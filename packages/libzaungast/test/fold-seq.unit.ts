// R1 guard: foldTable now reads the 48-bit LevelDB sequence by hand instead of allocating a per-entry
// `new DataView`. foldTable is module-internal, so both formulas are reproduced here and asserted equal
// across the full seq range — a transcription guard against the byte-arithmetic replacement.
import { test, expect } from 'vitest';

// The formula that was replaced (per-entry DataView).
function viaDataView(ikey: Uint8Array): number {
  const n = ikey.length;
  const dv = new DataView(ikey.buffer, ikey.byteOffset, ikey.byteLength);
  const seqLow = dv.getUint32(n - 7, true) + dv.getUint16(n - 3, true) * 2 ** 32;
  return ikey[n - 1] * 0x1000000000000 + seqLow;
}
// The replacement (hand-rolled little-endian read).
function viaBytes(ikey: Uint8Array): number {
  const n = ikey.length;
  const lo32 = (ikey[n - 7] | (ikey[n - 6] << 8) | (ikey[n - 5] << 16) | (ikey[n - 4] << 24)) >>> 0;
  const seqLow = lo32 + (ikey[n - 3] | (ikey[n - 2] << 8)) * 2 ** 32;
  return ikey[n - 1] * 0x1000000000000 + seqLow;
}
// An 8-byte internal-key trailer (empty userKey): byte0 = type, bytes[1..7] = seq (56-bit LE).
function trailer(seq: bigint, type = 1): Uint8Array {
  const k = new Uint8Array(8);
  k[0] = type;
  let s = seq;
  for (let i = 1; i <= 7; i++) {
    k[i] = Number(s & 0xffn);
    s >>= 8n;
  }
  return k;
}

test('R1: hand-rolled 48-bit seq read == DataView, across the full <2^53 range', () => {
  const seqs = [
    0n,
    1n,
    255n,
    256n,
    65535n,
    65536n,
    0xffffffffn,
    0x100000000n,
    0xffffffffffffn,
    (1n << 53n) - 1n,
  ];
  // deterministic pseudo-random fill, all < 2^53 (the seqHi < 0x20 domain foldTable enforces)
  let x = 123456789n;
  const MASK = (1n << 53n) - 1n;
  for (let i = 0; i < 2000; i++) {
    x = (x * 6364136223846793005n + 1442695040888963407n) & MASK;
    seqs.push(x);
  }
  for (const s of seqs) {
    const k = trailer(s);
    expect(viaBytes(k)).toBe(viaDataView(k));
    expect(viaBytes(k)).toBe(Number(s)); // and both equal the true value
  }
});
