//! Incremental refresh (delta apply; port of applyIncremental) + the writer↔reader file contract
//! (PRAGMA user_version + the in-file `_meta` table). A refresh opens the previous file, reads its
//! `_meta` floor, applies the delta up to the current sequence (delete-missing-chains +
//! delete-changed-chains + re-extract-changed + whole-replace profiles/events/calls + conversation
//! reconcile + recomputeDerived + delta FTS), and rewrites `_meta`. The previous file is never
//! mutated — TS swaps to the new file.

use std::collections::{BTreeMap, HashSet};

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
/// v2: `_meta` gained `source_sig` (the leveldb source-file signature for the no-op refresh gate).
/// v3: `_meta` gained `store_sigs` (per-store change signatures for the unchanged-store whole-replace
/// skip); a v2 file lacks the column, so the version gate forces a full rebuild rather than reading it.
pub const USER_VERSION: i32 = 3;

/// The state carried between refreshes (what a full ingest recorded so a later delta can validate the
/// schema hasn't shifted + knows the sequence floor). Mirrors TS IngestState, minus the mapping (the
/// caller reuses the same mapping — re-selected by mappingVersion from the file's _meta).
pub struct RefreshState {
    pub self_mri: Option<String>,
    pub max_seq: u64,
    pub msg_targets: Vec<String>,  // sorted (entity_targets_for sorts)
    pub conv_targets: Vec<String>, // sorted
    /// Per-store change signatures (entity → `entity_sig`) as of this state, for the unchanged-store
    /// whole-replace skip: a store whose signature is unchanged next tick is byte-identical and its
    /// replace is skipped. Keyed by entity (profile/event/call/conversation).
    pub store_sigs: BTreeMap<String, String>,
}

pub struct RefreshOutcome {
    pub need_full_rebuild: bool, // schema tripwire / error → caller must full-rebuild
    pub skipped: bool,           // lossy load → nothing applied, retry next refresh
    pub new_max_seq: u64,
    pub skipped_stores: u8, // unchanged stores whose whole-replace/reconcile was skipped this tick
}

/// The RefreshState a full ingest of `snap` would record (self_mri + maxSeq + mapped-store targets +
/// per-store change signatures).
pub fn compute_state(snap: &Snapshot, mapping: &Value) -> RefreshState {
    let msgs = extract_rows(snap, mapping, "message");
    RefreshState {
        self_mri: vote_self_mri(&msgs),
        max_seq: snap.max_seq,
        msg_targets: entity_targets_for(snap, mapping, "message"),
        conv_targets: entity_targets_for(snap, mapping, "conversation"),
        store_sigs: store_sigs(snap, mapping),
    }
}

/// Cheap per-store change signature: the sorted `target:max_seq:count` over the entity's mapped buckets
/// — bucket METADATA only, NO structured-clone decode. Two ticks with the same signature ⇒ the store's
/// live records are byte-identical: leveldb sequences are global + strictly monotonic, so any add/edit
/// gives its record the newest seq (lifting the bucket's `max_seq`) and any delete drops the live
/// `count`; and including the target SET makes a db/store rename (which shifts the targets) change the
/// signature too. So an unchanged signature ⇒ the store's whole-replace can be skipped (already correct).
fn entity_sig(snap: &Snapshot, mapping: &Value, entity: &str) -> String {
    entity_targets_for(snap, mapping, entity)
        .iter()
        .map(|t| {
            let (max_seq, count) = snap
                .buckets
                .iter()
                .find(|b| format!("{}:{}", b.db_id, b.os_id) == *t)
                .map_or((0u64, 0usize), |b| (b.max_seq, b.records.len()));
            format!("{t}:{max_seq}:{count}")
        })
        .collect::<Vec<_>>()
        .join(",")
}

/// Signatures for the skippable stores (profiles/events/calls/conversations). Cheap (no decode).
pub(crate) fn store_sigs(snap: &Snapshot, mapping: &Value) -> BTreeMap<String, String> {
    ["profile", "event", "call", "conversation"]
        .into_iter()
        .map(|e| (e.to_string(), entity_sig(snap, mapping, e)))
        .collect()
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
            skipped_stores: 0,
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
            skipped_stores: 0,
        };
    }
    // no-op fast-exit: maxSeq counts tombstones too, so equal ⇒ nothing landed since the last apply.
    if snap.max_seq == state.max_seq {
        return RefreshOutcome {
            need_full_rebuild: false,
            skipped: false,
            new_max_seq: snap.max_seq,
            skipped_stores: 0,
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
    // Whether any WHOLE chain disappeared this tick — the only way (besides a conv-store change) a
    // conversation can become newly-orphaned, so it gates the conversation-reconcile skip below.
    let missing = delete_messages_for_missing_chains(conn, &live);
    let missing_happened = !missing.is_empty();
    for id in missing {
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
    // Unchanged-store skip: a mapped small store whose signature matches the prior state's is
    // byte-identical (see `entity_sig`), so its whole-replace is skipped — the table is already
    // correct. On the common message-only tick this skips re-decoding + rewriting profiles/events/calls.
    let unchanged = |entity: &str| {
        state.store_sigs.get(entity).map(String::as_str)
            == Some(entity_sig(snap, mapping, entity).as_str())
    };
    let mut skipped_stores = 0u8;
    if unchanged("profile") {
        skipped_stores += 1;
    } else {
        replace_profiles(conn, &extract_rows(snap, mapping, "profile"));
    }
    if unchanged("event") {
        skipped_stores += 1;
    } else {
        replace_events(conn, &extract_rows(snap, mapping, "event"));
    }
    if unchanged("call") {
        skipped_stores += 1;
    } else {
        replace_calls(conn, &extract_rows(snap, mapping, "call"));
    }
    // Conversation reconcile (reset meta cols → re-apply from the conv store → drop orphans not
    // referenced by messages). Skip it ONLY when the conversation store is unchanged AND no whole chain
    // was deleted this tick — the two (and only) ways a conversation can newly-orphan or change meta.
    // When skipped, recompute_derived (below) still refreshes message-driven aggregates + materializes
    // any message-only conversation, so the store stays == a full rebuild.
    if unchanged("conversation") && !missing_happened {
        skipped_stores += 1;
    } else {
        reconcile_conversations(conn, snap, mapping, &mut handles);
    }
    conn.execute_batch("COMMIT").unwrap();

    recompute_derived(conn, self_mri, &mut handles);
    refresh_fts_delta(conn, &fts_ids);
    RefreshOutcome {
        need_full_rebuild: false,
        skipped: false,
        new_max_seq: snap.max_seq,
        skipped_stores,
    }
}

// Reconcile the conversation store: reset the live-meta cols, re-apply meta from the conversation
// store, and drop orphans (conversations neither in the live conv set nor referenced by any message).
// Run only when the conversation store changed or a whole chain was deleted (see refresh_store).
fn reconcile_conversations(
    conn: &Connection,
    snap: &Snapshot,
    mapping: &Value,
    handles: &mut Handles,
) {
    let conv_rows = extract_rows(snap, mapping, "conversation");
    conn.execute_batch(
        "update conversations set topic=null, team_id=null, thread_type=null, meta_last_ts=0",
    )
    .unwrap();
    apply_conversation_meta(conn, &conv_rows, handles);
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
           max_seq int, msg_targets text, conv_targets text, source_sig text, store_sigs text);
         delete from _meta;",
    )
    .map_err(|e| format!("_meta create: {e}"))?;
    conn.execute(
        "insert into _meta(fingerprint,mapping_version,self_mri,lossy,max_seq,msg_targets,conv_targets,source_sig,store_sigs)
         values(?,?,?,?,?,?,?,?,?)",
        params![
            fingerprint,
            mapping_version,
            state.self_mri,
            lossy as i64,
            state.max_seq as i64,
            targets_json(&state.msg_targets),
            targets_json(&state.conv_targets),
            source_sig,
            serde_json::to_string(&state.store_sigs).unwrap_or_else(|_| "{}".into()),
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
                store_sigs: BTreeMap::new(),
            },
            source_sig: None,
        });
    }
    let parse_targets =
        |s: String| -> Vec<String> { serde_json::from_str::<Vec<String>>(&s).unwrap_or_default() };
    conn.query_row(
        "select fingerprint,mapping_version,self_mri,lossy,max_seq,msg_targets,conv_targets,source_sig,store_sigs from _meta limit 1",
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
                    store_sigs: serde_json::from_str(
                        &r.get::<_, Option<String>>(8)?.unwrap_or_default(),
                    )
                    .unwrap_or_default(),
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

#[cfg(test)]
mod composed_tests {
    //! Composed correctness of `reuse_refresh_to_file` on REAL data. Env-gated: runs only when
    //! `ZAUNGAST_TEST_DIR` points at a leveldb dir, otherwise it skips (so dep-free `cargo test`/CI
    //! stays green). `diffreuse` proves the reuse LOADER == full and `diffincr` proves `refresh_store`
    //! == full; this closes the last gap — that their COMPOSITION in the FILE wrapper (R3 gate + defer
    //! ordering + copy + delta-apply + `_meta` rewrite) is ALSO byte-identical to a full rebuild, for
    //! a cold AND a warm cache. Self-oracle (== a native full rebuild); no new TS oracle needed.
    use super::{compute_state, refresh_store, reuse_refresh_to_file, write_meta};
    use crate::fingerprint::fingerprint;
    use crate::idb::{load_snapshot, load_snapshot_capped, LdbCache};
    use crate::resolver::{entity_targets_for, select_mapping, store_set_from_fp};
    use crate::store::{build_store, store_report};
    use rusqlite::{params, Connection};
    use serde_json::Value;
    use std::path::PathBuf;

    fn crate_rel(p: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(p)
    }

    // Single-source schema + first registered mapping JSON text (mirrors harness/run.mjs), read from
    // the sibling libzaungast package relative to this crate.
    fn schema_and_mappings() -> (String, Vec<String>) {
        let schema = std::fs::read_to_string(crate_rel("../libzaungast/src/schema.sql"))
            .expect("read schema.sql");
        let reg = std::fs::read_to_string(crate_rel("../libzaungast/src/schema/mappings.json"))
            .expect("read mappings.json");
        let first = serde_json::from_str::<Vec<String>>(&reg).expect("registry")[0].clone();
        let text =
            std::fs::read_to_string(crate_rel("../libzaungast/src/schema/versions").join(&first))
                .expect("read mapping.json");
        (schema, vec![text])
    }

    #[test]
    fn reuse_refresh_composed_equals_full() {
        let Ok(dir) = std::env::var("ZAUNGAST_TEST_DIR") else {
            eprintln!(
                "SKIP reuse_refresh_composed_equals_full — set ZAUNGAST_TEST_DIR to a leveldb dir"
            );
            return;
        };
        let (schema, mappings_json) = schema_and_mappings();
        let mappings: Vec<Value> =
            vec![serde_json::from_str(&mappings_json[0]).expect("parse mapping")];

        // Full snapshot → the mapping → the full-rebuild store report (the oracle).
        let full = load_snapshot(&dir).expect("load_snapshot");
        let full_fp = fingerprint(&full);
        let mapping = select_mapping(
            &full_fp.hash,
            &store_set_from_fp(&full_fp.stores),
            &mappings,
        )
        .expect("no mapping matched the dir");
        let full_report = store_report(&build_store(&full, mapping, &schema));

        // "Previous" store as of cap = maxSeq/2, written to a FILE. VACUUM INTO copies the in-memory
        // build (incl. FTS) to a real file; write_meta then stamps the incremental floor + user_version
        // with source_sig="" so R3's no-op gate never short-circuits (we WANT the delta path exercised).
        let cap = full.max_seq / 2;
        let capped = load_snapshot_capped(&dir, cap).expect("load_snapshot_capped");
        let prev_path = std::env::temp_dir().join("zaungast-reuse-prev.db");
        let _ = std::fs::remove_file(&prev_path);
        {
            let mem = build_store(&capped, mapping, &schema);
            mem.execute("VACUUM INTO ?1", params![prev_path.to_str().unwrap()])
                .expect("VACUUM INTO prev");
        }
        {
            let prev = Connection::open(&prev_path).expect("open prev");
            let state = compute_state(&capped, mapping);
            let mv = mapping.get("mappingVersion").and_then(Value::as_str);
            write_meta(
                &prev,
                &fingerprint(&capped).hash,
                mv,
                capped.lossy,
                "",
                &state,
            )
            .expect("write prev _meta");
        }

        let report_of = |p: &PathBuf| store_report(&Connection::open(p).expect("open store"));
        let mut cache = LdbCache::new();

        // Cold cache: reuse-refresh the capped prev up to the full sequence.
        let cold_path = std::env::temp_dir().join("zaungast-reuse-cold.db");
        let o1 = reuse_refresh_to_file(
            &dir,
            prev_path.to_str().unwrap(),
            cold_path.to_str().unwrap(),
            &mappings_json,
            &mut cache,
        )
        .expect("reuse cold");
        assert!(
            !o1.need_full_rebuild && !o1.skipped && !o1.deferred,
            "cold: delta applied (no rebuild/skip/defer)"
        );
        assert!(cache.has_prefix(), "cold reuse built the folded prefix");
        let cold_report = report_of(&cold_path);

        // Warm cache: same (never-mutated) prev, reuse the cached parses → identical store.
        let warm_path = std::env::temp_dir().join("zaungast-reuse-warm.db");
        let o2 = reuse_refresh_to_file(
            &dir,
            prev_path.to_str().unwrap(),
            warm_path.to_str().unwrap(),
            &mappings_json,
            &mut cache,
        )
        .expect("reuse warm");
        assert!(
            !o2.need_full_rebuild && !o2.skipped && !o2.deferred,
            "warm: delta applied (no rebuild/skip/defer)"
        );
        let warm_report = report_of(&warm_path);

        assert_eq!(
            cold_report, full_report,
            "cold reuse-refresh == full rebuild"
        );
        assert_eq!(
            warm_report, full_report,
            "warm reuse-refresh == full rebuild"
        );

        for p in [prev_path, cold_path, warm_path] {
            let _ = std::fs::remove_file(p);
        }
    }

    // A compaction (a cached `.ldb` vanishing) must make `reuse_refresh_to_file` DEFER: no file
    // written, so the Session falls back to the cacheless reparse (which reconciles the elided
    // deletion). Exercises the compacted → `defer()` early-out through the whole file wrapper — the
    // pure-Rust half of Q6's mandatory compaction scenario (the live forced-compaction is a WSL leg).
    #[test]
    fn reuse_refresh_defers_on_compaction() {
        let Ok(src) = std::env::var("ZAUNGAST_TEST_DIR") else {
            eprintln!("SKIP reuse_refresh_defers_on_compaction — set ZAUNGAST_TEST_DIR");
            return;
        };
        let (schema, mappings_json) = schema_and_mappings();
        let mappings: Vec<Value> =
            vec![serde_json::from_str(&mappings_json[0]).expect("parse mapping")];

        // Mutable copy of the source dir (we delete an `.ldb` from it to force a compaction).
        let m = std::env::temp_dir().join("zaungast-reuse-compact-src");
        let _ = std::fs::remove_dir_all(&m);
        std::fs::create_dir_all(&m).expect("mkdir M");
        for e in std::fs::read_dir(&src).expect("read src") {
            let e = e.expect("dirent");
            if e.file_type().is_ok_and(|t| t.is_file()) {
                std::fs::copy(e.path(), m.join(e.file_name())).expect("copy file");
            }
        }
        let m = m.to_str().unwrap().to_string();

        let full = load_snapshot(&m).expect("load_snapshot M");
        let full_fp = fingerprint(&full);
        let mapping = select_mapping(
            &full_fp.hash,
            &store_set_from_fp(&full_fp.stores),
            &mappings,
        )
        .expect("no mapping matched M");

        // Prev store as of cap, source_sig="" so R3 never short-circuits (the reuse load must run).
        let cap = full.max_seq / 2;
        let capped = load_snapshot_capped(&m, cap).expect("capped");
        let prev_path = std::env::temp_dir().join("zaungast-reuse-compact-prev.db");
        let _ = std::fs::remove_file(&prev_path);
        {
            let mem = build_store(&capped, mapping, &schema);
            mem.execute("VACUUM INTO ?1", params![prev_path.to_str().unwrap()])
                .expect("VACUUM INTO prev");
        }
        {
            let prev = Connection::open(&prev_path).expect("open prev");
            let state = compute_state(&capped, mapping);
            let mv = mapping.get("mappingVersion").and_then(Value::as_str);
            write_meta(
                &prev,
                &fingerprint(&capped).hash,
                mv,
                capped.lossy,
                "",
                &state,
            )
            .expect("write prev _meta");
        }

        let mut cache = LdbCache::new();
        // Tick 1: a normal reuse refresh WARMS the cache with M's current `.ldb` set.
        let new1 = std::env::temp_dir().join("zaungast-reuse-compact-new1.db");
        let o1 = reuse_refresh_to_file(
            &m,
            prev_path.to_str().unwrap(),
            new1.to_str().unwrap(),
            &mappings_json,
            &mut cache,
        )
        .expect("tick1");
        assert!(
            !o1.deferred && !o1.need_full_rebuild,
            "tick1 applies + warms the cache"
        );
        assert!(cache.has_prefix(), "tick1 built the folded prefix");

        // Compaction: delete an `.ldb` the cache now holds.
        let victim = {
            let mut ldbs: Vec<String> = std::fs::read_dir(&m)
                .unwrap()
                .filter_map(Result::ok)
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .filter(|f| {
                    std::path::Path::new(f)
                        .extension()
                        .is_some_and(|e| e == "ldb")
                })
                .collect();
            ldbs.sort();
            ldbs.into_iter().next().expect("at least one .ldb")
        };
        std::fs::remove_file(std::path::Path::new(&m).join(&victim)).expect("remove .ldb");

        // Tick 2: a cached `.ldb` vanished → MUST defer, writing no file.
        let new2 = std::env::temp_dir().join("zaungast-reuse-compact-new2.db");
        let _ = std::fs::remove_file(&new2);
        let o2 = reuse_refresh_to_file(
            &m,
            prev_path.to_str().unwrap(),
            new2.to_str().unwrap(),
            &mappings_json,
            &mut cache,
        )
        .expect("tick2");
        assert!(o2.deferred, "tick2 defers on compaction");
        assert!(
            !o2.need_full_rebuild && !o2.skipped,
            "defer, not rebuild/skip"
        );
        assert!(!new2.exists(), "defer writes no new file");

        let _ = std::fs::remove_dir_all(&m);
        for p in [prev_path, new1, new2] {
            let _ = std::fs::remove_file(p);
        }
    }

    // The unchanged-store skip (★d): with a cap ABOVE every profile/event/call/conversation bucket
    // seq (so those stores are identical in the capped prev and the full snapshot), a capped→full
    // refresh must SKIP all four small stores AND still produce a store byte-identical to a full
    // rebuild. The load-bearing gate on the skip PATH — the differential/composed tests use
    // cap=maxSeq/2, which exercises the whole-replace path, not the skip.
    #[test]
    fn refresh_skips_unchanged_stores() {
        let Ok(dir) = std::env::var("ZAUNGAST_TEST_DIR") else {
            eprintln!("SKIP refresh_skips_unchanged_stores — set ZAUNGAST_TEST_DIR");
            return;
        };
        let (schema, mappings_json) = schema_and_mappings();
        let mappings: Vec<Value> =
            vec![serde_json::from_str(&mappings_json[0]).expect("parse mapping")];
        let full = load_snapshot(&dir).expect("load_snapshot");
        let full_fp = fingerprint(&full);
        let mapping = select_mapping(
            &full_fp.hash,
            &store_set_from_fp(&full_fp.stores),
            &mappings,
        )
        .expect("no mapping matched the dir");

        // cap = the max bucket seq across the four small stores → they're all ≤ cap ⇒ identical in the
        // capped prev and the full snapshot ⇒ their signatures match ⇒ the refresh skips them.
        let cap = ["profile", "event", "call", "conversation"]
            .iter()
            .flat_map(|e| entity_targets_for(&full, mapping, e))
            .filter_map(|t| {
                full.buckets
                    .iter()
                    .find(|b| format!("{}:{}", b.db_id, b.os_id) == t)
                    .map(|b| b.max_seq)
            })
            .max()
            .unwrap_or(0);
        if full.max_seq <= cap {
            eprintln!("SKIP — no message records above the small-store max seq to form a delta");
            return;
        }

        let capped = load_snapshot_capped(&dir, cap).expect("load_snapshot_capped");
        let prev = build_store(&capped, mapping, &schema); // in-memory prev as of cap
        let state = compute_state(&capped, mapping);
        let outcome = refresh_store(&prev, &full, mapping, &state);
        assert!(
            !outcome.need_full_rebuild && !outcome.skipped,
            "the delta applied (not rebuild/skip)"
        );
        assert_eq!(
            outcome.skipped_stores, 4,
            "all four small stores unchanged at this cap → skipped"
        );
        assert_eq!(
            store_report(&prev),
            store_report(&build_store(&full, mapping, &schema)),
            "skip-path refresh == full rebuild"
        );
    }
}
