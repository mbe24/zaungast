//! Schema fingerprint — faithful port of format/fingerprint.ts. The frozen 16-hex hash selects the
//! mapping, so this must be byte-identical or selection breaks. Samples the first 5 records of each
//! bucket (dedup order), collects each decoded value's TOP-LEVEL key set (deserialize WITHOUT the
//! value-compression wrapper — a baked-in quirk: wrapper-compressed values throw → no keys), then
//! normalizes db names, sorts, canonical-JSON-encodes, and SHA-256s. Field keys go into a set that's
//! sorted, so JS key-iteration order is moot here — only the key SET + normalization + sort matter.

use std::collections::{BTreeSet, HashMap};

use crate::idb::Snapshot;
use crate::sha256::{hex, sha256};
use crate::value;

pub struct Fingerprint {
    pub hash: String,
    pub store_count: usize,
    pub db_count: usize,
    pub stores: Vec<(String, String, Vec<String>)>, // (normalized db, store, sorted fields)
}

fn is_hex(b: u8) -> bool {
    b.is_ascii_hexdigit()
}

// Replace every 8-4-4-4-12 hex GUID with "<guid>".
fn replace_guids(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < b.len() {
        let guid = i + 36 <= b.len()
            && b[i + 8] == b'-'
            && b[i + 13] == b'-'
            && b[i + 18] == b'-'
            && b[i + 23] == b'-'
            && (0..36).all(|k| matches!(k, 8 | 13 | 18 | 23) || is_hex(b[i + k]));
        if guid {
            out.push_str("<guid>");
            i += 36;
        } else {
            out.push(b[i] as char);
            i += 1;
        }
    }
    out
}

// `:xx-xx` (two ascii letters, dash, two ascii letters) at the very END → `:<locale>`.
fn replace_locale_suffix(s: &str) -> String {
    let b = s.as_bytes();
    let n = b.len();
    if n >= 6
        && b[n - 6] == b':'
        && b[n - 5].is_ascii_alphabetic()
        && b[n - 4].is_ascii_alphabetic()
        && b[n - 3] == b'-'
        && b[n - 2].is_ascii_alphabetic()
        && b[n - 1].is_ascii_alphabetic()
    {
        format!("{}:<locale>", &s[..n - 6])
    } else {
        s.to_string()
    }
}

// Replace `open <1+ digits> close` with `open <n> close` (left-to-right, non-overlapping — the close
// delimiter is consumed, matching JS String.replace(/:\d+:/g,...) / (/_\d+_/g,...)).
fn replace_delimited_digits(s: &str, open: u8, close: u8) -> String {
    let b = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == open {
            let mut j = i + 1;
            while j < b.len() && b[j].is_ascii_digit() {
                j += 1;
            }
            if j > i + 1 && j < b.len() && b[j] == close {
                out.push(open as char);
                out.push_str("<n>");
                out.push(close as char);
                i = j + 1;
                continue;
            }
        }
        out.push(b[i] as char);
        i += 1;
    }
    out
}

fn normalize_db_name(name: &str) -> String {
    let s = replace_guids(name);
    let s = replace_locale_suffix(&s);
    let s = replace_delimited_digits(&s, b':', b':');
    replace_delimited_digits(&s, b'_', b'_')
}

fn skip_version_varint(value: &[u8]) -> Option<usize> {
    let mut pos = 0;
    loop {
        let c = *value.get(pos)?;
        pos += 1;
        if c & 0x80 == 0 {
            break;
        }
    }
    Some(pos)
}

fn collect_top_keys(v: &value::Ssv, set: &mut BTreeSet<String>) {
    match v {
        value::Ssv::Object(props) => {
            for (k, _) in props {
                set.insert(k.clone());
            }
        }
        value::Ssv::Array { items, props } => {
            for i in 0..items.len() {
                set.insert(i.to_string());
            }
            for (k, _) in props {
                set.insert(k.clone());
            }
        }
        _ => {}
    }
}

// JS JSON.stringify string escaping (lowercase \uXXXX; \b \t \n \f \r shortforms; " and \ escaped).
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

pub fn fingerprint(snap: &Snapshot) -> Fingerprint {
    // sample first-5 per bucket → top-level key set (BTreeSet = sorted, matching sort(byCodeUnit))
    let mut sample_keys: HashMap<String, BTreeSet<String>> = HashMap::new();
    for bucket in &snap.buckets {
        let sk = format!("{}:{}", bucket.db_id, bucket.os_id);
        let mut set: BTreeSet<String> = BTreeSet::new();
        let lim = std::cmp::min(5, bucket.records.len());
        for r in &bucket.records[..lim] {
            if let Some(value) = &r.value {
                if let Some(vpos) = skip_version_varint(value) {
                    if let Ok(v) = value::deserialize(&value[vpos..], false) {
                        collect_top_keys(&v, &mut set);
                    }
                }
            }
        }
        sample_keys.insert(sk, set);
    }

    // buildStores: one per store-name that has a resolvable db-name; fields sorted; sort by db+store
    let mut stores: Vec<(String, String, Vec<String>)> = Vec::new();
    for (sk, store_name) in &snap.store_names {
        let db_id: u64 = sk.split(':').next().and_then(|x| x.parse().ok()).unwrap_or(0);
        let db_name = match snap.db_names.get(&db_id) {
            Some(n) => n,
            None => continue,
        };
        let fields: Vec<String> = sample_keys.get(sk).map(|s| s.iter().cloned().collect()).unwrap_or_default();
        stores.push((normalize_db_name(db_name), store_name.clone(), fields));
    }
    stores.sort_by(|a, b| {
        let ka = format!("{}{}", a.0, a.1);
        let kb = format!("{}{}", b.0, b.1);
        ka.as_bytes().cmp(kb.as_bytes())
    });

    let mut canonical = String::from("[");
    for (i, (db, store, fields)) in stores.iter().enumerate() {
        if i > 0 {
            canonical.push(',');
        }
        canonical.push('[');
        json_str(db, &mut canonical);
        canonical.push(',');
        json_str(store, &mut canonical);
        canonical.push_str(",[");
        for (j, f) in fields.iter().enumerate() {
            if j > 0 {
                canonical.push(',');
            }
            json_str(f, &mut canonical);
        }
        canonical.push_str("]]");
    }
    canonical.push(']');

    let hash = hex(&sha256(canonical.as_bytes()))[..16].to_string();
    Fingerprint { hash, store_count: stores.len(), db_count: snap.db_names.len(), stores }
}

/// Report for the differential: FP line (hash/counts) + one S line per store (sorted).
pub fn fingerprint_report(snap: &Snapshot) -> String {
    use std::fmt::Write;
    let fp = fingerprint(snap);
    let mut out = String::new();
    let _ = writeln!(out, "FP\t{}\t{}\t{}", fp.hash, fp.store_count, fp.db_count);
    for (db, store, fields) in &fp.stores {
        let _ = writeln!(out, "S\t{}\t{}\t{}", db, store, fields.join(","));
    }
    out
}
