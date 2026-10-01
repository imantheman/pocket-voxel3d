// TILT SHIFT, the OPTION screen's miniature look: the host blurs the top and
// bottom of the 3D world and leaves a sharp band across the middle, so the
// voxel towns read like a model railway shot close up. A port row in every
// game's options (Red/Blue/Yellow's optionsmenu.ts, Gold's OptionsMenu.ts),
// saved as save.options.tiltShift under these keys and stated to the host
// every frame as the level (spec `tiltShift`).

export const TILT_SHIFTS = [
  { key: "off", label: "OFF" },
  { key: "soft", label: "SOFT" },
  { key: "strong", label: "STRONG" },
] as const;

/** save.options.tiltShift -> the host's level: 0 off, 1 soft, 2 strong. */
export function tiltShiftLevel(v: unknown): number {
  const at = TILT_SHIFTS.findIndex((t) => t.key === v);
  return at >= 0 ? at : 0;
}
