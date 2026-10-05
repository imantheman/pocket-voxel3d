// Port of gen1recomp src/core/game3/display.lua (GPLv3 + additional terms; see LICENSE.md).
// The Display module table's data fields (display.lua:5-15, 180, 363),
// split from display.ts for LOAD ORDER only. display.lua requires every
// heavy module lazily inside its functions; the port imports them statically,
// and several UI modules read `Display.TILE` at load (`local T =
// Display.TILE`) while being reached from those imports. The table therefore
// lives in this leaf, which display.ts imports first and re-exports (a live
// binding), so W/H/TILE/COLS/ROWS exist before any of them evaluates.
// display.ts attaches the functions. Import Display from display.ts.

import type { Canvas } from "../platform/image.ts";
import type { DisplayFns } from "./display.ts";

export interface DisplayData {
  W: number;
  H: number;
  TILE: number;
  COLS: number;
  ROWS: number;
  _canvas: Canvas | null;
  _uiOnly: Canvas | null;
  _logged: boolean;
  planesBroken: boolean;
  mirrorForTests: boolean;
}

export const Display = {
  W: 240,
  H: 160,
  TILE: 8,
  COLS: 30,
  ROWS: 20,

  _canvas: null,
  _uiOnly: null, // secondary canvas for UI layer when field is drawn by host
  _logged: false,

  // NOT FAITHFUL: false in the Lua. The plane path needs src/render/Renderer
  // (desktop-only, an inert stub here), so the 3DS starts on presentFlat,
  // the path Brian falls back to when the planes fail.
  planesBroken: true,

  // The plane path presents straight from Renderer's canvases; the flat 240x160
  // copy is only for test drivers that read Display._canvas back.
  mirrorForTests: false,
} as DisplayData as DisplayData & DisplayFns;

export default Display;
