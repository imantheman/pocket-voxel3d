// Port of gen1recomp src/core/game3/field_move_show_mon.lua (GPLv3 + additional terms; see LICENSE.md).
// pokefirered/src/field_effect.c:2577 -- the field-move "show mon" streak
// band (outdoors / indoors) with the mon's front pic sliding across.
// `love` is always present here, so draw()'s love.graphics guard is constant true.

import { mod, tonumber, truthy } from "../../../import/gen3/lua.ts";
import { G } from "../platform/graphics.ts";
import { newImageData, type Image, type Quad } from "../platform/image.ts";
import { Player as PlayerMod } from "./player.ts";
import { FieldEffects } from "./field_effects.ts";
import { Extract } from "../../../import/gen3/extract_island1.ts";
import { Map as MapMod } from "./map.ts";
import { Pokemon } from "./pokemon.ts";
import { Audio } from "./audio.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface ShowMonFx {
  species: number;
  picSpecies: any;
  shiny: boolean;
  personality: any;
  noDuck: boolean;
  onDone?: () => void;
  outdoors: boolean;
  phase: number | "pose";
  posed: boolean;
  poseWait: number;
  hofs: number;
  winL: number; winT: number; winB: number;
  revealed: number; cleared: number;
  sprite: { x: number; y: number; state: string; wait?: number; done?: boolean } | null;
  hidden?: boolean;
}

// Lua: field_move_show_mon.lua:8
const BAND_TOP = 40;
const BAND_H = 80;
const BAND_W = 256;
const SCREEN_W = 240;
// pokefirered/include/constants/sound.h:42
const CRY_VOLUME_RS = 125;
// pokefirered/src/overworld.c:1228
const OUTDOOR_MAP_TYPES: Record<number, boolean> = { [1]: true, [2]: true, [3]: true, [5]: true, [6]: true };

// Lua: field_move_show_mon.lua:17
function player(): any {
  return PlayerMod;
}

// Lua: field_move_show_mon.lua:21
function band_image(kind: string): Image {
  if (ShowMon._img[kind]) return ShowMon._img[kind];
  const cache = FieldEffects._cache;
  if (!(cache && cache.read)) throw new Error("field move streaks: no ROM cache mounted");
  const rel = (Extract.CACHE_ROOT || "data/generated/gba") + "/field_effects/field_move_streaks_" + kind + ".rgba";
  let ok = true;
  let rgba: any;
  try { rgba = cache.read(rel); } catch { ok = false; }
  if (!(ok && rgba && rgba.length === BAND_W * BAND_H * 4)) throw new Error("field move streaks missing from the cache: " + rel);
  const id = newImageData(BAND_W, BAND_H, "rgba8", rgba);
  const img = G.newImage(id);
  (img as any).setFilter("nearest", "nearest");
  ShowMon._img[kind] = img;
  return img;
}

// Lua: field_move_show_mon.lua:37
function map_is_outdoors(): boolean {
  const M: any = MapMod;
  const def = M && M.currentDef ? M.currentDef() : null;
  return OUTDOOR_MAP_TYPES[tonumber(def ? def.mapType : undefined) ?? 0] === true;
}

// Lua: field_move_show_mon.lua:87 -- pokefirered/src/field_effect.c:2929
function step_sprite(fx: ShowMonFx): void {
  const s = fx.sprite;
  if (!s || s.done) return;
  if (s.state === "on") {
    s.x = s.x - 20;
    if (s.x <= 0x78) {
      s.x = 0x78;
      s.wait = 30;
      s.state = "wait";
      if (fx.noDuck) {
        // pokefirered/src/field_effect.c:2938
        Audio.playCry(fx.species, { mode: 0, volume: CRY_VOLUME_RS, noDuck: true });
      } else {
        // pokefirered/src/field_effect.c:2942
        Audio.playCry(fx.species, 0);
      }
    }
  } else if (s.state === "wait") {
    s.wait = s.wait! - 1;
    if (s.wait === 0) s.state = "off";
  } else if (s.state === "off") {
    if (s.x < -0x40) s.done = true; else s.x = s.x - 20;
  }
}

// Lua: field_move_show_mon.lua:113
function start_sprite(fx: ShowMonFx): void {
  fx.sprite = { x: 0x140, y: 0x50, state: "on" };
}

// Lua: field_move_show_mon.lua:117
function finish(fx: ShowMonFx): void {
  ShowMon._fx = null;
  if (fx.posed) player().fieldMoveAnim = 0;
  if (fx.onDone) fx.onDone();
}

// Lua: field_move_show_mon.lua:124 -- pokefirered/src/field_effect.c:2601
function step_outdoors(fx: ShowMonFx): void {
  const ph = fx.phase as number;
  if (ph === 1 || ph === 2) {
    fx.phase = ph + 1;
  } else if (ph === 3) {
    fx.hofs = fx.hofs - 16;
    fx.winL = Math.max(0, fx.winL - 16);
    fx.winT = Math.max(0x28, fx.winT - 2);
    fx.winB = Math.min(0x78, fx.winB + 2);
    if (fx.winL === 0 && fx.winT === 0x28 && fx.winB === 0x78) {
      start_sprite(fx);
      fx.phase = 4;
    }
  } else if (ph === 4) {
    fx.hofs = fx.hofs - 16;
    if (fx.sprite && fx.sprite.done) fx.phase = 5;
  } else if (ph === 5) {
    fx.hofs = fx.hofs - 16;
    fx.winT = Math.min(0x50, fx.winT + 6);
    fx.winB = Math.max(0x51, fx.winB - 6);
    if (fx.winT === 0x50 && fx.winB === 0x51) fx.phase = 6;
  } else if (ph === 6) {
    fx.phase = 7;
    fx.hidden = true;
  } else if (ph === 7) {
    finish(fx);
    return;
  }
  step_sprite(fx);
}

// Lua: field_move_show_mon.lua:156 -- pokefirered/src/field_effect.c:2757
function step_indoors(fx: ShowMonFx): void {
  const ph = fx.phase as number;
  if (ph === 1 || ph === 2) {
    fx.phase = ph + 1;
  } else if (ph === 3) {
    if (fx.revealed >= 16) {
      start_sprite(fx);
      fx.phase = 4;
    } else {
      fx.revealed = fx.revealed + 1;
    }
    fx.hofs = fx.hofs - 16;
  } else if (ph === 4) {
    fx.hofs = fx.hofs - 16;
    if (fx.sprite && fx.sprite.done) fx.phase = 5;
  } else if (ph === 5) {
    fx.hofs = fx.hofs - 16;
    fx.phase = 6;
  } else if (ph === 6) {
    fx.hofs = fx.hofs - 16;
    if (fx.cleared >= 16) fx.phase = 7; else fx.cleared = fx.cleared + 1;
  } else if (ph === 7) {
    finish(fx);
    return;
  }
  step_sprite(fx);
}

// Lua: field_move_show_mon.lua:197
function draw_band(img: Image | null, x0: number, x1: number, y0: number, y1: number, hofs: number): void {
  if (!img || x1 <= x0 || y1 <= y0) return;
  ShowMon._quad = ShowMon._quad ?? G.newQuad(0, 0, 1, 1, BAND_W, BAND_H);
  const q = ShowMon._quad!;
  let sx = x0;
  while (sx < x1) {
    const u = mod(sx + hofs, BAND_W);
    const w = Math.min(x1 - sx, BAND_W - u);
    q.setViewport(u, y0 - BAND_TOP, w, y1 - y0, BAND_W, BAND_H);
    G.draw(img, q, sx, y0);
    sx = sx + w;
  }
}

export const ShowMon = {
  // Lua: field_move_show_mon.lua:5
  _fx: null as ShowMonFx | null,
  _img: {} as Record<string, Image>,
  _quad: null as Quad | null,

  // Lua: field_move_show_mon.lua:43
  invalidate(): void {
    ShowMon._img = {};
  },

  // Lua: field_move_show_mon.lua:47
  isActive(): boolean {
    return ShowMon._fx != null;
  },

  // Lua: field_move_show_mon.lua:52 -- pokefirered/src/main.c:480
  reset(): void {
    ShowMon._fx = null;
  },

  // Lua: field_move_show_mon.lua:57 -- pokefirered/src/fldeff_rocksmash.c:44
  start(mon: any, opts?: any, onDone?: () => void): boolean {
    opts = opts ?? {};
    const species = tonumber(mon != null && typeof mon === "object" ? mon.species : mon) ?? 0;
    const P = player();
    const monTable = mon != null && typeof mon === "object" ? mon : null;
    const fx: ShowMonFx = {
      species,
      // pokefirered/src/field_effect.c:2920
      picSpecies: Pokemon.picSpecies(species, monTable ? monTable.personality : undefined),
      shiny: Pokemon.isShiny(monTable),
      personality: monTable ? monTable.personality : undefined,
      noDuck: opts.noDuck === true,
      onDone,
      outdoors: map_is_outdoors(),
      phase: opts.pose ? "pose" : 1,
      posed: opts.pose === true,
      // pokefirered/src/data/object_events/object_event_anims.h:633
      poseWait: 24,
      hofs: 0,
      winL: 240, winT: 80, winB: 81,
      revealed: 0, cleared: 0,
      sprite: null,
    };
    ShowMon._fx = fx;
    if (opts.pose) P.startFieldMove(24);
    return true;
  },

  // Lua: field_move_show_mon.lua:184
  step(): void {
    const fx = ShowMon._fx;
    if (!fx) return;
    const P = player();
    if (fx.phase === "pose") {
      fx.poseWait = fx.poseWait - 1;
      if (fx.poseWait > 0) return;
      fx.phase = 1;
    }
    if (fx.posed) P.fieldMoveAnim = 1;
    if (fx.outdoors) step_outdoors(fx); else step_indoors(fx);
  },

  // Lua: field_move_show_mon.lua:211
  draw(): void {
    const fx = ShowMon._fx;
    if (!fx || fx.phase === "pose") return;
    G.setColor(1, 1, 1, 1);
    const phase = fx.phase as number;
    if (fx.outdoors) {
      if (!fx.hidden && phase >= 3) {
        const y0 = Math.max(fx.winT, BAND_TOP);
        const y1 = Math.min(fx.winB, BAND_TOP + BAND_H);
        draw_band(band_image("outdoors"), fx.winL, SCREEN_W, y0, y1, fx.hofs);
      }
    } else {
      const img = band_image("indoors");
      if (phase === 3 || phase === 4 || phase === 5) {
        const x1 = (phase === 3 && fx.revealed < 16) ? Math.min(SCREEN_W, 16 * (fx.revealed + 1)) : SCREEN_W;
        const x0 = (phase === 3 && fx.revealed < 16) ? 16 : 0;
        draw_band(img, x0, x1, BAND_TOP, BAND_TOP + BAND_H, fx.hofs);
      } else if (phase === 6) {
        draw_band(img, Math.min(SCREEN_W, 16 * fx.cleared), SCREEN_W, BAND_TOP, BAND_TOP + BAND_H, fx.hofs);
      }
    }
    const s = fx.sprite;
    if (s && !s.done) {
      const entry: any = Pokemon.frontPic ? Pokemon.frontPic(fx.picSpecies, null, fx.shiny, fx.personality) : null;
      if (entry && truthy(entry.image)) {
        const w = entry.w ?? 64, h = entry.h ?? 64;
        G.draw(entry.image, Math.floor(s.x - w / 2), Math.floor(s.y - h / 2));
      }
    }
  },
};

export default ShowMon;
