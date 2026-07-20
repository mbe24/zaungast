import type { GetMessageArgs } from '../schemas.js';
import { getMessageShape } from '../schemas.js';
import type { QueryTool } from './types.js';
import type { View } from './shared.js';
import {
  HISTORY_NOTE,
  YOU_NOTE,
  envelope,
  fmtTs,
  ownerDisplayName,
  viewerLegend,
} from './shared.js';
import { renderReactions, resolveConversationArg, whoLabel } from './readConversation.js';

// get_message = render(messages.get(convId, id)) at FULL width. Sibling of read_conversation: that tool
// BROWSES (clipped, paged by message); this one READS ONE message end-to-end (untruncated,
// newline-preserving body, paged by CHARACTER via offset for a pathologically long body).
const CHUNK = 4000;

export function getMessage(view: View, args: GetMessageArgs = {} as GetMessageArgs): string {
  if (!args.conversation) return 'error: conversation (handle or title substring) is required';
  if (!args.message) return 'error: message (the m:… id from a search hit) is required';
  const resolved = resolveConversationArg(view, String(args.conversation));
  if ('early' in resolved) return resolved.early;
  const convId = resolved.id;
  const id = String(args.message).replace(/^m:/, '');
  const row = view.messages.get(convId, id);
  if (!row) return `${envelope(view)}\nmessage m:${id} not found in this conversation`;

  const conv = view.conversations.get(convId)!;
  const ownerNm = ownerDisplayName(view);

  const content = row.content ?? '';
  const total = content.length;
  const offset = Math.max(0, Number(args.offset) || 0);
  const slice = content.slice(offset, offset + CHUNK);
  const end = offset + slice.length;

  const label = conv.topic || conv.participantNames;
  const window =
    total === 0
      ? '(no body)'
      : offset >= total
        ? `full body · offset ${offset} is past end (length ${total})`
        : `full body · chars ${offset}..${end}/${total}`;
  const head = `${conv.handle} [${conv.kind}] "${label}" · m:${id} · ${window}`;

  const marks = (row.hasAttachment ? ' [attachment]' : '') + (row.mentionsMe ? ' [@me]' : '');
  const body = total === 0 ? '(no message body)' : slice;
  const cont = end < total ? `\n… +${total - end} chars · get_message(offset:${end})` : '';
  const msgLine = `${fmtTs(row.ts)} ${whoLabel(row, ownerNm)}> ${body}${marks}${cont}`;

  const rxLine = renderReactions(row.reactions, view, view.meta.selfMri, true);
  const pivot =
    row.rootId && String(row.rootId) !== id
      ? `in thread m:${row.rootId} · read_thread(thread: m:${row.rootId})`
      : '';
  const legend = row.isMine ? viewerLegend(ownerNm) : '';

  return [envelope(view), head, msgLine, rxLine, pivot, legend].filter(Boolean).join('\n');
}

export const getMessageTool: QueryTool = {
  kind: 'query',
  name: 'get_message',
  title: 'Read one message in full',
  description: `Fetch ONE message in full — its complete, untruncated body (line breaks preserved) plus reactions. Target it by conversation (c:xxxx or title/participant substring) PLUS message:m:<id> (the m:… from a search hit or a thread root). Page a very long body with offset:. Use read_conversation to BROWSE a conversation; use this to READ one message end-to-end. ${YOU_NOTE} ${HISTORY_NOTE}`,
  inputSchema: getMessageShape,
  run: getMessage,
};
