// Browser-safe public surface (plan A7). Everything re-exported here is fs-free: the decode + schema
// layers operating on a SnapshotSource, with none of the Node-only entry points — no string-dir
// `loadSnapshot`, no fs mapping loaders (`loadMapping`/`loadBundledMappingTexts`), no on-disk locator
// (`discoverTeamsDbs`). A browser caller preloads a leveldb dir into a `MemorySource` (async only at
// that boundary) and drives `loadSnapshotFrom` → `fingerprint` → `selectMapping` → `extractEntity`.
// Exposed as the explicit "./web" subpath (NOT a `browser` condition on `./format`): a different
// capability set deserves a distinct name, and `.`/`./format` stay exactly as they are.
export { loadSnapshotFrom, loadSnapshotFromAsync } from './format/chromium/indexeddb.js';
// Per-file `.ldb` parse primitive — a parse-worker pool calls this, then feeds the results back to
// loadSnapshotFrom via its `parsedTables` option (see LoadEntriesOptions). Parallel decode, one seam.
export { parseTable } from './format/chromium/sstable.js';
// Transfer codec (M4a): the parse worker packs each result into 3 transferables (packTable +
// packedTransferList) instead of N tiny per-entry buffers; the coordinator rebuilds it with unpackTable.
// Engine-agnostic — also on the non-web ./format surface.
// packRecords/unpackRecords apply the same 3-buffer flattening to the parallel EXTRACT dispatch.
export {
  packTable,
  unpackTable,
  packedTransferList,
  type PackedTable,
  packRecords,
  unpackRecords,
  packedRecordsTransferList,
  type PackedRecords,
} from './format/table-transfer.js';
export { MemorySource } from './format/chromium/memory-source.js';
export { fingerprint } from './format/fingerprint.js';
export {
  selectMapping,
  entityTargets,
  extractEntity,
  extractRecords,
  loadBundledMappings,
} from './format/resolver.js';
// Topics analytics primitives — the phrase extractor + the lift-scoring/window helpers are PURE (no
// ChatStore/SQL): a consumer feeds them `(ts, sender_mri, content)` rows from ANY engine and gets the
// same ranked topics as the built-in `topics.compute`. (Used by the DuckDB POC to score topics over
// DuckDB-returned rows — proof the analytics core isn't SQLite-specific.)
export { computeTopicRows, computeTopicsWindow } from './query.js';
export { makeExtractor } from './util/topics.js';
export { sampleStoreFields, type StoreFieldSample } from './format/sample.js';
export { proposeSchema, type SchemaProposal, type ProposedStore } from './format/propose.js';
export type * from './format/types.js';

// The static query facade (plan B5): build a store from a SnapshotSource on an injected SqlDriver, then
// query it with the same StoreView namespaces as the Node openStore(dir) — minus live-refresh. Types
// are exported so a browser consumer can name everything the facade returns (all type-only, zero bundle
// cost). The driver types let the consumer type the wasm driver they inject.
export {
  openStoreFromSource,
  openStoreFromSnapshot,
  type BuildPhase,
  type StoreView,
  type TeamsStore,
  type ConversationsApi,
  type MessagesApi,
  type PeopleApi,
  type EventsApi,
  type CallsApi,
  type TopicsApi,
  type MessageSearchOptions,
  type ConversationMessagesOptions,
  type ConversationListOptions,
  type PeopleFindOptions,
  type EventsListOptions,
  type CallsListOptions,
  type TopicsComputeOptions,
  type MessageSearchResult,
  type ConvMessagesResult,
  type TopicsComputeResult,
} from './store-facade.js';
// Parallel-extract seam: a consumer supplies an ExtractExecutor (e.g. a worker pool running
// extractRecords) to openStoreFromSnapshot; the library owns the ordering/reassembly.
export type { ExtractExecutor, ExtractTask } from './ingest/ingest-core.js';
// Turn-key parallel cold read: `createPool` spawns a browser Web Worker pool whose workers run
// `handlePoolMessage` (a 2-line entry), and `openStoreFromSourceParallel` drives parse+fold+extract over
// it with a serial fallback — the same fast path both example apps use, promoted for any browser consumer.
// (The @sqlite.org/sqlite-wasm driver is the separate `libzaungast/web/sqlite-wasm-driver` subpath.)
export { createPool } from './pool.js';
export { handlePoolMessage, type PoolRequest, type PoolResponse } from './pool-worker.js';
export {
  openStoreFromSourceParallel,
  type Pool,
  type ParallelBuildOptions,
  type ParallelBuildResult,
} from './parallel.js';
export type { SqlDriver, SqlDatabase, SqlStatement, SqlParam } from './ingest/sql-driver.js';
export type { StoreMeta } from './ingest/store.js';
export type {
  Conversation,
  Message,
  ReactionGroup,
  SearchHit,
  ThreadSummary,
  Person,
  PeopleResult,
  CalendarEvent,
  Attendee,
  Call,
  RecordingLink,
  Topic,
  QueryMiss,
  ConvMessagesMiss,
} from './query.js';
