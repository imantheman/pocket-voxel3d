// Port of gen1recomp src/core/game3/camera_object.lua (GPLv3 + additional terms; see LICENSE.md).
// pokefirered/src/field_specials.c:318
//
// Port notes:
// - Lazily required (lazyReq / pcall(require)): registers as
//   G3Lazy["src.core.game3.camera_object"].
// - package.loaded["src.core.game3.objects"] / ["src.core.game3.player"] and
//   pcall(require, "src.core.game3.field_view"): those modules are in the
//   bundle, so they are static imports treated as loaded.
// - offset() returns Lua's two values as the tuple [dx, dy].

/* eslint-disable @typescript-eslint/no-explicit-any */
import { len, remove } from "../platform/lt.ts";
import { tonumber } from "../../../import/gen3/lua.ts";
import { Objects as ObjectsMod } from "./objects.ts";
import { Player as PlayerMod } from "./player.ts";
import { FieldView as FieldViewMod } from "./field_view.ts";
import { G3Lazy } from "./lazy_registry.ts";

// pokefirered/include/constants/event_objects.h:24
const GFX_YOUNGSTER = 18;
// pokefirered/include/constants/event_object_movement.h:13
const MOVEMENT_TYPE_FACE_DOWN = 0x8;
const ELEVATION = 3;

const CELL = 16;

// Lua: camera_object.lua:19
function Objects(): any {
  return ObjectsMod;
}

// Lua: camera_object.lua:24
function Player(): any {
  return PlayerMod;
}

// Lua: camera_object.lua:29
function orderIndex(order: any, lid: number): number | undefined {
  for (let i = 1; i <= len(order); i++) {
    if (order[i] === lid) return i;
  }
  return undefined;
}

// Lua: camera_object.lua:36
function live(): any {
  const eo = CameraObject._eo;
  if (!eo) return undefined;
  const O = Objects();
  const lid = CameraObject.LOCALID;
  if (O._byId[lid] !== eo) {
    if (O._mapId != null && O._mapId === CameraObject._mapId) {
      O._byId[lid] = eo;
      if (!orderIndex(O._order, lid)) {
        O._order[len(O._order) + 1] = lid;
      }
      return eo;
    }
    CameraObject._eo = undefined;
    CameraObject._mapId = undefined;
    return undefined;
  }
  return eo;
}

export const CameraObject = {
  // pokefirered/include/constants/event_objects.h:203
  LOCALID: 127,

  _eo: undefined as any,
  _mapId: undefined as any,
  _wrapped: false,

  // Lua: camera_object.lua:56
  isActive(): boolean {
    return live() != null;
  },

  // Lua: camera_object.lua:60
  object(): any {
    return live();
  },

  // Lua: camera_object.lua:65
  // pokefirered/src/event_object_movement.c:2427
  offset(): [number, number] {
    const eo = live();
    if (!eo) return [0, 0];
    const P = Player();
    const dx = (tonumber(eo.px) ?? 0) - (tonumber(P.px) ?? 0);
    const dy = (tonumber(eo.py) ?? 0) - (tonumber(P.py) ?? 0);
    return [Math.floor(dx + 0.5), Math.floor(dy + 0.5)];
  },

  // Lua: camera_object.lua:75
  // pokefirered/src/field_camera.c:89
  installViewSeam(): boolean {
    if (CameraObject._wrapped) return true;
    const FieldView: any = FieldViewMod;
    if (typeof FieldView !== "object" || FieldView == null || typeof FieldView.draw !== "function") {
      return false;
    }
    const orig = FieldView.draw;
    FieldView.draw = function (game: any, canvasW?: number, canvasH?: number, opts?: any): void {
      const [dx, dy] = CameraObject.offset();
      if (dx === 0 && dy === 0) {
        return orig(game, canvasW, canvasH, opts);
      }
      const bx = FieldView.cameraPanX || 0;
      const by = FieldView.cameraPanY || 0;
      FieldView.cameraPanX = bx + dx;
      FieldView.cameraPanY = by + dy;
      let ok = true;
      let err: unknown;
      try { orig(game, canvasW, canvasH, opts); } catch (e) { ok = false; err = e; }
      FieldView.cameraPanX = bx;
      FieldView.cameraPanY = by;
      if (!ok) throw err;
    };
    FieldView._game3CameraObjectSeam = true;
    CameraObject._wrapped = true;
    return true;
  },

  // Lua: camera_object.lua:99
  spawn(_game?: any): any {
    let eo = live();
    if (eo) return eo;
    const O = Objects();
    const P = Player();
    const lid = CameraObject.LOCALID;
    const cx = tonumber(P.cellX) ?? 0;
    const cy = tonumber(P.cellY) ?? 0;
    const pool = O.spawnFromDefs([null, {
      localId: lid,
      x: cx,
      y: cy,
      graphicsId: GFX_YOUNGSTER,
      movementType: MOVEMENT_TYPE_FACE_DOWN,
      elevation: ELEVATION,
    }], undefined);
    eo = pool && pool.byId && pool.byId[lid];
    if (!eo) return undefined;
    eo.visible = false;
    eo.hidden = true;
    eo.px = tonumber(P.px) ?? (cx * CELL);
    eo.py = tonumber(P.py) ?? (cy * CELL);
    eo.facing = P.facing || "down";
    O._byId[lid] = eo;
    if (!orderIndex(O._order, lid)) {
      O._order[len(O._order) + 1] = lid;
    }
    delete O._tracks[lid];
    CameraObject._eo = eo;
    CameraObject._mapId = O._mapId;
    CameraObject.installViewSeam();
    return eo;
  },

  // Lua: camera_object.lua:134
  // pokefirered/src/field_specials.c:325
  remove(_game?: any): boolean {
    const O = Objects();
    const lid = CameraObject.LOCALID;
    const eo = CameraObject._eo;
    CameraObject._eo = undefined;
    CameraObject._mapId = undefined;
    const tr = O._tracks[lid];
    if (tr && !tr.done) {
      tr.done = true;
      const cb = tr.onDone;
      tr.onDone = undefined;
      if (cb) cb();
    }
    if (O._byId[lid] == null) return false;
    if (eo != null && O._byId[lid] !== eo) return false;
    delete O._byId[lid];
    const i = orderIndex(O._order, lid);
    if (i) remove(O._order, i);
    return true;
  },

  // Lua: camera_object.lua:155
  reset(): void {
    // package.loaded["src.core.game3.objects"]
    const O: any = ObjectsMod;
    const lid = CameraObject.LOCALID;
    if (O && O._byId && O._byId[lid] && O._byId[lid] === CameraObject._eo) {
      delete O._byId[lid];
      const i = orderIndex(O._order, lid);
      if (i) remove(O._order, i);
      if (O._tracks) delete O._tracks[lid];
    }
    CameraObject._eo = undefined;
    CameraObject._mapId = undefined;
  },
};

G3Lazy["src.core.game3.camera_object"] = CameraObject;

export default CameraObject;
