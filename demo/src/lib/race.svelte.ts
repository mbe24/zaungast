// Shared bar-chart-race playback state. The race page owns the tick loop; the story bar (in the layout)
// reads progress and drives play/pause/restart — so the top bar doubles as the transport control.
export const race = $state<{ weekIndex: number; playing: boolean; weeks: number }>({
	weekIndex: 0,
	playing: true,
	weeks: 0,
});

// 0..1 fraction of the timeline elapsed (drives the story bar's fill).
export const raceProgress = (): number =>
	race.weeks > 1 ? race.weekIndex / (race.weeks - 1) : race.weeks ? 1 : 0;

// Click behaviour: at the end → restart; otherwise pause/resume.
export function toggleRace(): void {
	if (race.weeks && race.weekIndex >= race.weeks - 1) {
		race.weekIndex = 0;
		race.playing = true;
	} else {
		race.playing = !race.playing;
	}
}
