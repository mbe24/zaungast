//! FTS5 index refresh over the messages table: `refresh_fts` rebuilds the whole index (full ingest),
//! `refresh_fts_delta` re-derives only the changed ids (incremental). Mirrors ChatStore.refreshFts.

use std::collections::HashSet;

use rusqlite::{params, Connection};

pub(crate) fn refresh_fts(conn: &Connection) {
    conn.execute_batch(
        "delete from messages_fts;
         insert into messages_fts(content,conv_id,id) select content,conv_id,id from messages where is_system=0 and content<>'';",
    )
    .unwrap();
}

// delta FTS: re-derive only the given ids from the (post-mutation) messages table. Mirrors
// ChatStore.refreshFts(changedIds). Empty → no-op.
pub(crate) fn refresh_fts_delta(conn: &Connection, ids: &HashSet<String>) {
    if ids.is_empty() {
        return;
    }
    conn.execute_batch(
        "create temp table if not exists _chg(id text primary key); delete from _chg;",
    )
    .unwrap();
    {
        let mut ins = conn
            .prepare("insert or ignore into _chg values(?)")
            .unwrap();
        for id in ids {
            ins.execute(params![id]).unwrap();
        }
    }
    conn.execute_batch(
        "delete from messages_fts where id in (select id from _chg);
         insert into messages_fts(content,conv_id,id) select content,conv_id,id from messages where id in (select id from _chg) and is_system=0 and content<>'';",
    )
    .unwrap();
}
