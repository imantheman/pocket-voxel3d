// Port of gen1recomp src/core/game3/move_learn.lua (GPLv3 + additional terms; see LICENSE.md).
// pokefirered/src/pokemon.c:5741 GetMoveRelearnerMoves
//
// NOT FAITHFUL (module): src.import.gba.extract_island1 is not ported; its
// CACHE_ROOT forwards to CachePaths.CACHE_ROOT (extract_island1.lua:21),
// which is read directly.

import { tonumber, truthy } from "../../../import/gen3/lua.ts";
import { ipairs, pairs, len, seq, type LuaTable } from "../platform/lt.ts";
import { luaLoad } from "../platform/luadata.ts";
import { Fs } from "../platform/fs.ts";
import { Pokemon } from "./pokemon.ts";
import { Profile } from "./profile.ts";
import { CachePaths } from "./cache_paths.ts";
import { Dataset } from "./dataset.ts";
import { CacheFs } from "../shared/import/CacheFs.ts";

// pokefirered/include/constants/pokemon.h:209
const MAX_LEVEL_UP_MOVES = 20;
// pokefirered/include/constants/global.h:77
const MAX_MON_MOVES = 4;
// pokefirered/include/constants/species.h:421
const SPECIES_EGG = 412;
// pokefirered/include/constants/party_menu.h:30 (MoveLearn.TUTOR_MOVE_*)
const TUTOR_MOVE_FRENZY_PLANT = 15;
const TUTOR_MOVE_BLAST_BURN = 16;
const TUTOR_MOVE_HYDRO_CANNON = 17;

interface CapeBrinkRow { species: number; tutor: number; move: number; flag: number }

// Lua: move_learn.lua:16
function learned_moves(mon: any): LuaTable {
  const out: LuaTable = seq();
  for (let i = 1; i <= MAX_MON_MOVES; i++) {
    out[i] = tonumber(Pokemon.moveIdAt(mon, i)) ?? 0;
  }
  return out;
}

// Lua: move_learn.lua:24
function contains(list: LuaTable, n: number, value: unknown): boolean {
  for (let i = 1; i <= n; i++) {
    if (list[i] === value) return true;
  }
  return false;
}

const SLOT_ARRAYS = seq("moves", "pp", "maxPp", "moveIds", "ppBonuses", "ppBonus", "ppUp");

// Lua: move_learn.lua:65
function packed_bonus(mon: any, slot: number): number | undefined {
  if (typeof mon.ppBonusesPacked !== "number") return undefined;
  return (mon.ppBonusesPacked >>> ((slot - 1) * 2)) & 3;
}

// Lua: move_learn.lua:70
function set_packed_bonus(mon: any, slot: number, value: number | undefined): void {
  if (typeof mon.ppBonusesPacked !== "number") return;
  const shift = (slot - 1) * 2;
  const packed = mon.ppBonusesPacked & ~(3 << shift);
  mon.ppBonusesPacked = packed | (((value ?? 0) & 3) << shift);
}

// Lua: move_learn.lua:78 -- pokefirered/src/party_menu_specials.c:70 ShiftMoveSlot
function shift_slot(mon: any, slotTo: number, slotFrom: number): void {
  for (const [, key] of ipairs<string>(SLOT_ARRAYS)) {
    const t = mon[key];
    if (t !== null && typeof t === "object") {
      const a = t[slotFrom], b = t[slotTo];
      t[slotTo] = a; t[slotFrom] = b;
    }
  }
  const a = packed_bonus(mon, slotTo), b = packed_bonus(mon, slotFrom);
  if (a != null || b != null) {
    set_packed_bonus(mon, slotTo, b);
    set_packed_bonus(mon, slotFrom, a);
  }
}

// pokefirered/src/field_specials.c:2213 sCapeBrinkCompatibleSpecies
// (Lua keys 0..2: a JS array whose slot 0 is used)
const CAPE_BRINK: CapeBrinkRow[] = [
  { species: 3, tutor: TUTOR_MOVE_FRENZY_PLANT, move: 338, flag: 0x2DE },
  { species: 6, tutor: TUTOR_MOVE_BLAST_BURN, move: 307, flag: 0x2DF },
  { species: 9, tutor: TUTOR_MOVE_HYDRO_CANNON, move: 308, flag: 0x2E0 },
];

// Lua: move_learn.lua:132
function cache_root(): string {
  // Lua: pcall(require, "src.core.game3.dataset") -- always loads here
  if (Dataset && Dataset.mountExtractRoots) {
    Dataset.mountExtractRoots();
  }
  // Lua: (okE and Extract and Extract.CACHE_ROOT) or "data/generated/gba"
  return CachePaths.CACHE_ROOT || "data/generated/gba";
}

// Lua: move_learn.lua:141
function read_cache_lua(rel: string, short: string): any {
  let content: string | undefined;
  if (Dataset && Dataset.cache) {
    const cache = Dataset.cache();
    if (truthy(cache) && cache.read) {
      content = cache.read(rel) ?? cache.read(short);
    }
  }
  if (!truthy(content)) {
    // Lua: pcall(require, "src.import.CacheFs")
    if (CacheFs && CacheFs.readActive) {
      content = CacheFs.readActive(rel) ?? CacheFs.readActive(short);
    }
  }
  if (!truthy(content)) {
    // love.filesystem.read
    content = Fs.read(rel) ?? Fs.read(short);
  }
  if (!truthy(content)) {
    // NOT FAITHFUL: io.open(rel, "r") -- no stdio on the 3DS; Fs.read
    // (already tried above) is the only filesystem.
    content = Fs.read(rel);
  }
  if (!truthy(content)) return undefined;
  const [chunk] = luaLoad(content, "@" + rel);
  if (!chunk) return undefined;
  try {
    const res = chunk();
    if (res !== null && typeof res === "object") return res;
  } catch {
    // Lua: pcall failed
  }
  return undefined;
}

// Lua: move_learn.lua:182
function tutor_pack(): any {
  if (MoveLearn._tutorLoaded) return MoveLearn._tutorPack;
  MoveLearn._tutorLoaded = true;
  const root = cache_root() + "/pokemon";
  MoveLearn._tutorPack = read_cache_lua(root + "/tutor.lua", "pokemon/tutor.lua");
  return MoveLearn._tutorPack;
}

// Lua: move_learn.lua:202
function cape_brink(): CapeBrinkRow[] | Record<string, never> {
  return Profile.has(undefined, "sevii") ? CAPE_BRINK : {};
}

export const MoveLearn = {
  MAX_LEVEL_UP_MOVES,

  /** pokefirered/src/pokemon.c:5741 */
  // Lua: move_learn.lua:32
  relearnableMoves(mon: any): LuaTable {
    const moves: LuaTable = seq();
    if (!truthy(mon)) return moves;
    const species = Pokemon.speciesOf(mon);
    if (!truthy(species) || species === SPECIES_EGG) return moves;
    const level = tonumber(mon.level) ?? 0;
    const known = learned_moves(mon);
    const set = Pokemon.learnset(species);
    let count = 0;
    for (let i = 1; i <= MAX_LEVEL_UP_MOVES; i++) {
      const entry = set[i];
      if (!truthy(entry)) break;
      const lv = tonumber(truthy(entry[1]) ? entry[1] : entry.level) ?? 0;
      const mv = tonumber(truthy(entry[2]) ? entry[2] : entry.move) ?? 0;
      if (mv > 0 && lv <= level) {
        if (!contains(known, MAX_MON_MOVES, mv) && !contains(moves, count, mv)) {
          count = count + 1;
          moves[count] = mv;
        }
      }
    }
    return moves;
  },

  /** pokefirered/src/pokemon.c:5791 */
  // Lua: move_learn.lua:57
  countRelearnableMoves(mon: any): number {
    if (!truthy(mon)) return 0;
    if (Pokemon.isEgg(mon)) return 0;
    return len(MoveLearn.relearnableMoves(mon));
  },

  /** pokefirered/src/party_menu_specials.c:92 MoveDeleterForgetMove */
  // Lua: move_learn.lua:91
  forgetMove(mon: any, slotIn: unknown): boolean {
    const slot = tonumber(slotIn);
    if (!truthy(mon) || slot === undefined || slot < 0 || slot >= MAX_MON_MOVES) return false;
    const i = slot + 1;
    if (!truthy(Pokemon.moveIdAt(mon, i))) return false;
    for (const [, key] of ipairs<string>(SLOT_ARRAYS)) {
      const t = mon[key];
      if (t !== null && typeof t === "object") t[i] = null;
    }
    // pokefirered/src/pokemon.c:3904 RemoveMonPPBonus
    set_packed_bonus(mon, i, 0);
    for (let j = i; j <= MAX_MON_MOVES - 1; j++) {
      shift_slot(mon, j, j + 1);
    }
    return true;
  },

  // pokefirered/include/constants/party_menu.h:28
  TUTOR_MOVE_COUNT: 15,
  // pokefirered/include/constants/party_menu.h:30
  TUTOR_MOVE_FRENZY_PLANT,
  TUTOR_MOVE_BLAST_BURN,
  TUTOR_MOVE_HYDRO_CANNON,

  // pokefirered/src/party_menu.c:91
  CAN_LEARN_MOVE: 0,
  CANNOT_LEARN_MOVE: 1,
  ALREADY_KNOWS_MOVE: 2,
  CANNOT_LEARN_MOVE_IS_EGG: 3,

  CAPE_BRINK,
  // pokefirered/include/constants/flags.h:764
  FLAG_LEARNED_ALL_MOVES_AT_CAPE_BRINK: 0x2E1,

  _tutorPack: undefined as any,
  _tutorLoaded: false,

  // Lua: move_learn.lua:177
  resetTutorPack(): void {
    MoveLearn._tutorPack = undefined;
    MoveLearn._tutorLoaded = false;
  },

  // Lua: move_learn.lua:191 -- pokefirered/src/data/pokemon/tutor_learnsets.h:22 sTutorLearnsets
  tutorLearnsets(): any {
    const pack = tutor_pack();
    return truthy(pack) ? pack.learnsets : undefined;
  },

  // Lua: move_learn.lua:197 -- pokefirered/src/data/pokemon/tutor_learnsets.h:1 sTutorMoves
  tutorMoves(): any {
    const pack = tutor_pack();
    return truthy(pack) ? pack.moves : undefined;
  },

  // Lua: move_learn.lua:208 -- pokeemerald/src/data/pokemon/tutor_learnsets.h:1
  tutorMoveCount(): number {
    const moves = MoveLearn.tutorMoves();
    if (!truthy(moves)) return MoveLearn.TUTOR_MOVE_COUNT;
    let n = 0;
    while (moves[n] != null) n = n + 1;
    return n;
  },

  /** pokefirered/src/party_menu.c:1892 GetTutorMove */
  // Lua: move_learn.lua:217
  tutorMove(tutorIn: unknown): number | undefined {
    const tutor = tonumber(tutorIn);
    if (tutor === undefined) return undefined;
    for (const [, row] of pairs<CapeBrinkRow>(cape_brink())) {
      if (row.tutor === tutor) return row.move;
    }
    if (tutor < 0 || tutor >= MoveLearn.tutorMoveCount()) return undefined;
    const moves = MoveLearn.tutorMoves();
    return truthy(moves) && truthy(moves[tutor]) ? moves[tutor] : undefined;
  },

  /** pokefirered/src/party_menu.c:1907 CanLearnTutorMove */
  // Lua: move_learn.lua:229
  canLearnTutorMove(speciesIn: unknown, tutorIn: unknown): boolean {
    const species = tonumber(speciesIn);
    const tutor = tonumber(tutorIn);
    if (species === undefined || tutor === undefined) return false;
    for (const [, row] of pairs<CapeBrinkRow>(cape_brink())) {
      if (row.tutor === tutor) return species === row.species;
    }
    if (tutor < 0 || tutor >= MoveLearn.tutorMoveCount()) return false;
    const sets = MoveLearn.tutorLearnsets();
    const bits = truthy(sets) ? tonumber(sets[species]) : undefined;
    if (bits === undefined) return false;
    return Math.floor(bits / Math.pow(2, tutor)) % 2 === 1;
  },

  /** pokefirered/src/party_menu.c:1867 CanMonLearnTMTutor, item 0 */
  // Lua: move_learn.lua:244
  canMonLearnTutorMove(mon: any, tutor: unknown): number {
    if (!truthy(mon)) return MoveLearn.CANNOT_LEARN_MOVE;
    if (Pokemon.isEgg(mon)) return MoveLearn.CANNOT_LEARN_MOVE_IS_EGG;
    const species = Pokemon.speciesOf(mon);
    if (!MoveLearn.canLearnTutorMove(species, tutor)) return MoveLearn.CANNOT_LEARN_MOVE;
    const move = MoveLearn.tutorMove(tutor);
    if (!truthy(move)) return MoveLearn.CANNOT_LEARN_MOVE;
    if (Pokemon.knowsMove(mon, move)) return MoveLearn.ALREADY_KNOWS_MOVE;
    return MoveLearn.CAN_LEARN_MOVE;
  },

  /** pokefirered/src/field_specials.c:510 GetLeadMonIndex */
  // Lua: move_learn.lua:256
  leadMonIndex(party: any): number {
    if (party === null || typeof party !== "object") return 0;
    for (let i = 1; i <= len(party); i++) {
      const mon = party[i];
      const species = truthy(mon) ? Pokemon.speciesOf(mon) : undefined;
      if (truthy(species) && species !== 0 && species !== SPECIES_EGG && !Pokemon.isEgg(mon)) {
        return i - 1;
      }
    }
    return 0;
  },

  /** pokefirered/src/field_specials.c:2219 CapeBrinkGetMoveToTeachLeadPokemon */
  // Lua: move_learn.lua:269
  capeBrinkRow(mon: any): CapeBrinkRow | undefined {
    if (!truthy(mon)) return undefined;
    const species = Pokemon.isEgg(mon) ? SPECIES_EGG : Pokemon.speciesOf(mon);
    for (let i = 0; i <= 2; i++) {
      if (CAPE_BRINK[i]!.species === species) {
        if ((tonumber(Pokemon.friendshipOf(mon)) ?? 0) !== 255) return undefined;
        return CAPE_BRINK[i];
      }
    }
    return undefined;
  },
};

export default MoveLearn;
