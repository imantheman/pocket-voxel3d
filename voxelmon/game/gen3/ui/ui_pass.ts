// Port of gen1recomp src/ui/game3/ui_pass.lua (GPLv3 + additional terms; see LICENSE.md).
// The Game3 UI pass: the stack's screens (or the legacy open menus), the
// field boxes, popups, the dialogue box, the choice box and the fade, drawn
// over the field / battle frame every frame (Display.drawUiPass).
//
// Display requires this module with `pcall(require, "src.ui.game3.ui_pass")`;
// it registers itself in G3Lazy (core/lazy_registry.ts).
//
// Brian's `lazyReq(name)` returns package.loaded[name] or requires it, so
// every module of the port is a static import here. Two port seams:
// - Modules that are lazily required elsewhere (coins_box, elevator_window,
//   berry_powder_box, museum_fossil_pic) are looked up in G3Lazy.
// - A `pcall(lazyReq, X)` of a module that is still a stub is a failed
//   require: the call into it throws NotPortedError, caught as `ok = false`.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { tostring } from "../../../import/gen3/lua.ts";
import { NotPortedError } from "../notported.ts";
import { G } from "../platform/graphics.ts";
import { ipairs, len } from "../platform/lt.ts";
import { G3Lazy } from "../core/lazy_registry.ts";
import Stack from "./stack.ts";
import Message from "./message.ts";
import Choice from "./choice.ts";
import StartMenu from "./start_menu.ts";
import BagMenu from "./bag_menu.ts";
import RegionMapM from "./region_map.ts";
import PartyMenu from "./party_menu.ts";
import Pokedex from "./pokedex.ts";
import OptionMenu from "./option_menu.ts";
import SaveMenu from "./save_menu.ts";
import TrainerCard from "./trainer_card.ts";
import PcMenu from "./pc_menu.ts";
import MoneyBox from "./money_box.ts";
import Screens from "./screens.ts";
import ShopMenuM from "./shop_menu.ts";
import MapPreviewScreenM from "./map_preview_screen.ts";
import MapNamePopupM from "./map_name_popup.ts";
import MonPicM from "./mon_pic.ts";
import NamingM from "./naming.ts";
import BattleTransitionM from "../core/battle_transition.ts";
import SeagallopM from "./seagallop.ts";
import WirelessIconM from "./wireless_icon.ts";
import FadeM from "./fade.ts";
import EasyChatM from "./easy_chat.ts";
import { Renderer as RendererM } from "../shared/render/Renderer.ts";

type Mod = any;

/** `pcall(f)` where only a stub's NotPortedError counts as the failed require. */
function pcallStub<T>(f: () => T): [boolean, T | undefined] {
  try {
    return [true, f()];
  } catch (e) {
    if (e instanceof NotPortedError) return [false, undefined];
    throw e;
  }
}

/**
 * `Mod.isOpen()` on a screen reached through a plain lazyReq.
 * NOT FAITHFUL: while the screen's module is still a stub, its isOpen()
 * reads false instead of raising (a stub screen's show() throws, so it can
 * never be open); the ported module answers for itself.
 */
function isOpen(m: Mod, fn = "isOpen"): boolean {
  const [ok, v] = pcallStub(() => (m && typeof m[fn] === "function" ? m[fn]() : false));
  return ok ? !!v : false;
}

/**
 * `lazyReq(name)` of a module required lazily elsewhere (G3Lazy).
 * NOT FAITHFUL: until it is ported the entry is absent, and the hard
 * require's error becomes "nothing to draw" here.
 */
function lazy(name: string): Mod | undefined {
  return G3Lazy[name];
}

export const UiPass: Record<string, any> = {};

// Lua: ui_pass.lua:11
function setRgb(r: number, g: number, b: number, a?: number): void {
  G.setColor(r, g, b, a ?? 1);
}

const gfxDrawWarned = new Set<unknown>();
// Lua: ui_pass.lua:16
function tryDraw(mod: Mod): void {
  if (mod && mod.draw) {
    try {
      mod.draw();
    } catch (err) {
      if (!gfxDrawWarned.has(mod)) {
        gfxDrawWarned.add(mod);
        console.log("[game3/gfx] mod draw failed: " + tostring(err instanceof Error ? err.message : err));
      }
    }
  }
}

// Lua: ui_pass.lua:27
UiPass.drawUi = function drawUi(): void {
  const RegionMap: Mod = RegionMapM;
  const CoinsBox = lazy("src.ui.game3.coins_box");
  const ElevatorWindow = lazy("src.ui.game3.elevator_window");

  const order = Stack.drawOrder();
  if (len(order) > 0) {
    for (const [, layer] of ipairs<any>(order)) {
      const skin = (Screens as Mod).skin(layer.id);
      if (skin && skin.draw) {
        tryDraw({ draw: () => skin.draw(layer.mod) });
      } else {
        tryDraw(layer.mod);
      }
    }
  } else {
    if (isOpen(StartMenu)) tryDraw(StartMenu);
    if (isOpen(BagMenu)) tryDraw(BagMenu);
    if (isOpen(RegionMap)) tryDraw(RegionMap);
    if (isOpen(PartyMenu)) tryDraw(PartyMenu);
    if (isOpen(Pokedex)) tryDraw(Pokedex);
    if (isOpen(OptionMenu)) tryDraw(OptionMenu);
    if (isOpen(SaveMenu)) tryDraw(SaveMenu);
    if (isOpen(TrainerCard)) tryDraw(TrainerCard);
    if (isOpen(PcMenu)) tryDraw(PcMenu);
  }

  const Money: Mod = MoneyBox;
  if (Money.isVisible && Money.isVisible()) {
    // package.loaded["src.ui.game3.shop_menu"]
    const ShopMenu: Mod = ShopMenuM;
    if (!(ShopMenu && ShopMenu.isOpen && isOpen(ShopMenu))) {
      tryDraw(Money);
    }
  }

  // pokefirered/src/coins.c:79
  if (CoinsBox && CoinsBox.isVisible && CoinsBox.isVisible()) {
    tryDraw(CoinsBox);
  }

  // pokefirered/src/berry_powder.c:113
  const BerryPowderBox = lazy("src.ui.game3.berry_powder_box");
  if (BerryPowderBox && BerryPowderBox.isVisible()) {
    tryDraw(BerryPowderBox);
  }

  // pokefirered/src/field_specials.c:1094
  if (ElevatorWindow && ElevatorWindow.isVisible && ElevatorWindow.isVisible()) {
    tryDraw(ElevatorWindow);
  }

  // pokefirered/src/map_name_popup.c
  const MapPreviewScreen: Mod = MapPreviewScreenM;
  const [okPrev, prevActive] = pcallStub(() => MapPreviewScreen && MapPreviewScreen.isActive && MapPreviewScreen.isActive());
  let previewActive = okPrev && !!prevActive;
  if (previewActive) {
    const top = Stack.top();
    const suppress = top && top.hideBelow;
    if (!suppress && !Message.isOpen()) {
      tryDraw(MapPreviewScreen);
    } else {
      previewActive = false;
    }
  }

  const MapNamePopup: Mod = MapNamePopupM;
  const [okPop, popActive] = pcallStub(() => MapNamePopup && MapNamePopup.isActive && MapNamePopup.isActive());
  if (okPop && popActive && !previewActive) {
    const top = Stack.top();
    const suppress = top && top.hideBelow;
    if (!suppress && !Message.isOpen()) {
      tryDraw(MapNamePopup);
    }
  }

  const MonPic: Mod = MonPicM;
  if (MonPic && MonPic.active) {
    tryDraw(MonPic);
  }

  const top = Stack.top();
  const suppressOverworldDialog = top && top.hideBelow;

  const MuseumPic = lazy("src.ui.game3.museum_fossil_pic");
  if (MuseumPic && MuseumPic.isActive() && !suppressOverworldDialog
      && !Stack.fullscreen() && !Stack.has("box_storage") && !Stack.has("pc_menu")) {
    tryDraw(MuseumPic);
  }

  if (Message.isOpen() && !suppressOverworldDialog && !Stack.has("box_storage") && !Stack.has("pc_menu")) {
    Message.draw();
  }

  const ChoiceM: Mod = Choice;
  if (ChoiceM.active && ChoiceM.options && !suppressOverworldDialog) {
    tryDraw(ChoiceM);
  }

  const Naming: Mod = NamingM;
  if (Naming.isOpen && Naming.isOpen()) {
    tryDraw(Naming);
  }

  const BattleTransition: Mod = BattleTransitionM;
  if (BattleTransition && BattleTransition.draw) {
    // pcall(lazyReq, ...) then a call: a stub stands for the failed require
    pcallStub(() => BattleTransition.draw());
  }

  const SeagallopUi: Mod = SeagallopM;
  const [okSea, seaActive] = pcallStub(() => SeagallopUi && SeagallopUi.isActive && SeagallopUi.isActive());
  if (okSea && seaActive) {
    tryDraw(SeagallopUi);
  }

  // pokefirered/src/overworld.c:1833
  const WirelessIcon: Mod = WirelessIconM;
  if (WirelessIcon.drawField) tryDraw({ draw: () => WirelessIcon.drawField() });

  const Fade: Mod = FadeM;
  const isNamingOpen = Naming.isOpen && Naming.isOpen();
  const isRegionMapOpen = RegionMap.isOpen && isOpen(RegionMap);
  const EasyChat: Mod = EasyChatM;
  const isEasyChatOpen = EasyChat.isOpen && isOpen(EasyChat);
  const isFullscreen = Stack.fullscreen() || Stack.has("bag") || isOpen(BagMenu);
  if (isFullscreen || isNamingOpen || isRegionMapOpen || isEasyChatOpen) {
    const Renderer: Mod = RendererM;
    if (Renderer) Renderer.screenVeil = null;
  } else if (Fade.draw) {
    Fade.draw();
  }

  setRgb(1, 1, 1, 1);
};

G3Lazy["src.ui.game3.ui_pass"] = UiPass;

export default UiPass;
