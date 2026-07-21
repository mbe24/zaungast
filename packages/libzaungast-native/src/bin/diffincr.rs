//! Differential-harness dumper (incremental layer). Proves native-incremental == native-full:
//! build a PARTIAL store as of seqCap (= maxSeq/2, the "previous" full ingest), apply an incremental
//! refresh up to the full sequence (store B), independently build a FULL store at the full sequence
//! (store C), and emit both per-table reports. diff-incr.mjs asserts B == C == the TS full rebuild
//! (the third leg), carrying the _inctest "incremental == full" invariant across into Rust.
//!   cargo run --bin diffincr -- <leveldb-dir> <mapping.json> <schema.sql>

use libzaungast_native::fingerprint::fingerprint;
use libzaungast_native::idb::{load_snapshot, load_snapshot_capped};
use libzaungast_native::resolver::{load_mapping, select_mapping, store_set_from_fp};
use libzaungast_native::store::{build_store, compute_state, refresh_store, store_report};

fn main() {
    let dir = std::env::args()
        .nth(1)
        .expect("usage: diffincr <leveldb-dir> <mapping.json> <schema.sql>");
    let mapping_path = std::env::args().nth(2).expect("mapping.json path required");
    let schema_path = std::env::args().nth(3).expect("schema.sql path required");
    let schema = std::fs::read_to_string(&schema_path).expect("read schema.sql");
    let mappings = vec![load_mapping(&mapping_path).expect("load_mapping")];

    // Full snapshot first — gives the full maxSeq (→ cap) and the full mapping.
    let full = load_snapshot(dir.as_str()).expect("load_snapshot");
    let full_fp = fingerprint(&full);
    let full_mapping = select_mapping(
        &full_fp.hash,
        &store_set_from_fp(&full_fp.stores),
        &mappings,
    )
    .expect("no mapping matched (full)");
    let cap = full.max_seq / 2;

    // The "previous" full ingest: a partial store as of `cap`, plus the state it would have recorded.
    let capped = load_snapshot_capped(dir.as_str(), cap).expect("load_snapshot_capped");
    let cap_fp = fingerprint(&capped);
    let cap_mapping = select_mapping(&cap_fp.hash, &store_set_from_fp(&cap_fp.stores), &mappings)
        .expect("no mapping matched (capped)");
    let prev = build_store(&capped, cap_mapping, &schema);
    let state = compute_state(&capped, cap_mapping);

    // Apply the delta up to the full sequence → store B (prev, mutated in place).
    let outcome = refresh_store(&prev, &full, cap_mapping, &state);

    // Independently build store C at the full sequence.
    let fullstore = build_store(&full, full_mapping, &schema);

    // Emit both reports (tagged) + the outcome so the harness can diff and diagnose.
    print!("{}", store_report(&prev).replace("T\t", "INCR\t"));
    print!("{}", store_report(&fullstore).replace("T\t", "FULL\t"));
    println!(
        "OUTCOME\tneed_full_rebuild={}\tskipped={}\tcap={}\tfull_max_seq={}\tnew_max_seq={}",
        outcome.need_full_rebuild, outcome.skipped, cap, full.max_seq, outcome.new_max_seq
    );
}
