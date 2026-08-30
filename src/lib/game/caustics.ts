/**
 * Forward-splat caustic map: the pool reference's differential-area method,
 * adapted to our scene.
 *
 * A grid of vertices rides the water surface. Each vertex refracts the sun
 * ray through the local surface normal (true Snell), then projects the
 * refracted ray onto a fixed reference plane — the map is BEAM-SPACE, as
 * in the reference, not a top-down landing map. Receivers sample it by
 * sliding their own position along the refracted sun direction to the
 * same plane, so every point at every depth lies on exactly one beam and
 * reads that beam's intensity. (An earlier version intersected the sphere
 * in the splat and indexed by landing xz; a top-down projection has zero
 * texel density at the silhouette, so caustics starved below the sphere's
 * upper third and the silhouette ring was pure noise.) The fragment
 * shader computes brightness as oldArea / newArea from screen
 * derivatives, and additive blending stacks fold contributions correctly
 * (several surface patches lighting the same spot genuinely sum).
 *
 * What falls out:
 *  - Band-limited output: the pattern cannot exceed grid + map resolution,
 *    so the analytic-sampling speckle is structurally impossible.
 *  - Crown shadow: entry points inside an exposed crown are not water;
 *    their beams splat with zero weight, which IS the crown's shadow in
 *    beam space. Self-shadowing of receivers is the receiver cosine's
 *    job (dot(normal, -refractedLight)), exactly as in the reference.
 *  - The trade: brightness is evaluated at the reference plane's depth
 *    for all receivers (the reference accepts the same approximation);
 *    depth-true convergence went out with the landing map.
 *
 * The splat refracts through the TRUE surface: the ambient Gerstner bands
 * (band-limited by the grid, so no analytic-sampling speckle) plus the
 * interactive ripple field. Capillaries stay out for now. Rays originate
 * on the displaced surface, so a receiver poking above a trough sits above
 * every ray origin and correctly receives no caustics.
 *
 * Future receivers (fish) upgrade the analytic intersection to a top-down
 * receiver depth pre-pass; the splat machinery is unchanged.
 */

import * as THREE from 'three'
import { RIPPLE_EXTENT } from './ripples'
import { sdfAtlasGlsl } from './sdf'
import { CAUSTICS, PROFILE, UNDERWATER } from './tuning'
import { waves, wavesGlsl, waveUniformA, waveUniformB } from './waves'

/**
 * The caustic domain covers the VIEW, not the ripple domain: light only
 * needs computing where the eye can see it. The view's footprint depends
 * on the window, so the extent is sized at load — a fixed 80m left big
 * windows sampling beyond the map at the top and corners, which read as
 * the seabed's caustics ending mid-screen. Resolution steps up with the
 * extent to hold the texel near 4cm. (Sized once: a resize to a LARGER
 * window needs a reload to regain full coverage.)
 */
const viewHalfAxis = (() => {
  if (typeof window === 'undefined') return 30
  // Mirrors Scene's screen->world footprint factors (0.71/1.34) and its
  // mobile/zoom split; caustics can't import Scene (cycle).
  const zoom = window.innerWidth < 720 ? 18 : 26
  return (
    0.71 * (window.innerWidth / zoom / 2) +
    1.34 * (window.innerHeight / zoom / 2)
  )
})()
/**
 * BASE extent: covers the view with the seabed at the caustic plane's own
 * depth. The LIVE extent (CausticMap.extent) grows past this when a deep
 * seabed pushes the sampled rect further — refraction lands floor pixels
 * up-screen of their surface point and deep receivers walk sunward to the
 * beam plane, both in proportion to depth. Texels coarsen as it grows,
 * which is the physically graceful trade: the deep floor that demands the
 * reach is exactly the one whose pattern is blurred anyway.
 */
export const CAUSTIC_EXTENT = Math.max(80, Math.ceil(2 * (viewHalfAxis + 16)))
/**
 * Floor for the LIVE extent. Deliberately NOT CAUSTIC_EXTENT: that is
 * baked from window.innerWidth/innerHeight at module load, so using it as
 * the floor meant a window that later SHRANK kept paying for the domain
 * the old one needed, and the texels stayed coarse for the rest of the
 * session with no way back. Scene recomputes the exact footprint from the
 * live camera quad every frame, so the floor only needs to be a sanity
 * bound.
 */
export const CAUSTIC_MIN_EXTENT = 80
export const CAUSTIC_RESOLUTION =
  typeof window !== 'undefined' && window.innerWidth < 720 ? 2048 : PROFILE.causticMapRes
/**
 * ACTIVE-TILE splatting: the domain divides into TILES x TILES tiles and
 * only tiles over the receivers (the sphere, later fish) are splatted each
 * frame; the rest of the map stays at its black clear. A full-domain grid
 * at useful ray density (~one per ripple cell) costs ~640k vertices, far
 * past this GPU's ~200k/frame budget; receiver culling spends the
 * vertices only where landed light is actually visible.
 */
// Fixed tile GRID: tileSize = extent / TILES scales with the live
// extent, and ray spacing (tileSize / TILE_GRID) scales with it — the
// spacing-to-texel ratio stays constant, so splat density per texel is
// depth-independent.
const TILES = 20
/**
 * Rays per tile side, holding PROFILE.causticRaySpacingM of ray spacing
 * — 0.104m is the density the pattern was tuned at (the dynamic
 * window-sized extent once grew the tiles under a fixed 48-ray grid, and
 * the coarser lattice was a visible regression).
 *
 * The 48-a-side floor exists for SMALL WINDOWS, where the target works
 * out finer than 48 and 48 is the density the look was approved at. It
 * SCALES with the knob: pinning it at 48 would have swallowed the top
 * half of the slider's range whole, and a floor that ignores the dial
 * driving it is not a floor, it is a bug with a comment.
 */
const RAY_SPACING_M = Math.max(PROFILE.causticRaySpacingM, 0.01)
const TILE_GRID = Math.min(
  Math.max(
    Math.round(CAUSTIC_EXTENT / TILES / RAY_SPACING_M),
    Math.max(Math.round((48 * 0.104) / RAY_SPACING_M), 6),
  ),
  96,
)
/** Vertex budget: cap on simultaneously active tiles (~140k verts). */
// Budget for the splat region. A LOW sun needs many more tiles: entry
// points sit sunward of the landing point by depth * tan(zenith), so the
// region grows fast as the sun sinks. At 60 the budget ran out around
// 15 degrees elevation and tiles were dropped in scan order — which
// showed as caustics vanishing from one quarter of a receiver, then the
// next, as the cut-off band swept across.
// Raised from 160 with the view-shaped marking below: the padded view
// rect on a large window wants ~200+ tiles, and the centre-out priority
// means an overrun clips the least-visible corners instead of sweeping
// bands off a receiver.
const MAX_TILES = 1024
const IOR = (1 / 1.33).toFixed(4)
/**
 * Depth of the beam-space reference plane, meters below rest. Brightness
 * is evaluated here for all receivers; the sphere's center depth is the
 * best single compromise. Receivers must project along the refracted sun
 * to THIS plane when sampling the map.
 */
export const CAUSTIC_PLANE_DEPTH = 6

// ---- Occluder tests for the shadow pass (fragment stage) ----
const occluderGlsl = `
uniform vec3 uSunDir;
uniform vec3 uSphereCenter;
uniform float uSphereRadius;
${sdfAtlasGlsl}

// ---- Cast-shadow visibility, IN THE MAP (the reference's system) ----
// The pool reference bakes its sphere shadow into a second channel of
// the caustic texture, computed against the same refracted rays as the
// pattern — receivers then CHOOSE channels (walls read pattern x
// shadow, the sphere reads pattern only, which is how it never shades
// itself). Same here, one channel further: vVisAll carries every
// occluder (the seabed's channel), vVisFloat only the surface floaters
// — hull and buoys — so submerged bodies read a channel their own
// silhouettes never touched. Because the splat is ADDITIVE, visibility
// cannot be written directly; each ray adds brightness x vis, making
// the shadowed channels true shadowed LIGHT fields under the same
// normalisation as the clean one.
uniform mat4 uBoatInv;
uniform mat4 uBuoyInv[3];
// Must match Scene.svelte's water shader.
const vec3 BUOY_HALF = vec3(0.5, 0.9, 0.5);
const float BUOY_R = 0.5;
uniform vec4 uCardRect; // rainbow card: cx, cz, hx, hz
uniform float uCardY;
uniform float uCardOn;
uniform vec3 uWhaleC;
uniform float uWhaleOn;
// Must match Scene.svelte's water shader: the test whale's semi-axes.
#define WHALE_AX vec3(6.0, 1.6, 2.2)
// Hull submergence 0-1: fades the hull OUT of the floater channel (B)
// as the water shader's analytic leg fades it in — the submerged-boat
// reclassification cross-fade. The seabed channel (G) keeps the hull
// at any depth: the floor is below everything, so the map's
// depth-blindness cannot hurt it.
uniform float uBoatSub;
// World y of the seabed (-1e5 when it's off): occlusion on the
// refracted leg stops HERE, not at the reference plane. The map is
// evaluated at the plane's depth, but light that already landed on a
// shallower seabed cannot be blocked below it — a sphere buried in a
// shallow floor kept casting from its underground half, and the extra
// shadow sat displaced down-sun of the visible body.
uniform float uSeabedY;

// Hull on the sun line through the entry point: the hull straddles the
// waterline, so one line covers topsides and draft (the bend over its
// ~1m span is centimetres). Soft SDF visibility, never a binary kill —
// the old crown shadow's radial spokes came from a binary one; here the
// jittered temporal accumulation integrates the soft edge further.
float boatShadowVis(vec3 P, vec3 dirW) {
	vec3 o = (uBoatInv * vec4(P, 1.0)).xyz;
	vec3 d = normalize((uBoatInv * vec4(dirW, 0.0)).xyz);
	vec3 invD = 1.0 / d;
	vec3 s0 = (uBoatSdfMin - o) * invD;
	vec3 s1 = (uBoatSdfMin + uBoatSdfSize - o) * invD;
	vec3 tmin3 = min(s0, s1);
	vec3 tmax3 = max(s0, s1);
	float tN = max(max(tmin3.x, tmin3.y), tmin3.z);
	float tF = min(min(tmax3.x, tmax3.y), tmax3.z);
	// Line test, unclamped: negative t is the above-water leg toward
	// the sun and must not be rejected.
	if (tN > tF) return 1.0;
	float minD = 1e9;
	for (int i = 0; i < 12; i++) {
		float t = mix(tN, tF, (float(i) + 0.5) / 12.0);
		minD = min(minD, boatSdfAt(o + d * t));
	}
	return smoothstep(0.0, 0.12, minD);
}

// A buoy on the sun line: analytic CYLINDER, arithmetic only.
//
// Was a box, which cast a square shadow from a round float — and unlike
// the silhouette, a shadow is read flat on the seabed where corners are
// obvious. Nearest-distance along the ray, same as before; only the
// distance function changed.
float buoyShadowVis(mat4 inv, vec3 P, vec3 dirW) {
	vec3 o = (inv * vec4(P, 1.0)).xyz;
	vec3 d = normalize((inv * vec4(dirW, 0.0)).xyz);
	// Bound the march by the barrel's slab plus the caps, so the samples
	// land where the buoy actually is.
	float a = dot(d.xz, d.xz);
	float tN = 0.0;
	float tF = 0.0;
	if (a > 1e-8) {
		float b = dot(o.xz, d.xz);
		float c = dot(o.xz, o.xz) - BUOY_R * BUOY_R;
		float disc = b * b - a * c;
		if (disc <= 0.0) return 1.0;
		float sq = sqrt(disc);
		tN = (-b - sq) / a;
		tF = (-b + sq) / a;
	} else {
		if (dot(o.xz, o.xz) > BUOY_R * BUOY_R) return 1.0;
		tN = -1e4;
		tF = 1e4;
	}
	if (abs(d.y) > 1e-8) {
		float c0 = (-BUOY_HALF.y - o.y) / d.y;
		float c1 = (BUOY_HALF.y - o.y) / d.y;
		tN = max(tN, min(c0, c1));
		tF = min(tF, max(c0, c1));
	} else if (abs(o.y) > BUOY_HALF.y) {
		return 1.0;
	}
	if (tN > tF) return 1.0;
	float minD = 1e9;
	for (int i = 0; i < 8; i++) {
		vec3 p = o + d * mix(tN, tF, (float(i) + 0.5) / 8.0);
		// Cylinder SDF: radial and axial distances combined.
		vec2 q = vec2(length(p.xz) - BUOY_R, abs(p.y) - BUOY_HALF.y);
		minD = min(minD, min(max(q.x, q.y), 0.0) + length(max(q, vec2(0.0))));
	}
	return smoothstep(0.0, 0.06, minD);
}

// The sphere against one ray leg, AHEAD-ONLY (a sphere behind the ray
// origin must not shadow — nearest-distance semantics ringed the
// breaching sphere's waterline on its sun side once before).
float sphereRayVis(vec3 P, vec3 rd, float tMax) {
	float b = dot(uSphereCenter - P, rd);
	if (b <= 0.0) return 1.0;
	float d = length(uSphereCenter - P - rd * min(b, tMax)) - uSphereRadius;
	return smoothstep(0.0, 0.35, d);
}

// The whale: an ellipsoid, tested as a sphere in scaled space (t stays
// a world-metres parameter because only the OFFSETS are scaled).
// Ahead-only like the sphere.
float whaleRayVis(vec3 P, vec3 rd, float tMax) {
	if (uWhaleOn < 0.5) return 1.0;
	vec3 o = (P - uWhaleC) / WHALE_AX;
	vec3 d = rd / WHALE_AX;
	float b = -dot(o, d) / dot(d, d);
	if (b <= 0.0) return 1.0;
	vec3 pc = o + d * min(b, tMax);
	// Scaled-space clearance, converted back to ~metres by the smallest
	// semi-axis (the conservative direction).
	float dist = (length(pc) - 1.0) * 1.6;
	return smoothstep(0.0, 0.35, dist);
}

// The rainbow card: a thin horizontal rect on the refracted leg.
float cardShadowVis(vec3 P, vec3 rd, float tMax) {
	if (uCardOn < 0.5 || rd.y > -0.001) return 1.0;
	float th = (P.y - uCardY) / -rd.y;
	if (th < 0.0 || th > tMax) return 1.0;
	vec2 q = abs(P.xz + rd.xz * th - uCardRect.xy) - uCardRect.zw;
	return smoothstep(0.0, 0.2, max(q.x, q.y));
}

`

const splatVertex = `
uniform sampler2D uRippleTex;
uniform vec2 uCenter;
uniform float uExtent;
uniform vec2 uRippleCenter;
uniform float uRippleExtent;
uniform vec3 uSunDir;
uniform vec3 uSphereCenter;
uniform float uSphereRadius;
uniform float uPlaneDepth;
uniform float uTime;
uniform float uAmp;
uniform float uMaxBright;
uniform vec2 uJitter; // per-frame lattice offset, world metres
varying vec2 vOld;
varying vec2 vNew;

${wavesGlsl()}

// Entry point, refracted direction and travel of the last traced ray.
vec3 gEntry;
vec3 gRefr;
float gLandT;

// ---- SHADOW PASS: hand the ray to the fragment stage, which tests the
// occluders PER TEXEL (per-vertex visibility interpolated across the
// coarse shadow lattice faceted every soft edge). ----
#ifdef SHADOW_PASS
varying vec3 vEntry;
varying vec3 vRefr;
varying float vLandT;
#endif

attribute vec2 aTile; // active tile origin, in tile units

// Trace ONE ray: rest position -> true surface (ambient Gerstner +
// ripples) -> refract -> land on the reference plane.
vec3 causticLand(vec2 sxz) {
	// ONE wave loop for displacement AND tangents: each sin/cos pair is
	// computed once and feeds both (waveDisplacement() ran a second
	// identical loop per vertex — with 1-3M splat vertices a frame, that
	// was tens of millions of transcendentals for nothing).
	vec3 D = vec3(0.0);
	float txx = 0.0;
	float txy = 0.0;
	float txz = 0.0;
	float tzy = 0.0;
	float tzz = 0.0;
	for (int i = 0; i < WAVE_COUNT; i++) {
		vec4 a = uWaveA[i];
		vec3 b = uWaveB[i];
		float theta = (sxz.x * a.x + sxz.y * a.y) * a.z - a.w * uTime + b.z;
		float sn = sin(theta);
		float cs = cos(theta);
		float amp = b.x * uAmp;
		D.x += b.y * amp * a.x * cs;
		D.z += b.y * amp * a.y * cs;
		D.y += amp * sn;
		float qak = b.y * amp * a.z;
		float ak = amp * a.z;
		txx -= qak * a.x * a.x * sn;
		txy += ak * a.x * cs;
		txz -= qak * a.x * a.y * sn;
		tzy += ak * a.y * cs;
		tzz -= qak * a.y * a.y * sn;
	}
	vec3 P = vec3(sxz.x + D.x, D.y, sxz.y + D.z);
	vec3 Tu = vec3(1.0 + txx, txy, txz);
	vec3 Tv = vec3(txz, tzy, 1.0 + tzz);
	vec3 Na = cross(Tv, Tu);
	vec2 slope = -Na.xz / max(Na.y, 0.2);

	// Interactive ripple field rides the displaced surface. Height AND
	// gradient in one fetch (the sim bakes grad into zw). Capillaries
	// stay out of caustics for now.
	vec2 ruv = (P.xz - uRippleCenter) / uRippleExtent + 0.5;
	if (ruv.x > 0.01 && ruv.x < 0.99 && ruv.y > 0.01 && ruv.y < 0.99) {
		vec4 field = texture2D(uRippleTex, ruv);
		P.y += field.x;
		slope += field.zw;
	}

	vec3 normal = normalize(vec3(-slope.x, 1.0, -slope.y));
	vec3 incident = -normalize(uSunDir);
	vec3 refr = refract(incident, normal, ${IOR});
	if (refr.y > -0.01) refr = vec3(0.0, -1.0, 0.0); // grazing guard

	gEntry = P;
	// Beam-space: EVERY ray projects to the reference plane; no receiver
	// intersection here. Occlusion never touches R — it lands in G/B as
	// brightness x visibility (see the channel note above), so a body
	// sampling the clean channel still reads its own light while the
	// channels below it carry its shadow.
	float t = max((P.y + uPlaneDepth) / max(-refr.y, 0.05), 0.0);
	gRefr = refr;
	gLandT = t;
	return P + refr * t;
}

void main() {
	vec2 domainUv = (aTile + uv) / ${TILES}.0;
	vec2 sxz = (domainUv - 0.5) * uExtent + uCenter + uJitter;
	// One ray, flat per-triangle brightness from the fragment stage's
	// derivatives. Under temporal accumulation this is the winning
	// estimator: geometrically honest per frame, integrated over jittered
	// lattices. (The per-vertex-interpolated and photon variants were
	// tried and retired.)
	vec3 land = causticLand(sxz);
	vOld = sxz;
	vNew = land.xz;
#ifdef SHADOW_PASS
	vEntry = gEntry;
	vRefr = gRefr;
	vLandT = gLandT;
#endif
	vec2 ndc = ((land.xz - uCenter) / uExtent) * 2.0;
	gl_Position = vec4(ndc, 0.0, 1.0);
}`

// ---- Sun-diffusion blur ----
// A clouded sun is an EXTENDED source, and every surface lens images the
// source: the caustic pattern is the point-source pattern convolved with
// the source's angular size projected through the water. So diffusion is
// literally a Gaussian blur of the map (radius = angular spread x
// reference-plane depth). A blur conserves energy: folds sink toward the
// local mean (~1), the crown shadow grows a penumbra, and the receivers'
// max(light - 1, 0) term dies out on its own — no receiver logic changes.
// Separable 13-tap kernel at half-sigma spacing, run over the active
// region only.

const blurVertex = `
uniform vec4 uRegion; // xy = NDC center, zw = NDC half-size
varying vec2 vUv;
void main() {
	vec2 p = position.xy * uRegion.zw + uRegion.xy;
	vUv = p * 0.5 + 0.5;
	gl_Position = vec4(p, 0.0, 1.0);
}`

const blurFragment = `
uniform sampler2D uSrc;
uniform vec2 uStep; // half-sigma tap spacing in uv, along the blur axis
varying vec2 vUv;
void main() {
	vec4 acc = texture2D(uSrc, vUv) * 0.1997;
	acc += (texture2D(uSrc, vUv + uStep) + texture2D(uSrc, vUv - uStep)) * 0.1762;
	acc += (texture2D(uSrc, vUv + 2.0 * uStep) + texture2D(uSrc, vUv - 2.0 * uStep)) * 0.1211;
	acc += (texture2D(uSrc, vUv + 3.0 * uStep) + texture2D(uSrc, vUv - 3.0 * uStep)) * 0.0648;
	acc += (texture2D(uSrc, vUv + 4.0 * uStep) + texture2D(uSrc, vUv - 4.0 * uStep)) * 0.0270;
	acc += (texture2D(uSrc, vUv + 5.0 * uStep) + texture2D(uSrc, vUv - 5.0 * uStep)) * 0.0088;
	acc += (texture2D(uSrc, vUv + 6.0 * uStep) + texture2D(uSrc, vUv - 6.0 * uStep)) * 0.0022;
	gl_FragColor = acc;
}`

const splatFragment = `
uniform float uMaxBright;
varying vec2 vOld;
varying vec2 vNew;
#ifdef SHADOW_PASS
varying vec3 vEntry;
varying vec3 vRefr;
varying float vLandT;
${occluderGlsl}
#endif

void main() {
	// Differential-area brightness from screen-space derivatives —
	// constant per warped triangle. True parallelogram areas (the 2D
	// cross), not length x length: the axis-product overestimates
	// sheared patches and speckles fold filaments.
	vec2 ox = dFdx(vOld);
	vec2 oy = dFdy(vOld);
	vec2 nx = dFdx(vNew);
	vec2 ny = dFdy(vNew);
	float oldArea = abs(ox.x * oy.y - ox.y * oy.x);
	float newArea = abs(nx.x * ny.y - nx.y * ny.x);
	float b = clamp(oldArea / max(newArea, 1e-7), 0.0, uMaxBright);
	// R clean, G shadowed by everything (seabed), B shadowed by the
	// floaters (generic objects), A shadowed by the buoys alone (the
	// hull — a floater reading a channel containing itself darkened its
	// whole wet body; underwater casters reach objects analytically).
	// One normalisation (R's mean) serves all four, so shadow is
	// honestly missing light, never a repaint. ALPHA IS DATA from here
	// on: every downstream pass must carry vec4 with NoBlending, and
	// the splat clear must zero alpha.
#ifdef SHADOW_PASS
	// Surface floaters block the SUN line through the entry point;
	// submerged bodies block the REFRACTED leg. The sphere tests both
	// legs (it can be dialed from seabed to airborne), min-combined so
	// a breaching sphere doesn't double-darken where the legs overlap.
	vec3 inc = -normalize(uSunDir);
	float hullV = boatShadowVis(vEntry, inc);
	float buoyV = 1.0;
	for (int i = 0; i < 3; i++) buoyV *= buoyShadowVis(uBuoyInv[i], vEntry, inc);
	// The refracted leg is truncated at the SEABED (see uSeabedY) — and
	// only there. It was once also min'd with the travel to the 6m
	// reference plane, which silently erased every caster below 6m: a
	// whale at 8m over a 12m floor cast nothing. The map is EVALUATED at
	// the plane, but its occlusion must cover the full column its one
	// real reader (the seabed) sits under.
	float tOcc = (vEntry.y - uSeabedY) / max(-normalize(vRefr).y, 0.05);
	float deepV = min(sphereRayVis(vEntry, -inc, 1e5), sphereRayVis(vEntry, normalize(vRefr), tOcc))
		* cardShadowVis(vEntry, normalize(vRefr), tOcc)
		* whaleRayVis(vEntry, normalize(vRefr), tOcc);
	// Channel roles: G (everything) is the seabed's; B (floaters) is the
	// generic object channel; A (buoys only) is the hull's. Underwater
	// casters are DELIBERATELY absent from B and A — object receivers
	// get them from the analytic leg (uwObjectShadow, Scene), which is
	// depth-correct per receiver where the map cannot be, and putting
	// them here too would double-shadow.
	float vAll = hullV * buoyV * deepV;
	float vFloat = mix(hullV, 1.0, uBoatSub) * buoyV;
	float vNoHull = buoyV;
	gl_FragColor = vec4(b, b * vAll, b * vFloat, b * vNoHull);
#else
	gl_FragColor = vec4(b, 0.0, 0.0, 1.0);
#endif
}`

/** Low-discrepancy sequence for the splat jitter — deterministic, so the
 * screenshot harness reproduces frame-for-frame (never Math.random). */
function halton(i: number, base: number): number {
  let f = 1
  let r = 0
  while (i > 0) {
    f /= base
    r += f * (i % base)
    i = Math.floor(i / base)
  }
  return r
}

// ---- Temporal accumulation ----
// The fresh splat blends UNDER the scrolled history: with the lattice
// jittered per frame, this integrates the fold-overlap wedge noise away
// (Monte Carlo over lattice phases — the fold singularity is integrable,
// so the average converges to the true finite brightness).
const accumFragment = `
uniform sampler2D uHist;
uniform sampler2D uCur;
uniform float uAlpha;
uniform vec2 uScroll;
uniform float uHistScale;
uniform float uTexelT;
uniform float uClipSigma;
varying vec2 vUv;
void main() {
	// HISTORY REMAP. A world point p sits at u = (p - c)/E + 0.5 this
	// frame and u' = (p - c')/E' + 0.5 in the history, so
	//   u' = (u - 0.5) * (E/E') + (c - c')/E' + 0.5
	// The scale term used to be missing, which is why a changed extent
	// had to throw the whole history away and show one raw jittered
	// frame — the flicker that only appeared while driving, because
	// driving is what moves the extent.
	vec2 huv = (vUv - 0.5) * uHistScale + uScroll + 0.5;
	float inH =
		huv.x > 0.0 && huv.x < 1.0 && huv.y > 0.0 && huv.y < 1.0 ? 1.0 : 0.0;
	vec4 h = texture2D(uHist, huv);
	vec4 c = texture2D(uCur, vUv);
	// NEIGHBOURHOOD CLAMP: waves move the pattern through the domain, and
	// unclamped history dragged bright filaments into decaying trails
	// ("trailing glitter"). Clamp the history into the current frame's
	// local brightness range (plus a pad for the jitter's own variance):
	// stale-bright history over now-dark water is rejected within a
	// frame, while history inside the local range keeps integrating the
	// lattice noise. Per channel — the shadowed fields (alpha included)
	// integrate, and their edges wobble, exactly like the clean one.
	vec4 cl = texture2D(uCur, vUv - vec2(uTexelT, 0.0));
	vec4 cr = texture2D(uCur, vUv + vec2(uTexelT, 0.0));
	vec4 cd = texture2D(uCur, vUv - vec2(0.0, uTexelT));
	vec4 cu = texture2D(uCur, vUv + vec2(0.0, uTexelT));
	vec4 lo;
	vec4 hi;
	if (uClipSigma > 0.0) {
		// VARIANCE CLIPPING (CAUSTICS.clipSigma). The min/max box below is
		// decided by the two most extreme taps, and near a caustic FOLD
		// one tap is exactly where the estimator's heavy tail lives — a
		// single outlier throws the window open and the history follows
		// it out. Fitting a Gaussian to the neighbourhood and clipping to
		// mean +/- k*sigma weights every tap instead, so one wild sample
		// widens the window a little rather than setting it outright.
		vec4 m1 = (c + cl + cr + cd + cu) * 0.2;
		vec4 m2 = (c * c + cl * cl + cr * cr + cd * cd + cu * cu) * 0.2;
		vec4 sd = sqrt(max(m2 - m1 * m1, vec4(0.0)));
		lo = m1 - uClipSigma * sd;
		hi = m1 + uClipSigma * sd;
	} else {
		vec4 mn = min(c, min(min(cl, cr), min(cd, cu)));
		vec4 mx = max(c, max(max(cl, cr), max(cd, cu)));
		vec4 pad = 0.35 * (mx - mn) + 0.05;
		lo = mn - pad;
		hi = mx + pad;
	}
	vec4 hc = clamp(h, lo, hi);
	gl_FragColor = mix(c, hc, uAlpha * inH);
}`

// ---- Edge-directed antialias ----
// The map's aliasing is the staircase along filament borders: warped
// splat triangles rasterize their edges in one-texel steps. FXAA-style
// repair, specialized for a single-channel HDR map: measure the local
// gradient, and blend ONLY along the isoline (perpendicular to the
// gradient). Nothing crosses an edge, so the filament's width and peak
// survive exactly; flat regions fail the edge test and pass through
// untouched. Not a blur in any direction that matters.
const edgeAAFragment = `
uniform sampler2D uSrc;
uniform float uTexelAA;
uniform float uAA;
varying vec2 vUv;
void main() {
	vec4 c = texture2D(uSrc, vUv);
	vec4 l = texture2D(uSrc, vUv - vec2(uTexelAA, 0.0));
	vec4 r = texture2D(uSrc, vUv + vec2(uTexelAA, 0.0));
	vec4 d = texture2D(uSrc, vUv - vec2(0.0, uTexelAA));
	vec4 u = texture2D(uSrc, vUv + vec2(0.0, uTexelAA));
	// Edge detection on the CLEAN channel; the blend applies to all
	// four (the shadowed fields share the clean field's filament
	// structure, so its isolines are theirs).
	vec2 g = vec2(r.r - l.r, u.r - d.r);
	float gm = length(g);
	// Scale-invariant edge metric: gradient against local level, so a
	// dim filament's border counts as much as a bright one's.
	float level = 0.25 * (l.r + r.r + d.r + u.r) + 0.5;
	float w = uAA * smoothstep(0.0005, 0.025, gm / level);
	if (w < 0.001) {
		gl_FragColor = c;
		return;
	}
	vec2 t = vec2(-g.y, g.x) * (uTexelAA / max(gm, 1e-6));
	vec4 a = texture2D(uSrc, vUv + t);
	vec4 b = texture2D(uSrc, vUv - t);
	gl_FragColor = mix(c, (c + a + b) / 3.0, w);
}`

// ONE-TAP COPY. The chain's "identity copies" (accumulated history back
// to the canonical map, edge-AA result back to it) went through the
// 13-tap blur kernel at step 0 — thirteen full-res RGBA16F fetches per
// texel, ~1GB of reads a frame at 3072^2, to move data unchanged. This
// is the honest move.
const copyFragment = `
uniform sampler2D uSrc;
varying vec2 vUv;
void main() {
	gl_FragColor = texture2D(uSrc, vUv);
}`

export class CausticMap {
  /**
   * SOURCE BLUR of the caustic pattern, metres of Gaussian sigma at the
   * map. Was derived from the weather's sun diffusion — physically an
   * overcast sun is an extended source and does blur its caustics — but
   * in practice the coupling cost the fine filaments at even modest
   * weather (past ~0.2m sigma the blur drops the whole map to quarter
   * resolution), so it is now its OWN dial, fed from
   * UNDERWATER.causticSourceBlurM. Weather keeps its other caustic
   * effect (the uCausticFlat wash toward featureless light).
   */
  sourceBlurM = 0

  private target: THREE.WebGLRenderTarget
  private histA: THREE.WebGLRenderTarget
  private histB: THREE.WebGLRenderTarget
  private accumMaterial: THREE.ShaderMaterial
  private accumScene: THREE.Scene
  private histSeeded = false
  private prevCenter = new THREE.Vector2()
  private prevExtent = 0
  private prevGrid = 0
  private frameIdx = 0
  private aaTarget: THREE.WebGLRenderTarget
  private aaMaterial: THREE.ShaderMaterial
  /**
   * THE SPLAT SPLIT. The pattern needs resolution (Tom judges 3072-4096
   * by eye for focused filaments); the shadow fields are soft and need
   * none of it — yet carrying them in the pattern map made every
   * full-res pass an 8-byte-per-texel RGBA walk. So the same rays splat
   * TWICE: the pattern into the R16F chain at full resolution (accum,
   * AA, pyramids), and the shadow channels into this half-res RGBA map
   * from a second material (SHADOW_PASS define) on a coarser lattice.
   * Receivers take shadow as the ratio sum(b*vis)/sum(b) of THIS map's
   * own channels — the same rays, so lattice noise cancels in the ratio
   * and the shadow map needs no accumulation and no AA of its own; one
   * blurred level gives it depth diffusion.
   */
  private shadowMaterial: THREE.ShaderMaterial
  private shadowGeometry: THREE.InstancedBufferGeometry
  private shadowScene: THREE.Scene
  private shadowTarget: THREE.WebGLRenderTarget
  // The shadow map's own defocus pyramid — the same rungs as the
  // pattern's (L1 ~0.5m, L2 ~2m), blended by the same t1/t2. Two rungs
  // are not optional: with only sharp + 2m mixed by t2, nothing
  // softened until 0.5m of spread and beyond it a crisp edge sat inside
  // a soft halo — read as "never blurs with depth".
  private shadowL1: THREE.WebGLRenderTarget
  private shadowL2: THREE.WebGLRenderTarget
  private shadowScratch: THREE.WebGLRenderTarget
  /** Shadow chain's own AA target + history pair, mirroring the pattern's. */
  private shadowAA: THREE.WebGLRenderTarget
  private shadowHistA: THREE.WebGLRenderTarget
  private shadowHistB: THREE.WebGLRenderTarget
  private shadowCanon!: THREE.WebGLRenderTarget
  private shadowGrid = 48
  private shadowHistSeeded = false
  private shadowPrevCenter = new THREE.Vector2()
  private shadowPrevExtent = 0
  private shadowPrevGrid = 0
  private copyMaterial: THREE.ShaderMaterial
  private copyScene: THREE.Scene
  /**
   * The CANONICAL map: whichever target holds the latest stage's result.
   * Each pass reads canon and writes its own target, then becomes canon
   * — no copy-backs. (Two full-res copies a frame were ~a quarter of
   * the map generator's cost; the map is 3072^2 RGBA16F, so every pass
   * over it is a 75MB write and 8 bytes per fetch.)
   */
  private canon!: THREE.WebGLRenderTarget
  /** Splat-box region (tile box + one tile margin) in NDC: centre xy,
   *  half-size zw. Everything splatted lies inside it, so a cleared
   *  target plus a region draw is a COMPLETE result. */
  private region = new THREE.Vector4(0, 0, 1, 1)
  private blurTarget: THREE.WebGLRenderTarget
  private blurQuarterA: THREE.WebGLRenderTarget
  private blurQuarterB: THREE.WebGLRenderTarget
  private pyr1: THREE.WebGLRenderTarget
  private pyr2: THREE.WebGLRenderTarget
  private pyrScratch: THREE.WebGLRenderTarget
  private material: THREE.ShaderMaterial
  private blurMaterial: THREE.ShaderMaterial
  private tileAttr: THREE.InstancedBufferAttribute
  private splatGeometry: THREE.InstancedBufferGeometry
  private splatMesh!: THREE.Mesh
  private tileGrid = 48
  private splatScene: THREE.Scene

  /** One ray lattice tile; rebuilt live when raySpacingM moves. */
  private buildSplatGeometry(grid: number): THREE.InstancedBufferGeometry {
    const base = new THREE.PlaneGeometry(1, 1, grid, grid)
    const geo = new THREE.InstancedBufferGeometry()
    geo.index = base.index
    geo.setAttribute('position', base.getAttribute('position'))
    geo.setAttribute('uv', base.getAttribute('uv'))
    geo.setAttribute('aTile', this.tileAttr)
    geo.instanceCount = 0
    return geo
  }
  private blurScene: THREE.Scene
  private aaScene: THREE.Scene
  private splatCamera: THREE.OrthographicCamera
  private clearColor = new THREE.Color(0, 0, 0)
  private savedClearColor = new THREE.Color()

  constructor() {
    this.target = new THREE.WebGLRenderTarget(
      CAUSTIC_RESOLUTION,
      CAUSTIC_RESOLUTION,
      {
        type: THREE.HalfFloatType,
        // Single channel again: the shadow fields live in their own
        // half-res map (see the splat split note), so this whole chain
        // moves 2-byte texels.
        format: THREE.RedFormat,
        // No mip chain: depth softening now comes from an explicit blur
        // pyramid (below) — driver mipmap generation on half-float
        // targets silently no-ops on some renderers, and regenerating
        // 2048^2 mips per frame was real cost for a maybe.
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: false,
        stencilBuffer: false,
      },
    )

    this.canon = this.target

    // One aTile instance attribute shared by both passes: which tiles are
    // active this frame.
    this.tileAttr = new THREE.InstancedBufferAttribute(
      new Float32Array(MAX_TILES * 2),
      2,
    )
    this.tileAttr.setUsage(THREE.DynamicDrawUsage)

    this.tileGrid = TILE_GRID
    this.splatGeometry = this.buildSplatGeometry(this.tileGrid)

    // ONE uniforms object for both splat materials: every per-frame
    // setter reaches the shadow pass for free.
    const splatUniforms = {
        uRippleTex: { value: null },
        uCenter: { value: new THREE.Vector2(0, 0) },
        uExtent: { value: CAUSTIC_EXTENT },
        uRippleCenter: { value: new THREE.Vector2(0, 0) },
        uRippleExtent: { value: RIPPLE_EXTENT },
        uSunDir: { value: new THREE.Vector3(0.4, 1, 0.3) },
        uSphereCenter: { value: new THREE.Vector3(3, -6, 2) },
        uSphereRadius: { value: 5 },
        uMaxBright: { value: 30 },
        uJitter: { value: new THREE.Vector2(0, 0) },
        uPlaneDepth: { value: CAUSTIC_PLANE_DEPTH },
        // Occluders for the shadow channels — wired by setOccluders once
        // the hull SDF bakes (until then the SDF box is degenerate at the
        // origin with no texture, and G/B just track R). The sphere
        // shares uSphereCenter/uSphereRadius above.
        uBoatInv: { value: new THREE.Matrix4() },
        uBoatSdf: { value: null as THREE.Texture | null },
        uBoatSdfMin: { value: new THREE.Vector3() },
        uBoatSdfSize: { value: new THREE.Vector3(0, 0, 0) },
        uBuoyInv: { value: [new THREE.Matrix4(), new THREE.Matrix4(), new THREE.Matrix4()] },
        uCardRect: { value: new THREE.Vector4(14, 2, 5, 2.5) },
        uCardY: { value: -6 },
        uCardOn: { value: 0 },
        uWhaleC: { value: new THREE.Vector3(0, -1e5, 0) },
        uWhaleOn: { value: 0 },
        uBoatSub: { value: 0 },
        uSeabedY: { value: -1e5 },
        uTime: { value: 0 },
        uAmp: { value: 1 },
        // Shared with every other wave material; see waveUniformA.
        uWaveA: { value: waveUniformA },
        uWaveB: { value: waveUniformB },
    }
    this.material = new THREE.ShaderMaterial({
      uniforms: splatUniforms,
      vertexShader: splatVertex,
      fragmentShader: splatFragment,
      // EXPLICIT One/One addition. THREE.AdditiveBlending is
      // src*SrcAlpha + dst — invisible while alpha was a constant 1.0,
      // but the moment alpha became the no-hull shadow field it scaled
      // every splat by it: all four channels went dark exactly where
      // the sphere blocks, which is where the sphere's and card's own
      // lookups land — they lost their caustics entirely.
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneFactor,
      depthTest: false,
      depthWrite: false,
      // Folded triangles invert their winding; both faces must splat.
      side: THREE.DoubleSide,
    })
    this.shadowMaterial = new THREE.ShaderMaterial({
      uniforms: splatUniforms,
      defines: { SHADOW_PASS: '' },
      vertexShader: splatVertex,
      fragmentShader: splatFragment,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneFactor,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
    // Coarser lattice: the splat is TRIANGLES, so coverage stays complete
    // at any grid; a coarser one only makes visibility vary linearly over
    // bigger patches, which soft shadow fields don't mind. Quarter the
    // vertex work of the pattern pass.
    // Its OWN lattice (PROFILE.causticShadowSpacingM), not tileGrid/2:
    // the pattern's density is chosen against temporal accumulation and
    // depth blur, neither of which this pass gets.
    this.shadowGrid = Math.min(
      Math.max(
        Math.round(
          CAUSTIC_EXTENT / TILES / Math.max(PROFILE.causticShadowSpacingM, 0.01),
        ),
        16,
      ),
      48,
    )
    this.shadowGeometry = this.buildSplatGeometry(this.shadowGrid)
    this.shadowScene = new THREE.Scene()
    const shadowMesh = new THREE.Mesh(this.shadowGeometry, this.shadowMaterial)
    shadowMesh.frustumCulled = false
    this.shadowScene.add(shadowMesh)

    this.splatScene = new THREE.Scene()
    this.splatMesh = new THREE.Mesh(this.splatGeometry, this.material)
    const splatMesh = this.splatMesh
    splatMesh.frustumCulled = false
    this.splatScene.add(splatMesh)

    this.splatCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)

    // Ping target + region quad for the separable sun-diffusion blur.
    // HALF resolution: a wide Gaussian has no fine detail to preserve,
    // so bouncing through a half-res intermediate is visually identical
    // at a quarter of the taps (everything addresses normalized UV, so
    // only this allocation changes).
    const blurTargetOpts = {
      type: THREE.HalfFloatType,
      format: THREE.RedFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
    } as const
    const histOpts = {
      type: THREE.HalfFloatType,
      format: THREE.RedFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
    } as const
    this.histA = new THREE.WebGLRenderTarget(
      CAUSTIC_RESOLUTION,
      CAUSTIC_RESOLUTION,
      histOpts,
    )
    this.histB = new THREE.WebGLRenderTarget(
      CAUSTIC_RESOLUTION,
      CAUSTIC_RESOLUTION,
      histOpts,
    )
    this.accumMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uHist: { value: null },
        uCur: { value: null },
        uAlpha: { value: 0 },
        uScroll: { value: new THREE.Vector2(0, 0) },
        uHistScale: { value: 1 },
        uTexelT: { value: 1 / CAUSTIC_RESOLUTION },
        uClipSigma: { value: 0 },
        uRegion: { value: new THREE.Vector4(0, 0, 1, 1) },
      },
      vertexShader: blurVertex,
      fragmentShader: accumFragment,
      // Alpha carries the no-hull shadow field: NormalBlending would
      // read it as coverage and composite garbage.
      blending: THREE.NoBlending,
      depthTest: false,
      depthWrite: false,
    })
    this.accumScene = new THREE.Scene()
    const accumMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      this.accumMaterial,
    )
    accumMesh.frustumCulled = false
    this.accumScene.add(accumMesh)

    this.aaTarget = new THREE.WebGLRenderTarget(
      CAUSTIC_RESOLUTION,
      CAUSTIC_RESOLUTION,
      {
        type: THREE.HalfFloatType,
        format: THREE.RedFormat,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: false,
        stencilBuffer: false,
      },
    )
    this.aaMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uSrc: { value: null },
        uRegion: { value: new THREE.Vector4(0, 0, 1, 1) },
        uTexelAA: { value: 1 / CAUSTIC_RESOLUTION },
        uAA: { value: CAUSTICS.edgeAA },
      },
      vertexShader: blurVertex,
      fragmentShader: edgeAAFragment,
      // Alpha is data (see accumMaterial).
      blending: THREE.NoBlending,
      depthTest: false,
      depthWrite: false,
    })

    // Shadow map: half the pattern resolution, RGBA; plus a blurred
    // level (quarter res) for depth diffusion. Small passes.
    const shadowOpts = {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
    } as const
    this.shadowTarget = new THREE.WebGLRenderTarget(
      CAUSTIC_RESOLUTION / 2,
      CAUSTIC_RESOLUTION / 2,
      shadowOpts,
    )
    const q = CAUSTIC_RESOLUTION / 4
    const sh = CAUSTIC_RESOLUTION / 2
    this.shadowAA = new THREE.WebGLRenderTarget(sh, sh, shadowOpts)
    this.shadowHistA = new THREE.WebGLRenderTarget(sh, sh, shadowOpts)
    this.shadowHistB = new THREE.WebGLRenderTarget(sh, sh, shadowOpts)
    this.shadowCanon = this.shadowTarget
    this.shadowL1 = new THREE.WebGLRenderTarget(q, q, shadowOpts)
    this.shadowL2 = new THREE.WebGLRenderTarget(q, q, shadowOpts)
    this.shadowScratch = new THREE.WebGLRenderTarget(q, q, shadowOpts)
    this.copyMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uSrc: { value: null },
        uRegion: { value: new THREE.Vector4(0, 0, 1, 1) },
      },
      vertexShader: blurVertex,
      fragmentShader: copyFragment,
      blending: THREE.NoBlending,
      depthTest: false,
      depthWrite: false,
    })
    this.copyScene = new THREE.Scene()
    const copyMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      this.copyMaterial,
    )
    copyMesh.frustumCulled = false
    this.copyScene.add(copyMesh)

    this.blurTarget = new THREE.WebGLRenderTarget(
      CAUSTIC_RESOLUTION / 2,
      CAUSTIC_RESOLUTION / 2,
      blurTargetOpts,
    )
    // Quarter-res pair for WIDE blurs: at storm's sigma (~14 texels) the
    // sparse 13-tap kernel sampled full-res filaments every ~7 texels
    // and ALIASED — ghosted filament replicas that read as faceted
    // caustics. Downsampling twice (each a 2x2 box via bilinear)
    // prefilters the source so the same tap spacing is ~1.8 of the
    // quarter-res texels: a genuine smooth spread.
    this.blurQuarterA = new THREE.WebGLRenderTarget(
      CAUSTIC_RESOLUTION / 4,
      CAUSTIC_RESOLUTION / 4,
      blurTargetOpts,
    )
    this.blurQuarterB = new THREE.WebGLRenderTarget(
      CAUSTIC_RESOLUTION / 4,
      CAUSTIC_RESOLUTION / 4,
      blurTargetOpts,
    )
    // DEFOCUS PYRAMID: the map is one plane's convergence, but a receiver
    // past the focal depth sees the beam bundle spread — features grow,
    // peaks dim, energy holds. For a texture that is exactly a Gaussian
    // blur, so the pyramid IS the depth model: L0 sharp (the map itself),
    // L1 ~0.5m kernel, L2 ~2m. Receivers blend by metres of defocus.
    this.pyr1 = new THREE.WebGLRenderTarget(
      CAUSTIC_RESOLUTION / 4,
      CAUSTIC_RESOLUTION / 4,
      blurTargetOpts,
    )
    this.pyr2 = new THREE.WebGLRenderTarget(
      CAUSTIC_RESOLUTION / 8,
      CAUSTIC_RESOLUTION / 8,
      blurTargetOpts,
    )
    this.pyrScratch = new THREE.WebGLRenderTarget(
      CAUSTIC_RESOLUTION / 8,
      CAUSTIC_RESOLUTION / 8,
      blurTargetOpts,
    )
    this.blurMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uSrc: { value: null },
        uStep: { value: new THREE.Vector2(0, 0) },
        uRegion: { value: new THREE.Vector4(0, 0, 1, 1) },
      },
      vertexShader: blurVertex,
      fragmentShader: blurFragment,
      blending: THREE.NoBlending,
      depthTest: false,
      depthWrite: false,
    })
    this.blurScene = new THREE.Scene()
    const blurMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      this.blurMaterial,
    )
    blurMesh.frustumCulled = false
    this.blurScene.add(blurMesh)
    this.aaScene = new THREE.Scene()
    const aaMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      this.aaMaterial,
    )
    aaMesh.frustumCulled = false
    this.aaScene.add(aaMesh)
    const meanOpts = {
      type: THREE.HalfFloatType,
      format: THREE.RedFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: false,
      stencilBuffer: false,
    } as const
    this.meanTarget = new THREE.WebGLRenderTarget(1, 1, meanOpts)
    this.meanTargetB = new THREE.WebGLRenderTarget(1, 1, meanOpts)
    this.meanMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: this.target.texture },
        // splatted rect in the map's uv space: centre xy, half-extent zw
        uRectUv: { value: new THREE.Vector4(0.5, 0.5, 0.4, 0.4) },
        uPrevMean: { value: null },
        uMeanBlend: { value: 1 },
      },
      vertexShader: `
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: `
precision highp float;
uniform sampler2D uMap;
uniform vec4 uRectUv;
uniform sampler2D uPrevMean;
uniform float uMeanBlend;
void main() {
	// 32x32. This is ONE pixel of output, so a thousand fetches is free,
	// and the estimator's variance falls as 1/N — the mean is a sample of
	// a heavy-tailed field (filaments reach maxBright x the mean), so it
	// needs the samples more than most reductions would.
	float acc = 0.0;
	for (int j = 0; j < 32; j++) {
		for (int i = 0; i < 32; i++) {
			vec2 t = (vec2(float(i), float(j)) + 0.5) / 32.0 * 2.0 - 1.0;
			acc += texture2D(uMap, uRectUv.xy + t * uRectUv.zw).r;
		}
	}
	// EMA against last frame's mean: the raw mean of a moving sea swings
	// frame to frame (crests focusing and defocusing heave it, hardest at
	// large waves), and dividing the whole pattern by a jittering scalar
	// FLICKERED every caustic on screen at once. Smoothing converges to
	// the exact value on a static sea, so frozen waves are unchanged.
	float prev = texture2D(uPrevMean, vec2(0.5)).r;
	gl_FragColor = vec4(mix(prev, acc / 1024.0, uMeanBlend), 0.0, 0.0, 1.0);
}`,
      depthTest: false,
      depthWrite: false,
    })
    this.meanScene = new THREE.Scene()
    const meanQuad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      this.meanMaterial,
    )
    meanQuad.frustumCulled = false
    this.meanScene.add(meanQuad)
  }

  /** Half-res RGBA shadow map: R clean, G/B/A shadowed light (see the
   *  splat split note). Receivers take ratios of its own channels. */
  get shadowTexture(): THREE.Texture {
    return this.shadowCanon.texture
  }

  /** The shadow map's defocus rungs (~0.5m and ~2m sigma). */
  get shadowL1Texture(): THREE.Texture {
    return this.shadowL1.texture
  }
  get shadowL2Texture(): THREE.Texture {
    return this.shadowL2.texture
  }

  get pyr1Texture(): THREE.Texture {
    return this.pyr1.texture
  }

  get pyr2Texture(): THREE.Texture {
    return this.pyr2.texture
  }

  get texture(): THREE.Texture {
    return this.canon.texture
  }

  /** One-tap copy (or bilinear 2x2-box downsample when dst is smaller). */
  private copyTo(
    renderer: THREE.WebGLRenderer,
    src: THREE.WebGLRenderTarget,
    dst: THREE.WebGLRenderTarget,
    region: THREE.Vector4,
  ) {
    const u = this.copyMaterial.uniforms
    u.uSrc.value = src.texture
    ;(u.uRegion.value as THREE.Vector4).copy(region)
    renderer.setRenderTarget(dst)
    renderer.clear(true, false, false)
    renderer.render(this.copyScene, this.splatCamera)
  }

  /**
   * Splat the tiles covering the padded VIEW rect (see setViewRect),
   * extended sunward so rays enter the water where they must to land
   * inside it. The map clears to BLACK — 0 means "no light reaches
   * here" — and receivers outside the splatted region must treat the map
   * as dark too (the validity fade).
   */
  step(
    renderer: THREE.WebGLRenderer,
    rippleTexture: THREE.Texture,
    sunDir: THREE.Vector3,
    time: number,
  ) {
    // Splat SOURCES sit sunward of their landings by roughly
    // planeDepth * tan(sunZenith); refraction bends rays toward vertical
    // so the un-refracted tangent (x0.6) over-estimates, which is the
    // safe direction. Slant clamp: below sy=0.12 the pad would grow
    // without bound as the sun approaches the horizon, with the
    // receiver-side border fade covering the last few degrees before the
    // light dies.
    const sy = Math.max(sunDir.y, 0.12)
    const shiftX = (sunDir.x / sy) * CAUSTIC_PLANE_DEPTH * 0.6
    const shiftZ = (sunDir.z / sy) * CAUSTIC_PLANE_DEPTH * 0.6
    const R = 0.70710678
    const sa = shiftX * R - shiftZ * R
    const sb = -shiftX * R - shiftZ * R

    const cc = this.material.uniforms.uCenter.value as THREE.Vector2
    this.material.uniforms.uExtent.value = this.extent
    this.material.uniforms.uMaxBright.value = CAUSTICS.maxBright
    this.material.uniforms.uCardOn.value = UNDERWATER.rainbowCard ? 1 : 0
    this.material.uniforms.uWhaleOn.value = UNDERWATER.whale ? 1 : 0
    this.material.uniforms.uSeabedY.value = UNDERWATER.seabed
      ? -UNDERWATER.seabedDepthM
      : -1e5
    // Ray lattice phase = WORLD ANCHOR + Halton jitter. The lattice used
    // to ride the domain, whose centre snaps to map texels as the boat
    // moves — every snap translated the rays by a fraction of the ray
    // spacing, re-rolling the fold-noise pattern faster than the
    // accumulation could integrate it: caustics flickered exactly while
    // the screen moved. The counter-phase below pins lattice points to a
    // world-fixed grid (the snap-to-spacing residual, bounded by half a
    // spacing — inside the tile marking's rr pad), so motion no longer
    // changes what the rays sample; only the deliberate jitter does.
    this.frameIdx = (this.frameIdx + 1) % 1024
    // 0.97 matches the slider. This clamp sat at 0.92 after the slider's
    // ceiling was raised, so the top of the range was silently inert —
    // exactly the stretch a sparse lattice needs, and exactly where
    // someone chasing flicker would be dragging it.
    const taa = Math.min(Math.max(CAUSTICS.temporalAA, 0), 0.97)
    {
      const raySp = this.extent / (TILES * this.tileGrid)
      const cc0 = this.material.uniforms.uCenter.value as THREE.Vector2
      const phaseX = Math.round(cc0.x / raySp) * raySp - cc0.x
      const phaseZ = Math.round(cc0.y / raySp) * raySp - cc0.y
      const j = this.material.uniforms.uJitter.value as THREE.Vector2
      if (taa > 0) {
        const jit = Math.max(CAUSTICS.jitterCells, 0)
        j.set(
          phaseX + (halton(this.frameIdx, 2) - 0.5) * raySp * jit,
          phaseZ + (halton(this.frameIdx, 3) - 0.5) * raySp * jit,
        )
      } else {
        j.set(phaseX, phaseZ)
      }
    }
    const tileSize = this.extent / TILES
    const half = this.extent / 2
    const rr = tileSize * R // tile half-diagonal
    // Mark every tile whose square overlaps the padded VIEW rect, in the
    // screen-aligned basis around the domain centre: right =
    // (0.7071, -0.7071) in xz, screen-up-horizontal = (-0.7071, -0.7071).
    // The old budget-wide SQUARE centred on the boat wasted its corners
    // off-screen and stopped short of the top of the view: floor samples
    // sit up-screen of their surface pixel (the eye ray keeps travelling
    // as it refracts), so what needs caustics is the view rect SHIFTED
    // up-screen, not a box around the boat. The rect (viewHw/Hn/Hf, from
    // Scene each frame) carries that shift; the sun pad above extends it
    // to where the splat rays ENTER the water.
    const aLo = -this.viewHw + Math.min(sa, 0) - rr
    const aHi = this.viewHw + Math.max(sa, 0) + rr
    const bLo = -this.viewHn + Math.min(sb, 0) - rr
    const bHi = this.viewHf + Math.max(sb, 0) + rr
    const bMid = (this.viewHf - this.viewHn) / 2
    const bHalf = Math.max((this.viewHn + this.viewHf) / 2, 1)
    const aHalf = Math.max(this.viewHw, 1)
    const idx = this.candIdx
    const keys = this.candKeys
    idx.length = 0
    for (let tz = 0; tz < TILES; tz++) {
      for (let tx = 0; tx < TILES; tx++) {
        const px = -half + (tx + 0.5) * tileSize
        const pz = -half + (tz + 0.5) * tileSize
        const a = px * R - pz * R
        const b = -px * R - pz * R
        if (a < aLo || a > aHi || b < bLo || b > bHi) continue
        // Centre-out priority (normalised max-metric): if the budget
        // clips, it clips the least-visible corners.
        const t = tz * TILES + tx
        keys[t] = Math.max(Math.abs(a) / aHalf, Math.abs(b - bMid) / bHalf)
        idx.push(t)
      }
    }
    idx.sort((x, y) => keys[x] - keys[y])
    const count = Math.min(idx.length, MAX_TILES)
    const attr = this.tileAttr.array as Float32Array
    let tx0 = TILES
    let tx1 = -1
    let tz0 = TILES
    let tz1 = -1
    for (let i = 0; i < count; i++) {
      const tx = idx[i] % TILES
      const tz = (idx[i] - tx) / TILES
      attr[i * 2] = tx
      attr[i * 2 + 1] = tz
      if (tx < tx0) tx0 = tx
      if (tx > tx1) tx1 = tx
      if (tz < tz0) tz0 = tz
      if (tz > tz1) tz1 = tz
    }
    this.tileAttr.needsUpdate = true
    this.splatGeometry.instanceCount = count
    this.shadowGeometry.instanceCount = count
    // The rect the receivers may trust this frame. The map is CLEAR
    // (zero) outside the splatted tiles, and zero reads as full caustic
    // shadow — any receiver sampling beyond must fade to neutral instead
    // (causticValidity in Scene, in this same rotated basis). When the
    // budget clipped, shrink the trusted rect to the centre-out metric
    // actually kept, so dropped corner tiles fade instead of going black.
    if (count > 0) {
      this.validCenter.set(cc.x, cc.y)
      const dm =
        idx.length > count
          ? Math.max(Math.min(keys[idx[count - 1]], 1) - 0.03, 0)
          : 1
      this.validHw = this.viewHw * dm
      this.validHn = Math.max(bHalf * dm - bMid, 0)
      this.validHf = Math.max(bMid + bHalf * dm, 0)
    } else {
      this.validHw = 0
      this.validHn = 0
      this.validHf = 0
    }

    this.material.uniforms.uRippleTex.value = rippleTexture
    this.material.uniforms.uSunDir.value.copy(sunDir)
    this.material.uniforms.uTime.value = time

    // Clear the whole map to black, then additively splat the active tiles.
    const previousTarget = renderer.getRenderTarget()
    const previousAutoClear = renderer.autoClear
    renderer.getClearColor(this.savedClearColor)
    const previousClearAlpha = renderer.getClearAlpha()

    renderer.setRenderTarget(this.target)
    // Alpha 0: the splat ADDS b x visNoHull into alpha, so a cleared 1
    // would bias the no-hull shadow field a full unit bright.
    renderer.setClearColor(this.clearColor, 0)
    renderer.clear(true, false, false)
    renderer.autoClear = false
    renderer.render(this.splatScene, this.splatCamera)
    // The shadow pass: same rays, same jitter, its own half-res map.
    renderer.setRenderTarget(this.shadowTarget)
    renderer.clear(true, false, false)
    renderer.render(this.shadowScene, this.splatCamera)
    this.shadowCanon = this.shadowTarget

    // Edge-directed antialias (see edgeAAFragment): repair the filament
    // staircase before anything downstream reads the map. Runs over the
    // splatted tile box plus a margin, and skips outright at 0.
    this.canon = this.target
    if (count > 0) {
      const u0 = (Math.max(tx0 - 1, 0) / TILES) * 2 - 1
      const u1 = (Math.min(tx1 + 2, TILES) / TILES) * 2 - 1
      const v0 = (Math.max(tz0 - 1, 0) / TILES) * 2 - 1
      const v1 = (Math.min(tz1 + 2, TILES) / TILES) * 2 - 1
      this.region.set((u0 + u1) / 2, (v0 + v1) / 2, (u1 - u0) / 2, (v1 - v0) / 2)
    } else {
      this.region.set(0, 0, 1, 1)
    }
    if (CAUSTICS.edgeAA > 0 && count > 0) {
      const aaU = this.aaMaterial.uniforms
      ;(aaU.uRegion.value as THREE.Vector4).copy(this.region)
      aaU.uAA.value = CAUSTICS.edgeAA
      // AA into its own target, which then IS the canonical map (cleared,
      // region drawn: complete). No copy back.
      aaU.uSrc.value = this.canon.texture
      renderer.setRenderTarget(this.aaTarget)
      renderer.clear(true, false, false)
      renderer.render(this.aaScene, this.splatCamera)
      this.canon = this.aaTarget
    }

    // Sun-diffusion blur, as a CLOSURE so it can run on either side of
    // the accumulator (CAUSTICS.blurBeforeAccum). Before, and the clamp
    // bounds are computed from a filtered frame; after, and the history
    // keeps the sharp splat and only the output is softened.
    const runSunBlur = () => {
      // Sun-diffusion blur (see the shader comment). Radius = angular
      // spread x plane depth, capped at a practical kernel — the receiver
      // side's flatten term (uCausticFlat, Scene) carries heavy overcast
      // the rest of the way to featureless light.
      const sigmaMeters = Math.min(this.sourceBlurM, 0.62)
      const sigmaTexels = sigmaMeters / (this.extent / CAUSTIC_RESOLUTION)
      // Below ~1.5 texels the blur is visually nothing (calm's clear-sky
      // diffusion lands here): skip both passes outright.
      if (sigmaTexels > 1.5 && count > 0) {
        // One tile of margin so the penumbra can spread past the splat
        // region; taps beyond it read the map's black, consistent with the
        // "no light computed" convention.
        const u0 = (Math.max(tx0 - 1, 0) / TILES) * 2 - 1
        const u1 = (Math.min(tx1 + 2, TILES) / TILES) * 2 - 1
        const v0 = (Math.max(tz0 - 1, 0) / TILES) * 2 - 1
        const v1 = (Math.min(tz1 + 2, TILES) / TILES) * 2 - 1
        const blurU = this.blurMaterial.uniforms
        ;(blurU.uRegion.value as THREE.Vector4).set(
          (u0 + u1) / 2,
          (v0 + v1) / 2,
          (u1 - u0) / 2,
          (v1 - v0) / 2,
        )
        const step = (0.5 * sigmaTexels) / CAUSTIC_RESOLUTION
        const stepVec = blurU.uStep.value as THREE.Vector2
        const pass = (
          src: THREE.WebGLRenderTarget,
          dst: THREE.WebGLRenderTarget,
          sx: number,
          sy: number,
        ) => {
          blurU.uSrc.value = src.texture
          stepVec.set(sx, sy)
          renderer.setRenderTarget(dst)
          renderer.clear(true, false, false)
          renderer.render(this.blurScene, this.splatCamera)
        }

        const region = blurU.uRegion.value as THREE.Vector4
        if (sigmaTexels <= 5) {
          // Narrow blur: taps are dense enough against full-res content.
          pass(this.canon, this.blurTarget, step, 0)
          pass(this.blurTarget, this.target, 0, step)
        } else {
          // Wide blur: prefilter down to quarter res (two bilinear 2x2
          // boxes — a one-tap copy through the minifying bilinear fetch),
          // blur there, upsample on the way back. Same sigma in UV space;
          // no aliasing.
          this.copyTo(renderer, this.canon, this.blurTarget, region)
          this.copyTo(renderer, this.blurTarget, this.blurQuarterA, region)
          pass(this.blurQuarterA, this.blurQuarterB, step, 0)
          pass(this.blurQuarterB, this.target, 0, step)
        }
        this.canon = this.target
      }
    }

    if (CAUSTICS.blurBeforeAccum) runSunBlur()

    // TEMPORAL ACCUMULATION (see accumFragment): blend the jittered
    // fresh splat under the scrolled history, then copy the result back
    // so every downstream consumer — diffusion, pyramids, mean,
    // receivers, the debug overlay — reads the integrated map. The
    // history reseeds whenever its texel<->world mapping changes.
    if (taa > 0 && count > 0) {
      const cc3 = this.material.uniforms.uCenter.value as THREE.Vector2
      // A changed EXTENT is no longer an invalidation: the remap above
      // handles it. Only a changed LATTICE (which rewrites what a texel
      // means) or a jump too far to have overlap still reseeds.
      const pe = this.prevExtent > 0 ? this.prevExtent : this.extent
      const invalid =
        !this.histSeeded ||
        this.prevGrid !== this.tileGrid ||
        Math.abs(cc3.x - this.prevCenter.x) +
          Math.abs(cc3.y - this.prevCenter.y) >
          0.2 * this.extent
      const aU = this.accumMaterial.uniforms
      ;(aU.uScroll.value as THREE.Vector2).set(
        (cc3.x - this.prevCenter.x) / pe,
        (cc3.y - this.prevCenter.y) / pe,
      )
      aU.uHistScale.value = this.extent / pe
      aU.uAlpha.value = invalid ? 0 : taa
      aU.uClipSigma.value = Math.max(CAUSTICS.clipSigma, 0)
      // Clamp neighbourhood in RAY CELLS, never finer than a texel. The
      // ray cell is 1/(TILES*tileGrid) of the domain in uv — extent
      // cancels, because the lattice and the domain scale together.
      aU.uTexelT.value = Math.max(
        1 / CAUSTIC_RESOLUTION,
        Math.max(CAUSTICS.clampCells, 0) / (TILES * this.tileGrid),
      )
      aU.uHist.value = this.histB.texture
      aU.uCur.value = this.canon.texture
      // Region draw over a cleared target (the history is read at a
      // scrolled uv, which can reach anywhere in the previous frame's
      // target, so the region only bounds what is WRITTEN). The result
      // becomes canon; the un-blurred history chain stays its own pair.
      ;(aU.uRegion.value as THREE.Vector4).copy(this.region)
      renderer.setRenderTarget(this.histA)
      renderer.clear(true, false, false)
      renderer.render(this.accumScene, this.splatCamera)
      this.canon = this.histA
      const swap = this.histA
      this.histA = this.histB
      this.histB = swap
      this.histSeeded = true
      this.prevCenter.copy(cc3)
      this.prevExtent = this.extent
      this.prevGrid = this.tileGrid
    } else {
      this.histSeeded = false
    }

    // THE SHADOW CHAIN GETS THE SAME TREATMENT. It used to go straight
    // from the splat to its pyramid — no antialias, no history — which
    // was survivable only while the lattice was dense enough that a
    // frame's occluded-ray fraction barely moved. Coarsen the map and
    // the fraction quantises, and with nothing integrating it the jitter
    // lands on screen as flickering shadow edges. The receiver's ratio
    // read (channel / clean) cancels a lot of shared jitter, but not the
    // part where numerator and denominator disagree about which rays an
    // occluder caught. Both stages are the pattern's own materials: the
    // AA already detects on the clean channel and blends all four, and
    // the accumulator is per-channel for exactly these fields.
    const shTexel = 2 / CAUSTIC_RESOLUTION
    if (CAUSTICS.shadowEdgeAA > 0 && count > 0) {
      const aaU = this.aaMaterial.uniforms
      ;(aaU.uRegion.value as THREE.Vector4).copy(this.region)
      aaU.uAA.value = CAUSTICS.shadowEdgeAA
      aaU.uTexelAA.value = shTexel
      aaU.uSrc.value = this.shadowCanon.texture
      renderer.setRenderTarget(this.shadowAA)
      renderer.clear(true, false, false)
      renderer.render(this.aaScene, this.splatCamera)
      this.shadowCanon = this.shadowAA
      // Hand the pattern's own AA uniform back, or the next frame's
      // pattern pass inherits the half-res texel and softens.
      aaU.uTexelAA.value = 1 / CAUSTIC_RESOLUTION
    }
    const shTaa = Math.min(Math.max(CAUSTICS.shadowTemporalAA, 0), 0.99)
    if (shTaa > 0 && count > 0) {
      const cc4 = this.material.uniforms.uCenter.value as THREE.Vector2
      const spe = this.shadowPrevExtent > 0 ? this.shadowPrevExtent : this.extent
      const invalid =
        !this.shadowHistSeeded ||
        this.shadowPrevGrid !== this.shadowGrid ||
        Math.abs(cc4.x - this.shadowPrevCenter.x) +
          Math.abs(cc4.y - this.shadowPrevCenter.y) >
          0.2 * this.extent
      const aU = this.accumMaterial.uniforms
      ;(aU.uScroll.value as THREE.Vector2).set(
        (cc4.x - this.shadowPrevCenter.x) / spe,
        (cc4.y - this.shadowPrevCenter.y) / spe,
      )
      aU.uHistScale.value = this.extent / spe
      aU.uAlpha.value = invalid ? 0 : shTaa
      aU.uClipSigma.value = Math.max(CAUSTICS.clipSigma, 0)
      // Ray cells of the SHADOW lattice, floored at this map's own texel
      // (half the pattern's).
      aU.uTexelT.value = Math.max(
        shTexel,
        Math.max(CAUSTICS.clampCells, 0) / (TILES * this.shadowGrid),
      )
      aU.uHist.value = this.shadowHistB.texture
      aU.uCur.value = this.shadowCanon.texture
      ;(aU.uRegion.value as THREE.Vector4).copy(this.region)
      renderer.setRenderTarget(this.shadowHistA)
      renderer.clear(true, false, false)
      renderer.render(this.accumScene, this.splatCamera)
      this.shadowCanon = this.shadowHistA
      const swapS = this.shadowHistA
      this.shadowHistA = this.shadowHistB
      this.shadowHistB = swapS
      this.shadowHistSeeded = true
      this.shadowPrevCenter.copy(cc4)
      this.shadowPrevExtent = this.extent
      this.shadowPrevGrid = this.shadowGrid
    } else {
      this.shadowHistSeeded = false
    }

    if (!CAUSTICS.blurBeforeAccum) runSunBlur()

    // Build the defocus pyramid (see the pyr1/pyr2 declarations). Full-
    // frame passes at 512^2/256^2 — cheap. uRegion goes full-quad here;
    // the diffusion blur above re-sets it from its tile box every frame.
    {
      const blurU = this.blurMaterial.uniforms
      ;(blurU.uRegion.value as THREE.Vector4).set(0, 0, 1, 1)
      const stepVec = blurU.uStep.value as THREE.Vector2
      const pass = (
        src: THREE.WebGLRenderTarget,
        dst: THREE.WebGLRenderTarget,
        sx: number,
        sy: number,
      ) => {
        blurU.uSrc.value = src.texture
        stepVec.set(sx, sy)
        renderer.setRenderTarget(dst)
        renderer.clear(true, false, false)
        renderer.render(this.blurScene, this.splatCamera)
      }
      // L1: ~0.5m world sigma. Kernel taps sit at sigma/2 spacing in UV.
      const s1 = 0.5 / this.extent / 2
      const full = blurU.uRegion.value as THREE.Vector4
      this.copyTo(renderer, this.canon, this.blurTarget, full)
      this.copyTo(renderer, this.blurTarget, this.blurQuarterA, full)
      pass(this.blurQuarterA, this.blurQuarterB, s1, 0)
      pass(this.blurQuarterB, this.pyr1, 0, s1)
      // L2: ~2m total; additional sigma on top of L1's 0.5m.
      const s2 = Math.sqrt(2.0 * 2.0 - 0.5 * 0.5) / this.extent / 2
      this.copyTo(renderer, this.pyr1, this.pyr2, full)
      pass(this.pyr2, this.pyrScratch, s2, 0)
      pass(this.pyrScratch, this.pyr2, 0, s2)
      // Shadow map's rungs at quarter res, same sigmas as the pattern's.
      this.copyTo(renderer, this.shadowCanon, this.shadowScratch, full)
      pass(this.shadowScratch, this.shadowL1, s1, 0)
      pass(this.shadowL1, this.shadowScratch, 0, s1)
      // (scratch now holds L1; keep L1 there and build L2 from it)
      this.copyTo(renderer, this.shadowScratch, this.shadowL1, full)
      pass(this.shadowL1, this.shadowScratch, s2, 0)
      pass(this.shadowScratch, this.shadowL2, 0, s2)
    }

    // Reduce the splatted rect to its mean, for receiver normalisation.
    {
      const cc2 = this.material.uniforms.uCenter.value as THREE.Vector2
      const rect = this.meanMaterial.uniforms.uRectUv.value as THREE.Vector4
      if (this.validHw > 0.5) {
        // The trusted rect is ROTATED 45deg to the map's axes; averaging
        // its axis-aligned bounding box would fold ~half unsplatted black
        // into the mean and the normalisation would over-brighten. Reduce
        // over the axis-aligned square INSCRIBED in the rect instead —
        // centred on the rect's (up-screen-shifted) middle, half-size
        // 0.7071 x the smaller half-extent.
        const R2 = 0.70710678
        const bc = (this.validHf - this.validHn) / 2
        const sHalf =
          Math.min(this.validHw, (this.validHn + this.validHf) / 2) * R2
        // WORLD-ANCHOR THE TAP LATTICE. The taps sit at fixed offsets
        // inside this rect, so a rect that slides with the boat draws a
        // fresh set of samples every frame — and a fresh sample of a
        // heavy-tailed field is a fresh error. The EMA below can only
        // smooth an estimate that is temporally correlated; under motion
        // it was averaging a random walk, and every receiver divides by
        // the result, so the whole pattern pulsed together. That was the
        // flicker that appeared only while driving.
        //
        // Quantise the half-extent (so the tap SPACING holds still), then
        // snap the centre to that spacing (so the taps land on the same
        // world points). Both step occasionally instead of sliding, and a
        // step is one correlated jump the EMA can absorb.
        const halfQ = Math.max(Math.round((sHalf * 0.8) / 2) * 2, 2)
        const sw = (halfQ * 2) / 32
        const mx = Math.round((this.validCenter.x - R2 * bc) / sw) * sw
        const mz = Math.round((this.validCenter.y - R2 * bc) / sw) * sw
        rect.set(
          (mx - cc2.x) / this.extent + 0.5,
          (mz - cc2.y) / this.extent + 0.5,
          // inset 20%: the rim mixes with unsplatted black and would drag
          // the mean low
          halfQ / this.extent,
          halfQ / this.extent,
        )
        this.meanMaterial.uniforms.uMap.value = this.canon.texture
        this.meanMaterial.uniforms.uPrevMean.value = this.meanTarget.texture
        this.meanMaterial.uniforms.uMeanBlend.value = this.meanSeeded ? 0.08 : 1
        this.meanSeeded = true
        renderer.setRenderTarget(this.meanTargetB)
        renderer.render(this.meanScene, this.meanCamera)
        const swap = this.meanTarget
        this.meanTarget = this.meanTargetB
        this.meanTargetB = swap
      } else {
        // nothing splatted: neutral mean so the division is a no-op
        renderer.setRenderTarget(this.meanTarget)
        renderer.setClearColor(new THREE.Color(1, 1, 1), 1)
        renderer.clear(true, false, false)
        this.meanSeeded = false
      }
    }

    renderer.autoClear = previousAutoClear
    renderer.setClearColor(this.savedClearColor, previousClearAlpha)
    renderer.setRenderTarget(previousTarget)
  }

  /** World rect (cx, cz, halfX, halfZ) the splat covered; empty = none. */
  /**
   * View rect the splat must cover, in the screen-aligned basis around
   * the domain centre: half-extents right / near (toward camera) / far
   * (up-screen). Scene refreshes it each frame from the unprojected view
   * quad plus the refraction shifts.
   */
  private viewHw = 40
  private viewHn = 40
  private viewHf = 40
  /**
   * Live domain size, world metres. Scene grows it each frame to whatever
   * the view rect (seabed depth included) demands, quantised to 2m so the
   * sun's slow slant doesn't shimmer the texel grid every frame.
   */
  extent = CAUSTIC_EXTENT
  setExtent(e: number) {
    const want = Math.max(CAUSTIC_MIN_EXTENT, Math.ceil(e / 2) * 2)
    // HYSTERESIS: grow immediately (coverage is correctness), shrink only
    // with 6m of slack. The need is recomputed every frame from inputs
    // that wiggle under motion (unprojected corners lag the camera by a
    // frame), and each flip across the 2m quantisation changed the
    // history's texel<->world mapping — a full temporal reseed, showing
    // one raw-jitter frame: the intermittent flicker while driving.
    if (want > this.extent || want < this.extent - 6) this.extent = want
  }
  /**
   * Wire the occluders for the shadow channels. Matrices and vectors are
   * held BY REFERENCE (the water material's own objects), so the splat
   * and the water can never see different poses — the same sharing rule
   * as the foam sim's buoys. The sphere needs no wiring: its uniforms
   * are already live via setSphereY.
   */
  setOccluders(
    boatInv: THREE.Matrix4,
    boatSdf: THREE.Texture,
    boatSdfMin: THREE.Vector3,
    boatSdfSize: THREE.Vector3,
    buoyInv: THREE.Matrix4[],
    cardRect: THREE.Vector4,
    whaleC: THREE.Vector3,
  ) {
    const u = this.material.uniforms
    u.uBoatInv.value = boatInv
    u.uBoatSdf.value = boatSdf
    u.uBoatSdfMin.value = boatSdfMin
    u.uBoatSdfSize.value = boatSdfSize
    u.uBuoyInv.value = buoyInv
    u.uCardRect.value = cardRect
    u.uWhaleC.value = whaleC
  }
  setViewRect(hw: number, hn: number, hf: number) {
    // Guard: the rotated rect must FIT the domain square, or the trusted
    // rect would claim tiles the marking loop can never reach and the
    // fade would give way to unsplatted black. With the live extent sized
    // from the same rect this should never bite; shrink proportionally if
    // it somehow does.
    const cap = this.extent * 0.7071 - 2
    const need = hw + Math.max(hn, hf)
    const k = need > cap ? cap / need : 1
    this.viewHw = hw * k
    this.viewHn = hn * k
    this.viewHf = hf * k
  }
  /** The rect receivers may trust this frame (same basis, world centre). */
  readonly validCenter = new THREE.Vector2()
  validHw = 0
  validHn = 0
  validHf = 0
  private candIdx: number[] = []
  private candKeys = new Float32Array(TILES * TILES)

  /**
   * 1x1 target holding the map's MEAN over the splatted rect, refreshed
   * every step. Receivers divide by it, which forces the pattern to
   * redistribute light rather than mint it — the splat's absolute
   * calibration measured 2-7x hot in patches, and normalising at the
   * sample is robust to whatever the splat does. A dedicated reduction
   * pass, NOT a mip read: mipmap generation on this half-float target
   * silently no-ops on some renderers, and a normalisation that quietly
   * turns itself off is worse than none.
   */
  private meanTarget: THREE.WebGLRenderTarget
  private meanTargetB: THREE.WebGLRenderTarget
  private meanSeeded = false
  private meanScene: THREE.Scene
  private meanCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private meanMaterial: THREE.ShaderMaterial

  get meanTexture(): THREE.Texture {
    return this.meanTarget.texture
  }

  /** Hull submergence 0-1, from the Scene each frame (see uBoatSub). */
  setBoatSubmerged(v: number) {
    this.material.uniforms.uBoatSub.value = v
  }

  /** Sphere centre height, live from the tuning panel. The rainbow card
   *  rides the same dial (Scene keeps uRainbowY = SPHERE_CY). */
  setSphereY(y: number) {
    ;(this.material.uniforms.uSphereCenter.value as THREE.Vector3).y = y
    this.material.uniforms.uCardY.value = y
  }

  /** Domain centre, for the receivers' uCausticCenter uniforms. */
  get center(): THREE.Vector2 {
    return this.material.uniforms.uCenter.value as THREE.Vector2
  }

  /**
   * Follow the boat. Stateless per frame (the map is fully re-splat each
   * step), so recentering is just the uniform — no content scroll needed.
   * The ripple centre rides along so the splat keeps reading the ripple
   * field at true world coordinates.
   */
  setCenter(x: number, z: number, rippleCenter: THREE.Vector2) {
    const texel = this.extent / CAUSTIC_RESOLUTION
    ;(this.material.uniforms.uCenter.value as THREE.Vector2).set(
      Math.round(x / texel) * texel,
      Math.round(z / texel) * texel,
    )
    ;(this.material.uniforms.uRippleCenter.value as THREE.Vector2).copy(
      rippleCenter,
    )
  }

  dispose() {
    this.meanTarget.dispose()
    this.meanTargetB.dispose()
    this.meanMaterial.dispose()
    this.pyr1.dispose()
    this.pyr2.dispose()
    this.pyrScratch.dispose()

    this.target.dispose()
    this.blurTarget.dispose()
    this.blurQuarterA.dispose()
    this.blurQuarterB.dispose()
    this.material.dispose()
    this.blurMaterial.dispose()
    this.aaTarget.dispose()
    this.shadowTarget.dispose()
    this.shadowAA.dispose()
    this.shadowHistA.dispose()
    this.shadowHistB.dispose()
    this.shadowL1.dispose()
    this.shadowL2.dispose()
    this.shadowScratch.dispose()
    this.shadowGeometry.dispose()
    this.shadowMaterial.dispose()
    this.aaMaterial.dispose()
    this.histA.dispose()
    this.histB.dispose()
    this.accumMaterial.dispose()
    this.splatGeometry.dispose()
  }
}
