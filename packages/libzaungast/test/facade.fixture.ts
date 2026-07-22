// Smoke test for the libzaungast public high-level data facade (store-api.ts). Builds
// the fully-synthetic .ldb+.log fixture (same generator the fixture golden uses — CI-safe, PII-free) and
// drives every entry point + namespace once to prove the facade wires through to the query layer,
// including the facade additions (point lookups, stats/threadSummaries, nameFor/maxStart, the topics
// envelope, tryOpen's honest arms, and the live handle's pinned `current()` reading).
//
// Run:
//   node --conditions=development --experimental-sqlite --import tsx packages/libzaungast/test/facade.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore, openLiveStore, tryOpen, inspect } from 'libzaungast';
import type { IngestEngine } from '../src/ingest/engine.js';
import { createJsEngine } from '../src/ingest/js-engine.js';
import { generateFixtureWithTables } from './fixture/generate.js';

let pass = 0,
  fail = 0;
const ok = (name: string, cond: boolean, detail = ''): void => {
  if (cond) {
    pass++;
    console.log(`  PASS ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name} ${detail}`);
  }
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaungast-facade-'));
try {
  generateFixtureWithTables(dir);

  console.log('=== openStore + meta ===');
  const store = openStore(dir);
  ok('meta.schemaMatched is true', store.meta.schemaMatched === true, JSON.stringify(store.meta));
  ok('meta.counts.messages > 0', store.meta.counts.messages > 0, `${store.meta.counts.messages}`);
  ok(
    'meta.counts.conversations > 0',
    store.meta.counts.conversations > 0,
    `${store.meta.counts.conversations}`,
  );

  console.log('\n=== conversations (list / get / resolve) ===');
  const convs = store.conversations.list();
  ok('conversations.list() non-empty', convs.length > 0, `${convs.length}`);
  const first = convs[0];
  ok('Conversation carries id', typeof first?.id === 'string' && first.id.length > 0, first?.id);
  const got = first ? store.conversations.get(first.id) : null;
  ok('conversations.get(id) returns the conversation', got?.id === first?.id, `${got?.id}`);
  const gotByHandle = first ? store.conversations.get(first.handle) : null;
  ok('conversations.get(c:handle) resolves', gotByHandle?.id === first?.id, `${gotByHandle?.id}`);
  ok('conversations.get(unknown) is null', store.conversations.get('c:does-not-exist') === null);
  const resolved = first ? store.conversations.resolve(first.handle) : [];
  ok(
    'conversations.resolve(handle) → candidates with display fields',
    resolved.length > 0 && resolved[0].id === first?.id,
    `${first?.handle} -> ${resolved.map((r) => r.id).join(',')}`,
  );

  console.log(
    '\n=== messages (search / inConversation / get / thread / stats / threadSummaries) ===',
  );
  const searched = store.messages.search({ query: 'lecture' });
  ok('messages.search returns ok', searched.ok === true, JSON.stringify(searched).slice(0, 120));
  if (searched.ok) {
    ok('messages.search has hits', searched.rows.length > 0, `${searched.rows.length}`);
    ok(
      'SearchHit is camelCase + snippet',
      typeof searched.rows[0]?.snippet === 'string' && typeof searched.rows[0]?.convId === 'string',
      JSON.stringify(searched.rows[0]).slice(0, 120),
    );
    ok(
      "search order is 'relevance' | 'time'",
      searched.order === 'relevance' || searched.order === 'time',
      searched.order,
    );
  }
  const convId = first!.id;
  const inConv = store.messages.inConversation(convId, { limit: 10 });
  ok('messages.inConversation returns ok', inConv.ok === true, JSON.stringify(inConv).slice(0, 80));
  let sampleMsgId = '';
  if (inConv.ok) {
    ok(
      'inConversation rows are Message',
      inConv.rows.every((r) => typeof r.convId === 'string'),
    );
    ok(
      'inConversation booleanizes flags',
      inConv.rows.every(
        (r) => typeof r.isMine === 'boolean' && typeof r.hasAttachment === 'boolean',
      ),
    );
    sampleMsgId = inConv.rows[inConv.rows.length - 1]?.id ?? '';
  }
  const missAround = store.messages.inConversation(convId, { around: 'm:not-a-real-id' });
  ok(
    'inConversation(around:missing) → no-such-message',
    !missAround.ok && missAround.reason.reason === 'no-such-message',
    JSON.stringify(missAround).slice(0, 80),
  );
  if (sampleMsgId) {
    const one = store.messages.get(convId, sampleMsgId);
    ok('messages.get(convId,id) returns Message', one?.id === sampleMsgId, `${one?.id}`);
    ok('messages.get(convId,missing) is null', store.messages.get(convId, 'nope') === null);
    const thread = store.messages.thread(convId, one!.rootId);
    ok(
      'messages.thread returns Message[]',
      Array.isArray(thread) && thread.length > 0,
      `${thread.length}`,
    );
  }
  const stats = store.messages.stats(convId);
  ok(
    'messages.stats → {total, earliestTs, newestTs}',
    typeof stats.total === 'number' && 'earliestTs' in stats && 'newestTs' in stats,
    JSON.stringify(stats),
  );
  const summaries = store.messages.threadSummaries(convId, {});
  ok(
    'messages.threadSummaries → ThreadSummary[]',
    Array.isArray(summaries) &&
      summaries.every((s) => typeof s.rootId === 'string' && typeof s.count === 'number'),
    `${summaries.length}`,
  );

  // The read_messages `older:` keyset cursor (res.nextOlder) — the one real behavior delta from
  // the read-path rewire, validated on real data but not in CI until now. Pins: (a) a full page mid-history
  // offers a cursor whose next page continues with no overlap/gap and paging reconstructs the whole
  // history; (b) a page that fills exactly at the cache horizon still emits a cursor, and that cursor
  // yields an empty page (an acceptable dead cursor — no crash, no further cursor); (c) an `around:`
  // read is a centered window, not a paged read, so it emits no cursor.
  console.log('\n=== messages.inConversation cursor paging ===');
  {
    // cursor paging is the FLAT-read behavior → pick the busiest flat conversation.
    const flat = store.conversations
      .list()
      .filter((c) => c.kind === '1:1' || c.kind === 'group' || c.kind === 'meeting')
      .sort((a, b) => b.msgCount - a.msgCount)[0];
    const cid = flat!.id;
    const full = store.messages.inConversation(cid, { limit: 100000 });
    const N = full.ok ? full.rows.length : 0;
    ok(
      `precondition: a flat conversation with ≥4 messages`,
      full.ok && N >= 4,
      `${flat?.kind} N=${N}`,
    );

    if (full.ok && N >= 4) {
      const allIds = full.rows.map((r) => r.id); // oldest→newest
      const L = 2;

      // (a) full page mid-history → cursor → next page continues, no overlap / no gap
      const p1 = store.messages.inConversation(cid, { limit: L });
      ok('(a) first page fills to the limit', p1.ok && p1.rows.length === L);
      ok('(a) a full page offers a nextOlder cursor', p1.ok && typeof p1.nextOlder === 'string');
      if (p1.ok && p1.nextOlder) {
        const p2 = store.messages.inConversation(cid, { limit: L, cursor: p1.nextOlder });
        ok('(a) next page returns ok', p2.ok);
        if (p2.ok) {
          const s1 = new Set(p1.rows.map((r) => r.id));
          ok(
            '(a) no overlap between pages',
            p2.rows.every((r) => !s1.has(r.id)),
          );
          const o = p1.rows[0]; // p1 is oldest→newest, so rows[0] is its oldest
          ok(
            '(a) next page is entirely older than page 1 (no gap/skip)',
            p2.rows.every((r) => r.ts < o.ts || (r.ts === o.ts && r.id < o.id)),
          );
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
          ok(
            '(a) paging reconstructs full history (no dup/gap)',
            JSON.stringify(paged) === JSON.stringify(allIds),
            `${paged.length} vs ${allIds.length}`,
          );
        }
      }

      // (b) a page filling exactly at the horizon still emits a cursor → that cursor yields empty
      const exact = store.messages.inConversation(cid, { limit: N });
      ok(
        '(b) exact-horizon full page still offers a (dead) cursor',
        exact.ok && exact.rows.length === N && typeof exact.nextOlder === 'string',
      );
      if (exact.ok && exact.nextOlder) {
        const dead = store.messages.inConversation(cid, { limit: L, cursor: exact.nextOlder });
        ok('(b) dead cursor yields an empty page (no crash)', dead.ok && dead.rows.length === 0);
        ok('(b) dead cursor emits no further cursor', dead.ok && dead.nextOlder === undefined);
      }

      // (c) around: a centered window emits no older cursor
      const mid = full.rows[Math.floor(N / 2)];
      const ar = store.messages.inConversation(cid, { around: `m:${mid.id}`, limit: L });
      ok('(c) around: read returns ok', ar.ok);
      ok('(c) around: emits no nextOlder cursor', ar.ok && ar.nextOlder === undefined);
    }
  }

  console.log('\n=== people (find / nameFor) ===');
  const ppl = store.people.find();
  ok('people.find() returns rows', ppl.rows.length > 0, `${ppl.mode}/${ppl.rows.length}`);
  ok(
    'PeopleResult.total present',
    typeof ppl.total === 'number' && ppl.total >= ppl.rows.length,
    `${ppl.total}`,
  );
  ok('Person.isBot is boolean', typeof ppl.rows[0]?.isBot === 'boolean');
  const someMri = ppl.rows[0]?.mri ?? '';
  ok('people.nameFor(mri) resolves', typeof store.people.nameFor(someMri) === 'string', someMri);
  ok('people.nameFor(unknown) is null', store.people.nameFor('8:orphan:nobody') === null);

  console.log('\n=== events (list / maxStart) / calls ===');
  const events = store.events.list();
  ok('events.list() returns an array', Array.isArray(events), `${events.length}`);
  ok('events.maxStart() returns a number', typeof store.events.maxStart() === 'number');
  const calls = store.calls.list();
  ok('calls.list() returns an array', Array.isArray(calls), `${calls.length}`);

  console.log('\n=== topics (envelope) ===');
  const topics = store.topics.compute({ window: '30d' });
  ok(
    'topics.compute ok:true or ok:false',
    typeof topics.ok === 'boolean',
    JSON.stringify(topics).slice(0, 120),
  );
  if (topics.ok) {
    ok(
      'topics envelope carries the renderer facts',
      Array.isArray(topics.rows) &&
        typeof topics.windowCount === 'number' &&
        typeof topics.scopeTotal === 'number' &&
        typeof topics.baseTotal === 'number' &&
        typeof topics.botExcluded === 'number' &&
        typeof topics.window.sinceTs === 'number',
      JSON.stringify(topics).slice(0, 160),
    );
  }
  const topicsMiss = store.topics.compute({ scope: 'conversation:definitely-no-such-conv' });
  ok(
    'topics scope miss → ok:false',
    topicsMiss.ok === false,
    JSON.stringify(topicsMiss).slice(0, 100),
  );

  console.log('\n=== inspect / tryOpen ===');
  const insp = inspect(dir);
  ok('inspect().schemaMatched is true', insp.schemaMatched === true, JSON.stringify(insp));
  const opened = tryOpen(dir);
  ok('tryOpen returns ok:true', opened.ok === true, JSON.stringify(opened).slice(0, 80));
  if (opened.ok) opened.store.close();
  const bad = tryOpen(path.join(dir, 'no-such-subdir'));
  ok(
    'tryOpen(bad dir) → unreadable with error string',
    !bad.ok && bad.reason === 'unreadable' && typeof bad.error === 'string',
    JSON.stringify(bad).slice(0, 100),
  );

  console.log('\n=== engine injection seam ===');
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
  ok(
    'injected engine.full drives openStore (equivalent store)',
    injectedFullCalls === 1 &&
      injStore.meta.counts.messages === store.meta.counts.messages &&
      injStore.meta.counts.conversations === store.meta.counts.conversations,
    `fullCalls=${injectedFullCalls}; ${JSON.stringify(injStore.meta.counts)} vs ${JSON.stringify(store.meta.counts)}`,
  );
  injStore.close();

  store.close();

  console.log('\n=== openLiveStore (static dir) — pinned current() reading ===');
  const live = openLiveStore({ dir });
  const reading = live.current();
  ok('current().meta.schemaMatched is true', reading.meta.schemaMatched === true);
  ok('current().mayBeStale is boolean', typeof reading.mayBeStale === 'boolean');
  ok('current().conversations.list() non-empty', reading.conversations.list().length > 0);
  const meta = live.refresh({ full: true });
  ok(
    'refresh({full}) returns meta',
    meta.schemaMatched === true,
    JSON.stringify(meta).slice(0, 80),
  );
  ok('current() after refresh still non-empty', live.current().conversations.list().length > 0);
  const snap = live.reloadSnapshot();
  ok('reloadSnapshot() returns a Snapshot', snap.buckets.size > 0, `${snap.buckets.size}`);
  live.close();
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exitCode = fail ? 1 : 0;
