// The BICYCLE: BikeFunction (engine/events/overworld.asm), the PLAYER_BIKE
// half of DoPlayerMovement (engine/overworld/player_movement.asm), the map
// load's CheckUpdatePlayerSprite (engine/overworld/map_setup.asm) and the
// bike shop's phone call (maps/GoldenrodBikeShop.asm ->
// engine/overworld/events.asm DoBikeStep).
// A port of gen1recomp src/world/gen2/Bike.lua at bdfac727 (MIT).
//
// DoBikeStep lives in StepEvents.ts; this is what puts the player in
// PLAYER_BIKE and the flag the clerk sets.
//
// love-free: every routine takes the map environment, the collision under the
// player and the current wPlayerState as plain values, so the whole decision
// tree is testable without a world. The three scripts BikeFunction queues are
// hand-assembled command lists for the VM, in the shape HiddenItems uses.

import { FieldMoves } from "./FieldMoves.ts";
import { Permissions } from "./Permissions.ts";
import { Strings } from "../shared/core/Strings.ts";
import { truthy } from "../platform/lua.ts";

/** A special resolved by LABEL through the cache's specialOrder. */
export type SpecialIdFn = (name: string) => number | undefined;

export interface TryBikeCtx {
  environment?: string;
  collision?: number;
  state?: string;
  alwaysOnBike?: unknown;
  [key: string]: any;
}

// Lua: Bike.lua:55-61 -- .CheckEnvironment's first half: CheckOutdoorMap
// (ROUTE or TOWN), plus CAVE and GATE by name. INDOOR, ENVIRONMENT_5 and
// DUNGEON are the three that refuse -- which is why you cannot ride inside a
// Gym but can ride through Union Cave and the Route 32 gatehouse.
const RIDEABLE_ENVIRONMENT: Record<string, true> = {
  TOWN: true, ROUTE: true, CAVE: true, GATE: true,
};

// Lua: Bike.lua:156-168 -- data/text/common_2.asm. None of the three hangs
// off a script pointer -- they are `text_far` targets inside
// engine/events/overworld.asm -- so the extractor never saw them. {STRBUF} is
// wStringBuffer2, which _DoItemEffect filled with the item's name;
// `getitemname` is that same fill here.
const TEXT_GOT_ON_BIKE = Strings.source("{PLAYER} got on the\n{STRBUF}.");
const TEXT_GOT_OFF_BIKE = Strings.source("{PLAYER} got off\nthe {STRBUF}.");
const TEXT_CANT_GET_OFF = Strings.source("You can't get off\nhere!");

// Lua: Bike.lua:170-209 -- Script_GetOnBike and Script_GetOffBike, the same
// six commands with a different PLAYER_* byte and a `special PlayMapMusic` on
// the way out (the bike theme was written into wMapMusic on the way in).
//
// The cart's `refreshmap` and `special UpdateTimePals` are dropped for the
// same reason HiddenItems.itemfinderScript drops them: both repair what the
// PACK overwrote, and the port draws the PACK as a state over an untouched
// world. The `opentext` in front is the mirror of that: the cart inherits the
// PACK's open text box and this port's queued script does not.
//
// `specialId(name)` resolves a special by LABEL; a nil answer just leaves that
// line out rather than dispatching some other special by a counted index.
function stateScript(item: unknown, varValue: number, text: string,
    specialId: SpecialIdFn | undefined, restoreMusic: boolean, silent: unknown): any[] {
  const script: any[] = [];
  if (!truthy(silent)) {
    // .CheckIfRegistered: with wUsingItemWithSelect set, the cart swaps in
    // Script_GetOnBike_Register / Script_GetOffBike_Register, the same state
    // change with the line and the box taken out -- a SELECT press gets on
    // the bike with no text at all.
    script.push({ op: "opentext" });
    script.push({ op: "getitemname", item });
  }
  script.push({ op: "loadvar", args: [Bike.VAR_MOVEMENT, varValue] });
  if (!truthy(silent)) {
    script.push({ op: "rawtext", text });
    script.push({ op: "waitbutton" });
    script.push({ op: "closetext" });
  }
  const update = specialId ? specialId("UpdatePlayerSprite") : undefined;
  if (truthy(update)) script.push({ op: "special", id: update });
  if (restoreMusic) {
    const play = specialId ? specialId("PlayMapMusic") : undefined;
    if (truthy(play)) script.push({ op: "special", id: play });
  }
  script.push({ op: "end" });
  return script;
}

export const Bike = {
  // Lua: Bike.lua:25-31 -- constants/engine_flags.asm. wBikeFlags' three bits
  // and wStatusFlags2's BIKE_SHOP_CALL bit are all reachable from a script as
  // ENGINE_* ids, the namespace Vm's setflag / clearflag writes onto
  // save.engineFlags.
  ENGINE_BIKE_SHOP_CALL_ENABLED: 19,
  ENGINE_STRENGTH_ACTIVE: 23,
  ENGINE_ALWAYS_ON_BIKE: 24,
  ENGINE_DOWNHILL: 25,

  // Lua: Bike.lua:33-39 -- engine/overworld/variables.asm .VarActionTable, and
  // wPlayerState as VAR_MOVEMENT writes it raw. Script_GetOnBike is `loadvar
  // VAR_MOVEMENT, PLAYER_BIKE`, so the mount is one variable write plus a
  // sprite reload.
  VAR_MOVEMENT: 0x08,
  PLAYER_NORMAL_ID: 0,
  PLAYER_BIKE_ID: 1,

  // Lua: Bike.lua:41-45 -- MUSIC_BICYCLE. .GetOnBike fades the current song
  // out, plays this one and writes it into wMapMusic, so the bike theme IS the
  // map's music until the map changes or the player gets off.
  MUSIC_BICYCLE: "Music_Bicycle",

  // Lua: Bike.lua:47-53 -- StepVectors (engine/overworld/map_objects.asm): a
  // normal step is 8 frames of 2 pixels and a fast step 4 frames of 4, so the
  // bike is exactly half the duration of a walk. The port walks a 16-pixel
  // cell in 16 frames, so the ratio is what carries over.
  stepFramesFor(walkFrames?: number): number {
    return Math.max(1, Math.floor((walkFrames ?? 16) / 2));
  },

  // Lua: Bike.lua:63-65
  environmentAllows(environment: unknown): boolean {
    return typeof environment === "string" && RIDEABLE_ENVIRONMENT[environment] === true;
  },

  // Lua: Bike.lua:67-75 -- .CheckEnvironment in full: the environment, then
  // GetPlayerTilePermission `and $f` -- the tile the player is STANDING on has
  // to be a plain LAND_TILE. Doors and stairs are LAND, so this rejects water
  // and walls: the gate that stops a bike being got on mid-surf.
  canUseHere(environment: unknown, collision: number | null | undefined): boolean {
    if (!Bike.environmentAllows(environment)) return false;
    return Permissions.isLand(collision);
  },

  // Lua: Bike.lua:77-99 -- .TryBike. Three answers plus a nil, in the cart's
  // own order:
  //   undefined       .CannotUseBike -- wFieldMoveSucceeded 0, the PACK
  //                   prints OakThisIsntTheTimeText and stays open.
  //   "mount"         PLAYER_NORMAL and the environment allows it.
  //   "dismount"      PLAYER_BIKE, and wBikeFlags' ALWAYS_ON_BIKE is clear.
  //   "cant_get_off"  PLAYER_BIKE on a forced stretch (the Cycling Road's
  //                   ENGINE_ALWAYS_ON_BIKE). Still returns 1 on the cart, so
  //                   the PACK closes and the refusal prints in the overworld.
  // A surfing player falls through every `cp` and lands on .CannotUseBike.
  tryBike(ctx?: TryBikeCtx): "mount" | "dismount" | "cant_get_off" | undefined {
    ctx = ctx ?? {};
    if (!Bike.canUseHere(ctx.environment, ctx.collision)) return undefined;
    const state = truthy(ctx.state) ? ctx.state : FieldMoves.PLAYER_NORMAL;
    if (state === FieldMoves.PLAYER_NORMAL) return "mount";
    if (state === FieldMoves.PLAYER_BIKE) {
      if (truthy(ctx.alwaysOnBike)) return "cant_get_off";
      return "dismount";
    }
    return undefined;
  },

  // Lua: Bike.lua:101-134 -- CheckUpdatePlayerSprite
  // (engine/overworld/map_setup.asm), run on every map load, in the cart's
  // own order:
  //   .CheckForcedBiking          ALWAYS_ON_BIKE puts the player ON the bike,
  //                               whatever they walked in as, and wins outright.
  //   .CheckSurfing               CheckOnWater reads the tile the player is
  //                               STANDING on: a load that lands on water is a
  //                               surfing load, and one that already was keeps
  //                               the sprite it had.
  //   .ResetSurfingOrBikingState  surfing and NOT on water, or riding into an
  //                               INDOOR, ENVIRONMENT_5 or DUNGEON map.
  // `onWater` undefined means the caller could not read the tile at all -- no
  // map up yet -- and the two surf arms are skipped rather than guessed at.
  mapSetupState(state: string, environment: unknown, alwaysOnBike: unknown, onWater: boolean | undefined): string {
    if (truthy(alwaysOnBike)) return FieldMoves.PLAYER_BIKE;
    if (onWater != null) {
      if (onWater) {
        if (FieldMoves.isSurfing(state)) return state;
        return FieldMoves.PLAYER_SURF;
      }
      if (FieldMoves.isSurfing(state)) return FieldMoves.PLAYER_NORMAL;
    }
    if (state !== FieldMoves.PLAYER_BIKE) return state;
    if (environment === "INDOOR" || environment === "ENVIRONMENT_5"
        || environment === "DUNGEON") {
      return FieldMoves.PLAYER_NORMAL;
    }
    return state;
  },

  // Lua: Bike.lua:136-143 -- .GetDPad: on a DOWNHILL map (the Cycling Road), a
  // frame with no direction held is a frame moving DOWN. A held direction,
  // any held direction, wins.
  forcedDirection<D extends string>(dir: D | undefined, downhill: unknown): D | "down" | undefined {
    if (truthy(dir)) return dir;
    if (truthy(downhill)) return "down";
    return undefined;
  },

  // Lua: Bike.lua:145-154 -- .DoStep's pick between STEP_BIKE and STEP_WALK.
  // The DOWNHILL exception is the cart's own: coasting across a slope is
  // SLOWER than coasting down it, so every direction but DOWN gets the walking
  // duration back.
  stepFrames(state: unknown, dir: unknown, downhill: unknown, walkFrames?: number): number {
    const walk = walkFrames ?? 16;
    if (state !== FieldMoves.PLAYER_BIKE) return walk;
    if (truthy(downhill) && dir !== "down") return walk;
    return Bike.stepFramesFor(walk);
  },

  // Lua: Bike.lua:211-214
  mountScript(item: unknown, specialId?: SpecialIdFn, silent?: unknown): any[] {
    return stateScript(item, Bike.PLAYER_BIKE_ID, TEXT_GOT_ON_BIKE,
      specialId, false, silent);
  },

  // Lua: Bike.lua:216-219
  dismountScript(item: unknown, specialId?: SpecialIdFn, silent?: unknown): any[] {
    return stateScript(item, Bike.PLAYER_NORMAL_ID, TEXT_GOT_OFF_BIKE,
      specialId, true, silent);
  },

  // Lua: Bike.lua:221-231 -- Script_CantGetOffBike: no loadvar at all, so
  // wPlayerState is left exactly as it was and the player is still riding
  // when the box closes.
  cantGetOffScript(): any[] {
    return [
      { op: "opentext" },
      { op: "rawtext", text: TEXT_CANT_GET_OFF },
      { op: "waitbutton" },
      { op: "closetext" },
      { op: "end" },
    ];
  },
};

export default Bike;
