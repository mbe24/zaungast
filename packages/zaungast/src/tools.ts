// Slim barrel. Keeps the `zaungast/tools.js` specifier stable (tests import the handlers +
// parseTime/fmtTs by name from here) and assembles the tool-descriptor registry (`TOOLS`) that
// server.ts loops over. Each handler + its tool-specific renderers live in tools/<name>.ts; the
// cross-cutting helpers live in tools/shared.ts.
import type { Tool } from './tools/types.js';
import { listConversations, listConversationsTool } from './tools/listConversations.js';
import { readConversation, readConversationTool } from './tools/readConversation.js';
import { readThread, readThreadTool } from './tools/readConversation.js';
import { getMessage, getMessageTool } from './tools/getMessage.js';
import { search, searchTool } from './tools/search.js';
import { topTopics, topTopicsTool } from './tools/topTopics.js';
import { findPerson, findPersonTool } from './tools/findPerson.js';
import { listEvents, listEventsTool } from './tools/listEvents.js';
import { listCalls, listCallsTool } from './tools/listCalls.js';
import { describeSchemaTool } from './tools/describeSchema.js';

export { fmtTs, parseTime } from './tools/shared.js';
export {
  listConversations,
  readConversation,
  readThread,
  getMessage,
  search,
  topTopics,
  findPerson,
  listEvents,
  listCalls,
};

export const TOOLS: Tool[] = [
  listConversationsTool,
  readConversationTool,
  readThreadTool,
  getMessageTool,
  searchTool,
  topTopicsTool,
  findPersonTool,
  listEventsTool,
  listCallsTool,
  describeSchemaTool,
];
