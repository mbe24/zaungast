// POC DuckDB backend — builds INDEPENDENTLY (no SQLite reuse). It consumes the engine-agnostic seam:
// `shapeBaseTables` (shared shaped rows) + `deriveTables` (shared pure-JS people/conversation aggregates,
// the dialect-free equivalent of SQLite's recompute), materializes them into DuckDB with explicit DDL,
// and answers the same four example queries the SQLite path does — proving the query/analytics layer
// ports to a genuinely different engine. Search has no FTS5 → the same content-LIKE fallback the library
// uses when FTS is off; topics reuses the pure JS scorer over DuckDB-returned rows.
import {
  computeTopicRows,
  computeTopicsWindow,
  deriveTables,
  makePhraseExtractor,
  type BaseTables,
  type Topic,
} from 'libzaungast/web';
import type { DuckDbConn } from './duckdb-wasm-driver.ts';

type PhaseHook = (phase: 'apply' | 'recompute', ms: number) => void;

// The facade-result shapes the POC's renderResult reads (a subset — only the fields it renders).
export interface DuckConv {
  handle: string;
  kind: string;
  msgCount: number;
  topic: string | null;
  participantNames: string | null;
}
export interface DuckPerson {
  handle: string;
  name: string;
  isBot: boolean;
  msgCount: number;
}
export type DuckSearch =
  | { ok: true; rows: { senderName: string; content: string }[]; order: 'time' }
  | { ok: false; reason: { reason: string } };
export type DuckTopics = { ok: true; rows: Topic[] } | { ok: false; reason: { reason: string } };

export interface DuckDbStore {
  conversations(n: number): Promise<DuckConv[]>;
  people(n: number): Promise<{ total: number; rows: DuckPerson[] }>;
  search(query: string, limit: number): Promise<DuckSearch>;
  topics(windowKey: string, n: number): Promise<DuckTopics>;
}

const num = (v: unknown): number => (typeof v === 'bigint' ? Number(v) : Number(v ?? 0));
const isBotMri = (mri: unknown) => typeof mri === 'string' && mri.startsWith('28:');
const likeLiteral = (q: string) => `'%${q.replace(/'/g, "''")}%'`;

// Load rows into a DuckDB table with an EXPLICIT column schema (avoids read_json_auto mistyping null-only
// columns). registerFileText ships the JSON as a virtual file; read_json with a `columns` spec types it.
async function loadTable(
  conn: DuckDbConn,
  name: string,
  rows: Record<string, unknown>[],
  columns: Record<string, string>,
): Promise<void> {
  await conn.registerFileText(`${name}.json`, JSON.stringify(rows));
  const colspec = Object.entries(columns)
    .map(([c, t]) => `${c}: '${t}'`)
    .join(', ');
  await conn.run(
    `create or replace table ${name} as ` +
      `select * from read_json('${name}.json', format='array', columns={${colspec}})`,
  );
}

// Materialize the shared base tables into DuckDB and derive (people + conversation aggregates) IN JS via
// the shared deriveTables, so the phases mirror SQLite: `apply` = load the base rows, `recompute` =
// derive + load the derived tables. (No FTS here → the caller reports `fts N/A`.)
export async function buildDuckDbStore(
  base: BaseTables,
  conn: DuckDbConn,
  opts: { onPhase?: PhaseHook } = {},
): Promise<DuckDbStore> {
  // apply: load the shaped base messages (only the columns the demo queries need).
  const tApply = performance.now();
  await loadTable(
    conn,
    'messages',
    base.messages.map((m) => ({
      conv_id: m.convId,
      id: m.id,
      ts: m.ts,
      sender_mri: m.senderMri,
      sender_name: m.senderName,
      is_system: m.isSystem,
      content: m.content,
    })),
    {
      conv_id: 'VARCHAR',
      id: 'VARCHAR',
      ts: 'BIGINT',
      sender_mri: 'VARCHAR',
      sender_name: 'VARCHAR',
      is_system: 'INTEGER',
      content: 'VARCHAR',
    },
  );
  opts.onPhase?.('apply', performance.now() - tApply);

  // recompute: derive (shared pure-JS, == SQLite's recompute) then load the derived tables.
  const tRec = performance.now();
  const derived = deriveTables(base);
  await loadTable(
    conn,
    'conversations',
    derived.conversations.map((c) => ({
      handle: c.handle,
      kind: c.kind,
      topic: c.topic,
      participant_names: c.participantNames,
      msg_count: c.msgCount,
      last_ts: c.lastTs,
    })),
    {
      handle: 'VARCHAR',
      kind: 'VARCHAR',
      topic: 'VARCHAR',
      participant_names: 'VARCHAR',
      msg_count: 'BIGINT',
      last_ts: 'BIGINT',
    },
  );
  await loadTable(
    conn,
    'people',
    derived.people.map((p) => ({
      handle: p.handle,
      name: p.name,
      mri: p.mri,
      msg_count: p.msgCount,
    })),
    { handle: 'VARCHAR', name: 'VARCHAR', mri: 'VARCHAR', msg_count: 'BIGINT' },
  );
  opts.onPhase?.('recompute', performance.now() - tRec);

  return {
    async conversations(n) {
      const rows = await conn.query<Record<string, unknown>>(
        `select handle, kind, msg_count, topic, participant_names
         from conversations where msg_count > 0 order by last_ts desc limit ${n | 0}`,
      );
      return rows.map((r) => ({
        handle: String(r.handle ?? ''),
        kind: String(r.kind ?? ''),
        msgCount: num(r.msg_count),
        topic: (r.topic as string) ?? null,
        participantNames: (r.participant_names as string) ?? null,
      }));
    },

    async people(n) {
      const [{ c } = { c: 0 }] = await conn.query<{ c: number | bigint }>(
        'select count(*) c from people',
      );
      const rows = await conn.query<Record<string, unknown>>(
        `select handle, name, mri, msg_count from people order by msg_count desc limit ${n | 0}`,
      );
      return {
        total: num(c),
        rows: rows.map((r) => ({
          handle: String(r.handle ?? ''),
          name: String(r.name ?? ''),
          isBot: isBotMri(r.mri),
          msgCount: num(r.msg_count),
        })),
      };
    },

    async search(query, limit) {
      const q = String(query ?? '').trim();
      if (!q) return { ok: false, reason: { reason: 'empty query' } };
      const rows = await conn.query<Record<string, unknown>>(
        `select sender_name, content from messages
         where is_system = 0 and content like ${likeLiteral(q)}
         order by ts desc limit ${limit | 0}`,
      );
      return {
        ok: true,
        order: 'time',
        rows: rows.map((r) => ({
          senderName: String(r.sender_name ?? ''),
          content: String(r.content ?? ''),
        })),
      };
    },

    async topics(windowKey, n) {
      const nameRows = await conn.query<{ name: unknown }>('select name from people');
      const nameTokens = new Set<string>();
      for (const r of nameRows)
        for (const w of String(r.name ?? '')
          .toLowerCase()
          .match(/[\p{L}\p{M}]{3,}/gu) ?? [])
          nameTokens.add(w);
      const { phrases } = makePhraseExtractor(nameTokens);

      const raw = await conn.query<Record<string, unknown>>(
        `select ts, sender_mri, content from messages where is_system = 0 and content <> ''`,
      );
      const all = raw
        .filter((r) => !isBotMri(r.sender_mri))
        .map((r) => ({
          ts: num(r.ts),
          senderMri: String(r.sender_mri ?? ''),
          content: String(r.content ?? ''),
        }));
      if (!all.length) return { ok: false, reason: { reason: 'no messages' } };

      const { sinceTs, untilTs } = computeTopicsWindow(all, { explicit: false, windowKey });
      const { rows } = computeTopicRows(all, phrases, { sinceTs, untilTs, minSenders: 2, n });
      return { ok: true, rows };
    },
  };
}
