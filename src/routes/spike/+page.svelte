<script lang="ts">
	import { onMount } from 'svelte';
	import * as THREE from 'three';
	import { plumeFragmentGlsl } from '$lib/game/plume';
	import { PLUME } from '$lib/game/tuning';

	// Standalone inspector for ONE crest plume, drawn with the game's
	// exact fragment shader (plume.ts) but with NO lean applied and the
	// envelope under manual control — so rise speed, tattering, width and
	// burst can be judged in isolation, with no wave moving underneath.
	let container: HTMLDivElement;
	let burst = $state(1);
	let lean = $state(0);
	let momentum = $state(4);
	let autoWave = $state(false);
	let paused = $state(false);
	let showBubble = $state(true);
	// True in-game scale: the sprite radius in metres and the game's
	// pixels-per-metre. `zoom` matches Scene.svelte's desktop value.
	let radius = $state(0.9);
	let zoom = $state(26);
	let riseBase = $state(PLUME.riseBase);
	let risePerSpeed = $state(PLUME.risePerSpeed);
	let reachRadii = $state(PLUME.reachRadii);
	// Derived, exactly as in tuning.ts: the quad is the canvas the reach
	// needs, never more.
	const quadFor = (reach: number) => 1 + reach / 2;
	let clipFrac = $state(PLUME.clipFrac);
	let showQuad = $state(true);

	onMount(() => {
		const renderer = new THREE.WebGLRenderer({ antialias: true });
		renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
		renderer.setClearColor('#16222c');
		container.appendChild(renderer.domElement);

		const scene = new THREE.Scene();
		// The plume lives inside a point sprite, so the camera is just a
		// unit quad — no perspective, no orbit.
		const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

		// A QUAD, not a point sprite: gl_PointSize is driver-clamped, so a
		// screen-filling point silently shrinks to ~255px.
		const geometry = new THREE.PlaneGeometry(2, 2);

		const uniformsAspect = new THREE.Vector2(1, 1);
		const uniforms = {
			uTime: { value: 0 },
			uColor: { value: new THREE.Color('#f2f8ff') },
			uFogColor: { value: new THREE.Color('#16222c') },
			uFogDensity: { value: 0 },
			uAspect: { value: uniformsAspect },
			uRise: { value: new THREE.Vector2(PLUME.riseBase, PLUME.risePerSpeed) },
			uBurst: { value: 1 },
			uGale: { value: 4 },
			uShear: { value: 0 },
			uFrac: { value: 1 / (1 + PLUME.reachRadii / 2) },
			uReach: { value: PLUME.reachRadii },
			uClip: { value: PLUME.clipFrac }
		};

		const material = new THREE.ShaderMaterial({
			uniforms,
			transparent: true,
			depthWrite: false,
			vertexShader: `
uniform float uBurst;
uniform float uGale;
uniform float uShear;
uniform float uFrac;
uniform vec2 uAspect;
varying float vViewZ;
varying float vFrac;
varying float vSeed;
varying float vBurst;
varying float vShear;
varying float vGale;
varying vec2 vPC;
varying vec2 vAnchor;
void main() {
	vAnchor = vec2(0.0);
	vViewZ = 0.0;
	vFrac = uFrac;
	vSeed = 0.37;
	vBurst = uBurst;
	vShear = uShear;
	vGale = uGale;
	// Sprite coords with y running DOWN, matching gl_PointCoord.
	vPC = vec2(uv.x, 1.0 - uv.y);
	gl_Position = vec4(position.xy * uAspect, 0.0, 1.0);
}`,
			fragmentShader: plumeFragmentGlsl(
				'vPC',
				'varying vec2 vPC;\nuniform float uReach;\nuniform float uClip;',
				{ reachRadii: 'uReach', clipFrac: 'uClip' }
			)
		});
		const plume = new THREE.Mesh(geometry, material);
		plume.frustumCulled = false;
		scene.add(plume);

		// The foam bubble the plume rises from, drawn inside the same quad
		// (bottom-centred, diameter = quad / quadFor(reach)) so it is exactly
		// where the game's bubble sits under its plume.
		const bubbleMat = new THREE.ShaderMaterial({
			uniforms: {
				uFrac: { value: 1 / (1 + PLUME.reachRadii / 2) },
				uAspect: { value: uniformsAspect },
				uColor: { value: new THREE.Color('#eef6fc') }
			},
			transparent: true,
			vertexShader: `
uniform vec2 uAspect;
varying vec2 vPC;
void main() {
	vPC = vec2(uv.x, 1.0 - uv.y);
	gl_Position = vec4(position.xy * uAspect, 0.0, 1.0);
}`,
			fragmentShader: `
uniform vec3 uColor;
uniform float uFrac;
varying vec2 vPC;
void main() {
	float rr = uFrac * 0.5;
	vec2 bc = vec2(0.5, 1.0 - rr);
	if (length((vPC - bc) / rr) > 1.0) discard;
	gl_FragColor = vec4(uColor, 1.0);
}`
		});
		const bubble = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), bubbleMat);
		bubble.frustumCulled = false;
		bubble.renderOrder = -1;
		scene.add(bubble);

		// The sprite quad's border, so it is obvious when a leaning or
		// widening plume runs out of canvas.
		const borderMat = new THREE.ShaderMaterial({
			uniforms: { uAspect: { value: uniformsAspect } },
			transparent: true,
			vertexShader: `
uniform vec2 uAspect;
void main() { gl_Position = vec4(position.xy * uAspect, 0.0, 1.0); }`,
			fragmentShader: `
void main() { gl_FragColor = vec4(0.42, 0.62, 0.76, 0.65); }`
		});
		const border = new THREE.LineSegments(
			new THREE.EdgesGeometry(new THREE.PlaneGeometry(2, 2)),
			borderMat
		);
		border.frustumCulled = false;
		border.renderOrder = 10;
		scene.add(border);

		function fit() {
			renderer.setSize(window.innerWidth, window.innerHeight);
			// TRUE in-game size: quad px = bubble diameter x quadFor(reach),
			// where the bubble is (2 x radius) metres at `zoom` px/m.
			const quadPx = radius * 2 * zoom * quadFor(reachRadii);
			uniformsAspect.set(quadPx / window.innerWidth, quadPx / window.innerHeight);
			// Nudge right of the control panel so it is never covered.
			plume.position.x = 0.35;
			bubble.position.x = 0.35;
		}
		fit();

		let raf = 0;
		let t = 0;
		let last = performance.now();
		const loop = () => {
			const now = performance.now();
			if (!paused) t += (now - last) / 1000;
			last = now;
			uniforms.uTime.value = t;
			// Live quad/reach: uFrac is the bubble's share of the quad.
			uniforms.uFrac.value = 1 / quadFor(reachRadii);
			uniforms.uReach.value = reachRadii;
			uniforms.uClip.value = clipFrac;
			bubbleMat.uniforms.uFrac.value = 1 / quadFor(reachRadii);
			border.visible = showQuad;
			fit();
			(uniforms.uRise.value as THREE.Vector2).set(riseBase, risePerSpeed);
			// MOMENTUM: what the game derives from the water's orbital
			// motion — speed drives amplitude/rise/tatter, and the plume
			// trails opposite the motion. One slider moves both, the way
			// a real wave does; `lean` remains as a manual override.
			const momLean = -momentum * 0.25;
			if (autoWave) {
				// A wave passing: height and vertical velocity from one
				// cycle, run through the game's peak-and-fall envelope.
				const phase = t * 0.6;
				const hn = Math.sin(phase);
				const vy = Math.cos(phase);
				const high =
					(Math.min(Math.max((hn - PLUME.burstHeightStart) /
						(PLUME.burstHeightFull - PLUME.burstHeightStart), 0), 1));
				const falling = Math.min(Math.max(-vy * PLUME.fallRamp * 0.5 + 0.5, 0), 1);
				uniforms.uBurst.value =
					high * (PLUME.risingStrength + (1 - PLUME.risingStrength) * falling);
				// Orbital speed peaks at the crest, reverses in the trough.
				uniforms.uGale.value = Math.abs(hn) * momentum;
				uniforms.uShear.value = -Math.cos(phase) * momentum * 0.25;
			} else {
				uniforms.uBurst.value = burst;
				// Momentum = the water's orbital speed: it drives the
				// plume's HEIGHT (amplitude) and its PULL (lean). The
				// animation speed is the separate rise sliders.
				uniforms.uGale.value = momentum;
				uniforms.uShear.value = lean + momLean;
			}
			bubble.visible = showBubble;
			renderer.render(scene, camera);
			raf = requestAnimationFrame(loop);
		};
		loop();

		window.addEventListener('resize', fit);
		return () => {
			cancelAnimationFrame(raf);
			window.removeEventListener('resize', fit);
			renderer.dispose();
			geometry.dispose();
			material.dispose();
			bubbleMat.dispose();
			border.geometry.dispose();
			borderMat.dispose();
		};
	});
</script>

<div bind:this={container} style="position: fixed; inset: 0;"></div>

<div class="panel">
	<label>
		burst <b>{burst.toFixed(2)}</b>
		<input type="range" min="0" max="1" step="0.01" bind:value={burst} />
	</label>
	<label>
		lean <b>{lean.toFixed(2)}</b>
		<input type="range" min="-1.5" max="1.5" step="0.01" bind:value={lean} />
	</label>
	<label>
		momentum m/s <b>{momentum.toFixed(1)}</b>
		<input type="range" min="0" max="12" step="0.1" bind:value={momentum} />
	</label>
	<label>
		rise (rows/s) <b>{riseBase.toFixed(2)}</b>
		<input type="range" min="0" max="8" step="0.05" bind:value={riseBase} />
	</label>
	<label>
		rise / speed <b>{risePerSpeed.toFixed(2)}</b>
		<input type="range" min="0" max="4" step="0.02" bind:value={risePerSpeed} />
	</label>
	<label>
		reach (radii) <b>{reachRadii.toFixed(1)}</b> <i>quad {quadFor(reachRadii).toFixed(1)}</i>
		<input type="range" min="0.5" max="12" step="0.1" bind:value={reachRadii} />
	</label>
	<label>
		clip (cut) <b>{clipFrac.toFixed(2)}</b>
		<input type="range" min="0.1" max="1" step="0.01" bind:value={clipFrac} />
	</label>
	<label>
		sprite radius m <b>{radius.toFixed(2)}</b>
		<input type="range" min="0.2" max="1.6" step="0.02" bind:value={radius} />
	</label>
	<label>
		zoom px/m <b>{zoom.toFixed(0)}</b>
		<input type="range" min="10" max="120" step="1" bind:value={zoom} />
	</label>
	<label class="row"><input type="checkbox" bind:checked={autoWave} /> auto wave cycle</label>
	<label class="row"><input type="checkbox" bind:checked={paused} /> pause</label>
	<label class="row"><input type="checkbox" bind:checked={showBubble} /> show bubble</label>
	<label class="row"><input type="checkbox" bind:checked={showQuad} /> show quad border</label>
	<p>
		Rendered at true game scale (zoom 26 px/m). Rise sliders are live;
		other shape constants live in PLUME (tuning.ts) and need a reload.
	</p>
</div>

<style>
	.panel {
		position: fixed;
		top: 1rem;
		left: 1rem;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 0.85rem 1rem;
		border-radius: 0.5rem;
		background: rgba(9, 18, 25, 0.82);
		color: #cfe0ec;
		font: 12px/1.4 ui-monospace, monospace;
		width: 210px;
		max-height: calc(100vh - 2rem);
		overflow-y: auto;
	}
	label {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}
	label.row {
		flex-direction: row;
		align-items: center;
		gap: 0.4rem;
	}
	i {
		float: right;
		font-style: normal;
		color: #62839b;
	}
	b {
		float: right;
		font-weight: 400;
		color: #8fb3ca;
	}
	input[type='range'] {
		width: 100%;
	}
	p {
		margin: 0.25rem 0 0;
		color: #7f9bb0;
	}
</style>
