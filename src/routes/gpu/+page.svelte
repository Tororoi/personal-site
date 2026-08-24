<script lang="ts">
	/**
	 * /gpu — WebGPU spike, phase 0: the COMPILER BAKE-OFF.
	 *
	 * The game's water fragment keeps hitting register/occupancy cliffs
	 * (Milestones 13 and 31): loops behind branches tax every pixel, an
	 * unroll made things WORSE, and none of it is visible to any profiler
	 * this platform offers. The suspicion: ANGLE's GLSL -> Metal
	 * translation compiles these shapes conservatively, and WGSL -> Metal
	 * through Dawn might not. That suspicion is the entire case for a
	 * WebGPU port — so it gets measured BEFORE any game code is ported.
	 *
	 * One synthetic fragment, twin-written in GLSL and WGSL from faithful
	 * copies of the water shader's hot shapes:
	 *   - the fused Gerstner displacement + tangent loop (18 waves)
	 *   - a branchy five-object hit chain with live state (the ~4ms item
	 *     no restructuring could reach)
	 *   - a 28-step SDF march (boatHit's shape, procedural SDF)
	 *   - a static 3x3 tap loop (procedural caustic stand-in)
	 *   - the exp/pow shading chain
	 * Same constants (seeded), same math, same pixel count, DPR ignored.
	 * Every term feeds the output colour so nothing can be DCE'd.
	 *
	 * Run one backend at a time. WebGL reports CPU-paced frame time (the
	 * only clock it has here); WebGPU adds REAL GPU time via timestamp
	 * queries when the device grants the feature — the first honest GPU
	 * number this machine has produced.
	 *
	 * Reading: if WGSL wins big (>30%), the port has a data-backed case;
	 * if it ties, weeks of porting just got saved.
	 *
	 * VERDICT (2026-08-24, AMD Radeon Pro 5300M): A TIE. 0.59 ms/Mpx
	 * WGSL (real GPU timestamps) vs 0.61 GLSL — within 2%. The port is
	 * dead. The spike still paid for itself three times over: it caught
	 * an apparent 12x that was actually (1) two DIFFERENT GPUs (WebGL
	 * defaults to the integrated chip on dual-GPU Macs unless the
	 * context requests high-performance — Threlte's default does, this
	 * page's first version didn't), then (2) a WebGPU pipeline that was
	 * silently INVALID from birth (timestampWrites property names — see
	 * below) reporting spectacular numbers for work it never did. Every
	 * lesson about honest measurement in one page: capture async errors
	 * FIRST-error-wins, pace frames in flight, make elision visibly
	 * impossible (additive 1/N tripwire), and only trust a clock that
	 * cannot resolve without the work having happened.
	 */
	import { onMount } from 'svelte';

	const W = 1600;
	const H = 1200;

	// ---- Seeded synthetic constants, injected into BOTH languages ----
	function mulberry32(seed: number) {
		let a = seed >>> 0;
		return () => {
			a = (a + 0x6d2b79f5) >>> 0;
			let t = a;
			t = Math.imul(t ^ (t >>> 15), t | 1);
			t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
	}
	const NW = 18;
	const rand = mulberry32(1897);
	const waves = Array.from({ length: NW }, (_, i) => {
		const lambda = 4.5 * Math.pow(68 / 4.5, (i + 0.5) / NW);
		const k = (2 * Math.PI) / lambda;
		const ang = rand() * Math.PI * 2;
		return {
			dx: Math.cos(ang),
			dz: Math.sin(ang),
			k,
			om: Math.sqrt(9.81 * k),
			amp: (0.06 * lambda) / (2 * Math.PI) * (0.75 + rand() * 0.5),
			q: 0.6 / NW / ((0.06 * lambda) / (2 * Math.PI) * k) * (0.75 + rand() * 0.5),
			ph: rand() * Math.PI * 2
		};
	});
	const fmt = (x: number) => {
		const s = x.toFixed(6);
		return s.includes('.') ? s : s + '.0';
	};
	const glslWaves = waves
		.map(
			(w) =>
				`vec4(${fmt(w.dx)}, ${fmt(w.dz)}, ${fmt(w.k)}, ${fmt(w.om)}), vec3(${fmt(w.amp)}, ${fmt(w.q)}, ${fmt(w.ph)})`
		)
		.map((pair, i) => `WA[${i}] = ${pair.split('), ')[0]}); WB[${i}] = ${pair.split('), ')[1]};`)
		.join('\n\t');
	const wgslWaves = waves
		.map(
			(w, i) =>
				`WA[${i}] = vec4f(${fmt(w.dx)}, ${fmt(w.dz)}, ${fmt(w.k)}, ${fmt(w.om)}); WB[${i}] = vec3f(${fmt(w.amp)}, ${fmt(w.q)}, ${fmt(w.ph)});`
		)
		.join('\n\t');

	// ---- The synthetic body, twice. KEEP THESE TWINS. ----
	const glslFrag = `#version 300 es
precision highp float;
uniform float uTime;
uniform vec2 uRes;
uniform sampler2D uTex;
out vec4 outColor;

vec4 WA[${NW}];
vec3 WB[${NW}];

float sdBlob(vec3 p) {
	// Two fetches per evaluation — boatSdfAt's atlas shape.
	float tex = textureLod(uTex, p.xz * 0.021, 0.0).r
		+ textureLod(uTex, p.xy * 0.017, 0.0).g;
	return length(p - vec3(3.0, -6.0, 2.0)) - 4.0
		+ 0.25 * sin(p.x * 3.0) * sin(p.z * 3.0) * sin(p.y * 3.0)
		+ (tex - 1.0) * 0.25;
}
float causticStandin(vec2 p) {
	float c = sin(p.x * 7.1) * cos(p.y * 6.3) + sin((p.x + p.y) * 3.7);
	return pow(clamp(c, 0.0, 1.0), 3.0)
		* (0.6 + 0.8 * textureLod(uTex, p * 0.06, 0.0).b);
}
void main() {
	${'INIT'/* placeholder replaced below */}
	vec2 frag = gl_FragCoord.xy / uRes;
	vec2 xz = (frag - 0.5) * 120.0;
	float t = uTime;

	// 1. Fused displacement + tangent loop (causticLand's shape).
	vec3 d = vec3(0.0);
	float txx = 0.0; float txy = 0.0; float txz = 0.0; float tzy = 0.0; float tzz = 0.0;
	for (int i = 0; i < ${NW}; i++) {
		vec4 a = WA[i];
		vec3 b = WB[i];
		float theta = (xz.x * a.x + xz.y * a.y) * a.z - a.w * t + b.z;
		float sn = sin(theta);
		float cs = cos(theta);
		float qak = b.y * b.x * a.z;
		float ak = b.x * a.z;
		d.x += b.y * b.x * a.x * cs;
		d.z += b.y * b.x * a.y * cs;
		d.y += b.x * sn;
		txx -= qak * a.x * a.x * sn;
		txy += ak * a.x * cs;
		txz -= qak * a.x * a.y * sn;
		tzy += ak * a.y * cs;
		tzz -= qak * a.y * a.y * sn;
	}
	vec3 P = vec3(xz.x + d.x, d.y, xz.y + d.z);
	vec3 Na = cross(vec3(txz, tzy, 1.0 + tzz), vec3(1.0 + txx, txy, txz));
	vec3 normal = normalize(vec3(-Na.x, 1.0, -Na.z) / max(Na.y, 0.2));
	vec3 refr = refract(vec3(0.24, -0.94, 0.24), normal, 0.7519);
	if (refr.y > -0.05) refr = vec3(0.0, -1.0, 0.0);

	// 2. Branchy hit chain with live state (five objects).
	float tHit = -1.0;
	vec3 hitN = vec3(0.0, 1.0, 0.0);
	vec3 albedo = vec3(0.75, 0.78, 0.72);
	float recvCh = 1.0;
	{
		vec3 oc = P - vec3(3.0, -6.0, 2.0);
		float b2 = dot(oc, refr);
		float c2 = dot(oc, oc) - 25.0;
		float disc = b2 * b2 - c2;
		if (disc > 0.0) {
			float th = -b2 - sqrt(disc);
			if (th > 0.0) { tHit = th; hitN = normalize(oc + refr * th); recvCh = 3.0; }
		}
	}
	for (int bi = 0; bi < 3; bi++) {
		vec3 bc = vec3(-8.0 + float(bi) * 7.0, -0.2, -6.0 + float(bi) * 5.0);
		vec3 o = P - bc;
		vec3 invD = 1.0 / refr;
		vec3 t0 = (vec3(-0.25, -0.45, -0.25) - o) * invD;
		vec3 t1 = (vec3(0.25, 0.45, 0.25) - o) * invD;
		vec3 tmin3 = min(t0, t1);
		vec3 tmax3 = max(t0, t1);
		float tN = max(max(tmin3.x, tmin3.y), tmin3.z);
		float tF = min(min(tmax3.x, tmax3.y), tmax3.z);
		if (tN <= tF && tN > 0.0 && (tHit < 0.0 || tN < tHit)) {
			tHit = tN;
			hitN = -sign(refr) * step(vec3(tN), tmin3);
			albedo = vec3(0.85, 0.37, 0.26);
			recvCh = 1.0;
		}
	}
	{
		vec3 o = (P - vec3(-8.0, -4.0, 2.0)) / vec3(6.0, 1.6, 2.2);
		vec3 dw = refr / vec3(6.0, 1.6, 2.2);
		float aw = dot(dw, dw);
		float bw = dot(o, dw);
		float cw = dot(o, o) - 1.0;
		float dscw = bw * bw - aw * cw;
		if (dscw > 0.0) {
			float tw = (-bw - sqrt(dscw)) / aw;
			if (tw > 0.0 && (tHit < 0.0 || tw < tHit)) {
				tHit = tw;
				hitN = normalize((o + dw * tw) / vec3(6.0, 1.6, 2.2));
				albedo = vec3(0.34, 0.4, 0.47);
				recvCh = 5.0;
			}
		}
	}

	// 3. 28-step SDF march (boatHit's shape, procedural SDF).
	float tm = 0.0;
	float marched = -1.0;
	for (int i = 0; i < 28; i++) {
		vec3 q = P + refr * tm;
		float dist = sdBlob(q);
		if (dist < 0.02) { marched = tm; break; }
		tm += max(dist * 0.9, 0.012);
		if (tm > 30.0) break;
	}
	if (marched > 0.0 && (tHit < 0.0 || marched < tHit)) {
		tHit = marched;
		albedo = vec3(0.5, 0.55, 0.6);
		recvCh = 2.0;
	}
	float depth = tHit > 0.0 ? tHit : 12.0;

	// 4. Static 3x3 tap loop (caustic stand-in).
	float acc0 = 0.0;
	for (int i = 0; i < 3; i++) {
		for (int j = 0; j < 3; j++) {
			vec2 Pi = P.xz + refr.xz * depth
				+ vec2(float(i) - 1.0, float(j) - 1.0) * 0.13;
			acc0 += causticStandin(Pi + vec2(t * 0.31, -t * 0.17));
		}
	}
	float caustic = max(1.0 + (acc0 / 9.0 - 1.0) * 1.6, 0.0);

	// 5. exp/pow shading chain (transmit + volume + contrast + return path).
	vec3 sigma = vec3(0.31, 0.146, 0.096);
	vec3 depthLight = exp(-depth * sigma);
	vec3 vol = (vec3(1.0) - depthLight) * vec3(0.06, 0.13, 0.18);
	float inc = clamp((dot(hitN, -refr) + 0.4) / 1.4, 0.0, 1.0);
	vec3 col = albedo * (depthLight * (vec3(0.22) + vec3(0.9) * inc * min(caustic, 1.0)) + vol);
	col += vec3(1.0, 0.98, 0.9) * max(caustic - 1.0, 0.0) * 0.35 * inc * depthLight;
	vec3 back = exp(-depth * sigma * 0.6);
	col = col * back + vec3(0.05, 0.11, 0.16) * (vec3(1.0) - back);
	col = pow(col, vec3(0.4545)) + 0.0001 * recvCh + 0.0001 * P.y;
	outColor = vec4(col, 1.0);
}`;

	const wgslFrag = `
struct U { time: f32, resx: f32, resy: f32, weight: f32 };
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var tex: texture_2d<f32>;
@group(0) @binding(2) var smp: sampler;

fn sdBlob(p: vec3f) -> f32 {
	// Two fetches per evaluation — boatSdfAt's atlas shape.
	let t = textureSampleLevel(tex, smp, p.xz * 0.021, 0.0).r
		+ textureSampleLevel(tex, smp, p.xy * 0.017, 0.0).g;
	return length(p - vec3f(3.0, -6.0, 2.0)) - 4.0
		+ 0.25 * sin(p.x * 3.0) * sin(p.z * 3.0) * sin(p.y * 3.0)
		+ (t - 1.0) * 0.25;
}
fn causticStandin(p: vec2f) -> f32 {
	let c = sin(p.x * 7.1) * cos(p.y * 6.3) + sin((p.x + p.y) * 3.7);
	return pow(clamp(c, 0.0, 1.0), 3.0)
		* (0.6 + 0.8 * textureSampleLevel(tex, smp, p * 0.06, 0.0).b);
}
@fragment
fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
	var WA: array<vec4f, ${NW}>;
	var WB: array<vec3f, ${NW}>;
	${'INIT'}
	let frag = pos.xy / vec2f(u.resx, u.resy);
	let xz = (frag - 0.5) * 120.0;
	let t = u.time;

	// 1. Fused displacement + tangent loop.
	var d = vec3f(0.0);
	var txx = 0.0; var txy = 0.0; var txz = 0.0; var tzy = 0.0; var tzz = 0.0;
	for (var i = 0; i < ${NW}; i++) {
		let a = WA[i];
		let b = WB[i];
		let theta = (xz.x * a.x + xz.y * a.y) * a.z - a.w * t + b.z;
		let sn = sin(theta);
		let cs = cos(theta);
		let qak = b.y * b.x * a.z;
		let ak = b.x * a.z;
		d.x += b.y * b.x * a.x * cs;
		d.z += b.y * b.x * a.y * cs;
		d.y += b.x * sn;
		txx -= qak * a.x * a.x * sn;
		txy += ak * a.x * cs;
		txz -= qak * a.x * a.y * sn;
		tzy += ak * a.y * cs;
		tzz -= qak * a.y * a.y * sn;
	}
	let P = vec3f(xz.x + d.x, d.y, xz.y + d.z);
	let Na = cross(vec3f(txz, tzy, 1.0 + tzz), vec3f(1.0 + txx, txy, txz));
	let normal = normalize(vec3f(-Na.x, 1.0, -Na.z) / max(Na.y, 0.2));
	var refr = refract(vec3f(0.24, -0.94, 0.24), normal, 0.7519);
	if (refr.y > -0.05) { refr = vec3f(0.0, -1.0, 0.0); }

	// 2. Branchy hit chain with live state.
	var tHit = -1.0;
	var hitN = vec3f(0.0, 1.0, 0.0);
	var albedo = vec3f(0.75, 0.78, 0.72);
	var recvCh = 1.0;
	{
		let oc = P - vec3f(3.0, -6.0, 2.0);
		let b2 = dot(oc, refr);
		let c2 = dot(oc, oc) - 25.0;
		let disc = b2 * b2 - c2;
		if (disc > 0.0) {
			let th = -b2 - sqrt(disc);
			if (th > 0.0) { tHit = th; hitN = normalize(oc + refr * th); recvCh = 3.0; }
		}
	}
	for (var bi = 0; bi < 3; bi++) {
		let bc = vec3f(-8.0 + f32(bi) * 7.0, -0.2, -6.0 + f32(bi) * 5.0);
		let o = P - bc;
		let invD = 1.0 / refr;
		let t0 = (vec3f(-0.25, -0.45, -0.25) - o) * invD;
		let t1 = (vec3f(0.25, 0.45, 0.25) - o) * invD;
		let tmin3 = min(t0, t1);
		let tmax3 = max(t0, t1);
		let tN = max(max(tmin3.x, tmin3.y), tmin3.z);
		let tF = min(min(tmax3.x, tmax3.y), tmax3.z);
		if (tN <= tF && tN > 0.0 && (tHit < 0.0 || tN < tHit)) {
			tHit = tN;
			hitN = -sign(refr) * step(vec3f(tN), tmin3);
			albedo = vec3f(0.85, 0.37, 0.26);
			recvCh = 1.0;
		}
	}
	{
		let o = (P - vec3f(-8.0, -4.0, 2.0)) / vec3f(6.0, 1.6, 2.2);
		let dw = refr / vec3f(6.0, 1.6, 2.2);
		let aw = dot(dw, dw);
		let bw = dot(o, dw);
		let cw = dot(o, o) - 1.0;
		let dscw = bw * bw - aw * cw;
		if (dscw > 0.0) {
			let tw = (-bw - sqrt(dscw)) / aw;
			if (tw > 0.0 && (tHit < 0.0 || tw < tHit)) {
				tHit = tw;
				hitN = normalize((o + dw * tw) / vec3f(6.0, 1.6, 2.2));
				albedo = vec3f(0.34, 0.4, 0.47);
				recvCh = 5.0;
			}
		}
	}

	// 3. 28-step SDF march.
	var tm = 0.0;
	var marched = -1.0;
	for (var i = 0; i < 28; i++) {
		let q = P + refr * tm;
		let dist = sdBlob(q);
		if (dist < 0.02) { marched = tm; break; }
		tm += max(dist * 0.9, 0.012);
		if (tm > 30.0) { break; }
	}
	if (marched > 0.0 && (tHit < 0.0 || marched < tHit)) {
		tHit = marched;
		albedo = vec3f(0.5, 0.55, 0.6);
		recvCh = 2.0;
	}
	var depth = 12.0;
	if (tHit > 0.0) { depth = tHit; }

	// 4. Static 3x3 tap loop.
	var acc0 = 0.0;
	for (var i = 0; i < 3; i++) {
		for (var j = 0; j < 3; j++) {
			let Pi = P.xz + refr.xz * depth
				+ vec2f(f32(i) - 1.0, f32(j) - 1.0) * 0.13;
			acc0 += causticStandin(Pi + vec2f(t * 0.31, -t * 0.17));
		}
	}
	let caustic = max(1.0 + (acc0 / 9.0 - 1.0) * 1.6, 0.0);

	// 5. exp/pow shading chain.
	let sigma = vec3f(0.31, 0.146, 0.096);
	let depthLight = exp(-depth * sigma);
	let vol = (vec3f(1.0) - depthLight) * vec3f(0.06, 0.13, 0.18);
	let inc = clamp((dot(hitN, -refr) + 0.4) / 1.4, 0.0, 1.0);
	var col = albedo * (depthLight * (vec3f(0.22) + vec3f(0.9) * inc * min(caustic, 1.0)) + vol);
	col += vec3f(1.0, 0.98, 0.9) * max(caustic - 1.0, 0.0) * 0.35 * inc * depthLight;
	let back = exp(-depth * sigma * 0.6);
	col = col * back + vec3f(0.05, 0.11, 0.16) * (vec3f(1.0) - back);
	col = pow(col, vec3f(0.4545)) + 0.0001 * recvCh + 0.0001 * P.y;
	// ELISION TRIPWIRE: additive pipeline, each pass contributes 1/N.
	// All passes executed -> full brightness; skipped passes -> visibly
	// dark canvas. A driver cannot fake the sum without doing the work.
	return vec4f(col * u.weight, 1.0);
}`;

	// Fullscreen passes per frame. 16.67ms is vsync: BOTH backends idle
	// there and every number is fiction — raise passes until both sit
	// well past 20ms, then compare ms/Mpx.
	let passes = $state(6);
	// Shared noise texture bytes (seeded): the real fragment does dozens
	// of fetches per pixel (SDF atlas march, tap loops), and fetch
	// latency hiding is where occupancy differences actually bite — an
	// ALU-only synthetic under-tests exactly the thing being measured.
	const TEXN = 512;
	const texBytes = (() => {
		const r = mulberry32(4242);
		const b = new Uint8Array(TEXN * TEXN * 4);
		for (let i = 0; i < b.length; i++) b[i] = Math.floor(r() * 256);
		return b;
	})();

	let glCanvas: HTMLCanvasElement;
	let gpuCanvas: HTMLCanvasElement;
	let running = $state<'none' | 'webgl' | 'webgpu'>('none');
	let glMs = $state(0);
	let gpuMs = $state(0);
	let gpuGpuMs = $state(-1); // real GPU time via timestamp query; -1 = unavailable
	let gpuDoneMs = $state(-1); // submit -> queue.onSubmittedWorkDone latency
	let glGpu = $state('—');
	let gpuGpu = $state('—');
	let status = $state('idle');
	let stopFn: (() => void) | null = null;

	function stop() {
		if (stopFn) stopFn();
		stopFn = null;
		running = 'none';
	}

	function runWebGL() {
		stop();
		running = 'webgl';
		status = 'webgl running';
		const gl = glCanvas.getContext('webgl2', {
			antialias: false,
			alpha: false,
			powerPreference: 'high-performance'
		})!;
		// Name the GPU this context actually landed on — on dual-GPU Macs
		// the two APIs can silently run on DIFFERENT chips (they did:
		// WebGL on the Intel iGPU, WebGPU on the Radeon — a fake 10x).
		{
			const dbg = gl.getExtension('WEBGL_debug_renderer_info');
			glGpu = dbg
				? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL))
				: String(gl.getParameter(gl.RENDERER));
		}
		const vs = `#version 300 es
void main() {
	vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
	gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;
		const frag = glslFrag.replace("${'INIT'}", '').replace('INIT', glslWaves);
		const mk = (type: number, src: string) => {
			const sh = gl.createShader(type)!;
			gl.shaderSource(sh, src);
			gl.compileShader(sh);
			if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
				status = 'GLSL compile error: ' + gl.getShaderInfoLog(sh);
				throw new Error(status);
			}
			return sh;
		};
		const prog = gl.createProgram()!;
		gl.attachShader(prog, mk(gl.VERTEX_SHADER, vs));
		gl.attachShader(prog, mk(gl.FRAGMENT_SHADER, frag));
		gl.linkProgram(prog);
		if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
			status = 'GLSL link error: ' + gl.getProgramInfoLog(prog);
			throw new Error(status);
		}
		gl.useProgram(prog);
		const uTime = gl.getUniformLocation(prog, 'uTime');
		const uRes = gl.getUniformLocation(prog, 'uRes');
		gl.uniform2f(uRes, W, H);
		const tex = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, tex);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, TEXN, TEXN, 0, gl.RGBA, gl.UNSIGNED_BYTE, texBytes);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
		gl.uniform1i(gl.getUniformLocation(prog, 'uTex'), 0);
		gl.viewport(0, 0, W, H);
		const samples: number[] = [];
		let last = performance.now();
		let raf = 0;
		const loop = () => {
			raf = requestAnimationFrame(loop);
			const now = performance.now();
			samples.push(now - last);
			last = now;
			if (samples.length > 90) samples.shift();
			// Drop the warmup, average the rest.
			if (samples.length > 30) {
				const s = samples.slice(10);
				glMs = s.reduce((a, b) => a + b, 0) / s.length;
			}
			for (let p = 0; p < passes; p++) {
				gl.uniform1f(uTime, now / 1000 + p * 0.05);
				gl.drawArrays(gl.TRIANGLES, 0, 3);
			}
			gl.flush();
		};
		raf = requestAnimationFrame(loop);
		stopFn = () => cancelAnimationFrame(raf);
	}

	async function runWebGPU() {
		stop();
		running = 'webgpu';
		status = 'webgpu starting…';
		const nav = navigator as unknown as { gpu?: any };
		if (!nav.gpu) {
			status = 'WebGPU unavailable in this browser';
			running = 'none';
			return;
		}
		const adapter = await nav.gpu.requestAdapter({ powerPreference: 'high-performance' });
		if (!adapter) {
			status = 'no WebGPU adapter';
			running = 'none';
			return;
		}
		try {
			const info = adapter.info ?? (await adapter.requestAdapterInfo?.());
			gpuGpu = info ? [info.vendor, info.architecture, info.device, info.description].filter(Boolean).join(' · ') : 'unknown';
		} catch {
			gpuGpu = 'unknown';
		}
		const wantTs = adapter.features.has('timestamp-query');
		const device = await adapter.requestDevice({
			requiredFeatures: wantTs ? ['timestamp-query'] : []
		});
		// WebGPU errors are ASYNC and silent: a validation failure turns
		// every draw into a no-op with a black canvas and a fast queue —
		// which looks exactly like "suspiciously good performance".
		let firstErr = false;
		device.addEventListener('uncapturederror', (e: any) => {
			// FIRST error wins: later ones are cascade symptoms ("invalid
			// due to a previous error") that bury the root cause.
			if (firstErr) return;
			firstErr = true;
			status = 'WebGPU error: ' + (e.error?.message ?? String(e.error));
		});
		const ctx = gpuCanvas.getContext('webgpu') as any;
		const format = nav.gpu.getPreferredCanvasFormat();
		ctx.configure({ device, format, alphaMode: 'opaque' });
		const code =
			`
@vertex
fn vsMain(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
	let p = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
	return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}
` + wgslFrag.replace("${'INIT'}", '').replace('INIT', wgslWaves);
		const module = device.createShaderModule({ code });
		const info = await module.getCompilationInfo();
		const errs = info.messages.filter((m: any) => m.type === 'error');
		if (errs.length) {
			status = 'WGSL error: ' + errs[0].message + ' @' + errs[0].lineNum;
			running = 'none';
			return;
		}
		device.pushErrorScope('validation');
		const pipeline = device.createRenderPipeline({
			layout: 'auto',
			vertex: { module, entryPoint: 'vsMain' },
			fragment: {
				module,
				entryPoint: 'fs',
				targets: [
					{
						format,
						blend: {
							color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
							alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' }
						}
					}
				]
			},
			primitive: { topology: 'triangle-list' }
		});
		const perr = await device.popErrorScope();
		if (perr) {
			status = 'pipeline error: ' + perr.message;
			running = 'none';
			return;
		}
		// ONE UNIFORM BUFFER PER PASS, times offset like the WebGL side —
		// identical passes were both un-WebGL-like and, in principle,
		// dedupable by a clever driver.
		const MAXP = 24;
		const ubufs = Array.from({ length: MAXP }, () =>
			device.createBuffer({ size: 16, usage: 0x40 | 0x8 /* UNIFORM|COPY_DST */ })
		);
		const gtex = device.createTexture({
			size: [TEXN, TEXN],
			format: 'rgba8unorm',
			usage: 0x4 | 0x2 /* TEXTURE_BINDING|COPY_DST */
		});
		device.queue.writeTexture({ texture: gtex }, texBytes, { bytesPerRow: TEXN * 4 }, [TEXN, TEXN]);
		const smp = device.createSampler({
			magFilter: 'linear',
			minFilter: 'linear',
			addressModeU: 'repeat',
			addressModeV: 'repeat'
		});
		const texView = gtex.createView();
		const binds = ubufs.map((b) =>
			device.createBindGroup({
				layout: pipeline.getBindGroupLayout(0),
				entries: [
					{ binding: 0, resource: { buffer: b } },
					{ binding: 1, resource: texView },
					{ binding: 2, resource: smp }
				]
			})
		);
		// Timestamp machinery (real GPU ms), when the feature exists.
		let qset: any = null;
		let qbuf: any = null;
		let qread: any = null;
		if (wantTs) {
			qset = device.createQuerySet({ type: 'timestamp', count: 2 });
			qbuf = device.createBuffer({ size: 16, usage: 0x200 | 0x4 /* QUERY_RESOLVE|COPY_SRC */ });
			qread = device.createBuffer({ size: 16, usage: 0x8 | 0x1 /* COPY_DST|MAP_READ */ });
		}
		let frameIdx = 0;
		const samples: number[] = [];
		const gpuSamples: number[] = [];
		const doneSamples: number[] = [];
		let last = performance.now();
		let raf = 0;
		let mapping = false;
		// FRAMES-IN-FLIGHT pacing. WebGPU has no implicit backpressure:
		// submitting every rAF tick while the GPU runs slower than vsync
		// grows the queue without bound — submit→done then measures an
		// ever-deepening backlog instead of a frame. Two in flight keeps
		// the GPU busy without letting the queue run away.
		let inFlight = 0;
		status = wantTs ? 'webgpu running (GPU timestamps on)' : 'webgpu running (no timestamp feature)';
		const loop = () => {
			raf = requestAnimationFrame(loop);
			if (inFlight >= 2) return; // paced: skip until the GPU catches up
			inFlight++;
			const now = performance.now();
			samples.push(now - last);
			last = now;
			if (samples.length > 90) samples.shift();
			if (samples.length > 30) {
				const s = samples.slice(10);
				gpuMs = s.reduce((a, b) => a + b, 0) / s.length;
			}
			if (frameIdx === 0) device.pushErrorScope('validation');
			for (let p = 0; p < passes; p++) {
				device.queue.writeBuffer(
					ubufs[p], 0, new Float32Array([now / 1000 + p * 0.05, W, H, 1 / passes])
				);
			}
			const enc = device.createCommandEncoder();
			for (let p = 0; p < passes; p++) {
				const desc: any = {
					colorAttachments: [
						{
							view: ctx.getCurrentTexture().createView(),
							loadOp: p === 0 ? 'clear' : 'load',
							storeOp: 'store',
							clearValue: { r: 0, g: 0, b: 0, a: 1 }
						}
					]
				};
				if (qset && p === 0) {
					desc.timestampWrites = {
						querySet: qset,
						// The spec names include "Write" — the shorter names
						// validate as undefined and invalidate the ENTIRE
						// command buffer: nothing executes, the queue drains
						// instantly, and the bench reports a spectacular
						// fiction. Root cause of the fake 12x (2026-08-24).
						beginningOfPassWriteIndex: 0,
						endOfPassWriteIndex: 1
					};
				}
				const pass = enc.beginRenderPass(desc);
				pass.setPipeline(pipeline);
				pass.setBindGroup(0, binds[p]);
				pass.draw(3);
				pass.end();
			}
			if (qset && !mapping) {
				enc.resolveQuerySet(qset, 0, 2, qbuf, 0);
				enc.copyBufferToBuffer(qbuf, 0, qread, 0, 16);
			}
			device.queue.submit([enc.finish()]);
			if (frameIdx === 0) {
				device.popErrorScope().then((e: any) => {
					if (e && !firstErr) {
						firstErr = true;
						status = 'root error: ' + e.message;
					}
				});
			}
			frameIdx++;
			// TRUE COMPLETION clock per submitted frame; also the pacing
			// release. With at most 2 in flight this measures a frame's
			// work plus at most one predecessor — bounded, honest.
			{
				const t0 = performance.now();
				device.queue.onSubmittedWorkDone().then(() => {
					inFlight--;
					doneSamples.push(performance.now() - t0);
					if (doneSamples.length > 60) doneSamples.shift();
					if (doneSamples.length > 10) {
						const g = doneSamples.slice(5);
						gpuDoneMs = g.reduce((a, b) => a + b, 0) / g.length;
					}
				});
			}
			if (qset && !mapping) {
				mapping = true;
				qread
					.mapAsync(1 /* MAP_READ */)
					.then(() => {
						const ts = new BigUint64Array(qread.getMappedRange());
						const ns = Number(ts[1] - ts[0]);
						qread.unmap();
						mapping = false;
						if (ns > 0) {
							// One timed pass of `passes`: scale to whole-frame time.
							gpuSamples.push((ns / 1e6) * passes);
							if (gpuSamples.length > 60) gpuSamples.shift();
							if (gpuSamples.length > 10) {
								const g = gpuSamples.slice(5);
								gpuGpuMs = g.reduce((a, b) => a + b, 0) / g.length;
							}
						}
					})
					.catch(() => {
						mapping = false;
					});
			}
		};
		raf = requestAnimationFrame(loop);
		stopFn = () => {
			cancelAnimationFrame(raf);
			try {
				device.destroy();
			} catch {
				/* ignore */
			}
		};
	}

	onMount(() => {
		glCanvas.width = W;
		glCanvas.height = H;
		gpuCanvas.width = W;
		gpuCanvas.height = H;
		return () => stop();
	});

	const mpx = $derived((W * H * passes) / 1e6);
	const capped = $derived(
		(running === 'webgl' && glMs > 0 && glMs < 17.5) ||
			(running === 'webgpu' && gpuMs > 0 && gpuMs < 17.5)
	);
</script>

<svelte:head><title>gpu bake-off</title></svelte:head>

<div class="page">
	<div class="panel">
		<strong>WebGPU spike 0: compiler bake-off</strong>
		<p>
			The water shader's hot shapes (wave+tangent loop, branchy hit
			chain, 28-step march, 3×3 taps, exp/pow chain), twin-written in
			GLSL and WGSL, texture pressure included (two fetches per march
			step, one per tap — the atlas shapes). Same seeded constants,
			{W}×{H}×{passes} passes = {mpx.toFixed(1)} Mpx of shading per
			frame. Run ONE at a time; the two canvases must show the same
			animation. RAISE PASSES until both frame times sit well past
			20ms — at 16.7ms you are measuring vsync, not the shader.
		</p>
		<div class="row">
			<span>passes {passes}</span>
			<input type="range" min="1" max="24" step="1" bind:value={passes} />
		</div>
		{#if capped}<p style="color:#e0b050">⚠ at vsync cap — raise passes.</p>{/if}
		<div class="row">
			<button onclick={runWebGL} class:on={running === 'webgl'}>run WebGL2</button>
			<button onclick={runWebGPU} class:on={running === 'webgpu'}>run WebGPU</button>
			<button onclick={stop}>stop</button>
		</div>
		<div class="nums">
			<div class="dim">WebGL GPU: {glGpu}</div>
			<div class="dim">WebGPU GPU: {gpuGpu}</div>
			<div>
				WebGL2: <b>{glMs > 0 ? glMs.toFixed(2) + ' ms/frame' : '—'}</b>
				{#if glMs > 0}<span class="dim"> · {(glMs / mpx).toFixed(2)} ms/Mpx (CPU-paced)</span>{/if}
			</div>
			<div>
				WebGPU: <b>{gpuMs > 0 ? gpuMs.toFixed(2) + ' ms/frame' : '—'}</b>
				{#if gpuMs > 0}<span class="dim"> · {(gpuMs / mpx).toFixed(2)} ms/Mpx (submission-paced)</span>{/if}
			</div>
			<div>
				WebGPU submit→done:
				<b>{gpuDoneMs > 0 ? gpuDoneMs.toFixed(2) + ' ms' : '—'}</b>
				{#if gpuDoneMs > 0}<span class="dim"> · true completion latency</span>{/if}
			</div>
			<div>
				WebGPU GPU-timestamps:
				<b>{gpuGpuMs > 0 ? gpuGpuMs.toFixed(2) + ' ms shading' : 'n/a'}</b>
				{#if gpuGpuMs > 0}<span class="dim"> · {(gpuGpuMs / mpx).toFixed(2)} ms/Mpx (REAL GPU)</span>{/if}
			</div>
			<div class="dim">status: {status}</div>
		</div>
		<p class="dim">
			Frame times saturate at vsync unless the shader is the
			bottleneck — at {mpx.toFixed(1)} Mpx it should be. Compare the
			two CPU-paced numbers against each other; the timestamp row is
			the honest one when present.
		</p>
	</div>
	<div class="canvases">
		<div><canvas bind:this={glCanvas} style="width:100%"></canvas><span>WebGL2</span></div>
		<div><canvas bind:this={gpuCanvas} style="width:100%"></canvas><span>WebGPU</span></div>
	</div>
</div>

<style>
	:global(html, body) {
		margin: 0;
		background: #10161c;
	}
	.page {
		display: flex;
		min-height: 100vh;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-size: 13px;
		color: #cfd8e0;
	}
	.panel {
		width: 340px;
		flex: none;
		padding: 14px;
		background: #161e26;
		border-right: 1px solid #263340;
		line-height: 1.5;
	}
	.row {
		display: flex;
		gap: 8px;
		margin: 10px 0;
	}
	button {
		background: #263340;
		color: inherit;
		border: none;
		border-radius: 3px;
		padding: 5px 10px;
		font: inherit;
		cursor: pointer;
	}
	button.on {
		background: #2f6b46;
	}
	.nums {
		margin: 10px 0;
		display: grid;
		gap: 4px;
	}
	.dim {
		color: #7f8ea0;
	}
	.canvases {
		flex: 1;
		display: grid;
		grid-template-rows: 1fr 1fr;
		gap: 8px;
		padding: 8px;
	}
	.canvases div {
		position: relative;
	}
	.canvases span {
		position: absolute;
		top: 6px;
		left: 8px;
		color: #9fb0c0;
		background: rgba(16, 22, 28, 0.6);
		padding: 1px 6px;
		border-radius: 3px;
	}
</style>
