// The seven HM field moves, as the love-free half of
// engine/events/overworld.asm: "may this move be used from here", "what does
// it do to the tile", and "which line does it print when it can't".
// A port of gen1recomp src/world/gen2/FieldMoves.lua at bdfac727 (MIT).
//
// Every routine in that file comes in two flavours and the port needs both:
//
//   *Function / Try*FromMenu   the PACK / party-submenu path. Checks the
//                              BADGE first (CheckBadge, which prints
//                              "Sorry! A new BADGE is required." itself), and
//                              assumes the mon is already chosen.
//   Try*OW                     the A-press path out of TryTileCollisionEvent.
//                              Checks the MOVE first (CheckPartyMove), then
//                              the badge through CheckEngineFlag -- CheckBadge
//                              with the text stripped off, so a badgeless A
//                              press is silent, not a refusal.
//
// The two orders are why a tree you cannot cut says "This tree can be CUT!"
// and stops, while CUT off the menu with no HIVEBADGE says "Sorry! A new BADGE
// is required." Keep them apart.
//
// Nothing here touches the save writer or the map: a routine is handed a
// context table (World:fieldContext builds it) and hands back a result:
//   { ok: false }                      declined outright, NOTHING printed
//                                      (TryHeadbuttOW's `ret nc`, TrySurfOW's
//                                      `.quit`)
//   { ok: false, text, badge? }        a refusal with a line, `badge` set when
//                                      it was CheckBadge that refused
//   { ok: true,  ask, ... }            a yesorno first, then the action
//   { ok: true,  action: "cut", ... }  run it now
// `action` names the World method that carries it out; everything else in the
// table is that action's argument.
//
// Port shapes: blockReplacement / somethingToCut / somethingToWhirlpool return
// a TUPLE [replacement, animation] | undefined (Lua's two values);
// softboiledTransfer returns [before, after] | undefined; partyMoveUser
// returns the mon alone (every caller reads only the mon).

import { GameVersion } from "../shared/core/GameVersion.ts";
import { Permissions } from "./Permissions.ts";
import { Runtime } from "../shared/mods/Runtime.ts";
import { Strings } from "../shared/core/Strings.ts";
import { truthy } from "../platform/lua.ts";

type Coll = number | null | undefined;

/** World:fieldContext's table (and the bare tables tests hand in). */
export interface FieldCtx {
  save?: any;
  data?: any;
  party?: any[];
  mon?: any;
  facing?: string;
  facingColl?: Coll;
  playerColl?: Coll;
  upColl?: Coll;
  facingBlock?: number;
  tileset?: string;
  playerState?: string;
  environment?: string;
  alwaysOnBike?: unknown;
  strengthActive?: unknown;
  dark?: unknown;
  canEscapeRope?: unknown;
  facingObject?: any;
  openAerodactylWall?: () => unknown;
  [key: string]: any;
}

export interface FieldResult {
  ok: boolean;
  text?: string;
  badge?: string;
  took?: boolean;
  ask?: string;
  action?: string;
  replacement?: number;
  animation?: number;
  mon?: any;
  state?: string;
  after?: string;
  object?: any;
  lastTalked?: number;
  cost?: number;
  inMenu?: boolean;
}

export interface BadgeFlag {
  store: "badges" | "kantoBadges";
  name: string;
}

export interface FlyPointRow {
  landmark: string;
  spawn: string;
  flag: number;
  name: string;
  /** pokegold's id, kept by bindEngineFlags before it rebinds `flag` by name. */
  goldFlag?: number;
}

export interface FlyPoint {
  landmark: string;
  spawn: string;
  index: any;
  name: any;
}

/** { facing block -> [replacement block, animation type] } per tileset. */
export type BlockTable = Record<string, Record<number, [number, number]>>;

type MenuFn = (ctx: FieldCtx) => FieldResult;

// Lua: FieldMoves.lua:232-242 -- CheckPartyMove (engine/events/overworld.asm):
// the first party slot holding move `moveId`. The cart leaves that slot in
// wCurPartyMon; the Lua also returned the 1-based slot, which no caller reads.
// EGG slots are skipped by the cart's `.next`.
function findMoveUser(party: any[] | undefined, moveId: unknown): any {
  for (const mon of party ?? []) {
    if (!truthy(mon.egg)) {
      for (const move of mon.moves ?? []) {
        const id = move !== null && typeof move === "object" ? move.id : move;
        if (id === moveId) return mon;
      }
    }
  }
  return undefined;
}

// Lua: FieldMoves.lua:244-246
function partyMoveUserVanilla(moveId: unknown, ctx: any): any {
  return findMoveUser(ctx ? ctx.party : undefined, moveId);
}

// Lua: FieldMoves.lua:455-466 -- COLL_RIGHT_WALL / LEFT / UP, the
// HI_NYBBLE_SIDE_WALLS rows that are actually used, plus the unused remainder
// of the block for completeness.
const BLOCKED_BY: Record<number, Partial<Record<string, true>>> = {
  0xb0: { right: true },
  0xb1: { left: true },
  0xb2: { up: true },
  0xb3: { down: true },
  0xb4: { down: true, right: true },
  0xb5: { down: true, left: true },
  0xb6: { up: true, right: true },
  0xb7: { up: true, left: true },
};

// Lua: FieldMoves.lua:585-592
function badgeGate(ctx: FieldCtx, move: string): FieldResult | undefined {
  const badge = FieldMoves.BADGE[move];
  if (FieldMoves.hasBadge(ctx.save, badge)) return undefined;
  // CheckBadge queues .BadgeRequiredText itself and every caller then exits
  // the jumptable, so this is a refusal WITH a line.
  return { ok: false, badge, text: FieldMoves.TEXT.BADGE_REQUIRED };
}

// Lua: FieldMoves.lua:719-720 -- ../pokecrystal/constants/map_object_constants.asm:145
const SPRITEMOVEDATA_SMASHABLE_ROCK = 0x18;

// Lua: FieldMoves.lua:807-809
function softboiledMaxHp(mon: any): number {
  return (mon ? (mon.maxHp ?? (mon.stats ? mon.stats.hp : undefined)) : undefined) ?? 0;
}

export const FieldMoves = {
  // ---------------------------------------------------------------- text
  // Lua: FieldMoves.lua:46-110 -- data/text/common_1.asm and common_2.asm, in
  // the port's own TextBox markers: \n is the second line (`line`), \f a page
  // break (`para`), and {STRBUF} is wStringBuffer2 -- GetPartyNickname fills
  // it, so it is always the nickname of the mon CheckPartyMove picked.
  // Transcribed because engine/events/overworld.asm names each label directly
  // and the extractor only walks reachable SCRIPT pointers. `#` is the
  // four-tile POKé compression byte.
  TEXT: {
    BADGE_REQUIRED: Strings.source("Sorry! A new BADGE\nis required."),
    CANT_USE_HERE: Strings.source("Can't use that\nhere."),
    // ../pokecrystal/data/text/common_2.asm:1516 _PokemonNotEnoughHPText
    NOT_ENOUGH_HP: Strings.source("Not enough HP!"),

    USE_CUT: Strings.source("{STRBUF} used\nCUT!"),
    CUT_NOTHING: Strings.source("There's nothing to\nCUT here."),
    ASK_CUT: Strings.source("This tree can be\nCUT!"
      + "\fWant to use CUT?"),
    CAN_CUT: Strings.source("This tree can be\nCUT!"),

    BLINDING_FLASH: Strings.source("A blinding FLASH\nlights the area!"),

    USED_SURF: Strings.source("{STRBUF} used\nSURF!"),
    CANT_SURF: Strings.source("You can't SURF\nhere."),
    ALREADY_SURFING: Strings.source("You're already\nSURFING."),
    ASK_SURF: Strings.source("The water is calm.\nWant to SURF?"),

    USE_WATERFALL: Strings.source("{STRBUF} used\nWATERFALL!"),
    HUGE_WATERFALL: Strings.source("Wow, it's a huge\nwaterfall."),
    ASK_WATERFALL: Strings.source("Do you want to use\nWATERFALL?"),

    USE_STRENGTH: Strings.source("{STRBUF} used\nSTRENGTH!"),
    MOVE_BOULDER: Strings.source("{STRBUF} can\nmove boulders."),
    ASK_STRENGTH: Strings.source("A #MON may be\nable to move this."
      + "\fWant to use\nSTRENGTH?"),
    BOULDERS_MOVE: Strings.source("Boulders may now\nbe moved!"),
    BOULDERS_MAY_MOVE: Strings.source("A #MON may be\nable to move this."),

    // EscapeRopeOrDig's three lines: _UseDigText and _UseEscapeRopeText open
    // the shared warp, _CantUseDigText is DIG's own refusal.
    USE_DIG: Strings.source("{STRBUF} used\nDIG!"),
    USE_ESCAPE_ROPE: Strings.source("{PLAYER} used an\nESCAPE ROPE."),
    // TeleportFunction: _TeleportReturnText on the way out.
    TELEPORT_RETURN: Strings.source("Return to the last\n#MON CENTER."),

    USE_WHIRLPOOL: Strings.source("{STRBUF} used\nWHIRLPOOL!"),
    MAY_PASS_WHIRLPOOL: Strings.source("It's a vicious\nwhirlpool!"
      + "\fA #MON may be\nable to pass it."),
    ASK_WHIRLPOOL: Strings.source("A whirlpool is in\nthe way."
      + "\fWant to use\nWHIRLPOOL?"),
    // Not a cart line: the prompt World:askFlyPoint falls back to when there
    // is no screen at all to push -- a headless probe, never a real run.
    ASK_FLY_TO: Strings.source("Fly to %s?"),
  },

  // ---------------------------------------------------------------- badges
  // Lua: FieldMoves.lua:112-125 -- the ENGINE_*BADGE each Function passes to
  // CheckBadge. No pattern (CUT is HIVE, SURF is FOG, FLASH the first badge).
  BADGE: {
    CUT: "HIVE", // CutFunction.CheckAble
    FLASH: "ZEPHYR", // FlashFunction.CheckUseFlash
    SURF: "FOG", // SurfFunction.TrySurf / TrySurfOW
    FLY: "STORM", // FlyFunction.TryFly
    STRENGTH: "PLAIN", // StrengthFunction.TryStrength / TryStrengthOW
    WHIRLPOOL: "GLACIER", // WhirlpoolFunction.TryWhirlpool / TryWhirlpoolOW
    WATERFALL: "RISING", // WaterfallFunction.TryWaterfall / TryWaterfallOW
  } as Record<string, string>,

  // Lua: FieldMoves.lua:127-138 -- wJohtoBadges bit order, also the order the
  // trainer card lists them in. A save may key `player.badges` by name or by
  // that position. NOTE MINERAL is bit 4 and STORM bit 5 -- NOT the order a
  // player earns them; constants/engine_flags.asm:38-45 is the authority.
  JOHTO_BADGES: [
    "ZEPHYR", "HIVE", "PLAIN", "FOG", "MINERAL", "STORM", "GLACIER", "RISING",
  ],

  // Lua: FieldMoves.lua:140-143
  KANTO_BADGES: [
    "BOULDER", "CASCADE", "THUNDER", "RAINBOW",
    "SOUL", "MARSH", "VOLCANO", "EARTH",
  ],

  // Lua: FieldMoves.lua:145-162 -- ENGINE_* id -> which badge store and which
  // name. On the cart ENGINE_ZEPHYRBADGE *is* bit 0 of wJohtoBadges, so
  // `setflag ENGINE_ZEPHYRBADGE` and owning the badge are the same write;
  // World:setEngineFlag / engineFlag route badge ids here so there is one
  // store. Crystal's badge block sits one higher than Gold's, so the ids come
  // from the cache's engineFlagOrder when it has one.
  // Crystal only; pokegold constants/engine_flags.asm:4-111 has no such row.
  FEMALE_FLAG_NAME: "ENGINE_PLAYER_IS_FEMALE",

  // Set by bindEngineFlags (Lua: FieldMoves.lua:184-191).
  BADGE_FLAG: {} as Record<number, BadgeFlag>,
  FEMALE_FLAG: undefined as number | undefined,
  BUG_CONTEST_FLAG: 16,
  BIKE_SHOP_CALL_FLAG: 19,

  // Lua: FieldMoves.lua:164-198 -- `order` is constants.engineFlagOrder: a
  // 0-based JSON array of the Lua's 1-based sequence (so the id is the array
  // index), or a table keyed by the Lua's 1-based numbers (id = key - 1).
  bindEngineFlags(order: unknown): Record<number, BadgeFlag> {
    const byName: Record<string, number> = {};
    if (Array.isArray(order)) {
      // pairs, not ipairs: a const_skip leaves a hole and ipairs would stop
      // there, silently dropping every badge past it.
      for (let i = 0; i < order.length; i++) {
        if (typeof order[i] === "string") byName[order[i]] = i;
      }
    } else if (order !== null && typeof order === "object") {
      const t = order as Record<string, unknown>;
      for (const key of Object.keys(t)) {
        const index = Number(key);
        const name = t[key];
        if (key !== "" && !Number.isNaN(index) && typeof name === "string") {
          byName[name] = index - 1;
        }
      }
    }
    const flags: Record<number, BadgeFlag> = {};
    const place = (names: string[], store: BadgeFlag["store"], goldBase: number): void => {
      for (let i = 0; i < names.length; i++) {
        const name = names[i]!;
        const id = byName["ENGINE_" + name + "BADGE"] ?? (goldBase + i + 1);
        flags[id] = { store, name };
      }
    };
    place(FieldMoves.JOHTO_BADGES, "badges", 25);
    place(FieldMoves.KANTO_BADGES, "kantoBadges", 33);
    FieldMoves.BADGE_FLAG = flags;
    // The flag IS wPlayerGender's bit 0, so World routes it to the gender byte
    // (data/events/engine_flags.asm:131, constants/engine_flags.asm:121).
    FieldMoves.FEMALE_FLAG = byName[FieldMoves.FEMALE_FLAG_NAME];
    // Crystal's ENGINE_MOBILE_SYSTEM (constants/engine_flags.asm:25) has no
    // Gold row, so every id from BUG_CONTEST_TIMER up shifts one.
    FieldMoves.BUG_CONTEST_FLAG = byName["ENGINE_BUG_CONTEST_TIMER"] ?? 16;
    FieldMoves.BIKE_SHOP_CALL_FLAG = byName["ENGINE_BIKE_SHOP_CALL_ENABLED"] ?? 19;
    // pokecrystal constants/engine_flags.asm:66-92 vs pokegold :65-91
    for (const row of FieldMoves.FLYPOINTS ?? []) {
      row.goldFlag = row.goldFlag ?? row.flag;
      row.flag = byName[row.name] ?? row.goldFlag;
    }
    return flags;
  },

  // Lua: FieldMoves.lua:202-211
  hasBadge(save: any, badge: string | undefined): boolean {
    if (!truthy(badge)) return true;
    const owned = save && save.player ? save.player.badges : undefined;
    if (owned === null || typeof owned !== "object") return false;
    if (truthy(owned[badge!])) return true;
    for (let i = 0; i < FieldMoves.JOHTO_BADGES.length; i++) {
      // a positional store is a 0-based JS array here, as a Lua sequence
      // becomes (Battle.hasBadge reads it the same way)
      if (FieldMoves.JOHTO_BADGES[i] === badge) return owned[i] === true;
    }
    return false;
  },

  // Lua: FieldMoves.lua:213-260 -- CheckPartyMove wrapped in the
  // fieldmove.eligibility chain, exactly as it wraps OverworldState:partyKnows
  // under Gen 1: the vanilla link runs first. The chain is (moveId, ctx) ->
  // mon. `fieldCtx` is World:fieldContext's table when the caller has one;
  // it is only read for the hook's ctx.
  partyMoveUser(party: any[] | undefined, moveId: unknown, fieldCtx?: FieldCtx): any {
    if (!Runtime.wantsHook("fieldmove.eligibility")) {
      return findMoveUser(party, moveId);
    }
    return Runtime.call("fieldmove.eligibility", partyMoveUserVanilla, moveId, {
      save: fieldCtx ? fieldCtx.save : undefined,
      data: fieldCtx ? fieldCtx.data : undefined,
      party,
      moveId,
    });
  },

  // --------------------------------------------------------- encounter gate
  // Lua: FieldMoves.lua:262-281 -- CanEncounterWildMon
  // (engine/overworld/events.asm). A CAVE or DUNGEON map jumps STRAIGHT to the
  // ice check, skipping CheckGrassCollision entirely, which is why every
  // walkable tile of Dark Cave and Union Cave is an encounter tile.
  // `noWild` is STATUSFLAGS_NO_WILD_ENCOUNTERS_F (`wildoff` / `wildon`).
  canEncounterWildMon(environment: unknown, playerColl: Coll, noWild: unknown): boolean {
    if (truthy(noWild)) return false;
    if (environment !== "CAVE" && environment !== "DUNGEON") {
      if (!Permissions.isEncounterCollision(playerColl)) return false;
    }
    // .ice_check: shared by both arms, so an ice floor in a cave is as free
    // of encounters as an ice floor on a route.
    if (Permissions.isIce(playerColl)) return false;
    return true;
  },

  // Lua: FieldMoves.lua:283-289 -- ChooseWildEncounter picks its table off
  // CheckOnWater, the PERMISSION of the tile the player stands on.
  encounterTable(playerColl: Coll): "water" | "grass" {
    return Permissions.isWater(playerColl) ? "water" : "grass";
  },

  // ------------------------------------------------------------ cut blocks
  // Lua: FieldMoves.lua:291-327 -- data/collision/field_move_blocks.asm,
  // verbatim. A row is facing block -> [replacement block, animation type]:
  // CUT and WHIRLPOOL swap the whole 32x32 BLOCK the facing tile belongs to,
  // which is why one swing clears a 2x2 patch of grass. Animation type 1 is
  // the grass swirl, 0 the falling tree (wCutWhirlpoolAnimationType).
  CUT_BLOCKS: {
    TILESET_JOHTO: {
      0x03: [0x02, 1], // grass
      0x5b: [0x3c, 0], // tree
      0x5f: [0x3d, 0], // tree
      0x63: [0x3f, 0], // tree
      0x67: [0x3e, 0], // tree
    },
    TILESET_JOHTO_MODERN: {
      0x03: [0x02, 1], // grass
    },
    TILESET_KANTO: {
      0x0b: [0x0a, 1], // grass
      0x32: [0x6d, 0], // tree
      0x33: [0x6c, 0], // tree
      0x34: [0x6f, 0], // tree
      0x35: [0x4c, 0], // tree
      0x60: [0x6e, 0], // tree
    },
    TILESET_PARK: {
      0x13: [0x03, 1], // grass
      0x03: [0x04, 1], // grass
    },
    TILESET_FOREST: {
      0x0f: [0x17, 0],
    },
  } as BlockTable,

  // Lua: FieldMoves.lua:329-333
  WHIRLPOOL_BLOCKS: {
    TILESET_JOHTO: {
      0x07: [0x36, 0],
    },
  } as BlockTable,

  // Lua: FieldMoves.lua:335-343 -- CheckOverworldTileArrays: the tileset has to
  // be in the dictionary AND the facing block in that tileset's list, or the
  // whole thing fails. TUPLE [replacement block, animation] | undefined.
  blockReplacement(table_: BlockTable | undefined, tileset: string | undefined, blockId: number | undefined): [number, number] | undefined {
    const rows = table_ && tileset != null ? table_[tileset] : undefined;
    const row = rows && blockId != null ? rows[blockId] : undefined;
    if (!row) return undefined;
    return [row[0], row[1]];
  },

  // Lua: FieldMoves.lua:345-353 -- CheckMapForSomethingToCut: the facing
  // tile's collision has to be cuttable AND the block it sits in has to have a
  // replacement (a COLL_CUT_TREE with no CutTreeBlockPointers row is the
  // cart's own "nothing to cut").
  somethingToCut(ctx: FieldCtx): [number, number] | undefined {
    if (!Permissions.isCuttable(ctx.facingColl)) return undefined;
    return FieldMoves.blockReplacement(
      FieldMoves.CUT_BLOCKS, ctx.tileset, ctx.facingBlock);
  },

  // Lua: FieldMoves.lua:355-361 -- TryWhirlpoolMenu, CheckMapForSomethingToCut
  // with CheckWhirlpoolTile in place of CheckCutCollision.
  somethingToWhirlpool(ctx: FieldCtx): [number, number] | undefined {
    if (!Permissions.isWhirlpool(ctx.facingColl)) return undefined;
    return FieldMoves.blockReplacement(
      FieldMoves.WHIRLPOOL_BLOCKS, ctx.tileset, ctx.facingBlock);
  },

  // Lua: FieldMoves.lua:363-371 -- CheckMapCanWaterfall: facing UP, and the
  // tile ABOVE the player (wTileUp, not the facing tile the A press found) is
  // a waterfall. The menu path has no facing tile at all, so it must be
  // wTileUp there too.
  canWaterfall(ctx: FieldCtx): boolean {
    if (ctx.facing !== "up") return false;
    return Permissions.isWaterfall(ctx.upColl);
  },

  // Lua: FieldMoves.lua:373-377 -- .CheckContinueWaterfall: the climb keeps
  // applying turn_waterfall UP while the tile the player STANDS on is still a
  // waterfall tile.
  waterfallContinues(playerColl: Coll): boolean {
    return Permissions.isWaterfall(playerColl);
  },

  // ------------------------------------------------------- player state
  // Lua: FieldMoves.lua:379-390 -- constants/ram_constants.asm wPlayerState,
  // held as strings so a save that round-trips one is readable. PLAYER_SKATE
  // (2) has no string: nothing in Gold ever writes it. These four are plain
  // constants World.ts reads at module load.
  PLAYER_NORMAL: "normal",
  PLAYER_BIKE: "bike",
  PLAYER_SURF: "surf",
  PLAYER_SURF_PIKA: "surf_pika",

  // Lua: FieldMoves.lua:392-397 -- ChrisStateSprites
  // (data/sprites/player_sprites.asm).
  STATE_SPRITE: {
    normal: "SPRITE_CHRIS",
    bike: "SPRITE_CHRIS_BIKE",
    surf: "SPRITE_SURF",
    surf_pika: "SPRITE_SURFING_PIKACHU",
  } as Record<string, string>,

  // Lua: FieldMoves.lua:399-406 -- data/sprites/player_sprites.asm:8-13
  // KrisStateSprites, the other half of GetPlayerSprite's pick
  // (engine/overworld/overworld.asm:55-64).
  STATE_SPRITE_FEMALE: {
    normal: "SPRITE_KRIS",
    bike: "SPRITE_KRIS_BIKE",
    surf: "SPRITE_SURF",
    surf_pika: "SPRITE_SURFING_PIKACHU",
  } as Record<string, string>,

  // Lua: FieldMoves.lua:408-412 -- wPlayerGender's PLAYERGENDER_FEMALE_F, as
  // the save spells it (constants/ram_constants.asm:176-177).
  isFemale(gender: unknown): boolean {
    return gender === "female";
  },

  // Lua: FieldMoves.lua:414-420 -- GetPlayerSprite's table pick and row walk
  // (engine/overworld/overworld.asm:57-64, :67-75).
  stateSprite(state: string | undefined, gender: unknown): string {
    const table_ = FieldMoves.isFemale(gender)
      ? FieldMoves.STATE_SPRITE_FEMALE : FieldMoves.STATE_SPRITE;
    return (state != null ? table_[state] : undefined) ?? table_[FieldMoves.PLAYER_NORMAL]!;
  },

  // Lua: FieldMoves.lua:422-424
  playerSprite(gender: unknown): string {
    return FieldMoves.stateSprite(FieldMoves.PLAYER_NORMAL, gender);
  },

  // Lua: FieldMoves.lua:426-430 -- whether the cache carries Kris at all; Gold
  // and Silver have no KrisStateSprites (pokegold
  // data/sprites/player_sprites.asm:1-6).
  hasGenderChoice(sprites: any): boolean {
    return (sprites ? sprites[FieldMoves.STATE_SPRITE_FEMALE.normal!] : undefined) != null;
  },

  // Lua: FieldMoves.lua:432-434
  isBiking(state: unknown): boolean {
    return state === FieldMoves.PLAYER_BIKE;
  },

  // Lua: FieldMoves.lua:436-439
  isSurfing(state: unknown): boolean {
    return state === FieldMoves.PLAYER_SURF
        || state === FieldMoves.PLAYER_SURF_PIKA;
  },

  // Lua: FieldMoves.lua:441-447 -- GetSurfType: the mon CheckPartyMove picked
  // decides the sprite, and PIKACHU is the one species that rides its own.
  surfType(mon: any): string {
    const species = mon ? (mon.species ?? mon.id) : undefined;
    if (species === "PIKACHU") return FieldMoves.PLAYER_SURF_PIKA;
    return FieldMoves.PLAYER_SURF;
  },

  // Lua: FieldMoves.lua:449-471 -- CheckDirection: refuse to start surfing
  // when the tile permissions already block a step in the facing direction.
  // The port has no wTilePermissions mask, but what it guards against is
  // surfing off a ledge or through a side wall, so the check is the same
  // question asked of the tile under the player.
  directionBlocked(playerColl: Coll, facing: string | undefined): boolean {
    const row = playerColl != null ? BLOCKED_BY[playerColl % 256] : undefined;
    return (row && facing != null ? row[facing] : undefined) === true;
  },

  // ------------------------------------------------------------------- fly
  // Lua: FieldMoves.lua:473-514 -- data/maps/flypoints.asm, verbatim and in
  // order: FlyMap walks this table by index, so the order is the order the
  // picker scrolls in. flyPoints reads landmarks.json for the index and the
  // printed name, and drops any row the cache has no landmark for.
  //
  // `flag` is the row's ENGINE_FLYPOINT_* id (constants/engine_flags.asm's
  // const_def count, 0-based): the byte a town's MAPCALLBACK_NEWMAP sets with
  // `setflag` the first time you walk in, and what hasVisitedSpawn reads. Ids
  // are pokegold's; bindEngineFlags rebinds by name.
  FLYPOINTS: [
    // Johto
    { landmark: "LANDMARK_NEW_BARK_TOWN", spawn: "SPAWN_NEW_BARK", flag: 64, name: "ENGINE_FLYPOINT_NEW_BARK" },
    { landmark: "LANDMARK_CHERRYGROVE_CITY", spawn: "SPAWN_CHERRYGROVE", flag: 65, name: "ENGINE_FLYPOINT_CHERRYGROVE" },
    { landmark: "LANDMARK_VIOLET_CITY", spawn: "SPAWN_VIOLET", flag: 66, name: "ENGINE_FLYPOINT_VIOLET" },
    { landmark: "LANDMARK_AZALEA_TOWN", spawn: "SPAWN_AZALEA", flag: 67, name: "ENGINE_FLYPOINT_AZALEA" },
    { landmark: "LANDMARK_GOLDENROD_CITY", spawn: "SPAWN_GOLDENROD", flag: 69, name: "ENGINE_FLYPOINT_GOLDENROD" },
    { landmark: "LANDMARK_ECRUTEAK_CITY", spawn: "SPAWN_ECRUTEAK", flag: 71, name: "ENGINE_FLYPOINT_ECRUTEAK" },
    { landmark: "LANDMARK_OLIVINE_CITY", spawn: "SPAWN_OLIVINE", flag: 70, name: "ENGINE_FLYPOINT_OLIVINE" },
    { landmark: "LANDMARK_CIANWOOD_CITY", spawn: "SPAWN_CIANWOOD", flag: 68, name: "ENGINE_FLYPOINT_CIANWOOD" },
    { landmark: "LANDMARK_MAHOGANY_TOWN", spawn: "SPAWN_MAHOGANY", flag: 72, name: "ENGINE_FLYPOINT_MAHOGANY" },
    { landmark: "LANDMARK_LAKE_OF_RAGE", spawn: "SPAWN_LAKE_OF_RAGE", flag: 73, name: "ENGINE_FLYPOINT_LAKE_OF_RAGE" },
    { landmark: "LANDMARK_BLACKTHORN_CITY", spawn: "SPAWN_BLACKTHORN", flag: 74, name: "ENGINE_FLYPOINT_BLACKTHORN" },
    { landmark: "LANDMARK_SILVER_CAVE", spawn: "SPAWN_MT_SILVER", flag: 75, name: "ENGINE_FLYPOINT_SILVER_CAVE" },
    // Kanto
    { landmark: "LANDMARK_PALLET_TOWN", spawn: "SPAWN_PALLET", flag: 52, name: "ENGINE_FLYPOINT_PALLET" },
    { landmark: "LANDMARK_VIRIDIAN_CITY", spawn: "SPAWN_VIRIDIAN", flag: 53, name: "ENGINE_FLYPOINT_VIRIDIAN" },
    { landmark: "LANDMARK_PEWTER_CITY", spawn: "SPAWN_PEWTER", flag: 54, name: "ENGINE_FLYPOINT_PEWTER" },
    { landmark: "LANDMARK_CERULEAN_CITY", spawn: "SPAWN_CERULEAN", flag: 55, name: "ENGINE_FLYPOINT_CERULEAN" },
    { landmark: "LANDMARK_VERMILION_CITY", spawn: "SPAWN_VERMILION", flag: 57, name: "ENGINE_FLYPOINT_VERMILION" },
    { landmark: "LANDMARK_ROCK_TUNNEL", spawn: "SPAWN_ROCK_TUNNEL", flag: 56, name: "ENGINE_FLYPOINT_ROCK_TUNNEL" },
    { landmark: "LANDMARK_LAVENDER_TOWN", spawn: "SPAWN_LAVENDER", flag: 58, name: "ENGINE_FLYPOINT_LAVENDER" },
    { landmark: "LANDMARK_CELADON_CITY", spawn: "SPAWN_CELADON", flag: 60, name: "ENGINE_FLYPOINT_CELADON" },
    { landmark: "LANDMARK_SAFFRON_CITY", spawn: "SPAWN_SAFFRON", flag: 59, name: "ENGINE_FLYPOINT_SAFFRON" },
    { landmark: "LANDMARK_FUCHSIA_CITY", spawn: "SPAWN_FUCHSIA", flag: 61, name: "ENGINE_FLYPOINT_FUCHSIA" },
    { landmark: "LANDMARK_CINNABAR_ISLAND", spawn: "SPAWN_CINNABAR", flag: 62, name: "ENGINE_FLYPOINT_CINNABAR" },
    { landmark: "LANDMARK_INDIGO_PLATEAU", spawn: "SPAWN_INDIGO", flag: 63, name: "ENGINE_FLYPOINT_INDIGO_PLATEAU" },
  ] as FlyPointRow[],

  // Lua: FieldMoves.lua:523-525 -- KANTO_FLYPOINT: the first Kanto row, 1-based
  // here. FlyMap splits the table at it and shows one region's half or the
  // other, never both.
  KANTO_FLYPOINT: 13,

  // Lua: FieldMoves.lua:527-548 -- HasVisitedSpawn is a bit in wVisitedSpawns,
  // which the ENGINE_FLYPOINT_* engine flags drive (Script_setflag lands them
  // on save.engineFlags[id]). A save from before this read the engine flags is
  // missing that entry entirely (undefined, not false), so the old
  // save.visitedSpawns set is kept as the fallback for exactly that case.
  hasVisitedSpawn(save: any, spawn: string | undefined): boolean {
    if (!(save && spawn != null)) return false;
    const row = FLYPOINT_BY_SPAWN[spawn];
    const engine = save.engineFlags;
    if (row && engine !== null && typeof engine === "object") {
      const set = engine[row.flag];
      if (set != null) return set === true;
    }
    return (save.visitedSpawns ?? {})[spawn] === true;
  },

  // Lua: FieldMoves.lua:550-577 -- the rows FlyMap would let the cursor stop
  // on: this region's half of the table, minus every spawn
  // CheckIfVisitedFlypoint rejects. The Kanto half is withheld until
  // SPAWN_INDIGO is visited (.KantoFlyMap's gate), because with no Kanto
  // flypoint enabled the cart's own picker crashes.
  flyPoints(save: any, landmarks: any, region: unknown): FlyPoint[] {
    let first = 1;
    let last = FieldMoves.KANTO_FLYPOINT - 1;
    if (region === "kanto"
        && FieldMoves.hasVisitedSpawn(save, "SPAWN_INDIGO")) {
      first = FieldMoves.KANTO_FLYPOINT;
      last = FieldMoves.FLYPOINTS.length;
    }
    const out: FlyPoint[] = [];
    const table_ = landmarks ? landmarks.landmarks : undefined;
    for (let i = first; i <= last; i++) {
      const row = FieldMoves.FLYPOINTS[i - 1]!;
      if (FieldMoves.hasVisitedSpawn(save, row.spawn)) {
        const entry = table_ ? table_[row.landmark] : undefined;
        out.push({
          landmark: row.landmark,
          spawn: row.spawn,
          index: entry ? entry.index : undefined,
          name: (entry ? entry.name : undefined) ?? row.landmark,
        });
      }
    }
    return out;
  },

  // ------------------------------------------------------------ menu paths
  // The *Function routines. A menu use has already picked the mon, so
  // `ctx.mon` is that mon and CheckPartyMove is not run again.

  // Lua: FieldMoves.lua:594-608 -- CutFunction: .CheckAble (badge, then
  // CheckMapForSomethingToCut), .DoCut, .FailCut.
  cutFromMenu(ctx: FieldCtx): FieldResult {
    const refused = badgeGate(ctx, "CUT");
    if (refused) return refused;
    const found = FieldMoves.somethingToCut(ctx);
    if (!found) {
      return { ok: false, text: FieldMoves.TEXT.CUT_NOTHING };
    }
    return {
      ok: true, action: "cut",
      replacement: found[0], animation: found[1],
      text: FieldMoves.TEXT.USE_CUT,
    };
  },

  // Lua: FieldMoves.lua:610-624 -- FlashFunction.CheckUseFlash: badge, then
  // wTimeOfDayPalset == DARKNESS_PALSET, so FLASH is refused in a lit cave and
  // on a route alike with FieldMoveFailed's generic line.
  // ../pokecrystal/engine/events/overworld.asm:284-287 puts
  // SpecialAerodactylChamber between the two, and its carry is a second way
  // into `.useflash`.
  flashFromMenu(ctx: FieldCtx): FieldResult {
    const refused = badgeGate(ctx, "FLASH");
    if (refused) return refused;
    const chamber = ctx.openAerodactylWall ? ctx.openAerodactylWall() : undefined;
    if (!truthy(ctx.dark) && !truthy(chamber)) {
      return { ok: false, text: FieldMoves.TEXT.CANT_USE_HERE };
    }
    return { ok: true, action: "flash", text: FieldMoves.TEXT.BLINDING_FLASH };
  },

  // Lua: FieldMoves.lua:626-653 -- SurfFunction: .TrySurf, .DoSurf, .FailSurf,
  // .AlreadySurfing. Already-surfing is checked BEFORE the facing tile, which
  // is why surfing up to a shore and pressing SURF says "You're already
  // SURFING." rather than "You can't SURF here."
  surfFromMenu(ctx: FieldCtx): FieldResult {
    const refused = badgeGate(ctx, "SURF");
    if (refused) return refused;
    if (truthy(ctx.alwaysOnBike)) {
      return { ok: false, text: FieldMoves.TEXT.CANT_SURF };
    }
    if (FieldMoves.isSurfing(ctx.playerState)) {
      return { ok: false, text: FieldMoves.TEXT.ALREADY_SURFING };
    }
    if (!Permissions.isWater(ctx.facingColl)
        || FieldMoves.directionBlocked(ctx.playerColl, ctx.facing)) {
      return { ok: false, text: FieldMoves.TEXT.CANT_SURF };
    }
    // Crystal's added `farcall CheckFacingObject`, which pokegold's :339 tags
    // BUG (../pokecrystal/engine/events/overworld.asm:364-365).
    if (truthy(ctx.facingObject) && GameVersion.fixes().surfOntoNpc) {
      return { ok: false, text: FieldMoves.TEXT.CANT_SURF };
    }
    return {
      ok: true, action: "surf",
      state: FieldMoves.surfType(ctx.mon),
      text: FieldMoves.TEXT.USED_SURF,
    };
  },

  // Lua: FieldMoves.lua:655-666 -- FlyFunction.TryFly: badge, then
  // CheckOutdoorMap -- ROUTE or TOWN and nothing else, so a Pokecenter counts
  // as indoors. The picker itself is the caller's job.
  flyFromMenu(ctx: FieldCtx): FieldResult {
    const refused = badgeGate(ctx, "FLY");
    if (refused) return refused;
    if (ctx.environment !== "ROUTE" && ctx.environment !== "TOWN") {
      // .indoors falls to .FailFly, which is FieldMoveFailed.
      return { ok: false, text: FieldMoves.TEXT.CANT_USE_HERE };
    }
    return { ok: true, action: "fly" };
  },

  // Lua: FieldMoves.lua:668-680 -- StrengthFunction.TryStrength: the badge and
  // nothing else; all it does is set BIKEFLAGS_STRENGTH_ACTIVE and say so.
  strengthFromMenu(ctx: FieldCtx): FieldResult {
    const refused = badgeGate(ctx, "STRENGTH");
    if (refused) return refused;
    return {
      ok: true, action: "strength",
      text: FieldMoves.TEXT.USE_STRENGTH,
      after: FieldMoves.TEXT.MOVE_BOULDER,
    };
  },

  // Lua: FieldMoves.lua:682-692 -- WaterfallFunction.TryWaterfall: badge, then
  // CheckMapCanWaterfall.
  waterfallFromMenu(ctx: FieldCtx): FieldResult {
    const refused = badgeGate(ctx, "WATERFALL");
    if (refused) return refused;
    if (!FieldMoves.canWaterfall(ctx)) {
      return { ok: false, text: FieldMoves.TEXT.CANT_USE_HERE };
    }
    return {
      ok: true, action: "waterfall", text: FieldMoves.TEXT.USE_WATERFALL,
    };
  },

  // Lua: FieldMoves.lua:694-708 -- WhirlpoolFunction: .TryWhirlpool (badge,
  // TryWhirlpoolMenu), .DoWhirlpool, .FailWhirlpool.
  whirlpoolFromMenu(ctx: FieldCtx): FieldResult {
    const refused = badgeGate(ctx, "WHIRLPOOL");
    if (refused) return refused;
    const found = FieldMoves.somethingToWhirlpool(ctx);
    if (!found) {
      return { ok: false, text: FieldMoves.TEXT.CANT_USE_HERE };
    }
    return {
      ok: true, action: "whirlpool",
      replacement: found[0], animation: found[1],
      text: FieldMoves.TEXT.USE_WHIRLPOOL,
    };
  },

  // Lua: FieldMoves.lua:710-717 -- TryHeadbuttFromMenu: no badge (HEADBUTT is
  // a TM), just the facing tile.
  headbuttFromMenu(ctx: FieldCtx): FieldResult {
    if (!Permissions.isHeadbuttTree(ctx.facingColl)) {
      return { ok: false, text: FieldMoves.TEXT.CANT_USE_HERE };
    }
    return { ok: true, action: "headbutt" };
  },

  // Lua: FieldMoves.lua:722-733 --
  // ../pokecrystal/engine/events/overworld.asm:1317 TryRockSmashFromMenu
  rockSmashFromMenu(ctx: FieldCtx): FieldResult {
    const object = ctx.facingObject;
    const def = object ? object.def : undefined;
    if (!def || def.movement !== SPRITEMOVEDATA_SMASHABLE_ROCK) {
      return { ok: false, text: FieldMoves.TEXT.CANT_USE_HERE };
    }
    return {
      ok: true, action: "rocksmash", object,
      lastTalked: (def.index ?? 0) + 1,
    };
  },

  // Lua: FieldMoves.lua:735-747 --
  // ../pokecrystal/engine/events/std_scripts.asm:241 SmashRockScript
  rockSmashScriptKey(stdScripts: any, scripts: any): any {
    const entry = stdScripts && stdScripts.scripts
      ? stdScripts.scripts.SmashRockScript : undefined;
    const smash = entry && truthy(entry.key) && scripts ? scripts[entry.key] : undefined;
    const jump = smash ? smash[0] : undefined;
    const ask = jump && jump.op === "farsjump" && truthy(jump.script)
      ? scripts[jump.script] : undefined;
    for (const cmd of ask ?? []) {
      if (cmd.op === "iftrue" && truthy(cmd.script)) return cmd.script;
    }
    return undefined;
  },

  // Lua: FieldMoves.lua:749-758 --
  // ../pokecrystal/engine/events/overworld.asm:1357 RockSmashFromMenuScript
  rockSmashFromMenuScript(stdScripts: any, scripts: any, specialId?: (name: string) => unknown): any[] | undefined {
    const key = FieldMoves.rockSmashScriptKey(stdScripts, scripts);
    if (!truthy(key)) return undefined;
    const script: any[] = [{ op: "refreshmap" }];
    const id = specialId ? specialId("UpdateTimePals") : undefined;
    if (truthy(id)) script.push({ op: "special", id });
    script.push({ op: "sjump", script: key });
    return script;
  },

  // Lua: FieldMoves.lua:760-768 -- SweetScentFromMenu
  // (engine/events/sweet_scent.asm): QueueScript then an unconditional
  // wFieldMoveSucceeded = 1 -- nothing can refuse the press. Whether anything
  // turns up is answered later by the queued script (World:sweetScentEncounter).
  sweetScentFromMenu(_ctx: FieldCtx): FieldResult {
    return { ok: true, action: "sweetscent" };
  },

  // Lua: FieldMoves.lua:770-780 -- DigFunction (EscapeRopeOrDig): no badge --
  // DIG is a TM -- just .CheckCanDig's CAVE / DUNGEON environment and a live
  // dig triple (ctx.canEscapeRope). .FailDig prints _CantUseDigText.
  digFromMenu(ctx: FieldCtx): FieldResult {
    const env = ctx.environment;
    if ((env !== "CAVE" && env !== "DUNGEON") || !truthy(ctx.canEscapeRope)) {
      return { ok: false, text: FieldMoves.TEXT.CANT_USE_HERE };
    }
    return { ok: true, action: "dig", text: FieldMoves.TEXT.USE_DIG };
  },

  // Lua: FieldMoves.lua:782-794 -- TeleportFunction .TryTeleport:
  // CheckOutdoorMap (TOWN or ROUTE); World:warpToSpawn resolves the last spawn
  // pair, so the outdoor test is the whole refusal here.
  teleportFromMenu(ctx: FieldCtx): FieldResult {
    const env = ctx.environment;
    if (env !== "TOWN" && env !== "ROUTE") {
      return { ok: false, text: FieldMoves.TEXT.CANT_USE_HERE };
    }
    return {
      ok: true, action: "teleport", text: FieldMoves.TEXT.TELEPORT_RETURN,
    };
  },

  // Lua: FieldMoves.lua:796-805 --
  // ../pokecrystal/engine/pokemon/mon_menu.asm:744 .CheckMonHasEnoughHP
  softboiledFromMenu(ctx: FieldCtx): FieldResult {
    const mon = ctx.mon;
    const maxHp = (mon ? (mon.maxHp ?? (mon.stats ? mon.stats.hp : undefined)) : undefined) ?? 0;
    const cost = Math.floor(maxHp / 5);
    if (!mon || (mon.hp ?? 0) <= cost) {
      return { ok: false, text: FieldMoves.TEXT.NOT_ENOUGH_HP };
    }
    return { ok: true, action: "softboiled", cost, inMenu: true };
  },

  // Lua: FieldMoves.lua:811-815 --
  // ../pokecrystal/engine/items/item_effects.asm:2043 .cant_use
  softboiledTargetOk(user: any, target: any): boolean {
    if (!(user && target) || target === user || truthy(target.isEgg)) return false;
    return (target.hp ?? 0) > 0 && (target.hp ?? 0) < softboiledMaxHp(target);
  },

  // Lua: FieldMoves.lua:817-824 --
  // ../pokecrystal/engine/items/item_effects.asm:1997 RemoveHP / :2005
  // RestoreHealth. TUPLE [hp before, hp after] | undefined (WorldAPI reads
  // both).
  softboiledTransfer(user: any, target: any, cost: number | undefined): [number, number] | undefined {
    if (!FieldMoves.softboiledTargetOk(user, target)) return undefined;
    const before = target.hp ?? 0;
    user.hp = Math.max(0, (user.hp ?? 0) - (cost ?? 0));
    target.hp = Math.min(softboiledMaxHp(target), before + (cost ?? 0));
    return [before, target.hp];
  },

  // Lua: FieldMoves.lua:826-842 -- filled in below, once the functions exist
  // (the Lua table captures the function values at definition time too).
  FROM_MENU: {} as Record<string, MenuFn>,

  // Lua: FieldMoves.lua:844-851 --
  // ../pokecrystal/engine/events/overworld.asm:1330 TryRockSmashFromMenu .no_rock
  fromMenu(moveId: string, ctx: FieldCtx): FieldResult {
    const fn = FieldMoves.FROM_MENU[moveId];
    if (!fn) {
      return { ok: false, text: FieldMoves.TEXT.CANT_USE_HERE };
    }
    return fn(ctx);
  },

  // -------------------------------------------------------------- OW paths
  // Try*OW, reached from TryTileCollisionEvent. The tile has already been
  // matched by the caller, so these start at CheckPartyMove and the badge is
  // CheckEngineFlag -- silent.

  // Lua: FieldMoves.lua:859-876 -- TryCutOW: no mon or no badge is NOT silent
  // here, it is CantCutScript, so an uncuttable tree still tells you it can be
  // cut. The map check happens after the YES (AskCutScript's `callasm
  // .CheckMap`), which is why YES to a tree in a tileset with no replacement
  // block simply closes the box.
  tryCutOW(ctx: FieldCtx): FieldResult {
    const mon = FieldMoves.partyMoveUser(ctx.party, "CUT", ctx);
    if (!truthy(mon) || !FieldMoves.hasBadge(ctx.save, FieldMoves.BADGE.CUT)) {
      return { ok: false, text: FieldMoves.TEXT.CAN_CUT, took: true };
    }
    const found = FieldMoves.somethingToCut(ctx);
    return {
      ok: true, took: true, mon,
      ask: FieldMoves.TEXT.ASK_CUT,
      action: found ? "cut" : undefined,
      replacement: found ? found[0] : undefined,
      animation: found ? found[1] : undefined,
      text: FieldMoves.TEXT.USE_CUT,
    };
  },

  // Lua: FieldMoves.lua:878-897 -- TryWhirlpoolOW. Unlike CUT,
  // TryWhirlpoolMenu runs BEFORE the ask, so a whirlpool in a tileset with no
  // replacement block gets the refusal line.
  tryWhirlpoolOW(ctx: FieldCtx): FieldResult {
    const mon = FieldMoves.partyMoveUser(ctx.party, "WHIRLPOOL", ctx);
    const found = FieldMoves.somethingToWhirlpool(ctx);
    if (!truthy(mon)
        || !FieldMoves.hasBadge(ctx.save, FieldMoves.BADGE.WHIRLPOOL)
        || !found) {
      return {
        ok: false, took: true, text: FieldMoves.TEXT.MAY_PASS_WHIRLPOOL,
      };
    }
    return {
      ok: true, took: true, mon,
      ask: FieldMoves.TEXT.ASK_WHIRLPOOL,
      action: "whirlpool",
      replacement: found[0], animation: found[1],
      text: FieldMoves.TEXT.USE_WHIRLPOOL,
    };
  },

  // Lua: FieldMoves.lua:899-912 -- TryWaterfallOW.
  tryWaterfallOW(ctx: FieldCtx): FieldResult {
    const mon = FieldMoves.partyMoveUser(ctx.party, "WATERFALL", ctx);
    if (!truthy(mon)
        || !FieldMoves.hasBadge(ctx.save, FieldMoves.BADGE.WATERFALL)
        || !FieldMoves.canWaterfall(ctx)) {
      return { ok: false, took: true, text: FieldMoves.TEXT.HUGE_WATERFALL };
    }
    return {
      ok: true, took: true, mon,
      ask: FieldMoves.TEXT.ASK_WATERFALL,
      action: "waterfall", text: FieldMoves.TEXT.USE_WATERFALL,
    };
  },

  // Lua: FieldMoves.lua:914-935 -- TrySurfOW. Every failure arm is `.quit` --
  // `xor a`, no script, no text -- so a shore with no SURF mon is a dead A
  // press. It is also the LAST thing TryTileCollisionEvent tries.
  trySurfOW(ctx: FieldCtx): FieldResult {
    if (FieldMoves.isSurfing(ctx.playerState)) return { ok: false };
    if (!Permissions.isWater(ctx.facingColl)) return { ok: false };
    if (FieldMoves.directionBlocked(ctx.playerColl, ctx.facing)) {
      return { ok: false };
    }
    if (!FieldMoves.hasBadge(ctx.save, FieldMoves.BADGE.SURF)) {
      return { ok: false };
    }
    const mon = FieldMoves.partyMoveUser(ctx.party, "SURF", ctx);
    if (!truthy(mon)) return { ok: false };
    if (truthy(ctx.alwaysOnBike)) return { ok: false };
    return {
      ok: true, took: true, mon,
      ask: FieldMoves.TEXT.ASK_SURF,
      action: "surf", state: FieldMoves.surfType(mon),
      text: FieldMoves.TEXT.USED_SURF,
    };
  },

  // Lua: FieldMoves.lua:937-964 -- TryStrengthOW, a callasm inside
  // AskStrengthScript: walking into a boulder runs the boulder's own script,
  // which asks this which of its three lines to print:
  //   0  "already"  STRENGTH is already active   -> BouldersMoveText
  //   1  "nope"     no mon / no PLAINBADGE       -> BouldersMayMoveText
  //   2  "ask"      may be turned on right now   -> AskStrengthScript
  // Note the inversion in the cart: `bit BIKEFLAGS_STRENGTH_ACTIVE_F` jumps to
  // .already_using when the bit is CLEAR, so 2 is the not-yet case and 0 the
  // already-on one. Reading that backwards swaps the two lines.
  tryStrengthOW(ctx: FieldCtx): FieldResult {
    const mon = FieldMoves.partyMoveUser(ctx.party, "STRENGTH", ctx);
    if (!truthy(mon) || !FieldMoves.hasBadge(ctx.save, FieldMoves.BADGE.STRENGTH)) {
      return { ok: false, took: true, text: FieldMoves.TEXT.BOULDERS_MAY_MOVE };
    }
    if (truthy(ctx.strengthActive)) {
      return { ok: false, took: true, text: FieldMoves.TEXT.BOULDERS_MOVE };
    }
    return {
      ok: true, took: true, mon,
      ask: FieldMoves.TEXT.ASK_STRENGTH,
      action: "strength",
      text: FieldMoves.TEXT.USE_STRENGTH,
      after: FieldMoves.TEXT.MOVE_BOULDER,
    };
  },
};

// Lua: FieldMoves.lua:200 -- the module binds Gold's defaults at load. (The
// Lua runs this before FLYPOINTS exists; here the rows are already present,
// so this also copies each row's `flag` into `goldFlag` -- the same value
// World.load's rebind would give it, so nothing observable changes.)
FieldMoves.bindEngineFlags(undefined);

// Lua: FieldMoves.lua:516-521 -- spawn -> row, built once, so hasVisitedSpawn
// does not walk the whole table on every call. Same row objects, so the
// rebinding above is seen here.
const FLYPOINT_BY_SPAWN: Record<string, FlyPointRow> = {};
for (const row of FieldMoves.FLYPOINTS) {
  FLYPOINT_BY_SPAWN[row.spawn] = row;
}

// Lua: FieldMoves.lua:826-842
Object.assign(FieldMoves.FROM_MENU, {
  CUT: FieldMoves.cutFromMenu,
  FLASH: FieldMoves.flashFromMenu,
  SURF: FieldMoves.surfFromMenu,
  FLY: FieldMoves.flyFromMenu,
  STRENGTH: FieldMoves.strengthFromMenu,
  WATERFALL: FieldMoves.waterfallFromMenu,
  WHIRLPOOL: FieldMoves.whirlpoolFromMenu,
  HEADBUTT: FieldMoves.headbuttFromMenu,
  ROCK_SMASH: FieldMoves.rockSmashFromMenu,
  SWEET_SCENT: FieldMoves.sweetScentFromMenu,
  DIG: FieldMoves.digFromMenu,
  TELEPORT: FieldMoves.teleportFromMenu,
  // ../pokecrystal/engine/pokemon/mon_menu.asm:138 MonMenu_Softboiled_MilkDrink
  SOFTBOILED: FieldMoves.softboiledFromMenu,
  MILK_DRINK: FieldMoves.softboiledFromMenu,
});

export default FieldMoves;
