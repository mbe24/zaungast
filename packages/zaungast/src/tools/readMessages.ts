import { reactionGlyph } from '../util/emoji.js';
import { byCodeUnit } from '../util/sort.js';
import type {
  MessageView,
  ReactionGroup,
  ConversationView,
  ThreadSummary,
} from 'libzaungast';
import type { ReadMessagesArgs } from '../schemas.js';
import { readMessagesShape } from '../schemas.js';
import type { QueryTool } from './types.js';
import type { View } from './shared.js';
import {
  HISTORY_NOTE,
  YOU_NOTE,
  badTime,
  clip,
  describeMiss,
  envelope,
  fmtTs,
  ownerDisplayName,
  ownerLabel,
  parseTime,
  viewerLegend,
} from './shared.js';

// Resolve a `conversation` selector (handle or title/participant substring) to a single
// conversation id, or an early-return string (ambiguous-picker text, or a "no match" message)
// when it can't unambiguously resolve. `conversations.resolve` returns candidate views newest-first.
function resolveConversationArg(
  view: View,
  conversation: string,
): { id: string } | { early: string } {
  const cands = view.conversations.resolve(conversation);
  if (!cands.length) return { early: `no conversation matches "${conversation}"` };
  if (cands.length > 1 && !conversation.startsWith('c:')) {
    return {
      early:
        `ambiguous — ${cands.length} conversations match. Pick a handle:\n` +
        cands
          .slice(0, 8)
          .map((c) => `  ${c.handle} [${c.kind}] ${c.topic || c.participantNames}`)
          .join('\n'),
    };
  }
  return { id: cands[0].id };
}

// Reaction summary for one message. Two-level cap, tuned against real data (see plan/vision.md
// #6): emoji groups sorted by reactor-count desc; groups 1–3 are NAMED (≤3 names, you-first then
// most-recent, per-group `+K` overflow), groups 4–5 show glyph+count only, group 6+ collapses to
// `+N more` (N = remaining reactor count, so the histogram total stays honest). `full` drops all
// caps and names everyone — for "did person X react?". Returns '' when there are no reactions.
function renderReactions(
  reactions: ReactionGroup[],
  view: View,
  selfMri: string | null,
  full: boolean,
): string {
  if (!reactions.length) return '';
  const nameOf = (mri: string): string =>
    mri === selfMri ? 'you' : view.people.nameFor(mri) || '(unknown)';
  // Order reactors within a group: you first, then most-recent by reaction time.
  const orderedNames = (users: ReactionGroup['users']): string[] => {
    const sorted = users.slice().sort((a, b) => {
      const aSelf = a.mri === selfMri,
        bSelf = b.mri === selfMri;
      if (aSelf !== bSelf) return aSelf ? -1 : 1;
      return b.time - a.time;
    });
    return sorted.map((x) => nameOf(x.mri));
  };
  // Order emoji groups: most reactors first; ties broken by earliest reaction, then key.
  const ranked = reactions
    .map((g) => ({
      g,
      count: g.users.length,
      min: Math.min(...g.users.map((x) => x.time || Infinity)),
    }))
    .sort((a, b) => b.count - a.count || a.min - b.min || byCodeUnit(a.g.key, b.g.key));

  const parts: string[] = [];
  let tail = 0;
  ranked.forEach(({ g, count }, i) => {
    const glyph = reactionGlyph(g.key);
    if (full) {
      parts.push(`${glyph} ${count} · ${orderedNames(g.users).join(', ')}`);
    } else if (i < 3) {
      const names = orderedNames(g.users).slice(0, 3);
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
  view: View;
  selfMri: string | null;
  full: boolean;
}

// Sender label: the owner as "<name> (you)", everyone else by display name.
function whoLabel(r: MessageView, ownerFallback: string | null): string {
  return r.isMine ? ownerLabel(r.senderName, ownerFallback) : r.senderName || '(unknown)';
}

// One rendered message at `indent`: `<indent><ts> <who>> <content><marks><suffix>`, plus an
// indented reaction line beneath it when reacted. `who` is precomputed (name / "<name> (you)" /
// "↳" burst mark); `suffix` (e.g. a thread tag) rides the text line, before any reaction line.
function msgText(
  r: MessageView,
  who: string,
  indent: string,
  rx?: ReactionCtx,
  suffix = '',
): string {
  const marks = (r.hasAttachment ? ' [attachment]' : '') + (r.mentionsMe ? ' [@me]' : '');
  const line = `${indent}${fmtTs(r.ts)} ${who}> ${clip(r.content, 280)}${marks}${suffix}`;
  const rxLine = rx ? renderReactions(r.reactions, rx.view, rx.selfMri, rx.full) : '';
  return rxLine ? `${line}\n${indent}      ${rxLine}` : line;
}

// FLAT rendering (1:1/group, and non-threaded views): chronological, same-sender bursts within
// 15 min collapse to "↳". Unchanged behaviour.
function renderMessageLines(
  rows: MessageView[],
  ownerFallback: string | null,
  rx?: ReactionCtx,
): string[] {
  let lastMri: string | null = null;
  let lastTs = 0;
  return rows.map((r) => {
    const collapsed = r.senderMri === lastMri && r.ts - lastTs < 15 * 60_000;
    lastMri = r.senderMri;
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
  root: MessageView,
  replies: MessageView[],
  ownerFallback: string | null,
  rx: ReactionCtx | undefined,
  opts: { suffix?: string; preReplies?: string; hitId?: string } = {},
): string[] {
  const mark = (r: MessageView, base: string) =>
    (opts.hitId && String(r.id) === opts.hitId ? '→ ' : '') + base;
  const out: string[] = [
    msgText(root, mark(root, whoLabel(root, ownerFallback)), '', rx, opts.suffix),
  ];
  if (opts.preReplies) out.push(`${REPLY_INDENT}${opts.preReplies}`);
  let lastMri: string | null = null;
  let lastTs = 0;
  for (const r of replies) {
    const collapsed = r.senderMri === lastMri && r.ts - lastTs < 15 * 60_000;
    lastMri = r.senderMri;
    lastTs = r.ts;
    const who = mark(r, collapsed ? '↳' : whoLabel(r, ownerFallback));
    out.push(msgText(r, who, REPLY_INDENT, rx));
  }
  return out;
}

// Split a thread's ts-ordered rows into { root, replies } (root = the id===root_id message).
function splitThread(
  rows: MessageView[],
  rootId: string,
): { root: MessageView; replies: MessageView[] } {
  const root = rows.find((r) => String(r.id) === rootId) ?? rows[0];
  return { root, replies: rows.filter((r) => r !== root) };
}

// ---------- channel (reply-chain) rendering ----------
const THREAD_INLINE_MAX = 40; // a thread this size or smaller renders whole in thread mode
const THREAD_WINDOW = 30; // else this many replies per page

function channelHead(conv: ConversationView, extra: string): string {
  return `${conv.handle} [channel] "${conv.topic || conv.participantNames}" · ${extra}`;
}

// One thread in the DIGEST: root always in full; ≤5-message threads show every reply (no marker);
// ≥6 show root + last 3 + a "+N earlier · read_messages(thread: m:…)" drill-in. A zero-reply thread
// is a bare root line (no thread tag). `rows` are the thread's non-system messages, ts-ascending.
function renderDigestThread(
  rows: MessageView[],
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
  view: View,
  conv: ConversationView,
  convId: string,
  args: ReadMessagesArgs,
  limit: number,
  since: number | undefined,
  until: number | undefined,
  ownerNm: string | null,
  rx: ReactionCtx,
): string {
  // thread summaries (in-window activity decides which threads appear)
  let summaries: ThreadSummary[] = view.messages.threadSummaries(convId, {
    sinceTs: since,
    untilTs: until,
  });
  const threadTotal = summaries.length;
  const older = args.cursor && /^older:(\d+):(.+)$/.exec(String(args.cursor));
  if (older) {
    const ots = Number(older[1]);
    const oid = older[2];
    summaries = summaries.filter(
      (s) => s.lastTs < ots || (s.lastTs === ots && String(s.rootId) < oid),
    );
  }
  // newest-active first for budget filling; ties broken by root_id descending (stable)
  summaries.sort((a, b) => b.lastTs - a.lastTs || (String(a.rootId) < String(b.rootId) ? 1 : -1));
  const shownPer = (n: number) => (n <= 5 ? n : 4); // root + last 3
  const picked: ThreadSummary[] = [];
  let budget = 0;
  for (const s of summaries) {
    const cost = shownPer(s.count);
    if (picked.length && budget + cost > limit) break;
    picked.push(s);
    budget += cost;
    if (budget >= limit) break;
  }
  // display oldest-active first so the most-recently-active thread sits at the bottom
  const blocks = [...picked].reverse().map((s) => {
    const rows = view.messages.thread(convId, s.rootId);
    return renderDigestThread(rows, String(s.rootId), ownerNm, rx).join('\n');
  });
  const oldestShown = picked[picked.length - 1];
  const olderCur =
    summaries.length > picked.length && oldestShown
      ? ` · older: older:${oldestShown.lastTs}:${oldestShown.rootId}`
      : '';
  const { total, earliestTs, newestTs } = view.messages.stats(convId);
  const head = channelHead(
    conv,
    `${total} msgs / ${threadTotal} threads · showing ${picked.length} threads, ${budget} msgs · threads by last activity · local cache ${fmtTs(earliestTs)}–${fmtTs(newestTs)}${olderCur}`,
  );
  const body = blocks.join('\n\n') || '(no threads)';
  const legend = /\(you\)>/.test(body) ? viewerLegend(ownerNm) : '';
  return `${[envelope(view), head, legend].filter(Boolean).join('\n')}\n${body}`;
}

// A single reply-chain: thread mode (read it in full) and the around-pivot (center on a hit).
// Inlines the whole chain up to THREAD_INLINE_MAX; larger chains window (newest, or around the
// hit) and page backward with a keyset `more: before m:<id>` cursor.
function renderThreadView(
  view: View,
  conv: ConversationView,
  convId: string,
  rootId: string,
  args: ReadMessagesArgs,
  ownerNm: string | null,
  rx: ReactionCtx,
  hitId?: string,
): string {
  const rows = view.messages.thread(convId, rootId);
  if (!rows.length)
    return `${envelope(view)}\nthread m:${rootId} not found in this conversation`;
  const { root, replies } = splitThread(rows, rootId);
  const rootMissing = String(root.id) !== rootId;
  const total = rows.length;

  const beforeM = args.cursor && /^before m:(.+)$/.exec(String(args.cursor));
  let shown: MessageView[];
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
  const legend = rows.some((r) => r.isMine) ? viewerLegend(ownerNm) : '';
  return `${[envelope(view), head, legend].filter(Boolean).join('\n')}\n${lines.join('\n')}`;
}

// Dispatch a channel read: a specific thread, an around-pivot (→ the hit's thread), or the digest.
function renderChannel(
  view: View,
  conv: ConversationView,
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
    return renderThreadView(view, conv, convId, rootId, args, ownerNm, rx);
  }
  if (args.around) {
    const aid = String(args.around).replace(/^m:/, '');
    const arow = view.messages.get(convId, aid);
    if (!arow) return `${envelope(view)}\nmessage m:${aid} not found in this conversation`;
    return renderThreadView(view, conv, convId, String(arow.rootId), args, ownerNm, rx, aid);
  }
  return renderChannelDigest(view, conv, convId, args, limit, since, until, ownerNm, rx);
}

function buildReadMessagesHead(
  conv: ConversationView,
  shown: number,
  total: number,
  earliest: number,
  newest: number,
  olderCursor: string,
): string {
  const olderSuffix = olderCursor ? ` · older: ${olderCursor}` : '';
  return `${conv.handle} [${conv.kind}] "${conv.topic || conv.participantNames}" · showing ${shown}/${total} · local cache ${fmtTs(earliest)}–${fmtTs(newest)}${olderSuffix}`;
}

export function readMessages(view: View, args: ReadMessagesArgs = {} as ReadMessagesArgs): string {
  const bt = badTime(args, ['since', 'until']);
  if (bt) return bt;
  if (!args.conversation) return 'error: conversation (handle or title substring) is required';
  const resolved = resolveConversationArg(view, String(args.conversation));
  if ('early' in resolved) return resolved.early;
  const id = resolved.id;
  const limit = Math.min(Number(args.limit) || 40, 200);
  const since = parseTime(args.since);
  const until = parseTime(args.until);
  const conv = view.conversations.get(id)!;
  const ownerNm = ownerDisplayName(view);
  const rx: ReactionCtx = {
    view,
    selfMri: view.meta.selfMri,
    full: String(args.reactions) === 'full',
  };
  // Channels render by reply-chain (thread digest / a single thread / an around-pivot); everything
  // else (1:1, group, meeting) stays flat and chronological.
  if (conv.kind === 'channel')
    return renderChannel(view, conv, id, args, limit, since, until, ownerNm, rx);

  const res = view.messages.inConversation(id, {
    sinceTs: since,
    untilTs: until,
    cursor: args.cursor != null ? String(args.cursor) : undefined,
    around: args.around != null ? String(args.around) : undefined,
    limit,
  });
  if (!res.ok) return describeMiss(res.reason);
  const rows = res.rows;

  const { total, earliestTs, newestTs } = view.messages.stats(id);
  // The older: cursor is now the library's own keyset token (offered when the window filled).
  const olderCursor = res.nextOlder ?? '';
  const head = buildReadMessagesHead(conv, rows.length, total, earliestTs, newestTs, olderCursor);
  const lines = renderMessageLines(rows, ownerNm, rx);
  // Emit the (you)-legend only when owner-authored rows are actually shown (else it's dead weight).
  const legend = rows.some((r) => r.isMine) ? viewerLegend(ownerNm) : '';
  const out = [envelope(view), head, legend].filter(Boolean).join('\n');
  return `${out}\n${lines.join('\n') || '(no messages)'}`;
}

export const readMessagesTool: QueryTool = {
  kind: 'query',
  name: 'read_messages',
  title: 'Read a conversation',
  description: `Read one conversation's messages in STORY ORDER (oldest→newest). Target by handle (c:xxxx) or title/participant substring. Page back with the returned older: cursor, or center on a message with around:. CHANNELS are grouped by reply-thread (root + replies, newest-active last); pass thread:m:<root> to read one thread in full — the digest prints the exact drill-in call. ${YOU_NOTE} ${HISTORY_NOTE}`,
  inputSchema: readMessagesShape,
  run: readMessages,
};
