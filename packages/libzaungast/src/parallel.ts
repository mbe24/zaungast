// Coordinator-side parallel cold read: parse `.ldb` across a worker pool, fold the Snapshot as tables
// arrive, fan the SSV extract out across the same pool, with a serial fallback at every failure. DOM-free
// — it drives a structural `Pool` (see ./pool.ts for the browser Web Worker implementation) and never
// touches Worker/self itself, so a Node worker_threads pool satisfying `Pool` works identically. This is
// the intricate part of a fast browser cold read; a consumer supplies a pool and gets back the store.
import { loadSnapshotFromAsync } from './format/chromium/indexeddb.js';
import { openStoreFromSnapshot, openStoreFromSource } from './store-facade.js';
import type { BuildPhase, TeamsStore } from './store-facade.js';
import { packRecords, packedRecordsTransferList, unpackTable } from './format/table-transfer.js';
import type { PackedTable } from './format/table-transfer.js';
import type { SnapshotSource, Snapshot, TableReadResult, EntityExtract } from './format/types.js';
import type { SqlDriver } from './ingest/sql-driver.js';
import type { PoolRequest } from './pool-worker.js';

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
  const ldbNames = source.names().filter((n) => n.endsWith('.ldb'));
  let usedPool = false;
  let parseMs = 0;
  try {
    let snap: Snapshot | null = null;
    if (pool) {
      const activePool = pool;
      try {
        const tParse = performance.now();
        // R-B: dispatch every `.ldb` parse eagerly, then fold each via getTable in canonical sorted order
        // while the pool parses the rest — the fold overlaps the parse. Byte-identical (the fold still
        // consumes files in sorted order; only wall-clock interleaving changes). A getTable miss →
        // inline read+parse at that position (see readTablesIntoAsync), so an undispatched file is safe.
        const pending = new Map<string, Promise<TableReadResult>>();
        let i = 0;
        for (const n of ldbNames) {
          const bytes = source.read(n);
          pending.set(
            n,
            activePool.run<PackedTable>({ kind: 'parse', bytes }).then((packed) => {
              onDecode?.(n, ++i, ldbNames.length);
              return unpackTable(packed);
            }),
          );
        }
        snap = await loadSnapshotFromAsync(source, { getTable: (name) => pending.get(name) });
        parseMs = performance.now() - tParse;
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
          runExtract: (task) => {
            // Pack the record range into 3 transferables so the whole chunk moves zero-copy — not one
            // structured-clone per tiny record buffer (the extract-side transfer tax).
            const packed = packRecords(task.records);
            return activePool.run<EntityExtract>(
              { kind: 'extract', packed, mapping: task.mapping, entity: task.entity },
              packedRecordsTransferList(packed),
            );
          },
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
