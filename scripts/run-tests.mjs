// scripts/run-tests.mjs — convention-based test discovery. Instead of enumerating test files literally
// in package.json (where a new file is silently never run), this globs every test under
// packages/*/test/** and dispatches by a ROLE encoded in the filename suffix:
//
//   *.unit.ts     pure unit test, no data           → CI
//   *.fixture.ts  synthetic-fixture-driven          → CI
//   *.golden.ts   synthetic golden (frozen digest)  → CI
//   *.int.ts      needs a leveldb dir — real via ZAUNGAST_TEST_DIR, or synthetic via run-integration.ts
//   *.real.ts     needs a REAL cache (skip-if-absent; never synthetic)
//
// A test file WITHOUT a recognized role suffix is a hard error — you can't add a test the runner
// forgets. Data-role runs (int/real) with no cache available SKIP with a printed reason (visible
// optionality — this repo's failure mode was silent skips), never a silent pass.
//
//   node scripts/run-tests.mjs <role> [leveldb-dir]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveLevelDbDir } from './native-runner.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROLES = ['unit', 'fixture', 'golden', 'int', 'real'];
const DATA_ROLES = new Set(['int', 'real']);
const NODE_FLAGS = ['--conditions=development', '--experimental-sqlite', '--import', 'tsx'];
// Not a test: the CI synthetic-integration orchestrator (it GENERATES fixtures + spawns the .int.ts
// files itself). Excluded from discovery so it isn't flagged as unclassified.
const NOT_A_TEST = new Set(['run-integration.ts']);

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'fixture') continue; // fixture/ holds the generator + encoders, not tests
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

function roleOf(file) {
  const base = path.basename(file);
  if (NOT_A_TEST.has(base)) return null;
  const m = base.match(/\.([a-z]+)\.ts$/);
  return m && ROLES.includes(m[1]) ? m[1] : 'UNCLASSIFIED';
}

// Discover + classify every test file up front; fail loudly on anything unclassified.
const testDirs = fs
  .readdirSync(path.join(REPO, 'packages'), { withFileTypes: true })
  .filter((e) => e.isDirectory() && fs.existsSync(path.join(REPO, 'packages', e.name, 'test')))
  .map((e) => path.join(REPO, 'packages', e.name, 'test'));
const classified = new Map(ROLES.map((r) => [r, []]));
const unclassified = [];
for (const d of testDirs) {
  for (const f of walk(d)) {
    const r = roleOf(f);
    if (r === null) continue;
    if (r === 'UNCLASSIFIED') unclassified.push(f);
    else classified.get(r).push(f);
  }
}
if (unclassified.length) {
  console.error('Unclassified test files (add a role suffix: .unit/.fixture/.golden/.int/.real.ts):');
  for (const f of unclassified) console.error(`  ${path.relative(REPO, f)}`);
  process.exit(2);
}

const role = process.argv[2];
if (!ROLES.includes(role)) {
  console.error(`usage: node scripts/run-tests.mjs <${ROLES.join('|')}> [leveldb-dir]`);
  process.exit(2);
}
const files = classified.get(role).sort();
// Resolve a leveldb dir for the data roles from argv or ZAUNGAST_TEST_DIR (both accept a dir / a
// parent holding a *.leveldb subdir / a bare data date). `int` tests hard-require a dir — they exit 1
// without one — so if none is available we print a visible SKIP. `real` tests self-resolve their own
// corpus (ZAUNGAST_REAL_DIR / autofind under data/) and self-skip, so they are ALWAYS spawned (gating
// them here would suppress a golden check that otherwise runs against a local real cache).
const dir = DATA_ROLES.has(role)
  ? resolveLevelDbDir(process.argv[3] ?? process.env.ZAUNGAST_TEST_DIR)
  : null;

if (role === 'int' && !dir) {
  console.error(
    `[int] SKIPPED ${files.length} test(s) — no leveldb dir (pass one, or set ZAUNGAST_TEST_DIR):`,
  );
  for (const f of files) console.error(`  · ${path.relative(REPO, f)}`);
  process.exit(0); // a visible skip is not a failure
}

let failed = 0;
for (const f of files) {
  console.log(`\n########## [${role}] ${path.relative(REPO, f)} ##########`);
  const env = dir ? { ...process.env, ZAUNGAST_TEST_DIR: dir } : process.env;
  const r = spawnSync(process.execPath, [...NODE_FLAGS, f, ...(dir ? [dir] : [])], { stdio: 'inherit', env });
  if ((r.status ?? 1) !== 0) {
    failed++;
    console.error(`FAILED: ${path.relative(REPO, f)} (exit ${r.status})`);
  }
}
console.log(`\n==== ${role}: ${files.length - failed}/${files.length} passed ====`);
process.exit(failed ? 1 : 0);
