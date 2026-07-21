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

// clippy::pedantic is the post-change gate. The lints allowed below are noise in a byte-exact
// serialization/crypto crate and are opted out deliberately rather than annotated at every site:
//   * cast_* — deliberate int-width casts on lengths/offsets/tags that are known-bounded by the
//     on-disk formats we mirror; widening/narrowing here is intentional and byte-significant.
//   * missing_errors_doc / missing_panics_doc / must_use_candidate — this is an internal accelerator,
//     not a public API; the Result/panic/#[must_use] contracts add churn without readers who need them.
//   * many_single_char_names — SHA-1/SHA-256 working variables (a..h) follow the FIPS spec verbatim.
//   * implicit_hasher — internal helpers keyed on the std hasher; genericizing buys nothing here.
//   * doc_markdown — the module prose references product/schema names (IndexedDB, ChatStore, leveldb,
//     StoreMeta, …) that read as prose, not code; backticking every one is noise.
#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    clippy::cast_lossless,
    clippy::missing_errors_doc,
    clippy::missing_panics_doc,
    clippy::must_use_candidate,
    clippy::many_single_char_names,
    clippy::implicit_hasher,
    clippy::doc_markdown
)]

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
