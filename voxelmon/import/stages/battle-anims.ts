// The composed battle move animations — beams, blobs, rings, projectiles.
//
// Port of gen1recomp tools/extract/battle_anims.py, reading the ROM through
// the manifest's symbols rather than pokered's asm sources, so a player only
// needs their own cartridge dump.
//
//   AttackAnimationPointers  one entry per move (NUM_ATTACKS = 165) and then
//                            the misc animations (SHOWPIC_ANIM, TOSS_ANIM,
//                            the status/ball/screen ones). Each block is
//                            `battle_anim` rows terminated by $FF:
//                              3 bytes: (tileset << 6) | delay, sound - 1,
//                                       subanimation id
//                              2 bytes: special effect id (>= $D8), sound - 1
//                            PlayAnimation (engine/battle/animations.asm:164)
//                            dispatches on that first byte.
//   SubanimationPointers     db (SUBANIMTYPE << 5) | frame_block_count, then
//                            count * (frame block, base coord, mode).
//   FrameBlockPointers       db tile_count, then tile_count OAM entries of
//                            (y, x, tile, attrs) relative to the base coord.
//   FrameBlockBaseCoords     (y, x) pairs in OAM space (screen y + 16, x + 8).
//   MoveAnimationTilesPointers
//                            per tileset: db tile_count, dw tiles, db bank.
//                            The tiles are 2bpp, laid out 16 to a row, and
//                            become one sheet per tileset in the gfx bin.

import { check } from "../ctx.ts";
import type { Ctx } from "../ctx.ts";
import { decode2bpp } from "../gfx.ts";

/** One row of a move's animation script. */
export type AnimRow =
  | { sub: number; tileset: number; delay: number; sound: number | null }
  | { effect: string; sound: number | null };

interface Subanim {
  type: string;
  blocks: { block: number; base: number; mode: number }[];
}

/** Tiles are 8x8, sixteen to a row, as pokered's sheets are laid out. */
const TILES_PER_ROW = 16;
const TILE_PX = 8;

export function extractBattleAnims(ctx: Ctx): Record<string, unknown> {
  const { rom, manifest, gfx } = ctx;
  const spec = manifest.battleAnimations;
  check(spec !== undefined, "manifest has no battleAnimations block");
  const moveOrder = manifest.constants.moveOrder;
  check(
    moveOrder.length === spec.moveCount,
    `move order (${moveOrder.length}) disagrees with moveCount (${spec.moveCount})`,
  );

  const sound = (raw: number): number | null => (raw === 0xff ? null : raw + 1);

  // --- the per-animation scripts -----------------------------------------
  const ptr = ctx.symbol("AttackAnimationPointers");
  const names = [...moveOrder, ...spec.miscAnimations];
  const anims: Record<string, AnimRow[]> = {};
  for (let index = 0; index < names.length; index++) {
    let address = rom.word(ptr.bank, ptr.address + index * 2);
    const rows: AnimRow[] = [];
    for (let guard = 0; guard < 64; guard++) {
      const first = rom.byte(ptr.bank, address);
      if (first === 0xff) break;
      if (first >= spec.firstSpecialEffect) {
        const effect = spec.specialEffects[String(first)];
        check(effect !== undefined, `unknown special effect ${first} in ${names[index]}`);
        rows.push({ effect, sound: sound(rom.byte(ptr.bank, address + 1)) });
        address += 2;
      } else {
        rows.push({
          sub: rom.byte(ptr.bank, address + 2),
          tileset: first >> 6,
          delay: first & 0x3f,
          sound: sound(rom.byte(ptr.bank, address + 1)),
        });
        address += 3;
      }
      check(guard < 63, `${names[index]}: animation script did not terminate`);
    }
    anims[names[index]] = rows;
  }

  // --- subanimations ------------------------------------------------------
  const subPtr = ctx.symbol("SubanimationPointers");
  const subanims: Subanim[] = [];
  for (let index = 0; index < spec.subanimCount; index++) {
    const address = rom.word(subPtr.bank, subPtr.address + index * 2);
    const head = rom.byte(subPtr.bank, address);
    const type = spec.subanimTypes[head >> 5];
    check(type !== undefined, `subanimation ${index} has unknown type ${head >> 5}`);
    const count = head & 0x1f;
    const blocks = [];
    for (let i = 0; i < count; i++) {
      const at = address + 1 + i * 3;
      blocks.push({
        block: rom.byte(subPtr.bank, at),
        base: rom.byte(subPtr.bank, at + 1),
        mode: rom.byte(subPtr.bank, at + 2),
      });
    }
    subanims.push({ type, blocks });
  }

  // --- frame blocks -------------------------------------------------------
  const fbPtr = ctx.symbol("FrameBlockPointers");
  const frameBlocks: { y: number; x: number; tile: number; attrs: number }[][] = [];
  for (let index = 0; index < spec.frameBlockCount; index++) {
    const address = rom.word(fbPtr.bank, fbPtr.address + index * 2);
    const count = rom.byte(fbPtr.bank, address);
    const tiles = [];
    for (let i = 0; i < count; i++) {
      const at = address + 1 + i * 4;
      tiles.push({
        y: rom.byte(fbPtr.bank, at),
        x: rom.byte(fbPtr.bank, at + 1),
        tile: rom.byte(fbPtr.bank, at + 2),
        attrs: rom.byte(fbPtr.bank, at + 3),
      });
    }
    frameBlocks.push(tiles);
  }

  // --- base coordinates ---------------------------------------------------
  const bcPtr = ctx.symbol("FrameBlockBaseCoords");
  const baseCoords: [number, number][] = [];
  for (let index = 0; index < spec.baseCoordCount; index++) {
    baseCoords.push([
      rom.byte(bcPtr.bank, bcPtr.address + index * 2),
      rom.byte(bcPtr.bank, bcPtr.address + index * 2 + 1),
    ]);
  }

  // --- the tile sheets ----------------------------------------------------
  const tsPtr = ctx.symbol("MoveAnimationTilesPointers");
  const tilesets: { tiles: number; gfx: string }[] = [];
  // The table has no count of its own: it runs until an entry stops looking
  // like one (the tile data follows immediately after it).
  for (let index = 0; index < 8; index++) {
    const at = tsPtr.address + index * 4;
    const count = rom.byte(tsPtr.bank, at);
    const address = rom.word(tsPtr.bank, at + 1);
    if (count === 0 || count > 0xc0 || address < 0x4000 || address > 0x8000 - count * 16) {
      break;
    }
    const rows = Math.ceil(count / TILES_PER_ROW);
    const w = TILES_PER_ROW * TILE_PX;
    const h = rows * TILE_PX;
    const key = `battleanim/${address.toString(16)}`;
    if (!gfx.has(key)) {
      // The sheet is a straight run of 2bpp tiles; pad the last row so the
      // decode has a full rectangle to write into.
      const bytes = new Uint8Array(rows * TILES_PER_ROW * 16);
      bytes.set(rom.bytes(tsPtr.bank, address, count * 16));
      gfx.add(key, decode2bpp(bytes, w, h, true));
    }
    tilesets.push({ tiles: count, gfx: key });
  }
  check(tilesets.length > 0, "no move animation tilesets found");

  // --- cross-checks: every id a script names must exist -------------------
  for (const [name, rows] of Object.entries(anims)) {
    for (const row of rows) {
      if (!("sub" in row)) continue;
      check(row.sub < subanims.length, `${name}: subanimation ${row.sub} is out of range`);
      check(row.tileset < tilesets.length, `${name}: tileset ${row.tileset} is out of range`);
    }
  }
  for (let i = 0; i < subanims.length; i++) {
    for (const b of subanims[i].blocks) {
      check(b.block < frameBlocks.length, `subanimation ${i}: frame block ${b.block} out of range`);
      check(b.base < baseCoords.length, `subanimation ${i}: base coord ${b.base} out of range`);
    }
  }

  return { anims, subanims, frameBlocks, baseCoords, tilesets };
}
