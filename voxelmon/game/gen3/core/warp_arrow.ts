// Port of gen1recomp src/core/game3/warp_arrow.lua (GPLv3 + additional terms; see LICENSE.md).
// The arrow-warp field effect shown in front of the player on an arrow-warp
// tile (doormats that warp when walked off).
//
// Port notes: package.loaded / require of field_effects and collision become
// static imports (every module is in the bundle, so "loaded" is always yes).

import { G } from "../platform/graphics.ts";
import { seq, len, ipairs, type LuaTable } from "../platform/lt.ts";
import { tonumber } from "../../../import/gen3/lua.ts";
import FieldEffects from "./field_effects.ts";
import CollisionMod from "./collision.ts";

const CELL = 16;
const ANIM_INDEX: Record<string, number> = { down: 1, up: 2, left: 3, right: 4 };
const DELTA: Record<string, LuaTable> = { down: seq(0, 1), up: seq(0, -1), left: seq(-1, 0), right: seq(1, 0) };

// pokefirered/src/data/field_effects/field_effect_objects.h:241
const FRLG_ANIMS: LuaTable = seq(
  seq(seq(2, 32), seq(3, 32)),
  seq(seq(0, 32), seq(1, 32)),
  seq(seq(4, 32), seq(5, 32)),
  seq(seq(6, 32), seq(7, 32)),
);

export interface WarpArrowState {
  visible: boolean;
  cx?: number;
  cy?: number;
  /** Sequence of { frame, duration } sequences. */
  seq?: LuaTable;
  step?: number;
  timer?: number;
}

// Lua: warp_arrow.lua:17
function FE(): any {
  return FieldEffects;
}

// Lua: warp_arrow.lua:21
function Collision(): any {
  return CollisionMod;
}

// Lua: warp_arrow.lua:25
function sequence(idx: number): LuaTable | undefined {
  const fe = FE();
  if (!fe.manifest()) return FRLG_ANIMS[idx];
  const o = fe.manifestObject("arrow");
  const out: LuaTable = [null];
  for (const [, c] of ipairs<LuaTable>((o && o.anims && o.anims[idx]) || [null])) {
    if (c[1] === "frame") out[len(out) + 1] = seq(tonumber(c[2]) ?? 0, Math.max(1, tonumber(c[3]) ?? 1));
  }
  return len(out) > 0 ? out : undefined;
}

export const WarpArrow = {
  _state: { visible: false } as WarpArrowState,

  // Lua: warp_arrow.lua:36
  hide(): void {
    WarpArrow._state.visible = false;
  },

  // Lua: warp_arrow.lua:41
  // pokeemerald/src/field_effect_helpers.c:193
  show(dir: string, cx: number, cy: number): void {
    const s = WarpArrow._state;
    if (s.visible && s.cx === cx && s.cy === cy) return;
    s.visible = true; s.cx = cx; s.cy = cy;
    s.seq = sequence(ANIM_INDEX[dir]);
    s.step = 1; s.timer = 0;
  },

  // Lua: warp_arrow.lua:50
  // pokeemerald/src/field_player_avatar.c:1445
  update(P: any): void {
    const C = Collision();
    if (!(C && C.behavior && C.arrowWarpDir)) return WarpArrow.hide();
    let cx = P.cellX, cy = P.cellY;
    if (P.moving) { cx = P.targetX; cy = P.targetY; }
    const dir: string = P.facingLocked ? P.moveDir : P.facing;
    const arrowDir = C.arrowWarpDir(C.behavior(cx, cy));
    const d = Object.prototype.hasOwnProperty.call(DELTA, dir) ? DELTA[dir] : undefined;
    if (arrowDir == null || arrowDir !== dir || !d) return WarpArrow.hide();
    WarpArrow.show(dir, cx + d[1], cy + d[2]);
  },

  // Lua: warp_arrow.lua:62
  step(): void {
    const s = WarpArrow._state;
    if (!(s.visible && s.seq)) return;
    s.timer = s.timer! + 1;
    if (s.timer >= s.seq[s.step!][2]) {
      s.timer = 0;
      s.step = (s.step! % len(s.seq)) + 1;
    }
  },

  // Lua: warp_arrow.lua:72
  draw(camX: number, camY: number): void {
    const s = WarpArrow._state;
    if (!(s.visible && s.seq)) return;
    const sheet = FE().loadSheet("arrow", 16, 16, 8);
    const q = sheet && sheet.quads[s.seq[s.step!][1]];
    if (!q) return;
    G.setColor(1, 1, 1, 1);
    G.draw(sheet.image, q, s.cx! * CELL - camX, s.cy! * CELL - camY);
  },
};

export default WarpArrow;
