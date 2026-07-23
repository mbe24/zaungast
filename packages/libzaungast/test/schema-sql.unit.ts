// Drift guard: the generated SCHEMA_SQL constant must equal the single-source schema.sql on disk.
// schema.sql is what the native Rust engine execs verbatim; schema-sql.ts is the browser-bundleable copy
// (no fs read). Edit schema.sql without regenerating (`npm run gen:schema-sql --workspace libzaungast`)
// and this fails. Node-only (reads fs) — not in the A8 browser project.
import { test, expect } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SCHEMA_SQL } from '../src/ingest/schema-sql.js';

test('SCHEMA_SQL matches the single-source schema.sql', () => {
  const onDisk = fs.readFileSync(
    fileURLToPath(new URL('../src/schema.sql', import.meta.url)),
    'utf8',
  );
  expect(SCHEMA_SQL).toBe(onDisk);
});
