// Port of gen1recomp src/core/game3/field_weather.lua (GPLv3 + additional terms; see LICENSE.md).
// Field Weather System (Fog, Shade, Rain)
// pokefirered/src/field_weather.c
// pokefirered/src/field_weather_effects.c
//
// Port notes:
// - Lazily required (pcall(lazyReq, ...) from runtime, weather, field_view):
//   registers as G3Lazy["src.core.game3.field_weather"].
// - Cache bytes are a byte string (one char per byte); raw:byte(ptr) is
//   charCodeAt(ptr - 1).

/* eslint-disable @typescript-eslint/no-explicit-any */
import { G } from "../platform/graphics.ts";
import type { Image } from "../platform/image.ts";
import { newImageData } from "../platform/image.ts";
import { ipairs, insert, len, remove, seq, type LuaTable } from "../platform/lt.ts";
import { random } from "../platform/rng.ts";
import { mod, tonumber } from "../../../import/gen3/lua.ts";
import { Dataset } from "./dataset.ts";
import { Weather } from "./weather.ts";
import { G3Lazy } from "./lazy_registry.ts";

const W = 240, H = 160;
const CACHE_ROOT = "data/generated/gba/weather";

interface RainSprite {
  x: number;
  y: number;
  speed: number;
  groundY: number;
  splashTick: number;
  state: string;
}

// Lua: field_weather.lua:20
function loadAssets(): { fog: Image | undefined; rain: Image | undefined } | undefined {
  if (FieldWeather._assets) return FieldWeather._assets;
  const cache: any = Dataset.cache();
  if (!(cache && cache.read)) return undefined;
  const fogRaw: string | undefined = cache.read(CACHE_ROOT + "/fog_horizontal.rgba");
  const rainRaw: string | undefined = cache.read(CACHE_ROOT + "/rain.rgba");

  // Lua: field_weather.lua:27
  const imgFromRgba = (raw: string | undefined, w: number, h: number): Image | undefined => {
    if (!raw || raw.length < w * h * 4) return undefined;
    const imgData = newImageData(w, h);
    let ptr = 1;
    for (let y = 0; y <= h - 1; y++) {
      for (let x = 0; x <= w - 1; x++) {
        const r = raw.charCodeAt(ptr - 1) || 0;
        const g = raw.charCodeAt(ptr) || 0;
        const b = raw.charCodeAt(ptr + 1) || 0;
        const a = raw.charCodeAt(ptr + 2) || 0;
        imgData.setPixel(x, y, r / 255, g / 255, b / 255, a / 255);
        ptr = ptr + 4;
      }
    }
    const img = G.newImage(imgData);
    img.setFilter("nearest", "nearest");
    img.setWrap("repeat", "repeat");
    return img;
  };

  const fogImg = fogRaw ? imgFromRgba(fogRaw, 64, 64) : undefined;
  const rainImg = rainRaw ? imgFromRgba(rainRaw, 16, 192) : undefined;

  FieldWeather._assets = {
    fog: fogImg,
    rain: rainImg,
  };
  return FieldWeather._assets;
}

export const FieldWeather = {
  // Weather.NONE (0): a literal, since module scope must not read the import cycle
  _current: 0 as number,
  _assets: undefined as { fog: Image | undefined; rain: Image | undefined } | undefined,
  _fogScrollOffset: 0,
  _fogScrollCounter: 0,
  _rainSprites: seq() as LuaTable,
  _rainTimer: 0,

  // Lua: field_weather.lua:57
  setWeather(weatherId: unknown): void {
    FieldWeather._current = tonumber(weatherId) ?? Weather.NONE;
    if (FieldWeather._current === Weather.FOG_HORIZONTAL) {
      FieldWeather._fogScrollOffset = 0;
      FieldWeather._fogScrollCounter = 0;
    } else if (FieldWeather._current === Weather.RAIN || FieldWeather._current === Weather.RAIN_THUNDERSTORM) {
      FieldWeather._rainSprites = seq();
      FieldWeather._rainTimer = 0;
    }
  },

  // Lua: field_weather.lua:68
  getWeather(): number {
    const E: any = Weather.rseEngine();
    if (E) return E.getCurrentWeather();
    return FieldWeather._current;
  },

  // Lua: field_weather.lua:74
  update(dt?: number): void {
    if (Weather.isSuspended()) return;
    const E: any = Weather.rseEngine();
    if (E) {
      E.update();
      return;
    }
    const w = FieldWeather._current;

    // pokefirered/src/field_weather_effects.c:1332 FogHorizontal_Main
    if (w === Weather.FOG_HORIZONTAL) {
      FieldWeather._fogScrollCounter = FieldWeather._fogScrollCounter + 1;
      if (FieldWeather._fogScrollCounter > 3) {
        FieldWeather._fogScrollCounter = 0;
        FieldWeather._fogScrollOffset = mod(FieldWeather._fogScrollOffset + 1, 256);
      }
    } else if (w === Weather.RAIN || w === Weather.RAIN_THUNDERSTORM || w === Weather.DOWNPOUR) {
      // Rain particle generation & simulation
      FieldWeather._rainTimer = FieldWeather._rainTimer + (dt ?? (1 / 60));
      const rs = FieldWeather._rainSprites;
      if (len(rs) < 24 && random() < 0.35) {
        insert(rs, {
          x: random(-20, W + 20),
          y: random(-40, -10),
          speed: random(7, 10),
          groundY: random(20, H),
          splashTick: 0,
          state: "falling",
        });
      }

      let i = 1;
      while (i <= len(rs)) {
        const r = rs[i] as RainSprite;
        if (r.state === "falling") {
          r.x = r.x - 2;
          r.y = r.y + r.speed;
          if (r.y >= r.groundY) {
            r.state = "splash";
            r.splashTick = 0;
          }
        } else if (r.state === "splash") {
          r.splashTick = r.splashTick + 1;
          if (r.splashTick >= 6) {
            remove(rs, i);
            i = i - 1;
          }
        }
        i = i + 1;
      }
    }
  },

  // Lua: field_weather.lua:127
  /** Render weather atmospheric layer over the field (before UI/dialogues) */
  drawBelow(camX?: number, camY?: number, canvasW?: number, canvasH?: number): void {
    if (Weather.isSuspended()) return;
    const E: any = Weather.rseEngine();
    if (E) E.drawBelow(camX || 0, camY || 0, canvasW || W, canvasH || H);
  },

  // Lua: field_weather.lua:133
  draw(camX?: number, camY?: number, canvasW?: number, canvasH?: number, exchangeCanvas?: any): void {
    if (Weather.isSuspended()) return;
    const E: any = Weather.rseEngine();
    if (E) {
      E.draw(camX || 0, camY || 0, canvasW || W, canvasH || H, exchangeCanvas);
      return;
    }
    const w = FieldWeather._current;
    if (w === Weather.NONE || w === Weather.SUNNY) return;

    canvasW = canvasW || W;
    canvasH = canvasH || H;
    camX = camX || 0;
    camY = camY || 0;

    const assets = loadAssets();

    // 1. WEATHER_SHADE: Atmospheric gamma dimming without color washout
    // pokefirered/src/field_weather_effects.c:2172 Shade_InitVars (gammaTargetIndex = 3)
    if (w === Weather.SHADE) {
      G.push("all");
      G.setBlendMode("multiply", "premultiplied");
      // Dim factor ~70% (0.70, 0.70, 0.75) for authentic cool shadow tint
      G.setColor(0.68, 0.68, 0.74, 1);
      G.rectangle("fill", 0, 0, canvasW, canvasH);
      G.pop();
    }

    // 2. WEATHER_FOG_HORIZONTAL: 64x64 fog sprites with GBA BLDALPHA (12/16 sprite, 8/16 backdrop)
    // pokefirered/src/field_weather_effects.c:1343 Weather_SetTargetBlendCoeffs(12, 8, 3)
    if (w === Weather.FOG_HORIZONTAL) {
      G.push("all");
      G.setBlendMode("alpha");
      // Alpha blend weight: 12/16 = 0.75
      G.setColor(1, 1, 1, 0.70);

      if (assets && assets.fog) {
        // pokefirered/src/field_weather_effects.c:1332 FogHorizontal_Update
        // In vanilla FireRed, fog sprites are fixed in screen space and drift horizontally
        // (+1 px every 4 frames) with zero camera/map parallax.
        const scrollX = mod(FieldWeather._fogScrollOffset, 64);
        const startX = -scrollX;

        for (let py = 0; py <= canvasH; py += 64) {
          for (let px = startX; px <= canvasW + 64; px += 64) {
            G.draw(assets.fog, px, py);
          }
        }
      } else {
        // Procedural atmospheric horizontal fog bands fallback
        for (let py = 0; py <= canvasH; py += 16) {
          const offset = mod(FieldWeather._fogScrollOffset * 2 + py * 4, 64);
          G.setColor(0.92, 0.95, 1.0, 0.28);
          G.rectangle("fill", -offset, py, canvasW + 64, 12);
        }
      }
      G.pop();
    }

    // 3. WEATHER_RAIN: Falling raindrops and splash particles
    if (w === Weather.RAIN || w === Weather.RAIN_THUNDERSTORM || w === Weather.DOWNPOUR) {
      G.push("all");
      G.setBlendMode("alpha");

      for (const [, r] of ipairs<RainSprite>(FieldWeather._rainSprites)) {
        if (r.state === "falling") {
          G.setColor(0.75, 0.85, 1.0, 0.85);
          G.line(r.x, r.y, r.x - 2, r.y + 7);
        } else if (r.state === "splash") {
          G.setColor(0.85, 0.92, 1.0, 0.65 - (r.splashTick * 0.1));
          G.circle("line", r.x, r.groundY, r.splashTick + 1);
        }
      }

      G.pop();
    }

    G.setColor(1, 1, 1, 1);
  },
};

G3Lazy["src.core.game3.field_weather"] = FieldWeather;

export default FieldWeather;
