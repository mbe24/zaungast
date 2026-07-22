// MCP tool-surface regression test. Generates the synthetic fixture into a temp dir, opens it via
// the PUBLIC libzaungast facade (`openStore`), and smoke-tests the whole zaungast MCP tool surface
// (search / list_conversations / rank_topics / find_person / read_conversation / read_thread /
// get_message / list_events /
// list_calls) against it — reaction rendering, the (you) identity label, channel reply-chain
// rendering, and the list_events / list_calls render contracts. Runs in CI with no real Teams cache
// (no PII). Sets a non-zero exit code on any failure.
//
// The library-internals half (byte codecs, extractEntity/ingest counts, chain_key, decode
// round-trips) lives in packages/libzaungast/test/fixture-verify.ts — this file deliberately does
// not duplicate it, and reaches the store only through the facade + the MCP tools.
//
// Run: npx vitest run packages/zaungast/test/fixture-verify.fixture.ts
import { test, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from 'libzaungast';
import {
  search,
  listConversations,
  rankTopics,
  findPerson,
  readConversation,
  readThread,
  getMessage,
  listEvents,
  listCalls,
} from 'zaungast/tools.js';
import { selectEngine } from 'zaungast/engine.js';
import { generateFixture } from '../../libzaungast/test/fixture/generate.js';
import { CONVERSATIONS } from '../../libzaungast/test/fixture/data.js';

let dir: string;
let store: ReturnType<typeof openStore>;
// Shared across sections (mirrors the original script's top-to-bottom variable reuse):
// `multi` is computed once and re-asserted on in the identity-label section; the two chat handles
// are looked up once and re-used by the list_calls assertions further down.
let multi: string;
let studyGroupHandle: string;
let midtermHandle: string;

// Find the conversation that CONTAINS a message matching `contentLike` (the facade equivalent of the
// old raw `... from messages where content like ?`), then render it whole through the read_conversation
// tool. `messages.search` returns SearchHits carrying `convId`; `conversations.get` maps id→handle.
const renderConv = (contentLike: string, opts: { reactions?: 'full' } = {}): string => {
  const res = store.messages.search({ query: contentLike, limit: 20 });
  const hit = res.ok
    ? res.rows.find((r) => r.content.toLowerCase().includes(contentLike.toLowerCase()))
    : undefined;
  const c = hit ? store.conversations.get(hit.convId) : null;
  return readConversation(store, { conversation: c!.handle, limit: 60, ...opts });
};

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaungast-fixture-'));
  generateFixture(dir);
  console.log(`generated fixture at ${dir}`);

  // A static `openStore` store is a valid tool View: the six query namespaces + the build's `meta`,
  // with `mayBeStale` absent → renders as not-stale (identical to the old deferred=false path).
  // Engine honors ZAUNGAST_ENGINE (native.yml runs this on the native engine, must equal JS output).
  const { engine } = await selectEngine();
  store = openStore(dir, { engine });

  multi = renderConv('study group');
  studyGroupHandle = store.conversations.get('19:f1e2d3c4b5a6@thread.v2')!.handle;
  midtermHandle = store.conversations.get('19:meeting_998877@thread.v2')!.handle;
});

afterAll(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('end-to-end: ingest() + ChatStore + search', () => {
  const results = search(store, { query: 'memoization', limit: 5 });
  expect(/memoization/i.test(results), results.slice(0, 200)).toBe(true);
});

test('tool surface (list / rank_topics / find_person)', () => {
  const list = listConversations(store, {});
  expect(/CS101|study-group|Algorithms/i.test(list), list.slice(0, 200)).toBe(true);
  const topics = rankTopics(store, {});
  expect(topics.trim().length > 0, 'rank_topics returns non-empty output').toBe(true);
  const person = findPerson(store, { query: 'Ada Lovelace' });
  expect(/Ada Lovelace/i.test(person), person.slice(0, 200)).toBe(true);
});

// reactions RENDERED by read_messages: glyph mapping, two-level cap, you-first, and the
// crucial end-to-end guarantee — a profiles-only reactor (never posted) resolves to a NAME in the
// actual tool output, not just in the decoded record.
test('reactions (read_conversation rendering)', () => {
  const single = renderConv('Haha fitting');
  expect(/👍 1 · Alan Turing/.test(single), single).toBe(true);

  expect(/❤️/.test(multi), 'multi-emoji: heart glyph rendered').toBe(true);
  expect(/🎉/.test(multi), 'multi-emoji: codepoint key 1f389_partypopper → 🎉').toBe(true);
  expect(/😮/.test(multi), 'multi-emoji: surprised → 😮').toBe(true);
  expect(/Margaret Hamilton/.test(multi), multi).toBe(true);

  const many = renderConv('Assignment 4 is due');
  expect(/😂 5 · you/.test(many), many).toBe(true);
  expect(/😂 5 · you[^\n]*\+2/.test(many), many).toBe(true);

  const full = renderConv('Assignment 4 is due', { reactions: 'full' });
  expect(
    /😂 5 · you/.test(full) &&
      /Edsger Dijkstra/.test(full) &&
      /Alan Turing/.test(full) &&
      !/😂 5[^\n]*\+\d/.test(full), // no overflow on the reaction line (tz offset in header also has +N)
    full,
  ).toBe(true);
});

// identity label: the owner's own messages must render as "<name> (you)", never "ME".
// A bare first-person token makes an AI reader misattribute the owner's messages to itself.
// Ada is SELF in this fixture; she authored "Sure, sharing now." in the study-group conversation.
test('identity label (owner = you)', () => {
  expect(/Ada Lovelace \(you\)>/.test(multi), multi).toBe(true);
  expect(!/(^|\s)ME>/.test(multi), multi).toBe(true);
  expect(/viewer: Ada Lovelace[^\n]*\(you\)/.test(multi), multi).toBe(true);

  // search must fix the SECOND 'ME' literal too. "fitting" hits only Ada's own DM line.
  const ownSearch = search(store, { query: 'fitting', limit: 5 });
  expect(/Ada Lovelace \(you\)/.test(ownSearch), ownSearch.slice(0, 300)).toBe(true);
  expect(!/(^|\s)ME>/.test(ownSearch), ownSearch.slice(0, 300)).toBe(true);
});

// get_message: fetch ONE message in full (untruncated body, char-window head, thread pivot).
test('get_message (single message, full body)', () => {
  const gc = store.conversations.list({ kind: 'channel' })[0];
  const gm = store.messages.inConversation(gc.id, { limit: 500 });
  const root = gm.ok ? gm.rows.find((r) => r.rootId === r.id) : undefined;
  const reply = gm.ok ? gm.rows.find((r) => r.rootId !== r.id) : undefined;
  if (root) {
    const out = getMessage(store, { conversation: gc.handle, message: `m:${root.id}` });
    expect(out.includes(root.content), out.slice(0, 200)).toBe(true);
    expect(/full body · chars 0\.\.\d+\/\d+/.test(out), out.slice(0, 200)).toBe(true);
    expect(!/in thread m:/.test(out), out).toBe(true);
  }
  if (reply) {
    const out = getMessage(store, { conversation: gc.handle, message: `m:${reply.id}` });
    expect(new RegExp(`in thread m:${reply.rootId}`).test(out), out).toBe(true);
  }
  const miss = getMessage(store, { conversation: gc.handle, message: 'm:doesnotexist' });
  expect(/not found in this conversation/.test(miss), miss).toBe(true);
});

// channel reply-chain rendering (digest / thread mode / around-pivot)
test('channel threaded rendering', () => {
  const chConv = store.conversations.list({ kind: 'channel' })[0];
  // The biggest reply-chain: the root with the most (non-system) messages — `threadSummaries` counts
  // exactly that (is_system=0 per chain). The C thread (root + 6 replies = 7) is the fixture's largest.
  const bigRoot = store.messages
    .threadSummaries(chConv.id, {})
    .slice()
    .sort((a, b) => b.count - a.count)[0].rootId;
  const digest = readConversation(store, { conversation: chConv.handle, limit: 40 });
  expect(/threads by last activity/.test(digest), digest.slice(0, 220)).toBe(true);
  expect(new RegExp(`\\[thread m:${bigRoot} · 6 replies`).test(digest), digest).toBe(true);
  expect(
    new RegExp(`\\+3 earlier · read_thread\\(thread: m:${bigRoot}\\)`).test(digest),
    digest,
  ).toBe(true);
  expect(!/CLRS chapter 8/.test(digest), digest).toBe(true);
  expect(
    /I'll pin these to the channel/.test(digest),
    'big thread newest reply is shown in the digest',
  ).toBe(true);
  expect(
    /Are the lectures recorded too\?/.test(digest) &&
      /post the recording link after class/.test(digest),
    'small (≤5) thread shows every reply (both A replies present)',
  ).toBe(true);
  expect(/Ada Lovelace \(you\)>/.test(digest), digest).toBe(true);

  const tmode = readThread(store, { conversation: chConv.handle, thread: 'm:' + bigRoot });
  expect(/showing 7\/7 · complete/.test(tmode), tmode).toBe(true);
  expect(/CLRS chapter 8/.test(tmode), 'thread mode shows the earliest reply (not truncated)').toBe(
    true,
  );
  expect(!/earlier/.test(tmode), 'thread mode (fits) has no "+N earlier" marker').toBe(true);
  expect(/📚/.test(tmode), tmode.slice(0, 160)).toBe(true);

  // Any non-system reply (id !== root) in the big chain — the reply-pivot target.
  const chReply = store.messages.thread(chConv.id, bigRoot).find((r) => r.id !== bigRoot)!;
  const around = readThread(store, { conversation: chConv.handle, thread: 'm:' + chReply.id });
  expect(
    new RegExp(`thread m:${chReply.rootId}`).test(around) && /→ /.test(around),
    around.slice(0, 300),
  ).toBe(true);
});

// All fixture calendar/call dates live in March 2026 — an explicit since/until window (rather
// than the tools' own forward-looking default) makes these tests independent of wall-clock "now".
test('list_events (tool rendering)', () => {
  const EV_WINDOW = { since: '2026-03-01', until: '2026-04-01' };

  const allEvents = listEvents(store, { ...EV_WINDOW, limit: 50 });
  expect(/\[cancelled\][^\n]*"Cancelled Study Session"/.test(allEvents), allEvents).toBe(true);
  expect(/\[confidential\][^\n]*"Confidential 1:1"/.test(allEvents), allEvents).toBe(true);
  expect(
    new RegExp(`"CS101 Midterm Review Session"[^\\n]*chat ${midtermHandle}\\b`).test(allEvents),
    allEvents,
  ).toBe(true);
  expect(
    /"Guest Lecture: Distributed Systems"[^\n]*chat \(no cached chat\)/.test(allEvents),
    allEvents,
  ).toBe(true);
  expect((allEvents.match(/\[appointment\] "Daily Standup"/g) ?? []).length === 1, allEvents).toBe(
    true,
  );
  // The overflow count (4) folds in the Exception row too — spec: "expand Occurrence + Exception
  // (a moved instance is exactly where a collapsed series lies)" — the moved instance shares the
  // same series_id, so it collapses into the run just like any other occurrence; it is not
  // rendered as its own separate line, and the "(moved)" subject never leaks into the collapse text.
  expect(/↻ Daily Standup ×4 more \(next [^)]+\)/.test(allEvents), allEvents).toBe(true);
  expect(!/"Daily Standup \(moved\)"/.test(allEvents), allEvents).toBe(true);
  expect(!/evt-series-master/.test(allEvents), allEvents).toBe(true);
  expect(/3 attendees \(2 accepted\)/.test(allEvents), allEvents).toBe(true);
  expect(!/Room CS-101/.test(allEvents), allEvents).toBe(true);

  const hideCancelled = listEvents(store, { ...EV_WINDOW, hide_cancelled: true, limit: 50 });
  expect(!/Cancelled Study Session/.test(hideCancelled), hideCancelled).toBe(true);

  const typeAppt = listEvents(store, { ...EV_WINDOW, type: 'appointment', limit: 50 });
  expect(!/CS101 Midterm Review Session/.test(typeAppt), typeAppt).toBe(true);
  expect(/Dentist appointment/.test(typeAppt), typeAppt).toBe(true);

  const typeMeeting = listEvents(store, { ...EV_WINDOW, type: 'meeting', limit: 50 });
  expect(!/Dentist appointment/.test(typeMeeting), typeMeeting).toBe(true);
  expect(/CS101 Midterm Review Session/.test(typeMeeting), typeMeeting).toBe(true);

  const attendeeFilter = listEvents(store, { ...EV_WINDOW, attendee: 'Alan Turing', limit: 50 });
  expect(/CS101 Midterm Review Session/.test(attendeeFilter), attendeeFilter).toBe(true);
  expect(!/Guest Lecture/.test(attendeeFilter), attendeeFilter).toBe(true);

  // include_body: positive (single narrowed result, non-confidential) — body renders, URL elided.
  const bodyPositive = listEvents(store, {
    ...EV_WINDOW,
    query: 'Room Booking',
    include_body: true,
  });
  expect(/Room booked/.test(bodyPositive), bodyPositive).toBe(true);
  expect(/\[link: example\.invalid\]/.test(bodyPositive), bodyPositive).toBe(true);
  expect(!/https:\/\/example\.invalid/.test(bodyPositive), bodyPositive).toBe(true);

  // include_body: negative (multiple results) — withheld with an explanatory note.
  const bodyMultiResult = listEvents(store, { ...EV_WINDOW, include_body: true, limit: 50 });
  expect(/include_body ignored/.test(bodyMultiResult), bodyMultiResult).toBe(true);

  // include_body: negative (confidential) — suppressed REGARDLESS of the arg, even narrowed to one.
  const bodyConfidential = listEvents(store, {
    ...EV_WINDOW,
    query: 'Confidential 1:1',
    include_body: true,
  });
  expect(
    /include_body ignored[^\n]*\[confidential\]/.test(bodyConfidential),
    bodyConfidential,
  ).toBe(true);
  expect(!/secret-doc/.test(bodyConfidential), bodyConfidential).toBe(true);
});

test('list_calls (tool rendering)', () => {
  const allCalls = listCalls(store, { limit: 50 });
  expect(!/Alan Turing/.test(allCalls), allCalls).toBe(true);
  expect(/← Margaret Hamilton · 5m · accepted/.test(allCalls), allCalls).toBe(true);
  expect(/→ Grace Hopper · missed/.test(allCalls), allCalls).toBe(true);
  expect(
    new RegExp(`study-group-cs101 ${studyGroupHandle}[^\\n]*· 45s`).test(allCalls),
    allCalls,
  ).toBe(true);
  const welcomeMsgId = String(CONVERSATIONS[1].messages[1].ts);
  expect(
    new RegExp(
      `Radia Perlman · 1h05m · accepted \\[recorded\\] recorded → ${studyGroupHandle} m:${welcomeMsgId}`,
    ).test(allCalls),
    allCalls,
  ).toBe(true);

  const missedOnly = listCalls(store, { missed: true, limit: 50 });
  expect(/Grace Hopper/.test(missedOnly) && !/Margaret Hamilton/.test(missedOnly), missedOnly).toBe(
    true,
  );

  const incomingOnly = listCalls(store, { direction: 'Incoming', limit: 50 });
  expect(
    !/Grace Hopper/.test(incomingOnly) && /Margaret Hamilton/.test(incomingOnly),
    incomingOnly,
  ).toBe(true);

  const participantFilter = listCalls(store, { participant: 'Margaret', limit: 50 });
  expect(
    /Margaret Hamilton/.test(participantFilter) && !/Grace Hopper/.test(participantFilter),
    participantFilter,
  ).toBe(true);
});
