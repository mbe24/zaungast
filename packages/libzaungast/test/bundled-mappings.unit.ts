// Drift guard for the hand-maintained bundled-mappings.ts barrel: it must exactly mirror the on-disk
// registry (schema/mappings.json) + version files. The barrel is what the browser build bundles, so a
// mismatch (a version added to versions/ + mappings.json but not the barrel, or vice versa) would ship
// stale/missing mappings to the browser with no other signal. Node-only (reads fs) — not in the A8
// browser project.
import { test, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundledMappings, bundledMappingNames } from '../src/schema/bundled-mappings.js';

const SCHEMA = fileURLToPath(new URL('../src/schema/', import.meta.url));
const registry = JSON.parse(
  fs.readFileSync(path.join(SCHEMA, 'mappings.json'), 'utf8'),
) as string[];

test('barrel names match the registry (set + order)', () => {
  expect([...bundledMappingNames]).toEqual(registry);
});

test('barrel content matches the on-disk version files', () => {
  const onDisk = registry.map((f) =>
    JSON.parse(fs.readFileSync(path.join(SCHEMA, 'versions', f), 'utf8')),
  );
  expect(bundledMappings).toEqual(onDisk);
});
