// Port of gen1recomp src/core/game3/deoxys.lua (GPLv3 + additional terms; see LICENSE.md).
// pret pokefirered/src/field_specials.c:2319-2456 -- Birth Island Deoxys triangle.
//
// The "triangle" is a single 32x32 inanimate rock object that the puzzle slides
// between eleven fixed positions. Every successful interaction advances the rock
// one position and shifts its palette one step towards the bright red "awakened"
// colours; walking more than the per-position step cap resets the puzzle.
// Reaching position 10 makes Deoxys appear.
//
// Return shapes: coords -> [x, y]; storeOf -> [store, synthesized];
// resolveRockObject -> [eo, localId]. Song ids read through song_fields.

import { format, mod, tonumber } from "../../../import/gen3/lua.ts";
import { len, pairs, seq, type LuaTable } from "../platform/lt.ts";
import { MapCatalog } from "../../../import/gen3/map_catalog.ts";
import { song_fields } from "./song_fields.ts";
import { Flags } from "./scripting/flags.ts";
import { Space as SpaceMod } from "./scripting/space.ts";
import { Objects as ObjectsMod } from "./objects.ts";
import { OwSprites } from "./ow_sprites.ts";
import { Audio } from "./audio.ts";
import { FieldEffects } from "./field_effects.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

// Lua: deoxys.lua:129
function flagsMod(): typeof Flags {
  return Flags;
}

// Lua: deoxys.lua:175
function objectsMod(): any {
  return ObjectsMod ?? null;
}

const ROCK_PALS: LuaTable = seq(
  seq(seq(33, 33, 33), seq(82, 82, 82), seq(140, 140, 140)),
  seq(seq(41, 33, 33), seq(82, 82, 82), seq(140, 140, 140)),
  seq(seq(49, 33, 33), seq(90, 82, 82), seq(148, 148, 140)),
  seq(seq(66, 33, 33), seq(115, 82, 82), seq(156, 148, 140)),
  seq(seq(74, 33, 33), seq(123, 82, 82), seq(165, 156, 140)),
  seq(seq(99, 33, 33), seq(140, 82, 82), seq(173, 156, 140)),
  seq(seq(99, 33, 33), seq(148, 82, 82), seq(181, 165, 140)),
  seq(seq(107, 33, 33), seq(156, 82, 82), seq(189, 165, 140)),
  seq(seq(123, 33, 33), seq(173, 82, 82), seq(197, 173, 148)),
  seq(seq(132, 33, 33), seq(181, 82, 82), seq(206, 173, 148)),
  seq(seq(206, 33, 33), seq(255, 82, 82), seq(255, 206, 156)),
);

export const Deoxys = {
  // Lua: deoxys.lua:12 -- pokefirered/include/constants/field_effects.h:71-72
  FLDEFF_MOVE_ROCK: 67,
  FLDEFF_DESTROY_ROCK: 68,

  // pokefirered/include/constants/vars.h
  VAR_DEOXYS_INTERACTION_NUM: 0x403E,
  VAR_DEOXYS_INTERACTION_STEP_COUNTER: 0x4026,
  // pokefirered/include/constants/flags.h
  FLAG_SYS_DEOXYS_AWAKENED: 0x848,

  // pokefirered/include/constants/event_objects.h
  OBJ_EVENT_GFX_METEORITE: 106,

  // pokefirered/include/constants/map_groups.h -- gMapGroup_SpecialArea:56
  MAP_GROUP: 2,
  MAP_NUM: 56,
  MAP_ID: "FR_BIRTH_ISLAND_EXTERIOR",

  // tools/mapjson/mapjson.cpp:415 numbers local_id 1-based in object_events order.
  LOCALID_ROCK: 1,
  LOCALID_DEOXYS: 2,

  // Lua: deoxys.lua:40 -- pokefirered/include/constants/species.h:419
  SPECIES_DEOXYS: 410,

  // Lua: deoxys.lua:43 -- pokefirered/src/field_specials.c:2334 -- index 0..10 == interaction num.
  COORDS: seq(
    seq(15, 12), seq(11, 14), seq(15, 8), seq(19, 14), seq(12, 11), seq(18, 11),
    seq(15, 14), seq(11, 14), seq(19, 14), seq(15, 15), seq(15, 10),
  ) as LuaTable,

  // Lua: deoxys.lua:49 -- pokefirered/src/field_specials.c:2346 -- indexed by num-1, num in 1..10.
  STEP_CAPS: seq(4, 8, 8, 8, 4, 4, 4, 6, 3, 3) as (number | null)[],

  // Lua: deoxys.lua:60 -- pret sDeoxysObjectPals (entries 1..3 of each 16-colour palette)
  ROCK_PALS,
  // Lua: deoxys.lua:73
  PALETTE_COUNT: len(ROCK_PALS),

  // Lua: deoxys.lua:79
  sourcePalette(): LuaTable {
    return Deoxys.ROCK_PALS[1];
  },

  // Lua: deoxys.lua:84
  clamp(numIn: unknown): number {
    const num = Math.floor(tonumber(numIn) ?? 0);
    if (num < 0) return 0;
    if (num > Deoxys.PALETTE_COUNT - 1) return Deoxys.PALETTE_COUNT - 1;
    return num;
  },

  // Lua: deoxys.lua:92
  palette(num: unknown): LuaTable {
    return Deoxys.ROCK_PALS[Deoxys.clamp(num) + 1];
  },

  // Lua: deoxys.lua:96
  paletteKey(num: unknown): string {
    return format("deoxys_rock_%d", Deoxys.clamp(num));
  },

  // Lua: deoxys.lua:101
  coords(num: unknown): [number, number] {
    const c = Deoxys.COORDS[Deoxys.clamp(num) + 1] ?? Deoxys.COORDS[1];
    return [c[1], c[2]];
  },

  // Lua: deoxys.lua:107
  moveFrames(num: unknown): number {
    return (Deoxys.clamp(num) === 0) ? 60 : 5;
  },

  // Lua: deoxys.lua:112
  stepCap(numIn: unknown): number | null {
    const num = Math.floor(tonumber(numIn) ?? 0);
    return Deoxys.STEP_CAPS[num] ?? null;
  },

  // Lua: deoxys.lua:117
  isBirthIsland(mapId: any): boolean {
    if (mapId == null) return false;
    if (mapId === Deoxys.MAP_ID) return true;
    if (MapCatalog && MapCatalog.mapIdFor) {
      try {
        const id = MapCatalog.mapIdFor(Deoxys.MAP_GROUP, Deoxys.MAP_NUM);
        if (id) return id === mapId;
      } catch { /* pcall */ }
    }
    return false;
  },

  // Lua: deoxys.lua:136
  storeOf(session: any): [any, boolean] {
    const Space: any = SpaceMod;
    if (Space && Space.store && Space.store.vars) return [Space.store, false];
    if (session != null && typeof session === "object" && session.store != null && typeof session.store === "object"
      && session.store.vars) {
      return [session.store, false];
    }
    if (session != null && typeof session === "object") {
      session.flags = session.flags != null && typeof session.flags === "object" ? session.flags : {};
      session.vars = session.vars != null && typeof session.vars === "object" ? session.vars : {};
      return [{ flags: session.flags, vars: session.vars }, true];
    }
    return [null, false];
  },

  // Lua: deoxys.lua:151
  getVar(session: any, id: number): number {
    const [store] = Deoxys.storeOf(session);
    return tonumber(flagsMod().getVar(store, null, id)) ?? 0;
  },

  // Lua: deoxys.lua:156
  setVar(session: any, id: number, value: unknown): void {
    const [store, synthesized] = Deoxys.storeOf(session);
    flagsMod().setVar(store, null, id, value);
    // Only mirror when the store is a view over the session tables; with a live
    // store Space.persistSession owns that write-back.
    if (synthesized && store) {
      store.vars[id] = mod(tonumber(value) ?? 0, 65536);
    }
  },

  // Lua: deoxys.lua:166
  getFlag(session: any, id: number): boolean {
    return flagsMod().getFlag(Deoxys.storeOf(session)[0], null, id) === true;
  },

  // Lua: deoxys.lua:170
  setFlag(session: any, id: number, on?: unknown): void {
    flagsMod().setFlag(Deoxys.storeOf(session)[0], null, id, on !== false);
  },

  // Lua: deoxys.lua:186
  resolveRockObject(): [any, number | null] {
    const Objects = objectsMod();
    if (!(Objects && Objects.find)) return [null, null];
    const eo = Objects.find(Deoxys.LOCALID_ROCK);
    if (eo && tonumber(eo.graphicsId) === Deoxys.OBJ_EVENT_GFX_METEORITE) {
      return [eo, Deoxys.LOCALID_ROCK];
    }
    for (const [id, cand] of pairs<any>(Objects._byId ?? {})) {
      if (cand && tonumber(cand.graphicsId) === Deoxys.OBJ_EVENT_GFX_METEORITE) {
        return [cand, tonumber(id) ?? null];
      }
    }
    return [null, null];
  },

  // Lua: deoxys.lua:202
  applyRockPalette(num: unknown, graphicsIdIn?: unknown): boolean {
    if (!(OwSprites && OwSprites.setObjectPalette)) return false;
    let graphicsId: any = graphicsIdIn;
    if (graphicsId == null) {
      const [eo] = Deoxys.resolveRockObject();
      graphicsId = eo ? eo.graphicsId : eo;
    }
    graphicsId = tonumber(graphicsId);
    if (graphicsId == null) return false;
    return OwSprites.setObjectPalette(graphicsId, Deoxys.paletteKey(num),
      Deoxys.palette(num), Deoxys.sourcePalette());
  },

  // Lua: deoxys.lua:216 -- pret MoveDeoxysObject (field_specials.c:2362)
  moveRock(numIn: unknown): boolean {
    const num = Deoxys.clamp(numIn);
    Deoxys.applyRockPalette(num);
    const D: any = Deoxys;
    if (Audio && Audio.playSe) {
      Audio.playSe(num === 0 ? D.SE_M_CONFUSE_RAY : D.SE_DEOXYS_MOVE);
    }
    const [eo, localId] = Deoxys.resolveRockObject();
    if (!eo) return false;
    const [x, y] = Deoxys.coords(num);
    if (!(FieldEffects && FieldEffects.startMoveDeoxysRock)) {
      return false;
    }
    return FieldEffects.startMoveDeoxysRock(localId, x, y, Deoxys.moveFrames(num)) != null;
  },

  // Lua: deoxys.lua:235 -- pret FldEff_DestroyDeoxysRock
  destroyRock(localId?: any, graphicsId?: any): boolean {
    const [eo, id] = Deoxys.resolveRockObject();
    if (localId == null) localId = id;
    if (graphicsId == null) graphicsId = eo ? eo.graphicsId : eo;
    if (!(FieldEffects && FieldEffects.startDestroyDeoxysRock)) {
      return false;
    }
    return FieldEffects.startDestroyDeoxysRock(localId, graphicsId) != null;
  },

  // Lua: deoxys.lua:247 -- pret IncrementBirthIslandRockStepCount (field_specials.c:2433)
  incrementStepCount(session: any): boolean {
    if (session == null || typeof session !== "object") return false;
    if (!Deoxys.isBirthIsland(session.map)) return false;
    let count = Deoxys.getVar(session, Deoxys.VAR_DEOXYS_INTERACTION_STEP_COUNTER) + 1;
    if (count > 99) count = 0;
    Deoxys.setVar(session, Deoxys.VAR_DEOXYS_INTERACTION_STEP_COUNTER, count);
    return true;
  },

  // Lua: deoxys.lua:258 -- pret Task_DoDeoxysTriangleInteraction (field_specials.c:2325)
  interact(session: any): number {
    if (Deoxys.getFlag(session, Deoxys.FLAG_SYS_DEOXYS_AWAKENED)) {
      return 3;
    }

    let num = Deoxys.getVar(session, Deoxys.VAR_DEOXYS_INTERACTION_NUM);
    const steps = Deoxys.getVar(session, Deoxys.VAR_DEOXYS_INTERACTION_STEP_COUNTER);
    Deoxys.setVar(session, Deoxys.VAR_DEOXYS_INTERACTION_STEP_COUNTER, 0);

    const cap = Deoxys.stepCap(num);
    if (num !== 0 && cap != null && cap < steps) {
      // Walked too far for this position: the rock snaps back to the start.
      Deoxys.moveRock(0);
      Deoxys.setVar(session, Deoxys.VAR_DEOXYS_INTERACTION_NUM, 0);
      return 0;
    } else if (num === 10) {
      Deoxys.setFlag(session, Deoxys.FLAG_SYS_DEOXYS_AWAKENED, true);
      return 2;
    }

    num = num + 1;
    Deoxys.moveRock(num);
    Deoxys.setVar(session, Deoxys.VAR_DEOXYS_INTERACTION_NUM, num);
    return 1;
  },
};

// Lua: deoxys.lua:36 -- pokefirered/include/constants/songs.h
song_fields(Deoxys);

export default Deoxys;
