// CI integration runner: generate a synthetic .ldb+.log leveldb fixture and run the
// mutation/equivalence harnesses against it — no real Teams cache (no PII), so this runs in CI.
//
// Each harness gets a FRESH fixture dir, because _inctest/_reusetest mutate their source dir
// (truncate .ldb, append .log, force compaction) — sharing one dir across harnesses would let
// earlier mutations corrupt later runs. The synthetic fixture is tiny, so this is fast.
//
// Run: node --experimental-sqlite --import tsx test/run-integration.ts  (or `npm run test:integration:ci`)
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateFixtureWithTables } from './fixture/generate.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const harnesses = ['_inctest.ts', '_reusetest.ts', '_fbtest.ts']

let failed = 0
for (const h of harnesses) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaungast-ci-'))
  generateFixtureWithTables(dir)
  console.log(`\n########## ${h} (synthetic .ldb+.log) ##########`)
  const r = spawnSync(
    process.execPath,
    ['--experimental-sqlite', '--import', 'tsx', path.join(here, h), dir],
    { stdio: 'inherit' },
  )
  if (r.status !== 0) { failed++; console.error(`FAILED: ${h} (exit ${r.status})`) }
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log(`\n==== integration: ${harnesses.length - failed}/${harnesses.length} harnesses passed ====`)
process.exit(failed ? 1 : 0)
