# Agent Policy

Execution rules for automation agents contributing to this repository. This is the single top-level
source of truth.

## Commit messages

For every completed task with repo changes, provide a single-line Conventional Commit message draft
with a scope: `type(scope): summary`.

## Docs sync

When a change affects observable behavior, CLI usage, or workflow, ask to update the following docs:

1. `README.md` — keep usage examples and command reference current.
2. `docs/` — update any affected content pages (getting-started, configuration, etc.).

If a docs page does not exist yet for new behavior, ask to create it under `docs/` and register it in `mkdocs.yml`.

## TypeScript — post-change gate (the primary check; mirrors CI)

After changes, esp.to the data layer, run the same checks CI runs:

```bash
npm run format:check && npm run typecheck && npm run typecheck:test \
  && npm test && npm run test:fixture && npm run test:integration:ci
```

## Rust — post-change (`packages/libzaungast-native` only)

Only when Rust source changed. Run these from `packages/libzaungast-native/`:

```bash
cargo fmt
cargo clippy --features harness --all-targets --no-deps -- -W clippy::pedantic   # lib + diff bins
cargo clippy --features napi    --lib          --no-deps -- -W clippy::pedantic   # the napi addon
```

> Tip: if your environment blocks executing freshly-built native binaries, run the toolchain inside a Linux container instead — e.g. `rust:1-slim-bookworm`.

For a native **behavior** change, the real gate is the byte-differential — the native engine must stay
byte-identical to the TS reference:

```bash
node packages/libzaungast-native/harness/run.mjs <leveldb-dir> --layer store   # also: --layer incr
# ZAUNGAST_NATIVE_RUNNER=local (native) or =docker (blocked environments)
```
