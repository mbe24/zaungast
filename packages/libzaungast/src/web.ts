// Browser-safe public surface (plan A7). Everything re-exported here is fs-free: the decode + schema
// layers operating on a SnapshotSource, with none of the Node-only entry points — no string-dir
// `loadSnapshot`, no fs mapping loaders (`loadMapping`/`loadBundledMappingTexts`), no on-disk locator
// (`discoverTeamsDbs`). A browser caller preloads a leveldb dir into a `MemorySource` (async only at
// that boundary) and drives `openStoreFromSourceParallel` (turn-key) or the kernel below.
// Exposed as the explicit "./web" subpath (NOT a `browser` condition on `./format`): a different
// capability set deserves a distinct name, and `.`/`./format` stay exactly as they are.
//
// SURFACE POLICY: this barrel is the TURN-KEY browser API — the mid-level parse/codec/executor primitives
// it used to expose (parseTable, the packTable/packRecords transfer codec, loadSnapshotFromAsync,
// openStoreFromSnapshot, ExtractExecutor, extractRecords, entityTargets) are now fully internal to
// `handlePoolMessage` + `openStoreFromSourceParallel`/`extractFromSourceParallel`, so they've been removed
// here. The codec + parseTable remain on the Node `./format` surface for power users / a future
// worker_threads pool. (A query-level async backend abstraction — AsyncStoreView/StoreBackend — is
// deliberately deferred: `StoreView` is the canonical namespace contract and a mapped async type is a
// semver-minor add the day a second backend implements full `StoreView`; the multi-DB seam that ships is
// the DATA-level shapeBaseTables/deriveTables below.)

// Decode + schema kernel (fs-free; `./format` is Node-only, so `./web` is the browser's only access here).
export { loadSnapshotFrom } from './format/chromium/indexeddb.js';
export { MemorySource } from './format/chromium/memory-source.js';
export { fingerprint } from './format/fingerprint.js';
export { selectMapping, extractEntity, loadBundledMappings } from './format/resolver.js';
export { sampleStoreFields, type StoreFieldSample } from './format/sample.js';
export { proposeSchema, type SchemaProposal, type ProposedStore } from './format/propose.js';
export type * from './format/types.js';

// Analytics primitives — PURE (no ChatStore/SQL): feed them `(ts, sender_mri, content)` rows from ANY
// engine to get the same ranked topics as `topics.compute`. `htmlToText` matches the raw-HTML the facade
// hands out (CalendarEvent.bodyHtml, message content pre-render).
export { computeTopicRows, computeTopicsWindow } from './query.js';
export { makeExtractor as makePhraseExtractor } from './util/topics.js';
export { htmlToText } from './util/text.js';

// The static query facade (plan B5): build a store from a SnapshotSource on an injected SqlDriver, then
// query it with the same StoreView namespaces as the Node openStore(dir) — minus live-refresh. Types are
// exported so a browser consumer can name everything the facade returns (all type-only, zero bundle cost).
export {
  openStoreFromSource,
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

// Engine-agnostic store-build seam: shape the raw extract into base tables (shared by any DB backend), and
// derive the people + conversation aggregates in pure JS (the dialect-free equivalent of the SQLite
// recompute). A non-SQLite backend consumes these to build an independent, data-matching store.
export {
  shapeBaseTables,
  deriveTables,
  baseMeta,
  type FullExtract,
  type BaseTables,
  type ConvMetaRow,
  type ProfileRow,
  type EventRow,
  type CallRow,
  type DerivedTables,
  type DerivedPerson,
  type DerivedConversation,
} from './ingest/ingest-core.js';
export type { MessageInsert } from './ingest/store.js';

// Turn-key parallel cold read: `createPool` spawns a browser Web Worker pool whose workers run
// `handlePoolMessage` (a 2-line entry), and `openStoreFromSourceParallel` / `extractFromSourceParallel`
// drive parse+fold(+extract) over it with a serial fallback — the fast path both example apps use.
// `Pool` is the single parallelism extension point (a Node worker_threads pool satisfying it slots in);
// `PoolRequest`/`PoolResponse` are opaque protocol types a consumer never constructs.
// (The @sqlite.org/sqlite-wasm driver is the separate `libzaungast/web/sqlite-wasm-driver` subpath.)
export { createPool } from './pool.js';
export { handlePoolMessage, type PoolRequest, type PoolResponse } from './pool-worker.js';
export {
  openStoreFromSourceParallel,
  extractFromSourceParallel,
  type Pool,
  type ParallelBuildOptions,
  type ParallelBuildResult,
  type ParallelExtractOptions,
  type ParallelExtractResult,
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
