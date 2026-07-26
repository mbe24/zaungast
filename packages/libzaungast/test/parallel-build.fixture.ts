// The promoted /web parallel build: openStoreFromSourceParallel (drives a Pool for parse + extract, folds
// on the coordinator) must build a store BYTE-EQUIVALENT to the serial openStoreFromSource — and fall
// back to serial on any pool failure. The Pool here runs the real handlePoolMessage in-process (the same
// parse/extract protocol a Web Worker would), so this exercises the actual dispatch/fold/reassembly.
import { test, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStoreFromSource } from '../src/store-facade.js';
import { openStoreFromSourceParallel, type Pool } from '../src/parallel.js';
import { handlePoolMessage, type PoolRequest } from '../src/pool-worker.js';
import { MemorySource } from '../src/format/chromium/memory-source.js';
import { createSqliteWasmDriver } from '../src/sqlite-wasm-driver.js';
import type { SqlDriver } from '../src/ingest/sql-driver.js';
import type { StoreMeta } from '../src/ingest/store.js';
import { generateFixtureWithTables } from './fixture/generate.js';

let dir: string;
let driver: SqlDriver;
beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaungast-parbuild-'));
  generateFixtureWithTables(dir, { ldbFileCount: 3 }); // needs real .ldb so the pool parse path runs
  driver = await createSqliteWasmDriver();
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function memSource(): MemorySource {
  const files = new Map<string, Uint8Array>();
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isFile()) files.set(name, fs.readFileSync(p));
  }
  return new MemorySource(files);
}

// An in-process Pool running the real handler. `failOn` makes run() REJECT for a given job kind. Note a
// rejected PARSE degrades transparently (loadSnapshotFromAsync inline-parses that file), so the pool is
// still used for extract; a rejected EXTRACT trips the orchestration's extract→serial fallback.
function fakePool(size = 4, failOn?: 'parse' | 'extract'): Pool {
  let destroyed = false;
  return {
    size,
    async run<T>(msg: PoolRequest): Promise<T> {
      await Promise.resolve(); // model async dispatch
      if (destroyed) throw new Error('pool destroyed');
      if (failOn && msg.kind === failOn) throw new Error(`forced ${failOn} failure`);
      return handlePoolMessage(msg).data as T;
    },
    destroy() {
      destroyed = true;
    },
  };
}

// A pool whose run() throws SYNCHRONOUSLY — the only way to trip the orchestration's WHOLESALE
// parse-catch (a per-job rejection is absorbed inline by loadSnapshotFromAsync instead).
function syncThrowPool(size = 4): Pool {
  return {
    size,
    run<T>(): Promise<T> {
      throw new Error('sync pool boom');
    },
    destroy() {},
  };
}

const stableMeta = (m: StoreMeta) => {
  const { asOf: _a, lastFullAt: _l, ...rest } = m;
  return rest;
};

async function expectSameAsSerial(pool: Pool | null, expectUsedPool: boolean) {
  const serial = openStoreFromSource(memSource(), { driver });
  const { store: par, usedPool } = await openStoreFromSourceParallel(memSource(), { driver, pool });
  try {
    expect(usedPool).toBe(expectUsedPool);
    expect(stableMeta(par.meta)).toEqual(stableMeta(serial.meta));
    expect(serial.meta.counts.messages).toBeGreaterThan(0);
    const convs = serial.conversations.list({ n: 100000 });
    expect(par.conversations.list({ n: 100000 })).toEqual(convs);
    for (const c of convs)
      expect(par.messages.inConversation(c.id, { limit: 100000 })).toEqual(
        serial.messages.inConversation(c.id, { limit: 100000 }),
      );
  } finally {
    serial.close();
    par.close();
  }
}

test('openStoreFromSourceParallel (pool) === openStoreFromSource', async () => {
  await expectSameAsSerial(fakePool(4), true);
});

test('pool=null → serial path, same store', async () => {
  await expectSameAsSerial(null, false);
});

test('parse-job rejections degrade to inline parse (extract still pooled), same store', async () => {
  // Per-job parse rejection is absorbed by loadSnapshotFromAsync's inline fallback → pool still used.
  await expectSameAsSerial(fakePool(4, 'parse'), true);
});

test('wholesale (synchronous) parse failure → full serial fallback, same store', async () => {
  await expectSameAsSerial(syncThrowPool(), false);
});

test('extract-pool failure → serial re-extract over the snapshot, same store', async () => {
  // usedPool stays false because the extract fell back; the store must still match serial.
  await expectSameAsSerial(fakePool(4, 'extract'), false);
});
