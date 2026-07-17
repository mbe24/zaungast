// Differential harness — fingerprint layer. Computes the TS schema fingerprint and (with --rust)
// diffs it line-by-line against Rust's `difffp`. A matching FP hash proves the whole upstream stack
// (buckets, sampling, decode, db-name normalization, sort, canonical JSON, SHA-256) is byte-identical
// — and it must equal the frozen known fingerprint, or mapping selection would break.
//   node packages/libzaungast-native/harness/diff-fp.mjs <leveldb-dir> [--rust <report.txt>]
import fs from 'node:fs';
import { loadSnapshot, fingerprint } from '../../libzaungast/dist/format/index.js';

function report(snap) {
  const fp = fingerprint(snap);
  const lines = [`FP\t${fp.hash}\t${fp.storeCount}\t${fp.dbCount}`];
  for (const s of fp.stores) lines.push(`S\t${s.db}\t${s.store}\t${s.fields.join(',')}`);
  return { lines, hash: fp.hash };
}

const dir = process.argv[2];
if (!dir) { console.error('usage: diff-fp.mjs <leveldb-dir> [--rust <report.txt>]'); process.exit(2); }
const rustIdx = process.argv.indexOf('--rust');
const rustFile = rustIdx > 0 ? process.argv[rustIdx + 1] : null;

const { lines: ts, hash } = report(loadSnapshot(dir));
if (!rustFile) {
  console.log(ts.join('\n'));
  console.log(`\n==== TS fingerprint = ${hash} (${ts.length - 1} stores) ====`);
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
console.log(`\n==== ${ok} lines match, ${bad} differ ==== (TS fingerprint ${hash})`);
process.exit(bad ? 1 : 0);
