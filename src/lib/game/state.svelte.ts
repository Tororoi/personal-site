import { ENV } from './env';

/**
 * Module-level game state: survives navigation because the module stays
 * loaded for the life of the page. Only game modules import this; nothing
 * on the content routes touches it, so three.js and friends never leak
 * into their bundles.
 */
export const game = $state({
	/**
	 * Seconds into the 24-minute day. Starts mid-afternoon with the sun 45
	 * degrees above the horizon in the south-west (phase 0.604 on the env
	 * sun arc): crosswise to the isometric camera's view axis, so
	 * receivers show classic lit/shadow modeling. Phase 0.396 is the
	 * mirrored morning pose.
	 */
	time: ENV.daySeconds * 0.604,
	running: true
});

/**
 * Renderer counters for the perf readout, written once a frame by Scene.
 *
 * These separate the two ways a frame gets slow, which look identical
 * from the fps number alone: too much geometry submitted (calls and
 * triangles climb) versus too much work per pixel (both stay flat while
 * the frame time rises anyway). Guessing between those two has cost real
 * time on this project before.
 */
export const perf = $state({
	/** Draw calls in the last main-scene render. */
	calls: 0,
	/** Triangles in the last main-scene render. */
	tris: 0,
	/** CPU milliseconds spent in the simulation task last frame. */
	taskMs: 0,
	/** Fixed simulation steps run last frame (catch-up multiplier). */
	steps: 0,
	/** Drawing-buffer size in device pixels — the fill-rate denominator. */
	w: 0,
	h: 0,
	/**
	 * Per-pass GPU milliseconds, populated only when ENABLE.gpuProfile is
	 * on. Measured by serialising with gl.finish(), so the totals are
	 * inflated; the split between them is the useful part.
	 */
	gpuRipple: 0,
	gpuFft: 0,
	gpuCaustic: 0,
	gpuFoam: 0,
	/** Foam field capacity estimate — foam's cost tracks its coverage. */
	foam: 0,
	/** Live spray droplets this frame (alpha-blended, so overdraw). */
	spray: 0,
	/**
	 * CPU milliseconds inside the fixed step, split by system and summed
	 * over every step the frame ran. Plain performance.now() timers, which
	 * — unlike the GPU's gl.finish() — measure exactly what they claim.
	 */
	cpuWhitecaps: 0,
	cpuSpray: 0,
	cpuCurrent: 0,
	/** CPU outside the fixed step: buoys, uniform mirroring, spray upload. */
	cpuRest: 0,
	/** Landing checks actually sampled, and skipped by the height bound. */
	checkRun: 0,
	checkSkip: 0
});
