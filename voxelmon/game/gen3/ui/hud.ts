// Port of gen1recomp src/ui/game3/hud.lua (GPLv3 + additional terms; see LICENSE.md).
// Game3 UI controller: input + open helpers.
// Drawing is owned by display.lua / gfx.lua (FRLG 240×160).
//
// Brian's `package.loaded[name]` / lazyReq(name) reads become static
// imports: every module named here is part of the port (stub or not), so
// "is it loaded" is always yes. Modules outside the port are noted where
// they are reached.

import { tonumber, tostring, truthy } from "../../../import/gen3/lua.ts";
import { len, type LuaTable } from "../platform/lt.ts";
import Message from "./message.ts";
import Choice from "./choice.ts";
import StartMenu from "./start_menu.ts";
import BagMenu from "./bag_menu.ts";
import RegionMap from "./region_map.ts";
import PartyMenu from "./party_menu.ts";
import Pokedex from "./pokedex.ts";
import OptionMenu from "./option_menu.ts";
import SaveMenu from "./save_menu.ts";
import TrainerCard from "./trainer_card.ts";
import PcMenu from "./pc_menu.ts";
import SummaryMenu from "./summary_menu.ts";
import ShopMenu from "./shop_menu.ts";
import Stack from "./stack.ts";
import Screens from "./screens.ts";
import Naming from "./naming.ts";
import EasyChat from "./easy_chat.ts";
import Fade from "./fade.ts";
import MapPreviewScreen from "./map_preview_screen.ts";
import Battle from "../core/battle.ts";
import Field from "../core/field.ts";
import Forced from "../core/forced_movement.ts";
import Warp from "../core/warp.ts";
import Player from "../core/player.ts";
import Space from "../core/scripting/space.ts";
import Flags from "../core/scripting/flags.ts";
import Runtime from "../core/runtime.ts";
import Audio from "../core/audio.ts";
import SE from "../core/se_ids.ts";

/** What Hud reads of the game: its input. */
export interface HudInput { wasPressed(k: string): boolean; isDown(k: string): boolean }
export interface HudGame { input?: HudInput; [k: string]: unknown }

const M = (m: unknown): LuaTable => m as LuaTable;

const s9Warned: Record<string, boolean> = {};
// Lua: hud.lua:23
function s9log(key: string, err: unknown): void {
  if (s9Warned[key]) return;
  s9Warned[key] = true;
  console.log("[game3/hud] hot-path pcall failed (" + key + "): " + tostring(err instanceof Error ? err.message : err));
}

// Lua: hud.lua:34
function log(msg: unknown): void {
  console.log("[game3] " + tostring(msg));
}

// Lua: hud.lua:68
function update_top_menu(input: HudInput): boolean {
  const top = Stack.top();
  if (top && top.mod) {
    const skin = Screens.skin(top.id);
    if (skin && skin.handleInput) {
      skin.handleInput(input, top.mod);
      return true;
    }
    if (top.mod.handleInput) {
      top.mod.handleInput(input);
      return true;
    }
  }
  if (SaveMenu.isOpen()) {
    if (input.wasPressed("left") || input.wasPressed("right")
        || input.wasPressed("up") || input.wasPressed("down")) {
      SaveMenu.move(1);
    } else if (input.wasPressed("a")) SaveMenu.confirm();
    else if (input.wasPressed("b")) SaveMenu.cancel();
    return true;
  }
  if (OptionMenu.isOpen()) {
    OptionMenu.handleInput(input);
    return true;
  }
  if (TrainerCard.isOpen()) {
    if (input.wasPressed("b") || input.wasPressed("start") || input.wasPressed("a")) {
      TrainerCard.close();
    }
    return true;
  }
  if (PcMenu.isOpen()) {
    if (PcMenu.handleInput) {
      PcMenu.handleInput(input);
    }
    return true;
  }
  if (ShopMenu.isOpen()) {
    if (ShopMenu.handleInput) {
      ShopMenu.handleInput(input);
    }
    return true;
  }
  if (BagMenu.isOpen()) {
    if (BagMenu.handleInput) {
      BagMenu.handleInput(input);
    } else {
      if (input.wasPressed("b") || input.wasPressed("start")) BagMenu.close();
    }
    return true;
  }
  if (RegionMap.isOpen()) {
    if (RegionMap.handleInput) {
      RegionMap.handleInput(input);
    } else {
      if (input.wasPressed("b") || input.wasPressed("start")) RegionMap.close();
    }
    return true;
  }
  if (SummaryMenu.isOpen()) {
    if (SummaryMenu.handleInput) {
      SummaryMenu.handleInput(input);
    } else {
      if (input.wasPressed("b") || input.wasPressed("start")) SummaryMenu.close();
    }
    return true;
  }
  if (PartyMenu.isOpen()) {
    if (PartyMenu.handleInput) {
      PartyMenu.handleInput(input);
    } else {
      if (input.wasPressed("b") || input.wasPressed("start")) PartyMenu.close();
    }
    return true;
  }
  if (Pokedex.isOpen()) {
    if (Pokedex.handleInput) {
      Pokedex.handleInput(input);
    } else {
      if (input.wasPressed("b") || input.wasPressed("start")) Pokedex.close();
    }
    return true;
  }
  if (StartMenu.isOpen()) {
    if (input.wasPressed("up")) StartMenu.move(-1);
    else if (input.wasPressed("down")) StartMenu.move(1);
    else if (input.wasPressed("a")) StartMenu.confirm();
    else if (input.wasPressed("b") || input.wasPressed("start")) {
      if (StartMenu.cancel) StartMenu.cancel(); else StartMenu.close();
    }
    return true;
  }
  return false;
}

// pokefirered/src/field_control_avatar.c:108
// Lua: hud.lua:165
function start_button_allowed(): boolean {
  const F = M(Field), Sp = M(Space), Fo = M(Forced), W = M(Warp), P = M(Player);
  const scriptBusy = Sp && Sp.vm && Sp.vm.isRunning && Sp.vm.isRunning();
  // pokefirered/src/field_effect.c:1155 FieldCB_FallWarpExit
  const locked = (F && truthy(F.locked) ? F.locked : undefined)
    || (Fo && Fo.isForced && Fo.isForced())
    || (W && W.isBusy && W.isBusy())
    // pokefirered/src/field_player_avatar.c:1419
    || (P && P.boulderPush != null);
  return !truthy(locked) && !truthy(scriptBusy);
}

export const Hud = {
  startButtonAllowed: start_button_allowed,
  _waitButton: undefined as (() => void) | undefined,
  _fieldInput: undefined as { start: boolean } | undefined,

  // Lua: hud.lua:38
  isMenuOpen(): boolean {
    const N = M(Naming), E = M(EasyChat);
    return !!(Stack.busy()
      || StartMenu.isOpen() || BagMenu.isOpen() || RegionMap.isOpen()
      || PartyMenu.isOpen() || SummaryMenu.isOpen() || Pokedex.isOpen()
      || OptionMenu.isOpen() || SaveMenu.isOpen()
      || TrainerCard.isOpen() || PcMenu.isOpen()
      || ShopMenu.isOpen()
      || (N && N.isOpen && N.isOpen())
      || (E && E.isOpen && E.isOpen()));
  },

  // Lua: hud.lua:51
  busy(): boolean {
    const B = M(Battle);
    if (B && B.isActive && B.isActive()) return true;
    return !!(Message.isOpen() || Choice.active || Hud.isMenuOpen()
      || (Fade && Fade.isActive && Fade.isActive())
      || Hud._waitButton != null);
  },

  // Lua: hud.lua:60
  armWaitButton(cb: (() => void) | undefined): void {
    Hud._waitButton = cb;
  },

  // Lua: hud.lua:64
  clearWaitButton(): void {
    Hud._waitButton = undefined;
  },

  // pokefirered/src/field_control_avatar.c:76 FieldClearPlayerInput
  // Lua: hud.lua:183
  clearFieldInput(): void {
    Hud._fieldInput = undefined;
  },

  // pokefirered/src/field_control_avatar.c:94 FieldGetPlayerInput
  // Lua: hud.lua:188
  sampleFieldInput(game: HudGame | undefined): void {
    const input = game ? game.input : undefined;
    if (!(input && input.wasPressed)) {
      Hud._fieldInput = undefined;
      return;
    }
    // pokeemerald/src/field_control_avatar.c:97
    // NOT FAITHFUL: Emerald only -- src.core.game3.bike (its rse() Acro/Mach
    // state) is not ported; Brian's pcall fails the same way when it is absent
    Hud._fieldInput = {
      start: (input.wasPressed("start") && start_button_allowed()) || false,
    };
  },

  // Lua: hud.lua:205
  update(game: HudGame | undefined, _dt?: unknown, inputTop?: unknown): void {
    const dt = tonumber(_dt) ?? (1 / 60);

    // Active stack modal menu tick
    const top = Stack.top();
    const namingTick = top && top.id === "naming";
    if (namingTick && top.mod && top.mod.handleInput) {
      // Naming consumes input before its page-swap timer can unlock the keyboard.
      // A prompt that opened it during this frame keeps its opening button press.
      if (inputTop == null || top === inputTop) top.mod.handleInput(game ? game.input : undefined);
    }
    if (top && top.mod && top.mod.update) {
      try { top.mod.update(dt); } catch (errU) { s9log("top.update", errU); }
    }

    // Tick location map name popup banner
    // NOT FAITHFUL: src/ui/game3/map_name_popup.lua has no port (not even a
    // stub); this is Brian's failed pcall(lazyReq, ...) path
    const okPop = false;
    s9log("map_name_popup", "module 'src.ui.game3.map_name_popup' not found");

    // Tick location preview screen (map_preview_screen.c Task_RunMapPreviewScreenForest)
    // (pcall(lazyReq, ...) guards only the require, which always succeeds here)
    const okPrev = true;
    if (MapPreviewScreen && MapPreviewScreen.update) {
      MapPreviewScreen.update(dt);
    }

    const input = game ? game.input : undefined;
    if (!input) return;

    let inBattle = false;
    const B = M(Battle);
    if (B && B.isActive && B.isActive()) {
      inBattle = true;
    }

    if (inBattle || Message.isOpen() || Stack.busy()) {
      if (okPop) { /* MapNamePopup.dismiss() -- not ported (above) */ }
      if (okPrev && MapPreviewScreen && MapPreviewScreen.dismiss) {
        MapPreviewScreen.dismiss();
      }
    }

    // Do not replay naming input or leak its closing press to the menu underneath.
    if (namingTick) return;

    // Active stack modal menu input takes top precedence.
    // When battle is active, overlays like EvolutionScene or modal stack menus still receive input.
    if (Stack.busy()) {
      const top2 = Stack.top();
      const evoTop = top2 && top2.id === "evolution_scene" && (inputTop == null || top2 === inputTop);
      const pyramidBagTop = top2 && top2.id === "rse_pyramid_bag";
      if ((!inBattle) || evoTop || pyramidBagTop || (top2 && top2.id === "naming")) {
        if (update_top_menu(input)) {
          return;
        }
      }
    }

    // Choice in field/scripting (in battle, Choice is driven by Battle.update).
    if (!inBattle && Choice.active) {
      if (input.wasPressed("up")) Choice.move(-1, 0);
      else if (input.wasPressed("down")) Choice.move(1, 0);
      else if (input.wasPressed("left")) Choice.move(0, -1);
      else if (input.wasPressed("right")) Choice.move(0, 1);
      else if (input.wasPressed("a")) Choice.confirm();
      else if (input.wasPressed("b")) Choice.cancel();
      return;
    }

    if (Message.isOpen()) {
      const held = input.isDown("a") || input.isDown("b");
      if (Message.setSpeedUp) Message.setSpeedUp(held);
      const aPress = input.wasPressed("a") || input.wasPressed("b");
      if (aPress) {
        const onLast = Message.isWaiting()
          && Message._page >= len(Message._pages || []);
        if (Message._stay && onLast) {
          // Stay on last page: waitbuttonpress / yesnobox own the A press.
          if (Hud._waitButton) {
            const cb = Hud._waitButton;
            Hud._waitButton = undefined;
            cb();
          }
        } else {
          Message.advance();
        }
      }
      return;
    }

    if (Hud._waitButton) {
      if (input.wasPressed("a") || input.wasPressed("b")) {
        const cb = Hud._waitButton;
        Hud._waitButton = undefined;
        cb();
      }
      return;
    }

    if (inBattle) {
      return;
    }

    if (!Hud.busy()) {
      // START opens pause menu when field is idle (Escape / gamepad Start).
      // Owned here (not Field) so the open press cannot also close same frame.
      if (input.wasPressed("start")) {
        const F = M(Field);
        const sample = Hud._fieldInput;
        // pokefirered/src/field_control_avatar.c:108
        let allowed = (sample ? sample.start : undefined) || false;
        if (sample == null) allowed = start_button_allowed();
        if (allowed) {
          Hud.openStartMenu(game, (F && truthy(F._session) ? F._session : undefined)
            ?? (Runtime.getSession ? Runtime.getSession() : undefined));
        }
      }
      return;
    }

    if (SummaryMenu.isOpen() && SummaryMenu.update) {
      SummaryMenu.update((_dt as number | undefined) ?? (1 / 60));
    }
    if (PartyMenu.isOpen() && PartyMenu.update) {
      PartyMenu.update((_dt as number | undefined) ?? (1 / 60));
    }

    update_top_menu(input);
  },

  // Lua: hud.lua:344
  openStartMenu(game: HudGame | undefined, session: unknown): void {
    if (StartMenu.isOpen()) {
      log("Start Menu close (toggle)");
      StartMenu.close();
      return;
    }
    // Close other field menus first.
    if (BagMenu.isOpen()) BagMenu.close();
    if (SummaryMenu.isOpen()) SummaryMenu.close();
    if (PartyMenu.isOpen()) PartyMenu.close();
    if (Pokedex.isOpen()) Pokedex.close();
    if (RegionMap.isOpen()) RegionMap.close();
    if (OptionMenu.isOpen()) OptionMenu.close();
    if (SaveMenu.isOpen()) SaveMenu.close();
    if (TrainerCard.isOpen()) TrainerCard.close();
    if (PcMenu.isOpen()) PcMenu.close();
    // pret FlagSet(FLAG_OPENED_START_MENU) on first open (Pallet sign lady).
    {
      const Sp = M(Space);
      const store = Sp ? Sp.store : undefined;
      const ids = Screens.flags(session);
      const flag = ids.IDS.OPENED_START_MENU;
      const v = ids.VAR_IDS.MAP_SCENE_PALLET_TOWN_SIGN_LADY;
      if (truthy(store) && truthy(flag) && truthy(v)) {
        const scene = Flags.getVar(store, undefined, v);
        if (scene >= 1) {
          Flags.setFlag(store, undefined, flag, true);
          if (Sp.persistSession) {
            try { Sp.persistSession(); } catch (errP) { s9log("persistSession", errP); }
          }
        }
      }
    }
    log("Start Menu on game3 display (FRLG 240x160)");
    Screens.get("start_menu", session).show({ session, game });
  },

  // Lua: hud.lua:384
  openMessage(_game: unknown, text: unknown, opts?: LuaTable): void {
    log("dialog on game3 display");
    Message.show(text, opts);
  },

  // Lua: hud.lua:389
  openMessageStay(_game: unknown, text: unknown, opts?: LuaTable): void {
    opts = opts || {};
    opts.stay = true;
    log("stay-dialog on game3 display");
    Message.showStay(text, opts);
  },

  // Lua: hud.lua:396
  openPc(_game: unknown, session: unknown): void {
    try { Audio.playSe(SE.resolve("SE_PC_ON")); } catch { /* pcall */ } // data/scripts/pc.inc:9
    Screens.get("pc", session).show({ session: truthy(session) ? session : Runtime.getSession() });
  },

  // Lua: hud.lua:401
  ensure(_game?: unknown, _mode?: unknown): any {
    return Hud;
  },

  // Lua: hud.lua:405
  new(): any {
    return Hud;
  },
};

export default Hud;
