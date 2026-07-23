// Differential harness — SSTable layer. Compares the Rust native reader against the TS `readTable`
// on every .ldb in a leveldb dir, by (entry count, lossy flag, crc32c digest of all entries).
//
// WHY a separate runner: the agent sandbox can build the Rust crate but CANNOT execute freshly-built
// native binaries (OS execution policy). JS runs fine, so the TS side computes here; run the Rust
// side on YOUR machine. Two modes:
//   • TS oracle only (no exe):   node packages/libzaungast-native/harness/diff-sstable.mjs <leveldb-dir>
//   • full compare (with exe):   ...diff-sstable.mjs <leveldb-dir> <path-to/difftable.exe>
//     (build first:  cd packages/libzaungast-native && cargo build --release)
//
// The digest MUST match Rust's `entries_digest`: crc32c(Castagnoli) fed, per entry in table order:
// keyLen(u32 LE), key bytes, valLen(u32 LE), value bytes.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { readTable } from '../../libzaungast/dist/format/chromium/node-source.js';

const CRC32C = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? (0x82f63b78 ^ (c >>> 1)) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function digest(entries) {
  let c = 0xffffffff;
  const fb = (b) => (c = (CRC32C[(c ^ b) & 0xff] ^ (c >>> 8)) >>> 0);
  const u32 = (x) => { fb(x & 0xff); fb((x >>> 8) & 0xff); fb((x >>> 16) & 0xff); fb((x >>> 24) & 0xff); };
  for (const [k, v] of entries) {
    u32(k.length >>> 0);
    for (const b of k) fb(b);
    u32(v.length >>> 0);
    for (const b of v) fb(b);
  }
  return ((c ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
}

const dir = process.argv[2];
if (!dir) {
  console.error('usage: diff-sstable.mjs <leveldb-dir> [difftable.exe | --rust <rust-digests.tsv>]');
  process.exit(2);
}
// three modes: TS-oracle-only (no extra arg) | spawn a native exe | compare against a captured
// rust-digests file (the container path — lines "<file>\t<count>\t<clean|lossy>\t<crc>").
const rustIdx = process.argv.indexOf('--rust');
const rustFile = rustIdx > 0 ? process.argv[rustIdx + 1] : null;
const exe = !rustFile && process.argv[3] && process.argv[3] !== '--rust' ? process.argv[3] : null;
let rustMap = null;
if (rustFile) {
  rustMap = new Map();
  for (const line of fs.readFileSync(rustFile, 'utf8').split('\n')) {
    const t = line.replace(/\r$/, '').trim();
    if (!t) continue;
    const i = t.indexOf('\t');
    rustMap.set(t.slice(0, i), t.slice(i + 1)); // file -> "count\tlossy\tcrc"
  }
}

const ldbs = fs.readdirSync(dir).filter((f) => f.endsWith('.ldb')).sort();
let ok = 0, bad = 0, oracleOnly = 0;
console.log(`# ${ldbs.length} .ldb files in ${dir}\n# columns: file  count  clean|lossy  crc32c`);
for (const f of ldbs) {
  const p = path.join(dir, f);
  const { entries, lossy } = readTable(p);
  const ts = `${entries.length}\t${lossy ? 'lossy' : 'clean'}\t${digest(entries)}`;
  if (!exe && !rustMap) {
    console.log(`TS   ${f}\t${ts}`);
    oracleOnly++;
    continue;
  }
  let rs;
  if (rustMap) rs = rustMap.get(f) ?? '(missing from rust output)';
  else {
    try {
      rs = execFileSync(exe, [p], { encoding: 'utf8' }).trim();
    } catch (e) {
      rs = 'ERR ' + (e.message || e).toString().split('\n')[0];
    }
  }
  const match = ts === rs;
  match ? ok++ : bad++;
  console.log(`${match ? 'OK  ' : 'FAIL'} ${f}\n       ts: ${ts}\n       rs: ${rs}`);
}
if (exe || rustMap) console.log(`\n==== ${ok} match, ${bad} differ ====`);
else console.log(`\n==== ${oracleOnly} TS oracle digests (rerun with --rust <file> or an exe to compare) ====`);
process.exit(bad ? 1 : 0);
