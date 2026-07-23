// The ONLY fs-touching module in the decode path. Wraps a leveldb dir on the Node filesystem as a
// LiveSnapshotSource, and re-exports the string-dir loaders (unchanged call shape) that the rest of
// the package uses — the pure decode core (indexeddb/sstable/write-ahead-log) never imports node:fs.
import fs from 'node:fs';
import path from 'node:path';
import type {
  LdbCache,
  LiveSnapshotSource,
  LoadEntriesOptions,
  LoadEntriesResult,
  LoadEntriesReuseResult,
  Snapshot,
  SnapshotSource,
  TableReadResult,
  WalBatch,
} from '../types.js';
import { parseTable } from './sstable.js';
import { parseWal } from './write-ahead-log.js';
import {
  loadSnapshotFrom,
  loadEntriesFrom,
  loadSnapshotReuseFrom,
  loadEntriesReuseFrom,
} from './indexeddb.js';

// A leveldb dir on the Node filesystem. `.ldb`/`.log` reads are one syscall each; `stat` powers the
// copy-reuse cache self-validation (a size change means the file was re-copied).
export class NodeSource implements LiveSnapshotSource {
  constructor(private readonly dir: string) {}
  names(): string[] {
    return fs.readdirSync(this.dir);
  }
  read(name: string): Uint8Array {
    return fs.readFileSync(path.join(this.dir, name));
  }
  stat(name: string): { size: number; mtimeMs: number } {
    const s = fs.statSync(path.join(this.dir, name));
    return { size: s.size, mtimeMs: s.mtimeMs };
  }
}

// A string dir becomes a (Live-capable) NodeSource; an already-built source passes through.
export const toSource = (src: string | SnapshotSource): SnapshotSource =>
  typeof src === 'string' ? new NodeSource(src) : src;

// String-dir loaders — the SAME names/signatures the codebase already uses (callers only change the
// import path, never the call shape). Reuse needs Live, so it builds a NodeSource directly.
export const loadSnapshot = (dir: string, opts: LoadEntriesOptions = {}): Snapshot =>
  loadSnapshotFrom(toSource(dir), opts);
export const loadEntries = (dir: string, opts: LoadEntriesOptions = {}): LoadEntriesResult =>
  loadEntriesFrom(toSource(dir), opts);
export const loadEntriesReuse = (dir: string, cache: LdbCache): LoadEntriesReuseResult =>
  loadEntriesReuseFrom(new NodeSource(dir), cache);
export const loadSnapshotReuse = (
  dir: string,
  cache: LdbCache,
): Snapshot & { compacted: boolean } => loadSnapshotReuseFrom(new NodeSource(dir), cache);

// Node byte-reader conveniences (differential harness + a fixture test read a single file by path).
export const readTable = (p: string): TableReadResult => parseTable(fs.readFileSync(p));
export const parseWriteAheadLog = (p: string): WalBatch[] => parseWal(fs.readFileSync(p));
