// Port of gen1recomp src/core/game3/battle/anim_port/g1_sprite.lua (GPLv3 + additional terms; see LICENSE.md).
// Group 1 sprites: pret sprite.c animation / affine-animation runners, the
// g1 particle draw (effect g1_remap) and battle_anim_mons.c sprite helpers.
//
// Port notes:
// - Brian's module-scope aliases (`local s16, u16 = P.s16, P.u16`) are not
//   taken at load (ES module order: no module-scope read of an import); the
//   functions call P.s16 / P.u16 directly.
// - S.inits (a weak-keyed table) is a WeakMap: `S.inits[f] = initFn` is
//   S.inits.set(f, initFn), a lookup is S.inits.get(f).
// - The shader is G.newShader("g1_remap"); Brian's send calls are unchanged
//   (vec3 uniforms are runtime sequences, [null, r, g, b]).
// - pcall(require, "src.core.game3.battle.ui"): ported (ok path).
// - A sprite's customDraw is `(s, vm)` (anim_vm calls s.customDraw(s, vm)).

/* eslint-disable @typescript-eslint/no-explicit-any */
import { tonumber, tostring } from "../../../../../import/gen3/lua.ts";
import { len, unpack } from "../../../platform/lt.ts";
import { find } from "../../../platform/lpattern.ts";
import { G, type Shader } from "../../../platform/graphics.ts";
import type { Quad } from "../../../platform/image.ts";
import { AnimSprites } from "../anim_sprites.ts";
import { AnimPal } from "../anim_pal.ts";
import { Ui } from "../ui.ts";
import { P } from "./g1_pret.ts";

const floor = Math.floor;

export const S: Record<string, any> = {};

// Lua: g1_sprite.lua:12
S.destroy = function (s: any): void {
  if (!s.active) return;
  AnimSprites.release(s);
};

S.DestroyAnimSprite = S.destroy;
S.DestroySpriteAndMatrix = S.destroy;

// Lua: g1_sprite.lua:20
S.setCb = function (s: any, fn: any): void {
  s._cb = fn;
};

// Lua: g1_sprite.lua:25 -- pokefirered/src/battle_anim_mons.c:377
S.store = function (s: any, fn: any): void {
  s._stored = fn;
};

// Lua: g1_sprite.lua:29
S.runStored = function (s: any): void {
  s._cb = s._stored ?? S.destroy;
};

// Lua: g1_sprite.lua:33
S.invisible = function (s: any): boolean {
  return s.visible === false;
};

// Lua: g1_sprite.lua:37
S.setInvisible = function (s: any, v: unknown): void {
  s.visible = !(v != null && v !== false);
};

const tb = (v: unknown): boolean => v != null && v !== false;

// Lua: g1_sprite.lua:41
function apply_flip(s: any, h: unknown, v: unknown): void {
  if (s.affineMode != null && s.affineMode !== 0) return;
  s._oamH = tb(h) !== tb(s._hFlip);
  s._oamV = tb(v) !== tb(s._vFlip);
}

// Lua: g1_sprite.lua:48 -- pokefirered/src/sprite.c:1236
S.setFlipBits = function (s: any, h: unknown, v: unknown): void {
  apply_flip(s, h, v);
};

// Lua: g1_sprite.lua:52
S.setOamFlip = function (s: any, h: unknown, v: unknown): void {
  s._oamH = tb(h);
  s._oamV = tb(v);
};

// Lua: g1_sprite.lua:57
function anim_frame(s: any, c: any): void {
  let d = c.d ?? 0;
  if (d > 0) d = d - 1;
  s.animDelayCounter = d;
  apply_flip(s, c.h, c.v);
  s._tile = (s._sheetTileStart ?? 0) + (c.f ?? 0);
}

// Lua: g1_sprite.lua:67
function anim_cmd(s: any, seq: any, c: any): void {
  if (c.e) {
    s.animCmdIndex = s.animCmdIndex - 1;
    s.animEnded = true;
  } else if (c.jump != null) {
    s.animCmdIndex = c.jump;
    const f = seq[s.animCmdIndex + 1];
    if (f) anim_frame(s, f);
  } else if (c.loop != null) {
    if ((s.animLoopCounter ?? 0) !== 0) {
      s.animLoopCounter = s.animLoopCounter - 1;
    } else {
      s.animLoopCounter = c.loop;
    }
    if (s.animLoopCounter !== 0) {
      s.animCmdIndex = s.animCmdIndex - 1;
      while (true) {
        const prev = seq[s.animCmdIndex];
        if (prev && prev.loop != null) break;
        if (s.animCmdIndex === 0) break;
        s.animCmdIndex = s.animCmdIndex - 1;
      }
      s.animCmdIndex = s.animCmdIndex - 1;
    }
    continue_anim(s);
  } else {
    anim_frame(s, c);
  }
}

// Lua: g1_sprite.lua:98 -- pokefirered/src/sprite.c:939
function continue_anim(s: any): void {
  const seq = s._anims ? s._anims[s.animNum ?? 0] : null;
  if (!seq) return;
  if ((s.animDelayCounter ?? 0) > 0) {
    if (!s.animPaused) s.animDelayCounter = s.animDelayCounter - 1;
    const c = seq[(s.animCmdIndex ?? 0) + 1];
    if (c && c.f != null) apply_flip(s, c.h, c.v);
  } else if (!s.animPaused) {
    s.animCmdIndex = (s.animCmdIndex ?? 0) + 1;
    const c = seq[s.animCmdIndex + 1];
    if (!c) {
      s.animCmdIndex = s.animCmdIndex - 1;
      s.animEnded = true;
      return;
    }
    anim_cmd(s, seq, c);
  }
}

// Lua: g1_sprite.lua:118 -- pokefirered/src/sprite.c:905
function begin_anim(s: any): void {
  const seq = s._anims ? s._anims[s.animNum ?? 0] : null;
  s.animCmdIndex = 0;
  s.animEnded = false;
  s.animLoopCounter = 0;
  if (!seq) return;
  const c = seq[1];
  if (c && c.f != null) {
    s.animBeginning = false;
    anim_frame(s, c);
  }
}

// Lua: g1_sprite.lua:132 -- pokefirered/src/sprite.c:1336
S.startAnim = function (s: any, num: number): void {
  s.animNum = num;
  s.animBeginning = true;
  s.animEnded = false;
};

// Lua: g1_sprite.lua:139 -- pokefirered/src/sprite.c:1343
S.startAnimIfDifferent = function (s: any, num: number): void {
  if (s.animNum !== num) S.startAnim(s, num);
};

// Lua: g1_sprite.lua:144 -- pokefirered/src/sprite.c:1349
S.seekAnim = function (s: any, idx: number): void {
  const paused = s.animPaused;
  s.animCmdIndex = idx - 1;
  s.animDelayCounter = 0;
  s.animBeginning = false;
  s.animEnded = false;
  s.animPaused = false;
  continue_anim(s);
  if ((s.animDelayCounter ?? 0) !== 0) s.animDelayCounter = s.animDelayCounter + 1;
  s.animPaused = paused;
};

// Lua: g1_sprite.lua:156
S.convertScale = function (scale: number): number {
  if (scale === 0) return 0;
  return P.s16(P.cdiv(0x10000, scale));
};

// Lua: g1_sprite.lua:161
S.setMatrix = function (s: any, xs: number, ys: number, rot: number): void {
  s._matX = xs;
  s._matY = ys;
  s._matRot = P.u16(rot);
};

// Lua: g1_sprite.lua:165
function aff_update(s: any): void {
  const a = s._aff;
  S.setMatrix(s, S.convertScale(a.xScale), S.convertScale(a.yScale), a.rotation);
}

// Lua: g1_sprite.lua:171 -- pokefirered/src/sprite.c:1292
function aff_rel(s: any, c: any): void {
  const a = s._aff;
  a.xScale = P.s16(a.xScale + (c.xs ?? 0));
  a.yScale = P.s16(a.yScale + (c.ys ?? 0));
  a.rotation = (a.rotation + ((c.r ?? 0) << 8)) & 0xFF00;
  aff_update(s);
}

// Lua: g1_sprite.lua:180 -- pokefirered/src/sprite.c:1320
function aff_frame(s: any, c: any): void {
  const a = s._aff;
  const d = c.d ?? 0;
  if (d !== 0) {
    aff_rel(s, c);
    a.delay = d - 1;
  } else {
    a.xScale = c.xs ?? 0;
    a.yScale = c.ys ?? 0;
    a.rotation = ((c.r ?? 0) << 8) & 0xFFFF;
    aff_rel(s, {});
    a.delay = 0;
  }
}

// Lua: g1_sprite.lua:197
function aff_cmd(s: any, seq: any, c: any): void {
  const a = s._aff;
  if (c.e) {
    s.affineAnimEnded = true;
    a.idx = a.idx - 1;
    aff_rel(s, {});
  } else if (c.jump != null) {
    a.idx = c.jump;
    const f = seq[a.idx + 1];
    if (f) aff_frame(s, f);
  } else if (c.loop != null) {
    if ((a.loop ?? 0) !== 0) a.loop = a.loop - 1; else a.loop = c.loop;
    if (a.loop !== 0) {
      a.idx = a.idx - 1;
      while (true) {
        const prev = seq[a.idx];
        if (prev && prev.loop != null) break;
        if (a.idx === 0) break;
        a.idx = a.idx - 1;
      }
      a.idx = a.idx - 1;
    }
    continue_affine(s);
  } else {
    aff_frame(s, c);
  }
}

// Lua: g1_sprite.lua:226 -- pokefirered/src/sprite.c:1080
function continue_affine(s: any): void {
  const a = s._aff;
  const seq = s._affAnims ? s._affAnims[a.animNum ?? 0] : null;
  if (!seq) return;
  if ((a.delay ?? 0) > 0) {
    if (!s.affineAnimPaused) {
      a.delay = a.delay - 1;
      const c = seq[a.idx + 1];
      if (c) aff_rel(s, c);
    }
  } else if (s.affineAnimPaused) {
    return;
  } else {
    a.idx = a.idx + 1;
    const c = seq[a.idx + 1];
    if (!c) {
      a.idx = a.idx - 1;
      s.affineAnimEnded = true;
      return;
    }
    aff_cmd(s, seq, c);
  }
}

// Lua: g1_sprite.lua:250
function aff_state(s: any): any {
  if (!s._aff) {
    s._aff = { animNum: 0, idx: 0, delay: 0, loop: 0, xScale: 0x100, yScale: 0x100, rotation: 0 };
  }
  return s._aff;
}

// Lua: g1_sprite.lua:258 -- pokefirered/src/sprite.c:1063
function begin_affine(s: any): void {
  const a = aff_state(s);
  const seq = s._affAnims ? s._affAnims[a.animNum ?? 0] : null;
  if (!seq || !seq[1] || seq[1].e) return;
  a.idx = 0;
  a.delay = 0;
  a.loop = 0;
  s.affineAnimBeginning = false;
  s.affineAnimEnded = false;
  aff_frame(s, seq[1]);
}

// Lua: g1_sprite.lua:271 -- pokefirered/src/sprite.c:1363
S.startAffineAnim = function (s: any, num: number): void {
  const a = aff_state(s);
  a.animNum = num;
  a.idx = 0;
  a.delay = 0;
  a.loop = 0;
  a.xScale = 0x100;
  a.yScale = 0x100;
  a.rotation = 0;
  s.affineAnimBeginning = true;
  s.affineAnimEnded = false;
};

// Lua: g1_sprite.lua:285 -- pokefirered/src/sprite.c:1378
S.changeAffineAnim = function (s: any, num: number): void {
  const a = aff_state(s);
  a.animNum = num;
  s.affineAnimBeginning = true;
  s.affineAnimEnded = false;
};

// Lua: g1_sprite.lua:293 -- pokefirered/src/sprite.c:897
S.animate = function (s: any): void {
  if (s.animBeginning) begin_anim(s); else continue_anim(s);
  if (s.affineMode != null && s.affineMode !== false && (s.affineMode & 1) !== 0) {
    aff_state(s);
    if (s.affineAnimBeginning) begin_affine(s); else continue_affine(s);
  }
};

// Lua: g1_sprite.lua:302 -- pokefirered/src/battle_anim_mons.c:1244
S.trySetRotScale = function (s: any, _recalc: unknown, xs: number, ys: number, rot: number): void {
  if (s.affineMode != null && s.affineMode !== false && (s.affineMode & 1) !== 0) {
    s.affineAnimPaused = true;
    S.setMatrix(s, xs, ys, rot);
  }
};

// Lua: g1_sprite.lua:309
S.tryResetAffine = function (s: any): void {
  S.trySetRotScale(s, true, 0x100, 0x100, 0);
  s.affineAnimPaused = false;
};

let shader: Shader | null = null;
let shaderFailed = false;
const SHADER_EFFECT = "g1_remap"; // Lua: g1_sprite.lua:316 (SHADER_SRC)

// Lua: g1_sprite.lua:336
function get_shader(): Shader | null {
  if (shader || shaderFailed) return shader;
  // (`love.graphics.newShader` always exists here.)
  try {
    shader = G.newShader(SHADER_EFFECT);
  } catch (sh) {
    shaderFailed = true;
    console.log("[g1] shader: " + tostring(sh));
  }
  return shader;
}

let quad: Quad | null = null;
const zeroVec: any[] = [null, 0, 0, 0];
const srcBuf: any[] = [null];
const dstBuf: any[] = [null];

// Lua: g1_sprite.lua:347 -- returns [st, remap]
function palette_state(s: any): [any, any] {
  const key = "tag:" + tostring(s._palTag ?? s.tag);
  let st = P.Pal.faded[key] ?? P.Pal.unfaded[key];
  const remap = P.Pal.remap[s._palTag ?? s.tag];
  if (s.palBlend && !st) {
    const k = (tonumber(s.palBlend.coeff) ?? 0) / 16;
    const [r, g, b] = P.rgb555(s.palBlend.color);
    st = { m: 1 - k, r: r * k, g: g * k, b: b * k };
  }
  return [st, remap];
}

// Lua: g1_sprite.lua:360 -- pokefirered/src/sprite.c:474
S.draw = function (s: any, vm: any): void {
  let img = s.image;
  if (!img || s.visible === false) return;
  const w = s._w ?? 16, h = s._h ?? 16;
  const sheetW = img.getWidth();
  const sheetH = img.getHeight();
  const tw = floor(w / 8);
  const sw = Math.max(1, floor(sheetW / 8));
  const tile = s._tile ?? 0;
  const x = floor(s.x + (s.ox ?? 0));
  const y = floor(s.y + (s.oy ?? 0));
  let sx = 1, sy = 1, rot = 0;
  let fx = 1, fy = 1;
  if (s.affineMode != null && s.affineMode !== false && (s.affineMode & 1) !== 0) {
    const mx = s._matX ?? 0x100, my = s._matY ?? 0x100;
    sx = mx !== 0 ? (256 / mx) : 0;
    sy = my !== 0 ? (256 / my) : 0;
    rot = -((s._matRot ?? 0) / 65536) * 2 * Math.PI;
  } else {
    if (s._oamH) fx = -1;
    if (s._oamV) fy = -1;
  }
  let alpha = s._drawAlpha;
  if (alpha == null) {
    alpha = s.alpha ?? 1;
    const bld = vm ? vm.bldAlpha : null;
    if (s.objBlend && bld) {
      alpha = alpha * Math.max(0, Math.min(16, tonumber(bld.eva ?? bld[1]) ?? 16)) / 16;
    }
  }
  if (s._alphaOverride != null && s._alphaOverride !== false) alpha = s._alphaOverride;
  const [st, remap] = palette_state(s);
  let sh: Shader | null = null;
  const pimg = AnimPal.begin(s, img, st ? { affine: st } : null);
  if (pimg) {
    img = pimg;
  } else if (st || remap) {
    sh = get_shader();
    if (sh) {
      const m = st ? st.m : 1;
      sh.send("blendM", m);
      sh.send("blendColor", st ? [null, st.r, st.g, st.b] : zeroVec);
      const n = remap ? Math.min(16, len(remap.src)) : 0;
      sh.send("nRemap", n);
      if (n > 0) {
        for (let i = 1; i <= 16; i++) {
          srcBuf[i] = remap.src[i] ?? zeroVec;
          dstBuf[i] = remap.dst[i] ?? zeroVec;
        }
        sh.send("remapSrc", ...unpack(srcBuf));
        sh.send("remapDst", ...unpack(dstBuf));
      }
      G.setShader(sh);
    }
  }
  G.setColor(1, 1, 1, alpha);
  G.push();
  G.translate(x, y);
  if (rot !== 0) G.rotate(rot);
  G.scale(sx * fx, sy * fy);
  if (!quad) quad = G.newQuad(0, 0, 8, 8, sheetW, sheetH);
  const q = quad!;
  for (let r = 0; r <= floor(h / 8) - 1; r++) {
    const t0 = tile + r * tw;
    let c = 0;
    while (c < tw) {
      const tt = t0 + c;
      const col = tt % sw;
      const row = floor(tt / sw);
      const n = Math.min(tw - c, sw - col);
      if (row * 8 < sheetH) {
        q.setViewport(col * 8, row * 8, n * 8, 8, sheetW, sheetH);
        G.draw(img, q, -w / 2 + c * 8, -h / 2 + r * 8);
      }
      c = c + n;
    }
  }
  G.pop();
  if (sh || pimg) G.setShader();
  G.setColor(1, 1, 1, 1);
};

// Lua: g1_sprite.lua:441
function runner(s: any): void {
  const cb = s._cb;
  if (cb) cb(s);
  if (!s.active || !s._g1) return;
  S.animate(s);
  s.oamPriority = s._pri ?? 2;
  s._pz = true;
  P.updateZ(s);
}

// Lua: g1_sprite.lua:452 -- pokefirered/src/sprite.c:494
S.applyTemplate = function (s: any, tplName: any, vm: any): void {
  const T = P.templates();
  const tpl = tplName != null ? T[tplName] : null;
  const info = (tpl && tpl.tag != null) ? P.tagInfo(vm, tpl.tag) : null;
  const opTag = s._op ? s._op.tag : null;
  const packTag = (typeof (tpl ? tpl.tag : null) === "string" && !info && opTag != null && P.tagInfo(vm, opTag)) ? true : false;
  if (packTag) s.tag = opTag;
  if (tpl && tpl.tag != null && !packTag) {
    s.tag = tpl.tag;
    s.image = (info && info.image) ? info.image : s.image;
  }
  s._tpl = tpl;
  s._w = (tpl ? tpl.w : null) ?? s._baseW ?? 16;
  s._h = (tpl ? tpl.h : null) ?? s._baseH ?? 16;
  s._anims = tpl ? tpl.anims : null;
  s._affAnims = tpl ? tpl.affine : null;
  s.affineMode = (tpl ? tpl.affineMode : null) ?? 0;
  s.objBlend = (tpl && tpl.objBlend) || false;
  s._pri = (tpl ? tpl.priority : null) ?? 2;
  s._palTag = (!packTag && tpl && tpl.pal != null) ? tpl.pal : s.tag;
  s._tile = 0;
  s._sheetTileStart = 0;
  s.animNum = 0;
  s.animCmdIndex = 0;
  s.animDelayCounter = 0;
  s.animLoopCounter = 0;
  s.animEnded = false;
  s.animPaused = false;
  s.animBeginning = true;
  s._aff = null;
  s.affineAnimPaused = false;
  s.affineAnimEnded = false;
  s.affineAnimBeginning = true;
  s._hFlip = false;
  s._vFlip = false;
  s._oamH = false;
  s._oamV = false;
  s.hFlip = false;
  s.vFlip = false;
  s.rotation = 0;
  s.scaleX = 1;
  s.scaleY = 1;
  s._matX = 0x100;
  s._matY = 0x100;
  s._matRot = 0;
  s.customDraw = S.draw;
  s._g1 = true;
  if (s.affineMode !== 0 && s._affAnims) aff_state(s);
};

// Lua: g1_sprite.lua:500
function init_from_vm(s: any, initFn: (s: any) => void): void {
  P.hookVmReset();
  const vm = s._vm ?? P.vm();
  s._vm = vm;
  const op = s._op;
  const args = (op && op.args) ?? s._args ?? [null];
  const A: number[] = [];
  for (let i = 0; i <= 7; i++) {
    let v = args[i + 1];
    if (v == null && vm && vm.args) v = vm.args[i];
    if (typeof v === "string") {
      const l = v.toLowerCase();
      if (find(l, "target") != null) v = 1; else if (find(l, "attacker") != null) v = 0; else v = tonumber(v) ?? 0;
    }
    A[i] = P.s16(tonumber(v) ?? 0);
  }
  s._A = A;
  for (let i = 0; i <= 7; i++) s.data[i] = 0;
  const tgt = P.tgt(vm);
  s.x = P.coord(vm, tgt, P.X_2);
  s.y = P.coord(vm, tgt, P.Y_PIC_OFFSET);
  s.ox = 0;
  s.oy = 0;
  s.visible = true;
  s.alpha = 1;
  S.applyTemplate(s, s.template ?? (op ? op.template : null), vm);
  if (op) {
    s.subpriority = (() => {
      const raw = tonumber(op.subpriority) ?? 0;
      const side = (op.animBattler === "target") ? P.tgt(vm) : P.atk(vm);
      let sub: number;
      if (raw >= 64) sub = P.subpriorityOf(side) + (raw - 64); else sub = P.subpriorityOf(side) - raw;
      if (sub < 3) sub = 3;
      return sub;
    })();
  } else {
    const side = s._anchorSide ?? tgt;
    s.subpriority = P.subpriorityOf(side) - (tonumber(s.subpriority) ?? 2);
  }
  s.callback = runner;
  s._cb = initFn;
  runner(s);
}

// Lua: g1_sprite.lua:543 (a weak-keyed table)
S.inits = new WeakMap<(s: any) => void, (s: any) => void>();

// Lua: g1_sprite.lua:545
S.wrap = function (initFn: (s: any) => void): (s: any) => void {
  const f = function (s: any): void {
    if (s._g1) return runner(s);
    return init_from_vm(s, initFn);
  };
  S.inits.set(f, initFn);
  return f;
};

// Lua: g1_sprite.lua:555 -- pokefirered/src/sprite.c:494
S.create = function (vm: any, tplName: string, x: number, y: number, subpriority: number | null | undefined,
  cb?: ((s: any) => void) | null): any {
  const T = P.templates();
  const tpl = T[tplName];
  const info = (tpl && tpl.tag != null) ? P.tagInfo(vm, tpl.tag) : null;
  const s = AnimSprites.acquire({
    x, y, image: info ? info.image : null, tag: tpl ? tpl.tag : null,
    w: (tpl ? tpl.w : null) ?? 16, h: (tpl ? tpl.h : null) ?? 16,
  });
  if (!s) return null;
  s._vm = vm;
  s.template = tplName;
  s.ox = 0;
  s.oy = 0;
  S.applyTemplate(s, tplName, vm);
  s.subpriority = subpriority ?? 0;
  s._A = [];
  for (let i = 0; i <= 7; i++) s._A[i] = P.s16((vm && vm.args ? vm.args[i] : null) ?? 0);
  s._cb = cb ?? function () { /* empty */ };
  s.callback = runner;
  s.oamPriority = s._pri ?? 2;
  s._pz = true;
  P.updateZ(s);
  return s;
};

// Lua: g1_sprite.lua:577 -- pokefirered/src/sprite.c:1336
S.createAndAnimate = function (vm: any, tplName: string, x: number, y: number, subpriority: number | null | undefined,
  cb: ((s: any) => void) | null | undefined, args?: Record<number, number> | null): any {
  const s = S.create(vm, tplName, x, y, subpriority, cb);
  if (!s) return null;
  if (args) for (let i = 0; i <= 7; i++) s._A[i] = P.s16(args[i] ?? 0);
  runner(s);
  return s;
};

S.runner = runner;

// Lua: g1_sprite.lua:588 -- pokefirered/src/battle_anim_mons.c:727
S.setToAttackerCoords = function (s: any): void {
  const vm = s._vm;
  s.x = P.coord(vm, P.atk(vm), P.X_2);
  s.y = P.coord(vm, P.atk(vm), P.Y_PIC_OFFSET);
};

// Lua: g1_sprite.lua:595 -- pokefirered/src/battle_anim_mons.c:735
S.setInitialXOffset = function (s: any, xOffset: number): void {
  const vm = s._vm;
  const ax = P.coord(vm, P.atk(vm), P.X);
  const tx = P.coord(vm, P.tgt(vm), P.X);
  if (ax > tx) {
    s.x = s.x - xOffset;
  } else if (ax < tx) {
    s.x = s.x + xOffset;
  } else if (P.atk(vm) !== "player") {
    s.x = s.x - xOffset;
  } else {
    s.x = s.x + xOffset;
  }
};

// Lua: g1_sprite.lua:611 -- pokefirered/src/battle_anim_mons.c:792
S.initPosToTarget = function (s: any, respect: unknown): void {
  const vm = s._vm;
  if (!tb(respect)) {
    s.x = P.coord(vm, P.tgt(vm), P.X);
    s.y = P.coord(vm, P.tgt(vm), P.Y);
  }
  S.setInitialXOffset(s, s._A[0]);
  s.y = s.y + s._A[1];
};

// Lua: g1_sprite.lua:622 -- pokefirered/src/battle_anim_mons.c:805
S.initPosToAttacker = function (s: any, respect: unknown): void {
  const vm = s._vm;
  const side = P.atk(vm);
  if (!tb(respect)) {
    s.x = P.coord(vm, side, P.X);
    s.y = P.coord(vm, side, P.Y);
  } else {
    s.x = P.coord(vm, side, P.X_2);
    s.y = P.coord(vm, side, P.Y_PIC_OFFSET);
  }
  S.setInitialXOffset(s, s._A[0]);
  s.y = s.y + s._A[1];
};

// Lua: g1_sprite.lua:637 -- pokefirered/src/battle_anim_mons.c:521
S.waitAnimForDuration = function (s: any): void {
  if (s.data[0] > 0) {
    s.data[0] = s.data[0] - 1;
  } else {
    S.runStored(s);
  }
};

// Lua: g1_sprite.lua:646 -- pokefirered/src/battle_anim_mons.c:548
S.convertPosDataToTranslateLinear = function (s: any): void {
  const d = s.data;
  if (d[1] > d[2]) d[0] = -d[0];
  const xDiff = d[2] - d[1];
  const old = d[0];
  d[0] = P.s16(Math.abs(P.cdiv(xDiff, d[0])));
  d[2] = P.s16(P.cdiv(d[4] - d[3], d[0]));
  d[1] = old;
};

// Lua: g1_sprite.lua:657 -- pokefirered/src/battle_anim_mons.c:562
S.translateSpriteLinear = function (s: any): void {
  const d = s.data;
  if (d[0] > 0) {
    d[0] = d[0] - 1;
    s.ox = s.ox + d[1];
    s.oy = s.oy + d[2];
  } else {
    S.runStored(s);
  }
};

// Lua: g1_sprite.lua:669 -- pokefirered/src/battle_anim_mons.c:576
S.translateSpriteLinearFixedPoint = function (s: any): void {
  const d = s.data;
  if (d[0] > 0) {
    d[0] = d[0] - 1;
    d[3] = P.s16(d[3] + d[1]);
    d[4] = P.s16(d[4] + d[2]);
    s.ox = d[3] >> 8;
    s.oy = d[4] >> 8;
  } else {
    S.runStored(s);
  }
};

// Lua: g1_sprite.lua:683 -- pokefirered/src/battle_anim_mons.c:651
S.translateSpriteLinearAndFlicker = function (s: any): void {
  const d = s.data;
  if (d[0] > 0) {
    d[0] = d[0] - 1;
    s.ox = d[2] >> 8;
    d[2] = P.s16(d[2] + d[1]);
    s.oy = d[4] >> 8;
    d[4] = P.s16(d[4] + d[3]);
    if (d[5] !== 0 && P.cmod(d[0], d[5]) === 0) s.visible = !s.visible;
  } else {
    S.runStored(s);
  }
};

// Lua: g1_sprite.lua:698 -- pokefirered/src/battle_anim_mons.c:433
S.translateInGrowingCircle = function (s: any): void {
  const d = s.data;
  if (d[3] !== 0) {
    const amp = (d[5] >> 8) + d[1];
    s.ox = P.Sin(d[0], amp);
    s.oy = P.Cos(d[0], amp);
    d[0] = d[0] + d[2];
    d[5] = P.s16(d[5] + d[4]);
    if (d[0] >= 0x100) d[0] = d[0] - 0x100; else if (d[0] < 0) d[0] = d[0] + 0x100;
    d[3] = d[3] - 1;
  } else {
    S.runStored(s);
  }
};

// Lua: g1_sprite.lua:714 -- pokefirered/src/battle_anim_mons.c:988
S.initLinear = function (s: any): void {
  const d = s.data;
  const x = d[2] - d[1];
  const y = d[4] - d[3];
  const speed = d[0];
  let xd = (Math.abs(x) << 8) & 0xFFFF;
  let yd = (Math.abs(y) << 8) & 0xFFFF;
  if (speed !== 0) {
    xd = P.cdiv(xd, speed) & 0xFFFF;
    yd = P.cdiv(yd, speed) & 0xFFFF;
  }
  if (x < 0) xd = xd | 1; else xd = xd & 0xFFFE;
  if (y < 0) yd = yd | 1; else yd = yd & 0xFFFE;
  d[1] = P.s16(xd);
  d[2] = P.s16(yd);
  d[4] = 0;
  d[3] = 0;
};

// Lua: g1_sprite.lua:734 -- pokefirered/src/battle_anim_mons.c:1034
S.translateLinear = function (s: any): boolean {
  const d = s.data;
  if (d[0] === 0) return true;
  const v1 = P.u16(d[1]);
  const v2 = P.u16(d[2]);
  const x = P.u16(P.u16(d[3]) + v1);
  const y = P.u16(P.u16(d[4]) + v2);
  if ((v1 & 1) !== 0) s.ox = -(x >>> 8); else s.ox = x >>> 8;
  if ((v2 & 1) !== 0) s.oy = -(y >>> 8); else s.oy = y >>> 8;
  d[3] = P.s16(x);
  d[4] = P.s16(y);
  d[0] = P.s16(d[0] - 1);
  return false;
};

// Lua: g1_sprite.lua:749
S.translateLinearFollowup = function (s: any): void {
  if (S.translateLinear(s)) S.runStored(s);
};

// Lua: g1_sprite.lua:754 -- pokefirered/src/battle_anim_mons.c:1016
S.startLinear = function (s: any): void {
  s.data[1] = s.x;
  s.data[3] = s.y;
  S.initLinear(s);
  s._cb = S.translateLinearFollowup;
  s._cb(s);
};

// Lua: g1_sprite.lua:763 -- pokefirered/src/battle_anim_mons.c:757
S.initArc = function (s: any): void {
  s.data[1] = s.x;
  s.data[3] = s.y;
  S.initLinear(s);
  const speed = s.data[0];
  s.data[6] = speed !== 0 ? P.s16(P.cdiv(0x8000, speed)) : 0;
  s.data[7] = 0;
};

// Lua: g1_sprite.lua:773 -- pokefirered/src/battle_anim_mons.c:766
S.translateHArc = function (s: any): boolean {
  if (S.translateLinear(s)) return true;
  s.data[7] = P.s16(s.data[7] + s.data[6]);
  s.oy = s.oy + P.Sin((P.u16(s.data[7]) >>> 8) & 0xFF, s.data[5]);
  return false;
};

// Lua: g1_sprite.lua:781 -- pokefirered/src/battle_anim_mons.c:1091
S.initFastLinear = function (s: any): void {
  const d = s.data;
  const x = d[2] - d[1];
  const y = d[4] - d[3];
  let x2 = (Math.abs(x) << 4) & 0xFFFF;
  let y2 = (Math.abs(y) << 4) & 0xFFFF;
  if (d[0] !== 0) {
    x2 = P.cdiv(x2, d[0]) & 0xFFFF;
    y2 = P.cdiv(y2, d[0]) & 0xFFFF;
  }
  if (x < 0) x2 = x2 | 1; else x2 = x2 & 0xFFFE;
  if (y < 0) y2 = y2 | 1; else y2 = y2 & 0xFFFE;
  d[1] = P.s16(x2);
  d[2] = P.s16(y2);
  d[4] = 0;
  d[3] = 0;
};

// Lua: g1_sprite.lua:800 -- pokefirered/src/battle_anim_mons.c:1125
S.fastTranslateLinear = function (s: any): boolean {
  const d = s.data;
  if (d[0] === 0) return true;
  const v1 = P.u16(d[1]);
  const v2 = P.u16(d[2]);
  const x = P.u16(P.u16(d[3]) + v1);
  const y = P.u16(P.u16(d[4]) + v2);
  if ((v1 & 1) !== 0) s.ox = -(x >>> 4); else s.ox = x >>> 4;
  if ((v2 & 1) !== 0) s.oy = -(y >>> 4); else s.oy = y >>> 4;
  d[3] = P.s16(x);
  d[4] = P.s16(y);
  d[0] = P.s16(d[0] - 1);
  return false;
};

// Lua: g1_sprite.lua:815
function fast_wait_end(s: any): void {
  if (S.fastTranslateLinear(s)) S.runStored(s);
}

// Lua: g1_sprite.lua:820 -- pokefirered/src/battle_anim_mons.c:1116
S.initAndRunFastLinear = function (s: any): void {
  s.data[1] = s.x;
  s.data[3] = s.y;
  S.initFastLinear(s);
  s._cb = fast_wait_end;
  s._cb(s);
};

// Lua: g1_sprite.lua:829 -- pokefirered/src/battle_anim_mons.c:1157
S.initFastLinearWithSpeed = function (s: any): void {
  const d = s.data;
  const xDiff = Math.abs(d[2] - d[1]) << 4;
  d[0] = P.s16(P.cdiv(xDiff, d[0]));
  S.initFastLinear(s);
};

// Lua: g1_sprite.lua:837 -- pokefirered/src/battle_anim_mons.c:701
S.runStoredWhenAffineEnds = function (s: any): void {
  if (s.affineAnimEnded) S.runStored(s);
};

// Lua: g1_sprite.lua:842 -- pokefirered/src/battle_anim_mons.c:707
S.runStoredWhenAnimEnds = function (s: any): void {
  if (s.animEnded) S.runStored(s);
};

// Lua: g1_sprite.lua:847 -- pokefirered/src/battle_anim_mons.c:672
S.destroyAfterTimer = function (s: any): void {
  if (s.data[0] > 0) {
    s.data[0] = s.data[0] - 1;
  } else {
    S.destroy(s);
  }
};

// Lua: g1_sprite.lua:856 -- pokefirered/src/battle_anim_mons.c:1174
S.setMonRotScale = function (side: any, xs: number, ys: number, rot: number): void {
  const p = P.present(side);
  if (!p) return;
  p.sx = xs !== 0 ? (256 / xs) : 0;
  p.sy = ys !== 0 ? (256 / ys) : 0;
  p.rotation = -(P.u16(rot) / 65536) * 2 * Math.PI;
  p._g1Rot = P.u16(rot);
  p._g1Ys = ys;
};

// Lua: g1_sprite.lua:867 -- pokefirered/src/battle_anim_mons.c:1222
S.resetMonRotScale = function (side: any): void {
  const p = P.present(side);
  if (!p) return;
  p.sx = 1;
  p.sy = 1;
  p.rotation = 0;
  p._g1Rot = 0;
  p._g1Ys = 0x100;
};

// Lua: g1_sprite.lua:875
function clone_draw(s: any, vm: any): void {
  if (s.visible === false) return;
  const side = s._cloneSide;
  const sp = P.species(vm, side);
  let entry: any = null;
  // pcall(require, "src.core.game3.battle.ui"): ported (ok path).
  const U: any = Ui;
  const okU = U != null;
  if (okU && U.battlerPic) entry = U.battlerPic(side, null, sp)[0];
  if (!(entry && entry.image)) return;
  let cx = s.x, cy = s.y;
  if (okU && U.battlerSpriteCenter) {
    [cx, cy] = U.battlerSpriteCenter(side, sp, P.COORDS[side]);
  }
  let alpha = s._drawAlpha;
  if (alpha == null) {
    alpha = s.alpha ?? 1;
    const bld = vm ? vm.bldAlpha : null;
    if (bld) alpha = alpha * Math.max(0, Math.min(16, tonumber(bld.eva ?? bld[1]) ?? 16)) / 16;
  }
  const st = s._cloneBlend;
  const sh = st ? get_shader() : null;
  if (sh) {
    sh.send("blendM", st.m);
    sh.send("blendColor", [null, st.r, st.g, st.b]);
    sh.send("nRemap", 0);
    G.setShader(sh);
  }
  G.setColor(1, 1, 1, alpha);
  const fx = s._cloneHFlip ? -1 : 1;
  G.draw(entry.image, cx + (s.ox ?? 0), cy + (s.oy ?? 0), s._cloneRot ?? 0,
    (s._cloneSx ?? 1) * fx, s._cloneSy ?? 1, 32, 32);
  if (sh) G.setShader();
  G.setColor(1, 1, 1, 1);
}

// Lua: g1_sprite.lua:910 -- pokefirered/src/battle_anim_mons.c:1517
S.cloneMon = function (vm: any, side: any, blendState: any): any {
  const p = P.present(side);
  if (!p) return null;
  const s = AnimSprites.acquire({ x: P.coord(vm, side, P.X_2), y: P.coord(vm, side, P.Y_PIC_OFFSET_DEFAULT), w: 64, h: 64 });
  if (!s) return null;
  s._vm = vm;
  s._g1 = true;
  s._g1Clone = true;
  s._cloneSide = side;
  s._cloneSx = p.sx ?? 1;
  s._cloneSy = p.sy ?? 1;
  s._cloneRot = p.rotation ?? 0;
  s._cloneHFlip = p.hFlip;
  s._cloneBlend = blendState;
  s.ox = p.ox ?? 0;
  s.oy = p.oy ?? 0;
  s.objBlend = true;
  s.visible = true;
  s._pri = 2;
  s.oamPriority = 2;
  s._pz = true;
  s.subpriority = P.subpriorityOf(side);
  s.customDraw = clone_draw;
  s._cb = function () { /* empty */ };
  s.callback = runner;
  P.updateZ(s);
  return s;
};

// Lua: g1_sprite.lua:936 -- pokefirered/src/battle_anim_mons.c:1762
S.monYOffsetFromYScale = function (vm: any, side: any): void {
  const p = P.present(side);
  if (!p) return;
  const v = 64 - P.yDelta(vm, side) * 2;
  const d = p._g1Ys ?? 0x100;
  let var2 = d !== 0 ? P.cdiv(v << 8, d) : 0;
  if (var2 > 128) var2 = 128;
  p.oy = P.cdiv(v - var2, 2);
};

// Lua: g1_sprite.lua:947 -- pokefirered/src/battle_anim_mons.c:1233
S.monYOffsetFromRotation = function (side: any): void {
  const p = P.present(side);
  if (!p) return;
  const rot = p._g1Rot ?? 0;
  const ys = p._g1Ys ?? 0x100;
  const c = floor(Math.sin((((rot >>> 8) & 0xFF) / 256) * 2 * Math.PI) * 16384);
  let mc = (c * ys) >> 14;
  if (mc < 0) mc = -mc;
  p.oy = mc >> 3;
};

export default S;
