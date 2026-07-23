// Node-only mapping loaders — the fs-touching half of the resolver, split out so the browser-reachable
// resolver.ts (selectMapping/extractEntity/extractRecords) stays fs-free. `loadMapping` reads a
// caller-given path; `loadBundledMappingTexts` returns each bundled mapping's VERBATIM JSON text for the
// native Rust engine (which does its own fingerprint + selectMapping). The text must be byte-exact, so
// it is read from disk here — never reconstructed from the parsed barrel (JSON.stringify would reorder
// keys / drop whitespace and break the native engine's text contract).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Mapping } from './types.js';

export function loadMapping(p: string): Mapping {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// The registry declares the SET + ORDER explicitly (not dir-globbing): the single reviewable source of
// truth, listed newest/most-specific first. src/schema/* is copied to dist/schema/* by the build, so
// this resolves identically in dev and prod.
const VERSIONS_DIR = fileURLToPath(new URL('../schema/versions/', import.meta.url));
const REGISTRY = fileURLToPath(new URL('../schema/mappings.json', import.meta.url));
let mappingFiles: string[] | null = null;
function bundledMappingFiles(): string[] {
  if (!mappingFiles) mappingFiles = JSON.parse(fs.readFileSync(REGISTRY, 'utf8')) as string[];
  return mappingFiles;
}

export function loadBundledMappingTexts(): string[] {
  return bundledMappingFiles().map((f) => fs.readFileSync(path.join(VERSIONS_DIR, f), 'utf8'));
}
