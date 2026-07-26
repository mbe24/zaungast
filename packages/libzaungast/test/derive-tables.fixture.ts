// deriveTables (pure-JS, engine-agnostic derivation) must be byte-equivalent to ChatStore's SQL
// recomputeDerived — over the SAME BaseTables — for BOTH the people table and the conversations' derived
// columns, INCLUDING the collision-extended handles (whose values depend on assignment order). This is
// the executable spec pinning the JS derive to the frozen SQLite recompute; any drift fails loudly, so a
// future DuckDB/other backend can derive in JS and match SQLite by construction.
import { test, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSnapshotFrom } from '../src/format/chromium/indexeddb.js';
import { extractFromSnapshot, shapeBaseTables, deriveTables } from '../src/ingest/ingest-core.js';
import { openStoreFromSource } from '../src/store-facade.js';
import { MemorySource } from '../src/format/chromium/memory-source.js';
import { createSqliteWasmDriver } from '../src/sqlite-wasm-driver.js';
import { byCodeUnit } from '../src/util/sort.js';
import type { SqlDriver } from '../src/ingest/sql-driver.js';
import { generateFixtureWithTables } from './fixture/generate.js';

let dir: string;
let driver: SqlDriver;
beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaungast-derive-'));
  generateFixtureWithTables(dir, { ldbFileCount: 3 });
  driver = await createSqliteWasmDriver();
});

function memSource(): MemorySource {
  const files = new Map<string, Uint8Array>();
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isFile()) files.set(name, fs.readFileSync(p));
  }
  return new MemorySource(files);
}

test('deriveTables ≡ SQLite recomputeDerived — people + conversation derived cols (incl. handles)', () => {
  const base = shapeBaseTables(extractFromSnapshot(loadSnapshotFrom(memSource())));
  const derived = deriveTables(base);
  const store = openStoreFromSource(memSource(), { driver });
  try {
    // people
    const sqlPeople = store.rawDb
      .prepare('select mri, handle, name, msg_count, last_ts from people order by mri')
      .all();
    const jsPeople = derived.people
      .slice()
      .sort((a, b) => byCodeUnit(a.mri, b.mri))
      .map((p) => ({
        mri: p.mri,
        handle: p.handle,
        name: p.name,
        msg_count: p.msgCount,
        last_ts: p.lastTs,
      }));
    expect(sqlPeople.length).toBeGreaterThan(0);
    expect(jsPeople).toEqual(sqlPeople);

    // conversations' full row (meta + derived cols)
    const cols =
      'id, handle, kind, topic, team_id, thread_type, meta_last_ts, msg_count, activity_ts, participant_count, last_ts, participant_names';
    const sqlConv = store.rawDb.prepare(`select ${cols} from conversations order by id`).all();
    const jsConv = derived.conversations
      .slice()
      .sort((a, b) => byCodeUnit(a.id, b.id))
      .map((c) => ({
        id: c.id,
        handle: c.handle,
        kind: c.kind,
        topic: c.topic,
        team_id: c.teamId,
        thread_type: c.threadType,
        meta_last_ts: c.metaLastTs,
        msg_count: c.msgCount,
        activity_ts: c.activityTs,
        participant_count: c.participantCount,
        last_ts: c.lastTs,
        participant_names: c.participantNames,
      }));
    expect(sqlConv.length).toBeGreaterThan(0);
    expect(jsConv).toEqual(sqlConv);
  } finally {
    store.close();
  }
});
