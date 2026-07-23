// libzaungast public high-level data facade (Node entry points). `openStore(dir)` does the whole
// load+resolve+build spine once and returns a lifetime-owning handle; `openLiveStore` adds the
// auto-refreshing Session. The browser-safe query facade (`StoreView` namespaces, `StaticTeamsStore`,
// `openStoreFromSource`) lives in store-facade.ts and is re-exported below, so this module keeps the
// fs/Session-bound half (Session, loadSnapshot(dir), createJsEngine) out of the browser graph.
//
// Error contract (stated once): a FALLIBLE facade query returns `{ ok: false, reason: QueryMiss } |
// { ok: true, … }`; an INFALLIBLE one returns its rows/value directly. Never a silent fall-through.
import type { Ingested } from './ingest/ingest.js';
import type { IngestEngine } from './ingest/engine.js';
import { createJsEngine } from './ingest/js-engine.js';
import type { StoreMeta } from './ingest/store.js';
import { Session, type SessionOptions } from './session.js';
import { loadSnapshot, fingerprint, selectMapping } from './format/index.js';
import type { Snapshot } from './format/types.js';
import { makeApis, StaticTeamsStore, type StoreView, type TeamsStore } from './store-facade.js';

// Re-export the browser-safe facade (query namespaces, StaticTeamsStore, openStoreFromSource, and all
// the StoreView/TeamsStore/*Api/option/result types) so existing importers of `./store-api.js` — and
// `src/index.ts`'s `.` surface — are unchanged.
export * from './store-facade.js';

// ---------- Node-only options ----------

export interface OpenStoreOptions {
  // Extra phrase-extractor stopwords merged into the language defaults for `topics.compute`
  // (union'd with any per-call `extraStopwords`). Omit for the default en+de behavior.
  extraStopwords?: Iterable<string>;
  // Ingest engine (advanced): inject a custom IngestEngine — e.g. the native accelerator from
  // libzaungast-native, constructed via its createNativeEngine(). Omit for the built-in JS engine
  // (the zero-dep TS reference). The engine-author contract lives at the 'libzaungast/engine-spi'
  // subpath; libzaungast never depends on any engine — the consumer chooses and injects one.
  engine?: IngestEngine;
}

// openLiveStore layers the auto-refreshing Session's options on top of the facade options.
export interface LiveOptions extends SessionOptions {
  extraStopwords?: Iterable<string>;
  // Eager first ingest at open time (default true — script consumers get a ready store). Pass
  // `false` for a lazy cold start (e.g. an MCP server that must return its handshake instantly and
  // warms afterward via `refresh()`); the first `current()`/`refresh()` then builds the store.
  warm?: boolean;
}

// What `inspect` reports about a store without building it.
export interface StoreInspection {
  fingerprint: string;
  schemaMatched: boolean;
  mappingVersion: string | null;
  lossy: boolean;
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
  const engine = opts.engine ?? createJsEngine();
  return new StaticTeamsStore(engine.full(dir), opts.extraStopwords);
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
    const engine = opts.engine ?? createJsEngine();
    ingested = engine.full(dir);
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
  const { mapping } = selectMapping(fp);
  return {
    fingerprint: fp.hash,
    schemaMatched: !!mapping,
    mappingVersion: mapping?.mappingVersion ?? null,
    lossy: snap.lossy,
  };
}
