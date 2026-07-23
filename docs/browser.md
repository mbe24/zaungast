# Browser usage

libzaungast runs its whole read pipeline — decode → schema resolution → SQLite store → the query
facade — **in the browser**, with no `node:fs`, `node:crypto`, `node:sqlite`, or Node builtins. The
browser-safe surface is the `libzaungast/web` entry point. It exposes the same static query namespaces
as `openStore(dir)` (conversations, messages, people, events, calls, topics — including FTS5 search),
minus the filesystem-backed and auto-refreshing pieces.

Two things differ from the Node path, both provided by the caller:

1. **Where the bytes come from** — instead of a directory path, libzaungast takes a `SnapshotSource`
   (a `MemorySource` built from the leveldb files' bytes).
2. **The SQLite engine** — instead of the built-in `node:sqlite`, an injected `SqlDriver`. Any
   WebAssembly SQLite build works; [`@sqlite.org/sqlite-wasm`](https://sqlite.org/wasm) is a good
   default because it ships FTS5 (so full-text search works) and has a synchronous API.

libzaungast itself has **no browser dependency** — the wasm SQLite build is the caller's to choose and
bundle.

## Example

```ts
import { openStoreFromSource, MemorySource } from 'libzaungast/web';
import { createSqliteWasmDriver } from './sqlite-wasm-driver.js'; // your SqlDriver (see below)

// 1. Get the leveldb directory's files into a Map<filename, bytes>. A folder <input> works in every
//    major browser (Chrome, Edge, Firefox, Safari); the File System Access API (showDirectoryPicker)
//    is a nicer UX but Chromium-only — see "Browser support" below.
async function readPickedFolder(fileList: FileList): Promise<MemorySource> {
  const files = new Map<string, Uint8Array>();
  for (const f of fileList) {
    files.set(f.name, new Uint8Array(await f.arrayBuffer()));
  }
  return new MemorySource(files);
}

// 2. Initialise the wasm SQLite once (async), then build + query the store (sync).
const driver = await createSqliteWasmDriver();
const source = await readPickedFolder(input.files!); // <input type="file" webkitdirectory>
using store = openStoreFromSource(source, { driver });

console.log(store.meta); // fingerprint, schemaMatched, counts, ftsEnabled, …
const hits = store.messages.search({ query: 'release plan', limit: 10 });
if (hits.ok) for (const h of hits.rows) console.log(h.senderName, h.snippet);
```

The store handle is the same `TeamsStore` shape `openStore(dir)` returns (minus live-refresh), so
every namespace — `conversations`, `messages`, `people`, `events`, `calls`, `topics` — works
identically. `store.meta.schemaMatched` tells you whether the Teams schema was recognised;
`openStoreFromSource` never throws for an unknown schema or a lossy load.

## The SqlDriver

`openStoreFromSource` takes a `SqlDriver` — the small interface (`open()` → a `SqlDatabase` with
`exec` / `prepare` → `{ run, get, all }` / `close`) that libzaungast's store runs on. It mirrors the
`node:sqlite` subset the reader uses. A reference adapter over `@sqlite.org/sqlite-wasm` lives in the
repo at `packages/libzaungast/examples/sqlite-wasm-driver.ts` — copy it into your app. In a bundled
build, pass the wasm locator so the glue can find `sqlite3.wasm` next to your bundle:

```ts
const driver = await createSqliteWasmDriver({
  locateFile: (path: string) => new URL(path, import.meta.url).href,
});
```

Swapping to a different SQLite build (e.g. sql.js, wa-sqlite) is just another `SqlDriver`
implementation — libzaungast is agnostic. (Note: FTS5 must be present for `messages.search` to use the
index; without it the reader degrades gracefully to a scan.)

## Browser support

The engine is universal — WebAssembly SQLite and libzaungast's decode/query code run in every modern
browser. **Only the "get the folder's bytes" step has a browser-support gradient**, and either option
below works:

- **`<input type="file" webkitdirectory>`** or **drag-and-drop a folder** — works in Chrome, Edge,
  **Firefox, and Safari**. Use this for the widest reach.
- **`showDirectoryPicker()`** (File System Access API) — nicer UX and supports re-reading the same
  directory, but **Chromium-only** (Chrome/Edge/Brave/Opera) today.

## Bundling and hosting

- Bundle with any browser bundler (esbuild `--platform=browser`, Vite, etc.). The `libzaungast/web`
  graph contains no `node:` builtins — a `--platform=browser` build that pulls one is a bug (the
  library's own CI enforces this with a bundle-smoke gate).
- Serve `sqlite3.wasm` alongside your bundle with the `application/wasm` MIME type (needed for
  streaming instantiation; most static hosts, including **GitHub Pages**, do this automatically).
- A plain **static site works** — everything is client-side, no server code. The default `:memory:`,
  synchronous, main-thread usage needs **no special headers**. (Cross-origin isolation — `COOP`/`COEP`
  — is only required if you later adopt OPFS persistence or multi-threaded SQLite, which some static
  hosts like GitHub Pages cannot set directly.)
