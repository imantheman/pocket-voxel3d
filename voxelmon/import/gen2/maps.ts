// Port of gen1recomp RomExtractorGen2.lua:1170-1485 (bdfac727):
// mapNameByIds, readMapGroupEntry, readConnections, readMapEvents and
// extractMaps. Everything script-shaped is recorded as RAW pointers (plus
// the "bb:aaaa" scriptKey Brian keys them by); disassembling the bytecode
// they point at is the scripts stage's job (extractScriptsAndText, :3448),
// which reads these same fields.

import { check } from "../ctx.ts";
import { type Gen2Ctx, orderName, scriptKey, signedByte } from "./ctx.ts";

/** RomExtractorGen2.lua:74-80 — record lengths (macros/scripts/maps.asm,
 * data/maps/maps.asm, data/maps/attributes.asm). */
export const MAP_LENGTH = 9;
export const ATTR_LENGTH = 12;
export const CONNECTION_LENGTH = 12;
export const WARP_LENGTH = 5;
export const COORD_LENGTH = 8;
export const BG_LENGTH = 5;
export const OBJECT_LENGTH = 13;
/** :92 constants/map_setup_constants.asm — more callbacks is a misread. */
const NUM_MAPCALLBACK_TYPES = 5;
/** :206 connection flag bits (constants/map_data_constants.asm). */
export const CONN_EAST = 0x01;
export const CONN_WEST = 0x02;
export const CONN_SOUTH = 0x04;
export const CONN_NORTH = 0x08;

/** BGEVENT_IFSET / BGEVENT_IFNOTSET (constants/script_constants.asm). */
const BGEVENT_IFSET = 5;
const BGEVENT_IFNOTSET = 6;

const mapByIdsCache = new WeakMap<Gen2Ctx, Map<number, string>>();

/** RomExtractorGen2.lua:1181 — (group, map) -> const name via
 * constants.mapGroups; undefined (omitted) for an unknown pair. */
export function mapNameByIds(ctx: Gen2Ctx, group: number, map: number): string | undefined {
  let table = mapByIdsCache.get(ctx);
  if (!table) {
    table = new Map();
    for (const spec of ctx.manifest.constants.mapGroups ?? []) table.set(spec.group * 1000 + spec.map, spec.name);
    mapByIdsCache.set(ctx, table);
  }
  return table.get(group * 1000 + map);
}

/** One MapGroupPointers entry (data/maps/maps.asm `map` macro). */
export interface MapGroupEntry {
  attributesBank: number;
  tileset: number;
  environment: number;
  attributesAddress: number;
  landmark: number;
  music: number;
  phoneAndPalette: number;
  fishGroup: number;
}

/** RomExtractorGen2.lua:1191 — group and map are 1-based; every group table
 * lives in MapGroupPointers' bank. */
export function readMapGroupEntry(ctx: Gen2Ctx, group: number, map: number): MapGroupEntry {
  const { rom } = ctx;
  const pointers = ctx.symbol("MapGroupPointers");
  const bank = pointers.bank;
  const groupPtr = rom.word(bank, pointers.address + (group - 1) * 2);
  const entry = groupPtr + (map - 1) * MAP_LENGTH;
  return {
    attributesBank: rom.byte(bank, entry),
    tileset: rom.byte(bank, entry + 1),
    environment: rom.byte(bank, entry + 2),
    attributesAddress: rom.word(bank, entry + 3),
    landmark: rom.byte(bank, entry + 5),
    music: rom.byte(bank, entry + 6),
    phoneAndPalette: rom.byte(bank, entry + 7),
    fishGroup: rom.byte(bank, entry + 8),
  };
}

export interface Connection {
  group: number;
  map: number;
  mapId?: string;
  /** `db _len - _src`: blocks in the strip. */
  stripLength: number;
  /** the connected map's width */
  width: number;
  /** signed `db _y, _x` window coordinates */
  yOffset: number;
  xOffset: number;
  /** The macro's \4 (target offset in blocks): -x/2 north/south, -y/2
   * east/west. */
  offset: number;
}

/** RomExtractorGen2.lua:1209 — the connection records follow the 12-byte
 * attributes in north, south, west, east order, one per set flag bit.
 * Returns {north?, south?, west?, east?}. */
export function readConnections(
  ctx: Gen2Ctx,
  bank: number,
  address: number,
  flags: number,
): Record<string, Connection> {
  const { rom } = ctx;
  const dirs: [number, string][] = [
    [CONN_NORTH, "north"],
    [CONN_SOUTH, "south"],
    [CONN_WEST, "west"],
    [CONN_EAST, "east"],
  ];
  const connections: Record<string, Connection> = {};
  let cursor = address;
  for (const [bit, key] of dirs) {
    if ((flags & bit) === 0) continue;
    const group = rom.byte(bank, cursor);
    const map = rom.byte(bank, cursor + 1);
    const yOffset = signedByte(rom.byte(bank, cursor + 8));
    const xOffset = signedByte(rom.byte(bank, cursor + 9));
    let offset = key === "north" || key === "south" ? -Math.floor(xOffset / 2) : -Math.floor(yOffset / 2);
    if (offset === 0) offset = 0; // :1231 — no -0
    connections[key] = {
      group,
      map,
      mapId: mapNameByIds(ctx, group, map),
      stripLength: rom.byte(bank, cursor + 6),
      width: rom.byte(bank, cursor + 7),
      yOffset,
      xOffset,
      offset,
    };
    cursor += CONNECTION_LENGTH;
  }
  return connections;
}

export interface Warp {
  x: number;
  y: number;
  /** 1-based destination warp (warp_event \4). */
  destWarp: number;
  destGroup: number;
  destMapNum: number;
  destMap?: string;
}

export interface CoordEvent {
  sceneId: number;
  y: number;
  x: number;
  /** raw script pointer in the map's events bank */
  script: number;
}

export interface BgEvent {
  y: number;
  x: number;
  /** BGEVENT_* function byte */
  kind: number;
  /** raw pointer: bytecode, or (BGEVENT_ITEM) a `hiddenitem` record; for
   * IFSET/IFNOTSET the conditional_event's script word */
  script: number;
  /** IFSET/IFNOTSET only: the conditional_event's EVENT_* id */
  event?: number;
}

export interface MapObject {
  /** 1-based position in the object list (object_const_def starts at 2,
   * the player being 1) */
  index: number;
  spriteId: number;
  sprite: string | number;
  /** block coords, the +4 border already removed */
  x: number;
  y: number;
  movement: number;
  radius: { y: number; x: number };
  /** signed h1, h2 (-1 = the time-of-day form) */
  hours: [number, number];
  palette: number;
  type: number;
  sight: number;
  script: number;
  /** EVENT_* flag word. Brian's `x == 0xFFFF and nil or x` is the Lua
   * and/or trap (it always yields x), so -1 ("always appear") comes out as
   * 65535 -- kept as he writes it, since the world port reads this shape. */
  eventFlag: number;
}

export interface MapEvents {
  warps: Warp[];
  coordEvents: CoordEvent[];
  bgEvents: BgEvent[];
  objects: MapObject[];
  /** Bus address of the first object_event (wCurMapObjectEventsPointer). */
  objectEventsAddr: number;
}

/** RomExtractorGen2.lua:1246 readMapEvents (*_MapEvents, macros/scripts/maps.asm). */
export function readMapEvents(
  ctx: Gen2Ctx,
  bank: number,
  address: number,
  spriteOrder: string[] | undefined,
): MapEvents {
  const { rom } = ctx;
  // `db 0, 0 ; filler`
  let cursor = address + 2;

  const warps: Warp[] = [];
  const warpCount = rom.byte(bank, cursor++);
  for (let i = 0; i < warpCount; i++) {
    // warp_event: db y, x, dest; map_id (group, map)
    const destGroup = rom.byte(bank, cursor + 3);
    const destMapNum = rom.byte(bank, cursor + 4);
    warps.push({
      x: rom.byte(bank, cursor + 1),
      y: rom.byte(bank, cursor),
      destWarp: rom.byte(bank, cursor + 2),
      destGroup,
      destMapNum,
      destMap: mapNameByIds(ctx, destGroup, destMapNum),
    });
    cursor += WARP_LENGTH;
  }

  const coordEvents: CoordEvent[] = [];
  const coordCount = rom.byte(bank, cursor++);
  for (let i = 0; i < coordCount; i++) {
    // coord_event: db scene, y, x; db 0; dw script; dw 0
    coordEvents.push({
      sceneId: rom.byte(bank, cursor),
      y: rom.byte(bank, cursor + 1),
      x: rom.byte(bank, cursor + 2),
      script: rom.word(bank, cursor + 4),
    });
    cursor += COORD_LENGTH;
  }

  const bgEvents: BgEvent[] = [];
  const bgCount = rom.byte(bank, cursor++);
  for (let i = 0; i < bgCount; i++) {
    // bg_event: db y, x, function; dw pointer
    const kind = rom.byte(bank, cursor + 2);
    const pointer = rom.word(bank, cursor + 3);
    const ev: BgEvent = { y: rom.byte(bank, cursor), x: rom.byte(bank, cursor + 1), kind, script: pointer };
    // :1305 — IFSET/IFNOTSET aim at a `conditional_event` (dw event, dw
    // script, both in the map's bank), not at bytecode.
    if (kind === BGEVENT_IFSET || kind === BGEVENT_IFNOTSET) {
      ev.event = rom.word(bank, pointer);
      ev.script = rom.word(bank, pointer + 2);
    }
    bgEvents.push(ev);
    cursor += BG_LENGTH;
  }

  const objects: MapObject[] = [];
  const objectCount = rom.byte(bank, cursor++);
  const objectEventsAddr = cursor;
  for (let i = 0; i < objectCount; i++) {
    // object_event: db sprite, y+4, x+4, movement; dn ry, rx; db h1, h2;
    // dn palette, type; db sight; dw script, flag
    const spriteId = rom.byte(bank, cursor);
    const radius = rom.byte(bank, cursor + 4);
    const palType = rom.byte(bank, cursor + 7);
    objects.push({
      index: i + 1,
      spriteId,
      sprite: orderName(spriteOrder, spriteId),
      x: rom.byte(bank, cursor + 2) - 4,
      y: rom.byte(bank, cursor + 1) - 4,
      movement: rom.byte(bank, cursor + 3),
      radius: { y: Math.floor(radius / 16), x: radius % 16 },
      hours: [signedByte(rom.byte(bank, cursor + 5)), signedByte(rom.byte(bank, cursor + 6))],
      palette: Math.floor(palType / 16),
      type: palType % 16,
      sight: rom.byte(bank, cursor + 8),
      script: rom.word(bank, cursor + 9),
      eventFlag: rom.word(bank, cursor + 11),
    });
    cursor += OBJECT_LENGTH;
  }

  return { warps, coordEvents, bgEvents, objects, objectEventsAddr };
}

export interface SceneScript {
  sceneId: number;
  script: number;
  scriptKey: string;
}

export interface MapCallback {
  /** MAPCALLBACK_* byte */
  type: number;
  callback: string | number;
  script: number;
  scriptKey: string;
}

/** RomExtractorGen2.lua:1400-1439 — the map scripts header
 * (def_scene_scripts {dw script, dw 0} x N; def_callbacks {db type, dw
 * script} x M), read defensively: Brian pcall-wraps every read, so a bad
 * pointer yields empty lists rather than an error. sceneScripts is keyed by
 * 0-based scene id (an object: 0-keyed and sparse where a script is 0). */
export function readMapScripts(
  ctx: Gen2Ctx,
  bank: number,
  scriptsAddr: number,
): { sceneScripts: Record<string, SceneScript>; callbacks: MapCallback[] } {
  const { rom } = ctx;
  const sceneScripts: Record<string, SceneScript> = {};
  const callbacks: MapCallback[] = [];
  const attempt = <T>(read: () => T): T | undefined => {
    try {
      return read();
    } catch {
      return undefined;
    }
  };
  if (!(bank > 0 && scriptsAddr >= 0x4000)) return { sceneScripts, callbacks };
  const sceneCount = attempt(() => rom.byte(bank, scriptsAddr));
  if (sceneCount === undefined || sceneCount >= 32) return { sceneScripts, callbacks };
  for (let si = 0; si < sceneCount; si++) {
    const script = attempt(() => rom.word(bank, scriptsAddr + 1 + si * 4));
    if (script) sceneScripts[String(si)] = { sceneId: si, script, scriptKey: scriptKey(bank, script) };
  }
  const cbBase = scriptsAddr + 1 + sceneCount * 4;
  const cbCount = attempt(() => rom.byte(bank, cbBase));
  if (cbCount !== undefined && cbCount <= NUM_MAPCALLBACK_TYPES) {
    for (let ci = 0; ci < cbCount; ci++) {
      const row = cbBase + 1 + ci * 3;
      const kind = attempt(() => rom.byte(bank, row));
      const script = attempt(() => rom.word(bank, row + 1));
      if (kind !== undefined && script) {
        callbacks.push({
          type: kind,
          // :1425 — MAPCALLBACK_* is const_def 1 behind a placeholder, so
          // the byte lands on Lua index byte + 1.
          callback: orderName(ctx.manifest.constants.mapCallbackOrder, kind + 1),
          script,
          scriptKey: scriptKey(bank, script),
        });
      }
    }
  }
  return { sceneScripts, callbacks };
}

/**
 * RomExtractorGen2.lua:1357 extractMaps (minus its extractRoofs call, which
 * index.ts runs in the same stage). maps.json is {MAP_NAME: {
 *   id, generation 2, group, map (1-based ids), width, height (blocks),
 *   borderBlock, tileset (TILESET_* name), tilesetId (raw constant),
 *   environment (name), environmentId, landmark, music (raw bytes),
 *   phoneService (true = HAS service: the high nybble is zero),
 *   palette (PALETTE_* name), fishGroup (FISHGROUP_* name),
 *   blocks (width*height block ids, row-major), blockdata {bank, address},
 *   connections {north?,south?,west?,east?: Connection},
 *   warps, coordEvents, bgEvents, objects (see readMapEvents),
 *   objectEventsAddr, sceneScripts {"<sceneId>": SceneScript},
 *   callbacks [MapCallback], scripts {bank, address} (the MapScripts
 *   header), events {bank, address}, source "ROM:MapGroupPointers[g][m]" }}.
 */
export function extractMaps(ctx: Gen2Ctx): Record<string, unknown> {
  const { rom } = ctx;
  const consts = ctx.manifest.constants;
  const out: Record<string, unknown> = {};
  for (const name of consts.mapOrder) {
    const spec = ctx.manifest.maps[name];
    check(spec, `manifest has no map spec for ${name}`);
    const entry = readMapGroupEntry(ctx, spec.group, spec.map);
    const attrBank = entry.attributesBank;
    const attrAddr = entry.attributesAddress;

    // map_attributes: db border; db height, width; db BANK(Blocks); dw
    // Blocks; db BANK(MapScripts); dw MapScripts, MapEvents; db connections
    const border = rom.byte(attrBank, attrAddr);
    const height = rom.byte(attrBank, attrAddr + 1);
    const width = rom.byte(attrBank, attrAddr + 2);
    check(width === spec.width && height === spec.height, `${name}: attributes dims mismatch manifest`);
    const blocksBank = rom.byte(attrBank, attrAddr + 3);
    const blocksAddr = rom.word(attrBank, attrAddr + 4);
    const eventsBank = rom.byte(attrBank, attrAddr + 6);
    const scriptsAddr = rom.word(attrBank, attrAddr + 7);
    const eventsAddr = rom.word(attrBank, attrAddr + 9);
    const connFlags = rom.byte(attrBank, attrAddr + 11);

    const blocks = rom.bytes(blocksBank, blocksAddr, width * height);
    const connections = readConnections(ctx, attrBank, attrAddr + ATTR_LENGTH, connFlags);
    const events = readMapEvents(ctx, eventsBank, eventsAddr, consts.spriteOrder);
    const { sceneScripts, callbacks } = readMapScripts(ctx, eventsBank, scriptsAddr);
    const phonePalette = entry.phoneAndPalette;

    out[name] = {
      id: name,
      generation: 2,
      group: spec.group,
      map: spec.map,
      width,
      height,
      borderBlock: border,
      // tileset/environment constants are 1-based (TILESET_JOHTO = 1), so
      // the raw byte IS the Lua index; palette/fish groups are 0-based.
      tileset: orderName(consts.tilesetOrder, entry.tileset),
      tilesetId: entry.tileset,
      environment: orderName(consts.environmentOrder, entry.environment),
      environmentId: entry.environment,
      landmark: entry.landmark,
      music: entry.music,
      // :1453 GetMapPhoneService — a ZERO high nybble means service.
      phoneService: Math.floor(phonePalette / 16) === 0,
      palette: orderName(consts.paletteOrder, (phonePalette % 16) + 1),
      fishGroup: orderName(consts.fishGroupOrder, entry.fishGroup + 1),
      blocks,
      blockdata: { bank: blocksBank, address: blocksAddr },
      connections,
      warps: events.warps,
      coordEvents: events.coordEvents,
      bgEvents: events.bgEvents,
      objects: events.objects,
      objectEventsAddr: events.objectEventsAddr,
      sceneScripts,
      callbacks,
      scripts: { bank: eventsBank, address: scriptsAddr },
      events: { bank: eventsBank, address: eventsAddr },
      source: `ROM:MapGroupPointers[${spec.group}][${spec.map}]`,
    };
  }
  return out;
}
