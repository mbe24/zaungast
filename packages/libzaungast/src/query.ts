// Library-side structured query layer (the future libzaungast public data API — B1 of the
// format-api-reshape / library-extraction plan). These functions return typed, engine-agnostic
// rows over the in-memory ChatStore; the MCP layer (tools.ts) renders them into token-economical
// text. The split is being done incrementally, one tool at a time, each proven byte-identical by
// the G2 MCP-output golden. Nothing here knows about MCP, agents, or token budgets.
import { isBotMri, type ChatStore } from './ingest/store.js';
import { makeExtractor } from './util/topics.js';
import { byCodeUnit } from './util/sort.js';

type DB = ChatStore['db'];

// escape LIKE wildcards in user input (used with `escape '\'`). Query-side helper.
export function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (m) => '\\' + m);
}

// ---------- resolvers (name/handle → ids) ----------
// Shared by the message-oriented tools (read_messages/search/top_topics). Pure resolution over the
// store; the MCP layer wraps these with agent-facing disambiguation/coverage text.

// A conversation selector (c:handle or title/participant substring) → matching conversation ids.
export function convIdsFor(db: DB, arg: string): string[] {
  if (arg.startsWith('c:')) {
    const r = db.prepare('select id from conversations where handle=?').get(arg) as any;
    return r ? [r.id] : [];
  }
  const like = `%${likeEscape(arg)}%`;
  return (
    db
      .prepare(
        String.raw`select id from conversations where topic like ? escape '\' or participant_names like ? escape '\'`,
      )
      .all(like, like) as any[]
  ).map((r) => r.id);
}

// A sender selector (p:handle or display-name substring) → a message-table WHERE fragment (aliased
// `m.`) + params, or a `.miss` when a p:handle doesn't resolve.
export function senderFilter(
  db: DB,
  arg: string,
): { sql: string; params: any[]; miss?: string } {
  if (arg.startsWith('p:')) {
    const r = db.prepare('select mri from people where handle=?').get(arg) as any;
    if (!r) return { sql: '1=0', params: [], miss: `no person matches ${arg}` };
    return { sql: 'm.sender_mri=?', params: [r.mri] };
  }
  return { sql: String.raw`m.sender_name like ? escape '\'`, params: [`%${likeEscape(arg)}%`] };
}

// Why a resolution couldn't be satisfied. A structured reason (Category-2 "outcome-with-reason" of
// the uniform error semantics) — the library never emits agent-facing prose; the MCP layer maps
// each reason to its user-facing message. `value` carries the offending selector.
export type QueryMiss =
  | { reason: 'no-such-sender'; value: string }
  | { reason: 'no-such-conversation'; value: string }
  | { reason: 'no-such-excluded-conversation'; value: string }
  | { reason: 'no-such-excluded-person'; value: string };

// The flat-read miss reason: QueryMiss plus the `around:` pivot case ('no-such-message', an id
// absent from the conversation). Kept as a SUPERSET of QueryMiss — not folded into it — so the MCP's
// exhaustive describeMiss() switch over QueryMiss stays valid until stage 2 handles the new case.
export type ConvMessagesMiss = QueryMiss | { reason: 'no-such-message'; value: string };

// Resolve an `exclude` list — `c:` conversation handles, `p:` person handles, and plain words — to
// ids/mris/words, or a `QueryMiss` when a handle doesn't resolve. Shared by the search + topics
// scopes.
export function resolveExcludes(
  db: DB,
  list: string[] | undefined,
): { convIds: string[]; mris: string[]; words: string[]; miss?: QueryMiss } {
  const convIds: string[] = [],
    mris: string[] = [],
    words: string[] = [];
  for (const raw of list ?? []) {
    const e = String(raw).trim();
    if (!e) continue;
    if (e.startsWith('c:')) {
      const r = db.prepare('select id from conversations where handle=?').get(e) as any;
      if (!r) return { convIds, mris, words, miss: { reason: 'no-such-excluded-conversation', value: e } };
      convIds.push(r.id);
    } else if (e.startsWith('p:')) {
      const r = db.prepare('select mri from people where handle=?').get(e) as any;
      if (!r) return { convIds, mris, words, miss: { reason: 'no-such-excluded-person', value: e } };
      mris.push(r.mri);
    } else words.push(e.toLowerCase());
  }
  return { convIds, mris, words };
}

// Build a safe FTS5 MATCH string: quote each term so user punctuation/operators can't throw a
// syntax error. Returns null if there's nothing to match.
export function ftsMatch(raw: string): string | null {
  const toks = raw.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  return toks.length ? toks.map((t) => `"${t}"`).join(' ') : null;
}

// ---------- message views ----------
// The engine-agnostic, camelCase shape of one message row as the facade hands it to consumers.
// The 0/1 SQLite flags are booleanized at this boundary; `reactionsJson` is the raw compact JSON
// string ([{k,u:[[mri,ts]]}]) left typed-but-unparsed (parsing is a deliberate #6-polish deferral).
// `rootId === id` ⇒ this message is a thread root (joins ThreadSummary.rootId).
export interface MessageView {
  id: string;
  convId: string;
  rootId: string;
  ts: number;
  kind: string;
  senderMri: string | null;
  senderName: string | null;
  isMine: boolean;
  hasAttachment: boolean;
  mentionsMe: boolean;
  content: string;
  reactionsJson: string | null;
}
// A search result row: a MessageView plus the highlighted `snippet` (the old raw-row `snip`).
export interface SearchHit extends MessageView {
  snippet: string;
}

// Map a raw `messages` row (snake_case, 0/1 flags) to a MessageView. The mappers live here (not in
// the facade) so any consumer of the raw query fns can reuse them; the facade calls them at its
// boundary while the query fns keep returning raw rows (the MCP still reads those directly).
export function toMessageView(r: any): MessageView {
  return {
    id: r.id,
    convId: r.conv_id,
    rootId: r.root_id,
    ts: r.ts,
    kind: r.kind,
    senderMri: r.sender_mri ?? null,
    senderName: r.sender_name ?? null,
    isMine: !!r.is_mine,
    hasAttachment: !!r.has_attach,
    mentionsMe: !!r.mentions_me,
    content: r.content,
    reactionsJson: r.reactions ?? null,
  };
}
// Map a raw search row (a `messages` row + a `snip` column) to a SearchHit.
export function toSearchHit(r: any): SearchHit {
  return { ...toMessageView(r), snippet: r.snip };
}

// ---------- search ----------
// Options for querySearch. All selectors are optional; time bounds are pre-parsed epoch ms (arg
// parsing / now-relative defaults stay MCP-side). `ftsEnabled` reflects whether the FTS5 index is
// available.
export interface SearchOptions {
  query?: string;
  from?: string;
  in?: string;
  kind?: string;
  mentionsMe?: boolean;
  hasAttachment?: boolean;
  exclude?: string[];
  sinceTs?: number;
  untilTs?: number;
  limit: number;
  ftsEnabled: boolean;
}
// On success: the hit rows + their order, plus DATA the MCP layer needs for its non-blocking notes
// — `inIds` (resolved conversation ids when `in` was given, for the ambiguity note) and `coverage`
// (scope min/max ts, present only when the cache-horizon note should show). On failure: a QueryMiss.
export type SearchResult =
  | { ok: false; reason: QueryMiss }
  | {
      ok: true;
      rows: any[];
      order: 'relevance' | 'time';
      inIds?: string[];
      coverage?: { hi: number; lo: number };
    };

// Run a search: resolve the scope (who/where/kind + excludes), apply the time window, execute the
// query, and compute the coverage-note trigger. Owns everything that was the MCP's buildSearchScope
// + time + runSearchQuery + computeSearchCoverage — no SQL fragments cross the boundary.
export function querySearch(store: ChatStore, opts: SearchOptions): SearchResult {
  const db = store.db;
  const conds: string[] = ['m.is_system=0'];
  const params: any[] = [];
  let inIds: string[] | undefined;
  if (opts.from) {
    const f = senderFilter(db, String(opts.from));
    if (f.miss) return { ok: false, reason: { reason: 'no-such-sender', value: String(opts.from) } };
    conds.push(f.sql);
    params.push(...f.params);
  }
  if (opts.in) {
    const ids = convIdsFor(db, String(opts.in));
    if (!ids.length) return { ok: false, reason: { reason: 'no-such-conversation', value: String(opts.in) } };
    inIds = ids;
    conds.push(`m.conv_id in (${ids.map(() => '?').join(',')})`);
    params.push(...ids);
  }
  if (opts.kind) {
    conds.push('m.kind=?');
    params.push(opts.kind);
  }
  if (opts.mentionsMe) conds.push('m.mentions_me=1');
  if (opts.hasAttachment) conds.push('m.has_attach=1');
  if (opts.exclude?.length) {
    const ex = resolveExcludes(db, opts.exclude);
    if (ex.miss) return { ok: false, reason: ex.miss };
    if (ex.convIds.length) {
      conds.push(`m.conv_id not in (${ex.convIds.map(() => '?').join(',')})`);
      params.push(...ex.convIds);
    }
    if (ex.mris.length) {
      conds.push(`m.sender_mri not in (${ex.mris.map(() => '?').join(',')})`);
      params.push(...ex.mris);
    }
  }
  // scope-only arrays (who/where/kind + excludes, NOT time, NOT the query term) — the coverage note
  // means "newest cached in this scope", not "newest matching the query".
  const scopeConds = [...conds];
  const scopeParams = [...params];
  if (opts.sinceTs) {
    conds.push('m.ts>=?');
    params.push(opts.sinceTs);
  }
  if (opts.untilTs) {
    conds.push('m.ts<?');
    params.push(opts.untilTs);
  }
  const { rows, order } = runSearchQuery(db, opts.ftsEnabled, conds, params, opts.limit, opts.query);
  const coverage = computeCoverage(db, scopeConds, scopeParams, rows.length, opts.sinceTs);
  return { ok: true, rows, order, inIds, coverage };
}

// Cache-horizon trigger: return the scope's {hi,lo} message-ts span (system msgs + ts=0 excluded)
// when the reader should see the coverage note — on empty results, or when a `since` filter starts
// after the newest cached message in scope (window entirely uncovered). Otherwise undefined. `hi===0`
// means the scope holds no cached messages at all (the MCP renders that as its own phrasing).
function computeCoverage(
  db: DB,
  scopeConds: string[],
  scopeParams: any[],
  rowCount: number,
  sinceTs: number | undefined,
): { hi: number; lo: number } | undefined {
  const scopeSql = scopeConds.join(' and ');
  const stats = () => {
    const r = db
      .prepare(`select min(m.ts) lo, max(m.ts) hi from messages m where ${scopeSql} and m.ts>0`)
      .get(...scopeParams) as any;
    return { hi: r?.hi ?? 0, lo: r?.lo ?? 0 };
  };
  if (rowCount === 0) return stats();
  if (sinceTs) {
    const hi =
      (db.prepare(`select max(m.ts) hi from messages m where ${scopeSql}`).get(...scopeParams) as any)
        ?.hi ?? 0;
    if (sinceTs > hi) return stats();
  }
  return undefined;
}

// Execute the search query itself: FTS5 MATCH+bm25 ranking when available and a query is given, else
// a plain content LIKE scan ordered by recency. `conds`/`params` are extended in place (the LIKE
// path appends the query term). Internal to querySearch.
function runSearchQuery(
  db: DB,
  ftsEnabled: boolean,
  conds: string[],
  params: any[],
  limit: number,
  query: string | undefined,
): { rows: any[]; order: 'relevance' | 'time' } {
  const match = query && String(query).trim() ? ftsMatch(String(query)) : null;
  if (match && ftsEnabled) {
    const rows = db
      .prepare(
        `select m.*, snippet(messages_fts,0,'[',']','…',10) snip
      from messages_fts f join messages m on m.conv_id=f.conv_id and m.id=f.id
      where messages_fts match ? and ${conds.join(' and ')}
      order by bm25(messages_fts) limit ?`,
      )
      .all(match, ...params, limit) as any[];
    return { rows, order: 'relevance' };
  }
  if (query && String(query).trim()) {
    conds.push(String.raw`m.content like ? escape '\'`);
    params.push(`%${likeEscape(String(query))}%`);
  }
  const rows = db
    .prepare(
      `select m.*, substr(m.content,1,120) snip from messages m
      where ${conds.join(' and ')} order by m.ts desc, m.id desc limit ?`,
    )
    .all(...params, limit) as any[];
  return { rows, order: 'time' };
}

// ---------- messages (flat window) ----------
// Options for a flat (1:1/group/meeting) conversation read. Time bounds are pre-parsed epoch ms;
// `cursor` is the library's own `older:<ts>:<id>` keyset token; `around` is an `m:<id>` pivot.
export interface ConvMessagesOptions {
  sinceTs?: number;
  untilTs?: number;
  cursor?: string;
  around?: string;
  limit: number;
}
// Fetch the rows to render for a flat conversation: either a window CENTERED on `around` (half
// before/half after, oldest→newest, ignoring time/cursor), or the last `limit` rows in the time +
// cursor window (also oldest→newest). Returns `{ aroundNotFound: <id> }` when the pivot id isn't in
// the conversation; the MCP layer turns that into its user-facing message.
export function queryConversationMessages(
  store: ChatStore,
  convId: string,
  opts: ConvMessagesOptions,
): { rows: any[] } | { aroundNotFound: string } {
  const db = store.db;
  if (opts.around) {
    const aroundId = opts.around.replace(/^m:/, '');
    const a = db
      .prepare('select ts from messages where conv_id=? and id=?')
      .get(convId, aroundId) as any;
    if (!a) return { aroundNotFound: opts.around };
    const half = Math.floor(opts.limit / 2);
    const before = db
      .prepare(
        `select * from messages where conv_id=? and is_system=0 and ts<=? order by ts desc, id desc limit ?`,
      )
      .all(convId, a.ts, half) as any[];
    const after = db
      .prepare(
        `select * from messages where conv_id=? and is_system=0 and ts>? order by ts asc, id asc limit ?`,
      )
      .all(convId, a.ts, half) as any[];
    return { rows: [...before.toReversed(), ...after] };
  }
  const conds = ['conv_id=?', 'is_system=0'];
  const params: any[] = [convId];
  if (opts.sinceTs) {
    conds.push('ts>=?');
    params.push(opts.sinceTs);
  }
  if (opts.untilTs) {
    conds.push('ts<?');
    params.push(opts.untilTs);
  }
  // cursor `older:<ts>:<id>` — (ts,id) tuple so equal-timestamp neighbours aren't skipped
  const older = opts.cursor && /^older:(\d+):(.+)$/.exec(String(opts.cursor));
  if (older) {
    conds.push('(ts<? or (ts=? and id<?))');
    params.push(Number(older[1]), Number(older[1]), older[2]);
  }
  // last `limit` in the window, rendered oldest→newest (story order)
  const rows = (
    db
      .prepare(
        `select * from messages where ${conds.join(' and ')} order by ts desc, id desc limit ?`,
      )
      .all(...params, opts.limit) as any[]
  ).reverse();
  return { rows };
}

// All non-system messages of one channel reply-chain (root + replies), chronological. Shared by the
// channel digest and single-thread renderers.
export function queryThread(db: DB, convId: string, rootId: string): any[] {
  return db
    .prepare(
      `select * from messages where conv_id=? and root_id=? and is_system=0 order by ts asc, id asc`,
    )
    .all(convId, rootId) as any[];
}

// A single message by (conv_id, id) — the raw row (or null). The facade's `messages.get` maps it
// to a MessageView; it also backs the around→root_id pivot (root_id is on the raw row).
export function messageById(store: ChatStore, convId: string, id: string): any | null {
  return (
    (store.db
      .prepare('select * from messages where conv_id=? and id=?')
      .get(convId, id) as any) ?? null
  );
}

// The camelCase facade shape of one reply-chain summary (queryThreadSummaries returns raw
// {root_id,n,last}; this is what the facade hands out). rootId joins MessageView.rootId.
export interface ThreadSummary {
  rootId: string;
  count: number;
  lastTs: number;
}
// Map a raw thread-summary row to a ThreadSummary.
export function toThreadSummary(r: { root_id: any; n: number; last: number }): ThreadSummary {
  return { rootId: String(r.root_id), count: r.n, lastTs: r.last };
}

// Per-reply-chain activity summaries (message count + last-activity ts per root) for a channel's
// time window — drives which threads a channel digest surfaces. Cursor paging is applied by the MCP
// layer over the returned summaries (it's a presentation/budget concern), not here.
export function queryThreadSummaries(
  store: ChatStore,
  convId: string,
  opts: { sinceTs?: number; untilTs?: number },
): { root_id: any; n: number; last: number }[] {
  const db = store.db;
  const conds = ['conv_id=?', 'is_system=0'];
  const params: any[] = [convId];
  if (opts.sinceTs) {
    conds.push('ts>=?');
    params.push(opts.sinceTs);
  }
  if (opts.untilTs) {
    conds.push('ts<?');
    params.push(opts.untilTs);
  }
  return db
    .prepare(
      `select root_id, count(*) n, max(ts) last from messages where ${conds.join(' and ')} group by root_id`,
    )
    .all(...params) as any[];
}

// A conversation's non-system message count + oldest/newest cached ts — the "showing X/total,
// local cache lo–hi" header stats, shared by the flat and channel-digest read paths.
export function convMessageStats(
  db: DB,
  convId: string,
): { total: number; earliest: number; newest: number } {
  const total = (
    db.prepare('select count(*) n from messages where conv_id=? and is_system=0').get(convId) as any
  ).n;
  const span = db
    .prepare('select min(ts) lo, max(ts) hi from messages where conv_id=? and is_system=0 and ts>0')
    .get(convId) as any;
  return { total, earliest: span?.lo ?? 0, newest: span?.hi ?? 0 };
}

// ---------- people ----------
export interface PersonView {
  handle: string;
  mri: string;
  name: string;
  msgCount: number;
  lastTs: number;
  isBot: boolean; // sender MRI is in the Bot Framework namespace (28:) — absorbs the MCP's isBotMri use
}
export interface PeopleResult {
  mode: 'handle' | 'search' | 'roster'; // how the query resolved (drives the renderer's header)
  query: string; // the trimmed query, '' for roster
  total: number; // ALL matches for this mode (not just the returned/limited rows)
  rows: PersonView[];
}

const toPersonRow = (r: any): PersonView => ({
  handle: r.handle,
  mri: r.mri,
  name: r.name,
  msgCount: r.msg_count,
  lastTs: r.last_ts,
  isBot: isBotMri(r.mri),
});

// find_person's data: a p:handle lookup, a name substring search, or the volume-ranked roster.
// `total` counts every match for the mode (the search/roster rows are limited to `n`); the handle
// mode's rows are already exhaustive so `total` equals the row count.
export function queryPeople(
  store: ChatStore,
  opts: { query?: string; n?: number } = {},
): PeopleResult {
  const db = store.db;
  const n = Math.min(Number(opts.n) || 8, 25);
  const q = opts.query ? String(opts.query).trim() : '';
  const cols = 'handle,mri,name,msg_count,last_ts';
  if (q.startsWith('p:')) {
    const rows = (db.prepare(`select ${cols} from people where handle=?`).all(q) as any[]).map(
      toPersonRow,
    );
    return { mode: 'handle', query: q, total: rows.length, rows };
  }
  if (q) {
    const total = (
      db
        .prepare(String.raw`select count(*) c from people where name like ? escape '\'`)
        .get(`%${likeEscape(q)}%`) as any
    ).c;
    const rows = (
      db
        .prepare(
          String.raw`select ${cols} from people where name like ? escape '\' order by msg_count desc limit ?`,
        )
        .all(`%${likeEscape(q)}%`, n) as any[]
    ).map(toPersonRow);
    return { mode: 'search', query: q, total, rows };
  }
  const total = (db.prepare('select count(*) c from people').get() as any).c;
  const rows = (
    db.prepare(`select ${cols} from people order by msg_count desc limit ?`).all(n) as any[]
  ).map(toPersonRow);
  return { mode: 'roster', query: '', total, rows };
}

// ---------- conversations ----------
export interface ConversationView {
  id: string; // the conversation's leveldb id (joins MessageView.convId; the c: handle is `handle`)
  handle: string;
  kind: string;
  topic: string | null;
  participantNames: string | null;
  lastTs: number;
  msgCount: number;
}

const toConversationView = (r: any): ConversationView => ({
  id: r.id,
  handle: r.handle,
  kind: r.kind,
  topic: r.topic,
  participantNames: r.participant_names,
  lastTs: r.last_ts,
  msgCount: r.msg_count,
});

// column list for the conversation views (shared by list/get/resolve).
const CONV_COLS = 'id,handle,kind,topic,participant_names,last_ts,msg_count';

// A single conversation by leveldb id OR by `c:` handle → its ConversationView (or null). Backs
// the facade's `conversations.get`.
export function conversationById(store: ChatStore, idOrHandle: string): ConversationView | null {
  const col = idOrHandle.startsWith('c:') ? 'handle' : 'id';
  const r = store.db
    .prepare(`select ${CONV_COLS} from conversations where ${col}=?`)
    .get(idOrHandle) as any;
  return r ? toConversationView(r) : null;
}

// Resolve a conversation selector (`c:handle` or a topic/participant substring) to candidate
// ConversationViews, newest-first (last_ts desc). Unlike convIdsFor (ids only), this carries the
// display fields so the MCP's ambiguity note can render candidates without a second lookup.
export function resolveConversations(store: ChatStore, sel: string): ConversationView[] {
  const db = store.db;
  if (sel.startsWith('c:')) {
    const rows = db.prepare(`select ${CONV_COLS} from conversations where handle=?`).all(sel) as any[];
    return rows.map(toConversationView);
  }
  const like = `%${likeEscape(sel)}%`;
  const rows = db
    .prepare(
      String.raw`select ${CONV_COLS} from conversations
      where topic like ? escape '\' or participant_names like ? escape '\'
      order by last_ts desc`,
    )
    .all(like, like) as any[];
  return rows.map(toConversationView);
}

// list_conversations' data: activity-ranked conversations, filtered by kind/query/participant/since.
// sinceTs arrives already parsed. query/participant are matched RAW (unescaped), as the tool did.
export function queryConversations(
  store: ChatStore,
  opts: {
    n?: number;
    kind?: string;
    query?: string;
    participant?: string;
    sinceTs?: number;
    includeEmpty?: boolean;
  } = {},
): ConversationView[] {
  const db = store.db;
  const n = Math.min(Number(opts.n) || 12, 30);
  const where: string[] = [];
  const params: any[] = [];
  if (!opts.includeEmpty) where.push('msg_count>0'); // hide 0-message team roots by default
  if (opts.kind) {
    where.push('kind=?');
    params.push(opts.kind);
  }
  if (opts.query) {
    where.push('(topic like ? or participant_names like ?)');
    params.push(`%${opts.query}%`, `%${opts.query}%`);
  }
  if (opts.participant) {
    where.push('participant_names like ?');
    params.push(`%${opts.participant}%`);
  }
  if (opts.sinceTs) {
    where.push('last_ts>=?');
    params.push(opts.sinceTs);
  }
  const w = where.length ? 'where ' + where.join(' and ') : '';
  const rows = db
    .prepare(
      `select ${CONV_COLS}
     from conversations ${w} order by last_ts desc limit ?`,
    )
    .all(...params, n) as any[];
  return rows.map(toConversationView);
}

// ---------- calls ----------
export interface CallView {
  startTs: number;
  direction: string | null;
  isMissed: number;
  durationMs: number;
  state: string | null;
  hasRecording: number;
  hasVoicemail: number;
  spamLevel: string | null;
  isCurrentUserPart: number;
  recordingLink: string | null;
  label: string; // resolved counterpart name / group topic+handle
}

// list_calls' data: filtered, resolved, limited call rows (newest first). Time bounds arrive
// already parsed (sinceTs/untilTs epoch ms); arg validation/parsing stays in the MCP layer.
export function queryCalls(
  store: ChatStore,
  opts: {
    direction?: string;
    missed?: boolean;
    sinceTs?: number;
    untilTs?: number;
    participant?: string;
    limit?: number;
  } = {},
): CallView[] {
  const db = store.db;
  const limit = Math.min(Number(opts.limit) || 30, 100);
  const where: string[] = ['is_deleted=0']; // filtered out by default
  const params: any[] = [];
  if (opts.direction) {
    where.push('direction=?');
    params.push(opts.direction);
  }
  if (opts.missed) where.push('is_missed=1');
  if (opts.sinceTs != null) {
    where.push('start_ts>=?');
    params.push(opts.sinceTs);
  }
  if (opts.untilTs != null) {
    where.push('start_ts<?');
    params.push(opts.untilTs);
  }
  const rowsAll = db
    .prepare(`select * from calls where ${where.join(' and ')} order by start_ts desc`)
    .all(...params) as any[];

  // Resolve each call's display label in JS (the table is tiny; this is what lets `participant`
  // filter on the RESOLVED name — TwoParty target.displayName is often null in the raw data).
  const resolved = rowsAll.map((r) => {
    let label: string;
    if (r.call_type === 'MultiParty') {
      const conv = r.group_thread_id
        ? (db
            .prepare('select handle,topic,participant_names from conversations where id=?')
            .get(r.group_thread_id) as any)
        : null;
      label = conv
        ? `${conv.topic || conv.participant_names || '(group)'} ${conv.handle}`
        : '(group call)';
    } else {
      label = (r.counterpart_mri && store.nameForMri(r.counterpart_mri)) || '(unknown)';
    }
    return { r, label };
  });
  const filtered = opts.participant
    ? resolved.filter((x) =>
        x.label.toLowerCase().includes(String(opts.participant).toLowerCase()),
      )
    : resolved;
  return filtered.slice(0, limit).map(({ r, label }) => ({
    startTs: r.start_ts,
    direction: r.direction,
    isMissed: r.is_missed,
    durationMs: r.duration_ms,
    state: r.state,
    hasRecording: r.has_recording,
    hasVoicemail: r.has_voicemail,
    spamLevel: r.spam_level,
    isCurrentUserPart: r.is_current_user_part,
    recordingLink: r.recording_link,
    label,
  }));
}

// ---------- events ----------
// One calendar event, camelCase (queryEvents aliases the snake_case DB columns). Number fields that
// are 0/1 flags stay `number` (SQLite has no boolean); the renderer treats them as truthy.
export interface EventView {
  id: string;
  seriesId: string | null;
  kind: string;
  subject: string | null;
  startTs: number;
  endTs: number;
  isAllDay: number;
  organizerName: string | null;
  cid: string | null;
  myResponse: string | null;
  isCancelled: number;
  isConfidential: number;
  hasAttach: number;
  attendees: string | null;
  bodyHtml: string | null;
}

// list_events' data: events in the (already-computed) window, filtered, chronological, limited.
// The forward-default window policy (today..+7d) and coverage notes stay in the MCP layer.
export function queryEvents(
  store: ChatStore,
  opts: {
    sinceTs?: number;
    untilTs?: number;
    type?: string;
    query?: string;
    attendee?: string;
    hideCancelled?: boolean;
    limit?: number;
  } = {},
): EventView[] {
  const db = store.db;
  const limit = Math.min(Number(opts.limit) || 30, 100);
  const where: string[] = [];
  const params: any[] = [];
  if (opts.sinceTs != null) {
    where.push('start_ts>=?');
    params.push(opts.sinceTs);
  }
  if (opts.untilTs != null) {
    where.push('start_ts<?');
    params.push(opts.untilTs);
  }
  if (opts.type && opts.type !== 'all') {
    where.push('kind=?');
    params.push(opts.type);
  }
  if (opts.query) {
    where.push(String.raw`subject like ? escape '\'`);
    params.push(`%${likeEscape(String(opts.query))}%`);
  }
  if (opts.attendee) {
    where.push(String.raw`attendees like ? escape '\'`);
    params.push(`%${likeEscape(String(opts.attendee))}%`);
  }
  if (opts.hideCancelled) where.push('is_cancelled=0');
  const w = where.length ? 'where ' + where.join(' and ') : '';
  return db
    .prepare(
      `select id, series_id as seriesId, kind, subject, start_ts as startTs, end_ts as endTs,
        is_all_day as isAllDay, organizer_name as organizerName, cid, my_response as myResponse,
        is_cancelled as isCancelled, is_confidential as isConfidential, has_attach as hasAttach,
        attendees, body_html as bodyHtml
      from events ${w} order by start_ts asc limit ?`,
    )
    .all(...params, limit) as unknown as EventView[];
}

// Newest materialized occurrence start across ALL events — the honest bound for list_events'
// "recurring events may be under-reported" coverage note.
export function maxEventStart(store: ChatStore): number {
  return (store.db.prepare('select max(start_ts) t from events').get() as any)?.t ?? 0;
}

// ---------- topics (analytics core) ----------
// Build the (cached) per-message phrase extractor: name tokens are excluded from phrase candidates,
// tokenization is cached per content string (the expensive part) on the store (persists across
// calls / incremental refreshes, invalidated when the name-token set changes), and per-call
// `exclude` words are applied by FILTERING the cached array after retrieval — never threaded into
// the extractor, so one call's excludes can't contaminate another's cached phrases.
export function buildPhraseExtractor(
  store: ChatStore,
  db: DB,
  excludeWords: Set<string>,
  extraStopwords?: Iterable<string>,
): (content: string) => string[] {
  const nameTokens = new Set<string>();
  for (const r of db.prepare('select name from people').all() as any[])
    for (const w of String(r.name || '')
      .toLowerCase()
      .match(/[\p{L}\p{M}]{3,}/gu) || [])
      nameTokens.add(w);
  const { phrases: extract } = makeExtractor(nameTokens, undefined, extraStopwords); // en+de merged (default)

  // `extraStopwords` alter the extraction itself (they break phrase runs), so they must be part of
  // the phrase-cache signature — otherwise a different stopword set would reuse stale phrases. When
  // none are supplied the signature is byte-identical to the pre-existing one (empty suffix), so the
  // MCP path (which never passes extras) keeps the exact same cache key and output.
  const extra = extraStopwords
    ? [...extraStopwords]
        .map((w) => String(w).toLowerCase())
        .filter(Boolean)
        .sort(byCodeUnit)
    : [];
  const sig =
    `${nameTokens.size}:${[...nameTokens].sort(byCodeUnit).join(',').length}` +
    (extra.length ? `:x${extra.join(',')}` : '');
  if (store.phraseCacheSig !== sig) {
    store.phraseCache.clear();
    store.phraseCacheSig = sig;
  }
  const cache = store.phraseCache;
  return (content: string): string[] => {
    let p = cache.get(content);
    if (!p) {
      p = extract(content);
      cache.set(content, p);
    }
    return excludeWords.size
      ? p.filter((ph) => !ph.split(' ').some((w) => excludeWords.has(w)))
      : p;
  };
}

export interface TopicView {
  phrase: string;
  count: number; // window mentions
  senderCount: number; // distinct senders in the window (anti-spam gate)
  lift: number; // window rate ÷ smoothed baseline rate
  example: { ts: number; content: string }; // an example message for the phrase
}

// Load the in-scope messages and (by default) drop bot/app senders (28: MRI) — automated
// "updated/status" chatter isn't a topic you discussed. Excluded from BOTH window and baseline
// so lift isn't skewed. (Scope/exclude conds are built by the MCP layer, which owns the shared
// conversation/person resolvers.)
function loadTopicsMessages(
  db: DB,
  conds: string[],
  params: any[],
  includeBots: boolean | undefined,
): { all: any[]; botExcluded: number } {
  let all = db
    .prepare(`select ts, sender_mri, content from messages where ${conds.join(' and ')}`)
    .all(...params) as any[];
  let botExcluded = 0;
  if (!includeBots) {
    const before = all.length;
    all = all.filter((m) => !isBotMri(m.sender_mri));
    botExcluded = before - all.length;
  }
  return { all, botExcluded };
}

// Options for a topics query scope. `scope` is `conversation:<term>` or `person:<term>`; `exclude`
// mixes c:/p: handles (scope filters) and plain words (phrase-extractor stopwords).
export interface TopicsScopeOptions {
  scope?: string;
  exclude?: string[];
  includeBots?: boolean;
}
// On success: the scoped, bot-filtered messages + the facts the MCP needs — `botExcluded` (for the
// disclosure note), `minSenders` (person/1:1 scope relaxes the ≥2-sender anti-spam gate to ≥1),
// `excludeWords` (plain exclude words → phrase-extractor stopwords), and `scopeConvIds` (resolved
// ids when scope=conversation:, for the ambiguity note). A conversation/person scope matching
// NOTHING is a miss, never a silent fall-through to whole-DB topics (P4).
export type TopicsScopeResult =
  | { ok: false; reason: QueryMiss }
  | {
      ok: true;
      all: any[];
      botExcluded: number;
      minSenders: number;
      excludeWords: string[];
      scopeConvIds?: string[];
    };
// Resolve the topics scope (conversation/person + excludes) and load its messages. Owns everything
// that was the MCP's resolveExcludes + buildTopicsScope + loadTopicsMessages — no SQL fragments
// cross the boundary.
export function loadTopicsInScope(store: ChatStore, opts: TopicsScopeOptions): TopicsScopeResult {
  const db = store.db;
  const ex = resolveExcludes(db, opts.exclude);
  if (ex.miss) return { ok: false, reason: ex.miss };
  const conds = ['is_system=0', "content<>''"];
  const params: any[] = [];
  let minSenders = 2;
  let scopeConvIds: string[] | undefined;
  const scope = opts.scope;
  if (scope && scope.startsWith('conversation:')) {
    const term = scope.slice(13);
    const ids = convIdsFor(db, term);
    if (!ids.length) return { ok: false, reason: { reason: 'no-such-conversation', value: term } };
    scopeConvIds = ids;
    conds.push(`conv_id in (${ids.map(() => '?').join(',')})`);
    params.push(...ids);
  } else if (scope && scope.startsWith('person:')) {
    const f = senderFilter(db, scope.slice(7));
    if (f.miss) return { ok: false, reason: { reason: 'no-such-sender', value: scope.slice(7) } };
    conds.push(f.sql.replace('m.', ''));
    params.push(...f.params);
    minSenders = 1;
  }
  if (ex.convIds.length) {
    conds.push(`conv_id not in (${ex.convIds.map(() => '?').join(',')})`);
    params.push(...ex.convIds);
  }
  if (ex.mris.length) {
    conds.push(`sender_mri not in (${ex.mris.map(() => '?').join(',')})`);
    params.push(...ex.mris);
  }
  const { all, botExcluded } = loadTopicsMessages(db, conds, params, opts.includeBots);
  return { ok: true, all, botExcluded, minSenders, excludeWords: ex.words, scopeConvIds };
}

// Score each candidate phrase by lift (window rate ÷ Laplace-smoothed baseline rate) weighted by
// log-frequency, requiring ≥3 window mentions and ≥minSenders distinct senders (anti-spam gate).
export function computeTopicRows(
  all: any[],
  phrases: (content: string) => string[],
  sinceTs: number,
  untilTs: number,
  minSenders: number,
  n: number,
): { rows: TopicView[]; baseTotal: number; win: any[] } {
  const baseDf = new Map<string, number>();
  let baseTotal = 0;
  for (const m of all)
    if (m.ts < sinceTs) {
      baseTotal++;
      for (const ph of new Set(phrases(m.content))) baseDf.set(ph, (baseDf.get(ph) || 0) + 1);
    }

  const count = new Map<string, number>(),
    df = new Map<string, number>();
  const senders = new Map<string, Set<string>>(),
    example = new Map<string, any>();
  const win = all.filter((m) => m.ts >= sinceTs && m.ts < untilTs);
  for (const m of win) {
    const seen = new Set<string>();
    for (const ph of phrases(m.content)) {
      count.set(ph, (count.get(ph) || 0) + 1);
      if (!seen.has(ph)) {
        df.set(ph, (df.get(ph) || 0) + 1);
        seen.add(ph);
      }
      (senders.get(ph) || senders.set(ph, new Set()).get(ph)!).add(m.sender_mri);
      if (!example.has(ph)) example.set(ph, m);
    }
  }
  const rows = [...count.entries()]
    .map(([ph, c]) => {
      const winRate = df.get(ph)! / Math.max(1, win.length);
      const baseRate = ((baseDf.get(ph) || 0) + 0.5) / (baseTotal + 1);
      return {
        phrase: ph,
        count: c,
        senderCount: senders.get(ph)!.size,
        lift: winRate / baseRate,
        example: example.get(ph),
      };
    })
    .filter((r) => r.count >= 3 && r.senderCount >= minSenders)
    .sort((a, b) => b.lift * Math.log2(1 + b.count) - a.lift * Math.log2(1 + a.count))
    .slice(0, n);
  return { rows, baseTotal, win };
}

// Topics window policy: an explicit range (already-parsed sinceTs/untilTs) overrides the enum
// window. Baseline is always messages BEFORE the window ("new vs history"); the default window
// anchors to the newest message actually IN SCOPE (`all`), not wall-clock now. `explicit` is passed
// in (the MCP layer computes it from arg presence + does the parseTime/validation).
export function computeTopicsWindow(
  all: any[],
  opts: { explicit: boolean; sinceTs?: number; untilTs?: number; windowKey?: string },
): { sinceTs: number; untilTs: number } {
  let maxTs = 0;
  for (const m of all) if (m.ts > maxTs) maxTs = m.ts;
  const windowMs =
    { '1d': 864e5, '7d': 7 * 864e5, '30d': 30 * 864e5 }[String(opts.windowKey || '7d')] ??
    7 * 864e5;
  const sinceTs = opts.explicit ? (opts.sinceTs ?? 0) : maxTs - windowMs;
  const untilTs = opts.explicit ? (opts.untilTs ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
  return { sinceTs, untilTs };
}
