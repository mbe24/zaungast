//! IndexedDB-on-LevelDB: dedup + Chromium key decode + Snapshot bucket grouping — faithful port of
//! format/chromium/indexeddb.ts (loadSnapshot path). Read every .ldb table + the .log WAL, dedup by
//! user-key keeping the highest sequence (LevelDB precedence), then one pass that decodes each key's
//! prefix, routes db-name/store-name catalog rows, and groups indexId==1 data records into per-store
//! buckets IN DEDUP-INSERTION ORDER (the fingerprint samples the first records per bucket in this
//! exact order — order-critical). Never opens leveldb; reads tables/WAL raw.

use std::collections::HashMap;
use std::path::Path;

use crate::sstable::{crc32c_final, crc32c_init, crc32c_update};

pub struct SnapshotRecord {
    pub seq: u64,
    pub rtype: u8,
    pub key: Vec<u8>,
    pub value: Option<Vec<u8>>,
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
    index: HashMap<Vec<u8>, usize>,
    raw: u64,
    lossy: bool,
}
impl Dedup {
    fn consider(&mut self, user_key: &[u8], value: Option<&[u8]>, seq: u64, rtype: u8) {
        self.raw += 1;
        match self.index.get(user_key) {
            None => {
                self.index.insert(user_key.to_vec(), self.order.len());
                self.order.push(SnapshotRecord {
                    seq,
                    rtype,
                    key: user_key.to_vec(),
                    value: value.map(|v| v.to_vec()),
                });
            }
            Some(&i) => {
                if seq > self.order[i].seq {
                    let r = &mut self.order[i];
                    r.seq = seq;
                    r.rtype = rtype;
                    r.key = user_key.to_vec();
                    r.value = value.map(|v| v.to_vec());
                }
            }
        }
    }
}

// Split each table entry's 8-byte trailer (type + 56-bit LE seq) and feed it. Returns true if any
// entry was too short to carry a trailer (→ lossy).
fn fold_table(entries: &[(Vec<u8>, Vec<u8>)], d: &mut Dedup) -> bool {
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
        d.consider(&ikey[..n - 8], Some(value), seq, rtype);
    }
    short
}

fn fold_batch(batch: &crate::wal::WalBatch, d: &mut Dedup) {
    for (i, op) in batch.ops.iter().enumerate() {
        d.consider(&op.key, op.value.as_deref(), batch.sequence + i as u64, op.op_type);
    }
}

fn sorted_by_ext(dir: &str, ext: &str) -> std::io::Result<Vec<String>> {
    let mut v: Vec<String> = std::fs::read_dir(dir)?
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|f| f.ends_with(ext))
        .collect();
    v.sort(); // ASCII .ldb/.log names → matches TS byCodeUnit
    Ok(v)
}

fn build_dedup_map(dir: &str) -> std::io::Result<Dedup> {
    let mut d = Dedup { order: Vec::new(), index: HashMap::new(), raw: 0, lossy: false };
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
    let b0 = *buf.get(0)?;
    let db_bytes = ((b0 >> 5) & 0x07) as usize + 1;
    let os_bytes = ((b0 >> 2) & 0x07) as usize + 1;
    let idx_bytes = (b0 & 0x03) as usize + 1;
    let mut p = 1usize;
    let database_id = read_int_le(buf, &mut p, db_bytes)?;
    let object_store_id = read_int_le(buf, &mut p, os_bytes)?;
    let index_id = read_int_le(buf, &mut p, idx_bytes)?;
    Some(DecodedPrefix { database_id, object_store_id, index_id, header_len: p })
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
    let mut bindex: HashMap<String, usize> = HashMap::new();
    let mut max_seq = 0u64;
    let raw_count = d.raw;
    let lossy = d.lossy;
    let unique_count = d.order.len();

    for e in d.order.into_iter() {
        if e.seq > max_seq {
            max_seq = e.seq;
        }
        if e.rtype == 0 {
            continue; // tombstone: bumps maxSeq only, never in a bucket
        }
        if e.key.is_empty() {
            continue;
        }
        let p = match decode_prefix(&e.key) {
            Some(x) => x,
            None => continue,
        };
        let (database_id, object_store_id, index_id, header_len) =
            (p.database_id, p.object_store_id, p.index_id, p.header_len);
        if database_id == 0 && object_store_id == 0 && index_id == 0 && e.key.get(header_len) == Some(&0xc9) {
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
        } else if database_id > 0 && object_store_id == 0 && index_id == 0 && e.key.get(header_len) == Some(&0x32) {
            // store-name catalog row: osId varint in the key, store name (utf16be) in the value.
            if let Some((os_id, pp)) = read_varint_num(&e.key, header_len + 1) {
                if e.key.get(pp) == Some(&0) {
                    if let Some(val) = e.value.as_deref() {
                        store_names.insert(format!("{}:{}", database_id, os_id), utf16be(val));
                    }
                }
            }
        } else if index_id == 1 {
            let bk = format!("{}:{}", database_id, object_store_id);
            let idx = match bindex.get(&bk) {
                Some(&i) => i,
                None => {
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
                }
            };
            if e.seq > buckets[idx].max_seq {
                buckets[idx].max_seq = e.seq;
            }
            buckets[idx].records.push(e);
        }
    }
    // back-fill resolved names onto each bucket
    for b in buckets.iter_mut() {
        b.store_name = store_names.get(&format!("{}:{}", b.db_id, b.os_id)).cloned();
        b.db_name = db_names.get(&b.db_id).cloned();
    }
    Snapshot { buckets, db_names, store_names, max_seq, raw_count, unique_count, lossy }
}

pub fn load_snapshot(dir: &str) -> std::io::Result<Snapshot> {
    Ok(collect_snapshot(build_dedup_map(dir)?))
}

// ---- differential oracle report (matches harness/diff-snapshot.mjs) ----
fn bucket_crc(b: &StoreBucket) -> u32 {
    let up = crc32c_update;
    let mut c = crc32c_init();
    for r in &b.records {
        for x in (r.key.len() as u32).to_le_bytes() {
            c = up(c, x);
        }
        for &x in &r.key {
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
                for &x in v {
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
            match crate::ssv::decode_value(bytes, false) {
                Ok(v) => {
                    let mut canon = Vec::new();
                    crate::ssv::canonical(&v, &mut canon);
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
    format!("GLOBAL\t{}\t{}\t{}\n{}", total, total_ok, snap.buckets.len(), body)
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
        snap.raw_count, snap.unique_count, snap.max_seq, lossy, snap.buckets.len()
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
