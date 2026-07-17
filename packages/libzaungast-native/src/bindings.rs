//! N-API surface (compiled only with `--features napi`). A thin wrapper over
//! `writer::ingest_to_file`: reads the Teams leveldb dir and writes the ChatStore SQLite file, then
//! returns the meta TS needs. All the real work — and all the tests — live in the pure-Rust modules;
//! this file only marshals across the Node boundary.

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
    pub schema_version: Option<String>,
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
    let o = crate::writer::ingest_to_file(&dir, &dest_path, &schema, &mappings)
        .map_err(napi::Error::from_reason)?;
    Ok(IngestResult {
        fingerprint: o.fingerprint,
        schema_matched: o.schema_matched,
        schema_version: o.schema_version,
        lossy: o.lossy,
        self_mri: o.self_mri,
        conversations: o.conversations as u32,
        messages: o.messages as u32,
        people: o.people as u32,
        earliest_ts: o.earliest_ts as f64,
        fts_enabled: o.fts_enabled,
    })
}
