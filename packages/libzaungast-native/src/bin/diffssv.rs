//! Differential-harness dumper (SSV layer): decode every record's value and print a per-bucket
//! crc32c over the canonical form of the decoded values. Matches harness/diff-ssv.mjs.
//!   cargo run --bin diffssv -- <leveldb-dir>

use libzaungast_native::idb::{load_snapshot, snapshot_ssv_report};
use libzaungast_native::sha256::hex;
use libzaungast_native::value::{canonical, decode_value};

fn main() {
    let dir = std::env::args()
        .nth(1)
        .expect("usage: diffssv <leveldb-dir> [db:os]");
    let snap = load_snapshot(&dir).expect("load_snapshot");
    // debug: `diffssv <dir> <db:os>` → print each record's canonical as hex (one line per record)
    if let Some(target) = std::env::args().nth(2) {
        for b in &snap.buckets {
            if format!("{}:{}", b.db_id, b.os_id) != target {
                continue;
            }
            for r in &b.records {
                match decode_value(r.value.as_deref().unwrap_or(&[]), false) {
                    Ok(v) => {
                        let mut c = Vec::new();
                        canonical(&v, &mut c);
                        println!("{}", hex(&c));
                    }
                    Err(e) => println!("ERR {e}"),
                }
            }
        }
        return;
    }
    print!("{}", snapshot_ssv_report(&snap));
}
