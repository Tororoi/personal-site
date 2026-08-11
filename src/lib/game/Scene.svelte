<script lang="ts">
	import * as THREE from 'three';
	import { T, useTask, useThrelte } from '@threlte/core';
	import { onDestroy } from 'svelte';
	import { waves, sampleSurface, sampleHeight, significantAmplitude, wavesGlsl } from './waves';
	import { computeEnv, DAY_SECONDS } from './env';
	import { game } from './state.svelte';

	let { active = true }: { active?: boolean } = $props();

	const { scene } = useThrelte();

	const mobile = window.innerWidth < 720;
	// The ortho camera only ever sees a ~55 x 64m footprint (max corner reach
	// ~42m from center), so the plane hugs that. Quad size (0.64m desktop, 1m
	// mobile) must stay under ~1/3 of the shortest ripple wavelength in
	// DEFAULT_FIELD or the short waves alias into vertex crawl.
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
		uAmpTotal: { value: significantAmplitude },
		// The wave field itself: uploaded from the same array the CPU sampler
		// reads, so the two twins cannot disagree about parameters.
		uWaveA: { value: waves.map((w) => new THREE.Vector4(w.dirX, w.dirZ, w.k, w.omega)) },
		uWaveB: { value: waves.map((w) => new THREE.Vector3(w.amp, w.q, w.phase)) },
		uLineColor: { value: new THREE.Color('#55c4fe') },
		uFogColor: { value: new THREE.Color('#0f131a') },
		uFogDensity: { value: 0.0075 }
	};

	const waterMaterial = new THREE.ShaderMaterial({
		uniforms: waterUniforms,
		wireframe: true,
		vertexShader: `
uniform float uTime;
uniform float uAmp;
varying float vViewZ;
varying float vHeight;

${wavesGlsl()}

void main() {
	// Sample in world space: when the mesh recenters on the drifting boat,
	// the wave field stays pinned to the world instead of following it.
	vec4 world = modelMatrix * vec4(position, 1.0);
	vec3 p = world.xyz + waveDisplacement(world.xz, uTime, uAmp);
	vHeight = p.y - world.y;
	vec4 view = viewMatrix * vec4(p, 1.0);
	vViewZ = -view.z;
	gl_Position = projectionMatrix * view;
}`,
		fragmentShader: `
uniform vec3 uLineColor;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uAmpTotal;
varying float vViewZ;
varying float vHeight;

void main() {
	// Brighter lines on crests, dimmer in troughs: shape reads in stills.
	float hn = clamp(vHeight / uAmpTotal * 0.5 + 0.5, 0.0, 1.0);
	vec3 col = uLineColor * (0.35 + 0.9 * hn);

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
			}

			const env = computeEnv(game.time / DAY_SECONDS);

			waterUniforms.uTime.value = waveTime;

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
				const surface = sampleSurface(x, z, waveTime);
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
