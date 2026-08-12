<script lang="ts">
	import { Canvas } from '@threlte/core';
	import { NoToneMapping } from 'three';
	import { onMount } from 'svelte';
	import Scene from './Scene.svelte';
	import { game } from './state.svelte';
	import { DAY_SECONDS } from './env';

	let { active = true }: { active?: boolean } = $props();

	// Cap device pixel ratio at 1.5 EVERYWHERE: desktop retina is DPR 2,
	// so the old desktop cap of 2 was a no-op right where the fragment
	// pipeline (underwater raytrace + reflection + foam web) is the frame
	// budget. 1.5 is 44% less fill than 2, and the soft organic water
	// hides the difference at our ortho zoom.
	const dpr = Math.min(window.devicePixelRatio || 1, 1.5);

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
