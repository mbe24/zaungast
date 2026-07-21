//! IndexedDB-on-LevelDB: dedup + Chromium key decode + Snapshot bucket grouping — faithful port of
//! format/chromium/indexeddb.ts (loadSnapshot path). Read every .ldb table + the .log WAL, dedup by
//! user-key keeping the highest sequence (LevelDB precedence), then one pass that decodes each key's
//! prefix, routes db-name/store-name catalog rows, and groups indexId==1 data records into per-store
//! buckets IN DEDUP-INSERTION ORDER (the fingerprint samples the first records per bucket in this
//! exact order — order-critical). Never opens leveldb; reads tables/WAL raw.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::time::{Duration, Instant};

use bytes::Bytes;

use crate::sstable::{crc32c_final, crc32c_init, crc32c_update};

#[derive(Clone)]
pub struct SnapshotRecord {
    pub seq: u64,
    pub rtype: u8,
    // `Bytes` (refcounted views into the parsed `.ldb` blocks / WAL copies) so the dedup fold and the
    // copy-reuse cache share value/key bytes instead of re-copying them every tick (★c). `Clone` is a
    // refcount bump (no byte memcpy) — which is what makes caching the folded prefix cheap (★c2).
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
// `Clone` is cheap now (Bytes-backed): a Vec + hashbrown-table memcpy + refcount bumps, no rehash and
// no byte copies — so the copy-reuse fast path can clone a cached fold and layer only the WAL (★c2).
#[derive(Clone)]
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

// ---- Axis B: copy-reuse snapshot loader (★c2: cache the folded .ldb dedup PREFIX, re-fold only .log) ----

/// The folded dedup state over a clean, sorted PREFIX of the current `.ldb` list — cached across
/// refreshes so a tick re-folds only the (small) `.log` on top of a cheap clone, never re-hashing all
/// ~116k records. `covered` is the sorted `(name, size)` of the `.ldb` folded in, and — by
/// construction (`.ldb` are write-once with monotonically-increasing numbers, so new files sort last)
/// — a POSITIONAL prefix of the current `.ldb` list. `dedup` holds NO `.log` records (those are folded
/// onto a per-tick CLONE), so it stays a valid, reusable `.ldb`-only fold.
struct FoldedPrefix {
    dedup: Dedup,
    covered: Vec<(String, u64)>,
}

/// Per-Session copy-reuse cache (Axis B / ★c2): the folded `.ldb` dedup prefix, carried across FFI
/// calls on the native engine handle. A full rebuild starts fresh (`None`). Correctness rests on
/// `.ldb` being write-once with never-recycled, monotonically-increasing file numbers (the invariant
/// R3's signature also leans on): a covered `(name, size)` is a stable identity for the bytes; a
/// vanished covered name means a compaction (→ the caller defers to a full reparse).
#[derive(Default)]
pub struct LdbCache {
    folded: Option<FoldedPrefix>,
    // Cumulative count of prefix records SERVED via the clone-and-`.log`-only fast path (added once
    // per fast-path tick). Zero exactly when the fast path never ran → the silent-regression guard.
    prefix_records_reused: usize,
}
impl LdbCache {
    pub fn new() -> Self {
        Self::default()
    }
    /// Whether a folded prefix is currently cached (a cold reuse builds it; introspection for the gate).
    pub fn has_prefix(&self) -> bool {
        self.folded.is_some()
    }
    /// Cumulative prefix records served via the fast path — the perf guard / profiler telemetry.
    pub fn prefix_records_reused(&self) -> usize {
        self.prefix_records_reused
    }
}

// `covered` is a POSITIONAL prefix of `current` — same names, positions, AND sizes for the first
// `covered.len()` entries. Factored out for unit-testing without real `.ldb`. When true, `current`'s
// tail (`current[covered.len()..]`) provably sorts after every covered file (both are sorted), so
// folding it onto the prefix reproduces a cold fold's order exactly — the append-order invariant
// becomes CHECKED, not assumed (a size change / reorder / filename-reuse pathology fails it → rebuild).
fn is_positional_prefix(covered: &[(String, u64)], current: &[(String, u64)]) -> bool {
    covered.len() <= current.len() && covered.iter().zip(current).all(|(a, b)| a == b)
}

// A covered `.ldb` filename no longer on disk ⇒ a compaction consumed it (which can elide a deletion),
// so the delta can't be trusted → the caller defers to a full reparse. Distinct from is_positional_prefix.
fn covered_name_vanished(covered: &[(String, u64)], current_names: &HashSet<&str>) -> bool {
    covered
        .iter()
        .any(|(n, _)| !current_names.contains(n.as_str()))
}

// Sorted `(name, size)` of the dir's `.ldb` files (size 0 on stat failure → treated as a changed size,
// so a stat-flaky file just forces a rebuild rather than a blind reuse).
fn sorted_ldb_sizes(dir: &str) -> std::io::Result<Vec<(String, u64)>> {
    Ok(sorted_by_ext(dir, ".ldb")?
        .into_iter()
        .map(|n| {
            let size = std::fs::metadata(Path::new(dir).join(&n)).map_or(0, |m| m.len());
            (n, size)
        })
        .collect())
}

/// Fold every `.ldb` in `ldb_now` fresh (sorted), returning the `.ldb`-only Dedup. `d.lossy` is set on
/// any read error / lossy table / short entry — the caller caches it as a prefix ONLY when `!d.lossy`.
fn fold_all_ldb(dir: &str, ldb_now: &[(String, u64)]) -> Dedup {
    let mut d = Dedup {
        order: Vec::new(),
        index: HashMap::new(),
        raw: 0,
        lossy: false,
        seq_cap: None,
    };
    for (name, _size) in ldb_now {
        match crate::sstable::read_table(&Path::new(dir).join(name).to_string_lossy()) {
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
    d
}

/// The `.ldb`-only fold for this tick (★c2), reusing/advancing the cached folded prefix when possible.
/// Returns `(dedup, compacted)` — `dedup` holds only `.ldb` records (the caller folds `.log` on top of
/// it, never on the persisted prefix). Three outcomes, mirroring `build_dedup_map`'s order exactly:
/// - **compaction** (a covered name vanished): rebuild the prefix from the CURRENT set (cache it if
///   clean, so reuse resumes next tick) and signal `compacted=true` → the caller DEFERS the delta.
/// - **fast path** (covered is a positional prefix): fold the clean tail into the persistent prefix,
///   then CLONE it (cheap, Bytes-backed) for the caller's `.log` fold. If a tail file is lossy, bypass
///   the prefix entirely (full re-fold, prefix untouched) — a lossy load makes `refresh_store` skip.
/// - **rebuild** (first tick, or a covered size change / reorder): full sorted fold, cache if clean.
fn build_dedup_map_reuse(dir: &str, cache: &mut LdbCache) -> std::io::Result<(Dedup, bool)> {
    let ldb_now = sorted_ldb_sizes(dir)?; // sorted (name, size) — identical fold order to build_dedup_map
    let current_names: HashSet<&str> = ldb_now.iter().map(|(n, _)| n.as_str()).collect();

    let (mut d, compacted) = match cache.folded.take() {
        // Compaction: a covered `.ldb` is gone → an elided deletion may lurk. Rebuild the prefix from
        // the current set (so reuse resumes next tick) but DEFER this tick's delta.
        Some(fp) if covered_name_vanished(&fp.covered, &current_names) => {
            let d = fold_all_ldb(dir, &ldb_now);
            if !d.lossy {
                cache.folded = Some(FoldedPrefix {
                    dedup: d.clone(),
                    covered: ldb_now.clone(),
                });
            }
            (d, true)
        }
        // Fast path: the prefix covers a positional head of the current list → fold only the tail.
        Some(mut fp) if is_positional_prefix(&fp.covered, &ldb_now) => {
            let mut lossy_tail = false;
            for (name, size) in &ldb_now[fp.covered.len()..] {
                match crate::sstable::read_table(&Path::new(dir).join(name).to_string_lossy()) {
                    Ok(t) if !t.lossy => {
                        if fold_table(&t.entries, &mut fp.dedup) {
                            lossy_tail = true; // a <8-byte entry ⇒ lossy
                            break;
                        }
                        fp.covered.push((name.clone(), *size));
                    }
                    _ => {
                        lossy_tail = true;
                        break;
                    }
                }
            }
            if lossy_tail {
                // A tail file is lossy → discard the half-advanced prefix (leave the cache empty; it
                // rebuilds next clean tick) and produce a fresh full fold (lossy → the caller skips).
                (fold_all_ldb(dir, &ldb_now), false)
            } else {
                cache.prefix_records_reused += fp.dedup.order.len();
                let out = fp.dedup.clone(); // the caller folds `.log` onto this clone, not `fp`
                cache.folded = Some(fp); // persist the advanced, `.log`-free prefix
                (out, false)
            }
        }
        // First tick, or a covered size change / reorder (the positional check failed) → full rebuild.
        _ => {
            let d = fold_all_ldb(dir, &ldb_now);
            if !d.lossy {
                cache.folded = Some(FoldedPrefix {
                    dedup: d.clone(),
                    covered: ldb_now.clone(),
                });
            }
            (d, false)
        }
    };

    // Fold the WAL onto `d` (the clone or a fresh fold) — NEVER the persisted prefix, which stays
    // `.log`-free so it can be cloned again next tick. Small + append-only; also the all-in-`.log` case.
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

/// The `.ldb`-fold vs `collect_snapshot` wall-clock split (measure-and-drop) — the profiler uses it to
/// separate what ★c2 speeds up (the fold) from `collect_snapshot`, which decodes/routes/buckets all
/// records every tick regardless. Pure observation; the snapshot is identical either way.
pub struct ReuseTimings {
    pub fold: Duration,
    pub collect: Duration,
}

/// Timed copy-reuse loader: the fold reuses the cached prefix (★c2), then `collect_snapshot` groups.
pub fn load_snapshot_reuse_timed(
    dir: &str,
    cache: &mut LdbCache,
) -> std::io::Result<(Snapshot, bool, ReuseTimings)> {
    let t = Instant::now();
    let (d, compacted) = build_dedup_map_reuse(dir, cache)?;
    let fold = t.elapsed();
    let t = Instant::now();
    let snap = collect_snapshot(d);
    let collect = t.elapsed();
    Ok((snap, compacted, ReuseTimings { fold, collect }))
}

/// Copy-reuse snapshot loader (Axis B / ★c2): fold reusing the cached `.ldb` dedup prefix, re-folding
/// only the `.log`, then group into a `Snapshot`. Returns `(snapshot, compacted)`; `compacted == true`
/// means a covered `.ldb` vanished (a compaction) and the snapshot MUST NOT be trusted for a delta —
/// the caller falls back to a full reparse (reconciling any elided deletion). Mirrors TS
/// `loadSnapshotReuse`.
pub fn load_snapshot_reuse(dir: &str, cache: &mut LdbCache) -> std::io::Result<(Snapshot, bool)> {
    let (snap, compacted, _t) = load_snapshot_reuse_timed(dir, cache)?;
    Ok((snap, compacted))
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
    use super::{covered_name_vanished, is_positional_prefix};
    use std::collections::HashSet;

    fn pairs(v: &[(&str, u64)]) -> Vec<(String, u64)> {
        v.iter().map(|(n, s)| ((*n).to_string(), *s)).collect()
    }

    // The ★c2 fast-path gate: `covered` must be a POSITIONAL prefix (same names, positions, sizes) of
    // the current sorted `.ldb` list — then the tail is safe to fold on top in order.
    #[test]
    fn positional_prefix_semantics() {
        let current = pairs(&[("000005.ldb", 100), ("000007.ldb", 200), ("000009.ldb", 50)]);
        // empty prefix is a prefix of anything (cold start / first build)
        assert!(is_positional_prefix(&pairs(&[]), &current));
        // exact head(s), same sizes → valid (fast-path append of the tail)
        assert!(is_positional_prefix(
            &pairs(&[("000005.ldb", 100)]),
            &current
        ));
        assert!(is_positional_prefix(
            &pairs(&[("000005.ldb", 100), ("000007.ldb", 200)]),
            &current
        ));
        assert!(is_positional_prefix(&current, &current)); // full match
                                                           // a covered size changed (partial→complete recopy) → NOT a prefix (rebuild, no defer)
        assert!(!is_positional_prefix(
            &pairs(&[("000005.ldb", 999)]),
            &current
        ));
        // a covered name at the wrong position (reorder / filename-reuse pathology) → NOT a prefix
        assert!(!is_positional_prefix(
            &pairs(&[("000007.ldb", 200)]),
            &current
        ));
        // longer than current → NOT a prefix
        assert!(!is_positional_prefix(
            &pairs(&[
                ("000005.ldb", 100),
                ("000007.ldb", 200),
                ("000009.ldb", 50),
                ("000011.ldb", 10)
            ]),
            &current
        ));
    }

    // Compaction = a covered `.ldb` name no longer on disk. Pure forward progress (a `.log` append
    // and/or a flush that only ADDS `.ldb`) keeps every covered name present → no compaction → defer.
    #[test]
    fn compaction_is_a_vanished_covered_ldb() {
        let names: HashSet<&str> = ["000005.ldb", "000007.ldb"].into_iter().collect();
        assert!(!covered_name_vanished(&[], &names)); // cold start never trips it
        assert!(!covered_name_vanished(&pairs(&[("000005.ldb", 1)]), &names)); // still present
        assert!(!covered_name_vanished(
            &pairs(&[("000005.ldb", 1), ("000007.ldb", 2)]),
            &names
        ));
        // a covered name gone from disk → compaction → defer to full reparse
        assert!(covered_name_vanished(
            &pairs(&[("000005.ldb", 1), ("000009.ldb", 3)]),
            &names
        ));
    }
}
