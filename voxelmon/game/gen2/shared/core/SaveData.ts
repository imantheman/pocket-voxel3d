// gen1recomp src/core/SaveData.lua at bdfac727 (MIT), as the Gold engine
// uses it.
//
// SaveData.lua is two things: the shared options.lua (defaults, merge, the
// per-game mod flags, the read-modify-write) and Gen 1's own progress file
// plus the desktop launcher's slot/cart/portable-directory registry. The Gold
// engine reaches only for the first half, and for the meta stamp and the mod
// migration pass Game2 runs on every load (Game2.lua:213-319, :967). Those are
// ported here, line for line.
//
// The second half is inert on this build, the way docs/gold-engine.md treats
// desktop-only modules: there is one host save slot (platform/saveio.ts),
// no filesystem, no launcher, no cart registry, and Gen 1 never boots in the
// Gold engine. Its functions answer "none": no active slot (so core/Save.ts
// takes its single-file path, Save.lua:140-149), no cart, no portable root.
// Gen 1's core migrations (SaveData.lua:2114-2172) only run when
// GameVersion.generation() == 1 (SaveData.lua:2062), which this build never
// is, so they are not registered.

import { GameVersion } from "./GameVersion.ts";
import { Logger } from "./Logger.ts";
import { SaveSerializer } from "./SaveSerializer.ts";
import { format, truthy } from "../../platform/lua.ts";
import { now, osTime } from "../../platform/clock.ts";
import * as saveio from "../../platform/saveio.ts";

type Table = Record<string, any>;

// src/core/Version.lua:21,27 -- the two numbers SaveData stamps.
const VERSION = { engine: "0.0.0-dev", saveFormat: 5 };

// ------- Semver.compare (src/mods/Semver.lua:13-76), for runMigrations

interface Semver { major: number; minor: number; patch: number; pre?: string }

// Lua: Semver.lua:13-34
function semverParse(text: unknown): Semver | undefined {
  if (typeof text !== "string") return undefined;
  let body = text.trim().replace(/^[vV]/, "");
  const plus = body.indexOf("+");
  if (plus >= 0) body = body.slice(0, plus);
  const m = /^([^-]+)-?(.*)$/.exec(body);
  if (!m) return undefined;
  const core = m[1]!;
  let pre: string | undefined = m[2]!;
  if (/[^\d.]/.test(core) || core.startsWith(".") || core.endsWith(".") || core.includes("..")) return undefined;
  const nums = core.split(".").filter((p) => p !== "").map(Number);
  if (nums.length === 0 || nums.length > 3) return undefined;
  if (pre === "") pre = undefined;
  else if (!/^[\w.-]+$/.test(pre)) return undefined;
  return { major: nums[0]!, minor: nums[1] ?? 0, patch: nums[2] ?? 0, pre };
}

// Lua: Semver.lua:39-62
function comparePre(a?: string, b?: string): number {
  if (a === b) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  const left = a.split(".").filter((p) => p !== "");
  const right = b.split(".").filter((p) => p !== "");
  const count = Math.max(left.length, right.length);
  for (let i = 0; i < count; i++) {
    const x = left[i];
    const y = right[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x) ? Number(x) : undefined;
    const ny = /^\d+$/.test(y) ? Number(y) : undefined;
    if (nx !== undefined && ny !== undefined) {
      if (nx !== ny) return nx < ny ? -1 : 1;
    } else if (nx !== undefined) return -1;
    else if (ny !== undefined) return 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// Lua: Semver.lua:65-76
function semverCompare(a: unknown, b: unknown): number | undefined {
  const va = typeof a === "object" && a !== null ? (a as Semver) : semverParse(a);
  const vb = typeof b === "object" && b !== null ? (b as Semver) : semverParse(b);
  if (!va || !vb) return undefined;
  for (const field of ["major", "minor", "patch"] as const) {
    const x = va[field] ?? 0;
    const y = vb[field] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return comparePre(va.pre, vb.pre);
}

// ------- helpers

const isTable = (v: unknown): v is Table => v !== null && typeof v === "object";

// Lua: SaveData.lua:471-483
function deepCopy<T>(v: T, seen: Map<unknown, unknown> = new Map()): T {
  if (!isTable(v)) return v;
  if (seen.has(v)) return seen.get(v) as T;
  const copy: any = Array.isArray(v) ? [] : {};
  seen.set(v, copy);
  for (const k of Object.keys(v)) copy[k] = deepCopy((v as any)[k], seen);
  return copy;
}

// Lua: SaveData.lua:460-465, with options.lua's text coming from the seam.
function readOptionsTable(): [Table | undefined, string?] {
  const body = saveio.readOptions();
  if (typeof body !== "string") return [undefined, "no file: options.lua"];
  return SaveSerializer.decodeWithError(body);
}

// Lua: SaveData.lua:501-508 -- the decode cache, one slot (one options store).
const optionsCache = { rev: 0, atRev: -1, tree: undefined as Table | undefined };

// Lua: SaveData.lua:514 -- the cart being played; always nil on this build
// unless something calls setCart.
let activeCart: string | undefined;
let activeCartHash: string | undefined;
let sealBroken = false;

// Lua: SaveData.lua:516-520
function cartBucket(opts: unknown, cartId: string): Table | undefined {
  const root = isTable(opts) ? opts.cartOptions : undefined;
  const bucket = isTable(root) ? root[cartId] : undefined;
  return isTable(bucket) ? bucket : undefined;
}

// Lua: SaveData.lua:524-532
function applyCartOverlay<T>(opts: T): T {
  if (!(activeCart && isTable(opts))) return opts;
  const bucket = cartBucket(opts, activeCart);
  if (!bucket) return opts;
  for (const key of SaveData.CART_OPTION_KEYS) {
    if (bucket[key] != null) (opts as Table)[key] = bucket[key];
  }
  return opts;
}

// Lua: SaveData.lua:534-539
function cartGlobals(onDisk: unknown): Table {
  const out: Table = {};
  if (!isTable(onDisk)) return out;
  for (const key of SaveData.CART_OPTION_KEYS) out[key] = onDisk[key];
  return out;
}

// Lua: SaveData.lua:543-564
function splitCartOverlay(opts: Table, globals: Table, onDisk: unknown): Table {
  if (!(activeCart && isTable(opts))) return opts;
  const root: Table = {};
  const prior = isTable(onDisk) ? onDisk.cartOptions : undefined;
  if (isTable(prior)) for (const id of Object.keys(prior)) root[id] = deepCopy(prior[id]);
  const mine = isTable(opts.cartOptions) ? opts.cartOptions : {};
  for (const id of Object.keys(mine)) root[id] = mine[id];
  const bucket: Table = isTable(root[activeCart]) ? root[activeCart] : {};
  const defaults = SaveData.defaultOptions();
  for (const key of SaveData.CART_OPTION_KEYS) {
    if (opts[key] != null) bucket[key] = opts[key];
    let global = globals ? globals[key] : undefined;
    if (global == null) global = defaults[key];
    opts[key] = global;
  }
  root[activeCart] = bucket;
  opts.cartOptions = root;
  return opts;
}

// Lua: SaveData.lua:917-921
function cartKey(cartId: unknown): string | undefined {
  if (typeof cartId !== "string" || cartId.length > 64) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(cartId)) return undefined;
  return `cart_${cartId}`;
}

// Lua: SaveData.lua:848-850
function forcedGenerations(entry: unknown): number | undefined {
  return entry === true ? 2 : undefined;
}

// Lua: SaveData.lua:1754-1756
let playthroughSeq = 0;
function word(n: unknown): number {
  const v = Math.floor(Number(n) || 0);
  return ((v % 4294967296) + 4294967296) % 4294967296;
}

// Lua: SaveData.lua:2031-2036
interface CoreMigration { from: number; seq: number; fn: (save: Table) => void }
const coreMigrations: CoreMigration[] = [];

// Lua: SaveData.lua:2038-2045
function storedVersion(save: Table, modId: string): string | undefined {
  for (const entry of (save.meta && save.meta.mods) || []) {
    if (isTable(entry) && entry.id === modId) return entry.version;
  }
  return undefined;
}

// Lua: SaveData.lua:2047-2050
function semverLt(a: unknown, b: unknown): boolean {
  const order = semverCompare(a, b);
  return order !== undefined && order < 0;
}

const inert = (): undefined => undefined;

export const SaveData = {
  // ------- desktop filesystem, launcher and Gen 1 progress: inert (header)
  saveFilename: inert as (version?: string) => string | undefined,
  gameFolders: (): Table[] => [],
  _resetPortableCacheForTests: inert,
  isPortable: (): boolean => false,
  portableBaseDir: inert,
  portableFs: inert,
  /** Lua: SaveData.lua:256 -- no filesystem: core/Save.ts goes through platform/saveio.ts. */
  persistenceFs: inert as (fs?: unknown) => unknown,

  // Lua: SaveData.lua:262-411 -- port + original Options menu defaults.
  defaultOptions(): Table {
    return {
      textSpeed: 3,
      animations: true,
      battleStyle: "shift",
      battleLayout: "og",
      battleFit: "fixed",
      battleHud: "standard",
      battleBg: "white",
      uiLayout: "centered",
      ruleset: "gen1_faithful",
      musicVol: 7,
      sfxVol: 7,
      pikaVol: 7,
      musicFilter: 0,
      speedOverworld: 1,
      speedBattle: 1,
      speedMenu: 1,
      colors: "gbc",
      tilt: 0,
      zoom: 0,
      voidFill: "trees",
      uiLetterbox: "auto",
      videoMode: "windowed",
      faithfulRes: 0,
      screenPos: "center",
      fpsCap: 60,
      logicClock: "60",
      performance: "auto",
      pipelines: {},
      mods: {},
      safeMode: false,
      modsGen2: {},
      modsByVersion: {},
      modsByVersionMigrated: false,
      modProfiles: [],
      modProfilesSeeded: false,
      modUpdateCache: {},
      modIndexes: [],
      modIndexCache: {},
      touchControls: { enabled: true },
      haptics: "light",
      hotbar: true,
      dateFormat: "device",
      timeFormat: "device",
      saveSync: { enabled: false, lastSyncAt: 0, revs: {}, stamps: {}, pendingConflicts: [] },
      cartOptions: {},
      cartMods: {},
      cartOptionsSeeded: {},
    };
  },

  // Lua: SaveData.lua:414-415
  CART_OPTION_KEYS: ["animations", "battleStyle", "ruleset", "speedBattle", "speedMenu", "speedOverworld", "textSpeed"],

  // Lua: SaveData.lua:419-440 -- merge loaded keys over defaults (shallow).
  mergeOptions(loaded: unknown): Table {
    const opts = SaveData.defaultOptions();
    if (isTable(loaded)) {
      for (const k of Object.keys(loaded)) opts[k] = loaded[k];
      if (loaded.speed != null && loaded.speedOverworld == null && loaded.speedBattle == null && loaded.speedMenu == null) {
        opts.speedOverworld = loaded.speed;
        opts.speedBattle = loaded.speed;
        opts.speedMenu = loaded.speed;
      }
      delete opts.speed;
    }
    return opts;
  },

  // Lua: SaveData.lua:442-444
  isSafeMode(options: unknown): boolean {
    return isTable(options) && options.safeMode === true;
  },

  // Lua: SaveData.lua:446-450
  setSafeMode(options: unknown, enabled: unknown): boolean {
    if (!isTable(options)) return false;
    options.safeMode = enabled === true;
    return options.safeMode;
  },

  // Lua: SaveData.lua:452-454
  encode(data: unknown): string {
    return SaveSerializer.encode(data);
  },

  // Lua: SaveData.lua:456-458
  decode(str: unknown): any {
    return SaveSerializer.decode(str);
  },

  /**
   * Lua: SaveData.lua:569-683 -- the read-modify-write of options.lua. The
   * seam's write is all-or-nothing, so the .tmp/.bak witnesses and the
   * read-back verify (#828) collapse into its boolean; `fs` is ignored.
   */
  saveOptions(opts: unknown, _fs?: unknown): Table | undefined {
    const [onDisk] = readOptionsTable();
    const cartGlobalValues = cartGlobals(onDisk);
    applyCartOverlay(onDisk);
    let isFull = isTable(opts);
    if (isFull) {
      for (const k of Object.keys(SaveData.defaultOptions())) {
        if ((opts as Table)[k] == null) {
          isFull = false;
          break;
        }
      }
    }
    let merged: Table;
    if (!isFull) {
      merged = {};
      if (isTable(opts)) for (const k of Object.keys(opts)) merged[k] = opts[k];
      if (isTable(onDisk)) {
        for (const k of Object.keys(onDisk)) {
          if (k !== "modOptions" && merged[k] == null) merged[k] = deepCopy(onDisk[k]);
        }
      }
    } else merged = opts as Table;
    const out = SaveData.mergeOptions(merged);
    if (isTable(onDisk) && isTable(onDisk.modOptions)) {
      const mo: Table = {};
      for (const modId of Object.keys(onDisk.modOptions)) mo[modId] = onDisk.modOptions[modId];
      const mine: Table = out.modOptions || {};
      for (const modId of Object.keys(mine)) {
        const bucket = mine[modId];
        if (isTable(bucket) && isTable(mo[modId])) {
          for (const k of Object.keys(bucket)) mo[modId][k] = bucket[k];
        } else mo[modId] = bucket;
      }
      out.modOptions = mo;
    }
    splitCartOverlay(out, cartGlobalValues, onDisk);
    const encoded = SaveSerializer.encode(out);
    if (!saveio.writeOptions(encoded)) {
      Logger.error("options save failed: %s", "write refused");
      return undefined;
    }
    optionsCache.rev += 1;
    return applyCartOverlay(out);
  },

  // Lua: SaveData.lua:685-733 -- options.lua merged over defaults, a copy.
  loadOptions(_fs?: unknown): Table {
    if (optionsCache.atRev !== optionsCache.rev) {
      const [data, err] = readOptionsTable();
      if (!data) {
        if (saveio.readOptions() !== undefined) Logger.error("options load failed: %s", String(err));
        // (no .tmp/.bak witnesses to promote: the seam's write is atomic)
        optionsCache.tree = SaveData.defaultOptions();
      } else {
        optionsCache.tree = SaveData.mergeOptions(data);
      }
      optionsCache.atRev = optionsCache.rev;
    }
    return applyCartOverlay(deepCopy(optionsCache.tree!));
  },

  // Lua: SaveData.lua:735
  PER_VERSION_MODS: true,

  // Lua: SaveData.lua:739-742
  modScope(version?: string): string | undefined {
    if (SaveData.PER_VERSION_MODS) return version;
    return undefined;
  },

  // Lua: SaveData.lua:750-793
  migrateModEnablement(options: unknown, mods?: unknown[]): boolean {
    if (!isTable(options) || options.modsByVersionMigrated) return false;
    options.mods = isTable(options.mods) ? options.mods : {};
    options.modsByVersion = isTable(options.modsByVersion) ? options.modsByVersion : {};
    const known = new Map<string, Table>();
    for (const id of Object.keys(options.mods)) if (id !== "") known.set(id, { id });
    for (const version of Object.keys(options.modsByVersion)) {
      const bucket = options.modsByVersion[version];
      if (GameVersion.VERSIONS[version] && isTable(bucket)) {
        for (const id of Object.keys(bucket)) if (id !== "" && !known.has(id)) known.set(id, { id });
      }
    }
    for (const mod of mods || []) {
      const id = isTable(mod) ? mod.id : mod;
      if (typeof id === "string" && id !== "") {
        known.set(id, isTable(mod) ? mod : known.get(id) ?? { id });
      }
    }
    if (known.size === 0) return false;
    const order: string[] = (GameVersion as any).ORDER ?? Object.keys(GameVersion.VERSIONS);
    for (const [id, mod] of known) {
      let shared = options.mods[id];
      if (typeof shared !== "boolean") shared = !(mod.experimental === true);
      for (const version of order) {
        let bucket = options.modsByVersion[version];
        if (!isTable(bucket)) {
          bucket = {};
          options.modsByVersion[version] = bucket;
        }
        if (typeof bucket[id] !== "boolean") bucket[id] = shared;
      }
    }
    options.modsByVersionMigrated = true;
    return true;
  },

  // Lua: SaveData.lua:798-809
  modEnabled(options: unknown, id: string, version?: string): boolean | undefined {
    const byVersion = isTable(options) ? options.modsByVersion : undefined;
    const bucket = version && isTable(byVersion) ? byVersion[version] : undefined;
    if (isTable(bucket) && typeof bucket[id] === "boolean") return bucket[id];
    const shared = isTable(options) ? options.mods : undefined;
    if (isTable(shared) && typeof shared[id] === "boolean") return shared[id];
    return undefined;
  },

  // Lua: SaveData.lua:814-834
  setModEnabled(options: unknown, id: unknown, enabled: unknown, version?: string): unknown {
    if (!isTable(options) || typeof id !== "string" || id === "") return options;
    const on = truthy(enabled);
    if (!version) {
      options.mods = options.mods || {};
      options.mods[id] = on;
      return options;
    }
    options.modsByVersion = options.modsByVersion || {};
    const bucket = options.modsByVersion[version] || {};
    options.modsByVersion[version] = bucket;
    const shared = options.mods && options.mods[id];
    if (typeof shared === "boolean" && shared === on) delete bucket[id];
    else bucket[id] = on;
    return options;
  },

  // Lua: SaveData.lua:852-867
  modForced(options: unknown, id: string, version?: string, generation?: number): boolean {
    const entry = isTable(options) && isTable(options.modsGen2) ? options.modsGen2[id] : undefined;
    if (entry == null || entry === false) return false;
    const gen = generation ?? (version ? GameVersion.generation(version) : undefined);
    const legacy = forcedGenerations(entry);
    if (legacy !== undefined) return legacy === gen;
    if (!isTable(entry)) return false;
    if (version) return entry[version] === true;
    for (const id2 of Object.keys(entry)) {
      if (entry[id2] === true && GameVersion.generation(id2) === gen) return true;
    }
    return false;
  },

  // Lua: SaveData.lua:872-891
  setModForced(options: unknown, id: unknown, forced: unknown, version?: string): boolean {
    if (!isTable(options) || typeof id !== "string" || id === "") return false;
    if (!(version && GameVersion.VERSIONS[version])) return false;
    options.modsGen2 = options.modsGen2 || {};
    let entry = options.modsGen2[id];
    if (!isTable(entry)) {
      const expanded: Table = {};
      if (forcedGenerations(entry) !== undefined) {
        const order: string[] = (GameVersion as any).ORDER ?? Object.keys(GameVersion.VERSIONS);
        for (const other of order) if (GameVersion.generation(other) === 2) expanded[other] = true;
      }
      entry = expanded;
      options.modsGen2[id] = entry;
    }
    if (truthy(forced)) entry[version] = true;
    else delete entry[version];
    if (Object.keys(entry).length === 0) delete options.modsGen2[id];
    return true;
  },

  // ------- save slots and carts (SaveData.lua:893-1750): no launcher, one
  // host slot. Every "which slot" answers none, so Save.lua's flat path runs.
  slotSummary: inert as (save?: unknown) => Table | undefined,
  slotDiskPath: inert as (version?: string, slotId?: unknown) => string | undefined,
  listSlots: (_version?: string): Table[] => [],
  readSlotSource: inert as (...a: unknown[]) => string | undefined,
  renameSlot: (..._a: unknown[]): boolean => false,
  setActiveSlot: (..._a: unknown[]): boolean => false,
  createSlot: inert as (version?: string) => string | undefined,
  activeSlot: inert as (version?: string) => string | undefined,
  writeSlot: (..._a: unknown[]): boolean => false,
  deleteSlot: (..._a: unknown[]): boolean => false,
  refreshSlotResolution: inert as (scope?: string) => undefined,
  resetSlotState: inert,

  // Lua: SaveData.lua:1495-1503
  setCart(cartId?: unknown, cartHash?: unknown): string | undefined {
    if (cartId != null && cartKey(cartId)) {
      activeCart = cartId as string;
      activeCartHash = typeof cartHash === "string" && cartHash !== "" ? cartHash : undefined;
    } else {
      activeCart = undefined;
      activeCartHash = undefined;
    }
    return activeCart;
  },

  // Lua: SaveData.lua:1505-1507
  getCart(): string | undefined {
    return activeCart;
  },

  cartModEnabled: inert as (...a: unknown[]) => boolean | undefined,
  setCartModEnabled: (..._a: unknown[]): boolean => false,
  seedCartOptions: (..._a: unknown[]): boolean => false,

  // Lua: SaveData.lua:1556-1559
  setCartHash(cartHash?: unknown): string | undefined {
    activeCartHash = typeof cartHash === "string" && cartHash !== "" ? cartHash : undefined;
    return activeCartHash;
  },

  // Lua: SaveData.lua:1561-1563
  getCartHash(): string | undefined {
    return activeCartHash;
  },

  // Lua: SaveData.lua:1565-1572
  breakSeal(save?: unknown): boolean {
    sealBroken = true;
    if (isTable(save)) {
      save.meta = isTable(save.meta) ? save.meta : {};
      save.meta.sealBroken = true;
    }
    return true;
  },

  // Lua: SaveData.lua:1574-1579
  isSealBroken(save?: unknown): boolean {
    if (isTable(save)) return isTable(save.meta) && save.meta.sealBroken === true;
    return sealBroken;
  },

  listCartSlots: (_cartId?: unknown): Table[] => [],
  cartsWithSlots: (_fs?: unknown): string[] => [],
  readCartSlotSource: inert as (...a: unknown[]) => string | undefined,
  createCartSlot: inert as (cartId?: unknown) => string | undefined,
  setActiveCartSlot: (..._a: unknown[]): boolean => false,
  activeCartSlot: inert as (cartId?: unknown) => string | undefined,
  renameCartSlot: (..._a: unknown[]): boolean => false,
  deleteCartSlot: (..._a: unknown[]): boolean => false,
  writeCartSlot: (..._a: unknown[]): boolean => false,
  slotCartHash: inert as (...a: unknown[]) => string | undefined,
  setSlotCartHash: (..._a: unknown[]): boolean => false,
  slotSealBroken: (..._a: unknown[]): boolean => false,
  markSlotSealBroken: (..._a: unknown[]): boolean => false,
  adoptCartSeal: (..._a: unknown[]): boolean => false,

  /**
   * Lua: SaveData.lua:1758-1765 -- four hex words: time, clock, a table
   * address, a sequence. JS has no table addresses; that word is a random
   * 32-bit value in its place.
   */
  newPlaythroughId(): string {
    playthroughSeq += 1;
    const addressLo = Math.floor(Math.random() * 4294967296);
    const clock = Math.floor(now() * 1000000);
    return format("%08x%08x%08x%08x", word(osTime()), word(clock), word(addressLo), word(playthroughSeq));
  },

  // The playthrough-id registry lives in the launcher's slot table
  // (SaveData.lua:1767-1933): nothing to remember it in here.
  ensurePlaythroughId: (save?: unknown): string | undefined => (isTable(save) && isTable(save.meta) ? save.meta.playthroughId : undefined),
  slotPlaythroughId: inert as (...a: unknown[]) => string | undefined,
  cartSlotPlaythroughId: inert as (...a: unknown[]) => string | undefined,
  selectedPlaythroughId: inert as (...a: unknown[]) => string | undefined,
  selectedNormalSaveInfo: inert as (...a: unknown[]) => Table | undefined,

  // Lua: SaveData.lua:1941-1970 -- the version/engine/mod-set stamp.
  buildMeta(mods?: Table[] | null, previous?: unknown, sessionStart?: unknown): Table {
    let list: Table[];
    if (mods != null) {
      list = [];
      for (const mod of mods) list.push({ id: mod.id, version: mod.version, api: mod.api });
      list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    } else {
      list = (isTable(previous) && previous.mods) || [];
    }
    let started: number | undefined = typeof sessionStart === "number" ? sessionStart : sessionStart != null ? Number(sessionStart) : undefined;
    if (started === undefined || Number.isNaN(started) || started <= 0 || started === Infinity) {
      started = isTable(previous) && previous.sessionStart != null ? Number(previous.sessionStart) : undefined;
    }
    const savedAt = osTime();
    if (started !== undefined && started > savedAt) started = savedAt;
    const prev = isTable(previous) ? previous : undefined;
    return {
      format: VERSION.saveFormat,
      engine: VERSION.engine,
      savedAt,
      sessionStart: started,
      playthroughId: prev ? prev.playthroughId : undefined,
      cartId: prev ? prev.cartId : undefined,
      cartHash: prev ? prev.cartHash : undefined,
      sealBroken: (prev && prev.sealBroken === true) || undefined,
      mods: list,
    };
  },

  // Lua: SaveData.lua:1975-1997 -- {added, removed, changed}.
  modsDiff(save: Table, activeMods?: Table[]): { added: string[]; removed: string[]; changed: Table[] } {
    const stored = new Map<string, string>();
    for (const entry of (save.meta && save.meta.mods) || []) {
      if (isTable(entry) && entry.id) stored.set(entry.id, entry.version || "");
    }
    const diff = { added: [] as string[], removed: [] as string[], changed: [] as Table[] };
    for (const mod of activeMods || []) {
      const was = stored.get(mod.id);
      if (was === undefined) diff.added.push(mod.id);
      else if (was !== mod.version) diff.changed.push({ id: mod.id, from: was, to: mod.version });
      stored.delete(mod.id);
    }
    for (const id of stored.keys()) diff.removed.push(id);
    diff.added.sort();
    diff.removed.sort();
    diff.changed.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return diff;
  },

  // Lua: SaveData.lua:2002-2023
  modsDiffNotice(diff: unknown, meta?: unknown): string | undefined {
    if (!isTable(diff)) return undefined;
    const removed = (diff.removed || []).length;
    const changed = (diff.changed || []).length;
    const added = (diff.added || []).length;
    if (removed === 0 && changed === 0 && added === 0) return undefined;
    const wrote = ((isTable(meta) && meta.mods) || []).length;
    const parts: string[] = [];
    if (removed > 0) parts.push(`${removed}${removed === 1 ? " is" : " are"} no longer active`);
    if (changed > 0) parts.push(`${changed} changed version`);
    if (added > 0) parts.push(`${added} newly active`);
    return format("This save was made with %d mod%s; %s", wrote, wrote === 1 ? "" : "s", parts.join(", "));
  },

  // Lua: SaveData.lua:2033-2036
  addCoreMigration(fromFormat: number, fn: (save: Table) => void): void {
    coreMigrations.push({ from: fromFormat, seq: coreMigrations.length + 1, fn });
  },

  // Lua: SaveData.lua:2052-2106
  runMigrations(save: Table, modChains?: Table | null, activeMods?: Table[]): Table {
    coreMigrations.sort((a, b) => (a.from !== b.from ? a.from - b.from : a.seq - b.seq));
    const fmt = (save.meta && save.meta.format) || 1;
    if (GameVersion.generation() === 1) {
      for (const m of coreMigrations) if (m.from >= fmt) m.fn(save);
    }
    save.meta = save.meta || { mods: [] };
    save.meta.format = VERSION.saveFormat;
    for (const active of activeMods || []) {
      const modSave = save.modData && save.modData[active.id];
      const recorded = modChains && modChains[active.id];
      if (modSave && recorded) {
        const chain: Table[] = [...recorded];
        chain.sort((a, b) => (semverLt(a.since, b.since) ? -1 : semverLt(b.since, a.since) ? 1 : 0));
        const stored = storedVersion(save, active.id) || "0.0.0";
        for (const m of chain) {
          if (semverLt(stored, m.since) && !semverLt(active.version, m.since)) {
            try {
              m.apply(modSave, save);
            } catch (err) {
              Logger.error("[%s] migration %s: %s -- skipped", active.id, String(m.since), String(err));
              break;
            }
          }
        }
      }
    }
    return save;
  },

  // Lua: SaveData.lua:2174-2178 (rememberPlaythroughId is the launcher's
  // registry, SaveData.lua:1774; it passes the options through here).
  saveLiveOptions(data: unknown): Table | undefined {
    if (!isTable(data) || !isTable(data.options)) return undefined;
    return SaveData.saveOptions(data.options);
  },

  // ------- Gen 1's progress file (SaveData.lua:2186-2680): Gen 1 SRAM
  // shapes; the Gold engine saves through core/Save.ts. Inert.
  save: (..._a: unknown[]): boolean => false,
  load: inert as (version?: string) => Table | undefined,
  validate: (_save?: unknown, _data?: unknown): Table => ({}),
  emptyReport: (_report?: unknown): boolean => true,
  defaultHeal: inert as (boot?: unknown) => unknown,
  applyPostGameHome: inert as (save?: unknown, boot?: unknown) => unknown,
  repairTradedOtIds: inert as (save?: unknown) => unknown,
  needsPostGameRescue: (_save?: unknown): boolean => false,
  newGame: inert as (boot?: unknown) => Table | undefined,
};

export default SaveData;
