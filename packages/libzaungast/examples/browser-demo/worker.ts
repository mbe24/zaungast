// POC Web Worker: does all the heavy lifting off the main thread — read the picked files, init the
// @sqlite.org/sqlite-wasm driver, build the store, and run a few facade queries — posting progress as it
// goes so the UI stays responsive. Built to browser-demo/dist/worker.js. Served over http (Workers,
// module loading, and the wasm fetch all require http, not file://).
//
// The whole parallel cold-read path (parse across a pool → fold → extract across the pool → serial
// fallback) now lives in libzaungast/web's `openStoreFromSourceParallel`; this file just spawns a pool
// (the UI threads stepper sizes it) and hands it in. Serial mode passes `pool: null`.
import {
  openStoreFromSource,
  openStoreFromSourceParallel,
  createPool,
  MemorySource,
  type SnapshotSource,
  type Pool,
} from 'libzaungast/web';
import { createSqliteWasmDriver } from 'libzaungast/web/sqlite-wasm-driver';

type In =
  | { kind: 'selftest' }
  | { kind: 'prewarm'; parallel: boolean; threads: number }
  | { kind: 'build'; files: File[]; parallel: boolean; threads: number };
type Out =
  | { type: 'progress'; msg: string }
  | { type: 'decoding'; name: string; i: number; n: number }
  | { type: 'phase'; phase: string; ms: number; note?: string }
  | { type: 'result'; data: unknown }
  | { type: 'error'; msg: string };

const post = (o: Out) => (self as unknown as Worker).postMessage(o);

// One WASM init per worker. locateFile resolves sqlite3.wasm next to worker.js (fetched + streamed).
let driverPromise: ReturnType<typeof createSqliteWasmDriver> | null = null;
const getDriver = () =>
  (driverPromise ??= createSqliteWasmDriver({
    locateFile: (path: string) => new URL(path, import.meta.url).href,
  }));

// Pool spawn at a caller-chosen size (the UI threads stepper) over the library's createPool; the workers
// run libzaungast/web's handlePoolMessage (see parse.worker.ts). Hoisted so a 'prewarm' message can spawn
// it during the file picker and the build after reuses it. Sanity-clamped so a bogus message can't spawn
// a runaway pool.
function spawnPool(size: number): Pool | null {
  const n = Math.min(Math.max(size, 2), 16);
  if (n <= 1) return null;
  try {
    return createPool(
      () => new Worker(new URL('./parse.worker.js', import.meta.url), { type: 'module' }),
      n,
    );
  } catch {
    return null;
  }
}
let warmPool: Pool | null = null; // populated by a 'prewarm' message, consumed by the next parallel build

// Ensure warmPool holds a pool of exactly `threads` workers (respawn if the stepper moved).
function warmTo(threads: number) {
  if (warmPool && warmPool.size !== threads) {
    warmPool.destroy();
    warmPool = null;
  }
  warmPool ??= spawnPool(threads);
}

self.onmessage = async (e: MessageEvent<In>) => {
  try {
    // Prewarm during the picker: init the wasm driver, and (if the toggle is on) spawn the pool — so the
    // build after the pick pays neither wasm-init nor pool-spawn. Fire-and-forget from main.ts.
    if (e.data.kind === 'prewarm') {
      const t = performance.now();
      await getDriver();
      if (e.data.parallel) warmTo(e.data.threads);
      console.log('[poc prewarm ms]', {
        driverInit: Math.round(performance.now() - t),
        pool: warmPool ? warmPool.size : 0,
      });
      return;
    }
    post({ type: 'progress', msg: 'initializing sqlite-wasm…' });
    const tDriver = performance.now();
    const driver = await getDriver();
    const driverWaitMs = performance.now() - tDriver; // ~0 when prewarm already inited it

    if (e.data.kind === 'selftest') {
      const store = openStoreFromSource(new MemorySource(new Map()), { driver });
      post({ type: 'result', data: { selfTest: true, meta: store.meta } });
      store.close();
      return;
    }

    const { files, parallel, threads } = e.data;
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

    // Progress-reporting SnapshotSource: openStoreFromSourceParallel reads each .ldb once (to dispatch
    // it to the pool) and the .log during the fold, so read() gives live per-file progress with no extra
    // wiring. In serial mode the whole decode flows through read() too.
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

    // Pick the pool: reuse the prewarmed one (respawn to the stepper size if needed); null in serial mode.
    let pool: Pool | null = null;
    let prewarmed = false;
    if (parallel) {
      warmTo(threads);
      prewarmed = warmPool !== null;
      pool = warmPool;
      warmPool = null; // openStoreFromSourceParallel consumes + destroys it
    } else if (warmPool) {
      warmPool.destroy(); // speculatively prewarmed, but this build is serial — free the idle workers
      warmPool = null;
    }

    const t = performance.now();
    const { store, usedPool, poolSize, parseMs } = await openStoreFromSourceParallel(source, {
      driver,
      pool,
      onPhase,
    });
    // Report the parallel decode as a phase line aligned with serial's `✓ decode`, noting the pool.
    // (Serial reports its own 'decode' phase via onPhase.)
    if (usedPool)
      post({
        type: 'phase',
        phase: 'decode',
        ms: Math.round(parseMs),
        note: `(using ${poolSize} workers)`,
      });
    const buildMs = Math.round(performance.now() - t);

    post({
      type: 'result',
      data: {
        mode: usedPool ? 'parallel' : 'serial',
        poolSize: usedPool ? poolSize : 0,
        parseMs: usedPool ? Math.round(parseMs) : null,
        prewarmed,
        driverWait: Math.round(driverWaitMs),
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
