// libzaungast public high-level data facade (B2 of the api-design plan — see plan/api-design.md §8;
// grown in B3a per plan/b3-facade-review.md). This is the "90% path" for data consumers:
// `openStore(dir)` does the whole load+resolve+build spine once and returns a lifetime-owning handle
// whose orthogonal query namespaces (conversations / messages / people / events / calls / topics)
// each delegate to the structured query layer (query.ts) over the resident ChatStore. It is PURELY
// ADDITIVE — it wraps the query functions + Session and changes none of their behavior; the raw
// SQLite handle and the Chromium byte readers stay hidden behind it.
//
// Error contract (stated once): a FALLIBLE facade query returns `{ ok: false, reason: QueryMiss } |
// { ok: true, … }`; an INFALLIBLE one returns its rows/value directly. Never a silent fall-through.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ingest, type Ingested } from './ingest/ingest.js';
import type { ChatStore, StoreMeta } from './ingest/store.js';
import { Session, type SessionOptions } from './session.js';
import { loadSnapshot, fingerprint, selectMapping, loadMapping } from './format/index.js';
import type { Mapping, Snapshot } from './format/types.js';
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
  toMessageView,
  toSearchHit,
  toThreadSummary,
  type SearchOptions,
  type ConvMessagesOptions,
  type ConversationView,
  type MessageView,
  type SearchHit,
  type ThreadSummary,
  type PeopleResult,
  type EventView,
  type CallView,
  type TopicView,
  type QueryMiss,
  type ConvMessagesMiss,
} from './query.js';

// Bundled mapping files (src/schema/versions/*.json) — reached exactly as ingest.ts's VERSIONS_DIR,
// but relative to this module (one level up from src/ingest/). `inspect`/`tryOpen` reuse this so a
// consumer never has to load mapping JSON themselves.
const VERSIONS_DIR = fileURLToPath(new URL('./schema/versions/', import.meta.url));
function loadMappings(): Mapping[] {
  return fs
    .readdirSync(VERSIONS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => loadMapping(path.join(VERSIONS_DIR, f)));
}

// Default row caps for the message reads (the query layer requires an explicit limit; the facade
// supplies a sensible default so a consumer need not think about it).
const DEFAULT_SEARCH_LIMIT = 30;
const DEFAULT_CONV_MESSAGES_LIMIT = 40;

// ---------- options ----------

export interface OpenStoreOptions {
  // Extra phrase-extractor stopwords merged into the language defaults for `topics.compute`
  // (union'd with any per-call `extraStopwords`). Omit for the default en+de behavior.
  extraStopwords?: Iterable<string>;
}

// openLiveStore layers the auto-refreshing Session's options on top of the facade options.
export interface LiveOptions extends SessionOptions {
  extraStopwords?: Iterable<string>;
  // Eager first ingest at open time (default true — script consumers get a ready store). Pass
  // `false` for a lazy cold start (e.g. an MCP server that must return its handshake instantly and
  // warms afterward via `refresh()`); the first `current()`/`refresh()` then builds the store.
  warm?: boolean;
}

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
  | { ok: false; reason: ConvMessagesMiss }
  | { ok: true; rows: MessageView[]; nextOlder?: string };

// On a scope miss the QueryMiss reason is surfaced verbatim (never a silent whole-DB fall-through);
// otherwise the scored topic rows PLUS every fact a renderer states about the run — the window and
// its message count, the scope's all-time size (0 ⇒ "no messages in scope"), the baseline size, the
// count of bot/app messages dropped, and the resolved conversation ids (scope=conversation:).
export type TopicsComputeResult =
  | { ok: false; reason: QueryMiss }
  | {
      ok: true;
      rows: TopicView[];
      window: { sinceTs: number; untilTs: number };
      windowCount: number; // messages inside the window
      scopeTotal: number; // messages in scope across all time (0 → "no messages in scope")
      baseTotal: number; // baseline size (messages before the window)
      botExcluded: number; // bot/app messages dropped (disclosure note)
      scopeConvIds?: string[]; // resolved ids when scope=conversation: (ambiguity note)
    };

// What `inspect` reports about a store without building it.
export interface StoreInspection {
  fingerprint: string;
  schemaMatched: boolean;
  schemaVersion: string | null;
  lossy: boolean;
}

// ---------- namespace surface ----------

export interface ConversationsApi {
  list(opts?: ConversationListOptions): ConversationView[];
  // Point lookup by leveldb id OR `c:` handle → the conversation (or null).
  get(id: string): ConversationView | null;
  // `c:handle` or a title/participant substring → candidate conversations WITH display fields,
  // newest-first (last_ts desc). The MCP owns the thresholds/prose around ambiguity.
  resolve(sel: string): ConversationView[];
}
export interface MessagesApi {
  search(opts?: MessageSearchOptions): MessageSearchResult;
  inConversation(convId: string, opts?: ConversationMessagesOptions): ConvMessagesResult;
  // Point lookup by (convId, id) — the around→root_id pivot; null when absent.
  get(convId: string, id: string): MessageView | null;
  thread(convId: string, rootId: string): MessageView[];
  threadSummaries(
    convId: string,
    opts?: { sinceTs?: number; untilTs?: number },
  ): ThreadSummary[];
  stats(convId: string): { total: number; earliestTs: number; newestTs: number };
}
export interface PeopleApi {
  find(opts?: PeopleFindOptions): PeopleResult;
  // Best display name for an MRI (people → profiles fallback), or null.
  nameFor(mri: string): string | null;
}
export interface EventsApi {
  list(opts?: EventsListOptions): EventView[];
  // Newest materialized occurrence start across ALL events (the honest recurring-events bound).
  maxStart(): number;
}
export interface CallsApi {
  list(opts?: CallsListOptions): CallView[];
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
// meaningless for a one-shot `openStore`.
export interface TeamsStore extends StoreView {
  close(): void;
  [Symbol.dispose](): void;
}

// A pinned, read-consistent view of ONE Session build: the query surface + the build's `meta`, plus
// `mayBeStale` (a fresher build may exist but wasn't applied — drives the may-be-stale flag).
export interface StoreReading extends StoreView {
  readonly mayBeStale: boolean;
}

// A live, auto-refreshing store (Session-backed). It exposes NO direct query namespaces — reads go
// through `current()`, which pins a single build so one logical operation (several facade calls)
// can't straddle a refresh. `refresh` forces a rebuild and returns the applied meta; `reloadSnapshot`
// re-loads the (consistent tmp) snapshot backing the current build for cold-path schema recovery.
export interface LiveTeamsStore {
  current(): StoreReading;
  refresh(opts?: { full?: boolean }): StoreMeta;
  reloadSnapshot(): Snapshot;
  close(): void;
  [Symbol.dispose](): void;
}

// ---------- namespace factory (shared by the static handle + a live reading) ----------
// `getStore` is a constant accessor bound to ONE ChatStore build, so every namespace call on the
// resulting view hits the same build (this is how read-consistency is delivered — the static handle
// owns one store for its lifetime; a live reading pins the build `current()` observed).

function mergeStopwords(
  ...sets: (Iterable<string> | undefined)[]
): Iterable<string> | undefined {
  const out = new Set<string>();
  for (const s of sets) if (s) for (const w of s) out.add(w);
  return out.size ? out : undefined; // undefined keeps buildPhraseExtractor byte-identical
}

function makeApis(
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
      return { ok: true, rows: res.rows.map(toMessageView), nextOlder };
    },
    get: (convId, id) => {
      const r = messageById(getStore(), convId, id);
      return r ? toMessageView(r) : null;
    },
    thread: (convId, rootId) => queryThread(getStore().db, convId, rootId).map(toMessageView),
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
      if (!scoped.ok) return scoped; // { ok: false, reason } — surfaced verbatim (P4)
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

class StaticTeamsStore implements TeamsStore {
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

// ---------- live handle ----------
// No direct namespaces: reads go through `current()`, which calls `Session.get()` ONCE and binds a
// StoreReading to that single build (the read-consistency pin that fixes the torn read — one logical
// operation making several facade calls can no longer straddle a refresh).

class LiveTeamsStoreImpl implements LiveTeamsStore {
  private readonly session: Session;
  private readonly extraStopwords?: Iterable<string>;

  constructor(session: Session, extraStopwords?: Iterable<string>) {
    this.session = session;
    this.extraStopwords = extraStopwords;
  }

  current(): StoreReading {
    const got = this.session.get(); // one probe/refresh decision for this whole reading
    const apis = makeApis(() => got.store, this.extraStopwords); // pinned to THIS build
    return {
      meta: got.meta,
      mayBeStale: got.staleProbeDeferred,
      conversations: apis.conversations,
      messages: apis.messages,
      people: apis.people,
      events: apis.events,
      calls: apis.calls,
      topics: apis.topics,
    };
  }
  refresh(opts: { full?: boolean } = {}): StoreMeta {
    return this.session.refreshNow(opts.full ?? false);
  }
  reloadSnapshot(): Snapshot {
    return loadSnapshot(this.session.currentDir());
  }
  close(): void {
    this.session.dispose();
  }
  [Symbol.dispose](): void {
    this.close();
  }
}

// ---------- entry points ----------

// One-shot static read of a leveldb dir (a copied snapshot / a test fixture). Runs the whole
// ingest spine once and returns a lifetime-owning handle. Never throws for "unknown schema" or a
// "lossy" load — `store.meta` tells the truth (schemaMatched / lossy); it throws only if `dir`
// cannot be read at all. Use `using store = openStore(dir)` for automatic disposal.
export function openStore(dir: string, opts: OpenStoreOptions = {}): TeamsStore {
  return new StaticTeamsStore(ingest(dir), opts.extraStopwords);
}

// A live, auto-refreshing store over the Session machinery (the MCP server's mode). Reads go through
// `current()`. `warm` (default true) runs the first full ingest eagerly; pass `false` for a lazy
// cold start.
export function openLiveStore(opts: LiveOptions = {}): LiveTeamsStore {
  const { extraStopwords, warm, ...sessionOpts } = opts;
  const session = new Session(sessionOpts);
  if (warm !== false) session.warmUp(); // eager first ingest; a failure surfaces on first current()
  return new LiveTeamsStoreImpl(session, extraStopwords);
}

// Check-before-commit companion to openStore: no throw for an unknown schema — branch on `reason`
// ('unknown-schema' → the store loaded but we don't know the schema, with its real meta;
// 'unreadable' → the dir itself couldn't be read, with the error string). The happy path returns the
// same handle openStore would.
export function tryOpen(
  dir: string,
  opts: OpenStoreOptions = {},
):
  | { ok: true; store: TeamsStore }
  | { ok: false; reason: 'unknown-schema'; meta: StoreMeta }
  | { ok: false; reason: 'unreadable'; error: string } {
  let ingested: Ingested;
  try {
    ingested = ingest(dir);
  } catch (e) {
    return { ok: false, reason: 'unreadable', error: (e as Error).message };
  }
  if (!ingested.meta.schemaMatched) {
    ingested.store.close(); // an empty store for an unknown schema — don't leak the handle
    return { ok: false, reason: 'unknown-schema', meta: ingested.meta };
  }
  return { ok: true, store: new StaticTeamsStore(ingested, opts.extraStopwords) };
}

// Cheap peek that does NOT build the SQLite store: decode+group the snapshot, hash it, and resolve
// a bundled mapping — enough to know whether we can interpret this store before committing to a
// full open. The non-committing companion to openStore/tryOpen.
export function inspect(dir: string): StoreInspection {
  const snap = loadSnapshot(dir);
  const fp = fingerprint(snap);
  const { mapping } = selectMapping(loadMappings(), fp);
  return {
    fingerprint: fp.hash,
    schemaMatched: !!mapping,
    schemaVersion: mapping?.schemaVersion ?? null,
    lossy: snap.lossy,
  };
}
