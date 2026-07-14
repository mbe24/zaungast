# Tools reference

All tools are read-only and return compact, shaped text. Every response starts with an
envelope line: `as_of MM-DD HH:mm (tz±N) · …`, giving the data freshness and timezone.

**Handles.** Conversations and people are referenced by short, stable handles — `c:xxxxxx`
and `p:xxxxxx` — derived from their full IDs. Messages carry `m:<id>`. Handles are stable
across refreshes, so you can pivot from a search hit to `read_messages(around: m:…)`.

---

## `list_conversations`

Your Teams sidebar. With no arguments, returns the most-recently-active conversations.

| Arg | Description |
|-----|-------------|
| `n` | How many (default 12, max 30). |
| `kind` | `1:1` \| `group` \| `channel` \| `meeting` \| `other`. |
| `query` | Match conversation title or participant. |
| `participant` | Display-name substring of a participant. |
| `since` | ISO date or relative (`-7d`, `-24h`). |
| `include_empty` | Include 0-message conversations (team roots); off by default. |

## `read_messages`

One conversation's messages in **story order** (oldest→newest). The header shows the local
cache span and an `older:` cursor for paging.

| Arg | Description |
|-----|-------------|
| `conversation` | `c:` handle or title/participant substring (**required**). |
| `limit` | Default 40, max 200. |
| `since` / `until` | Time window (ISO or relative). |
| `cursor` | The `older:…` value from a previous result, to page back. |
| `around` | A message id (`m:…` from a search hit) to center a window on. |
| `reactions` | `full` to list every reactor by name (default shows a capped summary). |

Consecutive messages from the same sender are collapsed with `↳`. Markers: `[@me]`,
`[attachment]`.

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
  know whether a *specific* person reacted.

## `search`

Full-text search (FTS5) with filters. An empty `query` becomes a filtered browse.

| Arg | Description |
|-----|-------------|
| `query` | FTS query; omit to browse by filters only. |
| `from` | Sender: display-name substring or `p:` handle. |
| `in` | Conversation: title substring or `c:` handle. |
| `kind` | Conversation kind. |
| `mentions_me` | Only messages that @mention you. |
| `has_attachment` | Only messages with an attachment. |
| `since` / `until` | Time window. |
| `exclude` | `c:`/`p:` handles to exclude from results. |
| `limit` | Default 20, max 60. |

On empty results (or a `since` window newer than the cache holds), a coverage note reports
the newest/oldest cached message in scope — so a quiet result isn't mistaken for a sync gap.

## `top_topics`

Distinctive/trending topics over a window, scored against your own baseline (not raw
frequency), each with an example message. Bot/app senders are excluded by default.

| Arg | Description |
|-----|-------------|
| `window` | `1d` \| `7d` \| `30d` (default `7d`). Ignored if `since`/`until` given. |
| `since` / `until` | Arbitrary window, overriding `window`. |
| `scope` | `conversation:<c: or title>` or `person:<name or p:>`. |
| `exclude` | Words, or `c:`/`p:` handles, to exclude. |
| `include_bots` | Include bot/app senders (excluded by default). |
| `n` | Default 8, max 15. |

## `find_person`

Resolve a name/nickname to a canonical person + `p:` handle, with message count and last
contact. Omit `query` to scan the roster (most-talked-to first). Bots are tagged `[bot]`;
you are tagged `(you)`.

| Arg | Description |
|-----|-------------|
| `query` | Name substring, or a `p:` handle to expand; omit to scan the roster. |
| `n` | Default 8, max 25. |

## `describe_schema`

A recovery tool. When a Teams update changes the on-disk layout so the store is no longer
recognized, this samples the raw stores and **proposes** a field mapping to save as a new
schema version. It proposes only — it never applies anything. See
[Troubleshooting](troubleshooting.md).

| Arg | Description |
|-----|-------------|
| `limit` | Max stores to list (default 20). |
