# zaungast

<img src="https://raw.githubusercontent.com/mbe24/zaungast/main/assets/logo.png" alt="zaungast logo: a hatted figure peeking over a fence with binoculars" width="150" align="right">

[![CI](https://github.com/mbe24/zaungast/actions/workflows/ci.yml/badge.svg)](https://github.com/mbe24/zaungast/actions/workflows/ci.yml)
[![Docs](https://readthedocs.org/projects/zaungast/badge/?version=latest)](https://zaungast.readthedocs.io/en/latest/)
[![npm](https://img.shields.io/npm/v/zaungast?color=2C9EC2&label=npm)](https://www.npmjs.com/package/zaungast)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-orange.svg)](https://raw.githubusercontent.com/mbe24/zaungast/main/LICENSE)

**zaungast** _(German: someone who watches over the fence without joining in)_ is a
**read-only, offline** [MCP](https://modelcontextprotocol.io/) server for **Teams** — search
chats, read conversations, surface trending topics, and find people straight from the **local
on-disk cache**, with no Graph API, no cloud, and no credentials, and token-economical output
for coding agents (Claude Code, Claude Desktop, …).

The new Teams client stores your chats in a local on-disk database; zaungast reads a copy of
it directly and serves it over MCP, so your agent can pull in Teams context — _"what was
decided about the release date", "catch me up on a channel I muted", "what's my team been
discussing this week"_ — without you copy-pasting, and without any cloud API.

- **Local & offline** — reads the on-disk Teams cache. No MS Graph API, no network calls.
- **No credentials** — nothing to log in to, no tokens, no permissions to grant.
- **Read-only & safe** — the Teams files are only ever _read/copied_, never written, locked,
  or modified. It cannot corrupt your Teams data.
- **Token-economical** — every tool returns compact, shaped output, never bulk dumps.
- **Zero-config** — auto-discovers the local Teams database; just register and go.

> ⚠️ **Windows & macOS** (new Teams / WebView2), Node.js ≥ 22.5. Both use the same
> Chromium/WebView2 store, so the reader is identical; the local database is auto-discovered on
> each, or point `TEAMS_LEVELDB_DIR` at it manually — see
> [requirements](https://zaungast.readthedocs.io/en/latest/installation/#requirements).
> **Not affiliated with or endorsed by Microsoft.** It reads your own local data on your own
> machine.

## Installation

`npx -y zaungast` fetches and runs the server, so registering it in your MCP client is the
whole install. No environment variables are needed in the common case — the local Teams
database is auto-discovered.

### Claude Code

Normal case — the Teams database is auto-discovered, so no variables are needed:

```sh
claude mcp add zaungast -- npx -y zaungast
```

Add `--scope user` to make it available in every project. Verify with `claude mcp list`
(expect `zaungast … ✓ Connected`), then open a new session.

Only if auto-discovery fails or you have multiple profiles, set `TEAMS_LEVELDB_DIR`
explicitly (the `-e` flag goes before the `--`) — see
[finding the Teams database folder](https://zaungast.readthedocs.io/en/latest/installation/#finding-the-teams-database-folder):

```sh
claude mcp add zaungast \
  -e TEAMS_LEVELDB_DIR="C:\Users\me\AppData\Local\Packages\MSTeams_8wekyb3d8bbwe\LocalCache\Microsoft\MSTeams\EBWebView\WV2Profile_tfw\IndexedDB\https_teams.microsoft.com_0.indexeddb.leveldb" \
  -- npx -y zaungast
```

### Codex

Add to `~/.codex/config.toml` (or run `codex mcp add zaungast -- npx -y zaungast`):

```toml
[mcp_servers.zaungast]
command = "npx"
args = ["-y", "zaungast"]
# The Teams database is auto-discovered, so no path is needed. To set or override it,
# delete the "#" below and point it at your …indexeddb.leveldb folder:
# env = { TEAMS_LEVELDB_DIR = "/full/path/to/https_teams.microsoft.com_0.indexeddb.leveldb" }
```

### Claude Desktop / other clients

Add to your client's MCP config (`claude_desktop_config.json`, `.mcp.json`, …):

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
fails or to pin a specific profile. From-source setup and other clients are covered in the
[installation docs](https://zaungast.readthedocs.io/en/latest/installation/).

## Tools

| Tool                 | What it does                                                                                          |
| -------------------- | ----------------------------------------------------------------------------------------------------- |
| `list_conversations` | Your Teams sidebar — newest conversations, or filter by kind/participant/title/time.                  |
| `read_messages`      | One conversation's messages in story order (window / cursor / around a hit).                          |
| `search`             | Full-text search + filters (from, in, kind, `mentions_me`, has-attachment, date).                     |
| `list_events`        | Calendar meetings & appointments (forward window by default); metadata-only, join-URLs never exposed. |
| `list_calls`         | Call history — 1:1/group calls with direction, duration, missed, and recording pointers.              |
| `top_topics`         | Distinctive/trending topics over a window, vs your baseline, with an example each.                    |
| `find_person`        | Resolve a name/nickname to a canonical person + handle, with contact stats.                           |
| `describe_schema`    | Recovery tool: propose a field mapping when a Teams update changes the DB layout.                     |

Full reference: [tools documentation](https://zaungast.readthedocs.io/en/latest/tools/).

## Environment variables

All optional — zaungast works with no configuration. Pass them via your MCP client's `env`
block (as above).

| Var                    | Default         | Notes                                                                                                                                             |
| ---------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TEAMS_LEVELDB_DIR`    | auto-discovered | Absolute path to the `…indexeddb.leveldb` folder (examples below). Set only if auto-discovery fails, or to pin one profile when you have several. |
| `ZAUNGAST_INCREMENTAL` | `copy-reuse`    | Refresh mode: `copy-reuse` (faster) or `reparse` (simpler).                                                                                       |
| `ZAUNGAST_DB_DIR`      | unset           | Read a static _copy_ of the database directly (offline analysis); skips discovery and live refresh.                                               |

`TEAMS_LEVELDB_DIR` points at the folder ending in **`.indexeddb.leveldb`** (the one holding
`CURRENT`, `MANIFEST-*`, `*.ldb`/`*.log`) — **not** its parent `IndexedDB` directory:

```
# Windows
C:\Users\<you>\AppData\Local\Packages\MSTeams_8wekyb3d8bbwe\LocalCache\Microsoft\MSTeams\EBWebView\<profile>\IndexedDB\https_teams.microsoft.com_0.indexeddb.leveldb

# macOS
/Users/<you>/Library/Containers/com.microsoft.teams2/Data/Library/Application Support/Microsoft/MSTeams/EBWebView/<profile>/IndexedDB/https_teams.microsoft.com_0.indexeddb.leveldb
```

`<profile>` is usually `WV2Profile_tfw`. Use the full absolute path in JSON configs (e.g. Claude
Desktop) — environment placeholders like `~` or `%LOCALAPPDATA%` aren't expanded there.

## Privacy & safety

- **Stays local** — no network calls; reads data already on your machine and serves it to your
  local agent over stdio.
- **Cannot harm Teams** — no code path writes to, locks, or memory-maps the Teams directory;
  only read-and-copy.
- **Images/files are URL-only** — chat images live in Teams' cloud behind auth; zaungast notes
  that an attachment exists but never fetches it and never handles credentials.

More in the [privacy & safety docs](https://zaungast.readthedocs.io/en/latest/privacy/).

## Documentation

Full documentation — tools reference, how it works, configuration, privacy, troubleshooting,
and development — lives at **<https://zaungast.readthedocs.io/>**.

## License

[Apache 2.0](LICENSE) © Mikael Beyene. Not affiliated with or endorsed by Microsoft.
"Microsoft Teams" is a trademark of Microsoft Corporation; this project only reads your own
local data.
