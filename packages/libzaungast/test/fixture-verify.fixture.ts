// Fixture correctness oracle. Generates the synthetic fixture into a temp dir, round-trips it
// through the SAME production readers the real Teams reader uses (src/format/*, src/ingest/*), and
// asserts the decoded content matches what test/fixture/data.ts declared. Runs in CI with no real
// Teams cache (no PII). Exits non-zero on any failure.
//
// This is a LIBRARY-internals test (it lives in libzaungast so it can reach the format primitives
// directly). The MCP tool-surface / rendering is covered elsewhere: the byte-identical MCP-output golden
// (packages/zaungast/test/golden/mcp.ts) and the facade smoke test (test/facade.ts).
//
// Run: npx vitest run packages/libzaungast/test/fixture-verify.fixture.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, beforeAll, afterAll } from 'vitest';
import {
  loadSnapshot,
  fingerprint,
  loadMapping,
  selectMapping,
  extractEntity,
} from '../src/format/index.js';
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
import type { SnapshotRecord, Snapshot, Mapping } from '../src/format/types.js';
import { ingest } from '../src/ingest/ingest.js';
import type { ChatStore } from '../src/ingest/store.js';
import { generateFixture } from './fixture/generate.js';
import {
  stringWithLength,
  utf16beBytes,
  idbValue,
  blobIndexHost,
  blobHost,
} from './fixture/encode.js';
import {
  ALL_PROFILES,
  CONVERSATIONS,
  STUDENTS,
  SILENT_PROFILE,
  EVENTS,
  CALLS,
} from './fixture/data.js';

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

let dir: string;
let live: SnapshotRecord[];
let lossy: boolean;
let rawCount: number;
let uniqueCount: number;
let snap: Snapshot;
let mapping: Mapping | null;
let via: string;
let convRows: ReturnType<typeof extractEntity>['records'];
let msgRows: ReturnType<typeof extractEntity>['records'];
let wantMsgCount: number;
let eventRows: ReturnType<typeof extractEntity>['records'];
let callRows: ReturnType<typeof extractEntity>['records'];
let store: ChatStore;
let meta: ReturnType<typeof ingest>['meta'];

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaungast-fixture-'));
  generateFixture(dir);

  const entries = loadEntries(dir);
  live = entries.live;
  lossy = entries.lossy;
  rawCount = entries.rawCount;
  uniqueCount = entries.uniqueCount;
  snap = loadSnapshot(dir);

  const fp = fingerprint(snap);
  const VDIR = fileURLToPath(new URL('../src/schema/versions/', import.meta.url));
  const mappings = fs
    .readdirSync(VDIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => loadMapping(path.join(VDIR, f)));
  const selected = selectMapping(fp, { mappings });
  mapping = selected.mapping;
  via = selected.via;

  convRows = extractEntity(snap, mapping, 'conversation').records;
  msgRows = extractEntity(snap, mapping, 'message').records;
  wantMsgCount = CONVERSATIONS.reduce((n, c) => n + c.messages.length, 0);
  eventRows = extractEntity(snap, mapping, 'event').records;
  callRows = extractEntity(snap, mapping, 'call').records;

  const ingested = ingest(dir);
  store = ingested.store;
  meta = ingested.meta;
});

afterAll(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// The key/store-name codec works in 16-bit code units on purpose: the fixture encoder uses
// charCodeAt and the reader uses fromCharCode. A non-BMP char (😀 U+1F600, 𝕏 U+1D54F) is a
// surrogate pair, and must survive encode->decode. This would break if either side were
// "fixed" to codePointAt/fromCodePoint (encode can't fit U+1F600 in one 16-bit unit).
test('UTF-16BE non-BMP round-trip', () => {
  const s = 'hi 😀 café 𝕏 end';
  expect(readStringWithLength(stringWithLength(s), 0)[0]).toEqual(s);
  expect(utf16be(utf16beBytes(s))).toEqual(s);
});

test('BigInt round-trip', () => {
  const src = { pos: 42n, negLarge: -98765432109876543210n, zero: 0n, big: 1n << 100n };
  const back = decodeValue(idbValue(src)) as Record<string, unknown>;
  expect(back.pos === 42n, `got ${back.pos}`).toBe(true);
  expect(back.negLarge === -98765432109876543210n, `got ${back.negLarge}`).toBe(true);
  expect(back.zero === 0n, `got ${back.zero}`).toBe(true);
  expect(back.big === 1n << 100n, `got ${back.big}`).toBe(true);
});

// Mirrors the real Teams app-icon record: an object whose imageBlob field is an embedded Blink
// Blob host object. URL-only design → the decoder returns a metadata-only marker, never bytes.
test('Blob host-object round-trip', () => {
  // kBlobIndexTag ('i'): exactly what all 6 real records use (index 0). Fields BEFORE and AFTER
  // the host object must survive so back-ref/cursor alignment is proven end-to-end.
  const idxRec = decodeValue(
    idbValue({ appId: 'app-1', imageUrl: 'https://x/y', imageBlob: blobIndexHost(0), after: 42 }),
  ) as Record<string, unknown>;
  expect(idxRec.appId).toEqual('app-1');
  expect(idxRec.imageUrl).toEqual('https://x/y');
  expect(idxRec.imageBlob).toEqual({ __blobIndex: 0 });
  expect(idxRec.after).toEqual(42);

  // kBlobTag ('b'): uuid + type + size. Marker exposes type/size only (no media bytes).
  const blobRec = decodeValue(
    idbValue({ b: blobHost('uuid-abc', 'image/png', 12345), tail: 'ok' }),
  ) as Record<string, unknown>;
  expect(blobRec.b).toEqual({ __blob: { type: 'image/png', size: 12345 } });
  expect(blobRec.tail).toEqual('ok');
});

// A value whose code units all fit in a byte is written one-byte (tag 0x22); any code unit >0xff
// makes it a two-byte UTF-16LE string (tag 0x63) — the per-string choice the real Teams cache
// makes. An exact round-trip of emoji/surrogates/CJK/curly-punctuation proves BOTH the encoder's
// two-byte emission and the decoder's 0x63 path (before this, the fixture encoder threw on >0xff).
test('SSV string encodings (one-byte / two-byte, per V8)', () => {
  const uni = 'café 🎉 Görkem Paweł 𝕏 端末 — “curly”';
  expect((decodeValue(idbValue({ s: uni })) as any).s).toEqual(uni);
  const mixed = decodeValue(idbValue({ a: 'hello world', b: 'wörld 🌍', c: 42 })) as any;
  expect([mixed.a, mixed.b, mixed.c]).toEqual(['hello world', 'wörld 🌍', 42]);
});

test('loadEntries', () => {
  expect(live.length > 0, `live=${live.length}`).toBe(true);
  expect(lossy === false).toBe(true);
  // raw=${rawCount} unique=${uniqueCount} live=${live.length}
  expect(rawCount >= 0 && uniqueCount >= 0).toBe(true);
});

test('fingerprint / selectMapping', () => {
  expect(mapping?.mappingVersion === '1.0.0', `via=${via} got=${mapping?.mappingVersion}`).toBe(
    true,
  );
});

test('extractEntity: conversation', () => {
  expect(convRows.length).toEqual(CONVERSATIONS.length);
  const channel = convRows.find((r) => r.id === '19:11223344aabb@thread.tacv2');
  expect(channel?.topic).toEqual('CS101 Algorithms - General');
  expect(channel?.teamId).toEqual('team-cs101-guid-0000');
  const dm = convRows.find((r) => r.id === '19:a1b2c3d4e5f6@unq.gbl.spaces');
  expect(dm?.topic === undefined || dm?.topic === null, `got ${JSON.stringify(dm?.topic)}`).toBe(
    true,
  );
});

test('extractEntity: message', () => {
  expect(msgRows.length).toEqual(wantMsgCount);
  const adaFirst = CONVERSATIONS[0].messages[0];
  const adaRow = msgRows.find((r) => r.id === String(adaFirst.ts));
  expect(adaRow?.content).toEqual(adaFirst.content);
  expect(adaRow?.senderName).toEqual('Ada Lovelace');
  expect(adaRow?.conversationId).toEqual(CONVERSATIONS[0].id);
  const mentionRow = msgRows.find(
    (r) => r.content === 'Thanks bot! @Ada Lovelace can you share your notes?',
  );
  expect(
    typeof mentionRow?.mentions === 'string' &&
      (mentionRow!.mentions as string).includes('a1000000-0000-4000-8000-000000000001'),
  ).toBe(true);
  const systemRows = msgRows.filter(
    (r) => typeof r.messageType === 'string' && r.messageType.startsWith('ThreadActivity/'),
  );
  expect(systemRows.length).toEqual(2); // AddMember + TopicUpdate
  const selfRows = msgRows.filter((r) => r.isSentByCurrentUser === true);
  expect(selfRows.length).toEqual(
    CONVERSATIONS.flatMap((c) => c.messages).filter((m) => m.isSentByCurrentUser).length,
  );
});

// reactions (decode round-trip): message.properties.emotions, mapped by the 'reactions' field
// ("properties.emotions") in the Teams mapping, must decode back out of the generated leveldb
// bytes exactly as declared in data.ts — keys, reactor MRIs, per-reactor counts, and times. This
// is decode-level only: no tool-rendering assertions here.
test('reactions (decode round-trip)', () => {
  type DecodedReactions = { key: string; users: { mri: string; time: number }[] }[];
  const [ada] = STUDENTS; // ada === SELF, the current user, per data.ts
  const reactedMessages = CONVERSATIONS.flatMap((c) => c.messages).filter((m) => m.reactions);
  expect(reactedMessages.length).toEqual(3);
  for (const m of reactedMessages) {
    const row = msgRows.find((r) => r.id === String(m.ts));
    expect(row?.reactions).toEqual(m.reactions);
  }

  const oneReactorRow = msgRows.find(
    (r) => r.content === "Haha fitting given the professor's name. Let's meet before class.",
  );
  const oneReactorReactions = oneReactorRow?.reactions as DecodedReactions | undefined;
  expect(oneReactorReactions?.[0]?.key).toEqual('like');
  expect(oneReactorReactions?.[0]?.users?.length).toEqual(1);

  const manyReactorsRow = msgRows.find(
    (r) => r.content === 'Reminder: Assignment 4 is due Friday at 11:59pm.',
  );
  const manyReactorsReactions = manyReactorsRow?.reactions as DecodedReactions | undefined;
  const manyReactorsUsers = manyReactorsReactions?.[0]?.users ?? [];
  expect(manyReactorsUsers.length >= 4).toEqual(true);
  expect(manyReactorsUsers.some((u) => u.mri === ada.mri)).toBe(true);
  expect(new Set(manyReactorsUsers.map((u) => u.time)).size === manyReactorsUsers.length).toBe(
    true,
  );

  const multiEmojiRow = msgRows.find(
    (r) => r.content === '<p>Welcome to the <b>CS101</b> study group!</p>',
  );
  const multiEmojiReactions = (multiEmojiRow?.reactions as DecodedReactions | undefined) ?? [];
  expect(multiEmojiReactions.length).toEqual(3);
  expect(multiEmojiReactions.map((g) => g.key).sort()).toEqual(
    ['1f389_partypopper', 'heart', 'surprised'].sort(),
  );
  const nonAuthorGroup = multiEmojiReactions.find((g) => g.key === 'surprised');
  expect(
    nonAuthorGroup?.users?.length === 1 && nonAuthorGroup.users[0].mri === SILENT_PROFILE.mri,
  ).toBe(true);
  expect(
    !CONVERSATIONS.flatMap((c) => c.messages).some((m) => m.sender.mri === SILENT_PROFILE.mri),
  ).toBe(true);
  expect(ALL_PROFILES.some((p) => p.mri === SILENT_PROFILE.mri)).toBe(true);
});

// profiles: cross-check the store the hard way — extract it directly using the same primitives
// resolver.ts's schemaTables/entityTargets use under the hood (all exported from
// src/format/index.ts). This is an independent check of the raw store; ingest itself now reads
// it via the 'profile' mapping entity (used above for reactor-name resolution).
test('profiles (direct extraction — no mapping entity)', () => {
  const profileRows = extractProfiles(live);
  expect(profileRows.length).toEqual(ALL_PROFILES.length);
  const adaProfile = profileRows.find((r) => r.mri === STUDENTS[0].mri);
  expect(adaProfile?.displayName).toEqual('Ada Lovelace');
  expect(adaProfile?.email).toEqual('ada.lovelace@example.edu');
});

test('extractEntity: event', () => {
  expect(eventRows.length).toEqual(EVENTS.length);
  const cachedMeetingRow = eventRows.find((r) => r.id === 'evt-meeting-cached');
  expect(cachedMeetingRow?.subject).toEqual('CS101 Midterm Review Session');
  expect(cachedMeetingRow?.cid).toEqual('19:meeting_998877@thread.v2');
  expect(
    Array.isArray(cachedMeetingRow?.attendees) &&
      (cachedMeetingRow!.attendees as any[]).length === 4,
  ).toBe(true);
  const masterRow = eventRows.find((r) => r.id === 'evt-series-master');
  expect(masterRow?.eventType).toEqual('RecurringMaster');
  const confRow = eventRows.find((r) => r.id === 'evt-confidential-1on1');
  expect(confRow?.doNotForward).toEqual(true);
  expect(
    typeof confRow?.bodyContent === 'string' &&
      (confRow!.bodyContent as string).includes('secret-doc'),
  ).toBe(true);
});

test('extractEntity: call', () => {
  expect(callRows.length).toEqual(CALLS.length);
  const recordedCallRow = callRows.find((r) => r.id === 'call-4-recorded');
  const recordings = recordedCallRow?.recordings as any[] | undefined;
  expect(recordings?.[0]?.linkedMessage?.conversationId).toEqual('19:f1e2d3c4b5a6@thread.v2');
  expect(recordings?.[0]?.linkedMessage?.linkedMessageId).toEqual(
    String(CONVERSATIONS[1].messages[1].ts),
  );
  const multiPartyRow = callRows.find((r) => r.id === 'call-3-multiparty');
  expect(
    Array.isArray(multiPartyRow?.participantList) &&
      (multiPartyRow!.participantList as any[]).length === 3,
  ).toBe(true);
  const deletedCallRow = callRows.find((r) => r.id === 'call-5-deleted');
  expect(deletedCallRow?.isDeleted).toEqual(true);
});

test('end-to-end: ingest() + ChatStore', () => {
  expect(meta.schemaMatched === true).toBe(true);
  // Regression guard: chain_key must survive a plain SELECT read-back. Message keys are binary
  // leveldb keys with embedded NUL bytes; if chain_key were stored as raw latin1, node:sqlite would
  // truncate it at the first NUL and every value would read back as ''. It's hex-encoded to avoid
  // that — this asserts a real message's chain_key is non-empty and hex-shaped (would fail on revert).
  {
    const ck = (
      store.db.prepare(`select chain_key from messages where chain_key<>'' limit 1`).get() as any
    )?.chain_key;
    expect(
      typeof ck === 'string' && ck.length > 0 && /^[0-9a-f]+$/.test(ck),
      `got ${JSON.stringify(ck)}`,
    ).toBe(true);
  }
  expect(meta.counts.conversations).toEqual(CONVERSATIONS.length);
  expect(meta.counts.messages).toEqual(wantMsgCount);
  const ingestedEventCount = (store.db.prepare('select count(*) n from events').get() as any).n;
  expect(ingestedEventCount).toEqual(EVENTS.length - 1);
  const ingestedCallCount = (store.db.prepare('select count(*) n from calls').get() as any).n;
  expect(ingestedCallCount).toEqual(CALLS.length);
  const kindCounts = store.db
    .prepare('select kind, count(*) n from events group by kind')
    .all() as any[];
  const meetingKindCount = kindCounts.find((r) => r.kind === 'meeting')?.n ?? 0;
  const apptKindCount = kindCounts.find((r) => r.kind === 'appointment')?.n ?? 0;
  expect(meetingKindCount).toEqual(2);
  expect(apptKindCount).toEqual(EVENTS.length - 1 - 2);
  expect(meta.lossy === false).toBe(true);
});
