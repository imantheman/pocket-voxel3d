// Port of gen1recomp src/ui/game3/easy_chat.lua (GPLv3 + additional terms; see LICENSE.md).
// FRLG Easy Chat / Profile word-selection modal (pret easy_chat_2.c & easy_chat_3.c).
// 1:1 Authentic UI matching FireRed/LeafGreen graphics, palettes, and layout.
//
// Emerald (rse) branches: Profile.family(session) decides them per session.
// The template lookup's FRLG path (no template) is ported as is; the
// Emerald word-group population needs src.core.game3.rse.*, which this port
// does not have, and throws `NOT FAITHFUL: Emerald only`.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { Display } from "../core/display.ts";
import { FrlgFont } from "./frlg_font.ts";
import { Stack } from "./stack.ts";
import { Audio } from "../core/audio.ts";
import { EasyChatText, type EcGroup, type EcWord } from "../core/easy_chat_text.ts";
// src.ui.game3.chrome is required by Brian's module but not used by it
import "./chrome.ts";
import { Strings } from "../shared/core/Strings.ts";
import { RomText } from "../core/rom_text.ts";
import { Runtime } from "../core/runtime.ts";
import { Flags } from "../core/scripting/flags.ts";
import { Space } from "../core/scripting/space.ts";
import { Dex } from "../core/dex.ts";
import { PokedexData } from "../core/pokedex_data.ts";
import { Profile } from "../core/profile.ts";
import { Dataset } from "../core/dataset.ts";
import { Fade } from "./fade.ts";
import { G } from "../platform/graphics.ts";
import { luaLoad } from "../platform/luadata.ts";
import { ipairs, len, pairs, seq, unpack, type LuaTable } from "../platform/lt.ts";
import { mod, tonumber } from "../../../import/gen3/lua.ts";

export interface EasyChatOpts {
  session?: any;
  type?: number;
  words?: LuaTable;
  onDone?: (confirmed: boolean, words: LuaTable) => void;
}

export interface EasyChatState {
  type: number;
  title: string;
  instr1: string;
  instr2: string;
  confirm1: string;
  confirm2: string;
  words: LuaTable;
  origWords: LuaTable;
  cols: number;
  rows: number;
  count: number;
  frame: any;
  selectedSlot: number;
  mode: string;
  footerIdx: number;
  groups: LuaTable;
  groupCursor: number;
  groupScroll: number;
  wordCursor: number;
  wordPage: number;
  confirmChoice: number;
  animTimer: number;
  onDone: ((confirmed: boolean, words: LuaTable) => void) | undefined;
  session: any;
}

// Positions matching pret sPhraseFrameDimensions[0]
const SLOTS_LAYOUT = seq(
  { x: 36, y: 34, w: 84, h: 16 },
  { x: 126, y: 34, w: 84, h: 16 },
  { x: 36, y: 52, w: 84, h: 16 },
  { x: 126, y: 52, w: 84, h: 16 },
);

// The cart's own words fit the boxes they are drawn in -- the widest is
// 72 px -- a translated one need not, so every word is clipped to its box.
// In the picker that box is the red selection rectangle, which starts 12 px
// left of the pen and is 92 px wide.  In the phrase frame it is the slot's
// own frame (SLOTS_LAYOUT), which also keeps a left word clear of the right
// slot's cursor.  Group names get the room up to the scroll arrows (centred
// at +112, 8 px wide) instead: an official translation already needs it --
// the French cart's VIE QUOTIDIEN. is 83 px.
const CELL_WIDTH = 80;
const GROUP_CELL_WIDTH = 88;

// Lua: easy_chat.lua:37
function slotWidth(index: number, penX: number): number {
  const frame = SLOTS_LAYOUT[index]!;
  return frame.x + frame.w - penX;
}

const FOOTER_BTNS = seq(
  { id: "DEL_ALL", cursorX: 22, y: 88 },
  { id: "CANCEL", cursorX: 109, y: 88 },
  { id: "OK", cursorX: 185, y: 88 },
);
const FOOTER_X = 32;

// src/easy_chat_2.c:309
const SCREEN_TEXT: Record<number, LuaTable> = {
  0: seq("gText_Profile", "gText_CombineFourWordsOrPhrases", "gText_AndMakeYourProfile",
    "gText_YourProfile", "gText_IsAsShownOkay"),
  1: seq("gText_AtTheBattlesStart", "gText_MakeMessageSixPhrases", "gText_MaxTwoTwelveLetterPhrases",
    "gText_YourFeelingAtTheBattlesStart", "gText_IsAsShownOkay"),
  14: seq("gText_Questionnaire", "gText_CombineFourWordsOrPhrases", "gText_AndFillOutTheQuestionnaire",
    "gText_TheAnswer", "gText_IsAsShownOkay"),
};

// Lua: easy_chat.lua:82
function play_se(id: number): void {
  // pcall(require, "src.core.game3.audio"): always loaded here
  if (Audio && Audio.playSe) {
    Audio.playSe(id);
  }
}

const EC_GROUP_POKEMON_2 = 0x00, EC_GROUP_TRAINER = 0x01, EC_GROUP_ADJECTIVES = 0x10;
const EC_GROUP_EVENTS = 0x11, EC_GROUP_MOVE_1 = 0x12, EC_GROUP_MOVE_2 = 0x13, EC_GROUP_POKEMON = 0x15;
// pokefirered/src/easy_chat.c:82
const SPECIES_DEOXYS = 410;

// Lua: easy_chat.lua:94
function session_state(sessionIn: any): [any, (name: string) => boolean] {
  // package.loaded["src.core.game3.runtime"]
  const session = sessionIn || (Runtime && Runtime.getSession && Runtime.getSession()) || {};
  // package.loaded["src.core.game3.scripting.space"]
  const store = (Space && Space.store) || session;
  return [session, (name: string): boolean => Flags.getFlag(store, null, Flags.IDS[name]) === true];
}

// pokefirered/src/easy_chat.c:692 UnlockedECMonOrMove
// Lua: easy_chat.lua:104
function unlocked_words(gid: number, dex: any): EcGroup | undefined {
  const g = EasyChatText.group(gid);
  if (!(g && g.words)) return undefined;
  if (gid !== EC_GROUP_POKEMON && gid !== EC_GROUP_POKEMON_2) return g;
  const out: any = {};
  for (const [k, v] of pairs(g)) out[k] = v;
  out.words = seq();
  for (const [, w] of ipairs<EcWord>(g.words)) {
    const [, species] = EasyChatText.decodeWord(w.id);
    if ((gid === EC_GROUP_POKEMON_2 && species !== SPECIES_DEOXYS) || Dex.isSeen(dex, species)) {
      out.words[len(out.words) + 1] = w;
    }
  }
  return out as EcGroup;
}

// pokeemerald/src/easy_chat.c:5806
// Lua: easy_chat.lua:122
function rse_group_words(gid: number, sess: any, Town: any): EcGroup | undefined {
  const g = EasyChatText.group(gid);
  if (!(g && g.words)) return undefined;
  const GR = Town.EC_GROUP;
  const out: any = {};
  for (const [k, v] of pairs(g)) out[k] = v;
  out.words = seq();
  if (gid === GR.POKEMON || gid === GR.POKEMON_NATIONAL || gid === GR.MOVE_1 || gid === GR.MOVE_2) {
    for (const [, w] of ipairs<EcWord>(g.words)) {
      if (gid !== GR.POKEMON || (sess.dex && Dex.isSeen(sess.dex, w.value))) out.words[len(out.words) + 1] = w;
    }
  } else {
    // pokeemerald/src/easy_chat.c:5775
    for (const [, w] of ipairs<any>(g.words)) {
      const idx = tonumber(w.alphabeticalOrder) ?? 0;
      const entry = g.words[idx + 1];
      let on: boolean;
      if (gid === GR.TRENDY_SAYING) {
        // NOT FAITHFUL: Emerald only (src.core.game3.rse.old_man is not in this port)
        throw new Error("NOT FAITHFUL: Emerald only (rse.old_man.isTrendySayingUnlocked)");
      } else {
        on = !!entry && entry.enabled !== false;
      }
      if (entry && on) out.words[len(out.words) + 1] = entry;
    }
  }
  return out as EcGroup;
}

// pokeemerald/src/easy_chat.c:5613
// Lua: easy_chat.lua:152
function rse_populate_groups(_session: any): LuaTable {
  // NOT FAITHFUL: Emerald only. Brian requires src.core.game3.rse.town_common
  // here (EC_GROUP, numWordsInGroup, groupUnlocked) and builds the list with
  // rse_group_words; that module is not in this port.
  void rse_group_words;
  throw new Error("NOT FAITHFUL: Emerald only (rse.town_common easy chat groups)");
}

let templatePack: any;

// pokeemerald/src/easy_chat.c:428
// Lua: easy_chat.lua:197
function rse_template(session: any, chatType: number): [any, any] | [] {
  if (Profile.family(session) !== "rse") return [];
  if (templatePack == null) {
    const src = Dataset.cache().read(EasyChatText.FILE);
    let chunk: (() => unknown) | undefined;
    if (src) [chunk] = luaLoad(src, "@" + EasyChatText.FILE);
    templatePack = chunk ? chunk() : false;
  }
  if (!(templatePack && templatePack.templates)) return [];
  for (const [, t] of ipairs<any>(templatePack.templates)) {
    if (t.type === chatType) return [t, templatePack.frames[t.frameId]];
  }
  return [];
}

// pokeemerald/src/easy_chat.c:345
const FRAMEID_MAIL = 2, FRAMEID_QUIZ_QUESTION = 7, FRAMEID_QUIZ_SET_QUESTION = 8;

/** Draw framed box with authentic FRLG orange/gold rounded border (text_input_frame_orange.pal). */
// Lua: easy_chat.lua:534
function drawOrangeFrame(x: number, y: number, w: number, h: number): void {
  // Outer shadow (dark orange 205, 98, 0)
  G.setColor(205 / 255, 98 / 255, 0 / 255, 1);
  G.rectangle("fill", x - 2, y - 2, w + 4, h + 4, 3, 3);
  // Main border (medium orange 255, 139, 57)
  G.setColor(255 / 255, 139 / 255, 57 / 255, 1);
  G.rectangle("fill", x - 1, y - 1, w + 2, h + 2, 2, 2);
  // Inner highlight (light orange 255, 189, 115)
  G.setColor(255 / 255, 189 / 255, 115 / 255, 1);
  G.rectangle("line", x, y, w, h);
  // Interior fill (pure white)
  G.setColor(1, 1, 1, 1);
  G.rectangle("fill", x + 1, y + 1, w - 2, h - 2);
}

/** Draw standard FRLG white dialog window frame (menu / text window border). */
// Lua: easy_chat.lua:550
function drawDialogFrame(x: number, y: number, w: number, h: number): void {
  // Outer drop shadow
  G.setColor(64 / 255, 72 / 255, 80 / 255, 0.4);
  G.rectangle("fill", x - 2, y - 2, w + 4, h + 4, 3, 3);
  // Outer border
  G.setColor(96 / 255, 112 / 255, 128 / 255, 1);
  G.rectangle("fill", x - 2, y - 2, w + 4, h + 4, 2, 2);
  // Inner light border
  G.setColor(192 / 255, 208 / 255, 224 / 255, 1);
  G.rectangle("fill", x - 1, y - 1, w + 2, h + 2, 1, 1);
  // Interior fill (pure white)
  G.setColor(1, 1, 1, 1);
  G.rectangle("fill", x, y, w, h);
}

/** Draw authentic FireRed 8x8 red triangle cursor (sSpriteTemplate_TriangleCursor) with bounce animation. */
// Lua: easy_chat.lua:566
function drawTriangleCursor(x: number, y: number, timer?: number): void {
  let bounce = 0;
  if (timer != null) {
    bounce = Math.floor(mod(timer * 6, 4));
    if (bounce === 3) bounce = 1;
  }
  const cx = x + bounce;
  const cy = y;
  // Outer border
  G.setColor(128 / 255, 0, 0, 1);
  G.polygon("fill", seq(
    cx - 1, cy - 1,
    cx + 7, cy + 3,
    cx - 1, cy + 7,
  ));
  // Red fill
  G.setColor(230 / 255, 8 / 255, 8 / 255, 1);
  G.polygon("fill", seq(
    cx, cy,
    cx + 6, cy + 3,
    cx, cy + 6,
  ));
  // Light red/orange highlight
  G.setColor(255 / 255, 189 / 255, 115 / 255, 1);
  G.line(cx, cy, cx + 5, cy + 3);
}

/** Draw authentic scroll indicators (sSpriteTemplate_ScrollIndicator). */
// Lua: easy_chat.lua:594
function drawScrollArrow(cx: number, cy: number, isUp: boolean): void {
  G.setColor(230 / 255, 8 / 255, 8 / 255, 1);
  if (isUp) {
    G.polygon("fill", seq(
      cx, cy - 3,
      cx + 4, cy + 3,
      cx - 4, cy + 3,
    ));
  } else {
    G.polygon("fill", seq(
      cx - 4, cy - 3,
      cx + 4, cy - 3,
      cx, cy + 3,
    ));
  }
}

export const EasyChat = {
  isMenu: true,

  openFlag: false,
  _state: undefined as EasyChatState | undefined,

  FOOTER_BTNS,

  // src/easy_chat_3.c:2314
  // Lua: easy_chat.lua:51
  footerLabels(): [LuaTable, LuaTable] {
    const out: LuaTable = seq(), xs: LuaTable = seq(0);
    if (!RomText.has("gText_DelAllCancelOk")) {
      // pokeemerald/src/easy_chat.c:1201
      const offsets = seq(16, 111, 196);
      for (const [i, key] of ipairs<string>(seq("gText_DelAll", "gText_Cancel5", "gText_Ok2"))) {
        out[i] = RomText.plain(key);
        xs[i] = 8 + offsets[i]! - FOOTER_X;
      }
      return [out, xs];
    }
    // the IR is a 0-based Seg[] (rom_text.ts). Its args are 0-based when
    // TextIR decoded them, but the script cache's bundle keeps the Lua
    // sequence ([null, arg]); cmd 0x13 has one argument, so take whichever.
    for (const seg of RomText.ir("gText_DelAllCancelOk")) {
      if (seg.t === "text") {
        out[len(out) + 1] = Strings(seg.s!);
      } else if (seg.t === "ext" && seg.cmd === 0x13) {
        const args = seg.args!;
        xs[len(out) + 1] = args[0] ?? args[1];
      }
    }
    return [out, xs];
  },

  // pokefirered/src/easy_chat.c:500 PopulateECGroups
  // Lua: easy_chat.lua:170
  populateGroups(sessionIn?: any): LuaTable {
    const [session, flag] = session_state(sessionIn);
    if (Profile.family(session) === "rse") return rse_populate_groups(session);
    const dex = session.dex;
    const ids: LuaTable = seq();
    if (Dex.countSeen(dex, "national") > 0) ids[len(ids) + 1] = EC_GROUP_POKEMON;
    for (let gid = EC_GROUP_TRAINER; gid <= EC_GROUP_ADJECTIVES; gid++) ids[len(ids) + 1] = gid;
    if (flag("SYS_GAME_CLEAR")) {
      ids[len(ids) + 1] = EC_GROUP_EVENTS;
      ids[len(ids) + 1] = EC_GROUP_MOVE_1;
      ids[len(ids) + 1] = EC_GROUP_MOVE_2;
    }
    if (PokedexData.isNationalUnlocked(session, dex)) ids[len(ids) + 1] = EC_GROUP_POKEMON_2;
    const list: LuaTable = seq();
    for (const [, gid] of ipairs<number>(ids)) {
      const g = unlocked_words(gid, dex);
      if (g) list[len(list) + 1] = g;
    }
    return list;
  },

  rseTemplate: rse_template,

  // Lua: easy_chat.lua:215
  open(optsIn?: EasyChatOpts): EasyChatState {
    const opts = optsIn ?? {};
    const [tmpl, frame] = rse_template(opts.session, tonumber(opts.type) ?? 0);
    let [cols, rows] = [2, 2];
    if (tmpl) [cols, rows] = [tmpl.numColumns, tmpl.numRows];
    let count = cols * rows;
    if (tmpl && (tmpl.frameId === FRAMEID_MAIL || tmpl.frameId === FRAMEID_QUIZ_QUESTION
      || tmpl.frameId === FRAMEID_QUIZ_SET_QUESTION)) {
      // pokeemerald/src/easy_chat.c:4108
      count = cols * rows - 1;
    }
    // pcall(require, "src.ui.game3.fade"): always loaded here
    if (Fade && Fade.clear) {
      Fade.clear();
    }

    const initialWords: LuaTable = seq();
    const srcWords = opts.words ?? (tmpl ? seq() : EasyChatText.DEFAULT_PROFILE);
    for (let i = 1; i <= count; i++) {
      const dflt = !tmpl ? EasyChatText.DEFAULT_PROFILE[i] : undefined;
      initialWords[i] = tonumber(srcWords[i]) ?? (dflt != null ? dflt : EasyChatText.EC_WORD_UNDEFINED);
    }

    const groupList = EasyChat.populateGroups(opts.session);

    let title: string, instr1: string, instr2: string, confirm1: string, confirm2: string;
    if (tmpl) {
      [title, instr1, instr2, confirm1, confirm2] = [tmpl.title, tmpl.instructions1, tmpl.instructions2, tmpl.confirm1, tmpl.confirm2];
    } else {
      const keys = (opts.type != null ? SCREEN_TEXT[opts.type] : undefined) ?? SCREEN_TEXT[0]!;
      title = RomText.plain(keys[1]);
      instr1 = RomText.plain(keys[2]);
      instr2 = RomText.plain(keys[3]);
      confirm1 = RomText.plain(keys[4]);
      confirm2 = RomText.plain(keys[5]);
    }

    const st: EasyChatState = {
      type: opts.type ?? 0,
      title,
      instr1,
      instr2,
      confirm1,
      confirm2,
      words: initialWords,
      origWords: seq(...unpack(initialWords, 1, count)),
      cols,
      rows,
      count,
      frame,
      selectedSlot: 1,
      mode: "SLOT", // "SLOT", "FOOTER", "GROUP", "WORD", "CONFIRM", "CANCEL_CONFIRM", "DEL_ALL_CONFIRM"
      footerIdx: 3, // 1 = DEL ALL, 2 = CANCEL, 3 = OK
      groups: groupList,
      groupCursor: 1,
      groupScroll: 0,
      wordCursor: 1,
      wordPage: 0,
      confirmChoice: 1, // 1 = YES, 2 = NO
      animTimer: 0,
      onDone: opts.onDone,
      session: opts.session,
    };

    EasyChat._state = st;
    EasyChat.openFlag = true;
    Stack.push("easy_chat", EasyChat, { hideBelow: true, fullscreen: true });
    return st;
  },

  // Lua: easy_chat.lua:284
  isOpen(): boolean {
    return EasyChat.openFlag;
  },

  // Lua: easy_chat.lua:288
  close(confirmed: boolean, words: LuaTable): void {
    const st = EasyChat._state;
    const cb = st ? st.onDone : undefined;
    EasyChat.openFlag = false;
    EasyChat._state = undefined;
    Stack.pop("easy_chat");
    if (cb) {
      cb(confirmed, words);
    }
  },

  // Lua: easy_chat.lua:299
  update(dt?: number): void {
    if (!EasyChat.openFlag || !EasyChat._state) return;
    EasyChat._state.animTimer = (EasyChat._state.animTimer ?? 0) + (dt ?? (1 / 60));
  },

  // Lua: easy_chat.lua:304
  handleInput(inp: any): void {
    if (!EasyChat.openFlag || !inp) return;
    const st = EasyChat._state;
    if (!st) return;

    // Confirmation Popups (CONFIRM, CANCEL_CONFIRM, DEL_ALL_CONFIRM)
    if (st.mode === "CONFIRM" || st.mode === "CANCEL_CONFIRM" || st.mode === "DEL_ALL_CONFIRM") {
      if (inp.wasPressed("up") || inp.wasPressed("down")) {
        st.confirmChoice = (st.confirmChoice === 1) ? 2 : 1;
        play_se(5); // SE_SELECT
      } else if (inp.wasPressed("a")) {
        play_se(5);
        if (st.mode === "CONFIRM") {
          if (st.confirmChoice === 1) {
            EasyChat.close(true, st.words);
          } else {
            st.mode = "SLOT";
          }
        } else if (st.mode === "CANCEL_CONFIRM") {
          if (st.confirmChoice === 1) {
            EasyChat.close(false, st.origWords);
          } else {
            st.mode = "SLOT";
          }
        } else if (st.mode === "DEL_ALL_CONFIRM") {
          if (st.confirmChoice === 1) {
            for (let i = 1; i <= st.count; i++) st.words[i] = EasyChatText.EC_WORD_UNDEFINED;
          }
          st.mode = "SLOT";
        }
      } else if (inp.wasPressed("b")) {
        play_se(5);
        st.mode = "SLOT";
      }
      return;
    }

    // Global shortcut: START opens OK confirmation
    if (inp.wasPressed("start")) {
      play_se(5);
      st.confirmChoice = 1;
      st.mode = "CONFIRM";
      return;
    }

    // Slot Navigation
    if (st.mode === "SLOT") {
      const col = (st.selectedSlot - 1) % st.cols;
      if (inp.wasPressed("left")) {
        if (col > 0) {
          st.selectedSlot = st.selectedSlot - 1;
          play_se(5);
        }
      } else if (inp.wasPressed("right")) {
        if (col < st.cols - 1 && st.selectedSlot < st.count) {
          st.selectedSlot = st.selectedSlot + 1;
          play_se(5);
        }
      } else if (inp.wasPressed("up")) {
        if (st.selectedSlot > st.cols) {
          st.selectedSlot = st.selectedSlot - st.cols;
          play_se(5);
        }
      } else if (inp.wasPressed("down")) {
        if (st.selectedSlot + st.cols <= st.count) {
          st.selectedSlot = st.selectedSlot + st.cols;
          play_se(5);
        } else {
          st.mode = "FOOTER";
          st.footerIdx = (col === 0) ? 1 : 3;
          play_se(5);
        }
      } else if (inp.wasPressed("a")) {
        play_se(5);
        st.mode = "GROUP";
      } else if (inp.wasPressed("b")) {
        play_se(5);
        st.confirmChoice = 2;
        st.mode = "CANCEL_CONFIRM";
      }

    // Footer Navigation (DEL. ALL, CANCEL, OK)
    } else if (st.mode === "FOOTER") {
      if (inp.wasPressed("left")) {
        if (st.footerIdx > 1) {
          st.footerIdx = st.footerIdx - 1;
          play_se(5);
        }
      } else if (inp.wasPressed("right")) {
        if (st.footerIdx < 3) {
          st.footerIdx = st.footerIdx + 1;
          play_se(5);
        }
      } else if (inp.wasPressed("up")) {
        st.mode = "SLOT";
        const lastRow = st.count - (st.count - 1) % st.cols;
        st.selectedSlot = (st.footerIdx <= 1) ? lastRow : Math.min(lastRow + 1, st.count);
        play_se(5);
      } else if (inp.wasPressed("a")) {
        play_se(5);
        if (st.footerIdx === 1) { // DEL. ALL
          st.confirmChoice = 2;
          st.mode = "DEL_ALL_CONFIRM";
        } else if (st.footerIdx === 2) { // CANCEL
          st.confirmChoice = 2;
          st.mode = "CANCEL_CONFIRM";
        } else if (st.footerIdx === 3) { // OK
          st.confirmChoice = 1;
          st.mode = "CONFIRM";
        }
      } else if (inp.wasPressed("b")) {
        play_se(5);
        st.mode = "SLOT";
      }

    // Group Selection Mode
    } else if (st.mode === "GROUP") {
      const numG = len(st.groups);
      const curIndex = st.groupCursor;
      let row = Math.floor((curIndex - 1) / 2);
      const col = (curIndex - 1) % 2;
      const totalRows = Math.ceil(numG / 2);

      if (inp.wasPressed("up")) {
        if (row > 0) {
          row = row - 1;
          st.groupCursor = Math.min(numG, row * 2 + col + 1);
          play_se(5);
        }
      } else if (inp.wasPressed("down")) {
        if (row < totalRows - 1) {
          row = row + 1;
          st.groupCursor = Math.min(numG, row * 2 + col + 1);
          play_se(5);
        }
      } else if (inp.wasPressed("left")) {
        if (col > 0) {
          st.groupCursor = st.groupCursor - 1;
          play_se(5);
        }
      } else if (inp.wasPressed("right")) {
        if (col < 1 && (st.groupCursor + 1) <= numG) {
          st.groupCursor = st.groupCursor + 1;
          play_se(5);
        }
      } else if (inp.wasPressed("a")) {
        play_se(5);
        st.mode = "WORD";
        st.wordCursor = 1;
        st.wordPage = 0;
      } else if (inp.wasPressed("b")) {
        play_se(5);
        st.mode = "SLOT";
      }

    // Word Selection Mode
    } else if (st.mode === "WORD") {
      const curGroup = st.groups[st.groupCursor];
      const wordsList: LuaTable = (curGroup && curGroup.words) || seq();
      const totalWords = len(wordsList);
      const pageSize = 8;
      const maxPages = Math.max(1, Math.ceil(totalWords / pageSize));
      const pageOffset = st.wordPage * pageSize;
      const curIndexOnPage = st.wordCursor; // 1..8
      let row = Math.floor((curIndexOnPage - 1) / 2);
      const col = (curIndexOnPage - 1) % 2;

      if (inp.wasPressed("up")) {
        if (row > 0) {
          row = row - 1;
          st.wordCursor = row * 2 + col + 1;
          play_se(5);
        } else if (st.wordPage > 0) {
          st.wordPage = st.wordPage - 1;
          st.wordCursor = 3 * 2 + col + 1;
          play_se(5);
        }
      } else if (inp.wasPressed("down")) {
        if (row < 3 && (pageOffset + (row + 1) * 2 + col + 1) <= totalWords) {
          row = row + 1;
          st.wordCursor = row * 2 + col + 1;
          play_se(5);
        } else if (st.wordPage < maxPages - 1) {
          st.wordPage = st.wordPage + 1;
          st.wordCursor = col + 1;
          play_se(5);
        }
      } else if (inp.wasPressed("left")) {
        if (col > 0) {
          st.wordCursor = st.wordCursor - 1;
          play_se(5);
        } else if (st.wordPage > 0) {
          st.wordPage = st.wordPage - 1;
          st.wordCursor = 1;
          play_se(5);
        }
      } else if (inp.wasPressed("right")) {
        if (col < 1 && (pageOffset + curIndexOnPage + 1) <= totalWords) {
          st.wordCursor = st.wordCursor + 1;
          play_se(5);
        } else if (st.wordPage < maxPages - 1) {
          st.wordPage = st.wordPage + 1;
          st.wordCursor = 1;
          play_se(5);
        }
      } else if (inp.wasPressed("select")) {
        // Page down shortcut
        if (st.wordPage < maxPages - 1) {
          st.wordPage = st.wordPage + 1;
          st.wordCursor = 1;
          play_se(5);
        }
      } else if (inp.wasPressed("a")) {
        const chosenIdx = pageOffset + st.wordCursor;
        const wEntry = wordsList[chosenIdx];
        if (wEntry) {
          st.words[st.selectedSlot] = wEntry.id;
          play_se(5);
          // Advance slot to next
          st.selectedSlot = (st.selectedSlot % st.count) + 1;
          st.mode = "SLOT";
        }
      } else if (inp.wasPressed("b")) {
        play_se(5);
        st.mode = "GROUP";
      }
    }
  },

  // Lua: easy_chat.lua:611
  draw(): void {
    if (!EasyChat.openFlag) return;
    const st = EasyChat._state;
    if (!st) return;

    // 1. Main Background (Authentic Light Teal / Soft Sea Green #73C5A4 from text_input_frame_orange.pal)
    G.setColor(115 / 255, 197 / 255, 164 / 255, 1);
    G.rectangle("fill", 0, 0, Display.W, Display.H);

    // Subtle background grid pattern
    G.setColor(98 / 255, 180 / 255, 148 / 255, 0.4);
    for (let gx = 0; gx <= Display.W; gx += 16) {
      G.line(gx, 0, gx, Display.H);
    }
    for (let gy = 0; gy <= Display.H; gy += 16) {
      G.line(0, gy, Display.W, gy);
    }

    // 2. Top Header Ribbon (Centered blue header box: tilemapLeft=7, top=0, width=16, height=2 -> x=56, y=2, w=128, h=16)
    const headerW = 128, headerH = 16;
    const headerX = 56;
    const headerY = 2;
    // Outer shadow & border
    G.setColor(24 / 255, 61 / 255, 130 / 255, 1);
    G.rectangle("fill", headerX - 1, headerY, headerW + 2, headerH, 3, 3);
    // Blue fill
    G.setColor(57 / 255, 138 / 255, 230 / 255, 1);
    G.rectangle("fill", headerX, headerY + 1, headerW, headerH - 2, 2, 2);

    // Title Text centered in header with title_text.pal colors (cyan 57, 205, 255 with purple-white 172, 172, 238)
    // Centred like the cart, but never started left of the ribbon: the longest
    // English title fills 118 of the header's 128 px, so a longer translation
    // would otherwise spill out of the blue fill on both sides.
    const titleW = FrlgFont.measure(st.title);
    const titleX = headerX + Math.max(0, Math.floor((headerW - titleW) / 2));
    FrlgFont.draw(st.title, titleX, headerY + 2, {
      colors: { fg: seq(1, 1, 1, 1) as number[], shadow: seq(24 / 255, 61 / 255, 130 / 255, 1) as number[], bg: seq(0, 0, 0, 0) as number[] },
    });

    // 3. Top Phrase Frame Box (pret sPhraseFrameDimensions[0]: tile x=2, y=3, w=26, h=6 -> pixel x=16, y=24, w=208, h=48)
    let [pX, pY, pW, pH] = [16, 24, 208, 48];
    if (st.frame) {
      const f = st.frame;
      [pX, pY, pW, pH] = [(f.left - 1) * 8, (f.top - 1) * 8, (f.width + 2) * 8, (f.height + 2) * 8];
    }
    drawOrangeFrame(pX, pY, pW, pH);

    // Draw the 4 slots inside the phrase frame (pret easy_chat_3.c: PrintECFields & ECInterfaceCmd_02)
    // Column 0: x = 41 (cursor at 31)
    // Column 1: x = 136 (cursor at 126)
    // Row 0: y = 34 (cursor at 37)
    // Row 1: y = 50 (cursor at 53)
    let slotPositions: LuaTable = seq(
      { x: 41, y: 34, cursorX: 31, cursorY: 37 },
      { x: 136, y: 34, cursorX: 126, cursorY: 37 },
      { x: 41, y: 50, cursorX: 31, cursorY: 53 },
      { x: 136, y: 50, cursorX: 126, cursorY: 53 },
    );

    if (st.frame) {
      // pokeemerald/src/easy_chat.c:4051
      const f = st.frame;
      slotPositions = seq();
      for (let i = 1; i <= st.count; i++) {
        const [c, r] = [(i - 1) % st.cols, Math.floor((i - 1) / st.cols)];
        const x = f.left * 8 + 17 + c * 104;
        const y = f.top * 8 + 1 + r * 16;
        slotPositions[i] = { x, y, cursorX: x - 10, cursorY: y + 3 };
      }
    }
    for (let i = 1; i <= st.count; i++) {
      const s = slotPositions[i];
      const wid = st.words[i];
      const isSelected = (st.mode === "SLOT" && st.selectedSlot === i);

      // Slot cursor (red bouncing triangle)
      if (isSelected) {
        drawTriangleCursor(s.cursorX, s.cursorY, st.animTimer);
      }

      if (wid == null || wid === EasyChatText.EC_WORD_UNDEFINED) {
        // 7 Red underscores matching pret CHAR_EXTRA_SYMBOL + CHAR_UNDERSCORE (7 glyphs in FONT_NORMAL_COPY_1)
        FrlgFont.draw("_______", s.x, s.y, { colors: FrlgFont.COLOR.RED });
      } else {
        const wText = EasyChatText.word(wid);
        if (wText && wText !== "") {
          FrlgFont.draw(wText, s.x, s.y, { maxWidth: st.frame ? 96 : slotWidth(i, s.x), colors: FrlgFont.COLOR.NORMAL });
        } else {
          FrlgFont.draw("_______", s.x, s.y, { colors: FrlgFont.COLOR.RED });
        }
      }
    }

    // 4. Middle Action Footer (DEL. ALL at x=32, CANCEL at x=119, OK at x=196 at y=88, cursor at y=91)
    const [footerLabels, footerXs] = EasyChat.footerLabels();
    for (const [i, label] of ipairs<string>(footerLabels)) {
      FrlgFont.draw(label, FOOTER_X + footerXs[i], 88, { colors: FrlgFont.COLOR.NORMAL });
    }
    for (const [i, btn] of ipairs<{ cursorX: number }>(FOOTER_BTNS)) {
      const isCur = (st.mode === "FOOTER" && st.footerIdx === i);
      if (isCur) {
        drawTriangleCursor(btn.cursorX, 91, st.animTimer);
      }
    }

    // 5. Bottom Workspace or Instruction Box
    if (st.mode === "SLOT" || st.mode === "FOOTER" || st.mode === "CONFIRM" || st.mode === "CANCEL_CONFIRM" || st.mode === "DEL_ALL_CONFIRM") {
      // Instruction Dialog Frame (pret sEasyChatWindowTemplates[1] with border: x=8, y=106, w=224, h=46)
      const dX = 8, dY = 106, dW = 224, dH = 46;
      drawDialogFrame(dX, dY, dW, dH);

      if (st.mode === "CONFIRM") {
        FrlgFont.draw(st.confirm1, dX + 8, dY + 6, { colors: FrlgFont.COLOR.NORMAL });
        FrlgFont.draw(st.confirm2, dX + 8, dY + 22, { colors: FrlgFont.COLOR.NORMAL });
      } else if (st.mode === "CANCEL_CONFIRM") {
        // src/easy_chat_2.c:1242
        FrlgFont.draw(RomText.plain("gText_QuitEditing"), dX + 8, dY + 6, { colors: FrlgFont.COLOR.NORMAL });
      } else if (st.mode === "DEL_ALL_CONFIRM") {
        // src/easy_chat_2.c:1251
        FrlgFont.draw(RomText.plain("gText_AllTextBeingEditedWill"), dX + 8, dY + 6, { colors: FrlgFont.COLOR.NORMAL });
        FrlgFont.draw(RomText.plain("gText_BeDeletedThatOkay"), dX + 8, dY + 22, { colors: FrlgFont.COLOR.NORMAL });
      } else {
        // Standard instructions
        FrlgFont.draw(st.instr1, dX + 8, dY + 6, { colors: FrlgFont.COLOR.NORMAL });
        FrlgFont.draw(st.instr2, dX + 8, dY + 22, { colors: FrlgFont.COLOR.NORMAL });
      }

      // YES / NO Menu for confirm states (pret sEasyChatYesNoWindowTemplate: x=184, y=64, w=48, h=38)
      if (st.mode === "CONFIRM" || st.mode === "CANCEL_CONFIRM" || st.mode === "DEL_ALL_CONFIRM") {
        const ynX = 184, ynY = 64, ynW = 48, ynH = 38;
        drawDialogFrame(ynX, ynY, ynW, ynH);
        // YES
        if (st.confirmChoice === 1) {
          drawTriangleCursor(ynX + 4, ynY + 8, st.animTimer);
        }
        FrlgFont.draw(RomText.plain("gText_Yes"), ynX + 16, ynY + 5, { colors: FrlgFont.COLOR.NORMAL });
        // NO
        if (st.confirmChoice === 2) {
          drawTriangleCursor(ynX + 4, ynY + 22, st.animTimer);
        }
        FrlgFont.draw(RomText.plain("gText_No"), ynX + 16, ynY + 19, { colors: FrlgFont.COLOR.NORMAL });
      }

    // Group Selection Sub-window (pret sEasyChatWindowTemplates[2]: x=8, y=76, w=224, h=78)
    } else if (st.mode === "GROUP") {
      const gX = 8, gY = 76, gW = 224, gH = 78;
      drawOrangeFrame(gX, gY, gW, gH);

      // pokefirered/src/easy_chat_3.c:1569
      const numG = len(st.groups);
      const curRow = Math.floor((st.groupCursor - 1) / 2);
      let startRow = Math.max(0, curRow - 1);
      if (startRow + 3 > Math.ceil(numG / 2)) {
        startRow = Math.max(0, Math.ceil(numG / 2) - 3);
      }

      // Scroll indicators
      if (startRow > 0) {
        drawScrollArrow(gX + 112, gY + 8, true);
      }
      if (startRow + 3 < Math.ceil(numG / 2)) {
        drawScrollArrow(gX + 112, gY + gH - 8, false);
      }

      for (let r = 0; r <= 2; r++) {
        const rowIdx = startRow + r;
        const yPos = gY + 18 + r * 16;
        for (let c = 0; c <= 1; c++) {
          const gIdx = rowIdx * 2 + c + 1;
          if (gIdx <= numG) {
            const grp = st.groups[gIdx];
            const xPos = (c === 0) ? (gX + 18) : (gX + 120);
            const isCur = (st.groupCursor === gIdx);

            if (isCur) {
              // Red selection rectangle outline around active group (pret rectangle_cursor)
              G.setColor(224 / 255, 32 / 255, 32 / 255, 1);
              G.rectangle("line", xPos - 12, yPos - 1, 92, 14, 2, 2);
              drawTriangleCursor(xPos - 10, yPos + 3, st.animTimer);
              FrlgFont.draw(EasyChatText.groupName(grp), xPos, yPos, { maxWidth: GROUP_CELL_WIDTH, colors: FrlgFont.COLOR.NORMAL });
            } else {
              FrlgFont.draw(EasyChatText.groupName(grp), xPos, yPos, { maxWidth: GROUP_CELL_WIDTH, colors: FrlgFont.COLOR.NORMAL });
            }
          }
        }
      }

    // Word Selection Sub-window (pret sEasyChatWindowTemplates[2]: x=8, y=76, w=224, h=78)
    } else if (st.mode === "WORD") {
      const wX = 8, wY = 76, wW = 224, wH = 78;
      drawOrangeFrame(wX, wY, wW, wH);

      const curGroup = st.groups[st.groupCursor];
      const wordsList: LuaTable = (curGroup && curGroup.words) || seq();
      const totalWords = len(wordsList);
      const pageSize = 8;
      const maxPages = Math.max(1, Math.ceil(totalWords / pageSize));
      const pageOffset = st.wordPage * pageSize;

      // pokefirered/src/easy_chat_3.c:1649 PrintECRowsWin2
      // Scroll indicators
      if (st.wordPage > 0) {
        drawScrollArrow(wX + 112, wY + 8, true);
      }
      if (st.wordPage < maxPages - 1) {
        drawScrollArrow(wX + 112, wY + wH - 8, false);
      }

      // Four rows of two, the way the cart pages this list: easy_chat_2.c
      // scrolls selectWordRowsAbove by 4, and easy_chat_3.c's PrintECRowsWin2
      // prints row * 16 + 96 for each of them.  The navigation below already
      // moves through four rows (row < 3) and the page holds eight words, so
      // drawing three left the last two of every page selectable but invisible.
      // The first row starts 2 px higher than it used to so the fourth one's
      // 14 px of glyphs stay inside the 78 px frame.
      for (let r = 0; r <= 3; r++) {
        const yPos = wY + 16 + r * 16;
        for (let c = 0; c <= 1; c++) {
          const idxOnPage = r * 2 + c + 1;
          const wIdx = pageOffset + idxOnPage;
          if (wIdx <= totalWords) {
            const wEntry = wordsList[wIdx];
            const xPos = (c === 0) ? (wX + 18) : (wX + 120);
            const isCur = (st.wordCursor === idxOnPage);

            if (isCur) {
              // Red selection outline
              G.setColor(224 / 255, 32 / 255, 32 / 255, 1);
              G.rectangle("line", xPos - 12, yPos - 1, 92, 14, 2, 2);
              drawTriangleCursor(xPos - 10, yPos + 3, st.animTimer);
              FrlgFont.draw(EasyChatText.wordInGroup(wEntry, curGroup), xPos, yPos, { maxWidth: CELL_WIDTH, colors: FrlgFont.COLOR.NORMAL });
            } else {
              FrlgFont.draw(EasyChatText.wordInGroup(wEntry, curGroup), xPos, yPos, { maxWidth: CELL_WIDTH, colors: FrlgFont.COLOR.NORMAL });
            }
          }
        }
      }
    }

    G.setColor(1, 1, 1, 1);
  },
};

export default EasyChat;
