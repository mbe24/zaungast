# Tools reference

All tools are read-only and return compact, shaped text. Every response starts with an
envelope line: `as_of MM-DD HH:mm (tz±N) · …`, giving the data freshness and timezone.

**Handles.** Conversations and people are referenced by short, stable handles — `c:xxxxxx`
and `p:xxxxxx` — derived from their full IDs. Messages carry `m:<id>`. Handles are stable
across refreshes, so you can pivot from a search hit to `read_messages(around: m:…)`.

---

## `list_conversations`

Your Teams sidebar. With no arguments, returns the most-recently-active conversations.

| Arg             | Description                                                   |
| --------------- | ------------------------------------------------------------- |
| `n`             | How many (default 12, max 30).                                |
| `kind`          | `1:1` \| `group` \| `channel` \| `meeting` \| `other`.        |
| `query`         | Match conversation title or participant.                      |
| `participant`   | Display-name substring of a participant.                      |
| `since`         | ISO date or relative (`-7d`, `-24h`).                         |
| `include_empty` | Include 0-message conversations (team roots); off by default. |

## `read_messages`

One conversation's messages in **story order** (oldest→newest). The header shows the local
cache span and an `older:` cursor for paging.

| Arg               | Description                                                                          |
| ----------------- | ------------------------------------------------------------------------------------ |
| `conversation`    | `c:` handle or title/participant substring (**required**).                           |
| `limit`           | Default 40, max 200.                                                                 |
| `since` / `until` | Time window (ISO or relative).                                                       |
| `cursor`          | The `older:…` (or in-thread `more:…`) value from a previous result, to page.         |
| `around`          | A message id (`m:…` from a search hit) to center on (its thread, in channels).       |
| `thread`          | In a channel, a thread id (`m:…` of a reply-chain root) to read that thread in full. |
| `reactions`       | `full` to list every reactor by name (default shows a capped summary).               |

Consecutive messages from the same sender are collapsed with `↳`. Markers: `[@me]`,
`[attachment]`.

### Channels are threaded

In **channels**, output is grouped by reply-chain instead of interleaved by time: each thread
shows its **root** in full, then replies indented beneath it, and threads are ordered by **last
activity** (most-recently-active at the bottom). Small threads (≤5 messages) show every reply;
larger ones show the root + last 3 replies and a drill-in marker naming the exact call:

```
09:14 Hana Björk> proposal: move CI to the new runners  [thread m:1747033 · 20 replies · last 10:41]
  +17 earlier · read_messages(thread: m:1747033)
  16:20 Bob Ito> staging is green on the new pool
  10:41 Hana Björk> 🎉
```

Pass `thread: m:<root>` to read one thread in full (it inlines up to ~40 messages, then pages
backward with a `more: before m:<id>` cursor and reports `complete` when done). `around: m:<id>`
in a channel resolves to that message's thread (marking the hit with `→`). 1:1, group, and
meeting conversations stay flat and chronological.

Your own messages are labelled **`<Your Name> (you)`** (not `ME`), and the result header carries a
`viewer:` line naming who `(you)` is. That speaker is the account owner — for an AI agent reading
the transcript, it's _the user_, not the assistant. (Same labelling in `search` results.)

### Reactions

Messages that were reacted to get a reaction line underneath, e.g.:

```
14:32 Ada> Ship it 🚀
      👍 4 · Grace, Bob, Carol +1   ❤️ 2 · Dave, Eve
```

How it's rendered (tuned against real data, where 16% of messages carry reactions):

- **Emoji, not shortcodes.** Teams stores reactions as internal keys (`like`, `1f389_partypopper`,
  `plusone;0-weu-…`). We render the actual glyph — a codepoint is read straight from the key when
  present, otherwise a shortcode table maps it (`fire`→🔥, `party`→🎉); an unmappable org-custom
  key falls back to a cleaned name.
- **Names come from your local cache only** (message authors + the local `profiles` store) — no
  lookups leave the machine. `(you)` is listed first when you reacted.
- **Capped for token economy, ordered by popularity.** Each emoji shows a count and up to 3
  names (you first, then most recent); extra reactors on that emoji show as `+K`. A message rarely
  has more than one emoji — but when it does, the emojis are sorted most-reacted first, the top 3
  are named, the next 2 show count-only, and any beyond that collapse into `+N more`. On real data
  this fully renders 99.9% of reacted messages without a `+N more`.
- `reactions: full` drops the caps and lists every reactor for every emoji — for when you need to
  know whether a _specific_ person reacted.

## `search`

Full-text search (FTS5) with filters. An empty `query` becomes a filtered browse.

| Arg               | Description                                    |
| ----------------- | ---------------------------------------------- |
| `query`           | FTS query; omit to browse by filters only.     |
| `from`            | Sender: display-name substring or `p:` handle. |
| `in`              | Conversation: title substring or `c:` handle.  |
| `kind`            | Conversation kind.                             |
| `mentions_me`     | Only messages that @mention you.               |
| `has_attachment`  | Only messages with an attachment.              |
| `since` / `until` | Time window.                                   |
| `exclude`         | `c:`/`p:` handles to exclude from results.     |
| `limit`           | Default 20, max 60.                            |

On empty results (or a `since` window newer than the cache holds), a coverage note reports
the newest/oldest cached message in scope — so a quiet result isn't mistaken for a sync gap.

## `list_events`

Your calendar — meetings and appointments from the local Teams calendar cache. Defaults to a
**forward** window (today → +7d); relative times accept future offsets too (e.g. `+30d`).

| Arg               | Description                                                           |
| ----------------- | --------------------------------------------------------------------- |
| `type`            | `meeting` \| `appointment` \| `all` (default `all`).                  |
| `query`           | Match the event subject.                                              |
| `attendee`        | Name/email substring of an attendee or the organizer.                 |
| `since` / `until` | Window (ISO or relative, e.g. `-7d`, `+30d`). Default `today .. +7d`. |
| `limit`           | Default 30, max 100.                                                  |
| `hide_cancelled`  | Drop cancelled events (shown by default, tagged `[cancelled]`).       |
| `include_body`    | Include the event body text on a single narrowed result (see below).  |

Each line gives the date/time, a `[meeting]`/`[appointment]` tag, subject, organizer, an
attendee summary (organizer + up to 3 names + `+K`, with an accepted tally), your response, and —
for online meetings — the chat handle (`chat c:…`, or `(no cached chat)` when the meeting's chat
isn't cached locally). Recurring series collapse: the first occurrence in the window renders
fully, the rest fold into `↻ <subject> ×N more (next …)`. Tags: `[cancelled]`, `[confidential]`,
`[attachment]`.

**Privacy.** Metadata only by default. Meeting **join URLs are never returned** (they can carry
tokens and an agent has no use for them). The event body is withheld unless you pass
`include_body` on a single-event result — and even then it's HTML-stripped with URLs reduced to
bare hostnames, and it is **never** returned for a `[confidential]` event. Only materialized
occurrences are cached, so a far-future window may under-report recurring events — the result
says so when the window runs past what's cached.

## `list_calls`

Your call history — 1:1 and group calls from the local call log.

| Arg               | Description                              |
| ----------------- | ---------------------------------------- |
| `direction`       | `Outgoing` \| `Incoming`.                |
| `missed`          | Only missed calls.                       |
| `participant`     | Name/email substring of the other party. |
| `since` / `until` | Window (ISO or relative).                |
| `limit`           | Default 30, max 100.                     |

Each line: date/time, a direction arrow (`←` incoming, `→` outgoing), the other party's name
(resolved from the local profiles cache), duration, and state (`accepted`/`missed`/`declined`).
Group calls link to their chat thread. A recorded call links to the message that announced it
(`recorded → c:… m:…`) so you can pivot with `read_messages(around:)`. Tags: `[recorded]`,
`[voicemail]`, `[spam?]`, `[not-you]`. Deleted entries are filtered out.

Recordings and transcripts themselves live in the cloud behind auth — zaungast surfaces only the
metadata (that a recording exists) and the pointer, never the media.

## `top_topics`

Distinctive/trending topics over a window, scored against your own baseline (not raw
frequency), each with an example message. Bot/app senders are excluded by default.

| Arg               | Description                                                             |
| ----------------- | ----------------------------------------------------------------------- |
| `window`          | `1d` \| `7d` \| `30d` (default `7d`). Ignored if `since`/`until` given. |
| `since` / `until` | Arbitrary window, overriding `window`.                                  |
| `scope`           | `conversation:<c: or title>` or `person:<name or p:>`.                  |
| `exclude`         | Words, or `c:`/`p:` handles, to exclude.                                |
| `include_bots`    | Include bot/app senders (excluded by default).                          |
| `n`               | Default 8, max 15.                                                      |

## `find_person`

Resolve a name/nickname to a canonical person + `p:` handle, with message count and last
contact. Omit `query` to scan the roster (most-talked-to first). Bots are tagged `[bot]`;
you are tagged `(you)`.

| Arg     | Description                                                          |
| ------- | -------------------------------------------------------------------- |
| `query` | Name substring, or a `p:` handle to expand; omit to scan the roster. |
| `n`     | Default 8, max 25.                                                   |

## `describe_schema`

A recovery tool. When a Teams update changes the on-disk layout so the store is no longer
recognized, this samples the raw stores and **proposes** a field mapping to save as a new
schema version. It proposes only — it never applies anything. See
[Troubleshooting](troubleshooting.md).

| Arg     | Description                      |
| ------- | -------------------------------- |
| `limit` | Max stores to list (default 20). |
