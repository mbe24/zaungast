// scripts/native-verify.mjs — the full local native gate in one command: fmt + clippy (check:native)
// + Rust unit tests, and — if a leveldb dir is given — the store+incr byte-differential against it.
// Mirrors what CI enforces (check:native + cargo test) plus the differential a maintainer runs against
// a real cache. Each step uses the shared runner (local or Docker). Stops at the first failure.
//   npm run verify:native                 # fmt/clippy/tests only (no differential — no dir)
//   npm run verify:native -- <dir|date>   # + store+incr differential against that cache
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveLevelDbDir } from './native-runner.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Resolve ONCE here (dir / parent / data date) and hand the resolved absolute leveldb path to both
// test:native and diff, so a `verify:native -- 2026-07-20` works end-to-end (both sub-steps agree).
const rawArg = process.argv.slice(2).filter((a) => !a.startsWith('-'))[0] || null;
const dataDir = rawArg ? resolveLevelDbDir(rawArg) : null;
if (rawArg && !dataDir) {
  console.error(`[verify:native] could not resolve a leveldb dir from "${rawArg}"`);
  process.exit(2);
}

const steps = [
  ['check:native (fmt + clippy)', [path.join(HERE, 'check-native.mjs')]],
  ['test:native (cargo test)', [path.join(HERE, 'native-test.mjs'), ...(dataDir ? [dataDir] : [])]],
];
if (dataDir) steps.push(['diff (store + incr)', [path.join(HERE, 'native-diff.mjs'), dataDir]]);
else console.error('[verify:native] no leveldb dir given → running fmt/clippy/tests only (no differential)');

for (const [label, args] of steps) {
  console.error(`\n########## verify:native → ${label} ##########`);
  const r = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if ((r.status ?? 1) !== 0) {
    console.error(`\nverify:native FAILED at: ${label}`);
    process.exit(1);
  }
}
console.error('\nverify:native: all steps passed ✔');
