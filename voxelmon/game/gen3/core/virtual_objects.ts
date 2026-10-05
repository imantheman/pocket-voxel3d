// Port of gen1recomp src/core/game3/virtual_objects.lua (GPLv3 + additional terms; see LICENSE.md).
// src/event_object_movement.c:1719, src/event_object_movement.c:9236, src/event_object_movement.c:9248-9257

import { len, remove, pairs, type LuaTable } from "../platform/lt.ts";
import { tonumber, tostring } from "../../../import/gen3/lua.ts";

export interface VObject {
  id: number;
  graphicsId: number;
  x: number;
  y: number;
  elevation: number;
  direction: number;
}

const byId: Record<number, VObject | null> = {};
const order: LuaTable = [null];
let logged: Record<string, boolean> = {};

// Lua: virtual_objects.lua:12
function log_once(key: string, msg: string): void {
  if (logged[key]) return;
  logged[key] = true;
  console.log("[game3/virtual_objects] " + tostring(msg));
}

export const VirtualObjects = {
  // include/constants/global.h:110, event.inc
  DIR_SOUTH: 1,

  // Lua: virtual_objects.lua:19 -- src/scrcmd.c:1171-1181
  spawn(vObjId: unknown, graphicsId: unknown, x: unknown, y: unknown, elevation: unknown, direction: unknown): VObject | undefined {
    const id = tonumber(vObjId);
    if (id == null) {
      log_once("spawn:" + tostring(vObjId), "createvobject with a non-numeric id");
      return undefined;
    }
    if (byId[id] == null) {
      order[len(order) + 1] = id;
    }
    const rec: VObject = {
      id,
      graphicsId: tonumber(graphicsId) ?? 0,
      x: tonumber(x) ?? 0,
      y: tonumber(y) ?? 0,
      // event.inc:1346
      elevation: tonumber(elevation) ?? 3,
      direction: tonumber(direction) ?? VirtualObjects.DIR_SOUTH,
    };
    byId[id] = rec;
    return rec;
  },

  // Lua: virtual_objects.lua:41
  turn(vObjId: unknown, direction: unknown): boolean {
    const id = tonumber(vObjId);
    const rec = id != null ? byId[id] : undefined;
    if (!rec) {
      log_once("turn:" + tostring(vObjId),
        "turnvobject for an id that was never created (" + tostring(vObjId) + ")");
      return false;
    }
    rec.direction = tonumber(direction) ?? rec.direction;
    return true;
  },

  // Lua: virtual_objects.lua:53
  remove(vObjId: unknown): boolean {
    const id = tonumber(vObjId);
    if (id == null || byId[id] == null) return false;
    byId[id] = null;
    for (let i = len(order); i >= 1; i--) {
      if (order[i] === id) remove(order, i);
    }
    return true;
  },

  // Lua: virtual_objects.lua:63
  get(vObjId: unknown): VObject | undefined {
    const id = tonumber(vObjId);
    return (id != null && byId[id]) || undefined;
  },

  // Lua: virtual_objects.lua:68
  list(): LuaTable {
    const out: LuaTable = [null];
    for (let i = 1; i <= len(order); i++) {
      const rec = byId[order[i]];
      if (rec) out[len(out) + 1] = rec;
    }
    return out;
  },

  // Lua: virtual_objects.lua:77
  slots(): number {
    return len(order);
  },

  // Lua: virtual_objects.lua:81
  nth(i: number): VObject | undefined {
    const id = order[i];
    return (id != null && byId[id]) || undefined;
  },

  // Lua: virtual_objects.lua:86
  count(): number {
    let n = 0;
    for (const _ of pairs(byId)) n = n + 1;
    return n;
  },

  // Lua: virtual_objects.lua:93 -- event_object_movement.c:9225
  clear(): void {
    for (const [k] of pairs(byId)) byId[k as number] = null;
    for (let i = len(order); i >= 1; i--) order[i] = null;
    order.length = 1;
  },

  // Lua: virtual_objects.lua:98
  reset(): void {
    VirtualObjects.clear();
    logged = {};
  },
};

export default VirtualObjects;
