// Port of gen1recomp src/core/game3/display.lua (GPLv3 + additional terms; see LICENSE.md).
// Game3 display owner (FRLG-native 240×160).
// Owns the presented frame when Runtime is active: own canvas, own letterbox,
// own UI. Field map is composited under the UI; Gen2 Chrome/StartMenu are not used.
//
// On the 3DS the "window" is the GBA screen itself (G reports 240x160), and
// src/render/Renderer (the plane path's world/UI canvases) is desktop-only
// and inert here, so frames are presented by presentFlat: Brian's own
// fallback when the planes fail.

// The table first: see display_table.ts (load order).
import { G3Lazy } from "./lazy_registry.ts";
import { Display } from "./display_table.ts";
import { tostring } from "../../../import/gen3/lua.ts";
import { G } from "../platform/graphics.ts";
import type { Canvas } from "../platform/image.ts";
import { ipairs, seq, type LuaTable } from "../platform/lt.ts";
import { Logger } from "../shared/core/Logger.ts";
import { SafeArea } from "../shared/core/SafeArea.ts";
import { Renderer as RendererModule } from "../shared/render/Renderer.ts";
import { Tilt } from "../shared/render/Tilt.ts";
import { Help } from "../ui/help_system.ts";
import { Stack } from "../ui/stack.ts";
import { ShopMenu } from "../ui/shop_menu.ts";
import { Battle } from "./battle.ts";
import { BattleTransition } from "./battle_transition.ts";
import { Stream } from "./asset_stream.ts";
import { Bg } from "./bg.ts";
import { Oam } from "./oam.ts";
import { FieldView } from "./field_view.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

// `require("src.render.Renderer")`: a module table whose methods Brian calls
// with `:`; the inert stub stands in for it.
const Renderer: any = RendererModule;

/** Display.composeHardware options. */
export interface ComposeOpts {
  animate?: boolean;
  build?: boolean;
  pretOrder?: unknown;
  clear?: LuaTable;
  scissor?: { x: number; y: number; w: number; h: number } | null;
  underlay?: (() => void) | null;
  overlay?: (() => void) | null;
}

// Lua: display.lua:17
function log(msg: unknown): void {
  // print("[game3/display] " .. tostring(msg))
  Logger.info("%s", "[game3/display] " + tostring(msg));
}

// Lua: display.lua:104
function beginOn(canvas: Canvas): void {
  G.push("all");
  G.setCanvas(canvas);
  G.clear(0, 0, 0, 0);
  G.origin();
  G.setColor(1, 1, 1, 1);
}

// Lua: display.lua:112
function endCanvas(): void {
  G.setCanvas();
  G.pop();
}

// Lua: display.lua:182
function prepareRenderer(game: any, kind: string): any {
  // `require("src.render.Renderer")`
  if (!Renderer.canvas) Renderer.init();
  // `pcall(require, "src.render.PaletteFX")`: PaletteFX (the Gen 1/2
  // palette ramps) is not part of the gen3 port, so the require fails.
  Renderer.setUISize(Display.W, Display.H);
  const opts = (game && game.options) || {};
  Renderer.uiCentered = (opts.uiLayout !== "dynamic");
  Renderer.uiFill = false;
  Renderer.uiWorldHold = false;
  Renderer.battleDim = null;
  Renderer.extendedWorldBand = false;
  const [state, paper] = Display.surround(game, kind);
  Renderer.surroundState = state;
  Renderer.paperShade = paper;
  return Renderer;
}

// pocket-voxel: with `Display.world3d` set (platform/worldview.ts, each
// frame before the draw), the field is the 3DS host's voxel world, not
// pictures on the GBA screen. FieldView.draw then runs for its bookkeeping
// (the session's cell, the camera, Map.world, this frame's actors for the
// world's people) and draws nothing; the frame's undrawn pixels stay clear
// so the world shows through round the text boxes and menus. The view is
// the top screen's reach rather than the GBA's, so the people of the maps
// beside this one are collected as far as the world is seen.
const WORLD3D_VIEW_W = 400;
const WORLD3D_VIEW_H = 320;
const WORLD3D_OPTS = { world3d: true };

// Lua: display.lua:225
function drawFieldPlane(game: any, vw: number, vh: number, R: any): void {
  // package.loaded["src.core.game3.battle_transition"]: always loaded here
  const Transition: any = BattleTransition;
  const transitioning = Transition && Transition.isActive && Transition.isActive();
  Oam.resetFrame();
  const prev = Oam.setLayer("world");
  const exchange = (current: any, replacement: any): any => {
    return R && R.exchangeWorldCanvas(current, replacement);
  };
  if ((Display as any).world3d) {
    // pocket-voxel seam: the 3DS host draws the voxel world instead
    // (platform/worldview.ts); the field keeps its bookkeeping only.
    FieldView.draw(game, WORLD3D_VIEW_W, WORLD3D_VIEW_H, WORLD3D_OPTS);
  } else if (Tilt.active() && !transitioning && R && R.beginUprightPass) {
    FieldView.draw(game, vw, vh, { skipActors: true, exchangeCanvas: exchange });
    R.beginUprightPass();
    FieldView.draw(game, vw, vh, { actorsOnly: true, billboard: true });
    R.endUprightPass();
  } else {
    FieldView.draw(game, vw, vh, { exchangeCanvas: exchange });
  }
  Oam.setLayer(prev);
  Oam.animateSprites("world");
  Oam.buildOamBuffer();
  if (Bg.hasVisible()) {
    for (let pri = 3; pri >= 0; pri--) {
      Bg.flushPriority(pri);
      Oam.flushPriority(pri, "world");
    }
  } else {
    Oam.flush("world");
  }
}

let uiRenderer: (() => unknown) | null | undefined;
let uiPass: any;

// Lua: display.lua:263
function drawUiPass(): unknown {
  if (uiRenderer) return uiRenderer();
  if (uiPass == null) {
    // `pcall(require, "src.ui.game3.ui_pass")`: a lazily-required module,
    // registered in G3Lazy by its port (absent = Brian's failed-require path)
    uiPass = G3Lazy["src.ui.game3.ui_pass"] ?? false;
  }
  if (uiPass && typeof uiPass.drawUi === "function") uiPass.drawUi();
  return undefined;
}

// Lua: display.lua:273
function drawUiPlane(): void {
  const prev = Oam.setLayer("ui");
  drawUiPass();
  if (Help.isOpen()) Help.draw();
  Oam.setLayer(prev);
  Oam.animateSprites("ui");
  Oam.buildOamBuffer();
  Oam.flush("ui");
}

// Lua: display.lua:285
function presentPlanes(game: any): void {
  const battleActive = Battle.isActive();
  // package.loaded["src.ui.game3.stack"]: always loaded here
  const StackM: any = Stack;
  // package.loaded["src.core.game3.minigames.common"]: the wireless
  // minigames are not ported (no module), so it is never loaded.
  const MG: any = null;
  const mgRun = (MG != null && typeof MG === "object") ? MG._run : null;
  const minigameActive = !battleActive && mgRun != null && typeof mgRun === "object" && mgRun.stage !== "enter"
    && StackM != null && StackM.has != null && StackM.has("minigame");
  const uiOnly = minigameActive || (!battleActive && StackM != null
    && StackM.fullscreen != null && StackM.fullscreen());
  // package.loaded["src.ui.game3.shop_menu"]: always loaded here
  const Shop: any = ShopMenu;
  const shopView = !battleActive && !uiOnly && Shop != null
    && Shop.isShopCamera != null && Shop.isShopCamera();
  const R = prepareRenderer(game, battleActive ? "battle" : "field");
  R.beginFrame(!battleActive && !uiOnly && !shopView);

  if (battleActive) {
    G.push("all");
    G.origin();
    G.clear(0.06, 0.12, 0.20, 1);
    Oam.resetFrame();
    Battle.draw(game, Display.W, Display.H);
    drawUiPass();
    if (Help.isOpen()) Help.draw();
    Oam.animateSprites();
    Oam.buildOamBuffer();
    if (Bg.hasVisible()) {
      for (let pri = 3; pri >= 0; pri--) {
        Bg.flushPriority(pri);
        Oam.flushPriority(pri);
      }
    } else {
      Oam.flush();
    }
    G.pop();
    R.endFrame(null, null);
    Display.mirrorFlatFrame(R);
    return;
  }

  if (uiOnly || shopView) {
    G.push("all");
    G.origin();
    // pokeemerald/src/shop.c:781
    if (shopView) drawFieldPlane(game, Display.W, Display.H, null);
    drawUiPlane();
    G.pop();
    R.endFrame(null, null);
    Display.mirrorFlatFrame(R);
    return;
  }

  R.beginWorldPass();
  G.push("all");
  G.origin();
  const [vw, vh] = R.worldViewSize();
  drawFieldPlane(game, vw, vh, R);
  G.pop();
  // package.loaded["src.core.game3.battle_transition"]: always loaded here
  const Transition: any = BattleTransition;
  if (Transition && Transition.isActive && Transition.isActive()) {
    Transition.drawWorld(R.worldCanvas, vw, vh);
  }
  R.endWorldPass();

  G.push("all");
  G.origin();
  drawUiPlane();
  G.pop();
  R.endFrame(null, null);
  Display.mirrorFlatFrame(R);
}

// Lua: display.lua:392
function presentFlat(game: any, winW: number, winH: number): boolean {
  const canvas = Display.ensureCanvas("main");
  if (!canvas) return false;

  beginOn(canvas);
  let failed = false;
  let err: unknown;
  try {
    (() => {
      if (Help.isOpen()) { Help.draw(); return; }
      const world3d = !!(Display as any).world3d && !Battle.isActive();
      // (with the voxel world under the frame, the canvas stays clear)
      if (!world3d) G.clear(0.06, 0.12, 0.20, 1);

      Oam.resetFrame();

      if (Battle.isActive()) {
        Battle.draw(game, Display.W, Display.H);
      } else if (world3d) {
        FieldView.draw(game, WORLD3D_VIEW_W, WORLD3D_VIEW_H, WORLD3D_OPTS);
      } else {
        FieldView.draw(game, Display.W, Display.H);
      }

      drawUiPass();

      // Animate after UI so party can attach bounce callbacks this frame.
      Oam.animateSprites();
      Oam.buildOamBuffer();
      if (Bg.hasVisible()) {
        for (let pri = 3; pri >= 0; pri--) {
          Bg.flushPriority(pri);
          Oam.flushPriority(pri);
        }
      } else {
        Oam.flush();
      }
    })();
  } catch (e) {
    failed = true;
    err = e;
  }
  endCanvas();
  if (failed) {
    throw err;
  }

  // Void bars + blit our frame (game3 letterbox, not Gen2 Playfield).
  // (none over the voxel world: the frame's clear pixels must stay clear)
  if (!(Display as any).world3d) {
    G.setColor(0.02, 0.04, 0.08, 1);
    G.rectangle("fill", 0, 0, winW, winH);
  }
  const [scale, ox, oy, , , scaleY] = Display.fit(winW, winH);
  G.setColor(1, 1, 1, 1);
  G.draw(canvas, ox, oy, 0, scale, scaleY);
  return true;
}

// The functions of the Display table (its data fields are in display_table.ts).
const fns = {
  drawUiPass,

  presentFlat,

  /** The field plane (a local function in the Lua): the seam where the voxel world replaces the 2D field. */
  drawFieldPlane,

  // Lua: display.lua:21
  ensureCanvas(whichIn?: string | null): Canvas | null {
    const which = whichIn ?? "main";
    const key = which === "ui" ? "_uiOnly" : "_canvas";
    const existing = Display[key];
    if (existing) {
      let ok = true, cw = 0, ch = 0;
      try {
        cw = existing.getWidth();
        ch = existing.getHeight();
      } catch {
        ok = false;
      }
      if (ok && cw === Display.W && ch === Display.H) {
        return existing;
      }
    }
    let canvas: Canvas | null = null;
    try {
      canvas = G.newCanvas(Display.W, Display.H, { dpiscale: 1 });
    } catch {
      canvas = null;
    }
    if (!canvas) {
      log("FAILED canvas create");
      return null;
    }
    canvas.setFilter("nearest", "nearest");
    Display[key] = canvas;
    if (!Display._logged) {
      log("owned FRLG frame " + Display.W + "x" + Display.H
        + " (not Gen2 160x144)");
      Display._logged = true;
    }
    return canvas;
  },

  // Lua: display.lua:50
  fit(winWIn?: number | null, winHIn?: number | null): [number, number, number, number, number, number] {
    let gw = 0, gh = 0;
    [gw, gh] = G.getDimensions();
    const winW = winWIn ?? (gw > 0 ? gw : Display.W);
    const winH = winHIn ?? (gh > 0 ? gh : Display.H);

    let safeX = 0, safeY = 0, safeW = winW, safeH = winH;
    if (gw > 0 && gh > 0 && winW === gw && winH === gh) {
      // SafeArea.windowRect() returns nil (inert) or x, y, w, h
      const r = SafeArea.windowRect();
      const [sx, sy, sw, sh] = (r ?? []) as (number | undefined)[];
      if (sw != null && sw > 0 && sh != null && sh > 0) {
        safeX = sx!; safeY = sy!; safeW = sw; safeH = sh;
      }
    }

    let dpiX = 1, dpiY = 1;
    if (gw > 0 && gh > 0) {
      const [fw, fh] = G.getPixelDimensions();
      if (fw && fw > 0) dpiX = fw / gw;
      if (fh && fh > 0) dpiY = fh / gh;
    } else {
      const d = G.getDPIScale();
      if (d && d > 1e-6) { dpiX = d; dpiY = d; }
    }

    const isPortrait = safeH > safeW;
    let k: number, ox: number, oy: number, pw: number, ph: number, scaleX: number, scaleY: number;

    if (isPortrait) {
      // On mobile portrait, scale to fit the available safe width cleanly.
      k = Math.max(1, Math.floor(safeW * dpiX / Display.W + 1e-9));
      scaleX = k / dpiX; scaleY = k / dpiY;
      pw = Display.W * scaleX;
      ph = Display.H * scaleY;
      ox = safeX + (safeW - pw) * 0.5;
      // In portrait, center the screen in the upper deck area (above the touch controls deck).
      const topDeckH = safeH * 0.48;
      oy = safeY + Math.max(4, (topDeckH - ph) * 0.5);
    } else {
      // Landscape / desktop: fit cleanly within safe area
      k = Math.max(1, Math.floor(Math.min(safeW * dpiX / Display.W, safeH * dpiY / Display.H) + 1e-9));
      scaleX = k / dpiX; scaleY = k / dpiY;
      pw = Display.W * scaleX;
      ph = Display.H * scaleY;
      ox = safeX + (safeW - pw) * 0.5;
      oy = safeY + (safeH - ph) * 0.5;
    }
    ox = Math.floor(ox * dpiX + 1e-9) / dpiX;
    oy = Math.floor(oy * dpiY + 1e-9) / dpiY;

    return [scaleX, ox, oy, pw, ph, scaleY];
  },

  /** GBA-style compositor: for priority 3→0, draw BGs then OBJs at that priority.
   *  Lower priority number composites in front. Same priority: OBJ above BG.
   *  opts:
   *    animate (bool, default true) — run Oam.animateSprites
   *    build (bool, default true) — rebuild OAM buffer
   *    clear (r,g,b,a table) — clear before compose
   *    scissor {x,y,w,h} — WIN-style clip
   *    underlay function() — drawn behind all BG/OBJ (rare)
   *    overlay function() — drawn after all BG/OBJ (fades, blend approximates) */
  // Lua: display.lua:126
  composeHardware(optsIn?: ComposeOpts | null): void {
    const opts: ComposeOpts = optsIn ?? {};

    if (opts.clear != null) {
      const c = opts.clear;
      G.clear(c[1] ?? 0, c[2] ?? 0, c[3] ?? 0, c[4] ?? 1);
    }

    if (opts.underlay) {
      opts.underlay();
    }

    if (opts.animate !== false) {
      Oam.animateSprites();
    }
    if (opts.build !== false) {
      Oam.buildOamBuffer(opts.pretOrder);
    }

    if (opts.scissor) {
      const s = opts.scissor;
      G.setScissor(s.x, s.y, s.w, s.h);
    }

    // Back → front: pri 3,2,1,0. Within each: BG then OBJ.
    for (let pri = 3; pri >= 0; pri--) {
      Bg.flushPriority(pri);
      Oam.flushPriority(pri);
    }

    if (opts.scissor) {
      G.setScissor();
    }

    if (opts.overlay) {
      opts.overlay();
    }
  },

  // Lua: display.lua:167
  surround(_game: any, kind: string): [false, null] | [{ letterboxWhite: boolean }, () => [number, number, number]] {
    let paper: LuaTable | null = null;
    if (kind === "boot" || kind === "quest") {
      paper = seq(0, 0, 0);
    } else if (kind === "battle") {
      paper = seq(0.92, 0.94, 0.96);
    }
    if (!paper) return [false, null];
    const p = paper;
    return [{ letterboxWhite: true }, () => {
      return [p[1], p[2], p[3]];
    }];
  },

  // Lua: display.lua:205
  presentUi(game: any, _winW: number, _winH: number, kind: string, drawFn: () => void): boolean {
    if (Display.planesBroken) return false;
    let ok = true;
    let err: unknown;
    try {
      prepareRenderer(game, kind);
      Renderer.beginFrame(false);
      G.push("all");
      G.origin();
      G.setColor(1, 1, 1, 1);
      drawFn();
      G.pop();
      Renderer.endFrame(null, null);
    } catch (e) {
      ok = false;
      err = e;
    }
    if (ok) return true;
    G.setCanvas();
    Display.planesBroken = true;
    log("plane present failed, falling back: " + tostring(err));
    return false;
  },

  // Lua: display.lua:260
  setUiRenderer(fn: (() => unknown) | null | undefined): void {
    uiRenderer = fn;
  },

  // Lua: display.lua:365
  mirrorFlatFrame(R: any): void {
    if (!Display.mirrorForTests) return;
    const canvas = Display.ensureCanvas("main");
    if (!canvas) return;
    const world = R.worldCanvas;
    const ui = R.canvas;
    if (!ui) return;
    G.push("all");
    G.setCanvas(canvas);
    G.origin();
    G.setBlendMode("alpha");
    G.clear(0, 0, 0, 1);
    G.setColor(1, 1, 1, 1);
    if (world && R.worldActive) {
      let ok = true, vw = 0, vh = 0;
      try {
        vw = world.getWidth();
        vh = world.getHeight();
      } catch {
        ok = false;
      }
      if (ok && vw && vh) {
        G.draw(world,
          Math.floor((Display.W - vw) / 2), Math.floor((Display.H - vh) / 2));
      }
    }
    G.draw(ui, 0, 0);
    G.setCanvas();
    G.pop();
  },

  // Lua: display.lua:444
  present(game: any, winW: number, winH: number): boolean {
    // package.loaded["src.core.game3.asset_stream"]: always loaded here
    if (Stream) Stream.frameComplete();
    if (!Display.planesBroken) {
      let ok = true;
      let err: unknown;
      try {
        presentPlanes(game);
      } catch (e) {
        ok = false;
        err = e;
      }
      if (ok) return true;
      G.setCanvas();
      Display.planesBroken = true;
      log("plane present failed, falling back: " + tostring(err));
    }
    return presentFlat(game, winW, winH);
  },

  // Lua: display.lua:457
  release(): void {
    for (const [, key] of ipairs<"_canvas" | "_uiOnly">(seq("_canvas", "_uiOnly"))) {
      const canvas = Display[key];
      if (canvas) {
        try { canvas.release(); } catch { /* pcall */ }
        Display[key] = null;
      }
    }
    Display._logged = false;
  },
};

export type DisplayFns = typeof fns;
Object.assign(Display, fns);

export { Display };
export default Display;
