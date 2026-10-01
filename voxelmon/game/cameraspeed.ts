// CAMERA SPEED, the OPTION screen's row for how fast the C-stick swings the
// 3D view: the Q8 multiplier the host applies to its own tuned rates (256 =
// as tuned; spec `camSpeed`). A port row in every game's options (Red/Blue/
// Yellow's optionsmenu.ts, Gold's OptionsMenu.ts), saved as
// save.options.cameraSpeed under these keys -- the Game Boy had no camera.

export const CAMERA_SPEEDS = [
  { key: "slow", label: "SLOW", q8: 128 },
  { key: "normal", label: "NORMAL", q8: 256 },
  { key: "fast", label: "FAST", q8: 448 },
] as const;
export const CAMERA_SPEED_DEFAULT_Q8 = 256;

/** The row's index for save.options.cameraSpeed (NORMAL when unset). */
export function cameraSpeedIndex(v: unknown): number {
  const at = CAMERA_SPEEDS.findIndex((s) => s.key === v);
  return at >= 0 ? at : 1;
}

/** save.options.cameraSpeed -> the host's Q8 multiplier. */
export function cameraSpeedQ8(v: unknown): number {
  return CAMERA_SPEEDS.find((s) => s.key === v)?.q8 ?? CAMERA_SPEED_DEFAULT_Q8;
}
