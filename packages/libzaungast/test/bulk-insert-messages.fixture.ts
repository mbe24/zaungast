// Lever 1: bulkInsertMessages (full-build fold + multi-row insert) must produce a BYTE-IDENTICAL
// `messages` table to the per-row version-guarded upsert (applyMessages) for EVERY input ordering.
// The two are the same per-key state machine (accept iff version >= current; ties → later row); this
// pins that with adversarial duplicate-(conv,id) sequences — the exact cases where a naive fold would
// diverge (decreasing-then-equal versions, ties, undefined/string versions) — plus a set large enough
// to cross the 256-row multi-row-batch boundary AND leave a sub-batch remainder.
import { test, expect, beforeAll } from 'vitest';
import { ChatStore } from '../src/ingest/store.js';
import { applyMessages, bulkInsertMessages } from '../src/ingest/ingest-core.js';
import { createSqliteWasmDriver } from '../examples/sqlite-wasm-driver.js';
import type { SqlDriver } from '../src/ingest/sql-driver.js';

let driver: SqlDriver;
beforeAll(async () => {
  driver = await createSqliteWasmDriver();
});

// A minimal decoded-message record (the fields shapeMessageRow reads). Distinct content per occurrence
// so the dump reveals WHICH duplicate won. __key must be a Uint8Array (chain_key = hex(latin1(__key))).
let keySeq = 0;
function mkRow(conv: string, id: string, version: unknown, content: string) {
  return {
    conversationId: conv,
    id,
    version,
    time: 1000 + keySeq,
    content,
    senderId: '8:sender',
    senderName: 'S',
    __key: new Uint8Array([keySeq & 0xff, (keySeq++ >> 8) & 0xff, 0]),
  };
}

const MSG_COLS =
  'conv_id,id,chain_key,version,ts,sender_mri,sender_name,kind,is_mine,is_system,has_attach,mentions_me,content,reactions,root_id';
function dump(store: ChatStore) {
  return store.db.prepare(`select ${MSG_COLS} from messages order by conv_id,id`).all();
}

// Build one store via each path from the same rows, in a transaction like buildStore does.
function buildBoth(rows: any[]) {
  const perRow = new ChatStore(driver);
  perRow.db.exec('BEGIN');
  applyMessages(perRow, rows, null);
  perRow.db.exec('COMMIT');

  const bulk = new ChatStore(driver);
  bulk.db.exec('BEGIN');
  bulkInsertMessages(bulk, rows, null);
  bulk.db.exec('COMMIT');

  const a = dump(perRow);
  const b = dump(bulk);
  perRow.close();
  bulk.close();
  return { a, b };
}

test('adversarial duplicate-(conv,id) version orderings: bulk === per-row upsert', () => {
  const rows = [
    // increasing → last wins (v3)
    mkRow('c:1', 'm1', 1, 'm1-v1'),
    mkRow('c:1', 'm1', 2, 'm1-v2'),
    mkRow('c:1', 'm1', 3, 'm1-v3'),
    // decreasing then equal → v5(row0) then v3 rejected then v5(row2) accepted (>=): 3rd row wins
    mkRow('c:1', 'm2', 5, 'm2-v5a'),
    mkRow('c:1', 'm2', 3, 'm2-v3'),
    mkRow('c:1', 'm2', 5, 'm2-v5b'),
    // exact ties → later wins
    mkRow('c:2', 'm3', 7, 'm3-v7a'),
    mkRow('c:2', 'm3', 7, 'm3-v7b'),
    // undefined versions → normalized to 0,0 → tie → later wins
    mkRow('c:2', 'm4', undefined, 'm4-a'),
    mkRow('c:2', 'm4', undefined, 'm4-b'),
    // string versions → normalized numerically ("10" > "9") → "10" wins (lexicographic would flip)
    mkRow('c:3', 'm5', '9', 'm5-9'),
    mkRow('c:3', 'm5', '10', 'm5-10'),
    // interleaved across keys (order-sensitivity of the fold vs upsert)
    mkRow('c:3', 'm6', 2, 'm6-v2'),
    mkRow('c:3', 'm7', 1, 'm7-v1'),
    mkRow('c:3', 'm6', 1, 'm6-v1-reject'),
    // no conversationId → dropped by both
    { id: 'orphan', version: 1, __key: new Uint8Array([9, 9, 9]) },
  ];
  const { a, b } = buildBoth(rows);
  expect(b).toEqual(a);
  // Sanity: the winners are the ones the state machine predicts (not just "both empty").
  const byId = Object.fromEntries(a.map((r: any) => [r.id, r.content]));
  expect(byId.m1).toBe('m1-v3');
  expect(byId.m2).toBe('m2-v5b');
  expect(byId.m3).toBe('m3-v7b');
  expect(byId.m4).toBe('m4-b');
  expect(byId.m5).toBe('m5-10');
  expect(byId.m6).toBe('m6-v2');
  expect(a).toHaveLength(7); // m1..m7, orphan dropped
});

test('crosses the 256-row batch boundary + remainder, with duplicates: bulk === per-row upsert', () => {
  keySeq = 0;
  const rows: any[] = [];
  // 300 unique winners (→ one full 256-row batch + a 44-row remainder), each with an earlier
  // lower-version duplicate that must lose, plus interleaving so order isn't trivially sorted.
  for (let i = 0; i < 300; i++) rows.push(mkRow('c:big', `k${i}`, 1, `k${i}-old`));
  for (let i = 299; i >= 0; i--) rows.push(mkRow('c:big', `k${i}`, 2, `k${i}-new`));
  const { a, b } = buildBoth(rows);
  expect(b).toEqual(a);
  expect(a).toHaveLength(300);
  expect(a.every((r: any) => String(r.content).endsWith('-new'))).toBe(true);
});
