// Tests for the feedback-driven features, driven through the libzaungast facade (openStore) + the
// MCP renderers. Real-data smoke test (ZAUNGAST_TEST_DIR).
import { openStore } from 'libzaungast';
import { loadSnapshot } from 'libzaungast/format';
import { search, rankTopics, findPerson, readConversation } from 'zaungast/tools.js';
import { describeSchema } from 'zaungast/tools/describeSchema.js';

const DIR = process.argv[2] ?? process.env.ZAUNGAST_TEST_DIR;
if (!DIR) {
  console.error('Set ZAUNGAST_TEST_DIR or pass a leveldb dir as argv[2]');
  process.exit(1);
}
let pass = 0,
  fail = 0;
const ok = (n: string, c: boolean, d = '') => {
  if (c) {
    pass++;
    console.log(`  PASS ${n}`);
  } else {
    fail++;
    console.log(`  FAIL ${n} ${d}`);
  }
};

const store = openStore(DIR);
// most-recent conversation (facade lists newest-first) — a stand-in for "a busy conversation".
const busiest = store.conversations.list({ n: 1 })[0];
// the highest-volume bot among the roster (find() is volume-ranked).
const botP = store.people.find({ n: 25 }).rows.find((p) => p.isBot);

console.log('=== bot classification ===');
{
  const def = rankTopics(store, { window: '30d', n: 6 });
  const inc = rankTopics(store, { window: '30d', n: 6, include_bots: true });
  ok('default excludes bots + discloses', /excluded \d+ bot\/app msgs/.test(def));
  ok('include_bots omits the exclusion note', !/excluded \d+ bot/.test(inc));
  const roster = findPerson(store, { n: 8 });
  ok('find_person tags a bot [bot]', /\[bot\]/.test(roster));
  ok('find_person tags self (you)', /\(you\)/.test(roster));
}

console.log('=== cache-horizon coverage note ===');
{
  const empty = search(store, { in: busiest.handle, since: '-1m', limit: 3 });
  ok('empty since-window shows coverage', /newest cached in this scope/.test(empty));
  ok('coverage claims cache, not "quiet"', !/quiet/i.test(empty));
  const future = search(store, { query: 'the', since: '2099-01-01', limit: 3 });
  ok('future window → 0 hits + coverage', /0 hits/.test(future) && /newest cached/.test(future));
}

console.log('=== in: ambiguity note ===');
{
  const genCount = store.conversations
    .list({ query: 'General', n: 1000 })
    .filter((c) => c.topic === 'General').length;
  const res = search(store, { in: 'General', limit: 2 });
  // only assert the note when the fixture actually has duplicate "General"s
  ok(
    'duplicate in: titles noted',
    genCount < 2 || /matched \d+ conversations/.test(res),
    `Generals=${genCount}`,
  );
}

console.log('=== exclude (words + handles) ===');
{
  const excl = rankTopics(store, { window: '30d', n: 8, exclude: ['token', 'jwt'] });
  ok('excluded words absent from topics', !/"token"|"jwt"/.test(excl));
  if (botP) {
    const s2 = search(store, { query: 'the', exclude: [botP.handle], limit: 10 });
    ok('excluded person absent from hits', !s2.includes(botP.handle.replace('p:', '')));
  } else ok('excluded person absent from hits', true, '(no bot person in fixture)');
  ok(
    'bad exclude handle fails loudly',
    /exclude: no (conversation|person)/.test(search(store, { query: 'x', exclude: ['c:nope'] })),
  );
}

console.log('=== rank_topics since/until + P4 ===');
{
  const r = rankTopics(store, { since: '-14d', until: '-7d', n: 4 });
  ok('explicit range shows in envelope', /range .+\.\..+/.test(r));
  ok('bad since errors', /cannot parse since/.test(rankTopics(store, { since: 'last week' })));
  ok(
    'P4: nonexistent conversation scope errors',
    /no conversation matches/.test(rankTopics(store, { scope: 'conversation:zzzznope' })),
  );
}

console.log('=== describe_schema nested labeling ===');
{
  const ds = describeSchema(loadSnapshot(DIR), { limit: 30 });
  ok('labels the per-entry level', /per messageMap\.\* entry:/.test(ds));
  ok(
    'nested fields include the mapped paths',
    /content/.test(ds) && /imDisplayName/.test(ds) && /originalArrivalTime/.test(ds),
  );
  ok('labels the record level', /record fields:/.test(ds));
}

console.log('=== read_conversation header ===');
{
  ok(
    'header shows local cache bounds',
    /local cache .+–.+/.test(readConversation(store, { conversation: busiest.handle, limit: 2 })),
  );
}

store.close();
console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
