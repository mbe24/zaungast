// MCP tool-surface regression test. Generates the synthetic fixture into a temp dir, opens it via
// the PUBLIC libzaungast facade (`openStore`), and smoke-tests the whole zaungast MCP tool surface
// (search / list_conversations / top_topics / find_person / read_messages / list_events /
// list_calls) against it — reaction rendering, the (you) identity label, channel reply-chain
// rendering, and the list_events / list_calls render contracts. Runs in CI with no real Teams cache
// (no PII). Sets a non-zero exit code on any failure.
//
// The library-internals half (byte codecs, extractEntity/ingest counts, chain_key, decode
// round-trips) lives in packages/libzaungast/test/fixture-verify.ts — this file deliberately does
// not duplicate it, and reaches the store only through the facade + the MCP tools.
//
// Run:
//   node --conditions=development --experimental-sqlite --import tsx packages/zaungast/test/fixture-verify.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from 'libzaungast';
import {
  search,
  listConversations,
  topTopics,
  findPerson,
  readMessages,
  listEvents,
  listCalls,
} from 'zaungast/tools.js';
import { generateFixture } from '../../libzaungast/test/fixture/generate.js';
import { CONVERSATIONS } from '../../libzaungast/test/fixture/data.js';

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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaungast-fixture-'));
generateFixture(dir);
console.log(`generated fixture at ${dir}`);

// A static `openStore` store is a valid tool View: the six query namespaces + the build's `meta`,
// with `mayBeStale` absent → renders as not-stale (identical to the old deferred=false path).
const store = openStore(dir);

// ---- 5. end-to-end: ingest() + ChatStore + search() (MCP-surface half) ----
console.log('\n=== end-to-end: ingest() + ChatStore + search ===');
const results = search(store, { query: 'memoization', limit: 5 });
ok('search finds seeded content', /memoization/i.test(results), results.slice(0, 200));

// ---- 6. tool-surface smoke: every tool answers sanely off the fixture ----
console.log('\n=== tool surface (list / top_topics / find_person) ===');
const list = listConversations(store, {});
ok(
  'list_conversations shows a seeded conversation',
  /CS101|study-group|Algorithms/i.test(list),
  list.slice(0, 200),
);
const topics = topTopics(store, {});
ok('top_topics returns non-empty output', topics.trim().length > 0);
const person = findPerson(store, { query: 'Ada Lovelace' });
ok('find_person resolves a seeded student', /Ada Lovelace/i.test(person), person.slice(0, 200));

// ---- 7. reactions RENDERED by read_messages: glyph mapping, two-level cap, you-first, and the
// crucial end-to-end guarantee — a profiles-only reactor (never posted) resolves to a NAME in the
// actual tool output, not just in the decoded record.
console.log('\n=== reactions (read_messages rendering) ===');
// Find the conversation that CONTAINS a message matching `contentLike` (the facade equivalent of the
// old raw `... from messages where content like ?`), then render it whole through the read_messages
// tool. `messages.search` returns SearchHits carrying `convId`; `conversations.get` maps id→handle.
const renderConv = (contentLike: string, opts: { reactions?: 'full' } = {}): string => {
  const res = store.messages.search({ query: contentLike, limit: 20 });
  const hit = res.ok
    ? res.rows.find((r) => r.content.toLowerCase().includes(contentLike.toLowerCase()))
    : undefined;
  const c = hit ? store.conversations.get(hit.convId) : null;
  return readMessages(store, { conversation: c!.handle, limit: 60, ...opts });
};

const single = renderConv('Haha fitting');
ok('single reactor renders glyph + name (like → 👍)', /👍 1 · Alan Turing/.test(single), single);

const multi = renderConv('study group');
ok('multi-emoji: heart glyph rendered', /❤️/.test(multi));
ok('multi-emoji: codepoint key 1f389_partypopper → 🎉', /🎉/.test(multi));
ok('multi-emoji: surprised → 😮', /😮/.test(multi));
ok(
  'profiles-only reactor resolves to a NAME in rendered output (Margaret Hamilton)',
  /Margaret Hamilton/.test(multi),
  multi,
);

const many = renderConv('Assignment 4 is due');
ok('capped: 5 reactors show count + you-first (😂 5 · you)', /😂 5 · you/.test(many), many);
ok('capped: overflow beyond 3 names shows +2', /😂 5 · you[^\n]*\+2/.test(many), many);

const full = renderConv('Assignment 4 is due', { reactions: 'full' });
ok(
  'full mode: every reactor named, no +N overflow',
  /😂 5 · you/.test(full) &&
    /Edsger Dijkstra/.test(full) &&
    /Alan Turing/.test(full) &&
    !/😂 5[^\n]*\+\d/.test(full), // no overflow on the reaction line (tz offset in header also has +N)
  full,
);

// ---- 8. identity label: the owner's own messages must render as "<name> (you)", never "ME".
// A bare first-person token makes an AI reader misattribute the owner's messages to itself.
// Ada is SELF in this fixture; she authored "Sure, sharing now." in the study-group conversation.
console.log('\n=== identity label (owner = you) ===');
ok('owner message labelled by real name + (you)', /Ada Lovelace \(you\)>/.test(multi), multi);
ok('no bare "ME>" label remains in read_messages', !/(^|\s)ME>/.test(multi), multi);
ok(
  'read_messages header carries the (you) viewer legend',
  /viewer: Ada Lovelace[^\n]*\(you\)/.test(multi),
  multi,
);

// search must fix the SECOND 'ME' literal too. "fitting" hits only Ada's own DM line.
const ownSearch = search(store, { query: 'fitting', limit: 5 });
ok(
  'search labels an owner-authored hit as "<name> (you)"',
  /Ada Lovelace \(you\)/.test(ownSearch),
  ownSearch.slice(0, 300),
);
ok('no bare "ME>" label remains in search', !/(^|\s)ME>/.test(ownSearch), ownSearch.slice(0, 300));

// ---- 8b. channel reply-chain rendering (digest / thread mode / around-pivot) ----
console.log('\n=== channel threaded rendering ===');
const chConv = store.conversations.list({ kind: 'channel' })[0];
// The biggest reply-chain: the root with the most (non-system) messages — `threadSummaries` counts
// exactly that (is_system=0 per chain). The C thread (root + 6 replies = 7) is the fixture's largest.
const bigRoot = store.messages
  .threadSummaries(chConv.id, {})
  .slice()
  .sort((a, b) => b.count - a.count)[0].rootId;
const digest = readMessages(store, { conversation: chConv.handle, limit: 40 });
ok(
  'digest declares last-activity thread ordering',
  /threads by last activity/.test(digest),
  digest.slice(0, 220),
);
ok(
  'big thread (7 msgs) shows a [thread m:… · 6 replies] tag',
  new RegExp(`\\[thread m:${bigRoot} · 6 replies`).test(digest),
  digest,
);
ok(
  'big thread truncated to root + last 3 with a verbatim drill-in call',
  new RegExp(`\\+3 earlier · read_messages\\(thread: m:${bigRoot}\\)`).test(digest),
  digest,
);
ok('big thread earliest reply is hidden in the digest', !/CLRS chapter 8/.test(digest), digest);
ok('big thread newest reply is shown in the digest', /I'll pin these to the channel/.test(digest));
ok(
  'small (≤5) thread shows every reply (both A replies present)',
  /Are the lectures recorded too\?/.test(digest) &&
    /post the recording link after class/.test(digest),
);
ok(
  'owner reply is labelled "<name> (you)" in a thread',
  /Ada Lovelace \(you\)>/.test(digest),
  digest,
);

const tmode = readMessages(store, { conversation: chConv.handle, thread: 'm:' + bigRoot });
ok(
  'thread mode inlines the whole 7-msg chain and says complete',
  /showing 7\/7 · complete/.test(tmode),
  tmode,
);
ok('thread mode shows the earliest reply (not truncated)', /CLRS chapter 8/.test(tmode));
ok('thread mode (fits) has no "+N earlier" marker', !/earlier/.test(tmode));
ok(
  'emoji in real message content survives ingest→render (two-byte SSV path)',
  /📚/.test(tmode),
  tmode.slice(0, 160),
);

// Any non-system reply (id !== root) in the big chain — the around-pivot target.
const chReply = store.messages.thread(chConv.id, bigRoot).find((r) => r.id !== bigRoot)!;
const around = readMessages(store, { conversation: chConv.handle, around: 'm:' + chReply.id });
ok(
  'around: in a channel resolves to the hit thread and marks the hit with →',
  new RegExp(`thread m:${chReply.rootId}`).test(around) && /→ /.test(around),
  around.slice(0, 300),
);

// ---- 9. list_events / list_calls (tool-render assertions) ----
// All fixture calendar/call dates live in March 2026 — an explicit since/until window (rather
// than the tools' own forward-looking default) makes these tests independent of wall-clock "now".
console.log('\n=== list_events (tool rendering) ===');
const EV_WINDOW = { since: '2026-03-01', until: '2026-04-01' };
const studyGroupHandle = store.conversations.get('19:f1e2d3c4b5a6@thread.v2')!.handle;
const midtermHandle = store.conversations.get('19:meeting_998877@thread.v2')!.handle;

const allEvents = listEvents(store, { ...EV_WINDOW, limit: 50 });
ok(
  'cancelled event shown by default, tagged [cancelled]',
  /\[cancelled\][^\n]*"Cancelled Study Session"/.test(allEvents),
  allEvents,
);
ok(
  'confidential event tagged [confidential]',
  /\[confidential\][^\n]*"Confidential 1:1"/.test(allEvents),
  allEvents,
);
ok(
  'cached-meeting chat pivot resolves to the real c: handle',
  new RegExp(`"CS101 Midterm Review Session"[^\\n]*chat ${midtermHandle}\\b`).test(allEvents),
  allEvents,
);
ok(
  'no-cache meeting renders "(no cached chat)", never a fabricated handle',
  /"Guest Lecture: Distributed Systems"[^\n]*chat \(no cached chat\)/.test(allEvents),
  allEvents,
);
ok(
  'recurring run-collapse: only ONE fully-rendered "Daily Standup" line',
  (allEvents.match(/\[appointment\] "Daily Standup"/g) ?? []).length === 1,
  allEvents,
);
// The overflow count (4) folds in the Exception row too — spec: "expand Occurrence + Exception
// (a moved instance is exactly where a collapsed series lies)" — the moved instance shares the
// same series_id, so it collapses into the run just like any other occurrence; it is not
// rendered as its own separate line, and the "(moved)" subject never leaks into the collapse text.
ok(
  'recurring run-collapse: summary line shows the right overflow count (occurrences + exception)',
  /↻ Daily Standup ×4 more \(next [^)]+\)/.test(allEvents),
  allEvents,
);
ok(
  'moved Exception instance folds into the collapse, not rendered separately',
  !/"Daily Standup \(moved\)"/.test(allEvents),
  allEvents,
);
ok(
  'RecurringMaster template itself never renders as an event',
  !/evt-series-master/.test(allEvents),
  allEvents,
);
ok(
  'attendee cap: names capped + accepted tally shown (Resource room excluded → 3 not 4)',
  /3 attendees \(2 accepted\)/.test(allEvents),
  allEvents,
);
ok(
  'meeting-room (type:Resource) attendee filtered out of the render',
  !/Room CS-101/.test(allEvents),
  allEvents,
);

const hideCancelled = listEvents(store, {
  ...EV_WINDOW,
  hide_cancelled: true,
  limit: 50,
});
ok(
  'hide_cancelled:true filters the cancelled event out',
  !/Cancelled Study Session/.test(hideCancelled),
  hideCancelled,
);

const typeAppt = listEvents(store, { ...EV_WINDOW, type: 'appointment', limit: 50 });
ok(
  'type:appointment excludes online meetings',
  !/CS101 Midterm Review Session/.test(typeAppt),
  typeAppt,
);
ok(
  'type:appointment still includes plain appointments',
  /Dentist appointment/.test(typeAppt),
  typeAppt,
);

const typeMeeting = listEvents(store, { ...EV_WINDOW, type: 'meeting', limit: 50 });
ok(
  'type:meeting excludes plain appointments',
  !/Dentist appointment/.test(typeMeeting),
  typeMeeting,
);
ok(
  'type:meeting includes online meetings',
  /CS101 Midterm Review Session/.test(typeMeeting),
  typeMeeting,
);

const attendeeFilter = listEvents(store, {
  ...EV_WINDOW,
  attendee: 'Alan Turing',
  limit: 50,
});
ok(
  'attendee filter matches the meeting Alan attends',
  /CS101 Midterm Review Session/.test(attendeeFilter),
  attendeeFilter,
);
ok(
  'attendee filter excludes the meeting Alan does not attend',
  !/Guest Lecture/.test(attendeeFilter),
  attendeeFilter,
);

// include_body: positive (single narrowed result, non-confidential) — body renders, URL elided.
const bodyPositive = listEvents(store, {
  ...EV_WINDOW,
  query: 'Room Booking',
  include_body: true,
});
ok(
  'include_body renders the body text for a single narrowed non-confidential event',
  /Room booked/.test(bodyPositive),
  bodyPositive,
);
ok(
  'include_body elides the URL to a bare hostname',
  /\[link: example\.invalid\]/.test(bodyPositive),
  bodyPositive,
);
ok(
  'include_body never leaks the raw URL',
  !/https:\/\/example\.invalid/.test(bodyPositive),
  bodyPositive,
);

// include_body: negative (multiple results) — withheld with an explanatory note.
const bodyMultiResult = listEvents(store, {
  ...EV_WINDOW,
  include_body: true,
  limit: 50,
});
ok(
  'include_body ignored (and noted) when the result is not narrowed to one event',
  /include_body ignored/.test(bodyMultiResult),
  bodyMultiResult,
);

// include_body: negative (confidential) — suppressed REGARDLESS of the arg, even narrowed to one.
const bodyConfidential = listEvents(store, {
  ...EV_WINDOW,
  query: 'Confidential 1:1',
  include_body: true,
});
ok(
  'include_body suppressed for a [confidential] event even when narrowed to one',
  /include_body ignored[^\n]*\[confidential\]/.test(bodyConfidential),
  bodyConfidential,
);
ok(
  'confidential body text never leaks even with include_body:true',
  !/secret-doc/.test(bodyConfidential),
  bodyConfidential,
);

console.log('\n=== list_calls (tool rendering) ===');
const allCalls = listCalls(store, { limit: 50 });
ok(
  'deleted call filtered out by default (its counterpart, Alan Turing, never appears)',
  !/Alan Turing/.test(allCalls),
  allCalls,
);
ok(
  'TwoParty incoming accepted: counterpart resolves via PROFILES ONLY (never posted a message)',
  /← Margaret Hamilton · 5m · accepted/.test(allCalls),
  allCalls,
);
ok(
  'TwoParty outgoing missed: shows "missed", no duration/state',
  /→ Grace Hopper · missed/.test(allCalls),
  allCalls,
);
ok(
  'MultiParty: group name + c: handle chat pivot, seconds-branch duration',
  new RegExp(`study-group-cs101 ${studyGroupHandle}[^\\n]*· 45s`).test(allCalls),
  allCalls,
);
const welcomeMsgId = String(CONVERSATIONS[1].messages[1].ts);
ok(
  'recorded call: [recorded] tag + hours-branch duration + recording pivot to the real message',
  new RegExp(
    `Radia Perlman · 1h05m · accepted \\[recorded\\] recorded → ${studyGroupHandle} m:${welcomeMsgId}`,
  ).test(allCalls),
  allCalls,
);

const missedOnly = listCalls(store, { missed: true, limit: 50 });
ok(
  'missed:true keeps only the missed call',
  /Grace Hopper/.test(missedOnly) && !/Margaret Hamilton/.test(missedOnly),
  missedOnly,
);

const incomingOnly = listCalls(store, { direction: 'Incoming', limit: 50 });
ok(
  'direction:Incoming excludes outgoing calls',
  !/Grace Hopper/.test(incomingOnly) && /Margaret Hamilton/.test(incomingOnly),
  incomingOnly,
);

const participantFilter = listCalls(store, { participant: 'Margaret', limit: 50 });
ok(
  'participant filter matches on the resolved (profiles-only) name',
  /Margaret Hamilton/.test(participantFilter) && !/Grace Hopper/.test(participantFilter),
  participantFilter,
);

store.close();

fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exitCode = fail ? 1 : 0;
