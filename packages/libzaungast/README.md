# libzaungast

Read-only, offline reader for the local Microsoft Teams cache. It decodes the new Teams client's
on-disk store, a Chromium IndexedDB database layered on LevelDB, into clean structured data you can
query directly: conversations, messages, people, calendar events, and calls. It needs no Graph API,
no cloud, and no credentials, and it has zero runtime dependencies.

libzaungast is the data layer behind the [zaungast](https://github.com/mbe24/zaungast) MCP server,
and it is equally usable on its own as a library.

> Not affiliated with or endorsed by Microsoft.

## Install

```sh
npm install libzaungast
```

Requires Node.js 22.5 or newer, since it uses the built-in `node:sqlite`.

## Quick start

```ts
import { openStore } from 'libzaungast';

using store = openStore('/path/to/https_teams.microsoft.com_0.indexeddb.leveldb');

// Full-text search across every message in the cache.
const found = store.messages.search({ query: 'release plan', limit: 10 });
if (found.ok) {
  for (const hit of found.rows) {
    console.log(new Date(hit.ts).toISOString(), hit.senderName, hit.snippet);
  }
}

// Read the most recent messages in a chosen conversation.
const chat = store.conversations.list({ n: 1 })[0];
if (chat) {
  const recent = store.messages.inConversation(chat.id, { limit: 20 });
  if (recent.ok) {
    for (const m of recent.rows) console.log(m.senderName, m.content);
  }
}
```

For a long-running process, `openLiveStore` returns a handle that refreshes as the cache changes on
disk. Its `incrementalMode` chooses how each refresh re-reads the store. The default `copy-reuse`
reuses the immutable table parses and re-reads only the write-ahead log, while `reparse` re-reads
everything each time. Both produce identical results.

```ts
import { openLiveStore } from 'libzaungast';

using live = openLiveStore({
  dir: '/path/to/https_teams.microsoft.com_0.indexeddb.leveldb',
  incrementalMode: 'reparse', // default is 'copy-reuse'
});

// current() returns the latest reading; the handle refreshes in the background.
console.log(live.current().meta.counts);
```

## Public surface

libzaungast has three entry points, one for each audience. Everything else is internal and cannot be
reached through the package's `exports`.

| Import                   | Audience                       | Description                                                                                                                                                                                                                                                                                             |
| ------------------------ | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `libzaungast`            | Application and script authors | The high-level data API and the primary path for reading a Teams cache. You open a store from a leveldb directory and query six orthogonal namespaces that return clean typed rows, so you can read conversations and messages or run full-text search without ever handling the underlying byte format. |
| `libzaungast/format`     | Power users and tooling        | The decode and schema layer that sits beneath the data API. It exposes the Chromium byte readers, the structured-clone value decoder, the content fingerprinting, and the schema description utilities, for callers who need to inspect or reinterpret the raw store rather than the resolved rows.       |
| `libzaungast/engine-spi` | Engine authors                 | The service provider interface for implementing an ingest engine. It hands an implementer the contract types, the schema inputs, and a factory for wrapping a finished store, so an alternative engine such as a native accelerator can be built in a separate package and injected without libzaungast ever depending on it. |

### The data API: `libzaungast`

This is the default import and the primary way to read a cache. `openStore(dir)` performs a one-shot
read and returns a handle, while `openLiveStore()` returns an auto-refreshing handle for a
long-running process. Either handle exposes the same six query namespaces. The conversations
namespace lists and resolves chats, channels, and meetings together with their participants and
activity. The messages namespace reads the messages inside a conversation, walks threads, runs
full-text search, and does point lookups. The people namespace is the directory of senders and
participants resolved from the cache. The events namespace surfaces calendar events and meetings, the
calls namespace surfaces call history with its direction, duration, and recordings, and the topics
namespace computes the distinctive trending phrases over a time window. Namespaces return plain typed
rows such as `Conversation`, `Message`, `Person`, `CalendarEvent`, `Call`, and `Topic`, and fallible
lookups return an explicit result object carrying an `ok` flag rather than failing silently. The
companions `tryOpen` and `inspect` let you check a directory before committing to a full open, and
`htmlToText` renders Teams rich-text bodies to plain text.

### The format layer: `libzaungast/format`

This is the decode and schema layer beneath the data API, intended for power users and tooling. It
exposes the raw building blocks that turn bytes into rows: the Chromium IndexedDB and LevelDB
readers, the Blink structured-clone value decoder, the content fingerprinting, and the schema
description utilities. Its `libzaungast/format/engine` sub-path adds the storage engine seam types
for callers who add or reinterpret a storage format. Most consumers never touch this layer, because
the data API is built on top of it and hands back finished rows.

### The engine SPI: `libzaungast/engine-spi`

This is the service provider interface for engine authors. An ingest engine reads a leveldb directory
and produces the queryable store, and the built-in TypeScript engine is the default. This subpath
provides the contract types, the schema inputs such as the DDL and the bundled schema mappings, a
conformance version to verify against, and a factory for wrapping a finished store file, so an
alternative engine such as a native Rust accelerator can be implemented in a separate package and
injected through the `engine` option on `openStore` or `openLiveStore`. libzaungast never depends on
any such engine; the consumer chooses one and passes it in.

## Guarantees

The reader only ever reads or copies the Teams directory. It never writes to it, never locks it, and
never memory maps it, so it cannot corrupt the store. It is fully offline with no network, no Graph
API, and no credentials, and it carries zero runtime dependencies. Media surfaces as metadata markers
and never as bytes.

Before version 1.0 the entry-point split and the error contract are stable, while row and query
details may still change.

## License

Apache-2.0. Part of the [zaungast](https://github.com/mbe24/zaungast) monorepo.
