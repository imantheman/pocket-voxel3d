// Port of gen1recomp src/ui/game3/map_preview_screen.lua (GPLv3 + additional terms; see LICENSE.md).
// FireRed location preview screen (pokefirered/src/map_preview_screen.c):
// the forest preview the field shows on entering a section, and the cave
// preview that runs ahead of the cave flash (fldeff_flash.c).
//
// The `love and love.graphics ...` guards always hold under LÖVE, so only
// that branch is ported (platform G).

/* eslint-disable @typescript-eslint/no-explicit-any */
import { FrlgFont, type Colors } from "./frlg_font.ts";
import { CaveTransition } from "./cave_transition.ts";
import { Fade } from "./fade.ts";
// src.import.gba.extract_island1's CACHE_ROOT forwards to CachePaths
// (extract_island1.lua:21), so that is read directly, as dataset.ts does.
import { CachePaths } from "../core/cache_paths.ts";
import { MapPreviewExtract } from "../../../import/gen3/map_preview_extract.ts";
import { Strings } from "../shared/core/Strings.ts";
import { Logger } from "../shared/core/Logger.ts";
import { Dataset } from "../core/dataset.ts";
import { CacheFs } from "../shared/import/CacheFs.ts";
import { Space } from "../core/scripting/space.ts";
import { Flags } from "../core/scripting/flags.ts";
import { Runtime } from "../core/runtime.ts";
import { Field } from "../core/field.ts";
import { Warp } from "../core/warp.ts";
import { Renderer } from "../shared/render/Renderer.ts";
import { NotPortedError } from "../notported.ts";
import { G } from "../platform/graphics.ts";
import { newImageData, type Canvas, type Image } from "../platform/image.ts";
import { read as fsRead } from "../platform/fs.ts";
import { luaLoad } from "../platform/luadata.ts";
import { gsub } from "../platform/lpattern.ts";
import { ipairs, seq, type LuaTable } from "../platform/lt.ts";
import { byte, format, tonumber, tostring } from "../../../import/gen3/lua.ts";

const STATE_IDLE = 0;
const STATE_HOLD = 1;
const STATE_FADE_OUT = 2;

// map_preview_screen.c:static const struct WindowTemplate sMapNameWindow
// { .bg = 0, .tilemapLeft = 0, .tilemapTop = 0, .width = 13, .height = 2,
//   .paletteNum = 14, .baseBlock = 0x1C2 }
// No LoadStdWindowTiles / DrawTextBorderOuter call, so unlike the map name
// popup the window is a plain solid rect with no 9-slice border.
const NAME_WINDOW_X = 0;
const NAME_WINDOW_Y = 0;
const NAME_WINDOW_TILES = 13;
const NAME_WINDOW_W = NAME_WINDOW_TILES * 8; // 104, matches the xctr base
const NAME_WINDOW_H = 2 * 8;
const NAME_WINDOW_TEXT_Y = 2; // AddTextPrinterParameterized4(..., xctr / 2, 2, ...)

// src/map_preview_screen.c:513
const FADE_OUT_FRAMES = 47;
const DURATION_FIRST_VISIT = 120;
const DURATION_REVISIT = 40;

/** One sMapPreviewScreenData entry of map_preview/manifest.lua. */
export interface PreviewEntry { mapsec: number; name: string; type: number; flagId: number; artwork: number }

/** palette.c's normal fade, as the cave preview drives it. */
interface PalFade {
  deltaY: number; y: number; targetY: number; dec: boolean; toggle: number; finishing: boolean;
  counter: number; active: boolean; bgY: number; pending: boolean;
}

export interface CavePreview {
  step: number;
  entry: PreviewEntry;
  image: Image;
  name: string;
  mapsec: number;
  data1: number;
  duration: number;
  fade: PalFade | undefined;
  level: number;
  color: number;
  done: (() => void) | undefined;
  frame: number;
  defer: boolean;
}

// The src.render.Renderer probe: the module is always present here (inert on
// the 3DS). Read at call time: no top-level reads of imports (module cycle).
function renderer(): Record<string, any> {
  return Renderer as unknown as Record<string, any>;
}

// Lua: map_preview_screen.lua:63
function cache_root(): string {
  return CachePaths.CACHE_ROOT || "data/generated/gba";
}

// Lua: map_preview_screen.lua:67
function log(msg: unknown): void {
  if (MapPreviewScreen._logged) return;
  MapPreviewScreen._logged = true;
  Logger.info("%s", "[game3/map_preview_screen] " + tostring(msg));
}

// Lua: map_preview_screen.lua:73
function read_bytes(rel: string): string | undefined {
  const cache = MapPreviewScreen._cache;
  if (cache && cache.read) {
    const d = cache.read(rel);
    if (typeof d === "string" && d.length > 0) return d;
  }
  // pcall(require, "src.core.game3.dataset"): always loaded here
  if (Dataset && Dataset.cache) {
    const d = Dataset.cache().read(rel);
    if (typeof d === "string" && d.length > 0) return d;
  }
  // pcall(require, "src.import.CacheFs") + the call: a stub stands for a failed require
  let viaCache: string | undefined;
  try {
    if (CacheFs && CacheFs.readActive) viaCache = CacheFs.readActive(rel);
  } catch (e) {
    if (!(e instanceof NotPortedError)) throw e;
  }
  if (typeof viaCache === "string" && viaCache.length > 0) return viaCache;
  {
    let d = fsRead(rel);
    if (typeof d === "string" && d.length > 0) return d;
    const alt = "data/generated/gba/" + gsub(rel, "^data/generated/gba/", "")[0];
    d = fsRead(alt);
    if (typeof d === "string" && d.length > 0) return d;
  }
  // NOT FAITHFUL: Brian's last resort io.open()s the two candidate paths
  // relative to the working directory; there is no io on the 3DS, and
  // love.filesystem (the host's cache) has just been asked for both.
  return undefined;
}

// Lua: map_preview_screen.lua:111
function load_lua(rel: string): any {
  const src = read_bytes(rel);
  if (!src) return undefined;
  const [chunk] = luaLoad(src, "@" + rel);
  if (!chunk) return undefined;
  try {
    return chunk();
  } catch {
    return undefined;
  }
}

// Lua: map_preview_screen.lua:121
function rgba_to_image(rgba: string | undefined, w: number, h: number): Image | undefined {
  if (!rgba || rgba.length < w * h * 4) return undefined;
  let imageData;
  try {
    imageData = newImageData(w, h, "rgba8", rgba);
  } catch {
    imageData = undefined;
  }
  if (!imageData) {
    imageData = newImageData(w, h);
    let i = 1;
    for (let y = 0; y <= h - 1; y++) {
      for (let x = 0; x <= w - 1; x++) {
        imageData.setPixel(x, y,
          (byte(rgba, i) ?? 0) / 255,
          (byte(rgba, i + 1) ?? 0) / 255,
          (byte(rgba, i + 2) ?? 0) / 255,
          (byte(rgba, i + 3) ?? 0) / 255);
        i = i + 4;
      }
    }
  }
  const image = G.newImage(imageData);
  if (image.setFilter) image.setFilter("nearest", "nearest");
  return image;
}

// Lua: map_preview_screen.lua:254
function scriptRunning(): boolean {
  // package.loaded["src.core.game3.scripting.space"]
  const vm: any = Space ? Space.vm : undefined;
  return !!(vm && vm.isRunning && vm.isRunning());
}

// src/palette.c:113
// Lua: map_preview_screen.lua:362
function paletteFadeUpdate(f: PalFade): boolean {
  if (!f.active) return false;
  if (f.pending) return true;
  if (f.finishing) {
    // src/palette.c:757
    if (f.counter === 4) {
      f.active = false;
      f.finishing = false;
      f.counter = 0;
      return false;
    }
    f.counter = f.counter + 1;
    return true;
  }
  if (f.toggle === 0) f.bgY = f.y;
  f.toggle = 1 - f.toggle;
  if (f.toggle === 0) {
    if (f.y === f.targetY) {
      f.finishing = true;
    } else if (f.dec) {
      f.y = Math.max(f.targetY, f.y - f.deltaY);
    } else {
      f.y = Math.min(f.targetY, f.y + f.deltaY);
    }
  }
  // src/palette.c:126
  f.pending = !f.finishing;
  return true;
}

// src/palette.c:151
// Lua: map_preview_screen.lua:393
function paletteFadeBegin(delay: number, startY: number, targetY: number): PalFade {
  const f: PalFade = {
    deltaY: 2, y: startY, targetY, dec: startY >= targetY,
    toggle: 0, finishing: false, counter: 0, active: true, bgY: startY,
    pending: false,
  };
  if (delay < 0) f.deltaY = f.deltaY - delay;
  paletteFadeUpdate(f);
  // src/palette.c:184
  f.pending = false;
  return f;
}

// Lua: map_preview_screen.lua:406
function holdingB(): boolean {
  // package.loaded["src.core.game3.runtime"]
  const game = Runtime ? Runtime._game : undefined;
  const input = game ? game.input : undefined;
  return input && input.isDown && input.isDown("b") ? true : false;
}

// Lua: map_preview_screen.lua:413
function caveStep(c: CavePreview): void {
  if (c.defer) {
    c.defer = false;
    return;
  }
  c.frame = c.frame + 1;
  if (c.step === 0) {
    [c.level, c.color] = [16, 0];
    c.step = 1;
  } else if (c.step === 1) {
    c.step = 2;
  } else if (c.step === 2) {
    c.fade = paletteFadeBegin(-1, 16, 0);
    c.step = 3;
  } else if (c.step === 3) {
    if (!paletteFadeUpdate(c.fade!)) {
      c.duration = MapPreviewScreen.durationFor(c.mapsec);
      c.step = 4;
    }
  } else if (c.step === 4) {
    // src/fldeff_flash.c:458
    c.data1 = c.data1 + 1;
    if (c.data1 > c.duration || holdingB()) {
      c.fade = paletteFadeBegin(-2, 0, 16);
      c.color = 1;
      c.step = 5;
    }
  } else if (c.step === 5) {
    if (!paletteFadeUpdate(c.fade!)) {
      // src/fldeff_flash.c:474
      MapPreviewScreen._cave = undefined;
      CaveTransition.start("enter", c.done, true);
      return;
    }
  }
  if (c.fade) {
    // src/fldeff_flash.c:199 CB2_ChangeMapMain
    paletteFadeUpdate(c.fade);
    c.fade.pending = false;
    c.level = c.fade.bgY;
  }
}

interface NwColors { fill: LuaTable; fg: LuaTable; shadow: LuaTable; bg: LuaTable }

// Lua: map_preview_screen.lua:501
function nameWindowColors(manifest: any): NwColors {
  const nw = manifest ? manifest.name_window : undefined;
  if (!nw) throw new Error("map preview manifest has no name_window");
  const rgb = (key: string): LuaTable => {
    const t = nw[key];
    if (!(t !== null && typeof t === "object" && tonumber(t[1]) != null && tonumber(t[2]) != null && tonumber(t[3]) != null)) {
      throw new Error("map preview name_window." + key + " is malformed");
    }
    return seq(t[1] / 255, t[2] / 255, t[3] / 255, 1);
  };
  return { fill: rgb("fill"), fg: rgb("fg"), shadow: rgb("shadow"), bg: rgb("bg") };
}

let nwManifestCache: any = false, nwColorsCache: NwColors | undefined, nwFontColors: Colors | undefined;
// Lua: map_preview_screen.lua:514
function nameWindowColorsCached(): [NwColors, Colors] {
  const m = MapPreviewScreen.manifest();
  if (m !== nwManifestCache || nwColorsCache == null) {
    nwManifestCache = m;
    nwColorsCache = nameWindowColors(m);
    nwFontColors = { fg: nwColorsCache.fg, shadow: nwColorsCache.shadow, bg: nwColorsCache.bg };
  }
  return [nwColorsCache, nwFontColors!];
}

// Lua: map_preview_screen.lua:524
function drawNameWindow(nameIn: string | undefined): void {
  const [colors, fontColors] = nameWindowColorsCached();
  const f = colors.fill;

  G.setColor(f[1], f[2], f[3], 1);
  G.rectangle("fill", NAME_WINDOW_X, NAME_WINDOW_Y, NAME_WINDOW_W, NAME_WINDOW_H);

  if (!nameIn || nameIn === "") {
    G.setColor(1, 1, 1, 1);
    return;
  }

  // The ROM's English section name, translated like the map popup's.
  const name = Strings(nameIn);
  // MapPreview_CreateMapNameWindow: xctr = 104 - GetStringWidth(FONT_NORMAL, ...)
  const textW = FrlgFont.measure(name);
  let xctr = NAME_WINDOW_W - textW;
  if (xctr < 0) xctr = 0;
  FrlgFont.draw(name, NAME_WINDOW_X + Math.floor(xctr / 2), NAME_WINDOW_Y + NAME_WINDOW_TEXT_Y, {
    colors: fontColors,
  });
  G.setColor(1, 1, 1, 1);
}

// Lua: map_preview_screen.lua:548
function drawOpaque(image: Image, name: string | undefined): void {
  G.setColor(1, 1, 1, 1);
  G.draw(image, 0, 0);
  drawNameWindow(name);
}

// Lua: map_preview_screen.lua:554
function ensureCanvas(): Canvas | undefined {
  if (MapPreviewScreen._canvas) return MapPreviewScreen._canvas;
  let canvas: Canvas | undefined;
  try {
    canvas = G.newCanvas(MapPreviewExtract.WIDTH, MapPreviewExtract.HEIGHT);
  } catch {
    canvas = undefined;
  }
  if (!canvas) return undefined;
  if (canvas.setFilter) canvas.setFilter("nearest", "nearest");
  MapPreviewScreen._canvas = canvas;
  return canvas;
}

// Lua: map_preview_screen.lua:564
function setVoidVeil(r: number, g: number, b: number, a: number): void {
  // package.loaded["src.render.Renderer"]
  const R = renderer();
  if (R) R.voidVeil = seq(r, g, b, a);
}

// Lua: map_preview_screen.lua:569
function drawCave(c: CavePreview): void {
  drawOpaque(c.image, c.name);
  const k = (c.level ?? 0) / 16;
  const v = c.color === 1 ? 1 : 0;
  if (k > 0) {
    G.setColor(v, v, v, k);
    G.rectangle("fill", 0, 0, MapPreviewExtract.WIDTH, MapPreviewExtract.HEIGHT);
    G.setColor(1, 1, 1, 1);
  }
  setVoidVeil(v * k, v * k, v * k, 1);
}

export const MapPreviewScreen = {
  STATE: { IDLE: STATE_IDLE, HOLD: STATE_HOLD, FADE_OUT: STATE_FADE_OUT },

  FADE_OUT_FRAMES,
  DURATION_FIRST_VISIT,
  DURATION_REVISIT,

  // mps.c sHasVisitedMapBefore: a transient EWRAM global that MapPreview_SetFlag
  // refreshes on every ScrCmd_setworldmapflag and that never resets.
  hasVisitedBefore: false,

  _active: false,
  _state: STATE_IDLE,
  _mapsec: undefined as number | undefined,
  _entry: undefined as PreviewEntry | undefined,
  _name: undefined as string | undefined,
  _image: undefined as Image | undefined,
  _timer: 0,
  _duration: 0,
  _fadeFrames: 0,
  _eva: 16,
  _evb: 0,
  _phase: 0,
  _onDone: undefined as (() => void) | undefined,
  _cave: undefined as CavePreview | undefined,

  _cache: undefined as { read?: (rel: string) => string | undefined } | undefined,
  _manifest: undefined as any,
  _manifestTried: false,
  _images: {} as Record<number, Image | undefined>,
  _canvas: undefined as Canvas | undefined,
  _logged: false,

  _nameWindowColors: nameWindowColors,

  // Lua: map_preview_screen.lua:144
  install(cacheIn?: any): void {
    let cache = cacheIn;
    if (!cache || !cache.read) {
      // pcall(require, "src.core.game3.dataset"): always loaded here
      if (Dataset && Dataset.cache) cache = Dataset.cache();
    }
    MapPreviewScreen._cache = cache;
  },

  // Lua: map_preview_screen.lua:152
  manifest(): any {
    if (MapPreviewScreen._manifest) {
      return MapPreviewScreen._manifest;
    }
    const rel = cache_root() + "/" + MapPreviewExtract.CACHE_SUB + "/manifest.lua";
    const t = load_lua(rel);
    if (!(t !== null && typeof t === "object") || !(t.entries !== null && typeof t.entries === "object")) {
      log("no preview manifest at " + rel);
      return undefined;
    }
    MapPreviewScreen._manifest = t;
    return t;
  },

  // Lua: map_preview_screen.lua:166
  ready(): boolean {
    return MapPreviewScreen.manifest() != null;
  },

  /** The map_preview_screen.c entry for a mapsec, or nil when there is none. */
  // Lua: map_preview_screen.lua:171
  entryFor(mapsec: unknown): PreviewEntry | undefined {
    const manifest = MapPreviewScreen.manifest();
    if (!manifest) return undefined;
    const id = tonumber(mapsec);
    if (id == null) return undefined;
    for (const [, e] of ipairs<PreviewEntry>(manifest.entries)) {
      if (e.mapsec === id) return e;
    }
    return undefined;
  },

  /** The mapsec whose baked artwork an entry reuses (PATTERN_BUSH and the six
   *  Tanoby chambers share another section's artwork), or nil. */
  // Lua: map_preview_screen.lua:184
  artworkFor(mapsec: unknown): number | undefined {
    const entry = MapPreviewScreen.entryFor(mapsec);
    if (entry) return entry.artwork;
    return undefined;
  },

  /** Baked artwork Image for a mapsec; nil when it has no preview. */
  // Lua: map_preview_screen.lua:191
  image(mapsec: unknown): Image | undefined {
    const artwork = MapPreviewScreen.artworkFor(mapsec);
    if (artwork == null) return undefined;
    const cached = MapPreviewScreen._images[artwork];
    if (cached) return cached;

    const rel = format("%s/%s/%d.rgba", cache_root(), MapPreviewExtract.CACHE_SUB, artwork);
    const bytes = read_bytes(rel);
    if (!(bytes && bytes.length >= MapPreviewExtract.WIDTH * MapPreviewExtract.HEIGHT * 4)) {
      throw new Error("missing baked artwork " + rel);
    }
    const image = rgba_to_image(bytes, MapPreviewExtract.WIDTH, MapPreviewExtract.HEIGHT);
    MapPreviewScreen._images[artwork] = image;
    return image;
  },

  /** MapPreview_GetDuration: a mapsec with no entry lasts 0 frames. Caves key off
   *  their own world-map flag; forests key off the transient global that
   *  ScrCmd_setworldmapflag refreshed when the section was last entered. */
  // Lua: map_preview_screen.lua:209
  durationFor(mapsec: unknown): number {
    const entry = MapPreviewScreen.entryFor(mapsec);
    if (!entry) return 0;
    if (entry.type === MapPreviewExtract.TYPE_CAVE) {
      return MapPreviewScreen.isFlagSet(entry.flagId) ? DURATION_REVISIT : DURATION_FIRST_VISIT;
    }
    return MapPreviewScreen.hasVisitedBefore ? DURATION_FIRST_VISIT : DURATION_REVISIT;
  },

  /** FlagGet, reading the scripting store first and the runtime session second
   *  (the same two sources map_name_popup.lua consults). */
  // Lua: map_preview_screen.lua:220
  isFlagSet(flagId: unknown): boolean {
    const id = tonumber(flagId);
    if (id == null) return false;
    // package.loaded["src.core.game3.scripting.space"] / [".flags"]: always loaded here
    const store = Space ? Space.store : undefined;
    if (store && Flags && Flags.getFlag) {
      let ok = true, val: unknown;
      try { val = Flags.getFlag(store, null, id); } catch { ok = false; }
      if (ok && val === true) return true;
    }
    // package.loaded["src.core.game3.runtime"]
    const session = Runtime && Runtime.getSession ? Runtime.getSession() : undefined;
    if (session && session.flags && session.flags[id]) return true;
    return false;
  },

  /** True when mapsec has an overworld preview of the given type. Mirrors
   *  MapHasPreviewScreen; the overworld only ever asks for MPS_TYPE_FOREST. */
  // Lua: map_preview_screen.lua:242
  has(mapsec: unknown, type_?: number): boolean {
    const entry = MapPreviewScreen.entryFor(mapsec);
    if (!entry) return false;
    if (type_ == null) return true;
    return entry.type === type_;
  },

  /** MapPreview_SetFlag: capture the pre-visit state, then set the flag. */
  // Lua: map_preview_screen.lua:250
  setVisitedFlag(_flagId: unknown, wasSet: unknown): void {
    MapPreviewScreen.hasVisitedBefore = wasSet !== true;
  },

  // Lua: map_preview_screen.lua:259
  show(mapsec: unknown): boolean {
    const entry = MapPreviewScreen.entryFor(mapsec);
    if (!entry) return false;
    if (entry.type !== MapPreviewExtract.TYPE_FOREST) return false;
    const duration = MapPreviewScreen.durationFor(mapsec);
    if (duration <= 0) return false;
    const image = MapPreviewScreen.image(mapsec);
    if (!image) return false;

    MapPreviewScreen._active = true;
    MapPreviewScreen._state = STATE_HOLD;
    MapPreviewScreen._mapsec = entry.mapsec;
    MapPreviewScreen._entry = entry;
    MapPreviewScreen._name = entry.name;
    MapPreviewScreen._image = image;
    MapPreviewScreen._timer = 0;
    MapPreviewScreen._duration = duration;
    MapPreviewScreen._fadeFrames = 0;
    MapPreviewScreen._eva = 16;
    MapPreviewScreen._evb = 0;
    MapPreviewScreen._phase = 0;
    // src/map_preview_screen.c:439
    // package.loaded["src.core.game3.field"]: always loaded here
    if (Field && Field.lock) {
      Field.lock();
      MapPreviewScreen._onDone = (): void => {
        // src/field_fadetransition.c:454
        if (Field.unlock && !scriptRunning() && !(Warp && Warp.isBusy && Warp.isBusy())) {
          Field.unlock();
        }
      };
    }
    return true;
  },

  // Lua: map_preview_screen.lua:295
  dismiss(): void {
    const wasActive = MapPreviewScreen._active;
    MapPreviewScreen._active = false;
    MapPreviewScreen._state = STATE_IDLE;
    MapPreviewScreen._entry = undefined;
    MapPreviewScreen._image = undefined;
    MapPreviewScreen._timer = 0;
    MapPreviewScreen._fadeFrames = 0;
    MapPreviewScreen._eva = 16;
    MapPreviewScreen._evb = 0;
    MapPreviewScreen._phase = 0;
    const onDone = MapPreviewScreen._onDone;
    MapPreviewScreen._onDone = undefined;
    if (wasActive && onDone) onDone();
  },

  // pokefirered/src/main.c:480
  // Lua: map_preview_screen.lua:312
  reset(): void {
    MapPreviewScreen._onDone = undefined;
    MapPreviewScreen.dismiss();
    MapPreviewScreen._cave = undefined;
    CaveTransition.clear();
  },

  // Lua: map_preview_screen.lua:319
  isForestActive(): boolean {
    return MapPreviewScreen._active === true;
  },

  // Lua: map_preview_screen.lua:323
  isActive(): boolean {
    return MapPreviewScreen._active === true || MapPreviewScreen._cave != null
      || CaveTransition.isActive();
  },

  // Lua: map_preview_screen.lua:328
  mapsec(): number | undefined {
    return MapPreviewScreen._mapsec;
  },

  // Lua: map_preview_screen.lua:332
  alpha(): number {
    if (MapPreviewScreen._state !== STATE_FADE_OUT) return 1;
    return MapPreviewScreen._eva / 16;
  },

  // src/fldeff_flash.c:422
  // Lua: map_preview_screen.lua:338
  runCave(mapsec: unknown, done?: () => void): boolean {
    const entry = MapPreviewScreen.entryFor(mapsec);
    if (!entry || entry.type !== MapPreviewExtract.TYPE_CAVE) return false;
    const image = MapPreviewScreen.image(mapsec);
    if (!image) return false;
    MapPreviewScreen._cave = {
      step: 0,
      entry,
      image,
      name: entry.name,
      mapsec: entry.mapsec,
      data1: 0,
      duration: 0,
      fade: undefined,
      level: 16,
      color: 0,
      done,
      frame: 0,
      defer: true,
    };
    return true;
  },

  // Lua: map_preview_screen.lua:456
  update(dt?: number): void {
    let step = Math.floor(((dt ?? (1 / 60)) * 60) + 0.5);
    if (step < 1) step = 1;
    if (MapPreviewScreen._cave || CaveTransition.isActive()) {
      for (let s = 1; s <= step; s++) {
        if (MapPreviewScreen._cave) {
          caveStep(MapPreviewScreen._cave);
        } else if (CaveTransition.isActive()) {
          CaveTransition.update(1 / 60);
        }
      }
      return;
    }
    if (!MapPreviewScreen._active) return;
    for (let s = 1; s <= step; s++) {
      if (MapPreviewScreen._state === STATE_HOLD) {
        // package.loaded["src.ui.game3.fade"]: always loaded here
        const fadingIn = Fade && Fade.isActive && Fade.isActive();
        if (!fadingIn) {
          // src/map_preview_screen.c:505
          MapPreviewScreen._timer = MapPreviewScreen._timer + 1;
          if (MapPreviewScreen._timer > MapPreviewScreen._duration) {
            MapPreviewScreen._state = STATE_FADE_OUT;
            MapPreviewScreen._fadeFrames = 0;
            MapPreviewScreen._phase = 0;
          }
        }
      } else if (MapPreviewScreen._state === STATE_FADE_OUT) {
        // src/map_preview_screen.c:513
        const phase = MapPreviewScreen._phase;
        if (phase === 0) {
          MapPreviewScreen._evb = Math.min(MapPreviewScreen._evb + 1, 16);
        } else if (phase === 1) {
          MapPreviewScreen._eva = Math.max(MapPreviewScreen._eva - 1, 0);
        }
        MapPreviewScreen._phase = (phase + 1) % 3;
        MapPreviewScreen._fadeFrames = MapPreviewScreen._fadeFrames + 1;
        if (MapPreviewScreen._eva === 0 && MapPreviewScreen._evb === 16) {
          MapPreviewScreen.dismiss();
          return;
        }
      }
    }
  },

  // Lua: map_preview_screen.lua:581
  draw(): void {
    if (MapPreviewScreen._cave) {
      drawCave(MapPreviewScreen._cave);
      return;
    }
    if (CaveTransition.isActive()) {
      CaveTransition.draw();
      return;
    }
    if (!MapPreviewScreen._active) return;
    const image = MapPreviewScreen._image ?? MapPreviewScreen.image(MapPreviewScreen._mapsec);
    if (!image) return;
    // src/map_preview_screen.c:532
    setVoidVeil(0, 0, 0, 1 - MapPreviewScreen._evb / 16);
    const alpha = MapPreviewScreen.alpha();
    if (alpha >= 1) {
      drawOpaque(image, MapPreviewScreen._name);
      return;
    }

    const canvas = ensureCanvas();
    if (!canvas) {
      G.setColor(1, 1, 1, alpha);
      G.draw(image, 0, 0);
      G.setColor(1, 1, 1, 1);
      drawNameWindow(MapPreviewScreen._name);
      return;
    }

    const previous = G.getCanvas ? G.getCanvas() : undefined;
    G.setCanvas(canvas);
    G.clear(0, 0, 0, 0);
    drawOpaque(image, MapPreviewScreen._name);
    G.setCanvas(previous);
    G.setColor(1, 1, 1, alpha);
    G.draw(canvas, 0, 0);
    G.setColor(1, 1, 1, 1);
  },
};

export default MapPreviewScreen;
