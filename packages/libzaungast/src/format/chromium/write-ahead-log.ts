// LevelDB write-ahead-log (.log) parser.
// Block = 32768 bytes. Record header = crc(4) + length(2 LE) + type(1).
//   type: 1=FULL, 2=FIRST, 3=MIDDLE, 4=LAST  (0 = zero/padding)
// A reassembled record is a WriteBatch:
//   header: sequence(8 LE) + count(4 LE); then `count` ops:
//     op: 1=kTypeValue -> key(varlen)+value(varlen); 0=kTypeDeletion -> key(varlen)
import fs from 'node:fs';
import { concat } from '#bytes';
import { crc32c, unmaskCrc } from './sstable.js';
import type { WalBatch, WalOp } from '../types.js';

const BLOCK = 32768;
const HEADER = 7;

function readVarint(buf: Uint8Array, off: number): [number, number] {
  let v = 0,
    shift = 0,
    pos = off;
  while (true) {
    const c = buf[pos++];
    v += (c & 0x7f) * 2 ** shift;
    if (!(c & 0x80)) break;
    shift += 7;
  }
  return [v, pos];
}

// Return array of {sequence, ops:[{type,key,value}]}
export function parseWriteAheadLog(path: string): WalBatch[] {
  const data = fs.readFileSync(path);
  // One cached DataView over the whole log for the multi-byte header reads in the loop below.
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const batches: WalBatch[] = [];
  let pos = 0;
  let frag: Uint8Array[] | null = null; // {parts:[]}

  while (pos + HEADER <= data.length) {
    const blockOff = pos % BLOCK;
    if (BLOCK - blockOff < HEADER) {
      pos += BLOCK - blockOff;
      continue;
    } // trailer padding
    const storedCrc = dv.getUint32(pos, true);
    const len = dv.getUint16(pos + 4, true);
    const type = data[pos + 6];
    const dataStart = pos + HEADER;
    if (type === 0 && len === 0) {
      // zero padding to block end
      pos += BLOCK - blockOff;
      continue;
    }
    // A copy taken mid-append can have a torn tail. Verify the record CRC (covers type+data)
    // and treat the first bad/short record as end-of-log (leveldb's own recovery semantics).
    // NOTE: a torn tail here is deliberately NOT "lossy" — the WAL is append-only and we read
    // sequentially from offset 0, so the parsed prefix is a consistent earlier point-in-time and
    // never regresses below an already-read seq; the truncated batch is picked up next refresh.
    if (dataStart + len > data.length) break;
    if (unmaskCrc(storedCrc) !== crc32c(data, pos + 6, pos + 7 + len)) break;
    const chunk = data.subarray(dataStart, dataStart + len);
    pos = dataStart + len;

    if (type === 1) {
      emit(chunk);
    } // FULL
    else if (type === 2) {
      frag = [chunk];
    } // FIRST
    else if (type === 3) {
      if (frag) frag.push(chunk);
    } // MIDDLE
    else if (type === 4) {
      if (frag) {
        frag.push(chunk);
        emit(concat(frag));
        frag = null;
      }
    } // LAST
  }

  function emit(record: Uint8Array): void {
    if (record.length < 12) return;
    // Cached DataView per record. The 8-byte sequence is asserted < 2^53 (leveldb never nears it),
    // so read it as two little-endian u32 halves and combine into a Number — no BigInt.
    const rdv = new DataView(record.buffer, record.byteOffset, record.byteLength);
    const sequence = rdv.getUint32(0, true) + rdv.getUint32(4, true) * 2 ** 32;
    const count = rdv.getUint32(8, true);
    let p = 12;
    const ops: WalOp[] = [];
    for (let i = 0; i < count && p < record.length; i++) {
      const opType = record[p++];
      let klen: number, vlen: number, key: Uint8Array, value: Uint8Array | undefined;
      [klen, p] = readVarint(record, p);
      key = record.subarray(p, p + klen);
      p += klen;
      if (opType === 1) {
        [vlen, p] = readVarint(record, p);
        value = record.subarray(p, p + vlen);
        p += vlen;
      }
      // key/value are views into the read file buffer (or the reassembled record); no copy. They
      // pin their backing buffer for the batch's lifetime — safe, nothing mutates decoded buffers.
      ops.push({ type: opType, key, value: value ?? null });
    }
    batches.push({ sequence, ops });
  }

  return batches;
}
