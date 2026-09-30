// The game-logic tables of Yellow's Surfing Pikachu minigame, as the ROM
// has them: engine/minigame/surfing_pikachu.asm, data/sprite_anims/
// surfing_pikachu_frames.asm and surfing_pikachu_oam.asm (pokeyellow).
// Graphics and the tilemap INCBINs are not here -- the importer provides
// those from the player's ROM.
//
// No Bun and no host here.

/** SURFING_MINIGAME_FLAT_WATER_Y */
export const SURFING_MINIGAME_FLAT_WATER_Y = 0x74;
/** SURFING_MINIGAME_CENTER_X: SCREEN_WIDTH_PX / 2 + OAM_X_OFS */
export const SURFING_MINIGAME_CENTER_X = 160 / 2 + 8;

/** SURFING_MINIGAME_PIKACHU_STATE_* */
export const PIKACHU_STATE = {
  RIDING: 0,
  JUMPING: 1,
  LANDING: 2,
  CRASHED: 3,
  GAME_END: 4,
  INIT_RESULTS: 5,
  RESULTS: 6,
} as const;

/** SurfingMinigame_UpdateMusicTempo.Tempos (dw) */
export const Tempos: readonly number[] = [117, 109, 101, 93, 85];

export const SurfingPikachuMiniPikachuTile: readonly number[] = [0xfe];
export const SurfingPikachuHPDigitTiles: readonly number[] = [0xd0, 0xd0, 0xd0, 0xd0];
export const SurfingPikachuWideCloudTiles: readonly number[] = [0xec, 0xed, 0xed, 0xee, 0xef];
export const SurfingPikachuNarrowCloudTiles: readonly number[] = [0xec, 0xed, 0xee, 0xef];
export const SurfingPikachuStatusBarTiles: readonly number[] = [0x17, 0x18, 0x19, 0x19, 0x19, 0x19, 0x19, 0x19, 0x19];

/** SurfingMinigame_PrintTextHiScore.Hi_Score: "Hi-Score!!" */
export const Hi_Score: readonly number[] = [0x20, 0x2e, 0x2f, 0x30, 0x31, 0x2c, 0x32, 0x23, 0x33];
/** SurfingMinigame_WriteHPLeft.HP_Left: "HP Left" */
export const HP_Left: readonly number[] = [0x20, 0x21, 0xff, 0x22, 0x23, 0x24, 0x25];
/** SurfingMinigame_WriteRadness.Radness */
export const Radness: readonly number[] = [0x27, 0x28, 0x29, 0x2a, 0x23, 0x26, 0x26];
/** SurfingMinigame_WriteTotal.Total */
export const Total: readonly number[] = [0x2b, 0x2c, 0x25, 0x28, 0x2d];

/** SurfingMinigame_LYOverridesInitialSineWave: amplitude 2, signed bytes */
export const SurfingMinigame_LYOverridesInitialSineWave: readonly number[] = [
  0, 0, 0, 1, 1, 1, 1, 2,
  2, 2, 1, 1, 1, 1, 0, 0,
  0, 0, 0, -1, -1, -1, -1, -2,
  -2, -2, -1, -1, -1, -1, 0, 0,
];

/**
 * SurfingPikachu_Sine.SineWave: `sine_table 32` under rgbasm -Q8, i.e.
 * dw round(sin(x / 64 turn) * 256) for x = 0..31.
 */
export const SineWave: readonly number[] = [
  0, 25, 50, 74, 98, 121, 142, 162, 181, 198, 213, 226, 237, 245, 251, 255,
  256, 255, 251, 245, 237, 226, 213, 198, 181, 162, 142, 121, 98, 74, 50, 25,
];

/** SurfingMinigame_BGMetatileTable: 2x2 tiles, (top-left, top-right, bottom-left, bottom-right) */
export const SurfingMinigame_BGMetatileTable: readonly (readonly number[])[] = [
  [0x00, 0x00, 0x00, 0x00], // 00 sky block (blank)
  [0x0b, 0x0b, 0x0b, 0x0b], // 01 water block
  [0x0b, 0x02, 0x02, 0x06], // 02
  [0x03, 0x0b, 0x07, 0x03], // 03
  [0x06, 0x06, 0x06, 0x06], // 04
  [0x07, 0x07, 0x07, 0x07], // 05
  [0x06, 0x04, 0x04, 0x08], // 06
  [0x05, 0x07, 0x08, 0x05], // 07
  [0x0b, 0x0b, 0x11, 0x12], // 08
  [0x0b, 0x0b, 0x13, 0x03], // 09
  [0x14, 0x12, 0x04, 0x08], // 0a
  [0x13, 0x07, 0x08, 0x05], // 0b
  [0x06, 0x14, 0x06, 0x14], // 0c unused, identical to 11
  [0x13, 0x07, 0x13, 0x07], // 0d
  [0x08, 0x08, 0x08, 0x08], // 0e solid blue
  [0x14, 0x12, 0x14, 0x12], // 0f
  [0x0b, 0x11, 0x02, 0x14], // 10
  [0x06, 0x14, 0x06, 0x14], // 11
  [0x0c, 0x0c, 0x0d, 0x0d], // 12 beach top block
  [0x0d, 0x0d, 0x0d, 0x0d], // 13 beach sand block
  [0x0e, 0x0f, 0x10, 0x0b], // 14 beach shore block
  [0x12, 0x13, 0x12, 0x13], // 15
];

/** SurfingMinigameWavePattern00 .. 1C: the eight metatiles of a course slice, top to bottom */
export const SurfingMinigameWavePatterns: readonly (readonly number[])[] = [
  [0x00, 0x00, 0x00, 0x01, 0x01, 0x01, 0x01, 0x01], // 00
  [0x00, 0x00, 0x00, 0x01, 0x01, 0x02, 0x04, 0x06], // 01
  [0x00, 0x00, 0x00, 0x01, 0x02, 0x04, 0x06, 0x0e], // 02
  [0x00, 0x00, 0x00, 0x10, 0x11, 0x06, 0x0e, 0x0e], // 03
  [0x00, 0x00, 0x00, 0x15, 0x15, 0x0e, 0x0e, 0x0e], // 04
  [0x00, 0x00, 0x00, 0x03, 0x05, 0x07, 0x0e, 0x0e], // 05
  [0x00, 0x00, 0x00, 0x01, 0x03, 0x05, 0x07, 0x0e], // 06
  [0x00, 0x00, 0x00, 0x01, 0x01, 0x03, 0x05, 0x07], // 07
  [0x00, 0x00, 0x00, 0x01, 0x01, 0x02, 0x04, 0x06], // 08
  [0x00, 0x00, 0x00, 0x01, 0x02, 0x04, 0x06, 0x0e], // 09
  [0x00, 0x00, 0x00, 0x08, 0x0f, 0x0a, 0x0e, 0x0e], // 0A
  [0x00, 0x00, 0x00, 0x09, 0x0d, 0x0b, 0x0e, 0x0e], // 0B
  [0x00, 0x00, 0x00, 0x01, 0x03, 0x05, 0x07, 0x0e], // 0C
  [0x00, 0x00, 0x00, 0x01, 0x01, 0x03, 0x05, 0x07], // 0D
  [0x00, 0x00, 0x00, 0x01, 0x01, 0x02, 0x04, 0x06], // 0E
  [0x00, 0x00, 0x00, 0x01, 0x10, 0x11, 0x06, 0x0e], // 0F
  [0x00, 0x00, 0x00, 0x01, 0x15, 0x15, 0x0e, 0x0e], // 10
  [0x00, 0x00, 0x00, 0x01, 0x03, 0x05, 0x07, 0x0e], // 11
  [0x00, 0x00, 0x00, 0x01, 0x01, 0x03, 0x05, 0x07], // 12
  [0x00, 0x00, 0x00, 0x01, 0x01, 0x02, 0x04, 0x06], // 13
  [0x00, 0x00, 0x00, 0x01, 0x08, 0x0f, 0x0a, 0x0e], // 14
  [0x00, 0x00, 0x00, 0x01, 0x09, 0x0d, 0x0b, 0x0e], // 15
  [0x00, 0x00, 0x00, 0x01, 0x01, 0x03, 0x05, 0x07], // 16
  [0x00, 0x00, 0x00, 0x01, 0x01, 0x10, 0x11, 0x06], // 17
  [0x00, 0x00, 0x00, 0x01, 0x01, 0x15, 0x15, 0x0e], // 18
  [0x00, 0x00, 0x00, 0x01, 0x01, 0x03, 0x05, 0x07], // 19
  [0x00, 0x00, 0x00, 0x01, 0x01, 0x08, 0x0f, 0x0a], // 1A
  [0x00, 0x00, 0x00, 0x01, 0x01, 0x09, 0x0d, 0x0b], // 1B
  [0x00, 0x00, 0x00, 0x14, 0x14, 0x14, 0x14, 0x14], // 1C
];
/** SurfingMinigameBeachPattern */
export const SurfingMinigameBeachPattern: readonly number[] = [0x00, 0x00, 0x00, 0x12, 0x13, 0x13, 0x13, 0x13];

/** SurfingMinigame_WaveSequenceStarts: the eight random wave sequences' first states */
export const SurfingMinigame_WaveSequenceStarts: readonly number[] = [0x01, 0x0e, 0x1a, 0x29, 0x32, 0x40, 0x4d, 0x5c];

/**
 * One entry of SurfingMinigame_GetWaveDataPointers.WaveFunctions. A "load"
 * is one of the SurfingMinigame_Load*: b and c are the left and right wave
 * heights (screen pixels), `pattern` the eight metatiles, and `then` its tail
 * -- SurfingMinigame_AdvanceWaveFunction, SurfingMinigame_ResetWaveSequence,
 * or a plain ret (SurfingMinigame_LoadFlatWave).
 */
export type WaveFunction =
  | { kind: "choose"; label: string }
  | { kind: "load"; label: string; b: number; c: number; pattern: readonly number[]; then: "advance" | "reset" | "stay" };

const FY = SURFING_MINIGAME_FLAT_WATER_Y;
const TILE_HEIGHT = 8;
/** lb bc, FLAT_WATER_Y - b * TILE_HEIGHT, FLAT_WATER_Y - c * TILE_HEIGHT */
function load(n: number, b: number, c: number, then: "advance" | "reset" | "stay" = "advance"): WaveFunction {
  const hex = n.toString(16).toUpperCase().padStart(2, "0");
  return {
    kind: "load",
    label: `SurfingMinigame_LoadWavePattern${hex}AndAdvance`,
    b: FY - b * TILE_HEIGHT,
    c: FY - c * TILE_HEIGHT,
    pattern: SurfingMinigameWavePatterns[n]!,
    then,
  };
}
const CHOOSE: WaveFunction = { kind: "choose", label: "SurfingMinigame_ChooseNextWaveSequence" };
const P00 = load(0x00, 0, 0);
const P01 = load(0x01, 0, 1);
const P02 = load(0x02, 2, 3);
const P03 = load(0x03, 4, 5);
const P04 = load(0x04, 6, 6);
const P05 = load(0x05, 6, 5);
const P06 = load(0x06, 4, 3);
const P07 = load(0x07, 2, 1);
const P08 = load(0x08, 0, 1);
const P09 = load(0x09, 2, 3);
const P0A = load(0x0a, 4, 5);
const P0B = load(0x0b, 5, 5);
const P0C = load(0x0c, 4, 3);
const P0D = load(0x0d, 2, 1);
const P0E = load(0x0e, 0, 1);
const P0F = load(0x0f, 2, 3);
const P10 = load(0x10, 4, 4);
const P11 = load(0x11, 4, 3);
const P12 = load(0x12, 2, 1);
const P13 = load(0x13, 0, 1);
const P14 = load(0x14, 2, 3);
const P15 = load(0x15, 3, 3);
const P16 = load(0x16, 2, 1);
const P17 = load(0x17, 0, 1);
const P18 = load(0x18, 2, 2);
const P19 = load(0x19, 2, 1);
const P1A = load(0x1a, 0, 1);
const P1B = load(0x1b, 1, 1);
const P1C = load(0x1c, 0, 0);
const BEACH: WaveFunction = {
  kind: "load", label: "SurfingMinigame_LoadBeachPatternAndAdvance", b: FY, c: FY, pattern: SurfingMinigameBeachPattern, then: "advance",
};
const BEACH_RESET: WaveFunction = {
  kind: "load", label: "SurfingMinigame_LoadBeachPatternAndReset", b: FY, c: FY, pattern: SurfingMinigameBeachPattern, then: "reset",
};
const FLAT_RESET: WaveFunction = {
  kind: "load", label: "SurfingMinigame_LoadFlatWaveAndReset", b: FY, c: FY, pattern: SurfingMinigameWavePatterns[0]!, then: "reset",
};
const FLAT: WaveFunction = {
  kind: "load", label: "SurfingMinigame_LoadFlatWave", b: FY, c: FY, pattern: SurfingMinigameWavePatterns[0]!, then: "stay",
};

/** SurfingMinigame_GetWaveDataPointers.WaveFunctions, $00..$7b */
export const WaveFunctions: readonly WaveFunction[] = [
  CHOOSE, // 00
  P13, P14, P15, P16, P00, P17, P18, P19, P00, P00, P00, P00, FLAT_RESET, // 01-0d
  P08, P09, P0A, P0B, P0C, P0D, P00, P00, P00, P00, P00, FLAT_RESET, // 0e-19
  P0E, P0F, P10, P11, P12, P0E, P0F, P10, P11, P12, P00, P00, P00, P00, FLAT_RESET, // 1a-28
  P13, P14, P15, P16, P00, P00, P00, P00, FLAT_RESET, // 29-31
  P17, P18, P19, P17, P18, P19, P17, P18, P19, P00, P00, P00, P00, FLAT_RESET, // 32-3f
  P1A, P1B, P0E, P0F, P10, P11, P12, P1A, P1B, P00, P00, P00, FLAT_RESET, // 40-4c
  P08, P09, P0A, P0B, P0C, P0D, P00, P1A, P1B, P1A, P1B, P00, P00, P00, FLAT_RESET, // 4d-5b
  P0E, P0F, P10, P11, P12, P13, P14, P15, P16, P00, P00, P00, P00, FLAT_RESET, // 5c-69
  P01, P02, P03, P04, P05, P06, P07, FLAT, // 6a-71: the Big Kahuna
  P00, P1C, BEACH, BEACH, BEACH, BEACH, BEACH, BEACH, BEACH, BEACH_RESET, // 72-7b: the beach
];

// ---------------------------------------------------------------- animated objects

/** SurfingPikachuObjectSpawnData: frameset, callback, tile offset (the engine ignores the last) */
export const SurfingPikachuObjectSpawnData: readonly (readonly number[])[] = [
  [0x00, 0x00, 0x00], // 0: unused
  [0x04, 0x01, 0x00], // 1: surfing Pikachu
  [0x11, 0x02, 0x00], // 2: START
  [0x12, 0x02, 0x00], // 3: GOAL
  [0x15, 0x00, 0x00], // 4: +50
  [0x16, 0x00, 0x00], // 5: +150
  [0x17, 0x00, 0x00], // 6: +350
  [0x18, 0x00, 0x00], // 7: +750
  [0x19, 0x00, 0x00], // 8: +180
  [0x1a, 0x00, 0x00], // 9: +500
  [0x14, 0x00, 0x00], // a: water spray
  [0x13, 0x03, 0x00], // b: Oh no...
  [0x1b, 0x04, 0x00], // c: intro Pikachu
];

// macros/scripts/gfx_anims.asm
const OAM_XFLIP = 0x20;
const OAM_YFLIP = 0x40;
const OAM_PAL1 = 0x10;
/** frame id, duration[, flags...]: db id, duration | flags << 1 */
function frame(id: number, duration: number, ...flags: number[]): number[] {
  let x = duration;
  for (const f of flags) x |= f << 1;
  return [id, x & 0xff];
}
const endanim = [0xff];
const dorestart = [0xfe];
const dorepeat = (n: number): number[] => [0xfd, n];
const delanim = [0xfc];
const script = (...parts: number[][]): number[] => parts.flat();
const surfingAngle = (a: number, b: number, ...flags: number[]): number[] =>
  script(frame(a, 8, ...flags), frame(b, 8, ...flags), dorestart);
const points = (id: number): number[] =>
  script(frame(id, 4), dorepeat(1), frame(id, 3), dorepeat(1), frame(id, 2), dorepeat(1), frame(id, 1), delanim);
const XY = [OAM_XFLIP, OAM_YFLIP];

/** SurfingPikachuFrames (data/sprite_anims/surfing_pikachu_frames.asm), by frameset, as the ROM's bytes */
export const SurfingPikachuFrames: readonly (readonly number[])[] = [
  script(frame(0x00, 32), endanim), // .SingleTile, unused
  surfingAngle(0x01, 0x02), // .SurfingAngle00
  surfingAngle(0x03, 0x04), // .SurfingAngle01
  surfingAngle(0x05, 0x06), // .SurfingAngle02
  surfingAngle(0x07, 0x08), // .SurfingAngle03
  surfingAngle(0x09, 0x0a), // .SurfingAngle04
  surfingAngle(0x0b, 0x0c), // .SurfingAngle05
  surfingAngle(0x0d, 0x0e), // .SurfingAngle06
  surfingAngle(0x01, 0x02, ...XY), // .SurfingAngle07
  surfingAngle(0x03, 0x04, ...XY), // .SurfingAngle08
  surfingAngle(0x05, 0x06, ...XY), // .SurfingAngle09
  surfingAngle(0x07, 0x08, ...XY), // .SurfingAngle10
  surfingAngle(0x09, 0x0a, ...XY), // .SurfingAngle11
  surfingAngle(0x0b, 0x0c, ...XY), // .SurfingAngle12
  surfingAngle(0x0d, 0x0e, ...XY), // .SurfingAngle13
  script(frame(0x11, 7), frame(0x12, 7), dorestart), // .SmallSplash
  script(frame(0x13, 2), frame(0x14, 2), dorepeat(8), frame(0x15, 2), endanim), // .LargeSplash
  script(frame(0x16, 32), frame(0x16, 32), delanim), // .StartText
  script(frame(0x17, 32), frame(0x17, 32), delanim), // .GoalText, unused
  script(frame(0x18, 32), endanim), // .OhNoText
  script(frame(0x19, 1), delanim), // .WaterSpray
  points(0x1a), // .Plus50Pts
  points(0x1b), // .Plus150Pts
  points(0x1c), // .Plus350Pts
  points(0x1d), // .Plus750Pts, unused
  points(0x1e), // .Plus180Pts
  points(0x1f), // .Plus500Pts
  script(frame(0x20, 7), frame(0x21, 7), frame(0x22, 7), frame(0x23, 7), dorestart), // .IntroPikachu
];

/** One SurfingPikachuOAMData entry: dbw tile offset, pointer to (y, x, tile, attr) lists. */
export interface OamFrame {
  tile: number;
  entries: readonly (readonly number[])[];
}

const SingleTile = [[-4, -4, 0x00, 0]];
const SurfingPikachu = [
  [-12, -12, 0x00, 0], [-12, -4, 0x01, 0], [-12, 4, 0x02, 0],
  [-4, -12, 0x10, 0], [-4, -4, 0x11, 0], [-4, 4, 0x12, 0],
  [4, -12, 0x20, 0], [4, -4, 0x21, 0], [4, 4, 0x22, 0],
];
const TextBanner = [
  [-8, -24, 0x00, 0], [-8, -16, 0x01, 0], [-8, -8, 0x02, 0], [-8, 0, 0x03, 0], [-8, 8, 0x04, 0], [-8, 16, 0x05, 0],
  [0, -24, 0x10, 0], [0, -16, 0x11, 0], [0, -8, 0x12, 0], [0, 0, 0x13, 0], [0, 8, 0x14, 0], [0, 16, 0x15, 0],
];
const WaterSpray = [[-4, 11, 0x00, OAM_PAL1], [4, 3, 0x0f, OAM_PAL1], [4, 11, 0x10, OAM_PAL1]];
const SmallSplash = [
  [-4, -16, 0x00, OAM_PAL1 | OAM_XFLIP], [-4, 8, 0x00, OAM_PAL1],
  [4, -16, 0x10, OAM_PAL1 | OAM_XFLIP], [4, -8, 0x0f, OAM_PAL1 | OAM_XFLIP],
  [4, 0, 0x0f, OAM_PAL1], [4, 8, 0x10, OAM_PAL1],
];
const LargeSplash = [
  [-12, -16, 0x00, OAM_PAL1], [-12, -8, 0x01, OAM_PAL1], [-12, 0, 0x01, OAM_PAL1 | OAM_XFLIP], [-12, 8, 0x00, OAM_PAL1 | OAM_XFLIP],
  [-4, -16, 0x10, OAM_PAL1], [-4, -8, 0x11, OAM_PAL1], [-4, 0, 0x11, OAM_PAL1 | OAM_XFLIP], [-4, 8, 0x10, OAM_PAL1 | OAM_XFLIP],
  [4, -16, 0x20, OAM_PAL1], [4, -8, 0x21, OAM_PAL1], [4, 0, 0x21, OAM_PAL1 | OAM_XFLIP], [4, 8, 0x20, OAM_PAL1 | OAM_XFLIP],
];
const EmptySurfboard = [[4, -12, 0x00, 0], [4, -4, 0x01, 0], [4, 4, 0x02, 0]];
const pts = (a: number, b: number, c?: number, d?: number): number[][] =>
  d === undefined
    ? [[-4, -12, a, 0], [-4, -4, b, 0], [-4, 4, c!, 0]]
    : [[-4, -16, a, 0], [-4, -8, b, 0], [-4, 0, c!, 0], [-4, 8, d, 0]];
const IntroPikachu = [
  [-12, -16, 0x03, OAM_XFLIP], [-12, -8, 0x02, OAM_XFLIP], [-12, 0, 0x01, OAM_XFLIP], [-12, 8, 0x00, OAM_XFLIP],
  [-4, -16, 0x13, OAM_XFLIP], [-4, -8, 0x12, OAM_XFLIP], [-4, 0, 0x11, OAM_XFLIP], [-4, 8, 0x10, OAM_XFLIP],
  [4, -16, 0x23, OAM_XFLIP], [4, -8, 0x22, OAM_XFLIP], [4, 0, 0x21, OAM_XFLIP], [4, 8, 0x20, OAM_XFLIP],
];

/** SurfingPikachuOAMData (data/sprite_anims/surfing_pikachu_oam.asm), by frame id */
export const SurfingPikachuOAMData: readonly OamFrame[] = [
  { tile: 0x00, entries: SingleTile }, // referenced but unused
  { tile: 0x00, entries: SurfingPikachu }, // 01
  { tile: 0x36, entries: SurfingPikachu },
  { tile: 0x03, entries: SurfingPikachu },
  { tile: 0x39, entries: SurfingPikachu },
  { tile: 0x06, entries: SurfingPikachu },
  { tile: 0x3c, entries: SurfingPikachu },
  { tile: 0x09, entries: SurfingPikachu },
  { tile: 0x60, entries: SurfingPikachu },
  { tile: 0x0c, entries: SurfingPikachu },
  { tile: 0x63, entries: SurfingPikachu },
  { tile: 0x30, entries: SurfingPikachu },
  { tile: 0x66, entries: SurfingPikachu },
  { tile: 0x33, entries: SurfingPikachu },
  { tile: 0x69, entries: SurfingPikachu }, // 0e
  { tile: 0x6c, entries: SurfingPikachu }, // 0f .UnusedFrontPikachu
  { tile: 0x9c, entries: SurfingPikachu }, // 10 .UnusedBackPikachu
  { tile: 0xa0, entries: SurfingPikachu }, // 11 .ResultsPikachu
  { tile: 0xa3, entries: SurfingPikachu }, // 12 .ResultsPikachu
  { tile: 0xa7, entries: SmallSplash }, // 13
  { tile: 0xa8, entries: LargeSplash }, // 14
  { tile: 0x98, entries: EmptySurfboard }, // 15 when Pikachu has fallen off
  { tile: 0xe0, entries: TextBanner }, // 16 .StartText
  { tile: 0xe6, entries: TextBanner }, // 17 .GoalText, referenced but unused
  { tile: 0xca, entries: TextBanner }, // 18 .OhNoText
  { tile: 0xa7, entries: WaterSpray }, // 19
  { tile: 0x00, entries: pts(0xbf, 0xd5, 0xd0) }, // 1a .Plus50Pts
  { tile: 0x00, entries: pts(0xbf, 0xd1, 0xd5, 0xd0) }, // 1b .Plus150Pts
  { tile: 0x00, entries: pts(0xbf, 0xd3, 0xd5, 0xd0) }, // 1c .Plus350Pts
  { tile: 0x00, entries: pts(0xbf, 0xd7, 0xd5, 0xd0) }, // 1d .Plus750Pts
  { tile: 0x00, entries: pts(0xbf, 0xd1, 0xd8, 0xd0) }, // 1e .Plus180Pts
  { tile: 0x00, entries: pts(0xbf, 0xd5, 0xd0, 0xd0) }, // 1f .Plus500Pts
  { tile: 0x80, entries: IntroPikachu }, // 20
  { tile: 0x84, entries: IntroPikachu },
  { tile: 0x88, entries: IntroPikachu },
  { tile: 0x8c, entries: IntroPikachu }, // 23
];
