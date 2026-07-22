// Tests for the feedback-driven features, driven through the libzaungast facade (openStore) + the
// MCP renderers. Runs against ZAUNGAST_TEST_DIR (real cache) when set, else a synthetic fixture.
import { test, expect, beforeAll, afterAll } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { resolveLevelDbDir } from '../../../scripts/native-runner.mjs';
import { generateFixtureWithTables } from '../../libzaungast/test/fixture/generate.js';
import { openStore, type TeamsStore } from 'libzaungast';
import { loadSnapshot } from 'libzaungast/format';
import { search, rankTopics, findPerson, readConversation } from 'zaungast/tools.js';
import { describeSchema } from 'zaungast/tools/describeSchema.js';

let dir: string;
let synthetic = false;
let store: TeamsStore;
// most-recent conversation (facade lists newest-first) — a stand-in for "a busy conversation".
let busiest: ReturnType<TeamsStore['conversations']['list']>[number];
// the highest-volume bot among the roster (find() is volume-ranked).
let botP: ReturnType<TeamsStore['people']['find']>['rows'][number] | undefined;

beforeAll(() => {
  const real = resolveLevelDbDir(process.env.ZAUNGAST_TEST_DIR);
  if (real) {
    dir = real;
  } else {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaungast-fb-'));
    generateFixtureWithTables(dir);
    synthetic = true;
  }
  store = openStore(dir);
  busiest = store.conversations.list({ n: 1 })[0];
  botP = store.people.find({ n: 25 }).rows.find((p) => p.isBot);
});

afterAll(() => {
  store.close();
  if (synthetic) fs.rmSync(dir, { recursive: true, force: true });
});

test('bot classification', () => {
  const def = rankTopics(store, { window: '30d', n: 6 });
  const inc = rankTopics(store, { window: '30d', n: 6, include_bots: true });
  expect(/excluded \d+ bot\/app msgs/.test(def), 'default excludes bots + discloses').toBe(true);
  expect(!/excluded \d+ bot/.test(inc), 'include_bots omits the exclusion note').toBe(true);
  const roster = findPerson(store, { n: 8 });
  expect(/\[bot\]/.test(roster), 'find_person tags a bot [bot]').toBe(true);
  expect(/\(you\)/.test(roster), 'find_person tags self (you)').toBe(true);
});

test('cache-horizon coverage note', () => {
  const empty = search(store, { in: busiest.handle, since: '-1m', limit: 3 });
  expect(/newest cached in this scope/.test(empty), 'empty since-window shows coverage').toBe(true);
  expect(!/quiet/i.test(empty), 'coverage claims cache, not "quiet"').toBe(true);
  const future = search(store, { query: 'the', since: '2099-01-01', limit: 3 });
  expect(
    /0 hits/.test(future) && /newest cached/.test(future),
    'future window → 0 hits + coverage',
  ).toBe(true);
});

test('in: ambiguity note', () => {
  const genCount = store.conversations
    .list({ query: 'General', n: 1000 })
    .filter((c) => c.topic === 'General').length;
  const res = search(store, { in: 'General', limit: 2 });
  // only assert the note when the fixture actually has duplicate "General"s
  expect(
    genCount < 2 || /matched \d+ conversations/.test(res),
    `duplicate in: titles noted Generals=${genCount}`,
  ).toBe(true);
});

test('exclude (words + handles)', () => {
  const excl = rankTopics(store, { window: '30d', n: 8, exclude: ['token', 'jwt'] });
  expect(!/"token"|"jwt"/.test(excl), 'excluded words absent from topics').toBe(true);
  if (botP) {
    const s2 = search(store, { query: 'the', exclude: [botP.handle], limit: 10 });
    expect(!s2.includes(botP.handle.replace('p:', '')), 'excluded person absent from hits').toBe(
      true,
    );
  } else {
    expect(true, 'excluded person absent from hits (no bot person in fixture)').toBe(true);
  }
  expect(
    /exclude: no (conversation|person)/.test(search(store, { query: 'x', exclude: ['c:nope'] })),
    'bad exclude handle fails loudly',
  ).toBe(true);
});

test('rank_topics since/until + scope errors', () => {
  const r = rankTopics(store, { since: '-14d', until: '-7d', n: 4 });
  expect(/range .+\.\..+/.test(r), 'explicit range shows in envelope').toBe(true);
  expect(
    /cannot parse since/.test(rankTopics(store, { since: 'last week' })),
    'bad since errors',
  ).toBe(true);
  expect(
    /no conversation matches/.test(rankTopics(store, { scope: 'conversation:zzzznope' })),
    'nonexistent conversation scope errors',
  ).toBe(true);
});

test('describe_schema nested labeling', () => {
  const ds = describeSchema(loadSnapshot(dir), { limit: 30 });
  expect(/per messageMap\.\* entry:/.test(ds), 'labels the per-entry level').toBe(true);
  expect(
    /content/.test(ds) && /imDisplayName/.test(ds) && /originalArrivalTime/.test(ds),
    'nested fields include the mapped paths',
  ).toBe(true);
  expect(/record fields:/.test(ds), 'labels the record level').toBe(true);
});

test('read_conversation header', () => {
  expect(
    /local cache .+–.+/.test(readConversation(store, { conversation: busiest.handle, limit: 2 })),
    'header shows local cache bounds',
  ).toBe(true);
});
