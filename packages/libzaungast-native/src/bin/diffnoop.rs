//! No-op-refresh gate check (source-signature, end-to-end): full-ingest to a temp file, then refresh the SAME,
//! unchanged dir. The leveldb source-file signature must match what the ingest recorded, so
//! `refresh_to_file` short-circuits (`skipped`) WITHOUT copying a new file or re-reading the snapshot.
//! Proves the `refresh_to_file` no-op path — the store/incr differentials use `refresh_store`, which
//! bypasses it. diff-noop.mjs asserts `skipped=true new_written=false`.
//!   cargo run --bin diffnoop -- <leveldb-dir> <mapping.json> <schema.sql>

use std::path::Path;

use libzaungast_native::store::{ingest_to_file, refresh_to_file};

fn main() {
    let dir = std::env::args()
        .nth(1)
        .expect("usage: diffnoop <leveldb-dir> <mapping.json> <schema.sql>");
    let mapping_path = std::env::args().nth(2).expect("mapping.json path required");
    let schema_path = std::env::args().nth(3).expect("schema.sql path required");
    let schema = std::fs::read_to_string(&schema_path).expect("read schema.sql");
    let mappings = vec![std::fs::read_to_string(&mapping_path).expect("read mapping.json")];

    let tmp = std::env::temp_dir();
    let prev = tmp.join("zaungast-noop-prev.db");
    let newp = tmp.join("zaungast-noop-new.db");
    let (prev_s, new_s) = (prev.to_str().expect("temp"), newp.to_str().expect("temp"));
    let _ = std::fs::remove_file(new_s);

    ingest_to_file(&dir, prev_s, &schema, &mappings).expect("ingest prev");
    let out = refresh_to_file(&dir, prev_s, new_s, &mappings).expect("refresh");
    // Expected on an unchanged dir: skipped (no-op), no full rebuild, and NO new file written.
    println!(
        "NOOP\tskipped={}\tneed_full_rebuild={}\tnew_written={}",
        out.skipped,
        out.need_full_rebuild,
        Path::new(new_s).exists()
    );
}
