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

import { applyOverrides, type Knob } from './tuningstore'

/** GLSL literal helper: GLSL needs `1.0`, JS prints `1`. */
export const f = (n: number, digits = 4) => n.toFixed(digits)

/**
 * MASTER SWITCHES — turn each effect off to see the others in
 * isolation. Shader-side flags bake in at material build (reload to
 * apply); CPU-side ones take effect immediately.
 */
export const ENABLE = {
  /**
   * The in-page tuning panel. Deliberately NOT editable from inside the
   * panel: switching it off there would remove the only way to switch it
   * back on. Toggle it here, or press ` in the page.
   */
  tuningUI: true,
  /** White ribbon on the folding mesh itself. */
  loopWhite: false,
  /** Pull of the pinch zone toward the sprite plane. */
  loopStretch: true,
  /** Froth masses surfacing from under the fold. */
  froth: false,
  /** Vertical spray thrown off each foam mass. */
  crestPlumes: false,
  /** Ballistic droplets launched from inside the loops. */
  splashDroplets: false,
  /** Spray kicked up by the buoys. */
  buoySpray: true,
  /** Persistent foam residue field (deposits from landings). */
  foamField: false,
  /** Continuous foam laid by the sim wherever froth appears. */
  foamTrail: true,
  /**
   * The two OBJECT foams, switched independently — they are different
   * things and are tuned separately.
   */
  /** Painted collar pinned to the waterline (CONTACT.*). */
  contactFoam: true,
  /** Foam objects EMIT into the field, which then drifts and dies with
   * the rest of it (FOAM.contact*). This is what makes the wake. */
  contactEmit: true,
  /**
   * Turbulence-scaled EVAPORATION: breaking water thinning the foam
   * floating on it, at up to 6x the calm rate. Switch off to see foam
   * survive the break that made it.
   *
   * Note this is dissipation, not spreading — how fast a patch grows
   * outward is FOAM.diffusion, and its lifetime is decayThin/decayThick.
   * (The turbulence DECAY channel is already gone: it used to shred
   * every droplet deposit in its own landing zone.)
   */
  turbDissipation: true,
  /** Foam left by landing droplets. Switch OFF to see the crest trail
   * on its own — the two sources are otherwise hard to tell apart. */
  dropletFoam: true,
  /** 2D fluid mist field and its overlay. */
  mist: false,
  /** Downslope gusts shaping the mist. */
  mistGusts: true,
  /** Standing Gerstner wave at an object's waterline (OBJWAVE). */
  objectWave: false,
  /** Mesh crest riding the water at an object's nose (BOWCREST). */
  bowCrest: false,
  /**
   * Fine surface texture: a GPU inverse FFT of a random-phase Phillips
   * spectrum (fftwaves.ts), banded by each preset's `detail` block.
   *
   * This is the ONLY detail-wave path — the sinusoid sum it replaced is
   * gone, not kept as a fallback, because a dozen jittered cosines read
   * as a beating pattern no matter how they are tuned and there was no
   * setting worth switching back to. Off means no detail waves at all:
   * the term leaves the shader and the transform stops running.
   */
  fftDetail: true,
  /** Whitecap EVENTS (crest bursts + drizzle). Off since the loop
   * study replaced them with loop-driven emission. */
  whitecapEvents: false,
  /**
   * GPU PASS PROFILER. Inserts a gl.finish() around each offscreen sim so
   * its real cost can be timed, and reports the split in the overlay.
   *
   * Read the breakdown, NOT the fps, while this is on: finish() serialises
   * the GPU against the CPU, so the total gets worse by construction. The
   * per-pass numbers are what is trustworthy, and their ratios are what
   * matter. Turn it off before judging any change.
   *
   * This exists because renderer.info cannot see these passes at all —
   * three resets it at the head of every render() call, so the overlay's
   * draw-call and triangle counts describe only the final scene render
   * and say nothing about the four render-target sims that precede it.
   */
  gpuProfile: false,
  /**
   * Stream perf samples to tools/perf-logger.mjs, four times a second.
   *
   * For loads that VARY — storm foam building and dying — where reading an
   * overlay by eye cannot capture the correlation between cost and
   * coverage. Start the sink first:
   *   node tools/perf-logger.mjs perf-log.jsonl
   * If it is not running the beacons fail silently and nothing breaks.
   */
  perfLog: true,
}

/**
 * FROTH — the white masses that surface as a crest overturns.
 * They live on a rest-space lattice under the water and are revealed by
 * the fold; size and visibility are driven by which wave is folding
 * (amplitude ratio) and how hard (pinch intensity). Named froth rather
 * than "sprites" (several systems are sprites now) and rather than
 * "bubbles" (saved for a future underwater effect).
 */
export const FROTH = {
  /**
   * Anchor lattice spacing, metres. Denser = more masses.
   *
   * Was 0.33 while buildFrothGeometry actually used a hardcoded 0.25, so
   * this knob both did nothing AND misinformed the one place that did
   * read it: spray.ts's CELL_MASSES, which converts a scan cell's area
   * into a froth-mass count and was therefore under-counting by 1.74x.
   * Corrected to the value the geometry really uses, and the geometry now
   * reads it, so the two cannot drift apart again.
   */
  lattice: 0.25,
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
  /**
   * Smallest a froth mass may be DRAWN, in screen pixels. Below this it
   * is culled outright rather than rendered as a speck.
   *
   * Needed on top of cullRadius because that tests the mass's radius
   * while the drawn size is radius x the emergence gate g. A mass on a
   * peak that is only mildly pinching has a perfectly legal radius and a
   * small g, so it passed the metre test and still painted two or three
   * pixels — a rash of white dots along every crest.
   *
   * Being in pixels rather than metres is deliberate: whether a sprite
   * reads as froth or as dirt on the screen depends on how big it lands,
   * which is a function of zoom and DPR, not of its size in the water.
   * 1.0 is the rasterisation floor (below it the driver clamps and paints
   * one pixel anyway); raise it until the specks go.
   */
  minPixels: 4.0,
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
}

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
}

/**
 * LOOP WHITENING & STRETCH — the water surface's own response to a
 * fold: the white ribbon, and the pull toward the sprite plane that
 * hides the fold's leading sliver.
 */
export const LOOP = {
  /**
   * WHITENESS comes from two independent claims, combined with max().
   * Both are live; weight them to taste.
   *
   *  - BACKFACE. The loop IS the mesh's backface: where a crest
   *    overturns, the rest -> world map inverts and the winding flips
   *    with it, so gl_FrontFacing reports the inverted sheet per pixel,
   *    exactly and with no state to flicker. Its limit is that it only
   *    covers what the camera can actually see of that sheet, which
   *    from this angle is a sliver along each crest — most of it hides
   *    behind the lip overhanging it.
   *
   *  - FOLD RAMPS. The Jacobian and overhang reconstruction: an
   *    estimate rather than the thing itself, but it reaches out from
   *    the seam into the compressed water around it, so it is what
   *    widens the read past the sliver.
   */
  /**
   * Weight of the backface term, 0-1.
   *
   * Zero by default, because gl_FrontFacing is decided PER TRIANGLE: a
   * tri is entirely front- or back-facing, so white driven by it has
   * hard polygon edges and no shading smoothing can help. That is
   * invisible on the ambient crests, where the ribbon is thin and froth
   * covers it, but obvious on an object's wave.
   *
   * Nothing is lost by dropping it. Backface means J < 0, and the ramp
   * term computes 1 - smoothstep(0, whiteJRamp, J) per PIXEL in
   * pinchMask — the same fact, feathered, at fragment resolution. Raise
   * this only to check what the exact geometric test would have said.
   */
  backfaceWhite: 0.0,
  /** Weight of the reconstructed fold-ramp term, 0-1. */
  rampWhite: 1.0,

  /**
   * The ramp term is a max() of three separate claims. Switch any of
   * them out to see what it was contributing — the term is dropped from
   * the shader source rather than scaled to zero.
   *
   * Do NOT try to disable one by zeroing its ramp instead. smoothstep
   * is undefined when its edges are equal (it divides by their
   * difference), so a zeroed ramp does not switch its term off — it
   * makes it unpredictable, and in practice it returns 1.0 everywhere,
   * which paints MORE white rather than none.
   */
  whiteFromJ: false,
  whiteFromTilt: true,
  whiteFromStretch: true,
  // Measured, storm preset, one frozen frame, against backface-only:
  // the J ramp alone adds 7.5% more white, but adds NOTHING on top of
  // the stretch term — at 0.04 against the stretch's 0.3 it is
  // subsumed, since 1-smoothstep(0, 0.3, J) is the larger of the two
  // everywhere and the max() never picks it. Widen whiteJRamp past
  // stretchJRamp before expecting it to show.

  /** Jacobian ramp for whiteness (0 = fully white at collapse). */
  whiteJRamp: 0.04,
  /** Overhang (normalised normal y) ramp for the rolling tongue. */
  whiteTiltStart: 0.02,
  whiteTiltFull: 0.12,

  /**
   * THIN LOOPS. A loop formed by a small wave is a hairline: it whitens
   * a sliver of surface and reads as a scratch rather than a break.
   * Loops whose froth factor falls below this are held back — from the
   * RAMP term only; the backface term is exact and is never gated.
   * While `debugThin` is on they render RED instead of being dropped.
   * Set to 0 to disable the gate entirely — that one IS handled as a
   * special case rather than as a degenerate smoothstep.
   */
  thinSk: 0.21,
  debugThin: false,

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
}

/**
 * OBJECT WAVE — a standing Gerstner wave anchored to an object's
 * waterline. Its own feature rather than part of FROTH: it is a wave,
 * and anything downstream of the wave field responds to it.
 *
 * Currently OFF (ENABLE.objectWave). It was built to manufacture a pinch
 * loop at an object and is not good at that — a fold the mesh can
 * resolve has to be several metres across, so it suits a large swell
 * around a hull rather than a tight crest. Kept because that IS a useful
 * effect in its own right.
 */
export const OBJWAVE = {
  /**
   * OBJECT WAVE — a real standing Gerstner wave at an object's
   * waterline, rather than a shaped deformation.
   *
   * It folds for the same reason the spectrum's waves do, and every
   * downstream system (mesh whitening, froth, droplets, foam) responds
   * through its ordinary criteria with nothing written twice.
   *
   * The fold condition is the ordinary Gerstner one:
   *
   *   q * amp * 2*pi / wavelength > 1
   *
   * At q 3 / amp 0.73 / lambda 12 that is 1.15, so it folds — just.
   *
   * WAVELENGTH IS SET BY THE MESH, not by taste. The fold — the part of
   * the wave where compression exceeds 1 — spans about a SIXTH of the
   * wavelength, so against 0.5m quads:
   *
   *   lambda 3   fold ~0.5m = 1 quad. Neighbouring vertices land on
   *              opposite sides of it and displace opposite ways, which
   *              aliases into a checkerboard of torn triangles.
   *   lambda 12  fold ~2m   = 4 quads. Resolves.
   *
   * Amplitude then has to RISE with wavelength to keep folding, since
   * the condition is q*A*2*pi/lambda > 1. A resolvable fold is therefore
   * always a large wave — metres of water on something sphere- or
   * boat-sized. Fine at that scale, impossible at a buoy's, which is the
   * same wall the artificial pinch kept hitting.
   *
   * Going far ABOVE the threshold does not help either: at qAk of 10 the
   * map is inverted many times over and the mesh simply shreds.
   */
  amp: 0.95,
  wavelength: 12,
  /** Gerstner chop for this wave. Raising it steepens toward the fold
   * without making the wave any taller. */
  q: 3,
  /** How far the wave carries from the hull before dying, metres. */
  reach: 8,
  /**
   * 0 = a full ring around the object, 1 = the upstream face only.
   * A hard nose-only mask varies fast around the hull and its derivative
   * is pure shear, which reads as the mesh twisting rather than curling;
   * keeping some ring in the mix holds that down.
   */
  windward: 0.6,
}

/**
 * BOW CREST — a strip of MESH riding the water at an object's nose.
 *
 * Every attempt to manufacture a crest by deforming the water failed on
 * the same constraint: a fold the mesh can resolve costs a pile of water
 * as big as the fold, so it is only expressible at swell scale. This
 * sidesteps it. The crest is its own geometry, so its shape owes nothing
 * to the water's tessellation and it can be as tight as wanted.
 *
 * It stays welded to the surface by sampling the SAME wave displacement
 * the water does, at the same rest positions — so it rises, falls and
 * sways with the swell exactly, with no matching to maintain.
 *
 * The rolling is shading, not geometry: froth bands scroll around the
 * cross-section. A real breaking lip tumbles because its material
 * circulates, and circulating material is what the scroll stands in for.
 */
export const BOWCREST = {
  /** Arc covered either side of dead-ahead, radians. PI/2 is the whole
   * upstream half; less makes a tighter nose crest. */
  arc: 1.57,
  /**
   * Where the crest sits ACROSS the contact collar's band, 0-1: 0 at the
   * hull edge, 1 at the collar's outer rim. Expressed against the collar
   * rather than in metres so the two stay registered — the crest tracks
   * the collar's width, its wobble and its chop scaling automatically,
   * instead of being a second set of numbers to keep aligned.
   */
  standoffFrac: 0.5,
  /** Lip cross-section radius, as a multiple of the collar's width.
   * The masses are sized off this too, so raising it grows the whole
   * crest together rather than just the tube. */
  thickPerWidth: 0.2,
  /** How far the tube leans downstream, as a fraction of its radius. */
  lean: 0.6,
  /**
   * TAPER away from the nose. The exponent on (1 - distance along the
   * arc): higher keeps the crest full further round before dropping off.
   */
  taperPower: 1.6,
  /** Thickness at the very ends, as a fraction of the nose's. */
  taperMin: 0.12,
  /**
   * Circulation speed in REVOLUTIONS PER SECOND, at timeScale 1.
   *
   * Scaled by the preset's timeScale where it is baked into the shader,
   * because timeScale goes into each wave's OMEGA when the spectrum is
   * built, not into uTime — so anything driven by uTime keeps wall-clock
   * pace unless it scales itself, and the crest would have spun on
   * regardless of how slowly the sea was moving.
   *
   * (The tube carries no pattern at all now, so this drives only the
   * masses. cullScale, cullFloor and bands went with the texture.)
   *
   * The PHYSICAL rate, measured against this spectrum, is 0.35 rev/s: a
   * Gerstner material point circles at its wave's own angular frequency,
   * and the pinch-weighted mean omega is 2.2 rad/s, a 2.85s turn. That
   * is much slower than a crest LOOKS, because what reads as churn there
   * is not the orbit at all — it is masses appearing and vanishing as
   * the fold sweeps past them. This crest has no such turnover, so it
   * has to carry the impression on circulation alone and runs faster
   * than the water really does.
   *
   * Ceiling: with `frothAround` masses on the ring a given point is
   * passed frothAround * rollRate times a second, and past roughly a
   * quarter of the frame rate it strobes — appearing to drift slowly
   * BACKWARD — instead of spinning. At 7 masses that is about 2.1.
   */
  rollRate: 1.7,
  /** Fade at the ends of the arc, as a fraction of it. */
  endFade: 0.35,
  /**
   * Waterline radius, metres, below which the crest fades out entirely.
   * The circle the surface cuts shrinks to nothing as an object goes
   * under, so this one number covers both a submerged object and a crown
   * only just breaking through — no separate depth test.
   *
   * Kept low. Measured on the storm preset, the sphere has ANY waterline
   * only about a quarter of the time — its crown sits at y = -1 while
   * the surface there swings between -5.4 and +4.9 — so a high threshold
   * hides the crest almost always.
   */
  minRing: 0.25,
  /**
   * FROTH MASSES riding the torus — how many along the arc and around
   * the cross-section, and how big each is.
   *
   * These carry the toroidal spin, because the tube itself cannot: a
   * smooth white surface has no feature to track, so rotation on it
   * reads as bands sliding rather than water circulating. Discrete
   * masses moving is what makes a pinch loop's froth tumble, and these
   * are the same masses on the same kind of path.
   */
  /**
   * Masses along the arc and around the cross-section. These are the
   * SPRITE counts, nothing to do with segArc/segLip, which tessellate
   * the tube — the tube is a smooth swept shape and needs far fewer
   * divisions than the froth needs masses.
   */
  frothAlong: 64,
  frothAround: 7,
  /**
   * Mean mass radius in METRES, plus the per-mass jitter either side.
   *
   * Absolute, not a fraction of the tube: a crest mass has a baked base
   * radius that the froth factor modulates, and that is what keeps masses
   * small against a large loop. Scaling them off the tube instead made
   * them a fixed share of its diameter at every size, so they read as a
   * lumpy tube rather than as froth on one.
   *
   * Neither size response nor density is a knob here — both come from
   * FROTH (visStart/visFull, sizeCap, densMax/densMin), so the bow crest
   * sizes and thins exactly as a wave crest does.
   *
   * Nor is the nominal tube size the masses are measured against: it is
   * derived in Scene from CONTACT.width, the chop foaminess and
   * thickPerWidth. As a hand-written constant it went stale as soon as
   * the collar was retuned and culled every mass.
   */
  frothBase: 0.26,
  frothRadiusVar: 0.3,

  /**
   * How far the masses sit PROUD of the tube, as a fraction of their own
   * radius. Not zero: flush with the surface they are the same white as
   * the tube and coincident with it, so their motion cannot be seen at
   * all. Standing out, their silhouettes break the tube's outline, and
   * that travelling outline is what reads as circulation.
   */
  frothProud: 0.8,
  /** Tessellation: segments along the arc and around the lip. */
  segArc: 36,
  segLip: 8,
}

/**
 * CONTACT FOAM — the painted collar where the surface meets a solid.
 *
 * Distinct from the foam objects EMIT into the field (FOAM.contact*).
 * That emission is ordinary foam and behaves like all the rest: it
 * drifts off downstream, spreads and dies. This is the collar that stays
 * ON the object — pinned, not drifting, present for as long as the
 * object is at the surface. The two are meant to be seen together: the
 * collar marks the waterline, the emission trails away from it.
 *
 * Nothing here reads wind or current. Drift belongs to the emitted foam,
 * which gets it from the field for free.
 */
export const CONTACT = {
  /** Collar width in metres at full foaminess. */
  width: 0.15,
  /** Opacity of the collar, applied as thickness into the foam web. */
  alpha: 0.95,
  /** Softness of the outer edge, as a fraction of the width. Not 0 —
   * a hard cut aliases against a curved silhouette. */
  soft: 0.18,
  /** Width wobble, as a fraction, so the collar is not a clean ring. */
  wobble: 0.3,
  /** Wobble wavelength, metres: the size of one bulge in the edge. */
  wobbleScale: 2.5,
  /**
   * How DEEP water can lie over an object and still show a collar,
   * metres, measured to the object's surface directly below each point.
   * Generous on purpose: this is the REACH, and shortening it leaves
   * fragments near the hull outside every case, so they paint nothing
   * and tear a hole in the collar. Shape the response with
   * `submergeBias` instead.
   */
  overwash: 0.9,
  /** Exponent on the overwash falloff: how readily white still shows
   * once an object is under. Higher = gone sooner, same reach. */
  submergeBias: 2,
  /** How fast the collar stops below a hull lifted clear, metres. */
  liftFade: 0.08,
  /** Narrowest the collar gets, as a fraction of `width`. Not 0, or the
   * vertical reading becomes a gate again and tears the collar. */
  spreadFloor: 0.25,
}

/**
 * SUN SPECULAR — the sun's own mirror image on the water.
 *
 * Separate from the sky reflection, and added AFTER the Fresnel blend
 * rather than folded into the reflected sky. Folded in, it was
 * multiplied by a Fresnel that bases at 0.25, so a highlight lost three
 * quarters of its strength at exactly the angles this camera views
 * from. That is wrong for the sun specifically: water's reflectance at
 * those angles really is a few percent, but the sun's radiance is so
 * enormous that its glitter still blows out to white. Reflectance and
 * radiance both matter, and only one of them was represented.
 *
 * Everything keys off the preset's sky.diffusion — the same cloudiness
 * that softens the caustics. A clear sky gives a tight, blazing glitter
 * path; overcast smears it into the broad sheen it had before.
 */
export const SPECULAR = {
  /**
   * Highlight tightness under a clear sky and under full overcast, as a
   * Phong exponent. Half-width is roughly sqrt(2*ln2 / n) radians, so
   * 260 gives about 4.2 degrees and 30 about 12.
   *
   * There is a floor on how tight this can usefully be, and it comes
   * from the CAMERA. Orthographic means one view direction for every
   * pixel, so the sun's mirror image appears only where the surface
   * normal equals the half-vector between view and sun — and that
   * half-vector sits 24 to 63 degrees off vertical depending on the
   * hour, 29 at noon. Water has to be tilted that far before it can
   * reflect the sun at all, which happens on wave FACES, never on flat
   * water. A highlight only 1.8 degrees wide (n = 1400) would flash
   * across such a face for a sliver of a degree and read as nothing.
   *
   * Two consequences worth knowing. Sun glitter here lives on steep
   * faces, not as the broad path a perspective camera would give — with
   * parallel rays there is no path, only a slope that qualifies or does
   * not. And on genuinely flat water there will be no highlight at any
   * setting; chop is what supplies the angles.
   */
  sharpClear: 3000,
  sharpOvercast: 300,
  /**
   * Peak brightness, as a multiple of the sun's colour. Above 1 on
   * purpose — a specular highlight is meant to clip to white — but it
   * also SETS THE SIZE of the white core, which is easy to miss:
   *
   *   white core half-angle ~= sqrt(2 * ln(gain) / sharp)
   *
   * because everything above 1.0 clips, so a big gain drags the lobe's
   * tails over the line. At sharp 260 / gain 14 the core came out at
   * 8.2 degrees against a nominal 4.2 half-width — twice the intended
   * size, and the reason it read as a blob rather than a glint. Raise
   * `sharp` alongside `gain`, or the highlight grows as it brightens.
   */
  gainClear: 16,
  gainOvercast: 0.35,
  /**
   * How much the surface's Fresnel dims the highlight, 0-1. 0 adds it at
   * full strength whatever the angle, 1 obeys Fresnel exactly. Partial,
   * because obeying it fully loses the glitter this camera is looking
   * for and ignoring it makes the sea shine from underneath.
   */
  fresnelMix: 1.0,
  /**
   * Which view geometry the highlight uses. true = rays converging on a
   * virtual eye; false = the camera's true orthographic direction. The
   * rest of the water is unaffected either way, so this is a clean A/B.
   *
   * On, because orthographic cannot produce a glitter PATH at all: with
   * one shared view ray a slope qualifies everywhere or nowhere, so the
   * highlight comes out as slivers scattered over whichever faces happen
   * to hit the angle, all equally bright regardless of distance. The
   * path in a photograph exists because perspective gives neighbouring
   * points different view rays, and this is the cheapest way to buy that
   * back without changing the projection.
   */
  /**
   * ENVELOPE MODE — the recommended one. Keeps the true orthographic
   * mirror test for WHETHER the sun reflects and off which facets, and
   * multiplies it by a smooth spatial envelope for WHERE on screen the
   * glitter sits.
   *
   * The virtual-eye mode below feeds the fake eye into the mirror test
   * itself, which is why it invents highlights at hours the sun could not
   * possibly reflect: it widens the range of facet slopes that qualify.
   * The envelope cannot do that — it peaks at 1 by construction, so it
   * only ever subtracts. Timing stays exactly the orthographic answer
   * while the streak's length and position become free parameters.
   *
   * Takes precedence over virtualEye. Both are ignored under a real
   * perspective camera, which needs no fakery.
   */
  /**
   * CAMERA EYE — treat the camera's own world position as a single point
   * the specular rays converge on. Everything else stays orthographic.
   *
   * The plainest possible answer to "an ortho view has no eye position":
   * give it the one it actually has. No tuned distance, no envelope, no
   * altitude ramp on the shape — the reflection lands where a viewer at
   * the camera would see it, and its focus follows from how far away that
   * is (56.7m here) rather than from a knob.
   *
   * Takes precedence over `envelope` and `virtualEye`. The core/halo split
   * still applies, so there is a dense centre inside a slacker wash.
   */
  cameraEye: true,
  /**
   * How far away the simulated viewpoint sits, metres, when cameraEye is
   * on. 57 is where the isometric camera actually is.
   *
   * An orthographic projection does not care about camera distance — only
   * direction and frustum — so nothing else in the scene moves when this
   * changes. But the specular is the one calculation that DOES converge on
   * a point, so distance is exactly what sets how tight the highlight is
   * and how far it travels as the sun drops: the centre lands at roughly
   * (0.53 x this) / tan(sunAltitude) from the viewpoint's ground position.
   * Nearer keeps the reflection in frame for longer at a low sun; further
   * spreads it wider and loses it sooner.
   */
  cameraEyeDistance: 57,
  envelope: true,
  /**
   * Distance of the notional viewer used for the envelope, metres.
   * Controls how long the streak is and how fast it falls off: near
   * gives a short compact patch, far stretches it toward covering the
   * view. It cannot affect WHEN the glitter appears, unlike eyeDistance.
   */
  envDistance: 40,
  /**
   * Envelope width, as slope VARIANCE in radians squared.
   *
   * The falloff is exp(-(1 - h.y) / envWidth) where h is the facet normal
   * a viewer would need at this point, and 1 - h.y is approximately
   * tilt^2 / 2 — so this is the Cox-Munk sun-glitter model, and envWidth
   * is the mean square surface slope. 0.02 is an RMS slope near 8 degrees,
   * a moderate breeze. Rougher seas spread the glitter wider; this could
   * be driven from windSpeed rather than tuned.
   */
  envWidth: 0.01,
  /**
   * HALO — a second, much broader and softer copy of the same reflection,
   * added under the core.
   *
   * Physically this is the circumsolar aureole: the sun's disc is half a
   * degree across, but forward scattering by haze smears a far dimmer
   * glow several degrees around it. On water that reads as a dense
   * glitter core sitting in a wide, thin shimmer — which is what makes it
   * look like a point source in a bright sky rather than a decal.
   *
   * Multipliers on the core, not absolute values, so the two stay related
   * when the core is retuned.
   */
  haloWidth: 1,
  /** Lobe sharpness relative to the core. Lower = catches slacker facets,
   * so the shimmer reaches further and survives a lower sun. */
  haloSharp: 0.15,
  /** Brightness relative to the core. */
  haloGain: 0.03,
  /**
   * ANISOTROPY — ratio of along-wind to cross-wind slope variance.
   *
   * Cox & Munk measured this off sun-glitter photographs in 1954: the sea
   * tilts further along the wind than across it, so the glitter is an
   * ellipse stretched downwind, not a disc. 1.0 is isotropic and reduces
   * this exactly to the plain Gaussian; 2 is a moderate breeze.
   *
   * It also earns its keep at low sun, where the required facet tilt runs
   * out along one axis — the stretch keeps the streak in view as the
   * specular point slides toward the horizon.
   */
  anisotropy: 4.0,
  /**
   * LOW-SUN BEHAVIOUR. The glitter's window is narrow because the
   * envelope's specular point slides out of view as the sun drops — so
   * the envelope opens up to follow it.
   *
   * Keyed on sun ALTITUDE, not day phase: altitude is what actually
   * causes it (a real glitter path lengthens toward the horizon for the
   * same reason), and phase numbers would silently become wrong the
   * moment the sun path's angle or offset changed.
   *
   * Above altHigh the base values apply unchanged; at altLow the *Low
   * values fully apply; between, they cross-fade.
   */
  altHigh: 26,
  altLow: 7,
  /**
   * Envelope distance at low sun — SMALLER than the base value, which is
   * the counter-intuitive part.
   *
   * The notional eye sits at 0.53 x this height, and the specular point
   * lands at eyeHeight / tan(sunAltitude) away from it. So as the sun
   * drops, a HIGH eye hurls the glitter's centre over the horizon:
   * measured, at distance 40 it passes the edge of the visible water
   * (~45m) by 15 degrees altitude and is at 86m by 10 degrees. Dropping
   * the eye keeps the reflection in view — at distance 15 the same
   * 10-degree sun puts it at 33m, still on screen.
   *
   * Raising it instead does make the patch bigger, which reads as an
   * improvement right up until the patch has left the frame.
   */
  envDistanceLow: 14,
  /** Envelope width at low sun. Wider keeps it alive as the tilt grows. */
  envWidthLow: 0.025,
  /** Halo brightness at low sun — the wash carries it once the core thins. */
  haloGainLow: 0.2,
  /**
   * Sun altitude below which the whole specular fades out, degrees. The
   * sun reddens and dims into the horizon haze; without this the glitter
   * would simply blink off when the light handed over to the moon.
   */
  fadeAltDeg: 3,
  virtualEye: true,
  /**
   * VIRTUAL EYE distance, metres, when `virtualEye` is on.
   *
   * The camera is orthographic, so every pixel shares one view direction
   * and a slope either satisfies the mirror condition everywhere or
   * nowhere — there is no glitter PATH, only slivers on qualifying
   * faces. A real path exists because perspective gives each point its
   * own view ray, so a continuum of positions satisfies the condition.
   *
   * This puts a virtual eye at that distance along the view axis and
   * measures the specular against rays converging on it. Deliberately a
   * cheat, and only the highlight uses it — the sky reflection and
   * Fresnel keep the true orthographic direction, so nothing else about
   * the water changes. Smaller values spread the path wider; very large
   * ones converge back on the orthographic behaviour.
   */
  eyeDistance: 42,
}

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
}

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
}

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
  /**
   * IMPACT CROWN scaling — how a buoy's splash answers to how hard it
   * actually landed. The energy is 0 at the splash threshold and 1 at a
   * full crest-fall.
   *
   * Both curves are exponents on that energy, and they are deliberately
   * different. COUNT may fall to almost nothing, because a gentle touch
   * should throw a handful of drops. SIZE settles toward sizeMin instead
   * of vanishing, because a light impact still makes spray — it makes
   * FINE spray. Previously neither scaled: the smallest qualifying bump
   * threw 12 droplets across the full size range, so every nudge read as
   * a belly-flop.
   */
  /**
   * The impact SPEED range, m/s, of buoy against water — the relative
   * closing speed of the two, so a buoy dropping onto rising water hits
   * harder than the same fall onto falling water.
   *
   * Below `impactMinSpeed` there is no splash at all. At
   * `impactFullSpeed` the crown is at full count and full size; the
   * curves below shape everything in between. These two set the SCALE
   * the curves are read against, so widening the range makes every
   * ordinary landing gentler without touching the curves themselves.
   */
  impactMinSpeed: 1.2,
  impactFullSpeed: 6.7,

  impactCountMin: 2,
  impactCountMax: 48,
  /** >1 holds the count down until the impact is genuinely hard. */
  impactCountCurve: 1.8,
  /** >1 keeps droplets near sizeMin except on the heaviest landings. */
  impactSizeCurve: 1.4,

  sizeMin: 0.04,
  sizeMax: 0.17,

  /** Loop scan: cadence (s), grid pitch and half-extent (m). */
  scanInterval: 0.1,
  scanStep: 1.6,
  /**
   * LANDING-CHECK SKIPPING. The per-droplet ocean sample was 88% of the
   * frame on storm; these decide how often it can be avoided.
   *
   * A droplet remembers the surface height where it last looked, and
   * skips the sample while it is still provably clear of the water. The
   * time part of that is exact (waves.maxSurfaceRate bounds how fast the
   * sea can rise); the SPACE part cannot be, because world-space surface
   * slope goes infinite at a Gerstner fold and storm folds constantly —
   * so slopeBound is a conservative stand-in, in metres of rise allowed
   * per metre the droplet travels.
   *
   * Raising it skips fewer checks and is safer; lowering it skips more.
   * If it is ever too low the failure is bounded and mild: a landing is
   * noticed a check late, which is the same latency the parity split
   * already accepts.
   */
  checkSlopeBound: 2.0,
  /**
   * Longest a droplet may go without a real sample, seconds, whatever
   * the bound says. The backstop that keeps a bad slopeBound from
   * letting a droplet fly on underwater.
   */
  checkMaxGap: 0.08,
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
   * ADAPTIVE SCANNING. Flat water is sampled at scanStep x this factor
   * — enough to notice a new loop forming — while the neighbourhood of
   * every known track is sampled at the full step. Most of a scan's
   * samples land on water that cannot pinch; tracks say where the
   * pinches are, so the fine grid can follow them.
   */
  scanCoarse: 3,
  /** Half-width of the fine band around a track, metres. */
  scanBand: 4,
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
  /**
   * The throw also scales with the LOOP'S OWN SPEED, as a fraction of
   * the dominant band's phase speed; this is the floor slow loops fall
   * to. Droplets fly PINNED to the loop's frame, so the hop is motion
   * relative to the crest — a fixed 1-2 m/s reads fine on a fast
   * plunger but looks like water being flung off a nearly stationary
   * slow crest.
   */
  hopFwdSpeedFloor: 0.25,

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
   * Minimum extent ALONG the crest, metres, for a loop to throw. This
   * replaces the old neighbour-vote "chain" classification: a genuine
   * crest line is a connected run with real width, while noise is a
   * lone sample or a short smear pointing along its own travel.
   */
  minLoopLength: 2.5,
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
}

/**
 * FOAM FIELD — persistent residue left by droplet landings (foam.ts).
 * Decay clocks are exponential time constants in seconds.
 */
export const FOAM = {
  /**
   * FOAM FROM THE FROTH — laid continuously by the sim, not stamped.
   *
   * Breaking water makes foam for as long as it is breaking, so this is
   * a rate rather than a set of deposits. The sim already evaluates the
   * wave field per texel for its turbulence probe, so it evaluates the
   * froth criterion in the same loop and adds foam wherever that fires.
   *
   * The CPU alternative — queueing gaussian deposits from the loop scan
   * — was tried and removed. It could only fire once per scan cycle, so
   * however the budget was spread it arrived as a batch of discrete
   * blobs every six frames, which read as patches appearing whole. It
   * was also capped by the field's 24-deposits-per-step drain, and by
   * the mass governor below, which quietly cancelled it.
   *
   * Foam laid directly under a break is evaporated at 6x by `turb`, so
   * what survives is what the crest has already moved off. That is the
   * trail, and it needs no explicit offset behind the wave.
   */
  /**
   * MINIMUM FROTH SIZE that lays foam, and the size at which laydown
   * reaches full rate — both the froth mass's RADIUS in metres, not its
   * size factor.
   *
   * Radius is the honest measure of "how big is this froth", because a
   * mass's radius is its base size times the size factor times the
   * visibility ramp: all three collapse together at the low end, so the
   * radius falls away far faster than the factor. Some worked values,
   * with the froth's mean 1.08m base:
   *
   *   factor 0.18 -> 0.03m   (below FROTH.cullRadius: never drawn)
   *   factor 0.25 -> 0.12m
   *   factor 0.30 -> 0.22m
   *   factor 0.35 -> 0.33m   (about the largest the storm produces)
   *
   * So gating on the factor at 0.18, as this did first, was laying foam
   * from froth too small to exist. Anything below FROTH.cullRadius is
   * invisible froth by definition and should never lay anything.
   */
  /**
   * BIG-FROTH ROLLOFF: how much laydown to take back off the LARGEST
   * breaks, 0-1, without touching the small ones.
   *
   * The laydown ramp is monotonic in froth size, so on its own every
   * knob on it moves small and large together — raising layMinRadius
   * cuts the small end, raising layFullRadius drags the middle down with
   * the top. This subtracts from the top end only: 0 leaves the response
   * exactly as it was, 0.5 halves the rate on the biggest froth, 1 takes
   * it to nothing while froth below `layBigStart` is untouched.
   *
   * Note this scales the rate PER TEXEL. A big break also covers more
   * texels, so its total contribution still grows with size — to flatten
   * total foam across sizes rather than just the rate, this has to go
   * fairly high.
   */
  layBigRolloff: 0.1,
  /** Froth radius where the rolloff begins and where it is fully
   * applied. Keep `layBigStart` at or above `layFullRadius`, or the
   * rolloff eats into the mid sizes it is meant to spare. */
  layBigStart: 0.18,
  layBigFull: 0.4,

  /**
   * The laydown's ABSOLUTE test: how far the surface must have folded
   * before it lays any foam, as the raw pinch (0 = not folding, 1 = J
   * fully collapsed). Nothing else in the froth criterion is absolute —
   * the amplitude ratio is measured against each preset's own dominant
   * wave, so it cannot tell a calm sea from a storm, and intK floors
   * well above zero by design. Without this the calm preset foamed
   * everywhere.
   *
   * For scale: J = 0.1 is the onset of pinching, J = 0 the fold line,
   * J < 0 inverted. Those map to pinch 0, 0.18 and upward.
   */
  /**
   * OBJECT CONTACT — foam made where the surface meets a solid.
   *
   * Emitted into the field rather than painted on the water, so it
   * drifts, spreads, decays and webs like every other kind of foam. The
   * wake shape is then emergent: the source is a plain collar and the
   * current pulls it downstream on its own. The painted version this
   * replaced needed a private copy of each of those behaviours — its own
   * drift term, its own tapering tail, its own fade — and none of them
   * agreed with the field without being hand-matched.
   */
  /** Width of the emitting band around an object's waterline, metres. */
  contactBand: 0.45,
  /**
   * WINDWARD BIAS. Water running into an object piles up and froths on
   * the face it strikes, so the emitting band is strengthened there and
   * left alone on the lee side.
   *
   * The velocity is the water's RELATIVE to the object: its per-texel
   * Gerstner orbital motion plus the surface current. The objects are
   * moored, so that is just the water's own motion — but it is written
   * as a relative velocity, so giving a buoy real horizontal movement
   * later needs no change here.
   */
  /** Extra emission on the face taking the flow head-on, as a multiple
   * of the base rate. 2 = three times as much foam on the nose. */
  contactBowGain: 2,
  /** Relative speed, m/s, at which that bias is fully applied. Orbital
   * motion alone reaches a few m/s in a storm and near nothing on calm,
   * so this mostly decides how quickly the effect arrives with weather. */
  contactFlowFull: 2,
  /** Thickness laid per 1/60s at the hull, before the chop scaling. */
  contactRate: 0.012,
  /** How deep water can lie over an object and still foam, metres. */
  contactOverwash: 0.9,
  /** How fast it stops below a hull lifted clear of the water, metres. */
  contactLift: 0.08,
  /**
   * Chop at which objects start foaming, and at which they foam fully.
   * Chop drives breaking, and breaking makes foam, so it separates a big
   * smooth swell from a frothy sea in a way wave height cannot. Against
   * the presets: calm 0.55 -> nothing, largeSwell 2.25 -> about a third,
   * storm 5 -> full.
   */
  contactChopStart: 1,
  contactChopFull: 5,

  layPinchStart: 0.05,
  layPinchFull: 0.35,

  layMinRadius: 0.03,
  layFullRadius: 0.15,
  /**
   * Thickness added per 1/60s at full froth. The field saturates at 1.0
   * and the sim steps every other frame, so the laydown at full rate is
   * about 60x this per second: 0.012 fills a texel in roughly 1.4s of
   * continuous froth cover, and a crest passes over in well under that.
   */
  layRate: 0.012,

  /** Thin foam's lifetime, s (the long linger). */
  decayThin: 8,
  /** Thick foam's, s: peaks erode faster so mounds flatten. */
  decayThick: 2,
  /** Turbulence window on the Jacobian probe. */
  turbJStart: 0.28,
  turbJFull: -0.15,
  /** Spread rate: AREA growth, not decay, is the main thinning force. */
  diffusion: 0.88,
  /**
   * PATCHINESS. One noise value per stretch of water sets both how fast
   * foam there spreads and how long it lasts, so patches do not all run
   * the same clock — some stay solid as thick streaks while neighbours
   * have already torn open into web. Without it the whole sea reaches
   * the lace stage together and reads as one uniform pattern.
   */
  /** Size of a patch, metres: roughly the width of one pocket. */
  varyScale: 5,
  /**
   * PER-CELL variation, applied in the web render rather than the sim.
   *
   * The pocket noise above varies over metres, so every web cell inside
   * one pocket shares its multiplier and they all expand and empty
   * together — an area holds on until the last cell has opened. These
   * two give each Voronoi cell its own character instead, from a random
   * baked into the web tile beside its distance field, so a patch tears
   * open unevenly and empties cell by cell.
   */
  /**
   * The two SIM-side per-cell knobs. These are what produce a cell still
   * sitting solid after the cells around it have gone entirely: they
   * vary the decay and spread of the thickness field itself, keyed to
   * the same per-cell random the render uses. The render-side pair below
   * can only reinterpret a shared thickness, which is worth about one
   * time constant and no more.
   */
  /** How much longer the stubbornest cells hold their foam. 0.8 gives
   * them ~5x the life, capped near 20s by the sim's retention ceiling. */
  cellLifeVary: 0.8,
  /** How much slower they spread. Holding thickness and refusing to
   * spread are the same behaviour, so this tracks cellLifeVary. */
  cellSpreadVary: 0.7,

  /**
   * MAXIMUM SIZE variation, 0-1. Cells grow by merging from the fine
   * rung toward the coarse one as foam thins, so this caps how far a
   * given cell is allowed to merge — which is the same as capping how
   * big it can get. 0 = every cell may merge fully, as before. 0.5 =
   * the most restricted cells only make it halfway and dissipate while
   * still small. 1 = they never merge at all and die at fine size.
   */
  cellMaxSizeVary: 0.5,
  /** Swing in how solid a cell stays: 0.5 = 0.5x to 1.5x strand width. */
  cellSolidVary: 0.5,
  /** Swing in the thickness a cell survives down to. Inverted against
   * the same random, so a cell that stays solid also lingers longest. */
  cellFadeVary: 0.45,
  /**
   * How much SLOWER the most solid patches spread, as a fraction of
   * `diffusion`. 0.55 = they spread at 0.45x while the rest run nominal.
   *
   * One-directional on purpose. Diffusion already sits at its saturation
   * ceiling, so scaling it ABOVE nominal does not spread faster — at a
   * mix factor of 1.0 each texel is replaced outright by its neighbour
   * average, which wipes the field out in about a second.
   */
  varySpread: 0.7,
  /**
   * How much LONGER the most solid patches last, as a fraction of the
   * decay clocks. Applied as an exponent on retention, so 0.35 gives
   * them about 1.54x the nominal life. Also one-directional: nothing
   * dies earlier than it did before.
   */
  varyLife: 0.5,
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
  /**
   * Fraction of the WIND speed that foam rides, on top of the current.
   *
   * Kept small deliberately. Foam floats in the skin of the water, so
   * the water's own motion should dominate and the breeze should only
   * lean it. At 0.05 the storm's 40 m/s wind contributed 2.0 m/s against
   * a 1.95 m/s current — and the storm runs its current INTO the wind,
   * so the two cancelled almost exactly and the field barely moved. Any
   * effect keyed to carry SPEED (the contact collar's wake) then scaled
   * to nothing, whatever its own knobs said.
   */
  drift: 0.012,
  /** How much of the SURFACE CURRENT foam inherits. Foam floats in the
   * skin of the water, so this is essentially 1. */
  currentCarry: 1.0,
  /**
   * Soft capacity: above `overloadStart` mass, thin foam's decay
   * accelerates toward `decayOld`, saturating at `overloadFull`.
   *
   * This is a GOVERNOR, so it silently cancels any attempt to add more
   * foam by adding more deposits. Mass accrues as amp x sigma^2 per
   * deposit and decays with a 12s time constant, so the steady state is
   * roughly (deposits/s x amp x sigma^2 x 12). Droplet landings alone
   * sat near 150 — comfortably under the old 200 — but the crest trail
   * adds ~400 deposits/s at amp 0.5 and sigma ~0.5, which is ~44 mass
   * units/s, or a steady state near 500. That pinned overload at
   * saturation and accelerated thin foam's decay to `decayOld` (3s),
   * eating the trail as fast as it was laid: the field held its old
   * total and the extra deposits bought nothing.
   *
   * Raised to fit the trail. If foam ever reads as too SPARSE after
   * turning a new source on, check window.foamMass() against these
   * before touching deposit rates or amounts.
   */
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
}

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
}

/**
 * FFT detail waves (fftwaves.ts). The transform itself is not tunable —
 * its shape comes from each preset's `detail` block — but how often it
 * runs is, because that is the whole of its frame cost.
 */
export const FFT = {
  /**
   * Run the transform every Nth frame. 1 = every frame.
   *
   * This is the only knob here that buys frame time, and it buys a lot:
   * a step is 32 render passes (two cascades x one spectrum + 14
   * butterfly stages + one resolve). They are tiny — 128x128 each, so
   * the fill is nothing — but 32 render-target binds and 32 draw calls
   * per frame is real driver overhead, and it is paid whether or not any
   * other effect is switched on.
   *
   * The field has no frame-to-frame state (each step is a fresh
   * transform of the same spectrum evolved to the current time), so
   * skipping steps is safe: the slope texture simply holds its last
   * contents. The cost is temporal — at 2 the fine sparkle updates at
   * 30Hz under a 60Hz render.
   */
  stepEvery: 1,
}

/**
 * FRAGMENT ABLATION — measurement scaffolding for the water shader.
 *
 * The water fragment is ~80% of the frame at working resolution, and
 * renderer.info cannot see inside a shader. Each switch below compiles
 * one block out of it, so its cost can be read off the fps/Mpx figure the
 * overlay reports. Everything defaults to false; turning one on makes the
 * water WRONG on purpose, which is the point.
 *
 * Measure in ms per megapixel, not fps: fps depends on window size, and
 * the whole reason this exists is that the frame scales with area. Take
 * (1000 / fps) / Mpx before and after, and the difference is that block's
 * per-pixel cost.
 */
export const PROFILE = {
  /** Underwater raytrace: refract, sphere + 3 buoy intersections, shade. */
  skipRefraction: false,
  /** Fresnel blend and the sky-gradient reflection. */
  skipReflection: false,
  /** Sun specular (a pow, plus the virtual-eye reflect). */
  skipSpecular: false,
  /** Foam thickness lookups, the web pattern and its lighting. */
  skipFoam: false,
  /** Per-pixel ripple slope (a texture gradient fetch). */
  skipRipple: false,
  /**
   * Loop white: the backface test, the Jacobian ramps, and the per-pixel
   * pinchMask refinement they can trigger. pinchMask is a full WAVE_COUNT
   * loop with a sin and cos per wave, and although it is gated to pixels
   * whose vertex estimate lands mid-ramp, GPUs branch per warp — one
   * qualifying pixel makes its whole neighbourhood pay. Also removes the
   * unconditional whitewaterLight() call that shades the ribbon.
   */
  skipLoopWhite: false,
  /**
   * Drop the water mesh entirely. Not a block — the whole surface, so the
   * rest of the scene can be priced on its own. This is the bound: what
   * is left is what no amount of shader work can recover.
   */
  hideWater: false,
  /**
   * Drop the sphere, the buoys and the sun/moon debug arcs too. With
   * hideWater this leaves an empty scene, which is the honest floor: any
   * cost that survives it belongs to the page, the compositor or the
   * driver, not to anything drawn here.
   */
  hideObjects: false,
  /**
   * Renderer-creation flags. Threlte defaults to antialias:true and
   * alpha:true, and neither is visible to any probe above: they cost
   * nothing to draw INTO, are paid at present time, and scale with canvas
   * area — which is the exact signature of the ~24ms that survives an
   * empty scene.
   *
   * antialias:true allocates a multisampled backbuffer, so every frame
   * clears and resolves 4x the pixels whether or not anything is drawn.
   * alpha:true makes the canvas translucent, so the browser composites it
   * against the page with blending instead of treating it as opaque.
   *
   * Both change output, so they are measurement switches, not fixes:
   * turning AA off costs edge quality. Needs a reload, which Apply does.
   */
  noAntialias: false,
  opaqueCanvas: false,
  /**
   * Stop each offscreen sim stepping. Their textures go stale, which is
   * visually wrong and fine for measurement.
   *
   * These exist because the gl.finish() profiler priced all four at 0.6ms
   * total, and that number is not trustworthy: browser WebGL implements
   * finish() as a flush with a partial sync rather than a true GPU
   * barrier, so it both under-reports and appears free. Ablation has
   * agreed with reality every time in this investigation; finish() has
   * not. Prefer these switches over the gpuProfile readout.
   *
   * None of them is a resolution change — the sim either runs at its
   * normal size or does not run.
   */
  skipRippleSim: false,
  skipCausticSim: false,
  skipFoamSim: false,
  /**
   * Stop DRAWING the sprite clouds while leaving them simulating.
   *
   * The point is to separate overdraw from everything else. Turning
   * ENABLE.froth or ENABLE.splashDroplets off changes how much foam gets
   * laid down, which changes the thing being measured; these do not touch
   * the simulation at all, so foam mass stays put and only the fill
   * disappears. Sprites are alpha-blended quads, so a dense cloud can
   * shade the same pixel many times over — invisible in both the draw-call
   * and triangle counts.
   */
  hideFroth: false,
  hideSpray: false,
  /**
   * Swap the isometric orthographic camera for a real PERSPECTIVE one.
   *
   * The point is the sun glitter. A glitter path is a perspective effect:
   * it exists because the view direction varies across the scene, which
   * varies the surface slope needed to mirror the sun, which makes the
   * density of qualifying facets fall away from the reflection. An
   * orthographic view has NO view-direction variation, so it cannot
   * produce one — it can only light every qualifying facet on screen at
   * once. SPECULAR.virtualEye fakes the variation, and the fake trades
   * one artefact for another: near eye gives a tight patch that appears
   * at every hour, far eye gives correct timing with a patch that grows
   * to fill the view. This switch shows what the honest version looks
   * like. It changes the whole game's look, so it is an experiment.
   */
  perspectiveCamera: false,
  /**
   * Camera distance in metres when perspectiveCamera is on. The field of
   * view is derived from it so the framing at the water plane stays put,
   * which makes this a clean "how much perspective" dial: small is a wide
   * lens up close, large converges on the orthographic look. 57 matches
   * where the isometric camera already sits.
   */
  perspectiveDistance: 57,
  /**
   * Skip the per-droplet landing check entirely. Droplets stop dying on
   * contact and fly through the water, so this is unusable for play — it
   * exists to price the check by ablation.
   *
   * Needed because micro-benchmarking the sampler in isolation put it at
   * ~15% of updateSpray, while updateSpray is ~100% of a storm frame. One
   * of those is wrong, and ablation is the method that has been right
   * every time in this investigation.
   */
  skipLandingCheck: false,
}

/**
 * REGISTRY for the tuning panel (TuningPanel.svelte).
 *
 * Listed explicitly rather than reflected off the module, so that adding
 * a helper export here cannot accidentally turn up as a row of sliders.
 * Every group is a flat map of numbers and booleans; the panel builds its
 * controls from that shape alone, which is why there is no per-knob UI
 * metadata to maintain alongside 260 values.
 */
const GROUPS = {
  ENABLE,
  FFT,
  PROFILE,
  FROTH,
  PLUME,
  LOOP,
  OBJWAVE,
  BOWCREST,
  CONTACT,
  SPECULAR,
  WIND,
  CURRENT,
  DROPLET,
  FOAM,
  MIST,
}

/**
 * The values as WRITTEN IN THIS FILE, snapshotted before any saved
 * override lands. This is what "modified" is measured against and what
 * Reset restores, so the panel keeps telling the truth about which knobs
 * have been moved even across many sessions of stored overrides.
 */
export const TUNING_DEFAULTS: Record<
  string,
  Record<string, Knob>
> = Object.fromEntries(
  Object.entries(GROUPS).map(([name, group]) => [name, { ...group }]),
)

for (const [name, group] of Object.entries(GROUPS)) {
  applyOverrides(name, group as Record<string, Knob>)
}

export const TUNING_GROUPS: Record<string, Record<string, Knob>> = GROUPS
