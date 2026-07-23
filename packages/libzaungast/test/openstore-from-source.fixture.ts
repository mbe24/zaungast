// B5 capstone: prove the ENTIRE browser stack end-to-end. Build a synthetic fixture dir, then read it
// two ways and assert the query facade returns the same data:
//   Node  : openStore(dir)                     → createJsEngine → node:sqlite
//   Browser: openStoreFromSource(MemorySource) → A5 SnapshotSource decode + A6 bundled mappings +
//            B1/B3 ChatStore + B4 @sqlite.org/sqlite-wasm driver + B5 facade
// node:sqlite and sqlite-wasm are DIFFERENT SQLite builds, so ordering on tied/partial sorts can differ
// (Fable's review): we compare fully-ordered reads directly, sort list/search results by a unique key
// before comparing, strip the wall-clock meta fields, and pass non-binding limits so a tied LIMIT cutoff
// can't select different row SETS. (Runs on the node #bytes codec; codec parity is pinned separately by
// seam-parity + the browser vitest project. @sqlite.org/sqlite-wasm is a devDependency.)
import { test, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../src/store-api.js';
import { openStoreFromSource, type TeamsStore } from '../src/store-facade.js';
import type { StoreMeta } from '../src/ingest/store.js';
import type { SqlDriver } from '../src/ingest/sql-driver.js';
import { MemorySource } from '../src/format/chromium/memory-source.js';
import { createSqliteWasmDriver } from '../examples/sqlite-wasm-driver.js';
import { generateFixture } from './fixture/generate.js';

let dir: string;
let nodeStore: TeamsStore; // openStore(dir) — node:sqlite
let webStore: TeamsStore; // openStoreFromSource — sqlite-wasm

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaungast-b5-'));
  generateFixture(dir);
  const driver: SqlDriver = await createSqliteWasmDriver();
  const files = new Map<string, Uint8Array>();
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isFile()) files.set(name, fs.readFileSync(p));
  }
  nodeStore = openStore(dir);
  webStore = openStoreFromSource(new MemorySource(files), { driver });
});
afterAll(() => {
  nodeStore?.close();
  webStore?.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

// asOf/lastFullAt are Date.now() at build time — strip them; everything else is content-derived.
const stableMeta = (m: StoreMeta) => {
  const { asOf: _a, lastFullAt: _l, ...rest } = m;
  return rest;
};
const byKey = <T>(rows: readonly T[], key: (r: T) => string): T[] =>
  [...rows].sort((a, b) => {
    const ka = key(a),
      kb = key(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

test('meta agrees (modulo wall-clock)', () => {
  expect(stableMeta(webStore.meta)).toEqual(stableMeta(nodeStore.meta));
  // Sanity: the fixture is a known schema, so both actually built a populated store.
  expect(nodeStore.meta.schemaMatched).toBe(true);
  expect(nodeStore.meta.counts.messages).toBeGreaterThan(0);
});

test('conversations.list agrees (sorted by id)', () => {
  const k = (c: { id: string }) => c.id;
  expect(byKey(webStore.conversations.list({ n: 100000 }), k)).toEqual(
    byKey(nodeStore.conversations.list({ n: 100000 }), k),
  );
});

test('messages.inConversation + stats agree per conversation (fully ordered by ts,id)', () => {
  const convs = byKey(nodeStore.conversations.list({ n: 100000 }), (c) => c.id);
  expect(convs.length).toBeGreaterThan(0);
  for (const c of convs) {
    const wn = webStore.messages.inConversation(c.id, { limit: 100000 });
    const nn = nodeStore.messages.inConversation(c.id, { limit: 100000 });
    expect(wn).toEqual(nn); // rows are ordered by (ts,id) → deterministic, deep-equal directly
    expect(webStore.messages.stats(c.id)).toEqual(nodeStore.messages.stats(c.id));
  }
});

test('people.find agrees (rows sorted by mri)', () => {
  const w = webStore.people.find({ n: 25 });
  const n = nodeStore.people.find({ n: 25 });
  expect({ mode: w.mode, query: w.query, total: w.total }).toEqual({
    mode: n.mode,
    query: n.query,
    total: n.total,
  });
  expect(byKey(w.rows, (p) => p.mri)).toEqual(byKey(n.rows, (p) => p.mri));
});

test('events.list + calls.list agree (sorted by id)', () => {
  expect(byKey(webStore.events.list(), (e) => e.id)).toEqual(
    byKey(nodeStore.events.list(), (e) => e.id),
  );
  expect(byKey(webStore.calls.list({ limit: 100000 }), (c) => c.id)).toEqual(
    byKey(nodeStore.calls.list({ limit: 100000 }), (c) => c.id),
  );
});

test('messages.search (FTS) agrees for a real token (hits sorted by id)', () => {
  // Derive a token that actually occurs, so this exercises FTS rather than the empty path.
  const anyConv = nodeStore.conversations.list({ n: 1 })[0];
  const seed = anyConv ? nodeStore.messages.inConversation(anyConv.id, { limit: 20 }) : undefined;
  const token = seed?.ok
    ? seed.rows
        .map((m) => m.content)
        .join(' ')
        .match(/[a-zA-Z]{4,}/)?.[0]
    : undefined;
  const q = token ?? 'the';
  const w = webStore.messages.search({ query: q, limit: 100000 });
  const n = nodeStore.messages.search({ query: q, limit: 100000 });
  expect(w.ok).toBe(n.ok);
  if (w.ok && n.ok) {
    expect(w.order).toBe(n.order);
    expect(byKey(w.rows, (h) => h.id)).toEqual(byKey(n.rows, (h) => h.id));
  }
});
