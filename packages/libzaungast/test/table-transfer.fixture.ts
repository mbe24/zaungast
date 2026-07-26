// M4a (packed parse transfer): packTable → (worker boundary) → unpackTable must rebuild a BYTE-IDENTICAL
// TableReadResult, so a parse-worker pool that ships 3 transferables per table instead of N tiny per-entry
// buffers folds to the exact same Snapshot. structuredClone models the postMessage serialization (minus
// the transfer-list move, which only skips the copy — it can't change bytes).
//
// The codec core is proven on SYNTHETIC entries (deterministic edge cases: empty values, varied lengths,
// full byte range) so it doesn't hinge on fixture internals; the end-to-end fold equality uses a fixture
// WITH real .ldb tables (generateFixtureWithTables — the default WAL-only fixture has none to pack).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { test, expect, beforeAll, afterAll } from 'vitest';
import { loadSnapshotFrom } from '../src/format/chromium/indexeddb.js';
import { parseTable } from '../src/format/chromium/sstable.js';
import { MemorySource } from '../src/format/chromium/memory-source.js';
import {
  packTable,
  unpackTable,
  packedTransferList,
  packRecords,
  unpackRecords,
  packedRecordsTransferList,
} from '../src/format/table-transfer.js';
import { generateFixtureWithTables } from './fixture/generate.js';
import type { Snapshot, SnapshotRecord } from '../src/format/types.js';
import type { TableEntry, TableReadResult } from '../src/format/types.js';

// Hash EVERY record's exact key+value bytes across all buckets (not the schema fingerprint, which only
// samples 5 records/bucket + field keys). This is what actually proves the fold saw byte-identical
// entries — it catches value corruption past the 5th record, and dropped/duplicated/reordered records.
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

// A synthetic table with awkward shapes: empty value, empty KEY, 1-byte, multi-byte, full 0..255 range.
function syntheticTable(): TableReadResult {
  const entries: TableEntry[] = [
    [new Uint8Array([1, 2, 3]), new Uint8Array(0)], // empty value
    [new Uint8Array(0), new Uint8Array([42])], // empty key
    [new Uint8Array([0]), new Uint8Array([255])],
    [
      Uint8Array.from({ length: 256 }, (_, b) => b),
      Uint8Array.from({ length: 256 }, (_, b) => 255 - b),
    ],
    [new Uint8Array([9]), new Uint8Array([8, 7, 6, 5])],
  ];
  return { entries, lossy: false };
}

test('packTable → unpackTable round-trips entries byte-identically', () => {
  const original = syntheticTable();
  const round = unpackTable(packTable(original));
  expect(round.lossy).toBe(original.lossy);
  expect(round.entries.length).toBe(original.entries.length);
  for (let e = 0; e < original.entries.length; e++) {
    expect(round.entries[e][0]).toEqual(original.entries[e][0]); // key bytes
    expect(round.entries[e][1]).toEqual(original.entries[e][1]); // value bytes
  }
});

test('packed table survives structuredClone (the worker hop) → still byte-identical', () => {
  const original = syntheticTable();
  const round = unpackTable(structuredClone(packTable(original)));
  for (let e = 0; e < original.entries.length; e++) {
    expect(round.entries[e][0]).toEqual(original.entries[e][0]);
    expect(round.entries[e][1]).toEqual(original.entries[e][1]);
  }
});

test('packedTransferList is exactly the 3 backing buffers (keys, vals, lens)', () => {
  const p = packTable(syntheticTable());
  const list = packedTransferList(p);
  expect(list).toHaveLength(3);
  expect(list[0]).toBe(p.keys);
  expect(list[1]).toBe(p.vals);
  expect(list[2]).toBe(p.lens.buffer);
  for (const b of list) expect(b).toBeInstanceOf(ArrayBuffer);
});

test('empty/lossy table packs and unpacks cleanly', () => {
  const round = unpackTable(packTable({ entries: [], lossy: true }));
  expect(round.entries).toHaveLength(0);
  expect(round.lossy).toBe(true);
});

// ── Extract-transport codec (packRecords/unpackRecords) ─────────────────────────────────────────
// A synthetic record range with the shapes recordsToRows must survive: a NULL value (tombstone), an
// EMPTY (0-length) value distinct from null, an empty key, and the full 0..255 byte range in both.
function syntheticRecords(): SnapshotRecord[] {
  return [
    { seq: 5, type: 1, key: new Uint8Array([1, 2, 3]), value: null }, // tombstone
    { seq: 6, type: 2, key: new Uint8Array([1, 2, 3]), value: new Uint8Array(0) }, // empty value ≠ null
    { seq: 7, type: 0, key: new Uint8Array(0), value: new Uint8Array([42]) }, // empty key
    {
      seq: 8,
      type: 3,
      key: Uint8Array.from({ length: 256 }, (_, b) => b),
      value: Uint8Array.from({ length: 256 }, (_, b) => 255 - b),
    },
  ];
}

// key/value bytes must round-trip exactly; a null value must stay null and an empty value must stay a
// 0-length Uint8Array (never collapse to null) — the two decode differently downstream.
function expectSameRecordBytes(round: SnapshotRecord[], original: SnapshotRecord[]) {
  expect(round.length).toBe(original.length);
  for (let i = 0; i < original.length; i++) {
    expect([...round[i].key]).toEqual([...original[i].key]);
    if (original[i].value === null) expect(round[i].value).toBeNull();
    else {
      expect(round[i].value).not.toBeNull();
      expect([...round[i].value!]).toEqual([...original[i].value!]);
    }
  }
}

test('packRecords → unpackRecords round-trips key/value bytes (null ≠ empty)', () => {
  expectSameRecordBytes(unpackRecords(packRecords(syntheticRecords())), syntheticRecords());
});

test('packed records survive structuredClone (the extract worker hop)', () => {
  expectSameRecordBytes(
    unpackRecords(structuredClone(packRecords(syntheticRecords()))),
    syntheticRecords(),
  );
});

test('packedRecordsTransferList is exactly the 3 backing buffers (keys, vals, lens)', () => {
  const p = packRecords(syntheticRecords());
  const list = packedRecordsTransferList(p);
  expect(list).toHaveLength(3);
  expect(list[0]).toBe(p.keys);
  expect(list[1]).toBe(p.vals);
  expect(list[2]).toBe(p.lens.buffer);
  for (const b of list) expect(b).toBeInstanceOf(ArrayBuffer);
});

test('empty record range packs and unpacks cleanly', () => {
  expect(unpackRecords(packRecords([]))).toHaveLength(0);
});

// End-to-end: real .ldb, packed+cloned+unpacked, must fold to the identical Snapshot + fingerprint.
let dir: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaungast-transfer-'));
  generateFixtureWithTables(dir, { ldbFileCount: 3 });
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function memSourceFrom(): MemorySource {
  const files = new Map<string, Uint8Array>();
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isFile()) files.set(name, fs.readFileSync(p));
  }
  return new MemorySource(files);
}

test('real .ldb packed → cloned → unpacked folds to identical record bytes (all records)', () => {
  // Compared by hashing EVERY record's key+value bytes (see hashAllRecords) — a full byte-identity
  // proof, not the schema fingerprint (which only samples 5 records/bucket and would miss value
  // corruption past the 5th record). A deep toEqual can't be used: this Node test's inline .ldb read
  // yields Buffer entries while unpackTable yields Uint8Array — same bytes, different wrapper; in the
  // browser both sides are Uint8Array, so the distinction can't arise there anyway.
  const baseline = loadSnapshotFrom(memSourceFrom());
  const src = memSourceFrom();
  const ldb = src.names().filter((n) => n.endsWith('.ldb'));
  expect(ldb.length).toBeGreaterThan(0); // guard: the fixture really produced tables to pack
  const parsed = new Map<string, TableReadResult>();
  for (const name of ldb) {
    const cloned = structuredClone(packTable(parseTable(src.read(name)))); // worker→coordinator hop
    parsed.set(name, unpackTable(cloned));
  }
  const viaPacked = loadSnapshotFrom(src, { parsedTables: parsed });
  expect(viaPacked.buckets.size).toBe(baseline.buckets.size);
  expect(hashAllRecords(viaPacked)).toBe(hashAllRecords(baseline));
});
