// Port of gen1recomp src/core/game3/ss_anne_cutscene.lua (GPLv3 + additional terms; see LICENSE.md).
// S.S. Anne departure cutscene matching pret pokefirered (src/ss_anne.c).
// Manages the ship's horn sound effects, wake trailing animation, smoke puffs,
// leftward sailing motion, and script coordination.
//
// Port notes:
// - Lazily required (field_view getMod, natives_cutscene): registers as
//   G3Lazy["src.core.game3.ss_anne_cutscene"].
// - package.loaded["src.core.game3.objects"] / pcall(require, audio): in the
//   bundle, static imports treated as loaded.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { G } from "../platform/graphics.ts";
import { insert, ipairs, len, seq, type LuaTable } from "../platform/lt.ts";
import { mod } from "../../../import/gen3/lua.ts";
// Audio constants (pokefirered/include/constants/songs.h:249)
import { SE } from "./se_ids.ts";
import { FieldEffects } from "./field_effects.ts";
import { Objects as ObjectsMod } from "./objects.ts";
import { Audio } from "./audio.ts";
import { G3Lazy } from "./lazy_registry.ts";

// Timing constants matching pokefirered/src/ss_anne.c
const INIT_FRAMES = 50;       // Task_SSAnneInit countdown
const SMOKE_INTERVAL = 70;    // Task_SSAnneRun smoke puff period
const SLIDE_SPEED_DIV = 5;    // 1 pixel movement every 5 frames (x = data[2] / 5)
const TRAVEL_DISTANCE = 216;  // pixels to travel until boat is fully off-screen
const FINISH_FRAMES = 40;     // Task_SSAnneFinish delay after exit horn

interface Wake { timer: number; x2: number; frame: number }
interface Smoke { timer: number; x2: number; frame: number; animEnded: boolean; boatOffsetAtSpawn: number }

// Lua: ss_anne_cutscene.lua:31
function playSe(id: number): void {
  const ad = SSAnneCutscene._adapters;
  if (ad && ad.playSe) {
    try { ad.playSe(id); } catch { /* pcall */ }
    return;
  }
  // pcall(require, "src.core.game3.audio")
  const A: any = Audio;
  if (A && A.playSe) {
    try { A.playSe(id); } catch { /* pcall */ }
  }
}

// Lua: ss_anne_cutscene.lua:43
function loadGfx(): void {
  if (!SSAnneCutscene._wakeImage) {
    const sheet = FieldEffects.loadSheet("ss_anne_wake", 16, 32, 2);
    if (sheet) {
      SSAnneCutscene._wakeImage = sheet.image;
      SSAnneCutscene._wakeQuads = sheet.quads;
    }
  }
  if (!SSAnneCutscene._smokeImage) {
    const sheet = FieldEffects.loadSheet("ss_anne_smoke", 16, 16, 4);
    if (sheet) {
      SSAnneCutscene._smokeImage = sheet.image;
      SSAnneCutscene._smokeQuads = sheet.quads;
    }
  }
}

// package.loaded["src.core.game3.objects"]: Objects.find(1)
function boat(): any {
  const O: any = ObjectsMod;
  return O && O.find && O.find(1);
}

export const SSAnneCutscene = {
  _active: false,
  _phase: "idle", // "init" | "run" | "finish" | "done"
  _initTimer: 0,
  _runTimer1: 0, // smoke timer
  _runTimer2: 0, // motion timer
  _finishTimer: 0,
  _boatOffset: 0,
  _wake: undefined as Wake | undefined,
  _smokes: seq() as LuaTable,
  _wakeImage: undefined as any,
  _wakeQuads: undefined as any,
  _smokeImage: undefined as any,
  _smokeQuads: undefined as any,
  _adapters: undefined as any,

  // Lua: ss_anne_cutscene.lua:61
  isActive(): boolean {
    return SSAnneCutscene._active;
  },

  // Lua: ss_anne_cutscene.lua:65
  reset(): void {
    SSAnneCutscene._active = false;
    SSAnneCutscene._phase = "idle";
    SSAnneCutscene._initTimer = 0;
    SSAnneCutscene._runTimer1 = 0;
    SSAnneCutscene._runTimer2 = 0;
    SSAnneCutscene._finishTimer = 0;
    SSAnneCutscene._boatOffset = 0;
    SSAnneCutscene._wake = undefined;
    SSAnneCutscene._smokes = seq();
  },

  // Lua: ss_anne_cutscene.lua:78
  /** pokefirered/src/ss_anne.c:82 DoSSAnneDepartureCutscene */
  start(_ctx: any, adapters: any): () => boolean {
    SSAnneCutscene.reset();
    SSAnneCutscene._adapters = adapters;
    SSAnneCutscene._active = true;
    SSAnneCutscene._phase = "init";
    SSAnneCutscene._initTimer = INIT_FRAMES;

    // Initial horn sound
    playSe(SE.SE_SS_ANNE_HORN);

    loadGfx();

    return () => SSAnneCutscene.step();
  },

  // Lua: ss_anne_cutscene.lua:96
  /** Ticked each frame during waitstate. Returns true when cutscene is fully finished. */
  step(): boolean {
    if (!SSAnneCutscene._active) return true;

    const eo = boat();

    if (SSAnneCutscene._phase === "init") {
      SSAnneCutscene._initTimer = SSAnneCutscene._initTimer - 1;
      if (SSAnneCutscene._initTimer <= 0) {
        // Task_SSAnneInit finishes: creates wake sprite and switches to Task_SSAnneRun
        SSAnneCutscene._phase = "run";
        SSAnneCutscene._wake = {
          timer: 0,
          x2: 0,
          frame: 0,
        };
      }
      return false;
    }

    if (SSAnneCutscene._phase === "run") {
      SSAnneCutscene._runTimer1 = SSAnneCutscene._runTimer1 + 1;
      SSAnneCutscene._runTimer2 = SSAnneCutscene._runTimer2 + 1;

      // Smoke puff creation every 70 frames
      if (SSAnneCutscene._runTimer1 === SMOKE_INTERVAL) {
        SSAnneCutscene._runTimer1 = 0;
        insert(SSAnneCutscene._smokes, {
          timer: 0,
          x2: 0,
          frame: 0,
          animEnded: false,
          boatOffsetAtSpawn: SSAnneCutscene._boatOffset,
        });
      }

      // Boat movement: x = data[2] / 5 (1 pixel every 5 frames)
      SSAnneCutscene._boatOffset = Math.floor(SSAnneCutscene._runTimer2 / SLIDE_SPEED_DIV);
      if (eo) {
        eo.raiseX = -SSAnneCutscene._boatOffset;
      }

      // Update wake sprite
      if (SSAnneCutscene._wake) {
        const w = SSAnneCutscene._wake;
        if (Math.floor(w.timer / 6) < 22) {
          w.timer = w.timer + 1;
        }
        w.x2 = Math.floor(w.timer / 6);
        // 12 ticks per frame, looping between frame 0 and frame 1
        w.frame = (mod(Math.floor(w.timer / 12), 2) === 0) ? 0 : 1;
      }

      // Update smoke sprites
      const activeSmokes: LuaTable = seq();
      for (const [, s] of ipairs(SSAnneCutscene._smokes)) {
        s.timer = s.timer + 1;
        s.x2 = Math.floor(s.timer / 4);
        if (s.timer < 10) {
          s.frame = 0;
        } else if (s.timer < 30) {
          s.frame = 1;
        } else if (s.timer < 50) {
          s.frame = 2;
        } else if (s.timer < 80) {
          s.frame = 3;
        } else {
          s.animEnded = true;
        }
        if (!s.animEnded) {
          activeSmokes[len(activeSmokes) + 1] = s;
        }
      }
      SSAnneCutscene._smokes = activeSmokes;

      // Exit check: when boat moves completely off-screen
      if (SSAnneCutscene._boatOffset >= TRAVEL_DISTANCE) {
        // Final horn sound
        playSe(SE.SE_SS_ANNE_HORN);
        SSAnneCutscene._phase = "finish";
        SSAnneCutscene._finishTimer = 0;
      }
      return false;
    }

    if (SSAnneCutscene._phase === "finish") {
      SSAnneCutscene._finishTimer = SSAnneCutscene._finishTimer + 1;
      if (SSAnneCutscene._finishTimer >= FINISH_FRAMES) {
        // Task_SSAnneFinish complete: clean up and unblock script
        SSAnneCutscene._active = false;
        SSAnneCutscene._phase = "done";
        if (eo) {
          eo.raiseX = 0;
        }
        return true;
      }
      return false;
    }

    return true;
  },

  // Lua: ss_anne_cutscene.lua:199
  /** Draw wake under boat actors (pret oam.priority = 2, subpriority = 0xFF). */
  drawWake(camX: number, camY: number): void {
    if (!SSAnneCutscene._active) return;
    if (!(SSAnneCutscene._wake && SSAnneCutscene._wakeImage && SSAnneCutscene._wakeQuads)) return;

    const eo = boat();
    if (!eo) return;

    const curBoatPx = (eo.px ?? (eo.cellX * 16)) - SSAnneCutscene._boatOffset;
    const boatPy = eo.py ?? (eo.cellY * 16);
    const boatLeft = curBoatPx - camX - 56;
    const boatTop = boatPy - camY - 48;

    const w = SSAnneCutscene._wake;
    const q = SSAnneCutscene._wakeQuads[w.frame || 0];
    if (q) {
      const wx = boatLeft + 106 + (w.x2 || 0);
      const wy = boatTop + 24;
      G.setColor(1, 1, 1, 1);
      G.draw(SSAnneCutscene._wakeImage, q, wx, wy);
    }
  },

  // Lua: ss_anne_cutscene.lua:223
  /** Draw smoke puffs rising from smokestack in overlay space (pret oam.priority = 0). */
  drawSmoke(camX: number, camY: number): void {
    if (!SSAnneCutscene._active) return;
    if (!(SSAnneCutscene._smokeImage && SSAnneCutscene._smokeQuads && len(SSAnneCutscene._smokes) > 0)) return;

    const eo = boat();
    if (!eo) return;

    const boatPy = eo.py ?? (eo.cellY * 16);
    const boatTop = boatPy - camY - 48;

    for (const [, s] of ipairs(SSAnneCutscene._smokes)) {
      const q = SSAnneCutscene._smokeQuads[s.frame || 0];
      if (q) {
        const spawnBoatLeft = (eo.px ?? (eo.cellX * 16)) - s.boatOffsetAtSpawn - camX - 56;
        const sx = spawnBoatLeft + 78 + (s.x2 || 0);
        const sy = boatTop + 2;
        G.setColor(1, 1, 1, 1);
        G.draw(SSAnneCutscene._smokeImage, q, sx, sy);
      }
    }
  },

  // Lua: ss_anne_cutscene.lua:247
  /** Draw wake and smoke overlay particles in world/screen space. */
  draw(camX: number, camY: number): void {
    SSAnneCutscene.drawWake(camX, camY);
    SSAnneCutscene.drawSmoke(camX, camY);
  },
};

G3Lazy["src.core.game3.ss_anne_cutscene"] = SSAnneCutscene;

export default SSAnneCutscene;
