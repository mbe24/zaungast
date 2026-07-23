// Barrel of the bundled schema mappings: static JSON imports of every file in schema/mappings.json, so
// the browser build inlines them (no fs). Order = registry precedence (selectMapping's store-presence
// fallback). Keep in sync with mappings.json + versions/ — test/bundled-mappings.unit.ts fails if the
// set, order, or content diverges from the on-disk registry. Adding a mapping: drop the JSON in
// versions/, add a line to mappings.json, add the matching import + array entry here.
import teamsV1 from './versions/teams.v1.json' with { type: 'json' };
import type { Mapping } from '../format/types.js';

export const bundledMappingNames: readonly string[] = ['teams.v1.json'];
export const bundledMappings: Mapping[] = [teamsV1 as unknown as Mapping];
