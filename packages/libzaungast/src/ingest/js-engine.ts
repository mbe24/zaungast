// The JS ingest engine, INSTANTIATED per Session (createJsEngine) so it can own a per-Session parse
// cache (`ldbCache`) for the copy-reuse fast path — an external engine (e.g. native) has no
// equivalent, so this state must not live in the engine-agnostic Session.
//
//   full / refresh   — the IngestEngine surface. `full` builds a store from a snapshot dir; `refresh`
//                      applies a cacheless reparse-incremental in place.
//   reuseRefresh     — JS-only copy-reuse fast path: reuse cached .ldb parses over a Session-mirrored
//                      snapshot dir; defers to the reparse path on compaction.
import { applyIncremental, ingest, type IngestState, type Ingested } from './ingest.js';
import type { IngestEngine, RefreshResult } from './engine.js';
import type { LdbCache } from '../format/types.js';
import { loadSnapshotReuse } from '../format/chromium/indexeddb.js';

// Reparse-incremental apply (mutate store + advance state in place), shared by `refresh` (a fresh
// dir) and `reuseRefresh` (a pre-loaded reuse snapshot).
function applyAndAdvance(
  prev: Ingested,
  source: Parameters<typeof applyIncremental>[2],
): RefreshResult {
  // Precondition (upheld by the Session's `!state` gate): prev.state is a non-null IngestState — an
  // unknown-schema store (state:null) is force-rebuilt before it can reach here.
  const state = prev.state as IngestState;
  const r = applyIncremental(prev.store, state, source);
  if (r.skipped) return { kind: 'skipped' };
  if (r.needFullRebuild) return { kind: 'needFull' };
  state.maxSeq = r.newMaxSeq; // advance the JS-side sequence watermark
  return { kind: 'inplace' };
}

export function createJsEngine(): IngestEngine {
  const ldbCache: LdbCache = new Map();
  return {
    full(dir: string, opts?: { seqCap?: number }): Ingested {
      ldbCache.clear(); // a fresh full rebuild moots every cached .ldb parse
      return ingest(dir, opts);
    },
    refresh(prev: Ingested, dir: string): RefreshResult {
      // Shared, cacheless JS reparse-incremental: loads a fresh snapshot of `dir`.
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
