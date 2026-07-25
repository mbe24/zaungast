// Shared playback state for the weekly-rhythm heatmap (page 3). The canvas owns a requestAnimationFrame
// clock and advances `pos` — a FRACTIONAL week index — so the morph, autoplay and drag-scrub are all the
// same thing (a position on the week axis). The story bar (in the layout) reads progress + toggles play.
export const rhythm = $state<{ pos: number; playing: boolean; weeks: number }>({
	pos: 0,
	playing: true,
	weeks: 0,
});

// 0..1 fraction of the timeline elapsed (drives the story bar's fill).
export const rhythmProgress = (): number =>
	rhythm.weeks > 1 ? rhythm.pos / (rhythm.weeks - 1) : rhythm.weeks ? 1 : 0;

// Click behaviour: at the end → restart; otherwise pause/resume.
export function toggleRhythm(): void {
	if (rhythm.weeks && rhythm.pos >= rhythm.weeks - 1 - 1e-3) {
		rhythm.pos = 0;
		rhythm.playing = true;
	} else {
		rhythm.playing = !rhythm.playing;
	}
}
