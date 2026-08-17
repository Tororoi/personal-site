/**
 * SURFACE CURRENT: the slow bulk drift of the water body, as distinct
 * from the wind that blows across it.
 *
 * Deterministic in wave time, like the wind — a set direction with a
 * slow meander and a gently breathing rate, so drifting objects wander
 * rather than tracking a perfectly straight line. Foam rides it today;
 * flotsam, the boat and a cast line are the obvious future consumers,
 * which is why this lives in its own module rather than inside foam.ts.
 */

import { CURRENT } from './tuning'
import { activeField, onFieldChange } from './waves'

/** The preset's surface-current set; falls back to the wind heading. */
let setAngle = activeField.surfaceCurrentHeading ?? activeField.windAngle
let setSpeed = activeField.surfaceCurrentSpeed ?? CURRENT.speed
onFieldChange(() => {
  setAngle = activeField.surfaceCurrentHeading ?? activeField.windAngle
  setSpeed = activeField.surfaceCurrentSpeed ?? CURRENT.speed
})

/** Surface current velocity in m/s at wave time t. Spatially uniform:
 * the visible patch of sea is far smaller than any real current eddy. */
export function currentVector(t: number): { x: number; z: number } {
  const a = setAngle + CURRENT.meander * Math.sin(t * 0.037 + 1.3)
  const s = setSpeed * (1 + CURRENT.breath * Math.sin(t * 0.083 + 0.6))
  return { x: Math.cos(a) * s, z: Math.sin(a) * s }
}

/** Integrated displacement, metres — for anything that needs the total
 * distance the water has carried it rather than an instantaneous rate. */
export const currentTravel = { x: 0, z: 0 }

export function advanceCurrent(dt: number, t: number) {
  const c = currentVector(t)
  currentTravel.x += c.x * dt
  currentTravel.z += c.z * dt
}
