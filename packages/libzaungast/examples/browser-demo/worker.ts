// POC Web Worker: does all the heavy lifting off the main thread — read the picked files, init the
// @sqlite.org/sqlite-wasm driver, build the store, and run a few facade queries — posting progress as it
// goes so the UI stays responsive. Built to browser-demo/dist/worker.js. Served over http (Workers,
// module loading, and the wasm fetch all require http, not file://).
//
// TWO build modes, chosen by the UI toggle so you can A/B them on the same cache back-to-back:
//   • serial   — openStoreFromSource: decode + fold + extract + build, all on this worker.
//   • parallel — parse the .ldb across a nested Web Worker pool, fold the Snapshot here (byte-identical
//                order → same result), then fan the SSV extract back out across the same pool. Falls back
//                to serial on any pool failure (nested workers unsupported, parse throw, …).
import {
  openStoreFromSource,
  openStoreFromSnapshot,
  loadSnapshotFrom,
  MemorySource,
  type SnapshotSource,
  type TableReadResult,
  type EntityExtract,
} from 'libzaungast/web';
import { createSqliteWasmDriver } from '../sqlite-wasm-driver.ts';
import { createPool, type Pool } from './pool.ts';

type In = { kind: 'selftest' } | { kind: 'build'; files: File[]; parallel: boolean };
type Out =
  | { type: 'progress'; msg: string }
  | { type: 'decoding'; name: string; i: number; n: number }
  | { type: 'phase'; phase: string; ms: number }
  | { type: 'result'; data: unknown }
  | { type: 'error'; msg: string };

const post = (o: Out) => (self as unknown as Worker).postMessage(o);

// One WASM init per worker. locateFile resolves sqlite3.wasm next to worker.js (fetched + streamed).
let driverPromise: ReturnType<typeof createSqliteWasmDriver> | null = null;
const getDriver = () =>
  (driverPromise ??= createSqliteWasmDriver({
    locateFile: (path: string) => new URL(path, import.meta.url).href,
  }));

self.onmessage = async (e: MessageEvent<In>) => {
  try {
    post({ type: 'progress', msg: 'initializing sqlite-wasm…' });
    const driver = await getDriver();

    if (e.data.kind === 'selftest') {
      const store = openStoreFromSource(new MemorySource(new Map()), { driver });
      post({ type: 'result', data: { selfTest: true, meta: store.meta } });
      store.close();
      return;
    }

    const { files, parallel } = e.data;
    post({ type: 'progress', msg: `reading ${files.length} files…` });
    const map = new Map<string, Uint8Array>();
    for (const f of files) map.set(f.name, new Uint8Array(await f.arrayBuffer()));

    // The decoder only reads .ldb/.log; a folder pick also includes leveldb metadata files (CURRENT,
    // MANIFEST-*, LOCK, LOG) that libzaungast never reads — report those so the file counts line up.
    const isData = (n: string) => n.endsWith('.ldb') || n.endsWith('.log');
    const dataFiles = [...map.keys()].filter(isData);
    const otherFiles = [...map.keys()].filter((n) => !isData(n));
    if (otherFiles.length)
      post({
        type: 'progress',
        msg: `${otherFiles.length} leveldb metadata ignored (${otherFiles.join(', ')})`,
      });
    post({ type: 'progress', msg: `${dataFiles.length} data files (.ldb/.log) to decode` });

    // Progress-reporting SnapshotSource (the A5 seam): the decoder calls read() once per .ldb/.log, so
    // reporting there gives live per-file progress with NO library change. In parallel mode the .ldb are
    // parsed by the pool (reported in the parse loop), so read() only fires for the .log WAL here.
    let i = 0;
    const source: SnapshotSource = {
      names: () => [...map.keys()],
      read: (name) => {
        const f = map.get(name);
        if (!f) throw new Error(`no such file: ${name}`);
        if (isData(name)) post({ type: 'decoding', name, i: ++i, n: dataFiles.length });
        return f;
      },
    };
    const onPhase = (phase: string, ms: number) =>
      post({ type: 'phase', phase, ms: Math.round(ms) });

    const ldbNames = [...map.keys()].filter((n) => n.endsWith('.ldb'));
    let pool: Pool | null = null;
    let poolSize = 0;
    if (parallel) {
      const cores = self.navigator?.hardwareConcurrency || 4;
      poolSize = Math.min(cores - 1, 8); // same cap as the wrapped app: beyond ~8, spawn tax > parallelism
      if (poolSize > 1)
        try {
          pool = createPool(
            () => new Worker(new URL('./parse.worker.js', import.meta.url), { type: 'module' }),
            poolSize,
          );
        } catch {
          pool = null;
        }
    }

    const t = performance.now();
    let parseMs = 0;
    let usedPool = false;
    let store;
    try {
      if (pool) {
        try {
          const logCount = dataFiles.length - ldbNames.length; // the .log WAL(s) folded in after
          post({
            type: 'progress',
            msg:
              `parsing ${ldbNames.length} .ldb across ${poolSize} workers` +
              (logCount ? ` (+${logCount} .log WAL folded after)` : '') +
              '…',
          });
          const tParse = performance.now();
          const parsed = new Map<string, TableReadResult>();
          await Promise.all(
            ldbNames.map(async (n) => {
              const res = await pool!.run<TableReadResult>({ kind: 'parse', bytes: map.get(n)! });
              parsed.set(n, res);
              post({ type: 'decoding', name: n, i: ++i, n: dataFiles.length });
            }),
          );
          parseMs = performance.now() - tParse;
          const snap = loadSnapshotFrom(source, { parsedTables: parsed });
          store = await openStoreFromSnapshot(snap, {
            driver,
            onPhase,
            runExtract: (task) =>
              pool!.run<EntityExtract>({
                kind: 'extract',
                records: task.records,
                mapping: task.mapping,
                entity: task.entity,
              }),
          });
          usedPool = true;
        } catch (err) {
          post({
            type: 'progress',
            msg: `pool failed → serial fallback (${(err as Error).message})`,
          });
          pool.destroy();
          pool = null;
          store = openStoreFromSource(source, { driver, onPhase });
        }
      } else {
        store = openStoreFromSource(source, { driver, onPhase });
      }
    } finally {
      pool?.destroy();
    }
    const buildMs = Math.round(performance.now() - t);

    post({
      type: 'result',
      data: {
        mode: usedPool ? 'parallel' : 'serial',
        poolSize: usedPool ? poolSize : 0,
        parseMs: usedPool ? Math.round(parseMs) : null,
        buildMs,
        meta: store.meta,
        conversations: store.conversations.list({ n: 20 }),
        people: store.people.find({ n: 10 }),
        search: store.messages.search({ query: 'the', limit: 5 }),
        topics: store.topics.compute({ window: '30d', n: 8 }),
      },
    });
    store.close();
  } catch (err) {
    post({ type: 'error', msg: (err as Error).message });
  }
};
