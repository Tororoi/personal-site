/**
 * Splash froth: the burst of seething white water where something hits the
 * surface. A separate effect from ripples (waves PROPAGATE; aerated water
 * sits where it was made and dies), so it gets separate machinery: no
 * texture, no sim pass. Each burst is an analytic blob, a gaussian that
 * spreads slowly and decays exponentially, evaluated directly in the water
 * shader from a small uniform list. The blob's seethe uses the same
 * crest-churn visual language as breaking waves.
 *
 * Froth is NOT gated by the sea's churn setting: a hard splash froths even
 * on a calm pond. Deposits self-scale with impact, and calm seas rarely
 * produce hard impacts, so calm water stays clean naturally.
 */

import { activeField } from './waves'

export const MAX_FROTH = 16

/** Seconds for a burst to decay to 1/e. Life is ~4x this. */
const FROTH_LIFE = 0.2
/** Meters/second the blob's radius grows (bubbles spreading). */
const FROTH_SPREAD = 0.25

const SETTINGS = {
  /** Seethe displacement, meters at full intensity. */
  frothAmplitude: 1.26,
  /** Whiteness gain: bursts paint solid white well before full seethe. */
  frothWhiteness: 4.2,
  /** Initial gaussian radius of a splashdown burst, meters. */
  frothSigma: 0.4,
  ...pick(activeField.ripples ?? {}, [
    'frothAmplitude',
    'frothWhiteness',
    'frothSigma',
  ]),
}

/** Splashdown burst radius; callers pass this to addFroth for impacts. */
export const FROTH_SIGMA = SETTINGS.frothSigma

function pick<T extends object>(obj: T, keys: (keyof T)[]): Partial<T> {
  const out: Partial<T> = {}
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k]
  return out
}

export type FrothBlob = {
  x: number
  z: number
  /** waveTime at the splash. */
  birth: number
  /** Initial gaussian radius, meters. */
  sigma: number
  /** 0..~1.5 burst strength; 0 = slot free. */
  amp: number
}

/** Fixed slots, uploaded to uniforms each frame by the Scene. */
export const frothBlobs: FrothBlob[] = Array.from(
  { length: MAX_FROTH },
  () => ({
    x: 0,
    z: 0,
    birth: -100,
    sigma: 1,
    amp: 0,
  }),
)

export function addFroth(
  t: number,
  x: number,
  z: number,
  sigma: number,
  amp: number,
) {
  const slot = frothBlobs.find(
    (b) => b.amp === 0 || t - b.birth > FROTH_LIFE * 4,
  )
  if (!slot) return
  slot.x = x
  slot.z = z
  slot.birth = t
  slot.sigma = sigma
  slot.amp = Math.min(amp, 1.5)
}

/**
 * Water-shader side: seethe + white where bursts are alive. Blob params
 * come from the same frothBlobs array the CPU mutates.
 */
export function frothGlsl(): string {
  return `
#define MAX_FROTH ${MAX_FROTH}
uniform vec4 uFrothA[MAX_FROTH]; // x, z, birth, sigma0
uniform vec4 uFrothB[MAX_FROTH]; // amp, unused...

float applyFroth(inout vec3 p, vec2 worldXZ, float t) {
	float white = 0.0;
	for (int i = 0; i < MAX_FROTH; i++) {
		float amp = uFrothB[i].x;
		if (amp < 0.01) continue;
		vec4 A = uFrothA[i];
		float age = t - A.z;
		if (age < 0.0 || age > ${(FROTH_LIFE * 4).toFixed(2)}) continue;
		float decay = exp(-age / ${FROTH_LIFE.toFixed(2)});
		float sigma = A.w + age * ${FROTH_SPREAD.toFixed(2)};
		vec2 d = worldXZ - A.xy;
		float intensity = amp * decay * exp(-dot(d, d) / (2.0 * sigma * sigma));
		if (intensity > 0.01) {
			float n1 = sin(worldXZ.x * 23.0 + t * 29.0) * sin(worldXZ.y * 17.0 - t * 25.0);
			float n2 = sin(worldXZ.x * 9.5 - t * 31.0 + 1.7) * sin(worldXZ.y * 13.5 + t * 21.0);
			p += vec3(n1 * 0.55, 0.5 + abs(n2), n2 * 0.55) *
				(${SETTINGS.frothAmplitude.toFixed(2)} * min(intensity, 1.0));
			white = max(white, intensity * ${SETTINGS.frothWhiteness.toFixed(2)});
		}
	}
	return clamp(white, 0.0, 1.0);
}`
}
