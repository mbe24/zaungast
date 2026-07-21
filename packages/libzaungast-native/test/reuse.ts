// Native copy-reuse (Axis B) RUNTIME test — the piece the pure-Rust harness can't reach: the actual
// compiled `.node` exercising the `External<LdbCache>` cache across FFI calls, `reuseRefresh` returning
// the right outcome, and the Session's copy-reuse `swapped` branch. The Rust gates already prove the
// data path byte-identical (diffreuse: loader == full; diffincr: apply == full; composed_tests:
// reuse_refresh_to_file == full rebuild, cold + warm + defer-on-compaction). This validates the
// PLUMBING is wired correctly and self-consistent (== a native full rebuild).
//
// Gated: skips cleanly when the addon isn't built (dev hosts / unit CI) or ZAUNGAST_TEST_DIR is unset.
// Deterministic change without crafting records: copy the source dir and drop its `.log` (the WAL
// holds the newest / highest-sequence writes), so the copy is a valid EARLIER state; the tick that
// restores the `.log` is "new data landed" — and because it only ADDS files, no cached `.ldb` vanishes
// (no compaction → the reuse path, not defer).
//
// Run (on a host with the built addon + a real leveldb dir):
//   ZAUNGAST_TEST_DIR=<leveldb-dir> node --conditions=development --experimental-sqlite \
//     --import tsx packages/libzaungast-native/test/reuse.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNativeEngine } from 'libzaungast-native';
import { openLiveStore } from 'libzaungast';

let pass = 0,
  fail = 0;
const ok = (name: string, cond: boolean, detail = ''): void => {
  if (cond) {
    pass++;
    console.log(`  PASS ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

// Copy a leveldb dir's files to a fresh temp dir; optionally drop the `.log` (→ an earlier state).
function copyDir(src: string, opts: { dropLog?: boolean } = {}): string {
  const dst = fs.mkdtempSync(path.join(os.tmpdir(), 'zg-reuse-'));
  for (const f of fs.readdirSync(src)) {
    if (opts.dropLog && f.endsWith('.log')) continue;
    const s = path.join(src, f);
    if (fs.statSync(s).isFile()) fs.copyFileSync(s, path.join(dst, f));
  }
  return dst;
}
function restoreLogs(from: string, to: string): void {
  for (const f of fs.readdirSync(from))
    if (f.endsWith('.log')) fs.copyFileSync(path.join(from, f), path.join(to, f));
}
const countsEq = (a: { conversations: number; messages: number; people: number }, b: typeof a) =>
  a.conversations === b.conversations && a.messages === b.messages && a.people === b.people;

console.log('\n=== native copy-reuse runtime (Axis B) ===');
const engineOrReason = createNativeEngine();
const DIR = process.env.ZAUNGAST_TEST_DIR;
if ('unavailable' in engineOrReason) {
  console.log(`  SKIP — native addon unavailable (${engineOrReason.unavailable})`);
} else if (!DIR) {
  console.log('  SKIP — set ZAUNGAST_TEST_DIR to a leveldb dir to run the runtime reuse test');
} else {
  const engine = engineOrReason;
  const tmpDirs: string[] = [];
  try {
    // ---- Engine level: External cache + reuseRefresh outcome + self-oracle ----
    const early = copyDir(DIR, { dropLog: true });
    tmpDirs.push(early);
    const prev = engine.full(early); // mints a fresh (empty) External cache on the handle
    const res = engine.reuseRefresh!(prev, DIR); // cold reuse over the full dir (has the .log delta)
    ok('reuseRefresh does not defer on a pure .log add', res !== 'defer', String(res));

    if (res !== 'defer' && res.kind === 'swapped') {
      const truth = engine.full(DIR); // native full rebuild of the same source = the oracle
      ok(
        'copy-reuse tick fingerprint == full rebuild',
        res.next.meta.fingerprint === truth.meta.fingerprint,
        `${res.next.meta.fingerprint} vs ${truth.meta.fingerprint}`,
      );
      ok(
        'copy-reuse tick counts == full rebuild',
        countsEq(res.next.meta.counts, truth.meta.counts),
        `${JSON.stringify(res.next.meta.counts)} vs ${JSON.stringify(truth.meta.counts)}`,
      );
      // Second tick on the unchanged dir: the External cache is passed back in and survives; the
      // R3 no-op gate short-circuits → skipped (proves the handle round-trips without crashing).
      const res2 = engine.reuseRefresh!(res.next, DIR);
      ok(
        'second reuse tick round-trips the cache handle (skipped / no defer)',
        res2 !== 'defer' && (res2.kind === 'skipped' || res2.kind === 'swapped'),
        String(res2 === 'defer' ? 'defer' : res2.kind),
      );
      if (res2 !== 'defer' && res2.kind === 'swapped') res2.next.store.close();
      truth.store.close();
      res.next.store.close();
    } else if (res !== 'defer' && res.kind === 'skipped') {
      ok('(degraded) source had no .log delta → skipped', true);
    }
    prev.store.close();

    // ---- Session level: the copy-reuse `swapped` branch in tryCopyReuse ----
    // A live Session over a mutable mirror: warm (full on the early state) → restore the .log → a
    // copy-reuse tick must catch up to a full rebuild of the source.
    const mirror = copyDir(DIR, { dropLog: true });
    tmpDirs.push(mirror);
    const live = openLiveStore({
      engine,
      overrideDir: mirror,
      incrementalMode: 'copy-reuse',
      warm: true,
    });
    restoreLogs(DIR, mirror); // "new data landed" in the live dir
    const meta = live.refresh({ full: false }); // → tryCopyReuse → reuseRefresh → swapped branch
    const truth = engine.full(DIR);
    ok(
      'Session copy-reuse swapped branch catches up to a full rebuild',
      meta.fingerprint === truth.meta.fingerprint,
      `${meta.fingerprint} vs ${truth.meta.fingerprint}`,
    );
    truth.store.close();
    live.close();
  } finally {
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  }
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
