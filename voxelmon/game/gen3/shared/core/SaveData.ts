// Port of gen1recomp src/core/SaveData.lua (GPLv3 + additional terms; see LICENSE.md).
// Save/load via love.filesystem. Game progress lives in a save slot
// (saves/<version>/slotN.lua, or the flat legacy save_<suffix>.lua);
// options live in options.lua so they survive New Game. Both are plain Lua
// tables serialized as Lua source (deterministic key order) and read back
// through SaveSerializer's data-only parser, so a save can never execute
// code. Files go through platform/fs.ts, whose writes land in the save store
// (platform/savefs.ts: the SD card on the 3DS, memory in tests).
//
// Ported (the surface the FireRed runtime uses, plus what it calls):
// saveFilename, persistenceFs, defaultOptions, CART_OPTION_KEYS,
// mergeOptions, isSafeMode, setSafeMode, encode, decode, saveOptions,
// loadOptions, the slot registry (setActiveSlot, activeSlot, createSlot,
// deleteSlot, refreshSlotResolution, resetSlotState, with the lazy legacy
// migration and disk-slot recovery), the opaque playthrough id
// (newPlaythroughId, ensurePlaythroughId, selectedPlaythroughId), buildMeta,
// modsDiff, modsDiffNotice, addCoreMigration, runMigrations, rollTrainerId,
// saveLiveOptions, save, load.
//
// Left out (Gen 1/2, launcher, save-editor or mod-manager only; none is
// called from gen3): portable mode (gameFolders, portableStatus, isPortable,
// portableBaseDir, portableFs and the Win32/POSIX FFI natives openNative /
// removeNative / statNative / mkdirNative / listNative -- the 3DS has one
// save root, so persistenceFs never reroutes), per-game mod enablement
// (modScope, migrateModEnablement, modEnabled, setModEnabled, modOrder,
// setModOrder, modForced, setModForced), slotSummary, slotDiskPath,
// listSlots, readSlotSource, renameSlot, writeSlot, custom carts and seals
// (setCart .. adoptCartSeal; the active cart stays nil, so the cart overlay
// paths below are inert), slotPlaythroughId, cartSlotPlaythroughId,
// selectedNormalSaveInfo, saveLiveOptions' Gen 2 branch, and the Gen 1
// validation / quarantine pass (validate, emptyReport, defaultHeal,
// applyPostGameHome, repairTradedOtIds, needsPostGameRescue, newGame).
// The Gen 1 core migrations (trainer id, Snorlax flags, options move, box
// shape, version tag, Game Corner grunt, OT repair) run only when
// GameVersion.generation() == 1, so they are not registered here.
//
// Save bytes go through SaveSerializer.ts (src/core/SaveSerializer.lua),
// which keeps Lua's number/string key distinction so a save stays
// byte-compatible with gen1recomp both ways.

import { Fs, type FileInfo } from "../../platform/fs.ts";
import { Logger } from "./Logger.ts";
import { SaveSerializer } from "./SaveSerializer.ts";
import { GameVersion } from "./GameVersion.ts";
import { format, tonumber, tostring } from "../../../../import/gen3/lua.ts";
import { insert, ipairs, isEmpty, len, pairs, remove as tremove, sort } from "../../platform/lt.ts";
import { osTime } from "../../../gen2/platform/clock.ts";
import { random } from "../../platform/rng.ts";
import { getTime } from "../../platform/timer.ts";
import { hasHost } from "../../platform/host.ts";
import { saveStore } from "../../platform/savefs.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** A love.filesystem-shaped filesystem (platform/fs.ts, or one a test injects). */
export interface PersistFs {
  read(name: string): string | undefined;
  getInfo(name: string, filter?: "file" | "directory"): FileInfo | undefined;
  write(name: string, data: string): boolean | [boolean, string?];
  remove?(name: string): boolean;
  createDirectory?(name: string): boolean;
  getDirectoryItems?(dir: string): string[];
}

// src/core/Version.lua: saveFormat and engine (that module is not part of this runtime)
const VERSION_SAVE_FORMAT = 5;
const VERSION_ENGINE = "0.0.0-dev";

// ------------------------------------------------------------ SaveData

// Lua: SaveData.lua:31
const OPTIONS_FILENAME = "options.lua";
const OPTIONS_BACKUP_FILENAME = OPTIONS_FILENAME + ".bak";
const OPTIONS_TMP_FILENAME = OPTIONS_FILENAME + ".tmp";

function fsWrite(fs: PersistFs, name: string, data: string): [boolean, string?] {
  const r = fs.write(name, data);
  if (Array.isArray(r)) return [r[0] === true, r[1]];
  return [r === true];
}

// Lua: SaveData.lua:555 -- portable mode never applies here, so an injected fs wins, else love.filesystem
function persistFs(fs?: PersistFs): PersistFs {
  return fs || (Fs as PersistFs);
}

// Lua: SaveData.lua:768 -- [table] or [undefined, err]
function readTable(fs: PersistFs, name: string): [any, string?] {
  if (!fs.getInfo(name)) return [undefined, "no file: " + name];
  const body = fs.read(name);
  if (typeof body !== "string") return [undefined, "unreadable: " + name];
  return SaveSerializer.decode(body);
}

// Lua: SaveData.lua:779
function deepCopy(v: any, seen?: Map<any, any>): any {
  if (v == null || typeof v !== "object") return v;
  const memo = seen || new Map();
  if (memo.has(v)) return memo.get(v);
  const copy: any = Array.isArray(v) ? [] : {};
  memo.set(v, copy);
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) copy[i] = deepCopy(v[i], memo);
  } else {
    for (const k of Object.keys(v)) {
      const val = v[k];
      if (val != null) copy[k] = deepCopy(val, memo);
    }
  }
  return copy;
}

// Lua: SaveData.lua:793
function remove(fs: PersistFs, name: string): void {
  if (fs.remove) fs.remove(name);
}

// Lua: SaveData.lua:807
const optionsCache = new WeakMap<object, { rev: number; atRev: number; tree: any }>();

// Lua: SaveData.lua:809
// The cache is keyed by the filesystem; for platform/fs.ts that is the save
// store behind it, so a store swapped in (tests) never sees another's options.
function optionsCacheSlot(fs: PersistFs): { rev: number; atRev: number; tree: any } {
  const key: object = fs === (Fs as PersistFs) ? saveStore() : fs;
  let slot = optionsCache.get(key);
  if (!slot) {
    slot = { rev: 0, atRev: -1, tree: undefined };
    optionsCache.set(key, slot);
  }
  return slot;
}

// Lua: SaveData.lua:822 -- the cart being played; SaveData.setCart (not ported) owns it, so it stays nil
const activeCart: string | undefined = undefined;
const activeCartHash: string | undefined = undefined;

// Lua: SaveData.lua:824
function cartBucket(opts: any, cartId: string): any {
  const root = opts != null && typeof opts === "object" ? opts.cartOptions : undefined;
  const bucket = root != null && typeof root === "object" ? root[cartId] : undefined;
  return bucket != null && typeof bucket === "object" ? bucket : undefined;
}

// Lua: SaveData.lua:832
function applyCartOverlay(opts: any): any {
  if (!(activeCart && opts != null && typeof opts === "object")) return opts;
  const bucket = cartBucket(opts, activeCart);
  if (!bucket) return opts;
  for (const [, key] of ipairs<string>(SaveData.CART_OPTION_KEYS)) {
    if (bucket[key] != null) opts[key] = bucket[key];
  }
  return opts;
}

// Lua: SaveData.lua:842
function cartGlobals(onDisk: any): Record<string, any> {
  const out: Record<string, any> = {};
  if (onDisk == null || typeof onDisk !== "object") return out;
  for (const [, key] of ipairs<string>(SaveData.CART_OPTION_KEYS)) out[key] = onDisk[key];
  return out;
}

// Lua: SaveData.lua:851
function splitCartOverlay(opts: any, globals: Record<string, any>, onDisk: any): any {
  if (!(activeCart && opts != null && typeof opts === "object")) return opts;
  const root: Record<string, any> = {};
  const prior = onDisk != null && typeof onDisk === "object" ? onDisk.cartOptions : undefined;
  if (prior != null && typeof prior === "object") {
    for (const [id, bucket] of pairs(prior)) root[id] = deepCopy(bucket);
  }
  for (const [id, bucket] of pairs(opts.cartOptions != null && typeof opts.cartOptions === "object" ? opts.cartOptions : {})) {
    root[id] = bucket;
  }
  const bucket = root[activeCart] != null && typeof root[activeCart] === "object" ? root[activeCart] : {};
  const defaults = SaveData.defaultOptions();
  for (const [, key] of ipairs<string>(SaveData.CART_OPTION_KEYS)) {
    if (opts[key] != null) bucket[key] = opts[key];
    let global = globals ? globals[key] : undefined;
    if (global == null) global = defaults[key];
    opts[key] = global;
  }
  root[activeCart] = bucket;
  opts.cartOptions = root;
  return opts;
}

// ------- save slots (Lua: SaveData.lua:1233)
const activeSlotCache: Record<string, string | false | undefined> = {};
const slotsChecked: Record<string, boolean | undefined> = {};
let freshPlaythrough: any;

const CART_PREFIX = "cart_";
const sealBroken = false;

// Lua: SaveData.lua:1250
function isCartKey(key: string): boolean {
  return key.slice(0, CART_PREFIX.length) === CART_PREFIX;
}

// Lua: SaveData.lua:1254
function slotDir(key: string): string { return "saves/" + key; }

// Lua: SaveData.lua:1256
function valid_slot_id(id: unknown): boolean {
  return typeof id === "string" && /^slot\d+$/.test(id);
}

// Lua: SaveData.lua:1260 -- [main, bak, tmp] or []
function slotNames(key: string, id: unknown): [string, string, string] | [] {
  if (!valid_slot_id(id)) return [];
  const main = slotDir(key) + "/" + (id as string) + ".lua";
  return [main, main + ".bak", main + ".tmp"];
}

// Lua: SaveData.lua:1269
function legacyNames(key: string): [string, string, string] {
  const suffix = isCartKey(key) ? ("_" + key) : GameVersion.saveSuffix(key);
  const main = "save" + suffix + ".lua";
  return [main, main + ".bak", main + ".tmp"];
}

// Lua: SaveData.lua:1280
function knownVersion(version: string | undefined): boolean {
  return GameVersion.info(version) !== undefined;
}

// Lua: SaveData.lua:1284
function knownScope(key: unknown): boolean {
  if (typeof key !== "string" || key === "") return false;
  if (isCartKey(key)) return true;
  return knownVersion(key);
}

// Lua: SaveData.lua:1290
function activeScopeKey(version?: string): string {
  if (activeCart) return CART_PREFIX + activeCart;
  return version || GameVersion.get();
}

// Lua: SaveData.lua:1295
function registryOf(opts: any, key: string): any {
  let root = opts.saveSlots, id = key;
  if (isCartKey(key)) {
    root = opts.cartSlots;
    id = key.slice(CART_PREFIX.length);
  }
  if (root == null || typeof root !== "object") return undefined;
  const reg = root[id];
  return reg != null && typeof reg === "object" ? reg : undefined;
}

// Lua: SaveData.lua:1305
function putRegistry(opts: any, key: string, reg: any): void {
  if (isCartKey(key)) {
    opts.cartSlots = opts.cartSlots != null && typeof opts.cartSlots === "object" ? opts.cartSlots : {};
    opts.cartSlots[key.slice(CART_PREFIX.length)] = reg;
  } else {
    opts.saveSlots = opts.saveSlots != null && typeof opts.saveSlots === "object" ? opts.saveSlots : {};
    opts.saveSlots[key] = reg;
  }
}

// Lua: SaveData.lua:1319
function ensureParentDir(fs: PersistFs, name: string): void {
  const m = /^(.*)\/[^/]+$/.exec(name);
  if (m && fs.createDirectory) fs.createDirectory(m[1]!);
}

// Lua: SaveData.lua:1327
function decodeSlot(fs: PersistFs, key: string, id: string): any {
  const [main, bak, tmp] = slotNames(key, id);
  if (!main) return undefined;
  let data = fs.getInfo(main) ? SaveSerializer.decode(fs.read(main) ?? "")[0] : undefined;
  if (data) return data;
  data = fs.getInfo(tmp!) ? SaveSerializer.decode(fs.read(tmp!) ?? "")[0] : undefined;
  if (data) return data;
  data = fs.getInfo(bak!) ? SaveSerializer.decode(fs.read(bak!) ?? "")[0] : undefined;
  return data || undefined;
}

// Lua: SaveData.lua:1344
function tryMigrateLegacy(key: string, fs: PersistFs): string | undefined {
  const [lmain, lbak, ltmp] = legacyNames(key);
  const mainBody = fs.getInfo(lmain) ? fs.read(lmain) : undefined;
  const bakBody = fs.getInfo(lbak) ? fs.read(lbak) : undefined;
  if (!(mainBody || bakBody)) return undefined;
  const id = "slot1";
  const [dmain, dbak] = slotNames(key, id) as [string, string, string];
  ensureParentDir(fs, dmain);
  if (mainBody) fs.write(dmain, mainBody);
  if (bakBody) fs.write(dbak, bakBody);
  if (!decodeSlot(fs, key, id)) return undefined;
  remove(fs, lmain);
  remove(fs, lbak);
  remove(fs, ltmp);
  const opts = SaveData.loadOptions(fs);
  putRegistry(opts, key, { list: [null, id], active: id });
  const ids = opts.playthroughIds ? opts.playthroughIds[key] : undefined;
  if (ids != null && typeof ids === "object" && typeof ids.legacy === "string" && ids.legacy !== "") {
    if (typeof ids[id] !== "string" || ids[id] === "") ids[id] = ids.legacy;
    delete ids.legacy;
  }
  SaveData.saveOptions(opts, fs);
  return id;
}

// Lua: SaveData.lua:1377
function scanDiskSlots(key: string, fs: PersistFs | undefined): (string | null)[] | undefined {
  if (!fs) return undefined;
  const dir = slotDir(key);
  const slots: (string | null)[] = [null];
  if (fs.getDirectoryItems && fs.getInfo && fs.getInfo(dir)) {
    let items: string[] = [];
    try { items = fs.getDirectoryItems(dir); } catch { items = []; }
    const numbers: { id: string; num: number }[] = [];
    for (const item of items) {
      const m = /^(slot\d+)\.lua$/.exec(item);
      if (m) {
        const n = tonumber(/\d+/.exec(m[1]!)![0]);
        numbers.push({ id: m[1]!, num: n ?? 0 });
      }
    }
    // NOT FAITHFUL (ties only): JS's sort is stable, LuaJIT's is not; slot numbers are unique
    numbers.sort((a, b) => a.num - b.num);
    for (const item of numbers) insert(slots, item.id);
  } else {
    for (let i = 1; i <= 30; i++) {
      const slotId = "slot" + i;
      const path = dir + "/" + slotId + ".lua";
      if (fs.getInfo && fs.getInfo(path)) insert(slots, slotId);
    }
  }
  return len(slots) > 0 ? slots : undefined;
}

// Lua: SaveData.lua:1410
function ensureSlots(key: string, fs: PersistFs): void {
  if (slotsChecked[key]) return;
  slotsChecked[key] = true;
  if (!knownScope(key)) {
    activeSlotCache[key] = false;
    return;
  }
  const opts = SaveData.loadOptions(fs);
  const reg = registryOf(opts, key);
  if (reg && reg.list != null && typeof reg.list === "object" && len(reg.list) > 0) {
    activeSlotCache[key] = reg.active || reg.list[1];
    return;
  }
  const migrated = tryMigrateLegacy(key, fs);
  if (migrated) {
    activeSlotCache[key] = migrated;
    return;
  }
  const recovered = scanDiskSlots(key, fs);
  if (recovered && len(recovered) > 0) {
    putRegistry(opts, key, { list: recovered, active: recovered[1] });
    SaveData.saveOptions(opts, fs);
    activeSlotCache[key] = recovered[1]!;
    Logger.info("auto-recovered %d save slot(s) for %s from disk", len(recovered), key);
    return;
  }
  activeSlotCache[key] = false;
}

// Lua: SaveData.lua:1443 -- [main, bak, tmp]
function saveNames(version?: string, injectedFs?: PersistFs): [string, string, string] {
  const key = activeScopeKey(version);
  const fs = persistFs(injectedFs);
  ensureSlots(key, fs);
  const slot = activeSlotCache[key];
  if (slot) {
    const names = slotNames(key, slot);
    if (names.length === 3) return names;
  }
  return legacyNames(key);
}

// Lua: SaveData.lua:1693
function createSlotIn(key: string): string {
  const fs = persistFs(undefined);
  ensureSlots(key, fs);
  const opts = SaveData.loadOptions(fs);
  const reg = registryOf(opts, key) || { list: [null], active: undefined };
  reg.list = reg.list != null && typeof reg.list === "object" ? reg.list : [null];
  let maxN = 0;
  for (const [, id] of ipairs<string>(reg.list)) {
    const m = /^slot(\d+)$/.exec(tostring(id));
    const n = m ? tonumber(m[1]) : undefined;
    if (n !== undefined && n > maxN) maxN = n;
  }
  const id = "slot" + (maxN + 1);
  reg.list[len(reg.list) + 1] = id;
  putRegistry(opts, key, reg);
  SaveData.saveOptions(opts, fs);
  return id;
}

// Lua: SaveData.lua:1664
function setActiveSlotIn(key: string, slotId: string): string {
  const fs = persistFs(undefined);
  const opts = SaveData.loadOptions(fs);
  const reg = registryOf(opts, key) || { list: [null], active: undefined };
  reg.list = reg.list != null && typeof reg.list === "object" ? reg.list : [null];
  let found = false;
  for (const [, id] of ipairs(reg.list)) {
    if (id === slotId) { found = true; break; }
  }
  if (!found) reg.list[len(reg.list) + 1] = slotId;
  reg.active = slotId;
  putRegistry(opts, key, reg);
  SaveData.saveOptions(opts, fs);
  slotsChecked[key] = true;
  activeSlotCache[key] = slotId;
  return slotId;
}

// Lua: SaveData.lua:1721
function activeSlotIn(key: string): string | undefined {
  const fs = persistFs(undefined);
  ensureSlots(key, fs);
  return activeSlotCache[key] || undefined;
}

// Lua: SaveData.lua:1804 -- [ok, err]
function deleteSlotIn(key: string, slotId: unknown): [boolean, string?] {
  if (typeof slotId !== "string" || slotId === "") {
    return [false, "missing slot id"];
  }
  const fs = persistFs(undefined);
  ensureSlots(key, fs);
  const opts = SaveData.loadOptions(fs);
  const reg = registryOf(opts, key);
  if (!reg || reg.list == null || typeof reg.list !== "object") return [false, "slot not registered"];
  let found = false, idx: number | undefined;
  for (const [i, id] of ipairs(reg.list)) {
    if (id === slotId) { found = true; idx = i; break; }
  }
  if (!found) return [false, "slot not registered"];

  const [main, bak, tmp] = slotNames(key, slotId);
  if (!main) return [false, "invalid slot id"];
  remove(fs, main);
  remove(fs, bak!);
  remove(fs, tmp!);
  remove(fs, slotDir(key) + "/" + slotId + ".cart");

  tremove(reg.list, idx);
  if (reg.names) delete reg.names[slotId];
  if (reg.hashes) {
    delete reg.hashes[slotId];
    if (isEmpty(reg.hashes)) delete reg.hashes;
  }
  if (reg.broken) {
    delete reg.broken[slotId];
    if (isEmpty(reg.broken)) delete reg.broken;
  }
  if (reg.active === slotId) {
    reg.active = reg.list[1] ?? undefined;
    if (reg.active === undefined) delete reg.active;
  }
  putRegistry(opts, key, reg);
  const ids = opts.playthroughIds != null && typeof opts.playthroughIds === "object" ? opts.playthroughIds[key] : undefined;
  if (ids != null && typeof ids === "object") {
    delete ids[slotId];
    if (isEmpty(ids)) delete opts.playthroughIds[key];
    if (isEmpty(opts.playthroughIds)) delete opts.playthroughIds;
  }
  SaveData.saveOptions(opts, fs);
  slotsChecked[key] = true;
  activeSlotCache[key] = reg.active || false;
  return [true];
}

// Lua: SaveData.lua:2120
function stampActiveCartHash(fs: PersistFs): void {
  if (!(activeCart && activeCartHash)) return;
  const key = CART_PREFIX + activeCart;
  const slot = activeSlotCache[key];
  if (typeof slot !== "string") return;
  const opts = SaveData.loadOptions(fs);
  const reg = registryOf(opts, key);
  if (!reg || reg.list == null || typeof reg.list !== "object") return;
  reg.hashes = reg.hashes != null && typeof reg.hashes === "object" ? reg.hashes : {};
  if (reg.hashes[slot] === activeCartHash) return;
  reg.hashes[slot] = activeCartHash;
  putRegistry(opts, key, reg);
  SaveData.saveOptions(opts, fs);
}

// Lua: SaveData.lua:2142
let playthroughSeq = 0;

// Lua: SaveData.lua:2144
function word(n: unknown): number {
  const v = tonumber(n) ?? 0;
  const f = Math.floor(v);
  return ((f % 4294967296) + 4294967296) % 4294967296;
}

// os.clock (process seconds): the platform timer when a host is bound
function osClock(): number {
  return hasHost() ? getTime() : 0;
}

// Lua: SaveData.lua:2157 -- [scope, key]
function playthroughScope(version?: string, injectedFs?: PersistFs): [string, string] {
  const key = activeScopeKey(version);
  const fs = persistFs(injectedFs);
  ensureSlots(key, fs);
  return [activeSlotCache[key] || "legacy", key];
}

// Lua: SaveData.lua:2164 -- [opts, changed]
function rememberPlaythroughId(save: any, optsIn?: any, injectedFs?: PersistFs): [any, boolean] {
  let opts = optsIn;
  const version = save != null && typeof save === "object" ? save.version || GameVersion.get() : GameVersion.get();
  const [scope, key] = playthroughScope(version, injectedFs);
  const persisted = SaveData.loadOptions(injectedFs);
  if (opts) {
    opts.saveSlots = deepCopy(persisted.saveSlots);
    opts.cartSlots = deepCopy(persisted.cartSlots);
    opts.playthroughIds = deepCopy(persisted.playthroughIds);
  } else {
    opts = persisted;
  }
  const meta = save != null && typeof save === "object" ? save.meta : undefined;
  const id = meta != null && typeof meta === "object" ? meta.playthroughId : undefined;
  if (typeof id !== "string" || id === "") {
    const byVersion = opts.playthroughIds ? opts.playthroughIds[key] : undefined;
    const mapped = byVersion ? byVersion[scope] : undefined;
    if (meta != null && typeof meta === "object" && typeof mapped === "string" && mapped !== "") {
      meta.playthroughId = mapped;
    }
    return [opts, false];
  }
  opts.playthroughIds = opts.playthroughIds || {};
  opts.playthroughIds[key] = opts.playthroughIds[key] || {};
  const changed = opts.playthroughIds[key][scope] !== id;
  opts.playthroughIds[key][scope] = id;
  return [opts, changed];
}

// Lua: SaveData.lua:2422
const coreMigrations: ({ from: number; seq: number; fn: (save: any) => void } | null)[] = [null];

// Lua: SaveData.lua:2429
function storedVersion(save: any, modId: string): string | undefined {
  for (const [, entry] of ipairs<any>((save.meta && save.meta.mods) || [null])) {
    if (entry != null && typeof entry === "object" && entry.id === modId) {
      return entry.version;
    }
  }
  return undefined;
}

// Lua: SaveData.lua:2438
// NOT FAITHFUL: src.mods.Semver is not part of this runtime; this compares
// the numeric major.minor.patch only (no pre-release precedence). It is
// reached only by mod migration chains, and no mod ever loads here.
function semverLt(a: unknown, b: unknown): boolean {
  const parse = (s: unknown): number[] | undefined => {
    if (typeof s !== "string") return undefined;
    const m = /^\s*[vV]?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(s);
    return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : undefined;
  };
  const va = parse(a), vb = parse(b);
  if (!va || !vb) return false;
  for (let i = 0; i < 3; i++) if (va[i] !== vb[i]) return va[i]! < vb[i]!;
  return false;
}

// Lua: SaveData.lua:2485
function rollTrainerId(): number {
  return random(0, 65535);
}

export const SaveData = {
  // Lua: SaveData.lua:53
  saveFilename(version?: string): string {
    const [main] = saveNames(version);
    return main;
  },

  // Lua: SaveData.lua:565
  persistenceFs(fs?: PersistFs): PersistFs {
    return persistFs(fs);
  },

  // Lua: SaveData.lua:571
  defaultOptions(): Record<string, any> {
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
      modProfiles: {},
      modProfilesSeeded: false,
      modOrder: {},
      modUpdateCache: {},
      modIndexes: {},
      modIndexCache: {},
      touchControls: { enabled: true },
      haptics: "light",
      hotbar: true,
      dateFormat: "device",
      timeFormat: "device",
      saveSync: { enabled: false, lastSyncAt: 0, revs: {}, stamps: {}, pendingConflicts: {} },
      cartOptions: {},
      cartMods: {},
      cartOptionsSeeded: {},
    };
  },

  // Lua: SaveData.lua:722
  CART_OPTION_KEYS: [null, "animations", "battleStyle", "ruleset",
    "speedBattle", "speedMenu", "speedOverworld", "textSpeed"] as (string | null)[],

  // Lua: SaveData.lua:727
  mergeOptions(loaded: any): Record<string, any> {
    const opts = SaveData.defaultOptions();
    if (loaded != null && typeof loaded === "object") {
      for (const [k, v] of pairs(loaded)) {
        opts[k as string] = v;
      }
      if (loaded.speed != null && loaded.speedOverworld == null
        && loaded.speedBattle == null && loaded.speedMenu == null) {
        opts.speedOverworld = loaded.speed;
        opts.speedBattle = loaded.speed;
        opts.speedMenu = loaded.speed;
      }
      delete opts.speed;
    }
    return opts;
  },

  // Lua: SaveData.lua:750
  isSafeMode(options: any): boolean {
    return options != null && typeof options === "object" && options.safeMode === true;
  },

  // Lua: SaveData.lua:754
  setSafeMode(options: any, enabled: unknown): boolean {
    if (options == null || typeof options !== "object") return false;
    options.safeMode = enabled === true;
    return options.safeMode;
  },

  // Lua: SaveData.lua:760
  encode(data: unknown): string {
    return SaveSerializer.encode(data);
  },

  // Lua: SaveData.lua:764 -- [table] or [undefined, err]
  decode(str: unknown): [any, string?] {
    return SaveSerializer.decode(str);
  },

  // Lua: SaveData.lua:877 -- the options written (the cart's view), or undefined on failure
  saveOptions(optsIn: any, fsIn?: PersistFs): Record<string, any> | undefined {
    const fs = persistFs(fsIn);
    let opts = optsIn;
    const [onDisk] = readTable(fs, OPTIONS_FILENAME);
    const cartGlobalValues = cartGlobals(onDisk);
    applyCartOverlay(onDisk);
    let isFull = opts != null && typeof opts === "object";
    if (isFull) {
      for (const k of Object.keys(SaveData.defaultOptions())) {
        if (opts[k] == null) { isFull = false; break; }
      }
    }
    if (!isFull) {
      const merged: Record<string, any> = {};
      if (opts != null && typeof opts === "object") {
        for (const [k, v] of pairs(opts)) merged[k as string] = v;
      }
      if (onDisk != null && typeof onDisk === "object") {
        for (const [k, v] of pairs(onDisk)) {
          if (k !== "modOptions" && merged[k as string] == null) {
            merged[k as string] = deepCopy(v);
          }
        }
      }
      opts = merged;
    }
    opts = SaveData.mergeOptions(opts);
    if (onDisk != null && typeof onDisk === "object" && onDisk.modOptions != null && typeof onDisk.modOptions === "object") {
      const merged: Record<string, any> = {};
      for (const [modId, bucket] of pairs(onDisk.modOptions)) {
        merged[modId as string] = bucket;
      }
      for (const [modId, bucket] of pairs<any>(opts.modOptions || {})) {
        if (bucket != null && typeof bucket === "object" && merged[modId as string] != null && typeof merged[modId as string] === "object") {
          for (const [k, v] of pairs(bucket)) merged[modId as string][k] = v;
        } else {
          merged[modId as string] = bucket;
        }
      }
      opts.modOptions = merged;
    }
    splitCartOverlay(opts, cartGlobalValues, onDisk);
    const encoded = SaveSerializer.encode(opts);
    let [ok, err] = fsWrite(fs, OPTIONS_TMP_FILENAME, encoded);
    if (!ok) {
      Logger.error("options save failed: %s", tostring(err));
      return undefined;
    }
    const prev = fs.getInfo(OPTIONS_FILENAME) ? fs.read(OPTIONS_FILENAME) : undefined;
    if (typeof prev === "string" && prev !== "" && prev !== encoded) {
      fs.write(OPTIONS_BACKUP_FILENAME, prev);
    }
    [ok, err] = fsWrite(fs, OPTIONS_FILENAME, encoded);
    if (!ok) {
      Logger.error("options save failed: %s", tostring(err));
      return undefined;
    }
    const wrote = fs.getInfo(OPTIONS_FILENAME) ? fs.read(OPTIONS_FILENAME) : undefined;
    if (wrote !== encoded) {
      Logger.error("options save did not land (%d bytes written, %s on disk)",
        encoded.length, typeof wrote === "string" ? tostring(wrote.length) : "nothing");
      return undefined;
    }
    fs.write(OPTIONS_BACKUP_FILENAME, encoded);
    remove(fs, OPTIONS_TMP_FILENAME);
    const slot = optionsCacheSlot(fs);
    slot.rev = slot.rev + 1;
    return applyCartOverlay(opts);
  },

  // Lua: SaveData.lua:993
  loadOptions(fsIn?: PersistFs): Record<string, any> {
    const fs = persistFs(fsIn);
    const slot = optionsCacheSlot(fs);
    if (slot.atRev !== slot.rev) {
      const [data, err] = readTable(fs, OPTIONS_FILENAME);
      if (!data) {
        if (fs.getInfo(OPTIONS_FILENAME)) {
          Logger.error("options load failed: %s", tostring(err));
        }
        let [recovered] = readTable(fs, OPTIONS_TMP_FILENAME);
        let from = "tmp";
        if (!recovered) {
          [recovered] = readTable(fs, OPTIONS_BACKUP_FILENAME);
          from = "bak";
        }
        if (recovered) {
          Logger.warn("options.lua %s; recovered from %s copy",
            fs.getInfo(OPTIONS_FILENAME) ? "corrupt" : "missing", from);
          if (fs.write) {
            fs.write(OPTIONS_FILENAME, SaveSerializer.encode(recovered));
          }
          slot.tree = SaveData.mergeOptions(recovered);
        } else {
          slot.tree = SaveData.defaultOptions();
        }
      } else {
        slot.tree = SaveData.mergeOptions(data);
      }
      slot.atRev = slot.rev;
    }
    return applyCartOverlay(deepCopy(slot.tree));
  },

  // Lua: SaveData.lua:1682
  setActiveSlot(version: string | undefined, slotId: string): string | undefined {
    const v = version || GameVersion.get();
    if (!knownVersion(v)) return undefined;
    return setActiveSlotIn(v, slotId);
  },

  // Lua: SaveData.lua:1711
  createSlot(version?: string): string | undefined {
    const v = version || GameVersion.get();
    if (!knownVersion(v)) return undefined;
    return createSlotIn(v);
  },

  // Lua: SaveData.lua:1727
  activeSlot(version?: string): string | undefined {
    const v = version || GameVersion.get();
    if (!knownVersion(v)) return undefined;
    return activeSlotIn(v);
  },

  // Lua: SaveData.lua:1852 -- [ok, err]
  deleteSlot(version: string | undefined, slotId: unknown): [boolean, string?] {
    const v = version || GameVersion.get();
    if (!knownVersion(v)) return [false, "unknown version"];
    return deleteSlotIn(v, slotId);
  },

  // Lua: SaveData.lua:1863
  refreshSlotResolution(scope?: unknown): void {
    if (scope != null) {
      if (typeof scope !== "string" || scope === "") return;
      delete activeSlotCache[scope];
      delete slotsChecked[scope];
      return;
    }
    for (const k of Object.keys(activeSlotCache)) delete activeSlotCache[k];
    for (const k of Object.keys(slotsChecked)) delete slotsChecked[k];
  },

  // Lua: SaveData.lua:1876
  resetSlotState(): void {
    SaveData.refreshSlotResolution();
    freshPlaythrough = undefined;
  },

  // Lua: SaveData.lua:2148
  newPlaythroughId(): string {
    playthroughSeq = playthroughSeq + 1;
    // NOT FAITHFUL: Brian mixes in a fresh table's address (tostring({})); JS has
    // no addresses, so a non-gameplay random word stands in (platform/rng.ts).
    const addressLo = random(0, 0xFFFFFFFF);
    const clock = Math.floor(osClock() * 1000000);
    return format("%08x%08x%08x%08x",
      word(osTime()), word(clock), word(addressLo), word(playthroughSeq));
  },

  // Lua: SaveData.lua:2199
  ensurePlaythroughId(save: any, injectedFs?: PersistFs): string | undefined {
    if (save == null || typeof save !== "object") return undefined;
    save.meta = save.meta != null && typeof save.meta === "object" ? save.meta : {};
    let id = save.meta.playthroughId;
    if (typeof id === "string" && id !== "") return id;

    const version = save.version || GameVersion.get();
    const [scope, key] = playthroughScope(version, injectedFs);
    const opts = SaveData.loadOptions(injectedFs);
    const isFresh = save === freshPlaythrough;
    if (isFresh) freshPlaythrough = undefined;
    const byVersion = opts.playthroughIds ? opts.playthroughIds[key] : undefined;
    const existing = byVersion ? byVersion[scope] : undefined;
    id = !isFresh ? existing : undefined;
    if (typeof id !== "string" || id === "") {
      id = SaveData.newPlaythroughId();
      if (!(isFresh && typeof existing === "string" && existing !== "")) {
        opts.playthroughIds = opts.playthroughIds || {};
        opts.playthroughIds[key] = opts.playthroughIds[key] || {};
        opts.playthroughIds[key][scope] = id;
        SaveData.saveOptions(opts, injectedFs);
      }
    }
    save.meta.playthroughId = id;
    return id;
  },

  // Lua: SaveData.lua:2272 -- [id] or [undefined, code, message]
  selectedPlaythroughId(save: any, injectedFs?: PersistFs): [string | undefined, string?, string?] {
    if (save == null || typeof save !== "object") {
      return [undefined, "not_in_playthrough", "No selected playthrough is available."];
    }
    const version = save.version || GameVersion.get();
    if (!knownVersion(version)) {
      return [undefined, "unknown_game", "The selected game version is unavailable."];
    }
    let id = save.meta ? save.meta.playthroughId : undefined;
    if (typeof id === "string" && id !== "") return [id];

    const [scope, key] = playthroughScope(version, injectedFs);
    const opts = SaveData.loadOptions(injectedFs);
    const byVersion = opts.playthroughIds ? opts.playthroughIds[key] : undefined;
    id = byVersion ? byVersion[scope] : undefined;
    if (typeof id !== "string" || id === "") {
      return [undefined, "no_selected_playthrough",
        "The selected playthrough has no durable tool state."];
    }
    return [id];
  },

  // Lua: SaveData.lua:2331
  buildMeta(mods: any, previous: any, sessionStart?: unknown): Record<string, any> {
    let list: any[];
    if (mods != null) {
      list = [null];
      for (const [, mod] of ipairs<any>(mods)) {
        list[len(list) + 1] = { id: mod.id, version: mod.version, api: mod.api };
      }
      sort<any>(list, (a, b) => a.id < b.id);
    } else {
      list = (previous != null && typeof previous === "object" && previous.mods) || {};
    }
    let started = tonumber(sessionStart);
    if (started === undefined || started !== started || started <= 0 || started === Infinity) {
      started = previous != null && typeof previous === "object" ? tonumber(previous.sessionStart) : undefined;
    }
    const savedAt = osTime();
    if (started !== undefined && started > savedAt) started = savedAt;
    const meta: Record<string, any> = {
      format: VERSION_SAVE_FORMAT,
      engine: VERSION_ENGINE,
      savedAt,
      sessionStart: started,
      playthroughId: previous != null && typeof previous === "object" ? previous.playthroughId : undefined,
      cartId: previous != null && typeof previous === "object" ? previous.cartId : undefined,
      cartHash: previous != null && typeof previous === "object" ? previous.cartHash : undefined,
      sealBroken: (previous != null && typeof previous === "object" && previous.sealBroken === true) || undefined,
      mods: list,
      modCount: len(list),
    };
    for (const k of Object.keys(meta)) if (meta[k] === undefined) delete meta[k];
    return meta;
  },

  // Lua: SaveData.lua:2366
  modsDiff(save: any, activeMods: any): { added: (string | null)[]; removed: (string | null)[]; changed: any[] } {
    const stored: Record<string, string> = {};
    for (const [, entry] of ipairs<any>((save.meta && save.meta.mods) || [null])) {
      if (entry != null && typeof entry === "object" && entry.id) {
        stored[entry.id] = entry.version || "";
      }
    }
    const diff = { added: [null] as (string | null)[], removed: [null] as (string | null)[], changed: [null] as any[] };
    for (const [, mod] of ipairs<any>(activeMods || [null])) {
      const was = stored[mod.id];
      if (was == null) {
        diff.added[len(diff.added) + 1] = mod.id;
      } else if (was !== mod.version) {
        diff.changed[len(diff.changed) + 1] = { id: mod.id, from: was, to: mod.version };
      }
      delete stored[mod.id];
    }
    for (const id of Object.keys(stored)) diff.removed[len(diff.removed) + 1] = id;
    sort(diff.added);
    sort(diff.removed);
    sort<any>(diff.changed, (a, b) => a.id < b.id);
    return diff;
  },

  // Lua: SaveData.lua:2393
  modsDiffNotice(diff: any, meta: any): string | undefined {
    if (diff == null || typeof diff !== "object") return undefined;
    const removed = len(diff.removed || [null]);
    const changed = len(diff.changed || [null]);
    const added = len(diff.added || [null]);
    if (removed === 0 && changed === 0 && added === 0) return undefined;
    const wrote = len((meta != null && typeof meta === "object" && meta.mods) || [null]);
    const parts: (string | null)[] = [null];
    if (removed > 0) {
      parts[len(parts) + 1] = tostring(removed) + (removed === 1 ? " is" : " are") + " no longer active";
    }
    if (changed > 0) {
      parts[len(parts) + 1] = tostring(changed) + " changed version";
    }
    if (added > 0) {
      parts[len(parts) + 1] = tostring(added) + " newly active";
    }
    const list: string[] = [];
    for (const [, p] of ipairs<string>(parts)) list.push(p);
    return format("This save was made with %d mod%s; %s",
      wrote, wrote === 1 ? "" : "s", list.join(", "));
  },

  // Lua: SaveData.lua:2424
  addCoreMigration(fromFormat: number, fn: (save: any) => void): void {
    coreMigrations[len(coreMigrations) + 1] = { from: fromFormat, seq: len(coreMigrations) + 1, fn };
  },

  // Lua: SaveData.lua:2443
  runMigrations(save: any, modChains?: any, activeMods?: any): any {
    sort<any>(coreMigrations, (a, b) => {
      if (a.from !== b.from) return a.from < b.from;
      return a.seq < b.seq;
    });
    const fmt = (save.meta && save.meta.format) || 1;
    if (GameVersion.generation() === 1) {
      for (const [, m] of ipairs<any>(coreMigrations)) {
        if (m.from >= fmt) m.fn(save);
      }
    }
    save.meta = save.meta || { mods: {} };
    save.meta.format = VERSION_SAVE_FORMAT;
    for (const [, active] of ipairs<any>(activeMods || [null])) {
      const modSave = save.modData ? save.modData[active.id] : undefined;
      const recorded = modChains ? modChains[active.id] : undefined;
      if (modSave && recorded) {
        const chain: any[] = [null];
        for (const [, m] of ipairs<any>(recorded)) chain[len(chain) + 1] = m;
        sort<any>(chain, (a, b) => semverLt(a.since, b.since));
        const stored = storedVersion(save, active.id) || "0.0.0";
        for (const [, m] of ipairs<any>(chain)) {
          if (semverLt(stored, m.since) && !semverLt(active.version, m.since)) {
            try {
              m.apply(modSave, save);
            } catch (e) {
              Logger.error("[%s] migration %s: %s -- skipped",
                active.id, tostring(m.since), tostring((e as Error).message ?? e));
              break;
            }
          }
        }
      }
    }
    return save;
  },

  rollTrainerId,

  // Lua: SaveData.lua:2573
  saveLiveOptions(data: any): Record<string, any> | undefined {
    if (data == null || typeof data !== "object" || data.options == null || typeof data.options !== "object") return undefined;
    data.options = rememberPlaythroughId(data, data.options)[0];
    return SaveData.saveOptions(data.options);
  },

  // Lua: SaveData.lua:2585
  save(data: any, mods?: any): boolean {
    const [FILENAME, BACKUP_FILENAME, TMP_FILENAME] = saveNames(data.version);
    if (mods != null || data.meta == null) {
      data.meta = SaveData.buildMeta(mods, data.meta);
    }
    if (data.options) {
      SaveData.saveLiveOptions(data);
    } else {
      const [opts, changed] = rememberPlaythroughId(data);
      if (changed) SaveData.saveOptions(opts);
    }
    if (activeCart && data.meta != null && typeof data.meta === "object") {
      data.meta.cartId = activeCart;
      if (activeCartHash) data.meta.cartHash = activeCartHash;
    }
    if (sealBroken && data.meta != null && typeof data.meta === "object") {
      data.meta.sealBroken = true;
    }
    const gameOnly: Record<string, any> = {};
    for (const [k, v] of pairs(data)) {
      if (k !== "options") gameOnly[k as string] = v;
    }
    const encoded = SaveSerializer.encode(gameOnly);
    const fs = persistFs(undefined);
    ensureParentDir(fs, FILENAME);
    if (fs.getInfo(FILENAME)) {
      const prev = fs.read(FILENAME);
      if (prev) fs.write(BACKUP_FILENAME, prev);
    }
    let [ok, err] = fsWrite(fs, TMP_FILENAME, encoded);
    if (!ok) {
      Logger.error("save failed: %s", tostring(err));
      return false;
    }
    remove(fs, FILENAME);
    [ok, err] = fsWrite(fs, FILENAME, encoded);
    if (!ok) {
      Logger.error("save failed: %s", tostring(err));
      return false;
    }
    remove(fs, TMP_FILENAME);
    stampActiveCartHash(fs);
    // NOT FAITHFUL: Brian then (pcall'd) asks src.import.SaveFileIO.dropStaleCart to
    // remove a stale .sav export beside a Gen 3 slot; there is no such export here.
    Logger.info("saved game");
    return true;
  },

  // Lua: SaveData.lua:2645 -- [save, recovered ("tmp" | "bak")] or []
  load(version?: string): [any, string?] {
    const [FILENAME, BACKUP_FILENAME, TMP_FILENAME] = saveNames(version);
    const fs = persistFs(undefined);
    let [data, err] = readTable(fs, FILENAME);
    let recovered: string | undefined;
    if (!data) {
      const [tmp] = readTable(fs, TMP_FILENAME);
      if (tmp) {
        data = tmp;
        recovered = "tmp";
      } else {
        const [bak] = readTable(fs, BACKUP_FILENAME);
        if (bak) { data = bak; recovered = "bak"; }
      }
      if (data) {
        Logger.warn("save.lua %s; recovered from %s copy",
          fs.getInfo(FILENAME) ? "corrupt" : "missing", recovered);
        fs.write(FILENAME, SaveSerializer.encode(data));
      }
    }
    if (!data) {
      if (fs.getInfo(FILENAME)) {
        Logger.error("load failed: %s", tostring(err));
      }
      return [undefined];
    }
    SaveData.runMigrations(data);
    data.options = SaveData.loadOptions();
    // NOT FAITHFUL: the Gen 2 branch (data.options = gen2.Save.loadOptions()) is never taken for FireRed.
    const [mapped] = SaveData.selectedPlaythroughId(data);
    if (typeof mapped === "string" && mapped !== "") {
      data.meta.playthroughId = mapped;
    }
    Logger.info("loaded save");
    return [data, recovered];
  },
};

export default SaveData;
