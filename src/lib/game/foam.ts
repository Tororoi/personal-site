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

export const FOAM_RESOLUTION = 1024
/**
 * Meters of world covered, matching the ripple domain: the field must
 * cover the scene. 100m / 1024 = ~0.1m texels, finer than the smallest
 * deposit (sigma ~0.1m).
 */
export const FOAM_EXTENT = 100

/**
 * Seconds for unfed thickness to fall to 1/e. Together with the
 * evaporation constant in the sim shader, a solid deposit crosses the
 * render floor about 8 seconds after its feeding stops.
 */
const DECAY_TAU = 5
/**
 * Per-frame neighbor mixing, 0..1: the spread rate. Diffusion is the
 * dissipation mechanism — mass leaves the peak and widens the skirt,
 * so a dying bank grows WIDE while it thins, like cream stirred out.
 * Sized against the short decay: a dot roughly triples its footprint
 * in its 8-second death.
 */
const DIFFUSION = 0.22
/** Downwind drift as a fraction of wind speed. */
const FOAM_DRIFT = 0.02

/** Gaussian deposits consumed per sim step. */
const MAX_INJECT = 24

type FoamDeposit = { x: number; z: number; sigma: number; amp: number }
const pending: FoamDeposit[] = []

/**
 * Deposit foam residue at REST-space (x, z). Accumulates: landing on an
 * existing bank raises it back toward solid (density top-up); landing on
 * bare water starts a new dot. Nothing is ever dropped.
 */
export function addFoam(x: number, z: number, sigma: number, amp = 0.9) {
  if (pending.length < 512) pending.push({ x, z, sigma, amp })
}

// Debug hook: paint foam from the console and watch it spread and die,
// e.g. addFoam(0, 0, 1.5).
if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).addFoam = addFoam
}

const simVertex = `
varying vec2 vUv;
void main() {
	vUv = uv;
	gl_Position = vec4(position.xy, 0.0, 1.0);
}`

const simFragment = `
uniform sampler2D uPrev;
uniform float uTexel;
uniform float uDecay;     // per-frame retention, exp(-1/(60 * tau))
uniform float uDiffusion; // per-frame neighbor mixing
uniform vec2 uShift;      // uv advection this frame (downwind drift)
uniform vec2 uCenter;
uniform float uExtent;
uniform vec4 uInject[${MAX_INJECT}]; // x, z, sigma, amp
varying vec2 vUv;

void main() {
	vec2 uv = vUv - uShift;
	float c = texture2D(uPrev, uv).r;
	float avg = (
		texture2D(uPrev, uv + vec2(uTexel, 0.0)).r +
		texture2D(uPrev, uv - vec2(uTexel, 0.0)).r +
		texture2D(uPrev, uv + vec2(0.0, uTexel)).r +
		texture2D(uPrev, uv - vec2(0.0, uTexel)).r
	) * 0.25;
	// Diffuse (mass-redistributing: spreads the skirt as the peak sinks),
	// then decay. The constant EVAPORATION term is what lets thin foam
	// actually reach zero: pure exponential decay + diffusion leaves an
	// ever-thinner skirt that never dies, which rendered as hairline
	// webs blanketing the whole sea.
	float h = max(mix(c, avg, uDiffusion) * uDecay - 0.0003, 0.0);

	vec2 world = (vUv - 0.5) * uExtent + uCenter;
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
        uDecay: { value: Math.exp(-1 / (60 * DECAY_TAU)) },
        uDiffusion: { value: DIFFUSION },
        uShift: { value: new THREE.Vector2(0, 0) },
        uCenter: { value: new THREE.Vector2(0, 0) },
        uExtent: { value: FOAM_EXTENT },
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

  /** One field update per frame, consuming queued deposits. */
  step(renderer: THREE.WebGLRenderer, windX: number, windZ: number) {
    const shift = this.material.uniforms.uShift.value as THREE.Vector2
    shift.set(
      (windX * FOAM_DRIFT) / 60 / FOAM_EXTENT,
      (windZ * FOAM_DRIFT) / 60 / FOAM_EXTENT,
    )

    const inject = this.material.uniforms.uInject.value as THREE.Vector4[]
    for (let i = 0; i < MAX_INJECT; i++) {
      const p = pending.shift()
      if (p) inject[i].set(p.x, p.z, p.sigma, p.amp)
      else inject[i].set(0, 0, 1, 0)
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
  }
}

// ---- Rendering ----

/** Voronoi web cell sizes, meters: the three-rung ladder (see foamGlsl). */
const CELL_FINE = 0.25
const CELL_MID = 0.6
const CELL_COARSE = 1.4
/**
 * Strand half-width at full thickness, in cell units. The farthest
 * interior point of a cell sits ~0.5 from an edge, so 0.55 fuses the
 * strands into a solid sheet; the sheet opens as thickness decays.
 */
const SOLID_WIDTH = 0.55

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

vec2 foamHash2(vec2 p) {
	return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453);
}

// Polynomial smooth minimum: where two cell edges meet, the blended
// distance dips below either one, so the thresholded strand grows a
// rounded FILLET at every junction instead of an angular corner.
float foamSmin(float a, float b, float k) {
	float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
	return mix(b, a, h) - k * h * (1.0 - h);
}

// Exact distance to the nearest Voronoi cell EDGE (iq's two-pass
// method): the web skeleton. Thresholding a TRUE distance field is what
// makes the strands capsule-shaped with naturally rounded junctions.
float foamWebDist(vec2 x) {
	vec2 n = floor(x);
	vec2 f = fract(x);
	vec2 mg = vec2(0.0);
	vec2 mr = vec2(0.0);
	float md = 8.0;
	for (int j = -1; j <= 1; j++) {
		for (int i = -1; i <= 1; i++) {
			vec2 g = vec2(float(i), float(j));
			vec2 o = foamHash2(n + g);
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
	// 3x3 second pass (iq's cheap variant): marginally inexact at some
	// far corners, invisible in foam, half the hashing. Edge distances
	// combine through a SMOOTH min, so junctions come out filleted.
	for (int j = -1; j <= 1; j++) {
		for (int i = -1; i <= 1; i++) {
			vec2 g = mg + vec2(float(i), float(j));
			vec2 o = foamHash2(n + g);
			vec2 r = g + o - f;
			if (dot(mr - r, mr - r) > 0.00001) {
				md = foamSmin(md, dot(0.5 * (mr + r), normalize(r - mr)), 0.25);
			}
		}
	}
	return md;
}

float foamThicknessAt(vec2 rest) {
	vec2 uv = (rest - uFoamCenter) / uFoamExtent + 0.5;
	if (uv.x <= 0.0 || uv.x >= 1.0 || uv.y <= 0.0 || uv.y >= 1.0) return 0.0;
	return texture2D(uFoamTex, uv).r;
}

float foamWeb(vec2 worldXZ, float thickness) {
	if (thickness < 0.07) return 0.0;
	// Domain warp: raw Voronoi edges are dead straight and their
	// junctions angular ("giraffe print"). A gentle sine warp curves
	// every strand; the smooth-min in foamWebDist rounds the joints.
	vec2 q = worldXZ + vec2(
		sin(worldXZ.y * 7.3 + worldXZ.x * 2.1),
		sin(worldXZ.x * 6.1 - worldXZ.y * 2.7)
	) * 0.09;
	// Three-rung cell ladder: solid/fine lace above ~0.45 thickness, mid
	// cells through the long middle age, huge sparse cells at the end.
	float dFine = foamWebDist(q / ${CELL_FINE.toFixed(2)});
	float dMid = foamWebDist(q / ${CELL_MID.toFixed(2)});
	float dCoarse = foamWebDist(q / ${CELL_COARSE.toFixed(2)});
	float hi = smoothstep(0.45, 0.9, thickness);
	float lo = smoothstep(0.06, 0.45, thickness);
	float dEdge = mix(mix(dCoarse, dMid, lo), dFine, hi);
	float halfWidth = thickness * ${SOLID_WIDTH.toFixed(2)};
	// Fade the last hairlines out instead of cutting: the render floor.
	return smoothstep(halfWidth, halfWidth - 0.09, dEdge) * smoothstep(0.07, 0.14, thickness);
}`
}
