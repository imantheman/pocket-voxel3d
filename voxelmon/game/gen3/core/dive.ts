// Port of gen1recomp src/core/game3/dive.lua (GPLv3 + additional terms; see LICENSE.md).
// pokeemerald/src/field_control_avatar.c:940 -- HM08 Dive. Gated by the
// "dive" capability, which FireRed's profile does not grant.
//
// Return shapes: trySetDiveWarp -> [code, dest]; currentDef -> [def, mapId].

import { tonumber, truthy } from "../../../import/gen3/lua.ts";
import { MB } from "./mb.ts";
import { Runtime } from "./runtime.ts";
import { Map as MapMod } from "./map.ts";
import { Capabilities } from "./capabilities.ts";
import { Space as SpaceMod } from "./scripting/space.ts";
import { Player as PlayerMod } from "./player.ts";
import { Collision as CollisionMod } from "./collision.ts";
import { FieldMoves } from "./field_moves.ts";
import { Field as FieldMod } from "./field.ts";
import { Warp } from "./warp.ts";
import { Task } from "./task.ts";
import { ShowMon } from "./field_move_show_mon.ts";
import { Audio } from "./audio.ts";
import { SE } from "./se_ids.ts";
import { FieldEffects } from "./field_effects.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface DiveDest { map: string; x: number; y: number; warpId?: any }

// Lua: dive.lua:18
function mbIs(beh: number | null | undefined, ...names: string[]): boolean {
  if (beh == null) return false;
  for (const name of names) {
    const id = MB.id(name);
    if (id != null && beh === id) return true;
  }
  return false;
}

// Lua: dive.lua:37
function session(): any {
  return Runtime && Runtime.getSession ? Runtime.getSession() ?? null : null;
}

// Lua: dive.lua:42
function currentDef(): [any, any] {
  const M: any = MapMod;
  return [M && M.currentDef ? M.currentDef() ?? null : null, M ? M.current ?? null : null];
}

// Lua: dive.lua:59 -- pokeemerald/src/overworld.c:756 SetDiveWarp
function setDiveWarp(dir: string, def: any, mapId: any, x: number, y: number, sess: any): DiveDest | null {
  const c = def ? def[dir] : null;
  if (c != null && typeof c === "object" && typeof c.map === "string") {
    return { map: c.map, x, y };
  }
  const Space: any = SpaceMod;
  if (Space && Space.runOnDiveWarp) Space.runOnDiveWarp(mapId);
  const w = sess ? sess.diveWarp : null;
  // pokeemerald/src/overworld.c:563 IsDummyWarp
  if (w == null || typeof w !== "object" || typeof w.map !== "string" || (tonumber(w.x) ?? -1) < 0) return null;
  return { map: w.map, x: tonumber(w.x)!, y: tonumber(w.y)!, warpId: w.warpId };
}

// Lua: dive.lua:90
function badge(sess: any): boolean {
  const Space: any = SpaceMod;
  return truthy(FieldMoves.hasBadge({ store: Space ? Space.store : undefined, session: sess }, "DIVE"));
}

// Lua: dive.lua:96
function fieldFree(): boolean {
  const Field: any = FieldMod;
  if (!(Field && Field.running) || Field.locked) return false;
  const Space: any = SpaceMod;
  if (!(Space && Space.active && Space.startScript)) return false;
  if (Space.vm && Space.vm.isRunning && Space.vm.isRunning()) return false;
  const P: any = PlayerMod;
  if (truthy(P.moving) || truthy(P.jumping)) return false;
  const W: any = Warp;
  if (W && W.isBusy && W.isBusy()) return false;
  return Dive._task == null;
}

// Lua: dive.lua:109
function startScript(label: string): boolean {
  const Space: any = SpaceMod;
  const key = Space.scriptKey(label);
  if (!truthy(key)) throw new Error("dive: script " + label + " is not in the script cache");
  return truthy(Space.startScript(key)) ? true : false;
}

export const Dive = {
  // Lua: dive.lua:12 -- pokeemerald/include/constants/map_types.h:9
  MAP_TYPE_UNDERWATER: 5,

  _task: null as any,

  // Lua: dive.lua:28 -- pokeemerald/src/metatile_behavior.c:853
  isDiveable(beh: number | null | undefined): boolean {
    return mbIs(beh, "INTERIOR_DEEP_WATER", "DEEP_WATER", "SOOTOPOLIS_DEEP_WATER");
  },

  // Lua: dive.lua:33 -- pokeemerald/src/metatile_behavior.c:863
  isUnableToEmerge(beh: number | null | undefined): boolean {
    return mbIs(beh, "NO_SURFACING", "SEAWEED_NO_SURFACING");
  },

  // Lua: dive.lua:47
  enabled(sess?: any): boolean {
    try {
      const has = Capabilities.has(sess ?? session(), "dive");
      return has === true;
    } catch {
      return false;
    }
  },

  // Lua: dive.lua:54
  isUnderwaterMap(def: any): boolean {
    return def != null && typeof def === "object" && tonumber(def.mapType) === Dive.MAP_TYPE_UNDERWATER;
  },

  // Lua: dive.lua:73 -- pokeemerald/src/field_control_avatar.c:965 TrySetDiveWarp
  trySetDiveWarp(sess?: any): [number, DiveDest | null] {
    sess = sess ?? session();
    const P: any = PlayerMod;
    const Collision: any = CollisionMod;
    const [def, mapId] = currentDef();
    const x = P.cellX, y = P.cellY;
    const beh = Collision.behavior(x, y);
    if (Dive.isUnderwaterMap(def) && !Dive.isUnableToEmerge(beh)) {
      const dest = setDiveWarp("emerge", def, mapId, x, y, sess);
      if (dest) return [1, dest];
    } else if (Dive.isDiveable(beh)) {
      const dest = setDiveWarp("dive", def, mapId, x, y, sess);
      if (dest) return [2, dest];
    }
    return [0, null];
  },

  // Lua: dive.lua:117 -- pokeemerald/src/field_control_avatar.c:463 TrySetupDiveDownScript
  tryDiveDown(): boolean {
    const sess = session();
    if (!Dive.enabled(sess) || !fieldFree()) return false;
    if (!badge(sess)) return false;
    const [code] = Dive.trySetDiveWarp(sess);
    if (code !== 2) return false;
    return startScript("EventScript_UseDive");
  },

  // Lua: dive.lua:127 -- pokeemerald/src/field_control_avatar.c:473 TrySetupDiveEmergeScript
  tryEmerge(): boolean {
    const sess = session();
    if (!Dive.enabled(sess) || !fieldFree()) return false;
    if (!badge(sess)) return false;
    if (!Dive.isUnderwaterMap(currentDef()[0])) return false;
    const [code] = Dive.trySetDiveWarp(sess);
    if (code !== 1) return false;
    return startScript("EventScript_UseDiveUnderwater");
  },

  // Lua: dive.lua:137
  isActive(): boolean {
    return Dive._task != null;
  },

  // Lua: dive.lua:142 -- pokeemerald/src/field_effect.c:1902 FldEff_UseDive
  useDive(slot: any, mon?: any): boolean {
    const sess = session();
    if (!mon && sess && sess.party && slot != null) mon = sess.party[slot + 1];
    const Field: any = FieldMod;
    const t: any = { state: 0, mon };
    Dive._task = t;
    Field.lock();
    Field.holdInput(true);
    Task.spawn(() => {
      const Space: any = SpaceMod;
      if (t.state === 0) {
        if (Space && Space.vm && Space.vm.isRunning()) return false;
        Field.lock();
        t.state = 1;
        // pokeemerald/src/field_effect.c:1924
        ShowMon.start(t.mon, { pose: true }, () => { t.state = 2; });
        return false;
      } else if (t.state === 1) {
        Field.lock();
        return false;
      }
      // pokeemerald/src/field_effect.c:1933
      Dive._task = null;
      Field.holdInput(false);
      const [code, dest] = Dive.trySetDiveWarp(sess);
      if (code !== 0 && dest) {
        Audio.playSe(SE.SE_M_DIVE);
        Warp.startDive(Runtime ? Runtime._mod : undefined, Runtime ? Runtime._game : undefined, dest.map, dest.x, dest.y);
      } else {
        Field.unlock();
      }
      return true;
    });
    return true;
  },

  // Lua: dive.lua:181 -- pokeemerald/src/overworld.c:911 GetAdjustedInitialTransitionFlags
  syncAvatar(): void {
    if (!Dive.enabled()) return;
    const P: any = PlayerMod;
    const def = currentDef()[0];
    if (!def) return;
    const under = Dive.isUnderwaterMap(def);
    if (under === (P.underwater === true)) return;
    if (truthy(P.moving)) return;
    if (under) {
      P.underwater = true;
      P.surfing = false;
      return;
    }
    P.underwater = false;
    const Collision: any = CollisionMod;
    if (Collision.isSurfable && Collision.isSurfable(Collision.behavior(P.cellX, P.cellY))) {
      P.surfing = true;
      const A: any = Audio;
      if (A.canOverrideMapMusic(A.MUS_SURF)) {
        A.playMapSong(A.MUS_SURF, { mapSong: A._mapSong });
      }
    }
  },

  // Lua: dive.lua:205
  reset(): void {
    Dive._task = null;
  },

  // Lua: dive.lua:209
  install(): void {
    if (FieldEffects.HANDLERS.FLDEFF_USE_DIVE) return;
    // pokeemerald/src/field_effect.c:1902
    FieldEffects.HANDLERS.FLDEFF_USE_DIVE = () => {
      return Dive.useDive(FieldEffects.fieldEffectArgument(0, 0));
    };
  },
};

export default Dive;
