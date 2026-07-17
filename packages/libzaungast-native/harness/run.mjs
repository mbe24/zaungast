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

const HERE = path.dirname(fileURLToPath(import.meta.url)); // .../harness
const CRATE = path.resolve(HERE, '..'); // .../libzaungast-native
const REPO = path.resolve(CRATE, '..', '..'); // repo root
const RUNNER = (process.env.ZAUNGAST_NATIVE_RUNNER || 'auto').toLowerCase();
const IMAGE = process.env.ZAUNGAST_NATIVE_IMAGE || 'rust:1-slim-bookworm';

const dirArg = process.argv[2];
if (!dirArg) {
  console.error('usage: node harness/run.mjs <leveldb-dir>   [env ZAUNGAST_NATIVE_RUNNER=auto|local|docker]');
  process.exit(2);
}
const dataAbs = path.resolve(dirArg);

// docker mode: build + run difftable over every .ldb inside a Linux container; returns the tsv text
// (<file>\t<count>\t<clean|lossy>\t<crc>). Repo mounted read-only; build happens container-side.
function dockerDigests() {
  const rel = path.relative(REPO, dataAbs).split(path.sep).join('/');
  const containerData = `/work/${rel}`;
  const script = '/work/packages/libzaungast-native/harness/incontainer.sh';
  console.error(`[runner=docker] image=${IMAGE}  data=${containerData}`);
  return execFileSync(
    'docker',
    ['run', '--rm', '-v', `${REPO}:/work:ro`, IMAGE, 'bash', script, containerData],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 256 * 1024 * 1024 },
  );
}

// local mode: cargo build, then run the native binary per .ldb on this host.
function localDigests() {
  const exe = path.join(CRATE, 'target', 'release', process.platform === 'win32' ? 'difftable.exe' : 'difftable');
  console.error('[runner=local] cargo build --release --bin difftable');
  execFileSync('cargo', ['build', '--release', '--bin', 'difftable'], { cwd: CRATE, stdio: ['ignore', 'inherit', 'inherit'] });
  const ldbs = fs.readdirSync(dataAbs).filter((f) => f.endsWith('.ldb')).sort();
  let out = '';
  for (const f of ldbs) {
    const line = execFileSync(exe, [path.join(dataAbs, f)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    out += `${f}\t${line}\n`;
  }
  return out;
}

function dockerAvailable() {
  const r = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8' });
  return r.status === 0 && (r.stdout || '').trim().length > 0;
}

let digests;
if (RUNNER === 'docker') {
  digests = dockerDigests();
} else if (RUNNER === 'local') {
  digests = localDigests();
} else {
  // auto: prefer local; fall back to docker if local execution is denied and docker is present.
  try {
    digests = localDigests();
  } catch (e) {
    if (dockerAvailable()) {
      console.error(`[runner=auto] local run failed (${e.code || e.message}); falling back to docker`);
      digests = dockerDigests();
    } else {
      console.error(
        `[runner=auto] local run failed and Docker is not available:\n  ${e.message}\n` +
          `  → run on an unrestricted host/CI, or install Docker and set ZAUNGAST_NATIVE_RUNNER=docker.`,
      );
      process.exit(1);
    }
  }
}

const tsv = path.join(os.tmpdir(), `zaungast-native-sstable-${process.pid}.tsv`);
fs.writeFileSync(tsv, digests);
const r = spawnSync(process.execPath, [path.join(HERE, 'diff-sstable.mjs'), dataAbs, '--rust', tsv], { stdio: 'inherit' });
fs.rmSync(tsv, { force: true });
process.exit(r.status ?? 1);
