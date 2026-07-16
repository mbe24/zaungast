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

export {
  loadEntries,
  loadEntriesReuse,
  loadSnapshot,
  loadSnapshotReuse,
  decodePrefix,
  decodeValue,
  readVarint,
  readStringWithLength,
  utf16be,
} from './chromium/indexeddb.js';
export { fingerprint } from './fingerprint.js';
export { loadMapping, selectMapping, entityTargets, extractEntity, extractRecords } from './resolver.js';
export { discoverTeamsDbs } from './discover.js';
export type * from './types.js';
