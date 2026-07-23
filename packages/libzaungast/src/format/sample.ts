// Structural field-sampler for schema recovery (audience #2 — "decode a Chromium store myself /
// propose a mapping"). This owns the Teams-specific STRUCTURAL walk over decoded records: each
// store's record-level top-level keys, `threadProperties` keys (conversation topics live there),
// and — for message-map containers — the union of the first few sub-entries' keys (the first entry
// can be a sparse control/typing entry missing the mapped fields).
//
// It reads field NAMES only (never values), so the raw value decoder stays internal: describe_schema
// consumes this instead of `decodeValue`. The propose-only POLICY (candidate matching, scoring,
// proposal assembly, output text) stays in the MCP; only the structural knowledge is library-side.
import { decodeValue } from './chromium/indexeddb.js';
import type { Snapshot } from './types.js';

// One sampled store's structural summary. `dbName`/`store` are the resolved catalog names; `count`
// is the store's live record count; `sampled` is how many records were actually decoded. `fields`
// are the record-level keys; when a message-map container is present, `nested` holds its per-entry
// keys and `nestedUnder` names the container.
export interface StoreFieldSample {
  store: string;
  dbName: string;
  count: number;
  sampled: number;
  fields: Set<string>;
  nested?: Set<string>;
  nestedUnder?: string;
}

// Decode one sampled record's value into `sample`'s field sets (record keys + threadProperties +
// messageMap/messages first-3-sub-entry keys). Undecodable samples are skipped.
function sampleRecordFields(sample: StoreFieldSample, value: Uint8Array | null): void {
  try {
    const obj = decodeValue(value);
    if (!obj || typeof obj !== 'object') return;
    for (const k of Object.keys(obj)) sample.fields.add(k);
    const tp = (obj as any).threadProperties;
    if (tp && typeof tp === 'object') for (const k of Object.keys(tp)) sample.fields.add(k);
    for (const container of ['messageMap', 'messages']) {
      const c = (obj as any)[container];
      if (c && typeof c === 'object' && !Array.isArray(c)) {
        for (const entry of Object.values(c).slice(0, 3)) {
          if (entry && typeof entry === 'object') {
            sample.nested ??= new Set();
            sample.nestedUnder = container;
            for (const k of Object.keys(entry as object)) sample.nested.add(k);
          }
        }
      }
    }
  } catch {
    /* skip undecodable sample */
  }
}

// Per-object-store record counts + a structural sample of up to `cap` records for field discovery,
// read straight off the snapshot's buckets (already grouped by store, names resolved). Keyed by the
// snapshot's `${dbId}:${osId}` store key.
export function sampleStoreFields(
  snap: Snapshot,
  opts: { cap?: number } = {},
): Map<string, StoreFieldSample> {
  const cap = opts.cap ?? 8;
  const stores = new Map<string, StoreFieldSample>();
  for (const [sk, bucket] of snap.buckets) {
    const sample: StoreFieldSample = {
      store: bucket.storeName ?? '?',
      dbName: bucket.dbName ?? `db${bucket.dbId}`,
      count: bucket.records.length,
      sampled: 0,
      fields: new Set(),
    };
    const lim = Math.min(cap, bucket.records.length);
    for (let i = 0; i < lim; i++) {
      sample.sampled++;
      sampleRecordFields(sample, bucket.records[i].value);
    }
    stores.set(sk, sample);
  }
  return stores;
}
