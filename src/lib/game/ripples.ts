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
import { activeField } from './waves'

export const RIPPLE_RESOLUTION = 1024
/** Meters of world covered by the domain; cell = extent / resolution. */
export const RIPPLE_EXTENT = 300

/**
 * Calm-water defaults; sea presets override via their `ripples` block (see
 * WaveFieldConfig in waves.ts). displayGain scales the DISPLAY of the field
 * without touching the simulation: the raw physics lives in honest meters
 * (a hard splash ring is ~5-15cm, real but invisible at 26px/m). churn
 * renders LIFTED ripple water as crest-style seethe: calm water makes clean
 * rings, choppy water tears them into agitation.
 */
const SETTINGS = {
  displayGain: 3.5,
  churn: 0,
  propagation: 0.04,
  damping: 0.9955,
  ...activeField.ripples,
}
/** Seethe displacement for churned lifted water, meters. */
const LIFT_SEETHE_AMPLITUDE = 0.26

/** Gaussian pokes applied per sim step. */
const MAX_INJECT = 8

type Injection = { x: number; z: number; radius: number; strength: number }
const pending: Injection[] = []

/**
 * Disturb the water at world (x, z): a displacement "hat" of `strength`
 * meters (down at center, crown around), which the wave equation evolves.
 * For the non-propagating burst of splash churn, see froth.ts.
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
        uPropagation: { value: SETTINGS.propagation },
        uDamping: { value: SETTINGS.damping },
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
 * Water-shader side: sample the field, displace, and churn only LIFTED
 * displaced water (churn-gated per sea); craters and troughs stay smooth.
 * Splash bursts are froth.ts, not here.
 */
export function ripplesGlsl(): string {
  return `
uniform sampler2D uRippleTex;
uniform vec2 uRippleCenter;
uniform float uRippleExtent;

float applyRipples(inout vec3 p, vec2 worldXZ, float t) {
	vec2 ruv = (worldXZ - uRippleCenter) / uRippleExtent + 0.5;
	if (ruv.x <= 0.0 || ruv.x >= 1.0 || ruv.y <= 0.0 || ruv.y >= 1.0) return 0.0;
	vec2 hv = texture2D(uRippleTex, ruv).xy;
	p.y += hv.x * ${SETTINGS.displayGain.toFixed(2)};
	float seethe = ${SETTINGS.churn.toFixed(2)} * clamp(max(hv.x, 0.0) * 10.0, 0.0, 1.0);
	if (seethe > 0.003) {
		float n1 = sin(worldXZ.x * 23.0 + t * 29.0) * sin(worldXZ.y * 17.0 - t * 25.0);
		float n2 = sin(worldXZ.x * 9.5 - t * 31.0 + 1.7) * sin(worldXZ.y * 13.5 + t * 21.0);
		p += vec3(n1 * 0.55, 0.45 + abs(n2), n2 * 0.55) * (${LIFT_SEETHE_AMPLITUDE.toFixed(2)} * seethe);
	}
	return seethe;
}`
}
