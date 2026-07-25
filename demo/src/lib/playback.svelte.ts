// Shared playback transport for the animated story pages (race, rhythms). Each page owns its own tick
// loop and mutates `state`; the story bar (in the layout) reads `progress()` and calls `toggle()`, so the
// top bar doubles as the transport control. Replaces the two near-identical race.svelte / rhythm.svelte
// stores. The transition maths live in ./playback.ts (pure + tested); this only adds the reactive shell.
import { progressOf, toggleState, type PlaybackState } from './playback';

export interface Playback {
	readonly state: PlaybackState; // reactive { pos, playing, frames }
	progress: () => number; // 0..1 fraction elapsed
	toggle: () => void; // pause/resume, or restart at the end
	reset: (frames: number) => void; // (re)seed for a dataset: frames set, position 0, playing
}

// `eps` tolerates a fractional position landing just shy of the last frame at the "restart" check.
export function createPlayback(eps = 0): Playback {
	const state = $state<PlaybackState>({ pos: 0, playing: true, frames: 0 });
	return {
		state,
		progress: () => progressOf(state),
		toggle: () => toggleState(state, eps),
		reset: (frames: number) => {
			state.frames = frames;
			state.pos = 0;
			state.playing = true;
		},
	};
}

export const racePlayback = createPlayback(); // integer frame positions (one day per tick)
export const rhythmPlayback = createPlayback(1e-3); // fractional positions (smooth week morph)
