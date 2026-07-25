import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrubPos } from './scrub.ts';

// Mirrors the exact expressions the two pages used before extraction:
//   race:   dragStartIndex - Math.round((dx/width)*total)   → sign -1, round true
//   rhythm: dragStartPos   + (dx/width)*total               → sign +1, round false

test('race (sign -1, round): drag left advances, drag right rewinds', () => {
	// width 100, total 10 → 10px = 1 frame.
	assert.equal(scrubPos(5, -50, 100, 10, -1, true), 10); // drag left 50px → +5 → clamps at 10
	assert.equal(scrubPos(5, +50, 100, 10, -1, true), 0); // drag right 50px → -5 → 0
	assert.equal(scrubPos(5, -20, 100, 10, -1, true), 7); // -1*round(-2) = +2 → 7
});

test('race: matches the original int expression across a sweep', () => {
	const width = 137,
		total = 42,
		start = 20;
	for (let dx = -300; dx <= 300; dx += 7) {
		const expected = Math.max(0, Math.min(total, start - Math.round((dx / width) * total)));
		assert.equal(scrubPos(start, dx, width, total, -1, true), expected, `dx=${dx}`);
	}
});

test('rhythm (sign +1, no round): drag right advances, fractional', () => {
	assert.equal(scrubPos(2, +30, 100, 10, 1, false), 5); // +3.0 → 5
	assert.equal(scrubPos(2, -30, 100, 10, 1, false), 0); // -3.0 → -1 → clamp 0
	assert.equal(scrubPos(2, +15, 100, 10, 1, false), 3.5); // fractional preserved
});

test('rhythm: matches the original fractional expression across a sweep', () => {
	const width = 211,
		total = 30,
		start = 12.3;
	for (let dx = -500; dx <= 500; dx += 13) {
		const expected = Math.max(0, Math.min(total, start + (dx / width) * total));
		assert.equal(scrubPos(start, dx, width, total, 1, false), expected, `dx=${dx}`);
	}
});

test('clamps to [0, total] at both ends', () => {
	assert.equal(scrubPos(0, -9999, 100, 10, 1, false), 0);
	assert.equal(scrubPos(0, +9999, 100, 10, 1, false), 10);
});
