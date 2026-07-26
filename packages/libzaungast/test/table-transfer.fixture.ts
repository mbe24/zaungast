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
import { test, expect, beforeAll, afterAll } from 'vitest';
import { loadSnapshotFrom } from '../src/format/chromium/indexeddb.js';
import { parseTable } from '../src/format/chromium/sstable.js';
import { MemorySource } from '../src/format/chromium/memory-source.js';
import { fingerprint } from '../src/format/fingerprint.js';
import { packTable, unpackTable, packedTransferList } from '../src/format/table-transfer.js';
import { generateFixtureWithTables } from './fixture/generate.js';
import type { TableEntry, TableReadResult } from '../src/format/types.js';

// A synthetic table with awkward shapes: empty value, 1-byte, multi-byte, full 0..255 byte range.
function syntheticTable(): TableReadResult {
  const entries: TableEntry[] = [
    [new Uint8Array([1, 2, 3]), new Uint8Array(0)], // empty value
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

test('real .ldb packed → cloned → unpacked folds to the identical fingerprint', () => {
  // Compared by fingerprint hash — the frozen wire identity, defined over the entry BYTES. (A deep
  // toEqual would spuriously fail here: this Node test's inline .ldb read yields Buffer entries while
  // unpackTable yields Uint8Array — same bytes, different wrapper. In the browser both sides are
  // Uint8Array, so the distinction can't arise there; the hash is the invariant that actually matters.)
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
  expect(fingerprint(viaPacked).hash).toBe(fingerprint(baseline).hash);
});
