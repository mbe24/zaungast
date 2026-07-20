// The JS ingest engine, INSTANTIATED per Session (createJsEngine) so it can own a per-Session parse
// cache (`ldbCache`) for the copy-reuse fast path — native has no equivalent, so this state must not
// live in the engine-agnostic Session.
//
//   full / refresh  — the SHARED, native-symmetric IngestEngine surface. Both are CACHELESS:
//                     `refresh` reparse-loads a fresh snapshot of `dir`. This is what 'reparse' mode
//                     and the copy-reuse fallback use.
//   reuseRefresh    — JS-ONLY (not on the IngestEngine interface): the copy-reuse fast path, reusing
//                     cached `.ldb` parses over a Session-produced (mirrored) snapshot dir.
import { applyIncremental, ingest, type Ingested } from './ingest.js';
import type { IngestEngine, RefreshResult } from './engine.js';
import type { LdbCache } from '../format/types.js';
import { loadSnapshotReuse } from '../format/chromium/indexeddb.js';

export interface JsEngine extends IngestEngine {
  // Copy-reuse incremental over a Session-mirrored snapshot dir. Returns a RefreshResult, or 'defer'
  // when the Session must fall back to the shared reparse-incremental `refresh` — on compaction (a
  // fresh full read reconciles compaction-elided deletions) or a lossy reuse-load.
  reuseRefresh(prev: Ingested, snapshotDir: string): RefreshResult | 'defer';
}

// A local copy of the reparse-incremental apply (mutate store + advance state in place), shared by
// `refresh` (fresh dir) and `reuseRefresh` (pre-loaded reuse snapshot).
function applyAndAdvance(
  prev: Ingested,
  source: Parameters<typeof applyIncremental>[2],
): RefreshResult {
  const r = applyIncremental(prev.store, prev.state!, source);
  if (r.skipped) return { kind: 'skipped' };
  if (r.needFullRebuild) return { kind: 'needFull' };
  prev.state!.maxSeq = r.newMaxSeq;
  return { kind: 'inplace' };
}

export function createJsEngine(): JsEngine {
  const ldbCache: LdbCache = new Map();
  return {
    full(dir: string, opts?: { seqCap?: number }): Ingested {
      ldbCache.clear(); // a fresh full rebuild moots every cached .ldb parse
      // JS full ingest. NB: ingest() still honors a ZAUNGAST_ENGINE override until native is externalized.
      return ingest(dir, opts);
    },
    refresh(prev: Ingested, dir: string): RefreshResult {
      // Shared, cacheless reparse-incremental (also native-symmetric): loads a fresh snapshot of `dir`.
      return applyAndAdvance(prev, dir);
    },
    reuseRefresh(prev: Ingested, snapshotDir: string): RefreshResult | 'defer' {
      const loaded = loadSnapshotReuse(snapshotDir, ldbCache);
      if (loaded.lossy) return { kind: 'skipped' }; // partial reuse-load → keep current, retry
      if (loaded.compacted) return 'defer'; // → reparse-incremental fallback (reconciles elided deletions)
      return applyAndAdvance(prev, loaded);
    },
  };
}
