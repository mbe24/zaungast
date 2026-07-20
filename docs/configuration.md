# Configuration

zaungast needs no configuration in the common case — the local Teams database is
auto-discovered and there are no credentials. All variables below are optional.

| Variable | Purpose | Default |
|----------|---------|---------|
| `TEAMS_LEVELDB_DIR` | Absolute path to the Teams `…\IndexedDB\https_teams.microsoft.com_0.indexeddb.leveldb` directory. Set only if auto-discovery fails, or to pin a specific profile when you have several. | auto-discovered |
| `ZAUNGAST_INCREMENTAL` | Refresh mode: `copy-reuse` (faster — reuses immutable `.ldb` parses, re-reads only the write-ahead log) or `reparse` (simpler — re-reads everything each refresh). Both produce identical results. | `copy-reuse` |
| `ZAUNGAST_DB_DIR` | Read a static *copy* of the leveldb directory directly instead of discovering/snapshotting the live one. Useful for offline analysis or tests; disables live refresh. | unset |
| `ZAUNGAST_ENGINE` | Ingest engine. `js` (default): the built-in pure-TypeScript engine — no extra dependencies. `native`: require the optional `libzaungast-native` Rust accelerator, and error loudly if it is not installed or fails the conformance handshake. `auto`: use native when it is present and conformant, otherwise fall back to JS. See [Native engine](#native-engine-optional). | `js` |

## Native engine (optional)

By default zaungast uses its built-in pure-TypeScript ingest engine, which needs no extra
dependencies. An optional Rust accelerator, `libzaungast-native`, performs the same ingest faster and
is byte-for-byte equivalent to the TypeScript reference (enforced in CI). To enable it:

1. **Build the accelerator.** It is not yet published to npm, so it is currently built from source in
   the monorepo: with a Rust toolchain installed, run `npm run build` in `packages/libzaungast-native`.
   This produces the platform-specific `.node` binary the engine loads.
2. **Select it.** Set `ZAUNGAST_ENGINE=native` to require it (zaungast errors loudly if the accelerator
   is missing or its conformance version does not match), or `ZAUNGAST_ENGINE=auto` to use it when
   available and otherwise fall back to the JS engine.

The startup banner reports the resolved engine — e.g. `zaungast v0.3.0 — offline Teams reader —
engine:native — ready (stdio)`. Under `auto`, an unavailable accelerator degrades gracefully to
`engine:js (native unavailable: …)` instead of failing. libzaungast itself never depends on the
accelerator; zaungast chooses and injects it.

## Setting variables in an MCP client

Claude Code:

```sh
claude mcp add zaungast -s user \
  -e TEAMS_LEVELDB_DIR="C:\\Users\\me\\AppData\\Local\\Packages\\MSTeams_8wekyb3d8bbwe\\LocalCache\\Microsoft\\MSTeams\\EBWebView\\WV2Profile_tfw\\IndexedDB\\https_teams.microsoft.com_0.indexeddb.leveldb" \
  -- npx -y zaungast
```

Codex (`~/.codex/config.toml`) — `env` is a TOML inline table:

```toml
[mcp_servers.zaungast]
command = "npx"
args = ["-y", "zaungast"]
env = { TEAMS_LEVELDB_DIR = "/full/path/to/https_teams.microsoft.com_0.indexeddb.leveldb" }
```

Generic MCP JSON config:

```json
{
  "mcpServers": {
    "zaungast": {
      "command": "npx",
      "args": ["-y", "zaungast"],
      "env": { "ZAUNGAST_INCREMENTAL": "reparse" }
    }
  }
}
```
