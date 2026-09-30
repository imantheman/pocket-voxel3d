// Port of gen1recomp RomExtractorGen2.lua:1487-1544 extractSprites
// (bdfac727): the overworld sheets only. extractMonSprites (:1562, the
// SPRITE_POKEMON-and-up ids that reuse party-menu icons) is not ported yet:
// it points at the icon sheets extractIcons writes, a later stage.

import { check } from "../ctx.ts";
import { decode2bpp } from "../gfx.ts";
import type { Gen2Ctx } from "./ctx.ts";

/** :190 — OverworldSprites rows (data/sprites/sprites.asm): dw addr, db
 * length (bytes), db bank, db type, db palette. */
export const SPRITEDATA_LENGTH = 6;

/** :193 — overworld_sprite type bytes. */
export const WALKING_SPRITE = 1;
export const STANDING_SPRITE = 2;
export const STILL_SPRITE = 3;
const SPRITE_TYPE_NAME: Record<number, string> = {
  [WALKING_SPRITE]: "WALKING_SPRITE",
  [STANDING_SPRITE]: "STANDING_SPRITE",
  [STILL_SPRITE]: "STILL_SPRITE",
};
/** :199 */
const SPRITE_PALETTE_NAME: Record<number, string> = {
  0: "PAL_OW_RED", 1: "PAL_OW_BLUE", 2: "PAL_OW_GREEN", 3: "PAL_OW_BROWN",
  4: "PAL_OW_PINK", 5: "PAL_OW_EMOTE", 6: "PAL_OW_TREE", 7: "PAL_OW_ROCK",
};

export interface SpriteEntry {
  id: string;
  source: string;
  /** gfx key "sprites/<base>": 16 wide, frames*16 tall, colour 0 transparent */
  image: string;
  frames: number;
  walker: boolean;
  spriteType: string | number;
  palette: string | number;
  paletteId: number;
}

/**
 * RomExtractorGen2.lua:1498 extractSprites. The length byte is already in
 * bytes; a WALKING_SPRITE stores standing + walking halves back to back, so
 * it reads size*2. Sheets are Gen 1's 16-wide strips (stand down/up/left,
 * walk down/up/left; right = X-flip). Only the first numOverworldSprites
 * ids are rows of this table. sprites.json: {SPRITE_X: SpriteEntry} with
 * source "ROM:OverworldSprites[n]" (n 0-based row).
 */
export function extractSprites(ctx: Gen2Ctx): Record<string, SpriteEntry> {
  const { rom, gfx } = ctx;
  const consts = ctx.manifest.constants;
  const order = consts.spriteOrder;
  const rows = consts.numOverworldSprites ?? order.length;
  const table = ctx.symbol("OverworldSprites");
  const out: Record<string, SpriteEntry> = {};
  for (let row = 0; row < rows; row++) {
    const constName = order[row]!;
    const rowAddr = table.address + row * SPRITEDATA_LENGTH;
    const pointer = rom.word(table.bank, rowAddr);
    const sizeBytes = rom.byte(table.bank, rowAddr + 2);
    const bank = rom.byte(table.bank, rowAddr + 3);
    const spriteType = rom.byte(table.bank, rowAddr + 4);
    const palette = rom.byte(table.bank, rowAddr + 5);
    const byteLength = spriteType === WALKING_SPRITE ? sizeBytes * 2 : sizeBytes;
    const width = 16;
    check(byteLength > 0 && byteLength % 16 === 0, `${constName}: sprite length not tile-aligned`);
    const height = (byteLength * 4) / width;
    check(height % 16 === 0, `${constName}: sprite height not frame-aligned`);
    const frames = height / 16;
    const walker = spriteType === WALKING_SPRITE || frames >= 6;
    const base = constName.toLowerCase().replace(/^sprite_/, "");
    const key = `sprites/${base}`;
    // :1524 — written once per base name.
    if (!gfx.has(key)) {
      gfx.add(key, decode2bpp(rom.bytes(bank, pointer, byteLength), width, height, true), walker ? { walker } : undefined);
    }
    out[constName] = {
      id: constName,
      source: `ROM:OverworldSprites[${row}]`,
      image: key,
      frames,
      walker,
      spriteType: SPRITE_TYPE_NAME[spriteType] ?? spriteType,
      palette: SPRITE_PALETTE_NAME[palette] ?? palette,
      paletteId: palette,
    };
  }
  return out;
}
