import { Session } from '../src/session.js'
import { listConversations, readMessages, search, topTopics } from '../src/tools.js'

const DIR = process.argv[2] ?? process.env.ZAUNGAST_TEST_DIR
if (!DIR) { console.error('Set ZAUNGAST_TEST_DIR or pass a leveldb dir as argv[2]'); process.exit(1) }
const s = new Session({ dir: DIR })
const { store, meta, staleProbeDeferred: d } = s.get()

const show = (title: string, out: string) => console.log(`\n########## ${title} ##########\n${out}`)

show('list_conversations {n:5}', listConversations(store, meta, d, { n: 5 }))
show('list_conversations {kind:"channel", n:4}', listConversations(store, meta, d, { kind: 'channel', n: 4 }))

// pick the busiest conversation handle to read
const top = store.db.prepare(`select handle from conversations order by msg_count desc limit 1`).get() as any
show(`read_messages {conversation:"${top.handle}", limit:6}`, readMessages(store, meta, d, { conversation: top.handle, limit: 6 }))

show('search {query:"weekend", limit:4}', search(store, meta, d, { query: 'weekend', limit: 4 }))
show('search {mentions_me:true, limit:4}', search(store, meta, d, { mentions_me: true, limit: 4 }))
show('search {from:"Grace", query:"release date", limit:4}', search(store, meta, d, { from: 'Grace', limit: 4 }))

show('top_topics {window:"7d", n:6}', topTopics(store, meta, d, { window: '7d', n: 6 }))

s.dispose()
