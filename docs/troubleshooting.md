# Troubleshooting

## "No Teams IndexedDB found"

Auto-discovery couldn't locate the database. Check that the **new** Teams desktop app is
installed and has been signed in at least once, then set `TEAMS_LEVELDB_DIR` explicitly to
the `…\IndexedDB\https_teams.microsoft.com_0.indexeddb.leveldb` directory (see
[Configuration](configuration.md)).

## "requires Node.js >= 22.5"

The server uses the built-in `node:sqlite`, added in Node 22.5. Upgrade Node.js. (On Node 22
the `--experimental-sqlite` flag is enabled for you automatically; you don't need to pass it.)

## Results seem stale / a channel looks empty but isn't

The local cache is a **synced slice** and syncs lazily per conversation — a channel you
haven't opened recently may have older cached content than the server has. zaungast discloses
this: `read_messages` shows the local cache span, and `search` appends a
`newest cached in this scope: …` note on empty/edge results. If you need the latest, open the
conversation in Teams once so the client syncs it, then query again.

## "schema is not recognized" after a Teams update

A Teams update can change the on-disk field layout so the built-in mapping no longer matches.
The tools will say the schema is unrecognized. Run **`describe_schema`** — it samples the raw
stores and prints a *proposed* field mapping (it applies nothing). Verify the proposed field
paths against the printed record/entry fields, save the JSON as
`src/schema/versions/teams-<version>.json`, rebuild, and restart. Please also open an issue
so the mapping can ship for everyone.

## Duplicate conversation titles

Two channels can share a title (e.g. two "General"s). `search in:"General"` searches both and
notes it (`matched N conversations — pass a c:handle to narrow`). Use the `c:` handle to
target one exactly.

## Verifying the install

`claude mcp list` should show `zaungast … ✓ Connected`. If not, run the server directly to
see stderr:

```sh
npx -y zaungast
```

It should print `zaungast MCP server ready (stdio)` and then wait for input (Ctrl-C to exit).
