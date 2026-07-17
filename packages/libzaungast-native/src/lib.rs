//! libzaungast-native — the optional Rust accelerator for libzaungast.
//!
//! Plan: `plan/rust-core-plan.md`. Seam A — this crate reads the Teams leveldb dir and writes the
//! ChatStore SQLite file; the TS `libzaungast` opens it read-only and serves the API. Developed as a
//! pure-cargo-testable library (each byte-layer verified against a TS differential oracle); the
//! napi-rs boundary is added last (P5). Read-only always: File::open, never leveldb DB::open.
//!
//! Layer status: P1 in progress — sstable reader (below); wal / idb-dedup / structured-clone /
//! resolver / fingerprint / store to follow.

pub mod fingerprint;
pub mod idb;
pub mod sha256;
pub mod snappy;
pub mod ssv;
pub mod sstable;
pub mod wal;
