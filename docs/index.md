# zaungast

**zaungast** *(German: someone who watches over the fence without joining in)* is an
[MCP](https://modelcontextprotocol.io/) server that gives your coding agent read access to
your **Teams** chats by reading the app's **local, on-disk cache** — not the cloud.

The new Teams client stores chats in a Chromium **IndexedDB / LevelDB** database on disk.
zaungast reads a copy of it, decodes it, and serves it over MCP so your agent can pull in
Teams context without copy-pasting and without any cloud API.

## Why

- **Local & offline** — no MS Graph API, no network calls, nothing to authorize.
- **No credentials** — it reads data already on your machine.
- **Read-only & safe** — the Teams files are only read/copied, never written or locked; it
  cannot corrupt your Teams data.
- **Token-economical** — compact, shaped tool output; never bulk dumps.

## At a glance

```sh
claude mcp add zaungast -s user -- npx -y zaungast
```

Then ask your agent things like:

- *"Catch me up on the muted channel since yesterday."*
- *"What did Grace say about release topics?"*
- *"What's my team on about this week?"*

## Next steps

- [Installation](installation.md)
- [Tools reference](tools.md)
- [How it works](how-it-works.md)
- [Privacy & safety](privacy.md)

!!! note "Platform & affiliation"
    Currently **Windows only** (new Teams / WebView2); see [Installation](installation.md).
    Not affiliated with or endorsed by Microsoft — it reads your own local data.
