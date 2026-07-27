# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.0] - 2026-07-27

### Added

- Add browser support for reading, ingesting, and querying a Teams cache.
- Add a `./web` entry point built on a pluggable `SqlDriver` seam, with a `node:sqlite` driver and an optional `@sqlite.org/sqlite-wasm` browser driver at `libzaungast/web/sqlite-wasm-driver` (installed separately, only if you use it).
- Add `openStoreFromSource`, a single build path that behaves identically in Node and the browser, with an optional `onPhase` hook for build-progress reporting.
- Speed up the first read with an optional Web Worker pool (`createPool`, `handlePoolMessage`, `openStoreFromSourceParallel`, `extractFromSourceParallel`) that parses `.ldb` files and extracts records in parallel, falling back to serial automatically.
- Add a `deferFts` option to build the full-text search index lazily on first search instead of during ingest.
- Add an engine-agnostic data seam (`shapeBaseTables`, `deriveTables`, `baseMeta`, and named row types), a read-only `rawDb` accessor, and topic-scorer exports, so a non-SQLite backend or custom analytics can build a byte-matching store.
- Add organization, profile type, and structured given/surname names to people, recovered for federated (external) contacts.

## [0.4.0] - 2026-07-21

### Added

- Publish the reader as a standalone `libzaungast` package with a public data facade, split out from the `zaungast` MCP server.
- Add an optional native (Rust) ingest engine, `libzaungast-native`, selectable via `ZAUNGAST_ENGINE`, with byte-identical output and an incremental-refresh path.
- Add `get_message` and `read_thread` tools.
- Render channel conversations by reply-chain (threaded).
- Persist conversation thread type, as a foundation for Teams Communities data.

### Changed

- Rename the `top_topics` tool to `rank_topics`, and `read_messages` to `read_conversation` (per-thread and single-message reads move to the new `read_thread` and `get_message` tools).
- Report the real package version in the MCP server info and startup banner.
- Speed up ingest and structured-clone decode via whole-file reads, memoized prefix decoding, single-pass HTML-to-text, and delta full-text indexing on refresh.

### Fixed

- Match the Teams schema by exact fingerprint through a versioned mapping registry, instead of guessing.

## [0.3.0] - 2026-07-16

### Added

- Add `list_events` and `list_calls` tools for calendar events and call history.
- Auto-discover the Teams store on macOS.

### Fixed

- Label your own messages with your name and `(you)` instead of `ME`.
- Encode `chain_key` NUL-safely (hex) so reply-chain keys containing NUL bytes ingest correctly.

## [0.2.0] - 2026-07-15

### Added

- Render emoji reactions in `read_messages`.
- Decode Blink blob values (`kHostObject`), completing structured-clone value coverage.

### Changed

- Speed up structured-clone decode by roughly 2×.

### Fixed

- Decode `BigInt` values instead of substituting `0`.

## [0.1.1] - 2026-07-13

Re-release of 0.1.0 with no functional changes.

### Fixed

- Add the repository metadata npm requires for a provenance publish.

## [0.1.0] - 2026-07-13

Initial release.

### Added

- Provide six read-only MCP tools: `list_conversations`, `read_messages`, `search`, `top_topics`, `find_person`, and `describe_schema`.
- Read the Chromium IndexedDB-on-LevelDB store the Teams app writes in pure JavaScript — an SSTable and write-ahead-log parser, a Snappy decoder, Chromium IndexedDB key coding, and a Blink/V8 structured-clone deserializer — with no native dependencies and no `idb_cmp1` comparator (full scan plus sequence-number dedup).
- Auto-discover the local Teams IndexedDB directory with zero configuration (override with `TEAMS_LEVELDB_DIR`).
- Index the data in an in-memory SQLite database (`node:sqlite`) with FTS5 full-text search.
- Refresh incrementally in two modes — `copy-reuse` (default; reuses immutable `.ldb` parses and re-reads only the write-ahead log) and `reparse` (`ZAUNGAST_INCREMENTAL=reparse`) — proven to produce identical results.
- Score `top_topics` by distinctiveness against a baseline, with bot exclusion, per-call `exclude` (words or handles), and arbitrary `since`/`until` windows.
- Disclose the local cache horizon: empty or edge results report the coverage window, so a quiet result is never mistaken for "the cache doesn't reach that far".
- Ship extensible English and German stopword sets.
- Guarantee read-only access — the live Teams directory is only ever read or copied, never opened for writing, locked, or memory-mapped, so the reader cannot corrupt the Teams store.

[Unreleased]: https://github.com/mbe24/zaungast/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/mbe24/zaungast/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/mbe24/zaungast/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/mbe24/zaungast/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/mbe24/zaungast/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/mbe24/zaungast/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/mbe24/zaungast/releases/tag/v0.1.0
