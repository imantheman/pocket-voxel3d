// Port of gen1recomp RomExtractor.lua extractSprites (lines 440-520),
// including build_rom_data.py's Yellow-only surfing-Pikachu sheet.

import { check } from "../ctx.ts";
import type { Ctx } from "../ctx.ts";
import { decode2bpp } from "../gfx.ts";

export function extractSprites(ctx: Ctx): Record<string, unknown> {
  const { rom, manifest, gfx } = ctx;
  const order = manifest.constants.spriteOrder;
  const metadata = manifest.sprites.order;
  const pointerTable = ctx.symbol("SpriteSheetPointerTable");
  check(metadata.length === order.length, "sprite metadata count does not match constants");

  const out: Record<string, unknown> = {};
  for (let index = 0; index < order.length; index++) {
    const constName = order[index];
    const spec = metadata[index];
    check(spec.id === constName, "sprite metadata is out of order");
    const address = pointerTable.address + index * 4;
    const pointer = rom.word(pointerTable.bank, address);
    const firstHalf = rom.byte(pointerTable.bank, address + 2);
    const bank = rom.byte(pointerTable.bank, address + 3);
    const width = spec.imageWidth;
    let height = spec.imageHeight;
    let byteLength = (width * height) / 4;
    let frames = height / 16;
    let expected = firstHalf * (frames >= 6 ? 2 : 1);
    if (byteLength !== expected) {
      // gen1recomp RomExtractor.lua:459 — the ROM firstHalfLength wins over
      // the manifest PNG dims; recompute height from it.
      byteLength = expected;
      check((byteLength * 4) % width === 0, `${constName}: ROM sprite length not tile-aligned`);
      height = (byteLength * 4) / width;
      frames = height / 16;
      expected = firstHalf * (frames >= 6 ? 2 : 1);
      check(byteLength === expected, `${constName}: sprite length mismatch`);
    }
    const base = spec.imageBase;
    const gfxKey = `sprites/${base}`;
    const walker = frames >= 6;
    if (!gfx.has(gfxKey)) {
      gfx.add(
        gfxKey,
        decode2bpp(rom.bytes(bank, pointer, byteLength), width, height, true),
        walker ? { walker } : undefined,
      );
    }
    out[constName] = {
      id: constName,
      source: `ROM:SpriteSheetPointerTable[${index}]`,
      image: `assets/generated/sprites/${base}.png`,
      frames,
      walker,
    };
  }

  // gen1recomp RomExtractor.lua:486 — RedBikeSprite loads outside
  // SpriteSheetPointerTable; same sheet shape, manifest-declared dims.
  const bike = manifest.sprites.bike;
  const bikeSymbol = ctx.symbol(bike.label);
  const bikeFrames = bike.imageHeight / 16;
  gfx.add(
    `sprites/${bike.imageBase}`,
    decode2bpp(
      rom.bytes(bikeSymbol.bank, bikeSymbol.address, (bike.imageWidth * bike.imageHeight) / 4),
      bike.imageWidth,
      bike.imageHeight,
      true,
    ),
    bikeFrames >= 6 ? { walker: true } : undefined,
  );
  out.SPRITE_RED_BIKE = {
    id: "SPRITE_RED_BIKE",
    source: "ROM:RedBikeSprite",
    image: "assets/generated/sprites/red_bike.png",
    frames: bikeFrames,
    walker: bikeFrames >= 6,
  };

  // Yellow: the surfing-Pikachu ride sheet, loaded outside the pointer
  // table (LoadSurfingPlayerSpriteGraphics2) exactly as the bike is.
  const surf = manifest.sprites.surfPikachu;
  if (surf && ctx.hasSymbol(surf.label)) {
    const surfSymbol = ctx.symbol(surf.label);
    const surfFrames = surf.imageHeight / 16;
    gfx.add(
      `sprites/${surf.imageBase}`,
      decode2bpp(
        rom.bytes(surfSymbol.bank, surfSymbol.address, (surf.imageWidth * surf.imageHeight) / 4),
        surf.imageWidth,
        surf.imageHeight,
        true,
      ),
      surfFrames >= 6 ? { walker: true } : undefined,
    );
    out.SPRITE_SURFING_PIKACHU = {
      id: "SPRITE_SURFING_PIKACHU",
      source: `ROM:${surf.label}`,
      image: `assets/generated/sprites/${surf.imageBase}.png`,
      frames: surfFrames,
      walker: surfFrames >= 6,
    };
  }
  return out;
}
