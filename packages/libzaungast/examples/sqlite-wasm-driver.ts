// Reference browser SqlDriver over @sqlite.org/sqlite-wasm — the adapter that plugs the wasm SQLite
// build into libzaungast's SqlDriver seam (src/ingest/sql-driver.ts). It is NOT part of the shipped
// library (files:["dist"] excludes examples/) and @sqlite.org/sqlite-wasm is a devDependency only, so a
// Node/MCP consumer never pulls wasm. A browser demo imports this alongside `libzaungast/web`, calls
// `await createSqliteWasmDriver()` once (the only async — the WASM init), then hands the sync driver to
// ChatStore/openStoreFromSource. Validated by test/sqlite-wasm-driver.unit.ts (drives a full ChatStore).
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import type { SqlDatabase, SqlDriver, SqlParam, SqlStatement } from '../src/ingest/sql-driver.js';

// The minimal oo1 shapes used here (the package's own types are broad). oo1's `exec` with rowMode
// 'object' + resultRows is the confirmed way to collect rows; `changes()` gives the affected-row count.
interface Oo1Db {
  exec(
    arg: string | { sql: string; bind?: SqlParam[]; rowMode?: string; resultRows?: unknown[] },
  ): void;
  changes(): number;
  pointer: number;
  close(): void;
}

// A statement keyed by its SQL: each call re-execs through oo1 (which caches the compiled statement
// internally). The prepared-statement cache in ChatStore still avoids re-building these wrapper objects.
class WasmStatement implements SqlStatement {
  constructor(
    private readonly db: Oo1Db,
    private readonly sql: string,
    private readonly lastRowid: () => number | bigint,
  ) {}
  run(...params: SqlParam[]): { changes: number | bigint; lastInsertRowid: number | bigint } {
    this.db.exec({ sql: this.sql, bind: params.length ? params : undefined });
    return { changes: this.db.changes(), lastInsertRowid: this.lastRowid() };
  }
  get(...params: SqlParam[]): unknown {
    const rows: unknown[] = [];
    this.db.exec({ sql: this.sql, bind: params.length ? params : undefined, rowMode: 'object', resultRows: rows });
    return rows[0];
  }
  all(...params: SqlParam[]): unknown[] {
    const rows: unknown[] = [];
    this.db.exec({ sql: this.sql, bind: params.length ? params : undefined, rowMode: 'object', resultRows: rows });
    return rows;
  }
}

class WasmDatabase implements SqlDatabase {
  constructor(
    // `any`: the package's Sqlite3Static type is broad; we only reach capi.sqlite3_last_insert_rowid.
    private readonly sqlite3: any,
    private readonly db: Oo1Db,
  ) {}
  exec(sql: string): void {
    this.db.exec(sql);
  }
  prepare(sql: string): SqlStatement {
    return new WasmStatement(this.db, sql, () =>
      this.sqlite3.capi.sqlite3_last_insert_rowid(this.db.pointer),
    );
  }
  close(): void {
    this.db.close();
  }
}

// Async once (WASM init), then a synchronous SqlDriver — matching ChatStore's sync constructor.
export async function createSqliteWasmDriver(): Promise<SqlDriver> {
  const sqlite3 = await sqlite3InitModule();
  return {
    open(target, opts = {}) {
      // Browser has no file paths / deleteOnClose (that's the Node temp-file path) — `target` is
      // ':memory:' (or an OPFS name). readOnly maps to oo1's 'r' open flag.
      const db = new sqlite3.oo1.DB(target, opts.readOnly ? 'r' : 'c') as Oo1Db;
      return new WasmDatabase(sqlite3, db);
    },
  };
}
