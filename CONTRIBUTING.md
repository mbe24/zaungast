# Contributing

Thanks for helping improve zaungast (a local-first, read-only MCP server over the Microsoft Teams
on-disk cache). This is the short version; [`docs/development.md`](docs/development.md) has the detail
(scripts, architecture, the read path).

> Contributing through an AI agent? [`AGENTS.md`](AGENTS.md) holds the
> agent-specific execution rules. Human contributors just need this guide.

## Setup

```sh
npm install   # Node.js >= 22.5
```

## Before you open a PR

Run the same gate CI runs, and keep it green:

```sh
npm run format:check
npm run typecheck && npm run typecheck:test
npm run check:test-naming
npm test && npm run test:fixture && npm run test:integration:ci && npm run test:golden
```

`npm run test:watch` gives you the vitest watch UI while iterating.

## Tests

Tests are vitest, split into five **role projects** by filename suffix — pick the right one, since
`check:test-naming` fails the build if a `test/**` file has no recognized suffix (vitest would
otherwise silently skip it):

- `*.unit.ts` — pure, data-free (CI)
- `*.fixture.ts` — driven by the synthetic PII-free fixture (CI)
- `*.golden.ts` — frozen output over the synthetic fixture (CI); update with `-u`
- `*.int.ts` — integration: a synthetic fixture in CI, or a real cache locally via `ZAUNGAST_TEST_DIR`
- `*.real.ts` — golden over a real local cache; skips (green) when none is present

Add tests as synthetic wherever possible — never commit a real Teams cache (PII). See
`docs/development.md` for how the fixture models the byte formats.

## Native accelerator (Rust)

Only relevant if you touch `packages/libzaungast-native`. It must stay **byte-identical** to the TS
reference: run `npm run diff -- <leveldb-dir|date>` (every layer must report `0 differ`) and
`npm run check:native` (Rust fmt + clippy; builds via cargo, auto-falling back to Docker where a
native build is blocked). `npm run diff` compares the Rust reader against the built `dist`, so it
hard-fails if `src` is newer than `dist` — run `npm run build` after editing TypeScript.

## Commits & docs

- **Commit messages**: single-line [Conventional Commits](https://www.conventionalcommits.org/),
  imperative, with a scope — e.g. `fix(format): handle empty reply chain`.
- **Docs**: if a change affects observable behavior, CLI usage, or workflow, update `README.md` and the
  relevant page under `docs/` in the same PR.
