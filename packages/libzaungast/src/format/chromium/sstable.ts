// Minimal read-only LevelDB SSTable (.ldb) parser.
// Format ref: https://github.com/google/leveldb/blob/main/doc/table_format.md
import fs from 'node:fs';
import * as Snappy from './snappy.js';
import type { BlockHandle, BlockReadResult, TableEntry, TableReadResult } from '../types.js';

const MAGIC_HIGH = 0xdb4775248b80fb57n; // full 64-bit magic

function readVarint(buf: Buffer, off: number): [bigint, number] {
  let result = 0n;
  let shift = 0n;
  let pos = off;
  while (true) {
    const byte = buf[pos++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7n;
  }
  return [result, pos];
}
function readVarintNum(buf: Buffer, off: number): [number, number] {
  const [v, pos] = readVarint(buf, off);
  return [Number(v), pos];
}

function readBlockHandle(buf: Buffer, off: number): [BlockHandle, number] {
  let offset: number, size: number, pos: number;
  [offset, pos] = readVarintNum(buf, off);
  [size, pos] = readVarintNum(buf, pos);
  return [{ offset, size }, pos];
}

// CRC32C (Castagnoli) with leveldb's masking, for block-integrity verification.
const CRC32C_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32c(buf: Buffer, start: number, end: number): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC32C_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
// leveldb's masking: Mask(crc) = rotate_right(crc,15) + kMaskDelta; kMaskDelta = 0xa282ead8.
export function unmaskCrc(m: number): number {
  const x = (m - 0xa282ead8) >>> 0;
  return ((x >>> 17) | (x << 15)) >>> 0;
}

// Read a block's raw bytes from the in-memory file buffer, handling the 5-byte trailer +
// compression. Uncompressed blocks are returned as a *view* into `file` (no copy) — the caller
// must treat block/entry buffers as read-only (nothing in the reader mutates decoded buffers).
function readBlock(file: Buffer, handle: BlockHandle, verifyCrc = false): BlockReadResult {
  const { offset, size } = handle;
  const compressionType = file[offset + size];
  let crcOk: boolean | null = null;
  if (verifyCrc) {
    const stored = unmaskCrc(file.readUInt32LE(offset + size + 1));
    crcOk = crc32c(file, offset, offset + size + 1) === stored;
  }
  const contents = file.subarray(offset, offset + size);
  if (compressionType === 0) return { data: contents, compressionType, crcOk };
  if (compressionType === 1) return { data: Snappy.uncompress(contents), compressionType, crcOk };
  throw new Error(`Unsupported compression type ${compressionType}`);
}

export { readBlock, readBlockHandle };

// Parse the entries of a data/index block (with restart-point prefix compression).
export function* parseBlock(data: Buffer): Generator<TableEntry> {
  const n = data.length;
  // last 4 bytes = num_restarts
  const numRestarts = data.readUInt32LE(n - 4);
  const restartsStart = n - 4 - numRestarts * 4;
  let pos = 0;
  let prevKey = Buffer.alloc(0);
  while (pos < restartsStart) {
    let shared: number, nonShared: number, valueLen: number;
    [shared, pos] = readVarintNum(data, pos);
    [nonShared, pos] = readVarintNum(data, pos);
    [valueLen, pos] = readVarintNum(data, pos);
    const keyStart = pos;
    pos += nonShared;
    const value = data.subarray(pos, pos + valueLen); // view into the block
    pos += valueLen;
    // Build the key with a single owned allocation (shared prefix + this entry's delta) instead of
    // Buffer.concat's array literal + intermediate subarray.
    const key = Buffer.allocUnsafe(shared + nonShared);
    prevKey.copy(key, 0, 0, shared);
    data.copy(key, shared, keyStart, keyStart + nonShared);
    prevKey = key;
    yield [key, value];
  }
}

export function readTable(path: string): TableReadResult {
  // Read the whole (tmp-copy) file once: one syscall, no per-block zeroed Buffer.alloc + readSync.
  // Blocks/values become views into this buffer; the entries returned pin it for their lifetime.
  const file = fs.readFileSync(path);
  const fileSize = file.length;
  const footerOff = fileSize - 48;
  const magic = file.readBigUInt64LE(fileSize - 8);
  if (magic !== MAGIC_HIGH) {
    console.error(`WARNING: bad magic ${magic.toString(16)} (expected ${MAGIC_HIGH.toString(16)})`);
  }
  // metaindex handle (skipped), then index handle (varints at the start of the 48-byte footer)
  const [, p] = readBlockHandle(file, footerOff);
  const [indexHandle] = readBlockHandle(file, p);

  // Verify CRCs: a copy taken while a table was being written could be torn. If the index
  // block itself is corrupt we can't trust the table — skip it. Corrupt data blocks are
  // skipped individually.
  // Verifying the INDEX block CRC (plus the footer magic check above) is enough to detect a
  // torn/truncated .ldb copy — a partial copy loses the tail (footer/index) and fails here.
  // Per-data-block CRC is skipped for speed (halves read time; the WAL is still fully CRC'd).
  // `lossy` = true if any block was skipped, so callers can refuse to treat a partial read as
  // deletion truth (an incremental deletion reconcile MUST NOT run on a lossy load).
  const { data: indexData, crcOk: idxOk } = readBlock(file, indexHandle, true);
  if (idxOk === false) return { entries: [], lossy: true };

  const entries: TableEntry[] = [];
  let lossy = false;
  for (const [, ivalue] of parseBlock(indexData)) {
    // index value = BlockHandle of a data block
    const [handle] = readBlockHandle(ivalue, 0);
    try {
      const block = readBlock(file, handle, false);
      // key is owned (parseBlock allocates it); value is a view into the block (into `file` for
      // uncompressed blocks, or the per-block snappy output). No copy here.
      for (const [k, v] of parseBlock(block.data)) entries.push([k, v]);
    } catch {
      lossy = true;
      continue;
    } // corrupt/short block → skip, mark lossy
  }
  return { entries, lossy };
}
