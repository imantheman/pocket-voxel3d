// Gold's voxel shapes: the Gen 2 branch of the tile classifier (cook/
// classify.ts, a port of Gen2Recomped-DramaticShapes lib/TileShape.lua, MIT)
// and what the cook does with it. The synthetic cases need nothing on disk;
// the last block runs on the Gold import and the fork's profile and skips
// without them.
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  classHeightsGen2,
  resetTileShapeCache,
  sealedCells,
  shapeAt,
  tileShapesFor,
} from "../voxelmon/cook/classify.ts";
import {
  GameMap,
  gen2ProfileKey,
  loadGen,
  loadGen2Profile,
  type MapDef,
  type Profile,
  type TilesetDef,
  voxelmodGen2Dir,
} from "../voxelmon/cook/data.ts";
import type { BuildingStats } from "../voxelmon/cook/buildings.ts";
import { keyOf } from "../voxelmon/cook/geom.ts";
import { analyseMap } from "../voxelmon/cook/structures.ts";

let serial = 0;

/** A one-off Gen 2 map: `blocks` are 4x4 tile ids, `collision` their quadrants. */
function mk(opts: {
  blocks: number[][];
  collision: number[][];
  layout: number[];
  width: number;
  height: number;
  border?: number;
  outdoor?: boolean;
  warps?: { x: number; y: number }[];
  objects?: { x: number; y: number }[];
}): GameMap {
  const id = `TILESET_T${serial++}`;
  const tileset = {
    id,
    image: "tilesets/t",
    imageWidth: 128,
    imageHeight: 48,
    tilesPerRow: 16,
    blocks: opts.blocks,
    collision: opts.collision,
    walkable: [],
  } as unknown as TilesetDef;
  const def = {
    id: `MAP_${id}`,
    index: 0,
    tileset: id,
    width: opts.width,
    height: opts.height,
    blocks: opts.layout,
    borderBlock: opts.border ?? 0,
    outdoor: opts.outdoor ?? true,
    warps: (opts.warps ?? []).map((w) => ({ ...w, destMap: "X", destWarp: 0 })),
    objects: opts.objects ?? [],
  } as MapDef;
  return new GameMap(def, tileset);
}

/** A profile whose one tileset entry applies to `map`. */
function prof(map: GameMap, entry: Record<string, unknown>, collision?: Record<string, string>): Profile {
  return {
    heights: {},
    collision: collision ?? {},
    tilesets: { [map.tileset.id]: entry },
  } as Profile;
}

const at = (map: GameMap, p: Profile, tx: number, ty: number) =>
  shapeAt(map, tileShapesFor(map, p), map.tileAt(tx, ty), tx, ty);

const FLOOR = new Array(16).fill(0x05);

// Gen2Recomped voxel_heights.lua:195 -- the Gold rows of the class table
const COLL: Record<string, string> = {
  "18": "cylinder",
  "21": "cylinder",
  "123": "wall",
  "24": "grass",
  "51": "cliff",
  "113": "wall",
  "144": "counter",
  "145": "bookcase",
  "147": "console",
  "159": "cylinder",
};

describe("Gold shapes: the profile", () => {
  test("a Gold tileset id reads as the fork's pokegold label", () => {
    expect(gen2ProfileKey("TILESET_JOHTO")).toBe("TilesetJohto");
    expect(gen2ProfileKey("TILESET_JOHTO_MODERN")).toBe("TilesetJohtoModern");
    expect(gen2ProfileKey("TILESET_POKECENTER")).toBe("TilesetPokecenter");
    expect(gen2ProfileKey("TILESET_ELITE_FOUR_ROOM")).toBe("TilesetEliteFourRoom");
    expect(gen2ProfileKey("TILESET_DARK_CAVE")).toBe("TilesetDarkCave");
  });

  test("the Gen 2 class vocabulary adds terrace/shell/waterfall/column, and entries override heights", () => {
    const map = mk({ blocks: [FLOOR], collision: [[0, 0, 0, 0]], layout: [0], width: 1, height: 1 });
    const h = classHeightsGen2(prof(map, { heights: { fence: 16 } }), map.tileset.id);
    expect([h.terrace, h.shell, h.waterfall, h.column, h.fence, h.planter]).toEqual([16, 32, 32, 32, 16, 32]);
  });

  test("a Gen 1 tileset (no collision bytes) never takes the Gen 2 branch", () => {
    resetTileShapeCache();
    const tileset = {
      id: `G1_${serial++}`,
      image: "t",
      imageWidth: 128,
      imageHeight: 48,
      tilesPerRow: 16,
      blocks: [FLOOR],
      walkable: [0x05],
    } as unknown as TilesetDef;
    const def = { id: "G1", index: 0, tileset: tileset.id, width: 1, height: 1, blocks: [0], borderBlock: 0 } as MapDef;
    const shapes = tileShapesFor(new GameMap(def, tileset), { collision: COLL } as Profile);
    expect(shapes.gen2).toBeUndefined();
    expect(shapes.coll).toBeUndefined();
  });
});

describe("Gold shapes: collision classes (TileShape.lua:709, :1147)", () => {
  const map = mk({
    // one block per quadrant class; the tiles carry no pin
    blocks: [FLOOR, FLOOR],
    collision: [
      [0x15, 0x18, 0x71, 0x90],
      [0x91, 0x7b, 0x29, 0x07],
    ],
    layout: [0, 1],
    width: 2,
    height: 1,
    border: 0,
  });
  const p = prof(map, {}, COLL);
  const cell = (cx: number, cy: number) => at(map, p, cx * 2, cy * 2)!;

  test("a lone tree is a round hull, tall grass stands in tufts", () => {
    expect([cell(0, 0).class, cell(0, 0).art, cell(0, 0).authored]).toEqual(["cylinder", "cylinder", true]);
    expect([cell(1, 0).class, cell(1, 0).art]).toEqual(["grass", "grass"]);
  });

  test("a walkable door or cave mouth stays wall, so the facade is not punched through", () => {
    expect(cell(0, 1).class).toBe("wall"); // $71 COLL_DOOR
    expect(cell(3, 0).class).toBe("wall"); // $7B COLL_CAVE
    expect(cell(0, 1).authored).toBe(true);
  });

  test("furniture by class: a counter is half a cell, a bookshelf a 32px upright", () => {
    expect([cell(1, 1).class, cell(1, 1).h]).toEqual(["counter", 8]);
    // the collapse builder is not ported: the stand-in is the authored fold
    expect([cell(2, 0).class, cell(2, 0).art, cell(2, 0).h]).toEqual(["bookcase", "upright", 32]);
  });

  test("water by class, and an unpinned wall stays the detector's", () => {
    expect(cell(2, 1).class).toBe("water");
    expect([cell(3, 1).class, cell(3, 1).authored]).toEqual(["wall", false]);
  });
});

describe("Gold shapes: tile pins over classes", () => {
  // block 0: Johto's tree wall ($05 in the atlas), block 1: a lone tree
  const TREE_WALL = [0x1e, 0x1f, 0x1e, 0x1f, 0x2e, 0x2f, 0x2e, 0x2f, 0x2e, 0x2f, 0x2e, 0x2f, 0x3e, 0x3f, 0x3e, 0x3f];
  const LONE = [0x1e, 0x1f, 5, 5, 0x3e, 0x3f, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5];
  const map = mk({
    blocks: [TREE_WALL, LONE],
    collision: [
      [0x07, 0x07, 0x07, 0x07],
      [0x15, 0, 0, 0],
    ],
    layout: [0, 1],
    width: 2,
    height: 1,
  });
  // voxel_heights.lua:374 TilesetJohto
  const p = prof(
    map,
    {
      cylinder: [0x1e, 0x1f, 0x3e, 0x3f],
      planter: [0x2e, 0x2f],
      when_below: {
        "30": [{ below: [0x2e], class: "planter" }],
        "31": [{ below: [0x2f], class: "planter" }],
      },
    },
    COLL,
  );

  test("the tree wall's crown over its middle course is a planter; its middle and foot too", () => {
    expect(at(map, p, 0, 0)!.class).toBe("planter"); // $1E over $2E
    expect(at(map, p, 0, 2)!.class).toBe("planter"); // $2E
    expect(at(map, p, 0, 3)!.class).toBe("cylinder"); // $3E, the foot
  });

  test("the lone tree drawn from the same tiles is a cylinder", () => {
    expect(at(map, p, 4, 0)!.class).toBe("cylinder"); // $1E over $3E
  });
});

describe("Gold shapes: conditional pins", () => {
  test("when_above: $4C is a ledge on open ground and wall under the rock", () => {
    const map = mk({
      blocks: [[0x3c, 0x3c, 0x05, 0x05, 0x4c, 0x4c, 0x4c, 0x4c, 0x05, 0x05, 0x05, 0x05, 0x05, 0x05, 0x05, 0x05]],
      collision: [[0x07, 0x07, 0, 0]],
      layout: [0],
      width: 1,
      height: 1,
    });
    const p = prof(map, { ledge: [0x4c], when_above: { "76": [{ above: [0x3c, 0x4b, 0x4c, 0x4d], class: "wall" }] } });
    expect(at(map, p, 0, 1)!.class).toBe("wall"); // $3C above
    expect(at(map, p, 2, 1)!.class).toBe("ledge"); // $05 above
  });

  test("when_cell asks whether the tile's own cell is walkable", () => {
    const map = mk({
      blocks: [[0x3c, 0x3c, 0x3c, 0x3c, 0x3c, 0x3c, 0x3c, 0x3c, 5, 5, 5, 5, 5, 5, 5, 5]],
      collision: [[0x00, 0x07, 0, 0]],
      layout: [0],
      width: 1,
      height: 1,
    });
    const p = prof(map, { when_cell: { "60": [{ walkable: true, class: "terrace" }] } });
    expect([at(map, p, 0, 0)!.class, at(map, p, 0, 0)!.art]).toEqual(["terrace", "top"]);
    expect(at(map, p, 2, 0)!.class).toBe("wall");
  });

  test("`rows` looks that many tile rows away", () => {
    const map = mk({
      blocks: [[0x39, 5, 5, 5, 5, 5, 5, 5, 0x0e, 5, 5, 5, 5, 5, 5, 5]],
      collision: [[0x07, 0x07, 0x07, 0x07]],
      layout: [0],
      width: 1,
      height: 1,
    });
    const two = prof(map, { when_below: { "57": [{ below: [0x0e], class: "terrace", rows: 2 }] } });
    expect(at(map, two, 0, 0)!.class).toBe("terrace");
    resetTileShapeCache();
    const one = prof(map, { when_below: { "57": [{ below: [0x0e], class: "terrace" }] } });
    expect(at(map, one, 0, 0)!.class).toBe("wall");
  });
});

describe("Gold shapes: hop lips (TileShape.lua:890, :1114)", () => {
  // cell (0,0) is $A0 (hop east, walkable), cell (1,0) the solid lip
  const build = (outdoor: boolean) =>
    mk({ blocks: [FLOOR], collision: [[0xa0, 0x07, 0x00, 0x00]], layout: [0], width: 1, height: 1, outdoor });

  test("outdoors the lip beside a hop cell is a knee-high ledge", () => {
    const map = build(true);
    const s = at(map, prof(map, {}, COLL), 2, 0)!;
    expect([s.class, s.h]).toEqual(["ledge", 6]);
  });

  test("indoors only a tileset that opts in (`hop_lips`) reads the lip", () => {
    const map = build(false);
    expect(at(map, prof(map, {}, COLL), 2, 0)!.class).toBe("wall");
    const cave = build(false);
    expect(at(cave, prof(cave, { hop_lips: true }, COLL), 2, 0)!.class).toBe("ledge");
  });

  test("the hop cell itself stays ground", () => {
    const map = build(true);
    expect(at(map, prof(map, {}, COLL), 0, 0)!.class).toBe("ground");
  });

  test("like the fork, the lip needs the class table (TileShape.lua:1120 shapes.coll)", () => {
    const map = build(true);
    expect(at(map, prof(map, {}), 2, 0)!.class).toBe("wall");
  });
});

describe("Gold shapes: sealed pockets and thin obstacles", () => {
  // a 4x4-cell map: a ring of wall around four walkable cells
  const RING = (warps: { x: number; y: number }[] = []) =>
    mk({
      blocks: [FLOOR],
      collision: [
        [0x07, 0x07, 0x07, 0x00],
        [0x07, 0x07, 0x00, 0x07],
        [0x07, 0x00, 0x07, 0x07],
        [0x00, 0x07, 0x07, 0x07],
      ],
      layout: [0, 1, 2, 3],
      width: 2,
      height: 2,
      warps,
    });

  test("walkable cells nothing reaches from the edge are the inside of a mountain", () => {
    const map = RING();
    expect(sealedCells(map)?.size).toBe(4);
    expect(at(map, prof(map, {}), 2, 2)!.class).toBe("wall");
  });

  test("a pocket with a warp in it is a walled yard, not rock", () => {
    const map = RING([{ x: 1, y: 1 }]);
    expect(sealedCells(map)).toBeNull();
    expect(at(map, prof(map, {}), 2, 2)!.class).toBe("ground");
  });

  test("outdoors, the rest of a cell holding a pinned post is the ground it stands in", () => {
    const post = [0x59, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5];
    const out = mk({ blocks: [post], collision: [[0x07, 0x07, 0x07, 0x07]], layout: [0], width: 1, height: 1 });
    expect(at(out, prof(out, { post: [0x59] }), 1, 0)!.class).toBe("ground");
    expect(at(out, prof(out, { post: [0x59] }), 0, 0)!.class).toBe("post");
    const inside = mk({
      blocks: [post],
      collision: [[0x07, 0x07, 0x07, 0x07]],
      layout: [0],
      width: 1,
      height: 1,
      outdoor: false,
    });
    expect(at(inside, prof(inside, { post: [0x59] }), 1, 0)!.class).toBe("wall");
  });
});

// ---------------------------------------------------------------------------
// the real thing: Gold's own maps through the fork's profile
// ---------------------------------------------------------------------------

const genDir = join(import.meta.dir, "../dist/voxelmon/gold/gen");
const ready =
  existsSync(join(genDir, "maps.json")) &&
  existsSync(join(voxelmodGen2Dir(), "data/voxel_heights.lua")) &&
  !!Bun.which("luajit");

describe("Gold shapes: Johto through the fork's profile", () => {
  const stats = (): BuildingStats => ({ built: [], claimOnly: [], skipped: [], placements: 0 });
  const load = () => {
    const gen = loadGen(genDir);
    return { gen, profile: loadGen2Profile(Object.keys(gen.tilesets)) };
  };
  const analyse = (name: string) => {
    const { gen, profile } = load();
    const def = gen.maps[name];
    const map = new GameMap(def, gen.tilesets[def.tileset]);
    const st = stats();
    return { map, S: analyseMap(gen, map, profile, st), st, profile };
  };

  test.skipIf(!ready)("the profile arrives keyed by Gold's own tileset ids", () => {
    const { profile } = load();
    expect(profile?.tilesets?.TILESET_JOHTO?.planter).toEqual([0x2e, 0x2f]);
    expect(profile?.collision?.["21"]).toBe("cylinder");
    const ids = (profile?.buildings?.TILESET_JOHTO ?? []).map((t) => t.id);
    expect(ids).toContain("johto_lighthouse");
    expect(ids).toContain("johto_house");
    // JohtoModern appends Johto's catalogue (voxel_heights.lua:6724)
    expect((profile?.buildings?.TILESET_JOHTO_MODERN ?? []).map((t) => t.id)).toContain("johto_mart");
  });

  test.skipIf(!ready)("New Bark Town: houses are templates, the tree wall a 32px fold, lone trees hulls", () => {
    const { map, S, st } = analyse("NEW_BARK_TOWN");
    expect(st.built).toEqual(expect.arrayContaining(["johto_house", "johto_hall"]));
    let planterFold = 0;
    let planterArt = 0;
    for (const s of S.shapeAt.values()) {
      if (s.class === "planter" && s.art === "upright" && s.authored && s.h === 32) planterFold++;
      if (s.art === "planter") planterArt++;
    }
    expect(planterFold).toBeGreaterThan(0);
    expect(planterArt).toBe(0); // none left for the unported box path
    // every carved hull sits on a lone tree ($15) or a cut tree ($12)
    expect(S.roundStamps.length).toBeGreaterThan(0);
    for (const st2 of S.roundStamps) {
      const cx = Math.floor((st2.mx - 8) / 16);
      const cy = Math.floor((st2.mz - 8) / 16);
      expect([0x15, 0x12]).toContain(map.cellCollision(cx, cy) ?? -1);
    }
    // the signs are billboards
    const sign = S.shapeAt.get(keyOf(8 * 2, 8 * 2));
    expect(sign?.art).toBe("billboard");
  });

  test.skipIf(!ready)("a Pokemon Center keeps its black surround flat and its counter low", () => {
    const { S } = analyse("CHERRYGROVE_POKECENTER_1F");
    expect(S.shapeAt.get(keyOf(-2, 4))?.class).toBe("void");
    const counters = [...S.shapeAt.values()].filter((s) => s.class === "counter");
    expect(counters.length).toBeGreaterThan(0);
    expect(counters[0].h).toBe(8);
  });
});
