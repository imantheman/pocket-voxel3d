// Port of gen1recomp src/ui/game3/option_rows.lua (GPLv3 + additional terms; see LICENSE.md).
// pokefirered/src/option_menu.c
//
// The desktop-only rows (video mode, letterbox, screen position, frame cap,
// vsync, performance, zoom, touch pad ...) drive modules that are inert on
// the 3DS: their functions return undefined. Brian's rows stay, but
// NOT FAITHFUL: a step whose inert module returns nothing keeps the stored
// option instead of writing nil over it (the options file round-trips with
// gen1recomp, so a desktop setting must survive a 3DS visit), and an inert
// label reads "----" instead of "nil". The CONTROLS row opens Brian's
// desktop key-binding screen, which is not in the port: activating it does
// nothing. os.getenv("POKEPORT_TOUCH") is never set on the 3DS.

import { format, mod as luaMod, tonumber, tostring } from "../../../import/gen3/lua.ts";
import { insert, ipairs, len, seq, type LuaTable } from "../platform/lt.ts";
import { Options } from "../core/options.ts";
import { Strings } from "../shared/core/Strings.ts";
import { RomText } from "../core/rom_text.ts";
import { GameSpeed } from "../shared/core/GameSpeed.ts";
import { Audio } from "../core/audio.ts";
import { Screens } from "./screens.ts";
import { Chrome } from "./chrome.ts";
import { Letterbox } from "../shared/render/Letterbox.ts";
import { VideoMode } from "../shared/core/VideoMode.ts";
import { Orientation } from "../shared/core/Orientation.ts";
import { FaithfulRes } from "../shared/core/FaithfulRes.ts";
import { ScreenPosition } from "../shared/core/ScreenPosition.ts";
import { FrameCap } from "../shared/core/FrameCap.ts";
import { VSync } from "../shared/core/VSync.ts";
import { LogicClock } from "../shared/core/LogicClock.ts";
import { Performance } from "../shared/core/Performance.ts";
import { Tilt } from "../shared/render/Tilt.ts";
import { Zoom } from "../shared/render/Zoom.ts";
import { Renderer } from "../shared/render/Renderer.ts";
import { VoidFill } from "../core/void_fill.ts";
import { Profile } from "../core/profile.ts";
import { TouchControls } from "../shared/core/TouchControls.ts";
import { ModManager } from "./mod_manager.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface OptionCtx { session?: any; game?: any; options: any }
export interface OptionRow {
  id?: string;
  label?: string;
  group?: boolean;
  value?: (c: OptionCtx) => unknown;
  step?: (c: OptionCtx, dir: number) => boolean;
  activate?: (c: OptionCtx) => void;
}

/** An inert desktop module's label: "----" where it answers nothing (see the header). */
function inertLabel(v: unknown): string {
  return v == null ? "----" : Strings(v as string);
}
/** An inert desktop module's next value: keep the stored one where it answers nothing. */
function inertNext(v: unknown, cur: unknown): unknown {
  return v == null ? cur : v;
}

// Lua: option_rows.lua:9
function cart(ctx: OptionCtx): any {
  return Options.block(ctx.options);
}

// Lua: option_rows.lua:13
function cartCycle(ctx: OptionCtx, key: string, n: number, dir?: number): boolean {
  const o = cart(ctx);
  const cur = tonumber(o[key]) ?? 0;
  dir = (dir != null && dir < 0) ? -1 : 1;
  Options.set({ options: o }, key, luaMod(luaMod(cur + dir, n) + n, n));
  return true;
}

// src/option_menu.c:478
// Lua: option_rows.lua:22
function cartLabel(ctx: OptionCtx, key: string, tbl: string): string {
  const cur = tonumber(cart(ctx)[key]) ?? 0;
  if (cur < 0 || cur >= RomText.count(tbl)[0]) return "?";
  return RomText.at(tbl, cur);
}

// src/option_menu.c:136
// Lua: option_rows.lua:29
function cartName(item: number): string {
  return RomText.at("sOptionMenuItemsNames", item);
}

// Lua: option_rows.lua:33
function volLabel(vIn: unknown): string {
  const v = tonumber(vIn) ?? 7;
  return v === 0 ? Strings("OFF") : tostring(v);
}

// Lua: option_rows.lua:38
function stepVolume(v: unknown, dir: number): number {
  return Math.max(0, Math.min(7, (tonumber(v) ?? 7) + dir));
}

const FILTERS = seq("OFF", "1X", "2X", "3X");

// Lua: option_rows.lua:44
function gameSpeedLabel(v: unknown): string {
  const speed = GameSpeed.clamp(v);
  if (speed === 1) return Strings("NORMAL");
  return Strings("%dX", speed);
}

// Lua: option_rows.lua:51
function speedRow(id: string, label: string, key: string): OptionRow {
  return {
    id, label: Strings(label),
    value: (ctx) => gameSpeedLabel(ctx.options[key]),
    step: (ctx, dir) => {
      ctx.options[key] = GameSpeed.cycle(ctx.options[key], dir);
      return true;
    },
  };
}

export const Rows = {
  // Lua: option_rows.lua:63
  build(ctx: OptionCtx): LuaTable {
    const rows: (OptionRow | null)[] = seq();
    const add = (row: OptionRow): void => { rows[len(rows) + 1] = row; };

    add({
      id: "textSpeed", label: cartName(0),
      value: (c) => cartLabel(c, "textSpeed", "sTextSpeedOptions"),
      step: (c, dir) => cartCycle(c, "textSpeed", 3, dir),
    });
    add(speedRow("speedOverworld", "OVERWORLD SPEED", "speedOverworld"));
    add(speedRow("speedBattle", "BATTLE SPEED", "speedBattle"));
    add(speedRow("speedMenu", "MENU SPEED", "speedMenu"));

    add({
      id: "battleScene", label: cartName(1),
      value: (c) => cartLabel(c, "battleScene", "sBattleSceneOptions"),
      step: (c, dir) => cartCycle(c, "battleScene", 2, dir),
    });
    add({
      id: "battleStyle", label: cartName(2),
      value: (c) => cartLabel(c, "battleStyle", "sBattleStyleOptions"),
      step: (c, dir) => cartCycle(c, "battleStyle", 2, dir),
    });

    add({
      id: "sound", label: cartName(3),
      value: (c) => cartLabel(c, "sound", "sSoundOptions"),
      step: (c, dir) => {
        cartCycle(c, "sound", 2, dir);
        Audio.applyOptions({ options: cart(c) });
        return true;
      },
    });
    add({
      id: "musicVol", label: Strings("MUSIC VOL"),
      value: (c) => volLabel(c.options.musicVol),
      step: (c, dir) => {
        c.options.musicVol = stepVolume(c.options.musicVol, dir);
        Audio.applyEngineOptions(c.options);
        return true;
      },
    });
    add({
      id: "sfxVol", label: Strings("SFX VOL"),
      value: (c) => volLabel(c.options.sfxVol),
      step: (c, dir) => {
        c.options.sfxVol = stepVolume(c.options.sfxVol, dir);
        Audio.applyEngineOptions(c.options);
        return true;
      },
    });
    add({
      id: "musicFilter", label: Strings("MUSIC FILTER"),
      value: (c) => Strings(FILTERS[(tonumber(c.options.musicFilter) ?? 0) + 1] ?? "OFF"),
      step: (c, dir) => {
        const v = (tonumber(c.options.musicFilter) ?? 0) + (dir < 0 ? -1 : 1);
        c.options.musicFilter = luaMod(luaMod(v, 4) + 4, 4);
        Audio.applyEngineOptions(c.options);
        return true;
      },
    });

    add({
      id: "buttonMode", label: cartName(4),
      value: (c) => cartLabel(c, "buttonMode", "sButtonTypeOptions"),
      step: (c, dir) => cartCycle(c, "buttonMode", 3, dir),
    });
    add({
      id: "controls", label: Strings("CONTROLS"),
      activate: (c) => {
        // NOT FAITHFUL: src.ui.game3.controls_menu (desktop key bindings) is
        // not in the port; Screens.get raises for it, so the row does nothing.
        let screen: any;
        try { screen = Screens.get("controls", c.session); } catch { return; }
        if (screen && screen.show) screen.show({ game: c.game, session: c.session, options: c.options });
      },
    });
    add({
      id: "frameType", label: cartName(5),
      value: (c) => {
        return RomText.plain("gText_FrameType") + format("%2d", (tonumber(cart(c).frameType) ?? 0) + 1); // src/option_menu.c:496
      },
      step: (c, dir) => {
        // pokeemerald/src/option_menu.c:518
        cartCycle(c, "frameType", (Chrome && Chrome.userFrameCount) ? Chrome.userFrameCount() : 10, dir);
        if (Chrome && Chrome.setFrameType) {
          Chrome.setFrameType(cart(c).frameType);
        }
        return true;
      },
    });

    add({
      id: "uiLayout", label: Strings("UI LAYOUT"),
      value: (c) => Strings(c.options.uiLayout === "dynamic" ? "DYNAMIC" : "CENTERED"),
      step: (c) => {
        c.options.uiLayout = (c.options.uiLayout === "dynamic") ? "centered" : "dynamic";
        return true;
      },
    });
    add({
      id: "uiLetterbox", label: Strings("UI LETTERBOX"),
      value: (c) => inertLabel(Letterbox.label(c.options.uiLetterbox)),
      step: (c, dir) => {
        c.options.uiLetterbox = inertNext(Letterbox.cycle(c.options.uiLetterbox, dir), c.options.uiLetterbox);
        Letterbox.setMode(c.options.uiLetterbox);
        return true;
      },
    });
    add({
      id: "videoMode", label: Strings("VIDEO MODE"),
      value: (c) => inertLabel(VideoMode.modeLabel(c.options.videoMode)),
      step: (c, dir) => {
        c.options.videoMode = inertNext(VideoMode.cycle(c.options.videoMode, dir), c.options.videoMode);
        VideoMode.apply(c.options.videoMode);
        return true;
      },
    });
    add({
      id: "orientation", label: Strings("ORIENTATION"),
      value: (c) => inertLabel(Orientation.modeLabel(c.options.orientation)),
      step: (c, dir) => {
        c.options.orientation = inertNext(Orientation.cycle(c.options.orientation, dir), c.options.orientation);
        Orientation.apply(c.options.orientation);
        return true;
      },
    });
    add({
      id: "faithfulRes", label: Strings("FAITHFUL RATIO"),
      value: (c) => inertLabel(FaithfulRes.label(c.options.faithfulRes)),
      step: (c, dir) => {
        c.options.faithfulRes = inertNext(FaithfulRes.cycle(c.options.faithfulRes, dir), c.options.faithfulRes);
        FaithfulRes.apply(c.options.faithfulRes);
        return true;
      },
    });
    add({
      id: "screenPos", label: Strings("SCREEN POS"),
      value: (c) => inertLabel(ScreenPosition.label(c.options.screenPos)),
      step: (c, dir) => {
        const nextMode = inertNext(ScreenPosition.cycle(c.options.screenPos, dir), c.options.screenPos);
        if (nextMode === c.options.screenPos) return false;
        c.options.screenPos = nextMode;
        ScreenPosition.setMode(nextMode);
        return true;
      },
    });
    add({
      id: "fpsCap", label: Strings("MAX FPS"),
      value: (c) => inertLabel(FrameCap.label(c.options.fpsCap)),
      step: (c, dir) => {
        c.options.fpsCap = inertNext(FrameCap.cycle(c.options.fpsCap, dir), c.options.fpsCap);
        FrameCap.apply(c.options.fpsCap);
        return true;
      },
    });
    add({
      id: "vsync", label: Strings("VSYNC"),
      value: (c) => inertLabel(VSync.label(c.options.vsync)),
      step: (c, dir) => {
        c.options.vsync = inertNext(VSync.cycle(c.options.vsync, dir), c.options.vsync);
        VSync.apply(c.options.vsync);
        return true;
      },
    });
    add({
      id: "logicClock", label: Strings("LOGIC CLOCK"),
      value: (c) => Strings(LogicClock.label(c.options.logicClock)),
      step: (c, dir) => {
        c.options.logicClock = LogicClock.cycle(c.options.logicClock, dir);
        LogicClock.apply(c.options.logicClock);
        return true;
      },
    });
    add({
      id: "performance", label: Strings("PERFORMANCE"),
      value: (c) => inertLabel(Performance.label(c.options.performance)),
      step: (c, dir) => {
        c.options.performance = inertNext(Performance.cycle(c.options.performance, dir), c.options.performance);
        if (c.game && c.game.applyOptions) c.game.applyOptions(c.options);
        return true;
      },
    });

    add({
      id: "tilt", label: Strings("TILT"),
      value: (c) => Strings(Tilt.levelLabel(tonumber(c.options.tilt) ?? 0)),
      step: (c, dir) => {
        const n = len(Tilt.ANGLE_LABELS);
        const v = luaMod((tonumber(c.options.tilt) ?? 0) + (dir < 0 ? -1 : 1), n);
        c.options.tilt = luaMod(v + n, n);
        Tilt.setLevel(c.options.tilt);
        return true;
      },
    });
    add({
      id: "zoom", label: Strings("ZOOM"),
      value: (c) => inertLabel(Zoom.offsetLabel(tonumber(c.options.zoom) ?? 0)),
      step: (c, dir) => {
        Zoom.nudgeOptions(c.options, dir, new Renderer().fitScale()); // Renderer:fitScale() (inert)
        return true;
      },
    });
    add({
      id: "voidFill", label: Strings("VOID FILL"),
      value: (c) => Strings(VoidFill.label(cart(c).voidFill)),
      step: (c, dir) => {
        const o = cart(c);
        o.voidFill = VoidFill.cycle(o.voidFill, dir);
        VoidFill.setMode(o.voidFill);
        return true;
      },
    });
    if (Profile.family(ctx && ctx.session) === "rse") {
      // NOT FAITHFUL: Emerald only -- rse/event_islands is not ported.
      throw new Error("NOT FAITHFUL: Emerald only (option_rows eventTickets)");
    }

    add({
      id: "touchControls", label: Strings("TOUCH PAD"),
      value: (c) => {
        const t = c.options.touchControls;
        const on = !(t != null && typeof t === "object" && t.enabled === false);
        return Strings(on ? "ON" : "OFF");
      },
      step: (c) => {
        let t = c.options.touchControls;
        if (t == null || typeof t !== "object") t = { enabled: true };
        t.enabled = !(t.enabled !== false);
        c.options.touchControls = t;
        new TouchControls().applyOptions(c.options); // TouchControls:applyOptions (inert)
        return true;
      },
    });
    add({
      id: "haptics", label: Strings("VIBRATION"),
      value: (c) => inertLabel(TouchControls.hapticLabel(c.options.haptics)),
      step: (c, dir) => {
        c.options.haptics = inertNext(TouchControls.cycleHaptics(c.options.haptics, dir), c.options.haptics);
        new TouchControls().applyOptions(c.options);
        TouchControls.buzz(c.options.haptics);
        return true;
      },
    });
    // Manager discoverable home (18-mod-manager-ux), same contract as Gen 1
    // OptionsMenu: always listed with an installed count, activate opens the
    // manager. Inert until A; costs a vanilla install a single row.
    add({
      id: "mods", label: Strings("MODS"),
      value: (c) => {
        const status = (c.game && c.game.modStatus) || {};
        return Strings("%d INSTALLED", len(status.available || {}));
      },
      activate: (c) => {
        // NOT FAITHFUL: the mod manager UI is deferred; its stub throws, so
        // the row does nothing on A.
        try { ModManager.show({ game: c.game, session: c.session }); } catch { /* deferred */ }
      },
    });
    add({
      id: "hotbar", label: Strings("KEY BAR"),
      value: (c) => Strings(c.options.hotbar === false ? "OFF" : "ON"),
      step: (c) => {
        c.options.hotbar = (c.options.hotbar === false);
        new TouchControls().applyOptions(c.options);
        return true;
      },
    });

    const touchEnv: string | undefined = undefined; // os.getenv("POKEPORT_TOUCH"): never set on the 3DS
    const mobile = Orientation.isAndroid() || Orientation.isIOS();
    const showTouch = touchEnv === "1" || (mobile && touchEnv !== "0");
    const keep: (OptionRow | null)[] = seq();
    for (const [, row] of ipairs<OptionRow>(rows)) {
      let drop = false;
      if (row.id === "orientation" && !mobile) drop = true;
      if (row.id === "videoMode" && VideoMode.fixedDisplay && VideoMode.fixedDisplay()) {
        drop = true;
      }
      if ((row.id === "touchControls" || row.id === "haptics" || row.id === "hotbar")
          && !showTouch) {
        drop = true;
      }
      if (!drop) keep[len(keep) + 1] = row;
    }
    return keep;
  },

  GROUPS: seq(
    { id: "group.speed", label: "SPEED",
      members: seq("textSpeed", "speedOverworld", "speedBattle", "speedMenu") },
    { id: "group.video", label: "VIDEO",
      members: seq("uiLayout", "videoMode", "orientation", "faithfulRes",
        "screenPos", "fpsCap", "vsync", "logicClock") },
    { id: "group.graphics", label: "GRAPHICS",
      members: seq("uiLetterbox", "frameType") },
    { id: "group.audio", label: "AUDIO",
      members: seq("sound", "musicVol", "sfxVol", "musicFilter") },
    { id: "group.battle", label: "BATTLE OPTIONS",
      members: seq("battleScene", "battleStyle") },
    { id: "group.extras", label: "EXTRAS",
      members: seq("tilt", "zoom", "voidFill", "eventTickets") },
  ),

  ORDER: seq(
    "group.speed", "group.video", "group.graphics", "group.audio",
    "performance", "group.battle", "group.extras", "buttonMode", "controls", "mods",
  ),

  // Lua: option_rows.lua:430
  group(rows: LuaTable, openPage: (title: string, members: LuaTable) => void): LuaTable {
    const owner: Record<string, any> = {}, picked: Record<string, LuaTable> = {};
    for (const [, g] of ipairs<any>(Rows.GROUPS)) {
      for (const [, id] of ipairs<string>(g.members)) owner[id] = g;
      picked[g.id] = seq();
    }
    for (const [, row] of ipairs<OptionRow>(rows)) {
      const g = row.id ? owner[row.id] : undefined;
      if (g) insert(picked[g.id], row);
    }
    const made: Record<string, OptionRow> = {};
    for (const [, g] of ipairs<any>(Rows.GROUPS)) {
      const members = picked[g.id];
      if (len(members) > 0) {
        made[g.id] = {
          id: g.id, label: Strings(g.label), group: true,
          value: () => Strings("%d OPTIONS", len(members)),
          activate: (_ctx) => { openPage(Strings(g.label), members); },
        };
      }
    }
    const byId: Record<string, OptionRow> = {}, view: (OptionRow | null)[] = seq(), taken: Record<string, boolean> = {};
    for (const [, row] of ipairs<OptionRow>(rows)) {
      if (row.id && !owner[row.id]) byId[row.id] = row;
    }
    for (const [, id] of ipairs<string>(Rows.ORDER)) {
      const row = made[id] || byId[id];
      if (row) {
        view[len(view) + 1] = row;
        taken[id] = true;
      }
    }
    for (const [, row] of ipairs<OptionRow>(rows)) {
      const id = row.id;
      if (!(id && (owner[id] || taken[id]))) view[len(view) + 1] = row;
    }
    return view;
  },
};

export default Rows;
