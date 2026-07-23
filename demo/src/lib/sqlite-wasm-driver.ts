// Browser SqlDriver over @sqlite.org/sqlite-wasm — plugs the wasm SQLite build into libzaungast's
// SqlDriver seam. Adapted from packages/libzaungast/examples/sqlite-wasm-driver.ts; the only change is
// importing the driver types from the published surface (`libzaungast/web`) instead of a src path.
// `createSqliteWasmDriver({ locateFile })` is awaited once (the WASM init) in the worker, then the sync
// driver is handed to openStoreFromSource.
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import type { SqlDatabase, SqlDriver, SqlParam, SqlStatement } from 'libzaungast/web';

interface Oo1Db {
	exec(
		arg: string | { sql: string; bind?: SqlParam[]; rowMode?: string; resultRows?: unknown[] },
	): void;
	changes(): number;
	pointer: number;
	close(): void;
}

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
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
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
