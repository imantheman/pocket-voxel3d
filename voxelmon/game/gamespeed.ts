// GAME SPEED: the port's fast-forward, a row on every game's OPTION screen
// (Red/Blue/Yellow's ui/optionsmenu.ts, Gold/Silver/Crystal's
// gen2/ui/OptionsMenu.ts). At 2X the game's logic -- walking, people, text,
// battle animations, menus, scripts -- runs two 60 Hz ticks for every one
// the host asks for, so everything happens twice as fast while the screen
// keeps its frame rate.
//
// The host is not told: it still calls frame() once per real 1/60 s (and
// renders after the last call of a frame), so the audio it renders on its
// own clock keeps the music at its pitch and tempo. Only the guest's logic
// loop multiplies, and only the last logic tick before the host renders
// composes the picture (stepHost below) -- the extra ticks cost logic, not
// drawing.
//
// gen1recomp's GAME SPEED works the same way (GameSpeed.lua: the fixed step
// run N times a frame, audio on its own real-time clock, a link at 1X on
// both machines). Its keys (`speed` on the Gen 2 path, `speedOverworld` /
// `speedBattle` / `speedMenu` on Gen 1) are left alone: this port saves its
// own `options.gameSpeed`, 1 or 2, so a save moving between the two keeps
// what each game set.
//
// THE API the OPTION / ENHANCEMENTS pages use: GAME_SPEEDS for the choices,
// gameSpeedOf(options) / setGameSpeedIn(options, n) on an options table, or
// the games' own game.gameSpeed() / game.setGameSpeed(n), which do the same
// on the game's options.

export const GAME_SPEEDS = [
  { key: 1, label: "1X" },
  { key: 2, label: "2X" },
] as const;

/** The row's label, kept here so a page can find the row by it. */
export const GAME_SPEED_LABEL = "SPEED";

/** The fastest the option goes. */
export const GAME_SPEED_MAX = 2;

/** options.gameSpeed -> 1 or 2 (1 when unset or anything else). */
export function gameSpeedOf(options: { gameSpeed?: unknown } | null | undefined): number {
  const v = Number(options?.gameSpeed);
  return v >= GAME_SPEED_MAX ? GAME_SPEED_MAX : 1;
}

/** The row's index into GAME_SPEEDS. */
export function gameSpeedIndex(options: { gameSpeed?: unknown } | null | undefined): number {
  return gameSpeedOf(options) - 1;
}

/** Set options.gameSpeed to `n`, clamped to a choice the row offers. */
export function setGameSpeedIn(options: { gameSpeed?: unknown }, n: unknown): number {
  const v = gameSpeedOf({ gameSpeed: n });
  options.gameSpeed = v;
  return v;
}

/**
 * Logic ticks per host step. The accumulator lets a speed between whole
 * numbers (a fallback's 1.5) average out: 1, 2, 1, 2, ... Never less than
 * one tick a step, so a speed of 1 is exactly the game as it always ran.
 */
export class SpeedStepper {
  private acc = 0;

  ticks(speed: number): number {
    const s = Number.isFinite(speed) && speed > 1 ? speed : 1;
    if (Number.isInteger(s)) {
      this.acc = 0;
      return s;
    }
    this.acc += s;
    const n = Math.floor(this.acc + 1e-9);
    this.acc -= n;
    return Math.max(1, n);
  }
}

/** A battle turn's frame budget for the guest, microseconds: past it the
 * host's 33 ms frame (the guest plus the screen's render and the host's own
 * work) is about to be missed. */
export const TURN_BUDGET = 25000;

/**
 * The fallback: 2X costs a second logic tick every step, and where a frame
 * was already near the budget (Gold's battles: their screen is most of the
 * frame) that tips it under 30 fps -- and a slow frame makes the host run
 * more steps the next, each now two ticks. The entry times its own frame()
 * calls (voxel.now, microseconds) and the logic ticks inside them, and
 * hands both here. While the guest's share of a rendered frame stays over
 * `high` on average AND the logic is a real part of it (`share`), SPEED
 * runs at 1.5X instead (one tick, two ticks, ...); it goes back to 2X once
 * the frame has been under `low`, or the logic a small part of it, for a
 * second. A frame the logic is not filling -- a screen whose drawing is the
 * cost -- keeps 2X: slowing the game there would buy nothing. A map load's
 * one long frame is clipped so it cannot trip it on its own. No clock (a
 * host without voxel.now): never engages.
 */
export class SpeedGovernor {
  /** The most SPEED may be right now. */
  cap = GAME_SPEED_MAX;
  /** Guest microseconds per rendered frame, smoothed; and the logic's part. */
  ema = 0;
  logicEma = 0;
  private acc = 0;
  private logicAcc = 0;
  private calm = 0;
  /** The last frame sampled was in a battle's turn (sample's `busy`). */
  private wasBusy = false;
  /** The longest logic tick in the frame being sampled. */
  private peakAcc = 0;

  constructor(
    readonly high = 18000,
    readonly low = 14000,
    private readonly onChange?: (cap: number, ema: number, logic: number) => void,
    readonly share = 0.35,
  ) {}

  /** One frame() call took `us`, `logicUs` of it in logic ticks; `shown`
   * when the host renders after it; `want` the speed asked for. `busy`
   * (a caller that says): a battle's turn is playing -- see TURN_BUDGET;
   * `peakUs` the longest single logic tick in the call. */
  sample(us: number, logicUs: number, shown: boolean, want: number, busy?: boolean, peakUs = 0): void {
    this.acc += us;
    this.logicAcc += logicUs;
    if (peakUs > this.peakAcc) this.peakAcc = peakUs;
    if (!shown) return;
    const peak = this.peakAcc;
    this.peakAcc = 0;
    const clip = this.high * 2;
    const raw = this.acc;
    const f = Math.min(this.acc, clip);
    const l = Math.min(this.logicAcc, f);
    this.acc = this.logicAcc = 0;
    this.ema = this.ema === 0 ? f : this.ema + (f - this.ema) / 16;
    this.logicEma = this.logicEma === 0 ? l : this.logicEma + (l - this.logicEma) / 16;
    // A battle's turn (a caller that passes `busy`): the frame rate first,
    // then as fast as it will go. One rendered frame whose guest time is over
    // the budget with the logic a real part of it steps SPEED down at once --
    // 2X, 1.5X, 1X -- and it stays down for the rest of the turn (no
    // waiting for an average: a turn is a few seconds, and every dropped
    // frame of it shows); the turn over, it is back to 2X.
    if (busy !== undefined && want > 1) {
      if (busy) {
        this.wasBusy = true;
        this.calm = 0;
        // (the logic fewer ticks would save: not the frame's longest tick --
        // a turn resolving is one big tick, there at any speed)
        if (raw > TURN_BUDGET && l - Math.min(peak, l) > f * this.share) this.set(this.cap > 1.5 ? 1.5 : 1);
        return;
      }
      if (this.wasBusy) {
        this.wasBusy = false;
        this.calm = 0;
        this.set(GAME_SPEED_MAX);
        return;
      }
    }
    const logicHeavy = this.logicEma > this.ema * this.share;
    if (want <= 1) {
      this.set(GAME_SPEED_MAX);
      this.calm = 0;
    } else if (this.cap > 1.5 && this.ema > this.high && logicHeavy) {
      this.set(1.5);
      this.calm = 0;
    } else if (this.cap < GAME_SPEED_MAX && (this.ema < this.low || this.logicEma < this.ema * (this.share - 0.1))) {
      if (++this.calm >= 30) {
        this.set(GAME_SPEED_MAX);
        this.calm = 0;
      }
    } else {
      this.calm = 0;
    }
  }

  /** `want` (logicSpeed) under the cap. */
  speed(want: number): number {
    return Math.min(want, this.cap);
  }

  private set(cap: number): void {
    if (cap === this.cap) return;
    this.cap = cap;
    this.onChange?.(cap, this.ema, this.logicEma);
  }
}

/**
 * One host step at `speed`: `tick(compose)` runs once per logic tick, and
 * compose is true on the last tick of the step and only when the host will
 * render after this step (`hostCompose`: voxel.lastStep, or the entry's own
 * guess on a host without it). Returns the ticks run.
 */
export function stepHost(
  stepper: SpeedStepper,
  speed: number,
  hostCompose: boolean,
  tick: (compose: boolean, i: number) => void,
): number {
  const n = stepper.ticks(speed);
  for (let i = 0; i < n; i++) tick(hostCompose && i === n - 1, i);
  return n;
}
