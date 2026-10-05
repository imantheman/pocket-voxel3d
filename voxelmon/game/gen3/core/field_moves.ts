// Port of gen1recomp src/core/game3/field_moves.lua (GPLv3 + additional terms; see LICENSE.md).
// Game 3 (FRLG / pokefirered) Field Moves Engine
// Handles all HM and utility field moves: Cut, Fly, Surf, Strength, Flash,
// Rock Smash, Waterfall, Dive, Dig, Teleport, Sweet Scent, Softboiled/Milk Drink.
// Supports dual-trigger architecture:
//   1. Party Menu Submenu (SetUpFieldMove_* / fromMenu)
//   2. Overworld A-Press Collision / Object Interaction (tryOW / EventScript_*)
//
// Return shapes (Lua multiple returns -> 0-based tuples):
//   partyMoveUser -> [mon, slot]; softboiledTransfer -> [ok, userHp, targetHp];
//   canPushBoulder -> [ok, tx, ty] (or [false]).
// SYS_FLAGS, GFX_IDS, SE and TEXT are Lua tables with an __index function;
// they are Proxies here (reads compute the value, as the metamethod does).

import { tonumber, truthy } from "../../../import/gen3/lua.ts";
import { gsub } from "../platform/lpattern.ts";
import { ipairs, len, pairs, seq, type LuaTable } from "../platform/lt.ts";
import { MapCatalog } from "../../../import/gen3/map_catalog.ts";
import { Flags } from "./scripting/flags.ts";
import { Profile } from "./profile.ts";
import { Constants } from "./constants.ts";
import { SE as SeIds } from "./se_ids.ts";
import { RomText } from "./rom_text.ts";
import { Pokemon } from "./pokemon.ts";
import { BrailleField } from "./braille_field.ts";
import { Dive } from "./dive.ts";
import { MB } from "./mb.ts";
import { Player as PlayerMod } from "./player.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

export type FieldMoveResult = Record<string, any>;

// Lua: field_moves.lua:59
function activeProfile(): any {
  return Profile.forSession(null);
}

// Lua: field_moves.lua:63
function isRse(): boolean {
  const P = activeProfile();
  return P != null && P.family === "rse";
}

// Lua: field_moves.lua:71 -- include/constants/flags.h:1330
const FRLG_SYS_FLAGS: Record<string, number> = {
  WHITE_FLUTE_ACTIVE: 0x803,
  BLACK_FLUTE_ACTIVE: 0x804,
  USE_STRENGTH: 0x805,
  FLASH_ACTIVE: 0x806,
};

// Lua: field_moves.lua:79 -- pokeemerald/include/constants/flags.h:1398
const RSE_SYS_FLAGS: Record<string, string> = {
  WHITE_FLUTE_ACTIVE: "FLAG_SYS_ENC_UP_ITEM",
  BLACK_FLUTE_ACTIVE: "FLAG_SYS_ENC_DOWN_ITEM",
  USE_STRENGTH: "FLAG_SYS_USE_STRENGTH",
  FLASH_ACTIVE: "FLAG_SYS_USE_FLASH",
};

// Lua: field_moves.lua:96 -- src/event_data.c:49
const FRLG_TEMP_SYS_FLAGS = seq("WHITE_FLUTE_ACTIVE", "BLACK_FLUTE_ACTIVE", "USE_STRENGTH");

// Lua: field_moves.lua:99 -- pokeemerald/src/event_data.c:39
const RSE_TEMP_SYS_FLAGS = seq("WHITE_FLUTE_ACTIVE", "BLACK_FLUTE_ACTIVE", "USE_STRENGTH", "FLAG_SYS_CTRL_OBJ_DELETE",
  "FLAG_NURSE_UNION_ROOM_REMINDER");

// Lua: field_moves.lua:115
const FRLG_GFX_IDS: Record<string, number> = {
  CUT_TREE: 95, // OBJ_EVENT_GFX_CUT_TREE
  ROCK_SMASH_ROCK: 96, // OBJ_EVENT_GFX_ROCK_SMASH_ROCK
  PUSHABLE_BOULDER: 97, // OBJ_EVENT_GFX_PUSHABLE_BOULDER
};

// Lua: field_moves.lua:142 -- pret include/constants/songs.h
const SE_NAMES: Record<string, string> = {
  USE_ITEM: "SE_USE_ITEM",
  BANG: "SE_BANG",
  WARP_OUT: "SE_WARP_OUT",
  CUT: "SE_M_CUT",
  ROCK_SMASH: "SE_M_ROCK_THROW",
  FLASH: "SE_M_REFLECT",
  SWEET_SCENT: "SE_M_SWEET_SCENT",
  DIVE: "SE_M_DIVE",
};

// Lua: field_moves.lua:215
const TEXT_ROM: Record<string, string> = {
  // src/data/party_menu.h:603
  CANT_USE_HERE: "gText_CantUseHere",
  ALREADY_SURFING: "gText_AlreadySurfing",
  CUT_NOTHING: "gText_NothingToCut",
  CANT_SURF_HERE: "gText_CantSurfHere",
  CURRENT_TOO_FAST: "gText_CurrentIsTooFast",
  ENJOY_CYCLING: "gText_EnjoyCycling",
  FLASH_IN_USE: "gText_InUseAlready_PM",
  NOT_ENOUGH_HP: "gText_NotEnoughHp",
  // src/party_menu.c:3928
  BADGE_REQUIRED: "gText_CantUseUntilNewBadge",

  // data/scripts/field_moves.inc:47
  ASK_CUT_TREE: "Text_CutTreeDown",
  TREE_CAN_BE_CUT: "Text_TreeCanBeCutDown",
  USED_MOVE: "Text_MonUsedMove",
  ASK_ROCK_SMASH: "Text_UseRockSmash",
  MON_MAY_SMASH_ROCK: "Text_MonMaySmashRock",
  ASK_STRENGTH: "Text_UseStrength",
  MON_MAY_PUSH_BOULDER: "Text_MonMayPushBoulder",
  USED_STRENGTH: "Text_MonUsedStrengthCanMoveBoulders",
  STRENGTH_ACTIVE: "Text_StrengthMadeMovingBouldersPossible",
  ASK_WATERFALL: "Text_UseWaterfall",
  USED_WATERFALL: "Text_MonUsedWaterfall",
  CANT_WATERFALL: "Text_WallOfWaterCrashingDown",
  NO_SWEET_SCENT_MONS: "Text_LooksLikeNothingHere",

  // data/text/surf.inc:1
  ASK_SURF: "Text_WantToSurf",
  USED_SURF: "Text_UsedSurf",
  CANT_SURF_CURRENT: "Text_CurrentTooFast",
};
// Lua: field_moves.lua:249 -- pokeemerald/data/scripts/field_move_scripts.inc:2
const TEXT_RSE: Record<string, string> = {
  ASK_CUT_TREE: "Text_WantToCut",
  TREE_CAN_BE_CUT: "Text_CantCut",
  USED_MOVE: "Text_MonUsedFieldMove",
  ASK_ROCK_SMASH: "Text_WantToSmash",
  MON_MAY_SMASH_ROCK: "Text_CantSmash",
  ASK_STRENGTH: "Text_WantToStrength",
  MON_MAY_PUSH_BOULDER: "Text_CantStrength",
  USED_STRENGTH: "Text_MonUsedStrength",
  STRENGTH_ACTIVE: "Text_StrengthActivated",
  ASK_WATERFALL: "Text_WantToWaterfall",
  USED_WATERFALL: "Text_MonUsedWaterfall",
  CANT_WATERFALL: "Text_CantWaterfall",
  NO_SWEET_SCENT_MONS: "Text_FailSweetScent",
  ASK_DIVE: "Text_WantToDive",
  CANT_DIVE: "Text_CantDive",
  USED_DIVE: "Text_MonUsedDive",
  ASK_SURFACE: "Text_WantToSurface",
  CANT_SURFACE: "Text_CantSurface",
  // pokeemerald/data/text/surf.inc:1
  ASK_SURF: "gText_WantToUseSurf",
  USED_SURF: "gText_PlayerUsedSurf",
};

// Lua: field_moves.lua:273
function textKey(key: string): string | undefined {
  if (isRse() && TEXT_RSE[key]) return TEXT_RSE[key];
  return TEXT_ROM[key];
}

// The Lua's setmetatable({}, { __index = fn }) tables.
function indexProxy<T>(fn: (key: string) => T): Record<string, T> {
  return new Proxy({} as Record<string, T>, {
    get(_t, key) {
      if (typeof key !== "string") return undefined;
      return fn(key);
    },
  });
}

// Lua: field_moves.lua:745 -- pokeemerald/src/party_menu.c:120
const RSE_MENU_ORDER = seq(
  "CUT", "FLASH", "ROCK_SMASH", "STRENGTH", "SURF", "FLY", "DIVE", "WATERFALL",
  "TELEPORT", "DIG", "SECRET_POWER", "MILK_DRINK", "SOFTBOILED", "SWEET_SCENT",
);

// Lua: field_moves.lua:968 -- pokeemerald/src/fldeff_cut.c:71
const HYPER_CUT: LuaTable = seq(
  seq<any>(-2, -2, seq<any>(1)), seq<any>(-1, -2, seq<any>(1)), seq<any>(0, -2, seq<any>(2)), seq<any>(1, -2, seq<any>(3)), seq<any>(2, -2, seq<any>(3)),
  seq<any>(-2, -1, seq<any>(1)), seq<any>(2, -1, seq<any>(3)), seq<any>(-2, 0, seq<any>(4)), seq<any>(2, 0, seq<any>(6)), seq<any>(-2, 1, seq<any>(7)),
  seq<any>(2, 1, seq<any>(9)), seq<any>(-2, 2, seq<any>(7)), seq<any>(-1, 2, seq<any>(7)), seq<any>(0, 2, seq<any>(8)), seq<any>(1, 2, seq<any>(9)), seq<any>(2, 2, seq<any>(9)),
);

// Lua: field_moves.lua:974
function mbIs(beh: number | null | undefined, ...names: string[]): boolean {
  if (beh == null) return false;
  for (const name of names) {
    const id = MB.id(name);
    if (id != null && beh === id) return true;
  }
  return false;
}

// Lua: field_moves.lua:1046
function label(name: string): number {
  const P = activeProfile();
  return Constants.of(P.id).require("metatile_labels", "METATILE_" + name);
}

// Lua: field_moves.lua:1052 -- pokeemerald/src/fldeff_cut.c:354 SetCutGrassMetatile
const RSE_CUT_GRASS: LuaTable = seq(
  seq<any>(seq("Fortree_LongGrass_Root", "General_LongGrass", "General_TallGrass"), "General_Grass"),
  seq<any>(seq("General_TallGrass_TreeLeft"), "General_Grass_TreeLeft"),
  seq<any>(seq("General_TallGrass_TreeRight"), "General_Grass_TreeRight"),
  seq<any>(seq("Fortree_SecretBase_LongGrass_BottomLeft"), "Fortree_SecretBase_LongGrass_TopLeft"),
  seq<any>(seq("Fortree_SecretBase_LongGrass_BottomMid"), "Fortree_SecretBase_LongGrass_TopMid"),
  seq<any>(seq("Fortree_SecretBase_LongGrass_BottomRight"), "Fortree_SecretBase_LongGrass_TopRight"),
  seq<any>(seq("Lavaridge_NormalGrass", "Lavaridge_AshGrass"), "Lavaridge_LavaField"),
  seq<any>(seq("Fallarbor_NormalGrass", "Fallarbor_AshGrass"), "Fallarbor_AshField"),
  seq<any>(seq("General_TallGrass_TreeUp"), "General_Grass_TreeUp"),
);

export const FieldMoves: Record<string, any> = {
  // Lua: field_moves.lua:21 -- pret include/constants/moves.h
  MOVES: {
    CUT: 15,
    FLY: 19,
    SURF: 57,
    STRENGTH: 70,
    FLASH: 148,
    ROCK_SMASH: 249,
    WATERFALL: 127,
    DIVE: 291,
    DIG: 91,
    TELEPORT: 100,
    SOFTBOILED: 135,
    MILK_DRINK: 208,
    SWEET_SCENT: 230,
    HEADBUTT: 29,
    SECRET_POWER: 290,
  } as Record<string, number>,

  // Lua: field_moves.lua:40
  MOVE_NAME_BY_ID: {} as Record<number, string>,

  // Lua: field_moves.lua:48 -- pret include/constants/flags.h
  BADGE_FLAGS: {
    FLASH: 0x820, // FLAG_BADGE01_GET (Boulder Badge)
    CUT: 0x821, // FLAG_BADGE02_GET (Cascade Badge)
    FLY: 0x822, // FLAG_BADGE03_GET (Thunder Badge)
    STRENGTH: 0x823, // FLAG_BADGE04_GET (Rainbow Badge)
    SURF: 0x824, // FLAG_BADGE05_GET (Soul Badge)
    ROCK_SMASH: 0x825, // FLAG_BADGE06_GET (Marsh Badge)
    WATERFALL: 0x826, // FLAG_BADGE07_GET (Volcano Badge)
    DIVE: 0x827, // FLAG_BADGE08_GET (Earth Badge / RSE Dive)
  } as Record<string, number>,

  // Lua: field_moves.lua:67
  isRse,

  // Lua: field_moves.lua:86
  SYS_FLAGS: indexProxy<number | undefined>((key) => {
    const P = activeProfile();
    if (P.family !== "rse") return FRLG_SYS_FLAGS[key];
    const name = RSE_SYS_FLAGS[key];
    return name ? (Flags.forVersion(P.id).IDS as any)[name] ?? undefined : undefined;
  }),

  // Lua: field_moves.lua:102
  tempSysFlags(): LuaTable {
    const P = activeProfile();
    const rse = P.family === "rse";
    const IDS: any = rse ? Flags.forVersion(P.id).IDS : null;
    const out: LuaTable = [null];
    for (const [, key] of ipairs<string>(rse ? RSE_TEMP_SYS_FLAGS : FRLG_TEMP_SYS_FLAGS)) {
      const id = FieldMoves.SYS_FLAGS[key] ?? (IDS ? IDS[key] : undefined);
      if (id) out[len(out) + 1] = id;
    }
    return out;
  },

  // Lua: field_moves.lua:121
  GFX_IDS: indexProxy<number | undefined>((key) => {
    const P = Profile.forSession(null) as any;
    const names = P.field ? P.field.fieldMoveGfx : undefined;
    if (!names) return FRLG_GFX_IDS[key];
    const name = names[key];
    return name ? Constants.of(P.id).require("event_objects", name) ?? undefined : undefined;
  }),

  // Lua: field_moves.lua:131
  badgeFlag(badgeKey: string): number | null {
    const P: any = Profile.forSession(null);
    if ((P.family ?? "frlg") === "frlg") return FieldMoves.BADGE_FLAGS[badgeKey] ?? null;
    for (const [, b] of ipairs<any>(Flags.forVersion(P.id).BADGES)) {
      if (b.fieldMove === badgeKey) return b.flag;
    }
    return null;
  },

  // Lua: field_moves.lua:152
  SE: indexProxy<number | undefined>((key) => {
    const name = SE_NAMES[key];
    return name ? (SeIds as any)[name] ?? undefined : undefined;
  }),

  // Lua: field_moves.lua:160 -- pokefirered/src/field_specials.c:2296 CutMoveRuinValleyCheck
  RUIN_VALLEY: {
    map: "FR_SIX_ISLAND_RUIN_VALLEY",
    x: 24,
    y: 25,
    facing: "up",
    // pokefirered/include/constants/flags.h:766
    flag: 0x2E3,
    // pokefirered/src/field_specials.c:2312
    doorX: 24,
    doorY: 24,
    // pokefirered/include/constants/metatile_labels.h:207
    doorOpen: 0x358,
  },

  // Lua: field_moves.lua:175 -- fldeff_cut.c sCutGrassMetatileMapping
  CUT_GRASS_METATILES: {
    [0x00D]: 0x001, // General: Plain_Grass -> Plain_Mowed
    [0x00A]: 0x013, // General: ThinTreeTop_Grass -> ThinTreeTop_Mowed
    [0x00B]: 0x00E, // General: WideTreeTopLeft_Grass -> WideTreeTopLeft_Mowed
    [0x00C]: 0x00F, // General: WideTreeTopRight_Grass -> WideTreeTopRight_Mowed
    [0x352]: 0x33E, // CeladonCity: CyclingRoad_Grass -> CyclingRoad_Mowed
    [0x300]: 0x310, // FuchsiaCity: SafariZoneTreeTopLeft_Grass -> SafariZoneTreeTopLeft_Mowed
    [0x301]: 0x311, // FuchsiaCity: SafariZoneTreeTopMiddle_Grass -> SafariZoneTreeTopMiddle_Mowed
    [0x302]: 0x312, // FuchsiaCity: SafariZoneTreeTopRight_Grass -> SafariZoneTreeTopRight_Mowed
    // pokefirered/include/constants/metatile_labels.h:295
    [0x284]: 0x281,
  } as Record<number, number>,

  // Lua: field_moves.lua:190 -- include/constants/metatile_behaviors.h:14
  BEHAVIORS: {
    GRASS: { [0x01]: true, [0x02]: true, [0x03]: true },
    WATER: { [0x10]: true, [0x11]: true, [0x12]: true, [0x13]: true, [0x15]: true },
    WATERFALL: { [0x13]: true },
    DEEP_WATER: { [0x12]: true },
  } as Record<string, Record<number, boolean>>,

  // Lua: field_moves.lua:198 -- src/metatile_behavior.c:594
  isWaterfallBehavior(beh: number | null | undefined): boolean {
    return beh != null && FieldMoves.BEHAVIORS.WATERFALL[beh] === true;
  },

  // Lua: field_moves.lua:203 -- pret include/constants/map_types.h
  MAP_TYPES: {
    TOWN: 1,
    CITY: 2,
    ROUTE: 3,
    UNDERGROUND: 4,
    UNDERWATER: 5,
    OCEAN_ROUTE: 6,
    UNKNOWN: 7,
    INDOOR: 8,
    SECRET_BASE: 9,
  } as Record<string, number>,

  // Lua: field_moves.lua:277
  textKey,

  // Lua: field_moves.lua:279
  TEXT: indexProxy<string | undefined>((key) => {
    const k = textKey(key);
    if (k) return RomText.ascii(k);
    return undefined;
  }),

  // Lua: field_moves.lua:288 -- data/scripts/field_moves.inc:8
  monText(key: string, monName: any, moveId?: any): string {
    const moveName = moveId ? Pokemon.moveName(moveId) : null;
    return RomText.ascii(textKey(key)!, { stringVars: seq(monName, moveName) });
  },

  // Lua: field_moves.lua:295
  normalizeMoveId(move: any): number | null {
    if (typeof move === "number") return move;
    if (typeof move === "string") {
      const upper = gsub(gsub(move.toUpperCase(), "%s+", "_")[0], "%-", "_")[0];
      if (FieldMoves.MOVES[upper]) return FieldMoves.MOVES[upper];
      if (upper === "SOFT_BOILED" || upper === "SOFTBOILED") return FieldMoves.MOVES.SOFTBOILED;
      if (upper === "ROCKSMASH" || upper === "ROCK_SMASH") return FieldMoves.MOVES.ROCK_SMASH;
      if (upper === "SWEETSCENT" || upper === "SWEET_SCENT") return FieldMoves.MOVES.SWEET_SCENT;
      if (upper === "MILKDRINK" || upper === "MILK_DRINK") return FieldMoves.MOVES.MILK_DRINK;
    }
    if (move != null && typeof move === "object" && move.id) {
      return FieldMoves.normalizeMoveId(move.id);
    }
    return null;
  },

  // Lua: field_moves.lua:313 -- [mon, slot0] or [nil, 6]
  partyMoveUser(party: LuaTable, moveIdentifier: any): [any, number] {
    const targetId = FieldMoves.normalizeMoveId(moveIdentifier);
    if (!targetId || !party) return [null, 6];

    for (let slot = 1; slot <= len(party); slot++) {
      const mon = party[slot];
      if (mon && !truthy(mon.isEgg) && !truthy(mon.egg)) {
        const moves = mon.moves ?? [null];
        for (const [, m] of ipairs(moves)) {
          const mId = FieldMoves.normalizeMoveId(m);
          if (mId === targetId) {
            return [mon, slot - 1];
          }
        }
      }
    }
    return [null, 6];
  },

  // Lua: field_moves.lua:333
  hasBadge(ctxOrStore: any, badgeKey: string): boolean {
    const flagId = FieldMoves.badgeFlag(badgeKey);
    if (!flagId) return true;

    // Direct flag store check
    if (ctxOrStore && ctxOrStore.flags) {
      return Flags.getFlag(ctxOrStore, null, flagId);
    }

    // Context table with store or session
    if (ctxOrStore && ctxOrStore.store) {
      return Flags.getFlag(ctxOrStore.store, ctxOrStore.ctx, flagId);
    }

    // Session with badges / flags
    if (ctxOrStore && ctxOrStore.session) {
      const s = ctxOrStore.session;
      if (s.flags && s.flags[flagId] != null) return s.flags[flagId] === true;
      if (s.badges && typeof s.badges === "object") {
        return s.badges[badgeKey] === true || s.badges[flagId] === true;
      }
    }

    // Host save check (player.badges or engineFlags)
    const save = ctxOrStore && (ctxOrStore.save ?? ctxOrStore);
    if (save && save.player && save.player.badges) {
      const b = save.player.badges;
      if (b[badgeKey] != null) return b[badgeKey] === true;
      if (b[flagId] != null) return b[flagId] === true;
    }

    return false;
  },

  // Lua: field_moves.lua:368
  isOutdoors(mapType: unknown): boolean {
    const mt = tonumber(mapType) ?? 0;
    return mt === FieldMoves.MAP_TYPES.TOWN
      || mt === FieldMoves.MAP_TYPES.CITY
      || mt === FieldMoves.MAP_TYPES.ROUTE
      || mt === FieldMoves.MAP_TYPES.OCEAN_ROUTE;
  },

  // Lua: field_moves.lua:377
  isDungeon(mapType: unknown, isCave?: boolean): boolean {
    const mt = tonumber(mapType) ?? 0;
    return isCave === true || mt === FieldMoves.MAP_TYPES.UNDERGROUND;
  },

  // Lua: field_moves.lua:384 -- pokefirered/src/party_menu.c:1511 GetMonNickname
  getMonName(mon: any): string {
    if (!mon) return "POK\xC3\xA9MON";
    if (Pokemon && Pokemon.displayMonName) {
      return Pokemon.displayMonName(mon);
    }
    const nick = mon.nickname;
    if (typeof nick === "string" && nick !== "") return nick;
    if (typeof mon.name === "string" && mon.name !== "") return mon.name;
    return mon.species ?? "POK\xC3\xA9MON";
  },

  // Lua: field_moves.lua:399 -- pokefirered/src/field_specials.c:2296 CutMoveRuinValleyCheck
  ruinValleyCutCheck(ctx?: any): boolean {
    ctx = ctx ?? {};
    const RV = FieldMoves.RUIN_VALLEY;
    const store = ctx.store;
    if (store && Flags.getFlag(store, ctx.ctx, RV.flag) === true) return false;
    const session = ctx.session;
    if (session && session.flags && truthy(session.flags[RV.flag])) return false;
    const mapId = ctx.mapId ?? (session ? session.map : undefined);
    if (mapId !== RV.map) return false;
    let x = ctx.x, y = ctx.y, facing = ctx.facing;
    if (x == null || y == null || facing == null) {
      const P: any = PlayerMod;
      if (!P) return false;
      x = P.cellX; y = P.cellY; facing = P.facing;
    }
    return x === RV.x && y === RV.y && facing === RV.facing;
  },

  // Lua: field_moves.lua:418
  cutFromMenu(ctx: any): FieldMoveResult {
    if (!FieldMoves.hasBadge(ctx, "CUT")) {
      return { ok: false, text: FieldMoves.TEXT.BADGE_REQUIRED, badge: "CUT" };
    }

    const mon = ctx.mon ?? FieldMoves.partyMoveUser(ctx.party, "CUT")[0];

    // pokefirered/src/fldeff_cut.c:123 SetUpFieldMove_Cut
    if (ctx.isDottedHoleDoor || FieldMoves.ruinValleyCutCheck(ctx)) {
      return {
        ok: true,
        action: "dotted_hole",
        mon,
        se: FieldMoves.SE.CUT,
      };
    }

    // 1) Check facing Cut Tree object
    if (ctx.facingObject && (ctx.facingObject.gfx === FieldMoves.GFX_IDS.CUT_TREE
      || ctx.facingObject.graphicsId === FieldMoves.GFX_IDS.CUT_TREE)) {
      return {
        ok: true,
        action: "cut_tree",
        target: ctx.facingObject,
        mon,
        se: FieldMoves.SE.CUT,
      };
    }

    // pokeemerald/src/fldeff_cut.c:156
    if (isRse() && ctx.cutGrassQuery) {
      const plan = FieldMoves.cutGrassPlan(ctx.cutGrassQuery, ctx.hyperCutter === true);
      if (plan) {
        return { ok: true, action: "cut_grass", mon, se: FieldMoves.SE.CUT, cutPlan: plan };
      }
      return { ok: false, text: FieldMoves.TEXT.CUT_NOTHING };
    }

    // 2) Check facing / standing 3x3 grass
    if (ctx.hasCuttableGrass) {
      return {
        ok: true,
        action: "cut_grass",
        mon,
        se: FieldMoves.SE.CUT,
      };
    }

    return { ok: false, text: FieldMoves.TEXT.CUT_NOTHING };
  },

  // Lua: field_moves.lua:470
  flashFromMenu(ctx: any): FieldMoveResult {
    if (!FieldMoves.hasBadge(ctx, "FLASH")) {
      return { ok: false, text: FieldMoves.TEXT.BADGE_REQUIRED, badge: "FLASH" };
    }

    // pokeemerald/src/fldeff_flash.c:76
    if (Constants.versionOf(ctx.session) === "emerald"
      && BrailleField.shouldDoRegisteel(ctx.session)) {
      return { ok: true, action: "braille_registeel", mon: ctx.mon ?? FieldMoves.partyMoveUser(ctx.party, "FLASH")[0] };
    }

    // src/party_menu.c:4047 DisplayCantUseFlashMessage
    if (ctx.isFlashActive || (ctx.store && Flags.getFlag(ctx.store, ctx.ctx, FieldMoves.SYS_FLAGS.FLASH_ACTIVE))) {
      return { ok: false, text: FieldMoves.TEXT.FLASH_IN_USE };
    }

    if (!ctx.isDarkCave && !ctx.isCave) {
      return { ok: false, text: FieldMoves.TEXT.CANT_USE_HERE };
    }

    const mon = ctx.mon ?? FieldMoves.partyMoveUser(ctx.party, "FLASH")[0];

    // data/scripts/flash.inc:1 EventScript_FldEffFlash
    return {
      ok: true,
      action: "flash",
      mon,
      se: FieldMoves.SE.FLASH,
      flag: FieldMoves.SYS_FLAGS.FLASH_ACTIVE,
    };
  },

  // Lua: field_moves.lua:503
  surfFromMenu(ctx: any): FieldMoveResult {
    if (!FieldMoves.hasBadge(ctx, "SURF")) {
      return { ok: false, text: FieldMoves.TEXT.BADGE_REQUIRED, badge: "SURF" };
    }

    if (ctx.isSurfing) {
      return { ok: false, text: FieldMoves.TEXT.ALREADY_SURFING };
    }

    // src/party_menu.c:4077 DisplayCantUseSurfMessage
    if (ctx.isFastCurrent) {
      return { ok: false, text: FieldMoves.TEXT.CURRENT_TOO_FAST };
    }

    if (!ctx.isFacingWater) {
      const map = ctx.mapId ?? (ctx.session ? ctx.session.map : undefined);
      if (map === MapCatalog.pretToEngine("Route17") || map === MapCatalog.pretToEngine("Route18")) {
        return { ok: false, text: FieldMoves.TEXT.ENJOY_CYCLING };
      }
      return { ok: false, text: FieldMoves.TEXT.CANT_SURF_HERE };
    }

    const mon = ctx.mon ?? FieldMoves.partyMoveUser(ctx.party, "SURF")[0];

    // src/party_menu.c:4055 FieldCallback_Surf
    return {
      ok: true,
      action: "surf",
      mon,
    };
  },

  // Lua: field_moves.lua:537
  strengthFromMenu(ctx: any): FieldMoveResult {
    if (!FieldMoves.hasBadge(ctx, "STRENGTH")) {
      return { ok: false, text: FieldMoves.TEXT.BADGE_REQUIRED, badge: "STRENGTH" };
    }

    const mon = ctx.mon ?? FieldMoves.partyMoveUser(ctx.party, "STRENGTH")[0];
    const monName = FieldMoves.getMonName(mon);

    return {
      ok: true,
      action: "strength",
      mon,
      flag: FieldMoves.SYS_FLAGS.USE_STRENGTH,
      text: FieldMoves.monText("USED_STRENGTH", monName),
    };
  },

  // Lua: field_moves.lua:555
  rockSmashFromMenu(ctx: any): FieldMoveResult {
    if (!FieldMoves.hasBadge(ctx, "ROCK_SMASH")) {
      return { ok: false, text: FieldMoves.TEXT.BADGE_REQUIRED, badge: "ROCK_SMASH" };
    }

    // pokeemerald/src/fldeff_rocksmash.c:125
    if (Constants.versionOf(ctx.session) === "emerald"
      && BrailleField.shouldDoRegirock(ctx.session)) {
      return { ok: true, action: "braille_regirock", mon: ctx.mon ?? FieldMoves.partyMoveUser(ctx.party, "ROCK_SMASH")[0] };
    }

    if (!ctx.facingObject || (ctx.facingObject.gfx !== FieldMoves.GFX_IDS.ROCK_SMASH_ROCK
      && ctx.facingObject.graphicsId !== FieldMoves.GFX_IDS.ROCK_SMASH_ROCK)) {
      return { ok: false, text: FieldMoves.TEXT.CANT_USE_HERE };
    }

    const mon = ctx.mon ?? FieldMoves.partyMoveUser(ctx.party, "ROCK_SMASH")[0];

    return {
      ok: true,
      action: "rock_smash",
      target: ctx.facingObject,
      mon,
      se: FieldMoves.SE.ROCK_SMASH,
    };
  },

  // Lua: field_moves.lua:584 -- src/party_menu.c:4118
  waterfallFromMenu(ctx: any): FieldMoveResult {
    if (!FieldMoves.hasBadge(ctx, "WATERFALL")) {
      return { ok: false, text: FieldMoves.TEXT.BADGE_REQUIRED, badge: "WATERFALL" };
    }

    if (!ctx.isSurfing || !ctx.isFacingWaterfall || ctx.facing !== "up") {
      return { ok: false, text: FieldMoves.TEXT.CANT_USE_HERE };
    }

    const mon = ctx.mon ?? FieldMoves.partyMoveUser(ctx.party, "WATERFALL")[0];

    return {
      ok: true,
      action: "waterfall",
      mon,
    };
  },

  // Lua: field_moves.lua:603
  flyFromMenu(ctx: any): FieldMoveResult {
    if (!FieldMoves.hasBadge(ctx, "FLY")) {
      return { ok: false, text: FieldMoves.TEXT.BADGE_REQUIRED, badge: "FLY" };
    }

    if (!FieldMoves.isOutdoors(ctx.mapType)) {
      return { ok: false, text: FieldMoves.TEXT.CANT_USE_HERE };
    }

    const mon = ctx.mon ?? FieldMoves.partyMoveUser(ctx.party, "FLY")[0];

    return {
      ok: true,
      action: "fly",
      mon,
    };
  },

  // Lua: field_moves.lua:622
  digFromMenu(ctx: any): FieldMoveResult {
    if (!FieldMoves.isDungeon(ctx.mapType, ctx.isCave) || !ctx.canEscapeRope) {
      return { ok: false, text: FieldMoves.TEXT.CANT_USE_HERE };
    }

    const mon = ctx.mon ?? FieldMoves.partyMoveUser(ctx.party, "DIG")[0];

    return {
      ok: true,
      action: "dig",
      mon,
      warp: ctx.escapeWarp,
    };
  },

  // Lua: field_moves.lua:638
  teleportFromMenu(ctx: any): FieldMoveResult {
    if (!FieldMoves.isOutdoors(ctx.mapType)) {
      return { ok: false, text: FieldMoves.TEXT.CANT_USE_HERE };
    }

    const mon = ctx.mon ?? FieldMoves.partyMoveUser(ctx.party, "TELEPORT")[0];

    return {
      ok: true,
      action: "teleport",
      mon,
      se: FieldMoves.SE.WARP_OUT,
      warp: ctx.lastHealWarp ?? ctx.respawnPoint,
    };
  },

  // Lua: field_moves.lua:655
  sweetScentFromMenu(ctx: any): FieldMoveResult {
    const mon = ctx.mon ?? FieldMoves.partyMoveUser(ctx.party, "SWEET_SCENT")[0];

    return {
      ok: true,
      action: "sweet_scent",
      mon,
      se: FieldMoves.SE.SWEET_SCENT,
      hasEncounter: ctx.hasWildEncounters === true,
      failText: FieldMoves.TEXT.NO_SWEET_SCENT_MONS,
    };
  },

  // Lua: field_moves.lua:669
  softboiledFromMenu(ctx: any): FieldMoveResult {
    const mon = ctx.mon;
    if (!mon) return { ok: false, text: FieldMoves.TEXT.CANT_USE_HERE };

    const maxHp = mon.maxHp ?? (mon.stats ? mon.stats.hp : undefined) ?? 0;
    const curHp = mon.hp ?? 0;
    const cost = Math.floor(maxHp / 5);

    if (curHp <= cost || cost <= 0) {
      return { ok: false, text: FieldMoves.TEXT.NOT_ENOUGH_HP };
    }

    return {
      ok: true,
      action: "softboiled",
      mon,
      cost,
    };
  },

  // Lua: field_moves.lua:690
  softboiledTargetOk(userMon: any, targetMon: any): boolean {
    if (!userMon || !targetMon) return false;
    if (userMon === targetMon) return false;
    if (truthy(targetMon.isEgg) || truthy(targetMon.egg)) return false;

    const curHp = targetMon.hp ?? 0;
    const maxHp = targetMon.maxHp ?? (targetMon.stats ? targetMon.stats.hp : undefined) ?? 0;
    return curHp > 0 && curHp < maxHp;
  },

  // Lua: field_moves.lua:701
  softboiledTransfer(userMon: any, targetMon: any, cost?: number): [boolean, number | null, number | null] {
    if (!FieldMoves.softboiledTargetOk(userMon, targetMon)) {
      return [false, null, null];
    }

    cost = cost ?? Math.floor((userMon.maxHp ?? 1) / 5);
    const userHpBefore = userMon.hp ?? 0;
    const targetHpBefore = targetMon.hp ?? 0;
    const targetMaxHp = targetMon.maxHp ?? (targetMon.stats ? targetMon.stats.hp : undefined) ?? targetHpBefore;

    userMon.hp = Math.max(0, userHpBefore - cost);
    targetMon.hp = Math.min(targetMaxHp, targetHpBefore + cost);

    return [true, userMon.hp, targetMon.hp];
  },

  // Lua: field_moves.lua:718 -- pokeemerald/src/party_menu.c:3916 SetUpFieldMove_Dive
  diveFromMenu(ctx: any): FieldMoveResult {
    if (!FieldMoves.hasBadge(ctx, "DIVE")) {
      return { ok: false, text: FieldMoves.TEXT.BADGE_REQUIRED, badge: "DIVE" };
    }
    const [code, dest] = Dive.trySetDiveWarp(ctx.session);
    if (code === 0) {
      return { ok: false, text: FieldMoves.TEXT.CANT_USE_HERE };
    }
    let mon = ctx.mon, slot: number | null = null;
    if (!mon) [mon, slot] = FieldMoves.partyMoveUser(ctx.party, "DIVE");
    return { ok: true, action: "dive", mon, slot, diveCode: code, dest };
  },

  // Lua: field_moves.lua:733 -- pokeemerald/src/fldeff_misc.c:547 SetUpFieldMove_SecretPower
  secretPowerFromMenu(_ctx: any): FieldMoveResult {
    // NOT FAITHFUL: Emerald only -- src.core.game3.rse.init (secret bases) is not ported.
    throw new Error("NOT FAITHFUL: Emerald only: src.core.game3.rse.init (SetUpFieldMove_SecretPower)");
  },

  // Lua: field_moves.lua:750
  menuOrder(): LuaTable | null {
    if (isRse()) return RSE_MENU_ORDER;
    return null;
  },

  // Lua: field_moves.lua:756 -- pokeemerald/src/party_menu.c:3725
  menuBadgeKey(moveName: string): string | null {
    if (!isRse()) return null;
    for (let i = 1; i <= 8; i++) {
      if (RSE_MENU_ORDER[i] === moveName) return moveName;
    }
    return null;
  },

  // Lua: field_moves.lua:765 (filled below, once the handlers exist)
  MENU_HANDLERS: {} as Record<number, (ctx: any) => FieldMoveResult>,

  // Lua: field_moves.lua:783
  fromMenu(moveIdentifier: any, ctx: any): FieldMoveResult {
    const moveId = FieldMoves.normalizeMoveId(moveIdentifier);
    const handler = moveId ? FieldMoves.MENU_HANDLERS[moveId] : null;
    if (!handler) {
      return { ok: false, text: FieldMoves.TEXT.CANT_USE_HERE };
    }
    return handler(ctx);
  },

  // Lua: field_moves.lua:795 -- EventScript_CutTree
  tryCutOW(ctx: any): FieldMoveResult {
    const [mon, slot] = FieldMoves.partyMoveUser(ctx.party, "CUT");
    const hasBadge = FieldMoves.hasBadge(ctx, "CUT");

    if (!mon || !hasBadge) {
      return {
        ok: false,
        text: FieldMoves.TEXT.TREE_CAN_BE_CUT,
      };
    }

    const monName = FieldMoves.getMonName(mon);
    return {
      ok: true,
      ask: FieldMoves.TEXT.ASK_CUT_TREE,
      action: "cut_tree",
      mon,
      slot,
      se: FieldMoves.SE.CUT,
      target: ctx.facingObject,
      text: FieldMoves.monText("USED_MOVE", monName, FieldMoves.MOVES.CUT),
    };
  },

  // Lua: field_moves.lua:820 -- EventScript_RockSmash
  tryRockSmashOW(ctx: any): FieldMoveResult {
    const [mon, slot] = FieldMoves.partyMoveUser(ctx.party, "ROCK_SMASH");
    const hasBadge = FieldMoves.hasBadge(ctx, "ROCK_SMASH");

    if (!mon || !hasBadge) {
      return {
        ok: false,
        text: FieldMoves.TEXT.MON_MAY_SMASH_ROCK,
      };
    }

    const monName = FieldMoves.getMonName(mon);
    return {
      ok: true,
      ask: FieldMoves.TEXT.ASK_ROCK_SMASH,
      action: "rock_smash",
      mon,
      slot,
      se: FieldMoves.SE.ROCK_SMASH,
      target: ctx.facingObject,
      text: FieldMoves.monText("USED_MOVE", monName, FieldMoves.MOVES.ROCK_SMASH),
    };
  },

  // Lua: field_moves.lua:845 -- EventScript_StrengthBoulder
  tryStrengthOW(ctx: any): FieldMoveResult {
    // pokeemerald/data/scripts/field_move_scripts.inc:122
    if (isRse() && !FieldMoves.hasBadge(ctx, "STRENGTH")) {
      return { ok: false, text: FieldMoves.TEXT.MON_MAY_PUSH_BOULDER };
    }
    const isStrengthActive = ctx.isStrengthActive || (ctx.store && Flags.getFlag(ctx.store, ctx.ctx, FieldMoves.SYS_FLAGS.USE_STRENGTH));
    if (isStrengthActive) {
      return {
        ok: false,
        alreadyActive: true,
        text: FieldMoves.TEXT.STRENGTH_ACTIVE,
      };
    }

    const [mon, slot] = FieldMoves.partyMoveUser(ctx.party, "STRENGTH");
    const hasBadge = FieldMoves.hasBadge(ctx, "STRENGTH");

    if (!mon || !hasBadge) {
      return {
        ok: false,
        text: FieldMoves.TEXT.MON_MAY_PUSH_BOULDER,
      };
    }

    const monName = FieldMoves.getMonName(mon);
    return {
      ok: true,
      ask: FieldMoves.TEXT.ASK_STRENGTH,
      action: "strength",
      mon,
      slot,
      flag: FieldMoves.SYS_FLAGS.USE_STRENGTH,
      text: FieldMoves.monText("USED_STRENGTH", monName),
    };
  },

  // Lua: field_moves.lua:882
  trySurfOW(ctx: any): FieldMoveResult {
    if (ctx.isSurfing) return { ok: false };
    if (ctx.isFastCurrent) {
      return { ok: false, text: FieldMoves.TEXT.CANT_SURF_CURRENT };
    }
    if (!ctx.isFacingWater) return { ok: false };

    const [mon, slot] = FieldMoves.partyMoveUser(ctx.party, "SURF");
    const hasBadge = FieldMoves.hasBadge(ctx, "SURF");

    if (!mon || !hasBadge) {
      // Silent failure in GBA / Gen2 for pressing A on water without Surf
      return { ok: false };
    }

    const monName = FieldMoves.getMonName(mon);
    return {
      ok: true,
      ask: FieldMoves.TEXT.ASK_SURF,
      action: "surf",
      mon,
      slot,
      text: FieldMoves.monText("USED_SURF", monName),
    };
  },

  // Lua: field_moves.lua:910 -- src/field_control_avatar.c:608, data/scripts/field_moves.inc:178
  tryWaterfallOW(ctx: any): FieldMoveResult {
    if (!ctx.isFacingWaterfall) {
      return { ok: false };
    }

    const [mon, slot] = FieldMoves.partyMoveUser(ctx.party, "WATERFALL");
    const hasBadge = FieldMoves.hasBadge(ctx, "WATERFALL");
    const surfingNorth = ctx.isSurfing && ctx.facing === "up";

    if (!mon || !hasBadge || !surfingNorth) {
      return {
        ok: false,
        text: FieldMoves.TEXT.CANT_WATERFALL,
      };
    }

    const monName = FieldMoves.getMonName(mon);
    return {
      ok: true,
      ask: FieldMoves.TEXT.ASK_WATERFALL,
      action: "waterfall",
      mon,
      slot,
      text: FieldMoves.monText("USED_WATERFALL", monName),
    };
  },

  // Lua: field_moves.lua:944 -- pokefirered/src/fldeff_cut.c:200
  mowGrass3x3(cx: number, cy: number, getMetatileFn?: (x: number, y: number) => any,
    setMetatileFn?: (x: number, y: number, mid: number) => void,
    sameElevationFn?: (x: number, y: number) => boolean): number {
    if (!getMetatileFn || !setMetatileFn) return 0;
    let count = 0;

    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (!sameElevationFn || sameElevationFn(x, y)) {
          const mid = getMetatileFn(x, y);
          // pokefirered/src/fldeff_cut.c:237
          const newMid = mid != null ? FieldMoves.CUT_GRASS_METATILES[mid] : undefined;
          if (newMid != null) {
            setMetatileFn(x, y, newMid);
            count = count + 1;
          }
        }
      }
    }

    return count;
  },

  // Lua: field_moves.lua:985 -- pokeemerald/src/metatile_behavior.c:175
  isPokeGrass(beh: number | null | undefined): boolean { return mbIs(beh, "TALL_GRASS", "LONG_GRASS"); },
  // Lua: field_moves.lua:987 -- pokeemerald/src/metatile_behavior.c:753
  isAshGrass(beh: number | null | undefined): boolean { return mbIs(beh, "ASHGRASS"); },
  // Lua: field_moves.lua:989 -- pokeemerald/src/metatile_behavior.c:1269
  isCuttableGrass(beh: number | null | undefined): boolean {
    return mbIs(beh, "TALL_GRASS", "LONG_GRASS", "ASHGRASS", "LONG_GRASS_SOUTH_EDGE");
  },

  // Lua: field_moves.lua:994 -- pokeemerald/src/fldeff_cut.c:138 SetUpFieldMove_Cut
  cutGrassPlan(q: any, hyper?: boolean): any {
    const tiles: Record<number, boolean> = {};
    const cutTiles: Record<number, boolean> = {};
    let found = false;
    for (let i = 0; i <= 2; i++) {
      const y = i - 1 + q.y;
      for (let j = 0; j <= 2; j++) {
        const x = j - 1 + q.x;
        if (q.elevationAt(x, y) === q.elevation) {
          const beh = q.behavior(x, y);
          if (FieldMoves.isPokeGrass(beh) || FieldMoves.isAshGrass(beh)) {
            tiles[6 + i * 5 + j] = true;
            found = true;
          }
          if (q.impassable(x, y)) {
            cutTiles[i * 3 + j] = false;
          } else {
            cutTiles[i * 3 + j] = true;
            if (FieldMoves.isCuttableGrass(beh)) tiles[6 + i * 5 + j] = true;
          }
        } else {
          cutTiles[i * 3 + j] = false;
        }
      }
    }
    if (hyper) {
      for (const [, h] of ipairs<any>(HYPER_CUT)) {
        const x = q.x + h[1], y = q.y + h[2];
        let ok = true;
        for (const [, need] of ipairs<number>(h[3])) {
          if (!cutTiles[need - 1]) { ok = false; break; }
        }
        if (ok && q.elevationAt(x, y) === q.elevation) {
          const id = h[2] * 5 + 12 + h[1];
          const beh = q.behavior(x, y);
          if (FieldMoves.isPokeGrass(beh) || FieldMoves.isAshGrass(beh)) {
            tiles[id] = true;
            found = true;
          } else if (FieldMoves.isCuttableGrass(beh)) {
            tiles[id] = true;
          }
        }
      }
    }
    if (!found) return null;
    const out: any = { side: hyper ? 5 : 3, reach: hyper ? 2 : 1, cells: [null] };
    for (let i = 0; i <= 24; i++) {
      if (tiles[i]) out.cells[len(out.cells) + 1] = { x: q.x + (i % 5) - 2, y: q.y + Math.floor(i / 5) - 2 };
    }
    return out;
  },

  // Lua: field_moves.lua:1064
  cutGrassMetatile(mid: number): number | null {
    for (const [, row] of ipairs<any>(RSE_CUT_GRASS)) {
      for (const [, from] of ipairs<string>(row[1])) {
        if (mid === label(from)) return label(row[2]);
      }
    }
    return null;
  },

  // Lua: field_moves.lua:1074 -- pokeemerald/src/fldeff_cut.c:417 SetCutGrassMetatiles
  fixLongGrass(x: number, y: number, side: number, getMid: (x: number, y: number) => any,
    setMid: (x: number, y: number, mid: number) => void): void {
    const longGrass = label("General_LongGrass"), grass = label("General_Grass"), root = label("Fortree_LongGrass_Root");
    const topL = label("Fortree_SecretBase_LongGrass_TopLeft"), topM = label("Fortree_SecretBase_LongGrass_TopMid"),
      topR = label("Fortree_SecretBase_LongGrass_TopRight");
    const botL = label("Fortree_SecretBase_LongGrass_BottomLeft"),
      botM = label("Fortree_SecretBase_LongGrass_BottomMid"), botR = label("Fortree_SecretBase_LongGrass_BottomRight");
    const lowerY = y + side;
    for (let i = 0; i <= side - 1; i++) {
      const cx = x + i;
      if (getMid(cx, y) === longGrass) {
        const below = getMid(cx, y + 1);
        if (below === grass) setMid(cx, y + 1, root);
        else if (below === topL) setMid(cx, y + 1, botL);
        else if (below === topM) setMid(cx, y + 1, botM);
        else if (below === topR) setMid(cx, y + 1, botR);
      }
      if (getMid(cx, lowerY) === grass) {
        if (getMid(cx, lowerY + 1) === root) setMid(cx, lowerY + 1, grass);
        if (getMid(cx, lowerY + 1) === botL) setMid(cx, lowerY + 1, topL);
        if (getMid(cx, lowerY + 1) === botM) setMid(cx, lowerY + 1, topM);
        if (getMid(cx, lowerY + 1) === botR) setMid(cx, lowerY + 1, topR);
      }
    }
  },

  // Lua: field_moves.lua:1102
  canPushBoulder(boulderObj: any, dir: string, isPassableFn: (x: number, y: number) => boolean): [boolean, number?, number?] {
    if (!boulderObj || !dir || !isPassableFn) return [false];

    const DELTA: Record<string, [null, number, number]> = {
      up: [null, 0, -1],
      down: [null, 0, 1],
      left: [null, -1, 0],
      right: [null, 1, 0],
    };

    const d = DELTA[dir];
    if (!d) return [false];

    const baseX = tonumber(boulderObj.x) ?? tonumber(boulderObj.cellX);
    const baseY = tonumber(boulderObj.y) ?? tonumber(boulderObj.cellY);
    if (baseX == null || baseY == null) return [false];

    const targetX = baseX + d[1];
    const targetY = baseY + d[2];

    return [isPassableFn(targetX, targetY), targetX, targetY];
  },
};

// Lua: field_moves.lua:41
for (const [name, id] of pairs<number>(FieldMoves.MOVES)) {
  FieldMoves.MOVE_NAME_BY_ID[id] = name as string;
}

// Lua: field_moves.lua:765 -- Jumptable of menu field move handlers
{
  const H = FieldMoves.MENU_HANDLERS, MV = FieldMoves.MOVES;
  H[MV.CUT] = FieldMoves.cutFromMenu;
  H[MV.FLY] = FieldMoves.flyFromMenu;
  H[MV.SURF] = FieldMoves.surfFromMenu;
  H[MV.STRENGTH] = FieldMoves.strengthFromMenu;
  H[MV.FLASH] = FieldMoves.flashFromMenu;
  H[MV.ROCK_SMASH] = FieldMoves.rockSmashFromMenu;
  H[MV.WATERFALL] = FieldMoves.waterfallFromMenu;
  H[MV.DIG] = FieldMoves.digFromMenu;
  H[MV.TELEPORT] = FieldMoves.teleportFromMenu;
  H[MV.SWEET_SCENT] = FieldMoves.sweetScentFromMenu;
  H[MV.SOFTBOILED] = FieldMoves.softboiledFromMenu;
  H[MV.MILK_DRINK] = FieldMoves.softboiledFromMenu;
  H[MV.DIVE] = FieldMoves.diveFromMenu;
  H[MV.SECRET_POWER] = FieldMoves.secretPowerFromMenu;
}

export default FieldMoves;
