<script lang="ts">
	// Observable Plot wrapper. Without `width`, it measures its container and fills it (Plot has no
	// auto-resize). With `width` set, it renders at that fixed width instead — put it inside an
	// `overflow-x-auto` wrapper for a horizontally scrollable chart (e.g. a long timeline). Marks use
	// CSS-var colors so charts recolor with the active theme.
	import * as Plot from '@observablehq/plot';

	type Options = Parameters<typeof Plot.plot>[0];
	let { options, width: fixedWidth }: { options: Options; width?: number } = $props();

	let el: HTMLDivElement;
	let measured = $state(0);

	$effect(() => {
		if (fixedWidth) return; // fixed width → no resize observation
		let raf = 0;
		const ro = new ResizeObserver((entries) => {
			const w = Math.floor(entries[0].contentRect.width);
			cancelAnimationFrame(raf);
			raf = requestAnimationFrame(() => {
				if (w && w !== measured) measured = w;
			});
		});
		ro.observe(el);
		return () => {
			cancelAnimationFrame(raf);
			ro.disconnect();
		};
	});

	$effect(() => {
		const w = fixedWidth ?? measured;
		if (!w) return;
		const figure = Plot.plot({ ...options, width: w });
		el.replaceChildren(figure);
		return () => figure.remove();
	});
</script>

<div bind:this={el} class="w-full"></div>
