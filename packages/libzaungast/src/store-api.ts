// libzaungast public high-level data facade (B2 of the api-design plan — see plan/api-design.md §8).
// This is the "90% path" for data consumers: `openStore(dir)` does the whole load+resolve+build
// spine once and returns a lifetime-owning handle whose orthogonal query namespaces
// (conversations / messages / people / events / calls / topics) each delegate to the existing
// structured query layer (query.ts) over the resident ChatStore. It is PURELY ADDITIVE — it wraps
// the query functions + Session and changes none of their behavior; the raw SQLite handle and the
// Chromium byte readers stay hidden behind it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ingest, type Ingested } from './ingest/ingest.js';
import type { ChatStore, StoreMeta } from './ingest/store.js';
import { Session, type SessionOptions } from './session.js';
import { loadSnapshot, fingerprint, selectMapping, loadMapping } from './format/index.js';
import type { Mapping } from './format/types.js';
import {
  queryConversations,
  convIdsFor,
  querySearch,
  queryConversationMessages,
  queryThread,
  queryPeople,
  queryEvents,
  queryCalls,
  loadTopicsInScope,
  computeTopicsWindow,
  computeTopicRows,
  buildPhraseExtractor,
  type SearchOptions,
  type SearchResult,
  type ConvMessagesOptions,
  type ConversationView,
  type PeopleResult,
  type EventView,
  type CallView,
  type TopicView,
  type QueryMiss,
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
}

// Message-search options mirror query.ts's SearchOptions, but the facade owns the store, so it fills
// `ftsEnabled` from it and defaults `limit` — both become optional here.
export type MessageSearchOptions = Omit<SearchOptions, 'ftsEnabled' | 'limit'> & {
  limit?: number;
  ftsEnabled?: boolean;
};
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

// On a scope miss the QueryMiss reason is surfaced verbatim (never a silent whole-DB fall-through);
// otherwise the scored topic rows + the resolved window and baseline size.
export type TopicsComputeResult =
  | { ok: false; reason: QueryMiss }
  | { rows: TopicView[]; baseTotal: number; window: { sinceTs: number; untilTs: number } };

// ---------- namespace surface ----------

export interface ConversationsApi {
  list(opts?: ConversationListOptions): ConversationView[];
  // `c:handle` or a title/participant substring → matching conversation ids (possibly several).
  resolve(sel: string): string[];
}
export interface MessagesApi {
  search(opts?: MessageSearchOptions): SearchResult;
  inConversation(
    convId: string,
    opts?: ConversationMessagesOptions,
  ): { rows: any[] } | { aroundNotFound: string };
  thread(convId: string, rootId: string): any[];
}
export interface PeopleApi {
  find(opts?: PeopleFindOptions): PeopleResult;
}
export interface EventsApi {
  list(opts?: EventsListOptions): EventView[];
}
export interface CallsApi {
  list(opts?: CallsListOptions): CallView[];
}
export interface TopicsApi {
  compute(opts?: TopicsComputeOptions): TopicsComputeResult;
}

// The lifetime-owning facade. `meta` describes the load (fingerprint/schemaMatched/lossy/counts/…);
// the six namespaces are orthogonal — call any, in any order, none depends on another.
export interface TeamsStore {
  readonly meta: StoreMeta;
  readonly conversations: ConversationsApi;
  readonly messages: MessagesApi;
  readonly people: PeopleApi;
  readonly events: EventsApi;
  readonly calls: CallsApi;
  readonly topics: TopicsApi;
  close(): void;
  [Symbol.dispose](): void;
}

// A live, auto-refreshing store (Session-backed): same namespaces, plus a forced `refresh()`; every
// query and `meta` read reflects the latest applied refresh.
export interface LiveTeamsStore extends TeamsStore {
  refresh(): void;
}

// ---------- namespace factories (shared by the static + live handles) ----------
// Each takes a `getStore` accessor: for a static store it always returns the same ChatStore; for a
// live store it returns `session.get().store` freshly each call (so queries always hit the current
// build). This is how both handles share one delegation implementation.

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
    resolve: (sel) => convIdsFor(getStore().db, sel),
  };
  const messages: MessagesApi = {
    search: (opts = {}) => {
      const store = getStore();
      return querySearch(store, {
        ...opts,
        limit: opts.limit ?? DEFAULT_SEARCH_LIMIT,
        ftsEnabled: opts.ftsEnabled ?? store.ftsEnabled,
      });
    },
    inConversation: (convId, opts = {}) =>
      queryConversationMessages(getStore(), convId, {
        ...opts,
        limit: opts.limit ?? DEFAULT_CONV_MESSAGES_LIMIT,
      }),
    thread: (convId, rootId) => queryThread(getStore().db, convId, rootId),
  };
  const people: PeopleApi = { find: (opts = {}) => queryPeople(getStore(), opts) };
  const events: EventsApi = { list: (opts = {}) => queryEvents(getStore(), opts) };
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
      const { rows, baseTotal } = computeTopicRows(
        scoped.all,
        phrases,
        sinceTs,
        untilTs,
        scoped.minSenders,
        n,
      );
      return { rows, baseTotal, window: { sinceTs, untilTs } };
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

class LiveTeamsStoreImpl implements LiveTeamsStore {
  readonly conversations: ConversationsApi;
  readonly messages: MessagesApi;
  readonly people: PeopleApi;
  readonly events: EventsApi;
  readonly calls: CallsApi;
  readonly topics: TopicsApi;
  private readonly session: Session;

  constructor(session: Session, extraStopwords?: Iterable<string>) {
    this.session = session;
    session.warmUp(); // eager first ingest; a failure surfaces on the first query, per Session
    const apis = makeApis(() => this.session.get().store, extraStopwords);
    this.conversations = apis.conversations;
    this.messages = apis.messages;
    this.people = apis.people;
    this.events = apis.events;
    this.calls = apis.calls;
    this.topics = apis.topics;
  }

  get meta(): StoreMeta {
    return this.session.get().meta;
  }
  refresh(): void {
    this.session.refreshNow();
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

// A live, auto-refreshing store over the Session machinery (the MCP server's mode). Same query
// namespaces plus `refresh()`; `meta` reads the current build each time.
export function openLiveStore(opts: LiveOptions = {}): LiveTeamsStore {
  const { extraStopwords, ...sessionOpts } = opts;
  return new LiveTeamsStoreImpl(new Session(sessionOpts), extraStopwords);
}

// Check-before-commit companion to openStore: no throw for an unknown schema — branch on `reason`
// ('unknown-schema' → the store loaded but we don't know the schema; 'unreadable' → the dir itself
// couldn't be read) and get the meta either way. The happy path returns the same handle openStore
// would.
export function tryOpen(
  dir: string,
):
  | { ok: true; store: TeamsStore }
  | { ok: false; reason: 'unknown-schema' | 'unreadable'; meta: StoreMeta } {
  let ingested: Ingested;
  try {
    ingested = ingest(dir);
  } catch {
    return { ok: false, reason: 'unreadable', meta: unreadableMeta() };
  }
  if (!ingested.meta.schemaMatched) {
    ingested.store.close(); // an empty store for an unknown schema — don't leak the handle
    return { ok: false, reason: 'unknown-schema', meta: ingested.meta };
  }
  return { ok: true, store: new StaticTeamsStore(ingested) };
}

// Cheap peek that does NOT build the SQLite store: decode+group the snapshot, hash it, and resolve
// a bundled mapping — enough to know whether we can interpret this store before committing to a
// full open. The non-committing companion to openStore/tryOpen.
export function inspect(dir: string): {
  fingerprint: string;
  schemaMatched: boolean;
  schemaVersion: string | null;
  lossy: boolean;
} {
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

// Synthetic meta for the 'unreadable' branch of tryOpen (ingest itself threw — the dir isn't a
// readable leveldb store). lossy:true flags that nothing could be read.
function unreadableMeta(): StoreMeta {
  return {
    asOf: Date.now(),
    fingerprint: '',
    schemaVersion: null,
    schemaMatched: false,
    counts: { conversations: 0, messages: 0, people: 0 },
    earliestTs: 0,
    ftsEnabled: false,
    lastFullAt: Date.now(),
    refreshMode: 'full',
    lossy: true,
    selfMri: null,
  };
}
