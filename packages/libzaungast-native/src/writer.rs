//! The SQLite store writer — port of ingest.ts's apply* + store.ts. Builds an in-memory ChatStore
//! (rusqlite) from a snapshot + mapping: conversation meta, messages (with htmlToText/reactions/
//! flags/root_id), profiles/events/calls (with compaction), then recomputeDerived (people + conv
//! aggregates + handles) and FTS. The recomputeDerived/FTS SQL is pure SQLite → reused verbatim; only
//! row-building is Rust. Verified via a per-table content differential vs a TS full rebuild.

use std::collections::{HashMap, HashSet};

use rusqlite::{params, Connection};
use serde_json::Value;

use crate::html::html_to_text;
use crate::idb::Snapshot;
use crate::resolver::extract_rows;
use crate::sha256::make_handle;
use crate::sstable::{crc32c_final, crc32c_init, crc32c_update};
use crate::ssv::Ssv;

// The schema DDL is NOT embedded here: it is passed in by the caller (TS reads the single-source
// libzaungast/src/schema.sql and hands us the exact string), so the two engines' schemas can't drift.
const FTS_CREATE: &str = "create virtual table messages_fts using fts5(content, conv_id unindexed, id unindexed, tokenize='porter unicode61');";

/// PRAGMA user_version stamped into every native-written .db — the freshness/staleness gate. TS
/// validates it on open; a mismatch means the file was written by an incompatible lib version (or the
/// schema generation was hand-bumped) → refuse to serve / full-rebuild. Schema-independent, readable
/// without assuming any table exists. Bump whenever the on-disk store layout changes meaningfully.
pub const USER_VERSION: i32 = 1;

// ---- Ssv field accessors + JS coercions ----
fn get<'a>(v: &'a Ssv, k: &str) -> Option<&'a Ssv> {
    match v {
        Ssv::Object(p) => p.iter().find(|(kk, _)| kk == k).map(|(_, x)| x),
        _ => None,
    }
}
fn as_str<'a>(v: Option<&'a Ssv>) -> Option<&'a str> {
    match v {
        Some(Ssv::Str(s)) => Some(s),
        _ => None,
    }
}
fn is_true(v: Option<&Ssv>) -> bool {
    matches!(v, Some(Ssv::Bool(true)))
}
fn is_truthy(v: Option<&Ssv>) -> bool {
    match v {
        None | Some(Ssv::Null) | Some(Ssv::Undefined) | Some(Ssv::Bool(false)) => false,
        Some(Ssv::Num(n)) => *n != 0.0 && !n.is_nan(),
        Some(Ssv::Str(s)) => !s.is_empty(),
        _ => true,
    }
}
// JS Number(v)
fn to_num(v: Option<&Ssv>) -> f64 {
    match v {
        Some(Ssv::Num(n)) => *n,
        Some(Ssv::Date(ms)) => *ms,
        Some(Ssv::Bool(b)) => {
            if *b {
                1.0
            } else {
                0.0
            }
        }
        Some(Ssv::Null) | None => 0.0,
        Some(Ssv::Str(s)) => {
            let t = s.trim();
            if t.is_empty() {
                0.0
            } else {
                t.parse::<f64>().unwrap_or(f64::NAN)
            }
        }
        _ => f64::NAN,
    }
}
// `X != null` in JS (not null AND not undefined) → String(X)
fn to_js_string(v: Option<&Ssv>) -> Option<String> {
    match v {
        None | Some(Ssv::Null) | Some(Ssv::Undefined) => None,
        Some(Ssv::Str(s)) => Some(s.clone()),
        Some(Ssv::Num(n)) => Some(num_to_js_string(*n)),
        Some(Ssv::Bool(b)) => Some(if *b { "true".into() } else { "false".into() }),
        _ => Some(String::new()), // objects/arrays → String() would be "[object Object]"/join; not used by these fields
    }
}
fn num_to_js_string(n: f64) -> String {
    if n.fract() == 0.0 && n.is_finite() && n.abs() < 1e21 {
        format!("{}", n as i64)
    } else {
        format!("{}", n)
    }
}

// ---- transforms ----
fn conv_kind(id: &str) -> &'static str {
    if id.contains("@unq.gbl.spaces") {
        "1:1"
    } else if id.contains("meeting_") {
        "meeting"
    } else if id.contains("@thread.v2") {
        "group"
    } else if id.contains("@thread.skype") || id.contains("@thread.tacv2") {
        "channel"
    } else {
        "other"
    }
}

fn is_system_message(m: &Ssv) -> bool {
    if let Some(t) = as_str(get(m, "type")) {
        if t != "Message" {
            return true;
        }
    }
    let mt = as_str(get(m, "messageType")).unwrap_or("");
    let l = mt.to_ascii_lowercase();
    l.starts_with("threadactivity/") || l.contains("control") || l.contains("event") || l.contains("systemmessage")
}

fn has_attachment(m: &Ssv, html: &str) -> bool {
    let hl = html.to_ascii_lowercase();
    if hl.contains("<img") || hl.contains("itemid=") || hl.contains("hostedcontents") || hl.contains("/v1/objects/") {
        return true;
    }
    for k in ["files", "cards", "attachments"] {
        match get(m, k) {
            Some(Ssv::Str(s)) => {
                if s.len() > 2 && s != "[]" {
                    return true;
                }
            }
            Some(Ssv::Array { items, .. }) => {
                if !items.is_empty() {
                    return true;
                }
            }
            _ => {}
        }
    }
    false
}

fn mentioned_mris(m: &Ssv) -> Vec<String> {
    let mentions = match get(m, "mentions") {
        Some(v) => v,
        None => return vec![],
    };
    // object with .properties.mentions → unwrap
    let raw = match mentions {
        Ssv::Object(_) => get(mentions, "properties").and_then(|p| get(p, "mentions")).unwrap_or(mentions),
        other => other,
    };
    let pick = |o: &Ssv| -> Option<String> {
        for k in ["mri", "itemid", "id"] {
            if let Some(s) = as_str(get(o, k)) {
                if !s.is_empty() {
                    return Some(s.to_string());
                }
            }
        }
        None
    };
    match raw {
        Ssv::Array { items, .. } => items.iter().filter_map(pick).collect(),
        Ssv::Str(s) => match serde_json::from_str::<Value>(s) {
            Ok(Value::Array(a)) => a
                .iter()
                .filter_map(|o| {
                    for k in ["mri", "itemid", "id"] {
                        if let Some(v) = o.get(k).and_then(|x| x.as_str()) {
                            if !v.is_empty() {
                                return Some(v.to_string());
                            }
                        }
                    }
                    None
                })
                .collect(),
            _ => vec![],
        },
        _ => vec![],
    }
}

// vote the current-user MRI: most-frequent senderId among isSentByCurrentUser messages (first-seen tiebreak).
fn vote_self_mri(msgs: &[Ssv]) -> Option<String> {
    let mut order: Vec<String> = Vec::new();
    let mut votes: HashMap<String, u32> = HashMap::new();
    for m in msgs {
        if is_true(get(m, "isSentByCurrentUser")) {
            if let Some(sid) = as_str(get(m, "senderId")) {
                if !votes.contains_key(sid) {
                    order.push(sid.to_string());
                }
                *votes.entry(sid.to_string()).or_insert(0) += 1;
            }
        }
    }
    order.into_iter().max_by_key(|k| votes[k]) // max_by_key keeps the FIRST max on ties (stable over the ordered vec)
}

// ---- JSON building (matches JSON.stringify) ----
fn json_str(s: &str, out: &mut String) {
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

fn compact_reactions(emotions: Option<&Ssv>) -> Option<String> {
    let items = match emotions {
        Some(Ssv::Array { items, .. }) if !items.is_empty() => items,
        _ => return None,
    };
    let mut groups: Vec<(String, Vec<(String, f64)>)> = Vec::new();
    for e in items {
        let key = match as_str(get(e, "key")) {
            Some(k) => k.to_string(),
            None => continue,
        };
        let users = match get(e, "users") {
            Some(Ssv::Array { items, .. }) if !items.is_empty() => items,
            _ => continue,
        };
        let mut u: Vec<(String, f64)> = Vec::new();
        for usr in users {
            if let Some(mri) = as_str(get(usr, "mri")) {
                let time = to_num(get(usr, "time"));
                let time = if time.is_nan() { 0.0 } else { time }; // Number(time)||0
                u.push((mri.to_string(), time));
            }
        }
        if u.is_empty() {
            continue;
        }
        u.sort_by(|a, b| a.0.cmp(&b.0));
        groups.push((key, u));
    }
    if groups.is_empty() {
        return None;
    }
    groups.sort_by(|a, b| a.0.cmp(&b.0));
    let mut out = String::from("[");
    for (i, (k, u)) in groups.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str("{\"k\":");
        json_str(k, &mut out);
        out.push_str(",\"u\":[");
        for (j, (mri, t)) in u.iter().enumerate() {
            if j > 0 {
                out.push(',');
            }
            out.push('[');
            json_str(mri, &mut out);
            out.push(',');
            out.push_str(&num_to_js_string(*t));
            out.push(']');
        }
        out.push_str("]}");
    }
    out.push(']');
    Some(out)
}

fn compact_attendees(attendees: Option<&Ssv>) -> Option<String> {
    let items = match attendees {
        Some(Ssv::Array { items, .. }) if !items.is_empty() => items,
        _ => return None,
    };
    let mut out: Vec<(String, String, String)> = Vec::new();
    for a in items {
        let ty = as_str(get(a, "type")).unwrap_or("").to_ascii_lowercase();
        if ty == "resource" {
            continue;
        }
        let n = to_js_string(get(a, "name")).unwrap_or_default();
        let e = to_js_string(get(a, "address")).unwrap_or_default();
        let r = get(a, "status").and_then(|s| to_js_string(get(s, "response"))).unwrap_or_default();
        if n.is_empty() && e.is_empty() {
            continue;
        }
        out.push((n, e, r));
    }
    if out.is_empty() {
        return None;
    }
    out.sort_by(|a, b| if a.0 == b.0 { a.1.cmp(&b.1) } else { a.0.cmp(&b.0) });
    let mut s = String::from("[");
    for (i, (n, e, r)) in out.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        s.push_str("{\"n\":");
        json_str(n, &mut s);
        s.push_str(",\"e\":");
        json_str(e, &mut s);
        s.push_str(",\"r\":");
        json_str(r, &mut s);
        s.push('}');
    }
    s.push(']');
    Some(s)
}

fn compact_participants(list: Option<&Ssv>) -> Option<String> {
    let items = match list {
        Some(Ssv::Array { items, .. }) if !items.is_empty() => items,
        _ => return None,
    };
    let mut out: Vec<(String, Option<String>)> = Vec::new();
    for p in items {
        if let Some(id) = as_str(get(p, "id")) {
            let name = to_js_string(get(p, "displayName"));
            out.push((id.to_string(), name));
        }
    }
    if out.is_empty() {
        return None;
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    let mut s = String::from("[");
    for (i, (mri, name)) in out.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        s.push_str("{\"mri\":");
        json_str(mri, &mut s);
        s.push_str(",\"name\":");
        match name {
            Some(n) => json_str(n, &mut s),
            None => s.push_str("null"),
        }
        s.push('}');
    }
    s.push(']');
    Some(s)
}

fn recording_link_of(r: &Ssv) -> Option<String> {
    // recordings[0].linkedMessage ?? transcript.linkedMessage
    let lm = get(r, "recordings")
        .and_then(|rec| if let Ssv::Array { items, .. } = rec { items.first() } else { None })
        .and_then(|r0| get(r0, "linkedMessage"))
        .or_else(|| get(r, "transcript").and_then(|t| get(t, "linkedMessage")))?;
    let conv = as_str(get(lm, "conversationId"))?;
    let msg = as_str(get(lm, "linkedMessageId"))?;
    let mut s = String::from("{\"conversationId\":");
    json_str(conv, &mut s);
    s.push_str(",\"linkedMessageId\":");
    json_str(msg, &mut s);
    s.push('}');
    Some(s)
}

fn to_epoch_ms(v: Option<&Ssv>) -> i64 {
    match v {
        Some(Ssv::Date(ms)) => *ms as i64,
        Some(Ssv::Num(n)) => *n as i64,
        // matches TS toEpochMs: `typeof v === 'string' -> Date.parse(v)` (NaN -> 0). Calls carry
        // startTime/endTime as an ISO-8601 string (e.g. "2026-05-11T12:50:41.5647378Z"); events
        // carry a real Date object, so only calls exercise this branch on production data.
        Some(Ssv::Str(s)) => parse_iso8601_ms(s).unwrap_or(0),
        _ => 0,
    }
}

// Date.parse of an ISO-8601 string, ms precision. Handles the extended format
// YYYY-MM-DDTHH:MM:SS[.frac][Z|±HH:MM]; fractional seconds are truncated to ms (floor),
// matching V8 (".5647378" -> 564). Returns None on anything it can't parse (caller -> 0).
fn parse_iso8601_ms(s: &str) -> Option<i64> {
    let s = s.trim();
    let b = s.as_bytes();
    let digits = |slice: &[u8]| -> Option<i64> {
        if slice.is_empty() || !slice.iter().all(|c| c.is_ascii_digit()) {
            return None;
        }
        std::str::from_utf8(slice).ok()?.parse::<i64>().ok()
    };
    // date: YYYY-MM-DD
    if b.len() < 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let year = digits(&b[0..4])?;
    let month = digits(&b[5..7])?;
    let day = digits(&b[8..10])?;
    let (mut hour, mut min, mut sec, mut frac_ms) = (0i64, 0i64, 0i64, 0i64);
    let mut offset_ms = 0i64;
    if b.len() > 10 {
        // separator: 'T' or space
        if b[10] != b'T' && b[10] != b' ' {
            return None;
        }
        let mut i = 11usize;
        if b.len() < i + 5 || b[i + 2] != b':' {
            return None;
        }
        hour = digits(&b[i..i + 2])?;
        min = digits(&b[i + 3..i + 5])?;
        i += 5;
        if i + 2 < b.len() && b[i] == b':' {
            sec = digits(&b[i + 1..i + 3])?;
            i += 3;
        }
        // optional fractional seconds
        if i < b.len() && b[i] == b'.' {
            let start = i + 1;
            let mut j = start;
            while j < b.len() && b[j].is_ascii_digit() {
                j += 1;
            }
            let frac = &b[start..j];
            if frac.is_empty() {
                return None;
            }
            // truncate/pad to 3 digits (floor to ms)
            let mut ms = [b'0'; 3];
            for k in 0..3 {
                if k < frac.len() {
                    ms[k] = frac[k];
                }
            }
            frac_ms = digits(&ms)?;
            i = j;
        }
        // timezone: Z | ±HH:MM | ±HHMM | (none = local; production is always Z)
        if i < b.len() {
            match b[i] {
                b'Z' => {}
                b'+' | b'-' => {
                    let sign = if b[i] == b'-' { -1 } else { 1 };
                    let rest = &b[i + 1..];
                    let (oh, om) = if rest.len() >= 5 && rest[2] == b':' {
                        (digits(&rest[0..2])?, digits(&rest[3..5])?)
                    } else if rest.len() >= 4 {
                        (digits(&rest[0..2])?, digits(&rest[2..4])?)
                    } else if rest.len() >= 2 {
                        (digits(&rest[0..2])?, 0)
                    } else {
                        return None;
                    };
                    offset_ms = sign * (oh * 60 + om) * 60_000;
                }
                _ => return None,
            }
        }
    }
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let days = days_from_civil(year, month, day);
    let ms = (((days * 24 + hour) * 60 + min) * 60 + sec) * 1000 + frac_ms;
    Some(ms - offset_ms)
}

// Howard Hinnant's days-from-civil: days since 1970-01-01 for a proleptic Gregorian date.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

// ---- handle assignment (6-hex sha1, collision-extended; matches store.ts handleFor) ----
struct Handles {
    used: HashSet<String>,
    by_full: HashMap<String, String>,
}
impl Handles {
    fn new() -> Self {
        Handles { used: HashSet::new(), by_full: HashMap::new() }
    }
    /// Seed the cache from an already-built store (native refresh opens the previous file). Existing
    /// conversations/people keep their handle, and a newly-inserted entity then gets a handle that
    /// AVOIDS `used` — so a 6-hex collision with an existing handle can't mint a duplicate that trips
    /// the `handle UNIQUE` constraint (which would panic → force a full rebuild). Makes refresh's
    /// handle assignment equal a full rebuild by construction, not by collision-free luck.
    fn seed_from(&mut self, conn: &Connection) {
        for (table, id_col) in [("conversations", "id"), ("people", "mri")] {
            let mut stmt = conn
                .prepare(&format!("select {id_col}, handle from {table} where handle is not null"))
                .unwrap();
            let rows = stmt
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
                .unwrap();
            for (full_id, handle) in rows.filter_map(Result::ok) {
                self.used.insert(handle.clone());
                self.by_full.insert(full_id, handle);
            }
        }
    }
    fn handle_for(&mut self, prefix: char, full_id: &str) -> String {
        if let Some(h) = self.by_full.get(full_id) {
            return h.clone();
        }
        for len in 6..=40 {
            let h = make_handle(prefix, full_id, len);
            if !self.used.contains(&h) {
                self.used.insert(h.clone());
                self.by_full.insert(full_id.to_string(), h.clone());
                return h;
            }
        }
        let fb = format!("{}:{}", prefix, &full_id.chars().take(12).collect::<String>());
        self.used.insert(fb.clone());
        self.by_full.insert(full_id.to_string(), fb.clone());
        fb
    }
}

fn latin1_hex(s: &str) -> String {
    let bytes: Vec<u8> = s.chars().map(|c| c as u8).collect();
    crate::sha256::hex(&bytes)
}

/// Build an in-memory ChatStore from a snapshot + mapping (full ingest). `schema` is the DDL string
/// handed in by the caller (the single-source libzaungast/src/schema.sql), execd verbatim.
pub fn build_store(snap: &Snapshot, mapping: &Value, schema: &str) -> Connection {
    let conn = Connection::open_in_memory().expect("open");
    conn.execute_batch(schema).expect("schema");
    conn.execute_batch(FTS_CREATE).expect("fts");
    populate(&conn, snap, mapping);
    conn
}

/// Populate an already-schema'd connection from a snapshot + mapping (the full-ingest apply* +
/// recompute + FTS spine, shared by the in-memory harness build and the file-writing napi path).
/// Returns the elected `selfMri` (the current user's MRI, or None).
fn populate(conn: &Connection, snap: &Snapshot, mapping: &Value) -> Option<String> {
    let msgs = extract_rows(snap, mapping, "message");
    let convs = extract_rows(snap, mapping, "conversation");
    let profiles = extract_rows(snap, mapping, "profile");
    let events = extract_rows(snap, mapping, "event");
    let calls = extract_rows(snap, mapping, "call");
    let self_mri = vote_self_mri(&msgs);
    let mut handles = Handles::new();

    conn.execute_batch("BEGIN").unwrap();
    apply_conversation_meta(conn, &convs, &mut handles);
    apply_messages(conn, &msgs, self_mri.as_deref());
    replace_profiles(conn, &profiles);
    replace_events(conn, &events);
    replace_calls(conn, &calls);
    conn.execute_batch("COMMIT").unwrap();

    recompute_derived(conn, self_mri.as_deref(), &mut handles);
    refresh_fts(conn);
    self_mri
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
    use crate::fingerprint::fingerprint;
    use crate::idb::load_snapshot;
    use crate::resolver::{select_mapping, store_set_from_fp};

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
    conn.execute_batch(schema).map_err(|e| format!("schema exec: {e}"))?;
    conn.execute_batch(FTS_CREATE).map_err(|e| format!("fts create: {e}"))?;

    let (schema_matched, mapping_version, self_mri) = match selected {
        Some(m) => {
            let self_mri = populate(&conn, &snap, m);
            // Write the in-file contract (_meta + user_version) so a later refresh reads its floor +
            // reuses this mapping. Build the state from populate's OWN outputs — its elected selfMri +
            // the cheap no-decode target lists — instead of compute_state, which would re-extract
            // (re-decode) the entire message store a second time.
            let ver = m.get("mappingVersion").and_then(|v| v.as_str()).map(|s| s.to_string());
            let state = RefreshState {
                self_mri,
                max_seq: snap.max_seq,
                msg_targets: crate::resolver::entity_targets_for(&snap, m, "message"),
                conv_targets: crate::resolver::entity_targets_for(&snap, m, "conversation"),
            };
            write_meta(&conn, &fp.hash, ver.as_deref(), snap.lossy, &state)?;
            (true, ver, state.self_mri)
        }
        // Unknown schema: an empty store (schema only), mirroring TS ingest (store loads, no rows).
        // Still stamp user_version + an empty _meta so the file is self-describing.
        None => {
            let empty = RefreshState { self_mri: None, max_seq: snap.max_seq, msg_targets: vec![], conv_targets: vec![] };
            write_meta(&conn, &fp.hash, None, snap.lossy, &empty)?;
            (false, None, None)
        }
    };

    let count = |t: &str| -> i64 {
        conn.query_row(&format!("select count(*) from {t}"), [], |r| r.get(0)).unwrap_or(0)
    };
    let earliest_ts: i64 = conn
        .query_row("select min(ts) from messages where ts>0", [], |r| r.get::<_, Option<i64>>(0))
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

fn apply_conversation_meta(conn: &Connection, convs: &[Ssv], handles: &mut Handles) {
    let mut stmt = conn
        .prepare(
            "insert into conversations(id,handle,kind,topic,team_id,thread_type,meta_last_ts) values(?,?,?,?,?,?,?)
             on conflict(id) do update set kind=excluded.kind, topic=excluded.topic, team_id=excluded.team_id, thread_type=excluded.thread_type, meta_last_ts=excluded.meta_last_ts",
        )
        .unwrap();
    for c in convs {
        let id = match as_str(get(c, "id")) {
            Some(i) if !i.is_empty() => i,
            _ => continue,
        };
        let handle = handles.handle_for('c', id);
        let topic = as_str(get(c, "topic")).filter(|s| !s.is_empty()).map(String::from); // c.topic || null
        let team_id = as_str(get(c, "teamId")).filter(|s| !s.is_empty()).map(String::from);
        let thread_type = as_str(get(c, "threadType")).filter(|s| !s.is_empty()).map(String::from);
        let meta_last = {
            let n = to_num(get(c, "lastMessageTimeUtc"));
            if n.is_nan() { 0 } else { n as i64 }
        };
        stmt.execute(params![id, handle, conv_kind(id), topic, team_id, thread_type, meta_last]).unwrap();
    }
}

// Insert/upsert message rows. Returns the id of every row processed (for a delta FTS refresh); the
// full-ingest caller ignores it. Mirrors applyMessages in TS (which likewise returns touched ids).
fn apply_messages(conn: &Connection, msgs: &[Ssv], self_mri: Option<&str>) -> Vec<String> {
    let mut ids: Vec<String> = Vec::with_capacity(msgs.len());
    let mut stmt = conn
        .prepare(
            "insert into messages
             (conv_id,id,chain_key,version,ts,sender_mri,sender_name,kind,is_mine,is_system,has_attach,mentions_me,content,reactions,root_id)
             values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
             on conflict(conv_id,id) do update set
               chain_key=excluded.chain_key, version=excluded.version, ts=excluded.ts,
               sender_mri=excluded.sender_mri, sender_name=excluded.sender_name, kind=excluded.kind,
               is_mine=excluded.is_mine, is_system=excluded.is_system, has_attach=excluded.has_attach,
               mentions_me=excluded.mentions_me, content=excluded.content, reactions=excluded.reactions,
               root_id=excluded.root_id
             where excluded.version >= messages.version",
        )
        .unwrap();
    for m in msgs {
        let conv_id = match as_str(get(m, "conversationId")) {
            Some(c) if !c.is_empty() => c.to_string(),
            _ => continue,
        };
        // ts = Number(time) || Date.parse(time) || Number(id) || 0  (JS `||` truthiness chain).
        // Number(time): Date → ms, numeric/numeric-string → n, ISO-string → NaN (falls through).
        // Real Teams data carries `time` as a Date; the synthetic fixture encodes it as an ISO
        // string, so the Date.parse fallback is load-bearing for fixture/dual-engine parity.
        let time = get(m, "time");
        let mut ts = to_num(time);
        if ts == 0.0 || ts.is_nan() {
            let dp = match time {
                Some(Ssv::Str(s)) => parse_iso8601_ms(s).unwrap_or(0),
                _ => 0,
            };
            if dp != 0 {
                ts = dp as f64;
            } else {
                let n = to_num(get(m, "id"));
                ts = if n.is_nan() { 0.0 } else { n };
            }
        }
        let ts = if ts.is_nan() { 0 } else { ts as i64 };
        let raw_html = as_str(get(m, "content")).unwrap_or("");
        let sender_mri = as_str(get(m, "senderId")).filter(|s| !s.is_empty()).unwrap_or("?").to_string();
        let is_mine = (self_mri == Some(sender_mri.as_str())) || is_true(get(m, "isSentByCurrentUser"));
        let mentions_me = self_mri.is_some()
            && !is_mine
            && mentioned_mris(m).iter().any(|x| Some(x.as_str()) == self_mri);
        let id_str = to_js_string(get(m, "id")).unwrap_or_default();
        let parent = to_js_string(get(m, "parentMessageId")).unwrap_or_default();
        let root_id = if !parent.is_empty() && parent != id_str { parent.clone() } else { id_str.clone() };
        let chain_key = as_str(get(m, "__key")).map(latin1_hex).unwrap_or_default();
        let version = {
            let n = to_num(get(m, "version"));
            if n.is_nan() { 0 } else { n as i64 }
        };
        let sender_name = as_str(get(m, "senderName")).unwrap_or("").to_string();
        stmt.execute(params![
            conv_id,
            id_str,
            chain_key,
            version,
            ts,
            sender_mri,
            sender_name,
            conv_kind(&conv_id),
            is_mine as i64,
            is_system_message(m) as i64,
            has_attachment(m, raw_html) as i64,
            mentions_me as i64,
            html_to_text(raw_html),
            compact_reactions(get(m, "reactions")),
            root_id,
        ])
        .unwrap();
        ids.push(id_str);
    }
    ids
}

fn replace_profiles(conn: &Connection, rows: &[Ssv]) {
    conn.execute_batch("delete from profiles").unwrap();
    let mut stmt = conn.prepare("insert or replace into profiles(mri,name) values(?,?)").unwrap();
    for r in rows {
        let mri = to_js_string(get(r, "mri")).unwrap_or_default();
        let name = to_js_string(get(r, "name")).unwrap_or_default();
        if !mri.is_empty() && !name.is_empty() {
            stmt.execute(params![mri, name]).unwrap();
        }
    }
}

fn replace_events(conn: &Connection, rows: &[Ssv]) {
    conn.execute_batch("delete from events").unwrap();
    let mut stmt = conn
        .prepare(
            "insert or replace into events(
               id,series_id,kind,subject,start_ts,end_ts,is_all_day,location,organizer_name,organizer_email,
               cid,my_response,show_as,is_cancelled,is_confidential,has_attach,attendees,body_html)
             values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .unwrap();
    for r in rows {
        if as_str(get(r, "eventType")) == Some("RecurringMaster") {
            continue;
        }
        let id = to_js_string(get(r, "id")).unwrap_or_else(|| as_str(get(r, "__key")).unwrap_or("").to_string());
        let cid_raw = as_str(get(r, "cid"));
        let cid = cid_raw.filter(|c| c.contains("19:meeting_")).map(String::from);
        let is_meeting = cid.is_some() || is_true(get(r, "isOnlineMeeting"));
        let is_confidential = is_truthy(get(r, "sensitivityLabelId")) || is_true(get(r, "doNotForward"));
        stmt.execute(params![
            id,
            to_js_string(get(r, "seriesId")),
            if is_meeting { "meeting" } else { "appointment" },
            to_js_string(get(r, "subject")),
            to_epoch_ms(get(r, "startTime")),
            to_epoch_ms(get(r, "endTime")),
            is_true(get(r, "isAllDay")) as i64,
            to_js_string(get(r, "location")),
            to_js_string(get(r, "organizerName")),
            to_js_string(get(r, "organizerEmail")),
            cid,
            to_js_string(get(r, "myResponse")),
            to_js_string(get(r, "showAs")),
            is_true(get(r, "isCancelled")) as i64,
            is_confidential as i64,
            is_true(get(r, "hasAttachments")) as i64,
            compact_attendees(get(r, "attendees")),
            to_js_string(get(r, "bodyContent")),
        ])
        .unwrap();
    }
}

fn replace_calls(conn: &Connection, rows: &[Ssv]) {
    conn.execute_batch("delete from calls").unwrap();
    let mut stmt = conn
        .prepare(
            "insert or replace into calls(
               id,call_type,direction,state,is_missed,start_ts,duration_ms,counterpart_mri,participants,
               group_thread_id,has_recording,recording_link,has_voicemail,spam_level,is_current_user_part,is_deleted)
             values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .unwrap();
    for r in rows {
        let direction = to_js_string(get(r, "callDirection"));
        let counterpart = if direction.as_deref() == Some("Outgoing") { get(r, "target") } else { get(r, "originator") };
        let counterpart_mri = counterpart.and_then(|c| to_js_string(get(c, "id")));
        let state = to_js_string(get(r, "callState"));
        let call_type = to_js_string(get(r, "callType"));
        let id = to_js_string(get(r, "id")).unwrap_or_else(|| as_str(get(r, "__key")).unwrap_or("").to_string());
        let duration = {
            let n = to_num(get(r, "durationInMs"));
            if n.is_nan() { 0 } else { n as i64 }
        };
        let has_recording = matches!(get(r, "recordings"), Some(Ssv::Array { items, .. }) if !items.is_empty());
        let participants = if call_type.as_deref() == Some("MultiParty") {
            compact_participants(get(r, "participantList"))
        } else {
            None
        };
        stmt.execute(params![
            id,
            call_type,
            direction,
            state,
            (state.as_deref() == Some("Missed")) as i64,
            to_epoch_ms(get(r, "startTime")),
            duration,
            counterpart_mri,
            participants,
            to_js_string(get(r, "groupChatThreadId")),
            has_recording as i64,
            recording_link_of(r),
            is_truthy(get(r, "voicemailMetadata")) as i64,
            to_js_string(get(r, "spamRiskLevel")),
            if get(r, "isCurrentUserPartOfCall") == Some(&Ssv::Bool(false)) { 0i64 } else { 1 },
            is_true(get(r, "isDeleted")) as i64,
        ])
        .unwrap();
    }
}

fn recompute_derived(conn: &Connection, self_mri: Option<&str>, handles: &mut Handles) {
    let self_s = self_mri.unwrap_or("");
    // message-only conversations (no conversation record)
    let missing: Vec<(String, String)> = {
        let mut stmt = conn
            .prepare("select conv_id, min(kind) kind from messages where conv_id not in (select id from conversations) group by conv_id order by conv_id")
            .unwrap();
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?.unwrap_or_default())))
            .unwrap();
        rows.filter_map(Result::ok).collect()
    };
    {
        let mut ins = conn.prepare("insert into conversations(id,handle,kind) values(?,?,?)").unwrap();
        for (conv_id, kind) in &missing {
            ins.execute(params![conv_id, handles.handle_for('c', conv_id), kind]).unwrap();
        }
    }
    // people (deterministic name = most-recent message)
    conn.execute_batch("delete from people").unwrap();
    let ppl: Vec<(String, i64, i64)> = {
        let mut stmt = conn
            .prepare("select sender_mri mri, count(*) c, max(ts) last from messages where is_system=0 group by sender_mri order by sender_mri")
            .unwrap();
        stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?)))
            .unwrap()
            .filter_map(Result::ok)
            .collect()
    };
    {
        let mut name_stmt = conn
            .prepare("select sender_name from messages where sender_mri=? and is_system=0 order by ts desc, id desc limit 1")
            .unwrap();
        let mut ins = conn.prepare("insert into people(mri,handle,name,msg_count,last_ts) values(?,?,?,?,?)").unwrap();
        for (mri, c, last) in &ppl {
            let name: String = name_stmt.query_row(params![mri], |r| r.get::<_, Option<String>>(0)).ok().flatten().unwrap_or_default();
            ins.execute(params![mri, handles.handle_for('p', mri), name, c, last]).unwrap();
        }
    }
    // conversation aggregates + last_ts + participant_names (pure SQL, reused verbatim)
    conn.execute_batch(
        "update conversations set
           msg_count=(select count(*) from messages m where m.conv_id=conversations.id and m.is_system=0),
           activity_ts=coalesce((select max(ts) from messages m where m.conv_id=conversations.id and m.is_system=0),0),
           participant_count=(select count(distinct sender_mri) from messages m where m.conv_id=conversations.id and m.is_system=0);
         update conversations set last_ts=max(coalesce(meta_last_ts,0), coalesce(activity_ts,0));",
    )
    .unwrap();
    conn.execute(
        "update conversations set participant_names=(
           select group_concat(name, ', ') from (
             select pl.name name, max(m.ts) mts, m.sender_mri from messages m
             join people pl on pl.mri=m.sender_mri
             where m.conv_id=conversations.id and m.is_system=0 and m.sender_mri<>? and pl.name<>''
             group by m.sender_mri order by mts desc, m.sender_mri limit 5))",
        params![self_s],
    )
    .unwrap();
}

fn refresh_fts(conn: &Connection) {
    conn.execute_batch(
        "delete from messages_fts;
         insert into messages_fts(content,conv_id,id) select content,conv_id,id from messages where is_system=0 and content<>'';",
    )
    .unwrap();
}

// ---- incremental refresh (delta apply; port of applyIncremental) ----

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
        msg_targets: crate::resolver::entity_targets_for(snap, mapping, "message"),
        conv_targets: crate::resolver::entity_targets_for(snap, mapping, "conversation"),
    }
}

// delete messages whose owning chain is no longer live (whole-chain / compaction-elided deletion);
// returns the deleted ids. Mirrors ChatStore.deleteMessagesForMissingChains.
fn delete_messages_for_missing_chains(conn: &Connection, live: &HashSet<String>) -> Vec<String> {
    conn.execute_batch("create temp table if not exists _live_chains(k text primary key); delete from _live_chains;")
        .unwrap();
    {
        let mut ins = conn.prepare("insert or ignore into _live_chains values(?)").unwrap();
        for k in live {
            ins.execute(params![k]).unwrap();
        }
    }
    let ids: Vec<String> = {
        let mut stmt = conn.prepare("select id from messages where chain_key not in (select k from _live_chains)").unwrap();
        stmt.query_map([], |r| r.get::<_, String>(0)).unwrap().filter_map(Result::ok).collect()
    };
    conn.execute_batch("delete from messages where chain_key not in (select k from _live_chains)").unwrap();
    ids
}

// delete messages by chain_key; returns deleted ids. Mirrors ChatStore.deleteMessagesByChain.
fn delete_messages_by_chain(conn: &Connection, chain_hex: &str) -> Vec<String> {
    let ids: Vec<String> = {
        let mut stmt = conn.prepare("select id from messages where chain_key=?").unwrap();
        stmt.query_map(params![chain_hex], |r| r.get::<_, String>(0)).unwrap().filter_map(Result::ok).collect()
    };
    conn.execute("delete from messages where chain_key=?", params![chain_hex]).unwrap();
    ids
}

// delta FTS: re-derive only the given ids from the (post-mutation) messages table. Mirrors
// ChatStore.refreshFts(changedIds). Empty → no-op.
fn refresh_fts_delta(conn: &Connection, ids: &HashSet<String>) {
    if ids.is_empty() {
        return;
    }
    conn.execute_batch("create temp table if not exists _chg(id text primary key); delete from _chg;").unwrap();
    {
        let mut ins = conn.prepare("insert or ignore into _chg values(?)").unwrap();
        for id in ids {
            ins.execute(params![id]).unwrap();
        }
    }
    conn.execute_batch(
        "delete from messages_fts where id in (select id from _chg);
         insert into messages_fts(content,conv_id,id) select content,conv_id,id from messages where id in (select id from _chg) and is_system=0 and content<>'';",
    )
    .unwrap();
}

/// Apply an incremental delta onto an existing store (opened on the previous file). Port of
/// applyIncremental: lossy-skip, schema tripwire, no-op fast-exit, then delete-missing-chains +
/// delete-changed-chains + re-extract-changed + whole-replace profiles/events/calls + conversation
/// reconcile + recomputeDerived + delta FTS. `mapping` MUST be the mapping the prior full ingest used.
pub fn refresh_store(conn: &Connection, snap: &Snapshot, mapping: &Value, state: &RefreshState) -> RefreshOutcome {
    // lossy load → don't apply (spuriously-absent chains would read as deletions); serve current.
    if snap.lossy {
        return RefreshOutcome { need_full_rebuild: false, skipped: true, new_max_seq: state.max_seq };
    }
    // schema tripwire: our mapped message/conversation stores resolve differently → full rebuild.
    let msg_t = crate::resolver::entity_targets_for(snap, mapping, "message");
    let conv_t = crate::resolver::entity_targets_for(snap, mapping, "conversation");
    if msg_t != state.msg_targets || conv_t != state.conv_targets {
        return RefreshOutcome { need_full_rebuild: true, skipped: false, new_max_seq: state.max_seq };
    }
    // no-op fast-exit: maxSeq counts tombstones too, so equal ⇒ nothing landed since the last apply.
    if snap.max_seq == state.max_seq {
        return RefreshOutcome { need_full_rebuild: false, skipped: false, new_max_seq: snap.max_seq };
    }

    // live + changed (seq > floor) chain keys, straight off the message buckets (hex, matching the
    // chain_key column encoding). changed_records feed the message re-extract.
    let mut live: HashSet<String> = HashSet::new();
    let mut changed_chains: HashSet<String> = HashSet::new();
    let mut changed_records: Vec<&crate::idb::SnapshotRecord> = Vec::new();
    for sk in &state.msg_targets {
        if let Some(b) = snap.buckets.iter().find(|b| format!("{}:{}", b.db_id, b.os_id) == *sk) {
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
    let new_rows = crate::resolver::extract_rows_from_records(&changed_records, mapping, "message");
    for id in apply_messages(conn, &new_rows, self_mri) {
        fts_ids.insert(id);
    }
    // cheap whole-store replaces (keeps the incremental==full invariant trivially true for these)
    replace_profiles(conn, &extract_rows(snap, mapping, "profile"));
    replace_events(conn, &extract_rows(snap, mapping, "event"));
    replace_calls(conn, &extract_rows(snap, mapping, "call"));
    // conversation reconcile: reset live-meta cols, re-apply, drop orphans (not referenced by messages)
    let conv_rows = extract_rows(snap, mapping, "conversation");
    conn.execute_batch("update conversations set topic=null, team_id=null, thread_type=null, meta_last_ts=0").unwrap();
    apply_conversation_meta(conn, &conv_rows, &mut handles);
    conn.execute_batch("create temp table if not exists _liveconv(id text primary key); delete from _liveconv;").unwrap();
    {
        let mut ins = conn.prepare("insert or ignore into _liveconv values(?)").unwrap();
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
    RefreshOutcome { need_full_rebuild: false, skipped: false, new_max_seq: snap.max_seq }
}

// ---- writer↔reader contract: PRAGMA user_version + the in-file _meta table ----
// The .db file is the contract (self-describing), not an FFI-return sidecar. `_meta` carries the
// StoreMeta bits NOT recoverable by query (fingerprint/mappingVersion/selfMri/lossy) PLUS the
// incremental state (maxSeq + mapped-store targets) so a later refresh reads its floor from the file.

/// Create + write the single-row `_meta` table and stamp user_version. `_meta` is native-only (not in
/// schema.sql, so the store differential's fixed TABLES list ignores it).
fn write_meta(
    conn: &Connection,
    fingerprint: &str,
    mapping_version: Option<&str>,
    lossy: bool,
    state: &RefreshState,
) -> Result<(), String> {
    let targets_json = |t: &[String]| serde_json::to_string(t).unwrap_or_else(|_| "[]".into());
    conn.execute_batch(
        "create table if not exists _meta(
           fingerprint text, mapping_version text, self_mri text, lossy int,
           max_seq int, msg_targets text, conv_targets text);
         delete from _meta;",
    )
    .map_err(|e| format!("_meta create: {e}"))?;
    conn.execute(
        "insert into _meta(fingerprint,mapping_version,self_mri,lossy,max_seq,msg_targets,conv_targets)
         values(?,?,?,?,?,?,?)",
        params![
            fingerprint,
            mapping_version,
            state.self_mri,
            lossy as i64,
            state.max_seq as i64,
            targets_json(&state.msg_targets),
            targets_json(&state.conv_targets),
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
            state: RefreshState { self_mri: None, max_seq: 0, msg_targets: vec![], conv_targets: vec![] },
        });
    }
    let parse_targets = |s: String| -> Vec<String> {
        serde_json::from_str::<Vec<String>>(&s).unwrap_or_default()
    };
    conn.query_row(
        "select fingerprint,mapping_version,self_mri,lossy,max_seq,msg_targets,conv_targets from _meta limit 1",
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
    use crate::idb::load_snapshot;

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
    let mapping = match mappings.iter().find(|m| {
        m.get("mappingVersion").and_then(|v| v.as_str()) == fm.mapping_version.as_deref()
    }) {
        Some(m) => m,
        None => return Ok(RefreshFileOutcome::rebuild()), // mapping for that mappingVersion is gone
    };

    let snap = load_snapshot(dir).map_err(|e| format!("load_snapshot: {e}"))?;
    let outcome = refresh_store(&conn, &snap, mapping, &fm.state);
    if outcome.need_full_rebuild {
        return Ok(RefreshFileOutcome::rebuild());
    }
    if outcome.skipped {
        // lossy: nothing applied. The new_path is a byte-copy of prev; keep serving it unchanged.
        return Ok(RefreshFileOutcome { need_full_rebuild: false, skipped: true, ..counts_of(&conn, &fm) });
    }

    // Rewrite _meta with the new state (recomputed from the full snapshot) + refresh user_version.
    let new_state = compute_state(&snap, mapping);
    let fp = crate::fingerprint::fingerprint(&snap);
    write_meta(&conn, &fp.hash, fm.mapping_version.as_deref(), snap.lossy, &new_state)?;

    let out = RefreshFileOutcome {
        need_full_rebuild: false,
        skipped: false,
        ..counts_of(&conn, &fm)
    };
    conn.close().map_err(|(_, e)| format!("close: {e}"))?;
    Ok(out)
}

fn counts_of(conn: &Connection, fm: &FileMeta) -> RefreshFileOutcome {
    let count = |t: &str| -> i64 { conn.query_row(&format!("select count(*) from {t}"), [], |r| r.get(0)).unwrap_or(0) };
    let earliest_ts: i64 = conn
        .query_row("select min(ts) from messages where ts>0", [], |r| r.get::<_, Option<i64>>(0))
        .ok()
        .flatten()
        .unwrap_or(0);
    RefreshFileOutcome {
        need_full_rebuild: false,
        skipped: false,
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
pub struct RefreshFileOutcome {
    pub need_full_rebuild: bool,
    pub skipped: bool,
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

// ---- per-table content differential report ----
fn feed_value(c: &mut u32, v: rusqlite::types::ValueRef) {
    use rusqlite::types::ValueRef::*;
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
    let (_, sql, ncols) = TABLES.iter().find(|(n, _, _)| *n == table).expect("unknown table");
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
                rusqlite::types::ValueRef::Text(t) => String::from_utf8_lossy(t).replace(['\t', '\n'], " "),
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

#[cfg(test)]
mod tests {
    use super::parse_iso8601_ms;

    // Parity golden: parse_iso8601_ms MUST equal JS Date.parse for the shapes Teams emits (and a few
    // edge cases). Reference values were produced by `node -e 'Date.parse(s)'`. Guards the two
    // engines' timestamp parsers against divergence.
    // No-timezone strings are intentionally excluded: Date.parse treats a bare date-time as LOCAL,
    // while we treat it as UTC — irrelevant because production call timestamps always carry `Z`.
    #[test]
    fn iso8601_matches_js_date_parse() {
        let cases: &[(&str, i64)] = &[
            ("2026-05-11T12:50:41.5647378Z", 1778503841564), // 7-digit fraction floored to ms
            ("2025-10-10T14:28:02.912119Z", 1760106482912),
            ("2024-01-01T00:00:00Z", 1704067200000), // no fraction
            ("2024-01-01T00:00:00.5Z", 1704067200500), // 1-digit fraction
            ("2024-01-01T00:00:00.12Z", 1704067200120), // 2-digit fraction
            ("2024-03-15T09:30:00+02:00", 1710487800000), // positive offset
            ("2024-03-15T09:30:00-05:30", 1710514800000), // negative offset w/ minutes
            ("1970-01-01T00:00:00.000Z", 0),               // epoch
            ("2000-02-29T23:59:59.999Z", 951868799999),    // leap day
        ];
        for (s, want) in cases {
            assert_eq!(parse_iso8601_ms(s), Some(*want), "parse_iso8601_ms({s:?})");
        }
    }
}
