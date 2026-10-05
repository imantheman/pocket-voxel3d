// Port of gen1recomp src/core/game3/coord_weather.lua (GPLv3 + additional terms; see LICENSE.md).
// pokeemerald/src/coord_event_weather.c

import { tonumber } from "../../../import/gen3/lua.ts";
import { Weather } from "./weather.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

let byTrigger: Record<number, number> | null = null;

export const CoordWeather = {
  // Lua: coord_weather.lua:8 -- pokeemerald/include/constants/weather.h:26
  // (built on first read: no top-level reads of imports)
  get BY_TRIGGER(): Record<number, number> {
    if (byTrigger) return byTrigger;
    byTrigger = {
    [1]: Weather.SUNNY_CLOUDS,
    [2]: Weather.SUNNY,
    [3]: Weather.RAIN,
    [4]: Weather.SNOW,
    [5]: Weather.RAIN_THUNDERSTORM,
    [6]: Weather.FOG_HORIZONTAL,
    [7]: Weather.FOG_DIAGONAL,
    [8]: Weather.VOLCANIC_ASH,
    [9]: Weather.SANDSTORM,
    [10]: Weather.SHADE,
    [11]: Weather.DROUGHT,
    [20]: Weather.ROUTE119_CYCLE,
    [21]: Weather.ROUTE123_CYCLE,
    };
    return byTrigger;
  },

  // Lua: coord_weather.lua:25 -- pokeemerald/asm/macros/map.inc:84
  isWeatherEvent(ev: any): boolean {
    return ev != null && typeof ev === "object" && ev.scriptKey == null && (tonumber(ev.scriptPtr) ?? 0) === 0;
  },

  // Lua: coord_weather.lua:30 -- pokeemerald/src/coord_event_weather.c:108
  run(trigger: unknown): boolean {
    const w = CoordWeather.BY_TRIGGER[tonumber(trigger) ?? -1];
    if (w == null) return false;
    Weather.setWeather(w);
    return true;
  },
};

export default CoordWeather;
