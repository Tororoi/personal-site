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
  /**
   * All caustic light on submerged surfaces — the projected pattern AND
   * its shadows (a blocked beam splats darkness: the sphere casts a real
   * shadow disc downstream of the sun's slant). Off = flat direct light,
   * and the whole caustic sim (splat + blur + mips) is skipped.
   */
  caustics: true,
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
  perfLog: false,
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

  /**
   * FLOOR on the froth reference, metres.
   *
   * A folding wave's size factor is loopAmp / max(seaDominantAmp, this).
   * Above the floor the reference is the sea's own biggest wave — the
   * per-sea normalisation both signed-off looks were tuned under, so
   * largeSwell and storm render exactly as before. The floor exists for
   * the seas BELOW it: without one, a calm sea normalises against its
   * own 4cm ripple and awards it full-size froth, which is the bug that
   * started all of this.
   *
   * A fully fixed reference was tried twice and cannot work: the tuned
   * looks disagree about what a 0.87m wave deserves (full size on
   * largeSwell, half on storm), so no single absolute curve reproduces
   * both. max(dom, floor) is relative where the tuning lives and
   * absolute where relativity lied.
   */
  ampRef: 0.87,
  /**
   * Exponent on the amplitude ratio before the clamp; 1 is linear, the
   * default. Below 1 lifts SMALL ratios hardest — 0.25 sent every
   * floor-sitting mid wave from 0.3 to ~0.55 and read as a huge global
   * froth amplification. Kept wired in case a soft knee is ever wanted.
   */
  ampCurve: 1.0,
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
  sharpClear: 4000,
  // Equal to sharpClear, and gainOvercast equals gainClear, so cloud
  // cover no longer changes the highlight at all. That is a choice, not
  // an oversight: split them again to get the soft overcast sheen back.
  sharpOvercast: 4000,
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
  gainClear: 5,
  gainOvercast: 5,
  /**
   * How much the surface's Fresnel dims the highlight, 0-1. 0 adds it at
   * full strength whatever the angle, 1 obeys Fresnel exactly. Partial,
   * because obeying it fully loses the glitter this camera is looking
   * for and ignoring it makes the sea shine from underneath.
   */
  fresnelMix: 1.0,
  /**
   * SEA-STATE BLEND. Everything named *Storm below is the value at a
   * storm's chop; the plain name is the value on calm water, and the sea's
   * own `chop` cross-fades between them.
   *
   * A calm sea mirrors: a tiny slope spread, so the sun's image survives
   * as a hard point and wants a very tight lobe. A storm shatters it
   * across thousands of steep facets, and the same lobe there picks out
   * almost nothing — it needs to be slack enough to catch the spread the
   * water actually has. One setting cannot do both, which is why these
   * are paired rather than compromised.
   *
   * The endpoints are the presets' own chop values, so largeSwell needs no
   * third set of its own. To actually MAKE the sea rougher and see these
   * cross-fade, use SEA.chopOverride — nothing in this group changes the
   * water.
   */
  /**
   * WHICH MEASURE OF THE SEA drives the calm/storm blend, as weights over
   * three normalised metrics (see seaDrive in waves.ts). They need not sum
   * to 1, and each is normalised against its own calm-to-storm range, so a
   * weight means the same thing across metrics despite the units differing.
   *
   * Slope carries all of it by default, because that is what the specular
   * physically responds to: the glitter's spread IS the surface slope
   * distribution, and the lobe is computed in slope space. Chop was the
   * original driver and is the worst of the three — it is a normalised fold
   * budget, not a physical property, and it tracks the sea only loosely.
   */
  driveSlope: 1,
  driveAmp: 0,
  driveChop: 0,
  /**
   * Curve on the drive: t = seaDrive(...) ^ this.
   *
   * Below 1 it rushes toward the storm values, which is what a sea state
   * actually does. 0.3 is solved to keep largeSwell at roughly twice the
   * storm values, as it was under the old chop driver — but it needed
   * re-solving, because slope puts largeSwell at 50% of the calm-to-storm
   * range where chop put it at 38%. 1.0 gives the plain linear ramp.
   */
  driveCurve: 0.3,
  sharpClearStorm: 100,
  sharpOvercastStorm: 100,
  sharpPeakStorm: 200,
  cameraEyeDistanceStorm: 140,
  /**
   * SHARPNESS SPIKE — a brief tightening of the core lobe as the sun
   * crosses a chosen moment, so the glitter snaps from a shimmer to a hard
   * point and back.
   *
   * Applied to sharpClear before it blends with sharpOvercast, so splitting
   * those two later keeps the spike on the clear-sky term where it belongs.
   *
   * Keyed on day PHASE rather than sun altitude, unlike the low-sun ramp
   * below. That is a deliberate difference: the ramp tracks a physical
   * cause (a low sun lengthens the reflection), while this is a staged
   * moment. The cost is that the four phases are tied to the current sun
   * path — change sunPathAngleDeg or sunPathOffsetDeg and the sun reaches
   * this point at a different time, so they need re-finding.
   */
  sharpPeak: 8000,
  /** Rise: sharpClear -> sharpPeak across these two phases. */
  spikeInStart: 0.69,
  spikeInEnd: 0.704,
  /** Fall: back down to sharpClear across these two. Between spikeInEnd
   * and spikeOutStart it holds at the peak. */
  spikeOutStart: 0.705,
  spikeOutEnd: 0.72,
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
  cameraEyeDistance: 700,
  /**
   * Height of the simulated viewpoint, as a multiple of the height the
   * view axis would give it (0.53 x distance, i.e. the camera's own 32
   * degree elevation).
   *
   * Split from distance because the two do different jobs and were welded
   * together. Distance sets how hard the rays fan, so it controls FOCUS.
   * Height sets where the reflection lands — the centre sits at
   * height / tan(sunAltitude) away — so it controls how fast the highlight
   * FLEES as the sun drops, and therefore how long the window lasts.
   * Below 1 the viewpoint stoops toward the water: tighter tail, longer
   * window. Above 1 it rises and the reflection runs off sooner.
   */
  cameraEyeHeight: 0.35,
  /** Lobe sharpness relative to the core. Lower = catches slacker facets,
   * so the shimmer reaches further and survives a lower sun. */
  haloSharp: 0.15,
  /** Brightness relative to the core. */
  haloGain: 0.2,
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
  anisotropy: 3.0,
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
  // 200 is deliberately past any altitude the sun can reach (90 is
  // straight up), so the cross-fade never completes and the low-sun
  // values are partly in effect all day, ramping gently rather than
  // switching in near the horizon. Set it inside 0..90 to get a band.
  altHigh: 200,
  altLow: 7,
  /** Halo brightness at low sun — the wash carries it once the core thins. */
  haloGainLow: 0.2,
  /**
   * Sun altitude below which the whole specular fades out, degrees. The
   * sun reddens and dims into the horizon haze; without this the glitter
   * would simply blink off when the light handed over to the moon.
   */
  fadeAltDeg: 3,
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
  /**
   * Ambient wave slope from the VERTEX stage (interpolated) instead of
   * the per-pixel analytic loop. Cheaper by one WAVE_COUNT loop per
   * water fragment, but the interpolation kinks at quad edges and
   * refraction magnifies the kinks into streaks at the buoy waterline.
   */
  vertexSlope: false,
  /**
   * Splat brightness from per-fragment derivatives (FLAT per warped
   * triangle) instead of the per-vertex Jacobian trace. Cheaper by two
   * ray evaluations per splat vertex (~3x less splat vertex ALU), but
   * thin filaments come out as beaded triangle steps instead of smooth
   * gradients. The perf/quality A/B for the caustic splat.
   */
  flatCausticSplat: false,
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
   * once. The simulated viewpoint (SPECULAR.cameraEyeDistance) supplies
   * that variation for the isometric camera; this switch shows what the
   * honest version looks like instead. It changes the whole game's look,
   * so it is an experiment rather than a setting.
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
  /**
   * Stream per-frame buoy state and every buoy-caused ripple/spray event
   * to the perf sink (tools/perf-logger.mjs), for hunting the vertical
   * jitter that offline simulation does not reproduce. Start the sink,
   * switch this on, play until the jitter shows, note roughly when.
   */
  buoyLog: false,
}

/**
 * SEA — overrides on the wave field itself (waves.ts), for testing.
 */
export const SEA = {
  /**
   * Replace the active preset's `chop`. Negative leaves the preset alone.
   *
   * For sweeping a continuous band of sea states rather than jumping
   * between the three presets — the SPECULAR pairs are cross-faded on
   * chop, and the only way to know the in-between values look right is to
   * sit at one. Presets are calm 0.55, largeSwell 2.25, storm 5, and 5 is
   * the top of the range — the storm is the roughest real sea here.
   *
   * LIVE: the field is rebuilt in place and the wave uniforms re-uploaded
   * the moment this moves. See applySeaState in waves.ts for what does NOT
   * follow — the FFT detail band, foam's chop thresholds and the whitecap
   * heading are baked at load and still want a reload.
   */
  chopOverride: -1,
  /**
   * Position on the continuous sea-state axis: 0 calm, 1 largeSwell,
   * 2 storm. Negative uses the preset as loaded (?sea=), unblended.
   *
   * Overrides which preset is in effect. chopOverride still applies on
   * top, so the two compose — blend to 0.6 and then push chop separately.
   *
   * LIVE, like chopOverride — ramp it from gameplay and the sea builds.
   */
  /**
   * Use the UNIFIED field instead of the presets. Overrides seaState and
   * ?sea=; chopOverride still applies on top.
   */
  useUnified: false,
  seaState: -1,
  /**
   * Seconds PER UNIT of seaState change. 0 snaps.
   *
   * A rate, not a duration: calm to storm is twice the journey of calm to
   * largeSwell and takes twice as long. A fixed duration made big changes
   * move fastest, which is backwards — the bigger the change, the more the
   * wave field has to deform, and the more time it needs to not read as
   * churn.
   *
   * Critically damped, so it eases in AND out and never overshoots. It
   * chases the knob rather than animating a fixed span, so moving the
   * target mid-transition bends the curve instead of restarting it.
   */
  transitionSecondsPerUnit: 25,
}

/**
 * UNIFIED SEA — the whole ocean on a handful of sliders.
 *
 * The band structure (wavelengths, headings, spreads, per-band slope
 * balance) is FIXED, in UNIFIED_BANDS in waves.ts: interpolating
 * wavelength or heading churns the surface, because both sit inside the
 * (position . direction) * k phase term. What a sea state actually varies
 * is energy and weather, and that is all these knobs drive.
 *
 * `waves` is the one calm-to-storm dial: 0 matches the calm preset's
 * energy, 1 largeSwell's, 2 the storm's — band slopes scale geometrically
 * through those measured landmarks and chop lerps through the presets'
 * values, so froth, foam, droplets and the specular all follow through
 * the systems they already key on.
 *
 * `weather` is deliberately separate: cloud cover is not a function of
 * wave height. It drives sky colour and sun diffusion, which is what the
 * caustics and the specular's clear/overcast blend already read.
 *
 * Compass knobs: 0 north, 90 east, 180 south, 270 west, calibrated so
 * WEST is where the default sun path sets (world azimuth 226). Bearings
 * are the direction the wind/current moves TOWARD.
 */
export const UNIFIED = {
  /** 0 calm .. 1 largeSwell .. 2 storm. */
  waves: 1,
  /** 0 clear blue .. 1 heavy overcast. */
  weather: 0.4,
  /** m/s. Spray advection, gusts, and the FFT detail spectrum's shape. */
  windSpeed: 9,
  /** Compass bearing the wind blows toward. 68 = the presets' heading. */
  windCompassDeg: 68,
  /** Compass bearing the surface current sets toward. */
  currentCompassDeg: 68,
  /** m/s. */
  currentSpeed: 1.55,
  /** Global tempo multiplier on every wave's phase speed. */
  timeScale: 1,
  /**
   * Multiplier on every band's wavelength. Moves SIZE without touching
   * STEEPNESS — a component's slope is amp * k and the wavelength cancels
   * — so this is the knob that separates the two, and the one exception
   * to "wavelengths are fixed": a uniform stretch keeps every phase
   * relationship, so it does not churn the way per-band edits do.
   */
  lambdaScale: 1,
  /** FFT surface-detail band: the SIZE of the fine texture, metres... */
  detailMin: 0.4,
  detailMax: 4,
  /** ...and its strength, as RMS slope. */
  detailSlope: 0.055,
}

/**
 * UNDERWATER — how submerged things are lit, and how the caustic pattern
 * behaves on them. All live (uniform-fed per frame).
 *
 * ONE shading path for every submerged surface — sphere, buoys, seabed,
 * the rainbow card, and the boat (its image pass captures unlit albedo,
 * so the refracted hull is lit here like everything else).
 */
export const UNDERWATER = {
  /**
   * Ambient on submerged surfaces, as a MULTIPLE of the ambient the same
   * object would receive in air. 1.0 matches it, so nothing jumps as it
   * crosses the surface; the sky still supplies the hue.
   *
   * This used to be a raw scale on the sky colour, which is the sea
   * preset's and barely moves through the day — so submerged things held
   * a fixed ambient while everything in air dimmed toward dusk, and 1.0
   * meant roughly FIVE times the above-water level at noon.
   */
  ambient: 1.0,
  /**
   * Refracted-sun diffuse on flat-albedo objects, as a MULTIPLE of the
   * above-water directional lighting. At 1.0 the only differences left
   * are the physical ones: Fresnel loss at the surface, and the beam's
   * concentration by refraction.
   */
  direct: 1.0,
  /**
   * The raytraced SEABED: whether it exists, and its depth in METRES
   * below the mean surface. Off, the refracted ray never lands — every
   * underwater pixel is pure water column, the open-ocean look. The
   * depth feeds the same extinction and caustic-defocus maths as any
   * submerged surface, so a deeper floor darkens and blurs on its own;
   * the caustic map is still splatted at its fixed focal plane, so
   * brightness and blur follow this knob but the pattern's scale
   * doesn't.
   */
  seabed: true,
  seabedDepthM: 6,
  /**
   * FADE RANGE, in METRES: the depth at which each channel is 90% gone
   * (10% of the light left). Beer-Lambert, so the shader converts with
   * sigma = ln(10) / range.
   *
   * Stated as a distance because that is how the effect is actually
   * known — "red disappears around 15 feet" — and the per-metre
   * coefficients it produces are the real ones: 5m gives 0.46/m against
   * pure water's measured 0.465 at 680nm, and 30m gives 0.076 against
   * 0.064 at 550nm. Blue at 90m implies 0.025/m, which is real SEAwater
   * with its dissolved organics rather than distilled water (0.009,
   * ~250m) — the right choice for an ocean.
   *
   * Defaults are the standard clear-water figures: red 15ft, orange
   * 30ft, yellow 50ft, green 100ft, blue past 300ft. Only red, green and
   * blue are set directly — orange and yellow are mixtures of the red
   * and green channels and fade where those two leave them, which lands
   * them near their real depths without a knob of their own. Hitting all
   * five exactly would take spectral rendering, not RGB.
   *
   * Lower a range for murkier water; raise it for gin-clear.
   */
  redRangeM: 10,
  greenRangeM: 60,
  blueRangeM: 180,
  /**
   * RAYLEIGH backscatter — molecular, per metre, quoted at green (550nm).
   *
   * Scattering is absorption's mirror image: water absorbs LONG
   * wavelengths first and scatters SHORT ones hardest. Pure water
   * molecules follow lambda^-4.3, which the shader applies as channel
   * weights (0.40, 1.00, 2.38) — blue scattered 5.9x more than red,
   * matching the ~5x figure for real water. This term alone is what
   * makes the open ocean deep blue.
   */
  rayleighScatter: 0.006,
  /**
   * MIE backscatter — plankton and sediment, per metre, EQUAL across
   * channels.
   *
   * Particles much larger than the wavelength scatter every colour
   * alike, so this returns white light into the column. Filtered through
   * the water's own absorption it lands as green or teal rather than
   * white, which is exactly why coastal water is green where open ocean
   * is blue: at the defaults, raising this lifts the green/blue ratio of
   * the deep colour from 0.14 toward 0.33. Shortening blueRangeM
   * (dissolved organics absorbing blue) is the other half of the coastal
   * look — the two together are the whole mechanism.
   */
  mieScatter: 0.0008,
  /**
   * How much of the extinction shows up as DARKENING, versus only
   * shifting hue.
   *
   * 1.0 is literal single-scattering physics — and it over-darkens,
   * because this model only ever removes light from a path and never
   * puts any back. In real water most of what a blue photon "loses" to
   * scattering is redirected, not absorbed, and a good share of it
   * rejoins the view; simulating that needs multiple scattering, which
   * this does not do. Below 1.0 the transmittance is renormalised so the
   * brightest surviving channel is preserved and the others still fall
   * away relative to it: colour goes in the same rainbow order, without
   * everything sinking into gloom. 1.0 if you want the raw physics.
   */
  dim: 0.65,
  /**
   * The water column's own glow as a LIGHT SOURCE on submerged surfaces.
   *
   * Backscattered light does not just hang between the camera and an
   * object, it also illuminates that object from every side — which is
   * why a diver at depth is lit blue rather than merely dark. Zero at
   * the surface (so nothing jumps at the waterline) and growing with
   * depth as the beam gives way to the scattered field.
   */
  glow: 1.0,
  /**
   * WRAP on the underwater direct light, matching the dry sphere's own
   * wrap term ((N.L + wrap)/(1 + wrap)).
   *
   * The dry branch softens its terminator so a flank at N.L = 0 still
   * gets 29% of the direct light; the underwater path used a hard
   * clamp, so the same flank went to ambient-only the moment it crossed
   * the surface — most of what the camera sees of a sphere or hull IS
   * flank, which read as "everything darkens when it submerges",
   * caustics on or off. Physically the wrap stands in for the scattered
   * field filling side faces, which real water does even harder than
   * air. 0 restores the hard clamp.
   */
  wrap: 0.4,
  /**
   * How much light gets deep enough to scatter back — clear vs overcast.
   *
   * Clear sunlight is directional and drives deep into the column, so
   * plenty returns as blue. Overcast light arrives diffuse and shallow,
   * is absorbed near the surface, and far less comes back — which is why
   * an overcast sea reads grey and flat rather than merely darker blue.
   * Blended by the sea's own sun diffusion.
   */
  scatterClear: 1.0,
  scatterOvercast: 0.3,
  /**
   * FRESNEL FLOOR — how much sky the surface reflects when looked at
   * head-on, and the largest single source of blue over anything
   * underwater.
   *
   * At this camera (32 degrees above the horizon) a 0.25 floor worked
   * out to ~0.33 — a third of every water pixel was sky before the
   * refracted view got a say, and it was the real reason shallow objects
   * read blue. Physical Fresnel for water at that angle is ~0.05. Now
   * that the sea's colour comes from backscatter, where it physically
   * comes from, this can sit near zero and the water still reads as
   * water. Grazing angles still mirror the sky regardless: the term
   * rises to 1 as the surface turns edge-on.
   */
  surfaceReflect: 0.02,
  /**
   * Strength of the GRAZING rise in the surface reflection — the part of
   * Fresnel that climbs toward a full mirror as a wave face tilts
   * edge-on. 1 is physical Schlick; below 1 the water stays transparent
   * on tilted faces (less sky painted over whatever is beneath a passing
   * wave), 0 leaves only the flat surfaceReflect floor at every angle.
   *
   * WHERE IT HAS AUTHORITY: steep faces. Full-range, it moves a storm
   * face 2% -> 21-38% sky; flat calm water only 2% -> 4%, which is
   * imperceptible — on a calm sea this slider does nearly nothing, by
   * physics, not by bug. NOTE: the sun glitter reads the same Fresnel
   * through SPECULAR.fresnelMix, so pulling this down also softens how
   * strongly the glitter favours tilted faces.
   */
  fresnelGrazing: 1.0,
  /**
   * Scale on the Fresnel loss of SUNLIGHT entering the water — the
   * "did the light get in" half, distinct from the view-path reflection
   * above. 1 is physical; 0 lets every ray in.
   *
   * WHERE IT HAS AUTHORITY: low sun only. The loss is ~2% at midday
   * (imperceptible either way), 8% at 26 degrees, 24% at 15, 48% at 8 —
   * this is the dial for how hard dusk dims the underwater world, and a
   * midday A/B will show nothing, by physics.
   */
  entryLoss: 0.0,
  /**
   * Blend of the underwater ambient toward a sky-hued version (same
   * luma). 0 = the exact per-channel ambient the object would get in
   * air, which is the physical choice — the water column's own
   * wavelength filtering is applied separately and correctly by the
   * extinction. RENAMED from ambientSkyTint on purpose: the old
   * luma-matched formula pumped the blue channel ~2.2x and starved red,
   * so a stale saved override must not resurrect it.
   */
  ambientSkyHue: 0.15,
  /**
   * A flat six-band rainbow card beside the sphere, riding at the same
   * height. A measuring instrument, not scenery: each band loses its
   * colour at its own depth, so the per-channel absorption becomes
   * directly readable — red should go first and violet-blue last as you
   * sink it. Hard edges between bands on purpose, so the fade of one
   * band is judged against its neighbour rather than a gradient.
   */
  rainbowCard: true,
  /**
   * Sphere centre height, metres (radius is 5). -6 sinks it just under;
   * +5 lifts it clear of the water. A staging control for judging the
   * underwater lighting against a body of known shape.
   */
  sphereDepth: -6,
  /**
   * Flat brightness multiplier on submerged shading — the honest fudge
   * for the gap this model has not closed analytically.
   *
   * Measured on the rainbow card at 1.5m in calm water (framebuffer is
   * LINEAR, calibrated by rendering a known constant): warm bands land at
   * 0.37-0.40 of their above-water value, which IS the absorption model
   * working; blue bands come out at 1.13-1.17, brighter, from in-scatter;
   * but green sits near 0.43-0.58 where extinction alone predicts ~0.85.
   * Part of that is the above-water card measuring ~1.3x brighter than
   * its own analytic model (MeshStandardMaterial adds a specular lobe the
   * underwater path has no equivalent for). Until that is chased down,
   * this closes the gap by eye — try ~1.3 to match the waterline.
   */
  exposure: 1.0,
}

/**
 * CAUSTICS — everything about the refracted light pattern on submerged
 * surfaces: how sharp it is born, how it spreads and fades with depth,
 * and how bright its filaments and shadows run. All live. The pattern
 * itself is the forward-splat map (caustics.ts); ENABLE.caustics kills
 * the whole system.
 */
export const CAUSTICS = {
  /**
   * SOURCE BLUR, metres of Gaussian sigma at the map — the sun's
   * angular size projected through the water, decoupled from weather on
   * purpose. 0.05 and below is effectively off (razor lines); past ~0.2
   * the blur pipeline drops to a quarter-resolution path, the
   * fine-detail cliff. Capped at 0.62 inside the map.
   */
  sourceBlurM: 0.05,
  /**
   * SPLAT RAY SPACING, metres between refracted rays at the surface.
   * The resolving power of the whole caustic pattern: filaments narrower
   * than the ray grid come out grainy or beaded. 0.104 is the density
   * the pattern was originally tuned at; lower is sharper and costs
   * splat vertices quadratically. The lattice never drops below 48 rays
   * a side (the historical minimum — on small windows that floor is
   * finer than this target, and it is what the look was approved at).
   * Live — the splat lattice rebuilds on the next frame.
   */
  raySpacingM: 0.104,
  /**
   * PEAK brightness clamp on the splat, as a multiple of neutral. The
   * fold singularities are where the pattern's pointwise brightness
   * genuinely diverges, and the ray lattice sampling that ridge returns
   * speckle between "large" and this clamp — the aliasing that only
   * shows on the BRIGHTEST caustics. A real sun is an extended source
   * (~0.5 deg), which physically bounds peak concentration to roughly
   * order ten: lower clamps saturate the ridge into a solid bright core
   * instead of sparkle. 30 was the historical value.
   */
  maxBright: 30,
  /**
   * TEMPORAL ACCUMULATION, 0..0.92: weight of the running history the
   * fresh splat blends under each frame. The map's residual aliasing is
   * fold-overlap wedge noise — the ray lattice sampling near-singular
   * filaments returns lattice-dependent structure no post-filter can
   * repair. With this on, the lattice is JITTERED each frame (Halton,
   * deterministic) and the history integrates the samples: structured
   * error becomes noise, noise averages away, and on frozen water the
   * pattern converges to the true integrated brightness. Higher = longer
   * memory = smoother but laggier under fast seas; 0.75 is ~4 frames.
   * The history scrolls with the travelling domain and reseeds on any
   * extent or lattice change. 0 disables jitter and accumulation both.
   */
  temporalAA: 0.75,
  /**
   * SUBPIXEL caustic taps per underwater pixel, 1..256. Rounded to a
   * square grid (1, 4, 9, 16, ... 256) spread across the pixel's true
   * footprint on the receiver (hardware derivatives). 1 = single point
   * sample; more taps integrate the refraction-magnified footprint that
   * point sampling shimmers over. Cost is linear in taps on every
   * underwater pixel.
   */
  subSamples: 9, // converged by eye: no appreciable gain past 9
  /**
   * EDGE-DIRECTED ANTIALIAS on the splatted map, 0..1. Where the map has
   * a strong gradient (a filament border), texels are blended ALONG the
   * isoline only — the staircase smooths while the profile ACROSS the
   * filament (width, peak) is untouched, and flat regions pass through
   * unchanged. This is FXAA's core idea specialized to the map: it is
   * not a blur — no energy crosses an edge. 0 skips the pass.
   */
  edgeAA: 1,
  /**
   * FOCAL DEPTH, metres below mean water level, where the pattern is
   * sharpest. GATES blurPerM: the floor's blur authority is
   * (floorDepth - focalM) x blurPerM. Physically f ~ 0.24 x wavelength
   * / slope for the chop that makes caustics (~6-9m here); lower it to
   * hand the blur knob authority higher in the column.
   */
  focalM: 0,
  /**
   * Metres of defocus-kernel per metre past the focal depth — how fast
   * the pattern spreads and softens going down (the blur pyramid:
   * features grow, peaks dim, energy holds). 0 = equally sharp at every
   * depth. Measured against depth below MEAN water level, so a passing
   * swell does not swing the seabed between sharp and soft.
   */
  blurPerM: 0.1,
  /**
   * FORMATION ramp, metres: refracted rays need a little distance to
   * converge, so there is no pattern at the very interface; it fades in
   * over this depth.
   */
  formM: 0.02,
  /**
   * Directional-light survival depth, metres: pattern strength falls as
   * exp(-depth / this), because scattering destroys the beam direction
   * that caustics ARE. THE brightness-dropoff-with-depth knob — at 45 a
   * 6m floor keeps 87% of the pattern; at 8 it keeps 47%. Also relaxes
   * lighting incidence toward omnidirectional at the same rate (same
   * physics, same cause).
   */
  diffuseDepthM: 45,
  /**
   * CONTRAST about the pattern's neutral point: light' = 1 + (light-1)
   * x this. Gives back the punch the mean-normalisation and the sRGB
   * output encode compress (measured: together they halved relative
   * contrast). Ridges brighten and dips deepen symmetrically.
   */
  contrast: 1.0,
  /**
   * Additive ridge brightness on flat-albedo objects. 1.0 is
   * energy-neutral: the diffuse term clamps the pattern at <= 1 and
   * this re-adds exactly the clamped-off ridge energy, so caustics
   * redistribute light instead of minting or stealing it.
   */
  ridgeGain: 1.0,
  /**
   * How dark a caustic shadow may drive the direct light. Also
   * insurance: any patch the splat misses reads as pitch shadow rather
   * than "no data" without a floor. Real troughs are not black either.
   */
  floor: 0.35,
  /**
   * Sun-diffusion band over which the pattern washes to featureless
   * light (weather's remaining caustic effect): start = where washing
   * begins, end = fully flat.
   */
  flatStart: 0.35,
  flatEnd: 1.0,
}

/**
 * INSPECT — debugging instruments, all staged (reload to apply). Nothing
 * here is gameplay: an isolation sea for studying a single wave, and a
 * re-aimable camera for looking at it side-on. The /wave route is the
 * matching 2D cross-section viewer.
 */
export const INSPECT = {
  /**
   * ISOLATION SEA: replace the whole banded spectrum with ONE large
   * rolling wave (waves.ts simpleSeaWaves), so behaviour can be judged
   * against a single readable crest. The sea-preset dial and UNIFIED
   * knobs are inert while this is on.
   */
  simpleSea: false,
  /** Wavelength of the single wave, metres. */
  simpleLambdaM: 64,
  /** Amplitude, metres. */
  simpleAmpM: 3,
  /**
   * Steepness as q*k*amp: 0 = pure sine, 1 = crest pinched vertical,
   * above 1 it loops.
   */
  simpleSteepness: 0.77,
  /** Travel heading, degrees (0 = +x; 315 is perpendicular to the stock camera). */
  simpleHeadingDeg: 315,
  /**
   * INSPECTION CAMERA. Yaw rotates the iso camera around the boat
   * (degrees; 0 = stock, which views toward azimuth 225 — already
   * perpendicular to a 315-degree wave). Elevation replaces the stock
   * ~32-degree down-look when non-zero (floored at 5); low values give
   * a wave's cross-section silhouette. The water mesh follows both; the
   * HUD compass and caustic coverage keep their stock alignment and sit
   * wrong at other angles — inspection tools, not gameplay.
   */
  camYawDeg: 0,
  camElevDeg: 0,
}

/**
 * BOAT — the player's hull. Same heave physics as the buoys (spring on
 * submersion) with its own constants, plus drive. All live.
 */
export const BOAT = {
  /** m/s^2 at full throttle. */
  thrust: 6.0,
  reverseThrust: 1.5,
  /** Linear + quadratic hull drag; together they set the top speed
   * (~5.8 m/s at the defaults: thrust = dragLinear*v + dragQuad*v^2). */
  dragLinear: 0.45,
  dragQuad: 0.045,
  /** rad/s of rudder at speed, and the fraction available at standstill. */
  turnRate: 1.5,
  turnMin: 0,
  /**
   * How far below its mount the propeller reaches, metres — the depth of
   * the air-control gate. Control holds while the water surface is
   * within this distance below the prop mount, because a real lower
   * unit sits DEEP: a Whaler's prop is ~0.4m under the transom, so a
   * small rise of the stern does not stop the screw biting. The first
   * version used a 5cm grace and cut control on the slightest lift.
   */
  propDepthM: 1.0,
  /**
   * WATER-ENTRY resistance (slamming), an upward drag of
   * entryDrag x (relative fall speed)^2 while penetrating. Real entry
   * force scales with rho v^2 x presented area — the faster the impact,
   * the harder water resists, which is why a dropped hull slaps to a
   * stop near the surface instead of submarining. Pitch streamlines it:
   * a steep bow-first attitude cuts the slam by up to 80%, so a diving
   * entry CAN still bury the bow. 2.5 stops a 6 m/s flat drop in about
   * 20cm; the old spring-only model let the same drop sink ~2m.
   */
  entryDrag: 2.0,
  /**
   * ARCADE AIR CONTROL: when true, throttle and rudder keep working with
   * the prop out of the water. False is the physical model — a motor
   * screaming in air moves nothing. (Momentum behaves physically either
   * way: no water drag in the air, yaw keeps spinning.)
   */
  airControl: false,
  /**
   * How far FORWARD of the hull's centre the turn pivots, metres. A boat
   * does not spin like a turntable: the rudder pushes the STERN
   * sideways, so the hull rotates about a point near the forward third —
   * the bow holds its line while the stern sweeps out. 1.5 puts the
   * pivot a third forward on this hull, giving the transom a ~4m arm.
   * 0 restores centre-spin. Water-only: an airborne hull genuinely does
   * rotate about its own centre of mass.
   */
  turnPivotM: 1.5,
  /**
   * How fast the yaw rate chases the rudder's command, 1/s. Yaw is a
   * STATE with momentum now, not a direct rotation: high values feel like
   * the old instant steering, but a launch no longer freezes a turn
   * mid-spin — the boat keeps rotating through the air.
   */
  yawResponse: 4,
  /**
   * Yaw damping when the hull is wet but the prop is OUT (stern kicked
   * clear over a crest): the water still sheds spin, just without the
   * rudder's authority. Fully airborne sheds none.
   */
  yawWaterDrag: 1.2,
  /**
   * How hard the keel bleeds SIDEWAYS slip, 1/s. Velocity is a vector
   * now, coupled to the facing only through the water: the keel slides
   * freely along its own axis and resists crossing it, which is what
   * makes a boat carve onto its nose instead of teleporting its momentum
   * whenever the bow swings. High = rails like the old model; low =
   * drifty; airborne = zero, so a launch carries the true launch vector
   * no matter how the hull spins on the way down.
   */
  keelGrip: 4,
  /**
   * Shortest wavelength that slides the boat, metres. The hull BRIDGES
   * waves shorter than itself — their slopes average away across the
   * waterline — so only components with lambda above ~half this ramp in,
   * full weight at this value. 24 means the swell bands slide the boat
   * while wind chop and ripple do nothing, however steep.
   */
  slideLambdaM: 24,
  /**
   * Fraction of the true gravity-slide felt on a tilted surface. A
   * floating hull's buoyancy is normal to the water while gravity is
   * straight down; the tangential remainder, g x surface-gradient,
   * accelerates it downslope — real boats surf exactly this force. 1 is
   * physical (a 0.2-slope face pulls ~2 m/s^2); default well below,
   * per "minor effect". Steeper waves push harder for free, since the
   * gradient IS the steepness.
   */
  slopeSlide: 0.7,
  /**
   * ORBITAL FOLLOWING, not push: water particles in a non-breaking wave
   * travel closed circles, and a floating hull rides that circle — the
   * elliptical surge of a moored boat, with ZERO net thrust over a wave
   * period. Implemented as hull drag acting in the moving water's frame.
   * 1 = the hull fully rides the orbit; 0 = the water's motion is
   * ignored. Net propulsion belongs to breakPush below, because only a
   * BREAKING wave actually throws water.
   */
  orbitalMotion: 0.5,
  /**
   * BREAKING-CREST push, m/s^2 at a full fold. Where the orbit fails —
   * the Jacobian says the crest is folding — water is thrown forward
   * near phase speed onto the front face, and THAT is the shove a hull
   * really feels from waves. Fires only on a RISING front face with a
   * breaking crest uphill of the hull, shoves straight down the face
   * (forward-only by construction), and scales with how far that crest
   * towers above the boat — 1m of crest overhead is nominal, a 2.5m
   * storm wall hits 2.5x, a knee-high fold gets the 0.3 floor. This is
   * the surf mechanic.
   */
  breakPush: 5,
  /** Heave: natural bob period (s) and damping ratio. Longer and more
   * damped than the buoys — a hull, not a cork. */
  /** THE WEIGHT DIALS. Period is inertia against buoyancy: short = cork
   * that chases every crest, long = mass that lags and cuts through.
   * Zeta is how dead the response is: low rings and OVERSHOOTS — and the
   * overshoot velocity is what flings a hull airborne off a crest. The
   * airborne threshold also scales: detach needs g/(2pi/T)^2 metres above
   * equilibrium — 0.64m at T=1.6, 1.95m at T=2.8. */
  bobPeriod: 2.0,
  bobZeta: 0.2,
  maxSubmersion: 0.5,
  /**
   * How much waves ROLL the boat (side to side) and PITCH it (fore and
   * aft) — separate authorities over the same wave slope, decomposed in
   * the boat's own frame. The shared spring (righting, tiltZeta) still
   * provides the WEIGHT: the hull does not snap to the water's angle, it
   * swings toward it with momentum and overshoot. A beamy hull rolls
   * less than it pitches; these two set that character.
   */
  rollGain: 1.0,
  pitchGain: 1.5,
  /**
   * Resting stern-down trim, radians: the engine's weight sits the
   * transom lower in the water, so the hull's neutral attitude is
   * slightly bow-up before speed trim adds to it. ~0.04 rad is 2.3
   * degrees.
   */
  sternTrim: 0.04,
  /**
   * THE SWING LEVERS, per axis. Zeta is how much the hull swings back
   * and forth: below ~0.5 it overshoots the water's angle and rocks
   * through visible cycles before settling; near 1 it eases on with no
   * overshoot. Righting is the swing SPEED (spring stiffness) — how
   * quickly each axis chases its target. rollGain/pitchGain above set
   * how far the waves command; these set the character of getting
   * there. Roll defaults looser than pitch because boats ROLL — a hull
   * is length-damped in pitch but rocks freely on its beam.
   */
  pitchRighting: 20,
  pitchZeta: 0.75,
  rollRighting: 8,
  rollZeta: 0.25,
  /** Bow-up trim per m/s of forward speed, radians. */
  trimPerSpeed: 0.028,
  /**
   * Extra bow-up per m/s^2 of forward ACCELERATION (throttle surge), on a
   * ~0.3s low-pass so it reads as the hull leaning back under power and
   * settling, not as a twitch per keypress.
   */
  trimPerAccel: 0.022,
  /**
   * Planing lift: metres of extra ride height per (m/s)^2, capped. A hull
   * with way on rides higher in the water; v-squared because that is what
   * dynamic lift actually scales with.
   */
  liftPerSpeed: 0.018,
  liftMax: 0.26,
  /** Wake: continuous ripple poke, per step at full speed. */
  wakeAmp: 0.016,
  /**
   * Where along the hull the wake poke is laid, metres fore of centre
   * (bow +2.3, stern -2.3). The bow shoulder is where a hull actually
   * pushes water aside, and the wave equation still trails the V behind.
   */
  wakeOffset: -0.8,
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
  SEA,
  UNIFIED,
  BOAT,
  UNDERWATER,
  CAUSTICS,
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
  INSPECT,
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

/**
 * Groups the panel edits LIVE, with no Apply and no reload.
 *
 * The default for everything here is STAGED, because these values are
 * interpolated into shader source as literals and a running material
 * cannot be re-linked. A group earns its place in this set only once every
 * one of its knobs reaches the scene through a uniform refreshed each
 * frame — otherwise the panel would report a change that never landed,
 * which is worse than asking for a reload.
 */
export const LIVE_GROUPS = new Set([
  'SPECULAR',
  'SEA',
  'UNIFIED',
  'BOAT',
  'UNDERWATER',
  // Every CAUSTICS knob reaches the scene through a per-frame uniform
  // (or the map's own per-step property), so the whole group is live.
  'CAUSTICS',
])
