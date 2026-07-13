# Development

## Setup

```sh
git clone https://github.com/mbe24/zaungast && cd zaungast
npm install
```

Requires Node.js ≥ 22.5.

## Scripts

| Script | Description |
|--------|-------------|
| `npm run build` | Compile TypeScript to `dist/` and copy schema mappings. |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm test` | Data-free unit tests (`test/unit.ts`) — run in CI. |
| `npm run test:integration` | Full suite against a real local Teams cache (see below). |
| `npm run dev` | Run the server from source via `tsx` (no build step). |
| `npm run assets` | Re-render the SVG brand assets in `assets/` and `.github/` to PNG. |

## Tests

- **Unit** (`npm test`) exercise the pure layers — Snappy, structured-clone decode, CRC32C,
  key coding, HTML→text, handles, topic extraction — with synthetic inputs and **no Teams
  data**. These run in CI.
- **Integration** (`npm run test:integration`) drive ingest, the tools, and the refresh
  lifecycle against a real on-disk Teams cache. They can't run in CI (shipping a real cache
  would leak PII), so they run locally. Point them at a copy of your leveldb dir; the harness
  scripts take the directory as an argument.

The integration suite's backbone is an **equivalence invariant**: an incrementally-refreshed
store must be byte-identical to a full rebuild of the same on-disk state — which keeps the
fast `copy-reuse` path provably correct.

## Architecture

- `src/format/` — the stable, dependency-free reader (SSTable, WAL, Snappy, IndexedDB key
  coding, Blink/V8 structured-clone, fingerprint, discovery). Unchanged across Teams updates.
- `src/schema/versions/` — per-fingerprint field **mappings** (the volatile part).
- `src/ingest/` — `store.ts` (SQLite schema + derived recompute) and `ingest.ts` (decode →
  rows, full + incremental).
- `src/session.ts` — snapshot + refresh lifecycle (copy-reuse / reparse).
- `src/tools.ts`, `src/schemas.ts`, `src/server.ts` — the MCP tools and their argument
  schemas. `src/index.ts` is the bootstrap; `src/main.ts` is the actual server entry.

See [How it works](how-it-works.md) for the read path in detail, and the
[Chromium IndexedDB format reference](reference/chromium-indexeddb-format.md) for the
byte-level spec each layer implements.

## Releasing

CI (`.github/workflows/ci.yml`) runs typecheck + build + unit tests on every push/PR to
`master`. To publish: bump `version` in `package.json`, tag `vX.Y.Z`, and push the tag — the
release workflow verifies the tag matches the version and that CI is green for the commit,
then publishes to npm with provenance.
