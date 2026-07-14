// Fixture correctness oracle AND the CI integration test.
// Generates the synthetic fixture into a temp dir, round-trips it through the SAME production
// readers the real Teams reader uses (src/format/*, src/ingest/*), asserts the decoded content
// matches what test/fixture/data.ts declared, and smoke-tests the whole MCP tool surface against
// it. Runs in CI with no real Teams cache (no PII). Exits non-zero on any failure.
//
// Run: node --experimental-sqlite --import tsx test/fixture/verify.ts  (or `npm run test:fixture`)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  loadEntries, fingerprint, loadMapping, selectMapping, extractEntity,
  decodePrefix, readStringWithLength, readVarint, utf16be, decodeValue,
} from '../../src/format/index.js'
import type { Entry } from '../../src/format/types.js'
import { ingest } from '../../src/ingest/ingest.js'
import { search, listConversations, topTopics, findPerson } from '../../src/tools.js'
import { generateFixture } from './generate.js'
import { ALL_PROFILES, CONVERSATIONS, STUDENTS } from './data.js'

let pass = 0, fail = 0
const ok = (name: string, cond: boolean, detail = ''): void => { if (cond) { pass++; console.log(`  PASS ${name}`) } else { fail++; console.log(`  FAIL ${name} ${detail}`) } }
const eq = (name: string, a: unknown, b: unknown): void => ok(name, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`)

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaungast-fixture-'))
generateFixture(dir)
console.log(`generated fixture at ${dir}`)

// ---- 1. loadEntries ----
console.log('\n=== loadEntries ===')
const { live, lossy, rawCount, uniqueCount } = loadEntries(dir)
ok('live.length > 0', live.length > 0, `live=${live.length}`)
ok('lossy === false', lossy === false)
console.log(`  raw=${rawCount} unique=${uniqueCount} live=${live.length}`)

// ---- 2. fingerprint + selectMapping ----
console.log('\n=== fingerprint / selectMapping ===')
const fp = fingerprint(live)
console.log(`  fingerprint hash=${fp.hash} stores=${fp.stores.map((s) => s.store).join(',')}`)
const VDIR = fileURLToPath(new URL('../../src/schema/versions/', import.meta.url))
const mappings = fs.readdirSync(VDIR).filter((f) => f.endsWith('.json')).map((f) => loadMapping(path.join(VDIR, f)))
const { mapping, via } = selectMapping(mappings, fp)
ok('mapping resolved', mapping?.schemaVersion === 'teams-2026-07', `via=${via} got=${mapping?.schemaVersion}`)
console.log(`  resolved via: ${via}`)

// ---- 3. extractEntity: conversation / message ----
console.log('\n=== extractEntity: conversation ===')
const convRows = extractEntity(live, mapping, 'conversation')
eq('conversation row count', convRows.length, CONVERSATIONS.length)
const channel = convRows.find((r) => r.id === '19:11223344aabb@thread.tacv2')
eq('channel topic extracted (threadProperties.topic)', channel?.topic, 'CS101 Algorithms - General')
eq('channel teamId extracted', channel?.teamId, 'team-cs101-guid-0000')
const dm = convRows.find((r) => r.id === '19:a1b2c3d4e5f6@unq.gbl.spaces')
ok('DM has no topic (threadProperties omitted)', dm?.topic === undefined || dm?.topic === null, `got ${JSON.stringify(dm?.topic)}`)

console.log('\n=== extractEntity: message ===')
const msgRows = extractEntity(live, mapping, 'message')
const wantMsgCount = CONVERSATIONS.reduce((n, c) => n + c.messages.length, 0)
eq('message row count', msgRows.length, wantMsgCount)
const adaFirst = CONVERSATIONS[0].messages[0]
const adaRow = msgRows.find((r) => r.id === String(adaFirst.ts))
eq('specific message content matches', adaRow?.content, adaFirst.content)
eq('specific message sender matches', adaRow?.senderName, 'Ada Lovelace')
eq('specific message conversationId matches', adaRow?.conversationId, CONVERSATIONS[0].id)
const mentionRow = msgRows.find((r) => r.content === 'Thanks bot! @Ada Lovelace can you share your notes?')
ok('mentions round-trip as JSON string', typeof mentionRow?.mentions === 'string' && (mentionRow!.mentions as string).includes('a1000000-0000-4000-8000-000000000001'))
const systemRows = msgRows.filter((r) => String(r.messageType).startsWith('ThreadActivity/'))
eq('system (ThreadActivity) message count', systemRows.length, 2) // AddMember + TopicUpdate
const selfRows = msgRows.filter((r) => r.isSentByCurrentUser === true)
eq('isSentByCurrentUser count (Ada authored)', selfRows.length, CONVERSATIONS.flatMap((c) => c.messages).filter((m) => m.isSentByCurrentUser).length)

// ---- 4. profiles: no mapping entity exists for this store yet, so extract it directly using
// the same primitives resolver.ts's schemaTables/entityTargets use under the hood (all exported
// from src/format/index.ts) rather than via extractEntity(mapping, 'profiles').
console.log('\n=== profiles (direct extraction — no mapping entity) ===')
function extractProfiles(entries: Entry[]): Record<string, unknown>[] {
  const dbNames = new Map<number, string>()
  const storeNames = new Map<string, string>()
  for (const { key, value } of entries) {
    if (key.length < 1) continue
    let p; try { p = decodePrefix(key) } catch { continue }
    if (p.databaseId === 0 && p.objectStoreId === 0 && p.indexId === 0 && key[p.headerLen] === 0xc9) {
      const [, p2] = readStringWithLength(key, p.headerLen + 1)
      const [name] = readStringWithLength(key, p2)
      const [id] = readVarint(value, 0)
      dbNames.set(id, name)
    } else if (p.databaseId > 0 && p.objectStoreId === 0 && p.indexId === 0 && key[p.headerLen] === 0x32) {
      const [osId, pp] = readVarint(key, p.headerLen + 1)
      if (key[pp] === 0) storeNames.set(`${p.databaseId}:${osId}`, utf16be(value))
    }
  }
  const targets = new Set<string>()
  for (const [sk, storeName] of storeNames) if (storeName === 'profiles') targets.add(sk)
  const rows: Record<string, unknown>[] = []
  for (const { key, value } of entries) {
    let p; try { p = decodePrefix(key) } catch { continue }
    if (p.indexId !== 1 || !targets.has(`${p.databaseId}:${p.objectStoreId}`)) continue
    try { rows.push(decodeValue(value) as Record<string, unknown>) } catch { /* skip */ }
  }
  return rows
}
const profileRows = extractProfiles(live)
eq('profile row count', profileRows.length, ALL_PROFILES.length)
const adaProfile = profileRows.find((r) => r.mri === STUDENTS[0].mri)
eq('profile displayName matches', adaProfile?.displayName, 'Ada Lovelace')
eq('profile email matches', adaProfile?.email, 'ada.lovelace@example.edu')

// ---- 5. bonus: end-to-end ingest() + ChatStore + search() ----
console.log('\n=== end-to-end: ingest() + ChatStore + search ===')
const { store, meta } = ingest(dir)
ok('ingest schemaMatched', meta.schemaMatched === true)
eq('ingest counts.conversations', meta.counts.conversations, CONVERSATIONS.length)
eq('ingest counts.messages', meta.counts.messages, wantMsgCount)
ok('ingest not lossy', meta.lossy === false)
const results = search(store, meta, false, { query: 'memoization', limit: 5 })
ok('search finds seeded content', /memoization/i.test(results), results.slice(0, 200))

// ---- 6. tool-surface smoke: every tool answers sanely off the fixture ----
console.log('\n=== tool surface (list / top_topics / find_person) ===')
const list = listConversations(store, meta, false, {})
ok('list_conversations shows a seeded conversation', /CS101|study-group|Algorithms/i.test(list), list.slice(0, 200))
const topics = topTopics(store, meta, false, {})
ok('top_topics returns non-empty output', topics.trim().length > 0)
const person = findPerson(store, meta, false, { name: 'Ada Lovelace' })
ok('find_person resolves a seeded student', /Ada Lovelace/i.test(person), person.slice(0, 200))
store.close()

fs.rmSync(dir, { recursive: true, force: true })

console.log(`\n==== ${pass} passed, ${fail} failed ====`)
process.exit(fail ? 1 : 0)
