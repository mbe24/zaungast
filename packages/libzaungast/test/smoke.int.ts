// Ingest smoke test over a real leveldb cache: exercises ingest + a handful of queries end-to-end.
// Requires ZAUNGAST_TEST_DIR (or a `data/<date>` cache) — skips (green) when none is available.
import { test, expect } from 'vitest';
import { resolveLevelDbDir } from '../../../scripts/native-runner.mjs';
import { ingest } from '../src/ingest/ingest.js';

const dir = resolveLevelDbDir(process.env.ZAUNGAST_TEST_DIR);

test.skipIf(!dir)('ingest smoke over a real cache', () => {
  const { store, meta } = ingest(dir!);

  expect(meta.schemaMatched).toBe(true);
  expect(meta.counts.messages).toBeGreaterThan(0);

  console.log(
    `ingest · fingerprint ${meta.fingerprint} · mapping ${meta.mappingVersion} · fts ${meta.ftsEnabled} · ` +
      `${meta.counts.conversations} conv · ${meta.counts.messages} msg · ${meta.counts.people} people`,
  );

  const db = store.db;

  const conversations = db
    .prepare(
      `select handle,kind,topic,participant_names,last_ts,msg_count
      from conversations order by last_ts desc limit 6`,
    )
    .all() as any[];
  expect(conversations.length).toBeGreaterThan(0);

  if (meta.ftsEnabled) {
    const hits = db
      .prepare(
        `select m.sender_name, m.ts, snippet(messages_fts,0,'[',']','…',8) s
        from messages_fts f join messages m on m.conv_id=f.conv_id and m.id=f.id
        where messages_fts match 'weekend' order by m.ts desc limit 4`,
      )
      .all();
    expect(Array.isArray(hits)).toBe(true);
  }

  const kinds = db
    .prepare(
      `select kind, is_system, count(*) n from messages group by kind, is_system order by n desc`,
    )
    .all() as any[];
  expect(kinds.length).toBeGreaterThan(0);

  const people = db
    .prepare(`select handle,name,msg_count,last_ts from people order by msg_count desc limit 5`)
    .all() as any[];
  expect(people.length).toBeGreaterThan(0);

  store.close();
});
