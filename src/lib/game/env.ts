/**
 * The environment system: one function from time-of-day to everything the
 * scene needs. Weather will later modulate the same outputs (fog density,
 * wave amplitude, water clarity), so all lighting and color flows through
 * this single point.
 *
 * In a true isometric orthographic view the sky itself is never on screen;
 * every camera ray points down into the water. Day and night therefore read
 * entirely through light color, water palette, and fog, which is what this
 * module produces.
 */

/** 24 real minutes per in-game day. */
export const DAY_SECONDS = 24 * 60;

export type RGB = [number, number, number];

export type Env = {
	/** Normalized, points from the scene toward the light (sun by day, moon by night). */
	lightDir: RGB;
	light: RGB;
	lightIntensity: number;
	ambient: RGB;
	ambientIntensity: number;
	waterDeep: RGB;
	waterShallow: RGB;
	glint: RGB;
	fog: RGB;
	fogDensity: number;
	waveAmp: number;
	/** 0 in daylight, 1 at night. Bioluminescence and stars hook in here later. */
	night: number;
};

type Palette = {
	deep: string;
	shallow: string;
	fog: string;
	light: string;
	lightIntensity: number;
	ambient: string;
	ambientIntensity: number;
	glint: string;
	fogDensity: number;
	waveAmp: number;
};

const NIGHT: Palette = {
	deep: '#04101c',
	shallow: '#12293e',
	fog: '#0d1622',
	light: '#96b4d8',
	lightIntensity: 0.55,
	ambient: '#2a3a55',
	ambientIntensity: 0.9,
	glint: '#c8dcf0',
	fogDensity: 0.008,
	waveAmp: 0.85
};

const DAWN: Palette = {
	deep: '#0e3040',
	shallow: '#c08d5f',
	fog: '#a06e50',
	light: '#ffc890',
	lightIntensity: 1.05,
	ambient: '#6d6274',
	ambientIntensity: 0.75,
	glint: '#ffd9a8',
	fogDensity: 0.006,
	waveAmp: 0.95
};

const MORNING: Palette = {
	deep: '#0d4a66',
	shallow: '#2f9dba',
	fog: '#acd8e8',
	light: '#fff1cf',
	lightIntensity: 1.3,
	ambient: '#7d9cb2',
	ambientIntensity: 0.7,
	glint: '#fff3d6',
	fogDensity: 0.004,
	waveAmp: 1
};

const NOON: Palette = {
	deep: '#0e567a',
	shallow: '#3ab5d4',
	fog: '#c2e6f2',
	light: '#fff8e6',
	lightIntensity: 1.45,
	ambient: '#8fb5c9',
	ambientIntensity: 0.7,
	glint: '#ffffff',
	fogDensity: 0.0035,
	waveAmp: 1
};

const DUSK: Palette = {
	deep: '#132c42',
	shallow: '#b0714f',
	fog: '#7d5244',
	light: '#ff9a5c',
	lightIntensity: 0.95,
	ambient: '#4e4c66',
	ambientIntensity: 0.7,
	glint: '#ffb87e',
	fogDensity: 0.006,
	waveAmp: 1.05
};

/** Phase 0 = midnight, 0.25 = sunrise, 0.5 = noon, 0.75 = sunset. */
const KEYFRAMES: [number, Palette][] = [
	[0.0, NIGHT],
	[0.21, NIGHT],
	[0.27, DAWN],
	[0.34, MORNING],
	[0.5, NOON],
	[0.66, MORNING],
	[0.73, DUSK],
	[0.79, NIGHT],
	[1.0, NIGHT]
];

function hexToRgb(hex: string): RGB {
	const n = parseInt(hex.slice(1), 16);
	return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

const FRAMES = KEYFRAMES.map(([phase, p]) => ({
	phase,
	deep: hexToRgb(p.deep),
	shallow: hexToRgb(p.shallow),
	fog: hexToRgb(p.fog),
	light: hexToRgb(p.light),
	lightIntensity: p.lightIntensity,
	ambient: hexToRgb(p.ambient),
	ambientIntensity: p.ambientIntensity,
	glint: hexToRgb(p.glint),
	fogDensity: p.fogDensity,
	waveAmp: p.waveAmp
}));

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lerp3 = (a: RGB, b: RGB, t: number): RGB => [
	lerp(a[0], b[0], t),
	lerp(a[1], b[1], t),
	lerp(a[2], b[2], t)
];

function smoothstep(edge0: number, edge1: number, x: number): number {
	const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
	return t * t * (3 - 2 * t);
}

export function computeEnv(phase: number): Env {
	const p = ((phase % 1) + 1) % 1;

	let i = 0;
	while (i < FRAMES.length - 2 && FRAMES[i + 1].phase < p) i++;
	const a = FRAMES[i];
	const b = FRAMES[i + 1];
	const t = smoothstep(0, 1, (p - a.phase) / (b.phase - a.phase));

	// Sun travels east to west; the moon takes over on the opposite arc.
	const theta = (p - 0.25) * Math.PI * 2;
	const sunAltitude = Math.sin(theta);
	const usingSun = sunAltitude > 0;
	const raw: RGB = usingSun
		? [Math.cos(theta) * 0.85, sunAltitude, 0.32]
		: [-Math.cos(theta) * 0.85, -sunAltitude, -0.32];
	const len = Math.hypot(raw[0], raw[1], raw[2]);
	const lightDir: RGB = [raw[0] / len, raw[1] / len, raw[2] / len];

	// Dim through the handover so the light never pops between sun and moon.
	const horizonFade = smoothstep(0.02, 0.14, Math.abs(sunAltitude));

	return {
		lightDir,
		light: lerp3(a.light, b.light, t),
		lightIntensity: lerp(a.lightIntensity, b.lightIntensity, t) * horizonFade,
		ambient: lerp3(a.ambient, b.ambient, t),
		ambientIntensity: lerp(a.ambientIntensity, b.ambientIntensity, t),
		waterDeep: lerp3(a.deep, b.deep, t),
		waterShallow: lerp3(a.shallow, b.shallow, t),
		glint: lerp3(a.glint, b.glint, t),
		fog: lerp3(a.fog, b.fog, t),
		fogDensity: lerp(a.fogDensity, b.fogDensity, t),
		waveAmp: lerp(a.waveAmp, b.waveAmp, t),
		night: smoothstep(0.05, -0.1, sunAltitude)
	};
}
