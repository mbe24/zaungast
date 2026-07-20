// The JS ingest engine, INSTANTIATED per Session (createJsEngine) so it can own a per-Session parse
// cache (`ldbCache`) for the copy-reuse fast path — native has no equivalent, so this state must not
// live in the engine-agnostic Session.
//
//   full / refresh   — the IngestEngine surface. `full` builds a store; `refresh` applies an
//                      incremental. TRANSITIONAL: because ingest() still honors a ZAUNGAST_ENGINE
//                      override, `full` may return a NATIVE store (handle in `state.native`), and
//                      `refresh` dispatches native stores to nativeRefresh (new-file-swap). When
//                      native is externalized (T4), this native dispatch moves out and `full`/`refresh`
//                      become pure JS.
//   reuseRefresh     — JS-only copy-reuse fast path over a Session-mirrored snapshot dir; defers a
//                      native store to the shared `refresh`.
import { applyIncremental, ingest, type IngestState, type Ingested } from './ingest.js';
import type { IngestEngine, RefreshResult } from './engine.js';
import type { LdbCache } from '../format/types.js';
import { loadSnapshotReuse } from '../format/chromium/indexeddb.js';
import { nativeRefresh, type NativeHandle } from './native.js';

// A native store's engine-private opaque state IS its on-disk file handle. Discriminated structurally
// (`IngestState` has no `native` key). Session never inspects this — only the engine does.
type NativeState = { native: NativeHandle };
function isNative(state: unknown): state is NativeState {
  return state != null && typeof state === 'object' && 'native' in state;
}

// Reparse-incremental apply (mutate store + advance state in place), shared by `refresh` (a fresh
// dir) and `reuseRefresh` (a pre-loaded reuse snapshot). Only ever called for a JS store (IngestState).
function applyAndAdvance(
  prev: Ingested,
  source: Parameters<typeof applyIncremental>[2],
): RefreshResult {
  // Precondition (upheld by callers): prev.state is a non-null IngestState — a native store goes
  // through the `swapped` branch above, and an unknown-schema store (state:null) is force-rebuilt by
  // the Session's `!state` gate, so it never reaches here.
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
      return ingest(dir, opts); // may return a native store via the ZAUNGAST_ENGINE bridge (transitional)
    },
    refresh(prev: Ingested, dir: string): RefreshResult {
      if (isNative(prev.state)) {
        // Native incremental (transitional): Rust reads the snapshot dir, writes a delta of the prev
        // file; we swap to it. needFullRebuild → full; skipped (lossy) → keep current.
        const r = nativeRefresh(dir, prev.state.native);
        if (r.kind === 'skipped') return { kind: 'skipped' };
        if (r.kind === 'needFullRebuild') return { kind: 'needFull' };
        return {
          kind: 'swapped',
          next: { store: r.store, meta: r.meta, lossy: false, state: { native: r.native } },
        };
      }
      // Shared, cacheless JS reparse-incremental: loads a fresh snapshot of `dir`.
      return applyAndAdvance(prev, dir);
    },
    reuseRefresh(prev: Ingested, snapshotDir: string): RefreshResult | 'defer' {
      if (isNative(prev.state)) return 'defer'; // copy-reuse is JS-only → let refresh do the native swap
      const loaded = loadSnapshotReuse(snapshotDir, ldbCache);
      if (loaded.lossy) return { kind: 'skipped' }; // partial reuse-load → keep current, retry
      if (loaded.compacted) return 'defer'; // → reparse-incremental fallback (reconciles elided deletions)
      return applyAndAdvance(prev, loaded);
    },
  };
}
