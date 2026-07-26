// Data-layer Web Worker (exposed via Comlink). Owns libzaungast/web + the wasm SQLite driver so all the
// heavy work — decode + build + query — runs off the main thread. The store stays resident so multiple
// visualizations (Wrapped now; contact graph etc. later) query the same build. Progress is reported
// through a Comlink-proxied callback the main thread passes in.
//
// The parallel cold-read path (parse across a pool → fold → extract across the pool → serial fallback)
// now lives in libzaungast/web's `openStoreFromSourceParallel`; this worker spawns a pool and hands it in.
import * as Comlink from 'comlink';
import {
  openStoreFromSource,
  openStoreFromSourceParallel,
  createPool,
  type SnapshotSource,
  type Pool,
  type TeamsStore,
  type StoreMeta,
  type BuildPhase,
} from 'libzaungast/web';
import { createSqliteWasmDriver } from 'libzaungast/web/sqlite-wasm-driver';
// Vite resolves the wasm to a served URL; the driver's locateFile hands it to the sqlite-wasm glue.
import sqlite3Url from '@sqlite.org/sqlite-wasm/sqlite3.wasm?url';
import { computeWrapped, type WrappedData } from './wrapped';

export type Progress =
  | { type: 'reading'; total: number }
  | { type: 'decoding'; name: string; i: number; n: number }
  | { type: 'phase'; phase: BuildPhase; ms: number };

let store: TeamsStore | null = null;
let driverPromise: ReturnType<typeof createSqliteWasmDriver> | null = null;
const getDriver = () =>
  (driverPromise ??= createSqliteWasmDriver({ locateFile: () => sqlite3Url }));

// Worker-pool sizing + spawn (over libzaungast/web's createPool; workers run handlePoolMessage), hoisted
// so prewarm() can spawn it DURING the file picker and build() just reuses it. CAP at 8: a naive
// `cores-1` (27 on a 28-core box) pays 27x module-init before any work; decode (~26 .ldb) + extract
// saturate well under it.
const POOL_SIZE = Math.min((self.navigator?.hardwareConcurrency || 4) - 1, 8);
function spawnPool(): Pool | null {
  if (POOL_SIZE <= 1) return null;
  try {
    return createPool(
      () => new Worker(new URL('./parse.worker.ts', import.meta.url), { type: 'module' }),
      POOL_SIZE,
    );
  } catch {
    return null;
  }
}
let warmPool: Pool | null = null; // populated by prewarm(), consumed by the next build()

const isData = (n: string) => n.endsWith('.ldb') || n.endsWith('.log');

const api = {
  // Prewarm during the file picker: init the wasm SQLite driver AND spawn the parse/extract pool (each
  // worker loads the libzaungast bundle) WHILE the user is still choosing a folder — so build() pays
  // neither after the pick. Idempotent; fire-and-forget — a failure just lets build() do it lazily.
  async prewarm(): Promise<void> {
    const t = performance.now();
    await getDriver();
    warmPool ??= spawnPool();
    console.log('[zaungast prewarm ms]', {
      driverInit: Math.round(performance.now() - t),
      pool: warmPool ? warmPool.size : 0,
    });
  },

  // Build the store from a picked leveldb folder. Reports progress via the (optional) proxied callback.
  async build(files: File[], onProgress?: (p: Progress) => void): Promise<StoreMeta> {
    const tDriver = performance.now();
    const driver = await getDriver();
    const driverWaitMs = performance.now() - tDriver; // ~0 when prewarm() already inited it
    onProgress?.({ type: 'reading', total: files.length });
    // Read every file's bytes CONCURRENTLY (File.arrayBuffer() is async I/O), overlapping the disk reads.
    const tRead = performance.now();
    const buffers = await Promise.all(files.map((f) => f.arrayBuffer()));
    const map = new Map<string, Uint8Array>();
    files.forEach((f, idx) => map.set(f.name, new Uint8Array(buffers[idx])));
    const readMs = performance.now() - tRead;

    const dataFiles = [...map.keys()].filter(isData);
    let i = 0;
    const source: SnapshotSource = {
      names: () => [...map.keys()],
      read: (name) => {
        const bytes = map.get(name);
        if (!bytes) throw new Error(`no such file: ${name}`);
        if (isData(name)) onProgress?.({ type: 'decoding', name, i: ++i, n: dataFiles.length });
        return bytes;
      },
    };

    store?.close();
    store = null; // so a failed build below leaves `wrapped()` with the clean "no store" error, not a closed handle
    const phaseMs: Record<string, number> = {};
    const onPhase = (phase: BuildPhase, ms: number) => {
      phaseMs[phase] = Math.round(ms);
      onProgress?.({ type: 'phase', phase, ms: Math.round(ms) });
    };

    // Reuse the prewarmed pool (or spawn now); openStoreFromSourceParallel owns parse+fold+extract with a
    // serial fallback and consumes/destroys the pool. deferFts: this viz may never search — take the whole
    // `fts` phase off the cold-read path.
    const prewarmed = warmPool !== null;
    const pool = warmPool ?? spawnPool();
    warmPool = null;

    const tBuild = performance.now();
    const result = await openStoreFromSourceParallel(source, {
      driver,
      pool,
      deferFts: true,
      onPhase,
    });
    store = result.store;
    const buildMs = performance.now() - tBuild;

    console.log('[zaungast cold-read ms]', {
      fileRead: Math.round(readMs),
      parsePool: result.usedPool ? Math.round(result.parseMs) : 'serial',
      ...phaseMs, // extract · apply · recompute · (decode only on the serial path; fts deferred)
      buildTotal: Math.round(buildMs),
      grandTotal: Math.round(readMs + buildMs),
      files: files.length,
      ldb: [...map.keys()].filter((n) => n.endsWith('.ldb')).length,
      pool: result.usedPool ? result.poolSize : 0,
      prewarmed,
      driverWait: Math.round(driverWaitMs),
      cores: self.navigator?.hardwareConcurrency ?? 0,
    });
    return store.meta;
  },

  async wrapped(): Promise<WrappedData> {
    if (!store) throw new Error('no store built yet');
    return computeWrapped(store);
  },
};

export type TeamsApi = typeof api;
Comlink.expose(api);
