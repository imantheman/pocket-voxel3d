// Port of gen1recomp RomExtractorGen2.lua:1722-2042 (bdfac727):
// readEvosAttacks (:1743) and extractPokemon (:1798) -- base data, names,
// evolutions and learnsets, egg moves, TM/HM learnsets, growth rates, front
// and back pics, and the 26 Unown letters. The pic-animation readers live in
// monanim.ts (none of them fire on Gold; see there).
//
// Not here: the EGG pic ("battle/front/egg") is written by Brian's
// extractMenuGfx (:6139), not by extractPokemon, and pokemon.json has no EGG
// row (EGG has no BaseData row either).

import type { Gen2Ctx } from "./ctx.ts";
import { columnsToRows, gfxKey, lua, picBank, speciesName, write2bpp, writeCompressedPic } from "./helpers.ts";
import { decompressLz3 } from "./lz.ts";
import { type MonAnimData, monAnimTables, tryMonAnimation } from "./monanim.ts";

/** :69 — every Gen 2 back pic is 6x6 tiles; only fronts vary. */
export const BACK_PIC_TILES = 6;
/** :123 — constants/item_constants.asm NUM_TM_HM (50 TMs + 7 HMs). */
export const NUM_TM_HM = 57;
/** :1736 — evolution method bytes (constants/pokemon_data_constants.asm). */
const EVOLVE_LEVEL = 1;
const EVOLVE_ITEM = 2;
const EVOLVE_TRADE = 3;
const EVOLVE_HAPPINESS = 4;
const EVOLVE_STAT = 5;
/** :1742 — TR_* (1-based, const_def 1). */
const TR_NAMES = ["ANYTIME", "MORNDAY", "NITE"];
/** :1745 — ATK_*_DEF in ROM order (1-based). */
const ATK_NAMES = ["ATK_GT_DEF", "ATK_LT_DEF", "ATK_EQ_DEF"];

/** One evolutions row. `method` is the EVOLVE_* name, or the raw byte for
 * an unknown method (then `parameter` carries its byte). */
export interface Evolution {
  method: string | number;
  into: string | number;
  level?: number;
  item?: string;
  time?: string;
  comparison?: string;
  parameter?: number;
}

export interface LevelMove {
  level: number;
  move: string | number;
}

/**
 * A Lua table constructor `{ a, b, ... }` as JSON per the brief: a dense
 * 1..n sequence becomes an array (trailing nils dropped), one with a hole
 * becomes an object keyed by the 1-based index, as LuaWriter's isArray
 * decides.
 */
export function luaSeq<T>(values: (T | undefined)[]): T[] | Record<string, T> {
  let length = values.length;
  while (length > 0 && values[length - 1] === undefined) length -= 1;
  const dense = values.slice(0, length);
  if (dense.every((value) => value !== undefined)) return dense as T[];
  const out: Record<string, T> = {};
  dense.forEach((value, i) => {
    if (value !== undefined) out[String(i + 1)] = value;
  });
  return out;
}

/**
 * RomExtractorGen2.lua:1750 readEvosAttacks — 3-byte evolution rows (4 for
 * EVOLVE_STAT: level, ATK_*_DEF, species) up to a 0, then (level, move)
 * pairs up to a 0. Species/item/move names come from the 1-based manifest
 * order lists; an unnamed move stays its number.
 */
export function readEvosAttacks(
  ctx: Gen2Ctx,
  bank: number,
  address: number,
): { evolutions: Evolution[]; levelMoves: LevelMove[] } {
  const { rom } = ctx;
  const moveOrder = (ctx.manifest.constants.moveOrder as string[] | undefined) ?? [];
  const itemOrder = (ctx.manifest.constants.itemOrder as string[] | undefined) ?? [];
  const evolutions: Evolution[] = [];
  const levelMoves: LevelMove[] = [];
  let pc = address;
  for (let n = 0; n < 16; n++) {
    const method = rom.byte(bank, pc);
    if (method === 0) {
      pc += 1;
      break;
    }
    if (method === EVOLVE_STAT) {
      const row: Evolution = {
        method: "EVOLVE_STAT",
        level: rom.byte(bank, pc + 1),
        into: speciesName(ctx, rom.byte(bank, pc + 3)),
      };
      const comparison = lua(ATK_NAMES, rom.byte(bank, pc + 2));
      if (comparison !== undefined) row.comparison = comparison;
      evolutions.push(row);
      pc += 4;
    } else {
      const parameter = rom.byte(bank, pc + 1);
      const row: Evolution = { method, into: speciesName(ctx, rom.byte(bank, pc + 2)) };
      const set = <K extends keyof Evolution>(key: K, value: Evolution[K] | undefined) => {
        if (value !== undefined) row[key] = value;
      };
      if (method === EVOLVE_LEVEL) {
        row.method = "EVOLVE_LEVEL";
        row.level = parameter;
      } else if (method === EVOLVE_ITEM) {
        row.method = "EVOLVE_ITEM";
        set("item", lua(itemOrder, parameter));
      } else if (method === EVOLVE_TRADE) {
        row.method = "EVOLVE_TRADE";
        // :1780 — $ff means "no held item required".
        if (parameter !== 0xff) set("item", lua(itemOrder, parameter));
      } else if (method === EVOLVE_HAPPINESS) {
        row.method = "EVOLVE_HAPPINESS";
        set("time", lua(TR_NAMES, parameter));
      } else {
        row.parameter = parameter;
      }
      evolutions.push(row);
      pc += 3;
    }
  }
  for (let n = 0; n < 64; n++) {
    const level = rom.byte(bank, pc);
    if (level === 0) break;
    const move = rom.byte(bank, pc + 1);
    levelMoves.push({ level, move: lua(moveOrder, move) ?? move });
    pc += 2;
  }
  return { evolutions, levelMoves };
}

/** :2009 — an lz3 pic at a far pointer. GetLZByte rolls into the next
 * bank at $8000, so the source runs on through bank+1. */
function lz3Stream(ctx: Gen2Ctx, bank: number, address: number): number[] {
  const compressed = ctx.toBankEnd(bank, address);
  for (const byte of ctx.rom.bytes(bank + 1, 0x4000, 0x4000)) compressed.push(byte);
  return decompressLz3(compressed);
}

interface PokemonAsset {
  front?: string | null;
  frontLabel?: string | null;
  back?: string | null;
  backLabel?: string | null;
  animLabel?: string | null;
  framesLabel?: string | null;
  bitmaskLabel?: string | null;
  idleLabel?: string | null;
}

/**
 * RomExtractorGen2.lua:1798 extractPokemon. Returns { pokemon: <pokemon.json> }:
 * - growthRates: {GROWTH_X: {id, index (0-based), numerator, denominator,
 *   squared (signed), linear, constant}};
 * - tmhmMoves: [move names] (element n-1 = TM/HM number n); tutorMoves only
 *   when the ROM has any (Crystal) -- never on Gold;
 * - SPECIES (all 251, keyed by name): {id, index, dex (1-based dex number),
 *   name, source "ROM:BaseData[n]", baseStats {hp, attack, defense, speed,
 *   specialAttack, specialDefense}, types [2], catchRate, baseExp,
 *   items (luaSeq of 2: [] / ["X"] / {"2": "X"} when a slot is NO_ITEM),
 *   genderRatio, eggSteps, picSize (tiles), growthRateId, growthRate,
 *   eggGroups (luaSeq of 2), eggGroupsRaw, tmhmRaw [8 bytes], tmhm [moves],
 *   tutorMoves?, evolutions [Evolution], levelMoves [LevelMove],
 *   eggMoves [moves], spriteFront? / spriteBack? (gfx keys
 *   "battle/front/<front>" tiles*8 square and "battle/back/<back>" 48x48,
 *   white backdrop matted transparent), anim? (never on Gold)};
 * - UNOWN additionally: letters {"A".."Z": {spriteFront?, spriteBack?,
 *   anim?}} with keys "battle/front/unown_<l>" / "battle/back/unown_<l>",
 *   and spriteFront/spriteBack = letter A's. Brian saves the letters with
 *   write2bpp, i.e. NOT matted (opaque white backdrop), unlike every other
 *   pic -- kept as he has it.
 */
export function extractPokemon(ctx: Gen2Ctx): Record<string, unknown> {
  const { rom } = ctx;
  const consts = ctx.manifest.constants;
  const speciesOrder = consts.speciesOrder;
  const typeById = new Map<number, string>();
  for (const [name, value] of Object.entries((consts.types as Record<string, number> | undefined) ?? {})) {
    typeById.set(value, name);
  }
  const baseData = ctx.symbol("BaseData");
  const names = ctx.symbol("PokemonNames");
  const evos = ctx.symbol("EvosAttacksPointers");
  const growthRates = ctx.symbol("GrowthRates");
  const tmhmMoves = ctx.symbol("TMHMMoves");
  const eggMovePointers = ctx.location("EggMovePointers") ? ctx.symbol("EggMovePointers") : undefined;
  const growthOrder = (consts.growthRateOrder as string[] | undefined) ?? [];
  const eggGroupOrder = (consts.eggGroupOrder as string[] | undefined) ?? [];
  const moveOrder = (consts.moveOrder as string[] | undefined) ?? [];
  const itemOrder = (consts.itemOrder as string[] | undefined) ?? [];
  const moveName = (id: number): string | number => lua(moveOrder, id) ?? id;

  // :1815 TMHMMoves: TM/HM number -> move, 0-terminated; numbers past
  // NUM_TM_HM are Crystal's tutors.
  const tmhmList: (string | number)[] = [];
  const tutorList: (string | number)[] = [];
  for (let i = 0; i < 64; i++) {
    const moveId = rom.byte(tmhmMoves.bank, tmhmMoves.address + i);
    if (moveId === 0) break;
    if (i + 1 > NUM_TM_HM) tutorList.push(moveName(moveId));
    tmhmList.push(moveName(moveId));
  }

  // :1831 GrowthRates rows: dn numerator, denominator; n^2 term with a $80
  // sign bit; n term; constant.
  const growth: Record<string, unknown> = {};
  growthOrder.forEach((name, i) => {
    const base = growthRates.address + i * 4;
    const packed = rom.byte(growthRates.bank, base);
    const squared = rom.byte(growthRates.bank, base + 1);
    growth[name] = {
      id: name,
      index: i,
      numerator: packed >> 4,
      denominator: packed & 15,
      squared: squared >= 0x80 ? -(squared - 0x80) : squared,
      linear: rom.byte(growthRates.bank, base + 2),
      constant: rom.byte(growthRates.bank, base + 3),
    };
  });

  const out: Record<string, unknown> = { growthRates: growth, tmhmMoves: tmhmList };
  if (tutorList.length > 0) out.tutorMoves = tutorList;
  const animTables = monAnimTables(ctx, false);
  const assets = ctx.manifest.pokemonAssets as Record<string, PokemonAsset | undefined>;

  for (let i = 0; i < speciesOrder.length; i++) {
    const species = speciesOrder[i];
    if (!species) continue;
    const index = i + 1; // the dex number
    // row[k] (Lua, 1-based) = bytes[k - 1] here.
    const row = rom.bytes(baseData.bank, baseData.address + i * 32, 32);
    if (row[0] !== index) throw new Error(`${species}: base data dex mismatch`);
    const name = rom.decodeText(rom.bytes(names.bank, names.address + i * 10, 10), ctx.manifest.charmap);

    const asset = assets[species];
    const tiles = row[17]! & 15; // BASE_PIC_SIZE low nibble
    let front: string | undefined;
    let back: string | undefined;
    let anim: MonAnimData | undefined;
    if (asset?.frontLabel && asset.front) {
      const stream = writeCompressedPic(ctx, asset.frontLabel, tiles, `battle/front/${asset.front}.png`);
      front = asset.front;
      if (animTables && asset.animLabel && asset.framesLabel && asset.bitmaskLabel && asset.idleLabel) {
        anim = tryMonAnimation(ctx, animTables, index, tiles, stream, asset.front);
      }
    }
    if (asset?.backLabel && asset.back) {
      // :1874 — backs are always 6x6, whatever the front's size.
      writeCompressedPic(ctx, asset.backLabel, BACK_PIC_TILES, `battle/back/${asset.back}.png`);
      back = asset.back;
    }

    // :1887 — plain dw pointers into the table's own bank.
    const evoAddress = rom.word(evos.bank, evos.address + i * 2);
    const { evolutions, levelMoves } = readEvosAttacks(ctx, evos.bank, evoAddress);

    // :1893 — egg moves up to $ff (NoEggMoves = empty list, not absent).
    const eggMoves: (string | number)[] = [];
    if (eggMovePointers) {
      const listAddr = rom.word(eggMovePointers.bank, eggMovePointers.address + i * 2);
      for (let offset = 0; offset < 16; offset++) {
        const move = rom.byte(eggMovePointers.bank, listAddr + offset);
        if (move === 0xff) break;
        eggMoves.push(moveName(move));
      }
    }

    // :1911 — BASE_TMHM bit i of byte n = TM/HM number n*8 + i + 1.
    const tmhmRaw = row.slice(24, 32);
    const tmhm: (string | number)[] = [];
    const tutorMoves: (string | number)[] = [];
    tmhmRaw.forEach((byteValue, byteIndex) => {
      for (let bit = 0; bit < 8; bit++) {
        if ((byteValue >> bit) & 1) {
          const number = byteIndex * 8 + bit + 1;
          const move = tmhmList[number - 1];
          if (move !== undefined && number > NUM_TM_HM) tutorMoves.push(move);
          else if (move !== undefined) tmhm.push(move);
        }
      }
    });

    const entry: Record<string, unknown> = {
      id: species,
      index,
      dex: index,
      name,
      source: `ROM:BaseData[${index}]`,
      baseStats: {
        hp: row[1],
        attack: row[2],
        defense: row[3],
        speed: row[4],
        specialAttack: row[5],
        specialDefense: row[6],
      },
      types: [typeById.get(row[7]!) ?? row[7]!, typeById.get(row[8]!) ?? row[8]!],
      catchRate: row[9],
      baseExp: row[10],
      items: luaSeq([lua(itemOrder, row[11]!), lua(itemOrder, row[12]!)]),
      // :1941 — a DV roll under it is female: 0 male-only, $fe female-only.
      genderRatio: row[13],
      eggSteps: row[15],
      picSize: tiles,
      growthRateId: row[22],
      growthRate: growthOrder[row[22]!],
      eggGroups: luaSeq([lua(eggGroupOrder, row[23]! >> 4), lua(eggGroupOrder, row[23]! & 15)]),
      eggGroupsRaw: row[23],
      tmhmRaw,
      tmhm,
      tutorMoves: tutorMoves.length > 0 ? tutorMoves : undefined,
      evolutions,
      levelMoves,
      eggMoves,
      spriteFront: front !== undefined ? gfxKey(`battle/front/${front}`) : undefined,
      spriteBack: back !== undefined ? gfxKey(`battle/back/${back}`) : undefined,
      anim,
    };
    for (const key of Object.keys(entry)) if (entry[key] === undefined) delete entry[key];
    out[species] = entry;
  }

  // :1983 UnownPicPointers: 26 `dba_pics front, back` rows (3-byte far
  // pointers); PokemonPicPointers' UNOWN row is only letter A.
  const unown = out.UNOWN as Record<string, unknown> | undefined;
  if (ctx.location("UnownPicPointers") && unown) {
    const symbol = ctx.symbol("UnownPicPointers");
    const letters: Record<string, Record<string, unknown>> = {};
    const tiles = (unown.picSize as number | undefined) ?? 6;
    const unownTables = monAnimTables(ctx, true);
    for (let index = 0; index < 26; index++) {
      const letter = String.fromCharCode(0x41 + index);
      const base = symbol.address + index * 6;
      const entry: Record<string, unknown> = {};
      let frontStream: number[] | undefined;
      const readPic = (offset: number, size: number, folder: string, key: string): void => {
        const bank = picBank(rom.byte(symbol.bank, base + offset));
        const address = rom.word(symbol.bank, base + offset + 1);
        const rel = `battle/${folder}/unown_${letter.toLowerCase()}.png`;
        try {
          const stream = lz3Stream(ctx, bank, address);
          if (key === "spriteFront") frontStream = stream;
          const pixelSize = size * 8;
          const byteLength = (pixelSize * pixelSize) / 4;
          const pixels: number[] = [];
          for (let p = 0; p < byteLength; p++) pixels.push(stream[p] ?? 0);
          // :2019 — write2bpp: saved opaque, not matted.
          write2bpp(ctx, columnsToRows(pixels, size, size), pixelSize, pixelSize, rel);
          entry[key] = gfxKey(rel);
        } catch {
          // :2023 — traced and skipped, like the Lua's pcall.
        }
      };
      readPic(0, tiles, "front", "spriteFront");
      readPic(3, BACK_PIC_TILES, "back", "spriteBack");
      if (unownTables && frontStream) {
        const result = tryMonAnimation(ctx, unownTables, index + 1, tiles, frontStream, `unown_${letter.toLowerCase()}`);
        if (result) entry.anim = result;
      }
      letters[letter] = entry;
    }
    unown.letters = letters;
    // :2036 — the species' own pics are letter A's (GetUnownLetter's default).
    unown.spriteFront ??= letters.A?.spriteFront;
    unown.spriteBack ??= letters.A?.spriteBack;
    unown.anim ??= letters.A?.anim;
    for (const key of ["spriteFront", "spriteBack", "anim"]) if (unown[key] === undefined) delete unown[key];
  }

  return { pokemon: out };
}
