// The gen3 runtime's field core (dataset, map, connections, layout_native,
// collision, tileset_native + asset_stream/asset_decode/palette,
// tileset_anim, field_cell_prepare, virtual_objects, field_modules,
// field_semantics, object_prepare) on real FireRed cache data through the
// DesktopHost: hydrate the maps, load Pallet Town's layout, check its size,
// warps, connections, collision and tileset, walk the door warp to the
// player's house and back, and run the tileset animation.
import { describe, expect, test, beforeAll } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DesktopHost } from "../voxelmon/game/gen3/platform/desktop.ts";
import { setHost } from "../voxelmon/game/gen3/platform/host.ts";
import { Fs } from "../voxelmon/game/gen3/platform/fs.ts";
import { len } from "../voxelmon/game/gen3/platform/lt.ts";
import { NotPortedError } from "../voxelmon/game/gen3/notported.ts";
import { Dataset } from "../voxelmon/game/gen3/core/dataset.ts";
import { Map } from "../voxelmon/game/gen3/core/map.ts";
import { Connections } from "../voxelmon/game/gen3/core/connections.ts";
import { LayoutNative } from "../voxelmon/game/gen3/core/layout_native.ts";
import { Collision } from "../voxelmon/game/gen3/core/collision.ts";
import { InteractionScripts } from "../voxelmon/game/gen3/core/scripting/interaction_scripts.ts";
import { NativeTileset } from "../voxelmon/game/gen3/core/tileset_native.ts";
import { TilesetAnim } from "../voxelmon/game/gen3/core/tileset_anim.ts";
import { Palette } from "../voxelmon/game/gen3/core/palette.ts";
import { Prepare as Cells } from "../voxelmon/game/gen3/core/field_cell_prepare.ts";
import { VirtualObjects } from "../voxelmon/game/gen3/core/virtual_objects.ts";
import { FieldModules } from "../voxelmon/game/gen3/core/field_modules.ts";
import { Sem } from "../voxelmon/game/gen3/core/field_semantics.ts";
import { Prepare as ObjectPrepare } from "../voxelmon/game/gen3/core/object_prepare.ts";
import { VoidFill } from "../voxelmon/game/gen3/core/void_fill.ts";

const ROOT = join(homedir(), "gen3ref/frfull");

describe.skipIf(!existsSync(ROOT))("gen3 runtime: field core on FireRed data", () => {
  let maps: Record<string, any>;
  let game: any;

  beforeAll(() => {
    setHost(new DesktopHost(ROOT));
    Dataset.mountExtractRoots();
    maps = Dataset.buildMaps();
    game = { data: { maps } };
    // Brian's extract_scripts installs the behaviour tables from objects/pack.lua
    const [chunk] = Fs.load("data/generated/gba/objects/pack.lua");
    InteractionScripts.install(chunk!() as any);
  });

  test("hydrates every map def from the cache", () => {
    expect(Object.keys(maps).length).toBe(425);
    const P = maps.FR_PALLET_TOWN;
    expect(P.width).toBe(24);
    expect(P.height).toBe(20);
    expect(P.pair).toBe("pallet_outdoor");
    expect(P.tileset).toBe("FR_PALLET_OUTDOOR");
    // header.json (map_tree) metadata
    expect(P.regionMapSectionId).toBe(88);
    expect(P.music).toBe(300);
    expect(P.mapType).toBe(1);
    expect(P.showMapName).toBe(1);
    expect(P.bikingAllowed).toBe(1);
    expect(Dataset.isOutdoorMapType(P.mapType)).toBe(true);
    expect(Dataset.kindOfMapType(4)).toEqual(["indoor", "INDOOR"]);
  });

  test("Pallet's warps: the player's house, the rival's house and Oak's lab", () => {
    const w = maps.FR_PALLET_TOWN.warps;
    expect(len(w)).toBe(3);
    expect(w[1]).toEqual({ x: 6, y: 7, destMap: "FR_PLAYERS_HOUSE_1F", destWarp: 2 });
    expect(w[2]).toMatchObject({ x: 15, y: 7, destMap: "FR_RIVALS_HOUSE" });
    expect(w[3]).toEqual({ x: 16, y: 13, destMap: "FR_OAKS_LAB", destWarp: 1 });
  });

  test("Pallet connects north to Route 1 (and south to Route 21)", () => {
    const conns = Connections.each(maps.FR_PALLET_TOWN);
    expect(len(conns)).toBe(2);
    expect(conns[1]).toEqual({ dir: "north", map: "FR_ROUTE_1", offset: 0 });
    expect(conns[2]).toEqual({ dir: "south", map: "FR_ROUTE_21_NORTH", offset: 0 });
    // keyed connections ({ north = {...} }) sort after the sequence
    expect(Connections.each({ connections: { west: "A", east: { map: "B", offset: 3 } } }))
      .toEqual([null, { dir: "east", map: "B", offset: 3 }, { dir: "west", map: "A", offset: 0 }]);
  });

  test("mid layouts attach, with Brian's border tiling", () => {
    expect(Dataset.attachMidLayouts(maps)).toBe(425);
    const L: LayoutNative = maps.FR_PALLET_TOWN.midLayout;
    expect(L).toBeInstanceOf(LayoutNative);
    expect([L.width, L.height, L.borderWidth, L.borderHeight]).toEqual([24, 20, 2, 2]);
    expect(L.borderMids).toEqual([null, 28, 29, 20, 21]);
    // out of bounds: the 2x2 border tiled from (0,0), collision 0xff
    expect(L.midAt(-1, -1)).toBe(21);
    expect(L.midAt(-2, -2)).toBe(28);
    expect(L.collAt(-1, 3)).toBe(0xff);
    expect(Connections.sizeOf(maps.FR_ROUTE_1)).toEqual([24, 40]);
    const coll = L.collArray();
    expect(coll[7 * 24 + 6 + 1]).toBe(L.collAt(6, 7));
    // stamp writes overrides (no FieldView needed)
    const copy = LayoutNative.fromDecoded({ width: 1, height: 1, cells: [null, { mid: 0x55, coll: 0, elev: 3 }] }, "X", "p");
    expect(copy.stamp({ width: 1, height: 1, cells: [null, { mid: 7, coll: 1, elev: 2 }] }, 0, 0)).toBe(1);
    expect(copy.cellAt(0, 0)).toEqual({ mid: 7, coll: 1, elev: 2 });
    // void_fill reaches layouts through the map module's registration
    expect(VoidFill.loaded.map).toBeDefined();
  });

  test("collision at known Pallet tiles", () => {
    expect(Collision.bindMap(game, "FR_PALLET_TOWN", maps.FR_PALLET_TOWN)).toBe(true);
    // the player's house door: a door cell with MB_WARP_DOOR (0x69)
    expect(Collision.cell(6, 7)).toBe(0x71);
    expect(Collision.behavior(6, 7)).toBe(0x69);
    // the wall above it is solid; the path in front is open
    expect(Collision.cell(6, 6)).toBe(0x07);
    expect(Collision.isWalkable(6, 6)).toBe(false);
    expect(Collision.isWalkable(6, 8)).toBe(true);
    // the mailbox / sign beside the door: MB_SIGNPOST-ish 0x84
    expect(Collision.behavior(4, 7)).toBe(0x84);
    expect(Collision.inBounds(23, 19)).toBe(true);
    expect(Collision.inBounds(24, 0)).toBe(false);
    expect(Collision.warpAt(6, 7)).toEqual(maps.FR_PALLET_TOWN.warps[1]);
    expect(Collision.warpAt(16, 13)).toEqual(maps.FR_PALLET_TOWN.warps[3]);
    expect(Collision.warpAt(6, 8)).toBeUndefined();
    // Route 1 has tall grass; Pallet has none
    let pallet = 0;
    for (let y = 0; y < 20; y++) for (let x = 0; x < 24; x++) if (Collision.isGrass(x, y)) pallet++;
    expect(pallet).toBe(0);
    Collision.bindMap(game, "FR_ROUTE_1", maps.FR_ROUTE_1);
    let route = 0;
    for (let y = 0; y < 40; y++) for (let x = 0; x < 24; x++) if (Collision.isGrass(x, y)) route++;
    expect(route).toBeGreaterThan(20);
  });

  test("walk the warp: Pallet's door to the player's house and back", () => {
    Collision.bindMap(game, "FR_PALLET_TOWN", maps.FR_PALLET_TOWN);
    const door = Collision.warpAt(6, 7);
    const dest = maps[door.destMap];
    const arrive = dest.warps[door.destWarp];
    expect(door.destMap).toBe("FR_PLAYERS_HOUSE_1F");
    expect([arrive.x, arrive.y]).toEqual([4, 8]);
    Collision.bindMap(game, door.destMap, dest);
    const back = Collision.warpAt(arrive.x, arrive.y);
    expect(back).toMatchObject({ destMap: "FR_PALLET_TOWN", destWarp: 1 });
    // pret: a header warp is live only on a warp behaviour (5,8 and 3,9 are not)
    expect(Collision.warpAt(5, 8)).toBeUndefined();
    expect(Collision.warpAt(3, 9)).toBeUndefined();
    const home = maps[back.destMap].warps[back.destWarp];
    expect([home.x, home.y]).toEqual([6, 7]);
  });

  test("Map: neighbours, world graph and cross-map sampling", () => {
    const P = maps.FR_PALLET_TOWN;
    const n = Map.loadNeighborsDepth1(game, P);
    expect(n.north!.map).toBe("FR_ROUTE_1");
    expect(n.south!.map).toBe("FR_ROUTE_21_NORTH");
    expect(len(Map.overscanSlices())).toBe(2);
    const R1 = maps.FR_ROUTE_1.midLayout;
    // one cell north of Pallet is Route 1's bottom row
    const [mid, pair, isVoid] = Map.worldMidAt(5, -1, P);
    expect(mid).toBe(R1.midAt(5, 39));
    expect(pair).toBe(R1.pair);
    expect(isVoid).toBeUndefined();
    expect(Map.worldMidAt(3, 4, P)[0]).toBe(P.midLayout.midAt(3, 4));
    const world = Map.computeWorld(maps, "FR_PALLET_TOWN", Map.WORLD_HOPS, 15, 10);
    const ids = new Set<string>();
    for (let i = 1; i <= len(world); i++) ids.add(world[i].id);
    expect(ids.has("FR_ROUTE_1")).toBe(true);
    expect(ids.has("FR_VIRIDIAN_CITY")).toBe(true);
    const viridian = [...Array(len(world)).keys()].map((i) => world[i + 1]).find((e: any) => e.id === "FR_VIRIDIAN_CITY");
    // Route 1 is 40 cells tall; Viridian joins it at offset -12
    expect(viridian.oy).toBe(-40 - maps.FR_VIRIDIAN_CITY.midLayout.height);
    expect(viridian.ox).toBe(-12);
  });

  test("Map.load runs until its first unported neighbour", () => {
    let err: unknown;
    try {
      Map.load(undefined, game, "FR_PALLET_TOWN", { x: 6, y: 8 });
    } catch (e) {
      err = e;
    }
    // (an unported neighbour: a NotPortedError stub, or encounters' unbound encounter_rules)
    if (err !== undefined) expect(err instanceof NotPortedError || /not ported/.test(String((err as Error).message))).toBe(true);
    // Encounters.resetRateModifiers comes first and throws while its rules are
    // unbound; past it, the map is current before the runtime stub is reached.
    if (err === undefined || err instanceof NotPortedError) {
      expect(Map.current).toBe("FR_PALLET_TOWN");
      expect(Map.currentDef()).toBe(maps.FR_PALLET_TOWN);
    }
    expect(Map.load(undefined, game, "NOT_A_MAP")).toEqual([undefined, "not a game3 map"]);
  });

  test("the native atlas loads and the tileset animation advances", () => {
    NativeTileset.install(Dataset.cache());
    expect(NativeTileset.ready("pallet_outdoor")).toBe(true);
    expect(NativeTileset.ready("no_such_pair")).toBe(false);
    const ts = NativeTileset.get("pallet_outdoor")!;
    expect([ts.cols, ts.rows, ts.midCount, ts.layered]).toEqual([16, 11, 169, true]);
    expect(ts.image!.getDimensions()).toEqual([256, 176]);
    expect(ts.overImage).toBeDefined();
    const L = maps.FR_PALLET_TOWN.midLayout;
    expect(NativeTileset.hasMid(ts, L.midAt(6, 7))).toBe(true);
    expect(NativeTileset.quad(ts, 17)!.getViewport()).toEqual([16, 16, 16, 16]);
    // map palette slot 0 colour 0 is black (pret)
    const [rgb, bgr] = Palette.load(Fs.read("data/generated/gba/native/pallet_outdoor/palettes.bin"));
    expect(rgb![0]![0]).toEqual([0, 0, 0]);
    expect((bgr as any)[0][0]).toBe(0);
    expect(Palette._md5hex("")).toBe("d41d8cd98f00b204e9800998ecf8427e");
    expect(Palette._md5hex("The quick brown fox jumps over the lazy dog")).toBe("9e107d9d372bb6826bd81d3542a419d6");
    // tileset_anim bound the pair when the atlas was published
    const entry: any = TilesetAnim._pairs["pallet_outdoor"];
    expect(entry && entry.banks.water).toBeDefined();
    TilesetAnim.setVisiblePairs({ pallet_outdoor: true });
    const before = ts.imageData!.px.slice();
    const w0 = TilesetAnim._waterFrame;
    for (let i = 0; i < 64; i++) TilesetAnim.step();
    expect(TilesetAnim.counter).toBe(64);
    expect(TilesetAnim._waterFrame).not.toBe(w0);
    let changed = 0;
    const after = ts.imageData!.px;
    for (let i = 0; i < after.length; i++) if (after[i] !== before[i]) changed++;
    expect(changed).toBeGreaterThan(0);
  });

  test("field_cell_prepare resolves a worker snapshot of Pallet (packed layout)", () => {
    const L = maps.FR_PALLET_TOWN.midLayout;
    const packed = L.workerPacked();
    expect(packed).toBeDefined();
    const s = {
      x0: -2, y0: -2, cols: 6, rows: 6, mode: "map",
      layouts: [null, { x0: -2, y0: -2, w: 28, h: 24, width: 24, height: 20, pair: "pallet_outdoor", blob: "", packed }],
      neighbors: [null], world: [null],
    };
    const plan = Cells.cells(s);
    expect(plan.pairs).toEqual([null, "pallet_outdoor"]);
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) expect(Cells.cell(plan, x, y)[0]).toBe(L.midAt(x, y));
    }
    const [mid, pair, isVoid, skip] = Cells.cell(plan, -1, -1);
    expect([mid, pair, isVoid, skip]).toEqual([L.midAt(-1, -1), "pallet_outdoor", true, false]);
    expect(Cells.cell(plan, 50, 50)[0]).toBeUndefined();
  });

  test("small modules: virtual objects, field modules, semantics, object prep", () => {
    VirtualObjects.reset();
    VirtualObjects.spawn(1, 5, 3, 4, undefined, undefined);
    VirtualObjects.spawn(2, 6, 0, 0, 2, 3);
    expect(VirtualObjects.count()).toBe(2);
    expect(VirtualObjects.get(1)).toEqual({ id: 1, graphicsId: 5, x: 3, y: 4, elevation: 3, direction: 1 });
    expect(VirtualObjects.turn(1, 4)).toBe(true);
    expect(VirtualObjects.turn(9, 4)).toBe(false);
    expect(VirtualObjects.remove(1)).toBe(true);
    expect(VirtualObjects.list()).toEqual([null, VirtualObjects.get(2)]);
    VirtualObjects.clear();
    expect(VirtualObjects.slots()).toBe(0);

    expect(FieldModules.enabled("vsSeeker")).toBe(true);
    expect(() => FieldModules.enabled("nope")).toThrow();
    expect(Sem.var(undefined, "repelSteps")).toBe(0x4020);
    expect(Sem.flag(undefined, "flashActive")).toBe(0x806);

    // (no movementType: hostSpec's in-place table needs constants.ts's emerald movement set, not registered yet)
    const eo = ObjectPrepare.instance({ localId: 3, x: 7, y: 9, graphicsId: 0, facing: "UP" }, { version: "firered", mapId: "FR_PALLET_TOWN" });
    expect([eo.facing, eo.movement, eo.range]).toEqual(["up", "STAY", "DOWN"]);
    expect([eo.localId, eo.cellX, eo.cellY, eo.px, eo.py, eo.sprite]).toEqual([3, 7, 9, 112, 144, "SPRITE_CHRIS"]);
    expect(eo.originMapId).toBe("FR_PALLET_TOWN");
    expect(ObjectPrepare.matches({ a: [null, 1, { b: 2 }] }, { a: [null, 1, { b: 2 }] })).toBe(true);
    expect(ObjectPrepare.matches({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(ObjectPrepare.freeze({ f: () => 1 })).toBeUndefined();
  });
});
