<script lang="ts">
	import { Canvas } from '@threlte/core';
	import { NoToneMapping } from 'three';
	import { onMount } from 'svelte';
	import Scene from './Scene.svelte';
	import { game } from './state.svelte';
	import { DAY_SECONDS } from './env';

	let { active = true }: { active?: boolean } = $props();

	const mobile = window.innerWidth < 720;
	// Cap device pixel ratio: retina at full DPR doubles fragment work for
	// little visible gain on a faceted low-poly scene.
	const dpr = Math.min(window.devicePixelRatio || 1, mobile ? 1.5 : 2);

	// Debug hook: /?tod=0.5 forces a time of day (0 = midnight, 0.5 = noon).
	const todParam = new URLSearchParams(window.location.search).get('tod');
	if (todParam !== null) {
		const tod = Number(todParam);
		if (Number.isFinite(tod) && tod >= 0 && tod <= 1) game.time = tod * DAY_SECONDS;
	}

	let fps = $state(0);
	onMount(() => {
		if (!import.meta.env.DEV) return;
		let frames = 0;
		let raf = 0;
		const loop = () => {
			frames++;
			raf = requestAnimationFrame(loop);
		};
		raf = requestAnimationFrame(loop);
		const timer = setInterval(() => {
			fps = frames;
			frames = 0;
		}, 1000);
		return () => {
			cancelAnimationFrame(raf);
			clearInterval(timer);
		};
	});
</script>

<div class="stage">
	<Canvas {dpr} toneMapping={NoToneMapping}>
		<Scene {active} />
	</Canvas>
	{#if import.meta.env.DEV}
		<div class="fps">{fps} FPS</div>
	{/if}
</div>

<style>
	.stage {
		position: absolute;
		inset: 0;
	}

	.fps {
		position: absolute;
		top: 8px;
		left: 8px;
		font-family: var(--font-mono);
		font-size: 11px;
		letter-spacing: 0.1em;
		color: var(--faint);
		pointer-events: none;
	}
</style>
