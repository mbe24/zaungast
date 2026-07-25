<script lang="ts">
	import { onMount } from 'svelte';
	import * as Card from '$lib/components/ui/card';
	import { Button } from '$lib/components/ui/button';
	import { base } from '$app/paths';
	import { app } from '$lib/app.svelte';
	import { rhythm, toggleRhythm } from '$lib/rhythm.svelte';
	import { colorRGB, CHAT, MEET, BOTH } from '$lib/rhythm-color';

	// ---- config ----
	const WEEKDAYS = 7;
	const ROWS = 19; // 0 = night, 1..17 = 06:00..22:00, 18 = early
	const FINE = 70; // fine slots per day in the worker data (matches wrapped.ts FINE_PER_DAY)
	const SMOOTH_WEEKS = 4; // rolling window along the animation (week) axis
	// Gaussian convolution along the minute axis. Wider sigma → softer active↔empty edges (the sharp
	// starts/stops of a block fade over ±~3σ quarter-hours). Bump CONV_SIGMA for more melt.
	const CONV_SIGMA = 2; // in quarter-hours (2 ≈ ±1.5h fade)
	const KERNEL = ((sigma: number): number[] => {
		const r = Math.max(1, Math.round(sigma * 3));
		const k: number[] = [];
		for (let i = -r; i <= r; i++) k.push(Math.exp(-(i * i) / (2 * sigma * sigma)));
		return k;
	})(CONV_SIGMA);
	const WEEK_MS = 450; // display time per week (autoplay speed)
	const ROW_PX = 34; // cell row height (css px)
	const FEATHER = 0.5; // 0..1 horizontal feather between day columns (softens the vertical cuts; 0 = off)
	const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']; // Sunday-anchored

	const fmtWeek = (ms: number) => (ms > 0 ? new Date(ms).toLocaleDateString() : '');
	const slotLabel = (row: number) => {
		if (row < 1 || row > 17) return ''; // buffer rows unlabeled
		const hh = row + 5; // 6..22
		return `${hh % 12 === 0 ? 12 : hh % 12} ${hh < 12 ? 'AM' : 'PM'}`;
	};

	const data = $derived(app.data);
	const weeks = $derived(data?.rhythmWeeks ?? []);

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
	// Convolve each day's contiguous hour-quarters (fine slots 1..68) along the minute axis.
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

	const curWeek = $derived(weeks[Math.round(Math.min(rhythm.pos, Math.max(0, weeks.length - 1)))] ?? 0);

	let canvasEl = $state<HTMLCanvasElement | null>(null);

	onMount(() => {
		rhythm.weeks = weeks.length;
		rhythm.pos = 0;
		rhythm.playing = true;
		const cv = canvasEl;
		if (!cv) return;

		const off = document.createElement('canvas'); // reusable 1×H strip (crisp per-day column)
		const off2 = document.createElement('canvas'); // WEEKDAYS×H source for the horizontal feather
		let raf = 0;
		let last = 0;

		const resize = () => {
			const d = Math.max(1, window.devicePixelRatio || 1);
			cv.width = Math.max(1, Math.round(cv.clientWidth * d));
			cv.height = Math.max(1, Math.round(cv.clientHeight * d));
		};
		const ro = new ResizeObserver(resize);
		ro.observe(cv);
		resize();

		const draw = () => {
			const ctx = cv.getContext('2d');
			if (!ctx) return;
			const W = cv.width;
			const H = cv.height;
			ctx.clearRect(0, 0, W, H);
			const A = convA;
			const B = convB;
			if (!A.length || W < 1 || H < 1) return;
			const pos = Math.min(rhythm.pos, A.length - 1);
			const w0 = Math.floor(pos);
			const w1 = Math.min(w0 + 1, A.length - 1);
			const f = pos - w0;
			const A0 = A[w0];
			const A1 = A[w1];
			const B0 = B[w0];
			const B1 = B[w1];
			const pa = aP95;
			const pb = bP95;
			const colW = W / WEEKDAYS;
			const rowH = H / ROWS;
			// Fine-slot centre positions down the column, so night↔6 AM and 10 PM↔early blend across the
			// buffer boundaries instead of cutting (the buffers aggregate 3–4h, so the blend is gentle).
			const hourTop = rowH;
			const hourBot = (ROWS - 1) * rowH;
			const hourSpan = hourBot - hourTop;
			const cNight = rowH * 0.5; // night-buffer centre
			const c1 = hourTop + (0.5 / 68) * hourSpan; // 06:00 slot centre
			const c68 = hourTop + (67.5 / 68) * hourSpan; // 22:45 slot centre
			const cEarly = hourBot + rowH * 0.5; // early-buffer centre

			off.width = 1;
			off.height = H;
			const octx = off.getContext('2d');
			if (!octx) return;
			const img = octx.createImageData(1, H);
			const px = img.data;
			off2.width = WEEKDAYS;
			off2.height = H;
			const octx2 = off2.getContext('2d');
			if (!octx2) return;
			const simg = octx2.createImageData(WEEKDAYS, H);
			const spx = simg.data;
			ctx.imageSmoothingEnabled = false;

			for (let day = 0; day < WEEKDAYS; day++) {
				const bse = day * FINE;
				for (let y = 0; y < H; y++) {
					let s0: number;
					let s1: number;
					let fr: number;
					if (y <= cNight) {
						s0 = s1 = bse; // flat above the night-buffer centre
						fr = 0;
					} else if (y < c1) {
						s0 = bse; // night → 6 AM blend
						s1 = bse + 1;
						fr = (y - cNight) / (c1 - cNight);
					} else if (y <= c68) {
						const fp = ((y - c1) / (c68 - c1)) * 67; // across the 67 gaps between slots 1..68
						const i = Math.min(66, Math.floor(fp));
						fr = fp - i;
						s0 = bse + 1 + i;
						s1 = bse + 2 + i;
					} else if (y < cEarly) {
						s0 = bse + FINE - 2; // 10 PM → early blend (slot 68 → 69)
						s1 = bse + FINE - 1;
						fr = (y - c68) / (cEarly - c68);
					} else {
						s0 = s1 = bse + FINE - 1; // flat below the early-buffer centre
						fr = 0;
					}
					// bilinear: interpolate between weeks (f), then between adjacent fine slots (fr).
					const a0 = A0[s0] + (A1[s0] - A0[s0]) * f;
					const a1 = A0[s1] + (A1[s1] - A0[s1]) * f;
					const av = a0 + (a1 - a0) * fr;
					const b0 = B0[s0] + (B1[s0] - B0[s0]) * f;
					const b1 = B0[s1] + (B1[s1] - B0[s1]) * f;
					const bv = b0 + (b1 - b0) * fr;
					const aN = Math.min(1, Math.max(0, av) / pa);
					const bN = Math.min(1, Math.max(0, bv) / pb);
					const [r, g, b] = colorRGB(aN, bN);
					const o = y * 4;
					px[o] = r;
					px[o + 1] = g;
					px[o + 2] = b;
					px[o + 3] = 255;
					const so = (y * WEEKDAYS + day) * 4;
					spx[so] = r;
					spx[so + 1] = g;
					spx[so + 2] = b;
					spx[so + 3] = 255;
				}
				octx.putImageData(img, 0, 0);
				ctx.drawImage(off, 0, 0, 1, H, Math.round(day * colW), 0, Math.ceil(colW), H);
			}

			// Subtle horizontal feather: overlay the columns bilinearly-blended at partial alpha, so the
			// hard vertical cuts between days soften. Gridlines (below) stay crisp on top.
			if (FEATHER > 0) {
				octx2.putImageData(simg, 0, 0);
				ctx.imageSmoothingEnabled = true;
				ctx.globalAlpha = FEATHER;
				ctx.drawImage(off2, 0, 0, WEEKDAYS, H, 0, 0, W, H);
				ctx.globalAlpha = 1;
				ctx.imageSmoothingEnabled = false;
			}

			// hairline grid on top (day + hour separators)
			const line = Math.max(1, Math.round((window.devicePixelRatio || 1) * 1.5));
			ctx.fillStyle = 'rgba(198, 208, 245, 0.13)';
			for (let day = 1; day < WEEKDAYS; day++) ctx.fillRect(Math.round(day * colW) - (line >> 1), 0, line, H);
			for (let row = 1; row < ROWS; row++) ctx.fillRect(0, Math.round(row * rowH) - (line >> 1), W, line);
		};

		const loop = (ts: number) => {
			if (!last) last = ts;
			const dt = ts - last;
			last = ts;
			if (rhythm.playing && rhythm.weeks > 1) {
				rhythm.pos += dt / WEEK_MS;
				if (rhythm.pos >= rhythm.weeks - 1) {
					rhythm.pos = rhythm.weeks - 1;
					rhythm.playing = false;
				}
			}
			draw();
			raf = requestAnimationFrame(loop);
		};
		raf = requestAnimationFrame(loop);
		return () => {
			cancelAnimationFrame(raf);
			ro.disconnect();
		};
	});

	// Drag to scrub weeks; click to pause/resume.
	let dragging = false;
	let dragMoved = false;
	let dragWasPlaying = false;
	let dragStartX = 0;
	let dragStartPos = 0;
	let dragWidth = 1;
	function onDown(e: PointerEvent): void {
		dragging = true;
		dragMoved = false;
		dragWasPlaying = rhythm.playing;
		dragStartX = e.clientX;
		dragStartPos = rhythm.pos;
		dragWidth = (e.currentTarget as HTMLElement).clientWidth || 1;
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
	}
	function onMove(e: PointerEvent): void {
		if (!dragging) return;
		const dx = e.clientX - dragStartX;
		if (!dragMoved && Math.abs(dx) < 4) return;
		if (!dragMoved) {
			dragMoved = true;
			rhythm.playing = false;
		}
		const total = Math.max(1, rhythm.weeks - 1);
		rhythm.pos = Math.max(0, Math.min(total, dragStartPos + (dx / dragWidth) * total));
	}
	function onUp(e: PointerEvent): void {
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
						<span style="color:{BOTH}">both at once</span>. Drag to scrub, tap to pause.
					</Card.Description>
				</div>
				<span class="font-heading text-2xl tabular-nums">{fmtWeek(curWeek)}</span>
			</div>
		</Card.Header>
		<Card.Content>
			<div class="grid w-full" style="grid-template-columns: 4.5rem 1fr;">
				<div></div>
				<div class="flex">
					{#each DAY_LABELS as d (d)}
						<div class="text-muted-foreground flex-1 pb-1 text-center text-lg font-semibold tracking-wider uppercase">
							{d}
						</div>
					{/each}
				</div>
				<div class="flex flex-col" style="height: {ROWS * ROW_PX}px;">
					{#each Array(ROWS) as _, row (row)}
						<div class="text-muted-foreground/70 flex flex-1 items-center justify-end pr-2 text-lg font-semibold tabular-nums">
							{slotLabel(row)}
						</div>
					{/each}
				</div>
				<canvas
					bind:this={canvasEl}
					class="block w-full cursor-pointer touch-none select-none"
					style="height: {ROWS * ROW_PX}px;"
					role="button"
					tabindex="0"
					aria-label="Weekly rhythm heatmap — drag to scrub weeks, tap to pause"
					onpointerdown={onDown}
					onpointermove={onMove}
					onpointerup={onUp}
					onpointercancel={onUp}
				></canvas>
			</div>
		</Card.Content>
	</Card.Root>
{/if}
