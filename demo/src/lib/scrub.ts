// Shared "grab the chart and slide it to scrub time" behaviour for the animated pages. A real drag
// (pointer moved past a small jitter threshold) pauses playback while dragging and resumes only if it was
// playing; a click (no drag) toggles play/pause. Extracted verbatim from the two copies on the race and
// rhythm pages — the only differences are the drag DIRECTION and integer-vs-fractional position, captured
// by `sign` and `round`. The position maths (scrubPos) are pure + unit-tested.
import type { Action } from 'svelte/action';
import type { Playback } from './playback.svelte';

const JITTER = 4; // px of movement tolerated before a press counts as a drag (so a click isn't a scrub)

// Pure: map a pointer drag to a clamped playback position.
//   startPos — position when the drag began; dx — horizontal px moved; width — element width;
//   total — the max position (frames-1, ≥1); sign — +1 if dragging right advances time, -1 if left;
//   round — snap to whole frames (the race) vs keep fractional (the rhythm morph).
export function scrubPos(
	startPos: number,
	dx: number,
	width: number,
	total: number,
	sign: 1 | -1,
	round: boolean,
): number {
	const delta = (dx / width) * total;
	const np = startPos + sign * (round ? Math.round(delta) : delta);
	return Math.max(0, Math.min(total, np));
}

export interface ScrubParams {
	playback: Playback; // read/written position + playing; toggled on a plain click
	sign: 1 | -1; // +1: drag right → forward (rhythm); -1: drag left → forward (race)
	round: boolean; // whole-frame positions (race) vs fractional (rhythm)
}

export const scrub: Action<HTMLElement, ScrubParams> = (node, params) => {
	let p = params;
	let dragging = false;
	let dragMoved = false;
	let dragWasPlaying = false;
	let startX = 0;
	let startPos = 0;
	let width = 1;

	const down = (e: PointerEvent) => {
		dragging = true;
		dragMoved = false;
		dragWasPlaying = p.playback.state.playing;
		startX = e.clientX;
		startPos = p.playback.state.pos;
		width = node.clientWidth || 1;
		node.setPointerCapture(e.pointerId);
	};
	const move = (e: PointerEvent) => {
		if (!dragging) return;
		const dx = e.clientX - startX;
		if (!dragMoved && Math.abs(dx) < JITTER) return; // tolerate jitter so a click isn't read as a drag
		if (!dragMoved) {
			dragMoved = true;
			p.playback.state.playing = false; // first real movement → yield control
		}
		const total = Math.max(1, p.playback.state.frames - 1);
		p.playback.state.pos = scrubPos(startPos, dx, width, total, p.sign, p.round);
	};
	const up = (e: PointerEvent) => {
		if (!dragging) return;
		dragging = false;
		node.releasePointerCapture?.(e.pointerId);
		if (dragMoved) {
			if (dragWasPlaying) p.playback.state.playing = true; // resume after a scrub
		} else {
			p.playback.toggle(); // a click (no drag) pauses / resumes (restarts at the end)
		}
	};

	node.addEventListener('pointerdown', down);
	node.addEventListener('pointermove', move);
	node.addEventListener('pointerup', up);
	node.addEventListener('pointercancel', up);
	return {
		update(next: ScrubParams) {
			p = next;
		},
		destroy() {
			node.removeEventListener('pointerdown', down);
			node.removeEventListener('pointermove', move);
			node.removeEventListener('pointerup', up);
			node.removeEventListener('pointercancel', up);
		},
	};
};
