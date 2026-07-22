// Public surface of the on-disk store reader — the one import path the rest of
// the app (src/ingest, src/session, src/tools) uses. Callers never reach into
// engine internals directly.
//
// The pipeline is:
//   on-disk store dir --[engine reader]--> live records (raw key + raw value)
//                     --[schema layer]--> version-identified, field-mapped rows
//
//   * Engine reader — ./chromium: the Windows Chromium-IndexedDB-on-LevelDB byte
//     format (SSTable, write-ahead log, Snappy, IndexedDB key coding, V8
//     structured clone). Platform/engine-specific.
//   * Schema layer  — ./fingerprint + ./resolver: version identification and
//     field mapping. Engine-agnostic in intent (they work on decoded records);
//     today they call the Chromium decoders directly — that call is the seam to
//     generalise when a second engine lands.
//   * Locator       — ./discover: finds the store on disk (Windows paths today).
//
// Adding a second platform (e.g. macOS WebKit-on-SQLite) means adding a sibling
// engine directory (./webkit) that yields the same record contract from ./types,
// then selecting between engines here — "add a directory", not a rewrite.

// Public /format surface (audience #2 — decode/schema/power users). The Chromium byte readers
// (decodePrefix/readVarint/readStringWithLength/utf16be), the raw value decoder (decodeValue), and
// the legacy/internal loaders (loadEntries/loadEntriesReuse/loadSnapshotReuse) are NOT exported —
// they are engine-version-specific internals reachable only from within the package (relative
// imports). Only loadSnapshot (the grouped Snapshot) is public.
export { loadSnapshot } from './chromium/indexeddb.js';
export { fingerprint } from './fingerprint.js';
export {
  loadMapping,
  selectMapping,
  entityTargets,
  extractEntity,
  extractRecords,
} from './resolver.js';
export { discoverTeamsDbs } from './discover.js';
// Structural field-sampler for schema recovery — reads field NAMES only, so the raw value decoder
// stays internal (see sample.ts). This is what describe_schema-style consumers use.
export { sampleStoreFields, type StoreFieldSample } from './sample.js';
// Propose-only schema recovery: the candidate-matching/scoring/assembly ALGORITHM over a sampled
// snapshot (data only; the MCP describe_schema tool renders it). See propose.ts.
export { proposeSchema, type SchemaProposal, type ProposedStore } from './propose.js';
export type * from './types.js';
