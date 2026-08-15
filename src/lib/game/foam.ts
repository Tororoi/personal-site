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
import { FOAM } from './tuning'
import { currentVector } from './current'
import { waves, wavesGlsl } from './waves'

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
// Calibrated against a measured storm steady state of ~150 mass units
// (window.foamMass()): pressure begins above normal-storm load and only
// saturates at ~2.7x it.
const OVERLOAD_START = FOAM.overloadStart
const OVERLOAD_FULL = FOAM.overloadFull
let massEst = 0
/** Downwind drift as a fraction of wind speed. */
const FOAM_DRIFT = FOAM.drift

/** Gaussian deposits consumed per sim step. */
const MAX_INJECT = 24

type FoamDeposit = { x: number; z: number; sigma: number; amp: number }
const pending: FoamDeposit[] = []

/**
 * Deposit foam residue at REST-space (x, z). Accumulates: landing on an
 * existing bank raises it back toward solid (density top-up); landing on
 * bare water starts a new dot. NEW deposits always win: when the queue
 * is full the OLDEST queued deposit is dropped, never the incoming one.
 */
export function addFoam(x: number, z: number, sigma: number, amp = 0.9) {
  if (pending.length >= 512) pending.shift()
  pending.push({ x, z, sigma, amp })
}

// Debug hook: paint foam from the console and watch it spread and die,
// e.g. addFoam(0, 0, 1.5).
if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).addFoam = addFoam
  // foamMass() reads the capacity estimate — for calibrating OVERLOAD_*.
  ;(window as unknown as Record<string, unknown>).foamMass = () => massEst
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
	gl_FragColor = vec4(md, 0.0, 0.0, 1.0);
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
uniform vec2 uShift;      // uv advection this frame (downwind drift)
uniform vec2 uCenter;
uniform float uExtent;
uniform float uTime;
uniform float uAmp;
uniform vec4 uInject[${MAX_INJECT}]; // x, z, sigma, amp
varying vec2 vUv;

${wavesGlsl()}

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
	if (dot(world, world) < 1764.0) J = waveJacobian(world, uTime, uAmp);
	float turb = 1.0 - smoothstep(${TURB_J_FULL.toFixed(2)}, ${TURB_J_START.toFixed(2)}, J);
	// DORMANT until it has some body: a deposit only starts spreading
	// (and dying) once it clears growStart. A single droplet's dot would
	// otherwise diffuse below the render floor before anyone saw it.
	float grown = smoothstep(
		${FOAM.growStart.toFixed(3)},
		${FOAM.growFull.toFixed(3)},
		c
	);
	float spreadH = mix(c, avg, uDiffusion * grown);
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
	// The sea's own randomness: where the surface is horizontally
	// COMPRESSED (J < 1) floating foam is squeezed together and persists;
	// where it is stretched it disperses. Plus slow blobby pockets of
	// extra persistence, so a few patches expand far past typical and
	// survive as thick streaks instead of everything fading uniformly.
	float conv = clamp(1.0 - J, -1.2, 1.2);
	float pocket = sin(world.x * 0.53 + world.y * 0.31) * sin(world.x * 0.17 - world.y * 0.47 + 2.0);
	// Biases are small and the cap tight: these stack, and an uncapped
	// stack once pushed pocket lifetimes toward a minute — the storm
	// saturated solid white. Max retention here is ~11s-equivalent.
	retain = min(retain + conv * 0.0012 + pocket * 0.0005, 0.9985);
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
			- ${FOAM.evaporation.toFixed(5)} * uDtScale * (1.0 + 5.0 * turb) * grown,
		0.0
	);

	// NO in-field crest generation: foam is EMERGENT from spray alone.
	// Every deposit below entered through a landing droplet; crests read as
	// breaking because they erupt spray (and their folded polys cull),
	// and the foam field is simply where that water came back down.

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

  constructor() {
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
        uDecayOld: { value: Math.exp(-1 / (60 * DECAY_TAU_OLD)) },
        uOverload: { value: 0 },
        uDiffusion: { value: DIFFUSION },
        uDiffTexel: { value: 1 / FOAM_RESOLUTION },
        uDtScale: { value: 1 },
        uShift: { value: new THREE.Vector2(0, 0) },
        uCenter: { value: new THREE.Vector2(0, 0) },
        uExtent: { value: FOAM_EXTENT },
        uTime: { value: 0 },
        uAmp: { value: 1 },
        uWaveA: {
          value: waves.map(
            (w) => new THREE.Vector4(w.dirX, w.dirZ, w.k, w.omega),
          ),
        },
        uWaveB: {
          value: waves.map((w) => new THREE.Vector3(w.amp, w.q, w.phase)),
        },
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
      format: THREE.RedFormat,
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
  step(
    renderer: THREE.WebGLRenderer,
    windX: number,
    windZ: number,
    t: number,
    dt: number,
  ) {
    if (!this.webTarget) this.bakeWeb(renderer)
    const u = this.material.uniforms
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
    // Foam drifts on BOTH: a fraction of the wind (it is blown across
    // the surface) plus the surface current in full (it floats in the
    // skin of the water, so it goes where the water goes).
    const cur = currentVector(t)
    const shift = u.uShift.value as THREE.Vector2
    shift.set(
      ((windX * FOAM_DRIFT + cur.x * FOAM.currentCarry) * d) / FOAM_EXTENT,
      ((windZ * FOAM_DRIFT + cur.z * FOAM.currentCarry) * d) / FOAM_EXTENT,
    )

    const inject = this.material.uniforms.uInject.value as THREE.Vector4[]
    for (let i = 0; i < MAX_INJECT; i++) {
      const p = pending.shift()
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

float foamThicknessAt(vec2 rest) {
	vec2 uv = (rest - uFoamCenter) / uFoamExtent + 0.5;
	if (uv.x <= 0.0 || uv.x >= 1.0 || uv.y <= 0.0 || uv.y >= 1.0) return 0.0;
	return texture2D(uFoamTex, uv).r;
}

float foamWeb(vec2 worldXZ, float thickness, float jac) {
	if (thickness < 0.05) return 0.0;
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
	vec2 q = worldXZ + vec2(
		sin(worldXZ.y * 2.1 + worldXZ.x * 0.7),
		sin(worldXZ.x * 1.8 - worldXZ.y * 0.8)
	) * 0.13;
	// The skeleton distance field is BAKED into a tiling texture (see
	// webBakeFragment): two bilinear fetches replace two live Voronoi
	// evaluations, which at storm foam coverage was the difference
	// between 19 and ~50 fps. Two rungs, fine and coarse — the cells
	// merge and GROW as the foam thins.
	float dFine = texture2D(uFoamWebTex, q / ${(CELL_FINE * WEB_TILE_CELLS).toFixed(2)}).r;
	float dCoarse = texture2D(uFoamWebTex, q / ${(CELL_COARSE * WEB_TILE_CELLS).toFixed(2)}).r;
	float dEdge = mix(dCoarse, dFine, smoothstep(0.1, 0.8 - merge, dens));
	float halfWidth = dens * ${SOLID_WIDTH.toFixed(2)};
	// Fade the last hairlines out instead of cutting: the render floor.
	return smoothstep(halfWidth, halfWidth - 0.09, dEdge) * smoothstep(0.04, 0.09, thickness);
}`
}
