import './_stdout-guard.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { openLiveStore } from 'libzaungast';
import { buildServer, VERSION } from './server.js';
import { selectEngine } from './engine.js';

// ZAUNGAST_DB_DIR = a static leveldb dir (tests / a manual copy) — skips snapshot+discovery.
// Otherwise discover the live Teams store (TEAMS_LEVELDB_DIR overrides discovery).
// Refresh mode defaults to 'copy-reuse' (fast: reuse immutable .ldb parses, re-read only the
// .log — chat data changes often during work hours). ZAUNGAST_INCREMENTAL=reparse opts out
// to the simpler full-reparse-each-refresh path.
// `warm: false` → a lazy cold start so `initialize` returns instantly; we warm post-handshake.
// ZAUNGAST_ENGINE (js|native|auto) selects the ingest engine; we inject it — libzaungast is pure.
const staticDir = process.env.ZAUNGAST_DB_DIR;
const incrementalMode = process.env.ZAUNGAST_INCREMENTAL === 'reparse' ? 'reparse' : 'copy-reuse';
const { engine, note } = await selectEngine();
const live = openLiveStore(
  staticDir
    ? { dir: staticDir, incrementalMode, warm: false, engine }
    : { overrideDir: process.env.TEAMS_LEVELDB_DIR, incrementalMode, warm: false, engine },
);

const server = buildServer(live);
await server.connect(new StdioServerTransport());
process.stderr.write(
  `zaungast v${VERSION} — offline Teams reader — engine:${note} — ready (stdio)\n`,
);

// Warm the index AFTER the handshake so `initialize` returns instantly and the first tool
// call is fast. Deferred a tick so connect() fully settles first — the cold store builds on
// this first refresh().
setTimeout(() => {
  try {
    live.refresh();
  } catch (e) {
    process.stderr.write(`warmUp: ${e}\n`);
  }
}, 0);

const shutdown = () => {
  try {
    live.close();
  } catch {}
  process.exit(0);
};
process.stdin.on('close', shutdown);
process.stdin.on('end', shutdown);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
