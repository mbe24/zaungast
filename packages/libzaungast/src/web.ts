// Browser-safe public surface (plan A7). Everything re-exported here is fs-free: the decode + schema
// layers operating on a SnapshotSource, with none of the Node-only entry points — no string-dir
// `loadSnapshot`, no fs mapping loaders (`loadMapping`/`loadBundledMappingTexts`), no on-disk locator
// (`discoverTeamsDbs`). A browser caller preloads a leveldb dir into a `MemorySource` (async only at
// that boundary) and drives `loadSnapshotFrom` → `fingerprint` → `selectMapping` → `extractEntity`.
// Exposed as the explicit "./web" subpath (NOT a `browser` condition on `./format`): a different
// capability set deserves a distinct name, and `.`/`./format` stay exactly as they are.
export { loadSnapshotFrom } from './format/chromium/indexeddb.js';
export { MemorySource } from './format/chromium/memory-source.js';
export { fingerprint } from './format/fingerprint.js';
export {
  selectMapping,
  entityTargets,
  extractEntity,
  extractRecords,
  loadBundledMappings,
} from './format/resolver.js';
export { sampleStoreFields, type StoreFieldSample } from './format/sample.js';
export { proposeSchema, type SchemaProposal, type ProposedStore } from './format/propose.js';
export type * from './format/types.js';
