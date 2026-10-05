// Port of gen1recomp src/core/game3/rotating_gate.lua (GPLv3 + additional terms; see LICENSE.md).
// Rotating gate puzzles (pokeemerald/src/rotating_gate.c). FireRed has no
// puzzle maps (PUZZLE_MAPS are Emerald's), so on FRLG puzzleType() is nil and
// every entry point is a no-op; the logic is ported as Brian has it.
// `love` is always present here, so Brian's `love and love.image` guard is constant true.

import { mod, tonumber } from "../../../import/gen3/lua.ts";
import { ipairs, len, pairs, seq, type LuaTable } from "../platform/lt.ts";
import { luaLoad } from "../platform/luadata.ts";
import { G } from "../platform/graphics.ts";
import { newImageData, type Image } from "../platform/image.ts";
import { Runtime } from "./runtime.ts";
import { Dataset } from "./dataset.ts";
import { Flags } from "./scripting/flags.ts";
import { Space } from "./scripting/space.ts";
import { Constants } from "./constants.ts";
import { Collision } from "./collision.ts";
import { Player } from "./player.ts";
import { SE } from "./se_ids.ts";
import { Audio } from "./audio.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

// Lua: rotating_gate.lua:3
const CELL = 16;

// Lua: rotating_gate.lua:6 -- pokeemerald/src/rotating_gate.c:160
const ARM_NORTH = 0, ARM_WEST = 3;
const ARM_EAST = 1, ARM_SOUTH = 2;
const ROTATE_ANTICLOCKWISE = 1, ROTATE_CLOCKWISE = 2;
// (ROTATE_NONE = 0 is declared but unused)

export interface Rot { dir: number; arm: number; long: number }

// Lua: rotating_gate.lua:10
function rot(dir: number, arm: number, long: number): Rot { return { dir, arm, long }; }
// Lua: rotating_gate.lua:11
function cw(arm: number, long: number): Rot { return rot(ROTATE_CLOCKWISE, arm, long); }
// Lua: rotating_gate.lua:12
function acw(arm: number, long: number): Rot { return rot(ROTATE_ANTICLOCKWISE, arm, long); }
const N = false;

export interface GateAnim { from: number; dir: number; t: number; frames: number }
export interface GatePuzzle { kind: string; map: any; gates: LuaTable; anims: Record<number, GateAnim | undefined> }

// Lua: rotating_gate.lua:77
function session(): any {
  return Runtime && Runtime.getSession ? Runtime.getSession() ?? null : null;
}

// Lua: rotating_gate.lua:82
function mapId(): any {
  const s = session();
  return s ? s.map : s;
}

// Lua: rotating_gate.lua:103
const store: { get?: (id: number) => any; set?: (id: number, v: number) => any } = {};

// Lua: rotating_gate.lua:109
function varGet(id: number): number {
  if (store.get) return store.get(id);
  return tonumber(Flags.getVar(Space ? Space.store : undefined, null, id)) ?? 0;
}

// Lua: rotating_gate.lua:116
function varSet(id: number, v: number): any {
  if (store.set) return store.set(id, v);
  Flags.setVar(Space ? Space.store : undefined, null, id, v);
}

// Lua: rotating_gate.lua:123
function varTemp0(): number {
  try {
    const id = Constants.of(Constants.versionOf(session())).require("vars", "VAR_TEMP_0");
    return id ?? 0x4000;
  } catch {
    return 0x4000;
  }
}

// Lua: rotating_gate.lua:191
function collisionAt(x: number, y: number): boolean {
  if (Collision.inBounds && !Collision.inBounds(x, y)) return true;
  return !Collision.isWalkable(x, y);
}

// Lua: rotating_gate.lua:237
function playerFast(): boolean {
  const P: any = Player;
  return P != null && (P.running === true || P.biking === true);
}

// Lua: rotating_gate.lua:243 -- pokeemerald/src/rotating_gate.c:762
function startAnim(i: number, direction: number): void {
  const p = RotatingGate._p!;
  const from = RotatingGate.getOrientation(i);
  p.anims[i] = { from, dir: direction, t: 0, frames: playerFast() ? 8 : 16 };
  if (Audio && Audio.playSe && SE.SE_ROTATING_GATE) Audio.playSe(SE.SE_ROTATING_GATE);
}

// Lua: rotating_gate.lua:299
function image(sheet: any): Image | null {
  const img0 = RotatingGate._images[sheet.file];
  if (img0 != null) return img0 || null;
  const rgba = Dataset.cache().read("data/generated/gba/rotating_gates/" + sheet.file);
  if (!(rgba && rgba.length === sheet.w * sheet.h * 4)) {
    RotatingGate._images[sheet.file] = false;
    return null;
  }
  const img = G.newImage(newImageData(sheet.w, sheet.h, "rgba8", rgba));
  if ((img as any).setFilter) (img as any).setFilter("nearest", "nearest");
  RotatingGate._images[sheet.file] = img;
  return img;
}

// Lua: rotating_gate.lua:313
function sheetFor(shape: any): any {
  const m = RotatingGate.manifest();
  for (const [, s] of ipairs<any>(m ? m.sheets ?? {} : {})) {
    if (s.shape === shape) return s;
  }
  return null;
}

export const RotatingGate = {
  // Lua: rotating_gate.lua:8
  ROTATE_ANTICLOCKWISE,
  ROTATE_CLOCKWISE,

  // Lua: rotating_gate.lua:16 -- pokeemerald/src/rotating_gate.c:494
  ROTATION_INFO: {
    up: seq<Rot | false>(
      N, N, N, N,
      cw(ARM_WEST, 1), cw(ARM_WEST, 0), acw(ARM_EAST, 0), acw(ARM_EAST, 1),
      N, N, N, N,
      N, N, N, N,
    ),
    down: seq<Rot | false>(
      N, N, N, N,
      N, N, N, N,
      acw(ARM_WEST, 1), acw(ARM_WEST, 0), cw(ARM_EAST, 0), cw(ARM_EAST, 1),
      N, N, N, N,
    ),
    left: seq<Rot | false>(
      N, acw(ARM_NORTH, 1), N, N,
      N, acw(ARM_NORTH, 0), N, N,
      N, cw(ARM_SOUTH, 0), N, N,
      N, cw(ARM_SOUTH, 1), N, N,
    ),
    right: seq<Rot | false>(
      N, N, cw(ARM_NORTH, 1), N,
      N, N, cw(ARM_NORTH, 0), N,
      N, N, acw(ARM_SOUTH, 0), N,
      N, N, acw(ARM_SOUTH, 1), N,
    ),
  } as Record<string, (Rot | false | null)[]>,

  // Lua: rotating_gate.lua:44 -- pokeemerald/src/rotating_gate.c:528
  ARM_POS_CW: seq(
    seq(0, -1), seq(1, -2), seq(0, 0), seq(1, 0), seq(-1, 0), seq(-1, 1), seq(-1, -1), seq(-2, -1),
  ) as any[],
  ARM_POS_ACW: seq(
    seq(-1, -1), seq(-1, -2), seq(0, -1), seq(1, -1), seq(0, 0), seq(0, 1), seq(-1, 0), seq(-2, 0),
  ) as any[],

  // Lua: rotating_gate.lua:52 -- pokeemerald/src/rotating_gate.c:538 ([0] = first row)
  ARM_LAYOUT: {
    0: seq(1, 0, 1, 0, 0, 0, 0, 0),
    1: seq(1, 1, 1, 0, 0, 0, 0, 0),
    2: seq(1, 0, 1, 1, 0, 0, 0, 0),
    3: seq(1, 1, 1, 1, 0, 0, 0, 0),
    4: seq(1, 0, 1, 0, 1, 0, 0, 0),
    5: seq(1, 1, 1, 0, 1, 0, 0, 0),
    6: seq(1, 0, 1, 1, 1, 0, 0, 0),
    7: seq(1, 0, 1, 0, 1, 1, 0, 0),
    8: seq(1, 1, 1, 1, 1, 0, 0, 0),
    9: seq(1, 1, 1, 0, 1, 1, 0, 0),
    10: seq(1, 0, 1, 1, 1, 1, 0, 0),
    11: seq(1, 1, 1, 1, 1, 1, 0, 0),
  } as Record<number, (number | null)[]>,

  // Lua: rotating_gate.lua:68 -- pokeemerald/src/rotating_gate.c:625
  PUZZLE_MAPS: {
    EM_FORTREE_CITY_GYM: "fortree",
    EM_ROUTE110_TRICK_HOUSE_PUZZLE6: "trick_house",
  } as Record<string, string>,

  // Lua: rotating_gate.lua:73
  _p: null as GatePuzzle | null,
  _manifest: null as any,
  _images: {} as Record<string, Image | false>,

  // Lua: rotating_gate.lua:87
  manifest(): any {
    const m = RotatingGate._manifest;
    if (m != null) return m || null;
    const src = Dataset.cache().read("data/generated/gba/rotating_gates/manifest.lua");
    const chunk = src ? luaLoad(src, "@rotating_gates/manifest.lua")[0] : null;
    let ok = false;
    let t: any = null;
    if (chunk) {
      try { t = chunk(); ok = true; } catch { ok = false; }
    }
    RotatingGate._manifest = (ok && t != null && typeof t === "object") ? t : false;
    return RotatingGate._manifest || null;
  },

  // Lua: rotating_gate.lua:99 -- pokeemerald/src/rotating_gate.c:625
  puzzleType(id?: any): string | undefined {
    return RotatingGate.PUZZLE_MAPS[id ?? mapId() ?? ""];
  },

  // Lua: rotating_gate.lua:105
  setStore(getVar?: (id: number) => any, setVar?: (id: number, v: number) => any): void {
    store.get = getVar;
    store.set = setVar;
  },

  // Lua: rotating_gate.lua:132 -- pokeemerald/src/rotating_gate.c:651
  getOrientation(i: number): number {
    const v = varGet(varTemp0() + Math.floor(i / 2));
    if (mod(i, 2) === 0) return mod(v, 256);
    return mod(Math.floor(v / 256), 256);
  },

  // Lua: rotating_gate.lua:138
  setOrientation(i: number, o: number): void {
    const id = varTemp0() + Math.floor(i / 2);
    let v = varGet(id);
    if (mod(i, 2) === 0) {
      v = Math.floor(v / 256) * 256 + mod(o, 256);
    } else {
      v = mod(o, 256) * 256 + mod(v, 256);
    }
    varSet(id, v);
  },

  // Lua: rotating_gate.lua:150 -- pokeemerald/src/rotating_gate.c:680
  loadConfig(kind: string): GatePuzzle | null {
    const m = RotatingGate.manifest();
    const gates = m && m.puzzles ? m.puzzles[kind] : null;
    if (!gates) return null;
    RotatingGate._p = { kind, map: mapId(), gates, anims: {} };
    return RotatingGate._p;
  },

  // Lua: rotating_gate.lua:159 -- pokeemerald/src/rotating_gate.c:933
  initPuzzle(): boolean {
    const kind = RotatingGate.puzzleType();
    if (!kind) return false;
    const p = RotatingGate.loadConfig(kind);
    if (!p) return false;
    for (const [i, g] of ipairs<any>(p.gates)) RotatingGate.setOrientation(i - 1, g.orientation);
    return true;
  },

  // Lua: rotating_gate.lua:169 -- pokeemerald/src/rotating_gate.c:951
  initPuzzleAndGraphics(): boolean {
    const kind = RotatingGate.puzzleType();
    if (!kind) return false;
    return RotatingGate.loadConfig(kind) != null;
  },

  // Lua: rotating_gate.lua:175
  active(): boolean {
    const p = RotatingGate._p;
    if (!p) return false;
    if (p.map !== mapId()) {
      RotatingGate._p = null;
      return false;
    }
    return true;
  },

  // Lua: rotating_gate.lua:185
  reset(): void {
    RotatingGate._p = null;
    RotatingGate._images = {};
    RotatingGate._manifest = null;
  },

  // Lua: rotating_gate.lua:196
  collisionAt,

  // Lua: rotating_gate.lua:199 -- pokeemerald/src/rotating_gate.c:850
  canRotate(i: number, direction: number, blocked?: (x: number, y: number) => boolean): boolean {
    const p = RotatingGate._p!;
    const g = p.gates[i + 1];
    const arms = direction === ROTATE_ANTICLOCKWISE ? RotatingGate.ARM_POS_ACW : RotatingGate.ARM_POS_CW;
    if (direction !== ROTATE_ANTICLOCKWISE && direction !== ROTATE_CLOCKWISE) return false;
    const orientation = RotatingGate.getOrientation(i);
    const layout = RotatingGate.ARM_LAYOUT[g.shape];
    blocked = blocked ?? collisionAt;
    for (let arm = ARM_NORTH; arm <= ARM_WEST; arm++) {
      for (let j = 0; j <= 1; j++) {
        const idx = 2 * mod(orientation + arm, 4) + j;
        if (layout[2 * arm + j + 1] === 1) {
          const off = arms[idx + 1];
          if (blocked(g.x + off[1], g.y + off[2])) return false;
        }
      }
    }
    return true;
  },

  // Lua: rotating_gate.lua:220 -- pokeemerald/src/rotating_gate.c:895
  hasArm(i: number, arm: number, long: number): boolean {
    const g = RotatingGate._p!.gates[i + 1];
    const armOrientation = mod(arm - RotatingGate.getOrientation(i) + 4, 4);
    return RotatingGate.ARM_LAYOUT[g.shape][armOrientation * 2 + long + 1] === 1;
  },

  // Lua: rotating_gate.lua:227 -- pokeemerald/src/rotating_gate.c:661
  rotate(i: number, direction: number): void {
    let o = RotatingGate.getOrientation(i);
    if (direction === ROTATE_ANTICLOCKWISE) {
      o = o === 0 ? 3 : o - 1;
    } else {
      o = mod(o + 1, 4);
    }
    RotatingGate.setOrientation(i, o);
  },

  // Lua: rotating_gate.lua:253 -- pokeemerald/src/rotating_gate.c:961
  checkCollision(direction: string, x: number, y: number, noAnimation?: boolean,
    blocked?: (x: number, y: number) => boolean, quiet?: boolean): boolean {
    if (!RotatingGate.active()) return false;
    const p = RotatingGate._p!;
    const info = RotatingGate.ROTATION_INFO[direction];
    if (!info) return false;
    for (const [i, g] of ipairs<any>(p.gates)) {
      const gi = i - 1;
      if (g.x - 2 <= x && x <= g.x + 1 && g.y - 2 <= y && y <= g.y + 1) {
        const cx = x - g.x + 2, cy = y - g.y + 2;
        const r = info[cy * 4 + cx + 1];
        if (r && RotatingGate.hasArm(gi, r.arm, r.long)) {
          if (RotatingGate.canRotate(gi, r.dir, blocked)) {
            if (!noAnimation) {
              if (!quiet) startAnim(gi, r.dir);
              RotatingGate.rotate(gi, r.dir);
              return false;
            }
          } else {
            return true;
          }
        }
      }
    }
    return false;
  },

  // Lua: rotating_gate.lua:279
  step(): void {
    const p = RotatingGate._p;
    if (!p) return;
    for (const [i, a] of pairs<GateAnim>(p.anims)) {
      a.t = a.t + 1;
      if (a.t >= a.frames) delete p.anims[i as number];
    }
  },

  // Lua: rotating_gate.lua:289 -- pokeemerald/src/rotating_gate.c:305
  angle(i: number): number {
    const p = RotatingGate._p;
    const a = p ? p.anims[i] : null;
    const o = RotatingGate.getOrientation(i);
    if (!a) return o * 64;
    const from = a.from * 64;
    const delta = (a.dir === ROTATE_CLOCKWISE ? 64 : -64) * Math.min(a.t, a.frames) / a.frames;
    return from + delta;
  },

  // Lua: rotating_gate.lua:322 -- pokeemerald/src/rotating_gate.c:728
  collectActors(actors: LuaTable): void {
    if (!RotatingGate.active()) return;
    for (const [i, g] of ipairs<any>(RotatingGate._p!.gates)) {
      const sheet = sheetFor(g.shape);
      const img = sheet ? image(sheet) : null;
      if (img) {
        const ang = RotatingGate.angle(i - 1);
        const cx = g.x * CELL, cy = g.y * CELL;
        actors[len(actors) + 1] = {
          kind: "rotating_gate", elevation: 3, sortY: cy - CELL, x: cx, y: cy, i: 96000 + i,
          draw: (_self: any, camX: number, camY: number) => {
            G.setColor(1, 1, 1, 1);
            G.draw(img, cx - camX, cy - camY, ang * 2 * Math.PI / 256, 1, 1, sheet.w / 2, sheet.h / 2);
          },
        };
      }
    }
  },
};

export default RotatingGate;
