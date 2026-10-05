// Port of gen1recomp src/import/gba/map_catalog.lua (GPLv3 + additional terms; see LICENSE.md).
// Map identity + tileset-pair discovery from the gMapGroups / MapTree census.
// Engine ids are FR_* (existing aliases) or FR_<PRET_NAME> derived from pret.
//
// Iteration order: the Lua walks groups.groups (explicit [0]..[42] keys) and
// FRLG_MAP_TO_FR / FRLG_MAP_TO_SEVII with pairs(). That order only decides
// which key binds an engine id's slot first (and last-wins aliases) when two
// keys share an engine id; FireRed's tables have no such collision. Here:
// groups ascending, the hand maps in insertion order.

import { format, tonumber } from "./lua.ts";
import { luaGet, luaLen } from "./luatable.ts";
import { Versions } from "./versions.ts";
import { Family, type FamilyDesc } from "./family.ts";
import { Profile } from "../../game/gen3/core/profile.ts";
import { MapTree, type Census, type CensusEntry, type MapLayout, type TilesetStruct } from "./map_tree.ts";
import { bindMapCatalog } from "./versions_frlg.ts";
import type { Rom } from "./rom.ts";

let _byGroupNum: Record<string, string> | undefined; // ["g:n"] = engineId
let _byPret: Record<string, string> | undefined; // pretName = engineId
let _aliases: Record<string, string> | undefined; // anyName = engineId
let _slotByEngine: Record<string, string> | undefined; // engineId = "g_n"
let _key: string | undefined;
const _states: Record<string, [Record<string, string>, Record<string, string>, Record<string, string>, Record<string, string>]> = {};

// Lua: map_catalog.lua:19
function catalog_key(): string {
  const F = Family.active();
  if (F.aliases) return F.name;
  return F.game;
}

// Lua: map_catalog.lua:25
function engine_prefix(F: FamilyDesc): string {
  if (F.aliases) return Profile.active().map.enginePrefix;
  return Profile.of(F.game).map.enginePrefix;
}

// Lua: map_catalog.lua:30
function convert_pret(pret: string, prefix: string): string {
  // Route1 → Route_1, Route22 → Route_22
  let s = pret.replace(/Route(\d+)/g, "Route_$1");
  // PalletTown → FR_PALLET_TOWN; ViridianCity_PokemonCenter_1F → FR_VIRIDIAN_CITY_POKEMON_CENTER_1F
  // Only split lower→Upper (not digit→Upper) so "1F" stays "1F".
  s = s.replace(/([a-z])([A-Z])/g, "$1_$2");
  s = s.replace(/-/g, "_").toUpperCase();
  s = s.replace(/_+/g, "_");
  return prefix + s;
}

// Lua: map_catalog.lua:41
function pret_to_engine(pret: unknown): string | undefined {
  if (typeof pret !== "string" || pret === "") return undefined;
  const F = Family.active();
  if (!F.aliases) {
    ensure_index();
    return _byPret![pret] ?? convert_pret(pret, engine_prefix(F));
  }
  // Existing hand aliases first.
  const hand = Versions.PRET_TO_FR && Versions.PRET_TO_FR[pret];
  if (hand) return hand;
  return convert_pret(pret, engine_prefix(F));
}

/** Lua's ipairs over a sequence stored as a JS array or an integer-keyed object. */
function seq<T>(t: unknown): T[] {
  if (t === undefined || t === null || typeof t !== "object") return [];
  const n = luaLen(t as object);
  const out: T[] = [];
  for (let i = 1; i <= n; i++) out.push(luaGet(t as object, i) as T);
  return out;
}

/** The groups table's keys (0..n), ascending. */
function groupKeys(groups: Record<string, unknown>): number[] {
  return Object.keys(groups).map(Number).sort((a, b) => a - b);
}

// Lua: map_catalog.lua:67 (families without hand aliases)
function rebuild_const_index(F: FamilyDesc): Record<string, string> {
  const groups = F.groups();
  const prefix = engine_prefix(F);
  const g = (groups.groups ?? {}) as Record<string, any>;
  for (const gi of groupKeys(g)) {
    const info = g[gi];
    const maps = info.maps ?? {};
    const nMaps = luaLen(maps);
    for (let mi = 1; mi <= nMaps; mi++) {
      const num = mi - 1;
      const key = format("%d:%d", gi, num);
      const pret = luaGet(maps, mi) as string;
      const cnst = (F.mapConstAt as (g: number, n: number) => string | undefined)(gi, num);
      const engine = cnst ? prefix + cnst.replace(/^MAP_/, "") : convert_pret(pret, prefix);
      _byGroupNum![key] = engine;
      _byPret![pret] = engine;
      _aliases![engine] = engine;
      _aliases![pret] = engine;
      _aliases![key] = engine;
      if (cnst) _aliases![cnst] = engine;
      if (_slotByEngine![engine] === undefined) {
        _slotByEngine![engine] = format("%d_%d", gi, num);
      }
    }
  }
  return _byGroupNum!;
}

// Lua: map_catalog.lua:135
function ensure_index(): void {
  const key = catalog_key();
  if (_byGroupNum && _key === key) return;
  const st = _states[key];
  if (st) {
    _key = key;
    [_byGroupNum, _byPret, _aliases, _slotByEngine] = st;
    return;
  }
  MapCatalog.rebuildIndex();
}

// Lua: map_catalog.lua:247
function map_type_kind(mapTypeIn: unknown): [string, string] {
  // pret map_types.h: 1 town, 2 city, 3 route, 4 underground, 8 indoor, …
  const mapType = tonumber(mapTypeIn) ?? 0;
  if (mapType === 3) return ["route", "ROUTE"];
  if (mapType === 8 || mapType === 4 || mapType === 9) return ["indoor", "INDOOR"];
  return ["town", "TOWN"];
}

export const MapCatalog = {
  // Lua: map_catalog.lua:54
  pretToEngine(pret: unknown): string | undefined {
    return pret_to_engine(pret);
  },

  // Lua: map_catalog.lua:58
  ensureRegistry(): typeof Versions {
    if (Versions.TILESETS === undefined || Versions.TILESETS === null) Versions.TILESETS = {};
    if (Versions.TILESET_PAIRS === undefined || Versions.TILESET_PAIRS === null) Versions.TILESET_PAIRS = {};
    if (Versions.PAIR_TILESET === undefined || Versions.PAIR_TILESET === null) Versions.PAIR_TILESET = {};
    if (Versions.MAPS === undefined || Versions.MAPS === null) Versions.MAPS = {};
    if (Versions.MAP_HEADERS === undefined || Versions.MAP_HEADERS === null) Versions.MAP_HEADERS = {};
    return Versions;
  },

  // Lua: map_catalog.lua:92 -- build (group,num) → engineId and pret → engineId
  // tables from pret groups + hand FR map
  rebuildIndex(): Record<string, string> {
    const F = Family.active();
    _key = catalog_key();
    _byGroupNum = {}; _byPret = {}; _aliases = {}; _slotByEngine = {};
    _states[_key] = [_byGroupNum, _byPret, _aliases, _slotByEngine];
    if (!F.aliases) {
      return rebuild_const_index(F);
    }
    const groups = F.groups();
    const bindSlot = (engine: string | undefined, key: string | undefined): void => {
      if (engine && key && _slotByEngine![engine] === undefined) {
        _slotByEngine![engine] = key.replace(/:/g, "_");
      }
    };
    const g = (groups.groups ?? {}) as Record<string, any>;
    for (const gi of groupKeys(g)) {
      const info = g[gi];
      const maps = seq<string>(info.maps ?? {});
      maps.forEach((pret, idx) => {
        const num = idx; // mi - 1
        const key = format("%d:%d", gi, num);
        const engine: string = Versions.FRLG_MAP_TO_FR[key]
          ?? Versions.FRLG_MAP_TO_SEVII[key]
          ?? pret_to_engine(pret);
        _byGroupNum![key] = engine;
        _byPret![pret] = engine;
        _aliases![engine] = engine;
        _aliases![pret] = engine;
        _aliases![key] = engine;
        bindSlot(engine, key);
      });
    }
    // Ensure hand FR_* keys alias to themselves.
    const toFr = (Versions.FRLG_MAP_TO_FR ?? {}) as Record<string, string>;
    for (const key of Object.keys(toFr)) {
      const engine = toFr[key]!;
      _aliases[engine] = engine;
      _byGroupNum[key] = engine;
      bindSlot(engine, key);
    }
    const toSevii = (Versions.FRLG_MAP_TO_SEVII ?? {}) as Record<string, string>;
    for (const key of Object.keys(toSevii)) {
      const engine = toSevii[key]!;
      _aliases[engine] = engine;
      _byGroupNum[key] = engine;
      bindSlot(engine, key);
    }
    return _byGroupNum;
  },

  // Lua: map_catalog.lua:147
  mapIdFor(group: unknown, num: unknown): string | undefined {
    ensure_index();
    const key = format("%d:%d", tonumber(group) ?? 0, tonumber(num) ?? 0);
    return _byGroupNum![key];
  },

  // Lua: map_catalog.lua:153
  slotKeyFor(mapId: unknown): string | undefined {
    ensure_index();
    if (typeof mapId !== "string") return undefined;
    return _slotByEngine![mapId] ?? _slotByEngine![_aliases![mapId] ?? ""];
  },

  // Lua: map_catalog.lua:159 -- [group, num]
  groupNumFor(mapId: unknown): [number | undefined, number | undefined] {
    const slot = MapCatalog.slotKeyFor(mapId);
    if (slot) {
      const m = /^(\d+)_(\d+)$/.exec(slot);
      if (m) return [tonumber(m[1]), tonumber(m[2])];
    }
    return [undefined, undefined];
  },

  // Lua: map_catalog.lua:168
  resolve(nameOrGroup: unknown, num?: unknown): string | undefined {
    ensure_index();
    if (num !== undefined && num !== null) {
      return MapCatalog.mapIdFor(nameOrGroup, num);
    }
    if (typeof nameOrGroup !== "string") return undefined;
    return _aliases![nameOrGroup] ?? nameOrGroup;
  },

  // Lua: map_catalog.lua:177
  isKnown(mapId: string): boolean {
    ensure_index();
    return _aliases![mapId] !== undefined;
  },

  // Lua: map_catalog.lua:184 -- match a tileset struct's tiles + metatiles +
  // attributes to a Versions.TILESETS name. [name, ts] (or [] for none).
  // pokefirered/include/global.fieldmap.h:80
  tilesetNameForPtr(rom: Rom, tilesetPtr: number | undefined): [string?, TilesetStruct?] {
    if (tilesetPtr === undefined || tilesetPtr === null || tilesetPtr === 0) return [];
    const ts = MapTree.parseTileset(rom, tilesetPtr);
    if (!ts) return [];
    const tilesOff = rom.ptrOffset(ts.tilesPtr);
    if (tilesOff === undefined) return [];
    const mtOff = rom.ptrOffset(ts.metatilesPtr);
    const attrOff = rom.ptrOffset(ts.attributesPtr);
    const catalog = (Versions.TILESETS ?? {}) as Record<string, any>;
    for (const name of Object.keys(catalog)) {
      const spec = catalog[name];
      if (spec.tiles === tilesOff && spec.metatiles === mtOff && spec.attributes === attrOff) {
        return [name, ts];
      }
    }
    const F = Family.active();
    MapCatalog.ensureRegistry();
    // Auto-register unknown tileset under a stable id.
    const id = (F.tilesetName as (off: number) => string | undefined)(ts.structOff) ?? format("rom_%08x", tilesetPtr);
    if (!Versions.TILESETS[id]) {
      const palsOff = rom.ptrOffset(ts.palettesPtr);
      let tilesBytes: number | undefined;
      if (!ts.compressed) {
        tilesBytes = (F.uncompressedTileBytes as (r: Rom, t: number, p: number | undefined, s: boolean) => number | undefined)(
          rom, tilesOff, palsOff, ts.secondary);
      }
      Versions.TILESETS[id] = {
        compressed: ts.compressed,
        secondary: ts.secondary,
        tiles: tilesOff,
        palettes: palsOff,
        metatiles: mtOff,
        attributes: attrOff,
        metatile_bytes: ts.metatile_bytes,
        attr_bytes: ts.attr_bytes,
        palette_count: ts.palette_count ?? 16,
        tiles_bytes: tilesBytes,
      };
    }
    return [id, ts];
  },

  // Lua: map_catalog.lua:224
  pairForLayout(rom: Rom, layout: MapLayout): string | undefined {
    const [priName] = MapCatalog.tilesetNameForPtr(rom, layout.primaryTilesetPtr);
    const [secName] = MapCatalog.tilesetNameForPtr(rom, layout.secondaryTilesetPtr);
    if (!priName || !secName) return undefined;
    MapCatalog.ensureRegistry();
    // Prefer an existing named pair.
    const pairsTbl = (Versions.TILESET_PAIRS ?? {}) as Record<string, any>;
    for (const pairName of Object.keys(pairsTbl)) {
      const pair = pairsTbl[pairName];
      if (pair.primary === priName && pair.secondary === secName) {
        return pairName;
      }
    }
    const pairName = priName + "__" + secName;
    if (!Versions.TILESET_PAIRS[pairName]) {
      Versions.TILESET_PAIRS[pairName] = { primary: priName, secondary: secName };
    }
    if (!Versions.PAIR_TILESET[pairName]) {
      const F = Family.active();
      const prefix = F.aliases ? "FR_" : engine_prefix(F);
      Versions.PAIR_TILESET[pairName] = format(prefix + "%s", pairName.toUpperCase().replace(/[^A-Z0-9]+/g, "_"));
    }
    return pairName;
  },

  // Lua: map_catalog.lua:256 -- register one census entry into Versions.MAPS /
  // MAP_HEADERS / version.layouts
  registerEntry(rom: Rom, version: any, entry: CensusEntry | undefined): string | undefined {
    if (!entry || !entry.layout || !entry.header) return undefined;
    const engineId: string = MapCatalog.resolve(entry.group, entry.num)
      ?? MapCatalog.pretToEngine(entry.pretName)
      ?? entry.id;
    const pair = MapCatalog.pairForLayout(rom, entry.layout);
    if (!pair) return undefined;
    MapCatalog.ensureRegistry();
    const [kind, env] = map_type_kind(entry.header.mapType);
    const layoutName = entry.pretName ?? engineId;
    const mapOff = rom.ptrOffset(entry.layout.mapPtr);
    Versions.MAPS[engineId] = {
      layout: layoutName,
      width: entry.layout.width,
      height: entry.layout.height,
      kind,
      environment: env,
      pair,
      pretName: entry.pretName,
      group: entry.group,
      num: entry.num,
    };
    Versions.MAP_HEADERS[engineId] = entry.header.headerOff;
    version.layouts = version.layouts ?? {};
    if (mapOff !== undefined) {
      version.layouts[layoutName] = {
        offset: mapOff,
        width: entry.layout.width,
        height: entry.layout.height,
      };
    }
    version.map_headers = Versions.MAP_HEADERS;
    version.tilesets = Versions.TILESETS;
    version.tileset_pairs = Versions.TILESET_PAIRS;
    return engineId;
  },

  // Lua: map_catalog.lua:295 -- every map in the census, stable group/num
  // order. Seeds (if given) are sorted to the front so early-game maps pack
  // first; nothing is filtered. [order, byEngine]
  allOrder(census: Census, seedIds?: string[]): [string[], Record<string, CensusEntry>] {
    ensure_index();
    const byEngine: Record<string, CensusEntry> = {};
    for (const entry of census.maps ?? []) {
      const id = MapCatalog.resolve(entry.group, entry.num)
        ?? MapCatalog.pretToEngine(entry.pretName);
      if (id) {
        entry.engineId = id;
        byEngine[id] = entry;
      }
    }

    const order: string[] = [];
    const seen = new Set<string>();
    const add = (id: string | undefined): void => {
      if (!id || seen.has(id) || !byEngine[id]) return;
      seen.add(id);
      order.push(id);
    };
    for (const id of seedIds ?? []) add(id);

    // Remainder in census walk order (already group/num sorted by MapTree.walk).
    for (const entry of census.maps ?? []) {
      add(entry.engineId);
    }
    return [order, byEngine];
  },

  // Lua: map_catalog.lua:325 -- expand a seed map-id list through warps +
  // connections until fixpoint. opts.maxDepth: hop limit from seeds (default 2).
  // Prefer MapCatalog.allOrder for a full-ROM extract into CacheFS.
  expandOrder(seedIds: string[], census: Census, opts?: { maxDepth?: unknown; skipGroups?: Record<number, boolean> }): [string[], Record<string, CensusEntry>] {
    opts = opts ?? {};
    const maxDepth = tonumber(opts.maxDepth) ?? 2;
    ensure_index();
    const byEngine: Record<string, CensusEntry> = {};
    for (const entry of census.maps ?? []) {
      const id = MapCatalog.resolve(entry.group, entry.num)
        ?? MapCatalog.pretToEngine(entry.pretName);
      if (id) {
        entry.engineId = id;
        byEngine[id] = entry;
      }
    }

    const order: string[] = [];
    const seen = new Set<string>();
    const depthOf: Record<string, number> = {};
    // Skip cable-club / link maps unless explicitly seeded (uncompressed special tilesets).
    const skipGroups = opts.skipGroups ?? { 0: true };
    const add = (id: string | undefined, depth: number): void => {
      if (!id || !byEngine[id]) return;
      if (seen.has(id)) return;
      if (depth > maxDepth) return;
      const entry = byEngine[id];
      if (depth > 0 && entry && skipGroups[entry.group]) return;
      seen.add(id);
      depthOf[id] = depth;
      order.push(id);
    };
    for (const id of seedIds) add(id, 0);

    let i = 0;
    while (i < order.length) {
      const id = order[i]!;
      const entry = byEngine[id];
      const depth = depthOf[id] ?? 0;
      if (entry) {
        for (const w of (entry.events && entry.events.warps) || []) {
          const dest = (w.destMap && MapCatalog.resolve(w.destMap))
            || MapCatalog.mapIdFor(w.mapGroup, w.mapNum);
          add(dest, depth + 1);
        }
        // NOT FAITHFUL (order): pairs() over the connection list; a list here.
        for (const c of entry.connections ?? []) {
          const dest = (c.map && MapCatalog.resolve(c.map))
            || MapCatalog.mapIdFor(c.mapGroup, c.mapNum);
          add(dest, depth + 1);
        }
      }
      i = i + 1;
    }
    return [order, byEngine];
  },

  // Lua: map_catalog.lua:377 -- register every map in `order` and rewrite
  // census warp/connection dests to engine ids
  registerOrder(rom: Rom, version: any, order: string[], byEngine: Record<string, CensusEntry>): string[] {
    const registered: string[] = [];
    for (const id of order) {
      const entry = byEngine[id];
      if (entry) {
        const eng = MapCatalog.registerEntry(rom, version, entry);
        if (eng) registered.push(eng);
      }
    }
    // Normalize warp destMap on entries we registered (for warps.lua writer).
    for (const id of registered) {
      const entry = byEngine[id];
      if (entry && entry.events && entry.events.warps) {
        for (const w of entry.events.warps) {
          w.destMap = MapCatalog.mapIdFor(w.mapGroup, w.mapNum)
            ?? (w.destMap ? MapCatalog.resolve(w.destMap) : undefined)
            ?? w.destMap;
        }
      }
      if (entry && entry.connections) {
        for (const c of entry.connections) {
          c.map = MapCatalog.mapIdFor(c.mapGroup, c.mapNum)
            ?? (c.map ? MapCatalog.resolve(c.map) : undefined)
            ?? c.map;
        }
      }
    }
    return registered;
  },
};

// versions_frlg.frMapFor consults the catalog (the Lua requires it lazily).
bindMapCatalog(MapCatalog);

export default MapCatalog;
