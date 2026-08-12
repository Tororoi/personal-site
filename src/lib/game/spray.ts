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
import { events, MAX_EVENTS, sampleOcean, windVector } from './whitecaps'

export const MAX_SPRAY = 512

const GRAVITY = 9.8
/**
 * Fraction of the wind a flying clump feels. Nearly zero: clumps are
 * heavy water and their flight is a GRAVITY arc; the wind gets a nudge,
 * not a ride. (0.7 sailed half the screen; 0.25 still read as wind-blown
 * rather than thrown-and-falling.)
 */
const WIND_CARRY = 0.08
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
    launch(
      t,
      x,
      s.height + 0.15,
      z,
      wx * forward + (Math.random() * 2 - 1) * 0.5,
      LAUNCH_UP_MIN + Math.random() * LAUNCH_UP_VAR,
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

  checkParity ^= 1
  for (let i = 0; i < sprayParticles.length; i++) {
    const p = sprayParticles[i]
    if (p.size === 0) continue
    if (t - p.birth > LIFE_MAX) {
      p.size = 0
      continue
    }
    // Drag toward the carried wind; gravity owns the vertical.
    const k = Math.min(DRAG * dt, 1)
    p.vx += (wind.x * WIND_CARRY - p.vx) * k
    p.vz += (wind.z * WIND_CARRY - p.vz) * k
    p.vy -= GRAVITY * dt
    p.x += p.vx * dt
    p.y += p.vy * dt
    p.z += p.vz * dt
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
          addFoam(p.x - s.swayX, p.z - s.swayZ, 0.05 + p.size * 0.4)
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
