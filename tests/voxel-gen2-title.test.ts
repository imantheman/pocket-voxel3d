// The Gen 2 (Gold) title screen and intro movie stages
// (voxelmon/import/gen2/title.ts, intro.ts): synthetic checks of the
// tilemap/metatile/sheet helpers, then -- only with a verified Gold ROM on
// this machine -- the real stages against pokegold's gfx/title and
// gfx/intro facts. No ROM bytes are ever committed.

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { GOLD_SHA1 } from "../voxelmon/import/env.ts";
import { GfxBin, GfxImage, TRANSPARENT } from "../voxelmon/import/gfx.ts";
import { Rom } from "../voxelmon/import/rom.ts";
import { Gen2Ctx } from "../voxelmon/import/gen2/ctx.ts";
import type { Gen2Manifest } from "../voxelmon/import/gen2/manifest.ts";
import { extractIntro, introBackground, introSheetBytes, layStarters } from "../voxelmon/import/gen2/intro.ts";
import {
  DMG_BGP,
  bgPalAt,
  composeTitleScreen,
  extractTitle,
  hoohPose,
  throughRegister,
  tilesFrom2bpp,
} from "../voxelmon/import/gen2/title.ts";

const BANK = 0x4000;

class FakeRom {
  readonly data = new Uint8Array(0x40 * BANK);
  put(bank: number, address: number, bytes: number[]): void {
    this.data.set(bytes, Rom.offset(bank, address));
  }
}

function fakeCtx(rom: FakeRom, symbols: Gen2Manifest["symbols"]): Gen2Ctx {
  const manifest = {
    format: 3, generation: 2, romSha1: GOLD_SHA1, charmap: {}, fontCharmap: [], maps: {}, tilesets: {},
    pokemonAssets: {}, text: {}, symbols, constants: {},
  } as unknown as Gen2Manifest;
  return new Gen2Ctx(new Rom(rom.data), manifest, new GfxBin());
}

/** A solid 8x8 tile of one shade (2bpp). */
const solidTile = (shade: number): number[] =>
  Array.from({ length: 16 }, (_, i) => ((i % 2 === 0 ? shade & 1 : shade >> 1) ? 0xff : 0));

// ---------------------------------------------------------------- synthetic

describe("gen2 intro helpers", () => {
  test("introSheetBytes pads to whole 16-tile rows, at least one", () => {
    expect(introSheetBytes([])[1]).toBe(1);
    expect(introSheetBytes([])[0].length).toBe(256);
    const [bytes, rows] = introSheetBytes(new Array(17 * 16).fill(7));
    expect(rows).toBe(2);
    expect(bytes.length).toBe(512);
    expect(bytes[17 * 16 - 1]).toBe(7);
    expect(bytes[17 * 16]).toBe(0);
    // a trailing partial tile is dropped when it overruns the rows
    const [cut] = introSheetBytes(new Array(16 * 16 + 5).fill(1));
    expect(cut.length).toBe(256);
  });

  test("introBackground reads the grid and sizes meta by its highest index", () => {
    const rom = new FakeRom();
    // lz3 literal of one tile (16 bytes) then the terminator
    rom.put(1, 0x4000, [0x0f, ...solidTile(3), 0xff]);
    const grid = Array.from({ length: 2 * 16 }, (_, i) => (i === 5 ? 2 : 0));
    rom.put(1, 0x4100, grid);
    rom.put(1, 0x4200, Array.from({ length: 64 }, (_, i) => i));
    const ctx = fakeCtx(rom, { G: [1, 0x4000], T: [1, 0x4100], M: [1, 0x4200] });
    const bg = introBackground(ctx, "G", "M", "T", 2, "intro/test_tiles.png");
    expect(bg.tiles).toBe("intro/test_tiles");
    expect(bg.tilemap).toEqual(grid);
    expect(bg.tilemapRows).toBe(2);
    expect(bg.meta).toEqual(Array.from({ length: 12 }, (_, i) => i)); // (2 + 1) * 4
    expect(ctx.gfx.directory["intro/test_tiles"]).toMatchObject({ w: 128, h: 8 });
    expect(ctx.gfx.bytes()[0]).toBe(3);
    expect(ctx.gfx.bytes()[8]).toBe(TRANSPARENT); // tile 1 is padding: shade 0 -> transparent
  });

  test("layStarters overwrites 25 tiles at $10/$29/$42 and zero-fills gaps", () => {
    const pics = [[1], [2], [3]].map(([v]) => new Array(25 * 16).fill(v));
    const out = layStarters(new Array(0x10 * 16).fill(9), pics);
    expect(out.length).toBe((0x42 + 25) * 16);
    expect(out[0x10 * 16 - 1]).toBe(9);
    expect(out[0x10 * 16]).toBe(1);
    expect(out[0x29 * 16]).toBe(2);
    expect(out[0x42 * 16 + 25 * 16 - 1]).toBe(3);
    expect(layStarters([], [[5]])[0]).toBe(0);
    expect(layStarters([], [[5]])[0x10 * 16]).toBe(5);
  });
});

describe("gen2 title helpers", () => {
  test("composeTitleScreen streams a 32-wide map to $FF and clips to 20x18", () => {
    const tiles = [solidTile(1), solidTile(2)].map((t) => tilesFrom2bpp(t)[0]!);
    const map: number[] = new Array(32 * 18).fill(0x7f); // unknown id: stays white
    map[0] = 0;
    map[19] = 1;
    map[20] = 1; // column 20: off screen
    map[32 + 1] = 0x80; // row 1: vTiles1 id
    map.push(0xff);
    const screen = composeTitleScreen((i) => map[i]!, (id) => (id < 0x80 ? tiles[id] : tiles[1]));
    expect([screen.w, screen.h]).toEqual([160, 144]);
    expect(screen.get(0, 0)).toBe(1);
    expect(screen.get(19 * 8 + 7, 7)).toBe(2);
    expect(screen.get(8, 8)).toBe(2);
    expect(screen.get(8, 0)).toBe(0);
  });

  test("bgPalAt follows FillTitleScreenPals' zones", () => {
    expect(bgPalAt(0, 0)).toBe(1);
    expect(bgPalAt(4, 6)).toBe(1);
    expect(bgPalAt(5, 6)).toBe(3);
    expect(bgPalAt(14, 6)).toBe(3);
    expect(bgPalAt(0, 7)).toBe(0);
    expect(bgPalAt(0, 11)).toBe(0);
    expect(bgPalAt(19, 12)).toBe(4);
  });

  test("throughRegister remaps opaque shades and keeps transparency", () => {
    const image = new GfxImage(4, 1, 0);
    image.px.set([0, 1, 2, TRANSPARENT]);
    expect([...throughRegister(image, DMG_BGP).px]).toEqual([0, 2, 1, TRANSPARENT]);
  });

  test("hoohPose places 8x16 objects about the (32, 24) origin, colour 0 see-through", () => {
    const tiles = tilesFrom2bpp([...solidTile(0), ...solidTile(2)], true);
    const pose = hoohPose(tiles, [[0, 0, 0, 0, 0]]);
    expect(pose.get(32, 24)).toBe(TRANSPARENT); // tile 0 is all colour 0
    expect(pose.get(32, 32)).toBe(2); // tile 1, the lower half
    expect(pose.get(31, 32)).toBe(TRANSPARENT);
  });
});

// ---------------------------------------------------------------- the real ROM

const GOLD_ROM = process.env.VOXELMON_GOLD_ROM ?? "/mnt/c/Users/isaac/OneDrive/Desktop/mGBA/Pokemon-Gold.gbc";
const GOLD_MANIFEST = join(
  process.env.VOXELMON_G1R_GEN2 ?? join(homedir(), "gen1recomp-mit-gen2"),
  "tools/rom_manifest_gold.json",
);
function goldInputs(): { rom: Uint8Array; manifest: Gen2Manifest } | null {
  if (!existsSync(GOLD_ROM) || !existsSync(GOLD_MANIFEST)) return null;
  const rom = new Uint8Array(readFileSync(GOLD_ROM));
  if (createHash("sha1").update(rom).digest("hex") !== GOLD_SHA1) return null;
  return { rom, manifest: JSON.parse(readFileSync(GOLD_MANIFEST, "utf8")) };
}
const gold = goldInputs();
if (!gold) console.log(`voxel-gen2-title: skipping the Gold ROM checks — no verified ROM at ${GOLD_ROM} or no manifest at ${GOLD_MANIFEST}`);

const isPalette = (pal: unknown): void => {
  expect(Array.isArray(pal)).toBe(true);
  expect((pal as unknown[]).length).toBe(4);
  for (const c of pal as number[][]) {
    expect(c.length).toBe(3);
    for (const v of c) expect(v >= 0 && v <= 255 && Number.isInteger(v)).toBe(true);
  }
};

describe.skipIf(!gold)("gen2 title + intro against the Gold ROM", () => {
  const ctx = gold ? new Gen2Ctx(new Rom(gold.rom), gold.manifest, new GfxBin(), GOLD_SHA1) : null!;
  const title = gold ? (extractTitle(ctx).title as any) : null;
  const intro = gold ? (extractIntro(ctx).intro as any) : null;
  const dims = (key: string) => {
    const e = ctx.gfx.directory[key]!;
    return [e.w, e.h];
  };
  const px = (key: string) => {
    const e = ctx.gfx.directory[key]!;
    return ctx.gfx.bytes().subarray(e.off, e.off + e.w * e.h);
  };

  test("title sheets have the screen's dimensions", () => {
    expect(dims(title.screen)).toEqual([160, 144]);
    expect(dims(title.screenGray)).toEqual([160, 144]);
    expect(dims(title.clouds)).toEqual([160, 48]);
    expect(dims(title.cloudsGray)).toEqual([160, 48]);
    expect(dims(title.image)).toEqual([160, 56]);
    expect(title.hoohFrames.length).toBe(5);
    for (const key of [title.hooh, ...title.hoohFrames, ...title.hoohFramesGray]) expect(dims(key)).toEqual([64, 64]);
    expect(dims(title.trail)).toEqual([8, 16]);
    expect(dims(title.trailGray)).toEqual([8, 16]);
    expect(dims(title.copyright)).toEqual([240, 8]);
    expect(dims(title.copyrightSplash)).toEqual([160, 144]);
  });

  test("title colour data: 5 BG palettes (title_bg_gold.pal), a 20x18 zone map, OBJ palettes", () => {
    expect(title.screenPalettes.length).toBe(5);
    for (const pal of title.screenPalettes) isPalette(pal);
    isPalette(title.hoohPalette);
    isPalette(title.trailPalette);
    expect(title.screenPalMap.length).toBe(360);
    expect(title.screenPalettes[1][0]).toEqual([255, 173, 0]); // 31,21,0 logo yellow
    expect(title.sky).toEqual([15 / 31, 20 / 31, 1]);
    expect(title.trailPhase).toBeUndefined();
    expect(title.timeoutFrames).toBe(84 * 60 + 16);
  });

  test("the screen is opaque, the grey set is it through rBGP, Ho-Oh's grey pose a silhouette", () => {
    const screen = px(title.screen);
    const gray = px(title.screenGray);
    expect(screen.includes(TRANSPARENT)).toBe(false);
    for (let i = 0; i < screen.length; i++) expect(gray[i]).toBe(DMG_BGP[screen[i]!]!);
    const pose = px(title.hoohFramesGray[0]);
    const opaque = [...pose].filter((v) => v !== TRANSPARENT);
    expect(opaque.length).toBeGreaterThan(500);
    expect(new Set(opaque)).toEqual(new Set([3]));
  });

  test("intro sheets are 16 tiles wide; water/grass match pokegold's pngs", () => {
    expect(dims(intro.water.tiles)).toEqual([128, 64]); // gfx/intro/water1.png
    expect(dims(intro.water.sprites)).toEqual([128, 64]); // water2.png
    expect(dims(intro.grass.tiles)).toEqual([128, 24]); // grass1.png
    expect(dims(intro.grass.sprites)).toEqual([128, 72]); // grass2.png
    const [fw, fh] = dims(intro.fire.tiles);
    expect(fw).toBe(128);
    expect(fh).toBeGreaterThan(64); // $80 tiles of FireGFX1, then FireGFX2
    const [sw, sh] = dims(intro.fire.sprites);
    expect(sw).toBe(128);
    expect(sh * 2).toBeGreaterThanOrEqual(0x42 + 25); // Totodile's last tile fits
  });

  test("intro tilemaps have pokegold's lengths and meta covers them", () => {
    expect(intro.water.tilemap.length).toBe(512); // water.tilemap
    expect(intro.water.tilemapRows).toBe(32);
    expect(intro.water.firstRow).toBe(15);
    expect(intro.grass.tilemap.length).toBe(256); // grass.tilemap
    expect(intro.grass.firstRow).toBe(0);
    for (const [act, binSize] of [["water", 272], ["grass", 112]] as const) {
      const bg = intro[act];
      expect(bg.meta.length).toBe((Math.max(...bg.tilemap) + 1) * 4);
      expect(bg.meta.length).toBeLessThanOrEqual(binSize); // water.bin / grass.bin
    }
  });

  test("intro palettes are 4-colour rows", () => {
    const p = intro.palettes;
    for (const key of ["waterBg", "magikarpBg", "magikarpOb", "grassBg", "grassOb", "startersOb"]) isPalette(p[key]);
    expect(p.waterOb.length).toBe(2);
    for (const pal of p.waterOb) isPalette(pal);
    expect(p.fireBg.length).toBe(4);
    for (const pal of p.fireBg) isPalette(pal);
  });
});
