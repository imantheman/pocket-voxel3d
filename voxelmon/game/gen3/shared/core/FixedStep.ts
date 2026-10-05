// Port of gen1recomp src/core/FixedStep.lua (GPLv3 + additional terms; see LICENSE.md).
// Fixed-step update loop at the Game Boy's ~60Hz. Game logic advances in
// whole steps regardless of the display refresh rate, which keeps movement,
// text speed and battle timing deterministic.
//
// Brian's FixedStep is one module table whose colon methods all run on it
// (`FixedStep:init(cb)`), so here it is one object: the class below and its
// single instance `FixedStep`. The work clock (love.timer.getTime) is
// platform/timer.ts's.

import { getTime } from "../../platform/timer.ts";
import { hasHost } from "../../platform/host.ts";
import { len, remove, sort } from "../../platform/lt.ts";
import { mod } from "../../../../import/gen3/lua.ts";

// Lua: FixedStep.lua:12 (local MAX_ACCUM = FixedStep.MAX_ACCUM)
const MAX_ACCUM = 0.25;
const SMOOTH_FRAMES = 4;
let SMOOTH_MAX = 1 / 60 * 2.5;
let STEP_EPS = 1 / 60 * 0.02;

// Lua: FixedStep.lua:37
const RESEED_PHASE = 0.5;
const PHASE_PROBE = 600;

// Lua: FixedStep.lua:43
function phaseOffset(period: number, step: number): number {
  const residuals: (number | null)[] = [null];
  const seen: Record<number, boolean> = {};
  let accum = 0;
  for (let n = 1; n <= PHASE_PROBE; n++) {
    accum = accum + period;
    while (accum >= step - STEP_EPS) accum = accum - step;
    const key = Math.floor(accum / step * 1e6 + 0.5);
    if (seen[key]) break;
    seen[key] = true;
    residuals[len(residuals) + 1] = accum;
  }
  if (len(residuals) === 0) return 0;
  sort<number>(residuals);
  let bestGap = -1, bestCentre = 0;
  const n = len(residuals);
  for (let i = 1; i <= n; i++) {
    const a = residuals[i]!;
    const b = (i < n) ? residuals[i + 1]! : (residuals[1]! + step);
    if (b - a > bestGap) { bestGap = b - a; bestCentre = (a + b) * 0.5; }
  }
  return mod(step - bestCentre, step);
}

export class FixedStepModule {
  GB_HZ = 4194304 / 70224;
  STEP = 1 / 60;
  MAX_ACCUM = 0.25;
  WORK_FRACTION = 0.75;
  /** A work clock override (seconds); undefined means love.timer.getTime. */
  clock: (() => number) | undefined = undefined;
  refreshPeriod: number | undefined = undefined;
  maxAccum: number | undefined = MAX_ACCUM;
  phasedFor: number | undefined = undefined;

  accum = 0;
  callback: ((dt: number) => void) | undefined = undefined;
  suppressCatchup = false;
  dtHistory: (number | null)[] | undefined = undefined;
  dtSum = 0;
  frameBreak = false;

  // Lua: FixedStep.lua:17
  setHz(hz: unknown): number {
    let n = typeof hz === "number" ? hz : Number(hz);
    if (!(n > 0)) n = 60;
    this.STEP = 1 / n;
    SMOOTH_MAX = this.STEP * 2.5;
    STEP_EPS = this.STEP * 0.02;
    this.phasedFor = undefined;
    return n;
  }

  // Lua: FixedStep.lua:64
  init(callback: (dt: number) => void): void {
    this.accum = 0;
    this.callback = callback;
    this.suppressCatchup = false;
    this.dtHistory = undefined;
    this.dtSum = 0;
    this.phasedFor = undefined;
    this.frameBreak = false;
  }

  // Lua: FixedStep.lua:75
  catchupLimit(speed: unknown, dt: unknown): number {
    let s = Number(speed);
    if (speed == null || Number.isNaN(s)) s = 1;
    if (s < 1) s = 1;
    const step = this.STEP;
    let frame = dt == null || Number.isNaN(Number(dt)) ? step : Number(dt);
    if (frame !== frame || frame < step || frame > SMOOTH_MAX) frame = step;
    let target = s * frame * 1.5;
    const floor = step * 2;
    if (target < floor) target = floor;
    return target;
  }

  // Lua: FixedStep.lua:87
  private workBudget(dt: number): number {
    const base = this.refreshPeriod ?? this.STEP;
    let frame = dt;
    if (frame < base) frame = base;
    if (frame > this.STEP * 2) frame = Math.max(base, this.STEP * 2);
    return frame * this.WORK_FRACTION;
  }

  // Lua: FixedStep.lua:95
  private workClock(): (() => number) | undefined {
    if (this.clock) return this.clock;
    return hasHost() ? getTime : undefined;
  }

  // Lua: FixedStep.lua:101
  update(dt: number, speedIn?: unknown): void {
    this.frameBreak = false;
    if (this.suppressCatchup) {
      this.suppressCatchup = false;
      this.dtHistory = undefined;
      this.dtSum = 0;
      this.accum = this.STEP * RESEED_PHASE;
      this.callback!(this.STEP);
      this.frameBreak = false;
      return;
    }
    let speed = Number(speedIn);
    if (speedIn == null || Number.isNaN(speed)) speed = 1;
    if (speed < 1) speed = 1;
    if (dt > MAX_ACCUM) dt = MAX_ACCUM;
    const frameDt = dt;
    const period = this.refreshPeriod;
    let snapped = false;
    if (period && dt > 0) {
      const frames = Math.floor(dt / period + 0.5);
      if (frames >= 1 && frames * period <= SMOOTH_MAX
        && Math.abs(frames * period - dt) < period * 0.25) {
        dt = frames * period;
        snapped = true;
      }
    }
    if (snapped) {
      this.dtHistory = undefined;
      this.dtSum = 0;
    } else if (dt > 0 && dt <= SMOOTH_MAX) {
      let hist = this.dtHistory;
      if (!hist) { hist = [null]; this.dtHistory = hist; this.dtSum = 0; }
      hist[len(hist) + 1] = dt;
      this.dtSum = this.dtSum + dt;
      if (len(hist) > SMOOTH_FRAMES) {
        this.dtSum = this.dtSum - hist[1]!;
        remove(hist, 1);
      }
      dt = this.dtSum / len(hist);
    } else {
      this.dtHistory = undefined;
      this.dtSum = 0;
    }
    if (period && this.phasedFor !== period) {
      this.phasedFor = period;
      const target = phaseOffset(period, this.STEP);
      this.accum = this.accum - mod(this.accum, this.STEP) + target;
    }
    this.accum = Math.min(this.accum + dt * speed, this.maxAccum || MAX_ACCUM);
    const clock = speed > 1 ? this.workClock() : undefined;
    const deadline = clock ? (clock() + this.workBudget(frameDt)) : undefined;
    while (this.accum >= this.STEP - STEP_EPS) {
      this.accum = this.accum - this.STEP;
      this.callback!(this.STEP);
      if (this.frameBreak) {
        this.frameBreak = false;
        this.accum = mod(this.accum, this.STEP);
        break;
      }
      if (deadline !== undefined && this.accum >= this.STEP - STEP_EPS && clock!() >= deadline) {
        this.accum = mod(this.accum, this.STEP);
        break;
      }
    }
  }

  // Lua: FixedStep.lua:173
  endFrame(): void {
    this.frameBreak = true;
  }

  // Lua: FixedStep.lua:182
  discardCatchup(): void {
    this.accum = 0;
    this.suppressCatchup = true;
  }
}

export const FixedStep = new FixedStepModule();
export default FixedStep;
