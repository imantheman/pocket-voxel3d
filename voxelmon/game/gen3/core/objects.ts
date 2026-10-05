// Port of gen1recomp src/core/game3/objects.lua (GPLv3 + additional terms; see LICENSE.md).
// Game3 EventObject instances (localId-keyed).
// Owns idle AI + applymovement tracks; optional host NPC mirror for adapters.
// Player localId 0xFF delegates to game3.player. Talk is Field.interact.
//
// Port notes:
// - lazyReq / package.loaded / pcall(require): every module is in the bundle,
//   so each is a static import used as Brian guards it. A pcall(lazyReq) of a
//   module that is still a stub is a failed require: where Brian calls into
//   such a module, the stub's own NotPortedError is caught (stubbed()) and the
//   failed-require path is taken. Modules with no file in the port at all
//   (field_effects_rse, rse/berry_trees, faraway_island: Emerald only) fail
//   to require via lazyReqMissing().
// - Tables keep Lua keys (platform/lt.ts): _order, forDraw/listActive results,
//   track action lists, JUMP_Y / FIG8 tables and carry lists are sequences
//   ([null, a, b]). Seams with modules ported 0-based are marked: the movement
//   specs of scripting/gfx_ids.ts (dirs, route, DELAYS) and
//   Movement.actionsFromBytes / step_diagonal `dirs` are 0-based JS arrays.
// - Multiple returns are 0-based tuples (takePrepared, playerCellFor).
// - Event objects are plain records built by object_prepare (Prepare.instance).

/* eslint-disable @typescript-eslint/no-explicit-any */
import { requireLua } from "./require_map.ts";
import { NotPortedError, notPorted } from "../notported.ts";
import { seq, len, ipairs, pairs, fromArray, type LuaTable } from "../platform/lt.ts";
import { truthy, tostring, tonumber, format, mod } from "../../../import/gen3/lua.ts";
import { match } from "../platform/lpattern.ts";
import Movement from "./scripting/movement.ts";
import Opcodes from "./scripting/opcodes.ts";
import GfxIds from "./scripting/gfx_ids.ts";
import ModRuntime from "../shared/mods/Runtime.ts";
import VirtualObjects from "./virtual_objects.ts";
import Prepare from "./object_prepare.ts";
import CollisionMod from "./collision.ts";
import PlayerMod from "./player.ts";
import SpaceMod from "./scripting/space.ts";
import Profile from "./profile.ts";
import MovementTypes from "./movement_types.ts";
import GameVersion from "../shared/core/GameVersion.ts";
import AssetStream from "./asset_stream.ts";
import MapCatalog from "../../../import/gen3/map_catalog.ts";
import Flags from "./scripting/flags.ts";
import Runtime from "./runtime.ts";
import FieldView from "./field_view.ts";
import TrainerSight from "./trainer_sight.ts";
import FieldEffects from "./field_effects.ts";
import Rng from "./rng.ts";
import Field from "./field.ts";
import Hud from "../ui/hud.ts";
import MB from "./mb.ts";

/** An EventObject (object_prepare's record; fields are Brian's). */
export type EventObject = Record<string, any>;
type EO = EventObject;

export interface Track {
  actions: LuaTable;
  i: number;
  sleep: number;
  done: boolean;
  onDone?: (() => void) | null;
}

interface Bounds { w: number; h: number }

// Lua: objects.lua:5 (lazyReq) -- for a module that has no file in the port
// (Emerald only): require fails, as in Lua.
function lazyReqMissing(name: string): any {
  const m = requireLua(name); // ported since this file was written
  if (m !== undefined) return m;
  return notPorted(`require("${name}") (no such module in the port)`);
}

/** True when `e` is the stub of `what` refusing to run (a failed require). */
function stubbed(e: unknown, what: string): boolean {
  return e instanceof NotPortedError && e.what === what;
}

const CELL = 16;
const WALK_FRAMES = 16;
// pokefirered/src/event_object_movement.c:5333 StartRunningAnim
const RUN_FRAMES = 8;
// pokefirered/src/event_object_movement.c:9029 UpdateRunSlowAnim
const RUN_SLOW_FRAMES = 11;
// include/constants/event_object_movement.h:81
const MOVEMENT_TYPE_INVISIBLE = 0x4C;
const DELTA: Record<string, [number, number]> = {
  up: [0, -1],
  down: [0, 1],
  left: [-1, 0],
  right: [1, 0],
};

// Lua: objects.lua:50
function log(msg: unknown): void {
  console.log("[game3/objects] " + tostring(msg));
}

// Lua: objects.lua:55 -- pokefirered/src/overworld.c
function layoutBounds(mapDef: any): Bounds | undefined {
  const L = mapDef ? mapDef.midLayout : undefined;
  const w = (L && L.width) || 0;
  const h = (L && L.height) || 0;
  if (w < 1 || h < 1) return undefined;
  return { w, h };
}

// Lua: objects.lua:65
function offMap(bounds: Bounds | null | undefined, eo: EO): boolean {
  if (!bounds) return false;
  const x = eo.cellX ?? 0;
  const y = eo.cellY ?? 0;
  return x < 0 || y < 0 || x >= bounds.w || y >= bounds.h;
}

// Lua: objects.lua:74
function Collision(): any {
  // package.loaded["src.core.game3.collision"] or lazyReq(...)
  return CollisionMod;
}

// Lua: objects.lua:79
function Player(): any {
  // package.loaded["src.core.game3.player"] or lazyReq(...)
  return PlayerMod;
}

// Lua: objects.lua:84
function Space(): any {
  // package.loaded["src.core.game3.scripting.space"]
  return SpaceMod;
}

// Lua: objects.lua:88
function isPlayer(localId: unknown): boolean {
  const id = tonumber(localId);
  return id === Objects.PLAYER_LOCAL_ID || id === 0xFF || id === 0x800F;
}

// Lua: objects.lua:93
function facingFromDef(def: any): string {
  const r = tostring(def.facing ?? def.range ?? "DOWN").toLowerCase();
  if (r === "up" || r === "down" || r === "left" || r === "right") {
    return r;
  }
  if (r === "any_dir" || r === "up_down" || r === "left_right") {
    return "down";
  }
  return "down";
}

// Lua: objects.lua:104
// Seam: returns a 0-based array, the shape of gfx_ids.ts's spec.dirs (it is
// only ever used in place of one).
function dirsForRange(range: unknown): string[] {
  const r = tostring(range ?? "DOWN").toUpperCase();
  if (r === "ANY_DIR") return ["up", "down", "left", "right"];
  if (r === "UP_DOWN") return ["up", "down"];
  if (r === "LEFT_RIGHT") return ["left", "right"];
  if (r === "UP") return ["up"];
  if (r === "DOWN") return ["down"];
  if (r === "LEFT") return ["left"];
  if (r === "RIGHT") return ["right"];
  return ["down", "up", "left", "right"];
}

const EMPTY: Record<string, any> = {};

// Lua: objects.lua:118
function fieldBlock(): Record<string, any> {
  // pcall(Profile.forSession)
  try {
    const row = Profile.forSession();
    return (row && row.field) || EMPTY;
  } catch {
    return EMPTY;
  }
}

// Lua: objects.lua:124
function isRse(): boolean {
  // pcall(Profile.forSession)
  try {
    const row = Profile.forSession();
    return row != null && row.family === "rse";
  } catch {
    return false;
  }
}

// Lua: objects.lua:131
function canonMt(mtIn: unknown): number | undefined {
  const mt = tonumber(mtIn);
  if (mt == null) return undefined;
  const version = GameVersion.get();
  // pcall(MovementTypes.canon, version, mt)
  let ok = true, v: number | undefined;
  try { v = MovementTypes.canon(version, mt); } catch { ok = false; }
  return ok && v != null ? v : mt;
}

let inPlace: Record<number, { dir: string; frames: number; always: boolean }> | undefined;
// Lua: objects.lua:142
function inPlaceTable(): Record<number, { dir: string; frames: number; always: boolean }> {
  if (inPlace) return inPlace;
  inPlace = {};
  const dirs: Record<string, string> = { DOWN: "down", UP: "up", LEFT: "left", RIGHT: "right" };
  // pokeemerald/src/event_object_movement.c:4422
  const kinds: [string, string, number, boolean][] = [
    ["firered", "MOVEMENT_TYPE_WALK_IN_PLACE_", 16, false],
    ["firered", "MOVEMENT_TYPE_WALK_IN_PLACE_FAST_", 8, false],
    ["firered", "MOVEMENT_TYPE_JOG_IN_PLACE_", 4, false],
    ["emerald", "MOVEMENT_TYPE_WALK_SLOWLY_IN_PLACE_", 32, true],
  ];
  for (const k of kinds) {
    for (const [suffix, dir] of pairs<string>(dirs)) {
      const id = MovementTypes.canonOf(k[0], k[1] + suffix);
      if (id != null) inPlace[id] = { dir, frames: k[2], always: k[3] };
    }
  }
  return inPlace;
}

// Lua: objects.lua:163
function hostSpec(mt: unknown, rangeX: unknown, rangeY: unknown): any {
  const spec: any = GfxIds.hostMovement(mt, rangeX, rangeY);
  const ip = inPlaceTable()[tonumber(mt) ?? -1];
  if (ip && (ip.always || truthy(fieldBlock().inPlaceMovementTypes))) {
    spec.movement = "IN_PLACE";
    spec.face = ip.dir;
    spec.range = ip.dir.toUpperCase();
    spec.frames = ip.frames;
  }
  return spec;
}

// Lua: objects.lua:177
function objectVisible(def: any): boolean {
  const Sp = Space();
  if (Sp && Sp.objectVisible) {
    return Sp.objectVisible(def);
  }
  const flag = def.flag;
  if (flag == null || flag === false || flag === 0 || flag === 0xFFFF || flag === 65535) {
    return true;
  }
  return true;
}

// include/constants/event_objects.h:195
const OBJ_KIND_CLONE = 255;

// Lua: objects.lua:193 -- pokefirered/src/overworld.c:410
function cloneTemplate(def: any): any {
  const t = def.cloneTarget;
  if (tonumber(def.kind) !== OBJ_KIND_CLONE || t === null || typeof t !== "object") return undefined;
  let mapId = t.mapId;
  if (mapId == null) {
    // pcall(lazyReq, "src.import.gba.map_catalog")
    if (MapCatalog && MapCatalog.mapIdFor) {
      mapId = MapCatalog.mapIdFor(tonumber(t.mapGroup), tonumber(t.mapNum));
    }
  }
  const Sp = Space();
  const ev = mapId != null && Sp && Sp.bundle && Sp.bundle.events ? Sp.bundle.events[mapId] : undefined;
  const defs = ev ? (ev.objects ?? ev.objectEvents) : undefined;
  const tpl = defs !== null && typeof defs === "object" ? defs[tonumber(t.localId) ?? 0] : undefined;
  if (tpl === null || typeof tpl !== "object" || tonumber(tpl.kind) === OBJ_KIND_CLONE) return undefined;
  return tpl;
}

// Lua: objects.lua:213
function templateCopy(srcIn: any): any {
  const src = srcIn ?? {};
  const tpl = cloneTemplate(src);
  const def: any = {};
  for (const [k, v] of pairs(tpl ?? src)) def[k] = v;
  if (tpl) {
    def.localId = src.localId; def.index = src.index; def.x = src.x; def.y = src.y;
    def.kind = src.kind; def.cloneTarget = src.cloneTarget;
  }
  return def;
}
// Lua: objects.lua:224
function sameTemplate(src: any, snapshot: any): boolean {
  if (cloneTemplate(src)) return Prepare.matches(templateCopy(src), snapshot);
  return Prepare.matches(src, snapshot);
}

// Lua: objects.lua:229
function newEventObject(src: any, neighbor: any, prepared: any): EO {
  const def = templateCopy(src);
  const x = tonumber(def.x) ?? 0, y = tonumber(def.y) ?? 0;
  let resolvedGfx = def.graphicsId ?? def.graphics;
  // pcall(lazyReq, "src.core.game3.scripting.space")
  const Sp = SpaceMod;
  if (Sp && Sp.resolveObjectGraphicsId) {
    let gid: any;
    try {
      gid = Sp.resolveObjectGraphicsId(def, neighbor);
    } catch (e) {
      if (!stubbed(e, "Space.resolveObjectGraphicsId")) throw e;
    }
    if (gid != null && gid !== false) resolvedGfx = gid;
  }
  const Coll = Collision();
  const elev = (def.elevation != null && def.elevation !== false && def.elevation !== 0 && def.elevation)
    || ((Coll && Coll.elevationAt && Coll.elevationAt(x, y)) ?? 0);
  // package.loaded["src.import.gba.map_catalog"] or (pcall(lazyReq, ...) and ...)
  let mg: number | undefined, mn: number | undefined;
  if (MapCatalog && MapCatalog.groupNumFor && (def.mapId ?? Objects._mapId) != null) {
    [mg, mn] = MapCatalog.groupNumFor(def.mapId ?? Objects._mapId);
  }
  const visible = objectVisible(def);
  let eo = prepared;
  if (!eo) {
    const rawMt = canonMt(def.movementType);
    eo = Prepare.instance(def, {
      rawMt, spec: rawMt != null ? hostSpec(rawMt, def.rangeX, def.rangeY) : undefined,
      version: GameVersion.get(), mapId: Objects._mapId, rse: isRse(),
      graphicsId: resolvedGfx, elevation: elev, group: mg, num: mn, visible,
    });
  } else {
    // Only authoritative live state is rebound here. Construction and movement
    // specifications came from an immutable worker snapshot.
    eo.def = def;
    if (tonumber(def.movementType) == null && def.radius) eo.spec.radius = def.radius;
    if (eo.spec.radius) eo.radius = eo.spec.radius;
    eo.graphicsId = resolvedGfx;
    eo.sprite = def.sprite ?? (resolvedGfx != null ? GfxIds.spriteFor(resolvedGfx) : undefined) ?? "SPRITE_YOUNGSTER";
    eo.elevation = elev; eo.visible = visible; eo.hidden = !visible;
    eo.originMapId = def.originMapId ?? def.mapId ?? Objects._mapId;
    eo.originMapGroup = tonumber(def.originMapGroup ?? def.mapGroup) ?? mg;
    eo.originMapNum = tonumber(def.originMapNum ?? def.mapNum) ?? mn;
  }
  return eo;
}

interface PreparedRow { defs: any; version: string; inPlace: any; snapshot: any; data?: any; error?: any }
const preparedMaps: Record<string, PreparedRow | undefined> = {};
let preparationStream: any;

// love.thread: not on the 3DS, so prefetchMap takes Brian's single-threaded
// path (it returns at once) and preparedMaps stays empty.
const LOVE_THREAD = false as boolean;

// Lua: objects.lua:271
function definitions(mapId: any, mapDef: any): LuaTable {
  const Sp = Space();
  const ev = Sp && Sp.bundle && Sp.bundle.events ? Sp.bundle.events[mapId] : undefined;
  const defs = ev ? (ev.objects ?? ev.objectEvents) : undefined;
  return (defs !== null && typeof defs === "object" && defs) || (mapDef && mapDef.objects) || [null];
}
// Lua: objects.lua:277
function preparationCurrent(row: PreparedRow, defs: LuaTable): boolean {
  if (row.defs !== defs || row.version !== GameVersion.get()
      || row.inPlace !== fieldBlock().inPlaceMovementTypes || len(row.snapshot.defs) !== len(defs)) return false;
  for (const [i, def] of ipairs(defs)) {
    if (!sameTemplate(def, row.snapshot.defs[i])) return false;
  }
  return true;
}
// Lua: objects.lua:285
function prefetchMap(mapId: any, mapDef: any, priority?: number): boolean | undefined {
  if (!LOVE_THREAD) return undefined;
  const Stream = AssetStream;
  if (Stream.workerFailed) return undefined;
  const defs = definitions(mapId, mapDef);
  const old = preparedMaps[mapId];
  if (old && old.error && preparationCurrent(old, defs)) return false;
  if (old && preparationCurrent(old, defs)
      && (old.data || (preparationStream && preparationStream.pending[mapId]))) return true;
  if (!preparationStream) {
    preparationStream = Stream.newTask("objects", (key: any, data: any, err: any) => {
      const row = preparedMaps[key];
      if (row) { row.data = data; row.error = err; }
    });
  }
  if (old) {
    const wanted: Record<string, boolean> = {};
    for (const id in preparedMaps) if (preparedMaps[id] != null && id !== mapId) wanted[id] = true;
    preparationStream.retain(wanted);
  }
  const templates: LuaTable = [null];
  for (const [i, def] of ipairs(defs)) templates[i] = templateCopy(def);
  const frozen = Prepare.freeze(templates);
  if (!frozen) { preparedMaps[mapId] = undefined; return undefined; }
  const version = GameVersion.get();
  const inPlaceEnabled = fieldBlock().inPlaceMovementTypes;
  const snapshot = { defs: frozen, version, mapId, rse: isRse(), inPlace: inPlaceEnabled };
  preparedMaps[mapId] = { defs, version, inPlace: inPlaceEnabled, snapshot };
  preparationStream.submit(mapId, snapshot, priority);
  AssetStream.poll();
  return preparationStream.pending[mapId] != null || preparedMaps[mapId]!.data != null;
}
// Lua: objects.lua:316
function preparationReady(mapId: any, mapDef: any): boolean {
  // package.loaded["src.core.game3.asset_stream"]
  const Stream = AssetStream;
  if (Stream) Stream.poll();
  const row = preparedMaps[mapId];
  return (row != null && row.data != null && preparationCurrent(row, definitions(mapId, mapDef))) || false;
}
// Lua: objects.lua:322
function retainPrepared(wanted: Record<string, unknown>): void {
  if (preparationStream) preparationStream.retain(wanted);
  for (const id in preparedMaps) {
    if (preparedMaps[id] != null && !truthy(wanted[id])) delete preparedMaps[id];
  }
}
// Lua: objects.lua:326
function _preparationPending(mapId: any): boolean | undefined {
  return preparationStream ? preparationStream.pending[mapId] != null : undefined;
}
// Lua: objects.lua:329 -- returns [data, snapshotDefs] (both nil on the sync route)
function takePrepared(mapId: any, defs: LuaTable): [any, any] {
  // package.loaded["src.core.game3.asset_stream"]
  const Stream = AssetStream;
  if (Stream) Stream.poll();
  const row = mapId != null ? preparedMaps[mapId] : undefined;
  if (row && row.data && preparationCurrent(row, defs)) {
    preparedMaps[mapId] = undefined;
    Objects._lastPreparationRoute = "worker";
    return [row.data, row.snapshot.defs];
  }
  Objects._lastPreparationRoute = "sync";
  return [undefined, undefined];
}
// Lua: objects.lua:340
function preparedRow(rows: any, snapshots: any, i: number, def: any): any {
  return (rows && sameTemplate(def, snapshots[i]) && rows[i]) || undefined;
}

// Lua: objects.lua:344
function clear(): void {
  Objects._byId = {};
  Objects._order = [null];
  Objects._tracks = {};
  Objects._mapId = undefined;
  Objects._defs = undefined;
  Objects._bounds = undefined;
  // src/event_object_movement.c:9225
  VirtualObjects.clear();
}

// Lua: objects.lua:356 -- pokefirered/src/overworld.c:405
function reset(): void {
  Objects.retainPrepared({});
  Objects.clear();
  Objects._perm = {};
  Objects._templateMt = {};
  Objects._logged = false;
  VirtualObjects.reset();
}

// Lua: objects.lua:365
function hasMap(): boolean {
  return Objects._mapId != null;
}

// Lua: objects.lua:370
/** Re-resolve OBJ_EVENT_GFX_VAR_* after ON_TRANSITION sets VAR_OBJ_GFX_ID_*. */
function refreshGraphics(): number {
  // pcall(lazyReq, "src.core.game3.scripting.space")
  const Sp = SpaceMod;
  if (!(Sp && Sp.resolveObjectGraphicsId)) return 0;
  let n = 0;
  for (const [, eo] of pairs<EO>(Objects._byId ?? {})) {
    if (eo && eo.def) {
      let gid: any;
      try {
        gid = Sp.resolveObjectGraphicsId(eo.def);
      } catch (e) {
        // the stub refuses on the first call: the failed-require path
        if (stubbed(e, "Space.resolveObjectGraphicsId")) return 0;
        throw e;
      }
      if (gid != null && gid !== false && gid !== eo.graphicsId) {
        eo.graphicsId = gid;
        eo.sprite = GfxIds.spriteFor(gid) ?? eo.sprite;
        n = n + 1;
      } else if (gid != null && gid !== false) {
        eo.graphicsId = gid;
      }
    }
  }
  // pcall(lazyReq, "src.core.game3.field_view")
  if (FieldView) FieldView._nativeDirty = true;
  return n;
}

// Lua: objects.lua:391
function hasActiveTracks(): boolean {
  const tracks = Objects._tracks;
  for (const k in tracks) {
    const tr = tracks[k];
    if (tr && !tr.done) return true;
  }
  return false;
}

interface PermRow { x?: number; y?: number; movementType?: number; facing?: string }

// Lua: objects.lua:398
function rememberPerm(mapIdIn: any, localIdIn: unknown, fields: PermRow): void {
  const mapId = mapIdIn ?? Objects._mapId;
  const localId = tonumber(localIdIn) ?? 0;
  if (mapId == null || localId <= 0) return;
  let bucket = Objects._perm[mapId];
  if (!bucket) {
    bucket = {};
    Objects._perm[mapId] = bucket;
  }
  let row = bucket[localId];
  if (!row) {
    row = {};
    bucket[localId] = row;
  }
  for (const k in fields) {
    const v = (fields as any)[k];
    if (v != null) (row as any)[k] = v;
  }
}

// Lua: objects.lua:420 -- src/event_object_movement.c:4806
function setSpec(eo: EO, mtIn: unknown): void {
  const mt = canonMt(mtIn) ?? 0;
  const spec = hostSpec(mt, eo.rangeX, eo.rangeY);
  spec.rangeX = tonumber(eo.rangeX) ?? 0;
  spec.rangeY = tonumber(eo.rangeY) ?? 0;
  spec.radius = { x: spec.rangeX, y: spec.rangeY };
  eo.movementType = tonumber(mt) ?? 0;
  eo.spec = spec;
  eo.movement = spec.movement;
  eo.range = spec.range;
  eo.radius = spec.radius;
  eo.seqIndex = 0;
  eo.idleTimer = undefined;
  if (isRse()) Objects.initRseKind(eo);
}

// Lua: objects.lua:436
function applyPerm(eo: EO, mapId: any): void {
  const bucket = Objects._perm[mapId];
  const row = bucket ? bucket[eo.localId] : undefined;
  if (!row) return;
  if (row.x != null) {
    eo.cellX = row.x;
    eo.homeX = row.x;
    eo.px = row.x * CELL;
    eo.targetX = row.x;
    if (eo.def) eo.def.x = row.x;
  }
  if (row.y != null) {
    eo.cellY = row.y;
    eo.homeY = row.y;
    eo.py = row.y * CELL;
    eo.targetY = row.y;
    if (eo.def) eo.def.y = row.y;
  }
  if (row.movementType != null) {
    setSpec(eo, row.movementType);
    // src/event_object_movement.c:1378
    eo.facing = eo.spec.face;
    // src/event_object_movement.c:1569
    eo.invisible = tonumber(row.movementType) === MOVEMENT_TYPE_INVISIBLE;
    if (eo.def) eo.def.movementType = row.movementType;
  }
  if (row.facing != null) {
    eo.facing = row.facing;
    if (eo.def) eo.def.facing = row.facing;
  }
}

// Lua: objects.lua:468
function resolveContextualMapObjects(mapId: any): void {
  if (mapId === "FR_OAKS_LAB" || mapId === "PalletTown_ProfessorOaksLab") {
    const Sp = Space();
    const store = Sp ? Sp.store : undefined;
    // package.loaded["src.core.game3.scripting.flags"] / ["src.core.game3.runtime"]
    const session = Runtime && Runtime.getSession ? Runtime.getSession() : undefined;

    let oakScene = 0;
    if (Flags && Flags.getVar && truthy(store)) {
      oakScene = Flags.getVar(store, undefined, 0x4055);
    } else if (session && session.vars) {
      oakScene = tonumber(session.vars[0x4055]) ?? 0;
    }

    let starter = 0;
    if (Flags && Flags.getVar && truthy(store)) {
      starter = Flags.getVar(store, undefined, 0x4031);
    } else if (session && session.vars) {
      starter = tonumber(session.vars[0x4031]) ?? 0;
    }

    if (starter === 0 && session && session.party && session.party[1]) {
      const sp = session.party[1].species;
      if (sp === 4) starter = 2;       // Charmander -> Rival has Squirtle
      else if (sp === 7) starter = 1;  // Squirtle -> Rival has Bulbasaur
      else if (sp === 1) starter = 0;  // Bulbasaur -> Rival has Charmander
    }

    if (oakScene === 1 || oakScene === 2) {
      rememberPerm(mapId, 4, { x: 6, y: 3, movementType: 8, facing: "down" });
      rememberPerm(mapId, 8, { x: 5, y: 4, movementType: 7, facing: "up" });
    } else if (oakScene === 3) {
      rememberPerm(mapId, 4, { x: 6, y: 3, movementType: 8, facing: "down" });
      let rx = 10, ry = 5;
      if (starter === 1) {
        rx = 8; ry = 5;
      } else if (starter === 2) {
        rx = 9; ry = 5;
      }
      rememberPerm(mapId, 8, { x: rx, y: ry, movementType: 7, facing: "up" });
    } else if ((oakScene >= 4 && oakScene <= 6) || oakScene >= 8) {
      rememberPerm(mapId, 4, { x: 6, y: 3, movementType: 8, facing: "down" });
    }
  }
  if (mapId === "FR_PALLET_TOWN" || mapId === "PalletTown") {
    const Sp = Space();
    const store = Sp ? Sp.store : undefined;
    const session = Runtime && Runtime.getSession ? Runtime.getSession() : undefined;

    let signLadyScene = 0;
    if (Flags && Flags.getVar && truthy(store)) {
      signLadyScene = Flags.getVar(store, undefined, 0x4070);
    } else if (session && session.vars) {
      signLadyScene = tonumber(session.vars[0x4070]) ?? 0;
    }

    let hasStarter = false;
    if (Flags && Flags.getFlag && truthy(store)) {
      hasStarter = Flags.getFlag(store, undefined, 0x291) || Flags.getFlag(store, undefined, 0x828);
    }
    if (!hasStarter && session && session.flags) {
      hasStarter = session.flags[0x291] === true || session.flags["0x291"] === true
        || session.flags[657] === true || session.flags["657"] === true
        || session.flags[0x828] === true || session.flags["0x828"] === true
        || session.flags[2088] === true || session.flags["2088"] === true;
    }
    if (!hasStarter && session && session.party && len(session.party) > 0) {
      hasStarter = true;
    }

    if (signLadyScene === 0) {
      if (hasStarter) {
        rememberPerm(mapId, 1, { x: 12, y: 2, movementType: 8, facing: "down" });
        if (Flags && truthy(store)) {
          Flags.setVar(store, undefined, 0x4002, 1); // VAR_TEMP_2 = 1 (SIGN_LADY_READY)
          Flags.setFlag(store, undefined, 0x291, true);
          Flags.setFlag(store, undefined, 0x83E, false); // FLAG_OPENED_START_MENU = false until scene completes
        }
        if (session) {
          if (session.vars) session.vars[0x4002] = 1;
          if (session.flags) {
            session.flags[0x291] = true;
            session.flags[657] = true;
            session.flags[0x83E] = undefined;
            session.flags[2110] = undefined;
          }
        }
      } else {
        rememberPerm(mapId, 1, { x: 5, y: 15, movementType: 7, facing: "up" });
      }
    }
  }
}

const TMT_FACE: Record<number, string> = { [7]: "up", [8]: "down", [9]: "left", [10]: "right" };

// Lua: objects.lua:566
function spawnFromTemplate(def: any, mapId: any, prepared: any): EO {
  const eo = newEventObject(def, undefined, prepared);
  if (mapId != null && (eo.originMapGroup == null || eo.originMapNum == null)) {
    // pcall(lazyReq, "src.import.gba.map_catalog")
    if (MapCatalog && MapCatalog.groupNumFor) {
      const [g, n] = MapCatalog.groupNumFor(mapId);
      if (g != null && n != null) {
        eo.originMapGroup = g;
        eo.originMapNum = n;
      }
    }
    eo.originMapId = mapId;
  }
  if (eo.localId > 0) {
    applyPerm(eo, mapId);
    const tmt = Objects._templateMt[eo.localId];
    if (tmt != null) {
      Objects.setTrainerMovementType(eo, tmt);
      // src/event_object_movement.c:1569
      eo.invisible = tmt === MOVEMENT_TYPE_INVISIBLE;
      const face = TMT_FACE[tmt];
      if (face) eo.facing = face;
    }
  }
  return eo;
}

// Lua: objects.lua:594 -- src/event_object_movement.c:1651
function respawnFromTemplate(lid: number): EO | undefined {
  let tpl: any;
  for (const [, def] of ipairs<any>(Objects._defs ?? [null])) {
    if (tonumber(def.localId ?? def.index) === lid) tpl = def;
  }
  if (!tpl) return undefined;
  const eo = spawnFromTemplate(tpl, Objects._mapId, undefined);
  eo.hidden = false; eo.visible = true;
  if (eo.def) eo.def.hidden = false;
  let present = Objects._byId[lid] != null;
  if (!present) {
    for (const [, id] of ipairs<number>(Objects._order)) {
      if (id === lid) { present = true; break; }
    }
  }
  Objects._byId[lid] = eo;
  Objects._tracks[lid] = undefined;
  if (!present) Objects._order[len(Objects._order) + 1] = lid;
  if (ModRuntime.wants("world.npc_spawned")) {
    ModRuntime.emit("world.npc_spawned", { mapId: Objects._mapId, npcId: lid, runtime: eo });
  }
  return eo;
}

// Lua: objects.lua:619
/** Spawn EventObjects from mapDef.objects (extract / content). */
function loadMap(_game: any, mapId: any, mapDef: any): number {
  const sameMap = Objects._mapId === mapId;
  // Never wipe in-flight applymovement on a same-map rebind (host setMap echo).
  Objects._foreign = undefined;
  if (!sameMap) {
    Objects._tracks = {};
    Objects._templateMt = {};
    // pokefirered/src/overworld.c:405
    Objects._perm = {};
  }
  Objects._byId = {};
  Objects._order = [null];
  Objects._mapId = mapId;
  // Prefer ROM event bundle (source of truth). mapDef.objects is the same
  // table reference after attachEventsToMaps and may have been mutated.
  let defs: any;
  const Sp = Space();
  const ev = Sp && Sp.bundle && Sp.bundle.events ? Sp.bundle.events[mapId] : undefined;
  if (ev) {
    defs = ev.objects ?? ev.objectEvents;
  }
  if (defs === null || typeof defs !== "object") {
    defs = mapDef ? mapDef.objects : undefined;
  }
  Objects._defs = defs ?? [null];
  Objects._bounds = layoutBounds(mapDef);
  if (mapId === "FR_PLAYERS_HOUSE_1F") {
    for (const [, def] of ipairs<any>(Objects._defs)) {
      if (tonumber(def.localId ?? def.index) === 1) {
        def.x = 8; def.y = 4;
      }
    }
  }
  resolveContextualMapObjects(mapId);
  const [prepared, snapshots] = takePrepared(mapId, Objects._defs);
  const announce = ModRuntime.wants("world.npc_spawned");
  for (const [i, def] of ipairs<any>(Objects._defs)) {
    const eo = spawnFromTemplate(def, mapId, preparedRow(prepared, snapshots, i, def));
    if (eo.localId > 0) {
      Objects._byId[eo.localId] = eo;
      Objects._order[len(Objects._order) + 1] = eo.localId;
      if (announce) {
        ModRuntime.emit("world.npc_spawned", { mapId, npcId: eo.localId, runtime: eo });
      }
    }
  }
  if (!Objects._logged) {
    log(format("spawned %d objects on %s", len(Objects._order), tostring(mapId)));
    Objects._logged = true;
  } else {
    log(format("reloaded %d objects on %s%s", len(Objects._order), tostring(mapId),
      sameMap ? " (kept tracks)" : ""));
  }
  return len(Objects._order);
}

const FOREIGN_BASE = 0xC0;

// Lua: objects.lua:677
function shiftObject(eo: EO, dx: number, dy: number): void {
  eo.cellX = (eo.cellX ?? 0) + dx; eo.cellY = (eo.cellY ?? 0) + dy;
  eo.px = (eo.px ?? 0) + dx * CELL; eo.py = (eo.py ?? 0) + dy * CELL;
  if (eo.targetX != null) { eo.targetX = eo.targetX + dx; eo.targetY = eo.targetY + dy; }
  if (eo.homeX != null) { eo.homeX = eo.homeX + dx; eo.homeY = eo.homeY + dy; }
}

export interface Carry { map: any; list: LuaTable; player: Track | undefined }

// Lua: objects.lua:685 -- pokeemerald/src/fieldmap.c:603 CameraMove, pokeemerald/src/event_object_movement.c:2217
function carryOut(dx: number, dy: number): Carry {
  const carry: Carry = { map: Objects._mapId, list: [null], player: undefined };
  const playerTrack = Objects._tracks[Objects.PLAYER_LOCAL_ID];
  if (playerTrack) carry.player = playerTrack;
  for (const [, lid] of ipairs<number>(Objects._order)) {
    const eo = Objects._byId[lid];
    const tr = Objects._tracks[lid];
    if (eo && eo.visible && !eo.hidden && ((tr && !tr.done) || truthy(eo.foreignMap))) {
      shiftObject(eo, dx, dy);
      eo.foreignMap = eo.foreignMap ?? Objects._mapId;
      eo.foreignLid = eo.foreignLid ?? lid;
      eo.originLocalId = eo.originLocalId ?? lid;
      eo.originMapId = eo.originMapId ?? eo.foreignMap;
      if (eo.originMapGroup == null || eo.originMapNum == null) {
        // pcall(lazyReq, "src.import.gba.map_catalog")
        if (MapCatalog && MapCatalog.groupNumFor) {
          const [g, n] = MapCatalog.groupNumFor(eo.originMapId);
          if (g != null && n != null) {
            eo.originMapGroup = g;
            eo.originMapNum = n;
          }
        }
      }
      carry.list[len(carry.list) + 1] = { eo, track: tr };
    }
  }
  return carry;
}

// Lua: objects.lua:714
function carryIn(carry: Carry | null | undefined): void {
  if (!carry) return;
  Objects._foreign = {};
  if (carry.player) Objects._tracks[Objects.PLAYER_LOCAL_ID] = carry.player;
  for (const [i, c] of ipairs<any>(carry.list)) {
    const key = FOREIGN_BASE + i - 1;
    if (key >= Objects.PLAYER_LOCAL_ID) break;
    c.eo.localId = key;
    Objects._byId[key] = c.eo;
    Objects._order[len(Objects._order) + 1] = key;
    if (c.track) Objects._tracks[key] = c.track;
    Objects._foreign[c.eo.foreignMap + ":" + tostring(c.eo.foreignLid)] = key;
  }
}

// Lua: objects.lua:729
function foreignKey(mapId: unknown, localId: unknown): number | undefined {
  const f = Objects._foreign;
  return (f && f[tostring(mapId) + ":" + tostring(tonumber(localId) ?? localId)]) ?? undefined;
}

// Lua: objects.lua:734
function find(localIdIn: unknown): any {
  const localId = tonumber(localIdIn) ?? 0;
  if (Objects.isPlayer(localId)) {
    return Player();
  }
  return Objects._byId[localId];
}

// Lua: objects.lua:743
// src/event_object_movement.c:1234-1249 GetObjectEventIdByLocalIdAndMap / TryGetObjectEventIdByLocalIdAndMap
function findObjectByLocalIdAndMap(localIdIn: unknown, mapGroup: unknown, mapNum: unknown): any {
  const localId = tonumber(localIdIn) ?? 0;
  if (Objects.isPlayer(localId)) {
    return Player();
  }
  const g = tonumber(mapGroup);
  const n = tonumber(mapNum);
  // pcall(lazyReq, "src.import.gba.map_catalog")
  const targetMapId = (MapCatalog && g != null && n != null && MapCatalog.mapIdFor(g, n)) || undefined;

  for (const [, lid] of ipairs<number>(Objects._order)) {
    const eo = Objects._byId[lid];
    if (eo) {
      const idMatch = (eo.localId === localId) || (eo.originLocalId === localId) || (eo.foreignLid === localId);
      if (idMatch) {
        if (g != null && n != null) {
          if ((eo.originMapGroup === g && eo.originMapNum === n)
              || (targetMapId && (eo.originMapId === targetMapId || eo.foreignMap === targetMapId))) {
            return eo;
          } else if (!truthy(eo.foreignMap) && Objects._mapId == targetMapId && eo.localId === localId) {
            return eo;
          }
        } else {
          return eo;
        }
      }
    }
  }
  return undefined;
}

// Lua: objects.lua:775 -- src/event_object_movement.c:2089-2116
function on_named_map(mapGroup: unknown, mapNum: unknown): boolean {
  if (mapGroup == null || mapNum == null) return true;
  // pcall(lazyReq, "src.import.gba.map_catalog")
  if (!(MapCatalog && MapCatalog.mapIdFor)) return true;
  const engineId = MapCatalog.mapIdFor(tonumber(mapGroup), tonumber(mapNum));
  if (engineId == null) return false;
  return engineId === Objects._mapId;
}

// Lua: objects.lua:785 -- src/event_object_movement.c:1967, scrcmd.c:1139
function setSubpriority(localIdIn: unknown, mapGroup: unknown, mapNum: unknown, subpriority: unknown): boolean {
  const localId = tonumber(localIdIn) ?? 0;
  if (Objects.isPlayer(localId)) {
    const P = Player();
    if (P) {
      P.fixedPriority = true;
      P.subpriority = tonumber(subpriority) ?? 0;
      return true;
    }
  }
  const eo = Objects.findObjectByLocalIdAndMap(localId, mapGroup, mapNum)
    || (on_named_map(mapGroup, mapNum) ? Objects._byId[localId] : undefined);
  if (!eo) return false;
  eo.fixedPriority = true;
  eo.subpriority = tonumber(subpriority) ?? 0;
  eo.fixedClass = undefined;
  return true;
}

// Lua: objects.lua:805 -- src/event_object_movement.c:1982, scrcmd.c:1149
function resetSubpriority(localIdIn: unknown, mapGroup: unknown, mapNum: unknown): boolean {
  const localId = tonumber(localIdIn) ?? 0;
  if (Objects.isPlayer(localId)) {
    const P = Player();
    if (P) {
      P.fixedPriority = undefined;
      P.subpriority = undefined;
      return true;
    }
  }
  const eo = Objects.findObjectByLocalIdAndMap(localId, mapGroup, mapNum)
    || (on_named_map(mapGroup, mapNum) ? Objects._byId[localId] : undefined);
  if (!eo) return false;
  eo.fixedPriority = undefined;
  eo.subpriority = undefined;
  eo.fixedClass = undefined;
  return true;
}

// Lua: objects.lua:824
function listActive(_mod?: any, _game?: any, _mapId?: any): LuaTable {
  const ids: LuaTable = [null];
  for (const [, lid] of ipairs<number>(Objects._order)) {
    const eo = Objects._byId[lid];
    if (eo && eo.visible && !eo.hidden) {
      ids[len(ids) + 1] = lid;
    }
  }
  return ids;
}

const VIRT_DIR_FACE: Record<number, string> = { [1]: "down", [2]: "up", [3]: "left", [4]: "right" };

const drawList: LuaTable = [null];
const vrecs: Record<string | number, EO> = {};

// Lua: objects.lua:840
/** The drawable objects this frame: a sequence reused across calls. */
function forDraw(): LuaTable {
  const list = drawList;
  let n = 0;
  const order = Objects._order;
  for (let k = 1; order[k] != null; k++) {
    const lid = order[k];
    const eo = Objects._byId[lid];
    // src/event_object_movement.c:8014
    if (eo && eo.visible && !eo.hidden && !eo.invisible
        && (eo.foreignMap != null || !offMap(Objects._bounds, eo))) {
      n = n + 1;
      list[n] = eo;
    }
  }
  // src/event_object_movement.c:1719
  const slots = VirtualObjects.slots();
  for (let i = 1; i <= slots; i++) {
    const vo: any = VirtualObjects.nth(i);
    if (vo) {
      let vrec = vrecs[vo.id];
      if (!vrec) {
        vrec = { virtualId: vo.id, visible: true, hidden: false };
        vrecs[vo.id] = vrec;
      }
      const gid = tonumber(vo.graphicsId) ?? 0;
      vrec.cellX = tonumber(vo.x) ?? 0;
      vrec.cellY = tonumber(vo.y) ?? 0;
      vrec.elevation = tonumber(vo.elevation) ?? 3;
      vrec.facing = VIRT_DIR_FACE[tonumber(vo.direction) ?? -1] ?? "down";
      vrec.sprite = GfxIds.spriteFor(gid);
      vrec.graphicsId = gid;
      vrec.raiseY = tonumber(vo.y2) ?? 0;
      if (!offMap(Objects._bounds, vrec)) {
        n = n + 1;
        list[n] = vrec;
      }
    }
  }
  for (let i = len(list); i >= n + 1; i--) list[i] = null;
  return list;
}

// Lua: objects.lua:880
/** First visible EventObject standing on (tx, ty), or nil if moving onto it. */
function at(txIn: unknown, tyIn: unknown): EO | undefined {
  const tx = tonumber(txIn), ty = tonumber(tyIn);
  if (tx == null || ty == null) return undefined;
  const order = Objects._order;
  for (let k = 1; order[k] != null; k++) {
    const eo = Objects._byId[order[k]];
    if (eo && eo.visible && !eo.hidden) {
      // src/event_object_movement.c:1281
      const cx = eo.moving && eo.targetX != null ? eo.targetX : eo.cellX;
      const cy = eo.moving && eo.targetY != null ? eo.targetY : eo.cellY;
      if (cx === tx && cy === ty) {
        return eo;
      }
    }
  }
  return undefined;
}

// Lua: objects.lua:898 -- pokefirered/src/event_object_movement.c:8432 AreElevationsCompatible
function elevationsCompatible(aIn: unknown, bIn: unknown): boolean {
  const a = tonumber(aIn) ?? 0, b = tonumber(bIn) ?? 0;
  return a === 0 || b === 0 || a === b;
}

// Lua: objects.lua:904
/** True if any non-passable EO occupies (tx,ty) or is stepping onto it. */
function blocks(tx: number, ty: number, exceptLocalIdIn?: unknown, elevation?: unknown): boolean {
  const exceptLocalId = tonumber(exceptLocalIdIn);
  const order = Objects._order;
  for (let k = 1; order[k] != null; k++) {
    const lid = order[k];
    if (lid !== exceptLocalId) {
      const eo = Objects._byId[lid];
      if (eo && eo.visible && !eo.hidden && !eo.passable
          && Objects.elevationsCompatible(elevation, eo.currentElevation)) {
        if (eo.cellX === tx && eo.cellY === ty) return true;
        if (eo.moving && eo.targetX === tx && eo.targetY === ty) {
          return true;
        }
      }
    }
  }
  // pokefirered/src/union_room_player_avatar.c:475
  const slots = VirtualObjects.slots();
  for (let i = 1; i <= slots; i++) {
    const vo: any = VirtualObjects.nth(i);
    if (vo && vo.solid === true && tonumber(vo.x) === tx && tonumber(vo.y) === ty) return true;
  }
  return false;
}

// Lua: objects.lua:927 -- pokefirered/src/event_object_movement.c:4899
function playerBlocks(tx: number, ty: number, elevation?: unknown): boolean {
  const P = Player();
  if (!P) return false;
  if (!Objects.elevationsCompatible(elevation, P.currentElevation)) return false;
  if (P.cellX === tx && P.cellY === ty) return true;
  if (P.moving && P.targetX === tx && P.targetY === ty) return true;
  return false;
}

// Lua: objects.lua:936
function walkPhaseOf(eo: EO): number {
  if (!eo.moving) return 0;
  // pokefirered/src/event_object_movement.c:7040 MovementAction_DisableAnimation_Step0
  if (eo.inanimate) return 0;
  const frames = eo.stepFrames ?? WALK_FRAMES;
  const p = mod(eo.animClock, frames);
  const mid = Math.floor(frames / 2);
  return (p >= Math.floor(frames / 4) && p < mid + Math.floor(frames / 4)) ? 1 : 0;
}

// Lua: objects.lua:946
function walkPhase(eo: EO): number {
  return walkPhaseOf(eo);
}

// Lua: objects.lua:951 -- pokefirered/src/event_object_movement.c:8400
function updateElevation(eo: EO): void {
  const Coll = Collision();
  if (!(eo && Coll && Coll.nextElevation)) return;
  const mapDef = eo.mapDef ?? Coll._mapDef;
  let cx = eo.cellX, cy = eo.cellY;
  if (eo.moving) { cx = eo.targetX; cy = eo.targetY; }
  eo.currentElevation = Coll.nextElevation(mapDef, eo.currentElevation ?? 0,
    cx, cy, eo.cellX, eo.cellY);
}

// Lua: objects.lua:961
function beginStep(eo: EO, tx: number, ty: number): void {
  eo.moving = true;
  eo.progress = 0;
  eo.targetX = tx;
  eo.targetY = ty;
  Objects.updateElevation(eo);
  eo.stepFrames = WALK_FRAMES;
  eo.animClock = 0;
}

// Lua: objects.lua:971
function finishStep(eo: EO, game: any, ctx: any): void {
  eo.cellX = eo.targetX;
  eo.cellY = eo.targetY;
  eo.px = eo.cellX * CELL;
  eo.py = eo.cellY * CELL;
  eo.moving = false;
  eo.progress = 0;
  eo.stepFlip = !eo.stepFlip;
  if (eo.def) {
    eo.def.x = eo.cellX; eo.def.y = eo.cellY;
  }
  if (ctx) return;
  const Coll = Collision();
  const curElev = Coll && Coll.elevationAt ? Coll.elevationAt(eo.cellX, eo.cellY) : undefined;
  if (curElev != null && curElev !== 0 && curElev !== 15) {
    eo.elevation = curElev;
  }
  // src/trainer_see.c:94
  if (eo.sight && eo.sight > 0 && !eo.scriptBusy && !eo.frozen) {
    // pcall(lazyReq, "src.core.game3.trainer_sight")
    if (TrainerSight && TrainerSight.check) {
      try {
        TrainerSight.check(game, eo);
      } catch (e) {
        if (!stubbed(e, "TrainerSight.check")) throw e;
      }
    }
  }
}

// src/event_object_movement.c:8866
const STEP_PIXELS: Record<number, LuaTable> = {
  [16]: seq(1),
  [8]: seq(2),
  [6]: seq(2, 3, 3),
  [4]: seq(4),
  [2]: seq(8),
  // src/event_object_movement.c:9029
  [11]: seq(1, 2),
  // src/event_object_movement.c:8984
  [24]: seq(1, 1, 0),
  // src/event_object_movement.c:8959
  [32]: seq(1, 0),
};
const STEP_OFFSETS: Record<number, LuaTable> = {};
for (const [framesK, pat] of pairs<LuaTable>(STEP_PIXELS)) {
  const frames = framesK as number;
  const cum: LuaTable = [null];
  let n = 0;
  for (let k = 1; k <= frames; k++) {
    n = Math.min(CELL, n + pat[mod(k - 1, len(pat)) + 1]);
    cum[k] = n;
  }
  STEP_OFFSETS[frames] = cum;
}

// Lua: objects.lua:1021
function stepOffset(frames: number, progress: number, cells: number): number {
  const cum = cells === 1 ? STEP_OFFSETS[frames] : undefined;
  if (cum) return cum[Math.min(progress, frames)];
  return Math.floor(cells * CELL * Math.min(progress, frames) / frames);
}

// Lua: objects.lua:1027
function tickMotion(eo: EO, game: any, ctx?: any): boolean {
  Objects.updateElevation(eo);
  if (!eo.moving) return false;
  eo.progress = eo.progress + 1;
  eo.animClock = eo.animClock + 1;
  const frames = eo.stepFrames ?? WALK_FRAMES;
  const dx = eo.targetX - eo.cellX;
  const dy = eo.targetY - eo.cellY;
  const off = stepOffset(frames, eo.progress, Math.max(Math.abs(dx), Math.abs(dy)));
  eo.px = eo.cellX * CELL + (dx > 0 ? off : dx < 0 ? -off : 0);
  eo.py = eo.cellY * CELL + (dy > 0 ? off : dy < 0 ? -off : 0);
  const arc = eo.jumpArc;
  if (arc) {
    // pokeemerald/src/event_object_movement.c:8462
    const i = Math.floor((eo.progress - 1) / (2 ** arc.shift));
    eo.raiseY = arc.table[i + 1] ?? 0;
    if (arc.thenFace && eo.progress === Math.floor(arc.frames / 2)) eo.facing = arc.thenFace;
  }
  if (eo.progress >= frames) {
    if (arc) {
      eo.jumpArc = undefined;
      eo.raiseY = undefined;
    }
    finishStep(eo, game, ctx);
    return true;
  }
  return false;
}

// Lua: objects.lua:1057
/** Scripted one-cell step (no collision — FRLG applymovement forces). */
function scriptStep(eo: any, dir: string, run?: unknown, slow?: unknown, fast?: unknown): boolean {
  if (!eo) return false;
  const P = Player();
  if (eo === P) {
    return P.scriptStep && P.scriptStep(dir, run, slow, fast);
  }
  if (eo.moving) return false;
  const d = DELTA[dir];
  if (!d) return false;
  // pokefirered/src/event_object_movement.c:6796 MovementAction_LockFacingDirection_Step0
  if (!eo.facingLocked) eo.facing = dir;
  beginStep(eo, eo.cellX + d[0], eo.cellY + d[1]);
  // pokefirered/src/event_object_movement.c:5333 StartRunningAnim
  if (truthy(run)) eo.stepFrames = truthy(slow) ? RUN_SLOW_FRAMES : RUN_FRAMES;
  if (truthy(fast)) eo.stepFrames = RUN_FRAMES;
  eo.frozen = true;
  eo.scriptBusy = true;
  return true;
}

// Lua: objects.lua:1077
function scriptJump(eo: any, dir: string, distanceIn?: number, opts?: any): boolean {
  if (!eo) return false;
  const P = Player();
  if (eo === P) {
    return P.scriptJump && P.scriptJump(dir, distanceIn);
  }
  if (eo.moving) return false;
  const distance = distanceIn ?? 1;
  const d = DELTA[dir];
  if (!d) return false;
  eo.facing = dir;
  beginStep(eo, eo.cellX + d[0] * distance, eo.cellY + d[1] * distance);
  if (isRse()) Objects.startJumpArc(eo, distance, opts);
  eo.frozen = true;
  eo.scriptBusy = true;
  return true;
}

// pokeemerald/src/event_object_movement.c:8424
const JUMP_Y: Record<string, LuaTable> = {
  high: seq(-4, -6, -8, -10, -11, -12, -12, -12, -11, -10, -9, -8, -6, -4, 0, 0),
  low: seq(0, -2, -3, -4, -5, -6, -6, -6, -5, -5, -4, -3, -2, 0, 0, 0),
  normal: seq(-2, -4, -6, -8, -9, -10, -10, -10, -9, -8, -6, -5, -3, -2, 0, 0),
};

// Lua: objects.lua:1104 -- pokeemerald/src/event_object_movement.c:8454
function startJumpArc(eo: EO, distance: number, optsIn?: any): void {
  const opts = optsIn ?? {};
  const frames = distance === 2 ? 32 : 16;
  const kind = opts.type ?? ((distance === 1) ? "normal" : "high");
  eo.stepFrames = frames;
  eo.jumpArc = {
    table: JUMP_Y[kind] ?? JUMP_Y.high, shift: distance === 2 ? 1 : 0, frames,
    thenFace: opts.thenFace, shadow: true,
  };
}

// Lua: objects.lua:1116 -- pokefirered/src/event_object_movement.c:5351 InitNpcForWalkSlower
function pushStep(eo: EO | null | undefined, dir: string, frames?: number): boolean {
  const d = DELTA[dir];
  if (!eo || !d || eo.moving) return false;
  eo.facing = dir;
  beginStep(eo, eo.cellX + d[0], eo.cellY + d[1]);
  eo.stepFrames = frames ?? WALK_FRAMES * 2;
  return true;
}

// Lua: objects.lua:1125
function scriptFace(eo: any, dir: string): void {
  if (!eo) return;
  const P = Player();
  if (eo === P) {
    if (P.scriptFace) P.scriptFace(dir); else P.facing = dir;
    return;
  }
  // pokefirered/src/event_object_movement.c:2501 SetObjectEventDirection
  if (eo.facingLocked) return;
  eo.facing = dir;
}

// pokefirered/src/event_object_movement.c:5208 GetOppositeDirection
const OPPOSITE_DIR: Record<string, string> = { down: "up", up: "down", left: "right", right: "left" };

// Lua: objects.lua:1141 -- pokefirered/src/event_object_movement.c:4789 GetDirectionToFace
function directionToFace(x1: number, y1: number, x2: number, y2: number): string {
  if (x1 > x2) return "left";
  if (x1 < x2) return "right";
  if (y1 > y2) return "up";
  return "down";
}

// Lua: objects.lua:1148
function advanceTrack(lid: any, tr: Track, _game: any): void {
  if (tr.done) return;
  const eo = Objects.find(lid);
  if (tr.sleep && tr.sleep > 0) {
    tr.sleep = tr.sleep - 1;
    if (tr.sleep > 0) return;
  }
  // Wait until current step finishes.
  if (eo && eo.moving) return;
  if (eo === Player() && Player().moving) return;
  if (eo && eo.trackWait) {
    if (!eo.trackWait(eo)) return;
    eo.trackWait = undefined;
  }

  let act: any = tr.actions[tr.i];
  if (act == null || act === false) {
    tr.done = true;
    if (eo && eo !== Player()) {
      eo.scriptBusy = false;
    }
    if (tr.onDone) {
      const cb = tr.onDone;
      tr.onDone = undefined;
      cb();
    }
    return;
  }
  tr.i = tr.i + 1;
  if (typeof act === "string") {
    const sdir = match(act, "^walk_(.*)$") ?? match(act, "^step_(.*)$");
    if (sdir != null) {
      act = { kind: "step", dir: sdir };
    } else {
      const tdir = match(act, "^turn_(.*)$") ?? match(act, "^face_(.*)$");
      if (tdir != null) {
        act = { kind: "turn", dir: tdir };
      }
    }
  }
  if (act !== null && typeof act === "object") {
    if (act.kind === "step") {
      if (eo === Player()) {
        if (Player().scriptStep) Player().scriptStep(act.dir, act.run, act.slow, act.fast);
      } else if (eo) {
        Objects.scriptStep(eo, act.dir, act.run, act.slow, act.fast);
      }
    } else if (act.kind === "jump") {
      if (eo === Player()) {
        if (Player().scriptJump) {
          Player().scriptJump(act.dir, act.distance ?? 1);
        } else if (Player().scriptStep) {
          for (let _ = 1; _ <= (act.distance ?? 1); _++) {
            Player().scriptStep(act.dir);
          }
        }
      } else if (eo) {
        if (Objects.scriptJump) {
          Objects.scriptJump(eo, act.dir, act.distance ?? 1,
            { thenFace: act.thenFace, type: act.jumpType });
        } else {
          Objects.scriptStep(eo, act.dir);
        }
      }
    } else if (act.kind === "step_diagonal") {
      Objects.scriptDiagonal(eo, act);
    } else if (act.kind === "levitate") {
      Objects.setLevitate(eo, act.on, act.atTop);
    } else if (act.kind === "figure8") {
      Objects.startFigure8(eo);
    } else if (act.kind === "lock_anim") {
      // pokeemerald/src/event_object_movement.c:8809
      if (eo && eo !== Player()) {
        eo.inanimate = truthy(act.locked);
        eo.facingLocked = truthy(act.locked);
      }
    } else if (act.kind === "reflection") {
      // pokeemerald/src/event_object_movement.c:6617
      if (eo) eo.hideReflection = truthy(act.hidden);
    } else if (act.kind === "jump_landing_effect") {
      // pokeemerald/src/event_object_movement.c:6444
      if (eo === Player()) {
        // pcall(lazyReq, "src.core.game3.field_effects_rse"): no such module in
        // the port (Emerald only), so the require fails and nothing happens.
        let okF = true, FxRse: any;
        try { FxRse = lazyReqMissing("src.core.game3.field_effects_rse"); } catch { okF = false; }
        if (okF && FxRse) FxRse.setJumpLandingEffect(act.on);
      } else if (eo) {
        eo.disableJumpLanding = !truthy(act.on);
      }
    } else if (act.kind === "reveal_trainer") {
      Objects.revealTrainer(eo);
    } else if (act.kind === "turn") {
      Objects.scriptFace(eo, act.dir);
    } else if (act.kind === "face_player") {
      // pokefirered/src/event_object_movement.c:6772 MovementAction_FacePlayer_Step0
      if (eo && eo !== Player()) {
        let dir = directionToFace(eo.cellX, eo.cellY, Player().cellX, Player().cellY);
        if (truthy(act.away)) dir = OPPOSITE_DIR[dir]!;
        Objects.scriptFace(eo, dir);
      }
    } else if (act.kind === "lock_facing") {
      // pokefirered/src/event_object_movement.c:6796 MovementAction_LockFacingDirection_Step0
      if (eo && eo !== Player()) eo.facingLocked = truthy(act.locked);
    } else if (act.kind === "animate") {
      // pokefirered/src/event_object_movement.c:7040 MovementAction_DisableAnimation_Step0
      if (eo && eo !== Player()) eo.inanimate = truthy(act.inanimate);
    } else if (act.kind === "remove_obstacle") {
      // pokefirered/src/event_object_movement.c:7135 MovementAction_RockSmashBreak_Step0
      tr.sleep = act.frames ?? 32;
    } else if (act.kind === "face_original") {
      if (eo && eo !== Player() && eo.def) {
        // src/event_object_movement.c:7016
        const origFace = eo.def.movementType != null ? GfxIds.initialFacing(eo.movementType)
          : facingFromDef(eo.def);
        Objects.scriptFace(eo, origFace);
      }
    } else if (act.kind === "bow") {
      if (eo && eo !== Player()) {
        eo.bowFrames = act.frames ?? 48;
        eo.facing = "down";
      }
      tr.sleep = act.frames ?? 48;
    } else if (act.kind === "emote") {
      if (eo) {
        // pcall(lazyReq, "src.core.game3.field_effects")
        if (FieldEffects) {
          try {
            if (FieldEffects.startEmote) {
              FieldEffects.startEmote(eo, act.emoteType ?? "exclamation");
            } else if (FieldEffects.startExclamation) {
              FieldEffects.startExclamation(eo);
            }
          } catch (e) {
            if (!stubbed(e, "FieldEffects.startEmote") && !stubbed(e, "FieldEffects.startExclamation")) throw e;
          }
        }
      }
      tr.sleep = act.frames ?? 60;
    } else if (act.kind === "sleep") {
      tr.sleep = act.frames ?? 1;
    } else if (act.kind === "hide") {
      // pokefirered/src/event_object_movement.c:7054
      if (eo === Player()) {
        Player().setVisible(false);
      } else if (eo) {
        eo.hidden = true;
        eo.visible = false;
      }
    } else if (act.kind === "show") {
      // pokefirered/src/event_object_movement.c:7061
      if (eo === Player()) {
        Player().setVisible(true);
      } else if (eo) {
        eo.hidden = false;
        eo.visible = true;
      }
    }
  }
}

// Lua: objects.lua:1302
function applyMovement(localId: unknown, stream: unknown, onDone?: (() => void) | null): void {
  const lid: any = tonumber(localId) ?? localId;
  // Seam: Movement.actionsFromBytes returns a 0-based array; tracks hold a
  // Lua sequence.
  const actions = fromArray(Movement.actionsFromBytes(stream));
  const eo = Objects.find(lid);
  if (eo && eo !== Player()) {
    eo.frozen = true;
    eo.scriptBusy = true;
  }
  Objects._tracks[lid] = {
    actions,
    i: 1,
    sleep: 0,
    done: false,
    onDone,
  };
  advanceTrack(lid, Objects._tracks[lid]!, undefined);
}

// Lua: objects.lua:1320
/** `actions` is a Lua sequence ([null, a, b]) of action tables or strings. */
function startTrack(localId: unknown, actions: LuaTable, onDone?: (() => void) | null): void {
  const lid: any = tonumber(localId) ?? localId;
  const eo = Objects.find(lid);
  if (eo && eo !== Player()) {
    eo.frozen = true;
    eo.scriptBusy = true;
  }
  if (actions == null || len(actions) === 0) {
    if (eo && eo !== Player()) {
      eo.scriptBusy = false;
    }
    if (onDone) onDone();
    return;
  }
  Objects._tracks[lid] = {
    actions,
    i: 1,
    sleep: 0,
    done: false,
    onDone,
  };
  advanceTrack(lid, Objects._tracks[lid]!, undefined);
}

// Lua: objects.lua:1344
function pollMovement(localId: unknown): boolean {
  // Tracks advance in Objects.update. Missing track ≠ done: returning true
  // here after loadMap wiped tracks was skipping Bill's walk_up / MeetCelio.
  const lid: any = tonumber(localId) ?? localId;
  if (lid === 0) {
    let any = false;
    const tracks = Objects._tracks;
    for (const k in tracks) {
      const tr = tracks[k];
      if (tr == null) continue;
      any = true;
      if (!tr.done) return false;
    }
    return any;
  }
  const tr = Objects._tracks[lid];
  if (!tr) return false;
  return tr.done === true;
}

// Lua: objects.lua:1361
function clearMovements(): void {
  Objects._tracks = {};
}

// Lua: objects.lua:1365
function sine(i: number): number {
  const v = 256 * Math.sin(mod(i, 256) * Math.PI / 128);
  return v >= 0 ? Math.floor(v + 0.5) : -Math.floor(-v + 0.5);
}

// Lua: objects.lua:1371 -- src/event_object_movement.c:7812
function raiseHandTick(eo: EO): void {
  let rh = eo.raiseHandState;
  if (!rh) {
    rh = { mode: 0, angle: 0, hops: 0, timer: 0, swing: 0 };
    eo.raiseHandState = rh;
    eo.raiseHand = true;
  }
  const mt = tonumber(eo.movementType) ?? 0;
  if (mt === 0x4F) {
    rh.swing = mod(rh.swing + 4, 256);
    eo.raiseX = Math.floor(sine(rh.swing) / 128);
    return;
  }
  if (mt !== 0x4E) return;
  if (rh.mode === 0) {
    rh.angle = rh.angle + 10;
    if (rh.angle > 127) {
      rh.angle = 0;
      rh.hops = rh.hops + 1;
      rh.mode = rh.hops;
      eo.raiseHand = false;
    }
    eo.raiseY = -Math.floor(3 * sine(rh.angle) / 128);
  } else if (rh.mode === 1) {
    rh.timer = rh.timer + 1;
    if (rh.timer > 16) {
      rh.timer = 0;
      eo.raiseHand = true;
      rh.mode = 0;
    }
  } else {
    rh.timer = rh.timer + 1;
    if (rh.timer > 80) {
      eo.raiseHandState = undefined;
    }
  }
}

// Lua: objects.lua:1409
function checkSight(game: any, eo: EO): void {
  // pcall(lazyReq, "src.core.game3.trainer_sight")
  if (TrainerSight && TrainerSight.check) {
    try {
      TrainerSight.check(game, eo);
    } catch (e) {
      if (!stubbed(e, "TrainerSight.check")) throw e;
    }
  }
}

// Lua: objects.lua:1417 -- src/event_object_movement.c:4830
function stepCollision(eo: EO, game: any, ctx: any, dir: string): "range" | "blocked" | undefined {
  const d = DELTA[dir]!;
  const tx = eo.cellX + d[0], ty = eo.cellY + d[1];
  // src/event_object_movement.c:4861
  const rx = tonumber(eo.rangeX ?? (eo.radius ? eo.radius.x : undefined)) ?? 0;
  const ry = tonumber(eo.rangeY ?? (eo.radius ? eo.radius.y : undefined)) ?? 0;
  if ((rx !== 0 && Math.abs(tx - eo.homeX) > rx) || (ry !== 0 && Math.abs(ty - eo.homeY) > ry)) {
    return "range";
  }
  let ok: boolean;
  if (ctx) {
    const Coll = Collision();
    ok = truthy(ctx.canEnter(tx, ty, eo.cellX, eo.cellY, dir))
      && !truthy(ctx.blocks(tx, ty, eo.localId));
    if (ok && eo.mapDef && Coll.directionallyImpassableOn(
        eo.mapDef, eo.cellX, eo.cellY, tx, ty, dir)) {
      ok = false;
    }
    // pokefirered/src/event_object_movement.c:4839
    if (ok && eo.mapDef && Coll.elevationMismatchOn(eo.mapDef, eo.currentElevation, tx, ty)) {
      ok = false;
    }
  } else {
    const Coll = Collision();
    // pokefirered/src/event_object_movement.c:8346 IsElevationMismatchAt
    const onWater = Coll.isWater(eo.cellX, eo.cellY);
    ok = Coll.canEnter(game, tx, ty,
      { fromX: eo.cellX, fromY: eo.cellY, dir, surfing: onWater,
        elevation: eo.currentElevation })[0];
    if (ok && Coll.isWater(tx, ty) !== onWater) ok = false;
    // pokefirered/src/event_object_movement.c:4841 DoesObjectCollideWithObjectAt
    if (Objects.playerBlocks(tx, ty, eo.currentElevation)) ok = false;
    if (Objects.blocks(tx, ty, eo.localId, eo.currentElevation)) ok = false;
  }
  if (!ok) return "blocked";
  return undefined;
}

// Lua: objects.lua:1456 -- src/event_object_movement.c:3884
function walkOrInPlace(eo: EO, dir: string, collision: unknown): void {
  eo.facing = dir;
  if (collision) {
    beginStep(eo, eo.cellX, eo.cellY);
  } else {
    const d = DELTA[dir]!;
    beginStep(eo, eo.cellX + d[0], eo.cellY + d[1]);
  }
}

// Lua: objects.lua:1467 -- src/event_object_movement.c:2770
function playerCellFor(ctx: any): [number, number] {
  const P = Player();
  const px = P.moving && P.targetX != null ? P.targetX : P.cellX;
  const py = P.moving && P.targetY != null ? P.targetY : P.cellY;
  return [px - (ctx ? (ctx.ox ?? 0) : 0), py - (ctx ? (ctx.oy ?? 0) : 0)];
}

// Lua: objects.lua:1474
function trainerCloseToRunningPlayer(eo: EO, ctx: any): boolean {
  const P = Player();
  if (!(P && P.running) || P.biking || P.surfing) return false;
  const tt = tonumber(eo.trainerType) ?? 0;
  if (tt !== 1 && tt !== 3) return false;
  const r = tonumber(eo.sight) ?? 0;
  const [px, py] = playerCellFor(ctx);
  return Math.abs(px - eo.cellX) <= r && Math.abs(py - eo.cellY) <= r;
}

// Lua: objects.lua:1485 -- src/event_object_movement.c:2801
function vectorDirection(dx: number, dy: number): string {
  if (Math.abs(dx) > Math.abs(dy)) return dx < 0 ? "left" : "right";
  return dy < 0 ? "up" : "down";
}

// Lua: objects.lua:1490
function southNorth(dy: number): string { return dy < 0 ? "up" : "down"; }
// Lua: objects.lua:1491
function westEast(dx: number): string { return dx < 0 ? "left" : "right"; }

// src/data/object_events/movement_type_func_tables.h:185
const FOLLOW: Record<number, (dx: number, dy: number) => string> = {
  [0]: vectorDirection,
  // Lua: objects.lua:1496
  [1]: (_, dy) => southNorth(dy),
  // Lua: objects.lua:1497
  [2]: (dx) => westEast(dx),
  // Lua: objects.lua:1498
  [3]: (dx, dy) => {
    let d = vectorDirection(dx, dy);
    if (d === "down") { d = westEast(dx); if (d === "right") d = "up"; }
    else if (d === "right") { d = southNorth(dy); if (d === "down") d = "up"; }
    return d;
  },
  // Lua: objects.lua:1504
  [4]: (dx, dy) => {
    let d = vectorDirection(dx, dy);
    if (d === "down") { d = westEast(dx); if (d === "left") d = "up"; }
    else if (d === "left") { d = southNorth(dy); if (d === "down") d = "up"; }
    return d;
  },
  // Lua: objects.lua:1510
  [5]: (dx, dy) => {
    let d = vectorDirection(dx, dy);
    if (d === "up") { d = westEast(dx); if (d === "right") d = "down"; }
    else if (d === "right") { d = southNorth(dy); if (d === "up") d = "down"; }
    return d;
  },
  // Lua: objects.lua:1516
  [6]: (dx, dy) => {
    let d = vectorDirection(dx, dy);
    if (d === "up") { d = westEast(dx); if (d === "left") d = "down"; }
    else if (d === "left") { d = southNorth(dy); if (d === "up") d = "down"; }
    return d;
  },
  // Lua: objects.lua:1522
  [7]: (dx, dy) => {
    let d = vectorDirection(dx, dy);
    if (d === "right") d = southNorth(dy);
    return d;
  },
  // Lua: objects.lua:1527
  [8]: (dx, dy) => {
    let d = vectorDirection(dx, dy);
    if (d === "left") d = southNorth(dy);
    return d;
  },
  // Lua: objects.lua:1532
  [9]: (dx, dy) => {
    let d = vectorDirection(dx, dy);
    if (d === "down") d = westEast(dx);
    return d;
  },
  // Lua: objects.lua:1537
  [10]: (dx, dy) => {
    let d = vectorDirection(dx, dy);
    if (d === "up") d = westEast(dx);
    return d;
  },
};

// Lua: objects.lua:1545 -- src/event_object_movement.c:2992
function followDirection(eo: EO, follow: number, ctx: any): string {
  const [px, py] = playerCellFor(ctx);
  const fn = FOLLOW[follow] ?? FOLLOW[0]!;
  return fn(px - eo.cellX, py - eo.cellY);
}

// Lua: objects.lua:1552
// Seam: `t` is a 0-based array (gfx_ids.ts's dirs / DELAYS, dirsForRange), so
// Brian's t[(Random() % #t) + 1] is t[Random() % t.length].
function pick<T>(t: readonly T[]): T {
  // idleRng = lazyReq("src.core.game3.rng")
  return t[Rng.Random() % t.length]!;
}

// tostring(movement):upper(), memoised (idleTick runs per object per frame).
const UPPER_MOVEMENT: Record<string, string> = {};
// Lua: objects.lua:1558 (the __index metamethod)
function upperMovement(k: unknown): string {
  const key = k as string;
  let v = UPPER_MOVEMENT[key];
  if (v == null) {
    v = tostring(k).toUpperCase();
    UPPER_MOVEMENT[key] = v;
  }
  return v;
}

// Lua: objects.lua:1564
function idleTick(eo: EO, game: any, ctx?: any): void {
  if (eo.frozen || eo.scriptBusy || eo.moving || eo.hidden || !eo.visible) {
    return;
  }
  // package.loaded["src.core.game3.field"]
  if (Field && Field.locked) return;
  // package.loaded["src.ui.game3.hud"]
  if (Hud && Hud.isMenuOpen && Hud.isMenuOpen()) return;
  if (eo.movement === "RAISE_HAND") {
    raiseHandTick(eo);
    return;
  }

  const mv = upperMovement(eo.movement ?? "STAY");
  if (mv === "STAY") return;
  if (mv === "IN_PLACE") {
    // pokeemerald/src/event_object_movement.c:4422
    const frames = (eo.spec && eo.spec.frames) ?? WALK_FRAMES;
    beginStep(eo, eo.cellX, eo.cellY);
    eo.stepFrames = frames;
    return;
  }
  let spec = eo.spec;
  if (!spec || spec.movement !== mv) {
    spec = { movement: mv, dirs: dirsForRange(eo.range), delays: "MEDIUM", follow: 0 };
  }

  if (mv === "BACK_FORTH") {
    // src/event_object_movement.c:3849
    let dir: string = (eo.seqIndex ?? 0) !== 0 ? OPPOSITE_DIR[spec.face]! : spec.face;
    if ((eo.seqIndex ?? 0) !== 0 && eo.cellX === eo.homeX && eo.cellY === eo.homeY) {
      eo.seqIndex = 0;
      dir = OPPOSITE_DIR[dir]!;
    }
    let c = stepCollision(eo, game, ctx, dir);
    if (c === "range") {
      eo.seqIndex = (eo.seqIndex ?? 0) + 1;
      dir = OPPOSITE_DIR[dir]!;
      c = stepCollision(eo, game, ctx, dir);
    }
    walkOrInPlace(eo, dir, c);
    return;
  }

  if (mv === "SEQUENCE") {
    // src/event_object_movement.c:3949
    let idx = eo.seqIndex ?? 0;
    if (idx === spec.skipFrom && ((spec.skipAxis === "x" && eo.cellX === eo.homeX)
        || (spec.skipAxis === "y" && eo.cellY === eo.homeY))) {
      idx = spec.skipFrom + 1;
    }
    // src/event_object_movement.c:3914
    if (idx === 3 && eo.cellX === eo.homeX && eo.cellY === eo.homeY) idx = 0;
    // Seam: gfx_ids.ts's route is 0-based (Brian: spec.route[idx + 1]).
    let dir: string = spec.route[idx];
    let c = stepCollision(eo, game, ctx, dir);
    if (c === "range") {
      idx = mod(idx + 1, 4);
      dir = spec.route[idx];
      c = stepCollision(eo, game, ctx, dir);
    }
    eo.seqIndex = idx;
    walkOrInPlace(eo, dir, c);
    return;
  }


  if (mv === "LOOK" || mv === "LOOK_AROUND" || mv === "ROTATE") {
    // src/event_object_movement.c:3044
    const close = trainerCloseToRunningPlayer(eo, ctx);
    if (eo.idleTimer == null) {
      eo.idleTimer = mv === "ROTATE" ? 48 : pick(GfxIds.DELAYS[spec.delays ?? "MEDIUM"]!);
    }
    eo.idleTimer = eo.idleTimer - 1;
    if (eo.idleTimer > 0 && !close) return;
    const oldFacing = eo.facing;
    // src/event_object_movement.c:2992
    let dir: string | false = close && followDirection(eo, spec.follow ?? 0, ctx);
    if (!dir) {
      const nxt = mv === "ROTATE" ? spec.next[eo.facing] : undefined;
      dir = nxt != null ? nxt as string : pick<string>(spec.dirs);
    }
    eo.facing = dir;
    eo.idleTimer = mv === "ROTATE" ? 48 : pick(GfxIds.DELAYS[spec.delays ?? "MEDIUM"]!);
    if (!ctx && eo.facing !== oldFacing && eo.sight && eo.sight > 0) {
      checkSight(game, eo);
    }
    return;
  }

  if (mv === "WALK") {
    // src/event_object_movement.c:2716
    if (eo.idleTimer == null) eo.idleTimer = pick(GfxIds.DELAYS.MEDIUM!);
    eo.idleTimer = eo.idleTimer - 1;
    if (eo.idleTimer > 0) return;
    // src/event_object_movement.c:2731
    const dir = pick<string>(spec.dirs ?? dirsForRange(eo.range));
    eo.facing = dir;
    eo.idleTimer = pick(GfxIds.DELAYS.MEDIUM!);
    if (stepCollision(eo, game, ctx, dir)) {
      if (!ctx && eo.sight && eo.sight > 0) checkSight(game, eo);
      return;
    }
    const d = DELTA[dir]!;
    beginStep(eo, eo.cellX + d[0], eo.cellY + d[1]);
    // src/event_object_movement.c:8959
    if (spec.slow) eo.stepFrames = WALK_FRAMES * 2;
  }
}

const trackIds: any[] = [null], trackRefs: (Track | null)[] = [null], trackActors: any[] = [null];

// Lua: objects.lua:1676
function fadeAlpha(eo: EO): number | undefined {
  const n = eo.fadeIn;
  if (n == null) return undefined;
  return (n + 1) / Objects.FADE_FRAMES;
}

// Lua: objects.lua:1682
function beginFadeIn(seen: Record<string | number, unknown>): void {
  for (const [, lid] of ipairs<number>(Objects._order)) {
    const eo = Objects._byId[lid];
    if (eo && eo.foreignMap == null && !Objects.isPlayer(lid)
        && eo.visible && !eo.hidden && !truthy(seen[lid])
        && Objects.inCameraView(eo)) {
      if (eo.berryTree) {
        eo.fadeIn = 0; eo.fadeHold = true;
      } else if (!eo.invisible) {
        eo.fadeIn = 0;
      }
    }
  }
}

// Lua: objects.lua:1697
function tickFade(eo: EO): void {
  let n = eo.fadeIn;
  if (n != null) {
    if (eo.fadeHold) {
      const bt = eo.berryTree;
      if (bt && !bt.init) return;
      eo.fadeHold = undefined;
      if (!(bt && bt.visible)) {
        eo.fadeIn = undefined;
        return;
      }
    }
    n = n + 1;
    eo.fadeIn = n < Objects.FADE_FRAMES ? n : undefined;
  }
}

// Lua: objects.lua:1715
function update(game: any): void {
  let count = 0;
  const tracks = Objects._tracks;
  for (const k in tracks) {
    const tr = tracks[k];
    if (tr == null) continue;
    // pairs() gives integer keys back as numbers
    const lid = tonumber(k) ?? k;
    count = count + 1;
    trackIds[count] = lid; trackRefs[count] = tr; trackActors[count] = Objects.find(lid);
  }
  // pokeemerald/src/event_object_movement.c:2167
  for (let i = 1; i <= count; i++) {
    const tr = trackRefs[i]!, eo = trackActors[i];
    const lid = (eo && eo.localId != null ? eo.localId : undefined) ?? trackIds[i];
    trackIds[i] = null; trackRefs[i] = null; trackActors[i] = null;
    if (Objects._tracks[lid] === tr && (!eo || Objects.find(lid) === eo)) {
      advanceTrack(lid, tr, game);
    }
  }
  const order = Objects._order;
  for (let k = 1; order[k] != null; k++) {
    const eo = Objects._byId[order[k]];
    if (eo) {
      if (eo.bowFrames && eo.bowFrames > 0) {
        eo.bowFrames = eo.bowFrames - 1;
        if (eo.bowFrames <= 0) eo.bowFrames = undefined;
      }
      tickFade(eo);
      tickMotion(eo, game);
      idleTick(eo, game);
      if (eo.rseKind || eo.levitate || eo.fig8) Objects.tickRse(eo);
    }
  }
}

// Lua: objects.lua:1746 -- pokeemerald/src/event_object_movement.c:5144
function scriptDiagonal(eo: any, act: any): boolean {
  if (!eo || eo === Player() || eo.moving) return false;
  // Seam: Movement's step_diagonal `dirs` is 0-based (Brian: act.dirs[1]).
  if (!eo.facingLocked) eo.facing = (act.dirs && act.dirs[0]) || eo.facing;
  beginStep(eo, eo.cellX + (act.dx ?? 0), eo.cellY + (act.dy ?? 0));
  if (truthy(act.slow)) eo.stepFrames = WALK_FRAMES * 2;
  eo.frozen = true;
  eo.scriptBusy = true;
  return true;
}

// Lua: objects.lua:1757 -- pokeemerald/src/event_object_movement.c:8895
function setLevitate(eo: any, on: unknown, atTop: unknown): void {
  if (!eo || eo === Player()) return;
  if (truthy(on)) {
    eo.levitate = { t: 0, d: -1 };
    return;
  }
  if (truthy(atTop)) {
    // pokeemerald/src/event_object_movement.c:7307
    eo.trackWait = (o: EO): boolean => {
      if ((o.raiseY ?? 0) === 0) {
        o.levitate = undefined;
        return true;
      }
      return false;
    };
    return;
  }
  eo.levitate = undefined;
  eo.raiseY = undefined;
}

// pokeemerald/src/event_object_movement.c:8347
const FIG8_X: LuaTable = seq(
  1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 2, 2, 1, 2, 2, 1, 2, 2, 1, 2, 1, 1,
  2, 1, 1, 2, 1, 1, 2, 1, 1, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
  0, 1, 1, 1, 0, 1, 1, 0, 1, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0,
);
const FIG8_Y: LuaTable = seq(
  0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1, 0, 1, 1, 0, 1, 1, 0, 1, 1,
  0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, -1, 0, 0, -1, 0, 0, -1, 0, -1, -1, 0, -1, -1, 0, -1, -1, -1, -1, -1, -1, -1, -2,
);

// Lua: objects.lua:1791
function startFigure8(eo: any): void {
  if (!eo || eo === Player()) return;
  eo.fig8 = { i: 0, part: 0, x2: 0, y2: 0 };
  eo.trackWait = (o: EO): boolean => o.fig8 == null;
}

// Lua: objects.lua:1798 -- pokeemerald/src/event_object_movement.c:8387
function figure8Step(eo: EO): void {
  const f = eo.fig8;
  const n = len(FIG8_X);
  const j = (n - 1) - f.i;
  if (f.part === 0) {
    f.x2 = f.x2 + FIG8_X[f.i + 1]; f.y2 = f.y2 + FIG8_Y[f.i + 1];
  } else if (f.part === 1) {
    f.x2 = f.x2 - FIG8_X[j + 1]; f.y2 = f.y2 + FIG8_Y[j + 1];
  } else if (f.part === 2) {
    f.x2 = f.x2 - FIG8_X[f.i + 1]; f.y2 = f.y2 + FIG8_Y[f.i + 1];
  } else {
    f.x2 = f.x2 + FIG8_X[j + 1]; f.y2 = f.y2 + FIG8_Y[j + 1];
  }
  f.i = f.i + 1;
  if (f.i === n) {
    f.i = 0;
    f.part = f.part + 1;
  }
  if (f.part === 4) {
    eo.fig8 = undefined;
    eo.raiseX = undefined; eo.raiseY = undefined;
    return;
  }
  eo.raiseX = f.x2; eo.raiseY = f.y2;
}

// pokeemerald/src/event_object_movement.c:3075
const MT_BERRY_TREE = 0x0C;
// pokeemerald/include/constants/event_object_movement.h:61
const MT_TREE_DISGUISE = 0x39;
const MT_MOUNTAIN_DISGUISE = 0x3A;
const MT_BURIED = 0x3F;

// pokeemerald/src/event_object_movement.c:1153 (unused here since
// initRseKind moved to object_prepare; kept as in Lua)
const COPY_TYPES: Record<number, { init: string; grass?: boolean }> = {
  [0x35]: { init: "up" }, [0x36]: { init: "down" }, [0x37]: { init: "left" }, [0x38]: { init: "right" },
  [0x3B]: { init: "up", grass: true }, [0x3C]: { init: "down", grass: true },
  [0x3D]: { init: "left", grass: true }, [0x3E]: { init: "right", grass: true },
};
void COPY_TYPES;
const DIR_IDX: Record<string, number> = { down: 1, up: 2, left: 3, right: 4 };
const IDX_DIR: LuaTable = seq("down", "up", "left", "right");
// pokeemerald/src/event_object_movement.c:1124
const COPY_FOR: LuaTable = seq(
  seq(2, 1, 4, 3), seq(1, 2, 3, 4), seq(3, 4, 2, 1), seq(4, 3, 1, 2),
);
const COPY_TO: LuaTable = seq(
  seq(2, 1, 4, 3), seq(1, 2, 3, 4), seq(4, 3, 1, 2), seq(3, 4, 2, 1),
);

// Lua: objects.lua:1850 -- pokeemerald/src/event_object_movement.c:5012
function copyDirection(copyInit: unknown, playerInit: unknown, playerMove: unknown): string | undefined {
  const pi = DIR_IDX[playerInit as string], pm = DIR_IDX[playerMove as string], ci = DIR_IDX[copyInit as string];
  if (!(pi && pm && ci)) return undefined;
  return IDX_DIR[COPY_TO[ci][COPY_FOR[pi][pm]]];
}

// Lua: objects.lua:1859 -- pokeemerald/src/event_object_movement.c:1890
function setBerryTreeGraphics(eo: EO, bt: any, tree: any): void {
  const stage = (tree && tree.stage) ?? 0;
  eo.invisible = true;
  bt.visible = false;
  if (stage === 0) return;
  bt.visible = true;
  const berryStage = stage - 1;
  // NOT FAITHFUL: Emerald only (field_effects_rse is not in the port; this
  // require fails).
  const FxRse = lazyReqMissing("src.core.game3.field_effects_rse");
  const m = FxRse.berryManifest();
  const berry = tonumber(tree.berry) ?? 1;
  const entry = m && m.trees && (m.trees[berry] ?? m.trees[1]);
  const st = entry && entry.stages && entry.stages[berryStage + 1];
  if (entry && st) {
    bt.tree = entry;
    const cmds: LuaTable = [null];
    for (const [, a] of ipairs<any>(st.anim ?? [null])) cmds[len(cmds) + 1] = seq<any>("frame", a.frame, a.duration);
    cmds[len(cmds) + 1] = seq<any>("jump", 0);
    bt.anim = FxRse.anim(cmds);
    eo.graphicsId = st.gfxId ?? eo.graphicsId;
  }
  bt.animNum = berryStage;
  bt.gfxKey = tostring(tree.berry) + ":" + tostring(stage);
}

// Lua: objects.lua:1884 -- pokeemerald/src/event_object_movement.c:3093
function berryTreeTick(eo: EO): void {
  const bt = eo.berryTree;
  // pcall(lazyReq, "src.core.game3.rse.berry_trees"): no such module in the
  // port (Emerald only), so the require fails and this returns.
  let okB = true, BerryTrees: any;
  try { BerryTrees = lazyReqMissing("src.core.game3.rse.berry_trees"); } catch { okB = false; }
  if (!(okB && BerryTrees && bt)) return;
  const tree = BerryTrees.peek(undefined, bt.id);
  const stage = (tree && tree.stage) ?? 0;
  const FxRse = lazyReqMissing("src.core.game3.field_effects_rse");
  if (!bt.init) {
    // pokeemerald/src/event_object_movement.c:3075
    bt.init = true; bt.func = "normal";
    setBerryTreeGraphics(eo, bt, tree);
    return;
  }
  if (bt.func === "sparkle" || bt.func === "sparkle_end") {
    // pokeemerald/src/event_object_movement.c:3154
    bt.timer = bt.timer + 1;
    bt.visible = mod(Math.floor(bt.timer / 2), 2) === 0 && bt.animNum != null;
    if (bt.timer > 64) {
      if (bt.func === "sparkle") {
        setBerryTreeGraphics(eo, bt, tree);
        bt.func = "sparkle_end"; bt.timer = 0;
      } else {
        bt.func = "normal";
        bt.visible = stage !== 0;
      }
    }
    return;
  }
  if (stage === 0) {
    if (!bt.justPicked && bt.animNum === 4) {
      FxRse.startBerryTreeSparkle(eo.cellX, eo.cellY);
    }
    bt.animNum = 0;
    bt.visible = false;
    return;
  }
  bt.visible = true;
  if (bt.animNum !== stage - 1) {
    // pokeemerald/src/event_object_movement.c:3139
    bt.func = "sparkle"; bt.timer = 0;
    FxRse.startBerryTreeSparkle(eo.cellX, eo.cellY);
    return;
  }
  if (bt.gfxKey !== tostring(tree.berry) + ":" + tostring(stage)) setBerryTreeGraphics(eo, bt, tree);
}

// Lua: objects.lua:1930
function isPokeGrass(x: number, y: number): boolean {
  const Coll = Collision();
  const b = Coll && Coll.behavior ? Coll.behavior(x, y) : undefined;
  return b != null && (b === MB.id("TALL_GRASS") || b === MB.id("LONG_GRASS"));
}

// Lua: objects.lua:1938 -- pokeemerald/src/event_object_movement.c:4168
function copyTick(eo: EO): void {
  const c = eo.copy;
  const P = Player();
  if (!(c && P)) return;
  if (c.playerInit == null) c.playerInit = P.facing;
  const moving = truthy(P.moving);
  const started = moving && !c.wasMoving;
  const finished = c.wasMoving && !moving;
  c.wasMoving = moving;
  // pcall(lazyReq, "src.core.game3.faraway_island"): no such module in the
  // port (Emerald only), so the require fails and mew is false.
  let okF = true, Faraway: any;
  try { Faraway = lazyReqMissing("src.core.game3.faraway_island"); } catch { okF = false; }
  const mew = okF && Faraway && Faraway.isMew(eo);
  if (finished && mew) Faraway.updateStepCounter();
  if (!started || eo.moving || eo.frozen || eo.scriptBusy) return;
  let dir: string | undefined;
  if (mew) {
    // pokeemerald/src/event_object_movement.c:4206
    dir = Faraway.mewDirection(eo, P);
    if (!dir) {
      eo.facing = Objects.copyDirection(c.init, c.playerInit, P.moveDir ?? P.facing) ?? eo.facing;
      return;
    }
  } else {
    dir = Objects.copyDirection(c.init, c.playerInit, P.moveDir ?? P.facing);
  }
  if (!dir) return;
  const d = DELTA[dir]!;
  eo.facing = dir;
  if (stepCollision(eo, undefined, undefined, dir) || (c.grass && !isPokeGrass(eo.cellX + d[0], eo.cellY + d[1]))) {
    return;
  }
  beginStep(eo, eo.cellX + d[0], eo.cellY + d[1]);
  if (P.running || P.biking) eo.stepFrames = RUN_FRAMES;
}

// Lua: objects.lua:1972
function tickRse(eo: EO): void {
  if (eo.levitate) {
    // pokeemerald/src/event_object_movement.c:8908
    const l = eo.levitate;
    if (mod(l.t, 4) === 0) eo.raiseY = (eo.raiseY ?? 0) + l.d;
    if (mod(l.t, 16) === 0) l.d = -l.d;
    l.t = l.t + 1;
  }
  if (eo.fig8) figure8Step(eo);
  if (eo.rseKind === "berry_tree") berryTreeTick(eo);
  if (eo.rseKind === "copy") copyTick(eo);
}

// Lua: objects.lua:1986 -- pokeemerald/src/event_object_movement.c:6503
function revealTrainer(eo: any): void {
  if (!eo || eo === Player()) return;
  const mt = tonumber(eo.movementType) ?? 0;
  if (mt === MT_BURIED) {
    // lazyReq("src.core.game3.trainer_sight")
    let done = false;
    TrainerSight.revealBuried(eo, () => { done = true; });
    eo.trackWait = (): boolean => done;
    return;
  }
  const d = eo.disguise;
  if (!d) return;
  // pokeemerald/src/field_effect_helpers.c:1380
  // NOT FAITHFUL: Emerald only (field_effects_rse is not in the port; this
  // require fails).
  const FxRse = lazyReqMissing("src.core.game3.field_effects_rse");
  d.a = FxRse.anim(FxRse.animCmds(d.sheet, 2));
  d.revealing = true;
  eo.trackWait = (o: EO): boolean => o.disguise == null || o.disguise.done === true;
}

export interface Pool { byId: Record<number, EO>; order: LuaTable; bounds: Bounds | undefined; mapDef: any }

// Lua: objects.lua:2005
function spawnFromDefs(defs: LuaTable, mapDef: any, mapId: any): Pool {
  const pool: Pool = { byId: {}, order: [null], bounds: layoutBounds(mapDef), mapDef };
  const Sp = mapId != null ? Space() : undefined;
  let nb = Sp && Sp.neighborObjectState ? Sp.neighborObjectState(mapId) : undefined;
  if (mapId != null && !nb && !(Sp && Sp.mapId === mapId)) nb = { store: { flags: {}, vars: {} }, perm: {}, movementType: {} };
  const [prepared, snapshots] = takePrepared(mapId, defs ?? [null]);
  for (const [i, def] of ipairs<any>(defs ?? [null])) {
    const eo = newEventObject(def, nb, preparedRow(prepared, snapshots, i, def));
    if (eo.localId > 0) {
      eo.mapDef = mapDef;
      if (nb) {
        const p = nb.perm[eo.localId];
        if (p) {
          eo.cellX = p.x; eo.cellY = p.y; eo.homeX = p.x; eo.homeY = p.y;
          eo.targetX = p.x; eo.targetY = p.y;
          eo.px = p.x * CELL; eo.py = p.y * CELL;
          eo.def.x = p.x; eo.def.y = p.y;
        }
        const mt = nb.movementType[eo.localId];
        if (mt != null && mt !== false) {
          Objects.setTrainerMovementType(eo, mt);
          // pokefirered/src/event_object_movement.c:359
          eo.facing = GfxIds.initialFacing(mt);
        }
        if ((tonumber(eo.graphicsId) ?? 0) >= 240) eo.invisible = true;
      }
      pool.byId[eo.localId] = eo;
      pool.order[len(pool.order) + 1] = eo.localId;
    }
  }
  return pool;
}

// Lua: objects.lua:2038
function tickPool(pool: any, game: any, ctx?: any): void {
  if (pool === null || typeof pool !== "object") return;
  const order = pool.order ?? [null];
  for (let k = 1; order[k] != null; k++) {
    const eo = pool.byId[order[k]];
    if (eo) {
      if (eo.bowFrames && eo.bowFrames > 0) {
        eo.bowFrames = eo.bowFrames - 1;
        if (eo.bowFrames <= 0) eo.bowFrames = undefined;
      }
      tickFade(eo);
      tickMotion(eo, game, ctx ?? pool);
      idleTick(eo, game, ctx);
    }
  }
}

// Lua: objects.lua:2054
function poolForDraw(pool: any): LuaTable {
  const list: LuaTable = [null];
  if (pool === null || typeof pool !== "object") return list;
  for (const [, lid] of ipairs<number>(pool.order ?? [null])) {
    const eo = pool.byId[lid];
    if (eo && eo.visible && !eo.hidden && !eo.invisible
        && !offMap(pool.bounds, eo)) {
      list[len(list) + 1] = eo;
    }
  }
  return list;
}

// Lua: objects.lua:2067
function snapshotPool(): { byId: Record<number, EO>; order: LuaTable; mapId: any; bounds: Bounds | undefined } {
  return {
    byId: Objects._byId, order: Objects._order,
    mapId: Objects._mapId, bounds: Objects._bounds,
  };
}

// Lua: objects.lua:2074
function adoptPool(pool: any): boolean {
  if (pool === null || typeof pool !== "object") return false;
  for (const [, lid] of ipairs<number>(pool.order ?? [null])) {
    const live = Objects._byId[lid];
    const ghost = pool.byId[lid];
    const mv = live && ghost && live.movement === ghost.movement
      && tostring(live.movement ?? "STAY").toUpperCase();
    if (mv === "WALK" || mv === "BACK_FORTH" || mv === "SEQUENCE") {
      live.cellX = ghost.cellX; live.cellY = ghost.cellY;
      live.px = ghost.px; live.py = ghost.py;
      live.targetX = ghost.targetX; live.targetY = ghost.targetY;
      live.moving = ghost.moving; live.progress = ghost.progress;
      live.stepFrames = ghost.stepFrames; live.animClock = ghost.animClock;
      live.facing = ghost.facing;
      live.stepFlip = ghost.stepFlip;
      live.idleTimer = ghost.idleTimer;
      live.seqIndex = ghost.seqIndex;
      if (live.def) { live.def.x = live.cellX; live.def.y = live.cellY; }
    } else if (mv === "LOOK" || mv === "ROTATE") {
      live.facing = ghost.facing;
      live.idleTimer = ghost.idleTimer;
    }
  }
  return true;
}

// Lua: objects.lua:2100
function addObject(localIdIn: unknown): boolean {
  const localId = tonumber(localIdIn) ?? 0;
  const eo = Objects._byId[localId];
  if (eo && !eo.hidden) return true;
  return respawnFromTemplate(localId) != null;
}

// Lua: objects.lua:2108
/** Re-evaluate hide flags after sidecar load / setflag mid-map. */
function refreshVisibility(): void {
  for (const [, lid] of ipairs<number>(Objects._order)) {
    const eo = Objects._byId[lid];
    if (eo && eo.def) {
      const vis = objectVisible(eo.def);
      eo.visible = vis;
      eo.hidden = !vis;
    }
  }
}

// Lua: objects.lua:2120 -- src/event_object_movement.c:1841
function inCameraView(eo: EO): boolean {
  const P = Player();
  if (!P) return false;
  const px = tonumber(P.cellX), py = tonumber(P.cellY);
  if (px == null || py == null) return false;
  // Lua: objects.lua:2125
  const inside = (xIn: unknown, yIn: unknown): boolean => {
    const x = tonumber(xIn), y = tonumber(yIn);
    return x != null && y != null
      && x >= px - 9 && x <= px + 10 && y >= py - 7 && y <= py + 9;
  };
  return inside(eo.cellX, eo.cellY) || inside(eo.homeX, eo.homeY);
}

// Lua: objects.lua:2137
/** pret FlagClear/FlagSet on an object template hide flag. src/scrcmd.c:558 */
function syncFlagVisibility(flagIdIn: unknown, hidden?: unknown, force?: unknown): void {
  const flagId = tonumber(flagIdIn) ?? 0;
  if (flagId === 0 || flagId === 0xFFFF || flagId === 65535) return;
  for (const [, lid] of ipairs<number>(Objects._order)) {
    const eo = Objects._byId[lid];
    if (eo) {
      const f = tonumber(eo.flag) ?? (eo.def ? tonumber(eo.def.flag ?? eo.def.flagId) : undefined) ?? 0;
      if (f === flagId) {
        if (truthy(hidden)) {
          if (truthy(force) || !inCameraView(eo)) {
            eo.hidden = true;
            eo.visible = false;
            if (eo.def) eo.def.hidden = true;
          }
        } else if (eo.hidden) {
          // src/event_object_movement.c:1792
          respawnFromTemplate(lid);
        }
      }
    }
  }
  // Template exists in defs but was never spawned (or despawned from order).
  if (!truthy(hidden)) {
    for (const [, def] of ipairs<any>(Objects._defs ?? [null])) {
      const f = tonumber(def.flag ?? def.flagId) ?? 0;
      const lid = tonumber(def.localId ?? def.index) ?? 0;
      if (f === flagId && lid > 0 && !Objects._byId[lid]) {
        Objects.addObject(lid);
      }
    }
  }
}

// Lua: objects.lua:2170
function removeObject(localIdIn: unknown): boolean {
  const localId = tonumber(localIdIn) ?? 0;
  const eo = Objects._byId[localId];
  if (!eo) return false;
  const flag = eo.def ? (eo.def.flag ?? eo.def.flagId) : undefined;
  if (flag != null && flag !== false && flag !== 0 && flag !== 0xFFFF && flag !== 65535) {
    // package.loaded["src.core.game3.scripting.space"]
    const Sp = SpaceMod;
    if (Sp && Sp.store) {
      Flags.setFlag(Sp.store, undefined, flag, true);
    }
  }
  eo.hidden = true;
  eo.visible = false;
  if (eo.def) eo.def.hidden = true;
  Objects._tracks[localId] = undefined;
  return true;
}

// Lua: objects.lua:2190 -- pokeemerald/src/event_object_movement.c:1939 SetObjectInvisibility
function hideObjectAt(localIdIn: unknown, mapGroup: unknown, mapNum: unknown): boolean {
  const localId = tonumber(localIdIn) ?? 0;
  if (Objects.isPlayer(localId)) {
    const P = Player();
    if (P && P.setVisible) P.setVisible(false);
    return true;
  }
  const eo = Objects.findObjectByLocalIdAndMap(localId, mapGroup, mapNum)
    || (on_named_map(mapGroup, mapNum) ? Objects._byId[localId] : undefined);
  if (!eo) return false;
  eo.invisible = true;
  return true;
}

// Lua: objects.lua:2204
function showObjectAt(localIdIn: unknown, mapGroup: unknown, mapNum: unknown): boolean {
  const localId = tonumber(localIdIn) ?? 0;
  if (Objects.isPlayer(localId)) {
    const P = Player();
    if (P && P.setVisible) P.setVisible(true);
    return true;
  }
  const eo = Objects.findObjectByLocalIdAndMap(localId, mapGroup, mapNum)
    || (on_named_map(mapGroup, mapNum) ? Objects._byId[localId] : undefined);
  if (!eo) {
    if (on_named_map(mapGroup, mapNum)) {
      return Objects.addObject(localId);
    }
    return false;
  }
  eo.invisible = false;
  eo.hidden = false;
  eo.visible = true;
  if (eo.def) eo.def.hidden = false;
  return true;
}

// Lua: objects.lua:2226
function hideObject(localId: unknown): boolean {
  return Objects.hideObjectAt(localId, undefined, undefined);
}

// Lua: objects.lua:2230
function showObject(localId: unknown): boolean {
  return Objects.showObjectAt(localId, undefined, undefined);
}

const TURN_DIRS: Record<number, string> = { [1]: "down", [2]: "up", [3]: "left", [4]: "right" };
const TURN_NAMES: Record<string, string> = { down: "down", up: "up", left: "left", right: "right" };

// Lua: objects.lua:2234
function turnObject(localId: unknown, dir: unknown): void {
  const facing = TURN_DIRS[tonumber(dir) ?? 0]
    ?? TURN_NAMES[tostring(dir ?? "").toLowerCase()];
  const eo = Objects.find(localId);
  if (eo && facing) {
    Objects.scriptFace(eo, facing);
  }
}

// Lua: objects.lua:2244
function setObjectXY(localId: unknown, xIn: unknown, yIn: unknown): void {
  const lid = tonumber(localId) ?? 0;
  const eo = Objects._byId[lid];
  const x = tonumber(xIn) ?? 0, y = tonumber(yIn) ?? 0;
  // Key perm by script map (Space.mapId) when active — not the previous map's
  // Objects._mapId if enter order ever regresses.
  const Sp = Space();
  const mapKey = (Sp && Sp.mapId) ?? Objects._mapId;
  rememberPerm(mapKey, lid, { x, y });
  if (!eo) return;
  eo.cellX = x; eo.cellY = y;
  eo.homeX = x; eo.homeY = y;
  eo.px = eo.cellX * CELL; eo.py = eo.cellY * CELL;
  eo.targetX = eo.cellX; eo.targetY = eo.cellY;
  eo.moving = false;
  if (eo.def) { eo.def.x = eo.cellX; eo.def.y = eo.cellY; }
}

// Lua: objects.lua:2262
function copyObjectXYToPerm(localId: unknown): void {
  const lid = tonumber(localId) ?? 0;
  const eo = Objects._byId[lid];
  if (!eo) return;
  const Sp = Space();
  const mapKey = (Sp && Sp.mapId) ?? Objects._mapId;
  rememberPerm(mapKey, lid, { x: eo.cellX, y: eo.cellY });
  eo.homeX = eo.cellX; eo.homeY = eo.cellY;
  if (eo.def) { eo.def.x = eo.cellX; eo.def.y = eo.cellY; }
}

// Lua: objects.lua:2273
function setMovementType(localId: unknown, mtIn: unknown): void {
  const lid = tonumber(localId) ?? 0;
  const eo = Objects._byId[lid];
  const mt = canonMt(mtIn) ?? 0;
  const Sp = Space();
  const mapKey = (Sp && Sp.mapId) ?? Objects._mapId;
  rememberPerm(mapKey, lid, { movementType: mt });
  if (!eo) return;
  Objects.setTrainerMovementType(eo, mt);
  const face = TMT_FACE[mt];
  if (face) eo.facing = face;
}

// Lua: objects.lua:2286
function clearRaiseHand(eo: EO): void {
  eo.raiseHandState = undefined;
  eo.raiseHand = undefined;
  eo.raiseX = undefined;
  eo.raiseY = undefined;
}

// Lua: objects.lua:2294 -- src/event_object_movement.c:4806
function setTrainerMovementType(localId: unknown, mtIn: unknown): void {
  const eo: EO | undefined = localId !== null && typeof localId === "object"
    ? localId as EO : Objects._byId[tonumber(localId) ?? 0];
  if (!eo) return;
  const mt = canonMt(mtIn) ?? 0;
  setSpec(eo, mt);
  clearRaiseHand(eo);
  // src/event_object_movement.c:4543
  if (mt === MOVEMENT_TYPE_INVISIBLE) eo.invisible = true;
  if (eo.movement === "RAISE_HAND") {
    eo.facing = "down";
  }
}

// Lua: objects.lua:2308 -- src/event_object_movement.c:2640
function overrideTemplateMovementType(localId: unknown, mt: unknown): void {
  const lid = tonumber(localId) ?? 0;
  if (lid <= 0) return;
  Objects._templateMt[lid] = canonMt(mt);
}

// Lua: objects.lua:2314
function templateMovementType(localId: unknown): number | undefined {
  const lid = tonumber(localId) ?? 0;
  const o = Objects._templateMt[lid];
  if (o != null) return o;
  for (const [, def] of ipairs<any>(Objects._defs ?? [null])) {
    if (tonumber(def.localId ?? def.index) === lid) {
      return tonumber(def.movementType) ?? 0;
    }
  }
  return undefined;
}

// Lua: objects.lua:2326
function facePlayer(localId: unknown, _game?: any): void {
  const eo = Objects._byId[tonumber(localId) ?? 0];
  const P = Player();
  if (!eo || !P) return;
  const dx = P.cellX - eo.cellX;
  const dy = P.cellY - eo.cellY;
  if (Math.abs(dx) > Math.abs(dy)) {
    eo.facing = dx > 0 ? "right" : "left";
  } else {
    eo.facing = dy > 0 ? "down" : "up";
  }
}

// Lua: objects.lua:2339
function freeze(localId: unknown): void {
  const eo = Objects._byId[tonumber(localId) ?? 0];
  if (eo) eo.frozen = true;
}

// Lua: objects.lua:2344
function unfreeze(localId: unknown): void {
  const eo = Objects._byId[tonumber(localId) ?? 0];
  if (eo && !eo.scriptBusy) eo.frozen = false;
}

// Lua: objects.lua:2351
/** No-op. EventObjects are owned by game3; Field.interact + adapters read them
 *  directly via Objects.find / forDraw. Kept for call-site compatibility. */
function syncToHost(_game?: any): void {
}

// Lua: objects.lua:2355
// Back-compat thin wrappers used by older Objects.addObject(adapters, id) calls.
function addObjectVia(adapters: any, localId: unknown): boolean {
  if (Objects.addObject(localId)) return true;
  if (adapters && adapters.addObject) return adapters.addObject(localId);
  return false;
}

// Lua: objects.lua:2361
function removeObjectVia(adapters: any, localId: unknown): boolean {
  Objects.removeObject(localId);
  if (adapters && adapters.removeObject) return adapters.removeObject(localId);
  return true;
}

export const Objects = {
  PLAYER_LOCAL_ID: (Opcodes.LOCALID_PLAYER ?? 0xFF) as number,
  MOVEMENT_TYPE_INVISIBLE,
  _byId: {} as Record<number, EO>, // [localId] = EventObject
  _order: [null] as LuaTable, // stable draw/list order (a sequence of localIds)
  _tracks: {} as Record<string | number, Track | undefined>, // [localId] = movement track
  _mapId: undefined as any,
  _defs: undefined as LuaTable | undefined, // original mapDef.objects (for addobject)
  _bounds: undefined as Bounds | undefined,
  // Permanent template overrides from setobjectxyperm / setobjectmovementtype.
  // Survives loadMap within a session (pret objectEventTemplates).
  _perm: {} as Record<string, Record<number, PermRow>>, // [mapId] = { [localId] = { x=, y=, movementType= } }
  _templateMt: {} as Record<number, number | undefined>,
  _logged: false,
  _foreign: undefined as Record<string, number> | undefined,
  _lastPreparationRoute: undefined as string | undefined,
  layoutBounds,
  offMap,
  isRse,
  canonMovementType: canonMt,
  hostSpec,
  cloneTemplate,
  rememberPerm,
  JUMP_Y,
  FADE_FRAMES: 10,
  tickFade,
  initRseKind: Prepare.initRseKind as (eo: EO) => void,
  inCameraView,
  FIG8_X,
  FIG8_Y,
  MT_BERRY_TREE,
  MT_BURIED,
  MT_TREE_DISGUISE,
  MT_MOUNTAIN_DISGUISE,
  isPlayer,
  prefetchMap,
  preparationReady,
  retainPrepared,
  _preparationPending,
  clear,
  reset,
  hasMap,
  refreshGraphics,
  hasActiveTracks,
  loadMap,
  carryOut,
  carryIn,
  foreignKey,
  find,
  findObjectByLocalIdAndMap,
  setSubpriority,
  resetSubpriority,
  listActive,
  forDraw,
  at,
  elevationsCompatible,
  blocks,
  playerBlocks,
  walkPhase,
  updateElevation,
  scriptStep,
  scriptJump,
  startJumpArc,
  pushStep,
  scriptFace,
  applyMovement,
  startTrack,
  pollMovement,
  clearMovements,
  fadeAlpha,
  beginFadeIn,
  update,
  scriptDiagonal,
  setLevitate,
  startFigure8,
  copyDirection,
  tickRse,
  revealTrainer,
  spawnFromDefs,
  tickPool,
  poolForDraw,
  snapshotPool,
  adoptPool,
  addObject,
  refreshVisibility,
  syncFlagVisibility,
  removeObject,
  hideObjectAt,
  showObjectAt,
  hideObject,
  showObject,
  turnObject,
  setObjectXY,
  copyObjectXYToPerm,
  setMovementType,
  setTrainerMovementType,
  overrideTemplateMovementType,
  templateMovementType,
  facePlayer,
  freeze,
  unfreeze,
  syncToHost,
  addObjectVia,
  removeObjectVia,
};

export default Objects;
