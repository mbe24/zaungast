//! Differential-harness dumper (fingerprint layer): print the schema fingerprint report (hash +
//! per-store db/store/fields). Matches harness/diff-fp.mjs.
//!   cargo run --bin difffp -- <leveldb-dir>

use libzaungast_native::fingerprint::fingerprint_report;
use libzaungast_native::idb::load_snapshot;

fn main() {
    let dir = std::env::args()
        .nth(1)
        .expect("usage: difffp <leveldb-dir>");
    let snap = load_snapshot(&dir).expect("load_snapshot");
    print!("{}", fingerprint_report(&snap));
}
