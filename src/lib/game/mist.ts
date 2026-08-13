/**
 * Mist: the AIR-DOMINATED class of white water, rendered as a wind-blown
 * point cloud.
 *
 * Ihmsen et al. 2012 classify diffuse material by which force dominates:
 * spray flies ballistically (water inertia), foam sits on the surface,
 * bubbles rise. Mist is the limit their spray class approaches as
 * droplets atomize: mass shrinks until AIR DRAG dominates gravity, and
 * the droplet becomes a passive tracer of the air with a small terminal
 * settling velocity. Disney's Moana pipeline (Frost & Stomakhin,
 * SIGGRAPH 2017) makes the same three-way split — foam / spray / mist as
 * separate passes, mist being the smallest droplets advected by the wind
 * field and settling slowly, rendered soft and translucent.
 *
 * So the sim here is deliberately trivial: strong Stokes relaxation
 * toward the local air velocity (wind + a gentle large-scale swirl so
 * the cloud billows instead of translating rigidly), a fixed terminal
 * settling speed, and a fade clock. No ocean sampling at all — mist that
 * drifts into a wave face is occluded by the opaque water, the same
 * guarantee the spray droplets lean on.
 *
 * Spawning: torn off at loop-splash sites (spume) and puffed out where
 * droplets crash (impact atomization) — both called from spray.ts, both
 * a FRACTION of events so mist stays a garnish, not a fog bank.
 */

import { windVector } from './whitecaps'

// Sized for the tripled spawn rate (~4k concurrent in storm): the ring
// recycler must not eat puffs mid-life.
export const MAX_MIST = 6144

/**
 * HEAVY mist: the purpose is to show the choppiness of the water, so
 * the plume must stay tied to its wave. Life is short, gravity is real
 * (drag-limited below true G but decisively downward), and the wind
 * only gets a grip LATE in life — and only a fraction of it — so the
 * cloud leaps, balloons, leans downwind, and falls back where it rose
 * instead of raining across the screen.
 */
/** Downward pull, m/s^2 (drag-limited heavy-droplet fall, not full G). */
const G_MIST = 3.2
/** 1/s: wind relaxation at END of life; ramps in as frac^2, so fresh
 * plumes are ballistic and only the dispersed haze gets swept. */
const WIND_GRIP = 2.5
/** Fraction of the wind the dispersed haze can reach. */
const WIND_CARRY = 0.35
/** Lifetime, s: up, balloon, fall back — all near the wave. */
const LIFE_MIN = 0.8
const LIFE_VAR = 0.8
/** Dispersal: random outward velocity given at spawn, m/s — the cloud
 * expansion is particles flying apart, size growth is in the shader.
 * Kept tight: the plume should read as a focused burst AT the pinch,
 * not a veil over the whole wave. */
const DISPERSE = 0.18

export type MistParticle = {
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  birth: number
  /** Total lifetime, seconds. 0 = slot free. */
  life: number
  seed: number
}

export const mistParticles: MistParticle[] = Array.from(
  { length: MAX_MIST },
  () => ({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, birth: -10, life: 0, seed: 0 }),
)

// Ring allocation: mist is plentiful and short-lived, so when the pool
// wraps, the OLDEST puff is silently recycled — new mist always wins.
let cursor = 0

export function spawnMist(
  t: number,
  x: number,
  y: number,
  z: number,
  vx: number,
  vy: number,
  vz: number,
) {
  const p = mistParticles[cursor]
  cursor = (cursor + 1) % MAX_MIST
  p.x = x
  p.y = y
  p.z = z
  p.vx = vx + (Math.random() * 2 - 1) * DISPERSE
  p.vy = vy + Math.random() * 0.15
  p.vz = vz + (Math.random() * 2 - 1) * DISPERSE
  p.birth = t
  p.life = LIFE_MIN + Math.random() * LIFE_VAR
  p.seed = Math.random() * 100
}

export function updateMist(dt: number, t: number) {
  const wind = windVector(t)
  for (const p of mistParticles) {
    if (p.life === 0) continue
    const age = t - p.birth
    if (age > p.life || p.y < -3) {
      p.life = 0
      continue
    }
    // Wind grip grows as frac^2: the fresh plume is ballistic water,
    // the dispersed end-of-life haze is fine enough to be swept.
    const frac = age / p.life
    const grip = Math.min(WIND_GRIP * frac * frac * dt, 1)
    p.vx += (wind.x * WIND_CARRY - p.vx) * grip
    p.vz += (wind.z * WIND_CARRY - p.vz) * grip
    p.vy -= G_MIST * dt
    p.x += p.vx * dt
    p.y += p.vy * dt
    p.z += p.vz * dt
  }
}

/** 0..1 render fade: quick bloom in, thinning as the cloud balloons. */
export function mistFade(p: MistParticle, t: number) {
  const age = t - p.birth
  const frac = age / p.life
  const grow = Math.min(age / 0.1, 1)
  const die = 1 - Math.max((frac - 0.35) / 0.65, 0)
  return grow * die
}

/** 0..1 age fraction, for shader-side size growth. */
export function mistAge(p: MistParticle, t: number) {
  return Math.min((t - p.birth) / p.life, 1)
}
