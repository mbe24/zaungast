// libzaungast/format/engine — the engine-seam stability contract (types only).
//
// The entire contract for "add a second storage engine" (e.g. a future macOS/WebKit reader) is:
// produce a `Snapshot`. `fingerprint`/`selectMapping`/`extractEntity` are all typed against it, so a
// new engine gets the whole schema+extract layer for free. `Snapshot`'s fields are additive-only
// across minor versions (never removed/repurposed), which is what makes "add a directory, don't
// rewrite" a real, versioned guarantee.
export type { Snapshot, StoreBucket, SnapshotRecord } from './types.js';
import type { Snapshot } from './types.js';

// An engine locates + decodes one on-disk store format into the shared `Snapshot`.
export interface Engine {
  readonly name: string; // e.g. 'chromium-leveldb', a future 'webkit-sqlite'
  detect(dir: string): boolean; // is this directory this engine's store format?
  loadSnapshot(dir: string, opts?: unknown): Snapshot;
}
