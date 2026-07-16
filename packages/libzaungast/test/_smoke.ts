import { ingest } from '../src/ingest/ingest.js';

const dir = process.argv[2];
const t0 = Date.now();
const { store, meta } = ingest(dir);
const ms = Date.now() - t0;

console.log(
  `ingest ${ms}ms · fingerprint ${meta.fingerprint} · schema ${meta.schemaVersion} · fts ${meta.ftsEnabled}`,
);
console.log(
  `counts: ${meta.counts.conversations} conv · ${meta.counts.messages} msg · ${meta.counts.people} people`,
);
console.log(`earliest: ${new Date(meta.earliestTs).toISOString()}`);

const db = store.db;
const iso = (t: number) => new Date(t).toISOString();

console.log('\n— latest 6 conversations —');
for (const r of db
  .prepare(
    `select handle,kind,topic,participant_names,last_ts,msg_count
    from conversations order by last_ts desc limit 6`,
  )
  .all() as any[])
  console.log(
    `  ${r.handle} [${r.kind}] ${(r.topic || r.participant_names || '(untitled)').slice(0, 40)} · ${r.msg_count} msg · ${iso(r.last_ts).slice(0, 16)}`,
  );

console.log('\n— search "weekend" (FTS) —');
if (meta.ftsEnabled) {
  for (const r of db
    .prepare(
      `select m.sender_name, m.ts, snippet(messages_fts,0,'[',']','…',8) s
      from messages_fts f join messages m on m.conv_id=f.conv_id and m.id=f.id
      where messages_fts match 'weekend' order by m.ts desc limit 4`,
    )
    .all() as any[])
    console.log(`  ${iso(r.ts).slice(0, 16)} ${r.sender_name}: ${r.s}`);
}

console.log('\n— message kind distribution —');
for (const r of db
  .prepare(
    `select kind, is_system, count(*) n from messages group by kind, is_system order by n desc`,
  )
  .all() as any[])
  console.log(`  ${r.kind}${r.is_system ? ' (system)' : ''}: ${r.n}`);

console.log('\n— top 5 people —');
for (const r of db
  .prepare(`select handle,name,msg_count,last_ts from people order by msg_count desc limit 5`)
  .all() as any[])
  console.log(`  ${r.handle} ${r.name} · ${r.msg_count} msg · last ${iso(r.last_ts).slice(0, 10)}`);

store.close();
