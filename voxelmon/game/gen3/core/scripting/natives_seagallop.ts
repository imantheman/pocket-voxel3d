// Port of gen1recomp src/core/game3/scripting/natives_seagallop.lua (GPLv3 + additional terms; see LICENSE.md).
// Seagallop ferry specials (pokefirered/src/seagallop.c, script_menu.c).
//
// Port notes:
// - Handlers return Lua's multiple returns as a 0-based tuple (natives.ts):
//   `return false, n` is `return [false, n]`. destinationMenu returns
//   [labels, top].
// - pcall(require) / package.loaded of ui seagallop, audio, fade, space,
//   runtime, natives, multichoice: static imports treated as loaded.
// - NOT FAITHFUL: ferryTask's `hasGraphics` probe (love.graphics plus
//   love.window, i.e. a desktop window rather than a headless run) is true
//   here: the 3DS always has a screen, and there is no love.window.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { len, seq, type LuaTable } from "../../platform/lt.ts";
import { format, tonumber, tostring } from "../../../../import/gen3/lua.ts";
import RomText from "../rom_text.ts";
import Std from "./stdscripts.ts";
import { SE } from "../se_ids.ts"; // pokefirered/include/constants/songs.h:23
import Flags from "./flags.ts";
import Space from "./space.ts";
import Runtime from "../runtime.ts";
import { Seagallop as SeagallopUiMod } from "../../ui/seagallop.ts";
import { Audio as AudioMod } from "../audio.ts";
import { Fade as FadeMod } from "../../ui/fade.ts";
import { Multichoice } from "./multichoice.ts";
import Natives, { type Handler } from "./natives.ts";

const VERMILION_CITY = 0;
const ONE_ISLAND = 1;
const TWO_ISLAND = 2;
const THREE_ISLAND = 3;
const FOUR_ISLAND = 4;
const FIVE_ISLAND = 5;
const SIX_ISLAND = 6;
const SEVEN_ISLAND = 7;
const CINNABAR_ISLAND = 8;
const NAVEL_ROCK = 9;
const BIRTH_ISLAND = 10;
const SEAGALLOP_MORE = 254;

// pokefirered/include/constants/menu.h:4
const SCR_MENU_CANCEL = 127;
const SCR_MENU_UNSET = 255;

const VAR_RESULT = 0x800D; // pokefirered/include/constants/vars.h:328
const VAR_ORIGIN = 0x8004; // pokefirered/include/constants/vars.h:319
const VAR_PAGE = 0x8005; // pokefirered/include/constants/vars.h:320
const VAR_DEST = 0x8006; // pokefirered/include/constants/vars.h:321

// pokefirered/src/seagallop.c:286
const CROSSING_FRAMES = 140;
// pokefirered/src/overworld.c:1128
const MUSIC_FADE_FRAMES = 64;

// pokefirered/src/seagallop.c:62
const WARPS: Record<number, LuaTable> = {
  [VERMILION_CITY]: seq(3, 5, 0x17, 0x20),
  [ONE_ISLAND]: seq(32, 4, 0x08, 0x05),
  [TWO_ISLAND]: seq(33, 4, 0x08, 0x05),
  [THREE_ISLAND]: seq(38, 0, 0x08, 0x05),
  [FOUR_ISLAND]: seq(35, 5, 0x08, 0x05),
  [FIVE_ISLAND]: seq(36, 2, 0x08, 0x05),
  [SIX_ISLAND]: seq(37, 2, 0x08, 0x05),
  [SEVEN_ISLAND]: seq(31, 6, 0x08, 0x05),
  [CINNABAR_ISLAND]: seq(3, 8, 0x15, 0x07),
  [NAVEL_ROCK]: seq(2, 59, 0x08, 0x05),
  [BIRTH_ISLAND]: seq(2, 58, 0x08, 0x05),
};

// Lua: natives_seagallop.lua:54
// pokefirered/src/script_menu.c:664
function destLabel(id: number): any {
  return RomText.at("sSeagallopDestStrings", id);
}

// Lua: natives_seagallop.lua:58
function flagsMod(): typeof Flags {
  return Flags;
}

// Lua: natives_seagallop.lua:62
function scriptStore(): any {
  const S: any = Space;
  if (S && S.store) return S.store;
  const rt: any = Runtime;
  const session = rt && rt.getSession && rt.getSession();
  return (session && session.store) || undefined;
}

// Lua: natives_seagallop.lua:70
function varGet(ctx: any, id: number): number {
  return tonumber(flagsMod().getVar(scriptStore(), ctx, id)) ?? 0;
}

// Lua: natives_seagallop.lua:74
function varSet(ctx: any, id: number, value: any): void {
  flagsMod().setVar(scriptStore(), ctx, id, tonumber(value) ?? 0);
}

const BY_NAME: Record<string, Handler> = {
  // Lua: natives_seagallop.lua:211
  // pokefirered/src/seagallop.c:174
  DoSeagallopFerryScene: (ctx, adapters) => {
    let destId = varGet(ctx, VAR_DEST);
    // pokefirered/src/seagallop.c:309
    if (destId < 0 || destId >= Seagallop.WARP_COUNT) {
      destId = VERMILION_CITY;
      varSet(ctx, VAR_DEST, destId);
    }
    Natives.awaitState(ctx, Seagallop.ferryTask(ctx, adapters, destId));
    return [false];
  },
  // Lua: natives_seagallop.lua:223
  // pokefirered/src/seagallop.c:454
  GetSeagallopNumber: (ctx) => {
    return [false, Seagallop.seagallopNumber(varGet(ctx, VAR_ORIGIN), varGet(ctx, VAR_DEST))];
  },
  // Lua: natives_seagallop.lua:227
  // pokefirered/src/script_menu.c:1234
  DrawSeagallopDestinationMenu: (ctx, adapters) => {
    varSet(ctx, VAR_RESULT, SCR_MENU_UNSET);
    const originId = varGet(ctx, VAR_ORIGIN);
    const page = varGet(ctx, VAR_PAGE);
    const [labels, top] = Seagallop.destinationMenu(originId, page);
    if (!(adapters && adapters.multichoice)) {
      varSet(ctx, VAR_RESULT, SCR_MENU_CANCEL);
      return [false];
    }
    (Multichoice.LISTS as any)[Seagallop.MENU_LIST_ID] = { labels, count: len(labels) };
    let picked = false;
    Natives.awaitState(ctx, () => picked);
    adapters.multichoice({
      op: "multichoice",
      1: 17, 2: top, 3: Seagallop.MENU_LIST_ID, 4: 0,
    }, (sel: any) => {
      varSet(ctx, VAR_RESULT, tonumber(sel) ?? SCR_MENU_CANCEL);
      picked = true;
    });
    return [false];
  },
  // Lua: natives_seagallop.lua:251
  // pokefirered/src/script_menu.c:1291
  GetSelectedSeagallopDestination: (ctx) => {
    const dest = Seagallop.selectedDestination(
      varGet(ctx, VAR_ORIGIN), varGet(ctx, VAR_PAGE), varGet(ctx, VAR_RESULT));
    return [false, dest];
  },
};

export const Seagallop = {
  WARPS,
  WARP_COUNT: 11,

  // Lua: natives_seagallop.lua:79
  // pokefirered/src/seagallop.c:454
  seagallopNumber(originId: number, destId: number): number {
    if (originId === CINNABAR_ISLAND || destId === CINNABAR_ISLAND) return 1;
    if (originId === VERMILION_CITY || destId === VERMILION_CITY) return 7;
    if (originId === NAVEL_ROCK || destId === NAVEL_ROCK) return 10;
    if (originId === BIRTH_ISLAND || destId === BIRTH_ISLAND) return 12;
    const isOneToThree = (v: number): boolean => v === ONE_ISLAND || v === TWO_ISLAND || v === THREE_ISLAND;
    if (isOneToThree(originId) && isOneToThree(destId)) return 2;
    const isFourOrFive = (v: number): boolean => v === FOUR_ISLAND || v === FIVE_ISLAND;
    if (isFourOrFive(originId) && isFourOrFive(destId)) return 3;
    const isSixOrSeven = (v: number): boolean => v === SIX_ISLAND || v === SEVEN_ISLAND;
    if (isSixOrSeven(originId) && isSixOrSeven(destId)) return 5;
    return 6;
  },

  // Lua: natives_seagallop.lua:96
  // pokefirered/src/script_menu.c:1234
  destinationMenu(originId: number, page: number): [LuaTable, number] {
    let top: number, numItems: number, destinationId: number;
    if (page === 1) {
      destinationId = (originId < FIVE_ISLAND) ? FIVE_ISLAND : FOUR_ISLAND;
      numItems = 5; top = 2;
    } else {
      destinationId = VERMILION_CITY;
      numItems = 6; top = 0;
    }
    const labels: LuaTable = seq();
    let i = 0;
    while (i < numItems - 2) {
      if (destinationId !== originId) {
        labels[len(labels) + 1] = destLabel(destinationId);
        i = i + 1;
      }
      destinationId = destinationId + 1;
      if (destinationId === SEVEN_ISLAND + 1) destinationId = VERMILION_CITY;
    }
    labels[len(labels) + 1] = RomText.plain("gText_Other");
    labels[len(labels) + 1] = RomText.plain("gOtherText_Exit");
    return [labels, top];
  },

  // Lua: natives_seagallop.lua:121
  // pokefirered/src/script_menu.c:1291
  selectedDestination(originId: number, page: number, result: number): number {
    if (result === SCR_MENU_CANCEL) return SCR_MENU_CANCEL;
    if (page === 1) {
      if (result === 3) return SEAGALLOP_MORE;
      if (result === 4) return SCR_MENU_CANCEL;
      if (result === 0) {
        return (originId > FOUR_ISLAND) ? FOUR_ISLAND : FIVE_ISLAND;
      }
      if (result === 1) {
        return (originId > FIVE_ISLAND) ? FIVE_ISLAND : SIX_ISLAND;
      }
      if (result === 2) {
        return (originId > SIX_ISLAND) ? SIX_ISLAND : SEVEN_ISLAND;
      }
    } else {
      if (result === 4) return SEAGALLOP_MORE;
      if (result === 5) return SCR_MENU_CANCEL;
      if (result >= originId) return result + 1;
      return result;
    }
    return VERMILION_CITY;
  },

  MENU_LIST_ID: 0xF001,

  // Lua: natives_seagallop.lua:147
  // pokefirered/src/seagallop.c:174
  ferryTask(ctx: any, adapters: any, destId: number): () => boolean {
    const originId = varGet(ctx, VAR_ORIGIN);
    const warp = WARPS[destId];
    let done = false;
    // pcall(require, "src.ui.game3.seagallop")
    const SeagallopUi: any = SeagallopUiMod;
    // NOT FAITHFUL: love.window probe (see the port notes).
    const hasGraphics = true;
    if (SeagallopUi && SeagallopUi.start && hasGraphics) {
      SeagallopUi.start(originId, destId, () => {
        if (warp && adapters && adapters.warp) {
          adapters.warp(warp[1], warp[2], -1, warp[3], warp[4], () => {}, "seagallop");
        } else if (adapters && adapters.log) {
          adapters.log(format("[game3] seagallop has no warp for dest %s", tostring(destId)));
        }
      }, () => {
        done = true;
      });
      return () => done;
    }

    let frames = 0;
    let phase = "cross";
    let waited = 0, arrived = false;
    const Audio: any = AudioMod;
    const Fade: any = FadeMod;
    return () => {
      if (phase === "cross") {
        frames = frames + 1;
        if (frames === 1 && Audio && Audio.playSe) { try { Audio.playSe(SE.SE_SHIP); } catch { /* pcall */ } }
        if (frames < CROSSING_FRAMES) return false;
        // pokefirered/src/seagallop.c:286
        if (Audio && Audio.fadeOutBgm) { try { Audio.fadeOutBgm(4); } catch { /* pcall */ } }
        if (Fade && Fade.begin) {
          const covered = !Fade.isActive() && (tonumber(Fade.t) ?? 0) >= 16;
          if (!covered) Fade.begin(Fade.MODE.TO_BLACK, 1, () => {});
        }
        phase = "fade";
        return false;
      }
      if (phase === "fade") {
        // pokefirered/src/seagallop.c:294
        waited = waited + 1;
        if (Fade && Fade.isActive()) return false;
        if (Audio && Audio._fadeOut && waited < MUSIC_FADE_FRAMES) return false;
        phase = "warp";
        if (Audio && Audio.playSe) { try { Audio.playSe(SE.SE_EXIT); } catch { /* pcall */ } }
        if (warp && adapters && adapters.warp) {
          adapters.warp(warp[1], warp[2], -1, warp[3], warp[4], () => { arrived = true; },
            "seagallop");
        } else {
          if (adapters && adapters.log) {
            adapters.log(format("[game3] seagallop has no warp for dest %s", tostring(destId)));
          }
          arrived = true;
        }
        return arrived;
      }
      return arrived;
    };
  },

  BY_NAME,
  /** Set by Std.legacyHandlers: special id -> handler. */
  HANDLERS: undefined as Record<number, Handler> | undefined,
};
// Lua: natives_seagallop.lua:257
Std.legacyHandlers(Seagallop);

export default Seagallop;
