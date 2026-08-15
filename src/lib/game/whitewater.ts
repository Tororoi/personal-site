/**
 * Shared lighting for every WHITE WATER surface: foam, foam sprites,
 * crest plumes and splash droplets.
 *
 * White water is not paint. It is a dense froth of air bubbles with an
 * albedo near 0.9, so it scatters light many times before releasing it:
 * it returns the light's BRIGHTNESS while keeping its own whiteness,
 * gathers from the entire sky dome rather than just the sun, and stays
 * visibly pale long after the sea around it has gone dark.
 *
 * The ambient/direct split is not fixed — it follows the sun's
 * diffusion, because cloud converts direct sunlight into sky radiance.
 * An overcast storm is lit almost entirely by the dome (flat, shadow-
 * less); a clear calm day is mostly direct (crisp relief).
 *
 * Requires these uniforms in the host material: uSkyZenith, uSkyHorizon,
 * uSunColor, uSunI, uSunDir, uSunDiffusion — plus uFogColor, which
 * doubles as the colour of the sea below for hemisphere ambient.
 */

import { f, FOAM } from './tuning'

export function whitewaterLightGlsl(): string {
  return `
/**
 * @param albedo   the material's own colour (near-white for foam)
 * @param nrm      surface normal; pass vec3(0,1,0) for flat sprites
 * @param shapeAmt 0 = no directional relief (2D sprites), 1 = full
 */
vec3 whitewaterLight(vec3 albedo, vec3 nrm, float shapeAmt) {
	// HEMISPHERE ambient. Sampling the sky gradient by the normal was
	// wrong for a diffuse body: it made DOWN-facing surfaces pick up the
	// bright horizon and up-facing ones the darker zenith, so droplets
	// were lit from below. A diffuse surface integrates its whole
	// visible hemisphere — up-facing sees the sky, down-facing sees the
	// dark sea. (uFogColor stands in for the water below; every host
	// material already declares it.)
	float up = clamp(nrm.y * 0.5 + 0.5, 0.0, 1.0);
	vec3 domeAvg = mix(uSkyHorizon, uSkyZenith, 0.65);
	vec3 sky = mix(uFogColor * 0.55, domeAvg, up);
	float wrap = clamp((dot(nrm, normalize(uSunDir)) + 0.45) / 1.45, 0.0, 1.0);
	float shape = mix(1.0, wrap, shapeAmt);
	// Cloud turns direct sun into sky light: diffusion IS the split.
	float diff = clamp(uSunDiffusion + ${f(FOAM.diffuseBase)}, 0.0, 1.0);
	// Ambient arrives from everywhere, so only the DIRECT term is shaded.
	vec3 recv =
		sky * (${f(FOAM.skyGain)} * diff)
		+ uSunColor * (${f(FOAM.sunGain)} * (1.0 - diff) * uSunI * shape);
	// Multiple scattering washes out hue: take the luminance, and only a
	// little of the chroma.
	float lum = dot(recv, vec3(0.2126, 0.7152, 0.0722));
	vec3 tinted = mix(vec3(lum), recv, ${f(FOAM.lightTint)});
	// Never fully dark: white water is the last thing on the sea to go.
	return albedo * max(tinted, vec3(${f(FOAM.darkFloor)}));
}`
}

/** The uniform names whitewaterLight() reads, for wiring materials. */
export const WHITEWATER_UNIFORM_DECLS = `
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform vec3 uSunColor;
uniform float uSunI;
uniform vec3 uSunDir;
uniform float uSunDiffusion;`
