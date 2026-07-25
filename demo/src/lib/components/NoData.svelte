<script lang="ts">
	// Shared empty state for the animated pages (race, rhythms) when the user hasn't picked a cache yet.
	import { base } from '$app/paths';
	import { Button } from '$lib/components/ui/button';
</script>

<div class="flex min-h-[50vh] flex-col items-center justify-center gap-4 text-center">
	<p class="text-muted-foreground text-lg">No data yet — pick your Teams cache folder first.</p>
	<Button href="{base}/" variant="secondary">← Back to start</Button>
</div>
