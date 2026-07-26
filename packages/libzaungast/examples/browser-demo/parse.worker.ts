// Ingest worker for the pool: off-thread `.ldb` parse (kind 'parse') AND SSV extract (kind 'extract').
// One worker script serves both cold-read phases so the pool is spawned once and reused.
//  • parse:   bytes → PackedTable (M4a); the parsed entries are flattened into 3 transferables (keys
//             blob + values blob + lengths table) via packTable, so a table crosses the boundary as 3
//             buffers moved zero-copy — not the hundreds of thousands of tiny per-entry buffers that
//             made per-entry transfer net-negative. The coordinator rebuilds it with unpackTable.
//  • extract: (records, mapping, entity) → EntityExtract; records arrive compact-copied by the library.
import { parseTable, extractRecords, packTable, packedTransferList } from 'libzaungast/web';

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
      res = { entries: [], lossy: true };
    }
    const packed = packTable(res);
    post.postMessage(packed, packedTransferList(packed) as Transferable[]);
  } else {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    post.postMessage(extractRecords(msg.records as any, msg.mapping as any, msg.entity));
  }
};
