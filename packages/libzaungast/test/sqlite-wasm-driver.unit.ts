// B4: prove the reference @sqlite.org/sqlite-wasm driver satisfies the SqlDriver seam by running a real
// ChatStore on it — schema creation, FTS5 detection, and exec/prepare→run/get/all all go through the
// wasm backend. This is the "browser SQLite actually drives the store" evidence; the Node path stays on
// node:sqlite. @sqlite.org/sqlite-wasm is a devDependency (never shipped). Async only for the one-time
// WASM init.
import { test, expect, beforeAll } from 'vitest';
import { ChatStore } from '../src/ingest/store.js';
import type { SqlDriver } from '../src/ingest/sql-driver.js';
import { createSqliteWasmDriver } from '../examples/sqlite-wasm-driver.js';

let driver: SqlDriver;
beforeAll(async () => {
  driver = await createSqliteWasmDriver();
});

test('ChatStore builds its schema + detects FTS5 on the wasm driver', () => {
  const store = new ChatStore(driver);
  // sqlite-wasm ships FTS5, so detectFts() (which opens a probe db via the driver) must succeed.
  expect(store.ftsEnabled).toBe(true);
  store.close();
});

test('exec + prepare→run/get/all round-trip through the wasm driver', () => {
  const store = new ChatStore(driver);
  store.db.exec('create table _t(a integer, b text)');
  const ins = store.db.prepare('insert into _t values(?,?)');
  expect(ins.run(1, 'x').changes).toBe(1);
  ins.run(2, 'y');
  ins.run(3, 'z');
  expect(store.db.prepare('select b from _t where a=?').get(2)).toEqual({ b: 'y' });
  expect(store.db.prepare('select a, b from _t order by a').all()).toEqual([
    { a: 1, b: 'x' },
    { a: 2, b: 'y' },
    { a: 3, b: 'z' },
  ]);
  expect(store.db.prepare('select b from _t where a=?').get(99)).toBeUndefined();
  store.close();
});
