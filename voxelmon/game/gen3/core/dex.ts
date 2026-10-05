// Port of gen1recomp src/core/game3/dex.lua (GPLv3 + additional terms; see LICENSE.md).
// Pokédex quarantine (H9): host bits 1–251; species 252+ in national_dex sidecar.
//
// The seen / caught / owned tables are Lua tables keyed by species: plain
// objects with integer keys here (absent = == null; clearing deletes the key).

import { format, mod, tonumber, tostring, truthy } from "../../../import/gen3/lua.ts";
import { pairs, ipairs, type LuaTable } from "../platform/lt.ts";
import { luaLoad } from "../platform/luadata.ts";
import { Profile } from "./profile.ts";
import { CachePaths } from "./cache_paths.ts";
import { Constants } from "./constants.ts";
import { Dataset } from "./dataset.ts";
import { Pokemon } from "./pokemon.ts";
import { PokedexData } from "./pokedex_data.ts";
import { Flags } from "./scripting/flags.ts";
import { GameVersion } from "../shared/core/GameVersion.ts";
import { CacheFs } from "../shared/import/CacheFs.ts";

type Row = ReturnType<typeof Profile.of>;
type DexTable = Record<string, any>;

const isTable = (v: unknown): v is LuaTable => v !== null && typeof v === "object";

// Lua: dex.lua:9
function profile_of(version: string | undefined): Row {
  return Profile.of(version);
}

// Lua: dex.lua:13 -- returns block, row
function dex_block(version: string | undefined): [Record<string, any>, Row] {
  const row = profile_of(version);
  const block = row.dex;
  if (!isTable(block)) {
    throw new Error("game3 profile '" + tostring(row.id) + "' has no dex block");
  }
  return [block, row];
}

// Lua: dex.lua:22
function version_of(session: any): string | undefined {
  if (isTable(session) && typeof session.version === "string") return session.version;
  return Profile.sessionVersion(session);
}

const packs: Record<string, any> = {};

// Lua: dex.lua:45
function load_pack(version: string | undefined, rel: string): any {
  const key = tostring(version) + "|" + rel;
  let t = packs[key];
  if (t != null) return truthy(t) ? t : undefined;
  const src = Dex.packReader(version, rel);
  if (!truthy(src)) throw new Error("dex pack " + rel + " is not in the " + tostring(version) + " cache");
  const [chunk, err] = luaLoad(src, "@" + rel);
  if (!chunk) throw new Error(err);
  t = chunk();
  packs[key] = t;
  return t;
}

// Lua: dex.lua:105
function resolve_species_id(species: unknown): number | undefined {
  if (species == null) return undefined;
  const n = tonumber(species);
  if (n !== undefined && n >= 1) return n;
  // Lua: pcall(require, "src.core.game3.pokemon") -- always loads here
  const P: any = Pokemon; // Lua also probes Pokemon.byName (not a member here)
  if (P) {
    if (P.speciesFromName) {
      const id = P.speciesFromName(tostring(species));
      if (truthy(id) && tonumber(id) !== undefined) return tonumber(id);
    } else if (P.byName) {
      const id = P.byName(tostring(species));
      if (truthy(id) && tonumber(id) !== undefined) return tonumber(id);
    }
  }
  return undefined;
}

// Lua: dex.lua:122
function bit_get(arr: unknown, species: any): boolean {
  if (!isTable(arr)) return false;
  const sp = resolve_species_id(species);
  if (sp !== undefined && arr[sp] === true) return true;
  if (species != null && arr[species] === true) return true;
  let v = sp !== undefined ? arr[sp] : undefined;
  if (!truthy(v)) v = species != null ? arr[species] : undefined;
  if (truthy(v) && v !== 0 && v !== false) return true;
  return false;
}

// Lua: dex.lua:132
function bit_set(arr: LuaTable, species: any, on: boolean): void {
  if (!truthy(arr)) return;
  const sp = resolve_species_id(species);
  const k = sp !== undefined ? sp : species;
  if (on) arr[k] = true;
  else delete arr[k];
}

const SPECIES_UNOWN = 201;
const SPECIES_SPINDA = 308;

// Lua: dex.lua:207
function record_personality(dex: DexTable, species: number | undefined, personality: unknown): void {
  const p = mod(tonumber(personality) ?? 0, 4294967296);
  if (species === SPECIES_UNOWN) dex.unownPersonality = p;
  if (species === SPECIES_SPINDA) dex.spindaPersonality = p;
}

// Lua: dex.lua:333
function keyed(t: unknown, id: any): any {
  if (!isTable(t)) return undefined;
  let v = t[id];
  if (v == null) v = t[tostring(id)];
  if (v == null) v = t[format("0x%X", id)];
  return v;
}

export const Dex = {
  HOST_MAX: 251,
  KANTO_MAX: 151,
  NATIONAL_MAX: 386,

  // Lua: dex.lua:27
  packReader(version: string | undefined, rel: string): string | undefined {
    const root = CachePaths.CACHE_ROOT;
    if (version == null || version === GameVersion.get()) {
      // Lua: pcall(require, "src.core.game3.dataset") -- always loads here
      if (Dataset && Dataset.cache) {
        const src = Dataset.cache().read(root + "/" + rel);
        if (truthy(src)) return src;
      }
    }
    if (!(CacheFs && CacheFs.readAt)) return undefined;
    const info = GameVersion.info(version);
    return CacheFs.readAt(((info && info.cachePrefix) || "") + root + "/" + rel);
  },

  // Lua: dex.lua:56
  resetPacks(): void {
    for (const k of Object.keys(packs)) delete packs[k];
  },

  // Lua: dex.lua:60
  regionalMax(version: string | undefined): number {
    const [block] = dex_block(version);
    if (truthy(block.regionalPrefix)) return block.regionalPrefix;
    return load_pack(profile_of(version).id, block.orderPack).count;
  },

  // Lua: dex.lua:67 -- pokeemerald/src/pokemon.c:5685
  regionalNumber(speciesIn: unknown, version: string | undefined): number | undefined {
    const species = tonumber(speciesIn);
    if (species === undefined) return undefined;
    const [block, row] = dex_block(version);
    if (truthy(block.regionalPrefix)) {
      if (species >= 1 && species <= block.regionalPrefix) return species;
      return undefined;
    }
    const n = load_pack(row.id, block.regionalPack).toHoenn[species];
    if (truthy(n) && n <= Dex.regionalMax(row.id)) return n;
    return undefined;
  },

  // Lua: dex.lua:80
  inRegional(species: unknown, version: string | undefined): boolean {
    return Dex.regionalNumber(species, version) != null;
  },

  // Lua: dex.lua:85 -- pokeemerald/src/pokemon.c:5659
  nationalInRegional(natIn: unknown, version: string | undefined): boolean {
    const nat = tonumber(natIn);
    if (nat === undefined) return false;
    const [block, row] = dex_block(version);
    if (truthy(block.regionalPrefix)) return nat >= 1 && nat <= block.regionalPrefix;
    const pack = load_pack(row.id, block.orderPack);
    for (let i = 1; i <= pack.count; i++) {
      if (pack.order[i] === nat) return true;
    }
    return false;
  },

  // Lua: dex.lua:97
  new(): DexTable {
    return {
      seen: {},   // [species] = true
      caught: {}, // [species] = true
      owned: {},  // alias for caught
    };
  },

  /** Import host dex (1–251) into game3 dex. */
  // Lua: dex.lua:143
  mergeFromHost(dex: DexTable | undefined, hostSave: any): void {
    if (!truthy(dex) || !truthy(hostSave)) return;
    const d = dex as DexTable;
    d.seen = d.seen ?? {};
    d.caught = d.caught ?? {};
    d.owned = d.owned ?? d.caught;
    const pd = hostSave.pokedex ?? hostSave.pokeDex ?? {};
    const seen = pd.seen ?? hostSave.seen ?? {};
    const caught = pd.caught ?? pd.owned ?? hostSave.caught ?? {};
    for (let sp = 1; sp <= Dex.HOST_MAX; sp++) {
      if (bit_get(seen, sp)) {
        bit_set(d.seen, sp, true);
      }
      if (bit_get(caught, sp)) {
        bit_set(d.caught, sp, true);
        bit_set(d.owned, sp, true);
      }
    }
  },

  /** Restore National sidecar (252+) into game3 dex. */
  // Lua: dex.lua:163
  restoreNational(dex: DexTable | undefined, sidecar: any): void {
    if (!truthy(dex) || !isTable(sidecar)) return;
    const d = dex as DexTable;
    d.seen = d.seen ?? {};
    d.caught = d.caught ?? {};
    d.owned = d.owned ?? d.caught;
    const nd = sidecar.national_dex ?? sidecar;
    const seen = nd.seen ?? {};
    const caught = nd.caught ?? {};
    for (const [sp, on] of pairs(seen)) {
      const n = tonumber(sp);
      if (n !== undefined && n > Dex.HOST_MAX && truthy(on)) bit_set(d.seen, n, true);
    }
    for (const [sp, on] of pairs(caught)) {
      const n = tonumber(sp);
      if (n !== undefined && n > Dex.HOST_MAX && truthy(on)) {
        bit_set(d.caught, n, true);
        bit_set(d.owned, n, true);
      }
    }
  },

  // Lua: dex.lua:184
  setSeen(dex: DexTable | undefined, species: any): void {
    if (!truthy(dex)) return;
    const d = dex as DexTable;
    d.seen = d.seen ?? {};
    const sp = resolve_species_id(species) ?? species;
    if (!truthy(sp)) return;
    bit_set(d.seen, sp, true);
  },

  // Lua: dex.lua:192
  setCaught(dex: DexTable | undefined, species: any): void {
    if (!truthy(dex)) return;
    const d = dex as DexTable;
    d.seen = d.seen ?? {};
    d.caught = d.caught ?? {};
    d.owned = d.owned ?? d.caught;
    const sp = resolve_species_id(species) ?? species;
    if (!truthy(sp)) return;
    bit_set(d.seen, sp, true);
    bit_set(d.caught, sp, true);
    bit_set(d.owned, sp, true);
  },

  // Lua: dex.lua:214 -- pokefirered/src/pokemon.c:6233
  handleSetPokedexFlag(dex: DexTable | undefined, species: any, caught: unknown, personality: unknown): void {
    if (!truthy(dex)) return;
    const sp = resolve_species_id(species);
    if (sp === undefined) return;
    if (truthy(caught)) {
      if (Dex.isCaught(dex, sp)) return;
      Dex.setCaught(dex, sp);
    } else {
      if (Dex.isSeen(dex, sp)) return;
      Dex.setSeen(dex, sp);
    }
    record_personality(dex as DexTable, sp, personality);
  },

  // Lua: dex.lua:229 -- pokefirered/src/pokedex_screen.c:2197
  defaultPersonality(dex: DexTable | undefined, speciesIn: unknown): number {
    const species = tonumber(speciesIn);
    if (!truthy(dex)) return 0;
    const d = dex as DexTable;
    if (species === SPECIES_SPINDA) return tonumber(d.spindaPersonality) ?? 0;
    if (species === SPECIES_UNOWN) return tonumber(d.unownPersonality) ?? 0;
    return 0;
  },

  // Lua: dex.lua:237
  isSeen(dex: DexTable | undefined, species: any): boolean {
    if (!truthy(dex)) return false;
    return bit_get((dex as DexTable).seen, species);
  },

  // Lua: dex.lua:242
  isCaught(dex: DexTable | undefined, species: any): boolean {
    if (!truthy(dex)) return false;
    const d = dex as DexTable;
    return bit_get(d.caught, species) || bit_get(d.owned, species);
  },

  // Lua: dex.lua:247
  isOwned(dex: DexTable | undefined, species: any): boolean {
    return Dex.isCaught(dex, species);
  },

  /** Register an encounter; returns whether it was already seen. */
  // Lua: dex.lua:252
  registerEncounter(dex: DexTable | undefined, species: any, session?: any): boolean {
    if (!truthy(dex) || !truthy(species)) return false;
    const sp = tonumber(species) ?? 1;
    if (truthy(dex_block(version_of(session))[0].registerGate) && sp > (Dex.KANTO_MAX ?? 151)) {
      if (!truthy(PokedexData.isNationalUnlocked(session, dex))) {
        return true; // cannot register non-Kanto species before National Dex
      }
    }
    const wasSeen = Dex.isSeen(dex, species);
    Dex.setSeen(dex, species);
    return wasSeen;
  },

  /** Register a capture; returns whether it was already caught. */
  // Lua: dex.lua:267
  registerCapture(dex: DexTable | undefined, species: any, session?: any, personality?: unknown): boolean {
    if (!truthy(dex) || !truthy(species)) return false;
    const sp = tonumber(species) ?? 1;
    if (truthy(dex_block(version_of(session))[0].registerGate) && sp > (Dex.KANTO_MAX ?? 151)) {
      if (!truthy(PokedexData.isNationalUnlocked(session, dex))) {
        return true; // cannot register non-Kanto species before National Dex
      }
    }
    const wasCaught = Dex.isCaught(dex, species);
    Dex.setCaught(dex, species);
    // pokefirered/src/battle_script_commands.c:9657
    if (!wasCaught) record_personality(dex as DexTable, resolve_species_id(species), personality);
    return wasCaught;
  },

  /** Count seen Pokémon in Kanto (1..151) or National mode. */
  // Lua: dex.lua:284
  countSeen(dex: DexTable | undefined, modeIn?: string): number {
    if (!truthy(dex)) return 0;
    const d = dex as DexTable;
    const mode = (modeIn ?? "kanto").toLowerCase();
    const maxSp = mode === "national" ? Dex.NATIONAL_MAX : Dex.KANTO_MAX;
    let count = 0;
    for (let sp = 1; sp <= maxSp; sp++) {
      if (Dex.isSeen(d, sp)) {
        count = count + 1;
      }
    }
    // Also count any seen above NATIONAL_MAX in national mode
    if (mode === "national" && isTable(d.seen)) {
      for (const [sp, on] of pairs(d.seen)) {
        const n = tonumber(sp);
        if (n !== undefined && n > Dex.NATIONAL_MAX && truthy(on)) {
          count = count + 1;
        }
      }
    }
    return count;
  },

  /** Count caught Pokémon in Kanto (1..151) or National mode. */
  // Lua: dex.lua:307
  countCaught(dex: DexTable | undefined, modeIn?: string): number {
    if (!truthy(dex)) return 0;
    const d = dex as DexTable;
    const mode = (modeIn ?? "kanto").toLowerCase();
    const maxSp = mode === "national" ? Dex.NATIONAL_MAX : Dex.KANTO_MAX;
    let count = 0;
    for (let sp = 1; sp <= maxSp; sp++) {
      if (Dex.isCaught(d, sp)) {
        count = count + 1;
      }
    }
    if (mode === "national") {
      const cTable = d.caught ?? d.owned ?? {};
      for (const [sp, on] of pairs(cTable)) {
        const n = tonumber(sp);
        if (n !== undefined && n > Dex.NATIONAL_MAX && truthy(on)) {
          count = count + 1;
        }
      }
    }
    return count;
  },

  // Lua: dex.lua:329
  countOwned(dex: DexTable | undefined, mode?: string): number {
    return Dex.countCaught(dex, mode);
  },

  // Lua: dex.lua:342 -- pokefirered/src/event_data.c:107
  nationalEnabled(save: any): boolean {
    if (!isTable(save)) return false;
    const [block, row] = dex_block(save.version);
    const nat = block.national;
    const C = Constants.of(row.id);
    const dex = isTable(save.dex) ? save.dex : {};
    const magic = dex.national === true || dex.nationalUnlocked === true || dex.isNationalUnlocked === true
      || save.national_dex_unlocked === true
      || (nat.magic != null && tonumber(dex.nationalMagic) === nat.magic);
    const flag = keyed(save.flags, C.require("flags", nat.flag));
    const flagSet = flag === true || (isTable(save.flags) && save.flags[nat.flag] === true);
    let v = keyed(save.vars, C.require("vars", nat.var));
    if (v == null && isTable(save.vars)) v = save.vars[nat.var];
    const varSet = tonumber(v) === nat.value;
    if (truthy(nat.requireAll)) return magic && flagSet && varSet;
    return magic || flagSet || varSet;
  },

  // Lua: dex.lua:361 -- pokeemerald/src/event_data.c:63
  enableNational(session: any): void {
    if (!isTable(session)) return;
    const [block, row] = dex_block(session.version);
    const nat = block.national;
    const C = Constants.of(row.id);
    session.dex = session.dex ?? {};
    session.dex.national = true;
    if (truthy(nat.magic)) session.dex.nationalMagic = nat.magic;
    if (row.family === "rse") session.pokedex = { mode: 1, order: 0 };
    session.flags = session.flags ?? {};
    session.vars = session.vars ?? {};
    Flags.setVar(session, undefined, C.require("vars", nat.var), nat.value);
    Flags.setFlag(session, undefined, C.require("flags", nat.flag), true);
  },

  // Lua: dex.lua:378 -- pokefirered/src/main_menu.c:643
  summaryCount(save: any): number {
    if (!isTable(save)) return 0;
    const dex = isTable(save.dex) ? save.dex
      : isTable(save.pokedex) ? save.pokedex : {};
    const national = Dex.nationalEnabled(save);
    const [block] = dex_block(save.version);
    const prefix = truthy(block.regionalPrefix);
    const counted: Record<number, boolean> = {};
    let n = 0;
    for (const key of ["caught", "owned"]) {
      for (const [sp, on] of pairs(isTable(dex[key]) ? dex[key] : {})) {
        let id = tonumber(sp);
        if (id === undefined && typeof sp === "string") {
          // Lua: pcall(resolve_species_id, sp)
          try {
            id = tonumber(resolve_species_id(sp));
          } catch {
            id = undefined;
          }
        }
        const regional = national || (prefix && id !== undefined && id <= Dex.KANTO_MAX)
          || (!prefix && id !== undefined && Dex.inRegional(id, save.version));
        if (id !== undefined && truthy(on) && on !== 0 && !counted[id]
            && id >= 1 && regional) {
          counted[id] = true;
          n = n + 1;
        }
      }
    }
    const ci = isTable(save.modData) && isTable(save.modData.cartImport)
      ? save.modData.cartImport : undefined;
    const maxNat = national ? Dex.NATIONAL_MAX : Dex.KANTO_MAX;
    for (const [, natRaw] of ipairs(ci && isTable(ci.dexOwned) ? ci.dexOwned : {})) {
      const nat = tonumber(natRaw);
      const inDex = (nat !== undefined && (national || prefix) && nat <= maxNat)
        || (nat !== undefined && !national && !prefix && Dex.nationalInRegional(nat, save.version));
      if (nat !== undefined && nat >= 1 && inDex && !(nat <= Dex.HOST_MAX && counted[nat])) {
        if (nat <= Dex.HOST_MAX) counted[nat] = true;
        n = n + 1;
      }
    }
    return n;
  },

  /** Split for returnToHost: hostUpdates (1–251) + national sidecar (252+). */
  // Lua: dex.lua:417 -- returns hostUpdates, national
  splitForHost(dex: DexTable | undefined): [DexTable, DexTable] {
    const hostSeen: Record<number, boolean> = {}, hostCaught: Record<number, boolean> = {};
    const natSeen: Record<number, boolean> = {}, natCaught: Record<number, boolean> = {};
    if (!truthy(dex)) {
      return [{ seen: hostSeen, caught: hostCaught },
        { seen: natSeen, caught: natCaught }];
    }
    const d = dex as DexTable;
    for (const [sp, on] of pairs(d.seen ?? {})) {
      const n = tonumber(sp);
      if (n !== undefined && truthy(on)) {
        if (n <= Dex.HOST_MAX) hostSeen[n] = true;
        else natSeen[n] = true;
      }
    }
    for (const [sp, on] of pairs(d.caught ?? {})) {
      const n = tonumber(sp);
      if (n !== undefined && truthy(on)) {
        if (n <= Dex.HOST_MAX) hostCaught[n] = true;
        else natCaught[n] = true;
      }
    }
    return [{ seen: hostSeen, caught: hostCaught },
      { seen: natSeen, caught: natCaught }];
  },

  /** Merge hostUpdates into save without touching indices > 251. */
  // Lua: dex.lua:443
  applyHostUpdates(save: any, hostUpdates: any): void {
    if (!truthy(save) || !truthy(hostUpdates)) return;
    save.pokedex = save.pokedex ?? {};
    save.pokedex.seen = save.pokedex.seen ?? {};
    save.pokedex.caught = save.pokedex.caught ?? {};
    for (const [sp, on] of pairs(hostUpdates.seen ?? {})) {
      const n = tonumber(sp);
      if (n !== undefined && n >= 1 && n <= Dex.HOST_MAX && truthy(on)) {
        save.pokedex.seen[n] = true;
      }
    }
    for (const [sp, on] of pairs(hostUpdates.caught ?? {})) {
      const n = tonumber(sp);
      if (n !== undefined && n >= 1 && n <= Dex.HOST_MAX && truthy(on)) {
        save.pokedex.caught[n] = true;
      }
    }
  },
};

export default Dex;
