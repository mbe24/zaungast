//! Minimal read-only LevelDB SSTable (.ldb) parser — a faithful port of
//! `packages/libzaungast/src/format/chromium/sstable.ts`. Read-only: opens the file, never writes,
//! never uses leveldb's DB::open (which would recover/compact = write). Corrupt/short blocks are
//! skipped and flagged `lossy`, exactly as the TS try/catch does — so a torn copy is never treated
//! as deletion truth downstream.
//! Format ref: https://github.com/google/leveldb/blob/main/doc/table_format.md

use crate::snappy;

const MAGIC: u64 = 0xdb4775248b80fb57; // full 64-bit table magic

/// CRC32C (Castagnoli) lookup table, built at compile time (mirrors sstable.ts's IIFE).
const CRC32C_TABLE: [u32; 256] = {
    let mut t = [0u32; 256];
    let mut n = 0usize;
    while n < 256 {
        let mut c = n as u32;
        let mut k = 0;
        while k < 8 {
            c = if c & 1 != 0 { 0x82f63b78 ^ (c >> 1) } else { c >> 1 };
            k += 1;
        }
        t[n] = c;
        n += 1;
    }
    t
};

fn crc32c(buf: &[u8], start: usize, end: usize) -> u32 {
    let mut c: u32 = 0xffffffff;
    let mut i = start;
    while i < end {
        c = CRC32C_TABLE[((c ^ buf[i] as u32) & 0xff) as usize] ^ (c >> 8);
        i += 1;
    }
    c ^ 0xffffffff
}

/// leveldb's mask: Mask(crc) = rotate_right(crc,15) + kMaskDelta (0xa282ead8). Unmask reverses it.
fn unmask_crc(m: u32) -> u32 {
    let x = m.wrapping_sub(0xa282ead8);
    (x >> 17) | (x << 15)
}

/// LEB128 varint (u64). `None` on truncation (bounds-safe — mirrors a TS RangeError → caught).
fn read_varint(buf: &[u8], off: usize) -> Option<(u64, usize)> {
    let mut result: u64 = 0;
    let mut shift: u32 = 0;
    let mut pos = off;
    loop {
        let byte = *buf.get(pos)?;
        pos += 1;
        result |= ((byte & 0x7f) as u64) << shift;
        if byte & 0x80 == 0 {
            break;
        }
        shift += 7;
        if shift >= 64 {
            return None;
        }
    }
    Some((result, pos))
}

/// A leveldb BlockHandle = (offset, size) as two varints.
fn read_block_handle(buf: &[u8], off: usize) -> Option<((usize, usize), usize)> {
    let (offset, pos) = read_varint(buf, off)?;
    let (size, pos) = read_varint(buf, pos)?;
    Some(((offset as usize, size as usize), pos))
}

struct BlockRead {
    data: Vec<u8>,
    crc_ok: Option<bool>,
}

/// Read a block's bytes: 5-byte trailer = 1 compression byte + 4-byte masked CRC. Type 0 = raw,
/// type 1 = snappy. `None` on any bounds/decompress failure or unsupported type (→ caller lossy).
/// (TS returns an uncompressed block as a zero-copy VIEW; we copy for now — byte-identical output,
/// optimize to Cow later.)
fn read_block(file: &[u8], offset: usize, size: usize, verify_crc: bool) -> Option<BlockRead> {
    let comp = *file.get(offset + size)?;
    let crc_ok = if verify_crc {
        let b = file.get(offset + size + 1..offset + size + 5)?;
        let stored = unmask_crc(u32::from_le_bytes([b[0], b[1], b[2], b[3]]));
        Some(crc32c(file, offset, offset + size + 1) == stored)
    } else {
        None
    };
    let contents = file.get(offset..offset + size)?;
    let data = match comp {
        0 => contents.to_vec(),
        1 => snappy::uncompress(contents).ok()?,
        _ => return None, // unsupported compression → treat as error (lossy), like the TS throw
    };
    Some(BlockRead { data, crc_ok })
}

/// Parse a data/index block's entries (restart-point prefix compression). `None` on corruption.
fn parse_block(data: &[u8]) -> Option<Vec<(Vec<u8>, Vec<u8>)>> {
    let n = data.len();
    if n < 4 {
        return None;
    }
    let num_restarts =
        u32::from_le_bytes([data[n - 4], data[n - 3], data[n - 2], data[n - 1]]) as usize;
    let restarts_start = n.checked_sub(4 + num_restarts.checked_mul(4)?)?;
    let mut pos = 0usize;
    let mut prev_key: Vec<u8> = Vec::new();
    let mut out: Vec<(Vec<u8>, Vec<u8>)> = Vec::new();
    while pos < restarts_start {
        let (shared, p) = read_varint(data, pos)?;
        pos = p;
        let (non_shared, p) = read_varint(data, pos)?;
        pos = p;
        let (value_len, p) = read_varint(data, pos)?;
        pos = p;
        let (shared, non_shared, value_len) =
            (shared as usize, non_shared as usize, value_len as usize);
        let key_start = pos;
        pos = pos.checked_add(non_shared)?;
        let value = data.get(pos..pos.checked_add(value_len)?)?.to_vec();
        pos += value_len;
        if shared > prev_key.len() {
            return None;
        }
        // key = shared prefix of prevKey + this entry's non-shared delta (single owned alloc).
        let mut key = Vec::with_capacity(shared + non_shared);
        key.extend_from_slice(&prev_key[..shared]);
        key.extend_from_slice(data.get(key_start..key_start + non_shared)?);
        prev_key = key.clone();
        out.push((key, value));
    }
    Some(out)
}

/// The result of reading a whole table: its (key, value) entries in table order, and whether any
/// block was skipped (lossy).
pub struct TableRead {
    pub entries: Vec<(Vec<u8>, Vec<u8>)>,
    pub lossy: bool,
}

fn lossy_empty() -> TableRead {
    TableRead { entries: Vec::new(), lossy: true }
}

/// Read every entry from an .ldb table file. Verifies the index-block CRC (a torn copy loses the
/// tail → fails here → lossy); per-data-block CRC skipped for speed (matches the TS reader).
pub fn read_table(path: &str) -> std::io::Result<TableRead> {
    let file = std::fs::read(path)?;
    let len = file.len();
    if len < 48 {
        return Ok(lossy_empty());
    }
    let footer_off = len - 48;
    let magic = u64::from_le_bytes(file[len - 8..len].try_into().unwrap());
    if magic != MAGIC {
        eprintln!("WARNING: bad magic {:x} (expected {:x})", magic, MAGIC);
    }
    // footer: metaindex handle (skipped) then index handle
    let (_, p) = match read_block_handle(&file, footer_off) {
        Some(x) => x,
        None => return Ok(lossy_empty()),
    };
    let (index_handle, _) = match read_block_handle(&file, p) {
        Some(x) => x,
        None => return Ok(lossy_empty()),
    };
    let index_block = match read_block(&file, index_handle.0, index_handle.1, true) {
        Some(b) => b,
        None => return Ok(lossy_empty()),
    };
    if index_block.crc_ok == Some(false) {
        return Ok(lossy_empty());
    }
    let index_entries = match parse_block(&index_block.data) {
        Some(e) => e,
        None => return Ok(lossy_empty()),
    };
    let mut entries: Vec<(Vec<u8>, Vec<u8>)> = Vec::new();
    let mut lossy = false;
    for (_ikey, ivalue) in &index_entries {
        let handle = match read_block_handle(ivalue, 0) {
            Some((h, _)) => h,
            None => {
                lossy = true;
                continue;
            }
        };
        match read_block(&file, handle.0, handle.1, false) {
            Some(b) => match parse_block(&b.data) {
                Some(es) => entries.extend(es),
                None => lossy = true,
            },
            None => lossy = true,
        }
    }
    Ok(TableRead { entries, lossy })
}

/// (count, crc32c) digest of a table's entries — the cross-language equality oracle. Feeds, per
/// entry in order: keyLen (u32 LE), key bytes, valLen (u32 LE), value bytes. The TS harness computes
/// the identical digest; matching (count, crc) ⇒ byte-identical reads.
pub fn entries_digest(entries: &[(Vec<u8>, Vec<u8>)]) -> (usize, u32) {
    let mut c: u32 = 0xffffffff;
    let mut feed = |b: u8| c = CRC32C_TABLE[((c ^ b as u32) & 0xff) as usize] ^ (c >> 8);
    for (k, v) in entries {
        for b in (k.len() as u32).to_le_bytes() {
            feed(b);
        }
        for &b in k {
            feed(b);
        }
        for b in (v.len() as u32).to_le_bytes() {
            feed(b);
        }
        for &b in v {
            feed(b);
        }
    }
    (entries.len(), c ^ 0xffffffff)
}
