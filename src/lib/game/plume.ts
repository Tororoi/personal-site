/**
 * The crest plume's fragment shader, shared by the game and the /spike
 * inspector so the two can never drift apart.
 *
 * The plume is painted inside an enlarged point sprite: the bubble sits
 * at the bottom of the quad, and everything above it is spray. All the
 * shaping constants come from PLUME in tuning.ts.
 *
 * Varyings the caller must supply:
 *  vFrac  - bubble diameter as a fraction of the quad
 *  vSeed  - per-sprite random, for sway phase and streak offset
 *  vBurst - 0..1 throw envelope (peak-and-fall in the game)
 *  vShear - trailing lean, in quad units per unit height
 *  vGale  - orbital speed, m/s: drives amplitude, rise and tattering
 *  vViewZ - view depth, for fog
 */

import { f, FOAM, PLUME } from './tuning'
import { whitewaterLightGlsl, WHITEWATER_UNIFORM_DECLS } from './whitewater'

/**
 * @param coord expression yielding the sprite's 0..1 coords, y running
 *   DOWN. The game uses point sprites (`gl_PointCoord`); the /spike
 *   inspector draws a quad instead, because gl_PointSize is clamped by
 *   the driver (255-1024px) and a full-screen plume silently shrank.
 */
export function plumeFragmentGlsl(
  coord = 'gl_PointCoord',
  decls = '',
  /** Live overrides for the /spike inspector: GLSL expressions used in
   * place of the baked constants, so its sliders take effect without a
   * rebuild. The game passes nothing and keeps the constants. */
  live: { reachRadii?: string; clipFrac?: string } = {},
): string {
  const REACH = live.reachRadii ?? f(PLUME.reachRadii)
  const CLIP = live.clipFrac ?? f(PLUME.clipFrac)
  return `
${decls}
uniform vec3 uColor;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uTime;
${WHITEWATER_UNIFORM_DECLS}
/** Rise rate (x = rows/s at rest, y = rows/s per m/s): a UNIFORM, not
 * a baked constant, so the /spike inspector can slide it live. */
uniform vec2 uRise;
varying float vViewZ;
varying float vFrac;
varying float vSeed;
varying float vBurst;
varying float vShear;
varying float vGale;
/** World XZ of the sprite: lets neighbouring plumes share a streak
 * pattern instead of each randomising its own (see PLUME.coherence). */
varying vec2 vAnchor;

${whitewaterLightGlsl()}

float hash(vec2 p) {
	return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

void main() {
	// Point coords: y runs DOWN, so the plume occupies small y.
	vec2 pc = ${coord};
	float rr = vFrac * 0.5;
	vec2 bc = vec2(0.5, 1.0 - rr);
	// Height above the plume's ROOT, 0..1 over its own reach — measured
	// in bubble radii, not as a fraction of the quad. The quad is only
	// canvas: making it bigger gives the plume room to lean and spread
	// into, without making the plume itself bigger. The root sits
	// partway INTO the bubble (rootDepth), so spray grows out of the
	// foam mass instead of balancing on its crown.
	float root = bc.y - rr * (1.0 - ${f(PLUME.rootDepth)});
	float reachQ = ${REACH} * rr;
	float h = (root - pc.y) / max(reachQ, 0.0001);
	if (h <= 0.0) discard;
	// Plume widens with height, wanders on a slow per-sprite phase, and
	// LEANS opposite the sprite's motion, so spray rakes over rather
	// than standing straight up.
	float sway = sin(uTime * ${f(PLUME.swayRate)} + vSeed * 20.0 + h * ${f(PLUME.swayHeightPhase)}) * ${f(PLUME.swayAmp)} * h;
	float halfW = rr * (${f(PLUME.widthBase)} + ${f(PLUME.widthGrowth)} * h);
	// LEAN is applied in full. (Clamping it to the quad's spare room
	// silently disabled it: the plume's own width already exceeds the
	// quad at the tip, so there is never spare room. The quad edge is
	// handled by a wide dissolve below instead.)
	// Lean scales with the plume's own HEIGHT (reachQ), not the bubble:
	// a taller throw is aloft longer and rakes further, and — more
	// practically — this keeps the rake looking the same relative to the
	// plume when reachRadii changes. Scaling by the bubble instead meant
	// every increase in reach quietly diluted the lean.
	float lean = vShear * ${f(PLUME.leanStrength)} * h * h * reachQ;
	float x = (pc.x - 0.5 - sway - lean) / halfW;
	float body = 1.0 - clamp(abs(x), 0.0, 1.0);
	if (body <= 0.0) discard;
	// Wispy structure: streaks travelling UP the plume under GRAVITY.
	// The height coordinate is warped by the ballistic inverse — for
	// h = vt - gt^2/2 with the apex at h = 1, elapsed time is
	// t(h) = sqrt(2) - sqrt(2(1-h)) — so equal time steps cover less
	// height as the spray rises: it launches fast and stalls at the top.
	// Sign: phase INCREASES with time, so features climb (the previous
	// term ran them downward).
	float hb = clamp(h, 0.0, 1.0);
	float fh = 1.41421 - sqrt(2.0 * (1.0 - hb));
	// Rise rate is deliberately INDEPENDENT of orbital speed: momentum
	// drives the plume's height and lean, not how fast it animates. It
	// is also normalised by the plume's own height — a tall plume covers
	// more screen distance per row, so without this a bigger throw still
	// READ as faster even at a fixed rows/s.
	float ampNorm = ${f(PLUME.ampIdle)} + ${f(PLUME.ampFull - PLUME.ampIdle)} * min(vGale / ${f(PLUME.speedFull)}, 1.0);
	float rise = (uRise.x + vGale * uRise.y) / max(ampNorm, 0.15);
	// Streak cell coordinates. The offset blends a per-sprite random
	// (independent plumes) with a WORLD-space anchor (neighbours share
	// the pattern and merge) — coherence picks the mix.
	vec2 offRandom = vec2(vSeed * 17.0, vSeed * 9.0);
	vec2 offWorld = vAnchor * ${f(PLUME.coherenceScale)};
	vec2 off = mix(offRandom, offWorld, ${f(PLUME.coherence)});
	float n = hash(vec2(
		floor(x * (${f(PLUME.wispFreq)} + vGale * ${f(PLUME.tatterFreq)}) + off.x),
		floor(fh * ${f(PLUME.wispRows)} - uTime * rise + off.y)
	));
	float wisp = smoothstep(${f(PLUME.wispCut)} + min(vGale * ${f(PLUME.tatterThresh)}, ${f(PLUME.tatterThreshCap)}), ${f(PLUME.wispCutEnd)}, n * (1.0 - h * 0.55) + body * ${f(PLUME.bodyBias)});
	// AMPLITUDE (reach and density) rises with the sprite's own SPEED:
	// momentum throws the spray, so the fastest foam sprays most.
	float amp = ampNorm;
	// The burst envelope drives BOTH density and reach. The tip FADES
	// rather than clipping — a hard cut was very visible at low rise and
	// heavy lean, where the streaks meet the cap edge-on.
	// The CUT: the burst envelope times clipFrac. Shrinking clipFrac
	// crops a tall plume rather than shrinking it, so what remains is
	// the broad lower body instead of a whole compressed cone.
	float reach = vBurst * amp * ${CLIP};
	float tip = smoothstep(reach, reach * (1.0 - ${f(PLUME.tipFade)}), h);
	if (tip <= 0.0) discard;
	// Dissolve at the sprite quad's border — WIDE, because a leaning or
	// widening plume genuinely runs out of quad, and a narrow fade just
	// makes the cut slightly softer instead of hiding it. Squared so the
	// falloff is gentle for most of the margin and only bites at the rim.
	float edgeD = min(min(pc.x, 1.0 - pc.x), pc.y) / max(${f(PLUME.edgeFade)}, 0.0001);
	float edge = clamp(edgeD, 0.0, 1.0);
	edge *= edge;
	float a = wisp * body * (1.0 - h) * (1.0 - h) * ${f(PLUME.alpha)} * vBurst * amp * tip * edge;
	if (a < ${f(PLUME.alphaCull)}) discard;
	// Spray is a 2D sprite with no meaningful normal, so it takes the
	// sky/sun COLOUR with no directional relief — airborne droplets are
	// lit from every side anyway.
	vec3 lit = whitewaterLight(uColor, vec3(0.0, 1.0, 0.0), 0.0);
	float fog = clamp(1.0 - exp(-uFogDensity * uFogDensity * vViewZ * vViewZ), 0.0, 1.0);
	gl_FragColor = vec4(mix(lit, uFogColor, fog), a);
}`
}
