//! The SQLite store writer — port of ingest.ts's apply* + store.ts. Builds a ChatStore (rusqlite)
//! from a snapshot + mapping and writes it to a file end-to-end (the seam-A pipeline), plus the
//! incremental refresh. Split into: `convert` (pure Ssv/JS-coercion/transform/time helpers), `extract`
//! (row extraction + insertion + Handles), `fts` (FTS5 refresh), `refresh` (incremental delta apply +
//! the file `_meta` contract), and this `mod` (orchestration: build_store/populate/ingest_to_file +
//! the per-table content differential). The recomputeDerived/FTS SQL is pure SQLite (reused verbatim);
//! only row-building is Rust. Verified via a per-table content differential vs a TS full rebuild.

mod convert;
mod extract;
mod fts;
mod refresh;

pub use refresh::USER_VERSION;
pub use refresh::{
    compute_state, refresh_store, refresh_to_file, reuse_refresh_to_file, FileMeta,
    RefreshFileOutcome, RefreshOutcome, RefreshState,
};

use std::time::{Duration, Instant};

use rusqlite::Connection;
use serde_json::Value;

use convert::vote_self_mri;
use extract::{
    apply_conversation_meta, apply_messages, recompute_derived, replace_calls, replace_events,
    replace_profiles, Handles,
};
use fts::refresh_fts;
use refresh::{store_sigs, write_meta};

use crate::fingerprint::fingerprint;
use crate::idb::{load_snapshot, Snapshot};
use crate::resolver::{entity_targets_for, extract_rows, select_mapping, store_set_from_fp};
use crate::sstable::{crc32c_final, crc32c_init, crc32c_update};

// The schema DDL is NOT embedded here: it is passed in by the caller (TS reads the single-source
// libzaungast/src/schema.sql and hands us the exact string), so the two engines' schemas can't drift.
const FTS_CREATE: &str = "create virtual table messages_fts using fts5(content, conv_id unindexed, id unindexed, tokenize='porter unicode61');";

/// Build an in-memory ChatStore from a snapshot + mapping (full ingest). `schema` is the DDL string
/// handed in by the caller (the single-source libzaungast/src/schema.sql), execd verbatim.
pub fn build_store(snap: &Snapshot, mapping: &Value, schema: &str) -> Connection {
    build_store_timed(snap, mapping, schema).0
}

/// Like `build_store`, but also returns the store-build phase timings. Used by the `profile` harness
/// bin; `build_store` and `ingest_to_file` just discard the timings (measure-and-drop — see the
/// `PhaseTimings` doc). The timings are pure observation and never touch the `Connection`, so the
/// store bytes are identical whether or not anyone reads them.
pub fn build_store_timed(
    snap: &Snapshot,
    mapping: &Value,
    schema: &str,
) -> (Connection, PhaseTimings) {
    let conn = Connection::open_in_memory().expect("open");
    conn.execute_batch(schema).expect("schema");
    conn.execute_batch(FTS_CREATE).expect("fts");
    let (_self_mri, timings) = populate(&conn, snap, mapping);
    (conn, timings)
}

/// Populate an already-schema'd connection from a snapshot + mapping (the full-ingest apply* +
/// recompute + FTS spine, shared by the in-memory harness build and the file-writing napi path).
/// Returns the elected `selfMri` (the current user's MRI, or None) and the per-sub-phase wall-clock
/// (`PhaseTimings`). The `Instant` reads are pure observation — they touch no SQLite write and change
/// no control flow, so the store output is unaffected; callers that don't profile just drop them.
fn populate(conn: &Connection, snap: &Snapshot, mapping: &Value) -> (Option<String>, PhaseTimings) {
    let t = Instant::now();
    let msgs = extract_rows(snap, mapping, "message");
    let convs = extract_rows(snap, mapping, "conversation");
    let profiles = extract_rows(snap, mapping, "profile");
    let events = extract_rows(snap, mapping, "event");
    let calls = extract_rows(snap, mapping, "call");
    let extract = t.elapsed();

    let self_mri = vote_self_mri(&msgs);
    let mut handles = Handles::new();

    // R1 write-tuning: ONE transaction spans apply + recompute + FTS (was a txn around apply only, then
    // recompute/FTS auto-committing per statement). On the file path (ingest_to_file) this, plus
    // journal_mode=OFF/synchronous=OFF, collapses the fsync-per-commit cost. Byte output is unchanged —
    // recompute/FTS read their own uncommitted writes within the txn, the same rows as before.
    let t = Instant::now();
    conn.execute_batch("BEGIN").unwrap();
    apply_conversation_meta(conn, &convs, &mut handles);
    apply_messages(conn, &msgs, self_mri.as_deref());
    replace_profiles(conn, &profiles);
    replace_events(conn, &events);
    replace_calls(conn, &calls);
    let apply = t.elapsed();

    let t = Instant::now();
    recompute_derived(conn, self_mri.as_deref(), &mut handles);
    let recompute = t.elapsed();

    let t = Instant::now();
    refresh_fts(conn);
    conn.execute_batch("COMMIT").unwrap();
    let fts = t.elapsed();

    (
        self_mri,
        PhaseTimings {
            extract,
            apply,
            recompute,
            fts,
        },
    )
}

/// The full seam-A pipeline: read the leveldb dir, fingerprint it, select among the caller's bundled
/// mappings, and write the ChatStore to `dest_path` (overwriting any prior file). `schema` and
/// `mappings_json` come from the TS package (single-source schema.sql + bundled mapping JSONs), so
/// Rust does the expensive read/decode/build end-to-end and TS opens the result read-only. Returns
/// the meta the TS side needs to construct its StoreMeta without re-reading anything.
pub fn ingest_to_file(
    dir: &str,
    dest_path: &str,
    schema: &str,
    mappings_json: &[String],
) -> Result<IngestOutcome, String> {
    // R3: source-file signature AS OF the read (before load_snapshot), stored in _meta so a later
    // refresh can short-circuit a no-op tick without re-reading. Fail-open (empty on error).
    let source_sig = crate::idb::source_signature(dir).unwrap_or_default();
    let snap = load_snapshot(dir).map_err(|e| format!("load_snapshot: {e}"))?;
    let fp = fingerprint(&snap);
    let mappings: Vec<Value> = mappings_json
        .iter()
        .map(|s| serde_json::from_str::<Value>(s).map_err(|e| format!("mapping JSON: {e}")))
        .collect::<Result<_, _>>()?;
    let selected = select_mapping(&fp.hash, &store_set_from_fp(&fp.stores), &mappings);

    // A fresh full rebuild: never open onto a stale file (would leave rows from a prior schema).
    let _ = std::fs::remove_file(dest_path);
    let conn = Connection::open(dest_path).map_err(|e| format!("open {dest_path}: {e}"))?;
    // R1 write-tuning: this file is a throwaway full rebuild (removed + rebuilt from leveldb on any
    // failure), so durability is irrelevant — skip the rollback journal + per-commit fsync. This is the
    // bulk of the ~2.3s file-write cost. SAFE ONLY because the file is disposable; NEVER set these on a
    // live-store refresh path (a crash there would corrupt the store TS is reading).
    conn.execute_batch("PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;")
        .map_err(|e| format!("pragmas: {e}"))?;
    conn.execute_batch(schema)
        .map_err(|e| format!("schema exec: {e}"))?;
    conn.execute_batch(FTS_CREATE)
        .map_err(|e| format!("fts create: {e}"))?;

    let (schema_matched, mapping_version, self_mri) = if let Some(m) = selected {
        // Production path: measure-and-drop — the store-build phase timings are discarded here (only
        // the `profile` bin, via `build_store_timed`, keeps them).
        let (self_mri, _timings) = populate(&conn, &snap, m);
        // Write the in-file contract (_meta + user_version) so a later refresh reads its floor +
        // reuses this mapping. Build the state from populate's OWN outputs — its elected selfMri +
        // the cheap no-decode target lists — instead of compute_state, which would re-extract
        // (re-decode) the entire message store a second time.
        let ver = m
            .get("mappingVersion")
            .and_then(|v| v.as_str())
            .map(std::string::ToString::to_string);
        let state = RefreshState {
            self_mri,
            max_seq: snap.max_seq,
            msg_targets: entity_targets_for(&snap, m, "message"),
            conv_targets: entity_targets_for(&snap, m, "conversation"),
            store_sigs: store_sigs(&snap, m),
        };
        write_meta(
            &conn,
            &fp.hash,
            ver.as_deref(),
            snap.lossy,
            &source_sig,
            &state,
        )?;
        (true, ver, state.self_mri)
    } else {
        // Unknown schema: an empty store (schema only), mirroring TS ingest (store loads, no rows).
        // Still stamp user_version + an empty _meta so the file is self-describing.
        let empty = RefreshState {
            self_mri: None,
            max_seq: snap.max_seq,
            msg_targets: vec![],
            conv_targets: vec![],
            store_sigs: std::collections::BTreeMap::default(),
        };
        write_meta(&conn, &fp.hash, None, snap.lossy, &source_sig, &empty)?;
        (false, None, None)
    };

    let count = |t: &str| -> i64 {
        conn.query_row(&format!("select count(*) from {t}"), [], |r| r.get(0))
            .unwrap_or(0)
    };
    let earliest_ts: i64 = conn
        .query_row("select min(ts) from messages where ts>0", [], |r| {
            r.get::<_, Option<i64>>(0)
        })
        .ok()
        .flatten()
        .unwrap_or(0);
    let outcome = IngestOutcome {
        fingerprint: fp.hash.clone(),
        schema_matched,
        mapping_version,
        lossy: snap.lossy,
        self_mri,
        conversations: count("conversations"),
        messages: count("messages"),
        people: count("people"),
        earliest_ts,
        fts_enabled: true, // bundled rusqlite always has FTS5
    };
    conn.close().map_err(|(_, e)| format!("close: {e}"))?;
    Ok(outcome)
}

/// Per-sub-phase wall-clock of a store build (`populate`), for the `profile` harness bin. Pure data:
/// filled by `populate`, returned via `build_store_timed`, and dropped by the production paths
/// (`build_store`/`ingest_to_file`) — it holds no `Connection` state and no wall-clock is ever
/// written into the store, so byte-identity is unaffected. Not compiled into the napi addon's hot
/// path in any meaningful way (six `Instant` reads per ingest, once, not in a loop).
#[derive(Debug, Clone, Copy, Default)]
pub struct PhaseTimings {
    /// `extract_rows` over all five entities (structured-clone decode → row structs).
    pub extract: Duration,
    /// the `BEGIN … COMMIT` apply block (conversation meta + messages + profiles/events/calls).
    pub apply: Duration,
    /// `recompute_derived` (people rollups, conversation activity, handle assignment).
    pub recompute: Duration,
    /// `refresh_fts` (FTS5 index (re)build).
    pub fts: Duration,
}

/// The meta a native ingest reports back so TS can build its StoreMeta without re-reading the store.
pub struct IngestOutcome {
    pub fingerprint: String,
    pub schema_matched: bool,
    pub mapping_version: Option<String>,
    pub lossy: bool,
    pub self_mri: Option<String>,
    pub conversations: i64,
    pub messages: i64,
    pub people: i64,
    pub earliest_ts: i64,
    pub fts_enabled: bool,
}

// ---- per-table content differential report ----
fn feed_value(c: &mut u32, v: rusqlite::types::ValueRef) {
    use rusqlite::types::ValueRef::{Blob, Integer, Null, Real, Text};
    let up = crc32c_update;
    match v {
        Null => *c = up(*c, 0),
        Integer(i) => {
            *c = up(*c, 1);
            for x in i.to_le_bytes() {
                *c = up(*c, x);
            }
        }
        Real(f) => {
            *c = up(*c, 2);
            for x in f.to_le_bytes() {
                *c = up(*c, x);
            }
        }
        Text(t) => {
            *c = up(*c, 3);
            for x in (t.len() as u32).to_le_bytes() {
                *c = up(*c, x);
            }
            for &x in t {
                *c = up(*c, x);
            }
        }
        Blob(b) => {
            *c = up(*c, 4);
            for &x in b {
                *c = up(*c, x);
            }
        }
    }
}

const TABLES: &[(&str, &str, usize)] = &[
    ("conversations", "select id,handle,kind,topic,team_id,thread_type,meta_last_ts,msg_count,participant_names,participant_count,activity_ts,last_ts from conversations order by id", 12),
    ("messages", "select conv_id,id,chain_key,version,ts,sender_mri,sender_name,kind,is_mine,is_system,has_attach,mentions_me,content,reactions,root_id from messages order by conv_id,id", 15),
    ("people", "select mri,handle,name,msg_count,last_ts from people order by mri", 5),
    ("events", "select id,series_id,kind,subject,start_ts,end_ts,is_all_day,location,organizer_name,organizer_email,cid,my_response,show_as,is_cancelled,is_confidential,has_attach,attendees,body_html from events order by id", 18),
    ("calls", "select id,call_type,direction,state,is_missed,start_ts,duration_ms,counterpart_mri,participants,group_thread_id,has_recording,recording_link,has_voicemail,spam_level,is_current_user_part,is_deleted from calls order by id", 16),
    ("messages_fts", "select content,conv_id,id from messages_fts order by id", 3),
];

/// Debug: dump a table's rows (tab-separated, null→\N) in the differential's column/row order.
pub fn dump_table(conn: &Connection, table: &str) -> String {
    let (_, sql, ncols) = TABLES
        .iter()
        .find(|(n, _, _)| *n == table)
        .expect("unknown table");
    let mut stmt = conn.prepare(sql).unwrap();
    let mut out = String::new();
    let mut q = stmt.query([]).unwrap();
    while let Some(row) = q.next().unwrap() {
        let mut parts: Vec<String> = Vec::new();
        for i in 0..*ncols {
            parts.push(match row.get_ref(i).unwrap() {
                rusqlite::types::ValueRef::Null => "\\N".to_string(),
                rusqlite::types::ValueRef::Integer(n) => n.to_string(),
                rusqlite::types::ValueRef::Real(f) => f.to_string(),
                rusqlite::types::ValueRef::Text(t) => {
                    String::from_utf8_lossy(t).replace(['\t', '\n'], " ")
                }
                rusqlite::types::ValueRef::Blob(_) => "<blob>".to_string(),
            });
        }
        out.push_str(&parts.join("\t"));
        out.push('\n');
    }
    out
}

pub fn store_report(conn: &Connection) -> String {
    use std::fmt::Write;
    let mut out = String::new();
    for (name, sql, ncols) in TABLES {
        let mut stmt = conn.prepare(sql).unwrap();
        let mut c = crc32c_init();
        let mut rows = 0u64;
        let mut q = stmt.query([]).unwrap();
        while let Some(row) = q.next().unwrap() {
            rows += 1;
            for i in 0..*ncols {
                feed_value(&mut c, row.get_ref(i).unwrap());
            }
        }
        let _ = writeln!(out, "T\t{}\t{}\t{:08x}", name, rows, crc32c_final(c));
    }
    out
}
