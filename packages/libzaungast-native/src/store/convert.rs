//! Pure value helpers for the store writer: Ssv field accessors, JS-coercion (Number/String/truthy),
//! the domain transforms (conv kind, system-message + attachment detection, mention MRIs, self-MRI
//! vote), JSON building (matches JSON.stringify), the compaction encoders (reactions/attendees/
//! participants/recording-link), and ISO-8601/Date.parse-parity time parsing. No SQLite here — these
//! turn decoded Ssv into scalars/strings the extract layer inserts.

use std::collections::HashMap;

use serde_json::Value;

use crate::sha256::hex;
use crate::value::Ssv;

// ---- Ssv field accessors + JS coercions ----
pub(crate) fn get<'a>(v: &'a Ssv, k: &str) -> Option<&'a Ssv> {
    match v {
        Ssv::Object(p) => p.iter().find(|(kk, _)| kk == k).map(|(_, x)| x),
        _ => None,
    }
}
pub(crate) fn as_str<'a>(v: Option<&'a Ssv>) -> Option<&'a str> {
    match v {
        Some(Ssv::Str(s)) => Some(s),
        _ => None,
    }
}
pub(crate) fn is_true(v: Option<&Ssv>) -> bool {
    matches!(v, Some(Ssv::Bool(true)))
}
pub(crate) fn is_truthy(v: Option<&Ssv>) -> bool {
    match v {
        None | Some(Ssv::Null) | Some(Ssv::Undefined) | Some(Ssv::Bool(false)) => false,
        Some(Ssv::Num(n)) => *n != 0.0 && !n.is_nan(),
        Some(Ssv::Str(s)) => !s.is_empty(),
        _ => true,
    }
}
// JS Number(v)
pub(crate) fn to_num(v: Option<&Ssv>) -> f64 {
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
pub(crate) fn to_js_string(v: Option<&Ssv>) -> Option<String> {
    match v {
        None | Some(Ssv::Null) | Some(Ssv::Undefined) => None,
        Some(Ssv::Str(s)) => Some(s.clone()),
        Some(Ssv::Num(n)) => Some(num_to_js_string(*n)),
        Some(Ssv::Bool(b)) => Some(if *b { "true".into() } else { "false".into() }),
        _ => Some(String::new()), // objects/arrays → String() would be "[object Object]"/join; not used by these fields
    }
}
pub(crate) fn num_to_js_string(n: f64) -> String {
    if n.fract() == 0.0 && n.is_finite() && n.abs() < 1e21 {
        format!("{}", n as i64)
    } else {
        format!("{}", n)
    }
}

// ---- transforms ----
pub(crate) fn conv_kind(id: &str) -> &'static str {
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

pub(crate) fn is_system_message(m: &Ssv) -> bool {
    if let Some(t) = as_str(get(m, "type")) {
        if t != "Message" {
            return true;
        }
    }
    let mt = as_str(get(m, "messageType")).unwrap_or("");
    let l = mt.to_ascii_lowercase();
    l.starts_with("threadactivity/") || l.contains("control") || l.contains("event") || l.contains("systemmessage")
}

pub(crate) fn has_attachment(m: &Ssv, html: &str) -> bool {
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

pub(crate) fn mentioned_mris(m: &Ssv) -> Vec<String> {
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
pub(crate) fn vote_self_mri(msgs: &[Ssv]) -> Option<String> {
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
pub(crate) fn json_str(s: &str, out: &mut String) {
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

pub(crate) fn compact_reactions(emotions: Option<&Ssv>) -> Option<String> {
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

pub(crate) fn compact_attendees(attendees: Option<&Ssv>) -> Option<String> {
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

pub(crate) fn compact_participants(list: Option<&Ssv>) -> Option<String> {
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

pub(crate) fn recording_link_of(r: &Ssv) -> Option<String> {
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

pub(crate) fn to_epoch_ms(v: Option<&Ssv>) -> i64 {
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
pub(crate) fn parse_iso8601_ms(s: &str) -> Option<i64> {
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
pub(crate) fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = if m > 2 { m - 3 } else { m + 9 };
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

pub(crate) fn latin1_hex(s: &str) -> String {
    let bytes: Vec<u8> = s.chars().map(|c| c as u8).collect();
    hex(&bytes)
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
