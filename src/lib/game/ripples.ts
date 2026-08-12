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
 * Objects interact by INJECTING gaussian pokes (injectRipple). Splash
 * rings, bow wakes, churn puddles, interference and everything else emerge
 * from propagation; nothing is choreographed.
 *
 * The water vertex shader samples the field (ripplesGlsl) and adds it to
 * the surface, deriving whiteness from local wave energy.
 *
 * Not CPU-twinned: ripples are centimeters and decorative; floaters ride
 * the ambient surface. The domain is world-anchored at uCenter (origin for
 * now; will follow the boat) and absorbs at its edges so ripples leaving
 * the area die instead of reflecting off an invisible wall.
 */

import * as THREE from 'three'

export const RIPPLE_RESOLUTION = 256
/** Meters of world covered by the domain; cell = extent / resolution. */
export const RIPPLE_EXTENT = 80
/** Wave-equation step scale. Higher = faster ripples; keep under ~0.5. */
const PROPAGATION = 0.14
/** Per-step energy retention. Closer to 1 = ripples ring longer. */
const DAMPING = 0.9955
/**
 * Visual amplification of the field where the water mesh samples it. The
 * raw physics lives in honest meters (a hard splash ring is ~5-15cm, real
 * but invisible at 26px/m); this scales the DISPLAY without touching the
 * simulation, so propagation stays physical.
 */
const DISPLAY_GAIN = 3.5
/** Gaussian pokes applied per sim step. */
const MAX_INJECT = 8

type Injection = { x: number; z: number; radius: number; strength: number }
const pending: Injection[] = []

/**
 * Poke the water at world (x, z): a gaussian push of `strength` meters over
 * `radius` meters. The wave equation turns it into an expanding ring.
 */
export function injectRipple(
  x: number,
  z: number,
  radius: number,
  strength: number,
) {
  if (pending.length < 64 && strength !== 0)
    pending.push({ x, z, radius, strength })
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
uniform float uExtent;
uniform vec4 uInject[${MAX_INJECT}]; // worldX, worldZ, radius, strength
varying vec2 vUv;

void main() {
	vec2 hv = texture2D(uPrev, vUv).xy;
	float sum =
		texture2D(uPrev, vUv + vec2(uTexel, 0.0)).x +
		texture2D(uPrev, vUv - vec2(uTexel, 0.0)).x +
		texture2D(uPrev, vUv + vec2(0.0, uTexel)).x +
		texture2D(uPrev, vUv - vec2(0.0, uTexel)).x;
	float v = hv.y + (sum * 0.25 - hv.x) * uPropagation;
	v *= uDamping;
	float h = hv.x + v;

	vec2 world = (vUv - 0.5) * uExtent + uCenter;
	for (int i = 0; i < ${MAX_INJECT}; i++) {
		vec4 inj = uInject[i];
		if (inj.w == 0.0) continue;
		vec2 d = world - inj.xy;
		h -= inj.w * exp(-dot(d, d) / (2.0 * inj.z * inj.z));
	}

	// Absorb near the domain boundary so ripples die instead of reflecting.
	float edge =
		smoothstep(0.0, 0.08, vUv.x) * smoothstep(0.0, 0.08, 1.0 - vUv.x) *
		smoothstep(0.0, 0.08, vUv.y) * smoothstep(0.0, 0.08, 1.0 - vUv.y);
	h *= mix(0.9, 1.0, edge);
	v *= mix(0.9, 1.0, edge);

	gl_FragColor = vec4(h, v, 0.0, 1.0);
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
        uDamping: { value: DAMPING },
        uCenter: { value: new THREE.Vector2(0, 0) },
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
  step(renderer: THREE.WebGLRenderer) {
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
 * Water-shader side: sample the field, displace, and derive whiteness from
 * local wave energy (fast-moving or tall ripple water is aerated).
 */
export function ripplesGlsl(): string {
  return `
uniform sampler2D uRippleTex;
uniform vec2 uRippleCenter;
uniform float uRippleExtent;

float applyRipples(inout vec3 p, vec2 worldXZ) {
	vec2 ruv = (worldXZ - uRippleCenter) / uRippleExtent + 0.5;
	if (ruv.x <= 0.0 || ruv.x >= 1.0 || ruv.y <= 0.0 || ruv.y >= 1.0) return 0.0;
	vec2 hv = texture2D(uRippleTex, ruv).xy;
	p.y += hv.x * ${DISPLAY_GAIN.toFixed(2)};
	return clamp(abs(hv.y) * 26.0 + max(abs(hv.x) - 0.04, 0.0) * 5.0, 0.0, 1.0);
}`
}
