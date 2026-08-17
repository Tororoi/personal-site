/**
 * Client half of the perf sampler (see tools/perf-logger.mjs).
 *
 * Records a sample every quarter second and ships them in batches, so a
 * varying load — storm foam building and dying — is captured as a series
 * rather than as whatever the eye happened to catch. The point is to be
 * able to correlate cost against coverage after the fact instead of
 * guessing at it live.
 *
 * Everything here is written to be invisible to the thing it measures:
 * samples accumulate in a plain array, and the flush is a sendBeacon,
 * which neither blocks nor waits for a response. If the sink is not
 * running the beacon fails silently and the page is unaffected.
 */

import { activeField } from './waves'
import { ENABLE, PROFILE } from './tuning'

const URL = 'http://127.0.0.1:8787/perf'
/** How often a sample is taken. */
const SAMPLE_MS = 250
/** How often samples are shipped. Batched so the beacon is rare. */
const FLUSH_MS = 2000

export type Sample = {
  /** Seconds since logging began. */
  t: number
  fps: number
  ms: number
  worst: number
  mpx: number
  msPerMpx: number
  calls: number
  tris: number
  cpuMs: number
  steps: number
  foam: number
  spray: number
  cpuWhitecaps: number
  cpuSpray: number
  cpuCurrent: number
  cpuRest: number
  checkRun: number
  checkSkip: number
}

let queue: string[] = []
let started = false
let t0 = 0

function flush() {
  if (!queue.length) return
  const body = queue.join('\n') + '\n'
  queue = []
  try {
    navigator.sendBeacon?.(URL, new Blob([body], { type: 'text/plain' }))
  } catch {
    /* sink not running; sampling is a dev aid, never a hard dependency */
  }
}

/**
 * Opens a run. The header line records the configuration, so a log is
 * self-describing — without it, two runs with different switches are
 * indistinguishable a day later and the data is worthless.
 */
export function startPerfLog(label: string) {
  if (started) return
  started = true
  t0 = performance.now()
  queue.push(
    JSON.stringify({
      run: label,
      sea: { chop: activeField.chop, windSpeed: activeField.windSpeed, seed: activeField.seed },
      enable: { ...ENABLE },
      profile: { ...PROFILE },
    }),
  )
  setInterval(flush, FLUSH_MS)
  // Losing the tail of a run to a closed tab is a silly way to lose data.
  addEventListener('pagehide', flush)
  addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush()
  })
}

export function recordSample(s: Omit<Sample, 't'>) {
  if (!started) return
  queue.push(JSON.stringify({ t: +((performance.now() - t0) / 1000).toFixed(2), ...s }))
}

export { SAMPLE_MS }
