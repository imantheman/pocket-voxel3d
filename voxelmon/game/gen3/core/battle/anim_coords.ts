// Port of gen1recomp src/core/game3/battle/anim_coords.lua (GPLv3 + additional terms; see LICENSE.md).
// Battler coordinates, ids and sides for the battle animation engine
// (pokefirered battle_anim_mons.c sBattlerCoords, subpriorities, bg ranks).

import { tonumber } from "../../../../import/gen3/lua.ts";
import { len, ipairs, pairs, type LuaTable } from "../../platform/lt.ts";
import { Battle } from "./init.ts";

// A sequence ({a, b}); local so module-scope tables never call an import.
const lseq = (...xs: any[]): any[] => [null, ...xs];


export interface XY { x: number; y: number; [k: number]: number }

// Lua: anim_coords.lua:5
function xy(x: number, y: number): XY { return { x, y, 1: x, 2: y }; }

// Lua: anim_coords.lua:24
function battle_state(): any {
  // package.loaded["src.core.game3.battle"]
  const B: any = Battle;
  return B != null ? B._st : undefined;
}

// Lua: anim_coords.lua:220 -- SIDE_KEY_MT: "player"/"enemy" read and write the
// bound battler id's slot. A JS Proxy stands in for the metatable; rawget /
// rawset on an id key are plain `t[id]` (the Proxy only remaps the two names).
const SIDE_KEY_HANDLER: ProxyHandler<any> = {
  get(t, k, r) {
    if (k === "player" || k === "enemy") {
      if (Object.prototype.hasOwnProperty.call(t, k)) return t[k];
      const id = AnimCoords.idOf(k);
      return id == null ? undefined : t[id];
    }
    return Reflect.get(t, k, r);
  },
  set(t, k, v) {
    if (k === "player" || k === "enemy") {
      const id = AnimCoords.idOf(k);
      if (id != null) { t[id] = v; return true; }
    }
    t[k] = v;
    return true;
  },
};

export const AnimCoords: Record<string, any> = {
  // pokefirered/src/battle_anim_mons.c:31
  SINGLES: [xy(72, 80), xy(176, 40), xy(48, 40), xy(112, 80)] as XY[],
  DOUBLES: [xy(32, 80), xy(200, 40), xy(90, 88), xy(152, 32)] as XY[],

  // pokefirered/src/battle_anim_mons.c:1908
  SUBPRIORITY: [30, 40, 20, 50] as number[],

  // pokefirered/src/battle_anim_mons.c:1934
  BG_PRIORITY_RANK: [2, 1, 1, 2] as number[],

  DRAW_ORDER_SINGLES: lseq(1, 0),
  DRAW_ORDER_DOUBLES: lseq(3, 1, 0, 2),

  _double: null as boolean | null,
  _bind: null as LuaTable,
  _coordinateOverrides: null as LuaTable,

  battleState: battle_state,

  // Lua: anim_coords.lua:30
  setDouble(v: unknown): void {
    if (v == null) AnimCoords._double = null; else AnimCoords._double = v !== false;
  },

  // Lua: anim_coords.lua:34
  setCoordinateOverrides(overrides: LuaTable): LuaTable {
    const previous = AnimCoords._coordinateOverrides;
    AnimCoords._coordinateOverrides = overrides;
    return previous;
  },

  // Lua: anim_coords.lua:40
  isDouble(st?: any): boolean {
    if (AnimCoords._double != null) return AnimCoords._double;
    st = st ?? battle_state();
    return st != null && typeof st === "object" && st.double === true;
  },

  // Lua: anim_coords.lua:46
  sideOf(id: unknown): "player" | "enemy" {
    const n = tonumber(id) ?? 0;
    return (((n % 2) + 2) % 2 === 0) ? "player" : "enemy";
  },

  // Lua: anim_coords.lua:51
  partner(id: unknown): number {
    return (tonumber(id) ?? 0) ^ 2;
  },

  // Lua: anim_coords.lua:55
  fixedId(key: unknown): number | null {
    if (typeof key === "number") return key;
    if (key === "enemy") return 1;
    if (key === "player") return 0;
    return null;
  },

  // Lua: anim_coords.lua:62
  idOf(key: any): number | null {
    const t = typeof key;
    if (t === "number") {
      if (key >= 0 && key <= 3) return Math.floor(key);
      return null;
    }
    if (key === "player") {
      const b = AnimCoords._bind;
      return (b && b.player) ?? 0;
    }
    if (key === "enemy") {
      const b = AnimCoords._bind;
      return (b && b.enemy) ?? 1;
    }
    if (key != null && t === "object") {
      if (typeof key.id === "number") return key.id;
      if (key.side != null && key.side !== false) return AnimCoords.idOf(key.side);
    }
    return null;
  },

  // Lua: anim_coords.lua:83
  bind(atkId?: number | null, tgtId?: number | null): void {
    if (atkId == null) {
      AnimCoords._bind = null;
      return;
    }
    tgtId = tgtId ?? atkId;
    const b: any = {};
    b[AnimCoords.sideOf(tgtId)] = tgtId;
    b[AnimCoords.sideOf(atkId)] = atkId;
    if (b.player == null) b.player = 0;
    if (b.enemy == null) b.enemy = 1;
    AnimCoords._bind = b;
  },

  // Lua: anim_coords.lua:97 -- returns fn's results as a tuple (Lua multiple returns).
  withBattler(id: number, fn: (...a: any[]) => any, ...rest: any[]): any {
    const prev = AnimCoords._bind;
    const b: any = { player: (prev && prev.player) ?? 0, enemy: (prev && prev.enemy) ?? 1 };
    b[AnimCoords.sideOf(id)] = id;
    AnimCoords._bind = b;
    let r: any;
    try {
      r = fn(AnimCoords.sideOf(id), ...rest);
    } finally {
      AnimCoords._bind = prev;
    }
    return r;
  },

  // Lua: anim_coords.lua:108 -- idx is Brian's 1-based argument position.
  sideArg(fn: (...a: any[]) => any, idx: number): (...a: any[]) => any {
    return (...args: any[]) => {
      const v = args[idx - 1];
      if (typeof v !== "number" || v < 0 || v > 3) return fn(...args);
      return AnimCoords.withBattler(v, (side: string) => {
        args[idx - 1] = side;
        return fn(...args);
      });
    };
  },

  // Lua: anim_coords.lua:120
  coords(st: any, key: any): XY | null {
    const id = AnimCoords.idOf(key);
    if (id == null) return null;
    const override = AnimCoords._coordinateOverrides && AnimCoords._coordinateOverrides[id];
    if (override != null && override !== false) return override;
    const t = AnimCoords.isDouble(st) ? AnimCoords.DOUBLES : AnimCoords.SINGLES;
    return t[id] ?? null;
  },

  // Lua: anim_coords.lua:129
  subpriority(key: any): number {
    const id = AnimCoords.idOf(key);
    return AnimCoords.SUBPRIORITY[id ?? 1];
  },

  // Lua: anim_coords.lua:134
  bgPriorityRank(key: any): number {
    const id = AnimCoords.idOf(key);
    return AnimCoords.BG_PRIORITY_RANK[id ?? 1];
  },

  // Lua: anim_coords.lua:139
  battler(st: any, id: number | null | undefined): any {
    st = st ?? battle_state();
    if (st == null || typeof st !== "object" || id == null) return null;
    const bs = st.battlers;
    let b = bs != null ? bs[id] : null;
    if (b == null && id === 0) b = st.player;
    if (b == null && id === 1) b = st.enemy;
    return b;
  },

  // Lua: anim_coords.lua:149
  ids(st?: any): LuaTable {
    if (AnimCoords.isDouble(st)) return lseq(0, 1, 2, 3);
    return lseq(0, 1);
  },

  // Lua: anim_coords.lua:155 -- pokefirered/src/battle_anim_mons.c:841
  spritePresent(st: any, id: number | null | undefined): boolean {
    if (id == null) return false;
    st = st ?? battle_state();
    if (id >= 2 && !AnimCoords.isDouble(st)) return false;
    if (st == null || typeof st !== "object") return id < 2;
    if (st.absent && st.absent[id]) return false;
    const b = AnimCoords.battler(st, id);
    if (b == null || b === false) return id < 2;
    const mon = b.mon;
    if (mon && (tonumber(mon.hp) ?? 0) <= 0) return false;
    return true;
  },

  // Lua: anim_coords.lua:168
  monDrawOrder(st?: any): LuaTable {
    if (AnimCoords.isDouble(st)) return AnimCoords.DRAW_ORDER_DOUBLES;
    return AnimCoords.DRAW_ORDER_SINGLES;
  },

  // Lua: anim_coords.lua:173
  monBehindZ(key: any, st?: any): number {
    const id = AnimCoords.idOf(key) ?? 1;
    const order = AnimCoords.monDrawOrder(st);
    for (const [k, v] of ipairs(order)) {
      if (v === id) return (k - 1) * 100 + 95;
    }
    return 95;
  },

  // Lua: anim_coords.lua:182 -- returns [lo, hi]
  particleBand(k: number, st?: any): [number, number] {
    const n = len(AnimCoords.monDrawOrder(st));
    if (k <= 0) return [0, 99];
    if (k >= n) return [k * 100 + 1, 999];
    return [k * 100 + 1, k * 100 + 99];
  },

  // Lua: anim_coords.lua:190 -- pokefirered/src/battle_anim.c:630
  layerZ(subIn: unknown, monbg: LuaTable, bgPrio: LuaTable, st?: any): number {
    const sub = tonumber(subIn) ?? 0;
    const order = AnimCoords.monDrawOrder(st);
    let layer = 0;
    for (let k = len(order); k >= 1; k--) {
      const id = order[k];
      let front: boolean;
      if (monbg && monbg[id]) {
        front = ((bgPrio && bgPrio[AnimCoords.BG_PRIORITY_RANK[id]]) ?? 2) >= 2;
      } else {
        front = sub < AnimCoords.SUBPRIORITY[id];
      }
      if (front) {
        layer = k;
        break;
      }
    }
    const rank = Math.max(0, Math.min(98, 98 - sub));
    if (layer === 0) return rank;
    return layer * 100 + 1 + rank;
  },

  // Lua: anim_coords.lua:212
  zFor(priIn: unknown, subIn: unknown, vm?: any, st?: any): number {
    const pri = tonumber(priIn) ?? 2;
    const sub = tonumber(subIn) ?? 0;
    if (pri <= 1) return 900 + ((((255 - sub) % 99) + 99) % 99);
    if (pri >= 3) return Math.max(1, Math.min(98, 98 - sub));
    return AnimCoords.layerZ(sub, vm && vm._monbg, vm && vm._bgPrio, st);
  },

  // Lua: anim_coords.lua:231
  idTable(init?: LuaTable): LuaTable {
    const t = new Proxy({}, SIDE_KEY_HANDLER);
    if (init) {
      for (const [k, v] of pairs(init)) t[k] = v;
    }
    return t;
  },
};

export default AnimCoords;
