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
	import { BREAKER } from '$lib/game/tuning';

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

	/**
	 * BREAKER LAB — one Gerstner wave in cross-section, with and without
	 * the crest-pitch tilt (tuning.ts BREAKER).
	 *
	 * Seeded from the live BREAKER values so it opens showing whatever
	 * the game is set to, then owned locally: this is a place to find
	 * numbers, not a second way to set them. Transfer what works.
	 */
	// Tom's tuned breaker, 2026-08-29. jStart == jFull collapses the
	// automatic trigger to a step, which is deliberate here: scrub is
	// driving the break amount directly while the SHAPE is being tuned.
	const bk = $state({
		bendDeg: 235,
		bendPow: 5,
		jStart: 0,
		jFull: 0,
		lambda: 37,
		amp: 5.5,
		q: 1,
		/** Half-width of the rotated window, radians of phase. */
		lipWindow: 3.14,
		/** Hinge depth below the crest, in amplitudes. 1 = still line. */
		pivotFrac: 1,
		/** Force the break amount instead of reading it from J. -1 = auto. */
		scrub: 0.4,
		ghosts: 5,
		showPlain: true
	});

	const BREAKER_ROWS: [keyof typeof bk, number, number, number][] = [
		['bendDeg', 0, 360, 1],
		['bendPow', 0.2, 6, 0.1],
		['jStart', -0.5, 1, 0.01],
		['jFull', -1, 0.6, 0.01],
		['lambda', 8, 120, 1],
		['amp', 0.1, 12, 0.1],
		['q', 0, 1.5, 0.02],
		['lipWindow', 0.2, 3.14, 0.02],
		['pivotFrac', 0, 3, 0.05],
		['scrub', -1, 1, 0.01],
		['ghosts', 0, 8, 1]
	];

	/**
	 * One wave, evaluated at rest coordinate u, in the (x, y) plane.
	 * Mirrors displace() and waveDisplacement(): the same Jacobian
	 * trigger and the same shortest-arc rotation, reduced to 2D where
	 * that rotation is a plain angle.
	 */
	function breakerPoint(u: number, time: number, forceB = -1) {
		const kk = (2 * Math.PI) / bk.lambda;
		const omega = Math.sqrt(G * kk);
		const theta = u * kk - omega * time;
		const sn = Math.sin(theta);
		const px = u + bk.q * bk.amp * Math.cos(theta);
		const py = bk.amp * sn;
		// One wave travelling +x: jzz = 1 and jxz = 0, so the determinant
		// is just jxx. At the crest this is 1 - q*A*k, the classic
		// Gerstner steepness limit.
		const J = 1 - bk.q * bk.amp * kk * sn;
		let b: number;
		if (forceB >= 0) b = forceB;
		else {
			const span = Math.max(bk.jStart - bk.jFull, 0.0001);
			const raw = Math.min(Math.max((bk.jStart - J) / span, 0), 1);
			b = raw * raw * (3 - 2 * raw);
		}

		// RIGID ROTATION of the crest region about the crest tip.
		//
		// The previous attempt rotated every point about its OWN vertical,
		// which is a shear: the forward shift was h*sin(phi), the same for
		// the front and back faces at equal height, so the crest swung
		// straight through a front face that never moved. A rigid rotation
		// cannot self-intersect — it is an isometry — and it produces the
		// right shape for free: the front face tucks UNDER as the back
		// face steepens, which is the barrel.
		//
		// Windowed by phase so the rotation fades to nothing before the
		// trough, where the water must still meet the neighbouring wave.
		// Only the window edges can distort, and only gently.
		// Signed phase from the nearest crest, in [-pi, pi].
		//
		// FLOOR, not %. JavaScript's remainder keeps the sign of the
		// dividend, so for negative phase it returns a negative value and
		// psi lands a full turn off — failing the window test everywhere
		// the phase happened to be negative, which is why the bend showed
		// on one crest and not the rest. (GLSL's mod() is always positive,
		// so the shader twin will not need this.)
		const TWO_PI = 2 * Math.PI;
		const raw0 = theta - Math.PI / 2 + Math.PI;
		const psi = raw0 - TWO_PI * Math.floor(raw0 / TWO_PI) - Math.PI;
		const w = Math.max(bk.lipWindow, 0.01);
		let phi = 0;
		if (Math.abs(psi) < w) {
			const wf = Math.cos(((psi / w) * Math.PI) / 2);
			phi = ((bk.bendDeg * Math.PI) / 180) * b * Math.pow(wf, bk.bendPow);
		}
		// HINGE, not the tip. Rotating about the crest tip pinned the one
		// point that should travel furthest — a plunging lip is thrown
		// forward and down, and it is the tip that lands. Putting the
		// pivot down in the wave body gives the tip the longest lever, so
		// it swings out over the face and comes down ahead of it.
		//
		// pivotFrac 0 keeps the old behaviour (hinge at the tip), 1 puts
		// it on the still-water line, past 1 below that. With the hinge at
		// the still line and phi at 90 the tip lands one amplitude forward
		// and level with the water; more than that drives it into the face.
		const uCrest = (theta - psi + omega * time) / kk;
		const cxp = uCrest;
		const cyp = bk.amp * (1 - bk.pivotFrac);
		const rx = px - cxp;
		const ry = py - cyp;
		const cs = Math.cos(phi);
		const sf = Math.sin(phi);
		return {
			plainX: px,
			plainY: py,
			x: cxp + (rx * cs + ry * sf),
			y: cyp + (-rx * sf + ry * cs),
			J,
			b
		};
	}

	const slice = new FlipSlice();
	let t = 0;
	let seededAt = { lambda: 0, amplitude: 0, depth: 0, slopeStart: 0, gridNx: 0 };
	let canvas: HTMLCanvasElement;
	let bcanvas: HTMLCanvasElement | undefined = $state();
	let stats = $state({ c: 0, particles: 0, ms: 0 });
	let bstats = $state({ maxB: 0, minJ: 1 });
	/** Which graph is on screen. Only the visible one is stepped or drawn:
	 *  a hidden canvas has zero client size, and sizing to that would
	 *  leave it blank when it came back. */
	let tab: 'tank' | 'bend' = $state('bend');

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

	function drawBreaker(ctx: CanvasRenderingContext2D) {
		if (!bcanvas) return;
		const dpr = window.devicePixelRatio || 1;
		const W = bcanvas.clientWidth;
		const H = bcanvas.clientHeight;
		if (bcanvas.width !== W * dpr || bcanvas.height !== H * dpr) {
			bcanvas.width = W * dpr;
			bcanvas.height = H * dpr;
		}
		const PW = bcanvas.width;
		const PH = bcanvas.height;
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, PW, PH);
		ctx.fillStyle = '#0d1319';
		ctx.fillRect(0, 0, PW, PH);

		const span = bk.lambda * 2;
		const sx = PW / span;
		// Vertical scale leaves room for a crest that has pitched over.
		const sy = Math.min(sx, PH / (bk.amp * 6));
		const y0 = PH * 0.55;
		const px = (wx: number) => wx * sx;
		const py = (wy: number) => y0 - wy * sy;

		// Still-water line.
		ctx.strokeStyle = '#22303e';
		ctx.lineWidth = dpr;
		ctx.beginPath();
		ctx.moveTo(0, py(0));
		ctx.lineTo(PW, py(0));
		ctx.stroke();

		const N = 700;
		// PROGRESSION. A breaking wave is not a fixed shape sliding past —
		// it develops. These ghosts are the SAME wave at successive break
		// amounts, faintest first, so the curl's whole life is on screen
		// at once instead of having to be caught as it happens.
		for (let g = 1; g <= bk.ghosts; g++) {
			const bg = g / (bk.ghosts + 1);
			ctx.strokeStyle = `rgba(224, 163, 62, ${(0.12 + 0.18 * bg).toFixed(3)})`;
			ctx.lineWidth = dpr;
			ctx.beginPath();
			for (let i = 0; i <= N; i++) {
				const p = breakerPoint((i / N) * span, t, bg);
				if (i === 0) ctx.moveTo(px(p.x), py(p.y));
				else ctx.lineTo(px(p.x), py(p.y));
			}
			ctx.stroke();
		}

		// The untilted wave, for comparison.
		if (bk.showPlain) {
			ctx.strokeStyle = '#3d5468';
			ctx.lineWidth = dpr;
			ctx.beginPath();
			for (let i = 0; i <= N; i++) {
				const p = breakerPoint((i / N) * span, t);
				if (i === 0) ctx.moveTo(px(p.plainX), py(p.plainY));
				else ctx.lineTo(px(p.plainX), py(p.plainY));
			}
			ctx.stroke();
		}

		// The tilted wave, coloured by how far into breaking it is.
		ctx.lineWidth = 2 * dpr;
		const forced = bk.scrub >= 0 ? bk.scrub : -1;
		let prev = breakerPoint(0, t, forced);
		let maxB = 0;
		let minJ = 1;
		for (let i = 1; i <= N; i++) {
			const p = breakerPoint((i / N) * span, t, forced);
			maxB = Math.max(maxB, p.b);
			minJ = Math.min(minJ, p.J);
			// Amber where it is pitching, red once the surface has folded.
			ctx.strokeStyle = p.J < 0 ? '#e05a4a' : p.b > 0.01 ? '#e0a33e' : '#5fd6e6';
			ctx.beginPath();
			ctx.moveTo(px(prev.x), py(prev.y));
			ctx.lineTo(px(p.x), py(p.y));
			ctx.stroke();
			prev = p;
		}
		bstats.maxB = maxB;
		bstats.minJ = minJ;
	}

	onMount(() => {
		const ctx = canvas.getContext('2d')!;
		const bctx = bcanvas?.getContext('2d') ?? null;
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
			if (tab === 'tank') {
				if (!k.paused && k.simSpeed > 0) stepFrame();
				draw(ctx);
			} else {
				// The bend graph animates on the same clock the tank uses.
				if (!k.paused && k.simSpeed > 0) t += (1 / 60) * k.simSpeed;
				if (bctx) drawBreaker(bctx);
			}
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
		{#if tab === 'tank'}
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
		{:else}
		<div class="group">breaker (BREAKER)</div>
		{#each BREAKER_ROWS as [key, min, max, step] (key)}
			<div class="row">
				<span class="name">{key}</span>
				<input type="range" {min} {max} {step} bind:value={bk[key] as number} />
				<span class="val">{(bk[key] as number).toFixed(2)}</span>
			</div>
		{/each}
		<div class="head">
			<label><input type="checkbox" bind:checked={bk.showPlain} /> show untilted</label>
		</div>
		<div class="row"><span class="name">min J</span><span class="val">{bstats.minJ.toFixed(3)}</span></div>
		<div class="row"><span class="name">max lean</span><span class="val">{bstats.maxB.toFixed(3)}</span></div>
		<p class="note">
			One Gerstner wave in section, bent by BREAKER. The crest
			region rotates forward about the still-water line by an angle
			that grows with height, so the base is pinned and the lip
			swings furthest — a bend, which stays injective, rather than
			Gerstner's overshoot, which passes through itself. Grey is the
			untilted wave, cyan the tilted one below threshold, amber where
			it is pitching, red where J has gone negative and the surface
			has folded through itself. Faint amber ghosts are the SAME wave
			at successive break amounts — the curl's progression, since a
			plunging lip develops rather than translating. scrub forces the
			break amount (-1 reads it from J) to hold one stage still.
			J at the crest is 1 - q*A*k, so
			amplitude, q and a short lambda all drive it toward breaking —
			min J in the readout is the crest's value. lean sets how far a
			fully broken crest pitches; jStart/jFull bracket the Jacobian
			range it ramps over. Seeded from the game's BREAKER values but
			owned here: copy what works back into tuning.ts.
		</p>
		{/if}
		{#if tab === 'tank'}
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
		{/if}
	</div>
	<div class="stack">
		<div class="tabs">
			<button class:on={tab === 'tank'} onclick={() => (tab = 'tank')}>fluid tank</button>
			<button class:on={tab === 'bend'} onclick={() => (tab = 'bend')}>wave bend</button>
		</div>
		<canvas bind:this={canvas} hidden={tab !== 'tank'}></canvas>
		<canvas bind:this={bcanvas} hidden={tab !== 'bend'}></canvas>
	</div>
</div>

<style>
	:global(html, body) {
		margin: 0;
		background: #10161c;
	}
	.stack {
		flex: 1;
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	.stack canvas {
		width: 100%;
		display: block;
		/* Both beat the bare `canvas { height: 100vh }` below: inside this
		   column the canvas fills what the tabs leave, not a viewport. */
		flex: 1;
		min-height: 0;
		height: auto;
	}
	.stack canvas[hidden] {
		display: none;
	}
	.tabs {
		display: flex;
		gap: 1px;
		background: #16202a;
		border-bottom: 1px solid #22303e;
	}
	.tabs button {
		background: #16202a;
		border: 0;
		color: #7d8fa0;
		font: inherit;
		padding: 7px 16px;
		cursor: pointer;
	}
	.tabs button:hover {
		color: #cfd8e0;
	}
	.tabs button.on {
		background: #10161c;
		color: #5fd6e6;
		box-shadow: inset 0 -2px 0 #5fd6e6;
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
