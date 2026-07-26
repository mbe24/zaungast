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
import type { TableReadResult } from './types.js';

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
  return { entries, lossy: p.lossy };
}
