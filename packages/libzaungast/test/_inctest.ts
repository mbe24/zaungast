import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ingest, applyIncremental } from '../src/ingest/ingest.js';
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

const DIR = process.argv[2] ?? process.env.ZAUNGAST_TEST_DIR;
if (!DIR) {
  console.error('Set ZAUNGAST_TEST_DIR or pass a leveldb dir as argv[2]');
  process.exit(1);
}
let pass = 0,
  fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) {
    pass++;
    console.log(`  PASS ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name} ${detail}`);
  }
};

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

console.log('\n=== A. spine: partial(seqCap) + incremental == full rebuild ===');
{
  const cap = midSeq(DIR);
  const partial = ingest(DIR, { seqCap: cap });
  const nBefore = (partial.store.db.prepare('select count(*) n from messages').get() as any).n;
  const r = applyIncremental(partial.store, partial.state!, DIR);
  const full = ingest(DIR);
  const nAfter = (partial.store.db.prepare('select count(*) n from messages').get() as any).n;
  console.log(
    `  partial had ${nBefore} msgs (cap seq ${cap}), incremental → ${nAfter}, full → ${(full.store.db.prepare('select count(*) n from messages').get() as any).n}`,
  );
  ok('incremental brought new messages in', nAfter > nBefore);
  ok('no schema-change fallback', r.needFullRebuild === false);
  ok('incremental store == full rebuild', dump(partial.store) === dump(full.store));
  ok('FTS consistent (incremental)', ftsConsistent(partial.store));
  ok('FTS consistent (full)', ftsConsistent(full.store));
  partial.store.close();
  full.store.close();
}

console.log('\n=== B. no-op incremental on unchanged dir ===');
{
  const s = ingest(DIR);
  const before = dump(s.store);
  applyIncremental(s.store, s.state!, DIR);
  ok('no-op incremental leaves store identical', dump(s.store) === before);
  s.store.close();
}

console.log('\n=== C. idempotency: incremental twice ===');
{
  const cap = midSeq(DIR);
  const p = ingest(DIR, { seqCap: cap });
  applyIncremental(p.store, p.state!, DIR);
  p.state!.maxSeq = loadEntries(DIR).maxSeq;
  const after1 = dump(p.store);
  applyIncremental(p.store, p.state!, DIR);
  ok('second incremental is a no-op', dump(p.store) === after1);
  p.store.close();
}

console.log(
  '\n=== D. deletion sweep: tombstone chains of size 1 / mid / max → count drops by EXACTLY N, == full ===',
);
{
  const snap = loadSnapshot(DIR);
  const maxSeq = snap.maxSeq;
  const targets = entityTargets(snap, getMapping(snap), 'message');
  // Discover each message-store DATA record's chain size (rows it owns) from one ingest, so the
  // sweep adapts to whatever capture is pointed at it. chain_key is hex-encoded in the store, so
  // match on e.key.toString('hex'). Buckets already hold only indexId===1 records, so no key
  // re-decode / indexId re-check is needed here (matches the old decodePrefix-filtered scan).
  const disc = ingest(DIR);
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
  console.log(
    `  ${cands.length} chains; deleting sizes → 1:${picks[0][1].n} mid:${picks[1][1].n} max:${picks[2][1].n}`,
  );
  for (const [label, v] of picks) {
    const modified = copyDir(DIR);
    fs.writeFileSync(path.join(modified, 'zzz999.log'), craftDeletionLog(v.key, maxSeq + 1000));
    const partial = ingest(DIR);
    const before = (partial.store.db.prepare('select count(*) n from messages').get() as any).n;
    applyIncremental(partial.store, partial.state!, modified);
    const after = (partial.store.db.prepare('select count(*) n from messages').get() as any).n;
    const full = ingest(modified);
    ok(
      `[${label}] tombstoned a chain owning ${v.n} → count drops by exactly ${v.n} (${before}→${after})`,
      before - after === v.n,
    );
    ok(
      `[${label}] incremental == full rebuild of modified`,
      dump(partial.store) === dump(full.store),
    );
    ok(`[${label}] FTS consistent after deletion`, ftsConsistent(partial.store));
    partial.store.close();
    full.store.close();
    fs.rmSync(modified, { recursive: true, force: true });
  }
}

console.log('\n=== E. Session end-to-end: warm full → mutate → incremental refresh ===');
{
  const { Session } = await import('../src/session.js');
  const copy = copyDir(DIR);
  const s = new (Session as any)({
    overrideDir: copy,
    minDebounceMs: 0,
    maxIncrementals: 2,
    incrementalMode: 'reparse',
  });
  const m0 = s.refreshNow(true); // full
  ok('warm-up is a full ingest with data', m0.refreshMode === 'full' && m0.counts.messages > 0);
  const before = m0.counts.messages;
  // mutate: tombstone a chain
  const snap = loadSnapshot(copy);
  fs.writeFileSync(
    path.join(copy, 'zz0.log'),
    craftDeletionLog(msgStoreKey(snap)!, snap.maxSeq + 1000),
  );
  const m1 = s.refreshNow(false); // incremental
  ok('refresh after mutation is incremental', m1.refreshMode === 'incremental');
  ok('incremental via Session dropped the tombstoned chain', m1.counts.messages < before);
  s.dispose();
  fs.rmSync(copy, { recursive: true, force: true });
}

console.log('\n=== F. backstop: full every maxIncrementals refreshes ===');
{
  const { Session } = await import('../src/session.js');
  const copy = copyDir(DIR);
  const s = new (Session as any)({
    overrideDir: copy,
    minDebounceMs: 0,
    maxIncrementals: 2,
    incrementalMode: 'reparse',
  });
  s.refreshNow(true); // full
  const modes: string[] = [];
  for (let i = 0; i < 4; i++) modes.push(s.refreshNow(false).refreshMode);
  console.log(`  modes after full: ${modes.join(', ')}`);
  ok(
    'backstop forces a full at the Nth incremental',
    modes[0] === 'incremental' && modes[1] === 'incremental' && modes[2] === 'full',
  );
  s.dispose();
  fs.rmSync(copy, { recursive: true, force: true });
}

console.log(
  '\n=== G. multi-step: two effectful incrementals (add then delete) == full of final ===',
);
{
  const copy = copyDir(DIR);
  const cap = midSeq(copy);
  const s = ingest(copy, { seqCap: cap });
  applyIncremental(s.store, s.state!, copy);
  s.state!.maxSeq = loadEntries(copy).maxSeq; // step 1: catch up
  const n1 = (s.store.db.prepare('select count(*) n from messages').get() as any).n;
  const snap = loadSnapshot(copy);
  fs.writeFileSync(
    path.join(copy, 'zzz1.log'),
    craftDeletionLog(msgStoreKey(snap)!, snap.maxSeq + 1000),
  ); // step 2: delete
  applyIncremental(s.store, s.state!, copy);
  s.state!.maxSeq = loadEntries(copy).maxSeq;
  const n2 = (s.store.db.prepare('select count(*) n from messages').get() as any).n;
  const full = ingest(copy);
  ok('step1 caught up, step2 deleted', n1 > 0 && n2 < n1);
  ok('two-step incremental == full of final', dump(s.store) === dump(full.store));
  s.store.close();
  full.store.close();
  fs.rmSync(copy, { recursive: true, force: true });
}

console.log('\n=== H. lossy load MUST NOT mass-delete (Hole 1 regression) ===');
{
  const corrupt = copyDir(DIR);
  const ldb = fs
    .readdirSync(corrupt)
    .filter((f) => f.endsWith('.ldb'))
    .sort()[0];
  const p = path.join(corrupt, ldb);
  const buf = fs.readFileSync(p);
  fs.writeFileSync(p, buf.subarray(0, Math.floor(buf.length / 2))); // truncate → bad footer/index
  const s = ingest(DIR); // full, all messages
  const before = (s.store.db.prepare('select count(*) n from messages').get() as any).n;
  const r = applyIncremental(s.store, s.state!, corrupt); // lossy target
  const after = (s.store.db.prepare('select count(*) n from messages').get() as any).n;
  ok('lossy load returns skipped', r.skipped === true);
  ok('store NOT mass-deleted on lossy load', after === before);
  s.store.close();
  fs.rmSync(corrupt, { recursive: true, force: true });
}

console.log('\n=== I. store-level: edit + soft-delete update flags and FTS (Hole 3) ===');
{
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
  ok(
    'v1 findable in FTS',
    (
      st.db
        .prepare("select count(*) n from messages_fts where messages_fts match 'hello'")
        .get() as any
    ).n === 1,
  );
  // edit: new content, same id, higher version
  st.insertMessage({ ...base, id: '1', version: 2, isSystem: 0, content: 'edited text' });
  st.refreshFts(null);
  ok(
    'edit: old token gone',
    (
      st.db
        .prepare("select count(*) n from messages_fts where messages_fts match 'hello'")
        .get() as any
    ).n === 0,
  );
  ok(
    'edit: new token found',
    (
      st.db
        .prepare("select count(*) n from messages_fts where messages_fts match 'edited'")
        .get() as any
    ).n === 1,
  );
  // soft-delete: content cleared, is_system flips (H3 — SET must update is_system)
  st.insertMessage({ ...base, id: '1', version: 3, isSystem: 1, content: '' });
  st.refreshFts(null);
  ok(
    'soft-delete: is_system updated on conflict',
    (st.db.prepare('select is_system from messages where id=?').get('1') as any).is_system === 1,
  );
  ok(
    'soft-delete: dropped from FTS',
    (
      st.db
        .prepare("select count(*) n from messages_fts where messages_fts match 'edited'")
        .get() as any
    ).n === 0,
  );
  st.close();
}

console.log(
  '\n=== J. tripwire: mapped-store target change → full rebuild; irrelevant churn → not ===',
);
{
  const s = ingest(DIR);
  const rNeg = applyIncremental(s.store, s.state!, DIR);
  ok('irrelevant dynamic-store churn does NOT trip', rNeg.needFullRebuild === false);
  s.state!.msgTargets = new Set([...s.state!.msgTargets, '99999:1']); // simulate our store having moved
  const rPos = applyIncremental(s.store, s.state!, DIR);
  ok('changed mapped targets trip a full rebuild', rPos.needFullRebuild === true);
  s.store.close();
}

console.log('\n=== K. Session cold-start lossy full is flagged and self-heals ===');
{
  const { Session } = await import('../src/session.js');
  const corrupt = copyDir(DIR);
  const ldb = fs
    .readdirSync(corrupt)
    .filter((f) => f.endsWith('.ldb'))
    .sort()[0];
  const good = fs.readFileSync(path.join(DIR, ldb));
  fs.writeFileSync(path.join(corrupt, ldb), good.subarray(0, Math.floor(good.length / 2))); // truncate → lossy
  const s = new (Session as any)({
    overrideDir: corrupt,
    minDebounceMs: 0,
    incrementalMode: 'reparse',
  });
  const m1 = s.refreshNow(true);
  ok('cold-start lossy full is flagged in meta', m1.lossy === true);
  fs.copyFileSync(path.join(DIR, ldb), path.join(corrupt, ldb)); // restore → clean
  const m2 = s.refreshNow(true);
  ok('a clean full clears the lossy flag', m2.lossy === false && m2.counts.messages > 0);
  s.dispose();
  fs.rmSync(corrupt, { recursive: true, force: true });
}

console.log(
  '\n=== L. hardening: post-COMMIT recompute throw → needFullRebuild (not a stuck store) ===',
);
{
  const copy = copyDir(DIR);
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
  const r = applyIncremental(s.store, s.state!, copy);
  ok('post-commit throw returns needFullRebuild', r.needFullRebuild === true);
  (s.store as any).recomputeDerived = orig;
  // store is not left mid-transaction: a normal write still works
  let writable = true;
  try {
    s.store.db.exec('BEGIN');
    s.store.db.exec('COMMIT');
  } catch {
    writable = false;
  }
  ok('store not left in an open transaction', writable);
  s.store.close();
  fs.rmSync(copy, { recursive: true, force: true });
}

console.log(
  '\n=== M. hardening: Session leaves no temp snapshot dir behind on a refresh throw ===',
);
{
  const { Session } = await import('../src/session.js');
  const before = fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith('zaungast-')).length;
  const copy = copyDir(DIR);
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
  ok('refresh threw on a vanished source', threw);
  s.dispose();
  const final = fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith('zaungast-')).length;
  ok('no leaked zaungast- temp dirs after dispose', final <= before);
}

console.log('\n=== N. hardening: handles stable across a full rebuild of identical data ===');
{
  const a = ingest(DIR);
  const b = ingest(DIR);
  const ha = (a.store.db.prepare('select id,handle from conversations order by id').all() as any[])
    .map((r) => `${r.id}=${r.handle}`)
    .join('|');
  const hb = (b.store.db.prepare('select id,handle from conversations order by id').all() as any[])
    .map((r) => `${r.id}=${r.handle}`)
    .join('|');
  ok('conversation handles reproducible across rebuilds', ha === hb);
  const pa = (a.store.db.prepare('select mri,handle from people order by mri').all() as any[])
    .map((r) => `${r.mri}=${r.handle}`)
    .join('|');
  const pb = (b.store.db.prepare('select mri,handle from people order by mri').all() as any[])
    .map((r) => `${r.mri}=${r.handle}`)
    .join('|');
  ok('people handles reproducible across rebuilds', pa === pb);
  ok(
    'handles are 6-hex (c:xxxxxx)',
    /^c:[0-9a-f]{6}$/.test(
      (a.store.db.prepare('select handle from conversations limit 1').get() as any).handle,
    ),
  );
  a.store.close();
  b.store.close();
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
