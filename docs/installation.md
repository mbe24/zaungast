# Installation

## Requirements

- **Windows** with the new Teams desktop app (`MSTeams` / WebView2), signed in at
  least once so a local cache exists. Teams on **macOS** uses a different storage engine
  (WebKit, SQLite-backed IndexedDB) and is not supported yet.
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

## Claude Desktop / generic MCP config

```json
{
  "mcpServers": {
    "zaungast": { "command": "npx", "args": ["-y", "zaungast"] }
  }
}
```

Add environment variables under an `"env"` key if needed (see [Configuration](configuration.md)).

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

## Multiple Teams profiles / accounts

zaungast picks the most-recently-active `https_teams.microsoft.com` database it finds. If you
have several profiles and it picks the wrong one, pin it explicitly with `TEAMS_LEVELDB_DIR`
(see [Configuration](configuration.md)).
