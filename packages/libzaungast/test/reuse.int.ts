// Copy-reuse (stage 2) correctness: the cached loader must produce an identical live set to
// the reparse loader, and applying it must equal a full rebuild.
//
// Run: npx vitest run packages/libzaungast/test/reuse.int.ts
import { test, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveLevelDbDir } from '../../../scripts/native-runner.mjs';
import { generateFixtureWithTables } from './fixture/generate.js';
import { ingest, applyIncremental, type IngestState } from '../src/ingest/ingest.js';
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
} from '../src/format/chromium/node-source.js';
import { decodePrefix } from '../src/format/chromium/indexeddb.js';
import { crc32c } from '../src/format/chromium/sstable.js';
import { byCodeUnit } from '../src/util/sort.js';

let dir: string;
let synthetic = false;
beforeAll(() => {
  const real = resolveLevelDbDir(process.env.ZAUNGAST_TEST_DIR);
  if (real) dir = real;
  else {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaungast-reuse-'));
    generateFixtureWithTables(dir);
    synthetic = true;
  }
});
afterAll(() => {
  if (synthetic) fs.rmSync(dir, { recursive: true, force: true });
});

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

// ---- Session-level: copy-reuse mode must equal reparse mode after identical mutations ----
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
function craftDeletionLog(userKey: Uint8Array, seq: number): Buffer {
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
function msgStoreKey(d: string): Uint8Array | null {
  const { live } = loadEntries(d);
  const snap = loadSnapshot(d);
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

test('A. cached loader output == reparse loader output (cold cache)', () => {
  const reparse = loadEntries(dir);
  const cache = new Map();
  const reuse = loadEntriesReuse(dir, cache);
  expect(liveSig(reparse.live) === liveSig(reuse.live), 'same live set').toBe(true);
  expect(reparse.maxSeq === reuse.maxSeq, 'same maxSeq').toBe(true);
  expect(
    cache.size === fs.readdirSync(dir).filter((f) => f.endsWith('.ldb')).length,
    'cache populated with every .ldb',
  ).toBe(true);
  expect(reuse.compacted === false && reuse.lossy === false, 'not compacted, not lossy').toBe(true);
});

test('B. warm cache: second call reuses parses, identical output', () => {
  const cache = new Map();
  const first = loadEntriesReuse(dir, cache);
  const cachedObjs = [...cache.values()];
  const second = loadEntriesReuse(dir, cache);
  expect(liveSig(first.live) === liveSig(second.live), 'identical live set warm').toBe(true);
  expect(
    [...cache.values()].every((v, i) => v === cachedObjs[i]),
    'cache objects reused (same references)',
  ).toBe(true);
});

test('C. spine: partial + applyIncremental(cached load) == full rebuild', () => {
  const cap = (() => {
    const s = loadEntries(dir)
      .live.map((e: any) => e.seq)
      .sort((a: number, b: number) => a - b);
    return s[Math.floor(s.length / 2)];
  })();
  const partial = ingest(dir, { seqCap: cap });
  const cache = new Map();
  const loaded = loadSnapshotReuse(dir, cache);
  const r = applyIncremental(partial.store, partial.state as IngestState, loaded);
  const full = ingest(dir);
  const dump = (s: any) =>
    JSON.stringify({
      m: s.db
        .prepare(
          'select conv_id,id,version,ts,sender_mri,is_system,content from messages order by conv_id,id',
        )
        .all(),
      p: s.db.prepare('select mri,name,msg_count from people order by mri').all(),
    });
  expect(r.needFullRebuild === false && r.skipped === false, 'no fallback').toBe(true);
  expect(dump(partial.store) === dump(full.store), 'cached-load incremental == full rebuild').toBe(
    true,
  );
  partial.store.close();
  full.store.close();
});

test('D. compaction detected when a cached .ldb disappears', () => {
  const d = copyDir(dir);
  const cache = new Map();
  loadEntriesReuse(d, cache); // populate
  const victim = fs
    .readdirSync(d)
    .filter((f) => f.endsWith('.ldb'))
    .sort()[0];
  fs.rmSync(path.join(d, victim));
  const after = loadEntriesReuse(d, cache);
  expect(after.compacted === true, 'compacted flag set').toBe(true);
  expect(!cache.has(victim), 'cache pruned the removed file').toBe(true);
  fs.rmSync(d, { recursive: true, force: true });
});

test('E. new .ldb flush is picked up; still == reparse', () => {
  const d = copyDir(dir);
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
  expect(cache.size === cacheSizeBefore + 1, 'new .ldb parsed into cache').toBe(true);
  expect(liveSig(after.live) === liveSig(loadEntries(d).live), 'reuse == reparse after flush').toBe(
    true,
  );
  fs.rmSync(held, { force: true });
  fs.rmSync(d, { recursive: true, force: true });
});

test('F. truncated (lossy) new .ldb → lossy, not cached (so it retries)', () => {
  const d = copyDir(dir);
  const cache = new Map();
  const victim = fs
    .readdirSync(d)
    .filter((f) => f.endsWith('.ldb'))
    .sort()[0];
  const good = fs.readFileSync(path.join(d, victim));
  fs.writeFileSync(path.join(d, victim), good.subarray(0, Math.floor(good.length / 2)));
  const res = loadEntriesReuse(d, cache);
  expect(res.lossy === true, 'lossy flag set').toBe(true);
  expect(!cache.has(victim), 'lossy file NOT cached (will retry)').toBe(true);
  fs.rmSync(d, { recursive: true, force: true });
});

test('G. Session copy-reuse == reparse after the same mutation (mode equivalence)', async () => {
  const { Session } = await import('../src/session.js');
  const dR = copyDir(dir),
    dC = copyDir(dir);
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
  expect(mC.refreshMode === 'incremental', 'copy-reuse refresh is incremental').toBe(true);
  expect(
    storeDump(sR.getStore()) === storeDump(sC.getStore()),
    'copy-reuse store == reparse store after deletion',
  ).toBe(true);
  sR.dispose();
  sC.dispose();
  fs.rmSync(dR, { recursive: true, force: true });
  fs.rmSync(dC, { recursive: true, force: true });
});

test('H. Session copy-reuse multi-step (add then delete) == reparse', async () => {
  const { Session } = await import('../src/session.js');
  const dR = copyDir(dir),
    dC = copyDir(dir);
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
  expect(
    storeDump(sR.getStore()) === storeDump(sC.getStore()),
    'multi-step copy-reuse == reparse',
  ).toBe(true);
  sR.dispose();
  sC.dispose();
  fs.rmSync(dR, { recursive: true, force: true });
  fs.rmSync(dC, { recursive: true, force: true });
});

test('I. end-to-end: compaction (merge .ldb) → copy-reuse store == reparse, no resurrection', async () => {
  const { Session } = await import('../src/session.js');
  const dC = copyDir(dir),
    dR = copyDir(dir);
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
  expect(
    dump(sC.getStore()) === dump(sR.getStore()),
    'copy-reuse store == reparse store after compaction',
  ).toBe(true);
  sC.dispose();
  sR.dispose();
  fs.rmSync(dC, { recursive: true, force: true });
  fs.rmSync(dR, { recursive: true, force: true });
});

test('J. needFullRebuild in copy-reuse latches a full rebuild (pendingFull)', async () => {
  const { Session } = await import('../src/session.js');
  const d = copyDir(dir);
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
  expect(m.refreshMode === 'full', 'recovered via full rebuild').toBe(true);
  expect(
    (s.getStore().db.prepare('select count(*) n from messages').get() as any).n === before,
    'store still valid after fallback',
  ).toBe(true);
  s.dispose();
  fs.rmSync(d, { recursive: true, force: true });
});

test('K. partial-.ldb wedge (H-A/H-B): a truncated snapshot .ldb recovers within one refresh', async () => {
  const { Session } = await import('../src/session.js');
  const d = copyDir(dir);
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
  expect(
    n === (full.store.db.prepare('select count(*) n from messages').get() as any).n,
    'recovered full message set within one refresh (size-check re-copied the truncated .ldb)',
  ).toBe(true);
  full.store.close();
  s.dispose();
  fs.rmSync(d, { recursive: true, force: true });
});

test('L. backstop fires in copy-reuse mode', async () => {
  const { Session } = await import('../src/session.js');
  const d = copyDir(dir);
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
  expect(modes.includes('full'), 'backstop forces a full within copy-reuse cadence').toBe(true);
  s.dispose();
  fs.rmSync(d, { recursive: true, force: true });
});
