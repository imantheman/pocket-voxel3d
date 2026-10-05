// Port of gen1recomp src/core/game3/bg.lua (GPLv3 + additional terms; see LICENSE.md).
// pret-faithful GBA background layers for game3 (4 hardware BGs).
// Each BG has its own priority 0..3 (lower = closer to camera).
// Display.composeHardware interleaves Bg.flushPriority with Oam.flushPriority.

import { tonumber } from "../../../import/gen3/lua.ts";
import { G } from "../platform/graphics.ts";
import type { Image, Quad } from "../platform/image.ts";
import { insert, ipairs, sort, seq, type LuaTable } from "../platform/lt.ts";
import { Fx, type GbaBlend, type GbaClip, type GbaFxSpec } from "./gba_fx.ts";

export interface BgLayer {
  id: number;
  visible: boolean;
  priority: number;
  image: Image | null | undefined;
  quad: Quad | null | undefined;
  // Pixel scroll (pret ChangeBgX/Y are Q8.8; callers convert or use setScrollPx)
  scrollX: number;
  scrollY: number;
  // Optional wrap period for H/V tiling (nil = no wrap)
  wrapW: number | null | undefined;
  wrapH: number | null | undefined;
  // Extra draw offset (close-up nudges, letterbox)
  offsetX: number;
  offsetY: number;
  alpha: number;
  fx: GbaFxSpec | null | undefined;
  blend: GbaBlend | null | undefined;
  clip: GbaClip | null | undefined;
  [k: string]: any;
}

// Lua: bg.lua:12
function new_layer(id: number): BgLayer {
  return {
    id,
    visible: false,
    priority: 0,
    image: null,
    quad: null,
    scrollX: 0,
    scrollY: 0,
    wrapW: null,
    wrapH: null,
    offsetX: 0,
    offsetY: 0,
    alpha: 1,
    fx: null,
    blend: null,
    clip: null,
  };
}

// Lua: bg.lua:37
function ensure(): void {
  if (Bg._layers) return;
  Bg._layers = [];
  for (let i = 0; i <= Bg.COUNT - 1; i++) {
    Bg._layers[i] = new_layer(i);
  }
}

// Lua: bg.lua:180
function modPositive(a: number, n: number): number {
  // Lua's % (floored), twice, as written
  const m1 = a - Math.floor(a / n) * n;
  const s = m1 + n;
  return s - Math.floor(s / n) * n;
}

// Lua: bg.lua:201
function blitRaw(L: BgLayer): void {
  const img = L.image!;
  const a = L.alpha ?? 1;
  G.setColor(1, 1, 1, a);

  const scrollX = Math.floor(L.scrollX ?? 0);
  const scrollY = Math.floor(L.scrollY ?? 0);
  const ox = (L.offsetX ?? 0) - scrollX;
  const oy = (L.offsetY ?? 0) - scrollY;
  const wrapW = L.wrapW;
  const wrapH = L.wrapH;

  // GBA sampling: screen (0,0) shows image (scrollX, scrollY), with optional wrap.
  const drawAt = (x: number, y: number): void => {
    if (L.quad) {
      G.draw(img, L.quad, x, y);
    } else {
      G.draw(img, x, y);
    }
  };

  if (wrapW != null && wrapW > 0 && wrapH != null && wrapH > 0) {
    let startX = modPositive(ox, wrapW);
    if (startX > 0) startX = startX - wrapW;
    let startY = modPositive(oy, wrapH);
    if (startY > 0) startY = startY - wrapH;
    let y = startY;
    while (y < 160 + wrapH) {
      let x = startX;
      while (x < 240 + wrapW) {
        drawAt(x, y);
        x = x + wrapW;
      }
      y = y + wrapH;
    }
  } else if (wrapW != null && wrapW > 0) {
    let start = modPositive(ox, wrapW);
    if (start > 0) start = start - wrapW;
    let x = start;
    while (x < 240 + wrapW) {
      drawAt(x, oy);
      x = x + wrapW;
    }
  } else if (wrapH != null && wrapH > 0) {
    let start = modPositive(oy, wrapH);
    if (start > 0) start = start - wrapH;
    let y = start;
    while (y < 160 + wrapH) {
      drawAt(ox, y);
      y = y + wrapH;
    }
  } else {
    drawAt(ox, oy);
  }
}

// Lua: bg.lua:257
function blitLayer(L: BgLayer): void {
  if (!L.image) return;
  if (L.clip != null && (L.clip.w <= 0 || L.clip.h <= 0)) return;
  Fx.withClip(L.clip, () => {
    Fx.draw(() => blitRaw(L), L.fx, L.blend);
  });
}

const byIdDesc = (a: BgLayer, b: BgLayer): boolean => a.id > b.id; // high id first (behind)

export const Bg = {
  COUNT: 4, // BG0..BG3
  COORD_SET: 0,
  COORD_ADD: 1,
  COORD_SUB: 2,

  /** _layers[0..3] (Lua keys 0..3) */
  _layers: null as BgLayer[] | null,

  // Lua: bg.lua:45
  reset(): void {
    ensure();
    for (let i = 0; i <= Bg.COUNT - 1; i++) {
      const L = Bg._layers![i]!;
      L.visible = false;
      L.priority = 0;
      L.image = null;
      L.quad = null;
      L.scrollX = 0;
      L.scrollY = 0;
      L.wrapW = null;
      L.wrapH = null;
      L.offsetX = 0;
      L.offsetY = 0;
      L.alpha = 1;
      L.fx = null;
      L.blend = null;
      L.clip = null;
    }
  },

  // Lua: bg.lua:66
  get(bgIn: unknown): BgLayer | null {
    ensure();
    const bg = tonumber(bgIn);
    if (bg == null || bg < 0 || bg >= Bg.COUNT) return null;
    return Bg._layers![bg] ?? null;
  },

  /** InitBgsFromTemplates-style: { {bg=, priority=, ...}, ... } */
  // Lua: bg.lua:74
  initFromTemplates(templates: LuaTable): void {
    Bg.reset();
    if (templates == null) return;
    for (const [, t] of ipairs<any>(templates)) {
      const L = Bg.get(t.bg);
      if (L) {
        L.priority = tonumber(t.priority) ?? 0;
        if (t.visible) L.visible = true;
      }
    }
  },

  // Lua: bg.lua:86
  setImage(bg: number, image: Image | null | undefined, quad?: Quad | null): void {
    const L = Bg.get(bg);
    if (!L) return;
    L.image = image;
    L.quad = quad;
  },

  // Lua: bg.lua:93
  setQuad(bg: number, quad: Quad | null | undefined): void {
    const L = Bg.get(bg);
    if (!L) return;
    L.quad = quad;
  },

  // Lua: bg.lua:99
  setPriority(bg: number, priority: unknown): void {
    const L = Bg.get(bg);
    if (!L) return;
    L.priority = Math.max(0, Math.min(3, tonumber(priority) ?? 0));
  },

  // Lua: bg.lua:105
  show(bg: number): void {
    const L = Bg.get(bg);
    if (L) L.visible = true;
  },

  // Lua: bg.lua:110
  hide(bg: number): void {
    const L = Bg.get(bg);
    if (L) L.visible = false;
  },

  // Lua: bg.lua:115
  setAlpha(bg: number, a: unknown): void {
    const L = Bg.get(bg);
    if (L) L.alpha = tonumber(a) ?? 1;
  },

  // Lua: bg.lua:120
  setOffset(bg: number, ox?: number | null, oy?: number | null): void {
    const L = Bg.get(bg);
    if (!L) return;
    if (ox != null) L.offsetX = ox;
    if (oy != null) L.offsetY = oy;
  },

  // Lua: bg.lua:127
  setWrap(bg: number, wrapW?: number | null, wrapH?: number | null): void {
    const L = Bg.get(bg);
    if (!L) return;
    L.wrapW = wrapW;
    L.wrapH = wrapH;
  },

  /** Direct pixel scroll. */
  // Lua: bg.lua:135
  setScrollPx(bg: number, x?: number | null, y?: number | null): void {
    const L = Bg.get(bg);
    if (!L) return;
    if (x != null) L.scrollX = x;
    if (y != null) L.scrollY = y;
  },

  /** pret ChangeBgX: value is Q8.8 (256ths of a pixel) when using ADD/SUB/SET modes. */
  // Lua: bg.lua:143
  changeBgX(bg: number, value: unknown, mode?: number | null): void {
    const L = Bg.get(bg);
    if (!L) return;
    const px = (tonumber(value) ?? 0) / 256;
    mode = mode ?? Bg.COORD_SET;
    if (mode === Bg.COORD_ADD) {
      L.scrollX = L.scrollX + px;
    } else if (mode === Bg.COORD_SUB) {
      L.scrollX = L.scrollX - px;
    } else {
      L.scrollX = px;
    }
  },

  // Lua: bg.lua:157
  changeBgY(bg: number, value: unknown, mode?: number | null): void {
    const L = Bg.get(bg);
    if (!L) return;
    const px = (tonumber(value) ?? 0) / 256;
    mode = mode ?? Bg.COORD_SET;
    if (mode === Bg.COORD_ADD) {
      L.scrollY = L.scrollY + px;
    } else if (mode === Bg.COORD_SUB) {
      L.scrollY = L.scrollY - px;
    } else {
      L.scrollY = px;
    }
  },

  // Lua: bg.lua:171
  hasVisible(): boolean {
    ensure();
    for (let i = 0; i <= Bg.COUNT - 1; i++) {
      const L = Bg._layers![i]!;
      if (L.visible && L.image) return true;
    }
    return false;
  },

  // Lua: bg.lua:186
  setFx(bg: number, fx: GbaFxSpec | null | undefined): void {
    const L = Bg.get(bg);
    if (L) L.fx = fx;
  },

  // Lua: bg.lua:191
  setBlend(bg: number, blend: GbaBlend | null | undefined): void {
    const L = Bg.get(bg);
    if (L) L.blend = blend;
  },

  // Lua: bg.lua:196
  setClip(bg: number, clip: GbaClip | null | undefined): void {
    const L = Bg.get(bg);
    if (L) L.clip = clip;
  },

  /** Draw all visible BGs with the given hardware priority (back-to-front caller loops 3→0).
   *  Same-priority BGs: lower BG index drawn later (in front), matching GBA. */
  // Lua: bg.lua:267
  flushPriority(priorityIn: unknown): void {
    // `if not love or not love.graphics`: G is always present
    ensure();
    const priority = tonumber(priorityIn) ?? 0;
    // Collect then draw low index last (front)
    const list = seq<BgLayer>();
    for (let i = 0; i <= Bg.COUNT - 1; i++) {
      const L = Bg._layers![i]!;
      if (L.visible && L.image && L.priority === priority) {
        insert(list, L);
      }
    }
    sort(list, byIdDesc);
    for (const [, L] of ipairs<BgLayer>(list)) {
      blitLayer(L);
    }
    G.setColor(1, 1, 1, 1);
  },

  /** Flush all priorities back→front (BGs only). Prefer Display.composeHardware. */
  // Lua: bg.lua:287
  flushAll(): void {
    for (let pri = 3; pri >= 0; pri--) {
      Bg.flushPriority(pri);
    }
  },
};

export default Bg;
