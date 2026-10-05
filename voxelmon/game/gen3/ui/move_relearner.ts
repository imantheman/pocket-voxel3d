// Port of gen1recomp src/ui/game3/move_relearner.lua (GPLv3 + additional terms; see LICENSE.md).
// pokefirered/src/learn_move.c:476 MoveRelearnerStateMachine
//
// Required lazily (natives_moveteach requires it by name), so it registers
// itself in G3Lazy. Brian's module-level option tables and window templates
// are built on first use (no top-level reads of imports: the gen3 import
// cycle). His pcall(require, ...) of dataset / CacheFs / extract_island1
// always succeed here; summary_menu's failed-require path is its stub
// throwing inside his pcall.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { byte, format, tonumber, tostring } from "../../../import/gen3/lua.ts";
import { Extract } from "../../../import/gen3/extract_island1.ts";
import { Stack } from "./stack.ts";
import { Window, type WindowTemplate } from "./window.ts";
import { FrlgFont, type FontOpts } from "./frlg_font.ts";
import { Pokemon } from "../core/pokemon.ts";
import { MoveLearn } from "../core/move_learn.ts";
import { LearnMove } from "../core/battle/learn_move.ts";
import { SummaryChrome } from "./summary_chrome.ts";
import { SummaryData } from "../core/summary_data.ts";
import { Strings } from "../shared/core/Strings.ts";
import { RomText } from "../core/rom_text.ts";
import { SE } from "../core/se_ids.ts";
import { Audio } from "../core/audio.ts";
import { Dataset } from "../core/dataset.ts";
import { CacheFs } from "../shared/import/CacheFs.ts";
import { SummaryMenu } from "./summary_menu.ts";
import { G3Lazy } from "../core/lazy_registry.ts";
import { G } from "../platform/graphics.ts";
import { Fs } from "../platform/fs.ts";
import { newImageData, type Image } from "../platform/image.ts";
import { len, seq, type LuaTable } from "../platform/lt.ts";

// pokefirered/src/learn_move.c:339
const VISIBLE = 7;
// pokefirered/src/new_menu_helpers.c:84 FONT_NORMAL maxLetterHeight
const ROW_H = 14;
const CACHE_SUB = "move_relearner";

interface Ui {
  LABEL_OPTS: FontOpts; VALUE_OPTS: FontOpts; DESC_OPTS: FontOpts; ROW_OPTS: FontOpts; PROMPT_OPTS: FontOpts;
  WIN_LIST: WindowTemplate; WIN_PROMPT: WindowTemplate; WIN_YESNO: WindowTemplate;
}
let ui: Ui | undefined;
/** Brian's module-level LABEL_OPTS .. WIN_YESNO (move_relearner.lua:29-38), built on first use. */
function U(): Ui {
  return (ui ??= {
    // pokefirered/src/learn_move.c:845 LoadMoveInfoUI
    LABEL_OPTS: { small: true, colors: FrlgFont.COLOR.DARK_GRAY },
    VALUE_OPTS: { colors: FrlgFont.COLOR.NORMAL },
    DESC_OPTS: { maxWidth: 116, linePitch: 14, colors: FrlgFont.COLOR.NORMAL },
    ROW_OPTS: { maxWidth: 72, colors: FrlgFont.COLOR.NORMAL },
    PROMPT_OPTS: { maxWidth: 204, linePitch: 15, colors: FrlgFont.COLOR.NORMAL },
    // pokefirered/src/learn_move.c:254 sWindowTemplates
    WIN_LIST: Window.template(19, 1, 10, 12),
    WIN_PROMPT: Window.template(2, 15, 26, 4),
    // pokefirered/src/learn_move.c:329 sMoveRelearnerYesNoMenuTemplate
    WIN_YESNO: Window.template(21, 8, 6, 4),
  });
}

// Lua: move_relearner.lua:41
function se(id: number | undefined): void {
  try {
    const A: any = Audio;
    if (A && A.playSe) A.playSe(id);
  } catch { /* pcall */ }
}

// Lua: move_relearner.lua:48
function read_bytes(rel: string): string | null {
  {
    const D: any = Dataset;
    if (D && D.cache) {
      let d: unknown;
      try { d = D.cache().read(rel); } catch { d = undefined; }
      if (typeof d === "string" && d.length > 0) return d;
    }
  }
  {
    const C: any = CacheFs;
    if (C && C.readActive) {
      let d: unknown;
      try { d = C.readActive(rel); } catch { d = undefined; }
      if (typeof d === "string" && d.length > 0) return d;
    }
  }
  {
    let d: unknown;
    try { d = Fs.read(rel); } catch { d = undefined; }
    if (typeof d === "string" && d.length > 0) return d;
  }
  // NOT FAITHFUL: no io.open fallback on the 3DS.
  return null;
}

// Lua: move_relearner.lua:72
function chrome_root(): string {
  const root = Extract.CACHE_ROOT || "data/generated/gba";
  return root + "/" + CACHE_SUB;
}

// Lua: move_relearner.lua:111
function total_rows(): number {
  return len(MoveRelearner.moves()) + 1;
}

// Lua: move_relearner.lua:115
function clamp_cursor(): void {
  const total = total_rows();
  if (MoveRelearner.cursor > total) MoveRelearner.cursor = total;
  if (MoveRelearner.cursor < 1) MoveRelearner.cursor = 1;
  if (MoveRelearner.cursor <= MoveRelearner.scroll) {
    MoveRelearner.scroll = MoveRelearner.cursor - 1;
  }
  if (MoveRelearner.cursor > MoveRelearner.scroll + VISIBLE) {
    MoveRelearner.scroll = MoveRelearner.cursor - VISIBLE;
  }
  if (MoveRelearner.scroll < 0) MoveRelearner.scroll = 0;
}

// Lua: move_relearner.lua:128
function mon_name(): string {
  return Pokemon.displayMonName(MoveRelearner._mon);
}

// pokefirered/src/learn_move.c:690
// Lua: move_relearner.lua:133
function to_list(): void {
  MoveRelearner.state = "list";
  MoveRelearner.prompt = RomText.plain("gText_TeachWhichMoveToMon", { stringVars: seq(mon_name()) });
}

// Lua: move_relearner.lua:138
function push_message(text: string, cb?: () => void): void {
  MoveRelearner.state = "message";
  MoveRelearner.prompt = text;
  MoveRelearner._messageCb = cb;
}

// Lua: move_relearner.lua:144
function ask_yes_no(text: string, cb?: (yes: boolean) => void): void {
  MoveRelearner.state = "yesno";
  MoveRelearner.prompt = text;
  MoveRelearner.yesNoCursor = 1;
  MoveRelearner._yesNoCb = cb;
}

// Lua: move_relearner.lua:151
function party_slot(): [LuaTable, number] {
  const party = MoveRelearner._session && MoveRelearner._session.party;
  if (party != null && typeof party === "object") {
    for (let i = 1; i <= len(party); i++) {
      if (party[i] === MoveRelearner._mon) return [party, i];
    }
  }
  return [seq(MoveRelearner._mon), 1];
}

// pokefirered/src/learn_move.c:603 ShowSelectMovePokemonSummaryScreen
// Lua: move_relearner.lua:162
function open_forget_screen(_labels: unknown, cb?: (slot: number | null) => void): void {
  // pcall(require, "src.ui.game3.summary_menu"): always present (a stub throws below)
  const SM: any = SummaryMenu;
  if (!(SM && SM.openMenu)) {
    if (cb) cb(null);
    return;
  }
  const [party, slot] = party_slot();
  let okOpen = true;
  try {
    SM.openMenu(party, slot, {
      session: MoveRelearner._session,
      mode: "select_move",
      moveToLearn: MoveRelearner._pendingMoveId,
      onSelectMove: (slotIdx: number) => {
        if (cb) cb(slotIdx);
      },
    });
  } catch { okOpen = false; }
  if (!okOpen && cb) cb(null);
}

// pokefirered/src/learn_move.c:512
// Lua: move_relearner.lua:193
function start_learn(moveId: number): void {
  MoveRelearner._pendingMoveId = moveId;
  LearnMove.begin({
    mon: MoveRelearner._mon,
    moveId,
    relearner: true,
    displayName: mon_name(),
    pushMsg: push_message,
    askYesNo: ask_yes_no,
    askForget: open_forget_screen,
    onDone: (learned: unknown) => {
      if (learned) {
        MoveRelearner.finish(true);
      } else {
        // pokefirered/src/learn_move.c:591
        MoveRelearner._moves = MoveLearn.relearnableMoves(MoveRelearner._mon);
        clamp_cursor();
        to_list();
      }
    },
  });
}

// pokefirered/src/learn_move.c:816 PrintMoveInfo
// Lua: move_relearner.lua:316
function move_info(moveId: number): any {
  let info = MoveRelearner._info;
  if (info && info.id === moveId) return info;
  const row = Pokemon.battleMove(moveId) || {};
  const power = tonumber(row.power) ?? 0;
  const acc = tonumber(row.accuracy) ?? 0;
  const desc = SummaryData.moveDescription(moveId, Pokemon.moveName(moveId));
  info = {
    id: moveId,
    badge: tostring(row.type ?? "NORMAL").toUpperCase(),
    power: power >= 2 ? format("%3d", power) : "---",
    accuracy: acc > 0 ? format("%3d", acc) : "---",
    pp: tostring(tonumber(row.pp) ?? 0),
    desc: (desc && desc !== "") ? FrlgFont.wrap(desc, 116) : null,
  };
  MoveRelearner._info = info;
  return info;
}

// Lua: move_relearner.lua:335
function draw_move_info(moveId: number): void {
  const info = move_info(moveId);
  const u = U();
  SummaryChrome.drawTypeBadge(info.badge, 41, 4);
  FrlgFont.draw(info.power, 121, 4, u.VALUE_OPTS);
  FrlgFont.draw(info.accuracy, 121, 18, u.VALUE_OPTS);
  FrlgFont.draw(info.pp, 42, 18, u.VALUE_OPTS);
  if (info.desc) {
    FrlgFont.draw(info.desc, 17, 48, u.DESC_OPTS);
  }
}

export const MoveRelearner = {
  isMenu: true,
  open: false,
  state: "list",
  cursor: 1,
  scroll: 0,
  yesNoCursor: 1,
  prompt: null as string | null,
  _mon: null as any,
  _session: null as any,
  _onDone: null as ((learned: boolean) => void) | null | undefined,
  _moves: null as LuaTable | null,
  _pendingMoveId: null as number | null,
  _messageCb: null as (() => void) | null | undefined,
  _yesNoCb: null as ((yes: boolean) => void) | null | undefined,
  _info: null as any,
  _chromeTried: false,
  _bg: null as Image | null,

  // pokefirered/src/learn_move.c:403 MoveRelearnerLoadBgGfx
  // Lua: move_relearner.lua:79
  chrome(): Image | null {
    if (MoveRelearner._chromeTried) return MoveRelearner._bg;
    MoveRelearner._chromeTried = true;
    const rgba = read_bytes(chrome_root() + "/bg.rgba");
    if (!rgba || rgba.length < 240 * 160 * 4) return null;
    let data;
    try { data = newImageData(240, 160); } catch { return null; }
    let okW = true;
    try {
      for (let y = 0; y <= 159; y++) {
        for (let x = 0; x <= 239; x++) {
          const o = (y * 240 + x) * 4;
          data.setPixel(x, y, byte(rgba, o + 1)! / 255, byte(rgba, o + 2)! / 255,
            byte(rgba, o + 3)! / 255, byte(rgba, o + 4)! / 255);
        }
      }
    } catch { okW = false; }
    if (!okW) return null;
    let img: Image;
    try { img = G.newImage(data); } catch { return null; }
    MoveRelearner._bg = img;
    return img;
  },

  // Lua: move_relearner.lua:103
  isOpen(): boolean {
    return MoveRelearner.open;
  },

  // Lua: move_relearner.lua:107
  moves(): LuaTable {
    return MoveRelearner._moves || seq();
  },

  // Lua: move_relearner.lua:180
  finish(learned?: boolean): void {
    if (!MoveRelearner.open) return;
    MoveRelearner.open = false;
    MoveRelearner.state = "list";
    MoveRelearner._messageCb = null;
    MoveRelearner._yesNoCb = null;
    Stack.pop("move_relearner");
    const cb = MoveRelearner._onDone;
    MoveRelearner._onDone = null;
    if (cb) cb(learned === true);
  },

  // Lua: move_relearner.lua:216
  show(mon: any, opts?: any): void {
    opts = opts || {};
    MoveRelearner.open = true;
    MoveRelearner._mon = mon;
    MoveRelearner._session = opts.session;
    MoveRelearner._onDone = opts.onDone;
    MoveRelearner._moves = MoveLearn.relearnableMoves(mon);
    MoveRelearner._pendingMoveId = null;
    MoveRelearner._messageCb = null;
    MoveRelearner._yesNoCb = null;
    MoveRelearner.cursor = 1;
    MoveRelearner.scroll = 0;
    clamp_cursor();
    to_list();
    Stack.push("move_relearner", MoveRelearner as LuaTable, { hideBelow: true, fullscreen: true });
  },

  // Lua: move_relearner.lua:233
  handleInput(input: any): void {
    if (!MoveRelearner.open) return;

    if (MoveRelearner.state === "message") {
      if (input.wasPressed("a") || input.wasPressed("b")) {
        se(SE.SE_SELECT);
        const cb = MoveRelearner._messageCb;
        MoveRelearner._messageCb = null;
        to_list();
        if (cb) cb();
      }
      return;
    }

    if (MoveRelearner.state === "yesno") {
      if (input.wasPressed("up") || input.wasPressed("down")) {
        MoveRelearner.yesNoCursor = MoveRelearner.yesNoCursor === 1 ? 2 : 1;
        se(SE.SE_SELECT);
      } else if (input.wasPressed("a")) {
        se(SE.SE_SELECT);
        const yes = MoveRelearner.yesNoCursor === 1;
        const cb = MoveRelearner._yesNoCb;
        MoveRelearner._yesNoCb = null;
        to_list();
        if (cb) cb(yes);
      } else if (input.wasPressed("b")) {
        se(SE.SE_SELECT);
        const cb = MoveRelearner._yesNoCb;
        MoveRelearner._yesNoCb = null;
        to_list();
        if (cb) cb(false);
      }
      return;
    }

    const total = total_rows();
    if (input.wasPressed("up")) {
      if (MoveRelearner.cursor > 1) {
        MoveRelearner.cursor = MoveRelearner.cursor - 1;
        clamp_cursor();
        se(SE.SE_SELECT);
      }
    } else if (input.wasPressed("down")) {
      if (MoveRelearner.cursor < total) {
        MoveRelearner.cursor = MoveRelearner.cursor + 1;
        clamp_cursor();
        se(SE.SE_SELECT);
      }
    } else if (input.wasPressed("a")) {
      se(SE.SE_SELECT);
      const moveId = MoveRelearner.moves()[MoveRelearner.cursor];
      if (moveId != null) {
        // pokefirered/src/learn_move.c:784
        ask_yes_no(RomText.plain("gText_TeachMoveQues",
          { stringVars: seq(mon_name(), Pokemon.moveName(moveId)) }), (yes) => {
          if (yes) {
            start_learn(moveId);
          } else {
            to_list();
          }
        });
      } else {
        MoveRelearner.giveUpPrompt();
      }
    } else if (input.wasPressed("b")) {
      se(SE.SE_SELECT);
      MoveRelearner.giveUpPrompt();
    }
  },

  // pokefirered/src/learn_move.c:789
  // Lua: move_relearner.lua:304
  giveUpPrompt(): void {
    ask_yes_no(RomText.plain("gText_GiveUpTryingToTeachNewMove", { stringVars: seq(mon_name()) }), (yes) => {
      if (yes) {
        // pokefirered/src/learn_move.c:541
        MoveRelearner.finish(false);
      } else {
        to_list();
      }
    });
  },

  // Lua: move_relearner.lua:346
  draw(): void {
    if (!MoveRelearner.open) return;
    const u = U();
    const moves = MoveRelearner.moves();
    const total = total_rows();

    const bg = MoveRelearner.chrome();
    if (bg) {
      G.setColor(1, 1, 1, 1);
      G.draw(bg, 0, 0);
    } else {
      G.setColor(0.24, 0.35, 0.50, 1);
      G.rectangle("fill", 0, 0, 240, 160);
      // pokefirered/src/learn_move.c:254 sWindowTemplates
      G.setColor(0.88, 0.91, 0.95, 1);
      G.rectangle("fill", 0, 0, 148, 48);
      G.setColor(0.98, 0.98, 0.98, 1);
      G.rectangle("fill", 16, 48, 120, 64);
      G.setColor(1, 1, 1, 1);
    }
    // pokefirered/src/learn_move.c:679 DrawTextBorderOnWindows6and7
    Window.stdFrame(u.WIN_LIST);
    Window.stdFrame(u.WIN_PROMPT);

    // pokefirered/src/learn_move.c:845 LoadMoveInfoUI
    FrlgFont.draw(Strings("TYPE"), 1, 4, u.LABEL_OPTS);
    FrlgFont.draw(Strings("POWER"), 80, 4, u.LABEL_OPTS);
    FrlgFont.draw(Strings("PP"), 1, 19, u.LABEL_OPTS);
    FrlgFont.draw(Strings("ACCURACY"), 80, 19, u.LABEL_OPTS);
    FrlgFont.draw(Strings("EFFECT"), 1, 34, u.LABEL_OPTS);

    const selected = moves[MoveRelearner.cursor];
    if (selected != null) draw_move_info(selected);

    // pokefirered/src/learn_move.c:339 sMoveRelearnerListMenuTemplate
    for (let i = 1; i <= VISIBLE; i++) {
      const idx = MoveRelearner.scroll + i;
      if (idx > total) break;
      const y = 8 + (i - 1) * ROW_H;
      if (idx === MoveRelearner.cursor && MoveRelearner.state === "list") {
        Window.cursorPx(152, y);
      }
      // pokefirered/src/learn_move.c:761
      const row = moves[idx] != null ? Pokemon.moveName(moves[idx]) : RomText.plain("gFameCheckerText_Cancel");
      FrlgFont.draw(row, 160, y, u.ROW_OPTS);
    }

    if (MoveRelearner.prompt) {
      FrlgFont.draw(MoveRelearner.prompt, 16, 122, u.PROMPT_OPTS);
    }

    if (MoveRelearner.state === "yesno") {
      Window.stdFrame(u.WIN_YESNO);
      FrlgFont.draw(RomText.plain("gText_Yes"), 176, 66, u.VALUE_OPTS);
      FrlgFont.draw(RomText.plain("gText_No"), 176, 82, u.VALUE_OPTS);
      Window.cursorPx(169, MoveRelearner.yesNoCursor === 1 ? 66 : 82);
    }
  },
};

G3Lazy["src.ui.game3.move_relearner"] = MoveRelearner;

export default MoveRelearner;
