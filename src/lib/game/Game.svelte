<script lang="ts">
	import { Canvas } from '@threlte/core';
	import { NoToneMapping, WebGLRenderer } from 'three';
	import { onMount } from 'svelte';
	import Scene from './Scene.svelte';
	import TuningPanel from './TuningPanel.svelte';
	import { game, perf } from './state.svelte';
	import { ENV } from './env';
	import { ENABLE, PROFILE } from './tuning';
	import { recordSample, SAMPLE_MS, startPerfLog } from './perflog';

	let { active = true }: { active?: boolean } = $props();

	// Left undefined unless a switch is on, so the normal path stays
	// exactly Threlte's own default construction.
	const createRenderer =
		PROFILE.noAntialias || PROFILE.opaqueCanvas
			? (canvas: HTMLCanvasElement) =>
					new WebGLRenderer({
						canvas,
						powerPreference: 'high-performance',
						antialias: !PROFILE.noAntialias,
						alpha: !PROFILE.opaqueCanvas
					})
			: undefined;

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
		if (Number.isFinite(tod) && tod >= 0 && tod <= 1) game.time = tod * ENV.daySeconds;
	}

	// Shown in dev OR whenever the tuning panel is up. Tuning happens
	// against a production `preview` build, where import.meta.env.DEV is
	// false — so the readout used to be missing from the one situation
	// that most needs a number rather than an impression.
	const showFps = import.meta.env.DEV || ENABLE.tuningUI;

	let fps = $state(0);
	// Worst frame in the last second. An average hides the stalls that
	// actually read as a struggling framerate; a single 40ms hitch is
	// obvious to the eye and invisible in a 58fps mean.
	let worstMs = $state(0);
	// Mean frame time, and that normalised by drawing-buffer area. The
	// second is the number to compare across ablation runs: fps depends on
	// window size, and this frame scales with area, so ms/Mpx is the only
	// figure that stays meaningful between measurements.
	let avgMs = $state(0);
	const msPerMpx = $derived(
		perf.w * perf.h > 0 ? avgMs / ((perf.w * perf.h) / 1e6) : 0
	);
	onMount(() => {
		if (!showFps) return;
		if (ENABLE.perfLog || PROFILE.buoyLog) startPerfLog(new Date().toISOString());
		let frames = 0;
		let worst = 0;
		let total = 0;
		let last = performance.now();
		let raf = 0;
		// A second, faster accumulator for the log. The 1s display window is
		// far too coarse for a load that swings with foam coverage — by the
		// time it updates, the burst being measured is over.
		let sAcc = 0;
		let sFrames = 0;
		let sWorst = 0;
		const loop = () => {
			const now = performance.now();
			const dt = now - last;
			worst = Math.max(worst, dt);
			total += dt;
			last = now;
			frames++;
			if (ENABLE.perfLog) {
				sAcc += dt;
				sFrames++;
				sWorst = Math.max(sWorst, dt);
				if (sAcc >= SAMPLE_MS) {
					const mpx = (perf.w * perf.h) / 1e6;
					const ms = sAcc / sFrames;
					recordSample({
						fps: Math.round((1000 * sFrames) / sAcc),
						ms: +ms.toFixed(2),
						worst: +sWorst.toFixed(2),
						mpx: +mpx.toFixed(2),
						msPerMpx: mpx > 0 ? +(ms / mpx).toFixed(3) : 0,
						calls: perf.calls,
						tris: perf.tris,
						cpuMs: +perf.taskMs.toFixed(2),
						steps: perf.steps,
						foam: +perf.foam.toFixed(1),
						spray: perf.spray,
						cpuWhitecaps: +perf.cpuWhitecaps.toFixed(2),
						cpuSpray: +perf.cpuSpray.toFixed(2),
						cpuCurrent: +perf.cpuCurrent.toFixed(2),
						cpuRest: +perf.cpuRest.toFixed(2),
						checkRun: perf.checkRun,
						checkSkip: perf.checkSkip,
						sEmit: +perf.sEmit.toFixed(2),
						sScan: +perf.sScan.toFixed(2),
						sTracks: +perf.sTracks.toFixed(2),
						sParticles: +perf.sParticles.toFixed(2)
					});
					sAcc = 0;
					sFrames = 0;
					sWorst = 0;
				}
			}
			raf = requestAnimationFrame(loop);
		};
		raf = requestAnimationFrame(loop);
		const timer = setInterval(() => {
			fps = frames;
			worstMs = worst;
			avgMs = frames ? total / frames : 0;
			frames = 0;
			worst = 0;
			total = 0;
		}, 1000);
		return () => {
			cancelAnimationFrame(raf);
			clearInterval(timer);
		};
	});
</script>

<div class="stage">
	<Canvas {dpr} toneMapping={NoToneMapping} {createRenderer}>
		<Scene {active} />
	</Canvas>
	{#if showFps}
		<div class="fps">
			{fps} FPS · worst {worstMs.toFixed(1)}ms<br />
			{perf.calls} calls · {(perf.tris / 1000).toFixed(0)}k tris<br />
			cpu {perf.taskMs.toFixed(1)}ms · {perf.steps} steps<br />
			{perf.w}×{perf.h} = {((perf.w * perf.h) / 1e6).toFixed(1)}Mpx<br />
			<span class="key">{msPerMpx.toFixed(2)} ms/Mpx</span><br />
			foam {perf.foam.toFixed(0)} · spray {perf.spray}<br />
			wc {perf.cpuWhitecaps.toFixed(1)} · spr {perf.cpuSpray.toFixed(1)} · cur {perf.cpuCurrent.toFixed(1)}
			· rest {perf.cpuRest.toFixed(1)}<br />
			checks {perf.checkRun} run · {perf.checkSkip} skipped<br />
			emit {perf.sEmit.toFixed(1)} · scan {perf.sScan.toFixed(1)} · trk {perf.sTracks.toFixed(1)} · part {perf.sParticles.toFixed(1)}
			{#if ENABLE.gpuProfile}
				<br />
				<span class="warn">profiling — total inflated</span><br />
				ripple {perf.gpuRipple.toFixed(1)} · fft {perf.gpuFft.toFixed(1)}<br />
				caustic {perf.gpuCaustic.toFixed(1)} · foam {perf.gpuFoam.toFixed(1)}
			{/if}
		</div>
	{/if}
	{#if ENABLE.tuningUI}
		<TuningPanel />
	{/if}
</div>

<style>
	.stage {
		position: absolute;
		inset: 0;
	}

	.key {
		color: #8fd4b4;
	}

	.warn {
		color: #d3a34a;
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
