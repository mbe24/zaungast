import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nf, fmtDate, fmtDateTime, abbrev } from './format.ts';

test('nf groups thousands (locale-independent digit check)', () => {
	// Grouping character varies by locale; assert the digits survive and length grew (a separator exists).
	const out = nf.format(1234567);
	assert.equal(out.replace(/\D/g, ''), '1234567');
	assert.ok(out.length > 7);
});

test('fmtDate: empty fallback', () => {
	assert.equal(fmtDate(0), '—');
	assert.equal(fmtDate(-1), '—');
	assert.equal(fmtDate(0, ''), ''); // race/rhythms use an empty string
	assert.equal(fmtDate(NaN), '—');
});

test('fmtDate: renders a date for a real timestamp', () => {
	const ms = Date.UTC(2026, 5, 26, 12, 0, 0);
	assert.equal(fmtDate(ms), new Date(ms).toLocaleDateString());
});

test('fmtDateTime: empty fallback + real value', () => {
	assert.equal(fmtDateTime(0), '—');
	assert.equal(fmtDateTime(0, ''), '');
	const ms = Date.UTC(2026, 0, 2, 3, 4, 5);
	assert.equal(fmtDateTime(ms), new Date(ms).toLocaleString());
});

test('abbrev: surname → initials, keeping compound parts', () => {
	assert.equal(abbrev('Lovelace'), 'L.');
	assert.equal(abbrev('de Lovelace'), 'd. L.'); // compound surname → each part, case preserved
	assert.equal(abbrev('von der Berg'), 'v. d. B.');
	assert.equal(abbrev(''), ''); // no surname → empty
});
