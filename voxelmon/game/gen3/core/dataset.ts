// Port of gen1recomp src/core/game3/dataset.lua (GPLv3 + additional terms; see LICENSE.md).
// Hydrate Game3 standalone data from the firered/ GBA extract cache.
// Uses native mid layouts + warps; does not touch Sevii ferry host maps.
//
// Port notes:
// - Extract.CACHE_ROOT / NATIVE_ROOT (src.import.gba.extract_island1) are a
//   proxy onto CachePaths (extract_island1.lua:21); this module reads and sets
//   CachePaths directly instead of importing extract_island1.
// - Cache files load through luaLoad (lt.ts shape): warps / connections are
//   keyed by map id, each a Lua sequence of rows.
// - NativePack.decodeMidLayout returns 0-based cells / borderMids; they are
//   converted to Lua sequences for LayoutNative.fromDecoded at the call site.
// - pcall(require, X) and package.loaded[X] are static imports (every module
//   is in the bundle).
// - The importer modules the runtime calls (map_sections_extract and others)
//   read through the importer's CacheFs (import/gen3/cache.ts), where Brian's
//   Lua reads Dataset.cache() / the one shared CacheFs. mountExtractRoots
//   binds it to an adapter over Dataset.cache() when nothing else (a test, the
//   cook) has bound it.

import { Versions } from "../../../import/gen3/versions.ts";
import { CachePaths } from "./cache_paths.ts";
import { MapIds } from "./map_ids.ts";
import { Profile } from "./profile.ts";
import { MapCatalog } from "../../../import/gen3/map_catalog.ts";
import { MapSectionsExtract } from "../../../import/gen3/map_sections_extract.ts";
import { NativePack } from "../../../import/gen3/native_pack.ts";
import { Json } from "../shared/link/Json.ts";
import { CacheFs } from "../shared/import/CacheFs.ts";
import { GameVersion } from "../shared/core/GameVersion.ts";
import { HealLocations } from "./heal_locations.ts";
import { LayoutNative } from "./layout_native.ts";
import { Space } from "./scripting/space.ts";
import { FieldModules } from "./field_modules.ts";
import { Plaza as UnionPlazaMap } from "./link/union_plaza_map.ts";
import { NativeTileset } from "./tileset_native.ts";
import { OwSprites } from "./ow_sprites.ts";
import { FieldEffects } from "./field_effects.ts";
import { Pokemon } from "./pokemon.ts";
import { PartyChrome } from "../ui/party_chrome.ts";
import { BagChrome } from "../ui/bag_chrome.ts";
import { MapPreviewScreen } from "../ui/map_preview_screen.ts";
import { Audio } from "./audio.ts";
import { Encounters } from "./encounters.ts";
import { Fs } from "../platform/fs.ts";
import { luaLoad } from "../platform/luadata.ts";
import { fromArray, ipairs, isEmpty, pairs, type LuaTable } from "../platform/lt.ts";
import { gsub } from "../platform/lpattern.ts";
import { format, tonumber, tostring } from "../../../import/gen3/lua.ts";
import { CacheFs as ImportCacheFs, type Cache as ImportCache } from "../../../import/gen3/cache.ts";

export interface DatasetCache {
  assetWorkerSpec(root: string, kind: string, key: unknown): { prefix: string; directory: string | undefined } | undefined;
  read(rel: string): string | undefined;
  /** [ok, err] (CacheFs.write's two values) */
  write(rel: string, bytes: string | Uint8Array): [boolean, string?];
  exists(rel: string): boolean;
}

// Lua: dataset.lua:11
// NOT FAITHFUL: no io.open on the 3DS. The override and the two relative
// candidates are read through love.filesystem (the host's cache); the OS
// save-directory roots (HOME, POKEPORT_IDENTITY, LÖVE identities) are dropped.
function diskFallback(rel: string): string | undefined {
  const override = Dataset.cacheRootOverride;
  if (override) {
    const data = Fs.read(override + "/" + gsub(rel, "^data/generated/gba/", "")[0]);
    if (typeof data === "string" && data.length > 0) return data;
  }
  const data = Fs.read(rel) ?? Fs.read("data/generated/gba/" + rel);
  if (typeof data === "string" && data.length > 0) return data;
  return undefined;
}

// Lua: dataset.lua:66
function loveCache(): DatasetCache {
  return {
    assetWorkerSpec(root: string, kind: string, key: unknown) {
      const rel = root + "/" + tostring(key) + (kind === "pair" ? "/mids.idx" : ".meta");
      const prefix = GameVersion.cachePrefix();
      // Only a version-qualified cache can be read independently of mounted
      // overlays. Overrides/custom readers retain the synchronous fallback.
      // (os.getenv("POKEPORT_GBA_CACHE") is always nil here.)
      if (Dataset.cacheRootOverride) return undefined;
      if (!CacheFs.existsAt(prefix + rel)) return undefined;
      return { prefix, directory: CacheFs.root() };
    },
    read(rel: string) {
      if (CacheFs && CacheFs.readActive) {
        const bytes = CacheFs.readActive(rel);
        if (typeof bytes === "string") return bytes;
      }
      {
        const bytes = Fs.read(rel);
        if (typeof bytes === "string") return bytes;
      }
      return diskFallback(rel);
    },
    write(rel: string, bytes: string | Uint8Array) {
      if (CacheFs && CacheFs.write) {
        return CacheFs.write(rel, bytes);
      }
      // (unreachable: CacheFs is always there; love.filesystem.write's success)
      return [Fs.write(rel, bytes)];
    },
    exists(rel: string) {
      if (CacheFs && CacheFs.existsAt) {
        if (GameVersion.cachePrefix && CacheFs.existsAt(GameVersion.cachePrefix() + rel)) {
          return true;
        }
        if (CacheFs.exists(rel)) return true;
      }
      if (Fs.getInfo(rel, "file")) {
        return true;
      }
      return diskFallback(rel) != null;
    },
  };
}

// The cache object is stateless (every read resolves CacheFs, love.filesystem
// and Dataset.cacheRootOverride at call time), so one instance is shared.
let sharedCache: DatasetCache | undefined;

// The importer's Cache over Dataset.cache() (see the port notes).
function bindImportCache(): void {
  try {
    ImportCacheFs.bound();
    return; // already bound
  } catch { /* none bound */ }
  const adapter: ImportCache = {
    read: (rel) => Dataset.cache().read(rel),
    write: (rel, bytes) => Dataset.cache().write(rel, bytes)[0],
    exists: (rel) => Dataset.cache().exists(rel),
    info: (rel) => (Dataset.cache().exists(rel) ? { type: "file" } : undefined),
  };
  ImportCacheFs.bind(adapter);
}

let dsLoadWarned = false;

// Lua: dataset.lua:127
function load_lua_rel(rel: string): any {
  const cache = loveCache();
  const src = cache.read(rel);
  if (src == null) return undefined;
  const [chunk] = luaLoad(src, "@" + rel);
  if (!chunk) return undefined;
  try {
    return chunk();
  } catch (e) {
    if (!dsLoadWarned) {
      dsLoadWarned = true;
      console.log("[game3/dataset] load failed for " + tostring(rel) + ": " + tostring(e instanceof Error ? e.message : e));
    }
    return undefined;
  }
}

// pokeemerald/include/constants/map_types.h:4
const MAP_TYPE_KIND: Record<number, [string, string]> = {
  [3]: ["route", "ROUTE"],
  [4]: ["indoor", "INDOOR"],
  [5]: ["route", "UNDERWATER"],
  [6]: ["route", "ROUTE"],
  [8]: ["indoor", "INDOOR"],
  [9]: ["indoor", "INDOOR"],
};

let manifestLayouts: Record<string, any> = {};

export const Dataset = {
  cacheRootOverride: undefined as string | undefined,
  // Brian's Dataset has no `map`; map.lua / warp.lua probe it (`Dataset.map`), so it reads nil.
  map: undefined as undefined | ((mapId: string) => any),

  // Lua: dataset.lua:121
  /** Shared firered CacheFs-backed cache for standalone Game3 (mod.cache is nil). */
  cache(): DatasetCache {
    if (!sharedCache) sharedCache = loveCache();
    return sharedCache;
  },

  // Lua: dataset.lua:143
  /** Build map defs for every FR_* (and any other) entry in native manifest / Versions.MAPS. */
  buildMaps(warpsIn?: any): Record<string, any> {
    const warps = warpsIn
      ?? load_lua_rel(CachePaths.CACHE_ROOT + "/warps.lua")
      ?? Versions.WARPS
      ?? {};
    const connections = load_lua_rel(CachePaths.CACHE_ROOT + "/connections.lua") ?? {};
    const manifest = load_lua_rel((CachePaths.NATIVE_ROOT ?? CachePaths.CACHE_ROOT + "/native") + "/manifest.lua") ?? {};
    const maps: Record<string, any> = {};
    const mapBlock = Profile.active().map ?? {};
    const registry = Versions.MAPS ?? {};

    // Lua: dataset.lua:158
    const add = (mapId: string, info: any): void => {
      const spec = registry[mapId] ?? {};
      const pair = (info && info.pair) ?? spec.pair;
      const tileset = pair != null && Versions.PAIR_TILESET ? Versions.PAIR_TILESET[pair] : undefined;

      // Load map header metadata if available in map_tree cache
      let regionMapSectionId = spec.regionMapSectionId;
      let showMapName = spec.showMapName;
      let floorNum = spec.floorNum;
      let weather = spec.weather;
      let mapType = spec.mapType;
      // pokefirered/include/global.fieldmap.h:191
      let cave = spec.cave;
      let allowEscaping = spec.allowEscaping;
      let allowRunning = spec.allowRunning;
      let bikingAllowed = spec.bikingAllowed;
      let battleType = spec.battleType;
      let music = spec.music;
      let borderWidth = spec.borderWidth;
      let borderHeight = spec.borderHeight;

      if (regionMapSectionId == null || showMapName == null || cave == null
        || allowEscaping == null || allowRunning == null || bikingAllowed == null
        || battleType == null || music == null
        || borderWidth == null || borderHeight == null) {
        // Try loading from data/generated/gba/map_tree/maps/{slot}/header.json
        const cache = loveCache();
        const candidates: LuaTable = [null];
        const slot = MapCatalog.slotKeyFor && MapCatalog.slotKeyFor(mapId);
        if (slot) candidates[candidates.length] = slot;
        if (spec.group != null && spec.num != null) {
          candidates[candidates.length] = format("%d_%d", spec.group, spec.num);
        }
        // Try lookup in FRLG_MAP_TO_FR reverse
        for (const [k, v] of pairs<string>(Versions.FRLG_MAP_TO_FR ?? {})) {
          if (v === mapId) {
            candidates[candidates.length] = gsub(String(k), ":", "_")[0];
          }
        }
        for (const [k, v] of pairs<string>(Versions.FRLG_MAP_TO_SEVII ?? {})) {
          if (v === mapId) {
            candidates[candidates.length] = gsub(String(k), ":", "_")[0];
          }
        }

        for (const [, slotKey] of ipairs<string>(candidates)) {
          const raw = cache.read("data/generated/gba/map_tree/maps/" + slotKey + "/header.json")
            ?? cache.read(CachePaths.CACHE_ROOT + "/map_tree/maps/" + slotKey + "/header.json");
          if (raw != null && Json && Json.decode) {
            // pcall(Json.decode, raw)
            let okH = false, h: any;
            try { h = Json.decode(raw)[0]; okH = true; } catch { okH = false; }
            if (okH && h !== null && typeof h === "object") {
              regionMapSectionId = regionMapSectionId ?? h.regionMapSectionId;
              showMapName = showMapName ?? h.showMapName;
              floorNum = floorNum ?? h.floorNum;
              weather = weather ?? h.weather;
              mapType = mapType ?? h.mapType;
              cave = cave ?? h.cave;
              allowEscaping = allowEscaping ?? h.allowEscaping;
              allowRunning = allowRunning ?? h.allowRunning;
              bikingAllowed = bikingAllowed ?? h.bikingAllowed;
              battleType = battleType ?? h.battleType;
              music = music ?? h.music;
              borderWidth = borderWidth ?? h.borderWidth;
              borderHeight = borderHeight ?? h.borderHeight;
              break;
            }
          }
        }
      }

      // Fallback inference if header.json was not loaded
      if (regionMapSectionId == null) {
        const secInfo = MapSectionsExtract.getInfo(undefined, mapId, floorNum ?? 0);
        // getInfo echoes secId 88 (a real section: Pallet Town) with
        // resolved=false for a map it cannot identify.  Taking that id would
        // advertise an unknown map as Pallet Town, so only trust a resolved one.
        if (secInfo && secInfo.resolved) {
          regionMapSectionId = secInfo.secId;
        }
      }
      if (showMapName == null) {
        showMapName = 0;
      }
      let kind = spec.kind, environment = spec.environment;
      if (mapBlock.kindsFromMapType && kind == null) {
        [kind, environment] = Dataset.kindOfMapType(mapType);
      }

      maps[mapId] = {
        id: mapId,
        name: mapId,
        width: (info && info.width) ?? spec.width ?? 20,
        height: (info && info.height) ?? spec.height ?? 18,
        kind: kind ?? "town",
        environment: environment ?? "TOWN",
        pair,
        tileset,
        warps: warps[mapId] ?? {},
        connections: connections[mapId] ?? {},
        regionMapSectionId,
        showMapName: (showMapName === 1 || showMapName === true) ? 1 : 0,
        floorNum: tonumber(floorNum) ?? 0,
        weather: weather ?? 0,
        mapType: mapType ?? 0,
        cave: tonumber(cave),
        allowEscaping: tonumber(allowEscaping),
        allowRunning: tonumber(allowRunning),
        bikingAllowed: tonumber(bikingAllowed),
        battleType: tonumber(battleType),
        music: tonumber(music),
        borderWidth: tonumber(borderWidth),
        borderHeight: tonumber(borderHeight),
        native: true,
      };
      Dataset.bindUnderwater(maps[mapId]);
    };

    if (manifest.layouts) {
      for (const [mapId, info] of pairs(manifest.layouts)) {
        // Prefer Fire Red maps for standalone boot; keep SEVII_* available but unused.
        add(mapId as string, info);
      }
    } else {
      for (const [mapId, spec] of pairs<any>(Versions.MAPS ?? {})) {
        add(mapId as string, { width: spec.width, height: spec.height, pair: spec.pair });
      }
    }

    if (isEmpty(connections) && mapBlock.strictConnections) {
      throw new Error("game3 dataset: connections.lua missing from the " + tostring(Profile.active().id) + " cache");
    }
    // Fallback corridor edges if connections.lua missing (pre-v82 caches).
    if (isEmpty(connections)) {
      if (maps.FR_PALLET_TOWN && maps.FR_ROUTE_1) {
        maps.FR_PALLET_TOWN.connections = {
          north: { map: "FR_ROUTE_1", offset: 0 },
        };
        maps.FR_ROUTE_1.connections = {
          south: { map: "FR_PALLET_TOWN", offset: 0 },
          north: { map: "FR_VIRIDIAN_CITY", offset: -12 },
        };
      }
      if (maps.FR_VIRIDIAN_CITY && maps.FR_ROUTE_1) {
        maps.FR_VIRIDIAN_CITY.connections = maps.FR_VIRIDIAN_CITY.connections ?? {};
        maps.FR_VIRIDIAN_CITY.connections.south = { map: "FR_ROUTE_1", offset: 12 };
      }
      if (maps.FR_VIRIDIAN_CITY && maps.FR_ROUTE_2) {
        maps.FR_VIRIDIAN_CITY.connections = maps.FR_VIRIDIAN_CITY.connections ?? {};
        maps.FR_VIRIDIAN_CITY.connections.north = { map: "FR_ROUTE_2", offset: 12 };
        maps.FR_ROUTE_2.connections = {
          south: { map: "FR_VIRIDIAN_CITY", offset: -12 },
          north: { map: "FR_PEWTER_CITY", offset: -12 },
        };
      }
      if (maps.FR_PEWTER_CITY && maps.FR_ROUTE_2) {
        maps.FR_PEWTER_CITY.connections = {
          south: { map: "FR_ROUTE_2", offset: 12 },
        };
      }
    }

    return maps;
  },

  // Lua: dataset.lua:332 -- [kind, environment]
  kindOfMapType(mapType: unknown): [string, string] {
    const row = MAP_TYPE_KIND[tonumber(mapType) ?? 0];
    if (row) return [row[0], row[1]];
    return ["town", "TOWN"];
  },

  // Lua: dataset.lua:339 -- pokeemerald/src/overworld.c:1354
  isOutdoorMapType(mapTypeIn: unknown): boolean {
    const mapType = tonumber(mapTypeIn);
    return mapType === 1 || mapType === 2 || mapType === 3 || mapType === 5 || mapType === 6;
  },

  // Lua: dataset.lua:345 -- pokeemerald/src/overworld.c:1377
  isIndoorMapType(mapTypeIn: unknown): boolean {
    const mapType = tonumber(mapTypeIn);
    return mapType === 8 || mapType === 9;
  },

  // Lua: dataset.lua:351 -- pokeemerald/src/overworld.c:756 SetDiveWarp
  bindUnderwater(def: any): any {
    if (def === null || typeof def !== "object" || def.connections === null || typeof def.connections !== "object") return def;
    for (const [, c] of ipairs<any>(def.connections)) {
      if (c !== null && typeof c === "object" && (c.dir === "dive" || c.dir === "emerge") && typeof c.map === "string") {
        def[c.dir] = { map: c.map, offset: tonumber(c.offset) ?? 0 };
      }
    }
    return def;
  },

  // Lua: dataset.lua:362
  /** Point extract roots at the engine firered cache and install native tilesets. */
  mountExtractRoots(): void {
    // (os.getenv("POKEPORT_GBA_CACHE") is always nil here)
    const root = Dataset.cacheRootOverride
      ?? "data/generated/gba";
    CachePaths.CACHE_ROOT = root;
    CachePaths.NATIVE_ROOT = root + "/native";
    Dataset.invalidateManifestCache();
    // package.loaded["src.core.game3.heal_locations"]
    if (HealLocations && HealLocations.invalidate) HealLocations.invalidate();
    bindImportCache();
  },

  // Lua: dataset.lua:375
  invalidateManifestCache(): void {
    manifestLayouts = {};
  },

  // Lua: dataset.lua:380
  /** Bind LayoutNative handles onto map defs (FieldView needs midLayout). */
  attachMidLayouts(maps: any, cacheIn?: DatasetCache): number {
    if (maps === null || typeof maps !== "object") return 0;
    const cache = cacheIn ?? loveCache();
    const nativeRoot = CachePaths.NATIVE_ROOT ?? (CachePaths.CACHE_ROOT + "/native");
    const manifestRel = nativeRoot + "/manifest.lua";
    let layouts = manifestLayouts[manifestRel];
    if (!layouts) {
      const manifest = load_lua_rel(manifestRel) ?? {};
      layouts = manifest.layouts ?? {};
      manifestLayouts[manifestRel] = layouts;
    }
    let attached = 0;
    for (const [mapId, def] of pairs<any>(maps)) {
      if (def && !def.midLayout) {
        const info = layouts[mapId];
        const rel = nativeRoot + "/"
          + ((info && info.file) ?? ("layouts/" + mapId + ".mid"));
        const blob = cache.read(rel);
        if (blob != null) {
          const [decoded] = NativePack.decodeMidLayout(blob);
          if (decoded) {
            const pair = (info && info.pair) ?? def.pair;
            // decodeMidLayout's cells / borderMids are 0-based: Lua sequences for LayoutNative
            def.midLayout = LayoutNative.fromDecoded(
              { ...decoded, cells: fromArray(decoded.cells), borderMids: fromArray(decoded.borderMids) },
              mapId as string, pair, blob);
            const tw = decoded.trueWidth ?? decoded.width;
            const th = decoded.trueHeight ?? decoded.height;
            if (tw && tw > 0) def.width = tw;
            if (th && th > 0) def.height = th;
            if (pair != null) def.pair = pair;
            attached = attached + 1;
          }
        }
      } else if (def && def.midLayout) {
        attached = attached + 1;
      }
    }
    return attached;
  },

  // Lua: dataset.lua:421
  /** Populate game.data for standalone Fire Red. */
  hydrate(game: any): boolean {
    Dataset.mountExtractRoots();
    const cache = loveCache();
    game.data = game.data ?? {};
    game.data.maps = Dataset.buildMaps();
    game.data.tilesets = game.data.tilesets ?? {};

    const nLayouts = Dataset.attachMidLayouts(game.data.maps, cache);

    let nEvents = 0;
    if (Space) {
      Space.ensureBundle(undefined);
      nEvents = Space.attachEventsToMaps(game.data.maps, Space.bundle) ?? 0;
    }
    if (FieldModules.enabled("unionPlaza")) {
      UnionPlazaMap.ensure(game);
    }

    if (NativeTileset.install) {
      NativeTileset.install(cache, undefined);
    }
    if (OwSprites && OwSprites.install) {
      OwSprites.install(cache);
    }
    if (FieldEffects && FieldEffects.install) {
      FieldEffects.install(cache);
    }

    if (Pokemon && Pokemon.install) {
      Pokemon.install(cache);
    }
    if (PartyChrome && PartyChrome.install) {
      PartyChrome.install(cache);
    }
    if (BagChrome && BagChrome.install) {
      BagChrome.install(cache);
    }
    if (MapPreviewScreen && MapPreviewScreen.install) {
      MapPreviewScreen.install(cache);
    }

    // Explicit firered audio root — never inherit Sevii Extract.CACHE_ROOT default.
    const audioRoot = "data/generated/gba/audio";
    const [okA, errA] = Audio.install(cache, { root: audioRoot });
    if (!okA) {
      const songs = load_lua_rel(audioRoot + "/songs.lua")
        ?? load_lua_rel(CachePaths.CACHE_ROOT + "/audio/songs.lua");
      if (songs) {
        Audio.loadMeta({ songs });
      }
      console.log("[game3/dataset] audio install: " + tostring(errA));
    } else if (Audio._pack && Audio._pack.index && Audio._pack.index.mapSongs && game.data && game.data.maps) {
      for (const [mapId, songId] of pairs(Audio._pack.index.mapSongs)) {
        const def = game.data.maps[mapId];
        if (def && def.music == null) def.music = songId;
      }
    }

    // Encounter tables need the mounted firered cache (install may have run earlier).
    if (Encounters && Encounters.loadFromMod) {
      Encounters.loadFromMod(undefined);
    }

    let nMaps = 0;
    for (const _ of pairs(game.data.maps)) nMaps = nMaps + 1;
    console.log(format(
      "[game3/dataset] hydrated %d maps midLayouts=%d eventMaps=%d (start=%s)",
      nMaps, nLayouts, nEvents, tostring(MapIds.newGameStart().map)));

    return true;
  },
};

export default Dataset;
