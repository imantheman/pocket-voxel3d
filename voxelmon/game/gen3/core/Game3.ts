// Port of gen1recomp src/core/Game3.lua (GPLv3 + additional terms; see LICENSE.md).
// The FireRed service owner (Gen 3 peer of Game / Game2). Boot: copyright ->
// title -> main menu -> Oak -> gender -> field.
//
// What differs from the desktop:
// - Input: the 3DS pad enters through Input.hostButtons (shared/core/Input.ts),
//   which raises this object's gamepadpressed / gamepadreleased (load()
//   registers Game3 as Input's host sink); keypressed / keyreleased and the
//   other LOVE callbacks are kept and simply never called by the 3DS entry.
// - Desktop plumbing (TouchControls, FaithfulRes, VSync, FrameCap, Zoom,
//   Letterbox, VideoMode, Orientation, ScreenPosition, Performance,
//   Renderer) are inert modules here: the calls stay, guarded as Brian
//   guards them. DiscordPresence, PresentSync and src.mods.Loader have no
//   module in this runtime; Brian already pcalls every use, so each reads
//   as a failed call (mods: "failed to load, continuing without them").
// - Link, union room, cable-club arena: deferred. Where Brian probes them
//   through package.loaded (Link.link, LinkMenu, minigames.common) they are
//   looked up in runtime.ts's G3Lazy registry and read as absent; the two
//   unguarded union-room calls take the offline path (NOT FAITHFUL: link
//   deferred).
// - Emerald (RSE) branches throw NOT FAITHFUL: Emerald only.
// - Game3.stepGC: no collectgarbage in QuickJS's API here (NOT FAITHFUL:
//   the engine's own GC runs; the budget constants stay).
// - package.loaded["X"] probes: modules this runtime has are imported and
//   treated as loaded; Brian's lazyReq'd modules with no file yet are looked
//   up in G3Lazy (runtime.ts).

import { FixedStep } from "../shared/core/FixedStep.ts";
import { Input, GamepadMap } from "../shared/core/Input.ts";
import { SaveData } from "../shared/core/SaveData.ts";
import { Schema } from "./save_schema_firered.ts";
import { MapIds } from "./map_ids.ts";
import { Profile } from "./profile.ts";
import { Runtime, G3Lazy } from "./runtime.ts";
import { Audio } from "./audio.ts";
import { Options } from "./options.ts";
import { Dataset } from "./dataset.ts";
import { Display } from "./display.ts";
import { Boot } from "../ui/boot.ts";
import { Help } from "../ui/help_system.ts";
import { UI as QuestLog } from "../ui/quest_log.ts";
import { R as QuestRecorder } from "./quest_log_recorder.ts";
import { FieldModules } from "./field_modules.ts";
import { Runtime as ModRuntime } from "../shared/mods/Runtime.ts";
import { Logger } from "../shared/core/Logger.ts";
import { GameVersion } from "../shared/core/GameVersion.ts";
import { GameSpeed } from "../shared/core/GameSpeed.ts";
import { Strings } from "../shared/core/Strings.ts";
import { LogicClock } from "../shared/core/LogicClock.ts";
import { Gen3Compat } from "../shared/mods/Gen3Compat.ts";
import { Versions } from "../../../import/gen3/versions.ts";
import { SE } from "./se_ids.ts";
import { Song } from "./song_ids.ts";
import { ItemsData } from "./items_data.ts";
import { TouchControls } from "../shared/core/TouchControls.ts";
import { Rng } from "./rng.ts";
import { Bg } from "./bg.ts";
import { Oam } from "./oam.ts";
import { Fade } from "../ui/fade.ts";
import { Map as G3Map } from "./map.ts";
import { Space } from "./scripting/space.ts";
import { StartMenu } from "../ui/start_menu.ts";
import { OptionMenu } from "../ui/option_menu.ts";
import { Pokemon } from "./pokemon.ts";
import { Moves } from "./battle/moves.ts";
import { Encounters } from "./encounters.ts";
import { Trainers } from "./scripting/trainers.ts";
import { RomText } from "./rom_text.ts";
import { VoidFill } from "./void_fill.ts";
import { Chrome } from "../ui/chrome.ts";
import { Tilt } from "../shared/render/Tilt.ts";
import { Letterbox } from "../shared/render/Letterbox.ts";
import { Zoom } from "../shared/render/Zoom.ts";
import { VideoMode } from "../shared/core/VideoMode.ts";
import { Orientation } from "../shared/core/Orientation.ts";
import { FaithfulRes } from "../shared/core/FaithfulRes.ts";
import { ScreenPosition } from "../shared/core/ScreenPosition.ts";
import { VSync } from "../shared/core/VSync.ts";
import { FrameCap } from "../shared/core/FrameCap.ts";
import { Performance } from "../shared/core/Performance.ts";
import { Renderer } from "../shared/render/Renderer.ts";
import { Field } from "./field.ts";
import { Player } from "./player.ts";
import { Bag } from "./bag.ts";
import { ItemUse } from "./item_use.ts";
import { VsSeeker } from "./vs_seeker.ts";
import { Hud } from "../ui/hud.ts";
import { Stack } from "../ui/stack.ts";
import { battle as Battle } from "./battle.ts";
import { Ghosts } from "./ghosts.ts";
import { Objects } from "./objects.ts";
import { FieldView } from "./field_view.ts";
import { Warp } from "./warp.ts";
import { Doors } from "./doors.ts";
import { G } from "../platform/graphics.ts";
import { osTime } from "../../gen2/platform/clock.ts";
import { tonumber, tostring } from "../../../import/gen3/lua.ts";
import { ipairs, len, pairs } from "../platform/lt.ts";
import { match } from "../platform/lpattern.ts";
import { Battle as SR1 } from "./battle/init.ts";
import { BattleBridge as SR2 } from "./battle_bridge.ts";
import { BattleTransition as SR3 } from "./battle_transition.ts";
import { Task as SR4 } from "./task.ts";
import { StepEvents as SR5 } from "./step_events.ts";
import { ShowMon as SR6 } from "./field_move_show_mon.ts";
import { Field as SR7 } from "./field.ts";
import { Itemfinder as SR8 } from "./itemfinder.ts";
import { SpecialFieldAnim as SR9 } from "./special_field_anim.ts";
import { PcAnim as SR10 } from "./pc_anim.ts";
import { TradeScene as SR11 } from "./trade_scene.ts";
import { Hud as SR12 } from "../ui/hud.ts";
import { MonPic as SR13 } from "../ui/mon_pic.ts";
import { Seagallop as SR14 } from "../ui/seagallop.ts";
import { MapPreviewScreen as SR15 } from "../ui/map_preview_screen.ts";
import { CaveTransition as SR16 } from "../ui/cave_transition.ts";
import { MapNamePopup as SR17 } from "../ui/map_name_popup.ts";
import { HelpWindow as SR18 } from "../ui/help_window.ts";
import { Rush as SR19 } from "../ui/whiteout_rush.ts";
import { ShopMenu as SR20 } from "../ui/shop_menu.ts";
import { Choice as SR21 } from "../ui/choice.ts";
import { Message as SR22 } from "../ui/message.ts";
import { MoneyBox as SR23 } from "../ui/money_box.ts";
import { HallOfFame as SR24 } from "../ui/hall_of_fame.ts";
import { HofPc as SR25 } from "../ui/hall_of_fame_pc.ts";
import { StartMenu as SR26 } from "../ui/start_menu.ts";
import { BagMenu as SR27 } from "../ui/bag_menu.ts";
import { BerryPouch as SR28 } from "../ui/berry_pouch.ts";
import { TmCase as SR29 } from "../ui/tm_case.ts";
import { PartyMenu as SR30 } from "../ui/party_menu.ts";
import { SummaryMenu as SR31 } from "../ui/summary_menu.ts";
import { Pokedex as SR32 } from "../ui/pokedex.ts";
import { OptionMenu as SR33 } from "../ui/option_menu.ts";
import { SaveMenu as SR34 } from "../ui/save_menu.ts";
import { TrainerCard as SR35 } from "../ui/trainer_card.ts";
import { PcMenu as SR36 } from "../ui/pc_menu.ts";
import { ItemPc as SR37 } from "../ui/item_pc.ts";
import { BoxStorageUI as SR38 } from "../ui/box_storage_ui.ts";
import { RegionMap as SR39 } from "../ui/region_map.ts";
import { FameCheckerUi as SR40 } from "../ui/fame_checker.ts";
import { EggHatch as SR41 } from "../ui/egg_hatch.ts";
import { EvolutionScene as SR42 } from "../ui/evolution_scene.ts";
import { ModManager as SR43 } from "../ui/mod_manager.ts";
import { ReleaseSeq as SR44 } from "../ui/release_seq.ts";
import { Naming as SR45 } from "../ui/naming.ts";
import { EasyChat as SR46 } from "../ui/easy_chat.ts";
import { Dive as SR47 } from "./dive.ts";
import { RotatingGate as SR48 } from "./rotating_gate.ts";
import { Fade as SR49 } from "../ui/fade.ts";
// every lazily-required module that has a port registers itself in G3Lazy
import "./lazy_modules.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

// Lua: Game3.lua:29
const s9Warned: Record<string, boolean> = {};
function s9log(key: string, err: unknown): void {
  if (s9Warned[key]) return;
  s9Warned[key] = true;
  console.log("[game3] hot-path pcall failed (" + key + "): " + tostring((err as Error)?.message ?? err));
}

// Lua: Game3.lua:39
function noop(): void {}

function errText(e: unknown): string {
  return tostring((e as Error)?.message ?? e);
}

// pcall(fn): [ok, result]
function pcall<T>(fn: () => T): [boolean, T | undefined, unknown?] {
  try {
    return [true, fn()];
  } catch (e) {
    return [false, undefined, e];
  }
}

// call an inert (desktop-only) module's function if it has one (instance-style or static)
function inert(m: any, fn: string, ...args: unknown[]): any {
  const f = m ? m[fn] : undefined;
  if (typeof f !== "function") return undefined;
  return f.apply(m, args);
}

// Lua: Game3.lua:44 -- pokefirered/src/item_use.c:159 SetUpItemUseOnFieldCallback
const FIELD_CB_SILENT: Record<string, boolean> = { bike: true, rod: true, map: true, escape: true };

// Lua: Game3.lua:67
const FIELD_CALLBACKS: Record<string, string> = {
  truck: "src.core.game3.truck_sequence", // pokeemerald/src/overworld.c:1542
};

// NOT FAITHFUL: link deferred -- union_room.isUnionMap is the offline answer (no union room)
function unionRoomMap(_id: unknown): boolean {
  return false;
}

// Lua: Game3.lua:1153
function closeFlag(flag: string): (m: any) => void {
  return (m: any) => {
    m[flag] = false;
    for (const [k, v] of pairs(m)) {
      if (typeof k === "string" && typeof v === "function" && match(k, "^_on%u")) m[k] = undefined;
    }
  };
}

// Lua: Game3.lua:1162
function dropField(field: string): (m: any) => void {
  return (m: any) => { m[field] = undefined; };
}

// Lua: Game3.lua:1167 -- pokefirered/src/main.c:480
const SOFT_RESET: [string, () => any, string | ((m: any) => void)][] = [
  ["src.core.game3.battle.init", () => SR1, "reset"],
  ["src.core.game3.battle_bridge", () => SR2, "reset"],
  ["src.core.game3.battle_transition", () => SR3, "abort"],
  ["src.core.game3.task", () => SR4, "clear"],
  ["src.core.game3.step_events", () => SR5, "flush"],
  ["src.core.game3.field_move_show_mon", () => SR6, "reset"],
  ["src.core.game3.pokecenter_heal", () => G3Lazy["src.core.game3.pokecenter_heal"], dropField("_fx")],
  ["src.core.game3.field", () => SR7, dropField("_frameTasks")],
  ["src.core.game3.ss_anne_cutscene", () => G3Lazy["src.core.game3.ss_anne_cutscene"], "reset"],
  ["src.core.game3.itemfinder", () => SR8, "reset"],
  ["src.core.game3.special_field_anim", () => SR9, "stopEscalator"],
  ["src.core.game3.pc_anim", () => SR10, "reset"],
  ["src.core.game3.camera_object", () => G3Lazy["src.core.game3.camera_object"], "reset"],
  ["src.core.game3.trade_scene", () => SR11, "cancel"],
  ["src.core.game3.scripting.natives_listmenu", () => G3Lazy["src.core.game3.scripting.natives_listmenu"], "close"],
  ["src.ui.game3.hud", () => SR12, "clearWaitButton"],
  ["src.ui.game3.mon_pic", () => SR13, "hide"],
  ["src.ui.game3.museum_fossil_pic", () => G3Lazy["src.ui.game3.museum_fossil_pic"], "reset"],
  ["src.ui.game3.seagallop", () => SR14, "stop"],
  ["src.ui.game3.map_preview_screen", () => SR15, "reset"],
  ["src.ui.game3.cave_transition", () => SR16, "clear"],
  ["src.ui.game3.map_name_popup", () => SR17, "dismiss"],
  ["src.ui.game3.help_window", () => SR18, "reset"],
  ["src.ui.game3.whiteout_rush", () => SR19, dropField("_state")],
  ["src.ui.game3.trade_scene", () => G3Lazy["src.ui.game3.trade_scene"], "close"],
  ["src.ui.game3.shop_menu", () => SR20, "reset"],
  ["src.ui.game3.choice", () => SR21, "reset"],
  ["src.ui.game3.message", () => SR22, "reset"],
  ["src.ui.game3.money_box", () => SR23, "hide"],
  ["src.ui.game3.coins_box", () => G3Lazy["src.ui.game3.coins_box"], "hide"],
  ["src.ui.game3.elevator_window", () => G3Lazy["src.ui.game3.elevator_window"], "hide"],
  ["src.ui.game3.berry_powder_box", () => G3Lazy["src.ui.game3.berry_powder_box"], "hide"],
  ["src.ui.game3.minigame_records", () => G3Lazy["src.ui.game3.minigame_records"], "reset"],
  ["src.ui.game3.hall_of_fame", () => SR24, "reset"],
  ["src.ui.game3.hall_of_fame_pc", () => SR25, "reset"],
  ["src.ui.game3.credits", () => G3Lazy["src.ui.game3.credits"], "reset"],
  ["src.ui.game3.start_menu", () => SR26, closeFlag("open")],
  ["src.ui.game3.start_menu", () => SR26, "resetCursor"], // pokefirered/src/start_menu.c:64
  ["src.ui.game3.bag_menu", () => SR27, closeFlag("open")],
  ["src.ui.game3.berry_pouch", () => SR28, closeFlag("open")],
  ["src.ui.game3.tm_case", () => SR29, closeFlag("open")],
  ["src.ui.game3.party_menu", () => SR30, closeFlag("open")],
  ["src.ui.game3.summary_menu", () => SR31, closeFlag("open")],
  ["src.ui.game3.pokedex", () => SR32, closeFlag("open")],
  ["src.ui.game3.option_menu", () => SR33, closeFlag("open")],
  ["src.ui.game3.save_menu", () => SR34, closeFlag("open")],
  ["src.ui.game3.trainer_card", () => SR35, closeFlag("open")],
  ["src.ui.game3.pc_menu", () => SR36, closeFlag("open")],
  ["src.ui.game3.item_pc", () => SR37, closeFlag("open")],
  ["src.ui.game3.box_storage_ui", () => SR38, closeFlag("open")],
  ["src.ui.game3.region_map", () => SR39, closeFlag("open")],
  ["src.ui.game3.daycare_menu", () => G3Lazy["src.ui.game3.daycare_menu"], closeFlag("open")],
  ["src.ui.game3.fame_checker", () => SR40, closeFlag("open")],
  ["src.ui.game3.move_relearner", () => G3Lazy["src.ui.game3.move_relearner"], closeFlag("open")],
  ["src.ui.game3.rse.move_relearner", () => G3Lazy["src.ui.game3.rse.move_relearner"], closeFlag("open")],
  ["src.ui.game3.egg_hatch", () => SR41, closeFlag("open")],
  ["src.ui.game3.evolution_scene", () => SR42, closeFlag("open")],
  ["src.ui.game3.diploma", () => G3Lazy["src.ui.game3.diploma"], closeFlag("open")],
  ["src.ui.game3.trainer_tower_records", () => G3Lazy["src.ui.game3.trainer_tower_records"], closeFlag("open")],
  ["src.ui.game3.teachy_tv", () => G3Lazy["src.ui.game3.teachy_tv"], closeFlag("open")],
  ["src.ui.game3.slot_machine", () => G3Lazy["src.ui.game3.slot_machine"], closeFlag("open")],
  ["src.ui.game3.mod_manager", () => SR43, closeFlag("open")],
  ["src.ui.game3.prize_corner", () => G3Lazy["src.ui.game3.prize_corner"], "reset"],
  ["src.ui.game3.stat_growth", () => G3Lazy["src.ui.game3.stat_growth"], closeFlag("_open")],
  ["src.ui.game3.release_seq", () => SR44, (m: any) => { m.active = false; m.onComplete = undefined; }],
  ["src.ui.game3.naming", () => SR45, closeFlag("openFlag")],
  ["src.ui.game3.easy_chat", () => SR46, closeFlag("openFlag")],
  ["src.ui.game3.rse.wall_clock", () => G3Lazy["src.ui.game3.rse.wall_clock"], "reset"],
  ["src.ui.game3.rse.starter_choose", () => G3Lazy["src.ui.game3.rse.starter_choose"], "reset"],
  ["src.core.game3.truck_sequence", () => G3Lazy["src.core.game3.truck_sequence"], "reset"],
  ["src.core.game3.dive", () => SR47, "reset"],
  ["src.core.game3.field_weather_rse", () => G3Lazy["src.core.game3.field_weather_rse"], "stop"],
  ["src.core.game3.rotating_gate", () => SR48, "reset"],
  ["src.core.game3.rotating_tile_puzzle", () => G3Lazy["src.core.game3.rotating_tile_puzzle"], "free"],
  ["src.core.game3.special_scene_rse", () => G3Lazy["src.core.game3.special_scene_rse"], "reset"],
  ["src.core.game3.fldeff_misc", () => G3Lazy["src.core.game3.fldeff_misc"], "reset"],
  ["src.core.game3.rse.match_call", () => G3Lazy["src.core.game3.rse.match_call"], "reset"],
  ["src.ui.game3.rse.pokedex", () => G3Lazy["src.ui.game3.rse.pokedex"], "reset"],
  ["src.ui.game3.rse.region_map", () => G3Lazy["src.ui.game3.rse.region_map"], "reset"],
  ["src.ui.game3.rse.option_menu", () => G3Lazy["src.ui.game3.rse.option_menu"], "reset"],
  ["src.ui.game3.rse.bag_menu", () => G3Lazy["src.ui.game3.rse.bag_menu"], "reset"],
  ["src.ui.game3.rse.summary_menu", () => G3Lazy["src.ui.game3.rse.summary_menu"], "reset"],
  ["src.ui.game3.rse.credits", () => G3Lazy["src.ui.game3.rse.credits"], "reset"],
  ["src.ui.game3.rse.item_storage", () => G3Lazy["src.ui.game3.rse.item_storage"], "reset"],
  ["src.ui.game3.rse.mail", () => G3Lazy["src.ui.game3.rse.mail"], "reset"],
  ["src.ui.game3.rse.mailbox", () => G3Lazy["src.ui.game3.rse.mailbox"], "reset"],
  ["src.ui.game3.rse.pokenav.init", () => G3Lazy["src.ui.game3.rse.pokenav.init"], "reset"],
  ["src.ui.game3.rse.pokenav.call_window", () => G3Lazy["src.ui.game3.rse.pokenav.call_window"], "reset"],
  ["src.ui.game3.rse.cable_car", () => G3Lazy["src.ui.game3.rse.cable_car"], "reset"],
  ["src.ui.game3.rse.rayquaza_scene", () => G3Lazy["src.ui.game3.rse.rayquaza_scene"], "reset"],
  ["src.ui.game3.rse.decoration", () => G3Lazy["src.ui.game3.rse.decoration"], "reset"],
  ["src.core.game3.rse.secret_base", () => G3Lazy["src.core.game3.rse.secret_base"], "reset"],
  ["src.ui.game3.rse.pokeblock_case", () => G3Lazy["src.ui.game3.rse.pokeblock_case"], "reset"],
  ["src.ui.game3.rse.use_pokeblock", () => G3Lazy["src.ui.game3.rse.use_pokeblock"], "reset"],
  ["src.ui.game3.rse.pokeblock_feed", () => G3Lazy["src.ui.game3.rse.pokeblock_feed"], "reset"],
  ["src.ui.game3.rse.berry_tag", () => G3Lazy["src.ui.game3.rse.berry_tag"], "reset"],
  ["src.ui.game3.rse.berry_blender", () => G3Lazy["src.ui.game3.rse.berry_blender"], "reset"],
  ["src.ui.game3.rse.slot_machine", () => G3Lazy["src.ui.game3.rse.slot_machine"], "reset"],
  ["src.ui.game3.rse.roulette", () => G3Lazy["src.ui.game3.rse.roulette"], "reset"],
  ["src.ui.game3.rse.contest", () => G3Lazy["src.ui.game3.rse.contest"], "reset"],
  ["src.ui.game3.rse.contest_results", () => G3Lazy["src.ui.game3.rse.contest_results"], "reset"],
  ["src.ui.game3.rse.contest_painting", () => G3Lazy["src.ui.game3.rse.contest_painting"], "reset"],
  ["src.ui.game3.rse.contest_entry_pic", () => G3Lazy["src.ui.game3.rse.contest_entry_pic"], "reset"],
  ["src.ui.game3.rse.frontier_pass", () => G3Lazy["src.ui.game3.rse.frontier_pass"], "reset"],
  ["src.ui.game3.rse.frontier_records", () => G3Lazy["src.ui.game3.rse.frontier_records"], "reset"],
  ["src.ui.game3.rse.dome_tourney", () => G3Lazy["src.ui.game3.rse.dome_tourney"], "reset"],
  ["src.ui.game3.rse.factory_select", () => G3Lazy["src.ui.game3.rse.factory_select"], "reset"],
  ["src.ui.game3.rse.factory_swap", () => G3Lazy["src.ui.game3.rse.factory_swap"], "reset"],
  ["src.ui.game3.rse.pyramid_bag", () => G3Lazy["src.ui.game3.rse.pyramid_bag"], "reset"],
  ["src.ui.game3.rse.pyramid_retire", () => G3Lazy["src.ui.game3.rse.pyramid_retire"], "reset"],
  ["src.ui.game3.rse.trainer_hill_records", () => G3Lazy["src.ui.game3.rse.trainer_hill_records"], "reset"],
  ["src.ui.game3.fade", () => SR49, "clear"],
];

// Lua: Game3.lua:1282
function clearFieldScreens(): void {
  for (const [, get, fn] of SOFT_RESET) {
    const mod = get();
    if (mod != null && (typeof mod === "object" || typeof mod === "function")) {
      if (typeof fn === "string") {
        if (mod[fn]) pcall(() => mod[fn]());
      } else {
        pcall(() => fn(mod));
      }
    }
  }
  const LeagueLighting = G3Lazy["src.core.game3.league_lighting"];
  if (LeagueLighting && LeagueLighting.reset) pcall(() => LeagueLighting.reset());
  const M: any = G3Map;
  M.disableMusicChange = M.MUSIC_DISABLE_OFF;
  const FV: any = FieldView;
  FV.hideActors = false;
  FV.setCameraPanning(0, 0);
}

// Lua: Game3.lua:247
function arenaSession(self: Game3, spec: any): any {
  let session: any;
  const version = GameVersion.get();
  if (spec && spec.slotId && SaveData.setActiveSlot) {
    pcall(() => SaveData.setActiveSlot(version, spec.slotId));
  }
  const [ok, loaded] = pcall(() => SaveData.load()[0]);
  const save: any = loaded;
  if (ok && save != null && typeof save === "object" && save.engine === "game3") {
    const activeMods = self.modStatus && self.modStatus.loaded;
    if (SaveData.runMigrations) {
      pcall(() => SaveData.runMigrations(save, self.mods && self.mods.migrations, activeMods));
    }
    const [okS, fromSave] = pcall(() => Schema.fromSaveTable(save));
    if (okS && fromSave != null && typeof fromSave === "object") session = fromSave;
  } else if (spec && spec.role !== "spectator") {
    Logger.warn("arena3: save slot %s could not be loaded", tostring(spec && spec.slotId));
  }
  session = session || { party: [null], bag: {} };
  if (typeof session.name !== "string" || session.name === "") {
    for (const [, row] of ipairs<any>((spec && spec.players) || [null])) {
      if (spec.seat != null && tonumber(row.seat) === tonumber(spec.seat)) session.name = row.name;
    }
  }
  session.store = session.store || { flags: {}, vars: {} };
  return session;
}

export class Game3 {
  [key: string]: any;

  // Lua: Game3.lua:41
  static SKIN_FAST_FORWARD = 4;
  // Lua: Game3.lua:741
  static GC_BUDGET_SEC = 0.0003;
  static GC_MAX_STEPS = 64;
  static GC_CEILING_KB = 1024 * 1024;

  generation = 3;
  input: any = Input;
  save: any = undefined;
  session: any = undefined;
  phase = "boot";
  boot: any = undefined;
  returnToLauncher: (() => void) | undefined = undefined;
  onExit: (() => void) | undefined = undefined;

  // Lua: Game3.lua:46
  static new(): Game3 {
    return new Game3();
  }

  // Lua: Game3.lua:59
  _hasContinueSave(): boolean {
    if (!SaveData.load) return false;
    const [ok, save] = pcall(() => SaveData.load()[0]);
    if (!ok || save == null || typeof save !== "object") return false;
    return save.engine === "game3" && typeof save.map === "string"
      && MapIds.isGame3Map(save.map, save.version);
  }

  // Lua: Game3.lua:71
  _enterField(session: any, reason: string, optsIn?: any): void {
    const opts = optsIn || {};
    const fieldCallback = opts.fieldCallback && FIELD_CALLBACKS[opts.fieldCallback];
    this.session = session;
    Options.bind(session, this.options);
    const R: any = Rng;
    if (reason === "continue") {
      if (!R.restoreFromSession(session)) {
        const tid = R.seedNewGame();
        if (session.trainerId == null) session.trainerId = tid;
        R.captureToSession(session);
      } else {
        R.perturb();
      }
    } else if (session.rng) {
      R.restoreFromSession(session);
      R.perturb();
    }
    this.save = Schema.toSaveTable(session);
    this.phase = "field";
    this.boot = undefined;
    {
      const B: any = Bg;
      if (B && B.reset) B.reset();
    }
    {
      const O: any = Oam;
      if (O && O.reset) O.reset();
    }
    {
      const F: any = Fade;
      if (F) {
        if (F.clear) F.clear();
        if (!fieldCallback) {
          if (F.begin) F.begin(F.MODE.FROM_BLACK, 1);
          F.lockInput = true; // pokefirered/src/field_fadetransition.c:441
        }
      }
    }
    session._questNewScene = true;
    if (reason === "continue") session._questMap = session.map;
    const M: any = G3Map;
    M._announced = undefined;
    M._nextEnterVia = (reason === "continue") ? "continue" : "new_game";
    // pokefirered/src/fieldmap.c:100
    Runtime.start(undefined, this, session, { reason: reason || "new_game" });
    M._nextEnterVia = undefined;
    if (fieldCallback) {
      const cb = G3Lazy[fieldCallback];
      if (!cb) throw new Error("NOT FAITHFUL: Emerald only (" + fieldCallback + " is not ported)");
      cb.execute();
    }
    if (reason === "continue") {
      if (Profile.family(session) === "rse") {
        // pokeemerald/src/overworld.c:1749
        throw new Error("NOT FAITHFUL: Emerald only (rse.init tryPutTodaysRivalTrainerOnAir)");
      }
      // pokefirered/src/overworld.c:1717
      const S: any = Space;
      if (S && S.runOnReturnToField) {
        S.runOnReturnToField();
      }
    }
  }

  // Lua: Game3.lua:131
  load(optsIn?: any): void {
    const activeVersion = GameVersion.get();
    Versions.select(activeVersion);
    SE.select(activeVersion);
    Song.select(activeVersion);
    ItemsData.ensureModel();
    const opts = optsIn || {};
    this.onExit = opts.onExit || this.onExit;
    Input.init();
    // the host seam: the 3DS pad's events come to this object (Input.ts)
    Input.setHostSink(this as any);
    this.input = Input;
    (Dataset as any).hydrate(this);
    if (this.data != null && typeof this.data === "object") this.data.generation = 3;
    const H: any = Help;
    H.reset();
    H.install((Dataset as any).cache());
    (QuestLog as any).install((Dataset as any).cache());

    inert(TouchControls, "init");
    this.touchControls = TouchControls;
    inert(TouchControls, "setHotkeyHandler", (action: string | undefined, pressed: boolean) => {
      if (!action) return;
      if (action.slice(0, 4) === "key:") {
        const key = action.slice(4);
        if (pressed) {
          if (this.keypressed) this.keypressed(key);
        } else {
          if (this.keyreleased) this.keyreleased(key);
        }
        return;
      }
      if (action === "fast_forward_hold") {
        if (pressed) {
          if (this._skinSpeedPrev == null) {
            this._skinSpeedPrev = this.speedOverride || false;
          }
          this.speedOverride = Game3.SKIN_FAST_FORWARD;
        } else {
          const prev = this._skinSpeedPrev;
          this._skinSpeedPrev = undefined;
          this.speedOverride = (prev !== false) ? prev : undefined;
        }
      } else if (action === "fast_forward_toggle") {
        if (pressed) this._cycleSpeed(1);
      } else if (action === "soft_reset") {
        if (pressed && this.phase !== "arena") {
          if (this.input) this.input.reset();
          inert(TouchControls, "reset");
          this.returnToTitle();
        }
      } else if (action === "menu") {
        if (pressed && this.phase === "field" && this.session) {
          (OptionMenu as any).show({ session: this.session, game: this });
        }
      }
    });

    const [rawSave, saveStatus] = this.loadSaveStatus();
    let options = (SaveData.loadOptions && SaveData.loadOptions())
      || (rawSave && rawSave.options)
      || (SaveData.defaultOptions && SaveData.defaultOptions());
    this.options = options;
    this.applyOptions(options);
    options = this.options;

    this._exposeModData();
    this._loadMods(opts);
    // DiscordPresence: no module in this runtime (pcall'd in the Lua)

    if (opts.arena) {
      FixedStep.init((dt: number) => {
        this.fixedUpdate(dt);
        this._speedLockEdge();
      });
      // PresentSync.applyFixedStepPeriod: no module in this runtime (pcall'd in the Lua)
      this.enterArena(opts.arena);
      return;
    }

    const continueOk = this._hasContinueSave();
    (StartMenu as any).resetCursor(); // pokefirered/src/main.c:134
    const B: any = Boot;
    this.boot = B.new(this);
    B.setHasContinue(this.boot, continueOk);
    if (continueOk) {
      B.setContinueInfo(this.boot, B.continueInfoFromSave(rawSave));
    }
    B.setSaveStatus(this.boot, saveStatus);
    B.setTextSpeed(this.boot, Options.block(this.options).textSpeed);
    this.phase = "boot";
    this.session = undefined;

    FixedStep.init((dt: number) => {
      this.fixedUpdate(dt);
      this._speedLockEdge();
    });
    // PresentSync.applyFixedStepPeriod: no module in this runtime (pcall'd in the Lua)
    if (ModRuntime.wants("game.ready")) {
      ModRuntime.emit("game.ready", { game: this });
    }
  }

  // Lua: Game3.lua:187-199 and 1321-1333 (the same block in load and returnToTitle) -- [rawSave, saveStatus]
  private loadSaveStatus(): [any, string] {
    let okLoad = false, rawSave: any, recovered: any;
    if (SaveData.load) {
      try {
        [rawSave, recovered] = SaveData.load();
        okLoad = true;
      } catch {
        okLoad = false;
      }
    }
    if (!okLoad) { rawSave = undefined; recovered = undefined; }
    let saveStatus = "ok";
    if (recovered) {
      saveStatus = "error"; // pokefirered/src/main_menu.c:251
    } else if (okLoad && rawSave == null && SaveData.persistenceFs && SaveData.saveFilename) {
      const [okFs, exists] = pcall(() => {
        const fs = SaveData.persistenceFs(undefined);
        return fs && fs.getInfo && fs.getInfo(SaveData.saveFilename()) != null;
      });
      if (okFs && exists) saveStatus = "invalid"; // pokefirered/src/main_menu.c:246
    }
    return [rawSave, saveStatus];
  }

  // Lua: Game3.lua:275 -- pokefirered/src/cable_club.c:964
  enterArena(spec: any): any {
    const session = arenaSession(this, spec);
    Options.bind(session, this.options);
    this.session = session;
    this.save = Schema.toSaveTable(session);
    this.boot = undefined;
    Runtime.session = session;
    Runtime._game = this;
    this.phase = "arena";
    const ArenaState = G3Lazy["src.ui.game3.arena_state"];
    if (!ArenaState) throw new Error("NOT FAITHFUL: link deferred (arena_state is not ported)");
    this.arena = ArenaState.new(this, spec);
    return this.arena;
  }

  // Lua: Game3.lua:288
  leaveArena(): void {
    this.arena = undefined;
    if (Runtime.session === this.session) Runtime.session = undefined;
    if (Runtime._game === this && !Runtime.isActive()) Runtime._game = undefined;
  }

  // Lua: Game3.lua:294
  _exposeModData(): void {
    const data = this.data;
    if (data == null || typeof data !== "object") return;
    data.gen3Pokemon = Pokemon;
    const M: any = Moves;
    if (!M._romLoaded) pcall(() => M.loadRomPack((Dataset as any).cache()));
    data.gen3Moves = M;
    const I: any = ItemsData;
    pcall(() => I.ensureLoaded());
    data.gen3Items = I;
    data.gen3Encounters = (Encounters as any)._tables;
    const [okT, pack] = pcall(() => (Trainers as any).pack());
    data.gen3Trainers = okT && pack != null && typeof pack === "object" ? pack : undefined;
    const S: any = Space;
    const bundle = S.bundle;
    data.gen3Text = bundle ? bundle.text : undefined;
    data.gen3Scripts = bundle ? bundle.scripts : undefined;
    data.gen3RomText = (RomText as any).overrides;
  }

  // Lua: Game3.lua:316
  // src.mods.Loader is not part of this runtime: the pcall fails as Brian's
  // does when the loader cannot load, and the game continues without mods.
  _loadMods(_opts?: any): void {
    Logger.error("mods failed to load, continuing without them: %s",
      "src.mods.Loader is not part of this runtime");
    Strings.load(this.data);
    const C: any = Gen3Compat;
    if (C != null && typeof C === "object" && C.applyMerged) {
      const [okA, , err] = pcall(() => C.applyMerged(this));
      if (!okA) {
        Logger.error("Gen3Compat.applyMerged failed: %s", errText(err));
      }
    }
  }

  // Lua: Game3.lua:345
  adoptSave(session: any, seedBuckets?: boolean): void {
    if (session == null || typeof session !== "object") return;
    if (session.modData == null || typeof session.modData !== "object") session.modData = {};
    const loader = this.mods;
    if (!loader) return;
    if (seedBuckets) {
      for (const [id, bucket] of pairs(loader.modSave || {})) {
        if (session.modData[id] == null) session.modData[id] = bucket;
      }
    }
    loader.modSave = session.modData;
  }

  // Lua: Game3.lua:358
  writeOptions(): void {
    if (this.options == null || typeof this.options !== "object") return;
    if (SaveData.saveOptions) pcall(() => SaveData.saveOptions(this.options));
  }

  // Lua: Game3.lua:362
  persistOptions(): void {
    this.writeOptions();
  }

  // Lua: Game3.lua:364
  applyOptions(optsIn?: any): void {
    const opts = optsIn || this.options || {};
    this.options = opts;
    const tryCall = (m: any, fn: string, ...args: unknown[]): any => {
      if (m == null) return undefined;
      const f = m[fn];
      if (typeof f !== "function") return undefined;
      const [okCall, res] = pcall(() => f.apply(m, args));
      if (!okCall) return undefined;
      return res;
    };
    Audio.applyEngineOptions(opts);
    const cartOpts = Options.block(opts);
    VoidFill.setMode(cartOpts.voidFill);
    pcall(() => (Chrome as any).setFrameType(cartOpts.frameType));
    tryCall(Tilt, "applyOptions", opts);
    tryCall(Letterbox, "applyOptions", opts);
    tryCall(Zoom, "applyOptions", opts);
    tryCall(VideoMode, "applyOptions", opts);
    tryCall(Orientation, "applyOptions", opts);
    const FR: any = FaithfulRes;
    if (FR.setNativeSize) {
      FR.setNativeSize((Display as any).W, (Display as any).H);
    }
    tryCall(FaithfulRes, "applyOptions", opts);
    tryCall(ScreenPosition, "applyOptions", opts);
    tryCall(VSync, "applyOptions", opts);
    tryCall(FrameCap, "applyOptions", opts);
    tryCall(LogicClock, "applyOptions", opts);
    // PresentSync.applyFixedStepPeriod: no module in this runtime
    const caps = tryCall(Performance, "applyOptions", opts);
    if (caps != null && typeof caps === "object") {
      if (!caps.tilt) tryCall(Tilt, "setLevel", 0);
      const Z: any = Zoom;
      if (Z) {
        Z.allowSurvey = caps.survey;
        if (!caps.survey && (Z.offset ?? 0) < 0) Z.offset = 0;
      }
      if (caps.fpsMax) {
        tryCall(FrameCap, "clampToPerformance", caps.fpsMax);
      }
    }
    if (this.touchControls) {
      inert(this.touchControls, "applyOptions", {
        touchControls: opts.touchControls,
        haptics: opts.haptics,
        hotbar: opts.hotbar,
      });
    }
    if (this.input && opts.bindings) {
      this.input.applyBindings(opts.bindings);
    }
  }

  // Lua: Game3.lua:422 -- pokefirered/src/main.c:325
  _aliasLA(): void {
    const input = this.input;
    if (!input || !input.setButtonAlias) return;
    let on: boolean | undefined;
    if (this.session) {
      on = Options.lEqualsA(this.session);
    } else if (this.options != null && typeof this.options === "object") {
      on = tonumber(Options.block(this.options).buttonMode) === 2;
    }
    input.setButtonAlias("l", on ? "a" : undefined);
  }

  // Lua: Game3.lua:434
  _handleRegisteredItem(): void {
    const input = this.input;
    if (!input || !input.wasPressed || !input.wasPressed("select")) {
      return;
    }
    const session = this.session;
    const item = session ? session.registeredItem : undefined;
    if (!item) return;
    // src/item_menu.c:2025
    const M: any = G3Map;
    if (M && unionRoomMap(M.current)) return;
    // src/overworld.c:2813
    const Link = G3Lazy["src.core.game3.link"];
    if (Link != null && typeof Link === "object" && Link.link != null && Link.inLinkRoom() === true) return;
    if (Runtime && Runtime.uiBusy && Runtime.uiBusy()) return;
    const F: any = Field;
    if (F && F.locked) return;
    const P: any = Player;
    if (P && P.boulderPush) return;
    if (Profile.family(session) === "rse") {
      // pokeemerald/src/item_menu.c:2025 UseRegisteredKeyItemOnField
      throw new Error("NOT FAITHFUL: Emerald only (frontier pike / pyramid)");
    }
    const Bg3: any = Bag;
    if (!session.bag || !Bg3.has(session.bag, item, 1)) {
      session.registeredItem = undefined;
      return;
    }
    const [ok, kind, text] = (ItemUse as any).useField(session, session.bag, item, undefined);
    if (kind === "vs_seeker") {
      // pokefirered/src/item_use.c:712
      if (ok) {
        (VsSeeker as any).use(session, this);
      } else if (text) {
        (Hud as any).openMessage(this, text);
      }
      return;
    }
    // pokefirered/src/item_use.c:159 SetUpItemUseOnFieldCallback
    if (text && !(ok && FIELD_CB_SILENT[kind])) {
      (Hud as any).openMessage(this, text);
    }
  }

  // Lua: Game3.lua:483
  _handleBootAction(action: any): void {
    if (!action) return;
    if (action.action === "continue") {
      const [ok, loaded] = pcall(() => SaveData.load()[0]);
      const save: any = loaded;
      if (ok && save && save.engine === "game3") {
        if (ModRuntime.wants("save.loading")) {
          ModRuntime.emit("save.loading", { raw: save });
        }
        const activeMods = this.modStatus && this.modStatus.loaded;
        if (SaveData.runMigrations) {
          SaveData.runMigrations(save, this.mods && this.mods.migrations, activeMods);
        }
        const modsDiff = SaveData.modsDiff ? SaveData.modsDiff(save, activeMods) : undefined;
        const session = Schema.fromSaveTable(save);
        Options.bind(session, this.options);
        this.adoptSave(session, !this._modSaveAdopted);
        this._modSaveAdopted = true;
        this.sessionStartedAt = osTime();
        this.questPlayback = FieldModules.enabled("questLog", session) ? (QuestLog as any).begin(session) : undefined;
        if (this.questPlayback) {
          this.session = session;
          this.phase = "quest_log";
          Audio.stopAll();
        } else {
          this._enterField(session, "continue");
        }
        if (modsDiff && SaveData.modsDiffNotice) {
          const notice = SaveData.modsDiffNotice(modsDiff, save.meta);
          if (notice) Logger.warn("%s", notice);
        }
        if (ModRuntime.wants("save.loaded")) {
          ModRuntime.emit("save.loaded", { save: session, meta: session.meta, modsDiff });
        }
      }
      return;
    }
    if (action.action === "new_game") {
      const session = Schema.newGame({
        name: action.name,
        rivalName: action.rivalName,
        gender: action.gender ?? 0,
        start: action.start || MapIds.newGameStart(),
        trainerIdLower: action.trainerIdLower,
      });
      this.adoptSave(session, !this._modSaveAdopted);
      this._modSaveAdopted = true;
      this.sessionStartedAt = osTime();
      if (ModRuntime.wants("save.created")) {
        ModRuntime.emit("save.created", { save: session });
      }
      this._enterField(session, "new_game", { fieldCallback: action.fieldCallback });
      return;
    }
    if (action.action === "exit") {
      Audio.stopAll();
      if (this.returnToLauncher) {
        this.returnToLauncher();
      } else if (this.onExit) {
        this.onExit();
      }
      // NOT FAITHFUL: no love.event.quit on the 3DS (the host owns the process)
      return;
    }
  }

  // Lua: Game3.lua:549
  fixedUpdate(dt?: number): void {
    this._aliasLA();
    if (ModRuntime.wantsHook("input.step")) {
      ModRuntime.call("input.step", noop, this, dt ?? FixedStep.STEP);
    }
    if (this.input && this.input.step) this.input.step();
    if (this.phase === "arena") {
      if (this.session) Audio.applyOptions(this.session);
      if (this.arena) this.arena.update(dt);
      return;
    }
    if ((this.input && this.input.softResetStep && this.input.softResetStep()) || this.softResetRequested) {
      this.softResetRequested = undefined;
      if (this.input) this.input.reset();
      if (this.touchControls) inert(this.touchControls, "reset");
      this.returnToTitle();
      return;
    }
    if (this.phase === "quest_log") {
      const p = this.questPlayback;
      const scene = p.current();
      Audio.applyOptions(this.session);
      if (scene && scene.song) Audio.playSong(scene.song);
      Audio.pumpBgm();
      p.update({ a: this.input.wasPressed("a"), b: this.input.wasPressed("b") });
      if (p.done) {
        this.questPlayback = undefined;
        this.input.reset();
        this._enterField(this.session, "continue");
      }
      return;
    }
    if (!(this.input && this.input.captureArmed)
      && FieldModules.enabled("helpSystem") && (Help as any).update(this)) {
      // Keep streaming BGM fed without advancing fanfare/script callbacks.
      Audio.pumpBgm();
      return;
    }
    if (this.session) Audio.applyOptions(this.session);

    (Rng as any).step();

    if (this.phase === "boot" && this.boot) {
      const action = (Boot as any).update(this.boot, this.input, dt);
      this._handleBootAction(action);
      return;
    }

    if (this.phase === "field") {
      this._handleRegisteredItem();
      if (Runtime.isActive()) {
        Runtime.update(dt);
        if (FieldModules.enabled("questLog", this.session)) QuestRecorder.update(this);
      }
    }
  }

  // Lua: Game3.lua:607
  speedCategory(): string {
    const S: any = Stack;
    const layers = S._layers || [null];
    for (let i = len(layers); i >= 1; i--) {
      if (layers[i].isMenu) return "menu";
    }
    const B: any = Battle;
    if (B && B.isActive && B.isActive()) {
      return "battle";
    }
    if (this.phase === "field") return "overworld";
    return "menu";
  }

  // Lua: Game3.lua:620
  isFixedSpeed(): boolean {
    if (this.phase === "arena") return true;
    const Link = G3Lazy["src.core.game3.link"];
    if (Link != null && typeof Link === "object" && Link.link != null) return true;
    const MG = G3Lazy["src.core.game3.minigames.common"];
    return MG != null && typeof MG === "object" && MG.isActive != null && MG.isActive() === true;
  }

  // Lua: Game3.lua:632 -- [locked, why]
  speedLocked(): [boolean, string?] {
    if (this.isFixedSpeed()) return [true, "link"];
    const B: any = Battle;
    if (B != null && typeof B === "object" && B.isActive && B.isActive()) {
      const st = B.getState && B.getState();
      if (st != null && typeof st === "object" && st.link) return [true, "link"];
    }
    // NOT FAITHFUL: link deferred -- union_room.isActive is the offline answer (false)
    const LinkMenu = G3Lazy["src.ui.game3.link_menu"];
    if (LinkMenu != null && typeof LinkMenu === "object") {
      if (LinkMenu.isOpen && LinkMenu.isOpen()) return [true, "link"];
      const Direct = LinkMenu.Direct;
      if (Direct != null && typeof Direct === "object" && Direct.isOpen && Direct.isOpen()) {
        return [true, "link"];
      }
    }
    if (this.phase !== "field") return [false];
    const M: any = G3Map;
    if (M != null && typeof M === "object" && unionRoomMap(M.current)) {
      return [true, "link"];
    }
    const Link = G3Lazy["src.core.game3.link"];
    if (Link != null && typeof Link === "object" && Link.inLinkRoom) {
      const [ok, inRoom] = pcall(() => Link.inLinkRoom());
      if (ok && inRoom === true) return [true, "link"];
    }
    return [false];
  }

  // Lua: Game3.lua:664
  _speedLockEdge(): void {
    if ((this._frameSpeed ?? 1) > 1 && this.speedLocked()[0]) {
      FixedStep.endFrame();
    }
  }

  // Lua: Game3.lua:670
  logicSpeed(): number {
    if (this.speedLocked()[0]) return 1;
    const override = tonumber(this.speedOverride);
    if (override !== undefined) return Math.max(1, override);
    const b = this.phase === "boot" && this.boot;
    const PHASE = (Boot as any).PHASE;
    if (b && (b.phase === PHASE.INTRO || b.phase === PHASE.TITLE
      || b.phase === PHASE.TITLE_CRY || b.phase === PHASE.TITLE_RESTART)) {
      return 1;
    }
    const opts = this.options;
    if (opts == null || typeof opts !== "object") return 1;
    const key = GameSpeed.optionKey(this.speedCategory());
    return Math.max(1, GameSpeed.clamp(opts[key]));
  }

  // Lua: Game3.lua:686
  _cycleSpeed(dir: number): void {
    if (this.options == null || typeof this.options !== "object") return;
    if (this.speedLocked()[0]) return;
    const key = GameSpeed.optionKey(this.speedCategory());
    const nextSpeed = GameSpeed.cycle(this.options[key], dir);
    for (const [, c] of ipairs<string>(GameSpeed.CATEGORIES)) {
      this.options[GameSpeed.optionKey(c)] = nextSpeed;
    }
    this.writeOptions();
  }

  // Lua: Game3.lua:698
  zoomGateOK(): boolean {
    if (this.phase !== "field") return false;
    const B: any = Battle;
    if (B && B.isActive && B.isActive()) return false;
    const F: any = Field;
    if (F && F.locked) return false;
    const Shop = G3Lazy["src.ui.game3.shop_menu"];
    if (Shop && Shop.isShopCamera && Shop.isShopCamera()) return false;
    return true;
  }

  // Lua: Game3.lua:709
  zoomStep(delta: number): void {
    if (!this.zoomGateOK()) return;
    const offset = inert(Zoom, "step", delta, inert(Renderer, "fitScale"));
    if (this.options != null && typeof this.options === "object") {
      this.options.zoom = offset;
      this.writeOptions();
    }
  }

  // Lua: Game3.lua:720
  update(dt: number): void {
    const speed = this.logicSpeed();
    this._frameSpeed = speed;
    FixedStep.maxAccum = FixedStep.catchupLimit(speed, dt);
    FixedStep.update(dt, speed);
    this._audioAccum = (this._audioAccum ?? 0) + dt;
    const STEP = 1 / 60;
    let guard = 0;
    while (this._audioAccum >= STEP && guard < 8) {
      this._audioAccum = this._audioAccum - STEP;
      guard = guard + 1;
      const [okA, , errA] = pcall(() => Audio.update(STEP));
      if (!okA) s9log("audio", errA);
    }
    if (this._audioAccum > 0.25) this._audioAccum = 0;
    const [okT, , errT] = pcall(() => Tilt.update(dt));
    if (!okT) s9log("tilt", errT);
    // DiscordPresence.update: no module in this runtime (pcall'd in the Lua)
    Game3.stepGC();
  }

  // Lua: Game3.lua:745 -- NOT FAITHFUL: collectgarbage does not exist here (QuickJS collects on its own)
  static stepGC(): void {}

  // Lua: Game3.lua:761
  _drawHud(w: number, h: number): void {
    if (!ModRuntime.wantsHook("render.hud")) return;
    const fit = (Display as any).fit(w, h) || [];
    const [scale, ox, oy, , , scaleY] = fit;
    const viewport = {
      width: w, height: h,
      gameX: ox, gameY: oy,
      gameWidth: (Display as any).W * scale, gameHeight: (Display as any).H * (scaleY ?? scale),
      scale,
    };
    G.push("all");
    const [okR, , errR] = pcall(() => ModRuntime.call("render.hud", noop, this, viewport));
    if (!okR) s9log("render.hud", errR);
    G.pop();
  }

  // Lua: Game3.lua:776
  draw(): void {
    const w = G.getWidth();
    const h = G.getHeight();
    const D: any = Display;

    if (this.phase === "arena") {
      if (this.arena) this.arena.draw(w, h);
      this._drawHud(w, h);
      if (this.touchControls) inert(this.touchControls, "draw");
      return;
    }

    if (this.phase === "quest_log" || (this.phase === "boot" && this.boot)) {
      const kind = (this.phase === "quest_log") ? "quest" : "boot";
      const drawBootFrame = (): void => {
        if (this.phase === "quest_log") (QuestLog as any).draw(this.questPlayback, this.session);
        else if ((Help as any).isOpen()) (Help as any).draw();
        else (Boot as any).draw(this.boot);
      };
      if (!D.presentUi(this, w, h, kind, drawBootFrame)) {
        const canvas = D.ensureCanvas("main");
        if (canvas) {
          G.push("all");
          G.setCanvas(canvas);
          G.origin();
          drawBootFrame();
          G.setCanvas();
          G.pop();
          const [scale, ox, oy, , , scaleY] = D.fit(w, h);
          G.setColor(0.02, 0.04, 0.08, 1);
          G.rectangle("fill", 0, 0, w, h);
          G.setColor(1, 1, 1, 1);
          G.draw(canvas, ox, oy, 0, scale, scaleY);
        } else {
          drawBootFrame();
        }
      }
      this._drawHud(w, h);
      if (this.touchControls) inert(this.touchControls, "draw");
      return;
    }

    if (Runtime.isActive()) {
      if (D.present(this, w, h)) {
        this._drawHud(w, h);
        if (this.touchControls) inert(this.touchControls, "draw");
        return;
      }
    }

    G.clear(0.05, 0.05, 0.12);
    G.setColor(0.4, 0.8, 0.4);
    // NOT FAITHFUL: the debug "Fire Red field: <map>" printf is dropped (no LOVE font on the 3DS)
    this._drawHud(w, h);
    if (this.touchControls) inert(this.touchControls, "draw");
  }

  // Lua: Game3.lua:838
  _hotkey(key: string): boolean {
    const hk = Input.hotkeyKey(key);
    if (key === "f1") {
      if (this.quickSaveAllowed()) this.saveGame();
      return true;
    } else if (key === "f2") {
      if (this.phase === "field") {
        pcall(() => (Stack as any).clear());
        pcall(() => { if (Runtime.stop) Runtime.stop(undefined, this); });
        pcall(() => (Ghosts as any).clear());
        this._handleBootAction({ action: "continue" });
      }
      return true;
    } else if (hk === "1") {
      this._cycleSpeed(1);
      return true;
    } else if (hk === "3") {
      if (this.zoomGateOK()) {
        Tilt.cycle();
        if (this.options != null && typeof this.options === "object") {
          this.options.tilt = Tilt.level;
          this.writeOptions();
        }
      }
      return true;
    } else if (hk === "4") {
      if (this.zoomGateOK()) {
        const offset = inert(Zoom, "cycle", inert(Renderer, "fitScale"));
        if (this.options != null && typeof this.options === "object") {
          this.options.zoom = offset;
          this.writeOptions();
        }
      }
      return true;
    } else if (key === "-" || key === "kp-") {
      this.zoomStep(-1);
      return true;
    } else if (key === "=" || key === "kp+") {
      this.zoomStep(1);
      return true;
    }
    return false;
  }

  // Lua: Game3.lua:888
  keypressed(key: string): any {
    const vanilla = (): void => {
      const armed = this.input && this.input.captureArmed;
      const bound = this.input && this.input.keyBindings && this.input.keyBindings[key] != null;
      if (!armed && !bound && this._hotkey(key)) return;
      if (this.input && this.input.keypressed) this.input.keypressed(key);
    };
    if (!ModRuntime.wantsHook("input.key")) return vanilla();
    return ModRuntime.call("input.key", vanilla, this, { phase: "pressed", key });
  }

  // Lua: Game3.lua:898
  keyreleased(key: string): any {
    const vanilla = (): void => {
      if (this.input && this.input.keyreleased) this.input.keyreleased(key);
    };
    if (!ModRuntime.wantsHook("input.key")) return vanilla();
    return ModRuntime.call("input.key", vanilla, this, { phase: "released", key });
  }

  // Lua: Game3.lua:906
  _padPressedBody(joystick: any, button: string): void {
    if (this.touchControls) inert(this.touchControls, "noteGamepad");
    const Input2 = this.input;
    if (!Input2) return;
    if (Input2.captureArmed) {
      if (Input2.gamepadpressed) Input2.gamepadpressed(joystick, button);
      return;
    }
    let selectHeld = Input2.isDown && Input2.isDown("select");
    if (!selectHeld && joystick && joystick.isGamepadDown) {
      const [ok, down] = pcall(() => joystick.isGamepadDown("back"));
      selectHeld = ok && down === true;
    }
    if (!selectHeld && Input2.padAction) {
      const action = Input2.padAction(button, true);
      if (action === "speedUp") {
        this._cycleSpeed(1);
        return;
      } else if (action === "speedDown") {
        this._cycleSpeed(-1);
        return;
      }
    }
    if (selectHeld) {
      const digit = GamepadMap.displayChordDigit(button);
      if (digit && this._hotkey(digit)) return;
    }
    if (Input2.gamepadpressed) Input2.gamepadpressed(joystick, button);
  }

  // Lua: Game3.lua:937
  _padReleasedBody(joystick: any, button: string): void {
    if (this.input && this.input.gamepadreleased) {
      this.input.gamepadreleased(joystick, button);
    }
  }

  // Lua: Game3.lua:943
  gamepadpressed(joystick: any, button: string): any {
    if (this.input && this.input.padEventSeen) this.input.padEventSeen(button);
    const vanilla = (): void => { this._padPressedBody(joystick, button); };
    if (!ModRuntime.wantsHook("input.gamepad")) return vanilla();
    return ModRuntime.call("input.gamepad", vanilla, this,
      { phase: "pressed", joystick, button });
  }

  // Lua: Game3.lua:950
  gamepadreleased(joystick: any, button: string): any {
    const vanilla = (): void => { this._padReleasedBody(joystick, button); };
    if (!ModRuntime.wantsHook("input.gamepad")) return vanilla();
    return ModRuntime.call("input.gamepad", vanilla, this,
      { phase: "released", joystick, button });
  }

  // Lua: Game3.lua:958 -- pokefirered/src/start_menu.c:198
  saveOffered(): any {
    const session = (Runtime.getSession && Runtime.getSession()) || this.session;
    return (StartMenu as any).saveOffered(session, this);
  }

  // Lua: Game3.lua:964 -- pokeemerald/src/overworld.c:1445
  quickSaveAllowed(): boolean {
    if (this.phase !== "field") return false;
    const H: any = Hud;
    if (H.busy() || !H.startButtonAllowed()) return false;
    const S: any = Space;
    if (S && S._pendingOnFrame) return false;
    return this.saveOffered();
  }

  // Lua: Game3.lua:973
  saveGame(): boolean | undefined {
    if (!this.session || this.phase === "quest_log" || this.phase === "arena") return undefined;
    if (ModRuntime.wantsHook("save.write")
      && ModRuntime.call("save.write", () => true, this) === false) {
      return false;
    }
    if (Runtime.getSession) {
      const s = Runtime.getSession();
      if (s) this.session = s;
    }
    pcall(() => (Space as any).persistSession(undefined, this));
    if (FieldModules.enabled("questLog", this.session)) QuestRecorder.save(this);
    const save: any = Schema.toSaveTable(this.session);
    if (SaveData.buildMeta) {
      save.meta = SaveData.buildMeta(
        this.modStatus && this.modStatus.loaded, save.meta, this.sessionStartedAt);
      this.session.meta = save.meta;
    }
    this.save = save;
    if (ModRuntime.wants("save.writing")) {
      ModRuntime.emit("save.writing", { save, meta: save.meta });
    }
    if (!SaveData.save) return false;
    const [ok, written] = pcall(() => SaveData.save(save));
    return ok && written !== false;
  }

  // Lua: Game3.lua:1002
  resize(): void {}

  // Lua: Game3.lua:1004 -- POKEPORT_TOUCH is never set on the 3DS
  mousepressed(_x: number, _y: number, _button?: number, istouch?: boolean): void {
    if (istouch) return;
  }

  // Lua: Game3.lua:1011
  mousemoved(_x: number, _y: number, _dx?: number, _dy?: number, istouch?: boolean): void {
    if (istouch) return;
  }

  // Lua: Game3.lua:1018
  mousereleased(_x: number, _y: number, _button?: number, istouch?: boolean): void {
    if (istouch) return;
  }

  // Lua: Game3.lua:1025
  wheelmoved(_: unknown, dy: unknown): any {
    if (typeof dy !== "number") return undefined;
    const vanilla = (): void => {
      if (dy > 0) {
        this.zoomStep(1);
      } else if (dy < 0) {
        this.zoomStep(-1);
      }
    };
    if (!ModRuntime.wantsHook("input.wheel")) return vanilla();
    return ModRuntime.call("input.wheel", vanilla, this, dy);
  }

  // Lua: Game3.lua:1037
  textinput(): void {}
  // Lua: Game3.lua:1038
  filedropped(): void {}

  // Lua: Game3.lua:1040
  touchpressed(id: unknown, x: number, y: number): void {
    if (this.touchControls && inert(this.touchControls, "touchpressed", id, x, y)) return;
  }

  // Lua: Game3.lua:1044
  touchmoved(id: unknown, x: number, y: number): void {
    if (this.touchControls) inert(this.touchControls, "touchmoved", id, x, y);
  }

  // Lua: Game3.lua:1048
  touchreleased(id: unknown, x: number, y: number): void {
    if (this.touchControls) inert(this.touchControls, "touchreleased", id, x, y);
  }

  // Lua: Game3.lua:1052
  gamepadaxis(joystick: any, axis: string, value: number): any {
    const vanilla = (): void => {
      if (Math.abs(value) > 0.5 && this.touchControls) {
        inert(this.touchControls, "noteGamepad");
      }
      if (this.input && this.input.triggerAxis) {
        const [trigger, phase] = this.input.triggerAxis(axis, value);
        if (trigger) {
          if (phase === "pressed") {
            this._padPressedBody(joystick, trigger);
          } else if (phase === "released") {
            this._padReleasedBody(joystick, trigger);
          }
          return;
        }
      }
      if (this.input && this.input.gamepadaxis) this.input.gamepadaxis(joystick, axis, value);
    };
    if (!ModRuntime.wantsHook("input.gamepad")) return vanilla();
    return ModRuntime.call("input.gamepad", vanilla, this,
      { phase: "axis", joystick, axis, value });
  }

  // Lua: Game3.lua:1075
  joystickpressed(joystick: any, button: number): void {
    if (GamepadMap.ignoreRawForJoystick(joystick) || GamepadMap.isAccelerometer(joystick)) return;
    if (this.touchControls) inert(this.touchControls, "noteGamepad");
    const Input2 = this.input;
    if (Input2 && Input2.joyAction && !Input2.captureArmed
      && !(Input2.isDown && Input2.isDown("select"))) {
      const action = Input2.joyAction(button);
      if (action === "speedUp") {
        this._cycleSpeed(1);
        return;
      } else if (action === "speedDown") {
        this._cycleSpeed(-1);
        return;
      }
    }
    if (Input2 && Input2.joystickpressed) Input2.joystickpressed(joystick, button);
  }

  // Lua: Game3.lua:1094
  joystickreleased(joystick: any, button: number): void {
    if (this.input && this.input.joystickreleased) this.input.joystickreleased(joystick, button);
  }

  // Lua: Game3.lua:1098
  joystickaxis(joystick: any, axis: number, value: number): void {
    if (Math.abs(value) > 0.5 && this.touchControls) {
      inert(this.touchControls, "noteGamepad");
    }
    if (this.input && this.input.joystickaxis) this.input.joystickaxis(joystick, axis, value);
  }

  // Lua: Game3.lua:1105
  joystickhat(joystick: any, hat: number, direction: string): void {
    if (direction !== "c" && this.touchControls) {
      inert(this.touchControls, "noteGamepad");
    }
    if (this.input && this.input.joystickhat) this.input.joystickhat(joystick, hat, direction);
  }

  // Lua: Game3.lua:1112
  _releaseModInput(): void {
    if (this.mods && this.mods.releaseModInput) this.mods.releaseModInput();
  }

  // Lua: Game3.lua:1116
  joystickadded(): void {
    this._releaseModInput();
  }

  // Lua: Game3.lua:1120
  joystickremoved(_joystick?: any): void {
    this._releaseModInput();
    if (this.touchControls) inert(this.touchControls, "joystickremoved");
  }

  // Lua: Game3.lua:1125
  focus(f: boolean): void {
    if (this.input) this.input.reset();
    if (this.touchControls) inert(this.touchControls, "reset");
    this._releaseModInput();
    if (f) {
      if (this.input) this.input.reconcile();
      Audio.onFocusGained();
    }
  }

  // Lua: Game3.lua:1135
  visible(v: boolean): void {
    if (v) {
      this.onResume();
    } else {
      if (this.input) this.input.reset();
      if (this.touchControls) inert(this.touchControls, "reset");
    }
  }

  // Lua: Game3.lua:1144
  onResume(): void {
    if (this.input) {
      this.input.reset();
      this.input.reconcile();
    }
    if (this.touchControls) inert(this.touchControls, "reset");
    Audio.onFocusGained();
  }

  // Lua: Game3.lua:1303
  returnToTitle(optsIn?: any): void {
    const opts = optsIn || {};
    this.questPlayback = undefined;
    (Help as any).reset();
    Audio.stopAll();
    (Stack as any).clear();
    clearFieldScreens();
    if (Runtime.isActive()) {
      Runtime.stop(undefined, this);
    }
    {
      const O: any = Objects;
      if (O && O.reset) pcall(() => O.reset());
    }
    {
      const F: any = Field;
      if (F && F.clearMetatiles) pcall(() => F.clearMetatiles());
    }
    this.phase = "boot";
    this.session = undefined;

    const [rawSave, saveStatus] = this.loadSaveStatus();
    const continueOk = this._hasContinueSave();
    (StartMenu as any).resetCursor();
    const B: any = Boot;
    this.boot = B.new(this);
    B.setHasContinue(this.boot, continueOk);
    if (continueOk) {
      B.setContinueInfo(this.boot, B.continueInfoFromSave(rawSave));
    }
    B.setSaveStatus(this.boot, saveStatus);
    B.setTextSpeed(this.boot, Options.block(this.options).textSpeed);
    if (!this.boot.custom || opts.skipIntro) {
      if (this.boot.custom) this.boot.custom.coldBoot = false;
      this.boot.phase = B.PHASE.TITLE;
      this.boot.timer = 0;
      B.enterTitle(this.boot);
    }
  }

  // Lua: Game3.lua:1351
  reset(): void {
    this.questPlayback = undefined;
    (Help as any).reset();
    Audio.endSession();
    (Stack as any).clear();
    clearFieldScreens();
    {
      const W: any = Warp;
      if (W && W.clear) pcall(() => W.clear());
    }
    {
      const D: any = Doors;
      if (D && D.release) pcall(() => D.release());
    }
    if (Runtime.isActive()) {
      pcall(() => Runtime.stop(undefined, this));
    }
    {
      const Gh: any = Ghosts;
      if (Gh && Gh.clear) pcall(() => Gh.clear());
    }
    for (const mod of [Oam, Bg, Objects] as any[]) {
      if (mod && mod.reset) pcall(() => mod.reset());
    }
    {
      const F: any = Field;
      if (F && F.clearMetatiles) pcall(() => F.clearMetatiles());
    }
    (Display as any).release();
    if (this.touchControls) {
      pcall(() => inert(this.touchControls, "setHotkeyHandler", undefined));
      this.touchControls = undefined;
    }
    Input.setHostSink(undefined);
    this.boot = undefined;
    this.arena = undefined;
    this.session = undefined;
    this.data = undefined;
    this.mods = undefined;
    this.modStatus = undefined;
    this._modSaveAdopted = undefined;
    this.phase = "boot";
    this.returnToLauncher = undefined;
    this.onExit = undefined;
  }

  // Lua: Game3.lua:1389
  quit(): void {
    if (this.quickSaveAllowed()) this.saveGame();
  }
}

export default Game3;
