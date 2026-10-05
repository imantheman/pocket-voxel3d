// Port of gen1recomp src/core/game3/doors.lua (GPLv3 + additional terms; see LICENSE.md).
// Game3 Door & Entrance Animation and Audio Engine (FRLG / GBA).
// Implements:
// 1. Exact sound selection per door type (SE_SLIDING_DOOR vs SE_DOOR vs SE_EXIT).
// 2. Multi-frame door opening and closing state machine (1x1 and 1x2 sizes).
// 3. Script opcode integration (opendoor, closedoor, waitdooranim).
// 4. Warp / field transition coordination.
//
// Shapes: Lua multiple returns are 0-based tuples. getDoorEntryAt returns
// [entry, doorInfo] (or [] for nil); getSoundForWarp returns [sound, kind].
// package.loaded["src.core.game3.map"] / ["src.core.game3.runtime"]: every
// module is loaded in the bundle, so they are imported directly (a stub's
// fields read undefined, as an unloaded module's would). `love` is always
// present on the port, so Brian's `love and love.x` guards are constant true.

import { SE } from "./se_ids.ts";
import { MB } from "./mb.ts";
import { Profile } from "./profile.ts";
import { Dataset } from "./dataset.ts";
import { Map } from "./map.ts";
import { Runtime } from "./runtime.ts";
import { Collision } from "./collision.ts";
import { Audio } from "./audio.ts";
import { LayoutNative } from "./layout_native.ts";
import { CachePaths } from "./cache_paths.ts";
import { CacheFs } from "../shared/import/CacheFs.ts";
import { Versions } from "../../../import/gen3/versions.ts";
import { NativePack } from "../../../import/gen3/native_pack.ts";
import { tostring, truthy } from "../../../import/gen3/lua.ts";
import { find, gsub } from "../platform/lpattern.ts";
import { ipairs, fromArray, type LuaTable } from "../platform/lt.ts";
import { luaLoad } from "../platform/luadata.ts";
import { Fs } from "../platform/fs.ts";
import { G } from "../platform/graphics.ts";
import { newImageData, type Image, type Quad } from "../platform/image.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface DoorEntry {
  index?: number;
  mid?: number;
  tile?: string;
  file?: string;
  sound?: string;
  sound_type?: number;
  size?: string;
  size_type?: number;
  tileset?: string;
  [k: string]: any;
}

export interface DoorInfo {
  file?: string;
  width?: number;
  height?: number;
  frame_width?: number;
  frame_height?: number;
  frames?: number;
  [k: string]: any;
}

export interface DoorAnim {
  mapId: any;
  x: number;
  y: number;
  kind: string;
  soundKind: string | undefined;
  tile: string | undefined;
  sheetFile: string | undefined;
  size: string;
  mode: string;
  frame: number;
  timer: number;
  delayTimer?: number;
  targetFrame: number;
  onDone?: (() => void) | undefined;
}

export interface DoorSheet {
  image: Image;
  quads: Quad[]; // [0]-keyed, as Brian's quads[fi]
  width: number;
  height: number;
  frame_width: number;
  frame_height: number;
  frames: number;
}

export interface DoorOpts {
  destMap?: any;
  sound?: number;
  playSound?: boolean;
  [k: string]: any;
}

// Lua: doors.lua:14
const SOUND_NAMES: Record<string, [string, number]> = {
  SOUND_NORMAL: ["SE_DOOR", 241],
  SOUND_SLIDING: ["SE_SLIDING_DOOR", 18],
  SOUND_EXIT: ["SE_EXIT", 238],
};

// Lua: doors.lua:20 (the metatable's __index: Doors.SOUND_* read through SE)
function soundName(k: string): number {
  const row = SOUND_NAMES[k]!;
  return SE[row[0]] ?? row[1];
}

// include/constants/metatile_behaviors.h:81
const MB_WARP_DOOR = 0x69;
// pokeemerald/src/metatile_behavior.c:228
const MB_PETALBURG_GYM_DOOR = MB.id("PETALBURG_GYM_DOOR");
void MB_PETALBURG_GYM_DOOR; // used only by the Emerald path (lookupRseDoorAt)

const EMPTY: LuaTable = {};

// Lua: doors.lua:35
function fieldBlock(): LuaTable {
  // package.loaded["src.core.game3.profile"] or require(...): imported
  let ok: boolean, row: any;
  try {
    row = Profile.forSession();
    ok = true;
  } catch (e) {
    ok = false;
    row = e;
  }
  return (ok && truthy(row) && truthy(row.field)) ? row.field : EMPTY;
}

// pokeemerald/src/field_door.c:546
// Lua: doors.lua:42
function soundFor(kind: string | undefined): number {
  const names = fieldBlock().doorSounds;
  const name = truthy(names) ? names[kind ?? "normal"] : undefined;
  if (truthy(name) && truthy(SE[name])) return SE[name];
  if (kind === "sliding") return Doors.SOUND_SLIDING;
  return Doors.SOUND_NORMAL;
}

// Lua: doors.lua:61
function cacheRoot(): string {
  // pcall(require, "src.core.game3.dataset"): imported
  if (Dataset && Dataset.mountExtractRoots) {
    Dataset.mountExtractRoots();
  }
  // Extract.CACHE_ROOT (src.import.gba.extract_island1) is a proxy onto
  // CachePaths (extract_island1.lua:21)
  return CachePaths.CACHE_ROOT ?? "data/generated/gba";
}

// Lua: doors.lua:70
function doorsRoot(): string {
  return cacheRoot() + "/doors";
}

// Lua: doors.lua:74
function loadManifest(): LuaTable {
  if (Doors._manifestLoaded) return Doors._manifest;
  Doors._manifestLoaded = true;

  const rel = doorsRoot() + "/manifest.lua";
  let content: string | undefined = undefined;

  // pcall(require, "src.core.game3.dataset"): imported
  if (Dataset && Dataset.cache) {
    const cache = Dataset.cache();
    if (cache && cache.read) {
      content = cache.read(rel) ?? cache.read("doors/manifest.lua");
    }
  }

  if (content == null) {
    // pcall(require, "src.import.CacheFs"): imported
    if (CacheFs && CacheFs.readActive) {
      content = CacheFs.readActive(rel) ?? CacheFs.readActive("doors/manifest.lua");
    }
  }

  if (content == null) {
    content = Fs.read(rel) ?? Fs.read("doors/manifest.lua");
  }

  // NOT FAITHFUL: io.open(rel) (a read relative to the working directory) has
  // no counterpart on the 3DS; love.filesystem above already covers the cache.

  if (content != null) {
    const [chunk] = luaLoad(content, "@" + rel);
    if (chunk) {
      let ok = false, res: unknown;
      try {
        res = chunk();
        ok = true;
      } catch {
        ok = false;
      }
      if (ok && typeof res === "object" && res !== null) {
        Doors._manifest = res;
        return res;
      }
    }
  }

  console.log("[game3/doors] no door manifest in the cache; door animations are off");
  Doors._manifest = {
    doors: {},
    by_mid: {},
  };
  return Doors._manifest;
}

// Lua: doors.lua:129
function isPairMatch(doorTileset: string | undefined, pair: string | undefined): boolean {
  if (!truthy(doorTileset) || doorTileset === "primary") return true;
  const p = tostring(pair ?? "").toLowerCase();
  if (p === "") return false;
  const has = (s: string): boolean => find(p, s) != null;
  if (doorTileset === "pallet" && (has("pallet") || has("oaks_lab"))) return true;
  if (doorTileset === "viridian" && has("viridian")) return true;
  if (doorTileset === "pewter" && has("pewter_outdoor")) return true;
  if (doorTileset === "saffron" && has("saffron")) return true;
  if (doorTileset === "cerulean" && has("cerulean")) return true;
  if (doorTileset === "lavender" && has("lavender")) return true;
  if (doorTileset === "vermilion" && has("vermilion")) return true;
  if (doorTileset === "celadon" && has("celadon")) return true;
  if (doorTileset === "fuchsia" && has("fuchsia")) return true;
  if (doorTileset === "cinnabar" && has("cinnabar")) return true;
  if (doorTileset === "sevii_123" && (has("sevii_outdoor") || has("sevii_123") || has("one_island") || has("two_island") || has("three_island"))) return true;
  if (doorTileset === "sevii_45" && (has("sevii_45") || has("four_island") || has("five_island") || has("rocket_warehouse"))) return true;
  if (doorTileset === "sevii_67" && (has("sevii_67") || has("six_island") || has("seven_island"))) return true;
  if (doorTileset === "dept_store" && (has("dept_store") || has("department_store"))) return true;
  if (doorTileset === "cable_club" && (has("cable_club") || has("network") || has("pokemon_center"))) return true;
  if (doorTileset === "silph_co" && (has("silph_co") || has("rocket_hideout"))) return true;
  if (doorTileset === "ss_anne" && has("ss_anne")) return true;
  if (doorTileset === "sea_cottage" && has("sea_cottage")) return true;
  if (doorTileset === "trainer_tower" && has("trainer_tower")) return true;
  return false;
}

// Lua: doors.lua:157 (resolveLayout's local norm; returns gsub's first value only)
function norm(m: unknown): string {
  return gsub(gsub(tostring(m ?? ""), "^FR_", "")[0], "^MAP_", "")[0];
}

// Lua: doors.lua:155
function resolveLayout(mapId: any): [any?, string?] {
  if (!truthy(mapId)) return [];
  const key = norm(mapId);

  // package.loaded["src.core.game3.map"]: imported
  if (Map && Map._def && Map._def.midLayout) {
    if (norm(Map.current) === key || norm(Map._def.id ?? Map._def.name) === key) {
      return [Map._def.midLayout, Map._def.pair];
    }
  }

  if (Map && Map.neighborList) {
    for (const [, n] of ipairs<any>(Map.neighborList)) {
      if (n.def && n.def.midLayout) {
        if (norm(n.map ?? n.mapId) === key) {
          return [n.def.midLayout, n.def.pair];
        }
      }
    }
  }

  // package.loaded["src.core.game3.runtime"]: imported
  const g = Runtime && Runtime._game;
  if (g && g.data && g.data.maps) {
    const m = g.data.maps[mapId] ?? g.data.maps["FR_" + key] ?? g.data.maps[key];
    if (m && m.midLayout) {
      return [m.midLayout, m.pair];
    }
  }

  if (Doors._layoutCache[key] != null) {
    const cached = Doors._layoutCache[key];
    if (cached) return [cached, cached.pair];
    return [undefined, undefined];
  }

  // pcall(require, "src.core.game3.dataset"): imported
  if (Dataset) {
    const cache = Dataset.cache && Dataset.cache();
    if (cache) {
      const nativeRoot = cacheRoot() + "/native";
      const rel1 = nativeRoot + "/layouts/" + mapId + ".mid";
      const rel2 = nativeRoot + "/layouts/FR_" + key + ".mid";
      const rel3 = nativeRoot + "/layouts/" + key + ".mid";
      const blob = cache.read(rel1) ?? cache.read(rel2) ?? cache.read(rel3);
      if (blob != null) {
        let pair: string | undefined = undefined;
        let natManifest: any = undefined;
        const natSrc = cache.read(nativeRoot + "/manifest.lua");
        if (natSrc != null) {
          const [chunk] = luaLoad(natSrc, "@native/manifest.lua");
          if (chunk) {
            try {
              const res = chunk();
              if (typeof res === "object" && res !== null) natManifest = res;
            } catch { /* pcall: ignored */ }
          }
        }
        if (natManifest && natManifest.layouts) {
          const info = natManifest.layouts[mapId] ?? natManifest.layouts["FR_" + key] ?? natManifest.layouts[key];
          pair = info ? info.pair : undefined;
        }
        if (!truthy(pair)) {
          // pcall(require, "src.import.gba.versions"): imported
          if (Versions && Versions.MAPS) {
            const spec = Versions.MAPS[mapId] ?? Versions.MAPS["FR_" + key] ?? Versions.MAPS[key];
            pair = spec ? spec.pair : undefined;
          }
        }
        const [decoded] = NativePack.decodeMidLayout(blob);
        if (decoded) {
          // seam: decodeMidLayout returns 0-based cells/borderMids; fromDecoded
          // takes Lua sequences
          const layout = LayoutNative.fromDecoded(
            { ...decoded, cells: fromArray(decoded.cells), borderMids: fromArray(decoded.borderMids) }, mapId, pair);
          Doors._layoutCache[key] = layout;
          return [layout, pair];
        }
      }
    }
  }

  Doors._layoutCache[key] = false;
  return [undefined, undefined];
}

// Lua: doors.lua:241
function normTileset(_name: unknown): string {
  throw new Error("NOT FAITHFUL: Emerald only (doors normTileset)");
}

// Lua: doors.lua:245
function rsePairDoors(_manifest: LuaTable, _pair: unknown): LuaTable {
  void normTileset;
  throw new Error("NOT FAITHFUL: Emerald only (doors rsePairDoors)");
}

// pokeemerald/src/field_door.c:426
// Lua: doors.lua:263
function lookupRseDoorAt(_manifest: LuaTable, _mapId: any, _x: number, _y: number): [DoorEntry?, DoorInfo?] {
  void rsePairDoors;
  throw new Error("NOT FAITHFUL: Emerald only (doors lookupRseDoorAt)");
}

// Lua: doors.lua:288
function lookupDoorAt(mapId: any, x: number, y: number): [DoorEntry?, DoorInfo?] {
  const manifest = loadManifest();
  if (manifest && manifest.family === "rse") {
    return lookupRseDoorAt(manifest, mapId, x, y);
  }
  if (!manifest || !manifest.by_mid) return [];

  const [layout, pair] = resolveLayout(mapId);
  let mid: number | undefined = undefined;
  if (layout && layout.midAt) {
    mid = layout.midAt(x, y);
  }

  if (mid != null && manifest.by_mid[mid]) {
    const entry: DoorEntry = manifest.by_mid[mid];
    const p = pair ?? (layout ? layout.pair : undefined);
    let beh: number | null | undefined = undefined;
    // pcall(require, "src.core.game3.collision"): imported
    if (Collision && Collision.behaviorOn) {
      beh = Collision.behaviorOn({ midLayout: layout, pair: p }, x, y);
    }
    // src/field_door.c:498
    let isDoorTile: boolean;
    if (beh != null) {
      isDoorTile = (beh === MB_WARP_DOOR);
    } else {
      isDoorTile = isPairMatch(entry.tileset, p);
    }
    if (isDoorTile) {
      const doorInfo = manifest.doors ? manifest.doors[entry.tile!] : undefined;
      return [entry, doorInfo];
    }
  }

  return [];
}

// src/fieldmap.c:367
// Lua: doors.lua:326
function liveMapId(): any {
  // package.loaded["src.core.game3.runtime"] / ["src.core.game3.map"]: imported
  const session = Runtime && Runtime.getSession && Runtime.getSession();
  if (session && session.map) return session.map;
  return Map ? (Map.current ?? undefined) : undefined;
}

// src/field_door.c:396
// Lua: doors.lua:365
function resolveDoorKind(mapId: any, x: number | undefined, y: number | undefined):
  [string | undefined, string | undefined, string | undefined, string | undefined] {
  if (x != null && y != null) {
    const [entry] = Doors.getDoorEntryAt(mapId, x, y);
    if (entry) {
      return [entry.tile, entry.size, entry.sound, entry.file];
    }
  }
  return [undefined, undefined, undefined, undefined];
}

// Lua: doors.lua:576
function loadSheet(tileName: string | undefined, sheetFile: string | undefined): DoorSheet | undefined {
  if (tileName == null) return undefined;
  const key = sheetFile ?? tileName;
  if (Doors._sheets[key] != null) {
    return Doors._sheets[key] || undefined;
  }

  // `love and love.image and love.graphics and love.image.newImageData`: always here

  const manifest = loadManifest();
  const info: DoorInfo | undefined = manifest && manifest.doors ? manifest.doors[tileName] : undefined;
  if (!info) {
    Doors._sheets[key] = false;
    return undefined;
  }
  if (typeof info.width !== "number" || info.width < 1
    || typeof info.height !== "number" || info.height < 1
    || typeof info.frames !== "number" || info.frames < 1) {
    Doors._sheets[key] = false;
    return undefined;
  }

  const file = sheetFile ?? info.file;
  const relPath = doorsRoot() + "/" + file;
  let bytes: string | undefined = undefined;

  // pcall(require, "src.core.game3.dataset"): imported
  if (Dataset && Dataset.cache) {
    const cache = Dataset.cache();
    if (cache && cache.read) {
      bytes = cache.read(relPath) ?? cache.read("doors/" + file);
    }
  }

  if (bytes == null) {
    // pcall(require, "src.import.CacheFs"): imported
    if (CacheFs && CacheFs.readActive) {
      bytes = CacheFs.readActive(relPath) ?? CacheFs.readActive("doors/" + file);
    }
  }

  if (bytes == null) {
    bytes = Fs.read(relPath) ?? Fs.read("doors/" + file);
  }

  // NOT FAITHFUL: io.open(relPath, "rb") has no counterpart on the 3DS;
  // love.filesystem above already covers the cache.

  if (bytes == null || bytes.length < (info.width * info.height * 4)) {
    Doors._sheets[key] = false;
    return undefined;
  }

  let imgData;
  try {
    imgData = newImageData(info.width, info.height, "rgba8", bytes);
  } catch {
    imgData = undefined;
  }
  if (!imgData) {
    imgData = newImageData(info.width, info.height);
    let i = 0; // Lua's i = 1 (bytes:byte(i)); charCodeAt is 0-based
    for (let y = 0; y <= info.height - 1; y++) {
      for (let x = 0; x <= info.width - 1; x++) {
        const r = (bytes.charCodeAt(i) || 0) / 255;
        const g = (bytes.charCodeAt(i + 1) || 0) / 255;
        const b = (bytes.charCodeAt(i + 2) || 0) / 255;
        const a = (bytes.charCodeAt(i + 3) || 0) / 255;
        imgData.setPixel(x, y, r, g, b, a);
        i = i + 4;
      }
    }
  }

  const img = G.newImage(imgData);
  if (img.setFilter) img.setFilter("nearest", "nearest");

  const quads: Quad[] = [];
  const frameH = info.frame_height!;
  const frameW = info.frame_width!;
  for (let fi = 0; fi <= info.frames - 1; fi++) {
    quads[fi] = G.newQuad(0, fi * frameH, frameW, frameH, info.width, info.height);
  }

  const sheet: DoorSheet = {
    image: img,
    quads,
    width: info.width,
    height: info.height,
    frame_width: frameW,
    frame_height: frameH,
    frames: info.frames,
  };
  Doors._sheets[key] = sheet;
  return sheet;
}

export const Doors = {
  // Lua: doors.lua:20 (Doors.SOUND_NORMAL / SOUND_SLIDING / SOUND_EXIT through the metatable)
  get SOUND_NORMAL(): number { return soundName("SOUND_NORMAL"); },
  get SOUND_SLIDING(): number { return soundName("SOUND_SLIDING"); },
  get SOUND_EXIT(): number { return soundName("SOUND_EXIT"); },

  soundFor,

  FRAME_TICKS: 4, // 4 engine frames per door animation step (FRLG standard)
  NUM_FRAMES: 3, // 3 animation frames (0: closed, 1: half, 2: fully open)

  // Active door animation state
  _activeAnim: undefined as DoorAnim | undefined,
  _manifest: undefined as LuaTable,
  _sheets: {} as Record<string, DoorSheet | false>, // [tileName] = { image, quads, width, height, frame_width, frame_height, frames }
  _manifestLoaded: false,

  _layoutCache: {} as Record<string, any>,

  /** Get door metadata entry for a map tile at (x, y) if available */
  // Lua: doors.lua:335
  getDoorEntryAt(mapId: any, x: number, y: number): [DoorEntry?, DoorInfo?] {
    // src/field_door.c:396
    const live = liveMapId();
    if (truthy(live)) {
      const [entry, info] = lookupDoorAt(live, x, y);
      if (entry) return [entry, info];
      if (live === mapId) return [];
    }
    return lookupDoorAt(mapId, x, y);
  },

  /** Determine the exact sound effect and door animation kind for a warp / doorway */
  // Lua: doors.lua:347
  getSoundForWarp(mapId: any, x: number | undefined, y: number | undefined, _destMap?: any, isDoor?: boolean):
    [number, string | undefined] {
    if (isDoor === false) {
      return [Doors.SOUND_EXIT, "exit"];
    }

    // Check ROM metatile manifest first at (mapId, x, y)
    if (x != null && y != null) {
      const [entry] = Doors.getDoorEntryAt(mapId, x, y);
      if (entry) {
        return [soundFor(entry.sound), entry.tile];
      }
    }

    // src/field_door.c:510
    return [Doors.SOUND_SLIDING, undefined];
  },

  /** Start door opening animation + sound */
  // Lua: doors.lua:376
  open(mapId: any, x: number, y: number, opts?: DoorOpts, onDone?: () => void): DoorAnim {
    opts = opts ?? {};
    let [sound, defaultKind] = Doors.getSoundForWarp(mapId, x, y, opts.destMap, true);
    if (truthy(opts.sound)) sound = opts.sound!;

    const [tile, size, soundKind, sheetFile] = resolveDoorKind(mapId, x, y);

    if (opts.playSound !== false) {
      // package.loaded["src.core.game3.audio"] or require(...): imported
      if (Audio && Audio.playSe) {
        Audio.playSe(sound);
      }
    }

    Doors._activeAnim = {
      mapId,
      x,
      y,
      kind: defaultKind ?? ((sound === Doors.SOUND_SLIDING) ? "sliding" : "normal"),
      soundKind,
      tile,
      sheetFile,
      size: size ?? "1x1",
      mode: "open",
      frame: 0,
      timer: 0,
      targetFrame: Doors.NUM_FRAMES - 1,
      onDone,
    };
    return Doors._activeAnim;
  },

  /** Set door at (mapId, x, y) immediately to fully open (frame 2) in hold mode */
  // Lua: doors.lua:409
  holdOpen(mapId: any, x: number, y: number, opts?: DoorOpts): DoorAnim {
    opts = opts ?? {};
    let [sound, defaultKind] = Doors.getSoundForWarp(mapId, x, y, opts.destMap, true);
    if (truthy(opts.sound)) sound = opts.sound!;

    const [tile, size, soundKind, sheetFile] = resolveDoorKind(mapId, x, y);

    Doors._activeAnim = {
      mapId,
      x,
      y,
      kind: defaultKind ?? ((sound === Doors.SOUND_SLIDING) ? "sliding" : "normal"),
      soundKind,
      tile,
      sheetFile,
      size: size ?? "1x1",
      mode: "hold",
      frame: Doors.NUM_FRAMES - 1,
      timer: 0,
      targetFrame: Doors.NUM_FRAMES - 1,
    };
    return Doors._activeAnim;
  },

  /** Start door closing animation + sound */
  // Lua: doors.lua:434
  close(mapId: any, x: number, y: number, opts?: DoorOpts, onDone?: () => void): DoorAnim {
    const o: DoorOpts = opts ?? {};
    let [sound, defaultKind] = Doors.getSoundForWarp(mapId, x, y, o.destMap, true);
    if (truthy(o.sound)) sound = o.sound!;

    const [tile, size, soundKind, sheetFile] = resolveDoorKind(mapId, x, y);

    Doors._activeAnim = {
      mapId,
      x,
      y,
      kind: defaultKind ?? ((sound === Doors.SOUND_SLIDING) ? "sliding" : "normal"),
      soundKind,
      tile,
      sheetFile,
      size: size ?? "1x1",
      mode: "close",
      frame: Doors.NUM_FRAMES - 1,
      timer: 0,
      targetFrame: 0,
      onDone: () => {
        if (o.playSound !== false) {
          // package.loaded["src.core.game3.audio"] or require(...): imported
          if (Audio && Audio.playSe) {
            Audio.playSe(sound);
          }
        }
        if (onDone) onDone();
      },
    };
    return Doors._activeAnim;
  },

  /** Start door closing animation after a delay (beat) in ticks */
  // Lua: doors.lua:468
  closeAfterDelay(mapId: any, x: number, y: number, delayTicks?: number, opts?: DoorOpts, onDone?: () => void): DoorAnim {
    const o: DoorOpts = opts ?? {};
    let [sound, defaultKind] = Doors.getSoundForWarp(mapId, x, y, o.destMap, true);
    if (truthy(o.sound)) sound = o.sound!;

    const [tile, size, soundKind, sheetFile] = resolveDoorKind(mapId, x, y);

    Doors._activeAnim = {
      mapId,
      x,
      y,
      kind: defaultKind ?? ((sound === Doors.SOUND_SLIDING) ? "sliding" : "normal"),
      soundKind,
      tile,
      sheetFile,
      size: size ?? "1x1",
      mode: "delay_close",
      frame: Doors.NUM_FRAMES - 1,
      timer: 0,
      delayTimer: delayTicks ?? 10,
      targetFrame: 0,
      onDone: () => {
        if (o.playSound === true) {
          // package.loaded["src.core.game3.audio"] or require(...): imported
          if (Audio && Audio.playSe) {
            Audio.playSe(sound);
          }
        }
        if (onDone) onDone();
      },
    };
    return Doors._activeAnim;
  },

  /** Advance active animation frame */
  // Lua: doors.lua:503
  update(_dt?: number): void {
    const anim = Doors._activeAnim;
    if (!anim) return;

    // src/field_fadetransition.c:757
    if (anim.tile == null && anim.mode !== "hold") {
      const cb = anim.onDone;
      anim.onDone = undefined;
      anim.frame = anim.targetFrame;
      if (anim.mode === "open") {
        anim.mode = "hold";
      } else {
        Doors._activeAnim = undefined;
      }
      if (cb) cb();
      return;
    }

    if (anim.mode === "delay_close") {
      anim.delayTimer = (anim.delayTimer ?? 1) - 1;
      if (anim.delayTimer <= 0) {
        anim.mode = "close";
        anim.timer = 0;
      }
      return;
    }

    if (anim.mode === "hold") {
      return;
    }

    anim.timer = anim.timer + 1;
    if (anim.timer >= Doors.FRAME_TICKS) {
      anim.timer = 0;
      if (anim.mode === "open") {
        if (anim.frame < anim.targetFrame) {
          anim.frame = anim.frame + 1;
        } else {
          const cb = anim.onDone;
          anim.onDone = undefined;
          anim.mode = "hold"; // Hold open frame while player steps through
          if (cb) cb();
        }
      } else if (anim.mode === "close") {
        if (anim.frame > anim.targetFrame) {
          anim.frame = anim.frame - 1;
        } else {
          const cb = anim.onDone;
          Doors._activeAnim = undefined;
          if (cb) cb();
        }
      }
    }
  },

  /** Check if door at (mapId, x, y) is currently animating */
  // Lua: doors.lua:559
  getActiveAnim(mapId?: any, x?: number, y?: number): DoorAnim | undefined {
    const anim = Doors._activeAnim;
    if (anim && (!truthy(mapId) || anim.mapId === mapId) && (!truthy(x) || anim.x === x) && (!truthy(y) || anim.y === y)) {
      return anim;
    }
    return undefined;
  },

  /** Check if door at (mapId, x, y) is fully open / holding open */
  // Lua: doors.lua:568
  isOpen(mapId?: any, x?: number, y?: number): boolean {
    const anim = Doors._activeAnim;
    if (anim && (!truthy(mapId) || anim.mapId === mapId) && (!truthy(x) || anim.x === x) && (!truthy(y) || anim.y === y)) {
      return anim.frame >= (Doors.NUM_FRAMES - 1);
    }
    return false;
  },

  /** Draw active door animation overlay */
  // Lua: doors.lua:676
  draw(camX?: number, camY?: number, canvasW?: number, canvasH?: number): void {
    const anim = Doors._activeAnim;
    if (!anim) return;
    // `love and love.graphics and love.graphics.rectangle`: always here

    const CELL = 16;
    const sx = anim.x * CELL - (camX ?? 0);
    const sy = anim.y * CELL - (camY ?? 0);

    // src/field_door.c:457
    const tileName = anim.tile;
    if (tileName == null) return;

    const sheet = loadSheet(tileName, anim.sheetFile);
    const hasSheet = sheet && sheet.image && sheet.quads;
    const width = (hasSheet && sheet.frame_width != null) ? sheet.frame_width : CELL;
    const height = (hasSheet && sheet.frame_height != null) ? sheet.frame_height : CELL;
    const yOffset = (height > CELL) ? CELL : 0;
    const top = sy - yOffset;
    if (sx + width <= 0 || top + height <= 0
      || sx >= (canvasW ?? 240) || top >= (canvasH ?? 160)) {
      return;
    }

    if (hasSheet) {
      const frame = Math.min(anim.frame, sheet.frames - 1);

      // Authentic black interior background behind the door graphic
      G.setColor(0.05, 0.07, 0.1, 1);
      G.rectangle("fill", sx, sy - yOffset, sheet.frame_width, sheet.frame_height);

      // Draw authentic ROM-derived door quad
      G.setColor(1, 1, 1, 1);
      G.draw(sheet.image, sheet.quads[frame], sx, sy - yOffset);
      return;
    }

    // Fallback vector drawing when sheets are unavailable
    if (anim.frame === 0) return;

    G.setColor(0.05, 0.07, 0.1, 1);
    G.rectangle("fill", sx + 1, sy + 1, 14, 15);

    if (tileName === "SlidingDouble") {
      if (anim.frame === 1) {
        G.setColor(0.65, 0.8, 0.88, 0.95);
        G.rectangle("fill", sx + 1, sy + 1, 4, 14);
        G.setColor(0.35, 0.5, 0.6, 1);
        G.rectangle("line", sx + 1, sy + 1, 4, 14);
        G.setColor(0.65, 0.8, 0.88, 0.95);
        G.rectangle("fill", sx + 11, sy + 1, 4, 14);
        G.setColor(0.35, 0.5, 0.6, 1);
        G.rectangle("line", sx + 11, sy + 1, 4, 14);
      }
    } else if (anim.soundKind === "sliding") {
      if (anim.frame === 1) {
        G.setColor(0.65, 0.8, 0.88, 0.95);
        G.rectangle("fill", sx + 8, sy + 1, 7, 14);
        G.setColor(0.35, 0.5, 0.6, 1);
        G.rectangle("line", sx + 8, sy + 1, 7, 14);
        G.setColor(0.85, 0.95, 1.0, 0.8);
        G.line(sx + 10, sy + 2, sx + 10, sy + 13);
      }
    } else {
      if (anim.frame === 1) {
        G.setColor(0.62, 0.42, 0.24, 0.95);
        G.rectangle("fill", sx + 8, sy + 1, 7, 14);
        G.setColor(0.35, 0.22, 0.1, 1);
        G.rectangle("line", sx + 8, sy + 1, 7, 14);
        G.setColor(0.45, 0.28, 0.14, 0.8);
        G.line(sx + 11, sy + 2, sx + 11, sy + 13);
      }
    }

    G.setColor(1, 1, 1, 1);
  },

  // Lua: doors.lua:753
  isBusy(): boolean {
    const anim = Doors._activeAnim;
    return anim != null && (anim.mode === "open" || anim.mode === "close" || anim.mode === "delay_close");
  },

  // Lua: doors.lua:758
  release(): void {
    Doors._sheets = {};
    Doors._layoutCache = {};
    Doors._activeAnim = undefined;
  },

  // Lua: doors.lua:764
  reset(): void {
    Doors._activeAnim = undefined;
  },
};

export default Doors;
