// scripts/native-runner.mjs — the SINGLE source of the local↔Docker runner selection + the Docker
// invocation convention for every Rust task: fmt/clippy (check:native), the byte-differential harness
// (harness/run.mjs), and the unit tests (native-test.mjs). Previously the `auto/local/docker` cascade,
// `dockerAvailable()`, and the mount convention were duplicated across check-native.mjs and
// harness/run.mjs (with a third, local-only variant in profile-rust.mjs — profiling is deliberately
// host/WSL only, see the Docker note below, so it does not use this module).
//
// One convention for all tasks:
//   - repo mounted at /work (read-write, so cargo may touch Cargo.lock; nothing else is written there);
//   - a named cargo-registry volume AND a named target-cache volume, so a container build does NOT
//     recompile the crate from scratch every run (the harness used to eat ~40s/layer copying to /build
//     and building cold);
//   - CARGO_TARGET_DIR redirected off the mount into the target volume;
//   - stderr is ALWAYS surfaced by callers (a diff-bin panic used to be swallowed by `2>/dev/null`).
//
// Docker is for CORRECTNESS only. Profiling stays local/WSL: a bind-mount inflates leveldb I/O ~6×, so
// timing fidelity requires bare metal — profiling is uniform in output schema, not in runner.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CRATE = path.join(REPO, 'packages', 'libzaungast-native');
export const RUNNER = (process.env.ZAUNGAST_NATIVE_RUNNER || 'auto').toLowerCase();
export const IMAGE = process.env.ZAUNGAST_NATIVE_IMAGE || 'rust:1-slim-bookworm';
export const REGISTRY_VOLUME = 'zaungast-native-cargo';
// Persistent build cache. Rebuild detection is mtime-based over the bind mount; if a stale artifact is
// ever reused, `docker volume rm zaungast-native-target` forces a clean rebuild.
export const TARGET_VOLUME = 'zaungast-native-target';

export function dockerAvailable() {
  const r = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8' });
  return r.status === 0 && (r.stdout || '').trim().length > 0;
}

// The shared `docker run …` argument prefix — everything up to the image. `env` entries are passed
// with -e (values already in container terms). The registry + target volumes cache across runs.
export function dockerRunArgs({ env = {} } = {}) {
  const args = [
    'run',
    '--rm',
    '-v',
    `${REPO}:/work`,
    '-v',
    `${REGISTRY_VOLUME}:/usr/local/cargo/registry`,
    '-v',
    `${TARGET_VOLUME}:/tmp/target`,
    '-w',
    '/work/packages/libzaungast-native',
    '-e',
    'CARGO_TARGET_DIR=/tmp/target',
  ];
  for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
  return args;
}

// Resolve a leveldb dir from: the dir itself (has a CURRENT file); a parent that contains a *.leveldb
// subdir; or a bare data date (e.g. "2026-07-20") under <repo>/data/. Returns an absolute path or null.
// Shared by the `diff`, `test:native`, and `verify:native` entrypoints so they resolve identically.
export function resolveLevelDbDir(input) {
  if (!input) return null;
  const isLevelDb = (d) => fs.existsSync(path.join(d, 'CURRENT'));
  const findSub = (d) =>
    fs.existsSync(d) && fs.statSync(d).isDirectory()
      ? fs
          .readdirSync(d, { withFileTypes: true })
          .filter((e) => e.isDirectory() && e.name.endsWith('.leveldb'))
          .map((e) => path.join(d, e.name))
          .find(isLevelDb)
      : undefined;
  for (const c of [path.resolve(input), path.resolve(REPO, 'data', input)]) {
    if (!fs.existsSync(c)) continue;
    if (isLevelDb(c)) return c;
    const sub = findSub(c);
    if (sub) return sub;
  }
  return null;
}

// Translate a host path under REPO to its /work/<rel> path inside the container. Throws if the path is
// outside REPO (it wouldn't be visible in the mount).
export function toContainerPath(hostAbs) {
  const rel = path.relative(REPO, path.resolve(hostAbs));
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`path ${hostAbs} is outside the repo (${REPO}); it can't be mounted into the container`);
  }
  return `/work/${rel.split(path.sep).join('/')}`;
}

// Run one of the two branches per ZAUNGAST_NATIVE_RUNNER. `auto` tries local and, on failure, falls
// back to Docker if available (the maintainer's host blocks native build/exec — Docker is the escape
// hatch). `local`/`docker` force the choice (CI uses `local`; a locked-down host uses `docker`).
export function runWithFallback(localFn, dockerFn, { label = 'native' } = {}) {
  if (RUNNER === 'docker') return dockerFn();
  if (RUNNER === 'local') return localFn();
  try {
    return localFn();
  } catch (e) {
    if (dockerAvailable()) {
      console.error(`[${label} runner=auto] local failed (${e.code || e.message}); falling back to Docker`);
      return dockerFn();
    }
    console.error(
      `[${label}] cargo is blocked/absent here and Docker is unavailable — run on Linux/WSL or install Docker.`,
    );
    process.exit(1);
  }
}
