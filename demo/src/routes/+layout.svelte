<script lang="ts">
	import './layout.css';
	import { base } from '$app/paths';
	import { onMount } from 'svelte';
	import { theme, themes, setTheme, type ThemeId } from '$lib/theme.svelte';

	let { children } = $props();

	// Theme picker hidden for now — force Frappé as the standard theme (Fable defines the visual
	// language next). The app.html pre-paint script sets it too, to avoid a flash.
	// Flip this to true to bring the picker back.
	const showThemePicker = false;
	onMount(() => setTheme('frappe'));
</script>

<svelte:head>
	<link rel="icon" type="image/svg+xml" href="{base}/logo.svg" />
	<link rel="alternate icon" href="{base}/logo.png" />
</svelte:head>

<div class="bg-background text-foreground min-h-screen">
	<header class="bg-background/70 sticky top-0 z-20 backdrop-blur-md">
		<div class="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-4 px-8 py-4">
			<div class="flex items-center gap-4">
				<img src="{base}/logo.svg" alt="zaungast logo" class="h-14 w-14 shrink-0" />
				<div>
					<h1 class="font-heading text-3xl font-semibold tracking-tight">Your Teams, Wrapped</h1>
					<p class="text-muted-foreground text-base">
						See everything Teams knows about you. No one else will.
					</p>
				</div>
			</div>
			<div class="flex items-center gap-4">
				<a
					href="https://github.com/mbe24/zaungast"
					target="_blank"
					rel="noopener noreferrer"
					class="text-muted-foreground hover:text-foreground flex items-center gap-2 text-sm"
				>
					<svg viewBox="0 0 16 16" class="size-5" fill="currentColor" aria-hidden="true">
						<path
							d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"
						/>
					</svg>
					mbe24/zaungast
				</a>
				{#if showThemePicker}
					<label class="text-muted-foreground flex items-center gap-2 text-sm">
						Theme
						<select
							class="border-border bg-card text-foreground rounded-md border px-2 py-1"
							value={theme.id}
							onchange={(e) => setTheme(e.currentTarget.value as ThemeId)}
						>
							{#each themes as t (t.id)}
								<option value={t.id}>{t.name}</option>
							{/each}
						</select>
					</label>
				{/if}
			</div>
		</div>
	</header>

	<main class="mx-auto max-w-[1600px] px-8 py-10">
		{@render children()}
	</main>
</div>
