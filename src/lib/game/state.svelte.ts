import { DAY_SECONDS } from './env';

/**
 * Module-level game state: survives navigation because the module stays
 * loaded for the life of the page. Only game modules import this; nothing
 * on the content routes touches it, so three.js and friends never leak
 * into their bundles.
 */
export const game = $state({
	/** Seconds into the 24-minute day. Starts mid-morning. */
	time: DAY_SECONDS * 0.34,
	running: true
});
