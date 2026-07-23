// The minimal SQLite surface ChatStore + the query layer use — the seam that lets the SAME store code
// run on node:sqlite (Node/MCP; the default, injected at the Node entry) or a wasm SQLite build (the
// browser, e.g. @sqlite.org/sqlite-wasm). This is a TypeScript interface only: zero runtime cost, and
// node:sqlite's DatabaseSync already satisfies it structurally, so the Node path needs no wrapper. A
// browser driver provides a thin adapter to the same shape. It mirrors exactly the node:sqlite subset in
// use — nothing more — so it is a faithful contract, not speculative abstraction.
export type SqlParam = string | number | bigint | Uint8Array | null;

export interface SqlStatement {
  run(...params: SqlParam[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: SqlParam[]): unknown;
  all(...params: SqlParam[]): unknown[];
}

export interface SqlDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  close(): void;
}

// Opens databases for ChatStore: `:memory:` for a fresh build (and the FTS-support probe), or a file
// path (read-only) for an already-built store. `deleteOnClose` unlinks a throwaway file on close (the
// native engine's temp .db). Injected into ChatStore — the store never imports a concrete driver, so the
// browser graph never pulls node:sqlite.
export interface SqlDriver {
  open(target: string, opts?: { readOnly?: boolean; deleteOnClose?: boolean }): SqlDatabase;
}
