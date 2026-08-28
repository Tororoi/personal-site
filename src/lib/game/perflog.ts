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
import { CAUSTICS, ENABLE, PROFILE } from './tuning'

const URL = 'http://127.0.0.1:8787/perf'
/** How often a sample is taken. */
const SAMPLE_MS = 250
/**
 * How often samples are shipped. Short, because sendBeacon silently drops
 * payloads past ~64KB — the buoy diagnostic at 180 lines/s in 2s batches
 * lost 87% of its frames that way. Small frequent batches stay far under
 * the limit, and the chunked flush below is the belt to this suspender.
 */
const FLUSH_MS = 300

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
  sEmit: number
  sScan: number
  sTracks: number
  sParticles: number
  /**
   * Per-pass GPU milliseconds. Only meaningful with ENABLE.gpuProfile on
   * — zero otherwise — and only trustworthy when perf.gpuClock reads 'q'
   * (real timer queries). These are the rows that matter for comparing
   * two configurations: this machine throttles ~2x under sustained load,
   * so wall-clock fps conflates the change under test with how warm the
   * GPU happened to be. Every pass inflating together IS the throttle
   * signature, and having them per-sample makes it visible after the
   * fact instead of guessable.
   */
  gpuMain: number
  gpuCaustic: number
  gpuFft: number
  gpuFoam: number
  gpuRipple: number
}

let queue: string[] = []
let started = false
let t0 = 0

function flush() {
  if (!queue.length) return
  const lines = queue
  queue = []
  // Chunked well under sendBeacon's ~64KB ceiling, and with a fetch
  // fallback when the beacon refuses: a diagnostic that silently drops
  // seven-eighths of its data is worse than none, because it gets read
  // as "the values were smooth".
  for (let i = 0; i < lines.length; i += 150) {
    const body = lines.slice(i, i + 150).join('\n') + '\n'
    try {
      const ok = navigator.sendBeacon?.(URL, new Blob([body], { type: 'text/plain' }))
      if (!ok) {
        fetch(URL, { method: 'POST', body, keepalive: true }).catch(() => {})
      }
    } catch {
      /* sink not running; sampling is a dev aid, never a hard dependency */
    }
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
      // The live groups a run's result depends on but PROFILE does not
      // carry — accumulation and clamp settings are tuned mid-session.
      caustics: { ...CAUSTICS },
    }),
  )
  setInterval(flush, FLUSH_MS)
  // Losing the tail of a run to a closed tab is a silly way to lose data.
  addEventListener('pagehide', flush)
  addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush()
  })
}

/**
 * Free-form diagnostic line into the same stream. Distinguished from perf
 * samples by its `d` tag; same batching, same fire-and-forget beacon.
 */
export function logDiag(obj: Record<string, unknown>) {
  if (!started) return
  queue.push(JSON.stringify({ d: 1, t: +((performance.now() - t0) / 1000).toFixed(3), ...obj }))
}

export function recordSample(s: Omit<Sample, 't'>) {
  if (!started) return
  queue.push(JSON.stringify({ t: +((performance.now() - t0) / 1000).toFixed(2), ...s }))
}

export { SAMPLE_MS }
