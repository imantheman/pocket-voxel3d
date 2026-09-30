// The Gen 2 battle-animation OBJECT runtime: a port of gen1recomp
// src/battle/gen2/AnimObjects.lua (bdfac727, MIT).
//
// pokegold engine/battle_anims/core.asm (the struct pool and the OAM writer),
// engine/battle_anims/helpers.asm (GetBattleAnimFrame) and
// engine/battle_anims/functions.asm (the 80 per-frame functions).  The DATA
// these run on -- objects, framesets, OAM sets, GFX sheets -- is extracted
// into `battle_anims.json` (voxelmon/import/gen2/battleanims.ts); nothing here
// is transcribed by hand.
//
// Ten structs, and one of them is picked by QueueBattleAnimation the same way
// _InitSpriteAnimStruct picks a sprite-anim slot: the first with INDEX == 0.
// Every field is a byte and wraps, and several functions rely on that: an
// object walks its Y offset down past 0 into $ff.. and reads the result back
// as a negative pixel offset.
//
// Coordinates are hardware OAM coordinates: an OBJ at struct (x, y) draws at
// (x - 8, y - 16) on the 160x144 screen.  `xOffset`/`yOffset` are signed bytes
// added on top, which is what every sine-driven function writes.
//
// Two traps this file exists to get right:
//
//  * ASM fallthrough is not the same as a jumptable branch.  A dozen of these
//    functions end their `.zero` case by dropping straight into `.one` on the
//    SAME frame, so an object that only ran its init would be a frame late for
//    the rest of its life.  Every one of those is written out here.
//  * `ld a, [hl]` followed by `inc [hl]` leaves `a` holding the value from
//    BEFORE the increment.  Dizzy's frameset flip and Perish Song's descent
//    both read the pre-increment value, and using the new one desynchronises
//    the animation from its own frameset.
//
// Screen-free on purpose: the battle view turns the OAM list into draw calls,
// and the tests step whole animations with no screen at all.

import { mod, truthy } from "../platform/lua.ts";
// The sine table is engine/math/sine.asm's `sine_table 32`, shared with the
// overworld/intro sprite anims: BattleAnim_Sine is `calc_sine_wave
// BattleAnimSineWave`, the same macro over the same 32-entry quarter wave.
import { SpriteAnims } from "../ui/SpriteAnims.ts";

// Lua: AnimObjects.lua:41
const NUM_STRUCTS = 10; // NUM_BATTLE_ANIM_STRUCTS
// wShadowOAM is 40 objects; BattleAnimOAMUpdate returns carry once it is full
// and BattleAnim_UpdateOAM_All stops walking the structs.
const OAM_LIMIT = 40;

const OAM_PRIO = 0x80;
const OAM_YFLIP = 0x40;
const OAM_XFLIP = 0x20;
const OAM_FLAG_MASK = 0xe0;
const OAM_PAL1 = 0x10;
// BATTLEANIMSTRUCT_OAMFLAGS_FIX_COORDS_F: bit 0 of the object's flags byte
// means "mirror this object onto the other battler's side when the enemy is
// the one attacking".
const FIX_COORDS = 0x01;

//--------------------------------------------------------------------------
// Types
//--------------------------------------------------------------------------

/** One battle-anim struct (BATTLEANIMSTRUCT_*); every numeric field a byte. */
export interface AnimStruct {
  index: number;
  oamFlags: number;
  fixY: number;
  framesetId: number;
  /** BATTLE_ANIM_FUNC_* name (the importer names it; a raw id if unnamed). */
  func: string | number;
  /** PAL_BATTLE_OB_* name (or a raw id). */
  palette: string | number;
  tileId: number;
  x: number;
  y: number;
  xOffset: number;
  yOffset: number;
  param: number;
  duration: number;
  frame: number;
  jt: number;
  var1: number;
  var2: number;
  /** The BATTLE_ANIM_OBJ_* this struct was queued from. */
  objectId?: string | number;
}

/**
 * One shadow-OAM entry. `x`/`y` are hardware OAM bytes (draw at x - 8,
 * y - 16 on the 160x144 screen, wrapping as bytes); `tile` is relative to the
 * script's battle-anim tile base (sheet-relative, BATTLEANIM_BASE_TILE not
 * added); `attr` carries OAM_PRIO/YFLIP/XFLIP and OAM_PAL1; `palette` is the
 * struct's PAL_BATTLE_OB_* name.
 */
export interface AnimOamEntry {
  y: number;
  x: number;
  tile: number;
  attr: number;
  /** The importer always names these (PAL_BATTLE_OB_*); see updateOam. */
  palette: string;
}

/** What InitBattleAnimBuffer leaves in wBattleAnimTemp*. */
export interface AnimBuffer {
  oamFlags: number;
  palette: string | number;
  tileId: number;
  x: number;
  y: number;
  xOffset: number;
  yOffset: number;
}

/** What the battle screen owns and this pool only reads (see AnimObjects.new). */
export interface AnimEnv {
  battleTurn?: number;
  animId?: string | number;
  ballPalette?: string | null;
  sgb?: unknown;
  [k: string]: any;
}

/** battle_anims.json, the parts this pool reads. */
export interface AnimObjectData {
  objects?: Record<string, any>;
  framesets?: Record<string, (string | number)[][]>;
  oamsets?: Record<string, { vtile?: number; sprites?: { y?: number; x?: number; tile?: number; attr?: number }[] }>;
  [k: string]: any;
}

export type AnimFunc = (pool: AnimObjectPool, st: AnimStruct) => void;

//--------------------------------------------------------------------------
// Byte arithmetic
//--------------------------------------------------------------------------

// Lua: AnimObjects.lua:58
function u8(value: number): number {
  return mod(value, 256);
}

// The byte read as a signed value, which is what every `bit 7, a` test and
// every coordinate add is really doing.
// Lua: AnimObjects.lua:62
function s8(value: number): number {
  value = mod(value, 256);
  return value < 0x80 ? value : value - 256;
}

// `sra a`: arithmetic shift right, sign preserved.
// Lua: AnimObjects.lua:68
function sra(value: number): number {
  return u8(Math.floor(s8(value) / 2));
}

// `swap a`
// Lua: AnimObjects.lua:71
function swap(value: number): number {
  value = u8(value);
  return (value >>> 4) | ((value << 4) & 0xf0);
}

// `rlca`
// Lua: AnimObjects.lua:77
function rlca(value: number): number {
  value = u8(value);
  return u8((value << 1) + (value >>> 7));
}

// Lua: AnimObjects.lua:82 -- bound at call time (not at load) so the
// SpriteAnims port can land later and tests can patch it.
function sine(angle: number, amplitude: number): number {
  return SpriteAnims.sine(angle, amplitude) as number;
}

// Lua: AnimObjects.lua:83
function cosine(angle: number, amplitude: number): number {
  return SpriteAnims.cosine(angle, amplitude) as number;
}

//--------------------------------------------------------------------------
// The struct pool
//--------------------------------------------------------------------------

// Lua: AnimObjects.lua:92
function newStruct(): AnimStruct {
  return {
    index: 0, oamFlags: 0, fixY: 0, framesetId: 0, func: 0, palette: 0,
    tileId: 0, x: 0, y: 0, xOffset: 0, yOffset: 0, param: 0,
    duration: 0, frame: 0xff, jt: 0, var1: 0, var2: 0,
  };
}

// ReinitBattleAnimFrameset: swap framesets and restart the frame walk.
// Lua: AnimObjects.lua:160
function reinit(st: AnimStruct, framesetId: number): void {
  st.framesetId = u8(framesetId);
  st.duration = 0;
  st.frame = 0xff; // `ld [hl], -1`
}

// Lua: AnimObjects.lua:166
function deinit(st: AnimStruct): void {
  st.index = 0;
}

// What a frameset row yields: the OAM set name, or the "wait" / "delete"
// pseudo-commands BattleAnimOAMUpdate acts on, plus the frame's flip flags.
// Rows are ["frame", oamset, duration, flips] / ["wait", n] / ["delete"]
// (0-based here; the Lua's row[2]/row[4] are row[1]/row[3]).
// Lua: AnimObjects.lua:227
function frameYield(row: (string | number)[]): [string | number | undefined, number] {
  const kind = row[0];
  if (kind === "wait") return ["wait", 0];
  if (kind === "delete") return ["delete", 0];
  return [row[1], (row[3] as number | undefined) ?? 0];
}

// AddOrSubtractY / AddOrSubtractX: a flipped entry mirrors around its own
// 8-pixel cell, which is `-(offset + 8)`.
// Lua: AnimObjects.lua:283
function mirror(value: number, flip: boolean): number {
  if (!flip) return value;
  return u8(-(u8(value) + 8));
}

export class AnimObjectPool {
  data: AnimObjectData;
  env: AnimEnv;
  structs: AnimStruct[];
  /** wLastAnimObjectIndex */
  lastIndex: number;
  oam: AnimOamEntry[];
  objectOrder: string[];
  framesetOrder: string[];
  framesetIds: Record<string, number>;
  /** The BG-effect state the Surf object drives (AnimRunner sets it to its BgEffects). */
  hram: any;
  obp0: number | null;

  // `data` is the importer's battle_anims table; `constants` its constants
  // table (for the ordered name lists an id indexes into).
  //
  // `env` is what the battle screen owns and this pool only reads:
  //   env.battleTurn   hBattleTurn: 0 while the player is attacking
  //   env.animId       wFXAnimID, the move whose script is running (KINESIS,
  //                    SOFTBOILED and MILK_DRINK get their own Y nudge)
  //   env.ballPalette  the PAL_BATTLE_OB_* name GetBallAnimPal resolves for
  //                    wCurItem, or nil outside a ball throw
  //   env.sgb          hSGB, which only Sky Attack's palette cycle reads
  // Lua: AnimObjects.lua:110
  constructor(data?: AnimObjectData | null, constants?: Record<string, any> | null, env?: AnimEnv | null) {
    this.data = data ?? {};
    this.env = env ?? {};
    this.structs = [];
    for (let slot = 0; slot < NUM_STRUCTS; slot++) this.structs[slot] = newStruct();
    this.lastIndex = 0; // wLastAnimObjectIndex
    this.oam = [];

    constants = constants ?? {};
    this.objectOrder = constants.battleAnimObjectOrder ?? [];
    this.framesetOrder = constants.battleAnimFramesetOrder ?? [];
    // Name -> numeric id, because several functions do frameset ARITHMETIC
    // (`ld a, BATTLE_ANIM_FRAMESET_SOUND_1; add [hl]`) while the extractor
    // writes names.  Keeping the struct's FRAMESET_ID numeric is what makes
    // those adds mean the same thing they do on the cart.
    this.framesetIds = Object.create(null) as Record<string, number>;
    this.framesetOrder.forEach((name, index) => {
      this.framesetIds[name] = index;
    });
    // engine/battle_anims/functions.asm:1158
    this.hram = null;
    this.obp0 = null;
  }

  static new(data?: AnimObjectData | null, constants?: Record<string, any> | null, env?: AnimEnv | null): AnimObjectPool {
    return new AnimObjectPool(data, constants, env);
  }

  // Lua: AnimObjects.lua:136
  clear(): void {
    for (let slot = 0; slot < NUM_STRUCTS; slot++) this.structs[slot] = newStruct();
    this.lastIndex = 0;
    this.oam = [];
    this.obp0 = null;
  }

  // BattleAnimCmd_ClearObjs.  The cart's loop clears $a0 bytes from
  // wActiveAnimObjects and BATTLEANIMSTRUCT_LENGTH is $18, so it reaches six
  // whole structs plus the first sixteen bytes of the seventh -- enough to zero
  // that one's INDEX, and no further.  Structs 8-10 keep running: that is the
  // documented bug (docs/bugs_and_glitches.md), and an animation that spawns
  // more than seven objects visibly depends on it.
  // Lua: AnimObjects.lua:149
  clearObjs(): void {
    for (let slot = 0; slot < 7; slot++) this.structs[slot] = newStruct();
  }

  // Lua: AnimObjects.lua:153
  framesetId(name: string): number {
    const id = this.framesetIds[name];
    if (id === undefined) throw new Error(`unknown battle anim frameset: ${String(name)}`);
    return id;
  }

  // InitBattleAnimation.  The object row's six bytes land in the struct in
  // order; the seventh field, TILEID, comes from the tile dict instead
  // (GetBattleAnimTileOffset), because where a sheet ended up in VRAM is a
  // property of the running script and not of the object.
  // Lua: AnimObjects.lua:172
  queue(
    objectId: string | number,
    x: number,
    y: number,
    param?: number | null,
    tileOffsetFor?: ((gfx: any) => number | null | undefined | false) | null,
  ): AnimStruct | null {
    let name: string | number = objectId;
    if (typeof objectId === "number") {
      name = this.objectOrder[objectId] ?? objectId;
    }
    const object = (this.data.objects ?? {})[name];
    if (!truthy(object)) return null;
    for (let slot = 0; slot < NUM_STRUCTS; slot++) {
      const st = this.structs[slot]!;
      if (st.index === 0) {
        this.lastIndex = u8(this.lastIndex + 1);
        st.index = this.lastIndex;
        st.oamFlags = object.flags ?? 0;
        st.fixY = object.fixY ?? 0;
        st.framesetId = this.framesetIds[object.frameset] ?? 0;
        st.func = object.func ?? 0;
        st.palette = object.palette ?? 0;
        const tile = tileOffsetFor ? tileOffsetFor(object.gfx) : undefined;
        st.tileId = truthy(tile) ? (tile as number) : 0;
        st.x = u8(x);
        st.y = u8(y);
        st.xOffset = 0;
        st.yOffset = 0;
        st.param = u8(param ?? 0);
        st.duration = 0;
        st.frame = 0xff;
        st.jt = 0;
        st.var1 = 0;
        st.var2 = 0;
        st.objectId = name;
        return st;
      }
    }
    // QueueBattleAnimation returns carry when all ten are busy; the script does
    // not look, and neither does anything here.
    return null;
  }

  // Lua: AnimObjects.lua:205
  findByIndex(value: number): AnimStruct | null {
    for (let slot = 0; slot < NUM_STRUCTS; slot++) {
      const st = this.structs[slot]!;
      if (st.index === value) return st;
    }
    return null;
  }

  // Lua: AnimObjects.lua:213
  activeCount(): number {
    let count = 0;
    for (let slot = 0; slot < NUM_STRUCTS; slot++) {
      if (this.structs[slot]!.index !== 0) count = count + 1;
    }
    return count;
  }

  //------------------------------------------------------------------------
  // GetBattleAnimFrame (engine/battle_anims/helpers.asm)
  //------------------------------------------------------------------------

  // `oamwait n` is not skipped here: GetBattleAnimFrame stores n as the struct's
  // duration and hands the command itself back, so the struct genuinely spends
  // n frames drawing nothing.  Only BattleAnimOAMUpdate knows what to do with it.
  // Returns [oamset name | "wait" | "delete" | undefined, frame flip flags]
  // (the Lua's two return values).
  // Lua: AnimObjects.lua:237
  getFrame(st: AnimStruct): [string | number | undefined, number] {
    const frames = (this.data.framesets ?? {})[this.framesetOrder[st.framesetId] as string];
    if (!frames) return [undefined, 0];
    for (let n = 0; n < 64; n++) {
      if (st.duration !== 0) {
        st.duration = st.duration - 1;
        const row = frames[st.frame];
        if (!row) return [undefined, 0];
        return frameYield(row);
      }
      st.frame = u8(st.frame + 1);
      const row = frames[st.frame];
      if (!row) return [undefined, 0];
      const kind = row[0];
      if (kind === "restart") {
        st.duration = 0;
        st.frame = 0xff;
      } else if (kind === "end") {
        // Step back two so the next pass lands on the frame before this one and
        // then holds it forever.
        st.duration = 0;
        st.frame = u8(st.frame - 2);
      } else if (kind === "delete") {
        // `oamdelete` carries no argument; the cart reads the next byte as a
        // duration anyway and then throws the whole struct away, so it does not
        // matter what lands here.
        st.duration = 0;
        return ["delete", 0];
      } else if (kind === "wait") {
        st.duration = u8(row[1] as number);
        return ["wait", 0];
      } else {
        st.duration = u8(row[2] as number);
        return frameYield(row);
      }
    }
    throw new Error(`battle anim frameset never yields a frame: ${String(this.framesetOrder[st.framesetId])}`);
  }

  //------------------------------------------------------------------------
  // BattleAnimOAMUpdate (engine/battle_anims/core.asm)
  //------------------------------------------------------------------------

  // InitBattleAnimBuffer.  On the enemy's turn the whole object is reflected
  // onto the other side of the field -- but only if its OAMFLAGS ask for it.
  // Lua: AnimObjects.lua:290
  initBuffer(st: AnimStruct): AnimBuffer {
    const buf: AnimBuffer = {
      oamFlags: st.oamFlags & OAM_PRIO,
      palette: st.palette,
      tileId: st.tileId,
      x: st.x,
      y: st.y,
      xOffset: st.xOffset,
      yOffset: st.yOffset,
    };
    if ((this.env.battleTurn ?? 0) === 0) return buf;
    buf.oamFlags = st.oamFlags;
    if ((st.oamFlags & FIX_COORDS) === 0) return buf;
    // x' = (-10 tiles + 4) - x: reflected about the middle of the field.
    buf.x = u8((-10 * 8 + 4) - st.x);
    if (st.fixY === 0xff) {
      buf.y = u8(5 * 8 + st.y);
    } else {
      let y = u8(st.fixY - st.y);
      const animId = this.env.animId;
      // The three self-targeting animations whose object sits one tile higher
      // on the enemy's side.
      if (animId === "KINESIS" || animId === "SOFTBOILED" || animId === "MILK_DRINK") {
        y = u8(y - 8);
      }
      buf.y = y;
    }
    buf.xOffset = u8(-st.xOffset);
    return buf;
  }

  // One struct's OAM entries appended to this.oam.  Returns true once the
  // 40-object shadow OAM is full, which is the carry the caller stops on.
  // Lua: AnimObjects.lua:321
  updateOam(st: AnimStruct): boolean {
    const buf = this.initBuffer(st);
    const [oamsetName, frameFlags] = this.getFrame(st);
    if (oamsetName === "wait" || oamsetName === undefined) return false;
    if (oamsetName === "delete") {
      deinit(st);
      return false;
    }
    buf.oamFlags = (frameFlags ^ buf.oamFlags) & OAM_FLAG_MASK;
    const set = (this.data.oamsets ?? {})[oamsetName];
    if (!set) return false;
    const tileId = u8(buf.tileId + (set.vtile ?? 0));
    const yFlip = (buf.oamFlags & OAM_YFLIP) !== 0;
    const xFlip = (buf.oamFlags & OAM_XFLIP) !== 0;
    for (const entry of set.sprites ?? []) {
      if (this.oam.length >= OAM_LIMIT) return true;
      // GetSpriteOAMAttr: the frame's flip/priority flags toggle the entry's;
      // OAM_PAL1 passes through from the entry, and the palette slot comes from
      // the struct.
      let attr = ((entry.attr ?? 0) ^ buf.oamFlags) & OAM_FLAG_MASK;
      attr = attr + ((entry.attr ?? 0) & OAM_PAL1);
      this.oam.push({
        y: u8(buf.y + buf.yOffset + mirror(entry.y ?? 0, yFlip)),
        x: u8(buf.x + buf.xOffset + mirror(entry.x ?? 0, xFlip)),
        // BATTLEANIM_BASE_TILE is added here on the cart and subtracted again by
        // every sheet lookup, so the port keeps tiles in sheet-relative space.
        tile: u8(tileId + (entry.tile ?? 0)),
        attr,
        // battle_anims.json names every object's palette, so this is a
        // PAL_BATTLE_OB_* string (a raw id only for an unnamed row).
        palette: buf.palette as string,
      });
    }
    return false;
  }

  // BattleAnim_UpdateOAM_All: run every live struct's function, then let it
  // write its OAM entries.  A struct that deinitialises itself inside its
  // function still draws this frame, because the ASM calls BattleAnimOAMUpdate
  // unconditionally.
  // Lua: AnimObjects.lua:359
  playFrame(): AnimOamEntry[] {
    this.oam = [];
    for (let slot = 0; slot < NUM_STRUCTS; slot++) {
      const st = this.structs[slot]!;
      if (st.index !== 0) {
        const fn = AnimObjects.FUNCTIONS[st.func as string];
        if (fn) fn(this, st);
        if (this.updateOam(st)) break;
      }
    }
    return this.oam;
  }
}

//--------------------------------------------------------------------------
// engine/battle_anims/functions.asm
//--------------------------------------------------------------------------

// Lua: AnimObjects.lua:376
function incJt(st: AnimStruct): void {
  st.jt = u8(st.jt + 1);
}

// BattleAnim_StepToTarget: inches the object toward the opponent's side, half
// as far vertically as horizontally.  The `dec [hl]` loop runs BEFORE `dec e`
// is tested, so a vertical step of 0 walks the Y coordinate 256 times -- right
// back where it started, which is the point.
// Lua: AnimObjects.lua:382
function stepToTarget(st: AnimStruct, speed: number): void {
  const e = speed & 0xf;
  st.x = u8(st.x + e);
  const steps = e >>> 1;
  st.y = u8(st.y - (steps === 0 ? 256 : steps));
}

// BattleAnim_StepCircle: circular movement whose height is a quarter of its
// width.
// Lua: AnimObjects.lua:391
function stepCircle(st: AnimStruct, angle: number, radius: number): void {
  st.yOffset = sra(sra(sine(angle, radius)));
  st.xOffset = cosine(angle, radius);
}

// A 16-bit accumulator spread over two byte fields, which is how every
// sub-pixel movement here is done: the HIGH byte is the pixel coordinate and
// the LOW byte the fraction.
// Lua: AnimObjects.lua:399
function add16(high: number, low: number, delta: number): [number, number] {
  const value = mod(u8(high) * 256 + u8(low) + delta, 0x10000);
  return [Math.floor(value / 256), value % 256];
}

const F: Record<string, AnimFunc> = {};

// Lua: AnimObjects.lua:406
F.BATTLE_ANIM_FUNC_NULL = (_, st) => {
  // anim_incobj is what walks this one to `.one`, which deletes the object.
  if (st.jt !== 0) deinit(st);
};

// BattleAnimFunction_ThrowFromUserToTarget: right 2 and up 1 a frame, with the
// object's PARAM as the amplitude of a sine on the Y offset.  Returns true for
// "still going", which is the carry the AndDisappear wrapper reads.
// Lua: AnimObjects.lua:414
function throwToTarget(st: AnimStruct): boolean {
  if (st.x >= 0x88) return false;
  st.x = u8(st.x + 2);
  st.y = u8(st.y - 1);
  const angle = st.var1;
  st.var1 = u8(st.var1 - 1);
  st.yOffset = sine(angle, st.param);
  return true;
}

// Lua: AnimObjects.lua:424
F.BATTLE_ANIM_FUNC_THROW_TO_TARGET = (_, st) => {
  throwToTarget(st);
};

// Lua: AnimObjects.lua:426
F.BATTLE_ANIM_FUNC_THROW_TO_TARGET_DISAPPEAR = (_, st) => {
  if (!throwToTarget(st)) deinit(st);
};

// Lua: AnimObjects.lua:430
F.BATTLE_ANIM_FUNC_WAVE_TO_TARGET = (_, st) => {
  if (st.x >= 0x88) {
    deinit(st);
    return;
  }
  st.x = u8(st.x + 2);
  st.y = u8(st.y - 1);
  const angle = st.var1;
  st.var1 = u8(st.var1 + 4);
  st.yOffset = sine(angle, 0x10);
  // The X offset is the cosine divided by sixteen, so the wave is much
  // flatter across than it is up.
  st.xOffset = sra(sra(sra(sra(cosine(angle, 0x10)))));
};

// Lua: AnimObjects.lua:445
F.BATTLE_ANIM_FUNC_MOVE_IN_CIRCLE = (_, st) => {
  if (st.jt === 0) {
    incJt(st);
    // Bit 7 of PARAM starts the object half a turn round; the rest is the
    // radius, so the flag has to come off before it is used as one.
    st.var1 = (st.param & 0x80) !== 0 ? 0x20 : 0;
    st.param = st.param & 0x7f;
  }
  const angle = st.var1;
  st.yOffset = sine(angle, st.param);
  st.xOffset = cosine(angle, st.param);
  st.var1 = u8(st.var1 + 1);
};

// Lua: AnimObjects.lua:459
F.BATTLE_ANIM_FUNC_USER_TO_TARGET = (_, st) => {
  if (st.jt !== 0) {
    deinit(st);
    return;
  }
  if (st.x >= 0x84) return;
  stepToTarget(st, st.param);
};

// Lua: AnimObjects.lua:468
F.BATTLE_ANIM_FUNC_USER_TO_TARGET_DISAPPEAR = (_, st) => {
  if (st.x >= 0x84) {
    deinit(st);
    return;
  }
  stepToTarget(st, st.param);
};

// GetBallAnimPal: the thrown ball wears the colour of the ball being thrown
// (data/battle_anims/ball_colors.asm).  The battle screen resolves that for
// wCurItem and hands it over as env.ballPalette.
// Lua: AnimObjects.lua:479
function ballPal(self: AnimObjectPool, st: AnimStruct): void {
  if (truthy(self.env.ballPalette)) st.palette = self.env.ballPalette as string;
}

// .four: the ball bounces on a shrinking sine while VAR2 steps down by four;
// when it reaches zero the ball opens.
// Lua: AnimObjects.lua:485
function pokeballBounce(self: AnimObjectPool, st: AnimStruct): void {
  st.yOffset = sine(st.var1, st.var2);
  st.var1 = u8(st.var1 - 1);
  if ((st.var1 & 0x1f) !== 0) return;
  // `ld [hl], a` after the mask: VAR1 is zeroed, not just left on a boundary,
  // so every bounce starts from the same phase.
  st.var1 = 0;
  st.var2 = u8(st.var2 - 4);
  if (st.var2 !== 0) return;
  reinit(st, self.framesetId("BATTLE_ANIM_FRAMESET_POKE_BALL_4"));
  incJt(st);
}

// .eight/.ten: the same sine, but every $10 steps the jumptable advances, so
// the caught / broke-free branch is only ever reached on a shake boundary.
// Lua: AnimObjects.lua:500
function pokeballWobble(_self: AnimObjectPool, st: AnimStruct): void {
  st.yOffset = sine(st.var1, st.var2);
  st.var1 = u8(st.var1 - 1);
  if ((st.var1 & 0x1f) === 0) {
    deinit(st);
    return;
  }
  if ((st.var1 & 0xf) !== 0) return;
  incJt(st);
}

// Lua: AnimObjects.lua:511
F.BATTLE_ANIM_FUNC_POKEBALL = (self, st) => {
  const jt = st.jt;
  if (jt === 0) {
    ballPal(self, st);
    incJt(st);
  } else if (jt === 1) {
    if (throwToTarget(st)) return;
    // The arc's Y offset is folded into the coordinate before the ball
    // switches to its opening frameset, so it lands where it fell.
    st.y = u8(st.y + st.yOffset);
    reinit(st, self.framesetId("BATTLE_ANIM_FRAMESET_POKE_BALL_3"));
    incJt(st);
  } else if (jt === 3) {
    incJt(st);
    reinit(st, self.framesetId("BATTLE_ANIM_FRAMESET_POKE_BALL_1"));
    st.var1 = 0;
    st.var2 = 0x10;
    pokeballBounce(self, st); // .three falls into .four
  } else if (jt === 4) {
    pokeballBounce(self, st);
  } else if (jt === 6) {
    reinit(st, self.framesetId("BATTLE_ANIM_FRAMESET_POKE_BALL_5"));
    st.jt = u8(st.jt - 1);
  } else if (jt === 7) {
    ballPal(self, st);
    reinit(st, self.framesetId("BATTLE_ANIM_FRAMESET_POKE_BALL_2"));
    incJt(st);
    st.var2 = 0x20;
    pokeballWobble(self, st); // .seven falls into .eight
  } else if (jt === 8 || jt === 10) {
    pokeballWobble(self, st);
  } else if (jt === 11) {
    deinit(st);
  }
};

// Lua: AnimObjects.lua:546
function pokeballBlockedFall(_self: AnimObjectPool, st: AnimStruct): void {
  if (st.y >= 0x80) {
    deinit(st);
    return;
  }
  st.y = u8(st.y + 4);
  st.x = u8(st.x - 2);
}

// Lua: AnimObjects.lua:555
F.BATTLE_ANIM_FUNC_POKEBALL_BLOCKED = (self, st) => {
  const jt = st.jt;
  if (jt === 0) {
    ballPal(self, st);
    incJt(st);
  } else if (jt === 1) {
    if (st.x < 0x70) {
      throwToTarget(st);
      return;
    }
    incJt(st);
    pokeballBlockedFall(self, st); // .next falls into .two
  } else if (jt === 2) {
    pokeballBlockedFall(self, st);
  }
};

// Lua: AnimObjects.lua:572
F.BATTLE_ANIM_FUNC_EMBER = (self, st) => {
  const jt = st.jt;
  if (jt === 0) {
    // The upper nybble of PARAM picks which branch this object runs.
    st.jt = swap(st.param) & 0xf;
  } else if (jt === 1) {
    if (st.x >= 0x88) return;
    stepToTarget(st, st.param);
  } else if (jt === 2) {
    deinit(st);
  } else if (jt === 3) {
    incJt(st);
    reinit(st, self.framesetId("BATTLE_ANIM_FRAMESET_FLAMETHROWER"));
  }
};

// Lua: AnimObjects.lua:588
F.BATTLE_ANIM_FUNC_DROP = (_, st) => {
  if (st.jt === 0) {
    incJt(st);
    st.var1 = 0x30;
    st.var2 = 0x48;
  }
  st.yOffset = sine(st.var1, st.var2);
  st.var1 = u8(st.var1 + 1);
  if ((st.var1 & 0x3f) !== 0) return;
  st.var1 = 0x20;
  // Each bounce loses PARAM off the amplitude; once that would go to zero or
  // below, the object is done.
  const left = st.var2 - st.param;
  if (left <= 0) {
    deinit(st);
    return;
  }
  st.var2 = left;
};

// Lua: AnimObjects.lua:607
F.BATTLE_ANIM_FUNC_USER_TO_TARGET_SPIN = (_, st) => {
  // .SetCoords: the lower nybble of PARAM is the horizontal step, half of it
  // the vertical one.
  const setCoords = (): void => {
    const e = st.param & 0xf;
    st.x = u8(st.x + e);
    const steps = e >>> 1;
    st.y = u8(st.y - (steps === 0 ? 256 : steps));
  };
  // .two: a circle whose top is flattened -- the cosine is pulled down by its
  // own radius and halved.
  const orbit = (): void => {
    if (st.var1 < 0x40) {
      st.yOffset = sra(u8(cosine(st.var1, 0x18) - 0x18));
      st.xOffset = sine(st.var1, 0x18);
      st.var1 = u8(st.var1 + (st.param & 0xf));
      return;
    }
    // .loop_back: the upper nybble is a lap counter.
    const laps = st.param & 0xf0;
    if (laps === 0) {
      incJt(st); // .finish falls into .three
      if (st.x >= 0xb0) {
        deinit(st);
      } else {
        setCoords();
      }
      return;
    }
    st.param = (st.param & 0xf) + (laps - 0x10);
    st.jt = u8(st.jt - 1);
  };
  const jt = st.jt;
  if (jt === 0) {
    if (st.x < 0x80) {
      setCoords();
      return;
    }
    // .next -> .one -> .two, all on this frame.
    incJt(st);
    incJt(st);
    st.var1 = 0;
    orbit();
  } else if (jt === 1) {
    incJt(st);
    st.var1 = 0;
    orbit();
  } else if (jt === 2) {
    orbit();
  } else if (jt === 3) {
    if (st.x >= 0xb0) {
      deinit(st);
      return;
    }
    setCoords();
  }
};

// Lua: AnimObjects.lua:665
F.BATTLE_ANIM_FUNC_SHAKE = (_, st) => {
  // .done_one: hold for the upper nybble of PARAM, then jump to the other side.
  const flip = (): void => {
    st.var1 = swap(st.param) & 0xf;
    st.xOffset = u8(-st.xOffset);
  };
  const jt = st.jt;
  if (jt === 0) {
    incJt(st);
    st.var1 = 0;
    st.xOffset = st.param & 0xf;
    flip(); // .zero falls into .one, and VAR1 is 0, so .done_one runs at once
  } else if (jt === 1) {
    if (st.var1 !== 0) {
      st.var1 = st.var1 - 1;
      return;
    }
    flip();
  } else if (jt === 2) {
    deinit(st);
  }
};

// Lua: AnimObjects.lua:688
F.BATTLE_ANIM_FUNC_FIRE_BLAST = (self, st) => {
  // .eight: the travelling flame spirals once it arrives.
  const spin = (): void => {
    const angle = st.var1;
    st.yOffset = sine(angle, 0x10);
    st.xOffset = cosine(angle, 0x10);
    st.var1 = u8(st.var1 + 1);
  };
  // .seven: straight across, then hand over to the spiral.
  const travel = (): void => {
    if (st.x < 0x88) {
      st.x = u8(st.x + 2);
      st.y = u8(st.y - 1);
      return;
    }
    incJt(st);
    reinit(st, self.framesetId("BATTLE_ANIM_FRAMESET_EMBER"));
    spin(); // .set_up_eight falls into .eight
  };
  const jt = st.jt;
  if (jt === 0) {
    // PARAM picks the branch outright: 7 is the flame that travels, and the
    // rest are the five arms of the blast, which only drift.
    st.jt = st.param;
    if (st.param === 7) {
      travel();
    } else {
      reinit(st, self.framesetId("BATTLE_ANIM_FRAMESET_BURNED"));
    }
  } else if (jt === 1) {
    st.yOffset = u8(st.yOffset - 1);
  } else if (jt === 2) {
    st.xOffset = u8(st.xOffset - 1);
  } else if (jt === 3) {
    st.xOffset = u8(st.xOffset + 1);
  } else if (jt === 4) {
    st.yOffset = u8(st.yOffset + 1);
    st.xOffset = u8(st.xOffset - 1);
  } else if (jt === 5) {
    st.yOffset = u8(st.yOffset + 1);
    st.xOffset = u8(st.xOffset + 1);
  } else if (jt === 7) {
    travel();
  } else if (jt === 8) {
    spin();
  } else if (jt === 9) {
    deinit(st);
  }
};

// BattleAnim_ScatterHorizontal: a 16-bit per-frame X step picked from the
// object's PARAM, so a screenful of leaves fans out instead of moving as one.
// Lua: AnimObjects.lua:740
function scatterHorizontal(st: AnimStruct): number {
  const param = st.param;
  if ((param & 0x80) === 0) {
    if (param >= 0x20) return 0x100;
    if (param >= 0x18) return 0x180;
    return 0x200;
  }
  const masked = param & 0x3f;
  if (masked >= 0x20) return -0x100;
  if (masked >= 0x18) return -0x180;
  return -0x200;
}

// Lua: AnimObjects.lua:753
F.BATTLE_ANIM_FUNC_RAZOR_LEAF = (self, st) => {
  const arcStep = (): void => {
    const radius = st.param & 0x3f;
    const angle = st.var1;
    st.var1 = u8(st.var1 - 1);
    st.yOffset = sine(angle, radius);
    [st.x, st.var2] = add16(st.x, st.var2, scatterHorizontal(st));
  };
  const arcOrLand = (): void => {
    if (st.var1 >= 0x30) {
      arcStep();
      return;
    }
    incJt(st);
    st.var1 = 0;
    st.var2 = 0;
    reinit(st, self.framesetId("BATTLE_ANIM_FRAMESET_RAZOR_LEAF_2"));
    // Bit 6 starts the second frameset six frames in, which is the leaf
    // already half-turned.
    if ((st.param & 0x40) !== 0) st.frame = 5;
  };
  const jt = st.jt;
  if (jt === 0) {
    incJt(st);
    st.var1 = 0x40;
    arcOrLand(); // .zero falls into .one
  } else if (jt === 1) {
    arcOrLand();
  } else if (jt === 2) {
    if (st.yOffset === 0x20) {
      deinit(st);
      return;
    }
    st.xOffset = sine(st.var1, 0x10);
    if ((st.param & 0x40) !== 0) {
      st.var1 = u8(st.var1 - 1);
    } else {
      st.var1 = u8(st.var1 + 1);
    }
    [st.yOffset, st.var2] = add16(st.yOffset, st.var2, 0x80);
  } else if (jt === 3) {
    reinit(st, self.framesetId("BATTLE_ANIM_FRAMESET_RAZOR_LEAF_1"));
    st.oamFlags = st.oamFlags & (0xff - OAM_XFLIP);
    incJt(st);
  } else if (jt >= 4 && jt <= 7) {
    incJt(st);
  } else if (jt === 8) {
    if (st.x >= 0xc0) return;
    stepToTarget(st, 8);
  }
};

// Lua: AnimObjects.lua:804
F.BATTLE_ANIM_FUNC_ROCK_SMASH = (self, st) => {
  if (st.jt === 0) {
    // Bit 6 picks between the two rock framesets.
    st.framesetId = u8(rlca(rlca(st.param & 0x40)) + self.framesetId("BATTLE_ANIM_FRAMESET_BIG_ROCK"));
    incJt(st);
    st.var1 = 0x40;
  }
  if (st.var1 < 0x30) {
    deinit(st);
    return;
  }
  const radius = st.param & 0x3f;
  const angle = st.var1;
  st.var1 = u8(st.var1 - 1);
  st.yOffset = sine(angle, radius);
  [st.x, st.var2] = add16(st.x, st.var2, scatterHorizontal(st));
};

// Lua: AnimObjects.lua:823
F.BATTLE_ANIM_FUNC_BUBBLE = (self, st) => {
  let jt = st.jt;
  if (jt === 0) {
    incJt(st);
    st.var1 = 0xc;
    jt = 1;
  }
  if (jt === 1) {
    if (st.var1 !== 0) {
      st.var1 = st.var1 - 1;
      stepToTarget(st, st.param);
      return;
    }
    incJt(st);
    st.var1 = 0;
    reinit(st, self.framesetId("BATTLE_ANIM_FRAMESET_PULSING_BUBBLE"));
    return;
  }
  if (jt !== 2) return;
  if (st.x < 0x98) {
    [st.x, st.var1] = add16(st.x, st.var1, 0x60);
  }
  if (st.y < 0x20) return;
  // The upper nybble of PARAM is a per-frame rise; `ld d, $ff` is what makes
  // it a NEGATIVE 16-bit step.
  [st.y, st.var2] = add16(st.y, st.var2, (st.param & 0xf0) - 0x100);
};

// engine/battle_anims/functions.asm:1148
// Lua: AnimObjects.lua:852
F.BATTLE_ANIM_FUNC_SURF = (self, st) => {
  const hram = self.hram;
  const jt = st.jt;
  if (jt === 0) {
    incJt(st);
    if (truthy(hram)) {
      hram.lcdc = "SCY";
      hram.lyStart = 0x58;
      hram.lyEnd = 0x5e;
    }
    return;
  }
  if (jt === 1) {
    if (st.y < st.param) {
      incJt(st);
      if (truthy(hram)) hram.lyStart = 0;
      return;
    }
    st.y = u8(st.y - 1);
    st.yOffset = sine(st.var1, 0x10);
    const top = st.yOffset + st.y - 0x10;
    // `ret c`: the wave stops climbing entirely on the frames the subtraction
    // underflows, offsets and all.
    if (top < 0) return;
    if (truthy(hram)) hram.lyStart = u8(top);
    st.xOffset = (st.xOffset + 1) & 7;
    st.var1 = u8(st.var1 + 2);
    return;
  }
  if (jt === 3) {
    if (st.y >= 0x70) {
      if (truthy(hram)) {
        hram.lcdc = null; // Lua nil
        hram.lyStart = 0;
        hram.lyEnd = 0;
      }
      deinit(st);
      return;
    }
    st.y = u8(st.y + 2);
    const top = st.y - 0x10;
    if (top < 0) return;
    if (truthy(hram)) hram.lyStart = u8(top);
    return;
  }
  if (jt === 4) deinit(st);
};

// Lua: AnimObjects.lua:896
F.BATTLE_ANIM_FUNC_SING = (self, st) => {
  if (st.jt === 0) {
    incJt(st);
    reinit(st, self.framesetId("BATTLE_ANIM_FRAMESET_MUSIC_NOTE_1") + st.param);
  }
  if (st.x >= 0xb8) {
    deinit(st);
    return;
  }
  stepToTarget(st, 2);
  const angle = st.var1;
  st.var1 = u8(st.var1 - 1);
  st.yOffset = sine(angle, 8);
};

// Lua: AnimObjects.lua:911
F.BATTLE_ANIM_FUNC_WATER_GUN = (self, st) => {
  let jt = st.jt;
  if (jt === 0) {
    incJt(st);
    jt = 1;
  }
  if (jt === 1) {
    if (st.y >= 0x30) {
      stepToTarget(st, 2);
      const angle = st.var1;
      st.var1 = u8(st.var1 - 1);
      st.yOffset = sine(angle, 8);
      return;
    }
    incJt(st);
    reinit(st, self.framesetId("BATTLE_ANIM_FRAMESET_WATER_GUN_2"));
    st.yOffset = 0;
    st.y = 0x30;
    // Everything but FIX_COORDS is dropped, so the splash never flips.
    st.oamFlags = st.oamFlags & FIX_COORDS;
    jt = 2;
  }
  if (jt !== 2) return;
  if (st.yOffset >= 0x18) {
    incJt(st);
    reinit(st, self.framesetId("BATTLE_ANIM_FRAMESET_WATER_GUN_3"));
    return;
  }
  st.yOffset = u8(st.yOffset + 1);
};

// Lua: AnimObjects.lua:942
F.BATTLE_ANIM_FUNC_POWDER = (_, st) => {
  if (st.yOffset >= 0x38) {
    deinit(st);
    return;
  }
  [st.yOffset, st.var1] = add16(st.yOffset, st.var1, 0x80);
  // Shakes sixteen pixels either side by toggling one bit.
  st.xOffset = st.xOffset ^ 0x10;
};

// Lua: AnimObjects.lua:952
F.BATTLE_ANIM_FUNC_RECOVER = (_, st) => {
  if (st.jt === 0) {
    incJt(st);
    st.var2 = st.param & 0xf0; // radius
    st.var1 = u8((st.param & 0xf) * 8); // starting angle
    st.param = 1; // reused as an every-other-frame toggle
  }
  if (st.var2 === 0) {
    deinit(st);
    return;
  }
  const angle = st.var1;
  st.var1 = u8(st.var1 + 1);
  st.yOffset = sine(angle, st.var2);
  st.xOffset = cosine(angle, st.var2);
  st.param = st.param ^ 1;
  if (st.param === 0) return;
  st.var2 = u8(st.var2 - 1);
};

// Lua: AnimObjects.lua:972
F.BATTLE_ANIM_FUNC_THUNDER_WAVE = (self, st) => {
  if (st.jt === 1) {
    incJt(st);
    reinit(st, self.framesetId("BATTLE_ANIM_FRAMESET_THUNDER_WAVE_EXTRA"));
  } else if (st.jt === 3) {
    deinit(st);
  }
};

// Clamp/Encore: two halves clap together, twice.  The frameset the object
// switches to is the base or the base + 1 (CLAMP_FLIPPED / ENCORE_HAND_
// FLIPPED), picked by the SIGN of the sine, so both halves close together.
// Lua: AnimObjects.lua:984
F.BATTLE_ANIM_FUNC_CLAMP_ENCORE = (_self, st) => {
  const step = (): void => {
    const value = sine(st.var1, st.param);
    st.xOffset = value;
    reinit(st, (value & 0x80) !== 0 ? st.var2 : u8(st.var2 + 1));
    st.var1 = u8(st.var1 + 1);
    if ((st.var1 & 0x1f) !== 0) return;
    incJt(st); // falls into .two, which is a bare IncAnonJumptableIndex
  };
  const jt = st.jt;
  if (jt === 0) {
    incJt(st);
    st.var2 = st.framesetId;
    st.var1 = (st.param & 0x80) !== 0 ? 0x30 : 0x10;
    st.param = st.param & 0x7f;
    step();
  } else if (jt === 1) {
    step();
  } else if (jt >= 2 && jt <= 5) {
    incJt(st);
  } else if (jt === 6) {
    st.jt = 1;
  }
};

// Lua: AnimObjects.lua:1009
F.BATTLE_ANIM_FUNC_BITE = (self, st) => {
  const step = (): void => {
    const value = sine(st.var1, st.param);
    st.yOffset = value;
    reinit(
      st,
      (value & 0x80) !== 0
        ? self.framesetId("BATTLE_ANIM_FRAMESET_BITE_1")
        : self.framesetId("BATTLE_ANIM_FRAMESET_BITE_2"),
    );
    st.var1 = u8(st.var1 + 2);
    if ((st.var1 & 0x1f) !== 0) return;
    incJt(st);
  };
  const jt = st.jt;
  if (jt === 0) {
    incJt(st);
    st.var1 = (st.param & 0x80) !== 0 ? 0x30 : 0x10;
    st.param = st.param & 0x7f;
    step();
  } else if (jt === 1) {
    step();
  } else if (jt >= 2 && jt <= 5) {
    incJt(st);
  } else if (jt === 6) {
    st.jt = 1;
  }
};

// Lua: AnimObjects.lua:1035
F.BATTLE_ANIM_FUNC_SOLAR_BEAM = (_, st) => {
  if (st.jt === 0) {
    incJt(st);
    st.var1 = 0x28;
    st.var2 = 0;
  }
  const angle = st.param;
  st.yOffset = sine(angle, st.var1);
  st.xOffset = cosine(angle, st.var1);
  if (st.var1 === 0) {
    deinit(st);
    return;
  }
  // The radius is a 16-bit value shrinking half a pixel a frame.
  [st.var1, st.var2] = add16(st.var1, st.var2, -0x80);
};

// The gust's radius comes from a nine-entry table, so the whirl pulses rather
// than turning at a constant width.
// Lua: AnimObjects.lua:1053
const GUST_OFFSETS: readonly number[] = [8, 6, 5, 4, 5, 6, 8, 12, 16];

// Lua: AnimObjects.lua:1056
F.BATTLE_ANIM_FUNC_GUST = (_, st) => {
  const wobble = (): void => {
    const radius = GUST_OFFSETS[st.var2] ?? 8;
    const angle = st.var1;
    // Height is a sixteenth of the width, plus PARAM's own drift.
    st.yOffset = u8(sra(sra(sra(sra(sine(angle, radius))))) + st.param);
    st.xOffset = cosine(angle, radius);
    st.var1 = u8(st.var1 - 8);
    // PARAM counts DOWN from 0 through $ff; once it drops below $c2 the whirl
    // settles back to the middle.
    if (st.param !== 0 && st.param < 0xc2) {
      st.var2 = 0;
      st.param = 0;
      st.xOffset = 0;
      st.yOffset = 0;
      return;
    }
    st.param = u8(st.param - 1);
    if ((st.param & 7) !== 0) return;
    st.var2 = u8(st.var2 + 1);
  };
  const move = (): void => {
    wobble();
    st.x = u8(st.x + 1);
    if ((st.x & 1) !== 0) return;
    st.y = u8(st.y - 1);
  };
  const jt = st.jt;
  if (jt === 0) {
    incJt(st);
    st.param = 0;
    wobble(); // .zero falls into .one
  } else if (jt === 1 || jt === 3) {
    wobble();
  } else if (jt === 2) {
    if (st.x < 0x88) {
      move();
    } else {
      incJt(st);
    }
  } else if (jt === 4) {
    if (st.x < 0xb8) {
      move();
    } else {
      deinit(st);
    }
  }
};

// Lua: AnimObjects.lua:1102
F.BATTLE_ANIM_FUNC_ABSORB = (_, st) => {
  if (st.x < 0x30) {
    deinit(st);
    return;
  }
  const e = st.param & 0xf;
  st.x = u8(st.x - e);
  const steps = e >>> 1;
  st.y = u8(st.y + (steps === 0 ? 256 : steps));
};

// Lua: AnimObjects.lua:1113
F.BATTLE_ANIM_FUNC_WRAP = (_, st) => {
  // anim_incobj walks the frameset one step along the BIND_1..4 run.
  if (st.jt !== 1) return;
  reinit(st, u8(st.framesetId + 1));
  incJt(st);
  st.var1 = 8;
};

// BattleAnim_StepThrownToTarget: a parabola whose horizontal step is PARAM's
// two nybbles read as a 16-bit fixed-point number -- the LOW nybble is the
// fraction and the HIGH nybble the whole pixels, which is the reverse of how
// the macro's argument reads.
// Lua: AnimObjects.lua:1125
function stepThrownToTarget(st: AnimStruct): void {
  st.var2 = u8(st.var2 - 1);
  st.yOffset = sine(st.var2, 0x20);
  st.fixY = u8(st.fixY + 2);
  const step = ((st.param & 0xf0) >>> 4) * 256 + swap(st.param & 0xf);
  [st.x, st.var1] = add16(st.x, st.var1, step);
  if ((st.var2 & 1) !== 0) return;
  st.y = u8(st.y - 1);
}

// Lua: AnimObjects.lua:1136
F.BATTLE_ANIM_FUNC_LEECH_SEED = (self, st) => {
  const jt = st.jt;
  if (jt === 0) {
    incJt(st);
    st.var2 = 0x40;
  } else if (jt === 1) {
    if (st.var2 >= 0x20) {
      stepThrownToTarget(st);
      return;
    }
    st.var2 = 0x40;
    reinit(st, self.framesetId("BATTLE_ANIM_FRAMESET_LEECH_SEED_2"));
    incJt(st);
  } else if (jt === 2) {
    if (st.var2 !== 0) {
      st.var2 = st.var2 - 1;
      return;
    }
    incJt(st);
    reinit(st, self.framesetId("BATTLE_ANIM_FRAMESET_LEECH_SEED_3"));
  }
};

// Lua: AnimObjects.lua:1159
F.BATTLE_ANIM_FUNC_SPIKES = (_, st) => {
  const jt = st.jt;
  if (jt === 0) {
    incJt(st);
    st.var2 = 0x40;
  } else if (jt === 1) {
    if (st.var2 >= 0x20) {
      stepThrownToTarget(st);
      return;
    }
    incJt(st);
  }
};

// Lua: AnimObjects.lua:1173
F.BATTLE_ANIM_FUNC_RAZOR_WIND = (self, st) => {
  F.BATTLE_ANIM_FUNC_MOVE_IN_CIRCLE!(self, st);
  // Fifteen extra steps a frame, so the object races round the circle.
  st.var1 = u8(st.var1 + 0xf);
};

// Lua: AnimObjects.lua:1179
function kickRoll(_self: AnimObjectPool, st: AnimStruct): void {
  if (st.x >= 0x98) return;
  st.x = u8(st.x + 2);
  const angle = st.var1;
  st.var1 = u8(st.var1 + 1);
  st.yOffset = sine(angle, 8);
}

// Lua: AnimObjects.lua:1187
F.BATTLE_ANIM_FUNC_KICK = (self, st) => {
  const jt = st.jt;
  if (jt === 1) {
    if (st.y < 0x30) {
      st.y = u8(st.y + 4);
      return;
    }
    st.jt = 0;
  } else if (jt === 2) {
    if (st.x >= 0x98) return;
    st.x = u8(st.x + 2);
    // The kick pins itself to the target's side and holds one frame.
    st.oamFlags = st.oamFlags | FIX_COORDS;
    st.fixY = 0x90;
    st.frame = 0;
    st.duration = 2;
    st.y = u8(st.y - 1);
  } else if (jt === 3) {
    incJt(st);
    st.var1 = 0x2c;
    st.frame = 0;
    st.duration = 0x80;
    kickRoll(self, st); // .three falls into .four
  } else if (jt === 4) {
    kickRoll(self, st);
  }
};

// Lua: AnimObjects.lua:1215
F.BATTLE_ANIM_FUNC_EGG = (self, st) => {
  // .EggVerticalWaveMotion, shared by both openings.
  const wave = (): void => {
    st.yOffset = sine(st.var1, st.var2);
    st.var1 = u8(st.var1 + 1);
    if ((st.var1 & 0x3f) !== 0) return;
    st.var1 = 0x20;
    st.var2 = u8(st.var2 - 8);
    if (st.var2 !== 0) return;
    st.var1 = 0;
    st.var2 = 0;
    incJt(st);
  };
  // .egg_bomb_step: the egg drifts up half a pixel a frame while it travels.
  const step = (): void => {
    st.x = u8(st.x + 1);
    [st.y, st.var1] = add16(st.y, st.var1, -0x80);
  };
  const jt = st.jt;
  if (jt === 0) {
    // The object starts here and then jumps to whichever branch PARAM names,
    // which is how one object serves both Egg Bomb and Softboiled.
    st.var1 = 0x28;
    st.var2 = 0x10;
    st.jt = st.param;
  } else if (jt === 1) {
    if (st.x < 0x40) st.x = u8(st.x + 1);
    wave();
  } else if (jt === 2) {
    if (st.x >= 0x88) {
      incJt(st);
      incJt(st); // .egg_bomb_done skips straight to .four
      return;
    }
    if ((st.x & 0xf) !== 0) {
      step();
      return;
    }
    st.var2 = 0x10;
    incJt(st);
  } else if (jt === 3) {
    if (st.var2 !== 0) {
      st.var2 = st.var2 - 1;
      return;
    }
    st.jt = u8(st.jt - 1);
    step();
  } else if (jt === 5) {
    deinit(st);
  } else if (jt === 6) {
    if (st.x < 0x4b) st.x = u8(st.x + 1);
    wave();
  } else if (jt === 7) {
    reinit(st, self.framesetId("BATTLE_ANIM_FRAMESET_EGG_WOBBLE"));
    incJt(st);
  } else if (jt === 8) {
    const angle = st.var1;
    st.var1 = u8(st.var1 + 2);
    st.xOffset = sine(angle, 2);
  } else if (jt === 9) {
    reinit(st, self.framesetId("BATTLE_ANIM_FRAMESET_EGG_CRACKED_BOTTOM"));
    st.yOffset = 4;
    incJt(st);
  } else if (jt === 11) {
    reinit(st, self.framesetId("BATTLE_ANIM_FRAMESET_EGG_CRACKED_TOP"));
    incJt(st);
    st.var1 = 0x40;
  } else if (jt === 12) {
    st.yOffset = sine(st.var1, 0x20);
    if (st.var1 < 0x30) {
      incJt(st);
      return;
    }
    st.var1 = u8(st.var1 - 1);
  }
};

// Lua: AnimObjects.lua:1290
F.BATTLE_ANIM_FUNC_MOVE_UP = (_, st) => {
  // Runs while the offset is 0 or already past $d8 going negative; anything
  // in between is "far enough up" and ends the object.
  if (st.yOffset !== 0 && st.yOffset < 0xd8) {
    deinit(st);
    return;
  }
  st.yOffset = u8(st.yOffset - st.param);
};

// Lua: AnimObjects.lua:1300
F.BATTLE_ANIM_FUNC_SOUND = (self, st) => {
  const motion = (): void => {
    const angle = st.var2;
    st.var2 = u8(st.var2 + 2);
    const value = sine(angle, 0x10);
    st.xOffset = value;
    if (st.param === 0) {
      st.yOffset = u8(-value);
    } else if (st.param !== 1) {
      st.yOffset = value;
    }
    // PARAM 1 leaves the Y offset alone: that is the flat sideways wave.
  };
  if (st.jt === 0) {
    if ((self.env.battleTurn ?? 0) !== 0) {
      // `xor $ff; add $3` is 2 - param: the enemy's three angles are the
      // player's three mirrored, 0 <-> 2.
      st.param = u8(2 - st.param);
    }
    incJt(st);
    st.var1 = 8;
    reinit(st, self.framesetId("BATTLE_ANIM_FRAMESET_SOUND_1") + st.param);
    return;
  }
  if (st.var1 === 0) {
    deinit(st);
    return;
  }
  st.var1 = st.var1 - 1;
  motion();
};

// Lua: AnimObjects.lua:1332
F.BATTLE_ANIM_FUNC_CONFUSE_RAY = (self, st) => {
  if (st.jt === 0) {
    incJt(st);
    st.var2 = st.param & 0x3f;
    // Bit 7 becomes both the frameset offset and, once swapped, the radius.
    st.param = rlca(st.param & 0x80);
    reinit(st, self.framesetId("BATTLE_ANIM_FRAMESET_CONFUSE_RAY_1") + st.param);
    return;
  }
  const radius = swap(st.param);
  const angle = st.var2;
  st.var2 = u8(st.var2 + 1);
  st.yOffset = sine(angle, radius);
  st.xOffset = cosine(angle, radius);
  if (st.x >= 0x80) return;
  // Both tests read the NEW VAR2, and the second `and $1` is applied to what
  // the first `and $3` left, not to the register again.
  const phase = st.var2 & 3;
  if (phase === 0) st.y = u8(st.y - 1);
  if ((phase & 1) !== 0) return;
  st.x = u8(st.x + 1);
};

// Lua: AnimObjects.lua:1355
F.BATTLE_ANIM_FUNC_DIZZY = (_, st) => {
  if (st.jt === 0) {
    incJt(st);
    st.var1 = st.framesetId;
    reinit(st, u8(st.var1 + rlca(st.param & 0x80)));
    st.param = st.param & 0x7f;
  }
  const angle = st.param;
  st.yOffset = sra(sra(sine(angle, 0x10)));
  st.xOffset = cosine(angle, 0x10);
  // `ld a, [hl]` then `inc [hl]`: the frameset flip tests the PRE-increment
  // angle, so the two chick frames swap on the same beat as the circle.
  st.param = u8(st.param + 1);
  const phase = angle & 0x3f;
  if (phase === 0) {
    reinit(st, st.var1);
  } else if ((phase & 0x1f) === 0) {
    reinit(st, u8(st.var1 + 1));
  }
};

// Hardcoded Y offsets, one per PARAM.
// Lua: AnimObjects.lua:1377
const AMNESIA_OFFSETS: readonly number[] = [0xec, 0xf8, 0x00];

// Lua: AnimObjects.lua:1379
F.BATTLE_ANIM_FUNC_AMNESIA = (self, st) => {
  if (st.jt === 0) {
    incJt(st);
    reinit(st, self.framesetId("BATTLE_ANIM_FRAMESET_AMNESIA_1") + st.param);
    st.yOffset = AMNESIA_OFFSETS[st.param] ?? 0;
  } else if (st.jt === 2) {
    // anim_incobj forces the object to deinit; Present is what uses it.
    deinit(st);
  }
};

// Lua: AnimObjects.lua:1390
F.BATTLE_ANIM_FUNC_FLOAT_UP = (_, st) => {
  const angle = st.var1;
  st.var1 = u8(st.var1 + 2);
  st.xOffset = sine(angle, 4);
  // `lb hl, -1, $a0` is the 16-bit constant $ffa0: up 3/8 of a pixel a frame.
  [st.yOffset, st.var2] = add16(st.yOffset, st.var2, -0x60);
};

// Lua: AnimObjects.lua:1398
F.BATTLE_ANIM_FUNC_DIG = (_, st) => {
  const angle = st.var1;
  st.var1 = u8(st.var1 - 2);
  st.yOffset = sine(angle, 0x10);
  st.x = u8(st.x + 1);
};

// Lua: AnimObjects.lua:1405
F.BATTLE_ANIM_FUNC_STRING = (self, st) => {
  if (st.jt !== 0) return;
  incJt(st);
  // PARAM 0 is the one that flips on the enemy's turn.
  if (st.param === 0) st.oamFlags = st.oamFlags | OAM_YFLIP;
  reinit(st, self.framesetId("BATTLE_ANIM_FRAMESET_STRING_SHOT_1") + st.param);
};

// Lua: AnimObjects.lua:1413
F.BATTLE_ANIM_FUNC_PARALYZED = (self, st) => {
  if (st.jt === 0) {
    incJt(st);
    st.var1 = 0;
    const param = st.param;
    // Bits 4-6 become the hold time; bit 7 flips the object, and the low
    // nybble is how far it jitters.
    st.param = swap(param & 0x70) & 0xf;
    if ((param & 0x80) === 0) {
      st.xOffset = param & 0xf;
    } else {
      st.xOffset = u8(-(param & 0xf));
      reinit(st, self.framesetId("BATTLE_ANIM_FRAMESET_PARALYZED_FLIPPED"));
    }
    return;
  }
  if (st.var1 !== 0) {
    st.var1 = st.var1 - 1;
    return;
  }
  st.var1 = st.param;
  st.xOffset = u8(-st.xOffset);
};

// A shared descent: a circle whose height is an eighth of its width, sinking
// one pixel every few frames until it is $28 down.  Spiral Descent checks
// every eight frames, Petal Dance every four.
// Lua: AnimObjects.lua:1440
function spiralDescent(st: AnimStruct, mask: number): void {
  const angle = st.var1;
  st.yOffset = u8(sra(sra(sra(sine(angle, 0x18)))) + st.var2);
  st.xOffset = cosine(angle, 0x18);
  st.var1 = u8(st.var1 + 1);
  if ((st.var1 & mask) !== 0) return;
  if (st.var2 >= 0x28) {
    deinit(st);
    return;
  }
  st.var2 = u8(st.var2 + 1);
}

// Lua: AnimObjects.lua:1453
F.BATTLE_ANIM_FUNC_SPIRAL_DESCENT = (_, st) => {
  spiralDescent(st, 7);
};
// Lua: AnimObjects.lua:1454
F.BATTLE_ANIM_FUNC_PETAL_DANCE = (_, st) => {
  spiralDescent(st, 3);
};

// Lua: AnimObjects.lua:1456
F.BATTLE_ANIM_FUNC_POISON_GAS = (_, st) => {
  if (st.jt !== 0) {
    spiralDescent(st, 7);
    return;
  }
  if (st.x >= 0x84) {
    incJt(st);
    return;
  }
  st.x = u8(st.x + 1);
  const angle = st.var1;
  st.var1 = u8(st.var1 + 1);
  st.xOffset = cosine(angle, 0x18);
  if ((st.x & 1) !== 0) return;
  st.y = u8(st.y - 1);
};

// Lua: AnimObjects.lua:1473
F.BATTLE_ANIM_FUNC_SMOKE_FLAME_WHEEL = (_, st) => {
  const angle = st.param;
  st.yOffset = u8(sra(sra(sra(sine(angle, 0x18)))) + st.var2);
  st.xOffset = cosine(angle, 0x18);
  st.param = u8(st.param + 2);
  if ((st.param & 7) !== 0) return;
  if (st.var2 === 0xe8) {
    deinit(st);
    return;
  }
  st.var2 = u8(st.var2 - 1);
};

// Lua: AnimObjects.lua:1486
F.BATTLE_ANIM_FUNC_SACRED_FIRE = (_, st) => {
  const angle = st.param;
  st.yOffset = u8(sra(sra(sra(sine(angle, 0x18)))) + st.var2);
  st.xOffset = cosine(angle, 0x18);
  st.param = u8(st.param + 2);
  if ((st.param & 3) !== 0) return;
  if (st.var2 === 0xd0) {
    deinit(st);
    return;
  }
  st.var2 = u8(st.var2 - 2);
};

// Lua: AnimObjects.lua:1499
F.BATTLE_ANIM_FUNC_PRESENT_SMOKESCREEN = (_, st) => {
  if (st.jt === 0) {
    incJt(st);
    st.var1 = 0x34;
    st.var2 = 0x10;
  } else if (st.jt === 2) {
    deinit(st);
    return;
  }
  if (st.jt !== 1) return;
  if (st.x >= 0x6c) return;
  stepToTarget(st, 2);
  let value = sine(st.var1, st.var2);
  // Only the upper half of the bounce shows: a positive sine is negated, so
  // the puff always sits above its line.
  if ((value & 0x80) === 0) value = u8(-value);
  st.yOffset = value;
  st.var1 = u8(st.var1 - 4);
  // The halving below is unreachable on the cart: `and $1f` can never leave
  // $20, so Present's puff keeps its height the whole way across.
};

// Lua: AnimObjects.lua:1520
F.BATTLE_ANIM_FUNC_HORN = (_, st) => {
  const spin = (): void => {
    const value = sine(st.var2, 8);
    st.xOffset = value;
    st.y = u8(st.var1 - sra(value));
    st.var2 = u8(st.var2 + 8);
  };
  const jt = st.jt;
  if (jt === 0) {
    st.jt = st.param;
    st.var1 = st.y;
  } else if (jt === 1) {
    if (st.x >= 0x58) return;
    stepToTarget(st, 2);
  } else if (jt === 2) {
    if (st.var2 >= 0x20) {
      deinit(st);
      return;
    }
    spin();
  } else if (jt === 3) {
    spin();
  }
};

// Lua: AnimObjects.lua:1545
F.BATTLE_ANIM_FUNC_NEEDLE = (_, st) => {
  const line = (): void => {
    if (st.x >= 0x84) {
      deinit(st);
      return;
    }
    stepToTarget(st, st.param);
  };
  const jt = st.jt;
  if (jt === 0) {
    // The upper nybble of PARAM picks straight line or arc.
    st.jt = swap(st.param) & 0xf;
  } else if (jt === 1) {
    line();
  } else if (jt === 2) {
    const value = sine(st.var1, 0x10);
    // Only the negative half is written, so the needle arcs upward only.
    if ((value & 0x80) !== 0) st.yOffset = value;
    st.var1 = u8(st.var1 - 4);
    line(); // .two falls into .one
  }
};

// Lua: AnimObjects.lua:1568
F.BATTLE_ANIM_FUNC_THIEF_PAYDAY = (_, st) => {
  if (st.jt === 0) {
    incJt(st);
    st.var1 = 0x28;
    st.var2 = u8(st.y - 0x28);
  }
  st.yOffset = sine(st.var1, st.var2);
  // PARAM is a MASK, so the coin only drifts left on the frames that clear it.
  if ((st.var1 & st.param) === 0) st.x = u8(st.x - 1);
  st.var1 = u8(st.var1 + 1);
  if ((st.var1 & 0x3f) !== 0) return;
  st.var1 = 0x20;
  st.var2 = st.var2 >>> 1;
};

// Lua: AnimObjects.lua:1583
F.BATTLE_ANIM_FUNC_ABSORB_CIRCLE = (_, st) => {
  const angle = st.param;
  st.yOffset = sine(angle, st.var1);
  st.xOffset = cosine(angle, st.var1);
  st.param = u8(st.param + 1);
  if ((st.param & 1) === 0) st.x = u8(st.x - 1);
  if ((st.param & 3) === 0) st.y = u8(st.y + 1);
  if (st.x >= 0x5a) {
    st.var1 = u8(st.var1 + 1);
    return;
  }
  if (st.var1 === 0) {
    deinit(st);
    return;
  }
  st.var1 = u8(st.var1 - 1);
};

// Lua: AnimObjects.lua:1601
F.BATTLE_ANIM_FUNC_CONVERSION = (_, st) => {
  const angle = st.param;
  st.param = u8(st.param + 1);
  st.yOffset = sine(angle, st.var1);
  st.xOffset = cosine(angle, st.var1);
  const age = st.var2;
  st.var2 = u8(st.var2 + 1);
  if (age < 0x40) {
    st.var1 = u8(st.var1 + 1);
    return;
  }
  const radius = st.var1;
  st.var1 = u8(st.var1 - 1);
  if (radius !== 0) return;
  deinit(st);
};

// Lua: AnimObjects.lua:1618
F.BATTLE_ANIM_FUNC_BONEMERANG = (_, st) => {
  if (st.jt === 0) {
    incJt(st);
    st.var2 = st.y;
  }
  st.y = u8(st.var2 + sine(st.param, 0x30));
  // Eight steps of phase between the two axes is what bends the throw into a
  // boomerang instead of a circle.
  st.xOffset = cosine(st.param + 8, 0x30);
  st.param = u8(st.param + 1);
};

// Lua: AnimObjects.lua:1630
F.BATTLE_ANIM_FUNC_SHINY = (_, st) => {
  if (st.jt !== 0) return;
  incJt(st);
  st.yOffset = sine(st.param, 0x10);
  st.xOffset = cosine(st.param, 0x10);
  st.var2 = 0xf;
};

// Sky Attack pulses OBP0 rather than moving anything, so the palette write is
// what the view has to see.
// Lua: AnimObjects.lua:1640
const SKY_ATTACK_GBC: readonly number[] = [0xff, 0xaa, 0x55, 0xaa];
const SKY_ATTACK_SGB: readonly number[] = [0xff, 0xff, 0x00, 0x00];

// Lua: AnimObjects.lua:1643
F.BATTLE_ANIM_FUNC_SKY_ATTACK = (self, st) => {
  const cyclePalette = (): void => {
    const phase = st.var2 & 7;
    st.var2 = u8(st.var2 + 1);
    const pals = truthy(self.env.sgb) ? SKY_ATTACK_SGB : SKY_ATTACK_GBC;
    self.obp0 = (pals[phase >>> 1] ?? 0xff) & st.var1;
  };
  const jt = st.jt;
  if (jt === 0) {
    incJt(st);
    st.var1 = (self.env.battleTurn ?? 0) === 0 ? 0xf0 : 0xcc;
  } else if (jt === 1) {
    cyclePalette();
  } else if (jt === 2) {
    cyclePalette();
    if (st.x >= 0x84) return;
    stepToTarget(st, 4);
  } else if (jt === 3) {
    cyclePalette();
    if (st.x >= 0xd0) {
      deinit(st);
      return;
    }
    stepToTarget(st, 4);
  }
};

// Lua: AnimObjects.lua:1670
F.BATTLE_ANIM_FUNC_GROWTH_SWORDS_DANCE = (_, st) => {
  const angle = st.param;
  st.yOffset = u8(sra(sra(sra(sine(angle, 0x18)))) + st.var2);
  st.param = u8(st.param + 1);
  st.xOffset = cosine(angle, 0x18);
  st.var2 = u8(st.var2 - 2);
};

// Lua: AnimObjects.lua:1678
F.BATTLE_ANIM_FUNC_STRENGTH_SEISMIC_TOSS = (_, st) => {
  const jt = st.jt;
  if (jt === 0) {
    if (st.yOffset === 0xe0) {
      incJt(st);
      st.var1 = 2;
      return;
    }
    [st.yOffset, st.var1] = add16(st.yOffset, st.var1, -0x80);
  } else if (jt === 1) {
    if (st.var2 !== 0) {
      st.var2 = st.var2 - 1;
      return;
    }
    // Shakes by negating the accumulated step and folding it into the offset
    // every four frames.
    st.var2 = 4;
    st.var1 = u8(-st.var1);
    st.yOffset = u8(st.yOffset + st.var1);
  } else if (jt === 2) {
    if (st.x >= 0x84) {
      deinit(st);
      return;
    }
    stepToTarget(st, 4);
  }
};

// Lua: AnimObjects.lua:1706
F.BATTLE_ANIM_FUNC_SPEED_LINE = (self, st) => {
  if (st.jt === 0) {
    incJt(st);
    reinit(st, self.framesetId("BATTLE_ANIM_FRAMESET_SPEED_LINE_1") + (st.param & 0x7f));
  }
  if ((st.param & 0x80) !== 0) {
    st.xOffset = u8(st.xOffset - 1);
  } else {
    st.xOffset = u8(st.xOffset + 1);
  }
};

// Lua: AnimObjects.lua:1719
F.BATTLE_ANIM_FUNC_SLUDGE = (self, st) => {
  const jt = st.jt;
  if (jt === 0) {
    incJt(st);
    st.var1 = 0xc;
  } else if (jt === 1) {
    if (st.var1 !== 0) {
      st.var1 = st.var1 - 1;
      return;
    }
    incJt(st);
    reinit(st, self.framesetId("BATTLE_ANIM_FRAMESET_SLUDGE_BUBBLE_BURST"));
    st.yOffset = u8(st.yOffset - 1); // .done falls into .two
  } else if (jt === 2) {
    st.yOffset = u8(st.yOffset - 1);
  }
};

// Lua: AnimObjects.lua:1737
F.BATTLE_ANIM_FUNC_METRONOME_HAND = (_, st) => {
  const angle = st.var1;
  st.var1 = u8(st.var1 + 2);
  st.yOffset = sine(angle, 2);
  st.xOffset = cosine(angle, 8);
};

// Lua: AnimObjects.lua:1744
F.BATTLE_ANIM_FUNC_METRONOME_SPARKLE_SKETCH = (_, st) => {
  if (st.yOffset >= 0x20) {
    deinit(st);
    return;
  }
  st.xOffset = cosine(st.param, 8);
  st.param = u8(st.param + 2);
  if ((st.param & 7) !== 0) return;
  st.yOffset = u8(st.yOffset + 1);
};

// Lua: AnimObjects.lua:1755
F.BATTLE_ANIM_FUNC_AGILITY = (_, st) => {
  // anim_incobj is what makes it disappear.
  if (st.jt !== 0) {
    deinit(st);
    return;
  }
  st.x = u8(st.x + st.param);
};

// Lua: AnimObjects.lua:1764
F.BATTLE_ANIM_FUNC_SAFEGUARD_PROTECT = (_, st) => {
  const angle = st.param;
  st.yOffset = sine(angle, 0x18);
  st.xOffset = sra(cosine(angle, 0x18));
  st.param = u8(st.param + 1);
};

// Lua: AnimObjects.lua:1771
F.BATTLE_ANIM_FUNC_LOCK_ON_MIND_READER = (_, st) => {
  // .two: hold for $10 frames, then go.
  const hold = (): void => {
    const left = st.var1;
    st.var1 = u8(st.var1 - 1);
    if (left !== 0) return;
    deinit(st);
  };
  let jt = st.jt;
  if (jt === 0) {
    incJt(st);
    st.var1 = 0x28;
    // The low nybble walks along the four LOCK_ON / MIND_READER framesets,
    // and the object's own frameset id is the base of that run.
    reinit(st, u8(st.framesetId + (st.param & 0xf)));
    st.param = (st.param & 0xf0) | 8;
    jt = 1;
  }
  if (jt === 1) {
    if (st.var1 !== 0) {
      st.var1 = st.var1 - 1;
      // The radius is the distance still to run, so the ring converges.
      const radius = u8(st.var1 + 8);
      st.yOffset = sine(st.param, radius);
      st.xOffset = cosine(st.param, radius);
      return;
    }
    st.var1 = 0x10;
    incJt(st);
    hold(); // .done falls into .two
    return;
  }
  if (jt === 2) hold();
};

// Lua: AnimObjects.lua:1806
F.BATTLE_ANIM_FUNC_HEAL_BELL_NOTES = (self, st) => {
  if (st.jt === 0) {
    incJt(st);
    reinit(st, self.framesetId("BATTLE_ANIM_FRAMESET_MUSIC_NOTE_1") + st.param);
  }
  if (st.yOffset >= 0x38) {
    deinit(st);
    return;
  }
  st.yOffset = u8(st.yOffset + 1);
  const angle = st.var1;
  st.var1 = u8(st.var1 + 1);
  st.xOffset = cosine(angle, 0x18);
  // Tests the Y COORDINATE, not the counter: the note drifts left on the
  // frames its row happens to be even.
  if ((st.y & 1) !== 0) return;
  st.x = u8(st.x - 1);
};

// Lua: AnimObjects.lua:1825
F.BATTLE_ANIM_FUNC_BATON_PASS = (_, st) => {
  if (st.param === 0) return;
  const angle = st.var1;
  st.var1 = u8(st.var1 + 1);
  let value = sine(angle, st.param);
  if ((value & 0x80) === 0) value = u8(-value);
  st.yOffset = value;
  if ((st.var1 & 0x1f) !== 0) return;
  // Each bounce is half the last.
  st.param = st.param >>> 1;
};

// Lua: AnimObjects.lua:1837
F.BATTLE_ANIM_FUNC_ENCORE_BELLY_DRUM = (_, st) => {
  if (st.var1 >= 0x10) {
    deinit(st);
    return;
  }
  const radius = st.var1;
  st.var1 = u8(st.var1 + 2);
  st.yOffset = sine(st.param, radius);
  st.xOffset = cosine(st.param, radius);
};

// Lua: AnimObjects.lua:1848
F.BATTLE_ANIM_FUNC_SWAGGER_MORNING_SUN = (_, st) => {
  // The top two bits of PARAM are the speed and the low six the angle; the
  // amplitude is VAR1 as it was BEFORE this frame's speed was added.
  const radius = st.var1;
  st.var1 = u8(st.var1 + rlca(rlca(st.param & 0xc0)));
  const angle = st.param & 0x3f;
  st.yOffset = sine(angle, radius);
  st.xOffset = cosine(angle, radius);
};

// Lua: AnimObjects.lua:1858
F.BATTLE_ANIM_FUNC_HIDDEN_POWER = (_, st) => {
  // .two: the ring expands eight pixels a frame and then vanishes.
  const expand = (): void => {
    if (st.var1 >= 0x80) {
      deinit(st);
      return;
    }
    const radius = st.var1;
    st.var1 = u8(st.var1 + 8);
    stepCircle(st, st.param, radius);
  };
  const jt = st.jt;
  if (jt === 0) {
    const angle = st.param;
    st.param = u8(st.param + 1);
    stepCircle(st, angle, 0x18);
  } else if (jt === 1) {
    incJt(st);
    st.var1 = 0x18;
    expand(); // .one falls into .two
  } else if (jt === 2) {
    expand();
  }
};

// Lua: AnimObjects.lua:1883
F.BATTLE_ANIM_FUNC_CURSE = (_, st) => {
  if (st.jt !== 1) return;
  if (st.x < 0x30) {
    deinit(st);
    return;
  }
  st.x = u8(st.x - 2);
  st.y = u8(st.y + 2);
};

// Lua: AnimObjects.lua:1893
F.BATTLE_ANIM_FUNC_PERISH_SONG = (_, st) => {
  const angle = st.param;
  st.param = u8(st.param + 2);
  // VAR1 is both the sink and the counter: the sine is added to it and then
  // it is stepped, so the ring drifts down as it turns.
  st.yOffset = u8(sra(sra(sine(angle, 0x50))) + st.var1);
  st.var1 = u8(st.var1 + 1);
  st.xOffset = cosine(angle, 0x50);
};

// Lua: AnimObjects.lua:1903
F.BATTLE_ANIM_FUNC_RAPID_SPIN = (_, st) => {
  if (st.yOffset === 0xd0) {
    deinit(st);
    return;
  }
  st.yOffset = u8(st.yOffset - 4);
};

// Lua: AnimObjects.lua:1911
F.BATTLE_ANIM_FUNC_BETA_PURSUIT = (_, st) => {
  const jt = st.jt;
  if (jt === 0) {
    if (st.param !== 0) {
      incJt(st);
      incJt(st);
      return;
    }
    incJt(st);
    st.yOffset = 0xec;
  } else if (jt === 1) {
    if (st.yOffset === 4) {
      deinit(st);
      return;
    }
    st.yOffset = u8(st.yOffset + 4);
  } else if (jt === 2) {
    if (st.yOffset === 0xd8) return;
    st.yOffset = u8(st.yOffset - 4);
  } else if (jt === 3) {
    deinit(st);
  }
};

// Lua: AnimObjects.lua:1935
F.BATTLE_ANIM_FUNC_RAIN_SANDSTORM = (_, st) => {
  // The Y offset wraps at $70, which is what makes a single object read as a
  // continuous fall of rain.
  const fall = (step: number): void => {
    const y = st.yOffset + 4;
    st.yOffset = y < 0x70 ? y : 0;
    st.xOffset = u8(st.xOffset + step);
  };
  const jt = st.jt;
  if (jt === 0) {
    st.jt = u8(st.param + 1); // .zero sets the index from PARAM and then incs
  } else if (jt === 1) {
    fall(2);
  } else if (jt === 2) {
    fall(8);
  } else if (jt === 3) {
    fall(4);
  }
};

// Lua: AnimObjects.lua:1955
F.BATTLE_ANIM_FUNC_BATTLE_ANIM_OBJ_B0 = (_, st) => {
  // Unused on the cart (nothing names BATTLE_ANIM_OBJ_B0), transcribed
  // because the jumptable slot is real: PARAM's nybbles become a 16-bit step
  // over XCOORD:VAR1, the high nybble duplicated into both halves of the
  // whole-pixel byte.
  let high = st.param & 0xf0;
  high = high | (high >>> 4);
  [st.x, st.var1] = add16(st.x, st.var1, high * 256 + swap(st.param & 0xf));
};

// Lua: AnimObjects.lua:1966
F.BATTLE_ANIM_FUNC_PSYCH_UP = (_, st) => {
  const angle = st.param;
  st.param = u8(st.param + 1);
  stepCircle(st, angle, 0x18);
};

// Lua: AnimObjects.lua:1972
F.BATTLE_ANIM_FUNC_COTTON = (_, st) => {
  const phase = st.var2;
  st.var2 = u8(st.var2 + 1);
  stepCircle(st, u8((phase >>> 1) + st.param), 0x18);
};

// Lua: AnimObjects.lua:1978
F.BATTLE_ANIM_FUNC_ANCIENT_POWER = (_, st) => {
  if (st.var1 >= 0x20) {
    deinit(st);
    return;
  }
  const angle = st.var1;
  st.var1 = u8(st.var1 + 1);
  st.yOffset = u8(-sine(angle, st.param));
};

// Lua: AnimObjects.lua:1988
export const AnimObjects = {
  FUNCTIONS: F,
  NUM_STRUCTS,
  OAM_LIMIT,
  OAM_XFLIP,
  OAM_YFLIP,
  OAM_PRIO,
  OAM_PAL1,
  FIX_COORDS,
  sine,
  cosine,
  u8,
  s8,
  sra,
  swap,
  rlca,
  // Lua: AnimObjects.lua:110
  new(data?: AnimObjectData | null, constants?: Record<string, any> | null, env?: AnimEnv | null): AnimObjectPool {
    return new AnimObjectPool(data, constants, env);
  },
};

export default AnimObjects;
