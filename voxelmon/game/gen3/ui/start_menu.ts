// Port of gen1recomp src/ui/game3/start_menu.lua (GPLv3 + additional terms; see LICENSE.md).
// FRLG-style start menu on Sevii (pret start_menu.c SetUpStartMenu_NormalField).
// Window at tilemapLeft=22 (right column), double-spaced entries.

import { mod as luaMod, tonumber, tostring } from "../../../import/gen3/lua.ts";
import { insert, len, pairs, type LuaTable } from "../platform/lt.ts";
import { NotPortedError } from "../notported.ts";
import { Stack } from "./stack.ts";
import { Window } from "./window.ts";
import { Chrome } from "./chrome.ts";
import { FrlgFont } from "./frlg_font.ts";
import { Strings } from "../shared/core/Strings.ts";
import { RomText } from "../core/rom_text.ts";
import { Runtime as ModRuntime } from "../shared/mods/Runtime.ts";
import { Data as FrlgData } from "./start_menu_frlg.ts";
import { Audio } from "../core/audio.ts";
import { SE } from "../core/se_ids.ts";
import { Union } from "../core/link/union_room.ts";
import { Safari } from "../core/safari.ts";
import { Profile } from "../core/profile.ts";
import { Screens } from "./screens.ts";
import { Map as G3Map } from "../core/map.ts";
import { Flags } from "../core/scripting/flags.ts";
import { Space } from "../core/scripting/space.ts";
import { Runtime } from "../core/runtime.ts";
import { G3Lazy } from "../core/lazy_registry.ts";
import { TrainerCard } from "./trainer_card.ts";
import { ModManager } from "./mod_manager.ts";
import { ListMenu } from "./list_menu.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */

// Lua: start_menu.lua:15
function se(id: unknown): void {
  try { Audio.playSe(SE.resolve(id)); } catch { /* pcall */ }
}

// Lua: start_menu.lua:27
function player_label(session: any): string {
  let name = (session && (session.name || session.playerName)) || "PLAYER";
  // PLAYER_NAME_LENGTH counts characters, and a kana is three bytes
  name = FrlgFont.truncate(name, 7);
  return upper(name);
}

/** Lua string.upper (C locale: ASCII letters only; kana bytes untouched). */
function upper(s: string): string {
  return s.replace(/[a-z]+/g, (m) => m.toUpperCase());
}

// pokefirered/src/overworld.c:1386 IsUpdateLinkStateCBActive
// Lua: start_menu.lua:35
function link_state_active(): boolean {
  // package.loaded["src.core.game3.link"]: a lazily-required module (G3Lazy)
  const Link = G3Lazy["src.core.game3.link"];
  if (!(Link != null && typeof Link === "object" && Link.link && Link.inLinkRoom)) return false;
  let ok = true, inRoom: unknown;
  try { inRoom = Link.inLinkRoom(); } catch { ok = false; }
  return ok && inRoom === true;
}

// pokefirered/src/union_room.c:4558 InUnionRoom
// Lua: start_menu.lua:43
function in_union_room(session: any): boolean {
  // package.loaded["src.core.game3.map"]
  const cur = (G3Map && typeof G3Map.current === "string" && G3Map.current) || (session && session.map);
  try {
    return Union.isUnionMap(cur);
  } catch (e) {
    // NOT FAITHFUL: link deferred -- union_room is still a stub; the offline
    // path (not in the Union Room) until it is ported.
    if (e instanceof NotPortedError) return false;
    throw e;
  }
}

// Lua: start_menu.lua:49
function safari_active(session: any): boolean {
  return Safari.isActive(session) === true;
}

// Lua: start_menu.lua:53
function data(session: any): any {
  let row: any;
  try { row = Profile.forSession(session); } catch { row = undefined; }
  const mod = row && row.ui != null && typeof row.ui === "object" ? row.ui.startMenu : undefined;
  if (!mod) return FrlgData;
  if (mod === "src.ui.game3.start_menu_frlg") return FrlgData;
  // NOT FAITHFUL: Emerald only -- the RSE start-menu data modules are not ported.
  throw new Error("NOT FAITHFUL: Emerald only (" + tostring(mod) + ")");
}

// Lua: start_menu.lua:61
function context(session: any): any {
  const ctx: any = { session };
  ctx.playerLabel = (): string => player_label(session);
  ctx.linkActive = (): boolean => link_state_active();
  ctx.inUnionRoom = (): boolean => in_union_room(session);
  ctx.safariActive = (): boolean => safari_active(session);
  ctx.mapId = (): unknown => {
    return (G3Map && typeof G3Map.current === "string" && G3Map.current) || (session && session.map);
  };
  ctx.version = (): unknown => session && session.version;
  ctx.flag = (name: string, fallback?: number): boolean => {
    const store = Space && Space.store;
    if (!(store && Flags && Flags.getFlag)) return true;
    const ids = Screens.flags(session).IDS;
    const id = (ids && ids[name]) ?? fallback;
    if (id == null) return false;
    return Flags.getFlag(store, null, id) === true;
  };
  ctx.var = (name: string): number => {
    const store = Space && Space.store;
    if (!(store && Flags && Flags.getVar)) return 0;
    const id = Screens.flags(session).VAR_IDS[name];
    return id != null ? (Flags.getVar(store, null, id) ?? 0) : 0;
  };
  ctx.safariBalls = (): number => Safari.balls(session);
  ctx.pyramidFloor = (): number => {
    const f = session && session.frontier;
    return tonumber(f && f.curChallengeBattleNum) ?? 0;
  };
  return ctx;
}

// pret MENU_POKEDEX..MENU_EXIT order for normal field.
// `game` is only read for modStatus (the gated MODS row); session alone is
// enough for the retail entry lists.
// Lua: start_menu.lua:99
function build_entries(session: any, game: any): [LuaTable, string, any] {
  const ctx = context(session);
  const [entries, kind] = data(session).build(ctx);
  // Same discoverable home as Gen 1/2 start menus (18-mod-manager-ux):
  // only once at least one mod is discovered, so vanilla is unchanged.
  const status = game && game.modStatus;
  if (kind === "normal" && status && len(status.available || {}) > 0) {
    insert(entries, len(entries), { id: "mods", label: "MODS" });
  }
  return [entries, kind, ctx];
}

const unported: Record<string, boolean> = {};

export const StartMenu: any = {
  isMenu: true,

  open: false,
  cursor: 1,
  ENTRIES: [null] as LuaTable,
  _confirmExit: false,
  _confirmCursor: 2, // 1=YES, 2=NO (default NO)
  MAX_VISIBLE: 8,
  _scrollOffset: 0,

  _session: undefined as any,
  _game: undefined as any,
  _onClose: undefined as (() => void) | undefined,
  _tutorial: false,
  _onTutorialSelect: undefined as ((sel: number) => void) | undefined,
  _kind: undefined as string | undefined,
  _data: undefined as any,
  _ctx: undefined as any,
  _safariStats: false,
  _frames: 0,

  // Lua: start_menu.lua:111
  resetCursor(): void {
    StartMenu.cursor = 1;
    StartMenu._scrollOffset = 0;
  },

  // Lua: start_menu.lua:116
  clampScroll(delta?: number, prevCursor?: number): void {
    const maxVisible = (StartMenu._data && StartMenu._data.maxVisible) || StartMenu.MAX_VISIBLE || 8;
    const n = len(StartMenu.ENTRIES || {});
    const visible = Math.min(n, maxVisible);
    StartMenu._scrollOffset = StartMenu._scrollOffset || 0;
    if (visible >= n) {
      StartMenu._scrollOffset = 0;
      return;
    }

    if (delta != null && prevCursor != null) {
      if (prevCursor === 1 && StartMenu.cursor === n) {
        StartMenu._scrollOffset = n - visible;
      } else if (prevCursor === n && StartMenu.cursor === 1) {
        StartMenu._scrollOffset = 0;
      } else if (StartMenu.cursor > StartMenu._scrollOffset + visible) {
        StartMenu._scrollOffset = StartMenu.cursor - visible;
      } else if (StartMenu.cursor <= StartMenu._scrollOffset) {
        StartMenu._scrollOffset = StartMenu.cursor - 1;
      }
    } else {
      if (StartMenu.cursor > StartMenu._scrollOffset + visible) {
        StartMenu._scrollOffset = StartMenu.cursor - visible;
      } else if (StartMenu.cursor <= StartMenu._scrollOffset) {
        StartMenu._scrollOffset = Math.max(0, StartMenu.cursor - 1);
      }
    }

    if (StartMenu._scrollOffset < 0) {
      StartMenu._scrollOffset = 0;
    } else if (StartMenu._scrollOffset > n - visible) {
      StartMenu._scrollOffset = n - visible;
    }
  },

  // Lua: start_menu.lua:153
  saveOffered(session: any, game: any): boolean {
    const entries = build_entries(session, game)[0];
    for (let i = 1; entries[i] != null; i++) {
      if (entries[i].id === "save") return true;
    }
    return false;
  },

  // Lua: start_menu.lua:160
  show(opts?: any): void {
    opts = opts || {};
    StartMenu.open = true;
    StartMenu._confirmExit = false;
    StartMenu._confirmCursor = 2;
    StartMenu._session = opts.session;
    StartMenu._game = opts.game;
    StartMenu._onClose = opts.onClose;
    StartMenu._tutorial = opts.tutorial ? true : false;
    StartMenu._onTutorialSelect = opts.onTutorialSelect;
    const d = data(opts.session);
    let entries: LuaTable, kind: string, ctx: any;
    if (StartMenu._tutorial && d.tutorialEntries) {
      ctx = context(opts.session);
      [entries, kind] = d.tutorialEntries(ctx);
    } else {
      [entries, kind, ctx] = build_entries(opts.session, opts.game);
    }
    StartMenu.ENTRIES = entries;
    StartMenu._kind = kind;
    StartMenu._data = d;
    StartMenu._ctx = ctx;
    StartMenu._safariStats = kind === "safari";
    if (ModRuntime.wantsHook("ui.start_menu.items")) {
      const hooked = ModRuntime.call("ui.start_menu.items", (_: unknown, items: unknown) => items,
        opts.game, StartMenu.ENTRIES);
      if (hooked != null && typeof hooked === "object") StartMenu.ENTRIES = hooked;
    }
    let pos = tonumber(opts.cursor ?? StartMenu.cursor) ?? 1;
    if (pos < 1 || pos > len(StartMenu.ENTRIES)) pos = 1; // pokefirered/src/menu.c:276
    StartMenu.cursor = pos; // pokefirered/src/start_menu.c:329
    StartMenu.clampScroll();
    Stack.push("start", StartMenu, { hideBelow: true });
    se("SE_WIN_OPEN");
  },

  // Lua: start_menu.lua:192
  close(silent?: boolean): void {
    StartMenu.open = false;
    StartMenu._confirmExit = false;
    StartMenu._tutorial = false;
    StartMenu._onTutorialSelect = undefined;
    Stack.pop("start");
    const cb = StartMenu._onClose;
    StartMenu._onClose = undefined;
    if (!silent) se("SE_SELECT"); // pokefirered/src/start_menu.c:1005
    if (cb) cb();
  },

  // Lua: start_menu.lua:204
  cancel(): void {
    if (StartMenu._confirmExit) {
      StartMenu._confirmExit = false;
      // pokefirered/src/menu.c:381
      return;
    }
    if (StartMenu._tutorial) {
      const cb = StartMenu._onTutorialSelect;
      StartMenu.close(true);
      if (cb) cb(127); // MULTI_B_PRESSED
      return;
    }
    StartMenu.close();
  },

  // Lua: start_menu.lua:219
  move(delta: number): void {
    if (StartMenu._confirmExit) {
      StartMenu._confirmCursor = (StartMenu._confirmCursor === 1) ? 2 : 1;
      se("SE_SELECT");
      return;
    }
    const n = len(StartMenu.ENTRIES);
    if (n < 1) return;
    const prevCursor = StartMenu.cursor;
    StartMenu.cursor = luaMod(StartMenu.cursor - 1 + delta, n) + 1;
    StartMenu.clampScroll(delta, prevCursor);
    se("SE_SELECT");
  },

  // Lua: start_menu.lua:233
  confirm(): void {
    se("SE_SELECT");
    if (StartMenu._tutorial) {
      const sel = StartMenu.cursor - 1;
      const cb = StartMenu._onTutorialSelect;
      StartMenu.close(true);
      if (cb) cb(sel);
      return;
    }
    if (StartMenu._confirmExit) {
      if (StartMenu._confirmCursor === 1) { // YES
        StartMenu.open = false;
        StartMenu._confirmExit = false;
        Stack.pop("start");
        // package.loaded["src.core.game3.runtime"]
        const game = (StartMenu._session && StartMenu._session.game)
          || (Runtime && Runtime._game)
          || StartMenu._game;
        if (game && game.returnToTitle) {
          game.returnToTitle({ skipIntro: true });
        }
      } else { // NO
        StartMenu._confirmExit = false;
      }
      return;
    }

    const e = StartMenu.ENTRIES[StartMenu.cursor];
    if (!e) return;
    const session = StartMenu._session;
    const d = StartMenu._data || data(session);
    if (typeof e.onSelect === "function") {
      try {
        e.onSelect(StartMenu._game, session);
      } catch (err) {
        console.log("[game3/start_menu] onSelect failed: " + tostring(err));
      }
    } else if (e.id === "exit") {
      if (d.exitConfirms) {
        StartMenu._confirmExit = true;
        StartMenu._confirmCursor = 2; // Default to NO
      } else {
        StartMenu.close(true); // pokeemerald/src/start_menu.c:747
      }
    } else if (e.id === "bag") {
      const BagMenu = Screens.get("bag", session);
      BagMenu.show(session && session.bag, {
        session,
        onClose: () => { /* nothing */ },
      });
    } else if (e.id === "pokedex") {
      if (d.dexNeedsSeen && !StartMenu.anySeen(session)) return;
      const Pokedex = Screens.get("pokedex", session);
      Pokedex.show(session && session.dex, { session });
    } else if (e.id === "pokemon") {
      const PartyMenu = Screens.get("party", session);
      PartyMenu.show(session && session.party, session && session.move_overlay, {
        session,
      });
    } else if (e.id === "pokenav" || e.id === "pyramid_bag" || e.id === "retire_frontier") {
      const mod = Screens.get(e.id, session);
      if (mod && mod.show) {
        mod.show({ session, game: StartMenu._game });
      } else {
        StartMenu.logUnported(e.id);
      }
    } else if (e.id === "retire") {
      // pokefirered/src/start_menu.c:546 StartMenuSafariZoneRetireCallback
      const game = StartMenu._game;
      StartMenu.close(true);
      Safari.retirePrompt(session, game);
    } else if (e.id === "trainer_link") {
      // pokefirered/src/start_menu.c:556 StartMenuLinkPlayerCallback
      // require("src.core.game3.link"): a lazily-required module (G3Lazy).
      const Link = G3Lazy["src.core.game3.link"];
      if (Link && Link.localTrainerCard) {
        TrainerCard.show({ session: Link.localTrainerCard() });
      } else {
        // NOT FAITHFUL: link deferred -- the link module is not ported (and
        // this row only appears while a link is active).
        StartMenu.logUnported(e.id);
      }
    } else if (e.id === "trainer") {
      const pass = StartMenu._kind !== "union" && StartMenu.frontierPassScreen(session);
      if (pass) {
        pass.show({ session, game: StartMenu._game }); // pokeemerald/src/start_menu.c:711
      } else {
        const TC = Screens.get("trainer_card", session);
        TC.show({ session });
      }
    } else if (e.id === "save" || e.id === "rest_frontier") {
      const SaveMenu = Screens.get("save", session);
      SaveMenu.show({ session, game: StartMenu._game });
    } else if (e.id === "option") {
      const OptionMenu = Screens.get("option", session);
      OptionMenu.show({ session });
    } else if (e.id === "mods") {
      // NOT FAITHFUL: the mod manager UI is deferred (its stub throws); the
      // MODS row only appears once a mod is discovered, which never happens here.
      ModManager.show({
        game: StartMenu._game || (session && session.game),
        session,
      });
    }
  },

  // Lua: start_menu.lua:331
  isOpen(): boolean {
    return StartMenu.open;
  },

  // pokeemerald/src/start_menu.c:612
  // Lua: start_menu.lua:336
  anySeen(session: any): boolean {
    const dex = session && session.dex;
    const seen = dex != null && typeof dex === "object" ? (dex.seen || dex.owned) : undefined;
    if (seen == null || typeof seen !== "object") return false;
    for (const [, on] of pairs(seen)) {
      if (on && on !== 0) return true;
    }
    return false;
  },

  // pokeemerald/src/start_menu.c:700
  // Lua: start_menu.lua:347
  frontierPassScreen(session: any): any {
    const store = Space && Space.store;
    if (!(store && Flags)) return undefined;
    const id = Screens.flags(session).IDS.SYS_FRONTIER_PASS;
    if (!(id != null && Flags.getFlag(store, null, id))) return undefined;
    if (!Screens.path("frontier_pass", session)) return undefined;
    return Screens.get("frontier_pass", session);
  },

  // Lua: start_menu.lua:361
  logUnported(id: string): void {
    if (unported[id]) return;
    unported[id] = true;
    console.log("[game3/start_menu] no screen registered for " + tostring(id));
  },

  /** pret: content at (22,1), width 7; labels at +8px, rows every 15px. */
  // Lua: start_menu.lua:368
  contentTemplate(): any {
    const maxVisible = (StartMenu._data && StartMenu._data.maxVisible) || StartMenu.MAX_VISIBLE || 8;
    const n = Math.min(Math.max(1, len(StartMenu.ENTRIES)), maxVisible);
    const d = StartMenu._data;
    if (d && d.window) {
      return Window.template(d.window.left, d.window.top, d.window.width, n * 2 + 2); // pokeemerald/src/menu.c:493
    }
    // Window height in tiles: pret (numActions*2)+2 includes frame padding;
    // content height for n×15px rows ≈ ceil(n*15/8) tiles.
    const contentH = Math.max(2, Math.ceil((n * Window.OPTION_HEIGHT) / 8));
    return Window.template(22, 1, 7, contentH);
  },

  // Lua: start_menu.lua:382
  draw(): void {
    if (!StartMenu.open) return;
    const dd = StartMenu._data;
    const ex = dd && dd.extraWindow && StartMenu._ctx ? dd.extraWindow(StartMenu._kind, StartMenu._ctx) : undefined;
    if (ex) {
      const stats = Window.template(ex.left, ex.top, ex.width, ex.height);
      Window.stdFrame(stats);
      const text = RomText.plain(ex.key, { stringVars: ex.vars });
      Window.printPx(text, stats.left * 8 + (ex.textX || 0), stats.top * 8 + (ex.textY ?? 1));
    }
    const tpl = StartMenu.contentTemplate();
    Window.stdFrame(tpl);
    const leftPx = tpl.left * 8;
    const topPx = tpl.top * 8;
    const d = StartMenu._data;

    const maxVisible = (d && d.maxVisible) || StartMenu.MAX_VISIBLE || 8;
    const visibleCount = Math.min(len(StartMenu.ENTRIES), maxVisible);
    const scroll = StartMenu._scrollOffset || 0;

    for (let r = 1; r <= visibleCount; r++) {
      const i = scroll + r;
      const e = StartMenu.ENTRIES[i];
      if (!e) break;
      // pret: cursor (0, r*15), text (8, r*15) inside the window.
      let yPx = Window.menuRowPx(topPx, r);
      if (d && d.rowPitch) yPx = topPx + d.textY + (r - 1) * d.rowPitch;
      if (!StartMenu._confirmExit && i === StartMenu.cursor) {
        Window.cursorPx(leftPx, yPx);
      }
      Window.printPx(e.label, leftPx + Window.CURSOR_WIDTH, yPx);
    }

    const n = len(StartMenu.ENTRIES);
    if (n > visibleCount && !StartMenu._confirmExit) {
      const showUp = scroll > 0;
      const showDown = scroll + visibleCount < n;
      StartMenu._frames = ((StartMenu._frames || 0) + 1) % 256;
      if (ListMenu && ListMenu.drawScrollArrows) {
        try { ListMenu.drawScrollArrows(tpl, showUp, showDown, StartMenu._frames); } catch { /* pcall */ }
      }
    }

    if (StartMenu._confirmExit) {
      // Bottom Dialogue Window
      Chrome.dialogueFrame();
      const prompt = Strings("RETURN TO MAIN\nMENU?");
      FrlgFont.draw(prompt, 2 * 8 + 4, 15 * 8 + 2, { linePitch: 15, colors: FrlgFont.COLOR.NORMAL });

      // Right YES/NO Window
      const popX = 21;
      const popY = 9;
      const popW = 6;
      const popH = 4;
      Window.stdFrame(Window.template(popX, popY, popW, popH));
      const rowY1 = popY * 8 + 2;
      const rowY2 = popY * 8 + 18;
      const curY = (StartMenu._confirmCursor === 1) ? rowY1 : rowY2;
      Window.cursorPx(popX * 8 + 1, curY);
      FrlgFont.draw(RomText.plain("gText_Yes"), popX * 8 + 9, rowY1, { colors: FrlgFont.COLOR.NORMAL });
      FrlgFont.draw(RomText.plain("gText_No"), popX * 8 + 9, rowY2, { colors: FrlgFont.COLOR.NORMAL });
    }
  },
};

export default StartMenu;
