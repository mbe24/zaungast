// DuckDB-Wasm adapter for the POC's engine picker. DuckDB-wasm is ASYNC (it runs in its own worker and
// returns Apache Arrow results), so it CANNOT sit behind libzaungast's synchronous SqlDriver seam — this
// is a POC-local async adapter, not a SqlDriver. It exists to prove the query/analytics layer isn't
// overfit to SQLite (see duckdb-store.ts). The wasm module + its worker are copied next to worker.js by
// build.mjs and resolved at runtime relative to import.meta.url (self-hosted — no CDN fetch).
import * as duckdb from '@duckdb/duckdb-wasm';

import type { Table } from 'apache-arrow';

export interface DuckDbConn {
  run(sql: string): Promise<void>;
  // Rows as plain objects. DuckDB returns BigInt for integer columns (COUNT, etc.); callers coerce.
  query<T = Record<string, unknown>>(sql: string): Promise<T[]>;
  // Bulk-load an Arrow table as a DuckDB table (schema from the Arrow schema when create is set).
  insertArrowTable(table: Table, options: { name: string; create?: boolean }): Promise<void>;
  close(): Promise<void>;
}

// Resolve an asset copied next to this bundle. The arg is NON-literal so esbuild leaves the URL alone (it
// only rewrites `new URL('<string-literal>', import.meta.url)`); build.mjs emits the file into dist.
const assetUrl = (name: string) => new URL(name, import.meta.url).href;

export async function createDuckDb(): Promise<DuckDbConn> {
  // Self-hosted bundles (no jsDelivr): eh = exception-handling (modern), mvp = broad-compat fallback.
  // selectBundle feature-detects and picks one; we don't offer coi (needs cross-origin isolation).
  const bundle = await duckdb.selectBundle({
    mvp: {
      mainModule: assetUrl('duckdb-mvp.wasm'),
      mainWorker: assetUrl('duckdb-browser-mvp.worker.js'),
    },
    eh: {
      mainModule: assetUrl('duckdb-eh.wasm'),
      mainWorker: assetUrl('duckdb-browser-eh.worker.js'),
    },
  });
  const worker = new Worker(bundle.mainWorker!);
  const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING), worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  const conn = await db.connect();
  return {
    async run(sql) {
      await conn.query(sql);
    },
    async query<T>(sql: string): Promise<T[]> {
      const table = await conn.query(sql);
      return table.toArray().map((row) => row.toJSON() as T);
    },
    async insertArrowTable(table, options) {
      await conn.insertArrowTable(table, options);
    },
    async close() {
      await conn.close();
      await db.terminate();
      worker.terminate();
    },
  };
}
