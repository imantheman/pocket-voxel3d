// Port of gen1recomp src/core/game3/pokemon.lua (GPLv3 + additional terms; see LICENSE.md).
// Runtime FRLG species names / menu icons / types (extracted pack).
//
// The pack's tables come from the importer's cache through luaLoad, in the
// lt.ts shape (species / move / national ids keep their Lua keys).

import { CachePaths } from "./cache_paths.ts";
import { PokemonExtract } from "../../../import/gen3/pokemon_extract.ts";
import { Versions } from "../../../import/gen3/versions.ts";
import { Runtime as ModRuntime } from "../shared/mods/Runtime.ts";
import { Gen3Compat } from "../shared/mods/Gen3Compat.ts";
import { Dataset } from "./dataset.ts";
import { CacheFs } from "../shared/import/CacheFs.ts";
import { HeldItems } from "./battle/held_items.ts";
import { Profile } from "./profile.ts";
import { FireredRules } from "./profiles/firered_rules.ts";
import { Rng } from "./rng.ts";
import { Dex } from "./dex.ts";
import { Runtime } from "./runtime.ts";
import { Moves } from "./battle/moves.ts";
import { ItemsData } from "./items_data.ts";
import { RomText } from "./rom_text.ts";
import { Fs } from "../platform/fs.ts";
import { luaLoad } from "../platform/luadata.ts";
import { G } from "../platform/graphics.ts";
import { newImageData, type Image, type ImageData, type Quad } from "../platform/image.ts";
import { gsub, match } from "../platform/lpattern.ts";
import { seq, len, ipairs, pairs, remove, concat, type LuaTable } from "../platform/lt.ts";
import { tostring, tonumber, truthy, mod, sub, byte, char } from "../../../import/gen3/lua.ts";

/** A cache handle as Brian's modules take it: `cache:read(rel)`. */
export interface PokemonCache {
  read(rel: string): string | null | undefined;
  [k: string]: any;
}

export interface MonIcon {
  image: Image; w: number; h: number; sheetH: number; frames: number; quads: Quad[];
}
export interface MonPic { image: Image; w: number; h: number }

export interface MonStats {
  maxHp: number; attack: number; defense: number; speed: number; spAtk: number; spDef: number;
}

const isTable = (v: unknown): v is Record<string, any> => v != null && typeof v === "object";

// s:upper() in Lua's C locale: ASCII only (byte strings keep their high bytes).
const upper = (s: string): string => s.replace(/[a-z]+/g, (m) => m.toUpperCase());

// UTF-8 bytes of the Lua source's literals.
const FEMALE = "\xE2\x99\x80"; // ♀
const MALE = "\xE2\x99\x82"; // ♂
const POKEMON_WORD = "POK\xC3\xA9MON"; // POKéMON

// Lua: pokemon.lua:35
const ROOT = (CachePaths.CACHE_ROOT ?? "data/generated/gba") + "/pokemon";

// Lua: pokemon.lua:37
function log(msg: unknown): void {
  if (Pokemon._logged) return;
  Pokemon._logged = true;
  console.log("[game3/pokemon] " + tostring(msg));
}

// Lua: pokemon.lua:43
function resolve_cache(cache: any): PokemonCache {
  if (truthy(cache) && truthy(cache.read)) return cache;
  // pcall(require, "src.core.game3.dataset"): the module is always there.
  if (Dataset && Dataset.cache) {
    const c = Dataset.cache();
    if (truthy(c)) return c;
  }
  return {
    read: (rel: string): string | undefined => {
      // pcall(require, "src.import.CacheFs"): the module is always there.
      if (CacheFs && CacheFs.readActive) {
        const data = CacheFs.readActive(rel);
        if (data != null) return data;
      }
      // NOT FAITHFUL: io.open(rel) / io.open("data/generated/gba/" .. rel)
      // become platform Fs reads (the 3DS has no io library).
      const data = Fs.read(rel) ?? Fs.read("data/generated/gba/" + rel);
      if (data != null) return data;
      return undefined;
    },
  };
}

// Lua: pokemon.lua:68
function copy_names(names: LuaTable): LuaTable {
  if (!isTable(names)) return null;
  const out: LuaTable = Array.isArray(names) ? [] : {};
  for (const [k, v] of pairs(names)) out[k] = v;
  return out;
}

// Lua: pokemon.lua:75
let pkLoadWarned = false;
// Lua: pokemon.lua:76
// luaLoad evaluates while loading, so a chunk that fails to evaluate returns
// nil at the load step (without the warning the Lua prints for a pcall
// failure). Log-only difference.
function load_lua(cache: any, rel: string): LuaTable {
  cache = resolve_cache(cache);
  const src = cache.read(rel);
  if (src == null) return null;
  const [chunk] = luaLoad(src, "@" + rel);
  if (!chunk) return null;
  let ok: boolean, t: any;
  try {
    t = chunk();
    ok = true;
  } catch (e) {
    ok = false;
    t = e instanceof Error ? e.message : e;
  }
  if (ok) return t;
  if (!pkLoadWarned) {
    pkLoadWarned = true;
    console.log("[game3/pokemon] load failed for " + tostring(rel) + ": " + tostring(t));
  }
  return null;
}

/**
 * Normalize host id / FRLG display name for reverse lookup.
 * "KYOGRE" / "NIDORAN_F" / "FARFETCH'D" / "HO-OH" / "MR. MIME"
 */
// Lua: pokemon.lua:93
function norm_key(s: unknown): string | null {
  if (s == null) return null;
  let k = upper(tostring(s));
  // NOT FAITHFUL (speed, same result): a name of only A-Z and 0-9 comes
  // through every substitution below unchanged (each needs a '_', '.', '-',
  // "'" or a gender glyph, or puts back the text it matched), so skip them.
  if (/^[A-Z0-9]*$/.test(k)) return k;
  // Common host aliases before stripping.
  k = gsub(gsub(k, "NIDORAN_F", "NIDORANF")[0], "NIDORAN_M", "NIDORANM")[0];
  k = gsub(gsub(k, "MR_MIME", "MRMIME")[0], "MIME_JR", "MIMEJR")[0];
  k = gsub(k, "FARFETCH[_']?D", "FARFETCHD")[0];
  k = gsub(k, "HO[_%-]?OH", "HOOH")[0];
  k = gsub(gsub(k, "NIDORAN" + FEMALE, "NIDORANF")[0], "NIDORAN" + MALE, "NIDORANM")[0];
  k = gsub(k, "FARFETCH'D", "FARFETCHD")[0];
  k = gsub(gsub(k, "MR%.%s*MIME", "MRMIME")[0], "MR%.", "MR")[0];
  k = gsub(k, "HO%-OH", "HOOH")[0];
  k = gsub(k, "[^A-Z0-9]", "")[0];
  return k;
}

// Lua: pokemon.lua:109
function build_name_index(names: LuaTable): Record<string, number> {
  const by: Record<string, number> = {};
  if (!isTable(names)) return by;
  for (const [id, name] of pairs(names)) {
    if (typeof id === "number" && typeof name === "string" && name !== "") {
      const k = norm_key(name);
      if (k != null && k !== "" && by[k] == null) {
        by[k] = id;
      }
      // Extra keys for gendered / punctuated FRLG glyphs.
      if (name.includes(FEMALE)) {
        by["NIDORANF"] = by["NIDORANF"] ?? id;
      }
      if (name.includes(MALE)) {
        by["NIDORANM"] = by["NIDORANM"] ?? id;
      }
    }
  }
  return by;
}

// Lua: pokemon.lua:130
function install(cache?: any): void {
  Pokemon._cache = resolve_cache(cache);
  Pokemon._spinda = null;
  Pokemon._spindaPics = null;
  Pokemon._names = null;
  Pokemon._types = null;
  Pokemon._national = null;
  Pokemon._manifest = null;
  Pokemon._byName = null;
  Pokemon._stats = null;
  Pokemon._abilities = null;
  Pokemon._abilityNames = null;
  Pokemon._speciesMeta = null;
  Pokemon._moveNames = null;
  Pokemon._romMoveNames = null;
  Pokemon._romAbilityNames = null;
  Pokemon._learnsets = null;
  Pokemon._eggMoves = null;
  Pokemon._evolutions = null;
  Pokemon._tmhm = null;
  Pokemon._dex = null;
  Pokemon._battleMoves = null;
  Pokemon._icons = {};
  Pokemon._front = {};
  Pokemon._logged = false;
  const root = (CachePaths.CACHE_ROOT ?? "data/generated/gba") + "/pokemon";
  const c = Pokemon._cache;
  Pokemon._manifest = load_lua(c, root + "/manifest.lua");
  Pokemon._names = load_lua(c, root + "/names.lua");
  Pokemon._types = load_lua(c, root + "/types.lua");
  Pokemon._national = load_lua(c, root + "/national.lua");
  Pokemon._stats = load_lua(c, root + "/stats.lua");
  Pokemon._abilities = load_lua(c, root + "/abilities.lua");
  Pokemon._abilityNames = load_lua(c, root + "/ability_names.lua");
  Pokemon._speciesMeta = load_lua(c, root + "/meta.lua");
  Pokemon._moveNames = load_lua(c, root + "/move_names.lua");
  Pokemon._romMoveNames = copy_names(Pokemon._moveNames);
  Pokemon._romAbilityNames = copy_names(Pokemon._abilityNames);
  Pokemon._learnsets = load_lua(c, root + "/learnsets.lua");
  Pokemon._eggMoves = load_lua(c, root + "/egg_moves.lua");
  Pokemon._evolutions = load_lua(c, root + "/evolutions.lua");
  Pokemon._tmhm = load_lua(c, root + "/tmhm.lua");
  Pokemon._dex = load_lua(c, root + "/dex.lua");
  const battlePack = load_lua(c, root + "/battle_moves.lua");
  Pokemon._battleMoves = truthy(battlePack) && truthy(battlePack.moves) ? battlePack.moves : null;
  Pokemon._byName = build_name_index(Pokemon._names);
  if (truthy(Pokemon._names)) {
    log("species pack ready (" + tostring(truthy(Pokemon._manifest) ? Pokemon._manifest.numSpecies : Pokemon._manifest) + ")");
  } else {
    log("species pack missing \xE2\x80\x94 re-import FireRed ROM");
  }
  Pokemon._runReloadHooks();
}

interface ReloadHook { fn: (p: typeof Pokemon) => unknown; key: unknown }

// Lua: pokemon.lua:186
function onReload(fn: unknown, key?: unknown): () => void {
  if (typeof fn !== "function") return () => {};
  const hooks = Pokemon._reloadHooks;
  for (let i = len(hooks); i >= 1; i--) {
    const h = hooks[i] as ReloadHook;
    if (h.fn === fn || (key != null && h.key === key)) {
      remove(hooks, i);
    }
  }
  const entry: ReloadHook = { fn: fn as ReloadHook["fn"], key };
  hooks[len(hooks) + 1] = entry;
  return () => {
    for (let i = len(hooks); i >= 1; i--) {
      if (hooks[i] === entry) remove(hooks, i);
    }
  };
}

// Lua: pokemon.lua:204
function _runReloadHooks(): void {
  const snapshot: LuaTable = seq();
  for (const [i, h] of ipairs(Pokemon._reloadHooks)) snapshot[i] = h;
  for (const [, h] of ipairs<ReloadHook>(snapshot)) {
    let ok = true, err: unknown;
    try {
      h.fn(Pokemon);
    } catch (e) {
      ok = false;
      err = e instanceof Error ? e.message : e;
    }
    if (!ok) log("onReload callback failed: " + tostring(err));
  }
}

// Lua: pokemon.lua:213
function invalidate(): void {
  Pokemon._icons = {};
  Pokemon._front = {};
  Pokemon._back = null;
  Pokemon._names = null;
  Pokemon._types = null;
  Pokemon._national = null;
  Pokemon._manifest = null;
  Pokemon._installTried = null;
  Pokemon._installWarned = null;
  Pokemon._byName = null;
  Pokemon._stats = null;
  Pokemon._abilities = null;
  Pokemon._abilityNames = null;
  Pokemon._speciesMeta = null;
  Pokemon._moveNames = null;
  Pokemon._romMoveNames = null;
  Pokemon._romAbilityNames = null;
  Pokemon._learnsets = null;
  Pokemon._eggMoves = null;
  Pokemon._evolutions = null;
  Pokemon._tmhm = null;
  Pokemon._dex = null;
  Pokemon._battleMoves = null;
  Pokemon._logged = false;
}

// Lua: pokemon.lua:240
function ready(): boolean {
  if (truthy(Pokemon._names)) return true;
  const cache = Pokemon._cache;
  return PokemonExtract.ready((cache ?? undefined) as any, CachePaths.CACHE_ROOT)
    || load_lua(cache, ROOT + "/names.lua") != null;
}

/** Internal FRLG SPECIES id -> display name. */
// Lua: pokemon.lua:248
function name(speciesIn: unknown): string {
  const species = tonumber(speciesIn);
  if (species == null || species < 1) return "?????";
  if (!truthy(Pokemon._names)) Pokemon.install(Pokemon._cache);
  const n = truthy(Pokemon._names) ? Pokemon._names[species] : Pokemon._names;
  if (truthy(n) && n !== "") return n;
  throw new Error("no ROM species name for species " + tostring(species));
}

// Lua: pokemon.lua:257
function keyName(speciesIn: unknown): string | null {
  const species = tonumber(speciesIn);
  if (species == null || species < 1) return null;
  if (!truthy(Pokemon._names)) Pokemon.install(Pokemon._cache);
  let n = truthy(Pokemon._names) ? Pokemon._names[species] : Pokemon._names;
  if (typeof n !== "string" || n === "" || n === "??????????") return null;
  n = upper(n);
  n = gsub(gsub(n, FEMALE, "_F")[0], MALE, "_M")[0];
  n = gsub(n, "[%.']", "")[0];
  n = gsub(n, "[%s%-]+", "_")[0];
  return n;
}

// Lua: pokemon.lua:270
function speciesFromName(nm: unknown): number | null {
  if (nm == null) return null;
  if (!truthy(Pokemon._byName)) Pokemon.install(Pokemon._cache);
  const k = norm_key(nm);
  if (k == null) return null;
  return truthy(Pokemon._byName) ? (Pokemon._byName![k] ?? null) : null;
}

/** National dex number -> internal SPECIES (when pack present). */
// Lua: pokemon.lua:279
function speciesFromNational(natIn: unknown): number | null {
  const nat = tonumber(natIn);
  if (nat == null || nat < 1) return null;
  if (!truthy(Pokemon._national)) Pokemon.install(Pokemon._cache);
  const t = Pokemon._national;
  if (truthy(t) && truthy(t.toSpecies) && truthy(t.toSpecies[nat])) {
    return t.toSpecies[nat];
  }
  if (nat <= 251) return nat;
  return null;
}

// Lua: pokemon.lua:291
function national(speciesIn: unknown): number | null {
  const species = tonumber(speciesIn);
  if (species == null || species < 1) return null;
  if (!truthy(Pokemon._national)) Pokemon.install(Pokemon._cache);
  const t = Pokemon._national;
  if (truthy(t) && truthy(t.toNational)) return t.toNational[species] ?? null;
  if (species <= 251) return species;
  return null;
}

// Lua: pokemon.lua:301
function types(speciesIn: unknown): LuaTable {
  const species = tonumber(speciesIn);
  if (species == null) return seq(0, 0);
  if (!truthy(Pokemon._types)) Pokemon.install(Pokemon._cache);
  const t = truthy(Pokemon._types) ? Pokemon._types[species] : null;
  if (truthy(t)) return seq(t[1] ?? 0, t[2] ?? 0);
  return seq(0, 0);
}

/** Base stats table { hp, atk, def, spe, spa, spd } or nil. */
// Lua: pokemon.lua:311
function stats(speciesIn: unknown): LuaTable {
  const species = tonumber(speciesIn);
  if (species == null) return null;
  if (!truthy(Pokemon._stats)) Pokemon.install(Pokemon._cache);
  return truthy(Pokemon._stats) ? (Pokemon._stats[species] ?? null) : null;
}

/** Ability ids { ability1, ability2 }. */
// Lua: pokemon.lua:319
function abilities(speciesIn: unknown): LuaTable {
  const species = tonumber(speciesIn);
  if (species == null) return seq(0, 0);
  if (!truthy(Pokemon._abilities)) Pokemon.install(Pokemon._cache);
  const a = truthy(Pokemon._abilities) ? Pokemon._abilities[species] : null;
  if (truthy(a)) return seq(a[1] ?? 0, a[2] ?? 0);
  return seq(0, 0);
}

// Lua: pokemon.lua:328
function abilityName(abilityIdIn: unknown): string {
  const abilityId = tonumber(abilityIdIn);
  if (abilityId == null || abilityId < 1) return "-------";
  if (!truthy(Pokemon._abilityNames)) Pokemon.install(Pokemon._cache);
  const n = truthy(Pokemon._abilityNames) ? Pokemon._abilityNames[abilityId] : null;
  if (truthy(n) && n !== "") return n;
  throw new Error("no ROM ability name for ability " + tostring(abilityId));
}

// Lua: pokemon.lua:337
function speciesMeta(speciesIn: unknown): LuaTable {
  const species = tonumber(speciesIn);
  if (species == null) return null;
  if (!truthy(Pokemon._speciesMeta)) Pokemon.install(Pokemon._cache);
  return truthy(Pokemon._speciesMeta) ? (Pokemon._speciesMeta[species] ?? null) : null;
}

/** ROM BaseStats.expYield (species meta from extract). */
// Lua: pokemon.lua:345
function expYield(species: unknown): number {
  const meta = Pokemon.speciesMeta(species);
  return (truthy(meta) ? tonumber(meta.expYield) : undefined) ?? 0;
}

/** ROM BaseStats.growthRate -- pret GROWTH_* index into gExperienceTables. */
// Lua: pokemon.lua:351
function growthRate(species: unknown): number {
  const meta = Pokemon.speciesMeta(species);
  return mod((truthy(meta) ? tonumber(meta.growthRate) : undefined) ?? 0, 6);
}

// Nature -> { atk, def, spe, spa, spd } deltas (+1 / -1 / 0).
// Lua: pokemon.lua:362
const NATURE_DELTAS: Record<number, LuaTable> = {
  0: seq(0, 0, 0, 0, 0), // Hardy
  1: seq(1, -1, 0, 0, 0), // Lonely
  2: seq(1, 0, -1, 0, 0), // Brave
  3: seq(1, 0, 0, -1, 0), // Adamant
  4: seq(1, 0, 0, 0, -1), // Naughty
  5: seq(-1, 1, 0, 0, 0), // Bold
  6: seq(0, 0, 0, 0, 0), // Docile
  7: seq(0, 1, -1, 0, 0), // Relaxed
  8: seq(0, 1, 0, -1, 0), // Impish
  9: seq(0, 1, 0, 0, -1), // Lax
  10: seq(-1, 0, 1, 0, 0), // Timid
  11: seq(0, -1, 1, 0, 0), // Hasty
  12: seq(0, 0, 0, 0, 0), // Serious
  13: seq(0, 0, 1, -1, 0), // Jolly
  14: seq(0, 0, 1, 0, -1), // Naive
  15: seq(-1, 0, 0, 1, 0), // Modest
  16: seq(0, -1, 0, 1, 0), // Mild
  17: seq(0, 0, -1, 1, 0), // Quiet
  18: seq(0, 0, 0, 0, 0), // Bashful
  19: seq(0, 0, 0, 1, -1), // Rash
  20: seq(-1, 0, 0, 0, 1), // Calm
  21: seq(0, -1, 0, 0, 1), // Gentle
  22: seq(0, 0, -1, 0, 1), // Sassy
  23: seq(0, 0, 0, -1, 1), // Careful
  24: seq(0, 0, 0, 0, 0), // Quirky
};

// Lua: pokemon.lua:390
function natureId(personality: unknown): number {
  return mod(tonumber(personality) ?? 0, 25);
}

// Lua: pokemon.lua:394
function gender(speciesIn: unknown, personalityIn?: unknown): string {
  const species = tonumber(speciesIn);
  const personality = tonumber(personalityIn) ?? 0;
  const meta = Pokemon.speciesMeta(species);
  const ratio = truthy(meta) ? meta.genderRatio : meta;
  if (ratio == null) return "U";
  if (ratio === Pokemon.GENDER_MALE) return "M";
  if (ratio === Pokemon.GENDER_FEMALE) return "F";
  if (ratio === Pokemon.GENDER_GENDERLESS) return "U";
  if (ratio > mod(personality, 256)) return "F";
  return "M";
}

/** Ability id for species + personality (ability1 vs ability2). */
// Lua: pokemon.lua:408
function abilityId(speciesIn: unknown, personalityIn?: unknown): number {
  const species = tonumber(speciesIn);
  const personality = tonumber(personalityIn) ?? 0;
  const pair = Pokemon.abilities(species);
  const a1 = pair[1] ?? 0, a2 = pair[2] ?? 0;
  if (a2 !== 0 && mod(personality, 2) === 1) {
    return a2;
  }
  return a1;
}

// Lua: pokemon.lua:419
function nature_mul(nature: number, statIndex: number): number {
  // statIndex: 1=atk 2=def 3=spe 4=spa 5=spd
  const d = NATURE_DELTAS[mod(nature, 25)];
  if (!truthy(d)) return 1;
  const delta = d[statIndex] ?? 0;
  if (delta > 0) return 1.1;
  if (delta < 0) return 0.9;
  return 1;
}

/** Gen3 CalculateMonStats -> { maxHp, attack, defense, speed, spAtk, spDef }. */
// Lua: pokemon.lua:430
function calcStats(speciesIn: unknown, levelIn: unknown, ivsIn?: any, evsIn?: any, personality?: unknown): MonStats {
  const species = tonumber(speciesIn);
  const level = tonumber(levelIn) ?? 1;
  const ivs = truthy(ivsIn) ? ivsIn : {};
  const evs = truthy(evsIn) ? evsIn : {};
  const base = Pokemon.stats(species);
  if (!truthy(base)) {
    return {
      maxHp: 15 + level * 2,
      attack: 10, defense: 10, speed: 10, spAtk: 10, spDef: 10,
    };
  }
  const nature = Pokemon.natureId(personality);
  const iv = (k: string): number => tonumber(ivs[k]) ?? 0;
  const ev = (k: string): number => tonumber(evs[k]) ?? 0;

  let maxHp: number;
  if (species === 303) { // pokefirered/src/pokemon.c:2124 SPECIES_SHEDINJA
    maxHp = 1;
  } else {
    maxHp = Math.floor(((2 * base.hp + iv("hp") + Math.floor(ev("hp") / 4)) * level) / 100)
      + level + 10;
  }

  const other = (baseStat: number, ivKey: string, evKey: string, natureIdx: number): number => {
    const n = Math.floor(((2 * baseStat + iv(ivKey) + Math.floor(ev(evKey) / 4)) * level) / 100) + 5;
    return Math.floor(n * nature_mul(nature, natureIdx));
  };

  return {
    maxHp,
    attack: other(base.atk, "atk", "atk", 1),
    defense: other(base.def, "def", "def", 2),
    speed: other(base.spe, "spe", "spe", 3),
    spAtk: other(base.spa, "spa", "spa", 4),
    spDef: other(base.spd, "spd", "spd", 5),
  };
}

/** Fill battle/display stats on an opaque mon (mutates and returns mon). */
// Lua: pokemon.lua:470
function applyStats(mon: any): any {
  if (!isTable(mon)) return mon;
  const species = tonumber(mon.species ?? mon.speciesId) ?? 1;
  const level = tonumber(mon.level) ?? 5;
  const ivs = mon.ivs ?? {};
  const evs = mon.evs ?? {};
  const personality = mon.personality ?? 0;
  const st = Pokemon.calcStats(species, level, ivs, evs, personality);
  mon.maxHp = st.maxHp;
  if (mon.hp == null || mon.hp < 0 || mon.hp > st.maxHp) {
    mon.hp = st.maxHp;
  }
  mon.attack = st.attack;
  mon.defense = st.defense;
  mon.speed = st.speed;
  mon.spAtk = st.spAtk;
  mon.spDef = st.spDef;
  // Aliases used by some battle paths.
  mon.atk = st.attack;
  mon.def = st.defense;
  mon.spe = st.speed;
  mon.spa = st.spAtk;
  mon.spd = st.spDef;
  return mon;
}

// Lua: pokemon.lua:515
const ITEM_LUXURY_BALL = 11; // pokefirered/include/constants/items.h:15
const HOLD_EFFECT_MACHO_BRACE = 24; // pokefirered/include/constants/hold_effects.h:28
const HOLD_EFFECT_FRIENDSHIP_UP = 27; // pokefirered/include/constants/hold_effects.h:31

// pokefirered/src/pokemon.c:1618 sFriendshipEventDeltas
// Lua: pokemon.lua:520
const FRIENDSHIP_DELTAS: Record<number, LuaTable> = {
  0: seq(5, 3, 2),
  1: seq(5, 3, 2),
  2: seq(1, 1, 0),
  3: seq(3, 2, 1),
  4: seq(1, 1, 0),
  5: seq(1, 1, 1),
  6: seq(3, 3, 3),
  7: seq(-1, -1, -1),
  8: seq(-5, -5, -10),
  9: seq(-5, -5, -10),
};

// pokefirered/include/constants/pokemon.h:166
// Lua: pokemon.lua:534
const EV_KEYS: LuaTable = seq("hp", "atk", "def", "spe", "spa", "spd");
const EV_YIELD_KEYS: LuaTable = seq("evHp", "evAtk", "evDef", "evSpe", "evSpa", "evSpd");

// pokefirered/include/pokemon.h:229
// Lua: pokemon.lua:539
function baseFriendship(species: unknown): number {
  const meta = Pokemon.speciesMeta(species);
  const v = truthy(meta) ? tonumber(meta.friendship) : undefined;
  if (v != null) return v;
  return 70;
}

// pokefirered/include/pokemon.h:219
// Lua: pokemon.lua:547
function evYield(species: unknown): Record<string, number> {
  if (isTable(species)) {
    species = tonumber(species.species ?? species.speciesId);
  }
  const meta = Pokemon.speciesMeta(species);
  const out: Record<string, number> = {};
  for (let i = 1; i <= 6; i++) {
    out[EV_KEYS[i]] = (truthy(meta) ? tonumber(meta[EV_YIELD_KEYS[i]]) : undefined) ?? 0;
  }
  return out;
}

// pokefirered/src/pokemon.c:1815
// Lua: pokemon.lua:560
function friendshipOf(mon: any): number {
  if (!isTable(mon)) return 0;
  const v = tonumber(mon.friendship ?? mon.happiness);
  if (v != null) return v;
  return Pokemon.baseFriendship(tonumber(mon.species ?? mon.speciesId));
}

// Lua: pokemon.lua:567
function setFriendship(mon: any, valueIn: unknown): number {
  if (!isTable(mon)) return 0;
  let value = Math.floor(tonumber(valueIn) ?? 0);
  if (value < 0) value = 0;
  if (value > Pokemon.MAX_FRIENDSHIP) value = Pokemon.MAX_FRIENDSHIP;
  mon.friendship = value;
  mon.happiness = value;
  return value;
}

// Lua: pokemon.lua:577
function evsOf(mon: any): Record<string, any> {
  if (!isTable(mon)) return {};
  let evs = mon.evs;
  if (!isTable(evs)) {
    evs = {};
    mon.evs = evs;
  }
  for (let i = 1; i <= 6; i++) {
    const k = EV_KEYS[i];
    evs[k] = Math.max(0, Math.min(Pokemon.MAX_PER_STAT_EVS, Math.floor(tonumber(evs[k]) ?? 0)));
  }
  return evs;
}

// pokefirered/src/pokemon.c:5597 GetMonEVCount
// Lua: pokemon.lua:592
function evCount(mon: any): number {
  const evs = Pokemon.evsOf(mon);
  let count = 0;
  for (let i = 1; i <= 6; i++) {
    count = count + (tonumber(evs[EV_KEYS[i]]) ?? 0);
  }
  return count;
}

// Lua: pokemon.lua:601
function hold_effect_of(mon: any): number {
  // pcall(require, "src.core.game3.battle.held_items"): always there.
  if (!HeldItems || !HeldItems.effectOf) return 0;
  const effect = HeldItems.effectOf(truthy(mon) ? (mon.item ?? mon.heldItem) : mon);
  return tonumber(effect) ?? 0;
}

// pokefirered/src/pokemon.c:5630 CheckPartyPokerus
// Lua: pokemon.lua:609
function hasPokerus(mon: any): boolean {
  return mod(tonumber(truthy(mon) ? mon.pokerus : mon) ?? 0, 16) !== 0;
}

// pokefirered/src/pokemon.c:5646 CheckPartyHasHadPokerus
// Lua: pokemon.lua:614
function hasHadPokerus(mon: any): boolean {
  return (tonumber(truthy(mon) ? mon.pokerus : mon) ?? 0) !== 0;
}

// Lua: pokemon.lua:618
function checkPartyPokerus(party: LuaTable, selection?: number): number {
  if (!isTable(party)) return 0;
  if (selection == null || selection === 0) {
    return Pokemon.hasPokerus(party[1]) ? 1 : 0;
  }
  let retVal = 0, curBit = 1, index = 1;
  while (selection !== 0) {
    if (mod(selection, 2) === 1 && Pokemon.hasPokerus(party[index])) {
      retVal = retVal + curBit;
    }
    index = index + 1;
    curBit = curBit * 2;
    selection = Math.floor(selection / 2);
  }
  return retVal;
}

// Lua: pokemon.lua:635
function checkPartyHasHadPokerus(party: LuaTable, selection?: number): number {
  if (!isTable(party)) return 0;
  if (selection == null || selection === 0) {
    return Pokemon.hasHadPokerus(party[1]) ? 1 : 0;
  }
  let retVal = 0, curBit = 1, index = 1;
  while (selection !== 0) {
    if (mod(selection, 2) === 1 && Pokemon.hasHadPokerus(party[index])) {
      retVal = retVal + curBit;
    }
    index = index + 1;
    curBit = curBit * 2;
    selection = Math.floor(selection / 2);
  }
  return retVal;
}

// require(<profile row>.saveRules): the rules modules by their Lua names
// (read at call time: the rules module sits in an import cycle with this one).
const SAVE_RULES: Record<string, () => Record<string, any>> = {
  "src.core.game3.profiles.firered_rules": () => FireredRules,
};

// Lua: pokemon.lua:652
function pokerus_live(session: any): boolean {
  const path = Profile.forSession(session).saveRules as string;
  const rules = SAVE_RULES[path]?.();
  if (rules == null) throw new Error("module '" + tostring(path) + "' not found");
  return rules.POKERUS === true;
}

// Lua: pokemon.lua:657
function has_species(mon: any): boolean {
  return isTable(mon) && (tonumber(mon.species ?? mon.speciesId) ?? 0) !== 0;
}

// pokeemerald/src/pokemon.c:6078
// Lua: pokemon.lua:662
function randomlyGivePartyPokerus(party: LuaTable, session?: any): void {
  if (!isTable(party) || !pokerus_live(session)) return;
  const rnd = Rng.Random();
  if (rnd !== 0x4000 && rnd !== 0x8000 && rnd !== 0xC000) return;
  let any = false;
  for (let i = 1; i <= 6; i++) {
    if (has_species(party[i]) && !Pokemon.isEgg(party[i])) any = true;
  }
  if (!any) return;
  let idx: number;
  do {
    idx = mod(Rng.Random(), 6);
  } while (!(has_species(party[idx + 1]) && !Pokemon.isEgg(party[idx + 1])));
  if (Pokemon.checkPartyHasHadPokerus(party, 1 << idx) !== 0) return;
  let r: number;
  do {
    r = mod(Rng.Random(), 256);
  } while (!((r & 7) !== 0));
  if ((r & 0xF0) !== 0) r = r & 7;
  r = (r | (r << 4)) & 0xFF;
  r = r & 0xF3;
  party[idx + 1].pokerus = mod(r + 1, 256);
}

// pokeemerald/src/pokemon.c:6170
// Lua: pokemon.lua:689
function updatePartyPokerusTime(daysIn: unknown, session?: any): void {
  if (!pokerus_live(session)) return;
  const days = tonumber(daysIn) ?? 0;
  const party = isTable(session) && truthy(session.party) ? session.party : {};
  for (let i = 1; i <= 6; i++) {
    const mon = party[i];
    if (has_species(mon)) {
      let p = tonumber(mon.pokerus) ?? 0;
      if ((p & 0xF) !== 0) {
        if ((p & 0xF) < days || days > 4) {
          p = p & 0xF0;
        } else {
          p = p - days;
        }
        if (p === 0) p = 0x10;
        mon.pokerus = p;
      }
    }
  }
}

// pokeemerald/src/pokemon.c:6194
// Lua: pokemon.lua:712
function partySpreadPokerus(party: LuaTable, session?: any): void {
  if (!isTable(party) || !pokerus_live(session)) return;
  if (mod(Rng.Random(), 3) !== 0) return;
  let i = 0;
  while (i < 6) {
    const mon = party[i + 1];
    if (has_species(mon)) {
      const cur = tonumber(mon.pokerus) ?? 0;
      if (cur !== 0 && (cur & 0xF) !== 0) {
        const prev = party[i];
        if (i !== 0 && isTable(prev) && ((tonumber(prev.pokerus) ?? 0) & 0xF0) === 0) {
          prev.pokerus = cur;
        }
        const nxt = party[i + 2];
        if (i !== 5 && isTable(nxt) && ((tonumber(nxt.pokerus) ?? 0) & 0xF0) === 0) {
          nxt.pokerus = cur;
          i = i + 1;
        }
      }
    }
    i = i + 1;
  }
}

// Lua: pokemon.lua:738
function regional(species: unknown, version?: string): number | undefined {
  return Dex.regionalNumber(species, version);
}

// Lua: pokemon.lua:742
function regionalCount(version?: string): number {
  return Dex.regionalMax(version);
}

// pokefirered/src/pokemon.c:5512 MonGainEVs
// Lua: pokemon.lua:747
function gainEVs(mon: any, defeatedSpecies: unknown): number | null {
  if (!isTable(mon)) return null;
  const evs = Pokemon.evsOf(mon);
  const cur: LuaTable = seq();
  let total = 0;
  for (let i = 1; i <= 6; i++) {
    cur[i] = tonumber(evs[EV_KEYS[i]]) ?? 0;
    total = total + cur[i];
  }
  const yld = Pokemon.evYield(defeatedSpecies);
  const multiplier = Pokemon.hasHadPokerus(mon) ? 2 : 1;
  const macho = hold_effect_of(mon) === HOLD_EFFECT_MACHO_BRACE;
  let gained = 0;
  for (let i = 1; i <= 6; i++) {
    if (total >= Pokemon.MAX_TOTAL_EVS) break;
    let inc = (tonumber(yld[EV_KEYS[i]]) ?? 0) * multiplier;
    if (macho) inc = inc * 2;
    if (total + inc > Pokemon.MAX_TOTAL_EVS) {
      inc = Pokemon.MAX_TOTAL_EVS - total;
    }
    if (cur[i] + inc > Pokemon.MAX_PER_STAT_EVS) {
      inc = Pokemon.MAX_PER_STAT_EVS - cur[i];
    }
    cur[i] = cur[i] + inc;
    total = total + inc;
    gained = gained + inc;
    evs[EV_KEYS[i]] = cur[i];
  }
  return gained;
}

// pokefirered/src/overworld.c:1265 GetCurrentRegionMapSectionId
// Lua: pokemon.lua:778
// NOT FAITHFUL (lookup only): package.loaded["src.core.game3.runtime"] is a
// static import, so the runtime module counts as loaded.
function currentMapSec(session?: any): number | null {
  session = session ?? {};
  const sec = tonumber(session.regionMapSectionId ?? session.mapSec);
  if (sec != null) return sec;
  const game = truthy(Runtime) ? Runtime._game : undefined;
  const def = truthy(session.map) && truthy(game) && truthy(game.data) && truthy(game.data.maps)
    ? game.data.maps[session.map] : undefined;
  return truthy(def) ? (tonumber(def.regionMapSectionId) ?? null) : null;
}

// Lua: pokemon.lua:788
function player_identity(player: any): [number | undefined, any] {
  player = player ?? {};
  let id = player.trainerId ?? player.id ?? player.playerId;
  let nm = player.name ?? player.playerName ?? player.otName;
  if (id == null || nm == null) {
    // package.loaded["src.core.game3.runtime"]: a static import here.
    let ok: boolean, sess: any;
    try {
      sess = truthy(Runtime) && truthy(Runtime.getSession) ? Runtime.getSession() : undefined;
      ok = true;
    } catch {
      ok = false;
    }
    if (ok && truthy(sess)) {
      id = id ?? sess.trainerId ?? sess.id ?? sess.playerId;
      nm = nm ?? sess.name ?? sess.playerName;
    }
  }
  return [tonumber(id), nm];
}

// pokefirered/src/pokemon.c:5974 IsOtherTrainer
// Lua: pokemon.lua:806
function isOtherTrainer(otId: unknown, otName: unknown, player?: any): boolean {
  const [playerId, playerName] = player_identity(player);
  if (playerId == null) return false;
  if (tonumber(otId) !== playerId) return true;
  const mine = tostring(playerName ?? "");
  const theirs = tostring(otName ?? "");
  for (let i = 1; i <= theirs.length; i++) {
    if (sub(theirs, i, i) !== sub(mine, i, i)) return true;
  }
  return false;
}

// pokefirered/src/pokemon.c:5965 IsTradedMon
// Lua: pokemon.lua:819
function isTradedMon(mon: any, player?: any): boolean {
  if (!isTable(mon) || mon.otId == null) return false;
  return Pokemon.isOtherTrainer(mon.otId, mon.otName ?? mon.ot, player);
}

// Lua: pokemon.lua:824
function friendship_bonuses(mon: any, friendship: number, ctx: any): number {
  if ((tonumber(mon.pokeball ?? mon.ball) ?? 0) === ITEM_LUXURY_BALL) {
    friendship = friendship + 1;
  }
  const sec = truthy(ctx) ? tonumber(ctx.mapSec) : undefined;
  const met = tonumber(mon.metLocation);
  if (sec != null && met != null && met === sec) {
    friendship = friendship + 1;
  }
  return friendship;
}

// pokefirered/src/pokemon.c:5480
// Lua: pokemon.lua:840
function isLeagueTrainerClass(trainerClass: unknown): boolean {
  const cls = tonumber(trainerClass);
  return (cls != null) && Pokemon.LEAGUE_TRAINER_CLASSES[cls] === true;
}

// pokefirered/src/pokemon.c:5440 AdjustFriendship
// Lua: pokemon.lua:846
function adjustFriendship(mon: any, event: unknown, ctx?: any): boolean {
  if (!isTable(mon)) return false;
  ctx = ctx ?? {};
  const species = tonumber(mon.species ?? mon.speciesId) ?? 0;
  if (species === 0 || species === Pokemon.SPECIES_EGG || truthy(mon.isEgg) || truthy(mon.egg)) {
    return false;
  }
  const ev = tonumber(event);
  const deltas = ev != null ? FRIENDSHIP_DELTAS[ev] : undefined;
  if (!truthy(deltas)) return false;

  let friendship = Pokemon.friendshipOf(mon);
  let tier = 1;
  if (friendship >= 100) tier = tier + 1;
  if (friendship >= 200) tier = tier + 1;

  if (event === Pokemon.FRIENDSHIP_EVENT_WALKING) {
    // pcall(require, "src.core.game3.rng"): always there.
    if (Rng && Rng.Random && mod(Rng.Random(), 2) === 1) return false;
  }
  if (event === Pokemon.FRIENDSHIP_EVENT_LEAGUE_BATTLE && !truthy(ctx.leagueBattle)) {
    return false;
  }

  let delta: number = deltas[tier];
  if (delta > 0 && hold_effect_of(mon) === HOLD_EFFECT_FRIENDSHIP_UP) {
    delta = Math.floor(150 * delta / 100);
  }
  friendship = friendship + delta;
  if (delta > 0) {
    friendship = friendship_bonuses(mon, friendship, ctx);
  }
  Pokemon.setFriendship(mon, friendship);
  return true;
}

// pokefirered/src/battle_util2.c:78 AdjustFriendshipOnBattleFaint
// Lua: pokemon.lua:882
function adjustFriendshipOnBattleFaint(mon: any, faintedLevelIn: unknown, opposingLevelIn: unknown, ctx?: any): boolean {
  const faintedLevel = tonumber(faintedLevelIn) ?? 1;
  const opposingLevel = tonumber(opposingLevelIn) ?? 1;
  let event = Pokemon.FRIENDSHIP_EVENT_FAINT_SMALL;
  if (opposingLevel > faintedLevel && opposingLevel - faintedLevel > 29) {
    event = Pokemon.FRIENDSHIP_EVENT_FAINT_LARGE;
  }
  return Pokemon.adjustFriendship(mon, event, ctx);
}

// pokefirered/src/pokemon.c:3976 UPDATE_FRIENDSHIP_FROM_ITEM
// Lua: pokemon.lua:893
function itemFriendship(mon: any, lowMidHigh: LuaTable, ctx?: any): boolean {
  if (!isTable(mon) || !isTable(lowMidHigh)) return false;
  let friendship = Pokemon.friendshipOf(mon);
  let change: number | undefined;
  if (friendship < 100) {
    change = tonumber(lowMidHigh[1]);
  } else if (friendship < 200) {
    change = tonumber(lowMidHigh[2]);
  } else {
    change = tonumber(lowMidHigh[3]);
  }
  if (change == null || change === 0) return false;
  if (change > 0 && hold_effect_of(mon) === HOLD_EFFECT_FRIENDSHIP_UP) {
    friendship = friendship + Math.floor(150 * change / 100);
  } else {
    friendship = friendship + change;
  }
  if (change > 0) {
    friendship = friendship_bonuses(mon, friendship, ctx);
  }
  Pokemon.setFriendship(mon, friendship);
  return true;
}

// pokefirered/src/pokemon.c:4229
// Lua: pokemon.lua:923
function raiseEvFromItem(mon: any, statKey: string, amountIn: unknown): number | null {
  const evs = Pokemon.evsOf(mon);
  if (evs[statKey] == null) return null;
  const evCnt = Pokemon.evCount(mon);
  if (evCnt >= Pokemon.MAX_TOTAL_EVS) return null;
  const data = tonumber(evs[statKey]) ?? 0;
  if (data >= Pokemon.EV_ITEM_RAISE_LIMIT) return null;
  const amount = Math.floor(tonumber(amountIn) ?? 0);
  let delta = amount;
  if (data + amount > Pokemon.EV_ITEM_RAISE_LIMIT) {
    delta = Pokemon.EV_ITEM_RAISE_LIMIT - data;
  }
  if (evCnt + delta > Pokemon.MAX_TOTAL_EVS) {
    delta = Pokemon.MAX_TOTAL_EVS - evCnt;
  }
  evs[statKey] = data + delta;
  // pokefirered/src/pokemon.c:2155
  const oldMaxHp = tonumber(mon.maxHp) ?? 0;
  const oldHp = tonumber(mon.hp) ?? 0;
  Pokemon.applyStats(mon);
  const newMaxHp = tonumber(mon.maxHp) ?? oldMaxHp;
  if (oldHp !== 0 || oldMaxHp !== 0) {
    mon.hp = Math.max(0, Math.min(newMaxHp, oldHp + (newMaxHp - oldMaxHp)));
  }
  return delta;
}

// The ROM's English name for a move or ability number, whatever a mod renamed
// it to; nil when the pack has none.
// Lua: pokemon.lua:952
function romMoveName(numIn: unknown): string | null {
  const num = tonumber(numIn);
  if (num == null) return null;
  if (!truthy(Pokemon._moveNames)) Pokemon.install(Pokemon._cache);
  return truthy(Pokemon._romMoveNames) ? (Pokemon._romMoveNames[num] ?? null) : null;
}

// Lua: pokemon.lua:959
function romAbilityName(abilityIdIn: unknown): string | null {
  const abilityId = tonumber(abilityIdIn);
  if (abilityId == null) return null;
  if (!truthy(Pokemon._abilityNames)) Pokemon.install(Pokemon._cache);
  return truthy(Pokemon._romAbilityNames) ? (Pokemon._romAbilityNames[abilityId] ?? null) : null;
}

// require("src.core.game3.battle.builtin_moves") under pcall -> [ok, module].
// NOT FAITHFUL: builtin_moves.lua (gen1recomp's 355-move fallback table) has no
// TS module (the stub generator skipped this pcall'd require), so the require
// counts as failed and the fallback is never used.
function require_builtin_moves(): [boolean, Record<number, any> | undefined] {
  return [false, undefined];
}

// Lua: pokemon.lua:966
// NOT FAITHFUL (lookup only): package.loaded["src.core.game3.battle.moves"]
// is a static import, so the moves module counts as loaded.
function moveName(moveId: any): string {
  if (isTable(moveId)) {
    moveId = moveId.id ?? moveId.move ?? moveId.moveId ?? moveId.num ?? moveId.name ?? moveId[1];
  }
  let num = tonumber(moveId);
  if (num == null && typeof moveId === "string") {
    if (truthy(Moves) && truthy(Moves.numForName)) {
      num = Moves.numForName(moveId) ?? undefined;
    }
    if (num == null) {
      if (moveId !== "" && moveId !== "-------") {
        return upper(gsub(tostring(moveId), "_", " ")[0]);
      }
    }
  }
  if (num == null || num < 1) return "-------";
  if (!truthy(Pokemon._moveNames)) Pokemon.install(Pokemon._cache);
  const n = truthy(Pokemon._moveNames) ? Pokemon._moveNames[num] : null;
  if (truthy(n) && n !== "") return n;
  const [okB, BuiltinMoves] = require_builtin_moves();
  if (okB && BuiltinMoves && BuiltinMoves[num] && BuiltinMoves[num].name) {
    return BuiltinMoves[num].name;
  }
  return "MOVE " + tostring(num);
}

// Lua: pokemon.lua:993
function learnset(species: any): LuaTable {
  if (isTable(species)) species = Pokemon.speciesOf(species);
  if (typeof species === "string") species = Pokemon.speciesFromName(species) ?? tonumber(species);
  species = tonumber(species);
  if (species == null) return seq();
  if (!truthy(Pokemon._learnsets)) Pokemon.install(Pokemon._cache);
  return (truthy(Pokemon._learnsets) ? Pokemon._learnsets[species] : null) ?? seq();
}

/**
 * Egg move ids for a species (FRLG gEggMoves), or nil when it has none.
 * Mirrors Pokemon.learnset's species coercion so mods can pass either form.
 */
// Lua: pokemon.lua:1004
function eggMoves(species: any): LuaTable {
  if (isTable(species)) species = Pokemon.speciesOf(species);
  if (typeof species === "string") species = Pokemon.speciesFromName(species) ?? tonumber(species);
  species = tonumber(species);
  if (species == null) return null;
  if (!truthy(Pokemon._eggMoves)) Pokemon.install(Pokemon._cache);
  const list = truthy(Pokemon._eggMoves) ? Pokemon._eggMoves[species] : null;
  if (!isTable(list) || len(list) === 0) return null;
  return list;
}

// Lua: pokemon.lua:1015
function evolutions(species: any): LuaTable {
  if (isTable(species)) species = Pokemon.speciesOf(species);
  if (typeof species === "string") species = Pokemon.speciesFromName(species) ?? tonumber(species);
  species = tonumber(species);
  if (species == null) return seq();
  if (!truthy(Pokemon._evolutions)) Pokemon.install(Pokemon._cache);
  return (truthy(Pokemon._evolutions) ? Pokemon._evolutions[species] : null) ?? seq();
}

// Lua: pokemon.lua:1024
function dexEntry(species: any): LuaTable {
  if (isTable(species)) species = Pokemon.speciesOf(species);
  if (typeof species === "string") species = Pokemon.speciesFromName(species) ?? tonumber(species);
  species = tonumber(species);
  if (species == null) return null;
  if (!truthy(Pokemon._dex)) Pokemon.install(Pokemon._cache);
  const nat = Pokemon.national(species);
  if (nat == null || !truthy(Pokemon._dex)) return null;
  return Pokemon._dex[nat] ?? null;
}

// Lua: pokemon.lua:1035
function battleMove(moveIdIn: unknown): LuaTable {
  const moveId = tonumber(moveIdIn);
  if (moveId == null) return null;
  if (!truthy(Pokemon._battleMoves)) Pokemon.install(Pokemon._cache);
  if (truthy(Pokemon._battleMoves) && truthy(Pokemon._battleMoves[moveId])) {
    return Pokemon._battleMoves[moveId];
  }
  const [okB, BuiltinMoves] = require_builtin_moves();
  if (okB && BuiltinMoves && BuiltinMoves[moveId]) {
    return BuiltinMoves[moveId];
  }
  return null;
}

// Lua: pokemon.lua:1049
function movePp(moveIdIn: unknown): number {
  const moveId = tonumber(moveIdIn);
  if (moveId == null || moveId < 1) return 5;
  const row = Pokemon.battleMove(moveId);
  return (truthy(row) ? tonumber(row.pp) : undefined) ?? 5;
}

/**
 * FRLG GiveBoxMonInitialMoveset: learn all <= level; if full, drop first; avoid
 * duplicates. Returns the Lua's three values: [moves, pp, maxPp].
 */
// Lua: pokemon.lua:1058
function movesAtLevel(species: any, levelIn?: unknown): [LuaTable, LuaTable, LuaTable] {
  if (isTable(species)) species = Pokemon.speciesOf(species);
  if (typeof species === "string") species = Pokemon.speciesFromName(species) ?? tonumber(species);
  species = tonumber(species);
  const level = tonumber(levelIn) ?? 1;
  const set = Pokemon.learnset(species);
  const moves: LuaTable = seq();
  const pp: LuaTable = seq();
  const maxPp: LuaTable = seq();

  const giveMove = (moveId: number): void => {
    if (!moveId || moveId <= 0) return;
    for (let i = 1; i <= len(moves); i++) {
      if (moves[i] === moveId) {
        return; // already knows this move (pret GiveMoveToBoxMon)
      }
    }
    const mpp = Pokemon.movePp(moveId);
    if (len(moves) < 4) {
      moves[len(moves) + 1] = moveId;
      pp[len(pp) + 1] = mpp;
      maxPp[len(maxPp) + 1] = mpp;
    } else {
      remove(moves, 1);
      remove(pp, 1);
      remove(maxPp, 1);
      moves[4] = moveId;
      pp[4] = mpp;
      maxPp[4] = mpp;
    }
  };

  for (const [, e] of ipairs(set)) {
    const lv = e[1] ?? e.level ?? 0;
    const mv = tonumber(e[2] ?? e.move) ?? 0;
    if (lv > level) {
      break;
    }
    giveMove(mv);
  }

  return [moves, pp, maxPp];
}

/** Moves learned at exactly `level` (ROM learnset). Order preserved. */
// Lua: pokemon.lua:1103
function movesLearnedAt(species: any, levelIn?: unknown): LuaTable {
  if (isTable(species)) species = Pokemon.speciesOf(species);
  if (typeof species === "string") species = Pokemon.speciesFromName(species) ?? tonumber(species);
  species = tonumber(species);
  const level = tonumber(levelIn) ?? 0;
  const out: LuaTable = seq();
  if (species == null || level < 1) return out;
  for (const [, e] of ipairs(Pokemon.learnset(species))) {
    const lv = e[1] ?? e.level ?? 0;
    const mv = tonumber(e[2] ?? e.move) ?? 0;
    if (lv === level && mv > 0) {
      out[len(out) + 1] = mv;
    } else if (lv > level) {
      break;
    }
  }
  return out;
}

// Lua: pokemon.lua:1122
function moveIdAt(mon: any, slot: number): number | undefined {
  if (!truthy(mon) || !truthy(mon.moves)) return undefined;
  const entry = mon.moves[slot];
  if (isTable(entry)) return tonumber(entry.id ?? entry.move);
  return tonumber(entry);
}

// Lua: pokemon.lua:1129
function knowsMove(mon: any, moveIdIn: unknown): boolean {
  const moveId = tonumber(moveIdIn);
  if (!truthy(mon) || moveId == null) return false;
  for (let i = 1; i <= 4; i++) {
    if (Pokemon.moveIdAt(mon, i) === moveId) return true;
  }
  return false;
}

// Lua: pokemon.lua:1138
function moveSlotCount(mon: any): number {
  let n = 0;
  for (let i = 1; i <= 4; i++) {
    const id = Pokemon.moveIdAt(mon, i);
    if (id != null && id > 0) n = n + 1;
  }
  return n;
}

// FRLG HM move IDs (cannot forget).
// Lua: pokemon.lua:1148
const HM_MOVES: Record<number, boolean> = {
  15: true, // CUT
  19: true, // FLY
  57: true, // SURF
  70: true, // STRENGTH
  148: true, // FLASH
  249: true, // ROCK SMASH
  127: true, // WATERFALL
  291: true, // DIVE
};

// Lua: pokemon.lua:1159
function isHmMove(moveId: unknown): boolean {
  return HM_MOVES[tonumber(moveId) ?? 0] === true;
}

/** Item id 289 (TM01) ... 346 (HM08) -> battle move id via extracted sTMHMMoves. */
// Lua: pokemon.lua:1164
function moveFromTmItem(itemId: unknown): number | undefined {
  let num = tonumber(itemId);
  if (num == null) {
    num = ItemsData.toNumericId(itemId as any) ?? undefined;
  }
  if (num == null || num < 289 || num > 346) return undefined;
  if (!truthy(Pokemon._tmhm)) Pokemon.install(Pokemon._cache);
  const machines = truthy(Pokemon._tmhm) ? Pokemon._tmhm.machines : null;
  if (!truthy(machines)) return undefined;
  const tmIndex = num - 289; // 0-based TM01
  return tonumber(machines[tmIndex]);
}

/** Can this species learn TM/HM machine index (0..57)? */
// Lua: pokemon.lua:1179
function canLearnTmIndex(speciesIn: unknown, tmIndexIn: unknown): boolean {
  const species = tonumber(speciesIn);
  const tmIndex = tonumber(tmIndexIn);
  if (species == null || tmIndex == null || tmIndex < 0 || tmIndex > 57) return false;
  if (!truthy(Pokemon._tmhm)) Pokemon.install(Pokemon._cache);
  const row = truthy(Pokemon._tmhm) && truthy(Pokemon._tmhm.learnsets) ? Pokemon._tmhm.learnsets[species] : null;
  if (!truthy(row)) return false;
  const lo = tonumber(row.lo) ?? 0;
  const hi = tonumber(row.hi) ?? 0;
  if (tmIndex < 32) {
    return mod(Math.floor(lo / (2 ** tmIndex)), 2) === 1;
  }
  return mod(Math.floor(hi / (2 ** (tmIndex - 32))), 2) === 1;
}

// Lua: pokemon.lua:1194
function canLearnTmItem(species: unknown, itemId: unknown): boolean {
  let num = tonumber(itemId);
  if (num == null) {
    num = ItemsData.toNumericId(itemId as any) ?? undefined;
  }
  if (num == null || num < 289 || num > 346) return false;
  return Pokemon.canLearnTmIndex(species, num - 289);
}

// Lua: pokemon.lua:1204
function move_max_pp(moveId: number): number {
  const row = Pokemon.battleMove(moveId);
  return (truthy(row) ? tonumber(row.pp) : undefined) ?? 5;
}

/** Teach move into first empty slot. Returns [true, slot] if taught. */
// Lua: pokemon.lua:1210
function teachMove(mon: any, moveIdIn: unknown): [boolean, number?] {
  const moveId = tonumber(moveIdIn);
  if (!truthy(mon) || moveId == null || moveId < 1) return [false];
  if (Pokemon.knowsMove(mon, moveId)) return [false];
  mon.moves = mon.moves ?? seq();
  mon.pp = mon.pp ?? seq();
  mon.maxPp = mon.maxPp ?? seq();
  for (let i = 1; i <= 4; i++) {
    const id = Pokemon.moveIdAt(mon, i);
    if (id == null || id === 0) {
      mon.moves[i] = moveId;
      const max = move_max_pp(moveId);
      mon.pp[i] = max;
      mon.maxPp[i] = max;
      // pokefirered/src/pokemon.c:2208
      if (ModRuntime.wants("pokemon.move_learned")) {
        ModRuntime.emit("pokemon.move_learned", {
          mon, moveId: Gen3Compat.moveName(moveId),
          moveNum: moveId, slot: i,
        });
      }
      return [true, i];
    }
  }
  return [false];
}

/** Replace move at 1-based slot. Returns [forgotten move id] or [nil, "hm"]. */
// Lua: pokemon.lua:1238
function replaceMove(mon: any, slotIn: unknown, newMoveIdIn: unknown): [number | undefined, string?] {
  const slot = tonumber(slotIn);
  const newMoveId = tonumber(newMoveIdIn);
  if (!truthy(mon) || slot == null || slot < 1 || slot > 4 || newMoveId == null) return [undefined];
  const old = Pokemon.moveIdAt(mon, slot);
  if (Pokemon.isHmMove(old)) return [undefined, "hm"];
  mon.moves = mon.moves ?? seq();
  mon.pp = mon.pp ?? seq();
  mon.maxPp = mon.maxPp ?? seq();
  mon.moves[slot] = newMoveId;
  const max = move_max_pp(newMoveId);
  mon.pp[slot] = max;
  mon.maxPp[slot] = max;
  // pokefirered/src/pokemon.c:2248
  if (ModRuntime.wants("pokemon.move_learned")) {
    const G3 = Gen3Compat;
    ModRuntime.emit("pokemon.move_learned", {
      mon, moveId: G3.moveName(newMoveId), moveNum: newMoveId, slot,
      forgotten: G3.moveName(old), forgottenNum: tonumber(old),
    });
  }
  return [old];
}

// An egg reads as the language's own EGG whatever its nickname holds: pret's
// GetMonData(MON_DATA_NICKNAME) returns gText_EggNickname for any egg
// (pokefirered/src/pokemon.c:3020).  The stored nickname is only a placeholder
// -- the cart's daycare writes タマゴ (daycare.c:1100), this engine "EGG".
// Lua: pokemon.lua:1266
function eggName(mon: any): string | undefined {
  if (Pokemon.isEgg(mon)) return RomText.plain("gText_EggNickname");
  return undefined;
}

// Lua: pokemon.lua:1270
function displayMonName(mon: any): string {
  if (!truthy(mon)) return POKEMON_WORD;
  const egg = eggName(mon);
  if (truthy(egg)) return egg!;
  const nick = mon.nickname;
  if (typeof nick === "string" && nick !== "") return nick;
  if (truthy(mon.name) && mon.name !== "") return mon.name;
  const sp = Pokemon.speciesOf(mon);
  return (sp != null ? Pokemon.name(sp) : undefined) ?? POKEMON_WORD;
}

/**
 * Atomically swap two move slots on a Pokémon, keeping move ID, PP, and PP
 * bonuses in sync. Solves the PP Swap Trap.
 */
// Lua: pokemon.lua:1283
function swapMoves(mon: any, slotAIn: unknown, slotBIn: unknown): boolean {
  if (!truthy(mon) || !truthy(slotAIn) || !truthy(slotBIn)) return false;
  const slotA = tonumber(slotAIn);
  const slotB = tonumber(slotBIn);
  if (slotA == null || slotB == null || slotA < 1 || slotA > 4 || slotB < 1 || slotB > 4) {
    return false;
  }
  if (slotA === slotB) return true;

  // 1. If mon.moves is an array of tables: { id = ..., pp = ..., ppBonuses = ... }
  if (isTable(mon.moves)) {
    const entryA = mon.moves[slotA];
    const entryB = mon.moves[slotB];
    mon.moves[slotA] = entryB;
    mon.moves[slotB] = entryA;
  }

  // 2. If parallel array mon.moveIds exists
  if (isTable(mon.moveIds)) {
    const idA = mon.moveIds[slotA];
    mon.moveIds[slotA] = mon.moveIds[slotB];
    mon.moveIds[slotB] = idA;
  }

  // 3. If parallel array mon.pp exists
  if (isTable(mon.pp)) {
    const ppA = mon.pp[slotA];
    mon.pp[slotA] = mon.pp[slotB];
    mon.pp[slotB] = ppA;
  }

  if (isTable(mon.maxPp)) {
    const maxA = mon.maxPp[slotA];
    mon.maxPp[slotA] = mon.maxPp[slotB];
    mon.maxPp[slotB] = maxA;
  }

  // 4. If parallel array mon.ppBonuses / mon.ppBonus / mon.ppUp exists
  if (isTable(mon.ppBonuses)) {
    const bA = mon.ppBonuses[slotA];
    mon.ppBonuses[slotA] = mon.ppBonuses[slotB];
    mon.ppBonuses[slotB] = bA;
  }
  if (isTable(mon.ppBonus)) {
    const bA = mon.ppBonus[slotA];
    mon.ppBonus[slotA] = mon.ppBonus[slotB];
    mon.ppBonus[slotB] = bA;
  }
  if (isTable(mon.ppUp)) {
    const bA = mon.ppUp[slotA];
    mon.ppUp[slotA] = mon.ppUp[slotB];
    mon.ppUp[slotB] = bA;
  }

  // 5. If PP bonuses are stored as packed bits (Gen 3 BoxMon / Pokemon: 2 bits per slot)
  if (typeof mon.ppBonusesPacked === "number") {
    let packed: number = mon.ppBonusesPacked;
    const shiftA = (slotA - 1) * 2;
    const shiftB = (slotB - 1) * 2;
    const bonusA = (packed >>> shiftA) & 3;
    const bonusB = (packed >>> shiftB) & 3;
    packed = packed & ~((3 << shiftA) | (3 << shiftB));
    packed = packed | (bonusA << shiftB) | (bonusB << shiftA);
    mon.ppBonusesPacked = packed;
  }

  // 6. If an active overlay exists on the mon (e.g. party menu overlay)
  if (isTable(mon.overlay)) {
    const ovA = mon.overlay[slotA];
    mon.overlay[slotA] = mon.overlay[slotB];
    mon.overlay[slotB] = ovA;
  }

  return true;
}

// Lua: pokemon.lua:1359
function isEgg(mon: any): boolean {
  if (!truthy(mon)) return false;
  return (mon.isEgg === true) || (mon.egg === true) || (mon.species === 412);
}

// pokefirered/src/pokemon.c:3245 MON_DATA_SPECIES_OR_EGG: an egg's menu icon is
// SPECIES_EGG's, not the species it will hatch into (party_menu.c:2655).
// Lua: pokemon.lua:1366
function speciesOrEgg(mon: any): number | null {
  if (Pokemon.isEgg(mon)) return Pokemon.SPECIES_EGG;
  return Pokemon.speciesOf(mon);
}

// Lua: pokemon.lua:1371
const SPECIES_UNOWN = 201;
const SPECIES_UNOWN_B = 413;

// pokefirered/src/pokemon_icon.c:1080
// Lua: pokemon.lua:1375
function unownLetter(personality: unknown): number {
  const p = mod(tonumber(personality) ?? 0, 4294967296);
  if (p === 0) return 0;
  const bits = (shift: number): number => mod(Math.floor(p / 2 ** shift), 4);
  return mod(bits(24) * 64 + bits(16) * 16 + bits(8) * 4 + bits(0), 28);
}

// pokefirered/src/decompress.c:85, src/pokemon_icon.c:1056
// Lua: pokemon.lua:1383
function picSpecies(speciesIn: unknown, personality?: unknown): number | undefined {
  const species = tonumber(speciesIn);
  if (species !== SPECIES_UNOWN) return species;
  const letter = Pokemon.unownLetter(personality);
  if (letter === 0) return SPECIES_UNOWN;
  return SPECIES_UNOWN_B + letter - 1;
}

// pokefirered/src/pokemon.c:6062
// Lua: pokemon.lua:1392
function isShiny(mon: any): boolean {
  if (!truthy(mon)) return false;
  if (mon.isShiny != null) return truthy(mon.isShiny);
  const p = mod(tonumber(mon.personality) ?? 0, 4294967296);
  const tid = mod(tonumber(mon.otId ?? mon.trainerId) ?? 0, 65536);
  const sid = mod(tonumber(mon.otSecretId) ?? 0, 65536);
  const value = (tid ^ sid) ^ (Math.floor(p / 65536) ^ mod(p, 65536));
  return value < 8;
}

// Lua: pokemon.lua:1402
function monPicSpecies(mon: any): number | undefined {
  if (Pokemon.isEgg(mon)) return Pokemon.SPECIES_EGG;
  return Pokemon.picSpecies(Pokemon.speciesOf(mon), truthy(mon) ? mon.personality : mon);
}

// Lua: pokemon.lua:1407
function monFrontPic(mon: any, form?: unknown): MonPic | null {
  return Pokemon.frontPic(Pokemon.monPicSpecies(mon), form, Pokemon.isShiny(mon), truthy(mon) ? mon.personality : mon);
}

// Lua: pokemon.lua:1411
function monBackPic(mon: any, form?: unknown): MonPic | null {
  return Pokemon.backPic(Pokemon.monPicSpecies(mon), form, Pokemon.isShiny(mon));
}

// pokefirered/src/pokemon_icon.c:1116
// Lua: pokemon.lua:1416
function monIcon(mon: any): MonIcon | null {
  return Pokemon.icon(Pokemon.monPicSpecies(mon));
}

// Lua: pokemon.lua:1420
function read_rgba(species: number): string | null {
  const cache = resolve_cache(Pokemon._cache);
  const root = (CachePaths.CACHE_ROOT ?? "data/generated/gba") + "/pokemon";
  const rel = root + "/icons/" + tostring(species) + ".rgba";
  const d = cache.read(rel);
  if (typeof d === "string" && d.length > 0) return d;
  return null;
}

// Lua: pokemon.lua:1429
// (`love and love.image and love.graphics` always holds here.)
function image_from_rgba(rgba: string | null | undefined, w: number, h: number): Image | null {
  if (rgba == null || rgba.length < w * h * 4) return null;
  let ok: boolean, imageData: ImageData | undefined;
  try {
    imageData = newImageData(w, h, "rgba8", rgba);
    ok = true;
  } catch {
    ok = false;
  }
  if (!ok || !imageData) {
    imageData = newImageData(w, h);
    let i = 1;
    for (let y = 0; y <= h - 1; y++) {
      for (let x = 0; x <= w - 1; x++) {
        imageData.setPixel(x, y,
          (byte(rgba, i) ?? 0) / 255,
          (byte(rgba, i + 1) ?? 0) / 255,
          (byte(rgba, i + 2) ?? 0) / 255,
          (byte(rgba, i + 3) ?? 0) / 255);
        i = i + 4;
      }
    }
  }
  const image = G.newImage(imageData);
  if (image.setFilter) image.setFilter("nearest", "nearest");
  return image;
}

/** Image for menu icon, or nil. */
// Lua: pokemon.lua:1453
function icon(speciesIn: unknown): MonIcon | null {
  const species = tonumber(speciesIn);
  if (species == null || species < 1) return null;
  if (truthy(Pokemon._icons[species])) return Pokemon._icons[species]!;
  const w: number = (truthy(Pokemon._manifest) ? Pokemon._manifest.iconW : undefined) ?? Versions.MON_ICON_W ?? 32;
  const h: number = (truthy(Pokemon._manifest) ? Pokemon._manifest.iconH : undefined) ?? Versions.MON_ICON_H ?? 32;
  const rgba = read_rgba(species);
  if (rgba == null) return null;
  const actualH = (rgba.length >= w * (h * 2) * 4) ? (h * 2) : h;
  const image = image_from_rgba(rgba, w, actualH);
  if (!image) return null;
  const frames = Math.max(1, Math.floor(actualH / h));
  const quads: Quad[] = []; // Lua keys 0..frames-1
  for (let f = 0; f <= frames - 1; f++) {
    quads[f] = G.newQuad(0, f * h, w, h, w, actualH);
  }
  const entry: MonIcon = { image, w, h, sheetH: actualH, frames, quads };
  Pokemon._icons[species] = entry;
  return entry;
}

// Lua: pokemon.lua:1474
function read_pic(rel: string): string | null {
  const cache = resolve_cache(Pokemon._cache);
  const d = truthy(cache) && truthy(cache.read) ? cache.read(rel) : undefined;
  if (typeof d === "string" && d.length >= 64 * 64 * 4) return d;
  return null;
}

// Lua: pokemon.lua:1481
const SPECIES_CASTFORM = 385;

// Lua: pokemon.lua:1483
function form_of(species: number, formIn: unknown): number {
  const form = tonumber(formIn) ?? 0;
  if (species !== SPECIES_CASTFORM || form < 1 || form > 3) return 0;
  return form;
}

// Lua: pokemon.lua:1489
function pic_rel(kind: string, species: number | string, form: number): string {
  const root = (CachePaths.CACHE_ROOT ?? "data/generated/gba") + "/pokemon/" + kind + "/";
  if (form > 0) return root + tostring(species) + "_" + tostring(form) + ".rgba";
  return root + tostring(species) + ".rgba";
}

type PicStore = Record<string | number, MonPic | false | undefined>;

// Lua: pokemon.lua:1495
function pic_entry(store: PicStore, key: string | number, rgba: string | null | undefined): MonPic | null {
  const image = image_from_rgba(rgba, 64, 64);
  if (!image) return null;
  const entry: MonPic = { image, w: 64, h: 64 };
  store[key] = entry;
  return entry;
}

// pokefirered/src/data/pokemon_graphics/shiny_palette_table.h:415
// Lua: pokemon.lua:1504
function pic(store: PicStore, kind: string, speciesIn: unknown, formIn: unknown, shiny: unknown): MonPic | null {
  const species = tonumber(speciesIn);
  if (species == null || species < 1) return null;
  const form = form_of(species, formIn);
  if (truthy(shiny) && species !== Pokemon.SPECIES_EGG) kind = kind + "_shiny";
  let key: string | number = form > 0 ? (tostring(species) + "_" + tostring(form)) : species;
  if (kind.includes("_shiny")) key = "shiny:" + tostring(key);
  const hit = store[key];
  if (hit) return hit;
  // false marks a pic file known to be missing, so draw loops that probe
  // backPic then frontPic every frame do not re-read the filesystem.
  if (hit === false) return null;
  const rgba = read_pic(pic_rel(kind, species, form));
  if (rgba == null) {
    store[key] = false;
    return null;
  }
  return pic_entry(store, key, rgba);
}

// Lua: pokemon.lua:1525
const SPECIES_SPINDA = 308;
const SPINDA_ROOT = "/pokemon/spinda/";

// Lua: pokemon.lua:1528
function spinda_file(nm: string): string | null | undefined {
  const cache = resolve_cache(Pokemon._cache);
  return truthy(cache) && truthy(cache.read)
    ? cache.read((CachePaths.CACHE_ROOT ?? "data/generated/gba") + SPINDA_ROOT + nm) : undefined;
}

interface SpindaData { tiles: string; normal: string; shiny: string; spots: string }

// Lua: pokemon.lua:1533
function spinda_data(): SpindaData | null {
  if (truthy(Pokemon._spinda)) return Pokemon._spinda;
  const tiles = spinda_file("front.4bpp"), normal = spinda_file("normal.gbapal"),
    shinyPal = spinda_file("shiny.gbapal"), spots = spinda_file("spots.bin");
  if (!(tiles != null && tiles.length >= 2048 && normal != null && normal.length >= 32
      && shinyPal != null && shinyPal.length >= 32 && spots != null && spots.length >= 144)) {
    return null;
  }
  Pokemon._spinda = { tiles, normal, shiny: shinyPal, spots };
  return Pokemon._spinda;
}

// pokefirered/src/pokemon.c:5276
// Lua: pokemon.lua:1546
// `buf` is the Lua's table keyed 0..2047 (a JS array, same keys).
function drawSpindaSpots(buf: number[], spots: string, personality: unknown): number[] {
  let p = mod(tonumber(personality) ?? 0, 4294967296);
  for (let i = 0; i <= 3; i++) {
    const base = i * 36;
    const x = mod(byte(spots, base + 1)! + mod(p, 16) - 8, 256);
    let y = mod(byte(spots, base + 2)! + mod(Math.floor(p / 16), 16) - 8, 256);
    for (let row = 0; row <= 15; row++) {
      let bits = byte(spots, base + 3 + row * 2)! + byte(spots, base + 4 + row * 2)! * 256;
      for (let column = x; column <= x + 15; column++) {
        const off = Math.floor(column / 8) * 32 + Math.floor(mod(column, 8) / 2)
          + Math.floor(y / 8) * 256 + mod(y, 8) * 4;
        if (mod(bits, 2) === 1) {
          const b = buf[off] ?? 0;
          if (mod(column, 2) === 1) {
            const hi = Math.floor(b / 16);
            if (hi >= 1 && hi <= 3) buf[off] = b + 64;
          } else {
            const lo = mod(b, 16);
            if (lo >= 1 && lo <= 3) buf[off] = b + 4;
          }
        }
        bits = Math.floor(bits / 2);
      }
      y = mod(y + 1, 256);
    }
    p = Math.floor(p / 256);
  }
  return buf;
}

// Lua: pokemon.lua:1576
function spinda_rgba(personality: unknown, shiny: unknown): string | null {
  const d = spinda_data();
  if (!d) return null;
  const buf: number[] = [];
  for (let i = 0; i <= 2047; i++) buf[i] = byte(d.tiles, i + 1)!;
  Pokemon.drawSpindaSpots(buf, d.spots, personality);
  const pal = truthy(shiny) ? d.shiny : d.normal;
  const rgb: string[] = [];
  for (let c = 0; c <= 15; c++) {
    const v = byte(pal, c * 2 + 1)! + byte(pal, c * 2 + 2)! * 256;
    rgb[c] = char(Math.floor(mod(v, 32) * 255 / 31 + 0.5),
      Math.floor(mod(Math.floor(v / 32), 32) * 255 / 31 + 0.5),
      Math.floor(mod(Math.floor(v / 1024), 32) * 255 / 31 + 0.5), 255);
  }
  const out: LuaTable = seq();
  const clear = char(0, 0, 0, 0);
  for (let ty = 0; ty <= 7; ty++) {
    for (let tx = 0; tx <= 7; tx++) {
      const tileOff = (ty * 8 + tx) * 32;
      for (let row = 0; row <= 7; row++) {
        for (let bx = 0; bx <= 3; bx++) {
          const b = buf[tileOff + row * 4 + bx]!;
          const x0 = tx * 8 + bx * 2;
          const i0 = (ty * 8 + row) * 64 + x0 + 1;
          const lo = mod(b, 16), hi = Math.floor(b / 16);
          out[i0] = lo === 0 ? clear : rgb[lo];
          out[i0 + 1] = hi === 0 ? clear : rgb[hi];
        }
      }
    }
  }
  return concat(out);
}

// pokefirered/src/decompress.c:105, src/pokemon.c:5339
// Lua: pokemon.lua:1612
function spinda_pic(personality: unknown, shiny: unknown): MonPic | null {
  const p = mod(tonumber(personality) ?? 0, 4294967296);
  const key = (truthy(shiny) ? "spinda_shiny:" : "spinda:") + tostring(p);
  Pokemon._spindaPics = Pokemon._spindaPics ?? {};
  const store = Pokemon._spindaPics!;
  if (store[key]) return store[key] as MonPic;
  return pic_entry(store, key, spinda_rgba(p, shiny));
}

// pokefirered/src/battle_gfx_sfx_util.c:354
// Lua: pokemon.lua:1621
function frontPic(species: unknown, form?: unknown, shiny?: unknown, personality?: unknown): MonPic | null {
  if (tonumber(species) === SPECIES_SPINDA) return spinda_pic(personality, shiny);
  return pic(Pokemon._front, "front", species, form, shiny);
}

// pokefirered/src/pokedex_screen.c:2212
// Lua: pokemon.lua:1627
function dexFrontPic(species: unknown, personality?: unknown): MonPic | null {
  const p = mod(tonumber(personality) ?? 0, 4294967296);
  // include/constants/pokemon.h:185
  const shiny = Pokemon.isShiny({ personality: p, otId: 8, otSecretId: 0 });
  return Pokemon.frontPic(Pokemon.picSpecies(species, p), 0, shiny, p);
}

// pokefirered/src/pokedex_screen.c:3058
// Lua: pokemon.lua:1635
function dexIcon(species: unknown, personality?: unknown): MonIcon | null {
  return Pokemon.icon(Pokemon.picSpecies(species, personality));
}

// Lua: pokemon.lua:1640
function backPic(species: unknown, form?: unknown, shiny?: unknown): MonPic | null {
  Pokemon._back = Pokemon._back ?? {};
  return pic(Pokemon._back!, "back", species, form, shiny);
}

// pokefirered/src/battle_gfx_sfx_util.c:422
// Lua: pokemon.lua:1646
function ghostPic(): MonPic | null {
  if (Pokemon._front.ghost) return Pokemon._front.ghost as MonPic;
  return pic_entry(Pokemon._front, "ghost", read_pic(pic_rel("front", "ghost", 0)));
}

// pokefirered/src/data/text/species_names.h:254
// Lua: pokemon.lua:1655
function isInternalSpecies(nIn: unknown): boolean {
  const n = tonumber(nIn);
  if (n == null || n < 1) return false;
  if (!truthy(Pokemon._names)) Pokemon.install(Pokemon._cache);
  const nm = truthy(Pokemon._names) ? Pokemon._names[n] : null;
  if (typeof nm !== "string" || nm === "") return false;
  return match(nm, "^%?+$") == null;
}

// Lua: pokemon.lua:1664
function numberingOf(mon: any): string | null {
  if (!isTable(mon)) return null;
  const tag = mon.speciesNumbering;
  if (tag === Pokemon.NUMBERING_INTERNAL || tag === Pokemon.NUMBERING_NATIONAL) return tag;
  return null;
}

// Lua: pokemon.lua:1671
function tagNumbering(mon: any, kind?: string): any {
  if (!isTable(mon)) return mon;
  if (kind !== Pokemon.NUMBERING_NATIONAL) kind = Pokemon.NUMBERING_INTERNAL;
  mon.speciesNumbering = kind;
  return mon;
}

/**
 * Resolve display species for a host/opaque mon table.
 * Host mons use string ids ("KYOGRE"); FRLG scripts use internal SPECIES ints.
 */
// Lua: pokemon.lua:1680
function speciesOf(mon: any): number | null {
  if (!truthy(mon)) return null;
  let raw = mon.species ?? mon.speciesId ?? mon.id;
  if (raw == null) return null;

  if (typeof raw === "string") {
    const byName = Pokemon.speciesFromName(raw);
    if (byName != null) return byName;
    const num = tonumber(raw);
    if (num != null) raw = num; else return null;
  }

  const n = tonumber(raw);
  if (n == null || n < 1) return null;

  const numbering = Pokemon.numberingOf(mon);
  if (numbering === Pokemon.NUMBERING_NATIONAL) {
    return Pokemon.speciesFromNational(n) ?? n;
  }
  if (numbering === Pokemon.NUMBERING_INTERNAL) return n;

  if (Pokemon.isInternalSpecies(n)) return n;
  return Pokemon.speciesFromNational(n) ?? n;
}

// Lua: pokemon.lua:1705
function displayName(mon: any): string {
  if (!truthy(mon)) return "?????";
  const egg = eggName(mon);
  if (truthy(egg)) return egg!;
  if (truthy(mon.nickname) && mon.nickname !== "") return tostring(mon.nickname);
  // Prefer pack name over host species string when we can resolve.
  const sp = Pokemon.speciesOf(mon);
  if (sp != null) return Pokemon.name(sp);
  if (truthy(mon.name) && mon.name !== "") return tostring(mon.name);
  if (typeof mon.species === "string") return mon.species;
  return "?????";
}

// pokefirered/src/trade.c:2391
// pokefirered/src/pokemon.c:1809
// Lua: pokemon.lua:1720
function savedName(mon: any): string | null {
  if (!isTable(mon)) return null;
  const nick = mon.nickname;
  if (typeof nick === "string" && nick !== "") return nick;
  if (Pokemon.isEgg(mon)) return null;
  const nm = mon.name;
  if (typeof nm === "string" && nm !== "") return nm;
  return null;
}

// Lua: pokemon.lua:7-33, 184, 357-359, 497-514, 536, 837, 918-920, 1524,
// 1651-1652 (the module's fields and constants), then its functions in order.
export const Pokemon = {
  _cache: null as PokemonCache | null,
  _names: null as LuaTable,
  _types: null as LuaTable,
  _national: null as LuaTable,
  _manifest: null as LuaTable,
  _byName: null as Record<string, number> | null, // normalized host/FRLG name -> internal SPECIES
  _icons: {} as Record<number, MonIcon | undefined>, // [species] = { image, w, h }
  _front: {} as PicStore, // [species] = { image, w, h }
  _back: null as PicStore | null,
  _spinda: null as SpindaData | null,
  _spindaPics: null as PicStore | null,
  _installTried: null as unknown,
  _installWarned: null as unknown,
  _stats: null as LuaTable,
  _abilities: null as LuaTable,
  _abilityNames: null as LuaTable,
  _speciesMeta: null as LuaTable,
  _moveNames: null as LuaTable,
  // The ROM's English move and ability names, copied at install before a mod
  // renames entries of _moveNames/_abilityNames in place.  Anything keyed by
  // the English name (the summary's descriptions) reads these.
  _romMoveNames: null as LuaTable,
  _romAbilityNames: null as LuaTable,
  _learnsets: null as LuaTable,
  _eggMoves: null as LuaTable,
  _evolutions: null as LuaTable,
  _tmhm: null as LuaTable,
  _dex: null as LuaTable,
  _battleMoves: null as LuaTable,
  _logged: false,
  _reloadHooks: seq() as LuaTable,

  // Gen3 genderRatio specials (match pret constants/pokemon.h).
  GENDER_MALE: 0x00,
  GENDER_FEMALE: 0xFE,
  GENDER_GENDERLESS: 0xFF,

  // pokefirered/include/constants/pokemon.h:215
  FRIENDSHIP_EVENT_GROW_LEVEL: 0,
  FRIENDSHIP_EVENT_VITAMIN: 1,
  FRIENDSHIP_EVENT_BATTLE_ITEM: 2,
  FRIENDSHIP_EVENT_LEAGUE_BATTLE: 3,
  FRIENDSHIP_EVENT_LEARN_TMHM: 4,
  FRIENDSHIP_EVENT_WALKING: 5,
  FRIENDSHIP_EVENT_MASSAGE: 6,
  FRIENDSHIP_EVENT_FAINT_SMALL: 7,
  FRIENDSHIP_EVENT_FAINT_OUTSIDE_BATTLE: 8,
  FRIENDSHIP_EVENT_FAINT_LARGE: 9,

  // pokefirered/include/constants/pokemon.h:226,233
  MAX_FRIENDSHIP: 255,
  MAX_PER_STAT_EVS: 255,
  MAX_TOTAL_EVS: 510,
  EV_ITEM_RAISE_LIMIT: 100,

  SPECIES_EGG: 412,
  EV_KEYS,

  // pokefirered/include/constants/trainers.h:267
  LEAGUE_TRAINER_CLASSES: { 84: true, 87: true, 90: true } as Record<number, boolean>,

  // pokefirered/src/data/pokemon/item_effects.h:163 VITAMIN_FRIENDSHIP_CHANGE
  VITAMIN_FRIENDSHIP_CHANGE: seq(5, 3, 2) as LuaTable,
  // pokefirered/src/data/pokemon/item_effects.h:225 STAT_BOOST_FRIENDSHIP_CHANGE
  STAT_BOOST_FRIENDSHIP_CHANGE: seq(1, 1, 0) as LuaTable,

  SPECIES_SPINDA,

  NUMBERING_INTERNAL: "internal",
  NUMBERING_NATIONAL: "national",

  install,
  onReload,
  _runReloadHooks,
  invalidate,
  ready,
  name,
  keyName,
  speciesFromName,
  speciesFromNational,
  national,
  types,
  stats,
  abilities,
  abilityName,
  speciesMeta,
  expYield,
  growthRate,
  natureId,
  gender,
  abilityId,
  calcStats,
  applyStats,
  baseFriendship,
  evYield,
  friendshipOf,
  setFriendship,
  evsOf,
  evCount,
  hasPokerus,
  hasHadPokerus,
  checkPartyPokerus,
  checkPartyHasHadPokerus,
  randomlyGivePartyPokerus,
  updatePartyPokerusTime,
  partySpreadPokerus,
  regional,
  regionalCount,
  gainEVs,
  currentMapSec,
  isOtherTrainer,
  isTradedMon,
  isLeagueTrainerClass,
  adjustFriendship,
  adjustFriendshipOnBattleFaint,
  itemFriendship,
  raiseEvFromItem,
  romMoveName,
  romAbilityName,
  moveName,
  learnset,
  eggMoves,
  evolutions,
  dexEntry,
  battleMove,
  movePp,
  // Lua: pokemon.lua:1055
  moveMaxPp: movePp,
  movesAtLevel,
  movesLearnedAt,
  moveIdAt,
  knowsMove,
  moveSlotCount,
  isHmMove,
  moveFromTmItem,
  canLearnTmIndex,
  canLearnTmItem,
  teachMove,
  replaceMove,
  displayMonName,
  swapMoves,
  isEgg,
  speciesOrEgg,
  unownLetter,
  picSpecies,
  isShiny,
  monPicSpecies,
  monFrontPic,
  monBackPic,
  monIcon,
  icon,
  drawSpindaSpots,
  // Lua: pokemon.lua:1609
  spindaRgba: spinda_rgba,
  frontPic,
  dexFrontPic,
  dexIcon,
  // Lua: pokemon.lua:1638
  frontSprite: frontPic,
  backPic,
  ghostPic,
  isInternalSpecies,
  numberingOf,
  tagNumbering,
  speciesOf,
  displayName,
  savedName,
};

export default Pokemon;
