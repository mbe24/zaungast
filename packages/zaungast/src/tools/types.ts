import type { StoreReading } from 'libzaungast';
import type { Snapshot } from 'libzaungast/format/engine';

// Render context: the ambient values the presentation layer used to read implicitly (the process
// timezone + the wall clock). Threading them explicitly makes rendering a pure function of its inputs
// — the server resolves them once per dispatch, and tests pass a fixed ctx for deterministic output.
//   tz  — IANA zone for local-time formatting (e.g. 'Europe/Berlin', 'UTC').
//   now — epoch ms treated as "now" for relative time windows + fmtTs year-elision.
export interface RenderCtx {
  tz: string;
  now: number;
}

// Tool descriptors: the registry entries server.ts loops over. `inputSchema` is the Zod raw-shape
// object from schemas.ts (typed `any` here). A `query` tool renders a pinned StoreReading; a `raw`
// tool (describe_schema) renders a raw Snapshot with no schemaMatched gate.
export interface QueryTool {
  kind: 'query';
  name: string;
  title: string;
  description: string;
  inputSchema: any;
  run(view: StoreReading, args: any, ctx: RenderCtx): string;
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
