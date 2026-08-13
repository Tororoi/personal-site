<script lang="ts">
	import { onMount } from 'svelte';
	import * as THREE from 'three';
	import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

	// Standalone inspector for ONE underside spike: the exact geometry
	// Scene.svelte generates per water tri, shown emerged (apex up), at
	// arm's length. Gray outline = the owning water tri; white pyramid =
	// the spike with its 12%-pulled base; wireframe overlay shows facets.
	let container: HTMLDivElement;

	onMount(() => {
		const renderer = new THREE.WebGLRenderer({ antialias: true });
		renderer.setSize(window.innerWidth, window.innerHeight);
		renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
		renderer.setClearColor('#16222c');
		container.appendChild(renderer.domElement);

		const scene = new THREE.Scene();
		const camera = new THREE.PerspectiveCamera(
			40,
			window.innerWidth / window.innerHeight,
			0.01,
			50
		);
		camera.position.set(0.9, 0.7, 0.9);

		// ---- The exact construction from Scene.svelte: smoothed octa ----
		const h2 = 0.5;
		const r = 0.3 + 0.12 * h2;
		const spikeGeometry = new THREE.OctahedronGeometry(r, 1);
		spikeGeometry.translate(0, r + 0.03, 0);
		const cx = 0;
		const cz = 0;
		const len = r * 2;

		const solid = new THREE.Mesh(
			spikeGeometry,
			new THREE.MeshBasicMaterial({ color: '#eef6fc', side: THREE.DoubleSide })
		);
		scene.add(solid);
		const wire = new THREE.Mesh(
			spikeGeometry,
			new THREE.MeshBasicMaterial({ color: '#3a5468', wireframe: true })
		);
		scene.add(wire);


		const grid = new THREE.GridHelper(2, 8, '#24384a', '#1d2e3d');
		scene.add(grid);

		const controls = new OrbitControls(camera, renderer.domElement);
		controls.target.set(cx, len * 0.35, cz);
		controls.autoRotate = true;
		controls.autoRotateSpeed = 1.2;

		let raf = 0;
		const loop = () => {
			controls.update();
			renderer.render(scene, camera);
			raf = requestAnimationFrame(loop);
		};
		loop();

		const onResize = () => {
			camera.aspect = window.innerWidth / window.innerHeight;
			camera.updateProjectionMatrix();
			renderer.setSize(window.innerWidth, window.innerHeight);
		};
		window.addEventListener('resize', onResize);

		return () => {
			cancelAnimationFrame(raf);
			window.removeEventListener('resize', onResize);
			controls.dispose();
			renderer.dispose();
			spikeGeometry.dispose();
		};
	});
</script>

<div bind:this={container} style="position: fixed; inset: 0;"></div>
