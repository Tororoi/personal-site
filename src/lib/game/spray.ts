/**
 * Ballistic spray: the AIRBORNE class of white water.
 *
 * Ihmsen et al. ("Unified spray, foam and air bubbles for particle-based
 * fluids", 2012) classify diffuse water into spray (flies), foam (sits on
 * the surface) and bubbles (rises under it), each spawned by physically
 * motivated criteria and simulated as a cheap post-process on the main
 * fluid. This module is our spray class; froth.ts is already the foam
 * class; bubbles wait for an underwater camera.
 *
 * The heightfield coupling follows O'Brien & Hodgins ("Dynamic Simulation
 * of Splashing Fluids", 1995): the surface spawns particles where it
 * breaks or is struck, particles fly ballistically under gravity + wind
 * drag, and EVERY landing hands displacement and momentum back to the
 * surface systems — a ripple injection, plus a tight froth deposit for
 * the big impact drops. Water leaves the heightfield, flies, returns.
 *
 * Emission criteria, adapted to our machinery:
 *  - Wave-crest criterion: whitecap EVENTS (whitecaps.ts already scans for
 *    crests whose Jacobian collapsed) burst on spawn and drizzle over the
 *    crumble window, at rates scaled by wind — Ihmsen's energy criterion;
 *    hard wind tears more water off a breaking crest.
 *  - Impact criterion: buoy splashdowns and rim digs emit directional
 *    cones via emitImpactSpray (called from the Scene's buoy physics).
 *
 * Fixed-step CPU sim, rendered as one InstancedMesh by the Scene. All
 * quantities are honest meters and m/s; sizes are art-scaled CLUMPS of
 * droplets (a real droplet is invisible at 26 px/m).
 */

import { addFoam } from './foam'
import { injectRipple } from './ripples'
import { waves } from './waves'
import { events, MAX_EVENTS, sampleOcean, windVector } from './whitecaps'

export const MAX_SPRAY = 1280

const GRAVITY = 9.8
/**
 * Fraction of the wind a flying clump feels. TEMP: zero — wind is OFF
 * for the loop-splash study; flights are pure gravity arcs. (The tuned
 * value before the study was 0.08.)
 */
const WIND_CARRY = 0.0
/** 1/s relaxation of velocity toward the carried wind (air drag). */
const DRAG = 1.4
/** Hard lifetime cap, seconds (safety net; landing is the real death). */
const LIFE_MAX = 3
/** Art-scaled clump radii, meters. */
const SIZE_MIN = 0.07
const SIZE_MAX = 0.24
/** Burst size when a crest first lets go, scaled by windFactor. */
const BURST_BASE = 20
const BURST_WIND = 36
/** Continuous drizzle per event, particles/sec at full crumble + wind 1. */
const CONTINUOUS_RATE = 104
/** Launch: upward throw, m/s. */
const LAUNCH_UP_MIN = 1.8
const LAUNCH_UP_VAR = 2.4
/**
 * The LOW twin's upward throw: every crest emission also launches a
 * skimming clump that barely clears the surface — most spray torn off a
 * crest hugs it instead of arcing high. This is what doubled density
 * without filling the sky.
 */
const LOW_UP_MIN = 0.5
const LOW_UP_VAR = 0.9
/**
 * Forward leap off a breaking crest, m/s: base + per m/s of wind. The
 * spill travels WITH the wave (waves ride the wind heading), which is
 * what visually ties a clump to the crest that threw it.
 */
const CREST_FORWARD_BASE = 1.4
const CREST_FORWARD = 0.06
/**
 * Instantaneous Jacobian below which water is VISIBLY breaking. Matches
 * the churn's onset (uChurnStart ~ 0.28): spray must come from the same
 * white water the viewer can see seething, or it reads as random.
 */
const CREST_J = 0.3
/** Sampling attempts to find a visibly-breaking point in an event patch. */
const CREST_TRIES = 4
/** Wind speed (m/s) that counts as "full" emission energy. */
const WIND_FULL = 15
/**
 * LOOP SPLASH: the breaking loop itself (the white looping mesh, J < 0)
 * is the emitter. A jittered grid sweeps the sea several times a second;
 * every sample inside a loop launches small, dense particles that hop
 * up and forward along the WAVE HEADING and fall under pure gravity.
 * Emission is proportional to loop LENGTH by construction (each grid
 * cell a loop line crosses is one emission quantum, and the per-pass
 * random offset makes a coarse grid find thin lines over a few passes),
 * with a bonus chance at the LARGER parts of the loop (deeper J).
 */
const LOOP_SCAN_INTERVAL = 0.1
const LOOP_SCAN_STEP = 1.6
const LOOP_SCAN_EXTENT = 40
/** Same J test as the white loop render. */
const LOOP_J = 0.02
/** Bonus-emission depth scale: J this far below LOOP_J = guaranteed extra. */
const LOOP_DEPTH_SPAN = 0.4
/**
 * The hop, RELATIVE to the loop: droplets inherit the loop's advance
 * velocity as their base (pinned to its frame), and these constants are
 * the small extra thrown AHEAD of it. Barely up, slightly forward.
 */
const LOOP_UP_MIN = 0.1
const LOOP_UP_VAR = 0.1
const LOOP_FORWARD_MIN = 1.0
const LOOP_FORWARD_VAR = 1.0
/**
 * Cover clumps SURF: the fold pattern travels at the phase velocity of
 * the dominant wave, so the boil advects at exactly that velocity to
 * stay seated in the culled gap. (The first version damped to a stop
 * and kept its birth height — the crest moved on and left frozen white
 * boulders hanging in the air.)
 */
const domWave = waves.reduce((a, b) => (b.amp > a.amp ? b : a), waves[0])
/** Global fallback heading (dominant wave) for degenerate points. */
const HEAD_X = domWave.dirX
const HEAD_Z = domWave.dirZ

/**
 * The LOOP'S advance velocity at a rest-space point: each wave's phase
 * velocity (omega/k along its heading), weighted by that wave's share
 * of the PINCH. A loop is a Jacobian deficit, and wave i's contribution
 * to it is qAk sin(theta) — k-weighted, so short crossing waves that
 * pinch far beyond their amplitude get their due, and only the
 * compression phase (sin > 0) votes at all. The share is squared for
 * soft winner-take-all: the wave actually folding this spot should own
 * the heading, not split it with the tall band that merely lifted it.
 * (First attempt weighted by orbital drive |qAw sin| — the dominant
 * band's bulk swamped every vote and bent loop headings toward it.)
 */
function loopVelocity(u: number, v: number, t: number) {
  let vx = 0
  let vz = 0
  let wsum = 0
  for (const w of waves) {
    const theta = (u * w.dirX + v * w.dirZ) * w.k - w.omega * t + w.phase
    const pinch = w.q * w.amp * w.k * Math.sin(theta)
    if (pinch <= 0) continue
    const contrib = pinch * pinch
    const c = w.omega / w.k
    vx += w.dirX * c * contrib
    vz += w.dirZ * c * contrib
    wsum += contrib
  }
  if (wsum < 0.001) {
    const c = domWave.omega / domWave.k
    return { x: HEAD_X * c, z: HEAD_Z * c }
  }
  return { x: vx / wsum, z: vz / wsum }
}

/**
 * loopVelocity plus the Gerstner sway at the same rest point, in one
 * wave pass — the per-frame kernel of PINNED flight. A loop particle's
 * rest anchor advects at this velocity, and anchor + sway + its own
 * small relative offset IS the particle's world position: it cannot
 * fall behind the loop no matter how the frame accelerates.
 */
function loopFrame(u: number, v: number, t: number) {
  let vx = 0
  let vz = 0
  let wsum = 0
  let swayX = 0
  let swayZ = 0
  for (const w of waves) {
    const theta = (u * w.dirX + v * w.dirZ) * w.k - w.omega * t + w.phase
    const sway = w.q * w.amp * Math.cos(theta)
    swayX += w.dirX * sway
    swayZ += w.dirZ * sway
    const pinch = w.q * w.amp * w.k * Math.sin(theta)
    if (pinch <= 0) continue
    const contrib = pinch * pinch
    const c = w.omega / w.k
    vx += w.dirX * c * contrib
    vz += w.dirZ * c * contrib
    wsum += contrib
  }
  if (wsum < 0.001) {
    const c = domWave.omega / domWave.k
    return { vx: HEAD_X * c, vz: HEAD_Z * c, swayX, swayZ }
  }
  return { vx: vx / wsum, vz: vz / wsum, swayX, swayZ }
}

export type SprayParticle = {
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  birth: number
  /** Clump radius, meters. 0 = slot free. */
  size: number
  /** True for impact (buoy) spray, which may deposit foam on landing. */
  impact: boolean
  /** True for loop droplets: flight is PINNED to the loop's frame. */
  loop: boolean
  /** Rest-space anchor riding the loop (advected at loopFrame velocity). */
  ax: number
  az: number
  /** Offset from the anchor, integrated from the relative hop below. */
  ox: number
  oz: number
  /** Horizontal hop velocity RELATIVE to the loop frame. */
  rvx: number
  rvz: number
}

export const sprayParticles: SprayParticle[] = Array.from(
  { length: MAX_SPRAY },
  () => ({
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    birth: -10,
    size: 0,
    impact: false,
    loop: false,
    ax: 0,
    az: 0,
    ox: 0,
    oz: 0,
    rvx: 0,
    rvz: 0,
  }),
)

function alloc(): SprayParticle | undefined {
  return sprayParticles.find((p) => p.size === 0)
}

function launch(
  t: number,
  x: number,
  y: number,
  z: number,
  vx: number,
  vy: number,
  vz: number,
  impact: boolean,
) {
  const p = alloc()
  if (!p) return
  p.x = x
  p.y = y
  p.z = z
  p.vx = vx
  p.vy = vy
  p.vz = vz
  p.birth = t
  p.size = SIZE_MIN + Math.random() * (SIZE_MAX - SIZE_MIN)
  p.impact = impact
  p.loop = false
}

/**
 * Loop-splash droplet, PINNED to the loop's frame: (ax, az) is the rest
 * anchor, (ox, oz) the initial scatter around it, (rvx, rvz) the small
 * hop velocity relative to the frame. World position is recomputed each
 * step from the advected anchor; only the vertical is ballistic.
 */
function launchLoop(
  t: number,
  ax: number,
  az: number,
  y: number,
  ox: number,
  oz: number,
  rvx: number,
  vy: number,
  rvz: number,
) {
  const p = alloc()
  if (!p) return
  p.ax = ax
  p.az = az
  p.ox = ox
  p.oz = oz
  p.rvx = rvx
  p.rvz = rvz
  p.x = ax + ox
  p.y = y
  p.z = az + oz
  p.vx = 0
  p.vy = vy
  p.vz = 0
  p.birth = t
  p.size = SIZE_MIN + Math.random() * (SIZE_MAX - SIZE_MIN)
  p.impact = false
  p.loop = true
}

/**
 * Crest emission. An event's patch is meters wide, but the eye only
 * accepts spray coming off water it can SEE breaking — so rejection-
 * sample the patch and launch only from points whose instantaneous
 * Jacobian is collapsed (the exact criterion the churn renders white).
 * The clump leaps forward along the wave's travel, not in a random
 * direction: a spilling crest throws its water ahead of itself.
 */
function emitCrest(t: number, ex: number, ez: number, sigma: number) {
  const wind = windVector(t)
  const windSpeed = Math.hypot(wind.x, wind.z)
  const wx = windSpeed > 0.001 ? wind.x / windSpeed : 1
  const wz = windSpeed > 0.001 ? wind.z / windSpeed : 0
  for (let i = 0; i < CREST_TRIES; i++) {
    const x = ex + (Math.random() * 2 - 1) * sigma * 0.8
    const z = ez + (Math.random() * 2 - 1) * sigma * 0.8
    const s = sampleOcean(x, z, t, 1, 1)
    if (s.jacobian > CREST_J || s.height < 0.05) continue
    const forward = CREST_FORWARD_BASE + windSpeed * CREST_FORWARD
    // A genuinely FOLDED crest (J < 0.05) has its polys culled from the
    // surface — the water there exists only as this spray, so it erupts
    // twice as much of it, thrown harder.
    const pairs = s.jacobian < 0.05 ? 2 : 1
    const boost = s.jacobian < 0.05 ? 1.35 : 1
    for (let k = 0; k < pairs; k++) {
      launch(
        t,
        x + (Math.random() * 2 - 1) * 0.3,
        s.height + 0.15,
        z + (Math.random() * 2 - 1) * 0.3,
        wx * forward + (Math.random() * 2 - 1) * 0.5,
        (LAUNCH_UP_MIN + Math.random() * LAUNCH_UP_VAR) * boost,
        wz * forward + (Math.random() * 2 - 1) * 0.5,
        false,
      )
      // The low twin: same crest, slightly offset, skimming forward just
      // above the surface on a short flat arc.
      launch(
        t,
        x + (Math.random() * 2 - 1) * 0.4,
        s.height + 0.08,
        z + (Math.random() * 2 - 1) * 0.4,
        wx * forward * 1.15 + (Math.random() * 2 - 1) * 0.5,
        LOW_UP_MIN + Math.random() * LOW_UP_VAR,
        wz * forward * 1.15 + (Math.random() * 2 - 1) * 0.5,
        false,
      )
    }
    return
  }
}

/**
 * Impact emission (O'Brien & Hodgins): a cone of clumps thrown from a
 * strike at (x, z). dir biases the cone (a rim digging in throws to one
 * side; pass 0,0 for a symmetric splashdown crown); energy 0..1 scales
 * count and speed.
 */
export function emitImpactSpray(
  t: number,
  x: number,
  z: number,
  dirX: number,
  dirZ: number,
  energy: number,
) {
  const count = Math.round(12 + energy * 36)
  const s = sampleOcean(x, z, t, 1, 1)
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2
    const r = (0.6 + Math.random() * 1.4) * (0.5 + energy)
    launch(
      t,
      x,
      s.height + 0.1,
      z,
      Math.cos(a) * r + dirX * 1.6 * energy,
      (1.2 + Math.random() * 1.6) * (0.6 + energy),
      Math.sin(a) * r + dirZ * 1.6 * energy,
      true,
    )
  }
}

/**
 * TEMP debug: every qualifying loop point's heading, refreshed per scan
 * pass. The Scene renders these as pink arrows so emission targeting
 * can be judged loop by loop.
 */
export type LoopHeading = {
  x: number
  y: number
  z: number
  hx: number
  hz: number
  speed: number
  /** true = neighbors line up ALONG the heading (chain) — bad spray site */
  chain: boolean
  /** Rest anchor + droplet count, carried so emission can run AFTER
   * classification (only pink points splash). */
  ax: number
  az: number
  count: number
}
export const loopHeadings: LoopHeading[] = []

let coverScanClock = 0

function scanLoopSplash(t: number) {
  loopHeadings.length = 0
  const jx = Math.random() * LOOP_SCAN_STEP
  const jz = Math.random() * LOOP_SCAN_STEP
  for (let x = -LOOP_SCAN_EXTENT + jx; x <= LOOP_SCAN_EXTENT; x += LOOP_SCAN_STEP) {
    for (let z = -LOOP_SCAN_EXTENT + jz; z <= LOOP_SCAN_EXTENT; z += LOOP_SCAN_STEP) {
      const s = sampleOcean(x, z, t, 1, 1)
      if (s.jacobian > LOOP_J) continue
      // One droplet per loop-length quantum, plus a bonus at the LARGER
      // parts of the loop (deeper inversion).
      const depth = Math.min((LOOP_J - s.jacobian) / LOOP_DEPTH_SPAN, 1)
      const count = 4 + (Math.random() < depth ? 4 : 0)
      // Rest coords for the evaluation: the sample's sway is the
      // inversion we already paid for.
      const lv = loopVelocity(x - s.swayX, z - s.swayZ, t)
      const lvLen = Math.hypot(lv.x, lv.z)
      const hx = lvLen > 0.01 ? lv.x / lvLen : HEAD_X
      const hz = lvLen > 0.01 ? lv.z / lvLen : HEAD_Z
      if (loopHeadings.length < 160) {
        loopHeadings.push({
          x,
          y: s.height,
          z,
          hx,
          hz,
          speed: lvLen,
          chain: false,
          ax: x - s.swayX,
          az: z - s.swayZ,
          count,
        })
      }
    }
  }
  // Classify each point by how its NEIGHBORS sit relative to its own
  // heading. A real crest line reads as points BESIDE each other
  // (offset perpendicular to heading) — good spray. A ribbon running
  // ALONG its own travel direction reads as points ahead/behind each
  // other — looks wrong whitened, worse sprayed. Majority vote inside
  // a 4 m disc; the 0.45-0.7 |cos| deadband keeps diagonals from
  // voting both ways.
  for (let i = 0; i < loopHeadings.length; i++) {
    const a = loopHeadings[i]
    let along = 0
    let beside = 0
    for (let j = 0; j < loopHeadings.length; j++) {
      if (j === i) continue
      const b = loopHeadings[j]
      const dx = b.x - a.x
      const dz = b.z - a.z
      const d2 = dx * dx + dz * dz
      if (d2 > 16 || d2 < 0.01) continue
      const cosT = Math.abs((dx * a.hx + dz * a.hz) / Math.sqrt(d2))
      if (cosT > 0.8) along++
      else if (cosT < 0.6) beside++
    }
    // Lean pink for real lines: only a clear fore/aft pattern (2+
    // votes, outnumbering the beside votes) condemns a group point as
    // a chain. ISOLATED points (no neighbors in the disc at all) also
    // go green — a lone grid hit is noise, not a crest line.
    a.chain = (along >= 2 && along > beside) || along + beside === 0
  }
  // Emission — from PINK points only. These are the primary crashing
  // particles: pinned to the loop's frame, thrown slightly ahead of it.
  for (const a of loopHeadings) {
    if (a.chain) continue
    for (let k = 0; k < a.count; k++) {
      const forward = LOOP_FORWARD_MIN + Math.random() * LOOP_FORWARD_VAR
      launchLoop(
        t,
        a.ax,
        a.az,
        a.y + 0.1,
        (Math.random() * 2 - 1) * 0.6,
        (Math.random() * 2 - 1) * 0.6,
        a.hx * forward + (Math.random() * 2 - 1) * 0.1,
        LOOP_UP_MIN + Math.random() * LOOP_UP_VAR,
        a.hz * forward + (Math.random() * 2 - 1) * 0.1,
      )
    }
  }
}

// Landing checks alternate between particle halves each step (the
// sampleOcean per particle is the module's dominant CPU cost, and a
// clump moves ~5cm between checks — the extra latency is invisible).
let checkParity = 0

// One entry per event slot: which birth we've already burst for.
const burstFor = new Float64Array(MAX_EVENTS).fill(-1)

// NOTE: crest-foam painting moved INTO the foam field's sim shader
// (foam.ts, PINCH_RATE): event-based CPU painting structurally missed
// most visible pinches — the scan grid skipped narrow pinch lines, the
// event threshold (J < 0.08) is far stricter than visible churn (0.28),
// slots cap at 8, and events sit still while crests move. The field
// evaluates pinch per texel, so every visible pinch grows foam.

/** Fixed-step update: emission from live breaks, then ballistics. */
export function updateSpray(dt: number, t: number) {
  const wind = windVector(t)
  const windSpeed = Math.hypot(wind.x, wind.z)
  const windFactor = Math.min(windSpeed / WIND_FULL, 2)

  for (let i = 0; i < MAX_EVENTS; i++) {
    const e = events[i]
    if (e.sigma === 0) continue
    const age = t - e.birth
    if (age < 0 || age > e.breakDuration) continue
    if (burstFor[i] !== e.birth) {
      burstFor[i] = e.birth
      const n = Math.round(BURST_BASE + BURST_WIND * windFactor)
      for (let k = 0; k < n; k++) emitCrest(t, e.x, e.z, e.sigma)
    }
    // Drizzle while the crest crumbles, peaking mid-break. Emit the true
    // expected count (integer part + Bernoulli remainder): a single
    // yes/no per step silently caps the rate at one per step once
    // rate * dt exceeds 1.
    const phase = Math.sin(Math.PI * (age / e.breakDuration))
    const drizzle = CONTINUOUS_RATE * phase * windFactor * dt
    let n = Math.floor(drizzle)
    if (Math.random() < drizzle - n) n++
    for (let k = 0; k < n; k++) emitCrest(t, e.x, e.z, e.sigma)
  }

  coverScanClock += dt
  if (coverScanClock >= LOOP_SCAN_INTERVAL) {
    coverScanClock = 0
    scanLoopSplash(t)
  }

  checkParity ^= 1
  for (let i = 0; i < sprayParticles.length; i++) {
    const p = sprayParticles[i]
    if (p.size === 0) continue
    if (t - p.birth > LIFE_MAX) {
      p.size = 0
      continue
    }
    if (p.loop) {
      // PINNED flight: the rest anchor advects at the loop frame's
      // velocity, the droplet's own hop integrates on top, and world
      // position is rebuilt from anchor + sway + offset. Horizontal
      // motion can never lag the loop; gravity owns the vertical.
      const fr = loopFrame(p.ax, p.az, t)
      p.ax += fr.vx * dt
      p.az += fr.vz * dt
      p.ox += p.rvx * dt
      p.oz += p.rvz * dt
      p.vy -= GRAVITY * dt
      p.y += p.vy * dt
      p.x = p.ax + fr.swayX + p.ox
      p.z = p.az + fr.swayZ + p.oz
    } else {
      // Drag toward the carried wind; gravity owns the vertical. With
      // the wind study OFF (WIND_CARRY 0) drag would relax droplets
      // toward a world-still frame and bleed launch velocity — skip it.
      if (WIND_CARRY > 0) {
        const k = Math.min(DRAG * dt, 1)
        p.vx += (wind.x * WIND_CARRY - p.vx) * k
        p.vz += (wind.z * WIND_CARRY - p.vz) * k
      }
      p.vy -= GRAVITY * dt
      p.x += p.vx * dt
      p.y += p.vy * dt
      p.z += p.vz * dt
    }
    // A submerged clump is dead REGARDLESS of rise or fall: a trough
    // emission can sit below the NEIGHBORING wave face for its entire
    // arc, invisible behind the opaque water. Only clumps that had a
    // real airborne life hand anything back — foam appearing where no
    // droplet was ever visible reads as haunted.
    if ((i & 1) !== checkParity) continue
    const s = sampleOcean(p.x, p.z, t, 1, 1)
    if (p.y < s.height - 0.02) {
      // Gate sized so trough-buried ghosts (dead in < 0.05s) still hand
      // nothing back, while the low skimmers' short real flights do.
      if (t - p.birth > 0.12) {
        // Landing: hand the water back (O'Brien & Hodgins). The clump
        // rings the surface and leaves a slow-dying dot of foam residue,
        // anchored in REST coordinates — the material water point under
        // the landing — so it rides the Gerstner sway with the surface.
        injectRipple(p.x, p.z, 0.1 + p.size, 0.02 + p.size * 0.18)
        if (!p.impact) {
          // Foam's ONLY source now — the field is emergent from landings.
        // Sigma floor: the field's texel is ~0.2m, and a sub-texel dot
        // dies to one diffusion pass no matter how slow the clocks are.
        // (0.2 base read as too much total foam; ~1 texel is the sweet
        // spot between resolvable and restrained.)
        addFoam(p.x - s.swayX, p.z - s.swayZ, 0.13 + p.size * 0.5)
        } else if (Math.random() < 0.4) {
          // Buoy (impact) spray leaves far less residue than a breaking
          // crest: a bobbing float was painting a solid disc around
          // itself.
          addFoam(p.x - s.swayX, p.z - s.swayZ, 0.04 + p.size * 0.3, 0.3)
        }
      }
      p.size = 0
    }
  }
}
