import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LiveTeamsStore, StoreReading } from 'libzaungast';
import type { Snapshot } from 'libzaungast/format/engine';
import { TOOLS } from './tools.js';

export function buildServer(live: LiveTeamsStore): McpServer {
  const server = new McpServer({ name: 'zaungast', version: '0.1.0' });

  const runQuery = (fn: (view: StoreReading, a: any) => string, args: any) => {
    try {
      const view = live.current(); // one probe/refresh decision → a pinned, consistent reading
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
        content: [{ type: 'text' as const, text: fn(view, args) }],
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
      async (args: any) => (tool.kind === 'query' ? runQuery(tool.run, args) : runRaw(tool.run, args)),
    );
  }

  return server;
}
