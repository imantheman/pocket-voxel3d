// Port of gen1recomp src/core/game3/league_lighting.lua (GPLv3 + additional terms; see LICENSE.md).
// pokefirered/src/field_specials.c:2133
//
// Port notes:
// - Lazily required (runtime / Game3 probe package.loaded): registers as
//   G3Lazy["src.core.game3.league_lighting"].
// - package.loaded / require of space, flags, map, tileset_native, fade,
//   battle, task, dataset: in the bundle (static imports, loaded).
// - load(src, ..., "t", {}) on cache data is luaLoad (platform/luadata.ts).
// - frame() returns Lua's two values as [index, phase].

/* eslint-disable @typescript-eslint/no-explicit-any */
import { len } from "../platform/lt.ts";
import { luaLoad } from "../platform/luadata.ts";
import { tonumber } from "../../../import/gen3/lua.ts";
import { Extract } from "../../../import/gen3/extract_island1.ts";
import { Dataset } from "./dataset.ts";
import { Space } from "./scripting/space.ts";
import { Flags } from "./scripting/flags.ts";
import { Map as MapMod } from "./map.ts";
import { NativeTileset } from "./tileset_native.ts";
import { Fade } from "../ui/fade.ts";
import { battle as Battle } from "./battle.ts";
import { Task } from "./task.ts";
import { G3Lazy } from "./lazy_registry.ts";

// pokefirered/include/constants/flags.h:12
const FLAG_TEMP_2 = 0x2;
const FLAG_TEMP_3 = 0x3;
const FLAG_TEMP_4 = 0x4;
const FLAG_TEMP_5 = 0x5;

// pokefirered/src/field_specials.c:2143
const CHAMPIONS_ROOM = "FR_POKEMON_LEAGUE_CHAMPIONS_ROOM";

export interface LightingState {
  mapId: any;
  set: any;
  slot: number;
  steps: number;
  index: number;
  timer: number;
  phase?: string;
  pair?: string;
  patched?: boolean;
  handle?: any;
}

// Lua: league_lighting.lua:18
function data(): any {
  if (LeagueLighting._data) return LeagueLighting._data;
  const rel = (Extract.CACHE_ROOT || "data/generated/gba") + "/league/lighting.lua";
  const src = (Dataset.cache() as any).read(rel);
  if (!src) return undefined;
  const [chunk] = luaLoad(src, "@" + rel);
  let ok = true;
  let val: any;
  try { val = chunk!(); } catch { ok = false; }
  if (ok && typeof val === "object" && val != null) LeagueLighting._data = val;
  return LeagueLighting._data;
}

// Lua: league_lighting.lua:30
function flag(id: number): boolean {
  // package.loaded["src.core.game3.scripting.space"]
  const S: any = Space;
  return Flags.getFlag(S && S.store, undefined, id) === true;
}

// Lua: league_lighting.lua:36
function currentMap(): any {
  // package.loaded["src.core.game3.map"]
  const M: any = MapMod;
  return M && M.current;
}

// Lua: league_lighting.lua:41
function currentPair(): string | undefined {
  const M: any = MapMod;
  const def = M && M.currentDef && M.currentDef();
  return def && (def.pair || (def.midLayout && def.midLayout.pair));
}

// Lua: league_lighting.lua:47
function apply(st: LightingState, index: number): void {
  const pal = st.set.pals[index + 1];
  if (!pal) return;
  st.pair = st.pair || currentPair();
  if (!st.pair) return;
  NativeTileset.setSlotPalette(st.pair, st.slot, pal);
  st.patched = true;
}

// Lua: league_lighting.lua:57
function restore(st: LightingState | undefined): void {
  if (!(st && st.patched && st.pair)) return;
  NativeTileset.resetSlotPalette(st.pair, st.slot);
  st.patched = false;
}

// Lua: league_lighting.lua:64
function paused(): boolean {
  // package.loaded["src.ui.game3.fade"] / ["src.core.game3.battle"]
  const F: any = Fade;
  if (F && F.isActive && F.isActive()) return true;
  const B: any = Battle;
  if (B && B.isActive && B.isActive()) return true;
  return false;
}

export const LeagueLighting = {
  task: undefined as LightingState | undefined,
  _data: undefined as any,

  // Lua: league_lighting.lua:74
  // pokefirered/src/field_specials.c:2160
  // pokefirered/src/field_specials.c:2187
  tick(st: LightingState): boolean {
    if (currentMap() !== st.mapId) {
      restore(st);
      if (LeagueLighting.task === st) LeagueLighting.task = undefined;
      return true;
    }
    if (st.phase === "cancel") {
      if (flag(FLAG_TEMP_4)) {
        apply(st, len(st.set.pals) - 1);
        st.phase = "held";
      }
      return false;
    }
    if (st.phase !== "run") return false;
    if (paused() || !flag(FLAG_TEMP_2) || flag(FLAG_TEMP_5)) return false;
    st.timer = st.timer - 1;
    if (st.timer !== 0) return false;
    st.index = st.index + 1;
    if (st.index === st.steps) st.index = 0;
    st.timer = st.set.timers[st.index + 1];
    apply(st, st.index);
    return false;
  },

  // Lua: league_lighting.lua:99
  // pokefirered/src/field_specials.c:2133
  start(mapId?: any): boolean {
    const d = data();
    if (!d) return false;
    // pokefirered/src/overworld.c:2105
    restore(LeagueLighting.task);
    LeagueLighting.stop();
    const set = mapId === CHAMPIONS_ROOM ? d.champion : d.e4;
    const st: LightingState = {
      mapId: mapId ?? currentMap(),
      set,
      slot: tonumber(d.palette_slot) ?? 7,
      steps: len(set.timers),
      index: 0,
      timer: set.timers[1],
    };
    if (flag(FLAG_TEMP_3)) {
      st.phase = "cancel";
    } else {
      st.phase = "run";
      apply(st, 0);
    }
    st.handle = Task.spawn(() => LeagueLighting.tick(st));
    LeagueLighting.task = st;
    return true;
  },

  // Lua: league_lighting.lua:127
  // pokefirered/src/field_specials.c:2205
  stop(): void {
    const st = LeagueLighting.task;
    if (!st) return;
    if (st.handle) {
      Task.cancel(st.handle.id);
    }
    LeagueLighting.task = undefined;
  },

  // Lua: league_lighting.lua:136
  reset(): void {
    restore(LeagueLighting.task);
    LeagueLighting.stop();
  },

  // Lua: league_lighting.lua:141
  frame(): [number | undefined, string | undefined] {
    const st = LeagueLighting.task;
    return [st && st.index, st && st.phase];
  },
};

G3Lazy["src.core.game3.league_lighting"] = LeagueLighting;

export default LeagueLighting;
