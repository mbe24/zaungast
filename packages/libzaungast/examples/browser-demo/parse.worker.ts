// Ingest worker for the pool: off-thread `.ldb` parse (kind 'parse') AND SSV extract (kind 'extract').
// One worker script serves both cold-read phases so the pool is spawned once and reused.
//  • parse:   bytes → TableReadResult; input CLONED in (coordinator keeps its copy for the serial
//             fallback / dev verify), parsed entry buffers TRANSFERRED back (dedup — entries share
//             per-block buffers) so no bytes are copied.
//  • extract: (records, mapping, entity) → EntityExtract; records arrive compact-copied by the library.
import { parseTable, extractRecords } from 'libzaungast/web';

type Msg =
  | { kind: 'parse'; bytes: Uint8Array }
  | { kind: 'extract'; records: unknown[]; mapping: unknown; entity: string };

self.onmessage = (e: MessageEvent<Msg>) => {
  const msg = e.data;
  const post = self as unknown as Worker;
  if (msg.kind === 'parse') {
    let res;
    try {
      res = parseTable(msg.bytes);
    } catch {
      // Mirror readTablesInto's inline catch: a corrupt table folds as lossy-empty (whole load marked
      // lossy), never a pool-killing throw — so one bad `.ldb` can't force a full serial re-parse.
      post.postMessage({ entries: [], lossy: true });
      return;
    }
    const transfer = [...new Set(res.entries.flatMap(([k, v]) => [k.buffer, v.buffer]))];
    post.postMessage(res, transfer as Transferable[]);
  } else {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    post.postMessage(extractRecords(msg.records as any, msg.mapping as any, msg.entity));
  }
};
