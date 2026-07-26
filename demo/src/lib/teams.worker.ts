// Data-layer Web Worker (exposed via Comlink). Owns libzaungast/web + the wasm SQLite driver so all the
// heavy work — decode + build + query — runs off the main thread. The store stays resident so multiple
// visualizations (Wrapped now; contact graph etc. later) query the same build. Progress is reported
// through a Comlink-proxied callback the main thread passes in.
import * as Comlink from 'comlink';
import {
  openStoreFromSource,
  openStoreFromSnapshot,
  loadSnapshotFromAsync,
  unpackTable,
  type SnapshotSource,
  type Snapshot,
  type TableReadResult,
  type PackedTable,
  type EntityExtract,
  type TeamsStore,
  type StoreMeta,
  type BuildPhase,
} from 'libzaungast/web';
import { createSqliteWasmDriver } from './sqlite-wasm-driver';
import { createPool, type Pool } from './pool';
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

// Worker-pool sizing + spawn, hoisted so prewarm() can spawn it (each worker loading the libzaungast
// bundle) DURING the file picker and build() just reuses it — no wasm-init / pool-spawn after the pick.
// CAP at 8: a naive `cores-1` (27 on a 28-core box) pays 27x module-init before any work; decode
// (~26 .ldb) + extract (a few 4000-record chunks) saturate well under it.
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
    // Read every file's bytes CONCURRENTLY (File.arrayBuffer() is async I/O). The serial
    // `await` loop this replaces read one file at a time; Promise.all overlaps the disk reads.
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

    // C3: parse the `.ldb` files across a Web Worker pool (the biggest cold-read phase), then fold the
    // Snapshot on this coordinator (byte-identical order → same fingerprint) and build the store from
    // it. Falls back to the serial path if a pool can't be created (e.g. nested workers unsupported) or
    // any parse fails — the coordinator keeps the raw bytes, so the fallback is always safe.
    const ldbNames = [...map.keys()].filter((n) => n.endsWith('.ldb'));
    // Reuse the pool prewarm() spawned during the picker; otherwise spawn it now (spawnPool caps size).
    const prewarmed = warmPool !== null;
    let pool: Pool | null = warmPool ?? spawnPool();
    warmPool = null;
    const poolSize = pool ? pool.size : 0; // captured before the finally destroys the pool

    const tBuild = performance.now();
    let parseMs = 0;
    let usedPool = false;
    let snap: Snapshot | null = null;
    try {
      if (pool) {
        try {
          const tParse = performance.now();
          // R-B: dispatch every `.ldb` parse eagerly, then let loadSnapshotFromAsync pull each via
          // getTable in canonical order and fold it WHILE the pool parses the rest — the fold overlaps
          // the parse instead of running after it. Byte-identical (the fold still consumes files in
          // sorted order; only wall-clock interleaving changes). getTable returns undefined for a name
          // never dispatched → inline parse fallback at that position (see readTablesIntoAsync).
          const pending = new Map<string, Promise<TableReadResult>>();
          for (const n of ldbNames)
            pending.set(
              n,
              pool!.run<PackedTable>({ kind: 'parse', bytes: map.get(n)! }).then((packed) => {
                onProgress?.({ type: 'decoding', name: n, i: ++i, n: dataFiles.length });
                return unpackTable(packed);
              }),
            );
          snap = await loadSnapshotFromAsync(source, { getTable: (name) => pending.get(name) });
          parseMs = performance.now() - tParse; // now the parse+fold overlap window
          usedPool = true;
        } catch (e) {
          console.warn('[zaungast] parse pool failed → serial fallback', e);
          snap = null;
          usedPool = false;
          pool.destroy(); // don't let stragglers contend with the serial re-parse
          pool = null;
        }
      }

      if (usedPool && snap) {
        // C4: fan the SSV extract out across the SAME pool (the library compacts records first, then
        // concatenates results in dispatch order → byte-identical to serial). On ANY pool failure,
        // fall back to a serial extract over the SAME snapshot (no re-parse) — extract is read-only.
        try {
          store = await openStoreFromSnapshot(snap, {
            driver,
            deferFts: true,
            onPhase,
            runExtract: (task) =>
              pool!.run<EntityExtract>({
                kind: 'extract',
                records: task.records,
                mapping: task.mapping,
                entity: task.entity,
              }),
          });
        } catch (e) {
          console.warn('[zaungast] extract pool failed → serial extract', e);
          // Destroy the pool BEFORE the serial re-extract so in-flight straggler chunks (up to all 5
          // entities' worth, since R-A dispatches them concurrently) don't contend with it.
          pool?.destroy();
          pool = null;
          store = await openStoreFromSnapshot(snap, { driver, deferFts: true, onPhase });
        }
      } else {
        store = openStoreFromSource(source, { driver, deferFts: true, onPhase });
      }
    } finally {
      pool?.destroy();
    }
    const buildMs = performance.now() - tBuild;

    console.log('[zaungast cold-read ms]', {
      fileRead: Math.round(readMs),
      parsePool: usedPool ? Math.round(parseMs) : 'serial',
      ...phaseMs, // extract · apply · recompute · (decode only on the serial path; fts deferred)
      buildTotal: Math.round(buildMs),
      grandTotal: Math.round(readMs + buildMs),
      files: files.length,
      ldb: ldbNames.length,
      pool: usedPool ? poolSize : 0,
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
