// Port of gen1recomp src/ui/game3/fade.lua (GPLv3 + additional terms; see LICENSE.md).
// FRLG-style screen fade overlay for game3 (boot, field adapters, Oak).
// Modes match pret include/constants/field_weather.h (fadescreen operand):
//   FADE_FROM_BLACK=0, FADE_TO_BLACK=1, FADE_FROM_WHITE=2, FADE_TO_WHITE=3

import { tonumber } from "../../../import/gen3/lua.ts";
import { G } from "../platform/graphics.ts";
import { Display } from "../core/display.ts";
import { Renderer } from "../shared/render/Renderer.ts";

const MODE = {
  FROM_BLACK: 0, // pret FADE_FROM_BLACK
  TO_BLACK: 1, // pret FADE_TO_BLACK
  FROM_WHITE: 2, // pret FADE_FROM_WHITE
  TO_WHITE: 3, // pret FADE_TO_WHITE
};

// Lua: fade.lua:25
function targetColor(mode: number): [number, number, number] {
  if (mode === MODE.TO_WHITE || mode === MODE.FROM_WHITE) {
    return [1, 1, 1];
  }
  return [0, 0, 0];
}

// `pcall(require, "src.render.Renderer")`: the module is always present here.
const R = Renderer as Record<string, any>;

/** A module table in Lua (Fade.x / Fade:_finish), kept as a class with static state. */
export class Fade {
  static active = false;
  static mode = 0;
  static speed = 1; // palette steps per frame (pret speed)
  static t = 0; // 0..16 blend strength toward target
  static doneCb: (() => void) | undefined = undefined;
  static _dir = 1; // +1 toward cover, -1 toward clear
  static _accum: number | undefined = undefined;
  static lockInput: unknown = undefined;
  static MODE = MODE;
  /** pocket-voxel: the veil draw() put over the screen this frame (r, g, b,
   *  a), or null; cleared before each frame by platform/game3_world.ts, which
   *  carries it to the voxel world's edges beyond the 2D layer. */
  static shown: [number, number, number, number] | null = null;

  /**
   * Start a fade. done() called when complete.
   * speed: frames per step of 16 (default 1 → ~16 frames).
   */
  // Lua: fade.lua:34
  static begin(modeIn: unknown, speedIn?: unknown, done?: () => void): void {
    const mode = tonumber(modeIn) ?? 0;
    const speed = Math.max(1, tonumber(speedIn) ?? 1);
    Fade.active = true;
    Fade.mode = mode;
    Fade.speed = speed;
    Fade.doneCb = done;
    Fade._accum = 0;
    if (mode === MODE.FROM_BLACK || mode === MODE.FROM_WHITE) {
      Fade.t = 16;
      Fade._dir = -1;
    } else {
      Fade.t = 0;
      Fade._dir = 1;
    }
  }

  // Lua: fade.lua:51
  static isActive(): boolean {
    return Fade.active;
  }

  // Lua: fade.lua:55
  static tick(dt?: number): boolean {
    if (!Fade.active) return false;
    // Frame-based: one step every `speed` frames at 60Hz.
    const frames = (dt ?? 1 / 60) * 60;
    Fade._accum = (Fade._accum ?? 0) + frames;
    while (Fade._accum >= Fade.speed) {
      Fade._accum = Fade._accum - Fade.speed;
      Fade.t = Fade.t + Fade._dir;
      if (Fade._dir > 0 && Fade.t >= 16) {
        Fade.t = 16;
        Fade._finish();
        return true;
      } else if (Fade._dir < 0 && Fade.t <= 0) {
        Fade.t = 0;
        Fade._finish();
        return true;
      }
    }
    return false;
  }

  // Lua: fade.lua:76 (Fade:_finish -- called with Fade as self; it uses only Fade)
  static _finish(): void {
    Fade.active = false;
    Fade.lockInput = undefined;
    const cb = Fade.doneCb;
    Fade.doneCb = undefined;
    if ((Fade.t ?? 0) <= 0) {
      if (R) {
        R.screenVeil = undefined;
      }
    }
    if (cb) cb();
  }

  // Lua: fade.lua:90
  static draw(): void {
    if (!Fade.active && (Fade.t ?? 0) <= 0) {
      if (R) R.screenVeil = undefined;
      return;
    }
    const a = (Fade.t ?? 0) / 16;
    if (a <= 0) {
      if (R) R.screenVeil = undefined;
      return;
    }
    const [r, g, b] = targetColor(Fade.mode);

    if (R && R.canvas) {
      R.screenVeil = [null, r, g, b, a];
      return;
    }

    G.setColor(r, g, b, a);
    Fade.shown = [r, g, b, a];
    let w: number = Display.W, h: number = Display.H;
    const curCanvas = G.getCanvas();
    if (curCanvas) {
      w = curCanvas.getWidth();
      h = curCanvas.getHeight();
    } else {
      const [gw, gh] = G.getDimensions();
      if (gw && gh && gw > 0 && gh > 0) { w = gw; h = gh; }
    }
    G.rectangle("fill", 0, 0, w, h);
    G.setColor(1, 1, 1, 1);
  }

  /** Instant clear (no anim). */
  // Lua: fade.lua:126
  static clear(): void {
    Fade.lockInput = undefined;
    Fade.active = false;
    Fade.t = 0;
    Fade.doneCb = undefined;
    if (R) {
      R.screenVeil = undefined;
    }
  }
}

export default Fade;
