// jsEngine — the default IngestEngine: pure-TS ingest. `full` builds a store from a snapshot dir;
// `refresh` applies an incremental delta onto a prior build IN PLACE (mutating prev.store + advancing
// prev.state) and reports the outcome. The Session re-stamps meta + counters on 'inplace' (policy).
//
// The copy-reuse fast path (a JS-decode optimization) still lives in the Session for now and is folded
// in here in a later step; this wraps the reparse full + incremental paths.
import { applyIncremental, ingest, type Ingested } from './ingest.js';
import type { IngestEngine, RefreshResult } from './engine.js';

export const jsEngine: IngestEngine = {
  full(dir: string, opts?: { seqCap?: number }): Ingested {
    // JS full ingest. NB: ingest() still honors a ZAUNGAST_ENGINE override until native is externalized.
    return ingest(dir, opts);
  },
  refresh(prev: Ingested, dir: string): RefreshResult {
    const r = applyIncremental(prev.store, prev.state!, dir);
    if (r.skipped) return { kind: 'skipped' };
    if (r.needFullRebuild) return { kind: 'needFull' };
    prev.state!.maxSeq = r.newMaxSeq; // advance the JS-side sequence watermark
    return { kind: 'inplace' };
  },
};
