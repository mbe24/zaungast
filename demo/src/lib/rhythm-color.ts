// Colour pipeline for the rhythm canvas. Precomputes a lookup table so the per-pixel hot loop is just an
// array index — no colour math per pixel. Blend: hue = chat-blue ↔ meeting-maroon by their relative
// amount, interpolated in OKLCH (so the balanced midpoint is a real purple, not mud); intensity ramps
// from the surface up to that hue, interpolated in OKLab. Colours from @catppuccin/palette (Frappé).
import { interpolate, rgb } from 'culori';
import { flavors } from '@catppuccin/palette';

const F = flavors.frappe.colors;
export const CHAT = F.blue.hex; // chat (A)
export const MEET = F.maroon.hex; // meetings (B)
export const BOTH = F.mauve.hex; // the balanced-mix purple (caption swatch)
// Ramp starts AT the empty colour so the scale is continuous through zero — no hard step between
// "faint" and "empty" (that step was the sharp data↔no-data edge). Gamma still lifts faint activity.
const RAMP0 = F.surface0.hex; // zero-intensity end of the ramp (== empty)
const EMPTY = F.surface0.hex; // a truly-empty slot
const GAMMA = 0.65; // intensity emphasis

const R_STEPS = 64; // ratio (chat↔meeting) resolution
const T_STEPS = 64; // intensity resolution

const to255 = (c: { r: number; g: number; b: number }): [number, number, number] => [
	Math.round(Math.max(0, Math.min(1, c.r)) * 255),
	Math.round(Math.max(0, Math.min(1, c.g)) * 255),
	Math.round(Math.max(0, Math.min(1, c.b)) * 255),
];

// LUT[(ri * T_STEPS + ti) * 3 + {0,1,2}] = r/g/b (0..255).
const LUT = (() => {
	const lut = new Uint8ClampedArray(R_STEPS * T_STEPS * 3);
	const hueRamp = interpolate([CHAT, MEET], 'oklch'); // ratio 0 = chat, 1 = meetings
	for (let ri = 0; ri < R_STEPS; ri++) {
		const hue = hueRamp(ri / (R_STEPS - 1));
		const ramp = interpolate([RAMP0, hue], 'oklab'); // intensity 0 = surface, 1 = full hue
		for (let ti = 0; ti < T_STEPS; ti++) {
			const [r, g, b] = to255(rgb(ramp(ti / (T_STEPS - 1))));
			const o = (ri * T_STEPS + ti) * 3;
			lut[o] = r;
			lut[o + 1] = g;
			lut[o + 2] = b;
		}
	}
	return lut;
})();

const EMPTY_RGB = to255(rgb(EMPTY));

// Normalized chat/meeting amounts (each already 0..1) → [r,g,b]. Empty (both 0) → the surface colour.
export function colorRGB(aN: number, bN: number): [number, number, number] {
	const sum = aN + bN;
	if (sum <= 0) return EMPTY_RGB;
	const ri = Math.min(R_STEPS - 1, Math.round((bN / sum) * (R_STEPS - 1)));
	const ti = Math.min(T_STEPS - 1, Math.round(Math.pow(Math.max(aN, bN), GAMMA) * (T_STEPS - 1)));
	const o = (ri * T_STEPS + ti) * 3;
	return [LUT[o], LUT[o + 1], LUT[o + 2]];
}
