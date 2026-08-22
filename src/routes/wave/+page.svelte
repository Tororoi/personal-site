<script lang="ts">
	/**
	 * /wave — 2D CROSS-SECTION LAB.
	 *
	 * Two layers on one canvas:
	 *   - the analytic Gerstner trochoid (grey ghost) — what linear theory
	 *     says the wave is doing;
	 *   - a 2D PIC/FLIP particle fluid (flip.ts), SEEDED from that wave —
	 *     particles start on exact Gerstner orbits, then gravity and
	 *     incompressibility own them.
	 *
	 * The first rung of the hybrid plan: if the coupling premise is sound,
	 * a moderate wave propagates and tracks the ghost; a steep one
	 * self-steepens, leans, and genuinely overturns — the shape a
	 * heightfield can never make. Everything is live; wave/grid knob
	 * changes re-seed automatically (the sim is an initial-value
	 * experiment, so a changed wave means a fresh start).
	 */
	import { onMount } from 'svelte';
	import { INSPECT } from '$lib/game/tuning';
	import { FlipSlice } from './flip';

	const G = 9.81;

	const k = $state({
		lambda: INSPECT.simpleLambdaM,
		amp: INSPECT.simpleAmpM,
		depth: 20,
		gridNx: 128,
		flipRatio: 0.9,
		pressureIters: 50,
		stiffness: 1,
		separateIters: 1,
		substeps: 1,
		simSpeed: 1,
		vExag: 2,
		showGhost: true,
		follow: true,
		paused: false
	});

	const KNOB_GROUPS: { title: string; rows: [keyof typeof k, number, number, number][] }[] = [
		{
			title: 'wave (reseeds)',
			rows: [
				['lambda', 8, 120, 1],
				['amp', 0.05, 8, 0.05],
				['depth', 4, 40, 1],
				['gridNx', 64, 256, 32]
			]
		},
		{
			title: 'flip',
			rows: [
				['flipRatio', 0, 1, 0.01],
				['pressureIters', 10, 120, 5],
				['stiffness', 0, 3, 0.05],
				['separateIters', 0, 2, 1],
				['substeps', 1, 4, 1]
			]
		},
		{
			title: 'display',
			rows: [
				['simSpeed', 0, 2, 0.05],
				['vExag', 0.5, 10, 0.5]
			]
		}
	];

	const slice = new FlipSlice();
	let t = 0;
	let seededAt = { lambda: 0, amp: 0, depth: 0, gridNx: 0 };
	let canvas: HTMLCanvasElement;
	let stats = $state({ c: 0, particles: 0, ms: 0, steep: 0 });

	function flipParams() {
		return {
			lambda: k.lambda,
			amp: k.amp,
			depth: k.depth,
			gridNx: k.gridNx,
			flipRatio: k.flipRatio,
			pressureIters: k.pressureIters,
			stiffness: k.stiffness,
			separateIters: Math.round(k.separateIters)
		};
	}

	function reseed() {
		slice.seed(flipParams(), t);
		seededAt = {
			lambda: k.lambda,
			amp: k.amp,
			depth: k.depth,
			gridNx: k.gridNx
		};
	}

	function stepFrame() {
		const sub = Math.max(1, Math.round(k.substeps));
		const dt = ((1 / 60) * k.simSpeed) / sub;
		for (let s = 0; s < sub; s++) slice.step(dt, flipParams());
		t += (1 / 60) * k.simSpeed;
	}

	onMount(() => {
		const ctx = canvas.getContext('2d')!;
		reseed();
		let raf = 0;
		function frame() {
			raf = requestAnimationFrame(frame);
			if (
				k.lambda !== seededAt.lambda ||
				k.amp !== seededAt.amp ||
				k.depth !== seededAt.depth ||
				k.gridNx !== seededAt.gridNx
			) {
				reseed();
			}
			if (!k.paused && k.simSpeed > 0) stepFrame();
			draw(ctx);
		}
		frame();
		return () => cancelAnimationFrame(raf);
	});

	function draw(ctx: CanvasRenderingContext2D) {
		const dpr = window.devicePixelRatio || 1;
		const W = canvas.clientWidth;
		const H = canvas.clientHeight;
		if (canvas.width !== W * dpr || canvas.height !== H * dpr) {
			canvas.width = W * dpr;
			canvas.height = H * dpr;
		}
		const PW = canvas.width;
		const PH = canvas.height;

		const view = 2 * k.lambda;
		const kk = (2 * Math.PI) / k.lambda;
		const omega = Math.sqrt(G * kk);
		const a = k.amp;
		const c = omega / kk;
		const pxPerM = W / view;
		const midY = H * 0.45;
		const yOf = (y: number) => midY - y * pxPerM * k.vExag;
		const viewX = k.follow ? ((c * t) % view) - view / 2 : 0;
		const xOf = (x: number) => ((((x - viewX) % view) + view) % view) * pxPerM;

		// Particles via raw pixels: ~25k dots per frame is nothing for an
		// ImageData plot and would crawl as fillRect calls.
		const img = ctx.createImageData(PW, PH);
		const data = img.data;
		const vmax = Math.max(a * omega * 2, 4);
		for (let i = 0; i < slice.numP; i++) {
			const relY = slice.py[i] - slice.surfaceY;
			const speed = Math.hypot(slice.pu[i], slice.pv[i]);
			const f = Math.min(speed / vmax, 1);
			const r = 70 + 185 * f;
			const g = 120 + 130 * f;
			const b = 220 + 35 * f;
			for (let tile = 0; tile < 2; tile++) {
				const sx = Math.round(xOf(slice.px[i] + tile * k.lambda) * dpr);
				const sy = Math.round(yOf(relY) * dpr);
				for (let ox = 0; ox < 2; ox++) {
					for (let oy = 0; oy < 2; oy++) {
						const xx = sx + ox;
						const yy = sy + oy;
						if (xx < 0 || xx >= PW || yy < 0 || yy >= PH) continue;
						const idx = (yy * PW + xx) * 4;
						data[idx] = r;
						data[idx + 1] = g;
						data[idx + 2] = b;
						data[idx + 3] = 255;
					}
				}
			}
		}
		ctx.putImageData(img, 0, 0);

		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

		// Floor and waterline.
		ctx.strokeStyle = 'rgba(150, 120, 90, 0.6)';
		ctx.lineWidth = 1;
		ctx.beginPath();
		ctx.moveTo(0, yOf(-k.depth));
		ctx.lineTo(W, yOf(-k.depth));
		ctx.stroke();
		ctx.strokeStyle = 'rgba(120, 140, 160, 0.35)';
		ctx.beginPath();
		ctx.moveTo(0, yOf(0));
		ctx.lineTo(W, yOf(0));
		ctx.stroke();

		// The analytic ghost: where linear theory says the surface is.
		if (k.showGhost) {
			ctx.strokeStyle = 'rgba(160, 175, 190, 0.7)';
			ctx.lineWidth = 1.5;
			ctx.beginPath();
			let prevSx = -1e9;
			const M = 900;
			for (let j = 0; j <= M; j++) {
				const rest = (j / M) * view;
				const theta = kk * rest - omega * t;
				const sx = xOf(rest + a * Math.cos(theta));
				const sy = yOf(a * Math.sin(theta));
				if (Math.abs(sx - prevSx) > W / 2) ctx.moveTo(sx, sy);
				else ctx.lineTo(sx, sy);
				prevSx = sx;
			}
			ctx.stroke();
		}

		stats = { c, particles: slice.numP, ms: slice.lastStepMs, steep: kk * a };
	}
</script>

<svelte:head><title>wave cross-section</title></svelte:head>

<div class="page">
	<div class="panel">
		<div class="head">
			<strong>wave lab</strong>
			<button onclick={() => (k.paused = !k.paused)}>{k.paused ? 'run' : 'pause'}</button>
			<button onclick={stepFrame}>step</button>
			<button onclick={reseed}>seed</button>
		</div>
		<div class="head">
			<label><input type="checkbox" bind:checked={k.follow} /> follow</label>
			<label><input type="checkbox" bind:checked={k.showGhost} /> ghost</label>
		</div>
		{#each KNOB_GROUPS as g (g.title)}
			<div class="group">{g.title}</div>
			{#each g.rows as [key, min, max, step] (key)}
				<div class="row">
					<span class="name">{key}</span>
					<input type="range" {min} {max} {step} bind:value={k[key] as number} />
					<span class="val">{(k[key] as number).toFixed(2)}</span>
				</div>
			{/each}
		{/each}
		<div class="group">readout</div>
		<div class="row"><span class="name">phase c</span><span class="val">{stats.c.toFixed(2)} m/s</span></div>
		<div class="row"><span class="name">steepness ka</span><span class="val">{stats.steep.toFixed(2)}</span></div>
		<div class="row"><span class="name">particles</span><span class="val">{stats.particles}</span></div>
		<div class="row"><span class="name">step</span><span class="val">{stats.ms.toFixed(1)} ms</span></div>
		<p class="note">
			2D PIC/FLIP (flip.ts) seeded from a TRUE trochoid (circular
			orbits, radius = amp — the volume-preserving Gerstner; the game's
			q-scaled sway is not, and detonates the solver). Steepness is
			k*amp: raise amp or drop lambda. Deep-water crests let go around
			ka 0.3-0.44; the trochoid loops at 1. Grey ghost = linear theory.
			Wave/grid knobs re-seed; flip knobs act live. x is periodic over
			one wavelength (drawn twice).
		</p>
	</div>
	<canvas bind:this={canvas}></canvas>
</div>

<style>
	:global(html, body) {
		margin: 0;
		background: #10161c;
	}
	.page {
		display: flex;
		height: 100vh;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 12px;
		color: #cfd8e0;
	}
	.panel {
		width: 300px;
		flex: none;
		overflow-y: auto;
		padding: 10px 12px;
		background: #161e26;
		border-right: 1px solid #263340;
	}
	.head {
		display: flex;
		gap: 8px;
		align-items: center;
		margin-bottom: 6px;
	}
	.head button {
		background: #263340;
		color: inherit;
		border: none;
		border-radius: 3px;
		padding: 3px 8px;
		font: inherit;
		cursor: pointer;
	}
	.group {
		margin: 10px 0 2px;
		color: #7fd4a0;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		font-size: 10px;
	}
	.row {
		display: flex;
		align-items: center;
		gap: 6px;
		margin: 2px 0;
	}
	.name {
		width: 92px;
		flex: none;
		color: #9fb0c0;
	}
	.row input[type='range'] {
		flex: 1;
		min-width: 0;
	}
	.val {
		width: 52px;
		flex: none;
		text-align: right;
		font-variant-numeric: tabular-nums;
	}
	.note {
		margin-top: 12px;
		color: #7f8ea0;
		line-height: 1.5;
	}
	canvas {
		flex: 1;
		height: 100vh;
		display: block;
	}
</style>
