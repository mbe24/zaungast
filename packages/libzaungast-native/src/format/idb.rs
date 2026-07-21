//! IndexedDB-on-LevelDB: dedup + Chromium key decode + Snapshot bucket grouping — faithful port of
//! format/chromium/indexeddb.ts (loadSnapshot path). Read every .ldb table + the .log WAL, dedup by
//! user-key keeping the highest sequence (LevelDB precedence), then one pass that decodes each key's
//! prefix, routes db-name/store-name catalog rows, and groups indexId==1 data records into per-store
//! buckets IN DEDUP-INSERTION ORDER (the fingerprint samples the first records per bucket in this
//! exact order — order-critical). Never opens leveldb; reads tables/WAL raw.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use bytes::Bytes;

use crate::sstable::{crc32c_final, crc32c_init, crc32c_update};

pub struct SnapshotRecord {
    pub seq: u64,
    pub rtype: u8,
    // `Bytes` (refcounted views into the parsed `.ldb` blocks / WAL copies) so the dedup fold and the
    // copy-reuse cache share value/key bytes instead of re-copying them every tick (★c).
    pub key: Bytes,
    pub value: Option<Bytes>,
}
pub struct StoreBucket {
    pub db_id: u64,
    pub os_id: u64,
    pub db_name: Option<String>,
    pub store_name: Option<String>,
    pub records: Vec<SnapshotRecord>,
    pub max_seq: u64,
}
pub struct Snapshot {
    pub buckets: Vec<StoreBucket>, // dedup-first-seen order (bucket order); records in-bucket ordered
    pub db_names: HashMap<u64, String>,
    pub store_names: HashMap<String, String>,
    pub max_seq: u64,
    pub raw_count: u64,
    pub unique_count: usize,
    pub lossy: bool,
}

// ---- dedup: first-seen-ordered map (Vec preserves JS Map insertion order; in-place overwrite) ----
struct Dedup {
    order: Vec<SnapshotRecord>,
    index: HashMap<Bytes, usize>,
    raw: u64,
    lossy: bool,
    // seqCap (tests/incremental differential only): ignore entries above this sequence, so the map
    // holds OLDER versions and max_seq reflects the capped set — mirrors loadEntries' seqCap in TS.
    seq_cap: Option<u64>,
}
impl Dedup {
    // `user_key`/`value` arrive as owned `Bytes` (cheap-clone refcounts, NOT byte copies): a new key
    // moves straight into the record + a refcount into the index; an overwrite moves the new value in.
    // Zero value/key memcpy per record — the ★c win vs the old `to_vec()` per record.
    fn consider(&mut self, user_key: Bytes, value: Option<Bytes>, seq: u64, rtype: u8) {
        if let Some(cap) = self.seq_cap {
            if seq > cap {
                return;
            }
        }
        self.raw += 1;
        match self.index.get(&user_key) {
            None => {
                self.index.insert(user_key.clone(), self.order.len());
                self.order.push(SnapshotRecord {
                    seq,
                    rtype,
                    key: user_key,
                    value,
                });
            }
            Some(&i) => {
                if seq > self.order[i].seq {
                    let r = &mut self.order[i];
                    r.seq = seq;
                    r.rtype = rtype;
                    // `r.key` is intentionally NOT reassigned: the index hit means it already holds the
                    // identical user-key bytes (same as JS re-pointing at an equal Buffer). Dropping the
                    // rewrite removes a malloc+memcpy+free per duplicate record.
                    r.value = value;
                }
            }
        }
    }
}

// Split each table entry's 8-byte trailer (type + 56-bit LE seq) and feed it. Returns true if any
// entry was too short to carry a trailer (→ lossy). The user-key + value are refcounted `Bytes`
// slices/clones (zero copy) — the trailer split is `ikey.slice(0..n-8)`.
fn fold_table(entries: &[(Bytes, Bytes)], d: &mut Dedup) -> bool {
    let mut short = false;
    for (ikey, value) in entries {
        let n = ikey.len();
        if n < 8 {
            short = true;
            continue;
        }
        let rtype = ikey[n - 8];
        let seq_hi = ikey[n - 1] as u64; // top 8 bits of the 56-bit seq
        let mut low48: u64 = 0;
        for i in 0..6 {
            low48 |= (ikey[n - 7 + i] as u64) << (8 * i as u32);
        }
        let seq = (seq_hi << 48) | low48;
        d.consider(ikey.slice(0..n - 8), Some(value.clone()), seq, rtype);
    }
    short
}

fn fold_batch(batch: &crate::wal::WalBatch, d: &mut Dedup) {
    for (i, op) in batch.ops.iter().enumerate() {
        d.consider(
            op.key.clone(),
            op.value.clone(),
            batch.sequence + i as u64,
            op.op_type,
        );
    }
}

fn sorted_by_ext(dir: &str, ext: &str) -> std::io::Result<Vec<String>> {
    let mut v: Vec<String> = std::fs::read_dir(dir)?
        .filter_map(std::result::Result::ok)
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|f| f.ends_with(ext))
        .collect();
    v.sort(); // ASCII .ldb/.log names → matches TS byCodeUnit
    Ok(v)
}

fn build_dedup_map(dir: &str, seq_cap: Option<u64>) -> std::io::Result<Dedup> {
    let mut d = Dedup {
        order: Vec::new(),
        index: HashMap::new(),
        raw: 0,
        lossy: false,
        seq_cap,
    };
    for f in sorted_by_ext(dir, ".ldb")? {
        let p = Path::new(dir).join(&f);
        match crate::sstable::read_table(&p.to_string_lossy()) {
            Ok(t) => {
                if t.lossy {
                    d.lossy = true;
                }
                if fold_table(&t.entries, &mut d) {
                    d.lossy = true;
                }
            }
            Err(_) => d.lossy = true,
        }
    }
    // Always read the WAL (a young/compacted db can hold all data in .log with no .ldb yet).
    for f in sorted_by_ext(dir, ".log")? {
        let p = Path::new(dir).join(&f);
        match crate::wal::parse_write_ahead_log(&p.to_string_lossy()) {
            Ok(batches) => {
                for b in &batches {
                    fold_batch(b, &mut d);
                }
            }
            Err(_) => d.lossy = true,
        }
    }
    Ok(d)
}

// ---- Chromium IndexedDB key coding ----
struct DecodedPrefix {
    database_id: u64,
    object_store_id: u64,
    index_id: u64,
    header_len: usize,
}
fn read_int_le(buf: &[u8], p: &mut usize, n: usize) -> Option<u64> {
    let mut v: u64 = 0;
    for i in 0..n {
        v += (*buf.get(*p)? as u64) << (8 * i as u32);
        *p += 1;
    }
    Some(v)
}
fn decode_prefix(buf: &[u8]) -> Option<DecodedPrefix> {
    let b0 = *buf.first()?;
    let db_bytes = ((b0 >> 5) & 0x07) as usize + 1;
    let os_bytes = ((b0 >> 2) & 0x07) as usize + 1;
    let idx_bytes = (b0 & 0x03) as usize + 1;
    let mut p = 1usize;
    let database_id = read_int_le(buf, &mut p, db_bytes)?;
    let object_store_id = read_int_le(buf, &mut p, os_bytes)?;
    let index_id = read_int_le(buf, &mut p, idx_bytes)?;
    Some(DecodedPrefix {
        database_id,
        object_store_id,
        index_id,
        header_len: p,
    })
}
fn read_varint_num(buf: &[u8], off: usize) -> Option<(u64, usize)> {
    let mut v: u64 = 0;
    let mut shift: u32 = 0;
    let mut pos = off;
    loop {
        let c = *buf.get(pos)?;
        pos += 1;
        v |= ((c & 0x7f) as u64) << shift;
        if c & 0x80 == 0 {
            break;
        }
        shift += 7;
        if shift >= 64 {
            return None;
        }
    }
    Some((v, pos))
}
// UTF-16BE string with a varint code-unit-length prefix.
fn read_string_with_length(buf: &[u8], off: usize) -> Option<(String, usize)> {
    let (len, pos) = read_varint_num(buf, off)?;
    let len = len as usize;
    let mut units: Vec<u16> = Vec::with_capacity(len);
    for i in 0..len {
        let hi = *buf.get(pos + i * 2)? as u16;
        let lo = *buf.get(pos + i * 2 + 1)? as u16;
        units.push((hi << 8) | lo);
    }
    Some((String::from_utf16_lossy(&units), pos + len * 2))
}
// UTF-16BE string filling the whole buffer (no length prefix).
fn utf16be(buf: &[u8]) -> String {
    let mut units = Vec::new();
    let mut i = 0;
    while i + 1 < buf.len() {
        units.push(((buf[i] as u16) << 8) | (buf[i + 1] as u16));
        i += 2;
    }
    String::from_utf16_lossy(&units)
}

fn collect_snapshot(d: Dedup) -> Snapshot {
    let mut db_names: HashMap<u64, String> = HashMap::new();
    let mut store_names: HashMap<String, String> = HashMap::new();
    let mut buckets: Vec<StoreBucket> = Vec::new();
    // Bucket index keyed by a (dbId, osId) TUPLE, not a `format!("{db}:{os}")` String — the old
    // string key allocated once PER DATA RECORD (~116k/tick). The store-name catalog map below stays
    // String-keyed (built once per store-name row, rare). (★c)
    let mut bindex: HashMap<(u64, u64), usize> = HashMap::new();
    let mut max_seq = 0u64;
    let raw_count = d.raw;
    let lossy = d.lossy;
    let unique_count = d.order.len();

    for e in d.order {
        if e.seq > max_seq {
            max_seq = e.seq;
        }
        if e.rtype == 0 {
            continue; // tombstone: bumps maxSeq only, never in a bucket
        }
        if e.key.is_empty() {
            continue;
        }
        let Some(p) = decode_prefix(&e.key) else {
            continue;
        };
        let (database_id, object_store_id, index_id, header_len) =
            (p.database_id, p.object_store_id, p.index_id, p.header_len);
        if database_id == 0
            && object_store_id == 0
            && index_id == 0
            && e.key.get(header_len) == Some(&0xc9)
        {
            // db-name catalog row: origin + db name in the key, dbId as a varint value.
            if let Some((_, p2)) = read_string_with_length(&e.key, header_len + 1) {
                if let Some((name, _)) = read_string_with_length(&e.key, p2) {
                    if let Some(val) = e.value.as_deref() {
                        if let Some((id, _)) = read_varint_num(val, 0) {
                            db_names.insert(id, name);
                        }
                    }
                }
            }
        } else if database_id > 0
            && object_store_id == 0
            && index_id == 0
            && e.key.get(header_len) == Some(&0x32)
        {
            // store-name catalog row: osId varint in the key, store name (utf16be) in the value.
            if let Some((os_id, pp)) = read_varint_num(&e.key, header_len + 1) {
                if e.key.get(pp) == Some(&0) {
                    if let Some(val) = e.value.as_deref() {
                        store_names.insert(format!("{database_id}:{os_id}"), utf16be(val));
                    }
                }
            }
        } else if index_id == 1 {
            let bk = (database_id, object_store_id);
            let idx = if let Some(&i) = bindex.get(&bk) {
                i
            } else {
                let i = buckets.len();
                bindex.insert(bk, i);
                buckets.push(StoreBucket {
                    db_id: database_id,
                    os_id: object_store_id,
                    db_name: None,
                    store_name: None,
                    records: Vec::new(),
                    max_seq: 0,
                });
                i
            };
            if e.seq > buckets[idx].max_seq {
                buckets[idx].max_seq = e.seq;
            }
            buckets[idx].records.push(e);
        }
    }
    // back-fill resolved names onto each bucket
    for b in &mut buckets {
        b.store_name = store_names
            .get(&format!("{}:{}", b.db_id, b.os_id))
            .cloned();
        b.db_name = db_names.get(&b.db_id).cloned();
    }
    Snapshot {
        buckets,
        db_names,
        store_names,
        max_seq,
        raw_count,
        unique_count,
        lossy,
    }
}

pub fn load_snapshot(dir: &str) -> std::io::Result<Snapshot> {
    Ok(collect_snapshot(build_dedup_map(dir, None)?))
}

/// Load a PARTIAL snapshot as of `seq_cap` (entries above it ignored) — the incremental differential
/// uses this to build a "previous" store, then proves refresh(prev)==full. Mirrors TS seqCap.
pub fn load_snapshot_capped(dir: &str, seq_cap: u64) -> std::io::Result<Snapshot> {
    Ok(collect_snapshot(build_dedup_map(dir, Some(seq_cap))?))
}

// ---- Axis B: copy-reuse snapshot loader (cache immutable .ldb parses, re-read only the .log) ----

/// One cached immutable `.ldb` parse: the parsed table entries + the on-disk size at parse time. A
/// size change (a partial→complete re-copy, or the rare recreated-DB filename reuse) invalidates the
/// entry so it is re-read. Mirrors the TS `LdbCache` value `{ res, size }`.
struct CachedTable {
    entries: Vec<(Bytes, Bytes)>,
    size: u64,
}

/// Per-Session copy-reuse cache (Axis B): immutable `.ldb` parses keyed by filename, reused across
/// incremental refreshes so only the small append-only `.log` is re-parsed each tick. Owned by the
/// native engine handle and carried across FFI calls; a full rebuild starts a fresh (empty) cache.
/// Mirrors the TS `LdbCache` owned per `createJsEngine`. Correctness rests on `.ldb` being write-once
/// with never-recycled file numbers (the same invariant R3's signature leans on): a cached
/// `(name, size)` is a stable identity for the bytes, and a vanished cached name means a compaction
/// (handled by the caller's defer-to-full-reparse — see `load_snapshot_reuse`).
#[derive(Default)]
pub struct LdbCache {
    tables: HashMap<String, CachedTable>,
    hits: usize,
}
impl LdbCache {
    pub fn new() -> Self {
        Self::default()
    }
    /// Cached-table count (introspection for the differential bin / telemetry).
    pub fn len(&self) -> usize {
        self.tables.len()
    }
    pub fn is_empty(&self) -> bool {
        self.tables.is_empty()
    }
    /// Cumulative `.ldb` parses served FROM cache (not re-read) across all reuse calls. A perf guard —
    /// a warm pass that never hits means `can_reuse` silently regressed to a full re-read every tick —
    /// plus telemetry (the profiler reports the hit rate).
    pub fn hits(&self) -> usize {
        self.hits
    }
}

// Reuse-cache decisions, factored out so they can be unit-tested WITHOUT real `.ldb` bytes.
//
// `compaction_detected`: any previously-cached `.ldb` filename is no longer on disk — a compaction
// consumed it, and compaction can elide a deletion (a key's tombstone merged away), so the caller
// MUST NOT reuse the stale cache; it defers to a full reparse of the current file set instead.
fn compaction_detected(cached_names: &[String], current: &HashSet<String>) -> bool {
    cached_names.iter().any(|f| !current.contains(f))
}
// `can_reuse`: reuse a cached parse iff the file is cached AND its on-disk size is known and unchanged.
// Same name + same size ⇒ (write-once, never-recycled numbers) the same bytes. A size change, an
// uncached file, OR a stat failure (unknown size) ⇒ re-read (never reuse blind).
fn can_reuse(cached_size: Option<u64>, disk_size: Option<u64>) -> bool {
    matches!((cached_size, disk_size), (Some(c), Some(d)) if c == d)
}

/// Cache-reusing, compaction-aware variant of `build_dedup_map` (Axis B). Reuses cached immutable
/// `.ldb` parses (by filename, size-revalidated), reads only new `.ldb` + all `.log` fresh, and folds
/// the UNION in the SAME sorted `.ldb`-then-`.log` order as `build_dedup_map` — so `d.order` (and thus
/// the fingerprint, which samples first-seen order) is identical to a cold full read. Returns
/// `(dedup, compacted)`; `compacted == true` means a cached `.ldb` vanished (the caller must fall back
/// to a full reparse). Prunes cache entries for absent files. Mirrors TS `buildReuseMap`.
fn build_dedup_map_reuse(
    dir: &str,
    cache: &mut LdbCache,
    seq_cap: Option<u64>,
) -> std::io::Result<(Dedup, bool)> {
    let mut d = Dedup {
        order: Vec::new(),
        index: HashMap::new(),
        raw: 0,
        lossy: false,
        seq_cap,
    };
    let ldb_now = sorted_by_ext(dir, ".ldb")?; // sorted — identical fold order to build_dedup_map
    let current: HashSet<String> = ldb_now.iter().cloned().collect();
    // Compaction check BEFORE any prune, over the cache as it stands from the previous tick.
    let cached_names: Vec<String> = cache.tables.keys().cloned().collect();
    let compacted = compaction_detected(&cached_names, &current);

    for f in &ldb_now {
        let p = Path::new(dir).join(f);
        let size = std::fs::metadata(&p).ok().map(|m| m.len());
        if can_reuse(cache.tables.get(f).map(|c| c.size), size) {
            // Reuse the immutable parse — but STILL propagate the short-entry lossy signal the cold
            // path raises (`fold_table` returns true on a <8-byte key). A table can parse clean yet
            // contain such a key, so it IS cached; without re-raising the flag a warm tick would read
            // lossy=false where a cold read reads lossy=true — a warm≠cold divergence. TS re-runs
            // foldTable on cache hits for the same reason.
            if fold_table(&cache.tables[f].entries, &mut d) {
                d.lossy = true;
            }
            cache.hits += 1;
        } else {
            match crate::sstable::read_table(&p.to_string_lossy()) {
                Ok(t) => {
                    if t.lossy {
                        d.lossy = true;
                    }
                    if fold_table(&t.entries, &mut d) {
                        d.lossy = true;
                    }
                    // H-B: cache only a CLEAN parse whose size we actually know — a partial parse must
                    // be retried next tick (never frozen), and a stat failure ⇒ don't cache (matching
                    // TS; the entry would be re-read next tick anyway rather than reused blind).
                    if !t.lossy {
                        if let Some(sz) = size {
                            cache.tables.insert(
                                f.clone(),
                                CachedTable {
                                    entries: t.entries,
                                    size: sz,
                                },
                            );
                        }
                    }
                }
                Err(_) => d.lossy = true,
            }
        }
    }
    // Prune cache entries for `.ldb` no longer on disk (freed after a compaction full-rebuild).
    cache.tables.retain(|f, _| current.contains(f));

    // Always re-read the WAL fresh (small, append-only; also the young/all-in-`.log` case).
    for f in sorted_by_ext(dir, ".log")? {
        let p = Path::new(dir).join(&f);
        match crate::wal::parse_write_ahead_log(&p.to_string_lossy()) {
            Ok(batches) => {
                for b in &batches {
                    fold_batch(b, &mut d);
                }
            }
            Err(_) => d.lossy = true,
        }
    }
    Ok((d, compacted))
}

/// Copy-reuse snapshot loader (Axis B): reuse cached immutable `.ldb` parses, re-read only the `.log`,
/// group into a `Snapshot`. Returns `(snapshot, compacted)`; `compacted == true` means a cached `.ldb`
/// vanished (a compaction) and the snapshot MUST NOT be trusted for a delta — the caller falls back to
/// a full reparse (which reads the current post-compaction file set, reconciling any elided deletion).
/// Mirrors TS `loadSnapshotReuse`.
pub fn load_snapshot_reuse(dir: &str, cache: &mut LdbCache) -> std::io::Result<(Snapshot, bool)> {
    let (d, compacted) = build_dedup_map_reuse(dir, cache, None)?;
    Ok((collect_snapshot(d), compacted))
}

/// A cheap fingerprint of the leveldb SOURCE files (no read/decompression) — the R3 no-op gate for
/// incremental refresh. Sorted `(name, size)` over the `.ldb` + `.log` + `MANIFEST-*` files this reader
/// consumes, plus `CURRENT`'s content. Unchanged ⇒ nothing landed: `.ldb` are write-once with
/// never-recycled file numbers (same-name-different-content is impossible) and the `.log` is
/// append-only (a new write always grows it), so any real change alters a name or a size. `mtime` is
/// deliberately excluded (a touch-without-change would force needless full refreshes). Callers
/// fail-open: treat any error, or a non-match, as "changed → full refresh path".
pub fn source_signature(dir: &str) -> std::io::Result<String> {
    use std::fmt::Write as _;
    let mut out = String::new();
    for ext in [".ldb", ".log"] {
        for name in sorted_by_ext(dir, ext)? {
            let len = std::fs::metadata(Path::new(dir).join(&name)).map_or(0, |m| m.len());
            let _ = writeln!(out, "{name}:{len}");
        }
    }
    let mut manifests: Vec<String> = std::fs::read_dir(dir)?
        .filter_map(std::result::Result::ok)
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|f| f.starts_with("MANIFEST-"))
        .collect();
    manifests.sort();
    for name in &manifests {
        let len = std::fs::metadata(Path::new(dir).join(name)).map_or(0, |m| m.len());
        let _ = writeln!(out, "{name}:{len}");
    }
    if let Ok(cur) = std::fs::read_to_string(Path::new(dir).join("CURRENT")) {
        let _ = write!(out, "CURRENT={}", cur.trim());
    }
    Ok(out)
}

// ---- differential oracle report (matches harness/diff-snapshot.mjs) ----
fn bucket_crc(b: &StoreBucket) -> u32 {
    let up = crc32c_update;
    let mut c = crc32c_init();
    for r in &b.records {
        for x in (r.key.len() as u32).to_le_bytes() {
            c = up(c, x);
        }
        for &x in &r.key[..] {
            c = up(c, x);
        }
        for x in r.seq.to_le_bytes() {
            c = up(c, x);
        }
        c = up(c, r.rtype);
        match &r.value {
            None => {
                for x in 0xFFFF_FFFFu32.to_le_bytes() {
                    c = up(c, x);
                }
            }
            Some(v) => {
                for x in (v.len() as u32).to_le_bytes() {
                    c = up(c, x);
                }
                for &x in &v[..] {
                    c = up(c, x);
                }
            }
        }
    }
    crc32c_final(c)
}

/// SSV-layer report: decode every record's VALUE and crc32c its canonical form per bucket (P2
/// differential). Per record: 0x01 + u32 len + canonical bytes on decode success, else 0x00 (a
/// decode failure on one side but not the other → digest diverges). Matches harness/diff-ssv.mjs.
pub fn snapshot_ssv_report(snap: &Snapshot) -> String {
    use std::fmt::Write;
    let up = crc32c_update;
    let mut total = 0usize;
    let mut total_ok = 0usize;
    let mut idx: Vec<usize> = (0..snap.buckets.len()).collect();
    idx.sort_by_key(|&i| (snap.buckets[i].db_id, snap.buckets[i].os_id));
    let mut body = String::new();
    for &i in &idx {
        let b = &snap.buckets[i];
        let mut c = crc32c_init();
        let mut ok = 0usize;
        for r in &b.records {
            let bytes = r.value.as_deref().unwrap_or(&[]);
            match crate::value::decode_value(bytes, false) {
                Ok(v) => {
                    let mut canon = Vec::new();
                    crate::value::canonical(&v, &mut canon);
                    c = up(c, 0x01);
                    for x in (canon.len() as u32).to_le_bytes() {
                        c = up(c, x);
                    }
                    for &x in &canon {
                        c = up(c, x);
                    }
                    ok += 1;
                }
                Err(_) => c = up(c, 0x00),
            }
        }
        total += b.records.len();
        total_ok += ok;
        let _ = writeln!(
            body,
            "BUCKET\t{}:{}\t{}\t{}\t{:08x}",
            b.db_id,
            b.os_id,
            b.records.len(),
            ok,
            crc32c_final(c)
        );
    }
    format!(
        "GLOBAL\t{}\t{}\t{}\n{}",
        total,
        total_ok,
        snap.buckets.len(),
        body
    )
}

/// Deterministic snapshot summary for cross-language equality: a GLOBAL line + one BUCKET line per
/// store (sorted by dbId:osId), each with a crc32c over its records in dedup-insertion order.
pub fn snapshot_report(snap: &Snapshot) -> String {
    use std::fmt::Write;
    let mut out = String::new();
    let lossy = if snap.lossy { "lossy" } else { "clean" };
    let _ = writeln!(
        out,
        "GLOBAL\t{}\t{}\t{}\t{}\t{}",
        snap.raw_count,
        snap.unique_count,
        snap.max_seq,
        lossy,
        snap.buckets.len()
    );
    let mut idx: Vec<usize> = (0..snap.buckets.len()).collect();
    idx.sort_by_key(|&i| (snap.buckets[i].db_id, snap.buckets[i].os_id));
    for &i in &idx {
        let b = &snap.buckets[i];
        let _ = writeln!(
            out,
            "BUCKET\t{}:{}\t{}\t{}\t{}\t{}\t{:08x}",
            b.db_id,
            b.os_id,
            b.records.len(),
            b.max_seq,
            b.db_name.as_deref().unwrap_or("-"),
            b.store_name.as_deref().unwrap_or("-"),
            bucket_crc(b)
        );
    }
    out
}

#[cfg(test)]
mod sig_tests {
    use super::source_signature;
    use std::fs;
    use std::path::{Path, PathBuf};

    // A fresh scratch dir per test (unique name → no parallel-test collision), cleaned first.
    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("zaungast-sig-{name}"));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }
    fn sig(d: &Path) -> String {
        source_signature(d.to_str().unwrap()).unwrap()
    }

    // The correctness argument as a test (not LevelDB lore): a real change always alters a name or a
    // size in the signature — .log append, new/removed .ldb, CURRENT flip — and it's idempotent.
    #[test]
    fn signature_detects_source_changes() {
        let d = scratch("basic");
        fs::write(d.join("000005.ldb"), b"aaa").unwrap();
        fs::write(d.join("000007.log"), b"bb").unwrap();
        fs::write(d.join("MANIFEST-000004"), b"m").unwrap();
        fs::write(d.join("CURRENT"), b"MANIFEST-000004\n").unwrap();
        let s1 = sig(&d);
        assert_eq!(s1, sig(&d), "idempotent");

        fs::write(d.join("000007.log"), b"bbccc").unwrap(); // .log append (grows)
        let s2 = sig(&d);
        assert_ne!(s1, s2, ".log append must differ");

        fs::write(d.join("000009.ldb"), b"x").unwrap(); // new .ldb
        let s3 = sig(&d);
        assert_ne!(s2, s3, "new .ldb must differ");

        fs::remove_file(d.join("000005.ldb")).unwrap(); // compaction removes an .ldb
        let s4 = sig(&d);
        assert_ne!(s3, s4, "removed .ldb must differ");

        fs::write(d.join("CURRENT"), b"MANIFEST-000008\n").unwrap(); // version-state flip
        let s5 = sig(&d);
        assert_ne!(s4, s5, "CURRENT flip must differ");

        let _ = fs::remove_dir_all(&d);
    }
}

#[cfg(test)]
mod reuse_tests {
    use super::{can_reuse, compaction_detected};
    use std::collections::HashSet;

    fn set(names: &[&str]) -> HashSet<String> {
        names.iter().map(|s| (*s).to_string()).collect()
    }

    // Compaction = a cached `.ldb` that is no longer on disk. Pure forward progress (a `.log` append
    // and/or a memtable flush that only ADDS `.ldb`) keeps every cached name present → no compaction.
    #[test]
    fn compaction_is_a_vanished_cached_ldb() {
        let current = set(&["000005.ldb", "000007.ldb"]);
        // cold start: empty cache never trips it
        assert!(!compaction_detected(&[], &current));
        // all cached still present → reuse (subset of current, incl. a new file on disk)
        assert!(!compaction_detected(&["000005.ldb".into()], &current));
        assert!(!compaction_detected(
            &["000005.ldb".into(), "000007.ldb".into()],
            &current
        ));
        // a cached file gone from disk → a compaction consumed it → defer to full reparse
        assert!(compaction_detected(
            &["000005.ldb".into(), "000009.ldb".into()],
            &current
        ));
    }

    // Reuse a cached parse only on an exact size match — a size change means a partial→complete
    // re-copy (or the rare recreated-DB filename reuse), so the cached bytes are stale and re-read.
    #[test]
    fn reuse_only_on_exact_size_match() {
        assert!(can_reuse(Some(1234), Some(1234))); // cached + same size → reuse
        assert!(!can_reuse(Some(1200), Some(1234))); // grew (partial→complete) → re-read
        assert!(!can_reuse(Some(1234), Some(1200))); // shrank (filename reuse) → re-read
        assert!(!can_reuse(None, Some(1234))); // uncached → read
        assert!(!can_reuse(Some(1234), None)); // stat failed (unknown size) → re-read, never blind
    }
}
