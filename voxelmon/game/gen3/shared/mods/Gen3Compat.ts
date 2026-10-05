// Port of gen1recomp src/mods/Gen3Compat.lua (GPLv3 + additional terms; see LICENSE.md).
// Gen 1 module facades for a FireRed boot: the Gen 1 mod API backed by
// src/core/game3. On the 3DS no mod ever loads, so this is the no-mod path:
// every function the runtime calls returns the vanilla value or behaviour.
//
// Ported: the id helpers (appliesTo, gen1MapId, gen3MapId, speciesId,
// speciesName, itemId, moveId, moveName, itemName, moveView, speciesView,
// partyNames, partyNums), the live flag/var accessors (getFlag, setFlag,
// getVar, setVar) and the save view built on them (saveView: flags, vars,
// inventory, player, pokedex), worldBusy, worldTick / interactWrapper /
// talkToWrapper (no facade is ever built, so they answer "no replacement"),
// applyMerged (records the game; the sprite-override wrap is identity with
// no mod and is not installed), scriptCtx, spriteOverrides, endSession,
// bind, serves, modules, resolve.
//
// Left out (mod machinery, reached only from a mod): the Gen 1 module
// facades the ADAPTERS table builds (src.core.Game, NPC, Collision,
// FieldDefaults, Boxes, OverworldController, PartyMenu, StartMenu,
// OptionsMenu, BattleState, ScriptRunner, PikachuFollower, Map, BoxMenu,
// WorldAPI) -- resolve() answers nil for them; the data views
// (pokemonRecord, moveRecord, itemRecord, dataView, mapView) and the mod
// registry re-apply after a ROM pack reload; mod sprite overrides
// (centredSprite, reseedSprites, the pokemon.sprite hook); the COVERAGE
// documentation table with coverage() / memberStatus(); src.mods.Schemas
// name lookups (moveId / moveName / itemName fall back to Brian's own
// canonicalName, as he does when Schemas is absent).

import { Logger } from "../core/Logger.ts";
import { GameVersion } from "../core/GameVersion.ts";
import { gsub, match } from "../../platform/lpattern.ts";
import { tonumber, tostring } from "../../../../import/gen3/lua.ts";
import { ipairs, len, pairs, sort } from "../../platform/lt.ts";
import { Pokemon } from "../../core/pokemon.ts";
import { ItemsData } from "../../core/items_data.ts";
import { Moves } from "../../core/battle/moves.ts";
import { Flags } from "../../core/scripting/flags.ts";
import { Bag as G3Bag } from "../../core/bag.ts";
import { Objects } from "../../core/objects.ts";
import { Space } from "../../core/scripting/space.ts";
import { Field } from "../../core/field.ts";
import { Battle as BattleInit } from "../../core/battle/init.ts";
import { battle as BattleMod } from "../../core/battle.ts";
import { Warp } from "../../core/warp.ts";
import { Player } from "../../core/player.ts";
import { Runtime as G3Runtime } from "../../core/runtime.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

// Lua: Gen3Compat.lua:12
let resolveGame: (() => any) | undefined;
let lastGame: any;

let built: Record<string, any> = {};
let claimants: Record<string, (string | null)[]> = {};
let warned: Record<string, boolean> = {};

// Lua: Gen3Compat.lua:19
function warnOnce(key: string, fmt: string, ...args: unknown[]): void {
  if (warned[key]) return;
  warned[key] = true;
  Logger.warn(fmt, ...args);
}

// Lua: Gen3Compat.lua:25
function who(name: string): string {
  const ids = claimants[name];
  if (!ids || len(ids) === 0) return "a gen3 mod";
  const out: string[] = [];
  for (const [, id] of ipairs<string>(ids)) out.push(id);
  return out.join(", ");
}

// Lua: Gen3Compat.lua:31
function live(): any {
  const g = resolveGame ? resolveGame() : undefined;
  return g || lastGame;
}

// Lua: Gen3Compat.lua:44 / 50 -- pcall(require) of a game3 module: the imports above
const g3 = {
  pokemon: (): any => Pokemon,
  items_data: (): any => ItemsData,
  "battle.moves": (): any => Moves,
  "scripting.flags": (): any => Flags,
  bag: (): any => G3Bag,
};

// Lua: Gen3Compat.lua:56
function session(): any {
  const R: any = G3Runtime;
  const s = R && R.getSession ? R.getSession() : undefined;
  if (s) return s;
  const g = live();
  return g ? g.session : undefined;
}

// Lua: Gen3Compat.lua:64
function space(): any {
  return Space;
}

// Lua: Gen3Compat.lua:68
function flagStore(): any {
  const S = space();
  return S ? S.store : undefined;
}

// Lua: Gen3Compat.lua:73
function inField(): boolean {
  const g = live();
  if (g && g.phase != null && g.phase !== "field") return false;
  return session() != null;
}

// Lua: Gen3Compat.lua:92
const MAP_PREFIX = "FR_";

// Lua: Gen3Compat.lua:121
function canonicalName(display: unknown): string | undefined {
  if (typeof display !== "string") return undefined;
  let s = display.toUpperCase();
  // "\xE2\x99\x82" / "\xE2\x99\x80" are the UTF-8 bytes of the male / female signs
  s = gsub(gsub(s, "\xE2\x99\x82", "_M")[0], "\xE2\x99\x80", "_F")[0];
  s = gsub(gsub(s, "[%.']", "")[0], "[%s%-]+", "_")[0];
  s = gsub(gsub(gsub(gsub(s, "[^%w_]", "")[0], "_+", "_")[0], "^_", "")[0], "_$", "")[0];
  return s;
}

// Lua: Gen3Compat.lua:181 -- src.mods.Schemas is not loaded: Brian's fallback
function schemaId(display: unknown): string | undefined {
  if (typeof display !== "string" || display === "") return undefined;
  return canonicalName(display);
}

// Lua: Gen3Compat.lua:214 -- no Schemas type names: the number stays
function typeName(t: unknown): unknown {
  return t;
}

// Lua: Gen3Compat.lua:249
function nameList(list: any, toName: (v: any) => string | undefined): any {
  if (list == null || typeof list !== "object") return list;
  const out: (string | null)[] = [null];
  for (const [, v] of ipairs(list)) {
    const name = (tonumber(v) ?? 0) !== 0 ? toName(v) : undefined;
    if (name) out[len(out) + 1] = name;
  }
  return out;
}

// Lua: Gen3Compat.lua:305
function flagId(name: unknown): number | undefined {
  if (typeof name === "number") return name;
  if (typeof name !== "string") return undefined;
  const n = tonumber(name);
  if (n !== undefined) return n;
  const F = g3["scripting.flags"]();
  if (!F) return undefined;
  let t: any;
  try { t = F.active(session()); } catch { t = undefined; }
  const ids = (t && t.IDS) || F.IDS;
  return ids ? ids[name] : undefined;
}

// Lua: Gen3Compat.lua:317
function varId(name: unknown): number | undefined {
  if (typeof name === "number") return name;
  if (typeof name !== "string") return undefined;
  const n = tonumber(name);
  if (n !== undefined) return n;
  const F = g3["scripting.flags"]();
  if (!F) return undefined;
  let t: any;
  try { t = F.active(session()); } catch { t = undefined; }
  const ids = (t && t.VAR_IDS) || F.VAR_IDS;
  return ids ? ids[name] : undefined;
}

// Lua: Gen3Compat.lua:392
const FLAGS_VIEW = new Proxy({}, {
  get: (_t, key) => (typeof key === "string" ? Gen3Compat.getFlag(key) : undefined),
  set: (_t, key, value) => {
    const [ok, err] = Gen3Compat.setFlag(String(key), value);
    if (!ok) {
      warnOnce("save.flags." + String(key),
        "[%s] save.flags.%s: %s", who("src.core.Game"), String(key), tostring(err));
    }
    return true;
  },
});

// Lua: Gen3Compat.lua:404
const VARS_VIEW = new Proxy({}, {
  get: (_t, key) => (typeof key === "string" ? Gen3Compat.getVar(key) : undefined),
  set: (_t, key, value) => { Gen3Compat.setVar(String(key), value); return true; },
});

// Lua: Gen3Compat.lua:409
const INVENTORY_VIEW = new Proxy({}, {
  get: (_t, key) => {
    if (typeof key !== "string") return undefined;
    const s = session();
    const B = g3.bag();
    if (!(s && s.bag && B)) return undefined;
    const id = Gen3Compat.itemId(key) ?? key;
    const n = B.get(s.bag, id);
    if (!n || n <= 0) return undefined;
    return n;
  },
  set: (_t, key, value) => {
    const s = session();
    const B = g3.bag();
    if (!(s && s.bag && B)) return true;
    const id = Gen3Compat.itemId(String(key));
    if (id === undefined) {
      warnOnce("save.inventory." + String(key),
        "[%s] save.inventory.%s: no FireRed item of that name",
        who("src.core.Game"), String(key));
      return true;
    }
    B.set(s.bag, id, tonumber(value) ?? 0);
    return true;
  },
});

// Lua: Gen3Compat.lua:434
function dexSide(field: string): any {
  return new Proxy({}, {
    get: (_t, key) => {
      if (typeof key !== "string") return undefined;
      const s = session();
      const dex = s && s.dex && s.dex[field];
      const sp = Gen3Compat.speciesId(key);
      if (!(dex && sp !== undefined)) return undefined;
      return (dex[sp] || dex[tostring(sp)]) ? true : undefined;
    },
    set: (_t, key, value) => {
      const s = session();
      const sp = Gen3Compat.speciesId(String(key));
      if (!(s && sp !== undefined)) return true;
      s.dex = s.dex || {};
      s.dex[field] = s.dex[field] || {};
      if (value) s.dex[field][sp] = true;
      else delete s.dex[field][sp];
      return true;
    },
  });
}

// Lua: Gen3Compat.lua:454
const POKEDEX_VIEW = { seen: dexSide("seen"), caught: dexSide("owned") };

// Lua: Gen3Compat.lua:456
const PLAYER_VIEW = new Proxy({}, {
  get: (_t, key) => {
    const s = session();
    if (!s) return undefined;
    if (key === "name") return s.name;
    if (key === "rival") return s.rivalName;
    if (key === "money") return s.money;
    if (key === "map") return Gen3Compat.gen1MapId(s.map);
    if (key === "gen3Map") return s.map;
    if (key === "x" || key === "y" || key === "facing") {
      const P: any = Player;
      if (P && inField()) {
        if (key === "x") return P.cellX;
        if (key === "y") return P.cellY;
        return P.facing;
      }
      return s[key];
    }
    return undefined;
  },
  set: (_t, key, value) => {
    const s = session();
    if (!s) return true;
    if (key === "name") s.name = value;
    else if (key === "rival") s.rivalName = value;
    else if (key === "money") s.money = value;
    else {
      warnOnce("save.player.write." + String(key),
        "[%s] save.player.%s is read-only on FireRed; move the player with "
        + "mod.world:warpTo", who("src.core.Game"), String(key));
    }
    return true;
  },
});

// Lua: Gen3Compat.lua:490
const SAVE_ABSENT: Record<string, string> = {
  boxes: "FireRed's PC is session.storage (14 boxes of 30 sparse slots); "
    + "require src.pokemon.Boxes, which is served",
  box: "FireRed has no Gen 1 save.box",
  objectToggles: "an object's visibility IS its hide flag on FireRed",
  defeatedTrainers: "trainer defeats are flags 0x500 + trainer id",
  hiddenTaken: "hidden items are flags on FireRed",
};

// Lua: Gen3Compat.lua:499
const SAVE_VIEW = new Proxy({}, {
  get: (_t, key) => {
    if (typeof key !== "string") return undefined;
    const s = session();
    if (!s) return undefined;
    if (key === "flags") return FLAGS_VIEW;
    if (key === "vars") return VARS_VIEW;
    if (key === "inventory") return INVENTORY_VIEW;
    if (key === "player") return PLAYER_VIEW;
    if (key === "pokedex") return POKEDEX_VIEW;
    if (key === "gen3") return s;
    const why = SAVE_ABSENT[key];
    if (why) {
      warnOnce("save.absent." + key, "[%s] save.%s has no Gen 3 backing: %s",
        who("src.core.Game"), key, why);
      return undefined;
    }
    return s[key];
  },
  set: (_t, key, value) => {
    const s = session();
    if (!s) return true;
    if (key === "flags" || key === "vars" || key === "inventory"
      || key === "player" || key === "pokedex") {
      warnOnce("save.replace." + String(key),
        "[%s] save.%s cannot be replaced wholesale on FireRed; write its keys",
        who("src.core.Game"), String(key));
      return true;
    }
    s[key as string] = value;
    return true;
  },
});

// Lua: Gen3Compat.lua:1306 -- the OverworldController facade; never built without a mod
const overworld: { update: unknown; interact: unknown; talkTo: unknown } | undefined = undefined;

// Lua: Gen3Compat.lua:1316
const OW = "src.world.OverworldController";

// Lua: Gen3Compat.lua:2034
const spriteOverrides: { front: Record<number, string>; back: Record<number, string> } = { front: {}, back: {} };

// Lua: Gen3Compat.lua:2263 -- the Gen 1 module names served (their builders are mod facades, not ported)
const ADAPTER_NAMES = [
  "src.core.Game", "src.world.NPC", "src.world.Collision", "src.world.FieldDefaults",
  "src.pokemon.Boxes", "src.world.OverworldController", "src.ui.PartyMenu",
  "src.ui.StartMenu", "src.ui.OptionsMenu", "src.battle.BattleState",
  "src.script.ScriptRunner", "src.world.PikachuFollower", "src.world.Map",
  "src.world.WorldAPI", "src.ui.BoxMenu",
];
const ADAPTERS: Record<string, true> = {};
for (const n of ADAPTER_NAMES) ADAPTERS[n] = true;

export const Gen3Compat = {
  // Lua: Gen3Compat.lua:81
  COVERAGE_VERSION: 1,
  STATUS: { BACKED: "backed", WARNED: "warned", ABSENT: "absent" },
  // Lua: Gen3Compat.lua:94
  FAMILIES: { frlg: true } as Record<string, boolean>,
  ADAPTERS,

  // Lua: Gen3Compat.lua:96
  appliesTo(version: unknown): boolean {
    if (typeof version !== "string") return true;
    if (!GameVersion.VERSIONS[version]) return true;
    return Gen3Compat.FAMILIES[GameVersion.layout(version) ?? ""] === true;
  },

  // Lua: Gen3Compat.lua:102
  gen1MapId(id: unknown): unknown {
    if (typeof id !== "string") return id;
    if (id.slice(0, MAP_PREFIX.length) === MAP_PREFIX) return id.slice(MAP_PREFIX.length);
    return id;
  },

  // Lua: Gen3Compat.lua:108
  gen3MapId(id: unknown): unknown {
    if (typeof id !== "string") return id;
    const g = live();
    const maps = g && g.data && g.data.maps;
    if (maps) {
      if (maps[id]) return id;
      if (maps[MAP_PREFIX + id]) return MAP_PREFIX + id;
      return undefined;
    }
    if (id.slice(0, MAP_PREFIX.length) === MAP_PREFIX) return id;
    return MAP_PREFIX + id;
  },

  // Lua: Gen3Compat.lua:130
  speciesId(ref: unknown): number | undefined {
    if (typeof ref === "number") return ref;
    if (typeof ref !== "string") return undefined;
    const n = tonumber(ref);
    if (n !== undefined) return n;
    const P = g3.pokemon();
    return (P && P.speciesFromName && P.speciesFromName(ref)) || undefined;
  },

  // Lua: Gen3Compat.lua:139
  speciesName(spIn: unknown): string | undefined {
    if (typeof spIn === "string" && tonumber(spIn) === undefined) return spIn;
    const sp = tonumber(spIn);
    if (sp === undefined) return undefined;
    const P = g3.pokemon();
    if (P && P.keyName) {
      const key = P.keyName(sp);
      if (key) return key;
    }
    if (!(P && P.name)) return undefined;
    return canonicalName(P.name(sp));
  },

  // Lua: Gen3Compat.lua:152
  itemId(ref: unknown): number | undefined {
    if (typeof ref === "number") return ref;
    const D = g3.items_data();
    const num = D && D.toNumericId ? D.toNumericId(ref) : undefined;
    if (num) return num;
    if (typeof ref === "string" && D && D.toNumericId) {
      return D.toNumericId(gsub(ref, "_", " ")[0]) ?? undefined;
    }
    return undefined;
  },

  // Lua: Gen3Compat.lua:163
  moveId(ref: unknown): number | undefined {
    if (typeof ref === "number") return ref;
    if (typeof ref !== "string") return undefined;
    const n = tonumber(ref);
    if (n !== undefined) return n;
    const M = g3["battle.moves"]();
    if (!M) return undefined;
    const norm = M.normalizeId ? M.normalizeId(ref) : ref;
    const num = M.numForName ? M.numForName(norm) : undefined;
    if (num) return num;
    return undefined;
  },

  // Lua: Gen3Compat.lua:190
  moveName(refIn: unknown): string | undefined {
    let ref: any = refIn;
    if (ref != null && typeof ref === "object") ref = ref.numId ?? ref.id ?? ref.move;
    if (typeof ref === "string" && tonumber(ref) === undefined) return ref;
    const num = tonumber(ref);
    if (num === undefined || num < 1) return undefined;
    const P = g3.pokemon();
    let name = P && P.moveName ? P.moveName(num) : undefined;
    if (typeof name !== "string" || name === "" || match(name, "^MOVE ")) {
      const M = g3["battle.moves"]();
      name = M && M.BY_NUM ? M.BY_NUM[num] : undefined;
    }
    return schemaId(name) || tostring(num);
  },

  // Lua: Gen3Compat.lua:204
  itemName(ref: unknown): string | undefined {
    if (ref == null || ref === 0) return undefined;
    if (typeof ref === "string" && tonumber(ref) === undefined) return ref;
    const num = tonumber(ref);
    if (num === undefined || num < 1) return undefined;
    const D = g3.items_data();
    const name = D && D.displayName ? D.displayName(num) : undefined;
    return schemaId(name) || tostring(num);
  },

  // Lua: Gen3Compat.lua:221
  moveView(ref: any): any {
    const M = g3["battle.moves"]();
    if (!M) return undefined;
    const def = ref != null && typeof ref === "object" && ref.effect != null ? ref : M.get(ref);
    if (!def) return undefined;
    const num = tonumber(def.numId) ?? Gen3Compat.moveId(ref != null && typeof ref === "object" ? def.id : ref);
    return {
      id: Gen3Compat.moveName(num) || def.id, index: num, num,
      name: M.displayName ? M.displayName(num ?? def.id) : def.id,
      type: typeName(def.type), gen3Type: tonumber(def.type),
      power: def.power, accuracy: def.accuracy, pp: def.pp,
      priority: def.priority, category: def.category, effect: def.effect,
      target: def.target, secondaryChance: def.secondaryChance,
    };
  },

  // Lua: Gen3Compat.lua:237
  speciesView(spIn: unknown): any {
    const sp = Gen3Compat.speciesId(spIn);
    if (sp === undefined) return undefined;
    const P = g3.pokemon();
    const meta = (P && P.speciesMeta && P.speciesMeta(sp)) || {};
    return {
      id: Gen3Compat.speciesName(sp), index: sp,
      catchRate: tonumber(meta.catchRate), expYield: tonumber(meta.expYield),
      growthRate: tonumber(meta.growthRate),
    };
  },

  // Lua: Gen3Compat.lua:259
  partyNames(party: any): (any | null)[] {
    const out: any[] = [null];
    for (const [i, mon] of ipairs<any>(party || [null])) {
      const row: any = {};
      for (const [k, v] of pairs(mon)) row[k] = v;
      const sp = tonumber(mon.species ?? mon.speciesId);
      row.species = Gen3Compat.speciesName(sp) ?? mon.species;
      row.speciesId = sp;
      if (mon.moves != null && typeof mon.moves === "object") {
        row.moves = nameList(mon.moves, Gen3Compat.moveName);
        row.moveIds = [null];
        for (const [j, v] of ipairs(mon.moves)) row.moveIds[j] = v;
      }
      if (mon.heldItem != null) {
        row.heldItem = Gen3Compat.itemName(mon.heldItem);
        row.heldItemId = tonumber(mon.heldItem);
      }
      out[i] = row;
    }
    return out;
  },

  // Lua: Gen3Compat.lua:281
  partyNums(party: any): (any | null)[] {
    const out: any[] = [null];
    for (const [i, mon] of ipairs<any>(party || [null])) {
      const row: any = {};
      for (const [k, v] of pairs(mon)) row[k] = v;
      row.species = Gen3Compat.speciesId(mon.species) ?? tonumber(mon.speciesId) ?? 0;
      delete row.speciesId;
      if (mon.moves != null && typeof mon.moves === "object") {
        const list: any[] = [null];
        for (const [j, v] of ipairs(mon.moves)) list[j] = Gen3Compat.moveId(v) ?? 0;
        row.moves = list;
      }
      delete row.moveIds;
      if (mon.heldItem != null) {
        row.heldItem = Gen3Compat.itemId(mon.heldItem);
      }
      delete row.heldItemId;
      out[i] = row;
    }
    return out;
  },

  // Lua: Gen3Compat.lua:329
  getFlag(name: unknown): true | undefined {
    const id = flagId(name);
    if (id === undefined) return undefined;
    const F = g3["scripting.flags"]();
    const store = flagStore();
    if (store && F) {
      return F.getFlag(store, undefined, id) ? true : undefined;
    }
    const s = session();
    const flags = s && s.flags;
    if (!flags) return undefined;
    return (flags[id] || flags[tostring(id)]) ? true : undefined;
  },

  // Lua: Gen3Compat.lua:343 -- [true] or [undefined, err]
  setFlag(name: unknown, value: unknown): [true?, string?] {
    const id = flagId(name);
    if (id === undefined) return [undefined, "unknown FireRed flag: " + tostring(name)];
    const F = g3["scripting.flags"]();
    const store = flagStore();
    if (store && F) {
      F.setFlag(store, undefined, id, value ? true : false);
      const O: any = Objects;
      if (O && O.syncFlagVisibility) {
        O.syncFlagVisibility(id, value ? true : false, true);
      }
      return [true];
    }
    const s = session();
    if (!s) return [undefined, "no session"];
    s.flags = s.flags || {};
    if (value) s.flags[tostring(id)] = true;
    else delete s.flags[tostring(id)];
    return [true];
  },

  // Lua: Gen3Compat.lua:363
  getVar(name: unknown): number | undefined {
    const id = varId(name);
    if (id === undefined) return undefined;
    const F = g3["scripting.flags"]();
    const S = space();
    if (S && S.store && F) {
      return F.getVar(S.store, S.vm ? S.vm.ctx : undefined, id);
    }
    const s = session();
    const vars = s && s.vars;
    return (vars ? tonumber(vars[id] ?? vars[tostring(id)]) : undefined) ?? 0;
  },

  // Lua: Gen3Compat.lua:376 -- [true] or [undefined, err]
  setVar(name: unknown, value: unknown): [true?, string?] {
    const id = varId(name);
    if (id === undefined) return [undefined, "unknown FireRed var: " + tostring(name)];
    const F = g3["scripting.flags"]();
    const S = space();
    if (S && S.store && F) {
      F.setVar(S.store, S.vm ? S.vm.ctx : undefined, id, value);
      return [true];
    }
    const s = session();
    if (!s) return [undefined, "no session"];
    s.vars = s.vars || {};
    s.vars[tostring(id)] = tonumber(value) ?? 0;
    return [true];
  },

  // Lua: Gen3Compat.lua:531
  saveView: SAVE_VIEW,

  // Lua: Gen3Compat.lua:1342 -- [busy, why]
  worldBusy(): [boolean, string?] {
    const F: any = Field;
    if (!(F && F.running)) return [true, "no overworld"];
    if (F.locked) return [true, "world is busy"];
    const R: any = G3Runtime;
    if (R && R.uiBusy) {
      try {
        if (R.uiBusy()) return [true, "world is busy"];
      } catch { /* pcall */ }
    }
    const S = space();
    if (S && S.vm && S.vm.isRunning && S.vm.isRunning()) {
      return [true, "a script is running"];
    }
    const B: any = BattleInit || BattleMod;
    if (B && B.isActive && B.isActive()) return [true, "a battle is running"];
    const W: any = Warp;
    if (W && W.isBusy && W.isBusy()) return [true, "the world is mid-warp"];
    const P: any = Player;
    if (P && P.moving) return [true, "world is busy"];
    return [false];
  },

  // Lua: Gen3Compat.lua:1625
  worldTick(dt: number): void {
    const ow: any = overworld;
    if (!ow || ow.update == null) return;
    ow.update(ow, dt);
  },

  // Lua: Gen3Compat.lua:1630
  interactWrapper(): unknown {
    const ow: any = overworld;
    if (!ow) return undefined;
    return ow.interact;
  },

  // Lua: Gen3Compat.lua:1635
  talkToWrapper(): unknown {
    const ow: any = overworld;
    if (!ow) return undefined;
    return ow.talkTo;
  },

  // Lua: Gen3Compat.lua:2174
  spriteOverrides(): { front: Record<number, string>; back: Record<number, string> } {
    const out: { front: Record<number, string>; back: Record<number, string> } = { front: {}, back: {} };
    for (const side of ["front", "back"] as const) {
      for (const [sp, path] of pairs<string>(spriteOverrides[side])) out[side][sp as number] = path;
    }
    return out;
  },

  // Lua: Gen3Compat.lua:2221
  // With no mod: records the game; collectOverrides finds no pokemon registry,
  // so the front/back pic wrap (wrapPics / seed) would only ever return the
  // vanilla entry, and the onReload re-apply has nothing to write. NOT
  // FAITHFUL: the identity wrap and the onReload registrations are not installed.
  applyMerged(game: any): void {
    if (game) lastGame = game;
    spriteOverrides.front = {};
    spriteOverrides.back = {};
  },

  // Lua: Gen3Compat.lua:2249
  scriptCtx(vm?: any): any {
    const S = space();
    return {
      game: live(),
      save: SAVE_VIEW,
      overworld: inField() ? Gen3Compat.resolve(OW) : undefined,
      runner: vm || (S && S.vm),
      vm: vm || (S && S.vm),
      generation: 3,
    };
  },

  // Lua: Gen3Compat.lua:2283
  endSession(): void {
    resolveGame = undefined;
    lastGame = undefined;
    built = {};
    claimants = {};
    warned = {};
  },

  // Lua: Gen3Compat.lua:2288
  bind(fn: (() => any) | undefined): void {
    resolveGame = fn;
  },

  // Lua: Gen3Compat.lua:2292
  serves(name: string): boolean {
    return ADAPTERS[name] != null;
  },

  // Lua: Gen3Compat.lua:2296
  modules(): (string | null)[] {
    const out: (string | null)[] = [null];
    for (const name of Object.keys(ADAPTERS)) out[len(out) + 1] = name;
    sort(out);
    return out;
  },

  // Lua: Gen3Compat.lua:2323
  // NOT FAITHFUL: the facades are mod API and are not ported; a served name
  // answers nil (and is still recorded as claimed by modId).
  resolve(name: string, modId?: string): any {
    if (!ADAPTERS[name]) return undefined;
    const module = built[name];
    if (modId) {
      let ids = claimants[name];
      if (!ids) { ids = [null]; claimants[name] = ids; }
      let seen = false;
      for (const [, id] of ipairs(ids)) if (id === modId) { seen = true; break; }
      if (!seen) ids[len(ids) + 1] = modId;
    }
    return module;
  },
};

export default Gen3Compat;
