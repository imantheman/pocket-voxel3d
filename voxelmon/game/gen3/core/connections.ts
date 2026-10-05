// Port of gen1recomp src/core/game3/connections.lua (GPLv3 + additional terms; see LICENSE.md).
// Map connections: a def's `connections` (a sequence of { dir, map, offset }
// rows from the cache, and/or string-keyed { north = {...} } entries) as one
// ordered list, plus pret's connection geometry. Lists are Lua sequences.

import { len, pairs, ipairs, sort, insert, type LuaTable } from "../platform/lt.ts";
import { tonumber } from "../../../import/gen3/lua.ts";

export type Dir = "north" | "south" | "west" | "east";

export interface ConnEntry { dir: Dir; map: string; offset: number }

/** A connected neighbour (Map.neighborList rows carry these fields). */
export interface Neighbor { dir: string; offset?: unknown; def?: any; map?: string; mapId?: string }

const CARDINAL: Record<string, Dir> = {
  north: "north", south: "south", west: "west", east: "east",
  up: "north", down: "south", left: "west", right: "east",
};

// Lua: connections.lua:12
function entry(dir: unknown, c: any): ConnEntry | undefined {
  const d = typeof dir === "string" ? CARDINAL[dir] : undefined;
  const map = c !== null && typeof c === "object" ? (c.map ?? c.mapId) : c;
  if (!d || typeof map !== "string") return undefined;
  return { dir: d, map, offset: c !== null && typeof c === "object" ? tonumber(c.offset) as number : 0 };
}

// Lua: connections.lua:47
function vertical(dir: string): boolean {
  return dir === "north" || dir === "south";
}

// Lua: connections.lua:52 -- pokefirered/src/fieldmap.c:724
function coordInIncoming(coord: number, srcMaxIn: number, destMax: number, offset: number): boolean {
  let srcMax = srcMaxIn;
  const lo = Math.max(offset, 0);
  if (destMax + offset < srcMax) srcMax = destMax + offset;
  return lo <= coord && coord <= srcMax;
}

export const Connections = {
  // Lua: connections.lua:8
  cardinal(dir: unknown): Dir | undefined {
    return typeof dir === "string" ? CARDINAL[dir] : undefined;
  },

  // Lua: connections.lua:19
  each(def: any): LuaTable {
    const out: LuaTable = [null];
    const conns = def && def.connections;
    if (conns === null || typeof conns !== "object") return out;
    const n = len(conns);
    for (let i = 1; i <= n; i++) {
      const c = conns[i];
      const e = c !== null && typeof c === "object" ? entry(c.dir ?? c.direction, c) : undefined;
      if (e) out[len(out) + 1] = e;
    }
    const keyed: LuaTable = [null];
    for (const [k, c] of pairs(conns)) {
      if (typeof k === "string") {
        const e = entry(k, c);
        if (e) keyed[len(keyed) + 1] = { k, e };
      }
    }
    sort<{ k: string; e: ConnEntry }>(keyed, (a, b) => a.k < b.k);
    for (const [, kv] of ipairs<{ k: string; e: ConnEntry }>(keyed)) insert(out, kv.e);
    return out;
  },

  // Lua: connections.lua:41 -- [w, h]
  sizeOf(def: any): [number, number] {
    const L = def && def.midLayout;
    if (L && L.width != null && L.height != null) return [L.width, L.height];
    return [(tonumber(def && def.width) ?? 0) * 2, (tonumber(def && def.height) ?? 0) * 2];
  },

  // Lua: connections.lua:59 -- pokefirered/src/fieldmap.c:686; [conn, destDef] or []
  incoming(def: any, dirIn: unknown, x: number, y: number, destDefOf: (map: string) => any): [ConnEntry?, any?] {
    const dir = typeof dirIn === "string" ? CARDINAL[dirIn] : undefined;
    if (!dir) return [];
    const [srcW, srcH] = Connections.sizeOf(def);
    for (const [, c] of ipairs<ConnEntry>(Connections.each(def))) {
      if (c.dir === dir) {
        const destDef = destDefOf(c.map);
        if (destDef) {
          const [w, h] = Connections.sizeOf(destDef);
          let hit: boolean;
          if (vertical(dir)) {
            hit = coordInIncoming(x, srcW, w, c.offset);
          } else {
            hit = coordInIncoming(y, srcH, h, c.offset);
          }
          if (hit) return [c, destDef];
        }
      }
    }
    return [];
  },

  // Lua: connections.lua:82 -- pokefirered/src/fieldmap.c:745; [lx, ly] or []
  localPos(n: Neighbor, x: number, y: number, srcW: number, srcH: number): [number?, number?] {
    const [w, h] = Connections.sizeOf(n.def);
    const off = tonumber(n.offset) ?? 0;
    let lx: number, ly: number;
    if (n.dir === "north") {
      lx = x - off; ly = h + y;
    } else if (n.dir === "south") {
      lx = x - off; ly = y - srcH;
    } else if (n.dir === "west") {
      lx = w + x; ly = y - off;
    } else if (n.dir === "east") {
      lx = x - srcW; ly = y - off;
    } else {
      return [];
    }
    const along = vertical(n.dir) ? lx : ly;
    const span = vertical(n.dir) ? w : h;
    if (along < 0 || along >= span) return [];
    return [lx, ly];
  },

  // Lua: connections.lua:104 -- pokefirered/src/fieldmap.c:761; [n, lx, ly] or []
  atPos(list: LuaTable, x: number, y: number, srcW: number, srcH: number): [Neighbor?, number?, number?] {
    for (const [, n] of ipairs<Neighbor>(list ?? [null])) {
      const dir = n.dir;
      const skip = (dir === "north" && y >= 0) || (dir === "south" && y < srcH)
        || (dir === "west" && x >= 0) || (dir === "east" && x < srcW);
      if (!skip && n.def) {
        const [lx, ly] = Connections.localPos(n, x, y, srcW, srcH);
        if (lx != null) return [n, lx, ly];
      }
    }
    return [];
  },
};

export default Connections;
