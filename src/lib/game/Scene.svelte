<script lang="ts">
	import * as THREE from 'three';
	import { T, useTask, useThrelte } from '@threlte/core';
	import { onDestroy } from 'svelte';
	import { waves, sampleHeight, wavesGlsl } from './waves';
	import {
		events,
		MAX_EVENTS,
		sampleOcean,
		update as updateWhitecaps,
		whitecapsGlsl
	} from './whitecaps';
	import { computeEnv, DAY_SECONDS } from './env';
	import { game } from './state.svelte';

	let { active = true }: { active?: boolean } = $props();

	const { scene } = useThrelte();

	const mobile = window.innerWidth < 720;
	// The ortho camera only ever sees a ~55 x 64m footprint (max corner reach
	// ~42m from center), so the plane hugs that. Quad size (0.64m desktop, 1m
	// mobile) must stay under ~1/3 of the shortest ripple wavelength in the
	// active sea preset or the short waves alias into vertex crawl.
	const WATER_SIZE = 140;
	const WATER_SEGMENTS = mobile ? 140 : 220;
	const zoom = mobile ? 18 : 26;

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
		uChurnAmp: { value: 0.22 }
	};

	const waterMaterial = new THREE.ShaderMaterial({
		uniforms: waterUniforms,
		wireframe: true,
		vertexShader: `
uniform float uTime;
uniform float uAmp;
varying float vViewZ;
varying float vHeight;
varying float vJacobian;
varying float vChurn;

${wavesGlsl()}
${whitecapsGlsl()}

void main() {
	// Sample in world space: when the mesh recenters on the drifting boat,
	// the wave field stays pinned to the world instead of following it.
	vec4 world = modelMatrix * vec4(position, 1.0);
	vec3 p = world.xyz + waveDisplacement(world.xz, uTime, uAmp);
	applyWhitecaps(p, world.xz, uTime);
	vHeight = p.y - world.y;
	vJacobian = waveJacobian(world.xz, uTime, uAmp);
	vChurn = applyChurn(p, world.xz, uTime, vJacobian);
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
	float foam = vChurn;
	col = mix(col, uFoamColor, foam);

	// Distance fade into the page background, doubling as moire control.
	float fog = 1.0 - exp(-uFogDensity * uFogDensity * vViewZ * vViewZ);
	col = mix(col, uFogColor, clamp(fog, 0.0, 1.0));

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

	const buoys = [
		{ x: 4, z: -3 },
		{ x: -7, z: 5 },
		{ x: 9, z: 8 }
	];
	let buoyMeshes = $state<(THREE.Mesh | undefined)[]>([]);

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
				// Whitecap events and spray advance on the fixed step too.
				updateWhitecaps(STEP, waveTime);
			}

			const env = computeEnv(game.time / DAY_SECONDS);

			waterUniforms.uTime.value = waveTime;

			// Mirror the event array into the shader uniforms.
			for (let i = 0; i < MAX_EVENTS; i++) {
				const e = events[i];
				waterUniforms.uEventA.value[i].set(e.x, e.z, e.birth, e.sigma);
				waterUniforms.uEventB.value[i].set(e.cap, e.breakDuration, 0, 0);
			}

			if (sun) {
				sun.position.set(env.lightDir[0] * 80, env.lightDir[1] * 80, env.lightDir[2] * 80);
				sun.color.setRGB(env.light[0], env.light[1], env.light[2], THREE.SRGBColorSpace);
				sun.intensity = env.lightIntensity * 2;
			}
			if (ambient) {
				ambient.color.setRGB(env.ambient[0], env.ambient[1], env.ambient[2], THREE.SRGBColorSpace);
				ambient.intensity = env.ambientIntensity * 1.6;
			}

			for (let i = 0; i < buoys.length; i++) {
				const mesh = buoyMeshes[i];
				if (!mesh) continue;
				const { x, z } = buoys[i];
				// ampScale 1 matches the water's tuning-mode uAmp; both must
				// change together or the floats detach from the surface.
				// sampleOcean includes whitecap crumble: a breaking crest
				// passing under a float drops it with the collapsing water.
				const surface = sampleOcean(x, z, waveTime);
				// Ride the surface, plus a fraction of the Gerstner orbital motion
				// as horizontal sway: anchored floats trace small ellipses.
				mesh.position.set(
					x + surface.swayX * 0.4,
					surface.height + 0.15,
					z + surface.swayZ * 0.4
				);
				mesh.rotation.z =
					(sampleHeight(x + 0.6, z, waveTime) - sampleHeight(x - 0.6, z, waveTime)) * -0.5;
				mesh.rotation.x =
					(sampleHeight(x, z + 0.6, waveTime) - sampleHeight(x, z - 0.6, waveTime)) * 0.5;
			}
		},
		{ autoStart: false }
	);

	$effect(() => {
		if (active && game.running) task.start();
		else task.stop();
	});

	onDestroy(() => {
		waterGeometry.dispose();
		waterMaterial.dispose();
		buoyGeometry.dispose();
		buoyMaterial.dispose();
		toonGradient.dispose();
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

<T.Mesh geometry={waterGeometry} material={waterMaterial} />

{#each buoys as buoy, i (i)}
	<T.Mesh
		bind:ref={buoyMeshes[i]}
		position={[buoy.x, 0, buoy.z]}
		geometry={buoyGeometry}
		material={buoyMaterial}
	/>
{/each}
