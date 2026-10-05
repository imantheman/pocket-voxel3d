// Port of gen1recomp src/core/game3/items_data.lua (GPLv3 + additional terms; see LICENSE.md).
// FRLG item metadata loaded from extracted pack (pret items.json).

/* eslint-disable @typescript-eslint/no-explicit-any */
import { RomText } from "./rom_text.ts";
import { Profile } from "./profile.ts";
import { Constants } from "./constants.ts";
import { Dataset } from "./dataset.ts";
import { luaLoad } from "../platform/luadata.ts";
import { pairs, ipairs } from "../platform/lt.ts";
import { format, tonumber, tostring, truthy } from "../../../import/gen3/lua.ts";
import { find, gsub, match } from "../platform/lpattern.ts";

type Tbl = Record<string | number, any>;

export interface ItemInfo {
  id: number | string;
  name: any;
  pocket: any;
  fieldUse: any;
  frlg?: number;
  price?: any;
  holdEffect?: any;
  holdEffectParam?: any;
  description?: any;
  battleUsage?: any;
  fieldUseFunc?: any;
  battleUseFunc?: any;
  registrability?: any;
  importance?: any;
  secondaryId?: any;
  effect?: any;
  pocketId?: any;
  fieldUseName?: any;
  battleUseName?: any;
}

interface HostRow { pocket: string; fieldUse: string; frlg: number }

const LABEL_KEYS: Tbl = {};
let pocketLabel: any;

// Lua: items_data.lua:18
function refill(dst: Tbl, src: Tbl | null | undefined): Tbl {
  for (const k of Object.keys(dst)) delete dst[k];
  for (const [k, v] of pairs(src ?? {})) dst[k] = v;
  return dst;
}

const GEN2_BERRY_ALIASES: Record<string, number> = {
  BERRY: 139, // ORAN BERRY
  GOLD_BERRY: 142, // SITRUS BERRY
  GOLDBERRY: 142,
  MYSTERYBERRY: 138, // LEPPA BERRY
  MIRACLEBERRY: 141, // LUM BERRY
  PSNCUREBERRY: 135, // PECHA BERRY
  PRZCUREBERRY: 133, // CHERI BERRY
  BURNT_BERRY: 136, // RAWST BERRY
  ICE_BERRY: 137, // ASPEAR BERRY
  BITTER_BERRY: 140, // PERSIM BERRY
  MINT_BERRY: 134, // CHESTO BERRY
};

// Lua: items_data.lua:159
function read_bytes(rel: string): string | undefined {
  Dataset.mountExtractRoots();
  const d = Dataset.cache().read(rel);
  if (typeof d === "string" && d.length > 0) return d;
  return undefined;
}

// Lua: items_data.lua:183
function build_by_name(packItems: any): Tbl {
  const map: Tbl = {};
  if (packItems !== null && typeof packItems === "object") {
    for (const [id, it] of pairs(packItems)) {
      if (it !== null && typeof it === "object" && truthy(it.name)) {
        const n = (it.name as string).toUpperCase();
        map[n] = id;
        map[gsub(n, "%s+", "_")[0]] = id;
        map[gsub(n, "[^%w]", "")[0]] = id;
      }
    }
  }
  for (const [k, v] of pairs(GEN2_BERRY_ALIASES)) {
    map[k] = v;
  }
  for (let i = 1; i <= 50; i++) {
    map[format("TM%02d", i)] = 288 + i;
    map[format("TM_%02d", i)] = 288 + i;
    map[format("TM%d", i)] = 288 + i;
    map[format("TM_%d", i)] = 288 + i;
  }
  for (let i = 1; i <= 8; i++) {
    map[format("HM%02d", i)] = 338 + i;
    map[format("HM_%02d", i)] = 338 + i;
    map[format("HM%d", i)] = 338 + i;
    map[format("HM_%d", i)] = 338 + i;
  }
  return map;
}

// Lua: items_data.lua:220
function load_pack(): Tbl {
  if (!ItemsData._bagModel) ItemsData.ensureModel();
  if (ItemsData._byId) return ItemsData._byId;
  const src = read_bytes("data/generated/gba/items/pack.lua");
  if (src) {
    const [chunk] = luaLoad(src, "@items/pack.lua");
    if (chunk) {
      let ok: boolean;
      let pack: any;
      try {
        pack = chunk();
        ok = true;
      } catch (e) {
        ok = false;
        pack = e;
      }
      if (ok && pack !== null && typeof pack === "object" && pack.items !== null && typeof pack.items === "object") {
        ItemsData.installPack(pack);
        if (!ItemsData._logged) {
          ItemsData._logged = true;
          console.log("[game3/items] pack ready (" + tostring(pack.count) + ")");
        }
        return ItemsData._byId as unknown as Tbl;
      }
      throw new Error("items/pack.lua did not load: " + tostring(pack));
    }
  }
  throw new Error("items/pack.lua is not in the cache");
}

// Lua: items_data.lua:255
function normalize_id(id: any): [number | undefined, string | undefined] {
  if (id == null) return [undefined, undefined];
  const s = tostring(id);
  if (match(s, "^FRLG_(%d+)$") != null) {
    return [tonumber(match(s, "^FRLG_(%d+)$")), s];
  }
  const num = tonumber(id);
  if (num !== undefined) return [num, tostring(num)];

  load_pack();
  const sUpper = s.toUpperCase();
  if (ItemsData._byName && ItemsData._byName[sUpper] != null) {
    return [ItemsData._byName[sUpper], s];
  }

  const tm = match(sUpper, "^TM_?(%d+)$");
  if (tm != null) {
    const n = tonumber(tm);
    if (n !== undefined && n >= 1 && n <= 50) return [288 + n, s];
  }
  const hm = match(sUpper, "^HM_?(%d+)$");
  if (hm != null) {
    const n = tonumber(hm);
    if (n !== undefined && n >= 1 && n <= 8) return [338 + n, s];
  }

  return [undefined, s];
}

// Refine FieldUseFunc_Medicine → heal/status/revive (pack maps all to "heal").
const STATUS_IDS: Record<number, boolean> = {
  14: true, 15: true, 16: true, 17: true, 18: true, // status heals
  23: true, // FULL HEAL
  32: true, // HEAL POWDER
  133: true, 134: true, 135: true, 136: true, 137: true, // status berries
};
const REVIVE_IDS: Record<number, boolean> = {
  24: true, 25: true, 45: true, // REVIVE / MAX / SACRED ASH
};
const FULL_RESTORE_IDS: Record<number, boolean> = { 19: true };

// include/constants/items.h:97-102
const LEVEL_IDS: Record<number, boolean> = { 68: true };
const EVO_IDS: Record<number, boolean> = { 93: true, 94: true, 95: true, 96: true, 97: true, 98: true };
const VITAMIN_IDS: Record<number, boolean> = { 63: true, 64: true, 65: true, 66: true, 67: true, 70: true };
const ESCAPE_IDS: Record<number, boolean> = { 85: true };
const REPEL_IDS: Record<number, boolean> = { 83: true, 84: true, 86: true };
// pokefirered/src/data/items.h:3962 FieldUseFunc_Bike
const BIKE_IDS: Record<number, boolean> = { 259: true, 272: true, 360: true };
// pokefirered/src/data/items.h:5492 FieldUseFunc_TownMap
const MAP_IDS: Record<number, boolean> = { 361: true };
// pokefirered/src/data/items.h:3977 FieldUseFunc_CoinCase
const COIN_CASE_IDS: Record<number, boolean> = { 260: true };
// pokefirered/src/data/items.h:5657 FieldUseFunc_PowderJar
const POWDER_JAR_IDS: Record<number, boolean> = { 372: true };
// pokefirered/src/data/items.h:3992 ItemUseOutOfBattle_Itemfinder
const ITEMFINDER_IDS: Record<number, boolean> = { 261: true };
// pokefirered/src/data/items.h:5507 FieldUseFunc_VsSeeker
const VS_SEEKER_IDS: Record<number, boolean> = { 362: true };

/** `t[k]` where Lua allows a nil key (reads give nil). */
function at(t: Record<number, boolean>, k: number | undefined): boolean {
  return k != null && t[k] === true;
}

export const ItemsData = {
  POCKET: {} as Tbl,
  POCKET_ORDER: {} as Tbl,
  BAG_POCKET_ORDER: {} as Tbl,
  // Lua: items_data.lua:10 ItemsData.POCKET_LABEL = RomText.lazy(LABEL_KEYS)
  // NOT FAITHFUL (load order): RomText.lazy runs on the first read of
  // POCKET_LABEL instead of at load, so this module loads before rom_text is
  // usable. The table is the same lazy view of LABEL_KEYS either way.
  get POCKET_LABEL(): any {
    if (pocketLabel === undefined) pocketLabel = RomText.lazy(LABEL_KEYS);
    return pocketLabel;
  },
  POCKET_RESULT: {} as Tbl,
  CAPACITY: {} as Tbl,
  PACK_POCKET: {} as Tbl,
  CONTAINERS: {} as Record<string, { item: number; flag: string | undefined }>,
  BAG_MODEL: { slotMax: {}, splitSlots: {}, sortHmsFirst: {}, sortById: {} } as {
    slotMax: Tbl; splitSlots: Tbl; sortHmsFirst: Tbl; sortById: Tbl; pcSlotMax?: any; pcItems?: any;
  },
  _bagModel: null as any,

  // Lua: items_data.lua:24
  applyProfile(version?: string | null): any {
    const row = Profile.of(version ?? undefined);
    const bag = row.bag;
    if (bag === null || typeof bag !== "object") {
      throw new Error("game3 profile '" + tostring(row.id) + "' has no bag block");
    }
    refill(ItemsData.POCKET, {});
    refill(ItemsData.POCKET_RESULT, {});
    for (const [i, name] of ipairs<string>(bag.pockets)) {
      ItemsData.POCKET[name] = name;
      ItemsData.POCKET_RESULT[name] = i;
    }
    refill(ItemsData.POCKET_ORDER, bag.pockets);
    refill(ItemsData.BAG_POCKET_ORDER, bag.visible);
    refill(LABEL_KEYS, bag.labels);
    refill(ItemsData.CAPACITY, bag.capacity);
    refill(ItemsData.PACK_POCKET, bag.packPockets);
    const C = Constants.of(row.id);
    const containers: Tbl = {};
    for (const [pocket, c] of pairs(bag.containers ?? {})) {
      containers[pocket] = { item: C.require("items", c.item), flag: c.flag };
    }
    refill(ItemsData.CONTAINERS, containers);
    refill(ItemsData.BAG_MODEL.slotMax, bag.slotMax);
    refill(ItemsData.BAG_MODEL.splitSlots, bag.splitSlots);
    refill(ItemsData.BAG_MODEL.sortHmsFirst, bag.sortHmsFirst);
    refill(ItemsData.BAG_MODEL.sortById, bag.sortById);
    ItemsData.BAG_MODEL.pcSlotMax = bag.pcSlotMax;
    ItemsData.BAG_MODEL.pcItems = bag.pcItems;
    ItemsData._bagModel = bag;
    return bag;
  },

  // Lua: items_data.lua:57
  ensureModel(sessionOrVersion?: any): void {
    const row = truthy(sessionOrVersion) ? Profile.forSession(sessionOrVersion) : Profile.active();
    const bag = row.bag;
    if (bag !== ItemsData._bagModel) {
      ItemsData._pack = null;
      ItemsData._byId = null;
      ItemsData._byName = null;
      ItemsData._logged = false;
      ItemsData.applyProfile(row.id);
    }
  },

  // Lua: items_data.lua:70
  slotMax(pocket: string): number {
    const m = ItemsData.BAG_MODEL.slotMax;
    return m[pocket] ?? m.default;
  },

  // pokefirered/include/constants/items.h:272
  ITEM_ITEMFINDER: 261,
  ITEM_TM_CASE: 364,
  ITEM_BERRY_POUCH: 365,
  // pokefirered/include/constants/items.h:434
  ITEM_VS_SEEKER: 362,
  FIRST_TM: 289,
  LAST_TM: 338,
  FIRST_HM: 339,
  LAST_HM: 346,

  _pack: null as any,
  _byId: null as Tbl | null,
  _logged: false,

  // Host string id → display / pocket (Sevii ferry).
  BY_HOST: {
    MASTER_BALL: { pocket: "POKE_BALLS", fieldUse: "battle", frlg: 1 },
    ULTRA_BALL: { pocket: "POKE_BALLS", fieldUse: "battle", frlg: 2 },
    GREAT_BALL: { pocket: "POKE_BALLS", fieldUse: "battle", frlg: 3 },
    POKE_BALL: { pocket: "POKE_BALLS", fieldUse: "battle", frlg: 4 },
    POTION: { pocket: "ITEMS", fieldUse: "heal", frlg: 13 },
    ANTIDOTE: { pocket: "ITEMS", fieldUse: "status", frlg: 14 },
    BURN_HEAL: { pocket: "ITEMS", fieldUse: "status", frlg: 15 },
    ICE_HEAL: { pocket: "ITEMS", fieldUse: "status", frlg: 16 },
    AWAKENING: { pocket: "ITEMS", fieldUse: "status", frlg: 17 },
    PARLYZ_HEAL: { pocket: "ITEMS", fieldUse: "status", frlg: 18 },
    FULL_RESTORE: { pocket: "ITEMS", fieldUse: "heal", frlg: 19 },
    MAX_POTION: { pocket: "ITEMS", fieldUse: "heal", frlg: 20 },
    HYPER_POTION: { pocket: "ITEMS", fieldUse: "heal", frlg: 21 },
    SUPER_POTION: { pocket: "ITEMS", fieldUse: "heal", frlg: 22 },
    FULL_HEAL: { pocket: "ITEMS", fieldUse: "status", frlg: 23 },
    REVIVE: { pocket: "ITEMS", fieldUse: "revive", frlg: 24 },
    MAX_REVIVE: { pocket: "ITEMS", fieldUse: "revive", frlg: 25 },
    FRESH_WATER: { pocket: "ITEMS", fieldUse: "heal", frlg: 26 },
    SODA_POP: { pocket: "ITEMS", fieldUse: "heal", frlg: 27 },
    LEMONADE: { pocket: "ITEMS", fieldUse: "heal", frlg: 28 },
    SUPER_REPEL: { pocket: "ITEMS", fieldUse: "repel", frlg: 83 },
    MAX_REPEL: { pocket: "ITEMS", fieldUse: "repel", frlg: 84 },
    ESCAPE_ROPE: { pocket: "ITEMS", fieldUse: "escape", frlg: 85 },
    REPEL: { pocket: "ITEMS", fieldUse: "repel", frlg: 86 },
    X_ATTACK: { pocket: "ITEMS", fieldUse: "battle", frlg: 75 },
    X_DEFEND: { pocket: "ITEMS", fieldUse: "battle", frlg: 76 },
    X_SPEED: { pocket: "ITEMS", fieldUse: "battle", frlg: 77 },
    X_ACCURACY: { pocket: "ITEMS", fieldUse: "battle", frlg: 78 },
    X_SPECIAL: { pocket: "ITEMS", fieldUse: "battle", frlg: 79 },
    POKE_DOLL: { pocket: "ITEMS", fieldUse: "battle", frlg: 80 },
    RARE_CANDY: { pocket: "ITEMS", fieldUse: "level", frlg: 68 },
    SUN_STONE: { pocket: "ITEMS", fieldUse: "evo", frlg: 93 },
    MOON_STONE: { pocket: "ITEMS", fieldUse: "evo", frlg: 94 },
    FIRE_STONE: { pocket: "ITEMS", fieldUse: "evo", frlg: 95 },
    THUNDER_STONE: { pocket: "ITEMS", fieldUse: "evo", frlg: 96 },
    WATER_STONE: { pocket: "ITEMS", fieldUse: "evo", frlg: 97 },
    LEAF_STONE: { pocket: "ITEMS", fieldUse: "evo", frlg: 98 },
    ORAN_BERRY: { pocket: "BERRY_POUCH", fieldUse: "heal", frlg: 139 },
    SITRUS_BERRY: { pocket: "BERRY_POUCH", fieldUse: "heal", frlg: 142 },
    LUM_BERRY: { pocket: "BERRY_POUCH", fieldUse: "status", frlg: 141 },
    LEPPA_BERRY: { pocket: "BERRY_POUCH", fieldUse: "pp", frlg: 138 },
    NUGGET: { pocket: "ITEMS", fieldUse: "none", frlg: 110 },
    METEORITE: { pocket: "KEY_ITEMS", fieldUse: "key", frlg: 280 },
    ITEMFINDER: { pocket: "KEY_ITEMS", fieldUse: "itemfinder", frlg: 261 },
    TOWN_MAP: { pocket: "KEY_ITEMS", fieldUse: "map", frlg: 361 },
    BICYCLE: { pocket: "KEY_ITEMS", fieldUse: "bike", frlg: 360 },
    TRI_PASS: { pocket: "KEY_ITEMS", fieldUse: "key", frlg: 367 },
    RAINBOW_PASS: { pocket: "KEY_ITEMS", fieldUse: "key", frlg: 368 },
    VS_SEEKER: { pocket: "KEY_ITEMS", fieldUse: "vs_seeker", frlg: 362 },
  } as Record<string, HostRow>,

  HEAL_AMOUNT: {
    13: 20, 19: 9999, 20: 9999, 21: 200, 22: 50,
    26: 50, 27: 60, 28: 80, 29: 100,
    139: 10, 142: 30,
    POTION: 20, SUPER_POTION: 50, HYPER_POTION: 200,
    MAX_POTION: 9999, FULL_RESTORE: 9999,
    FRESH_WATER: 50, SODA_POP: 60, LEMONADE: 80,
    ORAN_BERRY: 10, SITRUS_BERRY: 30,
  } as Record<string | number, number>,

  REPEL_STEPS: {
    86: 100, 83: 200, 84: 250,
    REPEL: 100, SUPER_REPEL: 200, MAX_REPEL: 250,
  } as Record<string | number, number>,

  _byName: null as Tbl | null,

  // Lua: items_data.lua:213
  installPack(pack: any): Tbl {
    ItemsData._pack = pack;
    ItemsData._byId = pack.items;
    ItemsData._byName = build_by_name(pack.items);
    return ItemsData._byId as Tbl;
  },

  // Lua: items_data.lua:242
  ensureLoaded(): Tbl {
    return load_pack();
  },

  // Lua: items_data.lua:246
  install(_cache?: any): void {
    ItemsData._pack = null;
    ItemsData._byId = null;
    ItemsData._byName = null;
    ItemsData._logged = false;
    ItemsData.applyProfile(null);
    load_pack();
  },

  // Lua: items_data.lua:284
  info(id: any): ItemInfo | undefined {
    if (id == null) return undefined;
    const byId = load_pack();
    const [num] = normalize_id(id);
    if (num !== undefined && byId[num] != null) {
      const e = byId[num];
      return {
        id: num,
        name: e.name,
        pocket: ItemsData.PACK_POCKET[e.pocket] ?? e.pocket,
        fieldUse: e.fieldUse ?? "none",
        price: e.price,
        holdEffect: e.holdEffect,
        holdEffectParam: e.holdEffectParam,
        description: e.description,
        battleUsage: e.battleUsage,
        fieldUseFunc: e.fieldUseFunc,
        battleUseFunc: e.battleUseFunc,
        registrability: e.registrability,
        importance: e.importance,
        secondaryId: e.secondaryId,
        effect: e.effect,
        pocketId: e.pocketId,
        fieldUseName: e.fieldUseName,
        battleUseName: e.battleUseName,
      };
    }
    const s = tostring(id);
    const h = ItemsData.BY_HOST[s];
    if (h) {
      return {
        id: s,
        name: byId[h.frlg] != null && truthy(byId[h.frlg].name) ? byId[h.frlg].name : gsub(s, "_", " ")[0],
        pocket: h.pocket,
        fieldUse: h.fieldUse,
        frlg: h.frlg,
      };
    }
    if (num !== undefined) return undefined;
    const sUpper = s.toUpperCase();
    if (find(sUpper, "BERRY", 1, true) != null) {
      return { id: s, name: gsub(s, "_", " ")[0], pocket: "BERRY_POUCH", fieldUse: "heal" };
    }
    if (find(sUpper, "^TM%d") != null || find(sUpper, "^HM%d") != null || find(sUpper, "^TM_") != null || find(sUpper, "^HM_") != null) {
      return { id: s, name: gsub(s, "_", " ")[0], pocket: "TM_CASE", fieldUse: "tm" };
    }
    return { id: s, name: gsub(s, "_", " ")[0], pocket: "ITEMS", fieldUse: "none" };
  },

  // Lua: items_data.lua:333
  pocketOf(id: any): string {
    const info = ItemsData.info(id);
    return info && truthy(info.pocket) ? info.pocket : "ITEMS";
  },

  // Lua: items_data.lua:338
  pocketResult(id: any): number {
    const pocket = ItemsData.pocketOf(id);
    return ItemsData.POCKET_RESULT[pocket] ?? 1;
  },

  // Lua: items_data.lua:343
  displayName(id: any): string {
    const info = ItemsData.info(id);
    return info && truthy(info.name) ? info.name : tostring(id);
  },

  // Lua: items_data.lua:348
  // The Lua returns the last gsub's (string, count); every caller reads the
  // string only, so this returns the string.
  description(id: any): string {
    const info = ItemsData.info(id);
    const desc: string = info && truthy(info.description) ? info.description : "";
    return gsub(gsub(desc, "\\n", "\n")[0], "\\p", "\n")[0];
  },

  // Lua: items_data.lua:354
  isTm(id: any): boolean {
    let num = tonumber(id);
    if (num === undefined) {
      const n2 = normalize_id(id)[0];
      num = n2;
    }
    if (num === undefined) {
      const s = tostring(id ?? "").toUpperCase();
      return find(s, "^TM%d+") != null || find(s, "^HM%d+") != null;
    }
    const ftm = ItemsData.FIRST_TM ?? 289;
    const ltm = ItemsData.LAST_TM ?? 338;
    const fhm = ItemsData.FIRST_HM ?? 339;
    const lhm = ItemsData.LAST_HM ?? 346;
    return (num >= ftm && num <= ltm) || (num >= fhm && num <= lhm);
  },

  // Lua: items_data.lua:371
  isEvolutionStone(id: any): boolean {
    let num = tonumber(id);
    if (num === undefined) {
      const n2 = normalize_id(id)[0];
      num = n2;
    }
    if (num === undefined) {
      const s = tostring(id ?? "").toUpperCase();
      return find(s, "STONE", 1, true) != null;
    }
    // include/constants/items.h:97-102
    return num >= 93 && num <= 98;
  },

  // Lua: items_data.lua:385
  /** nil (not false) when the id has no number, as `num and ...` gives. */
  isHm(id: any): boolean | null {
    let num = tonumber(id);
    if (num === undefined) {
      const n2 = normalize_id(id)[0];
      num = n2;
    }
    if (num === undefined) return null;
    return num >= ItemsData.FIRST_HM && num <= ItemsData.LAST_HM;
  },

  FIRST_BERRY: 133,
  LAST_BERRY: 175,

  // Lua: items_data.lua:397
  isBerry(id: any): boolean | null {
    let num = tonumber(id);
    if (num === undefined) {
      num = ItemsData.toNumericId(id);
    }
    if (num === undefined) return null;
    return num >= ItemsData.FIRST_BERRY && num <= ItemsData.LAST_BERRY;
  },

  // Lua: items_data.lua:406
  /** Get 1-based Berry index (1..43) from item ID. */
  berryNumber(id: any): number | undefined {
    let num = tonumber(id);
    if (num === undefined) {
      num = ItemsData.toNumericId(id);
    }
    if (num !== undefined && num >= ItemsData.FIRST_BERRY && num <= ItemsData.LAST_BERRY) {
      return num - ItemsData.FIRST_BERRY + 1;
    }
    return undefined;
  },

  // Lua: items_data.lua:418
  /** Get 1-based TM (1..50) or HM (1..8) index from item ID. */
  tmNumber(id: any): number | undefined {
    let num = tonumber(id);
    if (num === undefined) {
      num = ItemsData.toNumericId(id);
    }
    if (num !== undefined) {
      if (num >= ItemsData.FIRST_TM && num <= ItemsData.LAST_TM) {
        return num - ItemsData.FIRST_TM + 1;
      } else if (num >= ItemsData.FIRST_HM && num <= ItemsData.LAST_HM) {
        return num - ItemsData.FIRST_HM + 1;
      }
    }
    const s = tostring(id).toUpperCase();
    const tm = match(s, "TM_?(%d+)");
    if (tm != null) return tonumber(tm);
    const hm = match(s, "HM_?(%d+)");
    if (hm != null) return tonumber(hm);
    return undefined;
  },

  // Lua: items_data.lua:440
  /** Canonical bag key: prefer numeric FRLG id string. */
  bagKey(id: any): string {
    const num = normalize_id(id)[0];
    if (num !== undefined) return tostring(num);
    const h = ItemsData.BY_HOST[tostring(id)];
    if (h && truthy(h.frlg)) return tostring(h.frlg);
    return tostring(id);
  },

  // Lua: items_data.lua:448
  toNumericId(id: any): number | undefined {
    const num = normalize_id(id)[0];
    if (num !== undefined) return num;
    const h = ItemsData.BY_HOST[tostring(id)];
    if (h && truthy(h.frlg)) return h.frlg;
    return undefined;
  },

  // Lua: items_data.lua:469
  /** Coarse medicine kind for field/battle use. */
  medicineKind(id: any): string {
    const num = ItemsData.toNumericId(id) ?? tonumber(id);
    const host = tostring(id);
    if (at(FULL_RESTORE_IDS, num) || host === "FULL_RESTORE") return "full_restore";
    if (at(REVIVE_IDS, num) || host === "REVIVE" || host === "MAX_REVIVE" || host === "SACRED_ASH") {
      return "revive";
    }
    if (at(STATUS_IDS, num) || host === "ANTIDOTE" || host === "FULL_HEAL"
        || host === "BURN_HEAL" || host === "ICE_HEAL" || host === "AWAKENING"
        || host === "PARLYZ_HEAL") {
      return "status";
    }
    const info = ItemsData.info(id);
    if (info && info.fieldUse === "revive") return "revive";
    if (info && info.fieldUse === "status") return "status";
    if (info && info.fieldUse === "heal") return "heal";
    return info && truthy(info.fieldUse) ? info.fieldUse : "none";
  },

  // Lua: items_data.lua:508
  /** Effective field-use kind (medicine refined). */
  fieldUseKind(id: any): string {
    const num = ItemsData.toNumericId(id) ?? tonumber(id);
    const host = tostring(id).toUpperCase();
    if (at(LEVEL_IDS, num) || host === "RARE_CANDY") return "level";
    if (at(EVO_IDS, num) || find(host, "STONE", 1, true) != null) return "evo";
    if (at(VITAMIN_IDS, num) || host === "HP_UP" || host === "PROTEIN" || host === "IRON"
        || host === "CARBOS" || host === "CALCIUM" || host === "ZINC") {
      return "vitamin";
    }
    if ((num !== undefined && num >= 289 && num <= 346) || find(host, "^TM%d") != null || find(host, "^HM%d") != null
        || find(host, "TM_") != null || find(host, "HM_") != null) {
      return "tm";
    }
    if (at(ESCAPE_IDS, num) || host === "ESCAPE_ROPE") return "escape";
    if (at(REPEL_IDS, num) || find(host, "REPEL", 1, true) != null) return "repel";
    if (at(COIN_CASE_IDS, num) || host === "COIN_CASE") return "coin_case";
    if (at(POWDER_JAR_IDS, num) || host === "POWDER_JAR") return "powder_jar";
    if (at(BIKE_IDS, num) || find(host, "BIKE", 1, true) != null || find(host, "BICYCLE", 1, true) != null) return "bike";
    if (at(MAP_IDS, num) || host === "TOWN_MAP") return "map";
    if (at(ITEMFINDER_IDS, num) || host === "ITEMFINDER") return "itemfinder";
    if (at(VS_SEEKER_IDS, num) || host === "VS_SEEKER") return "vs_seeker";

    const info = ItemsData.info(id);
    if (!info) return "none";
    if (info.fieldUse === "heal" || info.fieldUse === "status" || info.fieldUse === "revive") {
      const mk = ItemsData.medicineKind(id);
      if (mk === "full_restore") return "heal";
      return mk;
    }
    if (info.fieldUse === "level") return "level";
    if (info.fieldUse === "evo") return "evo";
    if (info.pocket === "TM_CASE") return "tm";
    return truthy(info.fieldUse) ? info.fieldUse : "none";
  },

  // Lua: items_data.lua:544
  // Back-compat for older callers.
  BY_ID: new Proxy({} as Tbl, {
    get(_t, k) {
      if (typeof k !== "string") return undefined;
      const info = ItemsData.info(k);
      if (!info) return undefined;
      return { name: info.name, pocket: info.pocket, fieldUse: info.fieldUse };
    },
  }),
};

// Lua: items_data.lua:86-89
ItemsData._pack = null;
ItemsData._byId = null;
ItemsData._logged = false;
ItemsData.applyProfile(null);

export default ItemsData;
