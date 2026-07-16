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

// ---------- calls ----------
export interface CallRow {
  startTs: number;
  direction: string | null;
  isMissed: number;
  durationMs: number;
  state: string | null;
  hasRecording: number;
  hasVoicemail: number;
  spamLevel: string | null;
  isCurrentUserPart: number;
  recordingLink: string | null;
  label: string; // resolved counterpart name / group topic+handle
}

// list_calls' data: filtered, resolved, limited call rows (newest first). Time bounds arrive
// already parsed (sinceTs/untilTs epoch ms); arg validation/parsing stays in the MCP layer.
export function queryCalls(
  store: ChatStore,
  opts: {
    direction?: string;
    missed?: boolean;
    sinceTs?: number;
    untilTs?: number;
    participant?: string;
    limit?: number;
  } = {},
): CallRow[] {
  const db = store.db;
  const limit = Math.min(Number(opts.limit) || 30, 100);
  const where: string[] = ['is_deleted=0']; // filtered out by default
  const params: any[] = [];
  if (opts.direction) {
    where.push('direction=?');
    params.push(opts.direction);
  }
  if (opts.missed) where.push('is_missed=1');
  if (opts.sinceTs != null) {
    where.push('start_ts>=?');
    params.push(opts.sinceTs);
  }
  if (opts.untilTs != null) {
    where.push('start_ts<?');
    params.push(opts.untilTs);
  }
  const rowsAll = db
    .prepare(`select * from calls where ${where.join(' and ')} order by start_ts desc`)
    .all(...params) as any[];

  // Resolve each call's display label in JS (the table is tiny; this is what lets `participant`
  // filter on the RESOLVED name — TwoParty target.displayName is often null in the raw data).
  const resolved = rowsAll.map((r) => {
    let label: string;
    if (r.call_type === 'MultiParty') {
      const conv = r.group_thread_id
        ? (db
            .prepare('select handle,topic,participant_names from conversations where id=?')
            .get(r.group_thread_id) as any)
        : null;
      label = conv
        ? `${conv.topic || conv.participant_names || '(group)'} ${conv.handle}`
        : '(group call)';
    } else {
      label = (r.counterpart_mri && store.nameForMri(r.counterpart_mri)) || '(unknown)';
    }
    return { r, label };
  });
  const filtered = opts.participant
    ? resolved.filter((x) =>
        x.label.toLowerCase().includes(String(opts.participant).toLowerCase()),
      )
    : resolved;
  return filtered.slice(0, limit).map(({ r, label }) => ({
    startTs: r.start_ts,
    direction: r.direction,
    isMissed: r.is_missed,
    durationMs: r.duration_ms,
    state: r.state,
    hasRecording: r.has_recording,
    hasVoicemail: r.has_voicemail,
    spamLevel: r.spam_level,
    isCurrentUserPart: r.is_current_user_part,
    recordingLink: r.recording_link,
    label,
  }));
}
