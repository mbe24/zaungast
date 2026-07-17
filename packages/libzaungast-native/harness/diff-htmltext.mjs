// Differential harness — htmltext layer. Extracts message rows, runs the TS htmlToText over each
// `content`, crc32c's the outputs, and (with --rust) diffs against Rust's `difftext`. Validates the
// htmlToText port over the real message corpus (~11.8k messages) — the same content the golden hashes.
//   node .../diff-htmltext.mjs <leveldb-dir> --mapping <mapping.json> [--rust <report.txt>]
import fs from 'node:fs';
import { loadSnapshot, fingerprint, selectMapping, extractEntity, loadMapping } from '../../libzaungast/dist/format/index.js';
import { htmlToText } from '../../libzaungast/dist/util/text.js';

const CRC32C = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? (0x82f63b78 ^ (c >>> 1)) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();

const dir = process.argv[2];
const mapIdx = process.argv.indexOf('--mapping');
const mappingPath = mapIdx > 0 ? process.argv[mapIdx + 1] : null;
if (!dir || !mappingPath) { console.error('usage: diff-htmltext.mjs <leveldb-dir> --mapping <file> [--rust <report>]'); process.exit(2); }
const rustIdx = process.argv.indexOf('--rust');
const rustFile = rustIdx > 0 ? process.argv[rustIdx + 1] : null;

const snap = loadSnapshot(dir);
const fp = fingerprint(snap);
const mapping = selectMapping(fp, { mappings: [loadMapping(mappingPath)] }).mapping;
const rows = extractEntity(snap, mapping, 'message').records;

let c = 0xffffffff;
const up = (x) => (c = (CRC32C[(c ^ x) & 0xff] ^ (c >>> 8)) >>> 0);
for (const row of rows) {
  const html = typeof row.content === 'string' ? row.content : '';
  const b = Buffer.from(htmlToText(html), 'utf8');
  up(b.length & 0xff); up((b.length >>> 8) & 0xff); up((b.length >>> 16) & 0xff); up((b.length >>> 24) & 0xff);
  for (const x of b) up(x);
}
const ts = `HT\t${rows.length}\t${((c ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0')}`;

if (!rustFile) { console.log(ts); process.exit(0); }
const rs = fs.readFileSync(rustFile, 'utf8').replace(/\r/g, '').trim();
const match = ts === rs;
console.log(`${match ? 'OK' : 'FAIL'}\n   ts: ${ts}\n   rs: ${rs}`);
console.log(`\n==== ${match ? '1 match, 0 differ' : '0 match, 1 differ'} ====`);
process.exit(match ? 0 : 1);
