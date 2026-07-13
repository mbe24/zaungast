import './_stdout-guard.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { Session } from './session.js'
import { buildServer } from './server.js'

// ZAUNGAST_DB_DIR = a static leveldb dir (tests / a manual copy) — skips snapshot+discovery.
// Otherwise discover the live Teams store (TEAMS_LEVELDB_DIR overrides discovery).
// Refresh mode defaults to 'copy-reuse' (fast: reuse immutable .ldb parses, re-read only the
// .log — chat data changes often during work hours). ZAUNGAST_INCREMENTAL=reparse opts out
// to the simpler full-reparse-each-refresh path.
const staticDir = process.env.ZAUNGAST_DB_DIR
const incrementalMode = process.env.ZAUNGAST_INCREMENTAL === 'reparse' ? 'reparse' : 'copy-reuse'
const session = new Session(
  staticDir ? { dir: staticDir, incrementalMode } : { overrideDir: process.env.TEAMS_LEVELDB_DIR, incrementalMode },
)

const server = buildServer(session)
await server.connect(new StdioServerTransport())
process.stderr.write('zaungast MCP server ready (stdio)\n')

// Warm the index AFTER the handshake so `initialize` returns instantly and the first tool
// call is fast. Deferred a tick so connect() fully settles first.
setTimeout(() => { try { session.warmUp() } catch (e) { process.stderr.write(`warmUp: ${e}\n`) } }, 0)

const shutdown = () => { try { session.dispose() } catch {} process.exit(0) }
process.stdin.on('close', shutdown)
process.stdin.on('end', shutdown)
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
