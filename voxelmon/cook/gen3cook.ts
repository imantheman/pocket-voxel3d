// voxelmon/cook/gen3cook.ts — cook FireRed's maps into VXPK world paks.
//
// MIT. Reads the importer cache through cook/gen3.ts and meshes it with
// cook/gen3terrain.ts (the Voxel Overworld mod's rules, MIT); ports no
// gen1recomp code, so it is outside the gen3 licence split.
//
//   bun voxelmon/cook/gen3cook.ts [--only A,B] [--out DIR]
//
// One pak per map (the 3DS streams a pak per map, tools/cook3ds.ts), each
// carrying exactly what the world renderer reads for that map:
//
//   ATLS  page 0: the map's tile page (ATLAS_KIND.terrain), built from its
//         tileset pair -- so every map of one pair carries the SAME page and
//         the atlas share (tools/pak_share_atlas.py) hoists it into
//         common.vxat. Layout, 256 px wide (the pair's 16-metatile grid):
//           rows 0 .. R*16        each metatile's under layer
//           rows R*16 .. 2R*16    each metatile's under+over composite
//           rows 2R*16 .. +16     a 16x16 white block (flat-colour faces)
//         Texels are CLUT8 `palette*16 + colour` straight from the cache;
//         FRLG tilesets use 13 palettes (texels 0..207), so 254 is the white
//         and 255 is clear.
//   VPAL  0: the pair's sixteen palettes as one 256-entry CLUT (+ white and
//         clear); 1..3: the stock grey ramps for the other page kinds.
//   VCOL  the map draws through VPAL 0 (world_pal 0, terrain_page 0).
//   CHNK  the meshes (cook/mesh.ts packMap): terrain = tops and sides, cards
//         and overhead sheets as opaque rectangles; water = the sunk tops.
//         With FR_CARD_INSTANCES (the default), the cards go through the
//         tree-instance path instead (TINS): a border of trees is a handful
//         of distinct cards placed hundreds of times.
//   GAME  a small JSON record of the map (index, size, connections, warps,
//         map type) -- the runtime's dataset is cooked separately.
//   AUDI, CMAP, STMP  empty.
//
// After the cooks: the atlas share into paks_firered/, index.txt ("<map id>
// <name>", id = group << 8 | num), and world.json (every map's record, for
// the runtime's world view until FireRed has a gamedata container).

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  ATLAS_KIND,
  MESH_KIND,
  VXPK_COLOR_FLAG_WORLD,
  VXPK_META_FLAG_TREE_COARSE,
  VXPK_META_FLAG_TREE_LOD,
} from "../../contracts/spec/voxel-spec.ts";
import { gbPalette, type PageDef } from "./atlas.ts";
import { ROOT } from "./data.ts";
import { frCacheDir, type FrData, type FrMap, type FrPair, loadFrData, loadPair } from "./gen3.ts";
import { meshTerrain, type TerrainStats, type TileArt } from "./gen3terrain.ts";
import { type MapGeometry, packMap } from "./mesh.ts";
import { writePak } from "./pak.ts";

export const WHITE_INDEX = 254;
export const CLEAR_INDEX = 255;

/** A pair's tile page (see the header) and where each picture sits in it. */
export function buildPairPage(pair: FrPair): { page: PageDef; art: TileArt; clut: Uint32Array } {
  const W = pair.cols * 16;
  const R = pair.rows * 16;
  const H = 2 * R + 16;
  const tex = new Uint8Array(W * H).fill(CLEAR_INDEX);
  for (let i = 0; i < W * R; i++) {
    const u = pair.under[i]!;
    const o = pair.over[i]!;
    if (u >= WHITE_INDEX || o >= WHITE_INDEX) throw new Error(`${pair.name}: texel ${Math.max(u, o)} collides with the reserved indices`);
    tex[i] = u;
    tex[W * R + i] = o !== 0 ? o : u;
  }
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) tex[(2 * R + y) * W + x] = WHITE_INDEX;
  const clut = new Uint32Array(pair.clut);
  clut[WHITE_INDEX] = 0xffffffff;
  clut[CLEAR_INDEX] = 0x00000000;
  const at = (slot: number, y0: number): [number, number] => [(slot % pair.cols) * 16, y0 + Math.floor(slot / pair.cols) * 16];
  return {
    page: { w: W, h: H, kind: ATLAS_KIND.terrain, frames: [tex], name: `fr/${pair.name}` },
    art: { under: (s) => at(s, 0), full: (s) => at(s, R), white: [8, 2 * R + 8] },
    clut,
  };
}

/** The map record the pak's GAME section and world.json carry. */
export function mapRecord(m: FrMap): Record<string, unknown> {
  return {
    index: m.index,
    width: m.width,
    height: m.height,
    pair: m.pair,
    mapType: m.mapType,
    outdoor: m.outdoor,
    connections: m.connections,
    warps: m.warps,
    slot: m.slot,
  };
}

export interface Gen3CookResult {
  id: string;
  index: number;
  bytes: number;
  chunks: number;
  verts: number;
  /** Quads per stream, each card counted once. */
  quads: { terrain: number; sheets: number; water: number; cards: number };
  stats: TerrainStats;
}

/** Cook one map to one pak. */
export function cookFrMap(data: FrData, id: string, outPath: string, opts: { instances?: boolean } = {}): Gen3CookResult {
  const map = data.maps[id];
  if (!map) throw new Error(`unknown FireRed map: ${id}`);
  const pair = loadPair(data.root, map.pair);
  const { page, art, clut } = buildPairPage(pair);
  const t = meshTerrain(data.root, map, pair, art);

  // Cards ride the tree path when instancing (the pak writer dedupes them
  // into TINS shapes); every level of detail draws the same card, so the
  // runtime's choice of level never drops one.
  const instances = opts.instances ?? process.env.FR_CARD_INSTANCES !== "0";
  const cards = instances ? t.cards.map((q) => ({ ...q, tree: true })) : t.cards;
  const geo: MapGeometry = {
    // carved-tree quads must be the terrain stream's suffix (mesh.ts packMap)
    terrain: [...t.terrain, ...t.sheets, ...cards],
    treeCoarse: instances ? t.cards : [],
    treeBox: instances ? t.cards : [],
    water: t.water,
    grass: [],
    flower: [],
    stamps: new Map(),
  };
  const { chunks, stamps } = packMap(geo, { baseY: 0, pageW: page.w, pageH: page.h });
  const verts = chunks.reduce((n, c) => n + c.meshes.reduce((m, mesh) => m + mesh.verts.length, 0), 0);
  const treeLod = chunks.some((c) => c.meshes[MESH_KIND.treeBox]!.indices.length > 0);
  const treeCoarse = chunks.some((c) => c.meshes[MESH_KIND.treeCoarse]!.indices.length > 0);
  const gameJson = new TextEncoder().encode(JSON.stringify({ game: "firered", maps: { [id]: mapRecord(map) } }));
  const { bytes } = writePak({
    palettes: [clut, gbPalette(), gbPalette(), gbPalette()],
    pages: [page],
    maps: [{ mapId: map.index, chunks, stamps }],
    glyphs: [],
    gameJson,
    emotePage: null,
    metaFlags: (treeLod ? VXPK_META_FLAG_TREE_LOD : 0) | (treeCoarse ? VXPK_META_FLAG_TREE_COARSE : 0),
    colour: { maps: [{ mapId: map.index, worldPal: 0, terrainPage: 0 }], pagePal: [0], flags: VXPK_COLOR_FLAG_WORLD },
  });
  mkdirSync(join(outPath, ".."), { recursive: true });
  writeFileSync(outPath, bytes);
  const quads = { terrain: t.terrain.length, sheets: t.sheets.length, water: t.water.length, cards: t.cards.length };
  return { id, index: map.index, bytes: bytes.length, chunks: chunks.length, verts, quads, stats: t.stats };
}

const DIST = join(ROOT, "dist/voxelmon");
export const FR_PAKS = join(DIST, "paks_firered");
export const FR_PAKS_ORIG = join(DIST, "paks_orig_firered");

/** Cook every map (or `only`), then share the atlas and write the index. */
export function cookFireRed(only?: string[], opts: { orig?: string; paks?: string } = {}): number {
  const root = frCacheDir();
  if (!existsSync(join(root, "native/manifest.lua"))) {
    console.error(`gen3cook: no FireRed cache at ${root} (set VOXELMON_FR_CACHE)`);
    return 1;
  }
  const data = loadFrData(root);
  if (data.unmatched.length) console.warn(`gen3cook: census maps with no layout: ${data.unmatched.join(" ")}`);
  const orig = opts.orig ?? FR_PAKS_ORIG;
  const paks = opts.paks ?? FR_PAKS;
  const names = (only ?? Object.keys(data.maps)).sort();
  if (!only) rmSync(orig, { recursive: true, force: true });
  mkdirSync(orig, { recursive: true });
  console.log(`gen3cook: FireRed, ${names.length} maps from ${root}`);
  const results: Gen3CookResult[] = [];
  const t0 = performance.now();
  for (let i = 0; i < names.length; i++) {
    const r = cookFrMap(data, names[i]!, join(orig, `${names[i]}.vxpak`));
    results.push(r);
    if (i % 50 === 0 || i === names.length - 1) console.log(`  [${i + 1}/${names.length}] ${r.id}`);
  }
  const total = results.reduce((n, r) => n + r.bytes, 0);
  console.log(`  ${names.length} paks, ${(total / 1048576).toFixed(1)} MB before sharing, ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  writeFileSync(
    join(orig, "cook_stats.json"),
    JSON.stringify(results.map((r) => ({ id: r.id, index: r.index, bytes: r.bytes, chunks: r.chunks, verts: r.verts, quads: r.quads, ...r.stats })), null, 1),
  );
  if (only) {
    console.log("gen3cook: --only, so stopping after the cooks (no share, no index)");
    return 0;
  }

  // the atlas share: the existing byte transform (tools/cook3ds.ts step 2)
  rmSync(paks, { recursive: true, force: true });
  mkdirSync(paks, { recursive: true });
  const python = process.env.VOXELMON_PYTHON ?? "python3";
  const share = Bun.spawnSync([python, "tools/pak_share_atlas.py", orig, paks, "--verify"], {
    cwd: ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (share.exitCode !== 0) {
    console.error("gen3cook: the atlas share failed");
    return share.exitCode ?? 1;
  }
  // index.txt: "<map id> <name>", the id the paks carry
  const index = names.map((n) => `${data.maps[n]!.index} ${n}`).join("\n");
  writeFileSync(join(paks, "index.txt"), `${index}\n`);
  writeFileSync(
    join(paks, "world.json"),
    JSON.stringify({ game: "firered", maps: Object.fromEntries(names.map((n) => [n, mapRecord(data.maps[n]!)])) }),
  );
  let shared = 0;
  for (const f of readdirSync(paks)) shared += readFileSync(join(paks, f)).length;
  console.log(`  ${paks}: ${readdirSync(paks).filter((f) => f.endsWith(".vxpak")).length} paks + common.vxat + index.txt + world.json, ${(shared / 1048576).toFixed(1)} MB`);
  return 0;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--only");
  const only = at >= 0 && args[at + 1] ? args[at + 1]!.split(",").filter(Boolean) : undefined;
  const o = args.indexOf("--out");
  const orig = o >= 0 && args[o + 1] ? args[o + 1] : undefined;
  process.exit(cookFireRed(only, { orig }));
}

