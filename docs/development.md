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
| `npm run typecheck` | `tsc --noEmit` over `src/`. |
| `npm run typecheck:test` | Type-check `test/` (via `test/tsconfig.json`; run in CI). |
| `npm run format` | Format `src/` + `test/` with Prettier. |
| `npm run format:check` | Verify formatting (run in CI). |
| `npm test` | Data-free unit tests (vitest `unit` project) — run in CI. |
| `npm run test:watch` | Vitest in watch mode (all projects) for local development. |
| `npm run test:fixture` | Generate a synthetic leveldb cache and drive the full read → ingest → tools pipeline against it — no real data; run in CI. |
| `npm run test:integration:ci` | Run the mutation/equivalence harnesses against a synthetic `.ldb`+`.log` fixture — no real data; run in CI. |
| `npm run test:integration` | Same harnesses against a **real** local Teams cache (see below). |
| `npm run test:golden` | Freeze decode/extract + MCP tool output over the synthetic fixture — run in CI. |
| `npm run test:golden:real` | Same freezes over a **real** local cache (skip-if-absent; local only). |
| `npm run dev` | Run the server from source via `tsx` (no build step). |
| `npm run assets` | Re-render the SVG brand assets in `assets/` and `.github/` to PNG. |

## Code style

Formatting is enforced by **Prettier** (`.prettierrc`: semicolons, single quotes, 100 columns);
`npm run format:check` runs in CI. Run `npm run format` before committing.

There is no ESLint yet: `typescript-eslint` does not support TypeScript 7 (its parser targets
`typescript < 6.1`), so it can't run on this codebase. It'll be added once upstream supports
TS 7; the intended ruleset is typescript-eslint `recommended` + `no-unused-vars` (ignoring `_`)
+ `no-console` scoped to `src/` (stdout is the MCP transport).

## Tests

Tests run on **vitest**, split into five **role projects** by a filename suffix — `*.unit.ts` (pure,
CI), `*.fixture.ts` (synthetic-fixture-driven, CI), `*.golden.ts` (synthetic golden, CI), `*.int.ts`
(integration — a synthetic fixture in CI, or a real cache locally), `*.real.ts` (real-cache golden,
skip-if-absent). `npm test` / `test:fixture` / `test:golden` / `test:integration` / `test:golden:real`
each run one project (`vitest run --project <role>`); `test:watch` runs them all in watch mode, and
goldens update with `-u` (e.g. `npm run test:golden -- -u`).

Two guarantees carry over from the previous bespoke runner. `check:test-naming` (run in CI) fails if
any `test/**` file lacks a role suffix — vitest's include-globs would otherwise silently skip it, the
exact "test the runner forgets" failure mode. And the data-gated projects (`int`/`real`) self-skip
**green** when no cache is present, printing a visible reason — never a silent pass.

- **Unit** (`npm test`) exercise the pure layers — Snappy, structured-clone decode, CRC32C,
  key coding, HTML→text, handles, topic extraction — with synthetic inputs and **no Teams
  data**. These run in CI.
- **Synthetic fixture** (`test/fixture/`) — a group of CS students chatting, entirely fake and
  PII-free. It's the reader's *inverse*: `test/fixture/encode.ts` + `sstable-encode.ts` write the
  same byte formats `src/format/chromium/*` reads (`.log` WAL, `.ldb` SSTable, IndexedDB key
  coding, V8 structured-clone), deterministically. Two CI tests run against it, needing no real
  cache:
  - `npm run test:fixture` generates a WAL-only cache and drives the full read → ingest → tools
    pipeline, asserting the decoded content matches what was generated.
  - `npm run test:integration:ci` runs the mutation/equivalence harnesses (`incremental.int.ts`,
    `reuse.int.ts`, `feedback.int.ts`), each generating its own synthetic `.ldb`+`.log` fixture —
    including `.ldb` truncation and forced compaction.
- **Real-cache integration** (`npm run test:integration`) runs the same `*.int.ts` harnesses against
  a **real** on-disk Teams cache — a belt-and-braces check that
  catches real-world format quirks the synthetic fixture doesn't model. It runs locally (shipping
  a real cache would leak PII): point it at a copy of your leveldb dir via `ZAUNGAST_TEST_DIR`
  (or pass the dir as `argv[2]` to a harness directly).

The integration suite's backbone is an **equivalence invariant**: an incrementally-refreshed
store must be byte-identical to a full rebuild of the same on-disk state — which keeps the
fast `copy-reuse` path provably correct.

## Architecture

- `src/format/` — the stable, dependency-free reader. `src/format/index.ts` is the public
  barrel every caller imports; it's the single seam. Underneath:
  - `src/format/chromium/` — the Windows Chromium-IndexedDB-on-LevelDB byte format (SSTable,
    write-ahead log, Snappy, IndexedDB key coding, V8 structured clone). Engine-specific — a
    second platform (e.g. macOS WebKit-on-SQLite) would be a sibling directory yielding the
    same record contract, not a rewrite.
  - `src/format/fingerprint.ts`, `resolver.ts`, `discover.ts` — the engine-agnostic schema
    layer (version fingerprint, field mapping) and the on-disk locator. Unchanged across Teams
    updates.
  - `src/format/types.ts` — the shared record/result contracts.
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
`main`. To publish: bump `version` in `package.json`, tag `vX.Y.Z`, and push the tag — the
release workflow verifies the tag matches the version and that CI is green for the commit,
then publishes to npm with provenance.
