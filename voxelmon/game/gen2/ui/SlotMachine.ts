// gen1recomp src/ui/gen2/SlotMachine.lua (bdfac727, MIT): Gold's slot machine
// (engine/games/slot_machine.asm _SlotMachine), reached by the `special
// SlotMachine` every Game Corner machine's tile script calls.
//
// Every spin rolls a BIAS symbol out of a weighted table (Slots_InitBias), and
// each reel's stop is then MANIPULATED toward that symbol -- or, when the spin
// is unbiased, deliberately away from every symbol -- for up to four slots
// past where the player's A press landed. Reel 3 additionally has three
// near-miss theatres (the slow advance, the Golem drops and the Chansey egg)
// that only ever run when the first two reels already show matching SEVENs.
//
// Everything that decides an outcome is a pure function, taking a
// `random(n) -> 0..n-1`, so a test can drive seeded spins.
//
// Layout, from the ASM's own coordinates:
//
//   .PrintCoinsAndPayout  hlcoord 5, 1 and hlcoord 11, 1, 4 digits each
//   Slots_Lights*OnOff    hlcoord 3, 2 / 3, 4 / 3, 6 / 3, 8 / 3, 10, second
//                         tile of each light at column 16, pair one row down
//   Slots_InitReelTiles   the three reels in tile columns 6-7, 10-11, 14-15
//   Slots_UpdateReelPositionAndOAM
//                         the bottom symbol covers tile rows 8-9, the middle
//                         6-7, the top 4-5, a fourth peeks in at rows 2-3
//   Slots_AskBet          menu_coords 14, 10, 19, 17: " 3" at (16,12), cursor
//                         in column 15, labels two rows apart
//   Slots_PayoutText      the matched symbol's four tiles at (2,13)..(3,14),
//                         the ▼ at (18,17)

import G from "../platform/screen.ts";
import { loadGenerated } from "../platform/data.ts";
import { mod } from "../platform/lua.ts";
import { random as luaRandom } from "../platform/rng.ts";
import { CoinCase } from "../core/CoinCase.ts";
import { Music } from "../shared/core/Music.ts";
import { Sound } from "../shared/core/Sound.ts";
import { Strings } from "../shared/core/Strings.ts";
import { Assets } from "../shared/render/Assets.ts";
import { GbcPalette } from "../shared/render/GbcPalette.ts";
import type { LcdImage } from "../platform/screen.ts";
import { Chrome } from "./Chrome.ts";
import { TileSheet } from "./TileSheet.ts";

type Colors = readonly (readonly number[])[];
type Random = (n: number) => number;
/** A reel's three visible symbols, index 0 the BOTTOM row. */
export type ReelWindow = [number, number, number];

// ------------------------------------------------------------------ symbols
//
// Lua: SlotMachine.lua:61 -- the wSlotMatched constants are a `const_def 0,
// 4` block: they step by four and double as table indices.
const SEVEN = 0x00;
const POKEBALL = 0x04;
const CHERRY = 0x08;
const PIKACHU = 0x0c;
const SQUIRTLE = 0x10;
const STARYU = 0x14;

// SLOTS_NO_MATCH and SLOTS_NO_BIAS are both -1 ($ff). Lua: SlotMachine.lua:70
const NO_MATCH = -1;
const NO_BIAS = -1;

// Lua: SlotMachine.lua:73
const NAMES: Record<number, string> = {
  0x00: "SEVEN", 0x04: "POKEBALL", 0x08: "CHERRY",
  0x0c: "PIKACHU", 0x10: "SQUIRTLE", 0x14: "STARYU",
};

// Lua: SlotMachine.lua:79 -- what a symbol cell shows without the reel art.
const LABELS: Record<number, string> = {
  0x00: "7", 0x04: "()", 0x08: "CH",
  0x0c: "PI", 0x10: "SQ", 0x14: "ST",
};

// Lua: SlotMachine.lua:87 -- Slots_GetPayout .PayoutTable. The payout does
// NOT scale with the bet in Gen 2: the bet buys extra LINES.
const PAYOUTS: Record<number, number> = {
  0x00: 300, // SLOTS_SEVEN
  0x04: 50, // SLOTS_POKEBALL
  0x08: 6, // SLOTS_CHERRY
  0x0c: 8, // SLOTS_PIKACHU
  0x10: 10, // SLOTS_SQUIRTLE
  0x14: 15, // SLOTS_STARYU
};

/** Lua: SlotMachine.lua:96 */
function payout(matched: number | null | undefined): number {
  if (matched == null || matched === NO_MATCH) return 0;
  return PAYOUTS[matched] ?? 0;
}

// -------------------------------------------------------------------- reels
//
// Lua: SlotMachine.lua:107 -- Reel1..3Tilemap. REEL_SIZE is 15; the first
// three entries repeat at the end so a window reads without wrapping.
const REEL_SIZE = 15;

const REELS: number[][] = [
  // Reel1Tilemap: SEVEN at 0 and 5, a POKEBALL at 10.
  [SEVEN, CHERRY, STARYU, PIKACHU, SQUIRTLE,
    SEVEN, CHERRY, STARYU, PIKACHU, SQUIRTLE,
    POKEBALL, CHERRY, STARYU, PIKACHU, SQUIRTLE,
    SEVEN, CHERRY, STARYU],
  // Reel2Tilemap: one SEVEN, at 0, and POKEBALLs at 5 and 10.
  [SEVEN, PIKACHU, CHERRY, SQUIRTLE, STARYU,
    POKEBALL, PIKACHU, CHERRY, SQUIRTLE, STARYU,
    POKEBALL, PIKACHU, CHERRY, SQUIRTLE, STARYU,
    SEVEN, PIKACHU, CHERRY],
  // Reel3Tilemap: one SEVEN at 0 and one POKEBALL at 10.
  [SEVEN, PIKACHU, CHERRY, SQUIRTLE, STARYU,
    PIKACHU, CHERRY, SQUIRTLE, STARYU, PIKACHU,
    POKEBALL, CHERRY, SQUIRTLE, STARYU, PIKACHU,
    SEVEN, PIKACHU, CHERRY],
];

/**
 * Lua: SlotMachine.lua:144 -- Slots_GetCurrentReelState, byte for byte:
 * slot 0 reads as if it were 15, then `dec a / and $f`. Returns bottom,
 * middle, top. `strip` is 0-based.
 */
function window(strip: number[], position: number): ReelWindow {
  let a = position;
  if (a === 0) a = 0x0f;
  a = mod(a - 1, 16);
  return [strip[a]!, strip[a + 1]!, strip[a + 2]!];
}

/** Lua: SlotMachine.lua:152 -- inc a / and $f / cp REEL_SIZE / xor a. */
function advance(position: number): number {
  let a = mod(position + 1, 16);
  if (a === REEL_SIZE) a = 0;
  return a;
}

// -------------------------------------------------------------------- lines
//
// Lua: SlotMachine.lua:171 -- Slots_CheckMatchedAllThreeReels' jumptable,
// `wSlotBet and 3`, with .three falling through .two into .one. Every hit
// OVERWRITES wSlotMatched, so the LAST line checked pays (the middle row wins
// any tie). Each line is the window index (0 = bottom) per reel.
const UP_DIAG = [0, 1, 2];
const DOWN_DIAG = [2, 1, 0];
const BOTTOM = [0, 0, 0];
const TOP = [2, 2, 2];
const MIDDLE = [1, 1, 1];

const LINES: Record<number, number[][]> = {
  0: [],
  1: [MIDDLE],
  2: [BOTTOM, TOP, MIDDLE],
  3: [UP_DIAG, DOWN_DIAG, BOTTOM, TOP, MIDDLE],
};

function betLines(bet: number | null | undefined): number[][] {
  return LINES[mod(bet ?? 0, 4)] ?? [];
}

/** Lua: SlotMachine.lua:190 -- the matched symbol, or NO_MATCH. */
function matchAll(bet: number | null | undefined, r1: readonly number[], r2: readonly number[], r3: readonly number[]): number {
  let matched = NO_MATCH;
  for (const line of betLines(bet)) {
    const a = r1[line[0]!];
    if (a === r3[line[2]!] && a === r2[line[1]!]) matched = a!;
  }
  return matched;
}

// Lua: SlotMachine.lua:212 -- Slots_CheckMatchedFirstTwoReels: both diagonals
// and the middle row all test reel 2's middle symbol. {reel1, reel2} indices.
const TWO_LINES: Record<number, number[][]> = {
  0: [],
  1: [[1, 1]],
  2: [[0, 0], [2, 2], [1, 1]],
  3: [[0, 1], [2, 1], [0, 0], [2, 2], [1, 1]],
};

/**
 * Lua: SlotMachine.lua:219 -- the building symbol (or NO_MATCH) and whether
 * it is a SEVEN (wFirstTwoReelsMatchingSevens).
 */
function matchFirstTwo(bet: number | null | undefined, r1: readonly number[], r2: readonly number[]): [number, boolean] {
  let building = NO_MATCH;
  let matchingSevens = false;
  for (const line of TWO_LINES[mod(bet ?? 0, 4)] ?? []) {
    if (r1[line[0]!] === r2[line[1]!]) {
      building = r1[line[0]!]!;
      if (building === SEVEN) matchingSevens = true;
    }
  }
  return [building, matchingSevens];
}

// --------------------------------------------------------------------- bias
//
// Lua: SlotMachine.lua:242 -- Slots_InitBias. `percent` is "* $ff / 100"
// with integer division; the first row whose threshold is >= the roll wins.
const BIAS_NORMAL: [number, number][] = [
  [1, SEVEN], //   1 percent - 1
  [3, POKEBALL], //   1 percent + 1
  [10, STARYU], //   4 percent
  [20, SQUIRTLE], //   8 percent
  [40, PIKACHU], //  16 percent
  [48, CHERRY], //  19 percent
  [255, NO_BIAS],
];

// Lua: SlotMachine.lua:254 -- the luckier table (wScriptVar non-zero).
const BIAS_LUCKY: [number, number][] = [
  [2, SEVEN], //   1 percent
  [3, POKEBALL], //   1 percent + 1
  [8, STARYU], //   3 percent + 1
  [16, SQUIRTLE], //   6 percent + 1
  [30, PIKACHU], //  12 percent
  [80, CHERRY], //  31 percent + 1
  [255, NO_BIAS],
];

/**
 * Lua: SlotMachine.lua:268 -- `ld a, [wSlotBias] / and a / ret z`: a spin
 * already biased to SEVEN keeps it without rerolling.
 */
function initBias(currentBias: number | null | undefined, lucky: boolean | null | undefined, random: Random): number {
  if (currentBias === SEVEN) return SEVEN;
  const table = lucky ? BIAS_LUCKY : BIAS_NORMAL;
  const roll = random(256);
  for (const row of table) {
    if (row[0] >= roll) return row[1];
  }
  return NO_BIAS;
}

/** Lua: SlotMachine.lua:289 -- `call Random / and %00101010 / ret nz`. */
function rollKeepSevenChance(random: Random): boolean {
  return (random(256) & 0x2a) === 0;
}

/**
 * Lua: SlotMachine.lua:299 -- .LinedUpSevens: whether the seven bias
 * survives a SEVEN payout. keepSevenChance: and $1c (1 in 8); otherwise
 * and $14 (1 in 4) -- the ASM's own probably-inverted odds.
 */
function keepSevenBias(keepSevenChance: boolean | null | undefined, random: Random): boolean {
  const mask = keepSevenChance ? 0x1c : 0x14;
  return (random(256) & mask) === 0;
}

// --------------------------------------------------------------- reel stops
//
// Lua: SlotMachine.lua:316 -- each ReelAction_StopReel* runs once per SLOT;
// running it to a fixed point up front gives the slot the cart reaches.
const MANIP_COUNTER = 4;

// Lua: SlotMachine.lua:321
const SEARCH_LIMIT = REEL_SIZE * 4;

/**
 * Lua: SlotMachine.lua:326 -- ReelAction_StopReel1: no bias stops where the
 * player pressed; a bias walks up to four slots for it ANYWHERE in the window.
 */
function stopReel1(position: number, bias: number): number {
  const strip = REELS[0]!;
  let manip = MANIP_COUNTER;
  for (let i = 0; i < SEARCH_LIMIT; i++) {
    if (bias === NO_BIAS || manip === 0) return position;
    manip--;
    const [a, b, c] = window(strip, position);
    if (a === bias || b === bias || c === bias) return position;
    position = advance(position);
  }
  return position;
}

/**
 * Lua: SlotMachine.lua:341 -- ReelAction_StopReel2: stop once reels one and
 * two build the bias on a bought line, otherwise burn the four slots.
 */
function stopReel2(position: number, bias: number, bet: number, stopped1: readonly number[]): number {
  const strip = REELS[1]!;
  let manip = MANIP_COUNTER;
  for (let i = 0; i < SEARCH_LIMIT; i++) {
    const [building] = matchFirstTwo(bet, stopped1, window(strip, position));
    if (building !== NO_MATCH && building === bias) return position;
    if (bias === NO_BIAS || manip === 0) return position;
    manip--;
    position = advance(position);
  }
  return position;
}

/**
 * Lua: SlotMachine.lua:365 -- ReelAction_StopReel3, where "no bias means no
 * win" is enforced: a line matching the bias stops dead; a line matching
 * anything else keeps turning; no line stops unless a bias is still hunted.
 */
function stopReel3(position: number, bias: number, bet: number, stopped1: readonly number[], stopped2: readonly number[]): number {
  const strip = REELS[2]!;
  let manip = MANIP_COUNTER;
  for (let i = 0; i < SEARCH_LIMIT; i++) {
    const matched = matchAll(bet, stopped1, stopped2, window(strip, position));
    if (matched !== NO_MATCH) {
      if (matched === bias) return position;
      if (manip > 0) manip--;
    } else {
      if (bias === NO_BIAS || manip === 0) return position;
      manip--;
    }
    position = advance(position);
  }
  return position;
}

/**
 * Lua: SlotMachine.lua:393 -- Slots_StopReel2's alternative: bet >= 2, a
 * SEVEN anywhere in reel one, unbiased or SEVEN-biased: 80/256 that reel two
 * pauses and fast-spins to lined-up SEVENs.
 */
function reel2SkipsToSeven(bet: number | null | undefined, bias: number, stopped1: readonly number[], random: Random): boolean {
  if ((bet ?? 0) < 2) return false;
  if (bias !== SEVEN && bias !== NO_BIAS) return false;
  if (!(stopped1[0] === SEVEN || stopped1[1] === SEVEN || stopped1[2] === SEVEN)) return false;
  return random(256) < 80;
}

/** Lua: SlotMachine.lua:409 -- ReelAction_FastSpinReel2UntilLinedUp7s. */
function spinReel2ToSevens(position: number, bet: number, stopped1: readonly number[]): number {
  const strip = REELS[1]!;
  let pos = advance(position);
  for (let i = 0; i < SEARCH_LIMIT; i++) {
    const [building, sevens] = matchFirstTwo(bet, stopped1, window(strip, pos));
    if (building !== NO_MATCH && sevens) return pos;
    pos = advance(pos);
  }
  return pos;
}

// ------------------------------------------------------- reel 3's theatre
//
// Lua: SlotMachine.lua:428 -- Slots_StopReel3's action roll, only when the
// first two reels show matching SEVENs. The ASM's `.biased` label is reached
// when the bias is NOT SEVEN.
const REEL3_STOP = "stop";
const REEL3_SLOW = "slowAdvance";
const REEL3_GOLEM = "golem";
const REEL3_EGG = "chansey";

/** Lua: SlotMachine.lua:433 */
function reel3Action(matchingSevens: boolean | null | undefined, bias: number, random: Random): string {
  if (!matchingSevens) return REEL3_STOP;
  const r = random(256);
  if (bias === SEVEN) {
    // cp 71 percent - 1 (180) / cp 47 percent + 1 (120) / cp 24 percent - 1 (60)
    if (r >= 180) return REEL3_STOP; // 29.7%
    if (r >= 120) return REEL3_SLOW; // 23.4%
    if (r >= 60) return REEL3_GOLEM; // 23.4%
    return REEL3_EGG; // 23.4%
  }
  // cp 63 percent (160) / cp 31 percent + 1 (80). Chansey is unreachable here.
  if (r >= 160) return REEL3_STOP; // 37.5%
  if (r >= 80) return REEL3_SLOW; // 31.25%
  return REEL3_GOLEM; // 31.25%
}

/**
 * Lua: SlotMachine.lua:453 -- ReelAction_WaitSlowAdvanceReel3 .check1 /
 * .check2: SEVEN-biased spins toward lined-up SEVENs, anything else toward
 * NOTHING lined up.
 */
function theatreSatisfied(bias: number, matched: number): boolean {
  if (bias === SEVEN) return matched === SEVEN;
  return matched === NO_MATCH;
}

/** Lua: SlotMachine.lua:458 */
function slowAdvance(position: number, bias: number, bet: number, stopped1: readonly number[], stopped2: readonly number[]): number {
  const strip = REELS[2]!;
  for (let i = 0; i < SEARCH_LIMIT; i++) {
    const matched = matchAll(bet, stopped1, stopped2, window(strip, position));
    if (theatreSatisfied(bias, matched)) return position;
    position = advance(position);
  }
  return position;
}

/**
 * Lua: SlotMachine.lua:484 -- Slots_GetNumberOfGolems. Biased to SEVEN: one
 * slot per Golem until SEVENs line up (honest). Otherwise the search strides
 * by a growing step while the count returned is the FINAL stride, so the reel
 * lands somewhere the search never checked -- the cart's mismatch.
 */
function golemCount(position: number, bias: number, bet: number, stopped1: readonly number[], stopped2: readonly number[], random: Random): number {
  const strip = REELS[2]!;
  if (bias === SEVEN) {
    let walk = position;
    let count = 0;
    for (let i = 0; i < SEARCH_LIMIT; i++) {
      walk++;
      count++;
      const matched = matchAll(bet, stopped1, stopped2, window(strip, walk));
      if (matched === SEVEN) return count;
    }
    return count;
  }
  // `call Random / and $7 / cp $8 / 2 / jr c`: reroll until 4..7.
  let stride = random(8);
  while (stride < 4) stride = random(8);
  let walk = position;
  for (let i = 0; i < SEARCH_LIMIT; i++) {
    walk += stride;
    stride++;
    const matched = matchAll(bet, stopped1, stopped2, window(strip, walk));
    if (matched === NO_MATCH) return stride;
  }
  return stride;
}

// Lua: SlotMachine.lua:516 -- ReelAction_DropReel: 17 slots per egg.
const EGG_DROP = 17;

/** Lua: SlotMachine.lua:518 -- returns [position, drops]. */
function eggDrops(position: number, bet: number, stopped1: readonly number[], stopped2: readonly number[]): [number, number] {
  const strip = REELS[2]!;
  let drops = 0;
  for (let i = 0; i < SEARCH_LIMIT; i++) {
    for (let k = 0; k < EGG_DROP; k++) position = advance(position);
    drops++;
    const matched = matchAll(bet, stopped1, stopped2, window(strip, position));
    // `.check_match`: a match AND that match being SEVEN settles it.
    if (matched === SEVEN) return [position, drops];
  }
  return [position, drops];
}

export interface SpinOpts {
  random: Random;
  bet?: number;
  bias?: number;
  lucky?: boolean;
  /** Where the player's three A presses landed (0-based slot per reel). */
  stops?: number[];
}

export interface SpinResult {
  matched: number;
  payout: number;
  bias: number;
  reel3Action: string;
  positions: [number, number, number];
  windows: [ReelWindow, ReelWindow, ReelWindow];
}

/** Lua: SlotMachine.lua:542 -- one spin resolved end to end. */
function spin(opts: SpinOpts): SpinResult {
  const random = opts.random;
  const bet = opts.bet ?? 1;
  const bias = initBias(opts.bias ?? NO_BIAS, opts.lucky, random);
  const stops = opts.stops ?? [0, 0, 0];

  const p1 = stopReel1(stops[0]!, bias);
  const r1 = window(REELS[0]!, p1);

  let p2: number;
  if (reel2SkipsToSeven(bet, bias, r1, random)) p2 = spinReel2ToSevens(stops[1]!, bet, r1);
  else p2 = stopReel2(stops[1]!, bias, bet, r1);
  const r2 = window(REELS[1]!, p2);
  const [, matchingSevens] = matchFirstTwo(bet, r1, r2);

  const action = reel3Action(matchingSevens, bias, random);
  let p3 = stops[2]!;
  if (action === REEL3_STOP) {
    p3 = stopReel3(p3, bias, bet, r1, r2);
  } else if (action === REEL3_SLOW) {
    p3 = slowAdvance(p3, bias, bet, r1, r2);
  } else if (action === REEL3_GOLEM) {
    const count = golemCount(p3, bias, bet, r1, r2, random);
    for (let i = 0; i < count; i++) p3 = advance(p3);
  } else {
    [p3] = eggDrops(p3, bet, r1, r2);
  }
  const r3 = window(REELS[2]!, p3);

  const matched = matchAll(bet, r1, r2, r3);
  return {
    matched,
    payout: payout(matched),
    bias,
    reel3Action: action,
    positions: [p1, p2, p3],
    windows: [r1, r2, r3],
  };
}

// ------------------------------------------------------------------- layout
// Lua: SlotMachine.lua:587
const COINS_X = 5;
const COINS_Y = 1;
const PAYOUT_X = 11;
const PAYOUT_Y = 1;
// REEL_X_COORD / TILE_WIDTH (5, 9, 13): the three reel apertures.
const REEL_X = [5, 9, 13];
// bottom, middle, top, and the fourth symbol that only half shows.
const REEL_ROW = [8, 6, 4, 2];
// Slots_Lights3OnOff / 2 / 1: rows per bet, and the two columns.
const LIGHT_ROWS: Record<number, number[]> = { 3: [2, 10], 2: [4, 8], 1: [6] };
const LIGHT_COLS = [3, 16];
// Slots_AskBet's MenuHeader through GetMenuTextStartCoord.
const BET_BOX_X = 14;
const BET_BOX_Y = 10;
const BET_BOX_W = 6;
const BET_BOX_H = 8;
const BET_LABEL_X = 16;
const BET_LABEL_Y = 12;
const BET_SPACING = 2;
// .Text_PrintPayout's four ldcoord_a writes.
const PAYOUT_SYMBOL_X = 2;
const PAYOUT_SYMBOL_Y = 13;
// Textbox(0, TEXTBOX_Y).
const TEXT_BOX_X = 0;
const TEXT_BOX_Y = 12;
const TEXT_BOX_W = 20;
const TEXT_BOX_H = 6;
const TEXT_X = 1;
const TEXT_Y = 14;
const TEXT_LINE = 2;

// --------------------------------------------------------------------- text
//
// Lua: SlotMachine.lua:613 -- data/text/common_2.asm and common_3.asm.
export interface StaticText {
  source: string;
  english?: string[];
  args?: unknown[];
}

function splitLines(text: string): string[] {
  return text.split("\n");
}

/** Lua: SlotMachine.lua:624 */
function staticText(source: string): StaticText {
  return { source, english: splitLines(source) };
}

// Lua: SlotMachine.lua:628
const TEXTS: Record<string, StaticText> = {
  betHowMany: staticText(Strings.source("Bet how many\ncoins?")),
  start: staticText(Strings.source("Start!")),
  notEnough: staticText(Strings.source("Not enough\ncoins.")),
  ranOut: staticText(Strings.source("Darn… Ran out of\ncoins…")),
  playAgain: staticText(Strings.source("Play again?")),
  darn: staticText(Strings.source("Darn!")),
};

// Lua: SlotMachine.lua:642 -- keyed by the lines object (weak).
const lineCache = new WeakMap<StaticText, { text: string; lines: string[] }>();

/** Lua: SlotMachine.lua:652 -- deliberately \n-only (fixed two-line messages). */
function localizedLines(lines: StaticText | string[] | null | undefined): string[] {
  if (!lines) return [];
  if (Array.isArray(lines)) return lines;
  if (!lines.source) return [];
  const translated = lines.args ? Strings.get(lines.source, ...lines.args) : Strings.get(lines.source);
  if (translated === lines.source) return lines.english ?? splitLines(translated);
  const cached = lineCache.get(lines);
  if (cached && cached.text === translated) return cached.lines;
  const out = splitLines(translated);
  lineCache.set(lines, { text: translated, lines: out });
  return out;
}

/** Lua: SlotMachine.lua:670 -- _SlotsLinedUpText. */
function linedUpLines(won: number): StaticText {
  return { source: Strings.source("    lined up!\nWon %d coins!"), args: [won] };
}

// Lua: SlotMachine.lua:676 -- Slots_PlaySFX's labels.
const SFX_START = "Sfx_SlotMachineStart";
const SFX_STOP = "Sfx_StopSlot";
const SFX_PAY_DAY = "Sfx_PayDay";
const SFX_COIN = "Sfx_GetCoinFromSlots";
const SFX_QUIT = "Sfx_QuitSlots";
const SFX_SEVENS = "Sfx_2ndPlace";
const SFX_POKEBALLS = "Sfx_3rdPlace";
const SFX_SMALL_WIN = "Sfx_Present";

// Lua: SlotMachine.lua:744 -- Slots_AskBet: `ld a, 4 / sub b`.
const BET_ROWS = [" 3", " 2", " 1"];

export interface SlotMachineOpts {
  save?: any;
  /** wScriptVar on entry: the room's lucky machine. */
  lucky?: boolean;
  random?: Random;
  onClose?: () => void;
}

interface GolemAnim {
  count: number;
  state: string;
  var1: number;
  x: number;
  y: number;
  animFrame: number;
  animTimer: number;
  xoffset?: number;
}

interface ChanseyAnim {
  state: string;
  xcoord: number;
  x: number;
  y: number;
  animTimer: number;
  animPose: number;
  delay?: number;
  eggTimer?: number;
  eggStartX?: number;
  eggStartY?: number;
  eggX?: number;
  eggY?: number;
  eggVisible?: boolean;
}

// --------------------------------------------------------------------- draw
//
// Lua: SlotMachine.lua:1180 -- Color Game Boy palettes.
const GBC_PALS: { bg: Record<number, Colors>; obj: Record<number, Colors> } = {
  bg: {
    0: [[255, 255, 255], [198, 206, 231], [198, 198, 74], [0, 0, 0]], // Base frame
    1: [[255, 255, 255], [247, 82, 49], [198, 198, 74], [0, 0, 0]], // Vileplume / active lights
    2: [[255, 255, 255], [123, 255, 0], [198, 198, 74], [0, 0, 0]], // Bet 3 indicators
    3: [[255, 255, 255], [255, 123, 255], [198, 198, 74], [0, 0, 0]], // Bet 2 indicators
    4: [[255, 255, 255], [123, 173, 255], [198, 198, 74], [0, 0, 0]], // Bet 1 indicators
    5: [[255, 255, 90], [255, 255, 49], [198, 198, 74], [0, 0, 0]], // Yellow highlights
    6: [[255, 255, 255], [132, 156, 239], [206, 181, 0], [0, 0, 0]], // Textbox frame
    7: [[255, 255, 255], [173, 173, 173], [107, 107, 107], [0, 0, 0]], // Inactive / gray
  },
  obj: {
    0: [[255, 255, 255], [247, 82, 49], [255, 0, 0], [0, 0, 0]], // Seven
    1: [[255, 255, 255], [99, 206, 8], [41, 115, 0], [0, 0, 0]], // Pokeball
    2: [[255, 255, 255], [99, 206, 8], [247, 82, 49], [0, 0, 0]], // Cherry
    3: [[255, 255, 255], [255, 255, 49], [165, 123, 24], [0, 0, 0]], // Pikachu
    4: [[255, 255, 255], [255, 255, 49], [123, 173, 255], [0, 0, 0]], // Squirtle
    5: [[255, 255, 255], [255, 255, 49], [165, 123, 24], [0, 0, 0]], // Staryu / Golem
    6: [[255, 255, 255], [255, 198, 173], [255, 107, 255], [0, 0, 0]], // Chansey
    7: [[255, 255, 255], [255, 255, 255], [0, 0, 0], [0, 0, 0]], // Flashing
  },
};

// Lua: SlotMachine.lua:1203 -- the cart's SlotsTilemap, read once.
//
// NOT FAITHFUL: the Lua reads assets/generated/slots/gold_slots.tilemap with
// love.filesystem.read. The guest has no binary file channel, so the bytes
// come from the dataset's "gold_slots.tilemap" table (an array of bytes, or a
// string of byte chars) when the cook ships one; without it the machine takes
// the Lua's own degrade (a cleared panel and labelled reel cells).
let TILEMAP: number[] | false | null = null;
function getTilemap(): number[] | null {
  if (TILEMAP === null) {
    TILEMAP = false;
    let raw: unknown;
    try {
      raw = loadGenerated("assets/generated/slots/gold_slots.tilemap");
    } catch {
      raw = undefined;
    }
    if (typeof raw === "string" && raw.length > 0) {
      TILEMAP = Array.from(raw, (ch) => ch.charCodeAt(0) & 0xff);
    } else if (raw && typeof (raw as ArrayLike<number>).length === "number" && (raw as ArrayLike<number>).length > 0) {
      TILEMAP = Array.from(raw as ArrayLike<number>);
    }
  }
  return TILEMAP || null;
}

/** Lua: SlotMachine.lua:1221 -- the placeholder 2x2 symbol cell. */
function cell(tx: number, ty: number, label: string): void {
  G.setColor(0, 0, 0, 1);
  G.rectangle("line", tx * 8, ty * 8, 16, 16);
  Chrome.print(label, tx, ty + 1);
}

export class SlotMachine {
  // Lua: SlotMachine.lua:53
  static isOpaque = true;
  isOpaque = true;

  static SEVEN = SEVEN;
  static POKEBALL = POKEBALL;
  static CHERRY = CHERRY;
  static PIKACHU = PIKACHU;
  static SQUIRTLE = SQUIRTLE;
  static STARYU = STARYU;
  static NO_MATCH = NO_MATCH;
  static NO_BIAS = NO_BIAS;
  static NAMES = NAMES;
  static LABELS = LABELS;
  static PAYOUTS = PAYOUTS;
  static payout = payout;
  static REEL_SIZE = REEL_SIZE;
  /** 0-based: REELS[0] is the Lua's REELS[1]. */
  static REELS = REELS;
  static window = window;
  static advance = advance;
  static LINES = LINES;
  static matchAll = matchAll;
  static matchFirstTwo = matchFirstTwo;
  static BIAS_NORMAL = BIAS_NORMAL;
  static BIAS_LUCKY = BIAS_LUCKY;
  static initBias = initBias;
  static rollKeepSevenChance = rollKeepSevenChance;
  static keepSevenBias = keepSevenBias;
  static MANIP_COUNTER = MANIP_COUNTER;
  static stopReel1 = stopReel1;
  static stopReel2 = stopReel2;
  static stopReel3 = stopReel3;
  static reel2SkipsToSeven = reel2SkipsToSeven;
  static spinReel2ToSevens = spinReel2ToSevens;
  static REEL3_STOP = REEL3_STOP;
  static REEL3_SLOW = REEL3_SLOW;
  static REEL3_GOLEM = REEL3_GOLEM;
  static REEL3_EGG = REEL3_EGG;
  static reel3Action = reel3Action;
  static slowAdvance = slowAdvance;
  static golemCount = golemCount;
  static EGG_DROP = EGG_DROP;
  static eggDrops = eggDrops;
  static spin = spin;
  static TEXTS = TEXTS;

  game: any;
  save: any;
  lucky: boolean;
  onClose?: () => void;
  random: Random;
  keepSevenChance: boolean;
  bias: number;
  payoutLeft: number;
  payoutTick = 0;
  /** Per reel, 0-based (the Lua's [1..3]). */
  positions: number[];
  distance: number[];
  rate: number[];
  stops: (number | null)[];
  stopped: (ReelWindow | undefined)[] | null = null;
  matched = NO_MATCH;
  matchingSevens = false;
  phase?: string;
  betIndex = 1;
  bet?: number;
  message?: StaticText | null;
  /** 1-based, the reel the next A press stops. */
  reel = 1;
  delay = 0;
  reel3Action?: string | null;
  golems?: number;
  golemAnim?: GolemAnim | null;
  chanseyAnim?: ChanseyAnim | null;
  reel2Pause?: number | null;
  flash = 0;
  againChoice = 1;
  ranOutDelay = 0;
  sheet1?: TileSheet;
  sheet2?: TileSheet;
  sheet3?: TileSheet;
  actorsLoaded?: LcdImage | false;
  [key: string]: any;

  /** Lua: SlotMachine.lua:686 */
  wantsFillScale(): boolean {
    return true;
  }

  /** Lua: SlotMachine.lua:687 */
  drawsWidescreen(): boolean {
    return true;
  }

  /** Lua: SlotMachine.lua:690 -- opts: save, lucky (wScriptVar on entry), random(n), onClose(). */
  static new(game: any, opts?: SlotMachineOpts): SlotMachine {
    return new SlotMachine(game, opts ?? {});
  }

  constructor(game: any, opts: SlotMachineOpts) {
    this.game = game;
    this.save = opts.save || (game && game.save);
    this.lucky = opts.lucky || false;
    this.onClose = opts.onClose;
    this.random = opts.random ?? ((n: number) => luaRandom(n) - 1);
    // .InitGFX's tail, rolled once for the whole visit.
    this.keepSevenChance = rollKeepSevenChance(this.random);
    this.bias = NO_BIAS;
    this.payoutLeft = 0;
    this.positions = [0, 0, 0];
    this.distance = [0, 0, 0];
    this.rate = [0, 0, 0];
    this.stops = [null, null, null];
    this.playMusic();
    this.enterInit();
  }

  /** Lua: SlotMachine.lua:716 */
  playMusic(): void {
    const data = this.game && this.game.data;
    if (!data) return;
    Music.play(data, "Music_GameCorner");
  }

  /** Lua: SlotMachine.lua:722 */
  sfx(name: string): void {
    const data = this.game && this.game.data;
    if (data) Sound.play(data, name);
  }

  /** Lua: SlotMachine.lua:727 */
  coins(): number {
    return CoinCase.coins(this.save);
  }

  /** Lua: SlotMachine.lua:734 -- SlotsAction_Init. */
  enterInit(): void {
    this.matched = NO_MATCH;
    this.matchingSevens = false;
    this.phase = "bet";
    this.betIndex = 1; // `db 1 ; default option`: the " 3" row
    this.message = null;
  }

  /** Lua: SlotMachine.lua:746 */
  updateBet(input: any): void {
    if (this.message) {
      if (input.wasPressed("a") || input.wasPressed("b")) this.message = null;
      return;
    }
    if (input.wasPressed("up")) {
      this.betIndex = this.betIndex > 1 ? this.betIndex - 1 : BET_ROWS.length;
    } else if (input.wasPressed("down")) {
      this.betIndex = this.betIndex < BET_ROWS.length ? this.betIndex + 1 : 1;
    } else if (input.wasPressed("b")) {
      // VerticalMenu's carry is SLOTS_QUIT.
      this.quit();
    } else if (input.wasPressed("a")) {
      const bet = 4 - this.betIndex;
      if (this.coins() < bet) {
        this.message = TEXTS.notEnough;
        return;
      }
      this.bet = bet;
      CoinCase.takeCoins(this.save, bet);
      this.sfx(SFX_PAY_DAY);
      this.startSpin();
    }
  }

  /**
   * Lua: SlotMachine.lua:777 -- SlotsAction_BetAndStart's tail: this spin's
   * bias, all reels at REEL_ACTION_NORMAL_RATE, 32 frames of wSlotsDelay.
   */
  startSpin(): void {
    this.bias = initBias(this.bias, this.lucky, this.random);
    this.phase = "spinning";
    this.reel = 1;
    this.delay = 32;
    this.message = TEXTS.start;
    this.stopped = null;
    this.matched = NO_MATCH;
    this.matchingSevens = false;
    this.reel3Action = null;
    this.golemAnim = null;
    this.chanseyAnim = null;
    this.reel2Pause = null;
    for (let i = 0; i < 3; i++) {
      this.rate[i] = 4; // ReelAction_NormalRate
      this.stops[i] = null;
      this.distance[i] = 0;
    }
    this.sfx(SFX_START);
  }

  /**
   * Lua: SlotMachine.lua:800 -- Slots_SpinReel, per reel per frame: the
   * position advances whenever 16 pixels are traversed.
   */
  spinReels(): void {
    for (let i = 1; i <= 3; i++) {
      const rate = this.rate[i - 1]!;
      if (rate > 0) {
        this.distance[i - 1] = (this.distance[i - 1] || 0) + rate;
        while (this.distance[i - 1]! >= 16) {
          this.distance[i - 1] = this.distance[i - 1]! - 16;
          this.positions[i - 1] = advance(this.positions[i - 1]!);
          // A reel with a resting slot chosen stops the moment it reaches it.
          if (this.stops[i - 1] != null && this.positions[i - 1] === this.stops[i - 1]) {
            this.rate[i - 1] = 0;
            this.distance[i - 1] = 0;
            this.stopped = this.stopped || [];
            this.stopped[i - 1] = window(REELS[i - 1]!, this.positions[i - 1]!);
            this.sfx(SFX_STOP);
            this.reelStopped(i);
            break;
          }
        }
      }
    }
  }

  /** Lua: SlotMachine.lua:826 -- the three symbols reel `i` (1-based) shows. */
  reelWindow(i: number): ReelWindow {
    return window(REELS[i - 1]!, this.positions[i - 1]!);
  }

  /**
   * Lua: SlotMachine.lua:832 -- SlotsAction_WaitReel1 / 2 / 3: A picks the
   * slot, and the reel turns to wherever the manipulation put it.
   */
  pressStop(): void {
    const i = this.reel;
    if (this.stops[i - 1] != null) return;
    const here = this.positions[i - 1]!;
    const bet = this.bet ?? 0;
    if (i === 1) {
      this.stops[0] = stopReel1(here, this.bias);
    } else if (i === 2) {
      const r1 = this.stopped![0]!;
      const hereWindow = window(REELS[1]!, here);
      const [, hereSevens] = matchFirstTwo(bet, r1, hereWindow);
      const doSkip = reel2SkipsToSeven(bet, this.bias, r1, this.random);
      if (hereSevens && !doSkip) {
        this.stops[1] = here;
      } else if (doSkip) {
        // ReelAction_SetUpReel2SkipTo7: a 32-frame pause, then double rate.
        this.stops[1] = spinReel2ToSevens(here, bet, r1);
        this.reel2Pause = 32;
        this.rate[1] = 0; // paused during the tell
      } else {
        this.stops[1] = stopReel2(here, this.bias, bet, r1);
      }
    } else {
      const r1 = this.stopped![0]!;
      const r2 = this.stopped![1]!;
      const [, sevens] = matchFirstTwo(bet, r1, r2);
      this.matchingSevens = sevens;
      const action = reel3Action(sevens, this.bias, this.random);
      this.reel3Action = action;
      if (action === REEL3_STOP) {
        this.stops[2] = stopReel3(here, this.bias, bet, r1, r2);
      } else if (action === REEL3_SLOW) {
        this.stops[2] = slowAdvance(here, this.bias, bet, r1, r2);
        this.rate[2] = 1; // ReelAction_QuarterRate slow crawl
      } else if (action === REEL3_GOLEM) {
        let count = golemCount(here, this.bias, bet, r1, r2, this.random);
        if (count === 0) count = 3;
        let target = here;
        for (let k = 0; k < count; k++) target = advance(target);
        this.stops[2] = target;
        this.golems = count;
        this.golemAnim = {
          count,
          state: "falling",
          var1: 48,
          x: 100,
          y: 44 - 112,
          animFrame: 0,
          animTimer: 0,
        };
        this.rate[2] = 0; // reel 3 stepped by each golem impact
      } else {
        const [target] = eggDrops(here, bet, r1, r2);
        this.stops[2] = target;
        this.chanseyAnim = {
          state: "walking",
          xcoord: 0,
          x: -24,
          y: 44,
          animTimer: 0,
          animPose: 0,
        };
        this.rate[2] = 0; // paused until Chansey drops the egg
      }
    }
    // A reel already on its resting slot has nowhere to turn (unless a tell
    // or a theatre is running).
    if (this.reel2Pause == null && !this.golemAnim && !this.chanseyAnim) {
      if (this.stops[i - 1] === this.positions[i - 1]) {
        this.rate[i - 1] = 0;
        this.distance[i - 1] = 0;
        this.stopped = this.stopped || [];
        this.stopped[i - 1] = this.reelWindow(i);
        this.sfx(SFX_STOP);
        this.reelStopped(i);
      }
    }
  }

  /** Lua: SlotMachine.lua:911 */
  reelStopped(i: number): void {
    if (i < 3) {
      this.reel = i + 1;
      return;
    }
    this.golemAnim = null;
    this.chanseyAnim = null;
    this.reel2Pause = null;
    // SlotsAction_FlashIfWin: a win flashes for 16 frames first.
    const s = this.stopped!;
    this.matched = matchAll(this.bet, s[0]!, s[1]!, s[2]!);
    if (this.matched === NO_MATCH) {
      this.phase = "payoutText";
      this.message = TEXTS.darn;
      return;
    }
    this.phase = "flash";
    this.flash = 16;
  }

  /** Lua: SlotMachine.lua:935 -- SlotsAction_GiveEarnedCoins / PayoutTextAndAnim. */
  beginPayout(): void {
    this.payoutLeft = payout(this.matched);
    this.payoutTick = 0;
    this.phase = "payoutText";
    this.message = linedUpLines(this.payoutLeft);
    if (this.matched === SEVEN) {
      this.sfx(SFX_SEVENS);
      // .LinedUpSevens: does the seven streak survive?
      if (!keepSevenBias(this.keepSevenChance, this.random)) this.bias = NO_BIAS;
    } else if (this.matched === POKEBALL) {
      this.sfx(SFX_POKEBALLS);
    } else {
      this.sfx(SFX_SMALL_WIN);
    }
  }

  /**
   * Lua: SlotMachine.lua:956 -- SlotsAction_PayoutAnim: one coin every other
   * frame.
   */
  updatePayoutAnim(): void {
    this.payoutTick = (this.payoutTick || 0) + 1;
    if (this.payoutTick % 2 === 1) return;
    if (this.payoutLeft <= 0) {
      this.phase = "again";
      return;
    }
    this.payoutLeft = this.payoutLeft - 1;
    CoinCase.giveCoins(this.save, 1);
    if (this.payoutTick % 8 === 0) this.sfx(SFX_COIN);
  }

  /** Lua: SlotMachine.lua:969 -- Slots_AskPlayAgain: no coins is the exit. */
  enterAgain(): void {
    if (this.coins() <= 0) {
      this.phase = "ranOut";
      this.message = TEXTS.ranOut;
      this.ranOutDelay = 60; // `ld c, 60 / call DelayFrames`
      return;
    }
    this.phase = "again";
    this.againChoice = 1;
    this.message = TEXTS.playAgain;
  }

  /** Lua: SlotMachine.lua:981 */
  quit(): void {
    this.phase = "quit";
    this.sfx(SFX_QUIT);
    const data = this.game && this.game.data;
    if (data) Music.restoreMap(data);
    if (this.onClose) this.onClose();
  }

  /** Lua: SlotMachine.lua:989 */
  update(_dt?: number): void {
    const input = this.game && this.game.input;
    if (!input) return;
    const phase = this.phase;

    if (phase === "bet") {
      this.updateBet(input);
      return;
    }

    if (phase === "spinning") {
      // SlotsAction_WaitStart clears hJoypadSum first.
      if ((this.delay || 0) > 0) {
        this.delay = this.delay - 1;
        this.spinReels();
        return;
      }
      if (this.reel2Pause != null && this.reel2Pause > 0) {
        this.reel2Pause = this.reel2Pause - 1;
        if (this.reel2Pause <= 0) {
          this.reel2Pause = null;
          this.rate[1] = 8; // resume fast-spin after the tell
        }
      }

      if (this.golemAnim) {
        const g = this.golemAnim;
        // animation frames every 8 ticks
        g.animTimer = (g.animTimer || 0) + 1;
        if (g.animTimer >= 8) {
          g.animTimer = 0;
          g.animFrame = ((g.animFrame || 0) + 1) % 4;
        }
        if (g.state === "falling") {
          if (g.var1 > 32) {
            g.var1 = g.var1 - 1;
            const angle = (g.var1 * Math.PI) / 32;
            const yOffset = Math.floor(112 * Math.sin(angle) + 0.5);
            g.y = 44 + yOffset;
            g.x = 100;
          } else {
            // Landed on reel 3
            g.y = 44;
            g.x = 100;
            g.state = "rolling";
            g.xoffset = 0;
            g.animTimer = 0;
            g.animFrame = 0;
            this.sfx("Sfx_PlacePuzzlePieceDown");
            // reel 3 advances one slot per Golem impact
            this.positions[2] = advance(this.positions[2]!);
            this.distance[2] = 0;
          }
        } else if (g.state === "rolling") {
          g.xoffset = (g.xoffset || 0) + 1;
          g.x = 100 - g.xoffset;
          if (g.xoffset >= 88) {
            g.count = g.count - 1;
            if (g.count > 0) {
              g.state = "falling";
              g.var1 = 48;
              g.x = 100;
              g.y = 44 - 112;
            } else {
              // All Golems finished; halt reel 3 at target
              this.golemAnim = null;
              this.rate[2] = 0;
              this.distance[2] = 0;
              this.stopped = this.stopped || [];
              this.stopped[2] = this.reelWindow(3);
              this.sfx(SFX_STOP);
              this.reelStopped(3);
            }
          }
        }
      }

      if (this.chanseyAnim) {
        const c = this.chanseyAnim;
        if (c.state === "walking") {
          c.xcoord = (c.xcoord || 0) + 1;
          c.x = c.xcoord - 24;
          c.y = 44;
          // walking poses 0..3 every 6 frames
          c.animTimer = (c.animTimer || 0) + 1;
          if (c.animTimer >= 6) {
            c.animTimer = 0;
            c.animPose = ((c.animPose || 0) + 1) % 4;
          }
          if (c.xcoord % 16 === 0) this.sfx("Sfx_JumpOverLedge");
          if (c.x >= 88) {
            // Reached reel 3: the tell pause (arm raised)
            c.x = 88;
            c.state = "egg_pause";
            c.delay = 14;
            c.animPose = 3;
          }
        } else if (c.state === "egg_pause") {
          c.delay = (c.delay ?? 14) - 1;
          if (c.delay <= 0) {
            c.animPose = 4;
            c.state = "egg_drop";
            c.eggTimer = 0;
            c.eggStartX = c.x + 14;
            c.eggStartY = c.y + 8;
            c.eggX = c.eggStartX;
            c.eggY = c.eggStartY;
            c.eggVisible = true;
            this.sfx("Sfx_Present");
          }
        } else if (c.state === "egg_drop") {
          c.eggTimer = (c.eggTimer || 0) + 1;
          let t = c.eggTimer / 16;
          if (t > 1) t = 1;
          c.eggX = c.eggStartX! + t * (108 - c.eggStartX!);
          c.eggY = c.eggStartY! + t * (56 - c.eggStartY!) - Math.sin(t * Math.PI) * 8;
          if (c.eggTimer >= 16) {
            // the egg lands on reel 3
            c.eggVisible = false;
            c.state = "spinning";
            this.sfx("Sfx_PlacePuzzlePieceDown");
            this.rate[2] = 16; // fast drop reel 3 to the jackpot
          }
        }
      }

      this.message = null;
      if (input.wasPressed("a")) {
        if (this.stops[this.reel - 1] == null && this.reel2Pause == null && !this.golemAnim && !this.chanseyAnim) {
          this.pressStop();
        }
      }
      this.spinReels();
      return;
    }

    if (phase === "flash") {
      this.flash = this.flash - 1;
      if (this.flash <= 0) this.beginPayout();
      return;
    }

    if (phase === "payoutText") {
      if (this.matched === NO_MATCH) {
        if (input.wasPressed("a") || input.wasPressed("b")) this.enterAgain();
        return;
      }
      this.updatePayoutAnim();
      if (this.phase === "again") this.enterAgain();
      return;
    }

    if (phase === "again") {
      if (input.wasPressed("up") || input.wasPressed("down")) {
        this.againChoice = this.againChoice === 1 ? 2 : 1;
        return;
      }
      if (input.wasPressed("b")) {
        this.quit();
        return;
      }
      if (input.wasPressed("a")) {
        if (this.againChoice === 1) this.enterInit();
        else this.quit();
      }
      return;
    }

    if (phase === "ranOut") {
      this.ranOutDelay = this.ranOutDelay - 1;
      if (this.ranOutDelay <= 0) this.quit();
    }
  }

  /** Lua: SlotMachine.lua:1228 */
  sheets(): [TileSheet, TileSheet, TileSheet] {
    if (this.sheet1 == null) {
      this.sheet1 = TileSheet.new({ path: "assets/generated/slots/gold_slots_1.png", wide: 2, firstTile: 0 });
      this.sheet2 = TileSheet.new({ path: "assets/generated/slots/gold_slots_2.png", wide: 2, firstTile: 0 });
      this.sheet3 = TileSheet.new({ path: "assets/generated/slots/gold_slots_3.png", wide: 3, firstTile: 0 });
    }
    return [this.sheet1, this.sheet2!, this.sheet3!];
  }

  /** Lua: SlotMachine.lua:1237 -- SlotsTilemap through _CGB_SlotMachine's attributes. */
  drawBackground(): void {
    const [s1, s2] = this.sheets();
    const tm = getTilemap();
    if (!tm || !s1.available()) {
      // Fallback simple background if assets unavailable
      Chrome.clear();
      return;
    }
    const bet = this.bet || 0;
    for (let ty = 0; ty <= 11; ty++) {
      for (let tx = 0; tx <= 19; tx++) {
        let tileId = tm[ty * 20 + tx] ?? 0;
        let pal = 0;
        if ((tx <= 2 || tx >= 17) && ty >= 2 && ty <= 11) {
          if (ty >= 6 && ty <= 7) pal = 4;
          else if (ty >= 4 && ty <= 9) pal = 3;
          else pal = 2;
        } else if (tx >= 4 && tx <= 15 && ty >= 2 && ty <= 3) {
          pal = 1; // Vileplume
        } else if ((tx === 3 || tx === 16) && ty >= 2 && ty <= 11) {
          let isLit = false;
          if (ty === 6 || ty === 7) isLit = bet >= 1;
          else if (ty === 4 || ty === 5 || ty === 8 || ty === 9) isLit = bet >= 2;
          else if (ty === 2 || ty === 3 || ty === 10 || ty === 11) isLit = bet >= 3;
          if (isLit) {
            pal = 1;
            // the lit lights tiles
            if (tileId === 0x23) tileId = 0x14;
            else if (tileId === 0x24) tileId = 0x15;
          } else {
            pal = 0;
          }
        }
        const colors = GBC_PALS.bg[pal];
        s1.palette = colors;
        s2.palette = colors;
        if (tileId < 0x25) s1.draw(tileId, tx, ty);
        else s2.draw(tileId - 0x25, tx, ty);
      }
    }
  }

  /**
   * Lua: SlotMachine.lua:1290 -- four consecutive 2x2 symbols per reel,
   * bottom to top, scrolled down by the reel's pixel distance.
   *
   * The reels are OAM on the cart (Slots_UpdateReelPositionAndOAM), so they
   * are objects here, clipped to the reel aperture (rows 4-9): a symbol tile
   * wholly behind the masking rows is not drawn at all. NOT FAITHFUL: a tile
   * straddling the aperture's edge is drawn whole and masked by the BG
   * priority of drawOverlays' rows, which lets it through those tiles'
   * colour-0 pixels where the Lua's opaque redraw hid it completely.
   */
  drawReels(): void {
    const [, s2] = this.sheets();
    G.push();
    G.intersectScissor(4 * 8, 4 * 8, 12 * 8, 6 * 8);
    const objects = G.objects;
    G.objects = true;
    for (let i = 0; i < 3; i++) {
      const strip = REELS[i]!;
      const pos = this.positions[i]!;
      let a = pos;
      if (a === 0) a = 0x0f;
      a = mod(a - 1, 16);
      const rx = REEL_X[i]! * 8;
      const dy = Math.floor(this.distance[i] || 0);
      for (let row = 0; row <= 3; row++) {
        const sym = strip[a + row];
        if (typeof sym !== "number") {
          cell(REEL_X[i]!, REEL_ROW[row]!, "?");
          continue;
        }
        const py = 64 - row * 16 + dy;
        const pal = GBC_PALS.obj[Math.floor(sym / 4)] || GBC_PALS.obj[0];
        s2.palette = pal;
        // sym + 0..3: top-left, top-right, bottom-left, bottom-right
        const t0 = s2.quad(sym + 0);
        const t1 = s2.quad(sym + 1);
        const t2 = s2.quad(sym + 2);
        const t3 = s2.quad(sym + 3);
        const img = s2.image();
        if (img && t0 && t1 && t2 && t3) {
          const drawSym = (): void => {
            G.draw(img, t0, rx, py);
            G.draw(img, t1, rx + 8, py);
            G.draw(img, t2, rx, py + 8);
            G.draw(img, t3, rx + 8, py + 8);
          };
          if (GbcPalette.available()) GbcPalette.with(pal, drawSym);
          else drawSym();
        } else {
          cell(REEL_X[i]!, REEL_ROW[row]!, LABELS[sym] ?? "?");
        }
      }
    }
    G.objects = objects;
    G.pop();
  }

  /** Lua: SlotMachine.lua:1345 -- the Golem / Chansey sheet (24x240). */
  actorsImage(): LcdImage | null {
    if (this.actorsLoaded === undefined) {
      let img: LcdImage | undefined;
      try {
        img = Assets.image("assets/generated/slots/gold_slots_actors.png");
      } catch {
        img = undefined;
      }
      if (!img) {
        try {
          img = Assets.image("assets/generated/slots/gold_slots_3.png");
        } catch {
          img = undefined;
        }
      }
      this.actorsLoaded = img || false;
      if (this.actorsLoaded) {
        // Y=0 Golem standing, 32 Golem ball, 64..160 Chansey steps 1-4,
        // 192 Chansey egg drop pose (24x32 each), 224 the egg (8x16).
        this.quadGolemStand = G.newQuad(0, 0, 24, 32, 24, 240);
        this.quadGolemBall = G.newQuad(0, 32, 24, 32, 24, 240);
        this.quadChansey1 = G.newQuad(0, 64, 24, 32, 24, 240);
        this.quadChansey2 = G.newQuad(0, 96, 24, 32, 24, 240);
        this.quadChansey3 = G.newQuad(0, 128, 24, 32, 24, 240);
        this.quadChansey4 = G.newQuad(0, 160, 24, 32, 24, 240);
        this.quadChanseyDrop = G.newQuad(0, 192, 24, 32, 24, 240);
        this.quadEgg = G.newQuad(0, 224, 8, 16, 24, 240);
      }
    }
    return this.actorsLoaded || null;
  }

  /**
   * Lua: SlotMachine.lua:1379 -- the Vileplume row (2-3) and the bottom
   * brackets (10-11) redrawn over the reels, then the theatre actors.
   *
   * The Lua masks by painting over the reels; on the Gold screen a cell can
   * only hide an object through BG priority, so these rows are drawn keyed
   * (GbcPalette.keyedWith) straight from the sheets rather than through
   * TileSheet.draw, whose GbcPalette.with would drop the priority. The
   * actors are objects (OAM on the cart).
   */
  drawOverlays(): void {
    const [s1, s2] = this.sheets();
    const tm = getTilemap();
    if (!tm || !s1.available()) return;

    // Solid backdrop over the header and footer between columns 4..15
    const keyed = G.keyed;
    G.keyed = true;
    G.setColor(198 / 255, 198 / 255, 74 / 255, 1);
    G.rectangle("fill", 4 * 8, 2 * 8, 12 * 8, 2 * 8);
    G.rectangle("fill", 4 * 8, 10 * 8, 12 * 8, 2 * 8);
    G.setColor(1, 1, 1, 1);
    G.keyed = keyed;

    for (const ty of [2, 3, 10, 11]) {
      for (let tx = 4; tx <= 15; tx++) {
        const tileId = tm[ty * 20 + tx] ?? 0;
        const pal = ty <= 3 ? 1 : 0;
        const colors = GBC_PALS.bg[pal];
        const sheet = tileId < 0x25 ? s1 : s2;
        const index = tileId < 0x25 ? tileId : tileId - 0x25;
        const img = sheet.image();
        const quad = sheet.quad(index);
        if (img && quad) GbcPalette.keyedWith(colors, () => G.draw(img, quad, tx * 8, ty * 8));
      }
    }

    const objects = G.objects;
    G.objects = true;
    // the Golem
    if (this.golemAnim) {
      const actors = this.actorsImage();
      const g = this.golemAnim;
      if (actors) {
        let quad = this.quadGolemBall;
        let scaleX = 1;
        let scaleY = 1;
        if (g.state === "falling") {
          quad = this.quadGolemBall;
        } else if (g.state === "rolling") {
          // Frameset_SlotsGolem: 0 standing, 1 ball, 2 standing y-flip, 3 ball x-flip
          const rotFrame = (g.animFrame || 0) % 4;
          if (rotFrame === 0) {
            quad = this.quadGolemStand;
          } else if (rotFrame === 1) {
            quad = this.quadGolemBall;
          } else if (rotFrame === 2) {
            quad = this.quadGolemStand;
            scaleY = -1;
          } else if (rotFrame === 3) {
            quad = this.quadGolemBall;
            scaleX = -1;
          }
        }
        G.setColor(1, 1, 1, 1);
        // drawn around its centre (ox=12, oy=16)
        const drawGolem = (): void => G.draw(actors, quad, Math.floor(g.x + 12), Math.floor(g.y + 16), 0, scaleX, scaleY, 12, 16);
        if (GbcPalette.available()) GbcPalette.with(GBC_PALS.obj[5], drawGolem);
        else drawGolem();
      }
    }

    // Chansey and the egg
    if (this.chanseyAnim) {
      const actors = this.actorsImage();
      const c = this.chanseyAnim;
      if (actors) {
        let quad = this.quadChansey1;
        if (c.state === "walking") {
          const walkCycle = [this.quadChansey1, this.quadChansey2, this.quadChansey3, this.quadChansey4];
          quad = walkCycle[(c.animPose || 0) % 4] || this.quadChansey1;
        } else if (c.state === "egg_pause") {
          quad = this.quadChansey4;
        } else if (c.state === "egg_drop" || c.state === "spinning") {
          quad = this.quadChanseyDrop;
        }
        G.setColor(1, 1, 1, 1);
        const drawChansey = (): void => {
          G.draw(actors, quad, Math.floor(c.x), Math.floor(c.y ?? 44));
          if (c.eggVisible && c.eggX != null && c.eggY != null) {
            G.draw(actors, this.quadEgg, Math.floor(c.eggX), Math.floor(c.eggY));
          }
        };
        if (GbcPalette.available()) GbcPalette.with(GBC_PALS.obj[6], drawChansey);
        else drawChansey();
      }
    }
    G.objects = objects;
  }

  /** Lua: SlotMachine.lua:1486 */
  drawMessage(): void {
    if (!this.message) return;
    Chrome.textbox(TEXT_BOX_X, TEXT_BOX_Y, TEXT_BOX_W - 2, TEXT_BOX_H - 2);
    localizedLines(this.message).forEach((line, i) => Chrome.print(line, TEXT_X, TEXT_Y + i * TEXT_LINE));
    if (this.matched != null && this.matched !== NO_MATCH && this.phase === "payoutText") {
      const [, s2] = this.sheets();
      const sym = this.matched;
      const pal = GBC_PALS.obj[Math.floor(sym / 4)] || GBC_PALS.obj[0];
      s2.palette = pal;
      const t0 = s2.quad(sym + 0);
      const t1 = s2.quad(sym + 1);
      const t2 = s2.quad(sym + 2);
      const t3 = s2.quad(sym + 3);
      const img = s2.image();
      const px = PAYOUT_SYMBOL_X * 8;
      const py = PAYOUT_SYMBOL_Y * 8;
      if (img && t0 && t1 && t2 && t3) {
        const drawWin = (): void => {
          G.setColor(1, 1, 1, 1);
          G.draw(img, t0, px, py);
          G.draw(img, t1, px + 8, py);
          G.draw(img, t2, px, py + 8);
          G.draw(img, t3, px + 8, py + 8);
        };
        G.setColor(1, 1, 1, 1);
        if (GbcPalette.available()) GbcPalette.with(pal, drawWin);
        else drawWin();
      } else {
        cell(PAYOUT_SYMBOL_X, PAYOUT_SYMBOL_Y, LABELS[sym] ?? "?");
      }
    }
  }

  /** Lua: SlotMachine.lua:1529 */
  drawPanel(): void {
    // The Lua's panel sits on a white letterbox (drawWidescreen); here the
    // panel is the screen, so the rows nothing else draws are cleared to it
    // rather than left as holes onto the 3D world.
    Chrome.clear();
    this.drawBackground();
    this.drawReels();
    this.drawOverlays();

    // PRINTNUM_LEADINGZEROS | 2 bytes, 4 digits, for both counters.
    Chrome.print(Chrome.number(this.coins(), 4, true), COINS_X, COINS_Y);
    Chrome.print(Chrome.number(this.payoutLeft || 0, 4, true), PAYOUT_X, PAYOUT_Y);

    if (this.phase === "bet") {
      // "Bet how many coins?"
      Chrome.textbox(0, 12, 12, 4);
      const lines = localizedLines(TEXTS.betHowMany);
      Chrome.print(lines[0] ?? "", 1, 14);
      Chrome.print(lines[1] ?? "", 1, 16);
      // the bet choices (14, 10 to 19, 17)
      Chrome.textbox(BET_BOX_X, BET_BOX_Y, BET_BOX_W - 2, BET_BOX_H - 2);
      BET_ROWS.forEach((label, i0) => {
        const ty = BET_LABEL_Y + i0 * BET_SPACING;
        if (i0 + 1 === this.betIndex) Chrome.cursor(BET_LABEL_X - 1, ty);
        Chrome.print(label, BET_LABEL_X, ty);
      });
      if (this.message) {
        // "Not enough coins." over the full speech box
        Chrome.textbox(0, 12, 18, 4);
        localizedLines(this.message).forEach((line, i) => Chrome.print(line, TEXT_X, TEXT_Y + i * TEXT_LINE));
      }
    } else if (this.phase === "again") {
      // "Play again?"
      Chrome.textbox(0, 12, 18, 4);
      Chrome.print(localizedLines(TEXTS.playAgain)[0] ?? "", TEXT_X, TEXT_Y);
      // PlaceYesNoBox at (14, 12): YES at (16,13), NO at (16,15)
      Chrome.textbox(14, 12, 4, 3);
      Chrome.print(Strings.get("YES"), 16, 13);
      Chrome.print(Strings.get("NO"), 16, 15);
      Chrome.cursor(15, 13 + (this.againChoice - 1) * 2);
    } else {
      this.drawMessage();
    }
  }

  /** Lua: SlotMachine.lua:1575 */
  draw(): void {
    this.drawPanel();
  }

  /** Lua: SlotMachine.lua:1579 */
  drawWidescreen(winW: number, winH: number): void {
    Chrome.letterbox(winW, winH, 1, 1, 1);
    const scale = Chrome.fitScale();
    G.push();
    const [ox, oy] = Chrome.fitOrigin();
    G.translate(ox, oy);
    G.scale(scale, scale);
    this.drawPanel();
    G.pop();
  }
}

export default SlotMachine;
