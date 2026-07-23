<script lang="ts">
	import * as Card from '$lib/components/ui/card';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import Chart from '$lib/components/Chart.svelte';
	import * as Plot from '@observablehq/plot';
	import * as Comlink from 'comlink';
	import { createTeams, type Progress } from '$lib/teams';
	import type { WrappedData } from '$lib/wrapped';

	let phase = $state<'idle' | 'building' | 'ready' | 'error'>('idle');
	let progress = $state('');
	let error = $state('');
	let data = $state<WrappedData | null>(null);
	let fileInput = $state<HTMLInputElement>();

	// Help dialog: where the Teams cache folder lives, per OS (system paths, not PII).
	let helpOpen = $state(false);
	const detectOs = (): 'windows' | 'macos' => {
		const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
		const p = (nav.userAgentData?.platform || navigator.platform || '').toLowerCase();
		return p.includes('mac') ? 'macos' : 'windows';
	};
	let os = $state<'windows' | 'macos'>(detectOs());
	const WIN_PATH = String.raw`C:\Users\<you>\AppData\Local\Packages\MSTeams_8wekyb3d8bbwe\LocalCache\Microsoft\MSTeams\EBWebView\<profile>\IndexedDB\https_teams.microsoft.com_0.indexeddb.leveldb`;
	const MAC_PATH = `/Users/<you>/Library/Containers/com.microsoft.teams2/Data/Library/Application Support/Microsoft/MSTeams/EBWebView/<profile>/IndexedDB/https_teams.microsoft.com_0.indexeddb.leveldb`;

	const nf = new Intl.NumberFormat();
	const fmtDate = (ms: number) => (ms > 0 ? new Date(ms).toLocaleDateString() : '—');
	const fmtDateTime = (ms: number) => (ms > 0 ? new Date(ms).toLocaleString() : '—');

	// Display-time name shortening (until a real private mode): first name in full, each following
	// name-part to its initial. "Firstname Lastname" → "Firstname L."; "Firstname de Surname" → "Firstname d. S.".
	const abbrev = (name: string) => {
		const parts = name.trim().split(/\s+/);
		if (parts.length <= 1) return name;
		const [first, ...rest] = parts;
		return `${first} ${rest.map((p) => p[0] + '.').join(' ')}`;
	};

	// Conversation-kind display labels ("1:1" → "Chat"; others capitalized).
	const prettyKind = (k: string) => (k === '1:1' ? 'Chat' : k.charAt(0).toUpperCase() + k.slice(1));

	// Busiest-day highlight: "26th June 2026" — returns parts so the template can render the ordinal
	// suffix (th/st/nd/rd) smaller, since the heading font is uppercased.
	const longDateParts = (ms: number) => {
		const d = new Date(ms);
		const day = d.getDate();
		const v = day % 100;
		const suffix = v >= 11 && v <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][day % 10] ?? 'th');
		return { day, suffix, rest: `${d.toLocaleString(undefined, { month: 'long' })} ${d.getFullYear()}` };
	};

	// Auto-pick a scale from the data's dynamic range: orders of magnitude between a robust floor (10th
	// percentile of nonzero values, so one tiny outlier can't dominate) and the max. <1 order → linear,
	// <2 → sqrt (variance-stabilizing for counts), else → symlog (log-like but zero-safe).
	type ScaleType = 'linear' | 'sqrt' | 'symlog';
	function pickScaleType(values: number[]): ScaleType {
		const nz = values.filter((v) => v > 0).sort((a, b) => a - b);
		if (nz.length < 2) return 'linear';
		const max = nz[nz.length - 1];
		const floor = Math.max(1, nz[Math.floor(nz.length * 0.1)] ?? nz[0]);
		const orders = Math.log10(max / floor);
		return orders < 1 ? 'linear' : orders < 2 ? 'sqrt' : 'symlog';
	}

	// Round tick values (1 / 2.5 / 5 × 10^k) so a compressed (sqrt) axis stays readable — Plot's auto
	// ticks crowd. Returns 0 plus the largest few round anchors ≤ max (e.g. 0, 100, 250, 500, 1000).
	function niceTicks(max: number, count = 4): number[] {
		if (max <= 0) return [0];
		const anchors: number[] = [];
		for (let mag = 1; mag <= max; mag *= 10)
			for (const m of [1, 2.5, 5]) if (m * mag <= max) anchors.push(m * mag);
		return [0, ...anchors.slice(-count)];
	}

	const teams = createTeams();

	async function onFiles() {
		const files = fileInput?.files ? Array.from(fileInput.files) : [];
		if (!files.length) return;
		phase = 'building';
		error = '';
		data = null;
		try {
			await teams.build(
				files,
				Comlink.proxy((p: Progress) => {
					if (p.type === 'reading') progress = `Reading ${p.total} files…`;
					else if (p.type === 'decoding') progress = `Decoding ${p.name} (${p.i} of ${p.n})`;
					else progress = `Building store — ${p.phase}…`;
				}),
			);
			data = await teams.wrapped();
			phase = 'ready';
		} catch (e) {
			error = (e as Error).message;
			phase = 'error';
		}
	}

	const pick = () => fileInput?.click();

	// Plot style string (reliably applied to the svg root so tick labels inherit the 16px size).
	const base = 'background:transparent;color:var(--muted-foreground);font-family:inherit;font-size:16px;';

	// Scale types chosen from each chart's dynamic range (stable across panning — based on the full series).
	const activityScale = $derived(data ? pickScaleType(data.messagesPerDay.map((d) => d.count)) : 'linear');
	const peopleScale = $derived.by((): ScaleType => {
		if (!data) return 'linear';
		const s = pickScaleType(data.topPeople.map((p) => p.messages));
		return s === 'symlog' ? 'sqrt' : s; // bars start at 0 → cap at sqrt (symlog crowds ticks near max)
	});
	const peopleTicks = $derived(niceTicks(data ? Math.max(0, ...data.topPeople.map((p) => p.messages)) : 0));

	// Activity shows a 6-month window; drag pans it across the full cached span (no squish).
	const WINDOW_MS = 182 * 86_400_000; // ~6 months
	let windowStart = $state(0);
	$effect(() => {
		// Default to the most recent 6 months whenever new data loads.
		if (data) windowStart = Math.max(data.span.firstTs, data.span.lastTs - WINDOW_MS);
	});
	const windowEnd = $derived(windowStart + WINDOW_MS);
	const slideMax = $derived(data ? Math.max(data.span.firstTs, data.span.lastTs - WINDOW_MS) : 0);
	const canSlide = $derived(!!data && data.span.lastTs - data.span.firstTs > WINDOW_MS);

	// Drag-to-pan the activity window (replaces the scrollbar). clientWidth maps pixel drag → time.
	let chartW = $state(0);
	let dragging = false;
	let dragStartX = 0;
	let dragStartWin = 0;
	function onDragStart(e: PointerEvent) {
		if (!canSlide) return;
		dragging = true;
		dragStartX = e.clientX;
		dragStartWin = windowStart;
		(e.currentTarget as Element).setPointerCapture?.(e.pointerId);
	}
	function onDragMove(e: PointerEvent) {
		if (!dragging || !chartW || !data) return;
		const dt = ((e.clientX - dragStartX) / chartW) * WINDOW_MS; // drag right → go back in time
		windowStart = Math.max(data.span.firstTs, Math.min(slideMax, dragStartWin - dt));
	}
	const onDragEnd = () => (dragging = false);
	function onPanKey(e: KeyboardEvent) {
		if (!canSlide || !data) return;
		const step = 30 * 86_400_000; // ~1 month per arrow press
		if (e.key === 'ArrowLeft') windowStart = Math.max(data.span.firstTs, windowStart - step);
		else if (e.key === 'ArrowRight') windowStart = Math.min(slideMax, windowStart + step);
		else return;
		e.preventDefault();
	}

	/* eslint-disable @typescript-eslint/no-explicit-any */
	const activity = $derived(
		data &&
			({
				height: 380,
				marginTop: 24,
				marginBottom: 40,
				marginLeft: 16,
				marginRight: 56,
				style: base,
				x: { label: null, domain: [new Date(windowStart), new Date(windowEnd)] },
				y: { type: activityScale, label: 'messages', grid: true, axis: 'right', ticks: 5 },
				marks: [
					Plot.areaY(data.messagesPerDay, { x: (d: any) => new Date(d.date), y: 'count', fill: 'var(--chart-1)', fillOpacity: 0.2, curve: 'monotone-x', clip: true }),
					Plot.lineY(data.messagesPerDay, { x: (d: any) => new Date(d.date), y: 'count', stroke: 'var(--chart-1)', strokeWidth: 1.5, curve: 'monotone-x', clip: true }),
					Plot.ruleY([0]),
				],
			} as Parameters<typeof Plot.plot>[0]),
	);

	const people = $derived(
		data &&
			({
				height: 420,
				marginLeft: 130,
				marginRight: 32,
				marginBottom: 52,
				style: base,
				x: { type: peopleScale, label: 'messages', labelOffset: 44, grid: true, ticks: peopleTicks },
				y: { label: null, tickFormat: (n: string) => abbrev(n) },
				marks: [
					Plot.barX(data.topPeople, { x: 'messages', y: 'name', fill: 'var(--chart-2)', rx: 6, sort: { y: 'x', reverse: true } }),
					Plot.ruleX([0]),
				],
			} as Parameters<typeof Plot.plot>[0]),
	);

	const hourTotal = $derived(data ? data.hourHistogram.reduce((s, h) => s + h.count, 0) : 0);
	const hours = $derived(
		data &&
			({
				height: 220,
				marginLeft: 48,
				marginTop: 30,
				marginBottom: 40,
				style: base,
				x: { label: 'hour of day', tickFormat: (h: number) => `${h}` },
				y: { label: 'share of messages', grid: true, tickFormat: '%' },
				marks: [
					Plot.barY(data.hourHistogram, {
						x: 'hour',
						y: (d: any) => (hourTotal ? d.count / hourTotal : 0),
						fill: 'var(--chart-3)',
						rx: 3,
					}),
					Plot.ruleY([0]),
				],
			} as Parameters<typeof Plot.plot>[0]),
	);
	/* eslint-enable @typescript-eslint/no-explicit-any */

	const heroStats = $derived(
		data
			? [
					{ label: 'Messages', v: data.totals.messages, hint: 'across all chats' },
					{ label: 'People', v: data.totals.people, hint: 'you talked to' },
					{ label: 'Conversations', v: data.totals.conversations, hint: 'chats & channels' },
					{ label: 'Reactions', v: data.totals.reactions, hint: 'given & received' },
				]
			: [],
	);
</script>

<input bind:this={fileInput} type="file" webkitdirectory hidden onchange={onFiles} />

{#if phase !== 'ready'}
	<div class="flex min-h-[60vh] flex-col items-center justify-center gap-6 text-center">
		<div>
			<h2 class="font-heading text-4xl font-semibold tracking-tight">Your year in Teams</h2>
			<p class="text-muted-foreground mt-2 text-lg">
				Everything runs in your browser — nothing is uploaded.
			</p>
		</div>
		<Button size="lg" onclick={pick} disabled={phase === 'building'}>
			{phase === 'building' ? 'Working…' : 'Pick your Teams cache folder'}
		</Button>
		{#if phase === 'building'}
			<p class="text-muted-foreground text-base">{progress}</p>
		{/if}
		{#if phase === 'error'}
			<p class="text-destructive text-base">Couldn’t read that folder: {error}</p>
		{/if}
		<button
			type="button"
			class="text-muted-foreground hover:text-foreground text-sm underline underline-offset-4"
			onclick={() => (helpOpen = true)}
		>
			Need help finding the folder?
		</button>
	</div>{/if}

<Dialog.Root bind:open={helpOpen}>
	<Dialog.Content class="sm:max-w-[46rem]">
		<Dialog.Header>
			<Dialog.Title>Where is my Teams cache folder?</Dialog.Title>
			<Dialog.Description>
				Pick the folder ending in “.indexeddb.leveldb” — the one holding CURRENT, MANIFEST-*, and the
				*.ldb / *.log files. It’s read in your browser; nothing is uploaded.
			</Dialog.Description>
		</Dialog.Header>
		<div class="flex gap-2">
			<Button variant={os === 'windows' ? 'default' : 'secondary'} size="sm" onclick={() => (os = 'windows')}>
				Windows
			</Button>
			<Button variant={os === 'macos' ? 'default' : 'secondary'} size="sm" onclick={() => (os = 'macos')}>
				macOS
			</Button>
		</div>
		<pre class="bg-muted overflow-x-auto rounded-md p-3 text-sm [word-break:break-all] whitespace-pre-wrap">{os ===
			'windows'
				? WIN_PATH
				: MAC_PATH}</pre>
		<p class="text-muted-foreground text-sm">
			&lt;you&gt; is your account username; &lt;profile&gt; is your Teams profile folder (usually
			<code class="bg-muted rounded px-1 py-0.5">WV2Profile_tfw</code>).
		</p>
		<p class="text-muted-foreground text-sm">
			If Teams is running, shut it down first — or copy the folder and pick the copy — so you don’t
			interfere with Teams. Your browser may say “upload” because a folder picker is technically a
			file-upload control; it can’t tell that this page only reads the files locally. Nothing is
			transmitted.
		</p>
	</Dialog.Content>
</Dialog.Root>

{#if data}
	<section class="grid grid-cols-2 gap-4 md:grid-cols-4">
		{#each heroStats as s (s.label)}
			<Card.Root>
				<Card.Header>
					<Card.Description class="text-base">{s.label}</Card.Description>
					<Card.Title class="font-heading text-5xl tracking-tight">{nf.format(s.v)}</Card.Title>
				</Card.Header>
				<Card.Content class="text-muted-foreground text-base">{s.hint}</Card.Content>
			</Card.Root>
		{/each}
	</section>

	<section class="mt-6 grid gap-4 md:grid-cols-3">
		<Card.Root>
			<Card.Header>
				<Card.Description class="text-base">Busiest day</Card.Description>
				<Card.Title class="font-heading text-3xl">
					{#if data.busiestDay}
						{@const p = longDateParts(data.busiestDay.date)}{p.day}<span
							class="align-super text-[0.6em]">{p.suffix}</span
						> {p.rest}
					{:else}—{/if}
				</Card.Title>
			</Card.Header>
			<Card.Content class="text-muted-foreground text-base">
				{data.busiestDay ? `${nf.format(data.busiestDay.count)} messages` : ''}
			</Card.Content>
		</Card.Root>
		<Card.Root>
			<Card.Header>
				<Card.Description class="text-base">Night-owl index</Card.Description>
				<Card.Title class="font-heading text-3xl">{Math.round(data.nightOwlPct * 100)}%</Card.Title>
			</Card.Header>
			<Card.Content class="text-muted-foreground text-base">of messages sent 10pm–6am</Card.Content>
		</Card.Root>
		<Card.Root>
			<Card.Header>
				<Card.Description class="text-base">Longest streak</Card.Description>
				<Card.Title class="font-heading text-3xl">{data.longestStreak} days</Card.Title>
			</Card.Header>
			<Card.Content class="text-muted-foreground text-base">consecutive active days</Card.Content>
		</Card.Root>
	</section>

	<section class="mt-8 grid gap-6 lg:grid-cols-2">
		<Card.Root>
			<Card.Header><Card.Title>Activity</Card.Title><Card.Description>Messages per day</Card.Description></Card.Header>
			<Card.Content>
				{#if canSlide}
					<div class="text-muted-foreground mb-2 text-sm">
						{fmtDate(windowStart)} – {fmtDate(windowEnd)} · drag to pan
					</div>
				{/if}
				<div
					bind:clientWidth={chartW}
					role="slider"
					tabindex="0"
					aria-label="Activity timeline — drag or use arrow keys to pan"
					aria-valuemin={data.span.firstTs}
					aria-valuemax={slideMax}
					aria-valuenow={windowStart}
					class="touch-none select-none focus:outline-none {canSlide ? 'cursor-grab active:cursor-grabbing' : ''}"
					onpointerdown={onDragStart}
					onpointermove={onDragMove}
					onpointerup={onDragEnd}
					onpointerleave={onDragEnd}
					onkeydown={onPanKey}
				>
					{#if activity}<Chart options={activity} />{/if}
				</div>
			</Card.Content>
		</Card.Root>
		<Card.Root>
			<Card.Header><Card.Title>Top people</Card.Title><Card.Description>Who you talk to most</Card.Description></Card.Header>
			<Card.Content>{#if people}<Chart options={people} />{/if}</Card.Content>
		</Card.Root>
	</section>

	<section class="mt-6 grid gap-6 lg:grid-cols-2">
		<Card.Root>
			<Card.Header><Card.Title>When you’re active</Card.Title><Card.Description>Share of messages by hour of day</Card.Description></Card.Header>
			<Card.Content>{#if hours}<Chart options={hours} />{/if}</Card.Content>
		</Card.Root>
		{#if data.firstMessage}
			<Card.Root>
				<Card.Header>
					<Card.Title>First cached message</Card.Title>
					<Card.Description>{fmtDateTime(data.firstMessage.ts)} · {data.firstMessage.where}</Card.Description>
				</Card.Header>
				<Card.Content class="text-base">
					<div class="text-muted-foreground mb-1 font-medium">
						{abbrev(data.firstMessage.senderName ?? 'Someone')}
					</div>
					<div class="max-h-48 overflow-y-auto pr-2 whitespace-pre-wrap [scrollbar-width:thin]">
						{data.firstMessage.content || '(no text)'}
					</div>
				</Card.Content>
			</Card.Root>
		{/if}
	</section>

	<div
		class="bg-background/70 sticky bottom-0 z-10 mt-8 flex flex-wrap items-center justify-between gap-4 py-3 backdrop-blur-md"
	>
		<Button variant="secondary" size="sm" onclick={pick}>Pick a different folder</Button>
		<div class="flex flex-wrap items-center gap-2">
			<span class="text-muted-foreground text-base">Conversation mix:</span>
			{#each data.convMix as k (k.kind)}
				<Badge variant="secondary">{prettyKind(k.kind)} · {nf.format(k.count)}</Badge>
			{/each}
		</div>
		<span class="text-muted-foreground text-base">
			Cache spans {fmtDate(data.span.firstTs)} – {fmtDate(data.span.lastTs)}
		</span>
	</div>
{/if}
