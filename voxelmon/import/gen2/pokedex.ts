// Port of gen1recomp RomExtractorGen2.lua:5386-5501 (bdfac727):
// extractPokedex (-> the "pokedex" JSON: every species' dex entry plus the
// New and alphabetical sort orders) and extractLandmarks (-> the "landmarks"
// JSON: Pokegear town-map landmarks and the SPAWN_* respawn points).
// Text decodes through the manifest charmap with Rom.readString.

import type { Gen2Ctx } from "./ctx.ts";
import { lua } from "./helpers.ts";
import { mapNameByIds } from "./maps.ts";

export interface DexEntry {
  id: string;
  /** 1-based dex number (the species id). */
  dex: number;
  kind: string;
  /** The digits DisplayDexEntry prints: 4 digits, 2 before the point (204 -> 2'04"). */
  height: number;
  /** 5 digits, 4 before the point (150 -> 15.0 lb). */
  weight: number;
  /** Page one of the description. */
  text: string;
  /** Page two (starts right after page one's @). */
  text2: string;
}

/** Just what extractPokedex reads from manifest.pokemonAssets. */
interface DexAsset {
  dexLabel?: string;
}

/** One entry at bank:address: kind@, height word, weight word, page1@, page2@. :5405-5427. */
export function readDexEntry(
  ctx: Gen2Ctx,
  bank: number,
  address: number,
  species: string,
  dex: number,
): DexEntry {
  const charmap = ctx.manifest.charmap ?? {};
  const rom = ctx.rom;
  const [kind, consumed] = rom.readString(bank, address, charmap, 0x50, 24);
  const sizeAt = address + consumed;
  const height = rom.word(bank, sizeAt);
  const weight = rom.word(bank, sizeAt + 2);
  const [text, page1Length] = rom.readString(bank, sizeAt + 4, charmap, 0x50, 256);
  const [text2] = rom.readString(bank, sizeAt + 4 + page1Length, charmap, 0x50, 256);
  return { id: species, dex, kind, height, weight, text, text2 };
}

/**
 * :5388 extractPokedex -> `{ pokedex }`: { generation, source, entries
 * (species -> DexEntry; species without a dexLabel symbol, and UNUSED, are
 * absent), newOrder, alphabeticalOrder (arrays of #speciesOrder species
 * names; a byte that is no species id stays a number) }.
 */
export function extractPokedex(ctx: Gen2Ctx): Record<string, unknown> {
  const speciesOrder = ctx.manifest.constants.speciesOrder ?? [];
  const assets = ctx.manifest.pokemonAssets as Record<string, DexAsset | undefined>;

  // :5396 — each entry's own symbol is the address (entries span four banks).
  const entries: Record<string, DexEntry> = {};
  speciesOrder.forEach((species, i) => {
    const label = assets[species]?.dexLabel;
    const location = label ? ctx.location(label) : undefined;
    if (location && species !== "UNUSED") {
      entries[species] = readDexEntry(ctx, location[0], location[1], species, i + 1);
    }
  });

  // :5431 readOrder.
  const readOrder = (symbolName: string, length: number): (string | number)[] => {
    const symbol = ctx.symbol(symbolName);
    const list: (string | number)[] = [];
    for (let i = 0; i < length; i++) {
      const id = ctx.rom.byte(symbol.bank, symbol.address + i);
      list.push(lua(speciesOrder, id) ?? id);
    }
    return list;
  };

  return {
    pokedex: {
      generation: 2,
      source: "ROM:PokedexDataPointerTable + NewPokedexOrder",
      entries,
      newOrder: readOrder("NewPokedexOrder", speciesOrder.length),
      alphabeticalOrder: readOrder("AlphabeticalPokedexOrder", speciesOrder.length),
    },
  };
}

export interface Landmark {
  id: string;
  /** The LANDMARK_* constant (0-based). */
  index: number;
  /** Tilemap-space pixels (the ROM's OAM coords minus 8 / 16); may be negative. */
  x: number;
  y: number;
  /** <BSP> (the Town Map's breakable space) stored as "\n". */
  name: string;
}

export interface SpawnPoint {
  id: string;
  /** The SPAWN_* constant (0-based). */
  index: number;
  map?: string;
  x: number;
  y: number;
}

/**
 * :5457 extractLandmarks -> `{ landmarks }`: { generation, source, order
 * (landmarkOrder verbatim), landmarks (LANDMARK_* -> Landmark), spawns
 * (SPAWN_* -> SpawnPoint) }.
 */
export function extractLandmarks(ctx: Gen2Ctx): Record<string, unknown> {
  const consts = ctx.manifest.constants;
  const order = (consts.landmarkOrder as string[] | undefined) ?? [];
  const symbol = ctx.symbol("Landmarks");
  const charmap = ctx.manifest.charmap ?? {};
  const rom = ctx.rom;

  const landmarks: Record<string, Landmark> = {};
  order.forEach((id, i) => {
    const base = symbol.address + i * 4;
    const x = rom.byte(symbol.bank, base) - 8;
    const y = rom.byte(symbol.bank, base + 1) - 16;
    const pointer = rom.word(symbol.bank, base + 2);
    const [raw] = rom.readString(symbol.bank, pointer, charmap, 0x50, 24);
    landmarks[id] = { id, index: i, x, y, name: raw.replaceAll("<BSP>", "\n") };
  });

  // :5480 SpawnPoints — map_id + x/y per SPAWN_*.
  const spawnSymbol = ctx.symbol("SpawnPoints");
  const spawns: Record<string, SpawnPoint> = {};
  ((consts.spawnOrder as string[] | undefined) ?? []).forEach((id, i) => {
    const base = spawnSymbol.address + i * 4;
    const spawn: SpawnPoint = {
      id,
      index: i,
      x: rom.byte(spawnSymbol.bank, base + 2),
      y: rom.byte(spawnSymbol.bank, base + 3),
    };
    const map = mapNameByIds(ctx, rom.byte(spawnSymbol.bank, base), rom.byte(spawnSymbol.bank, base + 1));
    if (map) spawn.map = map;
    spawns[id] = spawn;
  });

  return {
    landmarks: { generation: 2, source: "ROM:Landmarks", order, landmarks, spawns },
  };
}
