// Port of gen1recomp src/ui/game3/stat_growth.lua (GPLv3 + additional terms; see LICENSE.md).
// Stat growth / level-up window (pokefirered Cmd_drawlvlupbox / DrawLevelUpWindowPg1 & Pg2).
//
// Port notes:
// - gen1recomp requires this module lazily (pcall(require) in exp_seq,
//   package.loaded in battle/init): it registers itself in G3Lazy under its
//   Lua name and is imported by core/lazy_modules.ts.
// - pcall(function ... end) blocks are try/catch.
// - `love and love.graphics` is always true here.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { format, tostring, truthy } from "../../../import/gen3/lua.ts";
import { seq, type LuaTable } from "../platform/lt.ts";
import Window from "./window.ts";
import FrlgFont from "./frlg_font.ts";
import RomText from "../core/rom_text.ts";
import Audio from "../core/audio.ts";
import SE from "../core/se_ids.ts";
import Profile from "../core/profile.ts";
import { G3Lazy } from "../core/lazy_registry.ts";

type Fn = (...a: any[]) => any;
interface Pos { x: number; y: number; w: number; h: number }

export interface StatGrowthModule {
  _open: boolean;
  _mon: any;
  _oldStats: any;
  _newStats: any;
  _page: number;
  _onDone: Fn | null | undefined;
  _pos: Pos | null | undefined;
  _box?: any;
  open(mon: any, oldStats: any, newStats: any, onDone?: Fn | null, opts?: any): void;
  isOpen(): boolean;
  close(opts?: any): void;
  handleInput(input: any): boolean;
  draw(): void;
}

export const StatGrowth = {} as StatGrowthModule;

StatGrowth._open = false;
StatGrowth._mon = undefined;
StatGrowth._oldStats = undefined;
StatGrowth._newStats = undefined;
StatGrowth._page = 1;
StatGrowth._onDone = undefined;
StatGrowth._pos = undefined;

// Lua: stat_growth.lua:17
function play_select_se(): void {
  try {
    if (truthy(Audio) && truthy(Audio.playSe)) {
      Audio.playSe((truthy(SE) && SE.SE_SELECT) || 5);
    }
  } catch { /* pcall */ }
}

// Lua: stat_growth.lua:27
function uiBlock(): any {
  let P: any;
  try { P = Profile.forSession(undefined); } catch { return undefined; }
  return truthy(P) && truthy(P.ui) ? P.ui : undefined;
}

// Lua: stat_growth.lua:32
StatGrowth.open = function (mon: any, oldStats: any, newStats: any, onDone?: Fn | null, opts?: any): void {
  opts = opts ?? {};
  const ui = uiBlock();
  const box = truthy(ui) ? ui.levelUpBox : undefined;
  StatGrowth._open = true;
  StatGrowth._mon = mon;
  StatGrowth._oldStats = oldStats ?? {};
  StatGrowth._newStats = newStats ?? {};
  StatGrowth._page = 1;
  StatGrowth._onDone = onDone;
  StatGrowth._box = box;
  StatGrowth._pos = truthy(opts.pos) ? opts.pos
    : (truthy(box) ? { x: box.x, y: box.y, w: box.w, h: box.h } : { x: 19, y: 1, w: 10, h: 11 });
};

// Lua: stat_growth.lua:46
StatGrowth.isOpen = function (): boolean {
  return StatGrowth._open;
};

/**
 * opts.silent drops the window without firing its onDone callback, for callers
 * tearing down a step that no longer exists (#2324).
 */
// Lua: stat_growth.lua:52
StatGrowth.close = function (opts?: any): void {
  const wasOpen = StatGrowth._open;
  StatGrowth._open = false;
  StatGrowth._mon = undefined;
  StatGrowth._oldStats = undefined;
  StatGrowth._newStats = undefined;
  StatGrowth._page = 1;
  const cb = StatGrowth._onDone;
  StatGrowth._onDone = undefined;
  if (wasOpen && truthy(cb) && !(truthy(opts) && truthy(opts.silent))) cb!();
};

// Lua: stat_growth.lua:64
StatGrowth.handleInput = function (input: any): boolean {
  if (!StatGrowth._open || !truthy(input)) return false;
  if (input.wasPressed("a") || input.wasPressed("b") || input.wasPressed("start")) {
    if (StatGrowth._page === 1) {
      play_select_se();
      StatGrowth._page = 2;
      return true;
    } else {
      play_select_se();
      StatGrowth.close();
      return true;
    }
  }
  return false;
};

// Lua: stat_growth.lua:80
StatGrowth.draw = function (): void {
  if (!StatGrowth._open) return;
  const pos = StatGrowth._pos ?? { x: 19, y: 1, w: 10, h: 11 };
  const winX = pos.x ?? 19;
  const winY = pos.y ?? 1;
  const winW = pos.w ?? 10;
  const winH = pos.h ?? 11;

  Window.stdFrame(Window.template(winX, winY, winW, winH));

  const oldS = StatGrowth._oldStats ?? {};
  const newS = StatGrowth._newStats ?? {};
  const oldList: LuaTable = seq(oldS.maxHp ?? 0, oldS.atk ?? 0, oldS.def ?? 0, oldS.spa ?? 0, oldS.spd ?? 0, oldS.spe ?? 0);
  const newList: LuaTable = seq(newS.maxHp ?? 0, newS.atk ?? 0, newS.def ?? 0, newS.spa ?? 0, newS.spd ?? 0, newS.spe ?? 0);
  const isPage1 = (StatGrowth._page === 1);
  const normal = { colors: FrlgFont.COLOR.NORMAL };

  const box = StatGrowth._box;
  if (truthy(box)) {
    const ui = uiBlock();
    const keys = (truthy(ui) && truthy(ui.party) && truthy(ui.party.text) ? ui.party.text.levelUpStats : undefined) ?? {};
    for (let idx = 1; idx <= 6; idx++) {
      // pokeemerald/src/menu_specialized.c:1536
      const rowY = winY * 8 + (idx - 1) * box.pitch;
      FrlgFont.draw(RomText.plain(keys[idx]), winX * 8, rowY, normal);
      if (isPage1) {
        const diff = newList[idx] - oldList[idx];
        FrlgFont.draw(diff >= 0 ? "+" : "-", winX * 8 + 56, rowY, normal);
        const x = Math.abs(diff) <= 9 ? 18 : 12;
        FrlgFont.draw(tostring(Math.abs(diff)), winX * 8 + 56 + x, rowY, normal);
      } else {
        // pokeemerald/src/menu_specialized.c:1588
        const v = newList[idx];
        const digits = v > 99 ? 3 : (v > 9 ? 2 : 1);
        FrlgFont.draw(tostring(v), winX * 8 + 56 + 6 * (4 - digits), rowY, normal);
      }
    }
    return;
  }
  for (let idx = 1; idx <= 6; idx++) {
    const rowY = winY * 8 + 2 + (idx - 1) * 14;
    // src/pokemon_special_anim_scene.c:1518
    FrlgFont.draw(RomText.at("sLevelUpWindowStatNames", idx - 1), winX * 8 + 2, rowY, normal);
    if (isPage1) {
      const diff = newList[idx] - oldList[idx];
      const sign = (diff >= 0) ? "+" : "-";
      const diffStr = format("%s%2d", sign, Math.abs(diff));
      FrlgFont.draw(diffStr, winX * 8 + 52, rowY, normal);
    } else {
      const valStr = format("%3d", newList[idx]);
      FrlgFont.draw(valStr, winX * 8 + 52, rowY, normal);
    }
  }
};

G3Lazy["src.ui.game3.stat_growth"] = StatGrowth;

export default StatGrowth;
