// voxelmon/cook/gen3.ts — the FireRed importer cache, read for the voxel cook.
//
// MIT, like the rest of voxelmon/cook. This file reads only the cache's
// FILE FORMATS and the ROM structures they hold (pret's map grid, border and
// metatile-attribute layouts, the GBA's BGR555 colours); it ports no
// gen1recomp code, so it sits outside the gen3 licence split. (The formats of
// the importer's own files -- mids.idx, palettes.bin, native/manifest.lua --
// are read from their bytes; see the notes on each reader.)
//
// What it hands the cook (cook/gen3cook.ts) for each map:
//
//   - the map record in the shape every other game's cook uses (data.ts
//     MapDef: id, index, size, the metatile grid in `blocks`, connections,
//     warps, outdoor), plus the Gen 3 extras: the raw collision bits and
//     elevation per cell, the border block, the map type, the tileset pair;
//   - per metatile id, its behaviour byte (the map's two tilesets'
//     attributes.bin) -- the class rules in cook/gen3terrain.ts read it;
//   - per tileset PAIR (what native/ calls the primary+secondary atlas a map
//     draws from), the metatile atlas as the cook's tile page wants it:
//     16x16 metatiles in a 16-wide grid, CLUT8 texels `palette*16 + colour`,
//     the under layer (BG3 + BG2, what the player walks over) and the over
//     layer (BG1, drawn above the player; texel 0 = clear), and the pair's
//     sixteen BGR555 palettes as one 256-entry CLUT.
//
// Cache paths are byte strings (fsio.ts diskPath); every path read here is
// plain ASCII, but they go through the same helper so a cache that grows a
// non-ASCII name still reads.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { luaModuleToJson } from "../import/lua.ts";
import type { MapDef } from "./data.ts";

/** The cache tree (the importer's data/generated/gba). VOXELMON_FR_CACHE overrides. */
export function frCacheDir(): string {
  return process.env.VOXELMON_FR_CACHE ?? join(homedir(), "gen3ref/frfull/data/generated/gba");
}

/** A cache path on disk, the bytes of `rel` kept as bytes (fsio.ts diskPath). */
function diskPath(root: string, rel: string): Buffer {
  return Buffer.concat([Buffer.from(root, "utf8"), Buffer.from("/" + rel, "latin1")]);
}

function read(root: string, rel: string): Buffer {
  return readFileSync(diskPath(root, rel));
}

function has(root: string, rel: string): boolean {
  return existsSync(diskPath(root, rel));
}

function readLua<T>(root: string, rel: string): T {
  return JSON.parse(luaModuleToJson(read(root, rel).toString("latin1"), rel)) as T;
}

// ---------------------------------------------------------------------------
// ROM facts (pokefirered include/constants/metatile_behaviors.h,
// include/global.fieldmap.h, src/metatile_behavior.c) -- values, not code.
// ---------------------------------------------------------------------------

/** MetatileBehavior_IsSurfable: every behaviour a surfer can cross. */
export const SURF_BEHAVIOURS = new Set([
  0x10, // MB_POND_WATER
  0x11, // MB_FAST_WATER
  0x12, // MB_DEEP_WATER
  0x13, // MB_WATERFALL
  0x15, // MB_OCEAN_WATER
  0x1a, // MB_UNUSED_WATER
  0x1b, // MB_CYCLING_ROAD_WATER
  0x50, // MB_EASTWARD_CURRENT
  0x51, // MB_WESTWARD_CURRENT
  0x52, // MB_NORTHWARD_CURRENT
  0x53, // MB_SOUTHWARD_CURRENT
]);

/** MB_JUMP_EAST .. MB_JUMP_SOUTH: the ledges. */
export const LEDGE_BEHAVIOURS = new Set([0x38, 0x39, 0x3a, 0x3b]);

/** MB_WARP_DOOR (an animated house / building door). */
export const MB_WARP_DOOR = 0x69;

/** NUM_METATILES_IN_PRIMARY (FRLG): ids from here on index the secondary tileset. */
export const NUM_METATILES_IN_PRIMARY = 640;

/**
 * MAP_TYPE_* (include/constants/map_types.h). Open-sky maps follow the clock
 * in the voxel mod; this cook only needs "outdoor".
 */
export const MAP_TYPE = { none: 0, town: 1, city: 2, route: 3, underground: 4, underwater: 5, oceanRoute: 6, indoor: 8, secretBase: 9 };

/** Is a map of this type out under the sky (the mod's `ctx.outdoor`, overworld.c IsMapTypeOutdoors). */
export function isOutdoorMapType(t: number): boolean {
  return t === MAP_TYPE.town || t === MAP_TYPE.city || t === MAP_TYPE.route || t === MAP_TYPE.underwater || t === MAP_TYPE.oceanRoute;
}

// ---------------------------------------------------------------------------
// records
// ---------------------------------------------------------------------------

export interface FrCell {
  /** Metatile id, 0..1023 (grid u16 bits 0-9). */
  mid: number;
  /** pret collision bits (grid u16 bits 10-11): 0 = passable, else impassable. */
  coll: number;
  /** Elevation (grid u16 bits 12-15). */
  elev: number;
}

/** One map, MapDef-shaped for the shared cook, plus what Gen 3 adds. */
export interface FrMap extends MapDef {
  /** census slot "group_num" (map_tree/maps/<slot>). */
  slot: string;
  group: number;
  num: number;
  /** pret's own name (PalletTown). */
  pretName: string;
  /** native/ tileset pair this map draws from (also in MapDef.tileset). */
  pair: string;
  primaryTileset: string;
  secondaryTileset: string;
  mapType: number;
  outdoor: boolean;
  cells: FrCell[];
  border: { w: number; h: number; mids: number[] };
}

/** One tileset pair's atlas, ready for a tile page. */
export interface FrPair {
  name: string;
  /** Atlas grid in metatiles (always 16 wide in this cache). */
  cols: number;
  rows: number;
  midCount: number;
  /** metatile id -> atlas slot (slot i sits at (i % cols, i / cols)). */
  midToSlot: Map<number, number>;
  /** Linear CLUT8 texels, (cols*16) x (rows*16): BG3+BG2, opaque everywhere. */
  under: Uint8Array;
  /** Linear CLUT8 texels, same size: BG1 (over the player); 0 = clear. */
  over: Uint8Array;
  /** The sixteen BGR555 palettes as one CLUT, ABGR (0xAABBGGRR), all opaque. */
  clut: Uint32Array;
  /** The same, as [r, g, b] 0..255. */
  rgb: [number, number, number][];
  /** Palettes the tilesets really use (FRLG: 13; texels never index past it). */
  numPalsTotal: number;
}

export interface FrData {
  root: string;
  maps: Record<string, FrMap>;
  /** Census entries the native manifest has no layout for (none in a full cache). */
  unmatched: string[];
}

// ---------------------------------------------------------------------------
// the importer's binary formats
// ---------------------------------------------------------------------------

/** BGR555 -> 8-bit channels, rounded (c * 255 / 31). */
export function bgr555(c: number): [number, number, number] {
  const r = c & 31;
  const g = (c >> 5) & 31;
  const b = (c >> 10) & 31;
  return [Math.floor((r * 255) / 31 + 0.5), Math.floor((g * 255) / 31 + 0.5), Math.floor((b * 255) / 31 + 0.5)];
}

/**
 * mids.idx: "SVMI" u8 version u8 flags u16 midCount u16 cols u16 rows, then
 * midCount u16 metatile ids, then midCount * 256 texel bytes (each metatile's
 * 16x16 block, row-major).
 */
function readIdx(buf: Buffer): { cols: number; rows: number; mids: number[]; texels: (slot: number) => Uint8Array } {
  if (buf.toString("latin1", 0, 4) !== "SVMI") throw new Error("bad mids.idx magic");
  const midCount = buf.readUInt16LE(6);
  const cols = buf.readUInt16LE(8);
  const rows = buf.readUInt16LE(10);
  const mids: number[] = [];
  for (let i = 0; i < midCount; i++) mids.push(buf.readUInt16LE(12 + i * 2));
  const base = 12 + midCount * 2;
  if (buf.length < base + midCount * 256) throw new Error("mids.idx truncated");
  return { cols, rows, mids, texels: (slot) => new Uint8Array(buf.subarray(base + slot * 256, base + slot * 256 + 256)) };
}

/** Lay an idx file's per-slot blocks out as one linear atlas. */
function linearAtlas(idx: ReturnType<typeof readIdx>): Uint8Array {
  const W = idx.cols * 16;
  const out = new Uint8Array(W * idx.rows * 16);
  idx.mids.forEach((_, slot) => {
    const block = idx.texels(slot);
    const sx = (slot % idx.cols) * 16;
    const sy = Math.floor(slot / idx.cols) * 16;
    for (let y = 0; y < 16; y++) out.set(block.subarray(y * 16, y * 16 + 16), (sy + y) * W + sx);
  });
  return out;
}

const pairCache = new Map<string, FrPair>();

/** A tileset pair's atlas (native/<pair>/mids.idx, mids_over.idx, palettes.bin). */
export function loadPair(root: string, name: string): FrPair {
  const hit = pairCache.get(`${root}\0${name}`);
  if (hit) return hit;
  const under = readIdx(read(root, `native/${name}/mids.idx`));
  const over = has(root, `native/${name}/mids_over.idx`) ? readIdx(read(root, `native/${name}/mids_over.idx`)) : null;
  if (over && (over.cols !== under.cols || over.mids.length !== under.mids.length)) {
    throw new Error(`${name}: mids_over.idx does not match mids.idx`);
  }
  // palettes.bin: "SVMP" u8 version u8 numPalsInPrimary u8 numPalsTotal u8 0,
  // then 16 palettes x 16 BGR555 colours (u16 LE)
  const pals = read(root, `native/${name}/palettes.bin`);
  if (pals.toString("latin1", 0, 4) !== "SVMP") throw new Error(`${name}: bad palettes.bin magic`);
  const numPalsTotal = pals[6] || 13;
  const clut = new Uint32Array(256);
  const rgb: [number, number, number][] = [];
  for (let i = 0; i < 256; i++) {
    const c = bgr555(pals.readUInt16LE(8 + i * 2));
    rgb.push(c);
    clut[i] = (0xff000000 | (c[2] << 16) | (c[1] << 8) | c[0]) >>> 0;
  }
  const midToSlot = new Map<number, number>();
  under.mids.forEach((mid, slot) => midToSlot.set(mid, slot));
  const pair: FrPair = {
    name,
    cols: under.cols,
    rows: under.rows,
    midCount: under.mids.length,
    midToSlot,
    under: linearAtlas(under),
    over: over ? linearAtlas(over) : new Uint8Array(under.cols * 16 * under.rows * 16),
    clut,
    rgb,
    numPalsTotal,
  };
  pairCache.set(`${root}\0${name}`, pair);
  return pair;
}

const attrCache = new Map<string, Uint32Array>();

/** A tileset's metatile attributes (map_tree/tilesets/<ts>/attributes.bin, u32 each). */
function attributes(root: string, ts: string): Uint32Array {
  const key = `${root}\0${ts}`;
  let a = attrCache.get(key);
  if (!a) {
    const rel = `map_tree/tilesets/${ts}/attributes.bin`;
    const b = has(root, rel) ? read(root, rel) : Buffer.alloc(0);
    a = new Uint32Array(b.length >> 2);
    for (let i = 0; i < a.length; i++) a[i] = b.readUInt32LE(i * 4);
    attrCache.set(key, a);
  }
  return a;
}

/** A metatile's behaviour byte (attribute bits 0-8) on this map. */
export function behaviourOf(root: string, map: FrMap, mid: number): number {
  const primary = mid < NUM_METATILES_IN_PRIMARY;
  const a = attributes(root, primary ? map.primaryTileset : map.secondaryTileset);
  const i = primary ? mid : mid - NUM_METATILES_IN_PRIMARY;
  return i >= 0 && i < a.length ? a[i] & 0x1ff : 0;
}

// ---------------------------------------------------------------------------
// the map list
// ---------------------------------------------------------------------------

/**
 * The six maps whose engine id is not a spelling of pret's name (the
 * importer's hand aliases -- naming facts, listed here rather than imported).
 */
const PRET_ALIASES: Record<string, string> = {
  PalletTown_PlayersHouse_1F: "FR_PLAYERS_HOUSE_1F",
  PalletTown_PlayersHouse_2F: "FR_PLAYERS_HOUSE_2F",
  PalletTown_RivalsHouse: "FR_RIVALS_HOUSE",
  PalletTown_ProfessorOaksLab: "FR_OAKS_LAB",
  OneIsland_PokemonCenter_1F: "SEVII_ONE_ISLAND_POKECENTER",
  OneIsland_PokemonCenter_2F: "SEVII_ONE_ISLAND_POKECENTER_2F",
};

/** Letters and digits only, upper case: how two spellings of one name compare. */
const squash = (s: string): string => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

interface Census {
  groups: { group: number; maps: { id: string; num: number; slot: string }[] }[];
}

interface Header {
  width: number;
  height: number;
  borderWidth?: number;
  borderHeight?: number;
  mapType: number;
  primaryTileset: string;
  secondaryTileset: string;
  pretName?: string;
}

/**
 * Every map the native manifest lays out, keyed by the runtime's map id
 * (FR_PALLET_TOWN), each joined to its census slot for the raw grid, border
 * and header. The map index is `group << 8 | num` (Gold's convention, so
 * index.txt and the pak's map ids stay unique and stable).
 */
export function loadFrData(root = frCacheDir()): FrData {
  const census = JSON.parse(read(root, "map_tree/census.json").toString("utf8")) as Census;
  const manifest = readLua<{ layouts: Record<string, { pair: string; width: number; height: number }> }>(root, "native/manifest.lua");
  const connections = readLua<Record<string, { dir: string; map: string; offset: number }[] | Record<string, never>>>(root, "connections.lua");
  const warps = readLua<Record<string, { x: number; y: number; destMap: string; destWarp: number }[] | Record<string, never>>>(root, "warps.lua");

  // engine id by squashed name, with and without its region prefix
  const engineBySquash = new Map<string, string>();
  for (const id of Object.keys(manifest.layouts)) {
    engineBySquash.set(squash(id), id);
    engineBySquash.set(squash(id.replace(/^(FR|LG|SEVII)_/, "")), id);
  }
  const maps: Record<string, FrMap> = {};
  const unmatched: string[] = [];
  for (const g of census.groups) {
    for (const entry of g.maps) {
      const id = PRET_ALIASES[entry.id] ?? engineBySquash.get(squash(entry.id));
      if (!id || !manifest.layouts[id]) {
        unmatched.push(`${entry.id}@${entry.slot}`);
        continue;
      }
      const h = JSON.parse(read(root, `map_tree/maps/${entry.slot}/header.json`).toString("utf8")) as Header;
      const grid = read(root, `map_tree/maps/${entry.slot}/grid.bin`);
      if (grid.length < h.width * h.height * 2) throw new Error(`${id}: grid.bin is short`);
      const cells: FrCell[] = [];
      for (let i = 0; i < h.width * h.height; i++) {
        const v = grid.readUInt16LE(i * 2);
        cells.push({ mid: v & 0x3ff, coll: (v >> 10) & 3, elev: (v >> 12) & 15 });
      }
      const bw = h.borderWidth || 2;
      const bh = h.borderHeight || 2;
      const bb = has(root, `map_tree/maps/${entry.slot}/border.bin`) ? read(root, `map_tree/maps/${entry.slot}/border.bin`) : Buffer.alloc(0);
      const borderMids: number[] = [];
      for (let i = 0; i < bw * bh; i++) borderMids.push(i * 2 + 1 < bb.length ? bb.readUInt16LE(i * 2) & 0x3ff : 0);
      const conns: Record<string, { map: string; offset: number }> = {};
      const cl = connections[id];
      for (const c of Array.isArray(cl) ? cl : []) conns[c.dir] = { map: c.map, offset: c.offset };
      const wl = warps[id];
      maps[id] = {
        id,
        index: (g.group << 8) | entry.num,
        tileset: manifest.layouts[id]!.pair,
        width: h.width,
        height: h.height,
        blocks: cells.map((c) => c.mid),
        borderBlock: borderMids[0] ?? 0,
        connections: conns,
        warps: Array.isArray(wl) ? wl.map((w) => ({ x: w.x, y: w.y, destMap: w.destMap, destWarp: w.destWarp })) : [],
        outdoor: isOutdoorMapType(h.mapType),
        slot: entry.slot,
        group: g.group,
        num: entry.num,
        pretName: entry.id,
        pair: manifest.layouts[id]!.pair,
        primaryTileset: h.primaryTileset,
        secondaryTileset: h.secondaryTileset,
        mapType: h.mapType,
        cells,
        border: { w: bw, h: bh, mids: borderMids },
      };
    }
  }
  return { root, maps, unmatched };
}

/**
 * The cell at (cx, cy), border-extended the way FRLG samples outside a map:
 * the border block tiled from the map's (0, 0) (fieldmap.c GetBorderBlockAt).
 * `inside` says which it was.
 */
export function cellAt(map: FrMap, cx: number, cy: number): FrCell & { inside: boolean } {
  if (cx >= 0 && cy >= 0 && cx < map.width && cy < map.height) {
    return { ...map.cells[cy * map.width + cx]!, inside: true };
  }
  const bx = ((cx % map.border.w) + map.border.w) % map.border.w;
  const by = ((cy % map.border.h) + map.border.h) % map.border.h;
  return { mid: map.border.mids[by * map.border.w + bx] ?? 0, coll: 1, elev: 0, inside: false };
}
