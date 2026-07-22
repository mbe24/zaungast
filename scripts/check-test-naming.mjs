// Test-file naming guard. Vitest discovers tests by include-glob: a file whose name matches a role
// glob runs, and a file that matches NONE is silently ignored — vitest can't warn about a file it
// never claimed. That reintroduces this repo's historical failure mode (a test that exists but never
// runs, while CI stays green). This guard closes the gap: it walks every .ts under packages/*/test/**,
// subtracts the known non-test helpers, and HARD-FAILS if any remaining file lacks a role suffix
// (.unit/.fixture/.golden/.int/.real). Run in CI BEFORE vitest — see `check:test-naming`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROLES = ['unit', 'fixture', 'golden', 'int', 'real'];
// Not tests: files under test/fixture/ are the synthetic-data GENERATORS + encoders, not test suites.
const HELPER_DIRS = new Set(['fixture']);

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (HELPER_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    // Collect every TS-ish extension, not just `.ts`: a `foo.int.mts` would dodge BOTH vitest's
    // `*.<role>.ts` include globs AND this guard if we only looked at `.ts` — the exact silent-skip
    // hole the guard exists to close. roleOf only accepts `.<role>.ts`, so a wrong extension flags.
    else if (/\.(ts|mts|cts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

const roleOf = (file) => {
  const m = path.basename(file).match(/\.([a-z]+)\.ts$/);
  return m && ROLES.includes(m[1]) ? m[1] : null;
};

const testDirs = fs
  .readdirSync(path.join(REPO, 'packages'), { withFileTypes: true })
  .filter((e) => e.isDirectory() && fs.existsSync(path.join(REPO, 'packages', e.name, 'test')))
  .map((e) => path.join(REPO, 'packages', e.name, 'test'));

const all = testDirs.flatMap(walk);
const unclassified = all.filter((f) => roleOf(f) === null);

if (unclassified.length) {
  console.error(
    'FAIL test-naming: these test files have no role suffix (.unit/.fixture/.golden/.int/.real) and ' +
      'would be SILENTLY IGNORED by vitest — rename them:',
  );
  for (const f of unclassified) console.error(`  ${path.relative(REPO, f)}`);
  process.exit(1);
}

const counts = ROLES.map((r) => `${all.filter((f) => roleOf(f) === r).length} ${r}`).join(', ');
console.log(`PASS test-naming: all ${all.length} test files classified (${counts}).`);
