// pocket-voxel platform for the gen3 (FireRed) port (GPLv3 + additional terms;
// see LICENSE.md). love.timer. The game runs a fixed 60 Hz step (Brian's
// FixedStep); the host ticks it, so the delta is a step.

import { getHost } from "./host.ts";

export const STEP = 1 / 60;

/** love.timer.getTime(): seconds, monotonic. */
export function getTime(): number { return getHost().now(); }
/** love.timer.getDelta(): NOT FAITHFUL -- the fixed step, not the measured frame. */
export function getDelta(): number { return STEP; }
/** love.timer.getFPS(): NOT FAITHFUL -- the step rate. */
export function getFPS(): number { return 60; }

export const Timer = { getTime, getDelta, getFPS, STEP };
export default Timer;
