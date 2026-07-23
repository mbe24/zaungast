// Pure in-memory SnapshotSource — the browser path (no fs). Base only: NO stat, so it drives the
// full-decode loaders (loadSnapshotFrom/loadEntriesFrom) but not the Node-only copy-reuse path.
import type { SnapshotSource } from '../types.js';

export class MemorySource implements SnapshotSource {
  private readonly files: Map<string, Uint8Array>;
  constructor(files: Map<string, Uint8Array> | Record<string, Uint8Array>) {
    this.files = files instanceof Map ? files : new Map(Object.entries(files));
  }
  names(): string[] {
    return [...this.files.keys()];
  }
  read(name: string): Uint8Array {
    const f = this.files.get(name);
    if (!f) throw new Error(`MemorySource: no such file ${name}`);
    return f;
  }
}
