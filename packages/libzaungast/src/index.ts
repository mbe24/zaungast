// libzaungast public barrel (B0: permissive). B3 narrows this to the intended data API and hides
// the Chromium byte readers + SQLite handle. For now consumers (incl. the zaungast MCP) mostly
// import specific subpaths (libzaungast/query.js, libzaungast/session.js, …); this barrel just
// gathers the main surface for `import { … } from 'libzaungast'`.
export * from './query.js';
export * from './format/index.js';
export { Session } from './session.js';
export { ingest, applyIncremental } from './ingest/ingest.js';
export type { IngestState } from './ingest/ingest.js';
export { ChatStore, isBotMri } from './ingest/store.js';
export type { StoreMeta } from './ingest/store.js';
