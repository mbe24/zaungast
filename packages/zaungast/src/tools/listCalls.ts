import type { ListCallsArgs } from '../schemas.js';
import { listCallsShape } from '../schemas.js';
import type { QueryTool } from './types.js';
import type { View } from './shared.js';
import { HISTORY_NOTE, badTime, envelope, fmtTs, pad, parseTime } from './shared.js';

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
function renderRecordingPivot(view: View, recordingLinkJson: string | null | undefined): string {
  if (!recordingLinkJson) return '';
  let link: { conversationId?: string; linkedMessageId?: string };
  try {
    link = JSON.parse(recordingLinkJson);
  } catch {
    return '';
  }
  if (!link.conversationId || !link.linkedMessageId) return '';
  const conv = view.conversations.get(link.conversationId);
  if (!conv) return '';
  return ` recorded → ${conv.handle} m:${link.linkedMessageId}`;
}

// list_calls = render(calls.list(...)). Library resolves + filters + limits the rows; this
// renderer owns arg validation and the arrow/tail/tags/pivot layout.
export function listCalls(view: View, args: ListCallsArgs = {}): string {
  const bt = badTime(args, ['since', 'until']);
  if (bt) return bt;
  const rows = view.calls.list({
    direction: args.direction,
    missed: args.missed,
    sinceTs: parseTime(args.since),
    untilTs: parseTime(args.until),
    participant: args.participant,
    limit: args.limit,
  });
  const lines = rows.map((r) => {
    const arrow = r.direction === 'Incoming' ? '←' : r.direction === 'Outgoing' ? '→' : '?';
    const tail = r.isMissed
      ? 'missed'
      : `${humanizeDuration(r.durationMs)} · ${(r.state || '?').toLowerCase()}`;
    const tags =
      (r.hasRecording ? ' [recorded]' : '') +
      (r.hasVoicemail ? ' [voicemail]' : '') +
      (r.spamLevel && !/^none$/i.test(r.spamLevel) ? ' [spam?]' : '') +
      (!r.isCurrentUserPart ? ' [not-you]' : '');
    const pivot = renderRecordingPivot(view, r.recordingLink);
    return `${fmtTs(r.startTs)} ${arrow} ${r.label} · ${tail}${tags}${pivot}`;
  });
  const head = envelope(view, `${rows.length} calls`);
  return `${head}\n${lines.join('\n') || '(no calls)'}`;
}

export const listCallsTool: QueryTool = {
  kind: 'query',
  name: 'list_calls',
  title: 'List call history',
  description: `Your call log: who called whom, when, and for how long. direction:Outgoing|Incoming, missed:true for the callState=Missed subset, participant filters by resolved counterpart/group name. Deleted calls are filtered out. Tags recorded/voicemail/spam calls and pivots a recording to the chat message that announced it (read_messages around:) when cached. ${HISTORY_NOTE}`,
  inputSchema: listCallsShape,
  run: listCalls,
};
