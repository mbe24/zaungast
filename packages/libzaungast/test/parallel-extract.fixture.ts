// C2 (parallel-ingest seam): extractFromSnapshotAsync + openStoreFromSnapshot must be BYTE-IDENTICAL to
// the serial extract regardless of chunk boundaries or worker completion order. The executor here mimics
// a worker pool but resolves chunks after random delays (out-of-order completion) with a deliberately
// tiny `chunkRecords`, so if reassembly were by completion order instead of dispatch (entity → bucket →
// range) order, msgRows would reorder → voteSelfMri could flip → these deep-equals would fail.
import { test, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSnapshotFrom } from '../src/format/chromium/indexeddb.js';
import {
  extractFromSnapshot,
  extractFromSnapshotAsync,
  type ExtractExecutor,
} from '../src/ingest/ingest-core.js';
import { extractRecords } from '../src/format/resolver.js';
import { openStoreFromSource, openStoreFromSnapshot } from '../src/store-facade.js';
import { MemorySource } from '../src/format/chromium/memory-source.js';
import { createSqliteWasmDriver } from '../examples/sqlite-wasm-driver.js';
import type { StoreMeta } from '../src/ingest/store.js';
import { generateFixture } from './fixture/generate.js';

let dir: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaungast-parx-'));
  generateFixture(dir);
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function filesMap(): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isFile()) files.set(name, fs.readFileSync(p));
  }
  return files;
}
const memSource = () => new MemorySource(filesMap());

// A worker-pool stand-in: resolves each chunk after a random delay (out-of-order completion).
const shuffled: ExtractExecutor = async (task) => {
  await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 4)));
  return extractRecords(task.records, task.mapping, task.entity);
};

const stableMeta = (m: StoreMeta) => {
  const { asOf: _a, lastFullAt: _l, ...rest } = m;
  return rest;
};

test('extractFromSnapshotAsync (shuffled executor, tiny chunks) === serial extractFromSnapshot', async () => {
  const snap = loadSnapshotFrom(memSource());
  const serial = extractFromSnapshot(snap);
  const parallel = await extractFromSnapshotAsync(snap, { runExtract: shuffled, chunkRecords: 3 });
  expect(parallel).toEqual(serial); // whole FullExtract: rows (order), selfMri, targets, fp, decoded/dropped
  // Sanity: the fixture actually populated the entities we're parallelizing.
  expect(serial.msgRows.length).toBeGreaterThan(0);
});

test('extractFromSnapshotAsync with no executor delegates to the serial path', async () => {
  const snap = loadSnapshotFrom(memSource());
  expect(await extractFromSnapshotAsync(snap)).toEqual(extractFromSnapshot(snap));
});

test('openStoreFromSnapshot (parallel extract) builds the same store as openStoreFromSource', async () => {
  const driver = await createSqliteWasmDriver();
  const serial = openStoreFromSource(memSource(), { driver });
  const snap = loadSnapshotFrom(memSource());
  const parallel = await openStoreFromSnapshot(snap, {
    driver,
    runExtract: shuffled,
    chunkRecords: 5,
  });
  try {
    expect(stableMeta(parallel.meta)).toEqual(stableMeta(serial.meta));
    expect(serial.meta.counts.messages).toBeGreaterThan(0);
    // Fully-ordered reads → deep-equal directly.
    const convs = serial.conversations.list({ n: 100000 });
    expect(parallel.conversations.list({ n: 100000 })).toEqual(convs);
    for (const c of convs) {
      expect(parallel.messages.inConversation(c.id, { limit: 100000 })).toEqual(
        serial.messages.inConversation(c.id, { limit: 100000 }),
      );
    }
  } finally {
    serial.close();
    parallel.close();
  }
});
