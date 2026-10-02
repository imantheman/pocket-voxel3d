// Port of gen1recomp RomExtractorGen2.lua:2043-2464 extractTitle
// (bdfac727): the Gold title screen (TitleScreenTilemap over
// TitleScreenGFX1/2), Ho-Oh's five OAM poses (TitleScreenGFX4), the trail
// sparkle (TitleScreenGFX3) and the copyright splash (CopyrightGFX).
//
// Gold and Silver (ctx.edition): Crystal's branch (:2046-2048, CrystalMovie)
// is dropped. Silver's switches are Brian's -- Lugia's oamsets, Silver's BG
// and OBJ palettes and registers, its trail/bob/scroll numbers -- under the
// Gold names the title screen reads (`hooh*` is whichever bird it is).
//
// DEVIATION from Brian (the gfx format stores shades, not RGB): where he
// `colorize`s an image through a palette and saves the RGB result
// (title_screen :2206, clouds :2220, pokemon_logo :2227, hooh_N / hooh
// :2325-2342, trail :2362), we save the SHADE image under the same key and
// ship the palettes as data instead:
//   screenPalettes  5 x 4 [r,g,b] 0-255   title_bg_gold.pal (BG_PALS :2082)
//   screenPalMap    360 ints, 20x18 row-major, 0-based index into
//                   screenPalettes per screen tile (bgPalAt :2152)
//   hoohPalette     4 [r,g,b]             title_fg.pal pal 0 (OBJ_HOOH :2097)
//   trailPalette    4 [r,g,b]             title_fg.pal pal 1 (OBJ_TRAIL :2100)
// Colour of a pixel = palette[shade] -- exactly Brian's palColor(pal,
// shadeOf(r)). `clouds` is screen rows 88..135, i.e. screenPalMap tile rows
// 11..16; `image` (the logo) is tile rows 0..6. Colours go through scale5
// (0-255, like every other Gen 2 palette here) where Brian divides by 31.
// The *_gray images are pure shade remaps (throughRegister) and are exact.

import { check } from "../ctx.ts";
import { GfxImage, TRANSPARENT, blit, decode2bpp } from "../gfx.ts";
import type { Gen2Ctx } from "./ctx.ts";
import { save, write2bpp } from "./helpers.ts";
import { type Rgb, scale5 } from "./palettes.ts";

type Pal5 = [number, number, number][];

/** :2082-2095 (Gold branch) — gfx/title/title_bg_gold.pal, 5 BG palettes, 5-bit. */
export const TITLE_BG_PALS_5: Pal5[] = [
  [[31, 31, 31], [18, 23, 31], [15, 20, 31], [0, 0, 0]],
  [[31, 21, 0], [12, 14, 12], [15, 20, 31], [0, 0, 17]],
  [[31, 31, 31], [31, 0, 0], [15, 20, 31], [0, 0, 0]],
  [[31, 31, 31], [29, 25, 0], [15, 20, 31], [17, 10, 1]],
  [[31, 31, 31], [23, 26, 31], [18, 23, 31], [0, 0, 0]],
];
/** :2082-2088 (Silver branch) — gfx/title/title_bg_silver.pal. */
export const TITLE_BG_PALS_SILVER_5: Pal5[] = [
  [[31, 31, 31], [0, 12, 15], [4, 8, 21], [0, 0, 0]],
  [[31, 21, 0], [15, 17, 15], [4, 8, 21], [0, 0, 17]],
  [[31, 31, 31], [31, 0, 0], [4, 8, 21], [0, 0, 0]],
  [[31, 31, 31], [24, 23, 25], [4, 8, 21], [8, 8, 9]],
  [[31, 31, 31], [5, 10, 11], [0, 12, 15], [0, 0, 0]],
];
/** :2097-2099 — title_fg.pal pal 0, Ho-Oh. */
const OBJ_HOOH_5: Pal5 = [[31, 31, 31], [7, 6, 3], [7, 6, 3], [7, 6, 3]];
/** :2100-2102 — title_fg.pal pal 1, the trail sparks. */
const OBJ_TRAIL_5: Pal5 = [[31, 31, 31], [31, 31, 0], [26, 22, 0], [0, 0, 0]];
/** :2105-2111 — Silver: DmgToCgbObjPal0 %11100000 makes OBJ pal 0
 * {c0, c0, c2, c3}, and the trail draws with it too (attribute 0). */
const OBJ_SILVER_5: Pal5 = [OBJ_HOOH_5[0]!, OBJ_HOOH_5[0]!, OBJ_HOOH_5[2]!, OBJ_HOOH_5[3]!];

/** :2125 — Gold's rBGP %11011000 as a shade -> shade map. */
export const DMG_BGP = [0, 2, 1, 3];
/** :2127 — Gold's rOBP0 %11111111: Ho-Oh is a solid silhouette. */
export const DMG_OBP0 = [3, 3, 3, 3];
/** :2128 — Gold's rOBP1 %11111000: the trail. */
export const DMG_OBP1 = [0, 2, 3, 3];
/** :2130-2131 — Silver writes %11110000 to both OBPs. */
export const DMG_OBP_SILVER = [0, 0, 3, 3];

const toRgb = (pal: Pal5): Rgb[] => pal.map(([r, g, b]) => [scale5(r), scale5(g), scale5(b)] as Rgb);

/** :2051 tilesFrom2bpp — whole 8x8 tiles; `transparent` keys shade 0. */
export function tilesFrom2bpp(raw: number[], transparent = false): GfxImage[] {
  const tiles: GfxImage[] = [];
  for (let offset = 0; offset + 16 <= raw.length; offset += 16) {
    tiles.push(decode2bpp(raw.slice(offset, offset + 16), 8, 8, transparent));
  }
  return tiles;
}

/** :2061 blitSprite — copy only the opaque pixels (OBJ colour 0 is see-through).
 * Love's setPixel errors off-canvas; so do we. */
function blitSprite(target: GfxImage, tile: GfxImage | undefined, tx: number, ty: number): void {
  if (!tile) return;
  check(tx >= 0 && ty >= 0 && tx + 8 <= target.w && ty + 8 <= target.h, `title sprite off canvas at ${tx},${ty}`);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const v = tile.get(x, y);
      if (v !== TRANSPARENT) target.set(tx + x, ty + y, v);
    }
  }
}

/** :2135 throughRegister — re-shade the opaque pixels through a DMG register. */
export function throughRegister(image: GfxImage, register: number[]): GfxImage {
  const out = new GfxImage(image.w, image.h, TRANSPARENT);
  for (let i = 0; i < image.px.length; i++) {
    const v = image.px[i]!;
    if (v !== TRANSPARENT) out.px[i] = register[v]!;
  }
  return out;
}

/** :2152 bgPalAt — FillTitleScreenPals' zones, 0-based palette index. */
export function bgPalAt(col: number, row: number): number {
  if (row >= 12) return 4;
  if (row === 6 && col >= 5 && col <= 14) return 3;
  if (row <= 6) return 1;
  return 0;
}

/**
 * :2186-2201 — stream a $FF-terminated tilemap into a 32-wide BG map and
 * draw the visible 20x18 onto a white (opaque shade 0) 160x144 screen.
 * `tileFor` resolves a tile id (undefined = leave white).
 */
export function composeTitleScreen(
  byteAt: (index: number) => number,
  tileFor: (id: number) => GfxImage | undefined,
): GfxImage {
  const screen = new GfxImage(160, 144, 0);
  for (let index = 0; ; index++) {
    const id = byteAt(index);
    if (id === 0xff) break;
    const col = index % 32;
    const row = Math.floor(index / 32);
    if (col < 20 && row < 18) {
      const tile = tileFor(id);
      if (tile) blit(screen, tile, col * 8, row * 8);
    }
  }
  return screen;
}

/** Full-width rows sy..sy+h-1 of `source` (Brian's blit into a blank). */
function crop(source: GfxImage, sy: number, h: number): GfxImage {
  const out = new GfxImage(source.w, h, 0);
  blit(out, source, 0, 0, 0, sy, source.w, h);
  return out;
}

/** OAM entry [tileX, tileY, dx, dy, vtile] (data/sprite_anims/oam.asm). */
type Oam = [number, number, number, number, number];

/** :2254-2306 HOOH_FRAMES — OAMData_GSIntroHoOh1..5, 8x16 objects. */
const HOOH_FRAMES: Oam[][] = [
  [
    [-4, -1, 0, 0, 0x00], [-3, -2, 0, 0, 0x02], [-3, 0, 0, 0, 0x04],
    [-2, -3, 0, 0, 0x06], [-2, -1, 0, 0, 0x08], [-2, 1, 0, 0, 0x0a],
    [-1, -3, 0, 0, 0x0c], [-1, -1, 0, 0, 0x0e], [-1, 1, 0, 0, 0x10],
    [0, -3, 0, 0, 0x12], [0, -1, 0, 0, 0x14], [0, 1, 0, 0, 0x16],
    [1, -3, 0, 0, 0x18], [1, -1, 0, 0, 0x1a], [1, 1, 0, 0, 0x1c],
    [2, -1, 0, 0, 0x1e], [2, 1, 0, 0, 0x20],
    [3, -2, 0, 0, 0x22], [3, 0, 0, 0, 0x24],
  ],
  [
    [-4, -1, 0, 0, 0x00], [-3, -2, 0, 0, 0x02], [-3, 0, 0, 0, 0x04],
    [-2, -1, 0, 0, 0x26], [-2, 1, 0, 0, 0x0a],
    [-1, -3, 0, 0, 0x28], [-1, -1, 0, 0, 0x2a], [-1, 1, 0, 0, 0x10],
    [0, -1, 0, 0, 0x2c], [0, 1, 0, 0, 0x16],
    [1, -1, 0, 0, 0x30], [1, 1, 0, 0, 0x1c],
    [2, -1, 0, 0, 0x1e], [2, 1, 0, 0, 0x20],
    [3, -2, 0, 0, 0x22], [3, 0, 0, 0, 0x24],
  ],
  [
    [-4, -1, 0, 0, 0x00], [-3, -2, 0, 0, 0x02], [-3, 0, 0, 0, 0x32],
    [-2, -1, 0, 0, 0x34], [-2, 1, 0, 0, 0x36],
    [-1, -1, 0, 0, 0x38], [-1, 1, 0, 0, 0x3a],
    [0, -1, 0, 0, 0x3c], [0, 1, 0, 0, 0x3e],
    [1, -1, 0, 0, 0x30], [1, 1, 0, 0, 0x1c],
    [2, -1, 0, 0, 0x1e], [2, 1, 0, 0, 0x20],
    [3, -2, 0, 0, 0x22], [3, 0, 0, 0, 0x24],
  ],
  [
    [-4, -1, 0, 0, 0x00], [-3, -2, 0, 0, 0x02], [-3, 0, 0, 0, 0x04],
    [-2, -1, 0, 0, 0x40], [-2, 1, 0, 0, 0x42], [-2, 3, 0, 0, 0x44],
    [-1, -1, 0, 0, 0x46], [-1, 1, 0, 0, 0x48], [-1, 3, 0, 0, 0x4a],
    [0, -1, 0, 0, 0x4c], [0, 1, 0, 0, 0x4e],
    [1, -1, 0, 0, 0x30], [1, 1, 0, 0, 0x1c],
    [2, -1, 0, 0, 0x1e], [2, 1, 0, 0, 0x20],
    [3, -2, 0, 0, 0x22], [3, 0, 0, 0, 0x24],
  ],
  [
    [-4, -1, 0, 0, 0x00], [-3, -2, 0, 0, 0x02], [-3, 0, 0, 0, 0x04],
    [-2, -1, 0, 0, 0x50], [-2, 1, 0, 0, 0x0a],
    [-1, -3, 0, 0, 0x52], [-1, -1, 0, 0, 0x54], [-1, 1, 0, 0, 0x10],
    [0, -3, 0, 0, 0x56], [0, -1, 0, 0, 0x2e], [0, 1, 0, 0, 0x16],
    [1, -1, 0, 0, 0x30], [1, 1, 0, 0, 0x1c],
    [2, -1, 0, 0, 0x1e], [2, 1, 0, 0, 0x20],
    [3, -2, 0, 0, 0x22], [3, 0, 0, 0, 0x24],
  ],
];
/** :2236-2253 — .OAMData_GSIntroLugia1 / 2 (data/sprite_anims/oam.asm:736-773). */
const LUGIA_1: Oam[] = [
  [-5, -2, 0, 0, 0x00], [-5, 0, 0, 0, 0x02],
  [-4, -2, 0, 0, 0x04], [-4, 0, 0, 0, 0x06],
  [-3, -1, 0, 0, 0x08], [-2, -1, 0, 0, 0x0a],
  [-1, -2, 0, 0, 0x0c], [-1, 0, 0, 0, 0x0e],
  [0, -2, 0, 0, 0x10], [0, 0, 0, 0, 0x12],
  [1, -2, 0, 0, 0x14], [1, 0, 0, 0, 0x16],
  [2, -2, 0, 0, 0x18], [2, 0, 0, 0, 0x1a],
  [3, -1, 0, 0, 0x1c], [4, -1, 0, 0, 0x1e],
];
const LUGIA_2: Oam[] = [
  [-5, -2, 0, 0, 0x00], [-5, 0, 0, 0, 0x02],
  [-4, -2, 0, 0, 0x04], [-4, 0, 0, 0, 0x06],
  [-3, -1, 0, 0, 0x08], [-2, -1, 0, 0, 0x0a],
  [-1, -2, 0, 0, 0x0c], [-1, 0, 0, 0, 0x0e],
  [0, -2, 0, 0, 0x10], [0, 0, 0, 0, 0x12],
  [1, -2, 0, 0, 0x14], [1, 0, 0, 0, 0x16],
  [2, -2, 0, 0, 0x18], [2, 0, 0, 0, 0x1a],
  [3, -2, 0, 0, 0x1c], [4, -2, 0, 0, 0x1e],
];
/** :2300-2304 — Silver's five oamsets, [layout, vtile base] (oam.asm:103-107). */
const LUGIA_FRAMES: [Oam[], number][] = [
  [LUGIA_1, 0x00], [LUGIA_1, 0x20], [LUGIA_2, 0x40], [LUGIA_2, 0x60], [LUGIA_1, 0x00],
];
/** :2308-2314 — Frameset_GSIntroHoOhLugia, Gold: [1-based frame, duration]. */
const HOOH_SEQUENCE: [number, number][] = [[1, 10], [2, 9], [3, 10], [4, 10], [3, 9], [5, 10]];
/** :2305-2307 — the same frameset, Silver, on a faster clock. */
const LUGIA_SEQUENCE: [number, number][] = [
  [2, 3], [1, 7], [2, 7], [3, 7], [3, 7], [4, 7], [4, 7], [3, 7], [2, 3],
];
/** :2316-2317 — the pose canvas and its origin (Gold; Silver's Lugia spans
 * x tiles -5..4, four tiles wider than Ho-Oh's -4..3). */
const POSE_W = 64;
const POSE_H = 64;
const ORIGIN_X = 32;
const ORIGIN_Y = 24;
const POSE_W_SILVER = 80;
const ORIGIN_X_SILVER = 40;

/** :2371-2378 — PlaceString lines over CopyrightGFX ($60-based ids). */
const COPY_LINES = [
  [0x60, 0x61, 0x62, 0x63, 0x7a, 0x7b, 0x7c, 0x7d, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a],
  [0x60, 0x61, 0x62, 0x63, 0x7a, 0x7b, 0x7c, 0x7d, 0x6b, 0x6c, 0x6d, 0x6e, 0x6f, 0x70, 0x71, 0x72],
  [0x60, 0x61, 0x62, 0x63, 0x7a, 0x7b, 0x7c, 0x7d, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x71, 0x72],
];

/** :2321-2334 — one Ho-Oh (or Lugia) pose from its oamset, on an EMPTY
 * (transparent) canvas: each entry is an 8x16 object, tiles base+vtile and
 * base+vtile+1. */
export function hoohPose(tiles: GfxImage[], oam: Oam[], base = 0, originX = ORIGIN_X, poseW = POSE_W): GfxImage {
  const pose = new GfxImage(poseW, POSE_H, TRANSPARENT);
  for (const [tx, ty, dx, dy, vtile] of oam) {
    const px = originX + tx * 8 + dx;
    const py = ORIGIN_Y + ty * 8 + dy;
    blitSprite(pose, tiles[base + vtile], px, py);
    blitSprite(pose, tiles[base + vtile + 1], px, py + 8);
  }
  return pose;
}

/**
 * RomExtractorGen2.lua:2043 extractTitle (Gold). title.json (the
 * `assets/generated/<rel>.png` paths are gfx keys `<rel>`):
 * {generation 2, layout "gold_title", source, screen "title/title_screen"
 * (160x144), clouds "title/clouds" (160x48), image "title/pokemon_logo"
 * (160x56), hooh "title/hooh" (= frame 1), hoohFrames [5 keys, 64x64,
 * transparent], screenGray, cloudsGray, hoohFramesGray, trailGray,
 * hoohSequence [[frame 1-based, duration]], hoohBobAmplitude 2, hoohBobStep 1,
 * hoohX 48, hoohY 56, trail "title/trail" (8x16), copyright
 * "title/copyright" (240x8), copyrightSplash (160x144), cloudScrollEvery 8,
 * cloudY 88, sky/below [r,g,b] 0..1 (Brian's floats), trailMode "gold",
 * trailSpawns [[x,y]...], trailSpawnEvery 4, trailStepX 4, trailStepY 1,
 * trailBobAmplitude 2, trailPhaseStep 3, timeoutFrames 5056} plus the
 * colour data that replaces his baked RGB sheets (file comment):
 * screenPalettes, screenPalMap, hoohPalette, trailPalette. trailPhase is
 * nil for Gold, so omitted.
 */
export function extractTitle(ctx: Gen2Ctx): Record<string, unknown> {
  const { rom } = ctx;
  const silver = ctx.edition === "silver";
  const bgPals = silver ? TITLE_BG_PALS_SILVER_5 : TITLE_BG_PALS_5;
  const objBird = silver ? OBJ_SILVER_5 : OBJ_HOOH_5;
  const objTrail = silver ? OBJ_SILVER_5 : OBJ_TRAIL_5;
  const obp0 = silver ? DMG_OBP_SILVER : DMG_OBP0;
  const obp1 = silver ? DMG_OBP_SILVER : DMG_OBP1;
  const originX = silver ? ORIGIN_X_SILVER : ORIGIN_X;
  const poseW = silver ? POSE_W_SILVER : POSE_W;

  // :2177-2185 — GFX1 is vTiles2 ($00-$7F), GFX2 vTiles1 ($80+).
  const vtiles2 = tilesFrom2bpp(ctx.decompressLz3Symbol("TitleScreenGFX1"));
  const vtiles1 = tilesFrom2bpp(ctx.decompressLz3Symbol("TitleScreenGFX2"));
  const tileFor = (id: number) => (id < 0x80 ? vtiles2[id] : vtiles1[id - 0x80]);

  // :2186-2206 — the composed screen. DEVIATION: saved as shades, not
  // colorized; screenPalettes + screenPalMap carry the colour.
  const map = ctx.symbol("TitleScreenTilemap");
  const screen = composeTitleScreen((i) => rom.byte(map.bank, map.address + i), tileFor);
  const screenKey = save(ctx, screen, "title/title_screen.png");
  // :2215 — the grey set, through rBGP.
  const screenGray = throughRegister(screen, DMG_BGP);
  const screenGrayKey = save(ctx, screenGray, "title/title_screen_gray.png");
  // :2217-2227 — cloud band (rows 11-16) and logo strip (rows 0-6).
  const cloudsKey = save(ctx, crop(screen, 88, 48), "title/clouds.png");
  const cloudsGrayKey = save(ctx, crop(screenGray, 88, 48), "title/clouds_gray.png");
  const logoKey = save(ctx, crop(screen, 0, 56), "title/pokemon_logo.png");
  const screenPalMap: number[] = [];
  for (let row = 0; row < 18; row++) for (let col = 0; col < 20; col++) screenPalMap.push(bgPalAt(col, row));

  // :2231 + :2318-2343 — Ho-Oh's poses. DEVIATION: the tinted pose is the
  // shade pose (hoohPalette carries OBJ_HOOH).
  const hoohTiles = tilesFrom2bpp(ctx.decompressLz3Symbol("TitleScreenGFX4"), true);
  const hoohFrames: string[] = [];
  const hoohFramesGray: string[] = [];
  const frames: [Oam[], number][] = silver ? LUGIA_FRAMES : HOOH_FRAMES.map((oam) => [oam, 0]);
  frames.forEach(([oam, base], i) => {
    const pose = hoohPose(hoohTiles, oam, base, originX, poseW);
    hoohFrames.push(save(ctx, pose, `title/hooh_${i + 1}.png`));
    hoohFramesGray.push(save(ctx, throughRegister(pose, obp0), `title/hooh_${i + 1}_gray.png`));
    if (i === 0) save(ctx, pose, "title/hooh.png");
  });

  // :2345-2363 — the trail: raw 2bpp; Gold's OAM is one 8x16 object,
  // Silver's two side by side, and only 4 of Silver's 8 copied tiles exist.
  const trailSym = ctx.symbol("TitleScreenGFX3");
  const trailTiles = tilesFrom2bpp(rom.bytes(trailSym.bank, trailSym.address, (silver ? 4 : 8) * 16), true);
  const trail = new GfxImage(silver ? 16 : 8, 16, TRANSPARENT);
  blitSprite(trail, trailTiles[0], 0, 0);
  blitSprite(trail, trailTiles[1], 0, 8);
  if (silver) {
    blitSprite(trail, trailTiles[2], 8, 0);
    blitSprite(trail, trailTiles[3], 8, 8);
  }
  const trailKey = save(ctx, trail, "title/trail.png");
  const trailGrayKey = save(ctx, throughRegister(trail, obp1), "title/trail_gray.png");

  // :2365-2389 — copyright tiles and the splash (hlcoord 2, 7 + line).
  const copyright = ctx.symbol("CopyrightGFX");
  const copyRaw = rom.bytes(copyright.bank, copyright.address, 30 * 16);
  const copyTiles = tilesFrom2bpp(copyRaw);
  const copyrightKey = write2bpp(ctx, copyRaw, 240, 8, "title/copyright.png");
  const splash = new GfxImage(160, 144, 0);
  COPY_LINES.forEach((line, li) => {
    const y = (7 + li) * 8;
    let x = 2 * 8;
    for (const tid of line) {
      const tile = copyTiles[tid - 0x60];
      if (tile) blit(splash, tile, x, y);
      x += 8;
    }
  });
  const splashKey = save(ctx, splash, "title/copyright_splash.png");

  const bg = bgPals;
  const f31 = (c: [number, number, number]) => [c[0] / 31, c[1] / 31, c[2] / 31];
  // :2392-2462
  return {
    title: {
      generation: 2,
      layout: "gold_title",
      source: "ROM:TitleScreenTilemap + TitleScreenGFX1/2/3/4, CopyrightGFX",
      screen: screenKey,
      clouds: cloudsKey,
      image: logoKey,
      hooh: "title/hooh",
      hoohFrames,
      screenGray: screenGrayKey,
      cloudsGray: cloudsGrayKey,
      hoohFramesGray,
      trailGray: trailGrayKey,
      hoohSequence: silver ? LUGIA_SEQUENCE : HOOH_SEQUENCE,
      hoohBobAmplitude: silver ? 8 : 2,
      hoohBobStep: silver ? -1 : 1,
      hoohX: 80 - originX,
      hoohY: 80 - ORIGIN_Y,
      trail: trailKey,
      copyright: copyrightKey,
      copyrightSplash: splashKey,
      // Silver decrements the cloud band's SCX every frame, Gold every 8
      cloudScrollEvery: silver ? 1 : 8,
      cloudY: 88,
      sky: f31(bg[0]![2]!),
      // under the band: Gold's cloud field (colour 0), Silver's sea floor (3)
      below: f31(bg[0]![silver ? 3 : 0]!),
      trailMode: silver ? "silver" : "gold",
      trailSpawns: silver ? [[72, 100]] : [[80, 88], [104, 88], [104, 88], [120, 88], [120, 88], [88, 88]],
      trailSpawnEvery: 4,
      trailStepX: 4,
      trailStepY: silver ? 0 : 1,
      trailBobAmplitude: silver ? 3 : 2,
      trailPhaseStep: silver ? 7 : 3,
      ...(silver ? { trailPhase: 0 } : {}),
      timeoutFrames: silver ? 73 * 60 + 36 : 84 * 60 + 16,
      // DEVIATION (file comment): the colours Brian baked into the sheets.
      screenPalettes: bg.map(toRgb),
      screenPalMap,
      hoohPalette: toRgb(objBird),
      trailPalette: toRgb(objTrail),
    },
  };
}
