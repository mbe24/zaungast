// Cross-platform (Node) entrypoint for the native differential harness. Produces the Rust reader's
// per-.ldb digests either by running the freshly-built binary directly, or — on hosts that block
// executing freshly-built binaries — inside a Linux Docker container; then diffs them against the TS
// oracle (diff-sstable.mjs). This is DEV/TEST tooling only; it is never part of the shipped package.
//
//   node packages/libzaungast-native/harness/run.mjs <leveldb-dir>
//
// Env:
//   ZAUNGAST_NATIVE_RUNNER = auto (default) | local | docker
//     local  — build + run the binary on this host (normal machines, CI). Cross-platform (cargo + the
//              native exe via Node; no bash, no Docker).
//     docker — build + run inside `ZAUNGAST_NATIVE_IMAGE` (locked-down hosts that deny native exec).
//     auto   — try local; if execution is denied and Docker is present, fall back to docker.
//   ZAUNGAST_NATIVE_IMAGE  = docker image (default rust:1-slim-bookworm)
//
// NOTE: harness/incontainer.sh is bash ON PURPOSE — it only ever runs INSIDE the Linux container.
// The project itself builds cross-platform via plain `cargo`/napi; nothing here is a host build step.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  CRATE,
  IMAGE,
  REPO,
  dockerRunArgs,
  runWithFallback,
  toContainerPath,
} from '../../../scripts/native-runner.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // .../harness

// The mapping the diff bins compare against — read from the single-source registry
// (schema/mappings.json), NOT hardcoded here, so a rename/version bump touches only the registry.
// The diff bins take one mapping file; use the first (highest-precedence) registered entry.
const MAPPING = `packages/libzaungast/src/schema/versions/${
  JSON.parse(fs.readFileSync(path.join(REPO, 'packages/libzaungast/src/schema/mappings.json'), 'utf8'))[0]
}`;

// layer config: which native bin + how it's invoked + which TS comparator.
const LAYERS = {
  sstable: { bin: 'difftable', mode: 'perfile', harness: 'diff-sstable.mjs' },
  snapshot: { bin: 'diffsnap', mode: 'whole', harness: 'diff-snapshot.mjs' },
  // copy-reuse: diffreuse self-asserts cold==warm==full (no false compaction) and emits the
  // WARM cache-reusing report in diffsnap format, so the SAME oracle proves warm-reuse == TS-full.
  reuse: { bin: 'diffreuse', mode: 'whole', harness: 'diff-snapshot.mjs' },
  ssv: { bin: 'diffssv', mode: 'whole', harness: 'diff-ssv.mjs' },
  fp: { bin: 'difffp', mode: 'whole', harness: 'diff-fp.mjs' },
  // extract needs the mapping file (repo-relative) passed to both the bin and the TS harness
  extract: {
    bin: 'diffextract',
    mode: 'whole',
    harness: 'diff-extract.mjs',
    extra: MAPPING,
  },
  htmltext: {
    bin: 'difftext',
    mode: 'whole',
    harness: 'diff-htmltext.mjs',
    extra: MAPPING,
  },
  store: {
    bin: 'diffstore',
    mode: 'whole',
    harness: 'diff-store.mjs',
    extra: MAPPING,
    // binExtra: passed to the Rust bin ONLY (after `extra`), not to the TS harness. The store bin
    // reads the DDL from the SAME single-source schema.sql the TS ingest uses (single-source schema.sql proof).
    binExtra: ['packages/libzaungast/src/schema.sql'],
    nodeFlags: ['--experimental-sqlite'], // TS ingest uses node:sqlite
  },
  incr: {
    bin: 'diffincr',
    mode: 'whole',
    harness: 'diff-incr.mjs',
    extra: MAPPING,
    binExtra: ['packages/libzaungast/src/schema.sql'],
    nodeFlags: ['--experimental-sqlite'], // three-way: native-incr == native-full == TS-full
  },
};
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const layerIdx = process.argv.indexOf('--layer');
const layerName = layerIdx > 0 ? process.argv[layerIdx + 1] : 'sstable';
const L = LAYERS[layerName];
const dirArg = args[0];
if (!L || !dirArg) {
  console.error(
    'usage: node harness/run.mjs <leveldb-dir> [--layer sstable|snapshot|reuse|ssv|fp|extract|htmltext|store|incr]   [env ZAUNGAST_NATIVE_RUNNER=auto|local|docker]\n' +
      '  (prefer `npm run diff -- <dir|date> [--layer <name>|all]` — resolves the leveldb dir and runs multiple layers)',
  );
  process.exit(2);
}
const dataAbs = path.resolve(dirArg);
const exeName = (b) => (process.platform === 'win32' ? `${b}.exe` : b);

// docker mode: build + run the layer's bin inside a Linux container. Mount convention + the registry
// and target caches come from native-runner (shared with check:native + native-test); the target
// volume means the build is NOT recompiled from scratch each layer. Returns the digest text.
function dockerDigests() {
  const containerData = toContainerPath(dataAbs);
  const script = '/work/packages/libzaungast-native/harness/incontainer.sh';
  console.error(`[runner=docker layer=${layerName}] image=${IMAGE}  data=${containerData}`);
  const extra = [...(L.extra ? [L.extra] : []), ...(L.binExtra || [])].map((p) => `/work/${p}`);
  return execFileSync(
    'docker',
    [...dockerRunArgs(), IMAGE, 'bash', script, containerData, L.bin, L.mode, ...extra],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 256 * 1024 * 1024 },
  );
}

// local mode: cargo build (all bins), then run the layer's bin on this host.
function localDigests() {
  const exe = path.join(CRATE, 'target', 'release', exeName(L.bin));
  console.error(`[runner=local layer=${layerName}] cargo build --release`);
  execFileSync('cargo', ['build', '--release', '--features', 'harness'], { cwd: CRATE, stdio: ['ignore', 'inherit', 'inherit'] });
  if (L.mode === 'whole') {
    const extra = [...(L.extra ? [L.extra] : []), ...(L.binExtra || [])].map((p) => path.resolve(REPO, p));
    return execFileSync(exe, [dataAbs, ...extra], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 256 * 1024 * 1024 });
  }
  const ldbs = fs.readdirSync(dataAbs).filter((f) => f.endsWith('.ldb')).sort();
  let out = '';
  for (const f of ldbs) {
    const line = execFileSync(exe, [path.join(dataAbs, f)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
    out += `${f}\t${line}\n`;
  }
  return out;
}

// Runner selection (local / docker / auto-with-fallback) is shared with check:native + native-test.
const digests = runWithFallback(localDigests, dockerDigests, { label: `layer=${layerName}` });

const tsv = path.join(os.tmpdir(), `zaungast-native-${layerName}-${process.pid}.tsv`);
fs.writeFileSync(tsv, digests);
const harnessArgs = [...(L.nodeFlags || []), path.join(HERE, L.harness), dataAbs, '--rust', tsv];
if (L.extra) harnessArgs.push('--mapping', path.resolve(REPO, L.extra));
const r = spawnSync(process.execPath, harnessArgs, { stdio: 'inherit' });
fs.rmSync(tsv, { force: true });
process.exit(r.status ?? 1);
