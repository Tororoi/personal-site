<script lang="ts">
	/**
	 * /wavepool — a controlled tank for WAVE PACKETS.
	 *
	 * A rectangular pool: wedge at the deep end, flat bottom, ramp to a
	 * shore that rises out of the water. Clicking the wedge (or pressing
	 * space) fires one stroke, which launches a row of packets down the
	 * pool. Every packet carries position, direction, omega and phase;
	 * per frame it integrates the ray equations against the LOCAL depth,
	 * so shoaling, wall reflection and — once the bed varies across the
	 * pool — refraction all come out of the same few lines. The surface
	 * is just the sum of the packets, evaluated on a grid.
	 *
	 * The whole point of the room: one wave, launched on demand, over a
	 * bed defined by ONE function (bedY). Add a reef or bend the shore by
	 * editing that function and everything — basin mesh, packet
	 * kinematics, readouts — follows, because nothing else knows the
	 * shape.
	 */
	import { onMount } from 'svelte';
	import * as THREE from 'three';
	import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

	const G = 9.81;
	/** Pool envelope, metres. x runs wedge (0) -> shore top (POOL_L). */
	const POOL_L = 60;
	// Doubled from 20: at 20m the headland's bulge WAS most of the pool
	// width, so there were no straight flanks left to contrast the wrap
	// against. Everything downstream (walls, spawn tiling, open-side
	// fade, camera framing) derives from this constant.
	const POOL_W = 40;

	const k = $state({
		/** Wave period of a stroke, seconds. Deep-water wavelength is
		 *  g*T^2/2pi — T=3 is ~14m, a good fit for a 60m pool. */
		periodS: 3,
		amp: 1,
		/** Packets per stroke, tiled across the pool's width. */
		packets: 8,
		/** Gerstner steepness: the horizontal trochoid displacement that
		 *  crowds material toward crests — sharp peaks, flat troughs. The
		 *  pool's carriers were pure sinusoids, but the surf lab's curl
		 *  was TUNED against trochoidal crests (its 2D curve carried the
		 *  q·a·cos term), so without this the same 235 degrees was being
		 *  asked to make a soft sine hump look like a pitching Gerstner
		 *  lip. 1 matches the lab's q. */
		steep: 1,
		/** Envelope length along travel, metres (the stroke's thickness
		 *  in DEEP water; it compresses with cg from there).
		 *
		 *  Keep it at least ~half the wavelength (see the lambda readout).
		 *  Below that the packet is sub-wavelength — a single hump with
		 *  the carrier sliding through it — and it BLINKS in place
		 *  instead of showing crests that travel: the narrowband model
		 *  only describes envelopes that span a wave. */
		pulseM: 7,
		deepM: 4,
		rampStartM: 30,
		/** Headland shape: how far the point juts up-pool, and the sigma
		 *  of its bulge across the width. Live on the headland preset. */
		headJutM: 13,
		headWideM: 6.5,
		simSpeed: 1,
		/** Amplitude follows energy flux along each packet's own ray:
		 *  A = A0 * sqrt(cg0/cg). The packet-correct form of shoaling —
		 *  Green's law is its shallow limit. */
		shoal: true,
		/** Lateral ray-tube transport: focusing and spreading move energy
		 *  across the pool. Off = width frozen, 1D energy only. */
		spreadEnergy: true,
		/** Dissipation where the wave exceeds the breaking criterion. Off,
		 *  a wave keeps every joule past H/d ~ 0.78 — unphysical, and
		 *  exactly the state to inspect: the red flags still mark where
		 *  breaking WOULD bite, and the shoaling growth runs uncapped all
		 *  the way to the sand (only the floor-contact drain retires it).
		 */
		breakLoss: true,
		/** The surf lab's crest curl, ported: a rigid rotation of each
		 *  crest about a hinge below it, driven by the SAME breaking
		 *  criterion as the red bars and the dissipation — so the lip
		 *  appears exactly where the physics says the wave is going over,
		 *  instead of where a scrub slider said so. */
		curl: true,
		/**
		 * GENERIC DECAY RIG for retuning against live waves. Pick a knob
		 * (dcVar); its effective value then decays PER PACKET as that
		 * packet is spent. The driver is spent = 1 - decay — the pool's
		 * own lifecycle clock, which only advances once breaking or the
		 * floor is actually eating the wave. dcStart is the spent
		 * fraction where decay begins, dcRate how fast it falls past
		 * that, dcLimit the floor (fraction of the knob's value) it can
		 * never fall below. mult = clamp(1 - rate*(spent-start), limit, 1)
		 */
		dcVar: 'none' as 'none' | 'steep' | 'curlDeg' | 'curlPow' | 'curlPivot' | 'curlWindow',
		dcStart: 0,
		dcRate: 1,
		dcLimit: 0,
		curlDeg: 235,
		curlPow: 5,
		curlPivot: 1,
		curlWindow: 3.14,
		/**
		 * Fire a stroke every period, like a real wavemaker. One pulse's
		 * crests die at its front (they outrun their own group — deep
		 * water has c = 2cg); a TRAIN keeps replacing them from behind, so
		 * crests reach the shore continuously.
		 *
		 * The phases lock automatically: omega is the clock, so a stroke
		 * fired exactly one period after the last is coherent with it —
		 * cos picks up a full 2pi between them, no bookkeeping.
		 */
		autoFire: false,
		reflectWalls: true,
		showPackets: true,
		paused: false
	});

	const ROWS: [keyof typeof k, number, number, number][] = [
		['periodS', 1, 8, 0.1],
		['amp', 0.05, 2.5, 0.05],
		['packets', 4, 60, 1],
		['steep', 0, 1.3, 0.02],
		['pulseM', 1, 24, 0.25],
		['deepM', 2, 8, 0.25],
		['rampStartM', 15, 45, 1],
		['headJutM', 0, 26, 0.5],
		['headWideM', 2, 16, 0.25],
		['curlDeg', 0, 360, 5],
		['curlPow', 0.5, 8, 0.1],
		['curlPivot', 0, 3, 0.05],
		['curlWindow', 0.2, 3.14, 0.02],
		['dcStart', 0, 1, 0.01],
		['dcRate', 0, 8, 0.05],
		['dcLimit', 0, 1, 0.01],
		['simSpeed', 0, 3, 0.05]
	];

	let stats = $state({
		live: 0,
		maxHd: 0,
		cgDeep: 0,
		shoreX: 0,
		lambdaDeep: 0,
		cOverCg: 0,
		peakA: 0
	});

	// ---- The bed: the single owner of the pool's shape ----------------

	/**
	 * Bed height at (x, z), water surface at y = 0. Flat at -deepM to
	 * rampStartM, then a straight ramp that crosses the waterline and
	 * tops out 1m above — the shore. Takes z even though nothing varies
	 * with it yet: a reef or a curved shoreline is an edit HERE and
	 * nowhere else.
	 */
	/** Which pool floor is installed. Everything reads bedY, so a preset
	 *  swap re-shapes the basin, the rays and the readouts at once.
	 *
	 *  What each is FOR:
	 *   ramp     — the control: no lateral variation, bending must be 0.
	 *   headland — shore bulges into the pool. Crests should WRAP it,
	 *              energy converging on the point — why headlands take
	 *              the sea's beating.
	 *   reef     — a shore-parallel BAR, crown ~1.2m down, spanning the
	 *              full width. Deliberately 1D: packets shoal on the
	 *              crown, reform in the deeper water behind, and nothing
	 *              bends — so a walls-off run is pure bar physics, with
	 *              headland and channel as the lateral cases.
	 *   channel  — the ramp cut deeper mid-width. Deeper is faster, so
	 *              rays refract OUT of the corridor onto its shoulders:
	 *              calm channel, loaded flanks. Why harbour entrances
	 *              are dredged where they are. */
	let bedShape = $state<'ramp' | 'headland' | 'reef' | 'channel'>('ramp');

	function bedY(x: number, z: number): number {
		let rampEff = k.rampStartM;
		let bump = 0;
		if (bedShape === 'headland') {
			rampEff -= k.headJutM * Math.exp(-(z * z) / (2 * k.headWideM * k.headWideM));
		} else if (bedShape === 'channel') {
			rampEff += 14 * Math.exp(-(z * z) / (2 * 3 * 3));
		} else if (bedShape === 'reef') {
			bump = (k.deepM - 1.2) * Math.exp(-((x - 26) ** 2) / (2 * 5 * 5));
		}
		const slope = (k.deepM + 1) / Math.max(POOL_L - 5 - rampEff, 5);
		const base =
			x <= rampEff ? -k.deepM : Math.min(-k.deepM + (x - rampEff) * slope, 1);
		return Math.min(base + bump, 1);
	}
	/** Water depth, floored: k diverges as depth reaches zero, and a
	 *  packet on dry land has nothing left to integrate. */
	const depthAt = (x: number, z: number) => Math.max(-bedY(x, z), 0.15);
	/** Centreline shoreline, by scan — the presets bend the shore, so no
	 *  closed form survives them. */
	function shoreX() {
		for (let x = 0; x <= POOL_L; x += 0.25) if (bedY(x, 0) >= 0) return x;
		return POOL_L;
	}

	// ---- Dispersion: the physics the packets carry --------------------

	/** Solve w^2 = g k tanh(kd) for k. Newton from the deep-water guess. */
	function waveNumber(omega: number, depth: number) {
		let kk = (omega * omega) / G;
		for (let i = 0; i < 5; i++) {
			const th = Math.tanh(kk * depth);
			const f = G * kk * th - omega * omega;
			const df = G * th + G * kk * depth * (1 - th * th);
			kk -= f / df;
			if (kk < 1e-6) kk = 1e-6;
		}
		return kk;
	}
	function groupSpeed(omega: number, kk: number, depth: number) {
		const kd = kk * depth;
		const sh = Math.sinh(2 * kd);
		return (omega / kk) * 0.5 * (1 + (2 * kd) / (sh === 0 ? 1e-6 : sh));
	}

	// ---- Packets -------------------------------------------------------

	type Packet = {
		x: number;
		z: number;
		theta: number;
		omega: number;
		a0: number;
		a: number;
		cg0: number;
		/** Carrier phase at the envelope centre. Advanced at k*cg - omega,
		 *  which is what makes crests run forward THROUGH the envelope —
		 *  the two-speeds fact, kept per packet. */
		phase: number;
		sigQ: number;
		/** Envelope half-length along travel. NOT fixed: the group
		 *  compresses as it shoals — the front is in shallower, slower
		 *  water than the rear — so this rides cg. Holding it constant
		 *  while the wavelength shrank multiplied the crests inside one
		 *  pulse without bound, which is not something the sea does: with
		 *  both compressing, the count only grows ~2x, because deep water
		 *  has cg = c/2 and shallow has cg = c. */
		sigS: number;
		/** Envelope dimensions at birth: the reference for energy
		 *  conservation (A^2 x length x width = const). */
		sig0: number;
		sigQ0: number;
		/** Angle between this packet's edge rays, radians. Integrates the
		 *  bend-rate DIFFERENCE across the width; the width integrates the
		 *  spread — ray-tube focusing, second order, which is why a reef's
		 *  focus forms BEHIND the reef rather than on it. */
		spread: number;
		/** Path curvature, 1/m: the bend rate over the group speed —
		 *  how sharply the ray this packet rides is turning. The envelope
		 *  LIES ALONG the ray, so a long packet in a refraction zone is
		 *  banana-shaped; drawn straight along the instantaneous heading
		 *  it visibly refuses to bend. Low-passed, since the bend rate is
		 *  sampled and jitters near steep gradients. */
		pathK: number;
		/** Accumulated dissipation, 1 at birth, falling as the beach (or
		 *  an open side) eats the packet. Its OWN channel: amplitude is
		 *  base-energy x decay, because the energy formula ASSIGNS p.a
		 *  each frame — a fade multiplied into p.a directly was silently
		 *  overwritten one frame later, leaving dissipation one frame
		 *  deep: flickering amplitude and unkillable shore zombies. */
		decay: number;
		breaking: boolean;
	};
	const packets: Packet[] = [];

	function fireStroke() {
		const omega = (2 * Math.PI) / Math.max(k.periodS, 0.1);
		const d0 = depthAt(6, 0);
		const cg0 = groupSpeed(omega, waveNumber(omega, d0), d0);
		const n = Math.round(k.packets);
		const spacing = (POOL_W - 4) / Math.max(n - 1, 1);
		for (let i = 0; i < n; i++) {
			packets.push({
				x: 6,
				z: -((POOL_W - 4) / 2) + i * spacing,
				theta: 0,
				omega,
				a0: k.amp,
				a: k.amp,
				cg0,
				phase: 0,
				// Sum of Gaussians is near-flat when sigma ~ 0.75 x spacing,
				// so one stroke reads as one crest line, not a row of dots —
				// until the bed makes neighbours diverge, which is exactly
				// the "one wave splitting into packets" this room is for.
				sigQ: Math.max(spacing * 0.75, 0.8),
				sigS: k.pulseM,
				sig0: k.pulseM,
				sigQ0: Math.max(spacing * 0.75, 0.8),
				spread: 0,
				pathK: 0,
				decay: 1,
				breaking: false
			});
		}
		// Cap: repeated strokes must not grow without bound.
		while (packets.length > 400) packets.shift();
		strokeT0 = labT;
	}

	/** Turning rate of a ray at a point: toward higher k, at a rate set
	 *  by the component of grad(k) across the ray — light toward higher
	 *  refractive index, verbatim. */
	function rayBend(omega: number, x: number, z: number, theta: number) {
		const e = 1.0;
		const kk = waveNumber(omega, depthAt(x, z));
		const d = depthAt(x, z);
		const cg = groupSpeed(omega, kk, d);
		const kx =
			(waveNumber(omega, depthAt(x + e, z)) - waveNumber(omega, depthAt(x - e, z))) / (2 * e);
		const kz =
			(waveNumber(omega, depthAt(x, z + e)) - waveNumber(omega, depthAt(x, z - e))) / (2 * e);
		return -((-Math.sin(theta) * kx + Math.cos(theta) * kz) / kk) * cg;
	}

	function stepPackets(dt: number) {
		let maxHd = 0;
		for (let i = packets.length - 1; i >= 0; i--) {
			const p = packets[i];
			const d = depthAt(p.x, p.z);
			const kk = waveNumber(p.omega, d);
			const cg = groupSpeed(p.omega, kk, d);
			const bendC = rayBend(p.omega, p.x, p.z, p.theta);
			p.theta += bendC * dt;
			// EACH EDGE RIDES ITS OWN WATER. The envelope's front is in
			// shallower water than its rear, so front and rear advance at
			// their own local cg — both positive, front slower — and the
			// centre moves at their mean. Compression is the DIFFERENCE
			// integrated over time, not a ratio law read at the centre:
			// the ratio version (sigma proportional to cg-at-centre)
			// agrees on gentle slopes but let sigma collapse faster than
			// the centre advanced on the steep shore gradient, which
			// marched the leading edge BACKWARD — an envelope-bookkeeping
			// artefact no part of a real group performs.
			const ct2 = Math.cos(p.theta);
			const st2 = Math.sin(p.theta);
			const reach = 3 * p.sigS;
			const dF = depthAt(p.x + ct2 * reach, p.z + st2 * reach);
			const dR = depthAt(p.x - ct2 * reach, p.z - st2 * reach);
			const cgF = groupSpeed(p.omega, waveNumber(p.omega, dF), dF);
			const cgR = groupSpeed(p.omega, waveNumber(p.omega, dR), dR);
			p.x += ct2 * ((cgF + cgR) / 2) * dt;
			p.z += st2 * ((cgF + cgR) / 2) * dt;
			// The floor is a numerical guard only, well below anything the
			// kinematics produce: the PHYSICAL stop is the front/rear speed
			// differential reaching zero as the rear itself beaches. The
			// old 0.5m floor pre-empted that and froze the squeeze while
			// the rear was still arriving.
			p.sigS = Math.max(p.sigS + ((cgF - cgR) / 6) * dt, 0.22);
			{
				const target = Math.min(
					Math.max(bendC / Math.max((cgF + cgR) / 2, 0.1), -0.04),
					0.04
				);
				p.pathK += (target - p.pathK) * Math.min(3 * dt, 1);
			}
			p.phase += (kk * cg - p.omega) * dt;
			if (k.spreadEnergy) {
				// LATERAL ray-tube transport — the same edges-ride-their-own-
				// water rule, turned sideways. The bend rate at the packet's
				// two lateral edges differs wherever the bed varies across
				// it; the SPREAD integrates that difference, the WIDTH
				// integrates the spread. Second order on purpose: rays bent
				// toward each other keep converging after the bending
				// stops, which is why a reef's focus forms behind it.
				const nx = -st2;
				const nz = ct2;
				const bR = rayBend(p.omega, p.x + nx * p.sigQ, p.z + nz * p.sigQ, p.theta);
				const bL = rayBend(p.omega, p.x - nx * p.sigQ, p.z - nz * p.sigQ, p.theta);
				p.spread += (bR - bL) * dt;
				p.sigQ = Math.min(Math.max(p.sigQ + ((cgF + cgR) / 2) * p.spread * dt, 0.4), 14);
			}

			// Side walls reflect: mirror the direction, keep everything else.
			const zLim = POOL_W / 2 - 0.5;
			if (k.reflectWalls) {
				if (p.z > zLim && Math.sin(p.theta) > 0) p.theta = -p.theta;
				else if (p.z < -zLim && Math.sin(p.theta) < 0) p.theta = -p.theta;
			} else if (Math.abs(p.z) > POOL_W / 2 + 1.5) {
				// Walls off means the sides are OPEN: what leaves the domain
				// fades out of it — through the decay channel, so it stays
				// faded.
				p.decay *= Math.exp(-4 * dt);
			}
			// INFORMATION, not an effect: flag where H exceeds ~0.78d. The
			// lab reports the breaking criterion; it does not enforce one.
			p.breaking = 2 * p.a > 0.78 * d;
			if (p.breaking) maxHd = Math.max(maxHd, (2 * p.a) / d);
			// Dissipation triggers on BREAKING, not on shallowness. A wave
			// loses its energy where it is too big for the water carrying
			// it (H/d past ~0.78) — which is necessarily AFTER the shoaling
			// growth, so the rise is seen before the fall. The previous
			// depth-triggered absorber taxed the packet all the way up the
			// ramp and it bled out before the amplification showed. Same
			// criterion as the red bars: the flag and the physics are one
			// mechanism now. A mild floor-contact term retires the tiny
			// remnants too small to ever break, and running off the pool's
			// end is a hard stop.
			// FLOOR drain and pool-end runoff: retire what is grinding on
			// the sand or has left the water entirely.
			let floorEat = 0;
			let wTot = 0;
			for (let j = -2; j <= 2; j++) {
				const sOff = (j / 2) * 2.2 * p.sigS;
				const w = Math.exp(-(sOff * sOff) / (2 * p.sigS * p.sigS));
				wTot += w;
				const dj = depthAt(p.x + ct2 * sOff, p.z + st2 * sOff);
				floorEat += w * (1 - Math.min(Math.max((dj - 0.16) / 0.1, 0), 1));
			}
			let rate = (1.5 * floorEat) / wTot;
			if (p.x > POOL_L) rate = 6;
			p.decay *= Math.exp(-rate * dt);
			const base = k.shoal
				? p.a0 * Math.sqrt((p.sig0 * p.sigQ0) / (p.sigS * p.sigQ))
				: p.a0;
			// BREAKING IS A CAP, NOT A RATE. A broken wave is a bore, and a
			// bore's height is slaved to the depth: it rides the beach at
			// H ~ 0.78 d, shedding exactly the energy turbulence must eat
			// to hold it on that line — deflating as the water shallows.
			// The old fixed drain raced shoaling and lost, leaving
			// "breaking" waves tall and red indefinitely. Relaxing decay
			// toward the saturation line gets all three regimes from one
			// rule: deflation down the beach, reform behind a bar (cap
			// lifts where depth returns, loss stops, the survivor is a
			// smaller unbroken wave), and permanence (decay never rises —
			// energy spent is spent).
			if (k.breakLoss) {
				const aSat = 0.39 * depthAt(p.x, p.z);
				const cap = aSat / Math.max(base, 1e-4);
				if (p.decay > cap)
					p.decay += (cap - p.decay) * Math.min(4 * dt, 1);
			}
			p.a = base * p.decay;
			if (p.a < 0.004) packets.splice(i, 1);
		}
		stats.live = packets.length;
		stats.maxHd = maxHd;
		let pk = 0;
		for (const p of packets) pk = Math.max(pk, p.a);
		stats.peakA = pk;
		// c/cg at the LEAD packet: 2 in deep water (crests outrun their
		// group and die at its front), sliding to 1 as the shallows kill
		// dispersion — the moment it reaches 1, crests stop dying and
		// ride in. Watching this number fall IS the explanation.
		let lead: Packet | null = null;
		for (const p of packets) if (!lead || p.x > lead.x) lead = p;
		if (lead) {
			const d = depthAt(lead.x, lead.z);
			const kk = waveNumber(lead.omega, d);
			stats.cOverCg = lead.omega / kk / groupSpeed(lead.omega, kk, d);
		} else stats.cOverCg = 0;
	}

	/**
	 * Surface height AND slope at a point — the packet sum differentiates
	 * in closed form, so the normal comes from calculus, not from the
	 * mesh. This is the pool's version of the smoothing the real sea
	 * gets: the game's water rebuilds its normals analytically per pixel
	 * precisely so lighting never sees mesh facets, and geometric
	 * (computeVertexNormals) shading here was half of the shore
	 * jumpiness. Writes into `surf` to keep the per-vertex loop
	 * allocation-free.
	 */
	const surf = { y: 0, gx: 0, gz: 0, dx: 0, dz: 0 };
	function surfaceAt(x: number, z: number) {
		surf.y = 0;
		surf.gx = 0;
		surf.gz = 0;
		surf.dx = 0;
		surf.dz = 0;
		for (const p of packets) {
			const dx = x - p.x;
			const dz = z - p.z;
			const ct = Math.cos(p.theta);
			const st = Math.sin(p.theta);
			const s = dx * ct + dz * st;
			if (s > 3 * p.sigS || s < -3 * p.sigS) continue;
			const q = -dx * st + dz * ct;
			// The cull box widens by the banana's own lateral excursion —
			// culling in the straight frame would delete the bent tails it
			// exists to draw.
			const swing = 0.5 * Math.abs(p.pathK) * 9 * p.sigS * p.sigS;
			if (q > 2.5 * p.sigQ + swing || q < -(2.5 * p.sigQ + swing)) continue;
			// Midpoint-rule carrier k: matches the accumulated phase
			// integral to third order, so phase-locked strokes stay
			// coherent while the train's front still shortens first.
			const kk = waveNumber(p.omega, depthAt((x + p.x) / 2, (z + p.z) / 2));
			// CURVED CREST. One theta per packet turns the whole segment
			// rigidly — the far end of a wide packet swings before the
			// water there has changed, which is not how a crest refracts.
			// The curvature needs no new state: it IS the heading gradient
			// along the crest, and `spread` already integrates the heading
			// difference across the width. The crest becomes the parabola
			// s = -kap q^2, so the side of the packet that has reached the
			// gradient lags or leads while the rest is still straight.
			const kap = Math.min(Math.max(p.spread / (4 * p.sigQ), -0.2), 0.2);
			// THE BENT FRAME. The envelope lies along its RAY, and the ray
			// curves — so the packet's lateral coordinate is measured from
			// the curved path (qb), not from the straight tangent line. A
			// long packet in a refraction zone is a banana; evaluated in
			// the straight frame it stayed a plank however hard the ray
			// turned under it. The crest parabola then bends about the
			// bent spine.
			const qb = q - 0.5 * p.pathK * s * s;
			const sc = s + kap * qb * qb;
			const es = Math.exp(-(sc * sc) / (2 * p.sigS * p.sigS));
			const eq = Math.exp(-(qb * qb) / (2 * p.sigQ * p.sigQ));
			const ph = kk * sc + p.phase;
			const co = Math.cos(ph);
			const si = Math.sin(ph);
			// The decay rig: this packet's multiplier for whichever knob is
			// under tuning, driven by how spent the packet is.
			const dm =
				k.dcVar === 'none'
					? 1
					: Math.min(
							Math.max(1 - k.dcRate * Math.max(1 - p.decay - k.dcStart, 0), k.dcLimit),
							1
						);
			const sEff = k.steep * (k.dcVar === 'steep' ? dm : 1);
			const cDegEff = k.curlDeg * (k.dcVar === 'curlDeg' ? dm : 1);
			const cPowEff = k.curlPow * (k.dcVar === 'curlPow' ? dm : 1);
			const cPivEff = k.curlPivot * (k.dcVar === 'curlPivot' ? dm : 1);
			const cWinEff = Math.max(k.curlWindow * (k.dcVar === 'curlWindow' ? dm : 1), 0.05);
			const aEnv = p.a * es * eq;
			const etaP = aEnv * co;
			// The trochoid: material at this phase is displaced down-wave
			// by -steep a sin(ph), same convention as classic Gerstner
			// (y = a cos, x-shift = -Q a sin). This is what sharpens the
			// peaks; the curl below rotates the SWAYED point, as the lab
			// did.
			const dsG = -sEff * aEnv * si;
			if (k.curl) {
				// THE SURF LAB'S CURL, fed by physics instead of a scrub.
				// psi: signed phase from the nearest crest. The crest region
				// within curlWindow rotates rigidly about a hinge curlPivot
				// local-amplitudes below the crest — rigid, so it cannot
				// self-intersect; hinged low, so the TIP travels furthest
				// and comes down ahead of the face (the lab's hard-won
				// lessons, verbatim). The break amount is the local H/d
				// ramp — the same number the bars flag and the beach eats
				// by, so all three agree about where waves are going over.
				const m = ph / (2 * Math.PI);
				const psi = 2 * Math.PI * (m - Math.round(m));
				if (Math.abs(psi) < cWinEff) {
					const aLoc = aEnv;
					const dLoc = depthAt(x, z);
					const bRaw = Math.min(
						Math.max(((2 * aLoc) / dLoc - 0.55) / 0.35, 0),
						1
					);
					if (bRaw > 0.002) {
						// The lab's unwind, restored. There, bend was
						// bThrow x (1 - collapse): structurally impossible to
						// have a hard bend on a collapsed wave, which is why
						// 235 degrees was safe. The pool's H/d criterion
						// broke that — depth shrinks as fast as a dying wave
						// does, so wisps kept curling at full angle. decay IS
						// this pool's collapse, so it takes the lab's role:
						// the bend unwinds exactly as the beach drains the
						// wave. With breakLoss off, decay holds ~1 and the
						// full tuned curl stands — the lab's held-scrub
						// tuning mode, recovered for free.
						const bAmt = bRaw * bRaw * (3 - 2 * bRaw) * p.decay;
						const wf = Math.cos((psi / cWinEff) * (Math.PI / 2));
						const phi =
							((cDegEff * Math.PI) / 180) * bAmt * Math.pow(wf, cPowEff);
						// Crest-relative frame: sample sits du down-wave of
						// the crest, hinge below the crest tip.
						const du = psi / kk;
						const hy = aLoc * (1 - cPivEff);
						const rx = du + dsG;
						const ry = etaP - hy;
						const cs = Math.cos(phi);
						const sf = Math.sin(phi);
						const duR = rx * cs + ry * sf;
						const yR = hy + (-rx * sf + ry * cs);
						const dShift = duR - du;
						surf.dx += dShift * ct;
						surf.dz += dShift * st;
						surf.y += yR;
					} else {
						surf.y += etaP;
						surf.dx += dsG * ct;
						surf.dz += dsG * st;
					}
				} else {
					surf.y += etaP;
					surf.dx += dsG * ct;
					surf.dz += dsG * st;
				}
			} else {
				surf.y += etaP;
				surf.dx += dsG * ct;
				surf.dz += dsG * st;
			}
			// Full chain rule through sc(s, qb(s, q)) and qb(s, q):
			//   dqb/ds = -pathK s   dqb/dq = 1
			//   dsc/ds = 1 + 2 kap qb dqb/ds   dsc/dq = 2 kap qb
			// The k field's own gradient stays dropped — second order.
			const ddu = p.a * eq * es * (-(sc / (p.sigS * p.sigS)) * co - kk * si);
			const ddv = p.a * es * eq * (-(qb / (p.sigQ * p.sigQ))) * co;
			const dqbds = -p.pathK * s;
			const dds = ddu * (1 + 2 * kap * qb * dqbds) + ddv * dqbds;
			const ddq = ddu * (2 * kap * qb) + ddv;
			surf.gx += dds * ct - ddq * st;
			surf.gz += dds * st + ddq * ct;
		}
		// NO dry-land mask, deliberately: run-up is the real answer, and a
		// mask would fight it when it lands here.
	}

	// ---- The spectrum: what a packet actually is -----------------------

	/**
	 * A Gaussian pulse IS a sum of sinusoids with wavenumbers clustered
	 * around the carrier — that is not a metaphor, it is the Fourier
	 * transform. Seven of them, weighted by the pulse's own spectrum,
	 * each given its OWN omega from the dispersion relation and its own
	 * phase integral down the pool: their sum forms the pulse, the pulse
	 * moves at cg because the components drift apart in phase, and near
	 * shore their speeds converge and the drifting stops. The graphs
	 * below the 3D view draw exactly these.
	 *
	 * Phase over varying depth is the WKB integral: each component keeps
	 * its omega and re-solves k locally, phase(x) = integral of k dx.
	 * Precomputed on a grid whenever the bed or the stroke changes.
	 */
	const NCOMP = 7;
	const GRID_N = 241;
	type Comp = { kDeep: number; omega: number; w: number; cum: Float32Array };
	let comps: Comp[] = [];
	/** Lab clock and the moment of the last stroke, shared with the
	 *  wedge so the strip and the 3D packets tell one story. */
	let labT = 0;
	let strokeT0 = 0;

	function rebuildComps() {
		const sig = Math.max(k.pulseM, 0.5);
		const omega0 = (2 * Math.PI) / Math.max(k.periodS, 0.1);
		const k0 = waveNumber(omega0, k.deepM);
		// Sample spacing trades spectrum coverage against the recurrence
		// artefact: a FINITE sum of cosines repeats in space at
		// 2pi/spacing, so the spacing is chosen to push the ghost pulse
		// past the pool's far end.
		const spacing = 0.45 / sig;
		const dx = POOL_L / (GRID_N - 1);
		const raw: Comp[] = [];
		let wSum = 0;
		for (let i = -(NCOMP - 1) / 2; i <= (NCOMP - 1) / 2; i++) {
			const kD = Math.max(k0 + i * spacing, 0.02);
			const om = Math.sqrt(G * kD * Math.tanh(kD * k.deepM));
			const w = Math.exp(-0.5 * (i * spacing * sig) ** 2);
			wSum += w;
			const cum = new Float32Array(GRID_N);
			for (let j = 1; j < GRID_N; j++) {
				const xm = (j - 0.5) * dx;
				cum[j] = cum[j - 1] + waveNumber(om, depthAt(xm, 0)) * dx;
			}
			// Zero the phase at the wedge face, where the stroke is born in
			// phase — that alignment IS the pulse.
			const off = cum[Math.round(6 / dx)];
			for (let j = 0; j < GRID_N; j++) cum[j] -= off;
			raw.push({ kDeep: kD, omega: om, w, cum });
		}
		for (const c of raw) c.w /= wSum;
		comps = raw;
	}

	function compPhase(c: Comp, x: number, tau: number) {
		const fx = Math.min(Math.max((x / POOL_L) * (GRID_N - 1), 0), GRID_N - 1.001);
		const j = Math.floor(fx);
		const cum = c.cum[j] + (c.cum[j + 1] - c.cum[j]) * (fx - j);
		return cum - c.omega * tau;
	}

	// ---- Scene ---------------------------------------------------------

	let host: HTMLDivElement;
	let gcanvas: HTMLCanvasElement | undefined = $state();

	onMount(() => {
		const renderer = new THREE.WebGLRenderer({ antialias: true });
		renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
		// setSize(..., false) below never touches CSS, so without these
		// the canvas displays at its BACKING size — pixelRatio times the
		// stage — and the pool's centre sits off in the overflow, which
		// read as "everything is in the lower right corner".
		renderer.domElement.style.width = '100%';
		renderer.domElement.style.height = '100%';
		renderer.domElement.style.display = 'block';
		host.appendChild(renderer.domElement);
		const scene = new THREE.Scene();
		scene.background = new THREE.Color('#10161c');
		const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 500);
		const controls = new OrbitControls(camera, renderer.domElement);
		controls.target.set(POOL_L / 2, -0.5, 0);
		controls.maxPolarAngle = Math.PI * 0.49;
		controls.minDistance = 8;
		controls.maxDistance = 250;
		/**
		 * Frame the whole pool once the viewport's real aspect is known —
		 * a hand-placed camera fits one window shape and clips every
		 * other. Bounding sphere of the basin, distance from whichever
		 * field of view is tighter, looking down-pool from behind the
		 * wedge so a fired wave travels away toward the shore.
		 */
		let framed = false;
		function frameThePool(aspect: number) {
			const RADIUS = 38;
			const vFov = (camera.fov * Math.PI) / 180;
			const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
			const dist = (RADIUS / Math.sin(Math.min(vFov, hFov) / 2)) * 1.04;
			const dir = new THREE.Vector3(-0.5, 0.55, 0.62).normalize();
			camera.position.copy(controls.target).addScaledVector(dir, dist);
			controls.update();
		}

		scene.add(new THREE.AmbientLight('#9fb2c4', 0.7));
		const sun = new THREE.DirectionalLight('#fff4e0', 1.6);
		sun.position.set(30, 45, 18);
		scene.add(sun);

		// -- Basin: bed + walls, all reading bedY --
		const BX = 121;
		const BZ = 81;
		const bedGeo = new THREE.PlaneGeometry(POOL_L, POOL_W, BX - 1, BZ - 1);
		bedGeo.rotateX(-Math.PI / 2);
		bedGeo.translate(POOL_L / 2, 0, 0);
		const bedMat = new THREE.MeshStandardMaterial({ color: '#8e9aa4', roughness: 0.95 });
		const bed = new THREE.Mesh(bedGeo, bedMat);
		scene.add(bed);
		function rebuildBed() {
			const pos = bedGeo.attributes.position;
			for (let i = 0; i < pos.count; i++) {
				pos.setY(i, bedY(pos.getX(i), pos.getZ(i)));
			}
			pos.needsUpdate = true;
			bedGeo.computeVertexNormals();
			stats.shoreX = shoreX();
		}
		let bedKey = '';

		const wallMat = new THREE.MeshStandardMaterial({ color: '#6d7883', roughness: 0.9 });
		const mkWall = (w: number, h: number, px: number, py: number, pz: number, ry = 0) => {
			const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), wallMat);
			m.position.set(px, py, pz);
			m.rotation.y = ry;
			scene.add(m);
			return m;
		};
		// Side walls face inward; back wall faces down-pool. The sides are
		// kept as refs so they HIDE when reflection is off — a drawn wall
		// that waves pass through would claim an interaction the physics
		// no longer has.
		const wallA = mkWall(POOL_L, 10, POOL_L / 2, -3, -POOL_W / 2, 0);
		const wallB = mkWall(POOL_L, 10, POOL_L / 2, -3, POOL_W / 2, Math.PI);
		mkWall(POOL_W, 10, 0, -3, 0, Math.PI / 2);

		// -- Water: one grid, heights summed from the packets --
		// 0.2m columns: a shore-compressed envelope (3 sigma ~ 0.7m) now
		// spans several cells instead of living between two vertices —
		// the other half of the amplitude jumpiness.
		const WX = 301;
		const WZ = 81;
		const waterGeo = new THREE.PlaneGeometry(POOL_L, POOL_W, WX - 1, WZ - 1);
		waterGeo.rotateX(-Math.PI / 2);
		waterGeo.translate(POOL_L / 2, 0, 0);
		const waterMat = new THREE.MeshStandardMaterial({
			color: '#2f6f9f',
			roughness: 0.35,
			transparent: true,
			opacity: 0.82,
			side: THREE.DoubleSide
		});
		const water = new THREE.Mesh(waterGeo, waterMat);
		scene.add(water);
		// Rest coordinates, captured once: the curl displaces vertices
		// HORIZONTALLY (an overturning lip is not a heightfield), so the
		// live position attribute can no longer serve as its own sample
		// grid.
		const waterBaseX = new Float32Array(waterGeo.attributes.position.count);
		const waterBaseZ = new Float32Array(waterGeo.attributes.position.count);
		for (let i = 0; i < waterBaseX.length; i++) {
			waterBaseX[i] = waterGeo.attributes.position.getX(i);
			waterBaseZ[i] = waterGeo.attributes.position.getZ(i);
		}

		// -- Packet markers: one bar per packet, perpendicular to travel --
		const MAXP = 400;
		/** Segments per marker bar: the bar draws the packet's own curved
		 *  crest (same parabola the surface uses), so the debug view and
		 *  the water can never disagree about the bend. */
		const BSEG = 8;
		const markGeo = new THREE.BufferGeometry();
		const markPos = new Float32Array(MAXP * BSEG * 2 * 3);
		const markCol = new Float32Array(MAXP * BSEG * 2 * 3);
		markGeo.setAttribute('position', new THREE.BufferAttribute(markPos, 3));
		markGeo.setAttribute('color', new THREE.BufferAttribute(markCol, 3));
		const marks = new THREE.LineSegments(
			markGeo,
			new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false })
		);
		marks.renderOrder = 10;
		marks.frustumCulled = false;
		scene.add(marks);

		// Envelope curves: the 2D packet tab's cyan envelope, drawn in 3D
		// over each packet — the vertical Gaussian profile along travel,
		// upper and lower. This is the instrument for the exact question
		// of whether crests move at a different speed than their packet:
		// the amber curve travels at cg, the surface's crests under it at
		// c, and any disagreement is visible instead of argued about.
		const ESEG = 16;
		/** Transverse arc resolution: the envelope's crest-following
		 *  curves, which are where the BEND is visible — the longitudinal
		 *  profiles sit at q = 0, where the parabola is zero by
		 *  construction, which is why the old overlay stayed straight
		 *  while the packet refracted under it. */
		const QSEG = 10;
		const envGeo = new THREE.BufferGeometry();
		const envPos = new Float32Array(MAXP * (ESEG * 2 + QSEG * 3) * 2 * 3);
		envGeo.setAttribute('position', new THREE.BufferAttribute(envPos, 3));
		const envLines = new THREE.LineSegments(
			envGeo,
			new THREE.LineBasicMaterial({ color: '#e0a33e', transparent: true, opacity: 0.7, depthTest: false })
		);
		envLines.renderOrder = 9;
		envLines.frustumCulled = false;
		scene.add(envLines);

		function updateMarks() {
			let n = 0;
			if (k.showPackets) {
				for (const p of packets) {
					if (n >= MAXP) break;
					const ct = Math.cos(p.theta);
					const st = Math.sin(p.theta);
					const kap = Math.min(Math.max(p.spread / (4 * p.sigQ), -0.2), 0.2);
					const y = 0.25 + p.a;
					// Cyan while sound, red once past the breaking criterion.
					const r = p.breaking ? 0.88 : 0.37;
					const g = p.breaking ? 0.35 : 0.84;
					const b = p.breaking ? 0.29 : 0.9;
					let o = n * BSEG * 6;
					for (let j = 0; j < BSEG; j++) {
						for (let e = 0; e < 2; e++) {
							const q = (((j + e) / BSEG) * 2 - 1) * p.sigQ;
							const sOff = -kap * q * q;
							markPos[o] = p.x + ct * sOff - st * q;
							markPos[o + 1] = y;
							markPos[o + 2] = p.z + st * sOff + ct * q;
							markCol[o] = r;
							markCol[o + 1] = g;
							markCol[o + 2] = b;
							o += 3;
						}
					}
					n++;
				}
			}
			markGeo.setDrawRange(0, n * BSEG * 2);
			markGeo.attributes.position.needsUpdate = true;
			markGeo.attributes.color.needsUpdate = true;

			let eo = 0;
			if (k.showPackets) {
				for (const p of packets) {
					if (eo + (ESEG * 2 + QSEG * 3) * 2 * 3 > envPos.length) break;
					const ct = Math.cos(p.theta);
					const st = Math.sin(p.theta);
					const kap = Math.min(Math.max(p.spread / (4 * p.sigQ), -0.2), 0.2);
					// Longitudinal profiles along the BENT SPINE — the ray the
					// envelope actually lies on, offset 0.5*pathK*s^2 off the
					// tangent. This is the bend of the packet's LENGTH, which
					// is what the eye reads top-down; drawn along the straight
					// heading these rails refused to turn however hard the ray
					// curved under them. (The transverse shoulder arcs are
					// gone — crest bend lives in the marker bars.)
					for (const sign of [1, -1]) {
						let lx = 0;
						let ly = 0;
						let lz = 0;
						for (let j = 0; j <= ESEG; j++) {
							const sTravel = (j / ESEG) * 6 * p.sigS - 3 * p.sigS;
							const qSpine = 0.5 * p.pathK * sTravel * sTravel;
							const y =
								sign * p.a * Math.exp(-(sTravel * sTravel) / (2 * p.sigS * p.sigS));
							const x = p.x + ct * sTravel - st * qSpine;
							const z = p.z + st * sTravel + ct * qSpine;
							if (j > 0) {
								envPos[eo++] = lx;
								envPos[eo++] = ly;
								envPos[eo++] = lz;
								envPos[eo++] = x;
								envPos[eo++] = y;
								envPos[eo++] = z;
							}
							lx = x;
							ly = y;
							lz = z;
						}
					}
				}
			}
			envGeo.setDrawRange(0, eo / 3);
			envGeo.attributes.position.needsUpdate = true;
		}

		// -- Interaction: the fire button, or space. No wedge: a paddle
		// stroke makes a CREST, and any packet in a real pool is emergent
		// from many of them — a machine that dispenses ready-made packets
		// was theatre pretending to be mechanism, so the trigger is now
		// honestly abstract. --
		function onKey(ev: KeyboardEvent) {
			if (ev.code === 'Space') {
				ev.preventDefault();
				fireStroke();
			}
		}
		window.addEventListener('keydown', onKey);

		const gctx = gcanvas?.getContext('2d') ?? null;
		/**
		 * The strip: one graph of the component SUM — which is the packet
		 * — and one graph per component. Every curve is the same WKB
		 * phase field at the same lab time, so what the strip shows is
		 * not an illustration of the 3D pool, it is the same mathematics
		 * drawn a different way: watch a crest in the sum, find it in the
		 * components, and see it exist only where they agree.
		 */
		function drawGraphs(g: CanvasRenderingContext2D) {
			if (!gcanvas) return;
			const dpr = window.devicePixelRatio || 1;
			const W = gcanvas.clientWidth;
			const H = gcanvas.clientHeight;
			if (gcanvas.width !== W * dpr || gcanvas.height !== H * dpr) {
				gcanvas.width = W * dpr;
				gcanvas.height = H * dpr;
			}
			const PW = gcanvas.width;
			const PH = gcanvas.height;
			g.setTransform(1, 0, 0, 1, 0, 0);
			g.fillStyle = '#0d1319';
			g.fillRect(0, 0, PW, PH);
			const PAD = 78 * dpr;
			const tau = labT - strokeT0;
			const liveH = Math.round(PH * 0.3);
			const sumH = Math.round(PH * 0.2);
			const rowH = (PH - liveH - sumH) / NCOMP;
			const sx = (x: number) => PAD + (x / POOL_L) * (PW - PAD - 8 * dpr);
			const shoreSx = sx(shoreX());

			const row = (
				y0: number,
				h: number,
				fn: (x: number) => number,
				colour: string,
				label: string
			) => {
				const mid = y0 + h / 2;
				g.strokeStyle = '#1c2833';
				g.lineWidth = dpr;
				g.beginPath();
				g.moveTo(PAD, mid);
				g.lineTo(PW, mid);
				g.stroke();
				// Shoreline, so the convergence of the components' speeds
				// can be read against where the shallows begin.
				g.strokeStyle = '#33424f';
				g.beginPath();
				g.moveTo(shoreSx, y0 + 2);
				g.lineTo(shoreSx, y0 + h - 2);
				g.stroke();
				g.strokeStyle = colour;
				g.lineWidth = 1.4 * dpr;
				g.beginPath();
				const N = 300;
				for (let i = 0; i <= N; i++) {
					const x = (i / N) * POOL_L;
					const y = mid - fn(x) * (h * 0.42);
					if (i === 0) g.moveTo(sx(x), y);
					else g.lineTo(sx(x), y);
				}
				g.stroke();
				g.fillStyle = '#8fa2b3';
				g.font = `${10 * dpr}px ui-monospace, Menlo, monospace`;
				g.fillText(label, 8 * dpr, y0 + h / 2 + 3 * dpr);
			};

			// TUNING WAVE: a synthetic STEADY TRAIN, always running — like
			// the spectral rows below, it needs no stroke. Every formula is
			// the packet code's, applied to the steady-state train instead
			// of a fired group: amplitude from flux conservation, capped by
			// the same 0.39d saturation, spent = how much the cap has
			// eaten, the decay rig riding spent, trochoid and curl
			// verbatim. Parametric, so the lip draws as a loop. What this
			// row deliberately lacks is the envelope — no group structure —
			// which is exactly why it can run forever: it is the wave the
			// train would carry at every x simultaneously, the ideal
			// subject for tuning shape against progression without firing.
			{
				const mid = liveH * 0.55;
				g.strokeStyle = '#1c2833';
				g.lineWidth = dpr;
				g.beginPath();
				g.moveTo(PAD, mid);
				g.lineTo(PW, mid);
				g.stroke();
				g.strokeStyle = '#33424f';
				g.beginPath();
				g.moveTo(shoreSx, 2);
				g.lineTo(shoreSx, liveH - 2);
				g.stroke();
				const cc = comps[(NCOMP - 1) / 2];
				if (cc) {
					const omega = cc.omega;
					const kD0 = waveNumber(omega, k.deepM);
					const cg0 = groupSpeed(omega, kD0, k.deepM);
					const scaleY = (liveH * 0.38) / Math.max(1.6 * k.amp, 0.4);
					g.strokeStyle = '#9fd8ea';
					g.lineWidth = 1.6 * dpr;
					g.beginPath();
					const NL = 340;
					for (let i = 0; i <= NL; i++) {
						const xw = (i / NL) * POOL_L;
						const d = depthAt(xw, 0);
						const kL = waveNumber(omega, d);
						const cg = groupSpeed(omega, kL, d);
						const A0x = k.shoal
							? k.amp * Math.sqrt(cg0 / Math.max(cg, 0.05))
							: k.amp;
						const Ax = k.breakLoss ? Math.min(A0x, 0.39 * d) : A0x;
						const spent = A0x > 1e-6 ? 1 - Ax / A0x : 0;
						const dm =
							k.dcVar === 'none'
								? 1
								: Math.min(
										Math.max(
											1 - k.dcRate * Math.max(spent - k.dcStart, 0),
											k.dcLimit
										),
										1
									);
						const sEff = k.steep * (k.dcVar === 'steep' ? dm : 1);
						const cDegEff = k.curlDeg * (k.dcVar === 'curlDeg' ? dm : 1);
						const cPowEff = k.curlPow * (k.dcVar === 'curlPow' ? dm : 1);
						const cPivEff = k.curlPivot * (k.dcVar === 'curlPivot' ? dm : 1);
						const cWinEff = Math.max(
							k.curlWindow * (k.dcVar === 'curlWindow' ? dm : 1),
							0.05
						);
						const ph = compPhase(cc, xw, labT);
						const m2 = ph / (2 * Math.PI);
						const psi = 2 * Math.PI * (m2 - Math.round(m2));
						const co = Math.cos(ph);
						const si = Math.sin(ph);
						let y = Ax * co;
						let dxp = -sEff * Ax * si;
						if (k.curl && Math.abs(psi) < cWinEff) {
							const bRaw = Math.min(
								Math.max(((2 * Ax) / d - 0.55) / 0.35, 0),
								1
							);
							const bAmt = bRaw * bRaw * (3 - 2 * bRaw) * (1 - spent);
							if (bAmt > 0.002) {
								const wf = Math.cos((psi / cWinEff) * (Math.PI / 2));
								const phi =
									((cDegEff * Math.PI) / 180) * bAmt * Math.pow(wf, cPowEff);
								const du = psi / kL;
								const hy = Ax * (1 - cPivEff);
								const rx = du + dxp;
								const ry = y - hy;
								const cs = Math.cos(phi);
								const sf = Math.sin(phi);
								y = hy + (-rx * sf + ry * cs);
								dxp = rx * cs + ry * sf - du;
							}
						}
						const px2 = sx(xw + dxp);
						const py2 = mid - y * scaleY;
						if (i === 0) g.moveTo(px2, py2);
						else g.lineTo(px2, py2);
					}
					g.stroke();
				}
				g.fillStyle = '#8fa2b3';
				g.font = `${10 * dpr}px ui-monospace, Menlo, monospace`;
				g.fillText('tuning wave · steady train', 8 * dpr, mid + 3 * dpr);
			}
			row(
				liveH,
				sumH,
				(x) => {
					let e = 0;
					for (const c of comps) e += c.w * Math.cos(compPhase(c, x, tau));
					return e;
				},
				'#e0a33e',
				'sum = packet'
			);
			for (let i = 0; i < comps.length; i++) {
				const c = comps[i];
				row(
					liveH + sumH + i * rowH,
					rowH,
					(x) => c.w * Math.cos(compPhase(c, x, tau)),
					i === (NCOMP - 1) / 2 ? '#7fd4a5' : '#5fd6e6',
					`λ${((2 * Math.PI) / c.kDeep).toFixed(1)} c${(c.omega / c.kDeep).toFixed(1)}`
				);
			}
		}

		let raf = 0;
		let fireClock = 0;
		let surfaceLive = false;
		let last = performance.now();
		function frame() {
			raf = requestAnimationFrame(frame);
			const now = performance.now();
			const dt = Math.min((now - last) / 1000, 0.1) * k.simSpeed;
			last = now;

			const key = `${k.deepM},${k.rampStartM},${k.periodS},${k.pulseM},${bedShape},${k.headJutM},${k.headWideM}`;
			if (key !== bedKey) {
				bedKey = key;
				rebuildBed();
				rebuildComps();
			}

			if (!k.paused && dt > 0) {
				labT += dt;
				if (k.autoFire) {
					fireClock += dt;
					if (fireClock >= k.periodS) {
						fireClock = 0;
						fireStroke();
					}
				}
				stepPackets(dt);
			}

			// Re-evaluate the surface only while there is something on it.
			// The grid sum plus computeVertexNormals is the frame's whole
			// cost, and an idle pool re-deriving a flat plane sixty times a
			// second is pure heat. One extra pass after the last packet
			// dies settles the mesh back to flat, then the loop is just a
			// render until the next stroke.
			if (packets.length > 0 || surfaceLive) {
				surfaceLive = packets.length > 0;
				const pos = waterGeo.attributes.position;
				const nrm = waterGeo.attributes.normal;
				for (let i = 0; i < pos.count; i++) {
					surfaceAt(waterBaseX[i], waterBaseZ[i]);
					pos.setXYZ(i, waterBaseX[i] + surf.dx, surf.y, waterBaseZ[i] + surf.dz);
					// Analytic normal from the UNBENT field. The curl's
					// rotation is not chain-ruled through the lighting — a
					// curling crest shades slightly as though still upright.
					// Accepted for the lab: the silhouette is the point here.
					const inv = 1 / Math.hypot(surf.gx, 1, surf.gz);
					nrm.setXYZ(i, -surf.gx * inv, inv, -surf.gz * inv);
				}
				pos.needsUpdate = true;
				nrm.needsUpdate = true;
			}
			updateMarks();

			{
				const omega = (2 * Math.PI) / Math.max(k.periodS, 0.1);
				const kDeep = waveNumber(omega, k.deepM);
				stats.cgDeep = groupSpeed(omega, kDeep, k.deepM);
				stats.lambdaDeep = (2 * Math.PI) / kDeep;
			}

			const w = host.clientWidth;
			const h = host.clientHeight;
			const c = renderer.domElement;
			if (c.width !== w * renderer.getPixelRatio() || c.height !== h * renderer.getPixelRatio()) {
				renderer.setSize(w, h, false);
				camera.aspect = w / h;
				camera.updateProjectionMatrix();
				// First sized frame is the earliest the true aspect exists.
				if (!framed && w > 0 && h > 0) {
					framed = true;
					frameThePool(w / h);
				}
			}
			wallA.visible = wallB.visible = k.reflectWalls;
			controls.update();
			renderer.render(scene, camera);
			if (gctx) drawGraphs(gctx);
		}
		frame();

		return () => {
			cancelAnimationFrame(raf);
			window.removeEventListener('keydown', onKey);
			controls.dispose();
			bedGeo.dispose();
			waterGeo.dispose();
			markGeo.dispose();
			renderer.dispose();
			host.removeChild(renderer.domElement);
		};
	});
</script>

<div class="page">
	<div class="panel">
		<div class="head">
			<button onclick={fireStroke}>fire stroke</button>
			<label><input type="checkbox" bind:checked={k.paused} /> pause</label>
		</div>
		<div class="group">bed</div>
		<div class="head">
			{#each ['ramp', 'headland', 'reef', 'channel'] as b (b)}
				<button class:on={bedShape === b} onclick={() => (bedShape = b as typeof bedShape)}>{b}</button>
			{/each}
		</div>
		<div class="group">stroke</div>
		{#each ROWS as [key, min, max, step] (key)}
			<div class="row">
				<span class="name">{key}</span>
				<input type="range" {min} {max} {step} bind:value={k[key] as number} />
				<span class="val">{(k[key] as number).toFixed(2)}</span>
			</div>
		{/each}
		<div class="head">
			<label><input type="checkbox" bind:checked={k.shoal} /> shoal</label>
			<label><input type="checkbox" bind:checked={k.spreadEnergy} /> focus</label>
			<label><input type="checkbox" bind:checked={k.breakLoss} /> break</label>
			<label><input type="checkbox" bind:checked={k.curl} /> curl</label>
			<label>
				decay
				<select bind:value={k.dcVar}>
					<option value="none">none</option>
					<option value="steep">steep</option>
					<option value="curlDeg">curlDeg</option>
					<option value="curlPow">curlPow</option>
					<option value="curlPivot">curlPivot</option>
					<option value="curlWindow">curlWindow</option>
				</select>
			</label>
			<label><input type="checkbox" bind:checked={k.autoFire} /> train</label>
			<label><input type="checkbox" bind:checked={k.reflectWalls} /> walls</label>
			<label><input type="checkbox" bind:checked={k.showPackets} /> packets</label>
		</div>
		<div class="group">readout</div>
		<div class="row"><span class="name">packets live</span><span class="val">{stats.live}</span></div>
		<div class="row"><span class="name">cg deep</span><span class="val">{stats.cgDeep.toFixed(2)} m/s</span></div>
		<div class="row"><span class="name">lambda deep</span><span class="val">{stats.lambdaDeep.toFixed(1)} m</span></div>
		<div class="row"><span class="name">c/cg @lead</span><span class="val">{stats.cOverCg.toFixed(2)}</span></div>
		<div class="row"><span class="name">shoreline x</span><span class="val">{stats.shoreX.toFixed(1)} m</span></div>
		<div class="row"><span class="name">max H/d</span><span class="val">{stats.maxHd.toFixed(2)}</span></div>
		<div class="row"><span class="name">peak A</span><span class="val">{stats.peakA.toFixed(2)} m</span></div>
		<p class="note">
			Fire a stroke (button or space): a row of wave packets, each
			carrying its own position, direction, omega and phase. There is
			no wedge on purpose — a paddle makes single crests, and real
			packets are emergent; the trigger is honestly abstract. Depth sets k through the dispersion relation, so the
			pulse slows and compresses over the ramp; with shoal on,
			amplitude follows energy flux along each packet's own ray. Side
			walls reflect. Bars mark packet centres — red once H passes
			0.78d, reported, not enforced. Drag to orbit, wheel to zoom.
			The bed presets are ONE function (bedY) re-shaped, and
			everything follows it. ramp is the control — no lateral
			variation, so any turning is a bug. headland: crests wrap the
			bulge, energy converging on the point. reef: a shore-parallel
			bar spanning the width, deliberately 1D — packets shoal on the
			crown (H/d flags red) and reform in the deeper water behind,
			and with walls off the sides are truly open: what leaves the
			pool is swallowed, not reflected and not haunting the edge.
			channel: deeper is faster, so rays refract out of
			the corridor onto its shoulders. focus toggles the lateral
			energy term (A&sup2; x length x width conserved); off, widths
			freeze and only 1D shoaling remains.
			The strip below decomposes the LAST stroke: amber is the sum of
			seven sinusoids sampled from the pulse's own spectrum — the sum
			IS the packet — and each row is one component with its deep
			wavelength and phase speed, propagated by its own phase
			integral over the real bed. Left of the shore line the speeds
			differ and the pulse exists only where the rows agree; past it
			they converge and the crests lock.
		</p>
	</div>
	<div class="stack">
		<div class="stage" bind:this={host}></div>
		<canvas class="graphs" bind:this={gcanvas}></canvas>
	</div>
</div>

<style>
	:global(html, body) {
		margin: 0;
		height: 100%;
		/* The page owns the viewport: everything scales to fit inside it,
		   and nothing is allowed to push the strip below the fold. */
		overflow: hidden;
		background: #10161c;
	}
	.page {
		/* FIXED to the viewport, not 100vh of document flow: the root
		   layout puts a Nav above every page, so a flowed 100vh page is
		   nav-height too tall — it either scrolls (the first complaint)
		   or, with overflow hidden, clips the strip (the second). Same
		   bug, two symptoms. Fixed-inset sidesteps the shell entirely;
		   the lab pages are reached by URL, not the nav. */
		position: fixed;
		inset: 0;
		z-index: 10;
		display: flex;
		height: 100vh;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 12px;
		color: #cfd8e0;
	}
	.panel {
		width: 300px;
		padding: 12px;
		overflow-y: auto;
		border-right: 1px solid #22303e;
		flex-shrink: 0;
	}
	.stack {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
	}
	.stage {
		flex: 1;
		min-height: 0;
	}
	.graphs {
		/* A share of the viewport, not a fixed strip: on a short window a
		   hard 320px ate the 3D view or spilled past the fold, and the
		   rows already scale to whatever height they are given. */
		height: clamp(170px, 34vh, 320px);
		flex-shrink: 0;
		width: 100%;
		display: block;
		border-top: 1px solid #22303e;
	}
	.head {
		display: flex;
		gap: 12px;
		align-items: center;
		margin: 6px 0;
	}
	.head button {
		background: #1d2833;
		border: 1px solid #33445a;
		color: #5fd6e6;
		font: inherit;
		padding: 4px 10px;
		cursor: pointer;
	}
	.head button:hover {
		background: #24313f;
	}
	.head button.on {
		color: #e0a33e;
		border-color: #e0a33e;
	}
	.head select {
		background: #1d2833;
		border: 1px solid #33445a;
		color: #cfd8e0;
		font: inherit;
	}
	.group {
		margin: 12px 0 4px;
		color: #7fd4a5;
		text-transform: uppercase;
		letter-spacing: 0.08em;
	}
	.row {
		display: flex;
		align-items: center;
		gap: 8px;
		margin: 3px 0;
	}
	.name {
		width: 92px;
		color: #8fa2b3;
	}
	.row input[type='range'] {
		flex: 1;
	}
	.val {
		width: 64px;
		text-align: right;
		font-variant-numeric: tabular-nums;
	}
	.note {
		margin-top: 14px;
		color: #7d8fa0;
		line-height: 1.5;
	}
</style>
