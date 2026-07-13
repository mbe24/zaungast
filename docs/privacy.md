# Privacy & safety

## It stays local

zaungast makes **no network calls**. It reads a database already on your machine and serves
it to your local agent over stdio. Nothing is uploaded, and there are no credentials or
tokens involved.

## It cannot harm your Teams data

The single most important safety property: **the live Teams directory is only ever read and
copied — never written to, locked, or memory-mapped.**

- No LevelDB library is opened against the live directory (so the `LOCK` file is never
  contended, no compaction/repair is triggered).
- Files are opened read-only and copied to a temporary directory; parsing happens on the
  copy, never in place.
- On Windows, a read-only observer cannot cause a running writer's writes to fail, and a
  file removed by Teams' compaction mid-copy is handled gracefully.

This was verified by design review and is covered by tests.

## Attachments and images

Images and files shared in chat are **not** stored locally — Teams keeps them in its cloud
behind authentication. zaungast surfaces *that* an attachment exists (an `[attachment]`
marker, and the URL is preserved in the data) but **never fetches the bytes** and never
handles any auth token. Fetching them would require live, authenticated calls — out of scope
for a local, credential-free reader.

## What's on disk

- The in-memory index is exactly that — **in memory**; it is not persisted.
- Temporary snapshots of the Teams files are written to the OS temp directory during a
  refresh and removed afterward.
- No artifact in the source tree contains your chat content: schema mappings hold only store
  names and field paths, and fixtures are synthetic.

## Scope

The reader sees everything in the local cache your Teams client synced — including 1:1 DMs.
That is correct and powerful, but the surface is broad; treat the tool's output as you would
your own Teams client.
