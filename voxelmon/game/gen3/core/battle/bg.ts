// Port of gen1recomp src/core/game3/battle/bg.lua (GPLv3 + additional terms; see LICENSE.md).
// FRLG battle background / terrain selection (pret battle_setup + battle_bg).
// One place: map kind / opts → terrain id → baked RGBA. UI and bridge both use this.
//
// Port notes:
// - ENV_MODULES' dynamic require: frlg is env_frlg.ts (static import); the rse
//   module is NOT FAITHFUL: Emerald only (throws).
// - The metatable __index exposing the env's TERRAIN / MAP_TYPE /
//   MAP_BATTLE_SCENE is replaced by plain properties holding the FRLG env's
//   tables (FRLG is the only family in the port; callers read
//   `BattleBg.TERRAIN.X` directly).

/* eslint-disable @typescript-eslint/no-explicit-any */
import { tonumber, tostring, truthy } from "../../../../import/gen3/lua.ts";
import { ipairs, isEmpty, type LuaTable } from "../../platform/lt.ts";
import BattleChrome from "../../ui/battle_chrome.ts";
import Profile from "../profile.ts";
import EnvFrlg, { type EnvModule } from "./env_frlg.ts";

export interface BattleBgModule {
  TERRAIN: Record<string, number>;
  MAP_TYPE: Record<string, number>;
  MAP_BATTLE_SCENE: Record<string, number>;
  _terrainId: number;
  _sheets: LuaTable | null | undefined;
  env(family?: string | null): EnvModule;
  resolveFromMapKind(kind?: string | null): number;
  resolveFromBehavior(behavior: any, mapKind?: string | null, mapType?: any, ctx?: any): number;
  resolveOverride(terrainId: any, opts?: any): number;
  setTerrain(id: any): void;
  terrainId(): number;
  availableSheets(): LuaTable | undefined;
  setAvailableSheets(set: LuaTable | null | undefined): void;
  sheetKey(id?: any): string;
  draw(id?: any, enemyOx?: any, playerOx?: any, bgOx?: any): boolean;
}

export const BattleBg = {} as BattleBgModule;

const ENV_MODULES: Record<string, string> = {
  frlg: "src.core.game3.battle.env_frlg",
  rse: "src.core.game3.battle.env_rse",
};

// Lua: bg.lua:13
BattleBg.env = function (family?: string | null): EnvModule {
  family = truthy(family) ? family : Profile.family();
  const module = ENV_MODULES[family!];
  if (!truthy(module)) throw new Error("battle bg: no environment module for family '" + tostring(family) + "'");
  if (family === "frlg") return EnvFrlg;
  throw new Error("NOT FAITHFUL: Emerald only (" + module + ")");
};

// Lua: bg.lua:20 (ENV_FIELDS + the metatable __index): property reads of the
// FRLG env's tables (getters, so nothing reads env_frlg at load time).
for (const k of ["TERRAIN", "MAP_TYPE", "MAP_BATTLE_SCENE"] as const) {
  Object.defineProperty(BattleBg, k, { get: () => EnvFrlg[k], enumerable: true });
}

// BattleBg._terrainId = BattleBg.TERRAIN.BUILDING: the default is taken on
// first read (no load-time read of env_frlg).
let terrainIdSet: number | undefined;
Object.defineProperty(BattleBg, "_terrainId", {
  get: () => terrainIdSet ?? BattleBg.TERRAIN.BUILDING!,
  set: (v: number) => { terrainIdSet = v; },
  enumerable: true,
});
BattleBg._sheets = undefined;

// Lua: bg.lua:32
BattleBg.resolveFromMapKind = function (kind?: string | null): number {
  return BattleBg.env().resolveFromMapKind(kind);
};

// Lua: bg.lua:36
BattleBg.resolveFromBehavior = function (behavior: any, mapKind?: string | null, mapType?: any, ctx?: any): number {
  return BattleBg.env().resolveFromBehavior(behavior, mapKind, mapType, ctx);
};

// Lua: bg.lua:40
BattleBg.resolveOverride = function (terrainId: any, opts?: any): number {
  return BattleBg.env().resolveOverride(terrainId, opts);
};

// Lua: bg.lua:44
BattleBg.setTerrain = function (id: any): void {
  BattleBg._terrainId = tonumber(id) ?? BattleBg.TERRAIN.BUILDING!;
};

// Lua: bg.lua:48
BattleBg.terrainId = function (): number {
  return BattleBg._terrainId;
};

// Lua: bg.lua:52
BattleBg.availableSheets = function (): LuaTable | undefined {
  if (truthy(BattleBg._sheets)) return BattleBg._sheets;
  const loaded = BattleChrome._terrains;
  if (loaded !== null && typeof loaded === "object" && !isEmpty(loaded)) return loaded;
  const m = BattleChrome._manifest;
  const baked = (m !== null && typeof m === "object") ? m.terrains : undefined;
  if (baked !== null && typeof baked === "object" && !isEmpty(baked)) return baked;
  return undefined;
};

// Lua: bg.lua:62
BattleBg.setAvailableSheets = function (set: LuaTable | null | undefined): void {
  BattleBg._sheets = set;
};

// Lua: bg.lua:66
function frlgSheetKey(env: EnvModule, id: number): string {
  const primary = env.TERRAIN_SHEET[id];
  if (!truthy(primary)) return "building";
  const have = BattleBg.availableSheets();
  if (!truthy(have)) return primary!;
  if (truthy(have[primary!])) return primary!;
  for (const [, key] of ipairs<string>(env.SHEET_DEGRADE[id] ?? {})) {
    if (truthy(have[key])) return key;
  }
  if (truthy(have.building)) return "building";
  if (truthy(have.grass)) return "grass";
  return primary!;
}

// Lua: bg.lua:81
BattleBg.sheetKey = function (id?: any): string {
  const n: number = tonumber(id) ?? BattleBg._terrainId;
  const env = BattleBg.env();
  if (!truthy(env.sheetFor)) return frlgSheetKey(env, n);
  const key = env.sheetFor!(n, BattleChrome.manifest());
  if (!truthy(key)) throw new Error("battle bg: no background for terrain id " + tostring(n));
  return key!;
};

// Lua: bg.lua:90
BattleBg.draw = function (id?: any, enemyOx?: any, playerOx?: any, bgOx?: any): boolean {
  const key = BattleBg.sheetKey(id);
  return BattleChrome.drawTerrain(key, enemyOx, playerOx, bgOx);
};

export default BattleBg;
