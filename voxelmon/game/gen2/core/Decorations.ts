// gen1recomp src/core/gen2/Decorations.lua at bdfac727 (MIT): the ornaments
// in the player's bedroom (engine/overworld/decorations.asm with
// data/decorations/attributes.asm, names.asm, decorations.asm).
//
// Three separate pieces of state: OWNED (one wEventFlags bit per decoration),
// PLACED (the eight wDeco* bytes on save.decorations, each a DECO_* id or 0)
// and VISIBLE (rebuilt from PLACED only on a map load, by `visibility` and
// `tiles`).
//
// Indexing: DECO_* ids and DECOFLAG_* are game values. ATTRIBUTES is a JS
// array indexed BY the DECO_* id (the Lua table has [0] too, so it is
// contiguous 0..52 and needs no shift). Lua's `return changed, pages` from
// `apply` is a tuple `[changed, pages]`.

import { Strings } from "../shared/core/Strings.ts";
import { tostring } from "../platform/lua.ts";

/** One attributes.asm row. `sprite` is a BLOCK id for maptile kinds, a SPRITE_* byte for object kinds. */
export interface DecoAttr {
  type: number;
  name: string;
  action: string | undefined;
  flag: number;
  sprite: number;
}

export interface DecoAction {
  slot?: string;
  put?: boolean;
  ornament?: boolean;
}

export interface DecoCategory {
  id: number;
  label: string;
  members: number[];
}

/** save.decorations: the eight wDeco* bytes by slot name (bed, carpet, ...). */
export type DecoState = Record<string, number>;

/** The Events bitfield (world/Events.ts), as this module uses it. */
type EventsLike = { get(flag: number): any; set(flag: number, v: boolean): any } | null | undefined;
type MonNameFn = ((name: string) => string | undefined | null) | null | undefined;

// Lua: Decorations.lua:36 -- constants/deco_constants.asm decoration types.
const PLANT = 1, BED = 2, CARPET = 3, POSTER = 4, DOLL = 5, BIGDOLL = 6;

// Lua: Decorations.lua:48-63 -- DoDecorationAction2.DecoActions as slot + direction.
const ACTIONS: Record<string, DecoAction> = {
  SET_UP_BED: { slot: "bed" },
  PUT_AWAY_BED: { slot: "bed", put: true },
  SET_UP_CARPET: { slot: "carpet" },
  PUT_AWAY_CARPET: { slot: "carpet", put: true },
  SET_UP_PLANT: { slot: "plant" },
  PUT_AWAY_PLANT: { slot: "plant", put: true },
  SET_UP_POSTER: { slot: "poster" },
  PUT_AWAY_POSTER: { slot: "poster", put: true },
  SET_UP_CONSOLE: { slot: "console" },
  PUT_AWAY_CONSOLE: { slot: "console", put: true },
  SET_UP_BIG_DOLL: { slot: "bigDoll" },
  PUT_AWAY_BIG_DOLL: { slot: "bigDoll", put: true },
  SET_UP_DOLL: { ornament: true },
  PUT_AWAY_DOLL: { ornament: true, put: true },
};

// Lua: Decorations.lua:70-80 -- wEventFlags bit numbers (constants/event_flags.asm).
const EVENT_TEMPORARY_UNTIL_MAP_RELOAD_1 = 0;
const EVENT_DECO_BED_1 = 676;
const EVENT_DECO_CARPET_1 = 680;
const EVENT_DECO_PLANT_1 = 684;
const EVENT_DECO_POSTER_1 = 687;
const EVENT_DECO_FAMICOM = 691;
const EVENT_DECO_PIKACHU_DOLL = 695;
const EVENT_PLAYERS_ROOM_POSTER = 716;
const EVENT_DECO_GOLD_TROPHY = 717;
const EVENT_DECO_SILVER_TROPHY = 718;
const EVENT_DECO_BIG_SNORLAX_DOLL = 719;

// Lua: Decorations.lua:107-110
function deco(kind: number, name: string, action: string | undefined, flag: number, sprite: number): DecoAttr {
  return { type: kind, name, action, flag, sprite };
}

const TEMP = EVENT_TEMPORARY_UNTIL_MAP_RELOAD_1;

// Lua: Decorations.lua:114-174 -- data/decorations/attributes.asm, indexed by DECO_*.
const ATTRIBUTES: DecoAttr[] = [
  deco(PLANT, "CANCEL", undefined, TEMP, 0),
  deco(PLANT, "PUT IT AWAY", "PUT_AWAY_BED", TEMP, 0), // BEDS
  deco(BED, "FEATHERY", "SET_UP_BED", EVENT_DECO_BED_1 + 0, 0x1b),
  deco(BED, "PINK", "SET_UP_BED", EVENT_DECO_BED_1 + 1, 0x1c),
  deco(BED, "POLKADOT", "SET_UP_BED", EVENT_DECO_BED_1 + 2, 0x1d),
  deco(BED, "PIKACHU", "SET_UP_BED", EVENT_DECO_BED_1 + 3, 0x1e),
  deco(PLANT, "PUT IT AWAY", "PUT_AWAY_CARPET", TEMP, 0), // CARPETS
  deco(CARPET, "RED", "SET_UP_CARPET", EVENT_DECO_CARPET_1 + 0, 0x08),
  deco(CARPET, "BLUE", "SET_UP_CARPET", EVENT_DECO_CARPET_1 + 1, 0x0b),
  deco(CARPET, "YELLOW", "SET_UP_CARPET", EVENT_DECO_CARPET_1 + 2, 0x0e),
  deco(CARPET, "GREEN", "SET_UP_CARPET", EVENT_DECO_CARPET_1 + 3, 0x11),
  deco(PLANT, "PUT IT AWAY", "PUT_AWAY_PLANT", TEMP, 0), // PLANTS
  deco(PLANT, "MAGNAPLANT", "SET_UP_PLANT", EVENT_DECO_PLANT_1 + 0, 0x20),
  deco(PLANT, "TROPICPLANT", "SET_UP_PLANT", EVENT_DECO_PLANT_1 + 1, 0x21),
  deco(PLANT, "JUMBOPLANT", "SET_UP_PLANT", EVENT_DECO_PLANT_1 + 2, 0x22),
  deco(PLANT, "PUT IT AWAY", "PUT_AWAY_POSTER", TEMP, 0), // POSTERS
  // The TOWN MAP poster is a DECO_PLANT: GetDecoName must not append " POSTER".
  deco(PLANT, "TOWN MAP", "SET_UP_POSTER", EVENT_DECO_POSTER_1 + 0, 0x1f),
  deco(POSTER, "PIKACHU", "SET_UP_POSTER", EVENT_DECO_POSTER_1 + 1, 0x23),
  deco(POSTER, "CLEFAIRY", "SET_UP_POSTER", EVENT_DECO_POSTER_1 + 2, 0x24),
  deco(POSTER, "JIGGLYPUFF", "SET_UP_POSTER", EVENT_DECO_POSTER_1 + 3, 0x25),
  deco(PLANT, "PUT IT AWAY", "PUT_AWAY_CONSOLE", TEMP, 0), // CONSOLES
  deco(PLANT, "NES", "SET_UP_CONSOLE", EVENT_DECO_FAMICOM + 0, 0x5c), // SPRITE_FAMICOM
  deco(PLANT, "SUPER NES", "SET_UP_CONSOLE", EVENT_DECO_FAMICOM + 1, 0x5b),
  deco(PLANT, "NINTENDO64", "SET_UP_CONSOLE", EVENT_DECO_FAMICOM + 2, 0x51),
  deco(PLANT, "VIRTUAL BOY", "SET_UP_CONSOLE", EVENT_DECO_FAMICOM + 3, 0x57),
  deco(PLANT, "PUT IT AWAY", "PUT_AWAY_BIG_DOLL", TEMP, 0), // BIG_DOLLS
  deco(BIGDOLL, "SNORLAX", "SET_UP_BIG_DOLL", EVENT_DECO_BIG_SNORLAX_DOLL + 0, 0x33),
  deco(BIGDOLL, "ONIX", "SET_UP_BIG_DOLL", EVENT_DECO_BIG_SNORLAX_DOLL + 1, 0x50),
  deco(BIGDOLL, "LAPRAS", "SET_UP_BIG_DOLL", EVENT_DECO_BIG_SNORLAX_DOLL + 2, 0x47),
  deco(PLANT, "PUT IT AWAY", "PUT_AWAY_DOLL", TEMP, 0), // DOLLS
  deco(DOLL, "PIKACHU", "SET_UP_DOLL", EVENT_DECO_PIKACHU_DOLL + 0, 0x8e),
  // "SURF PIKACHU DOLL" is one DecorationNames string, so a DECO_PLANT.
  deco(PLANT, "SURF PIKACHU DOLL", "SET_UP_DOLL", EVENT_DECO_PIKACHU_DOLL + 1, 0x34),
  deco(DOLL, "CLEFAIRY", "SET_UP_DOLL", EVENT_DECO_PIKACHU_DOLL + 2, 0x8f),
  deco(DOLL, "JIGGLYPUFF", "SET_UP_DOLL", EVENT_DECO_PIKACHU_DOLL + 3, 0x94),
  deco(DOLL, "BULBASAUR", "SET_UP_DOLL", EVENT_DECO_PIKACHU_DOLL + 4, 0x93),
  deco(DOLL, "CHARMANDER", "SET_UP_DOLL", EVENT_DECO_PIKACHU_DOLL + 5, 0x90),
  deco(DOLL, "SQUIRTLE", "SET_UP_DOLL", EVENT_DECO_PIKACHU_DOLL + 6, 0x89),
  deco(DOLL, "POLIWAG", "SET_UP_DOLL", EVENT_DECO_PIKACHU_DOLL + 7, 0x8d),
  deco(DOLL, "DIGLETT", "SET_UP_DOLL", EVENT_DECO_PIKACHU_DOLL + 8, 0x8c),
  // STARYU's doll stands on SPRITE_STARMIE; the cart's own row says so.
  deco(DOLL, "STARYU", "SET_UP_DOLL", EVENT_DECO_PIKACHU_DOLL + 9, 0x92),
  deco(DOLL, "MAGIKARP", "SET_UP_DOLL", EVENT_DECO_PIKACHU_DOLL + 10, 0x88),
  deco(DOLL, "ODDISH", "SET_UP_DOLL", EVENT_DECO_PIKACHU_DOLL + 11, 0x85),
  deco(DOLL, "GENGAR", "SET_UP_DOLL", EVENT_DECO_PIKACHU_DOLL + 12, 0x86),
  deco(DOLL, "SHELLDER", "SET_UP_DOLL", EVENT_DECO_PIKACHU_DOLL + 13, 0x84),
  deco(DOLL, "GRIMER", "SET_UP_DOLL", EVENT_DECO_PIKACHU_DOLL + 14, 0x95),
  deco(DOLL, "VOLTORB", "SET_UP_DOLL", EVENT_DECO_PIKACHU_DOLL + 15, 0x9b),
  deco(DOLL, "WEEDLE", "SET_UP_DOLL", EVENT_DECO_PIKACHU_DOLL + 16, 0x83),
  deco(DOLL, "UNOWN", "SET_UP_DOLL", EVENT_DECO_PIKACHU_DOLL + 17, 0x80),
  deco(DOLL, "GEODUDE", "SET_UP_DOLL", EVENT_DECO_PIKACHU_DOLL + 18, 0x81),
  deco(DOLL, "MACHOP", "SET_UP_DOLL", EVENT_DECO_PIKACHU_DOLL + 19, 0x9a),
  deco(DOLL, "TENTACOOL", "SET_UP_DOLL", EVENT_DECO_PIKACHU_DOLL + 20, 0x98),
  // Both trophies are SET_UP_DOLL: a trophy stands in an ornament slot.
  deco(PLANT, "GOLD TROPHY", "SET_UP_DOLL", EVENT_DECO_GOLD_TROPHY, 0x5e),
  deco(PLANT, "SILVER TROPHY", "SET_UP_DOLL", EVENT_DECO_SILVER_TROPHY, 0x5f),
];

// Lua: Decorations.lua:183-187
function range(first: number, last: number): number[] {
  const out: number[] = [];
  for (let id = first; id <= last; id++) out.push(id);
  return out;
}

// Lua: Decorations.lua:202-213 -- DecorationIDs: DECOFLAG_* -> DECO_* (0-based list here).
const DECORATION_IDS: number[] = [];
for (const group of [
  range(2, 5), range(7, 10), range(12, 14), range(16, 19), range(21, 24),
  range(30, 50), range(26, 28), [51, 52],
]) {
  for (const id of group) DECORATION_IDS.push(id);
}

// Lua: Decorations.lua:269-270 -- the `decorations` registry ("deco:<n>").
const DECO_ID_PREFIX = "deco:";
let registryRows: Record<string, DecoAttr> | null = null;

// Lua: Decorations.lua:307-311 -- GetDecoName's templates.
const BED_NAME = Strings.source("%s BED");
const CARPET_NAME = Strings.source("%s CARPET");
const POSTER_NAME = Strings.source("%s POSTER");
const DOLL_NAME = Strings.source("%s DOLL");
const BIG_DOLL_NAME = Strings.source("BIG %s");

// Lua: Decorations.lua:396-403 -- data/text/common_1.asm.
const SET_UP = Strings.source("Set up the\n%s.");
const PUT_AWAY = Strings.source("Put away the\n%s.");
const NOTHING_TO_PUT_AWAY = Strings.source("There's nothing to\nput away.");
const ALREADY_SET_UP = Strings.source("That's already set\nup.");
const NOTHING_TO_CHOOSE = Strings.source("There's nothing to\nchoose.");
// _PutAwayAndSetUpText is one text with a `para` in it, so it is two pages.
const PUT_AWAY_PAGE = Strings.source("Put away the\n%s");
const AND_SET_UP = Strings.source("and set up the\n%s.");

export const Decorations = {
  // Lua: Decorations.lua:39-42 -- the eight wDeco* bytes.
  SLOTS: [
    "bed", "carpet", "plant", "poster", "console", "bigDoll",
    "leftOrnament", "rightOrnament",
  ] as string[],

  ACTIONS,
  EVENT_PLAYERS_ROOM_POSTER,

  // Lua: Decorations.lua:89-94 -- PLAYERS_HOUSE_2F's four decoration objects.
  OBJECT_SLOTS: [
    { slot: "console", sprite: 0, flag: 1857 }, // SPRITE_CONSOLE
    { slot: "leftOrnament", sprite: 1, flag: 1858 }, // SPRITE_DOLL_1
    { slot: "rightOrnament", sprite: 2, flag: 1859 }, // SPRITE_DOLL_2
    { slot: "bigDoll", sprite: 3, flag: 1860 }, // SPRITE_BIG_DOLL
  ] as { slot: string; sprite: number; flag: number }[],

  ATTRIBUTES,

  // Lua: Decorations.lua:189-197 -- the seven category menus (.owned_pointers order).
  CATEGORIES: [
    { id: 1, label: "BED", members: range(2, 5) },
    { id: 6, label: "CARPET", members: range(7, 10) },
    { id: 11, label: "PLANT", members: range(12, 14) },
    { id: 15, label: "POSTER", members: range(16, 19) },
    { id: 20, label: "GAME CONSOLE", members: range(21, 24) },
    { id: 29, label: "ORNAMENT", members: range(30, 52) },
    { id: 25, label: "BIG DOLL", members: range(26, 28) },
  ] as DecoCategory[],

  /** Lua: Decorations.lua:216 -- DECOFLAG_* (0-based) -> DECO_*. */
  idForFlag(decoFlag: number | null | undefined): number | undefined {
    return DECORATION_IDS[decoFlag ?? 0];
  },

  // Lua: Decorations.lua:221-222
  DECOFLAG_GOLD_TROPHY_DOLL: 43,
  DECOFLAG_SILVER_TROPHY_DOLL: 44,

  // Lua: Decorations.lua:230-236 -- DescribeDecoration's five arms.
  DESC_SLOTS: {
    DECODESC_POSTER: { slot: "poster" },
    DECODESC_LEFT_DOLL: { slot: "leftOrnament", named: true },
    DECODESC_RIGHT_DOLL: { slot: "rightOrnament", named: true },
    DECODESC_BIG_DOLL: { slot: "bigDoll" },
    DECODESC_CONSOLE: { slot: "console", named: true },
  } as Record<string, { slot: string; named?: boolean }>,

  NOTHING_TO_CHOOSE,

  /**
   * Lua: Decorations.lua:247 -- save.decorations, created on demand with
   * InitDecorations' two defaults (DECO_FEATHERY_BED, DECO_TOWN_MAP).
   */
  state(save: Record<string, any> | null | undefined): DecoState {
    if (save === null || typeof save !== "object") return {};
    let state = save.decorations;
    if (!state) {
      state = { bed: 2, poster: 16 }; // DECO_FEATHERY_BED, DECO_TOWN_MAP
      save.decorations = state;
    }
    return state;
  },

  /** Lua: Decorations.lua:272 */
  idFor(decoId: number): string {
    return DECO_ID_PREFIX + tostring(decoId);
  },

  /** Lua: Decorations.lua:281 -- the merged registry row, else ATTRIBUTES[decoId]. */
  attributes(decoId: number | null | undefined): DecoAttr | undefined {
    if (decoId == null) return undefined;
    const merged = registryRows && registryRows[DECO_ID_PREFIX + tostring(decoId)];
    return merged || ATTRIBUTES[decoId];
  },

  /** Lua: Decorations.lua:288 -- vanilla registrations, engine-owned. */
  registerInto(registry: any, _unused: unknown, owner: unknown): number {
    let count = 0;
    ATTRIBUTES.forEach((attr, decoId) => {
      registry.register(Decorations.idFor(decoId), attr, owner);
      count = count + 1;
    });
    return count;
  },

  /** Lua: Decorations.lua:298 -- the merged table, held by reference; nil forgets it. */
  useRegistry(data: any): boolean {
    registryRows = (data && data.gen2Decorations) || null;
    return registryRows != null;
  },

  /** Lua: Decorations.lua:317 -- GetDecoName. `monName(base)` resolves a species name. */
  name(decoId: number | null | undefined, monName?: MonNameFn): string {
    const attr = Decorations.attributes(decoId);
    if (!attr) return "";
    const base = attr.name;
    if (attr.type === BED) return Strings.get(BED_NAME, base);
    if (attr.type === CARPET) return Strings.get(CARPET_NAME, base);
    const mon = (monName && monName(base)) || base;
    if (attr.type === POSTER) return Strings.get(POSTER_NAME, mon);
    if (attr.type === DOLL) return Strings.get(DOLL_NAME, mon);
    if (attr.type === BIGDOLL) return Strings.get(BIG_DOLL_NAME, mon);
    return base;
  },

  // ---- Owning -----------------------------------------------------------

  /** Lua: Decorations.lua:336 -- DecorationFlagAction CHECK_FLAG. */
  owns(events: EventsLike, decoId: number | null | undefined): boolean {
    const attr = Decorations.attributes(decoId);
    if (!(events && attr && attr.flag != null)) return false;
    return events.get(attr.flag) ? true : false;
  },

  /** Lua: Decorations.lua:347 -- SetSpecificDecorationFlag by DECOFLAG_*. */
  giveFlag(events: EventsLike, decoFlag: number): boolean {
    return Decorations.give(events, Decorations.idForFlag(decoFlag));
  },

  /** Lua: Decorations.lua:351 */
  give(events: EventsLike, decoId: number | null | undefined): boolean {
    const attr = Decorations.attributes(decoId);
    if (!(events && attr && attr.flag != null)) return false;
    events.set(attr.flag, true);
    return true;
  },

  /** Lua: Decorations.lua:362 -- .FindOwnedDecos (EXIT is the caller's). */
  ownedCategories(events: EventsLike): DecoCategory[] {
    const out: DecoCategory[] = [];
    for (const category of Decorations.CATEGORIES) {
      for (const id of category.members) {
        if (Decorations.owns(events, id)) {
          out.push(category);
          break;
        }
      }
    }
    return out;
  },

  /** Lua: Decorations.lua:379 -- FindOwnedDecosInCategory: owned ids, then the PUT IT AWAY row, then 0. */
  rows(events: EventsLike, category: DecoCategory | null | undefined): number[] {
    const out: number[] = [];
    for (const id of (category && category.members) || []) {
      if (Decorations.owns(events, id)) out.push(id);
    }
    if (out.length === 0) return out;
    out.push(category!.id);
    out.push(0);
    return out;
  },

  // ---- Placing ----------------------------------------------------------

  /**
   * Lua: Decorations.lua:414 -- DoDecorationAction2 for one menu row.
   * Returns [changed, pages]. `side` ("left"/"right") matters only on an
   * ornament row; anything else there is the cancel.
   */
  apply(state: DecoState | null | undefined, decoId: number, side?: string | null, monName?: MonNameFn): [boolean, string[]] {
    const attr = Decorations.attributes(decoId);
    if (!(state && attr)) return [false, []];
    const action = attr.action ? ACTIONS[attr.action] : undefined;
    // DecoAction_nothing: row 0, the CANCEL row.
    if (!action) return [false, []];

    let slot = action.slot!;
    if (action.ornament) {
      if (side !== "left" && side !== "right") return [false, []];
      slot = side === "right" ? "rightOrnament" : "leftOrnament";
    }

    const current = state[slot] ?? 0;
    const name = (id: number) => Decorations.name(id, monName);

    if (action.put) {
      // DecoAction_TryPutItAway clears the slot BEFORE it checks it.
      state[slot] = 0;
      if (current === 0) return [false, [Strings.get(NOTHING_TO_PUT_AWAY)]];
      // Names the thing that WAS out, not the PUT IT AWAY row.
      return [true, [Strings.get(PUT_AWAY, name(current))]];
    }

    if (current === decoId) {
      // .alreadythere: carry, nothing written.
      return [false, [Strings.get(ALREADY_SET_UP)]];
    }

    state[slot] = decoId;
    if (current === 0) {
      return [true, [Strings.get(SET_UP, name(decoId))]];
    }
    return [true, [Strings.get(PUT_AWAY_PAGE, name(current)),
      Strings.get(AND_SET_UP, name(decoId))]];
  },

  /** Lua: Decorations.lua:457 -- the same doll on the other side comes off it. */
  clearOtherSide(state: DecoState | null | undefined, decoId: number | null | undefined, side: string | null | undefined): void {
    if (!(state && decoId != null && decoId !== 0)) return;
    const other = side === "right" ? "leftOrnament" : "rightOrnament";
    if (state[other] === decoId) state[other] = 0;
  },

  // ---- Showing: the two map callbacks -------------------------------------

  /**
   * Lua: Decorations.lua:474 -- ToggleDecorationsVisibility: per object slot,
   * {sprite, byte, flag, hidden:false} or {sprite, flag, hidden:true}.
   */
  visibility(state: DecoState | null | undefined): { sprite: number; byte?: number; flag: number; hidden: boolean }[] {
    const out: { sprite: number; byte?: number; flag: number; hidden: boolean }[] = [];
    for (const row of Decorations.OBJECT_SLOTS) {
      const decoId = (state && state[row.slot]) ?? 0;
      const attr = Decorations.attributes(decoId);
      if (decoId !== 0 && attr) {
        out.push({ sprite: row.sprite, byte: attr.sprite, flag: row.flag, hidden: false });
      } else {
        out.push({ sprite: row.sprite, flag: row.flag, hidden: true });
      }
    }
    return out;
  },

  /**
   * Lua: Decorations.lua:504 -- ToggleMaptileDecorations: {x, y, block} in
   * BLOCK coordinates; the carpet also writes the row under it.
   */
  tiles(state: DecoState | null | undefined): { x: number; y: number; block: number }[] {
    const out: { x: number; y: number; block: number }[] = [];
    const put = (slot: string, blockX: number, blockY: number): number | undefined => {
      const attr = Decorations.attributes(state ? state[slot] : undefined);
      if (attr && attr.sprite && attr.sprite !== 0) {
        out.push({ x: blockX, y: blockY, block: attr.sprite });
        return attr.sprite;
      }
      return undefined;
    };
    put("bed", 0, 2);
    put("plant", 3, 2);
    put("poster", 3, 0);
    const carpet = put("carpet", 0, 0);
    if (carpet !== undefined) {
      out.push({ x: 0, y: 1, block: carpet + 1 });
      out.push({ x: 1, y: 1, block: carpet + 2 });
      out.push({ x: 2, y: 1, block: carpet + 1 });
    }
    return out;
  },

  /** Lua: Decorations.lua:529 -- SetPosterVisibility. */
  posterVisible(state: DecoState | null | undefined): boolean {
    return ((state && state.poster) || 0) !== 0;
  },
};

export default Decorations;
