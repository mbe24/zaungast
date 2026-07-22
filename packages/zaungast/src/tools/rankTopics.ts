import type { Topic } from 'libzaungast';
import type { RankTopicsArgs } from '../schemas.js';
import { rankTopicsShape } from '../schemas.js';
import type { QueryTool, RenderCtx } from './types.js';
import type { View } from './shared.js';
import {
  HISTORY_NOTE,
  badTime,
  clip,
  convAmbiguityNote,
  describeMiss,
  envelope,
  fmtTs,
  parseTime,
} from './shared.js';

function renderTopicRows(rows: Topic[], ctx?: RenderCtx): string[] {
  return rows.map(
    (r, i) =>
      `${i + 1}. "${r.phrase}" ×${r.count} (${r.lift.toFixed(1)}× baseline) · ${r.senderCount} people\n   e.g. ${fmtTs(r.example.ts, ctx)}: ${clip(r.example.content, 90)}`,
  );
}

export function rankTopics(view: View, args: RankTopicsArgs = {}, ctx?: RenderCtx): string {
  const bt = badTime(args, ['since', 'until'], ctx);
  if (bt) return bt;

  const res = view.topics.compute({
    scope: args.scope != null ? String(args.scope) : undefined,
    exclude: args.exclude,
    includeBots: args.include_bots,
    window: args.window,
    sinceTs: parseTime(args.since, ctx),
    untilTs: parseTime(args.until, ctx),
    n: args.n,
  });
  if (!res.ok) return describeMiss(res.reason);
  if (res.scopeTotal === 0) return `${envelope(view, ctx)}\n(no messages in scope)`;

  // scope-conversation ambiguity note (parallel to search's in: note) — kept first in `notes`, as
  // the old buildTopicsScope emitted it during scope resolution.
  const notes: string[] = [];
  if (args.scope != null && String(args.scope).startsWith('conversation:') && res.scopeConvIds) {
    const amb = convAmbiguityNote(view, String(args.scope).slice(13));
    if (amb) notes.push(amb.replace('in:', 'scope conversation:'));
  }

  if (res.botExcluded)
    notes.push(`excluded ${res.botExcluded} bot/app msgs · include_bots:true to include`);
  if (res.baseTotal < 30)
    notes.push(`baseline sparse (${res.baseTotal} msgs) — ×baseline is approximate`);
  const explicit = args.since != null || args.until != null;
  const untilLabel =
    res.window.untilTs === Number.MAX_SAFE_INTEGER ? 'now' : fmtTs(res.window.untilTs, ctx);
  const windowLabel = explicit
    ? `range ${fmtTs(res.window.sinceTs, ctx)}..${untilLabel}`
    : `window ${args.window || '7d'}`;
  const lines = renderTopicRows(res.rows, ctx);
  const head = [envelope(view, ctx, `${windowLabel} · ${res.windowCount} msgs`), ...notes].join(
    '\n',
  );
  return `${head}\n${lines.join('\n') || '(no distinctive topics)'}`;
}

export const rankTopicsTool: QueryTool = {
  kind: 'query',
  name: 'rank_topics',
  title: 'Rank trending topics',
  description: `Rank the distinctive/trending topics over a window (vs your baseline), overall or scoped to a person/conversation. Returns each topic with an exemplar message. ${HISTORY_NOTE}`,
  inputSchema: rankTopicsShape,
  run: rankTopics,
};
