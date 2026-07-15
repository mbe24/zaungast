import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Session } from './session.js';
import { listConversations, readMessages, search, topTopics, findPerson } from './tools.js';
import { describeSchema } from './tools/describeSchema.js';
import {
  listConversationsShape,
  readMessagesShape,
  searchShape,
  topTopicsShape,
  findPersonShape,
  describeSchemaShape,
} from './schemas.js';

const HISTORY_NOTE =
  'Note: this reads the LOCAL Teams cache — history is the synced slice on this device, not the full server archive.';

// The owner's own messages are labelled `<name> (you)`; that speaker is the human account owner,
// NOT you the assistant — attribute those lines to the user, never to yourself.
const YOU_NOTE =
  'The account owner\'s own messages are labelled "<name> (you)" — that speaker is the user, not you the assistant.';

export function buildServer(session: Session): McpServer {
  const server = new McpServer({ name: 'zaungast', version: '0.1.0' });

  const run = (fn: (s: any, m: any, d: boolean, a: any) => string, args: any) => {
    try {
      const { store, meta, staleProbeDeferred } = session.get();
      if (!meta.schemaMatched) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `This Teams build's IndexedDB schema is not recognized (fingerprint ${meta.fingerprint}). Run the describe_schema tool to inspect the stores and get a proposed mapping.`,
            },
          ],
        };
      }
      return {
        content: [{ type: 'text' as const, text: fn(store, meta, staleProbeDeferred, args) }],
      };
    } catch (e: any) {
      return {
        content: [{ type: 'text' as const, text: `error: ${e?.message ?? String(e)}` }],
        isError: true,
      };
    }
  };

  server.registerTool(
    'list_conversations',
    {
      title: 'List conversations',
      description: `Your Teams sidebar: the newest N conversations (default), or filter by kind/participant/title/time. ${HISTORY_NOTE}`,
      inputSchema: listConversationsShape,
    },
    async (args) => run(listConversations, args),
  );

  server.registerTool(
    'read_messages',
    {
      title: 'Read a conversation',
      description: `Read one conversation's messages in STORY ORDER (oldest→newest). Target by handle (c:xxxx) or title/participant substring. Page back with the returned older: cursor, or center on a message with around:. ${YOU_NOTE} ${HISTORY_NOTE}`,
      inputSchema: readMessagesShape,
    },
    async (args) => run(readMessages, args),
  );

  server.registerTool(
    'search',
    {
      title: 'Search messages',
      description: `Full-text search across all messages with filters. Empty query = filtered browse. from/in accept display-name / title substrings or handles. mentions_me finds messages that @mention you. ${YOU_NOTE} ${HISTORY_NOTE}`,
      inputSchema: searchShape,
    },
    async (args) => run(search, args),
  );

  server.registerTool(
    'top_topics',
    {
      title: 'Trending topics',
      description: `Distinctive/trending topics over a window (vs your baseline), overall or scoped to a person/conversation. Returns each topic with an exemplar message. ${HISTORY_NOTE}`,
      inputSchema: topTopicsShape,
    },
    async (args) => run(topTopics, args),
  );

  server.registerTool(
    'find_person',
    {
      title: 'Find a person',
      description: `Resolve a name/nickname fragment to a person's canonical name and stable p:handle, with message count and last-contact time. Use when a name is ambiguous or unrecognized, or when you need contact stats or a p:handle. For ordinary filtering, just pass a name substring directly to search/read_messages 'from'/'participant' — don't call this first. Omit query to scan the roster (most-talked-to first).`,
      inputSchema: findPersonShape,
    },
    async (args) => run(findPerson, args),
  );

  server.registerTool(
    'describe_schema',
    {
      title: 'Describe / recover schema',
      description: `Inspect the raw Teams IndexedDB stores and PROPOSE a field mapping. Use when tools report the schema is unrecognized (after a Teams update), or to inspect the DB structure. Proposes only — applies nothing; a human verifies the proposal and saves it as a new schema version.`,
      inputSchema: describeSchemaShape,
    },
    async (args) => {
      try {
        return {
          content: [{ type: 'text' as const, text: describeSchema(session.currentDir(), args) }],
        };
      } catch (e: any) {
        return {
          content: [{ type: 'text' as const, text: `error: ${e?.message ?? String(e)}` }],
          isError: true,
        };
      }
    },
  );

  return server;
}
