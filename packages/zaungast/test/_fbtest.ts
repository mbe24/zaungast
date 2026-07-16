// Tests for the feedback-driven features (single ingest, reused store).
import { ingest } from 'libzaungast/ingest/ingest.js';
import { search, topTopics, findPerson, readMessages } from 'zaungast/tools.js';
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

const { store, meta } = ingest(DIR);
const d = false;
const busiest = store.db
  .prepare('select handle from conversations order by msg_count desc limit 1')
  .get() as any;
const botP = store.db
  .prepare("select handle from people where mri like '28:%' order by msg_count desc limit 1")
  .get() as any;

console.log('=== bot classification ===');
{
  const def = topTopics(store, meta, d, { window: '30d', n: 6 });
  const inc = topTopics(store, meta, d, { window: '30d', n: 6, include_bots: true });
  ok('default excludes bots + discloses', /excluded \d+ bot\/app msgs/.test(def));
  ok('include_bots omits the exclusion note', !/excluded \d+ bot/.test(inc));
  const roster = findPerson(store, meta, d, { n: 8 });
  ok('find_person tags a bot [bot]', /\[bot\]/.test(roster));
  ok('find_person tags self (you)', /\(you\)/.test(roster));
}

console.log('=== cache-horizon coverage note ===');
{
  const empty = search(store, meta, d, { in: busiest.handle, since: '-1m', limit: 3 });
  ok('empty since-window shows coverage', /newest cached in this scope/.test(empty));
  ok('coverage claims cache, not "quiet"', !/quiet/i.test(empty));
  const future = search(store, meta, d, { query: 'the', since: '2099-01-01', limit: 3 });
  ok('future window → 0 hits + coverage', /0 hits/.test(future) && /newest cached/.test(future));
}

console.log('=== in: ambiguity note ===');
{
  const gen = store.db
    .prepare("select count(*) n from conversations where topic='General'")
    .get() as any;
  const res = search(store, meta, d, { in: 'General', limit: 2 });
  // only assert the note when the fixture actually has duplicate "General"s
  ok(
    'duplicate in: titles noted',
    gen.n < 2 || /matched \d+ conversations/.test(res),
    `Generals=${gen.n}`,
  );
}

console.log('=== exclude (words + handles) ===');
{
  const excl = topTopics(store, meta, d, { window: '30d', n: 8, exclude: ['token', 'jwt'] });
  ok('excluded words absent from topics', !/"token"|"jwt"/.test(excl));
  if (botP) {
    const s2 = search(store, meta, d, { query: 'the', exclude: [botP.handle], limit: 10 });
    ok('excluded person absent from hits', !s2.includes(botP.handle.replace('p:', '')));
  } else ok('excluded person absent from hits', true, '(no bot person in fixture)');
  ok(
    'bad exclude handle fails loudly',
    /exclude: no (conversation|person)/.test(
      search(store, meta, d, { query: 'x', exclude: ['c:nope'] }),
    ),
  );
}

console.log('=== top_topics since/until + P4 ===');
{
  const r = topTopics(store, meta, d, { since: '-14d', until: '-7d', n: 4 });
  ok('explicit range shows in envelope', /range .+\.\..+/.test(r));
  ok(
    'bad since errors',
    /cannot parse since/.test(topTopics(store, meta, d, { since: 'last week' })),
  );
  ok(
    'P4: nonexistent conversation scope errors',
    /no conversation matches/.test(topTopics(store, meta, d, { scope: 'conversation:zzzznope' })),
  );
}

console.log('=== describe_schema nested labeling ===');
{
  const ds = describeSchema(DIR, { limit: 30 });
  ok('labels the per-entry level', /per messageMap\.\* entry:/.test(ds));
  ok(
    'nested fields include the mapped paths',
    /content/.test(ds) && /imDisplayName/.test(ds) && /originalArrivalTime/.test(ds),
  );
  ok('labels the record level', /record fields:/.test(ds));
}

console.log('=== read_messages header ===');
{
  ok(
    'header shows local cache bounds',
    /local cache .+–.+/.test(
      readMessages(store, meta, d, { conversation: busiest.handle, limit: 2 }),
    ),
  );
}

store.close();
console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
