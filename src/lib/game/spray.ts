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
 * quantities are honest meters and m/s; sizes are art-scaled PARCELS of
 * droplets (a real droplet is invisible at 26 px/m).
 */

import { addFoam } from './foam'
import { queueMistSplat } from './mistfield'
import { DROPLET, ENABLE, FROTH, MIST, PROFILE } from './tuning'
import { injectRipple } from './ripples'
import { waves, maxSurfaceRate, SIN_TABLE, COS_TABLE, TRIG_SCALE, TRIG_MASK } from './waves'
import { events, MAX_EVENTS, oceanHeight, sampleOcean, windVector } from './whitecaps'

export const MAX_SPRAY = DROPLET.maxCount

const GRAVITY = DROPLET.gravity
/**
 * Fraction of the wind a flying droplet feels. TEMP: zero — wind is OFF
 * for the loop-splash study; flights are pure gravity arcs. (The tuned
 * value before the study was 0.08.)
 */
const WIND_CARRY = DROPLET.windCarry
/** 1/s relaxation of velocity toward the carried wind (air drag). */
const DRAG = DROPLET.drag
/** Hard lifetime cap, seconds (safety net; landing is the real death). */
const LIFE_MAX = DROPLET.lifeMax
/** Art-scaled droplet radii, meters. */
const SIZE_MIN = DROPLET.sizeMin
const SIZE_MAX = DROPLET.sizeMax
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
 * skimming droplet that barely clears the surface — most spray torn off a
 * crest hugs it instead of arcing high. This is what doubled density
 * without filling the sky.
 */
const LOW_UP_MIN = 0.5
const LOW_UP_VAR = 0.9
/**
 * Forward leap off a breaking crest, m/s: base + per m/s of wind. The
 * spill travels WITH the wave (waves ride the wind heading), which is
 * what visually ties a droplet to the crest that threw it.
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
const LOOP_SCAN_INTERVAL = DROPLET.scanInterval
const LOOP_SCAN_STEP = DROPLET.scanStep
/**
 * Half-extent of the emission scan, metres. Set from the Scene to match
 * the FROTH field's own window-derived extent: a fixed 40 m left froth
 * in the outer corners of a wide window unscanned, so it never threw
 * droplets. Falls back to the tuning value before the Scene reports in.
 */
let LOOP_SCAN_EXTENT: number = DROPLET.scanExtent

export function setScanExtent(halfMetres: number) {
  LOOP_SCAN_EXTENT = Math.max(halfMetres, DROPLET.scanExtent)
}

/**
 * The VISIBLE quad on the water plane, as four world-XZ corners in
 * order. The scan grid is world-axis aligned, but the camera is
 * isometric, so what the player sees is a rotated rectangle — the
 * square that contains it wastes nearly half its samples on ground that
 * is off screen. Points outside this quad are skipped before the
 * expensive ocean sample.
 */
let viewQuad: number[] | null = null

export function setViewQuad(corners: number[] | null) {
  viewQuad = corners && corners.length === 8 ? corners : null
}


/**
 * PERSISTENT LOOP TRACKS.
 *
 * The scan finds pinch points, but each cycle is anonymous: the grid is
 * re-jittered, points are unordered, and nothing connects one cycle to
 * the next. Tracks add the missing identity.
 *
 * Two steps. First CONNECTIVITY: union-find over the scan points groups
 * them into whole loops (a loop is a connected run of pinch points, so
 * its extent, length and mean motion are properties of the group, not
 * of any one sample). Then MATCHING: each group is paired with a track
 * from the previous cycle by rest-space proximity, so a loop keeps its
 * identity, accumulates age, and carries smoothed heading and speed
 * instead of the per-sample values that jitter with the grid.
 *
 * (Tracking the mesh's own triangles would give identity for free —
 * a tri IS a fixed parcel of water — but the water mesh runs to ~520k
 * triangles, far beyond a per-frame CPU pass, and a tri is only inside
 * a loop for a moment anyway: the loop travels through the mesh, so
 * membership churns and the loop still needs matching to persist.)
 */
export type LoopTrack = {
  id: number
  /** Rest-space centroid, advected by the loop frame between scans. */
  ax: number
  az: number
  /** World-space centroid — where the loop actually is, used for
   * grouping and for matching to the next cycle. */
  wx: number
  wz: number
  /** Smoothed heading and advance speed. */
  hx: number
  hz: number
  speed: number
  /** Member count and its span in metres along the crest. */
  points: number
  length: number
  /** Strongest froth factor anywhere on the loop. */
  peak: number
  /** Seconds since first seen, and when it was last matched. */
  age: number
  lastSeen: number
}

export const loopTracks: LoopTrack[] = []
let nextTrackId = 1

/** How far apart two scan points can be and still be the same loop. */
const LINK_DIST = 2.6
/** How far a track's centroid may move between cycles and still match. */
const TRACK_MATCH = 6

function buildLoopTracks(t: number) {
  const n = loopHeadings.length
  if (n === 0) return
  // --- connectivity: union-find over neighbouring scan points ---
  const parent = new Int32Array(n)
  for (let i = 0; i < n; i++) parent[i] = i
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]]
      i = parent[i]
    }
    return i
  }
  const union = (a: number, b: number) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[rb] = ra
  }
  // Link in WORLD space, not rest: a loop is contiguous where you can
  // see it. In rest space the Gerstner sway pulls neighbouring samples
  // metres apart precisely at a pinch (that displacement IS the pinch),
  // so rest-space linking left almost every loop as isolated points.
  const CELL = LINK_DIST
  const cells = new Map<number, number[]>()
  const key = (x: number, z: number) =>
    (Math.floor(x / CELL) + 4096) * 8192 + (Math.floor(z / CELL) + 4096)
  for (let i = 0; i < n; i++) {
    const k = key(loopHeadings[i].x, loopHeadings[i].z)
    const list = cells.get(k)
    if (list) list.push(i)
    else cells.set(k, [i])
  }
  const linkSq = LINK_DIST * LINK_DIST
  for (let i = 0; i < n; i++) {
    const a = loopHeadings[i]
    const cx = Math.floor(a.x / CELL)
    const cz = Math.floor(a.z / CELL)
    for (let ox = -1; ox <= 1; ox++) {
      for (let oz = -1; oz <= 1; oz++) {
        const list = cells.get((cx + ox + 4096) * 8192 + (cz + oz + 4096))
        if (!list) continue
        for (const j of list) {
          if (j <= i) continue
          const b = loopHeadings[j]
          const dx = b.x - a.x
          const dz = b.z - a.z
          if (dx * dx + dz * dz <= linkSq) union(i, j)
        }
      }
    }
  }
  // --- group summaries ---
  type Group = {
    ax: number
    az: number
    wx: number
    wz: number
    hx: number
    hz: number
    speed: number
    points: number
    peak: number
    minU: number
    maxU: number
  }
  const groups = new Map<number, Group>()
  for (let i = 0; i < n; i++) {
    const a = loopHeadings[i]
    const r = find(i)
    let g = groups.get(r)
    if (!g) {
      g = {
        ax: 0,
        az: 0,
        wx: 0,
        wz: 0,
        hx: 0,
        hz: 0,
        speed: 0,
        points: 0,
        peak: 0,
        minU: Infinity,
        maxU: -Infinity,
      }
      groups.set(r, g)
    }
    g.ax += a.ax
    g.az += a.az
    g.wx += a.x
    g.wz += a.z
    g.hx += a.hx
    g.hz += a.hz
    g.speed += a.speed
    g.points++
    g.peak = Math.max(g.peak, a.depth)
    // Extent ALONG the crest line (perpendicular to the heading).
    const u = a.x * -a.hz + a.z * a.hx
    if (u < g.minU) g.minU = u
    if (u > g.maxU) g.maxU = u
    a.track = r
  }
  // --- match to existing tracks, or spawn ---
  const matched = new Set<LoopTrack>()
  const idOf = new Map<number, number>()
  for (const [root, g] of groups) {
    const cx = g.ax / g.points
    const cz = g.az / g.points
    const wx = g.wx / g.points
    const wz = g.wz / g.points
    const hLen = Math.hypot(g.hx, g.hz) || 1
    const hx = g.hx / hLen
    const hz = g.hz / hLen
    const speed = g.speed / g.points
    const length = g.maxU - g.minU
    let best: LoopTrack | null = null
    let bestD = TRACK_MATCH * TRACK_MATCH
    for (const tr of loopTracks) {
      if (matched.has(tr)) continue
      const dx = tr.wx - wx
      const dz = tr.wz - wz
      const d2 = dx * dx + dz * dz
      if (d2 < bestD) {
        bestD = d2
        best = tr
      }
    }
    if (best) {
      matched.add(best)
      // Smooth: the grid jitters, the loop does not.
      best.ax += (cx - best.ax) * 0.5
      best.az += (cz - best.az) * 0.5
      best.wx += (wx - best.wx) * 0.5
      best.wz += (wz - best.wz) * 0.5
      best.hx += (hx - best.hx) * 0.35
      best.hz += (hz - best.hz) * 0.35
      best.speed += (speed - best.speed) * 0.35
      best.points = g.points
      best.length = length
      best.peak = g.peak
      best.lastSeen = t
      idOf.set(root, best.id)
    } else {
      const tr: LoopTrack = {
        id: nextTrackId++,
        ax: cx,
        az: cz,
        wx,
        wz,
        hx,
        hz,
        speed,
        points: g.points,
        length,
        peak: g.peak,
        age: 0,
        lastSeen: t,
      }
      loopTracks.push(tr)
      matched.add(tr)
      idOf.set(root, tr.id)
    }
  }
  // Publish stable ids onto the points, and retire stale tracks.
  for (const a of loopHeadings) {
    const id = idOf.get(a.track)
    a.track = id === undefined ? -1 : id
  }
  for (let i = loopTracks.length - 1; i >= 0; i--) {
    if (t - loopTracks[i].lastSeen > 0.4) loopTracks.splice(i, 1)
  }
  trackIndex.clear()
  for (const tr of loopTracks) trackIndex.set(tr.id, tr)
}

/** Per-frame: tracks ride their loop between scans and accumulate age. */
function updateLoopTracks(dt: number, t: number) {
  for (const tr of loopTracks) {
    tr.age += dt
    const fr = loopFrame(tr.ax, tr.az, t)
    tr.ax += fr.vx * dt
    tr.az += fr.vz * dt
    tr.wx = tr.ax + fr.swayX
    tr.wz = tr.az + fr.swayZ
  }
}


/** Id -> track, rebuilt each cycle: emission looks one up per point,
 * and a linear search over a few hundred tracks is needless work. */
const trackIndex = new Map<number, LoopTrack>()

/** Per-scan census, so it is possible to tell WHY froth is not
 * throwing: how many grid points were sampled, how many were steep
 * enough to record, and how many actually cleared every emission gate. */
export const scanCensus = {
  sampled: 0,
  skipped: 0,
  recorded: 0,
  emitted: 0,
  blockedFroth: 0,
  blockedExpose: 0,
  blockedPeak: 0,
}
/** Live tallies for the cycle in progress; published to scanCensus when
 * the cycle completes, so a reader never catches it mid-count. */
const censusLive = { ...scanCensus }

/** Convex point-in-quad by consistent edge sign. */
function inView(x: number, z: number) {
  if (!viewQuad) return true
  let sign = 0
  for (let i = 0; i < 4; i++) {
    const ax = viewQuad[i * 2]
    const az = viewQuad[i * 2 + 1]
    const bx = viewQuad[((i + 1) % 4) * 2]
    const bz = viewQuad[((i + 1) % 4) * 2 + 1]
    const cross = (bx - ax) * (z - az) - (bz - az) * (x - ax)
    if (cross > 0.0001) {
      if (sign < 0) return false
      sign = 1
    } else if (cross < -0.0001) {
      if (sign > 0) return false
      sign = -1
    }
  }
  return true
}
/** Same J test as the white loop render. */
const LOOP_J = DROPLET.scanJ
/** Bonus-emission depth scale: J this far below LOOP_J = guaranteed extra. */
const LOOP_DEPTH_SPAN = DROPLET.depthSpan
/**
 * The hop, RELATIVE to the loop: droplets inherit the loop's advance
 * velocity as their base (pinned to its frame), and these constants are
 * the small extra thrown AHEAD of it. Barely up, slightly forward.
 */
const LOOP_UP_MIN = DROPLET.hopUpMin
const LOOP_UP_VAR = DROPLET.hopUpVar
const LOOP_FORWARD_MIN = DROPLET.hopFwdMin
const LOOP_FORWARD_VAR = DROPLET.hopFwdVar
/**
 * Cover droplets SURF: the fold pattern travels at the phase velocity of
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
 * Vertical velocity of the surface at a rest point: d/dt of the Gerstner
 * height sum. A breaking crest RISES at ~amp*omega (1.5-2 m/s in storm)
 * — far faster than the droplets' 0.3-0.6 m/s hop, and the horizontal
 * pinning means they can't escape sideways. Without inheriting this,
 * the wave climbs over its own spray and culls it within a frame or two
 * (measured: ~780 insta-culls/s vs ~100 alive) — the droplet flicker.
 */
function surfaceRise(u: number, v: number, t: number) {
  let rise = 0
  for (const w of waves) {
    const theta = (u * w.dirX + v * w.dirZ) * w.k - w.omega * t + w.phase
    rise -= w.amp * w.omega * Math.cos(theta)
  }
  return rise
}

/**
 * The water's ORBITAL velocity at a rest point — the direction the
 * froth is being carried as it wheels around the fold. On the face of
 * an overturning crest this points forward and over, which is exactly
 * the way a mass of froth throws its water. (Time derivative of the
 * Gerstner displacement: horizontal qAw sin, vertical -Aw cos.)
 */
function orbital(u: number, v: number, t: number) {
  let x = 0
  let y = 0
  let z = 0
  for (const w of waves) {
    const theta = (u * w.dirX + v * w.dirZ) * w.k - w.omega * t + w.phase
    const s = Math.sin(theta)
    const f = w.q * w.amp * w.omega * s
    x += w.dirX * f
    z += w.dirZ * f
    y -= w.amp * w.omega * Math.cos(theta)
  }
  return { x, y, z }
}

/**
 * loopVelocity plus the Gerstner sway at the same rest point, in one
 * wave pass — the per-frame kernel of PINNED flight. A loop particle's
 * rest anchor advects at this velocity, and anchor + sway + its own
 * small relative offset IS the particle's world position: it cannot
 * fall behind the loop no matter how the frame accelerates.
 */
/**
 * Result of loopFrame, reused. loopFrame is called once per loop droplet
 * per step — thousands of times a frame — and returning a fresh object
 * from it was allocating at exactly the rate that produced multi-second
 * GC pauses in the landing check. Every call site consumes the fields
 * immediately; do not hold one across a second call.
 */
const frameScratch = { vx: 0, vz: 0, swayX: 0, swayZ: 0, h: 0 }

function loopFrame(u: number, v: number, t: number) {
  let vx = 0
  let vz = 0
  let wsum = 0
  let swayX = 0
  let swayZ = 0
  let h = 0
  for (const w of waves) {
    const theta = (u * w.dirX + v * w.dirZ) * w.k - w.omega * t + w.phase
    // Table lookup (see waves.ts), and ONE sin per wave: the height and
    // the pinch term are the same angle, and this used to call Math.sin
    // twice for it on top of a Math.cos.
    const f = theta * TRIG_SCALE
    const i0 = Math.floor(f)
    const fr = f - i0
    const ia = i0 & TRIG_MASK
    const ib = (i0 + 1) & TRIG_MASK
    const sn = SIN_TABLE[ia] + (SIN_TABLE[ib] - SIN_TABLE[ia]) * fr
    const cs = COS_TABLE[ia] + (COS_TABLE[ib] - COS_TABLE[ia]) * fr
    const sway = w.q * w.amp * cs
    swayX += w.dirX * sway
    swayZ += w.dirZ * sway
    h += w.amp * sn
    const pinch = w.q * w.amp * w.k * sn
    if (pinch <= 0) continue
    const contrib = pinch * pinch
    const c = w.omega / w.k
    vx += w.dirX * c * contrib
    vz += w.dirZ * c * contrib
    wsum += contrib
  }
  frameScratch.swayX = swayX
  frameScratch.swayZ = swayZ
  frameScratch.h = h
  if (wsum < 0.001) {
    const c = domWave.omega / domWave.k
    frameScratch.vx = HEAD_X * c
    frameScratch.vz = HEAD_Z * c
  } else {
    frameScratch.vx = vx / wsum
    frameScratch.vz = vz / wsum
  }
  return frameScratch
}

export type SprayParticle = {
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  birth: number
  /** Droplet radius, meters. 0 = slot free. */
  size: number
  /** True for impact (buoy) spray, which may deposit foam on landing. */
  impact: boolean
  /** True for loop droplets: flight is PINNED to the loop's frame. */
  loop: boolean
  /** Height above the local surface the droplet launches from — the
   * froth mass's crown plus clearance. Held so a staggered droplet can
   * keep riding that crown until it is thrown. */
  crown: number
  /** Time the landing was detected; -1 airborne. The droplet shrinks out
   * over a beat instead of blinking off the frame it touches water. */
  dying: number
  /** Rest-space anchor riding the loop (advected at loopFrame velocity). */
  ax: number
  az: number
  /** Offset from the anchor, integrated from the relative hop below. */
  ox: number
  oz: number
  /** Horizontal hop velocity RELATIVE to the loop frame. */
  rvx: number
  rvz: number
  /**
   * Where and when this droplet last sampled the surface, and what it
   * found. Lets the next check be skipped while the droplet is still
   * provably clear of the water — see DROPLET.checkSlopeBound.
   */
  chH: number
  chT: number
  chX: number
  chZ: number
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
    chH: Infinity,
    chT: -1e9,
    chX: 0,
    chZ: 0,
    impact: false,
    loop: false,
    crown: 0,
    dying: -1,
    ax: 0,
    az: 0,
    ox: 0,
    oz: 0,
    rvx: 0,
    rvz: 0,
  }),
)

let allocFails = 0
let culledYoung = 0

function alloc(): SprayParticle | undefined {
  const p = sprayParticles.find((p) => p.size === 0)
  if (!p) allocFails++
  return p
}

// Debug: flicker forensics — pool pressure vs spawn-buried insta-culls.
if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).sprayStats = () => ({
    active: sprayParticles.filter((p) => p.size > 0).length,
    allocFails,
    culledYoung,
    ...scanCensus,
    tracks: loopTracks.length,
  })
  // Debug: the live loop tracks — id, age, length, speed.
  ;(window as unknown as Record<string, unknown>).loopTracks = () =>
    loopTracks.map((tr) => ({
      id: tr.id,
      age: +tr.age.toFixed(2),
      points: tr.points,
      length: +tr.length.toFixed(1),
      speed: +tr.speed.toFixed(2),
    }))
  // Debug: the exact quad the scan is culled to, in world XZ.
  ;(window as unknown as Record<string, unknown>).scanQuad = () => ({
    quad: viewQuad ? [...viewQuad] : null,
    extent: LOOP_SCAN_EXTENT,
  })
}

/**
 * @param sizeK 0-1 ceiling on droplet size: 0 pins every droplet to
 *   sizeMin, 1 opens the full sizeMin..sizeMax range. A gentle impact
 *   throws fine spray, not a scattering of fat parcels.
 */
function launch(
  t: number,
  x: number,
  y: number,
  z: number,
  vx: number,
  vy: number,
  vz: number,
  impact: boolean,
  sizeK = 1,
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
  p.size = SIZE_MIN + Math.random() * (SIZE_MIN + (SIZE_MAX - SIZE_MIN) * sizeK - SIZE_MIN)
  p.impact = impact
  p.loop = false
  p.crown = 0
  p.dying = -1
  p.chH = Infinity
  p.chT = -1e9
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
  size: number,
  crown: number,
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
  // Birth STAGGER: the scan fires every 0.1s, and a whole pass born on
  // one frame reads as strobing volleys. A random activation delay
  // spreads the same droplets across the interval — continuous spray.
  p.birth = t + Math.random() * DROPLET.birthStagger
  p.size = size
  p.impact = false
  p.loop = true
  p.crown = crown
  p.dying = -1
  p.chH = Infinity
  p.chT = -1e9
}

/**
 * Crest emission. An event's patch is meters wide, but the eye only
 * accepts spray coming off water it can SEE breaking — so rejection-
 * sample the patch and launch only from points whose instantaneous
 * Jacobian is collapsed (the exact criterion the churn renders white).
 * The droplet leaps forward along the wave's travel, not in a random
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
 * Impact emission (O'Brien & Hodgins): a cone of droplets thrown from a
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
  // Scale the crown to how HARD the object actually hit. A buoy
  // dropping a few centimetres and one falling off a crest were
  // throwing the same 12-droplet minimum at the same full size range,
  // so every nudge read as a belly-flop. Count and size both fall away
  // with the impact, on their own curves: the count can go to almost
  // nothing, while the size settles toward sizeMin rather than zero —
  // a light touch still makes spray, just fine spray.
  const e = Math.min(Math.max(energy, 0), 1)
  const count = Math.round(
    DROPLET.impactCountMin +
      (DROPLET.impactCountMax - DROPLET.impactCountMin) *
        Math.pow(e, DROPLET.impactCountCurve),
  )
  if (count <= 0) return
  const sizeK = Math.pow(e, DROPLET.impactSizeCurve)
  const s = sampleOcean(x, z, t, 1, 1)
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2
    const r = (0.6 + Math.random() * 1.4) * (0.5 + e)
    launch(
      t,
      x,
      s.height + 0.1,
      z,
      Math.cos(a) * r + dirX * 1.6 * e,
      (1.2 + Math.random() * 1.6) * (0.6 + e),
      Math.sin(a) * r + dirZ * 1.6 * e,
      true,
      sizeK,
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
  /** Rest anchor + droplet count, carried so emission can run AFTER
   * classification (only pink points splash). */
  ax: number
  az: number
  count: number
  /** 0..1 inversion depth (drives oval target size). */
  depth: number
  /** Raw Jacobian at the sample, for the froth criterion. */
  jacobian: number
  /** Id of the persistent loop this point belongs to (-1 = none). */
  track: number
}
export const loopHeadings: LoopHeading[] = []

/** Froth masses a single scan cell stands for, before density and
 * visibility thinning: the cell's area over the froth lattice's. */
const CELL_MASSES =
  (DROPLET.scanStep / FROTH.lattice) * (DROPLET.scanStep / FROTH.lattice)

/** GLSL-style smoothstep, for the CPU twins of the froth criterion. */
function smooth01(x: number, e0: number, e1: number) {
  const u = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1)
  return u * u * (3 - 2 * u)
}

/** Phase speed of the dominant band — the reference a loop's own speed
 * is measured against. */
const DOM_PHASE_SPEED = domWave.omega / domWave.k

/** Mean baked froth radius (FROTH.radiusBase + half the jitter): the
 * lattice's per-point hash is a GPU detail, so emission uses the mean. */
const FROTH_MEAN_R = FROTH.radiusBase + FROTH.radiusVar * 0.5

/** Dominant band amplitude — the froth criterion's normaliser. */
const domAmp = waves.reduce((a, w) => Math.max(a, w.amp), 0)

let coverScanClock = 0

/**
 * The scan is SLICED across frames. At window scale it samples a few
 * thousand ocean points, and doing that in a single frame every 0.1s
 * was a periodic hitch that cost ~9fps of average — the work itself is
 * affordable, arriving all at once is not. Each call walks one slice of
 * the x range; the last slice classifies and emits.
 */
const SCAN_SLICES = 6
const SCAN_COARSE = Math.max(1, Math.round(DROPLET.scanCoarse))
let scanSlice = 0
let scanJx = 0
let scanJz = 0

/**
 * Cells (in scan-grid coordinates) close enough to a known loop to be
 * worth sampling at full resolution. Rebuilt once per cycle by
 * rasterising each track's crest band — a few thousand integer inserts,
 * against the ocean samples they save.
 */
const hotCells = new Set<number>()

function cellKey(ix: number, iz: number) {
  return (ix + 8192) * 32768 + (iz + 8192)
}

function markHotCells() {
  hotCells.clear()
  const step = LOOP_SCAN_STEP
  const band = DROPLET.scanBand
  for (const tr of loopTracks) {
    // Walk the crest line the track spans, and sweep across it.
    const ux = -tr.hz
    const uz = tr.hx
    const halfLen = Math.max(tr.length, step) * 0.5 + band
    for (let u = -halfLen; u <= halfLen; u += step) {
      for (let v = -band; v <= band; v += step) {
        const x = tr.wx + ux * u + tr.hx * v
        const z = tr.wz + uz * u + tr.hz * v
        hotCells.add(cellKey(Math.floor(x / step), Math.floor(z / step)))
      }
    }
  }
}

function scanLoopSplash(t: number) {
  if (scanSlice === 0) {
    loopHeadings.length = 0
    censusLive.sampled = 0
    censusLive.skipped = 0
    censusLive.recorded = 0
    censusLive.emitted = 0
    censusLive.blockedFroth = 0
    censusLive.blockedExpose = 0
    censusLive.blockedPeak = 0
    scanJx = Math.random() * LOOP_SCAN_STEP
    scanJz = Math.random() * LOOP_SCAN_STEP
    markHotCells()
  }
  const jx = scanJx
  const jz = scanJz
  const span = 2 * LOOP_SCAN_EXTENT
  const x0 = -LOOP_SCAN_EXTENT + (span * scanSlice) / SCAN_SLICES
  const x1 = -LOOP_SCAN_EXTENT + (span * (scanSlice + 1)) / SCAN_SLICES
  for (
    let x = x0 + jx;
    x < x1;
    x += LOOP_SCAN_STEP
  ) {
    for (
      let z = -LOOP_SCAN_EXTENT + jz;
      z <= LOOP_SCAN_EXTENT;
      z += LOOP_SCAN_STEP
    ) {
      if (!inView(x, z)) continue
      // ADAPTIVE: full resolution only near a known loop; elsewhere
      // every Nth cell, which is enough to catch a new one forming.
      const ix = Math.floor(x / LOOP_SCAN_STEP)
      const iz = Math.floor(z / LOOP_SCAN_STEP)
      const coarse =
        ((ix % SCAN_COARSE) + SCAN_COARSE) % SCAN_COARSE === 0 &&
        ((iz % SCAN_COARSE) + SCAN_COARSE) % SCAN_COARSE === 0
      if (!coarse && !hotCells.has(cellKey(ix, iz))) {
        censusLive.skipped++
        continue
      }
      censusLive.sampled++
      const s1 = sampleOcean(x, z, t, 1, 1)
      if (s1.jacobian > LOOP_J) continue
      censusLive.recorded++
      // Qualifying points get a REFINED sample for their ANCHOR: the
      // 1-iteration rest inversion is centimeter-grade on calm water but
      // worst exactly at a pinch (the sway gradient there is ~1 by
      // definition), and this anchor drives the pinned flight and the
      // heading. Qualification and depth stay on the COARSE sample —
      // re-testing J at the refined rest point silently culled sites
      // (the two samples straddle the pinch and disagree near its edge).
      const s = sampleOcean(x, z, t, 1, 3)
      // Exponential in loop size: emission doubles per half-depth, so
      // shallow grazes stay at 4 while the deepest inversions throw 16
      // (2x the old flat-bonus max). Stochastic rounding keeps the
      // fractional part honest instead of stair-stepping.
      const depth = Math.min((LOOP_J - s1.jacobian) / LOOP_DEPTH_SPAN, 1)
      const raw = 4 * Math.pow(2, 2 * depth)
      let count = Math.floor(raw)
      if (Math.random() < raw - count) count++
      // Rest coords for the evaluation: the sample's sway is the
      // inversion we already paid for.
      const lv = loopVelocity(x - s.swayX, z - s.swayZ, t)
      const lvLen = Math.hypot(lv.x, lv.z)
      const hx = lvLen > 0.01 ? lv.x / lvLen : HEAD_X
      const hz = lvLen > 0.01 ? lv.z / lvLen : HEAD_Z
      // The cap must exceed what a full window-sized scan can record,
      // or the list fills partway through the x sweep and every later
      // slice is silently dropped — which showed as froth throwing
      // droplets only on one side of the screen. A window scan records
      // ~600; 2048 leaves room for wider windows and finer steps.
      if (loopHeadings.length < 2048) {
        loopHeadings.push({
          x,
          y: s.height,
          z,
          hx,
          hz,
          speed: lvLen,
          ax: x - s.swayX,
          az: z - s.swayZ,
          count,
          depth,
          jacobian: s1.jacobian,
          track: -1,
        })
      }
    }
  }
  // Only the final slice has the whole picture: classify and emit.
  scanSlice = (scanSlice + 1) % SCAN_SLICES
  if (scanSlice !== 0) return
  // (The neighbour-vote chain classification lived here. Tracks make it
  // redundant: a real crest line is a connected run with genuine extent
  // ALONG the crest, which buildLoopTracks already measures as
  // `length` — so the vote, its bucket grid and its per-point pass are
  // gone, replaced by one comparison at emission.)
  buildLoopTracks(t)
  // Aim the trail at its per-cycle budget using LAST cycle's qualifying
  // count — the current one is not known until the loop below has run,
  // and the count changes slowly compared to a 0.1s cycle.
  // Emission — from PINK points only. These are the primary crashing
  // particles: pinned to the loop's frame, thrown slightly ahead of it.
  for (const a of loopHeadings) {
    // The hop is RELATIVE to the rising crest, like the horizontal is
    // relative to the advancing loop: droplets inherit the surface's
    // upward velocity so the wave can't climb over its own spray.
    const rise = surfaceRise(a.ax, a.az, t)
    // Shared by the foam trail and the droplets: how much froth this
    // point grows, and which persistent loop it belongs to.
    const sk = frothFactor(a.ax, a.az, t, a.jacobian)
    const tr = a.track >= 0 ? trackIndex.get(a.track) : undefined

    // FOAM TRAIL. The break lays foam itself, rather than waiting for a
    // droplet to land and leave a dot. Anchored in REST coordinates like
    // every other deposit — ax/az already ARE the rest anchor, so unlike
    // a landing this needs no inversion — and set down slightly behind
    // the crest, which then advances away and leaves it as a wake.
    if (!ENABLE.splashDroplets) continue
    // Stricter than the froth's own visibility threshold: a faint smear
    // of froth is fine to look at but has nothing to throw.
    if (sk < DROPLET.minFroth) {
      censusLive.blockedFroth++
      continue
    }
    // ...and the same factor sets how far ahead the water is thrown: a
    // big plunging loop hurls it forward, a small one barely clears its
    // own crest.
    const sizeK =
      DROPLET.hopFwdSizeFloor +
      (1 - DROPLET.hopFwdSizeFloor) * Math.min(sk / FROTH.sizeCap, 1)
    // ...and with the loop's OWN SPEED. Droplets fly pinned to the
    // loop's frame, so the hop is motion RELATIVE to the crest: at a
    // fixed 1-2 m/s it read fine on a fast plunger but looked like the
    // water was being flung off a nearly stationary slow crest.
    // The TRACK decides two things: whether this is a crest line at all
    // (a real one is a connected run with extent along the crest; noise
    // is a lone point or a short smear), and the smoothed heading and
    // speed — per-sample values jitter with the scan grid, the loop
    // itself does not.
    if (!tr || tr.length < DROPLET.minLoopLength) continue
    const trackSpeed = tr.speed
    const speedK =
      DROPLET.hopFwdSpeedFloor +
      (1 - DROPLET.hopFwdSpeedFloor) * Math.min(trackSpeed / DOM_PHASE_SPEED, 1)
    // How many froth masses this scan cell stands for: the cell's area
    // over the froth lattice's, thinned by the same density and
    // visibility ramps the shader applies. Each throws `perFroth`.
    const ss = smooth01(sk, FROTH.densStart, FROTH.densEnd)
    const densFrac = FROTH.densMax + (FROTH.densMin - FROTH.densMax) * ss
    const visFrac = smooth01(sk, FROTH.visStart, FROTH.visFull)
    const massCount = CELL_MASSES * densFrac * visFrac
    const count = Math.max(
      1,
      Math.min(Math.round(DROPLET.perFroth * massCount), DROPLET.maxPerPoint),
    )
    // Only throw once the froth mass is FULLY OUT of the water — the
    // sheet has overturned (J < 0, the same inversion that reveals the
    // mass to the camera) — AND the mass is at the TOP of its arc
    // around the loop. The second test is what stops droplets leaping
    // out of the water the instant a mass surfaces: a froth ball throws
    // its water when the crest carrying it peaks, so the surface must
    // be high and its climb spent.
    // The froth's own emergence gate, exactly as the shader computes
    // it: fully open below gateJFull, closed above gateJStart.
    const expose = 1 - smooth01(a.jacobian, FROTH.gateJFull, FROTH.gateJStart)
    if (expose < DROPLET.exposeMin) {
      censusLive.blockedExpose++
      continue
    }
    const hn = a.y / domAmp
    if (hn < DROPLET.peakHeight || rise > DROPLET.peakRise) {
      censusLive.blockedPeak++
      continue
    }
    censusLive.emitted++
    // Origin is the froth mass's CENTRE. The shader places the mass at
    // surface - normal * (submersion x radius); on an inverted sheet the
    // normal points down, so that offset lifts the mass clear of the
    // water — which is why it becomes visible at all.
    const frothR = FROTH_MEAN_R * Math.min(sk, FROTH.sizeCap)
    const centreOff = frothR * FROTH.submersion
    // Thrown along the froth's own SPIN around the loop: the water's
    // orbital velocity, which on an overturning face runs forward and
    // over. Normalised — the hop constants set the speed.
    const orb = orbital(a.ax, a.az, t)
    const thx = tr.hx
    const thz = tr.hz
    const orbLen = Math.hypot(orb.x, orb.y, orb.z)
    const ox0 = orbLen > 0.01 ? orb.x / orbLen : thx
    const oy0 = orbLen > 0.01 ? orb.y / orbLen : 1
    const oz0 = orbLen > 0.01 ? orb.z / orbLen : thz
    for (let k = 0; k < count; k++) {
      const forward =
        (LOOP_FORWARD_MIN + Math.random() * LOOP_FORWARD_VAR) * sizeK * speedK
      // A droplet can never be larger than a fraction of the mass that
      // threw it — tiny froth was shedding droplets bigger than itself.
      const sizeCap = Math.max(frothR * DROPLET.sizeVsFroth, SIZE_MIN)
      const size = Math.min(
        SIZE_MIN + Math.random() * (SIZE_MAX - SIZE_MIN),
        sizeCap,
      )
      const up = LOOP_UP_MIN + Math.random() * LOOP_UP_VAR
      // Start on the froth ball's LEADING FACE, not at its centre: the
      // mass is a metre across and opaque, so a droplet born at the
      // centre is simply inside it — invisible until it has travelled
      // its own radius.
      const emerge = frothR + size
      // Every droplet off a mass gets its OWN spawn point and its own
      // throw. Sharing them made a handful of droplets sit on top of
      // each other and read as one big blob. Spread across the whole
      // face (up to a full radius either way, on both horizontal axes
      // and vertically), and give each its own speed and direction
      // jitter, so one mass sheds a scattered burst.
      const sx = (Math.random() * 2 - 1) * frothR
      const sz = (Math.random() * 2 - 1) * frothR
      const sy = (Math.random() * 2 - 1) * frothR * 0.6
      // Per-droplet throw: speed varies around the mass's figure, and
      // the direction cones out from the spin axis.
      const spd = forward * (0.65 + Math.random() * 0.7)
      const coneX = (Math.random() * 2 - 1) * 0.35
      const coneZ = (Math.random() * 2 - 1) * 0.35
      launchLoop(
        t,
        a.ax,
        a.az,
        a.y + centreOff + oy0 * emerge + sy,
        ox0 * emerge + sx,
        oz0 * emerge + sz,
        ox0 * spd + coneX,
        Math.max(rise, 0) + oy0 * spd + up,
        oz0 * spd + coneZ,
        size,
        centreOff + oy0 * emerge + sy,
      )
    }
  }
  Object.assign(scanCensus, censusLive)
}

/**
 * The FROTH criterion, on the CPU. This is a twin of frothFrame() in
 * Scene.svelte: the same pinch-weighted amplitude vote, the same
 * intensity window with its lagged release tail, the same response
 * curve. It answers "would a froth mass exist here?" so droplet
 * emission can be gated on it — droplets are torn from the froth, so
 * they should not appear where there is no froth to tear.
 *
 * Returns the combined size factor `sk`; compare against FROTH.visStart.
 */
function frothFactor(u: number, v: number, t: number, jNow: number) {
  let wAmp = 0
  let wsum = 0
  for (const w of waves) {
    const theta = (u * w.dirX + v * w.dirZ) * w.k - w.omega * t + w.phase
    const pw = Math.max(w.q * w.amp * w.k * Math.sin(theta), 0)
    const sq = pw * pw
    wAmp += w.amp * sq
    wsum += sq
  }
  const loopAmp = wsum > 0.0001 ? wAmp / wsum : 0
  const ampK = Math.min(Math.max(loopAmp / domAmp, FROTH.ampRatioFloor), 1)
  // Jacobian a beat in the past, for the same release tail the shader has.
  let jxx = 1
  let jzz = 1
  let jxz = 0
  for (const w of waves) {
    const theta =
      (u * w.dirX + v * w.dirZ) * w.k - w.omega * (t - FROTH.gateLag) + w.phase
    const qak = w.q * w.amp * w.k * Math.sin(theta)
    jxx -= qak * w.dirX * w.dirX
    jzz -= qak * w.dirZ * w.dirZ
    jxz -= qak * w.dirX * w.dirZ
  }
  const jPast = jxx * jzz - jxz * jxz
  const iNow = Math.min(Math.max((FROTH.intJStart - jNow) / FROTH.intJSpan, 0), 1)
  const iPast = Math.min(Math.max((FROTH.intJStart - jPast) / FROTH.intJSpan, 0), 1)
  const intK =
    FROTH.intFloor +
    (1 - FROTH.intFloor) * Math.max(iNow, iPast * FROTH.gateLagWeight)
  let sk = ampK * intK
  const cs = Math.min(
    Math.max((sk - FROTH.curveStart) / (FROTH.curveEnd - FROTH.curveStart), 0),
    1,
  )
  sk *= 1 + FROTH.curveBoost * (cs * cs * (3 - 2 * cs))
  return sk
}

/**
 * SPUME INJECTORS: persistent entities that feed the mist field.
 *
 * Feeding straight off the scan puffed badly — the qualifying point SET
 * churns every 0.1s (jittered grid), so dye kept starting up at NEW
 * locations with no history. Injectors fix it the way the droplets and
 * crest ovals were fixed: spawned once, advected with loopFrame between
 * scans, strength EASED up and down, and only retired when their loop
 * is gone. Dye is then fed continuously at a smoothly moving point, so
 * the mist accumulates into a wall instead of popping.
 */
type SpumeInjector = {
  active: boolean
  ax: number
  az: number
  hx: number
  hz: number
  /** Eased 0..1 feed strength and its scan-driven target. */
  strength: number
  target: number
  lastSeen: number
  x: number
  z: number
  /** Loop advance velocity, handed to the splats as impulse. */
  vx: number
  vz: number
}

const MAX_INJECTORS = 48
const injectors: SpumeInjector[] = Array.from(
  { length: MAX_INJECTORS },
  () => ({
    active: false,
    ax: 0,
    az: 0,
    hx: 1,
    hz: 0,
    strength: 0,
    target: 0,
    lastSeen: -10,
    x: 0,
    z: 0,
    vx: 0,
    vz: 0,
  }),
)

/** Dye per second at full strength, per injector. */
const SPUME_RATE = MIST.spumeRate
/** Fraction of the feed dumped as a TIGHT plume right at the crest. */
const SPUME_CREST_SHARE = MIST.spumeCrestShare
// Two splats per injector now, so half the previous per-frame count
// keeps the field's 16-splat budget intact.
const SPUME_PER_FRAME = MIST.spumePerFrame
let spumeCursor = 0

function refreshInjectors(t: number) {
  for (const a of loopHeadings) {
    const ease = Math.min(Math.max((a.depth - 0.1) / 0.25, 0), 1)
    if (ease <= 0) continue
    let best: SpumeInjector | null = null
    let bestD = 4
    for (const o of injectors) {
      if (!o.active) continue
      const dx = o.ax - a.ax
      const dz = o.az - a.az
      const d2 = dx * dx + dz * dz
      if (d2 < bestD) {
        bestD = d2
        best = o
      }
    }
    const target = ease * ease * Math.min(a.count / 8, 1.5)
    if (best) {
      best.target = Math.max(best.target, target)
      best.lastSeen = t
      best.ax += (a.ax - best.ax) * 0.2
      best.az += (a.az - best.az) * 0.2
      best.hx += (a.hx - best.hx) * 0.3
      best.hz += (a.hz - best.hz) * 0.3
    } else {
      const o = injectors.find((o) => !o.active)
      if (!o) continue
      o.active = true
      o.ax = a.ax
      o.az = a.az
      o.hx = a.hx
      o.hz = a.hz
      o.strength = 0
      o.target = target
      o.lastSeen = t
      o.x = a.x
      o.z = a.z
    }
  }
  // Targets decay between refreshes so an unmatched injector eases out.
  for (const o of injectors) {
    if (o.active && t - o.lastSeen > 0.25) o.target = 0
  }
}

function updateInjectors(dt: number, t: number) {
  for (const o of injectors) {
    if (!o.active) continue
    const rate = o.target > o.strength ? 2.5 : 1.5
    o.strength += (o.target - o.strength) * Math.min(rate * dt, 1)
    if (o.strength < 0.02 && o.target === 0) {
      o.active = false
      continue
    }
    const fr = loopFrame(o.ax, o.az, t)
    o.ax += fr.vx * dt
    o.az += fr.vz * dt
    o.x = o.ax + fr.swayX
    o.z = o.az + fr.swayZ
    o.vx = fr.vx
    o.vz = fr.vz
  }
}

/** Feed the mist field: a rotating subset per frame, dt-scaled. The
 * impulse is the LOOP'S OWN advance velocity, so the dye RIDES with the
 * break — the field is Eulerian, dye goes where the velocity field
 * takes it, and the old backward impulse literally parked it. */
function emitSpume(dt: number) {
  const live = injectors.filter((o) => o.active && o.strength > 0.02)
  if (live.length === 0) return
  const served = Math.min(live.length, SPUME_PER_FRAME)
  const share = live.length / served
  for (let i = 0; i < served; i++) {
    const o = live[spumeCursor % live.length]
    spumeCursor++
    const feed = SPUME_RATE * o.strength * dt * share
    // TIGHT plume AT the crest, where the foam sprites are: most of the
    // feed goes here in a small radius, so it reads dense and bright
    // right off the foam. It thins fast on its own — the solver spreads
    // a concentrated blob far quicker than a wide one, so crest
    // prominence decays into haze behind it.
    queueMistSplat(
      o.x,
      o.z,
      feed * SPUME_CREST_SHARE,
      o.vx,
      o.vz,
      0.8,
    )
    // The tail: wider, weaker, travelling a little slower than the
    // crest so it strings out behind instead of stalling.
    queueMistSplat(
      o.x - o.hx * 1.6,
      o.z - o.hz * 1.6,
      feed * (1.0 - SPUME_CREST_SHARE),
      o.vx * 0.7,
      o.vz * 0.7,
      1.8,
    )
  }
}

// Landing checks alternate between particle halves each step (the
// sampleOcean per particle is the module's dominant CPU cost, and a
// droplet moves ~5cm between checks — the extra latency is invisible).
let checkParity = 0

// Landing-check accounting, so the height early-out can be shown to pay
// for itself rather than assumed to. The bound it uses is the straight
// amplitude sum, which is loose — components rarely align — so the skip
// rate depends entirely on how high droplets actually fly.
let checksRun = 0
let checksSkipped = 0
export function sprayCheckStats() {
  const r = { run: checksRun, skipped: checksSkipped }
  checksRun = 0
  checksSkipped = 0
  return r
}

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
  if (coverScanClock >= LOOP_SCAN_INTERVAL / SCAN_SLICES) {
    coverScanClock = 0
    scanLoopSplash(t)
    if (scanSlice === 0) refreshInjectors(t)
  }
  updateLoopTracks(dt, t)
  updateInjectors(dt, t)
  emitSpume(dt)

  checkParity ^= 1
  for (let i = 0; i < sprayParticles.length; i++) {
    const p = sprayParticles[i]
    if (p.size === 0) continue
    if (t - p.birth > LIFE_MAX) {
      p.size = 0
      continue
    }
    // Not yet activated (birth stagger): the droplet is still PART of
    // the froth mass, so it rides the loop frame instead of hanging in
    // space waiting. Otherwise the loop travelled on during the stagger
    // and the droplet popped into being where the froth used to be —
    // ahead of nothing, with no throw, just falling.
    if (t < p.birth) {
      if (p.loop) {
        const fr0 = loopFrame(p.ax, p.az, t)
        p.ax += fr0.vx * dt
        p.az += fr0.vz * dt
        p.x = p.ax + fr0.swayX + p.ox
        p.z = p.az + fr0.swayZ + p.oz
        // Keep sitting on the froth's crown as the wave lifts and drops.
        p.y = fr0.h + p.crown
      }
      continue
    }
    // Dying: keep riding the water while the render shrinks it out.
    if (p.dying >= 0) {
      if (t - p.dying > DROPLET.dieTime) p.size = 0
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
      // Publish the true horizontal motion for the render's velocity
      // streaking (pinned droplets don't integrate vx/vz themselves).
      p.vx = fr.vx + p.rvx
      p.vz = fr.vz + p.rvz
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
    // A submerged droplet is dead REGARDLESS of rise or fall: a trough
    // emission can sit below the NEIGHBORING wave face for its entire
    // arc, invisible behind the opaque water. Only droplets that had a
    // real airborne life hand anything back — foam appearing where no
    // droplet was ever visible reads as haunted.
    if ((i & 1) !== checkParity) continue
    // Loop droplets skip the submersion test while young: at a fold the
    // surface is MULTI-SHEETED and the sampler returns whichever sheet
    // the inversion lands on — often the tongue ABOVE the droplet — so
    // the test insta-culled healthy spray (~740/s measured, the
    // flicker). A genuinely buried droplet is occluded by the opaque
    // water meanwhile; the test resumes once the flight matures.
    if (p.loop && t - p.birth < DROPLET.submergeGrace) continue
    // Skip the sample while this droplet is still provably clear of the
    // water, extrapolating from where it last looked: the sea can have
    // risen at most maxSurfaceRate * elapsed since then, and moving
    // sideways can have carried the droplet over water at most
    // checkSlopeBound higher per metre travelled. LOCAL, unlike the global
    // amplitude-sum bound this replaced — a droplet 4m over a trough is
    // skippable here, where before it had to clear every crest at once.
    if (PROFILE.skipLandingCheck) continue
    const gap = t - p.chT
    const dxc = p.x - p.chX
    const dzc = p.z - p.chZ
    const reach =
      p.chH +
      maxSurfaceRate * gap +
      DROPLET.checkSlopeBound * Math.sqrt(dxc * dxc + dzc * dzc)
    if (gap < DROPLET.checkMaxGap && p.y - p.size > reach) {
      checksSkipped++
      continue
    }
    checksRun++
    const height = oceanHeight(p.x, p.z, t, 1, 1)
    p.chH = height
    p.chT = t
    p.chX = p.x
    p.chZ = p.z
    // CONTACT, not submersion: the droplet's underside reaching the water
    // is the moment of impact — that is when it breaks up, rings the
    // surface and leaves foam. Waiting for the centre to pass fully
    // under delayed every splash by the time it took to sink its own
    // radius, which at these sizes is a visible beat.
    if (p.y - p.size < height) {
      if (t - p.birth < 0.1) culledYoung++
      // Gate sized so trough-buried ghosts (dead in < 0.05s) still hand
      // nothing back, while the low skimmers' short real flights do.
      // LOOP droplets are exempt: they launch from a visible break and
      // land ahead of a RISING face, so their real flights are often
      // shorter than the gate — it was silently eating exactly the
      // crash-front deposits (droplet visibly hits, no foam appears).
      // A landing only counts if the droplet actually FLEW. Loop
      // droplets used to be exempt (they launched at the waterline and
      // their real flights were shorter than the gate), but now that
      // they launch clear of the froth crown a quick death means the
      // fold's multi-sheet misread killed them — and those were
      // depositing foam where no droplet was ever visible.
      if (t - p.birth > DROPLET.minFlight) {
        // Landing: hand the water back (O'Brien & Hodgins). The droplet
        // rings the surface and leaves a slow-dying dot of foam residue,
        // anchored in REST coordinates — the material water point under
        // the landing — so it rides the Gerstner sway with the surface.
        injectRipple(p.x, p.z, 0.1 + p.size, 0.02 + p.size * 0.18)
        // The deposit's REST anchor uses a refined 3-iteration inversion:
        // the cheap landing-check sample (1 iteration) misses by up to a
        // large fraction of a meter near a pinch, smearing crash-front
        // foam away from where the droplet visibly struck. Deposits are
        // rare (once per landing), so the extra sample costs nothing.
        const r = sampleOcean(p.x, p.z, t, 1, 3)
        // Impact atomization: some crashes puff a little mist.
        if (p.loop && Math.random() < 0.5) {
          queueMistSplat(p.x, p.z, 0.05, 0, 0, 0.6)
        }
        if (!ENABLE.dropletFoam) {
          // Attribution switch only — the ripple and mist above still
          // happen, so landings look the same minus their foam.
        } else if (!p.impact) {
          // Foam's ONLY source now — the field is emergent from landings.
          // Sigma floor: the field's texel is ~0.2m, and a sub-texel dot
          // dies to one diffusion pass no matter how slow the clocks are.
          // (0.2 base read as too much total foam; ~1 texel is the sweet
          // spot between resolvable and restrained.)
          addFoam(
            p.x - r.swayX,
            p.z - r.swayZ,
            DROPLET.depositBase + p.size * DROPLET.depositPerSize,
            DROPLET.depositAmount,
          )
        } else {
          // Buoy (impact) spray: EVERY droplet deposits, but at low amp so
          // the float doesn't paint a solid disc around itself. Sigma
          // floor matters here too: the old 0.04-0.11m deposits were
          // sub-texel and died to one diffusion pass — buoy spray never
          // visibly foamed at all.
          addFoam(
            p.x - r.swayX,
            p.z - r.swayZ,
            DROPLET.depositBaseBuoy + p.size * DROPLET.depositPerSizeBuoy,
            DROPLET.depositAmountBuoy,
          )
        }
      }
      p.dying = t
    }
  }
}
