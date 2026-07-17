// Differential harness — store layer. Runs the TS full ingest, dumps a per-table content digest, and
// (with --rust) diffs against Rust's `diffstore`. This is the seam-A gate: the Rust-built ChatStore
// must equal a TS full rebuild, table for table. Needs --experimental-sqlite (TS ingest uses node:sqlite).
//   node --experimental-sqlite .../diff-store.mjs <leveldb-dir> --mapping <m.json> [--rust <report>]
import fs from 'node:fs';
import { ingest } from '../../libzaungast/dist/ingest/ingest.js';

const CRC32C = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? (0x82f63b78 ^ (c >>> 1)) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();

// same tables + column order + digest rules as writer.rs
const TABLES = [
  ['conversations', ['id', 'handle', 'kind', 'topic', 'team_id', 'thread_type', 'meta_last_ts', 'msg_count', 'participant_names', 'participant_count', 'activity_ts', 'last_ts'], 'select id,handle,kind,topic,team_id,thread_type,meta_last_ts,msg_count,participant_names,participant_count,activity_ts,last_ts from conversations order by id'],
  ['messages', ['conv_id', 'id', 'chain_key', 'version', 'ts', 'sender_mri', 'sender_name', 'kind', 'is_mine', 'is_system', 'has_attach', 'mentions_me', 'content', 'reactions', 'root_id'], 'select conv_id,id,chain_key,version,ts,sender_mri,sender_name,kind,is_mine,is_system,has_attach,mentions_me,content,reactions,root_id from messages order by conv_id,id'],
  ['people', ['mri', 'handle', 'name', 'msg_count', 'last_ts'], 'select mri,handle,name,msg_count,last_ts from people order by mri'],
  ['events', ['id', 'series_id', 'kind', 'subject', 'start_ts', 'end_ts', 'is_all_day', 'location', 'organizer_name', 'organizer_email', 'cid', 'my_response', 'show_as', 'is_cancelled', 'is_confidential', 'has_attach', 'attendees', 'body_html'], 'select id,series_id,kind,subject,start_ts,end_ts,is_all_day,location,organizer_name,organizer_email,cid,my_response,show_as,is_cancelled,is_confidential,has_attach,attendees,body_html from events order by id'],
  ['calls', ['id', 'call_type', 'direction', 'state', 'is_missed', 'start_ts', 'duration_ms', 'counterpart_mri', 'participants', 'group_thread_id', 'has_recording', 'recording_link', 'has_voicemail', 'spam_level', 'is_current_user_part', 'is_deleted'], 'select id,call_type,direction,state,is_missed,start_ts,duration_ms,counterpart_mri,participants,group_thread_id,has_recording,recording_link,has_voicemail,spam_level,is_current_user_part,is_deleted from calls order by id'],
  ['messages_fts', ['content', 'conv_id', 'id'], 'select content,conv_id,id from messages_fts order by id'],
];

const dir = process.argv[2];
if (!dir) { console.error('usage: diff-store.mjs <leveldb-dir> --mapping <m> [--rust <r>]'); process.exit(2); }
const rustIdx = process.argv.indexOf('--rust');
const rustFile = rustIdx > 0 ? process.argv[rustIdx + 1] : null;

const { store } = ingest(dir);
const db = store.db;

// debug: --dump <table> prints that table's rows (same format as writer.rs dump_table)
const dumpIdx = process.argv.indexOf('--dump');
if (dumpIdx > 0) {
  const table = process.argv[dumpIdx + 1];
  const [, cols, sql] = TABLES.find((t) => t[0] === table);
  const lines = db.prepare(sql).all().map((row) => cols.map((c) => {
    const v = row[c];
    return v == null ? '\\N' : String(v).replace(/[\t\n]/g, ' ');
  }).join('\t'));
  store.close();
  process.stdout.write(lines.join('\n') + '\n');
  process.exit(0);
}

const ts = [];
for (const [name, cols, sql] of TABLES) {
  let c = 0xffffffff;
  const up = (x) => (c = (CRC32C[(c ^ x) & 0xff] ^ (c >>> 8)) >>> 0);
  const feed = (v) => {
    if (v === null || v === undefined) { up(0); return; }
    if (typeof v === 'number' || typeof v === 'bigint') {
      up(1); let n = BigInt(v); for (let i = 0; i < 8; i++) { up(Number(n & 0xffn)); n >>= 8n; } return;
    }
    if (typeof v === 'string') {
      const b = Buffer.from(v, 'utf8'); up(3);
      up(b.length & 0xff); up((b.length >>> 8) & 0xff); up((b.length >>> 16) & 0xff); up((b.length >>> 24) & 0xff);
      for (const x of b) up(x); return;
    }
    const b = Buffer.from(v); up(4); for (const x of b) up(x);
  };
  const rows = db.prepare(sql).all();
  for (const row of rows) for (const col of cols) feed(row[col]);
  ts.push(`T\t${name}\t${rows.length}\t${((c ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0')}`);
}
store.close();

if (!rustFile) { console.log(ts.join('\n')); process.exit(0); }
const rs = fs.readFileSync(rustFile, 'utf8').replace(/\r/g, '').trimEnd().split('\n');
let ok = 0, bad = 0;
for (let i = 0; i < Math.max(ts.length, rs.length); i++) {
  const a = ts[i] ?? '(missing TS)', b = rs[i] ?? '(missing rust)';
  if (a === b) ok++; else { bad++; console.log(`FAIL\n   ts: ${a}\n   rs: ${b}`); }
}
console.log(`\n==== ${ok} tables match, ${bad} differ ====`);
process.exit(bad ? 1 : 0);
