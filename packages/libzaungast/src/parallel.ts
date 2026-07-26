// Coordinator-side parallel cold read: parse `.ldb` across a worker pool, fold the Snapshot as tables
// arrive, fan the SSV extract out across the same pool, with a serial fallback at every failure. DOM-free
// — it drives a structural `Pool` (see ./pool.ts for the browser Web Worker implementation) and never
// touches Worker/self itself, so a Node worker_threads pool satisfying `Pool` works identically. This is
// the intricate part of a fast browser cold read; a consumer supplies a pool and gets back the store.
import { loadSnapshotFrom, loadSnapshotFromAsync } from './format/chromium/indexeddb.js';
import { openStoreFromSnapshot, openStoreFromSource } from './store-facade.js';
import type { BuildPhase, TeamsStore } from './store-facade.js';
import { extractFromSnapshotAsync, type FullExtract } from './ingest/ingest-core.js';
import { packRecords, packedRecordsTransferList, unpackTable } from './format/table-transfer.js';
import type { PackedTable } from './format/table-transfer.js';
import type { SnapshotSource, Snapshot, TableReadResult, EntityExtract } from './format/types.js';
import type { SqlDriver } from './ingest/sql-driver.js';
import type { PoolRequest } from './pool-worker.js';

// The pool's SSV extract executor: pack each record range into 3 transferables (zero-copy) and run it on
// a worker. Shared by openStoreFromSourceParallel and extractFromSourceParallel.
function poolExtract(pool: Pool) {
  return (task: { records: unknown[]; mapping: unknown; entity: string }) => {
    const packed = packRecords(task.records as never);
    return pool.run<EntityExtract>(
      { kind: 'extract', packed, mapping: task.mapping as never, entity: task.entity },
      packedRecordsTransferList(packed),
    );
  };
}

// Dispatch every `.ldb` parse to the pool eagerly (R-B), then fold via getTable in canonical order so the
// fold overlaps the parse. Returns the folded Snapshot + the parse+fold wall-clock. Throws on wholesale
// pool failure (the caller drops the pool and re-folds serially).
async function foldViaPool(
  source: SnapshotSource,
  pool: Pool,
  onDecode?: (name: string, i: number, total: number) => void,
): Promise<{ snap: Snapshot; parseMs: number }> {
  const ldbNames = source.names().filter((n) => n.endsWith('.ldb'));
  const tParse = performance.now();
  const pending = new Map<string, Promise<TableReadResult>>();
  let i = 0;
  for (const n of ldbNames) {
    const bytes = source.read(n);
    pending.set(
      n,
      pool.run<PackedTable>({ kind: 'parse', bytes }).then((packed) => {
        onDecode?.(n, ++i, ldbNames.length);
        return unpackTable(packed);
      }),
    );
  }
  const snap = await loadSnapshotFromAsync(source, { getTable: (name) => pending.get(name) });
  return { snap, parseMs: performance.now() - tParse };
}

export interface ParallelExtractResult {
  extract: FullExtract;
  usedPool: boolean;
  poolSize: number;
  parseMs: number; // parse+fold overlap window (0 on the serial path)
}
export interface ParallelExtractOptions {
  pool: Pool | null; // null → serial fold+extract
  chunkRecords?: number;
  onPhase?: (phase: BuildPhase, ms: number) => void;
  onDecode?: (name: string, i: number, total: number) => void;
}

// The shared parse→fold→extract front half, as a reusable seam: fold `.ldb` across the pool, then fan the
// SSV extract out across the same pool, returning the engine-agnostic `FullExtract`. Both the SQLite build
// (buildStore) and a non-SQLite backend (the DuckDB demo → shapeBaseTables/deriveTables) compose this.
// Same serial-fallback discipline as openStoreFromSourceParallel; consumes/destroys the pool.
export async function extractFromSourceParallel(
  source: SnapshotSource,
  opts: ParallelExtractOptions,
): Promise<ParallelExtractResult> {
  const { chunkRecords, onPhase, onDecode } = opts;
  let pool = opts.pool;
  const poolSize = pool ? pool.size : 0;
  let usedPool = false;
  let parseMs = 0;
  try {
    let snap: Snapshot | null = null;
    if (pool) {
      const activePool = pool;
      try {
        ({ snap, parseMs } = await foldViaPool(source, activePool, onDecode));
      } catch {
        snap = null; // parse pool failed → drop it, fold serially below
        activePool.destroy();
        pool = null;
      }
    }
    let extract: FullExtract;
    if (pool && snap) {
      const activePool = pool;
      try {
        extract = await extractFromSnapshotAsync(snap, {
          chunkRecords,
          onPhase,
          runExtract: poolExtract(activePool),
        });
        usedPool = true;
      } catch {
        activePool.destroy(); // extract pool failed → re-extract over the SAME snapshot, serially
        pool = null;
        extract = await extractFromSnapshotAsync(snap, { chunkRecords, onPhase });
      }
    } else {
      // No usable pool: fold serially (timed as the 'decode' phase, matching openStoreFromSource), extract.
      const tDecode = onPhase ? performance.now() : 0;
      const folded = loadSnapshotFrom(source);
      onPhase?.('decode', performance.now() - tDecode);
      extract = await extractFromSnapshotAsync(folded, { chunkRecords, onPhase });
    }
    return { extract, usedPool, poolSize, parseMs };
  } finally {
    pool?.destroy();
  }
}

// The minimal worker-pool the parallel build drives. Any pool with these three members works (the
// browser `createPool`, or a Node worker_threads pool) — kept structural + DOM-free (`transfer` is
// ArrayBuffer[], not Transferable[]). Workers must speak the PoolRequest protocol (see handlePoolMessage).
export interface Pool {
  readonly size: number;
  run<T>(msg: PoolRequest, transfer?: ArrayBuffer[]): Promise<T>;
  destroy(): void;
}

export interface ParallelBuildResult {
  store: TeamsStore;
  usedPool: boolean; // false → the serial fallback ran (no pool given, or a pool failure)
  poolSize: number;
  parseMs: number; // the parse+fold overlap window (0 on the serial path)
}

export interface ParallelBuildOptions {
  driver: SqlDriver;
  pool: Pool | null; // null → serial build (openStoreFromSource)
  deferFts?: boolean;
  extraStopwords?: Iterable<string>;
  chunkRecords?: number;
  onPhase?: (phase: BuildPhase, ms: number) => void;
  onDecode?: (name: string, i: number, total: number) => void; // fired per pooled `.ldb` as it parses
}

// Build a store from a SnapshotSource using the pool for parse + extract, folding on the coordinator.
// Always returns a store: any pool failure falls back to the serial path over the same bytes/snapshot
// (the coordinator keeps the raw bytes readable, and extract is read-only). Consumes the pool — it is
// destroyed before return (success or failure), so the caller re-spawns for the next build.
export async function openStoreFromSourceParallel(
  source: SnapshotSource,
  opts: ParallelBuildOptions,
): Promise<ParallelBuildResult> {
  const { driver, deferFts, extraStopwords, chunkRecords, onPhase, onDecode } = opts;
  let pool = opts.pool;
  const poolSize = pool ? pool.size : 0;
  let usedPool = false;
  let parseMs = 0;
  try {
    let snap: Snapshot | null = null;
    if (pool) {
      const activePool = pool;
      try {
        ({ snap, parseMs } = await foldViaPool(source, activePool, onDecode));
      } catch {
        // Parse pool failed (nested workers unsupported, a parse threw, …). Drop it so stragglers don't
        // contend with the serial re-parse; fall through to the serial build below.
        snap = null;
        activePool.destroy();
        pool = null;
      }
    }

    let store: TeamsStore;
    if (pool && snap) {
      const activePool = pool;
      try {
        store = await openStoreFromSnapshot(snap, {
          driver,
          deferFts,
          extraStopwords,
          chunkRecords,
          onPhase,
          runExtract: poolExtract(activePool),
        });
        usedPool = true;
      } catch {
        // Extract pool failed. Destroy it BEFORE the serial re-extract (R-A dispatches all entities
        // concurrently → stragglers must not contend) and re-extract over the SAME snapshot (no re-parse).
        activePool.destroy();
        pool = null;
        store = await openStoreFromSnapshot(snap, {
          driver,
          deferFts,
          extraStopwords,
          chunkRecords,
          onPhase,
        });
      }
    } else {
      store = openStoreFromSource(source, { driver, deferFts, extraStopwords, onPhase });
    }
    return { store, usedPool, poolSize, parseMs };
  } finally {
    pool?.destroy();
  }
}
