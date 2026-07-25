// Browser SqlDriver over @sqlite.org/sqlite-wasm — plugs the wasm SQLite build into libzaungast's
// SqlDriver seam. `createSqliteWasmDriver({ locateFile })` is awaited once (the WASM init) in the worker,
// then the sync driver is handed to openStoreFromSource.
//
// Prepared-statement reuse: each `prepare(sql)` compiles ONE oo1 `Stmt` and reuses it across calls via
// bind/step/reset. This matters — oo1's convenience `exec()` prepares AND finalizes on every call (see
// dist/index.mjs: `const stmt = db.prepare(sql); … stmt.finalize()`), so routing the hot per-row upserts
// through `exec` re-parsed the same SQL thousands of times. `ChatStore` already caches the wrapper per
// SQL, so one compiled statement now lives for the store's lifetime (freed on `DB.close()`).
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import type { SqlDatabase, SqlDriver, SqlParam, SqlStatement } from 'libzaungast/web';

// The oo1 `Stmt` methods we use (the package's own types are broad / `any`).
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
	// the statement (a SELECT that returned a row is left mid-iteration otherwise).
	private prime(params: SqlParam[]): void {
		this.stmt.reset(true);
		if (params.length) this.stmt.bind(params);
	}
	run(...params: SqlParam[]): { changes: number | bigint; lastInsertRowid: number | bigint } {
		this.prime(params);
		this.stmt.step(); // INSERT/UPDATE → SQLITE_DONE
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
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
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

export async function createSqliteWasmDriver(
	initOptions?: Record<string, unknown>,
): Promise<SqlDriver> {
	const init: (opts?: Record<string, unknown>) => ReturnType<typeof sqlite3InitModule> =
		sqlite3InitModule;
	const sqlite3 = await init(initOptions);
	return {
		open(target, opts = {}) {
			const db = new sqlite3.oo1.DB(target, opts.readOnly ? 'r' : 'c') as Oo1Db;
			return new WasmDatabase(sqlite3, db);
		},
	};
}
