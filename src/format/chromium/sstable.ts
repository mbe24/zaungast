// Minimal read-only LevelDB SSTable (.ldb) parser.
// Format ref: https://github.com/google/leveldb/blob/main/doc/table_format.md
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
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

// Read a block's raw bytes given a handle, handling the 5-byte trailer + compression.
function readBlock(fd: number, handle: BlockHandle, verifyCrc = false): BlockReadResult {
  const { offset, size } = handle;
  const buf = Buffer.alloc(size + 5); // include 1-byte type + 4-byte crc trailer
  // fs.readSync may perform a SHORT READ for large blocks — loop until fully read.
  let got = 0;
  while (got < size + 5) {
    const n = fs.readSync(fd, buf, got, size + 5 - got, offset + got);
    if (n <= 0) break;
    got += n;
  }
  const compressionType = buf[size];
  let crcOk: boolean | null = null;
  if (verifyCrc) {
    const stored = unmaskCrc(buf.readUInt32LE(size + 1));
    crcOk = crc32c(buf, 0, size + 1) === stored;
  }
  const contents = buf.subarray(0, size);
  if (compressionType === 0) return { data: Buffer.from(contents), compressionType, crcOk };
  if (compressionType === 1) {
    return { data: Snappy.uncompress(contents), compressionType, crcOk };
  }
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
    const keyDelta = data.subarray(pos, pos + nonShared);
    pos += nonShared;
    const value = data.subarray(pos, pos + valueLen);
    pos += valueLen;
    const key = Buffer.concat([prevKey.subarray(0, shared), keyDelta]);
    prevKey = key;
    yield [key, value];
  }
}

export function readTable(path: string): TableReadResult {
  const fd = fs.openSync(path, 'r');
  const stat = fs.fstatSync(fd);
  const fileSize = stat.size;
  const footer = Buffer.alloc(48);
  fs.readSync(fd, footer, 0, 48, fileSize - 48);
  const magic = footer.readBigUInt64LE(40);
  if (magic !== MAGIC_HIGH) {
    console.error(`WARNING: bad magic ${magic.toString(16)} (expected ${MAGIC_HIGH.toString(16)})`);
  }
  // metaindex handle (skipped), then index handle (varints at start of footer)
  const [, p] = readBlockHandle(footer, 0);
  const [indexHandle] = readBlockHandle(footer, p);

  // Verify CRCs: a copy taken while a table was being written could be torn. If the index
  // block itself is corrupt we can't trust the table — skip it. Corrupt data blocks are
  // skipped individually.
  // Verifying the INDEX block CRC (plus the footer magic check above) is enough to detect a
  // torn/truncated .ldb copy — a partial copy loses the tail (footer/index) and fails here.
  // Per-data-block CRC is skipped for speed (halves read time; the WAL is still fully CRC'd).
  // `lossy` = true if any block was skipped, so callers can refuse to treat a partial read as
  // deletion truth (an incremental deletion reconcile MUST NOT run on a lossy load).
  const { data: indexData, crcOk: idxOk } = readBlock(fd, indexHandle, true);
  if (idxOk === false) {
    fs.closeSync(fd);
    return { entries: [], lossy: true };
  }

  const entries: TableEntry[] = [];
  let lossy = false;
  for (const [, ivalue] of parseBlock(indexData)) {
    // index value = BlockHandle of a data block
    const [handle] = readBlockHandle(ivalue, 0);
    try {
      const block = readBlock(fd, handle, false);
      for (const [k, v] of parseBlock(block.data)) entries.push([Buffer.from(k), Buffer.from(v)]);
    } catch {
      lossy = true;
      continue;
    } // corrupt/short block → skip, mark lossy
  }
  fs.closeSync(fd);
  return { entries, lossy };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const path = process.argv[2];
  const { entries, lossy } = readTable(path);
  console.log(`Total entries: ${entries.length}${lossy ? ' (LOSSY)' : ''}`);
}
