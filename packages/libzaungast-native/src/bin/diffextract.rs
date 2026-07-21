//! Differential-harness dumper (extract layer): select the mapping for the snapshot's fingerprint,
//! extract every entity, and print a per-entity crc32c over the canonical form of each row.
//! Matches harness/diff-extract.mjs.
//!   cargo run --bin diffextract -- <leveldb-dir> <mapping.json>

use libzaungast_native::fingerprint::fingerprint;
use libzaungast_native::idb::load_snapshot;
use libzaungast_native::resolver::{
    extract_report, load_mapping, select_mapping, store_set_from_fp,
};

fn main() {
    let dir = std::env::args()
        .nth(1)
        .expect("usage: diffextract <leveldb-dir> <mapping.json>");
    let mapping_path = std::env::args().nth(2).expect("mapping.json path required");
    let snap = load_snapshot(&dir).expect("load_snapshot");
    let fp = fingerprint(&snap);
    let mappings = vec![load_mapping(&mapping_path).expect("load_mapping")];
    let store_set = store_set_from_fp(&fp.stores);
    if let Some(m) = select_mapping(&fp.hash, &store_set, &mappings) {
        print!("{}", extract_report(&snap, m));
    } else {
        eprintln!("no mapping matched fingerprint {}", fp.hash);
        std::process::exit(1);
    }
}
