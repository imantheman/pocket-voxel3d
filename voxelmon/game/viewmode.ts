// VIEW and BATTLES, the OPTION screen's 3D/2D switches (every game): 3D is
// the voxel world and the battles staged in it; 2D is the Game Boy screen as
// the cart drew it -- the map from above, and the flat battle screen. Saved
// as save.options.view / save.options.battleView ("3d" | "2d").

export const VIEW_MODES = [
  { key: "3d", label: "3D" },
  { key: "2d", label: "2D" },
] as const;

/** 0 for 3D (the default, and anything unknown), 1 for 2D. */
export function viewIndex(v: unknown): number {
  return v === "2d" ? 1 : 0;
}

export function is2d(v: unknown): boolean {
  return v === "2d";
}

// 2D SCREEN and 2D ZOOM OUT, VIEW 2D's own rows (every game): the map out to
// the top screen's edges (WIDE) rather than the Game Boy's box (NORMAL), and
// zoomed out round the same camera. Text boxes and menus keep the box.
// Saved as save.options.screen2d ("normal" | "wide") and
// save.options.zoom2d (a ZOOMS_2D percent).

export const SCREENS_2D = [
  { key: "normal", label: "NORMAL" },
  { key: "wide", label: "WIDE" },
] as const;

/** 2D ZOOM OUT's steps: the map's scale on the screen, percent. At 60 a
 *  Game Boy pixel is about one of the top screen's; FAR and MAX shrink the
 *  map below that (smoothed: the host's big canvas filters as it shrinks). */
export const ZOOMS_2D = [
  { pct: 100, label: "OFF" },
  { pct: 80, label: "LOW" },
  { pct: 67, label: "MID" },
  { pct: 60, label: "HIGH" },
  { pct: 50, label: "FAR" },
  { pct: 40, label: "MAX" },
] as const;

export function screen2dIndex(v: unknown): number {
  return v === "wide" ? 1 : 0;
}

/** The ZOOMS_2D step `v` names; 0 (no zoom) for anything else. */
export function zoom2dIndex(v: unknown): number {
  const at = ZOOMS_2D.findIndex((z) => z.pct === v);
  return at >= 0 ? at : 0;
}

/**
 * The picture the 2D options ask for, w x h map pixels, or null for the
 * Game Boy's own 160x144. NORMAL: the Game Boy's box at the zoom; WIDE: the
 * top screen's whole width, the box's pixel shape kept (the 3DS host lays
 * the 160x144 box over 302 of its 480 x 272 ortho units).
 */
export function canvasSize(options: { screen2d?: unknown; zoom2d?: unknown } | null | undefined):
    { w: number; h: number; wide: boolean } | null {
  const wide = screen2dIndex(options?.screen2d) === 1;
  const z = ZOOMS_2D[zoom2dIndex(options?.zoom2d)]!.pct / 100;
  if (!wide && z === 1) return null;
  const h = Math.round(144 / z);
  return { w: Math.round(wide ? (h * 480) / 272 : 160 / z), h, wide };
}
