# zaungast

<img src="https://raw.githubusercontent.com/mbe24/zaungast/main/assets/logo.png" alt="zaungast logo: a hatted figure peeking over a fence with binoculars" width="150" align="right">

[![CI](https://github.com/mbe24/zaungast/actions/workflows/ci.yml/badge.svg)](https://github.com/mbe24/zaungast/actions/workflows/ci.yml)
[![Docs](https://readthedocs.org/projects/zaungast/badge/?version=latest)](https://zaungast.readthedocs.io/en/latest/)
[![npm](https://img.shields.io/npm/v/zaungast?color=2C9EC2&label=npm)](https://www.npmjs.com/package/zaungast)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-orange.svg)](https://raw.githubusercontent.com/mbe24/zaungast/main/LICENSE)

**zaungast** *(German: someone who watches over the fence without joining in)* is a
**read-only, offline** [MCP](https://modelcontextprotocol.io/) server for **Teams** — search
chats, read conversations, surface trending topics, and find people straight from the **local
on-disk cache**, with no Graph API, no cloud, and no credentials, and token-economical output
for coding agents (Claude Code, Claude Desktop, …).

The new Teams client stores your chats in a local on-disk database; zaungast reads a copy of
it directly and serves it over MCP, so your agent can pull in Teams context — *"what did Grace
say about the deploy", "catch me up on the muted channel", "what's my team on about this
week"* — without you copy-pasting, and without any cloud API.

- **Local & offline** — reads the on-disk Teams cache. No MS Graph API, no network calls.
- **No credentials** — nothing to log in to, no tokens, no permissions to grant.
- **Read-only & safe** — the Teams files are only ever *read/copied*, never written, locked,
  or modified. It cannot corrupt your Teams data.
- **Token-economical** — every tool returns compact, shaped output (dense lines, snippets,
  aggregates), never bulk dumps.
- **Zero-config** — auto-discovers the local Teams database; just register and go.

> ⚠️ **Platform:** currently **Windows only** (new Teams / WebView2). Teams on macOS uses a
> different storage engine — see [Requirements](#requirements).
> **Not affiliated with or endorsed by Microsoft.** It reads your own local data on your own
> machine.

## Installation

Requires **Node.js ≥ 22.5** (for the built-in `node:sqlite`). The package is on npm, and
`npx -y zaungast` fetches and runs it — so registering it in your MCP client is the whole
install. No environment variables are needed in the common case; the local Teams database is
auto-discovered.

### Claude Code

```sh
claude mcp add zaungast -s user -- npx -y zaungast
```

`-s user` makes it available in every project. Verify with `claude mcp list` (expect
`zaungast … ✓ Connected`), then open a new session — the six tools are available.

### Claude Desktop / other clients

Add to your client's MCP config (e.g. `claude_desktop_config.json` or `.mcp.json`):

```json
{
  "mcpServers": {
    "zaungast": { "command": "npx", "args": ["-y", "zaungast"] }
  }
}
```

If auto-discovery can't find your Teams database, set `TEAMS_LEVELDB_DIR` (see
[Configuration](#configuration)). From-source and troubleshooting steps are in the
[docs](https://zaungast.readthedocs.io/en/latest/installation/).

## Tools

| Tool | What it does |
|------|--------------|
| `list_conversations` | Your Teams sidebar — newest conversations, or filter by kind/participant/title/time. |
| `read_messages` | One conversation's messages in story order (window / cursor / around a hit). |
| `search` | Full-text search + filters (from, in, kind, `mentions_me`, has-attachment, date). |
| `top_topics` | Distinctive/trending topics over a window, vs your baseline, with an example each. |
| `find_person` | Resolve a name/nickname to a canonical person + handle, with contact stats. |
| `describe_schema` | Recovery tool: propose a field mapping when a Teams update changes the DB layout. |

Full reference: [Tools documentation](https://zaungast.readthedocs.io/en/latest/tools/).

## Requirements

- **OS:** Windows (new Teams, `MSTeams` / WebView2). The reader targets Chromium's IndexedDB
  LevelDB + Blink/V8 value format. Teams on **macOS** uses WebKit (a SQLite-backed IndexedDB
  with a different serialization) and is not supported yet.
- **Node.js ≥ 22.5** — uses the built-in `node:sqlite` for the in-memory index. (On Node 22
  the server auto-enables the required `--experimental-sqlite` flag for you.)
- The new Teams desktop app, signed in at least once (so there's a local cache to read).

## Configuration

All optional — zaungast works with no configuration.

| Variable | Purpose |
|----------|---------|
| `TEAMS_LEVELDB_DIR` | Path to the Teams `…\IndexedDB\https_teams.microsoft.com_0.indexeddb.leveldb` directory. Set only if auto-discovery fails or you have multiple profiles. |
| `ZAUNGAST_INCREMENTAL` | Refresh mode: `copy-reuse` (default, faster) or `reparse` (simpler). |
| `ZAUNGAST_DB_DIR` | Read a static copy of the database directly (testing / offline analysis); skips discovery and live-refresh. |

## How it works

1. **Snapshot** — copies the Teams LevelDB files to a temp dir (read-only; the live files are
   never touched), so a running Teams client can't be disrupted.
2. **Decode** — a dependency-free reader parses the SSTables + write-ahead log, decompresses
   Snappy blocks, decodes Chromium's IndexedDB key coding, and deserializes the Blink/V8
   structured-clone values into chat records.
3. **Index** — loads messages/conversations/people into an in-memory SQLite database with
   FTS5 full-text search.
4. **Serve & refresh** — answers tool calls from the index; on each call a ~1 ms probe checks
   whether the cache changed and refreshes incrementally when it has.

More detail: [How it works](https://zaungast.readthedocs.io/en/latest/how-it-works/).

## Privacy & safety

- **Everything stays local.** zaungast makes no network calls; it reads data already on your
  machine and serves it to your local agent over stdio.
- **It cannot harm Teams.** There is no code path that writes to, locks, or memory-maps the
  Teams directory — only read-and-copy. Verified by design review and tests.
- **Images/files are URL-only.** Chat images live in Teams' cloud behind auth; zaungast
  surfaces that an attachment exists but never fetches it and never handles credentials.

## Development

```sh
git clone https://github.com/mbe24/zaungast && cd zaungast
npm install
npm run build            # compile to dist/
npm run typecheck        # tsc --noEmit
npm test                 # data-free unit tests
npm run test:integration # full suite — needs a local Teams cache
npm run assets           # re-render the SVG brand assets to PNG
```

See the [development docs](https://zaungast.readthedocs.io/en/latest/development/).

## License

[Apache 2.0](LICENSE) © Mikael Beyene. Not affiliated with or endorsed by Microsoft.
"Microsoft Teams" is a trademark of Microsoft Corporation; this project only reads your own
local data.
