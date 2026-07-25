// Pure playback-transition logic (no runes) so it's unit-testable in isolation. A playback position is a
// point on a frame axis [0, frames-1]: the race steps it in whole frames (days), the rhythm heatmap moves
// it fractionally (smooth morph) — hence the epsilon in toggle(). See createPlayback in playback.svelte.ts
// for the reactive wrapper the pages actually use.

export interface PlaybackState {
	pos: number; // current position on the frame axis (integer for the race, fractional for rhythms)
	playing: boolean;
	frames: number; // total frames; playback spans [0, frames-1]
}

// 0..1 fraction of the timeline elapsed (drives the story-bar fill).
export const progressOf = (s: Pick<PlaybackState, 'pos' | 'frames'>): number =>
	s.frames > 1 ? s.pos / (s.frames - 1) : s.frames ? 1 : 0;

// Click behaviour: at the end → restart; otherwise pause/resume. `eps` tolerates a fractional position
// landing just shy of the last frame (rhythm uses 1e-3); it's a no-op for integer positions (the race).
export function toggleState(s: PlaybackState, eps = 0): void {
	if (s.frames && s.pos >= s.frames - 1 - eps) {
		s.pos = 0;
		s.playing = true;
	} else {
		s.playing = !s.playing;
	}
}
