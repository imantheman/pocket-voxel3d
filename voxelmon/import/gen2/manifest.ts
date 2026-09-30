// gen1recomp tools/rom_manifest_gold.json (format 3), consumed verbatim from
// the bdfac727 checkout (env.ts g1rDirFor(2)). Gen 2's manifest shares
// almost nothing with Gen 1's (voxelmon/import/manifest.ts), so it gets its
// own type rather than a bent one. Types cover what the ported stages read;
// everything else rides the index signatures untouched.

/** constants.mapGroups rows: the (group, map) -> name table
 * RomExtractorGen2.lua:1181 mapNameByIds is built from. */
export interface MapGroupSpec {
  group: number;
  map: number;
  name: string;
  width: number;
  height: number;
}

export interface Gen2Constants {
  source: string;
  /** Map const names, in MapGroupPointers order (group 1 map 1 first). */
  mapOrder: string[];
  mapGroups: MapGroupSpec[];
  /** TILESET_* names; Lua index n (1-based) is the constant value n, so
   * TILESET_JOHTO (1) is element 0 here and Tilesets row 1 in ROM. */
  tilesetOrder: string[];
  /** TOWN.. (1-based constants, like tilesetOrder). */
  environmentOrder: string[];
  /** PALETTE_AUTO.. (0-based constants: Lua reads it at value + 1). */
  paletteOrder: string[];
  /** FISHGROUP_NONE.. (0-based constants). */
  fishGroupOrder: string[];
  /** MAPCALLBACK_NONE placeholder then MAPCALLBACK_TILES (1).. */
  mapCallbackOrder: string[];
  /** SPRITE_* names; SPRITE_CHRIS (1) is element 0. */
  spriteOrder: string[];
  /** How many spriteOrder ids are OverworldSprites rows (the rest from
   * spritePokemon on are SpriteMons rows). */
  numOverworldSprites?: number;
  spritePokemon?: number;
  speciesOrder: string[];
  trainerClassOrder: string[];
  battleAnimObPaletteOrder?: string[];
  [key: string]: unknown;
}

export interface Gen2MapSpec {
  group: number;
  map: number;
  name: string;
  width: number;
  height: number;
}

export interface Gen2Manifest {
  format: number;
  generation: number;
  romSha1: string;
  symbols: Record<string, [number, number]>;
  /** RomExtractorGen2.lua:220 — per-ROM-revision symbol overrides, merged
   * over `symbols` when present (Gold's manifest has none). */
  symbolRevisions?: Record<string, Record<string, [number, number]>>;
  charmap: Record<string, string>;
  fontCharmap: unknown;
  constants: Gen2Constants;
  maps: Record<string, Gen2MapSpec>;
  tilesets: Record<string, unknown>;
  pokemonAssets: Record<string, unknown>;
  text: Record<string, unknown>;
}

export async function loadGen2Manifest(path: string): Promise<Gen2Manifest> {
  const manifest = (await Bun.file(path).json()) as Gen2Manifest;
  if (manifest.generation !== 2 || manifest.format !== 3) {
    throw new Error(
      `not a Gen 2 format-3 manifest (generation ${manifest.generation}, format ${manifest.format}): ${path}`,
    );
  }
  return manifest;
}
