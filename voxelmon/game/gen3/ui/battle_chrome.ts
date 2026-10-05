// Port of gen1recomp src/ui/game3/battle_chrome.lua (GPLv3 + additional terms; see LICENSE.md).
// FRLG battle interface chrome (ROM-baked under pokemon/battle/).
//
// Port notes:
// - read_bytes: Brian's chain is the installed cache, Dataset.cache(),
//   CacheFs.readActive, love.filesystem (both spellings) and io.open. The
//   first three are kept; love.filesystem is Fs. NOT FAITHFUL: io.open has no
//   3DS equivalent (the host's filesystem is Fs, already tried).
// - load_lua uses luaLoad (cache data chunks).
// - `love and love.graphics` guards are always true here and are dropped.
// - _terrains after install is Brian's metatable-backed table (__index loads
//   a sheet on first read): a Proxy over a plain object whose get trap calls
//   BattleChrome.terrain(key); rawget/rawset go to the target.
// - Multiple returns are tuples: textOrigin -> [x, y, w, narrow];
//   messageOrigin -> [x, y, w].
// - pcall(require, "src.ui.game3.pokedex_chrome") in drawPartyBall: a stubbed
//   module is the failed-require path (NotPortedError swallowed).
// - print -> console.log.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { tonumber, tostring, truthy } from "../../../import/gen3/lua.ts";
import { G } from "../platform/graphics.ts";
import { newImageData, type Image, type Quad } from "../platform/image.ts";
import { Fs } from "../platform/fs.ts";
import { luaLoad } from "../platform/luadata.ts";
import { seq, ipairs, isEmpty, type LuaTable } from "../platform/lt.ts";
import { gsub } from "../platform/lpattern.ts";
import { NotPortedError } from "../notported.ts";
import Extract from "../../../import/gen3/extract_island1.ts";
import BattleChromeExtract from "../../../import/gen3/battle_chrome_extract.ts";
import Dataset from "../core/dataset.ts";
import CacheFs from "../shared/import/CacheFs.ts";
import Chrome from "./chrome.ts";
import FrlgFont from "./frlg_font.ts";
import PokedexChrome from "./pokedex_chrome.ts";

export interface TerrainEntry {
  image: Image;
  bgImage: Image | undefined;
  enemyPlat: Image | undefined;
  playerPlat: Image | undefined;
  postDexImage: Image | undefined;
  w: number;
  h: number;
}

export interface BattleChromeModule {
  _cache: any;
  _manifest: LuaTable | undefined;
  _textbox: Image | undefined;
  _playerBox: Image | undefined;
  _enemyBox: Image | undefined;
  _doublesPlayerBox: Image | undefined;
  _doublesOpponentBox: Image | undefined;
  _doublesTried?: boolean;
  _hpBold?: Image | undefined;
  _hpBoldQuads?: Record<number, Quad>;
  _hpBoldTried?: boolean;
  _elements: Image | undefined;
  _elementsExp?: Image | undefined;
  _partyBar: Image | undefined;
  _terrains: Record<string, any>;
  _terrainInfo: Record<string, any>;
  _terrainMissing: Record<string, boolean>;
  _logged: boolean;
  _quads: Record<string, any>;
  WIN: Record<string, number>;
  RSE_TEXT: Record<number, { x: number; y: number; narrow?: boolean }>;
  RSE_MENU_FRAMES: Record<string, LuaTable>;
  terrain(key: any): TerrainEntry | undefined;
  drawPostDexBg(key: any): boolean;
  install(cache?: any): void;
  hasHpBoldDigits(): boolean;
  drawHpBoldChar(ch: string, x: number, y: number): boolean;
  drawDoublesBox(isPlayer: any, x: number, y: number): void;
  manifest(): LuaTable;
  drawTerrain(key?: string | null, enemyOx?: any, playerOx?: any, bgOx?: any): boolean;
  drawCleanBg(key?: string | null): boolean;
  drawPanel(mode?: string | null): void;
  layout(): string;
  isRse(): boolean;
  window(id: any): { left: number; top: number; w: number; h: number; x: number; y: number };
  textOrigin(id: any): [number, number, number, boolean];
  messageOrigin(): [number, number, number];
  textboxColors(fg: number, shadow: number): any;
  drawMenuFrames(mode: string): void;
  drawEnemyBox(x: number, y: number): void;
  drawPlayerBox(x: number, y: number): void;
  scaledHpFraction(hp: any, maxHp: any, scale?: any): number;
  hpBarLevel(hp: any, maxHp: any): string;
  hpColor(hp: any, maxHp: any): string;
  drawHpBar(x: number, y: number, hp: any, maxHp: any, statusBorder?: any): void;
  drawElementTile(ti: number, x: number, y: number, healthboxPal?: any): void;
  drawExpBar(x: number, y: number, ratio?: number | null): void;
  drawPartyBall(x: number, y: number, kind?: string | null): void;
  drawCaughtBall(x: number, y: number): void;
  drawPartyBar(x: number, y: number, balls?: LuaTable | null, ox?: any, isOpponent?: any): void;
}

export const BattleChrome = {} as BattleChromeModule;

BattleChrome._cache = undefined;
BattleChrome._manifest = undefined;
BattleChrome._textbox = undefined;
BattleChrome._playerBox = undefined;
BattleChrome._enemyBox = undefined;
BattleChrome._doublesPlayerBox = undefined;
BattleChrome._doublesOpponentBox = undefined;
BattleChrome._elements = undefined;
BattleChrome._partyBar = undefined;
BattleChrome._terrains = {};
BattleChrome._terrainInfo = {};
BattleChrome._terrainMissing = {};
BattleChrome._logged = false;
BattleChrome._quads = {};

/** The raw table behind the _terrains proxy (rawget / rawset). */
let terrainsRaw: Record<string, any> = BattleChrome._terrains;

// Lua: battle_chrome.lua:23
function cache_root(): string {
  return truthy(Extract.CACHE_ROOT) ? Extract.CACHE_ROOT : "data/generated/gba";
}

// Lua: battle_chrome.lua:27
function battle_root(): string {
  return cache_root() + "/pokemon/battle";
}

// Lua: battle_chrome.lua:31
function log(msg: unknown): void {
  if (BattleChrome._logged) return;
  BattleChrome._logged = true;
  console.log("[game3/battle_chrome] " + tostring(msg));
}

/** pcall around a call into a module that may still be a stub. */
function tryStub<T>(f: () => T): T | undefined {
  try {
    return f();
  } catch (e) {
    if (e instanceof NotPortedError) return undefined;
    throw e;
  }
}

// Lua: battle_chrome.lua:37
function resolve_cache(cache: any): any {
  if (truthy(cache) && truthy(cache.read)) return cache;
  // pcall(require, "src.core.game3.dataset")
  if (truthy(Dataset) && truthy(Dataset.cache)) {
    return Dataset.cache();
  }
  return {
    read: (rel: string): string | undefined => {
      // pcall(require, "src.import.CacheFs")
      if (truthy(CacheFs) && truthy(CacheFs.readActive)) {
        return tryStub(() => CacheFs.readActive(rel));
      }
      return undefined;
    },
  };
}

// Lua: battle_chrome.lua:54
function read_bytes(rel: string): string | undefined {
  const cache = BattleChrome._cache;
  if (truthy(cache) && truthy(cache.read)) {
    const d = cache.read(rel);
    if (typeof d === "string" && d.length > 0) return d;
  }
  if (truthy(Dataset) && truthy(Dataset.cache)) {
    const d = Dataset.cache().read(rel);
    if (typeof d === "string" && d.length > 0) return d;
  }
  if (truthy(CacheFs) && truthy(CacheFs.readActive)) {
    const d = tryStub(() => CacheFs.readActive(rel));
    if (typeof d === "string" && d.length > 0) return d;
  }
  {
    let d = Fs.read(rel);
    if (typeof d === "string" && d.length > 0) return d;
    const alt = "data/generated/gba/" + gsub(rel, "^data/generated/gba/", "")[0];
    d = Fs.read(alt);
    if (typeof d === "string" && d.length > 0) return d;
  }
  // NOT FAITHFUL: the io.open candidates (rel, data/generated/gba/<rel>) are
  // the two paths love.filesystem just tried; there is no io on the 3DS.
  return undefined;
}

// Lua: battle_chrome.lua:92
function load_lua(rel: string): LuaTable | undefined {
  const src = read_bytes(rel);
  if (!truthy(src)) return undefined;
  const [chunk] = luaLoad(src!, "@" + rel);
  if (!truthy(chunk)) return undefined;
  try {
    return (chunk as () => LuaTable)();
  } catch {
    return undefined;
  }
}

// Lua: battle_chrome.lua:102
function rgba_to_image(rgba: string | undefined, w: number, h: number): Image | undefined {
  if (!truthy(rgba) || rgba!.length < w * h * 4) return undefined;
  let imageData;
  try { imageData = newImageData(w, h, "rgba8", rgba); } catch { imageData = undefined; }
  if (!imageData) return undefined;
  const image = G.newImage(imageData);
  if (image.setFilter) image.setFilter("nearest", "nearest");
  return image;
}

// pokefirered/src/battle_bg.c:644
// Lua: battle_chrome.lua:113
BattleChrome.terrain = function (key: any): TerrainEntry | undefined {
  key = tostring(truthy(key) ? key : "");
  const cache = terrainsRaw;
  const hit = cache[key];
  if (hit != null) return hit;
  if (BattleChrome._terrainMissing[key]) return undefined;
  const info = truthy(BattleChrome._terrainInfo) ? BattleChrome._terrainInfo[key] : undefined;
  if (!truthy(info)) return undefined;
  const root = battle_root();
  const w = info.w ?? 256, h = info.h ?? 256;
  const img = rgba_to_image(read_bytes(root + "/" + (info.file ?? ("terrain_" + key + ".rgba"))), w, h);
  if (!img) {
    BattleChrome._terrainMissing[key] = true;
    return undefined;
  }
  const entry: TerrainEntry = {
    image: img,
    bgImage: rgba_to_image(read_bytes(root + "/terrain_bg_" + key + ".rgba"), 256, 160),
    enemyPlat: rgba_to_image(read_bytes(root + "/terrain_enemy_" + key + ".rgba"), 256, 160),
    playerPlat: rgba_to_image(read_bytes(root + "/terrain_player_" + key + ".rgba"), 256, 160),
    postDexImage: truthy(info.postDexFile) ? rgba_to_image(read_bytes(root + "/" + info.postDexFile), 256, 256) : undefined,
    w,
    h,
  };
  cache[key] = entry;
  return entry;
};

// pokeemerald/src/battle_script_commands.c:10131
// pokefirered/src/battle_script_commands.c:9691
// Lua: battle_chrome.lua:143
BattleChrome.drawPostDexBg = function (key: any): boolean {
  const entry = BattleChrome.terrain(key);
  if (!(entry && entry.postDexImage)) {
    throw new Error("battle_chrome: missing ROM post-dex background for " + tostring(key));
  }
  const qKey = "post_dex_" + tostring(key);
  let q = BattleChrome._quads[qKey];
  if (!q) {
    q = G.newQuad(0, 0, 240, 112, 256, 256);
    BattleChrome._quads[qKey] = q;
  }
  G.setColor(1, 1, 1, 1);
  G.draw(entry.postDexImage, q, 0, 0);
  return true;
};

/** setmetatable({}, TERRAIN_MT): reads of a missing key load that sheet. */
// Lua: battle_chrome.lua:159
function newTerrainTable(): Record<string, any> {
  const raw: Record<string, any> = {};
  terrainsRaw = raw;
  return new Proxy(raw, {
    get(target, key) {
      if (typeof key !== "string") return undefined;
      const v = target[key];
      if (v != null) return v;
      return BattleChrome.terrain(key);
    },
  });
}

// Lua: battle_chrome.lua:163
BattleChrome.install = function (cache?: any): void {
  BattleChrome._cache = resolve_cache(cache);
  BattleChrome._manifest = undefined;
  BattleChrome._textbox = undefined;
  BattleChrome._playerBox = undefined;
  BattleChrome._enemyBox = undefined;
  BattleChrome._doublesPlayerBox = undefined;
  BattleChrome._doublesOpponentBox = undefined;
  BattleChrome._doublesTried = false;
  BattleChrome._hpBold = undefined;
  BattleChrome._hpBoldQuads = {};
  BattleChrome._hpBoldTried = false;
  BattleChrome._elements = undefined;
  BattleChrome._elementsExp = undefined;
  BattleChrome._partyBar = undefined;
  BattleChrome._terrains = newTerrainTable();
  BattleChrome._terrainInfo = {};
  BattleChrome._terrainMissing = {};
  BattleChrome._quads = {};
  BattleChrome._logged = false;
  const root = battle_root();
  BattleChrome._manifest = load_lua(root + "/manifest.lua");
  const m = BattleChrome._manifest ?? {};
  const tw = m.textboxW ?? 256, th = m.textboxH ?? 512;
  const tb = read_bytes(root + "/textbox.rgba");
  const pb = read_bytes(root + "/healthbox_player.rgba");
  const eb = read_bytes(root + "/healthbox_enemy.rgba");
  const el = read_bytes(root + "/elements.rgba");
  const elExp = read_bytes(root + "/elements_exp.rgba");
  const pbar = read_bytes(root + "/party_summary_bar.rgba");
  BattleChrome._textbox = rgba_to_image(tb, tw, th);
  BattleChrome._playerBox = rgba_to_image(pb, 128, 64);
  BattleChrome._enemyBox = rgba_to_image(eb, 128, 32);
  BattleChrome._elements = rgba_to_image(el, 320, 24);
  // EXP bar tiles need healthbox palette (blue); fall back to HP sheet if missing
  BattleChrome._elementsExp = rgba_to_image(elExp, 320, 24) ?? BattleChrome._elements;
  const pinfo = m.partySummaryBar ?? { w: 128, h: 8 };
  BattleChrome._partyBar = rgba_to_image(pbar, pinfo.w ?? 128, pinfo.h ?? 8);
  BattleChrome._terrainInfo = m.terrains ?? {
    grass: { file: "terrain_grass.rgba", w: m.terrainW ?? 256, h: m.terrainH ?? 256 },
  };

  if (truthy(pb) && truthy(eb) && truthy(tb) && !isEmpty(BattleChrome._terrainInfo)) {
    log("battle chrome ready (v" + tostring(m.format ?? "?") + ")");
  } else {
    log("battle chrome missing — re-run --pokemon extract");
  }
};

// Lua: battle_chrome.lua:212
function load_doubles_boxes(): void {
  if (BattleChrome._doublesTried) return;
  BattleChrome._doublesTried = true;
  const root = battle_root();
  const files: any = BattleChromeExtract.DOUBLES_FILES ?? {};
  const pRgba = read_bytes(root + "/" + (files.player ?? "healthbox_doubles_player.rgba"));
  const oRgba = read_bytes(root + "/" + (files.opponent ?? "healthbox_doubles_opponent.rgba"));
  BattleChrome._doublesPlayerBox = rgba_to_image(pRgba, 128, 32);
  BattleChrome._doublesOpponentBox = rgba_to_image(oRgba, 128, 32);
  if (!(BattleChrome._doublesPlayerBox && BattleChrome._doublesOpponentBox)) {
    console.log("[game3/battle_chrome] cache missing doubles healthboxes");
  }
}

// Lua: battle_chrome.lua:226
function load_hp_bold(): void {
  if (BattleChrome._hpBoldTried) return;
  BattleChrome._hpBoldTried = true;
  const w = BattleChromeExtract.HP_BOLD_W ?? 88, h = BattleChromeExtract.HP_BOLD_H ?? 8;
  const rgba = read_bytes(battle_root() + "/" + (BattleChromeExtract.HP_BOLD_FILE ?? "hp_bold_digits.rgba"));
  BattleChrome._hpBold = rgba_to_image(rgba, w, h);
  BattleChrome._hpBoldQuads = {};
  if (!BattleChrome._hpBold) {
    console.log("[game3/battle_chrome] cache missing bold HP digits");
  }
}

// Lua: battle_chrome.lua:238
BattleChrome.hasHpBoldDigits = function (): boolean {
  load_hp_bold();
  return BattleChrome._hpBold != null;
};

// pokefirered/src/battle_interface.c:889
// Lua: battle_chrome.lua:244
BattleChrome.drawHpBoldChar = function (ch: string, x: number, y: number): boolean {
  load_hp_bold();
  const img = BattleChrome._hpBold;
  if (!img) return false;
  const chars: string = BattleChromeExtract.HP_BOLD_CHARS ?? "0123456789/";
  // chars:find(ch, 1, true) (1-based)
  const at = chars.indexOf(ch);
  if (at < 0 || ch.length === 0) return false;
  const n = at + 1;
  let q = BattleChrome._hpBoldQuads![n];
  if (!q) {
    const [iw, ih] = img.getDimensions();
    q = G.newQuad((n - 1) * 8, 0, 8, 8, iw, ih);
    BattleChrome._hpBoldQuads![n] = q;
  }
  G.setColor(1, 1, 1, 1);
  G.draw(img, q, x, y);
  return true;
};

// pokefirered/src/battle_gfx_sfx_util.c:39
// Lua: battle_chrome.lua:262
BattleChrome.drawDoublesBox = function (isPlayer: any, x: number, y: number): void {
  load_doubles_boxes();
  let img = truthy(isPlayer) ? BattleChrome._doublesPlayerBox : BattleChrome._doublesOpponentBox;
  img = img ?? BattleChrome._enemyBox;
  if (!img) return;
  G.setColor(1, 1, 1, 1);
  G.draw(img, x, y);
};

// Lua: battle_chrome.lua:271
BattleChrome.manifest = function (): LuaTable {
  if (!truthy(BattleChrome._manifest)) BattleChrome.install(BattleChrome._cache);
  return BattleChrome._manifest ?? {};
};

/**
 * Draw terrain sheet ("grass" | "building"). Returns false if missing.
 * During intro slide-in:
 * 1. Base clean wallpaper (continuous sky and ground, no platforms).
 * 2. Transparent enemy platform oval sliding with enemyOx (no wrap, no solid bars).
 * 3. Transparent player platform oval sliding with playerOx (no wrap, no solid bars).
 * When at rest (enemyOx == 0, playerOx == 0), draws standard full terrain at (0, 0).
 */
// Lua: battle_chrome.lua:282
BattleChrome.drawTerrain = function (key?: string | null, enemyOx?: any, playerOx?: any, bgOx?: any): boolean {
  const k: string = truthy(key) ? key! : "building";
  const eOx: number = tonumber(enemyOx) ?? 0;
  const pOx: number = tonumber(playerOx) ?? 0;
  const bOx: number = tonumber(bgOx) ?? 0;
  const entry = BattleChrome.terrain(k) ?? BattleChrome.terrain("building")
    ?? BattleChrome.terrain("grass");
  if (!entry || !entry.image) return false;

  const qFullKey = "terrain_full_" + k;
  if (!BattleChrome._quads[qFullKey]) {
    BattleChrome._quads[qFullKey] = G.newQuad(0, 0, 240, 160, entry.w, entry.h);
  }

  if (eOx === 0 && pOx === 0) {
    const q = BattleChrome._quads[qFullKey];
    if (q) {
      G.setColor(1, 1, 1, 1);
      G.draw(entry.image, q, 0, 0);
      return true;
    }
    return false;
  }

  // During intro slide, use split transparent platforms over continuous wallpaper
  if (entry.bgImage && entry.enemyPlat && entry.playerPlat) {
    const qBgKey = "terrain_bg_view_" + k;
    if (!BattleChrome._quads[qBgKey]) {
      BattleChrome._quads[qBgKey] = G.newQuad(0, 0, 240, 160, 256, 160);
    }
    const qBg = BattleChrome._quads[qBgKey];
    G.setColor(1, 1, 1, 1);
    if (bOx !== 0) {
      // pokefirered/src/battle_intro.c:139
      const qWrapKey = "terrain_bg_wrap_" + k;
      if (!BattleChrome._quads[qWrapKey]) {
        BattleChrome._quads[qWrapKey] = G.newQuad(0, 0, 256, 160, 256, 160);
      }
      const qWrap = BattleChrome._quads[qWrapKey];
      if (qWrap) {
        const off = -(((bOx % 256) + 256) % 256);
        G.draw(entry.bgImage, qWrap, off, 0);
        G.draw(entry.bgImage, qWrap, off + 256, 0);
      } else if (qBg) {
        G.draw(entry.bgImage, qBg, 0, 0);
      }
    } else if (qBg) {
      G.draw(entry.bgImage, qBg, 0, 0);
    }
    G.draw(entry.enemyPlat, eOx, 0);
    G.draw(entry.playerPlat, pOx, 0);
    return true;
  }

  const q = BattleChrome._quads[qFullKey];
  if (q) {
    G.setColor(1, 1, 1, 1);
    G.draw(entry.image, q, 0, 0);
    return true;
  }
  return false;
};

/** Draw clean background wallpaper without battle platforms (e.g. for evolution scene). */
// Lua: battle_chrome.lua:346
BattleChrome.drawCleanBg = function (key?: string | null): boolean {
  const k: string = truthy(key) ? key! : "building";
  const entry = BattleChrome.terrain(k) ?? BattleChrome.terrain("building")
    ?? BattleChrome.terrain("grass");
  if (!entry) return false;

  if (entry.bgImage) {
    const qBgKey = "terrain_bg_view_" + k;
    if (!BattleChrome._quads[qBgKey]) {
      BattleChrome._quads[qBgKey] = G.newQuad(0, 0, 240, 160, 256, 160);
    }
    const qBg = BattleChrome._quads[qBgKey];
    G.setColor(1, 1, 1, 1);
    if (qBg) {
      G.draw(entry.bgImage, qBg, 0, 0);
      return true;
    }
  }

  const qFullKey = "terrain_full_" + k;
  if (!BattleChrome._quads[qFullKey] && entry.image) {
    BattleChrome._quads[qFullKey] = G.newQuad(0, 0, 240, 160, entry.w, entry.h);
  }
  const q = BattleChrome._quads[qFullKey];
  if (q && entry.image) {
    G.setColor(1, 1, 1, 1);
    G.draw(entry.image, q, 0, 0);
    return true;
  }
  return false;
};

/**
 * Draw textbox panel: message / action / fight.
 * Tilemap chrome starts at y=112 (not 120); panels are 48px tall, 160px apart.
 */
// Lua: battle_chrome.lua:380
BattleChrome.drawPanel = function (mode?: string | null): void {
  if (!BattleChrome._textbox) return;
  let scroll = 0;
  if (mode === "menu") scroll = 160;
  else if (mode === "moves") scroll = 320;
  const tw = (truthy(BattleChrome._manifest) && BattleChrome._manifest.textboxW) || 256;
  const th = (truthy(BattleChrome._manifest) && BattleChrome._manifest.textboxH) || 512;
  const key = "panel48_" + tostring(scroll);
  if (!BattleChrome._quads[key]) {
    let y = 112 + scroll;
    if (y + 48 > th) y = Math.max(0, th - 48);
    BattleChrome._quads[key] = G.newQuad(0, y, 240, 48, tw, th);
  }
  const q = BattleChrome._quads[key];
  if (q) {
    G.setColor(1, 1, 1, 1);
    G.draw(BattleChrome._textbox, q, 0, 112);
  }
};

// Lua: battle_chrome.lua:400
BattleChrome.layout = function (): string {
  const m = BattleChrome._manifest;
  return (m !== null && typeof m === "object" && truthy(m.layout)) ? m.layout : "frlg";
};

// Lua: battle_chrome.lua:405
BattleChrome.isRse = function (): boolean {
  return BattleChrome.layout() === "rse";
};

// pokeemerald/include/constants/battle.h:347
BattleChrome.WIN = {
  MSG: 0, ACTION_PROMPT: 1, ACTION_MENU: 2,
  MOVE_NAME_1: 3, MOVE_NAME_2: 4, MOVE_NAME_3: 5, MOVE_NAME_4: 6,
  PP: 7, DUMMY: 8, PP_REMAINING: 9, MOVE_TYPE: 10, SWITCH_PROMPT: 11, YESNO: 12,
  LEVEL_UP_BOX: 13, LEVEL_UP_BANNER: 14,
};

// pokeemerald/src/battle_message.c:1478
BattleChrome.RSE_TEXT = {
  [0]: { x: 0, y: 1 },
  [1]: { x: 1, y: 1 },
  [2]: { x: 0, y: 1 },
  [3]: { x: 0, y: 1, narrow: true },
  [4]: { x: 0, y: 1, narrow: true },
  [5]: { x: 0, y: 1, narrow: true },
  [6]: { x: 0, y: 1, narrow: true },
  [7]: { x: 0, y: 1, narrow: true },
  [8]: { x: 0, y: 1 },
  [9]: { x: 2, y: 1 },
  [10]: { x: 0, y: 1, narrow: true },
  [11]: { x: 0, y: 1, narrow: true },
  [12]: { x: 0, y: 1 },
};

// Lua: battle_chrome.lua:434
BattleChrome.window = function (id: any) {
  const m = truthy(BattleChrome._manifest) ? BattleChrome._manifest : BattleChrome.manifest();
  const rows = truthy(m.windows) ? m.windows.normal : undefined;
  const row = truthy(rows) ? rows[(tonumber(id) ?? 0) + 1] : undefined;
  if (!truthy(row)) throw new Error("battle chrome: manifest has no window template " + tostring(id));
  return {
    left: row.left, top: row.top % 20, w: row.w, h: row.h,
    x: row.left * 8, y: (row.top % 20) * 8,
  };
};

// Lua: battle_chrome.lua:445
BattleChrome.textOrigin = function (id: any): [number, number, number, boolean] {
  const w = BattleChrome.window(id);
  const t = BattleChrome.RSE_TEXT[tonumber(id) ?? 0] ?? { x: 0, y: 1 };
  return [w.x + t.x, w.y + t.y, w.w * 8, t.narrow === true];
};

// Lua: battle_chrome.lua:451
BattleChrome.messageOrigin = function (): [number, number, number] {
  if (!BattleChrome.isRse()) return [10, 122, 224];
  const [x, y, w] = BattleChrome.textOrigin(BattleChrome.WIN.MSG);
  return [x, y, w];
};

// Lua: battle_chrome.lua:457
function c5to8(x: number): number {
  return (x * 8 + Math.floor(x / 4)) / 255;
}

// Lua: battle_chrome.lua:461
function bgr555(v: any): LuaTable {
  const n: number = tonumber(v) ?? 0;
  return seq(c5to8(n % 32), c5to8(Math.floor(n / 32) % 32), c5to8(Math.floor(n / 1024) % 32), 1);
}

// pokeemerald/src/battle_message.c:1480
// Lua: battle_chrome.lua:467
BattleChrome.textboxColors = function (fg: number, shadow: number): any {
  const pal = (BattleChrome._manifest ?? {}).textboxPal;
  if (!truthy(pal)) {
    return FrlgFont.COLOR.WHITE;
  }
  return { fg: bgr555(pal[fg + 1]), shadow: bgr555(pal[shadow + 1]), bg: seq(0, 0, 0, 0) };
};

// pokeemerald/graphics/battle_interface/textbox_map.bin
BattleChrome.RSE_MENU_FRAMES = {
  menu: seq(seq(16, 15, 13, 4)),
  moves: seq(seq(1, 15, 18, 4), seq(21, 15, 8, 4)),
};

// pokeemerald/src/battle_bg.c:744
// Lua: battle_chrome.lua:483
BattleChrome.drawMenuFrames = function (mode: string): void {
  if (!BattleChrome.isRse()) return;
  const rects = BattleChrome.RSE_MENU_FRAMES[mode];
  if (!truthy(rects)) return;
  for (const [, r] of ipairs(rects)) {
    Chrome.userFrame(Chrome._frameType ?? 0, r[1], r[2], r[3], r[4]);
  }
};

// Lua: battle_chrome.lua:493
BattleChrome.drawEnemyBox = function (x: number, y: number): void {
  if (!BattleChrome._enemyBox) return;
  G.setColor(1, 1, 1, 1);
  G.draw(BattleChrome._enemyBox, x, y);
};

// Lua: battle_chrome.lua:499
BattleChrome.drawPlayerBox = function (x: number, y: number): void {
  if (!BattleChrome._playerBox) return;
  G.setColor(1, 1, 1, 1);
  G.draw(BattleChrome._playerBox, x, y);
};

// Element tile bases (pret B_INTERFACE_GFX_*)
const HP_TEXT_TILE = 1;
const HP_BAR_LEFT_BORDER = 65;
const HP_BAR_BASE: Record<string, number> = { green: 3, yellow: 47, red: 56 };
const HP_BAR_TILES = 6;
const HP_BAR_PIXELS = 48;
const EXP_BAR_TILE = 12;
const EXP_BAR_TILES = 8;

// pokefirered/src/battle_interface.c:2155
// Lua: battle_chrome.lua:515
BattleChrome.scaledHpFraction = function (hp: any, maxHp: any, scale?: any): number {
  let h: number = tonumber(hp) ?? 0;
  const m: number = tonumber(maxHp) ?? 0;
  const s: number = tonumber(scale) ?? HP_BAR_PIXELS;
  if (m <= 0 || h <= 0) return 0;
  if (h > m) h = m;
  const result = Math.floor(h * s / m);
  if (result === 0) return 1;
  return result;
};

// pokefirered/src/battle_interface.c:2168
// Lua: battle_chrome.lua:527
BattleChrome.hpBarLevel = function (hp: any, maxHp: any): string {
  const h: number = tonumber(hp) ?? 0;
  const m: number = tonumber(maxHp) ?? 0;
  if (m <= 0) return "empty";
  if (h >= m) return "full";
  const fraction = BattleChrome.scaledHpFraction(h, m, HP_BAR_PIXELS);
  if (fraction > Math.floor(HP_BAR_PIXELS * 50 / 100)) return "green";
  if (fraction > Math.floor(HP_BAR_PIXELS * 20 / 100)) return "yellow";
  if (fraction > 0) return "red";
  return "empty";
};

// pokefirered/src/battle_interface.c:1907
// Lua: battle_chrome.lua:540
BattleChrome.hpColor = function (hp: any, maxHp: any): string {
  const level = BattleChrome.hpBarLevel(hp, maxHp);
  if (level === "full") return "green";
  if (level === "empty") return "red";
  return level;
};

// Lua: battle_chrome.lua:547
function elements_tile_quad(ti: number, sheet?: Image): Quad | undefined {
  sheet = sheet ?? BattleChrome._elements;
  if (!sheet) return undefined;
  // Per-sheet subtables keyed by tile index (no per-tile string keys).
  const subKey = sheet === BattleChrome._elementsExp ? "exp_tiles" : "elt_tiles";
  let sub = BattleChrome._quads[subKey];
  if (!sub) {
    sub = {};
    BattleChrome._quads[subKey] = sub;
  }
  let q = sub[ti];
  if (!q) {
    const tw = 40; // 320/8
    const tx = ti % tw, ty = Math.floor(ti / tw);
    q = G.newQuad(tx * 8, ty * 8, 8, 8, 320, 24);
    sub[ti] = q;
  }
  return q;
}

// pokefirered/src/battle_interface.c:2050
// Lua: battle_chrome.lua:568
function split_bar_pixels(filled: any, numTiles: number): LuaTable {
  let remaining = Math.max(0, Math.min(numTiles * 8, Math.floor(tonumber(filled) ?? 0)));
  const out: LuaTable = [null];
  for (let i = 1; i <= numTiles; i++) {
    const pix = Math.max(0, Math.min(8, remaining));
    remaining = remaining - pix;
    out[i] = pix;
  }
  return out;
}

// Lua: battle_chrome.lua:579
function filled_pixels_for_bar(ratio: number, numTiles: number): LuaTable {
  const total = numTiles * 8;
  let filled = Math.floor(total * ratio);
  if (filled < 1 && ratio > 0) filled = 1;
  return split_bar_pixels(filled, numTiles);
}

/** Draw pret HP bar: HP label tiles + 6 fill tiles (48px). Top-left of 64×8 strip. */
// Lua: battle_chrome.lua:587
BattleChrome.drawHpBar = function (x: number, y: number, hp: any, maxHp: any, statusBorder?: any): void {
  if (!BattleChrome._elements) return;
  const color = BattleChrome.hpColor(hp, maxHp);
  const base = HP_BAR_BASE[color] ?? HP_BAR_BASE.green!;
  const pix = split_bar_pixels(BattleChrome.scaledHpFraction(hp, maxHp, HP_BAR_PIXELS), HP_BAR_TILES);

  G.setColor(1, 1, 1, 1);
  if (truthy(statusBorder)) {
    // pokefirered/src/battle_interface.c:1672
    const q = elements_tile_quad(HP_BAR_LEFT_BORDER);
    if (q) G.draw(BattleChrome._elements, q, x + 8, y);
  } else {
    for (let i = 0; i <= 1; i++) {
      const q = elements_tile_quad(HP_TEXT_TILE + i);
      if (q) G.draw(BattleChrome._elements, q, x + i * 8, y);
    }
  }
  for (let i = 0; i <= HP_BAR_TILES - 1; i++) {
    const q = elements_tile_quad(base + (pix[i + 1] ?? 0));
    if (q) G.draw(BattleChrome._elements, q, x + 16 + i * 8, y);
  }
};

// Lua: battle_chrome.lua:610
BattleChrome.drawElementTile = function (ti: number, x: number, y: number, healthboxPal?: any): void {
  const sheet = truthy(healthboxPal) ? (BattleChrome._elementsExp ?? BattleChrome._elements) : BattleChrome._elements;
  if (!sheet) return;
  const q = elements_tile_quad(ti, sheet);
  if (!q) return;
  G.setColor(1, 1, 1, 1);
  G.draw(sheet, q, x, y);
};

/** Pret EXP bar: 8 element tiles in healthbox VRAM (TAG_HEALTHBOX_PAL → blue). */
// Lua: battle_chrome.lua:620
BattleChrome.drawExpBar = function (x: number, y: number, ratio?: number | null): void {
  const sheet = BattleChrome._elementsExp ?? BattleChrome._elements;
  if (!sheet) return;
  const r = Math.max(0, Math.min(1, truthy(ratio) ? ratio! : 0));
  const pix = filled_pixels_for_bar(r, EXP_BAR_TILES);
  G.setColor(1, 1, 1, 1);
  for (let i = 0; i <= EXP_BAR_TILES - 1; i++) {
    const q = elements_tile_quad(EXP_BAR_TILE + (pix[i + 1] ?? 0), sheet);
    if (q) G.draw(sheet, q, x + i * 8, y);
  }
};

// Party summary balls: pret B_INTERFACE_GFX_BALL_PARTY_SUMMARY = tile 66.
// In pokefirered (battle_interface.c:1183-1202):
//   tile 66 (+0): ok (filled normal Pokéball)
//   tile 67 (+1): empty (empty circle outline)
//   tile 68 (+2): status (status ailment circle)
//   tile 69 (+3): faint (fainted dark circle)
const PARTY_BALL_TILE: Record<string, number> = {
  ok: 66,
  empty: 67,
  status: 68,
  faint: 69,
  caught: 70,
};

// Lua: battle_chrome.lua:646
BattleChrome.drawPartyBall = function (x: number, y: number, kind?: string | null): void {
  const ti = PARTY_BALL_TILE[truthy(kind) ? kind! : "ok"] ?? PARTY_BALL_TILE.ok!;
  const q = elements_tile_quad(ti);
  if (!q || !BattleChrome._elements) {
    // pcall(require, "src.ui.game3.pokedex_chrome")
    if (truthy(PokedexChrome) && truthy(PokedexChrome.drawCaughtMarker)) {
      tryStub(() => PokedexChrome.drawCaughtMarker(x, y));
    }
    return;
  }
  G.setColor(1, 1, 1, 1);
  G.draw(BattleChrome._elements, q, x, y);
};

// Lua: battle_chrome.lua:660
BattleChrome.drawCaughtBall = function (x: number, y: number): void {
  BattleChrome.drawPartyBall(x, y, "caught");
};

/**
 * Draw party summary bar and 6 ball slots (1:1 with pokefirered CreatePartyStatusSummarySprites).
 * Player: base (136, 96), un-flipped bar (<=====), balls at y=92 from x=160..210 (left-to-right).
 * Opponent: base (104, 40), H-flipped bar (=====>), balls at y=36 from x=30..80 (right-aligned).
 */
// Lua: battle_chrome.lua:667
BattleChrome.drawPartyBar = function (x: number, y: number, balls?: LuaTable | null, ox?: any, isOpponent?: any): void {
  const o: number = tonumber(ox) ?? 0;
  const b: LuaTable = balls ?? {};
  if (truthy(isOpponent)) {
    const barX = x + o;
    if (BattleChrome._partyBar) {
      G.setColor(1, 1, 1, 1);
      G.draw(BattleChrome._partyBar, barX, y, 0, -1, 1);
    }
    for (let i = 1; i <= 6; i++) {
      const kind = b[i] ?? "empty";
      const bx = (x + o) - 24 - 10 * (6 - i);
      BattleChrome.drawPartyBall(bx, y - 7, kind);
    }
  } else {
    const barX = x + o;
    if (BattleChrome._partyBar) {
      G.setColor(1, 1, 1, 1);
      G.draw(BattleChrome._partyBar, barX, y, 0, 1, 1);
    }
    for (let i = 1; i <= 6; i++) {
      const kind = b[i] ?? "empty";
      const bx = (x + o) + 24 + 10 * (i - 1);
      BattleChrome.drawPartyBall(bx, y - 8, kind);
    }
  }
};

export default BattleChrome;
