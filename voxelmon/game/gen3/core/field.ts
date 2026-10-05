// Port of gen1recomp src/core/game3/field.lua (GPLv3 + additional terms; see LICENSE.md).
// Game3 field loop coordinator (scripts, player input, heal/respawn).
//
// Port notes:
// - lazyReq / package.loaded / pcall(require): every module is in the bundle,
//   so each is a static import used exactly as Brian guards it. Modules with
//   no file in the port at all are marked where they are reached:
//   package.loaded probes read nil; lazyReq of one throws NotPortedError (as a
//   failed require would), via lazyReqMissing().
// - The `locked` metatable property (field.lua:47) is an accessor on Field.
// - Multiple returns are 0-based tuples: Field.useItemfinder -> [ok, kind,
//   text, info]; Field.fishingPose -> [g, x2, y2] (or []).
// - RSE / Emerald-only branches throw "NOT FAITHFUL: Emerald only".

/* eslint-disable @typescript-eslint/no-explicit-any */
import { notPorted } from "../notported.ts";
import { seq, len, ipairs, pairs, concat, type LuaTable } from "../platform/lt.ts";
import { truthy, tostring, tonumber, format, char } from "../../../import/gen3/lua.ts";
import { luaLoad } from "../platform/luadata.ts";
import Player from "./player.ts";
import ModRuntime from "../shared/mods/Runtime.ts";
import RomText from "./rom_text.ts";
import MapPreviewScreen from "../ui/map_preview_screen.ts";
import SaveSchemaFirered from "./save_schema_firered.ts";
import Dive from "./dive.ts";
import PcAnim from "./pc_anim.ts";
import Collision from "./collision.ts";
import Objects from "./objects.ts";
import AssetStream from "./asset_stream.ts";
import Follower from "../world/Follower.ts";
import Warp from "./warp.ts";
import Doors from "./doors.ts";
import Gen3Compat from "../shared/mods/Gen3Compat.ts";
import ForcedMovement from "./forced_movement.ts";
import Space from "./scripting/space.ts";
import Ghosts from "./ghosts.ts";
import MapMod from "./map.ts";
import Hud from "../ui/hud.ts";
import Runtime from "./runtime.ts";
import Message from "../ui/message.ts";
import TilesetAnim from "./tileset_anim.ts";
import FieldEffects from "./field_effects.ts";
import SpecialAnim from "./special_field_anim.ts";
import StepEvents from "./step_events.ts";
import Profile from "./profile.ts";
import InteractionScripts from "./scripting/interaction_scripts.ts";
import Flags from "./scripting/flags.ts";
import Adapters from "./scripting/adapters.ts";
import Bag from "./bag.ts";
import Audio from "./audio.ts";
import Items from "./items.ts";
import ItemsData from "./items_data.ts";
import Ctx from "./scripting/ctx.ts";
import SE from "./se_ids.ts";
import FieldMoves from "./field_moves.ts";
import Choice from "../ui/choice.ts";
import Task from "./task.ts";
import Pokemon from "./pokemon.ts";
import Constants from "./constants.ts";
import FieldModules from "./field_modules.ts";
import QuestLogRecorder from "./quest_log_recorder.ts";
import RegionMap from "../ui/region_map.ts";
import Fade from "../ui/fade.ts";
import Encounters from "./encounters.ts";
import BattleBridge from "./battle_bridge.ts";
import OwSprites from "./ow_sprites.ts";
import Rng from "./rng.ts";
import CachePaths from "./cache_paths.ts";
import Dataset from "./dataset.ts";
import MapSectionsExtract from "../../../import/gen3/map_sections_extract.ts";
import Battle from "./battle.ts";
import Safari from "./safari.ts";
import HealLocations from "./heal_locations.ts";
import Party from "./party.ts";
import MapIds from "./map_ids.ts";
import Weather from "./weather.ts";
import ScriptColl from "./scripting/collision.ts";
import FieldView from "./field_view.ts";
import LayoutNative from "./layout_native.ts";

// Lua: field.lua:3 (lazyReq) -- for a module that has no file in the port yet
// (it is outside the stubbed require closure): require fails, as in Lua.
function lazyReqMissing(name: string): any {
  return notPorted(`require("${name}") (no such module in the port yet)`);
}

type Fn = (...a: any[]) => any;

export interface FieldModule {
  _locks: Record<string, boolean>;
  locked: boolean;
  running: boolean;
  _mod: any;
  _game: any;
  _session: any;
  weather: number;
  metatileOverrides: Record<string, Record<number, { x: number; y: number; metatile: any; impassable: boolean }>>;
  _overrideLayouts: Record<string, any>;
  _waterfall: { dir: string; wait: number; started: boolean; steps: number } | null | undefined;
  _tempFlagMap: any;
  _holdInput: boolean;
  _flyLanding: boolean | null | undefined;
  _fallWarp: boolean;
  _fieldCallback: boolean;
  _obtainSeq: { second: any; delay: number } | null | undefined;
  _frameTasks: LuaTable;
  _fishing: {
    rod: number; step: string; timer: number; dots: number; required: number; rounds: number;
    anim: string; animT: number;
  } | null | undefined;
  FLY_BAKED_REL: string;
  _flyBaked: Record<string | number, FlyDest> | null | undefined;
  _flyBakedRoot: string | null | undefined;
  rseCutPlan: Fn;

  isLocked(): boolean;
  lock(tag?: string): void;
  unlock(tag?: string): void;
  clearMetatiles(layout?: any): void;
  metatileOverrideAt(mapId: any, x: number, y: number): any;
  holdInput(on: any): void;
  start(mod: any, game: any, session: any): void;
  stop(): void;
  getSession(): any;
  update(dt?: number): void;
  callbackPending(): boolean;
  hiddenItemAt(game: any, x: number, y: number, elevation?: number): any;
  pollObtainSequence(): void;
  pickUpHiddenItem(game: any, hidden: any): boolean;
  digUpUnderfootItem(game: any, hidden: any): boolean;
  useItemfinder(session?: any, showOWMessage?: any): [boolean, string, any, any];
  tryCoordEvents(game: any, cx: number, cy: number): boolean;
  onBoulderMoved(game: any, obj: any, cx?: any, cy?: any): boolean;
  tryWalkIntoSign(game: any, dir: string, probe?: any): boolean;
  addFrameTask(fn: () => any): void;
  runFrameTasks(): void;
  interact(game?: any): any;
  rseWaterScript(fx: number, fy: number, behavior: any): string | undefined;
  installRseFieldEffects(): void;
  executeFieldMove(payload: any): void;
  finishSweetScent(payload: any): void;
  tryRockSmashEncounter(): boolean;
  isFishing(): boolean;
  startFishing(rod: any): boolean;
  fishingPose(): [any, any, any] | [];
  tryFishingEncounter(rod: any): boolean;
  updateFishing(): boolean;
  openDottedHoleDoor(): boolean;
  installFlyDestinations(pack: any, root?: string): number;
  loadFlyDestinations(cache?: any, root?: string): number;
  flyDestinationsMounted(): boolean;
  invalidateFlyDestinations(): void;
  flyDestination(section: any): FlyDest | undefined;
  flyTo(section: any, mon: any, info?: any): boolean;
  forcedMovementPending(): boolean;
  pollSafariBalls(game?: any): boolean;
  clearTempFieldEventData(game: any, mapId: any): void;
  pollMapChange(game?: any): boolean;
  rideWaterfall(dir?: string, delay?: any): void;
  updateWaterfall(game?: any): void;
  respawnAtHeal(opts?: any): void;
  resetEliteFour(): void;
  setHealPoint(mapId: any, x: number, y: number): void;
  setRespawn(healLocationId: any): any;
  setWeather(id: any): void;
  setMetatile(x: any, y: any, metatile: any, isImpassable?: any): void;
}

interface FlyDest { map: string; x: number; y: number; healLocation: number | undefined }

// Lua: field.lua:13
export const Field = {} as FieldModule;

// Lua: field.lua:15
const _locks: Record<string, boolean> = {};
Field._locks = _locks;

// Lua: field.lua:18
Field.isLocked = function (): boolean {
  if (!Field._locks) return false;
  // next(Field._locks) ~= nil, without allocating
  for (const k in Field._locks) if (Field._locks[k] != null) return true;
  return false;
};

// Lua: field.lua:23
Field.lock = function (tag?: string): void {
  tag = tag ?? "default";
  Field._locks = Field._locks ?? {};
  Field._locks[tag] = true;
};

// Lua: field.lua:29
Field.unlock = function (tag?: string): void {
  if (Field._flyLanding) return;
  // pokefirered/src/field_effect.c:1274 FallWarpEffect_7
  if (Field._fallWarp) return;
  // pokefirered/src/field_effect.c:2532 TeleportInFieldEffectTask3
  if (Field._fieldCallback) return;
  // pokefirered/src/map_preview_screen.c:439
  // package.loaded["src.ui.game3.map_preview_screen"]
  if (MapPreviewScreen && truthy(MapPreviewScreen.isForestActive())) return;

  Field._locks = Field._locks ?? {};
  if (tag != null) {
    delete Field._locks[tag];
  } else {
    delete Field._locks["default"];
  }
};

// Lua: field.lua:47 (setmetatable: the `locked` pseudo-field)
Object.defineProperty(Field, "locked", {
  get(): boolean {
    return Field.isLocked();
  },
  set(v: unknown) {
    if (truthy(v)) {
      Field.lock("default");
    } else {
      Field.unlock("default");
    }
  },
  enumerable: false,
  configurable: true,
});

Field.running = false;
Field._mod = undefined;
Field._game = undefined;
Field._session = undefined;
Field.weather = 0;
Field.metatileOverrides = {};
Field._overrideLayouts = {};
Field._waterfall = undefined;
Field._tempFlagMap = undefined;

// pokefirered/src/event_object_movement.c:8959
const WALK_SLOWER_FRAMES = 32;

// Lua: field.lua:81 -- pokefirered/src/fieldmap.c:103
Field.clearMetatiles = function (layout?: any): void {
  for (const [, written] of pairs<any>(Field._overrideLayouts)) {
    if (written.clearOverrides) written.clearOverrides();
  }
  if (layout && layout.clearOverrides) layout.clearOverrides();
  Field.metatileOverrides = {};
  Field._overrideLayouts = {};
};

// Lua: field.lua:90
Field.metatileOverrideAt = function (mapId: any, x: number, y: number): any {
  const bucket = mapId != null ? Field.metatileOverrides[mapId] : undefined;
  return bucket ? bucket[y * 1024 + x] ?? undefined : undefined;
};

Field._holdInput = false;

// Lua: field.lua:97
Field.holdInput = function (on: any): void {
  Field._holdInput = on === true;
};

// Lua: field.lua:101
Field.start = function (mod: any, game: any, session: any): void {
  if (session && session._continueWarpDeferred) {
    SaveSchemaFirered.useContinueGameWarp(session);
  }
  Field._mod = mod;
  Field._game = game;
  Field._session = session;
  Field.running = true;
  Field._locks = {};
  Field.weather = 0;
  Field._waterfall = undefined;
  Field._fishing = undefined;
  Field._flyLanding = undefined;
  Field._fieldCallback = false;
  Field._holdInput = false;
  if (Player) Player.fishing = false;
  Dive.reset();
  if (truthy(Dive.enabled(session))) {
    Dive.install();
    Field.installRseFieldEffects();
  }
  // pokefirered/src/overworld.c:345
  Field._tempFlagMap = session ? session.map : undefined;
  Field.clearMetatiles();
  // package.loaded["src.core.game3.pc_anim"]
  if (PcAnim) PcAnim.reset();
  // package.loaded["src.ui.game3.seagallop"]: no such module in the port
  const SeagallopUi: any = undefined;
  if (SeagallopUi && SeagallopUi.stop) SeagallopUi.stop();
  if (session) {
    Player.syncFromSession(session);
  } else {
    Player.syncFromHost(game);
  }
  Player.syncSavePosition(game);

  // Bind collision grid + EventObjects for current Sevii map.
  const mapId = session ? session.map : undefined;
  const data = game && game.data && game.data.maps;
  const def = mapId != null && data ? data[mapId] : undefined;
  if (def) {
    Collision.bindMap(game, mapId, def);
    Objects.loadMap(game, mapId, def);
  }
};

// Lua: field.lua:149
Field.stop = function (): void {
  // package.loaded["src.core.game3.asset_stream"]
  const Stream = AssetStream;
  if (Stream) Stream.cancelPending();
  Follower.reset();
  Field.running = false;
  Field._session = undefined;
  Field._locks = {};
  Field._waterfall = undefined;
  Field._fishing = undefined;
  Field._flyLanding = undefined;
  Field._fieldCallback = false;
  // package.loaded["src.core.game3.player"]
  const PlayerMod = Player;
  if (PlayerMod) PlayerMod.fishing = false;
  // package.loaded["src.core.game3.warp"]
  if (Warp && Warp.clear) Warp.clear();
  // package.loaded["src.core.game3.doors"]
  if (Doors && Doors.release) Doors.release();
  Field._tempFlagMap = undefined;
};

// Lua: field.lua:169
Field.getSession = function (): any {
  return Field._session;
};

// Lua: field.lua:173
Field.update = function (_dt?: number): void {
  if (!Field.running) return;
  const game = Field._game;

  // package.loaded["src.mods.Gen3Compat"]
  const Compat = Gen3Compat;
  if (Compat && Compat.worldTick) Compat.worldTick(_dt as number);

  // pokefirered/src/field_tasks.c:66
  ForcedMovement.runStepCallback(game);

  // package.loaded["src.core.game3.scripting.space"]
  if (Space && Space.vm) {
    const ad = Space.vm.adapters;
    if (ad && ad.pollMovement) ad.pollMovement(0);
    Space.vm.tick();
    // pokefirered/src/field_control_avatar.c:212
    if (!truthy(Space.vm.isRunning())) {
      const world = game && (game.overworld || game.world);
      if (!(truthy(Space._deferOnFrameForFade) && world && truthy(world.mapSetup))
          // pokefirered/src/overworld.c:1403
          && !Field.callbackPending()) {
        const claiming = Space._pendingOnFrame;
        Space._pendingOnFrame = false;
        Space._deferOnFrameForFade = false;
        if (truthy(claiming) || !Field.isLocked()) {
          Space.runOnFrame();
          // pokefirered/src/script.c:463 TryRunOnFrameMapScript
          if (truthy(claiming) && !truthy(Space.vm.isRunning())) {
            Field.unlock();
          }
        }
      }
    }
  }

  // package.loaded["src.core.game3.pc_anim"]
  if (PcAnim) PcAnim.update();
  Field.runFrameTasks();

  // Game3 owns locomotion + EventObjects (host World:step is paused).
  Objects.update(game);
  Ghosts.sync();
  Ghosts.update(game);
  // Prepare nearby assets on a worker; share a main-thread texture budget.
  // package.loaded["src.core.game3.map"]
  if (MapMod && MapMod.stepWarm) MapMod.stepWarm(game);

  Field.pollMapChange(game);
  // pokefirered/src/safari_zone.c:60 CB2_EndSafariBattle
  Field.pollSafariBalls(game);

  const input = game ? game.input : undefined;
  // pokefirered/src/field_control_avatar.c:98
  let walkInput = input;
  if (Field.forcedMovementPending() || Field._holdInput) walkInput = undefined;
  // pokeemerald/src/overworld.c:911
  Dive.syncAvatar();
  // pokefirered/src/overworld.c:1402
  // package.loaded["src.core.game3.scripting.natives_events"]: no such module in the port
  const NativesEvents: any = undefined;
  if (NativesEvents && NativesEvents.pollWalkaway) {
    NativesEvents.pollWalkaway(Space && Space.vm, input);
  }
  Player.update(game, walkInput);
  Follower.update(game);
  Field.updateWaterfall(game);
  // pokefirered/src/field_player_avatar.c:1691
  Field.updateFishing();

  // package.loaded["src.core.game3.runtime"] or lazyReq(...) (unused, as in Lua)
  // package.loaded["src.ui.game3.message"]

  // A-button talk / signs / PC — owned here (host pollInput is no-op on Sevii).
  // START / pause menu is owned by Hud.update (avoids same-frame open+close).
  if (input && input.wasPressed && truthy(input.wasPressed("a"))) {
    if (!truthy(Hud.busy())) {
      Field.interact(game);
    }
  }
  // pokeemerald/src/field_control_avatar.c:153
  if (input && input.wasPressed && truthy(input.wasPressed("b")) && !truthy(Hud.busy())) {
    Dive.tryEmerge();
  }

  // Pret General tileset anims (water / flower / sand edge).
  // pcall(lazyReq, "src.core.game3.tileset_anim")
  if (TilesetAnim && TilesetAnim.step) {
    TilesetAnim.step();
  }

  // pcall(lazyReq, "src.core.game3.field_effects")
  if (FieldEffects && FieldEffects.step) {
    FieldEffects.step();
  }

  // pcall(lazyReq, "src.core.game3.doors")
  if (Doors && Doors.update) {
    Doors.update();
  }

  // pcall(lazyReq, "src.core.game3.special_field_anim")
  if (SpecialAnim && SpecialAnim.update) {
    SpecialAnim.update();
  }

  // pcall(lazyReq, "src.core.game3.step_events")
  if (StepEvents && StepEvents.update) {
    StepEvents.update(_dt, game);
  }

  if (Message && Message.tick) Message.tick();
  Field.pollObtainSequence();
  lazyReqMissing("src.core.game3.itemfinder").update();
};

// pokefirered/src/field_effect.c:1104 FieldCallback_FlyIntoMap
Field._flyLanding = false;

// pokefirered/src/field_effect.c:1155 FieldCB_FallWarpExit
Field._fallWarp = false;

// pokefirered/src/overworld.c:117 gFieldCallback
Field._fieldCallback = false;

// Lua: field.lua:300
Field.callbackPending = function (): boolean {
  if (Field._fieldCallback || Field._flyLanding || Field._fallWarp) return true;
  const mapBlock = Field._session ? Profile.forSession(Field._session).map : undefined;
  if (mapBlock && truthy(mapBlock.onFrameAfterWarpExit)) {
    // package.loaded["src.core.game3.warp"]
    // pokeemerald/src/field_screen_effect.c:317
    if (Warp && truthy(Warp.isBusy())) return true;
  }
  return false;
};

const DELTA: Record<string, [number, number]> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

// Lua: field.lua:313
function facing_cell(px: number, py: number, facing: any): [number, number] {
  const d = DELTA[facing ?? "down"] ?? DELTA.down!;
  return [px + d[0], py + d[1]];
}

// Lua: field.lua:319
/** Object cell for talk (pret CheckFacingObject): double past COLL_COUNTER desks. */
function facing_object_cell(fx: number, fy: number, facing: any): [number, number] {
  const CollisionStd = lazyReqMissing("src.core.game3.scripting.collision_std");
  const coll = Collision.cell ? Collision.cell(fx, fy) : undefined;
  if (truthy(CollisionStd.isCounter(coll))) {
    const d = DELTA[facing ?? "down"] ?? DELTA.down!;
    return [fx + d[0], fy + d[1]];
  }
  return [fx, fy];
}

// Lua: field.lua:330
function get_map_bg_events(game: any, mapId?: any): LuaTable {
  const session = Field._session;
  mapId = mapId ?? (session ? session.map : undefined);
  const data = game && game.data && game.data.maps;
  const def = mapId != null && data ? data[mapId] : undefined;
  let events = def ? def.bgEvents : undefined;
  if (!events) {
    // package.loaded["src.core.game3.scripting.space"]
    const ev = Space && Space.bundle && Space.bundle.events && Space.bundle.events[mapId];
    events = ev ? ev.bgEvents : undefined;
  }
  return events ?? {};
}

// Lua: field.lua:344
function bg_event_at(game: any, fx: number, fy: number, elevation: number, facingDir: number): any {
  const events = get_map_bg_events(game);
  for (const [, ev] of ipairs<any>(events)) {
    if (ev.scriptKey && InteractionScripts.backgroundMatches(ev, fx, fy, elevation, facingDir)) {
      return ev;
    }
  }
  return undefined;
}

// Lua: field.lua:354 -- returns store, Space (Space only for the live session)
function hidden_item_store(session: any): [any, any] {
  // package.loaded["src.core.game3.runtime"] / ["src.core.game3.scripting.space"]
  if (session && Runtime && Runtime.getSession && Runtime.getSession() === session
      && Space && Space.store) {
    return [Space.store, Space];
  }
  return [session ? session.store || session : session, undefined];
}

// Lua: field.lua:364
function hidden_item_at(game: any, x: number, y: number, _elevation?: number): any {
  const session = Field._session;
  const events = get_map_bg_events(game);
  const store = hidden_item_store(session)[0];
  for (const [, ev] of ipairs<any>(events)) {
    if ((ev.type === "hidden_item" || ev.kind === 7) && ev.x === x && ev.y === y) {
      const flag = ev.flag ?? (ev.hiddenItemId != null ? 0x3E8 + ev.hiddenItemId : undefined);
      if (flag != null && !truthy(Flags.getFlag(store, undefined, flag))) {
        return ev;
      }
    }
  }
  return undefined;
}

// Lua: field.lua:380
Field.hiddenItemAt = function (game: any, x: number, y: number, elevation?: number): any {
  return hidden_item_at(game || Field._game, x, y, elevation);
};

// pokefirered/include/constants/menu.h:107
const STDSTRING_COINS = 23;
const POCKET_STDSTRING: Record<string, number> = {
  ITEMS: 24, KEY_ITEMS: 25, POKE_BALLS: 26, TM_CASE: 27, BERRY_POUCH: 28,
};

// Lua: field.lua:390
function std_string(id: number): any {
  return Adapters.stdString(id);
}

// Lua: field.lua:394
function player_name(session: any): any {
  return (session ? session.playerName ?? session.name : undefined) ?? "RED";
}

Field._obtainSeq = undefined;

// Lua: field.lua:401 -- pokefirered/data/scripts/obtain_item.inc:170
function message_then_after_fanfare(first: any, second: any, delay?: number): void {
  Message.showStay(first, { session: Field._session });
  Field._obtainSeq = { second, delay: delay ?? 0 };
}

// Lua: field.lua:407
Field.pollObtainSequence = function (): void {
  const seq = Field._obtainSeq;
  if (!seq) return;
  // package.loaded["src.ui.game3.message"]
  if (!(Message && truthy(Message.isOpen()))) {
    Field._obtainSeq = undefined;
    return;
  }
  if (!truthy(Message.isWaiting())) return;
  // package.loaded["src.core.game3.audio"]
  if (Audio && Audio.isFanfareFinished && !truthy(Audio.isFanfareFinished())) return;
  if (seq.delay > 0) {
    seq.delay = seq.delay - 1;
    return;
  }
  Field._obtainSeq = undefined;
  Message.show(seq.second, { session: Field._session, done: () => { Message.close(); } });
};

// Lua: field.lua:426
function hidden_flag(hidden: any): any {
  return hidden.flag ?? (hidden.hiddenItemId != null ? 0x3E8 + hidden.hiddenItemId : undefined);
}

// Lua: field.lua:431 -- pokefirered/src/field_specials.c:158
function set_hidden_item_flag(game: any, hidden: any): void {
  const session = Field._session;
  const [store, SpaceMod] = hidden_item_store(session);
  const flag = hidden_flag(hidden);
  if (flag != null && store) {
    Flags.setFlag(store, undefined, flag, true);
    if (SpaceMod) SpaceMod.persistSession(undefined, game || Field._game);
  }
}

// Lua: field.lua:442 -- pokefirered/data/scripts/obtain_item.inc:197
function pick_up_hidden_coins(game: any, hidden: any, qty: any): boolean {
  const session = Field._session;
  const Corner = lazyReqMissing("src.core.game3.scripting.natives_corner");
  const store = hidden_item_store(session)[0];
  const ctx = { playerName: player_name(session), stringVars: seq(tostring(qty), std_string(STDSTRING_COINS)) };
  const found = RomText.box("Text_FoundXCoins", ctx);
  const refuse = (key: string): boolean => {
    Message.show(found + "\f" + RomText.box(key, ctx), { session, done: () => { Message.close(); } });
    return true;
  };
  // pokefirered/include/constants/flags.h:604
  if (!truthy(Flags.getFlag(store, undefined, 0x243))) {
    return refuse("Text_NothingToPutThemIn");
  }
  if (Corner.checkAddCoins(Bag.Coins.get(session), qty) === 0) {
    return refuse("Text_CoinCaseIsFull");
  }
  Bag.Coins.add(session, qty);
  set_hidden_item_flag(game, hidden);
  Audio.playFanfare("MUS_LEVEL_UP");
  message_then_after_fanfare(found, RomText.box("Text_PutCoinsAwayInCoinCase", ctx));
  return true;
}

// Lua: field.lua:471 -- pokefirered/data/scripts/obtain_item.inc:158
function pick_up_hidden_item(game: any, hidden: any, qty: any, foundKey: string, delay?: number): boolean {
  const session = Field._session;
  const itemId = hidden.item;
  const ctx = { playerName: player_name(session), stringVars: seq<any>("", Items.displayName(itemId)) };
  const found = RomText.box(foundKey, ctx);
  const bag = session ? session.bag : undefined;
  if (!bag || !truthy(Bag.add(bag, itemId, qty)[0])) {
    // pokefirered/data/scripts/obtain_item.inc:190
    Message.show(found + "\f" + RomText.box("Text_TooBadBagFull", ctx),
      { session, done: () => { Message.close(); } });
    return true;
  }
  set_hidden_item_flag(game, hidden);
  // pokefirered/data/scripts/obtain_item.inc:27
  Audio.playFanfare("MUS_LEVEL_UP");
  ctx.stringVars[3] = std_string(POCKET_STDSTRING[ItemsData.pocketOf(itemId)] ?? POCKET_STDSTRING.ITEMS!);
  message_then_after_fanfare(found, RomText.box("Text_PutItemAway", ctx), delay);
  return true;
}

// Lua: field.lua:497 -- pokefirered/data/scripts/obtain_item.inc:148
Field.pickUpHiddenItem = function (game: any, hidden: any): boolean {
  if (!hidden) return false;
  const session = Field._session;
  const store = hidden_item_store(session)[0];
  const flag = hidden_flag(hidden);
  if (flag != null && truthy(Flags.getFlag(store, undefined, flag))) {
    return false;
  }
  const qty = hidden.quantity ?? 1;
  if (Profile.family(session) === "rse") {
    // pokeemerald/src/field_control_avatar.c:348
    throw new Error("NOT FAITHFUL: Emerald only (hidden item script)");
  }
  if ((tonumber(hidden.item) ?? 0) === 0) {
    return pick_up_hidden_coins(game, hidden, qty);
  }
  return pick_up_hidden_item(game, hidden, qty, "Text_FoundOneItem");
};

// Lua: field.lua:522 -- pokefirered/data/scripts/itemfinder.inc:1
Field.digUpUnderfootItem = function (game: any, hidden: any): boolean {
  if (Profile.family(Field._session) === "rse") {
    // pokeemerald/src/item_use.c:597
    throw new Error("NOT FAITHFUL: Emerald only (itemfinder dig)");
  }
  if (!hidden) return false;
  const flag = hidden_flag(hidden);
  if (flag != null && truthy(Flags.getFlag(hidden_item_store(Field._session)[0], undefined, flag))) {
    return false;
  }
  // pokefirered/src/itemfinder.c:245
  return pick_up_hidden_item(game, hidden, 1, "Text_DugUpItemFromGround", 60);
};

// Lua: field.lua:539 -- pokefirered/src/itemfinder.c:131
// Returns [ok, "itemfinder", text, info] (Lua: four values).
Field.useItemfinder = function (session?: any, showOWMessage?: any): [boolean, string, any, any] {
  session = session || Field._session;
  // package.loaded["src.core.game3.player"]
  const P = Player;
  const px = (session ? session.playerX ?? session.x : undefined) ?? (P ? P.cellX ?? P.x : undefined) ?? 0;
  const py = (session ? session.playerY ?? session.y : undefined) ?? (P ? P.cellY ?? P.y : undefined) ?? 0;
  const game = Field._game;
  const mapId = session ? session.map : undefined;
  const Itemfinder = lazyReqMissing("src.core.game3.itemfinder");
  const store = hidden_item_store(session)[0];
  const layout = mapId != null ? MapMod.ensureMidLayout(game, mapId) : undefined;
  const result = Itemfinder.scan({
    px,
    py,
    events: get_map_bg_events(game, mapId),
    flagSet: (ev: any): boolean => {
      const flag = hidden_flag(ev);
      return flag == null || truthy(Flags.getFlag(store, undefined, flag));
    },
    width: layout ? layout.width : undefined,
    height: layout ? layout.height : undefined,
    neighbors: MapMod.neighbors,
    neighborList: MapMod.neighborList,
    eventsFor: (id: any) => get_map_bg_events(game, id),
  });

  if (!result) {
    const text = RomText.box(Itemfinder.textKey("nothing", session));
    if (truthy(showOWMessage)) {
      // pokefirered/src/itemfinder.c:150
      Message.show(text, { session, done: () => { Message.close(); } });
    }
    return [false, "itemfinder", text, undefined];
  }
  const key = Itemfinder.textKey(truthy(result.underfoot) ? "onTop" : "nearby", session);
  const text = RomText.box(key);
  if (truthy(showOWMessage)) {
    Field.lock();
    Itemfinder.start({
      result,
      facing: P ? P.facing : undefined,
      onMessage: (msgKey: any, done: any) => {
        Message.show(RomText.box(msgKey), { session, done });
      },
      onDone: () => {
        if (truthy(result.underfoot)) {
          // pokefirered/src/itemfinder.c:499
          Field.digUpUnderfootItem(game, result.item);
        } else {
          // pokefirered/src/itemfinder.c:485
          Message.close();
        }
        Field.unlock();
      },
    });
  }
  const info = { x: px + result.itemX, y: py + result.itemY, underfoot: result.underfoot };
  return [true, "itemfinder", text, info];
};

const DIR_BY_FACING: Record<string, number> = { down: 1, up: 2, left: 3, right: 4 };

// Lua: field.lua:602
/** Step-onto coord events (Pallet Oak gate, etc.). Returns true if a script started. */
Field.tryCoordEvents = function (game: any, cx: number, cy: number): boolean {
  game = game || Field._game;
  if (!Field.running) return false;
  if (Field.locked) return false;

  // package.loaded["src.core.game3.scripting.space"] or lazyReq(...)
  if (!truthy(Space.active) || !Space.startScript) return false;
  if (Space.vm && Space.vm.isRunning && truthy(Space.vm.isRunning())) {
    return false;
  }

  const session = Field._session;
  const mapId = session ? session.map : undefined;
  const data = game && game.data && game.data.maps;
  const def = mapId != null && data ? data[mapId] : undefined;
  let events = def ? def.coordEvents : undefined;
  if (!events) {
    const ev = Space.bundle && Space.bundle.events && Space.bundle.events[mapId];
    events = ev ? ev.coordEvents : undefined;
  }
  if (events == null || typeof events !== "object") return false;

  const store = Space.store;
  const ctx = (Space.vm && Space.vm.ctx) || Ctx.new();

  const P = Player;
  const facingDir = DIR_BY_FACING[P.facing] ?? 1;

  const CoordWeather = lazyReqMissing("src.core.game3.coord_weather");
  const elevation = tonumber(P.currentElevation ?? P.elevation) ?? 0;
  for (const [, ev] of ipairs<any>(events)) {
    // pokeemerald/src/field_control_avatar.c:883
    if (ev.x === cx && ev.y === cy && truthy(CoordWeather.isWeatherEvent(ev))
        && ((tonumber(ev.elevation) ?? 0) === 0 || tonumber(ev.elevation) === elevation)) {
      CoordWeather.run(ev.var);
    }
    if (ev.x === cx && ev.y === cy && ev.scriptKey) {
      const varId = tonumber(ev.var);
      if (varId != null) {
        const cur = Flags.getVar(store, ctx, varId);
        const want = tonumber(ev.value) ?? 0;
        if (cur !== want) {
          // not this trigger
        } else {
          Space.startScript(ev.scriptKey, undefined, facingDir);
          return true;
        }
      } else {
        Space.startScript(ev.scriptKey, undefined, facingDir);
        return true;
      }
    }
  }
  return false;
};

// pokefirered/include/constants/metatile_behaviors.h:27
const MB_STRENGTH_BUTTON = 0x20;
// pokefirered/include/constants/metatile_behaviors.h:78
const MB_FALL_WARP = 0x66;

// Lua: field.lua:667 -- returns beh, Collision
function boulderCell(_game: any, cx: number, cy: number): [any, any] {
  // package.loaded["src.core.game3.collision"] or lazyReq(...)
  const beh = Collision.behavior ? Collision.behavior(cx, cy) : undefined;
  return [beh, Collision];
}

// Lua: field.lua:675 -- pokefirered/src/field_control_avatar.c:1066
function boulderFallThroughHole(game: any, obj: any, cx: number, cy: number): boolean {
  const [beh, Coll] = boulderCell(game, cx, cy);
  if (beh == null) return false;
  let hole: boolean;
  if (Coll.isFallWarp) {
    hole = truthy(Coll.isFallWarp(beh));
  } else {
    hole = (beh === MB_FALL_WARP);
  }
  if (!hole) return false;

  try {
    if (Audio.playSe && SE.SE_FALL) Audio.playSe(SE.SE_FALL);
  } catch (_e) { /* pcall */ }

  // pokefirered/src/event_object_movement.c:1520 RemoveObjectEventByLocalIdAndMap
  Objects.removeObject(obj.localId ?? (obj.def ? obj.def.localId ?? obj.def.index : undefined));
  obj.moving = false;

  // pokefirered/src/event_object_movement.c:2546
  const reveal = tonumber(obj.trainerType)
    ?? tonumber(obj.def ? obj.def.trainerType : undefined) ?? 0;
  if (reveal > 0 && reveal !== 0xFFFF) {
    // package.loaded["src.core.game3.scripting.space"]
    if (Space && Space.store) {
      Flags.setFlag(Space.store, Space.vm ? Space.vm.ctx : undefined, reveal, false);
    }
    // package.loaded["src.core.game3.objects"]
    if (Objects && Objects.syncFlagVisibility) {
      Objects.syncFlagVisibility(reveal, false);
    }
  }
  return true;
}

// Lua: field.lua:715 -- pokefirered/src/field_control_avatar.c:1076
function boulderActivateVictoryRoadSwitch(game: any, cx: number, cy: number): boolean {
  const [beh, Coll] = boulderCell(game, cx, cy);
  if (beh == null) return false;
  let button: boolean;
  if (Coll.isStrengthButton) {
    button = truthy(Coll.isStrengthButton(beh));
  } else {
    button = (beh === MB_STRENGTH_BUTTON);
  }
  if (!button) return false;

  // package.loaded["src.core.game3.scripting.space"] or lazyReq(...)
  if (!truthy(Space.active) || !Space.startScript) return false;
  if (Space.vm && Space.vm.isRunning && truthy(Space.vm.isRunning())) return false;

  const session = Field._session;
  const mapId = session ? session.map : undefined;
  const data = game && game.data && game.data.maps;
  const def = mapId != null && data ? data[mapId] : undefined;
  let events = def ? def.coordEvents : undefined;
  if (!events) {
    const ev = Space.bundle && Space.bundle.events && Space.bundle.events[mapId];
    events = ev ? ev.coordEvents : undefined;
  }
  if (events == null || typeof events !== "object") return false;

  const P = Player;
  const facingDir = DIR_BY_FACING[P.facing] ?? 1;

  for (const [, ev] of ipairs<any>(events)) {
    if (ev.x === cx && ev.y === cy && ev.scriptKey) {
      Space.startScript(ev.scriptKey, undefined, facingDir);
      return true;
    }
  }
  return false;
}

// Lua: field.lua:756 -- pokefirered/src/field_player_avatar.c:1452
Field.onBoulderMoved = function (game: any, obj: any, cx?: any, cy?: any): boolean {
  game = game || Field._game;
  if (!obj) return false;
  if (!Field.running) return false;
  if (Field.locked) return false;
  cx = tonumber(cx) ?? obj.cellX;
  cy = tonumber(cy) ?? obj.cellY;
  if (cx == null || cy == null) return false;
  const fell = boulderFallThroughHole(game, obj, cx, cy);
  const pressed = boulderActivateVictoryRoadSwitch(game, cx, cy);
  return fell || pressed;
};

// Lua: field.lua:771
/**
 * A-button field interact: NPC talk → bgEvent → metatile interaction → Surf.
 * Returns true if a script (or handled action) started.
 */
function interacted(fx: number, fy: number, kind: string, target: any): void {
  if (!truthy(ModRuntime.wants("world.interacted"))) return;
  // package.loaded["src.core.game3.map"]
  const session = Field._session;
  ModRuntime.emit("world.interacted", {
    mapId: (session ? session.map : undefined) ?? (MapMod ? MapMod.current : undefined),
    x: fx, y: fy, kind, target,
  });
}

let inInteract = false;

// pokefirered/src/field_control_avatar.c:787
const MB_SIGNPOST = 0x84;
const MB_POKEMON_CENTER_SIGN = 0x87;
const MB_POKEMART_SIGN = 0x88;
const WALK_INTO_SIGN: Record<number, string> = {
  [MB_POKEMON_CENTER_SIGN]: "EventScript_PokecenterSign",
  [MB_POKEMART_SIGN]: "EventScript_PokemartSign",
  [0x91]: "EventScript_Indigo_UltimateGoal",
  [0x92]: "EventScript_Indigo_HighestAuthority",
};

// Lua: field.lua:795 -- pokefirered/src/field_control_avatar.c:745
Field.tryWalkIntoSign = function (game: any, dir: string, probe?: any): boolean {
  game = game || Field._game;
  if (dir !== "up" && dir !== "down") return false;
  const FP = Profile.forSession(Field._session);
  if (FP && FP.field && FP.field.walkIntoSigns === false) return false;
  const input = game ? game.input : undefined;
  if (input && input.isDown && (truthy(input.isDown("left")) || truthy(input.isDown("right")))) return false;
  if (!Field.running || Field.locked) return false;
  // package.loaded["src.core.game3.scripting.space"]
  if (!(Space && Space.vm)) return false;
  if (Space.vm.isRunning && truthy(Space.vm.isRunning())) return false;
  const P = Player;
  const [fx, fy] = facing_cell(P.cellX, P.cellY, dir);
  const behavior = Collision.behavior(fx, fy);
  let key: string | undefined;
  if (behavior === MB_POKEMON_CENTER_SIGN || behavior === MB_POKEMART_SIGN) {
    // pokefirered/src/metatile_behavior.c:721
    if (dir === "up") key = WALK_INTO_SIGN[behavior];
  } else if (behavior != null && WALK_INTO_SIGN[behavior]) {
    key = WALK_INTO_SIGN[behavior];
  } else if (behavior === MB_SIGNPOST) {
    // pokefirered/src/field_control_avatar.c:815
    const layout = Collision._mapDef ? Collision._mapDef.midLayout : undefined;
    let elevation = (layout ? layout.elevAt(P.cellX, P.cellY) : undefined) ?? 0;
    if (elevation === 0) elevation = P.elevation ?? 0;
    for (const [, ev] of ipairs<any>(get_map_bg_events(game))) {
      if (ev.scriptKey && ev.x === fx && ev.y === fy
          && (ev.elevation == null || ev.elevation === false || ev.elevation === 0 || ev.elevation === elevation)) {
        key = ev.scriptKey;
        break;
      }
    }
  }
  if (!key) return false;
  if (truthy(probe)) return true;
  const facingDir = (dir === "up") ? 2 : 1;
  if (!truthy(Space.startScript(key, undefined, facingDir))) return false;
  // pokefirered/src/script.c:260
  const ctx = Space.vm.ctx;
  if (ctx) {
    ctx.walkAwayFromSignInhibitTimer = 6;
    ctx.msgBoxIsCancelable = true;
    ctx.canWalkAway = true;
  }
  interacted(fx, fy, "sign", key);
  return true;
};

Field._frameTasks = {};

// Lua: field.lua:847 -- pokeemerald/src/task.c:110
Field.addFrameTask = function (fn: () => any): void {
  Field._frameTasks = Field._frameTasks ?? {};
  Field._frameTasks[len(Field._frameTasks) + 1] = fn;
};

// Lua: field.lua:852
Field.runFrameTasks = function (): void {
  const list = Field._frameTasks;
  if (!list || len(list) === 0) return;
  const keep: LuaTable = {};
  for (const [, fn] of ipairs<() => any>(list)) {
    let ok: boolean, done: any;
    try {
      done = fn();
      ok = true;
    } catch (_e) {
      ok = false;
    }
    if (ok && !truthy(done)) keep[len(keep) + 1] = fn;
  }
  Field._frameTasks = keep;
};

// Lua: field.lua:863
Field.interact = function (game?: any): any {
  game = game || Field._game;
  if (!Field.running) return false;
  // package.loaded["src.mods.Gen3Compat"]
  const Compat = Gen3Compat;
  const replaced = !inInteract && Compat && Compat.interactWrapper && Compat.interactWrapper();
  if (replaced) {
    inInteract = true;
    let ok: boolean, res: any;
    try {
      res = (replaced as (...a: any[]) => any)(Compat.resolve("src.world.OverworldController"));
      ok = true;
    } catch (e) {
      ok = false;
      res = e;
    }
    inInteract = false;
    if (!ok) throw res;
    return res;
  }

  // package.loaded["src.core.game3.runtime"]
  if (Runtime && Runtime.uiBusy && truthy(Runtime.uiBusy())) return false;
  if (Field.locked) return false;

  // package.loaded["src.core.game3.scripting.space"] or lazyReq(...)
  if (Space.vm && Space.vm.isRunning && truthy(Space.vm.isRunning())) {
    return false;
  }
  if (!truthy(Space.active) || !Space.startScript) return false;

  const P = Player;
  if (truthy(P.moving) || truthy(P.boulderPush)) return false;

  const CollisionStd = lazyReqMissing("src.core.game3.scripting.collision_std");

  const [fx, fy] = facing_cell(P.cellX, P.cellY, P.facing);
  const facingDir = DIR_BY_FACING[P.facing] ?? 1;

  const party = Field._session ? Field._session.party : undefined;

  // 1) EventObject (nurse behind counter uses doubled cell; Cut tree / Rock / Boulder)
  const [ox, oy] = facing_object_cell(fx, fy, P.facing);
  const eo = Objects.at(ox, oy);
  if (eo && eo.def) {
    let gfx = eo.def.graphicsId ?? eo.def.gfx;
    const FP = Profile.forSession(Field._session);
    // pokeemerald/data/scripts/field_move_scripts.inc:60
    if (FP.field && truthy(FP.field.fieldMoveScripts) && eo.def.scriptKey) gfx = undefined;
    if (gfx === FieldMoves.GFX_IDS.CUT_TREE) {
      const ctx = { party, store: Space.store, session: Field._session, facingObject: eo };
      const res = FieldMoves.tryCutOW(ctx);
      if (res.ask) {
        Message.show(res.ask, () => {
          Choice.yesNo((yes: any) => {
            if (truthy(yes)) Field.executeFieldMove(res); else Message.close();
          });
        });
        return true;
      } else if (res.text) {
        Message.show(res.text);
        return true;
      }
    } else if (gfx === FieldMoves.GFX_IDS.ROCK_SMASH_ROCK) {
      const ctx = { party, store: Space.store, session: Field._session, facingObject: eo };
      const res = FieldMoves.tryRockSmashOW(ctx);
      if (res.ask) {
        Message.show(res.ask, () => {
          Choice.yesNo((yes: any) => {
            if (truthy(yes)) Field.executeFieldMove(res); else Message.close();
          });
        });
        return true;
      } else if (res.text) {
        Message.show(res.text);
        return true;
      }
    } else if (gfx === FieldMoves.GFX_IDS.PUSHABLE_BOULDER) {
      const ctx = { party, store: Space.store, session: Field._session, facingObject: eo };
      const res = FieldMoves.tryStrengthOW(ctx);
      if (res.ask) {
        Message.show(res.ask, () => {
          Choice.yesNo((yes: any) => {
            if (truthy(yes)) Field.executeFieldMove(res); else Message.close();
          });
        });
        return true;
      } else if (res.text) {
        Message.show(res.text);
        return true;
      }
    } else if (eo.def.scriptKey) {
      const lid = eo.localId ?? eo.def.localId ?? eo.def.index ?? 0;
      const talkTo = Compat && Compat.talkToWrapper && Compat.talkToWrapper();
      if (talkTo && truthy((talkTo as (...a: any[]) => any)(Compat.resolve("src.world.OverworldController"), eo))) {
        interacted(ox, oy, "npc", eo);
        return true;
      }
      const talk = (): void => {
        Objects.freeze(lid);
        Objects.facePlayer(lid, game);
        Space.startScript(eo.def.scriptKey, lid, facingDir);
      };
      if (truthy(ModRuntime.wantsHook("world.talk"))) {
        ModRuntime.call("world.talk", talk, game, eo);
      } else {
        talk();
      }
      interacted(ox, oy, "npc", eo);
      return true;
    }
  }

  // 2) Extracted bgEvents (signs) — face cell only, not doubled
  const layout = Collision._mapDef ? Collision._mapDef.midLayout : undefined;
  let elevation = (layout ? layout.elevAt(P.cellX, P.cellY) : undefined) ?? 0;
  if (elevation === 0) elevation = P.elevation ?? 0;
  const sign = bg_event_at(game, fx, fy, elevation, facingDir);
  if (sign && sign.scriptKey) {
    if (truthy(Space.startScript(sign.scriptKey, undefined, facingDir))) {
      interacted(fx, fy, "sign", sign);
      return true;
    }
  }

  // pokeemerald/src/field_control_avatar.c:354
  if (truthy(FieldMoves.isRse())) {
    throw new Error("NOT FAITHFUL: Emerald only (secret base interact)");
  }

  // pokefirered/src/field_control_avatar.c:498
  const hidden = hidden_item_at(game, fx, fy, elevation);
  if (hidden && !truthy(hidden.underfoot)) {
    if (Field.pickUpHiddenItem(game, hidden)) {
      interacted(hidden.x, hidden.y, "hidden_item", hidden);
      return true;
    }
  }

  // 3) Original metatile interactions follow objects and map-specific scripts.
  const behavior = Collision.behavior(fx, fy);
  let key = InteractionScripts.scriptFor(behavior ?? undefined, P.facing,
    layout ? layout.elevAt(fx, fy) === elevation : undefined);
  if (behavior == null) key = CollisionStd.scriptFor(Collision.cell(fx, fy));
  if (key && truthy(Space.startScript(key, undefined, facingDir))) {
    interacted(fx, fy, "script", key);
    return true;
  }

  // pokeemerald/src/field_control_avatar.c:448 GetInteractedWaterScript
  if (truthy(FieldMoves.isRse())) {
    // pokeemerald/src/field_control_avatar.c:180
    throw new Error("NOT FAITHFUL: Emerald only (water script / dive)");
  }

  // 4) Water / Surf interact on facing water tile
  if (!truthy(P.surfing) && Collision.isWater && truthy(Collision.isWater(fx, fy))) {
    const ctx = { party, store: Space.store, session: Field._session, isFacingWater: true };
    const res = FieldMoves.trySurfOW(ctx);
    if (res.ask) {
      Message.show(res.ask, () => {
        Choice.yesNo((yes: any) => {
          if (truthy(yes)) Field.executeFieldMove(res); else Message.close();
        });
      });
      return true;
    }
  }

  // 5) pokefirered/src/field_control_avatar.c:608
  if (truthy(FieldMoves.isWaterfallBehavior(behavior))) {
    const ctx = {
      party, store: Space.store, session: Field._session,
      isSurfing: P.surfing === true, isFacingWaterfall: true, facing: P.facing,
    };
    const res = FieldMoves.tryWaterfallOW(ctx);
    if (res.ask) {
      Message.show(res.ask, () => {
        Choice.yesNo((yes: any) => {
          if (truthy(yes)) Field.executeFieldMove(res); else Message.close();
        });
      });
      return true;
    } else if (res.text) {
      Message.show(res.text);
      return true;
    }
  }

  return false;
};

// Lua: field.lua:1073 -- pokeemerald/src/field_control_avatar.c:448
Field.rseWaterScript = function (fx: number, fy: number, behavior: any): string | undefined {
  const P = Player;
  // package.loaded["src.core.game3.scripting.space"]
  const ctx = { store: Space ? Space.store : undefined, session: Field._session };
  const party = Field._session ? Field._session.party : undefined;
  if (truthy(FieldMoves.hasBadge(ctx, "SURF")) && truthy(FieldMoves.partyMoveUser(party, "SURF"))
      && !truthy(P.surfing) && !truthy(P.underwater) && truthy(Collision.isWater(fx, fy))) {
    return "EventScript_UseSurf";
  }
  if (truthy(FieldMoves.isWaterfallBehavior(behavior))) {
    if (truthy(FieldMoves.hasBadge(ctx, "WATERFALL")) && truthy(P.surfing) && P.facing === "up") {
      return "EventScript_UseWaterfall";
    }
    return "EventScript_CannotUseWaterfall";
  }
  return undefined;
};

// Lua: field.lua:1093
function deferUntilScriptEnds(fn: () => void): void {
  Field.locked = true;
  Field.holdInput(true);
  Task.spawn(() => {
    // package.loaded["src.core.game3.scripting.space"]
    if (Space && Space.vm && truthy(Space.vm.isRunning())) return false;
    Field.holdInput(false);
    fn();
    return true;
  });
}

// Lua: field.lua:1105
function partyMon(slot: any): any {
  const party = Field._session ? Field._session.party : undefined;
  return party ? party[(tonumber(slot) ?? 0) + 1] ?? undefined : undefined;
}

// Lua: field.lua:1110
Field.installRseFieldEffects = function (): void {
  const H = FieldEffects.HANDLERS;
  // pokeemerald/src/field_effect.c:2985
  H.FLDEFF_USE_SURF = H.FLDEFF_USE_SURF ?? function (): boolean {
    const mon = partyMon(FieldEffects.fieldEffectArgument(0, 0));
    deferUntilScriptEnds(() => { Field.executeFieldMove({ action: "surf", mon }); });
    return true;
  };
  // pokeemerald/src/field_effect.c:1828
  H.FLDEFF_USE_WATERFALL = H.FLDEFF_USE_WATERFALL ?? function (): boolean {
    const mon = partyMon(FieldEffects.fieldEffectArgument(0, 0));
    deferUntilScriptEnds(() => { Field.executeFieldMove({ action: "waterfall", mon }); });
    return true;
  };
};

// Lua: field.lua:1128 -- pokeemerald/src/fldeff_cut.c:138
function rseCutPlan(mon: any): any {
  const P = Player;
  let hyper = false;
  if (mon && mon.species) {
    let okA: boolean, ab: any;
    try {
      ab = Pokemon.abilityId(mon.species, mon.personality);
      okA = true;
    } catch (_e) {
      okA = false;
    }
    const C: any = Constants.of(Profile.forSession(undefined).id);
    hyper = okA && ab != null && ab === C.abilities.byName.ABILITY_HYPER_CUTTER;
  }
  const elev = Collision.elevationAt(P.cellX, P.cellY);
  return FieldMoves.cutGrassPlan({
    x: P.cellX, y: P.cellY, elevation: elev,
    behavior: (x: number, y: number) => Collision.behavior(x, y),
    elevationAt: (x: number, y: number) => Collision.elevationAt(x, y),
    impassable: (x: number, y: number) =>
      !(truthy(Collision.isWalkable(x, y)) || truthy(Collision.isWater(x, y))),
  }, hyper);
}
Field.rseCutPlan = rseCutPlan;

const QUEST_KEYS: Record<string, string> = {
  cut_tree: "UsedCut", cut_grass: "UsedCut", surf: "UsedSurf", strength: "UsedStrength",
  flash: "UsedFlash", rock_smash: "UsedRockSmash", dig: "UsedDigInLocation",
  teleport: "UsedTeleportToLocation", sweet_scent: "UsedSweetScent",
};

// Lua: field.lua:1151
Field.executeFieldMove = function (payload: any): void {
  if (!payload) return;
  const P = Player;

  const act = payload.action;
  // pokefirered/data/scripts/field_moves.inc:12
  if (payload.text && (act === "cut_tree" || act === "rock_smash" || act === "surf")) {
    const rest: any = {};
    for (const [k, v] of pairs(payload)) rest[k] = v;
    delete rest.text;
    Message.show(payload.text, () => {
      Message.close();
      Field.executeFieldMove(rest);
    });
    return;
  }
  const key = QUEST_KEYS[act];
  if (key && Field._session && FieldModules.enabled("questLog", Field._session)) {
    const Q = QuestLogRecorder;
    // pokefirered/src/party_menu.c:4154
    const where = act === "teleport" ? { map: Field._session.healMap } : Field._session;
    // {name, Q.location(...)}: the last call expands to all its values
    Q.event(Field._session, key, seq<any>(Pokemon.displayMonName(payload.mon),
      ...Q.location(Field._game, where)));
  }
  // pokefirered/src/fldeff_rocksmash.c:39
  const showMon = (fn: () => void, opts?: { pose?: boolean; noDuck?: boolean }): void => {
    opts = opts ?? {};
    lazyReqMissing("src.core.game3.field_move_show_mon").start(payload.mon, {
      pose: opts.pose !== false, noDuck: opts.noDuck,
    }, fn);
  };
  if (act === "cut_tree") {
    Field.locked = true;
    // pokefirered/src/fldeff_cut.c:183
    showMon(() => {
      if (payload.se) Audio.playSe(payload.se);
      const target = payload.target;
      const tx = (target ? target.cellX ?? target.x ?? (target.def ? target.def.x : undefined) : undefined) ?? P.cellX;
      const ty = (target ? target.cellY ?? target.y ?? (target.def ? target.def.y : undefined) : undefined) ?? P.cellY;

      FieldEffects.startCutTree(target, tx, ty, () => {
        if (target) {
          const lid = target.localId ?? (target.def ? target.def.localId ?? target.def.index : undefined);
          if (lid != null) Objects.removeObject(lid);
        }
        Field.locked = false;
      });
    });
  } else if (act === "cut_grass" && truthy(FieldMoves.isRse())) {
    // pokeemerald/src/fldeff_cut.c:316
    throw new Error("NOT FAITHFUL: Emerald only (cut grass)");
  } else if (act === "dive") {
    // pokeemerald/src/party_menu.c:3910 FieldCallback_Dive
    Dive.useDive(payload.slot, payload.mon);
  } else if (act === "cut_grass") {
    Field.locked = true;
    // pokefirered/src/fldeff_cut.c:169
    showMon(() => {
      if (payload.se) Audio.playSe(payload.se);
      const def = MapMod.currentDef();
      const layout = def ? def.midLayout : undefined;
      if (layout) {
        const w = layout.width ?? 0, h = layout.height ?? 0;
        // pokefirered/src/fldeff_rocksmash.c:31
        const elev = P.elevation ?? 0;
        FieldMoves.mowGrass3x3(P.cellX, P.cellY, (x: number, y: number) => layout.midAt(x, y),
          (x: number, y: number, mid: any) => { Field.setMetatile(x, y, mid, false); },
          (x: number, y: number) =>
            // pokefirered/src/fldeff_cut.c:219
            x >= 0 && y >= 0 && x < w && y < h && layout.elevAt(x, y) === elev
              && truthy(Collision.isGrass(x, y)));
        // pokefirered/src/field_effect_helpers.c:313
        if (!truthy(Collision.isGrass(P.cellX, P.cellY))) FieldEffects.clearTallGrass();
      }
      FieldEffects.startCutGrass(P.cellX, P.cellY, () => {
        Field.locked = false;
      });
    });
  } else if (act === "dotted_hole") {
    // pokefirered/src/fldeff_cut.c:194
    Field.locked = true;
    showMon(() => {
      if (payload.se) Audio.playSe(payload.se);
      FieldEffects.startCutGrass(P.cellX, P.cellY, () => {
        Field.openDottedHoleDoor();
      });
    });
  } else if (act === "fly" && Profile.family(Field._session) === "rse") {
    // pokeemerald/src/region_map.c:1647 CB2_OpenFlyMap
    throw new Error("NOT FAITHFUL: Emerald only (RSE fly map)");
  } else if (act === "fly") {
    // pokefirered/src/region_map.c:3873 CB2_OpenFlyMap
    Field.locked = true;
    RegionMap.show({
      session: Field._session,
      mode: "fly",
      onPick: (section: any) => { Field.flyTo(section, payload.mon); },
      onClose: () => { Field.locked = false; },
    });
  } else if (act === "braille_regirock" || act === "braille_registeel") {
    Field.locked = true;
    // pokeemerald/src/braille_puzzles.c:264
    showMon(() => {
      const session = Field._session;
      if (Constants.versionOf(session) === "emerald") {
        throw new Error("NOT FAITHFUL: Emerald only (braille regi effect)");
      }
      Field.locked = false;
    });
  } else if (act === "rock_smash") {
    Field.locked = true;
    // pokefirered/src/fldeff_rocksmash.c:123
    showMon(() => {
      if (payload.se) Audio.playSe(payload.se);
      const target = payload.target;
      const tx = (target ? target.cellX ?? target.x ?? (target.def ? target.def.x : undefined) : undefined) ?? P.cellX;
      const ty = (target ? target.cellY ?? target.y ?? (target.def ? target.def.y : undefined) : undefined) ?? P.cellY;

      FieldEffects.startRockSmash(target, tx, ty, () => {
        if (target) {
          const lid = target.localId ?? (target.def ? target.def.localId ?? target.def.index : undefined);
          if (lid != null) Objects.removeObject(lid);
        }
        Field.locked = false;
        // pokefirered/data/scripts/field_moves.inc:88
        Field.tryRockSmashEncounter();
      });
    });
  } else if (act === "strength") {
    Field.locked = true;
    // pokefirered/src/fldeff_strength.c:34
    showMon(() => {
      if (payload.flag != null) {
        // package.loaded["src.core.game3.scripting.space"]
        if (Space && Space.store) {
          Flags.setFlag(Space.store, undefined, payload.flag, true);
        }
        if (Field._session && Field._session.flags) {
          Field._session.flags[payload.flag] = true;
        }
      }
      if (payload.text) {
        Message.show(payload.text, () => {
          Message.close();
          Field.locked = false;
        });
      } else {
        Field.locked = false;
      }
    });
  } else if (act === "surf") {
    Field.locked = true;
    Audio.startSurfMusic();
    // pokefirered/src/field_effect.c:3020
    showMon(() => {
      P.startSurfing(Field._game, () => {
        Field.locked = false;
      });
    }, { noDuck: true });
  } else if (act === "waterfall") {
    // pokefirered/data/scripts/field_moves.inc:178
    Field.locked = true;
    const ride = (): void => {
      // pokefirered/src/field_effect.c:1627
      showMon(() => { Field.rideWaterfall("up", 0); }, { pose: false });
    };
    if (payload.text) {
      Message.show(payload.text, () => {
        Message.close();
        ride();
      });
    } else {
      ride();
    }
  } else if (act === "flash") {
    Field.locked = true;
    // pokefirered/src/fldeff_flash.c:177
    showMon(() => {
      if (payload.se) Audio.playSe(payload.se);
      if (payload.flag != null) {
        // package.loaded["src.core.game3.scripting.space"]
        if (Space && Space.store) {
          Flags.setFlag(Space.store, undefined, payload.flag, true);
        }
      }
      FieldEffects.startFlash(() => {
        Field.locked = false;
      });
    });
  } else if (act === "dig") {
    Field.locked = true;
    // pokefirered/src/fldeff_dig.c:32
    showMon(() => {
      const Session = Field._session;
      // pokeemerald/src/fldeff_dig.c:54
      if (Constants.versionOf(Session) === "emerald") {
        throw new Error("NOT FAITHFUL: Emerald only (braille dig)");
      }
      const warp = (payload.warp != null && typeof payload.warp === "object") ? payload.warp : {};
      const dest = warp.map ?? (Session ? Session.healMap : undefined);
      // pokefirered/src/fldeff_dig.c:39 StartDigFieldEffect
      Warp.startEscapeRope(Field._game, dest, warp.x, warp.y, (m: any, x: any, y: any) => {
        Field.respawnAtHeal({ fieldMove: true, warp: { map: m, x, y } });
      });
    });
  } else if (act === "teleport") {
    Field.locked = true;
    // pokefirered/src/fldeff_teleport.c:31
    showMon(() => {
      if (payload.se) Audio.playSe(payload.se);
      FieldEffects.startTeleportOut(() => {
        const Session = Field._session;
        const dest = ((payload.warp != null && typeof payload.warp === "object") ? payload.warp.map : undefined)
          ?? (Session ? Session.healMap : undefined);
        const [toMode, fromMode] = Warp.fadeModes(Fade, Field._game, dest);
        // pokefirered/src/field_effect.c:2421
        Fade.begin(toMode, 1, () => {
          Warp.mapTransition(Field._game, dest, () => {
            // pokefirered/src/field_effect.c:2434
            Field._fieldCallback = true;
            // pokefirered/src/field_effect.c:2431
            Field.respawnAtHeal({ fieldMove: true, warp: payload.warp });
            // pokefirered/src/field_effect.c:2454
            Player.setVisible(false);
            Field.locked = true;
            // pokefirered/src/field_effect.c:2449
            Fade.begin(fromMode, 1, () => {
              FieldEffects.startTeleportIn(() => {
                // pokefirered/src/field_effect.c:2532
                Field._fieldCallback = false;
                Warp.releaseField(Field);
              });
            });
          });
        });
      });
    });
  } else if (act === "sweet_scent") {
    Field.locked = true;
    // pokefirered/src/fldeff_sweetscent.c:44
    showMon(() => {
      if (payload.se) Audio.playSe(payload.se);
      FieldEffects.startSweetScent(() => {
        Field.locked = false;
        Field.finishSweetScent(payload);
      });
    });
  }
};

// Lua: field.lua:1462 -- pokefirered/src/fldeff_sweetscent.c:62
Field.finishSweetScent = function (payload: any): void {
  // package.loaded["src.core.game3.runtime"]
  const session = Field._session;
  let mapId = session ? session.map : undefined;
  if (mapId == null) {
    // package.loaded["src.core.game3.map"]
    mapId = MapMod ? MapMod.current : undefined;
  }
  const rules = Encounters.rules();
  if (rules.sweetScentFacility) {
    const handled = rules.sweetScentFacility(mapId);
    if (handled === true) return;
    if (handled === false) {
      if (!payload.failText) return;
      Message.show(RomText.box(payload.failText), { session, done: () => { Message.close(); } });
      return;
    }
  }
  const terrain = Encounters.terrainAt(Player.cellX, Player.cellY);
  const enc = (terrain === "land" || terrain === "water") ? Encounters.rollSweetScent(mapId, terrain) : undefined;
  if (truthy(enc)) {
    const [ok, err] = BattleBridge.startWild(Runtime ? Runtime._mod : undefined, Field._game, enc, {});
    if (truthy(ok)) return;
    console.log("[game3/field] sweet scent startWild failed: " + tostring(err));
  }
  if (!payload.failText) return;
  Message.show(RomText.box(payload.failText), { session, done: () => { Message.close(); } });
};

// Lua: field.lua:1496 -- pokefirered/src/wild_encounter.c:446
Field.tryRockSmashEncounter = function (): boolean {
  const session = Field._session;
  let mapId = session ? session.map : undefined;
  if (mapId == null) {
    // package.loaded["src.core.game3.map"]
    mapId = MapMod ? MapMod.current : undefined;
  }
  const enc = Encounters.rollRocks(mapId);
  if (!truthy(enc)) return false;
  // package.loaded["src.core.game3.runtime"]
  const [ok, err] = BattleBridge.startWild(Runtime ? Runtime._mod : undefined, Field._game, enc, {});
  if (!truthy(ok)) {
    console.log("[game3/field] rock smash startWild failed: " + tostring(err));
    return false;
  }
  return true;
};

// pokefirered/src/field_player_avatar.c:1721 Fishing3
const FISHING_WAIT_FRAMES = 60;
// pokefirered/src/field_player_avatar.c:1755 Fishing5
const FISHING_DOT_FRAMES = 20;
// pokefirered/src/field_player_avatar.c:1741 Fishing4
const FISHING_DOT_MAX = 10;
const FISHING_FIRST_ROUND_DOTS = 4;

Field._fishing = undefined;

// Lua: field.lua:1526
Field.isFishing = function (): boolean {
  return Field._fishing != null;
};

// Lua: field.lua:1531 -- pokefirered/src/field_player_avatar.c:1679 StartFishing
Field.startFishing = function (rod: any): boolean {
  if (Field._fishing) return false;
  Field.locked = true;
  Player.fishing = true;
  // field_player_avatar.c:1667
  Field._fishing = {
    rod: tonumber(rod) ?? 0, step: "wait", timer: 0, dots: 0, required: 0, rounds: 0,
    anim: "takeout", animT: 0,
  };
  return true;
};

// Lua: field.lua:1542 -- pokefirered/src/field_player_avatar.c:1954 AlignFishingAnimationFrames
// Returns [g, x2, y2], or [] when not fishing (Lua: nil).
Field.fishingPose = function (): [any, any, any] | [] {
  const f = Field._fishing;
  if (!(f && truthy(Player.fishing))) return [];
  const facing = Player.facing ?? "down";
  const g = OwSprites.fishingFrame(facing, f.anim, f.animT)[0];
  const [x2, y2] = OwSprites.fishingOffset(OwSprites.fishingAbsFrame(facing, g), facing);
  return [g, x2, y2];
};

// Lua: field.lua:1553 -- pokefirered/src/field_player_avatar.c:1936 Fishing16
function fishingStop(): void {
  Field._fishing = undefined;
  Player.fishing = false;
  Field.locked = false;
}

// Lua: field.lua:1560 -- pokefirered/src/wild_encounter.c:519 FishingWildEncounter
Field.tryFishingEncounter = function (rod: any): boolean {
  // pcall(lazyReq, "src.core.game3.encounters")
  if (!(Encounters && Encounters.rollFishing)) return false;
  const session = Field._session;
  let mapId = session ? session.map : undefined;
  if (mapId == null) {
    // package.loaded["src.core.game3.map"]
    mapId = MapMod ? MapMod.current : undefined;
  }
  let fishOpts: any;
  if (truthy(FieldMoves.isRse())) {
    // pokeemerald/src/wild_encounter.c:124
    throw new Error("NOT FAITHFUL: Emerald only (fishing at facing cell)");
  }
  const enc = Encounters.rollFishing(mapId, tonumber(rod) ?? 0, fishOpts);
  if (!truthy(enc)) return false;
  if (truthy(FieldMoves.isRse())) {
    // pokeemerald/src/wild_encounter.c:796
    throw new Error("NOT FAITHFUL: Emerald only (TV angler species)");
  }
  // package.loaded["src.core.game3.runtime"]
  const [ok, err] = BattleBridge.startWild(Runtime ? Runtime._mod : undefined, Field._game, enc, {});
  if (!truthy(ok)) {
    console.log("[game3/field] fishing startWild failed: " + tostring(err));
    return false;
  }
  return true;
};

// Lua: field.lua:1592
function fishingMapId(): any {
  const session = Field._session;
  const mapId = session ? session.map : undefined;
  if (mapId != null) return mapId;
  // package.loaded["src.core.game3.map"]
  return MapMod ? MapMod.current : undefined;
}

// Lua: field.lua:1601 -- pokefirered/src/field_player_avatar.c:1691 Task_Fishing
Field.updateFishing = function (): boolean {
  const f = Field._fishing;
  if (!f) return false;
  f.timer = f.timer + 1;
  f.animT = (f.animT ?? 0) + 1;

  if (f.step === "result" && f.anim === "putaway" && truthy(Player.fishing)) {
    const ended = OwSprites.fishingFrame(Player.facing, f.anim, f.animT)[1];
    // pokefirered/src/field_player_avatar.c:1918 Fishing15
    if (truthy(ended)) Player.fishing = false;
  }

  if (f.step === "wait") {
    if (f.timer >= FISHING_WAIT_FRAMES) {
      // pokefirered/src/field_player_avatar.c:1740-1746
      const rand = Rng.Random() % 10;
      let need = rand + 1;
      if ((f.rounds ?? 0) === 0) need = rand + FISHING_FIRST_ROUND_DOTS;
      f.required = Math.min(FISHING_DOT_MAX, need);
      f.dots = 0;
      f.timer = 0;
      f.step = "dots";
      Message.showStay("", { speed: 0 });
    }
  } else if (f.step === "dots") {
    if (f.timer >= FISHING_DOT_FRAMES) {
      f.timer = 0;
      if (f.dots >= f.required) {
        // pokefirered/src/field_player_avatar.c:1761-1765
        f.rounds = (f.rounds ?? 0) + 1;
        f.step = "bite";
      } else {
        f.dots = f.dots + 1;
        // pokefirered/src/field_player_avatar.c:1769
        const parts: LuaTable = {};
        for (let k = 0; k <= f.dots - 1; k++) {
          // "\252\18" .. string.char(k * 12) .. "·" (U+00B7 as its UTF-8 bytes)
          parts[len(parts) + 1] = "\xFC\x12" + char(k * 12) + "\xC2\xB7";
        }
        Message.showStay(concat(parts), { speed: 0 });
      }
    }
  } else if (f.step === "bite") {
    // pokefirered/src/field_player_avatar.c:1777 Fishing6
    f.step = "result";
    // pcall(lazyReq, "src.core.game3.encounters")
    const hasMons = (Encounters && Encounters.hasFishingMons
      && Encounters.hasFishingMons(fishingMapId())) || false;
    if (!truthy(hasMons) || (Rng.Random() % 2 === 1)) {
      // pokefirered/src/field_player_avatar.c:1890 Fishing12
      f.anim = "putaway"; f.animT = 0;
      // pokefirered/src/field_player_avatar.c:1895
      Message.show(RomText.box("gText_NotEvenANibble"), () => {
        fishingStop();
        if (truthy(FieldMoves.isRse())) {
          // pokeemerald/src/field_player_avatar.c:2035
          throw new Error("NOT FAITHFUL: Emerald only (TV fishing record)");
        }
      });
    } else {
      // pokefirered/src/field_player_avatar.c:1791
      f.anim = "hooked"; f.animT = 0;
      // pokefirered/src/field_player_avatar.c:1848
      const rod = f.rod;
      Message.show(RomText.box("gText_PokemonOnHook"), () => {
        fishingStop();
        Field.tryFishingEncounter(rod);
        if (truthy(FieldMoves.isRse())) {
          // pokeemerald/src/field_player_avatar.c:1975
          throw new Error("NOT FAITHFUL: Emerald only (TV fishing record)");
        }
      });
    }
  }
  return true;
};

// Lua: field.lua:1681 -- pokefirered/src/field_specials.c:2310 CutMoveOpenDottedHoleDoor
Field.openDottedHoleDoor = function (): boolean {
  const RV = FieldMoves.RUIN_VALLEY;
  Field.setMetatile(RV.doorX, RV.doorY, RV.doorOpen, false);
  try {
    Audio.playSe(SE.SE_BANG);
  } catch (_e) { /* pcall */ }
  // package.loaded["src.core.game3.scripting.space"]
  if (Space && Space.store) {
    Flags.setFlag(Space.store, Space.vm ? Space.vm.ctx : undefined, RV.flag, true);
  }
  const session = Field._session;
  if (session && session.flags) session.flags[RV.flag] = true;
  Field.locked = false;
  return true;
};

Field.FLY_BAKED_REL = "region_map/fly_destinations.lua";
Field._flyBaked = undefined;
Field._flyBakedRoot = undefined;

// Lua: field.lua:1705
function fly_default_root(): string {
  // Extract.CACHE_ROOT (src.import.gba.extract_island1) proxies onto
  // CachePaths (extract_island1.lua:21)
  return CachePaths.CACHE_ROOT;
}

// Lua: field.lua:1709
function fly_row(key: any, row: any): FlyDest {
  if (!(row != null && typeof row === "object" && typeof row.map === "string"
      && tonumber(row.x) != null && tonumber(row.y) != null)) {
    throw new Error("fly_destinations row " + tostring(key) + " is malformed");
  }
  return {
    map: row.map, x: tonumber(row.x)!, y: tonumber(row.y)!,
    healLocation: tonumber(row.healLocation),
  };
}

// Lua: field.lua:1717
Field.installFlyDestinations = function (pack: any, root?: string): number {
  if (!(pack != null && typeof pack === "object" && pack.fly_destinations != null
      && typeof pack.fly_destinations === "object")) {
    throw new Error("fly_destinations pack has no fly_destinations table");
  }
  const baked: Record<string | number, FlyDest> = {};
  Field._flyBaked = baked;
  Field._flyBakedRoot = root ?? fly_default_root();
  let n = 0;
  for (const [key, row] of pairs<any>(pack.fly_destinations)) {
    const dest = fly_row(key, row);
    if (typeof key === "string") baked[key] = dest;
    const num = tonumber(key) ?? tonumber(row.mapsec);
    if (num != null) baked[num] = dest;
    n = n + 1;
  }
  return n;
};

// Lua: field.lua:1733
Field.loadFlyDestinations = function (cache?: any, root?: string): number {
  cache = cache || Dataset.cache();
  root = root ?? fly_default_root();
  const rel = root + "/" + Field.FLY_BAKED_REL;
  const src = cache ? cache.read(rel) : undefined;
  if (!truthy(src)) throw new Error("missing cache file " + rel);
  const [chunk, err] = luaLoad(src, "@" + rel);
  if (!chunk) throw new Error(err);
  const pack = chunk();
  return Field.installFlyDestinations(pack, root);
};

// Lua: field.lua:1742
Field.flyDestinationsMounted = function (): boolean {
  const root = fly_default_root();
  if (Field._flyBaked != null && Field._flyBakedRoot === root) return true;
  const cache = Dataset.cache();
  if (!(cache && truthy(cache.read(root + "/" + Field.FLY_BAKED_REL)))) return false;
  Field.loadFlyDestinations(cache, root);
  return true;
};

// Lua: field.lua:1751
Field.invalidateFlyDestinations = function (): void {
  Field._flyBaked = undefined;
  Field._flyBakedRoot = undefined;
};

// Lua: field.lua:1757 -- pokefirered/src/region_map.c:4023 SetFlyWarpDestination
Field.flyDestination = function (section: any): FlyDest | undefined {
  if (section == null) return undefined;
  if (Field._flyBaked == null || Field._flyBakedRoot !== fly_default_root()) {
    Field.loadFlyDestinations();
  }
  const baked = Field._flyBaked!;
  const num = tonumber(section);
  const hit = baked[section] ?? (num != null ? baked[num] : undefined);
  if (hit) return hit;
  if (num == null) return undefined;
  // pcall(lazyReq, "src.import.gba.map_sections_extract")
  const MapSections = MapSectionsExtract;
  const info = MapSections && MapSections.SECTIONS && MapSections.SECTIONS[num];
  const id = info ? info.id : undefined;
  if (!id) return undefined;
  return baked[id];
};

// Lua: field.lua:1775 -- pokefirered/src/overworld.c:289
function resetCyclingRoadAfterTravel(): void {
  const session = Field._session;
  if (!session) return;
  // package.loaded["src.core.game3.runtime"] / ["src.core.game3.scripting.space"]
  const profile = Profile.forSession(session);
  const defs = Flags.forVersion(profile.id);
  const roadName = profile.family === "rse"
    ? "FLAG_SYS_CYCLING_ROAD" : "FLAG_SYS_ON_CYCLING_ROAD";
  const road = defs.IDS[roadName];
  if (!truthy(road)) throw new Error("assertion failed!");
  let scene: any = false;
  if (profile.family !== "rse") {
    scene = defs.VAR_IDS.VAR_MAP_SCENE_ROUTE16;
    if (!truthy(scene)) throw new Error("assertion failed!");
  }
  const live = Runtime && Runtime.getSession && Runtime.getSession();
  const seen = new Set<any>();
  for (const store of [session, session.store || false, (Space && Space.store) || false,
    live || false, (live && live.store) || false]) {
    if (store && !seen.has(store)) {
      seen.add(store);
      Flags.setFlag(store, undefined, road, false);
      if (store.flags) delete store.flags[roadName];
      if (truthy(scene)) {
        Flags.setVar(store, undefined, scene, 0);
        if (store.vars) {
          delete store.vars[tostring(scene)];
          delete store.vars[format("0x%X", scene)];
          delete store.vars.VAR_MAP_SCENE_ROUTE16;
        }
      }
    }
  }
  Player.biking = false; Player.bikeType = undefined;
  Player.surfing = false; Player.surfHopping = false;
  for (const s of [session, live || false]) {
    if (s) { s.biking = false; s.bikeType = undefined; }
  }
  const save = Field._game ? Field._game.save : undefined;
  if (save) {
    save.biking = false; save.bikeType = undefined;
    if (save.position) save.position.biking = false;
  }
}

// love.graphics: the platform's G always exists on the 3DS (flyTo's animated path).
const loveGraphics: boolean = true;

// Lua: field.lua:1819 -- pokefirered/src/field_effect.c:1065 ReturnToFieldFromFlyMapSelect
Field.flyTo = function (section: any, mon: any, info?: any): boolean {
  let dest: FlyDest | undefined = info ? info.dest : undefined;
  if (!dest) {
    dest = Field.flyDestination(section);
    if (!dest) throw new Error("no fly destination for mapsec " + tostring(section));
  }
  const d = dest;
  if (d.healLocation != null && FieldModules.enabled("questLog", Field._session)) {
    // pokefirered/src/region_map.c:4029 SetUsedFlyQuestLogEvent
    const Q = QuestLogRecorder;
    // {name, Q.location(...)}: the last call expands to all its values
    Q.event(Field._session, "UsedFly", seq<any>(Pokemon.displayMonName(mon),
      ...Q.location(Field._game, { map: d.map })));
  }
  Field.locked = true;
  const land = (): void => {
    resetCyclingRoadAfterTravel();
    MapMod.load(Field._mod, Field._game, d.map, {
      x: d.x, y: d.y, facing: "down", depth1Connections: true,
    });
    Player.reset(d.x, d.y, "down");
    Player.syncToHost(Field._game);
    Player.setVisible(true);
  };
  if (loveGraphics) {
    const flyOut = (): void => {
      const toMode = Warp.fadeModes(Fade, Field._game, d.map)[0];
      // pokefirered/src/field_effect.c:3324 FlyOutFieldEffect_WaitFlyOff
      Fade.begin(toMode, 1, () => {
        Warp.mapTransition(Field._game, d.map, () => {
          land();
          // pokefirered/src/field_effect.c:1104 FieldCallback_FlyIntoMap
          Player.setVisible(false);
          Field._flyLanding = true;
          Field.locked = true;
          Fade.begin(Fade.MODE.FROM_BLACK, 1, () => {
            // pokefirered/src/field_effect.c:1117 Task_FlyIntoMap
            FieldEffects.startFlyIn(() => {
              Field._flyLanding = false;
              Field.locked = false;
            });
          });
        });
      });
    };
    // pokefirered/src/field_effect.c:1073 FieldCallback_UseFly
    Fade.begin(Fade.MODE.FROM_BLACK, 1, () => {
      // pokefirered/src/field_effect.c:3241
      lazyReqMissing("src.core.game3.field_move_show_mon").start(mon, { pose: true }, () => {
        FieldEffects.startFlyOut(flyOut);
      });
    });
  } else {
    land();
    Field._flyLanding = false;
    Field.locked = false;
  }
  return true;
};

// Lua: field.lua:1879 -- pokefirered/src/metatile_behavior.c:266
Field.forcedMovementPending = function (): boolean {
  if (Field._waterfall) return false;
  if (!truthy(Player.surfing)) return false;
  let x = Player.cellX, y = Player.cellY;
  if (truthy(Player.moving)) { x = Player.targetX; y = Player.targetY; }
  if (!truthy(FieldMoves.isWaterfallBehavior(Collision.behavior(x, y)))) return false;
  // pokefirered/src/field_player_avatar.c:295
  return Collision.canEnter(Field._game, x, y + 1, {
    fromX: x, fromY: y, dir: "down", surfing: true,
    elevation: Player.currentElevation,
  })[0] === true;
};

// Lua: field.lua:1895 -- pokefirered/src/safari_zone.c:60 CB2_EndSafariBattle
Field.pollSafariBalls = function (game?: any): boolean {
  if (Field.locked) return false;
  // package.loaded["src.core.game3.battle"]
  if (Battle && Battle.isActive && truthy(Battle.isActive())) return false;
  // package.loaded["src.core.game3.scripting.space"]
  if (Space && Space.vm && Space.vm.isRunning && truthy(Space.vm.isRunning())) return false;
  // package.loaded["src.core.game3.warp"]
  if (Warp && Warp.isBusy && truthy(Warp.isBusy())) return false;
  // pcall(lazyReq, "src.core.game3.safari")
  if (!(Safari && Safari.isActive)) return false;
  const session = Field._session;
  if (!truthy(Safari.isActive(session))) return false;
  if (Safari.balls(session) > 0) return false;
  // pokefirered/data/scripts/safari_zone.inc:31 SafariZone_EventScript_OutOfBalls
  return truthy(Safari.outOfBalls(session, game || Field._game));
};

// Lua: field.lua:1913 -- pokefirered/src/event_data.c:49
Field.clearTempFieldEventData = function (game: any, mapId: any): void {
  // package.loaded["src.core.game3.scripting.space"]
  const session = Field._session;
  const ids = FieldMoves.tempSysFlags();
  const data = game && game.data && game.data.maps;
  const def = mapId != null && data ? data[mapId] : undefined;
  // pokefirered/src/overworld.c:803
  if (truthy(FieldMoves.isOutdoors(def ? def.mapType : undefined))) {
    ids[len(ids) + 1] = FieldMoves.SYS_FLAGS.FLASH_ACTIVE;
  }
  const n = len(ids);
  for (let i = 1; i <= n; i++) {
    const id = ids[i];
    if (Space && Space.store) Flags.setFlag(Space.store, undefined, id, false);
    if (session && session.flags) delete session.flags[id];
  }
};

// Lua: field.lua:1933 -- pokefirered/src/overworld.c:797
Field.pollMapChange = function (game?: any): boolean {
  const session = Field._session;
  const mapId = session ? session.map : undefined;
  if ((mapId ?? null) === (Field._tempFlagMap ?? null)) return false;
  Field._tempFlagMap = mapId;
  Field.clearTempFieldEventData(game || Field._game, mapId);
  return true;
};

// Lua: field.lua:1943 -- pokefirered/src/field_effect.c:1605
Field.rideWaterfall = function (dir?: string, delay?: any): void {
  Field.locked = true;
  Field._waterfall = { dir: dir ?? "up", wait: tonumber(delay) ?? 0, started: false, steps: 0 };
};

// Lua: field.lua:1950
// pokefirered/src/field_effect.c:1613
// pokefirered/src/field_player_avatar.c:246
Field.updateWaterfall = function (game?: any): void {
  const onWaterfall = truthy(FieldMoves.isWaterfallBehavior(Collision.behavior(Player.cellX, Player.cellY)));

  const st = Field._waterfall;
  if (st) {
    if (st.wait > 0) {
      st.wait = st.wait - 1;
      return;
    }
    if (truthy(Player.moving)) return;
    // pokefirered/src/field_effect.c:1659
    if ((st.started && !onWaterfall) || st.steps >= 64) {
      Field._waterfall = undefined;
      Field.locked = false;
      return;
    }
    st.started = true;
    st.steps = st.steps + 1;
    Player.forceStep(st.dir, () => {});
    // pokefirered/src/field_effect.c:1650
    Player.stepFrames = WALK_SLOWER_FRAMES;
    return;
  }

  if (!onWaterfall || Field.locked || !truthy(Player.surfing)) return;
  // package.loaded["src.core.game3.scripting.space"]
  if (Space && Space.vm && Space.vm.isRunning && truthy(Space.vm.isRunning())) return;
  // package.loaded["src.core.game3.runtime"]
  if (Runtime && Runtime.uiBusy && truthy(Runtime.uiBusy())) return;
  const tx = Player.cellX, ty = Player.cellY + 1;
  // pokefirered/src/field_player_avatar.c:295
  if (!truthy(Collision.canEnter(game || Field._game, tx, ty, {
    fromX: Player.cellX, fromY: Player.cellY, dir: "down", surfing: true,
    elevation: Player.currentElevation,
  })[0])) return;
  if (truthy(Player.moving)) {
    // pokefirered/src/field_player_avatar.c:147
    if (Player.targetX === tx && Player.targetY === ty) return;
    Player.moving = false;
    Player.progress = 0;
    Player.running = false;
    Player.jumping = false;
    Player.spriteYOffset = 0;
    Player.targetX = Player.cellX; Player.targetY = Player.cellY;
    Player.px = Player.cellX * 16; Player.py = Player.cellY * 16;
    Player._onStepDone = undefined;
  }
  // pokefirered/src/field_control_avatar.c:142
  if (truthy(FieldMoves.isWaterfallBehavior(Collision.behavior(tx, ty)))) {
    Player.forceStep("down", () => {});
  } else {
    Player.scriptStep("down");
  }
};

// Lua: field.lua:2008
/** White-out / heal respawn via game3 map loader (H7). */
Field.respawnAtHeal = function (opts?: any): void {
  const session = Field._session;
  if (!session) return;
  resetCyclingRoadAfterTravel();
  HealLocations.normalizeSession(session);
  const whiteOut = !(opts && truthy(opts.fieldMove));
  const healRow = HealLocations.model() === "heal_row";
  if (whiteOut) {
    // pokefirered/src/overworld.c:1556
    // package.loaded["src.core.game3.scripting.space"]
    if (Space && Space.vm && truthy(Space.vm.isRunning())) Space.vm.halt(true);
    if (healRow) {
      // pokeemerald/src/overworld.c:360
      if (Space && Space.runImmediately) Space.runImmediately("EventScript_WhiteOut");
    } else {
      // pokefirered/src/overworld.c:252
      Field.resetEliteFour();
    }
    // pokefirered/src/overworld.c:1553 CB2_WhiteOut
    // pcall(lazyReq, "src.core.game3.safari")
    if (Safari && Safari.reset) Safari.reset(session);
  }
  if (!(opts && truthy(opts.fieldMove)) && truthy(ModRuntime.wants("world.blacked_out"))) {
    ModRuntime.emit("world.blacked_out", {
      save: session,
      healTarget: { map: session.healMap, x: session.healX, y: session.healY },
    });
  }
  if (!(opts && truthy(opts.fieldMove))) {
    // pokefirered/src/overworld.c:1553 CB2_WhiteOut
    Party.healAll(session.party);
  }
  const start = MapIds.newGameStart(session.version);
  let mapId = session.healMap ?? start.healMap ?? start.map;
  let hx = session.healX ?? start.healX ?? start.x;
  let hy = session.healY ?? start.healY ?? start.y;
  let warp = opts ? opts.warp : undefined;
  if (typeof warp === "string") warp = { map: warp };
  if (warp != null && typeof warp === "object" && typeof warp.map === "string") {
    // pokefirered/src/overworld.c:656 SetWarpDestinationToEscapeWarp
    mapId = warp.map;
    hx = tonumber(warp.x) ?? hx;
    hy = tonumber(warp.y) ?? hy;
  }
  // pokefirered/src/overworld.c:1555
  const facing = (whiteOut && !healRow) ? "up" : "down";
  MapMod.load(Field._mod, Field._game, mapId, {
    x: hx,
    y: hy,
    facing,
    depth1Connections: true,
    heal: true,
  });
  Player.reset(hx, hy, facing);
  Player.syncToHost(Field._game);
  // pokefirered/src/heal_location.c:119 SetWhiteoutRespawnHealerNpcAsLastTalked
  const healerId = tonumber(session.healHealerLocalId);
  if (healerId != null && !(opts && truthy(opts.fieldMove))) {
    // package.loaded["src.core.game3.scripting.space"]
    if (Space && Space.store) {
      Flags.setVar(Space.store, Space.vm ? Space.vm.ctx : undefined, Ctx.VAR_LAST_TALKED, healerId);
    }
  }
  if (whiteOut && !healRow) {
    // pokefirered/src/overworld.c:1558
    const home = HealLocations.get(1);
    lazyReqMissing("src.ui.game3.whiteout_rush").start(Field._game, session, {
      home: home ? home.map === mapId : undefined,
      healerLocalId: healerId,
    });
  }
  // Map.load already locked; ON_FRAME / releaseall own unlock.
};

// data/scripts/hall_of_fame.inc:24
const CHAMPION_TRAINERS = seq(438, 439, 440, 739, 740, 741);
const ELITE_FOUR_FLAGS = seq("FLAG_DEFEATED_LORELEI", "FLAG_DEFEATED_BRUNO", "FLAG_DEFEATED_AGATHA",
  "FLAG_DEFEATED_LANCE", "FLAG_DEFEATED_CHAMP");

// Lua: field.lua:2090
Field.resetEliteFour = function (): void {
  // package.loaded["src.core.game3.scripting.space"]
  const store = Space ? Space.store : undefined;
  if (!store) return;
  const ctx = Space.vm ? Space.vm.ctx : undefined;
  for (const [, name] of ipairs<string>(ELITE_FOUR_FLAGS)) {
    Flags.setFlag(store, ctx, Flags.IDS[name], false);
  }
  for (const [, trainerId] of ipairs<number>(CHAMPION_TRAINERS)) {
    Flags.setFlag(store, ctx, Flags.trainerFlagId(trainerId), false);
  }
  Flags.setVar(store, ctx, Flags.IDS.VAR_MAP_SCENE_POKEMON_LEAGUE, 0);
};

// Lua: field.lua:2106
Field.setHealPoint = function (mapId: any, x: number, y: number): void {
  const session = Field._session;
  if (!session) return;
  session.healMap = mapId;
  session.healX = x;
  session.healY = y;
};

// Lua: field.lua:2115
/** pret ScrCmd_setrespawn → SetLastHealLocationWarp (we store whiteout tile). */
Field.setRespawn = function (healLocationId: any): any {
  const session = Field._session;
  if (!session) return false;
  return HealLocations.applyToSession(session, healLocationId);
};

// Lua: field.lua:2122
Field.setWeather = function (id: any): void {
  Field.weather = tonumber(id) ?? 0;
  Weather.apply(Field.weather);
};

// Lua: field.lua:2128
function passableColl(mapDef: any, pair: any, mid: number): number {
  const Interaction = InteractionScripts;
  const behaviors = pair != null && Interaction.behaviors ? (Interaction.behaviors as any)[pair] : undefined;
  const beh = behaviors ? behaviors[mid] : undefined;
  if (beh != null) {
    return ScriptColl.fromCell(mid, 0, beh, mapDef.kind)[0];
  }
  // pcall(lazyReq, "src.import.gba.register"): no such module in the port (pcall fails)
  const Register: any = undefined;
  const midIndex = Register ? Register._midIndex : undefined;
  const row = midIndex && pair != null && midIndex[pair] ? midIndex[pair][mid] : undefined;
  return (row ? row.coll : undefined) ?? 0x00;
}

// Lua: field.lua:2143 -- pokefirered/src/scrcmd.c:2103
Field.setMetatile = function (xIn: any, yIn: any, metatile: any, isImpassableIn?: any): void {
  const x = tonumber(xIn) ?? 0, y = tonumber(yIn) ?? 0;
  const isImpassable = isImpassableIn === true || (tonumber(isImpassableIn) ?? 0) !== 0;
  const session = Field._session;
  const mapId = session ? session.map : undefined;
  if (mapId != null) {
    let bucket = Field.metatileOverrides[mapId];
    if (!bucket) {
      bucket = {};
      Field.metatileOverrides[mapId] = bucket;
    }
    bucket[y * 1024 + x] = {
      x, y, metatile, impassable: isImpassable,
    };
  }
  if (truthy(ModRuntime.wants("world.block_replaced"))) {
    ModRuntime.emit("world.block_replaced", { mapId, bx: x, by: y, block: metatile });
  }
  const game = Field._game;
  const data = game && game.data && game.data.maps;
  const mapDef = mapId != null && data ? data[mapId] : undefined;
  const mid = tonumber(metatile) ?? 0;
  if (mapDef && mapDef.midLayout) {
    const layout = mapDef.midLayout;
    const pair = mapDef.pair ?? layout.pair;
    const coll = isImpassable ? 0x07 : passableColl(mapDef, pair, mid);
    // pokefirered/src/fieldmap.c:407
    layout.applyOverride(x, y, mid, coll, layout.elevAt(x, y));
    Field._overrideLayouts[mapId] = layout;
    if (!(Collision.patchCell && truthy(Collision.patchCell(mapId, mapDef, x, y)))) {
      Collision.bindMap(game, mapId, mapDef);
    }
    // applyOverride already invalidated the view cell (FieldView.invalidateLayoutCell).
    // package.loaded["src.core.game3.field_view"] / ["src.core.game3.layout_native"]
    if (FieldView && !(FieldView.invalidateLayoutCell && LayoutNative
        && layout.applyOverride === LayoutNative.prototype.applyOverride)) {
      FieldView._nativeDirty = true;
    }
  }
  const world = game && (game.overworld || game.world);
  if (world && world.map && world.map.setBlock) {
    try {
      world.map.setBlock(x, y, metatile);
    } catch (_e) { /* pcall */ }
  }
};

export default Field;
