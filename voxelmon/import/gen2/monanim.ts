// Port of gen1recomp RomExtractorGen2.lua:1604-1720 (bdfac727): the front
// pic animation readers (readMonFrames :1608, readMonAnimScript :1641,
// writeMonAnimSheet :1653, monAnimTables :1677, monAnimation :1701), plus
// the parts of src/render/MonAnim.lua they call (BITMASK_BYTES :8, the
// script command bytes :12-14, tileMap :18).
//
// Gold note: Gold/Silver front pics do not animate -- the pic_animation
// tables (AnimationPointers & co.) are Crystal's, so Gold's manifest names
// none of them, monAnimTables returns undefined and every `anim` is omitted.
// The readers are ported anyway (faithful, and pinned by synthetic tests) so
// the shape is there if a manifest ever supplies the tables.

import { GfxImage, blit, decode2bpp, matteColor0 } from "../gfx.ts";
import type { Gen2Ctx } from "./ctx.ts";
import { columnsToRows, gfxKey, save } from "./helpers.ts";

/** MonAnim.lua:8 — .Sizes db 4, 5, 7: bitmask bytes for a 5x5, 6x6, 7x7 pic. */
export const BITMASK_BYTES: Record<number, number> = { 5: 4, 6: 5, 7: 7 };

/** MonAnim.lua:12-14 (macros/scripts/pic_anims.asm). */
export const ANIM_END = 0xff;
export const ANIM_SETREPEAT = 0xfe;
export const ANIM_DOREPEAT = 0xfd;

/** RomExtractorGen2.lua:1605 — GetMonFramesPointer's Kanto/Johto split. */
export const JOHTO_POKEMON = 152;

/** One frame: `bitmask` is a 1-BASED slot into the bitmasks list (Lua's
 * `bitmasks[slot]`), `tiles` one tile id per set bit. */
export interface MonFrame {
  bitmask: number;
  tiles: number[];
}

/** RomExtractorGen2.lua:1720 — monAnimation's result table. `sheet` is the
 * gfx key "battle/anim/<name>" (a tiles*8 wide column of count+1 pictures,
 * base picture first). play/idle rows are [command, parameter]. */
export interface MonAnimData {
  tiles: number;
  sheet: string;
  count: number;
  bitmasks: number[][];
  frames: MonFrame[];
  play: [number, number][];
  idle: [number, number][];
}

interface MonAnimTables {
  anim: { bank: number; address: number };
  idle: { bank: number; address: number };
  bitmasks: { bank: number; address: number };
  frames: { bank: number; address: number };
  kantoFrames: number;
  johtoFrames: number;
}

/**
 * MonAnim.lua:18 tileMap — the tile ids of picture `frame` (0 = the base
 * picture, 1..n = frames[frame - 1]); bit i of the bitmask is tile i in the
 * column-major pic. undefined where Lua returns nil.
 */
export function tileMap(
  data: { tiles?: number; frames?: MonFrame[]; bitmasks?: number[][] } | undefined,
  frame: number,
): number[] | undefined {
  const tiles = data?.tiles;
  if (!tiles) return undefined;
  const count = tiles * tiles;
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(i);
  if (!frame || frame <= 0) return out;
  const row = data.frames?.[frame - 1];
  const mask = row && data.bitmasks?.[row.bitmask - 1];
  if (!row || !mask) return undefined;
  let cursor = 0;
  for (let i = 0; i < count; i++) {
    const byte = mask[Math.floor(i / 8)] ?? 0;
    if ((byte >> (i % 8)) & 1) {
      const id = row.tiles[cursor];
      if (id === undefined) return undefined;
      out[i] = id;
      cursor += 1;
    }
  }
  return out;
}

/**
 * RomExtractorGen2.lua:1608 readMonFrames — one `dw` per frame (the first
 * points past the list, so the gap is the count), each frame a bitmask id
 * then one tile per set bit. Bitmasks are deduplicated by id into 1-based
 * slots. undefined when the blob does not read back cleanly.
 */
export function readMonFrames(
  ctx: Gen2Ctx,
  bank: number,
  address: number,
  bitmaskBank: number,
  bitmaskAddress: number,
  tiles: number,
): { frames: MonFrame[]; bitmasks: number[][] } | undefined {
  const { rom } = ctx;
  const first = rom.word(bank, address);
  const count = (first - address) / 2;
  if (count < 1 || count > 64 || count % 1 !== 0) return undefined;
  const width = BITMASK_BYTES[tiles];
  if (!width) return undefined;
  const bitmasks: number[][] = [];
  const ids = new Map<number, number>();
  const frames: MonFrame[] = [];
  for (let index = 0; index < count; index++) {
    const pointer = rom.word(bank, address + index * 2);
    const raw = rom.byte(bank, pointer);
    let slot = ids.get(raw);
    if (slot === undefined) {
      bitmasks.push(rom.bytes(bitmaskBank, bitmaskAddress + raw * width, width));
      slot = bitmasks.length; // 1-based, as Lua's #bitmasks + 1
      ids.set(raw, slot);
    }
    const mask = bitmasks[slot - 1]!;
    const list: number[] = [];
    for (let bit = 0; bit < tiles * tiles; bit++) {
      const byte = mask[Math.floor(bit / 8)] ?? 0;
      if ((byte >> (bit % 8)) & 1) list.push(rom.byte(bank, pointer + list.length + 1));
    }
    frames.push({ bitmask: slot, tiles: list });
  }
  return { frames, bitmasks };
}

/** RomExtractorGen2.lua:1641 readMonAnimScript — (command, parameter) pairs
 * up to the $ff; undefined when no end within 128 rows. */
export function readMonAnimScript(ctx: Gen2Ctx, bank: number, address: number): [number, number][] | undefined {
  const rows: [number, number][] = [];
  for (let index = 0; index < 128; index++) {
    const command = ctx.rom.byte(bank, address + index * 2);
    if (command === ANIM_END) return rows;
    rows.push([command, ctx.rom.byte(bank, address + index * 2 + 1)]);
  }
  return undefined;
}

/**
 * RomExtractorGen2.lua:1653 writeMonAnimSheet — one column of whole
 * pictures, base first, each matted like writeCompressedPic. Returns the
 * gfx key, or undefined (nothing saved) when a tile id runs off the stream.
 */
export function writeMonAnimSheet(
  ctx: Gen2Ctx,
  stream: number[],
  tiles: number,
  frames: MonFrame[],
  bitmasks: number[][],
  relative: string,
): string | undefined {
  const size = tiles * 8;
  const perTile = 16;
  const available = Math.floor(stream.length / perTile);
  // ImageWriter.blank(..., 0, 0, 0, 0): alpha 0 = transparent.
  const sheet = new GfxImage(size, size * (frames.length + 1));
  const data = { tiles, frames, bitmasks };
  for (let index = 0; index <= frames.length; index++) {
    const map = tileMap(data, index);
    if (!map) return undefined;
    const raw: number[] = [];
    for (const id of map) {
      if (id >= available) return undefined;
      for (let offset = 0; offset < perTile; offset++) raw.push(stream[id * perTile + offset]!);
    }
    const image = matteColor0(decode2bpp(columnsToRows(raw, tiles, tiles), size, size));
    blit(sheet, image, 0, index * size);
  }
  save(ctx, sheet, relative);
  return gfxKey(relative);
}

/** RomExtractorGen2.lua:1677 monAnimTables — the four pointer tables (the
 * Unown set when `unown`), or undefined when the ROM names any of them not. */
export function monAnimTables(ctx: Gen2Ctx, unown: boolean): MonAnimTables | undefined {
  const prefix = unown ? "Unown" : "";
  const at = (name: string) => {
    const location = ctx.location(prefix + name);
    return location ? { bank: location[0], address: location[1] } : undefined;
  };
  const anim = at("AnimationPointers");
  const idle = at("AnimationIdlePointers");
  const bitmasks = at("BitmasksPointers");
  const frames = at("FramesPointers");
  if (!anim || !idle || !bitmasks || !frames) return undefined;
  // :1690 — KantoFrames shares FramesPointers' section, JohtoFrames
  // UnownFramesPointers'.
  const johto = ctx.location("UnownFramesPointers");
  if (!johto) return undefined;
  return {
    anim, idle, bitmasks, frames,
    kantoFrames: frames.bank,
    johtoFrames: unown ? frames.bank : johto[0],
  };
}

/** RomExtractorGen2.lua:1701 monAnimation — `index` is the 1-based row
 * (dex number, or Unown letter + 1). Throws on a bad read, like the Lua
 * (its callers pcall it). */
export function monAnimation(
  ctx: Gen2Ctx,
  tables: MonAnimTables | undefined,
  index: number,
  tiles: number | undefined,
  stream: number[] | undefined,
  name: string,
): MonAnimData | undefined {
  if (!tables || !stream || !tiles) return undefined;
  const { rom } = ctx;
  const read = readMonFrames(
    ctx,
    index < JOHTO_POKEMON ? tables.kantoFrames : tables.johtoFrames,
    rom.word(tables.frames.bank, tables.frames.address + (index - 1) * 2),
    tables.bitmasks.bank,
    rom.word(tables.bitmasks.bank, tables.bitmasks.address + (index - 1) * 2),
    tiles,
  );
  if (!read) return undefined;
  const play = readMonAnimScript(ctx, tables.anim.bank, rom.word(tables.anim.bank, tables.anim.address + (index - 1) * 2));
  const idle = readMonAnimScript(ctx, tables.idle.bank, rom.word(tables.idle.bank, tables.idle.address + (index - 1) * 2));
  if (!play || !idle || play.length === 0) return undefined;
  const sheet = writeMonAnimSheet(ctx, stream, tiles, read.frames, read.bitmasks, `battle/anim/${name}.png`);
  if (!sheet) return undefined;
  return { tiles, sheet, count: read.frames.length, bitmasks: read.bitmasks, frames: read.frames, play, idle };
}

/** Lua's `pcall(self.monAnimation, ...)`: a throw becomes undefined. */
export function tryMonAnimation(...args: Parameters<typeof monAnimation>): MonAnimData | undefined {
  try {
    return monAnimation(...args);
  } catch {
    return undefined;
  }
}
