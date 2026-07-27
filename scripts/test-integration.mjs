// scripts/test-integration.mjs — run the integration suite (vitest `int` project), optionally against a
// REAL leveldb cache.
//
//   npm run test:integration                          # synthetic fixtures only (real-data tests self-skip)
//   npm run test:integration -- <dir|parent|date>     # + real-data tests against that cache
//   ZAUNGAST_TEST_DIR=<dir> npm run test:integration   # same, via env var
//
// The real-data `.int.ts` tests (e.g. mcp.int.ts — the MCP-server-over-stdio round-trip) read
// ZAUNGAST_TEST_DIR and self-skip (staying green) when it's unset, so with no cache this runs only the
// synthetic-fixture cases. A positional <dir|date> is resolved via the shared resolveLevelDbDir (accepts
// the leveldb dir, a parent containing a *.leveldb, or a data date under data/) and sets that env for the
// child; with no positional, an already-set ZAUNGAST_TEST_DIR is respected. vitest owns its own argv (a
// bare positional would become a test-name filter), which is why the dir travels by env — this wrapper
// consumes the positional and forwards any remaining --flags to vitest.
import { spawnSync } from 'node:child_process';
import { REPO, resolveLevelDbDir } from './native-runner.mjs';

const args = process.argv.slice(2);
const positional = args.find((a) => !a.startsWith('-'));
const passthrough = args.filter((a) => a !== positional);

const env = { ...process.env };
if (positional) {
  const dir = resolveLevelDbDir(positional);
  if (!dir) {
    console.error(`could not resolve a leveldb dir from "${positional}"`);
    console.error('usage: npm run test:integration [-- <leveldb-dir|parent|data-date>]');
    process.exit(2);
  }
  env.ZAUNGAST_TEST_DIR = dir;
  console.error(`[test:integration] real cache — ZAUNGAST_TEST_DIR=${dir}`);
}

const r = spawnSync('npx', ['vitest', 'run', '--project', 'int', ...passthrough], {
  cwd: REPO,
  stdio: 'inherit',
  shell: true, // resolve the local vitest bin (and npx.cmd on Windows)
  env,
});
process.exit(r.status ?? 1);
