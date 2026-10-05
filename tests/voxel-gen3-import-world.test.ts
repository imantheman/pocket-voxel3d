// The gen3 (FireRed) importer's "world" cluster -- map census and catalog,
// tilesets, metatiles, native mid atlases / palettes / layouts, tileset
// animation banks and the map_tree mirror -- against gen1recomp's own
// importer under LuaJIT (the reference cache, see tests/gen3-import-harness.ts).
//
// The modules are driven exactly as src/import/gba/extract_island1.lua's
// Extract.run drives them (FRLG sequential plan, scripts not skipped). The
// orchestrator itself is not ported yet; its glue (pad_even,
// unique_mids_by_pair, the mid_index / meta / warps / connections writers) is
// mirrored here line for line so those files check the modules' data too.
// The one input another, not-yet-ported stage produces -- extract_scripts'
// extractFromRom bundle, which scriptMids is built from -- is read from the
// reference scripts.lua / events.lua that writeBundleFromRom wrote from the
// very same bundle.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stageCtx, skipReason, compareWrites, referenceFiles, REF_ROOT, GBA_ROOT } from "./gen3-import-harness.ts";
import { parseLuaModule, type LuaValue } from "../voxelmon/import/lua.ts";
import { format, tostring, tonumber } from "../voxelmon/import/gen3/lua.ts";
import { luaGet, luaLen } from "../voxelmon/import/gen3/luatable.ts";
import { Versions } from "../voxelmon/import/gen3/versions.ts";
import { Rom } from "../voxelmon/import/gen3/rom.ts";
import { MapTree } from "../voxelmon/import/gen3/map_tree.ts";
import { MapCatalog } from "../voxelmon/import/gen3/map_catalog.ts";
import { Tileset, type TilesetBundle } from "../voxelmon/import/gen3/tileset.ts";
import { Maps, type Grid, type Border, type Cell } from "../voxelmon/import/gen3/maps.ts";
import { AltLayouts } from "../voxelmon/import/gen3/alt_layouts.ts";
import { NativePack } from "../voxelmon/import/gen3/native_pack.ts";
import { AnimPack } from "../voxelmon/import/gen3/tileset_anim_pack.ts";
import { ExtractMapEvents, type Warp } from "../voxelmon/import/gen3/extract_map_events.ts";
import { MapTreeExtract } from "../voxelmon/import/gen3/map_tree_extract.ts";
import { Layouts } from "../voxelmon/import/gen3/layouts.ts";
import { Plans } from "../voxelmon/import/gen3/plans.ts";
import { Collision } from "../voxelmon/game/gen3/core/scripting/collision.ts";
import { Opcodes } from "../voxelmon/game/gen3/core/scripting/opcodes.ts";
import { GfxIds } from "../voxelmon/game/gen3/core/scripting/gfx_ids.ts";
import { InteractionScripts } from "../voxelmon/game/gen3/core/scripting/interaction_scripts.ts";
import { MovementTypes } from "../voxelmon/game/gen3/core/movement_types.ts";
import { Constants } from "../voxelmon/game/gen3/core/constants.ts";
import { VoidFill } from "../voxelmon/game/gen3/core/void_fill.ts";
import { CollPermissions } from "../voxelmon/game/gen3/shared/core/CollPermissions.ts";

const ctx = stageCtx();
if (!ctx) console.log(`voxel-gen3-import-world: skipping -- ${skipReason()}`);

// ------------------------------------------------------------ no ROM

describe("gen3 world core modules (no ROM)", () => {
  test("constants, opcodes, movement types", () => {
    const fr = Constants.of("leafgreen");
    expect(fr.game).toBe("firered");
    expect(fr.require("flags", "FLAG_HIDDEN_ITEMS_START")).toBe(1000);
    expect(fr.name("movement", 12, "MOVEMENT_TYPE_")).toBe("MOVEMENT_TYPE_BERRY_TREE_GROWTH");
    expect(() => fr.require("flags", "NOPE")).toThrow();
    expect(Opcodes.key(0x081bb8c3)).toBe("g3:081bb8c3");
    expect(Opcodes.get(0xa2)!.name).toBe("setmetatile");
    expect(Opcodes.MAX).toBe(0xd4);
    const set = Opcodes.forGame("firered");
    expect(set.trainerBattleType(4)).toBe("DOUBLE");
    expect(MovementTypes.canon("firered", 12)).toBe(12);
    expect(MovementTypes.canon("firered", 0x123)).toBe(0x123);
    expect(MovementTypes.nameOf("firered", 12)).toBe("MOVEMENT_TYPE_BERRY_TREE_GROWTH");
  });

  test("collision, permissions, gfx ids, interactions, void fill, layouts, plans", () => {
    expect(Collision.fromCell(0x00A, 1, 0, "town")).toEqual([0x07, "TREE", undefined]);
    expect(Collision.fromCell(5, 0, 0x60, "indoor")[0]).toBe(0x72);
    expect(Collision.fromCell(5, undefined, 0x38)).toEqual([0xA0, "LEDGE", "E"]);
    expect(CollPermissions.isLedge(0xA2)).toBe(true);
    expect(CollPermissions.isWater(0x29)).toBe(true);
    expect(CollPermissions.of(-1)).toBe(CollPermissions.WALL);
    expect(GfxIds.hostMovement(0x02, 0, 3)).toMatchObject({ movement: "WALK", range: "ANY_DIR", radius: { x: 1, y: 3 } });
    expect(GfxIds.hostMovement(0x1D, 2, 2).route).toEqual(["up", "right", "left", "down"]);
    expect(GfxIds.initialFacing(0x09)).toBe("left");
    expect(InteractionScripts.scriptFor(0x81, "down")).toBe("EventScript_Bookshelf");
    expect(InteractionScripts.scriptFor(0x86, "down")).toBeUndefined();
    expect(InteractionScripts.scriptFor(0x86, "up")).toBe("EventScript_PlayerFacingTVScreen");
    expect(VoidFill.cycle("map", -1)).toBe("black");
    expect(VoidFill.fillAt("black", 0, 0)).toBe(false);
    expect(VoidFill.primaryFor("general__rom_082d4af4")).toBe("general");
    expect(Layouts.of("leafgreen").trainerNameLen).toBe(12);
    expect(Layouts.pockets(Layouts.of("firered"))[1]).toBe("ITEMS");
    const plan = Plans.of("firered");
    expect(Plans.list(plan.sequential)).toEqual(["gba", "pokemon", "aux", "intro_audio"]);
    expect(Plans.modules(plan)).toContain("src.import.gba.region_map_extract");
  });

  test("native pack blobs round-trip", () => {
    const layout = {
      width: 2, height: 2, trueWidth: 1, trueHeight: 2, borderWidth: 2, borderHeight: 1, borderMids: [3, 4], flags: 1,
      cells: [{ mid: 1, coll: 2, elev: 3 }, { mid: 1023, coll: 0xff, elev: 0 }, { mid: 0, coll: 0, elev: 15 }, { mid: 640, coll: 7, elev: 1 }],
    };
    const [back] = NativePack.decodeMidLayout(NativePack.encodeMidLayout(layout));
    expect(back).toMatchObject(layout);
    const idx = { formatVersion: 1, flags: 2, midCount: 2, atlasCols: 16, atlasRows: 1, midIds: [5, 9], pixels: new Uint8Array(512).map((_, i) => i & 255) };
    const [d] = NativePack.decodeIdx(NativePack.encodeIdx(idx));
    expect(d!.midIds).toEqual([5, 9]);
    expect(Array.from(d!.pixels)).toEqual(Array.from(idx.pixels));
  });
});

// ------------------------------------------------------------ the extract_island1 glue

// Lua: extract_island1.lua:262
const MAP_ORDER = [
  "SEVII_ONE_ISLAND",
  "SEVII_ONE_ISLAND_KINDLE_ROAD",
  "SEVII_ONE_ISLAND_TREASURE_BEACH",
  "SEVII_ONE_ISLAND_POKECENTER",
  "SEVII_ONE_ISLAND_POKECENTER_2F",
  "SEVII_ONE_ISLAND_HARBOR",
  "SEVII_ONE_ISLAND_HOUSE1",
  "SEVII_ONE_ISLAND_HOUSE2",
  "FR_PALLET_TOWN",
  "FR_ROUTE_1",
  "FR_VIRIDIAN_CITY",
  "FR_ROUTE_2",
  "FR_PLAYERS_HOUSE_1F",
  "FR_PLAYERS_HOUSE_2F",
  "FR_RIVALS_HOUSE",
  "FR_OAKS_LAB",
  "FR_PEWTER_CITY",
  "FR_PEWTER_CITY_GYM",
];

// Lua: extract_island1.lua:73 pad_even (cells 0-based)
function padEven(grid: Grid): Grid {
  const w = grid.width, h = grid.height;
  const nw = w + (w % 2);
  const nh = h + (h % 2);
  if (nw === w && nh === h) return grid;
  const indoor = grid.environment === "INDOOR" || grid.kind === "indoor";
  const voidCell: Cell = { mid: 0, coll: 1, elev: 0 };
  const cells: Cell[] = [];
  const at = (x: number, y: number): Cell => {
    if (indoor && (x >= w || y >= h)) return voidCell;
    const sx = Math.min(x, w - 1);
    const sy = Math.min(y, h - 1);
    return grid.cells[sy * w + sx]!;
  };
  for (let y = 0; y <= nh - 1; y++) {
    for (let x = 0; x <= nw - 1; x++) {
      const c = at(x, y);
      cells.push({ mid: c.mid, coll: c.coll, elev: c.elev });
    }
  }
  return {
    width: nw, height: nh, cells, map_id: grid.map_id, kind: grid.kind, pair: grid.pair,
    environment: grid.environment, padded_from: { width: w, height: h },
  };
}

// Lua: extract_island1.lua:115 (its own copy of the table)
const DYNAMIC_MIDS_BY_PAIR: Record<string, number[]> = {
  network: [0x2D0, 0x2D1, 0x2D8, 0x2D9, 0x2E3, 0x2E4, 0x2EB, 0x2EC, 0x308, 0x309, 0x30A, 0x30B, 0x310, 0x311, 0x312, 0x313, 0x314, 0x315, 0x316, 0x317, 0x31C, 0x31E],
  pokemon_center: [0x2D0, 0x2D1, 0x2D8, 0x2D9, 0x2E3, 0x2E4, 0x2EB, 0x2EC, 0x308, 0x309, 0x30A, 0x30B, 0x310, 0x311, 0x312, 0x313, 0x314, 0x315, 0x316, 0x317, 0x31C, 0x31E],
  dept_store: [0x28D, 0x2D0, 0x2D1, 0x2D8, 0x2D9, 0x2E3, 0x2E4, 0x2EB, 0x2EC, 0x308, 0x309, 0x30A, 0x30B, 0x310, 0x311, 0x312, 0x313, 0x314, 0x315, 0x316, 0x317, 0x31C, 0x31E],
};

// Lua: extract_island1.lua:142 unique_mids_by_pair
function uniqueMidsByPair(grids: Record<string, Grid>, scriptMids: Record<string, Set<number>>): Record<string, number[]> {
  const byPair: Record<string, Set<number>> = {};
  for (const grid of Object.values(grids)) {
    const pair = grid.pair ?? "sevii_outdoor";
    const seen = (byPair[pair] ??= new Set());
    for (const cell of grid.cells) seen.add(cell.mid);
  }
  for (const pair of Object.keys(scriptMids)) {
    const seen = byPair[pair];
    if (seen) for (const mid of scriptMids[pair]!) seen.add(mid);
  }
  for (const pair of Object.keys(DYNAMIC_MIDS_BY_PAIR)) {
    const seen = byPair[pair];
    if (seen) for (const mid of DYNAMIC_MIDS_BY_PAIR[pair]!) seen.add(mid);
  }
  for (const pair of Object.keys(byPair)) NativePack.addDynamicMids(byPair[pair]!, pair);
  const out: Record<string, number[]> = {};
  for (const pair of Object.keys(byPair)) {
    const seen = byPair[pair]!;
    NativePack.addPcOnMids(seen);
    out[pair] = Array.from(seen).sort((a, b) => a - b);
  }
  return out;
}

// Lua: extract_island1.lua:42 write_json (its own encoder)
function islandJson(v: unknown): string {
  const esc = (s: string): string => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  if (v === undefined || v === null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return tostring(v);
  if (typeof v === "string") return '"' + esc(v) + '"';
  if (Array.isArray(v) && v.length > 0) return "[" + v.map(islandJson).join(",") + "]";
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  return "{" + keys.map((k) => '"' + esc(k) + '":' + islandJson(o[k])).join(",") + "}";
}

/** A parsed Lua literal as the port's JS shapes (sequence → array, else object with integer keys). */
function toJs(v: LuaValue): any {
  if (typeof v !== "object") return v;
  if (v.hash.size === 0) return v.array.map(toJs);
  const o: Record<string, unknown> = {};
  v.array.forEach((x, i) => { o[String(i + 1)] = toJs(x); });
  for (const [k, x] of v.hash) o[k] = toJs(x);
  return o;
}

function refLua(rel: string): any {
  return toJs(parseLuaModule(readFileSync(join(REF_ROOT, rel)).toString("latin1"), rel));
}

describe.skipIf(!ctx)("gen3 import world cluster against the reference", () => {
  test("extract_island1's world stages and map_tree_extract write the reference bytes", () => {
    const { imports, cache } = ctx!;
    const root = GBA_ROOT;

    // Lua: extract_island1.lua:284-299
    const importId = ctx!.version;
    const info = imports.info(importId)!;
    const [version, verr] = Versions.lookup(info.md5);
    expect(verr).toBeUndefined();
    const [rom] = Rom.open(imports, importId);

    // Lua: extract_island1.lua:302-309 -- full census, registered in order
    MapCatalog.rebuildIndex();
    const [census] = MapTree.walk(rom!, version);
    const [mapOrder, byEngine] = MapCatalog.allOrder(census!, MAP_ORDER);
    MapCatalog.registerOrder(rom!, version, mapOrder, byEngine);

    // Lua: extract_island1.lua:312-332
    const needed = new Set<string>();
    for (const mapId of mapOrder) {
      const spec = Versions.MAPS[mapId];
      needed.add((spec && spec.pair) || "sevii_outdoor");
    }
    const pairNames = Array.from(needed).sort();
    const bundles: Record<string, TilesetBundle> = {};
    for (const pairName of pairNames) {
      try {
        const [b, err] = Tileset.loadPair(rom!, version, pairName);
        if (b) bundles[pairName] = b;
        else console.log("[extract] skip tileset pair " + pairName + ": " + String(err));
      } catch (e) {
        console.log("[extract] skip tileset pair " + pairName + ": " + String(e));
      }
    }

    // Lua: extract_island1.lua:334-368
    const grids: Record<string, Grid> = {};
    const dropped: string[] = [];
    for (const mapId of mapOrder) {
      const spec = Versions.MAPS[mapId];
      const layoutSpec = spec && version.layouts && version.layouts[spec.layout];
      if (layoutSpec && bundles[spec.pair]) {
        const grid = Maps.loadGrid(rom!, layoutSpec);
        grid.map_id = mapId;
        grid.kind = spec.kind;
        grid.pair = spec.pair;
        grid.environment = spec.environment;
        grids[mapId] = padEven(grid);
      } else if (spec) {
        dropped.push(mapId);
      }
    }
    expect(dropped).toEqual([]);
    const borders: Record<string, Border> = {};
    for (const mapId of mapOrder) {
      if (grids[mapId]) borders[mapId] = Maps.loadBorder(rom!, version, mapId);
    }
    AltLayouts.build(rom!, version, grids, borders, padEven);
    // extract_scripts.extractFromRom's bundle, as writeBundleFromRom wrote it
    const extractedScripts = {
      scripts: refLua(GBA_ROOT + "/scripts/scripts.lua"),
      events: refLua(GBA_ROOT + "/scripts/events.lua"),
    };
    const scriptMids = NativePack.scriptMidsByPair(extractedScripts.scripts, extractedScripts.events, (mapId) => {
      const grid = grids[mapId];
      return grid ? (grid.pair ?? "sevii_outdoor") : undefined;
    });

    // Lua: extract_island1.lua:370-407 -- mid_index.lua
    const midsByPair = uniqueMidsByPair(grids, scriptMids);
    let totalMids = 0;
    for (const list of Object.values(midsByPair)) totalMids += list.length;
    const midIndex: Record<string, Record<number, { tiles: number[]; coll: number; behavior: number; category: string }>> = {};
    for (const pairName of pairNames) {
      midIndex[pairName] = {};
      for (const mid of midsByPair[pairName] ?? []) {
        const behavior = Tileset.behaviorOf(bundles[pairName]!, mid) || 0;
        const coll = Collision.fromCell(mid, 0, behavior, "outdoor")[0] || 0;
        midIndex[pairName]![mid] = { tiles: [0, 0, 0, 0], coll, behavior, category: "misc" };
      }
    }
    const miL = ["return {\n"];
    for (const pairName of pairNames) {
      miL.push(format("  [%q] = {\n", pairName));
      for (const mid of midsByPair[pairName] ?? []) {
        const i2 = midIndex[pairName]![mid]!;
        miL.push(format("    [%d] = { tiles = {%s}, coll = %d, behavior = %d, category = %q },\n",
          mid, i2.tiles.join(","), i2.coll, i2.behavior, i2.category));
      }
      miL.push("  },\n");
    }
    miL.push("}\n");
    cache.write(root + "/mid_index.lua", miL.join(""));

    // Lua: extract_island1.lua:409-422 -- meta.json
    cache.write(root + "/meta.json", islandJson({
      cache_version: Versions.CACHE_VERSION,
      native_version: Versions.NATIVE_VERSION ?? 5,
      md5: Versions.normalizeMd5(info.md5),
      version_id: version.id,
      import_id: importId,
      mid_count: totalMids,
      tile_count: 0,
      block_count: 0,
      imageWidth: 0,
      imageHeight: 0,
      tilesPerRow: 16,
      maps: mapOrder,
    }) + "\n");

    // Lua: extract_island1.lua:424-462 -- warps + connections from ROM
    const warps: Record<string, Warp[]> = {};
    const connections: Record<string, { dir: string; map: string; offset: number }[]> = {};
    {
      const [romW] = Rom.open(imports, importId);
      const [romWarps, romConns] = ExtractMapEvents.extractWarpsAndConnections(romW!, version);
      for (const mapId of mapOrder) {
        const list = romWarps[mapId];
        if (list && list.length > 0) {
          for (const w of list) {
            if (!w.destMap && w.mapGroup !== undefined) w.destMap = MapCatalog.mapIdFor(w.mapGroup, w.mapNum);
          }
          warps[mapId] = list;
        } else {
          const hand = Versions.WARPS[mapId];
          warps[mapId] = hand ? Plans.list<Warp>(hand) : [];
        }
      }
      for (const mapId of mapOrder) {
        const conns = romConns[mapId] ?? [];
        const fixed: { dir: string; map: string; offset: number }[] = [];
        for (const c of conns as any[]) {
          let dest: string | undefined = c.map;
          if ((!dest || /^g\d+_m\d+$/.test(dest)) && c.mapGroup !== undefined) {
            dest = MapCatalog.mapIdFor(c.mapGroup, c.mapNum) ?? dest;
          } else if (dest) {
            dest = MapCatalog.resolve(dest) ?? dest;
          }
          if (dest) fixed.push({ dir: c.dir, map: dest, offset: tonumber(c.offset) ?? 0 });
        }
        connections[mapId] = fixed;
      }
    }

    // Lua: extract_island1.lua:465-478 -- native packs
    const warpCells: Record<string, Set<number>> = {};
    for (const mapId of Object.keys(warps)) {
      const set = new Set<number>();
      for (const w of warps[mapId]!) {
        const x = tonumber(w.x), y = tonumber(w.y);
        if (x !== undefined && y !== undefined) set.add(NativePack.warpKey(x, y));
      }
      warpCells[mapId] = set;
    }
    NativePack.writeExtract(cache, root, bundles, grids, borders, pairNames, midIndex,
      Tileset.behaviorOf, Collision.fromCell, scriptMids, warpCells);

    // Lua: extract_island1.lua:481-516 -- tileset anim banks
    {
      const [rom2] = Rom.open(imports, importId);
      const midLists: Record<string, number[]> = {};
      for (const pairName of pairNames) {
        midLists[pairName] = NativePack.collectMidsForPair(grids, borders, pairName, scriptMids);
      }
      AnimPack.writeExtract(rom2!, cache, root, bundles, midLists, version);
    }

    // Lua: extract_island1.lua:518-550 -- warps.lua, connections.lua
    const wl = ["return {\n"];
    for (const mapId of mapOrder) {
      wl.push(format("  %s = {\n", mapId));
      for (const w of warps[mapId] ?? []) {
        const dest = w.destMap ?? MapCatalog.mapIdFor(w.mapGroup, w.mapNum);
        if (dest) {
          wl.push(format("    { x = %d, y = %d, destMap = %q, destWarp = %d },\n", w.x, w.y, dest, w.destWarp ?? 1));
        } else {
          wl.push(format("    { x = %d, y = %d, destMap = nil, destWarp = %d, mapGroup = %d, mapNum = %d },\n",
            w.x, w.y, w.destWarp ?? 1, w.mapGroup ?? 0, w.mapNum ?? 0));
        }
      }
      wl.push("  },\n");
    }
    wl.push("}\n");
    cache.write(root + "/warps.lua", wl.join(""));
    const cl = ["return {\n"];
    for (const mapId of mapOrder) {
      cl.push(format("  %s = {\n", mapId));
      for (const c of connections[mapId] ?? []) {
        cl.push(format("    { dir = %q, map = %q, offset = %d },\n", c.dir, c.map, tonumber(c.offset) ?? 0));
      }
      cl.push("  },\n");
    }
    cl.push("}\n");
    cache.write(root + "/connections.lua", cl.join(""));

    // Lua: extract_island1.lua:571-580 -- normalized map_tree mirror
    const [okTree, treeDetail] = MapTreeExtract.run(rom!, cache, { version, root: root + "/map_tree" });
    expect(okTree).toBe(true);
    expect(treeDetail.map_count).toBe(census!.map_count);

    // Every file written matches the reference...
    expect(compareWrites(cache.files)).toEqual([]);
    // ...and every reference file of these stages was written.
    const want = [
      ...referenceFiles(GBA_ROOT + "/native"),
      ...referenceFiles(GBA_ROOT + "/map_tree"),
      GBA_ROOT + "/mid_index.lua",
      GBA_ROOT + "/warps.lua",
      GBA_ROOT + "/connections.lua",
      GBA_ROOT + "/meta.json",
    ];
    expect(want.filter((p) => !cache.files.has(p))).toEqual([]);
    expect(cache.files.size).toBe(want.length);
    console.log(`voxel-gen3-import-world: ${cache.files.size} files byte-identical (${referenceFiles(GBA_ROOT + "/native").length} native, ${referenceFiles(GBA_ROOT + "/map_tree").length} map_tree)`);
    expect(luaLen(Versions.MAPS)).toBe(0); // MAPS is keyed by engine id, never a sequence
    expect(luaGet(Versions.MAPS, "FR_PALLET_TOWN")).toMatchObject({ pair: "pallet_outdoor", kind: "town" });
  }, 600000);
});
