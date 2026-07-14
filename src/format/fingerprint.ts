import crypto from 'node:crypto';
// Engine seam: fingerprinting is engine-agnostic in intent, but today it decodes raw
// Chromium records inline. A second engine would instead hand this module already-decoded
// records. See ./index.ts for the wider picture.
import { decodePrefix, readStringWithLength, readVarint, utf16be } from './chromium/indexeddb.js';
import { deserialize } from './chromium/structured-clone.js';
import type { DecodedPrefix, Entry, FingerprintResult, FingerprintStore } from './types.js';

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

// Deterministic, locale-independent string order (UTF-16 code-unit order — what the default
// Array.prototype.sort already gives, made explicit). The fingerprint hash is derived from
// sorted store/field names, so this MUST NOT be localeCompare: locale collation would make the
// same schema hash differently on a differently-configured machine.
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// Chromium keeps its IndexedDB schema catalog as metadata rows: database names in the (0,0,0)
// keyspace under marker 0xc9, store names in the (db,0,0) keyspace under 0x32; object data
// lives under indexId 1. One reader per record kind keeps the scan loop below flat.
function readDbNameRow(
  key: Buffer,
  value: Buffer | null,
  headerLen: number,
): { id: number; name: string } | null {
  if (key[headerLen] !== 0xc9) return null;
  const [, p2] = readStringWithLength(key, headerLen + 1);
  const [name] = readStringWithLength(key, p2);
  const [id] = readVarint(value, 0);
  return { id, name };
}
function readStoreNameRow(
  p: DecodedPrefix,
  key: Buffer,
  value: Buffer | null,
): { sk: string; name: string } | null {
  if (key[p.headerLen] !== 0x32) return null;
  const [osId, pp] = readVarint(key, p.headerLen + 1);
  if (key[pp] !== 0) return null;
  return { sk: `${p.databaseId}:${osId}`, name: utf16be(value) };
}

export function fingerprint(
  live: Entry[],
  { samplePerStore = 5 }: { samplePerStore?: number } = {},
): FingerprintResult {
  const dbNames = new Map<number, string>(); // dbId -> raw name
  const storeNames = new Map<string, string>(); // `${dbId}:${osId}` -> name
  const sampleKeys = new Map<string, Set<string>>(); // `${dbId}:${osId}` -> Set(field names)
  const sampleCounts = new Map<string, number>();

  // Record one store's top-level field keys, up to samplePerStore records per store.
  const sampleFields = (sk: string, value: Buffer | null): void => {
    const n = sampleCounts.get(sk) || 0;
    if (n >= samplePerStore) return;
    sampleCounts.set(sk, n + 1);
    try {
      const [, vpos] = readVarint(value, 0);
      // Invariant: `live` only holds non-deletion entries (type !== 0), which always carry a
      // non-null value (see indexeddb.ts) — the shared `Entry.value: Buffer | null` type covers
      // the tombstone case too, so this cast is safe here.
      const obj = deserialize((value as Buffer).subarray(vpos));
      const set = sampleKeys.get(sk) || new Set<string>();
      if (obj && typeof obj === 'object') for (const k of Object.keys(obj)) set.add(k);
      sampleKeys.set(sk, set);
    } catch {}
  };

  for (const { key, value } of live) {
    if (key.length < 1) continue;
    let p: DecodedPrefix;
    try {
      p = decodePrefix(key);
    } catch {
      continue;
    }
    const isMeta = p.objectStoreId === 0 && p.indexId === 0;
    if (p.databaseId === 0 && isMeta) {
      const row = readDbNameRow(key, value, p.headerLen);
      if (row) dbNames.set(row.id, row.name);
    } else if (p.databaseId > 0 && isMeta) {
      const row = readStoreNameRow(p, key, value);
      if (row) storeNames.set(row.sk, row.name);
    } else if (p.indexId === 1) {
      sampleFields(`${p.databaseId}:${p.objectStoreId}`, value);
    }
  }

  // Assemble normalized store descriptors.
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

  const canonical = JSON.stringify(stores.map((s) => [s.db, s.store, s.fields]));
  const hash = crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16);
  return { hash, storeCount: stores.length, stores, dbCount: dbNames.size };
}
