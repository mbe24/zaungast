import { proposeSchema, type ProposedStore } from 'libzaungast/format';
import type { Snapshot } from 'libzaungast/format/engine';
import { describeSchemaShape } from '../schemas.js';
import type { RawTool } from './types.js';

// Propose-only schema recovery: when a Teams update changes the DB layout (unknown fingerprint),
// sample the raw stores and PROPOSE a field mapping for a human to verify and save as
// src/schema/versions/teams-<ver>.json. NEVER applies anything itself.
//
// The proposal ALGORITHM (structural walk, db-name normalization, candidate matching, scoring,
// proposal assembly) is library-side in `proposeSchema` (schema/domain knowledge — see
// format/propose.ts). This module is the MCP PRESENTATION: it renders the proposal as text.

// Fields any proposal might reference are pinned to the FRONT of the printed list so a
// truncation can never hide exactly the paths the proposal maps (that's what made the old
// output read as "you mapped fields that don't exist").
function showFields(set: Set<string>, interest: Set<string>): string {
  const arr = [...set];
  return (
    [...arr.filter((f) => interest.has(f)), ...arr.filter((f) => !interest.has(f))]
      .slice(0, 24)
      .join(', ') || '(none decoded)'
  );
}

// Render the "Top data stores (by record count):" section, one entry per store (record-level
// fields, plus — when a message-map container was found — the nested per-entry fields too).
function renderStoreList(all: ProposedStore[], limit: number, interest: Set<string>): string[] {
  const lines: string[] = [];
  for (const s of all.slice(0, limit)) {
    lines.push(`  ${s.store} (${s.dbNorm})  ${s.count} recs`);
    if (s.nestedUnder) {
      // Show BOTH levels, labeled — the proposal's iterate/keep reference the record level while
      // content/sender/time live in the nested entries; a verifier needs to see where each lives.
      lines.push(
        `     record fields: ${showFields(s.fields, interest)}`,
        `     per ${s.nestedUnder}.* entry: ${showFields(s.nested!, interest)}`,
      );
    } else {
      lines.push(`     fields: ${showFields(s.fields, interest)}`);
    }
  }
  return lines;
}

export function describeSchema(snap: Snapshot, args: any = {}): string {
  const p = proposeSchema(snap);
  const lines: string[] = [];
  lines.push(
    `fingerprint ${p.fingerprint} · ${p.dbCount} databases · ${p.stores.length} data stores`,
  );
  lines.push('', 'Top data stores (by record count):');
  lines.push(...renderStoreList(p.stores, Number(args.limit) || 20, p.interest));

  lines.push(
    '',
    'PROPOSED mapping (VERIFY before saving to src/schema/versions/teams-<ver>.json):',
    JSON.stringify(p.proposal, null, 2),
    '',
    'This is a proposal only — nothing was applied. Confirm the field paths against real records, then add the file and restart.',
  );
  return lines.join('\n');
}

export const describeSchemaTool: RawTool = {
  kind: 'raw',
  name: 'describe_schema',
  title: 'Describe / recover schema',
  description: `Inspect the raw Teams IndexedDB stores and PROPOSE a field mapping. Use when tools report the schema is unrecognized (after a Teams update), or to inspect the DB structure. Proposes only — applies nothing; a human verifies the proposal and saves it as a new schema version.`,
  inputSchema: describeSchemaShape,
  run: describeSchema,
};
