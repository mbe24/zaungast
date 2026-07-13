# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Six read-only tools: `list_conversations`, `read_messages`, `search`, `top_topics`,
  `find_person`, `describe_schema`.
- Pure-JS reader for the Chromium IndexedDB LevelDB the new Teams app writes: SSTable +
  write-ahead-log parser, Snappy decoder, Chromium IndexedDB key coding, and a Blink/V8
  structured-clone value deserializer — no native dependencies, no `idb_cmp1` comparator
  needed (full scan + sequence-number dedup).
- Zero-config auto-discovery of the local Teams IndexedDB directory (override with
  `TEAMS_LEVELDB_DIR`).
- In-memory SQLite index (`node:sqlite`) with FTS5 full-text search.
- Incremental refresh with two modes — `copy-reuse` (default, reuses immutable `.ldb`
  parses; re-reads only the write-ahead log) and `reparse` (`ZAUNGAST_INCREMENTAL=reparse`)
  — proven to produce identical results.
- `top_topics` distinctive-vs-baseline scoring with bot exclusion, per-call `exclude`
  (words / handles), and arbitrary `since`/`until` windows.
- Cache-horizon disclosure: empty/edge results report the local coverage window so a
  quiet result is never mistaken for "the cache doesn't reach that far".
- English + German stopword sets (extensible registry).

### Safety

- The live Teams directory is only ever read/copied — never opened for writing, never
  locked, never memory-mapped. The reader cannot corrupt the Teams store.
