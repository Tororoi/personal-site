/**
 * Persistence for the in-page tuning panel (TuningPanel.svelte).
 *
 * WHY LOCALSTORAGE AND A RELOAD, rather than live-patching the running
 * scene: most of these values are baked into GLSL as literals, and not
 * only at component construction — foam.ts, ripples.ts, caustics.ts and
 * mistfield.ts assemble their shader strings at MODULE scope, which runs
 * once per page load. Remounting the canvas would rebuild the water
 * material against fresh values while those module-level shaders kept
 * the old ones, so half the change would land and half would not. That
 * failure is silent and looks exactly like the effect not working, which
 * is the worst possible thing to hand someone who is tuning.
 *
 * A reload sidesteps the whole class of problem: every module body reruns
 * and every literal is re-baked. The scene is deterministic from its seed,
 * so it comes back the same apart from the change under test.
 *
 * Overrides are applied by each config module at ITS OWN module scope, so
 * importers only ever observe patched values — ESM guarantees a module
 * body completes before any importer's does.
 */

export type Knob = number | boolean;
export type Overrides = Record<string, Record<string, Knob>>;

const KEY = 'game-tuning-overrides';

export function loadOverrides(): Overrides {
	if (typeof localStorage === 'undefined') return {};
	try {
		const raw = localStorage.getItem(KEY);
		const parsed = raw ? JSON.parse(raw) : null;
		return parsed && typeof parsed === 'object' ? (parsed as Overrides) : {};
	} catch {
		// Corrupt JSON, or storage blocked (private mode, embedded webview).
		// Tuning is a dev affordance; never let it stop the game booting.
		return {};
	}
}

export function saveOverrides(o: Overrides) {
	if (typeof localStorage === 'undefined') return;
	try {
		localStorage.setItem(KEY, JSON.stringify(o));
	} catch {
		/* quota or blocked storage */
	}
}

export function clearOverrides() {
	if (typeof localStorage === 'undefined') return;
	try {
		localStorage.removeItem(KEY);
	} catch {
		/* blocked storage */
	}
}

/**
 * Read once at module load so every group sees the same snapshot, and so
 * a panel that saves mid-session cannot half-apply to modules that have
 * not been evaluated yet.
 */
const SAVED = loadOverrides();

// MIGRATION — the env path knobs were reworked from (sun heading, moon
// delta) to an angle and an offset per body. `moonPathOffsetDeg` came
// through that rename with its NAME intact and its MEANING changed, which
// is the one case applyOverrides cannot detect: it type-checks and lands
// silently as a wrong value. The dropped `sunPathHeadingDeg` identifies a
// set written before the rework, so those are discarded outright.
if (SAVED.ENV && 'sunPathHeadingDeg' in SAVED.ENV) {
	delete SAVED.ENV;
	saveOverrides(SAVED);
}

// MIGRATION — UNIFIED merged into SEA (2026-08): the unified field IS the
// sea now, so its saved overrides keep applying under the new home.
if (SAVED.UNIFIED) {
	SAVED.SEA = { ...(SAVED.SEA ?? {}), ...SAVED.UNIFIED };
	delete SAVED.UNIFIED;
	saveOverrides(SAVED);
}

// MIGRATION — FFT's lone knob (stepEvery) moved into SEA's detail block.
if (SAVED.FFT) {
	SAVED.SEA = { ...(SAVED.SEA ?? {}), ...SAVED.FFT };
	delete SAVED.FFT;
	saveOverrides(SAVED);
}

// MIGRATION — CONTACT (the collar) merged into FOAM under collar* names.
if (SAVED.CONTACT) {
	const collar: Record<string, number | boolean> = {};
	for (const [k, v] of Object.entries(SAVED.CONTACT)) {
		collar['collar' + k[0].toUpperCase() + k.slice(1)] = v;
	}
	SAVED.FOAM = { ...(SAVED.FOAM ?? {}), ...collar };
	delete SAVED.CONTACT;
	saveOverrides(SAVED);
}

// MIGRATION — motorFoam renamed to centerWakeFoam and rehomed under the
// wake group; the scale also shrank (old max 20, new max 3 = the tuned
// level), so a carried value is capped rather than left off-slider.
if (SAVED.BOAT && 'motorFoam' in SAVED.BOAT) {
	const v = SAVED.BOAT.motorFoam;
	if (typeof v === 'number') SAVED.BOAT.centerWakeFoam = Math.min(v, 3);
	delete SAVED.BOAT.motorFoam;
	saveOverrides(SAVED);
}

// MIGRATION — gustSpacingM renamed BACK to gustLengthM (it briefly went
// the other way; the density job it was renamed for belongs to the
// dedicated gustDensity knob now). A stored value from the spacing era
// may exceed the new 2-60 range, so it is capped.
if (SAVED.WIND && 'gustSpacingM' in SAVED.WIND) {
	const v = SAVED.WIND.gustSpacingM;
	if (typeof v === 'number') SAVED.WIND.gustLengthM = Math.min(v, 60);
	delete SAVED.WIND.gustSpacingM;
	saveOverrides(SAVED);
}

// MIGRATION — the WEATHER restructure (2026-08-24): SEA.weather became
// WEATHER.overcast; SEA's wind pair moved home to WIND.
if (SAVED.SEA) {
	if ('weather' in SAVED.SEA) {
		SAVED.WEATHER = { ...(SAVED.WEATHER ?? {}), overcast: SAVED.SEA.weather };
		delete SAVED.SEA.weather;
	}
	for (const k of ['windSpeed', 'windCompassDeg'] as const) {
		if (k in SAVED.SEA) {
			SAVED.WIND = { ...(SAVED.WIND ?? {}), [k]: SAVED.SEA[k] };
			delete SAVED.SEA[k];
		}
	}
	saveOverrides(SAVED);
}

// MIGRATION — SPECULAR's inert clear/overcast pairs unified (2026-08-24):
// sharpClear -> sharp, gainClear -> gain; the Overcast twins (always held
// equal) are dropped.
if (SAVED.SPECULAR) {
	if ('sharpClear' in SAVED.SPECULAR) {
		SAVED.SPECULAR.sharp = SAVED.SPECULAR.sharpClear;
	}
	if ('gainClear' in SAVED.SPECULAR) {
		SAVED.SPECULAR.gain = SAVED.SPECULAR.gainClear;
	}
	for (const k of ['sharpClear', 'sharpOvercast', 'gainClear', 'gainOvercast']) {
		delete SAVED.SPECULAR[k];
	}
	saveOverrides(SAVED);
}

/**
 * Patch one config group in place from the saved set, and hand it back so
 * it can be used as an initialiser.
 *
 * Unknown and type-mismatched keys are skipped rather than trusted: the
 * store outlives the code, so a knob that was renamed or changed type
 * since the override was written must not resurrect itself as a stray
 * property or a string where a number is expected.
 */
export function applyOverrides<T extends Record<string, Knob>>(group: string, target: T): T {
	const saved = SAVED[group];
	if (!saved) return target;
	const t = target as Record<string, Knob>;
	for (const [k, v] of Object.entries(saved)) {
		if (!(k in t)) continue;
		if (typeof t[k] !== typeof v) continue;
		t[k] = v;
	}
	return target;
}
