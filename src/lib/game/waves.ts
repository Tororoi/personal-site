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

import * as THREE from 'three'
import { WEATHER, WIND, CURRENT, INSPECT, SEA } from './tuning'

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
   * Surface-current heading, radians, in the same frame as windAngle.
   * An opposing current shortens and steepens the waves it meets
   * (wave-current interaction compresses the train against the flow),
   * which is why the storm runs its current back into the wind while
   * the calmer seas run with it.
   */
  surfaceCurrentHeading?: number
  /** Surface-current speed, m/s. Defaults to CURRENT.speed. */
  surfaceCurrentSpeed?: number
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
   * sampleSurface() loses its formal convergence guarantee — and raising
   * the iteration count makes it WORSE at a fold, not better (each pass is
   * another chance to hop between the fold's sheets; measured at chop 5).
   * Floaters should ride sampleSurfaceTracked(), which follows one sheet
   * across frames.
   */
  chop: number
  /**
   * Optional global multiplier on every wave's phase speed, default 1.
   * 0.5 halves the whole sea's tempo without touching its shape; relative
   * speeds between long and short waves stay physical.
   */
  timeScale?: number
  /**
   * How this sea renders the interactive ripple field (ripples.ts).
   * Omitted values fall back to the calm-water defaults there.
   */
  ripples?: {
    /** Visual amplification of the smooth ripple displacement. */
    displayGain?: number
    /** Physical ripple propagation speed, m/s (resolution-independent). */
    speed?: number
    /** Per-step energy retention; lower = rings die faster. */
    damping?: number
    /** Splash-froth seethe displacement, meters (consumed by froth.ts). */
    frothAmplitude?: number
    /** Splash-froth whiteness gain (consumed by froth.ts). */
    frothWhiteness?: number
    /** Splashdown froth burst radius, meters (consumed by froth.ts). */
    frothSigma?: number
  }
  /**
   * SMALL SURFACE WAVES, for SHADING only.
   *
   * Between the mesh's reach and the capillaries there is a band — very
   * roughly 0.3m to 4m — that matters enormously for how the water
   * catches light and cannot be carried by geometry: the water is about
   * 0.5m quads, so anything shorter than a couple of metres aliases
   * rather than resolving. Putting it in `bands` would only add noise.
   *
   * So these are evaluated PER PIXEL as a slope added onto the shading
   * normal, the same trick ripples use (rippleShadeGrad) and the same
   * reason capillaries exist for the caustics. They tilt the surface for
   * lighting without displacing a single vertex.
   *
   * This is what a specular highlight needs. A sun glint only appears
   * where the normal reaches the mirror angle, so it is limited by how
   * finely the normal varies — not by the wave heights at all. Coarse
   * waves give a coarse, blobby glint however it is tuned.
   */
  detail?: {
    /** Shortest and longest wavelength the FFT cascades carry, metres. */
    minLambda?: number
    maxLambda?: number
    /** RMS surface slope of the band; sets how hard these tilt the normal. */
    slope?: number
  }
  /**
   * Sub-pixel capillary ripples for caustics: too small to move a pixel at
   * our zoom, so they are computed only where they are observable, in the
   * caustic Hessian (causticsGlsl). Real pools dapple finely because
   * centimeter-scale ripples are the strong lenses.
   */
  capillary?: {
    count?: number
    minLambda?: number
    maxLambda?: number
    /** Wave slope (amp * k); sets capillary energy. */
    slope?: number
  }
  /**
   * Reflected sky for this sea, sampled by the water's Wallace-style
   * reflection (Scene.svelte): a vertical gradient from horizon to zenith,
   * plus the sun's glare on the reflected ray. Weather transitions will
   * lerp these along with the bands.
   */
  sky?: {
    /** Color straight overhead (what flat-on facets mirror). */
    zenith: string
    /** Color at grazing reflections, near the horizon. */
    horizon: string
    /**
     * Sun diffusion, 0 clear sky .. 1 heavy overcast. Clouds turn the sun
     * from a point source into an extended one, and every surface lens
     * images the source: the caustic pattern is CONVOLVED with the
     * source's angular size. Drives the caustic map's blur + flatten
     * (caustics.ts / Scene) and softens the sun glare on the water.
     * Default 0.
     */
    diffusion?: number
  }
  bands: WaveBand[]
}

/**
 * BANDS, in a fixed order so the three seas line up band-for-band:
 *
 *   1 PRIMARY SWELL   heading 0the system on the wind
 *   2 CROSSING SWELL  heading 1.9-2.4  a second system well off it
 *   3 WIND SEAheading ~0.3 everyday texture, near the wind
 *   4 SHORT CHOP  heading ~-0.4leaning the other way
 *   5 RIPPLE  heading 0.5-0.8  near-isotropic, mesh-limited
 *
 * COUNTS are identical across all three seas on purpose, and storm's are
 * the canonical set — it is the most delicately tuned, so calm and
 * largeSwell were raised to meet it rather than the other way round. Where
 * a count went up, that band's `slope` was scaled by sqrt(old / new):
 * amplitudes add in quadrature, so spreading the same energy over more
 * components makes each that much smaller. That is why several slopes are
 * odd numbers rather than round ones.
 *
 * calm carries a further uniform trim on top: the sqrt correction fixes the
 * COUNT but not the fact that more slots redistribute wavelengths inside a
 * band, and amplitude scales with wavelength, so its significant amplitude
 * still landed 14% high. Measured and divided back out.
 *
 * The HEADING is what identifies a band, not its wavelength — the
 * ranges overlap between seas but the headings do not. Keeping the
 * order and count identical across presets is what would let a single
 * sea-state dial interpolate them: generateWaves walks a seeded RNG
 * band by band, so matching structure means component i is the SAME
 * wave in every preset, and blending deforms the sea instead of
 * reshuffling it.
 */

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
    // With the wind (0.42): nothing opposing the swell.
    surfaceCurrentHeading: 0.42,
    surfaceCurrentSpeed: 1.55,
    chop: 2.25,
    // Rings still readable, with some froth on energetic disturbances.
    ripples: {
      displayGain: 1.6,
      speed: 2.2,
      damping: 0.96,
    },
    timeScale: 0.7,
    // Big weather brewing: a light overcast gray, sun well scattered.
    sky: { zenith: '#c3cbd1', horizon: '#e9edf0', diffusion: 0.4 },
    // Wind chop riding the swell: plenty of fine tilt.
    detail: { minLambda: 0.4, maxLambda: 4, slope: 0.055 },
    bands: [
      // 1 PRIMARY SWELL. Primary swell: the long rolling system on the wind heading.
      {
        count: 4,
        minLambda: 28,
        maxLambda: 66,
        heading: 0,
        spread: 0.18,
        slope: 0.085,
        speed: 0.7,
      },
      // 2 CROSSING SWELL. Crossing swell ~110 degrees off: clashes with the primary, piles
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
      // 3 WIND SEA. Wind sea: the everyday texture, loosely on the wind.
      {
        count: 6,
        minLambda: 8,
        maxLambda: 16,
        heading: 0.3,
        spread: 0.7,
        slope: 0.05,
        speed: 1.5,
      },
      // 4 SHORT CHOP. Confused chop: wide scatter, leaning off-wind.
      {
        count: 5,
        minLambda: 5,
        maxLambda: 25,
        heading: -0.4,
        spread: 1.2,
        slope: 0.03486,
      },
      // 5 RIPPLE. Ripple: near-isotropic. Min wavelength must stay >= ~3-4x the water
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
  /**
   * EXPERIMENT SEA — built to make the drive metrics disagree.
   *
   * Long and gentle: largeSwell's bands with every wavelength x2.2 and
   * every slope x0.75. That lands it at 78% of the way to storm by
   * AMPLITUDE but only 36% by SLOPE, because the two are independent by
   * construction — a component's slope is amp * k = (slope * L / 2pi) *
   * (2pi / L), so the wavelength cancels and only the band's own `slope`
   * knob sets it. Stretching wavelengths therefore moves size without
   * touching steepness.
   *
   * That is the whole point: on the real presets slope and amplitude move
   * in lockstep and the two drivers agree to within 6%, so neither can be
   * judged against the other. Here they disagree by more than 2x, and with
   * SPECULAR.driveCurve set to 1 (linear) by over 6x.
   *
   * Not a sea to ship — a 145m primary swell barely fits the view. Reach
   * for it with /?sea=test, or use SEA.lambdaScale to sweep the same
   * axis continuously.
   */
  test: {
    seed: 1897,
    windAngle: 0.42,
    windSpeed: 9,
    surfaceCurrentHeading: 0.42,
    surfaceCurrentSpeed: 1.55,
    chop: 2.25,
    ripples: { displayGain: 1.6, speed: 2.2, damping: 0.96 },
    sky: { zenith: '#c3cbd1', horizon: '#e9edf0', diffusion: 0.4 },
    detail: { minLambda: 0.4, maxLambda: 4, slope: 0.055 },
    bands: [
      // 1 PRIMARY SWELL.
      {
        count: 4,
        minLambda: 61.6,
        maxLambda: 145.2,
        heading: 0,
        spread: 0.18,
        slope: 0.06375,
        speed: 0.7,
      },
      // 2 CROSSING SWELL.
      {
        count: 3,
        minLambda: 39.6,
        maxLambda: 101.2,
        heading: 1.9,
        spread: 1.25,
        slope: 0.04125,
        speed: 0.7,
      },
      // 3 WIND SEA.
      {
        count: 6,
        minLambda: 17.6,
        maxLambda: 35.2,
        heading: 0.3,
        spread: 0.7,
        slope: 0.0375,
        speed: 1.5,
      },
      // 4 SHORT CHOP.
      {
        count: 5,
        minLambda: 11,
        maxLambda: 55,
        heading: -0.4,
        spread: 1.2,
        slope: 0.0262,
        speed: 1.5,
      },
      // 5 RIPPLE.
      {
        count: 6,
        minLambda: 5.72,
        maxLambda: 9.9,
        heading: 0.8,
        spread: 1.6,
        slope: 0.03,
      },
    ],
  },
  /** Signed off: a gentle day, texture carried by ripples. */
  calm: {
    seed: 1897,
    windAngle: 0.42,
    windSpeed: 2,
    // With the wind.
    surfaceCurrentHeading: 0.42,
    chop: 0.55,
    timeScale: 1,
    // Clean water: smooth rings, no froth. These are the signed-off
    // calm-water interaction settings.
    ripples: {
      displayGain: 1.6,
      speed: 2.2,
      damping: 0.96,
    },
    // A gentle day mirrors a blue sky; near-point sun, crisp caustics.
    sky: { zenith: '#2e6fb2', horizon: '#a9cfe8', diffusion: 0.05 },
    // Glassy, but never mirror-flat: a fine cat's-paw texture is what
    // gives a calm sea its glitter under a clear sun.
    detail: { minLambda: 0.3, maxLambda: 5.4, slope: 0.01 },
    bands: [
      // 1 PRIMARY SWELL. One long, low swell rolling through.
      {
        count: 4,
        minLambda: 40,
        maxLambda: 50,
        heading: 0,
        spread: 1.52,
        slope: 0.00350562,
        speed: 0.7,
      },
      // 2 CROSSING SWELL. ABSENT on a calm sea — nothing else is running
      // through it. This is the band the other two presets have and calm
      // does not, so a sea-state blend needs one here (heading around 2.0,
      // slope near zero) purely so the structures match; at calm's end of
      // the dial it should contribute nothing.
      {
        count: 3,
        minLambda: 40,
        maxLambda: 50,
        heading: 0,
        spread: 1.52,
        slope: 0.00404811,
        speed: 0.7,
      },
      // 3 WIND SEA. A whisper of it.
      {
        count: 6,
        minLambda: 10,
        maxLambda: 18,
        heading: 0,
        spread: 1.5,
        slope: 0.00557744,
        speed: 1.2,
      },
      // 4 SHORT CHOP. Cross ripples.
      {
        count: 5,
        minLambda: 6,
        maxLambda: 10,
        heading: 0,
        spread: 1.4,
        slope: 0.00438202,
      },
      // 5 RIPPLE. Carries most of the visible texture on a calm day.
      {
        count: 6,
        minLambda: 2,
        maxLambda: 5,
        heading: 0,
        spread: 1.4,
        slope: 0.00399991,
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
    seed: 1897,
    windAngle: 0.32,
    windSpeed: 40,
    // AGAINST the wind (0.32 + PI): an opposing current is what makes a
    // storm sea stand up short and steep instead of running long.
    surfaceCurrentHeading: 3.46,
    surfaceCurrentSpeed: 1.55,
    chop: 5,
    // Slower than real: a storm sea that heaves and breaks at this rate
    // reads as BIGGER (ocean period grows with wavelength), and it
    // brings the loops' travel speed down so the crest spray is
    // legible instead of whipping past.
    timeScale: 0.7,
    // Choppy water tears rings apart: disturbances render mostly as
    // seething froth (crest-churn style), and ring energy dies fast.
    ripples: {
      displayGain: 1.6,
      speed: 2.2,
      damping: 0.96,
    },
    // Heavy cloud deck: a medium gray, darker than the swell's overcast;
    // a ghost of the caustic web survives it.
    sky: { zenith: '#6b737a', horizon: '#98a0a7', diffusion: 0.7 },
    // Torn-up surface: short, steep, every which way.
    detail: { minLambda: 0.35, maxLambda: 3, slope: 0.055 },
    bands: [
      // 1 PRIMARY SWELL. Dominant storm wind sea: big, steep, and disorganized.
      {
        count: 4,
        minLambda: 34,
        maxLambda: 72,
        heading: 0,
        spread: 0.55,
        slope: 0.145,
        speed: 0.8,
      },
      // 2 CROSSING SWELL. Crossing system ~140 degrees off: the sea state that makes
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
      // 3 WIND SEA. Steep mid chop.
      {
        count: 6,
        minLambda: 9,
        maxLambda: 20,
        heading: 0.3,
        spread: 1.1,
        slope: 0.085,
        speed: 1.5,
      },
      // 4 SHORT CHOP. Violent short chop.
      {
        count: 5,
        minLambda: 4,
        maxLambda: 9,
        heading: -0.5,
        spread: 1.5,
        slope: 0.07,
        speed: 1.5,
      },
      // 5 RIPPLE. Spray-scale texture. Min wavelength floor: see the mesh note above.
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

/**
 * SEA STATE — the presets as keyframes on one continuous axis.
 *
 * 0 = calm, 1 = largeSwell, 2 = storm, and anything between is a genuine
 * blend rather than a snap. This works only because the three now share a
 * seed AND a band structure: generateWaves walks the RNG band by band, so
 * component i draws the same jitter and phase in every preset. Sliding the
 * dial therefore DEFORMS one sea into the next — each wave keeps its
 * identity and changes wavelength, amplitude and heading — instead of
 * regenerating a different random field at every step.
 *
 * Interpolation is straight linear between neighbouring keyframes. It is
 * not perceptually even — calm to largeSwell is a 17x jump in amplitude,
 * so most of that segment already looks like weather — but the dial itself
 * is the curve: pick 0.2 rather than bending the mapping underneath.
 */
const SEA_SEQUENCE: WaveFieldConfig[] = [
  SEA_PRESETS.calm,
  SEA_PRESETS.largeSwell,
  SEA_PRESETS.storm,
]

const lerpN = (a: number, b: number, t: number) => a + (b - a) * t
/** Resolve an optional field to the value its consumer would have used. */
const opt = (x: number | undefined, fallback: number) =>
  x === undefined ? (x ?? fallback) : x

/** 0xRRGGBB knob number -> '#rrggbb'. */
function numHex(n: number): string {
  return '#' + (n & 0xffffff).toString(16).padStart(6, '0')
}

function lerpHex(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16)
  const pb = parseInt(b.slice(1), 16)
  const ch = (sh: number) =>
    Math.round(lerpN((pa >> sh) & 255, (pb >> sh) & 255, t))
      .toString(16)
      .padStart(2, '0')
  return `#${ch(16)}${ch(8)}${ch(0)}`
}

function blendFields(
  a: WaveFieldConfig,
  b: WaveFieldConfig,
  t: number,
): WaveFieldConfig {
  if (a.seed !== b.seed) {
    throw new Error(
      `sea blend needs one seed: ${a.seed} vs ${b.seed}. Different seeds mean ` +
        `different waves, so the blend would reshuffle rather than deform.`,
    )
  }
  return {
    seed: a.seed,
    windAngle: lerpN(a.windAngle, b.windAngle, t),
    windSpeed: lerpN(opt(a.windSpeed, 5), opt(b.windSpeed, 5), t),
    surfaceCurrentHeading: lerpN(
      opt(a.surfaceCurrentHeading, a.windAngle),
      opt(b.surfaceCurrentHeading, b.windAngle),
      t,
    ),
    surfaceCurrentSpeed: lerpN(
      opt(a.surfaceCurrentSpeed, CURRENT.speed),
      opt(b.surfaceCurrentSpeed, CURRENT.speed),
      t,
    ),
    chop: lerpN(a.chop, b.chop, t),
    timeScale: lerpN(opt(a.timeScale, 1), opt(b.timeScale, 1), t),
    ripples: {
      displayGain: lerpN(
        opt(a.ripples?.displayGain, 1),
        opt(b.ripples?.displayGain, 1),
        t,
      ),
      speed: lerpN(opt(a.ripples?.speed, 2.2), opt(b.ripples?.speed, 2.2), t),
      damping: lerpN(
        opt(a.ripples?.damping, 0.96),
        opt(b.ripples?.damping, 0.96),
        t,
      ),
    },
    sky: {
      zenith: lerpHex(
        a.sky?.zenith ?? '#2e6fb2',
        b.sky?.zenith ?? '#2e6fb2',
        t,
      ),
      horizon: lerpHex(
        a.sky?.horizon ?? '#a9cfe8',
        b.sky?.horizon ?? '#a9cfe8',
        t,
      ),
      diffusion: lerpN(opt(a.sky?.diffusion, 0), opt(b.sky?.diffusion, 0), t),
    },
    detail: {
      minLambda: lerpN(
        opt(a.detail?.minLambda, 0.35),
        opt(b.detail?.minLambda, 0.35),
        t,
      ),
      maxLambda: lerpN(
        opt(a.detail?.maxLambda, 3.5),
        opt(b.detail?.maxLambda, 3.5),
        t,
      ),
      slope: lerpN(opt(a.detail?.slope, 0.05), opt(b.detail?.slope, 0.05), t),
    },
    bands: a.bands.map((ba, i) => {
      const bb = b.bands[i]
      if (!bb || ba.count !== bb.count) {
        throw new Error(
          `sea blend needs matching band structure at band ${i}: ` +
            `count ${ba.count} vs ${bb?.count}. Component i must be the same ` +
            `wave in both, or the field reshuffles mid-slide.`,
        )
      }
      return {
        count: ba.count,
        minLambda: lerpN(ba.minLambda, bb.minLambda, t),
        maxLambda: lerpN(ba.maxLambda, bb.maxLambda, t),
        heading: lerpN(ba.heading, bb.heading, t),
        spread: lerpN(ba.spread, bb.spread, t),
        slope: lerpN(ba.slope, bb.slope, t),
        speed: lerpN(opt(ba.speed, 1), opt(bb.speed, 1), t),
      }
    }),
  }
}

/**
 * LIVE SEA STATE.
 *
 * Rebuilds the field in place so a transition can run during play instead
 * of needing a reload. In place is the whole trick: `waves` keeps its
 * identity, so every module holding a reference to it — the CPU sampler,
 * buoyancy, spray — follows without being told, and the GPU only needs its
 * two uniform arrays re-uploaded.
 *
 * Safe only because all three presets now carry 24 components: the shader
 * bakes `#define WAVE_COUNT` at build, so a changing count would need a
 * recompile. Asserted rather than assumed.
 *
 * NOT everything follows. Values baked into shader source or built once on
 * the GPU stay put: the FFT detail spectrum, foam's chop-derived
 * thresholds, the whitecap and current headings, and the froth lattice's
 * extent. Those still need a reload; what moves here is the sea itself —
 * heights, wavelengths, headings, chop and speed.
 */
/**
 * A field is only ever used through `activeField`, which gets written to —
 * so it must never ALIAS a preset. pickPreset returns the preset object
 * itself, and assigning over that would quietly overwrite a keyframe and
 * corrupt every later blend. Clone on the way in.
 */
function cloneField(f: WaveFieldConfig): WaveFieldConfig {
  return {
    ...f,
    ripples: f.ripples && { ...f.ripples },
    sky: f.sky && { ...f.sky },
    detail: f.detail && { ...f.detail },
    capillary: f.capillary && { ...f.capillary },
    bands: f.bands.map((b) => ({ ...b })),
  }
}

const fieldListeners: (() => void)[] = []
/** Register a recompute for anything derived from `waves`. */
export function onFieldChange(fn: () => void) {
  fieldListeners.push(fn)
}

/**
 * The PIVOT for live sea edits. Wave phases are anchored at the world
 * origin, so regenerating with a rotated wind (or scaled wavelengths)
 * rotates the whole interference pattern about (0,0) — and out at the
 * boat, kilometres of lever arm turn a small windCompassDeg nudge into
 * the sea sliding sideways underfoot. applySeaState re-anchors every
 * component's phase so its TOTAL phase at this point, at this time, is
 * unchanged: the water under the boat stays put and the far field turns
 * around the player instead of the origin. The Scene refreshes it each
 * fixed step.
 */
let pivotX = 0
let pivotZ = 0
let pivotT = 0
export function setSeaPivot(x: number, z: number, t: number) {
  pivotX = x
  pivotZ = z
  pivotT = t
}

export function applySeaState(state: number, chopOverride: number) {
  // The unified field is the only live sea now. `state` is kept in the
  // signature for the coming repurpose: transitions between SAVED
  // unified-sea values.
  const next = cloneField(unifiedField())
  if (chopOverride >= 0) next.chop = chopOverride
  Object.assign(activeField, next)
  const fresh = INSPECT.simpleSea ? simpleSeaWaves() : generateWaves(activeField)
  if (fresh.length !== waves.length) {
    throw new Error(
      `sea state changed the component count (${waves.length} -> ${fresh.length}). ` +
        `WAVE_COUNT is baked into the shader, so this needs a reload, not a swap.`,
    )
  }
  const TAU = 2 * Math.PI
  for (let i = 0; i < waves.length; i++) {
    const o = waves[i]
    const n = fresh[i]
    // Preserve the component's total phase at the pivot (see setSeaPivot):
    // theta = (p . dir) k - omega t + phase must match old and new.
    const thetaO = (pivotX * o.dirX + pivotZ * o.dirZ) * o.k - o.omega * pivotT + o.phase
    const thetaN = (pivotX * n.dirX + pivotZ * n.dirZ) * n.k - n.omega * pivotT + n.phase
    n.phase = (((n.phase + thetaO - thetaN) % TAU) + TAU) % TAU
    Object.assign(o, n)
  }
  maxSurfaceRate = waves.reduce((sum, w) => sum + Math.abs(w.amp * w.omega), 0)
  syncWaveUniforms()
  computeMetrics()
  for (const fn of fieldListeners) fn()
}

/**
 * The unified sea's FIXED band structure. Wavelengths, headings, spreads
 * and the slope BALANCE between bands live here as constants; the
 * SEA.waves dial scales the slopes uniformly, and nothing else about
 * a band ever moves. See the unified-field doc in tuning.ts (SEA group) for why.
 */
const UNIFIED_BANDS: WaveBand[] = [
  // 1 PRIMARY SWELL
  {
    count: 4,
    minLambda: 32,
    maxLambda: 68,
    heading: 0,
    spread: 0.4,
    slope: 0.085,
    speed: 0.75,
  },
  // 2 CROSSING SWELL
  {
    count: 3,
    minLambda: 19,
    maxLambda: 44,
    heading: 2.1,
    spread: 1.0,
    slope: 0.055,
    speed: 0.75,
  },
  // 3 WIND SEA
  {
    count: 6,
    minLambda: 9,
    maxLambda: 18,
    heading: 0.3,
    spread: 0.9,
    slope: 0.05,
    speed: 1.5,
  },
  // 4 SHORT CHOP
  {
    count: 5,
    minLambda: 4.5,
    maxLambda: 10,
    heading: -0.45,
    spread: 1.35,
    slope: 0.0349,
    speed: 1.5,
  },
  // 5 RIPPLE
  {
    count: 6,
    minLambda: 2.4,
    maxLambda: 4.8,
    heading: 0.8,
    spread: 1.7,
    slope: 0.04,
    speed: 1,
  },
]

/**
 * World azimuth of compass NORTH, degrees. Chosen so WEST (compass 270)
 * lands where the default sun path sets — world azimuth 226, from
 * sunPathAngleDeg 81 + 180 - sunPathOffsetDeg 35 — so "the sun sets in
 * the west" holds and the compass knobs read naturally. A fixed
 * calibration against the DEFAULT sun path, not a live link: retuning the
 * sun does not silently rotate the wind.
 */
const UNIFIED_NORTH_DEG = 316

/**
 * Energy landmarks for the `waves` dial: the factor to apply to every
 * band slope so the unified sea's RMS slope matches each preset's.
 * Computed lazily from the presets themselves rather than hardcoded, so
 * retuning a preset keeps the dial honest.
 */
let unifiedEnergy: { calm: number; storm: number } | null = null
function energyFactors() {
  if (!unifiedEnergy) {
    const rms = (f: WaveFieldConfig) => {
      let m = 0
      for (const w of generateWaves(f)) m += (w.amp * w.k * (w.amp * w.k)) / 2
      return Math.sqrt(m)
    }
    const base = rms({ ...SEA_PRESETS.largeSwell, bands: UNIFIED_BANDS })
    unifiedEnergy = {
      calm: rms(SEA_PRESETS.calm) / base,
      storm: rms(SEA_PRESETS.storm) / base,
    }
  }
  return unifiedEnergy
}

/**
 * The UNIFIED field, assembled from the sliders. Read fresh on every
 * rebuild, which is what makes every knob live.
 */
export function unifiedField(): WaveFieldConfig {
  const U = SEA
  const E = energyFactors()
  const w = Math.min(Math.max(U.waves, 0), 2)
  // Geometric through the landmarks: slopes span ~23x calm-to-storm, and
  // a linear ramp across that spends nearly all its length at one end.
  const fac = w <= 1 ? Math.pow(E.calm, 1 - w) : Math.pow(E.storm, w - 1)
  // Chop is a budget, not an energy; the presets' values lerp directly.
  const chop = w <= 1 ? 0.55 + (2.25 - 0.55) * w : 2.25 + (5 - 2.25) * (w - 1)
  const compass = (deg: number) =>
    ((UNIFIED_NORTH_DEG + deg) % 360) * (Math.PI / 180)
  return {
    seed: SEA_PRESETS.largeSwell.seed,
    windAngle: compass(WIND.windCompassDeg),
    windSpeed: WIND.windSpeed,
    surfaceCurrentHeading: compass(U.currentCompassDeg),
    surfaceCurrentSpeed: U.currentSpeed,
    chop,
    timeScale: U.timeScale,
    ripples: { displayGain: 1.6, speed: 2.2, damping: 0.96 },
    sky: {
      // The endpoints are WEATHER knobs (0xRRGGBB), pickable in the
      // panel; defaults are the calm/storm preset skies this replaced.
      zenith: lerpHex(
        numHex(WEATHER.skyClearZenith),
        numHex(WEATHER.skyOvercastZenith),
        WEATHER.overcast,
      ),
      horizon: lerpHex(
        numHex(WEATHER.skyClearHorizon),
        numHex(WEATHER.skyOvercastHorizon),
        WEATHER.overcast,
      ),
      diffusion: 0.05 + (0.7 - 0.05) * WEATHER.overcast,
    },
    detail: {
      minLambda: U.detailMin,
      maxLambda: U.detailMax,
      slope: U.detailSlope,
    },
    bands: UNIFIED_BANDS.map((b) => ({
      ...b,
      minLambda: b.minLambda * U.lambdaScale,
      maxLambda: b.maxLambda * U.lambdaScale,
      slope: b.slope * fac,
    })),
  }
}

/** The sea at a point on the calm -> largeSwell -> storm axis. */
export function fieldForSeaState(x: number): WaveFieldConfig {
  const c = Math.min(Math.max(x, 0), SEA_SEQUENCE.length - 1)
  const i = Math.min(Math.floor(c), SEA_SEQUENCE.length - 2)
  return blendFields(SEA_SEQUENCE[i], SEA_SEQUENCE[i + 1], c - i)
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
export const activeField: WaveFieldConfig = cloneField(unifiedField())

// Test override, applied BEFORE the field is generated: chop sets every
// wave's Gerstner q below, so it has to land before generateWaves runs.
// Everything downstream — significantAmplitude, maxSurfaceRate, the
// specular's chop blend — reads the patched value and follows.
if (SEA.chopOverride >= 0) activeField.chop = SEA.chopOverride

/**
 * ISOLATION override (INSPECT.simpleSea): one large rolling wave instead
 * of the banded spectrum, so behaviour can be judged against a single
 * readable crest. Steepness is given as q*k*amp directly (1 = the
 * looping threshold). Staged, so a toggle is a reload and WAVE_COUNT
 * re-bakes consistently into every shader.
 */
function simpleSeaWaves(): WaveParams[] {
  const k = (2 * Math.PI) / INSPECT.simpleLambdaM
  const angle = (INSPECT.simpleHeadingDeg * Math.PI) / 180
  return [
    {
      dirX: Math.cos(angle),
      dirZ: Math.sin(angle),
      k,
      omega: Math.sqrt(G * k),
      amp: INSPECT.simpleAmpM,
      q: INSPECT.simpleSteepness / (k * INSPECT.simpleAmpM),
      phase: 0,
    },
  ]
}

/** The live field. One array; the GPU uniforms and the CPU sampler both read it. */
export const waves = INSPECT.simpleSea ? simpleSeaWaves() : generateWaves(activeField)

/**
 * THE GPU MIRROR of `waves` — one set of objects, shared by every material
 * that embeds wavesGlsl().
 *
 * Shared rather than copied because copies were exactly the bug: the
 * caustic map, foam sim and mist field each built their own arrays at
 * construction, so a live field change reached the water and nothing else.
 * The caustics went on refracting a storm under a calm sea. One array
 * means a future module cannot forget to update.
 */
export const waveUniformA = waves.map(
  (w) => new THREE.Vector4(w.dirX, w.dirZ, w.k, w.omega),
)
export const waveUniformB = waves.map(
  (w) => new THREE.Vector3(w.amp, w.q, w.phase),
)

/**
 * MEASURED PROPERTIES of the live field — what effects should key on,
 * rather than the raw config values that produced it.
 *
 * `chop` is deliberately included but is the weakest of these: q is
 * defined as chop / (k * amp * N), so sum(q * amp * k) equals chop by
 * construction. It is a normalised fold BUDGET describing how sharpness
 * was distributed, not how big or steep the water is — which is why an
 * effect keyed on it tracks the sea only loosely.
 *
 * rmsSlope is usually the one worth reaching for: slope is amplitude x
 * wavenumber, so it folds wave size and wavelength into a single number,
 * and it is the quantity real surface optics is written in.
 */
export const seaMetrics = {
  /** RMS wave height, metres. */
  sigAmp: 0,
  /** RMS surface gradient. Dimensionless; ~0.02 glassy, ~0.35 storm. */
  rmsSlope: 0,
  /** The Gerstner fold budget. See the caveat above. */
  chop: 0,
  /** Wavelength of the largest component, metres. */
  domLambda: 0,
  windSpeed: 0,
}

function metricsOf(f: WaveFieldConfig, w: WaveParams[]) {
  let a2 = 0
  let mss = 0
  let dom = w[0]
  for (const x of w) {
    a2 += x.amp * x.amp
    // Each component contributes (amp * k)^2 / 2 to the mean square slope.
    mss += (x.amp * x.k * (x.amp * x.k)) / 2
    if (x.amp > dom.amp) dom = x
  }
  return {
    sigAmp: Math.sqrt(a2),
    rmsSlope: Math.sqrt(mss),
    chop: f.chop,
    domLambda: (2 * Math.PI) / dom.k,
    windSpeed: f.windSpeed ?? 5,
  }
}

function computeMetrics() {
  Object.assign(seaMetrics, metricsOf(activeField, waves))
}
computeMetrics()

/**
 * The two ends every metric is normalised against, measured off the calm
 * and storm presets. Fixed reference points, so a weight of 0.5 means the
 * same thing for slope as for amplitude despite one being radians and the
 * other metres.
 */
export const SEA_REFERENCE = {
  calm: metricsOf(SEA_PRESETS.calm, generateWaves(SEA_PRESETS.calm)),
  storm: metricsOf(SEA_PRESETS.storm, generateWaves(SEA_PRESETS.storm)),
}

/**
 * Where this sea sits on a 0 (calm) to 1 (storm) axis, as a weighted mix
 * of normalised metrics. Weights need not sum to 1; they are divided out.
 *
 * This is what lets an effect say "follow slope" or "mostly slope, a
 * little size" instead of picking a threshold pair in some metric's own
 * units and hoping it generalises.
 */
export function seaDrive(wSlope: number, wAmp: number, wChop: number): number {
  const total = wSlope + wAmp + wChop
  if (total <= 0) return 0
  const n = (v: number, a: number, b: number) =>
    b === a ? 0 : Math.min(Math.max((v - a) / (b - a), 0), 1)
  const R = SEA_REFERENCE
  return (
    (wSlope * n(seaMetrics.rmsSlope, R.calm.rmsSlope, R.storm.rmsSlope) +
      wAmp * n(seaMetrics.sigAmp, R.calm.sigAmp, R.storm.sigAmp) +
      wChop * n(seaMetrics.chop, R.calm.chop, R.storm.chop)) /
    total
  )
}

function syncWaveUniforms() {
  for (let i = 0; i < waves.length; i++) {
    waveUniformA[i].set(
      waves[i].dirX,
      waves[i].dirZ,
      waves[i].k,
      waves[i].omega,
    )
    waveUniformB[i].set(waves[i].amp, waves[i].q, waves[i].phase)
  }
}

/**
 * Typical crest height (RMS sum): use for normalizing height-based color.
 * The straight sum overstates it badly since components rarely align.
 */
/**
 * Fastest the surface can rise anywhere, metres per second: the sum of
 * each component's peak vertical speed (amp * omega), reached only if
 * every one crested together.
 *
 * Used to extrapolate a stale surface sample forward in time — knowing
 * how far the water can possibly have come up since a droplet last
 * looked. The GLOBAL height bound this replaced (the straight amplitude
 * sum) was measured doing nothing at all: 90,609 landing checks, 0
 * skipped, because 24 components never crest at once, so the bound sat
 * 2m above anything the sea actually does.
 */
export let maxSurfaceRate = waves.reduce(
  (s, w) => s + Math.abs(w.amp * w.omega),
  0,
)

/**
 * Surface height only, without allocating.
 *
 * sampleSurface returns a fresh object and sampleOcean spreads it into
 * another; at a few thousand droplets a frame that is tens of thousands of
 * short-lived objects, which showed up as multi-second GC pauses. Callers
 * that need the full sample still get it — this is for the hot paths that
 * only ever read .height.
 */
export function surfaceHeight(
  x: number,
  z: number,
  t: number,
  ampScale = 1,
  iterations = 3,
): number {
  let u = x
  let v = z
  for (let i = 0; i < iterations; i++) {
    // displace() writes into a module scratch, so this loop allocates
    // nothing. Do not hold the returned object across a second call.
    const d = displace(u, v, t, ampScale)
    u = x - d.x
    v = z - d.z
  }
  return displace(u, v, t, ampScale).y
}

export const significantAmplitude = Math.sqrt(
  waves.reduce((s, w) => s + w.amp * w.amp, 0),
)

/** Caustic-only capillary band; see the `capillary` config doc above. */
const CAPILLARY_DEFAULTS = {
  count: 5,
  // True pool scale: curvature A*k^2 ~ 2 gives a focal depth ~1.5m, so
  // caustics are fully formed just below the surface like the reference.
  minLambda: 0.25,
  maxLambda: 0.8,
  slope: 0.022,
}

const capillaries = (() => {
  const cfg = { ...CAPILLARY_DEFAULTS, ...(activeField.capillary ?? {}) }
  const rand = mulberry32(activeField.seed + 101)
  const out: {
    dirX: number
    dirZ: number
    k: number
    omega: number
    /** amp * k^2: this wave's curvature (lens strength). */
    ak2: number
    phase: number
  }[] = []
  for (let i = 0; i < cfg.count; i++) {
    const f = (i + 0.3 + rand() * 0.4) / cfg.count
    const lambda = cfg.minLambda * Math.pow(cfg.maxLambda / cfg.minLambda, f)
    const k = (2 * Math.PI) / lambda
    const angle = rand() * Math.PI * 2 // near-isotropic: capillaries scatter
    const amp = ((cfg.slope * lambda) / (2 * Math.PI)) * (0.75 + rand() * 0.5)
    out.push({
      dirX: Math.cos(angle),
      dirZ: Math.sin(angle),
      k,
      omega: Math.sqrt(G * k),
      ak2: amp * k * k,
      phase: rand() * Math.PI * 2,
    })
  }
  return out
})()

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

/**
 * SIN/COS TABLE for the CPU wave sum.
 *
 * displace() is the hot path behind every CPU surface query — buoyancy,
 * the whitecap scan, and above all the per-droplet landing check, which
 * measured as the single largest cost in a storm frame. It calls Math.sin
 * and Math.cos once each per wave, and those are slow enough in V8 to be
 * the bulk of the work at 24 components.
 *
 * A 4096-entry table with linear interpolation is 2.5x faster end to end
 * and wrong by 0.002mm at worst — nine orders of magnitude below anything
 * that matters here, and far below the centimetre grade the 1-iteration
 * sampler already accepts.
 *
 * Index arithmetic uses int32 masking, so it stays exact while
 * |theta| * 652 < 2^31 — about a day of continuous wave time. Past that
 * the index would wrap wrongly; nothing in this game runs that long, and
 * the alternative (a modulo per wave per call) costs most of the win.
 */
// Exported so the other CPU wave sums (spray.ts's loopFrame, the hottest
// loop in the game) can use the same table inline, without paying a
// function call per wave.
export const TRIG_BITS = 12
export const TRIG_N = 1 << TRIG_BITS
export const TRIG_MASK = TRIG_N - 1
export const SIN_TABLE = new Float64Array(TRIG_N)
export const COS_TABLE = new Float64Array(TRIG_N)
for (let i = 0; i < TRIG_N; i++) {
  const a = (i / TRIG_N) * Math.PI * 2
  SIN_TABLE[i] = Math.sin(a)
  COS_TABLE[i] = Math.cos(a)
}
export const TRIG_SCALE = TRIG_N / (Math.PI * 2)

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
    // Table lookup with one lerp; see SIN_TABLE above.
    const f = theta * TRIG_SCALE
    const i0 = Math.floor(f)
    const fr = f - i0
    const ia = i0 & TRIG_MASK
    const ib = (i0 + 1) & TRIG_MASK
    const c = COS_TABLE[ia] + (COS_TABLE[ib] - COS_TABLE[ia]) * fr
    const s = SIN_TABLE[ia] + (SIN_TABLE[ib] - SIN_TABLE[ia]) * fr
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
/**
 * sampleSurface into a caller-owned object, allocating nothing.
 *
 * For loops that sample thousands of points per step — the loop-splash
 * scan above all — where the returned object is read immediately and
 * thrown away. Callers holding two samples at once need two buffers.
 */
export function sampleSurfaceInto(
  out: SurfaceSample,
  x: number,
  z: number,
  t: number,
  ampScale = 1,
  iterations = 3,
): SurfaceSample {
  let u = x
  let v = z
  for (let i = 0; i < iterations; i++) {
    const d = displace(u, v, t, ampScale)
    u = x - d.x
    v = z - d.z
  }
  const d = displace(u, v, t, ampScale)
  out.height = d.y
  out.swayX = d.x
  out.swayZ = d.z
  out.jacobian = d.jxx * d.jzz - d.jxz * d.jxz
  return out
}

/**
 * Surface height at a REST-space point — a direct forward evaluation, no
 * inversion at all, so it is smooth in (u, v, t) everywhere including
 * folds. For gradients and probes anchored to a tracked rest point;
 * heights at a WORLD point still need sampleSurface.
 */
export function restHeight(u: number, v: number, t: number, ampScale = 1): number {
  return displace(u, v, t, ampScale).y
}

/**
 * The water's own horizontal ORBITAL velocity at a rest point — the exact
 * time-derivative of the Gerstner displacement, not a finite difference.
 * A difference taken along a MOVING sample track measures boatVelocity x
 * grad(sway) as well (with frozen waves, ONLY that), which once pushed a
 * driving boat along crest lines instead of with the wave's momentum.
 * The analytic form is phase-locked to elevation: strongest forward flow
 * at the crest, backward in the trough, zero mid-face.
 */
export function orbitalVelocityInto(
  out: { x: number; z: number },
  u: number,
  v: number,
  t: number,
  ampScale = 1,
  depth = 0,
): void {
  let vx = 0
  let vz = 0
  for (const w of waves) {
    const theta = (u * w.dirX + v * w.dirZ) * w.k - w.omega * t + w.phase
    // Deep-water orbits shrink as e^(-k depth) — PER COMPONENT, so a
    // submerged hull stops feeling the chop (large k dies within a
    // metre) while the long swell still reaches it. The textbook
    // decaying-circles picture, exact because the sum is per-wave.
    const s = Math.sin(theta) * w.q * w.amp * w.omega * Math.exp(-w.k * depth)
    vx += s * w.dirX
    vz += s * w.dirZ
  }
  out.x = vx * ampScale
  out.z = vz * ampScale
}

/**
 * Surface slope at a rest point, LOW-PASSED by wavelength: components
 * shorter than minLambda/2 contribute nothing, ramping to full weight at
 * minLambda. For hull physics — a boat bridges waves shorter than
 * itself, its waterline averaging their slopes away, while a long swell
 * tilts the whole vessel and slides it. Analytic, so the filter is exact
 * per component instead of an averaging baseline's sinc-shaped guess.
 */
export function filteredSlopeInto(
  out: { x: number; z: number },
  u: number,
  v: number,
  t: number,
  minLambda: number,
  ampScale = 1,
): void {
  let sx = 0
  let sz = 0
  const twoPi = Math.PI * 2
  for (const w of waves) {
    const lambda = twoPi / w.k
    const t01 = Math.min(Math.max((lambda - minLambda * 0.5) / (minLambda * 0.5), 0), 1)
    if (t01 <= 0) continue
    const g = t01 * t01 * (3 - 2 * t01)
    const theta = (u * w.dirX + v * w.dirZ) * w.k - w.omega * t + w.phase
    const c = Math.cos(theta) * w.amp * w.k * g
    sx += c * w.dirX
    sz += c * w.dirZ
  }
  out.x = sx * ampScale
  out.z = sz * ampScale
}

/**
 * Rest-point state for sampleSurfaceTracked: one per floating object,
 * carried across frames.
 */
export type TrackedRest = { u: number; v: number }

/**
 * sampleSurface with MEMORY: the inversion starts from last frame's
 * solution and is damped, so a floater follows one continuous sheet of
 * the surface instead of re-choosing every frame.
 *
 * Above chop ~1 the surface folds and the rest->world map turns
 * multi-sheeted. The plain cold-start iteration neither converges nor
 * picks a sheet consistently there — measured on the storm, its answer
 * was 0.52m of rest-point error on average, with frame-to-frame height
 * hops of 0.45m as it wandered between sheets (and MORE iterations make
 * that worse, not better: each one is another chance to hop). Warm
 * damped tracking cuts the mean error to 0.007m. The genuine jumps that
 * remain — a fold passing over the point annihilates the sheet being
 * ridden — are the caller's to rate-limit, since they are real surface
 * behaviour, not solver noise.
 */
export function sampleSurfaceTracked(
  out: SurfaceSample,
  rest: TrackedRest,
  x: number,
  z: number,
  t: number,
  ampScale = 1,
): SurfaceSample {
  let u = rest.u
  let v = rest.v
  for (let i = 0; i < 4; i++) {
    const d = displace(u, v, t, ampScale)
    u += 0.7 * (x - d.x - u)
    v += 0.7 * (z - d.z - v)
  }
  // If tracking has drifted somewhere hopeless (teleported object, first
  // frame), fall back to a cold start rather than riding a stale sheet.
  const dchk = displace(u, v, t, ampScale)
  if (Math.hypot(u + dchk.x - x, v + dchk.z - z) > 2.5) {
    u = x
    v = z
    for (let i = 0; i < 4; i++) {
      const d = displace(u, v, t, ampScale)
      u += 0.7 * (x - d.x - u)
      v += 0.7 * (z - d.z - v)
    }
  }
  rest.u = u
  rest.v = v
  const d = displace(u, v, t, ampScale)
  out.height = d.y
  out.swayX = d.x
  out.swayZ = d.z
  out.jacobian = d.jxx * d.jzz - d.jxz * d.jxz
  return out
}

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
}

// Analytic surface slope at REST coordinates — the same tangent sums the
// water vertex shader accumulates, packaged for PER-PIXEL use. The
// vertex-interpolated slope is continuous but kinks at every quad edge,
// and refraction magnifies those kinks into quad-pitch streaks wherever
// the view path is a lens (the buoy at its waterline). Rest coordinates
// interpolate exactly (linear in the mesh), so evaluating here gives a
// genuinely smooth normal at any tessellation — the analytic equivalent
// of the pool reference's per-pixel normal texture.
vec2 waveSlope(vec2 p, float t, float ampScale) {
	float txx = 0.0;
	float txy = 0.0;
	float txz = 0.0;
	float tzy = 0.0;
	float tzz = 0.0;
	for (int i = 0; i < WAVE_COUNT; i++) {
		vec4 a = uWaveA[i];
		vec3 b = uWaveB[i];
		float theta = (p.x * a.x + p.y * a.y) * a.z - a.w * t + b.z;
		float sn = sin(theta);
		float cs = cos(theta);
		float qak = b.y * b.x * ampScale * a.z;
		float ak = b.x * ampScale * a.z;
		txx -= qak * a.x * a.x * sn;
		txy += ak * a.x * cs;
		txz -= qak * a.x * a.y * sn;
		tzy += ak * a.y * cs;
		tzz -= qak * a.y * a.y * sn;
	}
	vec3 Tu = vec3(1.0 + txx, txy, txz);
	vec3 Tv = vec3(txz, tzy, 1.0 + tzz);
	vec3 Na = cross(Tv, Tu);
	return -Na.xz / max(Na.y, 0.2);
}`
}

/**
 * Caustics from the real surface, for anything underwater (the backdrop,
 * the tuning sphere, eventually fish backs). Follow the sun ray from an
 * underwater point up to the surface and ask the Jacobian how much the
 * surface CONVERGES there: converging surface focuses light.
 *
 * Physically corrected for sea state: rough water scatters light, so
 * contrast falls with the sea's significant amplitude, and dies further
 * with depth. A storm therefore shows FAINT smeared dapples while calm
 * water shows crisp ones, not the other way around.
 *
 * Requires wavesGlsl() earlier in the same shader (uses waveJacobian).
 */
/**
 * A STANDING GERSTNER WAVE anchored to an object's waterline.
 *
 * Not a shaped deformation — a wave, in the same form as every wave in
 * the spectrum, so it folds for the same reason they do. Its horizontal
 * and vertical displacements are in QUADRATURE (cos against sin), which
 * is the whole point: that 90-degree offset is what makes material trace
 * circles and a crest throw forward over its own base. A disturbance
 * whose horizontal and vertical parts share a profile can only bunch and
 * wring sideways, however hard it is driven.
 *
 * Phase is set so the crest sits AT the waterline: radial displacement
 * is zero there (water is neither pushed into nor pulled off the hull)
 * while the height and the compression are both at maximum. Compression
 * peaking with the crest is correct — it is what an ordinary Gerstner
 * wave does too.
 *
 * FOLD CONDITION, exactly as for the spectrum: q * A * k > 1, i.e.
 *
 *   q * amp * 2*pi / wavelength > 1
 *
 * so short and steep folds where long and gentle only humps. Short also
 * keeps the pile small, which is what is wanted against a hull.
 *
 * Standing (no time term) because a moored object in a current holds its
 * bow wave still in the world frame. A moving hull generalises to
 * omega = k * U, which stands still in the hull's frame instead.
 */
export function objectWaveGlsl(o: {
  centre: [number, number, number]
  radius: number
  amp: number
  wavelength: number
  q: number
  reach: number
  windward: number
  flow: [number, number]
}): string {
  const k = (2 * Math.PI) / o.wavelength
  const f = (n: number) => n.toFixed(5)
  return `
vec3 objectWave(vec2 p, float surfY) {
	vec2 rel = p - vec2(${f(o.centre[0])}, ${f(o.centre[2])});
	float r = length(rel);
	if (r < 0.0001) return vec3(0.0);
	// The circle the surface cuts at this height: the wave is anchored to
	// the WATERLINE, so it rides up and down the hull as the swell passes.
	float dy = surfY - ${f(o.centre[1])};
	float ring = ${f(o.radius)} * ${f(o.radius)} - dy * dy;
	if (ring <= 0.0) return vec3(0.0);
	// max(), not an early return: a hard cut is a C0 discontinuity in the
	// displacement and shows as a crease along the whole waterline.
	float d = max(r - sqrt(ring), 0.0);
	vec2 n = rel / r;
	// Blend between a full ring and a nose-only wave. A hard angular mask
	// varies fast around the hull and its derivative is pure shear, which
	// is what reads as the mesh twisting; keeping some ring in the mix
	// keeps that gentle.
	// smoothstep, not max(): max() has a kink where it reaches zero, and
	// that kink runs right down the object's beam line.
	float face = mix(1.0, smoothstep(-0.15, 0.55, -dot(n, vec2(${f(o.flow[0])}, ${f(o.flow[1])}))), ${f(o.windward)});
	float env = exp(-d / ${f(o.reach)}) * face;
	float th = ${f(k)} * d;
	vec3 disp;
	// Quadrature: -sin radially, +cos vertically. At the hull that is
	// zero radial displacement and a full-height crest.
	disp.xz = n * (-${f(o.q * o.amp)} * sin(th) * env);
	disp.y = ${f(o.amp)} * cos(th) * env;
	return disp;
}`
}

/**
 * The object wave's SHADING slope, evaluated per pixel.
 *
 * The same split ripples use, and for the same reason. Geometry has to
 * carry the FOLD — no amount of shading can make a surface overturn —
 * but it does not have to carry the shading. Left to the vertex frame
 * alone this wave's normal is interpolated linearly across each quad,
 * and at a 3m wavelength against 0.5m quads that is six samples per
 * wave, which reads as flat facets. Recomputing the slope here decouples
 * how it SHADES from how finely it is tessellated.
 */
export function objectWaveSlopeGlsl(): string {
  return `
vec2 objectWaveSlope(vec2 p, float surfY) {
	float e = 0.06;
	float h = objectWave(p, surfY).y;
	return vec2(
		objectWave(p + vec2(e, 0.0), surfY).y - h,
		objectWave(p + vec2(0.0, e), surfY).y - h
	) / e;
}`
}

export function causticsGlsl(): string {
  const seaScatter = (1 / (1 + significantAmplitude * 1.2)).toFixed(3)
  const f = (n: number) => n.toFixed(6)
  // Baked capillary Hessian terms (static per preset).
  const capLines = capillaries
    .map(
      (c) =>
        `\ttheta = (p.x * ${f(c.dirX)} + p.y * ${f(c.dirZ)}) * ${f(c.k)} - ${f(c.omega)} * t + ${f(c.phase)};\n` +
        `\tcs = sin(theta) * ${f(c.ak2)};\n` +
        `\thxx -= cs * ${f(c.dirX * c.dirX)}; hzz -= cs * ${f(c.dirZ * c.dirZ)}; hxz -= cs * ${f(c.dirX * c.dirZ)};`,
    )
    .join('\n')
  return `
// Refractive caustics, faithful to the pool reference: light bends through
// the surface by its normal; the floor-mapping's area change is
// det(I + depth * eta * H) with H the height field's HESSIAN (curvature).
// Curvature per wave is A*k^2, so fine ripples dominate BY PHYSICS.
// Composable: consumers accumulate Hessian terms from the ambient field
// (here) and the interactive ripple texture (rippleCausticGlsl), then
// shade the combined curvature, so buoy rings and splashes bend light
// exactly like the pool's drop rings do.

vec2 causticEntry(vec2 pointXZ, float depth, vec3 sunDir) {
	vec3 sun = normalize(sunDir);
	return pointXZ + (sun.xz / max(sun.y, 0.25)) * depth;
}

void ambientCausticHessian(vec2 p, float t, float ampScale,
	inout float hxx, inout float hzz, inout float hxz) {
	float theta;
	float cs;
	for (int i = 0; i < WAVE_COUNT; i++) {
		vec4 a = uWaveA[i];
		vec3 b = uWaveB[i];
		theta = (p.x * a.x + p.y * a.y) * a.z - a.w * t + b.z;
		cs = sin(theta) * (b.x * ampScale * a.z * a.z);
		hxx -= cs * a.x * a.x;
		hzz -= cs * a.y * a.y;
		hxz -= cs * a.x * a.y;
	}
${capLines}
}

float causticShade(float hxx, float hzz, float hxz, float depth) {
	float bend = depth * 0.25; // refraction lever arm, eta ~ 1 - 1/1.33
	// det(I - bend * H): the Jacobian of the refracted surface-to-receiver
	// map (rays bend DOWN the gradient), consistent with refractedEntry.
	float det = (1.0 - bend * hxx) * (1.0 - bend * hzz) - bend * bend * hxz * hxz;
	// abs(det): past the focal distance rays have CROSSED; the pattern
	// stays bright near every fold rather than exploding once and pegging.
	// The high clamp keeps razor filaments as lines, not plateaus.
	float focus = clamp(1.0 / max(abs(det), 0.05) - 1.0, -0.85, 8.0);
	// Pixel-integrated fold diffusion: deep below the focal distance the
	// folds are denser than a pixel, and the true pixel-average washes
	// toward a soft glow. fwidth(det) measures exactly that in-pixel
	// churn, so this one term is BOTH the anti-aliasing and the physical
	// post-focal blur (deeper = dimmer, like the pool floor), and it is
	// resolution-adaptive by construction. Near-focal filaments where det
	// is smooth pass through untouched.
	focus /= 1.0 + fwidth(det) * 60.0;
	return focus * ${seaScatter};
}

float causticAt(vec2 pointXZ, float depth, vec3 sunDir, float t, float ampScale) {
	vec2 p = causticEntry(pointXZ, depth, sunDir);
	float hxx = 0.0;
	float hzz = 0.0;
	float hxz = 0.0;
	ambientCausticHessian(p, t, ampScale, hxx, hzz, hxz);
	return causticShade(hxx, hzz, hxz, depth);
}`
}
