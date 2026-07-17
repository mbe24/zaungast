import type { StoreReading } from 'libzaungast';
import type { Snapshot } from 'libzaungast/format/engine';

// Tool descriptors: the registry entries server.ts loops over. `inputSchema` is the Zod raw-shape
// object from schemas.ts (typed `any` here). A `query` tool renders a pinned StoreReading; a `raw`
// tool (describe_schema) renders a raw Snapshot with no schemaMatched gate.
export interface QueryTool {
  kind: 'query';
  name: string;
  title: string;
  description: string;
  inputSchema: any;
  run(view: StoreReading, args: any): string;
}
export interface RawTool {
  kind: 'raw';
  name: string;
  title: string;
  description: string;
  inputSchema: any;
  run(snap: Snapshot, args: any): string;
}
export type Tool = QueryTool | RawTool;
