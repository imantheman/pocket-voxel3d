// Port of gen1recomp src/ui/game3/map_name_popup.lua (GPLv3 + additional terms; see LICENSE.md).
// 1:1 FireRed Map Name Popup Overlay (pokefirered/src/map_name_popup.c)
// Slides down from top-left on area/map transitions when showMapName == 1.
//
// Lua's `package.loaded["src.X"]` / `pcall(require, "src.X")` become the
// static imports below; Brian's `X and X.f` guards are kept. The Emerald
// theme (`Rse`, used when Profile.family() == "rse") keeps its state machine;
// the parts that need src/ui/game3/rse/* or src/core/game3/rse/* (not part of
// the FRLG port, no stubs) throw "NOT FAITHFUL: Emerald only".

/* eslint-disable @typescript-eslint/no-explicit-any */

import { format, tonumber, truthy } from "../../../import/gen3/lua.ts";
import { gsub } from "../platform/lpattern.ts";
import { ipairs, seq, insert } from "../platform/lt.ts";
import { G } from "../platform/graphics.ts";
import type { Image, Quad } from "../platform/image.ts";
import { FrlgFont, type Colors } from "./frlg_font.ts";
import { Chrome } from "./chrome.ts";
import { MapSectionsExtract } from "../../../import/gen3/map_sections_extract.ts";
import { Strings } from "../shared/core/Strings.ts";
import { RomText } from "../core/rom_text.ts";
import { Space } from "../core/scripting/space.ts";
import { Flags } from "../core/scripting/flags.ts";
import { Runtime } from "../core/runtime.ts";
import { Profile } from "../core/profile.ts";
import { Constants, type ConstantSet } from "../core/constants.ts";

/** Lua `a or b`: only nil and false fall through. */
function lor<A, B>(a: A, b: B): Exclude<A, null | undefined | false> | B {
  return a == null || (a as unknown) === false ? b : a as Exclude<A, null | undefined | false>;
}

// State Machine Constants
const STATE_IDLE = 0;
const STATE_SLIDE_IN = 1;
const STATE_HOLD = 2;
const STATE_SLIDE_OUT = 3;

// pokefirered/include/constants/flags.h:1530
const FLAG_DONT_SHOW_MAP_NAME_POPUP = 0x4000;

// pokefirered/src/map_name_popup.c:30
// Lua: map_name_popup.lua:43
function isFlagSuppressed(): boolean {
  const store = Space && Space.store;
  if (store && Flags && Flags.getFlag) {
    if (Flags.getFlag(store, null, FLAG_DONT_SHOW_MAP_NAME_POPUP)) return true;
  }
  const session = Runtime && Runtime.getSession && Runtime.getSession();
  if (session && session.flags && truthy(session.flags[FLAG_DONT_SHOW_MAP_NAME_POPUP])) {
    return true;
  }
  return false;
}

// pokeemerald/src/map_name_popup.c:219
const RSE_PRINT = 6, RSE_SLIDE_IN = 0, RSE_WAIT = 1, RSE_SLIDE_OUT = 2, RSE_ERASE = 4, RSE_END = 5;

export interface RseTask { state: number; yOffset: number; printTimer: number; onscreen: number; incoming: boolean }
export interface RseWindow {
  sec: number; theme: string; name: string; textX: number;
  bitmap: Image; outline: Image; colors: Colors;
}

// Lua: map_name_popup.lua:74
function themed(): boolean {
  // pcall(require, "src.core.game3.profile"): always loads here.
  return Profile.family() === "rse";
}

// Lua: map_name_popup.lua:79
function rseConstants(): ConstantSet {
  return Constants.of(Profile.forSession().id);
}

// Lua: map_name_popup.lua:84
function rseHidden(): boolean {
  const id = rseConstants().flag("FLAG_HIDE_MAP_NAME_POPUP");
  if (Space && Space.store && Flags && Flags.getFlag) {
    return Flags.getFlag(Space.store, null, id) === true;
  }
  const session = Runtime && Runtime.getSession && Runtime.getSession();
  return (session && session.flags && session.flags[id] === true) || false;
}

// Lua: map_name_popup.lua:98
// NOT FAITHFUL: Emerald only. The themed popup bitmap comes from
// src.ui.game3.rse.mapsec / rse.scene_kit, which are not part of the FRLG port.
function idxImage(theme: string, suffix: string, _pal: unknown): Image {
  throw new Error("NOT FAITHFUL: Emerald only: map popup image " + theme + suffix + " (src.ui.game3.rse.mapsec)");
}

// pokeemerald/src/map_name_popup.c:382
const FRAME_TILES: ((number | null)[] | null)[] = seq();
for (let i = 0; i <= 11; i++) insert(FRAME_TILES, seq(i, i, 0));
insert(FRAME_TILES, seq(12, 0, 1));
insert(FRAME_TILES, seq(13, 11, 1));
insert(FRAME_TILES, seq(14, 0, 2));
insert(FRAME_TILES, seq(15, 11, 2));
insert(FRAME_TILES, seq(16, 0, 3));
insert(FRAME_TILES, seq(17, 11, 3));
for (let i = 0; i <= 11; i++) insert(FRAME_TILES, seq(18 + i, i, 4));

// pokeemerald/src/map_name_popup.c:335
// Lua: map_name_popup.lua:136
// NOT FAITHFUL: Emerald only. It reads the section's theme, name and palettes
// through src.ui.game3.rse.mapsec and the pyramid / secret base systems of
// src.core.game3.rse.init, none of which are part of the FRLG port.
// (It would build Rse.window with idxImage(theme, "", pal) / idxImage(theme, "_outline", pal).)
function rsePrint(): void {
  throw new Error("NOT FAITHFUL: Emerald only: map popup print (src.ui.game3.rse.mapsec)");
}

// pokeemerald/include/constants/map_types.h:13
const MAP_TYPE_SECRET_BASE = 9;

const Rse = {
  // pokeemerald/src/map_name_popup.c:219
  STATE: {
    PRINT: RSE_PRINT, SLIDE_IN: RSE_SLIDE_IN, WAIT: RSE_WAIT,
    SLIDE_OUT: RSE_SLIDE_OUT, ERASE: RSE_ERASE, END: RSE_END,
  },
  // pokeemerald/src/map_name_popup.c:222
  OFFSCREEN_Y: 40,
  SLIDE_SPEED: 2,
  task: undefined as RseTask | undefined,
  def: undefined as any,
  window: undefined as RseWindow | undefined,
  FRAME_TILES,
  _quad: undefined as Quad | undefined,

  // pokeemerald/src/map_name_popup.c:231
  // Lua: map_name_popup.lua:180
  show(mapDef: any, _opts?: any): boolean {
    if (rseHidden()) return false;
    // pokeemerald/src/secret_base.c:453
    if (mapDef && tonumber(mapDef.mapType) === MAP_TYPE_SECRET_BASE) {
      // NOT FAITHFUL: Emerald only (R.var("VAR_INIT_SECRET_BASE") through src.core.game3.rse.init).
      throw new Error("NOT FAITHFUL: Emerald only: secret base popup (src.core.game3.rse.init)");
    }
    Rse.def = mapDef;
    const t = Rse.task;
    if (!t) {
      Rse.task = { state: RSE_PRINT, yOffset: Rse.OFFSCREEN_Y, printTimer: 0, onscreen: 0, incoming: false };
    } else {
      if (t.state !== RSE_SLIDE_OUT) t.state = RSE_SLIDE_OUT;
      t.incoming = true;
    }
    return true;
  },

  // pokeemerald/src/map_name_popup.c:254
  // Lua: map_name_popup.lua:199
  frame(): void {
    const t = Rse.task;
    if (!t) return;
    if (t.state === RSE_PRINT) {
      t.printTimer = t.printTimer + 1;
      if (t.printTimer > 30) {
        t.state = RSE_SLIDE_IN;
        t.printTimer = 0;
        rsePrint();
      }
    } else if (t.state === RSE_SLIDE_IN) {
      t.yOffset = t.yOffset - Rse.SLIDE_SPEED;
      if (t.yOffset <= 0) {
        t.yOffset = 0;
        t.state = RSE_WAIT;
        t.onscreen = 0;
      }
    } else if (t.state === RSE_WAIT) {
      t.onscreen = t.onscreen + 1;
      if (t.onscreen > 120) {
        t.onscreen = 0;
        t.state = RSE_SLIDE_OUT;
      }
    } else if (t.state === RSE_SLIDE_OUT) {
      t.yOffset = t.yOffset + Rse.SLIDE_SPEED;
      if (t.yOffset >= Rse.OFFSCREEN_Y) {
        t.yOffset = Rse.OFFSCREEN_Y;
        if (t.incoming) {
          t.state = RSE_PRINT;
          t.printTimer = 0;
          t.incoming = false;
        } else {
          t.state = RSE_ERASE;
        }
      }
    } else if (t.state === RSE_ERASE) {
      Rse.window = undefined;
      t.state = RSE_END;
    } else if (t.state === RSE_END) {
      Rse.dismiss();
    }
  },

  // pokeemerald/src/map_name_popup.c:319
  // Lua: map_name_popup.lua:243
  dismiss(): void {
    Rse.task = undefined;
    Rse.window = undefined;
  },

  // Lua: map_name_popup.lua:248
  update(dt?: number): void {
    const step = Math.max(1, Math.floor(((dt ?? (1 / 60)) * 60) + 0.5));
    for (let n = 1; n <= step; n++) {
      if (!Rse.task) return;
      Rse.frame();
    }
  },

  // Lua: map_name_popup.lua:256
  draw(): void {
    const t = Rse.task, w = Rse.window;
    if (!(t && w) || t.yOffset >= Rse.OFFSCREEN_Y) return;
    const oy = -t.yOffset;
    G.setColor(1, 1, 1, 1);
    const q = Rse._quad ?? G.newQuad(0, 0, 8, 8, 80, 24);
    Rse._quad = q;
    for (const [, e] of ipairs<(number | null)[]>(FRAME_TILES)) {
      q.setViewport((e[1]! % 10) * 8, Math.floor(e[1]! / 10) * 8, 8, 8, 80, 24);
      G.draw(w.outline, q, e[2]! * 8, oy + e[3]! * 8);
    }
    G.draw(w.bitmap, 8, oy + 8);
    FrlgFont.draw(w.name, 8 + w.textX, oy + 8 + 3, { font: "narrow", colors: w.colors, maxWidth: 80 });
    G.setColor(1, 1, 1, 1);
  },
};

/** Format clean fallback name from mapId if somehow unresolved */
// Lua: map_name_popup.lua:273
function cleanMapName(mapId: unknown): string {
  if (typeof mapId !== "string" || mapId === "") return "KANTO";
  let s = gsub(gsub(mapId, "^FR_", "")[0], "^SEVII_", "")[0];
  s = gsub(s, "(%l)(%u)", "%1 %2")[0];
  s = gsub(s, "(%a)(%d)", "%1 %2")[0];
  s = gsub(s, "(%d)(%a)", "%1 %2")[0];
  s = gsub(gsub(s, "_", " ")[0], "%s+", " ")[0].toUpperCase();
  return s;
}

/**
 * Trigger map name popup display
 * The section names are the cart's English, with the floor label
 * map_name_popup.c appends.  Both go through Strings(): the floor as a whole
 * label ("3F", "B1F", "ROOFTOP", the cart's gText_3F... rows), since the
 * European carts count floors differently (3F is "2E" in French).
 */
// Lua: map_name_popup.lua:288
function translated_name(info: { rawName?: string; name: string; floorNum?: unknown }): string {
  const base = Strings(lor(info.rawName, info.name));
  const floor = tonumber(info.floorNum) ?? 0;
  // pokefirered/src/map_name_popup.c:211
  if (floor === 127) return base + " " + RomText.plain("gText_Rooftop2");
  let label: string | undefined;
  if (floor < 0) label = format("B%dF", -floor);
  else if (floor > 0) label = format("%dF", floor);
  if (!label) return base;
  return base + " " + Strings(label);
}

export interface PopupOpts { force?: unknown }

export const MapNamePopup = {
  STATE: {
    IDLE: STATE_IDLE,
    SLIDE_IN: STATE_SLIDE_IN,
    HOLD: STATE_HOLD,
    SLIDE_OUT: STATE_SLIDE_OUT,
  },

  _state: STATE_IDLE,
  _tPos: 0, // 0..24 pixels (Love2D Y = _tPos - 24)
  _timer: 0, // frame counter for hold state
  _reshow: false,
  _pendingName: undefined as string | undefined,
  _pendingWidthTiles: 14 as number | undefined,
  _pendingWidth: 112 as number | undefined,

  // Active banner properties
  _name: "",
  _widthTiles: 14,
  _contentWidth: 112, // 14 tiles * 8px
  _floorNum: 0,

  Rse,

  // Lua: map_name_popup.lua:300
  show(mapDef: any, opts?: PopupOpts | null): boolean {
    opts = opts || {};
    if (themed()) return Rse.show(mapDef, opts);
    if (isFlagSuppressed()) return false;

    // Strict indoor suppression: showMapName must be 1/true unless forced by opts
    if (!truthy(opts.force)) {
      const showFlag = mapDef ? lor(mapDef.showMapName, mapDef.show_map_name) : mapDef;
      if (showFlag === 0 || showFlag === false) {
        MapNamePopup.dismiss();
        return false;
      }
    }

    const secId = mapDef ? lor(lor(mapDef.regionMapSectionId, mapDef.region_map_section_id), mapDef.mapsec) : mapDef;
    const mapId = mapDef ? lor(lor(mapDef.id, mapDef.name), mapDef.map) : mapDef;
    const floorNum = lor(mapDef ? lor(lor(mapDef.floorNum, mapDef.floor_num), mapDef.floor) : mapDef, 0);

    const info = MapSectionsExtract.getInfo(secId, mapId, floorNum);
    let name: string | undefined = info && info.name;
    // getInfo answers with the Pallet Town placeholder for a map it could not
    // identify (resolved == false).  Treat that as "no name" so the popup shows
    // the cleaned map id instead of a place the map is not.
    if (!name || name === "???" || name === "" || (info && info.resolved === false)) {
      name = cleanMapName(mapId);
    } else {
      name = translated_name(info);
    }

    // Calculate width matching pokefirered MapNamePopupCreateWindow:
    // Floor == 0: width = 14 (112px content)
    // Floor != 0 and Floor != 127: width = 19 (152px content)
    // Floor == 127 (Rooftop): width = 22 (176px content)
    let widthTiles = 14;
    let contentW = 112;
    const floor: number = lor(lor(tonumber(floorNum), info ? info.floorNum : undefined), 0);
    if (floor !== 0) {
      if (floor === 127) {
        widthTiles = 22;
        contentW = 176;
      } else {
        widthTiles = 19;
        contentW = 152;
      }
    }

    if (MapNamePopup._state === STATE_IDLE) {
      MapNamePopup._name = name;
      MapNamePopup._widthTiles = widthTiles;
      MapNamePopup._contentWidth = contentW;
      MapNamePopup._floorNum = floor;
      MapNamePopup._tPos = 0;
      MapNamePopup._timer = 0;
      MapNamePopup._reshow = false;
      MapNamePopup._state = STATE_SLIDE_IN;
    } else {
      // If already active, trigger reshow: slide up and reload text
      MapNamePopup._pendingName = name;
      MapNamePopup._pendingWidthTiles = widthTiles;
      MapNamePopup._pendingWidth = contentW;
      MapNamePopup._reshow = true;
      if (MapNamePopup._state !== STATE_SLIDE_OUT) {
        MapNamePopup._state = STATE_SLIDE_OUT;
      }
    }

    return true;
  },

  /** Dismiss active popup immediately (e.g. on dialogue open, battle, or indoor warp) */
  // Lua: map_name_popup.lua:370
  dismiss(): void {
    Rse.dismiss();
    if (MapNamePopup._state !== STATE_IDLE) {
      MapNamePopup._state = STATE_IDLE;
      MapNamePopup._tPos = 0;
      MapNamePopup._timer = 0;
      MapNamePopup._reshow = false;
      MapNamePopup._pendingName = undefined;
    }
  },

  /** Check if popup is currently visible/animating */
  // Lua: map_name_popup.lua:382
  isActive(): boolean {
    return MapNamePopup._state !== STATE_IDLE || Rse.task != null;
  },

  /** Frame tick (60 FPS / dt-based) */
  // Lua: map_name_popup.lua:387
  update(dt?: number): void {
    if (Rse.task) Rse.update(dt);
    if (MapNamePopup._state === STATE_IDLE) return;

    // Fixed-step 60 FPS increments (or accumulated sub-frames)
    const step = Math.max(1, Math.floor(((dt ?? (1 / 60)) * 60) + 0.5));

    for (let n = 1; n <= step; n++) {
      if (MapNamePopup._state === STATE_SLIDE_IN) {
        // pokefirered/src/map_name_popup.c:66: task->tPos -= 2 (slide down 2px per frame)
        MapNamePopup._tPos = MapNamePopup._tPos + 2;
        if (MapNamePopup._tPos >= 24) {
          MapNamePopup._tPos = 24;
          MapNamePopup._state = STATE_HOLD;
          MapNamePopup._timer = 0;
        }
      } else if (MapNamePopup._state === STATE_HOLD) {
        // pokefirered/src/map_name_popup.c:75: hold for 120 frames (2.0 seconds)
        MapNamePopup._timer = MapNamePopup._timer + 1;
        if (MapNamePopup._timer > 120) {
          MapNamePopup._timer = 0;
          MapNamePopup._state = STATE_SLIDE_OUT;
        }
      } else if (MapNamePopup._state === STATE_SLIDE_OUT) {
        // pokefirered/src/map_name_popup.c:82: slide back up 2px per frame
        MapNamePopup._tPos = MapNamePopup._tPos - 2;
        if (MapNamePopup._tPos <= 0) {
          MapNamePopup._tPos = 0;
          if (MapNamePopup._reshow && MapNamePopup._pendingName) {
            MapNamePopup._name = MapNamePopup._pendingName;
            MapNamePopup._widthTiles = MapNamePopup._pendingWidthTiles ?? 14;
            MapNamePopup._contentWidth = MapNamePopup._pendingWidth ?? 112;
            MapNamePopup._pendingName = undefined;
            MapNamePopup._reshow = false;
            MapNamePopup._state = STATE_SLIDE_IN;
          } else {
            MapNamePopup._state = STATE_IDLE;
            return;
          }
        }
      }
    }
  },

  /** Draw 1:1 FireRed location banner */
  // Lua: map_name_popup.lua:432
  draw(): void {
    if (Rse.task) Rse.draw();
    if (MapNamePopup._state === STATE_IDLE || MapNamePopup._tPos <= 0) {
      return;
    }

    const tPos = MapNamePopup._tPos;
    // Love2D coordinate translation: base Y sits at tPos - 24
    // When tPos = 0: py = -24 (offscreen above viewport)
    // When tPos = 24: py = 0 (flush against top bezel [0, 0])
    const px = 0;
    const py = tPos - 24;
    const widthTiles = MapNamePopup._widthTiles ?? 14;
    const contentW = MapNamePopup._contentWidth ?? (widthTiles * 8);

    // 1. Draw 9-slice standard text window border and white interior
    Chrome.mapPopupFrame(px, py, widthTiles);

    // 2. Map Name Text (Centered vertically and horizontally in enclosed window)
    // Uses FONT_NORMAL with dark gray (#626262) fg and light gray (#D5D5CD) shadow
    const name = MapNamePopup._name ?? "";
    const textW = (FrlgFont.measure ? FrlgFont.measure(name) : undefined) ?? (6 * name.length);
    const textX = px + 8 + Math.floor((contentW - textW) / 2);
    const textY = py + 5;

    FrlgFont.draw(name, textX, textY, {
      colors: FrlgFont.COLOR.NORMAL,
      maxWidth: contentW,
    });

    G.setColor(1, 1, 1, 1);
  },
};

export default MapNamePopup;
