//! N-API surface (compiled only with `--features napi`). A thin wrapper over
//! `writer::ingest_to_file`: reads the Teams leveldb dir and writes the ChatStore SQLite file, then
//! returns the meta TS needs. All the real work — and all the tests — live in the pure-Rust modules;
//! this file only marshals across the Node boundary.

// The #[napi] boundary dictates these signatures: exported fns take owned String/Vec<String>
// (that's what the macro marshals JS values into — borrowing is not an option). needless_pass_by_value
// is Rust-idiom advice that doesn't apply here.
#![allow(clippy::needless_pass_by_value)]

use napi::bindgen_prelude::External;
use napi_derive::napi;

/// Conformance version. The TS `auto` engine only trusts the native path when this matches the
/// value it was built against; bump it whenever native output could diverge from the TS reference
/// (schema shape, extraction, compaction, handle assignment, …). A mismatch → warn + fall back to JS.
#[napi]
pub fn conformance_version() -> u32 {
    1
}

/// The result of a native full ingest — mirrors the fields TS folds into its StoreMeta. Numbers are
/// JS `number` (u32 counts; f64 epoch-ms, exact below 2^53) rather than BigInt for a natural JS shape.
#[napi(object)]
pub struct IngestResult {
    pub fingerprint: String,
    pub schema_matched: bool,
    pub mapping_version: Option<String>,
    pub lossy: bool,
    pub self_mri: Option<String>,
    pub conversations: u32,
    pub messages: u32,
    pub people: u32,
    pub earliest_ts: f64,
    pub fts_enabled: bool,
}

/// Full ingest (seam A): read `dir`, fingerprint + select among `mappings` (the bundled mapping
/// JSON texts from the TS package), and write the ChatStore to `dest_path` (overwriting any prior
/// file). `schema` is the single-source DDL string. Synchronous, matching the TS `ingest()` model.
#[napi]
pub fn native_ingest(
    dir: String,
    dest_path: String,
    schema: String,
    mappings: Vec<String>,
) -> napi::Result<IngestResult> {
    let o = crate::store::ingest_to_file(&dir, &dest_path, &schema, &mappings)
        .map_err(napi::Error::from_reason)?;
    Ok(IngestResult {
        fingerprint: o.fingerprint,
        schema_matched: o.schema_matched,
        mapping_version: o.mapping_version,
        lossy: o.lossy,
        self_mri: o.self_mri,
        conversations: o.conversations as u32,
        messages: o.messages as u32,
        people: o.people as u32,
        earliest_ts: o.earliest_ts as f64,
        fts_enabled: o.fts_enabled,
    })
}

/// The result of a native incremental refresh. `needFullRebuild` → the delta couldn't apply (schema
/// tripwire / stale file / mapping gone); the caller must full-rebuild via nativeIngest. `skipped` →
/// a lossy load; nothing applied, `newPath` is a byte-copy of the previous file, keep serving it.
// Four independent refresh-outcome flags (rebuild / skip / defer / lossy) marshaled flat to JS; the
// `#[napi(object)]` shape is a flat struct, not a union, so this isn't a state better modeled as enum.
#[allow(clippy::struct_excessive_bools)]
#[napi(object)]
pub struct RefreshResult {
    pub need_full_rebuild: bool,
    pub skipped: bool,
    /// Copy-reuse only: a compaction consumed a cached `.ldb`, so reuse can't be trusted for a delta —
    /// the caller falls back to the cacheless `nativeRefresh`. Always false from `nativeRefresh`.
    pub deferred: bool,
    pub fingerprint: String,
    pub mapping_version: Option<String>,
    pub self_mri: Option<String>,
    pub lossy: bool,
    pub conversations: u32,
    pub messages: u32,
    pub people: u32,
    pub earliest_ts: f64,
}

/// Incremental refresh (seam A): copy `prevPath` → `newPath`, apply the delta from `dir` up to the
/// current sequence, and rewrite the new file's in-file meta. The previous file is never mutated (TS
/// may hold a read-only handle) — on success TS swaps to `newPath`. `mappings` are the bundled JSON
/// texts (the same set as nativeIngest); the mapping is reused by mappingVersion from the prev file.
#[napi]
pub fn native_refresh(
    dir: String,
    prev_path: String,
    new_path: String,
    mappings: Vec<String>,
) -> napi::Result<RefreshResult> {
    let o = crate::store::refresh_to_file(&dir, &prev_path, &new_path, &mappings)
        .map_err(napi::Error::from_reason)?;
    Ok(RefreshResult {
        need_full_rebuild: o.need_full_rebuild,
        skipped: o.skipped,
        deferred: o.deferred,
        fingerprint: o.fingerprint,
        mapping_version: o.mapping_version,
        self_mri: o.self_mri,
        lossy: o.lossy,
        conversations: o.conversations as u32,
        messages: o.messages as u32,
        people: o.people as u32,
        earliest_ts: o.earliest_ts as f64,
    })
}

/// Create a fresh, empty copy-reuse cache (Axis B). The TS side calls this once per FULL ingest and
/// carries the returned opaque handle on its `{ native }` state; every later `nativeReuseRefresh`
/// receives it back, reusing cached immutable `.ldb` parses. Held per-Session (not a process global)
/// and finalized when the handle is GC'd — so the parsed-`.ldb` RAM is bounded to one live store and
/// freed on dispose. A new full rebuild mints a new cache (mirrors the JS engine clearing `ldbCache`).
#[napi]
pub fn native_new_cache() -> External<crate::idb::LdbCache> {
    External::new(crate::idb::LdbCache::new())
}

/// Copy-reuse incremental refresh (Axis B): like `nativeRefresh`, but reuses the cached immutable
/// `.ldb` parses in `cache` and re-reads only the `.log`. `dir` is the Session's mirrored snapshot dir
/// (kept in lock-step with live by `snapshotReuse`). `deferred=true` ⇒ a compaction was detected;
/// nothing was written and the caller must fall back to `nativeRefresh` (the cacheless reparse, which
/// reconciles compaction-elided deletions). `cache` is mutated in place (new parses cached, dead
/// entries pruned) and lives across calls via the opaque External handle.
#[napi]
pub fn native_reuse_refresh(
    dir: String,
    prev_path: String,
    new_path: String,
    mappings: Vec<String>,
    mut cache: External<crate::idb::LdbCache>,
) -> napi::Result<RefreshResult> {
    let o = crate::store::reuse_refresh_to_file(&dir, &prev_path, &new_path, &mappings, &mut cache)
        .map_err(napi::Error::from_reason)?;
    Ok(RefreshResult {
        need_full_rebuild: o.need_full_rebuild,
        skipped: o.skipped,
        deferred: o.deferred,
        fingerprint: o.fingerprint,
        mapping_version: o.mapping_version,
        self_mri: o.self_mri,
        lossy: o.lossy,
        conversations: o.conversations as u32,
        messages: o.messages as u32,
        people: o.people as u32,
        earliest_ts: o.earliest_ts as f64,
    })
}
