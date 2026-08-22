/**
 * 2D PIC/FLIP wave tank for the /wave lab — the coupling prototype for
 * the hybrid plan.
 *
 * A vertical slice set up like a laboratory flume: solid walls at both
 * ends, a GENERATOR zone on the left where particle velocities are
 * relaxed toward the analytic Gerstner orbital field (unidirectional
 * Gerstner -> FLIP coupling — the same mechanism an in-game patch would
 * use at its upstream edge; it also absorbs anything reflected back
 * into it), a flat deep section, and a linearly rising bed toward the
 * right where waves shoal, steepen and break on their own — no scripted
 * breaking anywhere.
 *
 * Solver: classic staggered-MAC FLIP (Ten Minute Physics / jeantimex
 * style) — integrate, push apart, transfer to grid, Gauss-Seidel
 * projection with particle-density drift compensation, PIC/FLIP blend
 * back. Hot loops hoist every array to locals; `this.` lookups at
 * millions per step were most of an early profile.
 *
 * Seeding uses the TRUE trochoid: circular orbits, radius = amplitude,
 * steepness = k * amp. The game's q-scaled elliptic sway is not
 * volume-preserving and hands the solver a fluid with baked-in density
 * errors (measured: 3x crest detonation in the first second).
 */

export interface FlipParams {
	/**
	 * CREST MODE: instead of a shore tank, the box rides a single Gerstner
	 * crest in the WAVE FRAME (moving at phase speed c). There the wave is
	 * STEADY — frozen surface, water streaming through at orbital minus
	 * c — so "the rest of the larger wave" is injected as static velocity
	 * forcing on the side and bottom bands. The crest's wave-frame speed
	 * is (steepness - 1) * c: below 1 a steady crest exists and the sim
	 * should hold it; past 1 the crest outruns the wave and must throw a
	 * jet. This is the in-game patch, prototyped.
	 */
	crestMode: boolean;
	/**
	 * Crest mode only: the wave's steepness (loop threshold at 1). Crest
	 * water moves at steepness x c relative to the wave in BOTH the
	 * game's elliptic convention and the true trochoid, so the breaking
	 * criterion transfers — but only the trochoid is volume-consistent,
	 * so the sim uses it: orbit radius = steepness / k, and the amp knob
	 * is ignored in crest mode. (Forcing the elliptic field on an
	 * incompressible fluid churned 2x-c currents out of nothing.)
	 */
	steepness: number;
	lambda: number;
	/** Orbit radius = elevation amplitude; steepness is k * amp, derived. */
	amp: number;
	/** Water depth over the flat section, metres. */
	depth: number;
	/** Domain length in wavelengths. */
	domainWaves: number;
	/** Fraction of the domain where the bed starts rising. */
	slopeStart: number;
	/** Cells per wavelength. */
	gridNx: number;
	/**
	 * Phase-speed multiplier. Deep-water speed is locked to wavelength by
	 * dispersion, so the honest lever is gravity: g scales by waveSpeed^2
	 * everywhere (particle weight, dispersion, generator), and every
	 * wavelength travels waveSpeed x faster with the whole sim — breaking,
	 * bores, runup — staying self-consistent.
	 */
	waveSpeed: number;
	/** Generator relaxation rate, 1/s (0 = off; seeded wave only). */
	genStrength: number;
	/** Generator zone width, wavelengths. */
	genWidth: number;
	flipRatio: number;
	pressureIters: number;
	stiffness: number;
	separateIters: number;
	/** Bed friction, 1/s, acting in a thin layer above the bed. */
	bottomDrag: number;
	/**
	 * Wind, m/s, blowing toward the beach. Jeffreys sheltering: the air
	 * pressure asymmetry rides the surface SLOPE (not the height — that
	 * does no net work on a travelling wave), scaled by (U-c)|U-c| so
	 * wind slower than the wave grows nothing. Waves gain energy across
	 * the tank until breaking regulates them.
	 */
	windSpeed: number;
	/**
	 * Tide: a long swell (10 lambda) added to the generator. Longer than
	 * the whole tank, so inside it it reads as the water level slowly
	 * breathing — surf shifts up and down the beach with the phase.
	 */
	tide: number;
}

const G = 9.81;
const SOLID = 0;
const FLUID = 1;
const AIR = 2;

export class FlipSlice {
	// Grid: cell (i, j) at idx i * ny + j.
	nx = 0;
	ny = 0;
	h = 1;
	width = 0;
	/** u[i * ny + j] = LEFT face of cell column i. */
	private u = new Float32Array(0);
	/** v[i * (ny + 1) + j] = BOTTOM face of cell (i, j). */
	private v = new Float32Array(0);
	private uW = new Float32Array(0);
	private vW = new Float32Array(0);
	private prevU = new Float32Array(0);
	private prevV = new Float32Array(0);
	private cellType = new Int8Array(0);
	private solidMask = new Int8Array(0);
	private density = new Float32Array(0);
	private restDensity = 0;

	// Particles.
	numP = 0;
	px = new Float32Array(0);
	py = new Float32Array(0);
	pu = new Float32Array(0);
	pv = new Float32Array(0);
	radius = 0.1;
	/** Mean-surface height above y = 0 (the waterline). */
	surfaceY = 0;
	/** Actual water depth in the box (crest mode may deepen the knob). */
	depthEff = 0;
	/**
	 * Crest mode runs PERIODIC in x: in the wave frame water streams
	 * through the box at up to phase speed, and closed walls dam that
	 * flux — the pile-up starved the crest within seconds. One periodic
	 * wavelength recycles it exactly.
	 */
	private periodic = false;
	/** Bed-top height per column (world y), linearly interpolated. */
	bedY = new Float32Array(0);
	/** Highest particle per column, from the last markCells (wind + viz). */
	surfCol = new Float32Array(0);

	// Push-apart spatial hash.
	private hashSpacing = 1;
	private hashNx = 0;
	private hashNy = 0;
	private hashCount = new Int32Array(0);
	private hashFirst = new Int32Array(0);
	private hashIds = new Int32Array(0);

	/** Wall-clock cost of the last step, ms. */
	lastStepMs = 0;

	/** Bed height at world x (linear between columns). */
	bedAt(x: number): number {
		const nx = this.nx;
		const fx = Math.min(Math.max(x / this.h, 0), nx - 1.001);
		const i = fx | 0;
		const t = fx - i;
		return this.bedY[i] * (1 - t) + this.bedY[i + 1] * t;
	}

	seed(p: FlipParams, t0: number) {
		this.width = p.lambda * p.domainWaves;
		this.nx = Math.max(48, Math.round(p.gridNx * p.domainWaves));
		this.h = this.width / this.nx;
		const kWave = (2 * Math.PI) / p.lambda;
		// Crest mode: trochoid radius from steepness; the trough must stay
		// clear of the bottom forcing band, so the box deepens as needed.
		const aEff = p.crestMode ? p.steepness / kWave : p.amp;
		const depthEff = p.crestMode ? Math.max(p.depth, aEff / 0.7 + 1) : p.depth;
		this.depthEff = depthEff;
		const headroom = Math.max(2 * aEff + 2, 4);
		this.ny = Math.max(8, Math.ceil((depthEff + headroom) / this.h) + 1);
		this.surfaceY = this.h + depthEff;

		// Bed: one solid row of floor, flat until slopeStart, then linear
		// up to 2m ABOVE the waterline at the right wall — a beach the
		// runup can climb. Crest mode has no beach: the box bottom is a
		// forcing band standing in for the deep wave below.
		this.bedY = new Float32Array(this.nx + 1);
		const xs = p.slopeStart * this.width;
		const shoreY = this.surfaceY + 2;
		for (let i = 0; i <= this.nx; i++) {
			const x = i * this.h;
			const f =
				p.crestMode || x <= xs ? 0 : (x - xs) / Math.max(this.width - xs, 1e-6);
			this.bedY[i] = this.h + f * (shoreY - this.h);
		}

		const cells = this.nx * this.ny;
		this.u = new Float32Array(this.nx * this.ny);
		this.v = new Float32Array(this.nx * (this.ny + 1));
		this.uW = new Float32Array(this.u.length);
		this.vW = new Float32Array(this.v.length);
		this.prevU = new Float32Array(this.u.length);
		this.prevV = new Float32Array(this.v.length);
		this.cellType = new Int8Array(cells);
		this.density = new Float32Array(cells);
		this.surfCol = new Float32Array(this.nx);

		// Solid mask: walls at both ends (tank only), bed below its height.
		this.periodic = !!p.crestMode;
		this.solidMask = new Int8Array(cells);
		for (let i = 0; i < this.nx; i++) {
			for (let j = 0; j < this.ny; j++) {
				const solid =
					(!this.periodic && (i === 0 || i === this.nx - 1)) ||
					(j + 0.5) * this.h < this.bedAt((i + 0.5) * this.h);
				if (solid) this.solidMask[i * this.ny + j] = 1;
			}
		}

		// Particles: jittered 2x2-per-cell rest lattice below the surface
		// and above the bed, displaced onto Gerstner orbits. Tank mode uses
		// circular orbits (volume-true); crest mode uses the game's
		// elliptic q-scaled orbits, in the wave frame, with the crest
		// pinned at the box centre — the density mismatch of the elliptic
		// map is a seed transient the band forcing absorbs.
		// FINITE-DEPTH (Airy) structure: dispersion sqrt(gk tanh(kd)) and
		// cosh/sinh vertical profiles. Deep-water formulas in a shallow box
		// made the analytic wave 9% faster than the fluid's own — the sim
		// slipped out of phase with its forcing and decayed within seconds.
		const k = kWave;
		const th = Math.tanh(k * depthEff);
		const omega = Math.sqrt(G * k * th) * (p.waveSpeed || 1);
		const a = aEff;
		const sinhKd = Math.sinh(k * depthEff);
		const cPhase = omega / k;
		const spacing = this.h / 2;
		// 2r under the lattice spacing, or the push-apart inflates the
		// whole column from frame one.
		this.radius = 0.22 * this.h;
		const cols = Math.round(this.width / spacing);
		const rows = Math.ceil((depthEff + a) / spacing);
		const cap = cols * rows;
		this.px = new Float32Array(cap);
		this.py = new Float32Array(cap);
		this.pu = new Float32Array(cap);
		this.pv = new Float32Array(cap);
		let n = 0;
		for (let ci = 0; ci < cols; ci++) {
			for (let rj = 0; rj < rows; rj++) {
				const x0 = (ci + 0.25 + Math.random() * 0.5) * spacing;
				const y0 = this.h + this.radius + (rj + 0.25 + Math.random() * 0.5) * spacing;
				if (y0 > this.surfaceY) continue;
				const yb = Math.min(y0, this.surfaceY) - this.h;
				const ch = Math.cosh(k * yb) / sinhKd;
				const sh = Math.sinh(k * yb) / sinhKd;
				const theta = p.crestMode
					? k * (x0 - this.width / 2) + Math.PI / 2
					: k * x0 - omega * t0;
				const cx = x0 + a * ch * Math.cos(theta);
				const cy = y0 + a * sh * Math.sin(theta);
				if (this.periodic) {
					// wrap into the periodic box
				} else if (cx < this.h + this.radius || cx > this.width - this.h - this.radius) {
					continue;
				}
				const cxw = this.periodic ? ((cx % this.width) + this.width) % this.width : cx;
				if (cy < this.bedAt(cxw) + this.radius) continue;
				this.px[n] = cxw;
				this.py[n] = cy;
				this.pu[n] = a * ch * omega * Math.sin(theta) - (p.crestMode ? cPhase : 0);
				this.pv[n] = -a * sh * omega * Math.cos(theta);
				n++;
			}
		}
		this.numP = n;

		this.hashSpacing = 2.2 * this.radius;
		this.hashNx = Math.ceil(this.width / this.hashSpacing);
		this.hashNy = Math.ceil((this.ny * this.h) / this.hashSpacing) + 1;
		this.hashCount = new Int32Array(this.hashNx * this.hashNy + 1);
		this.hashFirst = new Int32Array(this.hashNx * this.hashNy + 1);
		this.hashIds = new Int32Array(cap);

		// Rest density over INTERIOR fluid cells only: surface cells are
		// half-empty and drag the target low, turning the compensation
		// into a steady outward push.
		this.markCells();
		this.particleDensity();
		let sum = 0;
		let count = 0;
		const ny = this.ny;
		const ct = this.cellType;
		for (let i = 1; i < this.nx - 1; i++) {
			for (let j = 1; j < ny - 1; j++) {
				if (ct[i * ny + j] !== FLUID) continue;
				if (
					ct[(i - 1) * ny + j] === FLUID &&
					ct[(i + 1) * ny + j] === FLUID &&
					ct[i * ny + j + 1] === FLUID &&
					ct[i * ny + j - 1] !== AIR
				) {
					sum += this.density[i * ny + j];
					count++;
				}
			}
		}
		this.restDensity = count > 0 ? sum / count : 0;
	}

	step(dt: number, t: number, p: FlipParams) {
		if (this.numP === 0) return;
		const start = performance.now();
		this.integrate(dt, p.waveSpeed || 1);
		if (p.crestMode) this.forceCrest(dt, p);
		else this.generate(dt, t, p);
		if (p.windSpeed > 0) this.windForce(dt, p);
		for (let it = 0; it < p.separateIters; it++) this.pushApart();
		this.collide(dt, p.bottomDrag || 0);
		this.toGrid();
		this.markCells();
		this.particleDensity();
		this.prevU.set(this.u);
		this.prevV.set(this.v);
		this.project(p.pressureIters, p.stiffness);
		this.fromGrid(p.flipRatio);
		this.lastStepMs = performance.now() - start;
	}

	private integrate(dt: number, waveSpeed: number) {
		const { px, py, pu, pv, numP, width, periodic } = this;
		const g = G * waveSpeed * waveSpeed * dt;
		for (let i = 0; i < numP; i++) {
			pv[i] -= g;
			let x = px[i] + pu[i] * dt;
			if (periodic) {
				if (x < 0) x += width;
				else if (x >= width) x -= width;
			}
			px[i] = x;
			py[i] += pv[i] * dt;
		}
	}

	/**
	 * The Gerstner conveyor: inside the generator zone, relax particle
	 * velocities toward the analytic orbital field, strongest at the wall
	 * and fading to nothing at the zone's edge. Feeds waves in AND
	 * swallows anything reflected back — the same trick twice.
	 */
	private generate(dt: number, t: number, p: FlipParams) {
		if (p.genStrength <= 0) return;
		const genW = p.genWidth * p.lambda;
		const d = this.depthEff;
		// Component 1: the primary Airy wave.
		const k1 = (2 * Math.PI) / p.lambda;
		const om1 = Math.sqrt(G * k1 * Math.tanh(k1 * d)) * (p.waveSpeed || 1);
		const s1 = Math.sinh(k1 * d);
		const a1 = p.amp;
		// Component 2: the BOUND second harmonic, scaled by the steepness
		// knob — 1 is the full Stokes coefficient (ka^2 / 2). Bound means
		// it rides the primary's phase speed: k and omega both double.
		const k2 = 2 * k1;
		const om2 = 2 * om1;
		const s2 = Math.sinh(k2 * d);
		const a2 = 0.5 * p.steepness * k1 * a1 * a1;
		// Component 3: the tide — a 10-lambda swell, longer than the tank,
		// so inside it it reads as the level slowly breathing.
		const kt = (2 * Math.PI) / (10 * p.lambda);
		const omt = Math.sqrt(G * kt * Math.tanh(kt * d)) * (p.waveSpeed || 1);
		const st = Math.sinh(kt * d);
		const at = p.tide;
		const { px, py, pu, pv, numP, surfaceY, h } = this;
		for (let i = 0; i < numP; i++) {
			const x = px[i];
			if (x >= genW) continue;
			const w = 1 - x / genW;
			const blend = Math.min(p.genStrength * dt * w, 1);
			const yb = Math.min(py[i], surfaceY) - h;
			let uG = 0;
			let vG = 0;
			{
				const theta = k1 * x - om1 * t;
				uG += ((a1 * Math.cosh(k1 * yb)) / s1) * om1 * Math.sin(theta);
				vG += ((-a1 * Math.sinh(k1 * yb)) / s1) * om1 * Math.cos(theta);
			}
			if (a2 > 0) {
				const theta = k2 * x - om2 * t;
				uG += ((a2 * Math.cosh(k2 * yb)) / s2) * om2 * Math.sin(theta);
				vG += ((-a2 * Math.sinh(k2 * yb)) / s2) * om2 * Math.cos(theta);
			}
			if (at > 0) {
				const theta = kt * x - omt * t;
				uG += ((at * Math.cosh(kt * yb)) / st) * omt * Math.sin(theta);
				vG += ((-at * Math.sinh(kt * yb)) / st) * omt * Math.cos(theta);
			}
			pu[i] += (uG - pu[i]) * blend;
			pv[i] += (vG - pv[i]) * blend;
		}
	}

	/**
	 * Wind input (Jeffreys sheltering) on the surface layer: vertical
	 * force proportional to MINUS the local surface slope, scaled by
	 * (U-c)|U-c|. On a travelling wave that is in phase with the surface
	 * velocity, so it does net positive work — waves grow with fetch
	 * until breaking eats the input.
	 */
	private windForce(dt: number, p: FlipParams) {
		const k1 = (2 * Math.PI) / p.lambda;
		const om1 = Math.sqrt(G * k1 * Math.tanh(k1 * this.depthEff));
		const c1 = om1 / k1;
		const rel = p.windSpeed - c1;
		const K = 0.05 * rel * Math.abs(rel);
		if (K <= 0) return;
		const { px, py, pv, numP, nx, h } = this;
		const surf = this.surfCol;
		const invH = 1 / h;
		const layer = 1.5 * h;
		for (let i = 0; i < numP; i++) {
			const ci = Math.min(Math.max((px[i] * invH) | 0, 0), nx - 1);
			const top = surf[ci];
			if (top < -1e8 || py[i] < top - layer) continue;
			const iL = Math.max(ci - 1, 0);
			const iR = Math.min(ci + 1, nx - 1);
			if (surf[iL] < -1e8 || surf[iR] < -1e8) continue;
			const slope = (surf[iR] - surf[iL]) / ((iR - iL) * h);
			let acc = -K * slope;
			if (acc > 3) acc = 3;
			else if (acc < -3) acc = -3;
			pv[i] += acc * dt;
		}
	}

	/**
	 * Crest-mode coupling: relax particle velocities toward the STATIC
	 * wave-frame Gerstner field inside three bands — both side walls and
	 * the bottom — standing in for the larger wave the box is riding.
	 * theta uses the world x directly (no rest inversion): the bands sit
	 * where the Jacobian is comfortable, and centimetre phase error is
	 * nothing against a relaxation forcing.
	 */
	private forceCrest(dt: number, p: FlipParams) {
		if (p.genStrength <= 0) return;
		const k = (2 * Math.PI) / p.lambda;
		const th = Math.tanh(k * this.depthEff);
		const omega = Math.sqrt(G * k * th) * (p.waveSpeed || 1);
		const sinhKd = Math.sinh(k * this.depthEff);
		const a = p.steepness / k; // elevation amplitude, matching the seed
		const cPhase = omega / k;
		const bandY = Math.max(0.3 * this.depthEff, 2 * this.h);
		const { px, py, pu, pv, numP, surfaceY, width, h } = this;
		for (let i = 0; i < numP; i++) {
			const x = px[i];
			const y = py[i];
			// Periodic x: only the BOTTOM band forces — it pins the deep
			// flow of the larger wave and bleeds off slow drift.
			const w = 1 - (y - h) / bandY;
			if (w <= 0) continue;
			const blend = Math.min(p.genStrength * dt * Math.min(w, 1), 1);
			const yb = Math.min(y, surfaceY) - h;
			const ch = Math.cosh(k * yb) / sinhKd;
			const sh = Math.sinh(k * yb) / sinhKd;
			const theta = k * (x - width / 2) + Math.PI / 2;
			const uG = a * ch * omega * Math.sin(theta) - cPhase;
			const vG = -a * sh * omega * Math.cos(theta);
			pu[i] += (uG - pu[i]) * blend;
			pv[i] += (vG - pv[i]) * blend;
		}
	}

	private collide(dt = 0, bottomDrag = 0) {
		const { px, py, pu, pv, numP, width, h, radius, bedY, nx, periodic } = this;
		const dragLayer = Math.max(1.5 * h, 0.6);
		const minX = h + radius;
		const maxX = width - h - radius;
		const maxY = this.ny * h - radius;
		const invH = 1 / h;
		for (let i = 0; i < numP; i++) {
			if (!periodic) {
				if (px[i] < minX) {
					px[i] = minX;
					if (pu[i] < 0) pu[i] = 0;
				} else if (px[i] > maxX) {
					px[i] = maxX;
					if (pu[i] > 0) pu[i] = 0;
				}
			}
			// Bed: clamp to the sloped floor and remove the velocity
			// component INTO it, keeping the along-slope part (runup).
			const fx = Math.min(Math.max(px[i] * invH, 0), nx - 1.001);
			const bi = fx | 0;
			const bt = fx - bi;
			const bed = bedY[bi] * (1 - bt) + bedY[bi + 1] * bt;
			// Bed friction: a thin boundary layer above the bed bleeds
			// momentum at bottomDrag per second, fading with height. Slows
			// the surf's base, drags runup and undertow.
			if (bottomDrag > 0 && py[i] < bed + dragLayer) {
				const wD = 1 - (py[i] - bed) / dragLayer;
				const f = 1 - Math.min(bottomDrag * dt * wD, 1);
				pu[i] *= f;
				pv[i] *= f;
			}
			if (py[i] < bed + radius) {
				py[i] = bed + radius;
				const gb = (bedY[bi + 1] - bedY[bi]) * invH;
				const nl = 1 / Math.sqrt(1 + gb * gb);
				const nxn = -gb * nl;
				const nyn = nl;
				const vn = pu[i] * nxn + pv[i] * nyn;
				if (vn < 0) {
					pu[i] -= vn * nxn;
					pv[i] -= vn * nyn;
				}
			} else if (py[i] > maxY) {
				py[i] = maxY;
				if (pv[i] > 0) pv[i] = 0;
			}
		}
	}

	private pushApart() {
		const { hashNx, hashNy, hashSpacing, numP } = this;
		const px = this.px;
		const py = this.py;
		const hashCount = this.hashCount;
		const hashFirst = this.hashFirst;
		const hashIds = this.hashIds;
		const total = hashNx * hashNy;
		const inv = 1 / hashSpacing;
		hashCount.fill(0);
		for (let i = 0; i < numP; i++) {
			const cx = Math.min(Math.max((px[i] * inv) | 0, 0), hashNx - 1);
			const cy = Math.min(Math.max((py[i] * inv) | 0, 0), hashNy - 1);
			hashCount[cx * hashNy + cy]++;
		}
		let first = 0;
		for (let c = 0; c < total; c++) {
			first += hashCount[c];
			hashFirst[c] = first;
		}
		hashFirst[total] = first;
		for (let i = 0; i < numP; i++) {
			const cx = Math.min(Math.max((px[i] * inv) | 0, 0), hashNx - 1);
			const cy = Math.min(Math.max((py[i] * inv) | 0, 0), hashNy - 1);
			const c = cx * hashNy + cy;
			hashFirst[c]--;
			hashIds[hashFirst[c]] = i;
		}
		const minDist = 2 * this.radius;
		const minDist2 = minDist * minDist;
		const { periodic, width } = this;
		const halfW = width / 2;
		for (let i = 0; i < numP; i++) {
			const x = px[i];
			const y = py[i];
			const cx = Math.min(Math.max((x * inv) | 0, 0), hashNx - 1);
			const cy = Math.min(Math.max((y * inv) | 0, 0), hashNy - 1);
			for (let ox = -1; ox <= 1; ox++) {
				let gx = cx + ox;
				if (periodic) gx = (gx + hashNx) % hashNx;
				else if (gx < 0 || gx >= hashNx) continue;
				for (let oy = -1; oy <= 1; oy++) {
					const gy = cy + oy;
					if (gy < 0 || gy >= hashNy) continue;
					const c = gx * hashNy + gy;
					const end = hashFirst[c + 1];
					for (let sIdx = hashFirst[c]; sIdx < end; sIdx++) {
						const j = hashIds[sIdx];
						if (j <= i) continue;
						let dx = px[j] - x;
						if (periodic) {
							if (dx > halfW) dx -= width;
							else if (dx < -halfW) dx += width;
						}
						const dy = py[j] - y;
						const d2 = dx * dx + dy * dy;
						if (d2 >= minDist2 || d2 === 0) continue;
						const d = Math.sqrt(d2);
						const push = (0.5 * (minDist - d)) / d;
						const mx = dx * push;
						const my = dy * push;
						let xi = px[i] - mx;
						let xj = px[j] + mx;
						if (periodic) {
							if (xi < 0) xi += width;
							else if (xi >= width) xi -= width;
							if (xj < 0) xj += width;
							else if (xj >= width) xj -= width;
						}
						px[i] = xi;
						py[i] -= my;
						px[j] = xj;
						py[j] += my;
					}
				}
			}
		}
	}

	private markCells() {
		const { nx, ny, h, numP } = this;
		const ct = this.cellType;
		const solid = this.solidMask;
		const px = this.px;
		const py = this.py;
		for (let i = 0; i < ct.length; i++) ct[i] = solid[i] === 1 ? SOLID : AIR;
		const invH = 1 / h;
		const surf = this.surfCol;
		surf.fill(-1e9);
		for (let pI = 0; pI < numP; pI++) {
			const ci = Math.min(Math.max((px[pI] * invH) | 0, 0), nx - 1);
			const cj = Math.min(Math.max((py[pI] * invH) | 0, 0), ny - 1);
			const idx = ci * ny + cj;
			if (ct[idx] === AIR) ct[idx] = FLUID;
			if (py[pI] > surf[ci]) surf[ci] = py[pI];
		}
	}

	private particleDensity() {
		const { nx, ny, h, numP } = this;
		const density = this.density;
		const px = this.px;
		const py = this.py;
		density.fill(0);
		const h1 = 1 / h;
		for (let pI = 0; pI < numP; pI++) {
			const x = px[pI] * h1 - 0.5;
			const y = py[pI] * h1 - 0.5;
			const x0 = Math.floor(x);
			const y0 = Math.floor(y);
			const tx = x - x0;
			const ty = y - y0;
			for (let ox = 0; ox <= 1; ox++) {
				let gi = x0 + ox;
				if (this.periodic) gi = ((gi % nx) + nx) % nx;
				else if (gi < 0 || gi >= nx) continue;
				for (let oy = 0; oy <= 1; oy++) {
					const gj = y0 + oy;
					if (gj < 0 || gj >= ny) continue;
					const w = (ox === 0 ? 1 - tx : tx) * (oy === 0 ? 1 - ty : ty);
					density[gi * ny + gj] += w;
				}
			}
		}
	}

	private scatter(
		grid: Float32Array,
		weights: Float32Array,
		rows: number,
		offX: number,
		offY: number,
		value: Float32Array
	) {
		const h1 = 1 / this.h;
		const nx = this.nx;
		const px = this.px;
		const py = this.py;
		const numP = this.numP;
		for (let pI = 0; pI < numP; pI++) {
			const x = (px[pI] - offX) * h1;
			const y = (py[pI] - offY) * h1;
			const x0 = Math.floor(x);
			const y0 = Math.floor(y);
			const tx = x - x0;
			const ty = y - y0;
			const val = value[pI];
			for (let ox = 0; ox <= 1; ox++) {
				let gi = x0 + ox;
				if (this.periodic) gi = ((gi % nx) + nx) % nx;
				else if (gi < 0 || gi >= nx) continue;
				for (let oy = 0; oy <= 1; oy++) {
					const gj = y0 + oy;
					if (gj < 0 || gj >= rows) continue;
					const w = (ox === 0 ? 1 - tx : tx) * (oy === 0 ? 1 - ty : ty);
					const idx = gi * rows + gj;
					grid[idx] += w * val;
					weights[idx] += w;
				}
			}
		}
	}

	private toGrid() {
		const { nx, ny } = this;
		this.u.fill(0);
		this.v.fill(0);
		this.uW.fill(0);
		this.vW.fill(0);
		// u faces at (i*h, (j+0.5)*h); v faces at ((i+0.5)*h, j*h).
		this.scatter(this.u, this.uW, ny, 0, this.h / 2, this.pu);
		this.scatter(this.v, this.vW, ny + 1, this.h / 2, 0, this.pv);
		const u = this.u;
		const v = this.v;
		for (let i = 0; i < u.length; i++) if (this.uW[i] > 0) u[i] /= this.uW[i];
		for (let i = 0; i < v.length; i++) if (this.vW[i] > 0) v[i] /= this.vW[i];
		// Faces touching solid cells are the bed/walls: static.
		const solid = this.solidMask;
		const nv = ny + 1;
		for (let i = 0; i < nx; i++) {
			for (let j = 0; j < ny; j++) {
				if (solid[i * ny + j] !== 1) continue;
				u[i * ny + j] = 0;
				if (i + 1 < nx) u[(i + 1) * ny + j] = 0;
				v[i * nv + j] = 0;
				v[i * nv + j + 1] = 0;
			}
		}
	}

	private project(iters: number, stiffness: number) {
		const { nx, ny, restDensity } = this;
		const u = this.u;
		const v = this.v;
		const cellType = this.cellType;
		const density = this.density;
		const nv = ny + 1;
		const over = 1.9;
		const comp = restDensity > 0 && stiffness > 0;
		const periodic = this.periodic;
		const i0 = periodic ? 0 : 1;
		const i1 = periodic ? nx : nx - 1;
		for (let iter = 0; iter < iters; iter++) {
			for (let i = i0; i < i1; i++) {
				const col = i * ny;
				const colV = i * nv;
				const colL = (periodic ? (i - 1 + nx) % nx : i - 1) * ny;
				const colR = (periodic ? (i + 1) % nx : i + 1) * ny;
				for (let j = 1; j < ny; j++) {
					const idx = col + j;
					if (cellType[idx] !== FLUID) continue;
					const sL = cellType[colL + j] === SOLID ? 0 : 1;
					const sR = cellType[colR + j] === SOLID ? 0 : 1;
					const sB = cellType[idx - 1] === SOLID ? 0 : 1;
					const sT = j + 1 < ny ? (cellType[idx + 1] === SOLID ? 0 : 1) : 1;
					const s = sL + sR + sB + sT;
					if (s === 0) continue;
					let div = u[colR + j] - u[idx] + v[colV + j + 1] - v[colV + j];
					if (comp) {
						const compression = density[idx] - restDensity;
						if (compression > 0) div -= stiffness * compression;
					}
					const pcorr = (-div / s) * over;
					u[idx] -= sL * pcorr;
					u[colR + j] += sR * pcorr;
					v[colV + j] -= sB * pcorr;
					v[colV + j + 1] += sT * pcorr;
				}
			}
		}
	}

	private gather(
		grid: Float32Array,
		prev: Float32Array,
		weights: Float32Array,
		rows: number,
		offX: number,
		offY: number,
		pI: number,
		out2: number[]
	) {
		const h1 = 1 / this.h;
		const nx = this.nx;
		const x = (this.px[pI] - offX) * h1;
		const y = (this.py[pI] - offY) * h1;
		const x0 = Math.floor(x);
		const y0 = Math.floor(y);
		const tx = x - x0;
		const ty = y - y0;
		let val = 0;
		let dval = 0;
		let wsum = 0;
		for (let ox = 0; ox <= 1; ox++) {
			let gi = x0 + ox;
			if (this.periodic) gi = ((gi % nx) + nx) % nx;
			else if (gi < 0 || gi >= nx) continue;
			for (let oy = 0; oy <= 1; oy++) {
				const gj = y0 + oy;
				if (gj < 0 || gj >= rows) continue;
				const idx = gi * rows + gj;
				if (weights[idx] <= 0) continue;
				const w = (ox === 0 ? 1 - tx : tx) * (oy === 0 ? 1 - ty : ty);
				val += w * grid[idx];
				dval += w * (grid[idx] - prev[idx]);
				wsum += w;
			}
		}
		if (wsum > 0) {
			out2[0] = val / wsum;
			out2[1] = dval / wsum;
		} else {
			out2[0] = 0;
			out2[1] = 0;
		}
	}

	private fromGrid(flipRatio: number) {
		const out2 = [0, 0];
		const { numP } = this;
		for (let pI = 0; pI < numP; pI++) {
			this.gather(this.u, this.prevU, this.uW, this.ny, 0, this.h / 2, pI, out2);
			this.pu[pI] = flipRatio * (this.pu[pI] + out2[1]) + (1 - flipRatio) * out2[0];
			this.gather(this.v, this.prevV, this.vW, this.ny + 1, this.h / 2, 0, pI, out2);
			this.pv[pI] = flipRatio * (this.pv[pI] + out2[1]) + (1 - flipRatio) * out2[0];
		}
	}
}
