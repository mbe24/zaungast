// Cohesive analogous accents for the race bars (page 2) and the top-people chart (page 1) — a given rank
// gets the same colour in both. One smooth OKLCH hue sweep along the cool family (blue → lavender → pink,
// hue 200°→345°) while lightness zig-zags pastel/deep every rank, so the sorted list reads as one gradient
// yet any two adjacent ranks stay far apart in lightness (CVD-safe for the contiguous top-people slice).
// Generated from a 4-step lightness/chroma pattern:
//   PATTERN = [ {l:0.86,c:0.095}, {l:0.65,c:0.130}, {l:0.81,c:0.125}, {l:0.605,c:0.110} ]  // pastel-hi / deep-hi / pastel-lo / deep-lo
//   formatHex({ mode:'oklch', ...PATTERN[i%4], h: 200 + i*(345-200)/11 })  for i in 0..11
export const PALETTE = [
	'#7fe4e9', // 0  pale sky-cyan
	'#00a2be', // 1  deep sapphire
	'#57d1ff', // 2  bright sky
	'#388abc', // 3  deep steel blue
	'#a4d5ff', // 4  pale periwinkle
	'#698cde', // 5  deep blue
	'#b0b8ff', // 6  lavender
	'#8475be', // 7  deep violet
	'#e0c1ff', // 8  pale lilac
	'#b074c2', // 9  deep mauve
	'#f0a2e5', // 10 pink
	'#b06591', // 11 deep rose
];
