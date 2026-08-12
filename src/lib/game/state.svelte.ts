import { DAY_SECONDS } from './env';

/**
 * Module-level game state: survives navigation because the module stays
 * loaded for the life of the page. Only game modules import this; nothing
 * on the content routes touches it, so three.js and friends never leak
 * into their bundles.
 */
export const game = $state({
	/**
	 * Seconds into the 24-minute day. Starts mid-afternoon with the sun 45
	 * degrees above the horizon in the south-west (phase 0.604 on the env
	 * sun arc): crosswise to the isometric camera's view axis, so
	 * receivers show classic lit/shadow modeling. Phase 0.396 is the
	 * mirrored morning pose.
	 */
	time: DAY_SECONDS * 0.604,
	running: true
});
