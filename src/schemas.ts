import { z } from 'zod'

// Single source of truth for tool argument schemas. The raw shapes feed McpServer's
// registerTool inputSchema; the inferred types type the tool functions in tools.ts — so a
// schema/tool-signature mismatch is a compile error, not a silent runtime bug.

const kindEnum = z.enum(['1:1', 'group', 'channel', 'meeting'])

export const listConversationsShape = {
  n: z.number().int().min(1).max(30).optional().describe('how many (default 12)'),
  kind: z.enum(['1:1', 'group', 'channel', 'meeting', 'other']).optional(),
  query: z.string().optional().describe('match conversation title or participant'),
  participant: z.string().optional().describe('display-name substring of a participant'),
  since: z.string().optional().describe('ISO date or relative like -7d/-24h'),
  include_empty: z.boolean().optional().describe('include 0-message conversations (team roots); off by default'),
}

export const readMessagesShape = {
  conversation: z.string().describe('conversation handle (c:xxxx) or title/participant substring'),
  limit: z.number().int().min(1).max(200).optional().describe('default 40'),
  since: z.string().optional(),
  until: z.string().optional(),
  cursor: z.string().optional().describe('the older:… value from a previous result, to page back'),
  around: z.string().optional().describe('a message id (the m:… value from a search hit) to center a window on'),
}

export const searchShape = {
  query: z.string().optional().describe('FTS query; omit to browse by filters only'),
  from: z.string().optional().describe('sender: display-name substring or p:handle'),
  in: z.string().optional().describe('conversation: title substring or c:handle'),
  kind: kindEnum.optional(),
  mentions_me: z.boolean().optional(),
  has_attachment: z.boolean().optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  exclude: z.array(z.string()).optional().describe('c:/p: handles to exclude from results'),
  limit: z.number().int().min(1).max(60).optional().describe('default 20'),
}

export const topTopicsShape = {
  window: z.enum(['1d', '7d', '30d']).optional().describe('default 7d; ignored if since/until given'),
  since: z.string().optional().describe('arbitrary window start (ISO or -7d); overrides window'),
  until: z.string().optional().describe('arbitrary window end (ISO or -1d)'),
  scope: z.string().optional().describe('"conversation:<c:handle or title>" or "person:<name or p:handle>"'),
  exclude: z.array(z.string()).optional().describe('words, or c:/p: handles, to exclude'),
  include_bots: z.boolean().optional().describe('include bot/app senders (excluded by default)'),
  n: z.number().int().min(1).max(15).optional().describe('default 8'),
}

export const findPersonShape = {
  query: z.string().optional().describe('name substring, or a p:handle to expand; omit to scan the roster'),
  n: z.number().int().min(1).max(25).optional().describe('default 8'),
}

export const describeSchemaShape = {
  limit: z.number().int().min(1).max(60).optional().describe('max stores to list (default 20)'),
}

export type ListConversationsArgs = z.infer<z.ZodObject<typeof listConversationsShape>>
export type ReadMessagesArgs = z.infer<z.ZodObject<typeof readMessagesShape>>
export type SearchArgs = z.infer<z.ZodObject<typeof searchShape>>
export type TopTopicsArgs = z.infer<z.ZodObject<typeof topTopicsShape>>
export type FindPersonArgs = z.infer<z.ZodObject<typeof findPersonShape>>
export type DescribeSchemaArgs = z.infer<z.ZodObject<typeof describeSchemaShape>>
