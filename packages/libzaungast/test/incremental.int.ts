import { test, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveLevelDbDir } from '../../../scripts/native-runner.mjs';
import { generateFixtureWithTables } from './fixture/generate.js';
import { ingest, applyIncremental, type IngestState } from '../src/ingest/ingest.js';
import { ChatStore } from '../src/ingest/store.js';
import {
  loadSnapshot,
  entityTargets,
  loadMapping,
  selectMapping,
  fingerprint,
} from '../src/format/index.js';
import { loadEntries } from '../src/format/chromium/indexeddb.js'; // internal (not public /format)
import { crc32c } from '../src/format/chromium/sstable.js';

function maskCrc(c: number): number {
  return (((c >>> 15) | (c << 17)) + 0xa282ead8) >>> 0;
}
function varint(n: number): Buffer {
  const b: number[] = [];
  while (n >= 0x80) {
    b.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  b.push(n);
  return Buffer.from(b);
}
// Craft a leveldb .log holding one WriteBatch that DELETES (tombstones) a user key.
function craftDeletionLog(userKey: Buffer, seq: number): Buffer {
  const batch = Buffer.concat([
    (() => {
      const s = Buffer.alloc(8);
      s.writeBigUInt64LE(BigInt(seq));
      return s;
    })(),
    (() => {
      const c = Buffer.alloc(4);
      c.writeUInt32LE(1);
      return c;
    })(), // count=1
    Buffer.from([0]), // op type 0 = deletion
    varint(userKey.length),
    userKey,
  ]);
  const type = Buffer.from([1]); // FULL record
  const crc = Buffer.alloc(4);
  crc.writeUInt32LE(maskCrc(crc32c(Buffer.concat([type, batch]), 0, 1 + batch.length)));
  const len = Buffer.alloc(2);
  len.writeUInt16LE(batch.length);
  return Buffer.concat([crc, len, type, batch]);
}

let dir: string;
let synthetic = false;
beforeAll(() => {
  const real = resolveLevelDbDir(process.env.ZAUNGAST_TEST_DIR);
  if (real) {
    dir = real;
  } else {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaungast-incr-'));
    generateFixtureWithTables(dir);
    synthetic = true;
  }
});
afterAll(() => {
  if (synthetic) fs.rmSync(dir, { recursive: true, force: true });
});

// canonical dump of all derived state, handles excluded (handle assignment order can differ)
function dump(store: ChatStore): string {
  const db = store.db;
  const msgs = db
    .prepare(
      `select conv_id,id,chain_key,version,ts,sender_mri,sender_name,kind,is_mine,is_system,has_attach,mentions_me,content
    from messages order by conv_id,id`,
    )
    .all();
  const convs = db
    .prepare(
      `select id,kind,topic,team_id,meta_last_ts,msg_count,participant_names,participant_count,activity_ts,last_ts
    from conversations order by id`,
    )
    .all();
  const ppl = db.prepare(`select mri,name,msg_count,last_ts from people order by mri`).all();
  return JSON.stringify({ msgs, convs, ppl });
}
function ftsConsistent(store: ChatStore): boolean {
  const db = store.db;
  const a = db
    .prepare(`select group_concat(id) g from (select id from messages_fts order by id)`)
    .get() as any;
  const b = db
    .prepare(
      `select group_concat(id) g from (select id from messages where is_system=0 and content<>'' order by id)`,
    )
    .get() as any;
  return (a?.g ?? null) === (b?.g ?? null);
}
// Full FTS CONTENT dump (not just membership) — so a delta FTS refresh that left stale
// content on a changed id, or failed to drop a deleted id, is caught against a full rebuild.
function ftsDump(store: ChatStore): string {
  return JSON.stringify(
    store.db.prepare(`select id, conv_id, content from messages_fts order by id`).all(),
  );
}
const VDIR = fileURLToPath(new URL('../src/schema/versions/', import.meta.url));
function getMapping(snap: any) {
  const mappings = fs
    .readdirSync(VDIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => loadMapping(path.join(VDIR, f)));
  return selectMapping(fingerprint(snap), { mappings }).mapping;
}
function msgStoreKey(snap: any): Buffer | null {
  const targets: Set<string> = entityTargets(snap, getMapping(snap), 'message');
  // buckets already hold ONLY indexId===1 (data) records, in dedup-insertion order — the same
  // first message-store record key the old decodePrefix scan-loop would have returned.
  for (const sk of targets) {
    const b = snap.buckets.get(sk);
    if (b?.records.length) return b.records[0].key;
  }
  return null;
}
// median seq among message-store records → guarantees a real delta for the incremental
function midSeq(dir: string): number {
  const snap = loadSnapshot(dir);
  const targets: Set<string> = entityTargets(snap, getMapping(snap), 'message');
  const seqs: number[] = [];
  for (const sk of targets) {
    const b = snap.buckets.get(sk);
    if (b) for (const rec of b.records) seqs.push(rec.seq);
  }
  seqs.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return seqs[Math.floor(seqs.length / 2)];
}
function copyDir(src: string): string {
  const dst = fs.mkdtempSync(path.join(os.tmpdir(), 'inctest-'));
  for (const f of fs.readdirSync(src)) fs.copyFileSync(path.join(src, f), path.join(dst, f));
  return dst;
}

test('A. spine: partial(seqCap) + incremental == full rebuild', () => {
  const cap = midSeq(dir);
  const partial = ingest(dir, { seqCap: cap });
  const nBefore = (partial.store.db.prepare('select count(*) n from messages').get() as any).n;
  const r = applyIncremental(partial.store, partial.state as IngestState, dir);
  const full = ingest(dir);
  const nAfter = (partial.store.db.prepare('select count(*) n from messages').get() as any).n;
  expect(
    nAfter > nBefore,
    `partial had ${nBefore} msgs (cap seq ${cap}), incremental → ${nAfter}`,
  ).toBe(true);
  expect(r.needFullRebuild === false, 'no schema-change fallback').toBe(true);
  expect(dump(partial.store) === dump(full.store), 'incremental store == full rebuild').toBe(true);
  expect(ftsConsistent(partial.store), 'FTS consistent (incremental)').toBe(true);
  expect(ftsConsistent(full.store), 'FTS consistent (full)').toBe(true);
  expect(
    ftsDump(partial.store) === ftsDump(full.store),
    'FTS content == full rebuild (delta refresh)',
  ).toBe(true);
  partial.store.close();
  full.store.close();
});

test('B. no-op incremental on unchanged dir', () => {
  const s = ingest(dir);
  const before = dump(s.store);
  applyIncremental(s.store, s.state as IngestState, dir);
  expect(dump(s.store) === before, 'no-op incremental leaves store identical').toBe(true);
  s.store.close();
});

test('C. idempotency: incremental twice', () => {
  const cap = midSeq(dir);
  const p = ingest(dir, { seqCap: cap });
  applyIncremental(p.store, p.state as IngestState, dir);
  (p.state as IngestState).maxSeq = loadEntries(dir).maxSeq;
  const after1 = dump(p.store);
  applyIncremental(p.store, p.state as IngestState, dir);
  expect(dump(p.store) === after1, 'second incremental is a no-op').toBe(true);
  p.store.close();
});

test('D. deletion sweep: tombstone chains of size 1 / mid / max → count drops by EXACTLY N, == full', () => {
  const snap = loadSnapshot(dir);
  const maxSeq = snap.maxSeq;
  const targets = entityTargets(snap, getMapping(snap), 'message');
  // Discover each message-store DATA record's chain size (rows it owns) from one ingest, so the
  // sweep adapts to whatever capture is pointed at it. chain_key is hex-encoded in the store, so
  // match on e.key.toString('hex'). Buckets already hold only indexId===1 records, so no key
  // re-decode / indexId re-check is needed here (matches the old decodePrefix-filtered scan).
  const disc = ingest(dir);
  const owns = disc.store.db.prepare('select count(*) n from messages where chain_key=?');
  const cands: { key: Buffer; n: number }[] = [];
  for (const sk of targets) {
    const b = snap.buckets.get(sk);
    if (!b) continue;
    for (const e of b.records) {
      const n = (owns.get(e.key.toString('hex')) as any).n;
      if (n > 0) cands.push({ key: e.key, n });
    }
  }
  disc.store.close();
  cands.sort((a, b) => a.n - b.n);
  const multi = cands.filter((c) => c.n > 1);
  // size 1, a representative MULTI-message chain (median of the >1 set — NOT the numeric median,
  // which is 1 since ~98% of chains hold a single message), and the largest chain present.
  const picks: [string, { key: Buffer; n: number }][] = [
    ['size-1', cands[0]],
    ['mid', multi[Math.floor(multi.length / 2)] ?? cands[cands.length - 1]],
    ['max', cands[cands.length - 1]],
  ];
  for (const [label, v] of picks) {
    const modified = copyDir(dir);
    fs.writeFileSync(path.join(modified, 'zzz999.log'), craftDeletionLog(v.key, maxSeq + 1000));
    const partial = ingest(dir);
    const before = (partial.store.db.prepare('select count(*) n from messages').get() as any).n;
    applyIncremental(partial.store, partial.state as IngestState, modified);
    const after = (partial.store.db.prepare('select count(*) n from messages').get() as any).n;
    const full = ingest(modified);
    expect(
      before - after === v.n,
      `[${label}] tombstoned a chain owning ${v.n} → count drops by exactly ${v.n} (${before}→${after})`,
    ).toBe(true);
    expect(
      dump(partial.store) === dump(full.store),
      `[${label}] incremental == full rebuild of modified`,
    ).toBe(true);
    expect(ftsConsistent(partial.store), `[${label}] FTS consistent after deletion`).toBe(true);
    expect(
      ftsDump(partial.store) === ftsDump(full.store),
      `[${label}] FTS content == full rebuild after deletion`,
    ).toBe(true);
    partial.store.close();
    full.store.close();
    fs.rmSync(modified, { recursive: true, force: true });
  }
});

test('E. Session end-to-end: warm full → mutate → incremental refresh', async () => {
  const { Session } = await import('../src/session.js');
  const copy = copyDir(dir);
  const s = new (Session as any)({
    overrideDir: copy,
    minDebounceMs: 0,
    maxIncrementals: 2,
    incrementalMode: 'reparse',
  });
  const m0 = s.refreshNow(true); // full
  expect(
    m0.refreshMode === 'full' && m0.counts.messages > 0,
    'warm-up is a full ingest with data',
  ).toBe(true);
  const before = m0.counts.messages;
  // mutate: tombstone a chain
  const snap = loadSnapshot(copy);
  fs.writeFileSync(
    path.join(copy, 'zz0.log'),
    craftDeletionLog(msgStoreKey(snap)!, snap.maxSeq + 1000),
  );
  const m1 = s.refreshNow(false); // incremental
  expect(m1.refreshMode === 'incremental', 'refresh after mutation is incremental').toBe(true);
  expect(m1.counts.messages < before, 'incremental via Session dropped the tombstoned chain').toBe(
    true,
  );
  s.dispose();
  fs.rmSync(copy, { recursive: true, force: true });
});

test('F. backstop: full every maxIncrementals refreshes', async () => {
  const { Session } = await import('../src/session.js');
  const copy = copyDir(dir);
  const s = new (Session as any)({
    overrideDir: copy,
    minDebounceMs: 0,
    maxIncrementals: 2,
    incrementalMode: 'reparse',
  });
  s.refreshNow(true); // full
  const modes: string[] = [];
  for (let i = 0; i < 4; i++) modes.push(s.refreshNow(false).refreshMode);
  expect(
    modes[0] === 'incremental' && modes[1] === 'incremental' && modes[2] === 'full',
    `backstop forces a full at the Nth incremental (modes: ${modes.join(', ')})`,
  ).toBe(true);
  s.dispose();
  fs.rmSync(copy, { recursive: true, force: true });
});

test('G. multi-step: two effectful incrementals (add then delete) == full of final', () => {
  const copy = copyDir(dir);
  const cap = midSeq(copy);
  const s = ingest(copy, { seqCap: cap });
  applyIncremental(s.store, s.state as IngestState, copy);
  (s.state as IngestState).maxSeq = loadEntries(copy).maxSeq; // step 1: catch up
  const n1 = (s.store.db.prepare('select count(*) n from messages').get() as any).n;
  const snap = loadSnapshot(copy);
  fs.writeFileSync(
    path.join(copy, 'zzz1.log'),
    craftDeletionLog(msgStoreKey(snap)!, snap.maxSeq + 1000),
  ); // step 2: delete
  applyIncremental(s.store, s.state as IngestState, copy);
  (s.state as IngestState).maxSeq = loadEntries(copy).maxSeq;
  const n2 = (s.store.db.prepare('select count(*) n from messages').get() as any).n;
  const full = ingest(copy);
  expect(n1 > 0 && n2 < n1, 'step1 caught up, step2 deleted').toBe(true);
  expect(dump(s.store) === dump(full.store), 'two-step incremental == full of final').toBe(true);
  s.store.close();
  full.store.close();
  fs.rmSync(copy, { recursive: true, force: true });
});

test('H. lossy load MUST NOT mass-delete (Hole 1 regression)', () => {
  const corrupt = copyDir(dir);
  const ldb = fs
    .readdirSync(corrupt)
    .filter((f) => f.endsWith('.ldb'))
    .sort()[0];
  const p = path.join(corrupt, ldb);
  const buf = fs.readFileSync(p);
  fs.writeFileSync(p, buf.subarray(0, Math.floor(buf.length / 2))); // truncate → bad footer/index
  const s = ingest(dir); // full, all messages
  const before = (s.store.db.prepare('select count(*) n from messages').get() as any).n;
  const r = applyIncremental(s.store, s.state as IngestState, corrupt); // lossy target
  const after = (s.store.db.prepare('select count(*) n from messages').get() as any).n;
  expect(r.skipped === true, 'lossy load returns skipped').toBe(true);
  expect(after === before, 'store NOT mass-deleted on lossy load').toBe(true);
  s.store.close();
  fs.rmSync(corrupt, { recursive: true, force: true });
});

test('I. store-level: edit + soft-delete update flags and FTS (Hole 3)', () => {
  const st = new ChatStore();
  const base = {
    convId: 'c',
    chainKey: 'k',
    ts: 1,
    senderMri: 'm',
    senderName: 'A',
    kind: 'chat',
    isMine: 0,
    hasAttach: 0,
    mentionsMe: 0,
  };
  st.insertMessage({ ...base, id: '1', version: 1, isSystem: 0, content: 'hello world' });
  st.refreshFts(null);
  expect(
    (
      st.db
        .prepare("select count(*) n from messages_fts where messages_fts match 'hello'")
        .get() as any
    ).n === 1,
    'v1 findable in FTS',
  ).toBe(true);
  // edit: new content, same id, higher version
  st.insertMessage({ ...base, id: '1', version: 2, isSystem: 0, content: 'edited text' });
  st.refreshFts(null);
  expect(
    (
      st.db
        .prepare("select count(*) n from messages_fts where messages_fts match 'hello'")
        .get() as any
    ).n === 0,
    'edit: old token gone',
  ).toBe(true);
  expect(
    (
      st.db
        .prepare("select count(*) n from messages_fts where messages_fts match 'edited'")
        .get() as any
    ).n === 1,
    'edit: new token found',
  ).toBe(true);
  // soft-delete: content cleared, is_system flips (SET must update is_system)
  st.insertMessage({ ...base, id: '1', version: 3, isSystem: 1, content: '' });
  st.refreshFts(null);
  expect(
    (st.db.prepare('select is_system from messages where id=?').get('1') as any).is_system === 1,
    'soft-delete: is_system updated on conflict',
  ).toBe(true);
  expect(
    (
      st.db
        .prepare("select count(*) n from messages_fts where messages_fts match 'edited'")
        .get() as any
    ).n === 0,
    'soft-delete: dropped from FTS',
  ).toBe(true);
  st.close();
});

test('J. tripwire: mapped-store target change → full rebuild; irrelevant churn → not', () => {
  const s = ingest(dir);
  const rNeg = applyIncremental(s.store, s.state as IngestState, dir);
  expect(rNeg.needFullRebuild === false, 'irrelevant dynamic-store churn does NOT trip').toBe(true);
  (s.state as IngestState).msgTargets = new Set([
    ...(s.state as IngestState).msgTargets,
    '99999:1',
  ]); // simulate our store having moved
  const rPos = applyIncremental(s.store, s.state as IngestState, dir);
  expect(rPos.needFullRebuild === true, 'changed mapped targets trip a full rebuild').toBe(true);
  s.store.close();
});

test('K. Session cold-start lossy full is flagged and self-heals', async () => {
  const { Session } = await import('../src/session.js');
  const corrupt = copyDir(dir);
  const ldb = fs
    .readdirSync(corrupt)
    .filter((f) => f.endsWith('.ldb'))
    .sort()[0];
  const good = fs.readFileSync(path.join(dir, ldb));
  fs.writeFileSync(path.join(corrupt, ldb), good.subarray(0, Math.floor(good.length / 2))); // truncate → lossy
  const s = new (Session as any)({
    overrideDir: corrupt,
    minDebounceMs: 0,
    incrementalMode: 'reparse',
  });
  const m1 = s.refreshNow(true);
  expect(m1.lossy === true, 'cold-start lossy full is flagged in meta').toBe(true);
  fs.copyFileSync(path.join(dir, ldb), path.join(corrupt, ldb)); // restore → clean
  const m2 = s.refreshNow(true);
  expect(m2.lossy === false && m2.counts.messages > 0, 'a clean full clears the lossy flag').toBe(
    true,
  );
  s.dispose();
  fs.rmSync(corrupt, { recursive: true, force: true });
});

test('L. hardening: post-COMMIT recompute throw → needFullRebuild (not a stuck store)', () => {
  const copy = copyDir(dir);
  const cap = midSeq(copy);
  const s = ingest(copy, { seqCap: cap });
  const snap = loadSnapshot(copy);
  fs.writeFileSync(
    path.join(copy, 'zzz2.log'),
    craftDeletionLog(msgStoreKey(snap)!, snap.maxSeq + 1000),
  );
  const orig = s.store.recomputeDerived.bind(s.store);
  (s.store as any).recomputeDerived = () => {
    throw new Error('boom (simulated post-commit failure)');
  };
  const r = applyIncremental(s.store, s.state as IngestState, copy);
  expect(r.needFullRebuild === true, 'post-commit throw returns needFullRebuild').toBe(true);
  (s.store as any).recomputeDerived = orig;
  // store is not left mid-transaction: a normal write still works
  let writable = true;
  try {
    s.store.db.exec('BEGIN');
    s.store.db.exec('COMMIT');
  } catch {
    writable = false;
  }
  expect(writable, 'store not left in an open transaction').toBe(true);
  s.store.close();
  fs.rmSync(copy, { recursive: true, force: true });
});

test('M. hardening: Session leaves no temp snapshot dir behind on a refresh throw', async () => {
  const { Session } = await import('../src/session.js');
  const before = fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith('zaungast-')).length;
  const copy = copyDir(dir);
  const s = new (Session as any)({
    overrideDir: copy,
    minDebounceMs: 0,
    incrementalMode: 'reparse',
  });
  s.refreshNow(true); // good warm-up
  // force the next full ingest to throw by pointing discovery at a now-missing dir
  fs.rmSync(copy, { recursive: true, force: true });
  let threw = false;
  try {
    s.refreshNow(true);
  } catch {
    threw = true;
  }
  expect(threw, 'refresh threw on a vanished source').toBe(true);
  s.dispose();
  const final = fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith('zaungast-')).length;
  expect(final <= before, 'no leaked zaungast- temp dirs after dispose').toBe(true);
});

test('N. hardening: handles stable across a full rebuild of identical data', () => {
  const a = ingest(dir);
  const b = ingest(dir);
  const ha = (a.store.db.prepare('select id,handle from conversations order by id').all() as any[])
    .map((r) => `${r.id}=${r.handle}`)
    .join('|');
  const hb = (b.store.db.prepare('select id,handle from conversations order by id').all() as any[])
    .map((r) => `${r.id}=${r.handle}`)
    .join('|');
  expect(ha === hb, 'conversation handles reproducible across rebuilds').toBe(true);
  const pa = (a.store.db.prepare('select mri,handle from people order by mri').all() as any[])
    .map((r) => `${r.mri}=${r.handle}`)
    .join('|');
  const pb = (b.store.db.prepare('select mri,handle from people order by mri').all() as any[])
    .map((r) => `${r.mri}=${r.handle}`)
    .join('|');
  expect(pa === pb, 'people handles reproducible across rebuilds').toBe(true);
  expect(
    /^c:[0-9a-f]{6}$/.test(
      (a.store.db.prepare('select handle from conversations limit 1').get() as any).handle,
    ),
    'handles are 6-hex (c:xxxxxx)',
  ).toBe(true);
  a.store.close();
  b.store.close();
});
