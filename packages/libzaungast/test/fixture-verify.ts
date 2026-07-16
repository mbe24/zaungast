// Fixture correctness oracle. Generates the synthetic fixture into a temp dir, round-trips it
// through the SAME production readers the real Teams reader uses (src/format/*, src/ingest/*), and
// asserts the decoded content matches what test/fixture/data.ts declared. Runs in CI with no real
// Teams cache (no PII). Exits non-zero on any failure.
//
// This is a LIBRARY-internals test (it lives in libzaungast so it can reach the format primitives
// directly). The MCP tool-surface / rendering is covered elsewhere: the byte-identical G2 golden
// (packages/zaungast/test/golden/mcp.ts) and the facade smoke test (test/facade.ts).
//
// Run: node --experimental-sqlite --import tsx test/fixture-verify.ts  (or `npm run test:fixture`)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSnapshot, fingerprint, loadMapping, selectMapping, extractEntity } from '../src/format/index.js';
// Internal Chromium byte readers / value decoder — not on the public /format surface; an in-package
// test reaches them directly (relative), which is exactly why they can stay hidden from consumers.
import {
  loadEntries,
  decodePrefix,
  readStringWithLength,
  readVarint,
  utf16be,
  decodeValue,
} from '../src/format/chromium/indexeddb.js';
import type { SnapshotRecord } from '../src/format/types.js';
import { ingest } from '../src/ingest/ingest.js';
import { generateFixture } from './fixture/generate.js';
import { stringWithLength, utf16beBytes, idbValue, blobIndexHost, blobHost } from './fixture/encode.js';
import { ALL_PROFILES, CONVERSATIONS, STUDENTS, SILENT_PROFILE, EVENTS, CALLS } from './fixture/data.js';

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
const eq = (name: string, a: unknown, b: unknown): void =>
  ok(
    name,
    JSON.stringify(a) === JSON.stringify(b),
    `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`,
  );

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaungast-fixture-'));
generateFixture(dir);
console.log(`generated fixture at ${dir}`);

// ---- 0. UTF-16BE codec round-trip (encoder <-> decoder agree on surrogate pairs) ----
// The key/store-name codec works in 16-bit code units on purpose: the fixture encoder uses
// charCodeAt and the reader uses fromCharCode. A non-BMP char (😀 U+1F600, 𝕏 U+1D54F) is a
// surrogate pair, and must survive encode->decode. This would break if either side were
// "fixed" to codePointAt/fromCodePoint (encode can't fit U+1F600 in one 16-bit unit).
console.log('=== UTF-16BE non-BMP round-trip ===');
{
  const s = 'hi 😀 café 𝕏 end';
  eq('readStringWithLength surrogate pairs', readStringWithLength(stringWithLength(s), 0)[0], s);
  eq('utf16be surrogate pairs', utf16be(utf16beBytes(s)), s);
}

// ---- 0b. BigInt round-trip: the decoder must reconstruct the exact value (not approximate) ----
console.log('\n=== BigInt round-trip ===');
{
  const src = { pos: 42n, negLarge: -98765432109876543210n, zero: 0n, big: 1n << 100n };
  const back = decodeValue(idbValue(src)) as Record<string, unknown>;
  ok('bigint positive', back.pos === 42n, `got ${back.pos}`);
  ok('bigint negative (>64-bit)', back.negLarge === -98765432109876543210n, `got ${back.negLarge}`);
  ok('bigint zero', back.zero === 0n, `got ${back.zero}`);
  ok('bigint 2^100', back.big === 1n << 100n, `got ${back.big}`);
}

// ---- 0c. Blink Blob host-object round-trip (kHostObject '\' 0x5c) ----
// Mirrors the real Teams app-icon record: an object whose imageBlob field is an embedded Blink
// Blob host object. URL-only design → the decoder returns a metadata-only marker, never bytes.
console.log('\n=== Blob host-object round-trip ===');
{
  // kBlobIndexTag ('i'): exactly what all 6 real records use (index 0). Fields BEFORE and AFTER
  // the host object must survive so back-ref/cursor alignment is proven end-to-end.
  const idxRec = decodeValue(
    idbValue({ appId: 'app-1', imageUrl: 'https://x/y', imageBlob: blobIndexHost(0), after: 42 }),
  ) as Record<string, unknown>;
  eq('blob-index appId before host object', idxRec.appId, 'app-1');
  eq('blob-index imageUrl before host object', idxRec.imageUrl, 'https://x/y');
  eq('blob-index marker', idxRec.imageBlob, { __blobIndex: 0 });
  eq('field after host object still decodes', idxRec.after, 42);

  // kBlobTag ('b'): uuid + type + size. Marker exposes type/size only (no media bytes).
  const blobRec = decodeValue(
    idbValue({ b: blobHost('uuid-abc', 'image/png', 12345), tail: 'ok' }),
  ) as Record<string, unknown>;
  eq('blob marker type/size', blobRec.b, { __blob: { type: 'image/png', size: 12345 } });
  eq('field after blob host object still decodes', blobRec.tail, 'ok');
}

// ---- 0d. SSV string encodings: one-byte (Latin1) vs two-byte (UTF-16LE), per V8 ----
// A value whose code units all fit in a byte is written one-byte (tag 0x22); any code unit >0xff
// makes it a two-byte UTF-16LE string (tag 0x63) — the per-string choice the real Teams cache
// makes. An exact round-trip of emoji/surrogates/CJK/curly-punctuation proves BOTH the encoder's
// two-byte emission and the decoder's 0x63 path (before this, the fixture encoder threw on >0xff).
console.log('\n=== SSV string encodings (one-byte / two-byte, per V8) ===');
{
  const uni = 'café 🎉 Görkem Paweł 𝕏 端末 — “curly”';
  eq('two-byte string round-trips exactly', (decodeValue(idbValue({ s: uni })) as any).s, uni);
  const mixed = decodeValue(idbValue({ a: 'hello world', b: 'wörld 🌍', c: 42 })) as any;
  eq(
    'one-byte and two-byte fields coexist in one record',
    [mixed.a, mixed.b, mixed.c],
    ['hello world', 'wörld 🌍', 42],
  );
}

// ---- 1. loadEntries ----
console.log('\n=== loadEntries ===');
const { live, lossy, rawCount, uniqueCount } = loadEntries(dir);
ok('live.length > 0', live.length > 0, `live=${live.length}`);
ok('lossy === false', lossy === false);
console.log(`  raw=${rawCount} unique=${uniqueCount} live=${live.length}`);
const snap = loadSnapshot(dir);

// ---- 2. fingerprint + selectMapping ----
console.log('\n=== fingerprint / selectMapping ===');
const fp = fingerprint(snap);
console.log(`  fingerprint hash=${fp.hash} stores=${fp.stores.map((s) => s.store).join(',')}`);
const VDIR = fileURLToPath(new URL('../src/schema/versions/', import.meta.url));
const mappings = fs
  .readdirSync(VDIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => loadMapping(path.join(VDIR, f)));
const { mapping, via } = selectMapping(fp, { mappings });
ok(
  'mapping resolved',
  mapping?.schemaVersion === 'teams-2026-07',
  `via=${via} got=${mapping?.schemaVersion}`,
);
console.log(`  resolved via: ${via}`);

// ---- 3. extractEntity: conversation / message ----
console.log('\n=== extractEntity: conversation ===');
const convRows = extractEntity(snap, mapping, 'conversation').records;
eq('conversation row count', convRows.length, CONVERSATIONS.length);
const channel = convRows.find((r) => r.id === '19:11223344aabb@thread.tacv2');
eq(
  'channel topic extracted (threadProperties.topic)',
  channel?.topic,
  'CS101 Algorithms - General',
);
eq('channel teamId extracted', channel?.teamId, 'team-cs101-guid-0000');
const dm = convRows.find((r) => r.id === '19:a1b2c3d4e5f6@unq.gbl.spaces');
ok(
  'DM has no topic (threadProperties omitted)',
  dm?.topic === undefined || dm?.topic === null,
  `got ${JSON.stringify(dm?.topic)}`,
);

console.log('\n=== extractEntity: message ===');
const msgRows = extractEntity(snap, mapping, 'message').records;
const wantMsgCount = CONVERSATIONS.reduce((n, c) => n + c.messages.length, 0);
eq('message row count', msgRows.length, wantMsgCount);
const adaFirst = CONVERSATIONS[0].messages[0];
const adaRow = msgRows.find((r) => r.id === String(adaFirst.ts));
eq('specific message content matches', adaRow?.content, adaFirst.content);
eq('specific message sender matches', adaRow?.senderName, 'Ada Lovelace');
eq('specific message conversationId matches', adaRow?.conversationId, CONVERSATIONS[0].id);
const mentionRow = msgRows.find(
  (r) => r.content === 'Thanks bot! @Ada Lovelace can you share your notes?',
);
ok(
  'mentions round-trip as JSON string',
  typeof mentionRow?.mentions === 'string' &&
    (mentionRow!.mentions as string).includes('a1000000-0000-4000-8000-000000000001'),
);
const systemRows = msgRows.filter(
  (r) => typeof r.messageType === 'string' && r.messageType.startsWith('ThreadActivity/'),
);
eq('system (ThreadActivity) message count', systemRows.length, 2); // AddMember + TopicUpdate
const selfRows = msgRows.filter((r) => r.isSentByCurrentUser === true);
eq(
  'isSentByCurrentUser count (Ada authored)',
  selfRows.length,
  CONVERSATIONS.flatMap((c) => c.messages).filter((m) => m.isSentByCurrentUser).length,
);

// ---- 3b. reactions (decode round-trip): message.properties.emotions, mapped by the
// 'reactions' field ("properties.emotions") in teams-2026-07.json, must decode back out of the
// generated leveldb bytes exactly as declared in data.ts — keys, reactor MRIs, per-reactor
// counts, and times. This is decode-level only: no tool-rendering assertions here.
console.log('\n=== reactions (decode round-trip) ===');
type DecodedReactions = { key: string; users: { mri: string; time: number }[] }[];
const [ada] = STUDENTS; // ada === SELF, the current user, per data.ts
const reactedMessages = CONVERSATIONS.flatMap((c) => c.messages).filter((m) => m.reactions);
eq('reacted message count seeded', reactedMessages.length, 3);
for (const m of reactedMessages) {
  const row = msgRows.find((r) => r.id === String(m.ts));
  eq(`reactions decode round-trip: "${m.content.slice(0, 40)}..."`, row?.reactions, m.reactions);
}

const oneReactorRow = msgRows.find(
  (r) => r.content === "Haha fitting given the professor's name. Let's meet before class.",
);
const oneReactorReactions = oneReactorRow?.reactions as DecodedReactions | undefined;
eq('single emoji / single reactor: key', oneReactorReactions?.[0]?.key, 'like');
eq(
  'single emoji / single reactor: exactly one reactor',
  oneReactorReactions?.[0]?.users?.length,
  1,
);

const manyReactorsRow = msgRows.find(
  (r) => r.content === 'Reminder: Assignment 4 is due Friday at 11:59pm.',
);
const manyReactorsReactions = manyReactorsRow?.reactions as DecodedReactions | undefined;
const manyReactorsUsers = manyReactorsReactions?.[0]?.users ?? [];
eq('single emoji / several reactors: reactor count >= 4', manyReactorsUsers.length >= 4, true);
ok(
  'single emoji / several reactors: self (ada) is a reactor',
  manyReactorsUsers.some((u) => u.mri === ada.mri),
);
ok(
  'single emoji / several reactors: all reactor times distinct',
  new Set(manyReactorsUsers.map((u) => u.time)).size === manyReactorsUsers.length,
);

const multiEmojiRow = msgRows.find(
  (r) => r.content === '<p>Welcome to the <b>CS101</b> study group!</p>',
);
const multiEmojiReactions = (multiEmojiRow?.reactions as DecodedReactions | undefined) ?? [];
eq('multiple distinct emojis: emoji-group count', multiEmojiReactions.length, 3);
eq(
  'multiple distinct emojis: emoji keys',
  multiEmojiReactions.map((g) => g.key).sort(),
  ['1f389_partypopper', 'heart', 'surprised'].sort(),
);
const nonAuthorGroup = multiEmojiReactions.find((g) => g.key === 'surprised');
ok(
  'non-authoring profile (SILENT_PROFILE) resolves as a reactor',
  nonAuthorGroup?.users?.length === 1 && nonAuthorGroup.users[0].mri === SILENT_PROFILE.mri,
);
ok(
  'SILENT_PROFILE never authors a message in this fixture',
  !CONVERSATIONS.flatMap((c) => c.messages).some((m) => m.sender.mri === SILENT_PROFILE.mri),
);
ok(
  'SILENT_PROFILE has a profile in ALL_PROFILES',
  ALL_PROFILES.some((p) => p.mri === SILENT_PROFILE.mri),
);
// ---- 4. profiles: cross-check the store the hard way — extract it directly using the same
// primitives resolver.ts's schemaTables/entityTargets use under the hood (all exported from
// src/format/index.ts). This is an independent check of the raw store; ingest itself now reads
// it via the 'profile' mapping entity (used above for reactor-name resolution).
console.log('\n=== profiles (direct extraction — no mapping entity) ===');
function extractProfiles(entries: SnapshotRecord[]): Record<string, unknown>[] {
  const storeNames = new Map<string, string>();
  for (const { key, value } of entries) {
    if (key.length < 1) continue;
    let p;
    try {
      p = decodePrefix(key);
    } catch {
      continue;
    }
    if (p.databaseId > 0 && p.objectStoreId === 0 && p.indexId === 0 && key[p.headerLen] === 0x32) {
      const [osId, pp] = readVarint(key, p.headerLen + 1);
      if (key[pp] === 0) storeNames.set(`${p.databaseId}:${osId}`, utf16be(value));
    }
  }
  const targets = new Set<string>();
  for (const [sk, storeName] of storeNames) if (storeName === 'profiles') targets.add(sk);
  const rows: Record<string, unknown>[] = [];
  for (const { key, value } of entries) {
    let p;
    try {
      p = decodePrefix(key);
    } catch {
      continue;
    }
    if (p.indexId !== 1 || !targets.has(`${p.databaseId}:${p.objectStoreId}`)) continue;
    try {
      rows.push(decodeValue(value) as Record<string, unknown>);
    } catch {
      /* skip */
    }
  }
  return rows;
}
const profileRows = extractProfiles(live);
eq('profile row count', profileRows.length, ALL_PROFILES.length);
const adaProfile = profileRows.find((r) => r.mri === STUDENTS[0].mri);
eq('profile displayName matches', adaProfile?.displayName, 'Ada Lovelace');
eq('profile email matches', adaProfile?.email, 'ada.lovelace@example.edu');

// ---- 4b. extractEntity: event (calendar) — decode round-trip against test/fixture/data.ts ----
console.log('\n=== extractEntity: event ===');
const eventRows = extractEntity(snap, mapping, 'event').records;
eq('event row count (raw, incl. RecurringMaster)', eventRows.length, EVENTS.length);
const cachedMeetingRow = eventRows.find((r) => r.id === 'evt-meeting-cached');
eq('cached-meeting subject decodes', cachedMeetingRow?.subject, 'CS101 Midterm Review Session');
eq(
  'cached-meeting cid decodes via skypeTeamsDataObject.cid',
  cachedMeetingRow?.cid,
  '19:meeting_998877@thread.v2',
);
ok(
  'cached-meeting attendees array decodes raw (4: 3 people + 1 Resource room)',
  Array.isArray(cachedMeetingRow?.attendees) && (cachedMeetingRow!.attendees as any[]).length === 4,
);
const masterRow = eventRows.find((r) => r.id === 'evt-series-master');
eq(
  'RecurringMaster eventType decodes (still present at extraction level)',
  masterRow?.eventType,
  'RecurringMaster',
);
const confRow = eventRows.find((r) => r.id === 'evt-confidential-1on1');
eq('confidential event doNotForward decodes', confRow?.doNotForward, true);
ok(
  'confidential event bodyContent decodes (raw)',
  typeof confRow?.bodyContent === 'string' &&
    (confRow!.bodyContent as string).includes('secret-doc'),
);

// ---- 4c. extractEntity: call (call-history) — decode round-trip ----
console.log('\n=== extractEntity: call ===');
const callRows = extractEntity(snap, mapping, 'call').records;
eq('call row count (raw, incl. deleted)', callRows.length, CALLS.length);
const recordedCallRow = callRows.find((r) => r.id === 'call-4-recorded');
const recordings = recordedCallRow?.recordings as any[] | undefined;
eq(
  'recorded call linkedMessage.conversationId decodes',
  recordings?.[0]?.linkedMessage?.conversationId,
  '19:f1e2d3c4b5a6@thread.v2',
);
eq(
  'recorded call linkedMessage.linkedMessageId decodes',
  recordings?.[0]?.linkedMessage?.linkedMessageId,
  String(CONVERSATIONS[1].messages[1].ts),
);
const multiPartyRow = callRows.find((r) => r.id === 'call-3-multiparty');
ok(
  'MultiParty participantList decodes (3 participants)',
  Array.isArray(multiPartyRow?.participantList) &&
    (multiPartyRow!.participantList as any[]).length === 3,
);
const deletedCallRow = callRows.find((r) => r.id === 'call-5-deleted');
eq('deleted call isDeleted decodes', deletedCallRow?.isDeleted, true);

// ---- 5. end-to-end: ingest() + ChatStore counts / classification ----
console.log('\n=== end-to-end: ingest() + ChatStore ===');
const { store, meta } = ingest(dir);
ok('ingest schemaMatched', meta.schemaMatched === true);
// Regression guard: chain_key must survive a plain SELECT read-back. Message keys are binary
// leveldb keys with embedded NUL bytes; if chain_key were stored as raw latin1, node:sqlite would
// truncate it at the first NUL and every value would read back as ''. It's hex-encoded to avoid
// that — this asserts a real message's chain_key is non-empty and hex-shaped (would fail on revert).
{
  const ck = (
    store.db.prepare(`select chain_key from messages where chain_key<>'' limit 1`).get() as any
  )?.chain_key;
  ok(
    'chain_key reads back non-empty + hex-encoded (NUL-safe)',
    typeof ck === 'string' && ck.length > 0 && /^[0-9a-f]+$/.test(ck),
    `got ${JSON.stringify(ck)}`,
  );
}
eq('ingest counts.conversations', meta.counts.conversations, CONVERSATIONS.length);
eq('ingest counts.messages', meta.counts.messages, wantMsgCount);
const ingestedEventCount = (store.db.prepare('select count(*) n from events').get() as any).n;
eq('ingested events count excludes the RecurringMaster row', ingestedEventCount, EVENTS.length - 1);
const ingestedCallCount = (store.db.prepare('select count(*) n from calls').get() as any).n;
eq(
  'ingested calls count (deleted call still STORED, only filtered at render)',
  ingestedCallCount,
  CALLS.length,
);
const kindCounts = store.db
  .prepare('select kind, count(*) n from events group by kind')
  .all() as any[];
const meetingKindCount = kindCounts.find((r) => r.kind === 'meeting')?.n ?? 0;
const apptKindCount = kindCounts.find((r) => r.kind === 'appointment')?.n ?? 0;
eq('cid-first classify: meeting count (2 online meetings)', meetingKindCount, 2);
eq(
  'cid-first classify: appointment count (everything else, RecurringMaster excluded)',
  apptKindCount,
  EVENTS.length - 1 - 2,
);
ok('ingest not lossy', meta.lossy === false);

store.close();

fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
