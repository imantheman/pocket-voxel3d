// Port of gen1recomp RomExtractorGen2.lua:616-1168 (bdfac727): readPalMap,
// the tileset animation programs (animStrip/readTilesetAnim),
// extractTilesets and extractRoofs, with the Crystal two-VRAM-bank sheet
// (crystalTilesetSheet, readCrystalPalMap, decodePalNibble, tileAttrs):
// Crystal's sheet is 256 tiles (bank 1 from tile $80) and its PalMap 112
// bytes; `tileAttrs` is Crystal-only.
//
// Image paths: Brian's `assets/generated/<rel>.png` become the gfx key
// `<rel>` (e.g. "tilesets/johto"), the entry in gen/gfx.json.

import { decode2bpp } from "../gfx.ts";
import type { Gen2Ctx } from "./ctx.ts";
import { decompressLz3 } from "./lz.ts";

/** RomExtractorGen2.lua:58 — gfx/tileset_palette_maps.asm is in "bank2"
 * (main.asm) and the Tilesets row stores only a 16-bit pointer. */
export const PAL_MAP_BANK = 0x02;
/** :59 — Crystal moved the include to "bank13" (pokecrystal main.asm:192-195). */
export const PAL_MAP_BANK_CRYSTAL = 0x13;
/** :66 — home/map.asm:1368 copies a second $60 tiles to VRAM bank 1; the
 * id's bit 7 carries the bank (engine/tilesets/map_palettes.asm:40). */
export const TILESET_VRAM_TILES = 256;
/** :67 */
const CRYSTAL_PAL_MAP_BYTES = 112;

/** RomExtractorGen2.lua:241 palMapBank. */
export function palMapBank(ctx: Gen2Ctx): number {
  return ctx.crystal ? PAL_MAP_BANK_CRYSTAL : PAL_MAP_BANK;
}

/** :621 decodePalNibble — one PalMap nibble's GBC attributes (palette
 * 1-BASED like tilePalettes; bit 3 the VRAM bank). */
export interface TileAttr {
  palette: number;
  vramBank: number;
  xFlip: boolean;
  yFlip: boolean;
  priority: boolean;
}

function decodePalNibble(n: number): TileAttr {
  n %= 16;
  return { palette: (n % 8) + 1, vramBank: Math.floor(n / 8) % 2, xFlip: false, yFlip: false, priority: false };
}

/**
 * RomExtractorGen2.lua:662 readCrystalPalMap — 48 bytes for bank 0, $ff
 * padding, 48 bytes for bank 1, two tiles a byte (low nibble first). Bank-1
 * entries land on tile ids $80-$df, so both arrays are indexed by tile id
 * (sparse between $60 and $7f).
 */
export function readCrystalPalMap(ctx: Gen2Ctx, address: number): { palettes: number[]; attrs: TileAttr[] } {
  const raw = ctx.rom.bytes(palMapBank(ctx), address, CRYSTAL_PAL_MAP_BYTES);
  const palettes: number[] = [];
  const attrs: TileAttr[] = [];
  const pair = (tileId: number, byte: number): void => {
    [byte % 16, Math.floor(byte / 16) % 16].forEach((n, i) => {
      const a = decodePalNibble(n);
      attrs[tileId + i] = a;
      palettes[tileId + i] = a.palette;
    });
  };
  let i = 0;
  let tileId = 0;
  for (let count = 0; i < raw.length && count < 48; count++, i++) {
    if (raw[i] === 0xff) break;
    pair(tileId, raw[i]!);
    tileId += 2;
  }
  while (i < raw.length && raw[i] === 0xff) i++;
  tileId = 0x80;
  for (let count = 0; i < raw.length && count < 48; count++, i++) {
    if (raw[i] === 0xff) break;
    pair(tileId, raw[i]!);
    tileId += 2;
  }
  return { palettes, attrs };
}

/** :1004 crystalTilesetSheet — LoadTilesetGFX's two CopyBytes: the first
 * 96 tiles to bank 0, the next 96 to bank 1 at tile $80. */
export function crystalTilesetSheet(pixels: number[]): number[] {
  const half = TILESET_TILE_COUNT * 16;
  const bank1 = (TILESET_VRAM_TILES / 2) * 16;
  const out = new Array<number>(bank1 + half).fill(0);
  for (let i = 0; i < half; i++) {
    out[i] = pixels[i] ?? 0;
    out[bank1 + i] = pixels[half + i] ?? 0;
  }
  return out;
}
/** :63 — a Gold tileset sheet is 96 tiles, 128x48. */
export const TILESET_TILE_COUNT = 96;
/** :73 — 128 metatiles (16 tile ids each) and 128 collision quads. */
export const METATILE_COUNT = 128;
/** data/tilesets.asm `tileset` macro: dba GFX, Meta, Coll; dw Anim, NULL, PalMap. */
export const TILESET_LENGTH = 15;
/** :189 — Roofs sets are 9 tiles. */
const ROOF_TILES = 9;

/**
 * RomExtractorGen2.lua:698 readPalMap (Gold path) as a pure function of the
 * 48 raw bytes. `tilepal` emits `dn (bank|PAL second), (bank|PAL first)`:
 * low nibble = even tile, high nibble = odd tile; `% 8` drops the VRAM-bank
 * bit. Values are 1-BASED PAL_BG_* slots (Lua indexes an 8-entry set with
 * them); the array itself is 0-based by tile id.
 */
export function decodePalMap(raw: number[]): number[] {
  const out: number[] = [];
  for (const byte of raw) {
    out.push((byte % 8) + 1);
    out.push((Math.floor(byte / 16) % 8) + 1);
  }
  return out;
}

/** RomExtractorGen2.lua:698 readPalMap — TILESET_TILE_COUNT/2 bytes in bank
 * 2 on Gold, the 112-byte two-bank map on Crystal. */
export function readPalMap(ctx: Gen2Ctx, address: number): number[] {
  if (ctx.crystal) return readCrystalPalMap(ctx, address).palettes;
  return decodePalMap(ctx.rom.bytes(PAL_MAP_BANK, address, TILESET_TILE_COUNT / 2));
}

/** RomExtractorGen2.lua:888 — the functions a `tileframe` row can name,
 * reverse-mapped by address. The last five are Crystal-only names; Gold's
 * manifest does not carry them, so they simply resolve to nothing. */
const ANIM_FUNCTIONS = [
  "DoneTileAnimation", "WaitTileAnimation",
  "StandingTileFrame", "StandingTileFrame8",
  "AnimateWaterTile", "AnimateFlowerTile", "AnimateWaterPalette",
  "ReadTileToAnimBuffer", "WriteTileFromAnimBuffer",
  "ScrollTileRightLeft", "ScrollTileDown", "ScrollTileUp",
  "ScrollTileLeft", "ScrollTileRight", "AnimateWhirlpoolTile",
  "AnimateLavaBubbleTile1", "AnimateLavaBubbleTile2",
  "AnimateTowerPillarTile", "FlickeringCaveEntrancePalette",
  "AnimateFountainTile",
  "ForestTreeLeftAnimation", "ForestTreeRightAnimation",
  "ForestTreeLeftAnimation2", "ForestTreeRightAnimation2",
];

/** :906-908 */
export const ANIM_BANK = 0x3f;
const ANIM_MAX_FRAMES = 32;
const VTILES2 = 0x9000;

/** :913 — tiles each shared strip's function can index (tileset_anims.asm
 * whirlpool `and %11`, tower pillar's 0..4 table, lava `and %011`). */
const ANIM_STRIP_FRAMES: Record<string, number> = { whirlpool: 4, tower: 5, lava: 4 };

/** :917 — functions whose argument is a `dw vTiles2 tile, dw frames` pair in
 * bank $3f rather than a VRAM address. */
const ANIM_POINTER_KIND: Record<string, string> = {
  AnimateWhirlpoolTile: "whirlpool",
  AnimateTowerPillarTile: "tower",
};

export interface AnimStrip {
  /** gfx key, e.g. "tilesets/anim/whirlpool_2f" (8 x frames*8). */
  image: string;
  frames: number;
}

export interface AnimFrame {
  /** Function name, or "unknown_%04x" for an address with no symbol. */
  func: string;
  /** 0-based vTiles2 tile id the step writes. */
  tile?: number;
  /** gfx key of the shared strip the step copies from. */
  sheet?: string;
  frames?: number;
  /** A ReadTileToAnimBuffer..WriteTileFromAnimBuffer run: how far one pass
   * scrolls the tile (h: right-left steps, v: down minus up). */
  scroll?: { h: number; v: number };
}

export interface TilesetAnim {
  /** Rows per pass (the row count; DoneTileAnimation wraps). */
  period: number;
  frames: AnimFrame[];
}

/** RomExtractorGen2.lua:924 animStrip — one shared frame strip, written once
 * however many tilesets name it. */
function animStrip(
  ctx: Gen2Ctx,
  strips: Record<string, AnimStrip>,
  name: string,
  kind: string,
  bank: number,
  address: number,
): AnimStrip {
  if (!strips[name]) {
    const count = ANIM_STRIP_FRAMES[kind]!;
    const key = `tilesets/anim/${name}`;
    ctx.gfx.add(key, decode2bpp(ctx.rom.bytes(bank, address, count * 16), 8, count * 8));
    strips[name] = { image: key, frames: count };
  }
  return strips[name]!;
}

const hex2 = (value: number): string => value.toString(16).padStart(2, "0");

/**
 * RomExtractorGen2.lua:937 readTilesetAnim — one tileset's wTilesetAnim
 * program (4-byte `dw arg, dw func` rows in bank $3f). _AnimateTileset runs
 * one row per frame and DoneTileAnimation wraps, so the row count is the
 * period. Undefined (omitted) for a zero pointer or a program with no
 * DoneTileAnimation within 32 rows.
 */
export function readTilesetAnim(
  ctx: Gen2Ctx,
  address: number,
  byAddress: Map<number, string>,
  strips: Record<string, AnimStrip>,
): TilesetAnim | undefined {
  if (!(address > 0)) return undefined;
  const { rom } = ctx;
  const frames: AnimFrame[] = [];
  let pending: { h: number; v: number } | undefined;
  for (let index = 0; index < ANIM_MAX_FRAMES; index++) {
    const at = address + index * 4;
    if (at + 3 >= 0x8000) break;
    const arg = rom.word(ANIM_BANK, at);
    const func = rom.word(ANIM_BANK, at + 2);
    const name = byAddress.get(func);
    // :953 — a step with no symbol costs that frame, not the program.
    const frame: AnimFrame = { func: name ?? `unknown_${func.toString(16).padStart(4, "0")}` };
    if (!name) {
      pending = undefined;
    } else {
      // :959 — a vTiles2 argument is the tile the step writes.
      if (arg >= VTILES2 && arg < VTILES2 + 0x800) frame.tile = Math.floor((arg - VTILES2) / 16);
      const kind = ANIM_POINTER_KIND[name];
      if (kind) {
        const dest = rom.word(ANIM_BANK, arg);
        if (dest >= VTILES2 && dest < VTILES2 + 0x800) {
          frame.tile = Math.floor((dest - VTILES2) / 16);
          const strip = animStrip(
            ctx, strips, `${kind}_${hex2(frame.tile)}`, kind, ANIM_BANK, rom.word(ANIM_BANK, arg + 2),
          );
          frame.sheet = strip.image;
          frame.frames = strip.frames;
        }
      } else if (name === "AnimateLavaBubbleTile1" || name === "AnimateLavaBubbleTile2") {
        // :974 — no argument: tile $5b and tile $38, one shared strip.
        frame.tile = name === "AnimateLavaBubbleTile1" ? 0x5b : 0x38;
        const lava = ctx.location("LavaBubbleTileFrames");
        if (lava) {
          const strip = animStrip(ctx, strips, "lava", "lava", lava[0], lava[1]);
          frame.sheet = strip.image;
          frame.frames = strip.frames;
        }
      } else if (name === "ReadTileToAnimBuffer") {
        pending = { h: 0, v: 0 };
      } else if (name === "ScrollTileRightLeft") {
        if (pending) pending.h += 1;
      } else if (name === "ScrollTileDown") {
        if (pending) pending.v += 1;
      } else if (name === "ScrollTileUp") {
        if (pending) pending.v -= 1;
      } else if (name === "WriteTileFromAnimBuffer") {
        if (pending && frame.tile !== undefined) frame.scroll = pending;
        pending = undefined;
      }
    }
    frames.push(frame);
    if (name === "DoneTileAnimation") return { period: frames.length, frames };
  }
  return undefined;
}

/** One Tilesets row (data/tilesets.asm `tileset` macro), decoded. */
export interface TilesetHeader {
  gfxBank: number;
  gfxAddress: number;
  metaBank: number;
  metaAddress: number;
  collBank: number;
  collAddress: number;
  animAddress: number;
  palMapAddress: number;
}

/** RomExtractorGen2.lua:1047-1055 — the fields of the 15-byte row. */
export function readTilesetHeader(ctx: Gen2Ctx, bank: number, rowAddress: number): TilesetHeader {
  const { rom } = ctx;
  return {
    gfxBank: rom.byte(bank, rowAddress),
    gfxAddress: rom.word(bank, rowAddress + 1),
    metaBank: rom.byte(bank, rowAddress + 3),
    metaAddress: rom.word(bank, rowAddress + 4),
    collBank: rom.byte(bank, rowAddress + 6),
    collAddress: rom.word(bank, rowAddress + 7),
    animAddress: rom.word(bank, rowAddress + 9),
    // +11 is `dw NULL`
    palMapAddress: rom.word(bank, rowAddress + 13),
  };
}

/** RomExtractorGen2.lua:1066 — 128 metatiles of 16 tile ids (row-major 4x4). */
export function readMetatiles(ctx: Gen2Ctx, bank: number, address: number): number[][] {
  const raw = ctx.rom.bytes(bank, address, METATILE_COUNT * 16);
  const blocks: number[][] = [];
  for (let offset = 0; offset < raw.length; offset += 16) blocks.push(raw.slice(offset, offset + 16));
  return blocks;
}

/** RomExtractorGen2.lua:1075 — 128 collision quads of 4 COLL_* bytes
 * (top-left, top-right, bottom-left, bottom-right). */
export function readCollision(ctx: Gen2Ctx, bank: number, address: number): number[][] {
  const raw = ctx.rom.bytes(bank, address, METATILE_COUNT * 4);
  const out: number[][] = [];
  for (let offset = 0; offset < raw.length; offset += 4) out.push(raw.slice(offset, offset + 4));
  return out;
}

/**
 * RomExtractorGen2.lua:1021 extractTilesets. Row index == TILESET_* value
 * (row 0 is the unused Tileset0 alias), so tilesetOrder element i (constant
 * i+1) is at headers.address + (i+1)*15. tilesets.json:
 * - TILESET_X: {id, generation 2, source "ROM:Tilesets[n]" (n = constant),
 *   header (the 15 raw row bytes), image (gfx key "tilesets/<base>"),
 *   imageWidth 128, imageHeight 48, tilesPerRow 16, blocks (128 x 16 tile
 *   ids), collision (128 x 4 COLL_* bytes), anim? (TilesetAnim), palMap
 *   {bank, address}, tilePalettes (96 x 1-BASED PAL_BG slot)};
 * - waterFrames / flowerFrames: gfx keys of the 8x32 frame strips;
 *   flowerCgbFrames [2, 4] (1-BASED rows of flowerFrames the CGB uses);
 * - animFrames: {stripName: {image, frames}} for every shared strip.
 */
export function extractTilesets(ctx: Gen2Ctx): Record<string, unknown> {
  const { rom, gfx } = ctx;
  const order = ctx.manifest.constants.tilesetOrder;
  const headers = ctx.symbol("Tilesets");
  // :1025 — Crystal's sheet is both VRAM banks, 256 tiles (128x128)
  const twoBank = ctx.crystal;
  const sheetTiles = twoBank ? TILESET_VRAM_TILES : TILESET_TILE_COUNT;
  const imageWidth = 128;
  const imageHeight = (sheetTiles / (imageWidth / 8)) * 8;
  const byteLength = (imageWidth * imageHeight) / 4;

  // :1033 — only symbols in bank $3f can be a program's function.
  const animByAddress = new Map<number, string>();
  for (const label of ANIM_FUNCTIONS) {
    const location = ctx.location(label);
    if (location && location[0] === ANIM_BANK) animByAddress.set(location[1], label);
  }
  const animStrips: Record<string, AnimStrip> = {};

  const out: Record<string, unknown> = {};
  for (let i = 0; i < order.length; i++) {
    const constName = order[i]!;
    const index = i + 1; // Lua's 1-based ipairs index == the TILESET_* value
    const rowAddress = headers.address + index * TILESET_LENGTH;
    const h = readTilesetHeader(ctx, headers.bank, rowAddress);

    // :1057 — lz3, handed everything to the bank end; padded or truncated
    // to the 96-tile sheet.
    let pixels = decompressLz3(ctx.toBankEnd(h.gfxBank, h.gfxAddress));
    if (twoBank) pixels = crystalTilesetSheet(pixels);
    while (pixels.length < byteLength) pixels.push(0);
    pixels.length = byteLength;
    const base = constName.toLowerCase().replace(/^tileset_/, "");
    const key = `tilesets/${base}`;
    gfx.add(key, decode2bpp(pixels, imageWidth, imageHeight));

    out[constName] = {
      id: constName,
      generation: 2,
      source: `ROM:Tilesets[${index}]`,
      header: rom.bytes(headers.bank, rowAddress, TILESET_LENGTH),
      image: key,
      imageWidth,
      imageHeight,
      tilesPerRow: imageWidth / 8,
      blocks: readMetatiles(ctx, h.metaBank, h.metaAddress),
      collision: readCollision(ctx, h.collBank, h.collAddress),
      // Anim programs live in bank $3f (data/tilesets.asm).
      anim: readTilesetAnim(ctx, h.animAddress, animByAddress, animStrips),
      palMap: { bank: palMapBank(ctx), address: h.palMapAddress },
      ...(twoBank
        ? (() => {
            // :1085 — Crystal: the full attribute per tile id beside the slots
            const map = readCrystalPalMap(ctx, h.palMapAddress);
            return { tilePalettes: map.palettes, tileAttrs: map.attrs };
          })()
        : { tilePalettes: readPalMap(ctx, h.palMapAddress) }),
    };
  }

  // :1113 — the strips every water/flower step writes from
  // (tileset_anims.asm:194, :225): four 8x8 tiles stacked 8x32, BG tiles
  // so no colour-0 key.
  const water = ctx.location("AnimateWaterTile.WaterTileFrames");
  if (water) {
    gfx.add("tilesets/water_frames", decode2bpp(rom.bytes(water[0], water[1], 4 * 16), 8, 32));
    out.waterFrames = "tilesets/water_frames";
  }
  const flower = ctx.location("AnimateFlowerTile.FlowerTileFrames");
  if (flower) {
    gfx.add("tilesets/flower_frames", decode2bpp(rom.bytes(flower[0], flower[1], 4 * 16), 8, 32));
    out.flowerFrames = "tilesets/flower_frames";
    // dmg_1, cgb_1, dmg_2, cgb_2: `and %10` plus hCGB picks rows 2 and 4
    // (1-based, as Brian stores them).
    out.flowerCgbFrames = [2, 4];
  }
  out.animFrames = animStrips;
  return out;
}

/** RomExtractorGen2.lua:1145 — ROOF_NEW_BARK .. ROOF_GOLDENROD. */
export const ROOF_NAMES = ["NEW_BARK", "VIOLET", "AZALEA", "OLIVINE", "GOLDENROD"];

/**
 * RomExtractorGen2.lua:1138 extractRoofs. Outdoor Johto towns replace VRAM
 * tiles $0a-$12 from Roofs, indexed by MapGroupRoofs[group]
 * (engine/tilesets/mapgroup_roofs.asm). roofs.json:
 * {generation 2, roofs: {NEW_BARK: {id, index (0-based), image (gfx key
 * "tilesets/roofs/new_bark", 72x8)}, ...}, mapGroupRoofs: {"<group>": NAME}}
 * — mapGroupRoofs is keyed by 1-based map group and SPARSE (groups with a
 * -1 roof are absent), so it is an object with string keys.
 */
export function extractRoofs(ctx: Gen2Ctx): Record<string, unknown> {
  const { rom, gfx } = ctx;
  const roofs = ctx.symbol("Roofs");
  const groupRoofs = ctx.symbol("MapGroupRoofs");
  const out = {
    generation: 2,
    roofs: {} as Record<string, { id: string; index: number; image: string }>,
    mapGroupRoofs: {} as Record<string, string>,
  };
  for (let index = 0; index < ROOF_NAMES.length; index++) {
    const name = ROOF_NAMES[index]!;
    const pixels = rom.bytes(roofs.bank, roofs.address + index * ROOF_TILES * 16, ROOF_TILES * 16);
    const key = `tilesets/roofs/${name.toLowerCase()}`;
    gfx.add(key, decode2bpp(pixels, 72, 8));
    out.roofs[name] = { id: name, index, image: key };
  }
  // :1158 — one signed byte per group, a leading -1 for group 0.
  for (let group = 1; group <= 26; group++) {
    const value = rom.byte(groupRoofs.bank, groupRoofs.address + group);
    const name = value < 0x80 ? ROOF_NAMES[value] : undefined;
    if (name) out.mapGroupRoofs[String(group)] = name;
  }
  return out;
}
