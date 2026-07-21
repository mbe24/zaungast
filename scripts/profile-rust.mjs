// scripts/profile-rust.mjs — one-command wrapper for the native (Rust) profiler, mirroring the ease of
// the TS `scripts/profile.mjs`. It resolves the single-source `schema.sql` + the highest-precedence
// mapping version (from `schema/mappings.json`, exactly as the diff harness does), stamps an output
// dir, and runs the `profile` harness bin via cargo. So all you pass is the data dir (+ `--heavy`):
//   node scripts/profile-rust.mjs [<leveldb-dir>] [--heavy | -n N]
//   npm run profile:native -- [<leveldb-dir>] [--heavy]
// Writes profiling/native-<YYYYMMDD-HHMMSS>/timings.json. Pair it with a TS run on the SAME dir
// (`npm run profile -- <dir> --heavy`) for a JS-vs-native profiling.md.
//
// Native build/run only → WSL2/Linux (the Windows host blocks executing freshly-built native code).
// `cargo run --release` builds on demand, so no separate build step (unlike the TS profiler).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Same default dir as scripts/profile.mjs, so both wrappers behave identically with no args.
const DEFAULT_DIR = 'data/2026-07-15/https_teams.microsoft.com_0.indexeddb.leveldb';

// Single-source inputs, resolved exactly like harness/run.mjs: the DDL both engines exec, and the
// first (highest-precedence) registered mapping version — a rename/bump touches only the registry.
const SCHEMA = 'packages/libzaungast/src/schema.sql';
const MAPPING = `packages/libzaungast/src/schema/versions/${
  JSON.parse(
    fs.readFileSync(path.join(REPO, 'packages/libzaungast/src/schema/mappings.json'), 'utf8'),
  )[0]
}`;

// First non-flag arg is the data dir (default otherwise); everything else passes through to the bin
// (--heavy, -n N, …). The bin re-parses, so flag/positional order doesn't matter.
const argv = process.argv.slice(2);
let dir;
let pass;
if (argv[0] && !argv[0].startsWith('-')) {
  dir = argv[0];
  pass = argv.slice(1);
} else {
  dir = DEFAULT_DIR;
  pass = argv;
}

const d = new Date();
const p2 = (n) => String(n).padStart(2, '0');
const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
const outDir = path.join('profiling', `native-${stamp}`);

const cargoArgs = [
  'run', '--release', '--features', 'harness',
  '--manifest-path', 'packages/libzaungast-native/Cargo.toml',
  '--bin', 'profile', '--',
  dir, SCHEMA, MAPPING, ...pass, '--out', outDir,
];
console.error(`[profile:native] cargo ${cargoArgs.join(' ')}`);
console.error(`[profile:native] → ${outDir}/timings.json  (native build/run needs WSL2/Linux)`);
// cwd: REPO so the bin (and its --cold child) resolve the repo-relative dir/schema/mapping/out paths.
execFileSync('cargo', cargoArgs, { cwd: REPO, stdio: 'inherit' });
