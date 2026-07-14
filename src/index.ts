#!/usr/bin/env node
// Bootstrap. The server uses node:sqlite, which on Node 22.x needs --experimental-sqlite.
// A published `npx zaungast` (or `node dist/index.js`) starts without that flag, so:
//   1. probe for node:sqlite;
//   2. if missing and we haven't already re-tried, re-exec THIS file once WITH the flag,
//      inheriting stdio so the MCP transport passes straight through;
//   3. if it's still missing after the flag, the Node version is too old (node:sqlite landed
//      in 22.5) — fail loudly instead of respawning forever.
// On Node ≥ 24 (sqlite stable) the first probe succeeds and we run directly, no respawn.
let sqliteReady = true;
try {
  await import('node:sqlite');
} catch {
  sqliteReady = false;
}

if (sqliteReady) {
  await import('./main.js');
} else if (process.execArgv.includes('--experimental-sqlite')) {
  // Flag is already set but node:sqlite is unavailable → Node is older than 22.5.
  process.stderr.write(
    `zaungast requires Node.js >= 22.5 (for the built-in node:sqlite). ` +
      `You are running ${process.version}. Please upgrade Node.js and try again.\n`,
  );
  process.exit(1);
} else {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const self = fileURLToPath(import.meta.url);
  const res = spawnSync(
    process.execPath,
    ['--experimental-sqlite', self, ...process.argv.slice(2)],
    { stdio: 'inherit' },
  );
  process.exit(res.status ?? 1);
}
