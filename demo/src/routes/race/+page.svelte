<script lang="ts">
	import { onMount } from 'svelte';
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import Chart from '$lib/components/Chart.svelte';
	import * as Plot from '@observablehq/plot';
	import { base } from '$app/paths';
	import { app } from '$lib/app.svelte';
	import { race, toggleRace } from '$lib/race.svelte';
	import { PALETTE } from '$lib/palette';

	const DAY = 86_400_000;
	const WINDOW = 35; // trailing days (~5 weeks) — smooths bursts/vacations (bigger = calmer, more sustained)
	const VOL_WINDOW = 182 * DAY; // ~6-month visible window for the volume chart; it scrolls with time
	const TICK_MS = 90; // one day per tick — fine steps keep both charts moving smoothly, without over-updating

	const nf = new Intl.NumberFormat();
	const fmtDay = (ms: number) => (ms > 0 ? new Date(ms).toLocaleDateString() : '');

	const abbrev = (raw: string) => {
		const name = raw.replace(/\s*\([^)]*\)\s*$/, '').trim(); // drop a trailing "(Org)" federated suffix
		if (name.includes(',')) {
			// "Surname, Given …" — Teams' format for external/federated contacts → "Surname, G."
			const [last, ...rest] = name.split(',');
			const given = rest.join(',').trim().split(/\s+/).filter(Boolean);
			return given.length ? `${last.trim()}, ${given[0][0]}.` : last.trim();
		}
		const parts = name.split(/\s+/).filter(Boolean);
		if (parts.length <= 1) return name;
		const [first, ...more] = parts;
		return `${first} ${more.map((p) => p[0] + '.').join(' ')}`;
	};

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

	// Start/reset the race whenever this page mounts. (race.weeks/weekIndex are generic frame counters.)
	onMount(() => {
		race.weeks = days.length;
		race.weekIndex = 0;
		race.playing = true;
	});

	// Playback loop: one day per tick; stop at the end (the story bar restarts/pauses).
	$effect(() => {
		if (!race.playing || race.weeks < 2) return;
		const id = setInterval(() => {
			if (race.weekIndex >= race.weeks - 1) race.playing = false;
			else race.weekIndex++;
		}, TICK_MS);
		return () => clearInterval(id);
	});

	const curDay = $derived(days[Math.min(race.weekIndex, Math.max(0, days.length - 1))] ?? 0);

	// Grab-and-slide the volume chart to scrub time, OR click it to pause/resume. A real drag (pointer
	// moved past a small threshold) pauses while dragging and resumes only if it was playing; a click (no
	// drag) toggles play/pause. Drag left → forward, drag right → rewind — a full sweep covers the whole
	// span. Bars, curve and the story bar all track race.weekIndex in lockstep.
	let dragging = false;
	let dragMoved = false;
	let dragWasPlaying = false;
	let dragStartX = 0;
	let dragStartIndex = 0;
	let dragWidth = 1;
	function onChartPointerDown(e: PointerEvent): void {
		dragging = true;
		dragMoved = false;
		dragWasPlaying = race.playing;
		dragStartX = e.clientX;
		dragStartIndex = race.weekIndex;
		dragWidth = (e.currentTarget as HTMLElement).clientWidth || 1;
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
	}
	function onChartPointerMove(e: PointerEvent): void {
		if (!dragging) return;
		const dx = e.clientX - dragStartX;
		if (!dragMoved && Math.abs(dx) < 4) return; // tolerate jitter so a click isn't read as a drag
		if (!dragMoved) {
			dragMoved = true;
			race.playing = false; // first real movement → yield control
		}
		const total = Math.max(1, days.length - 1);
		race.weekIndex = Math.max(0, Math.min(total, dragStartIndex - Math.round((dx / dragWidth) * total)));
	}
	function onChartPointerUp(e: PointerEvent): void {
		if (!dragging) return;
		dragging = false;
		(e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
		if (dragMoved) {
			if (dragWasPlaying) race.playing = true; // resume after a scrub
		} else {
			toggleRace(); // a click (no drag) pauses / resumes (restarts at the end)
		}
	}

	// Per-person rolling daily rate (precomputed once per dataset), stable colour by rank.
	const series = $derived(
		(data?.racePeople ?? []).map((p, i) => ({
			name: p.name,
			color: PALETTE[i % PALETTE.length],
			roll: rolling(p.daily),
		})),
	);

	// Hysteresis: carry the previous frame's order across ticks (plain, non-reactive) so near-ties don't
	// swap places on daily noise. A bar only overtakes the one above it once it leads by HYSTERESIS —
	// RELATIVE to the pair (not the global peak), so small values still order correctly (4 beats 2) while
	// genuine near-ties at any scale stay put.
	const HYSTERESIS = 0.15; // challenger must exceed a neighbour by this fraction of the larger to pass it
	const ROWS = 10; // visible slots
	const ROW_REM = 2.5; // vertical pitch per row (rem)
	let prevOrder: string[] = [];

	// One entry PER TRACKED PERSON, in a STABLE order (never reordered in the DOM). Each carries its
	// current rank; the template positions rows by transform:translateY(rank·pitch) and animates only the
	// transform — so a reorder glides on the compositor, immune to the volume chart's reflows (no flip).
	const rows = $derived.by(() => {
		const upto = Math.min(race.weekIndex, days.length - 1);
		const val = new Map(series.map((s) => [s.name, s.roll[upto] ?? 0]));
		// Scale bars to the CURRENT frame's leader, not the all-time peak — so the chart stays full and
		// "who's on top now" is legible; the volume chart below carries the absolute magnitude.
		const frameMax = Math.max(1, ...val.values());
		// Seed with last frame's order, then append anyone not yet placed — keeps the order stable.
		const names = prevOrder.filter((n) => val.has(n));
		for (const s of series) if (!names.includes(s.name)) names.push(s.name);
		// Stable sort: within the (relative) margin the comparator returns 0, so JS keeps the prior order.
		names.sort((a, b) => {
			const va = val.get(a) ?? 0;
			const vb = val.get(b) ?? 0;
			return Math.abs(vb - va) < Math.max(va, vb, 1) * HYSTERESIS ? 0 : vb - va;
		});
		prevOrder = names;
		const rank = new Map<string, number>();
		let r = 0;
		for (const n of names) if ((val.get(n) ?? 0) > 0 && r < ROWS) rank.set(n, r++);
		// Emit in series' fixed order so the #each never reorders the DOM.
		return series.map((s) => {
			const value = val.get(s.name) ?? 0;
			const rk = rank.get(s.name) ?? -1;
			return {
				name: s.name,
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

	const base_style =
		'background:transparent;color:var(--muted-foreground);font-family:inherit;font-size:14px;';

	/* eslint-disable @typescript-eslint/no-explicit-any */
	const curve = $derived.by(() => {
		if (!perDay.length) return null;
		const upto = Math.min(race.weekIndex, perDay.length - 1);
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
				Plot.lineY(shown, { x: 'day', y: 'count', stroke: 'var(--chart-1)', strokeWidth: 1.5, curve: 'monotone-x', clip: true }),
				Plot.ruleY([0]),
			],
		} as Parameters<typeof Plot.plot>[0];
	});
	/* eslint-enable @typescript-eslint/no-explicit-any */
</script>

{#if !data}
	<div class="flex min-h-[50vh] flex-col items-center justify-center gap-4 text-center">
		<p class="text-muted-foreground text-lg">No data yet — pick your Teams cache folder first.</p>
		<Button href="{base}/" variant="secondary">← Back to start</Button>
	</div>
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
				onclick={() => toggleRace()}
				onkeydown={(e) => {
					if (e.key === 'Enter' || e.key === ' ') {
						e.preventDefault();
						toggleRace();
					}
				}}
			>
				{#each rows as p (p.name)}
					<div
						class="absolute inset-x-0 flex items-center gap-3 transition-[transform,opacity] duration-500 ease-in-out"
						style="height: {ROW_REM}rem; transform: translateY({p.slot * ROW_REM}rem); opacity: {p.rank <
						0
							? 0
							: 1}"
					>
						<div class="text-muted-foreground w-36 shrink-0 truncate text-right text-sm">
							{abbrev(p.name)}
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
			<!-- The chart IS the scrubber: grab and slide it to move through time. -->
			<div
				class="cursor-grab touch-none select-none active:cursor-grabbing"
				role="slider"
				tabindex="0"
				aria-label="Drag left or right to scrub the timeline"
				aria-valuemin={0}
				aria-valuemax={Math.max(0, days.length - 1)}
				aria-valuenow={race.weekIndex}
				onpointerdown={onChartPointerDown}
				onpointermove={onChartPointerMove}
				onpointerup={onChartPointerUp}
				onpointercancel={onChartPointerUp}
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
