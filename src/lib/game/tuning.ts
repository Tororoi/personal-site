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
  /** Froth masses surfacing from under the fold. */
  froth: true,
  /** Vertical spray thrown off each foam mass. */
  crestPlumes: false,
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
 * FROTH — the white masses that surface as a crest overturns.
 * They live on a rest-space lattice under the water and are revealed by
 * the fold; size and visibility are driven by which wave is folding
 * (amplitude ratio) and how hard (pinch intensity). Named froth rather
 * than "sprites" (several systems are sprites now) and rather than
 * "bubbles" (saved for a future underwater effect).
 */
export const FROTH = {
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

  /** Generation threshold on the combined factor (nothing below). */
  visStart: 0.1,
  visFull: 0.42,

  /** Dynamic density: keep-fraction falls as froth size rises. */
  densMax: 1.0,
  densMin: 0.55,
  densStart: 0.15,
  densEnd: 0.5,
  /** Softness of the density cut, in rank units. */
  densSoft: 0.1,

  /** Masses smaller than this (metres) are culled as noise. */
  cullRadius: 0.07,
  /** How deep a mass's centre sits under the surface, x radius. */
  submersion: 0.8,
  /**
   * How much of the WATER's normal a froth mass's lighting takes,
   * 0-1. 0 = all face straight up and share one shade;
   * 1 = the raw surface normal, which at a fold points sideways or
   * down and drops them into the dark half of the ambient. The tilt
   * is the only reason froth masses differ in brightness.
   */
  normalTilt: 0,
} as const

/**
 * CREST PLUMES — vertical spray thrown off each foam sprite. Drawn as a
 * second pass over the same points: the quad is enlarged upward and the
 * fragment paints a plume above the bubble. Driven by MOMENTUM (the
 * water's own orbital velocity), not wind.
 */
export const PLUME = {
  /**
   * The plume's reach above the bubble, in bubble RADII — its actual
   * height, and the ONLY size knob. The sprite quad is derived from it
   * where it is used (1 bubble + reach/2), since a quad taller than the
   * reach is wasted fill and a shorter one cuts the plume off.
   */
  reachRadii: 3.8,
  /**
   * Where the plume's base sits on the bubble: 0 = the bubble's top,
   * 1 = its centre. Rooting it partway down overlaps the foam mass so
   * the spray grows OUT of it rather than balancing on its crown.
   */
  rootDepth: 0,
  /**
   * How much of the plume's shape is actually DRAWN, 0-1 of reach.
   * Shape and visible height are different things: cutting a tall plume
   * at 0.4 shows the broad, still-widening lower body (what the old
   * quad-edge crop did), whereas shrinking reachRadii to the same
   * height compresses the whole cone — taper and all — into it. Keep
   * reachRadii for the SHAPE and use this for the CUT.
   */
  clipFrac: 1.0,

  /** Amplitude (reach x density) at rest, and at `speedFull`. */
  ampIdle: 0.5,
  ampFull: 1.25,
  /** Orbital speed (m/s) at which amplitude saturates. Scales with the
   * preset's timeScale: slowing the sea lowers every orbital speed, so
   * this must come down with it or plumes shrink. */
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
  /** How hard a GUST rakes the plume, per m/s of gust wind. Plumes see
   * only the gust component, never the base breeze. */
  gustLean: 0.06,
  /** Slow per-sprite wander of the plume. */
  swayAmp: 0.09,
  swayRate: 1.7,
  swayHeightPhase: 2.6,

  /** Plume half-width at the base and how much it grows with height. */
  widthBase: 1.75,
  widthGrowth: 2.5,

  /**
   * RISE SPEED — how fast the spray appears to travel UP the plume.
   * This is the streak pattern scrolling along the plume's height, and
   * it is the dominant cue for "how fast is this spraying". Rows per
   * second at rest, plus rows per second per m/s of orbital speed (the
   * speed term dominates: 8 m/s water multiplies it by 8).
   */
  riseBase: 4.0,
  /** Kept at 0: momentum drives HEIGHT and PULL, not animation speed. */
  risePerSpeed: 1.0,
  /** Streak structure: rows up the plume, columns across it. */
  wispRows: 5.0,
  wispFreq: 4.0,
  /**
   * MOMENTUM COUPLINGS on the streak texture, both zero by default.
   * They were the hidden reason momentum still "sped things up": more
   * columns and a higher flicker threshold make the same rise rate read
   * as busier, faster churn. Raise them only if you want fast water to
   * look visibly grainier.
   */
  tatterFreq: 0.0,
  tatterThresh: 0.0,
  tatterThreshCap: 0.05,
  /** Threshold window for a streak to appear. */
  /**
   * Threshold window for a streak to appear. NARROW = coarse spray:
   * cells flip on and off crisply, reading as flecks of water. WIDE
   * (e.g. 0.05-0.9) fades every cell in gradually, which is what made
   * the plumes look smooth and airbrushed.
   */
  wispCut: 0.5,
  wispCutEnd: 0.9,
  /**
   * How much the plume's solid body pushes cells over the threshold.
   * High values fill the core in solid; low values let the speckle
   * reach all the way through the middle.
   */
  bodyBias: 0.4,

  /**
   * COHERENCE (0-1): how much the streak pattern is anchored in WORLD
   * space rather than randomised per sprite. At 0 (the current choice)
   * every plume has its own phase and reads as an individual throw; at
   * 1 neighbours share the pattern and merge into one sheet.
   */
  coherence: 0.0,
  /** World-space frequency of the shared pattern, cells per metre. */
  coherenceScale: 1.4,

  /** Soft fade at the top of the throw instead of a hard clip. */
  tipFade: 0.25,
  /** Dissolve width at the sprite quad's edge (0-0.5 in quad units).
   * Needs to be generous: the plume's own width plus its lean often
   * exceeds the quad, and a narrow fade only softens the cut. */
  edgeFade: 0.3,

  /** Overall opacity multiplier. */
  alpha: 1.0,
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
  /** Mean baked froth radius used to size the pull, metres. */
  stretchFrothR: 1.08,
  /** Pull direction: horizontal weight against the heading, and down. */
  stretchBack: 0.8,
  stretchDown: 0.65,

  /** Near-binary gate: pinches below the sprite criterion stay dark. */
  gateStart: 0.1,
  gateFull: 0.16,
} as const

/**
 * WIND — two components. The BASE is the steady breeze: it sets the
 * mean drift of mist and foam and barely changes. GUSTS are episodic
 * and violent, arriving at a noticeably different angle and outrunning
 * the base wind while they last. `windVector` is their sum, so existing
 * consumers see one wind; the crest plumes read the GUST alone, so
 * spray whips only when a gust is actually blowing through.
 */
export const WIND = {
  /** Base wander: slow heading drift, radians. */
  baseWander: 0.22,
  /** Slow multi-sine breathing on the base speed (fraction). */
  baseBreath: 0.18,

  /** Mean seconds between gust onsets. */
  gustCycle: 8,
  /** Fraction of the cycle a gust lasts (min + random var). */
  gustDurMin: 0.1,
  gustDurVar: 0.15,
  /** Gust heading offset from the base wind, radians (sign random). */
  gustTurnMin: 0,
  gustTurnVar: 2.1,
  /** Gust strength as a multiple of base wind speed. */
  gustSpeedMin: 1.4,
  gustSpeedVar: 1.6,
} as const

/**
 * SURFACE CURRENT — the slow bulk drift of the water itself, distinct
 * from wind. Wind pushes what sits ON the surface; the current moves the
 * surface. For now only foam rides it, but it is the natural anchor for
 * anything that should drift with the water (flotsam, a drifting boat,
 * a cast line) rather than with the air.
 */
export const CURRENT = {
  /**
   * Default speed, m/s (real coastal surface currents run 0.1-0.5).
   * DIRECTION is per-preset: each sea sets `surfaceCurrentHeading` in
   * waves.ts (the same frame as windAngle), because an opposing current
   * is what stands a storm sea up short and steep. A preset may also
   * override the speed with `surfaceCurrentSpeed`.
   */
  speed: 0.25,
  /** Slow meander of the set, radians, over minutes. */
  meander: 0.35,
  /** Fractional breathing of the drift rate. */
  breath: 0.25,
} as const

/**
 * SPLASH DROPLETS — the ballistic parcels of water thrown from inside a
 * loop. Each one stands for a fist-to-head-sized gout, not a literal
 * droplet: at 26 px/m a real droplet is a fraction of a pixel. The code
 * says DROPLET throughout; "clump" is gone.
 * Physics: pinned horizontally to the loop's advancing frame, gravity
 * owns the vertical (spray.ts).
 */
export const DROPLET = {
  /**
   * Pool size. Exhaustion shows as missing spray, not a crash — and it
   * WAS exhausting (43k failed allocations a run) once small froth
   * masses started throwing. Cheap to raise now that a droplet is a
   * single point-sprite vertex rather than an instanced octahedron.
   */
  maxCount: 4096,
  /** m/s^2. Real gravity: these are water, not dust. */
  gravity: 9.8,
  /** Fraction of the wind a flying clump feels (0 = pure ballistics). */
  windCarry: 0.0,
  /** 1/s relaxation toward the carried wind (air drag). */
  drag: 1.4,
  /** Hard lifetime cap, s (landing is the real death). */
  lifeMax: 3,
  /** Art-scaled droplet radii, m — a visible parcel, not a raindrop. */
  sizeMin: 0.04,
  sizeMax: 0.17,

  /** Loop scan: cadence (s), grid pitch and half-extent (m). */
  scanInterval: 0.1,
  scanStep: 1.6,
  scanExtent: 40,
  /**
   * Jacobian below which a scan sample is recorded. This must reach at
   * least FROTH.gateJStart, or froth that exists is invisible to the
   * droplet system: at 0.02 the scan only saw water already at the
   * point of collapse, while froth appears from J < 0.6 — so every
   * small and mid-sized froth mass was silently unable to throw.
   */
  scanJ: 0.45,
  /**
   * How far the froth's emergence gate must be open before a mass
   * throws (0 = the instant it appears, 1 = fully overturned). The old
   * test demanded J < 0, i.e. complete inversion, which small crests
   * never reach at all.
   */
  exposeMin: 0.45,
  /** Depth normalisation for the emission-count curve. */
  depthSpan: 0.4,

  /** Hop RELATIVE to the loop frame: up, then forward. */
  hopUpMin: 0.3,
  hopUpVar: 0.3,
  hopFwdMin: 1.5,
  hopFwdVar: 1.0,
  /**
   * The forward hop SCALES with the loop's size (the same froth factor
   * that gates emission, normalised by FROTH.sizeCap): a big plunging
   * loop throws its water well ahead, a small one barely clears its own
   * crest. hopFwdMin/Var are therefore the LARGE-loop values, and this
   * is the floor small loops fall to.
   */
  hopFwdSizeFloor: 1.0,

  /** Birth stagger (s): de-synchronises the 0.1s scan volleys. While
   * staggered a droplet RIDES its froth mass (it has not been thrown
   * yet), so it enters the air where the froth is at that moment rather
   * than popping into existence where the froth used to be. */
  birthStagger: 0.1,
  /**
   * Minimum froth factor a mass needs before it throws anything. The
   * froth's own visibility threshold (FROTH.visStart) is deliberately
   * generous — a faint smear of froth still reads fine — but the
   * smallest masses have no business hurling spray.
   */
  minFroth: 0.2,
  /**
   * Ceiling on a droplet's radius as a fraction of the froth mass that
   * threw it. Without it the tiniest masses were throwing droplets
   * bigger than themselves.
   */
  sizeVsFroth: 0.85,
  /**
   * Droplets thrown per FROTH MASS. Emission is scanned on a coarse
   * grid (scanStep) while froth sits on a fine lattice (FROTH.lattice),
   * so each scan cell stands for many masses: the count is this figure
   * times the masses estimated in the cell, capped by `maxPerPoint` to
   * protect the pool.
   */
  perFroth: 4,
  maxPerPoint: 14,
  /**
   * WHEN a froth mass throws its water: at the top of its arc around
   * the loop, not the moment it clears the surface. The mass is thrown
   * when the crest carrying it peaks — so emission needs the surface
   * high (`peakHeight`, as a fraction of the DOMINANT band's amplitude,
   * not the sea's total: normalising by the sum meant only the very
   * biggest crests could ever qualify) and its vertical velocity at or
   * just past zero (`peakRise`, m/s).
   * Without this, every mass threw the instant it surfaced, which read
   * as droplets leaping out of the water ahead of the wave.
   */
  peakHeight: 0.35,
  peakRise: 0.6,
  /** Minimum flight (s) before a landing may deposit foam. A droplet
   * killed early is a bad surface reading at a fold, not a splash —
   * letting those deposit painted foam where nothing was ever seen. */
  minFlight: 0.1,
  /** Render ease in/out (s) and death shrink. */
  growTime: 0.05,
  dieTime: 0.08,
  /** Motion streaking: stretch per m/s, and its cap. */
  streakPerSpeed: 0.1,
  streakCap: 2.1,
  /** Submersion test grace for young loop droplets (s): the surface is
   * multi-sheeted at a fold and insta-culled healthy spray. Launching
   * from the froth crown fixed the OTHER thing this was hiding (birth
   * already in contact), but the sheet misread is real and large:
   * measured at ~1300 culls/second with the grace shortened to 0.08,
   * versus ~13/s at 0.25. Every one of those culls also deposits foam,
   * so this value drives foam volume as much as it does spray. */
  submergeGrace: 0.25,
  /**
   * Clearance above the FROTH MASS's crown that droplets launch from,
   * metres. Droplets are torn off the froth, so the froth's own
   * geometry — not the raw water height — is where they start: the
   * mass sits FROTH.submersion x radius under the surface, so its
   * crown is above the waterline, and a droplet needs its own radius
   * plus this margin to clear its contact test at birth.
   */
  launchClearance: 0.06,
  /** Foam deposit radius: floor + per unit droplet size. */
  depositBase: 0.13,
  depositPerSize: 0.5,
  /**
   * How much foam a single landing lays down, 0-1. Now that deposits
   * survive their first seconds (FOAM.growStart holds them dormant
   * instead of diffusing them away) each one counts for far more, and
   * the old implicit 0.9 banked the whole sea white. This is the knob
   * for overall foam quantity: raise for a frothier sea, lower for a
   * cleaner one.
   */
  depositAmount: 0.9,
  /** Buoy spray leaves less behind than a breaking crest does. */
  depositAmountBuoy: 0.35,
  /** Buoy deposit radius: floor + per unit droplet size. */
  depositBaseBuoy: 0.13,
  depositPerSizeBuoy: 0.3,
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
  /**
   * DORMANCY, currently OFF: the window is closed (0..0.01), so every
   * deposit is immediately treated as grown and spreads and decays from
   * the moment it lands — the behaviour from before this existed.
   *
   * Open it (e.g. 0.18..0.45) and a deposit below `growStart` neither
   * spreads nor decays, just accumulating until others join it, which
   * keeps single landings visible. Each deposit then counts for far
   * more, so DROPLET.depositAmount must come down to match (~0.3).
   *
   * Without this, diffusion began the instant a droplet landed, so a
   * single deposit thinned below the render floor before it could ever
   * be seen: droplets visibly hit the water and left nothing. Now a
   * lone landing holds its shape until a few more join it, and only
   * then does the patch begin to spread and die.
   */
  growStart: 0,
  growFull: 0.01,
  /** Residual decay below `growStart`, as a fraction of the normal
   * rate. Not zero, or stray specks would live forever. */
  dormantDecay: 0.15,
  /** Flat evaporation per step, x(1 + 5*turb). */
  evaporation: 0.0002,
  /** Drift as a fraction of WIND speed (foam is blown as well as
   * carried; the surface current below moves it bodily). */
  drift: 0.05,
  /** How much of the SURFACE CURRENT foam inherits. Foam floats in the
   * skin of the water, so this is essentially 1. */
  currentCarry: 1.0,
  /** Soft capacity: above `overloadStart` mass, thin foam's decay
   * accelerates toward `decayOld`, saturating at `overloadFull`. */
  decayOld: 3,
  overloadStart: 200,
  overloadFull: 400,
  /**
   * FOAM AS A SCATTERER. Foam is a dense froth of air bubbles with an
   * albedo near 0.9: it integrates light from the whole sky dome and
   * returns mostly BRIGHTNESS, not the light's hue, and it stays white
   * long after the sea has gone dark. Shading it like matte paint made
   * it take the sky's colour completely and black out at night.
   */
  /** How much of the light's HUE foam takes on (0 = pure white always,
   * 1 = fully tinted like paint). Scattering keeps this low. */
  lightTint: 0.3,
  /** Ambient floor: the darkest foam ever gets, as a fraction of full
   * white. Real foam is still visibly white by starlight. */
  darkFloor: 0.3,
  /**
   * Sky-dome gain and direct-sun gain. Their BALANCE is not fixed: it
   * is set by how diffuse the sun is (SUN_DIFFUSION per preset), since
   * cloud converts direct sunlight into sky radiance. Overcast storm
   * light is nearly all ambient; a clear calm day is mostly direct.
   */
  skyGain: 3.3,
  sunGain: 4.9,
  /** Diffuse fraction even under a clear sky — the atmosphere always
   * scatters some light, and foam gathers it from every direction. */
  diffuseBase: 0.2,
  /** Directional shading floor: how much shape shows. 1 = flat, 0 =
   * full terminator. Foam self-shadows softly, so this stays high. */
  shapeFloor: 0.7,

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
