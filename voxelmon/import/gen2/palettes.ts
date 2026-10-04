// Port of gen1recomp RomExtractorGen2.lua:346-883 (bdfac727): color/colors,
// battleObjectPals, specialTilesetPalettes (:714-746, Crystal only) and
// extractPalettes.
//
// engine/gfx/color.asm LoadMapPals is the overworld colour pipeline
// (RomExtractorGen2.lua:351-359): EnvironmentColorsPointers[env] gives 4
// daytime rows of 8 indices into the shared TilesetBGPalette pool;
// MapObjectPals[daytime] gives the 8 OBJ palettes; outdoors, RoofPals[group]
// overwrites PAL_BG_ROOF colours 1-2. Colours are 0-255 per channel, like
// Gen 1's palettes.

import type { Gen2Ctx } from "./ctx.ts";

/** RomExtractorGen2.lua:39 PAL_BG_* slot names (constants/tileset_constants.asm). */
export const PAL_BG_NAMES = ["GRAY", "RED", "GREEN", "WATER", "YELLOW", "BROWN", "ROOF", "TEXT"];
/** :42 — 0-based slot LoadMapPals overrides per map group. */
export const PAL_BG_ROOF = 6;
/** :45 — wTimeOfDayPal order. */
export const DAYTIMES = ["MORN", "DAY", "NITE", "DARK"];
/** :48 — gfx/tilesets/bg_tiles.pal, "Valid indices: $00 - $29". */
const BG_PALETTE_COUNT = 0x2a;
/** :50 — PAL_OW_* per daytime. */
const OW_PALETTE_COUNT = 8;
/** :52 — NUM_ENVIRONMENTS + 1 (row 0 unused). */
const ENV_POINTER_COUNT = 8;
/** :53 — constants/map_constants.asm NUM_MAP_GROUPS. */
export const MAP_GROUP_COUNT = 26;

export type Rgb = [number, number, number];

/** :714 — engine/tilesets/tileset_palettes.asm:1, the tilesets whose BG set
 * Crystal swaps for a palette of their own. */
const SPECIAL_TILESET_PALETTES: Record<string, string> = {
  TILESET_POKECOM_CENTER: "PokeComPalette",
  TILESET_BATTLE_TOWER_INSIDE: "BattleTowerInsidePalette",
  TILESET_ICE_PATH: "IcePathPalette",
  TILESET_HOUSE: "HousePalette",
  TILESET_RADIO_TOWER: "RadioTowerPalette",
  TILESET_MANSION: "MansionPalette1",
};
const PAL_BG_WATER = 3;
const PAL_BG_YELLOW = 4;

/** :723 specialTilesetPalettes — undefined on Gold and Silver. */
export function specialTilesetPalettes(ctx: Gen2Ctx): Record<string, Rgb[][]> | undefined {
  if (!ctx.crystal) return undefined;
  let out: Record<string, Rgb[][]> | undefined;
  for (const [tileset, label] of Object.entries(SPECIAL_TILESET_PALETTES)) {
    const at = ctx.location(label);
    if (!at) continue;
    const set: Rgb[][] = [];
    for (let slot = 0; slot < 8; slot++) set.push(colors(ctx, at[0], at[1] + slot * 8, 4));
    (out ??= {})[tileset] = set;
  }
  // MansionPalette1's ninth palette -- engine/tilesets/tileset_palettes.asm:113
  const one = ctx.location("MansionPalette1");
  const two = ctx.location("MansionPalette2");
  const mansion = out?.TILESET_MANSION;
  if (mansion && one && two) {
    mansion[PAL_BG_YELLOW] = colors(ctx, two[0], two[1], 4);
    mansion[PAL_BG_WATER] = colors(ctx, one[0], one[1] + 6 * 8, 4);
    mansion[PAL_BG_ROOF] = colors(ctx, one[0], one[1] + 8 * 8, 4);
  }
  return out;
}

/** RomExtractorGen2.lua:363 — 5-bit channel to 0-255, rounded. */
export function scale5(value: number): number {
  return Math.floor((value * 255) / 31 + 0.5);
}

/** RomExtractorGen2.lua:574 — one little-endian BGR555 GBC colour
 * (%0bbbbbgggggrrrrr) as [r, g, b] 0-255. */
export function color(ctx: Gen2Ctx, bank: number, address: number): Rgb {
  const value = ctx.rom.word(bank, address);
  return [scale5(value & 31), scale5((value >> 5) & 31), scale5((value >> 10) & 31)];
}

/** RomExtractorGen2.lua:584 — `count` consecutive colours. */
export function colors(ctx: Gen2Ctx, bank: number, address: number, count: number): Rgb[] {
  const out: Rgb[] = [];
  for (let i = 0; i < count; i++) out.push(color(ctx, bank, address + i * 2));
  return out;
}

/**
 * RomExtractorGen2.lua:598 — BattleObjectPals: six 4-colour palettes whose
 * row 0 is PAL_BATTLE_OB_GRAY (slots ENEMY/PLAYER are the battlers' own
 * colours, not on disk), keyed by PAL_BATTLE_OB_* name. Undefined (omitted)
 * when the manifest lacks the symbol.
 */
export function battleObjectPals(ctx: Gen2Ctx): Record<string, Rgb[]> | undefined {
  const names = ctx.manifest.constants.battleAnimObPaletteOrder ?? [];
  if (!ctx.location("BattleObjectPals")) return undefined;
  const symbol = ctx.symbol("BattleObjectPals");
  const out: Record<string, Rgb[]> = {};
  for (let row = 0; row <= 5; row++) {
    // :608 names[row + 3] (1-based) = element row + 2
    const name = names[row + 2];
    if (name) out[name] = colors(ctx, symbol.bank, symbol.address + row * 8, 4);
  }
  return out;
}

/**
 * RomExtractorGen2.lua:748 extractPalettes. palettes.json:
 * - generation 2, source, daytimes ["MORN","DAY","NITE","DARK"],
 *   slotNames (PAL_BG_NAMES), roofSlot 7 (1-BASED slot, Lua's PAL_BG_ROOF+1);
 * - bg: 42 palettes x 4 [r,g,b] (the TilesetBGPalette pool);
 * - environments: {TOWN: {MORN: [8 indices], ...}, ...} — the indices are
 *   1-BASED into `bg` (Lua `+ 1`), so bg[index - 1] here;
 * - objects: {MORN: 8 palettes x 4 colours, ...};
 * - roofs: {"0".."26": {mornDay: 2 colours, nite: 2 colours}} — keyed by
 *   map group 0..26, 0-based so an object with string keys (SCHEMA.md);
 * - pokemon: {SPECIES: {normal: 2, shiny: 2}, ..., EGG} (middle colours only);
 * - trainers: {PLAYER, FALKNER, ...: 2 colours} (row 0 is PLAYER);
 * - hpBar {green, yellow, red, blue: 2 colours}, expBar (2), partyMenu
 *   (2 palettes x 4), battleObjects (see battleObjectPals).
 */
export function extractPalettes(ctx: Gen2Ctx): Record<string, unknown> {
  const { rom } = ctx;
  const consts = ctx.manifest.constants;

  const bgSymbol = ctx.symbol("TilesetBGPalette");
  const bg: Rgb[][] = [];
  for (let index = 0; index < BG_PALETTE_COUNT; index++) {
    bg.push(colors(ctx, bgSymbol.bank, bgSymbol.address + index * 8, 4));
  }

  // :760 environment -> daytime -> 8 pool indices, stored 1-based.
  const envSymbol = ctx.symbol("EnvironmentColorsPointers");
  const environments: Record<string, Record<string, number[]>> = {};
  const environmentOrder = consts.environmentOrder ?? [];
  for (let slot = 0; slot < ENV_POINTER_COUNT; slot++) {
    const rowAddress = rom.word(envSymbol.bank, envSymbol.address + slot * 2);
    // :767 — slot 0 is the unused leading entry; environment ids are 1-based
    // (Lua environmentOrder[slot] = element slot - 1).
    const name = slot >= 1 ? environmentOrder[slot - 1] : undefined;
    if (!name) continue;
    const perDaytime: Record<string, number[]> = {};
    for (let day = 0; day < DAYTIMES.length; day++) {
      const indices: number[] = [];
      for (let i = 0; i < 8; i++) indices.push(rom.byte(envSymbol.bank, rowAddress + day * 8 + i) + 1);
      perDaytime[DAYTIMES[day]!] = indices;
    }
    environments[name] = perDaytime;
  }

  // :785 OW sprite OBJ palettes, one set of 8 per daytime.
  const objSymbol = ctx.symbol("MapObjectPals");
  const objects: Record<string, Rgb[][]> = {};
  for (let day = 0; day < DAYTIMES.length; day++) {
    const set: Rgb[][] = [];
    for (let pal = 0; pal < OW_PALETTE_COUNT; pal++) {
      set.push(colors(ctx, objSymbol.bank, objSymbol.address + (day * OW_PALETTE_COUNT + pal) * 8, 4));
    }
    objects[DAYTIMES[day]!] = set;
  }

  // :797 RoofPals rows: two morn/day colours then two nite colours.
  const roofSymbol = ctx.symbol("RoofPals");
  const roofs: Record<string, { mornDay: Rgb[]; nite: Rgb[] }> = {};
  for (let group = 0; group <= MAP_GROUP_COUNT; group++) {
    const base = roofSymbol.address + group * 8;
    roofs[String(group)] = {
      mornDay: colors(ctx, roofSymbol.bank, base, 2),
      nite: colors(ctx, roofSymbol.bank, base + 4, 2),
    };
  }

  // :810 mon pics ship only their two middle colours. Row 0 is unused:
  // species n (Lua index n) sits at row n.
  const monSymbol = ctx.symbol("PokemonPalettes");
  const pokemon: Record<string, { normal: Rgb[]; shiny: Rgb[] }> = {};
  const species = consts.speciesOrder ?? [];
  for (let i = 0; i < species.length; i++) {
    const name = species[i];
    if (!name || name === "UNUSED") continue;
    const base = monSymbol.address + (i + 1) * 8;
    pokemon[name] = {
      normal: colors(ctx, monSymbol.bank, base, 2),
      shiny: colors(ctx, monSymbol.bank, base + 4, 2),
    };
  }
  // :829 — EGG ($fd) has its own row past the 251 species (palettes.asm:530).
  pokemon.EGG = {
    normal: colors(ctx, monSymbol.bank, monSymbol.address + 253 * 8, 2),
    shiny: colors(ctx, monSymbol.bank, monSymbol.address + 253 * 8 + 4, 2),
  };

  // :835 — row 0 is PlayerPalette (TRAINER_NONE has no pic): named PLAYER.
  const trainerSymbol = ctx.symbol("TrainerPalettes");
  const trainers: Record<string, Rgb[]> = {};
  const classes = consts.trainerClassOrder ?? [];
  for (let i = 0; i < classes.length; i++) {
    const name = i === 0 ? "PLAYER" : classes[i]!;
    trainers[name] = colors(ctx, trainerSymbol.bank, trainerSymbol.address + i * 4, 2);
  }

  const hp = ctx.symbol("HPBarPals");
  const exp = ctx.symbol("ExpBarPalette");
  const party = ctx.symbol("PartyMenuOBPals");

  return {
    generation: 2,
    source: "ROM:TilesetBGPalette/EnvironmentColorsPointers/MapObjectPals/RoofPals",
    daytimes: [...DAYTIMES],
    slotNames: PAL_BG_NAMES,
    roofSlot: PAL_BG_ROOF + 1,
    bg,
    environments,
    specialTilesets: specialTilesetPalettes(ctx),
    objects,
    roofs,
    pokemon,
    trainers,
    hpBar: {
      green: colors(ctx, hp.bank, hp.address, 2),
      yellow: colors(ctx, hp.bank, hp.address + 4, 2),
      red: colors(ctx, hp.bank, hp.address + 8, 2),
      blue: colors(ctx, hp.bank, hp.address + 12, 2),
    },
    expBar: colors(ctx, exp.bank, exp.address, 2),
    partyMenu: [colors(ctx, party.bank, party.address, 4), colors(ctx, party.bank, party.address + 8, 4)],
    battleObjects: battleObjectPals(ctx),
  };
}
