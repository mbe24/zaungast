//! Differential-harness dumper: read one .ldb and print `count<TAB>clean|lossy<TAB>crc32c` — the
//! same (count, digest) the TS harness computes via `readTable`. Matching lines ⇒ byte-identical.
//!   cargo run --bin difftable -- <path-to.ldb>

use libzaungast_native::sstable::{entries_digest, read_table};

fn main() {
    let path = std::env::args()
        .nth(1)
        .expect("usage: difftable <path.ldb>");
    let t = read_table(&path).expect("read");
    let (count, crc) = entries_digest(&t.entries);
    println!(
        "{}\t{}\t{:08x}",
        count,
        if t.lossy { "lossy" } else { "clean" },
        crc
    );
}
