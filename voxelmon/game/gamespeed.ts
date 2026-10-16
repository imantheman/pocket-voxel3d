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
