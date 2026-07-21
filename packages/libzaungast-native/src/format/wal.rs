//! LevelDB write-ahead-log (.log) parser — faithful port of format/chromium/write-ahead-log.ts.
//! Block = 32768 bytes. Record header = crc(4) + length(2 LE) + type(1); type 1=FULL/2=FIRST/
//! 3=MIDDLE/4=LAST. A reassembled record is a WriteBatch: sequence(8 LE) + count(4 LE), then `count`
//! ops (1=put key+value, 0=delete key). A torn tail (bad/short CRC) ends the log (leveldb recovery
//! semantics) — deliberately NOT lossy: the append-only prefix is a consistent earlier point-in-time.

use crate::sstable::{crc32c, unmask_crc};

const BLOCK: usize = 32768;
const HEADER: usize = 7;

pub struct WalOp {
    pub op_type: u8,
    pub key: Vec<u8>,
    pub value: Option<Vec<u8>>,
}
pub struct WalBatch {
    pub sequence: u64,
    pub ops: Vec<WalOp>,
}

fn read_varint(buf: &[u8], off: usize) -> Option<(u64, usize)> {
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

fn emit(record: &[u8], batches: &mut Vec<WalBatch>) {
    if record.len() < 12 {
        return;
    }
    let sequence = u64::from_le_bytes(record[0..8].try_into().unwrap());
    let count = u32::from_le_bytes(record[8..12].try_into().unwrap());
    let mut p = 12usize;
    let mut ops = Vec::new();
    let mut i = 0u32;
    while i < count && p < record.len() {
        let op_type = record[p];
        p += 1;
        let Some((klen, np)) = read_varint(record, p) else {
            break;
        };
        p = np;
        let klen = klen as usize;
        if p + klen > record.len() {
            break;
        }
        let key = record[p..p + klen].to_vec();
        p += klen;
        let value = if op_type == 1 {
            let Some((vlen, np)) = read_varint(record, p) else {
                break;
            };
            p = np;
            let vlen = vlen as usize;
            if p + vlen > record.len() {
                break;
            }
            let v = record[p..p + vlen].to_vec();
            p += vlen;
            Some(v)
        } else {
            None
        };
        ops.push(WalOp {
            op_type,
            key,
            value,
        });
        i += 1;
    }
    batches.push(WalBatch { sequence, ops });
}

pub fn parse_write_ahead_log(path: &str) -> std::io::Result<Vec<WalBatch>> {
    let data = std::fs::read(path)?;
    let mut batches: Vec<WalBatch> = Vec::new();
    let mut pos = 0usize;
    let mut frag: Option<Vec<u8>> = None;

    while pos + HEADER <= data.len() {
        let block_off = pos % BLOCK;
        if BLOCK - block_off < HEADER {
            pos += BLOCK - block_off; // trailer padding
            continue;
        }
        let stored_crc = u32::from_le_bytes(data[pos..pos + 4].try_into().unwrap());
        let len = u16::from_le_bytes(data[pos + 4..pos + 6].try_into().unwrap()) as usize;
        let rtype = data[pos + 6];
        let data_start = pos + HEADER;
        if rtype == 0 && len == 0 {
            pos += BLOCK - block_off; // zero padding to block end
            continue;
        }
        if data_start + len > data.len() {
            break; // torn tail → end of log
        }
        if unmask_crc(stored_crc) != crc32c(&data, pos + 6, pos + 7 + len) {
            break; // bad crc → end of log
        }
        let chunk = &data[data_start..data_start + len];
        pos = data_start + len;

        match rtype {
            1 => emit(chunk, &mut batches),   // FULL
            2 => frag = Some(chunk.to_vec()), // FIRST
            3 => {
                if let Some(f) = frag.as_mut() {
                    f.extend_from_slice(chunk);
                }
            } // MIDDLE
            4 => {
                if let Some(mut f) = frag.take() {
                    f.extend_from_slice(chunk);
                    emit(&f, &mut batches);
                }
            } // LAST
            _ => {}
        }
    }
    Ok(batches)
}
