// Port of gen1recomp src/core/game3/object_prepare.lua (GPLv3 + additional terms; see LICENSE.md).
// CPU-only object construction shared with the field preparation worker.
//
// Movement specs come from scripting/gfx_ids.ts in that port's shape (its
// dirs / route lists are 0-based arrays); they pass through untouched.
// snapshot.defs is a Lua sequence; Prepare.objects returns one.

import { GfxIds } from "./scripting/gfx_ids.ts";
import { MovementTypes } from "./movement_types.ts";
import { ipairs, pairs, type LuaTable } from "../platform/lt.ts";
import { tonumber, tostring } from "../../../import/gen3/lua.ts";

const CELL = 16, WALK_FRAMES = 16, MOVEMENT_TYPE_INVISIBLE = 0x4C;

// Lua: object_prepare.lua:6
function facingFromDef(def: any): string {
  const r = tostring(def.facing ?? def.range ?? "DOWN").toLowerCase();
  return (r === "up" || r === "down" || r === "left" || r === "right") ? r : "down";
}

let inPlace: Record<number, { dir: string; frames: number; always: boolean }> | undefined;

// Lua: object_prepare.lua:11
function hostSpec(mt: number, rx: unknown, ry: unknown, enabled: unknown): any {
  const spec: any = GfxIds.hostMovement(mt, rx, ry);
  if (!inPlace) {
    inPlace = {};
    const kinds: [string, string, number, boolean][] = [
      ["firered", "MOVEMENT_TYPE_WALK_IN_PLACE_", 16, false],
      ["firered", "MOVEMENT_TYPE_WALK_IN_PLACE_FAST_", 8, false],
      ["firered", "MOVEMENT_TYPE_JOG_IN_PLACE_", 4, false],
      ["emerald", "MOVEMENT_TYPE_WALK_SLOWLY_IN_PLACE_", 32, true],
    ];
    const dirs: Record<string, string> = { DOWN: "down", UP: "up", LEFT: "left", RIGHT: "right" };
    for (const kind of kinds) {
      for (const [suffix, dir] of pairs<string>(dirs)) {
        const id = MovementTypes.canonOf(kind[0], kind[1] + suffix);
        if (id != null) inPlace[id] = { dir, frames: kind[2], always: kind[3] };
      }
    }
  }
  const ip = inPlace[mt];
  if (ip && (ip.always || enabled)) {
    spec.movement = "IN_PLACE"; spec.face = ip.dir; spec.range = ip.dir.toUpperCase(); spec.frames = ip.frames;
  }
  return spec;
}

const MT_BERRY_TREE = 0x0C;
// pokeemerald/include/constants/event_object_movement.h:61
const MT_TREE_DISGUISE = 0x39;
const MT_MOUNTAIN_DISGUISE = 0x3A;
const MT_BURIED = 0x3F;

// pokeemerald/src/event_object_movement.c:1153
const COPY_TYPES: Record<number, { init: string; grass?: boolean }> = {
  [0x35]: { init: "up" }, [0x36]: { init: "down" }, [0x37]: { init: "left" }, [0x38]: { init: "right" },
  [0x3B]: { init: "up", grass: true }, [0x3C]: { init: "down", grass: true },
  [0x3D]: { init: "left", grass: true }, [0x3E]: { init: "right", grass: true },
};

export const Prepare = {
  // Lua: object_prepare.lua:46
  initRseKind(eo: any): void {
    const mt = tonumber(eo.movementType) ?? 0;
    eo.rseKind = undefined;
    const copy = COPY_TYPES[mt];
    if (copy) {
      eo.rseKind = "copy";
      eo.copy = { init: copy.init, grass: copy.grass };
    } else {
      eo.copy = undefined;
    }
    if (mt === MT_BERRY_TREE) {
      eo.rseKind = "berry_tree";
      eo.invisible = true;
      eo.berryTree = eo.berryTree ?? { id: tonumber(eo.def && (eo.def.berryTreeId ?? eo.def.trainerRange)) ?? 0 };
    } else {
      eo.berryTree = undefined;
    }
    if (mt === MT_TREE_DISGUISE || mt === MT_MOUNTAIN_DISGUISE) {
      eo.rseKind = "disguise";
      // pokeemerald/src/event_object_movement.c:4354
      const sheet = mt === MT_TREE_DISGUISE ? "tree_disguise" : "mountain_disguise";
      if (!(eo.disguise && eo.disguise.sheet === sheet)) eo.disguise = { sheet };
    } else {
      eo.disguise = undefined;
    }
    if (mt === MT_BURIED) {
      // pokeemerald/src/event_object_movement.c:4390
      eo.rseKind = "buried";
      eo.buried = true;
      eo.invisible = true;
    } else if (eo.buried) {
      eo.buried = undefined;
      eo.invisible = false;
    }
  },

  // Lua: object_prepare.lua:83
  instance(def: any, ctx: any): any {
    const lid = tonumber(def.localId ?? def.index) ?? 0;
    const x = tonumber(def.x) ?? 0, y = tonumber(def.y) ?? 0;
    let rawMt: number | undefined = ctx.rawMt;
    if (rawMt == null && def.movementType != null) {
      // pcall(MovementTypes.canon, ctx.version, def.movementType)
      let ok = true, value: number | undefined;
      try { value = MovementTypes.canon(ctx.version, def.movementType); } catch { ok = false; }
      rawMt = ok ? value : tonumber(def.movementType);
    }
    const mt = rawMt ?? 0;
    let spec = ctx.spec;
    if (!spec) {
      if (rawMt != null) spec = hostSpec(rawMt, def.rangeX, def.rangeY, ctx.inPlace);
      else {
        const r = def.radius ?? { x: 1, y: 1 };
        spec = { movement: def.movement ?? "STAY", range: def.range ?? "DOWN", rangeX: r.x, rangeY: r.y, radius: r };
      }
    }
    const facing = (def.facing != null && facingFromDef(def)) || (rawMt != null && spec.face) || facingFromDef(def);
    const resolvedGfx = ctx.graphicsId ?? def.graphicsId ?? def.graphics;
    const sprite = def.sprite ?? (resolvedGfx != null ? GfxIds.spriteFor(resolvedGfx) : undefined);
    const elev = ctx.elevation ?? 0;
    const mg = ctx.group, mn = ctx.num;
    const eo: any = {
      localId: lid,
      originLocalId: tonumber(def.originLocalId ?? def.localId ?? def.index) ?? lid,
      originMapId: def.originMapId ?? def.mapId ?? ctx.mapId,
      originMapGroup: tonumber(def.originMapGroup ?? def.mapGroup) ?? mg,
      originMapNum: tonumber(def.originMapNum ?? def.mapNum) ?? mn,
      def,
      cellX: x,
      cellY: y,
      px: x * CELL,
      py: y * CELL,
      homeX: x,
      homeY: y,
      facing,
      sprite: sprite ?? "SPRITE_YOUNGSTER",
      graphicsId: resolvedGfx,
      elevation: elev,
      currentElevation: tonumber(def.elevation) ?? 0,
      movementType: mt,
      movement: spec.movement,
      range: spec.range,
      radius: spec.radius ?? { x: spec.rangeX, y: spec.rangeY },
      rangeX: spec.rangeX,
      rangeY: spec.rangeY,
      spec,
      seqIndex: 0,
      sight: tonumber(def.sight ?? def.trainerRange) ?? 0,
      trainerType: tonumber(def.trainerType) ?? 0,
      scriptKey: def.scriptKey,
      flag: def.flag,
      visible: ctx.visible !== false,
      hidden: ctx.visible === false,
      // src/event_object_movement.c:1569
      invisible: mt === MOVEMENT_TYPE_INVISIBLE,
      frozen: false,
      passable: def.passable ? true : false,
      moving: false,
      progress: 0,
      stepFrames: WALK_FRAMES,
      targetX: x,
      targetY: y,
      stepFlip: false,
      animClock: 0,
      scriptBusy: false,
    };
    if (ctx.rse) Prepare.initRseKind(eo);
    return eo;
  },

  // Lua: object_prepare.lua:154
  objects(snapshot: any, cancelled?: () => boolean): LuaTable {
    const out: LuaTable = [null];
    for (const [i, def] of ipairs<any>(snapshot.defs)) {
      if (cancelled && cancelled()) throw new Error("object preparation cancelled");
      out[i] = Prepare.instance(def, snapshot);
    }
    return out;
  },

  // Lua: object_prepare.lua:164
  // Snapshot only serializable values; custom functions/metatables keep demand loading.
  // (A JS class instance stands for a table with a metatable.)
  freeze(value: unknown): unknown {
    const visiting = new Set<object>();
    let count = 0;
    const copy = (v: unknown, depth: number): unknown => {
      if (v === null || typeof v !== "object") {
        if (typeof v === "function" || typeof v === "symbol" || typeof v === "bigint") throw new Error("custom object definition");
        return v;
      }
      const proto = Object.getPrototypeOf(v);
      if (depth > 16 || visiting.has(v) || (proto !== Object.prototype && proto !== Array.prototype && proto !== null)) {
        throw new Error("custom object definition");
      }
      visiting.add(v);
      const out: any = Array.isArray(v) ? [] : {};
      for (const [k, item] of pairs(v)) {
        count = count + 1;
        if (count > 32768) throw new Error("large object definition");
        out[copy(k, depth + 1) as string | number] = copy(item, depth + 1);
      }
      visiting.delete(v);
      return out;
    };
    try { return copy(value, 0); } catch { return undefined; }
  },

  // Lua: object_prepare.lua:185
  matches(a: any, b: any): boolean {
    // Lua type(): null and undefined both stand for nil
    const ta = a == null ? "nil" : typeof a, tb = b == null ? "nil" : typeof b;
    if (ta !== tb) return false;
    if (ta !== "object") return ta === "nil" || a === b;
    for (const [k, v] of pairs(a)) if (!Prepare.matches(v, b[k])) return false;
    for (const [k] of pairs(b)) if (a[k] == null) return false;
    return true;
  },
};

export default Prepare;
