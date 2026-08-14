/**
 * MistField: mist as a 2D FLUID, not particles.
 *
 * A slim port of Pavel Dobryakov's WebGL-Fluid-Simulation (via the
 * threejs-fluid-simulation reference): a texture-space Eulerian solver —
 * velocity + dye fields on ping-pong targets, semi-Lagrangian advection,
 * vorticity confinement for the billowing curls, and a short Jacobi
 * pressure solve to keep the flow swirling instead of piling up. The
 * packaging follows FoamField: world-space XZ domain centered on the
 * view, CPU-queued splats consumed per step, stepped once per frame by
 * the Scene.
 *
 * Why a field over particles: mist density is CONTINUOUS by
 * construction — the wall-of-mist look needs no choreography, and
 * vorticity gives it real internal motion. The tradeoff (it's flat) is
 * fine under the game's fixed camera: the overlay plane rides the wave
 * heights, so the mist drapes over the swells.
 *
 * Injection: the loop-splash scan queues a dye + impulse splat per pink
 * site (spume), droplet landings queue small dye puffs. Wind is a gentle
 * relaxation force on the whole velocity field — dispersed mist gets
 * swept; fresh dense injections keep their own motion for a while.
 */

import * as THREE from 'three'
import { waves, wavesGlsl } from './waves'

/** Full domain width, meters, centered on the origin. */
export const MIST_EXTENT = 100

const SIM_RES = 128
const DYE_RES = 256
const PRESSURE_ITERS = 12
/** 1/s exponential dissipation. Dye ~2s visible life. */
const VEL_DISSIPATION = 0.4
const DYE_DISSIPATION = 0.55
/** Vorticity confinement strength (Dobryakov's "curl"). */
const VORTICITY = 14
/** Wind coupling: the ORIGINAL steady relaxation — the best-looking
 * baseline so far; its interplay with windVector's slow multi-sine
 * gustiness is what produced the organic sweeps. */
const WIND_CARRY = 0.45
const WIND_GRIP = 0.5
/**
 * Gusts, fourth iteration: DOWNSLOPE FLOW. Uniform forces translate
 * (iteration 2), random splats are diffused noise (iteration 1), a
 * moving jet front read as engineered translation (iteration 3). This
 * one takes its spatial structure from the WAVES themselves: during a
 * gust, every texel is pushed along the surface's downhill gradient,
 * masked to the BACK faces (downhill pointing against the travel
 * direction) — air spilling down the back of each swell. The forcing
 * pattern moves with the waves and shears against the crest-borne dye;
 * vorticity confinement is raised while the gust blows, so that shear
 * rolls up into heavy swirls. All structure is the sea's own.
 */
/** Peak downslope acceleration on steep backs, m/s^2 (x slope). */
const GUST_SLIDE = 50
/** Vorticity multiplier at gust peak (heavy swirling). */
const GUST_SWIRL = 0.9
/** Seconds between gusts (uniform range) and gust length. */
const GUST_GAP_MIN = 6
const GUST_GAP_VAR = 10
const GUST_DUR_MIN = 1.2
const GUST_DUR_VAR = 2.0
const MAX_SPLATS = 8

type MistSplat = {
  x: number
  z: number
  amount: number
  vx: number
  vz: number
  r: number
}
const pending: MistSplat[] = []

/** Queue a mist injection: dye amount plus a velocity impulse, gaussian
 * radius r meters. New splats win when the queue backs up. */
export function queueMistSplat(
  x: number,
  z: number,
  amount: number,
  vx: number,
  vz: number,
  r: number,
) {
  if (pending.length >= 256) pending.shift()
  pending.push({ x, z, amount, vx, vz, r })
}

const quadVertex = `
varying vec2 vUv;
void main() {
	vUv = uv;
	gl_Position = vec4(position.xy, 0.0, 1.0);
}`

const splatGlsl = `
uniform vec4 uSplatPos[${MAX_SPLATS}]; // x, z, radius, dyeAmount
uniform vec2 uSplatVel[${MAX_SPLATS}];
vec2 uvToWorld(vec2 uv) { return (uv - 0.5) * ${MIST_EXTENT.toFixed(1)}; }
`

// Semi-Lagrangian advection of velocity + dissipation + wind relaxation
// + impulse splats, all in one pass.
const advectVelFragment = `
uniform sampler2D uVel;
uniform float uDt;
uniform float uDissipation; // precomputed exp(-k dt)
uniform vec2 uWind;         // carry x wind, m/s
uniform float uWindK;       // grip x dt, clamped
uniform float uTime;
uniform float uAmpScale;
uniform float uGust;   // gust envelope 0..1
uniform vec2 uTravel;  // dominant wave travel direction, unit
${wavesGlsl()}
${splatGlsl}
varying vec2 vUv;

// Analytic gradient (d height / d xz) of the Gerstner height sum.
vec2 waveGrad(vec2 p, float t, float ampScale) {
	vec2 g = vec2(0.0);
	for (int i = 0; i < WAVE_COUNT; i++) {
		vec4 a = uWaveA[i];
		vec3 b = uWaveB[i];
		float theta = (p.x * a.x + p.y * a.y) * a.z - a.w * t + b.z;
		g += vec2(a.x, a.y) * (b.x * ampScale * a.z * cos(theta));
	}
	return g;
}

void main() {
	vec2 vel = texture2D(uVel, vUv).xy;
	vec2 uvBack = vUv - vel * uDt / ${MIST_EXTENT.toFixed(1)};
	vec2 v = texture2D(uVel, uvBack).xy * uDissipation;
	v += (uWind - v) * uWindK;
	vec2 world = uvToWorld(vUv);
	// Gust: air spilling DOWN THE BACK of each swell. Downhill force,
	// masked to faces where downhill opposes the travel direction.
	if (uGust > 0.001) {
		vec2 downhill = -waveGrad(world, uTime, uAmpScale);
		float back = clamp(-dot(normalize(downhill + vec2(0.00001)), uTravel) * 3.0, 0.0, 1.0);
		v += downhill * (${GUST_SLIDE.toFixed(1)} * uGust * back) * uDt;
	}
	for (int i = 0; i < ${MAX_SPLATS}; i++) {
		vec4 sp = uSplatPos[i];
		vec2 d = world - sp.xy;
		// BLEND toward the splat velocity, never accumulate. Additive
		// impulses suit Dobryakov's mouse drags, but the crest injectors
		// fire EVERY FRAME: adding ~8 m/s of loop velocity 60 times a
		// second built an unbounded velocity field that blew the mist
		// apart after a few seconds. A saturating blend gives the same
		// "dye rides the crest" behaviour with a fixed ceiling.
		float w = exp(-dot(d, d) / (sp.z * sp.z));
		v = mix(v, uSplatVel[i], min(w, 1.0));
	}
	// Safety net: nothing here should ever exceed a gale.
	float spd = length(v);
	if (spd > 25.0) v *= 25.0 / spd;
	gl_FragColor = vec4(v, 0.0, 1.0);
}`

const advectDyeFragment = `
uniform sampler2D uVel;
uniform sampler2D uDye;
uniform float uDt;
uniform float uDissipation;
${splatGlsl}
varying vec2 vUv;
void main() {
	vec2 vel = texture2D(uVel, vUv).xy;
	vec2 uvBack = vUv - vel * uDt / ${MIST_EXTENT.toFixed(1)};
	float dye = texture2D(uDye, uvBack).r * uDissipation;
	vec2 world = uvToWorld(vUv);
	for (int i = 0; i < ${MAX_SPLATS}; i++) {
		vec4 sp = uSplatPos[i];
		vec2 d = world - sp.xy;
		dye += sp.w * exp(-dot(d, d) / (sp.z * sp.z));
	}
	gl_FragColor = vec4(dye, 0.0, 0.0, 1.0);
}`

const curlFragment = `
uniform sampler2D uVel;
uniform float uTexel;
varying vec2 vUv;
void main() {
	float L = texture2D(uVel, vUv - vec2(uTexel, 0.0)).y;
	float R = texture2D(uVel, vUv + vec2(uTexel, 0.0)).y;
	float B = texture2D(uVel, vUv - vec2(0.0, uTexel)).x;
	float T = texture2D(uVel, vUv + vec2(0.0, uTexel)).x;
	gl_FragColor = vec4(R - L - T + B, 0.0, 0.0, 1.0);
}`

const vorticityFragment = `
uniform sampler2D uVel;
uniform sampler2D uCurl;
uniform float uTexel;
uniform float uCurlStrength;
uniform float uDt;
varying vec2 vUv;
void main() {
	float L = texture2D(uCurl, vUv - vec2(uTexel, 0.0)).r;
	float R = texture2D(uCurl, vUv + vec2(uTexel, 0.0)).r;
	float B = texture2D(uCurl, vUv - vec2(0.0, uTexel)).r;
	float T = texture2D(uCurl, vUv + vec2(0.0, uTexel)).r;
	float C = texture2D(uCurl, vUv).r;
	vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
	force /= length(force) + 0.0001;
	force *= uCurlStrength * C;
	force.y *= -1.0;
	vec2 vel = texture2D(uVel, vUv).xy;
	gl_FragColor = vec4(vel + force * uDt, 0.0, 1.0);
}`

const divergenceFragment = `
uniform sampler2D uVel;
uniform float uTexel;
varying vec2 vUv;
void main() {
	float L = texture2D(uVel, vUv - vec2(uTexel, 0.0)).x;
	float R = texture2D(uVel, vUv + vec2(uTexel, 0.0)).x;
	float B = texture2D(uVel, vUv - vec2(0.0, uTexel)).y;
	float T = texture2D(uVel, vUv + vec2(0.0, uTexel)).y;
	gl_FragColor = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0);
}`

const jacobiFragment = `
uniform sampler2D uPressure;
uniform sampler2D uDivergence;
uniform float uTexel;
varying vec2 vUv;
void main() {
	float L = texture2D(uPressure, vUv - vec2(uTexel, 0.0)).r;
	float R = texture2D(uPressure, vUv + vec2(uTexel, 0.0)).r;
	float B = texture2D(uPressure, vUv - vec2(0.0, uTexel)).r;
	float T = texture2D(uPressure, vUv + vec2(0.0, uTexel)).r;
	float div = texture2D(uDivergence, vUv).r;
	gl_FragColor = vec4((L + R + B + T - div) * 0.25, 0.0, 0.0, 1.0);
}`

const gradientFragment = `
uniform sampler2D uPressure;
uniform sampler2D uVel;
uniform float uTexel;
varying vec2 vUv;
void main() {
	float L = texture2D(uPressure, vUv - vec2(uTexel, 0.0)).r;
	float R = texture2D(uPressure, vUv + vec2(uTexel, 0.0)).r;
	float B = texture2D(uPressure, vUv - vec2(0.0, uTexel)).r;
	float T = texture2D(uPressure, vUv + vec2(0.0, uTexel)).r;
	vec2 vel = texture2D(uVel, vUv).xy;
	gl_FragColor = vec4(vel - 0.5 * vec2(R - L, T - B), 0.0, 1.0);
}`

function makeTarget(res: number, format: THREE.PixelFormat) {
  return new THREE.WebGLRenderTarget(res, res, {
    type: THREE.HalfFloatType,
    format,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
  })
}

function makeMaterial(
  fragment: string,
  uniforms: Record<string, THREE.IUniform>,
) {
  return new THREE.ShaderMaterial({
    vertexShader: quadVertex,
    fragmentShader: fragment,
    uniforms,
    depthTest: false,
    depthWrite: false,
  })
}

export class MistField {
  private vel: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget]
  private dye: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget]
  private pressure: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget]
  private curlT: THREE.WebGLRenderTarget
  private divT: THREE.WebGLRenderTarget
  private velIdx = 0
  private dyeIdx = 0
  private pIdx = 0

  private scene: THREE.Scene
  private camera: THREE.OrthographicCamera
  private quad: THREE.Mesh

  // Gust state machine: countdown to next gust, progress through the
  // active one (-1 = inactive), and its duration.
  private gustWait = GUST_GAP_MIN + Math.random() * GUST_GAP_VAR
  private gustT = -1
  private gustDur = 0

  private splatPos: THREE.Vector4[]
  private splatVel: THREE.Vector2[]

  private advectVelMat: THREE.ShaderMaterial
  private advectDyeMat: THREE.ShaderMaterial
  private curlMat: THREE.ShaderMaterial
  private vortMat: THREE.ShaderMaterial
  private divMat: THREE.ShaderMaterial
  private jacobiMat: THREE.ShaderMaterial
  private gradMat: THREE.ShaderMaterial

  constructor() {
    this.vel = [
      makeTarget(SIM_RES, THREE.RGFormat),
      makeTarget(SIM_RES, THREE.RGFormat),
    ]
    this.dye = [
      makeTarget(DYE_RES, THREE.RedFormat),
      makeTarget(DYE_RES, THREE.RedFormat),
    ]
    this.pressure = [
      makeTarget(SIM_RES, THREE.RedFormat),
      makeTarget(SIM_RES, THREE.RedFormat),
    ]
    this.curlT = makeTarget(SIM_RES, THREE.RedFormat)
    this.divT = makeTarget(SIM_RES, THREE.RedFormat)

    this.splatPos = Array.from(
      { length: MAX_SPLATS },
      () => new THREE.Vector4(0, 0, 1, 0),
    )
    this.splatVel = Array.from(
      { length: MAX_SPLATS },
      () => new THREE.Vector2(),
    )
    const texel = 1 / SIM_RES

    const dom = waves.reduce((a, b) => (b.amp > a.amp ? b : a), waves[0])
    this.advectVelMat = makeMaterial(advectVelFragment, {
      uVel: { value: null },
      uDt: { value: 0.016 },
      uDissipation: { value: 1 },
      uWind: { value: new THREE.Vector2() },
      uWindK: { value: 0 },
      uTime: { value: 0 },
      uAmpScale: { value: 1 },
      uGust: { value: 0 },
      uTravel: { value: new THREE.Vector2(dom.dirX, dom.dirZ) },
      uWaveA: {
        value: waves.map(
          (w) => new THREE.Vector4(w.dirX, w.dirZ, w.k, w.omega),
        ),
      },
      uWaveB: {
        value: waves.map((w) => new THREE.Vector3(w.amp, w.q, w.phase)),
      },
      uSplatPos: { value: this.splatPos },
      uSplatVel: { value: this.splatVel },
    })
    this.advectDyeMat = makeMaterial(advectDyeFragment, {
      uVel: { value: null },
      uDye: { value: null },
      uDt: { value: 0.016 },
      uDissipation: { value: 1 },
      uSplatPos: { value: this.splatPos },
      uSplatVel: { value: this.splatVel },
    })
    this.curlMat = makeMaterial(curlFragment, {
      uVel: { value: null },
      uTexel: { value: texel },
    })
    this.vortMat = makeMaterial(vorticityFragment, {
      uVel: { value: null },
      uCurl: { value: this.curlT.texture },
      uTexel: { value: texel },
      uCurlStrength: { value: VORTICITY },
      uDt: { value: 0.016 },
    })
    this.divMat = makeMaterial(divergenceFragment, {
      uVel: { value: null },
      uTexel: { value: texel },
    })
    this.jacobiMat = makeMaterial(jacobiFragment, {
      uPressure: { value: null },
      uDivergence: { value: this.divT.texture },
      uTexel: { value: texel },
    })
    this.gradMat = makeMaterial(gradientFragment, {
      uPressure: { value: null },
      uVel: { value: null },
      uTexel: { value: texel },
    })

    this.scene = new THREE.Scene()
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.advectVelMat)
    this.scene.add(this.quad)
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  }

  get texture(): THREE.Texture {
    return this.dye[this.dyeIdx].texture
  }


  private pass(
    renderer: THREE.WebGLRenderer,
    material: THREE.ShaderMaterial,
    target: THREE.WebGLRenderTarget,
  ) {
    this.quad.material = material
    renderer.setRenderTarget(target)
    renderer.render(this.scene, this.camera)
  }

  step(
    renderer: THREE.WebGLRenderer,
    windX: number,
    windZ: number,
    t: number,
    ampScale: number,
    dt: number,
  ) {
    const d = Math.min(Math.max(dt, 0.001), 0.05)
    const previous = renderer.getRenderTarget()

    // Advance the gust state machine and get the envelope (0 = calm):
    // fast attack (the sweep arrives), slow release (it passes).
    let gust = 0
    if (this.gustT < 0) {
      this.gustWait -= d
      if (this.gustWait <= 0) {
        this.gustT = 0
        this.gustDur = GUST_DUR_MIN + Math.random() * GUST_DUR_VAR
        this.gustWait = GUST_GAP_MIN + Math.random() * GUST_GAP_VAR
      }
    } else {
      this.gustT += d
      if (this.gustT >= this.gustDur) this.gustT = -1
      else {
        const u = this.gustT / this.gustDur
        gust = Math.min(u / 0.18, 1) * (1 - Math.max((u - 0.45) / 0.55, 0))
      }
    }

    // Consume queued splats into the shared uniform arrays.
    for (let i = 0; i < MAX_SPLATS; i++) {
      const sp = pending.shift()
      if (sp) {
        this.splatPos[i].set(sp.x, sp.z, sp.r, sp.amount)
        this.splatVel[i].set(sp.vx, sp.vz)
      } else {
        this.splatPos[i].set(0, 0, 1, 0)
        this.splatVel[i].set(0, 0)
      }
    }

    // 1. Advect velocity (+ dissipation + wind + impulse splats).
    const velA = this.vel[this.velIdx]
    const velB = this.vel[1 - this.velIdx]
    this.advectVelMat.uniforms.uVel.value = velA.texture
    this.advectVelMat.uniforms.uDt.value = d
    this.advectVelMat.uniforms.uDissipation.value = Math.exp(
      -VEL_DISSIPATION * d,
    )
    this.advectVelMat.uniforms.uTime.value = t
    this.advectVelMat.uniforms.uAmpScale.value = ampScale
    this.advectVelMat.uniforms.uGust.value = gust
    // Heavy swirling while the gust blows: the downslope shear gets
    // rolled up harder by a raised confinement strength.
    this.vortMat.uniforms.uCurlStrength.value =
      VORTICITY * (1 + (GUST_SWIRL - 1) * gust)
    // The steady lean is uniform; the gust force is per-texel downslope
    // flow inside the advect shader.
    ;(this.advectVelMat.uniforms.uWind.value as THREE.Vector2).set(
      windX * WIND_CARRY,
      windZ * WIND_CARRY,
    )
    this.advectVelMat.uniforms.uWindK.value = Math.min(WIND_GRIP * d, 1)
    this.pass(renderer, this.advectVelMat, velB)
    this.velIdx = 1 - this.velIdx

    // 2. Curl, 3. vorticity confinement.
    const vel2 = this.vel[this.velIdx]
    this.curlMat.uniforms.uVel.value = vel2.texture
    this.pass(renderer, this.curlMat, this.curlT)
    this.vortMat.uniforms.uVel.value = vel2.texture
    this.vortMat.uniforms.uDt.value = d
    this.pass(renderer, this.vortMat, this.vel[1 - this.velIdx])
    this.velIdx = 1 - this.velIdx

    // 4. Divergence, 5. pressure Jacobi, 6. gradient subtract.
    const vel3 = this.vel[this.velIdx]
    this.divMat.uniforms.uVel.value = vel3.texture
    this.pass(renderer, this.divMat, this.divT)
    for (let i = 0; i < PRESSURE_ITERS; i++) {
      this.jacobiMat.uniforms.uPressure.value = this.pressure[this.pIdx].texture
      this.pass(renderer, this.jacobiMat, this.pressure[1 - this.pIdx])
      this.pIdx = 1 - this.pIdx
    }
    this.gradMat.uniforms.uPressure.value = this.pressure[this.pIdx].texture
    this.gradMat.uniforms.uVel.value = vel3.texture
    this.pass(renderer, this.gradMat, this.vel[1 - this.velIdx])
    this.velIdx = 1 - this.velIdx

    // 7. Advect dye (+ dissipation + dye splats).
    const dyeA = this.dye[this.dyeIdx]
    this.advectDyeMat.uniforms.uVel.value = this.vel[this.velIdx].texture
    this.advectDyeMat.uniforms.uDye.value = dyeA.texture
    this.advectDyeMat.uniforms.uDt.value = d
    this.advectDyeMat.uniforms.uDissipation.value = Math.exp(
      -DYE_DISSIPATION * d,
    )
    this.pass(renderer, this.advectDyeMat, this.dye[1 - this.dyeIdx])
    this.dyeIdx = 1 - this.dyeIdx

    renderer.setRenderTarget(previous)
  }

  dispose() {
    for (const t of [
      ...this.vel,
      ...this.dye,
      ...this.pressure,
      this.curlT,
      this.divT,
    ])
      t.dispose()
    for (const m of [
      this.advectVelMat,
      this.advectDyeMat,
      this.curlMat,
      this.vortMat,
      this.divMat,
      this.jacobiMat,
      this.gradMat,
    ])
      m.dispose()
    ;(this.quad.geometry as THREE.BufferGeometry).dispose()
  }
}
