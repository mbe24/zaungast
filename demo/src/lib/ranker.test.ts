import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HysteresisRanker, type RankItem } from './ranker.ts';

// Reference: the EXACT logic that lived inline in race/+page.svelte before extraction. The
// characterization test below asserts the extracted ranker reproduces this frame-for-frame, and locks it
// against future drift.
function refOrder(prevOrder: string[], items: RankItem[], margin: number): string[] {
	const val = new Map(items.map((i) => [i.name, i.value]));
	const names = prevOrder.filter((n) => val.has(n));
	for (const i of items) if (!names.includes(i.name)) names.push(i.name);
	names.sort((a, b) => {
		const va = val.get(a) ?? 0;
		const vb = val.get(b) ?? 0;
		return Math.abs(vb - va) < Math.max(va, vb, 1) * margin ? 0 : vb - va;
	});
	return names;
}

// Deterministic PRNG (no Math.random, so runs are reproducible).
function lcg(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 0x100000000;
	};
}

test('characterization: ranker matches the old inline logic frame-for-frame', () => {
	const margin = 0.15;
	const people = Array.from({ length: 12 }, (_, i) => `p${i}`);
	const ranker = new HysteresisRanker(margin);
	let refPrev: string[] = [];
	const rand = lcg(42);

	for (let frame = 0; frame < 400; frame++) {
		// Volatile values, incl. exact ties and zeros, to exercise the margin comparator hard.
		const items: RankItem[] = people.map((name) => ({
			name,
			value: Math.floor(rand() * 20), // 0..19, integers → guaranteed ties
		}));
		const got = ranker.order(items);
		const want = refOrder(refPrev, items, margin);
		refPrev = want;
		assert.deepEqual(got, want, `frame ${frame}`);
	}
});

test('hysteresis: a near-tie does NOT reorder', () => {
	const r = new HysteresisRanker(0.15);
	r.order([{ name: 'A', value: 10 }, { name: 'B', value: 8 }]); // A leads → [A, B]
	// B nudges just ahead by 0.5 (< 0.15 * 10.5) → within margin → order held.
	assert.deepEqual(r.order([{ name: 'A', value: 10 }, { name: 'B', value: 10.5 }]), ['A', 'B']);
});

test('hysteresis: a decisive lead DOES overtake', () => {
	const r = new HysteresisRanker(0.15);
	r.order([{ name: 'A', value: 10 }, { name: 'B', value: 8 }]); // [A, B]
	// B jumps to 13 vs A 10 → |3| > 0.15*13 (1.95) → B overtakes.
	assert.deepEqual(r.order([{ name: 'A', value: 10 }, { name: 'B', value: 13 }]), ['B', 'A']);
});

test('newcomers are appended after the carried order', () => {
	const r = new HysteresisRanker(0.15);
	r.order([{ name: 'A', value: 5 }, { name: 'B', value: 4 }]); // [A, B]
	// C appears; with a small value it sorts to the back, but membership seeding keeps A,B stable.
	const out = r.order([
		{ name: 'A', value: 5 },
		{ name: 'B', value: 4 },
		{ name: 'C', value: 1 },
	]);
	assert.deepEqual(out, ['A', 'B', 'C']);
});

test('a departed name is dropped from the carried order', () => {
	const r = new HysteresisRanker(0.15);
	r.order([{ name: 'A', value: 5 }, { name: 'B', value: 4 }]);
	assert.deepEqual(r.order([{ name: 'A', value: 5 }]), ['A']);
});
