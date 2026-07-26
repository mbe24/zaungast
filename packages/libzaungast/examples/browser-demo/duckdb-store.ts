// POC-only DuckDB "store": proves libzaungast's schema + query/analytics layer isn't overfit to SQLite.
// It does NOT re-run the SQLite-specific store BUILDER (shaping, FTS, upserts) — that stays SQLite. It
// copies the already-built base tables out of the SQLite store (via TeamsStore.rawDb) into DuckDB and
// answers the same four example queries the POC renders, IN DuckDB — so a DuckDB path and a SQLite path
// share one renderer and produce matching output (conversations/people/topics identical; search differs
// because there's no FTS5 — it uses the same content-LIKE fallback the library uses when FTS is off).
// Topics reuses the PURE JS scorer (computeTopicRows) over DuckDB-returned rows — identical ranking,
// different engine. The DuckDB connection is injected so this is Node-testable (see the parity harness).
import {
  computeTopicRows,
  computeTopicsWindow,
  makeExtractor,
  type TeamsStore,
  type Topic,
} from 'libzaungast/web';
import type { DuckDbConn } from './duckdb-wasm-driver.ts';

// The facade-result shapes the POC's renderResult reads (a subset of the real facade types — only the
// fields it renders), so DuckDB and SQLite results render through the exact same code.
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

// DuckDB returns BigInt for integer columns (COUNT/BIGINT). Coerce for JS math + display.
const num = (v: unknown): number => (typeof v === 'bigint' ? Number(v) : Number(v ?? 0));
const isBotMri = (mri: unknown) => typeof mri === 'string' && mri.startsWith('28:');
// LIKE term: escape the SQL string literal (single quotes). The example query ('the') has no wildcards;
// this is the same crude content-scan the library uses when FTS is unavailable.
const likeLiteral = (q: string) => `'%${q.replace(/'/g, "''")}%'`;

// Copy one already-built SQLite table into DuckDB: register its rows as a JSON virtual file and let DuckDB
// infer the schema via read_json_auto. Arrow-free (portable across DuckDB-wasm targets); `create or
// replace` so a warm connection can be reused across builds.
async function copyTable(
  conn: DuckDbConn,
  sqlite: TeamsStore['rawDb'],
  name: string,
): Promise<number> {
  const rows = sqlite.prepare(`select * from ${name}`).all() as Record<string, unknown>[];
  if (!rows.length) {
    await conn.run(`drop table if exists ${name}`);
    return 0;
  }
  await conn.registerFileText(`${name}.json`, JSON.stringify(rows));
  await conn.run(`create or replace table ${name} as select * from read_json_auto('${name}.json')`);
  return rows.length;
}

export async function buildDuckDbStore(sqlite: TeamsStore, conn: DuckDbConn): Promise<DuckDbStore> {
  const db = sqlite.rawDb;
  // Copy the built base tables (with SQLite's derived cols) so DuckDB answers the same queries on the
  // same data — the query layer is what we're proving portable; the SQLite-specific BUILD is not re-run.
  await copyTable(conn, db, 'messages');
  await copyTable(conn, db, 'conversations');
  await copyTable(conn, db, 'people');
  await copyTable(conn, db, 'profiles');

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
      // Pull the analytic inputs from DuckDB, score with the SAME pure JS ranker as the SQLite facade.
      const nameRows = await conn.query<{ name: unknown }>('select name from people');
      const nameTokens = new Set<string>();
      for (const r of nameRows)
        for (const w of String(r.name ?? '')
          .toLowerCase()
          .match(/[\p{L}\p{M}]{3,}/gu) ?? [])
          nameTokens.add(w);
      const { phrases } = makeExtractor(nameTokens);

      const raw = await conn.query<Record<string, unknown>>(
        `select ts, sender_mri, content from messages where is_system = 0 and content <> ''`,
      );
      // Drop bot/app senders (28:) like the facade's default, and coerce ts to a number for the math.
      const all = raw
        .filter((r) => !isBotMri(r.sender_mri))
        .map((r) => ({
          ts: num(r.ts),
          sender_mri: r.sender_mri,
          content: String(r.content ?? ''),
        }));
      if (!all.length) return { ok: false, reason: { reason: 'no messages' } };

      const { sinceTs, untilTs } = computeTopicsWindow(all, { explicit: false, windowKey });
      const { rows } = computeTopicRows(all, phrases, sinceTs, untilTs, 2, n);
      return { ok: true, rows };
    },
  };
}
