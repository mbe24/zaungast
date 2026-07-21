// External-install smoke: prove a PUBLISHED libzaungast works for an outside consumer, i.e. that it
// resolves to `dist` (not `src` via the `development` condition, which only in-repo tooling passes)
// and that its schema assets (schema.sql + schema/versions/*.json) are packed and readable.
//
// It packs libzaungast exactly as `npm publish` would, installs the tarball into a throwaway consumer
// OUTSIDE the workspace, and imports it under PLAIN node (no --conditions=development). This is the
// guard for the one real publish risk: the dev exports-condition leaking to consumers.
//
// MANUAL check, run by hand — NOT wired into CI (it's ~16s and the failure mode is static). Run it
// when you change anything packaging-related: an `exports` subpath (e.g. adding engine-spi), the
// `files` field, or how the schema assets land in `dist`.
//
//   npm run smoke:external-install
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zg-extsmoke-'));
const run = (cmd, cwd) => execSync(cmd, { cwd, stdio: 'inherit' });

try {
  console.log('› building + packing libzaungast (as npm publish would)…');
  run('npm run build --workspace libzaungast', REPO);
  run(`npm pack --workspace libzaungast --pack-destination "${tmp}"`, REPO);
  const tgz = fs.readdirSync(tmp).find((f) => f.endsWith('.tgz'));
  if (!tgz) throw new Error('external-install smoke: npm pack produced no tarball');

  console.log('› installing the tarball into a scratch consumer (outside the workspace)…');
  const consumer = path.join(tmp, 'consumer');
  fs.mkdirSync(consumer);
  fs.writeFileSync(
    path.join(consumer, 'package.json'),
    JSON.stringify({ name: 'consumer', private: true, type: 'module' }),
  );
  run(`npm install --no-save --no-audit --no-fund "${path.join(tmp, tgz)}"`, consumer);

  // Runs under PLAIN node — no --conditions=development — so imports MUST resolve to dist and the
  // schema assets must be present in the packed tarball. A missing asset throws at import (SCHEMA_SQL
  // is read from ../schema.sql at load); the assertions confirm the reads returned real content.
  const check = [
    "import { openStore, inspect } from 'libzaungast';",
    "import { openStoreFile, SCHEMA_SQL, loadBundledMappingTexts, EXPECTED_CONFORMANCE } from 'libzaungast/engine-spi';",
    'const bad = [];',
    "if (typeof openStore !== 'function') bad.push('openStore');",
    "if (typeof inspect !== 'function') bad.push('inspect');",
    "if (typeof openStoreFile !== 'function') bad.push('openStoreFile');",
    "if (typeof SCHEMA_SQL !== 'string' || SCHEMA_SQL.length < 10) bad.push('SCHEMA_SQL (schema.sql read)');",
    'const maps = loadBundledMappingTexts();',
    "if (!Array.isArray(maps) || maps.length === 0) bad.push('loadBundledMappingTexts (versions/*.json read)');",
    "if (typeof EXPECTED_CONFORMANCE !== 'number') bad.push('EXPECTED_CONFORMANCE');",
    "if (bad.length) { console.error('FAIL external-install: ' + bad.join(', ')); process.exit(1); }",
    "console.log('PASS external-install: client API + engine-spi resolve from dist; schema assets readable');",
  ].join('\n');
  fs.writeFileSync(path.join(consumer, 'check.mjs'), check);
  run('node --experimental-sqlite check.mjs', consumer);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
