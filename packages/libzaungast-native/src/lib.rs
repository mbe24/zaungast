//! libzaungast-native — the optional Rust accelerator for libzaungast.
//!
//! Plan: `plan/rust-core-plan.md`. Seam A — this crate reads the Teams leveldb dir and writes the
//! ChatStore SQLite file; the TS `libzaungast` opens it read-only and serves the API. Developed as a
//! pure-cargo-testable library (each byte-layer verified against a TS differential oracle); the
//! napi-rs boundary (`bindings`, `--features napi`) wraps `writer::ingest_to_file`. Read-only always
//! on the source: File::open, never leveldb DB::open (it only ever WRITES the separate ChatStore).
//!
//! Layer status: all layers byte-identical to the TS reference on real data (sstable/wal/dedup →
//! structured-clone → fingerprint/extract → htmlToText → SQLite store, 6/6 tables). See
//! plan/rust-core-plan.md "Progress".

pub mod fingerprint;
pub mod html;
pub mod idb;
pub mod resolver;
pub mod sha256;
pub mod snappy;
pub mod ssv;
pub mod sstable;
pub mod wal;
pub mod writer;

// The Node addon (N-API) surface — only compiled with `--features napi` (produces the .node the TS
// engine switch loads). The pure-Rust pipeline lives in `writer::ingest_to_file`; this is a thin
// wrapper, so the crate stays fully testable via cargo/the diff bins without Node.
#[cfg(feature = "napi")]
pub mod bindings;
