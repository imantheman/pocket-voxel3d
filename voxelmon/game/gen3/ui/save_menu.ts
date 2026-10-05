// Port of gen1recomp src/ui/game3/save_menu.lua (GPLv3 + additional terms; see LICENSE.md).
// FRLG Save confirm dialog (start_menu save path matching pret start_menu.c).
// Features:
// 1. Top-left Save Stats Window (1, 1, 14, 9): Location header, Player, Badges, Pokédex, Time.
// 2. Bottom Dialogue Window (2, 15, 26, 4): "Would you like to save...", "SAVING...", "[Player] saved the game."
// 3. Right YES/NO Window (21, 9, 6, 4).

import { format, tonumber, tostring } from "../../../import/gen3/lua.ts";
import { ipairs, seq, type LuaTable } from "../platform/lt.ts";
import { find, gsub } from "../platform/lpattern.ts";
import { Stack } from "./stack.ts";
import { Window } from "./window.ts";
import { Chrome } from "./chrome.ts";
import { FrlgFont } from "./frlg_font.ts";
import { MapSectionsExtract } from "../../../import/gen3/map_sections_extract.ts";
import { Strings } from "../shared/core/Strings.ts";
import { RomText } from "../core/rom_text.ts";
import { Flags } from "../core/scripting/flags.ts";
import { Dex } from "../core/dex.ts";
import { Audio } from "../core/audio.ts";
import { SE } from "../core/se_ids.ts";
import { PokedexData } from "../core/pokedex_data.ts";
import { Screens } from "./screens.ts";
import { Profile } from "../core/profile.ts";
import { SaveData } from "../shared/core/SaveData.ts";
import { Runtime } from "../core/runtime.ts";
import { Bridge } from "../core/bridge.ts";
import { Logger } from "../shared/core/Logger.ts";
import { Space } from "../core/scripting/space.ts";
import { StartMenu } from "./start_menu.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

// Lua: save_menu.lua:27
function se(id: unknown): void {
  try { Audio.playSe(SE.resolve(id)); } catch { /* pcall */ }
}

/** Lua s:upper() (C locale: ASCII letters only). */
function upper(s: string): string {
  return s.replace(/[a-z]+/g, (m) => m.toUpperCase());
}

/** NOT FAITHFUL: Emerald only -- the RSE save layout (rse/init, rse/scene_kit) is not ported. */
function emeraldOnly(what: string): never {
  throw new Error("NOT FAITHFUL: Emerald only (save_menu " + what + ")");
}

// pret prints every stat value at one x (56 px into the window, labels at 4).
// A translated label can be wider than the English one the column was placed
// for ("DUREE JEU", "SPIELZEIT"), so push the column past the widest label,
// keeping the English gap.
const VALUE_X = 56;
const VALUE_GAP = VALUE_X - 4 - 42; // 42 = width of "POKéDEX", the widest US label

// pokeemerald/src/start_menu.c:1332 SAVE_BLUE / SAVE_RED / SAVE_GREEN belong
// to drawRse, the Emerald layout (not ported; see emeraldOnly).

// Lua: save_menu.lua:78
function saveExists(session: any): boolean {
  let ok = true, raw: unknown;
  try { raw = SaveData.load(session && session.version)[0]; } catch { ok = false; }
  return ok && raw != null && typeof raw === "object";
}

// Lua: save_menu.lua:116
function do_save(): void {
  SaveMenu._phase = "saving";
  const game = Runtime._game;
  const mod = Runtime._mod;

  // A write that did not happen must not be reported as one.  Neither call
  // signals success by itself: persistSessionOnly returns nothing useful, and
  // saveGame returns false for a refused write and nil for a deliberate no-op
  // (no session / quest-log phase).  Treat a raise, an explicit false, or an
  // absent saveGame as failure.
  let failure: string | undefined;
  if (SaveMenu._rse) {
    // pokeemerald/src/start_menu.c:1091
    emeraldOnly("pyramid pause");
  }
  if (game && mod && Bridge && typeof Bridge.persistSessionOnly === "function") {
    try {
      Bridge.persistSessionOnly(mod, game);
    } catch (err) {
      failure = "sidecar persist failed: " + tostring(err);
    }
  }
  if (!failure) {
    if (game && typeof game.saveGame === "function") {
      let ok = true, written: unknown;
      try { written = game.saveGame(); } catch (err) { ok = false; written = err; }
      if (!ok) {
        failure = "saveGame raised: " + tostring(written);
      } else if (written == null || written === false) {
        failure = "saveGame did not confirm a write (" + tostring(written) + ")";
      }
    } else {
      failure = "no saveGame available";
    }
  }

  if (failure) {
    SaveMenu._phase = "save_failed";
    SaveMenu._error = failure;
    try { Logger.warn("[save] %s", failure); } catch { /* pcall */ }
    return;
  }

  se("SE_SAVE");
  SaveMenu._phase = "saved";
  // pokeemerald/src/start_menu.c:1086
  if (SaveMenu._rse) SaveMenu._timer = 60;
}

// pret resolves the header through save_menu_util.c SAVE_STAT_LOCATION ->
// GetMapNameGeneric(dest, gMapHeader.regionMapSectionId) -> region_map.c
// GetMapName(dst, mapsec, 0), i.e. the sMapNames place name and never the
// engine's internal map id (which is what session.map holds).
// pokeemerald/src/menu.c:2135
// Lua: save_menu.lua:239
function rseLocationName(_session: any): string {
  return emeraldOnly("rseLocationName");
}

export const SaveMenu: any = {
  isMenu: true,

  open: false,
  cursor: 1, // 1=YES 2=NO
  _phase: "confirm", // confirm | overwrite | saving | saved | save_failed
  _error: undefined as string | undefined, // reason the last write failed, for the log
  _session: undefined as any,
  _game: undefined as any,
  _onClose: undefined as (() => void) | undefined,
  _rse: false,
  _timer: undefined as number | undefined,

  // Lua: save_menu.lua:31
  flagStore(session: any): any {
    // package.loaded["src.core.game3.scripting.space"]
    const live = Space && Space.getStore ? Space.getStore() : undefined;
    if (live != null && typeof live === "object" && live.flags != null && typeof live.flags === "object") return live;
    if (session == null || typeof session !== "object") return { flags: {} };
    if (session.store != null && typeof session.store === "object"
      && session.store.flags != null && typeof session.store.flags === "object") {
      return session.store;
    }
    return { flags: session.flags != null && typeof session.flags === "object" ? session.flags : {} };
  },

  // pokefirered/src/save_menu_util.c:44
  // Lua: save_menu.lua:43
  countBadges(session: any): number {
    return Flags.countBadges(SaveMenu.flagStore(session));
  },

  // pokefirered/src/save_menu_util.c:25
  // Lua: save_menu.lua:48
  countDex(session: any): number {
    const dex = session != null && typeof session === "object" ? session.dex : undefined;
    if (SaveMenu.layout(session) === "rse") {
      // pokeemerald/src/menu.c:2122
      const st = SaveMenu.flagStore(session);
      return Dex.summaryCount({ version: session.version, dex, flags: st.flags, vars: st.vars });
    }
    if (dex == null || typeof dex !== "object") return tonumber(session && session.caughtMonsCount) ?? 0;
    let national = false;
    if (PokedexData && PokedexData.isNationalUnlocked) {
      let ok = true, on: unknown;
      try { on = PokedexData.isNationalUnlocked(session, dex); } catch { ok = false; }
      national = ok && on === true;
    }
    return Dex.countCaught(dex, national ? "national" : "kanto");
  },

  // pokefirered/src/start_menu.c:984
  // Lua: save_menu.lua:66
  hasDex(session: any): boolean {
    const id = Screens.flags(session).IDS.SYS_POKEDEX_GET;
    return id != null && Flags.getFlag(SaveMenu.flagStore(session), null, id) === true;
  },

  // Lua: save_menu.lua:71
  layout(session: any): string {
    let row: any;
    try { row = Profile.forSession(session); } catch { row = undefined; }
    const ui = row && row.ui != null && typeof row.ui === "object" ? row.ui : undefined;
    return (ui && ui.saveMenu) || "frlg";
  },

  // Lua: save_menu.lua:83
  show(opts?: any): void {
    opts = opts || {};
    SaveMenu.open = true;
    SaveMenu.cursor = 1;
    SaveMenu._phase = "confirm";
    SaveMenu._rse = SaveMenu.layout(opts.session) === "rse";
    SaveMenu._timer = undefined;
    SaveMenu._error = undefined;
    SaveMenu._session = opts.session;
    SaveMenu._game = opts.game;
    SaveMenu._onClose = opts.onClose;
    Stack.push("save", SaveMenu, { hideBelow: true });
    // pokefirered/src/start_menu.c:605
  },

  // Lua: save_menu.lua:98
  close(): void {
    SaveMenu.open = false;
    Stack.pop("save");
    const cb = SaveMenu._onClose;
    SaveMenu._onClose = undefined;
    if (cb) cb();
  },

  // Lua: save_menu.lua:106
  isOpen(): boolean {
    return SaveMenu.open;
  },

  // Lua: save_menu.lua:110
  move(_delta?: number): void {
    if (SaveMenu._phase !== "confirm" && SaveMenu._phase !== "overwrite") return;
    SaveMenu.cursor = SaveMenu.cursor === 1 ? 2 : 1;
    se("SE_SELECT");
  },

  // pokeemerald/src/start_menu.c:1123
  // Lua: save_menu.lua:164
  update(): void {
    if (!(SaveMenu.open && SaveMenu._rse)) return;
    if (SaveMenu._phase === "saving_msg") {
      SaveMenu._phase = "saving";
      do_save();
      return;
    }
    if (SaveMenu._phase === "saved" && SaveMenu._timer != null) {
      SaveMenu._timer = SaveMenu._timer - 1;
      if (SaveMenu._timer <= 0) {
        SaveMenu._timer = undefined;
        SaveMenu.confirm();
      }
    }
  },

  // Lua: save_menu.lua:180
  confirm(): void {
    if (SaveMenu._phase === "save_failed") {
      // The dialog stays up so the failure is readable; dismissing it returns
      // to the start menu so the player can retry.
      SaveMenu.close();
      return;
    }
    if (SaveMenu._phase === "saved") {
      SaveMenu.close();
      if (StartMenu.isOpen()) StartMenu.close(true); // pokefirered/src/start_menu.c:583
      return;
    }
    if (SaveMenu._phase === "saving" || SaveMenu._phase === "saving_msg") {
      return;
    }

    if (SaveMenu.cursor === 1 && SaveMenu._rse) {
      se("SE_SELECT");
      if (SaveMenu._phase === "confirm" && saveExists(SaveMenu._session)) {
        // pokeemerald/src/start_menu.c:1003
        SaveMenu._phase = "overwrite";
        SaveMenu.cursor = 1;
      } else {
        // pokeemerald/src/start_menu.c:1080
        SaveMenu._phase = "saving_msg";
      }
    } else if (SaveMenu.cursor === 1) { // YES
      if (SaveMenu._phase === "confirm") {
        // If there is an active save file, ask overwrite confirm
        SaveMenu._phase = "overwrite";
        SaveMenu.cursor = 1;
        se("SE_SELECT");
      } else if (SaveMenu._phase === "overwrite") {
        do_save();
      }
    } else { // NO
      se("SE_SELECT"); // pokefirered/src/menu.c:376
      SaveMenu.close();
    }
  },

  // Lua: save_menu.lua:222
  cancel(): void {
    if (SaveMenu._phase === "saved") {
      if (SaveMenu._rse) return;
      SaveMenu.confirm();
      return;
    }
    if (SaveMenu._phase === "saving" || SaveMenu._phase === "saving_msg") {
      return;
    }
    SaveMenu.close();
  },

  // Lua: save_menu.lua:246
  locationName(session: any): string {
    session = session || {};
    if (SaveMenu.layout(session) === "rse") return rseLocationName(session);
    if (typeof session.mapName === "string" && session.mapName !== ""
      && !find(session.mapName, "^FR_") && !find(session.mapName, "^SEVII_")) {
      return upper(session.mapName);
    }
    const mapId = session.map;
    // package.loaded["src.core.game3.runtime"]
    const game = SaveMenu._game || (Runtime && Runtime._game);
    const def = mapId && game && game.data && game.data.maps && game.data.maps[mapId];
    const secId = session.regionMapSectionId ?? session.mapSec ?? (def ? def.regionMapSectionId : undefined);
    // floorNum 0: save_menu_util.c passes fill = 0, like map_name_popup.c.
    const info = MapSectionsExtract.getInfo(secId, mapId, 0);
    if (info && info.resolved && typeof info.name === "string" && info.name !== "") {
      return upper(info.rawName || info.name);
    }
    if (info && typeof info.name === "string" && info.name !== "" && info.name !== "PALLET TOWN") {
      return upper(info.rawName || info.name);
    }
    // Not a map we can identify (a mod's map, or one with no header data): show
    // a readable form of the id rather than getInfo's Pallet Town placeholder.
    let s = tostring(mapId || "PALLET TOWN");
    s = gsub(s, "^FR_", "")[0];
    s = gsub(s, "^SEVII_", "")[0];
    s = gsub(s, "_", " ")[0];
    return upper(s);
  },

  // Lua: save_menu.lua:277
  valueX(labels: LuaTable): number {
    let x = VALUE_X;
    for (const [, label] of ipairs<string>(labels)) {
      x = Math.max(x, 4 + FrlgFont.measure(label) + VALUE_GAP);
    }
    return x;
  },

  // Lua: save_menu.lua:290
  drawRse(): void {
    emeraldOnly("drawRse");
  },

  // Lua: save_menu.lua:341
  draw(): void {
    if (!SaveMenu.open) return;
    if (SaveMenu._rse) return SaveMenu.drawRse();
    const session = SaveMenu._session || {};
    const name = tostring(session.name || session.playerName || "");
    const map = Strings(SaveMenu.locationName(session));
    const labels = seq(
      RomText.plain("gSaveStatName_Player"), RomText.plain("gSaveStatName_Badges"),
      RomText.plain("gSaveStatName_Pokedex"), RomText.plain("gSaveStatName_Time"),
    );
    const valueX = 1 * 8 + SaveMenu.valueX(labels);
    const badges = SaveMenu.countBadges(session);
    const hasDex = SaveMenu.hasDex(session);
    const pt = session.playtime || session.playTime || {};
    const hours = tonumber(pt.hours ?? session.playTimeHours ?? session.hours) ?? 0;
    const mins = tonumber(pt.minutes ?? session.playTimeMinutes ?? session.minutes) ?? 0;

    // 1. Top-Left Save Stats Box (pret sSaveStatsWindowTemplate at (1, 1, 14, 9))
    // pokefirered/src/start_menu.c:971
    Window.fixedStdFrame(Window.template(1, 1, 14, 9));
    // Location Header.  pret start_menu.c PrintSaveStats centres it in the
    // 14-tile window: x = (112 - GetStringWidth(FONT_NORMAL, text)) / 2.
    const headerW = 14 * 8;
    const mapW = FrlgFont.measure(map);
    const mapX = 1 * 8 + Math.max(0, Math.floor((headerW - mapW) / 2));
    FrlgFont.draw(map, mapX, 1 * 8 + 2, { maxWidth: headerW, colors: FrlgFont.COLOR.NORMAL });
    // PLAYER
    FrlgFont.draw(labels[1], 1 * 8 + 4, 1 * 8 + 18, { colors: FrlgFont.COLOR.NORMAL });
    FrlgFont.draw(name, valueX, 1 * 8 + 18, { colors: FrlgFont.COLOR.NORMAL });
    // BADGES
    FrlgFont.draw(labels[2], 1 * 8 + 4, 1 * 8 + 32, { colors: FrlgFont.COLOR.NORMAL });
    FrlgFont.draw(tostring(badges), valueX, 1 * 8 + 32, { colors: FrlgFont.COLOR.NORMAL });
    // POKéDEX
    let timeY = 1 * 8 + 46;
    if (hasDex) {
      FrlgFont.draw(labels[3], 1 * 8 + 4, 1 * 8 + 46, { colors: FrlgFont.COLOR.NORMAL });
      FrlgFont.draw(tostring(SaveMenu.countDex(session)), valueX, 1 * 8 + 46, { colors: FrlgFont.COLOR.NORMAL });
      timeY = 1 * 8 + 60;
    }
    // TIME
    FrlgFont.draw(labels[4], 1 * 8 + 4, timeY, { colors: FrlgFont.COLOR.NORMAL });
    FrlgFont.draw(format("%d:%02d", hours, mins), valueX, timeY, { colors: FrlgFont.COLOR.NORMAL });

    // 2. Bottom Dialogue Window (pret WindowFunc_DrawDialogueFrame at (2, 15, 26, 4))
    Chrome.dialogueFrame();
    // pokefirered/src/start_menu.c:715
    let msg = RomText.plain("gText_WouldYouLikeToSaveTheGame");
    if (SaveMenu._phase === "overwrite") {
      // pokefirered/src/start_menu.c:750
      msg = RomText.plain("gText_AlreadySaveFile_WouldLikeToOverwrite");
    } else if (SaveMenu._phase === "saving") {
      // pokefirered/src/start_menu.c:787
      msg = RomText.plain("gText_SavingDontTurnOffThePower");
    } else if (SaveMenu._phase === "saved") {
      // pokefirered/src/start_menu.c:810
      msg = RomText.plain("gText_PlayerSavedTheGame", { playerName: name });
    } else if (SaveMenu._phase === "save_failed") {
      // do_save refused to report success; say so instead of claiming a save.
      msg = Strings("The game could not be saved.");
    }
    FrlgFont.draw(msg, 2 * 8 + 4, 15 * 8 + 2, { linePitch: 15, colors: FrlgFont.COLOR.NORMAL });

    // 3. Right YES/NO Window (pret sSaveStatsWindow / YesNo popup at (21, 9, 6, 4))
    if (SaveMenu._phase === "confirm" || SaveMenu._phase === "overwrite") {
      const popX = 21;
      const popY = 9;
      const popW = 6;
      const popH = 4;
      Window.stdFrame(Window.template(popX, popY, popW, popH));
      const rowY1 = popY * 8 + 2;
      const rowY2 = popY * 8 + 18;
      const curY = (SaveMenu.cursor === 1) ? rowY1 : rowY2;
      Window.cursorPx(popX * 8 + 1, curY);
      FrlgFont.draw(RomText.plain("gText_Yes"), popX * 8 + 9, rowY1, { colors: FrlgFont.COLOR.NORMAL });
      FrlgFont.draw(RomText.plain("gText_No"), popX * 8 + 9, rowY2, { colors: FrlgFont.COLOR.NORMAL });
    }
  },
};

export default SaveMenu;
