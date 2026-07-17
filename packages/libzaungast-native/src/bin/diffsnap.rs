//! Differential-harness dumper (snapshot layer): load the whole leveldb dir into a Snapshot and
//! print the report (GLOBAL + per-bucket lines with crc32c) that harness/diff-snapshot.mjs matches.
//!   cargo run --bin diffsnap -- <leveldb-dir>

use libzaungast_native::idb::{load_snapshot, snapshot_report};

fn main() {
    let dir = std::env::args().nth(1).expect("usage: diffsnap <leveldb-dir>");
    let snap = load_snapshot(&dir).expect("load_snapshot");
    print!("{}", snapshot_report(&snap));
}
