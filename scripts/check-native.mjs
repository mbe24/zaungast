// scripts/check-native.mjs — the Rust style + lint gate for libzaungast-native: `cargo fmt --check`
// plus `cargo clippy` at clippy::pedantic (warnings denied) over both feature sets — `harness` (lib +
// diff bins) and `napi` (the addon). Mirrors the byte-differential harness: it runs LOCALLY when cargo
// can build on this host, and only falls back to Docker when it can't (e.g. the Windows sandbox denies
// native build). Same knob as harness/run.mjs:
//   ZAUNGAST_NATIVE_RUNNER = auto (default) | local | docker
//     local  — cargo on this host (normal machines, CI, WSL).
//     docker — inside ZAUNGAST_NATIVE_IMAGE (hosts that deny native build/exec).
//     auto   — try local; if cargo can't build/run here and Docker is present, fall back to docker.
//   ZAUNGAST_NATIVE_IMAGE  = docker image (default rust:1-slim-bookworm)
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CRATE = path.join(REPO, 'packages', 'libzaungast-native');
const RUNNER = (process.env.ZAUNGAST_NATIVE_RUNNER || 'auto').toLowerCase();
const IMAGE = process.env.ZAUNGAST_NATIVE_IMAGE || 'rust:1-slim-bookworm';

// clippy::pedantic is the post-change gate; deliberate opt-outs live in lib.rs/bindings.rs #![allow].
// -D warnings makes any surviving warning fail the check; --no-deps keeps it to our own crate.
const PEDANTIC = ['--', '-W', 'clippy::pedantic', '-D', 'warnings'];
const STEPS = [
  ['fmt', '--check'],
  ['clippy', '--features', 'harness', '--all-targets', '--no-deps', ...PEDANTIC],
  ['clippy', '--features', 'napi', '--lib', '--no-deps', ...PEDANTIC],
];

function local() {
  console.error('[check:native runner=local] cargo fmt --check + clippy (harness, napi)');
  for (const args of STEPS) execFileSync('cargo', args, { cwd: CRATE, stdio: 'inherit' });
}

function docker() {
  console.error(`[check:native runner=docker] image=${IMAGE}`);
  // The slim image ships cargo but not clippy/rustfmt — add them. Build into /tmp/target so the
  // mounted working tree is never written; the named volume caches the crate registry across runs.
  const cmd = [
    'rustup component add clippy rustfmt >/dev/null 2>&1 || true',
    ...STEPS.map((args) => `cargo ${args.join(' ')}`),
  ].join(' && ');
  execFileSync(
    'docker',
    [
      'run', '--rm',
      '-v', `${REPO}:/work`,
      '-v', 'zaungast-native-cargo:/usr/local/cargo/registry',
      '-w', '/work/packages/libzaungast-native',
      '-e', 'CARGO_TARGET_DIR=/tmp/target',
      IMAGE, 'bash', '-c', cmd,
    ],
    { stdio: 'inherit' },
  );
}

function dockerAvailable() {
  const r = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8' });
  return r.status === 0 && (r.stdout || '').trim().length > 0;
}

if (RUNNER === 'docker') {
  docker();
} else if (RUNNER === 'local') {
  local();
} else {
  // auto: local first; fall back to Docker only when cargo can't build/run here (e.g. Windows sandbox).
  try {
    local();
  } catch (e) {
    if (dockerAvailable()) {
      console.error(`[check:native runner=auto] local cargo failed (${e.code || e.message}); falling back to Docker`);
      docker();
    } else {
      console.error('[check:native] cargo is blocked/absent here and Docker is unavailable — run on Linux/WSL or install Docker.');
      process.exit(1);
    }
  }
}
