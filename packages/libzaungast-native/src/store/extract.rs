//! Row extraction + insertion: takes decoded Ssv rows (from the format layer's extract) and writes
//! them into the SQLite store — conversation meta, messages (htmlToText/reactions/flags/root_id),
//! profiles/events/calls (with compaction), then recomputeDerived (people + conversation aggregates +
//! handles). Port of ingest.ts's apply* + store.ts's row builders. Shared by the full-ingest spine
//! (store::populate) and the incremental refresh (store::refresh). Also owns `Handles`, the
//! 6-hex-sha1 handle assigner (store.ts handleFor).

use std::collections::{HashMap, HashSet};

use rusqlite::{params, Connection};

use super::convert::*;
use crate::sha256::make_handle;
use crate::text::html_to_text;
use crate::value::Ssv;

// ---- handle assignment (6-hex sha1, collision-extended; matches store.ts handleFor) ----
pub(crate) struct Handles {
    used: HashSet<String>,
    by_full: HashMap<String, String>,
}
impl Handles {
    pub(crate) fn new() -> Self {
        Handles { used: HashSet::new(), by_full: HashMap::new() }
    }
    /// Seed the cache from an already-built store (native refresh opens the previous file). Existing
    /// conversations/people keep their handle, and a newly-inserted entity then gets a handle that
    /// AVOIDS `used` — so a 6-hex collision with an existing handle can't mint a duplicate that trips
    /// the `handle UNIQUE` constraint (which would panic → force a full rebuild). Makes refresh's
    /// handle assignment equal a full rebuild by construction, not by collision-free luck.
    pub(crate) fn seed_from(&mut self, conn: &Connection) {
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
    pub(crate) fn handle_for(&mut self, prefix: char, full_id: &str) -> String {
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

pub(crate) fn apply_conversation_meta(conn: &Connection, convs: &[Ssv], handles: &mut Handles) {
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
pub(crate) fn apply_messages(conn: &Connection, msgs: &[Ssv], self_mri: Option<&str>) -> Vec<String> {
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

pub(crate) fn replace_profiles(conn: &Connection, rows: &[Ssv]) {
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

pub(crate) fn replace_events(conn: &Connection, rows: &[Ssv]) {
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

pub(crate) fn replace_calls(conn: &Connection, rows: &[Ssv]) {
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

pub(crate) fn recompute_derived(conn: &Connection, self_mri: Option<&str>, handles: &mut Handles) {
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
