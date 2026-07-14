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

- *"Catch me up on the channel I muted last week."*
- *"What was decided about the release date?"*
- *"What's my team been discussing this week?"*

## Example

Say a group chat looks like this (the project's demo fixture — entirely fictional):

```
[group] "study-group-cs101" · showing 5/5 · local cache 03-02 10:20–10:40
10:20 Barbara Liskov> Welcome to the CS101 study group! [attachment]
10:25 Edsger Dijkstra> Can someone explain memoization vs dynamic programming?
10:30 CS101 Course Bot> Reminder: Assignment 4 is due Friday at 11:59pm.
10:35 Radia Perlman> Thanks bot! @Ada Lovelace can you share your notes? [@me]
10:40 ME> Sure, sharing now.
```

You ask your agent:

> *"Catch me up on the study group."*

zaungast hands it that thread — already compact and shaped — and the agent answers in its
own words:

> Barbara started the CS101 study group and shared a file. Edsger asked how memoization
> differs from dynamic programming, the course bot reminded everyone Assignment 4 is due
> Friday, and Radia asked you to share your notes — you said you're sending them.

## Next steps

- [Installation](installation.md)
- [Tools reference](tools.md)
- [How it works](how-it-works.md)
- [Privacy & safety](privacy.md)

!!! note "Platform & affiliation"
    Currently **Windows only** (new Teams / WebView2); see [Installation](installation.md).
    Not affiliated with or endorsed by Microsoft — it reads your own local data.
