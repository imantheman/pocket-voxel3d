// Port of gen1recomp src/core/game3/pc_anim.lua (GPLv3 + additional terms; see LICENSE.md).
// pokefirered/src/field_specials.c:212 -- the PC screen flicker when the
// player turns a PC on or off.
//
// Port notes: require / package.loaded / pcall(require) of player, map,
// tileset_native, field and scripting.flags become static imports (every
// module is in the bundle). METATILE_OFF/ON keep the Lua keys 0..2 as array
// indices.

import { tonumber } from "../../../import/gen3/lua.ts";
import Flags from "./scripting/flags.ts";
import Player from "./player.ts";
import MapMod from "./map.ts";
import NativeTileset from "./tileset_native.ts";
import Field from "./field.ts";

export interface PcAnimTask { state: number; timer: number; ctx: any }
export type PcAnimSetter = (x: number, y: number, mid: number, impassable: boolean) => void;

// Lua: pc_anim.lua:9
function var8004(ctx: any): number {
  return tonumber(Flags.getVar(null, ctx, 0x8004)) ?? 0;
}

// Lua: pc_anim.lua:15
// pokefirered/src/field_specials.c:249
function target(): [number, number] {
  const P = Player;
  let dx = 0, dy = 0;
  if (P.facing === "up") {
    dx = 0; dy = -1;
  } else if (P.facing === "left") {
    dx = -1; dy = -1;
  } else if (P.facing === "right") {
    dx = 1; dy = -1;
  }
  return [(tonumber(P.cellX) ?? 0) + dx, (tonumber(P.cellY) ?? 0) + dy];
}

// Lua: pc_anim.lua:44
function set_mid(mid: number): void {
  const [x, y] = target();
  if (PcAnim._set) {
    PcAnim._set(x, y, mid, true);
    return;
  }
  if (!PcAnim.drawable(mid)) return;
  Field.setMetatile(x, y, mid, true);
}

export const PcAnim = {
  task: undefined as PcAnimTask | undefined,
  _set: undefined as PcAnimSetter | undefined,

  METATILE_OFF: [0x062, 0x28F, 0x28F] as number[], // pokefirered/include/constants/metatile_labels.h:5
  METATILE_ON: [0x063, 0x28A, 0x28A] as number[], // pokefirered/include/constants/metatile_labels.h:74

  // Lua: pc_anim.lua:28
  setter(fn: PcAnimSetter | undefined): void {
    PcAnim._set = fn;
  },

  // Lua: pc_anim.lua:32
  drawable(mid: number): boolean {
    // package.loaded["src.core.game3.map"]
    const Map: any = MapMod;
    const def = Map && Map.currentDef && Map.currentDef();
    const pair = def && (def.pair || (def.midLayout && def.midLayout.pair));
    // pcall(require, "src.core.game3.tileset_native"): always present
    const okN = true;
    if (!(pair && okN && NativeTileset && NativeTileset.ready && NativeTileset.ready(pair))) {
      return true;
    }
    const ts: any = NativeTileset.get(pair);
    return !(ts && ts.midToSlot) || ts.midToSlot[mid] != null;
  },

  // Lua: pc_anim.lua:55
  turnOn(ctx: any): void {
    PcAnim.task = { state: 0, timer: 0, ctx };
  },

  // Lua: pc_anim.lua:60
  // pokefirered/src/field_specials.c:225
  update(): void {
    const t = PcAnim.task;
    if (!t) return;
    if (t.timer >= 6) {
      const v = var8004(t.ctx);
      const flickerOff = (t.state % 2) === 1;
      const offTile = PcAnim.METATILE_OFF[v];
      const onTile = PcAnim.METATILE_ON[v];
      if (offTile == null || onTile == null) {
        PcAnim.task = undefined;
        return;
      }
      set_mid(flickerOff ? offTile : onTile);
      t.timer = 0;
      t.state = t.state + 1;
      if (t.state >= 5) {
        PcAnim.task = undefined;
        return;
      }
    }
    t.timer = t.timer + 1;
  },

  // Lua: pc_anim.lua:84
  // pokefirered/src/field_specials.c:286
  turnOff(ctx?: any): void {
    const t = PcAnim.task;
    const effectiveCtx = ctx || (t && t.ctx);
    PcAnim.task = undefined;
    set_mid(PcAnim.METATILE_OFF[var8004(effectiveCtx)] ?? 0);
  },

  // Lua: pc_anim.lua:91
  reset(): void {
    PcAnim.task = undefined;
  },
};

export default PcAnim;
