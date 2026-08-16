/**
 * FFT DETAIL WAVES — the fine surface texture, as a real wave spectrum.
 *
 * The small waves used to be a sum of a dozen or so sinusoids evaluated
 * per pixel. That is quasi-periodic by construction: a small set beats
 * against itself on a fixed lattice and reads as a pattern however hard
 * the wavelengths, phases and directions are jittered. Detuning helps,
 * domain warping actively hurts (the warp's own wavelength becomes the
 * visible feature), and raising the count only pushes the repeat out.
 *
 * An inverse FFT of a random-phase spectrum fixes it in kind rather than
 * degree: a 128x128 transform carries sixteen thousand components for
 * one texture fetch, and random phases over a Phillips spectrum give the
 * Gaussian surface statistics a real sea has.
 *
 * WHY IT IS SAFE TO ADD HERE, when converting the main spectrum would
 * not be: this layer feeds the SHADING NORMAL and nothing else. No
 * buoyancy, no droplets, no Jacobian, no CPU twin to keep in step — the
 * recurring hazard in this codebase is the wave sum existing in five
 * hand-written copies, and this adds none. It is also exactly what an
 * FFT is best at: transform i*k*h and the SLOPE comes out directly, with
 * no derivative to take or maintain.
 *
 * TILING is the one real cost. An FFT patch repeats at its own size, and
 * the viewport spans 40-70m of water, so a single patch would visibly
 * repeat two or three times on screen — a worse artefact than the one
 * being fixed. Two cascades at deliberately non-commensurate sizes are
 * summed instead; their combined period is their least common multiple,
 * which is far larger than anything on screen.
 */

import * as THREE from 'three'
import { activeField } from './waves'

/** Transform size. 128 gives ~16k components per cascade. */
const N = 128
const STAGES = Math.log2(N)
const G = 9.81

/**
 * Patch sizes, metres. Deliberately NOT round multiples of each other:
 * two cascades whose sizes share a factor repeat together at that
 * factor, which throws away most of the benefit of having two.
 */
const CASCADES = [41.3, 6.7]

/**
 * Shortest wavelength a cascade will carry, in texels.
 *
 * The water shader fetches this field with bilinear filtering, so a wave
 * only three texels long is reconstructed as three straight ramps — the
 * same faceting that made the object wave read as low-poly, and the Nyquist
 * limit of 2 is nowhere near enough to avoid it. Four is the point where
 * the interpolation stops being the dominant shape, and it is what sets the
 * crossover between the two cascades below.
 */
const MIN_TEXELS = 4

/** Deterministic RNG, matching waves.ts so a seed reproduces a sea. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Box-Muller: the spectrum wants Gaussian amplitudes, not uniform. */
function gauss(rand: () => number): [number, number] {
  const u = Math.max(rand(), 1e-6)
  const v = rand()
  const r = Math.sqrt(-2 * Math.log(u))
  return [r * Math.cos(2 * Math.PI * v), r * Math.sin(2 * Math.PI * v)]
}

/**
 * The butterfly lookup: one row per stage, one column per index, giving
 * the twiddle factor and the two input indices for that butterfly.
 *
 * Precomputing it is what keeps the per-stage shader trivial — it does a
 * fetch, a complex multiply and an add, with no index arithmetic and no
 * bit reversal at runtime. Stage 0 reads bit-reversed, which is folded
 * into the table rather than computed per pixel.
 */
function butterflyData() {
  const rev = new Int32Array(N)
  for (let i = 0; i < N; i++) {
    let r = 0
    for (let b = 0; b < STAGES; b++) if (i & (1 << b)) r |= 1 << (STAGES - 1 - b)
    rev[i] = r
  }
  const data = new Float32Array(STAGES * N * 4)
  for (let s = 0; s < STAGES; s++) {
    for (let i = 0; i < N; i++) {
      const span = 1 << s
      const kk = (i * (N / (span * 2))) % N
      // +i convention: this is the INVERSE transform.
      const ang = (2 * Math.PI * kk) / N
      const topWing = i % (span * 2) < span
      let a: number
      let b: number
      if (s === 0) {
        a = topWing ? rev[i] : rev[i - 1]
        b = topWing ? rev[i + 1] : rev[i]
      } else {
        a = topWing ? i : i - span
        b = topWing ? i + span : i
      }
      const o = (s * N + i) * 4
      data[o] = Math.cos(ang)
      data[o + 1] = Math.sin(ang)
      data[o + 2] = a
      data[o + 3] = b
    }
  }
  return data
}

/**
 * Initial spectrum h0(k) for one cascade, plus conj(h0(-k)), packed into
 * one RGBA texel so the evolution pass needs a single fetch.
 *
 * Phillips, band-limited to this cascade: each patch only carries the
 * wavelengths between its own Nyquist and the next cascade up, or the
 * two would both contain the same mid frequencies and double them.
 */
function spectrumData(patch: number, minL: number, maxL: number, seed: number) {
  const rand = mulberry32(seed)
  const data = new Float32Array(N * N * 4)
  // Accumulated mean-square slope of the field this spectrum will produce,
  // so the caller can normalise. Worth doing on the CPU rather than leaving
  // it to a hand-tuned gain: it makes the preset's `slope` mean the same
  // physical thing here as it did for the sinusoid sum (RMS surface slope),
  // and keeps it stable if the band limits or patch sizes are retuned.
  let msSlope = 0
  const wind = activeField.windAngle
  const wx = Math.cos(wind)
  const wz = Math.sin(wind)
  const windSpeed = activeField.windSpeed ?? 5
  const bigL = (windSpeed * windSpeed) / G
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const n = x - N / 2
      const m = y - N / 2
      const kx = (2 * Math.PI * n) / patch
      const kz = (2 * Math.PI * m) / patch
      const klen = Math.hypot(kx, kz)
      const o = (y * N + x) * 4
      const lambda = klen > 1e-6 ? (2 * Math.PI) / klen : Infinity
      if (klen < 1e-6 || lambda < minL || lambda > maxL) {
        data[o] = data[o + 1] = data[o + 2] = data[o + 3] = 0
        continue
      }
      const kdotw = (kx * wx + kz * wz) / klen
      // Phillips, with the short-wave suppression term that keeps the
      // very smallest components from dominating the slope.
      let ph =
        (Math.exp(-1 / (klen * bigL * (klen * bigL))) / Math.pow(klen, 4)) *
        kdotw *
        kdotw
      ph *= Math.exp(-klen * klen * 0.004)
      const amp = Math.sqrt(Math.max(ph, 0) / 2)
      const [g1, g2] = gauss(rand)
      const [g3, g4] = gauss(rand)
      data[o] = g1 * amp
      data[o + 1] = g2 * amp
      // conj(h0(-k)): the reality condition. Without it the inverse
      // transform comes out complex and the surface is not a height.
      data[o + 2] = g3 * amp
      data[o + 3] = -g4 * amp
      // The spatial field is f(x) = sum_k F(k) e^{ikx} with independent
      // random phases, so its variance is just the sum of |F(k)|^2. The
      // time-varying h(k,t) has mean square |h0|^2 + |conj(h0(-k))|^2, and
      // the slope spectrum multiplies that by kx^2 (or kz^2); average the
      // two components since both share one gain.
      const msH = (g1 * g1 + g2 * g2 + g3 * g3 + g4 * g4) * amp * amp
      msSlope += ((kx * kx + kz * kz) / 2) * msH
    }
  }
  return { data, rms: Math.sqrt(msSlope) }
}

const quadGeom = new THREE.PlaneGeometry(2, 2)

const passVertex = `
void main() {
	gl_Position = vec4(position.xy, 0.0, 1.0);
}`

/**
 * Evolve h0 to time t and emit the SLOPE spectrum.
 *
 * Two real fields ride in one complex transform: slope-x goes in the
 * real part and slope-z in the imaginary part, so a single inverse FFT
 * returns both. That halves the work, and is only valid because both
 * are real-valued fields.
 */
const spectrumFragment = `
precision highp float;
uniform sampler2D uH0;
uniform float uTime;
uniform float uPatch;
void main() {
	vec2 px = gl_FragCoord.xy - 0.5;
	float n = px.x - ${(N / 2).toFixed(1)};
	float m = px.y - ${(N / 2).toFixed(1)};
	vec2 k = vec2(n, m) * (6.2831853 / uPatch);
	float klen = length(k);
	if (klen < 1e-6) { gl_FragColor = vec4(0.0); return; }
	vec4 h0 = texture2D(uH0, (px + 0.5) / ${N.toFixed(1)});
	// timeScale is baked here for the same reason waves.ts bakes it into
	// each omega: uTime stays real seconds everywhere in the scene.
	float w = sqrt(${G.toFixed(3)} * klen) * ${(activeField.timeScale ?? 1).toFixed(4)};
	float c = cos(w * uTime);
	float s = sin(w * uTime);
	// h(k,t) = h0 e^{iwt} + conj(h0(-k)) e^{-iwt}
	vec2 a = vec2(h0.x * c - h0.y * s, h0.x * s + h0.y * c);
	vec2 b = vec2(h0.z * c + h0.w * s, -h0.z * s + h0.w * c);
	vec2 h = a + b;
	// Slope spectra: i*kx*h and i*kz*h.
	vec2 sx = vec2(-k.x * h.y, k.x * h.x);
	vec2 sz = vec2(-k.y * h.y, k.y * h.x);
	// Pack as sx + i*sz so one transform yields both.
	gl_FragColor = vec4(sx.x - sz.y, sx.y + sz.x, 0.0, 1.0);
}`

/** One Cooley-Tukey stage, driven entirely by the butterfly lookup. */
const butterflyFragment = `
precision highp float;
uniform sampler2D uButterfly;
uniform sampler2D uSrc;
uniform float uStage;
uniform float uVertical;
void main() {
	vec2 px = gl_FragCoord.xy - 0.5;
	float along = uVertical > 0.5 ? px.y : px.x;
	// The lookup is N wide (index) by STAGES tall (stage), matching the
	// row-major fill in butterflyData(). Getting these two out of step is
	// silent: every fetch still returns a valid-looking twiddle and pair of
	// indices, just the wrong ones, and the output is plausible noise.
	vec4 bf = texture2D(uButterfly, vec2(
		(along + 0.5) / ${N.toFixed(1)},
		(uStage + 0.5) / ${STAGES.toFixed(1)}
	));
	vec2 ca, cb;
	if (uVertical > 0.5) {
		ca = texture2D(uSrc, vec2((px.x + 0.5) / ${N.toFixed(1)}, (bf.z + 0.5) / ${N.toFixed(1)})).rg;
		cb = texture2D(uSrc, vec2((px.x + 0.5) / ${N.toFixed(1)}, (bf.w + 0.5) / ${N.toFixed(1)})).rg;
	} else {
		ca = texture2D(uSrc, vec2((bf.z + 0.5) / ${N.toFixed(1)}, (px.y + 0.5) / ${N.toFixed(1)})).rg;
		cb = texture2D(uSrc, vec2((bf.w + 0.5) / ${N.toFixed(1)}, (px.y + 0.5) / ${N.toFixed(1)})).rg;
	}
	vec2 w = bf.xy;
	gl_FragColor = vec4(ca + vec2(w.x * cb.x - w.y * cb.y, w.x * cb.y + w.y * cb.x), 0.0, 1.0);
}`

/**
 * Undo the centred-k layout and scale. The spectrum is built with k = 0
 * at the texture's centre, so the transform comes out shifted by half a
 * period in each axis; multiplying by (-1)^(x+y) puts it back.
 */
const resolveFragment = `
precision highp float;
uniform sampler2D uSrc;
uniform float uGain;
void main() {
	vec2 px = gl_FragCoord.xy - 0.5;
	float sgn = mod(px.x + px.y, 2.0) < 0.5 ? 1.0 : -1.0;
	vec2 v = texture2D(uSrc, (px + 0.5) / ${N.toFixed(1)}).rg;
	gl_FragColor = vec4(v * (sgn * uGain), 0.0, 1.0);
}`

function makeTarget() {
  return new THREE.WebGLRenderTarget(N, N, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.RepeatWrapping,
    wrapT: THREE.RepeatWrapping,
    depthBuffer: false,
    generateMipmaps: false,
  })
}

export class FftWaveField {
  private scene = new THREE.Scene()
  private camera = new THREE.Camera()
  private mesh: THREE.Mesh
  private ping = [makeTarget(), makeTarget()]
  private out = CASCADES.map(() => makeTarget())
  private h0: THREE.DataTexture[]
  private butterfly: THREE.DataTexture
  private matSpectrum: THREE.ShaderMaterial
  private matButterfly: THREE.ShaderMaterial
  private matResolve: THREE.ShaderMaterial
  /** Per-cascade output scale, chosen so the summed field hits `slope`. */
  private gains: number[]

  constructor(minL: number, maxL: number, slope: number) {
    // N wide, STAGES tall — see the note in butterflyFragment.
    this.butterfly = new THREE.DataTexture(
      butterflyData(),
      N,
      STAGES,
      THREE.RGBAFormat,
      THREE.FloatType,
    )
    this.butterfly.needsUpdate = true

    // Each cascade carries only the wavelengths it can resolve well: from
    // a few texels up to a fraction of its patch. Overlapping their bands
    // would double the shared frequencies instead of extending the range.
    // Cascade 0 (the larger patch) takes the long end, cascade 1 the short:
    // the small waves are the ones whose 16.7m repeat is hardest to see.
    // Cascade 0 runs from its own resolution limit up to the longest detail
    // wave; cascade 1 fills in everything shorter, down to its own limit.
    // The bands butt together at the crossover rather than overlapping,
    // since a wavelength present in both patches is simply drawn twice.
    const crossover = (CASCADES[0] / N) * MIN_TEXELS
    const rms: number[] = []
    this.h0 = CASCADES.map((patch, i) => {
      const lo = Math.max(minL, (patch / N) * MIN_TEXELS)
      const hi = i === 0 ? maxL : Math.min(maxL, crossover)
      const built = spectrumData(patch, lo, hi, activeField.seed + 7331 + i * 17)
      rms.push(built.rms)
      const t = new THREE.DataTexture(built.data, N, N, THREE.RGBAFormat, THREE.FloatType)
      t.needsUpdate = true
      return t
    })

    // Independent cascades add in quadrature, so splitting the target by
    // sqrt(count) makes the sum land on `slope` rather than overshooting it.
    const share = slope / Math.sqrt(CASCADES.length)
    this.gains = rms.map((r) => (r > 1e-9 ? share / r : 0))

    const common = { depthTest: false, depthWrite: false }
    this.matSpectrum = new THREE.ShaderMaterial({
      uniforms: { uH0: { value: null }, uTime: { value: 0 }, uPatch: { value: 1 } },
      vertexShader: passVertex,
      fragmentShader: spectrumFragment,
      ...common,
    })
    this.matButterfly = new THREE.ShaderMaterial({
      uniforms: {
        uButterfly: { value: this.butterfly },
        uSrc: { value: null },
        uStage: { value: 0 },
        uVertical: { value: 0 },
      },
      vertexShader: passVertex,
      fragmentShader: butterflyFragment,
      ...common,
    })
    this.matResolve = new THREE.ShaderMaterial({
      uniforms: { uSrc: { value: null }, uGain: { value: 1 } },
      vertexShader: passVertex,
      fragmentShader: resolveFragment,
      ...common,
    })

    this.mesh = new THREE.Mesh(quadGeom, this.matSpectrum)
    this.mesh.frustumCulled = false
    this.scene.add(this.mesh)
  }

  private draw(renderer: THREE.WebGLRenderer, mat: THREE.ShaderMaterial, to: THREE.WebGLRenderTarget) {
    this.mesh.material = mat
    renderer.setRenderTarget(to)
    renderer.render(this.scene, this.camera)
  }

  /** One transform per cascade. Call once per frame before the water. */
  step(renderer: THREE.WebGLRenderer, t: number) {
    const prev = renderer.getRenderTarget()
    for (let c = 0; c < CASCADES.length; c++) {
      this.matSpectrum.uniforms.uH0.value = this.h0[c]
      this.matSpectrum.uniforms.uTime.value = t
      this.matSpectrum.uniforms.uPatch.value = CASCADES[c]
      this.draw(renderer, this.matSpectrum, this.ping[0])

      let src = 0
      for (let axis = 0; axis < 2; axis++) {
        this.matButterfly.uniforms.uVertical.value = axis
        for (let s = 0; s < STAGES; s++) {
          this.matButterfly.uniforms.uStage.value = s
          this.matButterfly.uniforms.uSrc.value = this.ping[src].texture
          this.draw(renderer, this.matButterfly, this.ping[1 - src])
          src = 1 - src
        }
      }
      this.matResolve.uniforms.uSrc.value = this.ping[src].texture
      this.matResolve.uniforms.uGain.value = this.gains[c]
      this.draw(renderer, this.matResolve, this.out[c])
    }
    renderer.setRenderTarget(prev)
  }

  get textures() {
    return this.out.map((t) => t.texture)
  }

  dispose() {
    this.ping.forEach((t) => t.dispose())
    this.out.forEach((t) => t.dispose())
    this.h0.forEach((t) => t.dispose())
    this.butterfly.dispose()
    this.matSpectrum.dispose()
    this.matButterfly.dispose()
    this.matResolve.dispose()
  }
}

/**
 * Build the field for the active preset. Reuses the same `detail` block as
 * the sinusoid version so the two are switchable on one flag and the
 * `slope` knob keeps its meaning; `count` is ignored, since the whole point
 * is that the component count is no longer a budget.
 */
export function makeFftDetail(): FftWaveField {
  const d = activeField.detail ?? {}
  return new FftWaveField(d.minLambda ?? 0.35, d.maxLambda ?? 3.5, d.slope ?? 0.05)
}

/**
 * Sampling side: two fetches, summed. Replaces the per-pixel sinusoid
 * sum with the same signature, so the water fragment is unchanged apart
 * from which function it calls.
 */
export function fftSlopeGlsl(): string {
  return `
uniform sampler2D uFftA;
uniform sampler2D uFftB;

vec2 detailSlope(vec2 p, float t) {
	return texture2D(uFftA, p / ${CASCADES[0].toFixed(3)}).rg
		+ texture2D(uFftB, p / ${CASCADES[1].toFixed(3)}).rg;
}`
}
