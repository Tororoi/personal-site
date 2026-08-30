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
		lambda: 20,
		amp: 3,
		q: 1,
		/** Half-width of the rotated window, radians of phase. */
		lipWindow: 3.14,
		/** Hinge depth below the crest, in amplitudes. 1 = still line. */
		pivotFrac: 1,
		/**
		 * LIFECYCLE position, 0..1: build, break, collapse. -1 hands
		 * amplitude and break amount back to the sliders.
		 */
		scrub: 0.4,
		/**
		 * Amplitude at which the bend starts, as a fraction of lambda.
		 * Gerstner pinches (J = 0) at A = lambda / (2*pi*q) = 0.159*lambda,
		 * so this defaults there rather than to a tuned constant — the
		 * 20:3 that felt right by eye IS the steepness limit.
		 */
		steepRatio: 0.159,
		/** Lifecycle position where the crest starts to throw. */
		tBreak: 0.62,
		/** How much of the lifecycle the throw occupies. Short on purpose:
		 *  waves build over many periods and collapse inside one. */
		breakSpan: 0.22,
		/** Amplitude left after collapsing, as a fraction of the peak. A
		 *  broken wave becomes a smaller wave, not flat water. */
		collapseTo: 0.45,
		/** How far through the throw the collapse waits before starting,
		 *  0..1 of the bend. The crest holds its height until the tip has
		 *  come round far enough to reach back into the face. */
		collapseLag: 0.35,
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
		['steepRatio', 0.02, 0.3, 0.002],
		['tBreak', 0, 1, 0.01],
		['breakSpan', 0.02, 0.6, 0.01],
		['collapseTo', 0, 1, 0.02],
		['collapseLag', 0, 0.95, 0.01],
		['ghosts', 0, 8, 1]
	];

	/**
	 * One wave, evaluated at rest coordinate u, in the (x, y) plane.
	 * Mirrors displace() and waveDisplacement(): the same Jacobian
	 * trigger and the same shortest-arc rotation, reduced to 2D where
	 * that rotation is a plain angle.
	 */
	/**
	 * The lifecycle: one scrub position to an amplitude and a break
	 * amount. Build to the steepness limit, throw the crest, collapse to
	 * a fraction of the peak.
	 */
	function lifecycle(tau: number) {
		const peak = bk.lambda * bk.steepRatio;
		const bEnd = Math.min(bk.tBreak + bk.breakSpan, 1);
		// Build: ease in so the wave grows fastest as it nears the limit,
		// which is how wind input compounds on an already-steep wave.
		const up = Math.min(Math.max(tau / Math.max(bk.tBreak, 0.0001), 0), 1);
		let amp = peak * up * up * (3 - 2 * up) * (0.35 + 0.65 * up);
		const raw = Math.min(
			Math.max((tau - bk.tBreak) / Math.max(bEnd - bk.tBreak, 0.0001), 0),
			1
		);
		const bThrow = raw * raw * (3 - 2 * raw);
		// COLLAPSE runs on the lifecycle clock, not on the throw's, so it
		// can outlast the throw and unwind gently. It starts collapseLag
		// of the way through the bend — the crest holds its height until
		// the tip has come round far enough to reach back into the face —
		// and finishes at the end of the lifecycle.
		const cStart = bk.tBreak + bk.collapseLag * (bEnd - bk.tBreak);
		const cRaw = Math.min(
			Math.max((tau - cStart) / Math.max(1 - cStart, 0.0001), 0),
			1
		);
		const c = cRaw * cRaw * (3 - 2 * cRaw);
		amp = amp * (1 - c) + peak * bk.collapseTo * c;
		// The bend UNWINDS with the collapse. A wave that has spent itself
		// is a smaller ordinary wave, not a permanently bent one — so the
		// throw has to come back out as the height comes down, leaving the
		// surface where the build had it at the same amplitude.
		const b = bThrow * (1 - c);
		return { amp, b };
	}

	function breakerPoint(u: number, time: number, forceB = -1) {
		const kk = (2 * Math.PI) / bk.lambda;
		const omega = Math.sqrt(G * kk);
		const theta = u * kk - omega * time;
		const sn = Math.sin(theta);
		// Lifecycle drives BOTH amplitude and break amount when scrubbing;
		// the sliders take over at -1.
		const live = bk.scrub >= 0 ? lifecycle(bk.scrub) : null;
		const amp = live ? live.amp : bk.amp;
		const px = u + bk.q * amp * Math.cos(theta);
		const py = amp * sn;
		// One wave travelling +x: jzz = 1 and jxz = 0, so the determinant
		// is just jxx. At the crest this is 1 - q*A*k, the classic
		// Gerstner steepness limit.
		const J = 1 - bk.q * amp * kk * sn;
		let b: number;
		if (forceB >= 0) b = forceB;
		else if (live) b = live.b;
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
		const cyp = amp * (1 - bk.pivotFrac);
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

	/**
	 * STOKES LAB — linear vs Gerstner vs Stokes at matched steepness.
	 *
	 * The distillation of the HOS paper's physics into something a line
	 * graph can show. HOS solves fully nonlinear potential flow
	 * numerically; for a REGULAR wave it converges to Stokes, which has a
	 * closed form. So this is the same nonlinearity HOS computes, in the
	 * one case where it can be written down.
	 *
	 * What it answers: how much of a sharpened crest is real nonlinearity
	 * and how much is Gerstner's trochoid, which sharpens for a different
	 * reason (horizontal particle crowding) and by a different amount.
	 */
	const st = $state({
		lambda: 40,
		/** Steepness ka. Stokes' limiting value is ~0.443 (H/lambda = 1/7),
		 *  past which no steady wave exists and the crest angle hits 120. */
		eps: 0.25,
		/** Gerstner's own steepness parameter, for the comparison curve. */
		q: 1,
		order: 3,
		showLinear: true,
		showGerstner: true
	});

	const STOKES_ROWS: [keyof typeof st, number, number, number][] = [
		['lambda', 8, 120, 1],
		['eps', 0, 0.443, 0.005],
		['q', 0, 1.5, 0.02],
		['order', 1, 3, 1]
	];

	/**
	 * Deep-water Stokes elevation to third order (Dean & Dalrymple):
	 *   eta = a cos t + (1/2) k a^2 cos 2t + (3/8) k^2 a^3 cos 3t
	 * Written in steepness so the harmonics read as what they are: the
	 * second raises the crest and fills the trough, the third sharpens.
	 */
	function stokesEta(theta: number, a: number, eps: number, order: number) {
		let e = Math.cos(theta);
		if (order >= 2) e += (eps / 2) * Math.cos(2 * theta);
		if (order >= 3) e += ((3 * eps * eps) / 8) * Math.cos(3 * theta);
		return a * e;
	}

	/**
	 * PACKET LAB — one Lagrangian wave packet.
	 *
	 * The primitive the third family is built from (Wave Particles,
	 * Water Wave Packets, Wave Curves): not a field sampled on a grid but
	 * a closed-form function you can evaluate anywhere and SUM, which is
	 * why it fits an engine whose physics probes arbitrary points.
	 *
	 *   eta(x,t) = A * exp(-(x - cg t)^2 / 2 sigma^2) * cos(k(x - c t))
	 *
	 * Two speeds, and the gap between them is the whole point. The
	 * CARRIER moves at the phase speed c = sqrt(g/k); the ENVELOPE moves
	 * at the group speed cg = dw/dk, which in deep water is exactly half
	 * of it. Crests are born at the back of the packet, run forward
	 * through it, and die at the front — something no plane-wave sum can
	 * express, since a plane wave has nowhere for a crest to be born.
	 *
	 * The packet also SPREADS, because its component wavenumbers travel
	 * at different speeds. That is real dispersion, carried by a handful
	 * of numbers rather than a simulation.
	 */
	const pk = $state({
		lambda: 30,
		amp: 2,
		/** Envelope half-width at birth, metres. */
		width: 25,
		/** Domain shown, metres. */
		spanM: 400,
		/** Dispersive spreading, x1 = the physical rate. */
		spread: 1,
		ghosts: 4,
		showEnvelope: true
	});

	const PACKET_ROWS: [keyof typeof pk, number, number, number][] = [
		['lambda', 4, 80, 1],
		['amp', 0.2, 8, 0.1],
		['width', 5, 120, 1],
		['spanM', 100, 900, 10],
		['spread', 0, 6, 0.1],
		['ghosts', 0, 8, 1]
	];

	/** Packet state at a given age: centre, width, and the two speeds. */
	function packetAt(age: number) {
		const kk = (2 * Math.PI) / pk.lambda;
		const omega = Math.sqrt(G * kk);
		const c = omega / kk;
		// Deep water: w = sqrt(gk), so dw/dk = c/2 exactly.
		const cg = c / 2;
		// Second derivative of w(k) sets how fast a packet spreads. Same
		// algebra as a quantum wave packet — dispersion does not care what
		// is doing the waving.
		const d2 = -0.25 * Math.sqrt(G) * Math.pow(kk, -1.5) * pk.spread;
		const sigma =
			pk.width * Math.sqrt(1 + Math.pow((d2 * age) / (2 * pk.width * pk.width), 2));
		return { kk, omega, c, cg, sigma, centre: cg * age };
	}

	function packetEta(x: number, age: number) {
		const p = packetAt(age);
		const env = pk.amp * Math.exp(-Math.pow(x - p.centre, 2) / (2 * p.sigma * p.sigma));
		return { y: env * Math.cos(p.kk * (x - p.c * age)), env };
	}

	/**
	 * RAY LAB — wave packets refracting over the island's shoal, seen
	 * from above.
	 *
	 * This is the step that plane waves cannot do. A Gerstner wave's
	 * phase is k.x - wt with k CONSTANT; to bend it you need k to vary
	 * with position, and then phase is no longer k.x but the integral of
	 * k along the path. Vary k per-position without that integral and the
	 * phase tears. Refraction is not a missing feature of plane waves, it
	 * is incompatible with what a plane wave is.
	 *
	 * A packet is somewhere, so it can carry its own k and have it bent.
	 * Nothing here implements refraction: it integrates the ray equations
	 * and refraction is what comes out.
	 */
	const ray = $state({
		/** Incoming bearing, degrees, in the game's compass. */
		bearing: 250,
		/** Wave period, seconds. Sets omega, which is conserved along a
		 *  ray — depth then decides k, and the gradient of k does the
		 *  bending. */
		periodS: 8,
		count: 24,
		/** Integration step, seconds of packet time. */
		stepS: 0.4,
		steps: 260,
		/** Depth in open water, metres. */
		depthM: 10,
		showCrests: true,
		showDepth: true
	});

	const RAY_ROWS: [keyof typeof ray, number, number, number][] = [
		['bearing', 0, 359, 1],
		['periodS', 2, 20, 0.5],
		['count', 4, 60, 1],
		['stepS', 0.05, 1.5, 0.05],
		['steps', 40, 600, 20],
		['depthM', 2, 40, 1]
	];

	/** The island's shoal, in the ray lab's own local frame: the tile
	 *  centre is the origin. Chebyshev, matching the game. */
	function rayDepth(x: number, z: number) {
		const d = Math.max(Math.abs(x), Math.abs(z));
		const edge = 50;
		const rampTo = 100;
		const f = Math.min(Math.max((d - edge) / (rampTo - edge), 0), 1);
		// Never exactly zero: k diverges as depth does, and a ray that
		// reaches dry land has nothing left to integrate.
		return Math.max(f * ray.depthM, 0.15);
	}

	/**
	 * Solve the dispersion relation w^2 = g k tanh(k d) for k, given w
	 * and depth. Newton from the deep-water guess; three passes is exact
	 * to well under a pixel here.
	 */
	function waveNumber(omega: number, depth: number) {
		let k = (omega * omega) / G;
		for (let i = 0; i < 6; i++) {
			const th = Math.tanh(k * depth);
			const f = G * k * th - omega * omega;
			const df = G * th + G * k * depth * (1 - th * th);
			k -= f / df;
			if (k < 1e-6) k = 1e-6;
		}
		return k;
	}

	/** Group velocity: dw/dk of the same relation. */
	function groupSpeed(omega: number, k: number, depth: number) {
		const kd = k * depth;
		const sh = Math.sinh(2 * kd);
		const n = 0.5 * (1 + (2 * kd) / (sh === 0 ? 1e-6 : sh));
		return (omega / k) * n;
	}

	const slice = new FlipSlice();
	let t = 0;
	let seededAt = { lambda: 0, amplitude: 0, depth: 0, slopeStart: 0, gridNx: 0 };
	let canvas: HTMLCanvasElement;
	let bcanvas: HTMLCanvasElement | undefined = $state();
	let scanvas: HTMLCanvasElement | undefined = $state();
	let pcanvas: HTMLCanvasElement | undefined = $state();
	let rcanvas: HTMLCanvasElement | undefined = $state();
	let stats = $state({ c: 0, particles: 0, ms: 0 });
	let bstats = $state({ maxB: 0, minJ: 1, amp: 0, peak: 0 });
	let sstats = $state({ ratio: 1, amp: 0 });
	let pstats = $state({ c: 0, cg: 0, sigma: 0 });
	let rstats = $state({ bendDeg: 0, kDeep: 0, kShore: 0 });
	// Mirrors waves.ts; the lab is standalone so it keeps its own copy.
	const UNIFIED_NORTH_DEG_LOCAL = 315;
	/** Which graph is on screen. Only the visible one is stepped or drawn:
	 *  a hidden canvas has zero client size, and sizing to that would
	 *  leave it blank when it came back. */
	let tab: 'tank' | 'bend' | 'stokes' | 'packet' | 'rays' = $state('bend');

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
		// Scale to the lifecycle PEAK so the wave does not appear to
		// grow and shrink the graph as it builds and collapses.
		const peakAmp = bk.scrub >= 0 ? bk.lambda * bk.steepRatio : bk.amp;
		const sy = Math.min(sx, PH / (peakAmp * 6));
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
			const tau = g / (bk.ghosts + 1);
			// Ghosts walk the whole LIFECYCLE, not just the throw: the
			// build is most of the story, and a set of ghosts that all
			// share one amplitude cannot show it.
			const saved = bk.scrub;
			bk.scrub = tau;
			ctx.strokeStyle = `rgba(224, 163, 62, ${(0.12 + 0.18 * tau).toFixed(3)})`;
			ctx.lineWidth = dpr;
			ctx.beginPath();
			for (let i = 0; i <= N; i++) {
				const p = breakerPoint((i / N) * span, t);
				if (i === 0) ctx.moveTo(px(p.x), py(p.y));
				else ctx.lineTo(px(p.x), py(p.y));
			}
			ctx.stroke();
			bk.scrub = saved;
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
		let prev = breakerPoint(0, t);
		let maxB = 0;
		let minJ = 1;
		for (let i = 1; i <= N; i++) {
			const p = breakerPoint((i / N) * span, t);
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
		const lc = bk.scrub >= 0 ? lifecycle(bk.scrub) : null;
		bstats.amp = lc ? lc.amp : bk.amp;
		bstats.peak = peakAmp;
	}

	function drawStokes(ctx: CanvasRenderingContext2D) {
		if (!scanvas) return;
		const dpr = window.devicePixelRatio || 1;
		const W = scanvas.clientWidth;
		const H = scanvas.clientHeight;
		if (scanvas.width !== W * dpr || scanvas.height !== H * dpr) {
			scanvas.width = W * dpr;
			scanvas.height = H * dpr;
		}
		const PW = scanvas.width;
		const PH = scanvas.height;
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, PW, PH);
		ctx.fillStyle = '#0d1319';
		ctx.fillRect(0, 0, PW, PH);

		const kk = (2 * Math.PI) / st.lambda;
		const a = st.eps / kk;
		const spanX = st.lambda * 2;
		const sx = PW / spanX;
		const sy = Math.min(sx, PH / (a * 5));
		const y0 = PH * 0.5;
		const px = (wx: number) => wx * sx;
		const py = (wy: number) => y0 - wy * sy;

		ctx.strokeStyle = '#22303e';
		ctx.lineWidth = dpr;
		ctx.beginPath();
		ctx.moveTo(0, py(0));
		ctx.lineTo(PW, py(0));
		ctx.stroke();

		const N = 800;
		const curve = (
			colour: string,
			width: number,
			pt: (u: number) => [number, number]
		) => {
			ctx.strokeStyle = colour;
			ctx.lineWidth = width * dpr;
			ctx.beginPath();
			for (let i = 0; i <= N; i++) {
				const [x, y] = pt((i / N) * spanX);
				if (i === 0) ctx.moveTo(px(x), py(y));
				else ctx.lineTo(px(x), py(y));
			}
			ctx.stroke();
		};

		// Linear: the reference. Symmetric by definition.
		if (st.showLinear)
			curve('#3d5468', 1, (u) => [u, a * Math.cos(kk * u - t * 0.6)]);
		// Gerstner: sharpens by moving particles horizontally, so its
		// curve is parametric and its crest can pass its own base.
		if (st.showGerstner)
			curve('#5fd6e6', 1.5, (u) => {
				const th = kk * u - t * 0.6;
				return [u - st.q * a * Math.sin(th), a * Math.cos(th)];
			});
		// Stokes: sharpens by adding bound harmonics, staying a function
		// of x. This is what the water actually does.
		curve('#e0a33e', 2, (u) => [
			u,
			stokesEta(kk * u - t * 0.6, a, st.eps, st.order)
		]);

		// Crest-to-trough asymmetry is the signature of real nonlinearity:
		// 1.0 for a sine, above 1 once the harmonics bite.
		const crest = stokesEta(0, a, st.eps, st.order);
		const trough = -stokesEta(Math.PI, a, st.eps, st.order);
		sstats.ratio = trough > 1e-6 ? crest / trough : 1;
		sstats.amp = a;
	}

	function drawPacket(ctx: CanvasRenderingContext2D) {
		if (!pcanvas) return;
		const dpr = window.devicePixelRatio || 1;
		const W = pcanvas.clientWidth;
		const H = pcanvas.clientHeight;
		if (pcanvas.width !== W * dpr || pcanvas.height !== H * dpr) {
			pcanvas.width = W * dpr;
			pcanvas.height = H * dpr;
		}
		const PW = pcanvas.width;
		const PH = pcanvas.height;
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, PW, PH);
		ctx.fillStyle = '#0d1319';
		ctx.fillRect(0, 0, PW, PH);

		const sx = PW / pk.spanM;
		const sy = Math.min(PH / (pk.amp * 4), sx * 40);
		const y0 = PH * 0.5;
		const px = (wx: number) => wx * sx;
		const py = (wy: number) => y0 - wy * sy;

		ctx.strokeStyle = '#22303e';
		ctx.lineWidth = dpr;
		ctx.beginPath();
		ctx.moveTo(0, py(0));
		ctx.lineTo(PW, py(0));
		ctx.stroke();

		// Time for the packet to cross the domain at the GROUP speed —
		// which is what actually carries it.
		const base = packetAt(0);
		const cross = pk.spanM / Math.max(base.cg, 0.001);
		const N = 1400;

		const drawAt = (age: number, colour: string, width: number, env: boolean) => {
			ctx.strokeStyle = colour;
			ctx.lineWidth = width * dpr;
			ctx.beginPath();
			for (let i = 0; i <= N; i++) {
				const x = (i / N) * pk.spanM;
				const e = packetEta(x, age);
				if (i === 0) ctx.moveTo(px(x), py(e.y));
				else ctx.lineTo(px(x), py(e.y));
			}
			ctx.stroke();
			if (!env) return;
			// Envelope, both signs: this is the part moving at cg, and
			// seeing it lag the crests is the point of the whole tab.
			for (const sgn of [1, -1]) {
				ctx.strokeStyle = 'rgba(95, 214, 230, 0.35)';
				ctx.lineWidth = dpr;
				ctx.beginPath();
				for (let i = 0; i <= N; i++) {
					const x = (i / N) * pk.spanM;
					const e = packetEta(x, age);
					if (i === 0) ctx.moveTo(px(x), py(sgn * e.env));
					else ctx.lineTo(px(x), py(sgn * e.env));
				}
				ctx.stroke();
			}
		};

		// Ghosts: the SAME packet at fixed points along its journey, so
		// the spreading is visible as a shape rather than as a memory.
		for (let g = 1; g <= pk.ghosts; g++) {
			const frac = g / (pk.ghosts + 1);
			drawAt(frac * cross, `rgba(224, 163, 62, ${(0.10 + 0.14 * frac).toFixed(3)})`, 1, false);
		}

		const age = (t * 0.6) % cross;
		drawAt(age, '#e0a33e', 2, pk.showEnvelope);

		const now = packetAt(age);
		pstats.c = now.c;
		pstats.cg = now.cg;
		pstats.sigma = now.sigma;
	}

	function drawRays(ctx: CanvasRenderingContext2D) {
		if (!rcanvas) return;
		const dpr = window.devicePixelRatio || 1;
		const W = rcanvas.clientWidth;
		const H = rcanvas.clientHeight;
		if (rcanvas.width !== W * dpr || rcanvas.height !== H * dpr) {
			rcanvas.width = W * dpr;
			rcanvas.height = H * dpr;
		}
		const PW = rcanvas.width;
		const PH = rcanvas.height;
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.fillStyle = '#0d1319';
		ctx.fillRect(0, 0, PW, PH);

		// Top-down, 320m across, shoal centred.
		const span = 320;
		const sc = Math.min(PW, PH) / span;
		const px = (x: number) => PW / 2 + x * sc;
		const py = (z: number) => PH / 2 + z * sc;

		// Depth, as bands. The shoal is what the rays are reacting to, so
		// it has to be visible or the bending looks arbitrary.
		if (ray.showDepth) {
			const step = 4;
			for (let sy = 0; sy < PH; sy += step) {
				for (let sx = 0; sx < PW; sx += step) {
					const wx = (sx - PW / 2) / sc;
					const wz = (sy - PH / 2) / sc;
					const f = rayDepth(wx, wz) / ray.depthM;
					const v = Math.round(18 + 26 * f);
					ctx.fillStyle = `rgb(${v},${v + 8},${v + 16})`;
					ctx.fillRect(sx, sy, step, step);
				}
			}
			// The shore itself.
			ctx.strokeStyle = '#4a5c6b';
			ctx.lineWidth = dpr;
			ctx.strokeRect(px(-50), py(-50), 100 * sc, 100 * sc);
		}

		const omega = (2 * Math.PI) / Math.max(ray.periodS, 0.1);
		const th0 = ((UNIFIED_NORTH_DEG_LOCAL + ray.bearing) * Math.PI) / 180;
		const dirX = Math.cos(th0);
		const dirZ = Math.sin(th0);
		// Start the rays on a line square to the incoming direction, well
		// clear of the shoal.
		const nx = -dirZ;
		const nz = dirX;
		let bent = 0;

		for (let r = 0; r < ray.count; r++) {
			const u = (r / Math.max(ray.count - 1, 1) - 0.5) * span * 0.95;
			let x = -dirX * span * 0.55 + nx * u;
			let z = -dirZ * span * 0.55 + nz * u;
			let theta = Math.atan2(dirZ, dirX);
			const theta0 = theta;

			ctx.beginPath();
			ctx.moveTo(px(x), py(z));
			for (let i = 0; i < ray.steps; i++) {
				const d = rayDepth(x, z);
				const k = waveNumber(omega, d);
				const cg = groupSpeed(omega, k, d);
				// Ray equation: rays bend TOWARD higher k, exactly as light
				// bends toward higher refractive index. The turning rate is
				// the component of grad(k) normal to the ray, over k.
				const e = 1.5;
				const kx =
					(waveNumber(omega, rayDepth(x + e, z)) -
						waveNumber(omega, rayDepth(x - e, z))) /
					(2 * e);
				const kz =
					(waveNumber(omega, rayDepth(x, z + e)) -
						waveNumber(omega, rayDepth(x, z - e))) /
					(2 * e);
				const ct = Math.cos(theta);
				const st = Math.sin(theta);
				// Left normal of the ray.
				const dTheta = -((-st * kx + ct * kz) / k) * cg * ray.stepS;
				theta += dTheta;
				x += Math.cos(theta) * cg * ray.stepS;
				z += Math.sin(theta) * cg * ray.stepS;
				ctx.lineTo(px(x), py(z));
				if (Math.abs(x) > span || Math.abs(z) > span) break;
			}
			ctx.strokeStyle = 'rgba(95, 214, 230, 0.55)';
			ctx.lineWidth = dpr;
			ctx.stroke();

			// Crest segment at the ray's end: perpendicular to travel, so
			// a row of them reads as a wavefront.
			if (ray.showCrests) {
				const cx = Math.cos(theta + Math.PI / 2) * 9;
				const cz = Math.sin(theta + Math.PI / 2) * 9;
				ctx.strokeStyle = '#e0a33e';
				ctx.lineWidth = 2 * dpr;
				ctx.beginPath();
				ctx.moveTo(px(x - cx), py(z - cz));
				ctx.lineTo(px(x + cx), py(z + cz));
				ctx.stroke();
			}
			bent = Math.max(bent, Math.abs(theta - theta0));
		}
		rstats.bendDeg = (bent * 180) / Math.PI;
		rstats.kDeep = waveNumber(omega, ray.depthM);
		rstats.kShore = waveNumber(omega, 0.5);
	}

	onMount(() => {
		const ctx = canvas.getContext('2d')!;
		const bctx = bcanvas?.getContext('2d') ?? null;
		const sctx = scanvas?.getContext('2d') ?? null;
		const pctx = pcanvas?.getContext('2d') ?? null;
		const rctx = rcanvas?.getContext('2d') ?? null;
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
				// Both line graphs animate on the same clock the tank uses.
				if (!k.paused && k.simSpeed > 0) t += (1 / 60) * k.simSpeed;
				if (tab === 'bend') {
					if (bctx) drawBreaker(bctx);
				} else if (tab === 'stokes') {
					if (sctx) drawStokes(sctx);
				} else if (tab === 'packet') {
					if (pctx) drawPacket(pctx);
				} else if (rctx) drawRays(rctx);
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
		{:else if tab === 'rays'}
		<div class="group">rays (refraction)</div>
		{#each RAY_ROWS as [key, min, max, step] (key)}
			<div class="row">
				<span class="name">{key}</span>
				<input type="range" {min} {max} {step} bind:value={ray[key] as number} />
				<span class="val">{(ray[key] as number).toFixed(2)}</span>
			</div>
		{/each}
		<div class="head">
			<label><input type="checkbox" bind:checked={ray.showCrests} /> crests</label>
			<label><input type="checkbox" bind:checked={ray.showDepth} /> depth</label>
		</div>
		<div class="row"><span class="name">max bend</span><span class="val">{rstats.bendDeg.toFixed(1)}&deg;</span></div>
		<div class="row"><span class="name">k deep</span><span class="val">{rstats.kDeep.toFixed(3)} /m</span></div>
		<div class="row"><span class="name">k @0.5m</span><span class="val">{rstats.kShore.toFixed(3)} /m</span></div>
		<p class="note">
			Wave packets crossing the island's shoal, from above. Cyan are
			the ray paths, amber the crest at each ray's end — a row of
			them IS the wavefront, and watching it turn to line up with the
			shore is the whole point.
			Nothing here implements refraction. Each packet carries omega,
			which is conserved; depth sets k through w&sup2; = gk&middot;tanh(kd);
			and the ray turns toward higher k exactly as light turns toward
			higher refractive index. Bending is what falls out. The k
			readouts show the same wave going short and slow as it shoals —
			that difference across a crest is what makes it turn.
			This is what a Gerstner wave cannot do: its phase is k&middot;x
			with k constant, and varying k per-position tears the phase
			unless you carry the integral along the path. A packet is
			somewhere, so it can carry it.
		</p>
		{:else if tab === 'packet'}
		<div class="group">packet (Lagrangian)</div>
		{#each PACKET_ROWS as [key, min, max, step] (key)}
			<div class="row">
				<span class="name">{key}</span>
				<input type="range" {min} {max} {step} bind:value={pk[key] as number} />
				<span class="val">{(pk[key] as number).toFixed(1)}</span>
			</div>
		{/each}
		<div class="head">
			<label><input type="checkbox" bind:checked={pk.showEnvelope} /> envelope</label>
		</div>
		<div class="row"><span class="name">phase c</span><span class="val">{pstats.c.toFixed(2)} m/s</span></div>
		<div class="row"><span class="name">group cg</span><span class="val">{pstats.cg.toFixed(2)} m/s</span></div>
		<div class="row"><span class="name">sigma now</span><span class="val">{pstats.sigma.toFixed(1)} m</span></div>
		<p class="note">
			One Lagrangian wave packet — the primitive behind wave
			particles, water wave packets and Skrivan's wave curves. Not a
			field on a grid: a closed form you can evaluate anywhere and
			SUM, which is the property an engine needs when its physics
			probes arbitrary points.
			Watch the crests, not the packet: they run forward THROUGH the
			envelope, appearing at the back and dying at the front, because
			the carrier moves at c and the envelope at cg = c/2 in deep
			water. A plane-wave sum cannot do that — a plane wave has
			nowhere for a crest to be born. Faint ghosts are the same
			packet further along its journey, showing it SPREAD as its
			component wavenumbers separate. That spreading is real
			dispersion carried by a handful of numbers.
		</p>
		{:else if tab === 'stokes'}
		<div class="group">nonlinear (Stokes)</div>
		{#each STOKES_ROWS as [key, min, max, step] (key)}
			<div class="row">
				<span class="name">{key}</span>
				<input type="range" {min} {max} {step} bind:value={st[key] as number} />
				<span class="val">{(st[key] as number).toFixed(3)}</span>
			</div>
		{/each}
		<div class="head">
			<label><input type="checkbox" bind:checked={st.showLinear} /> linear</label>
			<label><input type="checkbox" bind:checked={st.showGerstner} /> gerstner</label>
		</div>
		<div class="row"><span class="name">amp</span><span class="val">{sstats.amp.toFixed(2)} m</span></div>
		<div class="row"><span class="name">crest/trough</span><span class="val">{sstats.ratio.toFixed(3)}</span></div>
		<p class="note">
			Amber is Stokes, the closed form the HOS paper's method
			converges to for a regular wave — real nonlinearity, added as
			bound harmonics, so the surface stays a function of x. Cyan is
			Gerstner, which sharpens by moving particles sideways instead,
			and grey is the plain sine. All three at the same steepness ka.
			crest/trough is the tell: 1.0 for a sine, above 1 once the
			harmonics bite, and it is the asymmetry Gerstner gets by a
			different route and a different amount. Stokes has no steady
			solution past ka 0.443 (H/lambda = 1/7) — that limit is the
			same one BREAKER's 20:3 ratio lands on.
		</p>
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
		<div class="row"><span class="name">amp now</span><span class="val">{bstats.amp.toFixed(2)}</span></div>
		<div class="row"><span class="name">amp peak</span><span class="val">{bstats.peak.toFixed(2)}</span></div>
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
			<button class:on={tab === 'stokes'} onclick={() => (tab = 'stokes')}>nonlinear</button>
			<button class:on={tab === 'packet'} onclick={() => (tab = 'packet')}>packet</button>
			<button class:on={tab === 'rays'} onclick={() => (tab = 'rays')}>rays</button>
		</div>
		<canvas bind:this={canvas} hidden={tab !== 'tank'}></canvas>
		<canvas bind:this={bcanvas} hidden={tab !== 'bend'}></canvas>
		<canvas bind:this={scanvas} hidden={tab !== 'stokes'}></canvas>
		<canvas bind:this={pcanvas} hidden={tab !== 'packet'}></canvas>
		<canvas bind:this={rcanvas} hidden={tab !== 'rays'}></canvas>
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
