//! libzaungast-native — the optional Rust accelerator for libzaungast.
//!
//! The seam: this crate reads the Teams leveldb dir and writes the ChatStore SQLite file end-to-end;
//! the TS `libzaungast` opens it read-only and serves the API. Developed as a
//! pure-cargo-testable library (each byte-layer verified against a TS differential oracle); the
//! napi-rs boundary (`bindings`, `--features napi`) wraps `store::ingest_to_file`. Read-only always
//! on the source: File::open, never leveldb DB::open (it only ever WRITES the separate ChatStore).
//!
//! Layout mirrors the TS reader: `format` (byte readers → decode → fingerprint/extract) and `store`
//! (the SQLite writer + incremental refresh), plus the `text` (htmlToText) and `sha256` leaves. Layer
//! status: all byte-identical to the TS reference on real data (sstable/wal/dedup → structured-clone
//! → fingerprint/extract → htmlToText → SQLite store, 6/6 tables).

pub mod format;
pub mod sha256;
pub mod store;
pub mod text;

// Flat re-exports of the format modules. The file tree is layered (format/…), but the public module
// paths stay flat + stable (`crate::sstable`, `libzaungast_native::fingerprint`, …) so the diff bins
// and the store layer address the phase functions by short path without churn.
pub use format::{fingerprint, idb, resolver, snappy, sstable, value, wal};

// The Node addon (N-API) surface — only compiled with `--features napi` (produces the .node the TS
// engine switch loads). The pure-Rust pipeline lives in `store::ingest_to_file`; this is a thin
// wrapper, so the crate stays fully testable via cargo/the diff bins without Node.
#[cfg(feature = "napi")]
pub mod bindings;
