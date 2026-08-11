/**
 * Whitecapping: what happens AFTER the Jacobian says a crest is unstable.
 *
 * waves.ts detects instability (J collapsing); this module gives it
 * consequences. A CPU scan finds breaking crests and spawns EVENTS. Each
 * event, over its life:
 *
 * CRUMBLES the crest: a localized displacement that pulls the sharp top
 * down while the break is active. Twinned GLSL/CPU below, so floaters feel
 * the collapse too.
 *
 * The turbulent whitewater itself is mesh churn (applyChurn below), driven
 * by the instantaneous Jacobian field so it travels with the crest.
 *
 * Wind here is a VECTOR plus gusts, not a simulation: at a 55m viewport,
 * storm wind is spatially uniform to any observable precision. windAngle
 * and windSpeed come from the active sea preset.
 *
 * Event state lives in ONE array. The Scene uploads it to uniforms each
 * frame and the CPU twin reads it directly: the twins cannot disagree.
 */

import { activeField, sampleSurface, type SurfaceSample } from './waves'

export const MAX_EVENTS = 8

export type WhitecapEvent = {
  x: number
  z: number
  /** waveTime at spawn. */
  birth: number
  /** Gaussian radius of the patch, meters. 0 = slot inactive. */
  sigma: number
  /** Height above which the crumble pulls the crest down. */
  cap: number
  /** Seconds of active breaking (the crumble window); the event's lifetime. */
  breakDuration: number
}

/** Fixed slots; sigma = 0 marks a free slot. One array, both twins. */
export const events: WhitecapEvent[] = Array.from(
  { length: MAX_EVENTS },
  () => ({
    x: 0,
    z: 0,
    birth: 0,
    sigma: 0,
    cap: 0,
    breakDuration: 1,
  }),
)

// ---------- Wind ----------

const windAngle = activeField.windAngle
const windSpeed = activeField.windSpeed ?? 5

/** Slow multi-sine gust factor, ~0.7..1.4. Deterministic in waveTime. */
export function gust(t: number): number {
  return 1 + 0.25 * Math.sin(t * 0.31) + 0.15 * Math.sin(t * 0.73 + 2.1)
}

export function windVector(t: number): { x: number; z: number } {
  const g = windSpeed * gust(t)
  return { x: Math.cos(windAngle) * g, z: Math.sin(windAngle) * g }
}

// ---------- Event lifecycle ----------

/** J below this is treated as an active break worth an event. */
const BREAK_THRESHOLD = 0.08
/** Scan cadence and grid. The scan is the only cost when the sea is calm. */
const SCAN_INTERVAL = 0.35
const SCAN_EXTENT = 40
const SCAN_STEP = 3.6

let scanClock = 0

function crumblePhase(event: WhitecapEvent, t: number): number {
  const age = t - event.birth
  if (age < 0 || age > event.breakDuration) return 0
  return Math.sin(Math.PI * (age / event.breakDuration))
}

/**
 * Crumble contribution of all active events at world (x, z).
 * MUST match the event loop in whitecapsGlsl(), term for term.
 * ambientHeight is the surface height before events.
 */
export function eventSurface(
  x: number,
  z: number,
  t: number,
  ambientHeight: number,
): number {
  let dy = 0
  for (const e of events) {
    if (e.sigma === 0) continue
    const age = t - e.birth
    if (age < 0 || age > e.breakDuration) continue
    const dx = x - e.x
    const dz = z - e.z
    const env = Math.exp(-(dx * dx + dz * dz) / (2 * e.sigma * e.sigma))
    dy -=
      Math.max(ambientHeight + dy - e.cap, 0) * crumblePhase(e, t) * env * 0.85
  }
  return dy
}

/** Full ocean surface: ambient field plus event crumble. Floaters use THIS. */
export function sampleOcean(
  x: number,
  z: number,
  t: number,
  ampScale = 1,
  iterations = 3,
): SurfaceSample {
  const s = sampleSurface(x, z, t, ampScale, iterations)
  return { ...s, height: s.height + eventSurface(x, z, t, s.height) }
}

function spawn(t: number, x: number, z: number, height: number) {
  for (const e of events) {
    if (e.sigma !== 0 && t - e.birth <= e.breakDuration) {
      const dx = x - e.x
      const dz = z - e.z
      // Too close to a live event: it's the same break.
      if (dx * dx + dz * dz < (2 * e.sigma) ** 2) return
    }
  }
  const slot = events.find(
    (e) => e.sigma === 0 || t - e.birth > e.breakDuration,
  )
  if (!slot) return
  slot.x = x
  slot.z = z
  slot.birth = t
  slot.sigma = 4 + Math.random() * 3
  slot.cap = Math.max(height * 0.45, 0.2)
  slot.breakDuration = 1.3 + Math.random() * 0.8
}

/** Step events: expire finished breaks, periodic instability scan. */
export function update(dt: number, t: number) {
  for (const e of events) {
    if (e.sigma !== 0 && t - e.birth > e.breakDuration) e.sigma = 0
  }

  scanClock += dt
  if (scanClock >= SCAN_INTERVAL) {
    scanClock = 0
    for (let x = -SCAN_EXTENT; x <= SCAN_EXTENT; x += SCAN_STEP) {
      for (let z = -SCAN_EXTENT; z <= SCAN_EXTENT; z += SCAN_STEP) {
        const s = sampleSurface(x, z, t)
        if (s.jacobian < BREAK_THRESHOLD && s.height > 0) {
          spawn(t, x, z, s.height)
        }
      }
    }
  }

}

// ---------- GPU twin ----------

/**
 * GLSL twin of eventSurface(), plus the mesh churn.
 *
 * applyWhitecaps: crest crumble from the event array (twinned with
 * eventSurface, uploaded each frame).
 *
 * applyChurn: the active whitewater. Where the instantaneous Jacobian says
 * the surface is breaking, the mesh itself seethes: fast incoherent
 * turbulence plus an upward pile bias (the expanding aerated water). Driven
 * by the J FIELD, not events, so it travels with the crest and is shaped
 * like the crest. Deliberately NOT twinned on the CPU: the jitter is
 * mean-zero decoration, and floaters should ride the mean surface.
 */
export function whitecapsGlsl(): string {
  return `
#define MAX_EVENTS ${MAX_EVENTS}
uniform vec4 uEventA[MAX_EVENTS]; // x, z, birth, sigma
uniform vec4 uEventB[MAX_EVENTS]; // cap, breakDuration, 0, 0

// Crumbles p.y in place. Twin of eventSurface().
void applyWhitecaps(inout vec3 p, vec2 worldXZ, float t) {
	for (int i = 0; i < MAX_EVENTS; i++) {
		vec4 A = uEventA[i];
		vec4 B = uEventB[i];
		if (A.w < 0.001) continue;
		float age = t - A.z;
		if (age < 0.0 || age > B.y) continue;
		vec2 d = worldXZ - A.xy;
		float env = exp(-dot(d, d) / (2.0 * A.w * A.w));
		float breakPhase = sin(3.14159265 * age / B.y);
		p.y -= max(p.y - B.x, 0.0) * breakPhase * env * 0.85;
	}
}

uniform float uChurnStart; // J below this: churn begins
uniform float uChurnFull;  // J below this: full churn
uniform float uChurnAmp;   // meters of turbulent displacement at full churn
uniform vec2 uWind;            // live wind vector, m/s, gust-modulated
uniform float uChurnWindAniso; // per m/s: how much the downwind seethe component amplifies
uniform float uChurnWindPush;  // per m/s: steady downwind smear of churned water

// Returns churn 0..1 and roughens p in place where the surface is breaking.
// The sine frequencies sit below the mesh quad size on purpose: they alias
// into incoherent vertex seethe, which is exactly what boiling water needs.
// Wind makes the seethe directional: broken water is thrown downwind, so
// the turbulence component along the wind amplifies and the whole churned
// mass smears in the wind direction.
float applyChurn(inout vec3 p, vec2 worldXZ, float t, float jacobian) {
	float churn = 1.0 - smoothstep(uChurnFull, uChurnStart, jacobian);
	if (churn > 0.001) {
		float n1 = sin(worldXZ.x * 13.7 + t * 21.0) * sin(worldXZ.y * 11.3 - t * 17.0);
		float n2 = sin(worldXZ.x * 7.9 - t * 25.0 + 3.1) * sin(worldXZ.y * 15.1 + t * 19.0);
		vec3 turb = vec3(n1 * 0.6, 0.4 + abs(n2), n2 * 0.6);
		float windSpeed = length(uWind);
		if (windSpeed > 0.001) {
			vec2 windDir = uWind / windSpeed;
			// Seethe component already aligned with the wind, amplified
			// downwind; plus a steady smear that leans the churn off the crest.
			float along = turb.x * windDir.x + turb.z * windDir.y;
			turb.xz += windDir * (abs(along) * uChurnWindAniso + uChurnWindPush) * windSpeed;
		}
		p += turb * (uChurnAmp * churn);
	}
	return churn;
}`
}
