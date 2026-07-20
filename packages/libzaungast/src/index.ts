// libzaungast public API (B3: narrowed to the intended surface).
//
// The root entry is the high-level DATA API (audience #1): open a store, query its orthogonal
// namespaces (conversations / messages / people / events / calls / topics). The decode/schema layer
// for power users (audience #2) is at 'libzaungast/format'; the format engine-seam types at
// 'libzaungast/format/engine'; the ingest-engine SPI for engine authors (audience #3) at
// 'libzaungast/engine-spi'. Everything else is INTERNAL and unreachable through the package's
// exports map: the SQL query layer (query.ts), the SQLite ChatStore + its raw db handle, Session,
// the ingest internals, and the Chromium byte readers / value decoder.
//
// Guarantees (upheld by the API, enforced by the absence of any other surface): read-only (never
// writes/locks/mmaps the Teams dir — it reads copies), offline (no network, zero runtime deps),
// metadata-only (media surfaces as markers, never bytes; no credentials). Pre-1.0: the split and the
// error contract are stable; row-shape/query details may still change.

// Entry points + the lifetime-owning facade.
export { openStore, openLiveStore, tryOpen, inspect } from './store-api.js';
export type {
  TeamsStore,
  LiveTeamsStore,
  StoreReading,
  StoreView,
  StoreInspection,
  OpenStoreOptions,
  LiveOptions,
  ConversationsApi,
  MessagesApi,
  PeopleApi,
  EventsApi,
  CallsApi,
  TopicsApi,
  MessageSearchOptions,
  ConversationMessagesOptions,
  ConversationListOptions,
  PeopleFindOptions,
  EventsListOptions,
  CallsListOptions,
  TopicsComputeOptions,
  MessageSearchResult,
  ConvMessagesResult,
  TopicsComputeResult,
} from './store-api.js';

// The typed row/result shapes the query namespaces return (data types only — the query functions
// themselves are internal).
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

// Public helper + the store-metadata type. htmlToText is Teams-domain functionality (the library
// hands out raw CalendarEvent.bodyHtml on purpose). Bot-ness is exposed as DATA on the rows
// (Person.isBot / Message.senderIsBot), so the isBotMri predicate stays internal.
export { htmlToText } from './util/text.js';
export type { StoreMeta } from './ingest/store.js';
