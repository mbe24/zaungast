import type { SearchHit, Conversation } from 'libzaungast';
import type { SearchArgs } from '../schemas.js';
import { searchShape } from '../schemas.js';
import type { QueryTool, RenderCtx } from './types.js';
import type { View } from './shared.js';
import {
  HISTORY_NOTE,
  YOU_NOTE,
  badTime,
  clip,
  convAmbiguityNote,
  describeMiss,
  envelope,
  fmtTs,
  ownerDisplayName,
  ownerLabel,
  parseTime,
  viewerLegend,
} from './shared.js';

// A `from:` name-substring (not a p:handle) that matches >1 person → non-blocking narrowing note.
// `people.find` returns the FULL match total plus the volume-ranked sample rows.
function fromAmbiguityNote(view: View, from: string): string {
  if (from.startsWith('p:')) return '';
  const res = view.people.find({ query: from });
  if (res.total <= 1) return '';
  return `note: from:"${from}" matched ${res.total} people (${res.rows
    .slice(0, 4)
    .map((p) => `${p.handle} ${p.name}`)
    .join(', ')}) — pass a p:handle to narrow`;
}

// Render the cache-horizon note from querySearch's coverage span. `hi===0` means the scope holds no
// cached messages at all. Claims only what the cache knows ("newest cached"), never "quiet".
function coverageNoteText(hi: number, lo: number, ctx?: RenderCtx): string {
  if (!hi) return 'no cached messages in this scope';
  return `newest cached in this scope: ${fmtTs(hi, ctx)} · oldest ${fmtTs(lo, ctx)} — local cache may lag the server`;
}

// Build the per-hit lines and the (optional) conversation legend, resolving conv id → view once per
// distinct conversation (memoized; the in-memory point get is ~free).
function buildSearchResults(
  view: View,
  rows: SearchHit[],
  ownerFallback: string | null,
  ctx?: RenderCtx,
): { lines: string[]; legend: string } {
  const cache = new Map<string, Conversation | null>();
  const conv = (cid: string): Conversation | null => {
    if (!cache.has(cid)) cache.set(cid, view.conversations.get(cid));
    return cache.get(cid)!;
  };
  const hn = (cid: string) => conv(cid)?.handle ?? '?';
  const distinct = [...new Set(rows.map((r) => r.convId))];
  const legend =
    distinct.length <= 5
      ? distinct
          .map((cid) => {
            const c = conv(cid);
            return `${hn(cid)}="${c?.topic || c?.participantNames || '?'}"`;
          })
          .join(' · ')
      : '';
  const lines = rows.map((r) => {
    const label = r.isMine ? ownerLabel(r.senderName, ownerFallback) : r.senderName;
    return `${hn(r.convId)} ${fmtTs(r.ts, ctx)} m:${r.id} ${label}> ${clip(r.snippet, 140)}`;
  });
  return { lines, legend };
}

export function search(view: View, args: SearchArgs = {}, ctx?: RenderCtx): string {
  const bt = badTime(args, ['since', 'until'], ctx);
  if (bt) return bt;
  const limit = Math.min(Number(args.limit) || 20, 60);
  const res = view.messages.search({
    query: args.query,
    from: args.from != null ? String(args.from) : undefined,
    in: args.in != null ? String(args.in) : undefined,
    kind: args.kind,
    mentionsMe: args.mentions_me,
    hasAttachment: args.has_attachment,
    exclude: args.exclude,
    sinceTs: parseTime(args.since, ctx),
    untilTs: parseTime(args.until, ctx),
    limit,
  });
  if (!res.ok) return describeMiss(res.reason);
  const { rows, order } = res;

  // Non-blocking narrowing notes: from:-substring ambiguity, then in:-substring ambiguity (the
  // library resolved `in` → res.inIds; the note text is presentation).
  const notes: string[] = [];
  if (args.from != null) {
    const fn = fromAmbiguityNote(view, String(args.from));
    if (fn) notes.push(fn);
  }
  if (args.in != null && res.inIds) {
    const an = convAmbiguityNote(view, String(args.in));
    if (an) notes.push(an);
  }

  const ownerNm = ownerDisplayName(view);
  const { lines, legend } = buildSearchResults(view, rows, ownerNm, ctx);
  const coverage = res.coverage ? coverageNoteText(res.coverage.hi, res.coverage.lo, ctx) : '';
  // Owner-label legend, only when a hit is owner-authored (search interleaves conversations, so
  // the (you) rows can be scattered — the legend matters here at least as much as in read_conversation).
  const vlegend = rows.some((r) => r.isMine) ? viewerLegend(ownerNm) : '';

  const head = [
    envelope(view, ctx, `order:${order} · ${rows.length} hits`),
    ...notes,
    vlegend,
    legend,
    coverage,
  ]
    .filter(Boolean)
    .join('\n');
  return `${head}\n${lines.join('\n') || '(no matches)'}`;
}

export const searchTool: QueryTool = {
  kind: 'query',
  name: 'search',
  title: 'Search messages',
  description: `Full-text search across all messages with filters. Empty query = filtered browse. from/in accept display-name / title substrings or handles. mentions_me finds messages that @mention you. ${YOU_NOTE} ${HISTORY_NOTE}`,
  inputSchema: searchShape,
  run: search,
};
