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

Two dev harnesses (NOT in CI):

- `npm run profile -- <leveldb-dir> [--heavy]` (TS)
- `npm run profile:native -- <leveldb-dir> [--heavy]` (native Rust; WSL2/Linux only)

Being outside CI they drift silently — when a change reshapes profiled code (tool rename, engine
restructure), recheck they still run and measure the right thing.
