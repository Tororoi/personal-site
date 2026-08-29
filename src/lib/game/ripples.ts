/**
 * Physics-based interactive water: a 2D wave-equation heightfield in the
 * style of the Evan Wallace / jeantimex WebGL pool simulation.
 *
 * A 256x256 texture holds (height, velocity) per cell for the DISTURBANCE
 * field: everything the ambient Gerstner ocean does not know about, i.e.
 * water that objects have pushed around. Each frame a ping-pong render pass
 * integrates the discrete wave equation:
 *
 *   v += (average of neighbors - h) * propagation;  v *= damping;  h += v
 *
 * Objects interact by INJECTING displacement hats (injectRipple): water
 * pushed down at the center, crowned up around it. Rings, wakes,
 * interference and everything else emerge from propagation.
 *
 * This module is ONLY the wave dynamics. The non-propagating burst of
 * splash churn is a separate effect with separate machinery: froth.ts.
 *
 * Not CPU-twinned: ripples are centimeters and decorative; floaters ride
 * the ambient surface. The domain is world-anchored at uCenter (origin for
 * now; will follow the boat) and absorbs at its edges so ripples leaving
 * the area die instead of reflecting off an invisible wall.
 */

import * as THREE from 'three'
import { activeField, onFieldChange } from './waves'

export const RIPPLE_RESOLUTION = 768
/**
 * Meters of world covered by the domain. The domain must cover the SCENE
 * (the pool reference's domain covers its whole scene; that is the parity
 * that matters, not absolute cell size). At 100m / 768 the cells are
 * ~0.13m, ~3.4 screen pixels at zoom 26. Chosen against both neighbors:
 * 1024 was the reference's cells-per-pixel regime at nearly twice the
 * cost, and 512 visibly blotched the ring caustics and showed the wave
 * equation's axis anisotropy as square-ish rings around the buoys.
 */
export const RIPPLE_EXTENT = 100

/**
 * Calm-water defaults; sea presets override via their `ripples` block (see
 * WaveFieldConfig in waves.ts). displayGain scales the DISPLAY of the field
 * without touching the simulation: the raw physics lives in honest meters
 * (a hard splash ring is ~5-15cm, real but invisible at 26px/m).
 */
const RIPPLE_BASE = {
  displayGain: 3.5,
  /** Physical ripple propagation speed, m/s. */
  speed: 1.5,
  damping: 0.9955,
}
let SETTINGS = { ...RIPPLE_BASE, ...activeField.ripples }

/**
 * The wave-equation step constant, DERIVED from the physical speed and the
 * cell size (honest meters: presets state m/s and never need retuning when
 * resolution or extent change). c = sqrt(P/2) cells/step, so
 * P = 2 (c dt / cell)^2, clamped at 0.5 for stability; speeds above ~
 * cell/dt * 0.5 are unreachable at this resolution and get clamped.
 */
let PROPAGATION = Math.min(
  2 * ((SETTINGS.speed / 60 / (RIPPLE_EXTENT / RIPPLE_RESOLUTION)) ** 2),
  0.5,
)

/** Gaussian pokes applied per sim step. */
const MAX_INJECT = 8

type Injection = { x: number; z: number; radius: number; strength: number }
const pending: Injection[] = []

/**
 * Pokes being paid out over multiple sim steps — see injectRippleOver.
 */
const spreading: (Injection & { steps: number })[] = []

/**
 * Live disturbance regions, for consumers that only want to work where
 * ripples exist (the caustic splat culls to these). A disturbance's reach
 * is its expanding ring front: speed * age, plus a margin. Lifetime comes
 * from the preset's damping (time to decay to ~3%).
 */
const activity: { x: number; z: number; birth: number }[] = []
let ACTIVITY_TTL = Math.log(0.03) / Math.log(SETTINGS.damping) / 60

// A live sea-state change swaps the whole ripple character — a storm's
// rings travel and die differently from a calm's. displayGain reaches the
// shader as a uniform (below) precisely so it can move without a rebuild.
onFieldChange(() => {
  SETTINGS = { ...RIPPLE_BASE, ...activeField.ripples }
  PROPAGATION = Math.min(
    2 * ((SETTINGS.speed / 60 / (RIPPLE_EXTENT / RIPPLE_RESOLUTION)) ** 2),
    0.5,
  )
  ACTIVITY_TTL = Math.log(0.03) / Math.log(SETTINGS.damping) / 60
})

export function activeRegions(t: number): { x: number; z: number; r: number }[] {
  for (let i = activity.length - 1; i >= 0; i--) {
    if (t - activity[i].birth > ACTIVITY_TTL) activity.splice(i, 1)
  }
  return activity.map((a) => ({
    x: a.x,
    z: a.z,
    r: SETTINGS.speed * (t - a.birth) + 2.5,
  }))
}

/** Called by injectRipple; exported for future non-ripple disturbances. */
export function noteActivity(t: number, x: number, z: number) {
  // Self-prune so the list stays healthy even if activeRegions is unused.
  for (let i = activity.length - 1; i >= 0; i--) {
    if (t - activity[i].birth > ACTIVITY_TTL) activity.splice(i, 1)
  }
  // Merge with a recent nearby entry so continuous agitation (a bobbing
  // buoy) holds one region instead of spawning one per frame.
  for (const a of activity) {
    const dx = a.x - x
    const dz = a.z - z
    if (dx * dx + dz * dz < 4 && t - a.birth < 0.5) return
  }
  if (activity.length < 48) activity.push({ x, z, birth: t })
}

/**
 * Disturb the water at world (x, z): a displacement "hat" of `strength`
 * meters (down at center, crown around), which the wave equation evolves.
 * For the non-propagating burst of splash churn, see froth.ts.
 */
let rippleClock = 0
/** Called once per fixed step by the Scene so injections can be dated. */
export function setRippleClock(t: number) {
  rippleClock = t
}

/**
 * A poke paid out over `seconds` instead of landing in one step.
 *
 * The wave sim is happy either way — but the EYE is not. A splashdown
 * deposited as a single full-strength Gaussian materialises ~0.4m of
 * water beside the buoy in one frame, which reads as the mesh glitching
 * (a real ring grows over a couple hundred ms). Spreading the same total
 * energy across a few steps lets the earlier fraction start propagating
 * while the rest arrives: the ring RISES instead of appearing.
 */
export function injectRippleOver(
  x: number,
  z: number,
  radius: number,
  strength: number,
  seconds = 0.15,
) {
  const steps = Math.max(1, Math.round(seconds * 60))
  spreading.push({ x, z, radius, strength: strength / steps, steps })
}

export function injectRipple(
  x: number,
  z: number,
  radius: number,
  strength: number,
) {
  if (pending.length < 64 && strength !== 0) {
    pending.push({ x, z, radius, strength })
    noteActivity(rippleClock, x, z)
  }
}

// Debug hook: poke the water from the console, e.g. injectRipple(0, 0, 1, 0.4).
if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).injectRipple = injectRipple
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
uniform float uPropagation;
uniform float uDamping;
uniform vec2 uCenter;
uniform vec2 uScroll;
uniform float uExtent;
uniform vec4 uInject[${MAX_INJECT}]; // worldX, worldZ, radius, strength
varying vec2 vUv;

void main() {
	// uScroll shifts every PREV read when the domain recenters on the
	// moving boat: sampling the old frame offset by the centre delta keeps
	// rings pinned to the world instead of dragging with the window.
	vec2 suv = vUv + uScroll;
	vec2 hv = texture2D(uPrev, suv).xy;
	float hr = texture2D(uPrev, suv + vec2(uTexel, 0.0)).x;
	float hl = texture2D(uPrev, suv - vec2(uTexel, 0.0)).x;
	float hu = texture2D(uPrev, suv + vec2(0.0, uTexel)).x;
	float hd = texture2D(uPrev, suv - vec2(0.0, uTexel)).x;
	float sum = hr + hl + hu + hd;
	float v = hv.y + (sum * 0.25 - hv.x) * uPropagation;
	v *= uDamping;
	float h = hv.x + v;
	// The gradient rides free in zw: these neighbor fetches already
	// happened, and consumers (the caustic splat) then need ONE fetch per
	// sample instead of five.
	float cell = uExtent * uTexel;
	vec2 grad = vec2(hr - hl, hu - hd) / (2.0 * cell);

	vec2 world = (vUv - 0.5) * uExtent + uCenter;
	for (int i = 0; i < ${MAX_INJECT}; i++) {
		vec4 inj = uInject[i];
		if (inj.w == 0.0) continue;
		vec2 d = world - inj.xy;
		float dist2 = dot(d, d);
		// Displacement-conserving "hat": the object pushes water DOWN at the
		// center while the displaced volume piles UP in a crown around it,
		// simultaneously. A splash is local displacement, not a wave launch;
		// a balanced shape also radiates far less traveling ring than a
		// single-signed poke.
		float g = exp(-dist2 / (2.0 * inj.z * inj.z));
		float dist = sqrt(dist2);
		float rimSigma = 0.55 * inj.z;
		float rim = exp(-pow(dist - 1.3 * inj.z, 2.0) / (2.0 * rimSigma * rimSigma));
		h += inj.w * (0.85 * rim - g);
	}

	// Absorb near the domain boundary so ripples die instead of reflecting.
	float edge =
		smoothstep(0.0, 0.08, vUv.x) * smoothstep(0.0, 0.08, 1.0 - vUv.x) *
		smoothstep(0.0, 0.08, vUv.y) * smoothstep(0.0, 0.08, 1.0 - vUv.y);
	h *= mix(0.9, 1.0, edge);
	v *= mix(0.9, 1.0, edge);

	gl_FragColor = vec4(h, v, grad.x, grad.y);
}`

export class RippleSim {
  private targets: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget]
  private current = 0
  private material: THREE.ShaderMaterial
  private simScene: THREE.Scene
  private simCamera: THREE.OrthographicCamera

  constructor() {
    const makeTarget = () =>
      new THREE.WebGLRenderTarget(RIPPLE_RESOLUTION, RIPPLE_RESOLUTION, {
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: false,
        stencilBuffer: false,
      })
    this.targets = [makeTarget(), makeTarget()]

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uPrev: { value: this.targets[0].texture },
        uTexel: { value: 1 / RIPPLE_RESOLUTION },
        uPropagation: { value: PROPAGATION },
        uDamping: { value: SETTINGS.damping },
        uCenter: { value: new THREE.Vector2(0, 0) },
        uScroll: { value: new THREE.Vector2(0, 0) },
        uExtent: { value: RIPPLE_EXTENT },
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

  /** The latest field texture; re-read after each step (targets swap). */
  get texture(): THREE.Texture {
    return this.targets[this.current].texture
  }

  /** One wave-equation iteration, consuming queued injections. */
  /** Domain centre, for consumers' uRippleCenter uniforms. */
  get center(): THREE.Vector2 {
    return this.material.uniforms.uCenter.value as THREE.Vector2
  }

  private scrollPending = new THREE.Vector2()

  /**
   * Move the domain to follow the boat, in whole-texel steps, scrolling
   * the sim content so rings stay world-pinned. Texel snapping matters:
   * a fractional shift resampled every frame would diffuse the field.
   */
  recenter(x: number, z: number) {
    const cell = RIPPLE_EXTENT / RIPPLE_RESOLUTION
    const c = this.center
    const nx = Math.round(x / cell) * cell
    const nz = Math.round(z / cell) * cell
    if (nx === c.x && nz === c.y) return
    this.scrollPending.x += (nx - c.x) / RIPPLE_EXTENT
    this.scrollPending.y += (nz - c.y) / RIPPLE_EXTENT
    c.set(nx, nz)
  }

  step(renderer: THREE.WebGLRenderer) {
    ;(this.material.uniforms.uScroll.value as THREE.Vector2).copy(this.scrollPending)
    this.scrollPending.set(0, 0)
    // Pay out the time-spread pokes, one slice per step.
    for (let i = spreading.length - 1; i >= 0; i--) {
      const sp = spreading[i]
      pending.push({ x: sp.x, z: sp.z, radius: sp.radius, strength: sp.strength })
      if (--sp.steps <= 0) spreading.splice(i, 1)
    }
    // Follow a live sea-state change: propagation and damping are the
    // ripple's whole character and both move with the preset.
    this.material.uniforms.uPropagation.value = PROPAGATION
    this.material.uniforms.uDamping.value = SETTINGS.damping
    const inject = this.material.uniforms.uInject.value as THREE.Vector4[]
    for (let i = 0; i < MAX_INJECT; i++) {
      const p = pending.shift()
      if (p) inject[i].set(p.x, p.z, p.radius, p.strength)
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

/**
 * Water-shader side: sample the field and displace. Pure smooth
 * displacement — no seethe, no whiteness; rings are rings. Splash boil,
 * when something wants one, is separate machinery (froth.ts).
 */
/** Display gain in force right now — a uniform, so it can change live. */
export const rippleDisplayGain = () => SETTINGS.displayGain

export function ripplesGlsl(): string {
  return `
uniform sampler2D uRippleTex;
uniform vec2 uRippleCenter;
uniform float uRippleExtent;
uniform float uRippleGain;

void applyRipples(inout vec3 p, vec2 worldXZ) {
	vec2 ruv = (worldXZ - uRippleCenter) / uRippleExtent + 0.5;
	if (ruv.x <= 0.0 || ruv.x >= 1.0 || ruv.y <= 0.0 || ruv.y >= 1.0) return;
	p.y += texture2D(uRippleTex, ruv).x * uRippleGain;
}

// The DISPLAYED ripple surface's gradient (the sim bakes the physical
// gradient into zw; display gain scales height and slope alike). This is
// what lets ripples SHADE at texture resolution regardless of how coarse
// the water mesh is: the fragment adds these slopes onto the interpolated
// analytic wave normal.
// The DISPLAYED ripple height. Crest detection wants the height itself,
// not the gradient: a gradient peaks on the FLANKS, so keying foam to it
// paints the whole disturbed patch — including the water between a wake's
// arms — while the crest lines it should be tracing get a dead seam
// along the ridge where the slope passes through zero.
float rippleHeightAt(vec2 worldXZ) {
	vec2 ruv = (worldXZ - uRippleCenter) / uRippleExtent + 0.5;
	if (ruv.x <= 0.0 || ruv.x >= 1.0 || ruv.y <= 0.0 || ruv.y >= 1.0) return 0.0;
	return texture2D(uRippleTex, ruv).x * uRippleGain;
}

// The surface's VERTICAL RATE, metres per second, display-scaled.
//
// The sim integrates h += v each step, so the stored v is metres per
// STEP; x60 puts it in m/s so a threshold reads as a speed rather than
// as an artefact of the step rate.
//
// Signed on purpose. Rising water is a crest arriving, falling water is
// one leaving, and the peak itself passes through zero — so a positive
// threshold marks the ADVANCING face of each crest and nothing else,
// which is one line per crest instead of the two that |v| would give.
float rippleVelocityAt(vec2 worldXZ) {
	vec2 ruv = (worldXZ - uRippleCenter) / uRippleExtent + 0.5;
	if (ruv.x <= 0.0 || ruv.x >= 1.0 || ruv.y <= 0.0 || ruv.y >= 1.0) return 0.0;
	return texture2D(uRippleTex, ruv).y * uRippleGain * 60.0;
}

// NEGATIVE Laplacian of the ripple surface, 1/m: how tightly the water
// is curving, signed so that CRESTS are positive.
//
// div(grad) is zero on a flat surface and on a uniform slope, so unlike
// height or rate this measures the shape itself — a sharp little crest
// and a broad tall one read differently even at the same height, which
// is what makes it a size-independent way to find ridges.
//
// The sign does the trough gate for free: water curving downward (a
// crest) is positive here, water curving upward (a trough) negative, so
// any positive threshold excludes troughs without a second test.
//
// Four taps, on the gradient the sim already baked into zw — cheaper and
// smoother than differencing the height field twice.
float rippleCurvatureAt(vec2 worldXZ) {
	vec2 ruv = (worldXZ - uRippleCenter) / uRippleExtent + 0.5;
	if (ruv.x <= ${(2 / RIPPLE_RESOLUTION).toFixed(6)} || ruv.x >= ${(1 - 2 / RIPPLE_RESOLUTION).toFixed(6)} ||
		ruv.y <= ${(2 / RIPPLE_RESOLUTION).toFixed(6)} || ruv.y >= ${(1 - 2 / RIPPLE_RESOLUTION).toFixed(6)}) return 0.0;
	float e = ${(1 / RIPPLE_RESOLUTION).toFixed(6)};
	float gxr = texture2D(uRippleTex, ruv + vec2(e, 0.0)).z;
	float gxl = texture2D(uRippleTex, ruv - vec2(e, 0.0)).z;
	float gzu = texture2D(uRippleTex, ruv + vec2(0.0, e)).w;
	float gzd = texture2D(uRippleTex, ruv - vec2(0.0, e)).w;
	float cell = uRippleExtent * e;
	float lap = ((gxr - gxl) + (gzu - gzd)) / (2.0 * cell);
	return -lap * uRippleGain;
}

vec2 rippleShadeGrad(vec2 worldXZ) {
	vec2 ruv = (worldXZ - uRippleCenter) / uRippleExtent + 0.5;
	if (ruv.x <= 0.0 || ruv.x >= 1.0 || ruv.y <= 0.0 || ruv.y >= 1.0) return vec2(0.0);
	return texture2D(uRippleTex, ruv).zw * uRippleGain;
}`
}

/**
 * The ripple field's contribution to caustics: the finite-difference
 * Hessian of the interactive heightfield, added into the same curvature
 * accumulator as the ambient waves. This is what makes buoy rings, wakes
 * and splashes bend light on the floor below, exactly like the pool
 * reference's drop rings. Uses the PHYSICAL field (no display gain).
 * Standalone uniforms: safe to include without ripplesGlsl().
 */
export function rippleCausticGlsl(): string {
  const texel = (1 / RIPPLE_RESOLUTION).toFixed(6)
  return `
uniform sampler2D uRippleCTex;
uniform vec2 uRippleCCenter;
uniform float uRippleCExtent;

// Gradient of the ripple field (central differences), for the refractive
// entry-point solve.
vec2 rippleGrad(vec2 worldXZ) {
	vec2 ruv = (worldXZ - uRippleCCenter) / uRippleCExtent + 0.5;
	if (ruv.x <= 0.02 || ruv.x >= 0.98 || ruv.y <= 0.02 || ruv.y >= 0.98) return vec2(0.0);
	float e = uRippleCExtent * ${texel};
	vec2 tx = vec2(${texel}, 0.0);
	vec2 ty = vec2(0.0, ${texel});
	return vec2(
		texture2D(uRippleCTex, ruv + tx).x - texture2D(uRippleCTex, ruv - tx).x,
		texture2D(uRippleCTex, ruv + ty).x - texture2D(uRippleCTex, ruv - ty).x
	) / (2.0 * e);
}

// Refraction makes caustic GEOMETRY depth-dependent: the surface point
// whose bent ray lands at your point is displaced by bend * grad(h),
// solved by fixed-point iteration (same trick as the CPU Gerstner
// sampler). Rings genuinely converge toward focus and invert past it,
// instead of projecting straight down unchanged at every depth.
vec2 refractedEntry(vec2 entry0, float bend) {
	vec2 s = entry0;
	for (int i = 0; i < 3; i++) {
		s = entry0 + bend * rippleGrad(s);
	}
	return s;
}

void rippleHessian(vec2 worldXZ, inout float hxx, inout float hzz, inout float hxz) {
	vec2 ruv = (worldXZ - uRippleCCenter) / uRippleCExtent + 0.5;
	if (ruv.x <= 0.02 || ruv.x >= 0.98 || ruv.y <= 0.02 || ruv.y >= 0.98) return;
	float e = uRippleCExtent * ${texel}; // texel size in meters
	vec2 tx = vec2(${texel}, 0.0);
	vec2 ty = vec2(0.0, ${texel});
	float hc = texture2D(uRippleCTex, ruv).x;
	float hr = texture2D(uRippleCTex, ruv + tx).x;
	float hl = texture2D(uRippleCTex, ruv - tx).x;
	float hu = texture2D(uRippleCTex, ruv + ty).x;
	float hd = texture2D(uRippleCTex, ruv - ty).x;
	float hru = texture2D(uRippleCTex, ruv + tx + ty).x;
	float hrd = texture2D(uRippleCTex, ruv + tx - ty).x;
	float hlu = texture2D(uRippleCTex, ruv - tx + ty).x;
	float hld = texture2D(uRippleCTex, ruv - tx - ty).x;
	float inv = 1.0 / (e * e);
	hxx += (hr + hl - 2.0 * hc) * inv;
	hzz += (hu + hd - 2.0 * hc) * inv;
	hxz += (hru - hrd - hlu + hld) * 0.25 * inv;
}`
}
