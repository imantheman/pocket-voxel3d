// Port of gen1recomp src/core/game3/ghosts.lua (GPLv3 + additional terms; see LICENSE.md).
// Neighbour-map object pools ("ghosts"): the NPCs of the connected maps in
// Map.world, spawned, ticked near the camera, drawn, captured and adopted
// across a seamless map crossing.
//
// Return shapes: tickRect -> [x0, y0, x1, y1] or [] (internal).
// prepareOffscreen: `love.thread` does not exist on the 3DS, so it takes
// Brian's own no-worker path (return false: adopt the pool immediately).

import { tonumber, truthy } from "../../../import/gen3/lua.ts";
import { ipairs, len, pairs, type LuaTable } from "../platform/lt.ts";
import { Map as MapMod } from "./map.ts";
import { Objects as ObjectsMod } from "./objects.ts";
import { Permissions } from "../shared/world/gen2/Permissions.ts";
import { Space as SpaceMod } from "./scripting/space.ts";
import { Collision as CollisionMod } from "./collision.ts";
import { Player as PlayerMod } from "./player.ts";
import { FieldView as FieldViewMod } from "./field_view.ts";
import { Display as DisplayMod } from "./display.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface GhostPool { byId: Record<number, any>; order: LuaTable; bounds?: any; [k: string]: any }
export interface GhostCtx {
  ox: number;
  oy: number;
  canEnter: (tx: number, ty: number, fromX?: number, fromY?: number, dir?: string) => boolean;
  blocks: (tx: number, ty: number, exceptId?: number) => boolean;
}

// Lua: ghosts.lua:11
function Map(): any { return MapMod; }
// Lua: ghosts.lua:15
function Objects(): any { return ObjectsMod; }

// Lua: ghosts.lua:19
let permsLoaded = false;
let permsMod: typeof Permissions | null = null;
function permissions(): typeof Permissions | null {
  if (!permsLoaded) {
    permsMod = Permissions ?? null;
    permsLoaded = true;
  }
  return permsMod;
}

// Lua: ghosts.lua:29
function defsFor(mapId: any, def: any): any {
  const Space: any = SpaceMod;
  const ev = Space && Space.bundle && Space.bundle.events
    ? Space.bundle.events[mapId] : null;
  let defs = ev ? (ev.objects ?? ev.objectEvents) : null;
  if (defs == null || typeof defs !== "object") defs = def ? def.objects : null;
  return defs != null && typeof defs === "object" ? defs : null;
}

// Lua: ghosts.lua:38
function contextFor(entry: any, pool: GhostPool): GhostCtx {
  const layout = entry.def ? entry.def.midLayout : null;
  const P = permissions();
  return {
    ox: entry.ox ?? 0,
    oy: entry.oy ?? 0,
    canEnter: (tx: number, ty: number, fromX?: number, fromY?: number, dir?: string): boolean => {
      if (!layout) return false;
      if (tx < 0 || ty < 0 || tx >= (layout.width ?? 0) || ty >= (layout.height ?? 0)) {
        return false;
      }
      // pokefirered/src/event_object_movement.c:4889
      if (dir && entry.def) {
        const C: any = CollisionMod;
        if (C.directionallyImpassableOn
          && C.directionallyImpassableOn(entry.def, fromX, fromY, tx, ty, dir)) {
          return false;
        }
      }
      const coll = layout.collAt(tx, ty);
      if (P && P.isWalkable) return P.isWalkable(coll);
      return coll !== 0x07 && coll !== 0xff && coll !== 0x29;
    },
    blocks: (tx: number, ty: number, exceptId?: number): boolean => {
      for (const [, lid] of ipairs<number>(pool.order ?? {})) {
        const eo = pool.byId[lid];
        if (eo && lid !== exceptId && truthy(eo.visible) && !truthy(eo.hidden) && !truthy(eo.passable)) {
          if (eo.cellX === tx && eo.cellY === ty) return true;
          if (truthy(eo.moving) && eo.targetX === tx && eo.targetY === ty) return true;
        }
      }
      return Objects().playerBlocks(tx + (entry.ox ?? 0), ty + (entry.oy ?? 0));
    },
  };
}

// Lua: ghosts.lua:76 (weak-keyed)
const ctxCache = new WeakMap<object, any>();

// Lua: ghosts.lua:78
const EMPTY: LuaTable = [null];
const syncPlaced: Record<string, boolean> = {};

// Lua: ghosts.lua:83
function syncCurrent(world: LuaTable): boolean {
  if (Ghosts._syncWorld !== world || Ghosts._syncPools !== Ghosts._pools) return false;
  let n = 0;
  for (const [, entry] of ipairs<any>(world)) {
    if (!Ghosts._pools[entry.id]) return false;
    n = n + 1;
  }
  for (const [id] of pairs(Ghosts._pools)) {
    if (!syncPlaced[id] && id !== Ghosts._held) return false;
    n = n - 1;
  }
  return n === 0 || (Ghosts._held != null && n === -1);
}

// Lua: ghosts.lua:111
function markFade(pool: GhostPool, entry: any): void {
  const P: any = PlayerMod;
  const px = P ? tonumber(P.cellX) : undefined, py = P ? tonumber(P.cellY) : undefined;
  if (!(px != null && py != null)) return;
  for (const [, eo] of pairs<any>(pool.byId)) {
    const x = (eo.cellX ?? 0) + (entry.ox ?? 0), y = (eo.cellY ?? 0) + (entry.oy ?? 0);
    if (truthy(eo.visible) && !truthy(eo.hidden) && !truthy(eo.invisible)
      && x >= px - 9 && x <= px + 10 && y >= py - 7 && y <= py + 9) {
      eo.fadeIn = 0;
    }
  }
}

// Lua: ghosts.lua:124
function prepareOffscreen(_M: any, _entry: any): boolean {
  // `love.thread` is nil here: Brian's first guard returns false (no worker
  // preparation; the pool is spawned now).
  return false;
}

// Lua: ghosts.lua:182 -- [x0, y0, x1, y1] or []
function tickRect(): [number?, number?, number?, number?] {
  const P: any = PlayerMod;
  const px = P ? tonumber(P.cellX) : undefined, py = P ? tonumber(P.cellY) : undefined;
  if (!(px != null && py != null)) return [];
  const FieldView: any = FieldViewMod;
  const Display: any = DisplayMod;
  const vw = (FieldView && FieldView._viewW) || (Display && Display.W) || 240;
  const vh = (FieldView && FieldView._viewH) || (Display && Display.H) || 160;
  const cols = Math.ceil(vw / 16), rows = Math.ceil(vh / 16);
  const mx = Math.ceil(cols / 2) + 1 + cols * Ghosts.TICK_MARGIN_SCREENS;
  const my = Math.ceil(rows / 2) + 1 + rows * Ghosts.TICK_MARGIN_SCREENS;
  // cull rect in current-map cells
  return [px - mx, py - my, px + mx, py + my];
}

// Lua: ghosts.lua:197
function nearView(entry: any, x0?: number, y0?: number, x1?: number, y1?: number): boolean {
  if (x0 == null) return true;
  const layout = entry.def ? entry.def.midLayout : null;
  const w = layout ? layout.width : null;
  const h = layout ? layout.height : null;
  if (!(w && h)) return true;
  const ox = entry.ox ?? 0, oy = entry.oy ?? 0;
  return ox + w > x0 && ox <= x1! && oy + h > y0! && oy <= y1!;
}

export const Ghosts = {
  // Lua: ghosts.lua:9
  _pools: {} as Record<string, GhostPool>,
  _held: null as any,
  _heldGrace: null as number | null,
  _syncWorld: null as any,
  _syncPools: null as any,
  _fadeWindow: null as number | null,

  // Lua: ghosts.lua:74
  _contextFor: contextFor,

  // Lua: ghosts.lua:97
  FADE_WINDOW: 3,

  // Lua: ghosts.lua:99
  openFadeWindow(): void {
    Ghosts._fadeWindow = Ghosts.FADE_WINDOW;
  },

  // Lua: ghosts.lua:103
  visibleIds(mapId: any): Record<number, boolean> | null {
    const pool = Ghosts._pools[mapId];
    if (!pool) return null;
    const seen: Record<number, boolean> = {};
    for (const [, eo] of ipairs<any>(Objects().poolForDraw(pool))) seen[eo.localId] = true;
    return seen;
  },

  // Lua: ghosts.lua:139
  sync(): void {
    const M = Map();
    const world = M.world ?? EMPTY;
    if (!syncCurrent(world)) {
      const placed = syncPlaced;
      for (const id of Object.keys(placed)) delete placed[id];
      for (const [, entry] of ipairs<any>(world)) {
        placed[entry.id] = true;
        if (!Ghosts._pools[entry.id] && !prepareOffscreen(M, entry)) {
          const defs = defsFor(entry.id, entry.def);
          if (defs) {
            const pool = Objects().spawnFromDefs(defs, entry.def, entry.id);
            Ghosts._pools[entry.id] = pool;
            if ((Ghosts._fadeWindow ?? 0) > 0) markFade(pool, entry);
          }
        }
      }
      for (const id of Object.keys(Ghosts._pools)) {
        if (!placed[id] && id !== Ghosts._held) {
          delete Ghosts._pools[id];
        }
      }
      Ghosts._syncWorld = world;
      Ghosts._syncPools = Ghosts._pools;
    }
    const placed = syncPlaced;
    if (Ghosts._held != null && !placed[Ghosts._held]) {
      Ghosts._heldGrace = (Ghosts._heldGrace ?? 0) + 1;
      if (Ghosts._heldGrace > 2) {
        delete Ghosts._pools[Ghosts._held];
        Ghosts._held = null;
        Ghosts._heldGrace = null;
      }
    } else {
      Ghosts._heldGrace = null;
    }
  },

  // Lua: ghosts.lua:180
  TICK_MARGIN_SCREENS: 1,

  // Lua: ghosts.lua:207
  update(game: any): void {
    if ((Ghosts._fadeWindow ?? 0) > 0) Ghosts._fadeWindow = Ghosts._fadeWindow! - 1;
    const M = Map();
    const Obj = Objects();
    const [x0, y0, x1, y1] = tickRect();
    for (const [, entry] of ipairs<any>(M.world ?? EMPTY)) {
      const pool = Ghosts._pools[entry.id];
      if (pool && nearView(entry, x0, y0, x1, y1)) {
        let c = ctxCache.get(entry);
        if (!c || c.pool !== pool || c.def !== entry.def || c.layout !== (entry.def ? entry.def.midLayout : undefined)
          || c.ox !== entry.ox || c.oy !== entry.oy) {
          c = { pool, def: entry.def, layout: entry.def ? entry.def.midLayout : undefined, ox: entry.ox, oy: entry.oy, ctx: contextFor(entry, pool) };
          ctxCache.set(entry, c);
        }
        Obj.tickPool(pool, game, c.ctx);
      }
    }
  },

  // Lua: ghosts.lua:225
  forDraw(mapId: any): any {
    const pool = Ghosts._pools[mapId];
    if (!pool) return null;
    return Objects().poolForDraw(pool);
  },

  // Lua: ghosts.lua:232 -- pokefirered/src/event_object_movement.c:4899
  blocksOn(mapId: any, def: any, tx: number, ty: number): boolean {
    let pool = Ghosts._pools[mapId];
    if (!pool) {
      const defs = defsFor(mapId, def);
      if (!defs) return false;
      pool = Objects().spawnFromDefs(defs, def, mapId);
      Ghosts._pools[mapId] = pool;
    }
    for (const [, lid] of ipairs<number>(pool.order ?? {})) {
      const eo = pool.byId[lid];
      if (eo && truthy(eo.visible) && !truthy(eo.hidden) && !truthy(eo.passable)) {
        if (eo.cellX === tx && eo.cellY === ty) return true;
        if (truthy(eo.moving) && eo.targetX === tx && eo.targetY === ty) return true;
      }
    }
    return false;
  },

  // Lua: ghosts.lua:250
  capture(mapId: any): void {
    if (!mapId) return;
    const snap = Objects().snapshotPool();
    if (snap.mapId !== mapId) return;
    const pool: GhostPool = { byId: {}, order: [null], bounds: snap.bounds };
    for (const [, lid] of ipairs<number>(snap.order ?? {})) {
      const eo = snap.byId[lid];
      if (eo && eo.foreignMap == null) {
        pool.byId[lid] = eo;
        pool.order[len(pool.order) + 1] = lid;
        eo.scriptBusy = false;
        eo.frozen = false;
      }
    }
    Ghosts._pools[mapId] = pool;
    Ghosts._held = mapId;
    Ghosts._heldGrace = null;
  },

  // Lua: ghosts.lua:269
  adopt(mapId: any): void {
    if (!mapId) return;
    const pool = Ghosts._pools[mapId];
    if (!pool) return;
    Objects().adoptPool(pool);
    delete Ghosts._pools[mapId];
    if (Ghosts._held === mapId) Ghosts._held = null;
  },

  // Lua: ghosts.lua:278
  clear(): void {
    Ghosts._pools = {};
    Ghosts._held = null;
    Ghosts._heldGrace = null;
  },
};

export default Ghosts;
