// Smoke test for the libzaungast public high-level data facade (store-api.ts). Builds
// the fully-synthetic .ldb+.log fixture (same generator the fixture golden uses — CI-safe, PII-free) and
// drives every entry point + namespace once to prove the facade wires through to the query layer,
// including the facade additions (point lookups, stats/threadSummaries, nameFor/maxStart, the topics
// envelope, tryOpen's honest arms, and the live handle's pinned `current()` reading).
//
// Run: npx vitest run packages/libzaungast/test/facade.fixture.ts
import { test, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore, openLiveStore, tryOpen, inspect } from 'libzaungast';
import type { IngestEngine } from '../src/ingest/engine.js';
import { createJsEngine } from '../src/ingest/js-engine.js';
import { generateFixtureWithTables } from './fixture/generate.js';

let dir: string;
let store: ReturnType<typeof openStore>;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaungast-facade-'));
  generateFixtureWithTables(dir);
  store = openStore(dir);
});

afterAll(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('openStore + meta', () => {
  expect(store.meta.schemaMatched === true, JSON.stringify(store.meta)).toBe(true);
  expect(store.meta.counts.messages > 0, `${store.meta.counts.messages}`).toBe(true);
  expect(store.meta.counts.conversations > 0, `${store.meta.counts.conversations}`).toBe(true);
});

test('conversations (list / get / resolve)', () => {
  const convs = store.conversations.list();
  expect(convs.length > 0, `${convs.length}`).toBe(true);
  const first = convs[0];
  expect(typeof first?.id === 'string' && first.id.length > 0, first?.id).toBe(true);
  const got = first ? store.conversations.get(first.id) : null;
  expect(got?.id === first?.id, `${got?.id}`).toBe(true);
  const gotByHandle = first ? store.conversations.get(first.handle) : null;
  expect(gotByHandle?.id === first?.id, `${gotByHandle?.id}`).toBe(true);
  expect(
    store.conversations.get('c:does-not-exist') === null,
    'conversations.get(unknown) is null',
  ).toBe(true);
  const resolved = first ? store.conversations.resolve(first.handle) : [];
  expect(
    resolved.length > 0 && resolved[0].id === first?.id,
    `${first?.handle} -> ${resolved.map((r) => r.id).join(',')}`,
  ).toBe(true);
});

test('messages (search / inConversation / get / thread / stats / threadSummaries)', () => {
  const convs = store.conversations.list();
  const first = convs[0];
  const convId = first!.id;

  const searched = store.messages.search({ query: 'lecture' });
  expect(searched.ok === true, JSON.stringify(searched).slice(0, 120)).toBe(true);
  if (searched.ok) {
    expect(searched.rows.length > 0, `${searched.rows.length}`).toBe(true);
    expect(
      typeof searched.rows[0]?.snippet === 'string' && typeof searched.rows[0]?.convId === 'string',
      JSON.stringify(searched.rows[0]).slice(0, 120),
    ).toBe(true);
    expect(searched.order === 'relevance' || searched.order === 'time', searched.order).toBe(true);
  }

  const inConv = store.messages.inConversation(convId, { limit: 10 });
  expect(inConv.ok === true, JSON.stringify(inConv).slice(0, 80)).toBe(true);
  let sampleMsgId = '';
  if (inConv.ok) {
    expect(
      inConv.rows.every((r) => typeof r.convId === 'string'),
      'inConversation rows are Message',
    ).toBe(true);
    expect(
      inConv.rows.every(
        (r) => typeof r.isMine === 'boolean' && typeof r.hasAttachment === 'boolean',
      ),
      'inConversation booleanizes flags',
    ).toBe(true);
    sampleMsgId = inConv.rows[inConv.rows.length - 1]?.id ?? '';
  }
  const missAround = store.messages.inConversation(convId, { around: 'm:not-a-real-id' });
  expect(
    !missAround.ok && missAround.reason.reason === 'no-such-message',
    JSON.stringify(missAround).slice(0, 80),
  ).toBe(true);
  if (sampleMsgId) {
    const one = store.messages.get(convId, sampleMsgId);
    expect(one?.id === sampleMsgId, `${one?.id}`).toBe(true);
    expect(
      store.messages.get(convId, 'nope') === null,
      'messages.get(convId,missing) is null',
    ).toBe(true);
    const thread = store.messages.thread(convId, one!.rootId);
    expect(Array.isArray(thread) && thread.length > 0, `${thread.length}`).toBe(true);
  }
  const stats = store.messages.stats(convId);
  expect(
    typeof stats.total === 'number' && 'earliestTs' in stats && 'newestTs' in stats,
    JSON.stringify(stats),
  ).toBe(true);
  const summaries = store.messages.threadSummaries(convId, {});
  expect(
    Array.isArray(summaries) &&
      summaries.every((s) => typeof s.rootId === 'string' && typeof s.count === 'number'),
    `${summaries.length}`,
  ).toBe(true);
});

// The read_messages `older:` keyset cursor (res.nextOlder) — the one real behavior delta from
// the read-path rewire, validated on real data but not in CI until now. Pins: (a) a full page mid-history
// offers a cursor whose next page continues with no overlap/gap and paging reconstructs the whole
// history; (b) a page that fills exactly at the cache horizon still emits a cursor, and that cursor
// yields an empty page (an acceptable dead cursor — no crash, no further cursor); (c) an `around:`
// read is a centered window, not a paged read, so it emits no cursor.
test('messages.inConversation cursor paging', () => {
  // cursor paging is the FLAT-read behavior → pick the busiest flat conversation.
  const flat = store.conversations
    .list()
    .filter((c) => c.kind === '1:1' || c.kind === 'group' || c.kind === 'meeting')
    .sort((a, b) => b.msgCount - a.msgCount)[0];
  const cid = flat!.id;
  const full = store.messages.inConversation(cid, { limit: 100000 });
  const N = full.ok ? full.rows.length : 0;
  expect(full.ok && N >= 4, `${flat?.kind} N=${N}`).toBe(true);

  if (full.ok && N >= 4) {
    const allIds = full.rows.map((r) => r.id); // oldest→newest
    const L = 2;

    // (a) full page mid-history → cursor → next page continues, no overlap / no gap
    const p1 = store.messages.inConversation(cid, { limit: L });
    expect(p1.ok && p1.rows.length === L, '(a) first page fills to the limit').toBe(true);
    expect(
      p1.ok && typeof p1.nextOlder === 'string',
      '(a) a full page offers a nextOlder cursor',
    ).toBe(true);
    if (p1.ok && p1.nextOlder) {
      const p2 = store.messages.inConversation(cid, { limit: L, cursor: p1.nextOlder });
      expect(p2.ok, '(a) next page returns ok').toBe(true);
      if (p2.ok) {
        const s1 = new Set(p1.rows.map((r) => r.id));
        expect(
          p2.rows.every((r) => !s1.has(r.id)),
          '(a) no overlap between pages',
        ).toBe(true);
        const o = p1.rows[0]; // p1 is oldest→newest, so rows[0] is its oldest
        expect(
          p2.rows.every((r) => r.ts < o.ts || (r.ts === o.ts && r.id < o.id)),
          '(a) next page is entirely older than page 1 (no gap/skip)',
        ).toBe(true);
        // full paging reconstructs the entire history in order, no dup/gap
        const paged: string[] = [];
        let cur: string | undefined;
        for (let guard = 0; guard < 1000; guard++) {
          const pg = store.messages.inConversation(cid, { limit: L, cursor: cur });
          if (!pg.ok) break;
          paged.unshift(...pg.rows.map((r) => r.id)); // older pages prepend
          if (!pg.nextOlder || pg.rows.length === 0) break;
          cur = pg.nextOlder;
        }
        expect(
          JSON.stringify(paged) === JSON.stringify(allIds),
          `(a) paging reconstructs full history (no dup/gap): ${paged.length} vs ${allIds.length}`,
        ).toBe(true);
      }
    }

    // (b) a page filling exactly at the horizon still emits a cursor → that cursor yields empty
    const exact = store.messages.inConversation(cid, { limit: N });
    expect(
      exact.ok && exact.rows.length === N && typeof exact.nextOlder === 'string',
      '(b) exact-horizon full page still offers a (dead) cursor',
    ).toBe(true);
    if (exact.ok && exact.nextOlder) {
      const dead = store.messages.inConversation(cid, { limit: L, cursor: exact.nextOlder });
      expect(
        dead.ok && dead.rows.length === 0,
        '(b) dead cursor yields an empty page (no crash)',
      ).toBe(true);
      expect(
        dead.ok && dead.nextOlder === undefined,
        '(b) dead cursor emits no further cursor',
      ).toBe(true);
    }

    // (c) around: a centered window emits no older cursor
    const mid = full.rows[Math.floor(N / 2)];
    const ar = store.messages.inConversation(cid, { around: `m:${mid.id}`, limit: L });
    expect(ar.ok, '(c) around: read returns ok').toBe(true);
    expect(ar.ok && ar.nextOlder === undefined, '(c) around: emits no nextOlder cursor').toBe(true);
  }
});

test('people (find / nameFor)', () => {
  const ppl = store.people.find();
  expect(ppl.rows.length > 0, `${ppl.mode}/${ppl.rows.length}`).toBe(true);
  expect(typeof ppl.total === 'number' && ppl.total >= ppl.rows.length, `${ppl.total}`).toBe(true);
  expect(typeof ppl.rows[0]?.isBot === 'boolean', 'Person.isBot is boolean').toBe(true);
  const someMri = ppl.rows[0]?.mri ?? '';
  expect(typeof store.people.nameFor(someMri) === 'string', someMri).toBe(true);
  expect(store.people.nameFor('8:orphan:nobody') === null, 'people.nameFor(unknown) is null').toBe(
    true,
  );
});

test('events (list / maxStart) / calls', () => {
  const events = store.events.list();
  expect(Array.isArray(events), `${events.length}`).toBe(true);
  expect(typeof store.events.maxStart() === 'number', 'events.maxStart() returns a number').toBe(
    true,
  );
  const calls = store.calls.list();
  expect(Array.isArray(calls), `${calls.length}`).toBe(true);
});

test('topics (envelope)', () => {
  const topics = store.topics.compute({ window: '30d' });
  expect(typeof topics.ok === 'boolean', JSON.stringify(topics).slice(0, 120)).toBe(true);
  if (topics.ok) {
    expect(
      Array.isArray(topics.rows) &&
        typeof topics.windowCount === 'number' &&
        typeof topics.scopeTotal === 'number' &&
        typeof topics.baseTotal === 'number' &&
        typeof topics.botExcluded === 'number' &&
        typeof topics.window.sinceTs === 'number',
      JSON.stringify(topics).slice(0, 160),
    ).toBe(true);
  }
  const topicsMiss = store.topics.compute({ scope: 'conversation:definitely-no-such-conv' });
  expect(topicsMiss.ok === false, JSON.stringify(topicsMiss).slice(0, 100)).toBe(true);
});

test('inspect / tryOpen', () => {
  const insp = inspect(dir);
  expect(insp.schemaMatched === true, JSON.stringify(insp)).toBe(true);
  const opened = tryOpen(dir);
  expect(opened.ok === true, JSON.stringify(opened).slice(0, 80)).toBe(true);
  if (opened.ok) opened.store.close();
  const bad = tryOpen(path.join(dir, 'no-such-subdir'));
  expect(
    !bad.ok && bad.reason === 'unreadable' && typeof bad.error === 'string',
    JSON.stringify(bad).slice(0, 100),
  ).toBe(true);
});

test('engine injection seam', () => {
  // Omitting `engine` uses the built-in JS engine — that's the `store` opened above. Injecting a
  // custom IngestEngine must be honored: openStore routes the full build through the injected engine,
  // never the internal default. Wrap createJsEngine in a spy so we can prove the call landed and the
  // resulting store is equivalent (libzaungast has no engine of its own to fall back to).
  let injectedFullCalls = 0;
  const inner = createJsEngine();
  const spyEngine: IngestEngine = {
    full: (d, o) => {
      injectedFullCalls++;
      return inner.full(d, o);
    },
    refresh: (p, d) => inner.refresh(p, d),
    reuseRefresh: (p, s) => inner.reuseRefresh!(p, s),
  };
  const injStore = openStore(dir, { engine: spyEngine });
  expect(
    injectedFullCalls === 1 &&
      injStore.meta.counts.messages === store.meta.counts.messages &&
      injStore.meta.counts.conversations === store.meta.counts.conversations,
    `fullCalls=${injectedFullCalls}; ${JSON.stringify(injStore.meta.counts)} vs ${JSON.stringify(store.meta.counts)}`,
  ).toBe(true);
  injStore.close();
});

test('openLiveStore (static dir) — pinned current() reading', () => {
  const live = openLiveStore({ dir });
  const reading = live.current();
  expect(reading.meta.schemaMatched === true, 'current().meta.schemaMatched is true').toBe(true);
  expect(typeof reading.mayBeStale === 'boolean', 'current().mayBeStale is boolean').toBe(true);
  expect(reading.conversations.list().length > 0, 'current().conversations.list() non-empty').toBe(
    true,
  );
  const meta = live.refresh({ full: true });
  expect(meta.schemaMatched === true, JSON.stringify(meta).slice(0, 80)).toBe(true);
  expect(
    live.current().conversations.list().length > 0,
    'current() after refresh still non-empty',
  ).toBe(true);
  const snap = live.reloadSnapshot();
  expect(snap.buckets.size > 0, `${snap.buckets.size}`).toBe(true);
  live.close();
});
