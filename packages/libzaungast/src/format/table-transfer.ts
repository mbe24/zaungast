// Transfer codec for a parsed table (plan M4a). A `.ldb` parses into a `TableReadResult` whose `entries`
// are thousands of tiny per-key/per-value `Uint8Array`s. Posting that across a worker boundary (Web
// Worker OR node:worker_threads) means the structured-clone algorithm walks and neuters *each* of those
// hundreds of thousands of buffers — per-buffer bookkeeping that dominated the parse-pool wall-clock (the
// "transfer tax": parse-parallel was net-negative because of it). This codec flattens a result into
// exactly THREE buffers — a keys blob, a values blob, and a lengths table — so a whole table crosses the
// boundary as three transferables, not N. `unpackTable` rebuilds the identical `TableReadResult` on the
// far side as subarray *views* into the two blobs (no copy), so `loadSnapshotFrom({ parsedTables })` sees
// byte-identical entries.
//
// Pure + transport-agnostic (no Worker/postMessage here) so both the browser pool and a future Node
// worker_threads pool share it. Usage: worker does `const p = packTable(parseTable(bytes));
// post(p, packedTransferList(p))`; the coordinator does `unpackTable(received)`.
import type { TableReadResult, SnapshotRecord } from './types.js';

export interface PackedTable {
  keys: ArrayBuffer; // every key's bytes, concatenated in entry order
  vals: ArrayBuffer; // every value's bytes, concatenated in entry order
  lens: Uint32Array; // [keyLen, valLen] per entry — walks the two blobs back into entries
  lossy: boolean;
}

// The three buffers to hand to postMessage's transfer list, so they move (zero-copy) instead of clone.
// Kept OUT of PackedTable so the posted object never both clones and transfers the same buffers.
export function packedTransferList(p: PackedTable): ArrayBuffer[] {
  return [p.keys, p.vals, p.lens.buffer as ArrayBuffer];
}

// Flatten a parsed table into three transferable buffers. Copies each entry's bytes once into the shared
// blobs — cheap next to the per-buffer clone tax it removes.
export function packTable(res: TableReadResult): PackedTable {
  const n = res.entries.length;
  const lens = new Uint32Array(n * 2);
  let keyBytes = 0;
  let valBytes = 0;
  for (let e = 0; e < n; e++) {
    const [k, v] = res.entries[e];
    // lens is Uint32 — a >4 GiB entry would wrap mod 2^32 and desync every later entry on unpack.
    // Unreachable for real `.ldb` tables (~MB), but the codec is generic over any TableReadResult.
    if (k.length > 0xffffffff || v.length > 0xffffffff)
      throw new RangeError(`table-transfer: entry ${e} exceeds 4 GiB, not representable`);
    lens[e * 2] = k.length;
    lens[e * 2 + 1] = v.length;
    keyBytes += k.length;
    valBytes += v.length;
  }
  const keys = new Uint8Array(keyBytes);
  const vals = new Uint8Array(valBytes);
  let kOff = 0;
  let vOff = 0;
  for (let e = 0; e < n; e++) {
    const [k, v] = res.entries[e];
    keys.set(k, kOff);
    kOff += k.length;
    vals.set(v, vOff);
    vOff += v.length;
  }
  // new Uint8Array(n) always backs a plain ArrayBuffer (never SharedArrayBuffer); the cast narrows the
  // ArrayBufferLike that .buffer is typed as, so the buffers stay transferable.
  return {
    keys: keys.buffer as ArrayBuffer,
    vals: vals.buffer as ArrayBuffer,
    lens,
    lossy: res.lossy,
  };
}

// Rebuild the identical `TableReadResult` from a packed table. Entries are subarray views into the two
// blobs — no per-entry allocation, byte-identical to the original `parseTable` output.
export function unpackTable(p: PackedTable): TableReadResult {
  // lens is [keyLen, valLen] pairs — an odd length is a malformed packed table, not a partial read.
  if (p.lens.length % 2 !== 0) throw new RangeError('table-transfer: odd lens length');
  const keys = new Uint8Array(p.keys);
  const vals = new Uint8Array(p.vals);
  const n = p.lens.length / 2;
  const entries: TableReadResult['entries'] = new Array(n);
  let kOff = 0;
  let vOff = 0;
  for (let e = 0; e < n; e++) {
    const kLen = p.lens[e * 2];
    const vLen = p.lens[e * 2 + 1];
    entries[e] = [keys.subarray(kOff, kOff + kLen), vals.subarray(vOff, vOff + vLen)];
    kOff += kLen;
    vOff += vLen;
  }
  // The lengths must consume the blobs EXACTLY — otherwise subarray silently clamps and hands back
  // truncated/garbage entries. Fail loud on a mismatched packed table instead.
  if (kOff !== keys.length || vOff !== vals.length)
    throw new RangeError(
      `table-transfer: length mismatch (keys ${kOff}/${keys.length}, vals ${vOff}/${vals.length})`,
    );
  return { entries, lossy: p.lossy };
}

// ── Extract-transport codec ────────────────────────────────────────────────────────────────────
// The SAME per-buffer clone tax that motivated packTable also hits the parallel *extract* dispatch:
// the coordinator fans a bucket's `SnapshotRecord[]` out to the pool, and structured-clone would neuter
// every record's tiny key + value buffer one at a time. This flattens a record range into the same
// three-buffer shape (keys blob · vals blob · lengths) so a whole chunk crosses as three transferables.
//
// SCOPE: this is an extract-transport codec, not a general SnapshotRecord clone. `recordsToRows`
// (resolver.ts) — the sole consumer of transferred records — reads ONLY `key` and `value`; it never
// touches `seq`/`type`. So those two fields are deliberately NOT shipped, and `unpackRecords`
// reconstructs them as 0. A `null` value (tombstone) is preserved distinctly from a 0-length value via
// a sentinel length, because `decodeValue(null)` vs `decodeValue(<empty>)` differ downstream.
export interface PackedRecords {
  keys: ArrayBuffer; // every record key's bytes, concatenated in record order
  vals: ArrayBuffer; // every non-null value's bytes, concatenated in record order
  lens: Uint32Array; // [keyLen, valLen] per record; valLen === NULL_VALUE marks a null (tombstone) value
}

// Sentinel valLen meaning "value is null" — distinct from a real 0-length value. 0xffffffff is one past
// the largest representable real length, so no genuine value can collide with it (packRecords guards).
const NULL_VALUE = 0xffffffff;

// The three buffers to hand to postMessage's transfer list (moved zero-copy, not cloned). Kept OUT of
// PackedRecords so the posted object never both clones and transfers the same buffers.
export function packedRecordsTransferList(p: PackedRecords): ArrayBuffer[] {
  return [p.keys, p.vals, p.lens.buffer as ArrayBuffer];
}

// Flatten a record range into three transferable buffers. Copies each key/value's bytes once into the
// shared blobs — the same one copy `compactRecord` would do, but into contiguous blobs that transfer as
// three buffers instead of N per-record clones.
export function packRecords(records: SnapshotRecord[]): PackedRecords {
  const n = records.length;
  const lens = new Uint32Array(n * 2);
  let keyBytes = 0;
  let valBytes = 0;
  for (let i = 0; i < n; i++) {
    const { key, value } = records[i];
    // lens is Uint32 and NULL_VALUE is reserved — a key/value at/over 4 GiB would wrap or alias the
    // null sentinel and desync every later record. Unreachable for real records; the codec is generic.
    if (key.length >= NULL_VALUE || (value !== null && value.length >= NULL_VALUE))
      throw new RangeError(`records-transfer: record ${i} field exceeds 4 GiB, not representable`);
    lens[i * 2] = key.length;
    lens[i * 2 + 1] = value === null ? NULL_VALUE : value.length;
    keyBytes += key.length;
    if (value !== null) valBytes += value.length;
  }
  const keys = new Uint8Array(keyBytes);
  const vals = new Uint8Array(valBytes);
  let kOff = 0;
  let vOff = 0;
  for (let i = 0; i < n; i++) {
    const { key, value } = records[i];
    keys.set(key, kOff);
    kOff += key.length;
    if (value !== null) {
      vals.set(value, vOff);
      vOff += value.length;
    }
  }
  return { keys: keys.buffer as ArrayBuffer, vals: vals.buffer as ArrayBuffer, lens };
}

// Rebuild the record range from a packed buffer set. Keys/values are subarray VIEWS into the two blobs
// (no per-record allocation); `seq`/`type` are reconstructed as 0 (see SCOPE above).
export function unpackRecords(p: PackedRecords): SnapshotRecord[] {
  if (p.lens.length % 2 !== 0) throw new RangeError('records-transfer: odd lens length');
  const keys = new Uint8Array(p.keys);
  const vals = new Uint8Array(p.vals);
  const n = p.lens.length / 2;
  const out: SnapshotRecord[] = new Array(n);
  let kOff = 0;
  let vOff = 0;
  for (let i = 0; i < n; i++) {
    const kLen = p.lens[i * 2];
    const vLen = p.lens[i * 2 + 1];
    const key = keys.subarray(kOff, kOff + kLen);
    kOff += kLen;
    let value: Uint8Array | null = null;
    if (vLen !== NULL_VALUE) {
      value = vals.subarray(vOff, vOff + vLen);
      vOff += vLen;
    }
    out[i] = { seq: 0, type: 0, key, value };
  }
  // Lengths must consume both blobs EXACTLY — otherwise subarray silently clamps and hands back
  // truncated/garbage records. Fail loud on a mismatched packed set instead.
  if (kOff !== keys.length || vOff !== vals.length)
    throw new RangeError(
      `records-transfer: length mismatch (keys ${kOff}/${keys.length}, vals ${vOff}/${vals.length})`,
    );
  return out;
}
