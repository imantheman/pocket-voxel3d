// Port of gen1recomp src/render/Tilt.lua (GPLv3 + additional terms; see LICENSE.md).
// Overworld tilt mode: a cycleable, purely presentational perspective tilt
// (OFF / 15 / 35 / 50 degrees), persisted via save.options.tilt. It lives
// entirely in the draw path.

import { Zoom } from "./Zoom.ts";
import { ipairs, seq } from "../../platform/lt.ts";
import { tonumber } from "../../../../import/gen3/lua.ts";

// Lua: Tilt.lua:36
function ease(t: number): number {
  return t * t * (3 - 2 * t);
}

// Lua: Tilt.lua:40
function goalFor(level: number): number {
  return (Tilt.ANGLES_DEG[level + 1] ?? 0) * Math.PI / 180;
}

export const Tilt = {
  ANGLES_DEG: [null, 0, 15, 35, 50] as (number | null)[],
  ANGLE_LABELS: [null, "OFF", "15", "35", "50"] as (string | null)[],

  level: 0,
  angle: 0,
  from: 0,
  goal: 0,
  t: 1,
  TARGET_ANGLE: 0,
  enabled: false,

  TWEEN_TIME: 0.25,
  FOCAL: 1.0,
  VIEW_MARGIN: 0.35,

  // Lua: Tilt.lua:44
  setLevel(levelIn: unknown): void {
    let level = Math.floor(tonumber(levelIn) ?? 0);
    if (level < 0) level = 0;
    if (level > 3) level = 3;
    const goal = goalFor(level);
    if (goal !== Tilt.goal || level !== Tilt.level) {
      Tilt.from = Tilt.angle;
      Tilt.goal = goal;
      Tilt.t = 0;
    }
    Tilt.level = level;
    Tilt.TARGET_ANGLE = goal;
    Tilt.enabled = level > 0;
  },

  // Lua: Tilt.lua:60
  cycle(): number {
    Tilt.setLevel((Tilt.level + 1) % 4);
    return Tilt.level;
  },

  // Lua: Tilt.lua:66
  toggle(): number {
    return Tilt.cycle();
  },

  // Lua: Tilt.lua:70
  reset(): void {
    Tilt.level = 0;
    Tilt.angle = 0;
    Tilt.from = 0;
    Tilt.goal = 0;
    Tilt.t = 1;
    Tilt.TARGET_ANGLE = 0;
    Tilt.enabled = false;
  },

  // Lua: Tilt.lua:80
  applyOptions(opts: any): void {
    let level = Math.floor(tonumber(opts ? opts.tilt : undefined) ?? 0);
    if (level < 0) level = 0;
    if (level > 3) level = 3;
    Tilt.level = level;
    Tilt.goal = goalFor(level);
    Tilt.from = Tilt.goal;
    Tilt.angle = Tilt.goal;
    Tilt.t = 1;
    Tilt.TARGET_ANGLE = Tilt.goal;
    Tilt.enabled = level > 0;
  },

  // Lua: Tilt.lua:93
  levelLabel(level?: number): string {
    return Tilt.ANGLE_LABELS[(level ?? Tilt.level) + 1] ?? "OFF";
  },

  // Lua: Tilt.lua:98
  update(dt: number): void {
    if (Tilt.t < 1) {
      Tilt.t = Math.min(1, Tilt.t + dt / Tilt.TWEEN_TIME);
      const e = ease(Tilt.t);
      Tilt.angle = Tilt.from + (Tilt.goal - Tilt.from) * e;
    } else {
      Tilt.angle = Tilt.goal;
    }
    Tilt.TARGET_ANGLE = Tilt.goal;
    Tilt.enabled = Tilt.level > 0;
  },

  // Lua: Tilt.lua:112
  active(): boolean {
    return Tilt.level > 0 || Tilt.angle > 0;
  },

  // Lua: Tilt.lua:116
  gateOK(top: unknown, overworld: unknown): any {
    return Zoom.gateOK(top, overworld);
  },

  // Lua: Tilt.lua:120 -- [sx, sy, scale]
  groundPoint(cx: number, cy: number, vw: number, vh: number): [number, number, number] {
    const a = Tilt.angle;
    if (a <= 0) return [cx, cy, 1];
    const u = cx - vw * 0.5;
    const w = cy - vh * 0.5;
    const d = Tilt.FOCAL * vh;
    const scale = d / (d - w * Math.sin(a));
    const sx = vw * 0.5 + u * scale;
    const sy = vh * 0.5 + w * Math.cos(a) * scale;
    return [sx, sy, scale];
  },

  // Lua: Tilt.lua:141
  onGround(fx: number, fy: number, vw?: number, vh?: number, margin?: number): boolean {
    const m = margin ?? 0;
    return fx >= -m && fx <= (vw ?? 0) + m
      && fy >= -m && fy <= (vh ?? 0) + m;
  },

  // Lua: Tilt.lua:147
  viewGrowth(): number {
    const a = Tilt.angle;
    if (a <= 0) return 1;
    const topScale = 1 / (1 + 0.5 * Math.sin(a) / Tilt.FOCAL);
    const base = 1 / (Math.cos(a) * topScale);
    return base + Tilt.VIEW_MARGIN * (base - 1);
  },

  // Lua: Tilt.lua:155
  meshCorners(vw: number, vh: number): ((number | null)[] | null)[] {
    const corners = seq(
      seq(0, 0, 0, 0),
      seq(vw, 0, 1, 0),
      seq(vw, vh, 1, 1),
      seq(0, vh, 0, 1),
    );
    const out: ((number | null)[] | null)[] = [null];
    for (const [i, c] of ipairs<(number | null)[]>(corners)) {
      const [sx, sy, scale] = Tilt.groundPoint(c[1]!, c[2]!, vw, vh);
      out[i] = seq(sx, sy, c[3]!, c[4]!, scale);
    }
    return out;
  },
};

export default Tilt;
