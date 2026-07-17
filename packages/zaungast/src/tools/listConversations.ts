import type { ListConversationsArgs } from '../schemas.js';
import { listConversationsShape } from '../schemas.js';
import type { QueryTool } from './types.js';
import type { View } from './shared.js';
import { HISTORY_NOTE, badTime, envelope, fmtTs, parseTime } from './shared.js';

// list_conversations = render(conversations.list(...)).
export function listConversations(view: View, args: ListConversationsArgs = {}): string {
  const bt = badTime(args, ['since']);
  if (bt) return bt;
  const rows = view.conversations.list({
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
  return `${envelope(view, extra)}\n${lines.join('\n') || '(none)'}`;
}

export const listConversationsTool: QueryTool = {
  kind: 'query',
  name: 'list_conversations',
  title: 'List conversations',
  description: `Your Teams sidebar: the newest N conversations (default), or filter by kind/participant/title/time. ${HISTORY_NOTE}`,
  inputSchema: listConversationsShape,
  run: listConversations,
};
