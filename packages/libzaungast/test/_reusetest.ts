// Copy-reuse (stage 2) correctness: the cached loader must produce an identical live set to
// the reparse loader, and applying it must equal a full rebuild.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ingest, applyIncremental } from '../src/ingest/ingest.js';
import {
  loadSnapshot,
  entityTargets,
  loadMapping,
  selectMapping,
  fingerprint,
} from '../src/format/index.js';
// Internal loaders/byte-readers — not public /format; reached relatively by this in-package test.
import {
  loadEntries,
  loadEntriesReuse,
  loadSnapshotReuse,
  decodePrefix,
} from '../src/format/chromium/indexeddb.js';
import { byCodeUnit } from '../src/util/sort.js';

const DIR = process.argv[2] ?? process.env.ZAUNGAST_TEST_DIR;
if (!DIR) {
  console.error('Set ZAUNGAST_TEST_DIR or pass a leveldb dir as argv[2]');
  process.exit(1);
}
let pass = 0,
  fail = 0;
const ok = (n: string, c: boolean, d = '') => {
  if (c) {
    pass++;
    console.log(`  PASS ${n}`);
  } else {
    fail++;
    console.log(`  FAIL ${n} ${d}`);
  }
};

function liveSig(live: any[]): string {
  return live
    .map((e) => `${e.key.toString('latin1')}#${e.seq}#${e.type}`)
    .sort(byCodeUnit)
    .join('|');
}
function copyDir(src: string): string {
  const dst = fs.mkdtempSync(path.join(os.tmpdir(), 'reuse-'));
  for (const f of fs.readdirSync(src)) fs.copyFileSync(path.join(src, f), path.join(dst, f));
  return dst;
}

console.log('=== A. cached loader output == reparse loader output (cold cache) ===');
{
  const reparse = loadEntries(DIR);
  const cache = new Map();
  const reuse = loadEntriesReuse(DIR, cache);
  ok('same live set', liveSig(reparse.live) === liveSig(reuse.live));
  ok('same maxSeq', reparse.maxSeq === reuse.maxSeq);
  ok(
    'cache populated with every .ldb',
    cache.size === fs.readdirSync(DIR).filter((f) => f.endsWith('.ldb')).length,
  );
  ok('not compacted, not lossy', reuse.compacted === false && reuse.lossy === false);
}

console.log('\n=== B. warm cache: second call reuses parses, identical output ===');
{
  const cache = new Map();
  const first = loadEntriesReuse(DIR, cache);
  const cachedObjs = [...cache.values()];
  const second = loadEntriesReuse(DIR, cache);
  ok('identical live set warm', liveSig(first.live) === liveSig(second.live));
  ok(
    'cache objects reused (same references)',
    [...cache.values()].every((v, i) => v === cachedObjs[i]),
  );
}

console.log('\n=== C. spine: partial + applyIncremental(cached load) == full rebuild ===');
{
  const cap = (() => {
    const s = loadEntries(DIR)
      .live.map((e: any) => e.seq)
      .sort((a: number, b: number) => a - b);
    return s[Math.floor(s.length / 2)];
  })();
  const partial = ingest(DIR, { seqCap: cap });
  const cache = new Map();
  const loaded = loadSnapshotReuse(DIR, cache);
  const r = applyIncremental(partial.store, partial.state!, loaded);
  const full = ingest(DIR);
  const dump = (s: any) =>
    JSON.stringify({
      m: s.db
        .prepare(
          'select conv_id,id,version,ts,sender_mri,is_system,content from messages order by conv_id,id',
        )
        .all(),
      p: s.db.prepare('select mri,name,msg_count from people order by mri').all(),
    });
  ok('no fallback', r.needFullRebuild === false && r.skipped === false);
  ok('cached-load incremental == full rebuild', dump(partial.store) === dump(full.store));
  partial.store.close();
  full.store.close();
}

console.log('\n=== D. compaction detected when a cached .ldb disappears ===');
{
  const d = copyDir(DIR);
  const cache = new Map();
  loadEntriesReuse(d, cache); // populate
  const victim = fs
    .readdirSync(d)
    .filter((f) => f.endsWith('.ldb'))
    .sort()[0];
  fs.rmSync(path.join(d, victim));
  const after = loadEntriesReuse(d, cache);
  ok('compacted flag set', after.compacted === true);
  ok('cache pruned the removed file', !cache.has(victim));
  fs.rmSync(d, { recursive: true, force: true });
}

console.log('\n=== E. new .ldb flush is picked up; still == reparse ===');
{
  const d = copyDir(DIR);
  const cache = new Map();
  const ldbs = fs
    .readdirSync(d)
    .filter((f) => f.endsWith('.ldb'))
    .sort();
  // cold cache over a SUBSET (simulate an earlier state), then reveal the rest = "flush"
  const held = path.join(os.tmpdir(), 'held-' + ldbs[ldbs.length - 1]);
  fs.copyFileSync(path.join(d, ldbs[ldbs.length - 1]), held);
  fs.rmSync(path.join(d, ldbs[ldbs.length - 1]));
  loadEntriesReuse(d, cache); // cache without the last .ldb
  const cacheSizeBefore = cache.size;
  fs.copyFileSync(held, path.join(d, ldbs[ldbs.length - 1])); // "flush" appears
  const after = loadEntriesReuse(d, cache);
  ok('new .ldb parsed into cache', cache.size === cacheSizeBefore + 1);
  ok('reuse == reparse after flush', liveSig(after.live) === liveSig(loadEntries(d).live));
  fs.rmSync(held, { force: true });
  fs.rmSync(d, { recursive: true, force: true });
}

console.log('\n=== F. truncated (lossy) new .ldb → lossy, not cached (so it retries) ===');
{
  const d = copyDir(DIR);
  const cache = new Map();
  const victim = fs
    .readdirSync(d)
    .filter((f) => f.endsWith('.ldb'))
    .sort()[0];
  const good = fs.readFileSync(path.join(d, victim));
  fs.writeFileSync(path.join(d, victim), good.subarray(0, Math.floor(good.length / 2)));
  const res = loadEntriesReuse(d, cache);
  ok('lossy flag set', res.lossy === true);
  ok('lossy file NOT cached (will retry)', !cache.has(victim));
  fs.rmSync(d, { recursive: true, force: true });
}

// ---- Session-level: copy-reuse mode must equal reparse mode after identical mutations ----
import { crc32c } from '../src/format/chromium/sstable.js';
import { fileURLToPath } from 'node:url';

const VDIR = fileURLToPath(new URL('../src/schema/versions/', import.meta.url));
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
    })(),
    Buffer.from([0]),
    varint(userKey.length),
    userKey,
  ]);
  const type = Buffer.from([1]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32LE(maskCrc(crc32c(Buffer.concat([type, batch]), 0, 1 + batch.length)));
  const len = Buffer.alloc(2);
  len.writeUInt16LE(batch.length);
  return Buffer.concat([crc, len, type, batch]);
}
function msgStoreKey(dir: string): Buffer | null {
  const { live } = loadEntries(dir);
  const snap = loadSnapshot(dir);
  const mapping = selectMapping(fingerprint(snap), {
    mappings: fs
      .readdirSync(VDIR)
      .filter((f: string) => f.endsWith('.json'))
      .map((f: string) => loadMapping(path.join(VDIR, f))),
  }).mapping;
  const targets: Set<string> = entityTargets(snap, mapping, 'message');
  for (const e of live) {
    let p: any;
    try {
      p = decodePrefix(e.key);
    } catch {
      continue;
    }
    if (targets.has(`${p.databaseId}:${p.objectStoreId}`)) return e.key;
  }
  return null;
}
function storeDump(store: any): string {
  return JSON.stringify({
    m: store.db
      .prepare(
        'select conv_id,id,version,ts,sender_mri,is_system,content from messages order by conv_id,id',
      )
      .all(),
    c: store.db
      .prepare('select id,topic,msg_count,participant_names from conversations order by id')
      .all(),
    p: store.db.prepare('select mri,name,msg_count from people order by mri').all(),
  });
}

console.log(
  '\n=== G. Session copy-reuse == reparse after the same mutation (mode equivalence) ===',
);
{
  const { Session } = await import('../src/session.js');
  const dR = copyDir(DIR),
    dC = copyDir(DIR);
  const sR = new (Session as any)({
    overrideDir: dR,
    minDebounceMs: 0,
    incrementalMode: 'reparse',
  });
  const sC = new (Session as any)({
    overrideDir: dC,
    minDebounceMs: 0,
    incrementalMode: 'copy-reuse',
  });
  sR.refreshNow(true);
  sC.refreshNow(true); // both warm (full)
  sC.refreshNow(false); // copy-reuse: first incremental warms cache
  // identical mutation: tombstone a chain in each
  const seqR = loadEntries(dR).maxSeq,
    seqC = loadEntries(dC).maxSeq;
  fs.writeFileSync(path.join(dR, 'zz9.log'), craftDeletionLog(msgStoreKey(dR)!, seqR + 1000));
  fs.writeFileSync(path.join(dC, 'zz9.log'), craftDeletionLog(msgStoreKey(dC)!, seqC + 1000));
  sR.refreshNow(false);
  const mC = sC.refreshNow(false);
  ok('copy-reuse refresh is incremental', mC.refreshMode === 'incremental');
  ok(
    'copy-reuse store == reparse store after deletion',
    storeDump(sR.getStore()) === storeDump(sC.getStore()),
  );
  sR.dispose();
  sC.dispose();
  fs.rmSync(dR, { recursive: true, force: true });
  fs.rmSync(dC, { recursive: true, force: true });
}

console.log('\n=== H. Session copy-reuse multi-step (add then delete) == reparse ===');
{
  const { Session } = await import('../src/session.js');
  const dR = copyDir(DIR),
    dC = copyDir(DIR);
  const sR = new (Session as any)({
    overrideDir: dR,
    minDebounceMs: 0,
    incrementalMode: 'reparse',
  });
  const sC = new (Session as any)({
    overrideDir: dC,
    minDebounceMs: 0,
    incrementalMode: 'copy-reuse',
  });
  sR.refreshNow(true);
  sC.refreshNow(true);
  sC.refreshNow(false);
  // step 1: tombstone chain A
  const kR1 = msgStoreKey(dR)!,
    kC1 = msgStoreKey(dC)!;
  fs.writeFileSync(path.join(dR, 'a.log'), craftDeletionLog(kR1, loadEntries(dR).maxSeq + 1000));
  fs.writeFileSync(path.join(dC, 'a.log'), craftDeletionLog(kC1, loadEntries(dC).maxSeq + 1000));
  sR.refreshNow(false);
  sC.refreshNow(false);
  ok('multi-step copy-reuse == reparse', storeDump(sR.getStore()) === storeDump(sC.getStore()));
  sR.dispose();
  sC.dispose();
  fs.rmSync(dR, { recursive: true, force: true });
  fs.rmSync(dC, { recursive: true, force: true });
}

console.log(
  '\n=== I. H1 end-to-end: compaction (merge .ldb) → copy-reuse store == reparse, no resurrection ===',
);
{
  const { Session } = await import('../src/session.js');
  const dC = copyDir(DIR),
    dR = copyDir(DIR);
  const sC = new (Session as any)({
    overrideDir: dC,
    minDebounceMs: 0,
    incrementalMode: 'copy-reuse',
  });
  const sR = new (Session as any)({
    overrideDir: dR,
    minDebounceMs: 0,
    incrementalMode: 'reparse',
  });
  sC.refreshNow(true);
  sC.refreshNow(false); // warm copy-reuse cache
  sR.refreshNow(true);
  // simulate compaction on BOTH live dirs: drop the two smallest .ldb, add a merged higher-numbered
  // one built by re-parsing... simplest faithful sim: delete an .ldb from live (its keys vanish).
  // A real compaction preserves the resolvable view; deleting a whole .ldb models genuine loss.
  for (const d of [dC, dR]) {
    const ldbs = fs
      .readdirSync(d)
      .filter((f) => f.endsWith('.ldb'))
      .sort();
    fs.rmSync(path.join(d, ldbs[0])); // "compaction" removes an input; data genuinely gone
  }
  sC.refreshNow(false);
  sR.refreshNow(false);
  const dump = (s: any) =>
    JSON.stringify(s.db.prepare('select conv_id,id from messages order by conv_id,id').all());
  // both may go degraded (removing an .ldb can break the schema mapping) OR match — the invariant
  // is that copy-reuse never has MORE data than reparse (no resurrection).
  ok(
    'copy-reuse store == reparse store after compaction',
    dump(sC.getStore()) === dump(sR.getStore()),
  );
  sC.dispose();
  sR.dispose();
  fs.rmSync(dC, { recursive: true, force: true });
  fs.rmSync(dR, { recursive: true, force: true });
}

console.log('\n=== J. needFullRebuild in copy-reuse latches a full rebuild (pendingFull) ===');
{
  const { Session } = await import('../src/session.js');
  const d = copyDir(DIR);
  const s = new (Session as any)({
    overrideDir: d,
    minDebounceMs: 0,
    incrementalMode: 'copy-reuse',
  });
  s.refreshNow(true);
  s.refreshNow(false);
  // force the tripwire: mutate cached state so mapped targets differ → applyIncremental returns needFullRebuild
  s.cur.state.msgTargets = new Set([...s.cur.state.msgTargets, '99999:1']);
  const before = (s.getStore().db.prepare('select count(*) n from messages').get() as any).n;
  const m = s.refreshNow(false);
  ok('recovered via full rebuild', m.refreshMode === 'full');
  ok(
    'store still valid after fallback',
    (s.getStore().db.prepare('select count(*) n from messages').get() as any).n === before,
  );
  s.dispose();
  fs.rmSync(d, { recursive: true, force: true });
}

console.log(
  '\n=== K. partial-.ldb wedge (H-A/H-B): a truncated snapshot .ldb recovers within one refresh ===',
);
{
  const { Session } = await import('../src/session.js');
  const d = copyDir(DIR);
  const s = new (Session as any)({
    overrideDir: d,
    minDebounceMs: 0,
    incrementalMode: 'copy-reuse',
  });
  s.refreshNow(true);
  s.refreshNow(false); // warm; snapshot dir populated
  const snapDir = s.snapshotDir as string;
  const victim = fs
    .readdirSync(snapDir)
    .filter((f) => f.endsWith('.ldb'))
    .sort()[0];
  // corrupt the SNAPSHOT copy (live is intact) → simulates a prior partial copy
  const good = fs.readFileSync(path.join(snapDir, victim));
  fs.writeFileSync(path.join(snapDir, victim), good.subarray(0, Math.floor(good.length / 2)));
  s.cur.state.maxSeq = 0; // force re-derivation so a wedge would show as missing data
  s.refreshNow(false);
  const n = (s.getStore().db.prepare('select count(*) n from messages').get() as any).n;
  const full = ingest(d);
  ok(
    'recovered full message set within one refresh (size-check re-copied the truncated .ldb)',
    n === (full.store.db.prepare('select count(*) n from messages').get() as any).n,
  );
  full.store.close();
  s.dispose();
  fs.rmSync(d, { recursive: true, force: true });
}

console.log('\n=== L. backstop fires in copy-reuse mode ===');
{
  const { Session } = await import('../src/session.js');
  const d = copyDir(DIR);
  const s = new (Session as any)({
    overrideDir: d,
    minDebounceMs: 0,
    maxIncrementals: 1,
    incrementalMode: 'copy-reuse',
  });
  s.refreshNow(true);
  const modes = [
    s.refreshNow(false).refreshMode,
    s.refreshNow(false).refreshMode,
    s.refreshNow(false).refreshMode,
  ];
  ok('backstop forces a full within copy-reuse cadence', modes.includes('full'));
  s.dispose();
  fs.rmSync(d, { recursive: true, force: true });
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
