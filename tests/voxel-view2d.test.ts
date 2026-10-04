// VIEW 2D's overworld (voxelmon/game/world/view2d.ts): the GB screen's BG
// ring against the map it draws.
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadRuntimeData, REQUIRED_MODULES } from "../voxelmon/game/data.ts";
import { VoxelmonGame } from "../voxelmon/game/game.ts";
import { RecorderHost } from "../voxelmon/game/host.ts";
import { buildTiles, OverworldView2d } from "../voxelmon/game/world/view2d.ts";

const genDir = join(import.meta.dir, "../dist/voxelmon/gen");
const hasGen = REQUIRED_MODULES.every((m) => existsSync(join(genDir, `${m}.json`)));
const data = hasGen ? await loadRuntimeData(genDir) : null;

function gameAt(map: string, x: number, y: number): any {
  const game: any = new VoxelmonGame(data!, new RecorderHost(), 1);
  game.newGame();
  while (game.stack.length > 1) game.pop();
  game.overworld.enter(map, x, y, "down");
  return game;
}

/** The ring's tile at screen tile (sx, sy). */
function screenTile(v: any, sx: number, sy: number): number {
  return v.maps[(((v.scy >> 3) + sy) & 31) * 32 + (((v.scx >> 3) + sx) & 31)];
}

describe("VIEW 2D overworld", () => {
  test.skipIf(!hasGen)("the ring holds the map's tiles under the screen", () => {
    const game = gameAt("VIRIDIAN_POKECENTER", 3, 4);
    const v = new OverworldView2d().build(game)!;
    const p = game.overworld.player;
    const tx0 = Math.floor((Math.round(p.px) - 64) / 8);
    const ty0 = Math.floor((Math.round(p.py) - 64) / 8);
    for (let sy = 0; sy < 18; sy++) {
      for (let sx = 0; sx < 20; sx++) {
        expect(screenTile(v, sx, sy)).toBe(game.overworld.map.tileAt(tx0 + sx, ty0 + sy) & 0x7f);
      }
    }
    // the player's four sprites, at (64, 60) on screen
    expect(v.oam[0]! - 16).toBe(60);
    expect(v.oam[1]! - 8).toBe(64);
  });

  test.skipIf(!hasGen)("past a town's edge the connected route shows, not the border", () => {
    // Viridian's south edge: ROUTE_1 below, five blocks in
    const game = gameAt("VIRIDIAN_CITY", 20, 34);
    const v = new OverworldView2d().build(game)!;
    const route = data!.maps!.ROUTE_1!;
    const ts = data!.tilesets!.OVERWORLD! as unknown as { blocks: number[][] };
    const p = game.overworld.player;
    const tx0 = Math.floor((Math.round(p.px) - 64) / 8);
    const ty0 = Math.floor((Math.round(p.py) - 64) / 8);
    const viridianH = data!.maps!.VIRIDIAN_CITY!.height;
    let checked = 0;
    for (let sy = 0; sy < 18; sy++) {
      const ty = ty0 + sy;
      if (ty < viridianH * 4) continue;
      for (let sx = 0; sx < 20; sx++) {
        const tx = tx0 + sx;
        const nbx = Math.floor(tx / 4) - 5;
        const nby = Math.floor(ty / 4) - viridianH;
        if (nbx < 0 || nbx >= route.width) continue;
        const block = ts.blocks[route.blocks[nby * route.width + nbx]!]!;
        expect(screenTile(v, sx, sy)).toBe(block[(ty & 3) * 4 + (tx & 3)]! & 0x7f);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(40);
  });

  test.skipIf(!hasGen)("a cut tree's block is drawn as CUT leaves it", () => {
    const swaps = (data as any).field.cutTreeSwaps as { before: number; after: number }[];
    const def = data!.maps!.ROUTE_2!;
    const bi = def.blocks.findIndex((b) => swaps.some((s) => s.before === b));
    expect(bi).toBeGreaterThanOrEqual(0);
    const bx = bi % def.width;
    const by = Math.floor(bi / def.width);
    const game = gameAt("ROUTE_2", bx * 2, by * 2 + 2);
    const view = new OverworldView2d();
    const p = game.overworld.player;
    const tx0 = Math.floor((Math.round(p.px) - 64) / 8);
    const ty0 = Math.floor((Math.round(p.py) - 64) / 8);
    const ts = data!.tilesets!.OVERWORLD! as unknown as { blocks: number[][] };
    const at = (v: any) => screenTile(v, bx * 4 - tx0, by * 4 - ty0);
    const before = ts.blocks[def.blocks[bi]!]![0]! & 0x7f;
    expect(at(view.build(game))).toBe(before);
    game.overworld.map.markCut(bx * 2, by * 2);
    const after = ts.blocks[swaps.find((s) => s.before === def.blocks[bi])!.after]![0]! & 0x7f;
    expect(at(view.build(game))).toBe(after);
  });

  test.skipIf(!hasGen)("a trainer's ! sits 16 px over its person, on top", () => {
    const game = gameAt("VIRIDIAN_CITY", 20, 20);
    const view = new OverworldView2d();
    game.overworld.emote = { entity: game.overworld.player, kind: 1, frames: 30 };
    const v = view.build(game)!;
    // the bubble's four entries first, then the player's at (64, 60)
    expect(v.oam[0]! - 16).toBe(60 - 16);
    expect(v.oam[1]! - 8).toBe(64);
    expect(v.oam[4 * 4]! - 16).toBe(60);
    // its sheet is the pak's emote page
    expect(v.loads.some((l) => l.sheet === "emotes")).toBe(true);
  });

  test.skipIf(!hasGen)("Rock Tunnel is dark in 2D until FLASH", () => {
    const game = gameAt("ROCK_TUNNEL_1F", 15, 4);
    const view = new OverworldView2d();
    expect(view.build(game)!.bgp).toBe(0xfe);
    game.save.flashLit = true;
    const v = view.build(game)!;
    expect([v.bgp, v.obp0, v.obp1]).toEqual([0xe4, 0xe4, 0xe4]);
  });
});

describe("VIEW 2D tile cache", () => {
  /** The block at (bx, by) past the edge too, as view2d's tiles were first
   *  worked out (a block at a time): a connected map's, else the border. */
  function refBlock(def: any, maps: any, bx: number, by: number): number {
    const w = def.width;
    const h = def.height;
    if (bx >= 0 && by >= 0 && bx < w && by < h) return def.blocks[by * w + bx];
    const conns = def.connections;
    const at = (c: any, nbx: number, nby: number): number => {
      const d = c ? maps[c.map] : undefined;
      if (!d || nbx < 0 || nby < 0 || nbx >= d.width || nby >= d.height) return -1;
      return d.blocks[nby * d.width + nbx] ?? -1;
    };
    let b = -1;
    if (conns) {
      if (by < 0 && conns.north) b = at(conns.north, bx - conns.north.offset, by + (maps[conns.north.map]?.height ?? 0));
      if (b < 0 && by >= h && conns.south) b = at(conns.south, bx - conns.south.offset, by - h);
      if (b < 0 && bx < 0 && conns.west) b = at(conns.west, bx + (maps[conns.west.map]?.width ?? 0), by - conns.west.offset);
      if (b < 0 && bx >= w && conns.east) b = at(conns.east, bx - w, by - conns.east.offset);
    }
    return b >= 0 ? b : def.borderBlock;
  }

  test.skipIf(!hasGen)("every map's tiles match the block-at-a-time reference, connections and border included", () => {
    const game = gameAt("PALLET_TOWN", 5, 6);
    const ow = game.overworld;
    let maps = 0;
    for (const id of Object.keys(data!.maps!)) {
      try {
        ow.enter(id, 1, 1, "down");
      } catch {
        continue;
      }
      const map = ow.map;
      const t = buildTiles(map, data!.maps as any, (data as any).field?.cutTreeSwaps);
      const pad = (t.w - map.def.width * 4) / 2;
      const ts: number[][] = map.tileset.blocks;
      for (let ty = 0; ty < t.h; ty++) {
        for (let tx = 0; tx < t.w; tx++) {
          const bx = Math.floor((tx - pad) / 4);
          const by = Math.floor((ty - pad) / 4);
          const block = ts[refBlock(map.def, data!.maps, bx, by)];
          const want = block ? block[(((ty - pad) % 4) + 4) % 4 * 4 + ((((tx - pad) % 4) + 4) % 4)]! & 0x7f : 0;
          if (t.ids[ty * t.w + tx] !== want) throw new Error(`${id} tile (${tx - pad}, ${ty - pad}): ${t.ids[ty * t.w + tx]} != ${want}`);
        }
      }
      maps++;
    }
    expect(maps).toBeGreaterThan(200);
  });

  test.skipIf(!hasGen)("walking back over a seam reuses the map's tiles", () => {
    const game = gameAt("PALLET_TOWN", 10, 1);
    const view = new OverworldView2d();
    view.build(game);
    const first = (view as any).tiles;
    game.overworld.enter("ROUTE_1", 10, 34, "up");
    view.build(game);
    expect((view as any).tiles).not.toBe(first);
    game.overworld.enter("PALLET_TOWN", 10, 1, "down");
    view.build(game);
    expect((view as any).tiles).toBe(first);
  });
});

describe("VIEW 2D wide ring", () => {
  /** A stand-in for the core's GbScreen: the wide ring as the ops leave it. */
  function coreMirror() {
    const st = { cols: 64, rows: 32, scx: 0, scy: 0, w: 0, h: 0, ring: new Uint8Array(128 * 64), ops: 0 };
    const host = new Proxy({} as any, {
      get: (_t, name: string) => {
        if (name === "gbWide") return (w: number, h: number, scx: number, scy: number, _f: number, cols = 64, rows = 32) => {
          Object.assign(st, { w, h, cols: cols === 128 ? 128 : 64, rows: rows === 64 ? 64 : 32 });
          st.scx = scx & (st.cols * 8 - 1);
          st.scy = scy & (st.rows * 8 - 1);
        };
        if (name === "gbMap") return (at: number, hex: string) => {
          st.ops++;
          if (at < 0x800) return;
          for (let i = 0; i < hex.length / 2; i++) st.ring[at - 0x800 + i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
        };
        return () => {};
      },
    });
    return { st, host };
  }

  for (const zoom of [60, 50, 40]) {
    test.skipIf(!hasGen)(`walking at 2D ZOOM OUT ${zoom}% WIDE, the core's ring holds the map under the whole picture`, async () => {
      const { GbEmitter } = await import("../voxelmon/game/gb/emit.ts");
      const game = gameAt("VIRIDIAN_CITY", 18, 20);
      game.save.options = { ...(game.save.options ?? {}), view: "2d", screen2d: "wide", zoom2d: zoom };
      game.host.gbWide ??= () => {};
      const view = new OverworldView2d();
      const emitter = new GbEmitter();
      const { st, host } = coreMirror();
      const resolve = { page: () => 0, palette: () => 0 };
      const p = game.overworld.player;
      const map = game.overworld.map;
      // a walk: right 3 tiles a pixel at a time, down 2, left 5, up 4, then a jump
      const path: [number, number][] = [];
      for (let k = 0; k < 24; k++) path.push([1, 0]);
      for (let k = 0; k < 16; k++) path.push([0, 1]);
      for (let k = 0; k < 40; k++) path.push([-1, 0]);
      for (let k = 0; k < 32; k++) path.push([0, -1]);
      path.push([64, 40]);
      // the expected tiles: the cache (proven against the block-at-a-time
      // reference above, connections included -- map.tileAt answers the
      // border past an edge)
      const t = buildTiles(map, data!.maps as any, (data as any).field?.cutTreeSwaps);
      const pad = (t.w - map.def.width * 4) / 2;
      let checked = 0;
      for (const [dx, dy] of path) {
        p.px += dx;
        p.py += dy;
        const v = view.build(game)!;
        emitter.emit(host, v, resolve);
        expect(st.w).toBe(v.wideW);
        expect(st.cols).toBe(v.wideCols);
        // every tile the picture shows (each 8 px and its last pixel),
        // read through the core's ring at its scroll
        const vx = Math.round(p.px) - 64 - ((st.w - 160) >> 1);
        const vy = Math.round(p.py) - 64 - ((st.h - 144) >> 1);
        const xs: number[] = [];
        for (let x = 0; x < st.w; x += 8) xs.push(x);
        xs.push(st.w - 1);
        const ys: number[] = [];
        for (let y = 0; y < st.h; y += 8) ys.push(y);
        ys.push(st.h - 1);
        for (const y of ys) {
          for (const x of xs) {
            const rx = (st.scx + x) & (st.cols * 8 - 1);
            const ry = (st.scy + y) & (st.rows * 8 - 1);
            const got = st.ring[(ry >> 3) * st.cols + (rx >> 3)];
            const want = t.ids[(Math.floor((vy + y) / 8) + pad) * t.w + Math.floor((vx + x) / 8) + pad];
            if (got !== want) throw new Error(`zoom ${zoom} at (${p.px},${p.py}) picture (${x},${y}): ${got} != ${want}`);
            checked++;
          }
        }
      }
      expect(checked).toBeGreaterThan(1000);
      // the ring is the big one past HIGH
      expect(st.cols).toBe(zoom < 60 ? 128 : 64);
    });
  }
});
