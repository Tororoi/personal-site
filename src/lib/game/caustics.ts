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
import { waves, wavesGlsl, waveUniformA, waveUniformB } from './waves'

export const CAUSTIC_RESOLUTION = 2048
/**
 * The caustic domain covers the VIEW, not the ripple domain: light only
 * needs computing where the eye can see it, and the smaller extent buys
 * finer texels (80m / 2048 = 3.9cm) than matching the 100m ripple field
 * would. Receivers outside the domain read neutral light.
 */
export const CAUSTIC_EXTENT = 80
/**
 * ACTIVE-TILE splatting: the domain divides into TILES x TILES tiles and
 * only tiles over the receivers (the sphere, later fish) are splatted each
 * frame; the rest of the map stays at its black clear. A full-domain grid
 * at useful ray density (~one per ripple cell) costs ~640k vertices, far
 * past this GPU's ~200k/frame budget; receiver culling spends the
 * vertices only where landed light is actually visible.
 */
const TILES = 16
/** Rays per tile side: 5m tile / 48 = 0.104m spacing, the approved density. */
const TILE_GRID = 48
/** Vertex budget: cap on simultaneously active tiles (~140k verts). */
// Budget for the splat region. A LOW sun needs many more tiles: entry
// points sit sunward of the landing point by depth * tan(zenith), so the
// region grows fast as the sun sinks. At 60 the budget ran out around
// 15 degrees elevation and tiles were dropped in scan order — which
// showed as caustics vanishing from one quarter of a receiver, then the
// next, as the cut-off band swept across.
const MAX_TILES = 160
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
varying vec2 vOld;
varying vec2 vNew;
varying float vWeight;

${wavesGlsl()}

attribute vec2 aTile; // active tile origin, in tile units

void main() {
	vec2 domainUv = (aTile + uv) / ${TILES}.0;
	vec2 sxz = (domainUv - 0.5) * uExtent + uCenter;

	// The TRUE surface: full ambient Gerstner displacement plus analytic
	// tangent normals (this is the wave bands entering caustics,
	// band-limited by the grid), with the interactive ripples on top.
	// Rays start where the water actually is: a sphere crown standing
	// proud of a trough is above every ray origin and gets sky, not
	// caustics.
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
	// intersection here at all. The one exception is an entry point inside
	// an exposed crown — not water, so its beam carries no light, which is
	// precisely the crown's shadow in beam space. It still lands along its
	// geometric path so its triangles stay sane.
	vec3 origin = P;
	vec3 oc = origin - uSphereCenter;
	vWeight = dot(oc, oc) < uSphereRadius * uSphereRadius ? 0.0 : 1.0;
	float t = max((origin.y + uPlaneDepth) / max(-refr.y, 0.05), 0.0);
	vec3 land = origin + refr * t;

	vOld = sxz;
	vNew = land.xz;
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

const splatFragment = `
varying vec2 vOld;
varying vec2 vNew;
varying float vWeight;

void main() {
	// Differential-area brightness: how much refraction concentrated this
	// patch of light. 1 = neutral, > 1 focused, < 1 spread. Zero-weight
	// beams (crown-blocked) splat darkness by contributing nothing.
	float oldArea = length(dFdx(vOld)) * length(dFdy(vOld));
	float newArea = length(dFdx(vNew)) * length(dFdy(vNew));
	float brightness = clamp(oldArea / max(newArea, 1e-7), 0.0, 30.0);
	brightness *= vWeight;
	gl_FragColor = vec4(brightness, 0.0, 0.0, 1.0);
}`

export class CausticMap {
  /**
   * Sun diffusion, 0 clear .. 1 heavy overcast (from the sea preset's
   * sky.diffusion). Sets the source-size blur radius; weather transitions
   * can animate it. The micro-ripple (wind) spread will add to the same
   * radius in quadrature when it arrives.
   */
  diffusion = 0

  private target: THREE.WebGLRenderTarget
  private blurTarget: THREE.WebGLRenderTarget
  private blurQuarterA: THREE.WebGLRenderTarget
  private blurQuarterB: THREE.WebGLRenderTarget
  private material: THREE.ShaderMaterial
  private blurMaterial: THREE.ShaderMaterial
  private tileAttr: THREE.InstancedBufferAttribute
  private splatGeometry: THREE.InstancedBufferGeometry
  private splatScene: THREE.Scene
  private blurScene: THREE.Scene
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
        // MIPMAPPED so receivers can soften the pattern with depth: the
        // map is computed for ONE plane, and without a mip chain every
        // receiver reads it equally sharp no matter how deep it sits.
        // Sampling with a depth-proportional LOD bias is the cheap way to
        // get overlapping focal cones smearing out with distance.
        minFilter: THREE.LinearMipmapLinearFilter,
        magFilter: THREE.LinearFilter,
        generateMipmaps: true,
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

    const base = new THREE.PlaneGeometry(1, 1, TILE_GRID, TILE_GRID)
    const geo = new THREE.InstancedBufferGeometry()
    geo.index = base.index
    geo.setAttribute('position', base.getAttribute('position'))
    geo.setAttribute('uv', base.getAttribute('uv'))
    geo.setAttribute('aTile', this.tileAttr)
    geo.instanceCount = 0
    this.splatGeometry = geo

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
    const splatMesh = new THREE.Mesh(this.splatGeometry, this.material)
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
  }

  get texture(): THREE.Texture {
    return this.target.texture
  }

  /**
   * Splat the tiles covering the sphere's caustic footprint. Only objects
   * receive caustics now, so the active region is just the sphere's disc,
   * shifted along the sun's slant (rays enter the water upwind of where
   * they land) and padded for wave sway and refraction spread. The map
   * clears to BLACK — 0 means "no light reaches here" — and receivers
   * outside the splatted region must treat the map as dark too.
   */
  step(
    renderer: THREE.WebGLRenderer,
    rippleTexture: THREE.Texture,
    sunDir: THREE.Vector3,
    time: number,
  ) {
    const sphere = this.material.uniforms.uSphereCenter.value as THREE.Vector3
    const sphereR = this.material.uniforms.uSphereRadius.value as number

    // Surface entry points sit sunward of the landing point by roughly
    // depth * tan(sunZenith); refraction bends rays toward vertical so the
    // un-refracted tangent over-estimates, which is the safe direction.
    // Slant clamp. Below this the region would grow without bound as the
    // sun approaches the horizon; 0.3 (about 17 degrees) cut in while the
    // sun was still high enough to matter, freezing the region while the
    // real rays kept slanting away from it — receivers then sampled
    // unsplatted (black) map. Held lower now, with the receiver-side
    // border fade covering the last few degrees before the light dies.
    const sy = Math.max(sunDir.y, 0.12)
    const slantX = sunDir.x / sy
    const slantZ = sunDir.z / sy
    const depth = Math.max(-sphere.y, 0) + sphereR
    const cx = sphere.x + slantX * depth * 0.5
    const cz = sphere.z + slantZ * depth * 0.5
    const r =
      sphereR + Math.hypot(slantX, slantZ) * depth * 0.5 + 5

    // Mark tiles overlapped by the disc's bounding box — in DOMAIN
    // coordinates, since the domain now follows the boat. When the sphere
    // is far outside the travelling window the ranges go empty and the
    // splat simply skips, which is correct: its caustics are off-screen.
    const cc = this.material.uniforms.uCenter.value as THREE.Vector2
    const tileSize = CAUSTIC_EXTENT / TILES
    const half = CAUSTIC_EXTENT / 2
    let count = 0
    const attr = this.tileAttr.array as Float32Array
    // Cover a BOX CENTRED ON THE DOMAIN, as wide as the tile budget
    // allows, rather than a disc around the sphere. Beams only exist
    // where tiles are drawn, so a sphere-shaped budget lit a
    // sphere-shaped patch of sea and left everything else — the rainbow
    // card, the boat, most of the visible water — outside the pattern
    // with a hard edge where it stopped. The sphere is not special; the
    // VIEW is what needs caustics.
    const span = Math.min(TILES, Math.floor(Math.sqrt(MAX_TILES)))
    const mid = Math.floor(TILES / 2)
    const tx0 = Math.max(0, mid - Math.floor(span / 2))
    const tx1 = Math.min(TILES - 1, tx0 + span - 1)
    const tz0 = Math.max(0, mid - Math.floor(span / 2))
    const tz1 = Math.min(TILES - 1, tz0 + span - 1)
    for (let tz = tz0; tz <= tz1 && count < MAX_TILES; tz++) {
      for (let tx = tx0; tx <= tx1 && count < MAX_TILES; tx++) {
        attr[count * 2] = tx
        attr[count * 2 + 1] = tz
        count++
      }
    }
    this.tileAttr.needsUpdate = true
    this.splatGeometry.instanceCount = count
    // WORLD rect the splat actually covered this frame. The map is CLEAR
    // (zero) outside it, and zero reads as full caustic shadow — any
    // receiver sampling beyond the rect must fade to neutral instead.
    if (count > 0) {
      this.validRegion.set(
        cc.x - half + ((tx0 + tx1 + 1) / 2) * tileSize,
        cc.y - half + ((tz0 + tz1 + 1) / 2) * tileSize,
        ((tx1 - tx0 + 1) / 2) * tileSize,
        ((tz1 - tz0 + 1) / 2) * tileSize,
      )
    } else {
      this.validRegion.set(0, 0, 0, 0)
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

    // Sun-diffusion blur (see the shader comment). Radius = angular
    // spread x plane depth, capped at a practical kernel — the receiver
    // side's flatten term (uCausticFlat, Scene) carries heavy overcast
    // the rest of the way to featureless light.
    const sigmaMeters = Math.min(this.diffusion * 0.8, 0.62)
    const sigmaTexels = sigmaMeters / (CAUSTIC_EXTENT / CAUSTIC_RESOLUTION)
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

    renderer.autoClear = previousAutoClear
    renderer.setClearColor(this.savedClearColor, previousClearAlpha)
    renderer.setRenderTarget(previousTarget)
  }

  /** World rect (cx, cz, halfX, halfZ) the splat covered; empty = none. */
  readonly validRegion = new THREE.Vector4(0, 0, 0, 0)

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
    const texel = CAUSTIC_EXTENT / CAUSTIC_RESOLUTION
    ;(this.material.uniforms.uCenter.value as THREE.Vector2).set(
      Math.round(x / texel) * texel,
      Math.round(z / texel) * texel,
    )
    ;(this.material.uniforms.uRippleCenter.value as THREE.Vector2).copy(rippleCenter)
  }

  dispose() {
    this.target.dispose()
    this.blurTarget.dispose()
    this.blurQuarterA.dispose()
    this.blurQuarterB.dispose()
    this.material.dispose()
    this.blurMaterial.dispose()
    this.splatGeometry.dispose()
  }
}
