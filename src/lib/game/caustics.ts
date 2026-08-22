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
import { CAUSTICS, PROFILE } from './tuning'
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
export const CAUSTIC_RESOLUTION =
  typeof window !== 'undefined' && window.innerWidth < 720 ? 2048 : 3072
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
 * Rays per tile side for a given target spacing (CAUSTICS.raySpacingM).
 * Sized from the base extent: the dynamic window-sized extent once grew
 * the tiles under a fixed 48-ray grid, and the ~40% coarser lattice was
 * a visible regression in exactly the fine filaments the knobs were
 * tuned for. FLOOR at 48 rays — on smaller windows the target-spacing
 * formula lands below it, and the floor is the density the look was
 * approved at; the knob buys rays above the floor, never sells below.
 * The live extent can still exceed the base under a deep seabed — the
 * pattern is depth-blurred there anyway.
 */
function tileGridFor(spacingM: number): number {
  return Math.min(
    Math.max(Math.round(CAUSTIC_EXTENT / TILES / Math.max(spacingM, 0.03)), 48),
    96,
  )
}
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
uniform float uRayD; // finite-difference step, half the ray spacing (m)
uniform float uMaxBright;
uniform vec2 uJitter; // per-frame lattice offset, world metres
${
  PROFILE.pointCausticSplat
    ? ''
    : PROFILE.flatCausticSplat
      ? 'varying vec2 vOld;\nvarying vec2 vNew;'
      : 'varying float vBright;'
}

${wavesGlsl()}

attribute vec2 aTile; // active tile origin, in tile units

// Trace ONE ray: rest position -> true surface (ambient Gerstner +
// ripples) -> refract -> land on the reference plane.
vec3 causticLand(vec2 sxz) {
	vec3 D = waveDisplacement(sxz, uTime, uAmp);
	vec3 P = vec3(sxz.x + D.x, D.y, sxz.y + D.z);
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
		float qak = b.y * b.x * uAmp * a.z;
		float ak = b.x * uAmp * a.z;
		txx -= qak * a.x * a.x * sn;
		txy += ak * a.x * cs;
		txz -= qak * a.x * a.y * sn;
		tzy += ak * a.y * cs;
		tzz -= qak * a.y * a.y * sn;
	}
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

	// Beam-space: EVERY ray projects to the reference plane; no receiver
	// intersection here. (No crown shadow either: it was the only cast
	// shadow in the whole game — the sun has no shadow maps and nothing
	// above water shades anything — and a binary ray-kill aliased the
	// waterline circle into radial spokes. If cast shadows ever arrive,
	// they arrive everywhere at once.)
	float t = max((P.y + uPlaneDepth) / max(-refr.y, 0.05), 0.0);
	return P + refr * t;
}

void main() {
	vec2 domainUv = (aTile + uv) / ${TILES}.0;
	vec2 sxz = (domainUv - 0.5) * uExtent + uCenter + uJitter;
${
  PROFILE.pointCausticSplat
    ? `	// PHOTON mode: one ray, one 1-texel point of unit energy. The map
	// is the ray-density histogram; brightness emerges from density and
	// the mean-normalisation sets the scale. Speckle by construction —
	// temporalAA is the integrator that makes it converge.
	vec3 land = causticLand(sxz);
	gl_PointSize = 1.0;`
    : PROFILE.flatCausticSplat
      ? `	// FLAT mode (PROFILE.flatCausticSplat): one ray, brightness from
	// the fragment stage's derivatives — cheap, beaded filaments.
	vec3 land = causticLand(sxz);
	vOld = sxz;
	vNew = land.xz;`
    : `	// PER-VERTEX brightness, interpolated across the triangles. The old
	// per-fragment derivative version was constant across each warped
	// triangle — the whole map was a flat-shaded mosaic at ray-grid
	// pitch, which read as grain along every thin filament. Here the
	// warp's Jacobian is finite-differenced at the vertex itself (two
	// extra ray traces at half the ray spacing) and the rasterizer
	// interpolates smoothly between vertices — the grain's actual cause,
	// removed, with no blur anywhere. (PROFILE.flatCausticSplat is the
	// cheap fallback.)
	vec3 land = causticLand(sxz);
	vec3 landU = causticLand(sxz + vec2(uRayD, 0.0));
	vec3 landV = causticLand(sxz + vec2(0.0, uRayD));
	vec2 du = landU.xz - land.xz;
	vec2 dv = landV.xz - land.xz;
	float newArea = abs(du.x * dv.y - du.y * dv.x);
	vBright = clamp(uRayD * uRayD / max(newArea, 1e-7), 0.0, uMaxBright);`
}
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
	float acc = texture2D(uSrc, vUv).r * 0.1997;
	acc += (texture2D(uSrc, vUv + uStep).r + texture2D(uSrc, vUv - uStep).r) * 0.1762;
	acc += (texture2D(uSrc, vUv + 2.0 * uStep).r + texture2D(uSrc, vUv - 2.0 * uStep).r) * 0.1211;
	acc += (texture2D(uSrc, vUv + 3.0 * uStep).r + texture2D(uSrc, vUv - 3.0 * uStep).r) * 0.0648;
	acc += (texture2D(uSrc, vUv + 4.0 * uStep).r + texture2D(uSrc, vUv - 4.0 * uStep).r) * 0.0270;
	acc += (texture2D(uSrc, vUv + 5.0 * uStep).r + texture2D(uSrc, vUv - 5.0 * uStep).r) * 0.0088;
	acc += (texture2D(uSrc, vUv + 6.0 * uStep).r + texture2D(uSrc, vUv - 6.0 * uStep).r) * 0.0022;
	gl_FragColor = vec4(acc, 0.0, 0.0, 1.0);
}`

const splatFragment = PROFILE.pointCausticSplat
  ? `
void main() {
	// Unit-energy photon; scale is the mean-normalisation's problem.
	gl_FragColor = vec4(1.0, 0.0, 0.0, 1.0);
}`
  : PROFILE.flatCausticSplat
  ? `
uniform float uMaxBright;
varying vec2 vOld;
varying vec2 vNew;

void main() {
	// FLAT mode: differential-area brightness from screen-space
	// derivatives — constant per warped triangle. True parallelogram
	// areas (the 2D cross), not length x length: the axis-product
	// overestimates sheared patches and speckles fold filaments.
	vec2 ox = dFdx(vOld);
	vec2 oy = dFdy(vOld);
	vec2 nx = dFdx(vNew);
	vec2 ny = dFdy(vNew);
	float oldArea = abs(ox.x * oy.y - ox.y * oy.x);
	float newArea = abs(nx.x * ny.y - nx.y * ny.x);
	gl_FragColor = vec4(clamp(oldArea / max(newArea, 1e-7), 0.0, uMaxBright), 0.0, 0.0, 1.0);
}`
  : `
varying float vBright;

void main() {
	// Differential-area brightness (1 = neutral, > 1 focused), computed
	// per vertex in the splat vertex shader and interpolated here.
	gl_FragColor = vec4(vBright, 0.0, 0.0, 1.0);
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
uniform float uTexelT;
varying vec2 vUv;
void main() {
	vec2 huv = vUv + uScroll;
	float inH =
		huv.x > 0.0 && huv.x < 1.0 && huv.y > 0.0 && huv.y < 1.0 ? 1.0 : 0.0;
	float h = texture2D(uHist, huv).r;
	float c = texture2D(uCur, vUv).r;
	// NEIGHBOURHOOD CLAMP: waves move the pattern through the domain, and
	// unclamped history dragged bright filaments into decaying trails
	// ("trailing glitter"). Clamp the history into the current frame's
	// local brightness range (plus a pad for the jitter's own variance):
	// stale-bright history over now-dark water is rejected within a
	// frame, while history inside the local range keeps integrating the
	// lattice noise.
	float cl = texture2D(uCur, vUv - vec2(uTexelT, 0.0)).r;
	float cr = texture2D(uCur, vUv + vec2(uTexelT, 0.0)).r;
	float cd = texture2D(uCur, vUv - vec2(0.0, uTexelT)).r;
	float cu = texture2D(uCur, vUv + vec2(0.0, uTexelT)).r;
	float mn = min(c, min(min(cl, cr), min(cd, cu)));
	float mx = max(c, max(max(cl, cr), max(cd, cu)));
	float pad = 0.35 * (mx - mn) + 0.05;
	float hc = clamp(h, mn - pad, mx + pad);
	gl_FragColor = vec4(mix(c, hc, uAlpha * inH), 0.0, 0.0, 1.0);
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
	float c = texture2D(uSrc, vUv).r;
	float l = texture2D(uSrc, vUv - vec2(uTexelAA, 0.0)).r;
	float r = texture2D(uSrc, vUv + vec2(uTexelAA, 0.0)).r;
	float d = texture2D(uSrc, vUv - vec2(0.0, uTexelAA)).r;
	float u = texture2D(uSrc, vUv + vec2(0.0, uTexelAA)).r;
	vec2 g = vec2(r - l, u - d);
	float gm = length(g);
	// Scale-invariant edge metric: gradient against local level, so a
	// dim filament's border counts as much as a bright one's.
	float level = 0.25 * (l + r + d + u) + 0.5;
	float w = uAA * smoothstep(0.0005, 0.025, gm / level);
	if (w < 0.001) {
		gl_FragColor = vec4(c, 0.0, 0.0, 1.0);
		return;
	}
	vec2 t = vec2(-g.y, g.x) * (uTexelAA / max(gm, 1e-6));
	float a = texture2D(uSrc, vUv + t).r;
	float b = texture2D(uSrc, vUv - t).r;
	gl_FragColor = vec4(mix(c, (c + a + b) / 3.0, w), 0.0, 0.0, 1.0);
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
  private splatMesh!: THREE.Mesh | THREE.Points
  private tileGrid = 48
  private splatScene: THREE.Scene

  /** One ray lattice tile; rebuilt live when raySpacingM moves. */
  private buildSplatGeometry(grid: number): THREE.InstancedBufferGeometry {
    const base = new THREE.PlaneGeometry(1, 1, grid, grid)
    const geo = new THREE.InstancedBufferGeometry()
    // Photon mode draws POINTS: no index, or the shared interior vertices
    // of the triangle grid would each land 4-6 photons.
    if (!PROFILE.pointCausticSplat) geo.index = base.index
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
        // Single channel: quarters the additive fill bandwidth vs RGBA.
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

    // One aTile instance attribute shared by both passes: which tiles are
    // active this frame.
    this.tileAttr = new THREE.InstancedBufferAttribute(
      new Float32Array(MAX_TILES * 2),
      2,
    )
    this.tileAttr.setUsage(THREE.DynamicDrawUsage)

    this.tileGrid = tileGridFor(CAUSTICS.raySpacingM)
    this.splatGeometry = this.buildSplatGeometry(this.tileGrid)

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uRippleTex: { value: null },
        uCenter: { value: new THREE.Vector2(0, 0) },
        uExtent: { value: CAUSTIC_EXTENT },
        uRippleCenter: { value: new THREE.Vector2(0, 0) },
        uRippleExtent: { value: RIPPLE_EXTENT },
        uSunDir: { value: new THREE.Vector3(0.4, 1, 0.3) },
        uSphereCenter: { value: new THREE.Vector3(3, -6, 2) },
        uSphereRadius: { value: 5 },
        uRayD: { value: 0.05 },
        uMaxBright: { value: 30 },
        uJitter: { value: new THREE.Vector2(0, 0) },
        uPlaneDepth: { value: CAUSTIC_PLANE_DEPTH },
        uTime: { value: 0 },
        uAmp: { value: 1 },
        // Shared with every other wave material; see waveUniformA.
        uWaveA: { value: waveUniformA },
        uWaveB: { value: waveUniformB },
      },
      vertexShader: splatVertex,
      fragmentShader: splatFragment,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      // Folded triangles invert their winding; both faces must splat.
      side: THREE.DoubleSide,
    })

    this.splatScene = new THREE.Scene()
    this.splatMesh = PROFILE.pointCausticSplat
      ? new THREE.Points(this.splatGeometry, this.material)
      : new THREE.Mesh(this.splatGeometry, this.material)
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
        uTexelT: { value: 1 / CAUSTIC_RESOLUTION },
        uRegion: { value: new THREE.Vector4(0, 0, 1, 1) },
      },
      vertexShader: blurVertex,
      fragmentShader: accumFragment,
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
      depthTest: false,
      depthWrite: false,
    })

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
	float acc = 0.0;
	for (int j = 0; j < 16; j++) {
		for (int i = 0; i < 16; i++) {
			vec2 t = (vec2(float(i), float(j)) + 0.5) / 16.0 * 2.0 - 1.0;
			acc += texture2D(uMap, uRectUv.xy + t * uRectUv.zw).r;
		}
	}
	// EMA against last frame's mean: the raw mean of a moving sea swings
	// frame to frame (crests focusing and defocusing heave it, hardest at
	// large waves), and dividing the whole pattern by a jittering scalar
	// FLICKERED every caustic on screen at once. Smoothing converges to
	// the exact value on a static sea, so frozen waves are unchanged.
	float prev = texture2D(uPrevMean, vec2(0.5)).r;
	gl_FragColor = vec4(mix(prev, acc / 256.0, uMeanBlend), 0.0, 0.0, 1.0);
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

  get pyr1Texture(): THREE.Texture {
    return this.pyr1.texture
  }

  get pyr2Texture(): THREE.Texture {
    return this.pyr2.texture
  }

  get texture(): THREE.Texture {
    return this.target.texture
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
    // Jitter the ray lattice when accumulating: sub-spacing Halton
    // offsets, so successive frames sample different lattice phases.
    this.frameIdx = (this.frameIdx + 1) % 1024
    const taa = Math.min(Math.max(CAUSTICS.temporalAA, 0), 0.92)
    {
      const raySp = this.extent / (TILES * this.tileGrid)
      const j = this.material.uniforms.uJitter.value as THREE.Vector2
      if (taa > 0) {
        j.set(
          (halton(this.frameIdx, 2) - 0.5) * raySp,
          (halton(this.frameIdx, 3) - 0.5) * raySp,
        )
      } else {
        j.set(0, 0)
      }
    }
    // Live ray-density knob: rebuild the lattice when it moves.
    const wantGrid = tileGridFor(CAUSTICS.raySpacingM)
    if (wantGrid !== this.tileGrid) {
      const count0 = this.splatGeometry.instanceCount
      this.splatGeometry.dispose()
      this.tileGrid = wantGrid
      this.splatGeometry = this.buildSplatGeometry(wantGrid)
      this.splatGeometry.instanceCount = count0
      this.splatMesh.geometry = this.splatGeometry
    }
    // Finite-difference step for the per-vertex Jacobian: half the ray
    // spacing, tracking the live extent.
    this.material.uniforms.uRayD.value =
      (0.5 * this.extent) / (TILES * this.tileGrid)
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
    renderer.setClearColor(this.clearColor, 1)
    renderer.clear(true, false, false)
    renderer.autoClear = false
    renderer.render(this.splatScene, this.splatCamera)

    // Edge-directed antialias (see edgeAAFragment): repair the filament
    // staircase before anything downstream reads the map. Runs over the
    // splatted tile box plus a margin, and skips outright at 0.
    if (CAUSTICS.edgeAA > 0 && count > 0) {
      const u0 = (Math.max(tx0 - 1, 0) / TILES) * 2 - 1
      const u1 = (Math.min(tx1 + 2, TILES) / TILES) * 2 - 1
      const v0 = (Math.max(tz0 - 1, 0) / TILES) * 2 - 1
      const v1 = (Math.min(tz1 + 2, TILES) / TILES) * 2 - 1
      const aaU = this.aaMaterial.uniforms
      ;(aaU.uRegion.value as THREE.Vector4).set(
        (u0 + u1) / 2,
        (v0 + v1) / 2,
        (u1 - u0) / 2,
        (v1 - v0) / 2,
      )
      aaU.uAA.value = CAUSTICS.edgeAA
      const blurU = this.blurMaterial.uniforms
      ;(blurU.uRegion.value as THREE.Vector4).copy(
        aaU.uRegion.value as THREE.Vector4,
      )
      // AA into the scratch, then an identity copy back (the 13-tap blur
      // at step 0 sums to 1): this.target stays the canonical map every
      // downstream consumer reads.
      aaU.uSrc.value = this.target.texture
      renderer.setRenderTarget(this.aaTarget)
      renderer.clear(true, false, false)
      renderer.render(this.aaScene, this.splatCamera)
      blurU.uSrc.value = this.aaTarget.texture
      ;(blurU.uStep.value as THREE.Vector2).set(0, 0)
      renderer.setRenderTarget(this.target)
      renderer.clear(true, false, false)
      renderer.render(this.blurScene, this.splatCamera)
    }

    // TEMPORAL ACCUMULATION (see accumFragment): blend the jittered
    // fresh splat under the scrolled history, then copy the result back
    // so every downstream consumer — diffusion, pyramids, mean,
    // receivers, the debug overlay — reads the integrated map. The
    // history reseeds whenever its texel<->world mapping changes.
    if (taa > 0 && count > 0) {
      const cc3 = this.material.uniforms.uCenter.value as THREE.Vector2
      const invalid =
        !this.histSeeded ||
        this.prevExtent !== this.extent ||
        this.prevGrid !== this.tileGrid ||
        Math.abs(cc3.x - this.prevCenter.x) +
          Math.abs(cc3.y - this.prevCenter.y) >
          0.2 * this.extent
      const aU = this.accumMaterial.uniforms
      ;(aU.uScroll.value as THREE.Vector2).set(
        (cc3.x - this.prevCenter.x) / this.extent,
        (cc3.y - this.prevCenter.y) / this.extent,
      )
      aU.uAlpha.value = invalid ? 0 : taa
      aU.uHist.value = this.histB.texture
      aU.uCur.value = this.target.texture
      renderer.setRenderTarget(this.histA)
      renderer.clear(true, false, false)
      renderer.render(this.accumScene, this.splatCamera)
      // Identity copy back (13-tap blur at step 0 sums to 1).
      const blurU2 = this.blurMaterial.uniforms
      ;(blurU2.uRegion.value as THREE.Vector4).set(0, 0, 1, 1)
      ;(blurU2.uStep.value as THREE.Vector2).set(0, 0)
      blurU2.uSrc.value = this.histA.texture
      renderer.setRenderTarget(this.target)
      renderer.clear(true, false, false)
      renderer.render(this.blurScene, this.splatCamera)
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

      if (sigmaTexels <= 5) {
        // Narrow blur: taps are dense enough against full-res content.
        pass(this.target, this.blurTarget, step, 0)
        pass(this.blurTarget, this.target, 0, step)
      } else {
        // Wide blur: prefilter down to quarter res (two bilinear 2x2
        // boxes — the zero-step "blur" is an identity copy through the
        // minifying bilinear fetch), blur there, upsample on the way
        // back. Same sigma in UV space; no aliasing.
        pass(this.target, this.blurTarget, 0, 0)
        pass(this.blurTarget, this.blurQuarterA, 0, 0)
        pass(this.blurQuarterA, this.blurQuarterB, step, 0)
        pass(this.blurQuarterB, this.target, 0, step)
      }
    }

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
      pass(this.target, this.blurTarget, 0, 0)
      pass(this.blurTarget, this.blurQuarterA, 0, 0)
      pass(this.blurQuarterA, this.blurQuarterB, s1, 0)
      pass(this.blurQuarterB, this.pyr1, 0, s1)
      // L2: ~2m total; additional sigma on top of L1's 0.5m.
      const s2 = Math.sqrt(2.0 * 2.0 - 0.5 * 0.5) / this.extent / 2
      pass(this.pyr1, this.pyr2, 0, 0)
      pass(this.pyr2, this.pyrScratch, s2, 0)
      pass(this.pyrScratch, this.pyr2, 0, s2)
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
        const mx = this.validCenter.x - R2 * bc
        const mz = this.validCenter.y - R2 * bc
        rect.set(
          (mx - cc2.x) / this.extent + 0.5,
          (mz - cc2.y) / this.extent + 0.5,
          // inset 20%: the rim mixes with unsplatted black and would drag
          // the mean low
          (sHalf / this.extent) * 0.8,
          (sHalf / this.extent) * 0.8,
        )
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
    this.extent = Math.max(CAUSTIC_EXTENT, Math.ceil(e / 2) * 2)
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

  /** Sphere centre height, live from the tuning panel. */
  setSphereY(y: number) {
    ;(this.material.uniforms.uSphereCenter.value as THREE.Vector3).y = y
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
    this.aaMaterial.dispose()
    this.histA.dispose()
    this.histB.dispose()
    this.accumMaterial.dispose()
    this.splatGeometry.dispose()
  }
}
