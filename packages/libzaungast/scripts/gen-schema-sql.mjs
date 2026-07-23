// Generate src/ingest/schema-sql.ts (the SCHEMA_SQL string constant) from the single-source schema.sql,
// so the browser build can bundle the DDL with no fs read. schema.sql stays the one source of truth —
// the native Rust engine execs it verbatim, and this generated module is drift-guarded against it by
// test/schema-sql.unit.ts. Run when schema.sql changes: `npm run gen:schema-sql --workspace libzaungast`
// (a standalone step, NOT folded into copy-schema.mjs, which runs after tsc — this file must exist
// before tsc so it gets compiled). Committed output; prettier may reformat it (the drift test compares
// the VALUE, not the file bytes).
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const pkg = fileURLToPath(new URL('..', import.meta.url)); // packages/libzaungast/
const sql = fs.readFileSync(`${pkg}src/schema.sql`, 'utf8');
const out = `${pkg}src/ingest/schema-sql.ts`;

const content =
  `// GENERATED from src/schema.sql by scripts/gen-schema-sql.mjs — DO NOT EDIT BY HAND.\n` +
  `// Regenerate: \`npm run gen:schema-sql --workspace libzaungast\`. Drift-guarded by test/schema-sql.unit.ts.\n` +
  `// Lets the browser build bundle the DDL (no fs). schema.sql stays the single source the native engine execs.\n` +
  `export const SCHEMA_SQL = ${JSON.stringify(sql)};\n`;

fs.writeFileSync(out, content);
console.log(`wrote ${out} (${sql.length} chars of DDL)`);
