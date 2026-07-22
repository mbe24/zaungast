import type { FindPersonArgs } from '../schemas.js';
import { findPersonShape } from '../schemas.js';
import type { QueryTool, RenderCtx } from './types.js';
import type { View } from './shared.js';
import { envelope, fmtTs } from './shared.js';

// find_person = render(people.find(...)). The library returns typed PersonViews + how the query
// resolved; this MCP renderer owns the header/line/legend text and the token layout.
export function findPerson(view: View, args: FindPersonArgs = {}, ctx?: RenderCtx): string {
  const res = view.people.find({ query: args.query, n: args.n });
  if (res.mode === 'handle' && !res.rows.length)
    return `${envelope(view, ctx)}\nno person with handle ${res.query}`;
  if (res.mode === 'search' && !res.rows.length)
    return `${envelope(view, ctx)}\nno person matches "${res.query}" — try a shorter substring, or call find_person with no query to scan the roster.`;
  const header =
    res.mode === 'handle'
      ? 'profile'
      : res.mode === 'search'
        ? `${res.rows.length} people match "${res.query}"`
        : `roster — top ${res.rows.length} by volume`;
  const selfMri = view.meta.selfMri;
  const lines = res.rows.map((r) => {
    const tags = `${r.isBot ? ' [bot]' : ''}${selfMri && r.mri === selfMri ? ' (you)' : ''}`;
    return `${r.handle} "${r.name || '(unknown)'}"${tags} · ${r.msgCount} msg · last ${fmtTs(r.lastTs, ctx)}`;
  });
  return `${envelope(view, ctx, header)}\n${lines.join('\n')}`;
}

export const findPersonTool: QueryTool = {
  kind: 'query',
  name: 'find_person',
  title: 'Find a person',
  description: `Resolve a name/nickname fragment to a person's canonical name and stable p:handle, with message count and last-contact time. Use when a name is ambiguous or unrecognized, or when you need contact stats or a p:handle. For ordinary filtering, just pass a name substring directly to search (from/in) or read_conversation (conversation) — don't call this first. Omit query to scan the roster (most-talked-to first).`,
  inputSchema: findPersonShape,
  run: findPerson,
};
