// Port of gen1recomp src/core/game3/scripting/space.lua (GPLv3 + additional terms; see LICENSE.md).
// Sevii space swap: activate game3 on SEVII_* maps; wipe on leave/halt.
//
// Port notes:
// - lazyReq / package.loaded / pcall(require): every module of the bundle is
//   a static import, used exactly as Brian guards it. `src.world.gen2.World`
//   and `src.core.game3.rse.init` have no file in the port: their
//   pcall(lazyReq) reads as a failed require; the Emerald-only rse.init calls
//   throw "NOT FAITHFUL: Emerald only".
// - NOT FAITHFUL (shape seam): ensureBundle does not call the importer's
//   ExtractScripts.loadBundle, which reads the cache with readLuaLiteral
//   (sequences 0-based). It runs the same steps (extract_scripts.lua:664)
//   with luaLoad, so script lists keep Lua's 1-based rows and vm.lua's
//   `list[pc.index]` reads the same row. Text entries (TextIR segment
//   lists) are turned into 0-based arrays, TextIR's own convention, which
//   rom_text / message / ops_a pass to TextIR. Encounters.installEncounterTypes
//   (which reads with luaGet) gets the importer's shape via importerShape()
//   at the call site; InteractionScripts reads by key and takes either.
// - installLabels' metatable (__index through labels) is a Proxy over the
//   scripts table; rawget reads the table behind it (rawScripts).
// - Encounters.deps (core/encounters.ts late binding) gets Space and Flags
//   here at load, and encounter_rules/frlg.ts is imported for its own bind.
// - print -> Logger.info.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { ipairs, pairs, len, seq, toArray, type LuaTable } from "../../platform/lt.ts";
import { format, tonumber, tostring, truthy, mod as lmod } from "../../../../import/gen3/lua.ts";
import { luaLoad } from "../../platform/luadata.ts";
import { notPorted } from "../../notported.ts";
import { Logger } from "../../shared/core/Logger.ts";
import { MapIds } from "../map_ids.ts";
import { Ctx } from "./ctx.ts";
import { Flags } from "./flags.ts";
import { Vm } from "./vm.ts";
import Adapters from "./adapters.ts";
import { ExtractScripts } from "../../../../import/gen3/extract_scripts.ts";
import { GfxIds } from "./gfx_ids.ts";
import { ItemsData } from "../items_data.ts";
import { Profile } from "../profile.ts";
import { Dataset } from "../dataset.ts";
import { Extract } from "../../../../import/gen3/extract_island1.ts";
import { Bag } from "../bag.ts";
import Runtime from "../runtime.ts";
import Constants from "../constants.ts";
import Objects from "../objects.ts";
import Ops from "./ops_a.ts";
import Player from "../player.ts";
import Field from "../field.ts";
import Bridge from "../bridge.ts";
import CollisionStd from "./collision_std.ts";
import OC from "../../shared/world/OverworldController.ts";
import { InteractionScripts } from "./interaction_scripts.ts";
import { Encounters } from "../encounters.ts";
import { Marts } from "../marts.ts";
import "../encounter_rules/frlg.ts";

// Lua: space.lua:3 (lazyReq) for a module with no file in the port: the
// require fails, as in Lua; pcall(lazyReq, name) reads [false, err].
function pcallMissing(name: string): [false, string] {
  try {
    notPorted(`require("${name}") (no such module in the port yet)`);
  } catch (e) {
    return [false, String((e as Error).message ?? e)];
  }
}

// installLabels: the scripts table behind each labelled Proxy (rawget).
const RAW = new WeakMap<object, any>();
function rawScripts(t: any): any {
  return RAW.get(t) ?? t;
}

/**
 * Seam: a luaLoad-shaped value (1-based sequences, slot 0 unused) in the
 * importer's readLuaLiteral shape (a table keyed exactly 1..n is a 0-based
 * array; any other is an object with integer keys) for the importer-side
 * port Encounters.installEncounterTypes.
 */
function importerShape(v: any): any {
  if (v == null || typeof v !== "object") return v;
  if (Array.isArray(v)) {
    const n = len(v);
    let count = 0;
    for (let i = 0; i < v.length; i++) if (v[i] != null) count++;
    if (n > 0 && count === n) {
      const out: any[] = [];
      for (let i = 1; i <= n; i++) out.push(importerShape(v[i]));
      return out;
    }
    const obj: Record<string, any> = {};
    for (let i = 0; i < v.length; i++) if (v[i] != null) obj[i] = importerShape(v[i]);
    return obj;
  }
  const out: Record<string, any> = {};
  for (const k of Object.keys(v)) out[k] = importerShape(v[k]);
  return out;
}

// Lua: extract_scripts.lua:650 (ExtractScripts.bundleReady), on the luaLoad shape
function bundleReady(bundle: any): [boolean, string?] {
  if (!bundle) return [false, "nil bundle"];
  if (!bundle.scripts || isEmptyT(bundle.scripts)) return [false, "missing scripts"];
  if (!bundle.events || isEmptyT(bundle.events)) return [false, "missing events"];
  if (!bundle.text) return [false, "missing text"];
  return [true];
}
function isEmptyT(t: any): boolean {
  for (const _ of pairs(t)) return false;
  return true;
}

// Lua: extract_scripts.lua:664 (ExtractScripts.loadBundle) with luaLoad -- [bundle] | [undefined, why]
function loadBundle(cache: any, root?: string, opts?: { allowIncomplete?: boolean; strict?: boolean }): [any, string?] {
  opts = opts ?? {};
  root = root ?? "data/generated/gba";
  const base = root + "/" + ExtractScripts.CACHE_SUB;
  const load_lua = (rel: string): any => {
    const src = cache.read(rel);
    if (src == null) return undefined;
    const [chunk] = luaLoad(src, "@" + rel);
    if (!chunk) return undefined;
    return chunk();
  };
  const scripts = load_lua(base + "/scripts.lua");
  let text = load_lua(base + "/text.lua");
  let movements = load_lua(base + "/movements.lua");
  const events = load_lua(base + "/events.lua");
  const textTables = load_lua(base + "/text_tables.lua");
  if (scripts && events) {
    const objects = load_lua(root + "/objects/pack.lua");
    InteractionScripts.install(objects);
    // seam: encounters.ts reads encounterTypes with luaGet (readLuaLiteral shape)
    Encounters.installEncounterTypes(importerShape(objects && objects.encounterTypes));
    if (objects) {
      text = text ?? {}; movements = movements ?? {};
      for (const [k, v] of pairs(objects.scripts ?? {})) scripts[k] = v;
      for (const [k, v] of pairs(objects.text ?? {})) text[k] = v;
      for (const [k, v] of pairs(objects.movements ?? {})) movements[k] = v;
    }
    // seam: text entries are TextIR segment lists, which TextIR and its
    // callers (rom_text, message, ops_a) take as 0-based JS arrays.
    if (text) {
      for (const k of Object.keys(text)) {
        const v = text[k];
        if (Array.isArray(v) && v[0] == null) text[k] = toArray(v);
      }
    }
    const bundle: any = {
      scripts,
      text: text ?? {},
      textTables,
      movements: movements ?? {},
      events,
      fromCache: true,
    };
    {
      const n = Marts.load(cache, root);
      bundle.martListCount = n;
    }
    const [ok, why] = bundleReady(bundle);
    if (!ok && !opts.allowIncomplete) {
      if (opts.strict) {
        return [undefined, why];
      }
    }
    return [bundle];
  }
  return [undefined, "extract cache missing"];
}

// Lua: space.lua:40
function resolve_game(mod: any, game?: any): any {
  if (game) return game;
  if (mod && mod.game) return mod.game;
  // package.loaded["src.core.game3.runtime"]
  return Runtime && Runtime._game;
}

// Lua: space.lua:47
function resolve_session(mod: any, game?: any): any {
  if (Runtime && Runtime.getSession) {
    const s = Runtime.getSession();
    if (s) return s;
  }
  game = resolve_game(mod, game);
  return game && game.session;
}

// Lua: space.lua:57
function love_cache(): any {
  return Dataset.cache();
}

// Lua: space.lua:61
function load_sidecar(mod: any, game?: any): void {
  Space.store = Flags.newStore();
  // Standalone FR: do not keep the Sevii harbor seed unless a save restores it.
  const harborVar = (Flags.VAR_IDS && (Flags.VAR_IDS.MAP_SCENE_ONE_ISLAND_HARBOR ?? Flags.VAR_IDS.VAR_MAP_SCENE_ONE_ISLAND_HARBOR))
    ?? (Flags.IDS && (Flags.IDS.MAP_SCENE_ONE_ISLAND_HARBOR ?? Flags.IDS.VAR_MAP_SCENE_ONE_ISLAND_HARBOR))
    ?? 0x4075;
  if (harborVar != null) {
    delete Space.store.vars[harborVar];
  }
  const session = resolve_session(mod, game);
  if (session) {
    Flags.loadInto(Space.store, {
      flags: session.flags,
      vars: session.vars,
    });
    Flags.ensurePalletOakHidden(Space.store);
    if (Profile.has(session, "berryPouch") && session.bag && Bag.has(session.bag, ItemsData.ITEM_BERRY_POUCH, 1)) {
      Flags.setFlag(Space.store, null, Bag.FLAG_SYS_GOT_BERRY_POUCH, true); // src/item.c:249
    }
    return;
  }
  game = resolve_game(mod, game);
  const save = game && game.save;
  if (save && save.modData && save.modData[Space._saveKey]) {
    Flags.loadInto(Space.store, save.modData[Space._saveKey]);
  }
  Flags.ensurePalletOakHidden(Space.store);
}

// Lua: space.lua:91
function persist_sidecar(mod: any, game?: any): void {
  if (!Space.store) return;
  const snap = Flags.serialize(Space.store);
  const session = resolve_session(mod, game);
  if (session) {
    session.flags = snap.flags;
    session.vars = snap.vars;
    return;
  }
  game = resolve_game(mod, game);
  if (!(game && game.save)) return;
  game.save.modData = game.save.modData ?? {};
  game.save.modData[Space._saveKey] = snap;
  if (game.save.flags == null && session) {
    game.save.flags = session.flags;
    game.save.vars = session.vars;
  }
}

// pokeemerald/src/event_data.c:16
// Lua: space.lua:211
function share_specials(vm: any, sess: any): void {
  if (!(vm && sess && Profile.family(sess) === "rse")) return;
  let shared = Space._specials;
  if (!shared || shared.session !== sess) {
    shared = { session: sess, vars: vm.ctx.specialVars };
    Space._specials = shared;
  }
  vm.ctx.specialVars = shared.vars;
  vm.ctx.persistentSpecials = true;
}

// Lua: space.lua:288
function map_scripts(mapId?: any): any {
  mapId = mapId ?? Space.mapId;
  const ev = Space.bundle && Space.bundle.events && Space.bundle.events[mapId];
  return (ev && ev.mapScripts) || null;
}

// pokefirered/src/event_data.c:235
// Lua: space.lua:295
function varget(idIn: any): number {
  const id = tonumber(idIn) ?? 0;
  if (id < Ctx.TEMP_LO) return id;
  return Flags.getVar(Space.store, Space.vm && Space.vm.ctx, id);
}

// pokefirered/src/script.c:409
// Lua: space.lua:302
function check_script_table(rows: any): any {
  if (rows == null || typeof rows !== "object") return null;
  for (const [, row] of ipairs<any>(rows)) {
    if (row.script && varget(row.var) === varget(row.value ?? 0)) {
      return row.script;
    }
  }
  return null;
}

// pokefirered/src/script.c:33
// Lua: space.lua:313
function immediate_vm(): Vm | null {
  const main = Space.vm;
  if (!main) return null;
  let iv = Space._immediateVm;
  if (!iv || iv._host !== main) {
    iv = Vm.new({
      store: Space.store,
      scripts: main.scripts,
      text: main.text,
      movements: main.movements,
      adapters: main.adapters,
    });
    iv._mod = main._mod;
    iv._host = main;
    if (main.ctx.persistentSpecials) {
      iv.ctx.specialVars = main.ctx.specialVars;
      iv.ctx.persistentSpecials = true;
    }
    Space._immediateVm = iv;
  }
  iv.store = Space.store;
  return iv;
}

// pokefirered/src/script.c:375
// Lua: space.lua:338
function run_immediately(key: any): boolean {
  if (typeof key !== "string") return false;
  const iv = immediate_vm();
  if (!iv) return false;
  if (iv.isRunning()) iv.halt(true);
  // pokefirered/src/field_control_avatar.c:427
  iv.ctx.specialVars[Ctx.VAR_LAST_TALKED] =
    Space.vm!.ctx.specialVars[Ctx.VAR_LAST_TALKED];
  // pokefirered/src/field_specials.c:153
  // package.loaded["src.core.game3.runtime"]
  const session = Runtime && Runtime.getSession && Runtime.getSession();
  iv.ctx.lastBattleOutcome = (session && session.battleOutcome)
    || Space.vm!.ctx.lastBattleOutcome;
  if (!iv.start(key)) return false;
  for (let i = 1; i <= 1024; i++) {
    if (!iv.isRunning()) break;
    iv.tick();
  }
  return true;
}

const NEIGHBOR_FLOW_OPS: Record<string, boolean> = {
  ["end"]: true, ["return"]: true, call: true, ["goto"]: true,
  call_if: true, goto_if: true, compare_var_to_value: true,
  compare_var_to_var: true, checkflag: true, setvar: true,
  addvar: true, subvar: true, copyvar: true,
};

// Lua: space.lua:587
function runNeighborTransition(mapId: any): any {
  const ev = Space.bundle && Space.bundle.events && Space.bundle.events[mapId];
  if (!ev) return null;
  const src = Space.store ?? Flags.newStore();
  const store: any = { flags: {}, vars: {} };
  for (const [k, v] of pairs(src.flags ?? {})) store.flags[k] = v;
  for (const [k, v] of pairs(src.vars ?? {})) store.vars[k] = v;
  for (let id = Ctx.GFX_VAR_LO; id <= Ctx.GFX_VAR_HI; id++) delete store.vars[id];
  const state: any = { store, perm: {}, movementType: {} };
  const key = ev.mapScripts && ev.mapScripts.onTransition;
  const scripts = Space.vm && Space.vm.scripts;
  if (typeof key !== "string" || !(scripts && scripts[key])) return state;
  const vm = Vm.new({ store, scripts });
  const ctx = vm.ctx;
  vm.setPc(key, 1);
  ctx.status = "running";
  // src/overworld.c:807
  for (let i = 1; i <= 2000; i++) {
    const pc = ctx.pc;
    const list = pc && scripts[pc.listKey];
    const row = list && list[pc!.index];
    if (!row) break;
    pc!.index = pc!.index + 1;
    const op = row.op;
    if (op === "setobjectxyperm") {
      const lid = Flags.getVar(store, ctx, row.localId ?? row[1]);
      state.perm[lid] = {
        x: Flags.getVar(store, ctx, row[2]),
        y: Flags.getVar(store, ctx, row[3]),
      };
    } else if (op === "setobjectmovementtype") {
      const lid = Flags.getVar(store, ctx, row.localId ?? row[1]);
      state.movementType[lid] = tonumber(row[2]) ?? 0;
    } else if (NEIGHBOR_FLOW_OPS[op]) {
      Ops.dispatchUnhooked(vm, row);
    }
  }
  return state;
}

const FACING_DIRS: Record<string, number> = { down: 1, up: 2, left: 3, right: 4 };

export interface SpaceModule {
  active: boolean;
  vm: Vm | null | undefined;
  store: any;
  bundle: any;
  mapId: any;
  _saveKey: string;
  _mod?: any;
  _specials?: any;
  _immediateVm?: Vm | null;
  _inTransition?: boolean;
  _pendingOnFrame?: boolean;
  _deferOnFrameForFade?: boolean;
  _neighborState?: any;
  _installed?: boolean;
  currentMapId?: any;
  TEMP_FIELD_EVENT_FLAGS: LuaTable;
  [key: string]: any;
}

export const Space: SpaceModule = {
  active: false,
  vm: null,
  store: null,
  bundle: null,
  mapId: null,
  _saveKey: "firered_game3",

  // pokefirered/src/event_data.c:56
  TEMP_FIELD_EVENT_FLAGS: seq(0x807, 0x842),

  // Lua: space.lua:28
  isActive(): boolean {
    return Space.active === true;
  },

  // Lua: space.lua:32
  getVm(): Vm | null | undefined {
    return Space.vm;
  },

  // Lua: space.lua:36
  getStore(): any {
    return Space.store;
  },

  /** Persist flag/var store into the active session (and save sidecar if any). */
  // Lua: space.lua:111
  persistSession(mod?: any, game?: any): void {
    persist_sidecar(mod ?? Space._mod, game);
  },

  // Lua: space.lua:115
  ensureBundle(mod?: any): any {
    if (Space.bundle) return Space.bundle;
    Dataset.mountExtractRoots();
    const root = Extract.CACHE_ROOT ?? "data/generated/gba";
    const cache = (mod && mod.cache) || love_cache();
    const [bundle] = loadBundle(cache, root, { allowIncomplete: true });
    Space.bundle = bundle;
    Space.installLabels(bundle, cache, root);
    let nEv = 0;
    if (bundle && bundle.events) {
      for (const _ of pairs(bundle.events)) nEv = nEv + 1;
    }
    Logger.info(format("[game3/space] script bundle events=%d fromCache=%s",
      nEv, tostring(bundle && bundle.fromCache)));
    return Space.bundle;
  },

  // Lua: space.lua:134
  installLabels(bundle: any, cache: any, root?: string): any {
    if (!(bundle && bundle.scripts != null && typeof bundle.scripts === "object")) return null;
    const rel = (root ?? "data/generated/gba") + "/" + ExtractScripts.CACHE_SUB + "/labels.lua";
    const src = cache && cache.read(rel);
    const chunk = src != null ? luaLoad(src, "@" + rel)[0] : undefined;
    let okL = false, labels: any = null;
    if (chunk) {
      try { labels = chunk(); okL = true; } catch { okL = false; }
    }
    if (!okL || labels == null || typeof labels !== "object") return null;
    bundle.labels = labels;
    const scripts = rawScripts(bundle.scripts);
    const proxied = new Proxy(scripts, {
      get(t: any, k: string | symbol): any {
        const v = t[k as any];
        if (v != null || typeof k !== "string") return v;
        const key = labels[k];
        if (key != null && key !== k) return t[key];
        return undefined;
      },
    });
    RAW.set(proxied, scripts);
    bundle.scripts = proxied;
    return labels;
  },

  // Lua: space.lua:154
  scriptKey(name: any): string | null {
    const bundle = Space.bundle;
    if (typeof name !== "string" || !(bundle && bundle.scripts)) return null;
    const raw = rawScripts(bundle.scripts);
    if (raw[name] != null) return name;
    const key = bundle.labels && bundle.labels[name];
    if (key != null && raw[key] != null) return key;
    return null;
  },

  /** Copy extracted objects / signs / coords onto map defs (Objects + Field read these). */
  // Lua: space.lua:164
  attachEventsToMaps(maps: any, bundle?: any): number {
    bundle = bundle ?? Space.bundle ?? Space.ensureBundle(null);
    if (!(maps && bundle && bundle.events)) return 0;
    let n = 0;
    for (const [mapId, ev] of pairs<any>(bundle.events)) {
      const def = maps[mapId];
      if (def && ev != null && typeof ev === "object") {
        // Deep-ish copy object rows so setobjectxy/removeobject cannot mutate the
        // shared script bundle for the rest of the session.
        if (ev.objects != null && typeof ev.objects === "object") {
          const objs: LuaTable = seq();
          for (const [i, row] of ipairs<any>(ev.objects)) {
            const copy: any = {};
            for (const [k, v] of pairs(row)) copy[k] = v;
            objs[i] = copy;
          }
          def.objects = objs;
        } else if (ev.objectEvents != null && typeof ev.objectEvents === "object" && !def.objects) {
          const objs: LuaTable = seq();
          for (const [i, row] of ipairs<any>(ev.objectEvents)) {
            const copy: any = {};
            for (const [k, v] of pairs(row)) copy[k] = v;
            objs[i] = copy;
          }
          def.objects = objs;
        }
        if ((mapId === "EM_ROUTE101" || mapId === "MAP_ROUTE101" || mapId === "ROUTE101") && def.objects) {
          for (const [, obj] of ipairs<any>(def.objects)) {
            const lid = tonumber(obj.localId ?? obj.index);
            if ((lid === 2 || lid === 4 || obj.flag === "FLAG_HIDE_ROUTE_101_BIRCH_ZIGZAGOON_BATTLE" || obj.flag === "FLAG_HIDE_ROUTE_101_ZIGZAGOON")
                && ((obj.x === 9 && obj.y === 13) || (obj.x === 10 && obj.y === 13))) {
              obj.x = -100;
              obj.y = -100;
            }
          }
        }
        if (ev.bgEvents != null && typeof ev.bgEvents === "object") def.bgEvents = ev.bgEvents;
        if (ev.coordEvents != null && typeof ev.coordEvents === "object") def.coordEvents = ev.coordEvents;
        if (ev.mapScripts != null && typeof ev.mapScripts === "object") def.mapScripts = ev.mapScripts;
        if (ev.music != null) def.music = ev.music;
        n = n + 1;
      }
    }
    return n;
  },

  // Lua: space.lua:222
  activate(mod: any, mapId: any, game?: any, world?: any): Vm {
    if (Space.active && Space.mapId === mapId) {
      return Space.vm!;
    }
    if (Space.active) {
      Space.deactivate(mod);
    }
    load_sidecar(mod, game);
    Flags.onMapLoad(Space.store);
    const bundle = Space.ensureBundle(mod);
    const adapters = Adapters.host(mod, game, world);
    adapters.lookupMovement = (key: any) => {
      if (typeof key === "string") return bundle.movements[key];
      return bundle.movements[tostring(key)];
    };
    adapters.lookupText = (key: any) => bundle.text[key];
    Space.vm = Vm.new({
      store: Space.store,
      scripts: bundle.scripts,
      text: bundle.text,
      movements: bundle.movements,
      adapters,
    });
    Space.vm._mod = mod;
    share_specials(Space.vm, resolve_session(mod, game));
    Space.active = true;
    Space.mapId = mapId;
    Space._mod = mod;
    if (adapters.clearMovements) adapters.clearMovements();
    return Space.vm;
  },

  // pokeemerald/src/overworld.c:784 LoadMapFromCameraTransition
  // Lua: space.lua:255
  retarget(mod: any, mapId: any, game?: any, world?: any): Vm {
    if (!(Space.active && Space.vm)) return Space.activate(mod, mapId, game, world);
    Space.mapId = mapId;
    return Space.vm;
  },

  // Lua: space.lua:261
  deactivate(mod?: any): void {
    if (Space.vm) {
      Space.vm.halt(Space.vm.isRunning());
    }
    persist_sidecar(mod ?? Space._mod);
    if (Space.store) {
      // specialVars live on ctx; already wiped by halt
    }
    if (Space._immediateVm) {
      if (Space._immediateVm.isRunning()) Space._immediateVm.halt(true);
      Space._immediateVm = null;
    }
    Space.vm = null;
    Space.active = false;
    Space.mapId = null;
  },

  // Lua: space.lua:278
  onMapEnter(mod: any, mapId: any, game?: any, world?: any, opts?: any): Vm | undefined {
    if (!MapIds.isGame3Map(mapId)) {
      if (Space.active) Space.deactivate(mod);
      return undefined;
    }
    const vm = Space.activate(mod, mapId, game, world);
    Space.runEnterScripts(mod, mapId, game, world, opts);
    return vm;
  },

  // Lua: space.lua:359
  runImmediately(nameOrKey: any): boolean {
    return run_immediately(Space.scriptKey(nameOrKey) ?? nameOrKey);
  },

  // pokefirered/src/script.c:448
  // Lua: space.lua:364
  runOnResume(mapId?: any): boolean {
    if (!Space.vm) return false;
    const ms = map_scripts(mapId);
    return run_immediately(ms && ms.onResume);
  },

  // pokefirered/src/script.c:479
  // Lua: space.lua:371
  runOnWarpIntoMap(mapId?: any): boolean {
    if (!Space.vm) return false;
    const ms = map_scripts(mapId);
    const key = check_script_table(ms && ms.onWarpIntoMap);
    if (!key) return false;
    const ran = run_immediately(key);
    // pokeemerald/src/overworld.c:2176
    if (ran && Profile.family(resolve_session(Space._mod, null)) !== "rse") Space.refreshObjectGraphics();
    return ran;
  },

  // pokefirered/src/script.c:453
  // Lua: space.lua:383
  runOnReturnToField(mapId?: any): boolean {
    if (!Space.vm) return false;
    const ms = map_scripts(mapId);
    return run_immediately(ms && ms.onReturnToField);
  },

  // pokeemerald/src/script.c:348
  // Lua: space.lua:390
  runOnDiveWarp(mapId?: any): boolean {
    if (!Space.vm) return false;
    const ms = map_scripts(mapId);
    return run_immediately(ms && ms.onDiveWarp);
  },

  // pokefirered/src/fieldmap.c:93
  // Lua: space.lua:397
  runOnLoad(mapId?: any): boolean {
    if (!Space.vm) return false;
    mapId = mapId ?? Space.mapId;
    const ev = Space.bundle && Space.bundle.events && Space.bundle.events[mapId];
    const ms = ev && ev.mapScripts;
    const key = ms && ms.onLoad;
    if (typeof key !== "string") return false;
    const vm = Space.vm;
    if (vm.isRunning()) return false;
    vm.start(key);
    for (let i = 1; i <= 256; i++) {
      if (!vm.isRunning()) break;
      vm.tick();
    }
    return true;
  },

  // pokeemerald/src/event_data.c:39
  // Lua: space.lua:418
  tempFieldEventFlags(session?: any): LuaTable {
    let names: any = Profile.forSession(session).map;
    names = names && names.tempFieldEventFlags;
    if (!names) return Space.TEMP_FIELD_EVENT_FLAGS;
    const ids = Flags.active(session).IDS;
    const out: LuaTable = seq();
    for (const [, name] of ipairs<string>(names)) {
      const id = ids[name];
      if (id == null) throw new Error("space: unknown temp field flag " + tostring(name));
      out[len(out) + 1] = id;
    }
    return out;
  },

  // pokefirered/src/overworld.c:762
  // pokefirered/src/overworld.c:797
  // Lua: space.lua:434
  clearTempFieldEventFlags(mod?: any, game?: any): void {
    const session = resolve_session(mod ?? Space._mod, game);
    const list = Space.tempFieldEventFlags(session);
    for (let i = 1; i <= len(list); i++) {
      const id = list[i];
      if (Space.store) Flags.setFlag(Space.store, null, id, false);
      if (session && session.flags) delete session.flags[id];
    }
  },

  /**
   * ON_TRANSITION + schedule ON_FRAME. Call only after Objects.loadMap for mapId
   * so setobjectxyperm / removeobject hit the destination map's localIds (pret order).
   */
  // Lua: space.lua:446
  runEnterScripts(mod: any, mapId?: any, game?: any, world?: any, opts?: any): Vm | undefined {
    if (!Space.vm) return undefined;
    opts = opts ?? {};
    mapId = mapId ?? Space.mapId;
    if (opts.enterVia !== "continue") {
      Space.clearTempFieldEventFlags(mod, game);
    }
    const ev = Space.bundle && Space.bundle.events && Space.bundle.events[mapId];
    if (!ev) return Space.vm;
    const vm = Space.vm;
    const ms = ev.mapScripts ?? {};
    if (opts.keepScript && vm.isRunning()) {
      // pokeemerald/src/overworld.c:807
      Space._inTransition = true;
      let ok = true, err: any;
      try {
        if (run_immediately(ms.onTransition)) Space.refreshObjectGraphics();
        // pokeemerald/src/fieldmap.c:62
        if (Profile.family(resolve_session(mod, game)) === "rse") {
          throw new Error("NOT FAITHFUL: Emerald only (rse.init secretBase.onMapLoad)");
        }
        const key = ms.onLoad;
        if (typeof key === "string") run_immediately(key);
      } catch (e) { ok = false; err = e; }
      Space._inTransition = false;
      if (!ok) throw err;
      Space.runOnResume(mapId);
      Space._pendingOnFrame = true;
      return vm;
    }
    // pokefirered/src/overworld.c:807
    // pokefirered/src/event_object_movement.c:1813
    Space._inTransition = true;
    let ok = true, err: any;
    try {
      if (ms.onTransition && typeof ms.onTransition === "string") {
        vm.start(ms.onTransition);
        // Drain short transition scripts so ON_FRAME can run this enter.
        for (let i = 1; i <= 64; i++) {
          if (!vm.isRunning()) break;
          vm.tick();
        }
        // VAR_OBJ_GFX_ID_* / setobjectxyperm applied -- refresh NPC sprites.
        Space.refreshObjectGraphics();
      }
      // pokeemerald/src/fieldmap.c:62
      if (Profile.family(resolve_session(mod, game)) === "rse") {
        throw new Error("NOT FAITHFUL: Emerald only (rse.init secretBase.onMapLoad)");
      }
      // pokefirered/src/fieldmap.c:93
      Space.runOnLoad(mapId);
    } catch (e) { ok = false; err = e; }
    Space._inTransition = false;
    if (!ok) throw err;
    // pokefirered/src/overworld.c:783
    Space.runOnResume(mapId);
    // pokefirered/src/overworld.c:2148
    if (!(opts.seamless || opts.enterVia === "continue")) {
      Space.runOnWarpIntoMap(mapId);
    }
    // ON_FRAME (Bill intro etc.) -- defer while Gen2 MAPSETUP is still white.
    if (!vm.isRunning()) {
      Space.scheduleOnFrame(world);
    } else {
      Space._pendingOnFrame = true;
      if (world && world.mapSetup) {
        Space._deferOnFrameForFade = true;
      }
    }
    return vm;
  },

  // Lua: space.lua:518
  scheduleOnFrame(world?: any): void {
    // Always defer ON_FRAME to the field loop. Running it synchronously from
    // Map.load/warp nests under the previous script; warp.finish then cleared
    // Objects tracks and soft-locked MeetCelio on waitmovement.
    Space._pendingOnFrame = true;
    Space._deferOnFrameForFade = (world && world.mapSetup) ? true : false;
  },

  // pokefirered/src/overworld.c:1943
  // Lua: space.lua:527
  returnToField(mapId?: any): boolean {
    if (!Space.active || !Space.vm) return false;
    mapId = mapId ?? Space.mapId;
    const a = Space.runOnResume(mapId);
    const b = Space.runOnReturnToField(mapId);
    return a || b;
  },

  // Lua: space.lua:535
  runOnFrame(): void {
    if (!Space.active || !Space.vm) return;
    const ev = Space.bundle && Space.bundle.events && Space.bundle.events[Space.mapId];
    const key = check_script_table(ev && ev.mapScripts && ev.mapScripts.onFrame);
    if (key) Space.vm.start(key);
  },

  /** Resolve graphics / graphicsVar -> sprite for object defs at spawn. */
  // Lua: space.lua:543
  resolveObjectSprite(obj: any): any {
    if (typeof obj.sprite === "string" && obj.sprite !== "") {
      return obj.sprite;
    }
    return GfxIds.spriteFor(Space.resolveObjectGraphicsId(obj));
  },

  /**
   * Resolve FRLG OBJ_EVENT_GFX id (honours graphicsVar + OBJ_EVENT_GFX_VAR_*).
   * pret: graphicsId >= 240 -> VarGetObjectEventGraphicsId(id - 240).
   */
  // Lua: space.lua:552
  resolveObjectGraphicsId(obj: any, neighbor?: any): number | null | undefined {
    if (!obj) return null;
    let graphics = tonumber(obj.graphics ?? obj.graphicsId);
    const store = (neighbor && neighbor.store) || Space.store || Flags.newStore();
    const ctx = (Space.vm && Space.vm.ctx) || Ctx.new();
    if (truthy(obj.graphicsVar)) {
      const v = Flags.getVar(store, ctx, obj.graphicsVar);
      if (typeof v === "number" && v !== 0) graphics = v;
    }
    if (graphics != null && graphics >= 240 && graphics <= 255) {
      const varId = Ctx.GFX_VAR_LO + (graphics - 240);
      if (neighbor && store.vars[varId] == null) return null;
      // src/event_object_movement.c:2043
      graphics = lmod(tonumber(Flags.getVar(store, ctx, varId)) ?? 0, 256);
    }
    let okP = true, P: any;
    try { P = Profile.forSession(null); } catch { okP = false; }
    const invalid = okP && P && P.field && P.field.invalidGfx;
    if (invalid) {
      const E = (Constants.of(P.id) as any).event_objects.byName;
      // pokeemerald/src/event_object_movement.c:1927
      if (graphics != null && graphics >= E.NUM_OBJ_EVENT_GFX) graphics = E[invalid];
      return graphics;
    }
    // src/event_object_movement.c:2045
    if (graphics != null && graphics >= 152) graphics = 16;
    return graphics;
  },

  // Lua: space.lua:628
  neighborObjectState(mapId: any): any {
    if (!mapId || mapId === Space.mapId) return null;
    let cache = Space._neighborState;
    if (!cache || cache.host !== Space.mapId || cache.store !== Space.store) {
      cache = { host: Space.mapId, store: Space.store, maps: {} };
      Space._neighborState = cache;
    }
    let st = cache.maps[mapId];
    if (st == null) {
      let ok = true, res: any;
      try { res = runNeighborTransition(mapId); } catch { ok = false; }
      st = (ok && res) || false;
      cache.maps[mapId] = st;
    }
    return st || null;
  },

  /** After ON_TRANSITION sets VAR_OBJ_GFX_ID_*, refresh spawned sprites. */
  // Lua: space.lua:645
  refreshObjectGraphics(): void {
    if (!(Objects && Objects.refreshGraphics)) return;
    Objects.refreshGraphics();
  },

  // Lua: space.lua:651
  objectVisible(obj: any): boolean {
    const flag = tonumber(obj && (obj.flag ?? obj.flagId));
    // pret: flag 0 / 0xFFFF = no hide flag (always visible).
    if (flag == null || flag === 0 || flag === 0xFFFF || flag === 65535) {
      return true;
    }
    const store = Space.store || Flags.newStore();
    return !Flags.getFlag(store, (Space.vm && Space.vm.ctx) || Ctx.new(), flag);
  },

  // Lua: space.lua:661
  startScript(scriptKey: any, localId?: any, facing?: any): boolean {
    if (!Space.vm) return false;
    if (!truthy(facing)) {
      // package.loaded["src.core.game3.player"]
      const P = Player;
      if (P && P.facing) {
        facing = FACING_DIRS[P.facing] ?? 1;
      }
    }
    if (truthy(facing) && Space.store && Space.vm.ctx) {
      Flags.setVar(Space.store, Space.vm.ctx, Ctx.VAR_FACING, facing);
    }
    if (truthy(localId)) {
      return Space.vm.startTalk(scriptKey, localId, facing);
    }
    // src/field_control_avatar.c:200
    return Space.vm.startTalk(scriptKey, 0, facing);
  },

  // Lua: space.lua:680
  install(mod: any): void {
    if (Space._installed) return;
    Space._installed = true;
    Space._mod = mod;
    Space.ensureBundle(mod);

    // lazyReq("src.world.OverworldController")
    const OCT: any = OC;

    // Map enter / leave: Gen1 loadMap; Gen2 facade/World setMap.
    if (!OCT._game3LoadMap) {
      const afterMap = (world: any, mapId: any): void => {
        const game = (world && world.game) || (mod.game);
        if (MapIds.isGame3Map(mapId)) {
          if (Runtime.ensureActiveForMap) {
            Runtime.ensureActiveForMap(mod, game, mapId);
          }
          // Map.load calls Space.onMapEnter directly (no host setMap). External
          // ferry/host setMap still lands here.
          Logger.info("[game3] Space.afterMap SEVII map=" + tostring(mapId)
            + " \xE2\x86\x92 Space.onMapEnter");
          Space.onMapEnter(mod, mapId, game, world);
        } else {
          if (Space.active) {
            Logger.info("[game3] Space.afterMap left Sevii \xE2\x86\x92 deactivate Space");
          }
          if (Runtime && Runtime.isActive && Runtime.isActive()) {
            Bridge.persistSessionOnly(mod, game);
            Runtime.stop(mod, game);
          }
          Space.deactivate(mod);
        }
      };
      if (typeof OCT.loadMap === "function") {
        const prev = OCT.loadMap;
        OCT.loadMap = function (self: any, mapId: any, ...rest: any[]) {
          const r = prev(self, mapId, ...rest);
          afterMap(self, mapId);
          return r;
        };
      }
      if (typeof OCT.setMap === "function") {
        const prev = OCT.setMap;
        OCT.setMap = function (a: any, b: any, ...rest: any[]) {
          const mapId = typeof a === "string" ? a : b;
          const r = prev(a, b, ...rest);
          const world = (a != null && typeof a === "object") ? a : null;
          afterMap(world, mapId);
          return r;
        };
      }
      // Direct Gen2 World:setMap (ferry/warps often skip the facade).
      const [ok, World] = pcallMissing("src.world.gen2.World") as [boolean, any];
      if (ok && World && World.setMap && !World._game3SetMap) {
        const prevW = World.setMap;
        World.setMap = function (self: any, mapId: any, ...rest: any[]) {
          const r = prevW(self, mapId, ...rest);
          afterMap(self, mapId);
          return r;
        };
        World._game3SetMap = true;
      }
      OCT._game3LoadMap = true;
    }

    if (!OCT._game3Talk) {
      const prevTalk = OCT.talkTo;
      OCT.talkTo = function (world: any, npc: any) {
        const mapId = world && world.map && world.map.id;
        // Only claim Sevii object talk; leave Gen2 host sailors (Vermilion Port
        // Fast Ship, etc.) to earlier OC.talkTo wrappers such as the ferry.
        if (Space.active && MapIds.isGame3Map(mapId)
            && npc && npc.def && npc.def.scriptKey) {
          if (world) {
            world.talkNpc = npc;
            if (world.freezeNpc) {
              world.freezeNpc(npc);
            } else {
              npc.frozen = true;
              world.frozeNpcs = true;
            }
            if (npc.facePlayer && world.player) {
              npc.facePlayer(world.player);
            }
          }
          const lid = npc.def.localId ?? npc.def.index ?? 0;
          let facingDir: number | undefined = undefined;
          if (world && world.player && world.player.facing) {
            facingDir = FACING_DIRS[world.player.facing];
          }
          Space.startScript(npc.def.scriptKey, lid, facingDir);
          return true;
        }
        if (typeof prevTalk === "function") {
          return prevTalk(world, npc);
        }
        return false;
      };
      OCT._game3Talk = true;
    }

    // Gen2 World:busy must see game3 scripts or frozeNpcs clears mid-dialog.
    {
      const [ok, World] = pcallMissing("src.world.gen2.World") as [boolean, any];
      if (ok && World && World.busy && !World._game3Busy) {
        const prevBusy = World.busy;
        World.busy = function (self: any) {
          if (prevBusy(self)) return true;
          if (Space.active && Space.vm && Space.vm.isRunning()) {
            return true;
          }
          return false;
        };
        World._game3Busy = true;
      }
      if (ok && World && World.step && !World._game3Step) {
        const prevStep = World.step;
        World.step = function (self: any, ...rest: any[]) {
          const r = prevStep(self, ...rest);
          // When Game3 Runtime owns the field loop it drives Vm:tick via Field.update.
          if (Runtime && Runtime.isActive && Runtime.isActive()) {
            return r;
          }
          if (Space.active && Space.vm) {
            // Advance FRLG cutscene walks even between script yields.
            const ad = Space.vm.adapters;
            if (ad && ad.pollMovement) {
              ad.pollMovement(0);
            }
            Space.vm.tick();
            // pokefirered/src/field_control_avatar.c:212
            // package.loaded["src.core.game3.field"]
            if (!Space.vm.isRunning()) {
              if (Space._deferOnFrameForFade && self.mapSetup) {
                // Still fading in from MAPSETUP.WARP; keep holding onFrame.
              } else if (Field && Field.callbackPending && Field.callbackPending()) {
                // pokefirered/src/overworld.c:1403
              } else {
                const claiming = Space._pendingOnFrame;
                Space._pendingOnFrame = false;
                Space._deferOnFrameForFade = false;
                if (claiming || !(Field && Field.locked)) {
                  Space.runOnFrame();
                  if (claiming && !Space.vm.isRunning()) {
                    if (Field && Field.unlock) Field.unlock();
                  }
                }
              }
            }
          }
          return r;
        };
        World._game3Step = true;
      }
    }

    // Signs / bgEvents from extracted event tables; then collision-std (MB_PC etc.).
    // When game3 Runtime is active, Field.interact owns A-button; skip host path.
    if (!OCT._game3Interact) {
      const prevInteract = OCT.interact;
      OCT.interact = function (world: any) {
        if (Runtime && Runtime.isActive && Runtime.isActive()) {
          return false;
        }
        if (Space.active && world && world.player) {
          const p = world.player;
          const Map = world.map;
          const delta: Record<string, [number, number]> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
          const d = delta[p.facing] ?? delta.down;
          const fx = p.cellX + d[0], fy = p.cellY + d[1];
          const facingDir = FACING_DIRS[p.facing] ?? 1;

          // 1) Extracted bgEvents (signs / network machines from map event tables)
          if (world.bgEventAt) {
            const sign = world.bgEventAt(fx, fy);
            if (sign && sign.scriptKey) {
              Space.startScript(sign.scriptKey, null, facingDir);
              return true;
            }
          } else if (Map && Map.def && Map.def.bgEvents) {
            for (const [, ev] of ipairs<any>(Map.def.bgEvents)) {
              if (ev.x === fx && ev.y === fy && ev.scriptKey) {
                Space.startScript(ev.scriptKey, null, facingDir);
                return true;
              }
            }
          }

          // 2) Metatile-behavior std scripts (PC, ...) -- same idea as Gen2
          //    TILE_COLLISION_STD_SCRIPTS: applies wherever extract tagged MB_PC.
          let coll: any = null;
          if (Map && Map.cellCollision) {
            coll = Map.cellCollision(fx, fy);
          } else if (world.map && world.map.cellCollision) {
            coll = world.map.cellCollision(fx, fy);
          }
          const stdKey = CollisionStd.scriptFor(coll);
          if (stdKey) {
            Space.startScript(stdKey, null, facingDir);
            return true;
          }
        }
        if (typeof prevInteract === "function") {
          return prevInteract(world);
        }
        if (world && world.interactBody) {
          return world.interactBody();
        }
        return false;
      };
      OCT._game3Interact = true;
    }

    if (mod.events) {
      mod.events.on("game.save", () => {
        persist_sidecar(mod);
      });
    }
  },
};

// core/encounters.ts late binding (package.loaded scripting.space / flags).
// Getters, so an import cycle that reaches this file before flags.ts has
// finished (natives -> flags -> ... -> space) does not read Flags too early.
Object.defineProperty(Encounters.deps, "Space", { get: () => Space, enumerable: true, configurable: true });
Object.defineProperty(Encounters.deps, "Flags", { get: () => Flags, enumerable: true, configurable: true });

export default Space;
