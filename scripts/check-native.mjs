// scripts/check-native.mjs — the Rust style + lint gate for libzaungast-native: `cargo fmt --check`
// plus `cargo clippy` at clippy::pedantic (warnings denied) over both feature sets — `harness` (lib +
// diff bins) and `napi` (the addon). Runs LOCALLY when cargo can build on this host, and falls back to
// Docker when it can't (e.g. the Windows sandbox denies native build). Runner selection + the Docker
// invocation convention are shared with the differential harness + unit tests via native-runner.mjs.
//   ZAUNGAST_NATIVE_RUNNER = auto (default) | local | docker
//   ZAUNGAST_NATIVE_IMAGE  = docker image (default rust:1-slim-bookworm)
import { execFileSync } from 'node:child_process';
import { CRATE, IMAGE, dockerRunArgs, runWithFallback } from './native-runner.mjs';

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
  // The slim image ships cargo but not clippy/rustfmt — add them. Build into the shared target volume
  // (via dockerRunArgs' CARGO_TARGET_DIR) so runs reuse artifacts instead of recompiling from scratch.
  const cmd = [
    'rustup component add clippy rustfmt >/dev/null 2>&1 || true',
    ...STEPS.map((args) => `cargo ${args.join(' ')}`),
  ].join(' && ');
  execFileSync('docker', [...dockerRunArgs(), IMAGE, 'bash', '-c', cmd], { stdio: 'inherit' });
}

runWithFallback(local, docker, { label: 'check:native' });
