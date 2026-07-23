// Profiling harness for the zaungast reader/tools. Measures where time + memory go across a cold
// full parse, warm full parses, the format-layer phases, the store-build phases, incremental refresh
// (copy-reuse and reparse; no-op AND a real changed delta), and every tool call — plus CPU + heap
// sampling profiles around the full parse (warm), and a separate cold CPU profile.
//
// Emits the v1 timings schema (scripts/lib/timings-v1.mjs) so the output lines up with the native
// profiler (src/bin/profile.rs) and can be diffed by the compare tool. Shared metrics use canonical
// names (format.*, storeBuild.*, fullParse.*, throughput.*, refresh.noop.*, memory.*); TS-only things
// (MCP tools, the end-to-end changed delta, heap/cpu artifacts) go in engineExtra.
//
// Run against the BUILT dist (not tsx — avoids esbuild transpile noise in the samples), with GC
// exposed so the phase timers can exclude cross-iteration GC pauses:
//   npm run build
//   node --experimental-sqlite --expose-gc scripts/profile.mjs [<leveldb-dir>] [<iterations>]
//
// Two modes (the percentile spread p50/75/90/95/99 + stddev is emitted in BOTH):
//   LIGHT (default) — N=10 · tools 100 · top_topics 50 · incremental 20. A quick standard run.
//   HEAVY (opt-in)  — N=100 · tools 500 · top_topics 200 · incremental 40. A deep, tight-stddev
//                     re-profile (~20-30 min). Enable with the `--heavy` flag OR PROFILE_HEAVY=1.
//     node --experimental-sqlite --expose-gc scripts/profile.mjs <dir> --heavy
// An explicit <iterations> arg overrides the mode's default N (the tool/topic/incremental iteration
// counts still follow the mode).
//
// Outputs into profiling/<YYYYMMDD-HHMMSS>/ (gitignored): timings.json (v1), full-parse.cpuprofile,
// full-parse.heapprofile, full-parse-cold.cpuprofile. The main session writes profiling.md there.

import fs from 'node:fs';
import path from 'node:path';
import inspector from 'node:inspector';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

// Internals (ingest/Session — not on the public exports map) are reached via relative dist
// paths: the same "in-repo tooling reaches its own internals directly" pattern the tests use. The
// public data + format API comes through the narrow package entry points.
import { ingest, applyIncremental } from '../packages/libzaungast/dist/ingest/ingest.js';
import { Session } from '../packages/libzaungast/dist/session.js';
import {
  loadSnapshot,
  fingerprint,
  selectMapping,
  extractEntity,
  entityTargets,
} from 'libzaungast/format';
import { openStore } from 'libzaungast';
import {
  readConversation,
  search,
  listConversations,
  rankTopics,
  findPerson,
  listEvents,
  listCalls,
} from 'zaungast/tools.js';
import { metric, scalar, envelope } from './lib/timings-v1.mjs';
import { assertDistFresh, distBuiltAt } from './lib/dist-freshness.mjs';

// Every package this profiler loads from its BUILT dist (see header). Both dirs are repo-root-relative,
// matching the cwd `npm run profile` runs in and the other paths in this file.
const DIST_PACKAGES = [
  {
    label: 'libzaungast',
    srcDir: 'packages/libzaungast/src',
    distDir: 'packages/libzaungast/dist',
  },
  { label: 'zaungast', srcDir: 'packages/zaungast/src', distDir: 'packages/zaungast/dist' },
];

const gc = typeof global.gc === 'function' ? global.gc : null;

function connect() {
  const s = new inspector.Session();
  s.connect();
  const post = (m, p) => new Promise((res, rej) => s.post(m, p, (e, r) => (e ? rej(e) : res(r))));
  return { s, post };
}
async function cpuProfile(dir, iters, file) {
  const { s, post } = connect();
  await post('Profiler.enable');
  await post('Profiler.setSamplingInterval', { interval: 100 }); // µs (before start)
  await post('Profiler.start');
  for (let i = 0; i < iters; i++) {
    const r = ingest(dir);
    r.store.close();
  }
  const { profile } = await post('Profiler.stop');
  fs.writeFileSync(file, JSON.stringify(profile));
  s.disconnect();
}

// ---- --cold: fresh process, profiler started BEFORE the very first ingest (JIT/first-touch cost) ----
if (process.argv[2] === '--cold') {
  const coldOut = process.argv[4];
  await cpuProfile(process.argv[3], 1, path.join(coldOut, 'full-parse-cold.cpuprofile'));
  // Peak RSS of this fresh single-ingest process, straight from the OS high-water mark (maxRSS, in
  // KB). No sampler: getrusage/GetProcessMemoryInfo record the peak even while the synchronous
  // ingest blocks the event loop — which a setInterval sampler cannot. The parent folds this in.
  // TS ingests into an in-memory store (:memory:), so this OS peak IS the in-memory store peak.
  const coldPeakRssMB = process.resourceUsage().maxRSS / 1024; // raw MB (no writer rounding — v1)
  fs.writeFileSync(path.join(coldOut, 'cold-peak-rss.json'), JSON.stringify({ coldPeakRssMB }));
  process.exit(0);
}

// Fail fast if the built dist is older than its src — otherwise this run silently profiles OLD code
// (the imports above already loaded dist, but the expensive work is still ahead). Only the parent
// reaches here; the --cold child exits above, so it inherits the parent's already-verified dist.
assertDistFresh(DIST_PACKAGES);

// HEAVY vs LIGHT (see header): heavy is opt-in via `--heavy` or PROFILE_HEAVY=1; light is the
// standard default. Only the iteration COUNTS differ — the metrics/percentiles are identical.
const HEAVY = process.argv.includes('--heavy') || process.env.PROFILE_HEAVY === '1';
const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const DIR = positional[0] ?? 'data/2026-07-15/https_teams.microsoft.com_0.indexeddb.leveldb';
const N = Number(positional[1] ?? (HEAVY ? 100 : 10));
const TOOL_ITERS = HEAVY ? 500 : 100; // per-tool bench iterations
const TOPIC_ITERS = HEAVY ? 200 : 50; // top_topics (heavier per call)
const INC_ITERS = HEAVY ? 40 : 20; // incremental no-op refresh
if (!fs.existsSync(path.join(DIR, 'CURRENT'))) {
  console.error(`not a leveldb dir (no CURRENT): ${DIR}`);
  process.exit(1);
}

const d = new Date();
const p2 = (n) => String(n).padStart(2, '0');
const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
const outDir = path.join('profiling', stamp);
fs.mkdirSync(outDir, { recursive: true });

// Time `fn` `iters` times (GC'd before each, OUTSIDE the timed window so cross-iteration GC pauses
// don't land inside samples — slightly optimistic, noted in the md) → a RAW v1 metric (unit ms).
function bench(fn, iters = N) {
  const s = [];
  for (let i = 0; i < iters; i++) {
    if (gc) gc();
    const t = performance.now();
    fn();
    s.push(performance.now() - t);
  }
  return metric('ms', s);
}

const parsedBytes = fs
  .readdirSync(DIR)
  .filter((f) => /\.(ldb|log)$/i.test(f)) // only what ingest actually reads
  .reduce((s, f) => s + fs.statSync(path.join(DIR, f)).size, 0);

const metrics = {}; // canonical, cross-engine-comparable
const extra = {}; // engineExtra — TS-only, not in the parity table
let counts, lossy, liveEntries;

// ---- 1. full parse (IN-MEMORY): cold 1× then warm N×. TS's ChatStore is :memory: (ingest/store.ts),
// so these ARE the in-memory fullParse the schema wants — there is no disk write to strip (native's
// production path writes a .db file, which it must bench separately as its in-memory build). ----
const tc = performance.now();
{
  const r = ingest(DIR);
  counts = r.meta.counts;
  lossy = r.meta.lossy;
  extra['memory.rssWithStore'] = scalar('MB', process.memoryUsage().rss / 1048576); // store resident
  r.store.close();
}
metrics['fullParse.cold'] = scalar('ms', performance.now() - tc);
metrics['fullParse.warm'] = bench(() => {
  const r = ingest(DIR);
  r.store.close();
});
if (gc) {
  gc();
  const h0 = process.memoryUsage().heapUsed;
  const r = ingest(DIR);
  gc();
  extra['memory.retainedHeap'] = scalar('MB', (process.memoryUsage().heapUsed - h0) / 1048576);
  r.store.close();
}

// ---- 2. format-layer phases (shared 1:1 with native format.*). loadSnapshot decodes AND groups by
// store once; fingerprint/entityTargets/extractEntity take the Snapshot. entityTargets for
// message/conversation are precomputed (as ingest does); event/call/profile recompute (as prod). ----
const snap0 = loadSnapshot(DIR);
const fp0 = fingerprint(snap0);
const { mapping } = selectMapping(fp0);
liveEntries = snap0.uniqueCount;
const warmP50 = metrics['fullParse.warm'].p50;
metrics['throughput.entries'] = scalar('perSec', liveEntries / (warmP50 / 1000));
metrics['throughput.bytes'] = scalar('MBperSec', parsedBytes / 1048576 / (warmP50 / 1000));
const msgTargets = entityTargets(snap0, mapping, 'message');
const convTargets = entityTargets(snap0, mapping, 'conversation');
metrics['format.loadSnapshot'] = bench(() => loadSnapshot(DIR));
metrics['format.fingerprint'] = bench(() => fingerprint(snap0));
metrics['format.entityTargets'] = bench(() => entityTargets(snap0, mapping, 'message'));
metrics['format.extract.message'] = bench(() =>
  extractEntity(snap0, mapping, 'message', msgTargets),
);
metrics['format.extract.conversation'] = bench(() =>
  extractEntity(snap0, mapping, 'conversation', convTargets),
);
for (const ent of ['event', 'call', 'profile']) {
  metrics[`format.extract.${ent}`] = bench(() => extractEntity(snap0, mapping, ent));
}

// ---- 2b. store-build phases (shared with native PhaseTimings). ingest() fires an opt-in onPhase hook
// per phase (dev only; a no-op in production), so this measures the REAL build pipeline. Two structural
// differences keep apply/fts from being commit-for-commit comparable to the native engine: TS shapes
// the profile/event/call rows during `extract` (to drop the snapshot before building) whereas native
// shapes them during `apply`; and native wraps apply+recompute+fts in ONE transaction (COMMIT inside
// `fts`) whereas TS commits after `apply` and autocommits recompute/fts. ----
{
  const s = { extract: [], apply: [], recompute: [], fts: [] };
  for (let i = 0; i < N; i++) {
    if (gc) gc();
    const r = ingest(DIR, { onPhase: (phase, x) => s[phase].push(x) });
    r.store.close();
  }
  for (const p of ['extract', 'apply', 'recompute', 'fts'])
    metrics[`storeBuild.${p}`] = metric('ms', s[p]);
}

// ---- 3. incremental refresh. The no-op floor per mode is shared (refresh.noop.<mode>); the changed
// delta is end-to-end n=1 (applyIncremental mutates the store, so it can't be looped) → engineExtra. ----
const NOOP_KEY = { 'copy-reuse': 'copyReuse', reparse: 'reparse' };
for (const mode of ['copy-reuse', 'reparse']) {
  const sess = new Session({
    overrideDir: DIR,
    incrementalMode: mode,
    minDebounceMs: 0,
    maxIncrementals: 1_000_000,
  });
  sess.refreshNow(true);
  sess.refreshNow(false); // warm the copy-reuse ldbCache (iteration 1 is cold-cache; would skew)
  const s = [];
  for (let i = 0; i < INC_ITERS; i++) {
    if (gc) gc();
    const t = performance.now();
    sess.refreshNow(false);
    s.push(performance.now() - t);
  }
  sess.dispose();
  metrics[`refresh.noop.${NOOP_KEY[mode]}`] = metric('ms', s);
}
{
  // Build a store as-of an earlier sequence, then apply the remaining real records (reparse path).
  const seqs = [...snap0.buckets.values()]
    .flatMap((b) => b.records.map((r) => r.seq))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const cap = seqs[Math.floor(seqs.length * 0.99)]; // leaves the top ~1% of records to apply
  const part = ingest(DIR, { seqCap: cap });
  const before = part.store.counts().messages;
  const t = performance.now();
  applyIncremental(part.store, part.state, DIR);
  const changedMs = performance.now() - t;
  extra['refresh.changed.reparse'] = {
    ...scalar('ms', changedMs),
    appliedMsgs: part.store.counts().messages - before,
  };
  part.store.close();
}

// ---- 4. tool calls (engineExtra — native has no MCP layer). Through the public facade; pick the
// busiest channel + a flat conv via openStore's static view. ----
{
  const store = openStore(DIR);
  const convs = store.conversations.list({ n: 500 });
  const busiest = (kind) =>
    convs.filter((c) => c.kind === kind).sort((a, b) => b.msgCount - a.msgCount)[0]?.handle;
  const flat = busiest('1:1') ?? busiest('group');
  const chan = busiest('channel');
  const tool = (name, fn, iters = TOOL_ITERS) => {
    extra[`tool.${name}`] = bench(fn, iters);
  };
  if (flat)
    tool('read_messages_flat', () => readConversation(store, { conversation: flat, limit: 40 }));
  if (chan)
    tool('read_messages_channel', () => readConversation(store, { conversation: chan, limit: 40 }));
  tool('search', () => search(store, { query: 'the', limit: 20 }));
  tool('top_topics', () => rankTopics(store, { window: '30d' }), TOPIC_ITERS);
  tool('list_conversations', () => listConversations(store, {}));
  tool('find_person', () => findPerson(store, {}));
  tool('list_events', () =>
    listEvents(store, { since: '2020-01-01', until: '2030-01-01', limit: 30 }),
  );
  tool('list_calls', () => listCalls(store, { limit: 30 }));
  store.close();
}

// ---- 5. warm CPU + heap sampling profiles around a full-parse block, then a cold CPU profile + OS
// peak RSS in a fresh child (the profiler must precede the first-ever ingest). ----
const PROF_ITERS = Math.max(N, 10);
await cpuProfile(DIR, PROF_ITERS, path.join(outDir, 'full-parse.cpuprofile'));
{
  const { s, post } = connect();
  await post('HeapProfiler.enable');
  await post('HeapProfiler.startSampling', { samplingInterval: 4096 });
  for (let i = 0; i < PROF_ITERS; i++) {
    const r = ingest(DIR);
    r.store.close();
  }
  const { profile } = await post('HeapProfiler.stopSampling');
  fs.writeFileSync(path.join(outDir, 'full-parse.heapprofile'), JSON.stringify(profile));
  s.disconnect();
}
spawnSync(
  process.execPath,
  ['--experimental-sqlite', '--expose-gc', 'scripts/profile.mjs', '--cold', DIR, outDir],
  { stdio: 'inherit' },
);
try {
  const { coldPeakRssMB } = JSON.parse(
    fs.readFileSync(path.join(outDir, 'cold-peak-rss.json'), 'utf8'),
  );
  // TS's cold child ingests into :memory:, so its OS peak IS the in-memory store peak (shared metric).
  metrics['memory.storePeakRss'] = scalar('MB', coldPeakRssMB);
} catch {
  /* cold child didn't emit peak — leave the metric absent */
}
extra['artifacts'] = {
  cpuProfile: 'full-parse.cpuprofile',
  coldCpuProfile: 'full-parse-cold.cpuprofile',
  heapProfile: 'full-parse.heapprofile',
};

// ---- write the v1 envelope + a human console summary (console rounds; the JSON stays raw) ----
const env = envelope({
  engine: 'ts',
  dataset: {
    dir: DIR,
    entries: liveEntries,
    bytes: parsedBytes,
    counts,
    fingerprint: fp0.hash,
    lossy,
    gcPinned: !!gc,
  },
  mode: HEAVY ? 'heavy' : 'light',
  iters: { full: N, tools: TOOL_ITERS, topics: TOPIC_ITERS, incremental: INC_ITERS },
  metrics,
  engineExtra: extra,
  distBuiltAt: distBuiltAt(DIST_PACKAGES.map((p) => p.distDir)),
});
fs.writeFileSync(path.join(outDir, 'timings.json'), JSON.stringify(env, null, 2));

const r3 = (x) => (x == null ? '—' : +x.toFixed(3));
const val = (m) =>
  m == null
    ? '—'
    : m.n === 1
      ? `${r3(m.value)} ${m.unit}`
      : `p50 ${String(r3(m.p50)).padStart(9)}  p90 ${String(r3(m.p90)).padStart(9)}  p99 ${String(r3(m.p99)).padStart(9)}  ±${r3(m.stddev)} ${m.unit}`;
const show = (title, keys, from = metrics) => {
  console.log(`\n${title}:`);
  for (const k of keys) if (from[k] != null) console.log(`  ${k.padEnd(26)} ${val(from[k])}`);
};

console.log(`\n=== profile (ts) → ${outDir} ===`);
console.log(`data: ${DIR}`);
console.log(
  `  ${liveEntries} entries · ${(parsedBytes / 1048576).toFixed(1)} MB · counts ${JSON.stringify(counts)} · gcPinned ${!!gc} · fp ${fp0.hash}`,
);
console.log(
  `  mode: ${env.mode} (full N=${N} · tools ${TOOL_ITERS} · topics ${TOPIC_ITERS} · incremental ${INC_ITERS})`,
);
show('full parse (in-memory)', [
  'fullParse.cold',
  'fullParse.warm',
  'memory.storePeakRss',
  'throughput.entries',
  'throughput.bytes',
]);
show('format phases', [
  'format.loadSnapshot',
  'format.fingerprint',
  'format.entityTargets',
  'format.extract.message',
  'format.extract.conversation',
  'format.extract.event',
  'format.extract.call',
  'format.extract.profile',
]);
show('store-build phases (~= native PhaseTimings; apply/fts not commit-for-commit comparable)', [
  'storeBuild.extract',
  'storeBuild.apply',
  'storeBuild.recompute',
  'storeBuild.fts',
]);
show('incremental (no-op floor)', ['refresh.noop.copyReuse', 'refresh.noop.reparse']);
show(
  'engineExtra (TS-only)',
  Object.keys(extra).filter(
    (k) => k.startsWith('tool.') || k.startsWith('refresh.') || k.startsWith('memory.'),
  ),
  extra,
);
console.log(
  `\nartifacts in ${outDir}: timings.json (v1) · full-parse{,-cold}.cpuprofile · full-parse.heapprofile`,
);
