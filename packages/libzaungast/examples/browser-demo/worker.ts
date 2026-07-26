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
  extractFromSourceParallel,
  shapeBaseTables,
  createPool,
  MemorySource,
  type SnapshotSource,
  type Pool,
  type StoreMeta,
} from 'libzaungast/web';
import { createSqliteWasmDriver } from 'libzaungast/web/sqlite-wasm-driver';
import { buildDuckDbStore, type DuckDbStore } from './duckdb-store.ts';
import { createDuckDb } from './duckdb-wasm-driver.ts';

type Engine = 'sqlite' | 'duckdb';
type In =
  | { kind: 'selftest'; engine: Engine }
  | { kind: 'prewarm'; parallel: boolean; threads: number; engine: Engine }
  | { kind: 'build'; files: File[]; parallel: boolean; threads: number; engine: Engine };
type Out =
  | { type: 'progress'; msg: string }
  | { type: 'decoding'; name: string; i: number; n: number }
  | { type: 'phase'; phase: string; ms: number | null; note?: string } // ms null → rendered as an en dash (N/A)
  | { type: 'result'; data: unknown }
  | { type: 'error'; msg: string };

const post = (o: Out) => (self as unknown as Worker).postMessage(o);

// One WASM init per worker. locateFile resolves sqlite3.wasm next to worker.js (fetched + streamed).
let driverPromise: ReturnType<typeof createSqliteWasmDriver> | null = null;
const getDriver = () =>
  (driverPromise ??= createSqliteWasmDriver({
    locateFile: (path: string) => new URL(path, import.meta.url).href,
  }));

// One DuckDB connection per worker (the engine picker's second backend). Warmed during the picker (its
// wasm init is the slow part) so the 'duckdb-load' phase measures just the table copy. Reused across
// builds — buildDuckDbStore uses CREATE OR REPLACE, so re-running is safe.
let duckPromise: ReturnType<typeof createDuckDb> | null = null;
const getDuck = () => (duckPromise ??= createDuckDb());

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
      if (e.data.engine === 'duckdb') await getDuck(); // warm DuckDB's wasm during the picker too
      console.log('[poc prewarm ms]', {
        driverInit: Math.round(performance.now() - t),
        pool: warmPool ? warmPool.size : 0,
        duck: duckPromise ? 'warm' : 'cold',
      });
      return;
    }
    const engine = e.data.engine;

    // Self-test: build an empty SQLite store (verifies the wasm driver + facade), and — in DuckDB mode —
    // also init DuckDB + a trivial round-trip. Both engines init here since it's a wasm-engine check.
    if (e.data.kind === 'selftest') {
      post({
        type: 'progress',
        msg: `initializing ${engine === 'duckdb' ? 'sqlite-wasm + duckdb-wasm' : 'sqlite-wasm'}…`,
      });
      const driver = await getDriver();
      const store = openStoreFromSource(new MemorySource(new Map()), { driver });
      let duckOk: boolean | null = null;
      if (engine === 'duckdb') {
        const conn = await getDuck();
        duckOk = (await conn.query<{ x: number | bigint }>('select 42 as x')).length === 1;
      }
      post({ type: 'result', data: { selfTest: true, engine, duckOk, meta: store.meta } });
      store.close();
      return;
    }

    // Build: SQLite needs its wasm driver; DuckDB builds INDEPENDENTLY (no SQLite) → only duckdb-wasm inits.
    post({
      type: 'progress',
      msg: `initializing ${engine === 'duckdb' ? 'duckdb-wasm' : 'sqlite-wasm'}…`,
    });
    let driver: Awaited<ReturnType<typeof getDriver>> | null = null;
    let driverWaitMs = 0;
    if (engine === 'sqlite') {
      const tDriver = performance.now();
      driver = await getDriver();
      driverWaitMs = performance.now() - tDriver; // ~0 when prewarm already inited it
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
    let usedPool = false;
    let poolSize = 0;
    let parseMs = 0;
    let meta: StoreMeta;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let duck: DuckDbStore | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let sqlite: Awaited<ReturnType<typeof openStoreFromSourceParallel>>['store'] | null = null;

    if (engine === 'duckdb') {
      // Independent DuckDB build: the SHARED decode/fold/extract (extractFromSourceParallel) → shaped base
      // tables → DuckDB materialize with its OWN apply/recompute (deriveTables in JS). No SQLite involved.
      const res = await extractFromSourceParallel(source, { pool, onPhase }); // emits 'extract'
      usedPool = res.usedPool;
      poolSize = res.poolSize;
      parseMs = res.parseMs;
      const base = shapeBaseTables(res.extract);
      const duckConn = await getDuck(); // warmed during the picker
      duck = await buildDuckDbStore(base, duckConn, { onPhase }); // emits 'apply' + 'recompute'
      post({ type: 'phase', phase: 'fts', ms: null, note: 'N/A' }); // no FTS5 → search uses LIKE
      // Synthesize the meta (no ChatStore here): counts from DuckDB, fingerprint/self/lossy from the extract.
      const cnt = async (tbl: string) =>
        Number(
          (await duckConn.query<{ c: number | bigint }>(`select count(*) c from ${tbl}`))[0]?.c ??
            0,
        );
      const earliest = Number(
        (
          await duckConn.query<{ e: number | bigint | null }>(
            'select min(ts) e from messages where ts>0',
          )
        )[0]?.e ?? 0,
      );
      meta = {
        asOf: Date.now(),
        fingerprint: res.extract.fp.hash,
        mappingVersion: res.extract.mapping?.mappingVersion ?? null,
        schemaMatched: !!res.extract.mapping,
        counts: {
          conversations: await cnt('conversations'),
          messages: base.messages.length,
          people: await cnt('people'),
        },
        earliestTs: earliest,
        ftsEnabled: false,
        lastFullAt: Date.now(),
        refreshMode: 'full',
        lossy: res.extract.lossy,
        selfMri: res.extract.selfMri,
      };
    } else {
      const res = await openStoreFromSourceParallel(source, { driver: driver!, pool, onPhase }); // extract/apply/recompute/fts
      usedPool = res.usedPool;
      poolSize = res.poolSize;
      parseMs = res.parseMs;
      sqlite = res.store;
      meta = sqlite.meta;
    }
    // Decode line last, matching the existing style (both engines): parseMs is the parse+fold window.
    if (usedPool)
      post({
        type: 'phase',
        phase: 'decode',
        ms: Math.round(parseMs),
        note: `(using ${poolSize} workers)`,
      });
    const buildMs = Math.round(performance.now() - t);

    // Run the four example queries on the chosen engine, timing each (shown inline with each example in
    // the result). SQLite is sync, DuckDB async — `await fn()` times both correctly.
    const queryMs: Record<string, number> = {};
    const timed = async <T>(name: string, fn: () => T | Promise<T>): Promise<T> => {
      const t0 = performance.now();
      const r = await fn();
      queryMs[name] = Math.round(performance.now() - t0);
      return r;
    };
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const conversations = await timed<any>('conversations', () =>
      duck ? duck.conversations(20) : sqlite!.conversations.list({ n: 20 }),
    );
    const people = await timed<any>('people', () =>
      duck ? duck.people(10) : sqlite!.people.find({ n: 10 }),
    );
    const search = await timed<any>('search', () =>
      duck ? duck.search('the', 5) : sqlite!.messages.search({ query: 'the', limit: 5 }),
    );
    const topics = await timed<any>('topics', () =>
      duck ? duck.topics('30d', 8) : sqlite!.topics.compute({ window: '30d', n: 8 }),
    );
    /* eslint-enable @typescript-eslint/no-explicit-any */
    // The DuckDB connection is warm/reused across builds — not closed here.

    post({
      type: 'result',
      data: {
        engine,
        mode: usedPool ? 'parallel' : 'serial',
        poolSize: usedPool ? poolSize : 0,
        parseMs: usedPool ? Math.round(parseMs) : null,
        prewarmed,
        driverWait: Math.round(driverWaitMs),
        buildMs,
        queryMs,
        meta,
        conversations,
        people,
        search,
        topics,
      },
    });
    sqlite?.close();
  } catch (err) {
    post({ type: 'error', msg: (err as Error).message });
  }
};
