// Seam parity (plan A8): the browser decode path — loadSnapshotFrom over a MemorySource built from the
// raw file bytes — must produce exactly the same Snapshot as the Node path (loadSnapshot(dir) → NodeSource
// + fs). Runs in the default (Node) `fixture` project under the node #bytes codec, AND — via the browser
// vitest project (conditions:['browser']) — under the hand-rolled web codec, so a source-plumbing OR
// codec divergence surfaces here. Uses fs to seed the MemorySource (still Node under happy-dom; only
// module resolution changes across projects).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect, beforeAll, afterAll } from 'vitest';
import { loadSnapshot } from '../src/format/chromium/node-source.js';
import { loadSnapshotFrom } from '../src/format/chromium/indexeddb.js';
import { MemorySource } from '../src/format/chromium/memory-source.js';
import { generateFixture } from './fixture/generate.js';

let dir: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaungast-seam-'));
  generateFixture(dir);
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

// The browser preload equivalent: read every file's bytes into an in-memory Map.
function memSourceFrom(d: string): MemorySource {
  const files = new Map<string, Uint8Array>();
  for (const name of fs.readdirSync(d)) {
    const p = path.join(d, name);
    if (fs.statSync(p).isFile()) files.set(name, fs.readFileSync(p));
  }
  return new MemorySource(files);
}

test('MemorySource (browser path) yields the same Snapshot as loadSnapshot(dir) (Node path)', () => {
  const viaNode = loadSnapshot(dir);
  const viaMemory = loadSnapshotFrom(memSourceFrom(dir));
  expect(viaMemory).toEqual(viaNode);
});
