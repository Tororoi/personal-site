/**
 * TUNING: every art-directable number for the white-water systems, in
 * one place, grouped by the effect it belongs to.
 *
 * These are baked into shader source at material-build time (the values
 * are interpolated as GLSL literals), so changes take a reload — but
 * they live together, named, instead of scattered as bare literals
 * through a thousand lines of shader string.
 *
 * Physical constants and simulation invariants deliberately stay where
 * they are: the wave spectrum in waves.ts, the foam field's decay
 * clocks in foam.ts, the fluid solver's parameters in mistfield.ts.
 * This file is for the LOOK of the crest white water.
 */

/** GLSL literal helper: GLSL needs `1.0`, JS prints `1`. */
export const f = (n: number, digits = 4) => n.toFixed(digits)

/**
 * FOAM SPRITES — the white masses that surface as a crest overturns.
 * They live on a rest-space lattice under the water and are revealed by
 * the fold; size and visibility are driven by which wave is folding
 * (amplitude ratio) and how hard (pinch intensity).
 */
export const SPRITE = {
  /** Anchor lattice spacing, metres. Denser = more masses. */
  lattice: 0.33,
  /** Baked radius before scaling: base + jitter, metres. */
  radiusBase: 0.9,
  radiusVar: 0.36,

  /** Emergence gate on the Jacobian: fully out below `gateJFull`. */
  gateJFull: 0.08,
  gateJStart: 0.6,
  /** Seconds of lag for the release tail (a second, older Jacobian). */
  gateLag: 0.35,
  /** How much of the lagged gate survives (0-1). */
  gateLagWeight: 0.9,

  /** Size ceiling from the folding wave's amplitude ratio. */
  ampRatioFloor: 0.3,
  /** Pinch intensity window: J from `intJStart` down over `intJSpan`. */
  intJStart: 0.1,
  intJSpan: 0.55,
  /** Intensity's contribution range. */
  intFloor: 0.4,

  /** Response curve: boosts the medium-and-up range, never shrinks. */
  curveBoost: 0.5,
  curveStart: 0.15,
  curveEnd: 0.55,
  /** Hard ceiling on the combined size factor. */
  sizeCap: 1.2,

  /** Generation threshold on the combined factor (no sprite below). */
  visStart: 0.1,
  visFull: 0.42,

  /** Dynamic density: keep-fraction falls as sprite size rises. */
  densMax: 1.0,
  densMin: 0.55,
  densStart: 0.15,
  densEnd: 0.5,
  /** Softness of the density cut, in rank units. */
  densSoft: 0.1,

  /** Sprites smaller than this (metres) are culled as noise. */
  cullRadius: 0.07,
  /** How deep the sprite centre sits under the surface, x radius. */
  submersion: 0.8,
} as const

/**
 * CREST PLUMES — vertical spray thrown off each foam sprite. Drawn as a
 * second pass over the same points: the quad is enlarged upward and the
 * fragment paints a plume above the bubble. Driven by MOMENTUM (the
 * water's own orbital velocity), not wind.
 */
export const PLUME = {
  /** Quad enlargement over the bubble: sets maximum reach. */
  quadScale: 2.4,

  /** Amplitude (reach x density) at rest, and at `speedFull`. */
  ampIdle: 0.5,
  ampFull: 1.25,
  /** Orbital speed (m/s) at which amplitude saturates. */
  speedFull: 8.0,

  /** Burst envelope: height window over which spray is allowed. */
  burstHeightStart: -0.1,
  burstHeightFull: 0.55,
  /** How sharply the throw builds once the surface starts falling. */
  fallRamp: 3.0,
  /** Strength while the water is still RISING (0-1). */
  risingStrength: 0.5,

  /** Trailing lean opposite the sprite's motion (quad units). */
  leanStrength: 1.0,
  /** Slow per-sprite wander of the plume. */
  swayAmp: 0.09,
  swayRate: 1.7,
  swayHeightPhase: 2.6,

  /** Plume half-width at the base and how much it grows with height. */
  widthBase: 0.75,
  widthGrowth: 4.5,

  /** Wispy breakup: streak frequency/scroll per m/s of orbital speed. */
  tatterFreq: 0.9,
  tatterScroll: 0.4,
  /** Visibility threshold climb per m/s, and its cap. */
  tatterThresh: 0.018,
  tatterThreshCap: 0.05,
  /** Base streak density (frequency and scroll at zero speed). */
  wispFreq: 0.03,
  wispScroll: 0.3,
  wispRows: 5.0,
  /** Threshold window for a streak to appear. */
  wispCut: 0.05,
  wispCutEnd: 0.9,

  /** Overall opacity multiplier. */
  alpha: 0.85,
  /** Fragments below this alpha are discarded. */
  alphaCull: 0.02,
} as const

/**
 * LOOP WHITENING & STRETCH — the water surface's own response to a
 * fold: the white ribbon, and the pull toward the sprite plane that
 * hides the fold's leading sliver.
 */
export const LOOP = {
  /** Jacobian ramp for whiteness (0 = fully white at collapse). */
  whiteJRamp: 0.04,
  /** Overhang (normalised normal y) ramp for the rolling tongue. */
  whiteTiltStart: 0.02,
  whiteTiltFull: 0.12,

  /** Stretch gate: how far ahead of collapse the pull begins. */
  stretchJRamp: 0.3,
  /** Pull depth as a fraction of the local sprite radius. */
  stretchDepth: 0.8,
  /** Mean baked sprite radius used to size the pull, metres. */
  stretchSpriteR: 1.08,
  /** Pull direction: horizontal weight against the heading, and down. */
  stretchBack: 0.8,
  stretchDown: 0.65,

  /** Near-binary gate: pinches below the sprite criterion stay dark. */
  gateStart: 0.1,
  gateFull: 0.16,
} as const
