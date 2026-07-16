# Installation

## Requirements

- **Windows or macOS** with the new Teams desktop app (`MSTeams` / WebView2), signed in at
  least once so a local cache exists. Both platforms store chats in the same Chromium/WebView2
  IndexedDB, so the decode is identical — only the on-disk location differs, and it's
  auto-discovered on each (or set `TEAMS_LEVELDB_DIR` manually).
- **Node.js ≥ 22.5** — zaungast uses the built-in `node:sqlite`. On Node 22 the required
  `--experimental-sqlite` flag is enabled automatically (the CLI re-execs itself with it);
  on Node ≥ 24 `node:sqlite` is stable and no flag is involved.

## Claude Code

```sh
claude mcp add zaungast -s user -- npx -y zaungast
```

- `-s user` registers it for every project (drop it for this-project-only).
- No environment variables are needed — the local Teams database is auto-discovered.
- Verify: `claude mcp list` should show `zaungast … ✓ Connected`. Open a new session to use
  the tools.

## Codex

Add to `~/.codex/config.toml` (or run `codex mcp add zaungast -- npx -y zaungast`):

```toml
[mcp_servers.zaungast]
command = "npx"
args = ["-y", "zaungast"]
# The Teams database is auto-discovered, so no path is needed. To set or override it,
# delete the "#" below and point it at your …indexeddb.leveldb folder:
# env = { TEAMS_LEVELDB_DIR = "/full/path/to/https_teams.microsoft.com_0.indexeddb.leveldb" }
```

## Claude Desktop / generic MCP config

```json
{
  "mcpServers": {
    "zaungast": { "command": "npx", "args": ["-y", "zaungast"] }
  }
}
```

If you want to set or override a variable, use this form instead:

```json
{
  "mcpServers": {
    "zaungast": {
      "command": "npx",
      "args": ["-y", "zaungast"],
      "env": {
        "TEAMS_LEVELDB_DIR": "/full/path/to/https_teams.microsoft.com_0.indexeddb.leveldb"
      }
    }
  }
}
```

`TEAMS_LEVELDB_DIR` is optional — the database is auto-discovered. Set it only if discovery
fails or to pin a specific profile (see [Configuration](configuration.md) for all variables).

## From source

```sh
git clone https://github.com/mbe24/zaungast && cd zaungast
npm install
npm run build
```

Then register the built entry point:

```sh
claude mcp add zaungast -s user -- node "C:\\path\\to\\zaungast\\dist\\index.js"
```

(The entry point auto-enables `--experimental-sqlite` on Node 22, so you don't need to pass
it.) After any code change, re-run `npm run build` and restart the server (a fresh session
re-spawns it).

## Finding the Teams database folder

zaungast auto-discovers this, so you normally don't need it — but if discovery fails or you
have multiple profiles, set `TEAMS_LEVELDB_DIR` to the folder described here.

The new Teams client stores its data under:

```
%LOCALAPPDATA%\Packages\MSTeams_8wekyb3d8bbwe\LocalCache\Microsoft\MSTeams\EBWebView\<profile>\IndexedDB\
```

Inside that `IndexedDB\` folder you'll see **two** entries for the Teams origin:

```
IndexedDB\
├── https_teams.microsoft.com_0.indexeddb.leveldb   ← this one (set TEAMS_LEVELDB_DIR to it)
└── https_teams.microsoft.com_0.indexeddb.blob      ← sibling blob store (not used)
```

The folder you want is the one ending **`.leveldb`** — it contains `CURRENT`, `MANIFEST-*`,
and the `*.ldb` / `*.log` files. Set `TEAMS_LEVELDB_DIR` to _that_ folder, **not** its parent
`IndexedDB\` directory (which holds both). The `.blob` sibling (images and large binaries) is
a handy landmark that you're in the right place — zaungast doesn't read it.

Find the exact path with PowerShell:

```powershell
Get-ChildItem "$env:LOCALAPPDATA\Packages\MSTeams_*\LocalCache\Microsoft\MSTeams\EBWebView\*\IndexedDB\https_teams.microsoft.com_0.indexeddb.leveldb" -Directory | Select-Object -ExpandProperty FullName
```

### macOS

New Teams is a sandboxed app, so the same store lives under its container:

```
~/Library/Containers/com.microsoft.teams2/Data/Library/Application Support/Microsoft/MSTeams/EBWebView/<profile>/IndexedDB/https_teams.microsoft.com_0.indexeddb.leveldb
```

Find it with:

```sh
find ~/Library -type d -name "https_teams.microsoft.com_0.indexeddb.leveldb" 2>/dev/null
```

This is auto-discovered too; you only need `TEAMS_LEVELDB_DIR` if you have multiple profiles or a
non-standard install.

## Multiple Teams profiles / accounts

zaungast picks the most-recently-active `https_teams.microsoft.com` database it finds. If you
have several profiles (multiple `<profile>` or `WV2Profile_*` directories) and it picks the
wrong one, pin the right one explicitly with `TEAMS_LEVELDB_DIR` using the path above.
