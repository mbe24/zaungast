import crypto from 'node:crypto';
// Engine seam: fingerprinting is engine-agnostic in intent, but today it decodes raw
// Chromium records inline. A second engine would instead hand this module already-decoded
// records. See ./index.ts for the wider picture.
import { readVarint } from './chromium/indexeddb.js';
import { deserialize } from './chromium/structured-clone.js';
import { byCodeUnit } from '../util/sort.js';
import type { FingerprintResult, FingerprintStore, Snapshot } from './types.js';

// Build a stable, PII-free fingerprint of the Teams IndexedDB schema:
//   - normalized database "kind" names (GUIDs / build tokens / locale stripped)
//   - object store names
//   - the set of top-level field keys seen in a sample of each store's records
// This identifies the Teams *schema version* without depending on volatile db ids or GUIDs.

function normalizeDbName(name: string): string {
  return name
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<guid>')
    .replace(/:en-us$|:[a-z]{2}-[a-z]{2}$/i, ':<locale>')
    .replace(/:\d+:/g, ':<n>:')
    .replace(/_\d+_/g, '_<n>_');
}

// Build normalized, sorted store descriptors from the raw db-name / store-name / sampled-field
// maps the scan below collects. Normalizing (stripping GUIDs/locale/build tokens) and sorting
// happen here so the fingerprint hash only ever depends on stable content, never scan order.
function buildStores(
  dbNames: Map<number, string>,
  storeNames: Map<string, string>,
  sampleKeys: Map<string, Set<string>>,
): FingerprintStore[] {
  const stores: FingerprintStore[] = [];
  for (const [sk, storeName] of storeNames) {
    const dbId = Number(sk.split(':')[0]);
    const dbName = dbNames.get(dbId);
    if (!dbName) continue;
    stores.push({
      db: normalizeDbName(dbName),
      store: storeName,
      fields: [...(sampleKeys.get(sk) || [])].sort(byCodeUnit),
    });
  }
  stores.sort((a, b) => byCodeUnit(a.db + a.store, b.db + b.store));
  return stores;
}

export function fingerprint(
  snap: Snapshot,
  { samplePerStore = 5 }: { samplePerStore?: number } = {},
): FingerprintResult {
  // Sample the first `samplePerStore` records of each store's bucket (dedup-insertion order — the
  // same records, in the same order, the old live-scan sampled → byte-identical hash). Decode WITHOUT
  // the value-compression wrapper (deserialize on value.subarray(vpos), NOT decodeValue): a
  // wrapper-compressed value throws and contributes no field keys. This quirk is BAKED INTO the
  // recorded knownFingerprints hashes — do not "fix" it (see plan/format-api-reshape §1.5).
  const sampleKeys = new Map<string, Set<string>>();
  for (const [sk, bucket] of snap.buckets) {
    const set = new Set<string>();
    const lim = Math.min(samplePerStore, bucket.records.length);
    for (let i = 0; i < lim; i++) {
      const value = bucket.records[i].value; // non-tombstone → non-null; Entry.value type is Buffer|null
      try {
        const [, vpos] = readVarint(value, 0);
        const obj = deserialize((value as Buffer).subarray(vpos));
        if (obj && typeof obj === 'object') for (const k of Object.keys(obj)) set.add(k);
      } catch {}
    }
    sampleKeys.set(sk, set);
  }

  const stores = buildStores(snap.dbNames, snap.storeNames, sampleKeys);
  const canonical = JSON.stringify(stores.map((s) => [s.db, s.store, s.fields]));
  const hash = crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16);
  return { hash, storeCount: stores.length, stores, dbCount: snap.dbNames.size };
}
