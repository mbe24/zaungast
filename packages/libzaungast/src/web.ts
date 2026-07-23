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

// The static query facade (plan B5): build a store from a SnapshotSource on an injected SqlDriver, then
// query it with the same StoreView namespaces as the Node openStore(dir) — minus live-refresh. Types
// are exported so a browser consumer can name everything the facade returns (all type-only, zero bundle
// cost). The driver types let the consumer type the wasm driver they inject.
export {
  openStoreFromSource,
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
