// The Gen 2 battle-animation BACKGROUND effects: a port of gen1recomp
// src/battle/gen2/BgEffects.lua (bdfac727, MIT).
//
// pokegold engine/battle_anims/bg_effects.asm: five concurrent structs, each
// of {function, jumptable index, battle turn, param}, and a jumptable of 53
// effects that between them do all the shaking, flashing and sinking a Gen 2
// battle animation is made of.  Objects (battle/AnimObjects.ts) are
// OBJs; these are the BG layer.
//
// The one mechanism worth understanding before reading any of it: almost
// nothing here moves a sprite.  It writes wLYOverridesBackup, a per-scanline
// value the LCD STAT interrupt copies into rSCX, rSCY or rBGP as the beam
// passes.  BattleBGEffect_SetLCDStatCustoms1 picks the window -- scanlines
// $00-$36 for the enemy's pic, $2f-$5e for the player's -- so "shake the
// attacker" is "write the same SCX to every scanline the attacker occupies".
//
// The port keeps that literally: `lyBackup` is 144 bytes, `lcdc` names the
// register they land in, and src/ui/gen2/BattleAnimView.lua draws the BG layer
// one scanline band at a time.  Modelling it as "move the mon pic" instead
// would work for Tackle and then fall apart on Withdraw and Dig, which push a
// GROWING number of rows off and leave the rest where they are.
//
// Love-free, like AnimObjects.

import { AnimObjects, type AnimEnv } from "./AnimObjects.ts";
import { truthy } from "../platform/lua.ts";

// Lua: BgEffects.lua:27-29 takes these off AnimObjects at load time; here they
// are looked up at call time so the sibling module (and the SpriteAnims sine
// it re-exports) is never touched at module top level.
const u8 = (value: number): number => AnimObjects.u8(value);
const swap = (value: number): number => AnimObjects.swap(value);
const sine = (angle: number, amplitude: number): number => AnimObjects.sine(angle, amplitude);
const cosine = (angle: number, amplitude: number): number => AnimObjects.cosine(angle, amplitude);

const NUM_EFFECTS = 5; // NUM_BG_EFFECTS
const SCREEN_ROWS = 0x90; // wLYOverridesBackup is $91 bytes

// `dc a, b, c, d` packs four 2-bit shades into a DMG palette byte, high pair
// first: `dc 3, 2, 1, 0` is %11100100 = $e4, the identity ramp.
// Lua: BgEffects.lua:38
function dc(a: number, b: number, c: number, d: number): number {
  return a * 64 + b * 16 + c * 4 + d;
}

const NORMAL_PAL = dc(3, 2, 1, 0);

/** The register hLCDCPointer aims the per-scanline values at (nil: none). */
export type LcdcTarget = "SCX" | "SCY" | "BGP";
export type BattlerSide = "player" | "enemy";

/** One BG-effect struct. `func` is the effect name (or the raw id when the order list lacks it). */
export interface BgEffect {
  func: string | number | undefined;
  jt: number;
  turn: number;
  param: number;
  side: BattlerSide | undefined;
}

/** What the battle screen owns and both pools read (AnimRunner builds it): AnimObjects' env. */
export type { AnimEnv };

/** An object a BG effect asks the object pool to spawn. */
export interface BgSpawn {
  object: string | number;
  x: number;
  y: number;
  param: number;
}

// Lua: BgEffects.lua:47
function newEffect(): BgEffect {
  return { func: undefined, jt: 0, turn: 0, param: 0, side: undefined };
}

type EffectFn = (self: BgEffectsPool, st: BgEffect) => void;

//--------------------------------------------------------------------------

/** BgEffects.lua's local `Pool` metatable class. */
export class BgEffectsPool {
  static SURF_WAVE_LENGTH = 0x40;

  env: AnimEnv;
  effects: BgEffect[] = [];
  order: (string | number)[];
  scx = 0;
  scy = 0;
  lcdc: LcdcTarget | undefined = undefined;
  lyStart = 0;
  lyEnd = 0;
  /** Indexed 0..SCREEN_ROWS, as in the Lua (which was already 0-based here). */
  lyBackup: number[] = [];
  bgp = NORMAL_PAL;
  obp0 = NORMAL_PAL;
  obp1 = NORMAL_PAL;
  monShade: Record<BattlerSide, number> = { player: NORMAL_PAL, enemy: NORMAL_PAL };
  hidden: Record<BattlerSide, boolean> = { player: false, enemy: false };
  liftedRows: Record<BattlerSide, number[] | undefined> = { player: undefined, enemy: undefined };
  picSize: Record<BattlerSide, number | undefined> = { player: undefined, enemy: undefined };
  slide: Record<BattlerSide, number> = { player: 0, enemy: 0 };
  /** Indexed 0..SURF_WAVE_LENGTH-1, as in the Lua. */
  surfWave: number[] | undefined = undefined;
  spawns: BgSpawn[] = [];
  /** Set by BATTLE_BG_EFFECT_ROLLOUT; never cleared by reset(), as in the Lua. */
  rolloutYOffset: number | undefined = undefined;

  // `env` is shared with the object pool: env.battleTurn is hBattleTurn, and
  // env.flying tells BGEffect_CheckFlyDigStatus whether the battler in question
  // is mid-Fly or mid-Dig (in which case ShowMon and the battler-pic objects
  // decline to draw a mon that is not on the field).
  // Lua: BgEffects.lua:55
  constructor(constants?: Record<string, any>, env?: AnimEnv) {
    this.env = env ?? {};
    for (let slot = 0; slot < NUM_EFFECTS; slot++) this.effects[slot] = newEffect();
    this.order = (constants ?? {}).battleBgEffectOrder ?? [];
    this.reset();
  }

  // Lua: BgEffects.lua:65
  reset(): void {
    for (let slot = 0; slot < NUM_EFFECTS; slot++) this.effects[slot] = newEffect();
    // hSCX / hSCY: a whole-screen scroll, which is what the screen shakes use.
    this.scx = 0;
    this.scy = 0;
    // hLCDCPointer plus its window, and the per-scanline values themselves.
    this.lcdc = undefined;
    this.lyStart = 0;
    this.lyEnd = 0;
    this.lyBackup = [];
    for (let row = 0; row <= SCREEN_ROWS; row++) this.lyBackup[row] = 0;
    // wBGP / wOBP0 / wOBP1, as DMG palette bytes.
    this.bgp = NORMAL_PAL;
    this.obp0 = NORMAL_PAL;
    this.obp1 = NORMAL_PAL;
    // Per-battler state the CGB paths write instead of touching wBGP: shade
    // byte, hidden flag, lifted tile rows, and which BG square it is drawn at.
    this.monShade = { player: NORMAL_PAL, enemy: NORMAL_PAL };
    this.hidden = { player: false, enemy: false };
    this.liftedRows = { player: undefined, enemy: undefined };
    this.picSize = { player: undefined, enemy: undefined };
    this.slide = { player: 0, enemy: 0 };
    // wSurfWaveBGEffect: the $40-byte rolling wave Surf keeps beside the
    // overrides.  nil until InitSurfWaves lays one down.
    this.surfWave = undefined;
    // The objects a BG effect asks the object pool to spawn, drained by the
    // runner after each frame.
    this.spawns = [];
  }

  // Lua: BgEffects.lua:90
  activeCount(): number {
    let count = 0;
    for (let slot = 0; slot < NUM_EFFECTS; slot++) {
      if (this.effects[slot]!.func != null) count++;
    }
    return count;
  }

  /** Lua `self.order[effectId + 1] or effectId` (the order list is 0-based here). */
  private effectName(effectId: string | number): string | number {
    if (typeof effectId === "number") return this.order[effectId] ?? effectId;
    return effectId;
  }

  // QueueBGEffect: first free struct wins; a full pool silently drops the
  // request, which is exactly what the carry return means to the caller.
  // Lua: BgEffects.lua:100
  queue(effectId: string | number, jumptableIndex?: number, turn?: number, param?: number): BgEffect | undefined {
    const name = this.effectName(effectId);
    for (let slot = 0; slot < NUM_EFFECTS; slot++) {
      const st = this.effects[slot]!;
      if (st.func == null) {
        st.func = name;
        st.jt = u8(jumptableIndex ?? 0);
        st.turn = u8(turn ?? 0);
        st.param = u8(param ?? 0);
        st.side = undefined;
        return st;
      }
    }
    return undefined;
  }

  // BattleAnimCmd_IncBGEffect: bump the jumptable index of the first struct
  // running this effect.
  // Lua: BgEffects.lua:121
  incEffect(effectId: string | number): BgEffect | undefined {
    const name = this.effectName(effectId);
    for (let slot = 0; slot < NUM_EFFECTS; slot++) {
      const st = this.effects[slot]!;
      if (st.func === name) {
        st.jt = u8(st.jt + 1);
        return st;
      }
    }
    return undefined;
  }

  //------------------------------------------------------------------------
  // Shared helpers
  //------------------------------------------------------------------------

  // BGEffect_CheckBattleTurn: non-zero means "the side this effect is aimed at
  // is the player's".  A struct's `turn` is BG_EFFECT_USER / BG_EFFECT_TARGET,
  // so the same effect id follows whichever battler is attacking.
  // Lua: BgEffects.lua:146
  playerSide(st: BgEffect): boolean {
    return (((this.env.battleTurn ?? 0) & 1) ^ st.turn) !== 0;
  }

  // Lua: BgEffects.lua:150
  sideKey(st: BgEffect): BattlerSide {
    return this.playerSide(st) ? "player" : "enemy";
  }

  // BGEffect_CheckFlyDigStatus: zero means "on the field".
  // Lua: BgEffects.lua:155
  flyDig(st: BgEffect): boolean {
    const flying = this.env.flying ?? {};
    return truthy(flying[this.sideKey(st)]);
  }

  // Lua: BgEffects.lua:160
  clearLYOverrides(value = 0): void {
    for (let row = 0; row <= SCREEN_ROWS; row++) this.lyBackup[row] = value;
  }

  // BattleBGEffect_SetLCDStatCustoms1: the window is the attacker's pic rows.
  // Lua: BgEffects.lua:166
  setLCDStatCustoms1(register: LcdcTarget, st: BgEffect): void {
    this.lcdc = register;
    if (this.playerSide(st)) {
      this.lyStart = 0x2f;
      this.lyEnd = 0x5e;
    } else {
      this.lyStart = 0x00;
      this.lyEnd = 0x36;
    }
  }

  // engine/battle_anims/bg_effects.asm:2671
  // Lua: BgEffects.lua:176
  setLCDStatCustoms2(register: LcdcTarget, st: BgEffect): void {
    this.lcdc = register;
    if (this.playerSide(st)) {
      this.lyStart = 0x2d;
      this.lyEnd = 0x5e;
    } else {
      this.lyStart = 0x00;
      this.lyEnd = 0x36;
    }
  }

  // Lua: BgEffects.lua:185
  resetLCDStatCustom(st: BgEffect): void {
    this.lyStart = 0;
    this.lyEnd = 0;
    this.clearLYOverrides(0);
    this.lcdc = undefined;
    endEffect(st);
  }

  // Lua: BgEffects.lua:192
  resetVideoHRAM(): void {
    this.lcdc = undefined;
    this.bgp = NORMAL_PAL;
    this.obp1 = NORMAL_PAL;
    this.lyStart = 0;
    this.lyEnd = 0;
    this.clearLYOverrides(0);
  }

  // BGEffect_FillLYOverridesBackup: the same value on every scanline in the
  // window.  `dec d; jr nz` after the first store, so a zero-width window would
  // run 256 times; the port refuses instead of wrapping the array.
  // Lua: BgEffects.lua:202
  fillLY(value: number): void {
    let count = u8(this.lyEnd - this.lyStart);
    if (count === 0) count = 256;
    for (let i = 0; i < count; i++) {
      const row = this.lyStart + i;
      if (row > SCREEN_ROWS) break;
      this.lyBackup[row] = u8(value);
    }
  }

  // BGEffect_DisplaceLYOverridesBackup: the first `a` scanlines of the window
  // are scrolled to a blank part of the map ($90) and the rest are pushed down
  // by a + 1.  That is what makes Withdraw and Dig look like the mon sinking
  // rather than sliding.
  // Lua: BgEffects.lua:216
  displaceLY(a: number): void {
    a = u8(a);
    const span = u8(this.lyEnd - this.lyStart);
    const rest = u8(span - a);
    let row = this.lyStart;
    for (let n = a === 0 ? 256 : a; n > 0; n--) {
      if (row > SCREEN_ROWS) return;
      this.lyBackup[row] = 0x90;
      row++;
    }
    const pushed = u8(0xff - a);
    for (let n = rest === 0 ? 256 : rest; n > 0; n--) {
      if (row > SCREEN_ROWS) return;
      this.lyBackup[row] = pushed;
      row++;
    }
  }

  // DeformScreen: a standing sine wave down the window.  It walks the FIRST
  // $80 entries of wLYOverridesBackup by their low address byte and writes only
  // the ones inside the window -- `cp c / jr nc` skips while lyStart >= c and
  // `cp c / jr c` skips once lyEnd < c, so the row written is strictly
  // lyStart < row <= lyEnd -- but the phase advances on EVERY iteration, window
  // or not.  So where the window sits decides which part of the wave lands on
  // it, and two effects with the same amplitude and offset but different
  // windows do not look alike.
  //
  // `lb de, d, e` puts the AMPLITUDE in d and the phase step in e.
  // Lua: BgEffects.lua:244
  deformScreen(amplitude: number, offset: number): void {
    let progress = 0;
    for (let row = 0; row <= 0x7f; row++) {
      if (this.lyStart < row && row <= this.lyEnd && row <= SCREEN_ROWS) {
        this.lyBackup[row] = sine(progress, amplitude);
      }
      progress = u8(progress + offset);
    }
  }

  // InitSurfWaves: the same wave, into the $40-byte wSurfWaveBGEffect ring
  // rather than the overrides themselves.  Surf rotates that ring a step a frame
  // and copies it out, which is what makes the water ROLL instead of standing
  // still the way DeformScreen's does.
  // Lua: BgEffects.lua:260
  initSurfWaves(amplitude: number, offset: number): void {
    let progress = 0;
    this.surfWave = [];
    for (let index = 0; index < BgEffectsPool.SURF_WAVE_LENGTH; index++) {
      this.surfWave[index] = sine(progress, amplitude);
      progress = u8(progress + offset);
    }
  }

  // BattleBGEffect_Surf's `.RotatewSurfWaveBGEffect`: rotate the ring left one,
  // then paint scanlines $00-$5e from it -- zero at and below lyStart, the ring
  // (wrapping every $40 rows) above it.  The ring index advances on every
  // scanline including the zeroed ones, so the wave keeps its phase across the
  // boundary.
  // Lua: BgEffects.lua:274
  rotateSurfWave(): void {
    const wave = this.surfWave;
    if (!wave) return;
    const first = wave[0]!;
    for (let index = 0; index <= BgEffectsPool.SURF_WAVE_LENGTH - 2; index++) {
      wave[index] = wave[index + 1]!;
    }
    wave[BgEffectsPool.SURF_WAVE_LENGTH - 1] = first;
    let ring = 0;
    for (let row = 0; row <= 0x5e; row++) {
      let value = 0;
      if (this.lyStart < row) value = wave[ring]!;
      if (row <= SCREEN_ROWS) this.lyBackup[row] = u8(value);
      ring = (ring + 1) & (BgEffectsPool.SURF_WAVE_LENGTH - 1);
    }
  }

  // DeformWater: `count` PAIRS of scanlines either side of a centre at
  // lyStart + `progress`, each pair taking the next step of a sine whose angle
  // climbs by 4 a pair.  Both walkers start on the centre row, so it is written
  // twice and the figure is symmetric about it.  The two bounds checks are not
  // the same test: the downward walker stops once lyEnd < its row, the upward
  // one once lyStart >= its row.
  // Lua: BgEffects.lua:297
  deformWater(count: number, amplitude: number, offset: number, progress?: number): void {
    let down = this.lyStart + (progress ?? 0);
    let up = down;
    let angle = u8(offset);
    for (let n = u8(count); n > 0; n--) {
      const value = sine(angle, amplitude);
      if (this.lyEnd >= down) {
        if (down >= 0 && down <= SCREEN_ROWS) this.lyBackup[down] = value;
        down++;
      }
      if (this.lyStart < up) {
        if (up >= 0 && up <= SCREEN_ROWS) this.lyBackup[up] = value;
        up--;
      }
      angle = u8(angle + 4);
    }
  }

  // BattleBGEffect_WavyScreenFX: rotate the window's overrides up one row, the
  // old top row wrapping around to the bottom.  Every wobble effect is
  // DeformScreen once to lay the wave down and then this, once a frame, to make
  // it travel.
  // Lua: BgEffects.lua:319
  wavyScreenFX(): void {
    const span = u8(this.lyEnd - this.lyStart);
    if (span === 0) return;
    const first = this.lyBackup[this.lyStart] ?? 0;
    for (let i = 0; i < span; i++) {
      const row = this.lyStart + i;
      if (row > SCREEN_ROWS) break;
      this.lyBackup[row] = this.lyBackup[row + 1] ?? 0;
    }
    const last = this.lyStart + span;
    if (last <= SCREEN_ROWS) this.lyBackup[last] = first;
  }

  //------------------------------------------------------------------------

  // ExecuteBGEffects: one pass over the five structs.
  // Lua: BgEffects.lua:1342
  playFrame(): void {
    for (let slot = 0; slot < NUM_EFFECTS; slot++) {
      const st = this.effects[slot]!;
      if (st.func != null) {
        const fn = typeof st.func === "string" ? E[st.func] : undefined;
        if (fn) {
          fn(this, st);
        } else {
          // An id with no entry would otherwise sit in the pool forever and
          // keep the animation from ending.
          dropUnknown(st);
        }
      }
    }
  }

  // Lua: BgEffects.lua:1358
  takeSpawns(): BgSpawn[] {
    const spawns = this.spawns;
    this.spawns = [];
    return spawns;
  }
}

//--------------------------------------------------------------------------
// Shared helpers
//--------------------------------------------------------------------------

// Lua: BgEffects.lua:140
function endEffect(st: BgEffect): void {
  st.func = undefined;
}
// Lua: BgEffects.lua:141
function incJt(st: BgEffect): void {
  st.jt = u8(st.jt + 1);
}

/** A `dc` list: DMG palette bytes, $ff ending it and $fe rewinding it. */
type PalList = readonly number[];

// BattleBGEffect_GetFirstDMGPal / GetNextDMGPal walking a `dc` list.
// $ff ends the effect (returns nil); $fe restarts the list from the top.
// Lua: BgEffects.lua:334
function nextPal(st: BgEffect, pals: PalList): number | undefined {
  const index = st.param;
  st.param = u8(st.param + 1);
  let value = pals[index];
  if (value === undefined || value === 0xff) return undefined;
  if (value === 0xfe) {
    // Rewind and hand back the list's first entry.
    st.param = 0;
    value = pals[0];
  }
  return value;
}

// BattleBGEffect_GetNthDMGPal: JT doubles as a per-step frame counter, and it
// is reloaded from the struct's `turn` -- so the SAME field is the flash speed
// here and the battler side everywhere else.
// Lua: BgEffects.lua:350
function nthPal(st: BgEffect, pals: PalList): number | undefined {
  if (st.jt !== 0) {
    st.jt = st.jt - 1;
    const index = st.param;
    let value = pals[index];
    if (value === undefined || value === 0xff) return undefined;
    if (value === 0xfe) {
      st.param = 0;
      value = pals[0];
    }
    return value;
  }
  st.jt = st.turn;
  return nextPal(st, pals);
}

//--------------------------------------------------------------------------
// The effects (BattleBGEffects jumptable)
//--------------------------------------------------------------------------

const E: Record<string, EffectFn> = {};

// Lua: BgEffects.lua:372
E.BATTLE_BG_EFFECT_END = (_self, st) => endEffect(st);

// BattleBGEffect_FlashContinue: `turn` is the flash duration, `param` the
// number of flashes left, and the two palettes alternate.
// Lua: BgEffects.lua:376
function flash(self: BgEffectsPool, st: BgEffect, pals: PalList): void {
  if (st.jt !== 0) {
    st.jt = st.jt - 1;
    return;
  }
  st.jt = st.turn;
  if (st.param === 0) {
    endEffect(st);
    return;
  }
  st.param = u8(st.param - 1);
  self.bgp = pals[st.param & 1]!;
}

// Lua: BgEffects.lua:390
E.BATTLE_BG_EFFECT_FLASH_INVERTED = (self, st) => {
  flash(self, st, [dc(3, 2, 1, 0), dc(0, 1, 2, 3)]);
};

// Lua: BgEffects.lua:394
E.BATTLE_BG_EFFECT_FLASH_WHITE = (self, st) => {
  flash(self, st, [dc(3, 2, 1, 0), dc(0, 0, 0, 0)]);
};

const WHITE_HUES: PalList = [dc(3, 2, 1, 0), dc(3, 2, 0, 0), dc(3, 1, 0, 0), 0xff];
const BLACK_HUES: PalList = [dc(3, 2, 1, 0), dc(3, 3, 1, 0), dc(3, 3, 2, 0), 0xff];
const ALTERNATE_HUES: PalList = [
  dc(3, 2, 1, 0), dc(3, 3, 2, 0), dc(3, 3, 3, 0), dc(3, 3, 2, 0),
  dc(3, 2, 1, 0), dc(2, 1, 0, 0), dc(1, 0, 0, 0), dc(2, 1, 0, 0), 0xfe,
];

// Lua: BgEffects.lua:405
E.BATTLE_BG_EFFECT_WHITE_HUES = (self, st) => {
  const value = nthPal(st, WHITE_HUES);
  if (value === undefined) {
    endEffect(st);
    return;
  }
  self.bgp = value;
};

// Lua: BgEffects.lua:414
E.BATTLE_BG_EFFECT_BLACK_HUES = (self, st) => {
  const value = nthPal(st, BLACK_HUES);
  if (value === undefined) {
    endEffect(st);
    return;
  }
  self.bgp = value;
};

// Lua: BgEffects.lua:423
E.BATTLE_BG_EFFECT_ALTERNATE_HUES = (self, st) => {
  const value = nthPal(st, ALTERNATE_HUES);
  if (value === undefined) {
    endEffect(st);
    return;
  }
  self.bgp = value;
  self.obp1 = value;
};

const OB_GRAY_YELLOW: PalList = [dc(3, 2, 1, 0), dc(2, 1, 0, 0), 0xfe];
const OB_MID_GRAY_YELLOW: PalList = [dc(3, 2, 1, 0), dc(3, 1, 2, 0), 0xfe];
const BG_INVERTED: PalList = [dc(0, 1, 2, 3), dc(1, 2, 0, 3), dc(2, 0, 1, 3), 0xfe];

// Lua: BgEffects.lua:436
E.BATTLE_BG_EFFECT_CYCLE_OBPALS_GRAY_AND_YELLOW = (self, st) => {
  const value = nthPal(st, OB_GRAY_YELLOW);
  if (value !== undefined) self.obp0 = value;
};

// Lua: BgEffects.lua:441
E.BATTLE_BG_EFFECT_CYCLE_MID_OBPALS_GRAY_AND_YELLOW = (self, st) => {
  const value = nthPal(st, OB_MID_GRAY_YELLOW);
  if (value !== undefined) self.obp0 = value;
};

// Lua: BgEffects.lua:446
E.BATTLE_BG_EFFECT_CYCLE_BGPALS_INVERTED = (self, st) => {
  const value = nthPal(st, BG_INVERTED);
  if (value !== undefined) self.bgp = value;
};

// engine/battle_anims/bg_effects.asm:343
// Lua: BgEffects.lua:452
E.BATTLE_BG_EFFECT_HIDE_MON = (self, st) => {
  const jt = st.jt;
  if (jt === 0) {
    incJt(st);
    self.hidden[self.sideKey(st)] = true;
  } else if (jt >= 1 && jt <= 3) {
    incJt(st);
  } else if (jt === 4) {
    endEffect(st);
  }
};

// BattleBGEffect_RunPicResizeScript: rows of {size, base tile, coord slot},
// $ff ending, $fe clearing a box, $fd skipping the draw.  The sizes are the
// six BG squares (6x6, 4x4, 2x2 for the player; 7x7, 5x5, 3x3 for the enemy),
// which is how a mon grows into or shrinks out of the field.  Only the size
// matters to this port -- the tile ids and the coord slot are the same pic in
// the same box -- so the script is followed for its TIMING and its scale.
// (0-based here: the Lua's script[param + 1] is script[param].)
const PIC_RESIZE: Record<string, readonly (number | false)[]> = {
  // BattleBGEffect_ShowMon
  showPlayer: [0],
  showEnemy: [3],
  // BattleBGEffect_EnterMon
  enterPlayer: [2, 1, 0],
  enterEnemy: [5, 4, 3],
  // BattleBGEffect_ReturnMon: each step is preceded by a box clear, which is
  // the -2 row, and the last -3 row leaves the field empty.
  returnPlayer: [0, 1, 2, false],
  returnEnemy: [3, 4, 5, false],
};

// Lua: BgEffects.lua:483
function runPicResize(self: BgEffectsPool, st: BgEffect, script: readonly (number | false)[]): void {
  const side = self.sideKey(st);
  const jt = st.jt;
  if (jt === 0) {
    const step = script[st.param];
    st.param = u8(st.param + 1);
    if (step === undefined) {
      self.picSize[side] = undefined;
      endEffect(st);
      return;
    }
    if (step === false) {
      self.picSize[side] = undefined;
      self.hidden[side] = true;
    } else {
      self.picSize[side] = step;
      self.hidden[side] = false;
    }
    self.liftedRows[side] = undefined;
    incJt(st);
  } else if (jt >= 1 && jt <= 2) {
    incJt(st);
  } else if (jt === 3) {
    st.jt = 0;
  } else if (jt === 4) {
    self.picSize[side] = undefined;
    endEffect(st);
  }
}

// Lua: BgEffects.lua:513
E.BATTLE_BG_EFFECT_SHOW_MON = (self, st) => {
  if (self.flyDig(st)) {
    endEffect(st);
    return;
  }
  runPicResize(self, st, self.playerSide(st) ? PIC_RESIZE.showPlayer! : PIC_RESIZE.showEnemy!);
};

// Lua: BgEffects.lua:522
E.BATTLE_BG_EFFECT_ENTER_MON = (self, st) => {
  runPicResize(self, st, self.playerSide(st) ? PIC_RESIZE.enterPlayer! : PIC_RESIZE.enterEnemy!);
};

// Lua: BgEffects.lua:527
E.BATTLE_BG_EFFECT_RETURN_MON = (self, st) => {
  runPicResize(self, st, self.playerSide(st) ? PIC_RESIZE.returnPlayer! : PIC_RESIZE.returnEnemy!);
};

// BattleBGEffect_RemoveMon slides the pic's tilemap one column a frame
// towards the edge it came from, eight or nine columns' worth.
// Lua: BgEffects.lua:534
E.BATTLE_BG_EFFECT_REMOVE_MON = (self, st) => {
  const side = self.sideKey(st);
  const jt = st.jt;
  if (jt === 0) {
    incJt(st);
    st.param = self.playerSide(st) ? 9 : 8;
  } else if (jt === 1) {
    self.slide[side] = self.slide[side] + (self.playerSide(st) ? -8 : 8);
    incJt(st);
    st.param = u8(st.param - 1);
  } else if (jt === 2 || jt === 3) {
    incJt(st);
  } else if (jt === 4) {
    if (st.param === 0) {
      self.slide[side] = 0;
      self.hidden[side] = true;
      endEffect(st);
      return;
    }
    st.jt = 1;
  }
};

// The two battler-pic objects: the animation borrows the mon's own tiles as
// an OBJ so it can be moved without touching the tilemap.
// Lua: BgEffects.lua:559
function battlerObj(
  self: BgEffectsPool,
  st: BgEffect,
  objectPlayer: string,
  objectEnemy: string,
  rows: Record<BattlerSide, number[]>,
): void {
  const jt = st.jt;
  if (jt === 0) {
    if (self.flyDig(st)) {
      endEffect(st);
      return;
    }
    incJt(st);
    const player = self.playerSide(st);
    self.spawns.push({
      object: player ? objectPlayer : objectEnemy,
      x: player ? 6 * 8 : 16 * 8 + 4,
      y: 8 * 8,
      param: 0,
    });
  } else if (jt === 1) {
    incJt(st);
    // engine/battle_anims/bg_effects.asm:448-465: the rows the OBJ now covers
    // come out of the tilemap, and .five never puts them back.
    self.liftedRows[self.sideKey(st)] = rows[self.sideKey(st)];
  } else if (jt >= 2 && jt <= 4) {
    incJt(st);
  } else if (jt === 5) {
    endEffect(st);
  }
}

// Lua: BgEffects.lua:586
E.BATTLE_BG_EFFECT_BATTLEROBJ_1ROW = (self, st) => {
  battlerObj(self, st, "BATTLE_ANIM_OBJ_PLAYERHEAD_1ROW", "BATTLE_ANIM_OBJ_ENEMYFEET_1ROW", {
    player: [0, 1],
    enemy: [6, 1],
  });
};

// Lua: BgEffects.lua:592
E.BATTLE_BG_EFFECT_BATTLEROBJ_2ROW = (self, st) => {
  battlerObj(self, st, "BATTLE_ANIM_OBJ_PLAYERHEAD_2ROW", "BATTLE_ANIM_OBJ_ENEMYFEET_2ROW", {
    player: [0, 2],
    enemy: [5, 2],
  });
};

// BGEffect_RapidCyclePals.  On a CGB the palette is applied to ONE battler
// (the struct's side) rather than to the whole background, which is what the
// per-mon fades want; the port keeps that and leaves wBGP alone.
// Lua: BgEffects.lua:601
function rapidCyclePals(self: BgEffectsPool, st: BgEffect, pals: PalList): void {
  const jt = st.jt;
  if (jt === 0) {
    // engine/battle_anims/bg_effects.asm:2480-2494
    incJt(st);
    st.side = self.sideKey(st);
    st.turn = st.param;
    st.param = 0;
    return;
  }
  const side = st.side ?? self.sideKey(st);
  if (jt === 1) {
    if ((st.turn & 0xf) !== 0) {
      st.turn = u8(st.turn - 1);
      return;
    }
    // The low nybble is reloaded from the high one, which is the step delay.
    st.turn = swap(st.turn) | st.turn;
    const value = nextPal(st, pals);
    if (value === undefined) {
      // engine/battle_anims/bg_effects.asm:2515-2519
      st.param = u8(st.param - 1);
      return;
    }
    self.monShade[side] = value;
    return;
  }
  self.monShade[side] = NORMAL_PAL;
  endEffect(st);
}

const RAPID_PALS: Record<string, PalList> = {
  BATTLE_BG_EFFECT_RAPID_FLASH: [0xe4, 0x6c, 0xfe],
  BATTLE_BG_EFFECT_FADE_MON_TO_LIGHT: [0xe4, 0x90, 0x40, 0xff],
  BATTLE_BG_EFFECT_FADE_MON_TO_BLACK: [0xe4, 0xf8, 0xfc, 0xff],
  BATTLE_BG_EFFECT_FADE_MON_TO_LIGHT_REPEATING: [0xe4, 0x90, 0x40, 0x90, 0xfe],
  BATTLE_BG_EFFECT_FADE_MON_TO_BLACK_REPEATING: [0xe4, 0xf8, 0xfc, 0xf8, 0xfe],
  BATTLE_BG_EFFECT_CYCLE_MON_LIGHT_DARK_REPEATING: [0xe4, 0xf8, 0xfc, 0xf8, 0xe4, 0x90, 0x40, 0x90, 0xfe],
  BATTLE_BG_EFFECT_FLASH_MON_REPEATING: [0xe4, 0xfc, 0xe4, 0x00, 0xfe],
  BATTLE_BG_EFFECT_FADE_MON_TO_WHITE_WAIT_FADE_BACK: [
    0xe4, 0x90, 0x40, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x40, 0x90, 0xe4, 0xff,
  ],
  BATTLE_BG_EFFECT_FADE_MON_FROM_WHITE: [0x00, 0x40, 0x90, 0xe4, 0xff],
};

// Lua: BgEffects.lua:648
for (const name of Object.keys(RAPID_PALS)) {
  const pals = RAPID_PALS[name]!;
  E[name] = (self, st) => rapidCyclePals(self, st, pals);
}

// BattleBGEffect_FadeMonsToBlackRepeating fades BOTH battlers, on opposite
// halves of the same four-step ramp.
const FADE_BOTH: PalList = [0xe4, 0xe4, 0xf8, 0x90, 0xfc, 0x40, 0xf8, 0x90];

// Lua: BgEffects.lua:656
E.BATTLE_BG_EFFECT_FADE_MONS_TO_BLACK_REPEATING = (self, st) => {
  const jt = st.jt;
  if (jt === 0) {
    incJt(st);
    st.param = 0;
    return;
  }
  if (jt === 1) {
    const age = st.param;
    st.param = u8(st.param + 1);
    if ((age & 7) !== 0) return;
    // Bits 3-4 pick the pair, doubled into a row index.
    const index = ((age & 0x18) >>> 3) * 2;
    const first = FADE_BOTH[index] ?? NORMAL_PAL;
    const second = FADE_BOTH[index + 1] ?? NORMAL_PAL;
    if (self.playerSide(st)) {
      self.monShade.player = first;
      self.monShade.enemy = second;
    } else {
      self.monShade.enemy = first;
      self.monShade.player = second;
    }
    return;
  }
  self.monShade.player = NORMAL_PAL;
  self.monShade.enemy = NORMAL_PAL;
  endEffect(st);
};

// BattleBGEffects_GetShakeAmount.  JT is the total frame count, PARAM's low
// nybble the countdown to the next flip (reloaded from its high nybble) and
// `turn` the amplitude, negated on every flip.  Returns nil once it is done.
// Lua: BgEffects.lua:685
function shakeAmount(_self: BgEffectsPool, st: BgEffect): number | undefined {
  if (st.jt === 0) {
    endEffect(st);
    return undefined;
  }
  st.jt = st.jt - 1;
  if ((st.param & 0xf) !== 0) {
    st.param = u8(st.param - 1);
    return st.turn;
  }
  st.param = swap(st.param) | st.param;
  st.turn = u8(-st.turn);
  return st.turn;
}

// Lua: BgEffects.lua:700
E.BATTLE_BG_EFFECT_SHAKE_SCREEN_X = (self, st) => {
  self.scx = shakeAmount(self, st) ?? 0;
};

// Lua: BgEffects.lua:704
E.BATTLE_BG_EFFECT_SHAKE_SCREEN_Y = (self, st) => {
  self.scy = shakeAmount(self, st) ?? 0;
};

// Rollout shakes vertically and hands the negated amount to the first anim
// object's Y offset, so the boulder rides the shake instead of floating over
// it.  The cart's extra DelayFrame here is what makes Rollout's animation run
// at half speed; RunBattleAnimScript skips its own frame delay to compensate.
// Lua: BgEffects.lua:712
E.BATTLE_BG_EFFECT_ROLLOUT = (self, st) => {
  let amount = shakeAmount(self, st);
  if (amount === undefined || (amount & 0x80) !== 0) amount = 0;
  self.scy = amount;
  self.rolloutYOffset = u8(-amount);
};

// Lua: BgEffects.lua:719
E.BATTLE_BG_EFFECT_WOBBLE_SCREEN = (self, st) => {
  if (st.param >= 0x40) {
    self.scx = 0;
    return;
  }
  self.scx = sine(st.param, 6);
  st.param = u8(st.param + 2);
};

// Withdraw: a growing number of the attacker's scanlines are pushed off, so
// the mon appears to pull into its shell.  PARAM's low six bits are how far
// to go and its top two the step.
// Lua: BgEffects.lua:731
E.BATTLE_BG_EFFECT_WITHDRAW = (self, st) => {
  const jt = st.jt;
  if (jt === 0) {
    incJt(st);
    self.clearLYOverrides(0);
    self.setLCDStatCustoms1("SCY", st);
    self.lyEnd = u8(self.lyEnd + 1);
    st.turn = 1;
  } else if (jt === 1) {
    const limit = st.param & 0x3f;
    if (st.turn >= limit) return;
    self.displaceLY(st.turn);
    const step = (st.param >>> 6) & 3;
    st.turn = u8(st.turn + step);
  } else if (jt === 2) {
    self.resetLCDStatCustom(st);
  }
};

// Dig: the same displacement, but it pauses and then eats the pic two
// scanlines at a time until the whole window is gone.
// Lua: BgEffects.lua:752
E.BATTLE_BG_EFFECT_DIG = (self, st) => {
  const jt = st.jt;
  if (jt === 0) {
    incJt(st);
    self.clearLYOverrides(0);
    self.setLCDStatCustoms1("SCY", st);
    self.lyEnd = u8(self.lyEnd + 1);
    st.turn = 2;
    st.param = 0;
  } else if (jt === 1) {
    if (st.param !== 0) {
      st.param = u8(st.param - 1);
      return;
    }
    st.param = 0x10;
    incJt(st);
  } else if (jt === 2) {
    const span = u8(self.lyEnd - self.lyStart) - 1;
    if (span < st.turn) return;
    // Every eighth scanline the effect steps back a state, which is the
    // pause between digs.
    if ((st.turn & 7) === 0) st.jt = u8(st.jt - 1);
    self.displaceLY(st.turn);
    st.turn = u8(st.turn + 2);
  } else if (jt === 3) {
    self.resetLCDStatCustom(st);
  }
};

// Tackle: the attacker's rows slide eight pixels towards the target and back.
// `turn` is the signed step and `param` the distance travelled so far.
// Lua: BgEffects.lua:783
function tackleMoveForward(self: BgEffectsPool, st: BgEffect): void {
  if (st.param === u8(-8) || st.param === 8) incJt(st);
  self.fillLY(st.param);
  st.param = u8(st.param + st.turn);
}

// Lua: BgEffects.lua:789
function tackleReturn(self: BgEffectsPool, st: BgEffect): void {
  if (st.param === 0) incJt(st);
  self.fillLY(st.param);
  st.param = u8(st.param + u8(-st.turn));
}

// Lua: BgEffects.lua:795
function tackleInit(self: BgEffectsPool, st: BgEffect, backwards: boolean): void {
  incJt(st);
  self.clearLYOverrides(0);
  self.setLCDStatCustoms1("SCX", st);
  self.lyEnd = u8(self.lyEnd + 1);
  // SCX scrolls the BACKGROUND, so a negative value moves the mon RIGHT: the
  // player's back pic steps towards the enemy on -2, not +2.
  let forward = self.playerSide(st) ? u8(-2) : 2;
  if (backwards) forward = self.playerSide(st) ? 2 : u8(-2);
  st.param = 0;
  st.turn = forward;
}

// Lua: BgEffects.lua:808
E.BATTLE_BG_EFFECT_TACKLE = (self, st) => {
  const jt = st.jt;
  if (jt === 0) {
    tackleInit(self, st, false);
  } else if (jt === 1) {
    tackleMoveForward(self, st);
  } else if (jt === 2) {
    tackleReturn(self, st);
  } else if (jt === 3) {
    self.resetLCDStatCustom(st);
  }
};

// Lua: BgEffects.lua:821
E.BATTLE_BG_EFFECT_VITAL_THROW = (self, st) => {
  const jt = st.jt;
  if (jt === 0) {
    tackleInit(self, st, true);
  } else if (jt === 1) {
    tackleMoveForward(self, st);
  } else if (jt === 3) {
    tackleReturn(self, st);
  } else if (jt === 4) {
    self.resetLCDStatCustom(st);
  }
};

// Lua: BgEffects.lua:834
E.BATTLE_BG_EFFECT_BETA_PURSUIT = (self, st) => {
  const jt = st.jt;
  if (jt === 0) {
    tackleInit(self, st, true);
  } else if (jt === 1) {
    tackleMoveForward(self, st);
  } else if (jt === 2) {
    tackleReturn(self, st);
  } else if (jt === 3) {
    self.resetLCDStatCustom(st);
  }
};

// engine/battle_anims/bg_effects.asm:1444
// Lua: BgEffects.lua:848
E.BATTLE_BG_EFFECT_BODY_SLAM = (self, st) => {
  const jt = st.jt;
  if (jt === 0) {
    incJt(st);
    self.clearLYOverrides(0);
    self.setLCDStatCustoms2("SCX", st);
    self.lyEnd = u8(self.lyEnd + 1);
    st.param = 0;
    st.turn = self.playerSide(st) ? u8(-2) : 2;
  } else if (jt === 1) {
    tackleMoveForward(self, st);
  } else if (jt === 2) {
    tackleReturn(self, st);
  } else if (jt === 3) {
    self.resetLCDStatCustom(st);
  }
};

// Lua: BgEffects.lua:866
E.BATTLE_BG_EFFECT_WOBBLE_MON = (self, st) => {
  const jt = st.jt;
  if (jt === 0) {
    incJt(st);
    self.clearLYOverrides(0);
    self.setLCDStatCustoms1("SCX", st);
    self.lyEnd = u8(self.lyEnd + 1);
    st.param = 0;
  } else if (jt === 1) {
    self.fillLY(sine(st.param, 8));
    st.param = u8(st.param + 4);
  } else if (jt === 2) {
    self.resetLCDStatCustom(st);
  }
};

// Always the player's rows, and the window is written directly rather than
// through SetLCDStatCustoms1 -- this is the wobble the player's own mon does
// when it is confused, whoever is attacking.
// Lua: BgEffects.lua:885
E.BATTLE_BG_EFFECT_WOBBLE_PLAYER = (self, st) => {
  const jt = st.jt;
  if (jt === 0) {
    incJt(st);
    self.clearLYOverrides(0);
    self.lcdc = "SCX";
    self.lyStart = 0;
    self.lyEnd = 0x37;
    st.param = 0;
  } else if (jt === 1) {
    if (st.param >= 0x40) {
      self.resetLCDStatCustom(st);
      return;
    }
    self.fillLY(sine(st.param, 6));
    st.param = u8(st.param + 2);
  } else if (jt === 2) {
    self.resetLCDStatCustom(st);
  }
};

// Two sines an octave apart, which is what makes Flail read as thrashing
// rather than swaying.
// Lua: BgEffects.lua:907
E.BATTLE_BG_EFFECT_FLAIL = (self, st) => {
  const jt = st.jt;
  if (jt === 0) {
    incJt(st);
    self.clearLYOverrides(0);
    self.setLCDStatCustoms1("SCX", st);
    self.lyEnd = u8(self.lyEnd + 1);
    st.turn = 0;
    st.param = 0;
  } else if (jt === 1) {
    const wide = sine(st.param, 6);
    const narrow = sine(st.turn, 2);
    self.fillLY(u8(wide + narrow));
    st.turn = u8(st.turn + 8);
    st.param = u8(st.param + 2);
  } else if (jt === 2) {
    self.resetLCDStatCustom(st);
  }
};

// Lua: BgEffects.lua:926
E.BATTLE_BG_EFFECT_VIBRATE_MON = (self, st) => {
  const jt = st.jt;
  if (jt === 0) {
    incJt(st);
    self.clearLYOverrides(0);
    self.setLCDStatCustoms1("SCX", st);
    self.lyEnd = u8(self.lyEnd + 1);
    st.turn = 1;
    st.param = 0x20;
  } else if (jt === 1) {
    if (st.param === 0) {
      self.resetLCDStatCustom(st);
      return;
    }
    st.param = u8(st.param - 1);
    // Flips on the even frames only, so it buzzes at 30 Hz rather than 60.
    if ((st.param & 1) !== 0) return;
    st.turn = u8(-st.turn);
    self.fillLY(st.turn);
  }
};

// BounceDown: the attacker drops in on a cosine and settles, using the same
// scanline displacement Withdraw does.
// Lua: BgEffects.lua:950
E.BATTLE_BG_EFFECT_BOUNCE_DOWN = (self, st) => {
  const jt = st.jt;
  if (jt === 0) {
    incJt(st);
    self.clearLYOverrides(0);
    self.setLCDStatCustoms2("SCY", st);
    self.lyEnd = u8(self.lyEnd + 1);
    st.turn = 1;
    st.param = 0x20;
  } else if (jt === 1) {
    if (st.turn >= 0x38) return;
    const height = u8(cosine(st.param, 0x10) + 0x10);
    self.displaceLY(u8(st.turn + height));
    st.param = u8(st.param + 2);
  } else if (jt === 2) {
    self.resetLCDStatCustom(st);
  }
};

//--------------------------------------------------------------------------
// The screen-wide deformations
//--------------------------------------------------------------------------
//
// These thirteen are the ones that write a DIFFERENT value to every scanline
// rather than the same one to a band, so they all sit on DeformScreen,
// DeformWater or the surf ring above.  The shape of each is the ASM's; what
// the port cannot reproduce is the CGB writing rSCX mid-frame at sub-pixel
// timing, and none of these depend on that -- they depend on the ARRAY, which
// is modelled exactly.

// Surf.  `.zero` lays a 2-amplitude wave into the ring and falls through to
// `.one` on the same frame (ASM fallthrough, not a jumptable branch), and
// `.one` waits for hLCDCPointer: engine/battle_anims/functions.asm:1158.
// Lua: BgEffects.lua:983
E.BATTLE_BG_EFFECT_SURF = (self, st) => {
  let jt = st.jt;
  if (jt === 0) {
    incJt(st);
    self.initSurfWaves(2, 2);
    jt = 1;
  }
  if (jt === 1) {
    if (!self.lcdc) return;
    self.rotateSurfWave();
  } else if (jt === 2) {
    self.resetLCDStatCustom(st);
  }
};

// Whirlpool: the wave covers the WHOLE screen ($00-$5e) rather than one
// battler's rows, and it scrolls vertically (rSCY), so the water rolls
// top to bottom behind both mons.
// Lua: BgEffects.lua:1001
E.BATTLE_BG_EFFECT_WHIRLPOOL = (self, st) => {
  const jt = st.jt;
  if (jt === 0) {
    incJt(st);
    self.clearLYOverrides(0);
    self.lcdc = "SCY";
    self.lyStart = 0;
    self.lyEnd = 0x5e;
    self.deformScreen(2, 2);
  } else if (jt === 1) {
    self.wavyScreenFX();
  } else if (jt === 2) {
    self.resetLCDStatCustom(st);
  }
};

// The three water effects, which the Surf animation drives as a set: START
// opens the window and ends itself immediately, WATER does the work, END puts
// the registers back.
// Lua: BgEffects.lua:1019
E.BATTLE_BG_EFFECT_START_WATER = (self, st) => {
  self.clearLYOverrides(0);
  self.setLCDStatCustoms1("SCY", st);
  endEffect(st);
};

// WATER is the one effect whose three struct fields are all something else:
// PARAM is the sine phase (climbing 4 a frame), BATTLE_TURN is a frame
// counter that doubles as the amplitude, and JT_INDEX is the Y position the
// deformation is centred on.
//
// `ld a, [hl]` then `inc [hl]` twice leaves `a` holding the PRE-increment
// turn, and that is the count DeformWater is called with -- so the figure
// grows two scanlines a frame from nothing until the counter passes $20.
// Lua: BgEffects.lua:1033
E.BATTLE_BG_EFFECT_WATER = (self, st) => {
  const offset = st.param;
  st.param = u8(st.param + 4);
  // (0xff XOR the high nibble) + 4: the amplitude SHRINKS as the counter
  // climbs, so the wave is widest when it first appears.
  const amplitude = u8((((st.turn & 0xf0) >>> 4) ^ 0xff) + 4);
  const progress = st.jt;
  const count = st.turn;
  if (count >= 0x20) {
    self.clearLYOverrides(0);
    endEffect(st);
    return;
  }
  st.turn = u8(st.turn + 2);
  self.deformWater(count, amplitude, offset, progress);
};

// Lua: BgEffects.lua:1050
E.BATTLE_BG_EFFECT_END_WATER = (self, st) => {
  self.resetLCDStatCustom(st);
};

// Psychic is hardcoded to the whole screen ($00-$5f) whichever side used it,
// and only travels every FOURTH frame (`and $3 / ret nz`), which is what makes
// it a slow ripple rather than Teleport's shimmer.
// Lua: BgEffects.lua:1057
E.BATTLE_BG_EFFECT_PSYCHIC = (self, st) => {
  const jt = st.jt;
  if (jt === 0) {
    incJt(st);
    self.clearLYOverrides(0);
    self.lcdc = "SCX";
    self.lyStart = 0;
    self.lyEnd = 0x5f;
    self.deformScreen(6, 5);
    st.param = 0;
  } else if (jt === 1) {
    const counter = st.param;
    st.param = u8(st.param + 1);
    if ((counter & 3) !== 0) return;
    self.wavyScreenFX();
  } else if (jt === 2) {
    self.resetLCDStatCustom(st);
  }
};

// Teleport: the same wave as Psychic but only over the user's own rows, and
// travelling every frame.
// Lua: BgEffects.lua:1078
E.BATTLE_BG_EFFECT_TELEPORT = (self, st) => {
  const jt = st.jt;
  if (jt === 0) {
    incJt(st);
    self.clearLYOverrides(0);
    self.setLCDStatCustoms1("SCX", st);
    self.deformScreen(6, 5);
  } else if (jt === 1) {
    self.wavyScreenFX();
  } else if (jt === 2) {
    self.resetLCDStatCustom(st);
  }
};

// Night Shade takes its phase step from the struct's PARAM, so the same
// effect id gives a long slow roll or a tight ripple depending on what the
// script queued it with.
// Lua: BgEffects.lua:1095
E.BATTLE_BG_EFFECT_NIGHT_SHADE = (self, st) => {
  const jt = st.jt;
  if (jt === 0) {
    incJt(st);
    self.clearLYOverrides(0);
    self.setLCDStatCustoms1("SCY", st);
    self.deformScreen(2, st.param);
  } else if (jt === 1) {
    self.wavyScreenFX();
  } else if (jt === 2) {
    self.resetLCDStatCustom(st);
  }
};

// Double Team's afterimage: alternate scanlines are pushed +n and -n, so the
// pic reads as two copies of itself a few pixels apart.  `.UpdateLYOverrides`
// writes the pair (e, -e) down the window and, on an odd-height window,
// repeats `e` on the last row -- `srl a` leaves the odd bit in carry and
// `ret nc` is what skips that store on an even one.
// Lua: BgEffects.lua:1114
function doubleTeamOverrides(self: BgEffectsPool, value: number): void {
  const e = u8(value);
  const d = u8(-e);
  const span = u8(self.lyEnd - self.lyStart);
  const pairs = span >>> 1;
  const odd = (span & 1) !== 0;
  let row = self.lyStart;
  for (let n = 0; n < pairs; n++) {
    if (row > SCREEN_ROWS) return;
    self.lyBackup[row] = e;
    row++;
    if (row > SCREEN_ROWS) return;
    self.lyBackup[row] = d;
    row++;
  }
  if (odd && row <= SCREEN_ROWS) self.lyBackup[row] = e;
}

// Lua: BgEffects.lua:1132
E.BATTLE_BG_EFFECT_DOUBLE_TEAM = (self, st) => {
  const jt = st.jt;
  if (jt === 0) {
    incJt(st);
    self.clearLYOverrides(0);
    self.setLCDStatCustoms1("SCX", st);
    self.lyEnd = u8(self.lyEnd + 1);
    st.turn = 0;
  } else if (jt === 1) {
    // Split apart, a pixel a frame, to $10.
    if (st.param >= 0x10) {
      incJt(st);
      return;
    }
    const value = st.param;
    st.param = u8(st.param + 1);
    doubleTeamOverrides(self, value);
  } else if (jt === 2) {
    // Hold, wobbling about the current separation.  This state never advances
    // itself; the script's own `incbgeffect` is what moves it on.
    const wobble = u8(sine(st.turn, 2) + st.param);
    doubleTeamOverrides(self, wobble);
    st.turn = u8(st.turn + 4);
  } else if (jt === 3) {
    // Come back together.  The test is `cp $ff`, so a PARAM that started at 0
    // underflows to $ff and stops there rather than at zero.
    if (st.param === 0xff) {
      incJt(st);
      return;
    }
    const value = st.param;
    st.param = u8(st.param - 1);
    doubleTeamOverrides(self, value);
  } else if (jt === 5) {
    self.resetLCDStatCustom(st);
  }
  // jt 4 is a bare `ret`: the gap the script sits in between the two halves.
};

// Acid Armor: the wave is laid down once and then the whole window is scrolled
// DOWN one scanline a frame, with a blank row ($90) fed in at the top -- so
// the mon melts into the floor instead of wobbling in place.  The two
// fix-ups at the bottom clear the last two rows once their values are large
// enough to be showing the pic's own bottom edge.
// Lua: BgEffects.lua:1176
E.BATTLE_BG_EFFECT_ACID_ARMOR = (self, st) => {
  const jt = st.jt;
  if (jt === 0) {
    incJt(st);
    self.clearLYOverrides(0);
    self.setLCDStatCustoms1("SCY", st);
    self.deformScreen(2, st.param);
    self.lyBackup[self.lyEnd] = 0;
    self.lyBackup[self.lyEnd - 1] = 0;
  } else if (jt === 1) {
    for (let row = self.lyEnd; row >= self.lyStart + 1; row--) {
      self.lyBackup[row] = self.lyBackup[row - 1] ?? 0;
    }
    self.lyBackup[self.lyStart] = 0x90;
    const last = self.lyBackup[self.lyEnd] ?? 0;
    if (last >= 1 && last !== 0x90) self.lyBackup[self.lyEnd] = 0;
    const penultimate = self.lyBackup[self.lyEnd - 1] ?? 0;
    if (penultimate >= 2 && penultimate !== 0x90) {
      self.lyBackup[self.lyEnd - 1] = 0;
    }
  } else if (jt === 2) {
    self.resetLCDStatCustom(st);
  }
};

// Wave Deform: the amplitude ramps up to $20 in state 1 and back down to 0 in
// state 2, at a fixed phase step of 4.  Neither ramp advances the state on its
// own -- the script does -- so how far it gets is the script's business.
// Lua: BgEffects.lua:1204
E.BATTLE_BG_EFFECT_WAVE_DEFORM_MON = (self, st) => {
  const jt = st.jt;
  if (jt === 0) {
    incJt(st);
    self.clearLYOverrides(0);
    self.setLCDStatCustoms1("SCX", st);
  } else if (jt === 1) {
    if (st.param >= 0x20) return;
    const amplitude = st.param;
    st.param = u8(st.param + 1);
    self.deformScreen(amplitude, 4);
  } else if (jt === 2) {
    if (st.param === 0) {
      self.resetLCDStatCustom(st);
      return;
    }
    const amplitude = st.param;
    st.param = u8(st.param - 1);
    self.deformScreen(amplitude, 4);
  }
};

// The two beta send-outs are `; unused` on the cart -- nothing queues them --
// but they are in the jumptable, so a mod or a hand-written script can, and
// an unimplemented entry would sit in the pool forever.
//
// MON1 writes rBGP per scanline rather than a scroll register: every other
// row of the window steps through $00 (all white), $40, $90 and $e4 (normal),
// eight frames apart, so the pic fades in through a venetian blind.
const BETA_SEND_OUT_PALS: PalList = [0x00, 0x40, 0x90, 0xe4];

// `.SetLYOverridesBackup`: every SECOND scanline, (lyEnd - lyStart) / 2 times.
// Lua: BgEffects.lua:1236
function betaBlind(self: BgEffectsPool, value: number): void {
  const count = u8(self.lyEnd - self.lyStart) >>> 1;
  let row = self.lyStart;
  for (let n = 0; n < count; n++) {
    if (row > SCREEN_ROWS) return;
    self.lyBackup[row] = u8(value);
    row += 2;
  }
}

// `.GetLYOverride`: PARAM counts up and its top bits index the palette list,
// so each entry is held eight frames.  Past the end it returns nil, which is
// the `cp $ff` the caller branches on.
// Lua: BgEffects.lua:1249
function betaPal(st: BgEffect): number | undefined {
  const index = st.param >>> 3;
  st.param = u8(st.param + 1);
  return BETA_SEND_OUT_PALS[index];
}

// Lua: BgEffects.lua:1255
E.BATTLE_BG_EFFECT_BETA_SEND_OUT_MON1 = (self, st) => {
  const jt = st.jt;
  if (jt === 0) {
    incJt(st);
    self.clearLYOverrides(0xe4);
    self.setLCDStatCustoms1("BGP", st);
    self.lyEnd = u8(self.lyEnd + 1);
    for (let row = self.lyStart; row <= self.lyEnd - 1; row++) {
      if (row > SCREEN_ROWS) break;
      self.lyBackup[row] = 0;
    }
    st.param = 0;
    // `.zero` falls into `.one`, which is a bare ret.
  } else if (jt === 2) {
    const value = betaPal(st);
    if (value !== undefined) {
      betaBlind(self, value);
      return;
    }
    st.param = 0;
    self.lyStart = u8(self.lyStart + 1);
    incJt(st);
  } else if (jt === 3) {
    const value = betaPal(st);
    if (value === undefined) {
      incJt(st);
      return;
    }
    betaBlind(self, value);
    // The second pass also fills the row the blind skipped at the bottom.
    self.lyBackup[self.lyEnd - 1] = u8(value);
  } else if (jt === 5) {
    self.resetVideoHRAM();
    endEffect(st);
  }
  // jt 1 and 4 are bare rets.
};

// MON2 is a plain DeformScreen whose amplitude and phase step are the SAME
// value, counted down from $40 in eighths -- so the wobble starts at 8 and
// unwinds to nothing.
// Lua: BgEffects.lua:1296
E.BATTLE_BG_EFFECT_BETA_SEND_OUT_MON2 = (self, st) => {
  const jt = st.jt;
  if (jt === 0) {
    incJt(st);
    self.clearLYOverrides(0);
    self.setLCDStatCustoms1("SCX", st);
    st.turn = 0x40;
  } else if (jt === 1) {
    if (st.turn === 0) {
      self.resetLCDStatCustom(st);
      return;
    }
    const value = st.turn;
    st.turn = u8(st.turn - 1);
    // `ld a, [hl] / dec [hl] / srl a x3`: the PRE-decrement value, shifted.
    const amount = (value >>> 3) & 0x0f;
    self.deformScreen(amount, amount);
  }
};

// Nothing is left unmodelled.  The name stays so a caller (and the tests) can
// still ask, and so the answer is checkable rather than a claim in a comment.
// Lua: BgEffects.lua:1318
const UNMODELLED: string[] = [];
const UNMODELLED_SET: Record<string, boolean> = {};
for (const name of UNMODELLED) UNMODELLED_SET[name] = true;

// The Lua's DROPPED is one table used as both a set (DROPPED[name] = true)
// and a list (DROPPED[#DROPPED + 1] = name); here it is the list, and the
// set test is `includes`.
const DROPPED: (string | number)[] = [];

// Lua: BgEffects.lua:1326
function dropUnknown(st: BgEffect): void {
  const name = st.func;
  endEffect(st);
  if (typeof name === "string" && UNMODELLED_SET[name]) return;
  if (name !== undefined && !DROPPED.includes(name)) DROPPED.push(name);
  if (BgEffects.strict) {
    throw new Error(`BgEffects: no entry for ${String(name)}`);
  }
}

//--------------------------------------------------------------------------

export const BgEffects = {
  DROPPED,
  /** Lua: os.getenv("POKEPORT_DEV") == "1" (no environment on the device: false). */
  strict: (globalThis as any).process?.env?.POKEPORT_DEV === "1",
  EFFECTS: E,
  NUM_EFFECTS,
  NORMAL_PAL,
  SCREEN_ROWS,
  UNMODELLED,
  // Lua: BgEffects.lua:55
  new(constants?: Record<string, any>, env?: AnimEnv): BgEffectsPool {
    return new BgEffectsPool(constants, env);
  },
};

export default BgEffects;
