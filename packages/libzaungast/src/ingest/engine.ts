// The ingest-engine SEAM: the pluggable engine contract (IngestEngine) + the current selection
// policy (Engine string / resolveEngine). Kept separate from native.ts (native MECHANISM only).
import type { Ingested } from './ingest.js';

// The outcome of one incremental refresh, as a discriminated union so the Session stays
// engine-agnostic:
//   inplace  — the engine mutated prev.store in place (JS); the caller re-stamps meta + counters.
//   swapped  — the engine produced a fresh store to swap in (native new-file-swap).
//   skipped  — nothing applied (e.g. a lossy read); keep serving the current store, retry next time.
//   needFull — the delta can't apply (schema tripwire / stale) → the caller must full-rebuild.
export type RefreshResult =
  | { kind: 'inplace' }
  | { kind: 'swapped'; next: Ingested }
  | { kind: 'skipped' }
  | { kind: 'needFull' };

// A pluggable ingest engine: build a full store from a snapshot dir, or apply an incremental refresh
// onto a prior build. The JS engine (jsEngine) is the default; a native engine implements the same
// contract. `full`'s `seqCap` (tests only) builds a partial store as of an earlier sequence.
export interface IngestEngine {
  full(dir: string, opts?: { seqCap?: number }): Ingested;
  refresh(prev: Ingested, dir: string): RefreshResult;
  // OPTIONAL copy-reuse fast path (JS-only): reuse cached .ldb parses over a Session-mirrored
  // snapshot dir. Engines that don't offer it (e.g. native) simply omit it — the Session then skips
  // copy-reuse and uses `refresh`. Returns 'defer' when the caller must fall back to `refresh`.
  reuseRefresh?(prev: Ingested, snapshotDir: string): RefreshResult | 'defer';
}

export type Engine = 'auto' | 'js' | 'native';

// Resolve the effective engine: explicit env override (ZAUNGAST_ENGINE) wins, then the option, else
// the default 'js'. An unrecognized env value is ignored (falls through to the option/default).
//
// Default is 'js' (NOT 'auto'): the native engine is not picked up implicitly, even when a prebuilt
// addon is present, until it's proven across platforms. Opt in per-call with engine:'auto'|'native'
// or globally with ZAUNGAST_ENGINE. Revisit the default once native has real multi-platform mileage.
export function resolveEngine(opt?: Engine): Engine {
  const env = (process.env.ZAUNGAST_ENGINE || '').toLowerCase();
  if (env === 'js' || env === 'native' || env === 'auto') return env;
  return opt ?? 'js';
}
