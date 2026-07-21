//! Differential-harness dumper (htmltext layer): htmlToText over every message `content`, digest.
//! Matches harness/diff-htmltext.mjs.
//!   cargo run --bin difftext -- <leveldb-dir> <mapping.json>

use libzaungast_native::fingerprint::fingerprint;
use libzaungast_native::idb::load_snapshot;
use libzaungast_native::resolver::{
    htmltext_report, load_mapping, select_mapping, store_set_from_fp,
};

fn main() {
    let dir = std::env::args()
        .nth(1)
        .expect("usage: difftext <leveldb-dir> <mapping.json>");
    let mapping_path = std::env::args().nth(2).expect("mapping.json path required");
    let snap = load_snapshot(&dir).expect("load_snapshot");
    let fp = fingerprint(&snap);
    let mappings = vec![load_mapping(&mapping_path).expect("load_mapping")];
    let store_set = store_set_from_fp(&fp.stores);
    let mapping = select_mapping(&fp.hash, &store_set, &mappings).expect("no mapping matched");
    print!("{}", htmltext_report(&snap, mapping));
}
