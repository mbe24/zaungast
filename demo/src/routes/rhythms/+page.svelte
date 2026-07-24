<script lang="ts">
	import { onMount } from 'svelte';
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import { base } from '$app/paths';
	import { app } from '$lib/app.svelte';
	import { rhythm, toggleRhythm } from '$lib/rhythm.svelte';
	import { flavors } from '@catppuccin/palette';

	// ---- config (all code-controlled; no user toggles) ----
	const WEEKDAYS = 7; // 7 = Mon–Sun, 5 = Mon–Fri
	const ROWS = 19; // grid rows: 0 = night, 1..17 = 06:00..22:00, 18 = early
	const QUARTERS = 4; // 15-min segments per hour cell — the vertical minutes-within-hour axis
	const FINE = 70; // fine slots per day in the worker data (must match wrapped.ts FINE_PER_DAY)
	const SMOOTH_WEEKS = 4; // rolling window along the animation (week) axis
	const KERNEL = [1, 2, 3, 2, 1]; // convolution along the minute axis → soft quarter/hour transitions
	const TICK_MS = 450; // one week per tick
	const GAMMA = 0.65; // intensity emphasis
	const MORPH_MS = 500; // per-segment colour transition (week-to-week morph)

	// Colours from the official @catppuccin/palette (Frappé).
	const F = flavors.frappe.colors;
	const CHAT = F.blue.hex; // chat (A)
	const MEET = F.maroon.hex; // meetings (B)
	const RAMP0 = F.surface1.hex; // zero-intensity end of the ramp
	const EMPTY = F.surface0.hex; // a truly-empty slot
	const GRIDLINE = F.surface2.hex; // shared hairline between cells
	const BOTH_SWATCH = F.mauve.hex; // caption "both" swatch

	const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
	const fmtWeek = (ms: number) => (ms > 0 ? new Date(ms).toLocaleDateString() : '');
	const slotLabel = (row: number) => {
		if (row < 1 || row > 17) return ''; // buffer rows unlabeled
		const hh = row + 5; // 6..22
		return `${hh % 12 === 0 ? 12 : hh % 12} ${hh < 12 ? 'AM' : 'PM'}`; // 6 AM … 10 PM
	};
	// Fine-slot indices (0..69 within a day) a grid row occupies: buffers = 1, hours = their 4 quarters.
	const fineIndices = (row: number): number[] => {
		if (row === 0) return [0]; // night buffer
		if (row === 18) return [FINE - 1]; // early buffer
		const b = 1 + (row - 1) * QUARTERS;
		return [b, b + 1, b + 2, b + 3];
	};

	const data = $derived(app.data);
	const weeks = $derived(data?.rhythmWeeks ?? []);

	// Rolling mean along the WEEK axis (per fine cell) — stabilises the pattern across the time-lapse.
	function rollingMean(series: number[][], win: number): number[][] {
		const cells = series[0]?.length ?? 0;
		return series.map((_, i) => {
			const lo = Math.max(0, i - win + 1);
			const out = new Array(cells).fill(0);
			for (let k = lo; k <= i; k++) for (let c = 0; c < cells; c++) out[c] += series[k][c];
			const n = i - lo + 1;
			for (let c = 0; c < cells; c++) out[c] /= n;
			return out;
		});
	}
	// Convolution along the MINUTE axis: smooth each day's contiguous hour-quarters (fine slots 1..68)
	// so quarter- and hour-boundaries fade softly rather than stepping hard. Buffers (0, 69) untouched.
	function convolveDay(week: number[]): number[] {
		const half = KERNEL.length >> 1;
		const out = week.slice();
		for (let day = 0; day < 7; day++) {
			const base = day * FINE;
			for (let i = 1; i <= 68; i++) {
				let s = 0;
				let wsum = 0;
				for (let k = 0; k < KERNEL.length; k++) {
					const off = i + k - half;
					if (off < 1 || off > 68) continue;
					s += week[base + off] * KERNEL[k];
					wsum += KERNEL[k];
				}
				out[base + i] = wsum ? s / wsum : week[base + i];
			}
		}
		return out;
	}
	// 95th percentile of nonzero smoothed values — per-metric normaliser (chat and meetings differ in scale).
	function p95(series: number[][]): number {
		const vals: number[] = [];
		for (const row of series) for (const v of row) if (v > 0) vals.push(v);
		if (!vals.length) return 1e-9;
		vals.sort((a, b) => a - b);
		return Math.max(1e-9, vals[Math.floor(vals.length * 0.95)] ?? vals[vals.length - 1]);
	}

	const convA = $derived(rollingMean(data?.rhythmA ?? [], SMOOTH_WEEKS).map(convolveDay));
	const convB = $derived(rollingMean(data?.rhythmB ?? [], SMOOTH_WEEKS).map(convolveDay));
	const aP95 = $derived(p95(convA));
	const bP95 = $derived(p95(convB));

	const w = $derived(Math.min(rhythm.weekIndex, Math.max(0, weeks.length - 1)));
	const frameA = $derived(convA[w] ?? []);
	const frameB = $derived(convB[w] ?? []);

	// One fine slot → its blended colour: hue = chat-blue ↔ meeting-maroon by relative amount (OKLCH, so
	// the balanced midpoint is purple, not mud); intensity ramps from the surface up to that hue.
	function slotColor(aVal: number, bVal: number): string {
		const aN = Math.min(1, aVal / aP95);
		const bN = Math.min(1, bVal / bP95);
		const sum = aN + bN;
		if (sum <= 0) return EMPTY;
		const ratio = ((bN / sum) * 100).toFixed(1); // 0% = all chat … 100% = all meetings
		const t = (Math.pow(Math.max(aN, bN), GAMMA) * 100).toFixed(1);
		const hue = `color-mix(in oklch, ${MEET} ${ratio}%, ${CHAT})`;
		return `color-mix(in oklab, ${hue} ${t}%, ${RAMP0})`;
	}

	// Playback (weekly) + grab-to-scrub — mirrors the race page.
	onMount(() => {
		rhythm.weeks = weeks.length;
		rhythm.weekIndex = 0;
		rhythm.playing = true;
	});
	$effect(() => {
		if (!rhythm.playing || rhythm.weeks < 2) return;
		const id = setInterval(() => {
			if (rhythm.weekIndex >= rhythm.weeks - 1) rhythm.playing = false;
			else rhythm.weekIndex++;
		}, TICK_MS);
		return () => clearInterval(id);
	});
	let dragging = false;
	let dragMoved = false;
	let dragWasPlaying = false;
	let dragStartX = 0;
	let dragStartIndex = 0;
	let dragWidth = 1;
	function onGridPointerDown(e: PointerEvent): void {
		dragging = true;
		dragMoved = false;
		dragWasPlaying = rhythm.playing;
		dragStartX = e.clientX;
		dragStartIndex = rhythm.weekIndex;
		dragWidth = (e.currentTarget as HTMLElement).clientWidth || 1;
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
	}
	function onGridPointerMove(e: PointerEvent): void {
		if (!dragging) return;
		const dx = e.clientX - dragStartX;
		if (!dragMoved && Math.abs(dx) < 4) return;
		if (!dragMoved) {
			dragMoved = true;
			rhythm.playing = false;
		}
		const total = Math.max(1, weeks.length - 1);
		rhythm.weekIndex = Math.max(0, Math.min(total, dragStartIndex + Math.round((dx / dragWidth) * total)));
	}
	function onGridPointerUp(e: PointerEvent): void {
		if (!dragging) return;
		dragging = false;
		(e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
		if (dragMoved) {
			if (dragWasPlaying) rhythm.playing = true;
		} else {
			toggleRhythm();
		}
	}
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
					<Card.Title>Your week, in rhythm</Card.Title>
					<Card.Description>
						A typical week over time — <span style="color:{CHAT}">chat</span> and
						<span style="color:{MEET}">meetings</span>, blending to
						<span style="color:{BOTH_SWATCH}">both at once</span>. Drag to scrub, tap to pause.
					</Card.Description>
				</div>
				<span class="font-heading text-2xl tabular-nums">{fmtWeek(weeks[w])}</span>
			</div>
		</Card.Header>
		<Card.Content>
			<div
				class="w-full cursor-pointer touch-none select-none"
				role="button"
				tabindex="0"
				aria-label="Pause or resume; drag to scrub weeks"
				onpointerdown={onGridPointerDown}
				onpointermove={onGridPointerMove}
				onpointerup={onGridPointerUp}
				onpointercancel={onGridPointerUp}
			>
				<!-- Shared-line grid: the container's colour shows through the 1px gaps between cells. -->
				<div
					class="grid gap-px"
					style="grid-template-columns: 4.5rem repeat({WEEKDAYS}, minmax(0, 1fr)); background: {GRIDLINE};"
				>
					<div class="bg-card"></div>
					{#each DAY_LABELS.slice(0, WEEKDAYS) as d (d)}
						<div class="bg-card text-muted-foreground pb-1 text-center text-lg font-semibold tracking-wider uppercase">
							{d}
						</div>
					{/each}
					{#each Array(ROWS) as _, row (row)}
						{@const idx = fineIndices(row)}
						<div class="bg-card text-muted-foreground/70 pr-2 text-right text-lg font-semibold leading-9 tabular-nums">
							{slotLabel(row)}
						</div>
						{#each Array(WEEKDAYS) as _, day (day)}
							{#if idx.length === 1}
								<div
									class="h-9"
									style="background: {slotColor(frameA[day * FINE + idx[0]] ?? 0, frameB[day * FINE + idx[0]] ?? 0)}; transition: background-color {MORPH_MS}ms ease;"
								></div>
							{:else}
								<div class="grid h-9 grid-rows-4">
									{#each idx as fi (fi)}
										<div
											style="background: {slotColor(frameA[day * FINE + fi] ?? 0, frameB[day * FINE + fi] ?? 0)}; transition: background-color {MORPH_MS}ms ease;"
										></div>
									{/each}
								</div>
							{/if}
						{/each}
					{/each}
				</div>
			</div>
		</Card.Content>
	</Card.Root>
{/if}
