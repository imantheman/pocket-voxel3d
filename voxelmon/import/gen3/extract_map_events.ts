// Port of gen1recomp src/import/gba/extract_map_events.lua (GPLv3 + additional terms; see LICENSE.md).
// Parse GBA MapHeader / MapEvents from ROM -> game3 event tables.
// Primary writer for scripts/events cache (Gen2 extractScriptsAndText pattern).
// Lists are 0-based JS arrays (the Lua's sequences); a Lua nil field is
// `undefined` (writers skip it, as Lua tables have no such key).

import { tonumber } from "./lua.ts";
import { Versions } from "./versions.ts";
import { Family } from "./family.ts";
import type { Rom } from "./rom.ts";
import { Opcodes } from "../../game/gen3/core/scripting/opcodes.ts";
import { GfxIds } from "../../game/gen3/core/scripting/gfx_ids.ts";
import { Constants } from "../../game/gen3/core/constants.ts";
import { MovementTypes } from "../../game/gen3/core/movement_types.ts";
import { MapCatalog } from "./map_catalog.ts";

// Lua: extract_map_events.lua:11
function map_id_for(group: unknown, num: unknown): string | undefined {
  return MapCatalog.mapIdFor(group, num);
}

const OBJ_SIZE = 24;
const BG_SIZE = 12;
const WARP_SIZE = 8;
const COORD_SIZE = 16;

// Map script types (pret constants/maps.h)
const MAP_SCRIPT_ON_LOAD = 1;
const MAP_SCRIPT_ON_FRAME_TABLE = 2;
const MAP_SCRIPT_ON_TRANSITION = 3;
const MAP_SCRIPT_ON_WARP_INTO_MAP_TABLE = 4;
const MAP_SCRIPT_ON_RESUME = 5;
const MAP_SCRIPT_ON_DIVE_WARP = 6;
const MAP_SCRIPT_ON_RETURN_TO_FIELD = 7;

export interface MapHeader {
  layout: number;
  events: number;
  scripts: number;
  connections: number;
  music: number;
  layoutId: number;
  [k: string]: unknown;
}

export interface Warp {
  x: number;
  y: number;
  destMap: string | undefined;
  destWarp: number;
  mapGroup: number;
  mapNum: number;
}

export interface MapEvents {
  objects: Record<string, any>[];
  bgEvents: Record<string, any>[];
  coordEvents: Record<string, any>[];
  warps: Warp[];
  warpCount: number;
  objectCount: number;
  bgCount: number;
  coordCount: number;
}

export interface Connection { dir: string; map: string; offset: number }

function gba_off(rom: Rom, ptr: number | undefined): number | undefined {
  return rom.ptrOffset(ptr);
}

// Lua: extract_map_events.lua:36
function parse_objects(rom: Rom, ptr: number, count: number): Record<string, any>[] {
  const off = gba_off(rom, ptr);
  if (off === undefined || count <= 0) return [];
  const F = Family.active();
  let berryTree: number | undefined;
  if (!F.cloneObjects) {
    berryTree = Constants.of(F.game).id("movement", "MOVEMENT_TYPE_BERRY_TREE_GROWTH");
  }
  const objects: Record<string, any>[] = [];
  for (let i = 0; i <= count - 1; i++) {
    const base = off + i * OBJ_SIZE;
    const localId = rom.get(base);
    const graphics = rom.get(base + 1);
    // include/constants/event_objects.h:194-195, fieldmap.h:110-130
    const kind = rom.get(base + 2);
    const isClone = kind === 255 && F.cloneObjects;
    let x = rom.u16(base + 4);
    if (x >= 0x8000) x = x - 0x10000;
    let y = rom.u16(base + 6);
    if (y >= 0x8000) y = y - 0x10000;
    let elev: number, movementType: number | undefined, rangeX: number, rangeY: number, trainerType: number, sight: number;
    let cloneTarget: Record<string, any> | undefined;
    if (isClone) {
      elev = 0;
      movementType = 0;
      rangeX = 0; rangeY = 0;
      trainerType = 0;
      sight = 0;
      cloneTarget = {
        localId: rom.get(base + 8),
        mapNum: rom.u16(base + 12),
        mapGroup: rom.u16(base + 14),
      };
      cloneTarget.mapId = map_id_for(cloneTarget.mapGroup, cloneTarget.mapNum);
    } else {
      elev = rom.get(base + 8);
      movementType = rom.get(base + 9);
      const rangeWord = rom.u16(base + 10);
      rangeX = rangeWord % 16;
      rangeY = Math.floor(rangeWord / 16) % 16;
      trainerType = rom.u16(base + 12);
      sight = rom.u16(base + 14);
    }
    const scriptPtr = rom.u32(base + 16);
    const flag = rom.u16(base + 20);
    const rawMovementType = movementType;
    movementType = MovementTypes.canon(F.game, rawMovementType);
    const host = GfxIds.hostMovement(movementType, rangeX, rangeY);
    let scriptKey: string | undefined;
    if (scriptPtr !== 0 && gba_off(rom, scriptPtr) !== undefined) {
      scriptKey = Opcodes.key(scriptPtr);
    }
    objects.push({
      localId,
      index: localId,
      graphicsId: graphics,
      graphics,
      sprite: F.cloneObjects ? GfxIds.spriteFor(graphics) : undefined,
      kind,
      x,
      y,
      elevation: elev,
      movementType,
      movementTypeRaw: movementType !== rawMovementType ? rawMovementType : undefined,
      rangeX,
      rangeY,
      movement: host.movement,
      range: host.range,
      radius: host.radius,
      trainerType,
      sight,
      trainerRange: sight,
      scriptPtr,
      scriptKey,
      flag,
      cloneTarget,
      berryTreeId: berryTree !== undefined && berryTree !== null && rawMovementType === berryTree ? sight : undefined,
    });
  }
  return objects;
}

// Lua: extract_map_events.lua:118
function parse_bg_events(rom: Rom, ptr: number, count: number): Record<string, any>[] {
  const off = gba_off(rom, ptr);
  if (off === undefined || count <= 0) return [];
  const F = Family.active();
  const hiddenStart = Constants.of(F.game).require("flags", "FLAG_HIDDEN_ITEMS_START");
  const bgs: Record<string, any>[] = [];
  for (let i = 0; i <= count - 1; i++) {
    const base = off + i * BG_SIZE;
    let x = rom.u16(base);
    if (x >= 0x8000) x = x - 0x10000;
    let y = rom.u16(base + 2);
    if (y >= 0x8000) y = y - 0x10000;
    const elev = rom.get(base + 4);
    const kind = rom.get(base + 5);
    if (kind === F.hiddenItemBgKind) {
      const h = F.hiddenItem(rom, base);
      bgs.push({
        type: "hidden_item",
        x,
        y,
        elevation: elev,
        kind,
        item: h.item,
        hiddenItemId: h.hiddenItemId,
        quantity: h.quantity,
        underfoot: h.underfoot,
        flag: hiddenStart + h.hiddenItemId,
      });
    } else if (kind === F.secretBaseBgKind) {
      bgs.push({
        type: "secret_base",
        x,
        y,
        elevation: elev,
        kind,
        secretBaseId: rom.u32(base + 8),
      });
    } else {
      const scriptPtr = rom.u32(base + 8);
      const row: Record<string, any> = {
        type: "sign",
        x,
        y,
        elevation: elev,
        kind,
        scriptPtr,
      };
      // Hidden items store item data in the union, not a script pointer.
      if (scriptPtr !== 0 && gba_off(rom, scriptPtr) !== undefined) {
        row.scriptKey = Opcodes.key(scriptPtr);
      }
      bgs.push(row);
    }
  }
  return bgs;
}

// Lua: extract_map_events.lua:175
function parse_coord_events(rom: Rom, ptr: number, count: number): Record<string, any>[] {
  const off = gba_off(rom, ptr);
  if (off === undefined || count <= 0) return [];
  const coords: Record<string, any>[] = [];
  for (let i = 0; i <= count - 1; i++) {
    const base = off + i * COORD_SIZE;
    const x = rom.u16(base);
    const y = rom.u16(base + 2);
    const elev = rom.get(base + 4);
    const v = rom.u16(base + 6);
    const value = rom.u16(base + 8);
    const scriptPtr = rom.u32(base + 12);
    const row: Record<string, any> = {
      x, y, elevation: elev,
      var: v, value,
      scriptPtr,
    };
    if (scriptPtr !== 0 && gba_off(rom, scriptPtr) !== undefined) {
      row.scriptKey = Opcodes.key(scriptPtr);
    }
    coords.push(row);
  }
  return coords;
}

export interface MapScripts {
  onLoad?: string;
  onTransition?: string;
  onResume?: string;
  onReturnToField?: string;
  onFrame: { var: number; value: number; script: string }[];
  onWarpIntoMap: { var: number; value: number; script: string }[];
  onDiveWarp: any;
}

// Lua: extract_map_events.lua:201 -- parse mapScripts table -> [mapScripts summary, seeds]
function parse_map_scripts(rom: Rom, scriptsPtr: number): [MapScripts, number[]] {
  const empty = (): MapScripts => ({
    onLoad: undefined,
    onTransition: undefined,
    onResume: undefined,
    onReturnToField: undefined,
    onFrame: [],
    onWarpIntoMap: [],
    onDiveWarp: [],
  });
  const off = gba_off(rom, scriptsPtr);
  if (off === undefined) {
    return [empty(), []];
  }
  const seeds: number[] = [];
  const mapScripts = empty();
  let i = off;
  let guard = 0;
  while (guard < 32) {
    guard = guard + 1;
    const typ = rom.get(i);
    if (typ === 0) break;
    const ptr = rom.u32(i + 1);
    i = i + 5;
    const poff = gba_off(rom, ptr);
    if (poff === undefined) continue;
    if (typ === MAP_SCRIPT_ON_TRANSITION || typ === MAP_SCRIPT_ON_LOAD
      || typ === MAP_SCRIPT_ON_RESUME || typ === MAP_SCRIPT_ON_RETURN_TO_FIELD
      || typ === MAP_SCRIPT_ON_DIVE_WARP) {
      const key = Opcodes.key(ptr);
      seeds.push(ptr);
      if (typ === MAP_SCRIPT_ON_TRANSITION) {
        mapScripts.onTransition = key;
      } else if (typ === MAP_SCRIPT_ON_LOAD) {
        // pokefirered/src/fieldmap.c:93
        mapScripts.onLoad = key;
      } else if (typ === MAP_SCRIPT_ON_RESUME) {
        mapScripts.onResume = key;
      } else if (typ === MAP_SCRIPT_ON_RETURN_TO_FIELD) {
        mapScripts.onReturnToField = key;
      } else {
        // pokeemerald/src/script.c:348
        mapScripts.onDiveWarp = key;
      }
    } else if (typ === MAP_SCRIPT_ON_FRAME_TABLE || typ === MAP_SCRIPT_ON_WARP_INTO_MAP_TABLE) {
      // Table of { u16 var, u16 value, script* } terminated by var==0.
      let t = poff;
      for (let n = 1; n <= 32; n++) {
        const v = rom.u16(t);
        if (v === 0) break;
        const value = rom.u16(t + 2);
        const sp = rom.u32(t + 4);
        t = t + 8;
        if (gba_off(rom, sp) !== undefined) {
          const key = Opcodes.key(sp);
          seeds.push(sp);
          const row = { var: v, value, script: key };
          if (typ === MAP_SCRIPT_ON_FRAME_TABLE) {
            mapScripts.onFrame.push(row);
          } else {
            mapScripts.onWarpIntoMap.push(row);
          }
        }
      }
    }
  }
  return [mapScripts, seeds];
}

// Lua: extract_map_events.lua:291
function s16(rom: Rom, offset: number): number {
  const v = rom.u16(offset);
  if (v >= 0x8000) return v - 0x10000;
  return v;
}

// Lua: extract_map_events.lua:297
function parse_warps(rom: Rom, ptr: number, count: number | undefined): Warp[] {
  const off = gba_off(rom, ptr);
  if (off === undefined || count === undefined || count < 1) return [];
  const out: Warp[] = [];
  for (let i = 0; i <= count - 1; i++) {
    const base = off + i * WARP_SIZE;
    const x = s16(rom, base);
    const y = s16(rom, base + 2);
    const warpId = rom.get(base + 5);
    const mapNum = rom.get(base + 6);
    const mapGroup = rom.get(base + 7);
    // Keep ROM order so destWarp indices from other maps stay valid.
    out.push({
      x,
      y,
      destMap: map_id_for(mapGroup, mapNum),
      destWarp: (tonumber(warpId) ?? 0) + 1,
      mapGroup,
      mapNum,
    });
  }
  return out;
}

export const ExtractMapEvents = {
  // Lua: extract_map_events.lua:274
  parseHeader(rom: Rom, headerOff: number): MapHeader {
    const layout = rom.u32(headerOff);
    const events = rom.u32(headerOff + 4);
    const scripts = rom.u32(headerOff + 8);
    const connections = rom.u32(headerOff + 12);
    const music = rom.u16(headerOff + 16);
    const layoutId = rom.u16(headerOff + 18);
    return {
      layout,
      events,
      scripts,
      connections,
      music,
      layoutId,
    };
  },

  // Lua: extract_map_events.lua:321
  parseMapEvents(rom: Rom, eventsPtr: number): MapEvents | undefined {
    const off = gba_off(rom, eventsPtr);
    if (off === undefined) return undefined;
    const objN = rom.get(off);
    const warpN = rom.get(off + 1);
    const coordN = rom.get(off + 2);
    const bgN = rom.get(off + 3);
    const objP = rom.u32(off + 4);
    const warpP = rom.u32(off + 8);
    const coordP = rom.u32(off + 12);
    const bgP = rom.u32(off + 16);
    return {
      objects: parse_objects(rom, objP, objN),
      bgEvents: parse_bg_events(rom, bgP, bgN),
      coordEvents: parse_coord_events(rom, coordP, coordN),
      warps: parse_warps(rom, warpP, warpN),
      warpCount: warpN,
      objectCount: objN,
      bgCount: bgN,
      coordCount: coordN,
    };
  },

  // Lua: extract_map_events.lua:344
  parseConnections(rom: Rom, connectionsPtr: number): Connection[] {
    const off = gba_off(rom, connectionsPtr);
    if (off === undefined) return [];
    // struct MapConnections { s32 count; MapConnection *connections; }
    let count = rom.u32(off);
    // interpret as signed
    if (count >= 0x80000000) count = 0;
    if (count > 8) count = 0; // sanity
    const listPtr = rom.u32(off + 4);
    const listOff = gba_off(rom, listPtr);
    if (listOff === undefined || count < 1) return [];
    const out: Connection[] = [];
    const dirs = Family.active().connDirs;
    for (let i = 0; i <= count - 1; i++) {
      const base = listOff + i * 12;
      const direction = rom.get(base);
      let offset = rom.u32(base + 4);
      if (offset >= 0x80000000) offset = offset - 0x100000000;
      const mapGroup = rom.get(base + 8);
      const mapNum = rom.get(base + 9);
      const dirName = dirs[direction];
      const destMap = map_id_for(mapGroup, mapNum);
      if (dirName && destMap) {
        out.push({ dir: dirName, map: destMap, offset });
      }
    }
    return out;
  },

  // Lua: extract_map_events.lua:375 -- ROM warps + connections for every map
  // in MAP_HEADERS: [warpsByMapId, connectionsByMapId]
  extractWarpsAndConnections(rom: Rom, version?: any): [Record<string, Warp[]>, Record<string, Connection[]>] {
    version = version ?? Versions.lookup(rom.md5)[0];
    const headers: Record<string, number> = (version && version.map_headers) || Versions.MAP_HEADERS;
    const warps: Record<string, Warp[]> = {}, connections: Record<string, Connection[]> = {};
    for (const mapId of Object.keys(headers)) {
      const headerOff = headers[mapId]!;
      const hdr = ExtractMapEvents.parseHeader(rom, headerOff);
      const ev = ExtractMapEvents.parseMapEvents(rom, hdr.events);
      warps[mapId] = (ev && ev.warps) || [];
      connections[mapId] = ExtractMapEvents.parseConnections(rom, hdr.connections) || [];
    }
    return [warps, connections];
  },

  // Lua: extract_map_events.lua:390 -- extract all maps listed in
  // MAP_HEADERS: [eventsByMapId, scriptSeedPtrs]
  // NOT FAITHFUL (order): the Lua walks MAP_HEADERS with pairs(), so the
  // seed list order is LuaJIT's hash order; here MAP_HEADERS insertion order.
  extractIsland1(rom: Rom, version?: any): [Record<string, any>, number[]] {
    version = version ?? Versions.lookup(rom.md5)[0];
    const headers: Record<string, number> = (version && version.map_headers) || Versions.MAP_HEADERS;
    const events: Record<string, any> = {};
    const seeds: number[] = [];
    const seen = new Set<number>();
    const add_seed = (ptr: number | undefined): void => {
      if (ptr === undefined || ptr === null || ptr === 0) return;
      if (seen.has(ptr)) return;
      if (gba_off(rom, ptr) === undefined) return;
      seen.add(ptr);
      seeds.push(ptr);
    };

    for (const mapId of Object.keys(headers)) {
      const headerOff = headers[mapId]!;
      const hdr = ExtractMapEvents.parseHeader(rom, headerOff);
      const ev = ExtractMapEvents.parseMapEvents(rom, hdr.events);
      if (!ev) {
        events[mapId] = {
          objects: [], bgEvents: [], coordEvents: [],
          mapScripts: { onFrame: [], onWarpIntoMap: [], onDiveWarp: [] },
          music: hdr.music,
        };
      } else {
        const [mapScripts, scriptSeeds] = parse_map_scripts(rom, hdr.scripts);
        for (const o of ev.objects) {
          if (o.scriptPtr !== undefined && o.scriptPtr !== 0) add_seed(o.scriptPtr);
        }
        for (const b of ev.bgEvents) {
          if (b.scriptKey !== undefined && b.scriptPtr !== undefined) add_seed(b.scriptPtr);
        }
        for (const c of ev.coordEvents) {
          if (c.scriptPtr !== undefined) add_seed(c.scriptPtr);
        }
        for (const sp of scriptSeeds) add_seed(sp);
        events[mapId] = {
          objects: ev.objects,
          bgEvents: ev.bgEvents,
          coordEvents: ev.coordEvents,
          mapScripts,
          headerOff,
          music: hdr.music,
        };
      }
    }
    return [events, seeds];
  },
};

export default ExtractMapEvents;
