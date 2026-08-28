/**
 * Persistent surface foam: the RESIDUE class of white water, distinct
 * from froth (the seconds-long boil of an impact) and spray (airborne).
 *
 * STORAGE IS A FIELD, not a list. A 1024^2 single-channel THICKNESS
 * texture covers the scene in REST (material) coordinates. Every spray
 * landing splats a gaussian bump of thickness (accumulating toward
 * solid), and each frame the field:
 *   - DECAYS exponentially (a time constant of tens of seconds),
 *   - DIFFUSES (dying foam physically spreads thin — the spreading is
 *     real mass redistribution, peaks sink as footprints widen),
 *   - ADVECTS downwind (residue rides the surface).
 *
 * Why a field: capacity. The previous analytic slot pool could not
 * represent an unbounded stream of landings — every eviction policy
 * (steal-oldest, never-evict, evict-weakest) either killed young foam
 * or starved new foam, and both were user-visible. A texture never
 * drops a deposit: banks emerge from accumulation, fresh landings in
 * old banks read at full density, and new sites always foam.
 *
 * The LOOK is unchanged from the decal version: the water fragment
 * renders the field as a fat white WIREFRAME (see foamGlsl) — every
 * point within a strand half-width of a world-anchored Voronoi edge
 * skeleton, fat enough to fuse solid where the field is thick, tearing
 * into rounded lace and ever-larger cells as it thins.
 */

import * as THREE from 'three'
import { ENABLE, FOAM, FROTH } from './tuning'
import { currentVector } from './current'
import { activeField, waves, wavesGlsl, onFieldChange, waveUniformA, waveUniformB } from './waves'

export const FOAM_RESOLUTION = 512
/**
 * Meters of world covered, matching the ripple domain: the field must
 * cover the scene. 100m / 512 = ~0.2m texels — the field stores only
 * smooth THICKNESS (the web detail is generated per-pixel at render), so
 * it tolerates coarse texels. Known trade at 512: the smallest
 * spray-dot deposits (sigma ~0.08m) land sub-texel and their splat
 * amplitude varies with grid alignment; raise to 768 if landing dots
 * ever read as inconsistent.
 */
export const FOAM_EXTENT = 100

/**
 * How foamy this sea is, 0-1, from the preset's CHOP — the same measure
 * the crest foam uses. Chop is what drives crests into breaking, so it
 * separates a big smooth swell from a genuinely frothy one in a way wave
 * height cannot. A pure property of the sea — the two consumers (the
 * painted collar and the emission) apply their own ENABLE flags, so
 * neither can switch the other off. Declared up here because the shader
 * strings below
 * interpolate it at module load, and a const declared later is still in
 * its temporal dead zone at that point — it bakes in as NaN.
 */
/**
 * Recompute from the sea's chop; called on a live sea-state change.
 *
 * Deliberately chop with a THRESHOLD, not the metric drive the specular
 * uses: the dead zone below contactChopStart is a feature. A near-glassy
 * sea should grow no collar at all — a sliver-thin one reads oddly — and
 * chop-with-floor expresses exactly that.
 */
export function contactFoaminess(chop: number) {
  return Math.min(
    Math.max(
      (chop - FOAM.contactChopStart) / (FOAM.contactChopFull - FOAM.contactChopStart),
      0,
    ),
    1,
  )
}

export let CONTACT_FOAMINESS = contactFoaminess(activeField.chop)

/**
 * Decay time constants on calm water, seconds to 1/e — TWO of them,
 * blended by local thickness, and the thick one is FASTER. This is what
 * makes expansion continuous to the very end: exponential decay alone
 * preserves a gaussian's shape (so patches used to expand, stall, and
 * fade center-last), but with peaks decaying proportionally faster than
 * skirts, every mound erodes into a wide flat plateau that keeps
 * spreading — and a plateau falls through the render floor everywhere
 * AT ONCE. Biggest footprint and complete fade are the same moment.
 */
const DECAY_TAU_THIN = FOAM.decayThin
const DECAY_TAU_THICK = FOAM.decayThick
/**
 * Decay time constant where the water is actively BREAKING: churn tears
 * foam apart. The sim shader probes the local instantaneous Jacobian
 * (the same criterion that drives churn and spray) and blends between
 * the clocks per texel — dissipation is dynamic, tied to the actual
 * wave interaction underneath each patch of foam.
 */
const DECAY_TAU_TURB = 1.1
/** Jacobian ramp for the turbulence probe; matches the churn's. */
const TURB_J_START = FOAM.turbJStart
const TURB_J_FULL = FOAM.turbJFull
/**
 * Per-frame neighbor mixing, 0..1: the spread rate. Diffusion is the
 * dissipation mechanism — mass leaves the peak and widens the skirt,
 * so a dying bank grows WIDE while it thins, like cream stirred out.
 * Spread radius scales with sqrt of this: 0.88 doubles the maximum
 * expansion 0.22 gave. (Still stable: it is a positive-weight average.)
 */
const DIFFUSION = FOAM.diffusion

/**
 * Soft capacity: a CPU-side running estimate of total foam mass (unit:
 * amp x sigma^2 at deposit; decayed analytically — no GPU readback).
 * Above OVERLOAD_START, THIN foam's decay accelerates toward
 * DECAY_TAU_OLD, reaching it at OVERLOAD_FULL. Thin is the age proxy —
 * deposits are born thick and only thin out — so pressure fades the OLD
 * tails gracefully while new deposits always land at full strength.
 */
const DECAY_TAU_OLD = FOAM.decayOld
// Calibrated against measured storm steady state (window.foamMass()):
// pressure must begin ABOVE normal load, or it just cancels out any new
// foam source. See the note on FOAM.overloadStart.
const OVERLOAD_START = FOAM.overloadStart
const OVERLOAD_FULL = FOAM.overloadFull
let massEst = 0

/**
 * Current foam capacity estimate. Exposed because foam's frame cost tracks
 * how much of the screen it covers, and "seems slower when there's more
 * foam" is not something that can be acted on — pairing ms/Mpx with a
 * number makes it a measurement.
 */
export const foamMass = () => massEst
/** Accumulated wind+current carry in metres, so the web pattern can be
 *  advected to match the thickness field. Read by the water shader. */
export const foamFlow = { x: 0, z: 0 }
/** Downwind drift as a fraction of wind speed. */
const FOAM_DRIFT = FOAM.drift

/** Gaussian deposits consumed per sim step. */
const MAX_INJECT = 24

type FoamDeposit = { x: number; z: number; sigma: number; amp: number }
/**
 * TWO queues, drained in order. The field consumes MAX_INJECT deposits a
 * step — a per-fragment loop over a uniform array, so the ceiling is
 * paid by every texel in the field and cannot simply be raised.
 *
 * With one queue that ceiling starves by arrival rate rather than by
 * importance. Spray landings are an AMBIENT emitter: hundreds a step in
 * a steep sea, individually invisible. The boat's prop wash is a SIGNAL
 * emitter: a couple a frame, and the only thing drawing the wake. Sharing
 * a queue, the wake won a 24/inflow lottery and lost it outright above
 * chop ~4, where spray crosses the drain rate — the deposits were being
 * discarded inside addFoam, long before anything in the sim could act on
 * them. (That is also why foamMass READ LOW in a foamy sea: mass counts
 * deposits that land.)
 *
 * Signal deposits therefore get their own queue and the first slots.
 * Ambient deposits take what is left, and losing some of those is
 * invisible by construction.
 */
const pendingHi: FoamDeposit[] = []
const pendingLo: FoamDeposit[] = []

/**
 * Deposit foam residue at REST-space (x, z). Accumulates: landing on an
 * existing bank raises it back toward solid (density top-up); landing on
 * bare water starts a new dot. NEW deposits always win: when the queue
 * is full the OLDEST queued deposit is dropped, never the incoming one.
 *
 * priority 1 = signal (hulls, objects, the wake); 0 = ambient (spray).
 */
export function addFoam(x: number, z: number, sigma: number, amp = 0.9, priority = 0) {
  const q = priority > 0 ? pendingHi : pendingLo
  if (q.length >= (priority > 0 ? 128 : 512)) q.shift()
  q.push({ x, z, sigma, amp })
}

// Debug hook: paint foam from the console and watch it spread and die,
// e.g. addFoam(0, 0, 1.5).
if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).addFoam = addFoam
  // foamMass() reads the capacity estimate — for calibrating OVERLOAD_*.
  ;(window as unknown as Record<string, unknown>).foamMass = () => massEst
  // Deposits waiting to be injected. The field drains MAX_INJECT per
  // step, so a number that sits high means deposits are being queued
  // faster than they can land — and the queue drops its OLDEST first.
  ;(window as unknown as Record<string, unknown>).foamPending = () => ({
    hi: pendingHi.length,
    lo: pendingLo.length,
  })
}

const simVertex = `
varying vec2 vUv;
void main() {
	vUv = uv;
	gl_Position = vec4(position.xy, 0.0, 1.0);
}`

/**
 * The web skeleton is STATIC in world space, so its distance field is
 * baked ONCE into a small tiling texture (periodic hash -> seamless
 * repeat) and the water fragment pays two bilinear fetches instead of
 * two live Voronoi evaluations (~36 hashes + trig per pixel — measured
 * as the difference between 19 and ~50 fps in a foamy storm).
 */
const WEB_TILE_CELLS = 8
const WEB_TILE_RES = 512

const webBakeFragment = `
varying vec2 vUv;

vec2 webHash2(vec2 p) {
	// Periodic in the tile so the texture repeats seamlessly.
	p = mod(p, ${WEB_TILE_CELLS}.0);
	return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453);
}

/**
 * One random per CELL, periodic in the tile so it stays seamless. This
 * is what lets neighbouring cells behave differently: the sim's pocket
 * noise varies over metres, so every cell inside one pocket shares its
 * multiplier and they all open and die together — which reads as the
 * whole area holding on until the last cell has expanded.
 */
float webCellRand(vec2 p) {
	p = mod(p, ${WEB_TILE_CELLS}.0);
	return fract(sin(dot(p, vec2(45.31, 91.77))) * 24634.6345);
}

float webSmin(float a, float b, float k) {
	float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
	return mix(b, a, h) - k * h * (1.0 - h);
}

void main() {
	vec2 x = vUv * ${WEB_TILE_CELLS}.0;
	vec2 n = floor(x);
	vec2 f = fract(x);
	vec2 mg = vec2(0.0);
	vec2 mr = vec2(0.0);
	float md = 8.0;
	for (int j = -1; j <= 1; j++) {
		for (int i = -1; i <= 1; i++) {
			vec2 g = vec2(float(i), float(j));
			vec2 o = webHash2(n + g);
			vec2 r = g + o - f;
			float d = dot(r, r);
			if (d < md) {
				md = d;
				mr = r;
				mg = g;
			}
		}
	}
	md = 8.0;
	// Edge distances combine through a SMOOTH min: filleted junctions.
	for (int j = -1; j <= 1; j++) {
		for (int i = -1; i <= 1; i++) {
			vec2 g = mg + vec2(float(i), float(j));
			vec2 o = webHash2(n + g);
			vec2 r = g + o - f;
			if (dot(mr - r, mr - r) > 0.00001) {
				md = webSmin(md, dot(0.5 * (mr + r), normalize(r - mr)), 0.25);
			}
		}
	}
	gl_FragColor = vec4(md, webCellRand(n + mg), 0.0, 1.0);
}`

/**
 * Smooth value noise, 0-1. Shared by the sim (patchiness) and the water
 * fragment (the contact collar's edge), because both had reached for a
 * product of two sines first and both looked wrong the same way: sines
 * are strictly periodic, so they read as a uniform repeating ripple
 * rather than as irregularity.
 */
export const foamNoiseGlsl = `
float foamHash(vec2 p) {
	return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float foamNoise(vec2 p) {
	vec2 i = floor(p);
	vec2 f = p - i;
	f = f * f * (3.0 - 2.0 * f);
	float a = foamHash(i);
	float b = foamHash(i + vec2(1.0, 0.0));
	float c = foamHash(i + vec2(0.0, 1.0));
	float d = foamHash(i + vec2(1.0, 1.0));
	return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}`

const simFragment = `
uniform sampler2D uPrev;
uniform float uTexel;
uniform float uDecay;     // per-frame retention: calm + thin foam
uniform float uDecayThick; // per-frame retention: calm + thick foam (faster)
uniform float uDecayTurb; // per-frame retention on breaking water
uniform float uDecayOld;  // per-frame retention for thin foam at FULL overload
uniform float uOverload;  // 0-1 capacity pressure (see massEst)
uniform float uDiffusion; // per-step neighbor mixing (dt-scaled)
uniform float uDiffTexel; // diffusion tap distance in uv (see step())
uniform float uDtScale;   // frame dt / (1/60): wall-clock rate correction
uniform float uFoaminess; // sea chop -> collar/emission strength, live
uniform vec2 uShift;      // uv advection this frame (downwind drift)
uniform vec2 uCenter;
uniform float uExtent;
uniform float uTime;
uniform float uAmp;
uniform vec4 uInject[${MAX_INJECT}]; // x, z, sigma, amp
uniform float uDomAmp;
uniform sampler2D uWebTex;
uniform mat4 uBuoyInv[3];
/** Surface current, m/s. Added to the per-texel orbital velocity to get
 *  the water's true motion past a moored object. */
uniform vec2 uCurrent;
// Must match Scene.svelte's water shader and caustics.ts.
uniform vec3 SPHERE_C;
const float SPHERE_R = 5.0;
const vec3 BUOY_HALF = vec3(0.25, 0.45, 0.25);
/** Same accumulated carry the water fragment uses, so the cell a parcel
 *  of foam is standing in travels WITH it. Without this the stubborn
 *  cells are fixed places in the sea and the foam drifts through them. */
uniform vec2 uFlow;
varying vec2 vUv;

${wavesGlsl()}
${foamNoiseGlsl}

/**
 * The Jacobian AND the froth factor from ONE wave sum.
 *
 * The froth criterion is the same one the froth masses and the droplet
 * scan use, so foam laid from it appears exactly where froth appears.
 * It rides the Jacobian probe the sim already pays for — the pinch
 * weights reuse the sine that J needs — so the whole froth field costs a
 * handful of extra accumulators rather than a second wave pass.
 */
void frothProbe(
	vec2 p, float t, float ampScale,
	out float J, out float sk, out float pinch, out vec3 disp, out vec2 vel
) {
	float jxx = 1.0;
	float jzz = 1.0;
	float jxz = 0.0;
	float wAmp = 0.0;
	float wsum = 0.0;
	disp = vec3(0.0);
	vel = vec2(0.0);
	for (int i = 0; i < WAVE_COUNT; i++) {
		vec4 a = uWaveA[i];
		vec3 b = uWaveB[i];
		float theta = (p.x * a.x + p.y * a.y) * a.z - a.w * t + b.z;
		float s = sin(theta);
		float qak = b.y * b.x * ampScale * a.z;
		jxx -= qak * a.x * a.x * s;
		jzz -= qak * a.y * a.y * s;
		jxz -= qak * a.x * a.y * s;
		float pw = max(qak * s, 0.0);
		pw *= pw;
		wAmp += b.x * pw;
		wsum += pw;
		// The Gerstner displacement rides along: the field is indexed by
		// REST position, but objects sit in WORLD space, so the object
		// test needs to know where this material point actually is. One
		// extra cosine per wave, against a whole second wave pass if
		// waveDisplacement were called separately.
		float amp = b.x * ampScale;
		float c = cos(theta);
		disp.x += b.y * amp * a.x * c;
		disp.z += b.y * amp * a.y * c;
		disp.y += amp * s;
		// Horizontal ORBITAL velocity: the time derivative of the sway
		// above. Since theta carries -omega*t, d/dt of the cosine term is
		// +q*A*omega*dir*sin(theta) — and the sine is already in hand, so
		// this is two multiply-adds per wave, not another pass.
		float qao = b.y * amp * a.w * s;
		vel.x += qao * a.x;
		vel.y += qao * a.y;
	}
	J = jxx * jzz - jxz * jxz;
	float ampK = clamp(
		pow(max((wsum > 0.0001 ? wAmp / wsum : 0.0) / uDomAmp, 0.0001), ${FROTH.ampCurve.toFixed(3)}),
		${FROTH.ampRatioFloor.toFixed(3)},
		1.0
	);
	// The RAW pinch: how far the surface has folded, 0 on water that is
	// not folding at all. Reported separately from intK because intK
	// floors at intFloor — that floor exists to keep froth masses above a
	// minimum SIZE, and it is exactly wrong as a test of whether the
	// water is breaking.
	pinch = clamp((${FROTH.intJStart.toFixed(3)} - J) / ${FROTH.intJSpan.toFixed(3)}, 0.0, 1.0);
	float intK = mix(${FROTH.intFloor.toFixed(3)}, 1.0, pinch);
	sk = ampK * intK;
	sk *= 1.0 + ${FROTH.curveBoost.toFixed(3)} * smoothstep(
		${FROTH.curveStart.toFixed(3)},
		${FROTH.curveEnd.toFixed(3)},
		sk
	);
}

void main() {
	vec2 uv = vUv - uShift;
	float c = texture2D(uPrev, uv).r;
	float avg = (
		texture2D(uPrev, uv + vec2(uDiffTexel, 0.0)).r +
		texture2D(uPrev, uv - vec2(uDiffTexel, 0.0)).r +
		texture2D(uPrev, uv + vec2(0.0, uDiffTexel)).r +
		texture2D(uPrev, uv - vec2(0.0, uDiffTexel)).r
	) * 0.25;
	vec2 world = (vUv - 0.5) * uExtent + uCenter;
	// Turbulence-scaled decay: the local instantaneous Jacobian probes
	// how violently the water underneath is breaking, and churning water
	// TEARS foam apart while calm water lets it linger. Evaporation
	// scales with the same probe (and is what lets thin foam actually
	// reach zero — without it, diffusion leaves an undying hairline
	// skirt webbing the whole sea).
	// The Jacobian probe is the sim's dominant cost (a full wave sum per
	// texel), and half the 100m domain is never on screen: outside the
	// visible radius the probe is skipped and the water treated as calm —
	// invisible foam out there just decays quietly.
	float J = 1.0;
	float frothSk = 0.0;
	float frothPinch = 0.0;
	vec3 disp = vec3(0.0);
	vec2 orbital = vec2(0.0);
	if (dot(world, world) < 1764.0)
		frothProbe(world, uTime, uAmp, J, frothSk, frothPinch, disp, orbital);
	${
		ENABLE.turbDissipation
			? `float turb = 1.0 - smoothstep(${TURB_J_FULL.toFixed(2)}, ${TURB_J_START.toFixed(2)}, J);`
			: ''
	}
	// DORMANT until it has some body: a deposit only starts spreading
	// (and dying) once it clears growStart. A single droplet's dot would
	// otherwise diffuse below the render floor before anyone saw it.
	float grown = smoothstep(
		${FOAM.growStart.toFixed(3)},
		${FOAM.growFull.toFixed(3)},
		c
	);
	// PATCH CHARACTER. One number per stretch of water, driving both how
	// fast foam there spreads and how long it lives. Without it every
	// patch runs the same clock: they all thin at the same rate, so they
	// all open into web at the same moment and the sea reads as one
	// uniform lace. Varying the spread means some patches are still solid
	// while their neighbours have already torn open.
	//
	// Anchored in the field's own coordinates rather than carried per
	// deposit, so a patch drifts slowly through it — the water it sits on
	// changes character, which is also how the real thing behaves.
	// NOT named patch: that is a RESERVED WORD in GLSL ES (tessellation
	// shaders claim it), and using it fails compilation with a bare
	// "illegal use of reserved word" — which takes the whole foam sim
	// down, so the field renders nothing at all rather than misbehaving.
	float pocket = foamNoise(world * ${(1 / FOAM.varyScale).toFixed(4)}) * 0.65
		+ foamNoise(world * ${(2.3 / FOAM.varyScale).toFixed(4)} + 11.0) * 0.35;
	// Varies DOWNWARD only. Diffusion is already pinned at its saturation
	// ceiling (see uDiffusion in step: mixing saturates at ~1 per step),
	// so there is no "faster" left to ask for — and a mix factor of 1.0
	// is not fast spreading, it is replacing the texel outright with its
	// neighbour average, which erases foam within a second. Slow patches
	// hold together; the rest run at the nominal rate.
	// PER-CELL stubbornness, read from the SAME random the web render
	// uses, at the same cell scale and through the same domain warp — so
	// the cell that holds its thickness here is the cell that draws solid
	// there. (The warp must match or the two disagree about where one
	// cell ends, and the effect smears across boundaries.)
	//
	// This has to happen in the SIM, not just the render. A render-side
	// threshold can only reinterpret a shared thickness field, so a
	// stubborn cell outlives its neighbours by about one time constant
	// and no more. Varying the decay itself lets one cell still be
	// holding foam after the ones around it have gone to zero.
	vec2 wf = world - uFlow;
	vec2 wq = wf + vec2(
		sin(wf.y * 2.1 + wf.x * 0.7),
		sin(wf.x * 1.8 - wf.y * 0.8)
	) * 0.13;
	float cellRand = texture2D(uWebTex, wq / ${(FOAM.cellFine * WEB_TILE_CELLS).toFixed(2)}).g;
	float spreadK = mix(1.0, ${(1 - FOAM.varySpread).toFixed(3)}, pocket)
		* mix(1.0, ${(1 - FOAM.cellSpreadVary).toFixed(3)}, cellRand);
	float spreadH = mix(c, avg, clamp(uDiffusion * spreadK, 0.0, 1.0) * grown);
	// Thickness-biased decay (see DECAY_TAU_THIN/THICK): peaks erode
	// faster than skirts, so mounds flatten into spreading plateaus that
	// die everywhere at once — expansion is continuous until the fade.
	float thickBias = smoothstep(0.0, 0.6, spreadH);
	// Turbulence DECAY channel removed: pinned loop droplets deposit
	// exactly where J is collapsed, so the 1.1s turb clock was shredding
	// every fresh deposit in its own landing zone. turb still scales
	// evaporation below.
	float retain = mix(uDecay, uDecayThick, thickBias);
	// Capacity pressure: accelerate the decay of THIN (= old) foam only,
	// so approaching the budget fades the oldest tails instead of
	// popping anything or blocking new deposits.
	retain = mix(retain, min(retain, uDecayOld), uOverload * (1.0 - thickBias));
	// Where the surface is horizontally COMPRESSED (J < 1) floating foam
	// is squeezed together and persists; where it is stretched it
	// disperses.
	float conv = clamp(1.0 - J, -1.2, 1.2);
	// The cap is tight because these stack, and an uncapped stack once
	// pushed lifetimes toward a minute — the storm saturated solid white.
	retain = min(retain + conv * 0.0012, 0.9985);
	// Lifetime takes the same patch character as the spread. Retention is
	// per-frame, so an exponent scales the time constant directly:
	// retain^k is a life of tau/k. Below 1 the patch outlives its
	// neighbours and stays a thick streak; above 1 it fades early.
	// Same direction: solid patches outlive the rest, none die early.
	// Both scales compound: the pocket sets the region's character, the
	// cell decides which cells within it are the holdouts. The 0.9985 cap
	// is what stops a stubborn cell living forever — at 30 steps/s it
	// works out at roughly 20s, against 4-12s for ordinary foam.
	retain = min(
		pow(
			retain,
			mix(1.0, ${(1 - FOAM.varyLife).toFixed(3)}, pocket)
				* mix(1.0, ${(1 - FOAM.cellLifeVary).toFixed(3)}, cellRand)
		),
		0.9985
	);
	// Dormant foam barely decays either — it is waiting to be joined,
	// not dying. A small residual keeps stray specks from living forever.
	float dormantRetain = pow(retain, ${FOAM.dormantDecay.toFixed(3)});
	retain = mix(dormantRetain, retain, grown);
	// Evaporation is small: with doubled diffusion, AREA GROWTH is the
	// main thinning force (double the radius = a quarter the thickness),
	// and heavy evaporation was cutting the long thin phase short.
	// uDtScale makes rates WALL-CLOCK true at any framerate.
	float h = max(
		spreadH * retain
			- ${FOAM.evaporation.toFixed(5)} * uDtScale * ${
				ENABLE.turbDissipation ? '(1.0 + 5.0 * turb)' : '1.0'
			} * grown,
		0.0
	);

	// NO in-field crest generation: foam is EMERGENT from spray alone.
	// FOAM FROM THE FROTH, laid continuously.
	//
	// Breaking water makes foam the whole time it is breaking, so this is
	// a RATE, not a stamp: every step adds a little wherever the froth
	// criterion fires. Doing it from the CPU instead meant a batch of
	// discrete gaussians queued once per scan cycle, and those read
	// exactly as what they were — patches appearing whole, six frames
	// apart. Here there is no queue, no per-deposit budget and no burst;
	// the crest simply paints as it travels, and because it travels, what
	// it leaves behind is a trail.
	//
	// Foam laid under the break is also being evaporated at 6x by the
	// turb term above, so what survives is the part the crest has already
	// moved off — which is the wake, and the right answer anyway.
	// Gate on the froth mass's RADIUS, not on the raw froth factor. The
	// two are far apart at the low end: a mass's radius is its base size
	// times the factor times the visibility ramp, so all three collapse
	// together and the radius falls away much faster than the factor
	// does. A factor of 0.18 works out at about 0.03m of froth — under
	// FROTH.cullRadius, i.e. froth that is culled and never drawn. Gating
	// on the factor was laying foam from breaks that are not on screen.
	float frothR = ${(FROTH.radiusBase + FROTH.radiusVar * 0.5).toFixed(3)}
		* min(frothSk, ${FROTH.sizeCap.toFixed(3)})
		* smoothstep(${FROTH.visStart.toFixed(3)}, ${FROTH.visFull.toFixed(3)}, frothSk);
	// The response RAMPS UP with size and then, optionally, comes back
	// down: a plain smoothstep is monotonic, so every knob on it moves
	// small and large froth together. The rolloff is the only way to take
	// foam off the biggest breaks while leaving the small ones alone.
	// AND the water must actually be FOLDING. The size test alone is not
	// enough, because the froth factor behind it is RELATIVE: its
	// amplitude ratio is measured against the preset's own dominant wave,
	// so a calm sea's biggest ripples score as high as a storm's crests,
	// and intK's floor keeps the product well clear of zero even on flat
	// water. On the calm preset that came out around 0.5m of nominal
	// froth radius everywhere — straight through the size gate, at full
	// rate, on a sea with no breaking waves at all.
	//
	// The raw pinch has no floor and no normalisation: it is zero unless
	// the surface is genuinely folding, whatever sea this is.
	h += ${ENABLE.foamTrail ? '1.0' : '0.0'} * smoothstep(
		${FOAM.layPinchStart.toFixed(3)},
		${FOAM.layPinchFull.toFixed(3)},
		frothPinch
	) * smoothstep(
		${FOAM.layMinRadius.toFixed(3)},
		${FOAM.layFullRadius.toFixed(3)},
		frothR
	) * (1.0 - ${FOAM.layBigRolloff.toFixed(3)} * smoothstep(
		${FOAM.layBigStart.toFixed(3)},
		${FOAM.layBigFull.toFixed(3)},
		frothR
	)) * ${FOAM.layRate.toFixed(5)} * uDtScale;

	// OBJECT CONTACT, as a source rather than a painted shape.
	//
	// Foam at a waterline is foam: it should be made here and then live
	// like all the rest, drifting on the current, diffusing, decaying and
	// webbing. Painting it into the water shader instead meant carrying a
	// private copy of every one of those behaviours — its own drift, its
	// own tail, its own fade — each hand-shaped and none of it agreeing
	// with the field automatically. Emitting into the field gets the wake
	// for free: the collar is round, and the current pulls it out.
	//
	// The rate scales with CHOP, so a glassy sea wets its buoys without
	// foaming them and a storm rings them hard.
	{
		vec2 surfXZ = world + disp.xz;
		float surfY = disp.y;
		// The water's velocity RELATIVE to the object. Orbital motion plus
		// the surface current; the objects are moored, so their own
		// velocity is zero and relative velocity is just the water's. Give
		// a buoy real horizontal motion later and it subtracts here.
		vec2 relVel = orbital + uCurrent;
		float flowSpd = length(relVel);
		vec2 flowDir = flowSpd > 0.0001 ? relVel / flowSpd : vec2(0.0);
		float flowK = min(flowSpd / ${FOAM.contactFlowFull.toFixed(3)}, 1.0);
		float touch = 0.0;
		// Sphere: the circle the surface cuts at this height.
		float dyS = surfY - SPHERE_C.y;
		float ringS = sqrt(max(SPHERE_R * SPHERE_R - dyS * dyS, 0.0));
		if (ringS > 0.0) {
			// abs(), not max(d, 0): the band STRADDLES the waterline. Using
			// the outside-only distance made the whole interior emit too,
			// which as a painted collar was invisible behind the object but
			// as a SOURCE meant the sphere laying a solid disc up to 10m
			// across every time a trough exposed it — and the field then
			// spread that over everything.
			vec2 rel = surfXZ - SPHERE_C.xz;
			float dS = length(rel) - ringS;
			float band = 1.0 - smoothstep(0.0, ${FOAM.contactBand.toFixed(3)}, abs(dS));
			// WINDWARD face: the side the flow is running into. The outward
			// normal there points back up the flow, so the dot is negative.
			float bow = max(-dot(normalize(rel + vec2(1e-5)), flowDir), 0.0);
			touch = max(touch, band * (1.0 + ${FOAM.contactBowGain.toFixed(3)} * bow * flowK));
		}
		// Buoys: 2D footprint, with height only fading the strength.
		for (int i = 0; i < 3; i++) {
			vec3 lp = (uBuoyInv[i] * vec4(surfXZ.x, surfY, surfXZ.y, 1.0)).xyz;
			vec2 qb = abs(lp.xz) - BUOY_HALF.xz;
			float db = length(max(qb, vec2(0.0))) + min(max(qb.x, qb.y), 0.0);
			float vk = (1.0 - smoothstep(0.0, ${FOAM.contactOverwash.toFixed(3)}, max(lp.y - BUOY_HALF.y, 0.0)))
				* (1.0 - smoothstep(0.0, ${FOAM.contactLift.toFixed(3)}, max(-BUOY_HALF.y - lp.y, 0.0)));
			// Same windward bias, with the flow carried into the box's own
			// frame — the transform is rigid, so rotating the direction by
			// it (w = 0) is exact and needs no world-space buoy centre.
			vec2 flowLocal = (uBuoyInv[i] * vec4(flowDir.x, 0.0, flowDir.y, 0.0)).xz;
			float bowB = max(-dot(normalize(lp.xz + vec2(1e-5)), flowLocal), 0.0);
			float bandB = 1.0 - smoothstep(0.0, ${FOAM.contactBand.toFixed(3)}, abs(db));
			touch = max(touch, bandB * vk * (1.0 + ${FOAM.contactBowGain.toFixed(3)} * bowB * flowK));
		}
		h += touch * ${ENABLE.contactEmit ? FOAM.contactRate.toFixed(5) : '0.0'}
			* uFoaminess * uDtScale;
	}

	// Deposits below come from landing droplets: discrete splashes, which
	// genuinely are point events, unlike the break itself.

	for (int i = 0; i < ${MAX_INJECT}; i++) {
		vec4 inj = uInject[i];
		if (inj.w == 0.0) continue;
		vec2 d = world - inj.xy;
		h += inj.w * exp(-dot(d, d) / (2.0 * inj.z * inj.z));
	}
	h = min(h, 1.0);

	// Absorb near the domain edge so drifting foam dies instead of piling.
	float edge =
		smoothstep(0.0, 0.05, vUv.x) * smoothstep(0.0, 0.05, 1.0 - vUv.x) *
		smoothstep(0.0, 0.05, vUv.y) * smoothstep(0.0, 0.05, 1.0 - vUv.y);
	h *= edge;

	gl_FragColor = vec4(h, 0.0, 0.0, 1.0);
}`

export class FoamField {
  private targets: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget]
  private current = 0
  private material: THREE.ShaderMaterial
  private simScene: THREE.Scene
  private simCamera: THREE.OrthographicCamera
  private webTarget: THREE.WebGLRenderTarget | null = null

  /**
   * @param buoyInv the water material's own inverse buoy transforms,
   *   passed by reference so the sim and the water shader can never see
   *   different buoy positions.
   */
  constructor(buoyInv: THREE.Matrix4[], sphereC: THREE.Vector3) {
    const makeTarget = () =>
      new THREE.WebGLRenderTarget(FOAM_RESOLUTION, FOAM_RESOLUTION, {
        type: THREE.HalfFloatType,
        format: THREE.RedFormat,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: false,
        stencilBuffer: false,
      })
    this.targets = [makeTarget(), makeTarget()]

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uPrev: { value: this.targets[0].texture },
        uTexel: { value: 1 / FOAM_RESOLUTION },
        // Retention/diffusion/rate uniforms are recomputed from the real
        // frame dt each step, so the foam's clocks run in WALL-CLOCK time
        // — at 30fps the old per-frame constants made everything (decay,
        // spread, evaporation) take exactly twice as long as tuned.
        uDecay: { value: Math.exp(-1 / (60 * DECAY_TAU_THIN)) },
        uDecayThick: { value: Math.exp(-1 / (60 * DECAY_TAU_THICK)) },
        uDecayTurb: { value: Math.exp(-1 / (60 * DECAY_TAU_TURB)) },
        // The froth reference — see FROTH.ampRef. Kept in step with the
        // scene's copy via setDomAmp on every sea change.
        uDomAmp: { value: Math.max(waves.reduce((a, b) => Math.max(a, b.amp), 0), FROTH.ampRef) },
        uWebTex: { value: null as THREE.Texture | null },
        uFlow: { value: new THREE.Vector2() },
        // Shared with the water material: the same array object, so the
        // two can never see different buoy positions.
        uBuoyInv: { value: buoyInv },
        uCurrent: { value: new THREE.Vector2() },
        uDecayOld: { value: Math.exp(-1 / (60 * DECAY_TAU_OLD)) },
        uOverload: { value: 0 },
        uDiffusion: { value: DIFFUSION },
        uDiffTexel: { value: 1 / FOAM_RESOLUTION },
      uFoaminess: { value: CONTACT_FOAMINESS },
        uDtScale: { value: 1 },
        // Shared with the water and the crest so nothing can disagree
        // about where the sphere is; live from UNDERWATER.sphereDepth.
        SPHERE_C: { value: sphereC },
        uShift: { value: new THREE.Vector2(0, 0) },
        uCenter: { value: new THREE.Vector2(0, 0) },
        uExtent: { value: FOAM_EXTENT },
        uTime: { value: 0 },
        uAmp: { value: 1 },
        // Shared with every other wave material; see waveUniformA.
        uWaveA: { value: waveUniformA },
        uWaveB: { value: waveUniformB },
        uInject: {
          value: Array.from({ length: MAX_INJECT }, () => new THREE.Vector4()),
        },
      },
      vertexShader: simVertex,
      fragmentShader: simFragment,
      depthTest: false,
      depthWrite: false,
    })

    this.simScene = new THREE.Scene()
    this.simScene.add(
      new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material),
    )
    this.simCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  }

  /** The latest thickness field; re-read after each step (targets swap). */
  get texture(): THREE.Texture {
    return this.targets[this.current].texture
  }

  /** The baked, tiling web-skeleton distance field (null until baked). */
  get webTexture(): THREE.Texture | null {
    return this.webTarget ? this.webTarget.texture : null
  }

  private bakeWeb(renderer: THREE.WebGLRenderer) {
    this.webTarget = new THREE.WebGLRenderTarget(WEB_TILE_RES, WEB_TILE_RES, {
      type: THREE.HalfFloatType,
      // RG, not R: .r is the edge distance, .g the per-cell random.
      format: THREE.RGFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.RepeatWrapping,
      depthBuffer: false,
      stencilBuffer: false,
    })
    const material = new THREE.ShaderMaterial({
      vertexShader: simVertex,
      fragmentShader: webBakeFragment,
      depthTest: false,
      depthWrite: false,
    })
    const scene = new THREE.Scene()
    scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material))
    const previous = renderer.getRenderTarget()
    renderer.setRenderTarget(this.webTarget)
    renderer.render(scene, this.simCamera)
    renderer.setRenderTarget(previous)
    material.dispose()
  }

  /** One field update per frame, consuming queued deposits. */
  private pendingCenter = new THREE.Vector2(0, 0)

  /**
   * Follow the boat, texel-snapped. Only RECORDS the target here: the
   * centre must move in the same step() that scrolls the content, or the
   * two disagree for a frame. This sim runs at HALF frame rate, and the
   * first version moved the centre immediately — so on every in-between
   * frame the water sampled a moved window over unscrolled content, and
   * the whole foam layer flicked sideways by a texel each time the
   * travelling window stepped. Centre + content are one state; they
   * change together or not at all.
   */
  recenter(x: number, z: number) {
    const texel = FOAM_EXTENT / FOAM_RESOLUTION
    this.pendingCenter.set(Math.round(x / texel) * texel, Math.round(z / texel) * texel)
  }

  /** Domain centre, for the water shader's uFoamCenter. */
  get center(): THREE.Vector2 {
    return this.material.uniforms.uCenter.value as THREE.Vector2
  }

  step(
    renderer: THREE.WebGLRenderer,
    windX: number,
    windZ: number,
    t: number,
    dt: number,
  ) {
    if (!this.webTarget) this.bakeWeb(renderer)
    const u = this.material.uniforms
    // The sim reads the web tile for its per-cell random, so it can only
    // be wired once the bake above has run.
    if (!u.uWebTex.value && this.webTarget) u.uWebTex.value = this.webTarget.texture
    u.uTime.value = t
    const d = Math.min(Math.max(dt, 0.001), 0.1)
    u.uDecay.value = Math.exp(-d / DECAY_TAU_THIN)
    u.uDecayThick.value = Math.exp(-d / DECAY_TAU_THICK)
    u.uDecayTurb.value = Math.exp(-d / DECAY_TAU_TURB)
    u.uDecayOld.value = Math.exp(-d / DECAY_TAU_OLD)
    // Capacity pressure from the analytic mass estimate; the estimate's
    // own decay clock speeds up with overload so it tracks the
    // acceleration it causes in the field.
    const overload = Math.min(
      Math.max((massEst - OVERLOAD_START) / (OVERLOAD_FULL - OVERLOAD_START), 0),
      1,
    )
    u.uOverload.value = overload
    massEst *= Math.exp(-d / (DECAY_TAU_THIN * (1 - 0.7 * overload)))
    // Mixing saturates at ~1 per step, which would silently HALVE the
    // spread rate when steps are skipped (dt doubles). Compensation:
    // spread variance goes as mixing x tapDistance^2, so widen the taps
    // by sqrt of whatever the saturated mixing couldn't deliver.
    const targetMix = DIFFUSION * d * 60
    const mix = Math.min(targetMix, 0.95)
    u.uDiffusion.value = mix
    u.uDiffTexel.value = Math.sqrt(targetMix / mix) / FOAM_RESOLUTION
    u.uDtScale.value = d * 60
    // Follows a live sea-state change; see the onFieldChange hook below.
    u.uFoaminess.value = CONTACT_FOAMINESS
    // Foam drifts on BOTH: a fraction of the wind (it is blown across
    // the surface) plus the surface current in full (it floats in the
    // skin of the water, so it goes where the water goes).
    const cur = currentVector(t)
    // The same carry that advects the field, accumulated. Built here
    // from the field's own drift terms so the pattern and the thickness
    // can never disagree about how far the water has gone.
    foamFlow.x += (windX * FOAM_DRIFT + cur.x * FOAM.currentCarry) * d
    foamFlow.z += (windZ * FOAM_DRIFT + cur.z * FOAM.currentCarry) * d
    ;(u.uFlow.value as THREE.Vector2).set(foamFlow.x, foamFlow.z)
    ;(u.uCurrent.value as THREE.Vector2).set(cur.x, cur.z)
    const shift = u.uShift.value as THREE.Vector2
    shift.set(
      ((windX * FOAM_DRIFT + cur.x * FOAM.currentCarry) * d) / FOAM_EXTENT,
      ((windZ * FOAM_DRIFT + cur.z * FOAM.currentCarry) * d) / FOAM_EXTENT,
    )
    // Window recentering scrolls content through the same mechanism —
    // and moves the centre in the SAME step, atomically (see recenter).
    {
      const c = u.uCenter.value as THREE.Vector2
      if (this.pendingCenter.x !== c.x || this.pendingCenter.y !== c.y) {
        shift.x -= (this.pendingCenter.x - c.x) / FOAM_EXTENT
        shift.y -= (this.pendingCenter.y - c.y) / FOAM_EXTENT
        c.copy(this.pendingCenter)
      }
    }

    const inject = this.material.uniforms.uInject.value as THREE.Vector4[]
    for (let i = 0; i < MAX_INJECT; i++) {
      // Signal first, ambient with the remainder.
      const p = pendingHi.shift() ?? pendingLo.shift()
      if (p) {
        inject[i].set(p.x, p.z, p.sigma, p.amp)
        massEst += p.amp * p.sigma * p.sigma
      } else inject[i].set(0, 0, 1, 0)
    }

    const next = 1 - this.current
    this.material.uniforms.uPrev.value = this.targets[this.current].texture
    const previousTarget = renderer.getRenderTarget()
    renderer.setRenderTarget(this.targets[next])
    renderer.render(this.simScene, this.simCamera)
    renderer.setRenderTarget(previousTarget)
    this.current = next
  }

  /** The froth reference: max(sea dominant amp, FROTH.ampRef). */
  setDomAmp(v: number) {
    this.material.uniforms.uDomAmp.value = v
  }

  dispose() {
    this.targets[0].dispose()
    this.targets[1].dispose()
    this.material.dispose()
    if (this.webTarget) this.webTarget.dispose()
  }
}

// ---- Rendering ----

/** Voronoi web cell sizes, meters: the three-rung ladder (see foamGlsl). */
const CELL_FINE = FOAM.cellFine
const CELL_COARSE = FOAM.cellCoarse
/**
 * Strand half-width at full thickness, in cell units. The farthest
 * interior point of a cell sits ~0.5 from an edge, so 0.55 fuses the
 * strands into a solid sheet; the sheet opens as thickness decays.
 */
const SOLID_WIDTH = 0.8

/**
 * Water-fragment side, all of it: sample the thickness field at REST
 * coordinates, then render the fat white wireframe. The skeleton is the
 * edge network of a world-anchored Voronoi diagram; thick foam fuses
 * solid, thinning foam tears into rounded lace whose cells merge and
 * GROW down the three-rung ladder — spreading and relaxing as it dies.
 */
export function foamGlsl(): string {
  return `
uniform sampler2D uFoamTex;
uniform vec2 uFoamCenter;
uniform float uFoamExtent;
uniform sampler2D uFoamWebTex;
/** Accumulated wind+current carry, metres. The thickness field is
 *  advected inside the sim, but the web SKELETON is generated per pixel
 *  from a world-anchored lookup — so without this the foam's thickness
 *  flows downstream through a lace pattern that stands still, and only
 *  the envelope appears to move. Offsetting the domain by the same
 *  travel carries the pattern with the water. */
uniform vec2 uFoamFlow;
${foamNoiseGlsl}

float foamThicknessAt(vec2 rest) {
	vec2 uv = (rest - uFoamCenter) / uFoamExtent + 0.5;
	if (uv.x <= 0.0 || uv.x >= 1.0 || uv.y <= 0.0 || uv.y >= 1.0) return 0.0;
	return texture2D(uFoamTex, uv).r;
}

float foamWeb(vec2 worldXZ, float thickness, float jac) {
	// Below any per-cell fade threshold (see fadeK), so the global cut
	// never pre-empts a stubborn cell's own decision to hold on.
	if (thickness < 0.02) return 0.0;
	// Perceived DENSITY is a remap of thickness: near-solid through the
	// whole top half of the range — fresh foam has NO holes, and a
	// spreading patch stays dense for most of its growth — then dropping
	// fast, compressing the lace-and-fade into the end of life.
	// Upper edge raised 0.45 -> 0.65: full solidity now needs genuinely
	// thick foam, so patches open into web earlier instead of sitting as
	// dense white slabs.
	float dens = smoothstep(${FOAM.densStart.toFixed(3)}, ${FOAM.densEnd.toFixed(3)}, thickness);
	// Cell merging follows the WAVES: compressed water (J < 1) packs the
	// foam and holds the fine web longer; stretched water opens the
	// cells early.
	float merge = clamp((1.0 - jac) * 0.25, -0.2, 0.2);
	// Domain warp: baked Voronoi edges are dead straight and their
	// junctions angular; a gentle sine warp curves every strand (the
	// smooth-min baked into the tile rounds the joints).
	// Warp wavelength must be LONGER than the largest strand: at the old
	// ~1m period the merged coarse cells (2.2m) crossed several warp
	// waves per strand and came out squiggly. One gentle bend per
	// strand, slightly deeper to stay organic.
	// Ride the flow: the pattern belongs to the foam, not to the patch of
	// sea it happens to be over.
	vec2 flowed = worldXZ - uFoamFlow;
	vec2 q = flowed + vec2(
		sin(flowed.y * 2.1 + flowed.x * 0.7),
		sin(flowed.x * 1.8 - flowed.y * 0.8)
	) * 0.13;
	// The skeleton distance field is BAKED into a tiling texture (see
	// webBakeFragment): two bilinear fetches replace two live Voronoi
	// evaluations, which at storm foam coverage was the difference
	// between 19 and ~50 fps. Two rungs, fine and coarse — the cells
	// merge and GROW as the foam thins.
	vec2 wFine = texture2D(uFoamWebTex, q / ${(CELL_FINE * WEB_TILE_CELLS).toFixed(2)}).rg;
	vec2 wCoarse = texture2D(uFoamWebTex, q / ${(CELL_COARSE * WEB_TILE_CELLS).toFixed(2)}).rg;
	// MAXIMUM CELL SIZE, per cell. Cells grow by merging down the ladder
	// from fine to coarse as the foam thins, so a ceiling on how far a
	// cell may merge IS a ceiling on how big it gets. A cell held near
	// the fine rung never becomes a big open cell: its strands just thin
	// out and it dies at small size.
	//
	// Keyed to the COARSE random, because the coarse cell is the merged
	// cell whose size is being capped. Keying it to the fine random would
	// vary the ceiling WITHIN one merged cell, so different parts of the
	// same cell would read from different rungs and its edge network
	// would come apart.
	float sizeCeil = mix(${(1 - FOAM.cellMaxSizeVary).toFixed(3)}, 1.0, wCoarse.y);
	float blend = 1.0 - (1.0 - smoothstep(0.1, 0.8 - merge, dens)) * sizeCeil;
	float dEdge = mix(wCoarse.x, wFine.x, blend);
	// PER-CELL character, from the random baked into the tile alongside
	// the distance field. Each cell decides for itself how solid it stays
	// and how thin it can get before it goes — so a patch tears open
	// unevenly and empties cell by cell, instead of every cell in the
	// area reaching the same stage at the same moment.
	float cell = mix(wCoarse.y, wFine.y, blend);
	float halfWidth = dens * ${SOLID_WIDTH.toFixed(2)}
		* mix(${(1 - FOAM.cellSolidVary).toFixed(3)}, ${(1 + FOAM.cellSolidVary).toFixed(3)}, cell);
	// The last hairlines fade rather than cut, and the threshold they
	// fade against is per-cell too: stubborn cells outlast their
	// neighbours by holding on to thinner foam.
	float fadeK = mix(${(1 + FOAM.cellFadeVary).toFixed(3)}, ${(1 - FOAM.cellFadeVary).toFixed(3)}, cell);
	return smoothstep(halfWidth, halfWidth - 0.09, dEdge)
		* smoothstep(0.04 * fadeK, 0.09 * fadeK, thickness);
}`
}

// Chop drives how foamy an object's waterline is, and chop moves with the
// sea state, so this can no longer be a load-time constant.
onFieldChange(() => {
  CONTACT_FOAMINESS = contactFoaminess(activeField.chop)
})
