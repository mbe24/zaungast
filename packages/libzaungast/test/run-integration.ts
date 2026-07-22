// CI integration runner: generate a synthetic .ldb+.log leveldb fixture and run the
// mutation/equivalence harnesses against it — no real Teams cache (no PII), so this runs in CI.
//
// Each harness gets a FRESH fixture dir, because the incremental/reuse harnesses mutate their source
// dir (truncate .ldb, append .log, force compaction) — sharing one dir across harnesses would let
// earlier mutations corrupt later runs. The synthetic fixture is tiny, so this is fast.
//
// Run: node --experimental-sqlite --import tsx test/run-integration.ts  (or `npm run test:integration:ci`)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateFixtureWithTables } from './fixture/generate.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// incremental/reuse.int are libzaungast reader tests (here); feedback.int is a zaungast MCP-tool e2e
// test (cross-package) — all three run against a fresh synthetic fixture (libzaungast's generator).
const harnesses = ['incremental.int.ts', 'reuse.int.ts', '../../zaungast/test/feedback.int.ts'];

let failed = 0;
for (const h of harnesses) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaungast-ci-'));
  generateFixtureWithTables(dir);
  console.log(`\n########## ${h} (synthetic .ldb+.log) ##########`);
  // Inherit this process's node flags (--conditions=development, --experimental-sqlite, --import tsx)
  // so the spawned harness resolves the `libzaungast`/`zaungast` workspace packages to source too.
  const r = spawnSync(process.execPath, [...process.execArgv, path.join(here, h), dir], {
    stdio: 'inherit',
  });
  if (r.status !== 0) {
    failed++;
    console.error(`FAILED: ${h} (exit ${r.status})`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(
  `\n==== integration: ${harnesses.length - failed}/${harnesses.length} harnesses passed ====`,
);
process.exit(failed ? 1 : 0);
