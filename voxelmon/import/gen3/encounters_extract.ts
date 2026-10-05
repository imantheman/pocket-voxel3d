// Port of gen1recomp src/import/gba/encounters_extract.lua (GPLv3 + additional terms; see LICENSE.md).
// Extract FRLG wild encounter tables from ROM (gWildMonHeaders).
// FireRed USA 1.0: pret wild_encounter.h layout — not curated JSON.
// Lua differences: slot / variant / section lists are 0-based arrays.

import { format, tostring } from "./lua.ts";
import { luaGet, luaLen } from "./luatable.ts";
import { Versions } from "./versions.ts";
import { GameVersion } from "./game_version.ts";
import { Family } from "./family.ts";
import type { Cache } from "./cache.ts";
import type { Rom } from "./rom.ts";
import { Profile } from "../../game/gen3/core/profile.ts";

type Tbl = Record<string, any>;

export interface Slot { species: number; minLevel: number; maxLevel: number }
export interface Area { rate: number; slots: Slot[] }
export interface WildEntry {
  mapGroup: number;
  mapNum: number;
  land?: Area;
  water?: Area;
  rocks?: Area;
  fishing?: Area;
  variants?: Tbl[];
}

// Lua: encounters_extract.lua:13
function log(msg: unknown): void {
  console.log("[gba/encounters] " + tostring(msg));
}

// Lua: encounters_extract.lua:17
function gba_off(ptr: number): number | undefined {
  return Versions.gbaToFile(ptr);
}

// Lua: encounters_extract.lua:21
function read_info(rom: Rom, infoOff: number | undefined, slotCount: number): Area | undefined {
  if (infoOff === undefined) return undefined;
  const rate = rom.get(infoOff);
  const monsPtr = rom.u32(infoOff + 4);
  const monsOff = gba_off(monsPtr);
  if (monsOff === undefined) return undefined;
  const slots: Slot[] = [];
  for (let i = 0; i <= slotCount - 1; i++) {
    const base = monsOff + i * 4;
    const minLevel = rom.get(base);
    const maxLevel = rom.get(base + 1);
    const species = rom.u16(base + 2);
    slots.push({ species, minLevel, maxLevel });
  }
  return { rate, slots };
}

// Lua: encounters_extract.lua:42
function serialize_area(lines: string[], name: string, area: Area | undefined): void {
  if (!area || !area.slots || area.slots.length === 0) return;
  lines.push(format("    %s = {\n", name));
  lines.push(format("      rate = %d,\n", area.rate ?? 0));
  lines.push("      slots = {\n");
  for (const s of area.slots) {
    lines.push(format(
      "        { species = %d, minLevel = %d, maxLevel = %d },\n",
      s.species ?? 0, s.minLevel ?? 1, s.maxLevel ?? s.minLevel ?? 1));
  }
  lines.push("      },\n");
  lines.push("    },\n");
}

// Lua: encounters_extract.lua:56
function serialize_areas(lines: string[], entry: Tbl): void {
  serialize_area(lines, "land", entry.land);
  serialize_area(lines, "water", entry.water);
  serialize_area(lines, "rocks", entry.rocks);
  serialize_area(lines, "fishing", entry.fishing);
}

// Lua: encounters_extract.lua:63
function serialize_entry(lines: string[], key: string, entry: WildEntry): void {
  lines.push(format("  [%q] = {\n", key));
  lines.push(format("    mapGroup = %d,\n", entry.mapGroup ?? 0));
  lines.push(format("    mapNum = %d,\n", entry.mapNum ?? 0));
  serialize_areas(lines, entry);
  if (entry.variants) {
    lines.push("    variants = {\n");
    for (const v of entry.variants) {
      lines.push("      {\n");
      serialize_areas(lines, v);
      lines.push("      },\n");
    }
    lines.push("    },\n");
  }
  lines.push("  },\n");
}

// Lua: encounters_extract.lua:124 -- [prefixes (0-based), enginePrefix]
function map_prefixes(): [string[], string | undefined] {
  const map = Profile.of(GameVersion.get()).map;
  const p = map.prefixes ?? {};
  const prefixes: string[] = [];
  for (let i = 1; i <= luaLen(p); i++) prefixes.push(luaGet(p, i) as string);
  return [prefixes, map.enginePrefix];
}

// Lua: encounters_extract.lua:129
function add_aliases(tables: Record<string, WildEntry>, alias: string, packed: WildEntry, prefixes: string[],
  enginePrefix: string | undefined): void {
  tables[alias] = packed;
  for (const prefix of prefixes) {
    if (alias.substring(0, prefix.length) === prefix) {
      const bare = alias.substring(prefix.length);
      tables[bare] = packed;
      const m = prefix === enginePrefix ? /^ROUTE_(\d+)$/.exec(bare) : null;
      if (m) {
        const routeNum = m[1]!;
        tables["ROUTE" + routeNum] = packed;
        tables[enginePrefix + "ROUTE" + routeNum] = packed;
      }
      return;
    }
  }
}

// Lua: encounters_extract.lua:145
function is_alias(key: string, prefixes: string[]): boolean {
  for (const prefix of prefixes) {
    if (key.substring(0, prefix.length) === prefix) return true;
  }
  return false;
}

// Lua: encounters_extract.lua:152
function build_tables(entries: WildEntry[]): Record<string, WildEntry> {
  const tables: Record<string, WildEntry> = {};
  const [prefixes, enginePrefix] = map_prefixes();
  for (const e of entries) {
    const gn = format("%d:%d", e.mapGroup, e.mapNum);
    const packed: WildEntry = {
      mapGroup: e.mapGroup,
      mapNum: e.mapNum,
      land: e.land,
      water: e.water,
      rocks: e.rocks,
      fishing: e.fishing,
    };
    const first = tables[gn];
    if (first) {
      // pokefirered/src/wild_encounter.c:189
      first.variants = first.variants ?? [{
        land: first.land, water: first.water, rocks: first.rocks, fishing: first.fishing,
      }];
      first.variants.push(packed);
      continue;
    }
    tables[gn] = packed;
    const alias = Versions.mapIdFor(e.mapGroup, e.mapNum);
    if (alias) {
      add_aliases(tables, alias, packed, prefixes, enginePrefix);
    }
  }
  return tables;
}

// Lua: encounters_extract.lua:184
function source_label(): string {
  const F = Family.active();
  if (F.aliases) return "FireRed";
  return Profile.of(F.game).label;
}

// Lua: encounters_extract.lua:190
function encode_lua(tables: Record<string, WildEntry>, headerCount: number): string {
  const lines = [
    "-- Auto-extracted from ROM gWildMonHeaders (" + source_label() + ").\n",
    format("-- format_version=%d headers=%d\n", EncountersExtract.FORMAT_VERSION, headerCount),
    "return {\n",
  ];
  const keys = Object.keys(tables);
  keys.sort((a, b) => {
    // Prefer FR_/SEVII_ aliases after numeric keys for stable diffs.
    const an = /^(\d+):/.test(a), bn = /^(\d+):/.test(b);
    if (an && !bn) return -1;
    if (bn && !an) return 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  for (const k of keys) {
    serialize_entry(lines, k, tables[k]!);
  }
  lines.push("}\n");
  return lines.join("");
}

// Lua: encounters_extract.lua:241
function hasExtra(): boolean {
  return Versions.WILD_EXTRA_HEADERS !== undefined && Versions.WILD_EXTRA_HEADERS !== null;
}

// Lua: encounters_extract.lua:273
function encode_extra(extra: Tbl): string {
  const lines = [
    format("-- format_version=%d\n", EncountersExtract.FORMAT_VERSION),
    "return {\n",
    "  headerSets = {\n",
  ];
  const names = Object.keys(extra.headerSets).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const name of names) {
    lines.push(format("    %s = {\n", name));
    for (const e of extra.headerSets[name] as WildEntry[]) {
      lines.push("    {\n");
      lines.push(format("    mapGroup = %d,\n", e.mapGroup));
      lines.push(format("    mapNum = %d,\n", e.mapNum));
      serialize_areas(lines, e);
      lines.push("    },\n");
    }
    lines.push("    },\n");
  }
  lines.push("  },\n");
  const m = extra.feebas.mon;
  lines.push("  feebas = {\n");
  lines.push(format("    mon = { species = %d, minLevel = %d, maxLevel = %d },\n",
    m.species, m.minLevel, m.maxLevel));
  lines.push("    sections = {\n");
  for (const s of extra.feebas.sections) {
    lines.push(format("      { yMin = %d, yMax = %d, spotBase = %d },\n",
      s.yMin, s.yMax, s.spotBase));
  }
  lines.push("    },\n  },\n");
  lines.push("  alteringCaveHeldItems = {\n");
  for (const r of extra.alteringCaveHeldItems) {
    lines.push(format("    { species = %d, item = %d },\n", r.species, r.item));
  }
  lines.push("  },\n}\n");
  return lines.join("");
}

export const EncountersExtract = {
  FORMAT_VERSION: 2,
  EXTRA_REL: "wild_extra.lua",
  REQUIRED: ["encounters.lua", "wild_extra.lua"],

  /** Parse gWildMonHeaders from an open Rom handle. */
  // Lua: encounters_extract.lua:82
  parseRom(rom: Rom, version?: any): WildEntry[] {
    version = version ?? {};
    const headersOff = version.wild_mon_headers ?? Versions.WILD_MON_HEADERS;
    return EncountersExtract.parseHeaders(rom, headersOff, version, 512);
  },

  // Lua: encounters_extract.lua:88
  parseHeaders(rom: Rom, headersOff: number, version: any, limit: number): WildEntry[] {
    version = version ?? {};
    const hdrSize = version.wild_mon_header_size ?? Versions.WILD_MON_HEADER_SIZE;
    const landN = version.land_wild_count ?? Versions.LAND_WILD_COUNT;
    const waterN = version.water_wild_count ?? Versions.WATER_WILD_COUNT;
    const rockN = version.rock_wild_count ?? Versions.ROCK_WILD_COUNT;
    const fishN = version.fish_wild_count ?? Versions.FISH_WILD_COUNT;

    const out: WildEntry[] = [];
    let off = headersOff;
    let guard = 0;
    while (guard < limit) {
      guard = guard + 1;
      const mapGroup = rom.get(off);
      const mapNum = rom.get(off + 1);
      if (mapGroup === 0xFF && mapNum === 0xFF) {
        break;
      }
      const landPtr = rom.u32(off + 4);
      const waterPtr = rom.u32(off + 8);
      const rockPtr = rom.u32(off + 12);
      const fishPtr = rom.u32(off + 16);
      out.push({
        mapGroup,
        mapNum,
        land: read_info(rom, gba_off(landPtr), landN),
        water: read_info(rom, gba_off(waterPtr), waterN),
        rocks: read_info(rom, gba_off(rockPtr), rockN),
        fishing: read_info(rom, gba_off(fishPtr), fishN),
      });
      off = off + hdrSize;
    }
    return out;
  },

  /** Write data/generated/gba/encounters.lua from ROM. [detail] or [undefined, err] */
  // Lua: encounters_extract.lua:213
  writeExtract(rom: Rom, cache: Cache, root?: string, version?: any): [Tbl | undefined, string?] {
    root = root ?? "data/generated/gba";
    if (!rom || !cache) {
      return [undefined, "rom and cache required"];
    }
    const entries = EncountersExtract.parseRom(rom, version);
    const tables = build_tables(entries);
    const blob = encode_lua(tables, entries.length);
    cache.write(root + "/encounters.lua", blob);

    let aliased = 0;
    const [prefixes] = map_prefixes();
    for (const k of Object.keys(tables)) {
      if (is_alias(k, prefixes)) {
        aliased = aliased + 1;
      }
    }
    log(format("extracted %d headers → %s/encounters.lua (%d game3 aliases)",
      entries.length, root, aliased));
    return [{
      headers: entries.length,
      aliases: aliased,
      path: root + "/encounters.lua",
    }];
  },

  // Lua: encounters_extract.lua:245
  parseExtra(rom: Rom): Tbl {
    const out: Tbl = { headerSets: {} };
    const sets = Versions.WILD_EXTRA_HEADERS;
    const names = Object.keys(sets).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const name of names) {
      const set = sets[name];
      out.headerSets[name] = EncountersExtract.parseHeaders(rom, set.off, undefined, set.count);
    }
    // pokeemerald/src/wild_encounter.c:67
    const fo = Versions.FEEBAS_WILD_MON;
    out.feebas = {
      mon: { minLevel: rom.get(fo), maxLevel: rom.get(fo + 1), species: rom.u16(fo + 2) },
      sections: [] as Tbl[],
    };
    for (let i = 0; i <= Versions.FEEBAS_TILE_DATA_COUNT - 1; i++) {
      const o = Versions.FEEBAS_TILE_DATA + i * 6;
      out.feebas.sections[i] = { yMin: rom.u16(o), yMax: rom.u16(o + 2), spotBase: rom.u16(o + 4) };
    }
    // pokeemerald/src/pokemon.c:2114
    out.alteringCaveHeldItems = [];
    for (let i = 0; i <= Versions.ALTERING_CAVE_HELD_ITEM_COUNT - 1; i++) {
      const o = Versions.ALTERING_CAVE_HELD_ITEMS + i * 4;
      out.alteringCaveHeldItems[i] = { species: rom.u16(o), item: rom.u16(o + 2) };
    }
    return out;
  },

  // Lua: encounters_extract.lua:312
  writeExtra(rom: Rom, cache: Cache, root: string): Tbl {
    const extra = EncountersExtract.parseExtra(rom);
    cache.write(root + "/" + EncountersExtract.EXTRA_REL, encode_extra(extra));
    return extra;
  },

  // Lua: encounters_extract.lua:320
  ready(cache: Cache | undefined, cacheRoot?: string): boolean {
    if (!(cache && cache.exists)) return false;
    const root = cacheRoot ?? "data/generated/gba";
    if (!cache.exists(root + "/encounters.lua")) return false;
    return !hasExtra() || cache.exists(root + "/" + EncountersExtract.EXTRA_REL);
  },

  // Lua: encounters_extract.lua:327
  run(rom: Rom, cache: Cache, opts: { cacheRoot?: string; version?: any } = {}): Tbl {
    const root = opts.cacheRoot ?? "data/generated/gba";
    const [detail, err] = EncountersExtract.writeExtract(rom, cache, root, opts.version);
    if (!detail) throw new Error("encounters: " + tostring(err));
    if (hasExtra()) {
      const extra = EncountersExtract.writeExtra(rom, cache, root);
      let n = 0;
      for (const name of Object.keys(extra.headerSets)) n = n + extra.headerSets[name].length;
      detail.extraHeaders = n;
    }
    return detail;
  },
};

export default EncountersExtract;
