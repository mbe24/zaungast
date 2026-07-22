import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LiveTeamsStore, StoreReading } from 'libzaungast';
import type { Snapshot } from 'libzaungast/format/engine';
import type { RenderCtx } from './tools/types.js';
import { TOOLS } from './tools.js';

// The render timezone is resolved ONCE from the host (this is a local server; the machine's zone is
// the user's zone). `now` is sampled per dispatch. Together they form the RenderCtx passed to every
// query tool, so rendering never reads the ambient process timezone/clock implicitly.
const RENDER_TZ: string = Intl.DateTimeFormat().resolvedOptions().timeZone;

// The real package version — package.json sits one level up from both src/ (dev) and dist/ (published).
// Reported in the MCP initialize handshake and the startup banner: a passive, zero-network disclosure
// of what the user is running (the server never checks a registry — offline by design).
export const VERSION: string = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

export function buildServer(live: LiveTeamsStore): McpServer {
  const server = new McpServer({ name: 'zaungast', version: VERSION });

  const runQuery = (fn: (view: StoreReading, a: any, ctx: RenderCtx) => string, args: any) => {
    try {
      const view = live.current(); // one probe/refresh decision → a pinned, consistent reading
      const ctx: RenderCtx = { tz: RENDER_TZ, now: Date.now() };
      if (!view.meta.schemaMatched) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `This Teams build's IndexedDB schema is not recognized (fingerprint ${view.meta.fingerprint}). Run the describe_schema tool to inspect the stores and get a proposed mapping.`,
            },
          ],
        };
      }
      return {
        content: [{ type: 'text' as const, text: fn(view, args, ctx) }],
      };
    } catch (e: any) {
      return {
        content: [{ type: 'text' as const, text: `error: ${e?.message ?? String(e)}` }],
        isError: true,
      };
    }
  };

  const runRaw = (fn: (snap: Snapshot, a: any) => string, args: any) => {
    try {
      // Sample the CONSISTENT tmp snapshot backing the current build (never the live Teams dir).
      const snap = live.reloadSnapshot();
      return {
        content: [{ type: 'text' as const, text: fn(snap, args) }],
      };
    } catch (e: any) {
      return {
        content: [{ type: 'text' as const, text: `error: ${e?.message ?? String(e)}` }],
        isError: true,
      };
    }
  };

  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.inputSchema },
      async (args: any) =>
        tool.kind === 'query' ? runQuery(tool.run, args) : runRaw(tool.run, args),
    );
  }

  return server;
}
