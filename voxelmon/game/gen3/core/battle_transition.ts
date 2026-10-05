// Port of gen1recomp src/core/game3/battle_transition.lua (GPLv3 + additional terms; see LICENSE.md).
// Gen 3 (FireRed) battle transition orchestrator & visual effects.
// Replicates pret battle_transition.c and battle_setup.c.
//
// Port notes:
// - No top-level reads of imports: `local SINE = Trig.SINE` is read lazily
//   inside Sin/Cos; `local ID = IdsFrlg.ID` / MUGSHOT_BY_ID are read inside
//   functions. Each `DEF[ID.X] = {...}` is a top-level object (DEF_X, in
//   Brian's order; their functions only touch imports when called), and the
//   id-keyed DEF table is built on first use (frDef()). render's
//   `def == DEF[ID.X]` compares against those objects directly (the same
//   identity).
// - The metatable __index exposing ID / TERRAIN is two property getters
//   returning BattleTransition.ids()[k], as Brian's does on every read.
//   `_transitionId = ID.SLICE` is a getter/setter defaulting to Ids.ID.SLICE
//   on first read. `BattleTransition.H` (the helper table handed to the RSE
//   modules) is a getter building it on first read (it holds Pal / Audio).
// - IDS_MODULES' require: frlg is battle_transition_ids_frlg.ts (static);
//   rse is NOT FAITHFUL: Emerald only (throws). defs() for a non-FRLG family
//   throws the same at the RSE_MODULES require.
// - pcall(require, "src.ui.game3.battle_transition_chrome") reads
//   G3Lazy[...] (missing = failed require). trainer_pic and rng are linked in
//   (static imports), so their pcall(require)s always succeed.
// - Multiple returns are 0-based tuples: winH -> [l, r] | undefined, winV ->
//   [t, b], def.shift -> [dx, dy]. To keep the per-scanline paths free of
//   allocation (Brian's multiple returns allocate nothing), winH / winV /
//   shift return module-level scratch tuples: callers read them at once and
//   never keep them.
// - Brian's 1-based `out` span lists (out[1], out[2], ...) and the {X0, X1}
//   lists blackSpans returns stay 1-based (slot 0 unused). Buffers Brian
//   indexes from 0 (buf0 / buf1 / trail / barLevel) are plain JS arrays
//   indexed the same.
// - drawSpanRows' `rows` table (a sequence of row keys AND a key -> spans
//   hash) is two structures here: a key array and a key -> spans object.
// - `love and love.graphics` guards are always true here and are dropped
//   (drawWorld still returns false without a canvas). print -> console.log.
// - drawMugshot's `type(img) ~= "table"` (a LÖVE Image is userdata) is
//   `img instanceof Image`.
// - NOT FAITHFUL: the field scratch canvas asks for "repeat" wrap
//   (pcall(scratch.setWrap)); the host's canvases have no wrap mode, so a
//   SLICE / SWIRL row shifted past the edge samples outside the canvas
//   (those pixels lie under SLICE's black spans).

/* eslint-disable @typescript-eslint/no-explicit-any */
import { mod, tostring, truthy } from "../../../import/gen3/lua.ts";
import { seq, len, ipairs, pairs, type LuaTable } from "../platform/lt.ts";
import { G as LG } from "../platform/graphics.ts";
import { Image, type Canvas, type Quad } from "../platform/image.ts";
import { random } from "../platform/rng.ts";
import Audio from "./audio.ts";
import Trig from "./trig.ts";
import { Pal } from "./pal_fade.ts";
import Ids from "./battle_transition_ids_frlg.ts";
import Profile from "./profile.ts";
import TrainerPic from "./trainer_pic.ts";
import Rng from "./rng.ts";
import { G3Lazy } from "./lazy_registry.ts";

type GT = typeof LG;
type Fn = (...a: any[]) => any;

/** The drawing view (makeView / viewFor). */
export interface View {
  X0: number;
  X1: number;
  Y0: number;
  Y1: number;
  hdist(v: number): number;
  hmap(x: number): number;
  hmapL(x: number): number;
  hmapR(x: number): number;
  gx?: number;
  gy?: number;
  field?: Image;
  fieldQuad?: Quad;
  rowBands?(valueFn: (y: number) => any, drawFn: (v: any, y0: number, y1: number) => void): void;
}

/** One transition's running state (newFx). */
export interface FxState {
  id: number;
  def: Def;
  state: number;
  t: Record<string, any>;
  T: Record<string, any>;
  buf0: any[];
  buf1: any[];
  sprites: LuaTable;
  done: boolean;
  pal: Pal;
  opts: any;
  K: Record<string, number>;
  mugKey?: string;
  female?: boolean;
  mug?: any;
  [k: string]: any;
}

export interface Def {
  /** a sequence: funcs[fx.state + 1] */
  funcs: LuaTable;
  init?(fx: FxState): void;
  vblank?(fx: FxState): void;
  shift?(fx: FxState, y: number, R: View): [number, number];
  winSpans?(fx: FxState, y: number, out: number[]): number;
  rowSpans?(fx: FxState, y: number, R: View, out: number[]): number;
  sprite?(fx: FxState, s: any): void;
  post?(fx: FxState, R: View, G: GT): void;
  draw?(fx: FxState, R: View, G: GT): void;
  redraw?: boolean;
}

export interface BattleTransitionModule {
  ID: Record<string, number>;
  TERRAIN: Record<string, number>;
  _active: boolean;
  _phase: string;
  _transitionId: number;
  _opts: any;
  _doneCb: Fn | null | undefined;
  _frame: number;
  _fx: FxState | null | undefined;
  _pal: Pal | null | undefined;
  _intro: any;
  _worldDrawn: boolean;
  _mosaicCanvas?: Canvas | null;
  _mosaicKey?: any;
  _bigQuad?: Quad;
  _gridQuad?: Quad;
  _vsQuad?: Quad;
  _picQuad?: Quad;
  _scratch?: Canvas;
  _fieldQuad?: Quad;
  _uiScratch?: Canvas;
  _uiQuad?: Quad;
  RSE_MODULES: LuaTable;
  H: Record<string, any>;
  family(): string;
  ids(family?: string | null): any;
  getTerrainByMap(opts?: any): number;
  pickWild(opts?: any): number;
  pickTrainer(opts?: any): number;
  pick(opts?: any): number;
  defs(family?: string | null): Record<number, Def>;
  start(transitionId?: number | null, opts?: any, doneCb?: Fn | null): boolean;
  isActive(): boolean;
  finish(): void;
  abort(): void;
  tick(dt?: number): boolean;
  blackSpans(y: number, X0?: number, X1?: number): LuaTable;
  screenCoverage(): number;
  drawWorld(canvas: Canvas | null | undefined, vw: number, vh: number): boolean;
  draw(): void;
}

export const BattleTransition = {} as BattleTransitionModule;

const IDS_MODULES: Record<string, string> = {
  frlg: "src.core.game3.battle_transition_ids_frlg",
  rse: "src.core.game3.battle_transition_ids_rse",
};

// Lua: battle_transition.lua:25
BattleTransition.family = function (): string {
  return Profile.family();
};

// Lua: battle_transition.lua:29
BattleTransition.ids = function (family?: string | null): any {
  family = truthy(family) ? family : BattleTransition.family();
  const module = IDS_MODULES[family!];
  if (!truthy(module)) throw new Error("battle transition: no id table for family '" + tostring(family) + "'");
  if (family === "frlg") return Ids;
  throw new Error("NOT FAITHFUL: Emerald only (" + module + ")");
};

// Lua: battle_transition.lua:36 (the metatable __index for ID / TERRAIN)
for (const k of ["ID", "TERRAIN"] as const) {
  Object.defineProperty(BattleTransition, k, { get: () => BattleTransition.ids()[k], enumerable: true });
}

BattleTransition._active = false;
BattleTransition._phase = "idle";
// BattleTransition._transitionId = ID.SLICE: the default is taken on first read.
let transitionIdSet: number | undefined;
Object.defineProperty(BattleTransition, "_transitionId", {
  get: () => transitionIdSet ?? Ids.ID.SLICE,
  set: (v: number) => { transitionIdSet = v; },
  enumerable: true,
});
BattleTransition._opts = {};
BattleTransition._doneCb = undefined;
BattleTransition._frame = 0;
BattleTransition._fx = undefined;
BattleTransition._pal = undefined;
BattleTransition._intro = undefined;
BattleTransition._worldDrawn = false;

// Lua: battle_transition.lua:54
function getChrome(): any {
  const Chrome = G3Lazy["src.ui.game3.battle_transition_chrome"];
  if (truthy(Chrome)) return Chrome;
  return undefined;
}

// Lua: battle_transition.lua:60
function getTrainerPic(): any {
  // pcall(require, "src.core.game3.trainer_pic"): linked in
  const TP: any = TrainerPic;
  if (truthy(TP)) return TP;
  return undefined;
}

//------------------------------------------------------------------------------
// Transition Selection (battle_setup.c parity)
//------------------------------------------------------------------------------

// Lua: battle_transition.lua:70
BattleTransition.getTerrainByMap = function (opts?: any): number {
  return BattleTransition.ids().getTerrainByMap(opts);
};

// Lua: battle_transition.lua:74
BattleTransition.pickWild = function (opts?: any): number {
  return BattleTransition.ids().pickWild(opts);
};

// Lua: battle_transition.lua:78
BattleTransition.pickTrainer = function (opts?: any): number {
  return BattleTransition.ids().pickTrainer(opts);
};

// Lua: battle_transition.lua:82
BattleTransition.pick = function (opts?: any): number {
  opts = opts ?? {};
  if (truthy(opts.transitionId)) return opts.transitionId;
  if (truthy(opts.wild)) {
    return BattleTransition.pickWild(opts);
  } else {
    return BattleTransition.pickTrainer(opts);
  }
};

const DW = 240, DH = 160;
const GRAY = seq(11, 11, 11);

// Lua: battle_transition.lua:95
function s16(v: number): number {
  v = v & 0xFFFF;
  if (v >= 0x8000) v = v - 0x10000;
  return v;
}
// Lua: battle_transition.lua:100
function u16(v: number): number { return v & 0xFFFF; }
// Lua: battle_transition.lua:101
function u8(v: number): number { return v & 0xFF; }

/** Trig.SINE, read on first use (no load-time read of an import). */
let SINE: LuaTable | undefined;

// src/trig.c:514
// Lua: battle_transition.lua:104
function Sin(i: number, a: number): number {
  const S = SINE ?? (SINE = Trig.SINE);
  return s16((a * S[(i & 0xFF) + 1]) >> 8);
}
// Lua: battle_transition.lua:105
function Cos(i: number, a: number): number {
  const S = SINE ?? (SINE = Trig.SINE);
  return s16((a * S[((i + 64) & 0xFF) + 1]) >> 8);
}

// Lua: battle_transition.lua:107
function WIN_RANGE(a: number, b: number): number { return u16((a << 8) | b); }

/** winH's / winV's / shift's multiple returns (scratch tuples; read at once). */
const WH: [number, number] = [0, 0];
const WV: [number, number] = [0, 0];
const SH: [number, number] = [0, 0];
function shiftRet(dx: number, dy: number): [number, number] {
  SH[0] = dx;
  SH[1] = dy;
  return SH;
}

// Lua: battle_transition.lua:109
function winH(v: number | null | undefined): [number, number] | undefined {
  v = u16(v ?? 0);
  const l = v >>> 8;
  let r = v & 0xFF;
  if (r > DW || l > r) r = DW;
  if (l >= r) return undefined;
  WH[0] = l;
  WH[1] = r;
  return WH;
}

// Lua: battle_transition.lua:117
function winV(v: number | null | undefined): [number, number] {
  v = u16(v ?? 0);
  const t = v >>> 8;
  let b = v & 0xFF;
  if (b > DH || t > b) b = DH;
  WV[0] = t;
  WV[1] = b;
  return WV;
}

// src/battle_transition.c:2952
// Lua: battle_transition.lua:125
function initBlackWipe(d: Record<string, any>, sx: number, sy: number, ex: number, ey: number, stx: number, sty: number): void {
  d.startX = sx; d.startY = sy;
  d.currX = sx; d.currY = sy;
  d.endX = ex; d.endY = ey;
  d.xMove = stx; d.yMove = sty;
  d.xDist = ex - sx;
  if (d.xDist < 0) {
    d.xDist = -d.xDist;
    d.xMove = -stx;
  }
  d.yDist = ey - sy;
  if (d.yDist < 0) {
    d.yDist = -d.yDist;
    d.yMove = -sty;
  }
  d.temp = 0;
}

// src/battle_transition.c:2979
// Lua: battle_transition.lua:144
function updateBlackWipe(d: Record<string, any>, xExact: boolean, yExact: boolean): boolean {
  if (d.xDist > d.yDist) {
    d.currX = d.currX + d.xMove;
    d.temp = d.temp + d.yDist;
    if (d.temp > d.xDist) {
      d.currY = d.currY + d.yMove;
      d.temp = d.temp - d.xDist;
    }
  } else {
    d.currY = d.currY + d.yMove;
    d.temp = d.temp + d.xDist;
    if (d.temp > d.yDist) {
      d.currX = d.currX + d.xMove;
      d.temp = d.temp - d.yDist;
    }
  }
  let n = 0;
  if ((d.xMove > 0 && d.currX >= d.endX) || (d.xMove < 0 && d.currX <= d.endX)) {
    n = n + 1;
    if (xExact) d.currX = d.endX;
  }
  if ((d.yMove > 0 && d.currY >= d.endY) || (d.yMove < 0 && d.currY <= d.endY)) {
    n = n + 1;
    if (yExact) d.currY = d.endY;
  }
  return n === 2;
}

// src/battle_transition.c:2903
// Lua: battle_transition.lua:173
function setCircularMask(buf: any[], x: number, y: number, radius: number): void {
  for (let i = 0; i <= DH - 1; i++) buf[i] = 0x0A0A;
  for (let i = 0; i <= 63; i++) {
    const sinR = Sin(i, radius);
    let cosR = Cos(i, radius);
    let leftX = x - sinR;
    let winVal = x + sinR;
    let topY = y - cosR;
    let bottomY = y + cosR;
    if (leftX < 0) leftX = 0;
    if (winVal > DW) winVal = DW;
    if (topY < 0) topY = 0;
    if (bottomY > DH - 1) bottomY = DH - 1;
    winVal = winVal | (leftX << 8);
    buf[topY] = winVal;
    buf[bottomY] = winVal;
    cosR = Cos(i + 1, radius);
    let nextTop = y - cosR;
    let nextBottom = y + cosR;
    if (nextTop < 0) nextTop = 0;
    if (nextBottom > DH - 1) nextBottom = DH - 1;
    while (topY > nextTop) { topY = topY - 1; buf[topY] = winVal; }
    while (topY < nextTop) { topY = topY + 1; buf[topY] = winVal; }
    while (bottomY > nextBottom) { bottomY = bottomY - 1; buf[bottomY] = winVal; }
    while (bottomY < nextBottom) { bottomY = bottomY + 1; buf[bottomY] = winVal; }
  }
}

// Lua: battle_transition.lua:201
function fadeScreenBlack(fx: FxState): void {
  fx.pal.blend(Pal.ALL, 16, Pal.BLACK);
}

// Lua: battle_transition.lua:205
function copyBuf(dst: any[], src: any[], n: number, off?: number): void {
  off = off ?? 0;
  for (let i = off; i <= off + n - 1; i++) dst[i] = src[i];
}

// src/battle_transition.c:723
// Lua: battle_transition.lua:213
const DEF_BLUR: Def = {
  funcs: seq(
    (fx: FxState): boolean => {
      fx.mosaic = 0;
      fx.state = 1;
      return true;
    },
    (fx: FxState): boolean => {
      const t = fx.t;
      if (t.delay !== 0) {
        t.delay = t.delay - 1;
      } else {
        t.delay = fx.K.blurDelay;
        t.counter = t.counter + 1;
        if (t.counter === 10) {
          fx.pal.beginFade(Pal.ALL, -1, 0, 16, Pal.BLACK);
        }
        fx.mosaic = t.counter & 0xF;
        if (t.counter > 14) fx.state = 2;
      }
      return false;
    },
    (fx: FxState): boolean => {
      if (!fx.pal.fadeActive()) fx.done = true;
      return false;
    },
  ),
  init: (fx) => { fx.t.delay = 0; fx.t.counter = 0; },
  redraw: true,
};

// src/battle_transition.c:773
// Lua: battle_transition.lua:245
const DEF_SWIRL: Def = {
  funcs: seq(
    (fx: FxState): boolean => {
      fx.pal.beginFade(Pal.ALL, 4, 0, 16, Pal.BLACK);
      fx.wave1 = { idx: 0, amp: 0 };
      fx.state = 1;
      return false;
    },
    (fx: FxState): boolean => {
      const t = fx.t;
      fx.T.vblankDma = false;
      t.sinIndex = s16(t.sinIndex + 4);
      t.amp = s16(t.amp + 8);
      fx.wave0 = { idx: t.sinIndex, amp: t.amp };
      if (!fx.pal.fadeActive()) fx.done = true;
      fx.T.vblankDma = true;
      return false;
    },
  ),
  init: (fx) => { fx.t.sinIndex = 0; fx.t.amp = 0; },
  vblank: (fx) => {
    if (fx.T.vblankDma && truthy(fx.wave0)) fx.wave1 = fx.wave0;
  },
  shift: (fx, y) => {
    const w = fx.wave1;
    if (!truthy(w)) return shiftRet(0, 0);
    return shiftRet(Sin(w.idx + 2 * y, w.amp), 0);
  },
  redraw: true,
};

// src/battle_transition.c:829
// Lua: battle_transition.lua:277
const DEF_SHUFFLE: Def = {
  funcs: seq(
    (fx: FxState): boolean => {
      fx.pal.beginFade(Pal.ALL, 4, 0, 16, Pal.BLACK);
      fx.sh1 = { sinVal: 0, amp: 0 };
      fx.state = 1;
      return false;
    },
    (fx: FxState): boolean => {
      const t = fx.t;
      fx.T.vblankDma = false;
      const sinVal = u16(t.sinVal);
      const amp = u16(t.amp >> 8);
      t.sinVal = s16(t.sinVal + 4224);
      t.amp = s16(t.amp + 384);
      fx.sh0 = { sinVal, amp: s16(amp) };
      if (!fx.pal.fadeActive()) fx.done = true;
      fx.T.vblankDma = true;
      return false;
    },
  ),
  init: (fx) => { fx.t.sinVal = 0; fx.t.amp = 0; },
  vblank: (fx) => {
    if (fx.T.vblankDma && truthy(fx.sh0)) fx.sh1 = fx.sh0;
  },
  shift: (fx, y) => {
    const s = fx.sh1;
    if (!truthy(s)) return shiftRet(0, 0);
    return shiftRet(0, Sin(u16(s.sinVal + 4224 * y) >>> 8, s.amp));
  },
  redraw: true,
};

// src/battle_transition.c:906
// Lua: battle_transition.lua:311
function bigBlend(t: Record<string, any>, dec: boolean): void {
  let fire: boolean;
  if (t.blendDelay === 0) {
    fire = true;
  } else {
    t.blendDelay = t.blendDelay - 1;
    fire = t.blendDelay === 0;
  }
  if (fire) {
    if (dec) {
      t.evb = t.evb - 1;
      t.blendDelay = 2;
    } else {
      t.eva = t.eva + 1;
      t.blendDelay = 1;
    }
  }
}

// Lua: battle_transition.lua:330
function bigAmp(t: Record<string, any>): void {
  if (t.amp > 0) {
    t.sinIndex = s16(t.sinIndex + 12);
    t.amp = s16(t.amp - 384);
  } else {
    t.amp = 0;
  }
}

// Lua: battle_transition.lua:339
const DEF_BIG_POKEBALL: Def = {
  funcs: seq(
    (fx: FxState): boolean => {
      const t = fx.t;
      t.evb = 16; t.eva = 0; t.sinIndex = 0; t.amp = 0x4000; t.blendDelay = 0;
      fx.T.bldAlpha = seq(0, 16);
      fx.hofs1 = { const: 240 };
      fx.state = 1;
      return false;
    },
    (fx: FxState): boolean => {
      fx.pattern = true;
      fx.state = 2;
      return true;
    },
    (fx: FxState): boolean => {
      const t = fx.t;
      fx.T.vblankDma = false;
      bigBlend(t, false);
      fx.T.bldAlpha = seq(t.eva, t.evb);
      if (t.eva > 15) fx.state = 3;
      t.sinIndex = s16(t.sinIndex + 12);
      t.amp = s16(t.amp - 384);
      fx.hofs0 = { idx: t.sinIndex, amp: t.amp >> 8 };
      fx.T.vblankDma = true;
      return false;
    },
    (fx: FxState): boolean => {
      const t = fx.t;
      fx.T.vblankDma = false;
      bigBlend(t, true);
      fx.T.bldAlpha = seq(t.eva, t.evb);
      if (t.evb === 0) fx.state = 4;
      bigAmp(t);
      fx.hofs0 = { idx: t.sinIndex, amp: t.amp >> 8 };
      fx.T.vblankDma = true;
      return false;
    },
    (fx: FxState): boolean => {
      const t = fx.t;
      fx.T.vblankDma = false;
      bigAmp(t);
      fx.hofs0 = { idx: t.sinIndex, amp: t.amp >> 8 };
      if (t.amp <= 0) {
        fx.state = 5;
        t.radius = DH;
        t.radiusDelta = 256;
        t.vblankSet = false;
      }
      fx.T.vblankDma = true;
      return false;
    },
    (fx: FxState): boolean => {
      const t = fx.t;
      fx.T.vblankDma = false;
      if (t.radiusDelta < 2048) t.radiusDelta = t.radiusDelta + 256;
      if (t.radius !== 0) {
        t.radius = t.radius - (t.radiusDelta >> 8);
        if (t.radius < 0) t.radius = 0;
      }
      setCircularMask(fx.buf0, DW / 2, DH / 2, t.radius);
      if (t.radius === 0) {
        fadeScreenBlack(fx);
        fx.done = true;
      }
      if (!t.vblankSet) {
        t.vblankSet = true;
        fx.maskMode = true;
      }
      fx.T.vblankDma = true;
      return false;
    },
  ),
  vblank: (fx) => {
    const T = fx.T;
    fx.bldAlpha1 = T.bldAlpha;
    if (fx.maskMode) {
      if (!truthy(fx.mask1)) {
        fx.mask1 = [];
        fx.hofs1 = { const: 0 };
      }
      if (T.vblankDma) copyBuf(fx.mask1, fx.buf0, DH);
    } else if (T.vblankDma && truthy(fx.hofs0)) {
      fx.hofs1 = fx.hofs0;
    }
  },
  winSpans: (fx, y, out) => {
    if (!truthy(fx.mask1)) return 0;
    const w = winH(fx.mask1[y]);
    if (!w) {
      out[1] = 0; out[2] = DW;
      return 1;
    }
    const l = w[0], r = w[1];
    let n = 0;
    if (l > 0) { n = n + 1; out[2 * n - 1] = 0; out[2 * n] = l; }
    if (r < DW) { n = n + 1; out[2 * n - 1] = r; out[2 * n] = DW; }
    return n;
  },
};

// src/battle_transition.c:1099
const TRAIL_START_X = [-16, DW + 16]; // { [0] = -16, [1] = DW + 16 }
const TRAIL_DELAYS = seq(0, 16, 32, 8, 24);
const TRAIL_SPEEDS = [8, -8]; // { [0] = 8, [1] = -8 }
const TRAIL_LANE_MIN = -16, TRAIL_LANE_MAX = 20;

// Lua: battle_transition.lua:445
function trailRandom(): number {
  // pcall(require, "src.core.game3.rng"): linked in
  const R: any = Rng;
  if (truthy(R) && truthy(R.Random)) return R.Random();
  return random(0, 0xFFFF);
}

// Lua: battle_transition.lua:451
const DEF_POKEBALLS_TRAIL: Def = {
  funcs: seq(
    (fx: FxState): boolean => {
      fx.trail = {};
      fx.state = 1;
      return false;
    },
    (fx: FxState): boolean => {
      const side0 = trailRandom() & 1;
      for (let lane = TRAIL_LANE_MIN; lane <= TRAIL_LANE_MAX; lane++) {
        const side = side0 ^ (lane & 1);
        fx.sprites[len(fx.sprites) + 1] = {
          x: TRAIL_START_X[side],
          y: lane * 32 + 16,
          lane,
          side,
          delay: TRAIL_DELAYS[mod(lane, 5) + 1],
          prevX: -1,
          rot: 0,
          real: lane >= 0 && lane < 5,
        };
      }
      fx.state = 2;
      return false;
    },
    (fx: FxState): boolean => {
      for (const [, s] of ipairs(fx.sprites)) {
        if (s.real && !s.dead) return false;
      }
      fadeScreenBlack(fx);
      fx.done = true;
      return false;
    },
  ),
  sprite: (fx, s) => {
    s.rot = s.rot + (s.side === 0 ? -4 : 4);
    if (s.delay !== 0) {
      s.delay = s.delay - 1;
      return;
    }
    if (s.x >= 0 && s.x <= DW) {
      const posX = s.x >> 3;
      if (posX !== s.prevX) {
        s.prevX = posX;
        let cols = fx.trail[s.lane];
        if (!truthy(cols)) {
          cols = [];
          fx.trail[s.lane] = cols;
        }
        cols[posX] = true;
      }
    }
    s.x = s.x + TRAIL_SPEEDS[s.side];
    if (s.x < -15 || s.x > DW + 15) s.dead = true;
  },
};

// src/battle_transition.c:1207
// Lua: battle_transition.lua:509
const DEF_CLOCKWISE_WIPE: Def = {
  funcs: seq(
    (fx: FxState): boolean => {
      for (let i = 0; i <= DH - 1; i++) fx.buf1[i] = WIN_RANGE(DW + 3, DW + 4);
      fx.T.endX = DW / 2;
      fx.state = 1;
      return true;
    },
    (fx: FxState): boolean => {
      const T = fx.T, b = fx.buf0;
      T.vblankDma = false;
      initBlackWipe(T, DW / 2, DH / 2, T.endX, -1, 1, 1);
      do {
        b[T.currY] = WIN_RANGE(DW / 2, T.currX + 1);
      } while (!updateBlackWipe(T, true, true));
      T.endX = T.endX + fx.K.wipeStepX;
      if (T.endX >= DW) {
        T.endY = 0;
        fx.state = 2;
      }
      T.vblankDma = true;
      return false;
    },
    (fx: FxState): boolean => {
      const T = fx.T, b = fx.buf0;
      let start = 0, stop = 0;
      let finished = false;
      T.vblankDma = false;
      initBlackWipe(T, DW / 2, DH / 2, DW, T.endY, 1, 1);
      while (true) {
        start = DW / 2;
        stop = T.currX + 1;
        if (T.endY >= DH / 2) {
          start = T.currX;
          stop = DW;
        }
        b[T.currY] = WIN_RANGE(start, stop);
        if (finished) break;
        finished = updateBlackWipe(T, true, true);
      }
      T.endY = T.endY + fx.K.wipeStepY;
      if (T.endY >= DH) {
        T.endX = DW;
        fx.state = 3;
      } else {
        while (T.currY < T.endY) {
          T.currY = T.currY + 1;
          b[T.currY] = WIN_RANGE(start, stop);
        }
      }
      T.vblankDma = true;
      return false;
    },
    (fx: FxState): boolean => {
      const T = fx.T, b = fx.buf0;
      T.vblankDma = false;
      initBlackWipe(T, DW / 2, DH / 2, T.endX, DH, 1, 1);
      do {
        b[T.currY] = u16((T.currX << 8) | DW);
      } while (!updateBlackWipe(T, true, true));
      T.endX = T.endX - fx.K.wipeStepX;
      if (T.endX <= 0) {
        T.endY = DH;
        fx.state = 4;
      }
      T.vblankDma = true;
      return false;
    },
    (fx: FxState): boolean => {
      const T = fx.T, b = fx.buf0;
      let start = 0, stop = 0;
      let finished = false;
      T.vblankDma = false;
      initBlackWipe(T, DW / 2, DH / 2, 0, T.endY, 1, 1);
      while (true) {
        stop = (b[T.currY] ?? 0) & 0xFF;
        start = T.currX;
        if (T.endY <= DH / 2) {
          start = DW / 2;
          stop = T.currX;
        }
        b[T.currY] = WIN_RANGE(start, stop);
        if (finished) break;
        finished = updateBlackWipe(T, true, true);
      }
      T.endY = T.endY - fx.K.wipeStepY;
      if (T.endY <= 0) {
        T.endX = 0;
        fx.state = 5;
      } else {
        while (T.currY > T.endY) {
          T.currY = T.currY - 1;
          b[T.currY] = WIN_RANGE(start, stop);
        }
      }
      T.vblankDma = true;
      return false;
    },
    (fx: FxState): boolean => {
      const T = fx.T, b = fx.buf0;
      T.vblankDma = false;
      initBlackWipe(T, 120, 80, T.endX, 0, 1, 1);
      do {
        let start = DW / 2, stop = T.currX;
        if (T.currX >= 120) {
          start = 0; stop = DW;
        }
        b[T.currY] = WIN_RANGE(start, stop);
      } while (!updateBlackWipe(T, true, true));
      T.endX = T.endX + fx.K.wipeStepX;
      if (T.currX > DW / 2) fx.state = 6;
      T.vblankDma = true;
      return false;
    },
    (fx: FxState): boolean => {
      fadeScreenBlack(fx);
      fx.done = true;
      return false;
    },
  ),
  vblank: (fx) => {
    if (fx.T.vblankDma) copyBuf(fx.buf1, fx.buf0, DH);
  },
  winSpans: (fx, y, out) => {
    const w = winH(fx.buf1[y]);
    if (!w) return 0;
    out[1] = w[0]; out[2] = w[1];
    return 1;
  },
};

// src/battle_transition.c:1412
// Lua: battle_transition.lua:641
const DEF_RIPPLE: Def = {
  funcs: seq(
    (fx: FxState): boolean => {
      fx.rp1 = { sinVal: 0, amp: 0 };
      fx.state = 1;
      return true;
    },
    (fx: FxState): boolean => {
      const t = fx.t;
      fx.T.vblankDma = false;
      const amp = t.amp >> 8;
      const sinVal = u16(t.sinVal);
      t.sinVal = s16(t.sinVal + 0x400);
      if (t.amp <= 0x1FFF) t.amp = t.amp + 384;
      fx.rp0 = { sinVal, amp };
      t.timer = t.timer + 1;
      if (t.timer === fx.K.rippleFadeAt) {
        t.fadeStarted = true;
        fx.pal.beginFade(Pal.ALL, fx.K.rippleFadeDelay, 0, 16, Pal.BLACK);
      }
      if (t.fadeStarted && !fx.pal.fadeActive()) fx.done = true;
      fx.T.vblankDma = true;
      return false;
    },
  ),
  init: (fx) => { fx.t.sinVal = 0; fx.t.amp = 0; fx.t.timer = 0; },
  vblank: (fx) => {
    if (fx.T.vblankDma && truthy(fx.rp0)) fx.rp1 = fx.rp0;
  },
  shift: (fx, y) => {
    const s = fx.rp1;
    if (!truthy(s)) return shiftRet(0, 0);
    return shiftRet(0, Sin(u16(s.sinVal + 384 * y) >>> 8, s.amp));
  },
  redraw: true,
};

// src/battle_transition.c:1489
// Lua: battle_transition.lua:679
function waveX(w: { x: number; idx: number }, y: number): number {
  let x = w.x + Sin(u8(w.idx + 4 * y), 40);
  if (x < 0) x = 0;
  if (x > DW) x = DW;
  return x;
}

// Lua: battle_transition.lua:686
const DEF_WAVE: Def = {
  funcs: seq(
    (fx: FxState): boolean => {
      fx.state = 1;
      return true;
    },
    (fx: FxState): boolean => {
      const t = fx.t;
      fx.T.vblankDma = false;
      const sinIndex = u8(t.sinIndex);
      t.sinIndex = s16(t.sinIndex + 16);
      t.x = t.x + 8;
      const w = { x: t.x, idx: sinIndex };
      let finished = true;
      for (let i = 0; i <= DH - 1; i++) {
        if (waveX(w, i) < DW) {
          finished = false;
          break;
        }
      }
      fx.wv0 = w;
      if (finished) fx.state = 2;
      fx.T.vblankDma = true;
      return false;
    },
    (fx: FxState): boolean => {
      fadeScreenBlack(fx);
      fx.done = true;
      return false;
    },
  ),
  init: (fx) => { fx.t.sinIndex = 0; fx.t.x = 0; },
  vblank: (fx) => {
    if (fx.T.vblankDma && truthy(fx.wv0)) fx.wv1 = fx.wv0;
  },
  rowSpans: (fx, y, R, out) => {
    const w = fx.wv1;
    if (!truthy(w)) return 0;
    const x = waveX(w, y);
    if (x <= 0) return 0;
    out[1] = R.X0; out[2] = R.hmapR(x);
    return 1;
  },
};

// src/battle_transition.c:2293
// Lua: battle_transition.lua:732
const DEF_SLICE: Def = {
  funcs: seq(
    (fx: FxState): boolean => {
      fx.t.speed = 256;
      fx.t.accel = 1;
      fx.sl1 = 0;
      fx.state = 1;
      return true;
    },
    (fx: FxState): boolean => {
      const t = fx.t;
      fx.T.vblankDma = false;
      t.effectX = t.effectX + (t.speed >> 8);
      if (t.effectX > DW) t.effectX = DW;
      if (t.speed <= 0xFFF) t.speed = t.speed + t.accel;
      if (t.accel < 128) t.accel = t.accel * 2;
      fx.sl0 = t.effectX;
      if (t.effectX >= DW) fx.state = 2;
      fx.T.vblankDma = true;
      return false;
    },
    (fx: FxState): boolean => {
      fadeScreenBlack(fx);
      fx.done = true;
      return false;
    },
  ),
  init: (fx) => { fx.t.effectX = 0; },
  vblank: (fx) => {
    if (fx.T.vblankDma && fx.sl0 != null) fx.sl1 = fx.sl0;
  },
  rowSpans: (fx, y, R, out) => {
    const e = R.hdist(fx.sl1 ?? 0);
    if (e <= 0) return 0;
    if ((y & 1) === 1) {
      out[1] = R.X1 - e; out[2] = R.X1;
    } else {
      out[1] = R.X0; out[2] = R.X0 + e;
    }
    return 1;
  },
  shift: (fx, y, R) => {
    const e = R.hdist(fx.sl1 ?? 0);
    if ((y & 1) === 1) return shiftRet(e, 0);
    return shiftRet(-e, 0);
  },
  redraw: true,
};

// src/battle_transition.c:2402
const NUM_WHITE_BARS = 6;
const WHITE_BAR_HEIGHT = 1 + Math.floor(DH / NUM_WHITE_BARS);
const WHITE_BAR_DELAYS = seq(0, 9, 15, 6, 12, 3);
const FADE_TARGET = 16 * 256;

// Lua: battle_transition.lua:787
const DEF_WHITE_BARS_FADE: Def = {
  funcs: seq(
    (fx: FxState): boolean => {
      for (let i = 0; i <= DH - 1; i++) {
        fx.buf1[i] = 0;
        fx.buf0[i] = 0;
      }
      fx.barLevel = [];
      fx.barLevel1 = [];
      for (let i = 0; i <= NUM_WHITE_BARS - 1; i++) {
        fx.barLevel[i] = 0;
        fx.barLevel1[i] = 0;
      }
      fx.T.counter = 0;
      fx.state = 1;
      return false;
    },
    (fx: FxState): boolean => {
      let posY = 0;
      let last: any;
      for (let i = 0; i <= NUM_WHITE_BARS - 1; i++) {
        last = {
          x: DW, y: posY, bar: i, fade: 0, finished: false,
          delay: WHITE_BAR_DELAYS[i + 1], main: false,
        };
        fx.sprites[len(fx.sprites) + 1] = last;
        posY = posY + WHITE_BAR_HEIGHT;
      }
      last.main = true;
      fx.state = 2;
      return false;
    },
    (fx: FxState): boolean => {
      fx.T.vblankDma = false;
      if (fx.T.counter >= NUM_WHITE_BARS) {
        fx.pal.blend(Pal.ALL, 16, Pal.WHITE);
        fx.state = 3;
      }
      return false;
    },
    (fx: FxState): boolean => {
      fx.T.vblankDma = false;
      fx.darkenPhase = true;
      fx.T.bldY = 0;
      fx.T.counter = 0;
      fx.state = 4;
      return false;
    },
    (fx: FxState): boolean => {
      const T = fx.T;
      T.counter = T.counter + 480;
      T.bldY = T.counter >> 8;
      if (T.bldY > 16) {
        fadeScreenBlack(fx);
        fx.done = true;
      }
      return false;
    },
  ),
  sprite: (fx, s) => {
    const T = fx.T;
    if (s.delay !== 0) {
      s.delay = s.delay - 1;
      if (s.main) T.vblankDma = true;
      return;
    }
    const h = s.main ? (WHITE_BAR_HEIGHT - 2) : WHITE_BAR_HEIGHT;
    const lvl = s.fade >>> 8;
    for (let i = 0; i <= h - 1; i++) fx.buf0[s.y + i] = lvl;
    fx.barLevel[s.bar] = lvl;
    if (s.x === 0 && s.fade === FADE_TARGET) s.finished = true;
    s.x = s.x - 24;
    s.fade = s.fade + 192;
    if (s.x < 0) s.x = 0;
    if (s.fade > FADE_TARGET) s.fade = FADE_TARGET;
    if (s.main) T.vblankDma = true;
    if (s.finished && (!s.main || T.counter > 4)) {
      T.counter = T.counter + 1;
      s.dead = true;
    }
  },
  vblank: (fx) => {
    if (fx.T.vblankDma && !fx.darkenPhase) {
      copyBuf(fx.buf1, fx.buf0, DH);
      for (let i = 0; i <= NUM_WHITE_BARS - 1; i++) fx.barLevel1[i] = fx.barLevel[i];
    }
  },
  post: (fx, R, G) => {
    if (fx.darkenPhase) {
      let y = fx.T.bldY;
      if (y > 16) y = 16;
      if (y > 0) {
        G.setColor(0, 0, 0, y / 16);
        G.rectangle("fill", R.X0, R.Y0, R.X1 - R.X0, R.Y1 - R.Y0);
      }
      return;
    }
    if (!truthy(fx.barLevel1)) return;
    R.rowBands!((y: number) => {
      let v: number;
      if (y >= 0 && y < DH) {
        v = fx.buf1[y] ?? 0;
      } else {
        v = fx.barLevel1[mod(Math.floor(y / WHITE_BAR_HEIGHT), NUM_WHITE_BARS)] ?? 0;
      }
      if (v > 16) v = 16;
      return v;
    }, (v: number, y0: number, y1: number) => {
      if (v > 0) {
        G.setColor(1, 1, 1, v / 16);
        G.rectangle("fill", R.X0, y0, R.X1 - R.X0, y1 - y0);
      }
    });
  },
};

// src/battle_transition.c:2583
// Lua: battle_transition.lua:904
const DEF_GRID_SQUARES: Def = {
  funcs: seq(
    (fx: FxState): boolean => {
      fx.gridStage = 0;
      fx.state = 1;
      return false;
    },
    (fx: FxState): boolean => {
      const t = fx.t;
      if (t.delay === 0) {
        t.delay = 3;
        t.stage = t.stage + 1;
        fx.gridStage = t.stage;
        if (t.stage > 13) {
          fx.state = 2;
          t.delay = 16;
        }
      }
      t.delay = t.delay - 1;
      return false;
    },
    (fx: FxState): boolean => {
      const t = fx.t;
      t.delay = t.delay - 1;
      if (t.delay === 0) {
        fadeScreenBlack(fx);
        fx.done = true;
      }
      return false;
    },
  ),
  init: (fx) => { fx.t.delay = 0; fx.t.stage = 0; },
};

// src/battle_transition.c:2641
const ANGLED_MOVE = seq(
  seq(56, 0, 0, DH, 0),
  seq(104, DH, DW, 88, 1),
  seq(DW, 72, 56, 0, 1),
  seq(0, 32, 144, DH, 0),
  seq(144, DH, 184, 0, 1),
  seq(56, 0, 168, DH, 0),
  seq(168, DH, 48, 0, 1),
);
const ANGLED_END_DELAYS = seq(1, 1, 1, 1, 1, 1, 0);

// Lua: battle_transition.lua:950
const DEF_ANGLED_WIPES: Def = {
  funcs: seq(
    (fx: FxState): boolean => {
      for (let i = 0; i <= DH - 1; i++) {
        fx.buf0[i] = WIN_RANGE(0, DW);
        fx.buf1[i] = fx.buf0[i];
      }
      fx.state = 1;
      return true;
    },
    (fx: FxState): boolean => {
      const md = ANGLED_MOVE[fx.t.wipeId + 1]!;
      initBlackWipe(fx.T, md[1]!, md[2]!, md[3]!, md[4]!, 1, 1);
      fx.t.dir = md[5];
      fx.state = 2;
      return true;
    },
    (fx: FxState): boolean => {
      const T = fx.T, b = fx.buf0;
      T.vblankDma = false;
      let finished = false;
      for (let _ = 0; _ <= 15; _++) {
        const v = b[T.currY] ?? 0;
        let left = v >>> 8, right = v & 0xFF;
        if (fx.t.dir === 0) {
          if (left < T.currX) left = T.currX;
          if (left > right) left = right;
        } else {
          if (right > T.currX) right = T.currX;
          if (right <= left) right = left;
        }
        b[T.currY] = WIN_RANGE(left, right);
        if (finished) {
          fx.state = 3;
          break;
        }
        finished = updateBlackWipe(T, true, true);
      }
      T.vblankDma = true;
      return false;
    },
    (fx: FxState): boolean => {
      const t = fx.t;
      t.wipeId = t.wipeId + 1;
      if (t.wipeId < len(ANGLED_MOVE)) {
        fx.state = 4;
        t.delay = ANGLED_END_DELAYS[t.wipeId];
        return true;
      }
      fadeScreenBlack(fx);
      fx.done = true;
      return false;
    },
    (fx: FxState): boolean => {
      const t = fx.t;
      t.delay = t.delay - 1;
      if (t.delay === 0) {
        fx.state = 1;
        return true;
      }
      return false;
    },
  ),
  init: (fx) => { fx.t.wipeId = 0; },
  vblank: (fx) => {
    if (fx.T.vblankDma) copyBuf(fx.buf1, fx.buf0, DH);
  },
  winSpans: (fx, y, out) => {
    const w = winH(fx.buf1[y]);
    if (!w) {
      out[1] = 0; out[2] = DW;
      return 1;
    }
    const l = w[0], r = w[1];
    let n = 0;
    if (l > 0) { n = n + 1; out[2 * n - 1] = 0; out[2 * n] = l; }
    if (r < DW) { n = n + 1; out[2 * n - 1] = r; out[2 * n] = DW; }
    return n;
  },
};

// src/battle_transition.c:1566
const SPIRAL_ANGLE = seq(
  0x0, 0x26E, 0x100, 0x69, 0x0, -0x69, -0x100, -0x266E,
  0x0, 0x26E, 0x100, 0x69, 0x0, -0x69, -0x100, -0x266E,
);

// Lua: battle_transition.lua:1036
function spiralUpdate(b: any[], initRadius: number, dmax: number, off: number): void {
  let sinIndex = 0;
  for (let i = DH * 2; i <= DH * 6 - 1; i++) b[i] = DW / 2;
  let x1 = 0, y1 = 0, x2 = 0, y2 = 0;
  for (let _ = 0; _ <= dmax * 16 - 1; _++) {
    const a1 = initRadius + (sinIndex >>> 3);
    let a2 = a1;
    if ((sinIndex >>> 3) !== ((sinIndex + 1) >>> 3)) a2 = a1 + 1;
    y1 = DH / 2 - Sin(sinIndex, a1);
    x1 = Cos(sinIndex, a1) + DW / 2;
    y2 = DH / 2 - Sin(sinIndex + 1, a2);
    x2 = Cos(sinIndex + 1, a2) + DW / 2;
    if (!((y1 < 0 && y2 < 0) || (y1 > DH - 1 && y2 > DH - 1))) {
      if (y1 < 0) y1 = 0;
      if (y1 > DH - 1) y1 = DH - 1;
      if (x1 < 0) x1 = 0;
      if (x1 > 255) x1 = 255;
      if (y2 < 0) y2 = 0;
      if (y2 > DH - 1) y2 = DH - 1;
      if (x2 < 0) x2 = 0;
      if (x2 > 255) x2 = 255;
      y2 = y2 - y1;
      const base = (sinIndex >= 64 && sinIndex < 192) ? DH * 2 : DH * 3;
      b[y1 + base] = x1;
      if (y2 !== 0) {
        x2 = x2 - x1;
        if (x2 < -1 && x1 > 1) {
          x1 = x1 - 1;
        } else if (x2 > 1 && x1 < 255) {
          x1 = x1 + 1;
        }
        if (y2 < 0) {
          while (y2 < 0) { b[y1 + y2 + base] = x1; y2 = y2 + 1; }
        } else {
          while (y2 > 0) { b[y1 + y2 + base] = x1; y2 = y2 - 1; }
        }
      }
    }
    sinIndex = u8(sinIndex + 1);
  }

  if (off !== 0 && dmax % 4 !== 0) {
    y1 = Sin(dmax * 16, initRadius + (dmax << 1));
    const q = Math.floor(dmax / 4);
    const ang = SPIRAL_ANGLE[dmax + 1]!;
    if (q === 0 || q === 1) {
      if (y1 > DH / 2) y1 = DH / 2;
      for (let i = y1; i >= 1; i--) {
        x1 = ((i * ang) >> 8) + DW / 2;
        if (x1 >= 0 && x1 <= 255) {
          if (q === 0 && b[560 - i] < x1) {
            b[560 - i] = DW / 2;
          } else if (b[400 - i] < x1) {
            b[400 - i] = x1;
          }
        }
      }
    } else {
      if (y1 < -(DH / 2 - 1)) y1 = -(DH / 2 - 1);
      for (let i = y1; i <= 0; i++) {
        x1 = ((i * ang) >> 8) + DW / 2;
        if (x1 >= 0 && x1 <= 255) {
          if (q === 2 && b[400 - i] >= x1) {
            b[400 - i] = DW / 2;
          } else if (b[560 - i] > x1) {
            b[560 - i] = x1;
          }
        }
      }
    }
  }

  for (let i = 0; i <= DH - 1; i++) {
    b[i * 2 + off] = (b[i + DH * 2] << 8) | b[i + DH * 3];
  }
}

// Lua: battle_transition.lua:1113
function spiralWinV(d2: number): number {
  let top = 48 - d2;
  if (top < 0) top = 0;
  let bottom = d2 + 112;
  if (bottom > 255) bottom = 255;
  return u16(top | bottom);
}

// Lua: battle_transition.lua:1121
const DEF_SPIRAL: Def = {
  funcs: seq(
    (fx: FxState): boolean => {
      const T = fx.T;
      T.win0V = WIN_RANGE(48, DH - 48);
      T.win1V = WIN_RANGE(16, DH - 16);
      T.counter = 0;
      spiralUpdate(fx.buf1, 0, 0, 0);
      spiralUpdate(fx.buf1, 0, 0, 1);
      copyBuf(fx.buf0, fx.buf1, DH * 2);
      fx.t.d1 = 0; fx.t.d2 = 0;
      fx.state = 1;
      return false;
    },
    (fx: FxState): boolean => {
      const T = fx.T, t = fx.t;
      spiralUpdate(fx.buf1, t.d2, t.d1, 1);
      T.vblankDma = true;
      t.d1 = t.d1 + 1;
      if (t.d1 === len(SPIRAL_ANGLE) + 1) {
        spiralUpdate(fx.buf1, t.d2, 16, 0);
        T.win0V = spiralWinV(t.d2);
        t.d2 = t.d2 + 32;
        t.d1 = 0;
        spiralUpdate(fx.buf1, t.d2, 0, 1);
        T.win1V = spiralWinV(t.d2);
        T.vblankDma = true;
        if (t.d2 >= DH) {
          T.counter = 1;
          fadeScreenBlack(fx);
        }
      }
      return false;
    },
  ),
  vblank: (fx) => {
    const T = fx.T;
    if (T.counter !== 0) {
      fx.done = true;
      return;
    }
    if (T.vblankDma) {
      copyBuf(fx.buf0, fx.buf1, DH * 2);
      T.vblankDma = false;
    }
    fx.win0V1 = T.win0V; fx.win1V1 = T.win1V;
  },
  winSpans: (fx, y, out) => {
    let n = 0;
    const v0 = winV(fx.win0V1 ?? 0);
    const t0 = v0[0], b0 = v0[1];
    if (y >= t0 && y < b0) {
      const w = winH(fx.buf0[y * 2]);
      if (w) { n = n + 1; out[1] = w[0]; out[2] = w[1]; }
    }
    const v1 = winV(fx.win1V1 ?? 0);
    const t1 = v1[0], b1 = v1[1];
    if (y >= t1 && y < b1) {
      const w = winH(fx.buf0[y * 2 + 1]);
      if (w) { n = n + 1; out[2 * n - 1] = w[0]; out[2 * n] = w[1]; }
    }
    return n;
  },
};

const PIC_SLIDE_SPEEDS = [12, -12]; // { [0] = 12, [1] = -12 }
const PIC_SLIDE_ACCELS = [-1, 1]; // { [0] = -1, [1] = 1 }

// Lua: battle_transition.lua:1187 (PIC_FUNCS, keys 0..6)
const PIC_FUNCS: ((s: any) => boolean)[] = [
  // Lua: battle_transition.lua:1188
  () => false,
  // Lua: battle_transition.lua:1189
  (s) => {
    s.state = 2;
    s.speed = PIC_SLIDE_SPEEDS[s.dir];
    s.accel = PIC_SLIDE_ACCELS[s.dir];
    return true;
  },
  // Lua: battle_transition.lua:1195
  (s) => {
    s.x = s.x + s.speed;
    if (s.dir === 1 && s.x < DW - 107) {
      s.state = 3;
    } else if (s.dir === 0 && s.x > 103) {
      s.state = 3;
    }
    return false;
  },
  // Lua: battle_transition.lua:1204
  (s) => {
    s.speed = s.speed + s.accel;
    s.x = s.x + s.speed;
    if (s.speed === 0) {
      s.state = 4;
      s.accel = -s.accel;
      s.done = true;
    }
    return false;
  },
  // Lua: battle_transition.lua:1214
  () => false,
  // Lua: battle_transition.lua:1215
  (s) => {
    s.speed = s.speed + s.accel;
    s.x = s.x + s.speed;
    if (s.x < -31 || s.x > DW + 31) s.state = 6;
    return false;
  },
  // Lua: battle_transition.lua:1221
  () => false,
];

// Lua: battle_transition.lua:1224
function mugHofs(T: Record<string, any>): void {
  T.hofsOpp = s16(T.hofsOpp - 8);
  T.hofsPl = s16(T.hofsPl + 8);
}

// Lua: battle_transition.lua:1229
const MUGSHOT_DEF: Def = {
  funcs: seq(
    (fx: FxState): boolean => {
      const t = fx.t, T = fx.T;
      const mug = fx.mug;
      const c = mug.coords ?? seq(0, 0);
      fx.opp = {
        x: c[1] - 32, y: c[2] + 42, state: 0, dir: 0, speed: 0, accel: 0,
        pic: mug.pic, scale: mug.scale,
      };
      fx.player = {
        x: DW + 32, y: 106, state: 0, dir: 0, speed: 0, accel: 0,
        pic: mug.playerPic, flip: true, scale: 2,
      };
      fx.sprites[1] = fx.opp;
      fx.sprites[2] = fx.player;
      t.sinIndex = 0;
      t.top = 1;
      t.bottom = DW - 1;
      T.hofsOpp = 0; T.hofsPl = 0;
      for (let i = 0; i <= DH - 1; i++) fx.buf1[i] = WIN_RANGE(DW, DW + 1);
      fx.state = 1;
      return false;
    },
    (fx: FxState): boolean => {
      fx.banner = true;
      fx.state = 2;
      return false;
    },
    (fx: FxState): boolean => {
      const t = fx.t, T = fx.T, b = fx.buf0;
      T.vblankDma = false;
      let si = u8(t.sinIndex);
      t.sinIndex = s16(t.sinIndex + 16);
      for (let i = 0; i <= DH / 2 - 1; i++) {
        let x = t.top + Sin(si, 16);
        if (x < 0) x = 1;
        if (x > DW) x = DW;
        b[i] = x;
        si = u8(si + 16);
      }
      for (let i = DH / 2; i <= DH - 1; i++) {
        let x = t.bottom - Sin(si, 16);
        if (x < 0) x = 0;
        if (x > DW - 1) x = DW - 1;
        b[i] = u16((x << 8) | DW);
        si = u8(si + 16);
      }
      t.top = t.top + 8;
      t.bottom = t.bottom - 8;
      if (t.top > DW) t.top = DW;
      if (t.bottom < 0) t.bottom = 0;
      if (t.top === DW && t.bottom === 0) fx.state = 3;
      mugHofs(T);
      T.vblankDma = true;
      return false;
    },
    (fx: FxState): boolean => {
      const t = fx.t, T = fx.T;
      T.vblankDma = false;
      for (let i = 0; i <= DH - 1; i++) fx.buf0[i] = DW;
      fx.state = 4;
      t.sinIndex = 0; t.top = 0; t.bottom = 0;
      mugHofs(T);
      fx.opp.dir = 0;
      fx.player.dir = 1;
      fx.opp.state = fx.opp.state + 1;
      try { Audio.playSe("SE_MUGSHOT"); } catch { /* pcall */ }
      T.vblankDma = true;
      return false;
    },
    (fx: FxState): boolean => {
      mugHofs(fx.T);
      if (fx.opp.done) {
        fx.state = 5;
        fx.player.state = fx.player.state + 1;
      }
      return false;
    },
    (fx: FxState): boolean => {
      const T = fx.T;
      mugHofs(T);
      if (fx.player.done) {
        T.vblankDma = false;
        for (let i = 0; i <= DH - 1; i++) {
          fx.buf0[i] = 0;
          fx.buf1[i] = 0;
        }
        fx.fadeMode = true;
        fx.t.timer = 0;
        fx.t.spread = 0;
        fx.state = 6;
      }
      return false;
    },
    (fx: FxState): boolean => {
      const t = fx.t, T = fx.T, b = fx.buf0;
      T.vblankDma = false;
      let active = true;
      mugHofs(T);
      if (t.spread < DH / 2) t.spread = t.spread + 2;
      if (t.spread > DH / 2) t.spread = DH / 2;
      t.timer = t.timer + 1;
      if ((t.timer & 1) === 1) {
        active = false;
        for (let i = 0; i <= t.spread; i++) {
          const y1 = DH / 2 - i, y2 = DH / 2 + i;
          if ((b[y1] ?? 0) <= 15) {
            active = true;
            b[y1] = (b[y1] ?? 0) + 1;
          }
          if ((b[y2] ?? 0) <= 15) {
            active = true;
            b[y2] = (b[y2] ?? 0) + 1;
          }
        }
      }
      if (t.spread === DH / 2 && !active) fx.state = 7;
      T.vblankDma = true;
      return false;
    },
    (fx: FxState): boolean => {
      fx.T.vblankDma = false;
      fx.pal.blend(Pal.ALL, 16, Pal.WHITE);
      fx.darken = true;
      fx.t.timer = 0;
      fx.state = 8;
      return true;
    },
    (fx: FxState): boolean => {
      const t = fx.t;
      fx.T.vblankDma = false;
      t.timer = t.timer + 1;
      for (let i = 0; i <= DH - 1; i++) fx.buf0[i] = u16(t.timer * 257);
      if (t.timer > 15) fx.state = 9;
      fx.T.vblankDma = true;
      return false;
    },
    (fx: FxState): boolean => {
      fadeScreenBlack(fx);
      fx.done = true;
      return false;
    },
  ),
  sprite: (_fx, s) => {
    while (PIC_FUNCS[s.state](s)) { /* PIC_FUNCS[s.state](s) */ }
  },
  vblank: (fx) => {
    const T = fx.T;
    if (T.vblankDma) copyBuf(fx.buf1, fx.buf0, DH);
    fx.hofsOpp1 = T.hofsOpp; fx.hofsPl1 = T.hofsPl;
    fx.darken1 = fx.darken;
  },
};

/** DEF (keyed by FRLG transition id), built on first use: no load-time read of Ids. */
let DEF: Record<number, Def> | undefined;

// Lua: battle_transition.lua:210 / :1380 (DEF[ID.X] = ...; for mid in pairs(MUGSHOT_BY_ID))
function frDef(): Record<number, Def> {
  if (DEF) return DEF;
  const ID = Ids.ID;
  const D: Record<number, Def> = {};
  D[ID.BLUR!] = DEF_BLUR;
  D[ID.SWIRL!] = DEF_SWIRL;
  D[ID.SHUFFLE!] = DEF_SHUFFLE;
  D[ID.BIG_POKEBALL!] = DEF_BIG_POKEBALL;
  D[ID.POKEBALLS_TRAIL!] = DEF_POKEBALLS_TRAIL;
  D[ID.CLOCKWISE_WIPE!] = DEF_CLOCKWISE_WIPE;
  D[ID.RIPPLE!] = DEF_RIPPLE;
  D[ID.WAVE!] = DEF_WAVE;
  D[ID.SLICE!] = DEF_SLICE;
  D[ID.WHITE_BARS_FADE!] = DEF_WHITE_BARS_FADE;
  D[ID.GRID_SQUARES!] = DEF_GRID_SQUARES;
  D[ID.ANGLED_WIPES!] = DEF_ANGLED_WIPES;
  D[ID.SPIRAL!] = DEF_SPIRAL;
  for (const [mid] of pairs(Ids.MUGSHOT_BY_ID)) D[mid as number] = MUGSHOT_DEF;
  DEF = D;
  return D;
}

// local DEFS = { frlg = DEF } (frlg's entry is frDef(), made on first use)
const DEFS: Record<string, Record<number, Def>> = {};

BattleTransition.RSE_MODULES = seq(
  "src.core.game3.battle_transition_rse_a",
  "src.core.game3.battle_transition_rse_b",
  "src.core.game3.battle_transition_rse_frontier",
);

// Lua: battle_transition.lua:1390 (BattleTransition.H, built on first read)
let H: Record<string, any> | undefined;
Object.defineProperty(BattleTransition, "H", {
  get: () => H ??= {
    DW, DH, Pal, Audio,
    s16, u16, u8, Sin, Cos,
    WIN_RANGE, winH, winV,
    initBlackWipe, updateBlackWipe,
    setCircularMask, fadeScreenBlack, copyBuf,
    getChrome, getTrainerPic,
  },
  enumerable: true,
});

// Lua: battle_transition.lua:1399
BattleTransition.defs = function (family?: string | null): Record<number, Def> {
  family = truthy(family) ? family : BattleTransition.family();
  const hit = family === "frlg" ? (DEFS.frlg ??= frDef()) : DEFS[family!];
  if (truthy(hit)) return hit!;
  const IdsF = BattleTransition.ids(family);
  const ID = Ids.ID;
  const MUGSHOT_BY_ID = Ids.MUGSHOT_BY_ID;
  const D = frDef();
  const t: Record<number, Def> = {};
  for (const [name, id] of pairs<number>(IdsF.ID)) {
    const frId = ID[name as string];
    if (frId != null && !truthy(MUGSHOT_BY_ID[frId]) && truthy(D[frId])) t[id] = D[frId]!;
  }
  for (const [id] of pairs(IdsF.MUGSHOT_BY_ID)) t[id as number] = MUGSHOT_DEF;
  for (const [, module] of ipairs<string>(BattleTransition.RSE_MODULES)) {
    // require(module).register(t, Ids.ID, BattleTransition.H)
    throw new Error("NOT FAITHFUL: Emerald only (" + module + ")");
  }
  DEFS[family!] = t;
  return t;
};

// Lua: battle_transition.lua:1417
function mugshotFor(IdsF: any, key: string, female: boolean): any {
  if (IdsF.family === "frlg") {
    // pokefirered/src/battle_transition.c:360
    const pics: Record<string, number> = { lorelei: 112, bruno: 113, agatha: 114, lance: 115, blue: 125 };
    const coords: Record<string, LuaTable> = {
      lorelei: seq(-8, 0), bruno: seq(-10, 0), agatha: seq(0, 0), lance: seq(-32, 0), blue: seq(0, 0),
    };
    return {
      pic: pics[key] ?? 125, coords: coords[key] ?? seq(0, 0), scale: 2,
      playerPic: female ? 136 : 135,
    };
  }
  const Chrome = getChrome();
  const manifest = (truthy(Chrome) && truthy(Chrome.manifest) && Chrome.manifest()) || {};
  const [pics, coords, scales] = IdsF.mugshotTables(manifest);
  const sc = scales[key];
  return {
    pic: pics[key],
    coords: coords[key] ?? seq(0, 0),
    scale: truthy(sc) ? sc[1] / 256 : 2,
    playerPic: IdsF.MUGSHOT_PLAYER_PIC[female ? "female" : "male"],
  };
}

//------------------------------------------------------------------------------
// Orchestrator Lifecycle
//------------------------------------------------------------------------------

// Lua: battle_transition.lua:1443
function newFx(tid: number, opts: any): FxState {
  const IdsF = BattleTransition.ids();
  const defs = BattleTransition.defs(IdsF.family);
  let def = defs[tid];
  if (!truthy(def)) {
    if (IdsF.family !== "frlg") {
      console.log("[game3/battle_transition] transition " + tostring(tid) + " has no port; drawing SLICE");
    }
    def = defs[IdsF.ID.SLICE]!;
  }
  const fx: FxState = {
    id: tid, def: def!, state: 0, t: {}, T: { vblankDma: false },
    buf0: [], buf1: [], sprites: seq(), done: false,
    pal: BattleTransition._pal!, opts: opts ?? {}, K: IdsF.TUNE,
  };
  fx.mugKey = IdsF.MUGSHOT_BY_ID[tid];
  const g = truthy(opts) ? opts.playerGender : undefined;
  fx.female = (g === 1 || g === "female");
  if (truthy(fx.mugKey)) fx.mug = mugshotFor(IdsF, fx.mugKey!, fx.female);
  if (def!.init) def!.init(fx);
  return fx;
}

// Lua: battle_transition.lua:1466
function stepFx(fx: FxState): void {
  const def = fx.def;
  const funcs = def.funcs;
  while (!fx.done) {
    const f = funcs[fx.state + 1];
    if (!truthy(f) || !f(fx)) break;
  }
  if (def.sprite) {
    const alive: LuaTable = seq();
    let n = 0;
    for (const [, s] of ipairs(fx.sprites)) {
      if (!s.dead) def.sprite(fx, s);
      if (!s.dead || s.real) { n = n + 1; alive[n] = s; }
    }
    fx.sprites = alive;
  }
  fx.pal.updateFade();
  if (def.vblank) def.vblank(fx);
}

// src/battle_transition.c:2798
// Lua: battle_transition.lua:1486
function introStep(intro: any, pal: Pal): boolean {
  if (intro.state === 0) {
    intro.blend = intro.blend + 2;
    if (intro.blend > 16) intro.blend = 16;
    pal.blend(Pal.ALL, intro.blend, GRAY);
    if (intro.blend >= 16) intro.state = 1;
  } else {
    intro.blend = intro.blend - 2;
    if (intro.blend < 0) intro.blend = 0;
    pal.blend(Pal.ALL, intro.blend, GRAY);
    if (intro.blend === 0) {
      intro.fades = intro.fades - 1;
      if (intro.fades === 0) return true;
      intro.state = 0;
    }
  }
  return false;
}

// Lua: battle_transition.lua:1505
BattleTransition.start = function (transitionId?: number | null, opts?: any, doneCb?: Fn | null): boolean {
  opts = opts ?? {};
  BattleTransition._active = true;
  BattleTransition._transitionId = transitionId ?? Ids.ID.SLICE!;
  BattleTransition._opts = opts;
  BattleTransition._doneCb = doneCb;
  BattleTransition._frame = 0;
  BattleTransition._pal = Pal.new();
  BattleTransition._fx = undefined;
  BattleTransition._intro = {
    state: 0, blend: 0, fades: BattleTransition.ids().TUNE.introFades, wait: 1,
    done: false,
  };
  BattleTransition._worldDrawn = false;

  if (truthy(opts.skipIntro)) {
    BattleTransition._phase = "main";
  } else {
    BattleTransition._phase = "intro";
  }

  if (truthy(opts.headless)) {
    BattleTransition.finish();
    return true;
  }
  return true;
};

// Lua: battle_transition.lua:1531
BattleTransition.isActive = function (): boolean {
  return BattleTransition._active;
};

// Lua: battle_transition.lua:1535
BattleTransition.finish = function (): void {
  BattleTransition._active = false;
  BattleTransition._phase = "done";
  BattleTransition._fx = undefined;
  BattleTransition._mosaicCanvas = undefined;
  BattleTransition._mosaicKey = undefined;
  const cb = BattleTransition._doneCb;
  BattleTransition._doneCb = undefined;
  if (cb) cb();
};

// Lua: battle_transition.lua:1546
BattleTransition.abort = function (): void {
  BattleTransition._active = false;
  BattleTransition._phase = "idle";
  BattleTransition._fx = undefined;
  BattleTransition._doneCb = undefined;
  BattleTransition._mosaicCanvas = undefined;
  BattleTransition._mosaicKey = undefined;
};

// Lua: battle_transition.lua:1555
BattleTransition.tick = function (_dt?: number): boolean {
  if (!BattleTransition._active) return false;
  BattleTransition._frame = BattleTransition._frame + 1;
  const phase = BattleTransition._phase;

  if (phase === "intro") {
    const intro = BattleTransition._intro;
    if (intro.wait > 0) {
      intro.wait = intro.wait - 1;
    } else if (!intro.done) {
      if (introStep(intro, BattleTransition._pal!)) intro.done = true;
    } else {
      BattleTransition._phase = "main";
    }
    BattleTransition._pal!.updateFade();
    return true;
  }

  if (phase === "main") {
    let fx = BattleTransition._fx;
    if (!fx) {
      fx = newFx(BattleTransition._transitionId, BattleTransition._opts);
      BattleTransition._fx = fx;
    }
    stepFx(fx);
    if (fx.done) BattleTransition._phase = "ending";
    return true;
  }

  if (phase === "ending") {
    BattleTransition.finish();
    return true;
  }

  return false;
};

// Lua: battle_transition.lua:1592
function makeView(X0: number, X1: number, Y0: number, Y1: number): View {
  const span = X1 - X0;
  const R = { X0, X1, Y0, Y1 } as View;
  R.hdist = (v) => Math.floor(v * span / DW + 0.5);
  R.hmap = (x) => X0 + Math.floor(x * span / DW + 0.5);
  R.hmapL = (x) => { if (x <= 0) return X0; return R.hmap(x); };
  R.hmapR = (x) => { if (x >= DW) return X1; return R.hmap(x); };
  return R;
}

const SCRATCH: number[] = [];

// Lua: battle_transition.lua:1604
BattleTransition.blackSpans = function (y: number, X0?: number, X1?: number): LuaTable {
  const fx = BattleTransition._fx;
  if (!fx) return seq();
  const out: LuaTable = seq();
  const pal = fx.pal.slots[0]!;
  if (pal.y >= 16 && pal.color === Pal.BLACK) {
    return seq(X0 ?? 0, X1 ?? DW);
  }
  const def = fx.def;
  const R = makeView(X0 ?? 0, X1 ?? DW, 0, DH);
  let n = 0;
  if (def.rowSpans) {
    n = def.rowSpans(fx, y, R, SCRATCH);
  } else if (def.winSpans) {
    n = def.winSpans(fx, y, SCRATCH);
  }
  for (let i = 1; i <= 2 * n; i++) out[i] = SCRATCH[i];
  return out;
};

// Lua: battle_transition.lua:1624
BattleTransition.screenCoverage = function (): number {
  let covered = 0;
  for (let y = 0; y <= DH - 1; y++) {
    const s = BattleTransition.blackSpans(y);
    const row: Record<number, boolean> = {};
    for (let i = 1; i <= len(s); i += 2) {
      for (let x = Math.max(0, s[i]); x <= Math.min(DW, s[i + 1]) - 1; x++) row[x] = true;
    }
    for (const _ of pairs(row)) covered = covered + 1;
  }
  return covered / (DW * DH);
};

// Lua: battle_transition.lua:1637
function mergeRuns(R: View, valueFn: (y: number) => any, drawFn: (v: any, y0: number, y1: number) => void): void {
  let cur: any, start: number | undefined;
  for (let y = R.Y0; y <= R.Y1 - 1; y++) {
    const v = valueFn(y);
    if (v !== cur) {
      if (start != null && cur != null) drawFn(cur, start, y);
      cur = v; start = y;
    }
  }
  if (start != null && cur != null) drawFn(cur, start, R.Y1);
}

// Lua: battle_transition.lua:1649
function drawFieldRows(R: View, G: GT, fx: FxState | null | undefined): void {
  const tex = R.field;
  if (!tex) return;
  const def = fx ? fx.def : undefined;
  if (fx && def!.shift) {
    const q = R.fieldQuad!;
    let runStart: number | undefined, rdx = 0, rdy = 0;
    const flush = (yEnd: number): void => {
      if (runStart == null) return;
      q.setViewport(rdx, runStart + rdy + R.gy!, R.X1 - R.X0, yEnd - runStart);
      G.draw(tex, q, R.X0, runStart);
    };
    for (let y = R.Y0; y <= R.Y1 - 1; y++) {
      const d = def!.shift(fx, y, R);
      const dx = d[0], dy = d[1];
      if (!(runStart != null && dx === rdx && dy === rdy)) {
        flush(y);
        runStart = y; rdx = dx; rdy = dy;
      }
    }
    flush(R.Y1);
    return;
  }
  if (fx && truthy(fx.mosaic) && fx.mosaic > 0 && truthy(G.newCanvas)) {
    const m = fx.mosaic + 1;
    const bx0 = Math.floor(R.X0 / m), by0 = Math.floor(R.Y0 / m);
    const cw = Math.floor((R.X1 - 1) / m) - bx0 + 1;
    const ch = Math.floor((R.Y1 - 1) / m) - by0 + 1;
    // One canvas per transition, grown only when a level needs more room;
    // each level draws just its cw x ch corner through a quad.
    let small = BattleTransition._mosaicCanvas;
    let key = BattleTransition._mosaicKey;
    const keyIsTable = key !== null && typeof key === "object";
    if (!small || !keyIsTable || key.w < cw || key.h < ch) {
      if (small && small.release) { try { small.release(); } catch { /* pcall */ } }
      const nw = Math.max(cw, (keyIsTable && small) ? key.w : 0);
      const nh = Math.max(ch, (keyIsTable && small) ? key.h : 0);
      small = G.newCanvas(nw, nh, { dpiscale: 1 });
      small.setFilter("nearest", "nearest");
      key = { w: nw, h: nh, quad: G.newQuad(0, 0, cw, ch, nw, nh) };
      BattleTransition._mosaicCanvas = small;
      BattleTransition._mosaicKey = key;
    }
    key.quad.setViewport(0, 0, cw, ch, key.w, key.h);
    G.push("all");
    G.origin();
    G.setCanvas(small);
    G.clear(0, 0, 0, 1);
    G.setColor(1, 1, 1, 1);
    G.draw(tex, -bx0 + 0.5 - (R.gx! + 0.5) / m, -by0 + 0.5 - (R.gy! + 0.5) / m, 0, 1 / m, 1 / m);
    G.pop();
    G.setColor(1, 1, 1, 1);
    G.draw(small, key.quad, bx0 * m, by0 * m, 0, m, m);
    return;
  }
  G.draw(tex, R.X0, R.Y0);
}

// Lua: battle_transition.lua:1705
function drawSpanRows(R: View, G: GT, spanFn: (y: number, out: number[]) => number): void {
  // `rows`: the sequence of row keys (rowKeys) and the key -> spans hash (rowSpans)
  const rowKeys: string[] = [];
  const rowSpans: Record<string, number[]> = {};
  const tmp: number[] = [];
  for (let y = R.Y0; y <= R.Y1 - 1; y++) {
    const k = spanFn(y, tmp);
    let key = "";
    for (let i = 1; i <= 2 * k; i++) key = key + tmp[i] + ",";
    rowKeys.push(key);
    if (rowSpans[key] == null) {
      const s: number[] = [0]; // 1-based: { unpack(tmp, 1, 2 * k) }
      for (let i = 1; i <= 2 * k; i++) s.push(tmp[i]);
      rowSpans[key] = s;
    }
  }
  G.setColor(0, 0, 0, 1);
  let cur: string | undefined, start = R.Y0;
  const flush = (yEnd: number): void => {
    if (cur == null || cur === "") return;
    const s = rowSpans[cur];
    for (let i = 1; i < s.length; i += 2) {
      if (s[i + 1] > s[i]) G.rectangle("fill", s[i], start, s[i + 1] - s[i], yEnd - start);
    }
  };
  for (let i = 1; i <= rowKeys.length; i++) {
    const y = R.Y0 + i - 1;
    if (rowKeys[i - 1] !== cur) {
      flush(y);
      cur = rowKeys[i - 1]; start = y;
    }
  }
  flush(R.Y1);
}

// Lua: battle_transition.lua:1734
function drawWindowBlack(R: View, G: GT, fx: FxState): void {
  const def = fx.def;
  const screen: number[][] = [];
  const tmp: number[] = [];
  for (let y = 0; y <= DH - 1; y++) {
    const n = def.winSpans!(fx, y, tmp);
    const s: number[] = [0]; // 1-based
    for (let i = 1; i <= 2 * n; i++) s[i] = tmp[i];
    screen[y] = s;
  }
  const sub = { X0: Math.max(R.X0, 0), X1: Math.min(R.X1, DW), Y0: Math.max(R.Y0, 0), Y1: Math.min(R.Y1, DH) } as View;
  drawSpanRows(sub, G, (y, out) => {
    const s = screen[y];
    let k = 0;
    for (let i = 1; i < s.length; i += 2) {
      const a = Math.max(s[i], sub.X0), b = Math.min(s[i + 1], sub.X1);
      if (b > a) {
        k = k + 1;
        out[2 * k - 1] = a; out[2 * k] = b;
      }
    }
    return k;
  });
  if (R.X0 >= 0 && R.Y0 >= 0 && R.X1 <= DW && R.Y1 <= DH) return;
  const blackAt = (x: number, y: number): boolean => {
    const s = screen[y];
    for (let i = 1; i < s.length; i += 2) {
      if (x >= s[i] && x < s[i + 1]) return true;
    }
    return false;
  };
  const cx = DW / 2, cy = DH / 2, K = 64;
  const wedge = (ax: number, ay: number, bx: number, by: number): void => {
    G.polygon("fill", ax, ay, bx, by,
      cx + (bx - cx) * K, cy + (by - cy) * K,
      cx + (ax - cx) * K, cy + (ay - cy) * K);
  };
  G.setColor(0, 0, 0, 1);
  const edge = (count: number, test: (i: number) => boolean, emit: (a: number, b: number) => void): void => {
    let runStart: number | undefined;
    for (let i = 0; i <= count; i++) {
      const on = i < count && test(i);
      if (on && runStart == null) {
        runStart = i;
      } else if (!on && runStart != null) {
        emit(runStart, i);
        runStart = undefined;
      }
    }
  };
  edge(DW, (x) => blackAt(x, 0), (a, b) => wedge(a, 0, b, 0));
  edge(DW, (x) => blackAt(x, DH - 1), (a, b) => wedge(a, DH, b, DH));
  edge(DH, (y) => blackAt(0, y), (a, b) => wedge(0, a, 0, b));
  edge(DH, (y) => blackAt(DW - 1, y), (a, b) => wedge(DW, a, DW, b));
}

// Lua: battle_transition.lua:1790
function drawBigPokeball(R: View, G: GT, fx: FxState): void {
  if (!fx.pattern) return;
  const Chrome = getChrome();
  const img = truthy(Chrome) && truthy(Chrome.bigPokeball) ? Chrome.bigPokeball() : undefined;
  const ba = fx.bldAlpha1 ?? seq(0, 16);
  const eva = Math.min(16, ba[1]), evb = Math.min(16, ba[2]);
  if (!truthy(img)) return;
  let q = BattleTransition._bigQuad;
  if (!q) {
    q = G.newQuad(0, 0, 1, 1, DW, DH);
    BattleTransition._bigQuad = q;
  }
  const h = fx.hofs1 ?? { const: 240 };
  const rowHofs = (y: number): number => {
    if (h.const != null) return h.const;
    return Sin(h.idx + 132 * y, h.amp);
  };
  const pass = (): void => {
    for (let y = 0; y <= DH - 1; y++) {
      const s = rowHofs(y) & 0xFF;
      if (s < DW) {
        q!.setViewport(s, y, DW - s, 1);
        G.draw(img, q!, 0, y);
      }
      if (s > 16) {
        q!.setViewport(0, y, s - 16, 1);
        G.draw(img, q!, 256 - s, y);
      }
    }
  };
  if (evb < 16) {
    G.setColor(0, 0, 0, 1 - evb / 16);
    pass();
  }
  if (eva > 0) {
    G.setBlendMode("add");
    G.setColor(eva / 16, eva / 16, eva / 16, 1);
    pass();
    G.setBlendMode("alpha");
  }
  G.setColor(1, 1, 1, 1);
}

// Lua: battle_transition.lua:1833
function drawTrail(R: View, G: GT, fx: FxState): void {
  if (!truthy(fx.trail)) return;
  G.setColor(0, 0, 0, 1);
  for (const [lane, cols] of pairs<any>(fx.trail)) {
    const y0 = (lane as number) * 32;
    if (y0 + 32 > R.Y0 && y0 < R.Y1) {
      let runStart: number | undefined;
      for (let c = 0; c <= 32; c++) {
        const on = cols[c];
        if (on && runStart == null) {
          runStart = c;
        } else if (!on && runStart != null) {
          const a = R.hmapL(runStart * 8), b = R.hmapR(c * 8);
          if (b > a) G.rectangle("fill", a, y0, b - a, 32);
          runStart = undefined;
        }
      }
    }
  }
  const Chrome = getChrome();
  const ball = truthy(Chrome) && truthy(Chrome.slidingPokeball) ? Chrome.slidingPokeball() : undefined;
  if (!truthy(ball)) return;
  G.setColor(1, 1, 1, 1);
  for (const [, s] of ipairs(fx.sprites)) {
    if (!s.dead && s.y + 16 > R.Y0 && s.y - 16 < R.Y1) {
      G.draw(ball, R.hmap(s.x), s.y, -s.rot * Math.PI * 2 / 256, 1, 1, 16, 16);
    }
  }
}

// Lua: battle_transition.lua:1863
function drawGrid(R: View, G: GT, fx: FxState): void {
  const stage = fx.gridStage ?? 0;
  if (stage <= 0) return;
  const Chrome = getChrome();
  const img = truthy(Chrome) && truthy(Chrome.gridFrame) ? Chrome.gridFrame(stage) : undefined;
  if (!truthy(img)) {
    if (stage >= 14) {
      G.setColor(0, 0, 0, 1);
      G.rectangle("fill", R.X0, R.Y0, R.X1 - R.X0, R.Y1 - R.Y0);
    }
    return;
  }
  let q = BattleTransition._gridQuad;
  if (!q) {
    q = G.newQuad(0, 0, 1, 1, 8, 8);
    BattleTransition._gridQuad = q;
  }
  q.setViewport(R.X0, R.Y0, R.X1 - R.X0, R.Y1 - R.Y0, 8, 8);
  G.setColor(1, 1, 1, 1);
  G.draw(img, q, R.X0, R.Y0);
}

// Lua: battle_transition.lua:1885
function drawMugshot(R: View, G: GT, fx: FxState): void {
  const Chrome = getChrome();
  const vsbar = fx.banner && truthy(Chrome) && truthy(Chrome.vsbar)
    ? Chrome.vsbar(fx.mugKey, fx.female ? "female" : "male") : undefined;
  if (truthy(vsbar)) {
    let q = BattleTransition._vsQuad;
    if (!q) {
      q = G.newQuad(0, 0, 1, 1, 256, DH);
      BattleTransition._vsQuad = q;
    }
    G.setColor(1, 1, 1, 1);
    const y0 = Math.max(R.Y0, 0), y1 = Math.min(R.Y1, DH);
    for (let y = y0; y <= y1 - 1; y++) {
      let a: number | undefined, b: number | undefined;
      if (fx.fadeMode) {
        a = R.X0; b = R.X1;
      } else {
        const w = winH(fx.buf1[y]);
        if (w) { a = R.hmapL(w[0]); b = R.hmapR(w[1]); }
      }
      if (a != null && b! > a) {
        const hofs = (y < DH / 2) ? (fx.hofsOpp1 ?? 0) : (fx.hofsPl1 ?? 0);
        q.setViewport(a + hofs, y, b! - a, 1, 256, DH);
        G.draw(vsbar, q, a, y);
      }
    }
  }
  const TP = getTrainerPic();
  if (!truthy(TP)) return;
  let pq = BattleTransition._picQuad;
  if (!pq) {
    pq = G.newQuad(0, 0, 64, 32, 64, 64);
    BattleTransition._picQuad = pq;
  }
  G.setColor(1, 1, 1, 1);
  // ipairs({ fx.opp, fx.player }): stops at the first nil
  for (const s of [fx.opp, fx.player]) {
    if (s == null) break;
    const entry = truthy(TP.front) ? TP.front(s.pic) : undefined;
    const img = truthy(entry) ? (entry.image ?? entry) : undefined;
    if (img instanceof Image) {
      const k = s.scale ?? 2;
      const sx = s.flip ? -k : k;
      G.draw(img, pq, R.hmap(s.x), s.y, 0, sx, k, 32, 16);
    }
  }
}

// Lua: battle_transition.lua:1930
function drawMugshotPost(R: View, G: GT, fx: FxState): void {
  if (!fx.fadeMode) return;
  if (fx.darken1) {
    let v = (fx.buf1[0] ?? 0) & 0x1F;
    if (v > 16) v = 16;
    if (v > 0) {
      G.setColor(0, 0, 0, v / 16);
      G.rectangle("fill", R.X0, R.Y0, R.X1 - R.X0, R.Y1 - R.Y0);
    }
    return;
  }
  mergeRuns(R, (y) => {
    let yy = y;
    if (yy < 0) yy = 0;
    if (yy > DH - 1) yy = DH - 1;
    let v = (fx.buf1[yy] ?? 0) & 0x1F;
    if (v > 16) v = 16;
    return v;
  }, (v, y0, y1) => {
    if (v > 0) {
      G.setColor(1, 1, 1, v / 16);
      G.rectangle("fill", R.X0, y0, R.X1 - R.X0, y1 - y0);
    }
  });
}

// Lua: battle_transition.lua:1956
function render(R: View, G: GT): void {
  const fx = BattleTransition._fx;
  R.rowBands = (valueFn, drawFn) => { mergeRuns(R, valueFn, drawFn); };
  G.setColor(1, 1, 1, 1);
  G.setBlendMode("alpha");
  if (fx && fx.def.redraw) drawFieldRows(R, G, fx);
  if (fx) {
    const def = fx.def;
    if (def === DEF_BIG_POKEBALL) drawBigPokeball(R, G, fx);
    if (def === DEF_GRID_SQUARES) drawGrid(R, G, fx);
    if (def === DEF_POKEBALLS_TRAIL) drawTrail(R, G, fx);
    if (truthy(fx.mugKey)) drawMugshot(R, G, fx);
    if (def.draw) def.draw(fx, R, G);
    if (def.rowSpans) {
      drawSpanRows(R, G, (y, out) => def.rowSpans!(fx, y, R, out));
    } else if (def.winSpans) {
      drawWindowBlack(R, G, fx);
    }
  }
  const pal = BattleTransition._pal ? BattleTransition._pal.slots[0] : undefined;
  if (pal && pal.y > 0) {
    const c = pal.color ?? Pal.BLACK;
    G.setColor(c[1] / 31, c[2] / 31, c[3] / 31, Math.min(16, pal.y) / 16);
    G.rectangle("fill", R.X0, R.Y0, R.X1 - R.X0, R.Y1 - R.Y0);
  }
  if (fx) {
    if (fx.def.post) fx.def.post(fx, R, G);
    if (truthy(fx.mugKey)) drawMugshotPost(R, G, fx);
  }
  G.setColor(1, 1, 1, 1);
}

// Lua: battle_transition.lua:1988
function viewFor(gx: number, gy: number, w: number, h: number): View {
  const R = makeView(-gx, w - gx, -gy, h - gy);
  R.gx = gx; R.gy = gy;
  return R;
}

// Lua: battle_transition.lua:1994
BattleTransition.drawWorld = function (canvas: Canvas | null | undefined, vw: number, vh: number): boolean {
  if (!BattleTransition._active) return false;
  if (BattleTransition._opts && truthy(BattleTransition._opts.overUi)) return false;
  if (!canvas) return false;
  const G = LG;
  const gx = Math.floor((vw - DW) / 2), gy = Math.floor((vh - DH) / 2);
  const R = viewFor(gx, gy, vw, vh);
  const fx = BattleTransition._fx;
  G.push("all");
  G.origin();
  if (fx && fx.def.redraw) {
    let scratch = BattleTransition._scratch;
    if (!scratch || scratch.getWidth() !== vw || scratch.getHeight() !== vh) {
      if (scratch && scratch.release) { try { scratch.release(); } catch { /* pcall */ } }
      scratch = G.newCanvas(vw, vh, { dpiscale: 1 });
      scratch.setFilter("nearest", "nearest");
      try { scratch.setWrap("repeat", "repeat"); } catch { /* pcall */ }
      BattleTransition._scratch = scratch;
      BattleTransition._fieldQuad = G.newQuad(0, 0, 1, 1, vw, vh);
    }
    G.setCanvas(scratch);
    G.clear(0, 0, 0, 1);
    G.setColor(1, 1, 1, 1);
    G.draw(canvas, 0, 0);
    G.setCanvas(canvas);
    G.clear(0, 0, 0, 1);
    R.field = scratch;
    R.fieldQuad = BattleTransition._fieldQuad;
  }
  G.translate(gx, gy);
  let ok = true, err: unknown;
  try { render(R, G); } catch (e) { ok = false; err = e; }
  G.pop();
  if (!ok) console.log("[game3/battle_transition] " + tostring(err instanceof Error ? err.message : err));
  BattleTransition._worldDrawn = true;
  return true;
};

// Lua: battle_transition.lua:2031
BattleTransition.draw = function (): void {
  if (!BattleTransition._active) return;
  if (BattleTransition._worldDrawn) {
    BattleTransition._worldDrawn = false;
    return;
  }
  const G = LG;
  G.push("all");
  const R = viewFor(0, 0, DW, DH);
  const fx = BattleTransition._fx;
  const target = G.getCanvas();
  if (BattleTransition._opts && truthy(BattleTransition._opts.overUi) && fx && fx.def.redraw && target) {
    const w = target.getWidth(), h = target.getHeight();
    let scratch = BattleTransition._uiScratch;
    if (!scratch || scratch.getWidth() !== w || scratch.getHeight() !== h) {
      if (scratch && scratch.release) { try { scratch.release(); } catch { /* pcall */ } }
      scratch = G.newCanvas(w, h, { dpiscale: 1 });
      scratch.setFilter("nearest", "nearest");
      try { scratch.setWrap("repeat", "repeat"); } catch { /* pcall */ }
      BattleTransition._uiScratch = scratch;
      BattleTransition._uiQuad = G.newQuad(0, 0, 1, 1, w, h);
    }
    G.origin();
    G.setCanvas(scratch);
    G.clear(0, 0, 0, 1);
    G.setColor(1, 1, 1, 1);
    G.draw(target, 0, 0);
    G.setCanvas(target);
    G.clear(0, 0, 0, 1);
    R.field = scratch;
    R.fieldQuad = BattleTransition._uiQuad;
  }
  let ok = true, err: unknown;
  try { render(R, G); } catch (e) { ok = false; err = e; }
  G.pop();
  if (!ok) console.log("[game3/battle_transition] " + tostring(err instanceof Error ? err.message : err));
};

export default BattleTransition;
