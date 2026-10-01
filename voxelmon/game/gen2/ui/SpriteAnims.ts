// The Gen 2 sprite-animation runtime (pokegold engine/sprite_anims/core.asm)
// plus the slice of its data tables the Gold/Silver intro movie and the
// GameFreak splash use. Port of gen1recomp src/ui/gen2/SpriteAnims.lua at
// bdfac727 (MIT).
//
// Coordinates are hardware OAM coordinates: a struct's x/y are the byte the
// `depixel` macro built, and a drawn object sits at (x - 8, y - 16) on screen.
// Everything is 8-bit and wraps (Lua `%` -> mod()), which several sequences
// rely on -- Lapras walks its x down past 0 to $d0 to decide it has left.

import { mod } from "../platform/lua.ts";

const NUM_STRUCTS = 10; // NUM_SPRITE_ANIM_STRUCTS
// wShadowOAM is 40 objects; UpdateAnimFrame returns carry once it is full.
const OAM_LIMIT = 40;

const OAM_PRIO = 0x80, OAM_YFLIP = 0x40, OAM_XFLIP = 0x20;
const OAM_FLAG_MASK = 0xe0; // OAM_PRIO | OAM_YFLIP | OAM_XFLIP

// ------------------------------------------------------------------ Sine

// Lua: SpriteAnims.lua:44 -- engine/math/sine.asm `sine_table 32`: sin(x * pi/32)
// in Q8.8, so entry 16 is exactly $100.
const SINE: number[] = [];
for (let index = 0; index <= 31; index++) {
  SINE[index] = Math.floor(Math.sin(index * Math.PI / 32) * 256 + 0.5);
}

// Lua: SpriteAnims.lua:53 -- a = d * sin(a * pi/32), returned as the byte the
// ASM leaves in a (two's complement when negative).
function sine(angle: number, amplitude: number): number {
  angle = mod(angle, 64);
  const negative = angle >= 32;
  if (negative) angle = angle - 32;
  // The multiply accumulates into hl and only the high byte survives.
  const product = mod(mod(amplitude, 256) * SINE[angle], 0x10000);
  let result = Math.floor(product / 256);
  if (negative) result = -result;
  return mod(result, 256);
}

// Lua: SpriteAnims.lua:65 -- Sprites_Cosine: cos(x) = sin(x + pi/2).
function cosine(angle: number, amplitude: number): number {
  return sine(angle + 0x10, amplitude);
}

// ------------------------------------------------- data/sprite_anims/oam.asm

export interface OamEntry { y: number; x: number; tile: number; attr: number }

// Lua: SpriteAnims.lua:76 -- `dbsprite x tile, y tile, x pixel, y pixel, vtile, attr`
// emits the y byte first; both tile counts are taken mod $100.
function s(xTile: number, yTile: number, xPixel: number, yPixel: number, tile: number, attr: number): OamEntry {
  return {
    y: mod(yTile * 8 + yPixel, 256),
    x: mod(xTile * 8 + xPixel, 256),
    tile,
    attr,
  };
}

// Lua: SpriteAnims.lua:85
const OAMDATA: Record<string, OamEntry[]> = {
  OAMData_1x1_Palette0: [
    s( -1,  -1, 4, 4, 0x00, 0x00),
  ],
  OAMData_GSIntroShellder: [
    s( -1,  -1, 0, 0, 0x00, 0x00),
    s(  0,  -1, 0, 0, 0x01, 0x00),
    s( -1,   0, 0, 0, 0x10, 0x00),
    s(  0,   0, 0, 0, 0x11, 0x00),
  ],
  OAMData_GSIntroMagikarp: [
    s( -2,  -1, 4, 0, 0x00, 0x01),
    s( -1,  -1, 4, 0, 0x01, 0x01),
    s(  0,  -1, 4, 0, 0x02, 0x01),
    s( -2,   0, 4, 0, 0x10, 0x01),
    s( -1,   0, 4, 0, 0x11, 0x01),
    s(  0,   0, 4, 0, 0x12, 0x01),
  ],
  OAMData_GSIntroLapras1: [
    s( -3,  -3, 0, 0, 0x00, 0x00),
    s( -2,  -3, 0, 0, 0x01, 0x00),
    s( -1,  -3, 0, 0, 0x02, 0x00),
    s( -3,  -2, 0, 0, 0x10, 0x00),
    s( -2,  -2, 0, 0, 0x11, 0x00),
    s( -1,  -2, 0, 0, 0x12, 0x00),
    s( -3,  -1, 0, 0, 0x20, 0x00),
    s( -2,  -1, 0, 0, 0x21, 0x00),
    s( -1,  -1, 0, 0, 0x22, 0x00),
    s(  0,  -1, 0, 0, 0x23, 0x00),
    s( -3,   0, 0, 0, 0x30, 0x80),
    s( -2,   0, 0, 0, 0x31, 0x80),
    s( -1,   0, 0, 0, 0x32, 0x80),
    s(  0,   0, 0, 0, 0x33, 0x80),
    s(  1,   0, 0, 0, 0x34, 0x80),
    s( -3,   1, 0, 0, 0x40, 0x80),
    s( -2,   1, 0, 0, 0x41, 0x80),
    s( -1,   1, 0, 0, 0x42, 0x80),
    s(  0,   1, 0, 0, 0x43, 0x80),
    s(  1,   1, 0, 0, 0x44, 0x80),
    s(  2,   1, 0, 0, 0x45, 0x80),
    s( -3,   2, 0, 0, 0x50, 0x80),
    s( -2,   2, 0, 0, 0x51, 0x80),
    s( -1,   2, 0, 0, 0x52, 0x80),
    s(  0,   2, 0, 0, 0x53, 0x80),
    s(  1,   2, 0, 0, 0x54, 0x80),
    s(  2,   2, 0, 0, 0x55, 0x80),
  ],
  OAMData_GSIntroLapras2: [
    s( -3,  -3, 0, 0, 0x0d, 0x00),
    s( -2,  -3, 0, 0, 0x0e, 0x00),
    s( -1,  -3, 0, 0, 0x0f, 0x00),
    s( -3,  -2, 0, 0, 0x1d, 0x00),
    s( -2,  -2, 0, 0, 0x1e, 0x00),
    s( -1,  -2, 0, 0, 0x1f, 0x00),
    s( -3,  -1, 0, 0, 0x20, 0x00),
    s( -2,  -1, 0, 0, 0x21, 0x00),
    s( -1,  -1, 0, 0, 0x22, 0x00),
    s(  0,  -1, 0, 0, 0x23, 0x00),
    s( -3,   0, 0, 0, 0x30, 0x80),
    s( -2,   0, 0, 0, 0x31, 0x80),
    s( -1,   0, 0, 0, 0x32, 0x80),
    s(  0,   0, 0, 0, 0x33, 0x80),
    s(  1,   0, 0, 0, 0x34, 0x80),
    s( -3,   1, 0, 0, 0x40, 0x80),
    s( -2,   1, 0, 0, 0x41, 0x80),
    s( -1,   1, 0, 0, 0x42, 0x80),
    s(  0,   1, 0, 0, 0x43, 0x80),
    s(  1,   1, 0, 0, 0x44, 0x80),
    s(  2,   1, 0, 0, 0x45, 0x80),
    s( -3,   2, 0, 0, 0x50, 0x80),
    s( -2,   2, 0, 0, 0x51, 0x80),
    s( -1,   2, 0, 0, 0x52, 0x80),
    s(  0,   2, 0, 0, 0x53, 0x80),
    s(  1,   2, 0, 0, 0x54, 0x80),
    s(  2,   2, 0, 0, 0x55, 0x80),
  ],
  OAMData_GSIntroLapras3: [
    s( -3,  -3, 0, 0, 0x00, 0x00),
    s( -2,  -3, 0, 0, 0x01, 0x00),
    s( -1,  -3, 0, 0, 0x02, 0x00),
    s(  0,  -3, 0, 0, 0x03, 0x00),
    s( -3,  -2, 0, 0, 0x10, 0x00),
    s( -2,  -2, 0, 0, 0x11, 0x00),
    s( -1,  -2, 0, 0, 0x12, 0x00),
    s(  0,  -2, 0, 0, 0x13, 0x00),
    s( -3,  -1, 0, 0, 0x20, 0x00),
    s( -2,  -1, 0, 0, 0x21, 0x00),
    s( -1,  -1, 0, 0, 0x22, 0x00),
    s(  0,  -1, 0, 0, 0x23, 0x00),
    s(  1,  -1, 0, 0, 0x24, 0x00),
    s( -3,   0, 0, 0, 0x30, 0x80),
    s( -2,   0, 0, 0, 0x31, 0x80),
    s( -1,   0, 0, 0, 0x32, 0x80),
    s(  0,   0, 0, 0, 0x33, 0x80),
    s(  1,   0, 0, 0, 0x34, 0x80),
    s( -3,   1, 0, 0, 0x40, 0x80),
    s( -2,   1, 0, 0, 0x41, 0x80),
    s( -1,   1, 0, 0, 0x42, 0x80),
    s(  0,   1, 0, 0, 0x43, 0x80),
    s(  1,   1, 0, 0, 0x44, 0x80),
    s(  2,   1, 0, 0, 0x45, 0x80),
    s( -2,   2, 0, 0, 0x51, 0x80),
    s( -1,   2, 0, 0, 0x52, 0x80),
    s(  0,   2, 0, 0, 0x53, 0x80),
    s(  1,   2, 0, 0, 0x54, 0x80),
    s(  2,   2, 0, 0, 0x55, 0x80),
  ],
  OAMData_GSIntroNote: [
    s( -1,  -1, 4, 0, 0x00, 0x00),
    s( -1,   0, 4, 0, 0x10, 0x00),
  ],
  OAMData_GSIntroJigglypuffPikachu: [
    s( -2,  -2, 0, 0, 0x00, 0x00),
    s( -1,  -2, 0, 0, 0x01, 0x00),
    s(  0,  -2, 0, 0, 0x02, 0x00),
    s(  1,  -2, 0, 0, 0x03, 0x00),
    s( -2,  -1, 0, 0, 0x10, 0x00),
    s( -1,  -1, 0, 0, 0x11, 0x00),
    s(  0,  -1, 0, 0, 0x12, 0x00),
    s(  1,  -1, 0, 0, 0x13, 0x00),
    s( -2,   0, 0, 0, 0x20, 0x00),
    s( -1,   0, 0, 0, 0x21, 0x00),
    s(  0,   0, 0, 0, 0x22, 0x00),
    s(  1,   0, 0, 0, 0x23, 0x00),
    s( -2,   1, 0, 0, 0x30, 0x00),
    s( -1,   1, 0, 0, 0x31, 0x00),
    s(  0,   1, 0, 0, 0x32, 0x00),
    s(  1,   1, 0, 0, 0x33, 0x00),
  ],
  OAMData_GSIntroPikachuTail: [
    s(  3,  -2, 0, 0, 0x00, 0x00),
    s(  4,  -2, 0, 0, 0x01, 0x00),
    s(  2,  -1, 0, 0, 0x02, 0x00),
    s(  3,  -1, 0, 0, 0x03, 0x00),
    s(  2,   0, 0, 0, 0x04, 0x00),
  ],
  OAMData_GSIntroSmallFireball: [
    s( -1,  -1, 0, 0, 0x00, 0x00),
    s(  0,  -1, 0, 0, 0x00, 0x20),
    s( -1,   0, 0, 0, 0x00, 0x40),
    s(  0,   0, 0, 0, 0x00, 0x60),
  ],
  OAMData_TradePoofBubble: [
    s( -2,  -2, 0, 0, 0x00, 0x00),
    s( -1,  -2, 0, 0, 0x01, 0x00),
    s( -2,  -1, 0, 0, 0x02, 0x00),
    s( -1,  -1, 0, 0, 0x03, 0x00),
    s(  0,  -2, 0, 0, 0x01, 0x20),
    s(  1,  -2, 0, 0, 0x00, 0x20),
    s(  0,  -1, 0, 0, 0x03, 0x20),
    s(  1,  -1, 0, 0, 0x02, 0x20),
    s( -2,   0, 0, 0, 0x02, 0x40),
    s( -1,   0, 0, 0, 0x03, 0x40),
    s( -2,   1, 0, 0, 0x00, 0x40),
    s( -1,   1, 0, 0, 0x01, 0x40),
    s(  0,   0, 0, 0, 0x03, 0x60),
    s(  1,   0, 0, 0, 0x02, 0x60),
    s(  0,   1, 0, 0, 0x01, 0x60),
    s(  1,   1, 0, 0, 0x00, 0x60),
  ],
  OAMData_GSIntroBigFireball: [
    s( -3,  -3, 0, 0, 0x00, 0x00),
    s( -2,  -3, 0, 0, 0x01, 0x00),
    s( -1,  -3, 0, 0, 0x02, 0x00),
    s( -3,  -2, 0, 0, 0x03, 0x00),
    s( -2,  -2, 0, 0, 0x04, 0x00),
    s( -1,  -2, 0, 0, 0x05, 0x00),
    s( -3,  -1, 0, 0, 0x06, 0x00),
    s( -2,  -1, 0, 0, 0x05, 0x00),
    s( -1,  -1, 0, 0, 0x05, 0x00),
    s(  0,  -3, 0, 0, 0x02, 0x20),
    s(  1,  -3, 0, 0, 0x01, 0x20),
    s(  2,  -3, 0, 0, 0x00, 0x20),
    s(  0,  -2, 0, 0, 0x05, 0x20),
    s(  1,  -2, 0, 0, 0x04, 0x20),
    s(  2,  -2, 0, 0, 0x03, 0x20),
    s(  0,  -1, 0, 0, 0x05, 0x20),
    s(  1,  -1, 0, 0, 0x05, 0x20),
    s(  2,  -1, 0, 0, 0x06, 0x20),
    s( -3,   0, 0, 0, 0x06, 0x40),
    s( -2,   0, 0, 0, 0x05, 0x40),
    s( -1,   0, 0, 0, 0x05, 0x40),
    s( -3,   1, 0, 0, 0x03, 0x40),
    s( -2,   1, 0, 0, 0x04, 0x40),
    s( -1,   1, 0, 0, 0x05, 0x40),
    s( -3,   2, 0, 0, 0x00, 0x40),
    s( -2,   2, 0, 0, 0x01, 0x40),
    s( -1,   2, 0, 0, 0x02, 0x40),
    s(  0,   0, 0, 0, 0x05, 0x60),
    s(  1,   0, 0, 0, 0x05, 0x60),
    s(  2,   0, 0, 0, 0x06, 0x60),
    s(  0,   1, 0, 0, 0x05, 0x60),
    s(  1,   1, 0, 0, 0x04, 0x60),
    s(  2,   1, 0, 0, 0x03, 0x60),
    s(  0,   2, 0, 0, 0x02, 0x60),
    s(  1,   2, 0, 0, 0x01, 0x60),
    s(  2,   2, 0, 0, 0x00, 0x60),
  ],
  OAMData_GSIntroStarter: [
    s( -3,  -3, 4, 4, 0x00, 0x00),
    s( -3,  -2, 4, 4, 0x01, 0x00),
    s( -3,  -1, 4, 4, 0x02, 0x00),
    s( -3,   0, 4, 4, 0x03, 0x00),
    s( -3,   1, 4, 4, 0x04, 0x00),
    s( -2,  -3, 4, 4, 0x05, 0x00),
    s( -2,  -2, 4, 4, 0x06, 0x00),
    s( -2,  -1, 4, 4, 0x07, 0x00),
    s( -2,   0, 4, 4, 0x08, 0x00),
    s( -2,   1, 4, 4, 0x09, 0x00),
    s( -1,  -3, 4, 4, 0x0a, 0x00),
    s( -1,  -2, 4, 4, 0x0b, 0x00),
    s( -1,  -1, 4, 4, 0x0c, 0x00),
    s( -1,   0, 4, 4, 0x0d, 0x00),
    s( -1,   1, 4, 4, 0x0e, 0x00),
    s(  0,  -3, 4, 4, 0x0f, 0x00),
    s(  0,  -2, 4, 4, 0x10, 0x00),
    s(  0,  -1, 4, 4, 0x11, 0x00),
    s(  0,   0, 4, 4, 0x12, 0x00),
    s(  0,   1, 4, 4, 0x13, 0x00),
    s(  1,  -3, 4, 4, 0x14, 0x00),
    s(  1,  -2, 4, 4, 0x15, 0x00),
    s(  1,  -1, 4, 4, 0x16, 0x00),
    s(  1,   0, 4, 4, 0x17, 0x00),
    s(  1,   1, 4, 4, 0x18, 0x00),
  ],
  // The GameFreak splash (engine/movie/splash.asm).  The logo is a 3x5 block
  // of tiles laid row-major and it is the only OAM set in this file that asks
  // for OBJ palette 1 (`1 | OAM_PAL1`) -- which is the whole point, because
  // GameFreakPresents_UpdateLogoPal rotates OBP1 out from under it while
  // the star and sparkles stay on palette 0.
  OAMData_GSGameFreakLogo: [
    s( -2,  -3, 4, 4, 0x00, 0x11),
    s( -1,  -3, 4, 4, 0x01, 0x11),
    s(  0,  -3, 4, 4, 0x02, 0x11),
    s( -2,  -2, 4, 4, 0x03, 0x11),
    s( -1,  -2, 4, 4, 0x04, 0x11),
    s(  0,  -2, 4, 4, 0x05, 0x11),
    s( -2,  -1, 4, 4, 0x06, 0x11),
    s( -1,  -1, 4, 4, 0x07, 0x11),
    s(  0,  -1, 4, 4, 0x08, 0x11),
    s( -2,   0, 4, 4, 0x09, 0x11),
    s( -1,   0, 4, 4, 0x0a, 0x11),
    s(  0,   0, 4, 4, 0x0b, 0x11),
    s( -2,   1, 4, 4, 0x0c, 0x11),
    s( -1,   1, 4, 4, 0x0d, 0x11),
    s(  0,   1, 4, 4, 0x0e, 0x11),
  ],
  // Two tiles mirrored into a 16x16 star: only the left half is in the ROM.
  OAMData_GSGameFreakLogoStar: [
    s( -1,  -1, 0, 0, 0x00, 0x00),
    s(  0,  -1, 0, 0, 0x00, OAM_XFLIP),
    s( -1,   0, 0, 0, 0x01, 0x00),
    s(  0,   0, 0, 0, 0x01, OAM_XFLIP),
  ],
};

// Lua: SpriteAnims.lua:344 -- SpriteAnimOAMData rows: `spriteanimoam <vtile offset>, <data>`
// as [vtile, entries] (Lua set[1], set[2]).
export type OamSet = [number, OamEntry[]];
const OAMSETS: Record<string, OamSet> = {
  GS_INTRO_BUBBLE_1: [0x4c, OAMDATA.OAMData_1x1_Palette0],
  GS_INTRO_BUBBLE_2: [0x5c, OAMDATA.OAMData_1x1_Palette0],
  GS_INTRO_SHELLDER_1: [0x6c, OAMDATA.OAMData_GSIntroShellder],
  GS_INTRO_SHELLDER_2: [0x6e, OAMDATA.OAMData_GSIntroShellder],
  GS_INTRO_MAGIKARP_1: [0x2d, OAMDATA.OAMData_GSIntroMagikarp],
  GS_INTRO_MAGIKARP_2: [0x4d, OAMDATA.OAMData_GSIntroMagikarp],
  GS_INTRO_LAPRAS_1: [0x00, OAMDATA.OAMData_GSIntroLapras1],
  GS_INTRO_LAPRAS_2: [0x00, OAMDATA.OAMData_GSIntroLapras2],
  GS_INTRO_LAPRAS_3: [0x06, OAMDATA.OAMData_GSIntroLapras3],
  GS_INTRO_NOTE: [0x0c, OAMDATA.OAMData_GSIntroNote],
  GS_INTRO_INVISIBLE_NOTE: [0x0d, OAMDATA.OAMData_1x1_Palette0],
  GS_INTRO_JIGGLYPUFF_1: [0x00, OAMDATA.OAMData_GSIntroJigglypuffPikachu],
  GS_INTRO_JIGGLYPUFF_2: [0x04, OAMDATA.OAMData_GSIntroJigglypuffPikachu],
  GS_INTRO_JIGGLYPUFF_3: [0x08, OAMDATA.OAMData_GSIntroJigglypuffPikachu],
  GS_INTRO_PIKACHU_1: [0x40, OAMDATA.OAMData_GSIntroJigglypuffPikachu],
  GS_INTRO_PIKACHU_2: [0x44, OAMDATA.OAMData_GSIntroJigglypuffPikachu],
  GS_INTRO_PIKACHU_3: [0x48, OAMDATA.OAMData_GSIntroJigglypuffPikachu],
  GS_INTRO_PIKACHU_4: [0x4c, OAMDATA.OAMData_GSIntroJigglypuffPikachu],
  GS_INTRO_PIKACHU_TAIL_1: [0x80, OAMDATA.OAMData_GSIntroPikachuTail],
  GS_INTRO_PIKACHU_TAIL_2: [0x85, OAMDATA.OAMData_GSIntroPikachuTail],
  GS_INTRO_PIKACHU_TAIL_3: [0x8a, OAMDATA.OAMData_GSIntroPikachuTail],
  GS_INTRO_SMALL_FIREBALL: [0x00, OAMDATA.OAMData_GSIntroSmallFireball],
  GS_INTRO_MED_FIREBALL: [0x01, OAMDATA.OAMData_TradePoofBubble],
  GS_INTRO_BIG_FIREBALL: [0x09, OAMDATA.OAMData_GSIntroBigFireball],
  GS_INTRO_CHIKORITA: [0x10, OAMDATA.OAMData_GSIntroStarter],
  GS_INTRO_CYNDAQUIL: [0x29, OAMDATA.OAMData_GSIntroStarter],
  GS_INTRO_TOTODILE: [0x42, OAMDATA.OAMData_GSIntroStarter],
  // Splash offsets are relative to the dict base the splash sets ($8d, see
  // System.vtileBase), so the logo lands on $8d, the star on $9c and the
  // three sparkle frames on $9e-$a0.
  GS_GAMEFREAK_LOGO: [0x00, OAMDATA.OAMData_GSGameFreakLogo],
  GS_GAMEFREAK_LOGO_STAR: [0x0f, OAMDATA.OAMData_GSGameFreakLogoStar],
  GS_GAMEFREAK_LOGO_SPARKLE_1: [0x11, OAMDATA.OAMData_1x1_Palette0],
  GS_GAMEFREAK_LOGO_SPARKLE_2: [0x12, OAMDATA.OAMData_1x1_Palette0],
  GS_GAMEFREAK_LOGO_SPARKLE_3: [0x13, OAMDATA.OAMData_1x1_Palette0],
};

// ------------------------------------------- data/sprite_anims/framesets.asm

export interface FrameEntry { oamset: string; duration: number; flags: number }
export type Frame = FrameEntry | "restart" | "end";

// Lua: SpriteAnims.lua:389 -- `oamframe <oam set>, <duration>[, <flip>]`; the flip
// is stored as the OAM flag it becomes.
function f(oamset: string, duration: number, flags?: number): FrameEntry {
  return { oamset, duration, flags: flags ?? 0 };
}

// Lua: SpriteAnims.lua:396 -- "restart" is `oamrestart`, "end" is `oamend`;
// `oamdelete` is a frame UpdateAnimFrame acts on.
const DELETE = f("delete", 0);

// Lua: SpriteAnims.lua:398
const FRAMESETS: Record<string, Frame[]> = {
  GSIntroBubble: [
    f("GS_INTRO_BUBBLE_1", 8), f("GS_INTRO_BUBBLE_2", 8), "restart",
  ],
  GSIntroShellder: [
    f("GS_INTRO_SHELLDER_1", 8), f("GS_INTRO_SHELLDER_2", 8), "restart",
  ],
  GSIntroMagikarp: [
    f("GS_INTRO_MAGIKARP_1", 1, OAM_XFLIP),
    f("GS_INTRO_MAGIKARP_2", 1, OAM_XFLIP),
    "restart",
  ],
  GSIntroLapras: [
    f("GS_INTRO_LAPRAS_1", 7), f("GS_INTRO_LAPRAS_2", 7),
    f("GS_INTRO_LAPRAS_3", 7), f("GS_INTRO_LAPRAS_1", 7),
    "restart",
  ],
  GSIntroNote: [f("GS_INTRO_NOTE", 8), "end"],
  GSIntroInvisibleNote: [f("GS_INTRO_INVISIBLE_NOTE", 8), "end"],
  GSIntroJigglypuff: [
    f("GS_INTRO_JIGGLYPUFF_1", 25, OAM_XFLIP),
    f("GS_INTRO_JIGGLYPUFF_3", 9),
    f("GS_INTRO_JIGGLYPUFF_1", 25),
    f("GS_INTRO_JIGGLYPUFF_3", 9),
    "restart",
  ],
  GSIntroJigglypuff2: [f("GS_INTRO_JIGGLYPUFF_2", 32), "end"],
  GSIntroPikachu: [
    f("GS_INTRO_PIKACHU_1", 4), f("GS_INTRO_PIKACHU_2", 5),
    f("GS_INTRO_PIKACHU_4", 4), "restart",
  ],
  GSIntroPikachu2: [f("GS_INTRO_PIKACHU_2", 8), "end"],
  GSIntroPikachu3: [f("GS_INTRO_PIKACHU_3", 32), "end"],
  GSIntroPikachuTail: [
    f("GS_INTRO_PIKACHU_TAIL_1", 3), f("GS_INTRO_PIKACHU_TAIL_2", 3),
    f("GS_INTRO_PIKACHU_TAIL_3", 3), f("GS_INTRO_PIKACHU_TAIL_2", 3),
    "restart",
  ],
  GSIntroPikachuTail2: [f("GS_INTRO_PIKACHU_TAIL_1", 31), "end"],
  GSIntroFireball: [
    f("GS_INTRO_SMALL_FIREBALL", 1), f("GS_INTRO_MED_FIREBALL", 1),
    f("GS_INTRO_BIG_FIREBALL", 1), DELETE,
  ],
  GSIntroChikorita: [f("GS_INTRO_CHIKORITA", 24), DELETE],
  GSIntroCyndaquil: [f("GS_INTRO_CYNDAQUIL", 24, OAM_XFLIP), DELETE],
  GSIntroTotodile: [f("GS_INTRO_TOTODILE", 24), DELETE],
  // The logo holds one frame forever; the star flips vertically every three
  // frames, which is what makes it twinkle as it spirals.
  GameFreakLogo: [f("GS_GAMEFREAK_LOGO", 8), "end"],
  GSGameFreakLogoStar: [
    f("GS_GAMEFREAK_LOGO_STAR", 3),
    f("GS_GAMEFREAK_LOGO_STAR", 3, OAM_YFLIP),
    "restart",
  ],
  GSGameFreakLogoSparkle: [
    f("GS_GAMEFREAK_LOGO_SPARKLE_1", 2), f("GS_GAMEFREAK_LOGO_SPARKLE_2", 2),
    f("GS_GAMEFREAK_LOGO_SPARKLE_3", 2), f("GS_GAMEFREAK_LOGO_SPARKLE_2", 2),
    "restart",
  ],
};

// --------------------------------------------- data/sprite_anims/objects.asm

// Lua: SpriteAnims.lua:463 -- [frameset, sequence].
const OBJECTS: Record<string, [string, string]> = {
  GS_INTRO_BUBBLE: ["GSIntroBubble", "GSIntroBubble"],
  GS_INTRO_SHELLDER: ["GSIntroShellder", "GSIntroShellder"],
  GS_INTRO_MAGIKARP: ["GSIntroMagikarp", "GSIntroMagikarp"],
  GS_INTRO_LAPRAS: ["GSIntroLapras", "GSIntroLapras"],
  GS_INTRO_NOTE: ["GSIntroNote", "GSIntroNote"],
  GS_INTRO_INVISIBLE_NOTE: ["GSIntroInvisibleNote", "GSIntroNote"],
  GS_INTRO_JIGGLYPUFF: ["GSIntroJigglypuff", "GSIntroJigglypuff"],
  GS_INTRO_PIKACHU: ["GSIntroPikachu", "GSIntroPikachu"],
  GS_INTRO_PIKACHU_TAIL: ["GSIntroPikachuTail", "GSIntroPikachuTail"],
  GS_INTRO_FIREBALL: ["GSIntroFireball", "GSIntroFireball"],
  GS_INTRO_CHIKORITA: ["GSIntroChikorita", "GSIntroChikoritaTotodile"],
  GS_INTRO_CYNDAQUIL: ["GSIntroCyndaquil", "GSIntroCyndaquil"],
  GS_INTRO_TOTODILE: ["GSIntroTotodile", "GSIntroChikoritaTotodile"],
  GAMEFREAK_LOGO: ["GameFreakLogo", "GameFreakLogo"],
  GS_GAMEFREAK_LOGO_STAR: ["GSGameFreakLogoStar", "GSGameFreakLogoStar"],
  GS_GAMEFREAK_LOGO_SPARKLE:
    ["GSGameFreakLogoSparkle", "GSGameFreakLogoSparkle"],
};

// ------------------------------------------- engine/sprite_anims/core.asm

export interface AnimStruct {
  index: number; framesetId: string | null; seqId: string | null;
  x: number; y: number; xOffset: number; yOffset: number;
  duration: number; durationOffset: number; frame: number;
  jt: number; var1: number; var2: number; var3: number; var4: number;
  oamFlags: number;
}

// Lua: SpriteAnims.lua:490
function newStruct(): AnimStruct {
  return {
    index: 0, framesetId: null, seqId: null,
    x: 0, y: 0, xOffset: 0, yOffset: 0,
    duration: 0, durationOffset: 0, frame: -1,
    jt: 0, var1: 0, var2: 0, var3: 0, var4: 0,
    oamFlags: 0,
  };
}

// Lua: SpriteAnims.lua:553
function deinit(st: AnimStruct): void {
  st.index = 0;
}

// Lua: SpriteAnims.lua:558 -- _ReinitSpriteAnimFrame.
function reinit(st: AnimStruct, framesetId: string): void {
  st.framesetId = framesetId;
  st.duration = 0;
  st.frame = -1;
}

// Lua: SpriteAnims.lua:567 -- GetSpriteAnimFrame. "wait"/"delete" come back as
// themselves; UpdateAnimFrame acts on them. (st.frame stays the Lua 0-based
// counter; Lua frames[st.frame + 1] is frames[st.frame] here.)
function getFrame(st: AnimStruct): string {
  const frames = FRAMESETS[st.framesetId as string];
  for (let n = 1; n <= 64; n++) {
    if (st.duration !== 0) {
      st.duration = st.duration - 1;
      const entry = frames[st.frame] as FrameEntry;
      st.oamFlags = entry.flags;
      return entry.oamset;
    }
    st.frame = st.frame + 1;
    const entry = frames[st.frame];
    if (entry === "restart") {
      st.duration = 0;
      st.frame = -1;
    } else if (entry === "end") {
      // Step back two so the next pass lands on the frame before this one.
      st.duration = 0;
      st.frame = st.frame - 2;
    } else {
      st.duration = mod(entry.duration + st.durationOffset, 256);
      st.oamFlags = entry.flags;
      return entry.oamset;
    }
  }
  throw new Error("sprite anim frameset never yields a frame: " + String(st.framesetId));
}

// Lua: SpriteAnims.lua:596 -- AddOrSubtractY/X: a flipped object mirrors around
// its own 8-pixel cell, which is `-8 - offset`.
function mirror(value: number, flip: boolean): number {
  if (!flip) return value;
  return mod(-(value + 8), 256);
}

// Lua: SpriteAnims.lua:603 -- GetSpriteOAMAttr: the frame's flips toggle the entry's.
function attrOf(attr: number, flags: number): number {
  const toggled = (attr ^ flags) & OAM_FLAG_MASK;
  return (attr & (0xff - OAM_FLAG_MASK)) + toggled;
}

export type Sequence = (sys: SpriteAnimSystem, st: AnimStruct) => void;

// Lua: SpriteAnims.lua:487 -- the System metatable.
export class SpriteAnimSystem {
  structs: AnimStruct[] = [];
  animCount = 0;
  globalX = 0; // wGlobalAnimXOffset
  globalY = 0; // wGlobalAnimYOffset
  // wIntroSpriteStateFlag (and the splash's wIntroSceneFrameCounter cue).
  flag = 0;
  // GetSpriteAnimVTile's answer for whatever wSpriteAnimDict holds.
  vtileBase = 0;
  oam: OamEntry[] = [];

  // Lua: SpriteAnims.lua:502
  constructor() {
    for (let slot = 0; slot < NUM_STRUCTS; slot++) this.structs[slot] = newStruct();
  }

  // Lua: SpriteAnims.lua:521 -- ClearSpriteAnims zeroes the block, counter included.
  clear(): void {
    for (let slot = 0; slot < NUM_STRUCTS; slot++) this.structs[slot] = newStruct();
    this.animCount = 0;
    this.oam = [];
  }

  // Lua: SpriteAnims.lua:528 -- _InitSpriteAnimStruct: first free slot wins, nil if all busy.
  init(objectId: string, x: number, y: number): AnimStruct | null {
    const object = OBJECTS[objectId];
    if (!object) throw new Error("unknown sprite anim object: " + String(objectId));
    for (let slot = 0; slot < NUM_STRUCTS; slot++) {
      const st = this.structs[slot];
      if (st.index === 0) {
        // wSpriteAnimCount increments and skips 0.
        this.animCount = mod(this.animCount + 1, 256);
        if (this.animCount === 0) this.animCount = 1;
        st.index = this.animCount;
        st.framesetId = object[0];
        st.seqId = object[1];
        st.x = mod(x, 256); st.y = mod(y, 256);
        st.xOffset = 0; st.yOffset = 0;
        st.duration = 0; st.durationOffset = 0;
        st.frame = -1;
        st.jt = 0; st.var1 = 0; st.var2 = 0; st.var3 = 0; st.var4 = 0;
        st.oamFlags = 0;
        return st;
      }
    }
    return null;
  }

  // Lua: SpriteAnims.lua:610 -- UpdateAnimFrame. True once wShadowOAM is full.
  updateAnimFrame(st: AnimStruct): boolean {
    // InitSpriteAnimBuffer
    st.oamFlags = 0;
    const oamset = getFrame(st);
    if (oamset === "wait") return false;
    if (oamset === "delete") {
      deinit(st);
      return false;
    }
    const set = OAMSETS[oamset];
    if (!set) throw new Error("unknown OAM set: " + String(oamset));
    const vtile = mod(set[0], 256);
    const yFlip = (st.oamFlags & OAM_YFLIP) !== 0;
    const xFlip = (st.oamFlags & OAM_XFLIP) !== 0;
    for (const entry of set[1]) {
      if (this.oam.length >= OAM_LIMIT) return true;
      this.oam.push({
        y: mod(st.y + st.yOffset + this.globalY + mirror(entry.y, yFlip), 256),
        x: mod(st.x + st.xOffset + this.globalX + mirror(entry.x, xFlip), 256),
        tile: mod(this.vtileBase + vtile + entry.tile, 256),
        attr: attrOf(entry.attr, st.oamFlags),
      });
    }
    return false;
  }

  // Lua: SpriteAnims.lua:904 -- PlaySpriteAnimations / DoNextFrameForAllSprites.
  // A struct that deinitializes itself still draws this frame.
  playFrame(): OamEntry[] {
    this.oam = [];
    for (let slot = 0; slot < NUM_STRUCTS; slot++) {
      const st = this.structs[slot];
      if (st.index !== 0) {
        const sequence = SEQUENCES[st.seqId as string];
        if (!sequence) throw new Error("unknown sprite anim sequence: " + String(st.seqId));
        sequence(this, st);
        if (this.updateAnimFrame(st)) break;
      }
    }
    return this.oam;
  }

  // Lua: SpriteAnims.lua:920
  activeCount(): number {
    let count = 0;
    for (let slot = 0; slot < NUM_STRUCTS; slot++) {
      if (this.structs[slot].index !== 0) count = count + 1;
    }
    return count;
  }
}

// ------------------------------------- engine/sprite_anims/functions.asm

const SEQUENCES: Record<string, Sequence> = {};

// Lua: SpriteAnims.lua:642
SEQUENCES.GSIntroBubble = (_sys, st) => {
  const age = st.var2;
  st.var2 = mod(st.var2 + 1, 256);
  if (age >= 0x40) {
    deinit(st);
    return;
  }
  st.yOffset = mod(st.yOffset - 1, 256);
  st.var1 = mod(st.var1 + 2, 256);
  st.xOffset = sine(st.var1, 8);
};

// Lua: SpriteAnims.lua:656 -- deleted once the rising camera carries it past the bottom.
SEQUENCES.GSIntroShellder = (sys, st) => {
  if (mod(sys.globalY + st.y, 256) >= 0xb0) deinit(st);
};

// Lua: SpriteAnims.lua:660
SEQUENCES.GSIntroMagikarp = (_sys, st) => {
  if (st.jt === 0) {
    st.jt = st.jt + 1;
    // swap of a 0-3 value: the struct index spreads the school's phases out.
    st.var1 = mod(st.index, 4) * 16;
  }
  // lb de, 2, 1 on a CGB; the SGB branch doubles both.
  const dx = 2, dphase = 1;
  if (st.xOffset >= 0xf0) {
    deinit(st);
    return;
  }
  st.xOffset = mod(st.xOffset + dx, 256);
  st.var1 = mod(st.var1 + dphase, 256);
  st.yOffset = sine(st.var1, 8);
};

// Lua: SpriteAnims.lua:679 -- Lapras bobs every frame and only moves on odd ones.
function laprasBob(st: AnimStruct): boolean {
  const phase = st.var1;
  st.var1 = mod(st.var1 + 1, 256);
  st.yOffset = sine(phase, 4);
  return mod(st.var1, 2) === 0;
}

// Lua: SpriteAnims.lua:686
SEQUENCES.GSIntroLapras = (sys, st) => {
  if (st.jt === 0) {
    if (laprasBob(st)) return;
    if (st.x < 0x58) {
      st.jt = st.jt + 1;
      st.var2 = 0xb0;
      return;
    }
    st.x = mod(st.x - 1, 256);
  } else if (st.jt === 1) {
    laprasBob(st);
    if (st.var2 === 0) {
      st.jt = st.jt + 1;
      return;
    }
    st.var2 = st.var2 - 1;
  } else {
    if (laprasBob(st)) return;
    if (st.x === 0xd0) {
      deinit(st);
      sys.flag = 1;
      return;
    }
    st.x = mod(st.x - 1, 256);
  }
};

// Lua: SpriteAnims.lua:713
SEQUENCES.GSIntroNote = (_sys, st) => {
  if (st.jt === 0) {
    st.jt = st.jt + 1;
    // (index & 1) swapped then doubled: alternate notes start half a period on.
    st.var1 = mod(st.index, 2) * 0x20;
  }
  if (st.xOffset >= 0x80) {
    deinit(st);
    return;
  }
  st.xOffset = mod(st.xOffset + 1, 256);
  st.var1 = mod(st.var1 + 2, 256);
  const wobble = sine(st.var1, 4);
  st.yOffset = wobble;
  // The `and $2` tests the sine result, not var1.
  if (mod(wobble, 4) >= 2) st.y = mod(st.y - 1, 256);
};

// Lua: SpriteAnims.lua:732
SEQUENCES.GSIntroJigglypuff = (sys, st) => {
  if (st.jt === 0) {
    if (sys.flag === 0) return;
    st.jt = st.jt + 1;
    reinit(st, "GSIntroJigglypuff2");
  }
  if (st.x === 0xd0) {
    deinit(st);
    return;
  }
  st.x = mod(st.x - 2, 256);
};

// Lua: SpriteAnims.lua:745
SEQUENCES.GSIntroPikachu = (sys, st) => {
  if (st.jt === 0) {
    if (st.x === 0x80) {
      st.jt = st.jt + 1;
      st.var2 = 0x30;
      reinit(st, "GSIntroPikachu2");
      return;
    }
    st.x = mod(st.x - 1, 256);
  } else if (st.jt === 1) {
    if (st.var2 === 0) {
      st.jt = st.jt + 1;
      reinit(st, "GSIntroPikachu3");
      return;
    }
    st.var2 = st.var2 - 1;
  } else if (st.jt === 2) {
    st.var1 = mod(st.var1 + 4, 256);
    st.yOffset = sine(st.var1, 4);
    if (st.x === 0x50) {
      sys.flag = 1;
      st.jt = st.jt + 1;
      return;
    }
    st.x = mod(st.x - 4, 256);
  } else {
    if (st.x === 0xd0) {
      deinit(st);
      return;
    }
    st.x = mod(st.x - 2, 256);
  }
};

// Lua: SpriteAnims.lua:779
SEQUENCES.GSIntroPikachuTail = (sys, st) => {
  if (st.jt === 0) {
    if (st.x === 0x80) {
      st.jt = st.jt + 1;
      st.var2 = 0x30;
      reinit(st, "GSIntroPikachuTail2");
      return;
    }
    st.x = mod(st.x - 1, 256);
  } else if (st.jt === 1) {
    if (st.var2 === 0) {
      st.jt = st.jt + 1;
      return;
    }
    const before = st.var2;
    st.var2 = st.var2 - 1;
    // Two thirds of the way through the wind-up the tail starts swishing again.
    if (before === 0x20) reinit(st, "GSIntroPikachuTail");
  } else {
    st.var1 = mod(st.var1 + 4, 256);
    st.yOffset = sine(st.var1, 4);
    if (st.x === 0xd0) {
      deinit(st);
      return;
    }
    st.x = mod(st.x - 2, 256);
    // Before Pikachu himself has left, the tail runs at double speed.
    if (sys.flag !== 0) return;
    st.x = mod(st.x - 2, 256);
  }
};

// Lua: SpriteAnims.lua:812
SEQUENCES.GSIntroFireball = (_sys, st) => {
  if (st.jt === 0) {
    st.jt = st.jt + 1;
    // Two slices of the struct index become the launch angle.
    st.var1 = mod(mod(st.index, 4) * 16 + (st.index & 4) * 2, 256);
    return;
  }
  st.x = mod(st.x - 4, 256);
  const amplitude = st.var2;
  st.var2 = mod(st.var2 + 8, 256);
  st.yOffset = sine(st.var1, amplitude);
  st.xOffset = cosine(st.var1, amplitude);
};

// Lua: SpriteAnims.lua:829 -- the starters flash in along a quarter arc.
function starterFlash(st: AnimStruct, xPhase: number): void {
  if (st.jt === 0) {
    st.jt = st.jt + 1;
    st.var1 = 0x30;
    st.var2 = xPhase;
    return;
  }
  if (st.var1 >= 0x3c) return;
  // `inc [hl]` twice leaves a holding the value from before.
  const yPhase = st.var1;
  st.var1 = mod(st.var1 + 2, 256);
  st.yOffset = sine(yPhase, 0x90);
  const xAngle = st.var2;
  st.var2 = mod(st.var2 + 2, 256);
  st.xOffset = cosine(xAngle, 0x90);
}

// Lua: SpriteAnims.lua:847
SEQUENCES.GSIntroChikoritaTotodile = (_sys, st) => { starterFlash(st, 0x30); };
// Lua: SpriteAnims.lua:848
SEQUENCES.GSIntroCyndaquil = (_sys, st) => { starterFlash(st, 0x10); };

// Lua: SpriteAnims.lua:853 -- AnimSeq_GameFreakLogo: the splash owns the palette clock.
SEQUENCES.GameFreakLogo = () => {};

// Lua: SpriteAnims.lua:864 -- the star spirals inward; its death is the scene's cue.
SEQUENCES.GSGameFreakLogoStar = (sys, st) => {
  const radius = st.var1;
  if (radius === 0) {
    sys.flag = 1;
    deinit(st);
    return;
  }
  st.var1 = mod(st.var1 - 2, 256);
  if (mod(radius, 0x20) === 0) st.var2 = mod(st.var2 - 1, 256);
  const angle = st.jt;
  st.yOffset = sine(angle, radius);
  st.xOffset = cosine(angle, radius);
  st.jt = mod(st.jt + st.var2, 256);
};

// Lua: SpriteAnims.lua:885 -- a sparkle flies out along the angle its spawn picked.
SEQUENCES.GSGameFreakLogoSparkle = (_sys, st) => {
  let speed = st.var1 + st.var2 * 256;
  if (speed === 0) {
    deinit(st);
    return;
  }
  const amplitude = st.var4, angle = st.jt;
  st.yOffset = sine(angle, amplitude);
  st.xOffset = cosine(angle, amplitude);
  const travelled = mod(st.var3 + st.var4 * 256 + speed, 0x10000);
  st.var3 = mod(travelled, 256); st.var4 = Math.floor(travelled / 256);
  speed = mod(speed - 0x10, 0x10000);
  st.var1 = mod(speed, 256); st.var2 = Math.floor(speed / 256);
  st.jt = st.jt ^ 0x20;
};

export const SpriteAnims = {
  SINE,
  OAMSETS,
  FRAMESETS,
  OBJECTS,
  SEQUENCES,
  NUM_STRUCTS,
  OAM_LIMIT,
  OAM_PRIO,
  OAM_YFLIP,
  OAM_XFLIP,
  sine,
  cosine,
  // Lua: SpriteAnims.lua:502 -- `flag` is wIntroSpriteStateFlag.
  new(): SpriteAnimSystem {
    return new SpriteAnimSystem();
  },
};
export default SpriteAnims;
