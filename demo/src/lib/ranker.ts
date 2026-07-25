// Stateful bar-chart-race ordering with hysteresis. Carries the previous frame's order across ticks so
// near-ties don't swap places on daily noise: a challenger only overtakes a neighbour once it leads by
// `margin` × the larger of the two — RELATIVE to the pair (not the global peak), so small values still
// order correctly (4 beats 2) while genuine near-ties at any scale stay put. Extracted from an inline
// mutation inside the race page's $derived so the statefulness is explicit, named, and unit-testable.
// Construct one ranker per race (its memory resets with the component) and call order() each frame.

export interface RankItem {
	name: string;
	value: number;
}

export class HysteresisRanker {
	private prevOrder: string[] = [];

	// `margin` — the relative lead a challenger needs to overtake a neighbour (e.g. 0.15 = 15%).
	constructor(private readonly margin: number) {}

	// Returns the names ordered for this frame; within the margin the comparator returns 0, so the JS
	// stable sort keeps the prior order (that's the hysteresis). Mutates internal state for the next call.
	order(items: RankItem[]): string[] {
		const val = new Map(items.map((i) => [i.name, i.value]));
		// Seed with last frame's order (dropping anyone gone), then append newcomers — keeps order stable.
		const names = this.prevOrder.filter((n) => val.has(n));
		for (const i of items) if (!names.includes(i.name)) names.push(i.name);
		names.sort((a, b) => {
			const va = val.get(a) ?? 0;
			const vb = val.get(b) ?? 0;
			return Math.abs(vb - va) < Math.max(va, vb, 1) * this.margin ? 0 : vb - va;
		});
		this.prevOrder = names;
		return names;
	}
}
