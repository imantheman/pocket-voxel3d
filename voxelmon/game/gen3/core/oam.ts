// Port of gen1recomp src/core/game3/oam.lua (GPLv3 + additional terms; see LICENSE.md).
// pret-faithful GBA sprite pool + OAM blit for game3 (240×160).
// CreateSprite x/y are CENTER; hardware TL = x+x2+centerToCornerVec.

import { tonumber } from "../../../import/gen3/lua.ts";
import { G } from "../platform/graphics.ts";
import type { Image, Quad } from "../platform/image.ts";
import { len, seq, sort, type LuaTable } from "../platform/lt.ts";
import { Fx, type GbaBlend, type GbaClip, type GbaFxSpec } from "./gba_fx.ts";

export interface OamAttrs {
  shape: number;
  size: number;
  priority: number;
  affineMode: number;
  hFlip: boolean;
  vFlip: boolean;
  matrixNum: number;
}

export interface AffineAnimState { cmds: LuaTable; index: number; delay: number; begin: boolean; scale: number }

/** A sprite slot (pret struct Sprite, plus the port's draw fields). Callers hang their own fields on it. */
export interface Sprite {
  inUse: boolean;
  oam: OamAttrs;
  x: number;
  y: number;
  x2: number;
  y2: number;
  centerToCornerVecX: number;
  centerToCornerVecY: number;
  subpriority: number;
  invisible: boolean;
  callback: (s: Sprite) => void;
  /** data[1..8] (pret data[0..7]) */
  data: number[];
  image: Image | null | undefined;
  quad: Quad | null | undefined;
  animPaused: boolean;
  layer?: string;
  fx?: GbaFxSpec | null;
  blend?: GbaBlend | null;
  clip?: GbaClip | null;
  anims?: LuaTable;
  animQuads?: LuaTable;
  animNum?: number;
  animBeginning?: boolean;
  animEnded?: boolean;
  animCmdIndex?: number;
  animDelayCounter?: number;
  affineAnim?: AffineAnimState | null;
  affineScale?: number | null;
  affineScaleRaw?: number;
  affineMatrixA?: number | null;
  affineAnimEnded?: boolean;
  anchored?: boolean;
  anchorX?: number | null;
  anchorY?: number | null;
  objWindow?: any;
  palSlot?: any;
  objBlend?: any;
  _id?: number;
  _oamSortY?: number;
  /** buildOamBuffer's sprite_priority_key, once a frame */
  _oamKey?: number;
  /** its pool slot and the sort's stamp (buildOamBuffer) */
  _oamSlot?: number;
  _oamStamp?: number;
  [k: string]: any;
}

export interface SpriteDims { shape: number; size: number; w: number; h: number }

// pret sCenterToCornerVecTable[shape][size] = {x, y} (signed)
// (Lua keys [0..2][0..3]; each pair a sequence)
const CENTER_TO_CORNER: LuaTable[][] = [
  [ // square
    seq(-4, -4),
    seq(-8, -8),
    seq(-16, -16),
    seq(-32, -32),
  ],
  [ // horizontal rectangle
    seq(-8, -4),
    seq(-16, -4),
    seq(-16, -8),
    seq(-32, -16),
  ],
  [ // vertical rectangle
    seq(-4, -8),
    seq(-4, -16),
    seq(-8, -16),
    seq(-16, -32),
  ],
];

// Lua: oam.lua:64
function dummy_callback(_sprite: Sprite): void { /* nothing */ }

// Lua: oam.lua:67
function new_slot(): Sprite {
  return {
    inUse: false,
    oam: {
      shape: 0,
      size: 0,
      priority: 0,
      affineMode: 0,
      hFlip: false,
      vFlip: false,
      matrixNum: 0,
    },
    x: 0,
    y: 0,
    x2: 0,
    y2: 0,
    centerToCornerVecX: 0,
    centerToCornerVecY: 0,
    subpriority: 0,
    invisible: false,
    callback: dummy_callback,
    data: seq(0, 0, 0, 0, 0, 0, 0, 0) as number[],
    image: null,
    quad: null,
    animPaused: false,
  };
}

// Lua: oam.lua:100
function ensure_pool(): void {
  if (Oam._sprites) return;
  Oam._sprites = [];
  for (let i = 0; i <= Oam.MAX_SPRITES - 1; i++) {
    Oam._sprites[i] = new_slot();
  }
}

// Lua: oam.lua:159
function copy_oam(dst: OamAttrs, src: Partial<OamAttrs> | null | undefined): void {
  if (src == null) return;
  dst.shape = src.shape ?? 0;
  dst.size = src.size ?? 0;
  dst.priority = src.priority ?? 0;
  dst.affineMode = src.affineMode ?? 0;
  dst.hFlip = !!src.hFlip;
  dst.vFlip = !!src.vFlip;
  dst.matrixNum = src.matrixNum ?? 0;
}

// Lua: oam.lua:317
function layer_of(sprite: Sprite): string {
  return sprite.layer ?? "ui";
}

// Lua: oam.lua:326
function applyAnimFrame(s: Sprite, cmd: any): void {
  let dur = cmd.dur ?? 0;
  if (dur > 0) dur = dur - 1;
  s.animDelayCounter = dur;
  if (s.animQuads != null && s.animQuads[cmd.img] != null) {
    s.quad = s.animQuads[cmd.img];
  }
}

// Lua: oam.lua:335
function stepAnim(s: Sprite): void {
  const list = s.anims[s.animNum!];
  if (list == null) return;
  if (s.animBeginning) {
    s.animBeginning = false;
    s.animCmdIndex = 1;
    s.animEnded = false;
    applyAnimFrame(s, list[1]);
    return;
  }
  if (s.animDelayCounter! > 0) {
    if (!s.animPaused) s.animDelayCounter = s.animDelayCounter! - 1;
    return;
  }
  if (s.animPaused) return;
  s.animCmdIndex = s.animCmdIndex! + 1;
  const cmd = list[s.animCmdIndex];
  if (cmd == null || cmd === "end") {
    s.animCmdIndex = s.animCmdIndex - 1;
    s.animEnded = true;
  } else if (cmd.jump != null) {
    s.animCmdIndex = cmd.jump + 1;
    applyAnimFrame(s, list[s.animCmdIndex!]);
  } else {
    applyAnimFrame(s, cmd);
  }
}

// (Lua keys [0..2][0..3]; each {w, h} a sequence)
const SPRITE_DIMS: LuaTable[][] = [
  [seq(8, 8), seq(16, 16), seq(32, 32), seq(64, 64)],
  [seq(16, 8), seq(32, 8), seq(32, 16), seq(64, 32)],
  [seq(8, 16), seq(8, 32), seq(16, 32), seq(32, 64)],
];

// Lua: oam.lua:376
function idiv(a: number, b: number): number {
  const q = a / b;
  return q >= 0 ? Math.floor(q) : Math.ceil(q);
}

// pokefirered/src/sprite.c:1233
// Lua: oam.lua:382
function anchorCoord(baseDim: number, xformed: number, modifier: number): number {
  const sub = xformed - baseDim;
  let shift: number;
  if (sub < 0) {
    shift = Math.floor(-sub / 512);
  } else {
    shift = -Math.floor(sub / 512);
  }
  return modifier - (Math.floor((modifier * xformed) / baseDim) + shift);
}

// Lua: oam.lua:393
function updateAnchor(s: Sprite): void {
  const a = s.affineMatrixA ?? 0x100;
  const dims = SPRITE_DIMS[s.oam.shape]![s.oam.size]!;
  if (s.anchorX != null) {
    const dim = dims[1];
    s.x2 = anchorCoord(dim * 256, idiv(dim * 65536, a), s.anchorX);
  }
  if (s.anchorY != null) {
    const dim = dims[2];
    s.y2 = anchorCoord(dim * 256, idiv(dim * 65536, a), s.anchorY);
  }
}

// Lua: oam.lua:406
function setAffineScale(s: Sprite, scale: number): void {
  s.affineScaleRaw = scale;
  const a = scale !== 0 ? idiv(0x10000, scale) : 0x100;
  s.affineMatrixA = a;
  s.affineScale = 256 / a;
}

// pokefirered/src/sprite.c:1274
// Lua: oam.lua:426
function applyAffineFrame(s: Sprite, st: AffineAnimState, c: any): void {
  if ((c.dur ?? 0) > 0) {
    st.delay = c.dur - 1;
    st.scale = st.scale + c.v;
  } else {
    st.delay = 0;
    st.scale = c.v;
  }
  setAffineScale(s, st.scale);
}

// Lua: oam.lua:437
function stepAffine(s: Sprite): void {
  const st = s.affineAnim!;
  const cmds = st.cmds;
  if (st.begin) {
    st.begin = false;
    st.index = 1;
    s.affineAnimEnded = false;
    applyAffineFrame(s, st, cmds[1]);
  } else if (st.delay > 0) {
    st.delay = st.delay - 1;
    st.scale = st.scale + (cmds[st.index].v ?? 0);
    setAffineScale(s, st.scale);
  } else {
    st.index = st.index + 1;
    const c = cmds[st.index];
    if (c == null || c === "end") {
      st.index = st.index - 1;
      s.affineAnimEnded = true;
    } else {
      applyAffineFrame(s, st, c);
    }
  }
  if (s.anchored) updateAnchor(s);
}

// Lua: oam.lua:479
function sprite_priority_key(sprite: Sprite): number {
  // pret: gSpritePriorities[i] = subpriority | (oam.priority << 8)
  const oamPri = (sprite.oam && sprite.oam.priority) || 0;
  const sub = sprite.subpriority ?? 0;
  return oamPri * 256 + sub;
}

// Lua: oam.lua:486
function sort_sprites(a: Sprite, b: Sprite): boolean {
  // pret SortSprites: lower priority key first (drawn behind), then lower y.
  const pa = sprite_priority_key(a), pb = sprite_priority_key(b);
  if (pa !== pb) return pa < pb;
  return (a._oamSortY ?? 0) < (b._oamSortY ?? 0);
}

/** Collect visible sprites into draw buffer (BuildOamBuffer). */
// Lua: oam.lua:494
function sort_sprites_pret(a: Sprite, b: Sprite): boolean {
  // pokefirered/src/sprite.c:368
  const pa = sprite_priority_key(a), pb = sprite_priority_key(b);
  if (pa !== pb) return pa > pb;
  const ya = a._oamSortY ?? 0, yb = b._oamSortY ?? 0;
  if (ya !== yb) return ya < yb;
  return (a._id ?? 0) > (b._id ?? 0);
}

// Lua: oam.lua:567
function blit_affine(s: Sprite): void {
  const img = s.image!, q = s.quad;
  const dims = SPRITE_DIMS[s.oam.shape]![s.oam.size]!;
  const w = dims[1], h = dims[2];
  const m = s.affineScale ?? 1;
  let cx = (s.x ?? 0) + (s.x2 ?? 0) + (Oam._coordOffsetX ?? 0);
  let cy = (s.y ?? 0) + (s.y2 ?? 0) + (Oam._coordOffsetY ?? 0);
  if (!(Math.floor(s.oam.affineMode / 2) % 2 === 1)) {
    cx = cx + (s.centerToCornerVecX ?? 0) + w / 2;
    cy = cy + (s.centerToCornerVecY ?? 0) + h / 2;
  }
  if (q) {
    G.draw(img, q, cx, cy, 0, m, m, w / 2, h / 2);
  } else {
    G.draw(img, cx, cy, 0, m, m, w / 2, h / 2);
  }
}

// Lua: oam.lua:585
function blit_sprite(s: Sprite): void {
  const fx = s.fx ?? Oam._fx;
  const blend = s.blend ?? Oam._blend;
  const clip = s.clip ?? Oam._clip;
  if (clip != null && (clip.w <= 0 || clip.h <= 0)) return;
  const affine = s.affineScale;
  // No clip and an fx that draws plainly (Fx.withClip and Fx.draw would
  // just call through): skip building their closures.
  if (clip == null && !Fx.active(fx, blend)) {
    if (affine != null) blit_affine(s); else blit_plain(s);
    return;
  }
  const draw = affine != null ? (): void => blit_affine(s) : (): void => blit_plain(s);
  Fx.withClip(clip, () => Fx.draw(draw, fx, blend));
}

// Lua: oam.lua:599
function blit_plain(s: Sprite): void {
  // Oam.oamTopLeft(s), without building its pair (a per-sprite path)
  const tlx = (s.x ?? 0) + (s.x2 ?? 0) + (s.centerToCornerVecX ?? 0)
    + (Oam._coordOffsetX ?? 0);
  const tly = (s.y ?? 0) + (s.y2 ?? 0) + (s.centerToCornerVecY ?? 0)
    + (Oam._coordOffsetY ?? 0);
  const img = s.image, q = s.quad;
  if (!img) return;
  const sx = s.oam.hFlip ? -1 : 1;
  const sy = s.oam.vFlip ? -1 : 1;
  if (sx < 0 || sy < 0) {
    const dims = CENTER_TO_CORNER[s.oam.shape] && CENTER_TO_CORNER[s.oam.shape]![s.oam.size];
    const halfW = dims ? -dims[1] : 16;
    const halfH = dims ? -dims[2] : 16;
    const w = halfW * 2, h = halfH * 2;
    const dx = sx < 0 ? (tlx + w) : tlx;
    const dy = sy < 0 ? (tly + h) : tly;
    if (q) {
      G.draw(img, q, dx, dy, 0, sx, sy);
    } else {
      G.draw(img, dx, dy, 0, sx, sy);
    }
  } else {
    if (q) {
      G.draw(img, q, tlx, tly);
    } else {
      G.draw(img, tlx, tly);
    }
  }
}

const drawable = (s: Sprite): boolean => s.inUse && !s.invisible && !!s.image;

// sort_sprites_pret and sort_sprites over the keys buildOamBuffer stored
// (_oamKey, _oamSortY), for when every key is a plain number: the same
// answers without recomputing sprite_priority_key at each comparison.
function pret_before(a: Sprite, b: Sprite): boolean {
  const pa = a._oamKey!, pb = b._oamKey!;
  if (pa !== pb) return pa > pb;
  const ya = a._oamSortY!, yb = b._oamSortY!;
  if (ya !== yb) return ya < yb;
  return (a._id ?? 0) > (b._id ?? 0);
}
function plain_before(a: Sprite, b: Sprite): boolean {
  const pa = a._oamKey!, pb = b._oamKey!;
  if (pa !== pb) return pa < pb;
  return a._oamSortY! < b._oamSortY!;
}
// The same orders with pool slot last: what lt.ts's stable sort from pool
// order gives, as one total order, so any sort reaches the same list.
function pret_total(a: Sprite, b: Sprite): boolean {
  if (pret_before(a, b)) return true;
  if (pret_before(b, a)) return false;
  return a._oamSlot! < b._oamSlot!;
}
function plain_total(a: Sprite, b: Sprite): boolean {
  if (plain_before(a, b)) return true;
  if (plain_before(b, a)) return false;
  return a._oamSlot! < b._oamSlot!;
}
const sortScratch: Sprite[] = [];
let sortStamp = 0;

export const Oam = {
  MAX_SPRITES: 64,
  DISPLAY_WIDTH: 240,
  DISPLAY_HEIGHT: 160,

  // ST_OAM shape
  SHAPE_SQUARE: 0,
  SHAPE_H_RECT: 1,
  SHAPE_V_RECT: 2,

  // ST_OAM size index 0..3
  SIZE_0: 0,
  SIZE_1: 1,
  SIZE_2: 2,
  SIZE_3: 3,

  AFFINE_OFF: 0,
  AFFINE_NORMAL: 1,
  AFFINE_ERASE: 2,
  AFFINE_DOUBLE: 3,

  // Convenient aliases matching common pret SPRITE_SHAPE/SIZE macros
  SQUARE_8: { shape: 0, size: 0, w: 8, h: 8 } as SpriteDims,
  SQUARE_16: { shape: 0, size: 1, w: 16, h: 16 } as SpriteDims,
  SQUARE_32: { shape: 0, size: 2, w: 32, h: 32 } as SpriteDims,
  SQUARE_64: { shape: 0, size: 3, w: 64, h: 64 } as SpriteDims,
  HRECT_16x8: { shape: 1, size: 0, w: 16, h: 8 } as SpriteDims,
  HRECT_32x8: { shape: 1, size: 1, w: 32, h: 8 } as SpriteDims,
  HRECT_32x16: { shape: 1, size: 2, w: 32, h: 16 } as SpriteDims,
  HRECT_64x32: { shape: 1, size: 3, w: 64, h: 32 } as SpriteDims,
  VRECT_8x16: { shape: 2, size: 0, w: 8, h: 16 } as SpriteDims,
  VRECT_8x32: { shape: 2, size: 1, w: 8, h: 32 } as SpriteDims,
  VRECT_16x32: { shape: 2, size: 2, w: 16, h: 32 } as SpriteDims,
  VRECT_32x64: { shape: 2, size: 3, w: 32, h: 64 } as SpriteDims,

  DUMMY_CALLBACK: dummy_callback,

  /** _sprites[0..63] (Lua keys 0..63) */
  _sprites: null as Sprite[] | null,
  _buffer: null as LuaTable | null, // sorted draw list for this frame
  _sorted: null as LuaTable | null,
  _sortedPool: null as Sprite[] | null,
  _coordOffsetX: 0,
  _coordOffsetY: 0,
  _clip: null as GbaClip | null | undefined,
  _fx: null as GbaFxSpec | null | undefined,
  _blend: null as GbaBlend | null | undefined,
  _layer: "ui",

  // Lua: oam.lua:108
  reset(): void {
    ensure_pool();
    for (let i = 0; i <= Oam.MAX_SPRITES - 1; i++) {
      const s = Oam._sprites![i]!;
      s.inUse = false;
      s.image = null;
      s.quad = null;
      s.callback = dummy_callback;
      s.invisible = false;
      s.x2 = 0; s.y2 = 0;
      s.fx = null; s.blend = null; s.clip = null;
      s.anims = null; s.animQuads = null; s.affineAnim = null;
    }
    Oam._buffer = null;
    Oam._sorted = null;
    Oam._clip = null;
    Oam._fx = null;
    Oam._blend = null;
  },

  /** pret CalcCenterToCornerVec (signed). */
  // Lua: oam.lua:129
  calcCenterToCornerVec(shapeIn: unknown, sizeIn: unknown, affineModeIn: unknown): [number, number] {
    const shape = tonumber(shapeIn) ?? 0;
    const size = tonumber(sizeIn) ?? 0;
    const affineMode = tonumber(affineModeIn) ?? 0;
    const row = CENTER_TO_CORNER[shape] && CENTER_TO_CORNER[shape]![size];
    if (!row) return [0, 0];
    let x: number = row[1], y: number = row[2];
    // ST_OAM_AFFINE_DOUBLE_MASK = 0x2
    if (Math.floor(affineMode / 2) % 2 === 1) {
      x = x * 2; y = y * 2;
    }
    return [x, y];
  },

  // Lua: oam.lua:143
  applyCenterToCorner(sprite: Sprite): void {
    const [cx, cy] = Oam.calcCenterToCornerVec(
      sprite.oam.shape, sprite.oam.size, sprite.oam.affineMode);
    sprite.centerToCornerVecX = cx;
    sprite.centerToCornerVecY = cy;
  },

  /** Hardware OAM top-left (pret sprite.c BuildOamBuffer path). */
  // Lua: oam.lua:151
  oamTopLeft(sprite: Sprite): [number, number] {
    const ox = (sprite.x ?? 0) + (sprite.x2 ?? 0) + (sprite.centerToCornerVecX ?? 0)
      + (Oam._coordOffsetX ?? 0);
    const oy = (sprite.y ?? 0) + (sprite.y2 ?? 0) + (sprite.centerToCornerVecY ?? 0)
      + (Oam._coordOffsetY ?? 0);
    return [ox, oy];
  },

  /** CreateSprite — x/y are CENTER. template fields:
   *  oam | shape,size,priority | image, quad | callback | w,h (optional dims hint) */
  // Lua: oam.lua:172
  createSprite(template: any, x?: unknown, y?: unknown, subpriority?: unknown): [number, Sprite] | [null, null] {
    ensure_pool();
    template = template ?? {};
    for (let i = 0; i <= Oam.MAX_SPRITES - 1; i++) {
      const s = Oam._sprites![i]!;
      if (!s.inUse) {
        s.inUse = true;
        s.oam.affineMode = 0;
        s.oam.hFlip = false; s.oam.vFlip = false;
        s.oam.matrixNum = 0;
        copy_oam(s.oam, template.oam);
        if (template.shape != null) s.oam.shape = template.shape;
        if (template.size != null) s.oam.size = template.size;
        if (template.priority != null) s.oam.priority = template.priority;
        // Convenience: pass Oam.SQUARE_32 etc.
        if (template.dims) {
          s.oam.shape = template.dims.shape;
          s.oam.size = template.dims.size;
        }
        s.x = tonumber(x) ?? 0;
        s.y = tonumber(y) ?? 0;
        s.x2 = 0;
        s.y2 = 0;
        s.subpriority = tonumber(subpriority) ?? 0;
        s.invisible = false;
        s.callback = template.callback || dummy_callback;
        s.image = template.image;
        s.quad = template.quad;
        s.animPaused = !!template.animPaused;
        s.layer = template.layer || Oam._layer || "ui";
        s.fx = null; s.blend = null; s.clip = null;
        s.anims = template.anims;
        s.animQuads = template.animQuads;
        s.animNum = 0;
        s.animBeginning = template.anims != null;
        s.animEnded = false;
        s.animCmdIndex = 0;
        s.animDelayCounter = 0;
        s.affineAnim = null;
        s.affineScale = null;
        s.affineMatrixA = null;
        s.affineAnimEnded = false;
        s.anchored = false;
        s.anchorX = null; s.anchorY = null;
        s.objWindow = null; s.palSlot = null; s.objBlend = null;
        for (let d = 1; d <= 8; d++) s.data[d] = 0;
        Oam.applyCenterToCorner(s);
        s._id = i;
        return [i, s];
      }
    }
    return [null, null];
  },

  // Lua: oam.lua:226
  destroySprite(idIn: unknown): void {
    ensure_pool();
    const id = tonumber(idIn);
    if (id == null || id < 0 || id >= Oam.MAX_SPRITES) return;
    const s = Oam._sprites![id];
    if (s == null) return; // a fractional id: Lua's s would be nil and error; nothing to destroy
    s.inUse = false;
    s.image = null;
    s.quad = null;
    s.callback = dummy_callback;
    s.invisible = true;
  },

  // Lua: oam.lua:238
  destroyAll(): void {
    Oam.reset();
  },

  // Lua: oam.lua:242
  get(idIn: unknown): Sprite | null {
    ensure_pool();
    const id = tonumber(idIn);
    if (id == null) return null;
    const s = Oam._sprites![id];
    if (s && s.inUse) return s;
    return null;
  },

  // Lua: oam.lua:251
  setPos(id: unknown, x?: number | null, y?: number | null): void {
    const s = Oam.get(id);
    if (!s) return;
    if (x != null) s.x = x;
    if (y != null) s.y = y;
  },

  // Lua: oam.lua:258
  setOffset(id: unknown, x2?: number | null, y2?: number | null): void {
    const s = Oam.get(id);
    if (!s) return;
    if (x2 != null) s.x2 = x2;
    if (y2 != null) s.y2 = y2;
  },

  // Lua: oam.lua:265
  setImage(id: unknown, image: Image | null | undefined, quad?: Quad | null): void {
    const s = Oam.get(id);
    if (!s) return;
    s.image = image;
    s.quad = quad;
  },

  // Lua: oam.lua:272
  setInvisible(id: unknown, inv: unknown): void {
    const s = Oam.get(id);
    if (!s) return;
    s.invisible = !!inv;
  },

  // Lua: oam.lua:278
  setCallback(id: unknown, cb?: ((s: Sprite) => void) | null): void {
    const s = Oam.get(id);
    if (!s) return;
    s.callback = cb || dummy_callback;
  },

  // Lua: oam.lua:284
  setPriority(id: unknown, priority: unknown): void {
    const s = Oam.get(id);
    if (!s) return;
    s.oam.priority = Math.max(0, Math.min(3, tonumber(priority) ?? 0));
  },

  // Lua: oam.lua:290
  setSubpriority(id: unknown, sub: unknown): void {
    const s = Oam.get(id);
    if (!s) return;
    s.subpriority = tonumber(sub) ?? 0;
  },

  /** Begin frame (pret: clear shadow OAM build). */
  // Lua: oam.lua:297
  resetFrame(): void {
    ensure_pool();
    // Empty this frame's draw list in place; the sorted order survives in
    // Oam._sorted so buildOamBuffer can skip re-sorting an unchanged scene.
    const buf = Oam._buffer;
    if (buf == null || buf === Oam._sorted) {
      Oam._buffer = seq<Sprite>();
    } else {
      for (let i = len(buf); i >= 1; i--) buf[i] = null;
    }
  },

  // Lua: oam.lua:311
  setLayer(layer?: string | null): string {
    const prev = Oam._layer;
    Oam._layer = layer || "ui";
    return prev;
  },

  // Lua: oam.lua:321
  setCoordOffset(ox: unknown, oy: unknown): void {
    Oam._coordOffsetX = tonumber(ox) ?? 0;
    Oam._coordOffsetY = tonumber(oy) ?? 0;
  },

  // pokefirered/src/sprite.c:1066
  // Lua: oam.lua:364
  startAnim(s: Sprite, animNum?: number | null): void {
    s.animNum = animNum ?? 0;
    s.animBeginning = true;
    s.animEnded = false;
  },

  // pokefirered/src/sprite.c:1203
  // Lua: oam.lua:414
  setMatrixAnchor(s: Sprite, x: number | null | undefined, y: number | null | undefined): void {
    s.anchorX = x; s.anchorY = y;
    s.anchored = true;
  },

  // pokefirered/src/sprite.c:1062
  // Lua: oam.lua:420
  startAffineAnim(s: Sprite, cmds: LuaTable): void {
    s.affineAnim = { cmds, index: 1, delay: 0, begin: true, scale: 256 };
    s.affineAnimEnded = false;
  },

  // Lua: oam.lua:462
  animateSprite(s: Sprite): void {
    if (s.inUse && s.anims != null) stepAnim(s);
    if (s.inUse && s.affineAnim != null) stepAffine(s);
  },

  // Lua: oam.lua:467
  animateSprites(layer?: string | null): void {
    ensure_pool();
    for (let i = 0; i <= Oam.MAX_SPRITES - 1; i++) {
      const s = Oam._sprites![i]!;
      if (s.inUse && s.callback && (!layer || (s.layer ?? "ui") === layer)) {
        s.callback(s);
        if (s.inUse && s.anims != null) stepAnim(s);
        if (s.inUse && s.affineAnim != null) stepAffine(s);
      }
    }
  },

  // Lua: oam.lua:503
  buildOamBuffer(pretOrder?: unknown): LuaTable {
    ensure_pool();
    const pool = Oam._sprites!;
    let n = 0;
    // Plain numbers in every key (the usual case) let the sort compare the
    // stored keys; anything else (a string, NaN) keeps the original path.
    let numeric = true;
    for (let i = 0; i <= Oam.MAX_SPRITES - 1; i++) {
      const s = pool[i]!;
      if (drawable(s)) {
        // Oam.oamTopLeft(s)'s y, without building its pair
        const y = (s.y ?? 0) + (s.y2 ?? 0) + (s.centerToCornerVecY ?? 0)
          + (Oam._coordOffsetY ?? 0);
        s._oamSortY = y;
        s._oamSlot = i;
        const k = sprite_priority_key(s);
        s._oamKey = k;
        const id = s._id ?? 0;
        if (typeof y !== "number" || y !== y || typeof k !== "number" || k !== k
          || typeof id !== "number" || id !== id) numeric = false;
        n = n + 1;
      }
    }
    const cmp = numeric
      ? (pretOrder ? pret_before : plain_before)
      : (pretOrder ? sort_sprites_pret : sort_sprites);
    // Cache: last frame's sorted list.  Same length, every entry still drawable
    // and still in order means it holds exactly this frame's sprites (entries
    // are distinct pool slots), so the sort can be skipped.
    let sorted = Oam._sorted;
    let ok = false;
    if (sorted != null && len(sorted) === n && Oam._sortedPool === Oam._sprites) {
      ok = true;
      for (let i = 1; i <= n; i++) {
        const s: Sprite = sorted[i];
        if (!drawable(s)) { ok = false; break; }
        const nx: Sprite | null = sorted[i + 1];
        if (nx != null) {
          if (cmp(nx, s)) { ok = false; break; }
          // equal keys: keep pool order (pret's insertion sort is stable)
          if (!cmp(s, nx) && (s._id ?? 0) > (nx._id ?? 0)) { ok = false; break; }
        }
      }
    }
    if (!ok) {
      sorted = sorted ?? seq<Sprite>();
      let k = 0;
      if (numeric) {
        // An insertion sort under the total order, from last frame's order
        // (sprites that move a little stay nearly sorted), then any sprite
        // new this frame; the total order gives lt.ts sort's list.
        const tot = pretOrder ? pret_total : plain_total;
        const a = sortScratch;
        a.length = 0;
        const st = ++sortStamp;
        if (Oam._sortedPool === Oam._sprites) {
          for (let i = 1, m = len(sorted); i <= m; i++) {
            const s: Sprite | null = sorted[i];
            if (s != null && drawable(s) && s._oamStamp !== st && pool[s._oamSlot!] === s) {
              s._oamStamp = st;
              a.push(s);
            }
          }
        }
        for (let i = 0; i <= Oam.MAX_SPRITES - 1; i++) {
          const s = pool[i]!;
          if (drawable(s) && s._oamStamp !== st) { s._oamStamp = st; a.push(s); }
        }
        for (let i = 1; i < a.length; i++) {
          const s = a[i]!;
          let j = i - 1;
          while (j >= 0 && tot(s, a[j]!)) { a[j + 1] = a[j]!; j--; }
          a[j + 1] = s;
        }
        for (let i = len(sorted); i >= 1; i--) sorted[i] = null;
        for (let i = 0; i < a.length; i++) sorted[i + 1] = a[i];
        a.length = 0;
      } else {
        for (let i = len(sorted); i >= 1; i--) sorted[i] = null;
        for (let i = 0; i <= Oam.MAX_SPRITES - 1; i++) {
          const s = pool[i]!;
          if (drawable(s)) {
            k = k + 1;
            sorted[k] = s;
          }
        }
        sort(sorted, cmp);
      }
      Oam._sorted = sorted;
      Oam._sortedPool = Oam._sprites;
    }
    let buf = Oam._buffer;
    if (buf == null || buf === sorted) {
      buf = seq<Sprite>();
      Oam._buffer = buf;
    }
    for (let i = 1; i <= n; i++) buf[i] = sorted![i];
    for (let i = len(buf); i >= n + 1; i--) buf[i] = null;
    return buf;
  },

  // Lua: oam.lua:556
  setClip(clip: GbaClip | null | undefined): void {
    Oam._clip = clip;
  },

  // Lua: oam.lua:560
  setFx(fx: GbaFxSpec | null | undefined, blend?: GbaBlend | null): void {
    Oam._fx = fx;
    Oam._blend = blend;
  },

  // Lua: oam.lua:626
  flushOne(s: Sprite): void {
    G.setColor(1, 1, 1, 1);
    blit_sprite(s);
  },

  /** Blit sorted OAM to the current Love canvas (all priorities). */
  // Lua: oam.lua:632
  flush(layer?: string | null): void {
    // `if not love or not love.graphics`: G is always present
    let buf = Oam._buffer;
    if (buf == null) buf = Oam.buildOamBuffer();
    G.setColor(1, 1, 1, 1);
    // ipairs(buf), without the iterator (a per-frame path)
    for (let i = 1, s: Sprite = buf[1]; s != null; i++, s = buf[i]) {
      if (!layer || layer_of(s) === layer) {
        blit_sprite(s);
      }
    }
    G.setColor(1, 1, 1, 1);
  },

  /** Blit only sprites at a given OAM priority (for BG×OBJ interleave).
   *  Buffer must already be sorted (buildOamBuffer). Same-pri order preserved. */
  // Lua: oam.lua:647
  flushPriority(priorityIn: unknown, layer?: string | null): void {
    let buf = Oam._buffer;
    if (buf == null) buf = Oam.buildOamBuffer();
    const priority = tonumber(priorityIn) ?? 0;
    G.setColor(1, 1, 1, 1);
    // ipairs(buf), without the iterator (a per-frame path)
    for (let i = 1, s: Sprite = buf[1]; s != null; i++, s = buf[i]) {
      const p = (s.oam && s.oam.priority) || 0;
      if (p === priority && (!layer || layer_of(s) === layer)) {
        blit_sprite(s);
      }
    }
    G.setColor(1, 1, 1, 1);
  },
};

export default Oam;
