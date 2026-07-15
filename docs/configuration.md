# Configuration

zaungast needs no configuration in the common case — the local Teams database is
auto-discovered and there are no credentials. All variables below are optional.

| Variable | Purpose | Default |
|----------|---------|---------|
| `TEAMS_LEVELDB_DIR` | Absolute path to the Teams `…\IndexedDB\https_teams.microsoft.com_0.indexeddb.leveldb` directory. Set only if auto-discovery fails, or to pin a specific profile when you have several. | auto-discovered |
| `ZAUNGAST_INCREMENTAL` | Refresh mode: `copy-reuse` (faster — reuses immutable `.ldb` parses, re-reads only the write-ahead log) or `reparse` (simpler — re-reads everything each refresh). Both produce identical results. | `copy-reuse` |
| `ZAUNGAST_DB_DIR` | Read a static *copy* of the leveldb directory directly instead of discovering/snapshotting the live one. Useful for offline analysis or tests; disables live refresh. | unset |

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
