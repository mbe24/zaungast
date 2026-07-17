import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Mapping/extraction reads decoded structured-clone values from the snapshot's records. Keys,
// grouping, and the catalog are already resolved by the loader into the Snapshot; the only Chromium
// call left here is value decoding (decodeValue), which is fine — macOS Teams uses the same Chromium
// store, so there is no second value format to abstract for.
import { decodeValue } from './chromium/indexeddb.js';
import type {
  SnapshotRecord,
  EntityRecord,
  EntityExtract,
  Fingerprint,
  Mapping,
  Snapshot,
  MappingMatch,
} from './types.js';

// Resolve a mapping file against a fingerprint, then extract entities generically.

export function loadMapping(path: string): Mapping {
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

// The mapping files bundled with the package (src/schema/versions/*.json; copied to dist/ by the
// build, so this resolves the same in dev and prod). Loaded once and cached — they're static
// shipped data.
const VERSIONS_DIR = fileURLToPath(new URL('../schema/versions/', import.meta.url));
let bundledMappings: Mapping[] | null = null;
export function loadBundledMappings(): Mapping[] {
  if (!bundledMappings)
    bundledMappings = fs
      .readdirSync(VERSIONS_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => loadMapping(path.join(VERSIONS_DIR, f)));
  return bundledMappings;
}

// Raw JSON text of every bundled mapping — handed verbatim to the native engine, which does its own
// fingerprint + selectMapping (seam A: the expensive read lives in Rust, so TS can't pre-select).
export function loadBundledMappingTexts(): string[] {
  return fs
    .readdirSync(VERSIONS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => fs.readFileSync(path.join(VERSIONS_DIR, f), 'utf8'));
}

// Pick a mapping for the given fingerprint: exact hash match, else store-presence match. Defaults to
// the mappings bundled with the package (so a consumer never has to load mapping JSON themselves);
// pass `{ mappings }` to override with your own set.
export function selectMapping(fp: Fingerprint, opts: { mappings?: Mapping[] } = {}): MappingMatch {
  const mappings = opts.mappings ?? loadBundledMappings();
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
function recordsToRows(records: SnapshotRecord[], def: Mapping['entities'][string]): EntityExtract {
  const mapFields = (src: unknown, recKey: string): EntityRecord => {
    const r: EntityRecord = { __key: recKey };
    for (const [out, spec] of Object.entries(def.fields)) r[out] = firstDefined(src, spec);
    return r;
  };
  // One decoded record → 0..n rows. A def may `iterate` a container of sub-items (optionally
  // `keep`-filtered); otherwise the whole record is one row.
  const rowsFromRecord = (obj: unknown, recKey: string): EntityRecord[] => {
    if (!def.iterate) return [mapFields(obj, recKey)];
    const container = getPath(obj, def.iterate.replace(/\.\*$/, ''));
    if (!container || typeof container !== 'object') return [];
    const out: EntityRecord[] = [];
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

  const rows: EntityRecord[] = [];
  let decoded = 0;
  let dropped = 0;
  for (const rec of records) {
    let obj: unknown;
    try {
      obj = decodeValue(rec.value);
    } catch {
      dropped++;
      continue;
    }
    if (!obj) {
      dropped++;
      continue;
    }
    decoded++;
    rows.push(...rowsFromRecord(obj, rec.key.toString('latin1')));
  }
  return { records: rows, decoded, dropped };
}

// Extract rows for one entity definition from a snapshot — iterate only the target buckets'
// (indexId===1) records; no full scan, no key re-decode. `targets` (from entityTargets) may be
// supplied to skip recomputing them.
export function extractEntity(
  snap: Snapshot,
  mapping: Mapping | null,
  entityName: string,
  targets?: Set<string>,
): EntityExtract {
  const def = (mapping as Mapping).entities[entityName];
  targets ??= entityTargets(snap, mapping, entityName);
  const records: EntityRecord[] = [];
  let decoded = 0;
  let dropped = 0;
  for (const sk of targets) {
    const b = snap.buckets.get(sk);
    if (b) {
      const e = recordsToRows(b.records, def);
      records.push(...e.records);
      decoded += e.decoded;
      dropped += e.dropped;
    }
  }
  return { records, decoded, dropped };
}

// Extract rows from an explicit record set (the incremental path isolates the changed subset of one
// entity's store and maps just those, avoiding a whole-store re-extract).
export function extractRecords(
  records: SnapshotRecord[],
  mapping: Mapping | null,
  entityName: string,
): EntityExtract {
  return recordsToRows(records, (mapping as Mapping).entities[entityName]);
}
