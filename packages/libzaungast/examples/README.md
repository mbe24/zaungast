# libzaungast examples

Runnable examples for the library. These are **not published** (the package ships only `dist/`) and are
not compiled by the package's `tsc` (which is `src`-only, with no DOM lib) — for the browser example the
**esbuild build is the check** (a break fails `node build.mjs`). `sqlite-wasm-driver.ts` is additionally
type-checked and exercised by the library's own tests.

`@sqlite.org/sqlite-wasm` is a **devDependency** used only here — the library itself has no browser
dependency.

## `sqlite-wasm-driver.ts`

A reference `SqlDriver` (libzaungast's `B1` seam) over [`@sqlite.org/sqlite-wasm`](https://sqlite.org/wasm) —
the wasm SQLite build the browser path runs on. It ships FTS5 (so full-text search works) and has a
synchronous API. Copy it into your own app, or swap in a different wasm SQLite by implementing the same
tiny interface. Used by `browser-demo/` and by the library's tests (`test/sqlite-wasm-driver.unit.ts`,
`test/openstore-from-source.fixture.ts`).

## `browser-demo/`

Reads a Microsoft Teams cache **entirely in the browser** via `libzaungast/web`: pick a
`…indexeddb.leveldb` folder → decode → build a wasm SQLite store → query it (conversations, messages,
people, events, calls, topics, FTS search). Nothing is uploaded.

Build both outputs (build the library first):

```sh
npm run build --workspace libzaungast
node packages/libzaungast/examples/browser-demo/build.mjs
```

`build.mjs` emits two shapes into `browser-demo/dist/` (gitignored):

- **Hosted** — `index.html` + `main.js` + `worker.js` + `sqlite3.wasm`. Runs the build in a **Web
  Worker**, so the UI stays responsive and shows **live** per-file + per-phase progress. Must be served
  over http (Workers/modules/wasm-fetch don't work from `file://`): `node browser-demo/serve.mjs`, VS
  Code Live Server, GitHub Pages, etc.
- **Standalone** — a single self-contained `standalone.html` you can **double-click** (`file://`, no
  server). No Worker, so the tab is unresponsive for the few seconds the build takes and phase timings
  appear at the end; everything (JS + wasm) is inlined.

Both expose a "Self-test (no data)" button that only exercises the wasm driver, and a "Pick Teams cache
folder…" button for a real run.
