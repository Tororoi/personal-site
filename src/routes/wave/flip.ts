/**
 * 2D PIC/FLIP solver for the /wave lab — the first rung of the hybrid
 * plan: can a particle fluid, SEEDED from a Gerstner wave, carry it
 * forward and break it?
 *
 * A vertical slice along the wave's travel direction: x periodic over
 * one wavelength (the wave wraps), a solid floor at the bottom, open air
 * above. Classic staggered-MAC FLIP in the Ten Minute Physics /
 * jeantimex style: integrate particles, push apart, transfer to the
 * grid, project out divergence (Gauss-Seidel with overrelaxation and
 * particle-density drift compensation), transfer back with a PIC/FLIP
 * blend.
 *
 * Coupling IN is the seeding: particles start on Gerstner orbits —
 * position displaced circularly from a rest lattice with e^{ky} decay,
 * velocity the exact time derivative — so at t0 the sim IS the wave.
 * From there gravity and pressure own it: a moderate wave should simply
 * propagate (the solver agreeing with linear theory), a steep one should
 * sharpen and overturn. No forcing, no relaxation — an initial-value
 * experiment, which is exactly what the lab is for.
 */

export interface FlipParams {
	lambda: number;
	/** Orbit radius = elevation amplitude; steepness is k * amp, derived. */
	amp: number;
	depth: number;
	gridNx: number;
	flipRatio: number;
	pressureIters: number;
	stiffness: number;
	separateIters: number;
}

const G = 9.81;
const SOLID = 0;
const FLUID = 1;
const AIR = 2;

export class FlipSlice {
	// Grid: cell (i, j) at idx i * ny + j; j = 0 is the solid floor row.
	nx = 0;
	ny = 0;
	h = 1;
	width = 0;
	/** u[i * ny + j] = LEFT face of cell column i (x periodic). */
	private u = new Float32Array(0);
	/** v[i * (ny + 1) + j] = BOTTOM face of cell (i, j). */
	private v = new Float32Array(0);
	private uW = new Float32Array(0);
	private vW = new Float32Array(0);
	private prevU = new Float32Array(0);
	private prevV = new Float32Array(0);
	private cellType = new Int8Array(0);
	private density = new Float32Array(0);
	private restDensity = 0;

	// Particles.
	numP = 0;
	px = new Float32Array(0);
	py = new Float32Array(0);
	pu = new Float32Array(0);
	pv = new Float32Array(0);
	radius = 0.1;
	/** Mean-surface height above the floor (y of the waterline). */
	surfaceY = 0;

	// Push-apart spatial hash.
	private hashSpacing = 1;
	private hashNx = 0;
	private hashNy = 0;
	private hashCount = new Int32Array(0);
	private hashFirst = new Int32Array(0);
	private hashIds = new Int32Array(0);

	/** Wall-clock cost of the last step, ms. */
	lastStepMs = 0;

	/**
	 * (Re)build the grid and seed particles from the Gerstner wave at
	 * time t0. Steepness above 1 seeds an already-folded configuration —
	 * the push-apart resolves the overlap and the plunge starts at once.
	 */
	seed(p: FlipParams, t0: number) {
		this.width = p.lambda;
		this.nx = Math.max(32, Math.round(p.gridNx));
		this.h = this.width / this.nx;
		const headroom = Math.max(2 * p.amp + 2, 4);
		this.ny = Math.max(8, Math.ceil((p.depth + headroom) / this.h) + 1);
		this.surfaceY = this.h + p.depth; // one solid row below the column

		const cells = this.nx * this.ny;
		this.u = new Float32Array(this.nx * this.ny);
		this.v = new Float32Array(this.nx * (this.ny + 1));
		this.uW = new Float32Array(this.u.length);
		this.vW = new Float32Array(this.v.length);
		this.prevU = new Float32Array(this.u.length);
		this.prevV = new Float32Array(this.v.length);
		this.cellType = new Int8Array(cells);
		this.density = new Float32Array(cells);

		// Particles on a jittered 2x2-per-cell REST lattice below the
		// surface, displaced onto their Gerstner orbits.
		// CIRCULAR orbits — the true trochoid. The game's waves scale the
		// horizontal sway by q (elliptic), which is fine as graphics but is
		// NOT volume-preserving: seeding it hands the solver a fluid with
		// baked-in density errors, and the pressure solve detonates the
		// crests undoing them (measured: 3x crest spike in the first
		// second). The exact incompressible Gerstner has horizontal radius
		// EQUAL to the elevation amplitude; steepness is k * amp.
		const k = (2 * Math.PI) / p.lambda;
		const omega = Math.sqrt(G * k);
		const a = p.amp;
		const spacing = this.h / 2;
		// Radius must leave slack against the seeding lattice: 2r above the
		// spacing seeds the whole fluid OVERLAPPED, and the push-apart then
		// inflates the column (measured +6% volume and a 3x crest spike in
		// the first second).
		this.radius = 0.22 * this.h;
		const cols = Math.round(this.width / spacing);
		const rows = Math.ceil((p.depth + a) / spacing);
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
				// Orbit radius decays with rest depth below the waterline.
				const decay = Math.exp(k * Math.min(y0 - this.surfaceY, 0));
				const theta = k * x0 - omega * t0;
				const cx = x0 + a * decay * Math.cos(theta);
				const cy = y0 + a * decay * Math.sin(theta);
				if (cy < this.h + this.radius) continue;
				this.px[n] = ((cx % this.width) + this.width) % this.width;
				this.py[n] = cy;
				this.pu[n] = a * decay * omega * Math.sin(theta);
				this.pv[n] = -a * decay * omega * Math.cos(theta);
				n++;
			}
		}
		this.numP = n;

		// Push-apart hash sized to the particle diameter.
		this.hashSpacing = 2.2 * this.radius;
		this.hashNx = Math.ceil(this.width / this.hashSpacing);
		this.hashNy = Math.ceil((this.ny * this.h) / this.hashSpacing) + 1;
		this.hashCount = new Int32Array(this.hashNx * this.hashNy + 1);
		this.hashFirst = new Int32Array(this.hashNx * this.hashNy + 1);
		this.hashIds = new Int32Array(cap);

		// Rest density from the seeded state (drift compensation target).
		// INTERIOR cells only: surface cells are half-empty and drag the
		// average low, which turns the compensation into a steady outward
		// push.
		this.markCells();
		this.particleDensity();
		let sum = 0;
		let count = 0;
		const ny = this.ny;
		for (let i = 0; i < this.nx; i++) {
			for (let j = 1; j < ny - 1; j++) {
				if (this.cellType[i * ny + j] !== FLUID) continue;
				const iL = ((i - 1 + this.nx) % this.nx) * ny + j;
				const iR = ((i + 1) % this.nx) * ny + j;
				if (
					this.cellType[iL] === FLUID &&
					this.cellType[iR] === FLUID &&
					this.cellType[i * ny + j + 1] === FLUID &&
					this.cellType[i * ny + j - 1] !== AIR
				) {
					sum += this.density[i * ny + j];
					count++;
				}
			}
		}
		this.restDensity = count > 0 ? sum / count : 0;
	}

	step(dt: number, p: FlipParams) {
		if (this.numP === 0) return;
		const start = performance.now();
		this.integrate(dt);
		for (let it = 0; it < p.separateIters; it++) this.pushApart();
		this.collide();
		this.toGrid();
		this.markCells();
		this.particleDensity();
		this.prevU.set(this.u);
		this.prevV.set(this.v);
		this.project(dt, p.pressureIters, p.stiffness);
		this.fromGrid(p.flipRatio);
		this.lastStepMs = performance.now() - start;
	}

	private wrapX(x: number): number {
		return ((x % this.width) + this.width) % this.width;
	}

	private integrate(dt: number) {
		// Hot loops hoist every array to a local: `this.` lookups at
		// millions per step were most of the profile.
		const { px, py, pu, pv, numP, width } = this;
		const g = G * dt;
		for (let i = 0; i < numP; i++) {
			pv[i] -= g;
			let x = px[i] + pu[i] * dt;
			if (x < 0) x += width;
			else if (x >= width) x -= width;
			px[i] = x;
			py[i] += pv[i] * dt;
		}
	}

	private collide() {
		const minY = this.h + this.radius;
		const maxY = this.ny * this.h - this.radius;
		for (let i = 0; i < this.numP; i++) {
			if (this.py[i] < minY) {
				this.py[i] = minY;
				if (this.pv[i] < 0) this.pv[i] = 0;
			} else if (this.py[i] > maxY) {
				this.py[i] = maxY;
				if (this.pv[i] > 0) this.pv[i] = 0;
			}
		}
	}

	private pushApart() {
		const { hashNx, hashNy, hashSpacing, numP, width } = this;
		const px = this.px;
		const py = this.py;
		const hashCount = this.hashCount;
		const hashFirst = this.hashFirst;
		const hashIds = this.hashIds;
		const total = hashNx * hashNy;
		const inv = 1 / hashSpacing;
		hashCount.fill(0);
		for (let i = 0; i < numP; i++) {
			const cx = Math.min((px[i] * inv) | 0, hashNx - 1);
			const cy = Math.min((py[i] * inv) | 0, hashNy - 1);
			hashCount[cx * hashNy + cy]++;
		}
		let first = 0;
		for (let c = 0; c < total; c++) {
			first += hashCount[c];
			hashFirst[c] = first;
		}
		hashFirst[total] = first;
		for (let i = 0; i < numP; i++) {
			const cx = Math.min((px[i] * inv) | 0, hashNx - 1);
			const cy = Math.min((py[i] * inv) | 0, hashNy - 1);
			const c = cx * hashNy + cy;
			hashFirst[c]--;
			hashIds[hashFirst[c]] = i;
		}
		const minDist = 2 * this.radius;
		const minDist2 = minDist * minDist;
		const halfW = width / 2;
		for (let i = 0; i < numP; i++) {
			const x = px[i];
			const y = py[i];
			const cx = Math.min((x * inv) | 0, hashNx - 1);
			const cy = Math.min((y * inv) | 0, hashNy - 1);
			for (let ox = -1; ox <= 1; ox++) {
				const gx = (cx + ox + hashNx) % hashNx; // periodic x
				for (let oy = -1; oy <= 1; oy++) {
					const gy = cy + oy;
					if (gy < 0 || gy >= hashNy) continue;
					const c = gx * hashNy + gy;
					const end = hashFirst[c + 1];
					for (let sIdx = hashFirst[c]; sIdx < end; sIdx++) {
						const j = hashIds[sIdx];
						if (j <= i) continue;
						// Nearest periodic image in x.
						let dx = px[j] - x;
						if (dx > halfW) dx -= width;
						else if (dx < -halfW) dx += width;
						const dy = py[j] - y;
						const d2 = dx * dx + dy * dy;
						if (d2 >= minDist2 || d2 === 0) continue;
						const d = Math.sqrt(d2);
						const push = (0.5 * (minDist - d)) / d;
						const mx = dx * push;
						const my = dy * push;
						let xi = px[i] - mx;
						if (xi < 0) xi += width;
						else if (xi >= width) xi -= width;
						px[i] = xi;
						py[i] -= my;
						let xj = px[j] + mx;
						if (xj < 0) xj += width;
						else if (xj >= width) xj -= width;
						px[j] = xj;
						py[j] += my;
					}
				}
			}
		}
	}

	private markCells() {
		const { nx, ny, h } = this;
		this.cellType.fill(AIR);
		for (let i = 0; i < nx; i++) this.cellType[i * ny] = SOLID; // floor
		for (let pI = 0; pI < this.numP; pI++) {
			const ci = Math.min(Math.floor(this.px[pI] / h), nx - 1);
			const cj = Math.min(Math.max(Math.floor(this.py[pI] / h), 0), ny - 1);
			const idx = ci * ny + cj;
			if (this.cellType[idx] === AIR) this.cellType[idx] = FLUID;
		}
	}

	private particleDensity() {
		const { nx, ny, h } = this;
		this.density.fill(0);
		const h1 = 1 / h;
		for (let pI = 0; pI < this.numP; pI++) {
			const x = this.px[pI] * h1 - 0.5;
			const y = this.py[pI] * h1 - 0.5;
			const x0 = Math.floor(x);
			const y0 = Math.floor(y);
			const tx = x - x0;
			const ty = y - y0;
			for (let ox = 0; ox <= 1; ox++) {
				for (let oy = 0; oy <= 1; oy++) {
					const gi = (((x0 + ox) % nx) + nx) % nx;
					const gj = y0 + oy;
					if (gj < 0 || gj >= ny) continue;
					const w = (ox === 0 ? 1 - tx : tx) * (oy === 0 ? 1 - ty : ty);
					this.density[gi * ny + gj] += w;
				}
			}
		}
	}

	/**
	 * Bilinear scatter of one velocity component onto its staggered grid.
	 * offX/offY place the component's sample points; x wraps, y clamps.
	 */
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
			for (let ox = 0; ox <= 1; ox++) {
				for (let oy = 0; oy <= 1; oy++) {
					const gi = (((x0 + ox) % nx) + nx) % nx;
					const gj = y0 + oy;
					if (gj < 0 || gj >= rows) continue;
					const w = (ox === 0 ? 1 - tx : tx) * (oy === 0 ? 1 - ty : ty);
					const idx = gi * rows + gj;
					grid[idx] += w * value[pI];
					weights[idx] += w;
				}
			}
		}
	}

	private toGrid() {
		this.u.fill(0);
		this.v.fill(0);
		this.uW.fill(0);
		this.vW.fill(0);
		// u faces sit at (i*h, (j+0.5)*h); v faces at ((i+0.5)*h, j*h).
		this.scatter(this.u, this.uW, this.ny, 0, this.h / 2, this.pu);
		this.scatter(this.v, this.vW, this.ny + 1, this.h / 2, 0, this.pv);
		for (let i = 0; i < this.u.length; i++) if (this.uW[i] > 0) this.u[i] /= this.uW[i];
		for (let i = 0; i < this.v.length; i++) if (this.vW[i] > 0) this.v[i] /= this.vW[i];
		// Solid faces: floor and the row of v just above it stay zero.
		for (let i = 0; i < this.nx; i++) {
			this.v[i * (this.ny + 1) + 0] = 0;
			this.v[i * (this.ny + 1) + 1] = 0;
		}
	}

	private project(dt: number, iters: number, stiffness: number) {
		const { nx, ny, restDensity } = this;
		const u = this.u;
		const v = this.v;
		const cellType = this.cellType;
		const density = this.density;
		const nv = ny + 1;
		const over = 1.9;
		const comp = restDensity > 0 && stiffness > 0;
		for (let iter = 0; iter < iters; iter++) {
			for (let i = 0; i < nx; i++) {
				const col = i * ny;
				const colV = i * nv;
				const colR = ((i + 1) % nx) * ny;
				for (let j = 1; j < ny; j++) {
					const idx = col + j;
					if (cellType[idx] !== FLUID) continue;
					// Neighbour solidity: x-neighbours always exist (periodic);
					// below can be the floor; the top of the domain is open air.
					const sB = cellType[idx - 1] === SOLID ? 0 : 1;
					const s = 3 + sB;
					let div = u[colR + j] - u[idx] + v[colV + j + 1] - v[colV + j];
					if (comp) {
						const compression = density[idx] - restDensity;
						if (compression > 0) div -= stiffness * compression;
					}
					const pcorr = (-div / s) * over;
					u[idx] -= pcorr;
					u[colR + j] += pcorr;
					v[colV + j] -= sB * pcorr;
					v[colV + j + 1] += pcorr;
				}
			}
		}
		void dt;
	}

	/**
	 * Bilinear gather of one component, weighting only faces that carried
	 * particle weight this frame (an empty face has no meaningful value).
	 * Returns [pic, delta] into out2.
	 */
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
			for (let oy = 0; oy <= 1; oy++) {
				const gi = (((x0 + ox) % nx) + nx) % nx;
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
		for (let pI = 0; pI < this.numP; pI++) {
			this.gather(this.u, this.prevU, this.uW, this.ny, 0, this.h / 2, pI, out2);
			this.pu[pI] = flipRatio * (this.pu[pI] + out2[1]) + (1 - flipRatio) * out2[0];
			this.gather(this.v, this.prevV, this.vW, this.ny + 1, this.h / 2, 0, pI, out2);
			this.pv[pI] = flipRatio * (this.pv[pI] + out2[1]) + (1 - flipRatio) * out2[0];
		}
	}
}
