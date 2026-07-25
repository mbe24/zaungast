import { test } from 'node:test';
import assert from 'node:assert/strict';
import { progressOf, toggleState, type PlaybackState } from './playback.ts';

test('progressOf: fraction across the frame axis', () => {
	assert.equal(progressOf({ pos: 0, frames: 11 }), 0);
	assert.equal(progressOf({ pos: 5, frames: 11 }), 0.5);
	assert.equal(progressOf({ pos: 10, frames: 11 }), 1);
});

test('progressOf: degenerate frame counts', () => {
	assert.equal(progressOf({ pos: 0, frames: 0 }), 0); // no data
	assert.equal(progressOf({ pos: 0, frames: 1 }), 1); // single frame → full
});

test('toggleState (race, eps=0): pause/resume mid-timeline', () => {
	const s: PlaybackState = { pos: 3, playing: true, frames: 10 };
	toggleState(s);
	assert.deepEqual(s, { pos: 3, playing: false, frames: 10 });
	toggleState(s);
	assert.deepEqual(s, { pos: 3, playing: true, frames: 10 });
});

test('toggleState (race, eps=0): restart at the last frame', () => {
	const s: PlaybackState = { pos: 9, playing: false, frames: 10 };
	toggleState(s);
	assert.deepEqual(s, { pos: 0, playing: true, frames: 10 });
});

test('toggleState: no-op restart guard when frames=0', () => {
	const s: PlaybackState = { pos: 0, playing: true, frames: 0 };
	toggleState(s);
	// frames falsy → falls to the else branch → toggles playing, never "restarts".
	assert.deepEqual(s, { pos: 0, playing: false, frames: 0 });
});

test('toggleState (rhythm, eps=1e-3): fractional position just shy of the end restarts', () => {
	const s: PlaybackState = { pos: 9 - 1e-4, playing: false, frames: 10 };
	toggleState(s, 1e-3);
	assert.deepEqual(s, { pos: 0, playing: true, frames: 10 });
});

test('toggleState (rhythm, eps=1e-3): mid-timeline still pauses/resumes', () => {
	const s: PlaybackState = { pos: 4.5, playing: true, frames: 10 };
	toggleState(s, 1e-3);
	assert.equal(s.playing, false);
	assert.equal(s.pos, 4.5);
});
