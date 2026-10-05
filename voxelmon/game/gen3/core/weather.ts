// Port of gen1recomp src/core/game3/weather.lua (GPLv3 + additional terms; see LICENSE.md).
// Field weather session state (H5). Ops setweather / doweather / resetweather.
// pokefirered/include/constants/weather.h
// pokefirered/src/field_weather.c
//
// The RSE engine (src.core.game3.field_weather_rse) is Emerald only and has
// no port: rseEngine() is nil for FireRed's profile and throws for an "rse"
// one. src.core.game3.field_weather is a lazily-required module: apply()
// looks it up in G3Lazy and takes Brian's failed-require path when absent.

import { mod, tonumber } from "../../../import/gen3/lua.ts";
import { G3Lazy } from "./lazy_registry.ts";
import { luaLoad } from "../platform/luadata.ts";
import { Profile } from "./profile.ts";
import { Dataset } from "./dataset.ts";
import { Runtime } from "./runtime.ts";
import { Map as MapMod } from "./map.ts";
import { Field as FieldMod } from "./field.ts";
import { TimeEvents } from "./time_events.ts";
import { SaveSections } from "./save_sections.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

// Lua: weather.lua:45
function rseEngine(): any {
  let row: any;
  try {
    row = Profile.forSession(null);
  } catch {
    return null;
  }
  if (row == null || typeof row !== "object" || row.family !== "rse") return null;
  // NOT FAITHFUL: Emerald only -- src.core.game3.field_weather_rse is not ported.
  throw new Error("NOT FAITHFUL: Emerald only: src.core.game3.field_weather_rse");
}

// Lua: weather.lua:54
function session(): any {
  return Runtime && Runtime.getSession ? Runtime.getSession() ?? null : null;
}

// Lua: weather.lua:59
function syncActive(id: unknown): void {
  Weather.current = tonumber(id) ?? Weather.NONE;
  Weather._active = Weather.current !== Weather.NONE && Weather.current !== Weather.SUNNY;
}

// Lua: weather.lua:64
let cycleCache: any = null;

// Lua: weather.lua:97
function updateRainCounter(newWeather: number, oldWeather: number, sess: any): void {
  if (newWeather !== oldWeather && (newWeather === Weather.RAIN || newWeather === Weather.RAIN_THUNDERSTORM)) {
    if (sess != null && typeof sess === "object") {
      if (sess.gameStats == null || typeof sess.gameStats !== "object") sess.gameStats = {};
      // pokeemerald/include/constants/game_stat.h:44
      const id = 40;
      sess.gameStats[id] = Math.min(0xFFFFFF, Math.floor(tonumber(sess.gameStats[id]) ?? 0) + 1);
    }
  }
}

// Lua: weather.lua:138
function abnormalTarget(E: any, resume: boolean): number {
  let w = Weather.getSaved();
  if (w === Weather.ABNORMAL) {
    w = E.startAbnormal();
  } else {
    E.stopAbnormal();
  }
  if (resume) E.setCurrentAndNextWeather(w); else E.setNextWeather(w);
  return w;
}

// Lua: weather.lua:197
function currentMapId(): any {
  return MapMod ? MapMod.current ?? null : null;
}

// Lua: weather.lua:237
function fieldLocked(): boolean {
  return FieldMod != null && (FieldMod as any).locked === true;
}

// Lua: weather.lua:185 -- pokeemerald/include/global.h:994
// NOT FAITHFUL: Brian registers the "weather" save section at require time;
// the gen3 modules form one import cycle (no calls into other modules at
// load), so it is registered on first use of the weather state instead.
// FireRed's profile lists no save sections, so nothing reads it earlier.
let sectionRegistered = false;
function ensureSaveSection(): void {
  if (sectionRegistered) return;
  sectionRegistered = true;
  SaveSections.register("weather", SaveSections.fields([null, "savedWeather", "weatherCycleStage"], (sess: any) => {
    sess.savedWeather = Weather.NONE;
    sess.weatherCycleStage = 0;
  }));
}

export interface ScriptSavedPin { map: any; seq: number }

export const Weather = {
  // Lua: weather.lua:13
  NONE: 0,
  SUNNY_CLOUDS: 1,
  SUNNY: 2,
  RAIN: 3,
  SNOW: 4,
  RAIN_THUNDERSTORM: 5,
  FOG_HORIZONTAL: 6,
  VOLCANIC_ASH: 7,
  SANDSTORM: 8,
  FOG_DIAGONAL: 9,
  UNDERWATER: 10,
  SHADE: 11,
  DROUGHT: 12,
  DOWNPOUR: 13,
  UNDERWATER_BUBBLES: 14,
  ABNORMAL: 15,
  // pokeemerald/include/constants/weather.h:20
  ROUTE119_CYCLE: 20,
  ROUTE123_CYCLE: 21,

  // Aliases
  FOG: 6,
  ASH: 7,

  current: 0 as number,
  _pending: null as number | null,
  _active: false,
  _suspended: false,

  // pokeemerald/src/field_weather_effect.c:2579
  CYCLE_LENGTH: 4,

  rseEngine,

  // Lua: weather.lua:67 -- pokeemerald/src/field_weather_effect.c:2581
  cycles(): any {
    if (cycleCache) return cycleCache;
    let Ds: any = null;
    let okD = true;
    try { Ds = Dataset; } catch { okD = false; }
    const cache = okD && Ds.cache ? Ds.cache() : null;
    const body = cache && cache.read ? cache.read("data/generated/gba/weather/manifest.lua") : null;
    const chunk = body ? luaLoad(body, "=weather_manifest")[0] : null;
    let ok = false;
    let m: any = null;
    if (chunk) {
      try { m = chunk(); ok = true; } catch { ok = false; }
    }
    if (!(ok && m != null && typeof m === "object" && m.cycles != null && typeof m.cycles === "object")) {
      throw new Error("weather manifest has no cycles table (reimport the Emerald cache)");
    }
    cycleCache = m.cycles;
    return cycleCache;
  },

  // Lua: weather.lua:82
  invalidate(): void {
    cycleCache = null;
  },

  // Lua: weather.lua:87 -- pokeemerald/src/field_weather_effect.c:2596
  translate(weatherIn: unknown, sess?: any): number {
    const weather = tonumber(weatherIn) ?? Weather.NONE;
    if (weather >= Weather.NONE && weather <= Weather.ABNORMAL) return weather;
    const s = sess ?? session() ?? {};
    const stage = mod(tonumber(s.weatherCycleStage) ?? 0, Weather.CYCLE_LENGTH);
    if (weather === Weather.ROUTE119_CYCLE) return Weather.cycles().route119[stage + 1];
    if (weather === Weather.ROUTE123_CYCLE) return Weather.cycles().route123[stage + 1];
    return Weather.NONE;
  },

  // Lua: weather.lua:109 -- pokeemerald/src/field_weather_effect.c:2510
  setSaved(weather: unknown, sess?: any): number {
    ensureSaveSection();
    sess = sess ?? session() ?? {};
    const old = tonumber(sess.savedWeather) ?? Weather.NONE;
    sess.savedWeather = Weather.translate(weather, sess);
    updateRainCounter(sess.savedWeather, old, sess);
    return sess.savedWeather;
  },

  // Lua: weather.lua:118 -- pokeemerald/src/field_weather_effect.c:2517
  getSaved(sess?: any): number {
    ensureSaveSection();
    sess = sess ?? session() ?? {};
    return tonumber(sess.savedWeather) ?? Weather.NONE;
  },

  // Lua: weather.lua:124 -- pokeemerald/src/field_weather_effect.c:2522
  setSavedFromHeader(headerWeather: unknown, sess?: any): number {
    return Weather.setSaved(headerWeather, sess);
  },

  // Lua: weather.lua:129 -- pokeemerald/src/field_weather_effect.c:2529
  setWeather(weather: unknown, sess?: any): void {
    Weather.setSaved(weather, sess);
    const E = rseEngine();
    if (E) {
      E.setNextWeather(Weather.getSaved(sess));
      syncActive(E.getCurrentWeather());
    }
  },

  // Lua: weather.lua:150 -- pokeemerald/src/field_weather_effect.c:2541
  doCurrent(): void {
    const E = rseEngine();
    if (!E) return;
    abnormalTarget(E, false);
    syncActive(E.getCurrentWeather());
  },

  // Lua: weather.lua:158 -- pokeemerald/src/field_weather_effect.c:2560
  resumePaused(): void {
    const E = rseEngine();
    if (!E) return;
    abnormalTarget(E, true);
    E.readyForInit();
    syncActive(E.getCurrentWeather());
  },

  // Lua: weather.lua:167 -- pokeemerald/src/field_weather_effect.c:2622
  updatePerDay(increment: unknown, sess?: any): void {
    ensureSaveSection();
    sess = sess ?? session();
    if (sess == null || typeof sess !== "object") return;
    const stage = (tonumber(sess.weatherCycleStage) ?? 0) + (tonumber(increment) ?? 0);
    sess.weatherCycleStage = mod(stage, Weather.CYCLE_LENGTH);
  },

  // Lua: weather.lua:174
  installRseHooks(): void {
    const perDay = TimeEvents.handlers()[0];
    if (perDay.UpdateWeatherPerDay == null) {
      // pokeemerald/src/clock.c:47
      TimeEvents.onDay("UpdateWeatherPerDay", (sess: any, daysSince: unknown) => {
        Weather.updatePerDay(daysSince, sess);
      });
    }
  },

  // Lua: weather.lua:194
  _applySeq: 0,
  _scriptSaved: null as ScriptSavedPin | null,

  // Lua: weather.lua:202
  set(id: unknown): void {
    if (rseEngine()) {
      // pokeemerald/src/scrcmd.c:706
      Weather.setSaved(id);
      Weather._scriptSaved = { map: currentMapId(), seq: Weather._applySeq };
      return;
    }
    Weather._pending = tonumber(id) ?? Weather.NONE;
  },

  // Lua: weather.lua:212
  doWeather(): void {
    if (rseEngine()) {
      // pokeemerald/src/scrcmd.c:720
      Weather.doCurrent();
      return;
    }
    Weather.current = Weather._pending ?? Weather.current;
    Weather._active = Weather.current !== Weather.NONE && Weather.current !== Weather.SUNNY;
    Weather.apply(Weather.current);
  },

  // Lua: weather.lua:223
  reset(): void {
    ensureSaveSection();
    if (rseEngine()) {
      // pokeemerald/src/scrcmd.c:714
      const def = MapMod && MapMod.currentDef ? MapMod.currentDef() : null;
      Weather.setSavedFromHeader(def ? def.weather ?? Weather.NONE : Weather.NONE);
      return;
    }
    Weather._pending = Weather.NONE;
    Weather.current = Weather.NONE;
    Weather._active = false;
    Weather.apply(Weather.NONE);
  },

  // Lua: weather.lua:242
  apply(id: unknown, opts?: { seamless?: boolean }): void {
    ensureSaveSection();
    const E = rseEngine();
    if (E) {
      Weather.installRseHooks();
      opts = opts ?? {};
      let seamless = opts.seamless;
      if (seamless == null) seamless = !fieldLocked() && E.isStarted();
      const pinned = Weather._scriptSaved;
      // pokeemerald/src/overworld.c:854
      if (!(pinned && pinned.seq === Weather._applySeq && pinned.map === currentMapId())) {
        Weather.setSavedFromHeader(id);
      }
      Weather._applySeq = Weather._applySeq + 1;
      Weather._scriptSaved = null;
      if (seamless) {
        // pokeemerald/src/overworld.c:818
        Weather.doCurrent();
      } else {
        // pokeemerald/src/overworld.c:2147
        E.restart();
        Weather.resumePaused();
      }
      return;
    }

    Weather.current = tonumber(id) ?? Weather.NONE;
    Weather._active = Weather.current !== Weather.NONE && Weather.current !== Weather.SUNNY;

    // Lua: weather.lua:270 pcall(lazyReq, "src.core.game3.field_weather");
    // a missing G3Lazy entry is the failed require
    const FieldWeather = G3Lazy["src.core.game3.field_weather"];
    if (FieldWeather && FieldWeather.setWeather) {
      FieldWeather.setWeather(Weather.current);
    }

    const game = Runtime ? Runtime._game : null;
    const world = game ? (game.overworld ?? game.world) : null;
    if (world && world.setWeather) {
      try { world.setWeather(Weather.current); } catch { /* pcall */ }
    }
  },

  // Lua: weather.lua:283
  get(): number {
    const E = rseEngine();
    if (E) {
      // pokeemerald/src/field_weather.c:1032 GetCurrentWeather
      syncActive(E.getCurrentWeather());
    }
    return Weather.current;
  },

  // Lua: weather.lua:292
  isActive(): boolean {
    if (rseEngine()) Weather.get();
    return Weather._active;
  },

  // Lua: weather.lua:297
  suspend(): void {
    Weather._suspended = true;
  },

  // Lua: weather.lua:301
  resume(): void {
    Weather._suspended = false;
  },

  // Lua: weather.lua:305
  isSuspended(): boolean {
    return Weather._suspended;
  },
};

export default Weather;
