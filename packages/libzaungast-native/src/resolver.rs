//! Mapping resolution + generic entity extraction — faithful port of format/resolver.ts. Applies a
//! mapping definition (db glob + store + field paths, optional iterate/keep) to a snapshot's decoded
//! records, producing entity rows. This is the "generic, data-driven" layer: a new entity is a new
//! mapping JSON, zero Rust changes. Verified against the TS extractEntity via a per-entity row digest.

use std::collections::HashSet;

use serde_json::Value;

use crate::html::html_to_text;
use crate::idb::{Snapshot, SnapshotRecord};
use crate::sstable::{crc32c_final, crc32c_init, crc32c_update};
use crate::ssv::{canonical, decode_value, Ssv};

pub fn load_mapping(path: &str) -> Result<Value, String> {
    let s = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&s).map_err(|e| e.to_string())
}

/// selectMapping: exact fingerprint-hash match, else store-presence (requireStores ⊆ present stores).
pub fn select_mapping<'a>(
    fp_hash: &str,
    store_set: &HashSet<String>,
    mappings: &'a [Value],
) -> Option<&'a Value> {
    for m in mappings {
        if let Some(fps) = m.get("knownFingerprints").and_then(|k| k.as_array()) {
            if fps.iter().any(|x| x.as_str() == Some(fp_hash)) {
                return Some(m);
            }
        }
    }
    for m in mappings {
        let need: Vec<&str> = m
            .get("match")
            .and_then(|x| x.get("requireStores"))
            .and_then(|x| x.as_array())
            .map(|a| a.iter().filter_map(|s| s.as_str()).collect())
            .unwrap_or_default();
        if need.iter().all(|s| store_set.contains(*s)) {
            return Some(m);
        }
    }
    None
}

// glob: `*` is the only wildcard (TS: escape regex specials, `*`→`.*`, anchor ^…$).
fn glob(pat: &str, s: &str) -> bool {
    let segs: Vec<&str> = pat.split('*').collect();
    if segs.len() == 1 {
        return pat == s;
    }
    let n = segs.len();
    let mut idx = 0usize;
    if !segs[0].is_empty() {
        if !s.starts_with(segs[0]) {
            return false;
        }
        idx = segs[0].len();
    }
    for seg in &segs[1..n - 1] {
        if seg.is_empty() {
            continue;
        }
        match s[idx..].find(seg) {
            Some(k) => idx += k + seg.len(),
            None => return false,
        }
    }
    let last = segs[n - 1];
    last.is_empty() || (s.len() >= idx + last.len() && s[idx..].ends_with(last))
}

fn get_path<'a>(obj: &'a Ssv, path: &str) -> Option<&'a Ssv> {
    let mut cur = obj;
    for part in path.split('.') {
        match cur {
            Ssv::Object(props) => match props.iter().find(|(k, _)| k == part) {
                Some((_, v)) => cur = v,
                None => return None,
            },
            _ => return None,
        }
    }
    Some(cur)
}

fn first_defined<'a>(obj: &'a Ssv, spec: &[String]) -> Option<&'a Ssv> {
    for p in spec {
        if let Some(v) = get_path(obj, p) {
            let empty = matches!(v, Ssv::Str(s) if s.is_empty());
            if !matches!(v, Ssv::Undefined | Ssv::Null) && !empty {
                return Some(v);
            }
        }
    }
    None
}

// A parsed entity def: field specs + optional iterate/keep.
struct Def {
    db: String,
    store: String,
    fields: Vec<(String, Vec<String>)>,
    iterate: Option<String>,
    keep: Option<(String, Value)>,
}
fn parse_def(def: &Value) -> Def {
    let fields = def
        .get("fields")
        .and_then(|f| f.as_object())
        .map(|m| {
            m.iter()
                .map(|(k, spec)| {
                    let paths = match spec {
                        Value::String(s) => vec![s.clone()],
                        Value::Array(a) => a.iter().filter_map(|x| x.as_str().map(String::from)).collect(),
                        _ => vec![],
                    };
                    (k.clone(), paths)
                })
                .collect()
        })
        .unwrap_or_default();
    let keep = def.get("keep").map(|k| {
        (
            k.get("field").and_then(|f| f.as_str()).unwrap_or("").to_string(),
            k.get("equals").cloned().unwrap_or(Value::Null),
        )
    });
    Def {
        db: def.get("db").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        store: def.get("store").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        fields,
        iterate: def.get("iterate").and_then(|v| v.as_str()).map(String::from),
        keep,
    }
}

fn ssv_eq_json(iv: Option<&Ssv>, equals: &Value) -> bool {
    match (iv, equals) {
        (Some(Ssv::Str(s)), Value::String(e)) => s == e,
        (Some(Ssv::Bool(b)), Value::Bool(e)) => b == e,
        (Some(Ssv::Num(n)), Value::Number(e)) => e.as_f64() == Some(*n),
        (Some(Ssv::Null), Value::Null) => true,
        _ => false,
    }
}

fn is_falsy(v: &Ssv) -> bool {
    match v {
        Ssv::Null | Ssv::Undefined => true,
        Ssv::Bool(b) => !b,
        Ssv::Num(n) => *n == 0.0 || n.is_nan(),
        Ssv::Str(s) => s.is_empty(),
        _ => false,
    }
}

fn map_fields(src: &Ssv, rec_key: &str, def: &Def) -> Ssv {
    let mut props: Vec<(String, Ssv)> = Vec::with_capacity(def.fields.len() + 1);
    props.push(("__key".to_string(), Ssv::Str(rec_key.to_string())));
    for (out, spec) in &def.fields {
        let v = first_defined(src, spec).cloned().unwrap_or(Ssv::Undefined);
        props.push((out.clone(), v));
    }
    Ssv::Object(props)
}

fn rows_from_record(obj: &Ssv, rec_key: &str, def: &Def, out: &mut Vec<Ssv>) {
    match &def.iterate {
        None => out.push(map_fields(obj, rec_key, def)),
        Some(iter_path) => {
            let container_path = iter_path.strip_suffix(".*").unwrap_or(iter_path);
            if let Some(Ssv::Object(items)) = get_path(obj, container_path) {
                for (_k, item) in items {
                    if let Some((kfield, kequals)) = &def.keep {
                        if !ssv_eq_json(get_path(item, kfield), kequals) {
                            continue; // keep only items whose field == equals
                        }
                    }
                    out.push(map_fields(item, rec_key, def));
                }
            }
        }
    }
}

fn entity_targets(snap: &Snapshot, def: &Def) -> Vec<String> {
    let mut targets: Vec<String> = Vec::new();
    for (sk, store_name) in &snap.store_names {
        let db_id: u64 = sk.split(':').next().and_then(|x| x.parse().ok()).unwrap_or(0);
        if let Some(db_name) = snap.db_names.get(&db_id) {
            if *store_name == def.store && glob(&def.db, db_name) {
                targets.push(sk.clone());
            }
        }
    }
    targets.sort(); // deterministic (usually a single target per entity)
    targets
}

/// Extract rows for one entity def. Returns (rows, decoded, dropped).
fn extract_entity(snap: &Snapshot, def: &Def) -> (Vec<Ssv>, usize, usize) {
    let targets = entity_targets(snap, def);
    let mut rows: Vec<Ssv> = Vec::new();
    let (mut decoded, mut dropped) = (0usize, 0usize);
    for sk in &targets {
        let bucket = snap.buckets.iter().find(|b| format!("{}:{}", b.db_id, b.os_id) == *sk);
        let bucket = match bucket {
            Some(b) => b,
            None => continue,
        };
        for rec in &bucket.records {
            let obj = match decode_value(rec.value.as_deref().unwrap_or(&[]), false) {
                Ok(v) => v,
                Err(_) => {
                    dropped += 1;
                    continue;
                }
            };
            if is_falsy(&obj) {
                dropped += 1;
                continue;
            }
            decoded += 1;
            let rec_key: String = rec.key.iter().map(|&b| b as char).collect(); // latin1
            rows_from_record(&obj, &rec_key, def, &mut rows);
        }
    }
    (rows, decoded, dropped)
}

/// Report for the differential: one E line per entity (sorted by name), with a crc32c over the
/// canonical form of each extracted row in extraction order.
pub fn extract_report(snap: &Snapshot, mapping: &Value) -> String {
    use std::fmt::Write;
    let mut out = String::new();
    let entities = mapping.get("entities").and_then(|e| e.as_object());
    let mut names: Vec<&String> = entities.map(|m| m.keys().collect()).unwrap_or_default();
    names.sort();
    for name in names {
        let def = parse_def(&entities.unwrap()[name]);
        let (rows, decoded, dropped) = extract_entity(snap, &def);
        let mut c = crc32c_init();
        for row in &rows {
            let mut canon = Vec::new();
            canonical(row, &mut canon);
            for x in (canon.len() as u32).to_le_bytes() {
                c = crc32c_update(c, x);
            }
            for &x in &canon {
                c = crc32c_update(c, x);
            }
        }
        let _ = writeln!(out, "E\t{}\t{}\t{}\t{}\t{:08x}", name, rows.len(), decoded, dropped, crc32c_final(c));
    }
    out
}

/// Extract just the rows for one entity (for downstream store-write / transform differentials).
pub fn extract_rows(snap: &Snapshot, mapping: &Value, name: &str) -> Vec<Ssv> {
    match mapping.get("entities").and_then(|e| e.get(name)) {
        Some(d) => extract_entity(snap, &parse_def(d)).0,
        None => Vec::new(),
    }
}

/// htmltext-layer report: htmlToText over every message `content` (extraction order), crc32c'd.
pub fn htmltext_report(snap: &Snapshot, mapping: &Value) -> String {
    let rows = extract_rows(snap, mapping, "message");
    let mut c = crc32c_init();
    for row in &rows {
        let content = match row {
            Ssv::Object(props) => props
                .iter()
                .find(|(k, _)| k == "content")
                .and_then(|(_, v)| if let Ssv::Str(s) = v { Some(s.as_str()) } else { None })
                .unwrap_or(""),
            _ => "",
        };
        let b = html_to_text(content);
        let bytes = b.as_bytes();
        for x in (bytes.len() as u32).to_le_bytes() {
            c = crc32c_update(c, x);
        }
        for &x in bytes {
            c = crc32c_update(c, x);
        }
    }
    format!("HT\t{}\t{:08x}", rows.len(), crc32c_final(c))
}

/// The store-name SET from a fingerprint, for select_mapping's store-presence check.
pub fn store_set_from_fp(stores: &[(String, String, Vec<String>)]) -> HashSet<String> {
    stores.iter().map(|(_, s, _)| s.clone()).collect()
}

/// The mapped-store targets ("dbId:osId", sorted) for one entity — the incremental schema-change
/// tripwire set. Empty when the entity isn't in the mapping. Mirrors entityTargets in TS.
pub fn entity_targets_for(snap: &Snapshot, mapping: &Value, name: &str) -> Vec<String> {
    match mapping.get("entities").and_then(|e| e.get(name)) {
        Some(d) => entity_targets(snap, &parse_def(d)),
        None => Vec::new(),
    }
}

/// Extract rows for one entity from a SPECIFIC set of records (not whole buckets) — the incremental
/// delta re-extracts only the changed message-store records. Mirrors extractRecords in TS.
pub fn extract_rows_from_records(records: &[&SnapshotRecord], mapping: &Value, name: &str) -> Vec<Ssv> {
    let def = match mapping.get("entities").and_then(|e| e.get(name)) {
        Some(d) => parse_def(d),
        None => return Vec::new(),
    };
    let mut rows: Vec<Ssv> = Vec::new();
    for rec in records {
        let obj = match decode_value(rec.value.as_deref().unwrap_or(&[]), false) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if is_falsy(&obj) {
            continue;
        }
        let rec_key: String = rec.key.iter().map(|&b| b as char).collect(); // latin1
        rows_from_record(&obj, &rec_key, &def, &mut rows);
    }
    rows
}
