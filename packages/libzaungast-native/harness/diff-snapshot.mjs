// Differential harness — Snapshot layer (dedup + Chromium key decode + collectSnapshot buckets).
// Computes the TS oracle report via loadSnapshot and (with --rust <file>) diffs it against the Rust
// `diffsnap` report line-by-line. Report: a GLOBAL line + one BUCKET line per store (sorted by
// dbId:osId), each carrying a crc32c over its records IN dedup-insertion order — so a wrong dedup
// winner, wrong prefix decode, or wrong record ORDER (which the fingerprint samples) all diverge.
//   node packages/libzaungast-native/harness/diff-snapshot.mjs <leveldb-dir> [--rust <report.txt>]
import fs from 'node:fs';
import { loadSnapshot } from '../../libzaungast/dist/format/index.js';

const CRC32C = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? (0x82f63b78 ^ (c >>> 1)) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function bucketCrc(records) {
  let c = 0xffffffff;
  const up = (b) => (c = (CRC32C[(c ^ b) & 0xff] ^ (c >>> 8)) >>> 0);
  const u32 = (x) => { up(x & 0xff); up((x >>> 8) & 0xff); up((x >>> 16) & 0xff); up((x >>> 24) & 0xff); };
  for (const r of records) {
    u32(r.key.length >>> 0);
    for (const b of r.key) up(b);
    let s = BigInt(r.seq); // seq → 8 bytes LE (>32-bit → BigInt, not <<)
    for (let i = 0; i < 8; i++) { up(Number(s & 0xffn)); s >>= 8n; }
    up(r.type & 0xff);
    if (r.value == null) u32(0xffffffff);
    else { u32(r.value.length >>> 0); for (const b of r.value) up(b); }
  }
  return ((c ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
}
function report(snap) {
  const lines = [];
  lines.push(`GLOBAL\t${snap.rawCount}\t${snap.uniqueCount}\t${snap.maxSeq}\t${snap.lossy ? 'lossy' : 'clean'}\t${snap.buckets.size}`);
  const bs = [...snap.buckets.values()].sort((a, b) => a.dbId - b.dbId || a.osId - b.osId);
  for (const b of bs) {
    lines.push(`BUCKET\t${b.dbId}:${b.osId}\t${b.records.length}\t${b.maxSeq}\t${b.dbName ?? '-'}\t${b.storeName ?? '-'}\t${bucketCrc(b.records)}`);
  }
  return lines;
}

const dir = process.argv[2];
if (!dir) { console.error('usage: diff-snapshot.mjs <leveldb-dir> [--rust <report.txt>]'); process.exit(2); }
const rustIdx = process.argv.indexOf('--rust');
const rustFile = rustIdx > 0 ? process.argv[rustIdx + 1] : null;

const ts = report(loadSnapshot(dir));
if (!rustFile) {
  console.log(ts.join('\n'));
  console.log(`\n==== TS snapshot oracle: ${ts.length} lines (rerun with --rust to compare) ====`);
  process.exit(0);
}
const rs = fs.readFileSync(rustFile, 'utf8').replace(/\r/g, '').trimEnd().split('\n');
let ok = 0, bad = 0;
const n = Math.max(ts.length, rs.length);
for (let i = 0; i < n; i++) {
  const a = ts[i] ?? '(missing TS)';
  const b = rs[i] ?? '(missing rust)';
  if (a === b) ok++;
  else { bad++; console.log(`FAIL line ${i}\n   ts: ${a}\n   rs: ${b}`); }
}
console.log(`\n==== ${ok} lines match, ${bad} differ ====`);
process.exit(bad ? 1 : 0);
