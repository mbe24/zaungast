//! Incremental refresh (delta apply; port of applyIncremental) + the writer↔reader file contract
//! (PRAGMA user_version + the in-file `_meta` table). A refresh opens the previous file, reads its
//! `_meta` floor, applies the delta up to the current sequence (delete-missing-chains +
//! delete-changed-chains + re-extract-changed + whole-replace profiles/events/calls + conversation
//! reconcile + recomputeDerived + delta FTS), and rewrites `_meta`. The previous file is never
//! mutated — TS swaps to the new file.

use std::collections::HashSet;

use rusqlite::{params, Connection};
use serde_json::Value;

use super::convert::{as_str, get, vote_self_mri};
use super::extract::{
    apply_conversation_meta, apply_messages, recompute_derived, replace_calls, replace_events,
    replace_profiles, Handles,
};
use super::fts::refresh_fts_delta;
use crate::idb::{load_snapshot, load_snapshot_reuse, LdbCache, Snapshot};
use crate::resolver::{entity_targets_for, extract_rows, extract_rows_from_records};

/// PRAGMA user_version stamped into every native-written .db — the freshness/staleness gate. TS
/// validates it on open; a mismatch means the file was written by an incompatible lib version (or the
/// schema generation was hand-bumped) → refuse to serve / full-rebuild. Schema-independent, readable
/// without assuming any table exists. Bump whenever the on-disk store layout changes meaningfully.
/// v2 (R3): `_meta` gained `source_sig` (the leveldb source-file signature for the no-op refresh gate);
/// a v1 file lacks the column, so the version gate forces a full rebuild rather than reading it.
pub const USER_VERSION: i32 = 2;

/// The state carried between refreshes (what a full ingest recorded so a later delta can validate the
/// schema hasn't shifted + knows the sequence floor). Mirrors TS IngestState, minus the mapping (the
/// caller reuses the same mapping — re-selected by mappingVersion from the file's _meta).
pub struct RefreshState {
    pub self_mri: Option<String>,
    pub max_seq: u64,
    pub msg_targets: Vec<String>,  // sorted (entity_targets_for sorts)
    pub conv_targets: Vec<String>, // sorted
}

pub struct RefreshOutcome {
    pub need_full_rebuild: bool, // schema tripwire / error → caller must full-rebuild
    pub skipped: bool,           // lossy load → nothing applied, retry next refresh
    pub new_max_seq: u64,
}

/// The RefreshState a full ingest of `snap` would record (self_mri + maxSeq + mapped-store targets).
pub fn compute_state(snap: &Snapshot, mapping: &Value) -> RefreshState {
    let msgs = extract_rows(snap, mapping, "message");
    RefreshState {
        self_mri: vote_self_mri(&msgs),
        max_seq: snap.max_seq,
        msg_targets: entity_targets_for(snap, mapping, "message"),
        conv_targets: entity_targets_for(snap, mapping, "conversation"),
    }
}

// delete messages whose owning chain is no longer live (whole-chain / compaction-elided deletion);
// returns the deleted ids. Mirrors ChatStore.deleteMessagesForMissingChains.
fn delete_messages_for_missing_chains(conn: &Connection, live: &HashSet<String>) -> Vec<String> {
    conn.execute_batch("create temp table if not exists _live_chains(k text primary key); delete from _live_chains;")
        .unwrap();
    {
        let mut ins = conn
            .prepare("insert or ignore into _live_chains values(?)")
            .unwrap();
        for k in live {
            ins.execute(params![k]).unwrap();
        }
    }
    let ids: Vec<String> = {
        let mut stmt = conn
            .prepare("select id from messages where chain_key not in (select k from _live_chains)")
            .unwrap();
        stmt.query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .filter_map(Result::ok)
            .collect()
    };
    conn.execute_batch("delete from messages where chain_key not in (select k from _live_chains)")
        .unwrap();
    ids
}

// delete messages by chain_key; returns deleted ids. Mirrors ChatStore.deleteMessagesByChain.
fn delete_messages_by_chain(conn: &Connection, chain_hex: &str) -> Vec<String> {
    let ids: Vec<String> = {
        let mut stmt = conn
            .prepare("select id from messages where chain_key=?")
            .unwrap();
        stmt.query_map(params![chain_hex], |r| r.get::<_, String>(0))
            .unwrap()
            .filter_map(Result::ok)
            .collect()
    };
    conn.execute("delete from messages where chain_key=?", params![chain_hex])
        .unwrap();
    ids
}

/// Apply an incremental delta onto an existing store (opened on the previous file). Port of
/// applyIncremental: lossy-skip, schema tripwire, no-op fast-exit, then delete-missing-chains +
/// delete-changed-chains + re-extract-changed + whole-replace profiles/events/calls + conversation
/// reconcile + recomputeDerived + delta FTS. `mapping` MUST be the mapping the prior full ingest used.
pub fn refresh_store(
    conn: &Connection,
    snap: &Snapshot,
    mapping: &Value,
    state: &RefreshState,
) -> RefreshOutcome {
    // lossy load → don't apply (spuriously-absent chains would read as deletions); serve current.
    if snap.lossy {
        return RefreshOutcome {
            need_full_rebuild: false,
            skipped: true,
            new_max_seq: state.max_seq,
        };
    }
    // schema tripwire: our mapped message/conversation stores resolve differently → full rebuild.
    let msg_t = entity_targets_for(snap, mapping, "message");
    let conv_t = entity_targets_for(snap, mapping, "conversation");
    if msg_t != state.msg_targets || conv_t != state.conv_targets {
        return RefreshOutcome {
            need_full_rebuild: true,
            skipped: false,
            new_max_seq: state.max_seq,
        };
    }
    // no-op fast-exit: maxSeq counts tombstones too, so equal ⇒ nothing landed since the last apply.
    if snap.max_seq == state.max_seq {
        return RefreshOutcome {
            need_full_rebuild: false,
            skipped: false,
            new_max_seq: snap.max_seq,
        };
    }

    // live + changed (seq > floor) chain keys, straight off the message buckets (hex, matching the
    // chain_key column encoding). changed_records feed the message re-extract.
    let mut live: HashSet<String> = HashSet::new();
    let mut changed_chains: HashSet<String> = HashSet::new();
    let mut changed_records: Vec<&crate::idb::SnapshotRecord> = Vec::new();
    for sk in &state.msg_targets {
        if let Some(b) = snap
            .buckets
            .iter()
            .find(|b| format!("{}:{}", b.db_id, b.os_id) == *sk)
        {
            for rec in &b.records {
                let hex = crate::sha256::hex(&rec.key);
                live.insert(hex.clone());
                if rec.seq > state.max_seq {
                    changed_chains.insert(hex);
                    changed_records.push(rec);
                }
            }
        }
    }

    // Seed from the existing (previous-file) rows so new-entity handle assignment can't collide with
    // an already-issued handle (which would trip `handle UNIQUE`); existing entities keep their handle.
    let mut handles = Handles::new();
    handles.seed_from(conn);
    let self_mri = state.self_mri.as_deref();
    conn.execute_batch("BEGIN").unwrap();
    let mut fts_ids: HashSet<String> = HashSet::new();
    for id in delete_messages_for_missing_chains(conn, &live) {
        fts_ids.insert(id);
    }
    for ck in &changed_chains {
        for id in delete_messages_by_chain(conn, ck) {
            fts_ids.insert(id);
        }
    }
    let new_rows = extract_rows_from_records(&changed_records, mapping, "message");
    for id in apply_messages(conn, &new_rows, self_mri) {
        fts_ids.insert(id);
    }
    // cheap whole-store replaces (keeps the incremental==full invariant trivially true for these)
    replace_profiles(conn, &extract_rows(snap, mapping, "profile"));
    replace_events(conn, &extract_rows(snap, mapping, "event"));
    replace_calls(conn, &extract_rows(snap, mapping, "call"));
    // conversation reconcile: reset live-meta cols, re-apply, drop orphans (not referenced by messages)
    let conv_rows = extract_rows(snap, mapping, "conversation");
    conn.execute_batch(
        "update conversations set topic=null, team_id=null, thread_type=null, meta_last_ts=0",
    )
    .unwrap();
    apply_conversation_meta(conn, &conv_rows, &mut handles);
    conn.execute_batch(
        "create temp table if not exists _liveconv(id text primary key); delete from _liveconv;",
    )
    .unwrap();
    {
        let mut ins = conn
            .prepare("insert or ignore into _liveconv values(?)")
            .unwrap();
        for c in &conv_rows {
            if let Some(id) = as_str(get(c, "id")) {
                if !id.is_empty() {
                    ins.execute(params![id]).unwrap();
                }
            }
        }
    }
    conn.execute_batch(
        "delete from conversations where id not in (select id from _liveconv) and id not in (select distinct conv_id from messages)",
    )
    .unwrap();
    conn.execute_batch("COMMIT").unwrap();

    recompute_derived(conn, self_mri, &mut handles);
    refresh_fts_delta(conn, &fts_ids);
    RefreshOutcome {
        need_full_rebuild: false,
        skipped: false,
        new_max_seq: snap.max_seq,
    }
}

// ---- writer↔reader contract: PRAGMA user_version + the in-file _meta table ----
// The .db file is the contract (self-describing), not an FFI-return sidecar. `_meta` carries the
// StoreMeta bits NOT recoverable by query (fingerprint/mappingVersion/selfMri/lossy) PLUS the
// incremental state (maxSeq + mapped-store targets) so a later refresh reads its floor from the file.

/// Create + write the single-row `_meta` table and stamp user_version. `_meta` is native-only (not in
/// schema.sql, so the store differential's fixed TABLES list ignores it).
pub(crate) fn write_meta(
    conn: &Connection,
    fingerprint: &str,
    mapping_version: Option<&str>,
    lossy: bool,
    source_sig: &str,
    state: &RefreshState,
) -> Result<(), String> {
    let targets_json = |t: &[String]| serde_json::to_string(t).unwrap_or_else(|_| "[]".into());
    conn.execute_batch(
        "create table if not exists _meta(
           fingerprint text, mapping_version text, self_mri text, lossy int,
           max_seq int, msg_targets text, conv_targets text, source_sig text);
         delete from _meta;",
    )
    .map_err(|e| format!("_meta create: {e}"))?;
    conn.execute(
        "insert into _meta(fingerprint,mapping_version,self_mri,lossy,max_seq,msg_targets,conv_targets,source_sig)
         values(?,?,?,?,?,?,?,?)",
        params![
            fingerprint,
            mapping_version,
            state.self_mri,
            lossy as i64,
            state.max_seq as i64,
            targets_json(&state.msg_targets),
            targets_json(&state.conv_targets),
            source_sig,
        ],
    )
    .map_err(|e| format!("_meta insert: {e}"))?;
    conn.pragma_update(None, "user_version", USER_VERSION)
        .map_err(|e| format!("user_version: {e}"))?;
    Ok(())
}

/// The `_meta` row + user_version read back from a native-written file. `stale` = user_version
/// mismatch (an incompatible/older-lib file → caller must full-rebuild).
pub struct FileMeta {
    pub stale: bool,
    pub fingerprint: String,
    pub mapping_version: Option<String>,
    pub lossy: bool,
    pub state: RefreshState,
    /// The leveldb source-file signature recorded when this file was written (R3 no-op gate). `None`
    /// for a stale/v1 file (never trusted → full rebuild).
    pub source_sig: Option<String>,
}

fn read_meta(conn: &Connection) -> Result<FileMeta, String> {
    let uv: i32 = conn
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .map_err(|e| format!("read user_version: {e}"))?;
    if uv != USER_VERSION {
        return Ok(FileMeta {
            stale: true,
            fingerprint: String::new(),
            mapping_version: None,
            lossy: false,
            state: RefreshState {
                self_mri: None,
                max_seq: 0,
                msg_targets: vec![],
                conv_targets: vec![],
            },
            source_sig: None,
        });
    }
    let parse_targets =
        |s: String| -> Vec<String> { serde_json::from_str::<Vec<String>>(&s).unwrap_or_default() };
    conn.query_row(
        "select fingerprint,mapping_version,self_mri,lossy,max_seq,msg_targets,conv_targets,source_sig from _meta limit 1",
        [],
        |r| {
            Ok(FileMeta {
                stale: false,
                fingerprint: r.get::<_, Option<String>>(0)?.unwrap_or_default(),
                mapping_version: r.get::<_, Option<String>>(1)?,
                lossy: r.get::<_, i64>(3)? != 0,
                state: RefreshState {
                    self_mri: r.get::<_, Option<String>>(2)?,
                    max_seq: r.get::<_, i64>(4)? as u64,
                    msg_targets: parse_targets(r.get::<_, Option<String>>(5)?.unwrap_or_default()),
                    conv_targets: parse_targets(r.get::<_, Option<String>>(6)?.unwrap_or_default()),
                },
                source_sig: r.get::<_, Option<String>>(7)?,
            })
        },
    )
    .map_err(|e| format!("read _meta: {e}"))
}

/// Incremental seam-A entry (across FFI calls): copy the previous file to `new_path`, read its
/// `_meta` for the refresh floor + the same mapping (reused by mappingVersion), apply the delta up to
/// the current sequence, and rewrite `_meta`. On a schema tripwire / stale file / lossy load it
/// signals the caller to full-rebuild instead (need_full_rebuild) or serve-current (skipped). The
/// previous file is never mutated (TS may still hold a read-only handle on it) — TS swaps to new_path.
pub fn refresh_to_file(
    dir: &str,
    prev_path: &str,
    new_path: &str,
    mappings_json: &[String],
) -> Result<RefreshFileOutcome, String> {
    // R3 no-op short-circuit: if the leveldb source files are byte-identical to when prev was written,
    // nothing landed → keep serving prev with NO copy and NO load_snapshot (returns `skipped`, which
    // the Session already treats as "keep current"). Open prev READ-ONLY (never mutate it — TS may hold
    // a handle). Fail-open: any error / empty sig / non-match falls through to the full refresh path.
    if let Ok(sig) = crate::idb::source_signature(dir) {
        if !sig.is_empty() {
            if let Ok(prev) =
                Connection::open_with_flags(prev_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            {
                if let Ok(fm) = read_meta(&prev) {
                    if !fm.stale && fm.source_sig.as_deref() == Some(sig.as_str()) {
                        return Ok(RefreshFileOutcome {
                            skipped: true,
                            ..counts_of(&prev, &fm)
                        });
                    }
                }
            }
        }
    }

    let _ = std::fs::remove_file(new_path);
    std::fs::copy(prev_path, new_path).map_err(|e| format!("copy prev→new: {e}"))?;
    let conn = Connection::open(new_path).map_err(|e| format!("open {new_path}: {e}"))?;

    let fm = read_meta(&conn)?;
    if fm.stale {
        return Ok(RefreshFileOutcome::rebuild()); // incompatible/older-lib file → full rebuild
    }
    let mappings: Vec<Value> = mappings_json
        .iter()
        .map(|s| serde_json::from_str::<Value>(s).map_err(|e| format!("mapping JSON: {e}")))
        .collect::<Result<_, _>>()?;
    // Reuse the SAME mapping the prior full ingest used, by mappingVersion (not re-selected).
    let Some(mapping) = mappings.iter().find(|m| {
        m.get("mappingVersion").and_then(|v| v.as_str()) == fm.mapping_version.as_deref()
    }) else {
        return Ok(RefreshFileOutcome::rebuild()); // mapping for that mappingVersion is gone
    };

    // Record the source signature AS OF the read (before load_snapshot) so it never OVER-counts: a
    // write landing after this but seen by load_snapshot just costs one extra full refresh next time,
    // never a missed update. Fail-open (empty on error → next refresh won't short-circuit).
    let source_sig = crate::idb::source_signature(dir).unwrap_or_default();
    let snap = load_snapshot(dir).map_err(|e| format!("load_snapshot: {e}"))?;
    let outcome = refresh_store(&conn, &snap, mapping, &fm.state);
    if outcome.need_full_rebuild {
        return Ok(RefreshFileOutcome::rebuild());
    }
    if outcome.skipped {
        // lossy: nothing applied. The new_path is a byte-copy of prev; keep serving it unchanged.
        return Ok(RefreshFileOutcome {
            need_full_rebuild: false,
            skipped: true,
            ..counts_of(&conn, &fm)
        });
    }

    // Rewrite _meta with the new state (recomputed from the full snapshot) + refresh user_version.
    let new_state = compute_state(&snap, mapping);
    let fp = crate::fingerprint::fingerprint(&snap);
    write_meta(
        &conn,
        &fp.hash,
        fm.mapping_version.as_deref(),
        snap.lossy,
        &source_sig,
        &new_state,
    )?;

    let out = RefreshFileOutcome {
        need_full_rebuild: false,
        skipped: false,
        ..counts_of(&conn, &fm)
    };
    conn.close().map_err(|(_, e)| format!("close: {e}"))?;
    Ok(out)
}

/// Copy-reuse incremental refresh (Axis B). Twin of `refresh_to_file`, but loads the snapshot via the
/// cache-reusing loader (reuse immutable `.ldb` parses, re-read only the `.log`) instead of a full
/// re-read. `cache` persists across calls (owned by the TS handle). On a compaction (a cached `.ldb`
/// vanished) it returns `deferred` — nothing is written, and the caller falls back to the cacheless
/// `refresh_to_file`, whose fresh full read reconciles any compaction-elided deletion. Everything else
/// — R3 no-op short-circuit, schema tripwire, delta-apply, `_meta` rewrite — matches `refresh_to_file`.
/// The compaction/defer check + the prev meta read happen BEFORE any copy, so a defer/rebuild costs no
/// file I/O. The previous file is never mutated (opened READ-ONLY) — TS swaps to `new_path` on success.
pub fn reuse_refresh_to_file(
    dir: &str,
    prev_path: &str,
    new_path: &str,
    mappings_json: &[String],
    cache: &mut LdbCache,
) -> Result<RefreshFileOutcome, String> {
    // R3 no-op short-circuit: unchanged source ⇒ keep serving prev, no copy/load. Same as refresh_to_file.
    if let Ok(sig) = crate::idb::source_signature(dir) {
        if !sig.is_empty() {
            if let Ok(prev) =
                Connection::open_with_flags(prev_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            {
                if let Ok(fm) = read_meta(&prev) {
                    if !fm.stale && fm.source_sig.as_deref() == Some(sig.as_str()) {
                        return Ok(RefreshFileOutcome {
                            skipped: true,
                            ..counts_of(&prev, &fm)
                        });
                    }
                }
            }
        }
    }

    // Read prev's meta READ-ONLY, before any copy — a defer/rebuild then costs zero file I/O.
    let prev = Connection::open_with_flags(prev_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("open prev {prev_path}: {e}"))?;
    let fm = read_meta(&prev)?;
    if fm.stale {
        return Ok(RefreshFileOutcome::rebuild()); // incompatible/older-lib file → full rebuild
    }
    let mappings: Vec<Value> = mappings_json
        .iter()
        .map(|s| serde_json::from_str::<Value>(s).map_err(|e| format!("mapping JSON: {e}")))
        .collect::<Result<_, _>>()?;
    let Some(mapping) = mappings.iter().find(|m| {
        m.get("mappingVersion").and_then(|v| v.as_str()) == fm.mapping_version.as_deref()
    }) else {
        return Ok(RefreshFileOutcome::rebuild()); // mapping for that mappingVersion is gone
    };

    // Cache-reusing load (updates + prunes the cache). A compaction consumed a cached `.ldb` ⇒ the
    // reuse snapshot can't be trusted for a delta (an elided deletion would resurrect) ⇒ defer to the
    // cacheless reparse. Record source_sig AS OF the read (before load) so it never over-counts.
    let source_sig = crate::idb::source_signature(dir).unwrap_or_default();
    let (snap, compacted) =
        load_snapshot_reuse(dir, cache).map_err(|e| format!("load_snapshot_reuse: {e}"))?;
    if compacted {
        return Ok(RefreshFileOutcome::defer());
    }

    // Materialize the new file (copy prev → new) and apply the delta onto it (identical to refresh_to_file).
    let _ = std::fs::remove_file(new_path);
    std::fs::copy(prev_path, new_path).map_err(|e| format!("copy prev→new: {e}"))?;
    let conn = Connection::open(new_path).map_err(|e| format!("open {new_path}: {e}"))?;

    let outcome = refresh_store(&conn, &snap, mapping, &fm.state);
    if outcome.need_full_rebuild {
        return Ok(RefreshFileOutcome::rebuild());
    }
    if outcome.skipped {
        return Ok(RefreshFileOutcome {
            skipped: true,
            ..counts_of(&conn, &fm)
        });
    }

    let new_state = compute_state(&snap, mapping);
    let fp = crate::fingerprint::fingerprint(&snap);
    write_meta(
        &conn,
        &fp.hash,
        fm.mapping_version.as_deref(),
        snap.lossy,
        &source_sig,
        &new_state,
    )?;
    let out = counts_of(&conn, &fm);
    conn.close().map_err(|(_, e)| format!("close: {e}"))?;
    Ok(out)
}

fn counts_of(conn: &Connection, fm: &FileMeta) -> RefreshFileOutcome {
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
    RefreshFileOutcome {
        need_full_rebuild: false,
        skipped: false,
        deferred: false,
        fingerprint: fm.fingerprint.clone(),
        mapping_version: fm.mapping_version.clone(),
        self_mri: fm.state.self_mri.clone(),
        lossy: fm.lossy,
        conversations: count("conversations"),
        messages: count("messages"),
        people: count("people"),
        earliest_ts,
    }
}

/// Result of a native file-refresh — the StoreMeta bits TS folds in after swapping to the new file.
// The four flags are independent refresh outcomes (rebuild / skip / defer / lossy) marshaled flat to
// TS via `RefreshResult`; an enum wouldn't map to the `#[napi(object)]` shape the reader expects.
#[allow(clippy::struct_excessive_bools)]
pub struct RefreshFileOutcome {
    pub need_full_rebuild: bool,
    pub skipped: bool,
    /// Copy-reuse only: a compaction consumed a cached `.ldb`, so the reuse path can't be trusted for a
    /// delta — the caller falls back to the cacheless reparse (`refresh_to_file`). No file was written.
    pub deferred: bool,
    pub fingerprint: String,
    pub mapping_version: Option<String>,
    pub self_mri: Option<String>,
    pub lossy: bool,
    pub conversations: i64,
    pub messages: i64,
    pub people: i64,
    pub earliest_ts: i64,
}
impl RefreshFileOutcome {
    fn rebuild() -> Self {
        RefreshFileOutcome {
            need_full_rebuild: true,
            skipped: false,
            deferred: false,
            fingerprint: String::new(),
            mapping_version: None,
            self_mri: None,
            lossy: false,
            conversations: 0,
            messages: 0,
            people: 0,
            earliest_ts: 0,
        }
    }
    // Copy-reuse compaction: nothing written, caller must reparse. Carries no counts (unused on defer).
    fn defer() -> Self {
        RefreshFileOutcome {
            need_full_rebuild: false,
            skipped: false,
            deferred: true,
            fingerprint: String::new(),
            mapping_version: None,
            self_mri: None,
            lossy: false,
            conversations: 0,
            messages: 0,
            people: 0,
            earliest_ts: 0,
        }
    }
}
