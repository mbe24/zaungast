// Native copy-reuse (Axis B) RUNTIME test — the piece the pure-Rust harness can't reach: the actual
// compiled `.node` exercising the `External<LdbCache>` cache across FFI calls, `reuseRefresh` returning
// the right outcome, and the Session's copy-reuse `swapped` branch. The Rust gates already prove the
// data path byte-identical (diffreuse: loader == full; diffincr: apply == full; composed_tests:
// reuse_refresh_to_file == full rebuild, cold + warm + defer-on-compaction). This validates the
// PLUMBING is wired correctly and self-consistent (== a native full rebuild).
//
// Gated: skips cleanly when the addon isn't built (dev hosts / unit CI) or ZAUNGAST_TEST_DIR is unset.
//
// Change simulation (no crafted records): copy the source dir and drop its `.log` (the WAL holds the
// newest / highest-sequence writes), so the copy is a valid EARLIER state; the tick that restores the
// `.log` is "new data landed" — and because it only ADDS files, no cached `.ldb` vanishes (no
// compaction → the reuse path, not defer). We work off a ONE-TIME static copy of ZAUNGAST_TEST_DIR so
// a live/mutating source can't race the oracle, and we assert against COUNTS (real catch-up) — never
// only the fingerprint, which is the schema SHAPE (identical for the early and full states) — plus a
// spy proving the Session actually took the `swapped` branch (a reparse fallback also stamps
// 'incremental', so refreshMode alone can't tell them apart).
//
// Run (on a host with the built addon + a real leveldb dir):
//   ZAUNGAST_TEST_DIR=<leveldb-dir> node --conditions=development --experimental-sqlite \
//     --import tsx packages/libzaungast-native/test/reuse.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNativeEngine } from 'libzaungast-native';
import { openLiveStore } from 'libzaungast';
import type { IngestEngine, Ingested, RefreshResult } from 'libzaungast/engine-spi';

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

const tmpDirs: string[] = [];
// Copy a leveldb dir's files to a fresh temp dir; optionally drop the `.log` (→ an earlier state).
function copyDir(src: string, opts: { dropLog?: boolean } = {}): string {
  const dst = fs.mkdtempSync(path.join(os.tmpdir(), 'zg-reuse-'));
  tmpDirs.push(dst);
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
type Counts = { conversations: number; messages: number; people: number };
const countsEq = (a: Counts, b: Counts) =>
  a.conversations === b.conversations && a.messages === b.messages && a.people === b.people;
const kindOf = (r: RefreshResult | 'defer') => (r === 'defer' ? 'defer' : r.kind);

console.log('\n=== native copy-reuse runtime (Axis B) ===');
const engineOrReason = createNativeEngine();
const DIR = process.env.ZAUNGAST_TEST_DIR;
if ('unavailable' in engineOrReason) {
  console.log(`  SKIP — native addon unavailable (${engineOrReason.unavailable})`);
} else if (!DIR) {
  console.log('  SKIP — set ZAUNGAST_TEST_DIR to a leveldb dir to run the runtime reuse test');
} else {
  const engine = engineOrReason;
  const opened: Ingested[] = []; // track builds so we always close their temp .db dirs
  const build = (dir: string): Ingested => {
    const ing = engine.full(dir);
    opened.push(ing);
    return ing;
  };
  try {
    // One-time STATIC copy of the (possibly live) source, and an EARLIER state with the `.log` dropped.
    const source = copyDir(DIR);
    const early = copyDir(source, { dropLog: true });

    // The full-rebuild oracle + the precheck: if dropping the `.log` didn't change the data (no WAL
    // delta — e.g. a cleanly-flushed copy), there is nothing for copy-reuse to catch up to → SKIP
    // rather than record a vacuous PASS.
    const prev = build(early);
    const truth = build(source);
    if (countsEq(prev.meta.counts, truth.meta.counts)) {
      console.log('  SKIP — source has no .log delta over its .ldb (nothing for reuse to apply)');
    } else {
      // ---- Engine level: External cache + reuseRefresh MUST swap (needFull/skipped/defer = FAIL) ----
      const res = engine.reuseRefresh!(prev, source); // cold reuse over the full (with-.log) source
      ok('engine reuseRefresh → swapped', res !== 'defer' && res.kind === 'swapped', kindOf(res));
      if (res !== 'defer' && res.kind === 'swapped') {
        opened.push(res.next);
        ok(
          'engine swapped counts == full rebuild',
          countsEq(res.next.meta.counts, truth.meta.counts),
          `${JSON.stringify(res.next.meta.counts)} vs ${JSON.stringify(truth.meta.counts)}`,
        );
        // Second tick on the unchanged source: the External handle round-trips; the R3 no-op gate
        // must short-circuit → skipped (accepting swapped here would tolerate a regressed no-op gate).
        const res2 = engine.reuseRefresh!(res.next, source);
        ok(
          'second tick → skipped (R3 no-op, cache handle survived)',
          kindOf(res2) === 'skipped',
          kindOf(res2),
        );
        if (res2 !== 'defer' && res2.kind === 'swapped') opened.push(res2.next);
      }

      // ---- Session level: prove the copy-reuse `swapped` branch in tryCopyReuse actually fires ----
      const seen: string[] = [];
      const spied: IngestEngine = {
        full: (d, o) => engine.full(d, o),
        refresh: (p, d) => engine.refresh(p, d),
        reuseRefresh: (p, d) => {
          const r = engine.reuseRefresh!(p, d);
          seen.push(kindOf(r)); // record what the copy-reuse fast path returned
          return r;
        },
      };
      const mirror = copyDir(source, { dropLog: true });
      const live = openLiveStore({
        engine: spied,
        overrideDir: mirror,
        incrementalMode: 'copy-reuse',
        warm: true, // eager first full build on the early state
      });
      restoreLogs(source, mirror); // "new data landed" in the live dir
      const meta = live.refresh({ full: false }); // → tryCopyReuse → reuseRefresh → swapped branch
      ok(
        'Session engaged copy-reuse and it swapped (not a fallback)',
        seen.length === 1 && seen[0] === 'swapped',
        `reuseRefresh returned [${seen.join(',')}]`,
      );
      ok(
        'Session copy-reuse counts == full rebuild',
        countsEq(meta.counts, truth.meta.counts),
        `${JSON.stringify(meta.counts)} vs ${JSON.stringify(truth.meta.counts)}`,
      );
      live.close();
    }
  } finally {
    for (const ing of opened) {
      try {
        ing.store.close();
      } catch {
        /* best-effort cleanup */
      }
    }
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  }
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
