// Port of gen1recomp src/core/game3/gba_fx.lua (GPLv3 + additional terms; see LICENSE.md).
// GBA colour effects for a BG layer or sprite: palette fade (BLDY toward a
// colour, per palette slot), greyscale, brightness (BLDY), the OBJ window,
// the scanline band, and the BLDALPHA two-pass blend. The GLSL source at
// gba_fx.lua:3 is the platform effect "gba_fx" (platform/effects/gba_fx.ts).

import { G, type Shader } from "../platform/graphics.ts";
import { seq, type LuaTable } from "../platform/lt.ts";

/** A colour effect: Pal:fx() builds these (y 0..16 toward color, gray, bldy, objWin, band). */
export interface GbaFxSpec {
  y?: number;
  color?: LuaTable;
  gray?: boolean;
  bldy?: number;
  objWin?: { image?: unknown; x: number; y: number; w: number; h: number; bldy?: number } | null;
  band?: number | null;
  base?: LuaTable;
  [k: string]: unknown;
}

/** BLDALPHA: eva (target 1) and evb (target 2), 0..16. */
export interface GbaBlend { eva?: number; evb?: number }

export interface GbaClip { x: number; y: number; w: number; h: number }

// NOT FAITHFUL: the GLSL source (gba_fx.lua:3) is not compiled here; the
// shader is created by its effect name, "gba_fx", which implements it.
const SRC = "gba_fx";

let shader: Shader | false | undefined;

// Lua: gba_fx.lua:53
function getShader(): Shader | undefined {
  if (shader === undefined) {
    try {
      shader = G.newShader(SRC);
    } catch {
      shader = false;
    }
  }
  return shader || undefined;
}

// Lua: gba_fx.lua:65
function send(sh: Shader, fx: GbaFxSpec | null | undefined, mode: number, k?: number): void {
  const col = (fx != null && fx.color != null) ? fx.color : Fx.BLACK;
  sh.send("fadeY", (fx != null && fx.y != null) ? fx.y : 0);
  // a vec3 uniform: LÖVE's {r, g, b} as a JS array (glsl.vec reads arrays 0-based)
  sh.send("fadeColor", [col[1], col[2], col[3]]);
  sh.send("gray", (fx != null && fx.gray) ? 1 : 0);
  sh.send("bldy", (fx != null && fx.bldy != null) ? fx.bldy : 0);
  sh.send("mode", mode);
  sh.send("k", k ?? 1);
  sh.send("bandOn", (fx != null && fx.band != null) ? 1 : 0);
  sh.send("bandY", (fx != null && fx.band != null) ? fx.band : 0);
  const win = fx != null ? fx.objWin : null;
  if (win != null && win.image != null) {
    sh.send("winOn", 1);
    sh.send("winTex", win.image);
    sh.send("winRect", [win.x, win.y, win.w, win.h]);
    sh.send("winBldy", win.bldy ?? 0);
  } else {
    sh.send("winOn", 0);
  }
}

export const Fx = {
  WHITE: seq(31, 31, 31) as LuaTable,
  BLACK: seq(0, 0, 0) as LuaTable,

  // Lua: gba_fx.lua:86
  active(fx: GbaFxSpec | null | undefined, blend?: GbaBlend | null): boolean {
    if (blend != null) return true;
    if (fx == null) return false;
    return (fx.y ?? 0) > 0 || !!fx.gray || (fx.bldy ?? 0) > 0 || fx.objWin != null || fx.band != null;
  },

  // Lua: gba_fx.lua:92
  draw(drawFn: () => void, fx: GbaFxSpec | null | undefined, blend?: GbaBlend | null): void {
    if (!Fx.active(fx, blend)) {
      drawFn();
      return;
    }
    const sh = getShader();
    if (!sh) {
      drawFn();
      return;
    }
    const prevShader = G.getShader();
    if (blend != null) {
      const [mode, alphaMode] = G.getBlendMode();
      send(sh, fx, 1, Math.min(16, blend.evb ?? 0) / 16);
      G.setShader(sh);
      G.setBlendMode("multiply", "premultiplied");
      drawFn();
      send(sh, fx, 2, Math.min(16, blend.eva ?? 0) / 16);
      G.setBlendMode("add", "alphamultiply");
      drawFn();
      G.setBlendMode(mode, alphaMode);
    } else {
      send(sh, fx, 0, 1);
      G.setShader(sh);
      drawFn();
    }
    G.setShader(prevShader);
  },

  // Lua: gba_fx.lua:121
  withClip(clip: GbaClip | null | undefined, fn: () => void): void {
    if (clip == null) {
      fn();
      return;
    }
    const prev = G.getScissor();
    G.intersectScissor(clip.x, clip.y, Math.max(0, clip.w), Math.max(0, clip.h));
    fn();
    if (prev) {
      G.setScissor(prev[0], prev[1], prev[2], prev[3]);
    } else {
      G.setScissor();
    }
  },
};

export default Fx;
