import { isBotMri, type ChatStore, type StoreMeta } from 'libzaungast/ingest/store.js';
import { byCodeUnit } from 'libzaungast/util/sort.js';
import { reactionGlyph } from './util/emoji.js';
import { htmlToText } from 'libzaungast/util/text.js';
import {
  likeEscape,
  queryPeople,
  queryCalls,
  queryConversations,
  queryEvents,
  maxEventStart,
} from 'libzaungast/query.js';
import {
  loadTopicsInScope,
  computeTopicRows,
  convIdsFor,
  querySearch,
  queryConversationMessages,
  queryThread,
  queryThreadSummaries,
  convMessageStats,
  buildPhraseExtractor,
  computeTopicsWindow,
} from 'libzaungast/query.js';
import type { EventView, TopicView, QueryMiss } from 'libzaungast/query.js';
import type {
  ListConversationsArgs,
  ReadMessagesArgs,
  SearchArgs,
  TopTopicsArgs,
  FindPersonArgs,
  ListEventsArgs,
  ListCallsArgs,
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
  // Sign-aware relative offset: '-7d' (past, the original/only direction) or '+7d' (future —
  // needed for list_events' forward-looking default window). ISO/epoch handling unchanged.
  const rel = /^([+-])(\d+)([dhm])$/.exec(s.trim());
  if (rel) {
    const sign = rel[1] === '-' ? -1 : 1;
    const n = +rel[2];
    const u = rel[3];
    const subDayMs = u === 'h' ? 36e5 : 6e4;
    return now + sign * n * (u === 'd' ? 864e5 : subDayMs);
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : t;
}
// Reject unparseable time filters loudly instead of silently ignoring them.
function badTime(args: any, keys: string[]): string | null {
  for (const k of keys)
    if (args[k] != null && parseTime(args[k]) === undefined)
      return `error: cannot parse ${k}="${args[k]}" — use ISO (2026-07-01) or relative (-7d / +7d / -24h / -30m)`;
  return null;
}
// ftsMatch now lives in ./query.js (imported above).
// Truncate with an ellipsis marker so the agent can tell a message was cut.
function clip(s: string, n: number): string {
  s = (s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// likeEscape now lives in the query layer (./query.js) and is imported above.

// ---------- resolvers (name/handle → ids) ----------
// The resolvers (convIdsFor/senderFilter/resolveExcludes) + the fallible query cores now live in
// ./query.js. The presentation below turns their structured results (QueryMiss reasons, resolved
// ids, coverage spans) into the agent-facing note/error text — the library emits no prose.

// Map a library QueryMiss to its user-facing message (the exact strings the scope-builders used to
// return inline).
function describeMiss(m: QueryMiss): string {
  switch (m.reason) {
    case 'no-such-sender':
      return `no person matches ${m.value}`;
    case 'no-such-conversation':
      return `no conversation matches "${m.value}"`;
    case 'no-such-excluded-conversation':
      return `exclude: no conversation ${m.value}`;
    case 'no-such-excluded-person':
      return `exclude: no person ${m.value}`;
  }
}

// A `from:` name-substring (not a p:handle) that matches >1 person → non-blocking narrowing note.
function fromAmbiguityNote(db: DB, from: string): string {
  if (from.startsWith('p:')) return '';
  const ppl = db
    .prepare(
      String.raw`select handle,name from people where name like ? escape '\' order by msg_count desc`,
    )
    .all(`%${likeEscape(from)}%`) as any[];
  if (ppl.length <= 1) return '';
  return `note: from:"${from}" matched ${ppl.length} people (${ppl
    .slice(0, 4)
    .map((p) => `${p.handle} ${p.name}`)
    .join(', ')}) — pass a p:handle to narrow`;
}

// Render the cache-horizon note from querySearch's coverage span. `hi===0` means the scope holds no
// cached messages at all. Claims only what the cache knows ("newest cached"), never "quiet".
function coverageNoteText(hi: number, lo: number): string {
  if (!hi) return 'no cached messages in this scope';
  return `newest cached in this scope: ${fmtTs(hi)} · oldest ${fmtTs(lo)} — local cache may lag the server`;
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

// list_conversations = render(queryConversations(...)).
export function listConversations(
  store: ChatStore,
  meta: StoreMeta,
  deferred: boolean,
  args: ListConversationsArgs = {},
): string {
  const bt = badTime(args, ['since']);
  if (bt) return bt;
  const rows = queryConversations(store, {
    n: args.n,
    kind: args.kind,
    query: args.query,
    participant: args.participant,
    sinceTs: parseTime(args.since),
    includeEmpty: args.include_empty,
  });
  const lines = rows.map((r) => {
    const title = r.topic || r.participantNames || '(untitled)';
    return `${r.handle} [${r.kind}] "${title}" · ${r.msgCount} msg · last ${fmtTs(r.lastTs)}`;
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

// queryMessageWindow (the flat/around row fetch) now lives in ./query.js (imported above).

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

// The account owner's own messages must NOT be labelled with a bare first-person token: to an
// LLM reading the transcript, `ME`/`I` resolves to its OWN voice, so it misattributes the owner's
// messages to itself. Label the owner by real name + a `(you)` marker instead — a named third
// party the agent can't confuse with itself, while `(you)` keeps the human's at-a-glance cue and
// (correctly, for a machine) binds to the agent's human principal, who IS the account owner.
// `ownerFallback` is only used for the degenerate case of an is_mine row with an empty sender_name.
function ownerLabel(senderName: string | null | undefined, ownerFallback: string | null): string {
  const nm = senderName || ownerFallback;
  return nm ? `${nm} (you)` : '(you)';
}

// The owner's canonical display name (for the fallback + the header legend), or null if it can't
// be resolved (owner never posted / no self MRI).
function ownerDisplayName(store: ChatStore, meta: StoreMeta): string | null {
  const selfMri = (meta as any).selfMri as string | null;
  return selfMri ? store.nameForMri(selfMri) : null;
}

// One-line header note that tells a machine reader what `(you)` means. Emitted only when the
// result actually contains owner-authored rows; empty when the owner name is unresolved.
function viewerLegend(name: string | null): string {
  return name ? `viewer: ${name} — "(you)" marks this account's owner, not the assistant` : '';
}

// Sender label: the owner as "<name> (you)", everyone else by display name.
function whoLabel(r: any, ownerFallback: string | null): string {
  return r.is_mine ? ownerLabel(r.sender_name, ownerFallback) : r.sender_name || '(unknown)';
}

// One rendered message at `indent`: `<indent><ts> <who>> <content><marks><suffix>`, plus an
// indented reaction line beneath it when reacted. `who` is precomputed (name / "<name> (you)" /
// "↳" burst mark); `suffix` (e.g. a thread tag) rides the text line, before any reaction line.
function msgText(r: any, who: string, indent: string, rx?: ReactionCtx, suffix = ''): string {
  const marks = (r.has_attach ? ' [attachment]' : '') + (r.mentions_me ? ' [@me]' : '');
  const line = `${indent}${fmtTs(r.ts)} ${who}> ${clip(r.content, 280)}${marks}${suffix}`;
  const rxLine = rx ? renderReactions(r.reactions, rx.store, rx.selfMri, rx.full) : '';
  return rxLine ? `${line}\n${indent}      ${rxLine}` : line;
}

// FLAT rendering (1:1/group, and non-threaded views): chronological, same-sender bursts within
// 15 min collapse to "↳". Unchanged behaviour.
function renderMessageLines(rows: any[], ownerFallback: string | null, rx?: ReactionCtx): string[] {
  let lastMri: string | null = null;
  let lastTs = 0;
  return rows.map((r) => {
    const collapsed = r.sender_mri === lastMri && r.ts - lastTs < 15 * 60_000;
    lastMri = r.sender_mri;
    lastTs = r.ts;
    const who = collapsed ? '  ↳' : whoLabel(r, ownerFallback);
    return msgText(r, who, '', rx);
  });
}

const REPLY_INDENT = '  ';

// THREADED rendering: a root at column 0, then its replies indented, same-sender bursts among the
// shown replies collapsing to "↳". `suffix` tags the root (e.g. "[thread m:… · N replies · …]");
// `preReplies` is an optional notice inserted between root and replies (e.g. "+N earlier · …");
// `hitId` marks one line with a "→" gutter (the search-pivot target).
function renderThread(
  root: any,
  replies: any[],
  ownerFallback: string | null,
  rx: ReactionCtx | undefined,
  opts: { suffix?: string; preReplies?: string; hitId?: string } = {},
): string[] {
  const mark = (r: any, base: string) =>
    (opts.hitId && String(r.id) === opts.hitId ? '→ ' : '') + base;
  const out: string[] = [
    msgText(root, mark(root, whoLabel(root, ownerFallback)), '', rx, opts.suffix),
  ];
  if (opts.preReplies) out.push(`${REPLY_INDENT}${opts.preReplies}`);
  let lastMri: string | null = null;
  let lastTs = 0;
  for (const r of replies) {
    const collapsed = r.sender_mri === lastMri && r.ts - lastTs < 15 * 60_000;
    lastMri = r.sender_mri;
    lastTs = r.ts;
    const who = mark(r, collapsed ? '↳' : whoLabel(r, ownerFallback));
    out.push(msgText(r, who, REPLY_INDENT, rx));
  }
  return out;
}

// Split a thread's ts-ordered rows into { root, replies } (root = the id===root_id message).
function splitThread(rows: any[], rootId: string): { root: any; replies: any[] } {
  const root = rows.find((r) => String(r.id) === rootId) ?? rows[0];
  return { root, replies: rows.filter((r) => r !== root) };
}

// Show both local bounds so a caller knows the cache slice — "newest local" flags when the
// local cache lags the server (its most recent cached message may be days old).
// ---------- channel (reply-chain) rendering ----------
const THREAD_INLINE_MAX = 40; // a thread this size or smaller renders whole in thread mode
const THREAD_WINDOW = 30; // else this many replies per page

function channelHead(conv: any, extra: string): string {
  return `${conv.handle} [channel] "${conv.topic || conv.participant_names}" · ${extra}`;
}

// One thread in the DIGEST: root always in full; ≤5-message threads show every reply (no marker);
// ≥6 show root + last 3 + a "+N earlier · read_messages(thread: m:…)" drill-in. A zero-reply thread
// is a bare root line (no thread tag). `rows` are the thread's non-system messages, ts-ascending.
function renderDigestThread(
  rows: any[],
  rootId: string,
  ownerNm: string | null,
  rx: ReactionCtx,
): string[] {
  const { root, replies } = splitThread(rows, rootId);
  const rootMissing = String(root.id) !== rootId;
  const nReplies = replies.length;
  const last = fmtTs(rows[rows.length - 1].ts);
  const suffix = nReplies
    ? `  [thread m:${rootId} · ${nReplies} ${nReplies === 1 ? 'reply' : 'replies'} · last ${last}]`
    : '';
  const missNote = rootMissing ? `[root m:${rootId} not in local cache]` : undefined;
  if (rows.length <= 5)
    return renderThread(root, replies, ownerNm, rx, { suffix, preReplies: missNote });
  const shown = replies.slice(-3);
  const pre = `+${nReplies - shown.length} earlier · read_messages(thread: m:${rootId})`;
  return renderThread(root, shown, ownerNm, rx, {
    suffix,
    preReplies: missNote ? `${missNote}  ${pre}` : pre,
  });
}

// Default channel view: threads grouped by reply-chain, ordered by last activity (newest at the
// bottom), size-gated, filled to a message budget (`limit`). Pages threads via the older: cursor.
function renderChannelDigest(
  store: ChatStore,
  meta: StoreMeta,
  deferred: boolean,
  conv: any,
  convId: string,
  args: ReadMessagesArgs,
  limit: number,
  since: number | undefined,
  until: number | undefined,
  ownerNm: string | null,
  rx: ReactionCtx,
): string {
  const db = store.db;
  // thread summaries (in-window activity decides which threads appear)
  let summaries = queryThreadSummaries(store, convId, { sinceTs: since, untilTs: until });
  const threadTotal = summaries.length;
  const older = args.cursor && /^older:(\d+):(.+)$/.exec(String(args.cursor));
  if (older) {
    const ots = Number(older[1]);
    const oid = older[2];
    summaries = summaries.filter(
      (s) => s.last < ots || (s.last === ots && String(s.root_id) < oid),
    );
  }
  // newest-active first for budget filling; ties broken by root_id descending (stable)
  summaries.sort((a, b) => b.last - a.last || (String(a.root_id) < String(b.root_id) ? 1 : -1));
  const shownPer = (n: number) => (n <= 5 ? n : 4); // root + last 3
  const picked: any[] = [];
  let budget = 0;
  for (const s of summaries) {
    const cost = shownPer(s.n);
    if (picked.length && budget + cost > limit) break;
    picked.push(s);
    budget += cost;
    if (budget >= limit) break;
  }
  // display oldest-active first so the most-recently-active thread sits at the bottom
  const blocks = [...picked].reverse().map((s) => {
    const rows = queryThread(db, convId, s.root_id);
    return renderDigestThread(rows, String(s.root_id), ownerNm, rx).join('\n');
  });
  const oldestShown = picked[picked.length - 1];
  const olderCur =
    summaries.length > picked.length && oldestShown
      ? ` · older: older:${oldestShown.last}:${oldestShown.root_id}`
      : '';
  const { total, earliest, newest } = convMessageStats(db, convId);
  const head = channelHead(
    conv,
    `${total} msgs / ${threadTotal} threads · showing ${picked.length} threads, ${budget} msgs · threads by last activity · local cache ${fmtTs(earliest)}–${fmtTs(newest)}${olderCur}`,
  );
  const body = blocks.join('\n\n') || '(no threads)';
  const legend = /\(you\)>/.test(body) ? viewerLegend(ownerNm) : '';
  return `${[envelope(meta, deferred), head, legend].filter(Boolean).join('\n')}\n${body}`;
}

// A single reply-chain: thread mode (read it in full) and the around-pivot (center on a hit).
// Inlines the whole chain up to THREAD_INLINE_MAX; larger chains window (newest, or around the
// hit) and page backward with a keyset `more: before m:<id>` cursor.
function renderThreadView(
  store: ChatStore,
  meta: StoreMeta,
  deferred: boolean,
  conv: any,
  convId: string,
  rootId: string,
  args: ReadMessagesArgs,
  ownerNm: string | null,
  rx: ReactionCtx,
  hitId?: string,
): string {
  const db = store.db;
  const rows = queryThread(db, convId, rootId);
  if (!rows.length)
    return `${envelope(meta, deferred)}\nthread m:${rootId} not found in this conversation`;
  const { root, replies } = splitThread(rows, rootId);
  const rootMissing = String(root.id) !== rootId;
  const total = rows.length;

  const beforeM = args.cursor && /^before m:(.+)$/.exec(String(args.cursor));
  let shown: any[];
  let earlier = 0;
  if (hitId && total > THREAD_INLINE_MAX) {
    const idx = Math.max(
      0,
      replies.findIndex((r) => String(r.id) === hitId),
    );
    const start = Math.max(0, idx - Math.floor(THREAD_WINDOW / 2));
    shown = replies.slice(start, start + THREAD_WINDOW);
    earlier = start;
  } else if (beforeM) {
    const cutId = beforeM[1];
    const cut = replies.find((r) => String(r.id) === cutId);
    const cutTs = cut ? cut.ts : Infinity;
    const older = replies.filter((r) => r.ts < cutTs || (r.ts === cutTs && String(r.id) < cutId));
    shown = older.slice(-THREAD_WINDOW);
    earlier = older.length - shown.length;
  } else if (total > THREAD_INLINE_MAX) {
    shown = replies.slice(-THREAD_WINDOW);
    earlier = replies.length - shown.length;
  } else {
    shown = replies;
  }

  const more = earlier > 0 && shown.length > 0;
  const preParts: string[] = [];
  if (rootMissing) preParts.push(`[root m:${rootId} not in local cache]`);
  if (more) preParts.push(`… +${earlier} earlier · more: before m:${shown[0].id}`);
  const lines = renderThread(root, shown, ownerNm, rx, {
    preReplies: preParts.join('  ') || undefined,
    hitId,
  });
  const status = more ? `more: before m:${shown[0].id}` : 'complete';
  const head = channelHead(
    conv,
    `thread m:${rootId}${hitId ? ` around m:${hitId}` : ''} · showing ${1 + shown.length}/${total} · ${status}`,
  );
  const legend = rows.some((r) => r.is_mine) ? viewerLegend(ownerNm) : '';
  return `${[envelope(meta, deferred), head, legend].filter(Boolean).join('\n')}\n${lines.join('\n')}`;
}

// Dispatch a channel read: a specific thread, an around-pivot (→ the hit's thread), or the digest.
function renderChannel(
  store: ChatStore,
  meta: StoreMeta,
  deferred: boolean,
  conv: any,
  convId: string,
  args: ReadMessagesArgs,
  limit: number,
  since: number | undefined,
  until: number | undefined,
  ownerNm: string | null,
  rx: ReactionCtx,
): string {
  if (args.thread) {
    const rootId = String(args.thread).replace(/^m:/, '');
    return renderThreadView(store, meta, deferred, conv, convId, rootId, args, ownerNm, rx);
  }
  if (args.around) {
    const aid = String(args.around).replace(/^m:/, '');
    const arow = store.db
      .prepare('select root_id from messages where conv_id=? and id=?')
      .get(convId, aid) as any;
    if (!arow)
      return `${envelope(meta, deferred)}\nmessage m:${aid} not found in this conversation`;
    return renderThreadView(
      store,
      meta,
      deferred,
      conv,
      convId,
      String(arow.root_id),
      args,
      ownerNm,
      rx,
      aid,
    );
  }
  return renderChannelDigest(
    store,
    meta,
    deferred,
    conv,
    convId,
    args,
    limit,
    since,
    until,
    ownerNm,
    rx,
  );
}

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
  const since = parseTime(args.since);
  const until = parseTime(args.until);
  const conv = db
    .prepare('select handle,kind,topic,participant_names from conversations where id=?')
    .get(id) as any;
  const ownerNm = ownerDisplayName(store, meta);
  const rx: ReactionCtx = {
    store,
    selfMri: (meta as any).selfMri as string | null,
    full: String(args.reactions) === 'full',
  };
  // Channels render by reply-chain (thread digest / a single thread / an around-pivot); everything
  // else (1:1, group, meeting) stays flat and chronological.
  if (conv?.kind === 'channel')
    return renderChannel(store, meta, deferred, conv, id, args, limit, since, until, ownerNm, rx);

  const fetched = queryConversationMessages(store, id, {
    sinceTs: since,
    untilTs: until,
    cursor: args.cursor != null ? String(args.cursor) : undefined,
    around: args.around != null ? String(args.around) : undefined,
    limit,
  });
  if ('aroundNotFound' in fetched)
    return `message ${fetched.aroundNotFound} not found in this conversation`;
  const rows = fetched.rows;

  const { total, earliest, newest } = convMessageStats(db, id);
  // Only offer an older: cursor when there really are older messages (else the agent pages into nothing).
  const oldest = rows[0];
  const olderCursor = oldest && oldest.ts > earliest ? `older:${oldest.ts}:${oldest.id}` : '';
  const head = buildReadMessagesHead(conv, rows.length, total, earliest, newest, olderCursor);
  const lines = renderMessageLines(rows, ownerNm, rx);
  // Emit the (you)-legend only when owner-authored rows are actually shown (else it's dead weight).
  const legend = rows.some((r: any) => r.is_mine) ? viewerLegend(ownerNm) : '';
  const out = [envelope(meta, deferred), head, legend].filter(Boolean).join('\n');
  return `${out}\n${lines.join('\n') || '(no messages)'}`;
}

// The search scope-building + query + coverage-trigger now live in query.querySearch; this file
// renders its result (notes/legend/lines) below.

// Build the per-hit lines and the (optional) conversation legend, resolving conv_id → handle
// once per distinct conversation (memoized).
function buildSearchResults(
  db: DB,
  rows: any[],
  ownerFallback: string | null,
): { lines: string[]; legend: string } {
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
  const lines = rows.map((r) => {
    const label = r.is_mine ? ownerLabel(r.sender_name, ownerFallback) : r.sender_name;
    return `${hn(r.conv_id)} ${fmtTs(r.ts)} m:${r.id} ${label}> ${clip(r.snip, 140)}`;
  });
  return { lines, legend };
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
  const res = querySearch(store, {
    query: args.query,
    from: args.from != null ? String(args.from) : undefined,
    in: args.in != null ? String(args.in) : undefined,
    kind: args.kind,
    mentionsMe: args.mentions_me,
    hasAttachment: args.has_attachment,
    exclude: args.exclude,
    sinceTs: parseTime(args.since),
    untilTs: parseTime(args.until),
    limit,
    ftsEnabled: meta.ftsEnabled,
  });
  if (!res.ok) return describeMiss(res.reason);
  const { rows, order } = res;

  // Non-blocking narrowing notes: from:-substring ambiguity, then in:-substring ambiguity (the
  // library resolved `in` → res.inIds; the note text is presentation).
  const notes: string[] = [];
  if (args.from != null) {
    const fn = fromAmbiguityNote(db, String(args.from));
    if (fn) notes.push(fn);
  }
  if (args.in != null && res.inIds) {
    const an = convAmbiguityNote(db, String(args.in), res.inIds);
    if (an) notes.push(an);
  }

  const ownerNm = ownerDisplayName(store, meta);
  const { lines, legend } = buildSearchResults(db, rows, ownerNm);
  const coverage = res.coverage ? coverageNoteText(res.coverage.hi, res.coverage.lo) : '';
  // Owner-label legend, only when a hit is owner-authored (search interleaves conversations, so
  // the (you) rows can be scattered — the legend matters here at least as much as in read_messages).
  const vlegend = rows.some((r: any) => r.is_mine) ? viewerLegend(ownerNm) : '';

  const head = [
    envelope(meta, deferred, `order:${order} · ${rows.length} hits`),
    ...notes,
    vlegend,
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
// buildPhraseExtractor now lives in ./query.js (imported above).

// The topics scope-building + message load now live in query.loadTopicsInScope (P4: a
// conversation/person scope matching nothing is a miss, never a whole-DB fall-through). The MCP
// keeps the phrase extractor, window/row computation, and the note/label text below.

// Window: explicit since/until (arbitrary range) overrides the enum window. Baseline is always
// the messages BEFORE the window ("new vs history") — never after — so a topic that persists
// past the window isn't penalised. The default window anchors to the newest message actually IN
// SCOPE (`all`), not wall-clock "now".
// computeTopicsWindow (window policy) now lives in ./query.js; the MCP layer computes `explicit`
// from arg presence and parses since/until before calling it.

// computeTopicRows moved to ./query.js (imported above).

function renderTopicRows(rows: TopicView[]): string[] {
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

  const scoped = loadTopicsInScope(store, {
    scope: args.scope != null ? String(args.scope) : undefined,
    exclude: args.exclude,
    includeBots: args.include_bots,
  });
  if (!scoped.ok) return describeMiss(scoped.reason);
  const { all, botExcluded, minSenders, excludeWords, scopeConvIds } = scoped;

  const phrases = buildPhraseExtractor(store, db, new Set(excludeWords));
  if (!all.length) return `${envelope(meta, deferred)}\n(no messages in scope)`;

  // scope-conversation ambiguity note (parallel to search's in: note) — kept first in `notes`, as
  // the old buildTopicsScope emitted it during scope resolution.
  const notes: string[] = [];
  if (args.scope != null && String(args.scope).startsWith('conversation:') && scopeConvIds) {
    const amb = convAmbiguityNote(db, String(args.scope).slice(13), scopeConvIds);
    if (amb) notes.push(amb.replace('in:', 'scope conversation:'));
  }

  const explicit = args.since != null || args.until != null;
  const { sinceTs, untilTs } = computeTopicsWindow(all, {
    explicit,
    sinceTs: parseTime(args.since),
    untilTs: parseTime(args.until),
    windowKey: args.window,
  });
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

// find_person = render(queryPeople(...)). The library returns typed PersonRows + how the query
// resolved; this MCP renderer owns the header/line/legend text and the token layout.
export function findPerson(
  store: ChatStore,
  meta: StoreMeta,
  deferred: boolean,
  args: FindPersonArgs = {},
): string {
  const res = queryPeople(store, { query: args.query, n: args.n });
  if (res.mode === 'handle' && !res.rows.length)
    return `${envelope(meta, deferred)}\nno person with handle ${res.query}`;
  if (res.mode === 'search' && !res.rows.length)
    return `${envelope(meta, deferred)}\nno person matches "${res.query}" — try a shorter substring, or call find_person with no query to scan the roster.`;
  const header =
    res.mode === 'handle'
      ? 'profile'
      : res.mode === 'search'
        ? `${res.rows.length} people match "${res.query}"`
        : `roster — top ${res.rows.length} by volume`;
  const selfMri = (meta as any).selfMri as string | null;
  const lines = res.rows.map((r) => {
    const tags = `${isBotMri(r.mri) ? ' [bot]' : ''}${selfMri && r.mri === selfMri ? ' (you)' : ''}`;
    return `${r.handle} "${r.name || '(unknown)'}"${tags} · ${r.msgCount} msg · last ${fmtTs(r.lastTs)}`;
  });
  return `${envelope(meta, deferred, header)}\n${lines.join('\n')}`;
}

// ================= list_events / list_calls =================

// `07-16 10:00` — same MM-DD HH:mm shape as fmtTs but WITHOUT the year prefix (a time range's
// second half never needs one) and without the seconds; used for the `–HH:mm` end half below.
function hm(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function eventTimeRange(startTs: number, endTs: number, isAllDay: boolean): string {
  if (isAllDay) return `${fmtTs(startTs).split(' ')[0]} (all day)`;
  const startLabel = fmtTs(startTs);
  return endTs > startTs ? `${startLabel}–${hm(endTs)}` : startLabel;
}

interface AttendeeRow {
  n: string;
  e: string;
  r: string;
}
// Cap attendees exactly like reactions: total + accepted tally, plus ≤3 names + `+K` overflow —
// large meetings carry 100+ attendees inline and must never be dumped raw.
function renderAttendees(attendeesJson: string | null | undefined): string {
  if (!attendeesJson) return 'no attendees';
  let atts: AttendeeRow[];
  try {
    atts = JSON.parse(attendeesJson);
  } catch {
    return 'no attendees';
  }
  if (!Array.isArray(atts) || atts.length === 0) return 'no attendees';
  const total = atts.length;
  const accepted = atts.filter((a) => /^accepted$/i.test(a.r)).length;
  const names = atts.map((a) => a.n).filter(Boolean);
  const shown = names.slice(0, 3);
  const extra = total - shown.length;
  const namesPart = shown.length ? `: ${shown.join(', ')}${extra > 0 ? ` +${extra}` : ''}` : '';
  return `${total} attendees (${accepted} accepted)${namesPart}`;
}

// Privacy: elide every URL in an (opt-in, already-htmlToText'd) event body down to its bare
// hostname — the full URL can carry tokens and is a prompt-injection surface (see spec §5).
function elideUrlsToHostnames(text: string): string {
  return text.replace(/https?:\/\/([^\s/]+)(\/[^\s]*)?/gi, (_m, host) => `[link: ${host}]`);
}

// EventView now lives in ./query.js (imported above).

// One event row, fully rendered (subject/org/attendees/response/chat-pivot/tags).
function renderEventLine(db: DB, r: EventView): string {
  const tags =
    (r.is_cancelled ? ' [cancelled]' : '') +
    (r.is_confidential ? ' [confidential]' : '') +
    (r.has_attach ? ' [attachment]' : '');
  const timeRange = eventTimeRange(r.start_ts, r.end_ts, !!r.is_all_day);
  const org = r.organizer_name ? `org: ${r.organizer_name}` : 'org: (unknown)';
  const attendees = renderAttendees(r.attendees);
  const you = r.my_response ? `you: ${r.my_response}` : '';
  let chat = '';
  if (r.kind === 'meeting') {
    const conv = r.cid
      ? (db.prepare('select handle from conversations where id=?').get(r.cid) as any)
      : null;
    chat = `chat ${conv ? conv.handle : '(no cached chat)'}`;
  }
  const parts = [org, attendees, you, chat].filter(Boolean);
  return `${timeRange} [${r.kind}]${tags} "${r.subject || '(no subject)'}" · ${parts.join(' · ')}`;
}

// Recurrence run-collapse: rows sharing a series_id, in the window, beyond the first 2 collapse
// to one summary line (the chat handle prints once — on the fully-rendered first occurrence).
function renderEventGroups(db: DB, rows: EventView[]): string[] {
  // Group by series_id, preserving each row's relative chronological position (rows arrive
  // pre-sorted by start_ts asc, so a group's array is automatically in series order too).
  const bySeries = new Map<string, EventView[]>();
  for (const r of rows) {
    if (!r.series_id) continue;
    const g = bySeries.get(r.series_id);
    if (g) g.push(r);
    else bySeries.set(r.series_id, [r]);
  }

  const collapsedHandled = new Set<string>();
  const lines: string[] = [];
  for (const r of rows) {
    if (r.series_id) {
      const group = bySeries.get(r.series_id)!;
      if (group.length > 2) {
        if (collapsedHandled.has(r.series_id)) continue; // already summarized
        collapsedHandled.add(r.series_id);
        lines.push(renderEventLine(db, r));
        const rest = group.length - 1;
        const next = group[1];
        lines.push(
          `  ↻ ${r.subject || '(no subject)'} ×${rest} more (next ${fmtTs(next.start_ts)})`,
        );
        continue;
      }
    }
    lines.push(renderEventLine(db, r));
  }
  return lines;
}

export function listEvents(
  store: ChatStore,
  meta: StoreMeta,
  deferred: boolean,
  args: ListEventsArgs = {},
): string {
  const bt = badTime(args, ['since', 'until']);
  if (bt) return bt;
  const now = Date.now();
  const sinceArg = parseTime(args.since);
  const untilArg = parseTime(args.until);
  const noWindowGiven = sinceArg == null && untilArg == null;
  // Forward default window: today..+7d — a calendar tool defaults to what's COMING UP, unlike
  // messages tools which default to recent history. (Window policy stays MCP-side.)
  const winSince = sinceArg ?? (noWindowGiven ? now : undefined);
  const winUntil = untilArg ?? (noWindowGiven ? now + 7 * 864e5 : undefined);

  const rows = queryEvents(store, {
    sinceTs: winSince,
    untilTs: winUntil,
    type: args.type,
    query: args.query,
    attendee: args.attendee,
    hideCancelled: args.hide_cancelled,
    limit: args.limit,
  });
  const db = store.db;

  const notes: string[] = [];
  // The cache only holds MATERIALIZED occurrences of a recurring series — a far-future window
  // can under-report even though nothing is actually missing from the source. Compare the
  // effective window end against the newest occurrence the cache has for ANY event (not just
  // this query's matches), since that's the honest bound on what could possibly be materialized.
  if (winUntil != null) {
    const maxStart = maxEventStart(store);
    if (winUntil > maxStart)
      notes.push(
        `note: window extends past the newest cached occurrence (${fmtTs(maxStart)}) — the cache only holds materialized occurrences; recurring events further out may be under-reported`,
      );
  }

  // include_body: opt-in, narrow-result-only, and never for a confidential event (regardless of
  // the arg) — see spec §5. Rendered as an extra indented line beneath the one matching event.
  let bodyBlock = '';
  if (args.include_body) {
    if (rows.length !== 1)
      notes.push(
        `note: include_body ignored — narrow the query to a single event (add query:/since/until) to see its body`,
      );
    else if (rows[0].is_confidential)
      notes.push(`note: include_body ignored — this event is [confidential]`);
    else if (rows[0].body_html) {
      const text = elideUrlsToHostnames(htmlToText(rows[0].body_html));
      bodyBlock = `\n  body: ${clip(text, 1000)}`;
    }
  }

  const lines = renderEventGroups(db, rows);
  const head = [envelope(meta, deferred, `${rows.length} events`), ...notes]
    .filter(Boolean)
    .join('\n');
  return `${head}\n${(lines.join('\n') || '(no events)') + bodyBlock}`;
}

// `14m`, `1h02m`, `0s` — humanized call duration.
function humanizeDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${pad(m % 60)}m`;
}

// The recording/transcript pointer resolved into a `read_messages`-ready pivot: the announcement
// message's conversation handle + id. Skips gracefully (returns '') if unresolvable — the
// conversation may not be cached, or the JSON may be malformed.
function renderRecordingPivot(db: DB, recordingLinkJson: string | null | undefined): string {
  if (!recordingLinkJson) return '';
  let link: { conversationId?: string; linkedMessageId?: string };
  try {
    link = JSON.parse(recordingLinkJson);
  } catch {
    return '';
  }
  if (!link.conversationId || !link.linkedMessageId) return '';
  const conv = db
    .prepare('select handle from conversations where id=?')
    .get(link.conversationId) as any;
  if (!conv) return '';
  return ` recorded → ${conv.handle} m:${link.linkedMessageId}`;
}

// list_calls = render(queryCalls(...)). Library resolves + filters + limits the rows; this
// renderer owns arg validation and the arrow/tail/tags/pivot layout.
export function listCalls(
  store: ChatStore,
  meta: StoreMeta,
  deferred: boolean,
  args: ListCallsArgs = {},
): string {
  const bt = badTime(args, ['since', 'until']);
  if (bt) return bt;
  const rows = queryCalls(store, {
    direction: args.direction,
    missed: args.missed,
    sinceTs: parseTime(args.since),
    untilTs: parseTime(args.until),
    participant: args.participant,
    limit: args.limit,
  });
  const db = store.db;
  const lines = rows.map((r) => {
    const arrow = r.direction === 'Incoming' ? '←' : r.direction === 'Outgoing' ? '→' : '?';
    const tail = r.isMissed
      ? 'missed'
      : `${humanizeDuration(r.durationMs)} · ${(r.state || '?').toLowerCase()}`;
    const tags =
      (r.hasRecording ? ' [recorded]' : '') +
      (r.hasVoicemail ? ' [voicemail]' : '') +
      (r.spamLevel && !/^none$/i.test(r.spamLevel) ? ' [spam?]' : '') +
      (r.isCurrentUserPart === 0 ? ' [not-you]' : '');
    const pivot = renderRecordingPivot(db, r.recordingLink);
    return `${fmtTs(r.startTs)} ${arrow} ${r.label} · ${tail}${tags}${pivot}`;
  });
  const head = envelope(meta, deferred, `${rows.length} calls`);
  return `${head}\n${lines.join('\n') || '(no calls)'}`;
}
