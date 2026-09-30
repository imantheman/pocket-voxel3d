// gen1recomp src/core/gen2/Unown.lua at bdfac727 (MIT): the letter a set of
// DVs spells, which letters the Ruins of Alph have unlocked, and the #DEX's
// catching-order list of them.
//
//   GetUnownLetter          engine/gfx/load_pics.asm
//   CheckUnownLetter        engine/battle/core.asm
//   UnlockedUnownLetterSets data/wild/unlocked_unowns.asm
//   UpdateUnownDex          engine/pokedex/unown_dex.asm (wUnownDex)
//   PrintUnownWord          engine/pokedex/unown_dex.asm
//   CountUnown              engine/events/specials.asm
//
// Letters are NUMBERS, 1 = A .. 26 = Z (what the cart stores); `Unown.name`
// is the only place a number becomes a character. save.unownDex is a 0-based
// JS array of letter numbers in first-caught order. `engineFlags` is keyed
// by ENGINE_* index (an object with numeric keys).

import { Runtime } from "../shared/mods/Runtime.ts";
import { sub, truthy } from "../platform/lua.ts";

type SaveLike = Record<string, any> | null | undefined;

/** A mon's four DVs, as Mon keeps them. */
export interface UnownDVs {
  attack: number;
  defense: number;
  speed: number;
  special: number;
}

export interface UnlockSet {
  flag: number;
  name: string;
  first: number;
  last: number;
}

export interface UnownPuzzle {
  id: string;
  flag: number;
  event: string;
}

type EngineFlags = Record<number, unknown> | null | undefined;

// Lua: Unown.lua:27-31
const NUM_UNOWN = 26;
const SPECIES = "UNOWN";
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

// Lua: Unown.lua:52-67 -- GetUnownLetter takes the MIDDLE two bits of each
// DV, packs atk,def,spd,spc, then divides by 10 ($ff / 26, truncated) + 1.
function middleBits(dv: number | undefined): number {
  return Math.floor((dv ?? 0) / 2) % 4;
}

// Lua: Unown.lua:167 -- the capped retries of LoadEnemyMon's .GenerateDVs.
const DV_RETRIES = 256;

export const Unown = {
  NUM_UNOWN,
  SPECIES,
  ALPHABET,
  // Lua: Unown.lua:92-96 -- the flag that gates the #DEX's UNOWN MODE.
  ENGINE_UNOWN_DEX: 12,

  // Lua: Unown.lua:83-103 -- data/wild/unlocked_unowns.asm; ENGINE_* indices.
  UNLOCK_SETS: [
    { flag: 42, name: "ENGINE_UNLOCKED_UNOWNS_A_TO_K", first: 1, last: 11 },
    { flag: 43, name: "ENGINE_UNLOCKED_UNOWNS_L_TO_R", first: 12, last: 18 },
    { flag: 44, name: "ENGINE_UNLOCKED_UNOWNS_S_TO_W", first: 19, last: 23 },
    { flag: 45, name: "ENGINE_UNLOCKED_UNOWNS_X_TO_Z", first: 24, last: 26 },
  ] as UnlockSet[],

  // Lua: Unown.lua:105-115 -- UNOWNPUZZLE_* order, indexed from 0 as the
  // script's setval passes it.
  PUZZLES: [
    { id: "KABUTO", flag: 42, event: "EVENT_SOLVED_KABUTO_PUZZLE" },
    { id: "OMANYTE", flag: 43, event: "EVENT_SOLVED_OMANYTE_PUZZLE" },
    { id: "AERODACTYL", flag: 44, event: "EVENT_SOLVED_AERODACTYL_PUZZLE" },
    { id: "HO_OH", flag: 45, event: "EVENT_SOLVED_HO_OH_PUZZLE" },
  ] as UnownPuzzle[],

  // Lua: Unown.lua:272-282 -- data/pokemon/unown_words.asm (letter n at
  // WORDS[n - 1]). X really is "XXXXX".
  WORDS: [
    "ANGRY", "BEAR", "CHASE", "DIRECT", "ENGAGE", "FIND", "GIVE", "HELP",
    "INCREASE", "JOIN", "KEEP", "LAUGH", "MAKE", "NUZZLE", "OBSERVE", "PERFORM",
    "QUICKEN", "REASSURE", "SEARCH", "TELL", "UNDO", "VANISH", "WANT", "XXXXX",
    "YIELD", "ZOOM",
  ] as string[],

  // Lua: Unown.lua:33-39 -- 1 -> "A"; out of range -> undefined.
  name(letter: unknown): string | undefined {
    if (typeof letter !== "number") return undefined;
    if (letter < 1 || letter > NUM_UNOWN) return undefined;
    return sub(ALPHABET, letter, letter);
  },

  // Lua: Unown.lua:41-48 -- "A" -> 1; a number passes straight through.
  index(letter: unknown): number | undefined {
    if (typeof letter === "number") return letter;
    if (typeof letter !== "string" || letter.length !== 1) return undefined;
    const at = ALPHABET.indexOf(letter.toUpperCase());
    return at < 0 ? undefined : at + 1;
  },

  // Lua: Unown.lua:69-81 -- no DVs is a caller bug, not a letter A.
  letterFromDVs(dvs: Partial<UnownDVs> | null | undefined): number | undefined {
    if (dvs == null) return undefined;
    const packed = middleBits(dvs.attack) * 64
      + middleBits(dvs.defense) * 16
      + middleBits(dvs.speed) * 4
      + middleBits(dvs.special);
    return Math.floor(packed / 10) + 1;
  },

  // Lua: Unown.lua:117-130 -- CheckUnownLetter (sense flipped: true = unlocked).
  letterUnlocked(letter: unknown, engineFlags: EngineFlags): boolean {
    const index = Unown.index(letter);
    if (index === undefined) return false;
    for (const set of Unown.UNLOCK_SETS) {
      if (engineFlags && truthy(engineFlags[set.flag])) {
        if (index >= set.first && index <= set.last) return true;
      }
    }
    return false;
  },

  // Lua: Unown.lua:132-142 -- `ld a, [wUnlockedUnowns] / and a`.
  anyUnlocked(engineFlags: EngineFlags): boolean {
    if (!engineFlags) return false;
    for (const set of Unown.UNLOCK_SETS) {
      if (truthy(engineFlags[set.flag])) return true;
    }
    return false;
  },

  // Lua: Unown.lua:144-156 -- every reachable letter, ascending.
  unlockedLetters(engineFlags: EngineFlags): number[] {
    const out: number[] = [];
    for (const set of Unown.UNLOCK_SETS) {
      if (engineFlags && truthy(engineFlags[set.flag])) {
        for (let letter = set.first; letter <= set.last; letter++) out.push(letter);
      }
    }
    out.sort((a, b) => a - b);
    return out;
  },

  // Lua: Unown.lua:158-181 -- LoadEnemyMon's .GenerateDVs: reroll while the
  // letter is locked (capped; then an unlocked letter directly).
  // `randomDVs` is Mon.randomDVs.
  wildDVs(engineFlags: EngineFlags, randomDVs: () => UnownDVs): UnownDVs {
    let dvs = randomDVs();
    if (!Unown.anyUnlocked(engineFlags)) return dvs;
    let tries = 0;
    while (!Unown.letterUnlocked(Unown.letterFromDVs(dvs), engineFlags)) {
      tries++;
      if (tries >= DV_RETRIES) {
        return Unown.dvsForLetter(Unown.unlockedLetters(engineFlags)[0] ?? 1);
      }
      dvs = randomDVs();
    }
    return dvs;
  },

  // Lua: Unown.lua:183-199 -- the inverse of GetUnownLetter: the lowest
  // packed value in the letter's band, middle bits only.
  dvsForLetter(letter: unknown): UnownDVs {
    const index = Unown.index(letter) ?? 1;
    const packed = (index - 1) * 10;
    const dv = (shift: number): number => (Math.floor(packed / shift) % 4) * 2;
    return {
      attack: dv(64),
      defense: dv(16),
      speed: dv(4),
      special: dv(1),
    };
  },

  // Lua: Unown.lua:201-210 -- wUnownDex (save.unownDex).
  dex(save: SaveLike): number[] {
    if (!truthy(save)) return [];
    const s = save as Record<string, any>;
    if (!truthy(s.unownDex)) s.unownDex = [];
    return s.unownDex;
  },

  // Lua: Unown.lua:212-240 -- UpdateUnownDex: a listed letter returns at
  // once; a new one is appended. unown.unlocked fires once per letter.
  updateDex(save: SaveLike, letter: unknown): boolean {
    const index = Unown.index(letter);
    if (!(truthy(save) && index !== undefined)) return false;
    const list = Unown.dex(save);
    for (const seen of list) {
      if (seen == null) break;
      if (seen === index) return false;
    }
    if (list.length >= NUM_UNOWN) return false;
    list.push(index);
    if (Runtime.wants("unown.unlocked")) {
      Runtime.emit("unown.unlocked", {
        letter: index, name: Unown.name(index), word: Unown.word(index),
        count: list.length,
      });
    }
    return true;
  },

  // Lua: Unown.lua:242-249
  caught(save: SaveLike, letter: unknown): boolean {
    const index = Unown.index(letter);
    if (index === undefined) return false;
    for (const seen of Unown.dex(save)) {
      if (seen == null) break;
      if (seen === index) return true;
    }
    return false;
  },

  // Lua: Unown.lua:251-263 -- AddPartyMon / SendMonIntoBox's
  // GetUnownLetter + UpdateUnownDex; non-Unown falls through.
  registerCatch(save: SaveLike, mon: any): boolean {
    const letter = Unown.monLetter(mon);
    if (!(truthy(save) && letter !== undefined)) return false;
    return Unown.updateDex(save, letter);
  },

  // Lua: Unown.lua:265-270 -- CountUnown (also VAR_UNOWNCOUNT).
  count(save: SaveLike): number {
    return Unown.dex(save).length;
  },

  // Lua: Unown.lua:284-287
  word(letter: unknown): string | undefined {
    const index = Unown.index(letter);
    return index !== undefined ? Unown.WORDS[index - 1] ?? undefined : undefined;
  },

  // Lua: Unown.lua:289-296 -- the stored form first, else the DVs.
  monLetter(mon: any): number | undefined {
    if (!truthy(mon) || mon.species !== SPECIES) return undefined;
    if (truthy(mon.unownLetter)) return Unown.index(mon.unownLetter);
    return Unown.letterFromDVs(mon.dvs);
  },

  // Lua: Unown.lua:298-308 -- pokemon.json UNOWN's `letters.A .. letters.Z`.
  forms(pokemon: any): Record<string, any> | undefined {
    const def = pokemon ? pokemon[SPECIES] : undefined;
    return def ? def.letters ?? undefined : undefined;
  },

  // Lua: Unown.lua:310-326 -- a letter's front (or back) pic; no letter ->
  // undefined, never letter A. A cache without `letters` degrades to the
  // species' own pics.
  formSprite(pokemon: any, letter: unknown, back?: unknown): any {
    const def = pokemon ? pokemon[SPECIES] : undefined;
    if (!def) return undefined;
    const index = Unown.index(letter);
    if (index === undefined) return undefined;
    const name = Unown.name(index);
    const form = def.letters && name !== undefined ? def.letters[name] : undefined;
    if (form) {
      return truthy(back) && truthy(form.spriteBack) ? form.spriteBack : form.spriteFront;
    }
    return truthy(back) && truthy(def.spriteBack) ? def.spriteBack : def.spriteFront;
  },
};

export default Unown;
