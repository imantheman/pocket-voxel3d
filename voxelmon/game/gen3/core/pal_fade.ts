// Port of gen1recomp src/core/game3/pal_fade.lua (GPLv3 + additional terms; see LICENSE.md).
// The 32 GBA palette slots (16 BG, 16 OBJ) as fade state: pret's
// BeginNormalPaletteFade / BlendPalettes / BlendPalettesGradually, turned
// into a per-slot gba_fx spec (Pal:fx) that layers and sprites draw with.

import { Fx, type GbaFxSpec } from "./gba_fx.ts";
import { insert, ipairs, len, pairs, seq, type LuaTable } from "../platform/lt.ts";

interface Slot { y: number; color: LuaTable; gray: boolean; base: LuaTable | null }

interface FadeState {
  active: boolean; mask: number; delay: number; counter: number;
  y: number; target: number; color: LuaTable; deltaY: number;
  yDec: boolean; toggle: number; finishing: boolean; finishCount: number;
}

interface Gradual {
  mask: number; coeff: number; target: number; color: LuaTable; timer: number;
  delay: number; delta: number; done?: boolean;
}

// Lua: pal_fade.lua:9
function bit(mask: number, i: number): boolean {
  // masks reach 2^32 - 1: float maths, as the Lua
  return Math.floor(mask / 2 ** i) % 2 === 1;
}

// Lua: pal_fade.lua:38
function blendRange(self: Pal, mask: number, lo: number, hi: number, y: number, color: LuaTable): void {
  for (let i = lo; i <= hi; i++) {
    if (bit(mask, i)) {
      const s = self.slots[i]!;
      s.y = y;
      s.color = color;
    }
  }
}

export class Pal {
  static WHITE: LuaTable = seq(31, 31, 31);
  static BLACK: LuaTable = seq(0, 0, 0);

  static ALL = 2 ** 32 - 1;
  static BG = 2 ** 16 - 1;
  static OBJ = Pal.ALL - Pal.BG;

  /** slots[0..31] (Lua keys 0..31) */
  slots: Slot[] = [];
  fade: FadeState | null = null;
  gradual: LuaTable = seq<Gradual>();

  // Lua: pal_fade.lua:13
  static new(): Pal {
    const self = new Pal();
    self.reset();
    return self;
  }

  // Lua: pal_fade.lua:19
  reset(): void {
    for (let i = 0; i <= 31; i++) {
      this.slots[i] = { y: 0, color: Pal.BLACK, gray: false, base: null };
    }
    this.fade = null;
    this.gradual = seq<Gradual>();
  }

  // Lua: pal_fade.lua:27
  static mask(bg?: LuaTable | null, obj?: LuaTable | null): number {
    let m = 0;
    for (const [, i] of ipairs<number>(bg ?? seq())) m = m + 2 ** i;
    for (const [, i] of ipairs<number>(obj ?? seq())) m = m + 2 ** (16 + i);
    return m;
  }

  // pokefirered/src/palette.c:778
  // Lua: pal_fade.lua:49
  blend(mask: number, y: number, color: LuaTable): void {
    blendRange(this, mask, 0, 31, y, color);
  }

  // Lua: pal_fade.lua:53
  setGray(slot: number, on: unknown): void {
    this.slots[slot]!.gray = !!on;
  }

  // Lua: pal_fade.lua:57
  setBase(slot: number, color: LuaTable | null): void {
    this.slots[slot]!.base = color;
  }

  // Lua: pal_fade.lua:61
  restore(slot: number): void {
    const s = this.slots[slot]!;
    s.y = 0;
    s.gray = false;
    s.base = null;
  }

  // pokefirered/src/palette.c:157
  // Lua: pal_fade.lua:67
  beginFade(mask: number, delay: number, startY: number, targetY: number, color: LuaTable): boolean {
    if (this.fade != null && this.fade.active) return false;
    let deltaY = 2;
    if (delay < 0) {
      deltaY = deltaY - delay;
      delay = 0;
    }
    this.fade = {
      active: true, mask, delay, counter: delay,
      y: startY, target: targetY, color, deltaY,
      yDec: startY >= targetY, toggle: 0, finishing: false, finishCount: 0,
    };
    this.updateFade();
    return true;
  }

  // Lua: pal_fade.lua:83
  fadeActive(): boolean {
    return this.fade != null && this.fade.active;
  }

  // pokefirered/src/palette.c:414
  // Lua: pal_fade.lua:88
  updateFade(): boolean {
    const f = this.fade;
    if (!(f != null && f.active)) return false;
    if (f.finishing) {
      if (f.finishCount === 4) {
        f.active = false;
        f.finishing = false;
        f.finishCount = 0;
      } else {
        f.finishCount = f.finishCount + 1;
      }
      return f.active;
    }
    if (f.toggle === 0) {
      if (f.counter < f.delay) {
        f.counter = f.counter + 1;
        return true;
      }
      f.counter = 0;
    }
    if (f.toggle === 0) {
      blendRange(this, f.mask, 0, 15, f.y, f.color);
    } else {
      blendRange(this, f.mask, 16, 31, f.y, f.color);
    }
    f.toggle = 1 - f.toggle;
    if (f.toggle === 0) {
      if (f.y === f.target) {
        f.mask = 0;
        f.finishing = true;
      } else if (!f.yDec) {
        f.y = Math.min(f.target, f.y + f.deltaY);
      } else {
        f.y = Math.max(f.target, f.y - f.deltaY);
      }
    }
    return true;
  }

  // Lua: pal_fade.lua:127
  resetFade(): void {
    this.fade = null;
  }

  // pokefirered/src/palette.c:912
  // Lua: pal_fade.lua:132
  blendGradually(mask: number, delay: number, coeff: number, target: number, color: LuaTable): Gradual {
    const t: Gradual = { mask, coeff, target, color, timer: 0, delay: 0, delta: 1 };
    if (delay >= 0) {
      t.delay = delay;
      t.delta = 1;
    } else {
      t.delay = 0;
      t.delta = -delay + 1;
    }
    if (target < coeff) t.delta = -t.delta;
    this.gradual[len(this.gradual) + 1] = t;
    this._stepGradual(t);
    return t;
  }

  // pokefirered/src/palette.c:935
  // Lua: pal_fade.lua:146
  _stepGradual(t: Gradual): void {
    if (t.done) return;
    t.timer = t.timer + 1;
    if (t.timer > t.delay) {
      t.timer = 0;
      this.blend(t.mask, t.coeff, t.color);
      if (t.coeff === t.target) {
        t.done = true;
        return;
      }
      t.coeff = t.coeff + t.delta;
      if ((t.delta >= 0 && t.coeff >= t.target) || (t.delta < 0 && t.coeff <= t.target)) {
        t.coeff = t.target;
      }
    }
  }

  // Lua: pal_fade.lua:163
  runGradual(): void {
    const keep = seq<Gradual>();
    for (const [, t] of ipairs<Gradual>(this.gradual)) {
      this._stepGradual(t);
      if (!t.done) insert(keep, t);
    }
    this.gradual = keep;
  }

  // Lua: pal_fade.lua:172
  gradualActive(): boolean {
    for (const [, t] of ipairs<Gradual>(this.gradual)) {
      if (!t.done) return true;
    }
    return false;
  }

  // Lua: pal_fade.lua:179
  clearGradual(): void {
    this.gradual = seq<Gradual>();
  }

  // Lua: pal_fade.lua:183
  fx(slot: number, extra?: LuaTable | null): GbaFxSpec | null {
    const s = this.slots[slot]!;
    const y = s.y, color = s.color;
    const fx: GbaFxSpec = { y, color, gray: s.gray };
    if (s.base != null) {
      fx.base = s.base;
      fx.y = 16;
      fx.color = seq(s.base[1] + Math.floor((color[1] - s.base[1]) * y / 16),
        s.base[2] + Math.floor((color[2] - s.base[2]) * y / 16),
        s.base[3] + Math.floor((color[3] - s.base[3]) * y / 16));
    }
    if (extra != null) {
      for (const [k, v] of pairs(extra)) fx[k] = v;
    }
    if (!Fx.active(fx)) return null;
    return fx;
  }

  // Lua: pal_fade.lua:201
  static bgSlot(i: number): number { return i; }
  // Lua: pal_fade.lua:202
  static objSlot(i: number): number { return 16 + i; }
}

export default Pal;
