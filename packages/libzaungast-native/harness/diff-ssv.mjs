// Differential harness — SSV layer (V8 structured-clone value decoder). Decodes EVERY record's
// value via the TS decodeValue, serializes each to the same canonical byte form as the Rust
// `canonical()`, and crc32c's per bucket — then (with --rust) diffs line-by-line against Rust's
// `diffssv`. Catches any decoder divergence: wrong string/number/bigint decode, missing/extra keys,
// wrong back-ref resolution, differing decode success/failure. Object keys sorted by UTF-8 bytes on
// both sides; array own-props ignored on both sides (see ssv.rs canonical()).
//   node packages/libzaungast-native/harness/diff-ssv.mjs <leveldb-dir> [--rust <report.txt>]
import fs from 'node:fs';
import { loadSnapshot, decodeValue } from '../../libzaungast/dist/format/chromium/indexeddb.js';

const CRC32C = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? (0x82f63b78 ^ (c >>> 1)) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

const f64 = Buffer.alloc(8);
function pushF64(out, n) { f64.writeDoubleLE(n, 0); for (let i = 0; i < 8; i++) out.push(f64[i]); }
function varintOut(out, n) {
  n = Number(n);
  for (;;) { const b = n & 0x7f; n = Math.floor(n / 128); if (n !== 0) out.push(b | 0x80); else { out.push(b); break; } }
}
function pushBigMag(out, m) {
  const bytes = [];
  while (m > 0n) { bytes.push(Number(m & 0xffn)); m >>= 8n; }
  varintOut(out, bytes.length);
  for (const x of bytes) out.push(x);
}
// canonical byte form of a decoded value (mirrors ssv.rs::canonical)
function canonical(v, out) {
  if (v === undefined) return void out.push(0x75); // 'u'
  if (v === null) return void out.push(0x6e); // 'n'
  const t = typeof v;
  if (t === 'boolean') return void out.push(v ? 0x54 : 0x46);
  if (t === 'number') { out.push(0x64); pushF64(out, v); return; } // 'd'
  if (t === 'bigint') { out.push(0x47); out.push(v < 0n ? 1 : 0); pushBigMag(out, v < 0n ? -v : v); return; } // 'G'
  if (t === 'string') { out.push(0x73); const b = Buffer.from(v, 'utf8'); varintOut(out, b.length); for (const x of b) out.push(x); return; } // 's'
  if (v instanceof Date) { out.push(0x4d); pushF64(out, v.getTime()); return; } // 'M'
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) { out.push(0x62); varintOut(out, v.length); for (const x of v) out.push(x); return; } // 'b'
  if (Array.isArray(v)) { out.push(0x5b); varintOut(out, v.length); for (const it of v) canonical(it, out); out.push(0x5d); return; } // [ ]
  // plain object (incl. markers) — keys sorted by utf8 bytes
  out.push(0x7b);
  const keys = Object.keys(v).sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
  for (const k of keys) { const kb = Buffer.from(k, 'utf8'); varintOut(out, kb.length); for (const x of kb) out.push(x); canonical(v[k], out); }
  out.push(0x7d);
}

function report(snap) {
  const lines = [];
  let total = 0, totalOk = 0;
  const bs = [...snap.buckets.values()].sort((a, b) => a.dbId - b.dbId || a.osId - b.osId);
  const bucketLines = [];
  for (const b of bs) {
    let c = 0xffffffff;
    const up = (x) => (c = (CRC32C[(c ^ x) & 0xff] ^ (c >>> 8)) >>> 0);
    let ok = 0;
    for (const r of b.records) {
      let decoded = null, failed = false;
      try { decoded = decodeValue(r.value); } catch { failed = true; }
      if (failed) { up(0x00); continue; }
      const canon = [];
      canonical(decoded, canon);
      up(0x01);
      const L = canon.length >>> 0;
      up(L & 0xff); up((L >>> 8) & 0xff); up((L >>> 16) & 0xff); up((L >>> 24) & 0xff);
      for (const x of canon) up(x);
      ok++;
    }
    total += b.records.length;
    totalOk += ok;
    bucketLines.push(`BUCKET\t${b.dbId}:${b.osId}\t${b.records.length}\t${ok}\t${((c ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0')}`);
  }
  lines.push(`GLOBAL\t${total}\t${totalOk}\t${bs.length}`);
  lines.push(...bucketLines);
  return lines;
}

const dir = process.argv[2];
if (!dir) { console.error('usage: diff-ssv.mjs <leveldb-dir> [--rust <report.txt>]'); process.exit(2); }
const rustIdx = process.argv.indexOf('--rust');
const rustFile = rustIdx > 0 ? process.argv[rustIdx + 1] : null;

const ts = report(loadSnapshot(dir));
if (!rustFile) {
  console.log(ts.join('\n'));
  console.log(`\n==== TS SSV oracle: ${ts.length} lines (rerun with --rust to compare) ====`);
  process.exit(0);
}
const rs = fs.readFileSync(rustFile, 'utf8').replace(/\r/g, '').trimEnd().split('\n');
let ok = 0, bad = 0;
for (let i = 0; i < Math.max(ts.length, rs.length); i++) {
  const a = ts[i] ?? '(missing TS)';
  const b = rs[i] ?? '(missing rust)';
  if (a === b) ok++;
  else { bad++; if (bad <= 20) console.log(`FAIL line ${i}\n   ts: ${a}\n   rs: ${b}`); }
}
console.log(`\n==== ${ok} lines match, ${bad} differ ====`);
process.exit(bad ? 1 : 0);
