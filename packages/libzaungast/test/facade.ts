// Smoke test for the libzaungast public high-level data facade (store-api.ts, task B2). Builds the
// fully-synthetic .ldb+.log fixture (same generator the G1 golden uses — CI-safe, PII-free) and
// drives every entry point + namespace once to prove the facade wires through to the query layer.
//
// Run:
//   node --conditions=development --experimental-sqlite --import tsx packages/libzaungast/test/facade.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  openStore,
  openLiveStore,
  tryOpen,
  inspect,
} from 'libzaungast/store-api.js';
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

  console.log('\n=== conversations ===');
  const convs = store.conversations.list();
  ok('conversations.list() non-empty', convs.length > 0, `${convs.length}`);
  const someHandle = convs[0]?.handle ?? '';
  const resolved = store.conversations.resolve(someHandle);
  ok('conversations.resolve(handle) resolves', resolved.length > 0, `${someHandle} -> ${resolved}`);

  console.log('\n=== messages ===');
  const searched = store.messages.search({ query: 'lecture' });
  ok('messages.search returns ok', searched.ok === true, JSON.stringify(searched).slice(0, 120));
  if (searched.ok) ok('messages.search has rows', searched.rows.length > 0, `${searched.rows.length}`);
  const firstConv = resolved[0];
  const inConv = store.messages.inConversation(firstConv, { limit: 10 });
  ok('messages.inConversation returns rows', 'rows' in inConv, JSON.stringify(inConv).slice(0, 80));

  console.log('\n=== people ===');
  const ppl = store.people.find();
  ok('people.find() returns rows', ppl.rows.length > 0, `${ppl.mode}/${ppl.rows.length}`);

  console.log('\n=== events / calls ===');
  const events = store.events.list();
  ok('events.list() returns an array', Array.isArray(events), `${events.length}`);
  const calls = store.calls.list();
  ok('calls.list() returns an array', Array.isArray(calls), `${calls.length}`);

  console.log('\n=== topics ===');
  const topics = store.topics.compute({ window: '30d' });
  // rows OR a structured miss — both are valid facade outcomes over a small fixture.
  ok(
    'topics.compute returns rows or ok:false',
    'ok' in topics ? topics.ok === false : Array.isArray(topics.rows),
    JSON.stringify(topics).slice(0, 120),
  );

  console.log('\n=== inspect / tryOpen ===');
  const insp = inspect(dir);
  ok('inspect().schemaMatched is true', insp.schemaMatched === true, JSON.stringify(insp));
  const opened = tryOpen(dir);
  ok('tryOpen returns ok:true', opened.ok === true, JSON.stringify(opened).slice(0, 80));
  if (opened.ok) opened.store.close();

  store.close();

  console.log('\n=== openLiveStore (static dir) ===');
  const live = openLiveStore({ dir });
  ok('live.meta.schemaMatched is true', live.meta.schemaMatched === true);
  ok('live.conversations.list() non-empty', live.conversations.list().length > 0);
  live.refresh();
  ok('live.conversations.list() still non-empty after refresh', live.conversations.list().length > 0);
  live.close();
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
