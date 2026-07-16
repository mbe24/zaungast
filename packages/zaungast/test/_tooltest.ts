import { openStore } from 'libzaungast/store-api.js';
import { listConversations, readMessages, search, topTopics } from 'zaungast/tools.js';

const DIR = process.argv[2] ?? process.env.ZAUNGAST_TEST_DIR;
if (!DIR) {
  console.error('Set ZAUNGAST_TEST_DIR or pass a leveldb dir as argv[2]');
  process.exit(1);
}
const store = openStore(DIR);

const show = (title: string, out: string) =>
  console.log(`\n########## ${title} ##########\n${out}`);

show('list_conversations {n:5}', listConversations(store, { n: 5 }));
show('list_conversations {kind:"channel", n:4}', listConversations(store, { kind: 'channel', n: 4 }));

// pick the most-recent conversation to read (facade lists newest-first).
const top = store.conversations.list({ n: 1 })[0];
if (top)
  show(
    `read_messages {conversation:"${top.handle}", limit:6}`,
    readMessages(store, { conversation: top.handle, limit: 6 }),
  );

show('search {query:"weekend", limit:4}', search(store, { query: 'weekend', limit: 4 }));
show('search {mentions_me:true, limit:4}', search(store, { mentions_me: true, limit: 4 }));
show('search {from:"Grace", limit:4}', search(store, { from: 'Grace', limit: 4 }));

show('top_topics {window:"7d", n:6}', topTopics(store, { window: '7d', n: 6 }));

store.close();
