// Browser SqlDriver over @sqlite.org/sqlite-wasm — the adapter that plugs the wasm SQLite build into
// libzaungast's SqlDriver seam (./ingest/sql-driver.ts). Shipped as the ISOLATED subpath
// `libzaungast/web/sqlite-wasm-driver` so it isn't pulled into the main `./web` bundle: @sqlite.org/
// sqlite-wasm is NOT a declared dependency (its version stream is prerelease-only, which breaks semver
// peer ranges) — a browser consumer that uses THIS subpath installs it themselves; a Node/MCP consumer
// (or a browser consumer bringing its own driver) never touches wasm. A browser consumer imports this
// alongside `libzaungast/web`, calls
// `await createSqliteWasmDriver({ locateFile })` once (the only async — the WASM init), then hands the
// sync driver to openStoreFromSource/openStoreFromSourceParallel. Validated by test/sqlite-wasm-driver.unit.ts.
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import type { SqlDatabase, SqlDriver, SqlParam, SqlStatement } from './ingest/sql-driver.js';

// The minimal oo1 shapes used here (the package's own types are broad). We reuse a compiled `Stmt`
// across calls (bind/step/reset) instead of oo1's convenience `exec()` — `exec()` prepares AND finalizes
// on EVERY call (dist/index.mjs: `const stmt = db.prepare(sql); … stmt.finalize()`), so routing the hot
// per-row upserts through it re-parses the same SQL thousands of times. `ChatStore` caches the wrapper
// per SQL, so one compiled statement now lives for the store's lifetime (freed on `DB.close()`).
interface Oo1Stmt {
  bind(params: SqlParam[]): Oo1Stmt;
  step(): boolean;
  get(target: Record<string, unknown>): Record<string, unknown>;
  reset(alsoClearBinds?: boolean): Oo1Stmt;
  finalize(): void;
}
interface Oo1Db {
  exec(sql: string): void;
  prepare(sql: string): Oo1Stmt;
  changes(): number;
  pointer: number;
  close(): void;
}

class WasmStatement implements SqlStatement {
  constructor(
    private readonly db: Oo1Db,
    private readonly stmt: Oo1Stmt, // compiled once; reused
    private readonly lastRowid: () => number | bigint,
  ) {}
  // reset(true) clears the previous call's bindings; rebind (positional array); trailing reset() releases
  // the statement (a SELECT that returned a row is otherwise left mid-iteration).
  private prime(params: SqlParam[]): void {
    this.stmt.reset(true);
    if (params.length) this.stmt.bind(params);
  }
  run(...params: SqlParam[]): { changes: number | bigint; lastInsertRowid: number | bigint } {
    this.prime(params);
    this.stmt.step();
    this.stmt.reset();
    return { changes: this.db.changes(), lastInsertRowid: this.lastRowid() };
  }
  get(...params: SqlParam[]): unknown {
    this.prime(params);
    const row = this.stmt.step() ? this.stmt.get({}) : undefined;
    this.stmt.reset();
    return row;
  }
  all(...params: SqlParam[]): unknown[] {
    this.prime(params);
    const rows: unknown[] = [];
    while (this.stmt.step()) rows.push(this.stmt.get({}));
    this.stmt.reset();
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
    return new WasmStatement(this.db, this.db.prepare(sql), () =>
      this.sqlite3.capi.sqlite3_last_insert_rowid(this.db.pointer),
    );
  }
  close(): void {
    this.db.close(); // oo1 DB.close() finalizes any open statements
  }
}

// Async once (WASM init), then a synchronous SqlDriver — matching ChatStore's sync constructor.
// `initOptions` is passed straight to sqlite3InitModule (Emscripten module opts) — in a bundled browser
// build, pass `{ locateFile }` so the glue can find sqlite3.wasm next to the bundle. Node needs none.
export async function createSqliteWasmDriver(
  // `locateFile` is the one option every browser build needs (point the glue at sqlite3.wasm); the rest
  // are passed through to sqlite3InitModule (Emscripten module opts). Node needs neither.
  initOptions?: { locateFile?: (path: string, prefix?: string) => string } & Record<
    string,
    unknown
  >,
): Promise<SqlDriver> {
  // The shipped types declare sqlite3InitModule as taking no args; at runtime it accepts the standard
  // Emscripten module options (locateFile, print, …). Widen the signature rather than cast the result,
  // so the returned Sqlite3Static type is preserved.
  const init: (opts?: Record<string, unknown>) => ReturnType<typeof sqlite3InitModule> =
    sqlite3InitModule;
  const sqlite3 = await init(initOptions);
  return {
    open(target, opts = {}) {
      // Browser has no file paths / deleteOnClose (that's the Node temp-file path) — `target` is
      // ':memory:' (or an OPFS name). readOnly maps to oo1's 'r' open flag.
      const db = new sqlite3.oo1.DB(target, opts.readOnly ? 'r' : 'c') as Oo1Db;
      return new WasmDatabase(sqlite3, db);
    },
  };
}
