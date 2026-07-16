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

// Build a safe FTS5 MATCH string: quote each term so user punctuation/operators can't throw a
// syntax error. Returns null if there's nothing to match.
export function ftsMatch(raw: string): string | null {
  const toks = raw.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  return toks.length ? toks.map((t) => `"${t}"`).join(' ') : null;
}

// ---------- search ----------
// Execute the search: FTS5 MATCH+bm25 ranking when available and a query is given, else a plain
// content LIKE scan ordered by recency. `conds`/`params` are extended in place: the LIKE path
// appends the query as a where-clause (so callers must pass their OWN copy, not the shared scope
// arrays, if those need to stay query-free — see the coverage note in the MCP layer).
export function runSearchQuery(
  db: DB,
  ftsEnabled: boolean,
  conds: string[],
  params: any[],
  limit: number,
  query: string | undefined,
): { rows: any[]; order: string } {
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
// Fetch the rows to render for a flat (1:1/group/meeting) conversation: either a window CENTERED
// on `around` (half before/half after, oldest→newest), or the last `limit` rows matching
// `conds`/`params` (also oldest→newest). Returns `{ aroundNotFound: <id> }` when the pivot id
// isn't in the conversation; the MCP layer turns that into its user-facing message.
export function queryMessageWindow(
  db: DB,
  id: string,
  limit: number,
  conds: string[],
  params: any[],
  around: string | undefined,
): { rows: any[] } | { aroundNotFound: string } {
  if (around) {
    const aroundId = around.replace(/^m:/, '');
    const a = db.prepare('select ts from messages where conv_id=? and id=?').get(id, aroundId) as any;
    if (!a) return { aroundNotFound: around };
    const half = Math.floor(limit / 2);
    const before = db
      .prepare(
        `select * from messages where conv_id=? and is_system=0 and ts<=? order by ts desc, id desc limit ?`,
      )
      .all(id, a.ts, half) as any[];
    const after = db
      .prepare(
        `select * from messages where conv_id=? and is_system=0 and ts>? order by ts asc, id asc limit ?`,
      )
      .all(id, a.ts, half) as any[];
    return { rows: [...before.toReversed(), ...after] };
  }
  // last `limit` in the window, rendered oldest→newest (story order)
  const rows = (
    db
      .prepare(
        `select * from messages where ${conds.join(' and ')} order by ts desc, id desc limit ?`,
      )
      .all(...params, limit) as any[]
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

// Per-reply-chain activity summaries (message count + last-activity ts per root) for the given
// scope conds/params — drives which threads a channel digest surfaces.
export function queryThreadSummaries(
  db: DB,
  conds: string[],
  params: any[],
): { root_id: any; n: number; last: number }[] {
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
export interface PersonRow {
  handle: string;
  mri: string;
  name: string;
  msgCount: number;
  lastTs: number;
}
export interface PeopleResult {
  mode: 'handle' | 'search' | 'roster'; // how the query resolved (drives the renderer's header)
  query: string; // the trimmed query, '' for roster
  rows: PersonRow[];
}

const toPersonRow = (r: any): PersonRow => ({
  handle: r.handle,
  mri: r.mri,
  name: r.name,
  msgCount: r.msg_count,
  lastTs: r.last_ts,
});

// find_person's data: a p:handle lookup, a name substring search, or the volume-ranked roster.
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
    return { mode: 'handle', query: q, rows };
  }
  if (q) {
    const rows = (
      db
        .prepare(
          String.raw`select ${cols} from people where name like ? escape '\' order by msg_count desc limit ?`,
        )
        .all(`%${likeEscape(q)}%`, n) as any[]
    ).map(toPersonRow);
    return { mode: 'search', query: q, rows };
  }
  const rows = (
    db.prepare(`select ${cols} from people order by msg_count desc limit ?`).all(n) as any[]
  ).map(toPersonRow);
  return { mode: 'roster', query: '', rows };
}

// ---------- conversations ----------
export interface ConversationRow {
  handle: string;
  kind: string;
  topic: string | null;
  participantNames: string | null;
  lastTs: number;
  msgCount: number;
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
): ConversationRow[] {
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
      `select handle,kind,topic,participant_names,last_ts,msg_count
     from conversations ${w} order by last_ts desc limit ?`,
    )
    .all(...params, n) as any[];
  return rows.map((r) => ({
    handle: r.handle,
    kind: r.kind,
    topic: r.topic,
    participantNames: r.participant_names,
    lastTs: r.last_ts,
    msgCount: r.msg_count,
  }));
}

// ---------- calls ----------
export interface CallRow {
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
): CallRow[] {
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
// Raw event row shape (DB columns) — the recurrence-collapse renderer in the MCP layer reads these
// fields directly; kept snake_case to match the events table (a camelCase remap is a later cleanup).
export interface EventRow {
  id: string;
  series_id: string | null;
  kind: string;
  subject: string | null;
  start_ts: number;
  end_ts: number;
  is_all_day: number;
  organizer_name: string | null;
  cid: string | null;
  my_response: string | null;
  is_cancelled: number;
  is_confidential: number;
  has_attach: number;
  attendees: string | null;
  body_html: string | null;
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
): EventRow[] {
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
    .prepare(`select * from events ${w} order by start_ts asc limit ?`)
    .all(...params, limit) as unknown as EventRow[];
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
): (content: string) => string[] {
  const nameTokens = new Set<string>();
  for (const r of db.prepare('select name from people').all() as any[])
    for (const w of String(r.name || '')
      .toLowerCase()
      .match(/[\p{L}\p{M}]{3,}/gu) || [])
      nameTokens.add(w);
  const { phrases: extract } = makeExtractor(nameTokens); // en+de merged (default)

  const sig = `${nameTokens.size}:${[...nameTokens].sort(byCodeUnit).join(',').length}`;
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

export interface TopicRow {
  ph: string;
  c: number;
  ns: number;
  lift: number;
  ex: any;
}

// Load the in-scope messages and (by default) drop bot/app senders (28: MRI) — automated
// "updated/status" chatter isn't a topic you discussed. Excluded from BOTH window and baseline
// so lift isn't skewed. (Scope/exclude conds are built by the MCP layer, which owns the shared
// conversation/person resolvers.)
export function loadTopicsMessages(
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

// Score each candidate phrase by lift (window rate ÷ Laplace-smoothed baseline rate) weighted by
// log-frequency, requiring ≥3 window mentions and ≥minSenders distinct senders (anti-spam gate).
export function computeTopicRows(
  all: any[],
  phrases: (content: string) => string[],
  sinceTs: number,
  untilTs: number,
  minSenders: number,
  n: number,
): { rows: TopicRow[]; baseTotal: number; win: any[] } {
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
      return { ph, c, ns: senders.get(ph)!.size, lift: winRate / baseRate, ex: example.get(ph) };
    })
    .filter((r) => r.c >= 3 && r.ns >= minSenders)
    .sort((a, b) => b.lift * Math.log2(1 + b.c) - a.lift * Math.log2(1 + a.c))
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
