// Library-side structured query layer (the future libzaungast public data API — B1 of the
// format-api-reshape / library-extraction plan). These functions return typed, engine-agnostic
// rows over the in-memory ChatStore; the MCP layer (tools.ts) renders them into token-economical
// text. The split is being done incrementally, one tool at a time, each proven byte-identical by
// the G2 MCP-output golden. Nothing here knows about MCP, agents, or token budgets.
import type { ChatStore } from './ingest/store.js';

// escape LIKE wildcards in user input (used with `escape '\'`). Query-side helper.
export function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (m) => '\\' + m);
}

// ---------- people ----------
export interface PersonRow {
  handle: string;
  mri: string;
  name: string;
  msgCount: number;
  lastTs: number;
}
export interface PeopleResult {
  mode: 'handle' | 'search' | 'roster'; // how the query resolved (drives the renderer's header)
  query: string; // the trimmed query, '' for roster
  rows: PersonRow[];
}

const toPersonRow = (r: any): PersonRow => ({
  handle: r.handle,
  mri: r.mri,
  name: r.name,
  msgCount: r.msg_count,
  lastTs: r.last_ts,
});

// find_person's data: a p:handle lookup, a name substring search, or the volume-ranked roster.
export function queryPeople(
  store: ChatStore,
  opts: { query?: string; n?: number } = {},
): PeopleResult {
  const db = store.db;
  const n = Math.min(Number(opts.n) || 8, 25);
  const q = opts.query ? String(opts.query).trim() : '';
  const cols = 'handle,mri,name,msg_count,last_ts';
  if (q.startsWith('p:')) {
    const rows = (db.prepare(`select ${cols} from people where handle=?`).all(q) as any[]).map(
      toPersonRow,
    );
    return { mode: 'handle', query: q, rows };
  }
  if (q) {
    const rows = (
      db
        .prepare(
          String.raw`select ${cols} from people where name like ? escape '\' order by msg_count desc limit ?`,
        )
        .all(`%${likeEscape(q)}%`, n) as any[]
    ).map(toPersonRow);
    return { mode: 'search', query: q, rows };
  }
  const rows = (
    db.prepare(`select ${cols} from people order by msg_count desc limit ?`).all(n) as any[]
  ).map(toPersonRow);
  return { mode: 'roster', query: '', rows };
}
