// Pool worker: a 2-line entry over libzaungast/web's handlePoolMessage, which runs both cold-read pool
// jobs — `.ldb` parse → PackedTable, and the SSV extract over a packed record range → EntityExtract —
// and returns the reply + the ArrayBuffers to move zero-copy. The coordinator (teams.worker.ts) spawns N
// of these via createPool. The parse/extract logic itself lives in the library, so this stays trivial.
import { handlePoolMessage } from 'libzaungast/web';

self.onmessage = (e: MessageEvent) => {
  const { data, transfer } = handlePoolMessage(e.data);
  (self as unknown as Worker).postMessage(data, transfer);
};
