// MCP server e2e over stdio: spawns the real server as a child process (StdioClientTransport),
// lists tools, and calls a few. Real-data-only — no synthetic fallback — so it self-skips (green)
// when no ZAUNGAST_TEST_DIR leveldb cache is available.
import { test, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { resolveLevelDbDir } from '../../../scripts/native-runner.mjs';

const dir = resolveLevelDbDir(process.env.ZAUNGAST_TEST_DIR);

let client: Client | undefined;

beforeAll(async () => {
  if (!dir) return;
  const indexPath = fileURLToPath(new URL('../src/index.ts', import.meta.url));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--conditions=development', '--experimental-sqlite', '--import', 'tsx', indexPath],
    env: { ...process.env, ZAUNGAST_DB_DIR: dir },
    stderr: 'inherit',
  });
  client = new Client({ name: 'test', version: '0' });
  await client.connect(transport);
});

afterAll(async () => {
  await client?.close();
});

test.skipIf(!dir)('MCP server e2e over stdio', async () => {
  const tools = await client!.listTools();
  expect(tools.tools.length).toBeGreaterThan(0);

  async function call(name: string, args: any) {
    const r: any = await client!.callTool({ name, arguments: args });
    const text = r.content[0].text;
    expect(text.length).toBeGreaterThan(0);
  }

  await call('list_conversations', { n: 4 });
  await call('search', { query: 'weekend', limit: 3 });
  await call('rank_topics', { window: '7d', n: 4 });
});
