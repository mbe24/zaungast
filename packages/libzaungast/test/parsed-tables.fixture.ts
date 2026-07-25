// C1 (parallel-ingest seam): loadSnapshotFrom with injected pre-parsed `.ldb` tables (`parsedTables`)
// must yield a BYTE-IDENTICAL Snapshot to the inline read+parse path — the invariant the browser
// parse-worker pool relies on. A worker parses each `.ldb` (parseTable) off-thread; the coordinator folds
// the results here. Covers: full pre-parse, a partial map (missing entries fall back to inline parse),
// and fingerprint-hash equality (the frozen wire identity).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect, beforeAll, afterAll } from 'vitest';
import { loadSnapshotFrom } from '../src/format/chromium/indexeddb.js';
import { parseTable } from '../src/format/chromium/sstable.js';
import { MemorySource } from '../src/format/chromium/memory-source.js';
import { fingerprint } from '../src/format/fingerprint.js';
import { generateFixture } from './fixture/generate.js';
import type { TableReadResult } from '../src/format/types.js';

let dir: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaungast-parsed-'));
  generateFixture(dir);
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

// What a parse-worker pool produces: every `.ldb` pre-parsed by filename.
function parseAllLdb(src: MemorySource): Map<string, TableReadResult> {
  const m = new Map<string, TableReadResult>();
  for (const name of src.names())
    if (name.endsWith('.ldb')) m.set(name, parseTable(src.read(name)));
  return m;
}

test('parsedTables (full pre-parse) yields a byte-identical Snapshot', () => {
  const baseline = loadSnapshotFrom(memSourceFrom());
  const src = memSourceFrom();
  const viaParsed = loadSnapshotFrom(src, { parsedTables: parseAllLdb(src) });
  expect(viaParsed).toEqual(baseline);
  expect(fingerprint(viaParsed).hash).toBe(fingerprint(baseline).hash);
});

test('parsedTables (partial map) falls back to inline parse for misses — still byte-identical', () => {
  const baseline = loadSnapshotFrom(memSourceFrom());
  const src = memSourceFrom();
  const all = [...parseAllLdb(src)];
  const partial = new Map(all.filter((_, i) => i % 2 === 0)); // half injected, half fall back
  const viaPartial = loadSnapshotFrom(src, { parsedTables: partial });
  expect(viaPartial).toEqual(baseline);
  expect(fingerprint(viaPartial).hash).toBe(fingerprint(baseline).hash);
});

test('parsedTables omitted is exactly the inline path (unchanged default)', () => {
  const baseline = loadSnapshotFrom(memSourceFrom());
  const viaEmpty = loadSnapshotFrom(memSourceFrom(), { parsedTables: new Map() });
  expect(viaEmpty).toEqual(baseline);
});

test('parsedTables survives structuredClone (the worker boundary) — byte-identical', () => {
  // structuredClone is exactly the serialization a postMessage from a parse worker performs (minus
  // transfer): entry views become copies over fresh buffers. Proves worker-parsed tables fold identically.
  const baseline = loadSnapshotFrom(memSourceFrom());
  const src = memSourceFrom();
  const cloned = structuredClone(parseAllLdb(src));
  const viaCloned = loadSnapshotFrom(src, { parsedTables: cloned });
  expect(viaCloned).toEqual(baseline);
  expect(fingerprint(viaCloned).hash).toBe(fingerprint(baseline).hash);
});
