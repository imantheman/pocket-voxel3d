// voxelmon/cook/data.ts — cook-time inputs (voxelmon/SCHEMA.md).
//
// Loads dist/voxelmon/gen/*.json + gfx.bin, wraps a map the way the
// gen1recomp runtime does (Map.lua: tileAt border-extends, every cell rule
// judges the cell's BOTTOM-LEFT tile), and converts the VoxelMod profile
// (data/voxel_heights.lua) to JSON through a LuaJIT one-shot — the same
// mechanism the importer's parity path uses.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { luaModuleToJson } from "../import/lua.ts";
import { activeVersion, type GameVersion, genDirFor } from "../import/env.ts";
import type { RedppPack } from "./redpp.ts";
import { isGrass as isGrassColl, isLand, isWater as isWaterColl } from "../game/gen2/permissions.ts";
import { isGen2, normalizeGen2 } from "./gen2.ts";

export const ROOT = fileURLToPath(new URL("../..", import.meta.url));
/** The dataset of the game this run cooks (import/env.ts activeVersion). */
export const GEN_DIR = genDirFor(activeVersion());

// ---------------------------------------------------------------------------
// gen/ dataset
// ---------------------------------------------------------------------------

export interface TilesetDef {
  id: string;
  image: string;
  imageWidth: number;
  imageHeight: number;
  tilesPerRow: number;
  blocks: number[][];
  walkable: number[];
  counterTiles?: number[];
  grassTile?: number;
  doorTiles?: number[];
  warpTiles?: number[];
  waterTiles?: number[];
  shoreTiles?: number[];
  animation?: string;
  /**
   * Gen 2: one COLL_* byte per 2x2-tile quadrant of each metatile --
   * top-left, top-right, bottom-left, bottom-right (the `tilecoll` macro) --
   * which is what a Gen 2 cell is judged by (game/gen2/permissions.ts).
   * Absent for Gen 1, whose cells are judged by their bottom-left tile.
   */
  collision?: number[][];
}

export interface MapDef {
  id: string;
  index: number;
  tileset: string;
  width: number;
  height: number;
  blocks: number[];
  borderBlock: number;
  connections?: Record<string, { map: string; offset: number }>;
  warps?: { x: number; y: number; destMap: string; destWarp: number }[];
  signs?: unknown[];
  objects?: unknown[];
  outdoor?: boolean;
  /** Cells carrying a cook-time cut-tree prop (cook/structures.ts). */
  cuttableCells?: [number, number][];
  /**
   * Blocks (bx,by) where cli.ts baked a CLOSED card-key door in, for mesh.ts
   * to lift out as per-cell stamps. The runtime hides them on unlock.
   */
  stampBlocks?: [number, number][];
}

export interface GfxEntry {
  off: number;
  w: number;
  h: number;
  walker?: boolean;
}

/** The imported SGB palette module (gen/palettes.json — ROM SuperPalettes):
 * 37 named 4-color palettes, lightest shade first, plus the ROM's own order
 * (the pak's SGB set is packed in exactly this order) and the species map. */
export interface PalettesDef {
  palettes: Record<string, [number, number, number][]>;
  order: string[];
  pokemon: Record<string, string>;
  source?: string;
}

/** One imported sprite record; `source` carries the ROM crosswalk the RED++
 * OBJ-palette assignment is keyed by ("ROM:SpriteSheetPointerTable[N]"). */
export interface SpriteDef {
  id: string;
  source: string;
  image: string;
  frames: number;
  walker?: boolean;
}

export interface GenData {
  maps: Record<string, MapDef>;
  tilesets: Record<string, TilesetDef>;
  palettes: PalettesDef;
  sprites: Record<string, SpriteDef>;
  gfx: Record<string, GfxEntry>;
  gfxBin: Uint8Array;
  font: {
    mainBase: number;
    extraBase: number;
    glyphsPerRow: number;
    charmap: { code: number; seq: string }[];
  };
  constants: Record<string, unknown>;
  encounters: Record<string, unknown>;
  moves: unknown;
  pokemon: Record<string, Record<string, unknown>>;
  items: unknown;
  typeChart: unknown;
  trainers: unknown;
  text: unknown;
  textPointers: unknown;
  trainerHeaders: unknown;
  field: Record<string, unknown>;
  /** Battle move animations, or null in a dataset imported before them. */
  battleAnims: BattleAnims | null;
  /** Yellow's minigame data (import stages/minigame.ts), else null. */
  minigame: Record<string, unknown> | null;
  /** Which game the dataset was imported from (version.json; absent = red). */
  version: GameVersion;
}

/** The tables voxelmon/import/stages/battle-anims.ts writes. */
export interface BattleAnims {
  anims: Record<string, unknown[]>;
  subanims: unknown[];
  frameBlocks: unknown[][];
  baseCoords: [number, number][];
  tilesets: { tiles: number; gfx: string }[];
}

export function genMissingReason(genDir = GEN_DIR): string | null {
  if (!existsSync(join(genDir, "maps.json"))) {
    return `imported dataset not found: ${genDir} (run \`bun tools/voxel.ts import\`)`;
  }
  return null;
}

function readJson<T>(genDir: string, name: string): T {
  return JSON.parse(readFileSync(join(genDir, name), "utf8")) as T;
}

/** A module a dataset may not carry: Gold's import has no Gen 1 tables yet. */
function optionalJson<T>(genDir: string, name: string): T {
  return (existsSync(join(genDir, name)) ? readJson(genDir, name) : undefined) as T;
}

export function loadGen(genDir = GEN_DIR): GenData {
  const gen: GenData = {
    maps: readJson(genDir, "maps.json"),
    tilesets: readJson(genDir, "tilesets.json"),
    palettes: readJson(genDir, "palettes.json"),
    sprites: readJson(genDir, "sprites.json"),
    gfx: readJson(genDir, "gfx.json"),
    gfxBin: new Uint8Array(readFileSync(join(genDir, "gfx.bin"))),
    font: optionalJson(genDir, "font.json"),
    constants: readJson(genDir, "constants.json"),
    encounters: optionalJson(genDir, "encounters.json"),
    moves: optionalJson(genDir, "moves.json"),
    pokemon: optionalJson(genDir, "pokemon.json"),
    items: optionalJson(genDir, "items.json"),
    typeChart: optionalJson(genDir, "type_chart.json"),
    trainers: optionalJson(genDir, "trainers.json"),
    text: optionalJson(genDir, "text.json"),
    textPointers: optionalJson(genDir, "text_pointers.json"),
    trainerHeaders: optionalJson(genDir, "trainer_headers.json"),
    field: optionalJson(genDir, "field.json"),
    // Optional: a dataset imported before the animations still cooks, and
    // the guest simply has no move animations to play.
    battleAnims: existsSync(join(genDir, "battle_anims.json"))
      ? readJson(genDir, "battle_anims.json")
      : null,
    minigame: existsSync(join(genDir, "minigame.json")) ? readJson(genDir, "minigame.json") : null,
    // A dataset imported before versions existed is Red's.
    version: existsSync(join(genDir, "version.json"))
      ? (readJson(genDir, "version.json") as { version: GameVersion }).version
      : "red",
  };
  // Gold: Brian's records seen the way the cook reads a map (cook/gen2.ts)
  if (isGen2(gen)) normalizeGen2(gen);
  return gen;
}

// ---------------------------------------------------------------------------
// tile art — gfx.bin is 1 byte/px: 0..3 = GB shade (0 lightest), 0xff = clear
// ---------------------------------------------------------------------------

/** Transparent-pixel byte in gfx.bin. */
export const PX_CLEAR = 0xff;

/** Indexed-bitmap view over one gfx.json entry. */
export class Art {
  constructor(
    readonly bin: Uint8Array,
    readonly off: number,
    readonly w: number,
    readonly h: number,
  ) {}

  /** Raw shade byte (0..3, or PX_CLEAR) at (x, y); out of range = clear. */
  px(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return PX_CLEAR;
    return this.bin[this.off + y * this.w + x];
  }
}

export function artOf(gen: GenData, key: string): Art | null {
  const e = gen.gfx[key];
  if (!e) return null;
  return new Art(gen.gfxBin, e.off, e.w, e.h);
}

/** gfx.json key of a tileset's atlas sheet ("assets/generated/x.png" → "x"). */
export function sheetKeyOf(tileset: TilesetDef): string {
  return tileset.image.replace(/^assets\/generated\//, "").replace(/\.png$/, "");
}

// Shade classes, matching the upstream cutoffs on min(r,g,b) of the GB
// palette PNGs (shade 0 = 1.0, 1 = 0.666, 2 = 0.333, 3 = 0):
//   VoxelMod Structures.lua:2289 shadeClass / Buildings.lua:116 shadeOf.
// Our gfx bytes ARE the class: 0=white, 1=light/grey, 2=dark, 3=black.
export type ShadeName = "off" | "white" | "light" | "dark" | "black";
const SHADE_NAMES: ShadeName[] = ["white", "light", "dark", "black"];

export function shadeClassOf(byte: number): ShadeName {
  if (byte === PX_CLEAR) return "off";
  return SHADE_NAMES[byte & 3];
}

// ---------------------------------------------------------------------------
// runtime Map semantics (gen1recomp src/world/Map.lua)
// ---------------------------------------------------------------------------

// Map.lua:20-22 stale-cache fallbacks: water $14 everywhere, shore $32/$48
// everywhere except SHIP_PORT.
const WATER_TILES = [0x14];
const SHORE_TILES = [0x32, 0x48];
const NO_SHORE_TILESETS = new Set(["SHIP_PORT"]);

export function mod(a: number, b: number): number {
  return ((a % b) + b) % b;
}

export class GameMap {
  readonly def: MapDef;
  readonly tileset: TilesetDef;
  readonly id: string;
  readonly widthTiles: number;
  readonly heightTiles: number;
  readonly walkable: Set<number>;
  readonly doorTiles: Set<number>;
  readonly waterTiles: Set<number>;

  constructor(def: MapDef, tileset: TilesetDef) {
    this.def = def;
    this.tileset = tileset;
    this.id = def.id;
    this.widthTiles = def.width * 4;
    this.heightTiles = def.height * 4;
    this.walkable = new Set(tileset.walkable ?? []);
    this.doorTiles = new Set(tileset.doorTiles ?? []);
    // VoxelMod Map.lua:128-131 — water and shore share one lookup.
    this.waterTiles = new Set(tileset.waterTiles ?? WATER_TILES);
    const shore = tileset.shoreTiles ?? (NO_SHORE_TILESETS.has(def.tileset) ? [] : SHORE_TILES);
    for (const t of shore) this.waterTiles.add(t);
  }

  // Map.lua:196 blockAt — border-extends with the map's own borderBlock.
  blockAt(bx: number, by: number): number {
    if (bx < 0 || by < 0 || bx >= this.def.width || by >= this.def.height) {
      return this.def.borderBlock;
    }
    return this.def.blocks[by * this.def.width + bx];
  }

  // Map.lua:204 tileAt — tile id at 8px tile coordinates, border-extended.
  tileAt(tx: number, ty: number): number {
    const block = this.tileset.blocks[this.blockAt(Math.floor(tx / 4), Math.floor(ty / 4))];
    return block[mod(ty, 4) * 4 + mod(tx, 4)];
  }

  // Map.lua:212 cellTile — the collision tile: the cell's bottom-left tile.
  cellTile(cx: number, cy: number): number {
    return this.tileAt(cx * 2, cy * 2 + 1);
  }

  inBounds(cx: number, cy: number): boolean {
    return cx >= 0 && cy >= 0 && cx < this.def.width * 2 && cy < this.def.height * 2;
  }

  /** Gen 2: the cell's collision byte, from its metatile's quadrant
   * (border-extended like every other rule here). Undefined for Gen 1. */
  cellCollision(cx: number, cy: number): number | undefined {
    const quads = this.tileset.collision;
    if (!quads) return undefined;
    const block = this.blockAt(Math.floor(cx / 2), Math.floor(cy / 2));
    return quads[block]?.[mod(cy, 2) * 2 + mod(cx, 2)];
  }

  isWalkableCell(cx: number, cy: number): boolean {
    if (this.tileset.collision) return isLand(this.cellCollision(cx, cy));
    return this.walkable.has(this.cellTile(cx, cy));
  }

  isWaterCell(cx: number, cy: number): boolean {
    if (this.tileset.collision) return isWaterColl(this.cellCollision(cx, cy));
    return this.waterTiles.has(this.cellTile(cx, cy));
  }

  // Map.lua:224 isGrassCell — off-map cells never count (border filler).
  isGrassCell(cx: number, cy: number): boolean {
    if (!this.inBounds(cx, cy)) return false;
    if (this.tileset.collision) return isGrassColl(this.cellCollision(cx, cy));
    const grass = this.tileset.grassTile;
    return grass !== undefined && this.cellTile(cx, cy) === grass;
  }

  // Map.lua:148 isOutdoor.
  get outdoor(): boolean {
    if (this.def.outdoor !== undefined) return this.def.outdoor;
    return this.def.tileset === "OVERWORLD";
  }
}

// ---------------------------------------------------------------------------
// the VoxelMod profile (data/voxel_heights.lua) via a LuaJIT one-shot
// ---------------------------------------------------------------------------

// The profile's shape after lua-dump normalization: numeric keys stringify.
export interface Profile {
  heights?: Record<string, number>;
  tilesets?: Record<string, ProfileTileset>;
  buildings?: Record<string, BuildingTemplate[]>;
  /**
   * Gen 2 only (the Gen2Recomped-DramaticShapes profile): COLL_* class ->
   * shape class, for every Gen 2 tileset at once (voxel_heights.lua:195).
   * Keys are the class byte, stringified by the dump.
   */
  collision?: Record<string, string>;
}

export interface ProfileTileset {
  heights?: Record<string, number>;
  when_above?: Record<string, { above?: number[]; class: string }[]>;
  when_below?: Record<string, { below?: number[]; class: string }[]>;
  prop_ground?: Record<string, number>;
  // class name -> tile-id list (everything else in the entry).
  [cls: string]: unknown;
}

export interface BuildingTemplate {
  id?: string;
  tiles: number[][];
  topRows?: number[][];
  claimOnly?: boolean;
  roofRows?: number;
  roofBack?: number;
  roofFront?: number;
  roofCycle?: [number, number];
  slab?: number;
  frontEave?: number;
  ledge?: [number, number] | null;
  seal?: string;
  panes?: boolean;
  depth?: number;
  depthPx?: number;
  keep?: number[];
  support?: number;
  scrub?: [number, number, number, number][];
  // desk-set fields (not built in v1 — see cook/buildings.ts):
  parts?: unknown;
  desk?: unknown;
  tray?: unknown;
  wall?: unknown;
}


export function voxelmodDir(): string {
  return process.env.VOXELMON_VOXELMOD ?? join(homedir(), "code/DramaticShapeVoxelMod");
}

let profileCache: Profile | null | undefined;

/** Load data/voxel_heights.lua, or null (with a printed reason) when absent. */
export function loadProfile(): Profile | null {
  if (profileCache !== undefined) return profileCache;
  const path = join(voxelmodDir(), "data/voxel_heights.lua");
  if (!existsSync(path)) {
    console.error(`voxel cook: profile not found: ${path} (set VOXELMON_VOXELMOD)`);
    profileCache = null;
    return null;
  }
  profileCache = JSON.parse(luaModuleToJson(readFileSync(path, "utf8"), path)) as Profile;
  return profileCache;
}

// ---------------------------------------------------------------------------
// the Gen 2 profile: Gen2Recomped-DramaticShapes data/voxel_heights.lua (MIT)
// ---------------------------------------------------------------------------

/** Where the Gen 2 fork of the voxel mod lives (VOXELMON_VOXELMOD_GEN2). */
export function voxelmodGen2Dir(): string {
  return process.env.VOXELMON_VOXELMOD_GEN2 ?? join(homedir(), "dl/Gen2Recomped-DramaticShapes");
}

/**
 * A Gold tileset id as the fork's profile keys it: pokegold's label, so
 * TILESET_JOHTO_MODERN is `TilesetJohtoModern` and TILESET_POKECENTER is
 * `TilesetPokecenter` (voxel_heights.lua:374, :5699, :8299).
 */
export function gen2ProfileKey(tilesetId: string): string {
  return (
    "Tileset" +
    tilesetId
      .replace(/^TILESET_/, "")
      .split("_")
      .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
      .join("")
  );
}

let gen2ProfileCache: Profile | null | undefined;

/**
 * Load the Gen 2 profile, re-keyed by the Gold dataset's own tileset ids.
 *
 * Unlike potato_voxel's `return { ... }` data module, the fork's file is a
 * Lua PROGRAM -- `local profile = {...}`, assignments onto it, a loop that
 * appends Johto's building catalogue to JohtoModern's (voxel_heights.lua:
 * 6724), `return profile` -- so the in-process data reader cannot take it.
 * It runs through the LuaJIT one-shot (import/lua-dump.lua), the importer's
 * parity mechanism. Only the TilesetX entries are carried across (the Gen 1
 * and Prism entries in the same file are never reachable from a Gold map),
 * plus `heights` and the `collision` class table; `collision_prism` is
 * Prism's overlay and Gold never reads it (TileShape.lua:717).
 */
/**
 * The fork's profile as the cook keeps it -- `heights`, `collision`, and the
 * TilesetX entries of `tilesets` and `buildings` -- dumped from the Lua
 * through LuaJIT. Only tools/gen2_profile_snapshot.ts calls this now.
 */
export function dumpGen2Profile(path: string): Profile {
  const dump = fileURLToPath(new URL("../import/lua-dump.lua", import.meta.url));
  const raw = JSON.parse(
    execFileSync("luajit", [dump, path], { encoding: "utf8", maxBuffer: 64 << 20 }),
  ) as Profile & Record<string, unknown>;
  const keep = <T>(rec: Record<string, T> | undefined): Record<string, T> => {
    const o: Record<string, T> = {};
    for (const [k, v] of Object.entries(rec ?? {})) if (k.startsWith("Tileset")) o[k] = v;
    return o;
  };
  return { heights: raw.heights, collision: raw.collision, tilesets: keep(raw.tilesets), buildings: keep(raw.buildings) };
}

/**
 * The snapshot of the fork's profile this repository carries
 * (voxelmon/cook/gen2-profile.json, MIT -- gen2-profile.LICENSE), so a cook
 * needs neither the fork's checkout nor LuaJIT.
 */
export const GEN2_PROFILE_SNAPSHOT = fileURLToPath(new URL("./gen2-profile.json", import.meta.url));

export function loadGen2Profile(tilesetIds: string[]): Profile | null {
  if (gen2ProfileCache !== undefined) return gen2ProfileCache;
  let raw: Profile;
  if (!process.env.VOXELMON_VOXELMOD_GEN2 && existsSync(GEN2_PROFILE_SNAPSHOT)) {
    raw = JSON.parse(readFileSync(GEN2_PROFILE_SNAPSHOT, "utf8")).profile as Profile;
  } else {
    // a checkout named explicitly (or no snapshot): the Lua, through LuaJIT
    const path = join(voxelmodGen2Dir(), "data/voxel_heights.lua");
    if (!existsSync(path)) {
      console.error(`voxel cook: Gen 2 profile not found: ${path} (set VOXELMON_VOXELMOD_GEN2)`);
      gen2ProfileCache = null;
      return null;
    }
    try {
      raw = dumpGen2Profile(path);
    } catch (error) {
      console.error(`voxel cook: Gen 2 profile failed to load (${String(error)})`);
      gen2ProfileCache = null;
      return null;
    }
  }
  const out: Profile = { heights: raw.heights, collision: raw.collision, tilesets: {}, buildings: {} };
  for (const id of tilesetIds) {
    const key = gen2ProfileKey(id);
    const ts = raw.tilesets?.[key];
    if (ts) out.tilesets![id] = ts;
    const list = raw.buildings?.[key];
    if (list) out.buildings![id] = list;
  }
  gen2ProfileCache = out;
  return out;
}

// ---------------------------------------------------------------------------
// the RED++ color pack (gen1recomp data/palettes_gbc.lua) via the same
// LuaJIT one-shot, cached under dist/ — voxelmon/SCHEMA.md §gen/
// ---------------------------------------------------------------------------

export function gen1recompDir(): string {
  return process.env.VOXELMON_G1R ?? join(homedir(), "code/gen1recomp");
}

let redppCache: RedppPack | null | undefined;

/**
 * Load `data/palettes_gbc.lua` (pokered-gbc-derived, MIT, NOT ROM-derived),
 * dumped to `gen/palettes_gbc.json` and re-dumped whenever the source is
 * newer. Returns null — with a printed reason, the `loadProfile` discipline
 * — when the checkout is absent; the cooker then omits every
 * RED++ binding and the pak renders exactly as it does today.
 */
export function loadRedpp(genDir = GEN_DIR): RedppPack | null {
  if (redppCache !== undefined) return redppCache;
  // VOXELMON_COLOUR=none cooks Game Boy grayscale without deleting the pack
  if (process.env.VOXELMON_COLOUR === "none") {
    redppCache = null;
    return null;
  }
  const path = join(gen1recompDir(), "data/palettes_gbc.lua");
  const cache = join(genDir, "palettes_gbc.json");
  if (!existsSync(path)) {
    console.error(`voxel cook: RED++ color pack not found: ${path} (set VOXELMON_G1R)`);
    redppCache = null;
    return null;
  }
  const fresh =
    existsSync(cache) && statSync(cache).mtimeMs >= statSync(path).mtimeMs;
  if (fresh) {
    redppCache = JSON.parse(readFileSync(cache, "utf8")) as RedppPack;
    return redppCache;
  }
  const json = luaModuleToJson(readFileSync(path, "utf8"), path);
  mkdirSync(genDir, { recursive: true });
  writeFileSync(cache, json);
  redppCache = JSON.parse(json) as RedppPack;
  return redppCache;
}
