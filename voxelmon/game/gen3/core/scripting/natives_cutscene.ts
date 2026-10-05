// Port of gen1recomp src/core/game3/scripting/natives_cutscene.lua (GPLv3 + additional terms; see LICENSE.md).
// Cutscene specials: camera object, teleporter animations, credits, diploma,
// league lighting, wing flaps, museum fossil pics, the S.S. Anne departure.
//
// Port notes:
// - Handlers return Lua's multiple returns as a 0-based tuple (natives.ts).
// - pcall(require, X) of lazily registered modules (camera_object,
//   ui credits, ui diploma) looks X up in G3Lazy; a missing entry is the
//   failed require. require("src.ui.game3.museum_fossil_pic") is a plain
//   require: with no module registered it throws, as Lua's require does.
// - package.loaded / require of runtime, space, player, field, task, audio,
//   league_lighting, ss_anne_cutscene, natives: static imports.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { mod, tonumber } from "../../../../import/gen3/lua.ts";
import Std from "./stdscripts.ts";
import { SE } from "../se_ids.ts"; // pokefirered/include/constants/songs.h:155
import Flags from "./flags.ts";
import Space from "./space.ts";
import { Runtime } from "../runtime.ts";
import { G3Lazy } from "../lazy_registry.ts";
import { Player } from "../player.ts";
import { Field } from "../field.ts";
import { Task } from "../task.ts";
import { Audio } from "../audio.ts";
import { LeagueLighting } from "../league_lighting.ts";
import { SSAnneCutscene } from "../ss_anne_cutscene.ts";
import Natives, { type Handler } from "./natives.ts";

const VAR_0x8004 = 0x8004; // pokefirered/include/constants/vars.h:319
const VAR_0x8005 = 0x8005; // pokefirered/include/constants/vars.h:320
const VAR_0x8006 = 0x8006; // pokefirered/include/constants/vars.h:321

const SPECIES_KABUTOPS = 141; // pokefirered/src/script_menu.c:1165
const SPECIES_AERODACTYL = 142; // pokefirered/src/script_menu.c:1171

/** Lua's plain require of a lazily registered module: throws when absent. */
function requireLazy(name: string): any {
  const m = G3Lazy[name];
  if (m == null) throw new Error("module '" + name + "' not found");
  return m;
}

// Lua: natives_cutscene.lua:14
function flagsMod(): typeof Flags {
  return Flags;
}

// Lua: natives_cutscene.lua:18
function sessionOf(ctx: any): any {
  const rt: any = Runtime;
  return (rt && rt.getSession && rt.getSession())
    || (ctx && ctx.session)
    || undefined;
}

// Lua: natives_cutscene.lua:25
function scriptStore(ctx: any): any {
  const S: any = Space;
  const session = sessionOf(ctx);
  return (S && S.store)
    || (session && (session.store || session))
    || (ctx && (ctx.store || ctx.session || (ctx.vars && ctx)))
    || undefined;
}

// Lua: natives_cutscene.lua:34
function varGet(ctx: any, id: number): number {
  return tonumber(flagsMod().getVar(scriptStore(ctx), ctx, id)) ?? 0;
}

// Lua: natives_cutscene.lua:38
function playSe(adapters: any, id: number): void {
  if (adapters && adapters.playSe) {
    adapters.playSe(id, false);
    return;
  }
  try { Audio.playSe(id); } catch { /* pcall */ }
}

// Lua: natives_cutscene.lua:46
function currentGame(): any {
  const rt: any = Runtime;
  return (rt && rt._game) || undefined;
}

// Lua: natives_cutscene.lua:51
function cameraObject(): any {
  // pcall(require, "src.core.game3.camera_object")
  const CameraObject = G3Lazy["src.core.game3.camera_object"];
  if (typeof CameraObject === "object" && CameraObject != null) return CameraObject;
  return undefined;
}

const BY_NAME: Record<string, Handler> = {
  // Lua: natives_cutscene.lua:59
  // pokefirered/src/field_specials.c:318
  SpawnCameraObject: () => {
    const CameraObject = cameraObject();
    if (CameraObject && CameraObject.spawn) {
      try { CameraObject.spawn(currentGame()); } catch { /* pcall */ }
    }
    return [false];
  },
  // Lua: natives_cutscene.lua:67
  // pokefirered/src/field_specials.c:325
  RemoveCameraObject: () => {
    const CameraObject = cameraObject();
    if (CameraObject && CameraObject.remove) {
      try { CameraObject.remove(currentGame()); } catch { /* pcall */ }
    }
    return [false];
  },
  // Lua: natives_cutscene.lua:75
  // src/special_field_anim.c:223-265, include/constants/metatile_labels.h:177-186
  AnimateTeleporterHousing: (ctx) => {
    const P: any = Player;
    const F: any = Field;
    const T: any = Task;
    if (!(F && F.setMetatile && T && T.spawn)) {
      return [false];
    }
    let x = tonumber(P.cellX) ?? 0;
    const y = (tonumber(P.cellY) ?? 0) - 5;
    if (varGet(ctx, VAR_0x8004) === 0) x = x + 6; else x = x - 1;
    let timer = 0, state = 0;
    T.spawn(() => {
      if (timer === 0) {
        if (mod(state, 2) === 0) {
          F.setMetatile(x, y, 0x2B5, true);
          F.setMetatile(x, y + 2, 0x2B7, true);
        } else {
          F.setMetatile(x, y, 0x2B6, true);
          F.setMetatile(x, y + 2, 0x2B8, true);
        }
      }
      timer = timer + 1;
      if (timer !== 16) return false;
      timer = 0;
      state = state + 1;
      if (state !== 13) return false;
      F.setMetatile(x, y, 0x28A, true);
      F.setMetatile(x, y + 2, 0x296, true);
      return true;
    });
    return [false];
  },
  // Lua: natives_cutscene.lua:109
  // src/special_field_anim.c:285-330
  AnimateTeleporterCable: () => {
    const P: any = Player;
    const F: any = Field;
    const T: any = Task;
    if (!(F && F.setMetatile && T && T.spawn)) {
      return [false];
    }
    let x = (tonumber(P.cellX) ?? 0) + 4;
    const y = (tonumber(P.cellY) ?? 0) - 5;
    let timer = 0, state = 0;
    T.spawn(() => {
      if (timer === 0) {
        if (state !== 0) {
          F.setMetatile(x, y, 0x285, true);
          F.setMetatile(x, y + 1, 0x2B4, true);
          if (state === 4) return true;
          x = x - 1;
        }
        F.setMetatile(x, y, 0x2B9, true);
        F.setMetatile(x, y + 1, 0x2BA, true);
      }
      timer = timer + 1;
      if (timer === 4) {
        timer = 0;
        state = state + 1;
      }
      return false;
    });
    return [false];
  },

  // Lua: natives_cutscene.lua:142
  // pokefirered/src/credits.c:711, data/maps/IndigoPlateau_Exterior/scripts.inc:80
  DoCredits: (ctx) => {
    // pcall(require, "src.ui.game3.credits")
    const Credits = G3Lazy["src.ui.game3.credits"];
    if (!(Credits != null && ctx)) return [false];
    let okStart = true;
    let started: any;
    try { started = Credits.start(); } catch { okStart = false; }
    if (okStart && started) {
      Natives.awaitState(ctx, () => false);
    }
    return [false];
  },

  // Lua: natives_cutscene.lua:153
  // pokefirered/src/field_specials.c:90, src/diploma.c:100, data/maps/CeladonCity_Condominiums_3F/scripts.inc:34
  ShowDiploma: (ctx) => {
    // pcall(require, "src.ui.game3.diploma")
    const Diploma = G3Lazy["src.ui.game3.diploma"];
    if (!(Diploma != null && ctx)) return [false];
    let done = false;
    let okShow = true;
    let shown: any;
    try { shown = Diploma.show({ onDone: () => { done = true; } }); } catch { okShow = false; }
    if (okShow && shown) {
      Natives.awaitState(ctx, () => done);
    }
    return [false];
  },

  // Lua: natives_cutscene.lua:165
  // pokefirered/src/field_specials.c:2133, data/scripts/pokemon_league.inc:63
  DoPokemonLeagueLightingEffect: () => {
    const S: any = Space;
    try { LeagueLighting.start(S && S.mapId); } catch { /* pcall */ }
    return [false];
  },

  // Lua: natives_cutscene.lua:172
  // pokefirered/src/field_specials.c:2535, NavelRock_Summit/scripts.inc:39-41
  LoopWingFlapSound: (ctx, adapters) => {
    const loops = varGet(ctx, VAR_0x8004);
    const delay = varGet(ctx, VAR_0x8005);
    playSe(adapters, SE.SE_M_WING_ATTACK);
    if (loops > 0 && delay > 0) {
      const T: any = Task;
      if (T && T.spawn) {
        let ticks = 0, count = 0;
        T.spawn(() => {
          ticks = ticks + 1;
          if (ticks >= delay) {
            ticks = 0;
            count = count + 1;
            playSe(adapters, SE.SE_M_WING_ATTACK);
          }
          // field_specials.c:2553, field_specials.c:2546-2554
          return count >= loops - 1;
        });
      }
    }
    return [false];
  },

  // Lua: natives_cutscene.lua:196
  // pokefirered/src/script_menu.c:1151, scripts.inc:170-187, script_menu.c:1165-1176
  OpenMuseumFossilPic: (ctx) => {
    const species = varGet(ctx, VAR_0x8004);
    if (species !== SPECIES_KABUTOPS && species !== SPECIES_AERODACTYL) {
      return [false];
    }
    if (ctx) {
      requireLazy("src.ui.game3.museum_fossil_pic").show(ctx, species,
        varGet(ctx, VAR_0x8005), varGet(ctx, VAR_0x8006));
    }
    return [false];
  },

  // Lua: natives_cutscene.lua:209
  // pokefirered/src/script_menu.c:1184
  CloseMuseumFossilPic: (ctx) => {
    if (ctx) requireLazy("src.ui.game3.museum_fossil_pic").hide(ctx);
    return [false];
  },
  // Lua: natives_cutscene.lua:214
  // pokefirered/src/ss_anne.c:82 DoSSAnneDepartureCutscene
  DoSSAnneDepartureCutscene: (ctx, adapters) => {
    Natives.awaitState(ctx, SSAnneCutscene.start(ctx, adapters));
    return [false];
  },
};

export const Cutscene = {
  BY_NAME,
  /** Set by Std.legacyHandlers: special id -> handler. */
  HANDLERS: undefined as Record<number, Handler> | undefined,
};
// Lua: natives_cutscene.lua:221
Std.legacyHandlers(Cutscene);

export default Cutscene;
