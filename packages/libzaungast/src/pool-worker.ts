// The parse/extract pool worker's protocol + handler (browser parallel ingest). A consumer's worker
// entry is two lines:
//   import { handlePoolMessage } from 'libzaungast/web';
//   self.onmessage = (e) => { const r = handlePoolMessage(e.data); self.postMessage(r.data, r.transfer); };
// Kept DOM-free — it takes the message DATA (not a MessageEvent) and returns `transfer` as ArrayBuffer[]
// — so it compiles under the library's Node lib. The one file that references `Worker` is ./pool.ts.
import { parseTable } from './format/chromium/sstable.js';
import {
  packTable,
  packedTransferList,
  unpackRecords,
  type PackedRecords,
} from './format/table-transfer.js';
import { extractRecords } from './format/resolver.js';
import type { Mapping } from './format/types.js';

// One pool job. `parse`: a raw `.ldb` → PackedTable. `extract`: a packed record range + its entity
// mapping → EntityExtract. Both cross the worker boundary in the 3-buffer packed form (M4a codec).
export type PoolRequest =
  | { kind: 'parse'; bytes: Uint8Array }
  | { kind: 'extract'; packed: PackedRecords; mapping: Mapping; entity: string };

// The reply payload + the ArrayBuffers to hand postMessage's transfer list (moved zero-copy). Typed as
// ArrayBuffer[] rather than Transferable[] to keep this module DOM-free.
export interface PoolResponse {
  data: unknown;
  transfer: ArrayBuffer[];
}

// Run one pool job. Pure (no Worker/self) so it's unit-testable and the worker entry stays trivial.
export function handlePoolMessage(msg: PoolRequest): PoolResponse {
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
    return { data: packed, transfer: packedTransferList(packed) };
  }
  const ex = extractRecords(unpackRecords(msg.packed), msg.mapping, msg.entity);
  return { data: ex, transfer: [] };
}
