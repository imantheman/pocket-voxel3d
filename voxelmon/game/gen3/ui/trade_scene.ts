// Port of gen1recomp src/ui/game3/trade_scene.lua (GPLv3 + additional terms; see LICENSE.md).
// Draws core/trade_scene's state: the importer's trade sheets (GBA screen,
// cable, link-mon glow, ball) when the cache has them, else a black hold.
//
// Port notes:
// - Lazily required (core/trade_scene's pcall(require, "src.ui.game3.trade_scene")):
//   registers G3Lazy["src.ui.game3.trade_scene"] at the end.
// - Extract.CACHE_ROOT (src.import.gba.extract_island1, no port) proxies onto
//   CachePaths.CACHE_ROOT (extract_island1.lua:21), as core/field.ts reads it.
// - pcall(require, "src.core.game3.dataset") / "src.import.CacheFs": both are
//   in the bundle; `love.filesystem` is Fs; `love.image`/`love.graphics` are
//   always present.
// - NOT FAITHFUL: no io.open on the 3DS. read_bytes' last fallback (io.open
//   on the two relative paths) is dropped; Fs.read already tried both.
// - package.loaded["src.core.game3.scripting.space"]: Space is in the bundle.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { pairs } from "../platform/lt.ts";
import { gsub } from "../platform/lpattern.ts";
import { tonumber, tostring, mod } from "../../../import/gen3/lua.ts";
import { G } from "../platform/graphics.ts";
import { newImageData } from "../platform/image.ts";
import * as Fs from "../platform/fs.ts";
import { luaLoad } from "../platform/luadata.ts";
import { G3Lazy } from "../core/lazy_registry.ts";
import Stack from "./stack.ts";
import Display from "../core/display.ts";
import Chrome from "./chrome.ts";
import FrlgFont from "./frlg_font.ts";
import Pokemon from "../core/pokemon.ts";
import CachePaths from "../core/cache_paths.ts";
import Dataset from "../core/dataset.ts";
import { CacheFs } from "../shared/import/CacheFs.ts";
import Space from "../core/scripting/space.ts";

// Lua: trade_scene.lua:17
function cache_root(): string {
  // (Extract and Extract.CACHE_ROOT) or "data/generated/gba"
  return CachePaths.CACHE_ROOT || "data/generated/gba";
}

// Lua: trade_scene.lua:21
function trade_root(): string {
  return cache_root() + "/" + TradeSceneUi.CACHE_SUB;
}

// Lua: trade_scene.lua:25
function log(msg: unknown): void {
  if (TradeSceneUi._logged) return;
  TradeSceneUi._logged = true;
  console.log("[game3/trade_scene] " + tostring(msg));
}

// Lua: trade_scene.lua:31
function read_bytes(rel: string): string | undefined {
  // pcall(require, "src.core.game3.dataset")
  if (Dataset && Dataset.cache) {
    const cache = Dataset.cache();
    if (cache && cache.read) {
      const d = cache.read(rel);
      if (typeof d === "string" && d.length > 0) return d;
    }
  }
  // pcall(require, "src.import.CacheFs")
  if (CacheFs && CacheFs.readActive) {
    const d = CacheFs.readActive(rel);
    if (typeof d === "string" && d.length > 0) return d;
  }
  {
    let d = Fs.read(rel);
    if (typeof d === "string" && d.length > 0) return d;
    const alt = "data/generated/gba/" + gsub(rel, "^data/generated/gba/", "")[0];
    d = Fs.read(alt);
    if (typeof d === "string" && d.length > 0) return d;
  }
  // NOT FAITHFUL: no io.open on the 3DS (see the port notes).
  return undefined;
}

// Lua: trade_scene.lua:63
function load_lua(rel: string): any {
  const src = read_bytes(rel);
  if (!src) return undefined;
  const [chunk] = luaLoad(src, "@" + rel);
  if (!chunk) return undefined;
  let t: any;
  try { t = chunk(); } catch { return undefined; }
  if (t != null && typeof t === "object") return t;
  return undefined;
}

// Lua: trade_scene.lua:73
function rgba_to_image(rgba: string | undefined, w: number, h: number): any {
  // `love and love.image and love.graphics`: always present here
  if (!rgba || w < 1 || h < 1 || rgba.length < w * h * 4) return undefined;
  let imageData: any;
  try { imageData = newImageData(w, h, "rgba8", rgba); } catch { return undefined; }
  if (!imageData) return undefined;
  const image = G.newImage(imageData);
  if (image.setFilter) image.setFilter("nearest", "nearest");
  return image;
}

// pokefirered/src/trade_scene.c:398 sAnim_GbaScreen_Long
const FLASH_FRAMES = 7;

const SHEETS: Record<string, string> = {
  gba: "gba_screen",
  cableCloseup: "cable_closeup",
  cableEnd: "cable_end",
  linkMonGlow: "link_mon_glow",
  linkMonShadow: "link_mon_shadow",
  monShadowBg: "mon_shadow_bg",
  gbaFlash: "gba_screen_flash",
  ball: "ball",
};

// Lua: trade_scene.lua:175
function draw_mon(pic: any, x: number, y: number, scaleIn?: number): void {
  if (!(pic && pic.image)) return;
  const scale = scaleIn ?? 1;
  if (scale <= 0.02) return;
  G.setColor(1, 1, 1, 1);
  G.draw(pic.image, x, y, 0, scale, scale, 32, 32);
}

// Lua: trade_scene.lua:184
// pokefirered/src/pokeball.c:59 gBallSpriteSheets BALL_POKE
function draw_ball(s: any, art: any, x: number, y: number): void {
  if (art && art.ball) {
    G.setColor(1, 1, 1, 1);
    G.draw(art.ball, x - 8, y - 8);
    return;
  }
  G.setColor(0.86, 0.15, 0.15, 1);
  G.circle("fill", x, y, 7);
  G.setColor(0.94, 0.94, 0.94, 1);
  G.arc("fill", x, y, 7, 0, Math.PI);
  G.setColor(0.1, 0.1, 0.1, 1);
  G.rectangle("fill", x - 7, y - 1, 14, 2);
  G.circle("line", x, y, 2.5);
  if ((s.ballWhite ?? 0) > 0) {
    G.setColor(1, 1, 1, s.ballWhite);
    G.circle("fill", x, y, 8);
  }
}

// Lua: trade_scene.lua:203
function draw_text_window(text: string | undefined): void {
  if (!text || text === "") return;
  // pokefirered/src/trade_scene.c:480 sTradeMessageWindowTemplates
  Chrome.fixedStdFrame(2, 15, 26, 4);
  FrlgFont.draw(text, 16, 122, { maxWidth: 208 });
}

export const TradeSceneUi = {
  CACHE_SUB: "trade",

  _core: undefined as any,
  _art: undefined as any,
  _artTried: false,
  _logged: false,

  // Lua: trade_scene.lua:98
  // pokefirered/src/trade_scene.c:1220 LoadTradeGbaSpriteGfx
  loadArt(): any {
    if (TradeSceneUi._artTried) return TradeSceneUi._art;
    TradeSceneUi._artTried = true;
    const man = load_lua(trade_root() + "/manifest.lua");
    if (!man) {
      log("no trade art in the cache, holding on black through the transfer");
      return undefined;
    }
    const art: any = { manifest: man };
    for (const [key, name] of pairs<string>(SHEETS)) {
      const entry = man[name] ?? man[key];
      const w = tonumber(entry ? entry.width : undefined) ?? 0;
      const h = tonumber(entry ? entry.height : undefined) ?? 0;
      art[key] = rgba_to_image(read_bytes(trade_root() + "/" + name + ".rgba"), w, h);
    }
    if (!art.gba) {
      log("trade manifest has no gba screen sheet, holding on black through the transfer");
      return undefined;
    }
    // pokefirered/src/trade_scene.c:1126
    const center = tonumber((man.gba_screen ?? {}).center_y) ?? (0x15C + 80);
    art.gbaTop = center - art.gba.getHeight() / 2;
    if (art.gbaFlash) {
      const fw = art.gbaFlash.getWidth() / FLASH_FRAMES;
      const fh = art.gbaFlash.getHeight();
      const quads: any[] = [];
      const [dw, dh] = art.gbaFlash.getDimensions();
      for (let i = 0; i <= FLASH_FRAMES - 1; i++) {
        quads[i] = G.newQuad(i * fw, 0, fw, fh, dw, dh);
      }
      art.gbaFlashQuads = quads;
      art.gbaFlashW = fw;
    }
    TradeSceneUi._art = art;
    return art;
  },

  // Lua: trade_scene.lua:134
  invalidate(): void {
    TradeSceneUi._art = undefined;
    TradeSceneUi._artTried = false;
  },

  // Lua: trade_scene.lua:139
  isOpen(): boolean {
    return TradeSceneUi._core != null;
  },

  // Lua: trade_scene.lua:143
  start(core: any): void {
    TradeSceneUi._core = core;
    Stack.push("trade_scene", TradeSceneUi as any, { hideBelow: true, fullscreen: true });
  },

  // Lua: trade_scene.lua:148
  close(): void {
    TradeSceneUi._core = undefined;
    Stack.pop("trade_scene");
  },

  // Lua: trade_scene.lua:154
  // pokefirered/src/trade_scene.c:1103 CB2_InGameTrade
  update(): void {
    const core = TradeSceneUi._core;
    if (!core) return;
    const s = core.state && core.state();
    // pokefirered/src/trade_scene.c:2527 CB2_UpdateLinkTrade
    if (s && s.uiDriven) {
      core.step();
      return;
    }
    // package.loaded["src.core.game3.scripting.space"]
    if (Space && Space.vm) Space.vm.tick();
  },

  // Lua: trade_scene.lua:168
  // pokefirered/src/trade_scene.c:1770
  handleInput(input: any): void {
    const core = TradeSceneUi._core;
    if (!core || !input) return;
    if (core.isLink && core.isLink()) return;
    if (input.wasPressed("a")) core.pressA();
  },

  // Lua: trade_scene.lua:210
  draw(): void {
    const core = TradeSceneUi._core;
    // `not (love and love.graphics)`: always present here
    if (!core) return;
    const s = core.state();
    if (!s) return;
    const art = s.art;

    G.setColor(0, 0, 0, 1);
    G.rectangle("fill", 0, 0, Display.W, Display.H);

    // pokefirered/src/trade_scene.c:1121
    if (art && s.monShadowBg && art.monShadowBg) {
      G.setColor(1, 1, 1, 1);
      G.draw(art.monShadowBg, -(tonumber(s.bg2hofs) ?? 0), 0);
    }

    if (art && s.gbaVisible) {
      G.setColor(1, 1, 1, 1);
      // pokefirered/src/trade_scene.c:678 REG_OFFSET_BG1VOFS
      G.draw(art.gba, 0, (art.gbaTop ?? 0) - (tonumber(s.bg1vofs) ?? 0));
      if (s.cableEnd && art.cableEnd) {
        G.draw(art.cableEnd, 128 - art.cableEnd.getWidth() / 2, 65);
      }
      if (s.flash != null && art.gbaFlash && art.gbaFlashQuads) {
        const idx = Math.floor(mod(s.flash / 2, FLASH_FRAMES));
        const fw = art.gbaFlashW;
        G.draw(art.gbaFlash, art.gbaFlashQuads[idx], 120 - fw / 2,
          80 - art.gbaFlash.getHeight() / 2);
      }
    }

    if (art && s.cableCloseup && art.cableCloseup) {
      G.setColor(1, 1, 1, 1);
      G.draw(art.cableCloseup, 0, 0);
    }

    if (art && s.linkVisible) {
      const y = (s.linkY ?? 0) + (s.linkY2 ?? 0);
      if (art.linkMonGlow) {
        G.setColor(1, 1, 1, 1);
        G.draw(art.linkMonGlow, 128 - art.linkMonGlow.getWidth() / 2,
          y - art.linkMonGlow.getHeight() / 2);
      }
      if (art.linkMonShadow) {
        G.draw(art.linkMonShadow, 128 - art.linkMonShadow.getWidth() / 2,
          y - art.linkMonShadow.getHeight() / 2);
      }
    }

    if (art && s.crossVisible && art.linkMonShadow) {
      G.setColor(1, 1, 1, 1);
      const w2 = art.linkMonShadow.getWidth() / 2;
      const h2 = art.linkMonShadow.getHeight() / 2;
      G.draw(art.linkMonShadow, 111 - w2, (s.crossMonAy ?? 170) + (s.crossY2a ?? 0) - h2);
      G.draw(art.linkMonShadow, 129 - w2, (s.crossMonBy ?? -10) + (s.crossY2b ?? 0) - h2);
    }

    // pokefirered/src/trade_scene.c:757 draws every mon by MON_DATA_SPECIES_OR_EGG
    // pokefirered/src/trade_scene.c:1541
    if (s.crossMonVisible) {
      draw_mon(Pokemon.monFrontPic(s.offer),
        60, 192 + (s.monY2a ?? 0), 1);
      draw_mon(Pokemon.monFrontPic(s.received),
        180, -32 + (s.monY2b ?? 0), 1);
    }

    // pokefirered/src/trade_scene.c:772
    if (s.playerVisible) {
      draw_mon(Pokemon.monFrontPic(s.offer),
        120 + (s.monX2 ?? 0), 60, s.monScale ?? 1);
    }

    // pokefirered/src/trade_scene.c:1716
    if (s.partnerVisible) {
      draw_mon(Pokemon.monFrontPic(s.received),
        120, 60, 1);
    }

    if (s.ballVisible) {
      draw_ball(s, art, s.ballX ?? 120, (s.ballY ?? 32) + (s.ballY2 ?? 0));
    }

    if ((s.whiteBlend ?? 0) > 0) {
      G.setColor(1, 1, 1, s.whiteBlend);
      G.rectangle("fill", 0, 0, Display.W, Display.H);
    }

    if ((s.veil ?? 0) > 0) {
      G.setColor(0, 0, 0, Math.min(1, s.veil));
      G.rectangle("fill", 0, 0, Display.W, Display.H);
    }

    draw_text_window(s.text);
    G.setColor(1, 1, 1, 1);
  },
};

export default TradeSceneUi;

G3Lazy["src.ui.game3.trade_scene"] = TradeSceneUi;
