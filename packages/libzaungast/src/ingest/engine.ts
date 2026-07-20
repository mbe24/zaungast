// The ingest-engine SEAM: the pluggable engine contract (IngestEngine) + the refresh-outcome union
// (RefreshResult). An engine builds a full store or applies an incremental; the Session drives it
// engine-agnostically. The JS engine (createJsEngine) is the built-in default; an external engine
// (e.g. the native accelerator, libzaungast-native) implements the same contract and is INJECTED by
// the consumer via openStore/openLiveStore's `engine` option. This is engine-author SPI — re-exported
// through the 'libzaungast/engine-spi' subpath, not the client API.
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
