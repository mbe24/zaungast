import fs from 'node:fs';
// Engine seam: mapping/extraction is engine-agnostic in intent (a mapped record has the same
// fields however it was stored), but today it decodes raw Chromium records inline. A second
// engine would hand this module already-decoded records. See ./index.ts.
import {
  decodePrefix,
  readStringWithLength,
  readVarint,
  utf16be,
  decodeValue,
} from './chromium/indexeddb.js';
import type {
  DecodedPrefix,
  Entry,
  ExtractedRow,
  FingerprintResult,
  Mapping,
  SelectMappingResult,
} from './types.js';

// Resolve a mapping file against a fingerprint, then extract entities generically.

export function loadMapping(path: string): Mapping {
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

// Pick a mapping for the given fingerprint: exact hash match, else store-presence match.
export function selectMapping(mappings: Mapping[], fp: FingerprintResult): SelectMappingResult {
  const storeSet = new Set(fp.stores.map((s) => s.store));
  for (const m of mappings)
    if (m.knownFingerprints?.includes(fp.hash)) return { mapping: m, via: 'fingerprint' };
  for (const m of mappings) {
    const need = m.match?.requireStores ?? [];
    if (need.every((s) => storeSet.has(s)))
      return { mapping: m, via: 'store-presence (UNVERIFIED for this fingerprint)' };
  }
  return { mapping: null, via: 'none' };
}

const glob = (pat: string, s: string): boolean =>
  new RegExp('^' + pat.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$').test(s);

// `obj` is a decoded structured-clone value (genuinely dynamic shape) — indexing it by a
// path segment is a type-only cast here (`cur[part]` at runtime, exactly as the untyped
// original did); it does not add or remove any runtime check.
function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    if (cur == null) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}
function firstDefined(obj: unknown, spec: string | string[]): unknown {
  const paths = Array.isArray(spec) ? spec : [spec];
  for (const p of paths) {
    const v = getPath(obj, p);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

// Per-`live` memoized index: the prefix decode of every entry (the single biggest ingest waste
// — a full ingest used to re-run decodePrefix ~11× over all entries, ~1.2M closure+object allocs
// just to re-derive (dbId,osId,indexId)) plus the db/store-name catalog, computed ONCE and shared
// across the fingerprint-independent consumers (entityTargets ×N + extractEntity ×N). Keyed on the
// live array reference (WeakMap → GC'd with it); the incremental path's subset array gets its own.
interface LiveIndex {
  prefixes: (DecodedPrefix | null)[]; // parallel to live; null = key too short / undecodable
  dbNames: Map<number, string>;
  storeNames: Map<string, string>;
}
const indexCache = new WeakMap<Entry[], LiveIndex>();

function liveIndex(live: Entry[]): LiveIndex {
  const hit = indexCache.get(live);
  if (hit) return hit;
  const prefixes: (DecodedPrefix | null)[] = new Array(live.length);
  const dbNames = new Map<number, string>();
  const storeNames = new Map<string, string>();
  for (let i = 0; i < live.length; i++) {
    const { key, value } = live[i];
    let p: DecodedPrefix | null = null;
    if (key.length >= 1) {
      try {
        p = decodePrefix(key);
      } catch {
        p = null;
      }
    }
    prefixes[i] = p;
    if (!p) continue;
    const { databaseId, objectStoreId, indexId, headerLen } = p;
    if (databaseId === 0 && objectStoreId === 0 && indexId === 0 && key[headerLen] === 0xc9) {
      const [, p2] = readStringWithLength(key, headerLen + 1);
      const [name] = readStringWithLength(key, p2);
      // See fingerprint.ts: `live` only holds non-deletion entries, so value is never null here.
      const [id] = readVarint(value, 0);
      dbNames.set(id, name);
    } else if (databaseId > 0 && objectStoreId === 0 && indexId === 0 && key[headerLen] === 0x32) {
      const [osId, pp] = readVarint(key, headerLen + 1);
      if (key[pp] === 0) storeNames.set(`${databaseId}:${osId}`, utf16be(value));
    }
  }
  const idx: LiveIndex = { prefixes, dbNames, storeNames };
  indexCache.set(live, idx);
  return idx;
}

// The (dbId:osId) keys whose db/store match an entity definition. Uses the shared per-live catalog
// (no re-scan). `mapping` is typed to also accept `null` because callers commonly pass the result
// of `selectMapping(...).mapping` straight through without a guard, exactly as the untyped original
// did — a null mapping still throws the same TypeError on first access below.
export function entityTargets(
  live: Entry[],
  mapping: Mapping | null,
  entityName: string,
): Set<string> {
  const def = (mapping as Mapping).entities[entityName];
  const { dbNames, storeNames } = liveIndex(live);
  const targets = new Set<string>();
  for (const [sk, storeName] of storeNames) {
    const dbId = Number(sk.split(':')[0]);
    const dbName = dbNames.get(dbId);
    if (dbName && glob(def.db, dbName) && storeName === def.store) targets.add(sk);
  }
  return targets;
}

// Extract rows for one entity definition. Each row carries __key = the source record's
// leveldb user-key (latin1) so callers can group messages by their reply-chain record.
// `targets` (from entityTargets) may be supplied to extract from a subset of `live` that
// lacks the db-name metadata (incremental path). Iterates `live` in order (output order
// preserved) using the shared prefix index — no per-entry re-decode of the key prefix.
export function extractEntity(
  live: Entry[],
  mapping: Mapping | null,
  entityName: string,
  targets?: Set<string>,
): ExtractedRow[] {
  const def = (mapping as Mapping).entities[entityName];
  targets ??= entityTargets(live, mapping, entityName);
  const { prefixes } = liveIndex(live);

  const mapFields = (src: unknown, recKey: string): ExtractedRow => {
    const r: ExtractedRow = { __key: recKey };
    for (const [out, spec] of Object.entries(def.fields)) r[out] = firstDefined(src, spec);
    return r;
  };

  // One decoded record → 0..n rows. A def may `iterate` a container of sub-items (optionally
  // `keep`-filtered); otherwise the whole record is one row.
  const rowsFromRecord = (obj: unknown, recKey: string): ExtractedRow[] => {
    if (!def.iterate) return [mapFields(obj, recKey)];
    const container = getPath(obj, def.iterate.replace(/\.\*$/, ''));
    if (!container || typeof container !== 'object') return [];
    const out: ExtractedRow[] = [];
    for (const item of Object.values(container as Record<string, unknown>)) {
      if (
        def.keep &&
        (item as Record<string, unknown> | null | undefined)?.[def.keep.field] !== def.keep.equals
      )
        continue;
      out.push(mapFields(item, recKey));
    }
    return out;
  };

  const rows: ExtractedRow[] = [];
  for (let i = 0; i < live.length; i++) {
    const p = prefixes[i];
    if (!p || p.indexId !== 1) continue;
    if (!targets.has(`${p.databaseId}:${p.objectStoreId}`)) continue;
    const { key, value } = live[i];
    let obj: unknown;
    try {
      obj = decodeValue(value);
    } catch {
      continue;
    }
    if (!obj) continue;
    rows.push(...rowsFromRecord(obj, key.toString('latin1')));
  }
  return rows;
}
