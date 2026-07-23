// Browser-safe query facade: the `StoreView` namespaces (conversations / messages / people / events /
// calls / topics) over a resident ChatStore, plus `openStoreFromSource` — the static, browser-capable
// spine that builds a store from a SnapshotSource on an injected SqlDriver. No `Session`, no
// `loadSnapshot(dir)`, no `node:*`: the Node entry points (`openStore(dir)`, `openLiveStore`, `tryOpen`,
// `inspect`) live in store-api.ts, which re-exports this module. `makeApis` is shared with the Node
// live handle (LiveTeamsStoreImpl), so it is exported.
//
// Error contract (stated once): a FALLIBLE facade query returns `{ ok: false, reason: QueryMiss } |
// { ok: true, … }`; an INFALLIBLE one returns its rows/value directly. Never a silent fall-through.
import type { ChatStore, StoreMeta } from './ingest/store.js';
import type { SqlDriver } from './ingest/sql-driver.js';
import type { SnapshotSource } from './format/types.js';
import { loadSnapshotFrom } from './format/chromium/indexeddb.js';
import { buildStore, extractFromSnapshot, type Ingested } from './ingest/ingest-core.js';
import {
  queryConversations,
  conversationById,
  resolveConversations,
  querySearch,
  queryConversationMessages,
  queryThread,
  messageById,
  queryThreadSummaries,
  convMessageStats,
  queryPeople,
  queryEvents,
  maxEventStart,
  queryCalls,
  loadTopicsInScope,
  computeTopicsWindow,
  computeTopicRows,
  buildPhraseExtractor,
  toMessage,
  toSearchHit,
  toThreadSummary,
  type SearchOptions,
  type ConvMessagesOptions,
  type Conversation,
  type Message,
  type SearchHit,
  type ThreadSummary,
  type PeopleResult,
  type CalendarEvent,
  type Call,
  type Topic,
  type QueryMiss,
  type ConvMessagesMiss,
} from './query.js';

// Default row caps for the message reads (the query layer requires an explicit limit; the facade
// supplies a sensible default so a consumer need not think about it).
const DEFAULT_SEARCH_LIMIT = 30;
const DEFAULT_CONV_MESSAGES_LIMIT = 40;

// ---------- options ----------

// Message-search options mirror query.ts's SearchOptions, but the facade owns the store, so it fills
// `ftsEnabled` from it and defaults `limit` — both drop off here. (`ftsEnabled` is an implementation
// switch, not an option: the store knows whether the FTS index exists.)
export type MessageSearchOptions = Omit<SearchOptions, 'ftsEnabled' | 'limit'> & { limit?: number };
// Flat-conversation read options; `limit` defaults if omitted.
export type ConversationMessagesOptions = Omit<ConvMessagesOptions, 'limit'> & { limit?: number };

// Option shapes for the delegating namespaces — derived from the query fns so they can't drift.
export type ConversationListOptions = NonNullable<Parameters<typeof queryConversations>[1]>;
export type PeopleFindOptions = NonNullable<Parameters<typeof queryPeople>[1]>;
export type EventsListOptions = NonNullable<Parameters<typeof queryEvents>[1]>;
export type CallsListOptions = NonNullable<Parameters<typeof queryCalls>[1]>;

export interface TopicsComputeOptions {
  scope?: string;
  exclude?: string[];
  includeBots?: boolean;
  window?: string; // '1d' | '7d' | '30d' (defaults to 7d in computeTopicsWindow)
  sinceTs?: number; // explicit range (epoch ms) — overrides the window when set
  untilTs?: number;
  n?: number;
  extraStopwords?: Iterable<string>; // union'd with the store-level extraStopwords
}

// ---------- result shapes ----------

// A search's success arm carries typed hits + the DATA the renderer needs for its non-blocking notes
// (`inIds` for the in:-ambiguity note, `coverage` for the cache-horizon note). On a scope miss the
// QueryMiss reason is surfaced verbatim.
export type MessageSearchResult =
  | { ok: false; reason: QueryMiss }
  | {
      ok: true;
      rows: SearchHit[];
      order: 'relevance' | 'time';
      inIds?: string[];
      coverage?: { hi: number; lo: number };
    };

// A flat conversation read: on success the mapped rows + a `nextOlder` keyset cursor when older
// messages remain; on a miss ('no-such-message' for an absent `around:` pivot) the reason.
export type ConvMessagesResult =
  { ok: false; reason: ConvMessagesMiss } | { ok: true; rows: Message[]; nextOlder?: string };

// On a scope miss the QueryMiss reason is surfaced verbatim (never a silent whole-DB fall-through);
// otherwise the scored topic rows PLUS every fact a renderer states about the run — the window and
// its message count, the scope's all-time size (0 ⇒ "no messages in scope"), the baseline size, the
// count of bot/app messages dropped, and the resolved conversation ids (scope=conversation:).
export type TopicsComputeResult =
  | { ok: false; reason: QueryMiss }
  | {
      ok: true;
      rows: Topic[];
      window: { sinceTs: number; untilTs: number };
      windowCount: number; // messages inside the window
      scopeTotal: number; // messages in scope across all time (0 → "no messages in scope")
      baseTotal: number; // baseline size (messages before the window)
      botExcluded: number; // bot/app messages dropped (disclosure note)
      scopeConvIds?: string[]; // resolved ids when scope=conversation: (ambiguity note)
    };

// ---------- namespace surface ----------

export interface ConversationsApi {
  list(opts?: ConversationListOptions): Conversation[];
  // Point lookup by leveldb id OR `c:` handle → the conversation (or null).
  get(id: string): Conversation | null;
  // `c:handle` or a title/participant substring → candidate conversations WITH display fields,
  // newest-first (last_ts desc). The MCP owns the thresholds/prose around ambiguity.
  resolve(sel: string): Conversation[];
}
export interface MessagesApi {
  search(opts?: MessageSearchOptions): MessageSearchResult;
  inConversation(convId: string, opts?: ConversationMessagesOptions): ConvMessagesResult;
  // Point lookup by (convId, id) — the around→root_id pivot; null when absent.
  get(convId: string, id: string): Message | null;
  thread(convId: string, rootId: string): Message[];
  threadSummaries(convId: string, opts?: { sinceTs?: number; untilTs?: number }): ThreadSummary[];
  stats(convId: string): { total: number; earliestTs: number; newestTs: number };
}
export interface PeopleApi {
  find(opts?: PeopleFindOptions): PeopleResult;
  // Best display name for an MRI (people → profiles fallback), or null.
  nameFor(mri: string): string | null;
}
export interface EventsApi {
  list(opts?: EventsListOptions): CalendarEvent[];
  // Newest materialized occurrence start across ALL events (the honest recurring-events bound).
  maxStart(): number;
}
export interface CallsApi {
  list(opts?: CallsListOptions): Call[];
}
export interface TopicsApi {
  compute(opts?: TopicsComputeOptions): TopicsComputeResult;
}

// The query surface, with no lifetime: the six orthogonal namespaces + the load's `meta`. Shared by
// the static handle and by a live handle's pinned reading.
export interface StoreView {
  readonly meta: StoreMeta;
  readonly conversations: ConversationsApi;
  readonly messages: MessagesApi;
  readonly people: PeopleApi;
  readonly events: EventsApi;
  readonly calls: CallsApi;
  readonly topics: TopicsApi;
}

// The lifetime-owning static handle. `meta` describes the load (fingerprint/schemaMatched/lossy/
// counts/…). Its `lastFullAt`/`refreshMode` fields are live-refresh diagnostics — static and
// meaningless for a one-shot `openStore`/`openStoreFromSource`.
export interface TeamsStore extends StoreView {
  close(): void;
  [Symbol.dispose](): void;
}

// ---------- namespace factory (shared by the static handle + a live reading) ----------
// `getStore` is a constant accessor bound to ONE ChatStore build, so every namespace call on the
// resulting view hits the same build (this is how read-consistency is delivered — the static handle
// owns one store for its lifetime; a live reading pins the build `current()` observed).

function mergeStopwords(...sets: (Iterable<string> | undefined)[]): Iterable<string> | undefined {
  const out = new Set<string>();
  for (const s of sets) if (s) for (const w of s) out.add(w);
  return out.size ? out : undefined; // undefined keeps buildPhraseExtractor byte-identical
}

export function makeApis(
  getStore: () => ChatStore,
  baseExtraStopwords?: Iterable<string>,
): {
  conversations: ConversationsApi;
  messages: MessagesApi;
  people: PeopleApi;
  events: EventsApi;
  calls: CallsApi;
  topics: TopicsApi;
} {
  const conversations: ConversationsApi = {
    list: (opts = {}) => queryConversations(getStore(), opts),
    get: (id) => conversationById(getStore(), id),
    resolve: (sel) => resolveConversations(getStore(), sel),
  };
  const messages: MessagesApi = {
    search: (opts = {}) => {
      const store = getStore();
      const res = querySearch(store, {
        ...opts,
        limit: opts.limit ?? DEFAULT_SEARCH_LIMIT,
        ftsEnabled: store.ftsEnabled,
      });
      if (!res.ok) return res;
      return {
        ok: true,
        rows: res.rows.map(toSearchHit),
        order: res.order,
        inIds: res.inIds,
        coverage: res.coverage,
      };
    },
    inConversation: (convId, opts = {}) => {
      const limit = opts.limit ?? DEFAULT_CONV_MESSAGES_LIMIT;
      const res = queryConversationMessages(getStore(), convId, { ...opts, limit });
      if ('aroundNotFound' in res)
        return { ok: false, reason: { reason: 'no-such-message', value: res.aroundNotFound } };
      // nextOlder: a keyset cursor for the previous page. Rows are oldest→newest, so the oldest is
      // rows[0]. Offered only for the paged (non-`around`) path and only when the window filled —
      // a full page is the standard "older rows likely remain" signal.
      let nextOlder: string | undefined;
      if (!opts.around && res.rows.length >= limit && res.rows.length) {
        const oldest = res.rows[0];
        nextOlder = `older:${oldest.ts}:${oldest.id}`;
      }
      return { ok: true, rows: res.rows.map(toMessage), nextOlder };
    },
    get: (convId, id) => {
      const r = messageById(getStore(), convId, id);
      return r ? toMessage(r) : null;
    },
    thread: (convId, rootId) => queryThread(getStore().db, convId, rootId).map(toMessage),
    threadSummaries: (convId, opts = {}) =>
      queryThreadSummaries(getStore(), convId, opts).map(toThreadSummary),
    stats: (convId) => {
      const s = convMessageStats(getStore().db, convId);
      return { total: s.total, earliestTs: s.earliest, newestTs: s.newest };
    },
  };
  const people: PeopleApi = {
    find: (opts = {}) => queryPeople(getStore(), opts),
    nameFor: (mri) => getStore().nameForMri(mri),
  };
  const events: EventsApi = {
    list: (opts = {}) => queryEvents(getStore(), opts),
    maxStart: () => maxEventStart(getStore()),
  };
  const calls: CallsApi = { list: (opts = {}) => queryCalls(getStore(), opts) };
  const topics: TopicsApi = {
    compute: (opts = {}) => {
      const store = getStore();
      const scoped = loadTopicsInScope(store, {
        scope: opts.scope,
        exclude: opts.exclude,
        includeBots: opts.includeBots,
      });
      if (!scoped.ok) return scoped; // { ok: false, reason } — surfaced verbatim
      const extra = mergeStopwords(baseExtraStopwords, opts.extraStopwords);
      const phrases = buildPhraseExtractor(store, store.db, new Set(scoped.excludeWords), extra);
      const explicit = opts.sinceTs != null || opts.untilTs != null;
      const { sinceTs, untilTs } = computeTopicsWindow(scoped.all, {
        explicit,
        sinceTs: opts.sinceTs,
        untilTs: opts.untilTs,
        windowKey: opts.window,
      });
      const n = Math.min(Number(opts.n) || 8, 15);
      const { rows, baseTotal, win } = computeTopicRows(
        scoped.all,
        phrases,
        sinceTs,
        untilTs,
        scoped.minSenders,
        n,
      );
      return {
        ok: true,
        rows,
        window: { sinceTs, untilTs },
        windowCount: win.length,
        scopeTotal: scoped.all.length,
        baseTotal,
        botExcluded: scoped.botExcluded,
        scopeConvIds: scoped.scopeConvIds,
      };
    },
  };
  return { conversations, messages, people, events, calls, topics };
}

// ---------- static handle ----------

export class StaticTeamsStore implements TeamsStore {
  readonly conversations: ConversationsApi;
  readonly messages: MessagesApi;
  readonly people: PeopleApi;
  readonly events: EventsApi;
  readonly calls: CallsApi;
  readonly topics: TopicsApi;
  private readonly store: ChatStore;
  private readonly _meta: StoreMeta;

  constructor(ingested: Ingested, extraStopwords?: Iterable<string>) {
    this.store = ingested.store;
    this._meta = ingested.meta;
    const apis = makeApis(() => this.store, extraStopwords);
    this.conversations = apis.conversations;
    this.messages = apis.messages;
    this.people = apis.people;
    this.events = apis.events;
    this.calls = apis.calls;
    this.topics = apis.topics;
  }

  get meta(): StoreMeta {
    return this._meta;
  }
  close(): void {
    this.store.close();
  }
  [Symbol.dispose](): void {
    this.close();
  }
}

// ---------- browser entry point ----------

// One-shot static read of a leveldb store presented as a `SnapshotSource` (the browser path — e.g. a
// `MemorySource` preloaded from a directory-picker), built on an injected `SqlDriver` (the sqlite-wasm
// driver in the browser). Mirrors `openStore(dir)`'s contract minus live-refresh: never throws for an
// unknown schema or a lossy load — `meta` tells the truth (schemaMatched / lossy). Synchronous; the only
// async is the caller's one-time driver init (e.g. `await createSqliteWasmDriver()`).
export function openStoreFromSource(
  source: SnapshotSource,
  opts: { driver: SqlDriver; extraStopwords?: Iterable<string> },
): TeamsStore {
  const ingested = buildStore(extractFromSnapshot(loadSnapshotFrom(source)), opts.driver);
  return new StaticTeamsStore(ingested, opts.extraStopwords);
}
