import { isBotMri, type ChatStore, type StoreMeta } from './ingest/store.js';
import { makeExtractor } from './util/topics.js';
import { byCodeUnit } from './util/sort.js';
import { reactionGlyph } from './util/emoji.js';
import type {
  ListConversationsArgs,
  ReadMessagesArgs,
  SearchArgs,
  TopTopicsArgs,
  FindPersonArgs,
} from './schemas.js';

type DB = ChatStore['db'];

// ---------- formatting ----------
const pad = (n: number) => String(n).padStart(2, '0');
export function fmtTs(ts: number): string {
  if (!ts) return '--';
  const d = new Date(ts);
  const now = new Date();
  const y = d.getFullYear() !== now.getFullYear() ? `${d.getFullYear()}-` : '';
  return `${y}${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function envelope(meta: StoreMeta, deferred: boolean, extra = ''): string {
  const tz = -new Date().getTimezoneOffset() / 60;
  const stale = deferred ? ' · data:may-be-stale' : '';
  const lossy = (meta as any).lossy ? ' · data:incomplete(source-partially-unreadable)' : '';
  return `as_of ${fmtTs(meta.asOf)} (tz${tz >= 0 ? '+' : ''}${tz})${stale}${lossy}${extra ? ' · ' + extra : ''}`;
}
export function parseTime(s: string | number | undefined, now = Date.now()): number | undefined {
  if (s == null) return undefined;
  if (typeof s === 'number') return s;
  const rel = /^-(\d+)([dhm])$/.exec(s.trim());
  if (rel) {
    const n = +rel[1];
    const u = rel[2];
    const subDayMs = u === 'h' ? 36e5 : 6e4;
    return now - n * (u === 'd' ? 864e5 : subDayMs);
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : t;
}
// Reject unparseable time filters loudly instead of silently ignoring them.
function badTime(args: any, keys: string[]): string | null {
  for (const k of keys)
    if (args[k] != null && parseTime(args[k]) === undefined)
      return `error: cannot parse ${k}="${args[k]}" — use ISO (2026-07-01) or relative (-7d / -24h / -30m)`;
  return null;
}
// Build a safe FTS5 MATCH string: quote each term so user punctuation/operators can't
// throw a syntax error. Returns null if there's nothing to match.
function ftsMatch(raw: string): string | null {
  const toks = raw.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  return toks.length ? toks.map((t) => `"${t}"`).join(' ') : null;
}
// Truncate with an ellipsis marker so the agent can tell a message was cut.
function clip(s: string, n: number): string {
  s = (s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// escape LIKE wildcards in user input (used with `escape '\'`)
function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (m) => '\\' + m);
}

// ---------- resolvers (name/handle → ids) ----------
function convIdsFor(db: DB, arg: string): string[] {
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
function senderFilter(db: DB, arg: string): { sql: string; params: any[]; miss?: string } {
  if (arg.startsWith('p:')) {
    const r = db.prepare('select mri from people where handle=?').get(arg) as any;
    if (!r) return { sql: '1=0', params: [], miss: `no person matches ${arg}` };
    return { sql: 'm.sender_mri=?', params: [r.mri] };
  }
  return { sql: String.raw`m.sender_name like ? escape '\'`, params: [`%${likeEscape(arg)}%`] };
}

// Resolve an `exclude` list into conversation ids / sender MRIs / plain words. Handles fail
// loudly (return .miss) so a typo'd handle never silently excludes nothing.
function resolveExcludes(
  db: DB,
  list: string[] | undefined,
): { convIds: string[]; mris: string[]; words: string[]; miss?: string } {
  const convIds: string[] = [],
    mris: string[] = [],
    words: string[] = [];
  for (const raw of list ?? []) {
    const e = String(raw).trim();
    if (!e) continue;
    if (e.startsWith('c:')) {
      const r = db.prepare('select id from conversations where handle=?').get(e) as any;
      if (!r) return { convIds, mris, words, miss: `exclude: no conversation ${e}` };
      convIds.push(r.id);
    } else if (e.startsWith('p:')) {
      const r = db.prepare('select mri from people where handle=?').get(e) as any;
      if (!r) return { convIds, mris, words, miss: `exclude: no person ${e}` };
      mris.push(r.mri);
    } else words.push(e.toLowerCase());
  }
  return { convIds, mris, words };
}

// Local-cache coverage for a scope (min/max message ts, system msgs excluded) — surfaced on
// empty/edge results so "0 hits" isn't misread as "quiet" when the cache simply hasn't synced
// anything that recent. Claims only what the cache knows ("newest cached"), never "quiet".
function coverageNote(db: DB, scopeSql: string, scopeParams: any[]): string {
  const r = db
    .prepare(`select min(m.ts) lo, max(m.ts) hi from messages m where ${scopeSql} and m.ts>0`)
    .get(...scopeParams) as any;
  if (!r?.hi) return 'no cached messages in this scope';
  return `newest cached in this scope: ${fmtTs(r.hi)} · oldest ${fmtTs(r.lo)} — local cache may lag the server`;
}
// A conversation title-substring that matches >1 conversation → non-blocking disambiguation note.
function convAmbiguityNote(db: DB, arg: string, ids: string[]): string {
  if (arg.startsWith('c:') || ids.length <= 1) return '';
  const rows = db
    .prepare(
      `select handle,topic,participant_names from conversations where id in (${ids.map(() => '?').join(',')}) order by last_ts desc limit 4`,
    )
    .all(...ids) as any[];
  const names = rows
    .map((r) => `${r.handle} ${r.topic || r.participant_names || ''}`.trim())
    .join(', ');
  return `note: in:"${arg}" matched ${ids.length} conversations (${names}) — searching all; pass a c:handle to narrow`;
}

// ================= TOOLS =================

export function listConversations(
  store: ChatStore,
  meta: StoreMeta,
  deferred: boolean,
  args: ListConversationsArgs = {},
): string {
  const db = store.db;
  const bt = badTime(args, ['since']);
  if (bt) return bt;
  const n = Math.min(Number(args.n) || 12, 30);
  const where: string[] = [];
  const params: any[] = [];
  if (!args.include_empty) where.push('msg_count>0'); // hide 0-message team roots by default
  if (args.kind) {
    where.push('kind=?');
    params.push(args.kind);
  }
  if (args.query) {
    where.push('(topic like ? or participant_names like ?)');
    params.push(`%${args.query}%`, `%${args.query}%`);
  }
  if (args.participant) {
    where.push('participant_names like ?');
    params.push(`%${args.participant}%`);
  }
  const since = parseTime(args.since);
  if (since) {
    where.push('last_ts>=?');
    params.push(since);
  }
  const w = where.length ? 'where ' + where.join(' and ') : '';
  const rows = db
    .prepare(
      `select handle,kind,topic,participant_names,last_ts,msg_count
     from conversations ${w} order by last_ts desc limit ?`,
    )
    .all(...params, n) as any[];
  const lines = rows.map((r) => {
    const title = r.topic || r.participant_names || '(untitled)';
    return `${r.handle} [${r.kind}] "${title}" · ${r.msg_count} msg · last ${fmtTs(r.last_ts)}`;
  });
  const extra = `${rows.length} conversations`;
  return `${envelope(meta, deferred, extra)}\n${lines.join('\n') || '(none)'}`;
}

// Resolve a `conversation` selector (handle or title/participant substring) to a single
// conversation id, or an early-return string (ambiguous-picker text, or a "no match" message)
// when it can't unambiguously resolve.
function resolveConversationArg(db: DB, conversation: string): { id: string } | { early: string } {
  const ids = convIdsFor(db, conversation);
  if (!ids.length) return { early: `no conversation matches "${conversation}"` };
  if (ids.length > 1 && !conversation.startsWith('c:')) {
    const cands = db
      .prepare(
        `select handle,kind,topic,participant_names from conversations
      where id in (${ids.map(() => '?').join(',')}) order by last_ts desc limit 8`,
      )
      .all(...ids) as any[];
    return {
      early:
        `ambiguous — ${ids.length} conversations match. Pick a handle:\n` +
        cands.map((c) => `  ${c.handle} [${c.kind}] ${c.topic || c.participant_names}`).join('\n'),
    };
  }
  return { id: ids[0] };
}

// Fetch the rows to render: either a window CENTERED on `around` (half before/half after,
// oldest→newest), or the last `limit` rows matching `conds`/`params` (also oldest→newest).
function fetchMessageRows(
  db: DB,
  id: string,
  limit: number,
  conds: string[],
  params: any[],
  around: string | undefined,
): { rows: any[] } | { early: string } {
  if (around) {
    const aroundId = around.replace(/^m:/, '');
    const a = db
      .prepare('select ts from messages where conv_id=? and id=?')
      .get(id, aroundId) as any;
    if (!a) return { early: `message ${around} not found in this conversation` };
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

// Render message rows oldest→newest, collapsing consecutive same-sender runs (by MRI, not
// display name) unless more than 15 minutes have passed since the previous message.
// Reaction summary for one message. Two-level cap, tuned against real data (see plan/vision.md
// #6): emoji groups sorted by reactor-count desc; groups 1–3 are NAMED (≤3 names, you-first then
// most-recent, per-group `+K` overflow), groups 4–5 show glyph+count only, group 6+ collapses to
// `+N more` (N = remaining reactor count, so the histogram total stays honest). `full` drops all
// caps and names everyone — for "did person X react?". Returns '' when there are no reactions.
function renderReactions(
  reactionsJson: string | null | undefined,
  store: ChatStore,
  selfMri: string | null,
  full: boolean,
): string {
  if (!reactionsJson) return '';
  let groups: { k: string; u: [string, number][] }[];
  try {
    groups = JSON.parse(reactionsJson);
  } catch {
    return '';
  }
  if (!Array.isArray(groups) || groups.length === 0) return '';
  const nameOf = (mri: string): string =>
    mri === selfMri ? 'you' : store.nameForMri(mri) || '(unknown)';
  // Order reactors within a group: you first, then most-recent by reaction time.
  const orderedNames = (u: [string, number][]): string[] => {
    const sorted = u.slice().sort((a, b) => {
      const aSelf = a[0] === selfMri,
        bSelf = b[0] === selfMri;
      if (aSelf !== bSelf) return aSelf ? -1 : 1;
      return b[1] - a[1];
    });
    return sorted.map((x) => nameOf(x[0]));
  };
  // Order emoji groups: most reactors first; ties broken by earliest reaction, then key.
  const ranked = groups
    .map((g) => ({ g, count: g.u.length, min: Math.min(...g.u.map((x) => x[1] || Infinity)) }))
    .sort((a, b) => b.count - a.count || a.min - b.min || byCodeUnit(a.g.k, b.g.k));

  const parts: string[] = [];
  let tail = 0;
  ranked.forEach(({ g, count }, i) => {
    const glyph = reactionGlyph(g.k);
    if (full) {
      parts.push(`${glyph} ${count} · ${orderedNames(g.u).join(', ')}`);
    } else if (i < 3) {
      const names = orderedNames(g.u).slice(0, 3);
      const extra = count - names.length;
      parts.push(`${glyph} ${count} · ${names.join(', ')}${extra > 0 ? ` +${extra}` : ''}`);
    } else if (i < 5) {
      parts.push(`${glyph} ${count}`);
    } else {
      tail += count;
    }
  });
  if (tail > 0) parts.push(`+${tail} more`);
  return parts.join('   ');
}

interface ReactionCtx {
  store: ChatStore;
  selfMri: string | null;
  full: boolean;
}

function renderMessageLines(rows: any[], rx?: ReactionCtx): string[] {
  let lastMri: string | null = null;
  let lastTs = 0;
  return rows.map((r) => {
    const collapsed = r.sender_mri === lastMri && r.ts - lastTs < 15 * 60_000;
    lastMri = r.sender_mri;
    lastTs = r.ts;
    const senderLabel = r.is_mine ? 'ME' : r.sender_name || '(unknown)';
    const who = collapsed ? '  ↳' : senderLabel;
    const marks = (r.has_attach ? ' [attachment]' : '') + (r.mentions_me ? ' [@me]' : '');
    const line = `${fmtTs(r.ts)} ${who}> ${clip(r.content, 280)}${marks}`;
    const rxLine = rx ? renderReactions(r.reactions, rx.store, rx.selfMri, rx.full) : '';
    return rxLine ? `${line}\n      ${rxLine}` : line;
  });
}

// Show both local bounds so a caller knows the cache slice — "newest local" flags when the
// local cache lags the server (its most recent cached message may be days old).
function buildReadMessagesHead(
  conv: any,
  shown: number,
  total: number,
  earliest: number,
  newest: number,
  olderCursor: string,
): string {
  const olderSuffix = olderCursor ? ` · older: ${olderCursor}` : '';
  return `${conv.handle} [${conv.kind}] "${conv.topic || conv.participant_names}" · showing ${shown}/${total} · local cache ${fmtTs(earliest)}–${fmtTs(newest)}${olderSuffix}`;
}

export function readMessages(
  store: ChatStore,
  meta: StoreMeta,
  deferred: boolean,
  args: ReadMessagesArgs = {} as ReadMessagesArgs,
): string {
  const db = store.db;
  const bt = badTime(args, ['since', 'until']);
  if (bt) return bt;
  if (!args.conversation) return 'error: conversation (handle or title substring) is required';
  const resolved = resolveConversationArg(db, String(args.conversation));
  if ('early' in resolved) return resolved.early;
  const id = resolved.id;

  const limit = Math.min(Number(args.limit) || 40, 200);
  const conds = ['conv_id=?', 'is_system=0'];
  const p: any[] = [id];
  const since = parseTime(args.since);
  if (since) {
    conds.push('ts>=?');
    p.push(since);
  }
  const until = parseTime(args.until);
  if (until) {
    conds.push('ts<?');
    p.push(until);
  }
  // cursor `older:<ts>:<id>` — (ts,id) tuple so equal-timestamp neighbours aren't skipped
  const older = args.cursor && /^older:(\d+):(.+)$/.exec(String(args.cursor));
  if (older) {
    conds.push('(ts<? or (ts=? and id<?))');
    p.push(Number(older[1]), Number(older[1]), older[2]);
  }

  const fetched = fetchMessageRows(
    db,
    id,
    limit,
    conds,
    p,
    args.around ? String(args.around) : undefined,
  );
  if ('early' in fetched) return fetched.early;
  const rows = fetched.rows;

  const conv = db
    .prepare('select handle,kind,topic,participant_names from conversations where id=?')
    .get(id) as any;
  const total = (
    db.prepare('select count(*) n from messages where conv_id=? and is_system=0').get(id) as any
  ).n;
  const span = db
    .prepare('select min(ts) lo, max(ts) hi from messages where conv_id=? and is_system=0 and ts>0')
    .get(id) as any;
  const earliest = span?.lo ?? 0,
    newest = span?.hi ?? 0;
  // Only offer an older: cursor when there really are older messages (else the agent pages into nothing).
  const oldest = rows[0];
  const olderCursor = oldest && oldest.ts > earliest ? `older:${oldest.ts}:${oldest.id}` : '';
  const head = buildReadMessagesHead(conv, rows.length, total, earliest, newest, olderCursor);
  const lines = renderMessageLines(rows, {
    store,
    selfMri: (meta as any).selfMri as string | null,
    full: String(args.reactions) === 'full',
  });
  return `${envelope(meta, deferred)}\n${head}\n${lines.join('\n') || '(no messages)'}`;
}

// Apply the `from:` filter: resolve to a sender condition, plus (for a name substring, not a
// p:handle) a non-blocking "matched N people" note when the substring is ambiguous.
function applyFromFilter(
  db: DB,
  from: string,
): { cond: string; params: any[]; note?: string } | { miss: string } {
  const f = senderFilter(db, from);
  if (f.miss) return { miss: f.miss };
  let note: string | undefined;
  if (!from.startsWith('p:')) {
    const ppl = db
      .prepare(
        String.raw`select handle,name from people where name like ? escape '\' order by msg_count desc`,
      )
      .all(`%${likeEscape(from)}%`) as any[];
    if (ppl.length > 1)
      note = `note: from:"${from}" matched ${ppl.length} people (${ppl
        .slice(0, 4)
        .map((p) => `${p.handle} ${p.name}`)
        .join(', ')}) — pass a p:handle to narrow`;
  }
  return { cond: f.sql, params: f.params, note };
}
// Apply the `in:` filter: resolve a conversation selector to a scope condition, or "no
// conversation matches" when nothing resolves.
function applyInFilter(
  db: DB,
  inArg: string,
): { cond: string; params: any[]; note?: string } | { miss: string } {
  const ids = convIdsFor(db, inArg);
  if (!ids.length) return { miss: `no conversation matches "${inArg}"` };
  const amb = convAmbiguityNote(db, inArg, ids);
  return {
    cond: `m.conv_id in (${ids.map(() => '?').join(',')})`,
    params: ids,
    note: amb || undefined,
  };
}
// Apply the `exclude` list (c:/p: handles only — plain words aren't used by search) as extra
// scope conditions, or a miss when a handle doesn't resolve.
function applyExcludeFilter(
  db: DB,
  exclude: string[],
): { conds: string[]; params: any[] } | { miss: string } {
  const ex = resolveExcludes(db, exclude);
  if (ex.miss) return { miss: ex.miss };
  const conds: string[] = [];
  const params: any[] = [];
  if (ex.convIds.length) {
    conds.push(`m.conv_id not in (${ex.convIds.map(() => '?').join(',')})`);
    params.push(...ex.convIds);
  }
  if (ex.mris.length) {
    conds.push(`m.sender_mri not in (${ex.mris.map(() => '?').join(',')})`);
    params.push(...ex.mris);
  }
  return { conds, params };
}
// Build the scope filter (who/where/kind + excludes — NOT time, NOT the query term) from
// search args, used both to run the query and to compute the coverage note. Returns an
// early-return miss string when a from:/in:/exclude handle doesn't resolve, so a typo'd handle
// never silently matches nothing (or everything).
function buildSearchScope(
  db: DB,
  args: SearchArgs,
): { conds: string[]; params: any[]; notes: string[] } | { miss: string } {
  const conds: string[] = ['m.is_system=0'];
  const params: any[] = [];
  const notes: string[] = [];
  if (args.from) {
    const f = applyFromFilter(db, String(args.from));
    if ('miss' in f) return { miss: f.miss };
    conds.push(f.cond);
    params.push(...f.params);
    if (f.note) notes.push(f.note);
  }
  if (args.in) {
    const inRes = applyInFilter(db, String(args.in));
    if ('miss' in inRes) return { miss: inRes.miss };
    conds.push(inRes.cond);
    params.push(...inRes.params);
    if (inRes.note) notes.push(inRes.note);
  }
  if (args.kind) {
    conds.push('m.kind=?');
    params.push(args.kind);
  }
  if (args.mentions_me) conds.push('m.mentions_me=1');
  if (args.has_attachment) conds.push('m.has_attach=1');
  if (args.exclude?.length) {
    const exRes = applyExcludeFilter(db, args.exclude);
    if ('miss' in exRes) return { miss: exRes.miss };
    conds.push(...exRes.conds);
    params.push(...exRes.params);
  }
  return { conds, params, notes };
}

// Execute the search: FTS5 MATCH+bm25 ranking when available and a query is given, else a plain
// content LIKE scan ordered by recency. `conds`/`params` are extended in place: the LIKE path
// appends the query as a where-clause (so callers must pass their OWN copy, not the shared scope
// arrays, if those need to stay query-free — see computeSearchCoverage).
function runSearchQuery(
  db: DB,
  meta: StoreMeta,
  conds: string[],
  params: any[],
  limit: number,
  query: string | undefined,
): { rows: any[]; order: string } {
  const match = query && String(query).trim() ? ftsMatch(String(query)) : null;
  if (match && meta.ftsEnabled) {
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

// Build the per-hit lines and the (optional) conversation legend, resolving conv_id → handle
// once per distinct conversation (memoized).
function buildSearchResults(db: DB, rows: any[]): { lines: string[]; legend: string } {
  const convH = new Map<string, string>();
  const hn = (cid: string) =>
    convH.get(cid) ??
    convH
      .set(
        cid,
        (db.prepare('select handle from conversations where id=?').get(cid) as any)?.handle ?? '?',
      )
      .get(cid)!;
  const distinct = [...new Set(rows.map((r) => r.conv_id))];
  const legend =
    distinct.length <= 5
      ? distinct
          .map(
            (cid) =>
              `${hn(cid)}="${(db.prepare('select topic,participant_names from conversations where id=?').get(cid) as any)?.topic || (db.prepare('select participant_names from conversations where id=?').get(cid) as any)?.participant_names || '?'}"`,
          )
          .join(' · ')
      : '';
  const lines = rows.map(
    (r) =>
      `${hn(r.conv_id)} ${fmtTs(r.ts)} m:${r.id} ${r.is_mine ? 'ME' : r.sender_name}> ${clip(r.snip, 140)}`,
  );
  return { lines, legend };
}

// Cache-horizon note: on empty results, or when a `since` filter starts after the newest cached
// message in scope (window entirely uncovered), tell the reader what the cache holds.
function computeSearchCoverage(
  db: DB,
  scopeConds: string[],
  scopeParams: any[],
  rows: any[],
  since: number | undefined,
): string {
  const scopeSql = scopeConds.join(' and ');
  if (rows.length === 0) return coverageNote(db, scopeSql, scopeParams);
  if (since) {
    const hi =
      (
        db
          .prepare(`select max(m.ts) hi from messages m where ${scopeSql}`)
          .get(...scopeParams) as any
      )?.hi ?? 0;
    if (since > hi) return coverageNote(db, scopeSql, scopeParams);
  }
  return '';
}

export function search(
  store: ChatStore,
  meta: StoreMeta,
  deferred: boolean,
  args: SearchArgs = {},
): string {
  const db = store.db;
  const bt = badTime(args, ['since', 'until']);
  if (bt) return bt;
  const limit = Math.min(Number(args.limit) || 20, 60);
  // scopeConds/scopeParams = who/where/kind + excludes (NOT time, NOT the query term) — used for
  // the coverage note so "newest cached" means "in this scope", not "newest matching the query".
  const scope = buildSearchScope(db, args);
  if ('miss' in scope) return scope.miss;
  const { conds: scopeConds, params: scopeParams, notes } = scope;

  const conds = [...scopeConds];
  const params = [...scopeParams];
  const since = parseTime(args.since);
  if (since) {
    conds.push('m.ts>=?');
    params.push(since);
  }
  const until = parseTime(args.until);
  if (until) {
    conds.push('m.ts<?');
    params.push(until);
  }

  const { rows, order } = runSearchQuery(db, meta, conds, params, limit, args.query);
  const { lines, legend } = buildSearchResults(db, rows);
  const coverage = computeSearchCoverage(db, scopeConds, scopeParams, rows, since);

  const head = [
    envelope(meta, deferred, `order:${order} · ${rows.length} hits`),
    ...notes,
    legend,
    coverage,
  ]
    .filter(Boolean)
    .join('\n');
  return `${head}\n${lines.join('\n') || '(no matches)'}`;
}

// Build the (cached) per-message phrase extractor: name tokens are excluded from phrase
// candidates, tokenization is cached per content string (the expensive part) on the store
// (persists across calls / incremental refreshes, invalidated when the name-token set changes),
// and per-call `exclude` words are applied by FILTERING the cached array after retrieval — never
// threaded into the extractor, so one call's excludes can't contaminate another's cached phrases.
function buildPhraseExtractor(
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

// Restrict top_topics to a conversation or a person, plus always-applied excludes. A person/1:1
// scope inherently has one speaker per phrase, so the ≥2-sender anti-spam gate relaxes to ≥1
// there. A conversation/person scope matching NOTHING must error, not silently fall through to
// whole-DB topics (P4).
function buildTopicsScope(
  db: DB,
  scope: string | undefined,
  ex: { convIds: string[]; mris: string[] },
): { conds: string[]; params: any[]; notes: string[]; minSenders: number } | { miss: string } {
  const conds = ['is_system=0', "content<>''"];
  const params: any[] = [];
  const notes: string[] = [];
  let personScope = false;
  if (scope && scope.startsWith('conversation:')) {
    const term = scope.slice(13);
    const ids = convIdsFor(db, term);
    if (!ids.length) return { miss: `no conversation matches "${term}"` };
    conds.push(`conv_id in (${ids.map(() => '?').join(',')})`);
    params.push(...ids);
    const amb = convAmbiguityNote(db, term, ids);
    if (amb) notes.push(amb.replace('in:', 'scope conversation:'));
  } else if (scope && scope.startsWith('person:')) {
    const f = senderFilter(db, scope.slice(7));
    if (f.miss) return { miss: f.miss };
    conds.push(f.sql.replace('m.', ''));
    params.push(...f.params);
    personScope = true;
  }
  if (ex.convIds.length) {
    conds.push(`conv_id not in (${ex.convIds.map(() => '?').join(',')})`);
    params.push(...ex.convIds);
  }
  if (ex.mris.length) {
    conds.push(`sender_mri not in (${ex.mris.map(() => '?').join(',')})`);
    params.push(...ex.mris);
  }
  return { conds, params, notes, minSenders: personScope ? 1 : 2 };
}

// Load the in-scope messages and (by default) drop bot/app senders (28: MRI) — automated
// "updated/status" chatter isn't a topic you discussed. Excluded from BOTH window and baseline
// so lift isn't skewed.
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

// Window: explicit since/until (arbitrary range) overrides the enum window. Baseline is always
// the messages BEFORE the window ("new vs history") — never after — so a topic that persists
// past the window isn't penalised. The default window anchors to the newest message actually IN
// SCOPE (`all`), not wall-clock "now".
function computeTopicsWindow(
  all: any[],
  args: TopTopicsArgs,
): { sinceTs: number; untilTs: number; explicit: boolean } {
  const explicit = args.since != null || args.until != null;
  let maxTs = 0;
  for (const m of all) if (m.ts > maxTs) maxTs = m.ts;
  const windowMs =
    { '1d': 864e5, '7d': 7 * 864e5, '30d': 30 * 864e5 }[String(args.window || '7d')] ?? 7 * 864e5;
  const sinceTs = explicit ? (parseTime(args.since) ?? 0) : maxTs - windowMs;
  const untilTs = explicit
    ? (parseTime(args.until) ?? Number.MAX_SAFE_INTEGER)
    : Number.MAX_SAFE_INTEGER;
  return { sinceTs, untilTs, explicit };
}

// Score each candidate phrase by lift (window rate ÷ Laplace-smoothed baseline rate) weighted by
// log-frequency, requiring ≥3 window mentions and ≥minSenders distinct senders (anti-spam gate).
function computeTopicRows(
  all: any[],
  phrases: (content: string) => string[],
  sinceTs: number,
  untilTs: number,
  minSenders: number,
  n: number,
): {
  rows: { ph: string; c: number; ns: number; lift: number; ex: any }[];
  baseTotal: number;
  win: any[];
} {
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

function renderTopicRows(
  rows: { ph: string; c: number; ns: number; lift: number; ex: any }[],
): string[] {
  return rows.map(
    (r, i) =>
      `${i + 1}. "${r.ph}" ×${r.c} (${r.lift.toFixed(1)}× baseline) · ${r.ns} people\n   e.g. ${fmtTs(r.ex.ts)}: ${clip(r.ex.content, 90)}`,
  );
}

export function topTopics(
  store: ChatStore,
  meta: StoreMeta,
  deferred: boolean,
  args: TopTopicsArgs = {},
): string {
  const db = store.db;
  const bt = badTime(args, ['since', 'until']);
  if (bt) return bt;
  const n = Math.min(Number(args.n) || 8, 15);

  const ex = resolveExcludes(db, args.exclude);
  if (ex.miss) return ex.miss;
  const phrases = buildPhraseExtractor(store, db, new Set(ex.words));

  const scoped = buildTopicsScope(db, args.scope ? String(args.scope) : undefined, ex);
  if ('miss' in scoped) return scoped.miss;
  const { conds, params, notes, minSenders } = scoped;

  const { all, botExcluded } = loadTopicsMessages(db, conds, params, args.include_bots);
  if (!all.length) return `${envelope(meta, deferred)}\n(no messages in scope)`;

  const { sinceTs, untilTs, explicit } = computeTopicsWindow(all, args);
  const { rows, baseTotal, win } = computeTopicRows(all, phrases, sinceTs, untilTs, minSenders, n);

  if (botExcluded)
    notes.push(`excluded ${botExcluded} bot/app msgs · include_bots:true to include`);
  if (baseTotal < 30) notes.push(`baseline sparse (${baseTotal} msgs) — ×baseline is approximate`);
  const untilLabel = untilTs === Number.MAX_SAFE_INTEGER ? 'now' : fmtTs(untilTs);
  const windowLabel = explicit
    ? `range ${fmtTs(sinceTs)}..${untilLabel}`
    : `window ${args.window || '7d'}`;
  const lines = renderTopicRows(rows);
  const head = [envelope(meta, deferred, `${windowLabel} · ${win.length} msgs`), ...notes].join(
    '\n',
  );
  return `${head}\n${lines.join('\n') || '(no distinctive topics)'}`;
}

export function findPerson(
  store: ChatStore,
  meta: StoreMeta,
  deferred: boolean,
  args: FindPersonArgs = {},
): string {
  const db = store.db;
  const n = Math.min(Number(args.n) || 8, 25);
  const q = args.query ? String(args.query).trim() : '';
  let rows: any[];
  let header: string;
  if (q.startsWith('p:')) {
    rows = db
      .prepare('select handle,mri,name,msg_count,last_ts from people where handle=?')
      .all(q) as any[];
    if (!rows.length) return `${envelope(meta, deferred)}\nno person with handle ${q}`;
    header = 'profile';
  } else if (q) {
    rows = db
      .prepare(
        String.raw`select handle,mri,name,msg_count,last_ts from people where name like ? escape '\' order by msg_count desc limit ?`,
      )
      .all(`%${likeEscape(q)}%`, n) as any[];
    if (!rows.length)
      return `${envelope(meta, deferred)}\nno person matches "${q}" — try a shorter substring, or call find_person with no query to scan the roster.`;
    header = `${rows.length} people match "${q}"`;
  } else {
    rows = db
      .prepare(
        'select handle,mri,name,msg_count,last_ts from people order by msg_count desc limit ?',
      )
      .all(n) as any[];
    header = `roster — top ${rows.length} by volume`;
  }
  const selfMri = (meta as any).selfMri as string | null;
  const lines = rows.map((r) => {
    const tags = `${isBotMri(r.mri) ? ' [bot]' : ''}${selfMri && r.mri === selfMri ? ' (you)' : ''}`;
    return `${r.handle} "${r.name || '(unknown)'}"${tags} · ${r.msg_count} msg · last ${fmtTs(r.last_ts)}`;
  });
  return `${envelope(meta, deferred, header)}\n${lines.join('\n')}`;
}
