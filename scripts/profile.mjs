// Profiling harness for the zaungast reader/tools. Measures where time + memory go across a cold
// full parse, warm full parses, the format-layer phases, incremental refresh (copy-reuse and
// reparse; no-op AND a real changed delta), and every tool call — plus CPU + heap sampling
// profiles around the full parse (warm), and a separate cold CPU profile.
//
// Run against the BUILT dist (not tsx — avoids esbuild transpile noise in the samples), with GC
// exposed so the phase timers can exclude cross-iteration GC pauses:
//   npm run build
//   node --experimental-sqlite --expose-gc scripts/profile.mjs [<leveldb-dir>] [<iterations>]
//
// Outputs into profiling/<YYYYMMDD-HHMMSS>/ (gitignored): timings.json, full-parse.cpuprofile,
// full-parse.heapprofile, full-parse-cold.cpuprofile. The main session writes profiling.md there.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import inspector from 'node:inspector';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

// Internals (ingest/Session — not on the public exports map post-B3) are reached via relative dist
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
  readMessages,
  search,
  listConversations,
  topTopics,
  findPerson,
  listEvents,
  listCalls,
} from 'zaungast/tools.js';

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
  const coldPeakRssMB = +(process.resourceUsage().maxRSS / 1024).toFixed(1);
  fs.writeFileSync(path.join(coldOut, 'cold-peak-rss.json'), JSON.stringify({ coldPeakRssMB }));
  process.exit(0);
}

const DIR = process.argv[2] ?? 'data/2026-07-15/https_teams.microsoft.com_0.indexeddb.leveldb';
const N = Number(process.argv[3] ?? 10);
if (!fs.existsSync(path.join(DIR, 'CURRENT'))) {
  console.error(`not a leveldb dir (no CURRENT): ${DIR}`);
  process.exit(1);
}

const d = new Date();
const p2 = (n) => String(n).padStart(2, '0');
const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
const outDir = path.join('profiling', stamp);
fs.mkdirSync(outDir, { recursive: true });

// GC before each iteration (outside the timed region) so cross-iteration GC pauses don't land
// inside random samples. Excludes GC from the timed window — slightly optimistic, noted in md.
function bench(label, fn, iters = N) {
  const s = [];
  for (let i = 0; i < iters; i++) {
    if (gc) gc();
    const t = performance.now();
    fn();
    s.push(performance.now() - t);
  }
  s.sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  const at = (q) => s[Math.min(s.length - 1, Math.floor(iters * q))];
  return {
    label,
    iters,
    min: +s[0].toFixed(3),
    median: +at(0.5).toFixed(3),
    mean: +(sum / iters).toFixed(3),
    p95: +at(0.95).toFixed(3),
    max: +s[iters - 1].toFixed(3),
  };
}

const results = { meta: {}, fullParse: {}, formatPhases: [], incremental: [], tools: [] };
const parsedBytes = fs
  .readdirSync(DIR)
  .filter((f) => /\.(ldb|log)$/i.test(f)) // only what ingest actually reads
  .reduce((s, f) => s + fs.statSync(path.join(DIR, f)).size, 0);
results.meta = {
  when: d.toISOString(),
  dir: DIR,
  parsedBytes,
  iterations: N,
  gcPinned: !!gc,
  node: process.version,
  platform: `${os.platform()} ${os.release()}`,
  cpu: os.cpus()[0]?.model,
};

// ---- 1. full parse: cold (1×) then warm (N×) ----
// Peak-RSS during this in-process cold parse is deliberately NOT sampled here: a setInterval sampler
// can't fire while the synchronous ingest blocks the event loop. The true peak is captured OS-side
// (process.resourceUsage().maxRSS) in the fresh --cold child below → results.fullParse.coldPeakRssMB.
let tc = performance.now();
{
  const r = ingest(DIR);
  results.meta.counts = r.meta.counts;
  results.meta.lossy = r.meta.lossy;
  results.fullParse.rssWithStoreMB = +(process.memoryUsage().rss / 1048576).toFixed(1); // store resident
  r.store.close();
}
results.fullParse.coldMs = +(performance.now() - tc).toFixed(3);
results.fullParse.warm = bench('ingest (warm)', () => {
  const r = ingest(DIR);
  r.store.close();
});
// retained JS heap after one parse (small — the store is native SQLite memory, not JS heap)
if (gc) {
  gc();
  const h0 = process.memoryUsage().heapUsed;
  const r = ingest(DIR);
  gc();
  results.fullParse.retainedHeapMB = +((process.memoryUsage().heapUsed - h0) / 1048576).toFixed(1);
  r.store.close();
}

// ---- 2. format-layer phase breakdown (the API-reshape target) ----
// Post-refactor: loadSnapshot replaces loadEntries (it decodes AND groups by store once);
// fingerprint/entityTargets/extractEntity now take the Snapshot; selectMapping defaults to the
// bundled mappings; extractEntity returns an EntityExtract envelope (the bench times the call).
const snap0 = loadSnapshot(DIR);
const fp0 = fingerprint(snap0);
const { mapping } = selectMapping(fp0);
results.meta.liveEntries = snap0.uniqueCount;
results.meta.throughput = {
  entriesPerSec: Math.round(snap0.uniqueCount / (results.fullParse.warm.median / 1000)),
  mbPerSec: +(parsedBytes / 1048576 / (results.fullParse.warm.median / 1000)).toFixed(1),
};
// precompute targets exactly as ingest does for message/conversation (passed in → no re-scan);
// event/call/profile are extracted WITHOUT precomputed targets in production (applyEvents/…), so
// bench them the same way. entityTargets is now an O(#stores) catalog lookup (post-Snapshot), not a scan.
const msgTargets = entityTargets(snap0, mapping, 'message');
const convTargets = entityTargets(snap0, mapping, 'conversation');
results.formatPhases.push(bench('loadSnapshot (read+decode+group)', () => loadSnapshot(DIR)));
results.formatPhases.push(bench('fingerprint', () => fingerprint(snap0)));
results.formatPhases.push(bench('entityTargets (catalog lookup)', () => entityTargets(snap0, mapping, 'message')));
results.formatPhases.push(bench('extractEntity(message) [targets passed]', () => extractEntity(snap0, mapping, 'message', msgTargets)));
results.formatPhases.push(bench('extractEntity(conversation) [targets passed]', () => extractEntity(snap0, mapping, 'conversation', convTargets)));
for (const ent of ['event', 'call', 'profile']) {
  results.formatPhases.push(bench(`extractEntity(${ent}) [targets recomputed, as prod]`, () => extractEntity(snap0, mapping, ent)));
}

// ---- 3. incremental refresh ----
// (a) no-op refresh floor, per mode. Warm one refresh first so the copy-reuse ldbCache is populated
//     (iteration 1 is cold-cache and would skew the distribution).
for (const mode of ['copy-reuse', 'reparse']) {
  const s = new Session({ overrideDir: DIR, incrementalMode: mode, minDebounceMs: 0, maxIncrementals: 1_000_000 });
  const t = performance.now();
  s.refreshNow(true);
  const fullMs = +(performance.now() - t).toFixed(3);
  s.refreshNow(false); // warm the cache (copy-reuse)
  const inc = bench(`incremental no-op (${mode})`, () => s.refreshNow(false), 20);
  s.dispose();
  results.incremental.push({ mode, kind: 'no-op', fullMs, ...inc });
}
// (b) a REAL changed delta (reparse path): build a store as-of an earlier sequence, then apply the
//     remaining real records. Single-shot (applyIncremental mutates the store). No live data touched.
{
  const seqs = [...snap0.buckets.values()]
    .flatMap((b) => b.records.map((r) => r.seq))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const cap = seqs[Math.floor(seqs.length * 0.99)]; // leaves the top ~1% of records to apply
  const part = ingest(DIR, { seqCap: cap });
  const before = part.store.counts().messages;
  const t = performance.now();
  applyIncremental(part.store, part.state, DIR);
  const changedMs = +(performance.now() - t).toFixed(3);
  const appliedMsgs = part.store.counts().messages - before;
  part.store.close();
  results.incremental.push({ mode: 'reparse', kind: 'changed', appliedMsgs, changedMs, iters: 1 });
}

// ---- 4. tool calls (through the public facade — tools now take (view, args); openStore's static
//         TeamsStore is a valid view). Pick the busiest channel + a flat conv via the facade. ----
{
  const store = openStore(DIR);
  const convs = store.conversations.list({ n: 500 });
  const busiest = (kind) =>
    convs.filter((c) => c.kind === kind).sort((a, b) => b.msgCount - a.msgCount)[0]?.handle;
  const flat = busiest('1:1') ?? busiest('group');
  const chan = busiest('channel');
  const T = 100;
  if (flat) results.tools.push(bench('read_messages (flat)', () => readMessages(store, { conversation: flat, limit: 40 }), T));
  if (chan) results.tools.push(bench('read_messages (channel digest)', () => readMessages(store, { conversation: chan, limit: 40 }), T));
  results.tools.push(bench('search "the"', () => search(store, { query: 'the', limit: 20 }), T));
  results.tools.push(bench('top_topics 30d', () => topTopics(store, { window: '30d' }), 50));
  results.tools.push(bench('list_conversations', () => listConversations(store, {}), T));
  results.tools.push(bench('find_person (roster)', () => findPerson(store, {}), T));
  results.tools.push(bench('list_events', () => listEvents(store, { since: '2020-01-01', until: '2030-01-01', limit: 30 }), T));
  results.tools.push(bench('list_calls', () => listCalls(store, { limit: 30 }), T));
  store.close();
}

// ---- 5. warm CPU + heap sampling profiles around a full-parse block ----
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
// cold CPU profile + OS-tracked peak RSS in a fresh process (profiler must precede the first-ever ingest)
spawnSync(process.execPath, ['--experimental-sqlite', '--expose-gc', 'scripts/profile.mjs', '--cold', DIR, outDir], { stdio: 'inherit' });
try {
  const { coldPeakRssMB } = JSON.parse(fs.readFileSync(path.join(outDir, 'cold-peak-rss.json'), 'utf8'));
  results.fullParse.coldPeakRssMB = coldPeakRssMB;
} catch {
  /* cold child didn't emit peak — leave undefined */
}

// ---- write timings + console summary ----
fs.writeFileSync(path.join(outDir, 'timings.json'), JSON.stringify(results, null, 2));
const row = (r) => `  ${r.label.padEnd(46)} median ${String(r.median).padStart(9)}ms  p95 ${String(r.p95).padStart(9)}ms`;
console.log(`\n=== profile → ${outDir} ===`);
console.log(`data: ${DIR}`);
console.log(`  ${results.meta.liveEntries} entries · ${(parsedBytes / 1048576).toFixed(1)} MB parsed · counts ${JSON.stringify(results.meta.counts)} · gcPinned ${!!gc}`);
console.log(`\nfull parse: cold ${results.fullParse.coldMs}ms · warm median ${results.fullParse.warm.median}ms · cold peak RSS ${results.fullParse.coldPeakRssMB ?? '—'}MB · RSS w/store ${results.fullParse.rssWithStoreMB}MB`);
console.log(`throughput: ${results.meta.throughput.entriesPerSec} entries/s · ${results.meta.throughput.mbPerSec} MB/s`);
console.log('\nformat phases:');
results.formatPhases.forEach((r) => console.log(row(r)));
console.log('\nincremental:');
results.incremental.forEach((r) =>
  r.kind === 'no-op'
    ? console.log(`  no-op (${r.mode}): full ${r.fullMs}ms · refresh median ${r.median}ms p95 ${r.p95}ms`)
    : console.log(`  changed (${r.mode}): applied ${r.appliedMsgs} msgs in ${r.changedMs}ms`),
);
console.log('\ntools:');
results.tools.forEach((r) => console.log(row(r)));
console.log(`\nartifacts in ${outDir}: timings.json · full-parse{,-cold}.cpuprofile · full-parse.heapprofile`);
