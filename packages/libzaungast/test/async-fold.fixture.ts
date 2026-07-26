// R-B (ordered fold-behind-parse): loadSnapshotFromAsync folds `.ldb` tables pulled through a `getTable`
// provider so the caller can parse them off-thread while the fold runs. It MUST be byte-identical to the
// sync loadSnapshotFrom regardless of the provider's COMPLETION order — because it awaits each file in
// canonical (byCodeUnit) order, the `consider` call sequence (→ Map insertion order → fingerprint sample
// → records[] order) is unchanged. A provider miss (undefined) or rejection falls back to inline parse
// at that same position; a provider-returned lossy table marks the load lossy, matching the sync path.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect, beforeAll, afterAll } from 'vitest';
import { loadSnapshotFrom, loadSnapshotFromAsync } from '../src/format/chromium/indexeddb.js';
import { parseTable } from '../src/format/chromium/sstable.js';
import { fingerprint } from '../src/format/fingerprint.js';
import { MemorySource } from '../src/format/chromium/memory-source.js';
import { generateFixtureWithTables } from './fixture/generate.js';
import type { Snapshot, TableReadResult } from '../src/format/types.js';

// Hash every record's exact key+value bytes across all buckets — the true byte-identity check (not the
// schema fingerprint, which only samples 5/bucket).
function hashAllRecords(snap: Snapshot): string {
  const h = createHash('sha256');
  for (const [sk, bucket] of snap.buckets) {
    h.update(sk);
    h.update(String(bucket.records.length));
    for (const r of bucket.records) {
      h.update(new Uint8Array(r.key));
      h.update('\0');
      h.update(r.value === null ? '\0null' : new Uint8Array(r.value));
      h.update('\0');
    }
  }
  return h.digest('hex');
}
const sameSnapshot = (a: Snapshot, b: Snapshot) => {
  expect(a.buckets.size).toBe(b.buckets.size);
  expect(a.rawCount).toBe(b.rawCount);
  expect(a.uniqueCount).toBe(b.uniqueCount);
  expect(a.maxSeq).toBe(b.maxSeq);
  expect(fingerprint(a).hash).toBe(fingerprint(b).hash);
  expect(hashAllRecords(a)).toBe(hashAllRecords(b));
};

let dir: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaungast-asyncfold-'));
  // Several .ldb so there IS an order to shuffle, and enough that a wrong (arrival-order) fold reorders.
  generateFixtureWithTables(dir, { ldbFileCount: 4 });
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

test('async fold with out-of-order (random-delay) provider === sync loadSnapshotFrom', async () => {
  const baseline = loadSnapshotFrom(memSource());
  const src = memSource();
  // Provider resolves each table after a random delay → completion order differs from fold order. If the
  // loader folded on arrival instead of canonical order, records[] would reorder and this would fail.
  const getTable = (name: string): Promise<TableReadResult> =>
    new Promise((resolve) =>
      setTimeout(() => resolve(parseTable(src.read(name))), Math.floor(Math.random() * 5)),
    );
  const async = await loadSnapshotFromAsync(src, { getTable });
  sameSnapshot(async, baseline);
});

test('async fold with reverse-resolving provider === sync (canonical order, not arrival)', async () => {
  const baseline = loadSnapshotFrom(memSource());
  const src = memSource();
  const names = src.names().filter((n) => n.endsWith('.ldb'));
  const delayFor = (name: string) => (names.length - names.indexOf(name)) * 3; // last file resolves first
  const getTable = (name: string): Promise<TableReadResult> =>
    new Promise((resolve) => setTimeout(() => resolve(parseTable(src.read(name))), delayFor(name)));
  sameSnapshot(await loadSnapshotFromAsync(src, { getTable }), baseline);
});

test('no getTable → inline parse, identical to sync', async () => {
  const baseline = loadSnapshotFrom(memSource());
  sameSnapshot(await loadSnapshotFromAsync(memSource()), baseline);
});

test('provider REJECTION for a middle file → inline fallback, identical to sync', async () => {
  const baseline = loadSnapshotFrom(memSource());
  const src = memSource();
  const names = src.names().filter((n) => n.endsWith('.ldb'));
  const victim = names[Math.floor(names.length / 2)];
  const getTable = (name: string): Promise<TableReadResult> =>
    name === victim
      ? Promise.reject(new Error('worker died'))
      : Promise.resolve(parseTable(src.read(name)));
  sameSnapshot(await loadSnapshotFromAsync(src, { getTable }), baseline);
});

test('provider-returned lossy table marks the load lossy', async () => {
  const src = memSource();
  const names = src.names().filter((n) => n.endsWith('.ldb'));
  const victim = names[0];
  const getTable = (name: string): TableReadResult =>
    name === victim ? { entries: [], lossy: true } : parseTable(src.read(name));
  const snap = await loadSnapshotFromAsync(src, { getTable });
  expect(snap.lossy).toBe(true);
});
