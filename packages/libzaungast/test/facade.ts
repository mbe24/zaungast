// Smoke test for the libzaungast public high-level data facade (store-api.ts, grown in B3a). Builds
// the fully-synthetic .ldb+.log fixture (same generator the G1 golden uses — CI-safe, PII-free) and
// drives every entry point + namespace once to prove the facade wires through to the query layer,
// including the B3a additions (point lookups, stats/threadSummaries, nameFor/maxStart, the topics
// envelope, tryOpen's honest arms, and the live handle's pinned `current()` reading).
//
// Run:
//   node --conditions=development --experimental-sqlite --import tsx packages/libzaungast/test/facade.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore, openLiveStore, tryOpen, inspect } from 'libzaungast';
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

  console.log('\n=== messages (search / inConversation / get / thread / stats / threadSummaries) ===');
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
    ok('inConversation rows are Message', inConv.rows.every((r) => typeof r.convId === 'string'));
    ok(
      'inConversation booleanizes flags',
      inConv.rows.every((r) => typeof r.isMine === 'boolean' && typeof r.hasAttachment === 'boolean'),
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
    ok('messages.thread returns Message[]', Array.isArray(thread) && thread.length > 0, `${thread.length}`);
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
    Array.isArray(summaries) && summaries.every((s) => typeof s.rootId === 'string' && typeof s.count === 'number'),
    `${summaries.length}`,
  );

  console.log('\n=== people (find / nameFor) ===');
  const ppl = store.people.find();
  ok('people.find() returns rows', ppl.rows.length > 0, `${ppl.mode}/${ppl.rows.length}`);
  ok('PeopleResult.total present', typeof ppl.total === 'number' && ppl.total >= ppl.rows.length, `${ppl.total}`);
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
  ok('topics.compute ok:true or ok:false', typeof topics.ok === 'boolean', JSON.stringify(topics).slice(0, 120));
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

  store.close();

  console.log('\n=== openLiveStore (static dir) — pinned current() reading ===');
  const live = openLiveStore({ dir });
  const reading = live.current();
  ok('current().meta.schemaMatched is true', reading.meta.schemaMatched === true);
  ok('current().mayBeStale is boolean', typeof reading.mayBeStale === 'boolean');
  ok('current().conversations.list() non-empty', reading.conversations.list().length > 0);
  const meta = live.refresh({ full: true });
  ok('refresh({full}) returns meta', meta.schemaMatched === true, JSON.stringify(meta).slice(0, 80));
  ok(
    'current() after refresh still non-empty',
    live.current().conversations.list().length > 0,
  );
  const snap = live.reloadSnapshot();
  ok('reloadSnapshot() returns a Snapshot', snap.buckets.size > 0, `${snap.buckets.size}`);
  live.close();
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exitCode = fail ? 1 : 0;
