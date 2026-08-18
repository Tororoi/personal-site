<script lang="ts">
	import * as THREE from 'three';
	import { T, useTask, useThrelte } from '@threlte/core';
	import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
	import { onDestroy } from 'svelte';
	import { bakeSdfAtlas } from './sdf';
	import {
		activeField,
		objectWaveGlsl,
		objectWaveSlopeGlsl,
		waves,
		wavesGlsl,
		applySeaState,
		fieldForSeaState,
		generateWaves,
		waveUniformA,
		waveUniformB,
		seaDrive,
		seaMetrics
	} from './waves';
	import {
		events,
		MAX_EVENTS,
		sampleOcean,
		update as updateWhitecaps,
		whitecapsGlsl,
		windTravel,
		windBase,
		windVector,
		sampleOceanTracked } from './whitecaps';
	import { fftSlopeGlsl, makeFftDetail } from './fftwaves';
	import { injectRipple, RIPPLE_EXTENT, RippleSim, ripplesGlsl, setRippleClock, rippleDisplayGain, injectRippleOver } from './ripples';
	import { CAUSTIC_EXTENT, CAUSTIC_PLANE_DEPTH, CausticMap } from './caustics';
	import {
		emitImpactSpray,
		MAX_SPRAY,
		setScanCenter,
		setScanExtent,
		setViewQuad,
		sprayParticles,
		sprayCheckStats,
		sprayCostStats,
		updateSpray
	} from './spray';
	import { currentVector } from './current';
	import { MistField, MIST_EXTENT } from './mistfield';
	import {
		addFoam,
		foamMass,
		CONTACT_FOAMINESS,
		foamFlow,
		FoamField,
		foamGlsl,
		foamNoiseGlsl,
		FOAM_EXTENT
	} from './foam';
	import {
		BOAT,
		CONTACT,
		DROPLET,
		ENABLE,
		f,
		FFT,
		FOAM,
		FROTH,
		LOOP,
		BOWCREST,
		MIST,
		OBJWAVE,
		PROFILE,
		SPECULAR,
		PLUME,
		SEA,
		UNIFIED } from './tuning';
	import { plumeFragmentGlsl } from './plume';
	import { whitewaterLightGlsl, WHITEWATER_UNIFORM_DECLS } from './whitewater';
	import { advanceCurrent } from './current';
	import { computeEnv, ENV } from './env';
	import { logDiag } from './perflog';
	import { game, perf } from './state.svelte';

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
	if (todParam !== null) game.time = ENV.daySeconds * parseFloat(todParam);
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
	// Sized for the ROUGHEST sea, not the one loaded. Geometry extent is
	// baked into buffers at build, so a live sea-state change cannot resize
	// it — and a margin cut for calm would let a storm reveal unrendered
	// corners the moment the dial moved. Over-covering costs some
	// off-screen quads on calm; under-covering is a visible hole.
	const worstField = fieldForSeaState(2);
	const worstWaves = generateWaves(worstField);
	const SWAY_BOUND = worstWaves.reduce((sum, w) => sum + w.q * w.amp, 0);
	const EDGE_MARGIN =
		2 + SWAY_BOUND + 3.2 * Math.sqrt(worstWaves.reduce((sum, w) => sum + w.amp * w.amp, 0));
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
	let waterMeshRef = $state<THREE.Mesh | undefined>();

	// Window resizes rebuild the plane (debounced), so the water always
	// covers the CURRENT window instead of the mount-time one.
	let resizeTimer = 0;
	function onWindowResize() {
		clearTimeout(resizeTimer);
		resizeTimer = window.setTimeout(() => {
			waterGeometry.dispose();
			waterGeometry = buildWaterGeometry();
			frothGeometry.dispose();
			frothGeometry = buildFrothGeometry();
			frothMesh.geometry = frothGeometry;
		}, 200);
	}
	window.addEventListener('resize', onWindowResize);

	const env0 = computeEnv(game.time / ENV.daySeconds);

	// Sun diffusion from the sea preset's cloud deck (waves.ts sky), 0
	// clear .. 1 heavy overcast. Feeds three effects of the SAME cause:
	// the caustic map's source-size blur (caustics.ts), the receiver-side
	// flatten that carries heavy overcast past the practical blur radius,
	// and the softening of the sun's glare on the water.
	// Cloud cover, which the sea state carries. Read live rather than
	// captured: it sets the caustic blur radius and the specular's
	// clear/overcast blend, and both were freezing at whatever the page
	// loaded with — a storm's soft caustics persisting into a calm sea.
	const sunDiffusion = () => activeField.sky?.diffusion ?? 0;
	const SUN_DIFFUSION = sunDiffusion();
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
		// Shared with the caustic, foam and mist sims — see waveUniformA.
		uWaveA: { value: waveUniformA },
		uWaveB: { value: waveUniformB },
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
		// Display gain for the ripple field. A uniform rather than a baked
		// literal so a live sea-state change can swap the ripple character.
		uRippleGain: { value: rippleDisplayGain() },
		// Detail-wave slope cascades (fftwaves.ts). Static textures once the
		// field exists, but they are render targets, so they are pointed at
		// after the first step rather than at construction.
		uFftA: { value: null as THREE.Texture | null },
		uFftB: { value: null as THREE.Texture | null },
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
		// True camera position, for the perspective experiment. Under the
		// isometric camera nothing reads it — every pixel shares uViewDir.
		// The viewpoint the specular converges on. Under the isometric camera
		// that is a SIMULATION — ortho has no meaningful eye distance — so it
		// is placed along the view axis at SPECULAR.cameraEyeDistance. Under
		// a real perspective camera it is overwritten with the true position.
		uCamPos: { value: new THREE.Vector3() },
		// The boat in the underwater raytrace: world->local, plus its hull
		// colour for the refracted image.
		uBoatInv: { value: new THREE.Matrix4() },
		// The boat's rendered image, for the refracted view. The analytic
		// polytope in boatHit is only a BOUNDING volume: the ray decides
		// where the hull is, this texture decides what it looks like — so
		// the refraction shows the real model, Blender hull included, not
		// a box approximation of it.
		uBoatTex: { value: null as THREE.Texture | null },
		uProj: { value: new THREE.Matrix4() },
		uBoatSdf: { value: null as THREE.Texture | null },
		uBoatSdfMin: { value: new THREE.Vector3() },
		uBoatSdfSize: { value: new THREE.Vector3(1, 1, 1) },
		// Driven per frame from sun altitude (see altHigh/altLow in SPECULAR).
		// Every SPECULAR value the shader needs, refreshed each frame — that
		// is what lets the panel tune them without a reload. Baked literals
		// would be marginally cheaper and would cost an Apply per nudge.
		// Wind heading for the anisotropic lobe. A uniform, not a literal:
		// a live sea-state change turns the wind, and a baked cos/sin would
		// leave the glitter stretched along a direction the sea abandoned.
		// Object-waterline foaminess, from the sea's chop. A uniform so it
		// follows a live sea-state change like the foam sim's copy does.
		uFoaminess: { value: CONTACT_FOAMINESS },
		uWindDir: {
			value: new THREE.Vector2(Math.cos(activeField.windAngle), Math.sin(activeField.windAngle))
		},
		uSpecSharpCore: { value: 1 },
		uSpecSharpWash: { value: 1 },
		uSpecGain: { value: 1 },
		uSpecAniso: { value: SPECULAR.anisotropy },
		uSpecFresnelMix: { value: SPECULAR.fresnelMix },
		uSpecHaloGain: { value: SPECULAR.haloGain },
		/** Horizon fade, 0 below fadeAltDeg. */
		uSpecFade: { value: 1 },
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
		/** Wind+current carry, m/s, the SAME combination the foam field is
		 * advected by — so the collar leans the way drifting foam goes. */
		/** Accumulated carry, so the web pattern drifts with the foam. */
		uFoamFlow: { value: new THREE.Vector2() },
		uFoamCenter: { value: new THREE.Vector2(0, 0) },
		uFoamExtent: { value: FOAM_EXTENT },
		// Baked tiling web-skeleton distance field (set after first bake).
		uFoamWebTex: { value: null as THREE.Texture | null },
		// The froth reference: max(sea's dominant amplitude, FROTH.ampRef).
		// ONE uniform object, shared by every material that sizes froth —
		// separate copies are how the caustics once kept refracting a storm
		// under a calm sea. Refreshed in syncSeaState.
		uDomAmp: { value: Math.max(waves.reduce((a, b) => Math.max(a, b.amp), 0), FROTH.ampRef) }
	};

	/**
	 * Centre of the TRAVELLING WINDOW — the water mesh, froth lattice and
	 * droplet scan all cover a viewport-sized patch that follows the boat.
	 * Snapped to the water quad (0.5m, a multiple of the froth lattice), so
	 * recentering shifts the local grids onto the SAME world lattice they
	 * already occupied: no vertex swimming, no froth reroll.
	 */
	const winCenter = new THREE.Vector2();
	const uWinCenter = { value: winCenter };

	/**
	 * Boat SDF grid: resolution, and the slice-atlas tiling (WebGL1 has no
	 * sampler3D, so the 3D field ships as tiled 2D slices with a manual
	 * slice-mix in the shader). Baked once at load from the actual mesh —
	 * see sdf.ts — so the refracted hull, and the caustics landing on it,
	 * follow the true surface rather than a bounding approximation.
	 */
	const BOAT_SDF = { nx: 96, ny: 40, nz: 48, tilesX: 8, tilesY: 6 };

	// The visible ocean "floor" depth; also the miss plane of the water's
	// underwater raytrace.
	const BACKDROP_DEPTH = 10;

	// The reconstructed fold ramps: a max() over whichever of the three
	// claims are switched on, emitted as source so a disabled term costs
	// nothing. Shared by the vertex estimate and the fragment refinement
	// so the two can never disagree about which terms are in play.
	const rampWhiteGlsl = (jac: string, tilt: string, stretch: string | null) => {
		const terms: string[] = [];
		if (LOOP.whiteFromJ) terms.push(`1.0 - smoothstep(0.0, ${f(LOOP.whiteJRamp)}, ${jac})`);
		if (LOOP.whiteFromTilt)
			terms.push(`1.0 - smoothstep(${f(LOOP.whiteTiltStart)}, ${f(LOOP.whiteTiltFull)}, ${tilt})`);
		if (stretch !== null && LOOP.whiteFromStretch) terms.push(stretch);
		if (terms.length === 0) return '0.0';
		return terms.reduce((a, b) => `max(${a}, ${b})`);
	};

	/** The object wave, shared verbatim by every shader that builds a
	 * displacement gradient. One definition: the water mesh, its fragment
	 * refinement and the froth sprites must agree about where the water
	 * is, or one of them silently undoes another. */
	const objWaveGlsl = objectWaveGlsl({
		centre: [3, -6, 2],
		radius: 5,
		amp: OBJWAVE.amp,
		wavelength: OBJWAVE.wavelength,
		q: OBJWAVE.q,
		reach: OBJWAVE.reach,
		windward: OBJWAVE.windward,
		flow: [
			Math.cos(activeField.surfaceCurrentHeading ?? 0),
			Math.sin(activeField.surfaceCurrentHeading ?? 0)
		]
	});

	/** Folds the object wave into a caller's displacement gradient.
	 * Emits nothing when the sample is out of the wave's reach.
	 * @param pos   GLSL vec2 expression: where to sample, world XZ
	 * @param surfY GLSL float expression: the surface height there
	 * @param apply GLSL statement adding `ow` to the caller's position */
	const objWaveApply = (pos: string, surfY: string, apply: string) =>
		!ENABLE.objectWave
			? ''
			: `
	{
		vec3 ow = objectWave(${pos}, ${surfY});
		if (dot(ow, ow) > 1e-9) {
			// Gradient by finite difference: the wave is one sin, one cos
			// and an exp, so three samples cost far less than deriving and
			// maintaining an analytic Jacobian for the envelope as well.
			float owe = 0.08;
			vec3 owx = (objectWave(${pos} + vec2(owe, 0.0), ${surfY}) - ow) / owe;
			vec3 owz = (objectWave(${pos} + vec2(0.0, owe), ${surfY}) - ow) / owe;
			txx += owx.x;
			txy += owx.y;
			txz += 0.5 * (owx.z + owz.x);
			tzy += owz.y;
			tzz += owz.z;
			${apply}
		}
	}`;

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
	// FADE at the caustic map's border, never a hard in/out test. The
	// beam-space lookup walks further from the receiver as the sun sinks
	// (a low sun's refracted ray travels a long way horizontally to
	// reach the caustic plane), so at low elevations parts of a receiver
	// cross the map edge — with a binary test that showed as caustics
	// snapping off one region at a time. Clamped sample + smooth fade to
	// unlit keeps it continuous.
	float caustic = texture2D(uCausticMap, clamp(cuv, 0.002, 0.998)).r;
	vec2 cEdge = min(cuv, 1.0 - cuv);
	float inMap = smoothstep(0.0, 0.08, min(cEdge.x, cEdge.y));
	float light = mix(1.0, caustic, inMap);
	// Heavy overcast: past the map blur's practical radius, the extended
	// source washes the pattern (and its shadows) toward featureless light.
	light = mix(light, 1.0, uCausticFlat);
	// Direct light is shadow-modulated only (min with 1); fold brightness
	// arrives as the additive term, cosine-weighted to true irradiance.
	// Ambient is SKY-tinted (the underwater half is lit by the whole
	// dome refracting down), so dusk warms both sides of the waterline
	// together instead of only the caustic-lit half.
	vec3 amb = mix(uSkyHorizon, uSkyZenith, clamp(normal.y * 0.5 + 0.5, 0.0, 1.0));
	vec3 col = albedo * (amb * 0.45 + uLightColor * (0.5 * inc * depthLight * uLightI * min(light, 1.0)));
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
	const foamField = new FoamField(waterUniforms.uBuoyInv.value);
	let foamAccum = 0;
	let foamEven = false;

	// PERSPECTIVE EXPERIMENT. Sit the camera on the same axis the isometric
	// one uses, at PROFILE.perspectiveDistance, and derive the field of
	// view so the framing at the water plane is unchanged. That makes the
	// distance a pure "how much perspective" dial rather than a zoom: near
	// is a wide lens close in, far converges on the orthographic look.
	/**
	 * FOG DEPTH BIAS, metres.
	 *
	 * vViewZ is distance from the CAMERA, so moving the camera back fogs the
	 * whole scene even though nothing in it has moved — measured, the
	 * perspective experiment at 150m put a storm sea 56% into fog against
	 * 11% at the isometric distance, which is why it went dark. Subtracting
	 * the camera's own distance makes fog measure depth into the scene
	 * instead. Zero at the current isometric camera, so the look is
	 * unchanged; it only stops the fog reacting to where the lens is.
	 */
	/**
	 * How far the reflected sky sinks into the fog colour at full night.
	 *
	 * The preset sky colours are DAYLIGHT skies, and they used to shine all
	 * night: the Fresnel reflection kept painting largeSwell's bright
	 * overcast (#c3cbd1) across the whole surface, so its nights read as
	 * grey days. (Storm looked fine only because its sky constants are
	 * already dark.) Pulling the sky toward the env's fog colour by the
	 * night factor darkens every sea coherently — the same keyframes that
	 * already darken the water and the fog now take the reflection with
	 * them.
	 */
	const NIGHT_SKY_TO_FOG = 0.85;
	const skyZenithBase = new THREE.Color(activeField.sky?.zenith ?? '#a8c8d8');
	const skyHorizonBase = new THREE.Color(activeField.sky?.horizon ?? '#d5e3ea');
	const skyScratch = new THREE.Color();

	const BASE_CAM_DIST = Math.hypot(34, 30, 34);
	// The simulated viewpoint the specular converges on. Distance sets the
	// fan (focus); height, scaled separately, sets how far the reflection
	// travels as the sun lowers. Static under the isometric camera; the
	// perspective branch overwrites it with the real position below.
	{
		const d = new THREE.Vector3(34, 30, 34).normalize().multiplyScalar(SPECULAR.cameraEyeDistance);
		d.y *= SPECULAR.cameraEyeHeight;
		waterUniforms.uCamPos.value.copy(d);
	}
	const fogZBias =
		(PROFILE.perspectiveCamera ? PROFILE.perspectiveDistance : BASE_CAM_DIST) - BASE_CAM_DIST;
	/** Fog term for a shader that has vViewZ in scope. */
	const fogGlsl = (out: string) =>
		`float ${out} = clamp(1.0 - exp(-uFogDensity * uFogDensity` +
		` * max(vViewZ - ${f(fogZBias)}, 0.0) * max(vViewZ - ${f(fogZBias)}, 0.0)), 0.0, 1.0);`;

	const perspDir = new THREE.Vector3(34, 30, 34).normalize();
	const perspPos = perspDir.clone().multiplyScalar(PROFILE.perspectiveDistance).toArray() as [
		number,
		number,
		number
	];
	const perspFov =
		(2 *
			Math.atan(window.innerHeight / zoom / 2 / PROFILE.perspectiveDistance) *
			180) /
		Math.PI;
	if (PROFILE.perspectiveCamera) {
		waterUniforms.uCamPos.value.fromArray(perspPos);
	}

	/**
	 * LIVE SEA STATE. Watches the two SEA knobs and rebuilds the field when
	 * either moves, then re-uploads everything the GPU holds a copy of.
	 * applySeaState rewrites `waves` in place, so the CPU sampler, buoyancy
	 * and spray need nothing — only these mirrors do.
	 */
	// The state actually in the water, which chases SEA.seaState rather than
	// tracking it. Critically damped (the SmoothDamp formulation), so it
	// eases in and out, never overshoots, and stays stable at any frame
	// time — a plain lerp-by-dt would be frame-rate dependent and an
	// exponential would only ease out.
	let seaEased = SEA.seaState;
	let seaVel = 0;
	let seaApplied = '';
	// Distance this transition has to cover, captured when the target moves.
	// The damper's time constant scales with it, so the pace stays even
	// whether the journey is 0.1 or the full calm-to-storm 2.
	let seaTargetSeen = SEA.seaState;
	let seaSpan = 0;
	function syncSeaState(dt: number) {
		const target = SEA.seaState;
		if (target !== seaTargetSeen) {
			seaTargetSeen = target;
			seaSpan = Math.abs(target - seaEased);
		}
		const tau = SEA.transitionSecondsPerUnit * Math.max(seaSpan, 0.02);
		if (target < 0 || seaEased < 0 || tau <= 0) {
			// Preset mode has nothing to interpolate along; snap.
			seaEased = target;
			seaVel = 0;
		} else if (Math.abs(target - seaEased) > 1e-4 || Math.abs(seaVel) > 1e-4) {
			const omega = 2 / tau;
			const x = omega * Math.min(dt, 0.1);
			const decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
			const change = seaEased - target;
			const temp = (seaVel + omega * change) * Math.min(dt, 0.1);
			seaVel = (seaVel - omega * temp) * decay;
			seaEased = target + (change + temp) * decay;
		} else {
			seaEased = target;
			seaVel = 0;
		}
		// Any UNIFIED knob must trigger a rebuild too — that group IS the
		// field when useUnified is on, so its values belong in the key.
		// Joining the whole group is cheap next to the rebuild it guards.
		const key = SEA.useUnified
			? `U${Object.values(UNIFIED).join(',')},${SEA.chopOverride}`
			: `${seaEased.toFixed(4)},${SEA.chopOverride}`;
		if (key === seaApplied) return;
		seaApplied = key;
		applySeaState(seaEased, SEA.chopOverride);
		waterUniforms.uWindDir.value.set(
			Math.cos(activeField.windAngle),
			Math.sin(activeField.windAngle)
		);
		waterUniforms.uFoaminess.value = CONTACT_FOAMINESS;
		{
			const ref = Math.max(waves.reduce((a, b) => Math.max(a, b.amp), 0), FROTH.ampRef);
			waterUniforms.uDomAmp.value = ref;
			foamField.setDomAmp(ref);
		}
		waterUniforms.uRippleGain.value = rippleDisplayGain();
		// The FFT spectrum is CPU work — two 128^2 float textures — so it is
		// marked stale here and rebuilt on a throttle rather than inline.
		fftStale = true;
		const dif = sunDiffusion();
		waterUniforms.uSunDiffusion.value = dif;
		causticMap.diffusion = dif;
		waterUniforms.uCausticFlat.value = THREE.MathUtils.smoothstep(dif, 0.35, 1.0);
		skyZenithBase.set(activeField.sky?.zenith ?? '#a8c8d8');
		skyHorizonBase.set(activeField.sky?.horizon ?? '#d5e3ea');
	}

	/** GLSL-style smoothstep that also accepts e0 > e1 (a falling ramp). */
	function smooth01(x: number, e0: number, e1: number) {
		const u = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
		return u * u * (3 - 2 * u);
	}

	// FFT spectrum rebuild, throttled. Regenerating it costs several
	// milliseconds, far too much per frame, but the band it carries is
	// sub-metre texture — stepping it a couple of times a second during a
	// transition is well below what the eye can follow.
	let fftStale = false;
	let fftStaleClock = 0;
	const FFT_REBUILD_INTERVAL = 0.4;
	function syncFftSpectrum(dt: number) {
		if (!fftDetail || !fftStale) return;
		fftStaleClock += dt;
		if (fftStaleClock < FFT_REBUILD_INTERVAL) return;
		fftStaleClock = 0;
		fftStale = false;
		const d = activeField.detail ?? {};
		fftDetail.rebuild(d.minLambda ?? 0.35, d.maxLambda ?? 3.5, d.slope ?? 0.05);
	}

	// The FFT detail-wave cascades that own uFftA/uFftB. Unlike the other
	// sims this one has no state to carry frame to frame — each step is a
	// fresh transform of the same spectrum evolved to the current time — so
	// it can be skipped or restarted freely.
	const fftDetail = ENABLE.fftDetail ? makeFftDetail() : null;
	// Frame counter for FFT.stepEvery. Each step is self-contained, so a
	// skipped frame just leaves the last slope texture in place.
	let fftFrame = 0;

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
	/**
	 * How the specular gets its reflection direction, and whether it is
	 * shaped. Exactly one applies; both fakes are inert under a real
	 * perspective camera, where `reflectedRay` is already per-pixel truth.
	 */
	/**
	 * How the specular gets its reflection direction, and how it is shaped.
	 * Exactly one branch applies; both fakes are inert under a real
	 * perspective camera, where `reflectedRay` is already per-pixel truth.
	 *
	 * Envelope mode emits TWO shapes — a tight core and a broad halo — so
	 * the common code below can sum a dense glitter and the dim aureole
	 * around it. The other modes emit a halo of zero, which drops the
	 * second term entirely rather than double-counting the core.
	 */
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
uniform vec3 uCamPos;
uniform vec2 uWindDir;
uniform float uFoaminess;
uniform float uSpecSharpCore;
uniform float uSpecSharpWash;
uniform float uSpecGain;
uniform float uSpecAniso;
uniform float uSpecFresnelMix;
uniform float uSpecHaloGain;
uniform float uSpecFade;
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
uniform float uDomAmp;
uniform vec2 uWinCenter;
varying float vLoopSk;
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
${whitewaterLightGlsl()}
${foamGlsl()}
${ripplesGlsl()}
${wavesGlsl()}
${ENABLE.fftDetail ? fftSlopeGlsl() : ''}
${ENABLE.objectWave ? objWaveGlsl : ''}
${ENABLE.objectWave ? objectWaveSlopeGlsl() : ''}

// The fold ramps at FRAGMENT resolution (see the gate in main): one
// tangent loop yields both tests — the unnormalized Na.y IS the
// horizontal Jacobian determinant, and Na.y/|Na| is the tilt.
float pinchMask(vec2 restXZ) {
	float txx = 0.0;
	float txy = 0.0;
	float txz = 0.0;
	float tzy = 0.0;
	float tzz = 0.0;
	float wAmp = 0.0;
	float wsum = 0.0;
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
		float pw = max(qak * sn, 0.0);
		pw *= pw;
		wAmp += wb.x * pw;
		wsum += pw;
	}
	// The same wave the vertex used. This refinement runs wherever the
	// vertex reported a partial value — exactly where the object wave is
	// — so leaving it out here would rebuild a spectrum-only frame and
	// erase the vertex's verdict.
	${objWaveApply('vWorld.xz', 'vWorld.y', '')}
	vec3 Tu = vec3(1.0 + txx, txy, txz);
	vec3 Tv = vec3(txz, tzy, 1.0 + tzz);
	vec3 Na = cross(Tv, Tu);
	float ny = Na.y / max(length(Na), 0.0001);
	// Shared sprite-criterion gate (twin of the vertex).
	// Compressed absolute sizing — see FROTH.ampCurve. max() guards pow(0, x),
	// which is undefined in GLSL for a zero base.
	float ampK = clamp(pow(max((wsum > 0.0001 ? wAmp / wsum : 0.0) / uDomAmp, 0.0001), ${f(FROTH.ampCurve)}), 0.3, 1.0);
	float intK = mix(0.4, 1.0, clamp((0.1 - Na.y) / 0.55, 0.0, 1.0));
	float sk = ampK * intK;
	sk *= 1.0 + 0.5 * smoothstep(0.15, 0.55, sk);
	float vis = smoothstep(0.1, 0.16, sk);
	return ${rampWhiteGlsl(
		'Na.y',
		'ny',
		`1.0 - smoothstep(0.0, ${f(LOOP.stretchJRamp)}, Na.y)`
	)} * vis;
}

/**
 * CONTACT FOAM: the collar where the surface meets a solid.
 *
 * Measured per pixel against each object's SILHOUETTE AT THIS FRAGMENT'S
 * OWN HEIGHT, which is what makes it track the waterline for free. There
 * is no waterline to find and nothing to update as the waves pass: the
 * fragment is already on the surface, so asking "how far am I from the
 * object, at my height" answers it directly, and the collar climbs and
 * falls with the swell.
 *
 * Wholly analytic, so it cannot drift, diffuse or decay the way the foam
 * FIELD does — it simply exists wherever an object is at the surface.
 */
/**
 * CONTACT FOAM: the collar of foam that sits ON an object at the
 * waterline. Distinct from the foam objects emit into the field — that
 * is ordinary foam and drifts away; this stays put for as long as the
 * object is at the surface, and reads nothing about wind or current.
 *
 * Measured per pixel against each object's silhouette AT THIS
 * FRAGMENT'S OWN HEIGHT, so it tracks the waterline for free: there is
 * no waterline to compute and nothing to update as the swell passes.
 */
float contactFoam(vec3 P) {
	// A sea too calm to foam has NO collar, and this has to be tested at
	// runtime. It used to be a build-time gate on CONTACT_FOAMINESS, which
	// baked the collar out entirely whenever the page loaded on calm — so
	// blending up to a storm never grew one. Testing here also covers the
	// original hazard: at zero width the smoothstep below has equal edges,
	// which is undefined in GLSL and returns 1, giving the calmest sea the
	// THICKEST collar.
	if (uFoaminess < 0.001) return 0.0;
	// Value noise, not a product of sines: sines are strictly periodic
	// and gave the edge one wavelength and one amplitude everywhere.
	float wob = foamNoise(P.xz * ${f(1 / CONTACT.wobbleScale)}) * 0.6
		+ foamNoise(P.xz * ${f(2.7 / CONTACT.wobbleScale)} + 7.0) * 0.4;
	float w = ${f(CONTACT.width)} * uFoaminess
		* mix(${f(1 - CONTACT.wobble)}, ${f(1 + CONTACT.wobble)}, wob);
	float m = 0.0;
	// SPHERE. Two cases, because height must never be a hard gate: BESIDE
	// is water alongside, out to w past the silhouette at this height;
	// OVER is water covering it, faded by how deep it lies above the
	// object's surface directly beneath — depth to the surface below, not
	// height above the crown, which says nothing about the flank.
	float rXZ = length(P.xz - SPHERE_C.xz);
	if (rXZ < SPHERE_R + w) {
		float dy = P.y - SPHERE_C.y;
		float ring = sqrt(max(SPHERE_R * SPHERE_R - dy * dy, 0.0));
		float beside = 1.0 - smoothstep(w * ${f(1 - CONTACT.soft)}, w, max(rXZ - ring, 0.0));
		float rc = min(rXZ, SPHERE_R);
		float topY = SPHERE_C.y + sqrt(max(SPHERE_R * SPHERE_R - rc * rc, 0.0));
		float over = pow(
			1.0 - smoothstep(0.0, ${f(CONTACT.overwash)}, max(P.y - topY, 0.0)),
			${f(CONTACT.submergeBias)}
		) * step(rXZ, SPHERE_R);
		m = max(m, max(beside, over));
	}
	// BUOYS. A box has a height-independent footprint, so this 2D signed
	// distance settles WHETHER the water is against it — the same shape
	// of test the foam field uses, which is why the field never tears
	// around ripples. Height only scales HOW WIDE the collar spreads;
	// used as a gate it left fragments matching no case, which painted
	// nothing and let plain water cut across the collar behind them.
	for (int i = 0; i < 3; i++) {
		vec3 lp = (uBuoyInv[i] * vec4(P, 1.0)).xyz;
		vec2 q = abs(lp.xz) - BUOY_HALF.xz;
		float d = length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0);
		if (d > w) continue;
		float vk = pow(
			1.0 - smoothstep(0.0, ${f(CONTACT.overwash)}, max(lp.y - BUOY_HALF.y, 0.0)),
			${f(CONTACT.submergeBias)}
		) * (1.0 - smoothstep(0.0, ${f(CONTACT.liftFade)}, max(-BUOY_HALF.y - lp.y, 0.0)));
		float wEff = w * mix(${f(CONTACT.spreadFloor)}, 1.0, vk);
		m = max(m, (1.0 - smoothstep(wEff * ${f(1 - CONTACT.soft)}, wEff, max(d, 0.0))) * vk);
	}
	return m;
}

// Ray vs a buoy's oriented box: slab test in the box's local frame.
// Returns the entering t (world units, both frames are rigid) or -1;
// writes the world-space face normal.
uniform mat4 uBoatInv;
uniform sampler2D uBoatTex;
// Three auto-declares viewMatrix in fragment shaders but NOT
// projectionMatrix — referencing it kills the compile silently. Fed from
// the camera every frame instead.
uniform mat4 uProj;

// The hull as a SIGNED DISTANCE FIELD, sphere-traced. boatHit's contract
// is unchanged — nearest t plus a surface normal — but both now come from
// the real mesh, baked at load (sdf.ts): the refraction bends around the
// actual hull, and the caustic and underwater shading read a true surface
// point and normal, which is what keeps a body recognisable underwater.
// The image pass still supplies colour. Fish and the Blender hull inherit
// all of this by being baked the same way.
uniform sampler2D uBoatSdf;
uniform vec3 uBoatSdfMin;
uniform vec3 uBoatSdfSize;

float boatSdfAt(vec3 q) {
	vec3 u = clamp((q - uBoatSdfMin) / uBoatSdfSize, 0.0, 1.0);
	// slice index + mix across the 48-deep stack of 8x6 tiles
	float z = u.z * 47.0;
	float z0 = floor(min(z, 46.0));
	float fz = z - z0;
	vec2 sxy = u.xy * vec2(0.989583, 0.975000) + vec2(0.005208, 0.012500);
	vec2 tile0 = vec2(mod(z0, 8.0), floor(z0 / 8.0));
	vec2 tile1 = vec2(mod(z0 + 1.0, 8.0), floor((z0 + 1.0) / 8.0));
	float d0 = texture2D(uBoatSdf, (tile0 + sxy) * vec2(0.125000, 0.166667)).r;
	float d1 = texture2D(uBoatSdf, (tile1 + sxy) * vec2(0.125000, 0.166667)).r;
	return mix(d0, d1, fz);
}

float boatHit(vec3 ro, vec3 rd, out vec3 nWorld) {
	vec3 o = (uBoatInv * vec4(ro, 1.0)).xyz;
	vec3 d = (uBoatInv * vec4(rd, 0.0)).xyz;
	// enter the SDF's bounding box first
	vec3 invD = 1.0 / d;
	vec3 t0v = (uBoatSdfMin - o) * invD;
	vec3 t1v = (uBoatSdfMin + uBoatSdfSize - o) * invD;
	vec3 tmin3 = min(t0v, t1v);
	vec3 tmax3 = max(t0v, t1v);
	float tN = max(max(tmin3.x, tmin3.y), tmin3.z);
	float tF = min(min(tmax3.x, tmax3.y), tmax3.z);
	if (tN > tF || tF < 0.0) return -1.0;
	float t = max(tN + 0.001, 0.0);
	for (int i = 0; i < 28; i++) {
		vec3 q = o + d * t;
		float dist = boatSdfAt(q);
		if (dist < 0.02) {
			vec2 e = vec2(0.06, 0.0);
			vec3 nL = normalize(vec3(
				boatSdfAt(q + e.xyy) - boatSdfAt(q - e.xyy),
				boatSdfAt(q + e.yxy) - boatSdfAt(q - e.yxy),
				boatSdfAt(q + e.yyx) - boatSdfAt(q - e.yyx)));
			nWorld = normalize(nL * mat3(uBoatInv));
			return t;
		}
		// 0.9 safety on the step: linear filtering can slightly overstate
		// the distance right at a slice boundary
		t += max(dist * 0.9, 0.012);
		if (t > tF) return -1.0;
	}
	return -1.0;
}

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
	// Ripples and the object wave both shade at their own resolution
	// rather than the mesh's: their slopes are recomputed here and added
	// onto the interpolated analytic wave normal.
	// Ripples, the small surface waves and the object wave all shade at
	// their OWN resolution rather than the mesh's: each slope is
	// recomputed here per pixel and added onto the interpolated analytic
	// wave normal. That is what lets detail finer than a 0.5m quad tilt
	// the surface for lighting without a single extra vertex — and the
	// specular lives on exactly that, since a glint appears only where
	// the normal reaches the mirror angle.
	vec2 slope = vSlope + ${PROFILE.skipRipple ? 'vec2(0.0)' : 'rippleShadeGrad(vWorld.xz)'}
		${ENABLE.fftDetail ? '+ detailSlope(vWorld.xz, uTime)' : ''}
		${ENABLE.objectWave ? '+ objectWaveSlope(vWorld.xz, vWorld.y)' : ''};
	vec3 normal = normalize(vec3(-slope.x, 1.0, -slope.y));
	// THE view direction for this pixel. Under the isometric camera it is
	// one constant for the whole screen — which is exactly why that camera
	// cannot produce a glitter path. Under a real perspective camera it
	// varies per pixel, and everything downstream (refraction, Fresnel,
	// specular) becomes honest with no further special-casing.
	vec3 viewDir = ${PROFILE.perspectiveCamera ? 'normalize(uCamPos - vWorld)' : 'uViewDir'};


	// Pool-style view refraction: the underwater scene is drawn BY the
	// water. Refract the eye ray at this facet's normal, intersect it with
	// the sphere (floor plane on a miss), and shade the hit with the SAME
	// shadeUnderwater the sphere mesh uses — so the submerged body sways
	// and shatters with every wave and ripple, while the dry crown
	// (rasterized normally above the surface) stays put, pencil-in-water
	// style.
	vec3 eye = -viewDir;
	${PROFILE.skipRefraction ? `vec3 transmitted = uFloorColor * (0.1 + 0.32 * uLightI);` : `
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
	{
		vec3 bn;
		float tb = boatHit(vWorld, refr, bn);
		if (tb > 0.0 && (tHit < 0.0 || tb < tHit)) {
			// Project the analytic hit through the camera and read the
			// boat's actual rendered image there. The polytope shapes the
			// refraction; the texture carries every modelled detail. Alpha
			// zero means the ray passed through the bound's slack beside
			// the real hull — not a hit at all.
			vec3 bp = vWorld + refr * tb;
			vec4 bclip = uProj * viewMatrix * vec4(bp, 1.0);
			vec2 buv = (bclip.xy / bclip.w) * 0.5 + 0.5;
			vec4 bimg = texture2D(uBoatTex, buv);
			if (bimg.a > 0.35) {
				tHit = tb;
				hitN = bn;
				albedo = bimg.rgb;
			}
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
	}`}
	// The tint the old translucent layer contributed by alpha blending,
	// now composed in-shader; uAlphaBase is still the clarity knob.
	transmitted = mix(transmitted, uWaterColor, uAlphaBase);

	// Wallace-style reflection: reflect the eye ray and sample the SKY in
	// that direction — the preset's vertical gradient with the sun's glare
	// living IN the sky — instead of a single flat sky color. His fresnel
	// too: a substantial base reflectivity rising to 1 at grazing, which
	// is what makes water read as a mirror at low angles.
	vec3 reflectedRay = reflect(eye, normal);
	${PROFILE.skipReflection ? `float fresnel = 0.25;
	vec3 col = transmitted;` : `float facing = clamp(dot(normal, viewDir), 0.0, 1.0);
	float fresnel = mix(0.25, 1.0, pow(1.0 - facing, 3.0));
	vec3 skyCol = mix(uSkyHorizon, uSkyZenith, clamp(reflectedRay.y, 0.0, 1.0));
	vec3 col = mix(transmitted, skyCol, fresnel);`}

	// SUN SPECULAR — the sun's mirror image, added on top of the Fresnel
	// blend rather than mixed into it.
	//
	// Inside the blend it was multiplied by a Fresnel basing at 0.25, so a
	// highlight kept a quarter of its strength at the angles this camera
	// works at and read as a diffuse sheen. Water's reflectance there
	// really is small — but the sun's radiance is large enough that its
	// glitter still clips to white, and only the reflectance half of that
	// was being modelled. fresnelMix sets how much angle dependence to keep.
	//
	// WHY THERE IS A SIMULATED VIEWPOINT AT ALL. A glitter path is a
	// perspective effect: it exists because the view direction varies
	// across the scene, which varies the facet slope needed to mirror the
	// sun, which makes the density of qualifying facets fall away from the
	// reflection. An orthographic camera has NO view-direction variation,
	// so it cannot produce one — every qualifying facet on screen lights at
	// once, scattered evenly. So the specular, and only the specular,
	// converges its rays on a point (uCamPos). Under a perspective camera
	// that point is the real one and none of this is a fake.
	//
	// Two earlier attempts are gone. Feeding a tuned "virtual eye" into the
	// mirror test itself widened the range of slopes that qualified, which
	// invented highlights at hours the sun could not possibly reflect. A
	// separate Cox-Munk envelope multiplied over the honest ortho test kept
	// the timing but could not be made to hold the reflection on screen as
	// the sun set. The viewpoint below is the simpler answer: give the
	// projection the eye it lacks, and tune where that eye stands.
	${
		PROFILE.skipSpecular
			? ''
			: `// Rays converge on uCamPos — the real camera under a perspective
	// view, the simulated viewpoint under the isometric one, where ortho
	// has no eye distance of its own to borrow.
	vec3 specEye = normalize(uCamPos - vWorld);
	vec3 specH = normalize(specEye + normalize(uSunDir));
	// Worked in SLOPE space rather than pow(dot(reflected, sun), n): the two
	// agree to 6e-5, and this form is what lets the lobe be ANISOTROPIC —
	// stretched along the wind, which is the shape a real glitter path has
	// (Cox & Munk measured the sea tilting further along the wind than
	// across it). dS is the facet slope this pixel would need, minus the
	// slope it has.
	vec2 dS = vec2(slope.x + specH.x / max(specH.y, 0.001),
		slope.y + specH.z / max(specH.y, 0.001));
	float dA = dot(dS, uWindDir);
	float dC = dS.x * uWindDir.y - dS.y * uWindDir.x;
	float qA = dA * dA;
	float qC = dC * dC;
	// Dense core inside a slacker, dimmer wash. The wash accepts facets the
	// core rejects, which is what keeps a shimmer alive once the sun drops
	// and the required tilt runs past what the core will take.
	float sigCore = 0.25 / uSpecSharpCore;
	float sigWash = 0.25 / uSpecSharpWash;
	float specCore = exp(-0.5 * (qA / (sigCore * uSpecAniso) + qC * uSpecAniso / sigCore));
	float specWash = exp(-0.5 * (qA / (sigWash * uSpecAniso) + qC * uSpecAniso / sigWash));
	// No reflection from a sun under the horizon, or one the facet faces away from.
	float specVis = step(0.001, specH.y) * step(0.0, normalize(uSunDir).y);
	col += uSunColor * (uSunI * uSpecGain * uSpecFade * specVis
		* (specCore + uSpecHaloGain * specWash)
		* mix(1.0, fresnel, uSpecFresnelMix));`
	}

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
	// Two DIFFERENT whites, deliberately shaded differently:
	//  - the LOOP ribbon is the same substance as the foam sprites and
	//    splash droplets that erupt from it, so it takes their flat,
	//    sky-facing colour and matches them exactly.
	//  - the persistent foam FIELD lies on the water, so it keeps the
	//    per-pixel wave normal and the relief that comes with it.
	// THE LOOP IS THE BACKFACE. Where a Gerstner crest overturns, the
	// rest -> world map inverts and the mesh's winding flips with it, so
	// the water you can see inside a breaking loop is literally the
	// underside of the sheet. The rasteriser already knows this per
	// pixel and for free.
	//
	// Everything before this asked the wave field to describe that
	// region second-hand — Jacobian ramps, froth factors, distance
	// fields, tracked loops — and every one of them was either too
	// narrow, too eager on unbroken swell, or (once loop tracking got
	// involved) flickery, because the answer was being reconstructed
	// frame by frame from a re-jittering scan. gl_FrontFacing is the
	// same fact, exact, stable and with no state at all behind it.
	// EXACT: the inverted sheet itself, straight off the rasteriser.
	${PROFILE.skipLoopWhite ? '' : `float backface = ${ENABLE.loopWhite ? `(gl_FrontFacing ? 0.0 : 1.0) * ${f(LOOP.backfaceWhite)}` : '0.0'};
	// RECONSTRUCTED: the Jacobian and overhang ramps. Refined per pixel
	// only where the vertex estimate lands mid-ramp — a whole extra wave
	// pass is not worth paying on water that is plainly one or the other.
	float ramps = ${ENABLE.loopWhite ? 'vPinchWhite' : '0.0'};
	if (ramps > 0.01 && ramps < 0.99) ramps = pinchMask(vRest);
	// The thin gate applies to the RAMPS only. The backface is not an
	// estimate that can be wrong about a hairline — it is the sheet.
	float thin = ${
		LOOP.thinSk > 0
			? `1.0 - smoothstep(${f(LOOP.thinSk * 0.75)}, ${f(LOOP.thinSk)}, vLoopSk)`
			: '0.0'
	};
	ramps *= (1.0 - thin) * ${f(LOOP.rampWhite)};
	float loopWhite = max(backface, ramps);`}
	// The two foams stay separate SUBSTANCES — the collar never enters
	// the field, so it cannot drift, diffuse, decay or be governed by the
	// field's mass budget — but they share one SKELETON. Feeding the
	// collar's strength in as a thickness means a collar thinning out
	// (object going under, footprint shrinking) tears into the same lace
	// the field does, opening cell by cell with the same per-cell
	// character, instead of simply dimming. Taking the max rather than
	// summing also means one web where they overlap, not two drawn over
	// each other.
	${PROFILE.skipFoam ? '' : `float fieldT = ${ENABLE.foamField ? 'foamThicknessAt(vRest)' : '0.0'};
	// The pinned collar, ON TOP of whatever the field holds. Objects also
	// EMIT into the field (foam.ts) and that foam arrives through fieldT,
	// already drifting and dying like the rest — the two are meant to be
	// seen together, the collar marking the waterline and the emission
	// trailing off it. Baked out entirely when the sea is too calm to
	// foam, rather than left at zero width: a zero-width smoothstep has
	// equal edges, which is undefined in GLSL and returns 1, so the
	// calmest sea got the THICKEST collar.
	float contactT = ${
		ENABLE.contactFoam ? `contactFoam(vWorld) * ${f(CONTACT.alpha)}` : '0.0'
	};
	// One web over both, so a fading collar tears into the same lace the
	// field does, and overlapping foam draws one pattern rather than two.
	float foamAmt = foamWeb(vRest, max(fieldT, contactT), vJacobian);
	vec3 foamN = normalize(vec3(-slope.x, 1.0, -slope.y));
	vec3 foamLit = whitewaterLight(uFoamColor, foamN, ${f(1 - FOAM.shapeFloor)});
	col = mix(col, foamLit, foamAmt);`}
	${
		PROFILE.skipLoopWhite
			? ''
			: `vec3 flatLit = whitewaterLight(uFoamColor, vec3(0.0, 1.0, 0.0), ${f(1 - FOAM.shapeFloor)});
	${
		LOOP.debugThin
			? 'col = mix(col, mix(flatLit, vec3(0.95, 0.15, 0.1), thin), max(backface, vPinchWhite));'
			: 'col = mix(col, flatLit, loopWhite);'
	}`
	}

	${fogGlsl('fog')}
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
uniform float uDomAmp;
uniform vec2 uWinCenter;
uniform float uAmp;
varying float vViewZ;
varying float vHeight;
varying float vJacobian;
varying vec3 vWorld;
varying vec2 vRest;
varying vec2 vSlope;
varying float vOverhang;
varying float vLoopSk;
varying float vPinchWhite;

${wavesGlsl()}
${ENABLE.objectWave ? objWaveGlsl : ''}
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
	float wAmp = 0.0;
	float wsum = 0.0;
	float hwx = 0.0;
	float hwz = 0.0;
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
		// Pinch-weighted amplitude + heading votes (sprite-size twin and
		// the stretch's stable pull direction).
		float pw = max(qak * sn, 0.0);
		pw *= pw;
		wAmp += wb.x * pw;
		hwx += wa.x * pw;
		hwz += wa.y * pw;
		wsum += pw;
	}
	${objWaveApply('world.xz', 'p.y', 'p += ow;')}
	vec3 Tu = vec3(1.0 + txx, txy, txz);
	vec3 Tv = vec3(txz, tzy, 1.0 + tzz);
	vec3 Na = cross(Tv, Tu);
	// From the FULL frame, object wave included. waveJacobian above sees
	// only the spectrum, so without this every consumer of J carries on
	// as though the object's wave were not there.
	vJacobian = Na.y;
	vSlope = -Na.xz / max(Na.y, 0.2);
	// NORMALIZED normal y: -> 0 means the surface tips vertical, < 0
	// means it OVERHANGS — the visible rolling tongue of a breaking
	// loop, which the Jacobian ramp misses (J marks the compressed seam
	// hidden INSIDE the fold, not the thrown water rolling over it).
	// Raw Na.y would be wrong here: unnormalized, it IS approximately
	// the Jacobian determinant again.
	vOverhang = Na.y / max(length(Na), 0.0001);
	// STRETCH the pinched loop toward the foam sprite centers: the flat
	// discs depth-test at their centers ~0.8r behind the surface along
	// -normal, and the sheet in front of that plane showed as a dark
	// line slicing them. Pulling the pinch-zone surface along -normal
	// fills the wedge between fold and sprite plane with WHITE water.
	// SHARED FROTH CRITERION: the same smoothstep(0.1, 0.42) gate the
	// sprites use — a loop that generates no sprites neither whitens
	// nor stretches, so all three systems agree on which pinches count.
	// Compressed absolute sizing — see FROTH.ampCurve. max() guards pow(0, x),
	// which is undefined in GLSL for a zero base.
	float ampK = clamp(pow(max((wsum > 0.0001 ? wAmp / wsum : 0.0) / uDomAmp, 0.0001), ${f(FROTH.ampCurve)}), 0.3, 1.0);
	float intK = mix(0.4, 1.0, clamp((0.1 - vJacobian) / 0.55, 0.0, 1.0));
	float sk = ampK * intK;
	sk *= 1.0 + 0.5 * smoothstep(0.15, 0.55, sk);
	// NEAR-BINARY gate for the water: the 0.1 criterion decides WHICH
	// pinches whiten, but qualifying ones whiten at full harshness (the
	// narrow 0.1-0.16 ramp only smooths the on/off boundary; the
	// sprites keep their own wider size-ease ramp).
	float vis = smoothstep(0.1, 0.16, sk);
	vLoopSk = sk;
	// The fold's own ramps: sharp, and saturated at a real fold. A
	// coarse per-vertex estimate — the fragment refines it through
	// pinchMask wherever it lands mid-ramp.
	vPinchWhite = ${rampWhiteGlsl('vJacobian', 'vOverhang', null)};
	float stretchGate = ${ENABLE.loopStretch ? `(1.0 - smoothstep(0.0, ${f(LOOP.stretchJRamp)}, vJacobian)) * vis` : '0.0'};
	if (stretchGate > 0.001) {
		// Pull by 0.8 x the reconstructed local sprite radius, along a
		// STABLE direction: backward against the pinch-weighted heading
		// and down into the wave body. The raw normal swings wildly
		// between adjacent vertices at a fold — pulling along it painted
		// a squiggly sheet, worst on crests diagonal to the mesh grid.
		float frothR = ${f(LOOP.stretchFrothR)} * min(sk, ${f(FROTH.sizeCap)});
		vec2 hd = wsum > 0.0001 ? normalize(vec2(hwx, hwz)) : vec2(1.0, 0.0);
		vec3 pullDir = normalize(vec3(-hd.x * ${f(LOOP.stretchBack)}, -${f(LOOP.stretchDown)}, -hd.y * ${f(LOOP.stretchBack)}));
		p += pullDir * (frothR * ${f(LOOP.stretchDepth)} * stretchGate);
	}
	vPinchWhite = ${LOOP.whiteFromStretch ? 'max(vPinchWhite, stretchGate)' : 'vPinchWhite'} * vis;
	// SPREAD: extend the white outward from thick loops.
	//
	// Widening the J threshold cannot do this, which is why the earlier
	// attempt saturated and then started painting flat water. The white
	// was foldTest * vis, and vis gates on the LOCAL froth factor -- so
	// no matter how wide the J window opened, the paint stopped dead at
	// the sk = 0.1 contour, and inside that contour it eventually filled
	// everything, peak or not. Worse, the widening keyed off the same
	// vertex's sk, and the vertices we want to newly whiten are exactly
	// the ones whose sk is low. It could never reach past itself.
	//
	// So measure distance instead. J is smooth and crosses zero AT the
	// fold, so to first order the distance from here to the nearest fold
	// line is J / |grad J| — in metres, from the gradient accumulated
	// above. Points far from any fold are excluded by construction,
	// which is what keeps flat water dark.

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
	${fogGlsl('fog')}
	col = mix(col, uFogColor, fog);

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
		uCausticFlat: waterUniforms.uCausticFlat,
		uSkyZenith: waterUniforms.uSkyZenith,
		uSkyHorizon: waterUniforms.uSkyHorizon
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
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
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
	// slice a hard line across the crown. The sun's COLOUR matters as
	// much as its intensity — shading by uLightI alone left the dry
	// crown grey at dusk while the submerged half glowed warm, because
	// shadeUnderwater does multiply by uLightColor. Ambient comes from
	// the SKY (zenith above, horizon toward the rim), so the unlit side
	// picks up the same dusk tint the water reflects.
	float wrap = clamp((dot(normal, sun) + 0.4) / 1.4, 0.0, 1.0);
	vec3 skyAmb = mix(uSkyHorizon, uSkyZenith, clamp(normal.y * 0.5 + 0.5, 0.0, 1.0));
	vec3 dry = uSphereColor * (skyAmb * 0.45 + uLightColor * (0.75 * wrap * uLightI));

	// --- Wet branch: shadeUnderwater (shared with the water raytrace, see
	// its definition for the lighting model). Only reached by fragments
	// the opaque water surface doesn't cover — i.e. the thin waterline
	// blend band on an exposed crown.
	vec3 wet = shadeUnderwater(vWorld, normal, uSphereColor, max(waterY - vWorld.y, 0.0));

	vec3 col = mix(dry, wet, submerged);

	${fogGlsl('fog')}
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

	// Ballistic spray droplets (spray.ts) as POINT SPRITES — one vertex
	// each instead of an instanced octahedron, matching how the foam
	// masses are drawn. Cheaper (no per-droplet matrix, ~1/20th the
	// vertices) and consistent: droplets ARE foam in flight, so they
	// take the same flat, sky-facing shading and the same colour.
	// Streaking survives as a screen-space ellipse carved in the
	// fragment, since a point sprite is always a square.
	const sprayPositions = new Float32Array(MAX_SPRAY * 3);
	const spraySizes = new Float32Array(MAX_SPRAY);
	const sprayVels = new Float32Array(MAX_SPRAY * 3);
	const sprayGeometry = new THREE.BufferGeometry();
	const sprayPosAttr = new THREE.BufferAttribute(sprayPositions, 3);
	const spraySizeAttr = new THREE.BufferAttribute(spraySizes, 1);
	const sprayVelAttr = new THREE.BufferAttribute(sprayVels, 3);
	sprayPosAttr.setUsage(THREE.DynamicDrawUsage);
	spraySizeAttr.setUsage(THREE.DynamicDrawUsage);
	sprayVelAttr.setUsage(THREE.DynamicDrawUsage);
	sprayGeometry.setAttribute('position', sprayPosAttr);
	sprayGeometry.setAttribute('aSize', spraySizeAttr);
	sprayGeometry.setAttribute('aVel', sprayVelAttr);
	const sprayMaterial = new THREE.ShaderMaterial({
		uniforms: {
			// SHARED with the foam: a droplet is foam that is airborne.
			uColor: waterUniforms.uFoamColor,
			uFogColor: waterUniforms.uFogColor,
			uFogDensity: waterUniforms.uFogDensity,
			uSkyZenith: waterUniforms.uSkyZenith,
			uSkyHorizon: waterUniforms.uSkyHorizon,
			uSunColor: waterUniforms.uSunColor,
			uSunI: waterUniforms.uSunI,
			uSunDir: waterUniforms.uSunDir,
			uSunDiffusion: waterUniforms.uSunDiffusion,
			uPointPx: { value: zoom * Math.min(window.devicePixelRatio || 1, 1.5) }
		},
		vertexShader: `
uniform float uPointPx;
attribute float aSize;
attribute vec3 aVel;
varying float vViewZ;
varying vec2 vDir;
varying float vStretch;
void main() {
	vec4 view = modelViewMatrix * vec4(position, 1.0);
	vViewZ = -view.z;
	// Motion streak, in screen space: project the droplet's velocity and
	// grow the quad along it. Volume-preserving, so a streaking droplet
	// thins as it lengthens.
	vec4 c0 = projectionMatrix * view;
	vec4 c1 = projectionMatrix * (view + vec4(aVel, 0.0));
	vec2 d = c1.xy / max(c1.w, 0.0001) - c0.xy / max(c0.w, 0.0001);
	float sp = length(aVel);
	vStretch = min(1.0 + sp * ${f(DROPLET.streakPerSpeed)}, ${f(DROPLET.streakCap)});
	vDir = length(d) > 0.00001 ? normalize(d) : vec2(1.0, 0.0);
	// Same cull as the froth masses — see the note there. This one has
	// been invisible only by luck: a spent droplet's last position is at or
	// under the water, where the opaque surface hides its stray pixel. One
	// that expires in mid-air would show.
	float px = aSize * 2.0 * uPointPx * vStretch;
	if (px < 1.0) {
		gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
		gl_PointSize = 0.0;
		return;
	}
	gl_PointSize = px;
	gl_Position = c0;
}`,
		fragmentShader: `
uniform vec3 uColor;
uniform vec3 uFogColor;
uniform float uFogDensity;
${WHITEWATER_UNIFORM_DECLS}
varying float vViewZ;
varying vec2 vDir;
varying float vStretch;
${whitewaterLightGlsl()}
void main() {
	// Carve an ellipse out of the square: long along the motion, the
	// original width across it.
	vec2 pc = gl_PointCoord - 0.5;
	pc.y = -pc.y;
	float along = dot(pc, vDir);
	float across = pc.x * vDir.y - pc.y * vDir.x;
	if (length(vec2(along, across * vStretch)) * 2.0 > 1.0) discard;
	// FLAT and sky-facing, exactly like the foam masses: a screen-facing
	// disc has no honest normal to sculpt. Same shapeAmt as the sprites
	// too — passing 0 here skipped the directional term entirely and
	// left droplets a few percent brighter than the foam they came from.
	vec3 lit = whitewaterLight(uColor, vec3(0.0, 1.0, 0.0), ${f(1 - FOAM.shapeFloor)});
	${fogGlsl('fog')}
	gl_FragColor = vec4(mix(lit, uFogColor, fog), 1.0);
}`
	});
	const sprayMesh = new THREE.Points(sprayGeometry, sprayMaterial);
	sprayMesh.frustumCulled = false;

	// FROTH: one scaled-up point sprite per grid
	// intersection instead of sphere meshes — a single vertex each, so
	// the field is ~20x lighter than the octa version. The sprite's
	// center rides under the surface (hidden by depth) and pops out when
	// the sheet overturns; the steepness gate scales both the offset and
	// the pixel size. position = (anchorX, radius, anchorZ).
	const quadNear = new THREE.Vector3();
	const quadFar = new THREE.Vector3();
	const quadCorners: number[] = [];
	const QUAD_NDC: [number, number][] = [
		[-1, -1],
		[1, -1],
		[1, 1],
		[-1, 1]
	];
	function updateViewQuad() {
		const cam = camera.current;
		if (!cam) return;
		quadCorners.length = 0;
		for (const [nx, ny] of QUAD_NDC) {
			quadNear.set(nx, ny, -1).unproject(cam);
			quadFar.set(nx, ny, 1).unproject(cam);
			const dy = quadFar.y - quadNear.y;
			if (Math.abs(dy) < 1e-6) return;
			const tHit = -quadNear.y / dy;
			quadCorners.push(
				quadNear.x + (quadFar.x - quadNear.x) * tHit,
				quadNear.z + (quadFar.z - quadNear.z) * tHit
			);
		}
		// Push each corner out from the centre: waves sway in from just
		// past the edge, and their froth should still throw.
		let cx = 0;
		let cz = 0;
		for (let i = 0; i < 4; i++) {
			cx += quadCorners[i * 2] / 4;
			cz += quadCorners[i * 2 + 1] / 4;
		}
		for (let i = 0; i < 4; i++) {
			const dx = quadCorners[i * 2] - cx;
			const dz = quadCorners[i * 2 + 1] - cz;
			const len = Math.hypot(dx, dz) || 1;
			quadCorners[i * 2] += (dx / len) * EDGE_MARGIN;
			quadCorners[i * 2 + 1] += (dz / len) * EDGE_MARGIN;
		}
		setViewQuad(quadCorners);
	}
	function buildFrothGeometry() {
		// Dense base lattice; the shader thins it dynamically by sprite
		// size (small beads pack tight, big masses stay sparse).
		// Read from the knob, not duplicated: spray.ts sizes its droplet
		// emission from the same number, and the two silently disagreed.
		const S = FROTH.lattice;
		const half =
			0.71 * (window.innerWidth / zoom / 2) +
			1.34 * (window.innerHeight / zoom / 2) +
			EDGE_MARGIN;
		// The droplet scan must cover the same ground as the froth field,
		// or froth in the window's outer corners never throws.
		setScanExtent(half);
		const pos: number[] = [];
		const rank: number[] = [];
		for (let gx = -half; gx <= half; gx += S) {
			for (let gz = -half; gz <= half; gz += S) {
				const h2 = Math.abs(Math.sin(gx * 37.719 + gz * 53.117) * 24634.6345) % 1;
				const h3 = Math.abs(Math.sin(gx * 91.331 + gz * 17.923) * 15731.743) % 1;
				// radiusBase + radiusVar, carried as the attribute frothFrame
				// reads as baseR. (The /3 x3 pairing was a leftover scale.)
				pos.push(gx, FROTH.radiusBase + FROTH.radiusVar * h2, gz);
				rank.push(h3);
			}
		}
		const g = new THREE.BufferGeometry();
		g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
		g.setAttribute('aRank', new THREE.Float32BufferAttribute(rank, 1));
		return g;
	}
	let frothGeometry = buildFrothGeometry();
	// Shared sprite frame/sizing GLSL — the mist EMITTER runs the exact
	// same function, so every plume is born at a real sprite's centre.
	const frothFrameGlsl = `
float frothFrame(vec2 anchor, float baseR, float rank, out vec3 surf, out vec3 Nn, out float g) {
	vec3 d = waveDisplacement(anchor, uTime, uAmp);
	float txx = 0.0; float txy = 0.0; float txz = 0.0; float tzy = 0.0; float tzz = 0.0;
	float wAmp = 0.0; float wsum = 0.0;
	for (int i = 0; i < WAVE_COUNT; i++) {
		vec4 wa = uWaveA[i];
		vec3 wb = uWaveB[i];
		float th = (anchor.x * wa.x + anchor.y * wa.y) * wa.z - wa.w * uTime + wb.z;
		float sn = sin(th);
		float cs = cos(th);
		float qak = wb.y * wb.x * uAmp * wa.z;
		float ak = wb.x * uAmp * wa.z;
		txx -= qak * wa.x * wa.x * sn;
		txy += ak * wa.x * cs;
		txz -= qak * wa.x * wa.y * sn;
		tzy += ak * wa.y * cs;
		tzz -= qak * wa.y * wa.y * sn;
		// Pinch-weighted amplitude vote: which wave is folding here, and
		// how BIG is it? (Same weighting as the CPU's loopVelocity.)
		float pw = max(qak * sn, 0.0);
		pw *= pw;
		wAmp += wb.x * pw;
		wsum += pw;
	}
	${objWaveApply('anchor + d.xz', 'd.y', 'd += ow;')}
	vec3 Tu = vec3(1.0 + txx, txy, txz);
	vec3 Tv = vec3(txz, tzy, 1.0 + tzz);
	vec3 Na = cross(Tv, Tu);
	Nn = Na / max(length(Na), 0.0001);
	// EASED motion, statelessly: a WIDER J band stretches growth over
	// the fold's whole approach, and a second Jacobian evaluated
	// FROTH.gateLag seconds in the PAST gives a release tail.
	float gNow = 1.0 - smoothstep(${f(FROTH.gateJFull)}, ${f(FROTH.gateJStart)}, Na.y);
	float jxx = 1.0; float jzz = 1.0; float jxz = 0.0;
	for (int i = 0; i < WAVE_COUNT; i++) {
		vec4 wa = uWaveA[i];
		vec3 wb = uWaveB[i];
		float th = (anchor.x * wa.x + anchor.y * wa.y) * wa.z - wa.w * (uTime - ${f(FROTH.gateLag)}) + wb.z;
		float qak = wb.y * wb.x * uAmp * wa.z * sin(th);
		jxx -= qak * wa.x * wa.x;
		jzz -= qak * wa.y * wa.y;
		jxz -= qak * wa.x * wa.y;
	}
	float Jp = jxx * jzz - jxz * jxz;
	float gPast = 1.0 - smoothstep(${f(FROTH.gateJFull)}, ${f(FROTH.gateJStart)}, Jp);
	g = max(gNow, gPast * ${f(FROTH.gateLagWeight)});
	// Size = folder amplitude ratio (ceiling) x pinch intensity.
	float loopAmp = wsum > 0.0001 ? wAmp / wsum : 0.0;
	float ampK = clamp(pow(max(loopAmp / uDomAmp, 0.0001), ${f(FROTH.ampCurve)}), ${f(FROTH.ampRatioFloor)}, 1.0);
	float iNow = clamp((${f(FROTH.intJStart)} - Na.y) / ${f(FROTH.intJSpan)}, 0.0, 1.0);
	float iPast = clamp((${f(FROTH.intJStart)} - Jp) / ${f(FROTH.intJSpan)}, 0.0, 1.0);
	// The lagged intensity is weighted by the same gateLagWeight as the
	// lagged gate above: it is the one "how much does the past count"
	// number, and having two independent 0.9s here was how it read before.
	float intK = mix(${f(FROTH.intFloor)}, 1.0, max(iNow, iPast * ${f(FROTH.gateLagWeight)}));
	float sk = ampK * intK;
	sk *= 1.0 + ${f(FROTH.curveBoost)} * smoothstep(${f(FROTH.curveStart)}, ${f(FROTH.curveEnd)}, sk);
	float visible = smoothstep(${f(FROTH.visStart)}, ${f(FROTH.visFull)}, sk);
	float dens = mix(${f(FROTH.densMax)}, ${f(FROTH.densMin)}, smoothstep(${f(FROTH.densStart)}, ${f(FROTH.densEnd)}, sk));
	float keep = smoothstep(0.0, ${f(FROTH.densSoft)}, dens - rank);
	float r = baseR * min(sk, ${f(FROTH.sizeCap)}) * visible * keep;
	if (r < ${f(FROTH.cullRadius)}) r = 0.0;
	surf = vec3(anchor.x + d.x, d.y, anchor.y + d.z);
	return r;
}`;

	const frothMaterial = new THREE.ShaderMaterial({
		uniforms: {
			uTime: waterUniforms.uTime,
			uAmp: waterUniforms.uAmp,
			uWaveA: waterUniforms.uWaveA,
			uWaveB: waterUniforms.uWaveB,
			// SHARED with the foam field: sprites are foam, so they must be
			// the same colour by construction, not by two matching hexes.
			uColor: waterUniforms.uFoamColor,
			uFogColor: waterUniforms.uFogColor,
			uFogDensity: waterUniforms.uFogDensity,
			uPointPx: { value: zoom * Math.min(window.devicePixelRatio || 1, 1.5) },
			uDomAmp: waterUniforms.uDomAmp,
			uWinCenter,
			uSkyZenith: waterUniforms.uSkyZenith,
			uSkyHorizon: waterUniforms.uSkyHorizon,
			uSunColor: waterUniforms.uSunColor,
			uSunI: waterUniforms.uSunI,
			uSunDir: waterUniforms.uSunDir,
			uSunDiffusion: waterUniforms.uSunDiffusion,
		},
		vertexShader: `
uniform float uTime;
uniform float uAmp;
uniform float uPointPx;
uniform float uDomAmp;
uniform vec2 uWinCenter;
${wavesGlsl()}
${ENABLE.objectWave ? objWaveGlsl : ''}
${frothFrameGlsl}
attribute float aRank;
varying float vViewZ;
varying vec3 vNrm;
void main() {
	vec3 surf; vec3 Nn; float g;
	// WORLD anchor: the lattice recenters on the boat, and the offset is
	// snapped to multiples of the spacing, so local+centre lands on the
	// same world lattice. Size jitter and density rank are hashed from the
	// WORLD anchor — hashing the local grid would reroll every mass's size
	// on every recenter step, a full-screen froth shimmer while driving.
	vec2 anchor = position.xz + uWinCenter;
	float baseR = ${f(FROTH.radiusBase)} + ${f(FROTH.radiusVar)}
		* fract(abs(sin(anchor.x * 37.719 + anchor.y * 53.117) * 24634.6345));
	float rank = fract(abs(sin(anchor.x * 91.331 + anchor.y * 17.923) * 15731.743));
	float r = frothFrame(anchor, baseR, rank, surf, Nn, g);
	// (The hand-built bow froth that used to sit here — proximity band,
	// windward dot, authored roll cycle — is gone. The object PINCH does
	// that job upstream by bending the Gerstner map, so these masses now
	// surface through the ORDINARY froth criterion and inherit its
	// sizing, gating and motion instead of carrying private copies.)
	vec3 world = surf - Nn * (r * ${f(FROTH.submersion)} * g);
	// The foam mass rides the water: light it by the surface normal.
	vNrm = Nn;
	vec4 view = viewMatrix * vec4(world, 1.0);
	vViewZ = -view.z;
	// CULLED SPRITES MUST LEAVE CLIP SPACE, not merely shrink to nothing.
	// gl_PointSize = 0.0 does not hide a point: the driver clamps it to
	// ALIASED_POINT_SIZE_RANGE's minimum, which is 1 on desktop GL, so an
	// inactive mass still paints one fully opaque white pixel. The
	// fragment's disc test cannot catch it either — at one pixel
	// gl_PointCoord is 0.5 dead centre, so dd is 0 and nothing discards.
	// With one anchor per lattice cell that is a field of white specks
	// over the whole sea, which is exactly what it looked like.
	//
	// Moving the vertex out of clip space is the reliable cull and is safe
	// for POINTS (a triangle with only some corners moved still rasterises,
	// stretched toward the moved corner — that is why the bow crest mesh
	// discards in the fragment instead). Same pattern as the plume shader.
	// Cull on the DRAWN size, which is radius x emergence gate — see
	// FROTH.minPixels. Testing the radius alone (frothFrame does that with
	// cullRadius) misses a full-sized mass that is only fractionally out
	// of the water, and those were the specks along the crests.
	float px = r * 2.0 * uPointPx * g;
	if (px < ${f(FROTH.minPixels)}) {
		gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
		gl_PointSize = 0.0;
		return;
	}
	gl_PointSize = px;
	gl_Position = projectionMatrix * view;
}`,
		fragmentShader: `
uniform vec3 uColor;
uniform vec3 uFogColor;
uniform float uFogDensity;
${WHITEWATER_UNIFORM_DECLS}
varying float vViewZ;
varying vec3 vNrm;
${whitewaterLightGlsl()}
void main() {
	// Opaque round sprite: discard outside the disc keeps depth honest
	// (no transparency sorting), so the water still occludes correctly.
	float dd = length(gl_PointCoord - 0.5) * 2.0;
	if (dd > 1.0) discard;
	// FLAT, and matched to the foam. Two corrections to the water normal
	// first, both because of WHERE these sprites live:
	//  1. They surface at a FOLD, where the sheet is vertical or fully
	//     overturned — the normal there points sideways or straight
	//     DOWN, so lighting by it put most sprites in the dark-sea half
	//     of the hemisphere ambient. Flip any downward normal back up:
	//     a foam mass presents its top to the sky no matter which way
	//     the water under it has rolled.
	//  2. Bias the result toward world up, so a mass reads as a blob
	//     sitting proud of the surface rather than a decal painted on a
	//     near-vertical sheet. A little tilt survives, which is what
	//     keeps sprites from looking uniformly stamped.
	vec3 sn = vNrm.y < 0.0 ? -vNrm : vNrm;
	vec3 upN = normalize(mix(vec3(0.0, 1.0, 0.0), sn, ${f(FROTH.normalTilt)}));
	vec3 lit = whitewaterLight(uColor, upN, ${f(1 - FOAM.shapeFloor)});
	${fogGlsl('fog')}
	gl_FragColor = vec4(mix(lit, uFogColor, fog), 1.0);
}`
	});
	const frothMesh = new THREE.Points(frothGeometry, frothMaterial);
	frothMesh.frustumCulled = false;

	// ---- BOW CREST: a strip of mesh riding the water at the nose ----
	//
	// Its own geometry rather than a deformation of the water, so its
	// shape owes nothing to the water's tessellation — which is the whole
	// point. Deforming the water can only express a fold several metres
	// across, because a fold costs a pile of water as big as itself; a
	// separate strip can be as tight as it likes.
	//
	// It stays welded to the surface by sampling the SAME wave
	// displacement at the same rest positions, so it rises, falls and
	// sways with the swell with nothing to keep in sync.
	//
	// The plane's two axes are reinterpreted: x runs ALONG the arc, y runs
	// AROUND the lip's cross-section.
	const bowCrestGeometry = new THREE.PlaneGeometry(
		1,
		1,
		BOWCREST.segArc,
		BOWCREST.segLip
	);

	/**
	 * The crest's SHAPE lives entirely in this vertex shader — the
	 * geometry is a bare unit plane whose two axes are reinterpreted. So
	 * a wireframe view has to run the same shader; a plain wireframe
	 * material would draw the undeformed plane and show nothing useful.
	 */
	/**
	 * Where a point on the bow crest's torus is, in world space.
	 *
	 * Shared verbatim by the tube and by the froth masses riding it, so
	 * the two cannot disagree about the surface the masses are on. Takes
	 * the arc parameter (0-1 across the crest) and an angle around the
	 * cross-section; returns the world position, the outward normal, the
	 * taper and the liveness.
	 */
	/**
	 * The preset's clock. timeScale is baked into each wave's omega when
	 * the spectrum is built, so uTime stays real seconds — anything
	 * animating on uTime has to scale itself or it runs at wall-clock
	 * rate while the sea runs at its own.
	 */
	const crestTimeScale = activeField.timeScale ?? 1;

	/**
	 * The tube's NOMINAL cross-section: what it measures at average
	 * wobble, full taper, for this sea. Masses are at their full size
	 * here and saturate above it.
	 *
	 * DERIVED, never written down. As a hand-copied constant it silently
	 * went stale the moment CONTACT.width was tuned — the tube shrank,
	 * the ratio against the stale nominal collapsed, and every mass fell
	 * under FROTH.cullRadius and vanished. Anything that is a function of
	 * other knobs has to be computed from them.
	 */
	const crestRefThick = Math.max(
		CONTACT.width * CONTACT_FOAMINESS * BOWCREST.thickPerWidth,
		0.001
	);

	const bowCrestPlaceGlsl = `
uniform float uTime;
uniform float uAmp;
uniform float uFoaminess;
uniform vec2 uFlowDir;
const vec3 SPHERE_C = vec3(3.0, -6.0, 2.0);
const float SPHERE_R = 5.0;

void bowCrestPlace(
	float arcT, float phi,
	out vec3 pos, out vec3 nrm, out float taper, out float alive, out float thick
) {
	// Centred on the flow's stagnation point — dead ahead of the object.
	float ang = atan(uFlowDir.y, uFlowDir.x) + 3.14159
		+ (arcT - 0.5) * 2.0 * ${f(BOWCREST.arc)};
	vec2 n = vec2(cos(ang), sin(ang));
	// WHERE THE WATER MEETS THE SPHERE, solved in WORLD space — the space
	// the contact collar works in. Placing by a rest position instead
	// misses by the Gerstner sway, metres in a storm.
	//
	// Two nested solves: the outer is a fixed point (the waterline radius
	// depends on the height there, which depends on the radius); the
	// inner inverts the Gerstner map, answering "which material point
	// lands HERE?".
	float ringW = SPHERE_R;
	float collarW = 0.0;
	vec2 rest = SPHERE_C.xz + n * ringW;
	vec2 target = rest;
	vec3 d = vec3(0.0);
	for (int it = 0; it < 3; it++) {
		vec2 anchorXZ = SPHERE_C.xz + n * ringW;
		float wob = foamNoise(anchorXZ * ${f(1 / CONTACT.wobbleScale)}) * 0.6
			+ foamNoise(anchorXZ * ${f(2.7 / CONTACT.wobbleScale)} + 7.0) * 0.4;
		collarW = ${f(CONTACT.width)} * uFoaminess
			* mix(${f(1 - CONTACT.wobble)}, ${f(1 + CONTACT.wobble)}, wob);
		target = SPHERE_C.xz + n * (ringW + collarW * ${f(BOWCREST.standoffFrac)});
		// Damped and clamped: the plain iteration only converges where the
		// displacement gradient is under 1, and that fails at a fold —
		// which is where this crest lives.
		for (int k = 0; k < 4; k++) {
			vec2 want = target - waveDisplacement(rest, uTime, uAmp).xz;
			rest = mix(rest, want, 0.7);
			vec2 off = rest - target;
			float ol = length(off);
			if (ol > ${f(SWAY_BOUND)}) rest = target + off * (${f(SWAY_BOUND)} / ol);
		}
		d = waveDisplacement(rest, uTime, uAmp);
		float dy = d.y - SPHERE_C.y;
		ringW = sqrt(max(SPHERE_R * SPHERE_R - dy * dy, 0.0));
	}
	// As the object goes under, the circle the surface cuts shrinks to
	// nothing — so the ring radius is itself the liveness test.
	alive = smoothstep(0.0, ${f(BOWCREST.minRing)}, ringW);
	float away = abs(arcT - 0.5) * 2.0;
	taper = pow(max(1.0 - away, 0.0), ${f(BOWCREST.taperPower)});
	thick = collarW * ${f(BOWCREST.thickPerWidth)}
		* mix(${f(BOWCREST.taperMin)}, 1.0, taper);
	// rest + displacement lands ON target by construction.
	vec3 surf = vec3(target.x, d.y, target.y);
	vec3 outw = vec3(n.x, 0.0, n.y);
	vec3 up = vec3(0.0, 1.0, 0.0);
	// The tube sits ON the water: centre one radius up, so the bottom of
	// the circle touches the surface at whatever thickness it has.
	vec3 axisC = surf + up * thick + outw * (${f(BOWCREST.lean)} * thick);
	pos = axisC + outw * (cos(phi) * thick) + up * (sin(phi) * thick);
	nrm = normalize(outw * cos(phi) + up * sin(phi));
}`;

	/**
	 * The crest's SHAPE lives entirely in the shader — the geometry is a
	 * bare unit plane whose two axes are reinterpreted. A wireframe view
	 * has to run the same shader; a plain wireframe material would draw
	 * the undeformed plane.
	 */
	const bowCrestVertex = `
varying float vViewZ;
varying vec2 vUvC;
varying vec3 vNrm;
varying float vTaper;
varying float vAlive;
${wavesGlsl()}
${foamNoiseGlsl}
${bowCrestPlaceGlsl}

void main() {
	vUvC = uv;
	vec3 pos;
	float thick;
	bowCrestPlace(uv.x, uv.y * 6.28318, pos, vNrm, vTaper, vAlive, thick);
	vec4 view = viewMatrix * vec4(pos, 1.0);
	vViewZ = -view.z;
	gl_Position = projectionMatrix * view;
}`;

	const bowCrestUniforms = {
			uTime: waterUniforms.uTime,
			uAmp: waterUniforms.uAmp,
			uWaveA: waterUniforms.uWaveA,
			uWaveB: waterUniforms.uWaveB,
			uColor: waterUniforms.uFoamColor,
			uFogColor: waterUniforms.uFogColor,
			uFogDensity: waterUniforms.uFogDensity,
			uFlowDir: { value: new THREE.Vector2(1, 0) },
			uSkyZenith: waterUniforms.uSkyZenith,
			uSkyHorizon: waterUniforms.uSkyHorizon,
			uSunColor: waterUniforms.uSunColor,
			uSunI: waterUniforms.uSunI,
			uSunDir: waterUniforms.uSunDir,
			uSunDiffusion: waterUniforms.uSunDiffusion,
			// Shared with the water so the crest's collar and the painted
			// collar cannot disagree about how foamy the sea is.
			uFoaminess: waterUniforms.uFoaminess
	};

	const bowCrestMaterial = new THREE.ShaderMaterial({
		uniforms: bowCrestUniforms,
		vertexShader: bowCrestVertex,
		fragmentShader: `
precision highp float;
uniform vec3 uColor;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uTime;
varying float vViewZ;
varying vec2 vUvC;
varying vec3 vNrm;
varying float vTaper;
varying float vAlive;
${foamNoiseGlsl}
// whitewaterLightGlsl emits only the FUNCTION; the uniforms it reads are
// a separate export. Omitting them fails the fragment compile, and a
// material with a broken shader draws nothing at all with no error
// unless the console is open — which is how this went invisible.
${WHITEWATER_UNIFORM_DECLS}
${whitewaterLightGlsl()}

void main() {
	// ROLLING is shading, not geometry: froth bands travel around the
	// cross-section. A breaking lip tumbles because its material
	// circulates, and this stands in for that circulation.
	// SOLID white, with NO pattern of any kind: the tube is a plain mass
	// of water. Everything that gives the crest texture and motion is the
	// froth riding it — a tube that patterns itself competes with those
	// masses and reads as painted rather than as water.
	// PARTIAL CULL toward the ends, not a uniform fade: the taper is a
	// threshold against noise, so the tube breaks into patches and thins
	// out unevenly, which is how froth actually runs out.
	float ends = smoothstep(0.0, ${f(BOWCREST.endFade)}, min(vUvC.x, 1.0 - vUvC.x));
	float a = ends * vAlive;
	if (a < 0.02) discard;
	// FLAT, exactly as the froth sprites are lit: any downward normal is
	// flipped back up, then biased toward world up by FROTH.normalTilt —
	// at 0 every part of the tube takes one shade, so it matches the
	// sprites by construction rather than by two settings agreeing.
	vec3 sn = vNrm.y < 0.0 ? -vNrm : vNrm;
	vec3 upN = normalize(mix(vec3(0.0, 1.0, 0.0), sn, ${f(FROTH.normalTilt)}));
	vec3 lit = whitewaterLight(uColor, upN, ${f(1 - FOAM.shapeFloor)});
	${fogGlsl('fog')}
	gl_FragColor = vec4(mix(lit, uFogColor, fog), a);
}`,
		transparent: true,
		depthWrite: false,
		side: THREE.DoubleSide
	});

	/**
	 * ?wire — the crest as a red wireframe, over everything.
	 *
	 * Same vertex shader, so it shows the ACTUAL deformed strip. depthTest
	 * off because the crest rides the waterline and the opaque water hides
	 * it exactly where its shape matters most.
	 */
	const bowCrestWireMaterial = new THREE.ShaderMaterial({
		uniforms: bowCrestUniforms,
		vertexShader: bowCrestVertex,
		fragmentShader: `
precision highp float;
varying float vViewZ;
varying vec2 vUvC;
varying vec3 vNrm;
varying float vTaper;
varying float vAlive;
void main() {
	// Obey the SAME liveness cull as the shaded pass. Without it the wire
	// view drew the tube even where the shaded one discards it entirely,
	// so the two disagreed and the wireframe could not be used to
	// diagnose the shaded pass — it showed a healthy tube while nothing
	// was on screen.
	if (vAlive <= 0.0) discard;
	gl_FragColor = vec4(1.0, 0.15, 0.15, 1.0);
}`,
		wireframe: true,
		depthTest: false,
		depthWrite: false,
		side: THREE.DoubleSide
	});

	const wireView =
		typeof window !== 'undefined' &&
		new URLSearchParams(window.location.search).has('wire');

	/**
	 * FROTH MASSES riding the torus, carrying the toroidal spin.
	 *
	 * The spin has to live here, not on the tube. Crest froth reads as
	 * tumbling because discrete MASSES move; a smooth white tube has no
	 * feature to track, so rotation painted on it can only look like
	 * bands sliding over a static surface. Give the masses an angle
	 * around the cross-section that advances with time and they circulate
	 * the way froth does on a real pinch loop — and they inherit the
	 * tube's own placement, so they cannot drift off it.
	 */
	function buildBowFrothGeometry() {
		const pos: number[] = [];
		const rank: number[] = [];
		for (let i = 0; i < BOWCREST.frothAlong; i++) {
			for (let j = 0; j < BOWCREST.frothAround; j++) {
				const h = Math.abs(Math.sin(i * 37.719 + j * 53.117) * 24634.6345) % 1;
				const h2 = Math.abs(Math.sin(i * 12.989 + j * 78.233) * 43758.545) % 1;
				// x = arc parameter, y = starting angle around the tube,
				// z = this mass's own baked radius. Jittered per mass the
				// way the crest froth's is, so no two are the same size.
				pos.push(
					(i + 0.5) / BOWCREST.frothAlong,
					(j + h) / BOWCREST.frothAround,
					// z is the per-mass JITTER multiplier now, not a radius:
					// the radius itself comes from the torus in the shader.
					1 - BOWCREST.frothRadiusVar + 2 * BOWCREST.frothRadiusVar * h2
				);
				rank.push(Math.abs(Math.sin(i * 91.331 + j * 17.923) * 15731.743) % 1);
			}
		}
		const g = new THREE.BufferGeometry();
		g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
		g.setAttribute('aRank', new THREE.Float32BufferAttribute(rank, 1));
		return g;
	}
	const bowFrothGeometry = buildBowFrothGeometry();

	const bowFrothMaterial = new THREE.ShaderMaterial({
		uniforms: { ...bowCrestUniforms, uPointPx: frothMaterial.uniforms.uPointPx },
		vertexShader: `
attribute float aRank;
uniform float uPointPx;
varying float vViewZ;
varying vec3 vNrm;
varying float vFade;
${wavesGlsl()}
${foamNoiseGlsl}
${bowCrestPlaceGlsl}

void main() {
	// The angle advances with time: this IS the toroidal spin. NEGATIVE,
	// because phi runs outward -> up -> inward, so increasing it drags
	// the top of the roll back toward the hull. A breaking lip throws the
	// other way: over the top and away from the object.
	float phi = (position.y - uTime * ${f(BOWCREST.rollRate * crestTimeScale)}) * 6.28318;
	vec3 pos;
	float taper;
	float alive;
	float thick;
	bowCrestPlace(position.x, phi, pos, vNrm, taper, alive, thick);
	// SIZED BY THE CREST FROTH'S OWN LAW, not proportionally to the tube.
	//
	// Tying the radius to a fraction of the tube made masses scale 1:1
	// with it — always the same share of its diameter, so they read as a
	// lumpy tube rather than as froth sitting on one. A crest mass has an
	// ABSOLUTE base radius that the froth factor then modulates through a
	// saturating ramp and a cap, which is why masses stay small against a
	// big loop. Here the tube's thickness against its nominal plays the
	// froth factor's part, and the rest of the law is FROTH's verbatim.
	float sizeFac = thick / ${f(crestRefThick)};
	// DENSITY RISES AS MASSES SHRINK (FROTH.densMax -> densMin as size
	// goes up): big masses stay sparse so they read individually, small
	// ones pack in so a thinning crest breaks into spray, not gaps.
	float dens = mix(${f(FROTH.densMax)}, ${f(FROTH.densMin)},
		smoothstep(${f(FROTH.densStart)}, ${f(FROTH.densEnd)}, sizeFac));
	float keep = smoothstep(0.0, ${f(FROTH.densSoft)}, dens - aRank);
	float r = ${f(BOWCREST.frothBase)} * position.z
		* min(sizeFac, ${f(FROTH.sizeCap)})
		* smoothstep(${f(FROTH.visStart)}, ${f(FROTH.visFull)}, sizeFac)
		* keep;
	// Below the crest froth's own cull radius it is noise, not a mass.
	if (r < ${f(FROTH.cullRadius)}) r = 0.0;
	// PROUD of the surface, not on it. Sitting exactly on the tube they
	// are the same flat white as the tube, coincident with it and losing
	// the depth test to it half the time — so the circulation was real
	// and completely invisible. Pushed out along the normal they break
	// the tube's silhouette, and it is that broken outline travelling
	// round that reads as rotation, not any shading inside it.
	pos += vNrm * (r * ${f(BOWCREST.frothProud)});
	vFade = alive * step(0.0001, r);
	vec4 view = viewMatrix * vec4(pos, 1.0);
	vViewZ = -view.z;
	// Same cull as the froth masses — see the note there.
	float px = r * 2.0 * uPointPx * vFade;
	if (px < 1.0) {
		gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
		gl_PointSize = 0.0;
		return;
	}
	gl_PointSize = px;
	gl_Position = projectionMatrix * view;
}`,
		fragmentShader: `
precision highp float;
uniform vec3 uColor;
uniform vec3 uFogColor;
uniform float uFogDensity;
varying float vViewZ;
varying vec3 vNrm;
varying float vFade;
${WHITEWATER_UNIFORM_DECLS}
${whitewaterLightGlsl()}

void main() {
	if (vFade <= 0.0) discard;
	float dd = length(gl_PointCoord - 0.5) * 2.0;
	if (dd > 1.0) discard;
	// FLAT, exactly as the crest froth sprites are lit.
	vec3 sn = vNrm.y < 0.0 ? -vNrm : vNrm;
	vec3 upN = normalize(mix(vec3(0.0, 1.0, 0.0), sn, ${f(FROTH.normalTilt)}));
	vec3 lit = whitewaterLight(uColor, upN, ${f(1 - FOAM.shapeFloor)});
	${fogGlsl('fog')}
	gl_FragColor = vec4(mix(lit, uFogColor, fog), 1.0);
}`
	});

	const bowFrothMesh = new THREE.Points(bowFrothGeometry, bowFrothMaterial);
	bowFrothMesh.frustumCulled = false;
	bowFrothMesh.visible = ENABLE.bowCrest;

	const bowCrestMesh = new THREE.Mesh(
		bowCrestGeometry,
		wireView ? bowCrestWireMaterial : bowCrestMaterial
	);
	bowCrestMesh.frustumCulled = false;
	bowCrestMesh.visible = ENABLE.bowCrest;

	// CREST SPRAY: a second pass over the SAME points. Each sprite's
	// quad is enlarged upward and the fragment paints a vertical plume
	// above the bubble — spray lifting off that specific foam mass. The
	// bubble region is discarded here (the opaque pass already drew it),
	// and this pass is transparent with no depth write, so plumes layer
	// over each other without sorting artefacts.

	const crestSprayMaterial = new THREE.ShaderMaterial({
		uniforms: {
			uTime: waterUniforms.uTime,
			uAmp: waterUniforms.uAmp,
			uWaveA: waterUniforms.uWaveA,
			uWaveB: waterUniforms.uWaveB,
			uDomAmp: frothMaterial.uniforms.uDomAmp,
			uWinCenter,
			uPointPx: frothMaterial.uniforms.uPointPx,
			uColor: { value: new THREE.Color('#f2f8ff') },
			uFogColor: waterUniforms.uFogColor,
			uFogDensity: waterUniforms.uFogDensity,
			uSkyZenith: waterUniforms.uSkyZenith,
			uSkyHorizon: waterUniforms.uSkyHorizon,
			uSunColor: waterUniforms.uSunColor,
			uSunI: waterUniforms.uSunI,
			uSunDir: waterUniforms.uSunDir,
			uSunDiffusion: waterUniforms.uSunDiffusion,
			uViewH: { value: 900 },
			// Driver cap on gl_PointSize (often 255 or 1024). The quad must
			// be clamped to it IN THE SHADER: the GPU clamps the rendered
			// size anyway, and if the centre offset is computed from the
			// unclamped size the sprite lands in the wrong place — and
			// jumps as sprites cross the cap.
			uMaxPoint: { value: 1024 },
			uRise: { value: new THREE.Vector2(PLUME.riseBase, PLUME.risePerSpeed) },
			// Wind in SCREEN space (NDC per metre of drift) plus its
			// speed, so plumes shear downwind and tatter in a gale.
			uWindScreen: { value: new THREE.Vector2(0, 0) },
			uWindSpeed: { value: 0 }
		},
		transparent: true,
		depthWrite: false,
		vertexShader: `
uniform float uTime;
uniform float uAmp;
uniform float uPointPx;
uniform float uDomAmp;
uniform vec2 uWinCenter;
uniform float uViewH;
uniform float uMaxPoint;
uniform vec2 uWindScreen;
uniform float uWindSpeed;
${wavesGlsl()}
${ENABLE.objectWave ? objWaveGlsl : ''}
${frothFrameGlsl}
attribute float aRank;
varying float vViewZ;
varying float vFrac;
varying float vSeed;
varying float vBurst;
varying float vShear;
varying float vGale;
varying vec2 vAnchor;
void main() {
	vec3 surf; vec3 Nn; float g;
	// Same world-anchor treatment as the froth masses — see the note there.
	vec2 anchor = position.xz + uWinCenter;
	float baseR = ${f(FROTH.radiusBase)} + ${f(FROTH.radiusVar)}
		* fract(abs(sin(anchor.x * 37.719 + anchor.y * 53.117) * 24634.6345));
	float rank = fract(abs(sin(anchor.x * 91.331 + anchor.y * 17.923) * 15731.743));
	float r = frothFrame(anchor, baseR, rank, surf, Nn, g);
	// BURST at the wave's peak: analytic surface height (normalised by
	// the total amplitude) and its time derivative. Spray fires as the
	// crest tops out and trails off on the way down — a throw, not a
	// steady emission.
	float hSum = 0.0;
	float aSum = 0.0;
	float vY = 0.0;
	vec3 vel = vec3(0.0);
	for (int i = 0; i < WAVE_COUNT; i++) {
		vec4 wa = uWaveA[i];
		vec3 wb = uWaveB[i];
		float th = (position.x * wa.x + position.z * wa.y) * wa.z - wa.w * uTime + wb.z;
		float amp = wb.x * uAmp;
		hSum += amp * sin(th);
		aSum += amp;
		vY -= amp * wa.w * cos(th);
		// Orbital velocity of the water this sprite rides: d/dt of the
		// Gerstner displacement (horizontal qAw sin, vertical -Aw cos).
		float qaw = wb.y * amp * wa.w;
		vel.x += qaw * wa.x * sin(th);
		vel.z += qaw * wa.y * sin(th);
	}
	vel.y = vY;
	float hn = hSum / max(aSum, 0.0001);
	// The throw is the PEAK and the FALL: nothing before the crest tops
	// out, full strength through the descent while the water is still
	// high, tapering as the surface drops away. Rising water is silent.
	float high = smoothstep(${f(PLUME.burstHeightStart)}, ${f(PLUME.burstHeightFull)}, hn);
	float falling = smoothstep(0.0, -0.35, vY / max(aSum, 0.0001) * ${f(PLUME.fallRamp)});
	vBurst = high * mix(${f(PLUME.risingStrength)}, 1.0, falling);
	if (r <= 0.0 || g <= 0.001 || vBurst <= 0.01) {
		gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
		gl_PointSize = 0.0;
		return;
	}
	vec3 world = surf - Nn * (r * 0.8 * g);
	vec4 view = viewMatrix * vec4(world, 1.0);
	vViewZ = -view.z;
	float bubblePx = r * 2.0 * uPointPx * g;
	// Quad = the canvas the reach needs: one bubble plus half the reach
	// above it. Clamped to the driver's point-size ceiling (see uMaxPoint).
	float quadPx = min(bubblePx * ${f(1 + PLUME.reachRadii / 2)}, uMaxPoint);
	// Bubble sits at the BOTTOM of the enlarged quad; shift the centre
	// up by the extra half-height so the bubble stays put on screen.
	vec4 clip = projectionMatrix * view;
	clip.y += (quadPx - bubblePx) * 0.5 * (2.0 / uViewH) * clip.w;
	gl_Position = clip;
	gl_PointSize = quadPx;
	vFrac = bubblePx / quadPx;
	vSeed = fract(sin(position.x * 12.9898 + position.z * 78.233) * 43758.5453);
	vAnchor = position.xz;
	// MOMENTUM, not wind: the plume trails OPPOSITE the sprite's own
	// motion, like spray thrown off a moving mass. Project the sprite's
	// world velocity to screen, negate it, and express the sideways part
	// in the sprite's own quad units.
	vec4 c0 = projectionMatrix * view;
	vec4 c1 = projectionMatrix * viewMatrix * vec4(world + vel, 1.0);
	vec2 velScreen = c1.xy / c1.w - c0.xy / c0.w;
	// Normalised by the BUBBLE, not the quad: lean should scale with the
	// foam mass, not with how much spare canvas its sprite has. Momentum
	// sets the trailing rake; a GUST adds to it (the steady breeze is
	// deliberately absent — only gusts move spray).
	float bubbleNdc = max(bubblePx * (2.0 / uViewH), 0.0001);
	vShear = (-velScreen.x + uWindScreen.x * ${f(PLUME.gustLean)}) / bubbleNdc;
	// Speed drives amplitude and tattering (fast water throws more).
	vGale = length(vel);
}`,
		fragmentShader: plumeFragmentGlsl(undefined, undefined, undefined, fogZBias)
	});
	// Query the driver's point-size ceiling once.
	const maxPointSize = (() => {
		const gl = renderer.getContext();
		const range = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE) as Float32Array;
		return range && range[1] ? range[1] : 255;
	})();
	const sprayWindA = new THREE.Vector3();
	const sprayWindB = new THREE.Vector3();
	const crestSprayMesh = new THREE.Points(frothGeometry, crestSprayMaterial);
	crestSprayMesh.frustumCulled = false;
	crestSprayMesh.renderOrder = 6;
	crestSprayMesh.visible = ENABLE.crestPlumes && !PROFILE.hideSpray;
	frothMesh.visible = ENABLE.froth && !PROFILE.hideFroth;
	sprayMesh.visible = !PROFILE.hideSpray;





	// Mist FLUID (mistfield.ts): Dobryakov-style velocity+dye solver.
	// Rendered as a translucent overlay plane that rides the wave
	// heights, sampling the dye field in world space — the mist drapes
	// over the swells and swirls with real fluid motion.
	const mistField = new MistField();
	// Mist FLUID (mistfield.ts): Dobryakov-style velocity+dye solver,
	// rendered as a translucent plane that rides the wave (and ripple)
	// surface, sampling the dye in world space — the mist drapes over
	// the swells and swirls with real fluid motion.
	const mistGeometry = new THREE.PlaneGeometry(MIST_EXTENT, MIST_EXTENT, 96, 96);
	mistGeometry.rotateX(-Math.PI / 2);
	const mistMaterial = new THREE.ShaderMaterial({
		uniforms: {
			uTime: waterUniforms.uTime,
			uAmp: waterUniforms.uAmp,
			uWaveA: waterUniforms.uWaveA,
			uWaveB: waterUniforms.uWaveB,
			uMistTex: { value: null as THREE.Texture | null },
			uFogColor: waterUniforms.uFogColor,
			uFogDensity: waterUniforms.uFogDensity,
			uColor: { value: new THREE.Color('#e9f3fb') },
			uRippleTex: waterUniforms.uRippleTex,
			uRippleCenter: waterUniforms.uRippleCenter,
			uRippleExtent: waterUniforms.uRippleExtent,
			uRippleGain: waterUniforms.uRippleGain
		},
		transparent: true,
		depthWrite: false,
		// The plane FOLDS with the waves at a pinch, and folded triangles
		// invert winding — front-side culling deleted the mist exactly
		// over the loops (same lesson the water mesh learned).
		side: THREE.DoubleSide,
		vertexShader: `
uniform float uTime;
uniform float uAmp;
${wavesGlsl()}
${ripplesGlsl()}
varying vec2 vWorldXZ;
varying float vViewZ;
void main() {
	vec2 rest = position.xz;
	vec3 d = waveDisplacement(rest, uTime, uAmp);
	vec3 world = vec3(rest.x + d.x, d.y, rest.y + d.z);
	// Ride the RIPPLED surface: buoy ripple crests poked through a
	// waves-only mist plane.
	applyRipples(world, world.xz);
	// Hover just above the surface so the haze reads as ON the water.
	world.y += ${f(MIST.hover)};
	vWorldXZ = world.xz;
	vec4 view = viewMatrix * vec4(world, 1.0);
	vViewZ = -view.z;
	gl_Position = projectionMatrix * view;
}`,
		fragmentShader: `
uniform sampler2D uMistTex;
uniform vec3 uColor;
uniform vec3 uFogColor;
uniform float uFogDensity;
varying vec2 vWorldXZ;
varying float vViewZ;
void main() {
	vec2 uv = vWorldXZ / ${MIST_EXTENT.toFixed(1)} + 0.5;
	float m = texture2D(uMistTex, uv).r;
	// Soft saturation: dense cores go toward solid haze, tails feather.
	// Steep enough that real mist OCCLUDES the surface detail beneath it.
	float a = 1.0 - exp(-m * ${f(MIST.opacityGain)});
	// Dense cores read BRIGHTER, not just more opaque.
	vec3 mistCol = mix(uColor, vec3(1.0), smoothstep(${f(MIST.brightStart)}, ${f(MIST.brightEnd)}, m));
	// Fade at the field's border so the domain edge never shows.
	vec2 e = min(uv, 1.0 - uv);
	a *= smoothstep(0.0, 0.04, min(e.x, e.y));
	${fogGlsl('fog')}
	gl_FragColor = vec4(mix(mistCol, uFogColor, fog * 0.75), a * 0.88);
}`
	});
	const mistMesh = new THREE.Mesh(mistGeometry, mistMaterial);
	mistMesh.frustumCulled = false;
	mistMesh.renderOrder = 4;
	mistMesh.visible = ENABLE.mist;

	// y/vy: vertical state for gravity-limited falling. Buoyancy is instant
	// upward (rising water carries the float), but when a crest drops away
	// faster than gravity can pull, the buoy separates and falls
	// ballistically until the surface catches it again.
	// y/vy: vertical state. tx/tz: tilt (horizontal components of the up
	// vector), wx/wz: tilt velocity, for the bottom-heavy pendulum dynamics.
	// pw: previous waterline, for the surface's rise rate. lt: time of the
	// last directional tip splash (throttle).
	// rest: the tracked rest-space point under this buoy, carried across
	// frames so the surface sampler follows one sheet (sampleSurfaceTracked).
	const buoys = [
		{ x: 4, z: -3, y: 0, vy: 0, tx: 0, tz: 0, wx: 0, wz: 0, pw: 0, lt: -10, wet: false, rest: { u: 4, v: -3 } },
		{ x: -7, z: 5, y: 0, vy: 0, tx: 0, tz: 0, wx: 0, wz: 0, pw: 0, lt: -10, wet: false, rest: { u: -7, v: 5 } },
		{ x: 9, z: 8, y: 0, vy: 0, tx: 0, tz: 0, wx: 0, wz: 0, pw: 0, lt: -10, wet: false, rest: { u: 9, v: 8 } }
	];
	// Scratch for the tracked sample; consumed within each buoy's block.
	const buoySurf = { height: 0, swayX: 0, swayZ: 0, jacobian: 1 };
	let buoyMeshes = $state<(THREE.Mesh | undefined)[]>([]);

	// Disturbance hierarchy: the crest-fall splashdown is THE event; all
	// other interactions sit far below it. Tip splashes are small,
	// one-sided, and throttled; ambient bobbing barely registers.
	const TIP_SPLASH_THRESHOLD = 2.0; // tilt speed (1/s) that counts as digging in
	const TIP_SPLASH_COOLDOWN = 0.3; // seconds between tip splashes per buoy
	const TIP_RIM = 0.38; // meters: splash lands off the rim, not the center

	const BUOY_GRAVITY = 9.8; // m/s^2
	/**
	 * HEAVE MODEL — a spring-damper on submersion, replacing the old
	 * snap-to-waterline. The buoy now has real vertical dynamics: push it
	 * under and it bobs back with overshoot; a wave lifts it with lag; a
	 * splashdown rings. This is the foundation the bobber needs — a strike
	 * is exactly "it dipped when no wave explains it", which only means
	 * something once dipping is dynamics rather than assignment.
	 *
	 * Two numbers parameterise the whole thing, and both are FEEL, not
	 * caps: the natural bob period (mass over waterplane area, in disguise)
	 * and the damping ratio (hull drag). Everything the old caps hacked in
	 * falls out: teleports can't happen because a waterline step is now
	 * just a force, upward acceleration is bounded by the spring, and the
	 * downward pull above equilibrium is clamped at gravity because a hull
	 * out of the water is simply falling.
	 */
	const BUOY_BOB_PERIOD = 1.2; // s — natural heave period of the float
	const BUOY_BOB_ZETA = 0.15; // damping ratio; < 1 so it visibly rings
	const BUOY_W0 = (2 * Math.PI) / BUOY_BOB_PERIOD;
	const BUOY_SPRING = BUOY_W0 * BUOY_W0; // accel per metre of submersion
	const BUOY_DAMP = 2 * BUOY_BOB_ZETA * BUOY_W0;
	/** Submersion past which extra depth adds no more push (hull volume). */
	const BUOY_MAX_SUBMERSION = 0.8;
	/**
	 * Where water contact ends: the depth at which the spring's pull-down
	 * exactly equals gravity. Below it the buoy is airborne — undamped,
	 * falling at g — and the force law is continuous across the boundary.
	 */
	const BUOY_CONTACT_DISP = -BUOY_GRAVITY / BUOY_SPRING;
	/**
	 * Waterline rate above which a frame is treated as a SHEET STEP, m/s.
	 * When a fold ends the sheet the tracked sampler rides, the sampled
	 * waterline steps; the raw (waterline - pw) / dt rate then reads tens
	 * of m/s for one frame, and everything keyed on it — bob agitation,
	 * the splashdown impact — fired a phantom splash out of nowhere. Real
	 * sustained rise never reaches this, so past it the frame is "no
	 * data": riseRate zero, no event triggers.
	 */
	const BUOY_STEP_RATE = 7;

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

	// DEBUG: where the light is, relative to the sphere. A dot sits on
	// the sphere's surface at the sub-light point (the spot the light is
	// directly over), and a thin arc traces that point's path. The SUN
	// and MOON are drawn separately — yellow and pale blue — because
	// they are genuinely different arcs, not two halves of one circle:
	// computeEnv negates the vector at handover, mirroring the night arc
	// through the origin onto the opposite side of the sphere.
	// depthTest off: the sphere sits below the waterline, so the opaque
	// water hides the markers exactly when they matter most.
	const SUN_COLOR = '#ffd83a';
	const MOON_COLOR = '#a8c8ff';
	const markerGeo = new THREE.SphereGeometry(0.28, 12, 10);
	const sunDotMat = new THREE.MeshBasicMaterial({ color: SUN_COLOR, depthTest: false });
	const moonDotMat = new THREE.MeshBasicMaterial({ color: MOON_COLOR, depthTest: false });
	const sunDot = new THREE.Mesh(markerGeo, sunDotMat);
	const moonDot = new THREE.Mesh(markerGeo, moonDotMat);
	sunDot.renderOrder = 12;
	moonDot.renderOrder = 12;

	function pathMat(color: string) {
		return new THREE.LineBasicMaterial({
			color,
			transparent: true,
			opacity: 0.55,
			depthTest: false
		});
	}
	const sunPathMat = pathMat(SUN_COLOR);
	const moonPathMat = pathMat(MOON_COLOR);

	/** Trace the light's path over the phases where `daytime` holds. The
	 * sun rules the half where its altitude is positive; the moon takes
	 * the other half. */
	function lightPathPoints(daytime: boolean) {
		const pts: THREE.Vector3[] = [];
		const R = SPHERE_CR + 0.06;
		const STEPS = 160;
		for (let i = 0; i <= STEPS; i++) {
			const phase = i / STEPS;
			// Same test computeEnv uses to hand over between sun and moon.
			const isDay = Math.sin((phase - 0.25) * Math.PI * 2) > 0;
			if (isDay !== daytime) continue;
			const e = computeEnv(phase);
			pts.push(
				new THREE.Vector3(
					SPHERE_CX + e.lightDir[0] * R,
					SPHERE_CY + e.lightDir[1] * R,
					SPHERE_CZ + e.lightDir[2] * R
				)
			);
		}
		return pts;
	}
	function lightPath(daytime: boolean, mat: THREE.LineBasicMaterial) {
		const line = new THREE.Line(
			new THREE.BufferGeometry().setFromPoints(lightPathPoints(daytime)),
			mat
		);
		line.renderOrder = 11;
		return line;
	}
	const sunPath = lightPath(true, sunPathMat);
	const moonPath = lightPath(false, moonPathMat);

	// The two arcs are the only way to SEE what the path knobs do, so they
	// have to follow them. The knobs are live (nothing bakes them), but the
	// geometry was traced once at build, so it is re-traced whenever any of
	// the four changes — compared as a string rather than watched, since
	// ENV is a plain object no one is subscribed to.
	let pathSig = '';
	function refreshLightPaths() {
		const sig = `${ENV.sunPathAngleDeg},${ENV.sunPathOffsetDeg},${ENV.moonPathAngleDeg},${ENV.moonPathOffsetDeg}`;
		if (sig === pathSig) return;
		pathSig = sig;
		sunPath.geometry.setFromPoints(lightPathPoints(true));
		moonPath.geometry.setFromPoints(lightPathPoints(false));
	}
	refreshLightPaths();
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
	// Debug: ?freeze halts the WAVE clock while leaving render running,
	// so anything still moving is intrinsic to a shader (plume sway,
	// rise) rather than wave-driven. ?freeze=N starts at time N.
	const freezeParam =
		typeof window === 'undefined'
			? null
			: new URLSearchParams(window.location.search).get('freeze');
	const frozen = freezeParam !== null;
	if (frozen) waveTime = Number(freezeParam) || 12;

	// GPU pass profiler (ENABLE.gpuProfile). renderer.info cannot see the
	// offscreen sims — three resets it at the head of every render() — so
	// the only way to price them from inside the page is to serialise with
	// finish() and time the wall clock. That distorts the total, which is
	// why it is behind a flag rather than always on.
	const profGl = ENABLE.gpuProfile ? renderer.getContext() : null;
	let profT = 0;
	function profReset() {
		if (!profGl) return;
		profGl.finish();
		profT = performance.now();
	}
	function lap(key: 'gpuRipple' | 'gpuFft' | 'gpuCaustic' | 'gpuFoam') {
		if (!profGl) return;
		profGl.finish();
		const now = performance.now();
		perf[key] = now - profT;
		profT = now;
	}

	// ---------- The player's boat ----------
	// A Boston-Whaler-ish center console from primitives (a Blender hull
	// will replace the geometry later; the physics won't change). Floats
	// on the same heave spring as the buoys with its own constants (BOAT),
	// drives on the arrow keys, and the camera plus every travelling
	// window follows it.
	const boat = {
		x: -1,
		z: 1,
		/** Radians; direction of travel is (cos, sin) in xz. */
		heading: 3.93,
		speed: 0,
		y: 0,
		vy: 0,
		wet: true,
		tx: 0,
		tz: 0,
		twx: 0,
		twz: 0,
		pw: 0,
		prevSpeed: 0,
		accelSm: 0,
		rest: { u: -1, v: 1 }
	};
	const boatSurf = { height: 0, swayX: 0, swayZ: 0, jacobian: 1 };
	const boatKeys = { fwd: false, back: false, left: false, right: false };
	function boatKey(e: KeyboardEvent, down: boolean) {
		switch (e.key) {
			case 'ArrowUp':
				boatKeys.fwd = down;
				break;
			case 'ArrowDown':
				boatKeys.back = down;
				break;
			case 'ArrowLeft':
				boatKeys.left = down;
				break;
			case 'ArrowRight':
				boatKeys.right = down;
				break;
			default:
				return;
		}
		e.preventDefault();
	}
	const onBoatKeyDown = (e: KeyboardEvent) => boatKey(e, true);
	const onBoatKeyUp = (e: KeyboardEvent) => boatKey(e, false);
	window.addEventListener('keydown', onBoatKeyDown);
	window.addEventListener('keyup', onBoatKeyUp);

	const boatDisposables: { dispose(): void }[] = [];
	function buildBoatMesh(): THREE.Group {
		const g = new THREE.Group();
		const mat = (color: string, opts: Record<string, unknown> = {}) => {
			const m = new THREE.MeshStandardMaterial({ color, roughness: 0.6, ...opts });
			boatDisposables.push(m);
			return m;
		};
		const add = (geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number) => {
			boatDisposables.push(geo);
			const mesh = new THREE.Mesh(geo, m);
			mesh.position.set(x, y, z);
			g.add(mesh);
			return mesh;
		};
		const hullMat = mat('#f2f5f3', { roughness: 0.45 });
		const railMat = mat('#22364e');
		const deckMat = mat('#dfe5e1');
		const consoleMat = mat('#ccd5d9');
		const darkMat = mat('#1a1d20', { roughness: 0.5 });
		const glassMat = mat('#9fb4bd', { roughness: 0.15, transparent: true, opacity: 0.45 });

		// Hull plan: parallel sides aft, a curved taper to a near-point bow.
		// Extruded in Y so the sides are vertical — which a Whaler's nearly
		// are — then dropped so the design waterline is the group's y = 0.
		// Every stacked piece sits at a DISTINCT height with real clearance:
		// the first build reused the full plan for hull, rail and deck with
		// coincident faces (rail top exactly on the hull cap), and the
		// z-fighting shimmered as "flickery texture".
		const plan = (k: number) => {
			const sh = new THREE.Shape();
			sh.moveTo(-2.3 * k, -0.95 * k);
			sh.lineTo(0.5 * k, -0.95 * k);
			sh.quadraticCurveTo(1.75 * k, -0.8 * k, 2.3 * k, 0);
			sh.quadraticCurveTo(1.75 * k, 0.8 * k, 0.5 * k, 0.95 * k);
			sh.lineTo(-2.3 * k, 0.95 * k);
			sh.closePath();
			return sh;
		};
		const hullGeo = new THREE.ExtrudeGeometry(plan(1), { depth: 0.55, bevelEnabled: false });
		hullGeo.rotateX(-Math.PI / 2);
		hullGeo.translate(0, -0.2, 0); // 0.2m draft; cap (= deck) at 0.35
		add(hullGeo, hullMat, 0, 0, 0);
		// Rub rail: a RING (outline minus a hole), proud of the sheer and
		// clear of the cap — no full-plan slab, so no coplanar face.
		const railShape = plan(1.04);
		railShape.holes.push(new THREE.Path(plan(0.93).getPoints(24)));
		const railGeo = new THREE.ExtrudeGeometry(railShape, { depth: 0.08, bevelEnabled: false });
		railGeo.rotateX(-Math.PI / 2);
		railGeo.translate(0, 0.31, 0); // 0.31..0.39, straddling the sheer line
		add(railGeo, railMat, 0, 0, 0);
		// Deck sole: inset and 2cm PROUD of the hull cap.
		const deckGeo = new THREE.ExtrudeGeometry(plan(0.88), { depth: 0.02, bevelEnabled: false });
		deckGeo.rotateX(-Math.PI / 2);
		deckGeo.translate(0, 0.352, 0);
		add(deckGeo, deckMat, 0, 0, 0);
		// Center console + raked windshield + leaning post, standing on the
		// deck sole (0.372).
		add(new THREE.BoxGeometry(0.8, 0.55, 0.75), consoleMat, 0.15, 0.65, 0);
		const shield = add(new THREE.BoxGeometry(0.05, 0.32, 0.66), glassMat, 0.58, 1.05, 0);
		shield.rotation.z = -0.35;
		add(new THREE.BoxGeometry(0.34, 0.14, 0.55), consoleMat, -0.75, 0.81, 0);
		add(new THREE.BoxGeometry(0.28, 0.36, 0.42), consoleMat, -0.75, 0.55, 0);
		// Outboard: cowl over the transom, lower unit into the water.
		add(new THREE.BoxGeometry(0.5, 0.4, 0.36), mat('#2a2f34', { roughness: 0.4 }), -2.52, 0.42, 0);
		add(new THREE.BoxGeometry(0.12, 0.6, 0.14), darkMat, -2.48, -0.05, 0);
		return g;
	}
	const boatMesh = buildBoatMesh();
	// Bake the hull's distance field while the group still sits at the
	// origin (the bake works in group-local space). ~1s once, at load.
	{
		const bake = bakeSdfAtlas(boatMesh, BOAT_SDF.nx, BOAT_SDF.ny, BOAT_SDF.nz, BOAT_SDF.tilesX, 0.25);
		const tex = new THREE.DataTexture(
			bake.data,
			bake.width,
			bake.height,
			THREE.RedFormat,
			THREE.FloatType
		);
		tex.minFilter = THREE.LinearFilter;
		tex.magFilter = THREE.LinearFilter;
		tex.needsUpdate = true;
		boatDisposables.push(tex);
		waterUniforms.uBoatSdf.value = tex;
		waterUniforms.uBoatSdfMin.value.copy(bake.min);
		waterUniforms.uBoatSdfSize.value.copy(bake.size);
	}
	// Everything the boat-image pass renders lives on layer 3.
	boatMesh.traverse((o) => o.layers.enable(3));
	/**
	 * Offscreen render of the boat alone, clipped to below the local
	 * waterline, refreshed every frame. Square is fine: sampling goes
	 * through the camera's own projection, so the texture is just an
	 * anisotropic copy of the screen's NDC space.
	 */
	const boatRT = new THREE.WebGLRenderTarget(1024, 1024, { depthBuffer: true });
	const boatClip = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0);
	const boatClearScratch = new THREE.Color();
	function renderBoatImage() {
		const cam = camera.current;
		if (!cam) return;
		if (sun) sun.layers.enable(3);
		if (ambient) ambient.layers.enable(3);
		// Keep only what is below the water at the boat: a horizontal cut
		// at the local surface height. Locally exact enough — the hull is
		// 4.6m in seas whose slope across it is modest.
		boatClip.constant = boatSurf.height + 0.03;
		renderer.clippingPlanes = [boatClip];
		const mask = cam.layers.mask;
		cam.layers.set(3);
		const prevRT = renderer.getRenderTarget();
		const prevClearColor = renderer.getClearColor(boatClearScratch);
		const prevClearAlpha = renderer.getClearAlpha();
		renderer.setRenderTarget(boatRT);
		renderer.setClearColor(0x000000, 0);
		renderer.clear();
		renderer.render(scene, cam);
		renderer.setRenderTarget(prevRT);
		renderer.setClearColor(prevClearColor, prevClearAlpha);
		cam.layers.mask = mask;
		renderer.clippingPlanes = [];
		waterUniforms.uBoatTex.value = boatRT.texture;
		waterUniforms.uProj.value.copy(cam.projectionMatrix);
	}
	const boatUpV = new THREE.Vector3();
	const boatFwdV = new THREE.Vector3();
	const boatSideV = new THREE.Vector3();
	const boatBasis = new THREE.Matrix4();
	const boatTrimQ = new THREE.Quaternion();
	const ISO_CAM = [34, 30, 34] as const;

	function updateBoat(dt: number) {
		// DRIVE. Quadratic + linear hull drag set the top speed (~5.8 m/s
		// at the defaults); rudder authority grows with way on, and flips
		// when making sternway, like a real helm.
		const throttle = (boatKeys.fwd ? BOAT.thrust : 0) - (boatKeys.back ? BOAT.reverseThrust : 0);
		boat.speed += throttle * dt;
		boat.speed -= (BOAT.dragLinear * boat.speed + BOAT.dragQuad * boat.speed * Math.abs(boat.speed)) * dt;
		const steer = (boatKeys.right ? 1 : 0) - (boatKeys.left ? 1 : 0);
		const authority = BOAT.turnMin + (1 - BOAT.turnMin) * Math.min(Math.abs(boat.speed) / 3, 1);
		boat.heading += steer * BOAT.turnRate * authority * dt * (boat.speed < -0.2 ? -1 : 1);
		boat.x += Math.cos(boat.heading) * boat.speed * dt;
		boat.z += Math.sin(boat.heading) * boat.speed * dt;
		// Surge, low-passed: drives the lean-back-under-power trim.
		const fwdAccel = dt > 0 ? (boat.speed - boat.prevSpeed) / dt : 0;
		boat.prevSpeed = boat.speed;
		boat.accelSm += (fwdAccel - boat.accelSm) * Math.min(dt / 0.3, 1);

		// HEAVE — the buoys' spring with the boat's constants. Freeboard
		// lives in the hull geometry, so equilibrium is the surface itself.
		sampleOceanTracked(boatSurf, boat.rest, boat.x, boat.z, waveTime);
		const wl = boatSurf.height;
		const raw = dt > 0 ? (wl - boat.pw) / dt : 0;
		const rise = Math.abs(raw) > BUOY_STEP_RATE ? 0 : THREE.MathUtils.clamp(raw, -6, 6);
		boat.pw = wl;
		const w0 = (2 * Math.PI) / BOAT.bobPeriod;
		const spring = w0 * w0;
		const damp = 2 * BOAT.bobZeta * w0;
		// Planing lift raises the heave EQUILIBRIUM, so the spring carries
		// the hull up smoothly as it gathers way and settles it on stopping.
		const lift = THREE.MathUtils.clamp(
			BOAT.liftPerSpeed * boat.speed * Math.abs(boat.speed),
			-0.08,
			BOAT.liftMax
		);
		const disp = wl + lift - boat.y;
		const airborne = disp <= -BUOY_GRAVITY / spring;
		let accel = Math.max(spring * Math.min(disp, BOAT.maxSubmersion), -BUOY_GRAVITY);
		if (!airborne) accel -= damp * (boat.vy - rise);
		boat.vy += accel * dt;
		boat.y += boat.vy * dt;
		if (!airborne && !boat.wet) {
			const impact = Math.abs(rise - boat.vy);
			if (impact > DROPLET.impactMinSpeed) {
				const amp = Math.min(
					(impact - DROPLET.impactMinSpeed) / (DROPLET.impactFullSpeed - DROPLET.impactMinSpeed),
					1
				);
				injectRippleOver(boat.x, boat.z, 1.6, 0.1 + amp * 0.3, 0.075);
				if (ENABLE.buoySpray) emitImpactSpray(waveTime, boat.x, boat.z, 0, 0, amp);
			}
		}
		boat.wet = !airborne;

		// TILT toward the water slope, sampled over hull-sized baselines
		// (cold 1-iteration samples on purpose — see the buoy tilt note).
		let tgtX = 0;
		let tgtZ = 0;
		if (!airborne) {
			tgtX =
				(-(sampleOcean(boat.x + 1.6, boat.z, waveTime, 1, 1).height -
					sampleOcean(boat.x - 1.6, boat.z, waveTime, 1, 1).height) /
					3.2) *
				BOAT.tiltGain;
			tgtZ =
				(-(sampleOcean(boat.x, boat.z + 0.9, waveTime, 1, 1).height -
					sampleOcean(boat.x, boat.z - 0.9, waveTime, 1, 1).height) /
					1.8) *
				BOAT.tiltGain;
		}
		const spr = airborne ? 0 : BOAT.righting;
		const tDrag = airborne ? 0.5 : 2 * BOAT.tiltZeta * Math.sqrt(BOAT.righting);
		boat.twx += (spr * (tgtX - boat.tx) - tDrag * boat.twx) * dt;
		boat.twz += (spr * (tgtZ - boat.tz) - tDrag * boat.twz) * dt;
		boat.tx += boat.twx * dt;
		boat.tz += boat.twz * dt;

		// WAKE: a continuous quiet poke at the stern. The wave equation
		// turns the moving disturbance into the trailing V by itself.
		if (!airborne && Math.abs(boat.speed) > 0.6) {
			const amp = BOAT.wakeAmp * Math.min(Math.abs(boat.speed) / 5, 1);
			if (amp > 0.002) {
				injectRipple(
					boat.x + Math.cos(boat.heading) * BOAT.wakeOffset,
					boat.z + Math.sin(boat.heading) * BOAT.wakeOffset,
					0.9,
					amp
				);
			}
		}

		// POSE: orthonormal basis from heading and the tilt normal, plus
		// speed trim (rotating about the side axis lifts the bow).
		boatUpV.set(boat.tx, 1, boat.tz).normalize();
		boatFwdV.set(Math.cos(boat.heading), 0, Math.sin(boat.heading));
		boatFwdV.addScaledVector(boatUpV, -boatFwdV.dot(boatUpV)).normalize();
		boatSideV.crossVectors(boatFwdV, boatUpV);
		boatBasis.makeBasis(boatFwdV, boatUpV, boatSideV);
		boatMesh.quaternion.setFromRotationMatrix(boatBasis);
		const trim = THREE.MathUtils.clamp(
			BOAT.trimPerSpeed * boat.speed + BOAT.trimPerAccel * boat.accelSm,
			-0.08,
			0.2
		);
		boatTrimQ.setFromAxisAngle(boatSideV, trim);
		boatMesh.quaternion.premultiply(boatTrimQ);
		boatMesh.position.set(boat.x, boat.y, boat.z);
		// Feed the water's raytrace now, same as the buoys: Threlte would
		// update the world matrix later in the frame, and the refracted
		// half must not lag the rasterized half.
		boatMesh.updateMatrixWorld();
		waterUniforms.uBoatInv.value.copy(boatMesh.matrixWorld).invert();
		renderBoatImage();

		// CAMERA + TRAVELLING WINDOWS. The camera translates with the boat
		// (direction fixed, so no lookAt needed); each world-window system
		// recenters through its own mechanism.
		const cam = camera.current;
		const off = PROFILE.perspectiveCamera ? perspPos : ISO_CAM;
		if (cam) cam.position.set(off[0] + boat.x, off[1], off[2] + boat.z);
		if (PROFILE.perspectiveCamera) {
			waterUniforms.uCamPos.value.set(perspPos[0] + boat.x, perspPos[1], perspPos[2] + boat.z);
		}
		winCenter.set(Math.round(boat.x * 2) / 2, Math.round(boat.z * 2) / 2);
		if (waterMeshRef) waterMeshRef.position.set(winCenter.x, 0, winCenter.y);
		rippleSim.recenter(boat.x, boat.z);
		waterUniforms.uRippleCenter.value.copy(rippleSim.center);
		backdropUniforms.uRippleCCenter.value.copy(rippleSim.center);
		causticMap.setCenter(boat.x, boat.z, rippleSim.center);
		waterUniforms.uCausticCenter.value.copy(causticMap.center);
		foamField.recenter(boat.x, boat.z);
		waterUniforms.uFoamCenter.value.copy(foamField.center);
		setScanCenter(boat.x, boat.z);
	}

	const task = useTask(
		(delta) => {
			const cpuT0 = performance.now();
			let steps = 0;
			// Accumulated ACROSS steps, so these show the true per-frame cost
			// including the catch-up multiplier rather than one step's worth.
			let tWhitecaps = 0;
			let tSpray = 0;
			let tCurrent = 0;
			let mark = 0;
			accumulator = Math.min(accumulator + delta, 0.25);
			while (accumulator >= STEP) {
				accumulator -= STEP;
				steps++;
				if (!frozen) waveTime += STEP;
				if (!ENV.freezeTime) game.time = (game.time + STEP) % ENV.daySeconds;
				// Whitecap events and ballistic spray advance on the fixed
				// step too (spray after whitecaps: it reads the freshly
				// scanned break events).
				setRippleClock(waveTime);
				mark = performance.now();
				updateWhitecaps(STEP, waveTime);
				tWhitecaps += -mark + (mark = performance.now());
				updateSpray(STEP, waveTime);
				tSpray += -mark + (mark = performance.now());
				advanceCurrent(STEP, waveTime);
				tCurrent += performance.now() - mark;
				contactFoamClock += STEP;
				if (contactFoamClock >= CONTACT_FOAM_INTERVAL) {
					contactFoamClock = 0;
					// depositContactFoam(waveTime);
				}
			}

			const stepEnd = performance.now();
			perf.cpuWhitecaps = tWhitecaps;
			perf.cpuSpray = tSpray;
			perf.cpuCurrent = tCurrent;

			syncSeaState(delta);
			syncFftSpectrum(delta);
			updateBoat(Math.min(delta, 0.1));

			const env = computeEnv(game.time / ENV.daySeconds);

			// Read BEFORE this frame's offscreen sims run: three resets
			// renderer.info at the head of every render() call, including
			// render-target ones, so at the top of the task it still holds
			// the previous frame's MAIN-scene totals. Reading it after the
			// sims would report whichever 128x128 pass happened to run last.
			perf.calls = renderer.info.render.calls;
			perf.tris = renderer.info.render.triangles;
			perf.w = renderer.domElement.width;
			perf.h = renderer.domElement.height;

			crestSprayMaterial.uniforms.uViewH.value =
				renderer.domElement.height || window.innerHeight;
			crestSprayMaterial.uniforms.uMaxPoint.value = maxPointSize;
			waterUniforms.uTime.value = waveTime;

			// Only scan the ground the camera can SEE: the isometric view is
			// a rotated rectangle on the water plane, so the axis-aligned
			// scan square wastes its corners. Recomputed per frame — doing
			// it at geometry-build time ran before the camera's matrices
			// existed, and the garbage quad culled the entire scan.
			updateViewQuad();
			const wind = windVector(waveTime);
			waterUniforms.uWind.value.set(wind.x, wind.z);
			// The collar leans downstream on the same carry the foam field
			// drifts on, so the two agree about which way the water goes.
			// FOAM IGNORES GUSTS. Gusts are violent and short — they would
			// yank the whole field sideways and snap back, which reads as
			// the sea sliding rather than as weather. Foam rides the steady
			// breeze and the current only. (Crest plumes take the opposite
			// deal: gust alone, no base.)
			const windSteady = windBase(waveTime);
			{
				// The crest sits dead ahead of the object in the flow, so it
				// needs the same steady carry the foam rides.
				const cur = currentVector(waveTime);
				const cs = Math.hypot(cur.x, cur.z);
				if (cs > 1e-4) bowCrestMaterial.uniforms.uFlowDir.value.set(cur.x / cs, cur.z / cs);
			}
			waterUniforms.uWindTravel.value.set(windTravel.x, windTravel.z);

			// Mirror the event array into the shader uniforms.
			for (let i = 0; i < MAX_EVENTS; i++) {
				const e = events[i];
				waterUniforms.uEventA.value[i].set(e.x, e.z, e.birth, e.sigma);
				waterUniforms.uEventB.value[i].set(e.cap, e.breakDuration, 0, 0);
			}
			// One wave-equation iteration, then point the water shader at the
			// freshly written side of the ping-pong pair.
			profReset();
			if (!PROFILE.skipRippleSim) rippleSim.step(renderer);
			lap('gpuRipple');
			waterUniforms.uRippleTex.value = rippleSim.texture;
			if (fftDetail && fftFrame++ % FFT.stepEvery === 0) {
				fftDetail.step(renderer, waveTime);
				const [a, b] = fftDetail.textures;
				waterUniforms.uFftA.value = a;
				waterUniforms.uFftB.value = b;
			}
			lap('gpuFft');
			backdropUniforms.uRippleCTex.value = rippleSim.texture;
			if (!PROFILE.skipCausticSim) {
				causticMap.step(renderer, rippleSim.texture, waterUniforms.uSunDir.value, waveTime);
			}
			lap('gpuCaustic');
			backdropUniforms.uCausticMap.value = causticMap.texture;
			// One foam-field update per TWO frames (decay + diffusion +
			// drift + queued deposits), then point the water shader at the
			// fresh side.
			foamAccum += Math.min(delta, 0.1);
			foamEven = !foamEven;
			if (foamEven && !PROFILE.skipFoamSim) {
				foamField.step(renderer, windSteady.x, windSteady.z, waveTime, foamAccum);
				foamAccum = 0;
				waterUniforms.uFoamTex.value = foamField.texture;
				waterUniforms.uFoamFlow.value.set(foamFlow.x, foamFlow.z);
				waterUniforms.uFoamWebTex.value = foamField.webTexture;
			}
			lap('gpuFoam');
			// Wind projected to screen: NDC offset for a 1m downwind drift.
			{
				const wcam = camera.current;
				sprayWindA.set(0, 0, 0).project(wcam);
				sprayWindB.set(wind.x, 0, wind.z).project(wcam);
				const ws = Math.hypot(wind.x, wind.z);
				(crestSprayMaterial.uniforms.uWindScreen.value as THREE.Vector2).set(
					sprayWindB.x - sprayWindA.x,
					sprayWindB.y - sprayWindA.y
				);
				crestSprayMaterial.uniforms.uWindSpeed.value = ws;
			}
			if (ENABLE.mist)
				mistField.step(
				renderer,
				wind.x,
				wind.z,
				waveTime,
				waterUniforms.uAmp.value,
				Math.min(delta, 0.1)
			);
			mistMaterial.uniforms.uMistTex.value = mistField.texture;

			waterUniforms.uSunDir.value.set(env.lightDir[0], env.lightDir[1], env.lightDir[2]);
			// SPECULAR ENVELOPE, from sun altitude. As the sun drops, its
			// specular point slides out of view and the required facet tilt
			// grows past what the core lobe accepts — which is what made the
			// glitter's window so short. Widening the envelope and leaning on
			// the halo follows the reflection out instead of losing it, the
			// same way a real glitter path lengthens toward the horizon.
			{
				const sunAlt = Math.asin(Math.max(Math.min(env.lightDir[1], 1), -1)) * (180 / Math.PI);
				const t = smooth01(sunAlt, SPECULAR.altHigh, SPECULAR.altLow);
				const dif = waterUniforms.uSunDiffusion.value;
				// Sea state first: a calm mirror and a shattered storm want
				// lobes two orders of magnitude apart, so each of these has a
				// storm twin and the preset's chop cross-fades them.
				// Which property of the sea this effect follows — slope by
				// default. seaDrive returns 0 at the calm reference and 1 at
				// the storm one, whatever mix of metrics is weighted in.
				const chopT = Math.pow(
					seaDrive(SPECULAR.driveSlope, SPECULAR.driveAmp, SPECULAR.driveChop),
					SPECULAR.driveCurve
				);
				// GEOMETRIC, not linear. These pairs span up to 40x, and a linear
				// ramp across that spends almost its whole length near the calm
				// end — halfway between 4000 and 100 is 2050, which is still a
				// mirror. Interpolating the ratio puts the midpoint at 632, which
				// is halfway in the sense that matters. Falls back to linear if
				// either end is zero or negative, where a ratio is undefined.
				const mixc = (a: number, b: number) =>
					a > 0 && b > 0 ? a * Math.pow(b / a, chopT) : a + (b - a) * chopT;
				// Staged sharpness spike: rise, hold, fall across four phases.
				// Multiplying the two smoothsteps gives the hold for free —
				// the first is fully in before the second starts backing it out.
				const ph = ((game.time / ENV.daySeconds) % 1 + 1) % 1;
				// The spike windows are positions along the ARC, not times of
				// day: the moon rides the same clock half a turn later
				// (computeEnv gives it theta + PI), so at night the day-phase
				// windows shift by half a day and the moon's glitter snaps at
				// the same point of its pass as the sun's does.
				const sunUp = Math.sin((ph - 0.25) * Math.PI * 2) > 0;
				const bodyPh = sunUp ? ph : (ph + 0.5) % 1;
				const spike =
					smooth01(bodyPh, SPECULAR.spikeInStart, SPECULAR.spikeInEnd) *
					(1 - smooth01(bodyPh, SPECULAR.spikeOutStart, SPECULAR.spikeOutEnd));
				const base = mixc(SPECULAR.sharpClear, SPECULAR.sharpClearStorm);
				const peak = mixc(SPECULAR.sharpPeak, SPECULAR.sharpPeakStorm);
				const clear = base + (peak - base) * spike;
				const sharp =
					clear + (mixc(SPECULAR.sharpOvercast, SPECULAR.sharpOvercastStorm) - clear) * dif;
				waterUniforms.uSpecSharpCore.value = sharp;
				waterUniforms.uSpecSharpWash.value = sharp * SPECULAR.haloSharp;
				waterUniforms.uSpecGain.value =
					SPECULAR.gainClear + (SPECULAR.gainOvercast - SPECULAR.gainClear) * dif;
				waterUniforms.uSpecAniso.value = SPECULAR.anisotropy;
				waterUniforms.uSpecFresnelMix.value = SPECULAR.fresnelMix;
				if (!PROFILE.perspectiveCamera) {
					waterUniforms.uCamPos.value
						.set(34, 30, 34)
						.normalize()
						.multiplyScalar(mixc(SPECULAR.cameraEyeDistance, SPECULAR.cameraEyeDistanceStorm));
					waterUniforms.uCamPos.value.y *= SPECULAR.cameraEyeHeight;
					// The simulated viewpoint is anchored to the LOOK TARGET,
					// which is the boat now, not the origin.
					waterUniforms.uCamPos.value.x += boat.x;
					waterUniforms.uCamPos.value.z += boat.z;
				}
				waterUniforms.uSpecHaloGain.value =
					SPECULAR.haloGain + (SPECULAR.haloGainLow - SPECULAR.haloGain) * t;
				waterUniforms.uSpecFade.value = smooth01(sunAlt, 0, SPECULAR.fadeAltDeg);
			}
			// Sub-light point on the sphere's surface: the sun's dot while
			// the sun is up, the moon's while it is not.
			const isDay = Math.sin((game.time / ENV.daySeconds - 0.25) * Math.PI * 2) > 0;
			const activeDot = isDay ? sunDot : moonDot;
			activeDot.position.set(
				SPHERE_CX + env.lightDir[0] * (SPHERE_CR + 0.06),
				SPHERE_CY + env.lightDir[1] * (SPHERE_CR + 0.06),
				SPHERE_CZ + env.lightDir[2] * (SPHERE_CR + 0.06)
			);
			sunDot.visible = isDay;
			moonDot.visible = !isDay;
			refreshLightPaths();
			// Reflected sky follows the clock: daylight preset colours, sunk
			// toward the fog as night falls. skyScratch carries the fog tone.
			skyScratch.setRGB(env.fog[0], env.fog[1], env.fog[2]);
			waterUniforms.uSkyZenith.value
				.copy(skyZenithBase)
				.lerp(skyScratch, env.night * NIGHT_SKY_TO_FOG);
			waterUniforms.uSkyHorizon.value
				.copy(skyHorizonBase)
				.lerp(skyScratch, env.night * NIGHT_SKY_TO_FOG);
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
				const surface = sampleOceanTracked(buoySurf, b.rest, x, z, waveTime);
				const waterline = surface.height + 0.15;
				// How fast the surface itself is moving vertically, clamped
				// against first-frame garbage.
				const rawRate = buoyDt > 0 ? (waterline - b.pw) / buoyDt : 0;
				if (PROFILE.buoyLog) {
					logDiag({
						k: 'buoy',
						i,
						y: +b.y.toFixed(4),
						wl: +waterline.toFixed(4),
						raw: +rawRate.toFixed(2),
						vy: +b.vy.toFixed(3),
						u: +b.rest.u.toFixed(3),
						v: +b.rest.v.toFixed(3),
						tx: +b.tx.toFixed(3),
						tz: +b.tz.toFixed(3),
						wxz: +Math.hypot(b.wx, b.wz).toFixed(3)
					});
				}
				// Beyond BUOY_STEP_RATE this is a sheet step, not water motion.
				const riseRate =
					Math.abs(rawRate) > BUOY_STEP_RATE ? 0 : THREE.MathUtils.clamp(rawRate, -6, 6);
				b.pw = waterline;

				const px = x + surface.swayX * 0.4;
				const pz = z + surface.swayZ * 0.4;

				// Heave: submersion relative to the equilibrium ride height.
				const disp = waterline - b.y;
				const airborne = disp <= BUOY_CONTACT_DISP;
				// Buoyancy pushes up with submersion (capped once the hull is
				// fully under); the pull-down above equilibrium can never
				// exceed gravity, because a hull out of the water is just a
				// falling object. Damping is against the WATER, not the air,
				// so a wave sweeping up under the buoy drags it along.
				let accel = Math.max(
					BUOY_SPRING * Math.min(disp, BUOY_MAX_SUBMERSION),
					-BUOY_GRAVITY
				);
				if (!airborne) accel -= BUOY_DAMP * (b.vy - riseRate);
				// Semi-implicit Euler: velocity first, then position — the
				// stable order for an oscillator at fixed steps.
				b.vy += accel * buoyDt;
				b.y += b.vy * buoyDt;

				if (!airborne && !b.wet) {
					// Contact begins: splashdown, scaled by the relative
					// speed of buoy and water. The expanding ring, rebound
					// column, and interference all come from the wave
					// equation; the heave spring adds the bob-and-ring.
					const impact = Math.abs(riseRate - b.vy);
					if (impact > DROPLET.impactMinSpeed) {
						const amp = Math.min(
							(impact - DROPLET.impactMinSpeed) /
								(DROPLET.impactFullSpeed - DROPLET.impactMinSpeed),
							1
						);
						// Spread over ~75ms: the ring rises instead of
						// teleporting in — the "sudden awkward ripple".
						injectRippleOver(px, pz, 0.8, 0.12 + amp * 0.35, 0.075);
						if (PROFILE.buoyLog)
							logDiag({ k: 'splash', i, impact: +impact.toFixed(2), amp: +amp.toFixed(3) });
						if (ENABLE.buoySpray) emitImpactSpray(waveTime, px, pz, 0, 0, amp);
					}
				}
				b.wet = !airborne;

				if (!airborne) {
					// The hull pushing through the water is a continuous
					// disturbance, but a QUIET one: quadratic in rise rate
					// so gentle bobbing injects nearly nothing, and capped
					// far below a splashdown.
					const breaking = THREE.MathUtils.clamp((0.4 - surface.jacobian) / 0.8, 0, 1);
					const agitation = Math.min(riseRate * riseRate * 0.005 + breaking * 0.012, 0.035);
					if (agitation > 0.004) {
						injectRipple(px, pz, 0.45, agitation);
						if (PROFILE.buoyLog) logDiag({ k: 'bob', i, amp: +agitation.toFixed(4) });
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
					// Cold 1-iteration samples, deliberately: they barely
					// invert, which makes them a heavy low-pass — smoothly
					// biased near folds, never spiky. A rest-space gradient
					// around the tracked point was tried and measured WORSE
					// (its cold-start fallback jumps the anchor at sheet
					// ends: 14 tilt spikes per 18 buoy-minutes vs 0 here).
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
					injectRippleOver(sideX, sideZ, 0.3, 0.04 + tip * 0.08, 0.1);
					if (PROFILE.buoyLog) logDiag({ k: 'tip', i, tip: +tip.toFixed(3) });
					// The rim digging in flicks water outward on that side.
					if (ENABLE.buoySpray)
						emitImpactSpray(waveTime, sideX, sideZ, b.wx / tipSpeed, b.wz / tipSpeed, tip * 0.5);
				}
			}

			// Mirror the spray pool into the point cloud: birth ease-in and
			// death ease-out on the size, velocity for the streak.
			let liveSpray = 0;
			for (let i = 0; i < MAX_SPRAY; i++) {
				const p = sprayParticles[i];
				if (p.size === 0 || waveTime < p.birth) {
					spraySizes[i] = 0;
					continue;
				}
				liveSpray++;
				const grow = Math.min((waveTime - p.birth) / DROPLET.growTime, 1);
				const shrink =
					p.dying >= 0 ? Math.max(1 - (waveTime - p.dying) / DROPLET.dieTime, 0) : 1;
				spraySizes[i] = p.size * grow * shrink;
				sprayPositions[i * 3] = p.x;
				sprayPositions[i * 3 + 1] = p.y;
				sprayPositions[i * 3 + 2] = p.z;
				sprayVels[i * 3] = p.vx;
				sprayVels[i * 3 + 1] = p.vy;
				sprayVels[i * 3 + 2] = p.vz;
			}
			sprayPosAttr.needsUpdate = true;
			spraySizeAttr.needsUpdate = true;
			sprayVelAttr.needsUpdate = true;

			// CPU time actually spent in here, and how many fixed steps it
			// took. Together with the frame time these split the two cases
			// that look identical from fps: if taskMs is most of the frame
			// the sim is the cost, and if it is a rounding error the frame
			// is going on fragment shading instead.
			//
			// `steps` matters on its own because the catch-up loop is a
			// multiplier: at 50ms frames it runs the whole sim three times
			// per rendered frame, so anything expensive in here is paid
			// three times over.
			perf.taskMs = performance.now() - cpuT0;
			perf.steps = steps;
			perf.foam = foamMass();
			perf.spray = liveSpray;
			perf.cpuRest = performance.now() - stepEnd;
			const cs = sprayCheckStats();
			perf.checkRun = cs.run;
			perf.checkSkip = cs.skipped;
			const sc = sprayCostStats();
			perf.sEmit = sc.emit;
			perf.sScan = sc.scan;
			perf.sTracks = sc.tracks;
			perf.sParticles = sc.particles;
		},
		{ autoStart: false }
	);

	$effect(() => {
		if (active && game.running) task.start();
		else task.stop();
	});

	onDestroy(() => {
		renderer.domElement.removeEventListener('pointerdown', onPointerDown);
		window.removeEventListener('keydown', onBoatKeyDown);
		window.removeEventListener('keyup', onBoatKeyUp);
		for (const d of boatDisposables) d.dispose();
		boatRT.dispose();
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
		frothGeometry.dispose();
		frothMaterial.dispose();
		bowCrestGeometry.dispose();
		bowCrestMaterial.dispose();
		bowCrestWireMaterial.dispose();
		bowFrothGeometry.dispose();
		bowFrothMaterial.dispose();
		crestSprayMaterial.dispose();
		mistGeometry.dispose();
		mistMaterial.dispose();
		mistField.dispose();
		toonGradient.dispose();
		rippleSim.dispose();
		fftDetail?.dispose();
		foamField.dispose();
	});
</script>

{#if PROFILE.perspectiveCamera}
	<T.PerspectiveCamera
		makeDefault
		position={perspPos}
		fov={perspFov}
		near={1}
		far={PROFILE.perspectiveDistance * 3 + 400}
		oncreate={(cam) => cam.lookAt(0, 0, 0)}
	/>
{:else}
	<T.OrthographicCamera
		makeDefault
		position={[34, 30, 34]}
		{zoom}
		near={1}
		far={400}
		oncreate={(cam) => cam.lookAt(0, 0, 0)}
	/>
{/if}

<T.DirectionalLight bind:ref={sun} position={[40, 60, 20]} intensity={env0.lightIntensity * 2} />
<T.AmbientLight bind:ref={ambient} intensity={env0.ambientIntensity * 1.6} />

{#if !PROFILE.hideObjects}
	<T.Mesh geometry={sphereGeometry} material={sphereMaterial} position={[3, -6, 2]} />
{/if}

{#if !PROFILE.hideObjects}
	<T is={sunPath} />
	<T is={moonPath} />
	<T is={sunDot} />
	<T is={moonDot} />
{/if}

<T is={sprayMesh} />

<T is={frothMesh} />
<T is={bowCrestMesh} />
<T is={bowFrothMesh} />

<T is={crestSprayMesh} />

<T is={mistMesh} />
{#if !PROFILE.hideWater}
	<!-- frustumCulled off: the shader samples via modelMatrix so the mesh is
	     a travelling window; its bbox is recentred every frame anyway. -->
	<T.Mesh bind:ref={waterMeshRef} geometry={waterGeometry} material={waterMaterial} frustumCulled={false} />
{/if}
<T is={boatMesh} />

{#each PROFILE.hideObjects ? [] : buoys as buoy, i (i)}
	<T.Mesh
		bind:ref={buoyMeshes[i]}
		position={[buoy.x, 0, buoy.z]}
		geometry={buoyGeometry}
		material={buoyMaterial}
	/>
{/each}
