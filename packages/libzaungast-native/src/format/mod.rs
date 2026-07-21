//! Format layer: the byte readers + decode + schema/mapping resolution — the Rust counterpart of the
//! TS `libzaungast/format`. Each submodule maps to a decode phase (and to a `diff*` harness bin that
//! verifies it byte-for-byte against the TS reader): sstable/wal/snappy (raw block readers), idb
//! (dedup + buckets → Snapshot), value (structured-clone value decode), fingerprint (schema hash),
//! resolver (mapping select + row extraction). Re-exported flat at the crate root (see lib.rs) so the
//! bins and the store layer address them by short path.
pub mod fingerprint;
pub mod idb;
pub mod resolver;
pub mod snappy;
pub mod sstable;
pub mod value;
pub mod wal;
