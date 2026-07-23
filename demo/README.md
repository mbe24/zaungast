# Your Teams, Wrapped — demo

A static web app that reads your local **Microsoft Teams** cache **entirely in your browser** and turns
it into a year-in-review — totals, busiest day, night-owl index, longest streak, the people you talk to,
activity over time, and your first cached message. Nothing is uploaded; the data never leaves the tab.

It's the showcase for [`libzaungast`](../packages/libzaungast) (the Teams-cache reader) and the
`zaungast` MCP server.

## How it works

A Web Worker owns `libzaungast/web` + a wasm SQLite build: you pick your `…indexeddb.leveldb` folder, it
decodes it and builds an in-memory store, and the UI queries that over
[Comlink](https://github.com/GoogleChromeLabs/comlink) — all client-side. (The in-app "Need help finding
the folder?" dialog shows where the cache lives on Windows / macOS.)

## Develop

The demo bundles `libzaungast/web` from the local workspace (`file:../packages/libzaungast`), so build the
library first:

```sh
# from the repo root — install + build the library the demo links
npm ci
npm run build --workspace libzaungast

# then run the demo (its own install; not a workspace member)
cd demo
npm install
npm run dev
```

## Build & deploy

```sh
npm run build                       # static site → demo/build/
BASE_PATH=/zaungast npm run build   # with the GitHub Pages project subpath
```

Deployment is **manual**: Actions → "Deploy demo to GitHub Pages" → Run workflow
(`.github/workflows/pages.yml`). Live at <https://mbe24.github.io/zaungast/>.

## Stack

SvelteKit (static adapter) · Tailwind + shadcn-svelte · Observable Plot + d3-force · a Comlink Web Worker
over `libzaungast/web` + `@sqlite.org/sqlite-wasm`. Cross-browser and fully static — no server, no
COOP/COEP headers needed.

Once `libzaungast` is published to npm, the `file:` dependency becomes `libzaungast@^0.5.0`.
