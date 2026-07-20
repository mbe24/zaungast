// libzaungast ENGINE-AUTHOR SPI (Service Provider Interface). This is NOT the client API (that's the
// package root '.'). This subpath is the contract + building blocks for implementing an ingest engine
// — e.g. the optional native accelerator (libzaungast-native) — that the CONSUMER injects into
// openStore / openLiveStore via the `engine` option. libzaungast itself never depends on any such
// engine; it only defines what one must implement.
//
// Stability: this surface is SEMVER-EXEMPT relative to the client API. An engine author pins it
// deliberately; it must not constrain '.' versioning.
//
// Core-seed invariant: everything re-exported here bottoms out at libzaungast LEAF modules
// (ingest/engine, ingest/ingest, ingest/store, ingest/conformance, format/resolver) with no
// dependency on the client API. That is what lets this whole surface later lift into a shared
// `libzaungast-core` by moving this module and rewiring a single import edge.
//
// How an engine uses it: implement `IngestEngine` (full / refresh, optional reuseRefresh), returning
// `Ingested`s. Build the store .db yourself (the reader's DDL is `SCHEMA_SQL`; the bundled
// schema-mapping texts are `loadBundledMappingTexts()`), then wrap the finished file with
// `openStoreFile` (so `ChatStore` stays internal to libzaungast). Match `EXPECTED_CONFORMANCE` before
// trusting native output. Assemble your own `StoreMeta` (this SPI exports its shape as a type).

// The engine contract + its refresh-outcome union, and the data shapes an engine produces.
export type { IngestEngine, RefreshResult } from './ingest/engine.js';
export type { Ingested } from './ingest/ingest.js';
export type { StoreMeta } from './ingest/store.js';

// Ingest INPUTS an engine feeds to its store builder: the reader's SQLite DDL + the bundled
// schema-mapping texts (an array of JSON strings).
export { SCHEMA_SQL } from './ingest/store.js';
export { loadBundledMappingTexts } from './format/resolver.js';

// The reader's conformance-contract version — an engine's addon must match it before its output is
// trusted (the handshake the consumer enforces).
export { EXPECTED_CONFORMANCE } from './ingest/conformance.js';

// The OUTPUT factory: wrap an engine-built store .db as an `Ingested`. Keeps `ChatStore` internal.
export { openStoreFile } from './ingest/ingest.js';
