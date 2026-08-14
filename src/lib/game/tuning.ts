/**
 * TUNING: every art-directable number for the white-water systems, in
 * one place, grouped by the effect it belongs to.
 *
 * These are baked into shader source at material-build time (the values
 * are interpolated as GLSL literals), so changes take a reload — but
 * they live together, named, instead of scattered as bare literals
 * through a thousand lines of shader string.
 *
 * The wave SPECTRUM stays in waves.ts (it defines the sea itself, and
 * each preset owns its bands); everything downstream of it — the white
 * water's look AND its physics — lives here.
 */

/** GLSL literal helper: GLSL needs `1.0`, JS prints `1`. */
export const f = (n: number, digits = 4) => n.toFixed(digits)

/**
 * MASTER SWITCHES — turn each effect off to see the others in
 * isolation. Shader-side flags bake in at material build (reload to
 * apply); CPU-side ones take effect immediately.
 */
export const ENABLE = {
  /** White ribbon on the folding mesh itself. */
  loopWhite: true,
  /** Pull of the pinch zone toward the sprite plane. */
  loopStretch: true,
  /** Foam masses surfacing from under the fold. */
  foamSprites: true,
  /** Vertical spray thrown off each foam mass. */
  crestPlumes: true,
  /** Ballistic droplets launched from inside the loops. */
  splashDroplets: true,
  /** Spray kicked up by the buoys. */
  buoySpray: true,
  /** Persistent foam residue field (deposits from landings). */
  foamField: true,
  /** 2D fluid mist field and its overlay. */
  mist: false,
  /** Downslope gusts shaping the mist. */
  mistGusts: true,
  /** Whitecap EVENTS (crest bursts + drizzle). Off since the loop
   * study replaced them with loop-driven emission. */
  whitecapEvents: false,
} as const

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

/**
 * SPLASH DROPLETS — the ballistic clumps thrown from inside a loop.
 * Physics: pinned horizontally to the loop's advancing frame, gravity
 * owns the vertical (spray.ts).
 */
export const DROPLET = {
  /** Pool size. Exhaustion shows as missing spray, not a crash. */
  maxCount: 1280,
  /** m/s^2. Real gravity: these are water, not dust. */
  gravity: 9.8,
  /** Fraction of the wind a flying clump feels (0 = pure ballistics). */
  windCarry: 0.0,
  /** 1/s relaxation toward the carried wind (air drag). */
  drag: 1.4,
  /** Hard lifetime cap, s (landing is the real death). */
  lifeMax: 3,
  /** Art-scaled clump radii, m. */
  sizeMin: 0.07,
  sizeMax: 0.24,

  /** Loop scan: cadence (s), grid pitch and half-extent (m). */
  scanInterval: 0.1,
  scanStep: 1.6,
  scanExtent: 40,
  /** Jacobian below which a sample counts as a loop. */
  scanJ: 0.02,
  /** Depth normalisation for the emission-count curve. */
  depthSpan: 0.4,

  /** Hop RELATIVE to the loop frame: up, then forward. */
  hopUpMin: 0.3,
  hopUpVar: 0.3,
  hopFwdMin: 1.0,
  hopFwdVar: 1.0,

  /** Birth stagger (s): de-synchronises the 0.1s scan volleys. */
  birthStagger: 0.1,
  /** Render ease in/out (s) and death shrink. */
  growTime: 0.05,
  dieTime: 0.08,
  /** Motion streaking: stretch per m/s, and its cap. */
  streakPerSpeed: 0.1,
  streakCap: 2.1,
  /** Submersion test grace for young loop droplets (s): the surface is
   * multi-sheeted at a fold and insta-culled healthy spray. */
  submergeGrace: 0.25,
  /** Foam deposit radius: floor + per unit clump size. */
  depositBase: 0.13,
  depositPerSize: 0.5,
} as const

/**
 * FOAM FIELD — persistent residue left by droplet landings (foam.ts).
 * Decay clocks are exponential time constants in seconds.
 */
export const FOAM = {
  /** Thin foam's lifetime, s (the long linger). */
  decayThin: 12,
  /** Thick foam's, s: peaks erode faster so mounds flatten. */
  decayThick: 4,
  /** Turbulence window on the Jacobian probe. */
  turbJStart: 0.28,
  turbJFull: -0.15,
  /** Spread rate: AREA growth, not decay, is the main thinning force. */
  diffusion: 0.88,
  /** Flat evaporation per step, x(1 + 5*turb). */
  evaporation: 0.0002,
  /** Drift as a fraction of wind speed. */
  drift: 0.05,
  /** Soft capacity: above `overloadStart` mass, thin foam's decay
   * accelerates toward `decayOld`, saturating at `overloadFull`. */
  decayOld: 3,
  overloadStart: 200,
  overloadFull: 400,
  /** Web render: density remap window and cell sizes (m). */
  densStart: 0.04,
  densEnd: 0.65,
  cellFine: 0.4,
  cellCoarse: 2.2,
} as const

/**
 * MIST FIELD — the 2D fluid solver (mistfield.ts) and its sources.
 */
export const MIST = {
  /** Domain width, m, and grid resolutions. */
  extent: 100,
  simRes: 128,
  dyeRes: 256,
  /** Jacobi iterations for the pressure solve. */
  pressureIters: 12,
  /** 1/s exponential dissipation. */
  velDissipation: 0.4,
  dyeDissipation: 0.55,
  /** Vorticity confinement: the billowing curls. */
  vorticity: 14,
  /** Steady wind coupling: fraction carried, and grip 1/s. */
  windCarry: 0.45,
  windGrip: 0.5,
  /** Gusts: downslope acceleration on wave BACKS, and the swirl boost. */
  gustSlide: 50,
  gustSwirl: 0.9,
  /** Gust timing, s. */
  gustGapMin: 6,
  gustGapVar: 10,
  gustDurMin: 1.2,
  gustDurVar: 2.0,
  /** Spume injectors: dye per second at full strength, and how many
   * injectors are fed per frame. */
  spumeRate: 1.0,
  spumePerFrame: 8,
  /** Share of the feed dumped as a tight plume at the crest. */
  spumeCrestShare: 0.65,
  /** Overlay: opacity response and brightness window. */
  opacityGain: 3.2,
  brightStart: 0.35,
  brightEnd: 1.1,
  /** Height the overlay plane hovers above the surface, m. */
  hover: 0.3,
} as const
