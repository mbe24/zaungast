// Differential harness — incremental layer (the native-vs-TS three-way store gate). The Rust `diffincr` emits two
// per-table reports: INCR (a partial store as of maxSeq/2, refreshed to full) and FULL (an independent
// full build). This runs the TS FULL ingest as the third leg and asserts, per table:
//     native-incremental  ==  native-full  ==  TS-full
// i.e. a native delta-refreshed store equals both a native full rebuild AND the TS reference — the
// _inctest "incremental == full" invariant, carried across into the Rust engine.
//   node --experimental-sqlite .../diff-incr.mjs <leveldb-dir> --rust <diffincr-output> [--mapping <m>]
import fs from 'node:fs';
import { ingest } from '../../libzaungast/dist/ingest/ingest.js';

const CRC32C = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? (0x82f63b78 ^ (c >>> 1)) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();

// same tables + column order + digest rules as writer.rs / diff-store.mjs
const TABLES = [
  ['conversations', ['id', 'handle', 'kind', 'topic', 'team_id', 'thread_type', 'meta_last_ts', 'msg_count', 'participant_names', 'participant_count', 'activity_ts', 'last_ts'], 'select id,handle,kind,topic,team_id,thread_type,meta_last_ts,msg_count,participant_names,participant_count,activity_ts,last_ts from conversations order by id'],
  ['messages', ['conv_id', 'id', 'chain_key', 'version', 'ts', 'sender_mri', 'sender_name', 'kind', 'is_mine', 'is_system', 'has_attach', 'mentions_me', 'content', 'reactions', 'root_id'], 'select conv_id,id,chain_key,version,ts,sender_mri,sender_name,kind,is_mine,is_system,has_attach,mentions_me,content,reactions,root_id from messages order by conv_id,id'],
  ['people', ['mri', 'handle', 'name', 'msg_count', 'last_ts'], 'select mri,handle,name,msg_count,last_ts from people order by mri'],
  ['events', ['id', 'series_id', 'kind', 'subject', 'start_ts', 'end_ts', 'is_all_day', 'location', 'organizer_name', 'organizer_email', 'cid', 'my_response', 'show_as', 'is_cancelled', 'is_confidential', 'has_attach', 'attendees', 'body_html'], 'select id,series_id,kind,subject,start_ts,end_ts,is_all_day,location,organizer_name,organizer_email,cid,my_response,show_as,is_cancelled,is_confidential,has_attach,attendees,body_html from events order by id'],
  ['calls', ['id', 'call_type', 'direction', 'state', 'is_missed', 'start_ts', 'duration_ms', 'counterpart_mri', 'participants', 'group_thread_id', 'has_recording', 'recording_link', 'has_voicemail', 'spam_level', 'is_current_user_part', 'is_deleted'], 'select id,call_type,direction,state,is_missed,start_ts,duration_ms,counterpart_mri,participants,group_thread_id,has_recording,recording_link,has_voicemail,spam_level,is_current_user_part,is_deleted from calls order by id'],
  ['messages_fts', ['content', 'conv_id', 'id'], 'select content,conv_id,id from messages_fts order by id'],
];

const dir = process.argv[2];
const rustIdx = process.argv.indexOf('--rust');
const rustFile = rustIdx > 0 ? process.argv[rustIdx + 1] : null;
if (!dir || !rustFile) { console.error('usage: diff-incr.mjs <leveldb-dir> --rust <diffincr-output>'); process.exit(2); }

// TS full rebuild → per-table digest lines "conversations\t<crc>", etc.
const { store } = ingest(dir);
const db = store.db;
const tsDigest = new Map();
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
  tsDigest.set(name, `${rows.length}\t${((c ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0')}`);
}
store.close();

// Parse the Rust diffincr output: INCR/FULL blocks + the OUTCOME line.
const lines = fs.readFileSync(rustFile, 'utf8').replace(/\r/g, '').trimEnd().split('\n');
const incr = new Map(), full = new Map();
let outcome = '';
for (const line of lines) {
  const p = line.split('\t');
  if (p[0] === 'INCR') incr.set(p[1], `${p[2]}\t${p[3]}`);
  else if (p[0] === 'FULL') full.set(p[1], `${p[2]}\t${p[3]}`);
  else if (p[0] === 'OUTCOME') outcome = line;
}
console.log(`   ${outcome}`);
if (/need_full_rebuild=true|skipped=true/.test(outcome)) {
  console.log('FAIL: refresh did not apply a delta (tripwire/lossy) — cap chosen made this a non-test');
  process.exit(1);
}

let ok = 0, bad = 0;
for (const [name] of TABLES) {
  const t = tsDigest.get(name), i = incr.get(name), f = full.get(name);
  // three-way: native-incremental == native-full == TS-full
  if (i === f && f === t) { ok++; }
  else {
    bad++;
    console.log(`FAIL ${name}\n   native-incr: ${i}\n   native-full: ${f}\n   ts-full:     ${t}`);
  }
}
console.log(`\n==== ${ok} tables three-way match (native-incr == native-full == TS-full), ${bad} differ ====`);
process.exit(bad ? 1 : 0);
