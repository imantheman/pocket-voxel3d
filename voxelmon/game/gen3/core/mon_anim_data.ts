// Port of gen1recomp src/core/game3/mon_anim_data.lua (GPLv3 + additional terms; see LICENSE.md).
// The front/back pic animation tables the importer extracts (mon_anim_extract):
// per-species anim command lists, front anim ids and delays, back anim sets.
// FireRed/LeafGreen have none (the extract only exists for Emerald), so on
// FRLG `get()` is nil and MonAnim stays disabled, as in Brian's.

import { GameVersion } from "../shared/core/GameVersion.ts";
import { Dataset } from "./dataset.ts";
import { luaLoad } from "../platform/luadata.ts";
import { ipairs, len, pairs, type LuaTable } from "../platform/lt.ts";
import { tonumber, tostring } from "../../../import/gen3/lua.ts";

/** What MonAnimData reads through: Dataset.cache() or a cache handed to useCache. */
export interface MonAnimCache { read(rel: string): string | null | undefined }

/** One frame/jump/loop/end command of a pic anim list (pret's AnimCmd). */
export interface MonAnimCmd { op?: string; target?: number; count?: number; frame?: number; duration?: number; hFlip?: boolean; vFlip?: boolean }

export interface MonAnimPack {
  front: LuaTable;
  back: LuaTable;
  fnIds: Record<string, number>;
}

// Lua: mon_anim_data.lua:11
let packs: Record<string, MonAnimPack | false> = {};

// Lua: mon_anim_data.lua:13
function versionKey(): string {
  return tostring(GameVersion.get()) + ":" + tostring(GameVersion.cachePrefix());
}

// Lua: mon_anim_data.lua:29
function read(rel: string): string | undefined {
  const cache = MonAnimData.cache();
  const ok = cache != null;
  if (!ok || !cache || !cache.read) return undefined;
  const src = cache.read(rel);
  if (typeof src !== "string" || src === "") return undefined;
  return src;
}

// Lua: mon_anim_data.lua:38
function loadLua(rel: string): LuaTable {
  const src = read(rel);
  if (!src) return undefined;
  const [chunk, err] = luaLoad(src, "@" + rel);
  if (!chunk) throw new Error("mon_anim_data: " + tostring(err));
  return chunk();
}

export const MonAnimData = {
  FRONT: "data/generated/gba/pokemon/front_anims.lua",
  BACK: "data/generated/gba/pokemon/back_anims.lua",
  SHEET: "data/generated/gba/pokemon/front_anim/%d.rgba",
  SHEET_SHINY: "data/generated/gba/pokemon/front_anim_shiny/%d.rgba",

  // pokeemerald/src/pokemon.c:1864
  PP_UP_GET_MASK_0: 0x03,

  _cache: undefined as MonAnimCache | undefined,

  // Lua: mon_anim_data.lua:18
  useCache(cache: MonAnimCache | undefined): void {
    MonAnimData._cache = cache;
    packs = {};
  },

  // Lua: mon_anim_data.lua:23
  cache(): MonAnimCache | undefined {
    if (MonAnimData._cache) return MonAnimData._cache;
    try {
      const cache = Dataset.cache();
      return cache ? cache : undefined;
    } catch {
      return undefined;
    }
  },

  // Lua: mon_anim_data.lua:46
  get(): MonAnimPack | undefined {
    const key = versionKey();
    let hit = packs[key];
    if (hit != null) return hit || undefined;
    const front = loadLua(MonAnimData.FRONT);
    const back = front && loadLua(MonAnimData.BACK);
    if (!(front && back)) {
      packs[key] = false;
      return undefined;
    }
    const byName: Record<string, number> = {};
    for (const [id, name] of pairs<string>(front.functions ?? {})) byName[name] = id as number;
    hit = { front, back, fnIds: byName };
    packs[key] = hit;
    return hit;
  },

  // Lua: mon_anim_data.lua:63
  reset(): void {
    packs = {};
  },

  // Lua: mon_anim_data.lua:67
  available(): boolean {
    return MonAnimData.get() != null;
  },

  // Lua: mon_anim_data.lua:71
  functionName(id: number): string | undefined {
    const d = MonAnimData.get();
    return (d && d.front.functions[id]) ?? undefined;
  },

  // Lua: mon_anim_data.lua:76
  functionCount(): number {
    const d = MonAnimData.get();
    if (!d) return 0;
    let n = 0;
    for (const _ of pairs(d.front.functions)) n = n + 1;
    return n;
  },

  // Lua: mon_anim_data.lua:84
  /** The species' anim lists keyed 0.. (anim number), each a sequence of commands. */
  anims(species: unknown): Record<number, (MonAnimCmd | null)[]> | undefined {
    const d = MonAnimData.get();
    if (!d) return undefined;
    const row = d.front.species[tonumber(species) ?? 0] ?? d.front.species[0];
    const out: Record<number, (MonAnimCmd | null)[]> = {};
    for (const [i, id] of ipairs<number>(row)) {
      const l = d.front.lists[id];
      const cmds = l ? l.cmds : undefined;
      if (cmds != null) out[i - 1] = cmds; // `out[i - 1] = l and l.cmds or nil`
    }
    return out;
  },

  // pokeemerald/src/pokemon.c:6852
  // Lua: mon_anim_data.lua:97
  frontAnimId(species: unknown): number | undefined {
    const d = MonAnimData.get();
    if (!d) return undefined;
    const ids = d.front.animIds;
    const i = tonumber(species) ?? 0;
    if (ids[i] != null) return ids[i];
    return d.front.animDelays[i - len(ids)] ?? undefined;
  },

  // pokeemerald/src/pokemon.c:6841
  // Lua: mon_anim_data.lua:107
  delay(species: unknown): number {
    const d = MonAnimData.get();
    if (!d) return 0;
    const t = d.front.animDelays;
    const i = tonumber(species) ?? 0;
    if (t[i] != null) return t[i];
    if (i === len(t) + 1) return MonAnimData.PP_UP_GET_MASK_0;
    return 0;
  },

  // pokeemerald/src/pokemon_animation.c:885
  // Lua: mon_anim_data.lua:118
  backAnimSet(species: unknown): number {
    const d = MonAnimData.get();
    if (!d) return 0;
    const v = d.back.sets[tonumber(species) ?? 0] ?? 0;
    if (v !== 0) return v - 1;
    return 0;
  },

  // pokeemerald/src/pokemon_animation.c:968
  // Lua: mon_anim_data.lua:127
  backAnimId(backAnimSet: number, nature: unknown): number | undefined {
    const d = MonAnimData.get();
    if (!d) return undefined;
    const mod = d.back.natureMods[tonumber(nature) ?? 0] ?? 0;
    return d.back.ids[3 * backAnimSet + mod] ?? undefined;
  },
};

export default MonAnimData;
