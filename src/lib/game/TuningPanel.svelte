<!--
	TUNING PANEL — every knob in tuning.ts, plus the environment clock,
	editable in the page.

	TWO KINDS OF KNOB, and the distinction is the whole design:

	  LIVE (env.ts)     — nothing bakes them, computeEnv() rereads them
	                      every frame, so they apply on the drag and
	                      persist immediately.
	  STAGED (tuning.ts)— baked into GLSL as literals at module scope, so
	                      they cannot take effect without re-running those
	                      module bodies. Edits queue up and land together
	                      on Apply, which reloads the page. See the note
	                      in tuningstore.ts for why a canvas remount is
	                      not enough.

	Controls are generated from the shape of the config objects rather
	than declared per knob: there are 260 of them and a hand-written UI
	would rot the first time one was renamed. The cost is that slider
	ranges are a guess from the default value, which is why every row also
	has a number box that accepts anything.
-->
<script lang="ts">
	import { ENABLE, LIVE_GROUPS, TUNING_DEFAULTS, TUNING_GROUPS } from './tuning';
	import { computeEnv, ENV, ENV_DEFAULTS } from './env';
	import { seaDrive, seaMetrics, SEA_REFERENCE } from './waves';
	import { game, perf as perfTick } from './state.svelte';
	import {
		clearOverrides,
		loadOverrides,
		saveOverrides,
		type Knob,
		type Overrides
	} from './tuningstore';

	const UI_KEY = 'game-tuning-ui';

	type UiState = { open: string[]; hidden: boolean };
	function loadUi(): UiState {
		try {
			const raw = localStorage.getItem(UI_KEY);
			const p = raw ? JSON.parse(raw) : null;
			if (p && typeof p === 'object') {
				return { open: Array.isArray(p.open) ? p.open : [], hidden: !!p.hidden };
			}
		} catch {
			/* ignore */
		}
		return { open: [], hidden: false };
	}
	const ui0 = loadUi();

	let hidden = $state(ui0.hidden);
	let open = $state(new Set<string>(ui0.open));
	let search = $state('');

	function persistUi() {
		try {
			localStorage.setItem(UI_KEY, JSON.stringify({ open: [...open], hidden }));
		} catch {
			/* ignore */
		}
	}

	// Staged edits: group -> knob -> value. Nothing here has reached the
	// running scene yet.
	let pending = $state<Overrides>({});
	// Mirror of ENV, because ENV itself is a plain object the UI cannot
	// observe. Writes go to both.
	let envVals = $state<Record<string, Knob>>({ ...ENV });
	// ENV is a plain object, so nothing observes it; bumped on every write
	// to drive the derived sun-geometry readout below.
	let envTick = $state(0);
	// Same trick for the live tuning groups: TUNING_GROUPS is a plain object
	// the UI cannot observe, so writes bump this to force the rows to reread.
	let liveTick = $state(0);

	const pendingCount = $derived(
		Object.values(pending).reduce((n, g) => n + Object.keys(g).length, 0)
	);

	// `tuningUI` is excluded on purpose — see the comment on it in tuning.ts.
	const GROUP_NAMES = Object.keys(TUNING_GROUPS);
	const knobNames = (g: string) =>
		Object.keys(TUNING_GROUPS[g]).filter((k) => !(g === 'ENABLE' && k === 'tuningUI'));

	/** Current effective value: staged edit if there is one, else live. */
	function valueOf(g: string, k: string): Knob {
		void liveTick;
		const p = pending[g]?.[k];
		return p !== undefined ? p : TUNING_GROUPS[g][k];
	}

	/**
	 * Write a knob. Groups in LIVE_GROUPS reach the scene through uniforms
	 * refreshed every frame, so they are applied and persisted on the spot;
	 * everything else is baked into shader source and has to queue for the
	 * reload that Apply performs.
	 */
	function setKnob(g: string, k: string, v: Knob) {
		if (!LIVE_GROUPS.has(g)) {
			setStaged(g, k, v);
			return;
		}
		TUNING_GROUPS[g][k] = v;
		liveTick++;
		const o = loadOverrides();
		const next = { ...(o[g] ?? {}) };
		if (v === TUNING_DEFAULTS[g][k]) delete next[k];
		else next[k] = v;
		if (Object.keys(next).length) o[g] = next;
		else delete o[g];
		saveOverrides(o);
	}
	const isModified = (g: string, k: string) => valueOf(g, k) !== TUNING_DEFAULTS[g][k];
	const isStaged = (g: string, k: string) => pending[g]?.[k] !== undefined;

	function setStaged(g: string, k: string, v: Knob) {
		// An edit back to the live value is not a change; drop it so the
		// pending count means what it says.
		if (v === TUNING_GROUPS[g][k]) {
			if (pending[g]) {
				delete pending[g][k];
				if (!Object.keys(pending[g]).length) delete pending[g];
			}
			return;
		}
		pending[g] = { ...(pending[g] ?? {}), [k]: v };
	}

	function setEnv(k: string, v: Knob) {
		envVals[k] = v;
		envTick++;
		(ENV as unknown as Record<string, Knob>)[k] = v;
		const o = loadOverrides();
		const next = { ...(o.ENV ?? {}) };
		if (v === ENV_DEFAULTS[k]) delete next[k];
		else next[k] = v;
		if (Object.keys(next).length) o.ENV = next;
		else delete o.ENV;
		saveOverrides(o);
	}

	function apply() {
		if (!pendingCount) return;
		const o = loadOverrides();
		for (const [g, knobs] of Object.entries(pending)) {
			const next = { ...(o[g] ?? {}) };
			for (const [k, v] of Object.entries(knobs)) {
				// Storing a value identical to the source default would
				// silently pin it, so a later edit to tuning.ts would appear
				// to do nothing. Drop it instead.
				if (v === TUNING_DEFAULTS[g][k]) delete next[k];
				else next[k] = v;
			}
			if (Object.keys(next).length) o[g] = next;
			else delete o[g];
		}
		saveOverrides(o);
		location.reload();
	}

	function resetAll() {
		if (!confirm('Discard every stored override and reload?')) return;
		clearOverrides();
		location.reload();
	}

	// setStaged already drops the entry when the target equals the live
	// value, so this stages a change only when there is really one to make.
	const revert = (g: string, k: string) => setKnob(g, k, TUNING_DEFAULTS[g][k]);

	/**
	 * Slider bounds inferred from the default. A guess, deliberately: with
	 * 260 knobs the alternative is a metadata table that goes stale. The
	 * number box beside it is the authoritative control and takes any value.
	 */
	function rangeFor(def: number, cur: number) {
		const mag = Math.max(Math.abs(def), Math.abs(cur));
		const neg = def < 0 || cur < 0;
		if (mag === 0) return { min: neg ? -1 : 0, max: 1, step: 0.01 };
		if (Number.isInteger(def) && mag >= 2) {
			const max = Math.max(10, Math.ceil(mag * 4));
			return { min: neg ? -max : 0, max, step: 1 };
		}
		if (mag <= 1) return { min: neg ? -1 : 0, max: 1, step: 0.001 };
		const max = Math.ceil(mag * 4);
		return { min: neg ? -max : 0, max, step: max / 500 };
	}

	/**
	 * Explicit bounds for tuning knobs whose sensible range the heuristic
	 * cannot guess from the default. Keyed "GROUP.knob".
	 */
	/**
	 * Single-select RADIO knobs: numeric under the hood (the index), a
	 * one-only radio row in the UI. WEATHER's preset selectors —
	 * placeholders until the preset tables land.
	 */
	const RADIO_OPTIONS: Record<string, string[]> = {
		'WEATHER.skyPreset': ['sunny', 'partly cloudy', 'overcast', 'foggy', 'rainy', 'stormy'],
		'WEATHER.waterBody': ['coastal', 'tropical', 'open water'],
		'WEATHER.waterClarity': [
			'clear shallow',
			'clear deep',
			'medium clear',
			'murky',
			'red algae bloom',
			'biolum algae bloom'
		]
	};

	const TUNING_RANGE: Record<string, { min: number; max: number; step: number }> = {
		// Defaults to -1 (meaning "leave the preset alone"), so the heuristic
		// would infer -1..1 — useless for a value spanning the presets' 0.55
		// to 5. Capped AT 5 rather than past it: the storm preset is the top
		// of the real range, and letting the slider run beyond it only buys
		// unreachable sea states at the cost of resolution across the real ones.
		'SEA.chopOverride': { min: -1, max: 5, step: 0.05 },
		'SEA.seaState': { min: -1, max: 2, step: 0.01 },
		'BOAT.thrust': { min: 0, max: 8, step: 0.1 },
		'BOAT.reverseThrust': { min: 0, max: 4, step: 0.1 },
		'BOAT.horsepower': { min: 0, max: 20, step: 0.1 },
		'BOAT.centerWakeFoam': { min: 0, max: 3, step: 0.05 },
		'BOAT.dragLinear': { min: 0.05, max: 1, step: 0.01 },
		'BOAT.dragQuad': { min: 0, max: 0.15, step: 0.002 },
		'BOAT.turnRate': { min: 0, max: 2.5, step: 0.05 },
		'BOAT.turnMin': { min: 0, max: 1, step: 0.02 },
		'BOAT.turnPivotM': { min: 0, max: 2.5, step: 0.05 },
		'BOAT.yawResponse': { min: 1, max: 20, step: 0.5 },
		'BOAT.yawWaterDrag': { min: 0, max: 5, step: 0.1 },
		'BOAT.keelGrip': { min: 0, max: 10, step: 0.1 },
		'BOAT.propDepthM': { min: 0, max: 1, step: 0.02 },
		'BOAT.entryDrag': { min: 0, max: 10, step: 0.1 },
		'BOAT.slopeSlide': { min: 0, max: 1, step: 0.02 },
		'BOAT.slideLambdaM': { min: 4, max: 80, step: 1 },
		'BOAT.orbitalMotion': { min: 0, max: 1, step: 0.02 },
		'BOAT.breakPush': { min: 0, max: 8, step: 0.1 },
		'BOAT.bobPeriod': { min: 0.5, max: 4, step: 0.05 },
		'BOAT.bobZeta': { min: 0.1, max: 1.2, step: 0.02 },
		'BOAT.maxSubmersion': { min: 0.1, max: 1, step: 0.02 },
		'BOAT.rollGain': { min: 0, max: 2, step: 0.02 },
		'BOAT.pitchGain': { min: 0, max: 2, step: 0.02 },
		'BOAT.sternTrim': { min: -0.1, max: 0.15, step: 0.005 },
		'BOAT.pitchRighting': { min: 2, max: 60, step: 1 },
		'BOAT.pitchZeta': { min: 0.05, max: 1.2, step: 0.02 },
		'BOAT.rollRighting': { min: 2, max: 60, step: 1 },
		'BOAT.rollZeta': { min: 0.05, max: 1.2, step: 0.02 },
		'BOAT.trimPerSpeed': { min: 0, max: 0.08, step: 0.001 },
		'BOAT.trimPerAccel': { min: 0, max: 0.08, step: 0.001 },
		'BOAT.liftPerSpeed': { min: 0, max: 0.02, step: 0.0005 },
		'BOAT.liftMax': { min: 0, max: 0.5, step: 0.01 },
		'UNDERWATER.ambient': { min: 0, max: 1.2, step: 0.01 },
		'UNDERWATER.direct': { min: 0, max: 1.5, step: 0.01 },
		'UNDERWATER.seabedDepthM': { min: 2, max: 60, step: 0.5 },
		'CAUSTICS.edgeAA': { min: 0, max: 1, step: 0.02 },
		'CAUSTICS.maxBright': { min: 2, max: 40, step: 0.5 },
		'CAUSTICS.temporalAA': { min: 0, max: 0.92, step: 0.02 },
		'INSPECT.simpleLambdaM': { min: 8, max: 120, step: 1 },
		'INSPECT.simpleAmpM': { min: 0.05, max: 3, step: 0.05 },
		'INSPECT.simpleSteepness': { min: 0, max: 1.3, step: 0.01 },
		'INSPECT.simpleHeadingDeg': { min: 0, max: 360, step: 5 },
		'INSPECT.camYawDeg': { min: -180, max: 180, step: 5 },
		'INSPECT.camElevDeg': { min: 0, max: 80, step: 1 },
		'CAUSTICS.ridgeGain': { min: 0, max: 2.5, step: 0.02 },
		'CAUSTICS.castShadow': { min: 0, max: 1, step: 0.05 },
		'PROFILE.causticMapRes': { min: 1024, max: 4096, step: 512 },
		'PROFILE.renderScale': { min: 0.5, max: 1, step: 0.05 },
		'UNDERWATER.redRangeM': { min: 0.5, max: 40, step: 0.5 },
		'UNDERWATER.greenRangeM': { min: 2, max: 150, step: 1 },
		'UNDERWATER.blueRangeM': { min: 5, max: 400, step: 5 },
		'UNDERWATER.rayleighScatter': { min: 0, max: 0.03, step: 0.0002 },
		'UNDERWATER.mieScatter': { min: 0, max: 0.02, step: 0.0001 },
		'CAUSTICS.diffuseDepthM': { min: 2, max: 200, step: 1 },
		'CAUSTICS.formM': { min: 0.02, max: 6, step: 0.02 },
		'CAUSTICS.sourceBlurM': { min: 0, max: 0.6, step: 0.005 },
		'CAUSTICS.contrast': { min: 0.2, max: 4, step: 0.05 },
		'CAUSTICS.focalM': { min: 0, max: 6, step: 0.1 },
		'CAUSTICS.blurPerM': { min: 0, max: 1.5, step: 0.01 },
		'UNDERWATER.exposure': { min: 0.2, max: 3, step: 0.02 },
		'UNDERWATER.dim': { min: 0, max: 1, step: 0.01 },
		'UNDERWATER.glow': { min: 0, max: 3, step: 0.02 },
		'UNDERWATER.scatterClear': { min: 0, max: 3, step: 0.02 },
		'UNDERWATER.scatterOvercast': { min: 0, max: 3, step: 0.02 },
		'UNDERWATER.surfaceReflect': { min: 0, max: 0.6, step: 0.002 },
		'UNDERWATER.fresnelGrazing': { min: 0, max: 1.5, step: 0.01 },
		'UNDERWATER.entryLoss': { min: 0, max: 100, step: 0.5 },
		'UNDERWATER.ambientSkyHue': { min: 0, max: 1, step: 0.01 },
		'UNDERWATER.wrap': { min: 0, max: 1, step: 0.01 },
		'UNDERWATER.sphereDepth': { min: -14, max: 6, step: 0.1 },
		'UNDERWATER.whaleY': { min: -20, max: 2, step: 0.1 },
		'UNDERWATER.whaleX': { min: -40, max: 40, step: 0.5 },
		'UNDERWATER.whaleZ': { min: -40, max: 40, step: 0.5 },
		'BOAT.wakeAmp': { min: 0, max: 0.05, step: 0.001 },
		'BOAT.wakeOffset': { min: -2.5, max: 2.5, step: 0.1 },
		'SEA.waves': { min: 0, max: 2, step: 0.01 },
		'WEATHER.overcast': { min: 0, max: 1, step: 0.01 },
		'WEATHER.turbidity': { min: 0, max: 1, step: 0.01 },
		'WEATHER.transitionS': { min: 0, max: 60, step: 0.5 },
		'WIND.windSpeed': { min: 0, max: 45, step: 0.5 },
		'WIND.windCompassDeg': { min: 0, max: 360, step: 1 },
		'SEA.currentCompassDeg': { min: 0, max: 360, step: 1 },
		'SEA.currentSpeed': { min: 0, max: 4, step: 0.05 },
		'SEA.timeScale': { min: 0.2, max: 2, step: 0.01 },
		'SEA.lambdaScale': { min: 0.2, max: 4, step: 0.01 },
		'SEA.detailMin': { min: 0.1, max: 2, step: 0.01 },
		'SEA.detailMax': { min: 0.5, max: 8, step: 0.05 },
		'SEA.detailSlope': { min: 0, max: 0.15, step: 0.001 },
		'WIND.gustLambdaMin': { min: 0.05, max: 1, step: 0.01 },
		'WIND.gustLambdaMax': { min: 0.2, max: 3, step: 0.05 },
		'WIND.gustSlopeAmp': { min: 0, max: 0.3, step: 0.005 },
		'WIND.gustLengthM': { min: 2, max: 60, step: 1 },
		'WIND.gustWidthM': { min: 2, max: 60, step: 1 },
		'WIND.gustDensity': { min: 0, max: 1, step: 0.02 },
		'WIND.gustDirPow': { min: 1, max: 8, step: 0.5 },
		'WIND.gustFresnelGrazing': { min: 0, max: 1.5, step: 0.01 },
		'WIND.gustSurfaceReflect': { min: 0, max: 0.6, step: 0.002 },
		'WIND.gustCover': { min: 0, max: 1, step: 0.02 },
		'WIND.gustSharp': { min: 0.02, max: 0.6, step: 0.01 },
		'WIND.gustGain': { min: 0, max: 2, step: 0.05 },
		'SEA.stepEvery': { min: 1, max: 6, step: 1 },
		'DROPLET.maxCount': { min: 0, max: 8192, step: 64 },
		// Chop thresholds, so they need the chop range — not the 0..1 the
		// heuristic infers from a default under 1.
		// Exponent: above 1 is the opposite curve, so leave room for it.
		'SPECULAR.driveCurve': { min: 0.05, max: 2, step: 0.01 },
		'SPECULAR.driveSlope': { min: 0, max: 1, step: 0.01 },
		'SPECULAR.driveAmp': { min: 0, max: 1, step: 0.01 },
		'SPECULAR.driveChop': { min: 0, max: 1, step: 0.01 }
	};

	/** Explicit bounds for the handful of env knobs, which have real units. */
	const ENV_RANGE: Record<string, { min: number; max: number; step: number }> = {
		daySeconds: { min: 10, max: 1200, step: 5 }
	};

	/** What each env knob actually does, in one line, shown under its row. */
	const ENV_HELP: Record<string, string> = {
		daySeconds: 'real seconds per full day'
	};

	// What the water actually measures, as opposed to the config that
	// produced it. seaMetrics is a plain object rewritten on each field
	// rebuild, so `perf` is borrowed purely as a per-frame reactive tick.
	const sea = $derived.by(() => {
		void perfTick.calls;
		const R = SEA_REFERENCE;
		const pct = (v: number, a: number, b: number) =>
			b === a ? 0 : Math.min(Math.max((v - a) / (b - a), 0), 1);
		return {
			sigAmp: seaMetrics.sigAmp,
			rmsSlope: seaMetrics.rmsSlope,
			chop: seaMetrics.chop,
			domLambda: seaMetrics.domLambda,
			wind: seaMetrics.windSpeed,
			nSlope: pct(seaMetrics.rmsSlope, R.calm.rmsSlope, R.storm.rmsSlope),
			nAmp: pct(seaMetrics.sigAmp, R.calm.sigAmp, R.storm.sigAmp),
			nChop: pct(seaMetrics.chop, R.calm.chop, R.storm.chop),
			drive: seaDrive(
				TUNING_GROUPS.SPECULAR.driveSlope as number,
				TUNING_GROUPS.SPECULAR.driveAmp as number,
				TUNING_GROUPS.SPECULAR.driveChop as number
			)
		};
	});

	// The sun/moon path knobs are LOCKED IN (env.ts keeps the values as
	// constants); only the clock speed remains adjustable.
	const ENV_KNOBS = ['daySeconds'];

	/** Trim binary-float noise without truncating genuinely fine values. */
	const show = (n: number) => {
		if (Number.isInteger(n)) return String(n);
		return String(parseFloat(n.toPrecision(7)));
	};

	const matches = (g: string, k: string) => {
		const q = search.trim().toLowerCase();
		if (!q) return true;
		return k.toLowerCase().includes(q) || g.toLowerCase().includes(q);
	};
	/**
	 * Section headers WITHIN each group's dropdown — small labels, not
	 * sub-dropdowns. Order here is the display order; knobs missing from
	 * a group's map fall to the end unlabelled, so a newly added knob
	 * can never silently disappear from the panel.
	 */
	const KNOB_SECTIONS: Record<string, [string, string[]][]> = {
		CAUSTICS: [
			['splat', ['maxBright', 'sourceBlurM']],
			['depth', ['formM', 'focalM', 'blurPerM', 'diffuseDepthM']],
			['look', ['temporalAA', 'edgeAA', 'contrast', 'ridgeGain', 'castShadow']]
		],
		UNDERWATER: [
			['light', ['ambient', 'direct', 'dim', 'glow', 'exposure']],
			['absorption', ['redRangeM', 'greenRangeM', 'blueRangeM']],
			['scattering', ['rayleighScatter', 'mieScatter', 'scatterClear', 'scatterOvercast']],
			['shading', ['wrap', 'ambientSkyHue']],
			['interface', ['surfaceReflect', 'fresnelGrazing', 'entryLoss']],
			['seabed', ['seabed', 'seabedDepthM']],
			['testing', ['sphereDepth', 'rainbowCard', 'whale', 'whaleY', 'whaleX', 'whaleZ']]
		],
		BOAT: [
			['drive', ['pinned', 'thrust', 'reverseThrust', 'horsepower', 'propDepthM']],
			['steering', ['turnRate', 'turnMin', 'turnPivotM', 'yawResponse', 'yawWaterDrag', 'airControl']],
			['hull', ['dragLinear', 'dragQuad', 'keelGrip']],
			['waves', ['orbitalMotion', 'slopeSlide', 'slideLambdaM', 'breakPush']],
			['buoyancy', ['bobPeriod', 'bobZeta', 'maxSubmersion', 'entryDrag']],
			['swing', ['rollGain', 'rollRighting', 'rollZeta', 'pitchGain', 'pitchRighting', 'pitchZeta']],
			['trim', ['sternTrim', 'trimPerSpeed', 'trimPerAccel', 'liftPerSpeed', 'liftMax']],
			['wake', ['wakeAmp', 'wakeOffset', 'centerWakeFoam']]
		],
		SPECULAR: [
			['core', ['sharpClear', 'sharpOvercast', 'gainClear', 'gainOvercast', 'fresnelMix']],
			['drive', ['driveSlope', 'driveAmp', 'driveChop', 'driveCurve']],
			['spike', ['sharpPeak', 'spikeInStart', 'spikeInEnd', 'spikeOutStart', 'spikeOutEnd']],
			['storm', ['sharpClearStorm', 'sharpOvercastStorm', 'sharpPeakStorm', 'cameraEyeDistanceStorm']],
			['eye', ['cameraEyeDistance', 'cameraEyeHeight']],
			['halo', ['haloSharp', 'haloGain', 'haloGainLow', 'anisotropy']],
			['altitude', ['altHigh', 'altLow', 'fadeAltDeg']]
		],
		WEATHER: [
			['presets', ['skyPreset', 'waterBody', 'waterClarity', 'transitionS']],
			['dials', ['overcast', 'turbidity']]
		],
		WIND: [
			['wind', ['windSpeed', 'windCompassDeg', 'baseWander', 'baseBreath']],
			['gusting', ['gustCycle', 'gustDurMin', 'gustDurVar', 'gustTurnMin', 'gustTurnVar', 'gustSpeedMin', 'gustSpeedVar']],
			['gustmask', ['gustLambdaMin', 'gustLambdaMax', 'gustSlopeAmp', 'gustDirPow', 'gustLengthM', 'gustWidthM', 'gustDensity', 'gustCover', 'gustSharp', 'gustGain', 'gustFresnelGrazing', 'gustSurfaceReflect']]
		],
		SEA: [
			['sea', ['waves', 'lambdaScale', 'chopOverride', 'seaState', 'transitionSecondsPerUnit']],
			['current', ['currentSpeed', 'currentCompassDeg']],
			['tempo', ['timeScale']],
			['detail', ['detailMin', 'detailMax', 'detailSlope', 'stepEvery']]
		],
		FROTH: [
			['size', ['lattice', 'radiusBase', 'radiusVar', 'sizeCap']],
			['gates', ['gateJStart', 'gateJFull', 'gateLag', 'gateLagWeight']],
			['amplitude', ['ampRef', 'ampCurve', 'ampRatioFloor']],
			['intensity', ['intJStart', 'intJSpan', 'intFloor', 'curveBoost', 'curveStart', 'curveEnd']],
			['density', ['visStart', 'visFull', 'densMax', 'densMin', 'densStart', 'densEnd', 'densSoft']],
			['culling', ['cullRadius', 'minPixels']],
			['pose', ['submersion', 'normalTilt']]
		],
		FOAM: [
			['deposition', ['layPinchStart', 'layPinchFull', 'layMinRadius', 'layFullRadius', 'layRate', 'layBigRolloff', 'layBigStart', 'layBigFull']],
			['contact', ['contactBand', 'contactBowGain', 'contactFlowFull', 'contactRate', 'contactOverwash', 'contactLift', 'contactChopStart', 'contactChopFull', 'collarWidth', 'collarAlpha', 'collarSoft', 'collarWobble', 'collarWobbleScale', 'collarOverwash', 'collarSubmergeBias', 'collarLiftFade', 'collarSpreadFloor']],
			['decay', ['decayThin', 'decayThick', 'decayOld', 'dormantDecay', 'evaporation', 'turbJStart', 'turbJFull']],
			['motion', ['diffusion', 'drift', 'currentCarry']],
			['growth', ['growStart', 'growFull']],
			['variety', ['varyScale', 'varySpread', 'varyLife', 'cellLifeVary', 'cellSpreadVary', 'cellMaxSizeVary', 'cellSolidVary', 'cellFadeVary']],
			['overload', ['overloadStart', 'overloadFull']],
			['shading', ['lightTint', 'darkFloor', 'skyGain', 'sunGain', 'diffuseBase', 'shapeFloor']],
			['web', ['densStart', 'densEnd', 'cellFine', 'cellCoarse']]
		],
		DROPLET: [
			['physics', ['maxCount', 'gravity', 'windCarry', 'drag']],
			['impact', ['impactMinSpeed', 'impactFullSpeed', 'impactCountMin', 'impactCountMax', 'impactCountCurve', 'impactSizeCurve']],
			['scan', ['scanInterval', 'scanStep', 'scanExtent', 'scanJ', 'scanCoarse', 'scanBand', 'checkSlopeBound', 'checkMaxGap']],
			['gating', ['exposeMin', 'depthSpan', 'minFroth', 'minLoopLength', 'perFroth', 'maxPerPoint', 'birthStagger']],
			['launch', ['hopUpMin', 'hopUpVar', 'hopFwdMin', 'hopFwdVar', 'hopFwdSizeFloor', 'hopFwdSpeedFloor', 'launchClearance']],
			['lifetime', ['sizeMin', 'sizeMax', 'sizeVsFroth', 'growTime', 'dieTime', 'peakHeight', 'peakRise', 'minFlight', 'lifeMax', 'submergeGrace']],
			['streaks', ['streakPerSpeed', 'streakCap']],
			['deposit', ['depositBase', 'depositPerSize', 'depositAmount', 'depositBaseBuoy', 'depositPerSizeBuoy', 'depositAmountBuoy']]
		],
		PLUME: [
			['reach', ['reachRadii', 'rootDepth', 'clipFrac']],
			['burst', ['ampIdle', 'ampFull', 'speedFull', 'burstHeightStart', 'burstHeightFull', 'fallRamp', 'risingStrength']],
			['motion', ['leanStrength', 'gustLean', 'swayAmp', 'swayRate', 'swayHeightPhase']],
			['shape', ['widthBase', 'widthGrowth', 'riseBase', 'risePerSpeed']],
			['wisps', ['wispRows', 'wispFreq', 'wispCut', 'wispCutEnd', 'tatterFreq', 'tatterThresh', 'tatterThreshCap']],
			['fade', ['bodyBias', 'coherence', 'coherenceScale', 'tipFade', 'edgeFade', 'alpha', 'alphaCull']]
		],
		LOOP: [
			['stretch', ['stretchJRamp', 'stretchDepth', 'stretchFrothR', 'stretchBack', 'stretchDown']]
		],
		BOWCREST: [
			['geometry', ['arc', 'standoffFrac', 'thickPerWidth', 'lean', 'minRing']],
			['taper', ['taperPower', 'taperMin', 'rollRate', 'endFade']],
			['froth', ['frothAlong', 'frothAround', 'frothBase', 'frothRadiusVar', 'frothProud']],
			['segments', ['segArc', 'segLip']]
		],
		MIST: [
			['sim', ['extent', 'simRes', 'dyeRes', 'pressureIters', 'velDissipation', 'dyeDissipation', 'vorticity']],
			['gusts', ['windCarry', 'windGrip', 'gustSlide', 'gustSwirl', 'gustGapMin', 'gustGapVar', 'gustDurMin', 'gustDurVar']],
			['spume', ['spumeRate', 'spumePerFrame', 'spumeCrestShare']],
			['look', ['opacityGain', 'brightStart', 'brightEnd', 'hover']]
		],
		ENABLE: [
			['water', ['caustics', 'fftDetail', 'gustMask', 'objectWave']],
			['whitewater', ['loopWhite', 'loopStretch', 'froth', 'crestPlumes', 'whitecapEvents', 'bowCrest']],
			['spray', ['splashDroplets', 'buoySpray', 'dropletFoam']],
			['foam', ['foamField', 'foamTrail', 'contactFoam', 'contactEmit', 'turbDissipation']],
			['mist', ['mist', 'mistGusts']],
			['meta', ['tuningUI', 'gpuProfile', 'perfLog']]
		],
		PROFILE: [
			['shading', ['vertexSlope', 'skipRefraction', 'skipReflection', 'skipSpecular', 'skipFoam', 'skipRipple', 'skipLoopWhite']],
			['sims', ['skipRippleSim', 'skipCausticSim', 'causticMapRes', 'skipFoamSim']],
			['hide', ['hideWater', 'hideObjects', 'hideFroth', 'hideSpray']],
			['canvas', ['renderScale', 'autoScale', 'noAntialias', 'opaqueCanvas']],
			['camera', ['perspectiveCamera', 'perspectiveDistance']],
			['misc', ['skipLandingCheck', 'buoyLog']]
		],
		INSPECT: [
			['sea', ['simpleSea', 'simpleLambdaM', 'simpleAmpM', 'simpleSteepness', 'simpleHeadingDeg']],
			['camera', ['camYawDeg', 'camElevDeg']]
		]
	};
	/** Prefix marking a header entry in the sectioned knob list. */
	const SECTION_MARK = '\u00a7';
	function sectionKnobs(g: string, hits: string[]): string[] {
		const secs = KNOB_SECTIONS[g];
		if (!secs || !hits.length) return hits;
		const out: string[] = [];
		const used = new Set<string>();
		for (const [h, keys] of secs) {
			const sub = keys.filter((k) => hits.includes(k));
			if (!sub.length) continue;
			out.push(SECTION_MARK + h);
			for (const k of sub) {
				out.push(k);
				used.add(k);
			}
		}
		out.push(...hits.filter((k) => !used.has(k)));
		return out;
	}

	const groupHits = (g: string) => knobNames(g).filter((k) => matches(g, k));

	function toggleGroup(g: string) {
		if (open.has(g)) open.delete(g);
		else open.add(g);
		open = new Set(open);
		persistUi();
	}

	/** Every knob differing from the file, as something pasteable. */
	function copyChanges() {
		const lines: string[] = [];
		const envDiff = Object.keys(ENV_DEFAULTS).filter((k) => envVals[k] !== ENV_DEFAULTS[k]);
		if (envDiff.length) {
			lines.push('// env.ts — ENV');
			for (const k of envDiff) lines.push(`  ${k}: ${show2(envVals[k])},`);
		}
		for (const g of GROUP_NAMES) {
			const diff = knobNames(g).filter((k) => isModified(g, k));
			if (!diff.length) continue;
			lines.push(`// tuning.ts — ${g}`);
			for (const k of diff) lines.push(`  ${k}: ${show2(valueOf(g, k))},`);
		}
		const text = lines.length ? lines.join('\n') : '// nothing changed from the file defaults';
		navigator.clipboard?.writeText(text);
		copied = true;
		setTimeout(() => (copied = false), 1200);
	}
	const show2 = (v: Knob) => (typeof v === 'boolean' ? String(v) : show(v));
	let copied = $state(false);

	const totalModified = $derived(
		GROUP_NAMES.reduce((n, g) => n + knobNames(g).filter((k) => isModified(g, k)).length, 0) +
			Object.keys(ENV_DEFAULTS).filter((k) => envVals[k] !== ENV_DEFAULTS[k]).length
	);

	// ---- time of day -------------------------------------------------
	const phase = $derived(((game.time / ENV.daySeconds) % 1 + 1) % 1);
	/** Name the phase from the same landmarks env.ts keyframes on. */
	const phaseLabel = $derived(
		phase < 0.21 || phase >= 0.79
			? 'night'
			: phase < 0.3
				? 'dawn'
				: phase < 0.44
					? 'morning'
					: phase < 0.58
						? 'noon'
						: phase < 0.7
							? 'afternoon'
							: 'dusk'
	);
	function setPhase(p: number) {
		game.time = p * ENV.daySeconds;
	}
	/**
	 * Scrubbing the clock freezes it. Otherwise the thumb springs forward
	 * under the cursor on every frame and the control is unusable — and
	 * wanting to look at a particular phase is the only reason to drag it.
	 */
	function grabPhase() {
		if (!ENV.freezeTime) setEnv('freezeTime', true);
	}

	function onKey(e: KeyboardEvent) {
		const t = e.target as HTMLElement | null;
		if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
		if (e.key === '`') {
			hidden = !hidden;
			persistUi();
		}
	}
</script>

<svelte:window onkeydown={onKey} />

{#if hidden}
	<button
		class="reveal"
		onclick={() => {
			hidden = false;
			persistUi();
		}}>tuning `</button
	>
{:else}
	<div class="panel">
		<header>
			<div class="titlerow">
				<strong>TUNING</strong>
				<span class="dim">{totalModified} changed</span>
				<button
					class="x"
					title="Hide (`)"
					onclick={() => {
						hidden = true;
						persistUi();
					}}>×</button
				>
			</div>
			<div class="actions">
				<button class="apply" disabled={!pendingCount} onclick={apply}>
					{pendingCount ? `Apply ${pendingCount} & reload` : 'Apply'}
				</button>
				<button onclick={copyChanges}>{copied ? 'Copied' : 'Copy'}</button>
				<button onclick={resetAll}>Reset</button>
			</div>
			<input class="search" placeholder="filter knobs…" bind:value={search} />
			{#if pendingCount}
				<p class="note">
					Staged edits are baked into shader source — they land on Apply, which reloads.
				</p>
			{/if}
		</header>

		<div class="body">
			<!-- LIVE: applies on the drag, no reload. -->
			<section class="grp live">
				<h3>ENVIRONMENT <span class="dim">live</span></h3>

				<div class="knob">
					<div class="head">
						<span class="name">time of day <span class="dim">{phaseLabel}</span></span>
						<span class="num ro">{phase.toFixed(3)}</span>
					</div>
					<input
						type="range"
						min="0"
						max="1"
						step="0.001"
						value={phase}
						onpointerdown={grabPhase}
						oninput={(e) => setPhase(+e.currentTarget.value)}
					/>
				</div>

				<label class="bool">
					<input
						type="checkbox"
						checked={!!envVals.freezeTime}
						onchange={(e) => setEnv('freezeTime', e.currentTarget.checked)}
					/>
					<span class="name" class:mod={envVals.freezeTime !== ENV_DEFAULTS.freezeTime}
						>freezeTime</span
					>
				</label>

				<label class="bool">
					<input
						type="checkbox"
						checked={!!envVals.freezeWaves}
						onchange={(e) => setEnv('freezeWaves', e.currentTarget.checked)}
					/>
					<span class="name" class:mod={envVals.freezeWaves !== ENV_DEFAULTS.freezeWaves}
						>freezeWaves</span
					>
				</label>


				{#each ENV_KNOBS as k (k)}
					{@const r = ENV_RANGE[k]}
					<div class="knob">
						<div class="head">
							<span class="name" class:mod={envVals[k] !== ENV_DEFAULTS[k]}>{k}</span>
							<input
								class="num"
								type="number"
								step={r.step}
								value={show(envVals[k] as number)}
								onchange={(e) => setEnv(k, +e.currentTarget.value)}
							/>
						</div>
						<input
							type="range"
							min={r.min}
							max={r.max}
							step={r.step}
							value={envVals[k] as number}
							oninput={(e) => setEnv(k, +e.currentTarget.value)}
						/>
						<p class="help">{ENV_HELP[k]}</p>
					</div>
				{/each}
			</section>

			<section class="grp live">
				<h3>SEA <span class="dim">measured</span></h3>
				<div class="geom">
					<div><span>significant amplitude</span><span>{sea.sigAmp.toFixed(3)} m</span></div>
					<div><span>RMS slope</span><span>{sea.rmsSlope.toFixed(4)}</span></div>
					<div><span>chop</span><span>{sea.chop.toFixed(2)}</span></div>
					<div><span>dominant wavelength</span><span>{sea.domLambda.toFixed(1)} m</span></div>
					<div><span>wind</span><span>{sea.wind.toFixed(1)} m/s</span></div>
					<div class="rule"><span>normalised calm&rarr;storm</span><span></span></div>
					<div><span>slope</span><span>{(sea.nSlope * 100).toFixed(0)}%</span></div>
					<div><span>amplitude</span><span>{(sea.nAmp * 100).toFixed(0)}%</span></div>
					<div><span>chop</span><span>{(sea.nChop * 100).toFixed(0)}%</span></div>
					<div class="good"><span>specular drive</span><span>{(sea.drive * 100).toFixed(0)}%</span></div>
				</div>
			</section>

			<!-- STAGED: baked into GLSL, needs the reload. -->
			{#each GROUP_NAMES as g (g)}
				{@const hits = groupHits(g)}
				{#if hits.length}
					{@const shown = sectionKnobs(g, search.trim() ? hits : open.has(g) ? hits : [])}
					{@const mods = knobNames(g).filter((k) => isModified(g, k)).length}
					<section class="grp">
						<h3>
							<button class="ghead" onclick={() => toggleGroup(g)}>
								<span class="caret">{search.trim() || open.has(g) ? '▾' : '▸'}</span>
								{g}
								<span class="dim">{hits.length}</span>
								{#if LIVE_GROUPS.has(g)}<span class="livetag">live</span>{/if}
								{#if mods}<span class="badge">{mods}</span>{/if}
							</button>
						</h3>

						{#each shown as k (k)}
							{#if k.startsWith(SECTION_MARK)}
								<div class="shead">{k.slice(1)}</div>
							{:else}
							{@const v = valueOf(g, k)}
							{#if RADIO_OPTIONS[`${g}.${k}`]}
								<div class="knob" class:staged={isStaged(g, k)}>
									<div class="head">
										<span class="name" class:mod={isModified(g, k)}>{k}</span>
									</div>
									<div class="radios">
										{#each RADIO_OPTIONS[`${g}.${k}`] as label, i (label)}
											<label class="radio">
												<input
													type="radio"
													name={`${g}.${k}`}
													checked={v === i}
													onchange={() => setKnob(g, k, i)}
												/>
												<span>{label}</span>
											</label>
										{/each}
									</div>
								</div>
							{:else if typeof v === 'boolean'}
								<label class="bool" class:staged={isStaged(g, k)}>
									<input
										type="checkbox"
										checked={v}
										onchange={(e) => setKnob(g, k, e.currentTarget.checked)}
									/>
									<span class="name" class:mod={isModified(g, k)}>{k}</span>
								</label>
							{:else}
								{@const def = TUNING_DEFAULTS[g][k] as number}
								{@const r = TUNING_RANGE[`${g}.${k}`] ?? rangeFor(def, v)}
								<div class="knob" class:staged={isStaged(g, k)}>
									<div class="head">
										<span class="name" class:mod={isModified(g, k)}>{k}</span>
										{#if isModified(g, k)}
											<button class="rev" title="Back to {show(def)}" onclick={() => revert(g, k)}
												>↺</button
											>
										{/if}
										<input
											class="num"
											type="number"
											step={r.step}
											value={show(v)}
											onchange={(e) => setKnob(g, k, +e.currentTarget.value)}
										/>
									</div>
									<input
										type="range"
										min={r.min}
										max={Math.max(r.max, v)}
										step={r.step}
										value={v}
										oninput={(e) => setKnob(g, k, +e.currentTarget.value)}
									/>
								</div>
							{/if}
							{/if}
						{/each}
					</section>
				{/if}
			{/each}
		</div>
	</div>
{/if}

<style>
	.shead {
		margin: 10px 0 2px;
		font-size: 10px;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: #6d8296;
	}

	.reveal,
	.panel {
		position: absolute;
		top: 0;
		right: 0;
		z-index: 20;
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 11px;
		color: #cfe0ee;
	}

	.reveal {
		margin: 8px;
		padding: 4px 8px;
		background: #10161dcc;
		border: 1px solid #2b3b4b;
		border-radius: 4px;
		color: #8fa6ba;
		cursor: pointer;
	}

	.panel {
		display: flex;
		flex-direction: column;
		width: 300px;
		height: 100%;
		/*
		 * Opaque, and NO backdrop-filter. A blur here reads as free but is
		 * not: the compositor has to re-blur whatever is behind the panel
		 * every time it changes, and what is behind it is a canvas
		 * repainting at 60fps. It cost real frame time for an effect that
		 * was invisible anyway under a 95%-opaque fill.
		 */
		background: #0b1118;
		border-left: 1px solid #22303e;
	}

	header {
		flex: none;
		padding: 8px;
		border-bottom: 1px solid #22303e;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.titlerow {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.titlerow strong {
		letter-spacing: 0.14em;
	}
	.dim {
		color: #6c8399;
		font-weight: 400;
	}
	.x {
		margin-left: auto;
		background: none;
		border: none;
		color: #6c8399;
		font-size: 15px;
		line-height: 1;
		cursor: pointer;
	}

	.actions {
		display: flex;
		gap: 4px;
	}
	.actions button {
		flex: 1;
		padding: 4px 0;
		background: #16202b;
		border: 1px solid #2b3b4b;
		border-radius: 3px;
		color: #b6cadb;
		font: inherit;
		cursor: pointer;
	}
	.actions button:hover:not(:disabled) {
		background: #1e2b39;
	}
	.actions button:disabled {
		opacity: 0.4;
		cursor: default;
	}
	.apply {
		flex: 2 !important;
	}
	.apply:not(:disabled) {
		background: #1d4a3a !important;
		border-color: #2f7357 !important;
		color: #b9f0d4 !important;
	}

	.search {
		width: 100%;
		padding: 3px 6px;
		background: #060a0f;
		border: 1px solid #2b3b4b;
		border-radius: 3px;
		color: inherit;
		font: inherit;
	}

	.note {
		margin: 0;
		color: #7f9ab0;
		line-height: 1.35;
	}

	.geom {
		margin: 2px 0 4px;
		padding: 4px 6px;
		background: #0d151d;
		border: 1px solid #1c2833;
		border-radius: 3px;
		font-variant-numeric: tabular-nums;
	}
	.geom div {
		display: flex;
		justify-content: space-between;
		gap: 8px;
		color: #7f9ab0;
	}
	.geom .good {
		color: #8fd4b4;
	}
	.geom .rule {
		margin-top: 3px;
		padding-top: 3px;
		border-top: 1px solid #1c2833;
		color: #55708a;
	}

	.help {
		margin: 1px 0 0;
		color: #5f7a90;
		font-size: 10px;
		line-height: 1.3;
	}

	.body {
		flex: 1;
		overflow-y: auto;
		overscroll-behavior: contain;
	}

	.grp {
		border-bottom: 1px solid #18242f;
	}
	.grp h3 {
		margin: 0;
		font-size: 11px;
		font-weight: 600;
	}
	.live h3 {
		padding: 6px 8px;
		letter-spacing: 0.1em;
		color: #8fd4b4;
	}
	.ghead {
		width: 100%;
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 6px 8px;
		background: none;
		border: none;
		color: #a9c1d4;
		font: inherit;
		font-weight: 600;
		letter-spacing: 0.08em;
		text-align: left;
		cursor: pointer;
	}
	.ghead:hover {
		background: #131d27;
	}
	.caret {
		color: #55708a;
	}
	.livetag {
		color: #8fd4b4;
		font-weight: 400;
	}

	.badge {
		margin-left: auto;
		padding: 0 5px;
		background: #33506b;
		border-radius: 7px;
		color: #d3e7f7;
	}

	.knob,
	.radios {
		display: flex;
		flex-wrap: wrap;
		gap: 2px 10px;
		margin: 2px 0 4px;
	}
	.radio {
		display: flex;
		align-items: center;
		gap: 4px;
		font-size: 11px;
		color: #9fb0c0;
		cursor: pointer;
	}
	.bool {
		display: block;
		padding: 3px 8px 5px;
	}
	.bool {
		display: flex;
		align-items: center;
		gap: 6px;
		cursor: pointer;
	}
	.knob.staged,
	.bool.staged {
		box-shadow: inset 2px 0 0 #d3a34a;
	}

	.head {
		display: flex;
		align-items: center;
		gap: 4px;
	}
	.name {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: #93aabe;
	}
	.name.mod {
		color: #ffd28a;
	}
	.rev {
		background: none;
		border: none;
		color: #6c8399;
		cursor: pointer;
		padding: 0 2px;
		font-size: 12px;
	}

	.num {
		width: 68px;
		padding: 1px 4px;
		background: #060a0f;
		border: 1px solid #24323f;
		border-radius: 3px;
		color: #e6f1fa;
		font: inherit;
		text-align: right;
		font-variant-numeric: tabular-nums;
	}
	.num.ro {
		border-color: transparent;
		background: none;
		color: #8fd4b4;
	}

	input[type='range'] {
		width: 100%;
		height: 12px;
		margin: 1px 0 0;
		accent-color: #4f8fbf;
		cursor: ew-resize;
	}
	input[type='checkbox'] {
		accent-color: #4f8fbf;
	}
</style>
