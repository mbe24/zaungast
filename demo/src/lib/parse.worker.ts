// Parse-worker: decode one `.ldb` file's bytes → TableReadResult, off the coordinator thread. The
// coordinator folds the results into the Snapshot (deterministic order → byte-identical fingerprint).
// Input bytes are CLONED in (the coordinator keeps its copy for the serial fallback / dev verify); the
// parsed entry buffers are TRANSFERRED back (dedup — entries share per-block buffers) so no bytes copy.
import { parseTable } from 'libzaungast/web';

self.onmessage = (e: MessageEvent<{ bytes: Uint8Array }>) => {
  const res = parseTable(e.data.bytes);
  const transfer = [...new Set(res.entries.flatMap(([k, v]) => [k.buffer, v.buffer]))];
  (self as unknown as Worker).postMessage(res, transfer as Transferable[]);
};
