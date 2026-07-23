// Standard FIPS 180-4 / RFC 3174 test vectors for the vendored hashes. These ARE the spec, so they
// prove byte-parity with node:crypto and the Rust reader without importing either — which also keeps
// this spec runnable under the browser condition (plan A8). The real-data parity (that fingerprint +
// handles are unchanged) is separately pinned by the goldens, knownFingerprints, and the differential.
import { test, expect } from 'vitest';
import { sha256, sha1, sha256Hex, sha1Hex } from '../src/util/hash.js';
import { toHex } from '#bytes';

// A 56-byte message → forces a second padded block (the tricky boundary): 56 + 1 + 8 > 64.
const TWO_BLOCK = 'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq';

const SHA256: ReadonlyArray<readonly [string, string]> = [
  ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
  ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
  [TWO_BLOCK, '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
];
const SHA1: ReadonlyArray<readonly [string, string]> = [
  ['', 'da39a3ee5e6b4b0d3255bfef95601890afd80709'],
  ['abc', 'a9993e364706816aba3e25717850c26c9cd0d89d'],
  [TWO_BLOCK, '84983e441c3bd26ebaae4aa1f95129e5e54670f1'],
];

test.each(SHA256)('sha256(%j) matches the FIPS vector', (input, want) => {
  expect(sha256Hex(input)).toBe(want);
  expect(toHex(sha256(new TextEncoder().encode(input)))).toBe(want); // byte fn agrees with the hex helper
});

test.each(SHA1)('sha1(%j) matches the RFC 3174 vector', (input, want) => {
  expect(sha1Hex(input)).toBe(want);
  expect(toHex(sha1(new TextEncoder().encode(input)))).toBe(want);
});

test('digests are the correct length', () => {
  expect(sha256(new Uint8Array(0)).length).toBe(32);
  expect(sha1(new Uint8Array(0)).length).toBe(20);
});

test('the hex helpers encode input as UTF-8 (matching createHash().update(str))', () => {
  // "é" is U+00E9 → UTF-8 bytes C3 A9. The string helper must hash those two bytes, not one latin1 byte.
  expect(sha256Hex('é')).toBe(toHex(sha256(Uint8Array.from([0xc3, 0xa9]))));
  expect(sha1Hex('é')).toBe(toHex(sha1(Uint8Array.from([0xc3, 0xa9]))));
});
