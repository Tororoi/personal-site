<script lang="ts">
	import '../app.css';
	import { page } from '$app/state';
	import Nav from '$lib/components/Nav.svelte';
	import Footer from '$lib/components/Footer.svelte';
	import type { Component } from 'svelte';

	let { children } = $props();

	const path = $derived(page.url.pathname);
	const onHome = $derived(path === '/');
	// Home reserves the full viewport for the game; the resume ends on its paper blocks.
	const showFooter = $derived(!(onHome || path.startsWith('/resume')));

	// The game mounts here, not in the home page component, so its canvas and
	// WebGL context survive navigation: leaving / hides the stage and stops the
	// loop, returning shows it again with everything still loaded. three.js is
	// dynamically imported on first visit to /, so content routes never ship it.
	let Game = $state<Component<{ active: boolean }> | null>(null);

	$effect(() => {
		if (!onHome || Game) return;
		if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
		import('$lib/game/Game.svelte').then((module) => (Game = module.default));
	});
</script>

<div class="shell">
	<Nav />
	<div class="game-stage" class:off={!onHome}>
		{#if Game}
			<Game active={onHome} />
		{:else if onHome}
			<span class="placeholder">[ GAME STAGE ]</span>
		{/if}
	</div>
	{@render children()}
	{#if showFooter}
		<Footer />
	{/if}
</div>

<style>
	.game-stage {
		flex: 1;
		position: relative;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.game-stage.off {
		display: none;
	}

	.placeholder {
		font-family: var(--font-mono);
		font-size: 12px;
		letter-spacing: 0.14em;
		color: var(--faint);
	}
</style>
