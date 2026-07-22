// scripts/native-test.mjs — run the Rust unit tests via the shared runner (local or Docker), so
// `npm run test:native` works even on a host that blocks native build/exec (falls back to Docker).
//   npm run test:native                       # pure tests (env-gated parity tests self-skip)
//   npm run test:native -- <dir|date>         # + ZAUNGAST_TEST_DIR → the parity tests run too
//   npm run test:native -- <name-filter>      # a positional that ISN'T a leveldb dir is a cargo filter
//   npm run test:native -- <dir> <name-filter>
// (npm swallows the first `--`, so a bare positional arrives here directly — we disambiguate by
// asking resolveLevelDbDir whether the first positional is a real cache; if not, it's a filter.)
import { execFileSync } from 'node:child_process';
import {
  CRATE,
  IMAGE,
  dockerRunArgs,
  resolveLevelDbDir,
  runWithFallback,
  toContainerPath,
} from './native-runner.mjs';

const argv = process.argv.slice(2);
const ddIdx = argv.indexOf('--');
const afterDD = ddIdx >= 0 ? argv.slice(ddIdx + 1) : [];
const positional = (ddIdx >= 0 ? argv.slice(0, ddIdx) : argv).filter((a) => !a.startsWith('-'));
const dataDir = positional[0] ? resolveLevelDbDir(positional[0]) : null;
const filter = [...afterDD, ...(dataDir ? positional.slice(1) : positional)];
const cargoArgs = ['test', '--release', '--lib', ...filter];

function local() {
  const env = { ...process.env };
  if (dataDir) env.ZAUNGAST_TEST_DIR = dataDir;
  execFileSync('cargo', cargoArgs, { cwd: CRATE, stdio: 'inherit', env });
}

function docker() {
  const env = dataDir ? { ZAUNGAST_TEST_DIR: toContainerPath(dataDir) } : {};
  execFileSync('docker', [...dockerRunArgs({ env }), IMAGE, 'bash', '-c', `cargo ${cargoArgs.join(' ')}`], {
    stdio: 'inherit',
  });
}

runWithFallback(local, docker, { label: 'test:native' });
