// The Gold screen's cooked tiles (voxelmon/cook/gen2lcd.ts) and Gold's
// dataset container (voxelmon/game/gen2/platform/container.ts).

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadGen } from "../voxelmon/cook/data.ts";
import { buildLcdTiles, LCD_PAGE_TILES, lcdImageTiles } from "../voxelmon/cook/gen2lcd.ts";
import { readGen2Container, writeGen2Container } from "../voxelmon/game/gen2/platform/container.ts";

const GOLD_GEN = join(import.meta.dir, "..", "dist", "voxelmon", "gold", "gen");
const haveGold = existsSync(join(GOLD_GEN, "gfx.json")) && existsSync(join(GOLD_GEN, "pokemon.json"));

describe("gen2 dataset container", () => {
  test("round trips documents, including non-ASCII text", () => {
    const text = writeGen2Container({ a: '{"x":1}', b: '"POKéMON"', c: "[]" });
    const back = readGen2Container(text);
    expect(Object.keys(back)).toEqual(["a", "b", "c"]);
    expect(JSON.parse(back.a!)).toEqual({ x: 1 });
    expect(JSON.parse(back.b!)).toBe("POKéMON");
    expect(back.c).toBe("[]");
  });
});

describe("gen2 lcd tiles", () => {
  test("synthetic: de-duplicates, keeps runs, and maps clear to colour 0", () => {
    // a 16x8 image: tile A (all colour 2) twice; an 8x8 image: clear
    const bin = new Uint8Array(16 * 8 + 64);
    bin.fill(2, 0, 128);
    bin.fill(0xff, 128);
    const gen = { gfx: { img: { off: 0, w: 16, h: 8 }, clear: { off: 128, w: 8, h: 8 } }, gfxBin: bin };
    const t = buildLcdTiles(gen as never, ["clear", "img"]);
    expect(t.tiles).toBe(2); // blank + colour-2 tile
    expect(t.gfx.clear).toEqual([1, 1, 0, 1]);
    expect(lcdImageTiles(t.gfx.img!).ids).toEqual([1, 1]);
    const page = t.pages[0]!.frames[0]!;
    expect(page[8]).toBe(2); // tile 1's first pixel
    expect(page[0]).toBe(0);
  });

  test.skipIf(!haveGold)("real Gold graphics: every image rebuilds from its tiles", () => {
    const gen = loadGen(GOLD_GEN);
    const t = buildLcdTiles(gen);
    const keys = Object.keys(t.gfx);
    expect(keys.length).toBeGreaterThan(800);
    expect(t.tiles).toBeLessThan(0x10000);
    expect(t.pages.length).toBe(Math.ceil(t.tiles / LCD_PAGE_TILES));
    const px = (id: number, x: number, y: number): number => {
      const page = t.pages[Math.floor(id / LCD_PAGE_TILES)]!;
      const i = id % LCD_PAGE_TILES;
      return page.frames[0]![(Math.floor(i / 32) * 8 + y) * 256 + (i % 32) * 8 + x]!;
    };
    for (const key of ["fonts/font", "battle/front/chikorita", "menu/pokegear".replace("menu/pokegear", keys.find((k) => k.startsWith("menu/"))!)]) {
      const e = gen.gfx[key]!;
      const { w, ids } = lcdImageTiles(t.gfx[key]!);
      for (let y = 0; y < e.h; y++) {
        for (let x = 0; x < e.w; x++) {
          const v = gen.gfxBin[e.off + y * e.w + x]!;
          const id = ids[Math.floor(y / 8) * w + Math.floor(x / 8)]!;
          expect(px(id, x % 8, y % 8)).toBe(v === 0xff ? 0 : v & 3);
        }
      }
    }
    console.log(`gold lcd: ${keys.length} images, ${t.tiles} unique tiles, ${t.pages.length} pages`);
  });
});
