# How it works

## The data

The new Teams client is a WebView2 (Chromium) app. It stores your chats in a
Chromium **IndexedDB** database, which is itself backed by **LevelDB** on disk at:

```
%LOCALAPPDATA%\Packages\MSTeams_*\LocalCache\Microsoft\MSTeams\EBWebView\
    <profile>\IndexedDB\https_teams.microsoft.com_0.indexeddb.leveldb
```

The relevant object stores are the reply-chain messages, the conversation list, and profiles.

## The read path (dependency-free)

Chromium's IndexedDB LevelDB uses a custom comparator (`idb_cmp1`) that off-the-shelf
LevelDB libraries refuse to open. zaungast sidesteps this entirely: for a read-only reader,
a **full scan + dedup by LevelDB sequence number** is exactly LevelDB's own precedence rule,
so the comparator is never needed. The pure-JS pipeline:

1. Parse the **SSTable** (`.ldb`) files and the **write-ahead log** (`.log`), verifying CRCs.
2. Decompress **Snappy** blocks.
3. Decode Chromium's **IndexedDB key coding** (database/object-store/index ids + UTF-16 keys).
4. Deserialize the **Blink/V8 structured-clone** values (the actual message objects), including
   Chromium's IndexedDB value compression wrapper.

A version **fingerprint** (normalized store names + field-key sets) selects a checked-in
field **mapping**, so the volatile Teams schema is separated from the stable Chromium format.

The exact byte layouts of each of these layers are documented in the
[Chromium IndexedDB format reference](reference/chromium-indexeddb-format.md).

## Indexing & serving

Decoded records are loaded into an in-memory **SQLite** database (`node:sqlite`) with an
**FTS5** full-text index. Tools answer from this index — fast, and shaped for token economy.

## Refresh lifecycle

1. **Snapshot** — the live Teams files are *copied* to a temp dir (read-only) before parsing,
   so a running Teams client is never disrupted and half-written state is never read in place.
2. **Ingest** — decode + load into SQLite. The first build happens right after the MCP
   handshake so the first tool call is fast.
3. **Staleness probe** — on each tool call a ~1 ms check compares the live write-ahead log to
   the last-seen state.
4. **Incremental refresh** — when the cache changed, only new records (by sequence number) are
   applied; deletions are reconciled. Two modes exist:
   - **`copy-reuse`** (default) reuses immutable `.ldb` parses and re-reads only the small
     `.log` — ~3× faster.
   - **`reparse`** re-reads everything each time (simpler; identical results).
   A periodic full rebuild backstops any drift. Both modes are proven to produce identical
   stores.

## Freshness disclosure

Because the local cache is a *synced slice* — and syncs lazily, per-conversation — a scope's
newest cached message can lag the server. Tools disclose this: `read_messages` shows the
local cache span, and `search` appends a coverage note on empty/edge results, so a quiet
result is never silently mistaken for "the cache doesn't reach that far".
