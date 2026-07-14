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
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { keyPrefix, stringWithLength, utf16beBytes, idbKeyString, idbValue, buildLog, type WalOpIn } from './encode.js'
import { ALL_PROFILES, CONVERSATIONS, type ConversationDef, type MessageDef } from './data.js'

const ORIGIN = 'https://teams.microsoft.com'

// Database/object-store layout. Real Teams splits these across separate IndexedDB databases;
// the mapping's entity defs glob-match `db` independently per entity ("*conversation-manager*",
// "*replychain-manager*"), so conversations/replychains must live in DIFFERENT db ids for
// entityTargets() to resolve correctly. `profiles` has no mapping entity (yet) — it's included
// anyway per the task brief, in its own db, purely for fingerprint/store-presence + manual use.
const DB_CONVERSATIONS = { id: 1, name: 'teams-conversation-manager', store: 'conversations', osId: 1 }
const DB_REPLYCHAINS = { id: 2, name: 'teams-replychain-manager', store: 'replychains', osId: 1 }
const DB_PROFILES = { id: 3, name: 'teams-profile-manager', store: 'profiles', osId: 1 }

function dbNameRow(dbId: number, dbName: string): { key: Buffer; value: Buffer } {
  const key = Buffer.concat([keyPrefix(0, 0, 0), Buffer.from([0xc9]), stringWithLength(ORIGIN), stringWithLength(dbName)])
  const value = Buffer.from([dbId]) // varint(dbId), dbId < 128 here so a single byte
  return { key, value }
}
function storeNameRow(dbId: number, osId: number, storeName: string): { key: Buffer; value: Buffer } {
  const key = Buffer.concat([keyPrefix(dbId, 0, 0), Buffer.from([0x32]), Buffer.from([osId]), Buffer.from([0x00])])
  const value = utf16beBytes(storeName)
  return { key, value }
}
function dataRow(dbId: number, osId: number, userKey: Buffer, record: Record<string, unknown>): { key: Buffer; value: Buffer } {
  const key = Buffer.concat([keyPrefix(dbId, osId, 1), userKey])
  const value = idbValue(record)
  return { key, value }
}

function messageId(m: MessageDef): string { return String(m.ts) }

function buildMessageRecord(m: MessageDef, conv: ConversationDef): Record<string, unknown> {
  const hasMentions = !!m.mentions
  const hasFiles = !!m.files
  return {
    id: messageId(m),
    type: 'Message', // the mapping's `keep` filter requires this literal value
    conversationId: conv.id,
    parentMessageId: '0',
    version: 1,
    originalArrivalTime: new Date(m.ts).toISOString(),
    creator: m.sender.mri,
    imDisplayName: m.sender.displayName,
    messageType: m.systemType ? `ThreadActivity/${m.systemType}` : (m.messageType ?? 'RichText/Html'),
    contentType: m.contentType ?? 'text',
    content: m.content,
    isSentByCurrentUser: !!m.isSentByCurrentUser,
    properties: (hasMentions || hasFiles)
      ? { mentions: hasMentions ? JSON.stringify(m.mentions) : undefined, files: hasFiles ? m.files : undefined }
      : undefined,
  }
}

function buildConversationRecord(conv: ConversationDef): Record<string, unknown> {
  const lastTs = conv.messages.reduce((max, m) => Math.max(max, m.ts), 0)
  return {
    id: conv.id,
    type: conv.type,
    teamId: conv.teamId,
    lastMessageTimeUtc: lastTs,
    threadProperties: conv.topic !== undefined ? { topic: conv.topic, threadType: conv.threadType } : undefined,
  }
}

function buildReplychainRecord(conv: ConversationDef): Record<string, unknown> {
  const messageMap: Record<string, unknown> = {}
  for (const m of conv.messages) messageMap[messageId(m)] = buildMessageRecord(m, conv)
  return { id: conv.id, conversationId: conv.id, messageMap }
}

// Assemble every leveldb (key,value) pair the fixture emits, in a fixed, deterministic order:
// db-name catalog rows, then store-name catalog rows, then data rows (conversations, then
// replychains, then profiles). Order only affects sequence-number assignment, not correctness.
function buildOps(): { key: Buffer; value: Buffer }[] {
  const ops: { key: Buffer; value: Buffer }[] = []

  ops.push(dbNameRow(DB_CONVERSATIONS.id, DB_CONVERSATIONS.name))
  ops.push(dbNameRow(DB_REPLYCHAINS.id, DB_REPLYCHAINS.name))
  ops.push(dbNameRow(DB_PROFILES.id, DB_PROFILES.name))

  ops.push(storeNameRow(DB_CONVERSATIONS.id, DB_CONVERSATIONS.osId, DB_CONVERSATIONS.store))
  ops.push(storeNameRow(DB_REPLYCHAINS.id, DB_REPLYCHAINS.osId, DB_REPLYCHAINS.store))
  ops.push(storeNameRow(DB_PROFILES.id, DB_PROFILES.osId, DB_PROFILES.store))

  for (const conv of CONVERSATIONS) {
    ops.push(dataRow(DB_CONVERSATIONS.id, DB_CONVERSATIONS.osId, idbKeyString(conv.id), buildConversationRecord(conv)))
  }
  for (const conv of CONVERSATIONS) {
    ops.push(dataRow(DB_REPLYCHAINS.id, DB_REPLYCHAINS.osId, idbKeyString(conv.id), buildReplychainRecord(conv)))
  }
  for (const p of ALL_PROFILES) {
    ops.push(dataRow(DB_PROFILES.id, DB_PROFILES.osId, idbKeyString(p.mri), { mri: p.mri, displayName: p.displayName, email: p.email, jobTitle: p.jobTitle, department: p.department }))
  }

  return ops
}

// Each op becomes its own single-op WriteBatch with a strictly increasing sequence number
// (LevelDB sequence numbers must never repeat or go backwards within a log).
function buildBatches(ops: { key: Buffer; value: Buffer }[]): { sequence: number; ops: WalOpIn[] }[] {
  return ops.map((op, i) => ({ sequence: i + 1, ops: [{ type: 1 as const, key: op.key, value: op.value }] }))
}

export function generateFixture(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
  const ops = buildOps()
  const batches = buildBatches(ops)
  const log = buildLog(batches)

  fs.writeFileSync(path.join(dir, '000003.log'), log)
  fs.writeFileSync(path.join(dir, 'CURRENT'), 'MANIFEST-000001\n')
  // Never parsed by the reader (discover.ts's isLevelDb only checks for presence) — a minimal
  // deterministic stub is enough.
  fs.writeFileSync(path.join(dir, 'MANIFEST-000001'), 'zaungast synthetic fixture stub manifest\n')
}

// Manual invocation: node --experimental-sqlite --import tsx test/fixture/generate.ts <outDir>
// NOTE: the `import.meta.url === \`file://${argv[1].replaceAll(...)}\`` pattern used by the
// production src/*.ts files' own main-blocks (write-ahead-log.ts, sstable.ts) does not actually
// match on Windows — a Windows file:// URL is `file:///C:/...` (three slashes before the drive
// letter), but that pattern only ever produces two, so the comparison is always false there and
// those CLI entrypoints silently no-op on Windows. This file isn't under src/, so it uses a
// robust, platform-correct comparison instead (real path equality) so manual invocation works.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outDir = process.argv[2]
  if (!outDir) { console.error('usage: generate.ts <outDir>'); process.exit(1) }
  generateFixture(outDir)
  console.log(`wrote synthetic fixture to ${outDir}`)
}
