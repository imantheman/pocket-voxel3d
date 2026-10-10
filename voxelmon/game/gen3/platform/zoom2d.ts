// pocket-voxel platform for the gen3 (FireRed) port (GPLv3 + additional terms;
// see LICENSE.md). VIEW 2D's 2D SCREEN and 2D ZOOM OUT rows, as the other
// games' OPTION screens have them (voxelmon/game/viewmode.ts): the field out
// to the top screen's edges (WIDE) rather than the GBA screen's box (NORMAL),
// and zoomed out round the same camera. Text boxes and menus keep the box.
// Saved with the options as options.screen2d ("normal" | "wide") and
// options.zoom2d (a ZOOMS_2D percent: the map's scale against the box's).
//
// The 3DS lays the GBA screen over the top screen at 1.5x (360x240 of its
// 400x240, centred). Zoomed out, the field is drawn into a canvas of its own
// at the GBA's pixels -- as much more of the map as the zoom shows -- and
// the host lays that canvas under the frame (g3FieldLayer, g3_render.c) at
// the zoom's scale; the frame keeps its text boxes and menus over it.
//
// The steps are the other games' where the scale comes out clean (MID: one
// map pixel to one of the screen's, crisp; FAR: three screen pixels to four;
// MAX: two map pixels to one, each screen pixel the even mix of a 2x2 block)
// -- their LOW (1.2x) and HIGH (0.9x) would smear unevenly here, so they are
// left out.

/** The box's scale: a GBA pixel is 1.5 of the top screen's (g3_render.c). */
export const BOX_SCALE = 1.5;
/** The top screen, and the box on it (x0..x1). */
export const SCREEN_W = 400;
export const SCREEN_H = 240;
export const BOX_X0 = 20;
export const BOX_X1 = 380;

export const SCREENS_2D = [
  { key: "normal", label: "NORMAL" },
  { key: "wide", label: "WIDE" },
] as const;

/** 2D ZOOM OUT's steps: the map's scale against the box's, percent (as
 *  viewmode.ts's), and the screen pixels a map pixel takes. */
export const ZOOMS_2D = [
  { pct: 100, label: "OFF", scale: 1.5 },
  { pct: 67, label: "MID", scale: 1 },
  { pct: 50, label: "FAR", scale: 0.75 },
  { pct: 33, label: "MAX", scale: 0.5 },
] as const;

export function screen2dIndex(v: unknown): number {
  return v === "wide" ? 1 : 0;
}

/** The ZOOMS_2D step `v` names; 0 (no zoom) for anything else. */
export function zoom2dIndex(v: unknown): number {
  const at = ZOOMS_2D.findIndex((z) => z.pct === v);
  return at >= 0 ? at : 0;
}

/** What the field's own canvas is, and where the host lays it. */
export interface Zoom2dSpec {
  /** The canvas: map pixels drawn (the camera centred on it as on the GBA's). */
  w: number;
  h: number;
  /** The screen rectangle it fills (400x240 units, the host's ortho). */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Screen pixels a map pixel takes. */
  scale: number;
  /** Shrunk (scale under 1): the host samples it filtered (2x2 even at MAX). */
  smooth: boolean;
}

/** The spec the options ask for, or null for the GBA screen as it is. */
export function zoom2dSpec(options: { screen2d?: unknown; zoom2d?: unknown } | null | undefined): Zoom2dSpec | null {
  const wide = screen2dIndex(options?.screen2d) === 1;
  const z = ZOOMS_2D[zoom2dIndex(options?.zoom2d)]!;
  if (!wide && z.pct === 100) return null;
  const x0 = wide ? 0 : BOX_X0, x1 = wide ? SCREEN_W : BOX_X1;
  // whole map pixels; the rectangle is then the canvas at the scale, centred
  // in the region (a fraction of a pixel short of its edges at most)
  const w = Math.ceil((x1 - x0) / z.scale);
  const h = Math.ceil(SCREEN_H / z.scale);
  const cx = (x0 + x1) / 2;
  return {
    w, h,
    x0: cx - (w * z.scale) / 2, x1: cx + (w * z.scale) / 2,
    y0: SCREEN_H / 2 - (h * z.scale) / 2, y1: SCREEN_H / 2 + (h * z.scale) / 2,
    scale: z.scale,
    smooth: z.scale < 1,
  };
}
