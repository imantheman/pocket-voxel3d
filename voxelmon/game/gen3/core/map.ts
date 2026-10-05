// Port of gen1recomp src/core/game3/map.lua (GPLv3 + additional terms; see LICENSE.md).
// Game3 map loader. Owns Sevii enter: player, collision, EventObjects, Space scripts.
// Talk/interact is Field.interact. Do not call host setMap/warpToMapId here —
// MAPSETUP.WARP races ON_FRAME and wipes applymovement tracks (Bill intro).
//
// Port notes:
// - Lists (neighborList, world, queues, overscan slices) are Lua sequences;
//   neighbors is keyed by direction.
// - package.loaded[X] and pcall(require, X) are static imports (every module
//   is in the bundle). The modules Brian loads with pcall(require) that have
//   no file in this port (roamer, renewable_hidden_items,
//   ui/game3/map_name_popup) read as a failed pcall: skipped, each marked.
// - VoidFill.loaded.map is set when this module loads (void_fill.ts header).
// - The exported name `Map` shadows JS's Map inside this file; none is used.

import { MapIds } from "./map_ids.ts";
import { Runtime as ModRuntime } from "../shared/mods/Runtime.ts";
import { Connections } from "./connections.ts";
import { FieldModules } from "./field_modules.ts";
import { NativeTileset } from "./tileset_native.ts";
import { FieldView } from "./field_view.ts";
import { Display } from "./display.ts";
import { OwSprites } from "./ow_sprites.ts";
import { Objects } from "./objects.ts";
import { Player } from "./player.ts";
import { Stream } from "./asset_stream.ts";
import { Ghosts } from "./ghosts.ts";
import { Plan as FieldPlan } from "./field_plan.ts";
import { Dataset } from "./dataset.ts";
import { Message as StayMessage } from "../ui/message.ts";
import { Encounters } from "./encounters.ts";
import { Runtime } from "./runtime.ts";
import { Profile } from "./profile.ts";
import { TilesetAnim } from "./tileset_anim.ts";
import { Space } from "./scripting/space.ts";
import { Field } from "./field.ts";
import { Collision } from "./collision.ts";
import { FieldEffects } from "./field_effects.ts";
import { VirtualObjects } from "./virtual_objects.ts";
import { VsSeeker } from "./vs_seeker.ts";
import { Capabilities } from "./capabilities.ts";
import { Rtc } from "./rtc.ts";
import { TimeEvents } from "./time_events.ts";
import { Weather } from "./weather.ts";
import { Flags } from "./scripting/flags.ts";
import { Sem as FieldSemantics } from "./field_semantics.ts";
import { Audio } from "./audio.ts";
import { NativesTv } from "./scripting/natives_tv.ts";
import { MapPreviewScreen } from "../ui/map_preview_screen.ts";
import { FixedStep } from "../shared/core/FixedStep.ts";
import { VoidFill } from "./void_fill.ts";
import { Timer } from "../platform/timer.ts";
import { ipairs, len, pairs, remove, type LuaTable } from "../platform/lt.ts";
import { find } from "../platform/lpattern.ts";
import { tonumber } from "../../../import/gen3/lua.ts";

export interface WorldEntry { id: string; def: any; ox: number; oy: number }
export interface NeighborEntry { dir: string; map: string; mapId: string; def: any; offset: number }

/** A world/neighbour cell sample: [mid, pair, void]. */
export type MidSample = [number, string | undefined, boolean | undefined];

// Lua: map.lua:27
function host_map_def(game: any, mapId: string): any {
  const data = game && game.data;
  return data && data.maps && data.maps[mapId];
}

// Lua: map.lua:32
function host_world(game: any): any {
  return game && (game.overworld ?? game.world);
}

// Lua: map.lua:65
const cell_size = Connections.sizeOf;

// worldMidAt runs per drawn cell (FieldView); the Lua returns its values
// without allocating, so these samples are shared: valid until the next call.
const sampleOut: MidSample = [0, undefined, undefined];
const sampleNb: [number | undefined, string | undefined] = [undefined, undefined];

// Lua: map.lua:366 -- writes sampleNb ([mid, pair]); mid undefined when off the neighbour
function fromNeighbor(n: any, nx: number, ny: number, primaryPair: string | undefined): void {
  sampleNb[0] = undefined; sampleNb[1] = undefined;
  if (!n || !n.def) return;
  const L = n.def.midLayout;
  if (!L) return;
  if (nx < 0 || ny < 0 || nx >= (L.width ?? 0) || ny >= (L.height ?? 0)) {
    return;
  }
  const pair = L.pair ?? n.def.pair;
  sampleNb[0] = L.midAt(nx, ny); sampleNb[1] = pair ?? primaryPair;
}

// Lua: map.lua:377 -- writes sampleNb
function fromDir(list: LuaTable, dir: string, cx: number, cy: number, w: number, h: number, primaryPair: string | undefined): void {
  for (let i = len(list); i >= 1; i--) {
    const n = list[i];
    if (n.dir === dir && n.def && n.def.midLayout) {
      const L = n.def.midLayout;
      const offset = tonumber(n.offset) ?? 0;
      let nx: number, ny: number;
      if (dir === "north") {
        nx = cx - offset; ny = (L.height ?? 0) + cy;
      } else if (dir === "south") {
        nx = cx - offset; ny = cy - h;
      } else if (dir === "west") {
        nx = (L.width ?? 0) + cx; ny = cy - offset;
      } else {
        nx = cx - w; ny = cy - offset;
      }
      fromNeighbor(n, nx, ny, primaryPair);
      if (sampleNb[0] != null) return;
    }
  }
  sampleNb[0] = undefined; sampleNb[1] = undefined;
}

// (port helper: worldMidAt's multiple returns, in the shared sample)
function out(mid: number, pair: string | undefined, isVoid?: boolean): MidSample {
  sampleOut[0] = mid; sampleOut[1] = pair; sampleOut[2] = isVoid;
  return sampleOut;
}

export const Map = {
  current: undefined as string | undefined,
  _announced: undefined as string | undefined,
  neighbors: {} as Record<string, NeighborEntry>,
  neighborList: [null] as LuaTable,
  _loadedLayouts: {} as Record<string, boolean>,
  _def: undefined as any,
  _currentDef: undefined as any,
  // pokefirered/include/overworld.h:46
  MUSIC_DISABLE_OFF: 0, MUSIC_DISABLE_STOP: 1, MUSIC_DISABLE_KEEP: 2,
  // pokefirered/src/overworld.c:103
  disableMusicChange: 0,

  world: [null] as LuaTable,
  _worldRoot: undefined as string | undefined,
  _worldReachW: -1,
  _worldReachH: -1,
  WORLD_HOPS: 2,

  WARM_MARGIN_SCREENS: 1,
  WARM_BUDGET_SEC: 0.030,
  WARM_MAX_DEFER: 3,
  _warmDefer: 0,

  _warmPairs: undefined as boolean | undefined,
  _warmQueue: undefined as LuaTable | undefined,
  _warmEntries: undefined as Record<string, LuaTable> | undefined,
  _warmScanTick: undefined as number | undefined,
  _warmScanWorld: undefined as LuaTable | undefined,
  _warmScanX: undefined as number | undefined,
  _warmScanY: undefined as number | undefined,
  _warmScanX1: undefined as number | undefined,
  _warmScanY1: undefined as number | undefined,
  _nextEnterVia: undefined as string | undefined,
  _lastSectionId: undefined as number | undefined,

  // Lua: map.lua:23
  currentDef(): any {
    return Map._def ?? Map._currentDef;
  },

  // Lua: map.lua:36
  loadNeighborsDepth1(game: any, primaryDef: any): Record<string, NeighborEntry> {
    Map.neighbors = {};
    Map.neighborList = [null];
    if (!primaryDef || primaryDef.connections === null || typeof primaryDef.connections !== "object") {
      return Map.neighbors;
    }
    const data = game && game.data && game.data.maps;
    if (!data) return Map.neighbors;
    // pokefirered/src/fieldmap.c:129
    for (const [, conn] of ipairs<any>(Connections.each(primaryDef))) {
      const mid = conn.map;
      if (data[mid]) {
        const def = data[mid];
        Map.ensureMidLayout(game, mid, def);
        const n: NeighborEntry = {
          dir: conn.dir,
          map: mid,
          mapId: mid,
          def,
          offset: conn.offset,
        };
        Map.neighborList[len(Map.neighborList) + 1] = n;
        Map.neighbors[conn.dir] = Map.neighbors[conn.dir] ?? n;
        Map._loadedLayouts[mid] = true;
      }
    }
    return Map.neighbors;
  },

  // Lua: map.lua:73
  computeWorld(maps: any, rootId: string, hops?: number, reachW?: number, reachH?: number,
    ensureIn?: (id: string, def: any) => void): LuaTable {
    const outList: LuaTable = [null];
    const rootDef = maps && maps[rootId];
    if (!rootDef) return outList;
    const ensure = ensureIn ?? ((): void => {});
    ensure(rootId, rootDef);
    const [rootW, rootH] = cell_size(rootDef);
    const placed: Record<string, boolean> = { [rootId]: true };
    const queue: LuaTable = [null, { id: rootId, def: rootDef, ox: 0, oy: 0, hops: 0 }];
    let qi = 1;
    // Lua: map.lua:83
    const inReach = (def: any, ox: number, oy: number): boolean => {
      if (!(reachW != null && reachH != null)) return false;
      const [w, h] = cell_size(def);
      return ox + w > -reachW && ox < rootW + reachW
        && oy + h > -reachH && oy < rootH + reachH;
    };
    while (queue[qi]) {
      const cur = queue[qi];
      qi = qi + 1;
      const [curW, curH] = cell_size(cur.def);
      for (const [, conn] of ipairs<any>(Connections.each(cur.def))) {
        const dir = conn.dir;
        const destId = conn.map;
        const destDef = maps[destId];
        if (destDef && destDef !== rootDef && !placed[destId]) {
          const offset = conn.offset;
          ensure(destId, destDef);
          const [destW, destH] = cell_size(destDef);
          let ox: number | undefined, oy: number | undefined;
          if (dir === "north") {
            ox = offset; oy = -destH;
          } else if (dir === "south") {
            ox = offset; oy = curH;
          } else if (dir === "west") {
            ox = -destW; oy = offset;
          } else if (dir === "east") {
            ox = curW; oy = offset;
          }
          if (ox != null) {
            ox = cur.ox + ox; oy = cur.oy + (oy as number);
            const reach = inReach(destDef, ox as number, oy as number);
            if (cur.hops + 1 <= (hops ?? 0) || reach) {
              placed[destId] = true;
              outList[len(outList) + 1] = { id: destId, def: destDef, ox, oy };
              if (cur.hops + 1 < (hops ?? 0) || reach) {
                queue[len(queue) + 1] = {
                  id: destId, def: destDef, ox, oy, hops: cur.hops + 1,
                };
              }
            }
          }
        }
      }
    }
    return outList;
  },

  // Lua: map.lua:130
  refreshWorld(game: any, reachWIn: unknown, reachHIn: unknown, rootIdIn?: string): LuaTable {
    const rootId = rootIdIn ?? Map.current;
    const maps = game && game.data && game.data.maps;
    if (!(rootId && maps)) {
      Map.world = [null];
      Map._worldRoot = undefined;
      return Map.world;
    }
    const reachW = Math.floor(tonumber(reachWIn) ?? 0);
    const reachH = Math.floor(tonumber(reachHIn) ?? 0);
    if (Map._worldRoot === rootId
      && Map._worldReachW === reachW && Map._worldReachH === reachH) {
      return Map.world;
    }
    Map.world = Map.computeWorld(maps, rootId, Map.WORLD_HOPS, reachW, reachH,
      (id, def) => {
        Map.ensureMidLayout(game, id, def);
      });
    for (const [, entry] of ipairs<WorldEntry>(Map.world)) {
      Map._loadedLayouts[entry.id] = true;
    }
    // package.loaded["src.core.game3.tileset_native"]
    const NT = NativeTileset;
    if (NT && NT.get) {
      const sync = Map._warmPairs;
      Map._warmPairs = undefined;
      const [x0, y0, x1, y1] = Map.warmRect();
      const queue: LuaTable = [null];
      const seen: Record<string, boolean> = {};
      const entries: Record<string, LuaTable> = {};
      for (const [, entry] of ipairs<WorldEntry>(Map.world)) {
        const pair = entry.def && (entry.def.pair ?? (entry.def.midLayout && entry.def.midLayout.pair));
        if (sync && pair && !NT.prefetch && Map.warmNear(entry, x0, y0, x1, y1)) {
          if (NT.ready(pair)) { try { NT.get(pair); } catch { /* pcall */ } }
        } else if (typeof pair === "string" && !(NT._pairs && NT._pairs[pair])) {
          if (!seen[pair]) {
            seen[pair] = true;
            queue[len(queue) + 1] = pair;
            entries[pair] = [null];
          }
          const list = entries[pair]!;
          list[len(list) + 1] = entry;
        }
      }
      Map._warmQueue = queue[1] ? queue : undefined;
      Map._warmEntries = queue[1] ? entries : undefined;
      if (NT._stream) {
        const root = maps[rootId];
        const pair = root && (root.pair ?? (root.midLayout && root.midLayout.pair));
        if (pair) seen[pair] = true;
        NT._stream.retain(seen);
      }
    }
    Map._worldRoot = rootId;
    Map._worldReachW = reachW;
    Map._worldReachH = reachH;
    // package.loaded["src.core.game3.field_view"]
    if (FieldView) FieldView._nativeDirty = true;
    return Map.world;
  },

  // Lua: map.lua:193
  warmNow(game: any, rootId?: string): LuaTable {
    const vw = (FieldView && FieldView._viewW) ?? (Display && Display.W) ?? 240;
    const vh = (FieldView && FieldView._viewH) ?? (Display && Display.H) ?? 160;
    Map._warmPairs = undefined;
    const world = Map.refreshWorld(game, Math.ceil(vw / 16), Math.ceil(vh / 16), rootId);
    const Native = NativeTileset;
    const def = rootId != null ? host_map_def(game, rootId) : undefined;
    const pair = def && (def.pair ?? (def.midLayout && def.midLayout.pair));
    if (Native && pair && Native.ready(pair)) { try { Native.get(pair); } catch { /* pcall */ } }
    const Ow = OwSprites;
    if (Ow && Ow.get && Ow.playerGraphicsId) {
      const gid = Ow.playerGraphicsId(game);
      if (gid != null) { try { Ow.get(gid); } catch { /* pcall */ } }
      const [x0, y0, x1, y1] = Map.warmRect();
      for (const [, eo] of ipairs<any>((Objects && Objects.forDraw && Objects.forDraw()) ?? [null])) {
        const x = eo.cellX ?? 0, y = eo.cellY ?? 0;
        if (eo.graphicsId != null && (x0 == null || (x >= x0 && x <= x1! && y >= y0! && y <= y1!))) {
          try { Ow.get(eo.graphicsId); } catch { /* pcall */ }
        }
      }
    }
    Map.stepWarm(game);
    return world;
  },

  // Lua: map.lua:219 -- [x0, y0, x1, y1], or [] without a player cell
  warmRect(marginIn?: number): [number?, number?, number?, number?] {
    const P = Player;
    const px = P ? tonumber(P.cellX) : undefined, py = P ? tonumber(P.cellY) : undefined;
    if (!(px != null && py != null)) return [];
    const vw = (FieldView && FieldView._viewW) ?? (Display && Display.W) ?? 240;
    const vh = (FieldView && FieldView._viewH) ?? (Display && Display.H) ?? 160;
    const cols = Math.ceil(vw / 16), rows = Math.ceil(vh / 16);
    const margin = marginIn ?? Map.WARM_MARGIN_SCREENS;
    const mx = Math.ceil(cols / 2) + 1 + cols * margin;
    const my = Math.ceil(rows / 2) + 1 + rows * margin;
    return [px - mx, py - my, px + mx, py + my];
  },

  // Lua: map.lua:234
  warmNear(entry: any, x0?: number, y0?: number, x1?: number, y1?: number): boolean {
    if (x0 == null) return true;
    const layout = entry.def && entry.def.midLayout;
    const w = layout && layout.width, h = layout && layout.height;
    if (!(w != null && h != null)) return true;
    const ox = entry.ox ?? 0, oy = entry.oy ?? 0;
    return ox + w > x0 && ox <= x1! && oy + h > y0! && oy <= y1!;
  },

  // Lua: map.lua:243
  stepWarm(game: any): boolean {
    // package.loaded asset_stream / tileset_native
    const S = Stream;
    const Native = NativeTileset;
    if (Native && Native.prefetch) {
      const [x0, y0, x1, y1] = Map.warmRect();
      Map._warmScanTick = ((Map._warmScanTick ?? 0) + 1) % 4;
      if (Map._warmScanTick !== 0 && Map._warmScanWorld === Map.world
        && Map._warmScanX === x0 && Map._warmScanY === y0
        && Map._warmScanX1 === x1 && Map._warmScanY1 === y1) {
        if (S) S.update();
        return true;
      }
      Map._warmScanWorld = Map.world;
      Map._warmScanX = x0; Map._warmScanY = y0; Map._warmScanX1 = x1; Map._warmScanY1 = y1;
      const [vx0, vy0, vx1, vy1] = Map.warmRect(0);
      const wantedPairs: Record<string, boolean> = {};
      const priorities: Record<string, number> = {};
      const def = Map.currentDef();
      const currentPair = def && (def.pair ?? (def.midLayout && def.midLayout.pair));
      if (currentPair) { wantedPairs[currentPair] = true; priorities[currentPair] = 0; }
      const queue: LuaTable = Map._warmQueue ?? [null];
      for (let i = len(queue); i >= 1; i--) {
        const pair = queue[i];
        let near = !(Map._warmEntries && Map._warmEntries[pair]);
        for (const [, entry] of ipairs<any>((Map._warmEntries && Map._warmEntries[pair]) ?? [null])) {
          if (Map.warmNear(entry, x0, y0, x1, y1)) near = true;
          if (Map.warmNear(entry, vx0, vy0, vx1, vy1)) priorities[pair] = 0;
        }
        if (Native._pairs[pair]) remove(queue, i);
        else if (near) wantedPairs[pair] = true;
      }
      if (!queue[1]) Map._warmQueue = undefined;
      if (Native._stream) Native._stream.retain(wantedPairs);
      for (const [pair] of pairs(wantedPairs)) Native.prefetch(pair, priorities[pair] ?? 1);
      const Ow = OwSprites;
      const Obj = Objects;
      if (Obj && Obj.prefetchMap) {
        const wanted: Record<string, boolean> = {};
        for (const [, entry] of ipairs<WorldEntry>(Map.world ?? [null])) {
          if (Map.warmNear(entry, x0, y0, x1, y1)) {
            wanted[entry.id] = true;
            Obj.prefetchMap(entry.id, entry.def, entry.id === Map.current ? 0 : 1);
          }
        }
        Obj.retainPrepared(wanted);
      }
      if (game && Ow && Ow.prefetch) {
        const wanted: Record<number, number> = {};
        // Lua: map.lua:291
        const actor = (eo: any, ox?: number, oy?: number): void => {
          if (!(eo.visible && !eo.hidden && !eo.invisible)) return;
          const x = (eo.cellX ?? 0) + (ox ?? 0), y = (eo.cellY ?? 0) + (oy ?? 0);
          if (x0 == null || (x >= x0 && x <= x1! && y >= y0! && y <= y1!)) {
            const gid = tonumber(eo.graphicsId);
            if (gid != null) {
              const visible = vx0 == null || (x >= vx0 && x <= vx1! && y >= vy0! && y <= vy1!);
              wanted[gid] = Math.min(wanted[gid] ?? 1, visible ? 0 : 1);
            }
          }
        };
        for (const [, eo] of ipairs<any>((Obj && Obj.forDraw && Obj.forDraw()) ?? [null])) actor(eo);
        // package.loaded["src.core.game3.ghosts"]
        for (const [, entry] of ipairs<WorldEntry>(Map.world ?? [null])) {
          if (Map.warmNear(entry, x0, y0, x1, y1)) {
            for (const [, eo] of ipairs<any>((Ghosts && Ghosts.forDraw(entry.id)) ?? [null])) actor(eo, entry.ox, entry.oy);
          }
        }
        const gid = Ow.playerGraphicsId(game);
        if (gid != null) wanted[gid] = 0;
        if (Ow._stream) Ow._stream.retain(wanted);
        for (const [id, priority] of pairs<number>(wanted)) Ow.prefetch(id, priority);
      }
      if (game) FieldPlan.prefetch(game);
      if (S) S.update();
      return true;
    }
    const queue = Map._warmQueue;
    if (!queue) return false;
    const NT = NativeTileset;
    // love.timer is always present here
    if (Timer.getDelta() > Map.WARM_BUDGET_SEC
      && Map._warmDefer < Map.WARM_MAX_DEFER) {
      Map._warmDefer = Map._warmDefer + 1;
      return false;
    }
    Map._warmDefer = 0;
    const entries = Map._warmEntries ?? {};
    const [x0, y0, x1, y1] = Map.warmRect();
    let i = 1;
    while (queue[i]) {
      const pair = queue[i];
      if ((NT && (NT._pairs && NT._pairs[pair]))
        || !(NT && NT.get)) {
        remove(queue, i);
      } else {
        let near = !entries[pair];
        for (const [, entry] of ipairs<any>(entries[pair] ?? [null])) {
          if (Map.warmNear(entry, x0, y0, x1, y1)) { near = true; break; }
        }
        if (near) {
          remove(queue, i);
          if (NT.ready(pair)) {
            try { NT.get(pair); } catch { /* pcall */ }
            if (!queue[1]) Map._warmQueue = undefined;
            return true;
          }
        } else {
          i = i + 1;
        }
      }
    }
    if (!queue[1]) Map._warmQueue = undefined;
    return false;
  },

  // Lua: map.lua:358
  overscanSlices(): LuaTable {
    const slices: LuaTable = [null];
    for (const [, n] of ipairs<NeighborEntry>(Map.neighborList ?? [null])) {
      slices[len(slices) + 1] = { dir: n.dir, mapId: n.map ?? n.mapId, offset: n.offset };
    }
    return slices;
  },

  // Lua: map.lua:402
  /**
   * Resolve a cell in current-map space, sampling connected neighbors when OOB
   * (pret VMap connection fill). Returns [mid, sourcePair, void]. OOB with no
   * neighbor falls through to primary border tiling. The tuple is shared
   * (valid until the next call): destructure it at once.
   */
  worldMidAt(cx: number, cy: number, primaryDef: any): MidSample {
    const layout = primaryDef && primaryDef.midLayout;
    if (!layout) return out(0, undefined);
    const w = layout.width ?? 0, h = layout.height ?? 0;
    const primaryPair = layout.pair ?? primaryDef.pair;

    if (cx >= 0 && cy >= 0 && cx < w && cy < h) {
      return out(layout.midAt(cx, cy), primaryPair);
    }

    const list = Map.neighborList ?? [null];

    // pokefirered/src/fieldmap.c:129
    if (cy < 0) {
      fromDir(list, "north", cx, cy, w, h, primaryPair);
      if (sampleNb[0] != null) return out(sampleNb[0], sampleNb[1]);
    } else if (cy >= h) {
      fromDir(list, "south", cx, cy, w, h, primaryPair);
      if (sampleNb[0] != null) return out(sampleNb[0], sampleNb[1]);
    }

    if (cx < 0) {
      fromDir(list, "west", cx, cy, w, h, primaryPair);
      if (sampleNb[0] != null) return out(sampleNb[0], sampleNb[1]);
    } else if (cx >= w) {
      fromDir(list, "east", cx, cy, w, h, primaryPair);
      if (sampleNb[0] != null) return out(sampleNb[0], sampleNb[1]);
    }

    const world = Map.world;
    for (let i = 1; world[i] != null; i++) {
      const entry = world[i];
      const L = entry.def !== primaryDef && entry.def && entry.def.midLayout;
      if (L) {
        const nx = cx - entry.ox, ny = cy - entry.oy;
        if (nx >= 0 && ny >= 0 && nx < (L.width ?? 0) && ny < (L.height ?? 0)) {
          return out(L.midAt(nx, ny), L.pair ?? entry.def.pair ?? primaryPair);
        }
      }
    }

    return out(layout.midAt(cx, cy), primaryPair, true);
  },

  // Lua: map.lua:445
  /**
   * Ensure mapDef.midLayout is bound (lazy; Dataset.hydrate usually did this).
   * Returns the layout (void_fill.ts reads it as a one-value tuple, [layout]).
   */
  ensureMidLayout(game: any, mapId: string, defIn?: any): any {
    const def = defIn ?? host_map_def(game, mapId);
    if (!def) return undefined;
    if (def.midLayout) return def.midLayout;
    if (Dataset.attachMidLayouts && game && game.data && game.data.maps) {
      Dataset.attachMidLayouts({ [mapId]: def });
    }
    return def.midLayout;
  },

  // Lua: map.lua:459
  /**
   * Load a Sevii map under game3 ownership (pret enter order).
   * 1) Bind game3 player + collision + EventObjects
   * 2) Objects.loadMap then Space.runEnterScripts (ON_TRANSITION -> ON_FRAME)
   * Returns { mapId, neighbors, overscan }, or [undefined, err] (Lua: nil, err).
   */
  load(mod: any, game: any, mapId: string, optsIn?: any): any {
    const opts = optsIn ?? {};
    if (!MapIds.isGame3Map(mapId)) {
      return [undefined, "not a game3 map"];
    }
    if (!opts.seamless) {
      // package.loaded["src.ui.game3.message"]
      if (StayMessage && StayMessage.closeStay) StayMessage.closeStay();
    }
    // pret RestartWildEncounterImmunitySteps on LoadMap / LoadMapFromWarp: every
    // map entry restarts the wild encounter grace period. Unconditional, so the
    // seamless connection crossing between two routes resets it too.
    {
      if (Encounters && Encounters.resetRateModifiers) {
        Encounters.resetRateModifiers();
      }
      // NOT FAITHFUL: src.core.game3.roamer has no file in this port yet, so
      // Brian's pcall(require) fails and the roamer move (overworld.c:816 /
      // pokefirered's MoveAllRoamersToOtherLocationSets) is skipped.
    }
    const fromMapId = Map._announced;
    if (Map.current && Map.current !== mapId) {
      Ghosts.capture(Map.current);
    }
    if (fromMapId && fromMapId !== mapId && ModRuntime.wants("map.exited")) {
      ModRuntime.emit("map.exited", { mapId: fromMapId, toMapId: mapId });
    }
    Map._announced = mapId;
    Map.current = mapId;
    Map._loadedLayouts = { [mapId]: true };
    // overworld.c:792, overworld.c:759
    Map._worldRoot = undefined;

    let def = host_map_def(game, mapId);
    if (!def) {
      if (Dataset && Dataset.map) {
        def = Dataset.map(mapId);
      }
    }
    Map.ensureMidLayout(game, mapId, def);
    {
      // package.loaded["src.core.game3.runtime"]
      const sess = (Runtime && Runtime.getSession && Runtime.getSession()) ?? (game && game.session);
      if (def && sess && Profile.family(sess) === "rse") {
        throw new Error("NOT FAITHFUL: Emerald only (map.lua:521, rse.init pyramid / trainer hill onMapLoad)");
      }
    }
    Map._def = def;
    Map._currentDef = def;
    if (opts.depth1Connections !== false) {
      Map.loadNeighborsDepth1(game, def);
    } else {
      Map.neighbors = {};
      Map.neighborList = [null];
    }

    const world = host_world(game);
    const x = tonumber(opts.x) ?? 0;
    const y = tonumber(opts.y) ?? 0;
    const facing = opts.facing ?? "down";

    if (!Runtime.isActive || !Runtime.isActive()) {
      if (Runtime.ensureActiveForMap) {
        Runtime.ensureActiveForMap(mod, game, mapId);
      }
    }

    const session = (Runtime.getSession && Runtime.getSession()) ?? (game && game.session);
    const save = game && game.save;
    const onCyclingRoad = Player.isOnCyclingRoad && Player.isOnCyclingRoad(session, x, y, def);
    let wasBiking = (Player.biking === true);
    if (opts.initialLoad && !wasBiking) {
      wasBiking = (session && session.biking === true) || (save && save.biking === true) || false;
    }

    // pokefirered/src/overworld.c:878 GetAdjustedInitialTransitionFlags
    let keepBike = false;
    if (wasBiking || onCyclingRoad) {
      const allowed = def && def.bikingAllowed;
      if (allowed != null) {
        // pokefirered/src/overworld.c:948 Overworld_IsBikingAllowed
        keepBike = (tonumber(allowed) ?? 0) !== 0;
      } else {
        const pair = def && (def.pair ?? (def.midLayout && def.midLayout.pair));
        keepBike = typeof pair === "string" && find(pair, "outdoor", 1, true) != null;
      }
    }

    const isRse = session != null && Profile.family(session) === "rse";
    if (isRse && !opts.seamless && session.map) {
      // pokeemerald/src/overworld.c:542
      session.lastUsedWarp = { map: session.map, x: session.x, y: session.y };
    }
    if (session) {
      session.map = mapId;
      session.x = x;
      session.y = y;
      session.facing = facing;
      session.biking = keepBike;
    }

    // Keep save.position current for ferry exit / host save without setMap.
    if (save) {
      save.position = save.position ?? {};
      save.position.map = mapId;
      save.position.x = x;
      save.position.y = y;
      save.position.facing = facing;
      save.position.biking = keepBike;
      save.biking = keepBike;
    }

    if (opts.seamless) {
      // Connection remap (pret LoadMapFromCameraTransition): keep mid-step motion.
      // Caller parks one cell before landing and sets target toward landing.
      Player.cellX = x;
      Player.cellY = y;
      Player.px = x * 16;
      Player.py = y * 16;
      Player.facing = facing;
    } else {
      Player.reset(x, y, facing);
    }
    // pokefirered/src/overworld.c:2145 SetPlayerAvatarTransitionFlags
    Player.biking = keepBike;
    Player.syncSavePosition(game);

    // pcall(require, field_view)
    if (FieldView) FieldView._nativeDirty = true;
    // pokeemerald/src/overworld.c:529, pokeemerald/src/overworld.c:815
    {
      const TA = TilesetAnim as typeof TilesetAnim & { _rse?: unknown };
      const pair = def && (def.pair ?? (def.midLayout && def.midLayout.pair));
      if (TA && TA._rse && TA.enterMap && typeof pair === "string") {
        TA.enterMap(pair, opts.seamless === true);
      }
    }

    // Scripts/events before spawn so Objects.loadMap sees mapDef.objects.
    if (Space.ensureBundle) Space.ensureBundle(mod ?? Runtime._mod);
    if (def && Space.attachEventsToMaps && game && game.data && game.data.maps) {
      Space.attachEventsToMaps({ [mapId]: def }, Space.bundle);
    }

    // pokefirered/src/fieldmap.c:93
    Field.clearMetatiles(def && def.midLayout);
    if (def) {
      Collision.bindMap(game, mapId, def);
    } else {
      // No def for this id.  Keeping the previous map's grid bound would validate
      // movement against the map we just left; unbind so canEnter falls back to
      // the host map (collision.lua: "Prefer owned grid; fall back to host map").
      Collision.clear();
    }

    Map._warmPairs = !opts.seamless || undefined;
    // pret GroundEffect_SpawnOnTallGrass when warping onto grass.
    if (!opts.seamless) {
      const onGrass = Collision.isGrass && Collision.isGrass(Player.cellX, Player.cellY);
      if (Encounters && Encounters.noteGrass) {
        Encounters.noteGrass(onGrass);
      }
      if (FieldEffects) {
        if (onGrass && FieldEffects.tallGrassAt) {
          FieldEffects.tallGrassAt(Player.cellX, Player.cellY, true);
        } else if (FieldEffects.clearTallGrass) {
          FieldEffects.clearTallGrass();
        }
      }
    }

    // Activate scripts (flag store) -> spawn destination NPCs -> ON_TRANSITION.
    // pret order: never run setobjectxyperm against the previous map's localIds
    // (Pallet sign-lady localId=1 was teleporting Mom on FR_PLAYERS_HOUSE_1F).
    if (!opts.seamless) {
      Field.lock();
      // pokeemerald/src/overworld.c:2134
      VirtualObjects.clear();
    }

    // pokefirered/src/overworld.c:800
    if (fromMapId && (fromMapId !== mapId || opts.heal) && FieldModules.enabled("vsSeeker", session)) {
      VsSeeker.mapReset(session);
    }
    if (isRse && Capabilities.gate(session, "match_call")) {
      // pokeemerald/src/overworld.c:801
      throw new Error("NOT FAITHFUL: Emerald only (map.lua:681, rse.rematch)");
    }
    // pokeemerald/src/overworld.c:802
    if (session && Rtc.enabled(session)) {
      TimeEvents.run(session);
    }
    if (opts.keepScript && Space && Space.retarget) {
      Space.retarget(mod ?? Runtime._mod, mapId, game, world);
    } else if (Space && Space.activate) {
      Space.activate(mod ?? Runtime._mod, mapId, game, world);
    }

    // pokefirered/src/overworld.c:805
    const savedFlash = session ? tonumber(session.flashLevel) : undefined;
    if (FieldView && FieldView.setDefaultFlashLevel) {
      FieldView.setDefaultFlashLevel(game, mapId);
      // pokefirered/src/overworld.c:1691 CB2_ContinueSavedGame
      if (savedFlash != null && (opts.enterVia ?? Map._nextEnterVia) === "continue") {
        FieldView.setFlashLevel(savedFlash);
      }
    }

    if (def) {
      const seen = opts.seamless ? Ghosts.visibleIds(mapId) : undefined;
      Objects.loadMap(game, mapId, def);
      if (opts.carry) Objects.carryIn(opts.carry);
      if (opts.seamless) {
        Objects.beginFadeIn(seen ?? {});
        Ghosts.openFadeWindow();
      }
      Ghosts.adopt(mapId);
    }
    // pokefirered/src/overworld.c:771 / :808 TryRegenerateRenewableHiddenItems
    // NOT FAITHFUL: src.core.game3.renewable_hidden_items has no file in this
    // port yet; Brian's pcall(require) would fail, so the regeneration is skipped.
    if (FieldModules.enabled("renewableHiddenItems", session)) {
      // (Renewable.tryRegenerate(session, group, num, mapId) once ported)
    }
    // pokefirered/src/overworld.c:809 SetCurrentAndNextWeather
    if (def && def.weather != null) {
      Weather.apply(def.weather, { seamless: opts.seamless });
    }
    if (isRse && !opts.seamless && def && Dataset.isOutdoorMapType(def.mapType)) {
      // pokeemerald/src/overworld.c:857
      const flash = FieldSemantics.flag(session, "flashActive");
      if (flash != null && Space.store) Flags.setFlag(Space.store, undefined, flash, false);
    }
    // pokefirered/src/overworld.c:769
    // pokefirered/src/overworld.c:806
    Audio.setSavedSong(undefined);
    if (fromMapId === mapId) {
      if (opts.reason && ModRuntime.wants("map.reloaded")) {
        ModRuntime.emit("map.reloaded", { mapId, reason: opts.reason ?? "reload" });
      }
    } else if (ModRuntime.wants("map.entered")) {
      ModRuntime.emit("map.entered", {
        mapId, map: def, fromMapId,
        via: opts.via ?? ((opts.seamless && "connection")
          || (opts.heal && "respawn") || (fromMapId ? "warp" : "boot")),
      });
    }
    // pokefirered/src/overworld.c:1717
    const enterVia = opts.enterVia ?? Map._nextEnterVia;
    Map._nextEnterVia = undefined;
    if (Space && Space.runEnterScripts) {
      Space.runEnterScripts(mod ?? Runtime._mod, mapId, game, world,
        { seamless: opts.seamless, enterVia, keepScript: opts.keepScript });
    } else if (Space && Space.onMapEnter) {
      Space.onMapEnter(mod ?? Runtime._mod, mapId, game, world);
    }
    // pokeemerald/src/overworld.c:870
    if (session && !opts.seamless && Capabilities.has(session, "tv")
      && def && Dataset.isIndoorMapType(def.mapType)) {
      NativesTv.updateScreensOnMap(session);
    }

    // Map BGM from extract index / header music.
    {
      let music = def && def.music;
      if (music == null && Audio._pack && Audio._pack.index && Audio._pack.index.mapSongs) {
        music = Audio._pack.index.mapSongs[mapId];
      }
      // pokefirered/src/overworld.c:1063
      if (Map.disableMusicChange === Map.MUSIC_DISABLE_STOP) {
        Audio.playSong(0);
        music = undefined;
      } else if (Map.disableMusicChange === Map.MUSIC_DISABLE_KEEP) {
        music = undefined;
      }
      if (music != null && music !== 0xFFFF && Audio.mapMusicPolicy() === "rse") {
        // pokeemerald/src/overworld.c:1170
        Audio.mapLoadMusic({
          mapId, fromMapId, seamless: opts.seamless, music,
          x: Player.cellX, y: Player.cellY,
        });
      } else if (music != null && music !== 0xFFFF) {
        let id: number | undefined;
        if (opts.seamless) {
          // pokefirered/src/overworld.c:1075
          const fromDef = fromMapId && host_map_def(game, fromMapId);
          if (Audio._currentSong && Audio._currentSong.id === Audio.MUS_SURF) {
            Audio.setMapSong(music);
          } else if (Audio.specialMapSong(fromDef && fromDef.regionMapSectionId) === Audio.MUS_SURF) {
            id = Audio.MUS_SURF;
          } else {
            id = music;
          }
        } else {
          // pokefirered/src/overworld.c:1039
          id = Audio._savedSong ?? ((Audio.specialMapSong(def && def.regionMapSectionId) === Audio.MUS_SURF
            && Audio.MUS_SURF) || music);
        }
        if (id != null) Audio.playMapSong(id, { mapSong: music });
      }
    }

    // Location change overlay (pokefirered/src/overworld.c:785, 1687, 1922)
    // Strict arbiter: gMapHeader.showMapName == TRUE. If 0/false, strictly suppress popup.
    // overworld.c:1913 gives a changed map section with a FOREST preview screen
    // precedence over the popup; pret gates that on a real warp, not a connection.
    {
      const currSec = def && (def.regionMapSectionId ?? def.region_map_section_id);
      const lastSec = Map._lastSectionId;
      const showFlag = def && (def.showMapName ?? def.show_map_name);
      let previewed = false;

      if (currSec != null && !opts.seamless && lastSec !== currSec && FieldModules.enabled("mapPreview", session)) {
        if (MapPreviewScreen) {
          MapPreviewScreen.dismiss();
          previewed = MapPreviewScreen.show(currSec) === true;
        }
      }

      // NOT FAITHFUL: src.ui.game3.map_name_popup has no file in this port yet;
      // Brian's pcall(require) would fail, so no popup is shown or dismissed.
      if (FieldModules.enabled("mapNamePopup", session)) {
        void previewed; void showFlag;
      }
      if (def && def.regionMapSectionId != null) {
        Map._lastSectionId = def.regionMapSectionId;
      }
    }

    if (!opts.seamless) {
      if (!Space._pendingOnFrame
        && !(Space.vm && Space.vm.isRunning && Space.vm.isRunning())) {
        Field.unlock();
      }
    }

    if (Map._warmPairs) Map.warmNow(game, mapId);
    FixedStep.discardCatchup();

    return {
      mapId,
      neighbors: Map.neighbors,
      overscan: Map.overscanSlices(),
    };
  },

  // Lua: map.lua:858
  loadedLayoutCount(): number {
    let n = 0;
    for (const _ of pairs(Map._loadedLayouts)) n = n + 1;
    return n;
  },
};

// package.loaded["src.core.game3.map"] stand-in for void_fill.lua:107
// (VoidFill.layoutFor reads `[layout, pending]` from ensureMidLayout).
VoidFill.loaded.map = {
  ensureMidLayout(game: unknown, mapId: string): [any, boolean?] {
    return [Map.ensureMidLayout(game, mapId)];
  },
};

export default Map;
