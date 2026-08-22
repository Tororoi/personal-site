<script lang="ts">
	/**
	 * /wave — 2D surf lab. A PIC/FLIP wave tank (flip.ts): Gerstner-driven
	 * generator on the left, flat section, rising bed toward the beach.
	 * Waves grow under wind, ride the tide, drag on the bottom, shoal and
	 * break — all emergent. Solver internals are frozen at tuned values;
	 * the panel is only the physical dials.
	 */
	import { onMount } from 'svelte';
	import { FlipSlice } from './flip';

	const G = 9.81;
	/** Tuned solver internals — deliberately not knobs. */
	const FIXED = {
		crestMode: false,
		domainWaves: 3,
		waveSpeed: 1,
		genStrength: 3,
		genWidth: 0.5,
		flipRatio: 0.9,
		pressureIters: 50,
		stiffness: 1,
		separateIters: 1
	};

	// Tom's tuned defaults, 2026-08-22.
	const k = $state({
		lambda: 64,
		amplitude: 8,
		steepness: 1.3,
		depth: 12,
		slopeStart: 0.45,
		bottomDrag: 0.85,
		windSpeed: 30,
		tide: 3,
		gridNx: 96,
		simSpeed: 3.05,
		vExag: 1,
		follow: false,
		paused: false
	});

	const KNOB_GROUPS: { title: string; rows: [keyof typeof k, number, number, number][] }[] = [
		{
			title: 'tank (reseeds)',
			rows: [
				['lambda', 8, 120, 1],
				['amplitude', 0.05, 8, 0.05],
				['depth', 4, 40, 1],
				['slopeStart', 0.1, 1, 0.05],
				['gridNx', 64, 192, 32]
			]
		},
		{
			title: 'sea (live)',
			rows: [
				['steepness', 0, 1.3, 0.01],
				['bottomDrag', 0, 5, 0.05],
				['windSpeed', 0, 30, 0.5],
				['tide', 0, 3, 0.05]
			]
		},
		{
			title: 'display',
			rows: [
				['simSpeed', 0, 5, 0.05],
				['vExag', 0.5, 10, 0.5]
			]
		}
	];

	const slice = new FlipSlice();
	let t = 0;
	let seededAt = { lambda: 0, amplitude: 0, depth: 0, slopeStart: 0, gridNx: 0 };
	let canvas: HTMLCanvasElement;
	let stats = $state({ c: 0, particles: 0, ms: 0 });

	function flipParams() {
		return {
			...FIXED,
			lambda: k.lambda,
			amp: k.amplitude,
			steepness: k.steepness,
			depth: k.depth,
			slopeStart: k.slopeStart,
			gridNx: k.gridNx,
			bottomDrag: k.bottomDrag,
			windSpeed: k.windSpeed,
			tide: k.tide
		};
	}

	function reseed() {
		slice.seed(flipParams(), t);
		seededAt = {
			lambda: k.lambda,
			amplitude: k.amplitude,
			depth: k.depth,
			slopeStart: k.slopeStart,
			gridNx: k.gridNx
		};
	}

	function stepFrame() {
		// Fast-forward buys substeps, never a CFL-breaking timestep.
		const sub = Math.max(1, Math.ceil(k.simSpeed));
		const dt = ((1 / 60) * k.simSpeed) / sub;
		const p = flipParams();
		for (let s = 0; s < sub; s++) {
			slice.step(dt, t, p);
			t += dt;
		}
	}

	onMount(() => {
		const ctx = canvas.getContext('2d')!;
		reseed();
		let raf = 0;
		function frame() {
			raf = requestAnimationFrame(frame);
			if (
				k.lambda !== seededAt.lambda ||
				k.amplitude !== seededAt.amplitude ||
				k.depth !== seededAt.depth ||
				k.slopeStart !== seededAt.slopeStart ||
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

		const domain = k.lambda * FIXED.domainWaves;
		const kk = (2 * Math.PI) / k.lambda;
		const dd = slice.depthEff || k.depth;
		const omega = Math.sqrt(G * kk * Math.tanh(kk * dd));
		const c = omega / kk;

		// Follow: a 2-wavelength window riding at phase speed — surf one
		// crest from the generator to the beach, then wrap back.
		const view = k.follow ? 2 * k.lambda : domain;
		const viewL = k.follow ? ((c * t) % domain) - k.lambda : 0;
		const pxPerM = W / view;
		const midY = H * 0.45;
		const yOf = (y: number) => midY - y * pxPerM * k.vExag;
		const xOf = (x: number) => (x - viewL) * pxPerM;

		// Particles as raw pixels (fillRect at these counts would crawl).
		const img = ctx.createImageData(PW, PH);
		const data = img.data;
		const vmax = Math.max(k.amplitude * omega * 2, 4);
		for (let i = 0; i < slice.numP; i++) {
			const relY = slice.py[i] - slice.surfaceY;
			const speed = Math.hypot(slice.pu[i], slice.pv[i]);
			const f = Math.min(speed / vmax, 1);
			const r = 70 + 185 * f;
			const g = 120 + 130 * f;
			const b = 220 + 35 * f;
			const sx = Math.round(xOf(slice.px[i]) * dpr);
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
		ctx.putImageData(img, 0, 0);

		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

		// The bed (filled) and the waterline.
		ctx.fillStyle = 'rgba(122, 96, 68, 0.55)';
		ctx.beginPath();
		ctx.moveTo(xOf(0), H);
		for (let i = 0; i <= slice.nx; i++) {
			const x = i * slice.h;
			ctx.lineTo(xOf(x), yOf(slice.bedY[i] - slice.surfaceY));
		}
		ctx.lineTo(xOf(slice.width), H);
		ctx.closePath();
		ctx.fill();
		ctx.strokeStyle = 'rgba(120, 140, 160, 0.35)';
		ctx.lineWidth = 1;
		ctx.beginPath();
		ctx.moveTo(0, yOf(0));
		ctx.lineTo(W, yOf(0));
		ctx.stroke();

		// The Gerstner ghost: the analytic surface the generator drives —
		// primary + steepness-scaled bound harmonic + tide, same phases as
		// the forcing. It knows nothing about the slope, wind, or drag, so
		// wherever the particles leave this line, that gap is what the
		// fluid sim is adding.
		{
			const k1 = kk;
			const om1 = omega;
			const a1 = k.amplitude;
			const k2 = 2 * k1;
			const om2 = 2 * om1;
			const a2 = 0.5 * k.steepness * k1 * a1 * a1;
			const kt = (2 * Math.PI) / (10 * k.lambda);
			const omt = Math.sqrt(G * kt * Math.tanh(kt * dd));
			const at = k.tide;
			ctx.strokeStyle = 'rgba(170, 185, 200, 0.65)';
			ctx.lineWidth = 1.5;
			ctx.beginPath();
			const M = 900;
			for (let j = 0; j <= M; j++) {
				const x = viewL + (j / M) * view;
				const y =
					a1 * Math.sin(k1 * x - om1 * t) +
					a2 * Math.sin(k2 * x - om2 * t) +
					at * Math.sin(kt * x - omt * t);
				const sx = (j / M) * W;
				const sy = yOf(y);
				if (j === 0) ctx.moveTo(sx, sy);
				else ctx.lineTo(sx, sy);
			}
			ctx.stroke();
		}

		stats = { c, particles: slice.numP, ms: slice.lastStepMs };
	}
</script>

<svelte:head><title>surf lab</title></svelte:head>

<div class="page">
	<div class="panel">
		<div class="head">
			<strong>surf lab</strong>
			<button onclick={() => (k.paused = !k.paused)}>{k.paused ? 'run' : 'pause'}</button>
			<button onclick={stepFrame}>step</button>
			<button onclick={reseed}>seed</button>
		</div>
		<div class="head">
			<label><input type="checkbox" bind:checked={k.follow} /> follow</label>
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
		<div class="row"><span class="name">particles</span><span class="val">{stats.particles}</span></div>
		<div class="row"><span class="name">step</span><span class="val">{stats.ms.toFixed(1)} ms</span></div>
		<p class="note">
			PIC/FLIP wave tank: generator left, beach right, everything else
			emergent. steepness adds the bound Stokes harmonic to generated
			crests (sharper, break sooner). bottomDrag is bed friction — it
			shapes the surf zone and the undertow. windSpeed grows waves
			with fetch (slope-keyed sheltering; no growth unless wind
			outruns the wave, c in the readout). tide is a 10-lambda swell:
			the level breathes and the break point migrates. follow rides a
			2-lambda window at phase speed — surf one wave to the beach.
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
