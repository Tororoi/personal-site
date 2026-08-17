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

import { applyOverrides, type Knob } from './tuningstore';

/**
 * The environment knobs the tuning panel drives LIVE — no reload, unlike
 * everything in tuning.ts. They can be live precisely because nothing
 * bakes them: computeEnv() reads all of them on every call, once a frame.
 */
const ENV_BASE = {
	/**
	 * Real seconds per in-game day. 240 is long enough to read as a cycle,
	 * short enough to watch dawn, noon, dusk and night in one sitting.
	 */
	daySeconds: 240,
	/**
	 * ANGLE — which way the arc runs, in degrees: the compass bearing the
	 * sun rises from. 0 = +X, increasing toward +Z (clockwise from above),
	 * the same convention as windAngle. Spinning this turns the whole path
	 * about the vertical axis; it does not change its shape.
	 *
	 * 45 lays the path along the camera's own axis. The camera sits at
	 * (34, 30, 34), azimuth 45 degrees, so the sun rises behind it and sets
	 * at azimuth 225 — directly opposite, in the middle of the view. That
	 * is the arrangement that makes a specular highlight plainest: at dusk
	 * the sun is straight ahead and its reflection comes back along the
	 * line of sight.
	 */
	sunPathAngleDeg: 45,
	/**
	 * OFFSET — how far the arc is pushed off centre, in degrees.
	 *
	 * At 0 the path is a great circle: it cuts through the middle of the
	 * sphere and passes straight overhead at midday, which is only what
	 * the sun really does on the equator. Winding this up slides the whole
	 * circle sideways off the sphere's centre, so it becomes a smaller
	 * circle leaning to one side and the sun tracks across at an angle
	 * instead of climbing to the top — the everywhere-else case, and how a
	 * season or a latitude reads. The number IS the miss distance: 30
	 * means the highest the sun gets is 30 degrees short of straight up.
	 * Sign picks the side it leans to.
	 *
	 * Sunrise and sunset stay put no matter what this is, so day length
	 * and the sun/moon handover are untouched — only the height and the
	 * lean of the arc between them change.
	 */
	sunPathOffsetDeg: 0,
	/** The moon's own angle. 50 keeps its circle crossing the sun's rather
	 * than sitting on top of it. */
	moonPathAngleDeg: 50,
	/** The moon's own offset, read exactly like the sun's. */
	moonPathOffsetDeg: 0,
	/**
	 * AUTO-AIM THE GLITTER. When on, sunPathAngleDeg is ignored and solved
	 * for instead, so the sun crosses the camera's view axis — and the
	 * glitter path stands vertical on screen — at sunGlintPhase.
	 *
	 * Why this rather than a rule that keeps it vertical all day: it cannot
	 * be done. The sun's azimuth is angle + atan2(sin off, cos off cos t),
	 * so it is constant only when the offset is zero — and a zero offset
	 * forces the arc through the zenith and pins the azimuth to the angle
	 * itself, which is what puts the glitter off-screen once the angle is
	 * chosen for how it lights objects rather than where it reflects.
	 * Tilt the arc and the azimuth must sweep. What you CAN choose is
	 * WHEN the sweep crosses the camera, which is what this does.
	 */
	alignGlint: false,
	/**
	 * Day phase at which to stand the glitter vertical, when alignGlint is
	 * on. 0.66 is mid-afternoon, where the sun is low enough for a long
	 * reflection but still well clear of the horizon.
	 */
	glintPhase: 0.66,
	/** Hold the clock where it is, so a phase can be studied still. */
	freezeTime: false
};

/**
 * Azimuth the camera looks along, degrees. The camera sits at (34, 30, 34)
 * facing the origin, so it looks toward 225 — and a glitter path lying on
 * that bearing (or its opposite, 45) is the one that reads as vertical on
 * screen rather than running off at an angle.
 */
export const CAMERA_AZIMUTH_DEG = 225;

/** As written in this file, before any saved override. */
export const ENV_DEFAULTS: Record<string, Knob> = { ...ENV_BASE };

export const ENV = applyOverrides('ENV', ENV_BASE);

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

const DEG = Math.PI / 180;

/**
 * The sun's path angle actually in force: the knob, or the value solved to
 * put the glitter on the camera axis at ENV.glintPhase.
 *
 * Inverts azimuth(t) = angle + atan2(sin off, cos off * cos t) for `angle`
 * at the chosen phase. Exported because the tuning panel reports the
 * derived value — a knob that is silently ignored is worse than no knob.
 */
export function effectiveSunAngleDeg(): number {
	if (!ENV.alignGlint) return ENV.sunPathAngleDeg;
	const off = ENV.sunPathOffsetDeg * DEG;
	const theta = (ENV.glintPhase - 0.25) * Math.PI * 2;
	const swing = Math.atan2(Math.sin(off), Math.cos(off) * Math.cos(theta)) / DEG;
	return CAMERA_AZIMUTH_DEG - swing;
}

export function computeEnv(phase: number): Env {
	const p = ((phase % 1) + 1) % 1;

	let i = 0;
	while (i < FRAMES.length - 2 && FRAMES[i + 1].phase < p) i++;
	const a = FRAMES[i];
	const b = FRAMES[i + 1];
	const t = smoothstep(0, 1, (p - a.phase) / (b.phase - a.phase));

	// Sun and moon each travel a GREAT CIRCLE through the sphere's
	// centre: a unit circle in the plane spanned by world up and a fixed
	// horizontal heading. (The previous formulation squashed X by 0.85
	// and pushed the whole arc south by a constant 0.6, which made both
	// paths off-centre ellipses — and negating the vector at handover
	// mirrored the night arc onto the opposite side of the sphere rather
	// than continuing it.)
	//
	// The moon's plane is rotated a few degrees from the sun's, so the
	// two circles cross rather than coincide.
	const theta = (p - 0.25) * Math.PI * 2;
	const sunAltitude = Math.sin(theta);
	const usingSun = sunAltitude > 0;
	// The moon rides the same clock half a turn later, so it is up
	// exactly when the sun is down.
	const bodyTheta = usingSun ? theta : theta + Math.PI;
	const sunAngle = effectiveSunAngleDeg();
	// The moon keeps its own angle as a DELTA off the sun's, so an
	// auto-aimed sun does not leave the two arcs in unrelated places.
	const angle =
		(usingSun ? sunAngle : sunAngle + (ENV.moonPathAngleDeg - ENV.sunPathAngleDeg)) * DEG;
	const offset = (usingSun ? ENV.sunPathOffsetDeg : ENV.moonPathOffsetDeg) * DEG;

	// The path is built from three perpendicular directions: `u`, the
	// horizontal bearing the body rises from; world up; and `n`, the
	// horizontal direction square to both, which is the axis the circle
	// slides along when it comes off centre.
	const ux = Math.cos(angle);
	const uz = Math.sin(angle);
	const nx = -uz;
	const nz = ux;
	const ct = Math.cos(bodyTheta);
	const st = Math.sin(bodyTheta);

	// With offset 0 this is u*cos + up*sin: a great circle through the
	// zenith. Offset shifts the circle sin(offset) of the way along n and
	// shrinks its radius to cos(offset), which is what keeps every point
	// on the unit sphere — the circle stays ON the sphere, just no longer
	// centred on it. Peak altitude falls to 90 - offset degrees, while the
	// horizon crossings stay at bodyTheta 0 and PI, because the vertical
	// component is cos(offset)*sin(bodyTheta) and n is horizontal.
	const shift = Math.sin(offset);
	const ring = Math.cos(offset);
	const lightDir: RGB = [nx * shift + ux * ct * ring, st * ring, nz * shift + uz * ct * ring];

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
