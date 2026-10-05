// Port of gen1recomp src/core/game3/battle/moves.lua (GPLv3 + additional terms; see LICENSE.md).
// Move table: ROM gBattleMoves pack.
//
// Port notes:
// - src.import.gba.extract_island1 has no port; the only member read here is
//   Extract.CACHE_ROOT, which extract_island1.lua:21 forwards to
//   CachePaths.CACHE_ROOT, so that is read directly (as dataset.ts etc. do).
// - The lazy requires (pokemon, versions, dataset) are static imports.
// - `load(src, "@" .. root, "t", {})` is luaLoad; the pack's `moves` table is
//   in the lt.ts shape (keyed by move id, 0 included).
// - BY_NUM and the name index are prototype-less objects, so a lookup of a
//   name such as "constructor" reads nil as in Lua.
// - error(msg, 2) becomes a thrown Error (no position prefix).

/* eslint-disable @typescript-eslint/no-explicit-any */
import { tonumber, tostring, truthy } from "../../../../import/gen3/lua.ts";
import { ipairs, isEmpty, len, pairs, remove, seq, type LuaTable } from "../../platform/lt.ts";
import { gsub } from "../../platform/lpattern.ts";
import { luaLoad } from "../../platform/luadata.ts";
import { Versions } from "../../../../import/gen3/versions.ts";
import { CachePaths } from "../cache_paths.ts";
import { Dataset } from "../dataset.ts";
import { Pokemon } from "../pokemon.ts";
import Types from "./types.ts";
import EffectIds from "./effect_ids.ts";

export interface MoveView {
  id: string;
  numId: number;
  power: any;
  type: any;
  category: "physical" | "special" | "status";
  accuracy: any;
  pp: any;
  effect: any;
  secondaryChance: any;
  target: any;
  priority: any;
  flags: any;
  effectId: any;
}

interface ReloadHook { fn: (m: MovesModule) => unknown; key: unknown }

export interface MovesModule {
  _rom: LuaTable | null;
  _romLoaded: boolean;
  _linkRows: LuaTable | null;
  romRows(): LuaTable | null;
  setLinkRows(rows: any): void;
  BY_NUM: Record<number, string>;
  _numByName: Record<string, number> | null;
  loadRomPack(cache?: any): boolean;
  _reloadHooks: LuaTable;
  onReload(fn: any, key?: unknown): () => void;
  _runReloadHooks(): void;
  romReady(): boolean;
  normalizeId(moveId: any): string | null;
  constName(numId: any): string | undefined;
  numForName(name: any): number | null | undefined;
  get(moveId: any): MoveView;
  displayName(moveId: any): string;
  priority(moveId: any): number;
}

export const Moves = {} as MovesModule;

Moves._rom = null; // { [id] = row }
Moves._romLoaded = false;
Moves._linkRows = null;

// Lua: moves.lua:13
Moves.romRows = function (): LuaTable | null {
  Moves.romReady();
  return Moves._rom;
};

// Lua: moves.lua:19 -- pokeemerald/src/battle_controllers.c:397
Moves.setLinkRows = function (rows: any): void {
  Moves._linkRows = (rows !== null && typeof rows === "object") ? rows : null;
};

Moves.BY_NUM = Object.create(null) as Record<number, string>;
Moves._numByName = null;

// Lua: moves.lua:26
function const_name(romName: any): string {
  return gsub(gsub(tostring(romName).toUpperCase(), "%s+", "_")[0], "-", "_")[0];
}

// Lua: moves.lua:30
function build_names(): Record<string, number> {
  const byNum: Record<number, string> = Object.create(null);
  const byName: Record<string, number> = Object.create(null);
  const count: number = Versions.MOVES_COUNT;
  for (let id = 1; id <= count - 1; id++) {
    const n = Pokemon.romMoveName(id);
    if (truthy(n) && n !== "") {
      const key = const_name(n);
      byNum[id] = key;
      if (!truthy(byName[key])) byName[key] = id;
    }
  }
  for (const [k] of pairs(Moves.BY_NUM)) delete (Moves.BY_NUM as any)[k];
  for (const [id, key] of pairs<string>(byNum)) Moves.BY_NUM[id as number] = key;
  Moves._numByName = !isEmpty(byName) ? byName : null;
  return byName;
}

// Lua: moves.lua:47
Moves.loadRomPack = function (cache?: any): boolean {
  Moves._romLoaded = true;
  const root = (CachePaths.CACHE_ROOT ?? "data/generated/gba") + "/pokemon/battle_moves.lua";
  cache = truthy(cache) ? cache : Dataset.cache();
  const src = cache.read(root);
  if (!truthy(src)) throw new Error("pokemon/battle_moves.lua is not in the cache");
  const [chunk, err] = luaLoad(src, "@" + root);
  if (!truthy(chunk)) throw new Error(tostring(err));
  const pack = (chunk as () => any)();
  const moves = truthy(pack) ? pack.moves : pack;
  if (!truthy(moves)) throw new Error("pokemon/battle_moves.lua has no moves");
  Moves._rom = moves;
  Moves._numByName = null;
  build_names();
  Moves._runReloadHooks();
  return true;
};

Moves._reloadHooks = seq();

// Lua: moves.lua:62
Moves.onReload = function (fn: any, key?: unknown): () => void {
  if (typeof fn !== "function") return function (): void {};
  const hooks = Moves._reloadHooks;
  for (let i = len(hooks); i >= 1; i--) {
    const h: ReloadHook = hooks[i];
    if (h.fn === fn || (key != null && h.key === key)) {
      remove(hooks, i);
    }
  }
  const entry: ReloadHook = { fn, key };
  hooks[len(hooks) + 1] = entry;
  return function (): void {
    for (let i = len(hooks); i >= 1; i--) {
      if (hooks[i] === entry) remove(hooks, i);
    }
  };
};

// Lua: moves.lua:80
Moves._runReloadHooks = function (): void {
  const snapshot: LuaTable = seq();
  for (const [i, h] of ipairs<ReloadHook>(Moves._reloadHooks)) snapshot[i] = h;
  for (const [, h] of ipairs<ReloadHook>(snapshot)) {
    try {
      h.fn(Moves);
    } catch (err) {
      console.log("[game3/moves] onReload callback failed: " + tostring(err instanceof Error ? err.message : err));
    }
  }
};

// Lua: moves.lua:89
Moves.romReady = function (): boolean {
  if (!Moves._romLoaded) Moves.loadRomPack(null);
  return Moves._rom != null;
};

/** Lua `a or b`. */
function lor(a: any, b: any): any {
  return truthy(a) ? a : b;
}

// Lua: moves.lua:94
function unwrap_move(moveId: any): any {
  if (moveId !== null && typeof moveId === "object") {
    return lor(lor(lor(lor(lor(moveId.id, moveId.move), moveId.moveId), moveId.num), moveId.name), moveId[1]);
  }
  return moveId;
}

// Lua: moves.lua:101
Moves.normalizeId = function (moveIdIn: any): string | null {
  const moveId = unwrap_move(moveIdIn);
  if (moveId == null || moveId === 0 || moveId === "") return null;
  if (typeof moveId === "number") {
    return lor(Moves.constName(moveId), tostring(moveId));
  }
  if (typeof moveId !== "string") return null;
  const s = gsub(gsub(moveId.toUpperCase(), "%s+", "_")[0], "-", "_")[0];
  if (s === "THUNDER_SHOCK") return "THUNDERSHOCK";
  if (s === "WILLOWISP") return "WILL_O_WISP";
  if (s === "DOUBLE_SLAP") return "DOUBLESLAP";
  return s;
};

// Lua: moves.lua:115
Moves.constName = function (numId: any): string | undefined {
  if (!truthy(Moves._numByName)) build_names();
  return Moves.BY_NUM[tonumber(numId) ?? -1];
};

// Lua: moves.lua:120
Moves.numForName = function (nameIn: any): number | null | undefined {
  const name = unwrap_move(nameIn);
  if (!truthy(name)) return null;
  if (typeof name === "number") return name;
  const byName = truthy(Moves._numByName) ? Moves._numByName! : build_names();
  return lor(byName[const_name(name)], byName[name]);
};

// Lua: moves.lua:128
function from_rom(numId: number): MoveView | null {
  Moves.romReady();
  if (!truthy(Moves._rom)) return null;
  const row = lor(truthy(Moves._linkRows) ? Moves._linkRows![numId] : Moves._linkRows, Moves._rom![numId]);
  if (!truthy(row)) return null;
  let cat: MoveView["category"] = Types.isPhysical(row.type) ? "physical" : "special";
  if ((row.power ?? 0) === 0) cat = "status";
  const id = Moves.constName(numId);
  if (!truthy(id)) throw new Error("no ROM name for move " + tostring(numId));
  return {
    id: id as string,
    numId: numId,
    power: row.power,
    type: row.type,
    category: cat,
    accuracy: row.accuracy,
    pp: row.pp,
    effect: row.effect,
    secondaryChance: row.secondaryChance,
    target: row.target,
    priority: row.priority,
    flags: row.flags,
    effectId: EffectIds.STATUS_SETUP[row.effect],
  };
}

// Lua: moves.lua:153 -- src/data/battle_moves.h:1
Moves.get = function (moveIdIn: any): MoveView {
  const moveId = unwrap_move(moveIdIn);
  let num = tonumber(moveId) as number | null | undefined;
  if (num == null && typeof moveId === "string") {
    num = Moves.numForName(Moves.normalizeId(moveId));
  }
  const m = num != null ? from_rom(num) : null;
  if (!truthy(m)) throw new Error("no ROM move row for move " + tostring(moveId));
  return m as MoveView;
};

// Lua: moves.lua:164
Moves.displayName = function (moveIdIn: any): string {
  const moveId = unwrap_move(moveIdIn);
  if (!truthy(moveId) || moveId === 0 || moveId === "" || moveId === "-------") {
    return "-------";
  }

  let num = tonumber(moveId) as number | null | undefined;
  if (num == null && typeof moveId === "string") {
    num = Moves.numForName(Moves.normalizeId(moveId));
  }
  return Pokemon.moveName(num != null ? num : moveId);
};

const PRIORITY_FALLBACK: Record<number, number> = {
  98: 1,   // QUICK_ATTACK
  182: 2,  // PROTECT
  197: 2,  // DETECT
  183: 1,  // MACH_PUNCH
  245: 2,  // EXTREMESPEED
  252: 1,  // FAKE_OUT
  283: 3,  // HELPING_HAND
  264: 4,  // MAGIC_COAT
  268: 4,  // SNATCH
  279: -3, // REVENGE
  263: -3, // FOCUS_PUNCH
  233: -5, // VITAL_THROW
  46: -6,  // ROAR
  18: -6,  // WHIRLWIND
  309: -6, // COUNTER
  310: -6, // MIRROR_COAT
};

// Lua: moves.lua:196
Moves.priority = function (moveId: any): number {
  if (!truthy(moveId) || moveId === 0 || moveId === "") return 0;
  let ok = false, m: MoveView | undefined;
  try {
    m = Moves.get(moveId);
    ok = true;
  } catch {
    ok = false;
  }
  if (ok && truthy(m) && m!.priority != null) return tonumber(m!.priority) ?? 0;
  let num = tonumber(moveId) as number | null | undefined;
  if (num == null && typeof moveId === "string") {
    num = Moves.numForName(Moves.normalizeId(moveId));
  }
  return (num != null ? PRIORITY_FALLBACK[num] : undefined) ?? 0;
};

export default Moves;
