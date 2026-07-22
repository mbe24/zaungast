import { htmlToText } from 'libzaungast';
import type { CalendarEvent, Attendee } from 'libzaungast';
import type { ListEventsArgs } from '../schemas.js';
import { listEventsShape } from '../schemas.js';
import type { QueryTool, RenderCtx } from './types.js';
import type { View } from './shared.js';
import { HISTORY_NOTE, badTime, clip, envelope, fmtHm, fmtTs, parseTime } from './shared.js';

function eventTimeRange(
  startTs: number,
  endTs: number,
  isAllDay: boolean,
  ctx?: RenderCtx,
): string {
  if (isAllDay) return `${fmtTs(startTs, ctx).split(' ')[0]} (all day)`;
  const startLabel = fmtTs(startTs, ctx);
  return endTs > startTs ? `${startLabel}–${fmtHm(endTs, ctx)}` : startLabel;
}

// Cap attendees exactly like reactions: total + accepted tally, plus ≤3 names + `+K` overflow —
// large meetings carry 100+ attendees inline and must never be dumped raw. The library already
// parsed CalendarEvent.attendees into typed Attendee[].
function renderAttendees(atts: Attendee[]): string {
  if (atts.length === 0) return 'no attendees';
  const total = atts.length;
  const accepted = atts.filter((a) => /^accepted$/i.test(a.response)).length;
  const names = atts.map((a) => a.name).filter(Boolean);
  const shown = names.slice(0, 3);
  const extra = total - shown.length;
  const namesPart = shown.length ? `: ${shown.join(', ')}${extra > 0 ? ` +${extra}` : ''}` : '';
  return `${total} attendees (${accepted} accepted)${namesPart}`;
}

// Privacy: elide every URL in an (opt-in, already-htmlToText'd) event body down to its bare
// hostname — the full URL can carry tokens and is a prompt-injection surface.
function elideUrlsToHostnames(text: string): string {
  return text.replace(/https?:\/\/([^\s/]+)(\/[^\s]*)?/gi, (_m, host) => `[link: ${host}]`);
}

// One event row, fully rendered (subject/org/attendees/response/chat-pivot/tags).
function renderEventLine(view: View, r: CalendarEvent, ctx?: RenderCtx): string {
  const tags =
    (r.isCancelled ? ' [cancelled]' : '') +
    (r.isConfidential ? ' [confidential]' : '') +
    (r.hasAttachment ? ' [attachment]' : '');
  const timeRange = eventTimeRange(r.startTs, r.endTs, !!r.isAllDay, ctx);
  const org = r.organizerName ? `org: ${r.organizerName}` : 'org: (unknown)';
  const attendees = renderAttendees(r.attendees);
  const you = r.myResponse ? `you: ${r.myResponse}` : '';
  let chat = '';
  if (r.kind === 'meeting') {
    const conv = r.cid ? view.conversations.get(r.cid) : null;
    chat = `chat ${conv ? conv.handle : '(no cached chat)'}`;
  }
  const parts = [org, attendees, you, chat].filter(Boolean);
  return `${timeRange} [${r.kind}]${tags} "${r.subject || '(no subject)'}" · ${parts.join(' · ')}`;
}

// Recurrence run-collapse: rows sharing a series_id, in the window, beyond the first 2 collapse
// to one summary line (the chat handle prints once — on the fully-rendered first occurrence).
function renderEventGroups(view: View, rows: CalendarEvent[], ctx?: RenderCtx): string[] {
  // Group by series_id, preserving each row's relative chronological position (rows arrive
  // pre-sorted by start_ts asc, so a group's array is automatically in series order too).
  const bySeries = new Map<string, CalendarEvent[]>();
  for (const r of rows) {
    if (!r.seriesId) continue;
    const g = bySeries.get(r.seriesId);
    if (g) g.push(r);
    else bySeries.set(r.seriesId, [r]);
  }

  const collapsedHandled = new Set<string>();
  const lines: string[] = [];
  for (const r of rows) {
    if (r.seriesId) {
      const group = bySeries.get(r.seriesId)!;
      if (group.length > 2) {
        if (collapsedHandled.has(r.seriesId)) continue; // already summarized
        collapsedHandled.add(r.seriesId);
        lines.push(renderEventLine(view, r, ctx));
        const rest = group.length - 1;
        const next = group[1];
        lines.push(
          `  ↻ ${r.subject || '(no subject)'} ×${rest} more (next ${fmtTs(next.startTs, ctx)})`,
        );
        continue;
      }
    }
    lines.push(renderEventLine(view, r, ctx));
  }
  return lines;
}

export function listEvents(view: View, args: ListEventsArgs = {}, ctx?: RenderCtx): string {
  const bt = badTime(args, ['since', 'until'], ctx);
  if (bt) return bt;
  const now = ctx?.now ?? Date.now();
  const sinceArg = parseTime(args.since, ctx);
  const untilArg = parseTime(args.until, ctx);
  const noWindowGiven = sinceArg == null && untilArg == null;
  // Forward default window: today..+7d — a calendar tool defaults to what's COMING UP, unlike
  // messages tools which default to recent history. (Window policy stays MCP-side.)
  const winSince = sinceArg ?? (noWindowGiven ? now : undefined);
  const winUntil = untilArg ?? (noWindowGiven ? now + 7 * 864e5 : undefined);

  const rows = view.events.list({
    sinceTs: winSince,
    untilTs: winUntil,
    type: args.type,
    query: args.query,
    attendee: args.attendee,
    hideCancelled: args.hide_cancelled,
    limit: args.limit,
  });

  const notes: string[] = [];
  // The cache only holds MATERIALIZED occurrences of a recurring series — a far-future window
  // can under-report even though nothing is actually missing from the source. Compare the
  // effective window end against the newest occurrence the cache has for ANY event (not just
  // this query's matches), since that's the honest bound on what could possibly be materialized.
  if (winUntil != null) {
    const maxStart = view.events.maxStart();
    if (winUntil > maxStart)
      notes.push(
        `note: window extends past the newest cached occurrence (${fmtTs(maxStart, ctx)}) — the cache only holds materialized occurrences; recurring events further out may be under-reported`,
      );
  }

  // include_body: opt-in, narrow-result-only, and never for a confidential event (regardless of
  // the arg). Rendered as an extra indented line beneath the one matching event.
  let bodyBlock = '';
  if (args.include_body) {
    if (rows.length !== 1)
      notes.push(
        `note: include_body ignored — narrow the query to a single event (add query:/since/until) to see its body`,
      );
    else if (rows[0].isConfidential)
      notes.push(`note: include_body ignored — this event is [confidential]`);
    else if (rows[0].bodyHtml) {
      const text = elideUrlsToHostnames(htmlToText(rows[0].bodyHtml));
      bodyBlock = `\n  body: ${clip(text, 1000)}`;
    }
  }

  const lines = renderEventGroups(view, rows, ctx);
  const head = [envelope(view, ctx, `${rows.length} events`), ...notes].filter(Boolean).join('\n');
  return `${head}\n${(lines.join('\n') || '(no events)') + bodyBlock}`;
}

export const listEventsTool: QueryTool = {
  kind: 'query',
  name: 'list_events',
  title: 'List calendar events',
  description: `Your calendar: meetings and appointments, defaulting to a FORWARD window (today..+7d — pass since/until to look elsewhere). type:meeting|appointment|all; query/attendee filter by substring. Metadata by default (attendee names/response tallies, no join URLs — those are never stored); include_body only works on a single narrowed-down event and stays off for [confidential] events regardless. ${HISTORY_NOTE}`,
  inputSchema: listEventsShape,
  run: listEvents,
};
