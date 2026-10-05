// Port of gen1recomp src/import/gba/object_interactions_extract.lua (GPLv3 + additional terms; see LICENSE.md).
// Global interactions are code-referenced roots, absent from MapEvents BFS.
// Read the original script bytecode/text and metatile attributes from the ROM.
// NOT FAITHFUL: the RSE path (readScriptsRse / readRse) needs Emerald's
// symbol tables and behavior translator, which are not ported; it is kept
// for shape and throws (Syms / MB.translator raise "NOT FAITHFUL: Emerald only").

import { format, tostring } from "./lua.ts";
import { luaGet, luaKeys } from "./luatable.ts";
import { Versions } from "./versions.ts";
import { Family } from "./family.ts";
import { Syms } from "./syms.ts";
import { MapTree } from "./map_tree.ts";
import { MapCatalog } from "./map_catalog.ts";
import { ExtractScripts } from "./extract_scripts.ts";
import type { Cache } from "./cache.ts";
import type { Rom } from "./rom.ts";
import { InteractionScripts as I } from "../../game/gen3/core/scripting/interaction_scripts.ts";
import { Opcodes } from "../../game/gen3/core/scripting/opcodes.ts";
import { MB } from "../../game/gen3/core/mb.ts";

type Tbl = Record<string, any>;

// Lua: object_interactions_extract.lua:14
function flavorBase(rom: Rom): number {
  for (let off = Versions.address(0x1A7000); off <= Versions.address(0x1A8000); off++) {
    let match = true;
    for (let n = 0; n <= 27; n++) {
      const p = off + n * 9;
      if (rom.get(p) !== 0x0F || rom.get(p + 1) !== 0 || rom.get(p + 6) !== 9
        || rom.get(p + 7) !== 3 || rom.get(p + 8) !== 2) { match = false; break; }
    }
    if (match) {
      const text = rom.ptrOffset(rom.u32(off + 2));
      // "It's" at the start of Text_Bookshelf (Latin BPRE).
      if (text !== undefined && rom.get(text) === 0xC3 && rom.get(text + 1) === 0xE8
        && rom.get(text + 2) === 0xB4 && rom.get(text + 3) === 0xE7) return off;
    }
  }
  throw new Error("Original object interaction scripts not found in this FireRed ROM");
}

// Lua: object_interactions_extract.lua:192
function serialize(value: unknown): string {
  if (typeof value === "string") return format("%q", value);
  if (value === null || typeof value !== "object") return tostring(value);
  const keys = luaKeys(value);
  const ks = (k: number | string): string => (typeof k === "number" ? tostring(k) : k);
  keys.sort((a, b) => {
    const sa = ks(a), sb = ks(b);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  });
  const out = ["{"];
  for (const k of keys) out.push("[" + serialize(k) + "]=" + serialize(luaGet(value, k)) + ",");
  out.push("}");
  return out.join("");
}

export const E = {
  PATH: "data/generated/gba/objects/pack.lua",

  // src/field_control_avatar.c:539,:573-577
  CODE_SLOTS: [
    [8, "TrainerTower_EventScript_ShowTime"],
    [25, "CableClub_EventScript_ShowWirelessCommunicationScreen"],
    [26, "EventScript_Questionnaire"],
    [27, "CableClub_EventScript_ShowBattleRecords"],
  ] as [number, string][],

  // Lua: object_interactions_extract.lua:31
  readScripts(rom: Rom): Tbl {
    const base = flavorBase(rom);
    const seeds: number[] = [], aliases: Record<string, string> = {};
    I.FLAVOR.forEach((row, idx) => {
      const n = idx + 1;
      const ptr = 0x08000000 + base + (n - 1) * 9;
      seeds.push(ptr); aliases["EventScript_" + row[1]] = Opcodes.key(ptr);
    });
    // GetInteractedMetatileScript's preceding literal is WallTownMap.
    let pool: number | undefined;
    for (let off = 0x6D000; off <= 0x6D900; off += 4) {
      if (rom.u32(off) === base + 0x08000000 && rom.u32(off + 24) === base + 9 + 0x08000000) {
        pool = off; break;
      }
    }
    if (pool === undefined) throw new Error("Wall Town Map script reference not found");
    const wall = rom.u32(pool - 24);
    if (rom.ptrOffset(wall) === undefined) throw new Error("Wall Town Map script reference not found");
    seeds.push(wall); aliases.EventScript_WallTownMap = Opcodes.key(wall);
    for (const row of E.CODE_SLOTS) {
      const ptr = rom.u32(pool + row[0] * 24);
      if (rom.ptrOffset(ptr) === undefined) throw new Error("Interaction script reference not found: " + row[1]);
      seeds.push(ptr); aliases[row[1]] = Opcodes.key(ptr);
    }
    for (const row of I.CODE) if (!aliases[row[1]]) throw new Error("unseeded interaction script " + row[1]);
    const pack = ExtractScripts.bfsFromSeeds(rom, seeds);
    for (const alias of Object.keys(aliases)) {
      const s = pack.scripts[aliases[alias]!];
      if (!s) throw new Error("assertion failed!");
      pack.scripts[alias] = s;
    }
    return { version: 1, scripts: pack.scripts, text: pack.text, movements: pack.movements };
  },

  // pokeemerald/src/field_control_avatar.c:367
  RSE_INTERACTIONS: [
    ["TELEVISION", "EventScript_TV", "north"],
    ["PC", "EventScript_PC"],
    ["CLOSED_SOOTOPOLIS_DOOR", "EventScript_ClosedSootopolisDoor"],
    ["SKY_PILLAR_CLOSED_DOOR", "SkyPillar_Outside_EventScript_ClosedDoor"],
    ["CABLE_BOX_RESULTS_1", "EventScript_CableBoxResults"],
    ["POKEBLOCK_FEEDER", "EventScript_PokeBlockFeeder"],
    ["TRICK_HOUSE_PUZZLE_DOOR", "Route110_TrickHousePuzzle_EventScript_Door"],
    ["REGION_MAP", "EventScript_RegionMap"],
    ["RUNNING_SHOES_INSTRUCTION", "EventScript_RunningShoesManual"],
    ["PICTURE_BOOK_SHELF", "EventScript_PictureBookShelf"],
    ["BOOKSHELF", "EventScript_BookShelf"],
    ["POKEMON_CENTER_BOOKSHELF", "EventScript_PokemonCenterBookShelf"],
    ["VASE", "EventScript_Vase"],
    ["TRASH_CAN", "EventScript_EmptyTrashCan"],
    ["SHOP_SHELF", "EventScript_ShopShelf"],
    ["BLUEPRINT", "EventScript_Blueprint"],
    ["WIRELESS_BOX_RESULTS", "EventScript_WirelessBoxResults", "north"],
    ["CABLE_BOX_RESULTS_2", "EventScript_CableBoxResults", "north"],
    ["QUESTIONNAIRE", "EventScript_Questionnaire"],
    ["TRAINER_HILL_TIMER", "EventScript_TrainerHillTimer"],
    ["SECRET_BASE_PC", "SecretBase_EventScript_PC", "elevation"],
    ["SECRET_BASE_REGISTER_PC", "SecretBase_EventScript_RecordMixingPC", "elevation"],
    ["SECRET_BASE_SAND_ORNAMENT", "SecretBase_EventScript_SandOrnament", "elevation"],
    ["SECRET_BASE_TV_SHIELD", "SecretBase_EventScript_ShieldOrToyTV", "elevation"],
  ] as [string, string, string?][],

  // pokeemerald/src/field_control_avatar.c:448,463,508
  RSE_CODE_ROOTS: [
    "EventScript_UseSurf", "EventScript_UseWaterfall", "EventScript_CannotUseWaterfall",
    "EventScript_UseDive", "EventScript_FallDownHole",
  ],

  // Lua: object_interactions_extract.lua:90 -- [seeds, aliases]
  readScriptsRse(game: string): [number[], Record<string, string>] {
    const S = Syms.of(game);
    const seeds: number[] = [], aliases: Record<string, string> = {};
    const add = (name: string): void => {
      if (aliases[name]) return;
      const ptr = 0x08000000 + S.off(name);
      seeds.push(ptr); aliases[name] = Opcodes.key(ptr);
    };
    for (const row of E.RSE_INTERACTIONS) add(row[1]);
    for (const name of E.RSE_CODE_ROOTS) add(name);
    return [seeds, aliases];
  },

  // Lua: object_interactions_extract.lua:102
  readRse(rom: Rom, _version: any): Tbl {
    const F = Family.active();
    const Mb = MB.translator(F.game);
    if (!Mb) throw new Error("no behavior translator for " + tostring(F.game));
    // NOT FAITHFUL: Emerald only -- the rest of readRse (tile bits, per-pair
    // canonical behaviors) needs the mb_<game> translator, which is not ported.
    throw new Error("NOT FAITHFUL: Emerald only -- object_interactions_extract.readRse is not ported");
  },

  // Lua: object_interactions_extract.lua:157
  read(rom: Rom, version: any): Tbl {
    if (Family.active().name !== "frlg") return E.readRse(rom, version);
    const pack = E.readScripts(rom);
    const V = Versions;
    const [census] = MapTree.walk(rom, version);
    if (!census) throw new Error("assertion failed!");
    const [order, entries] = MapCatalog.allOrder(census);
    MapCatalog.registerOrder(rom, version, order, entries);
    pack.behaviors = {};
    pack.encounterTypes = {};
    const attrs: Record<string, Record<number, number>> = {};
    const attributes = (name: string): Record<number, number> => {
      if (attrs[name]) return attrs[name]!;
      const spec = ((version && version.tilesets) || V.TILESETS)[name];
      if (!spec) throw new Error("assertion failed!");
      const out: Record<number, number> = {};
      for (let i = 0; i <= Math.floor(spec.attr_bytes / 4) - 1; i++) out[i] = rom.u32(spec.attributes + i * 4);
      attrs[name] = out; return out;
    };
    // pokefirered/src/fieldmap.c:68
    const pairsTbl = (version && version.tileset_pairs) || V.TILESET_PAIRS;
    for (const name of Object.keys(pairsTbl)) {
      const pair = pairsTbl[name];
      const out: Record<number, number> = {}; pack.behaviors[name] = out;
      const enc: Record<number, number> = {}; pack.encounterTypes[name] = enc;
      const prim = attributes(pair.primary);
      for (const k of Object.keys(prim)) {
        const mid = Number(k), w = prim[mid]!;
        out[mid] = w % 512;
        const e = Math.floor(w / 0x1000000) % 8;
        if (e !== 0) enc[mid] = e;
      }
      const sec = attributes(pair.secondary);
      for (const k of Object.keys(sec)) {
        const mid = Number(k), w = sec[mid]!;
        out[mid + 640] = w % 512;
        const e = Math.floor(w / 0x1000000) % 8;
        if (e !== 0) enc[mid + 640] = e;
      }
    }
    return pack;
  },

  // Lua: object_interactions_extract.lua:201
  writeExtract(rom: Rom, cache: Cache, root: string | undefined, version: any): Tbl {
    const pack = E.read(rom, version);
    const path = (root ?? "data/generated/gba") + "/objects/pack.lua";
    if (!cache.write(path, "return " + serialize(pack) + "\n")) throw new Error("assertion failed!");
    return pack;
  },
};

export const ObjectInteractionsExtract = E;
export default E;
