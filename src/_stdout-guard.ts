// Imported FIRST from index.ts: redirect all console.* to stderr so no stray write
// corrupts the stdio JSON-RPC framing on stdout. The MCP transport owns stdout.
for (const m of ['log', 'info', 'debug', 'warn'] as const) {
  console[m] = (...a: unknown[]) => { process.stderr.write(a.map(String).join(' ') + '\n') }
}
export {}
