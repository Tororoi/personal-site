<script lang="ts">
	import * as THREE from 'three';
	import { T, useTask, useThrelte } from '@threlte/core';
	import { onDestroy } from 'svelte';
	import { causticsGlsl, waves, wavesGlsl } from './waves';
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
	import { addFroth, FROTH_SIGMA, frothBlobs, frothGlsl, MAX_FROTH, updateFroth } from './froth';
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
	// The plane is sized from THIS window's actual ground footprint: ortho
	// zoom is fixed pixels-per-meter, so a bigger window sees more ocean.
	// The 0.71/1.34 coefficients come from the camera orientation (45 deg
	// azimuth, ~32 deg elevation): a screen half-width of w meters reaches
	// 0.71w in world x/z, a half-height of h reaches 1.34h. +4m margin
	// covers Gerstner sway pulling vertices off the edge. Sized at mount;
	// a window resize larger than mount needs a reload to regain coverage.
	const WATER_SIZE =
		2 * (0.71 * (window.innerWidth / zoom / 2) + 1.34 * (window.innerHeight / zoom / 2) + 4);
	// Fixed vertex budget buys the finest quads this window allows. The
	// water is deliberately FINE: the low-poly look belongs to the fish,
	// boat and buoy models, not the ocean. Quad size must stay under ~1/3
	// of the shortest ripple wavelength in the active sea preset.
	const WATER_SEGMENTS = Math.min(
		Math.round(WATER_SIZE / (mobile ? 0.6 : 0.2)),
		mobile ? 170 : 510
	);

	// ---------- Water ----------

	const waterGeometry = new THREE.PlaneGeometry(
		WATER_SIZE,
		WATER_SIZE,
		WATER_SEGMENTS,
		WATER_SEGMENTS
	);
	waterGeometry.rotateX(-Math.PI / 2);

	const env0 = computeEnv(game.time / DAY_SECONDS);

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
		uFoamStart: { value: 0.55 },
		uFoamFull: { value: 0.12 },
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
		// Splash froth blobs (froth.ts), refreshed each frame from the same
		// array addFroth() writes.
		uFrothA: { value: Array.from({ length: MAX_FROTH }, () => new THREE.Vector4()) },
		uFrothB: { value: Array.from({ length: MAX_FROTH }, () => new THREE.Vector4()) },
		// Solid-mode water, pool-style (Wallace/jeantimex): a Fresnel blend
		// between transmitted water color and reflected sky, plus sun
		// specular. Facets facing the camera show the water; tilted facets
		// catch the sky and sparkle.
		uWaterColor: { value: new THREE.Color('#1a5876') },
		uSkyColor: { value: new THREE.Color('#a8c8d8') },
		// CLARITY PINNED HIGH for caustic tuning: nearly transparent surface
		// so the underwater scene reads unobstructed. Restore toward ~0.78
		// when clarity becomes a weather/preset property.
		uAlphaBase: { value: 0.3 },
		// Live sun from the day/night cycle, updated per frame.
		uSunDir: { value: new THREE.Vector3(0.4, 1, 0.3) },
		uSunColor: { value: new THREE.Color('#fff2d0') },
		uSunI: { value: 1.2 },
		// Constant for the ortho camera: unit vector from scene toward camera.
		uViewDir: { value: new THREE.Vector3(34, 30, 34).normalize() }
	};

	// The wave-equation sim that owns uRippleTex's contents.
	const rippleSim = new RippleSim();

	// Forward-splat caustic map (pool-style differential area). Caustics
	// source from the ripple field only; ambient bands stay out per the
	// noise diagnosis (see caustics.ts for how they could return).
	const causticMap = new CausticMap();

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
uniform vec3 uSkyColor;
uniform float uAlphaBase;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunI;
uniform vec3 uViewDir;
varying vec3 vWorld;
varying float vViewZ;
varying float vChurn;
varying float vRipple;

void main() {
	vec3 normal = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
	if (normal.y < 0.0) normal = -normal;

	// Pool-style shading: Fresnel decides per facet whether you look INTO
	// the water (transmitted color) or AT it (reflected sky). Flat-on
	// facets transmit; tilted ones mirror the sky.
	float facing = clamp(dot(normal, uViewDir), 0.0, 1.0);
	float fresnel = 0.02 + 0.98 * pow(1.0 - facing, 3.0);
	vec3 col = mix(uWaterColor, uSkyColor, fresnel);

	// Sun sparkle: sharp Blinn specular on facets catching the half vector.
	vec3 halfVec = normalize(normalize(uSunDir) + uViewDir);
	float spec = pow(max(dot(normal, halfVec), 0.0), 90.0);
	col += uSunColor * spec * uSunI;

	float foam = max(vChurn, vRipple);
	col = mix(col, uFoamColor, foam);

	// Reflective facets are more opaque (you see the sky, not through);
	// transmitting facets stay clear for whatever swims below.
	float alpha = mix(uAlphaBase, 0.96, fresnel);
	alpha = mix(alpha, 0.97, foam);

	float fog = clamp(1.0 - exp(-uFogDensity * uFogDensity * vViewZ * vViewZ), 0.0, 1.0);
	col = mix(col, uFogColor, fog);
	alpha = mix(alpha, 1.0, fog);

	gl_FragColor = vec4(col, alpha);
}`;

	const waterMaterial = new THREE.ShaderMaterial({
		uniforms: waterUniforms,
		wireframe,
		transparent: !wireframe,
		vertexShader: `
uniform float uTime;
uniform float uAmp;
varying float vViewZ;
varying float vHeight;
varying float vJacobian;
varying float vChurn;
varying float vRipple;
varying vec3 vWorld;

${wavesGlsl()}
${whitecapsGlsl()}
${ripplesGlsl()}
${frothGlsl()}

void main() {
	// Sample in world space: when the mesh recenters on the drifting boat,
	// the wave field stays pinned to the world instead of following it.
	vec4 world = modelMatrix * vec4(position, 1.0);
	vec3 p = world.xyz + waveDisplacement(world.xz, uTime, uAmp);
	applyWhitecaps(p, world.xz, uTime);
	vHeight = p.y - world.y;
	vJacobian = waveJacobian(world.xz, uTime, uAmp);
	vChurn = applyChurn(p, world.xz, uTime, vJacobian);
	// Sample ripples at the DISPLACED position: Gerstner slides vertices
	// horizontally by meters, and the field is indexed by true world
	// coordinates. Sampling at the rest position would paint rings onto the
	// water's material coordinates, making them swim with the passing waves
	// instead of staying where the object poked. vRipple carries only
	// churned water (lifted ripple water + splash froth bursts); smooth
	// ripples stay uncolored.
	vRipple = max(applyRipples(p, p.xz, uTime), applyFroth(p, p.xz, uTime));
	vWorld = p;
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
varying float vChurn;
varying float vRipple;

void main() {
	// Brighter lines on crests, dimmer in troughs. vHeight is meters above
	// still water; uHeightScale is an absolute reference, not per-preset, so
	// brightness is comparable across sea states.
	float hn = clamp(vHeight / uHeightScale * 0.5 + 0.5, 0.0, 1.0);
	vec3 col = uLineColor * (0.35 + 0.9 * hn);

	// Churn only for now: the Jacobian foam ramp is temporarily disabled so
	// the churn reads in isolation. To restore it:
	// float foam = 1.0 - smoothstep(uFoamFull, uFoamStart, vJacobian);
	// foam = max(foam, vChurn);
	float foam = max(vChurn, vRipple);
	col = mix(col, uFoamColor, foam);

	// Distance fade into the page background, doubling as moire control.
	float fog = 1.0 - exp(-uFogDensity * uFogDensity * vViewZ * vViewZ);
	col = mix(col, uFogColor, clamp(fog, 0.0, 1.0));

	gl_FragColor = vec4(col, 1.0);
}`
	});
	if (!wireframe) waterMaterial.fragmentShader = solidFragment;

	// ---------- Underwater backdrop ----------
	// The "floor" of the visible ocean: an opaque plane a few meters down.
	// The surface's transparency reveals it the way the pool reference
	// reveals its tiles: calm clear water finally reads as WATER because
	// there is something lit beneath it. It's a depth-colored void, not a
	// caustic receiver: at 10m under our seas, refracted light is far too
	// diffuse to pattern it, so caustics render only on OBJECTS below the
	// surface (the sphere, later fish).
	const BACKDROP_DEPTH = 10;
	const backdropGeometry = new THREE.PlaneGeometry(WATER_SIZE, WATER_SIZE);
	backdropGeometry.rotateX(-Math.PI / 2);
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
		// Backdrop's own: refreshed from the env palette each frame.
		uFloorColor: { value: new THREE.Color('#0a2e44') },
		uLightColor: { value: new THREE.Color('#fff2d0') },
		uLightI: { value: 1.2 },
		uDepth: { value: BACKDROP_DEPTH },
		// Ripple field for caustics (uRippleCTex re-pointed each frame) and
		// the tuning sphere's sun-projected shadow.
		uRippleCTex: { value: null as THREE.Texture | null },
		uRippleCCenter: { value: new THREE.Vector2(0, 0) },
		uRippleCExtent: { value: RIPPLE_EXTENT },
		uCausticMap: { value: null as THREE.Texture | null },
		uCausticCenter: { value: new THREE.Vector2(0, 0) },
		uCausticExtent: { value: CAUSTIC_EXTENT }
	};
	const backdropMaterial = new THREE.ShaderMaterial({
		uniforms: backdropUniforms,
		vertexShader: `
varying vec3 vWorld;
varying float vViewZ;
void main() {
	vec4 world = modelMatrix * vec4(position, 1.0);
	vWorld = world.xyz;
	vec4 view = viewMatrix * world;
	vViewZ = -view.z;
	gl_Position = projectionMatrix * view;
}`,
		fragmentShader: `
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform vec3 uFloorColor;
uniform float uLightI;
varying vec3 vWorld;
varying float vViewZ;

void main() {
	vec3 col = uFloorColor * (0.1 + 0.32 * uLightI);

	float fog = clamp(1.0 - exp(-uFogDensity * uFogDensity * vViewZ * vViewZ), 0.0, 1.0);
	col = mix(col, uFogColor, fog);
	gl_FragColor = vec4(col, 1.0);
}`
	});

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
		uSphereColor: { value: new THREE.Color('#8f9ea6') }
	};
	const sphereMaterial = new THREE.ShaderMaterial({
		uniforms: sphereUniforms,
		vertexShader: `
varying vec3 vWorld;
varying vec3 vNormal;
varying float vViewZ;
void main() {
	vec4 world = modelMatrix * vec4(position, 1.0);
	vWorld = world.xyz;
	vNormal = mat3(modelMatrix) * normal;
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
uniform float uTime;
uniform float uAmp;
varying vec3 vWorld;
varying vec3 vNormal;
varying float vViewZ;

${wavesGlsl()}

void main() {
	vec3 normal = normalize(vNormal);
	vec3 sun = normalize(uSunDir);

	// The ACTUAL water surface above this fragment, not the resting plane:
	// one fixed-point step undoes the Gerstner horizontal sway, same
	// inversion the CPU sampler uses. A crown standing proud of a storm
	// trough is genuinely DRY: lit by direct sun, no caustics, no depth
	// dimming.
	vec3 D = waveDisplacement(vWorld.xz, uTime, uAmp);
	D = waveDisplacement(vWorld.xz - D.xz, uTime, uAmp);
	float waterY = D.y;
	float submerged = clamp((waterY - vWorld.y) / 0.35 + 0.5, 0.0, 1.0);

	// --- Dry branch: direct sun with soft wrap so the terminator doesn't
	// slice a hard line across the crown.
	float wrap = clamp((dot(normal, sun) + 0.4) / 1.4, 0.0, 1.0);
	vec3 dry = uSphereColor * (0.3 + 0.75 * wrap * uLightI);

	// --- Wet branch, structured like the pool reference: a constant
	// ambient base the caustics never touch (scattered water light reaches
	// undersides too), plus a diffuse term that is DIRECTIONAL along the
	// REFRACTED sun ray — underwater, light arrives along
	// refract(-sun, up), not from straight above — and only that
	// directional term is caustic-modulated.
	float depth = max(waterY - vWorld.y, 0.0);
	float depthLight = exp(-depth * 0.1);
	vec3 refrLight = refract(-sun, vec3(0.0, 1.0, 0.0), 0.7519);
	float inc = clamp(dot(normal, -refrLight), 0.0, 1.0);

	// BEAM-SPACE lookup, as the pool reference: slide this point along the
	// refracted sun direction to the splat's reference plane and read the
	// beam's intensity there. Every point at every depth lies on exactly
	// one beam, so the equator gets its caustics too — the old top-down
	// landing map starved everything below the upper third and needed a
	// stack of noise guards; beam space needs none. The map clears to
	// black = no light, ~1 where flat water passes light through, > 1 in
	// fold filaments, 0 in the exposed crown's shadow.
	vec2 beamXZ = vWorld.xz + refrLight.xz * ((${(-CAUSTIC_PLANE_DEPTH).toFixed(1)} - vWorld.y) / refrLight.y);
	vec2 cuv = (beamXZ - uCausticCenter) / uCausticExtent + 0.5;
	float light = 1.0;
	if (cuv.x > 0.0 && cuv.x < 1.0 && cuv.y > 0.0 && cuv.y < 1.0) {
		light = texture2D(uCausticMap, cuv).r;
	}

	// Direct light is shadow-modulated only (min with 1): fold brightness
	// arrives as the additive caustic term, not by washing the diffuse.
	// The map stores energy per HORIZONTAL area; the inc cosine converts
	// it to true surface irradiance, so flanks neither blow out nor
	// over-collect.
	vec3 wet = uSphereColor * (0.45 + 0.5 * inc * depthLight * uLightI * min(light, 1.0));
	wet += uLightColor * max(light - 1.0, 0.0) * uLightI * 0.8 * inc * depthLight;

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
				// Whitecap events and froth drift advance on the fixed step too.
				setRippleClock(waveTime);
				updateWhitecaps(STEP, waveTime);
				updateFroth(STEP, waveTime);
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
			for (let i = 0; i < MAX_FROTH; i++) {
				const f = frothBlobs[i];
				waterUniforms.uFrothA.value[i].set(f.x, f.z, f.birth, f.sigma);
				waterUniforms.uFrothB.value[i].set(f.amp, 0, 0, 0);
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
							// Two separate effects: the displacement hat (water
							// pushed aside, wave equation) and the froth burst
							// (churn that boils in place, froth.ts).
							injectRipple(px, pz, 0.8, 0.12 + amp * 0.35);
							addFroth(waveTime, px, pz, FROTH_SIGMA, 0.5 + amp * 0.7);
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
					addFroth(waveTime, sideX, sideZ, 0.32, 0.15 + tip * 0.35);
				}
			}
		},
		{ autoStart: false }
	);

	$effect(() => {
		if (active && game.running) task.start();
		else task.stop();
	});

	onDestroy(() => {
		renderer.domElement.removeEventListener('pointerdown', onPointerDown);
		waterGeometry.dispose();
		waterMaterial.dispose();
		backdropGeometry.dispose();
		backdropMaterial.dispose();
		causticMap.dispose();
		sphereGeometry.dispose();
		sphereMaterial.dispose();
		buoyGeometry.dispose();
		buoyMaterial.dispose();
		toonGradient.dispose();
		rippleSim.dispose();
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

<T.Mesh
	geometry={backdropGeometry}
	material={backdropMaterial}
	position={[0, -BACKDROP_DEPTH, 0]}
/>
<T.Mesh geometry={sphereGeometry} material={sphereMaterial} position={[3, -6, 2]} />
<T.Mesh geometry={waterGeometry} material={waterMaterial} />

{#each buoys as buoy, i (i)}
	<T.Mesh
		bind:ref={buoyMeshes[i]}
		position={[buoy.x, 0, buoy.z]}
		geometry={buoyGeometry}
		material={buoyMaterial}
	/>
{/each}
