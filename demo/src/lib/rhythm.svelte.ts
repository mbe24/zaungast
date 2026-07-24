// Shared playback state for the weekly-rhythm heatmap (page 3). Mirrors race.svelte.ts but on a
// WEEKLY timeline (rhythmWeeks), independent of the race's daily one. The page owns the tick loop; the
// story bar (in the layout) reads progress and drives play/pause/restart.
export const rhythm = $state<{ weekIndex: number; playing: boolean; weeks: number }>({
	weekIndex: 0,
	playing: true,
	weeks: 0,
});

// 0..1 fraction of the timeline elapsed (drives the story bar's fill).
export const rhythmProgress = (): number =>
	rhythm.weeks > 1 ? rhythm.weekIndex / (rhythm.weeks - 1) : rhythm.weeks ? 1 : 0;

// Click behaviour: at the end → restart; otherwise pause/resume.
export function toggleRhythm(): void {
	if (rhythm.weeks && rhythm.weekIndex >= rhythm.weeks - 1) {
		rhythm.weekIndex = 0;
		rhythm.playing = true;
	} else {
		rhythm.playing = !rhythm.playing;
	}
}
