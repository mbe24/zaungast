// Real-data smoke: exercises the MCP tool renderers against a live leveldb cache. Skips (green)
// when no real cache is available.
import { test, expect } from 'vitest';
import { openStore } from 'libzaungast';
import { listConversations, readConversation, search, rankTopics } from 'zaungast/tools.js';
import { resolveLevelDbDir } from '../../../scripts/native-runner.mjs';

const dir = resolveLevelDbDir(process.env.ZAUNGAST_TEST_DIR);

test.skipIf(!dir)('MCP tool renderers over a real cache', () => {
  const store = openStore(dir!);

  const show = (title: string, out: string) =>
    console.log(`\n########## ${title} ##########\n${out}`);

  const list5 = listConversations(store, { n: 5 });
  show('list_conversations {n:5}', list5);
  expect(typeof list5).toBe('string');
  expect(list5.length).toBeGreaterThan(0);

  show(
    'list_conversations {kind:"channel", n:4}',
    listConversations(store, { kind: 'channel', n: 4 }),
  );

  // pick the most-recent conversation to read (facade lists newest-first).
  const top = store.conversations.list({ n: 1 })[0];
  if (top) {
    const read = readConversation(store, { conversation: top.handle, limit: 6 });
    show(`read_conversation {conversation:"${top.handle}", limit:6}`, read);
    expect(typeof read).toBe('string');
    expect(read.length).toBeGreaterThan(0);
  }

  show('search {query:"weekend", limit:4}', search(store, { query: 'weekend', limit: 4 }));
  show('search {mentions_me:true, limit:4}', search(store, { mentions_me: true, limit: 4 }));
  show('search {from:"Grace", limit:4}', search(store, { from: 'Grace', limit: 4 }));

  const topics = rankTopics(store, { window: '7d', n: 6 });
  show('rank_topics {window:"7d", n:6}', topics);
  expect(typeof topics).toBe('string');
  expect(topics.length).toBeGreaterThan(0);

  store.close();
});
