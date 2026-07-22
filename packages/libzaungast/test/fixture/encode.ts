// Low-level encoders for the fixture generator — the INVERSE of the byte formats decoded by
// src/format/chromium/{write-ahead-log,indexeddb,structured-clone}.ts and src/format/chromium/sstable.ts
// (for crc32c). Read those files first; this module writes exactly what they read.
//
// Nothing here is imported by production code, and nothing under src/ is modified — this only
// imports the pure, side-effect-free crc32c helper.
import { crc32c } from '../../src/format/chromium/sstable.js';

// ---- varint (unsigned LEB128, as read by readVarint in write-ahead-log.ts / indexeddb.ts) ----
export function varint(n: number): Buffer {
  const bytes: number[] = [];
  // All values used by this fixture comfortably fit in a JS safe integer; no bigint needed.
  while (n >= 0x80) {
    bytes.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  bytes.push(n & 0x7f);
  return Buffer.from(bytes);
}

// zigzag varint, as read by Reader.zigzag() in structured-clone.ts: v%2 ? -(v+1)/2 : v/2
export function zigzagVarint(v: number): Buffer {
  const z = v >= 0 ? v * 2 : -v * 2 - 1;
  return varint(z);
}

// ---- Chromium IndexedDB key coding (inverse of decodePrefix in indexeddb.ts) ----
// All ids used by this fixture are < 256, so each byte-width is 1 and b0 = 0x00
// ((dbBytes-1)<<5)|((osBytes-1)<<2)|(idxBytes-1) with all widths=1 -> 0.
export function keyPrefix(databaseId: number, objectStoreId: number, indexId: number): Buffer {
  if (databaseId > 255 || objectStoreId > 255 || indexId > 255)
    throw new Error('fixture ids must be < 256 (single-byte prefix only)');
  return Buffer.from([0x00, databaseId, objectStoreId, indexId]);
}

// UTF-16BE string WITH a varint code-unit-length prefix (inverse of readStringWithLength) —
// used inside metadata-row KEYS (db-name / store-name rows).
export function stringWithLength(s: string): Buffer {
  const len = varint(s.length);
  const body = Buffer.alloc(s.length * 2);
  for (let i = 0; i < s.length; i++) body.writeUInt16BE(s.charCodeAt(i), i * 2); // NOSONAR S7758 — UTF-16 code units by design (see verify.ts round-trip)
  return Buffer.concat([len, body]);
}

// UTF-16BE string with NO length prefix, filling the whole buffer (inverse of utf16be) —
// used for store-name metadata row VALUES.
export function utf16beBytes(s: string): Buffer {
  const body = Buffer.alloc(s.length * 2);
  for (let i = 0; i < s.length; i++) body.writeUInt16BE(s.charCodeAt(i), i * 2); // NOSONAR S7758 — UTF-16 code units by design (see verify.ts round-trip)
  return body;
}

// A plausible (opaque to the reader) Chromium IndexedDBKey encoding for a string primary key:
// type tag 0x01 (String) + varint(length) + UTF-16BE chars. The reader never parses the bytes
// after the (db,os,index) prefix — it only treats them as an opaque byte string (for dedup /
// __key) — so the exact shape doesn't matter for correctness, but this mirrors the real format.
export function idbKeyString(s: string): Buffer {
  return Buffer.concat([Buffer.from([0x01]), stringWithLength(s)]);
}

// ---- V8/Blink structured-clone (SSV) writer — inverse of structured-clone.ts's Reader ----
// Only the tag subset our synthetic values use: object, string, int32, double, bool, null, array.
const TAG = {
  NULL: 0x30,
  TRUE: 0x54,
  FALSE: 0x46,
  INT32: 0x49,
  DOUBLE: 0x4e,
  BIGINT: 0x5a, // 'Z'
  STR1: 0x22, // one-byte (Latin1) string
  STR2: 0x63, // 'c' two-byte (UTF-16LE) string
  BEGIN_OBJ: 0x6f,
  END_OBJ: 0x7b,
  BEGIN_DENSE: 0x41,
  END_DENSE: 0x24,
};

// SSV bigint: tag + varint(bitfield) + magnitude bytes (little-endian), where
// bitfield = (byteLength << 1) | signBit. Inverse of Reader.bigint().
function encodeBigInt(v: bigint): Buffer {
  const neg = v < 0n;
  let mag = neg ? -v : v;
  const bytes: number[] = [];
  while (mag > 0n) {
    bytes.push(Number(mag & 0xffn));
    mag >>= 8n;
  }
  const bitfield = (bytes.length << 1) | (neg ? 1 : 0);
  return Buffer.concat([Buffer.from([TAG.BIGINT]), varint(bitfield), Buffer.from(bytes)]);
}

// Mirror V8's ValueSerializer: a string whose UTF-16 code units all fit in a byte is written as a
// one-byte (Latin1) string; the moment any unit exceeds 0xFF it's a two-byte (UTF-16LE) string —
// exactly the per-string choice the real Teams cache makes. Both length prefixes are BYTE counts.
function encodeString(s: string): Buffer {
  let oneByte = true;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 0xff) {
      // NOSONAR S7758 — UTF-16 code units by design (matches V8's OneByte/TwoByte split)
      oneByte = false;
      break;
    }
  }
  if (oneByte)
    return Buffer.concat([Buffer.from([TAG.STR1]), varint(s.length), Buffer.from(s, 'latin1')]);
  const body = Buffer.from(s, 'utf16le'); // byte length = 2 × code units
  return Buffer.concat([Buffer.from([TAG.STR2]), varint(body.length), body]);
}

function encodeDouble(d: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeDoubleLE(d);
  return Buffer.concat([Buffer.from([TAG.DOUBLE]), b]);
}

// ---- Blink host object (V8 kHostObject '\'=0x5c) — inverse of Reader.hostObject() ----
// UTF-8 string with a varint byte-length prefix (Blink's ReadUTF8String coding).
function encodeUtf8String(s: string): Buffer {
  const body = Buffer.from(s, 'utf8');
  return Buffer.concat([varint(body.length), body]);
}

// kBlobIndexTag ('i'): kHostObject + 'i' + varint(index). What real Teams app-icon records use.
export function blobIndexHost(index: number): Buffer {
  return Buffer.concat([Buffer.from([0x5c, 0x69]), varint(index)]);
}

// kBlobTag ('b'): kHostObject + 'b' + ReadUTF8String(uuid) + ReadUTF8String(type) + varint(size).
export function blobHost(uuid: string, type: string, size: number): Buffer {
  return Buffer.concat([
    Buffer.from([0x5c, 0x62]),
    encodeUtf8String(uuid),
    encodeUtf8String(type),
    varint(size),
  ]);
}

// Recursively encode any JS value our fixture data uses. Object key order is preserved
// (Object.entries iteration order for string keys), and `undefined` values/entries are OMITTED —
// this lets the data model use `field: maybeUndefined` to mean "field absent", matching how real
// Teams records vary field presence (e.g. a DM with no threadProperties.topic).
export function encodeValue(v: unknown): Buffer {
  // A Buffer is treated as pre-encoded SSV bytes emitted verbatim — the escape hatch used to
  // embed a host object (Blob) that encodeValue has no JS representation for. See blobIndexHost().
  if (Buffer.isBuffer(v)) return v;
  if (v === null || v === undefined) return Buffer.from([TAG.NULL]);
  if (typeof v === 'boolean') return Buffer.from([v ? TAG.TRUE : TAG.FALSE]);
  if (typeof v === 'string') return encodeString(v);
  if (typeof v === 'bigint') return encodeBigInt(v);
  if (typeof v === 'number') {
    if (Number.isInteger(v) && Math.abs(v) < 2 ** 31)
      return Buffer.concat([Buffer.from([TAG.INT32]), zigzagVarint(v)]);
    return encodeDouble(v);
  }
  if (Array.isArray(v)) return encodeDenseArray(v);
  if (typeof v === 'object') return encodeObject(v as Record<string, unknown>);
  throw new Error(`fixture: unsupported value type ${typeof v}`);
}

export function encodeObject(obj: Record<string, unknown>): Buffer {
  const parts: Buffer[] = [Buffer.from([TAG.BEGIN_OBJ])];
  let count = 0;
  for (const [k, val] of Object.entries(obj)) {
    if (val === undefined) continue;
    parts.push(encodeString(k), encodeValue(val));
    count++;
  }
  parts.push(Buffer.from([TAG.END_OBJ]), varint(count));
  return Buffer.concat(parts);
}

export function encodeDenseArray(arr: unknown[]): Buffer {
  const parts: Buffer[] = [Buffer.from([TAG.BEGIN_DENSE]), varint(arr.length)];
  for (const v of arr) parts.push(encodeValue(v));
  parts.push(Buffer.from([TAG.END_DENSE]), varint(0), varint(arr.length));
  return Buffer.concat(parts);
}

// Full top-level SSV blob for an IndexedDB record value: minimal envelope `0xFF <ver> <object>`
// (findEnvelopeRoot in structured-clone.ts anchors on 0xFF, skips 2 bytes, and finds 0x6F right
// there — no 0xFE blink-trailer needed). See test/core.unit.ts's own {a:1} test vector for the same shape.
export function ssvObject(obj: Record<string, unknown>): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0x0f]), encodeObject(obj)]);
}

// IndexedDB IDB *value* wrapper: varint(value-version) ++ SSV blob. No 0xFF 0x11 compression
// wrapper is used — decodeValue only strips that wrapper if present, so an uncompressed value
// (whose first two bytes are not 0xFF 0x11) decodes directly.
export function idbValue(obj: Record<string, unknown>): Buffer {
  return Buffer.concat([varint(1), ssvObject(obj)]);
}

// ---- LevelDB WAL (.log) writer — inverse of write-ahead-log.ts's parseWriteAheadLog ----
const BLOCK = 32768;
const HEADER = 7;

// leveldb's crc masking. Forward mask: Mask(c) = rotate_right(c,15) + kMaskDelta (0xa282ead8).
// rotate_right(c,15) = (c>>>15) | (c<<17), all mod 2**32. sstable.ts exports the inverse
// (unmaskCrc) but not this forward direction, so it's reimplemented here (same formula the
// task spec gives, and the same one test/incremental.int.ts uses for its own crafted WAL records).
// Exported: sstable-encode.ts (the .ldb writer) needs the identical forward mask for its
// per-block CRC trailers.
export function maskCrc(c: number): number {
  const rotated = ((c >>> 15) | (c << 17)) >>> 0;
  return (rotated + 0xa282ead8) >>> 0;
}

// Re-exported so sstable-encode.ts (and any other fixture module) can import both crc32c and
// maskCrc from this single low-level-encoders module, rather than reaching into src/ directly.
export { crc32c };

export interface WalOpIn {
  type: 1 | 0;
  key: Buffer;
  value?: Buffer;
} // type 1=value, 0=deletion

// Serialize one WriteBatch: sequence(8 LE) + count(4 LE) + ops, where each op is
// type(1) + varint(keyLen) + key [+ varint(valueLen) + value if type===1].
function encodeBatch(sequence: number, ops: WalOpIn[]): Buffer {
  const seqBuf = Buffer.alloc(8);
  seqBuf.writeBigUInt64LE(BigInt(sequence));
  const countBuf = Buffer.alloc(4);
  countBuf.writeUInt32LE(ops.length);
  const opBufs: Buffer[] = [];
  for (const op of ops) {
    if (op.type === 1) {
      const v = op.value as Buffer;
      opBufs.push(Buffer.from([1]), varint(op.key.length), op.key, varint(v.length), v);
    } else {
      opBufs.push(Buffer.from([0]), varint(op.key.length), op.key);
    }
  }
  return Buffer.concat([seqBuf, countBuf, ...opBufs]);
}

// Stateful physical-record writer mirroring leveldb's log_writer.cc AddRecord: splits a logical
// record's bytes across 32768-byte blocks, padding the trailer of a block with zeros when fewer
// than HEADER(7) bytes remain, and fragmenting a record that doesn't fit into FIRST/MIDDLE/LAST
// physical records (each with its own crc+len+type header). Every record we feed it here is a
// full WriteBatch (one per op in this fixture, so `left` is tiny) — the fragmentation loop is
// still implemented in full for correctness/robustness if the dataset grows past one block.
class LogWriter {
  private readonly chunks: Buffer[] = [];
  private blockOffset = 0;

  private emitPhysicalRecord(type: number, data: Buffer): void {
    const crc = maskCrc(crc32c(Buffer.concat([Buffer.from([type]), data]), 0, 1 + data.length));
    const header = Buffer.alloc(HEADER);
    header.writeUInt32LE(crc, 0);
    header.writeUInt16LE(data.length, 4);
    header.writeUInt8(type, 6);
    this.chunks.push(header, data);
    this.blockOffset += HEADER + data.length;
  }

  addRecord(payload: Buffer): void {
    let offset = 0;
    let begin = true;
    do {
      const leftover = BLOCK - this.blockOffset;
      if (leftover < HEADER) {
        if (leftover > 0) {
          this.chunks.push(Buffer.alloc(leftover));
          this.blockOffset += leftover;
        }
        // Reader treats a full-zero HEADER-worth of bytes (or less) at a block tail as padding
        // and skips to the next block boundary; it never re-parses these bytes as a record.
        this.blockOffset = 0;
      }
      const avail = BLOCK - this.blockOffset - HEADER;
      const remaining = payload.length - offset;
      const fragLen = Math.min(remaining, avail);
      const end = fragLen === remaining;
      const type = begin && end ? 1 : begin ? 2 : end ? 4 : 3; // FULL/FIRST/LAST/MIDDLE
      this.emitPhysicalRecord(type, payload.subarray(offset, offset + fragLen));
      offset += fragLen;
      begin = false;
    } while (offset < payload.length);
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

// Build the full .log file contents for a sequence of (sequence, ops) WriteBatches.
export function buildLog(batches: { sequence: number; ops: WalOpIn[] }[]): Buffer {
  const w = new LogWriter();
  for (const b of batches) w.addRecord(encodeBatch(b.sequence, b.ops));
  return w.toBuffer();
}
