/**
 * Single source of truth for ocean surface displacement.
 *
 * The surface is a sum of Gerstner waves generated from a directional
 * spectrum: a few long swells near the wind heading, a mid band with wider
 * spread, and short chop scattered up to ~60 degrees off-wind, all with
 * randomized (seeded, deterministic) phases. Gerstner waves displace
 * horizontally as well as vertically, which sharpens crests and flattens
 * troughs.
 *
 * The formula exists twice: once in GLSL (water vertex shader) and once in
 * TypeScript (buoyancy, bobber, anything that floats). Both live in THIS file
 * and both read the SAME runtime array; the shader receives it as uniform
 * arrays, so there are no baked literals and weather can regenerate the field
 * at runtime. If the two formulas ever diverge, floating objects detach from
 * the surface.
 *
 * Because Gerstner displacement is horizontal too, "height at (x, z)" is not
 * a direct lookup: sampleSurface() inverts the displacement with a fixed
 * point iteration (3 rounds, exact to millimeters at our steepness).
 */

export type WaveParams = {
  /** Unit direction of travel. */
  dirX: number
  dirZ: number
  /** Angular wavenumber, 2*pi / wavelength. */
  k: number
  /** Angular frequency from deep-water dispersion, sqrt(g * k). */
  omega: number
  /** Meters. */
  amp: number
  /** Gerstner chop factor for this component. */
  q: number
  /** Random phase offset, radians. */
  phase: number
}

export type WaveBand = {
  count: number
  minLambda: number
  maxLambda: number
  /** Heading offset from the wind angle, radians. Crossing systems clash. */
  heading: number
  /** Max angle off this band's heading, radians. */
  spread: number
  /** Wave slope (amp * k); sets amplitude per wavelength. */
  slope: number
  /**
   * Optional phase-speed multiplier for this band, default 1 (physical
   * dispersion, omega = sqrt(g * k)). Art-direction knob: breaks physics,
   * but only for this band.
   */
  speed?: number
}

export type WaveFieldConfig = {
  seed: number
  /** Radians; the heading waves travel toward. Weather will own this later. */
  windAngle: number
  /**
   * Meters per second, used for spray advection and gusts (not wave energy,
   * yet; the JONSWAP pass will tie band energies to it). Default 5.
   */
  windSpeed?: number
  /**
   * Global Gerstner chop budget. Crest sharpness rises with it. Above ~0.9
   * the sharpest crests start to self-intersect ("looping"): deliberately
   * allowed, since it reads as sharp breaking peaks and gives floaters a
   * lively snap. The loop condition is the Jacobian of the horizontal
   * displacement going negative, which is exactly what the foam/whitecap
   * pass will threshold on: loop = foam, once foam renders.
   *
   * Caveat: far past ~1, the CPU sampler's fixed-point inversion in
   * sampleSurface() loses its formal convergence guarantee. It behaves well
   * at largeSwell's 2.25 in practice; if floaters ever jitter on an extreme
   * preset, raise the iteration count there.
   */
  chop: number
  /**
   * Optional global multiplier on every wave's phase speed, default 1.
   * 0.5 halves the whole sea's tempo without touching its shape; relative
   * speeds between long and short waves stay physical.
   */
  timeScale?: number
  bands: WaveBand[]
}

/**
 * Named sea states. Preview one live with /?sea=<name>. Weather will
 * eventually own transitions between them (lerping band energies).
 */
export const SEA_PRESETS = {
  /** Signed off: large, confused open-ocean swell with breaking peaks. */
  largeSwell: {
    seed: 1897,
    windAngle: 0.42,
    windSpeed: 9,
    chop: 2.25,
    bands: [
      // Primary swell: the long rolling system on the wind heading.
      {
        count: 4,
        minLambda: 28,
        maxLambda: 66,
        heading: 0,
        spread: 0.18,
        slope: 0.085,
        speed: 0.7,
      },
      // Crossing swell ~110 degrees off: clashes with the primary, piles
      // pyramid peaks where crests intersect instead of parallel fronts.
      {
        count: 3,
        minLambda: 18,
        maxLambda: 46,
        heading: 1.9,
        spread: 1.25,
        slope: 0.055,
        speed: 0.7,
      },
      // Wind sea: the everyday texture, loosely on the wind.
      {
        count: 6,
        minLambda: 8,
        maxLambda: 16,
        heading: 0.3,
        spread: 0.7,
        slope: 0.05,
        speed: 1.5,
      },
      // Confused chop: wide scatter, leaning off-wind.
      {
        count: 3,
        minLambda: 5,
        maxLambda: 25,
        heading: -0.4,
        spread: 1.2,
        slope: 0.045,
      },
      // Ripple: near-isotropic. Min wavelength must stay >= ~3-4x the water
      // mesh quad size (see WATER_SEGMENTS) or it aliases into vertex crawl.
      {
        count: 6,
        minLambda: 2.6,
        maxLambda: 4.5,
        heading: 0.8,
        spread: 1.6,
        slope: 0.04,
      },
    ],
  },
  /** Signed off: a gentle day, texture carried by ripples. */
  calm: {
    seed: 1897,
    windAngle: 0.42,
    windSpeed: 2,
    chop: 0.55,
    timeScale: 1,
    bands: [
      // One long, low swell rolling through.
      {
        count: 2,
        minLambda: 40,
        maxLambda: 50,
        heading: 0,
        spread: 0.12,
        slope: 0.008,
        speed: 0.7,
      },
      // A whisper of wind sea.
      {
        count: 3,
        minLambda: 10,
        maxLambda: 18,
        heading: 0.2,
        spread: 0.5,
        slope: 0.009,
        speed: 1.2,
      },
      // Ripples carry most of the visible texture on a calm day.
      {
        count: 5,
        minLambda: 2,
        maxLambda: 5,
        heading: 0.5,
        spread: 1.4,
        slope: 0.005,
      },
      // Cross ripples
      {
        count: 5,
        minLambda: 6,
        maxLambda: 10,
        heading: -0.3,
        spread: 1.4,
        slope: 0.005,
      },
    ],
  },
  /**
   * Starting scaffold for tuning: a storm. Everything is up for grabs.
   * Storm seas are young and wind-driven: the wind sea dominates instead of
   * organized swell, directional spread is wide everywhere, slopes push
   * toward the breaking limit (amp * k of ~0.14), and high chop loops many
   * crests, which is where foam will appear once it renders.
   */
  storm: {
    seed: 4242,
    windAngle: 0.42,
    windSpeed: 18,
    chop: 4.6,
    bands: [
      // Dominant storm wind sea: big, steep, and disorganized.
      {
        count: 4,
        minLambda: 34,
        maxLambda: 72,
        heading: 0,
        spread: 0.55,
        slope: 0.145,
        speed: 0.8,
      },
      // Crossing system ~140 degrees off: the sea state that makes
      // storms feel treacherous, peaks erupting without rhythm.
      {
        count: 3,
        minLambda: 20,
        maxLambda: 40,
        heading: 2.4,
        spread: 0.8,
        slope: 0.17,
        speed: 0.8,
      },
      // Steep mid chop.
      {
        count: 6,
        minLambda: 9,
        maxLambda: 20,
        heading: 0.3,
        spread: 1.1,
        slope: 0.085,
        speed: 1.5,
      },
      // Violent short chop.
      {
        count: 5,
        minLambda: 4,
        maxLambda: 9,
        heading: -0.5,
        spread: 1.5,
        slope: 0.07,
        speed: 1.5,
      },
      // Spray-scale texture. Min wavelength floor: see the mesh note above.
      {
        count: 6,
        minLambda: 2.6,
        maxLambda: 4.5,
        heading: 0.8,
        spread: 1.8,
        slope: 0.05,
      },
    ],
  },
} satisfies Record<string, WaveFieldConfig>

/** The preset the site ships with. */
export const DEFAULT_FIELD: WaveFieldConfig = SEA_PRESETS.storm

function pickPreset(): WaveFieldConfig {
  // Debug hook: /?sea=calm previews a preset without a code edit.
  if (typeof window !== 'undefined') {
    const name = new URLSearchParams(window.location.search).get('sea')
    if (name && name in SEA_PRESETS) {
      return SEA_PRESETS[name as keyof typeof SEA_PRESETS]
    }
  }
  return DEFAULT_FIELD
}

/** Deterministic PRNG so the field is identical across sessions and twins. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const G = 9.81

export function generateWaves(
  cfg: WaveFieldConfig = DEFAULT_FIELD,
): WaveParams[] {
  const rand = mulberry32(cfg.seed)
  const waves: WaveParams[] = []
  for (const band of cfg.bands) {
    for (let i = 0; i < band.count; i++) {
      // Stratified sampling in log-wavelength: covers the band without clumping.
      const f = (i + 0.3 + rand() * 0.4) / band.count
      const lambda =
        band.minLambda * Math.pow(band.maxLambda / band.minLambda, f)
      const k = (2 * Math.PI) / lambda
      const angle =
        cfg.windAngle + band.heading + (rand() * 2 - 1) * band.spread
      const amp =
        ((band.slope * lambda) / (2 * Math.PI)) * (0.75 + rand() * 0.5)
      waves.push({
        dirX: Math.cos(angle),
        dirZ: Math.sin(angle),
        k,
        // Deep-water dispersion, scaled by the band and global speed knobs.
        // Baked into omega here, so the GPU and CPU twins agree for free.
        omega: Math.sqrt(G * k) * (band.speed ?? 1) * (cfg.timeScale ?? 1),
        amp,
        q: 0,
        phase: rand() * Math.PI * 2,
      })
    }
  }
  // Split the chop budget so sum(q * k * amp) = chop. Below 1 crests stay
  // smooth; above 1 the sharpest ones loop (see the chop doc on WaveFieldConfig).
  for (const w of waves) w.q = cfg.chop / (w.k * w.amp * waves.length)
  return waves
}

/** The preset actually in effect this session (after the ?sea= override). */
export const activeField: WaveFieldConfig = pickPreset()

/** The live field. One array; the GPU uniforms and the CPU sampler both read it. */
export const waves = generateWaves(activeField)

/**
 * Typical crest height (RMS sum): use for normalizing height-based color.
 * The straight sum overstates it badly since components rarely align.
 */
export const significantAmplitude = Math.sqrt(
  waves.reduce((s, w) => s + w.amp * w.amp, 0),
)

// ---------- CPU twin ----------

export type SurfaceSample = {
  height: number
  /** Horizontal Gerstner displacement at this point; use scaled-down for sway. */
  swayX: number
  swayZ: number
  /**
   * Jacobian determinant of the horizontal Gerstner map. 1 on flat water,
   * 0 where a crest pinches vertical, negative where the surface folds over
   * itself: that crest is BREAKING. Foam, spray, and splash triggers all
   * key off this going negative.
   */
  jacobian: number
}

const scratch = { x: 0, y: 0, z: 0, jxx: 1, jzz: 1, jxz: 0 }

function displace(u: number, v: number, t: number, ampScale: number) {
  let dx = 0
  let dy = 0
  let dz = 0
  let jxx = 1
  let jzz = 1
  let jxz = 0
  for (const w of waves) {
    const theta = (u * w.dirX + v * w.dirZ) * w.k - w.omega * t + w.phase
    const amp = w.amp * ampScale
    const c = Math.cos(theta)
    const s = Math.sin(theta)
    dx += w.q * amp * w.dirX * c
    dz += w.q * amp * w.dirZ * c
    dy += amp * s
    // Partial derivatives of the horizontal displacement.
    const qak = w.q * amp * w.k
    jxx -= qak * w.dirX * w.dirX * s
    jzz -= qak * w.dirZ * w.dirZ * s
    jxz -= qak * w.dirX * w.dirZ * s
  }
  scratch.x = dx
  scratch.y = dy
  scratch.z = dz
  scratch.jxx = jxx
  scratch.jzz = jzz
  scratch.jxz = jxz
  return scratch
}

/**
 * Surface state above world (x, z) at time t.
 * MUST match waveDisplacement() in the GLSL below, term for term.
 */
export function sampleSurface(
  x: number,
  z: number,
  t: number,
  ampScale = 1,
  // 3 is exact to millimeters; 1 is centimeter-grade and half the cost,
  // fine for particles that only need to hug the surface visually.
  iterations = 3,
): SurfaceSample {
  // Invert the horizontal displacement: find the parameter point that lands on (x, z).
  let u = x
  let v = z
  for (let i = 0; i < iterations; i++) {
    const d = displace(u, v, t, ampScale)
    u = x - d.x
    v = z - d.z
  }
  const d = displace(u, v, t, ampScale)
  return {
    height: d.y,
    swayX: d.x,
    swayZ: d.z,
    jacobian: d.jxx * d.jzz - d.jxz * d.jxz,
  }
}

export function sampleHeight(
  x: number,
  z: number,
  t: number,
  ampScale = 1,
): number {
  return sampleSurface(x, z, t, ampScale).height
}

// ---------- GPU twin ----------

/**
 * GLSL twin of displace(). Same formulas, term for term, and the uniforms
 * are uploaded from the same `waves` array (see the uniform setup in Scene).
 */
export function wavesGlsl(): string {
  return `
#define WAVE_COUNT ${waves.length}
uniform vec4 uWaveA[WAVE_COUNT]; // dirX, dirZ, k, omega
uniform vec3 uWaveB[WAVE_COUNT]; // amp, q, phase

vec3 waveDisplacement(vec2 p, float t, float ampScale) {
	vec3 d = vec3(0.0);
	for (int i = 0; i < WAVE_COUNT; i++) {
		vec4 a = uWaveA[i];
		vec3 b = uWaveB[i];
		float theta = (p.x * a.x + p.y * a.y) * a.z - a.w * t + b.z;
		float amp = b.x * ampScale;
		float c = cos(theta);
		d.x += b.y * amp * a.x * c;
		d.z += b.y * amp * a.y * c;
		d.y += amp * sin(theta);
	}
	return d;
}

// Jacobian determinant of the horizontal Gerstner map. 1 = flat water,
// 0 = crest pinched vertical, negative = folded over itself: BREAKING.
// Twin of the jxx/jzz/jxz sums in displace() on the CPU side.
float waveJacobian(vec2 p, float t, float ampScale) {
	float jxx = 1.0;
	float jzz = 1.0;
	float jxz = 0.0;
	for (int i = 0; i < WAVE_COUNT; i++) {
		vec4 a = uWaveA[i];
		vec3 b = uWaveB[i];
		float theta = (p.x * a.x + p.y * a.y) * a.z - a.w * t + b.z;
		float s = sin(theta);
		float qak = b.y * b.x * ampScale * a.z;
		jxx -= qak * a.x * a.x * s;
		jzz -= qak * a.y * a.y * s;
		jxz -= qak * a.x * a.y * s;
	}
	return jxx * jzz - jxz * jxz;
}`
}
