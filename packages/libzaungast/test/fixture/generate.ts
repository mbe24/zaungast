// Synthetic Teams-IndexedDB-on-LevelDB fixture generator.
//
// Writes a WAL-only ("young") leveldb directory: everything lives in one .log file, no .ldb
// tables — loadEntries() reads a DB like this correctly (see the comment above its `includeLog`
// block in src/format/chromium/indexeddb.ts: "a freshly-compacted or young DB can hold all its
// data in the .log with no .ldb tables yet"). CURRENT + MANIFEST-000001 are minimal stubs so
// discover.ts's isLevelDb() (which only checks for their PRESENCE, never parses them) is happy.
//
// Fully deterministic: no Math.random, no Date.now()/no-arg new Date() — see data.ts's fixed
// BASE_TS. Two runs of generateFixture() produce byte-identical directory contents.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  keyPrefix,
  stringWithLength,
  utf16beBytes,
  idbKeyString,
  idbValue,
  buildLog,
  type WalOpIn,
} from './encode.js';
import { encodeTable, ldbKey } from './sstable-encode.js';
import { readTable } from '../../src/format/chromium/sstable.js';
import {
  ALL_PROFILES,
  CONVERSATIONS,
  EVENTS,
  CALLS,
  type ConversationDef,
  type MessageDef,
  type EventDef,
  type CallDef,
} from './data.js';

const ORIGIN = 'https://teams.microsoft.com';

// Database/object-store layout. Real Teams splits these across separate IndexedDB databases;
// the mapping's entity defs glob-match `db` independently per entity ("*conversation-manager*",
// "*replychain-manager*"), so conversations/replychains must live in DIFFERENT db ids for
// entityTargets() to resolve correctly. `profiles` has no mapping entity (yet) — it's included
// anyway per the task brief, in its own db, purely for fingerprint/store-presence + manual use.
const DB_CONVERSATIONS = {
  id: 1,
  name: 'teams-conversation-manager',
  store: 'conversations',
  osId: 1,
};
const DB_REPLYCHAINS = { id: 2, name: 'teams-replychain-manager', store: 'replychains', osId: 1 };
const DB_PROFILES = { id: 3, name: 'teams-profile-manager', store: 'profiles', osId: 1 };
// Glob-matched by the 'event'/'call' mapping entities: db "*calendar*" / "*call-history-manager*".
const DB_CALENDAR = { id: 4, name: 'teams-calendar-manager', store: 'calendar', osId: 1 };
const DB_CALLHISTORY = {
  id: 5,
  name: 'teams-call-history-manager',
  store: 'call-history',
  osId: 1,
};

function dbNameRow(dbId: number, dbName: string): { key: Buffer; value: Buffer } {
  const key = Buffer.concat([
    keyPrefix(0, 0, 0),
    Buffer.from([0xc9]),
    stringWithLength(ORIGIN),
    stringWithLength(dbName),
  ]);
  const value = Buffer.from([dbId]); // varint(dbId), dbId < 128 here so a single byte
  return { key, value };
}
function storeNameRow(
  dbId: number,
  osId: number,
  storeName: string,
): { key: Buffer; value: Buffer } {
  const key = Buffer.concat([
    keyPrefix(dbId, 0, 0),
    Buffer.from([0x32]),
    Buffer.from([osId]),
    Buffer.from([0x00]),
  ]);
  const value = utf16beBytes(storeName);
  return { key, value };
}
function dataRow(
  dbId: number,
  osId: number,
  userKey: Buffer,
  record: Record<string, unknown>,
): { key: Buffer; value: Buffer } {
  const key = Buffer.concat([keyPrefix(dbId, osId, 1), userKey]);
  const value = idbValue(record);
  return { key, value };
}

function messageId(m: MessageDef): string {
  return String(m.ts);
}

function buildMessageRecord(m: MessageDef, conv: ConversationDef): Record<string, unknown> {
  const hasMentions = !!m.mentions;
  const hasFiles = !!m.files;
  const hasReactions = !!m.reactions;
  return {
    id: messageId(m),
    type: 'Message', // the mapping's `keep` filter requires this literal value
    conversationId: conv.id,
    // Real Teams: a reply-chain ROOT's parentMessageId is its own id; each reply's is the root's
    // id. Mirror that so ingest derives root_id correctly (m.replyTo = the root message's ts).
    parentMessageId: m.replyTo != null ? String(m.replyTo) : messageId(m),
    version: 1,
    originalArrivalTime: new Date(m.ts).toISOString(),
    creator: m.sender.mri,
    imDisplayName: m.sender.displayName,
    messageType: m.systemType
      ? `ThreadActivity/${m.systemType}`
      : (m.messageType ?? 'RichText/Html'),
    contentType: m.contentType ?? 'text',
    content: m.content,
    isSentByCurrentUser: !!m.isSentByCurrentUser,
    properties:
      hasMentions || hasFiles || hasReactions
        ? {
            mentions: hasMentions ? JSON.stringify(m.mentions) : undefined,
            files: hasFiles ? m.files : undefined,
            // Real shape: an array of { key, users: [ { mri, time } ] }, stored as-is (not
            // stringified) — encodeValue already recurses through nested arrays/objects.
            emotions: hasReactions ? m.reactions : undefined,
          }
        : undefined,
  };
}

function buildConversationRecord(conv: ConversationDef): Record<string, unknown> {
  const lastTs = conv.messages.reduce((max, m) => Math.max(max, m.ts), 0);
  return {
    id: conv.id,
    type: conv.type,
    teamId: conv.teamId,
    lastMessageTimeUtc: lastTs,
    threadProperties:
      conv.topic !== undefined ? { topic: conv.topic, threadType: conv.threadType } : undefined,
  };
}

function buildReplychainRecord(conv: ConversationDef): Record<string, unknown> {
  const messageMap: Record<string, unknown> = {};
  for (const m of conv.messages) messageMap[messageId(m)] = buildMessageRecord(m, conv);
  return { id: conv.id, conversationId: conv.id, messageMap };
}

// Inverse of the 'event' mapping entity (the bundled Teams mapping): field names
// here are the RAW Teams calendar record's, not the mapped/derived ones. NOTE: real Teams data
// decodes startTime/endTime as an actual structured-clone Date (see ingest.ts's toEpochMs doc) —
// the fixture's encodeValue has no Date case, so these travel as plain ISO strings instead;
// ingest's toEpochMs accepts both.
function buildEventRecord(e: EventDef): Record<string, unknown> {
  return {
    objectId: e.objectId,
    seriesMasterId: e.seriesMasterId ?? undefined,
    subject: e.subject,
    startTime: e.startTime,
    endTime: e.endTime,
    isAllDayEvent: e.isAllDayEvent,
    location: e.location,
    organizerName: e.organizerName,
    organizerAddress: e.organizerAddress,
    isOnlineMeeting: e.isOnlineMeeting,
    skypeTeamsDataObject: e.cid ? { cid: e.cid } : undefined,
    isAppointment: e.isAppointment,
    myResponseType: e.myResponseType,
    showAs: e.showAs,
    isCancelled: e.isCancelled,
    eventType: e.eventType ?? undefined,
    sensitivityLabelId: e.sensitivityLabelId ?? undefined,
    doNotForward: e.doNotForward,
    hasAttachments: e.hasAttachments,
    attendees: e.attendees?.map((a) => ({
      name: a.name,
      address: a.address,
      role: 'User', // real Teams: role is uniformly "User"; the distinction is in `type`
      type: a.type ?? 'Required',
      status: { response: a.response ?? 'None' },
    })),
    bodyContent: e.bodyContent,
  };
}

// Inverse of the 'call' mapping entity. `conversationId` (48:calllogs, deliberately unmapped
// for privacy) is intentionally NOT emitted here: this fixture only ever writes
// fields the reader is actually meant to touch.
function buildCallRecord(c: CallDef): Record<string, unknown> {
  return {
    callId: c.callId,
    callType: c.callType,
    callDirection: c.callDirection,
    callState: c.callState,
    startTime: c.startTime,
    durationInMs: c.durationInMs,
    originatorParticipant: { id: c.originator.mri, displayName: c.originator.displayName ?? null },
    targetParticipant: { id: c.target.mri, displayName: c.target.displayName ?? null },
    participantList: c.participantList?.map((p) => ({
      id: p.mri,
      displayName: p.displayName ?? null,
    })),
    groupChatThreadId: c.groupChatThreadId,
    recordings: c.recordingLink
      ? [
          {
            id: `rec-${c.callId}`,
            contentTypes: c.hasTranscript ? 'Recording+Transcript' : 'Recording',
            linkedMessage: {
              conversationId: c.recordingLink.conversationId,
              linkedMessageId: c.recordingLink.linkedMessageId,
            },
          },
        ]
      : undefined,
    isDeleted: c.isDeleted,
  };
}

// Assemble every leveldb (key,value) pair the fixture emits, in a fixed, deterministic order:
// db-name catalog rows, then store-name catalog rows, then data rows (conversations, then
// replychains, then profiles). Order only affects sequence-number assignment, not correctness.
function buildOps(): { key: Buffer; value: Buffer }[] {
  const ops: { key: Buffer; value: Buffer }[] = [];

  ops.push(
    dbNameRow(DB_CONVERSATIONS.id, DB_CONVERSATIONS.name),
    dbNameRow(DB_REPLYCHAINS.id, DB_REPLYCHAINS.name),
    dbNameRow(DB_PROFILES.id, DB_PROFILES.name),
    dbNameRow(DB_CALENDAR.id, DB_CALENDAR.name),
    dbNameRow(DB_CALLHISTORY.id, DB_CALLHISTORY.name),
  );

  ops.push(
    storeNameRow(DB_CONVERSATIONS.id, DB_CONVERSATIONS.osId, DB_CONVERSATIONS.store),
    storeNameRow(DB_REPLYCHAINS.id, DB_REPLYCHAINS.osId, DB_REPLYCHAINS.store),
    storeNameRow(DB_PROFILES.id, DB_PROFILES.osId, DB_PROFILES.store),
    storeNameRow(DB_CALENDAR.id, DB_CALENDAR.osId, DB_CALENDAR.store),
    storeNameRow(DB_CALLHISTORY.id, DB_CALLHISTORY.osId, DB_CALLHISTORY.store),
  );

  for (const conv of CONVERSATIONS) {
    ops.push(
      dataRow(
        DB_CONVERSATIONS.id,
        DB_CONVERSATIONS.osId,
        idbKeyString(conv.id),
        buildConversationRecord(conv),
      ),
    );
  }
  for (const conv of CONVERSATIONS) {
    ops.push(
      dataRow(
        DB_REPLYCHAINS.id,
        DB_REPLYCHAINS.osId,
        idbKeyString(conv.id),
        buildReplychainRecord(conv),
      ),
    );
  }
  for (const p of ALL_PROFILES) {
    ops.push(
      dataRow(DB_PROFILES.id, DB_PROFILES.osId, idbKeyString(p.mri), {
        mri: p.mri,
        displayName: p.displayName,
        email: p.email,
        jobTitle: p.jobTitle,
        department: p.department,
      }),
    );
  }
  for (const e of EVENTS) {
    ops.push(
      dataRow(DB_CALENDAR.id, DB_CALENDAR.osId, idbKeyString(e.objectId), buildEventRecord(e)),
    );
  }
  for (const c of CALLS) {
    ops.push(
      dataRow(DB_CALLHISTORY.id, DB_CALLHISTORY.osId, idbKeyString(c.callId), buildCallRecord(c)),
    );
  }

  return ops;
}

// Each op becomes its own single-op WriteBatch with a strictly increasing sequence number
// (LevelDB sequence numbers must never repeat or go backwards within a log).
function buildBatches(
  ops: { key: Buffer; value: Buffer }[],
): { sequence: number; ops: WalOpIn[] }[] {
  return ops.map((op, i) => ({
    sequence: i + 1,
    ops: [{ type: 1 as const, key: op.key, value: op.value }],
  }));
}

export function generateFixture(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const ops = buildOps();
  const batches = buildBatches(ops);
  const log = buildLog(batches);

  fs.writeFileSync(path.join(dir, '000003.log'), log);
  fs.writeFileSync(path.join(dir, 'CURRENT'), 'MANIFEST-000001\n');
  // Never parsed by the reader (discover.ts's isLevelDb only checks for presence) — a minimal
  // deterministic stub is enough.
  fs.writeFileSync(path.join(dir, 'MANIFEST-000001'), 'zaungast synthetic fixture stub manifest\n');
}

// ---- Mixed .ldb + .log layout (copy-reuse / equivalence tests need this — a WAL-only dir never
// exercises readTable()/loadEntriesReuse()'s .ldb-cache path at all) ----
//
// buildOps() returns one (key,value) op per leveldb record, IN THE SAME DETERMINISTIC ORDER
// generateFixture() uses. We assign each op a strictly-increasing sequence number in that order,
// then split the sequence range: the OLDER prefix becomes one or more .ldb tables (immutable,
// as real compacted tables are), and the NEWER suffix stays in the .log — mirroring a real
// LevelDB directory where the WAL always holds the most-recently-written (highest-sequence) data
// not yet flushed/compacted. `ldbFraction` (default 0.7) controls how much of the data is
// "older" (in tables) vs. "newer" (in the log); `ldbFileCount` (default 2) splits that older
// portion across that many separate .ldb files (contiguous seq ranges per file — like separate
// flushes/levels) so tests that need >1 .ldb (e.g. "a flush appears", "compaction removes one of
// several tables") have something to work with out of the box.
export interface TablesFixtureOptions {
  ldbFraction?: number;
  ldbFileCount?: number;
}

export function generateFixtureWithTables(dir: string, opts: TablesFixtureOptions = {}): void {
  const { ldbFraction = 0.7, ldbFileCount = 2 } = opts;
  fs.mkdirSync(dir, { recursive: true });
  const ops = buildOps();
  const n = ops.length;
  const ldbCount = Math.max(ldbFileCount, Math.round(n * ldbFraction)); // ensure room for ldbFileCount files
  const ldbOps = ops.slice(0, ldbCount);
  const logOps = ops.slice(ldbCount);

  // Split the older prefix into `ldbFileCount` contiguous, non-overlapping seq ranges — each its
  // own standalone .ldb file. seq = 1-based position in `ops` (matches buildBatches()'s scheme).
  const perFile = Math.ceil(ldbOps.length / ldbFileCount);
  for (let i = 0; i < ldbFileCount; i++) {
    const slice = ldbOps.slice(i * perFile, (i + 1) * perFile);
    if (slice.length === 0) continue;
    const seqBase = i * perFile;
    const tableEntries = slice.map((op, j) => ({
      key: ldbKey(op.key, BigInt(seqBase + j + 1), 1),
      value: op.value,
    }));
    fs.writeFileSync(path.join(dir, `00000${4 + i}.ldb`), encodeTable(tableEntries));
  }

  const logBatches = logOps.map((op, i) => ({
    sequence: ldbCount + i + 1,
    ops: [{ type: 1 as const, key: op.key, value: op.value }],
  }));
  fs.writeFileSync(path.join(dir, `00000${4 + ldbFileCount}.log`), buildLog(logBatches));

  fs.writeFileSync(path.join(dir, 'CURRENT'), 'MANIFEST-000001\n');
  fs.writeFileSync(
    path.join(dir, 'MANIFEST-000001'),
    'zaungast synthetic fixture stub manifest (tables)\n',
  );
}

// ---- Mutation / compaction helpers for equivalence tests (applied to a dir already produced by
// generateFixtureWithTables, typically a copy so the original fixture stays pristine) ----

// Append a brand-new .log file holding one WriteBatch per op, sequence numbers starting at
// `startSeq` — simulates new writes landing in the WAL (a plain append / edit / new message).
export function appendLog(
  dir: string,
  filename: string,
  ops: { key: Buffer; value: Buffer; type?: 0 | 1 }[],
  startSeq: number,
): void {
  const batches = ops.map((op, i) => ({
    sequence: startSeq + i,
    ops: [
      op.type === 0
        ? { type: 0 as const, key: op.key }
        : { type: 1 as const, key: op.key, value: op.value as Buffer },
    ],
  }));
  fs.writeFileSync(path.join(dir, filename), buildLog(batches));
}

// Remove an .ldb file — simulates a compaction input disappearing (loadEntriesReuse must detect
// this via its `compacted` flag and the caller must force a full rebuild).
export function removeLdb(dir: string, filename: string): void {
  fs.rmSync(path.join(dir, filename));
}

// Rewrite an existing .ldb file, dropping entries whose (userKey) trailer-stripped bytes match
// `dropUserKey` — simulates a real compaction eliding a tombstoned/dead key entirely (as opposed
// to `removeLdb`, which drops a WHOLE table). Reads the table back with the production reader
// (readTable) so this stays a faithful "recompact" rather than a hand-rolled parse.
export function rewriteLdbDropping(dir: string, filename: string, dropUserKey: Buffer): void {
  const { entries } = readTable(path.join(dir, filename));
  const kept = entries.filter(([ikey]) => Buffer.compare(ikey.subarray(0, -8), dropUserKey) !== 0);
  fs.writeFileSync(
    path.join(dir, filename),
    encodeTable(kept.map(([key, value]) => ({ key, value }))),
  );
}

// Manual invocation: node --experimental-sqlite --import tsx test/fixture/generate.ts <outDir>
// NOTE: the `import.meta.url === \`file://${argv[1].replaceAll(...)}\`` pattern used by the
// production src/*.ts files' own main-blocks (write-ahead-log.ts, sstable.ts) does not actually
// match on Windows — a Windows file:// URL is `file:///C:/...` (three slashes before the drive
// letter), but that pattern only ever produces two, so the comparison is always false there and
// those CLI entrypoints silently no-op on Windows. This file isn't under src/, so it uses a
// robust, platform-correct comparison instead (real path equality) so manual invocation works.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outDir = process.argv[2];
  const tables = process.argv.includes('--tables');
  if (!outDir) {
    console.error('usage: generate.ts <outDir> [--tables]');
    process.exit(1);
  }
  if (tables) generateFixtureWithTables(outDir);
  else generateFixture(outDir);
  console.log(`wrote synthetic fixture (${tables ? '.ldb+.log' : 'WAL-only'}) to ${outDir}`);
}
