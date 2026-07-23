# Agent Policy

Execution rules for automation agents contributing to this repository. This is the single top-level
source of truth.

## Commit messages

For every completed task with repo changes, provide a single-line Conventional Commit message draft
in imperative language with a scope, e.g., `type(scope): fix bug X in component Y`. When asked to commit, use that same style for the commit itself.

## Docs sync

When a change affects observable behavior, CLI usage, or workflow, ask to update the following docs:

1. `README.md` — keep usage examples and command reference current.
2. `docs/` — update any affected content pages (getting-started, configuration, etc.).

If a docs page does not exist yet for new behavior, ask to create it under `docs/` and register it in `mkdocs.yml`.

## Validation — post-change

Run the same gate CI runs, then keep it green. Exact invocations live in `package.json` scripts and
`.github/workflows/` — this section is *what* to check and *when*, not command lines to copy (they drift).

### TypeScript (primary gate; mirrors CI)

The `format:check` → `typecheck`/`typecheck:test` → `test`/`test:fixture`/`test:integration:ci` chain,
after any change (especially the data layer).

### Rust (`packages/libzaungast-native`, only when Rust source changed)

- **Style/lint:** `npm run check:native` — wraps `cargo fmt` + pedantic `clippy`, auto-falling back to
  Docker when the host can't build natively.
- **Behavior:** the native engine must stay byte-identical to the TS reference. Run the byte-differential
  via `npm run diff -- <dir|date> [--layer <name>|all]` (wraps `harness/run.mjs`; resolves the leveldb
  dir, default layers `store,incr`, `all` runs every layer); every layer must report `0 differ`.
  `store` + `incr` are the minimum — for a multi-module change, a refactor/rename, or when unsure which
  layer is hit, run `--layer all` plus the Rust unit tests (`npm run test:native`; pass a `<dir|date>`
  to also run the `ZAUNGAST_TEST_DIR`-gated parity tests). Layers map to the same-named module under
  `format/`/`store/`. `npm run verify:native -- <dir|date>` chains check:native + tests + `store,incr`.

## Profiling

Dev harnesses (NOT in CI). Both profilers emit the **v1 timings schema** (`scripts/lib/timings-v1.mjs`
is the spec of record) — shared canonical `metrics` + engine-specific `engineExtra` — so runs are
directly comparable:

- `npm run profile -- <leveldb-dir> [--heavy]` (TS)
- `npm run profile:native -- <leveldb-dir> [--heavy]` (native Rust; WSL2/Linux only)
- `npm run profile:compare -- <former.json> <current.json>` — diffs two runs; mode is inferred from
  `engine` (differ → cross-engine parity table; match → former→current regression with drift flags).
  Cross-engine parity requires both runs on the **same platform** (both WSL2); `--allow-cross-runner`
  downgrades that to a warning.

`npm run profile` and the `npm run diff` TS oracle both load the built `dist`, so they **hard-fail if any
loaded package's `src` is newer than its `dist`** — run `npm run build` first (the profiler also stamps the
dist build time into its timings envelope, so a stale run stays detectable after the fact).

The shared percentile definition (nearest-rank ceil-clamped + population stddev) is pinned by a test
vector on both sides — `npm run test:schema` (TS, gated in CI) and the `percentile_vector_matches_ts`
test in `src/bin/profile.rs` (native, gated via `cargo test --features harness --bin profile`).

Being outside CI the profilers themselves drift silently — when a change reshapes profiled code (tool
rename, engine restructure), recheck they still run and measure the right thing.
