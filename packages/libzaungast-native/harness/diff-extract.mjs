// Differential harness — extract layer (mapping application). Selects the mapping for the snapshot's
// fingerprint, extracts every entity via the TS extractEntity, canonicalizes each row (same rules as
// ssv.rs canonical()), crc32c's per entity, and (with --rust) diffs against Rust's `diffextract`.
// Proves the generic mapping application (db-glob targets, field paths, iterate/keep) matches.
//   node .../diff-extract.mjs <leveldb-dir> --mapping <mapping.json> [--rust <report.txt>]
import fs from 'node:fs';
import { loadSnapshot, fingerprint, selectMapping, extractEntity, loadMapping } from '../../libzaungast/dist/format/index.js';

const CRC32C = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? (0x82f63b78 ^ (c >>> 1)) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const f64 = Buffer.alloc(8);
function pushF64(out, n) { f64.writeDoubleLE(n, 0); for (let i = 0; i < 8; i++) out.push(f64[i]); }
function varintOut(out, n) { n = Number(n); for (;;) { const b = n & 0x7f; n = Math.floor(n / 128); if (n !== 0) out.push(b | 0x80); else { out.push(b); break; } } }
function pushBigMag(out, m) { const a = []; while (m > 0n) { a.push(Number(m & 0xffn)); m >>= 8n; } varintOut(out, a.length); for (const x of a) out.push(x); }
function canonical(v, out) {
  if (v === undefined) return void out.push(0x75);
  if (v === null) return void out.push(0x6e);
  const t = typeof v;
  if (t === 'boolean') return void out.push(v ? 0x54 : 0x46);
  if (t === 'number') { out.push(0x64); pushF64(out, v); return; }
  if (t === 'bigint') { out.push(0x47); out.push(v < 0n ? 1 : 0); pushBigMag(out, v < 0n ? -v : v); return; }
  if (t === 'string') { out.push(0x73); const b = Buffer.from(v, 'utf8'); varintOut(out, b.length); for (const x of b) out.push(x); return; }
  if (v instanceof Date) { out.push(0x4d); pushF64(out, v.getTime()); return; }
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) { out.push(0x62); varintOut(out, v.length); for (const x of v) out.push(x); return; }
  if (Array.isArray(v)) { out.push(0x5b); varintOut(out, v.length); for (const it of v) canonical(it, out); out.push(0x5d); return; }
  out.push(0x7b);
  const keys = Object.keys(v).sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
  for (const k of keys) { const kb = Buffer.from(k, 'utf8'); varintOut(out, kb.length); for (const x of kb) out.push(x); canonical(v[k], out); }
  out.push(0x7d);
}

const dir = process.argv[2];
const mapIdx = process.argv.indexOf('--mapping');
const mappingPath = mapIdx > 0 ? process.argv[mapIdx + 1] : null;
if (!dir || !mappingPath) { console.error('usage: diff-extract.mjs <leveldb-dir> --mapping <file> [--rust <report>]'); process.exit(2); }
const rustIdx = process.argv.indexOf('--rust');
const rustFile = rustIdx > 0 ? process.argv[rustIdx + 1] : null;

const snap = loadSnapshot(dir);
const fp = fingerprint(snap);
const mapping = selectMapping(fp, { mappings: [loadMapping(mappingPath)] }).mapping;
if (!mapping) { console.error(`no mapping matched fingerprint ${fp.hash}`); process.exit(1); }

const ts = [];
for (const name of Object.keys(mapping.entities).sort()) {
  const { records, decoded, dropped } = extractEntity(snap, mapping, name);
  let c = 0xffffffff;
  const up = (x) => (c = (CRC32C[(c ^ x) & 0xff] ^ (c >>> 8)) >>> 0);
  for (const row of records) {
    const canon = [];
    canonical(row, canon);
    const L = canon.length >>> 0;
    up(L & 0xff); up((L >>> 8) & 0xff); up((L >>> 16) & 0xff); up((L >>> 24) & 0xff);
    for (const x of canon) up(x);
  }
  ts.push(`E\t${name}\t${records.length}\t${decoded}\t${dropped}\t${((c ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0')}`);
}

if (!rustFile) {
  console.log(ts.join('\n'));
  console.log(`\n==== TS extract oracle: ${ts.length} entities (fp ${fp.hash}) ====`);
  process.exit(0);
}
const rs = fs.readFileSync(rustFile, 'utf8').replace(/\r/g, '').trimEnd().split('\n');
let ok = 0, bad = 0;
for (let i = 0; i < Math.max(ts.length, rs.length); i++) {
  const a = ts[i] ?? '(missing TS)';
  const b = rs[i] ?? '(missing rust)';
  if (a === b) ok++;
  else { bad++; console.log(`FAIL\n   ts: ${a}\n   rs: ${b}`); }
}
console.log(`\n==== ${ok} entities match, ${bad} differ ====`);
process.exit(bad ? 1 : 0);
