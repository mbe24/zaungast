import fs from 'node:fs';
// Engine seam: mapping/extraction is engine-agnostic in intent (a mapped record has the same
// fields however it was stored), but today it decodes raw Chromium records inline. A second
// engine would hand this module already-decoded records. See ./index.ts.
// Only Chromium dependency left after the Snapshot migration: value decoding (keys/grouping/catalog
// are resolved by the loader into the Snapshot). This is the documented, deferred value-decode seam.
import { decodeValue } from './chromium/indexeddb.js';
import type {
  Entry,
  ExtractedRow,
  FingerprintResult,
  Mapping,
  Snapshot,
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

// The (dbId:osId) keys whose db/store match an entity definition, read straight from the snapshot's
// resolved catalog (no scan, no key decode). `mapping` is typed to also accept `null` because
// callers commonly pass `selectMapping(...).mapping` straight through — a null mapping still throws
// the same TypeError on first access, exactly as the untyped original did.
export function entityTargets(
  snap: Snapshot,
  mapping: Mapping | null,
  entityName: string,
): Set<string> {
  const def = (mapping as Mapping).entities[entityName];
  const targets = new Set<string>();
  for (const [sk, storeName] of snap.storeNames) {
    const dbId = Number(sk.split(':')[0]);
    const dbName = snap.dbNames.get(dbId);
    if (dbName && glob(def.db, dbName) && storeName === def.store) targets.add(sk);
  }
  return targets;
}

// Map an already-selected set of records (all from one entity's store) to rows via its mapping def.
// Each row carries __key = the source record's leveldb user-key (latin1) so callers can group
// messages by their reply-chain record. Shared by extractEntity (whole target buckets) and
// extractRecords (an incremental changed-subset).
function recordsToRows(records: Entry[], def: Mapping['entities'][string]): ExtractedRow[] {
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
  for (const rec of records) {
    let obj: unknown;
    try {
      obj = decodeValue(rec.value);
    } catch {
      continue;
    }
    if (!obj) continue;
    rows.push(...rowsFromRecord(obj, rec.key.toString('latin1')));
  }
  return rows;
}

// Extract rows for one entity definition from a snapshot — iterate only the target buckets'
// (indexId===1) records; no full scan, no key re-decode. `targets` (from entityTargets) may be
// supplied to skip recomputing them.
export function extractEntity(
  snap: Snapshot,
  mapping: Mapping | null,
  entityName: string,
  targets?: Set<string>,
): ExtractedRow[] {
  const def = (mapping as Mapping).entities[entityName];
  targets ??= entityTargets(snap, mapping, entityName);
  const rows: ExtractedRow[] = [];
  for (const sk of targets) {
    const b = snap.buckets.get(sk);
    if (b) rows.push(...recordsToRows(b.records, def));
  }
  return rows;
}

// Extract rows from an explicit record set (the incremental path isolates the changed subset of one
// entity's store and maps just those, avoiding a whole-store re-extract).
export function extractRecords(
  records: Entry[],
  mapping: Mapping | null,
  entityName: string,
): ExtractedRow[] {
  return recordsToRows(records, (mapping as Mapping).entities[entityName]);
}
