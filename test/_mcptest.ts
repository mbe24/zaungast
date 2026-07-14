import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'node:url'

const indexPath = fileURLToPath(new URL('../src/index.ts', import.meta.url))
const dbDir = process.argv[2] ?? process.env.ZAUNGAST_TEST_DIR
if (!dbDir) { console.error('Set ZAUNGAST_TEST_DIR or pass a leveldb dir as argv[2]'); process.exit(1) }

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['--experimental-sqlite', '--import', 'tsx', indexPath],
  env: { ...process.env, ZAUNGAST_DB_DIR: dbDir },
  stderr: 'inherit',
})
const client = new Client({ name: 'test', version: '0' })
await client.connect(transport)

const tools = await client.listTools()
process.stdout.write(`\nTOOLS: ${tools.tools.map((t) => t.name).join(', ')}\n`)

async function call(name: string, args: any) {
  const t0 = Date.now()
  const r: any = await client.callTool({ name, arguments: args })
  process.stdout.write(`\n===== ${name}(${JSON.stringify(args)})  [${Date.now() - t0}ms] =====\n${r.content[0].text}\n`)
}

await call('list_conversations', { n: 4 })
await call('search', { query: 'weekend', limit: 3 })
await call('top_topics', { window: '7d', n: 4 })

await client.close()
process.exit(0)
