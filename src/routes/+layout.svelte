<script lang="ts">
	import '../app.css';
	import { page } from '$app/state';
	import Nav from '$lib/components/Nav.svelte';
	import Footer from '$lib/components/Footer.svelte';

	let { children } = $props();

	const path = $derived(page.url.pathname);
	// Home reserves the full viewport for the game; the resume ends on its paper blocks.
	const showFooter = $derived(!(path === '/' || path.startsWith('/resume')));
</script>

<div class="shell">
	<Nav />
	{@render children()}
	{#if showFooter}
		<Footer />
	{/if}
</div>
