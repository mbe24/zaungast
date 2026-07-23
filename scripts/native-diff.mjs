// scripts/native-diff.mjs — ergonomic wrapper over harness/run.mjs. Resolves the leveldb dir (accepts
// the dir itself, a parent that CONTAINS a *.leveldb subdir, or a data date like 2026-07-20 under
// data/) and runs one or more differential layers. Default = the AGENTS minimum (store + incr);
// `--layer <name>` runs one; `--layer all` runs every layer. The shared target-cache volume means only
// the first layer pays the compile. Reports a pass/fail summary and exits nonzero if any layer differs.
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO, resolveLevelDbDir } from './native-runner.mjs';
import { assertDistFresh } from './lib/dist-freshness.mjs';

const ALL_LAYERS = ['sstable', 'snapshot', 'reuse', 'ssv', 'fp', 'extract', 'htmltext', 'store', 'incr'];
const DEFAULT_LAYERS = ['store', 'incr'];

const argv = process.argv.slice(2);
const layerIdx = argv.indexOf('--layer');
const layerArg = layerIdx >= 0 ? argv[layerIdx + 1] : null;
const layers = layerArg === 'all' ? ALL_LAYERS : layerArg ? [layerArg] : DEFAULT_LAYERS;
const dirInput = argv.filter((a) => !a.startsWith('--') && a !== layerArg)[0];
const dir = resolveLevelDbDir(dirInput);
if (!dir) {
  console.error(
    `usage: npm run diff -- <leveldb-dir|parent|data-date> [--layer <name>|all]\n  default layers: ${DEFAULT_LAYERS.join(', ')}  ·  all: ${ALL_LAYERS.join(', ')}`,
  );
  console.error(dirInput ? `could not resolve a leveldb dir from "${dirInput}"` : 'no dir given');
  process.exit(2);
}

// Every layer's TS oracle imports libzaungast's BUILT dist while the native side is rebuilt each run
// (cargo). Guard against comparing fresh-native vs stale-TS — a stale oracle can bless OLD behavior as
// "0 differ". (The harness never loads zaungast, so only libzaungast is checked.)
assertDistFresh([
  {
    label: 'libzaungast',
    srcDir: path.join(REPO, 'packages', 'libzaungast', 'src'),
    distDir: path.join(REPO, 'packages', 'libzaungast', 'dist'),
  },
]);

const runJs = path.join(REPO, 'packages', 'libzaungast-native', 'harness', 'run.mjs');
console.error(`[diff] dir=${dir}  layers=${layers.join(', ')}`);
const failed = [];
for (const layer of layers) {
  console.error(`\n===== diff layer: ${layer} =====`);
  const r = spawnSync(process.execPath, [runJs, dir, '--layer', layer], { stdio: 'inherit' });
  if ((r.status ?? 1) !== 0) failed.push(layer);
}
console.error(
  `\n===== diff: ${layers.length - failed.length}/${layers.length} layers passed${failed.length ? ` — FAILED: ${failed.join(', ')}` : ''} =====`,
);
process.exit(failed.length ? 1 : 0);
