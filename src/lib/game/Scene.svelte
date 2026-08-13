<script lang="ts">
	import * as THREE from 'three';
	import { T, useTask, useThrelte } from '@threlte/core';
	import { onDestroy } from 'svelte';
	import { activeField, causticsGlsl, significantAmplitude, waves, wavesGlsl } from './waves';
	import {
		events,
		MAX_EVENTS,
		sampleOcean,
		update as updateWhitecaps,
		whitecapsGlsl,
		windTravel,
		windVector
	} from './whitecaps';
	import { injectRipple, RIPPLE_EXTENT, RippleSim, ripplesGlsl, setRippleClock } from './ripples';
	import { CAUSTIC_EXTENT, CAUSTIC_PLANE_DEPTH, CausticMap } from './caustics';
	import { emitImpactSpray, MAX_SPRAY, sprayParticles, updateSpray } from './spray';
	import { addFoam, FoamField, foamGlsl, FOAM_EXTENT } from './foam';
	import { computeEnv, DAY_SECONDS } from './env';
	import { game } from './state.svelte';

	let { active = true }: { active?: boolean } = $props();

	const { scene, renderer, camera } = useThrelte();

	const mobile = window.innerWidth < 720;
	// The signed-off wireframe tuning view is one URL away: /?wire (composes
	// with ?sea= and ?tod=). Default is now the solid translucent render.
	const urlParams = new URLSearchParams(window.location.search);
	const wireframe = urlParams.has('wire');
	// ?tod=0..1 sets the day phase at load (0.25 sunrise, 0.396 = 45 deg
	// sun in the south-east, 0.5 noon, 0.604 = 45 deg sun in the
	// south-west [crosswise side light, the default], 0.75 sunset).
	const todParam = urlParams.get('tod');
	if (todParam !== null) game.time = DAY_SECONDS * parseFloat(todParam);
	const zoom = mobile ? 18 : 26;

	// ---------- Water ----------
	// The plane is fitted to THIS window's actual ground footprint: ortho
	// zoom is fixed pixels-per-meter, so a bigger window sees more ocean.
	// The 0.71/1.34 coefficients come from the camera orientation (45 deg
	// azimuth, ~32 deg elevation): a screen half-width of w meters reaches
	// 0.71w in world x/z, a half-height of h reaches 1.34h. Fitting the
	// mesh to the frustum footprint IS the polygon cull: nothing outside
	// the window (plus the physics margin) is ever meshed.
	//
	// The margin is derived from the ACTIVE wave field instead of a fixed
	// guess: Gerstner sway pulls edge vertices inward by up to the sum of
	// per-wave sway amplitudes, and an elevated crest at the window edge
	// uncovers ground behind it by ~1.6x its height at our camera
	// elevation — the old flat 4m margin let storm seas reveal unrendered
	// corners.
	const SWAY_BOUND = waves.reduce((sum, w) => sum + w.q * w.amp, 0);
	const EDGE_MARGIN = 2 + SWAY_BOUND + 3.2 * significantAmplitude;
	function buildWaterGeometry() {
		const size =
			2 *
			(0.71 * (window.innerWidth / zoom / 2) +
				1.34 * (window.innerHeight / zoom / 2) +
				EDGE_MARGIN);
		// Quad size only limits displacement silhouettes now: shading is
		// smooth (analytic vertex slopes + per-pixel ripple gradients), so
		// the mesh can be far coarser than the old facet-shaded 0.2m
		// without visible faceting. Must stay under ~1/3 of the shortest
		// ripple wavelength.
		const segments = Math.min(
			Math.round(size / (mobile ? 0.6 : 0.5)),
			mobile ? 170 : 510
		);
		const geometry = new THREE.PlaneGeometry(size, size, segments, segments);
		geometry.rotateX(-Math.PI / 2);
		return geometry;
	}
	let waterGeometry = $state(buildWaterGeometry());

	// Window resizes rebuild the plane (debounced), so the water always
	// covers the CURRENT window instead of the mount-time one.
	let resizeTimer = 0;
	function onWindowResize() {
		clearTimeout(resizeTimer);
		resizeTimer = window.setTimeout(() => {
			waterGeometry.dispose();
			waterGeometry = buildWaterGeometry();
		}, 200);
	}
	window.addEventListener('resize', onWindowResize);

	const env0 = computeEnv(game.time / DAY_SECONDS);

	// Sun diffusion from the sea preset's cloud deck (waves.ts sky), 0
	// clear .. 1 heavy overcast. Feeds three effects of the SAME cause:
	// the caustic map's source-size blur (caustics.ts), the receiver-side
	// flatten that carries heavy overcast past the practical blur radius,
	// and the softening of the sun's glare on the water.
	const SUN_DIFFUSION = activeField.sky?.diffusion ?? 0;
	const CAUSTIC_FLAT = THREE.MathUtils.smoothstep(SUN_DIFFUSION, 0.35, 1.0);

	// ---- Wireframe tuning mode ----
	// Styling is deliberately stripped while the simulation is tuned: bare
	// wireframe over the site background, line brightness lifted at crests so
	// wave shape reads in stills. Lighting and the low-poly treatment return
	// after the sim is signed off (the old cel shader is in git history).
	const waterUniforms = {
		uTime: { value: 0 },
		// Held at 1 while tuning so the judged sea state is stable; the
		// weather system will own this multiplier later.
		uAmp: { value: 1 },
		// ABSOLUTE height scale, in meters: full line brightness at this
		// height, dimmest at its negative, for EVERY preset. Deliberately not
		// normalized per preset, so two sea states compare directly: a calm
		// sea correctly reads as mostly mid-brightness. Sized so the storm
		// preset's stacked peaks (~3m+) barely clip.
		uHeightScale: { value: 3.5 },
		// The wave field itself: uploaded from the same array the CPU sampler
		// reads, so the two twins cannot disagree about parameters.
		uWaveA: { value: waves.map((w) => new THREE.Vector4(w.dirX, w.dirZ, w.k, w.omega)) },
		uWaveB: { value: waves.map((w) => new THREE.Vector3(w.amp, w.q, w.phase)) },
		uLineColor: { value: new THREE.Color('#55c4fe') },
		uFogColor: { value: new THREE.Color('#0f131a') },
		uFogDensity: { value: 0.0075 },
		// Breaking-crest ("crashing") visualization: lines whiten as the
		// surface Jacobian drops. Foam begins below uFoamStart and saturates
		// at uFoamFull. J = 1 flat water, 0 pinched crest, < 0 folded/breaking.
		// Thresholds sit against the measured storm distribution (median J
		// ~1.2, p5 ~0.44, J < 0 on ~0.05% of the surface): onset where the
		// steepest few percent of crests live, saturated just above a true
		// fold, so breaking events read as bright flashes.
		uFoamColor: { value: new THREE.Color('#f4f9ff') },
		uFoamStart: { value: 0 },
		uFoamFull: { value: -0.12 },
		// Whitecap events, refreshed each frame from the same array the CPU
		// twin reads (see whitecaps.ts).
		uEventA: { value: Array.from({ length: MAX_EVENTS }, () => new THREE.Vector4()) },
		uEventB: { value: Array.from({ length: MAX_EVENTS }, () => new THREE.Vector4()) },
		// Mesh churn: the surface seethes where the Jacobian says it is
		// actively breaking. Tighter thresholds than the foam ramp: foam
		// marks "steep", churn marks "breaking right now".
		uChurnStart: { value: 0.28 },
		uChurnFull: { value: -0.15 },
		uChurnAmp: { value: 0.22 },
		// Multiplier on the UPWARD seethe component only, for both crest
		// churn and splash froth. Raises the erupting height of white water
		// without touching horizontal jitter or the wind push.
		uChurnLift: { value: 2.0 },
		// Wind's grip on the churn: uWind is refreshed each frame (gusts
		// included). Aniso amplifies the downwind seethe component; push
		// smears the churned mass downwind. Both are per m/s of wind, so
		// calm's 2 m/s barely registers and storm's 18 m/s throws water.
		uWind: { value: new THREE.Vector2() },
		uChurnWindAniso: { value: 0.04 },
		uChurnWindPush: { value: 0.18 },
		// Wind grip varies in space: sheltered below -0.4m (troughs), fully
		// exposed above 1m (crests); traveling gust patches briefly more than
		// double the grip (1 + uGustBoost) as they sweep downwind.
		uWindShelter: { value: new THREE.Vector2(-2.5, -1.0) },
		uGustBoost: { value: 0.2 },
		uWindTravel: { value: new THREE.Vector2() },
		// Gust pacing. uGustSize scales the patches (2 = twice as large, and
		// correspondingly rarer since fewer fit in the field); uGustRate is
		// how fast they sweep, as a fraction of wind speed (1 = ride the
		// wind; storm's 18 m/s crosses the view in ~3s at rate 1, ~7s at 0.45).
		uGustSize: { value: 1.6 },
		uGustRate: { value: 0.5 },
		// Max heading deviation a gust patch can carry, radians. Each patch
		// samples its own veer from a decorrelated field: ~0.4 = up to ~23
		// degrees off the global wind, either side.
		uGustVeer: { value: 0.4 },
		// Physics ripple field (ripples.ts): the interactive heightfield.
		// Texture re-pointed each frame after the sim step (ping-pong swap).
		uRippleTex: { value: null as THREE.Texture | null },
		uRippleCenter: { value: new THREE.Vector2(0, 0) },
		uRippleExtent: { value: RIPPLE_EXTENT },
		// Solid-mode water, pool-style (Wallace/jeantimex): a Fresnel blend
		// between transmitted water color and reflected sky, plus sun
		// specular. Facets facing the camera show the water; tilted facets
		// catch the sky and sparkle.
		uWaterColor: { value: new THREE.Color('#1a5876') },
		// Wallace-style reflected sky: a vertical gradient owned by the sea
		// preset (waves.ts sky), sampled along the reflected eye ray.
		uSkyZenith: { value: new THREE.Color(activeField.sky?.zenith ?? '#a8c8d8') },
		uSkyHorizon: { value: new THREE.Color(activeField.sky?.horizon ?? '#d5e3ea') },
		// CLARITY PINNED HIGH for caustic tuning: nearly transparent surface
		// so the underwater scene reads unobstructed. Restore toward ~0.78
		// when clarity becomes a weather/preset property.
		uAlphaBase: { value: 0.3 },
		// Live sun from the day/night cycle, updated per frame.
		uSunDir: { value: new THREE.Vector3(0.4, 1, 0.3) },
		uSunColor: { value: new THREE.Color('#fff2d0') },
		uSunI: { value: 1.2 },
		// Constant for the ortho camera: unit vector from scene toward camera.
		uViewDir: { value: new THREE.Vector3(34, 30, 34).normalize() },
		// Underwater raytrace (pool-style view refraction): the water
		// fragment draws the submerged scene itself, so it needs the same
		// receiver-lighting inputs as the sphere and backdrop materials.
		// These are the CANONICAL uniform objects; backdropUniforms and
		// sphereUniforms reference them, so one write per frame feeds all
		// three shaders.
		uLightColor: { value: new THREE.Color('#fff2d0') },
		uLightI: { value: 1.2 },
		uCausticMap: { value: null as THREE.Texture | null },
		uCausticCenter: { value: new THREE.Vector2(0, 0) },
		uCausticExtent: { value: CAUSTIC_EXTENT },
		uFloorColor: { value: new THREE.Color('#0a2e44') },
		uSphereColor: { value: new THREE.Color('#8f9ea6') },
		// Floaters join the underwater raytrace: each buoy's inverse world
		// matrix (refreshed every frame from its mesh) takes the refracted
		// ray into box space for a slab test, so submerged halves refract
		// and sway like everything else below the surface.
		uBuoyInv: {
			value: [new THREE.Matrix4(), new THREE.Matrix4(), new THREE.Matrix4()]
		},
		uBuoyColor: { value: new THREE.Color('#d95f43') },
		// Sun diffusion (see SUN_DIFFUSION above): glare softening in the
		// water fragment, and the caustic flatten in shadeUnderwater.
		uSunDiffusion: { value: SUN_DIFFUSION },
		uCausticFlat: { value: CAUSTIC_FLAT },
		// Persistent foam field (foam.ts): the thickness texture, sampled
		// at REST coordinates; re-pointed each frame after the sim step.
		uFoamTex: { value: null as THREE.Texture | null },
		uFoamCenter: { value: new THREE.Vector2(0, 0) },
		uFoamExtent: { value: FOAM_EXTENT },
		// Baked tiling web-skeleton distance field (set after first bake).
		uFoamWebTex: { value: null as THREE.Texture | null }
	};

	// The visible ocean "floor" depth; also the miss plane of the water's
	// underwater raytrace.
	const BACKDROP_DEPTH = 10;

	// Wet-side receiver shading, shared VERBATIM by the water's raytraced
	// underwater view and the sphere mesh's submerged branch: one tuning
	// surface, twins cannot drift. Hosts declare the uniforms (uSunDir,
	// uLightColor, uLightI, uCausticMap, uCausticCenter, uCausticExtent).
	// Constant ambient the caustics never touch; diffuse directional along
	// the REFRACTED sun; beam-space caustic lookup (see caustics.ts).
	const underwaterShadeGlsl = `
vec3 shadeUnderwater(vec3 P, vec3 normal, vec3 albedo, float depth) {
	vec3 sunN = normalize(uSunDir);
	vec3 refrLight = refract(-sunN, vec3(0.0, 1.0, 0.0), 0.7519);
	float inc = clamp(dot(normal, -refrLight), 0.0, 1.0);
	float depthLight = exp(-depth * 0.1);
	vec2 beamXZ = P.xz + refrLight.xz * ((${(-CAUSTIC_PLANE_DEPTH).toFixed(1)} - P.y) / refrLight.y);
	vec2 cuv = (beamXZ - uCausticCenter) / uCausticExtent + 0.5;
	float light = 1.0;
	if (cuv.x > 0.0 && cuv.x < 1.0 && cuv.y > 0.0 && cuv.y < 1.0) {
		light = texture2D(uCausticMap, cuv).r;
	}
	// Heavy overcast: past the map blur's practical radius, the extended
	// source washes the pattern (and its shadows) toward featureless light.
	light = mix(light, 1.0, uCausticFlat);
	// Direct light is shadow-modulated only (min with 1); fold brightness
	// arrives as the additive term, cosine-weighted to true irradiance.
	vec3 col = albedo * (0.45 + 0.5 * inc * depthLight * uLightI * min(light, 1.0));
	col += uLightColor * max(light - 1.0, 0.0) * uLightI * 0.8 * inc * depthLight;
	return col;
}`;

	// The wave-equation sim that owns uRippleTex's contents.
	const rippleSim = new RippleSim();

	// The foam thickness field that owns uFoamTex's contents. Stepped at
	// HALF frame rate: foam evolves on multi-second timescales, the
	// dt-aware step keeps every clock wall-clock true across skipped
	// frames, and the sim (the wave-sum probe especially) is one of the
	// larger recurring GPU passes.
	const foamField = new FoamField();
	let foamAccum = 0;
	let foamEven = false;

	// Forward-splat caustic map (pool-style differential area) over the
	// full wave surface, blurred by the preset's sun diffusion.
	const causticMap = new CausticMap();
	causticMap.diffusion = SUN_DIFFUSION;

	// Click to drop a ripple, pool-style. This is also the embryo of the
	// casting input: click -> raycast -> water point.
	const raycaster = new THREE.Raycaster();
	const clickNdc = new THREE.Vector2();
	const waterPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
	const clickPoint = new THREE.Vector3();
	function onPointerDown(event: PointerEvent) {
		const rect = renderer.domElement.getBoundingClientRect();
		clickNdc.set(
			((event.clientX - rect.left) / rect.width) * 2 - 1,
			-((event.clientY - rect.top) / rect.height) * 2 + 1
		);
		const cam = camera.current;
		if (!cam) return;
		raycaster.setFromCamera(clickNdc, cam);
		if (raycaster.ray.intersectPlane(waterPlane, clickPoint)) {
			injectRipple(clickPoint.x, clickPoint.z, 0.25, 0.2);
		}
	}
	renderer.domElement.addEventListener('pointerdown', onPointerDown);

	// The wireframe fragment is the tuning instrument; the solid fragment
	// is the first step toward the real look: translucent water whose
	// opacity falls off with depth, faceted shading so geometry reads.
	const solidFragment = `
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform vec3 uFoamColor;
uniform vec3 uWaterColor;
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform float uAlphaBase;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunI;
uniform vec3 uViewDir;
uniform vec3 uLightColor;
uniform float uLightI;
uniform sampler2D uCausticMap;
uniform vec2 uCausticCenter;
uniform float uCausticExtent;
uniform vec3 uFloorColor;
uniform vec3 uSphereColor;
uniform float uSunDiffusion;
uniform float uCausticFlat;
uniform float uTime;
uniform float uAmp;
uniform float uFoamStart;
uniform float uFoamFull;
uniform float uHeightScale;
varying float vHeight;
varying vec3 vWorld;
varying vec2 vRest;
varying vec2 vSlope;
varying float vOverhang;
varying float vPinchWhite;
varying float vViewZ;
varying float vJacobian;

// Must match the <T.Mesh> sphere placement and caustics.ts uSphereCenter.
const vec3 SPHERE_C = vec3(3.0, -6.0, 2.0);
const float SPHERE_R = 5.0;

uniform mat4 uBuoyInv[3];
uniform vec3 uBuoyColor;
// Half extents of buoyGeometry (BoxGeometry 0.5 x 0.9 x 0.5).
const vec3 BUOY_HALF = vec3(0.25, 0.45, 0.25);

${underwaterShadeGlsl}
${foamGlsl()}
${ripplesGlsl()}
${wavesGlsl()}

// Exact loop mask at FRAGMENT resolution (see the gate in main): one
// tangent loop yields both tests — the unnormalized Na.y IS the
// horizontal Jacobian determinant, and Na.y/|Na| is the tilt.
float pinchMask(vec2 restXZ) {
	float txx = 0.0;
	float txy = 0.0;
	float txz = 0.0;
	float tzy = 0.0;
	float tzz = 0.0;
	for (int i = 0; i < WAVE_COUNT; i++) {
		vec4 wa = uWaveA[i];
		vec3 wb = uWaveB[i];
		float theta = (restXZ.x * wa.x + restXZ.y * wa.y) * wa.z - wa.w * uTime + wb.z;
		float sn = sin(theta);
		float cs = cos(theta);
		float qak = wb.y * wb.x * uAmp * wa.z;
		float ak = wb.x * uAmp * wa.z;
		txx -= qak * wa.x * wa.x * sn;
		txy += ak * wa.x * cs;
		txz -= qak * wa.x * wa.y * sn;
		tzy += ak * wa.y * cs;
		tzz -= qak * wa.y * wa.y * sn;
	}
	vec3 Tu = vec3(1.0 + txx, txy, txz);
	vec3 Tv = vec3(txz, tzy, 1.0 + tzz);
	vec3 Na = cross(Tv, Tu);
	float ny = Na.y / max(length(Na), 0.0001);
	return max(1.0 - smoothstep(0.0, 0.04, Na.y), 1.0 - smoothstep(0.02, 0.12, ny));
}

// Ray vs a buoy's oriented box: slab test in the box's local frame.
// Returns the entering t (world units, both frames are rigid) or -1;
// writes the world-space face normal.
float buoyHit(mat4 inv, vec3 ro, vec3 rd, out vec3 nWorld) {
	vec3 o = (inv * vec4(ro, 1.0)).xyz;
	vec3 d = (inv * vec4(rd, 0.0)).xyz;
	vec3 invD = 1.0 / d;
	vec3 t0 = (-BUOY_HALF - o) * invD;
	vec3 t1 = (BUOY_HALF - o) * invD;
	vec3 tmin3 = min(t0, t1);
	vec3 tmax3 = max(t0, t1);
	float tN = max(max(tmin3.x, tmin3.y), tmin3.z);
	float tF = min(min(tmax3.x, tmax3.y), tmax3.z);
	if (tN > tF || tN < 0.0) return -1.0;
	// The entering face is the axis tN came from; its normal opposes the ray.
	vec3 nLocal = -sign(d) * step(vec3(tN), tmin3);
	// Rigid transform: v * mat3(inv) == transpose(mat3(inv)) * v == R * v.
	nWorld = normalize(nLocal * mat3(inv));
	return tN;
}

void main() {
	// SMOOTH shading: interpolated analytic wave slope + per-pixel ripple
	// slope from the sim texture (rings shade at texture resolution no
	// matter how coarse the mesh is). Churn zones keep the chaotic facet
	// normal — those facets ARE the boil's look.
	vec2 slope = vSlope + rippleShadeGrad(vWorld.xz);
	vec3 normal = normalize(vec3(-slope.x, 1.0, -slope.y));


	// Pool-style view refraction: the underwater scene is drawn BY the
	// water. Refract the eye ray at this facet's normal, intersect it with
	// the sphere (floor plane on a miss), and shade the hit with the SAME
	// shadeUnderwater the sphere mesh uses — so the submerged body sways
	// and shatters with every wave and ripple, while the dry crown
	// (rasterized normally above the surface) stays put, pencil-in-water
	// style.
	vec3 eye = -uViewDir;
	vec3 refr = refract(eye, normal, 0.7519);
	vec3 oc = vWorld - SPHERE_C;
	float b = dot(oc, refr);
	float c = dot(oc, oc) - SPHERE_R * SPHERE_R;
	float disc = b * b - c;
	float tHit = -1.0;
	vec3 hitN = vec3(0.0, 1.0, 0.0);
	vec3 albedo = uSphereColor;
	if (disc > 0.0) {
		float th = -b - sqrt(disc);
		if (th > 0.0) {
			tHit = th;
			hitN = normalize(vWorld + refr * th - SPHERE_C);
		}
	}
	// Buoys are in the intersection list too; nearest hit wins.
	for (int i = 0; i < 3; i++) {
		vec3 bn;
		float tb = buoyHit(uBuoyInv[i], vWorld, refr, bn);
		if (tb > 0.0 && (tHit < 0.0 || tb < tHit)) {
			tHit = tb;
			hitN = bn;
			albedo = uBuoyColor;
		}
	}
	vec3 transmitted;
	if (tHit > 0.0) {
		vec3 P = vWorld + refr * tHit;
		transmitted = shadeUnderwater(P, hitN, albedo, max(vWorld.y - P.y, 0.0));
	} else {
		// Same flat shading as the backdrop mesh, which this raytrace has
		// effectively replaced under the water.
		transmitted = uFloorColor * (0.1 + 0.32 * uLightI);
	}
	// The tint the old translucent layer contributed by alpha blending,
	// now composed in-shader; uAlphaBase is still the clarity knob.
	transmitted = mix(transmitted, uWaterColor, uAlphaBase);

	// Wallace-style reflection: reflect the eye ray and sample the SKY in
	// that direction — the preset's vertical gradient with the sun's glare
	// living IN the sky — instead of a single flat sky color. His fresnel
	// too: a substantial base reflectivity rising to 1 at grazing, which
	// is what makes water read as a mirror at low angles.
	float facing = clamp(dot(normal, uViewDir), 0.0, 1.0);
	float fresnel = mix(0.25, 1.0, pow(1.0 - facing, 3.0));
	vec3 reflectedRay = reflect(eye, normal);
	vec3 skyCol = mix(uSkyHorizon, uSkyZenith, clamp(reflectedRay.y, 0.0, 1.0));
	// The glare is the sun's mirror image: a diffused (clouded) sun makes
	// it broader and dimmer, same cause as the caustic blur.
	float glareExp = mix(350.0, 30.0, uSunDiffusion);
	float glareGain = 2.0 * (1.0 - 0.85 * uSunDiffusion);
	skyCol += uSunColor * uSunI * glareGain * pow(max(dot(reflectedRay, normalize(uSunDir)), 0.0), glareExp);
	vec3 col = mix(transmitted, skyCol, fresnel);

	// Whiteness: the active boil (churn/ripple seethe) plus PERSISTENT
	// foam residue (foam.ts) — patches left behind by the strongest
	// breaks and by spray landings, dying on their own clock with a
	// webbing tear-off. No whiteness is slaved to the instantaneous wave
	// shape: foam that appeared and vanished with each passing peak read
	// as unmotivated.
	// TEMP natural-view: ONLY the looping mesh is white. The vertex mask
	// is near-binary and interpolates as triangular wedges (the fold is a
	// sub-quad feature), so pixels in the TRANSITION band re-evaluate the
	// exact mask at fragment resolution — a thin sliver of the screen
	// pays the wave loop, and the ribbon edges come out curved.
	float foam = vPinchWhite;
	if (foam > 0.01 && foam < 0.99) foam = pinchMask(vRest);
	// Persistent foam residue (foam.ts): deposits from droplet landings,
	// dissipating on their own clock with the webbing tear-off.
	foam = max(foam, foamWeb(vRest, foamThicknessAt(vRest), vJacobian));
	col = mix(col, uFoamColor, foam);

	float fog = clamp(1.0 - exp(-uFogDensity * uFogDensity * vViewZ * vViewZ), 0.0, 1.0);
	col = mix(col, uFogColor, fog);

	gl_FragColor = vec4(col, 1.0);
}`;

	const waterMaterial = new THREE.ShaderMaterial({
		uniforms: waterUniforms,
		wireframe,
		// Solid water is OPAQUE now: it raytraces its own underwater view,
		// so nothing rasterized below the surface should show through.
		transparent: false,
		// Folded (looping) crests invert their triangle winding — with
		// default FrontSide culling the rolling tongue of a breaking wave
		// was never rendered at all, only the crease seam behind it. Same
		// lesson the caustic splat learned.
		side: THREE.DoubleSide,
		vertexShader: `
uniform float uTime;
uniform float uAmp;
varying float vViewZ;
varying float vHeight;
varying float vJacobian;
varying vec3 vWorld;
varying vec2 vRest;
varying vec2 vSlope;
varying float vOverhang;
varying float vPinchWhite;

${wavesGlsl()}
${whitecapsGlsl()}
${ripplesGlsl()}

void main() {
	// Sample in world space: when the mesh recenters on the drifting boat,
	// the wave field stays pinned to the world instead of following it.
	vec4 world = modelMatrix * vec4(position, 1.0);
	vec3 p = world.xyz + waveDisplacement(world.xz, uTime, uAmp);
	applyWhitecaps(p, world.xz, uTime);
	vHeight = p.y - world.y;
	vJacobian = waveJacobian(world.xz, uTime, uAmp);
	// TEMP natural-view: ONLY the LOOPING mesh is white. Two strict,
	// local tests, no neighborhood guessing:
	//  - J < 0: the horizontal rest->display mapping is INVERTED here —
	//    this vertex is on the surface segment tucked between the fold
	//    lines, i.e. inside the loop itself;
	//  - overhang: the (normalized) surface normal has tipped past
	//    vertical — the rolling face of the tongue.
	// Elevated-but-unfolded water near a pinch stays dark.
	// Analytic ambient-wave SLOPE (the caustic splat's tangent
	// construction): interpolated per pixel, it shades the swell as a
	// smooth curved surface instead of per-triangle facets — the facet
	// look was screen-derivative shading, where the triangle is the
	// shading unit. Ripple slopes join per-pixel in the fragment.
	float txx = 0.0;
	float txy = 0.0;
	float txz = 0.0;
	float tzy = 0.0;
	float tzz = 0.0;
	for (int i = 0; i < WAVE_COUNT; i++) {
		vec4 wa = uWaveA[i];
		vec3 wb = uWaveB[i];
		float theta = (world.x * wa.x + world.z * wa.y) * wa.z - wa.w * uTime + wb.z;
		float sn = sin(theta);
		float cs = cos(theta);
		float qak = wb.y * wb.x * uAmp * wa.z;
		float ak = wb.x * uAmp * wa.z;
		txx -= qak * wa.x * wa.x * sn;
		txy += ak * wa.x * cs;
		txz -= qak * wa.x * wa.y * sn;
		tzy += ak * wa.y * cs;
		tzz -= qak * wa.y * wa.y * sn;
	}
	vec3 Tu = vec3(1.0 + txx, txy, txz);
	vec3 Tv = vec3(txz, tzy, 1.0 + tzz);
	vec3 Na = cross(Tv, Tu);
	vSlope = -Na.xz / max(Na.y, 0.2);
	// NORMALIZED normal y: -> 0 means the surface tips vertical, < 0
	// means it OVERHANGS — the visible rolling tongue of a breaking
	// loop, which the Jacobian ramp misses (J marks the compressed seam
	// hidden INSIDE the fold, not the thrown water rolling over it).
	// Raw Na.y would be wrong here: unnormalized, it IS approximately
	// the Jacobian determinant again.
	vOverhang = Na.y / max(length(Na), 0.0001);
	vPinchWhite = max(
		1.0 - smoothstep(0.0, 0.04, vJacobian),
		1.0 - smoothstep(0.02, 0.12, vOverhang)
	);
	// Sample ripples at the DISPLACED position: Gerstner slides vertices
	// horizontally by meters, and the field is indexed by true world
	// coordinates. Sampling at the rest position would paint rings onto the
	// water's material coordinates, making them swim with the passing waves
	// instead of staying where the object poked. Ripples are pure smooth
	// displacement, no whiteness.
	applyRipples(p, p.xz);
	vWorld = p;
	// Rest (material) coordinates for surface-riding decals: foam is
	// anchored to the WATER, not the world, so it must be sampled in the
	// frame that sways with the surface.
	vRest = world.xz;
	vec4 view = viewMatrix * vec4(p, 1.0);
	vViewZ = -view.z;
	gl_Position = projectionMatrix * view;
}`,
		fragmentShader: `
uniform vec3 uLineColor;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uHeightScale;
uniform vec3 uFoamColor;
uniform float uFoamStart;
uniform float uFoamFull;
varying float vViewZ;
varying float vHeight;
varying float vJacobian;

void main() {
	// Brighter lines on crests, dimmer in troughs. vHeight is meters above
	// still water; uHeightScale is an absolute reference, not per-preset, so
	// brightness is comparable across sea states.
	float hn = clamp(vHeight / uHeightScale * 0.5 + 0.5, 0.0, 1.0);
	vec3 col = uLineColor * (0.35 + 0.9 * hn);

	// Churn only for now: the Jacobian foam ramp is temporarily disabled so
	// the churn reads in isolation. To restore it:
	// float foam = 1.0 - smoothstep(uFoamFull, uFoamStart, vJacobian);
	float foam = 0.0;
	col = mix(col, uFoamColor, foam);

	// Distance fade into the page background, doubling as moire control.
	float fog = 1.0 - exp(-uFogDensity * uFogDensity * vViewZ * vViewZ);
	col = mix(col, uFogColor, clamp(fog, 0.0, 1.0));

	gl_FragColor = vec4(col, 1.0);
}`
	});
	if (!wireframe) waterMaterial.fragmentShader = solidFragment;

	// ---------- Shared underwater uniforms ----------
	// Historically the backdrop plane's material; the plane itself is gone
	// (the opaque water raytraces its own floor at BACKDROP_DEPTH), but
	// this object remains the uniform hub the sphere material references.
	const backdropUniforms = {
		// Shared uniform OBJECTS with the water material: one write per
		// frame updates both shaders.
		uTime: waterUniforms.uTime,
		uAmp: waterUniforms.uAmp,
		uWaveA: waterUniforms.uWaveA,
		uWaveB: waterUniforms.uWaveB,
		uSunDir: waterUniforms.uSunDir,
		uFogColor: waterUniforms.uFogColor,
		uFogDensity: waterUniforms.uFogDensity,
		// Shared canonical objects living on waterUniforms (see there): one
		// write per frame feeds the water raytrace, backdrop and sphere.
		uFloorColor: waterUniforms.uFloorColor,
		uLightColor: waterUniforms.uLightColor,
		uLightI: waterUniforms.uLightI,
		uDepth: { value: BACKDROP_DEPTH },
		// Ripple field texture, re-pointed each frame.
		uRippleCTex: { value: null as THREE.Texture | null },
		uRippleCCenter: { value: new THREE.Vector2(0, 0) },
		uRippleCExtent: { value: RIPPLE_EXTENT },
		uCausticMap: waterUniforms.uCausticMap,
		uCausticCenter: waterUniforms.uCausticCenter,
		uCausticExtent: waterUniforms.uCausticExtent
	};
	// No backdrop MESH anymore: since the water went opaque and raytraces
	// its own floor color, the backdrop plane was 100% occluded — a
	// full-screen quad of dead fill every frame. backdropUniforms remains
	// as the shared-uniform hub the sphere material references.

	// Caustic tuning prop: a large pale sphere under the water. Its
	// curvature, sun-facing shading and depth gradient are what make
	// caustics read as LIGHT striking a surface instead of a flat pattern.
	// Stand-in for the fish/whale-shark backs that will receive the same
	// causticAt() term.
	const sphereGeometry = new THREE.SphereGeometry(5, 64, 48);
	const sphereUniforms = {
		uTime: waterUniforms.uTime,
		uAmp: waterUniforms.uAmp,
		uWaveA: waterUniforms.uWaveA,
		uWaveB: waterUniforms.uWaveB,
		uSunDir: waterUniforms.uSunDir,
		uFogColor: waterUniforms.uFogColor,
		uFogDensity: waterUniforms.uFogDensity,
		uLightColor: backdropUniforms.uLightColor,
		uLightI: backdropUniforms.uLightI,
		uRippleCTex: backdropUniforms.uRippleCTex,
		uRippleCCenter: backdropUniforms.uRippleCCenter,
		uRippleCExtent: backdropUniforms.uRippleCExtent,
		uCausticMap: backdropUniforms.uCausticMap,
		uCausticCenter: backdropUniforms.uCausticCenter,
		uCausticExtent: backdropUniforms.uCausticExtent,
		uSphereColor: waterUniforms.uSphereColor,
		uCausticFlat: waterUniforms.uCausticFlat
	};
	const sphereMaterial = new THREE.ShaderMaterial({
		uniforms: sphereUniforms,
		vertexShader: `
uniform float uTime;
uniform float uAmp;
varying vec3 vWorld;
varying vec3 vNormal;
varying float vViewZ;
varying float vWaterY;

${wavesGlsl()}

void main() {
	vec4 world = modelMatrix * vec4(position, 1.0);
	vWorld = world.xyz;
	vNormal = mat3(modelMatrix) * normal;
	// The ACTUAL water surface above this vertex, not the resting plane:
	// one fixed-point step undoes the Gerstner horizontal sway, same
	// inversion the CPU sampler uses. Computed per VERTEX: the waterline
	// varies at wave scale (meters), far smoother than the mesh, and the
	// per-pixel version was two full wave sums for every sphere pixel.
	vec3 D = waveDisplacement(world.xz, uTime, uAmp);
	D = waveDisplacement(world.xz - D.xz, uTime, uAmp);
	vWaterY = D.y;
	vec4 view = viewMatrix * world;
	vViewZ = -view.z;
	gl_Position = projectionMatrix * view;
}`,
		fragmentShader: `
uniform vec3 uSunDir;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform vec3 uLightColor;
uniform float uLightI;
uniform vec3 uSphereColor;
uniform sampler2D uCausticMap;
uniform vec2 uCausticCenter;
uniform float uCausticExtent;
uniform float uCausticFlat;
varying vec3 vWorld;
varying vec3 vNormal;
varying float vViewZ;
varying float vWaterY;

${underwaterShadeGlsl}

void main() {
	vec3 normal = normalize(vNormal);
	vec3 sun = normalize(uSunDir);

	// True waterline interpolated from the vertex stage (see vertex
	// shader): a crown standing proud of a storm trough is genuinely
	// DRY - lit by direct sun, no caustics, no depth dimming.
	float waterY = vWaterY;
	float submerged = clamp((waterY - vWorld.y) / 0.35 + 0.5, 0.0, 1.0);

	// --- Dry branch: direct sun with soft wrap so the terminator doesn't
	// slice a hard line across the crown.
	float wrap = clamp((dot(normal, sun) + 0.4) / 1.4, 0.0, 1.0);
	vec3 dry = uSphereColor * (0.3 + 0.75 * wrap * uLightI);

	// --- Wet branch: shadeUnderwater (shared with the water raytrace, see
	// its definition for the lighting model). Only reached by fragments
	// the opaque water surface doesn't cover — i.e. the thin waterline
	// blend band on an exposed crown.
	vec3 wet = shadeUnderwater(vWorld, normal, uSphereColor, max(waterY - vWorld.y, 0.0));

	vec3 col = mix(dry, wet, submerged);

	float fog = clamp(1.0 - exp(-uFogDensity * uFogDensity * vViewZ * vViewZ), 0.0, 1.0);
	col = mix(col, uFogColor, fog);
	gl_FragColor = vec4(col, 1.0);
}`
	});

	// ---------- Placeholder floaters (prove the CPU sampler matches the GPU) ----------

	const toonGradient = new THREE.DataTexture(
		new Uint8Array([110, 190, 255]),
		3,
		1,
		THREE.RedFormat
	);
	toonGradient.minFilter = THREE.NearestFilter;
	toonGradient.magFilter = THREE.NearestFilter;
	toonGradient.needsUpdate = true;

	const buoyGeometry = new THREE.BoxGeometry(0.5, 0.9, 0.5);
	const buoyMaterial = new THREE.MeshToonMaterial({
		color: '#d95f43',
		gradientMap: toonGradient
	});

	// Ballistic spray clumps (spray.ts): one instanced low-poly droplet
	// mesh, matrices rewritten each frame from the particle pool. Dead
	// slots collapse to scale 0.
	// Detail 1: rounder clumps (the big cover boils read as boulders at
	// detail 0) while staying low-poly.
	const sprayGeometry = new THREE.OctahedronGeometry(1, 1);
	// Plain solid clumps (mist is a separate system). Fog uniforms are
	// SHARED with the water material (same objects) so preset changes
	// propagate — unfogged particles read whiter than the foam below.
	const sprayMaterial = new THREE.ShaderMaterial({
		uniforms: {
			uColor: { value: new THREE.Color('#eef6fc') },
			uFogColor: waterUniforms.uFogColor,
			uFogDensity: waterUniforms.uFogDensity
		},
		vertexShader: `
varying float vViewZ;
void main() {
	vec4 view = viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0);
	vViewZ = -view.z;
	gl_Position = projectionMatrix * view;
}`,
		fragmentShader: `
uniform vec3 uColor;
uniform vec3 uFogColor;
uniform float uFogDensity;
varying float vViewZ;
void main() {
	float fog = clamp(1.0 - exp(-uFogDensity * uFogDensity * vViewZ * vViewZ), 0.0, 1.0);
	gl_FragColor = vec4(mix(uColor, uFogColor, fog), 1.0);
}`
	});
	const sprayMesh = new THREE.InstancedMesh(sprayGeometry, sprayMaterial, MAX_SPRAY);
	sprayMesh.frustumCulled = false;
	sprayMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
	const sprayDummy = new THREE.Object3D();

	// y/vy: vertical state for gravity-limited falling. Buoyancy is instant
	// upward (rising water carries the float), but when a crest drops away
	// faster than gravity can pull, the buoy separates and falls
	// ballistically until the surface catches it again.
	// y/vy: vertical state. tx/tz: tilt (horizontal components of the up
	// vector), wx/wz: tilt velocity, for the bottom-heavy pendulum dynamics.
	// pw: previous waterline, for the surface's rise rate. lt: time of the
	// last directional tip splash (throttle).
	const buoys = [
		{ x: 4, z: -3, y: 0, vy: 0, tx: 0, tz: 0, wx: 0, wz: 0, pw: 0, lt: -10 },
		{ x: -7, z: 5, y: 0, vy: 0, tx: 0, tz: 0, wx: 0, wz: 0, pw: 0, lt: -10 },
		{ x: 9, z: 8, y: 0, vy: 0, tx: 0, tz: 0, wx: 0, wz: 0, pw: 0, lt: -10 }
	];
	let buoyMeshes = $state<(THREE.Mesh | undefined)[]>([]);

	// Disturbance hierarchy: the crest-fall splashdown is THE event; all
	// other interactions sit far below it. Tip splashes are small,
	// one-sided, and throttled; ambient bobbing barely registers.
	const TIP_SPLASH_THRESHOLD = 2.0; // tilt speed (1/s) that counts as digging in
	const TIP_SPLASH_COOLDOWN = 0.3; // seconds between tip splashes per buoy
	const TIP_RIM = 0.38; // meters: splash lands off the rim, not the center

	const BUOY_GRAVITY = 9.8; // m/s^2: the fall-rate clamp
	// Cap on vertical velocity carried out of the water, so a violent crest
	// can toss a buoy, but only modestly.
	const BUOY_MAX_CARRY = 3.5;

	// Bottom-heavy pendulum tilt: the ballast is a righting spring toward
	// the water-slope target, and angular momentum makes the buoy swing past
	// and rock back instead of easing to a stop.
	const BUOY_TILT = 1.2; // slope exaggeration so tilt reads at ortho distance
	// Righting strength (spring, 1/s^2). sqrt of this is the rock frequency:
	// 30 = ~1.1s per full rock, a small ballasted float.
	const BUOY_RIGHTING = 60;
	// Damping ratio: < 1 is underdamped. 0.25 = swings past and rocks 2-3
	// times before settling; raise toward 1 for a heavier, deader float.
	const BUOY_SWING_DAMPING = 0.25;
	// Airborne there is no water to push against: momentum carries the tilt,
	// trimmed only by this light air drag (1/s).
	const BUOY_AIR_DRAG = 0.5;
	const UP = new THREE.Vector3(0, 1, 0);
	const buoyNormal = new THREE.Vector3();

	// ---------- Contact foam ----------
	// Where an object meets the surface, aerated water collects: a dense
	// collar of foam refreshed while contact lasts (the field's decay
	// erases it a few seconds after contact ends). Buoys get a hull
	// collar; the sphere gets its TRUE waterline circle — per angle, the
	// radius where the wave surface crosses the sphere's crown, found by
	// bisection — which only exists while the crown pokes above the
	// local surface.
	const CONTACT_FOAM_INTERVAL = 0.5;
	let contactFoamClock = 0;
	// Must match the <T.Mesh> sphere placement and the shader constants.
	const SPHERE_CX = 3;
	const SPHERE_CY = -6;
	const SPHERE_CZ = 2;
	const SPHERE_CR = 5;
	function depositContactFoam(t: number) {
		for (const b of buoys) {
			const s = sampleOcean(b.x, b.z, t, 1, 1);
			// Touching = riding the surface, not tossed clear of it.
			if (Math.abs(b.y - (s.height + 0.15)) > 0.5) continue;
			for (let k = 0; k < 6; k++) {
				const a = (k / 6) * Math.PI * 2;
				addFoam(
					b.x - s.swayX + Math.cos(a) * 0.3,
					b.z - s.swayZ + Math.sin(a) * 0.3,
					0.14,
					0.9
				);
			}
		}

		const crown = sampleOcean(SPHERE_CX, SPHERE_CZ, t, 1, 1);
		if (crown.height >= SPHERE_CY + SPHERE_CR) return;
		const ANGLES = 14;
		for (let k = 0; k < ANGLES; k++) {
			const a = (k / ANGLES) * Math.PI * 2;
			const dx = Math.cos(a);
			const dz = Math.sin(a);
			// Bisect: inside the waterline the surface sits below the crown
			// (exposed), outside it sits above; the crossing is the contact.
			let lo = 0;
			let hi = SPHERE_CR - 0.01;
			for (let i = 0; i < 6; i++) {
				const mid = (lo + hi) / 2;
				const s = sampleOcean(SPHERE_CX + dx * mid, SPHERE_CZ + dz * mid, t, 1, 1);
				const ySphere = SPHERE_CY + Math.sqrt(Math.max(SPHERE_CR * SPHERE_CR - mid * mid, 0));
				if (s.height < ySphere) lo = mid;
				else hi = mid;
			}
			const r = (lo + hi) / 2;
			const s = sampleOcean(SPHERE_CX + dx * r, SPHERE_CZ + dz * r, t, 1, 1);
			const spacing = (2 * Math.PI * Math.max(r, 0.5)) / ANGLES;
			addFoam(
				SPHERE_CX + dx * r - s.swayX,
				SPHERE_CZ + dz * r - s.swayZ,
				Math.max(0.16, spacing * 0.4),
				0.95
			);
		}
	}

	// The whitewater churn is mesh displacement in the water shader, not
	// particles; see applyChurn in whitecaps.ts. Spray was removed: revisit
	// with the styled render if the storm still wants it.

	// ---------- Scene environment ----------

	// Constant page-background ground while tuning; the env palette resumes
	// ownership of these when the styled shading returns.
	const background = new THREE.Color('#0f131a');
	scene.background = background;
	const fog = new THREE.FogExp2(background.getHex(), 0.0075);
	scene.fog = fog;

	let sun = $state<THREE.DirectionalLight>();
	let ambient = $state<THREE.AmbientLight>();

	// ---------- Simulation loop: fixed step, free-running render ----------

	const STEP = 1 / 60;
	let accumulator = 0;
	let waveTime = 0;

	const task = useTask(
		(delta) => {
			accumulator = Math.min(accumulator + delta, 0.25);
			while (accumulator >= STEP) {
				accumulator -= STEP;
				waveTime += STEP;
				game.time = (game.time + STEP) % DAY_SECONDS;
				// Whitecap events and ballistic spray advance on the fixed
				// step too (spray after whitecaps: it reads the freshly
				// scanned break events).
				setRippleClock(waveTime);
				updateWhitecaps(STEP, waveTime);
				updateSpray(STEP, waveTime);
				contactFoamClock += STEP;
				if (contactFoamClock >= CONTACT_FOAM_INTERVAL) {
					contactFoamClock = 0;
					// depositContactFoam(waveTime);
				}
			}

			const env = computeEnv(game.time / DAY_SECONDS);

			waterUniforms.uTime.value = waveTime;

			const wind = windVector(waveTime);
			waterUniforms.uWind.value.set(wind.x, wind.z);
			waterUniforms.uWindTravel.value.set(windTravel.x, windTravel.z);

			// Mirror the event array into the shader uniforms.
			for (let i = 0; i < MAX_EVENTS; i++) {
				const e = events[i];
				waterUniforms.uEventA.value[i].set(e.x, e.z, e.birth, e.sigma);
				waterUniforms.uEventB.value[i].set(e.cap, e.breakDuration, 0, 0);
			}
			// One wave-equation iteration, then point the water shader at the
			// freshly written side of the ping-pong pair.
			rippleSim.step(renderer);
			waterUniforms.uRippleTex.value = rippleSim.texture;
			backdropUniforms.uRippleCTex.value = rippleSim.texture;
			causticMap.step(renderer, rippleSim.texture, waterUniforms.uSunDir.value, waveTime);
			backdropUniforms.uCausticMap.value = causticMap.texture;
			// One foam-field update per TWO frames (decay + diffusion +
			// drift + queued deposits), then point the water shader at the
			// fresh side.
			foamAccum += Math.min(delta, 0.1);
			foamEven = !foamEven;
			if (foamEven) {
				foamField.step(renderer, wind.x, wind.z, waveTime, foamAccum);
				foamAccum = 0;
				waterUniforms.uFoamTex.value = foamField.texture;
				waterUniforms.uFoamWebTex.value = foamField.webTexture;
			}

			waterUniforms.uSunDir.value.set(env.lightDir[0], env.lightDir[1], env.lightDir[2]);
			waterUniforms.uSunColor.value.setRGB(env.light[0], env.light[1], env.light[2]);
			waterUniforms.uSunI.value = env.lightIntensity;
			backdropUniforms.uFloorColor.value.setRGB(
				env.waterDeep[0],
				env.waterDeep[1],
				env.waterDeep[2]
			);
			backdropUniforms.uLightColor.value.setRGB(env.light[0], env.light[1], env.light[2]);
			backdropUniforms.uLightI.value = env.lightIntensity;
			if (sun) {
				sun.position.set(env.lightDir[0] * 80, env.lightDir[1] * 80, env.lightDir[2] * 80);
				sun.color.setRGB(env.light[0], env.light[1], env.light[2], THREE.SRGBColorSpace);
				sun.intensity = env.lightIntensity * 2;
			}
			if (ambient) {
				ambient.color.setRGB(env.ambient[0], env.ambient[1], env.ambient[2], THREE.SRGBColorSpace);
				ambient.intensity = env.ambientIntensity * 1.6;
			}

			// Clamped so a background-tab hiccup can't integrate a huge fall.
			const buoyDt = Math.min(delta, 0.1);
			for (let i = 0; i < buoys.length; i++) {
				const mesh = buoyMeshes[i];
				if (!mesh) continue;
				const b = buoys[i];
				const { x, z } = b;
				// ampScale 1 matches the water's tuning-mode uAmp; both must
				// change together or the floats detach from the surface.
				// sampleOcean includes whitecap crumble: a breaking crest
				// passing under a float drops it with the collapsing water.
				const surface = sampleOcean(x, z, waveTime);
				const waterline = surface.height + 0.15;
				// How fast the surface itself is moving vertically, clamped
				// against first-frame garbage.
				const riseRate =
					buoyDt > 0
						? THREE.MathUtils.clamp((waterline - b.pw) / buoyDt, -6, 6)
						: 0;
				b.pw = waterline;

				const px = x + surface.swayX * 0.4;
				const pz = z + surface.swayZ * 0.4;

				let airborne = b.y > waterline + 0.001;
				if (!airborne) {
					// In the water: buoyancy wins instantly, ride the surface.
					// Track the surface's climb rate (capped) so leaving a
					// crest carries believable momentum into the fall.
					if (buoyDt > 0) {
						b.vy = Math.min((waterline - b.y) / buoyDt, BUOY_MAX_CARRY);
					}
					b.y = waterline;
					// The hull pushing through the water is a continuous
					// disturbance, but a QUIET one: quadratic in rise rate
					// so gentle bobbing injects nearly nothing, and capped
					// far below a splashdown. Displacement only; froth is
					// reserved for actual impacts.
					const breaking = THREE.MathUtils.clamp((0.4 - surface.jacobian) / 0.8, 0, 1);
					const agitation = Math.min(riseRate * riseRate * 0.005 + breaking * 0.012, 0.035);
					if (agitation > 0.004) injectRipple(px, pz, 0.45, agitation);
				} else {
					// Off the crest: the surface fell faster than gravity
					// allows. Fall ballistically until the water catches us.
					b.vy -= BUOY_GRAVITY * buoyDt;
					b.y += b.vy * buoyDt;
					if (b.y <= waterline) {
						// Splashdown: one hard poke scaled by the relative
						// speed of buoy and water. The expanding ring, the
						// rebound column, and any interference with other
						// ripples all come from the wave equation.
						const impact = Math.abs(riseRate - b.vy);
						if (impact > 1.2) {
							const amp = Math.min((impact - 1.2) / 3.5, 1);
							// Two effects: the displacement hat (water pushed
							// aside, wave equation) and the airborne crown
							// (ballistic spray, spray.ts) whose landings leave
							// the foam. No froth boil: buoys rely on splash +
							// foam alone.
							injectRipple(px, pz, 0.8, 0.12 + amp * 0.35);
							emitImpactSpray(waveTime, px, pz, 0, 0, amp);
						}
						b.y = waterline;
						b.vy = 0;
						airborne = false;
					}
				}

				// Ride the surface, plus a fraction of the Gerstner orbital motion
				// as horizontal sway: anchored floats trace small ellipses.
				mesh.position.set(px, b.y, pz);

				// Bottom-heavy pendulum tilt. In water, the ballast springs the
				// buoy toward the water-slope target (gradient over a 1.2m
				// baseline: rides the swell, ignores ripple); its momentum
				// swings it past and rocks it back. Airborne there is no
				// righting force at all: the tilt coasts on momentum with
				// light air drag, so splashdown lands at whatever angle the
				// toss left, and the mismatch excites the next rock. All
				// forces act on tx/tz (up-vector horizontal components).
				let targetX = 0;
				let targetZ = 0;
				if (!airborne) {
					const gradX =
						(sampleOcean(x + 0.6, z, waveTime, 1, 1).height -
							sampleOcean(x - 0.6, z, waveTime, 1, 1).height) /
						1.2;
					const gradZ =
						(sampleOcean(x, z + 0.6, waveTime, 1, 1).height -
							sampleOcean(x, z - 0.6, waveTime, 1, 1).height) /
						1.2;
					targetX = -gradX * BUOY_TILT;
					targetZ = -gradZ * BUOY_TILT;
				}
				const spring = airborne ? 0 : BUOY_RIGHTING;
				const drag = airborne
					? BUOY_AIR_DRAG
					: 2 * BUOY_SWING_DAMPING * Math.sqrt(BUOY_RIGHTING);
				b.wx += (spring * (targetX - b.tx) - drag * b.wx) * buoyDt;
				b.wz += (spring * (targetZ - b.tz) - drag * b.wz) * buoyDt;
				b.tx = THREE.MathUtils.clamp(b.tx + b.wx * buoyDt, -1.4, 1.4);
				b.tz = THREE.MathUtils.clamp(b.tz + b.wz * buoyDt, -1.4, 1.4);
				buoyNormal.set(b.tx, 1, b.tz).normalize();
				mesh.quaternion.setFromUnitVectors(UP, buoyNormal);

				// Feed the water's underwater raytrace: box-space transform
				// from the transform just written (Threlte would compute the
				// world matrix later in the frame; do it now so the raytraced
				// half can't lag the rasterized half).
				mesh.updateMatrixWorld();
				waterUniforms.uBuoyInv.value[i].copy(mesh.matrixWorld).invert();

				// Directional tip splash: swinging hard means the rim digs
				// into the water on the side the buoy is rotating toward, so
				// a small one-sided splash lands off that rim. Throttled and
				// far weaker than a crest-fall splashdown.
				const tipSpeed = Math.hypot(b.wx, b.wz);
				if (
					!airborne &&
					tipSpeed > TIP_SPLASH_THRESHOLD &&
					waveTime - b.lt > TIP_SPLASH_COOLDOWN
				) {
					b.lt = waveTime;
					const sideX = px + (b.wx / tipSpeed) * TIP_RIM;
					const sideZ = pz + (b.wz / tipSpeed) * TIP_RIM;
					const tip = Math.min((tipSpeed - TIP_SPLASH_THRESHOLD) / 3.5, 1);
					injectRipple(sideX, sideZ, 0.3, 0.04 + tip * 0.08);
					// The rim digging in flicks water outward on that side.
					emitImpactSpray(waveTime, sideX, sideZ, b.wx / tipSpeed, b.wz / tipSpeed, tip * 0.5);
				}
			}

			// Mirror the spray pool into the instanced mesh.
			for (let i = 0; i < MAX_SPRAY; i++) {
				const p = sprayParticles[i];
				if (p.size === 0) {
					sprayDummy.scale.setScalar(0);
				} else {
					sprayDummy.scale.setScalar(p.size);
					sprayDummy.position.set(p.x, p.y, p.z);
				}
				sprayDummy.updateMatrix();
				sprayMesh.setMatrixAt(i, sprayDummy.matrix);
			}
			sprayMesh.instanceMatrix.needsUpdate = true;
		},
		{ autoStart: false }
	);

	$effect(() => {
		if (active && game.running) task.start();
		else task.stop();
	});

	onDestroy(() => {
		renderer.domElement.removeEventListener('pointerdown', onPointerDown);
		window.removeEventListener('resize', onWindowResize);
		clearTimeout(resizeTimer);
		waterGeometry.dispose();
		waterMaterial.dispose();
		causticMap.dispose();
		sphereGeometry.dispose();
		sphereMaterial.dispose();
		buoyGeometry.dispose();
		buoyMaterial.dispose();
		sprayGeometry.dispose();
		sprayMaterial.dispose();
		toonGradient.dispose();
		rippleSim.dispose();
		foamField.dispose();
	});
</script>

<T.OrthographicCamera
	makeDefault
	position={[34, 30, 34]}
	{zoom}
	near={1}
	far={400}
	oncreate={(cam) => cam.lookAt(0, 0, 0)}
/>

<T.DirectionalLight bind:ref={sun} position={[40, 60, 20]} intensity={env0.lightIntensity * 2} />
<T.AmbientLight bind:ref={ambient} intensity={env0.ambientIntensity * 1.6} />

<T.Mesh geometry={sphereGeometry} material={sphereMaterial} position={[3, -6, 2]} />

<T is={sprayMesh} />
<T.Mesh geometry={waterGeometry} material={waterMaterial} />

{#each buoys as buoy, i (i)}
	<T.Mesh
		bind:ref={buoyMeshes[i]}
		position={[buoy.x, 0, buoy.z]}
		geometry={buoyGeometry}
		material={buoyMaterial}
	/>
{/each}
