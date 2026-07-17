//! Differential-harness dumper (store layer): build the full ChatStore and print a per-table content
//! digest. Matches harness/diff-store.mjs (which runs the TS full ingest).
//!   cargo run --bin diffstore -- <leveldb-dir> <mapping.json> <schema.sql> [table]
//! The schema is read from the SAME single-source file TS uses (libzaungast/src/schema.sql), proving
//! the seam contract: one DDL string, both engines exec it.

use libzaungast_native::fingerprint::fingerprint;
use libzaungast_native::idb::load_snapshot;
use libzaungast_native::resolver::{load_mapping, select_mapping, store_set_from_fp};
use libzaungast_native::writer::{build_store, store_report};

fn main() {
    let dir = std::env::args().nth(1).expect("usage: diffstore <leveldb-dir> <mapping.json> <schema.sql> [table]");
    let mapping_path = std::env::args().nth(2).expect("mapping.json path required");
    let schema_path = std::env::args().nth(3).expect("schema.sql path required");
    let schema = std::fs::read_to_string(&schema_path).expect("read schema.sql");
    let snap = load_snapshot(&dir).expect("load_snapshot");
    let fp = fingerprint(&snap);
    let mappings = vec![load_mapping(&mapping_path).expect("load_mapping")];
    let mapping = select_mapping(&fp.hash, &store_set_from_fp(&fp.stores), &mappings).expect("no mapping matched");
    let conn = build_store(&snap, mapping, &schema);
    // debug: `diffstore <dir> <mapping> <schema.sql> <table>` dumps that table's rows
    if let Some(table) = std::env::args().nth(4) {
        print!("{}", libzaungast_native::writer::dump_table(&conn, &table));
    } else {
        print!("{}", store_report(&conn));
    }
}
