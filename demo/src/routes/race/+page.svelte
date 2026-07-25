<script lang="ts">
	import { onMount } from 'svelte';
	import * as Card from '$lib/components/ui/card';
	import Chart from '$lib/components/Chart.svelte';
	import NoData from '$lib/components/NoData.svelte';
	import * as Plot from '@observablehq/plot';
	import { app } from '$lib/app.svelte';
	import { racePlayback } from '$lib/playback.svelte';
	import { PALETTE } from '$lib/palette';
	import { nf, fmtDate } from '$lib/format';
	import { scrub } from '$lib/scrub';
	import { plotStyle, type PlotOptions } from '$lib/plot';
	import { HysteresisRanker } from '$lib/ranker';

	const pb = racePlayback; // { state: { pos, playing, frames }, progress, toggle, reset }

	const DAY = 86_400_000;
	const WINDOW = 35; // trailing days (~5 weeks) — smooths bursts/vacations (bigger = calmer, more sustained)
	const VOL_WINDOW = 182 * DAY; // ~6-month visible window for the volume chart; it scrolls with time
	const TICK_MS = 90; // one day per tick — fine steps keep both charts moving smoothly, without over-updating

	const fmtDay = (ms: number) => fmtDate(ms, ''); // race labels use an empty fallback, not "—"

	// Rolling window sum — messages in the trailing WINDOW days (a whole count, so the label matches the
	// bar). Activity AT that time, not an all-time total, so bars rise and fall as who you talk to shifts.
	const rolling = (daily: number[]): number[] =>
		daily.map((_, i) => {
			let s = 0;
			for (let k = Math.max(0, i - WINDOW + 1); k <= i; k++) s += daily[k];
			return s;
		});

	const data = $derived(app.data);
	const days = $derived(data?.raceDays ?? []);

	// Start/reset the race whenever this page mounts. (pos = current frame; frames = day count.)
	onMount(() => pb.reset(days.length));

	// Playback loop: one day per tick; stop at the end (the story bar restarts/pauses).
	$effect(() => {
		if (!pb.state.playing || pb.state.frames < 2) return;
		const id = setInterval(() => {
			if (pb.state.pos >= pb.state.frames - 1) pb.state.playing = false;
			else pb.state.pos++;
		}, TICK_MS);
		return () => clearInterval(id);
	});

	const curDay = $derived(days[Math.min(pb.state.pos, Math.max(0, days.length - 1))] ?? 0);

	// Per-person rolling daily rate (precomputed once per dataset), stable colour by rank.
	const series = $derived(
		(data?.racePeople ?? []).map((p, i) => ({
			key: p.key, // MRI — stable identity (same-named people don't merge)
			label: p.label,
			color: PALETTE[i % PALETTE.length],
			roll: rolling(p.daily),
		})),
	);

	const ROWS = 10; // visible slots
	const ROW_REM = 2.5; // vertical pitch per row (rem)
	// Stable bar ordering: a challenger must lead a neighbour by 15% (of the larger) to overtake it, so
	// daily noise doesn't make near-ties flicker. State + logic live in the ranker (see ranker.ts).
	const ranker = new HysteresisRanker(0.15);

	// One entry PER TRACKED PERSON, in a STABLE order (never reordered in the DOM). Each carries its
	// current rank; the template positions rows by transform:translateY(rank·pitch) and animates only the
	// transform — so a reorder glides on the compositor, immune to the volume chart's reflows (no flip).
	const rows = $derived.by(() => {
		const upto = Math.min(pb.state.pos, days.length - 1);
		const items = series.map((s) => ({ id: s.key, value: s.roll[upto] ?? 0 }));
		const val = new Map(items.map((i) => [i.id, i.value]));
		// Scale bars to the CURRENT frame's leader, not the all-time peak — so the chart stays full and
		// "who's on top now" is legible; the volume chart below carries the absolute magnitude.
		const frameMax = Math.max(1, ...val.values());
		const order = ranker.order(items); // hysteresis ordering (stable within the margin), by key
		const rank = new Map<string, number>();
		let r = 0;
		for (const id of order) if ((val.get(id) ?? 0) > 0 && r < ROWS) rank.set(id, r++);
		// Emit in series' fixed order so the #each never reorders the DOM.
		return series.map((s) => {
			const value = val.get(s.key) ?? 0;
			const rk = rank.get(s.key) ?? -1;
			return {
				key: s.key,
				label: s.label,
				color: s.color,
				value,
				pct: (Math.sqrt(value) / Math.sqrt(frameMax)) * 100,
				rank: rk,
				slot: rk < 0 ? ROWS : rk, // parked just below the stage when out of the top 10
			};
		});
	});

	const VOL_SMOOTH = 7; // days; a multiple of 7 so the weekday/weekend cycle cancels out exactly
	// Total messages/day (to + from you), aligned to the race days, then a trailing 7-day mean so the
	// weekend dip doesn't show as a sawtooth (trailing, not centred, so the curve never anticipates).
	const perDay = $derived.by(() => {
		const map = new Map<number, number>();
		for (const d of data?.messagesPerDay ?? []) {
			const day = Math.floor(d.date / DAY) * DAY;
			map.set(day, (map.get(day) ?? 0) + d.count);
		}
		const raw = days.map((d) => map.get(d) ?? 0);
		return days.map((d, i) => {
			const lo = Math.max(0, i - VOL_SMOOTH + 1);
			let s = 0;
			for (let k = lo; k <= i; k++) s += raw[k];
			return { day: new Date(d), count: s / (i - lo + 1) };
		});
	});

	const base_style = plotStyle(14);

	/* eslint-disable @typescript-eslint/no-explicit-any */
	const curve = $derived.by(() => {
		if (!perDay.length) return null;
		const upto = Math.min(pb.state.pos, perDay.length - 1);
		const shown = perDay.slice(0, upto + 1); // reveal the curve up to the current day
		const yMax = Math.max(1, ...perDay.map((d) => d.count));
		const first = perDay[0].day.getTime();
		const last = perDay[perDay.length - 1].day.getTime();
		const cur = perDay[upto].day.getTime();
		// A ~6-month window that keeps the drawing point roughly centred, clamped at the ends — so it
		// starts against the left border and finishes against the right border.
		const wide = last - first > VOL_WINDOW;
		const winStart = wide
			? Math.min(Math.max(cur - VOL_WINDOW / 2, first), last - VOL_WINDOW)
			: first;
		const winEnd = wide ? winStart + VOL_WINDOW : last;
		return {
			height: 200,
			marginLeft: 44,
			marginTop: 30,
			marginBottom: 40,
			style: base_style,
			x: { label: null, domain: [new Date(winStart), new Date(winEnd)] },
			y: { label: 'messages / day', grid: true, domain: [0, yMax] },
			marks: [
				Plot.areaY(shown, { x: 'day', y: 'count', fill: 'var(--chart-1)', fillOpacity: 0.18, curve: 'monotone-x', clip: true }),
				Plot.lineY(shown, { x: 'day', y: 'count', stroke: 'var(--chart-1)', strokeWidth: 2.5, curve: 'monotone-x', clip: true }),
				Plot.ruleY([0]),
			],
		} as PlotOptions;
	});
	/* eslint-enable @typescript-eslint/no-explicit-any */
</script>

{#if !data}
	<NoData />
{:else}
	<Card.Root>
		<Card.Header>
			<div class="flex flex-wrap items-center justify-between gap-3">
				<div>
					<Card.Title>Top people over time</Card.Title>
					<Card.Description>
						Who you're writing with most at each point in time (1:1 messages in a rolling {WINDOW}-day
						window) — tap the top bar to pause / restart
					</Card.Description>
				</div>
				<span class="font-heading text-2xl tabular-nums">{fmtDay(curDay)}</span>
			</div>
		</Card.Header>
		<Card.Content>
			<!-- Fixed-height stage. Rows keep a stable DOM order and are placed by transform:translateY;
			     only the transform (and width/opacity) animate, so reorders glide on the compositor — no
			     DOM reordering, no flip, immune to the volume chart's per-tick reflows. -->
			<!-- Click anywhere on the bars to pause / resume (like the volume chart + the story bar). -->
			<div
				class="relative cursor-pointer"
				style="height: {ROWS * ROW_REM}rem"
				role="button"
				tabindex="0"
				aria-label="Pause or resume the race"
				onclick={() => pb.toggle()}
				onkeydown={(e) => {
					if (e.key === 'Enter' || e.key === ' ') {
						e.preventDefault();
						pb.toggle();
					}
				}}
			>
				{#each rows as p (p.key)}
					<div
						class="absolute inset-x-0 flex items-center gap-3 transition-[transform,opacity] duration-500 ease-in-out"
						style="height: {ROW_REM}rem; transform: translateY({p.slot * ROW_REM}rem); opacity: {p.rank <
						0
							? 0
							: 1}"
					>
						<div class="text-muted-foreground w-28 shrink-0 truncate text-right text-sm">
							{p.label}
						</div>
						<div class="min-w-0 flex-1">
							<div
								class="h-7 rounded-md transition-[width] duration-500 ease-out"
								style="width: {p.pct}%; background: {p.color}"
							></div>
						</div>
						<div class="w-12 shrink-0 text-sm tabular-nums">{nf.format(Math.round(p.value))}</div>
					</div>
				{/each}
			</div>
		</Card.Content>
	</Card.Root>

	<Card.Root class="mt-6">
		<Card.Header>
			<Card.Title>Message volume</Card.Title>
			<Card.Description>Messages per day (to + from you), 7-day average — scrolls with the race</Card.Description>
		</Card.Header>
		<Card.Content>
			<!-- The chart IS the scrubber: grab and slide it to move through time (drag left → forward). -->
			<div
				class="cursor-grab touch-none select-none active:cursor-grabbing"
				role="slider"
				tabindex="0"
				aria-label="Drag, or use arrow keys, to scrub the timeline; Enter to pause"
				aria-valuemin={0}
				aria-valuemax={Math.max(0, days.length - 1)}
				aria-valuenow={pb.state.pos}
				use:scrub={{ playback: pb, sign: -1, round: true }}
			>
				{#if curve}<Chart options={curve} />{/if}
			</div>
			<div class="text-muted-foreground mt-1 flex justify-between text-xs tabular-nums">
				<span>{fmtDay(days[0] ?? 0)}</span>
				<span>{fmtDay(days[days.length - 1] ?? 0)}</span>
			</div>
		</Card.Content>
	</Card.Root>
{/if}
