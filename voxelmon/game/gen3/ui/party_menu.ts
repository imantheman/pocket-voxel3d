// Port of gen1recomp src/ui/game3/party_menu.lua (GPLv3 + additional terms; see LICENSE.md).
// Party menu — pret PARTY_LAYOUT_SINGLE (windows + FONT_SMALL + OAM sprites).

/* eslint-disable @typescript-eslint/no-explicit-any */
import { format, mod, rep, tonumber, tostring, truthy } from "../../../import/gen3/lua.ts";
import { Extract } from "../../../import/gen3/extract_island1.ts";
import { MapSectionsExtract } from "../../../import/gen3/map_sections_extract.ts";
import { G } from "../platform/graphics.ts";
import { newImageData, type Image, type Quad } from "../platform/image.ts";
import { luaLoad } from "../platform/luadata.ts";
import { Timer } from "../platform/timer.ts";
import { insert, ipairs, len, pairs, remove, seq, type LuaTable } from "../platform/lt.ts";
import { NotPortedError } from "../notported.ts";
import { Stack } from "./stack.ts";
import { Chrome } from "./chrome.ts";
import { Window } from "./window.ts";
import { FrlgFont, type FontOpts } from "./frlg_font.ts";
import { PartyChrome } from "./party_chrome.ts";
import { SummaryMenu } from "./summary_menu.ts";
import { BagMenu } from "./bag_menu.ts";
import { EvolutionScene } from "./evolution_scene.ts";
import { StartMenu } from "./start_menu.ts";
import { Pokemon } from "../core/pokemon.ts";
import { Display } from "../core/display.ts";
import { Oam, type Sprite } from "../core/oam.ts";
import { ItemUse } from "../core/item_use.ts";
import { ItemsData } from "../core/items_data.ts";
import { Bag } from "../core/bag.ts";
import { Strings } from "../shared/core/Strings.ts";
import { RomText } from "../core/rom_text.ts";
import { TextIR } from "../core/scripting/text_ir.ts";
import { Profile } from "../core/profile.ts";
import { Runtime } from "../core/runtime.ts";
import { Audio } from "../core/audio.ts";
import { SE } from "../core/se_ids.ts";
import { Dataset } from "../core/dataset.ts";
import { Mail } from "../core/mail.ts";
import { SummaryData } from "../core/summary_data.ts";
import { Evolution } from "../core/evolution.ts";
import { MoveLearn } from "../core/move_learn.ts";
import { R as QuestLogRecorder } from "../core/quest_log_recorder.ts";
import { LearnMove } from "../core/battle/learn_move.ts";
import { Oak } from "../core/battle/oak_advice.ts";
import { Ui as BattleUi } from "../core/battle/ui.ts";
import { Battle } from "../core/battle.ts";
import { FieldMoves } from "../core/field_moves.ts";
import { Player } from "../core/player.ts";
import { Collision } from "../core/collision.ts";
import { Objects } from "../core/objects.ts";
import { Map as G3Map } from "../core/map.ts";
import { Field } from "../core/field.ts";
import { Space } from "../core/scripting/space.ts";

/** What PartyMenu.handleInput reads (shared/core/Input, or a scripted press). */
export interface PartyInput {
  wasPressed(key: string): boolean;
  isDown?(key?: string): boolean;
}

type Cb = (() => void) | null | undefined;

export interface PartyMenuModule {
  isMenu: boolean;
  open: boolean;
  cursor: number;
  /** "list" | "action" | "item_action" | "switch" | "summary" | "use" | "give" | "message" | ... */
  mode: string;
  actionCursor: number;
  itemActionCursor: number;
  switchFrom: number | null;
  summaryPage: number;
  ACTIONS: LuaTable;
  ITEM_ACTIONS: LuaTable;
  _oam: LuaTable | null; // per-slot { mon, ball, status } sprite ids
  _summaryIcon: number | null;
  _messageText: string | null;
  _onMessageDismiss: Cb;
  _item: any;
  _bag: any;
  _holdIcons: { image: Image; quads: Record<number, Quad>; w: number; h: number } | null;
  _yesNoPrompt: string | null;
  _yesNoCallback: ((yes: boolean) => void) | null;
  _yesNoCursor: number;
  _forgetPrompt: string | null;
  _forgetMoves: LuaTable | null;
  _forgetCallback: ((idx: number | null) => void) | null;
  _forgetCursor: number;
  _hpAnim: { slot: number; current: number; target: number; maxHp: number; speed: number; onDone: Cb } | null;
  POKEDUDE_PLANS: Record<string, LuaTable>;
  // state set by show() and friends
  _session: any;
  _party: LuaTable | null;
  _overlay: LuaTable | null;
  _giveSource: any;
  _activeSlot: number;
  _layout: string;
  _multi: LuaTable | null;
  _minigameEligible: ((slot: number, mon: any) => any) | null | undefined;
  _battle: any;
  _chooseMax: number | null;
  _chooseOrder: LuaTable | null;
  _chooseEligible: any;
  _tutor: number | null | undefined;
  _tutorResult: boolean | null;
  _tutorAutoSlot: number | null;
  _previousMode: string | null;
  _onClose: Cb;
  _onSelect: ((...a: any[]) => any) | null | undefined;
  _validate: ((slot: any) => any) | null | undefined;
  _lastSelectedSlot: number;
  _order: LuaTable | null;
  _flyReturn: { party: LuaTable | null; session: any; slot: number } | null;
  _pokedude: any;
  _fieldMoveNames: Record<string, boolean> | null;
  _softboiledDonorSlot: number | null;
  _statGrowthMon: any;
  _statGrowthOld: any;
  _statGrowthNew: any;
  _statGrowthPage: number;
  _statGrowthDone: Cb;
  _oakPages: LuaTable | null;
  _oakPage: number | null;
  _oakWrapped: string | null;
  _oakFx: { phase: string; y: number; slot: number; counter: number } | null;
  _oakReturn: string | null;

  itemIsEvolutionStone(item: any): boolean;
  showStatGrowth(mon: any, oldStats: any, newStats: any, onDone: Cb): void;
  heldItemSheet(): PartyMenuModule["_holdIcons"];
  heldItemFrame(mon: any): number | null;
  battleOrder(st: any): LuaTable;
  show(sessionParty?: LuaTable | null, moveOverlay?: any, opts?: any): void;
  returnFromFlyMap(): boolean;
  close(): void;
  movesFor(slot: number): LuaTable;
  isOpen(): boolean;
  chosenOrder(): LuaTable;
  dismissMessage(): void;
  showMessage(text: unknown, onDismiss?: Cb): void;
  showYesNo(promptText: string, cb: ((yes: boolean) => void) | null): void;
  showForgetPrompt(promptText: string, moveNames: LuaTable, cb: ((idx: number | null) => void) | null): void;
  pickPpMove(mon: any, item: any, cb: (moveSlot: number) => void): void;
  multiActions(slot: number): LuaTable;
  enterChosenMon(slot: number): boolean;
  removeChosenMon(slot: number): void;
  confirmChosenMons(): boolean;
  askCancelChooseMons(): void;
  reloadSprites(): void;
  startHpAnim(slot: number, startHp: number, targetHp: number, maxHp: number, onDone: Cb): void;
  update(dt?: number): void;
  isPokedude(): boolean;
  showPokedude(party: LuaTable | null, opts?: any): void;
  handleInput(input: PartyInput): void;
  slotDescription(slot: number): string | null;
  draw(): void;
}

// Lua: party_menu.lua:19
export const PartyMenu = { isMenu: true } as PartyMenuModule;

PartyMenu.open = false;
PartyMenu.cursor = 1;
PartyMenu.mode = "list"; // "list" | "action" | "item_action" | "switch" | "summary" | "use" | "give" | "message"
PartyMenu.actionCursor = 1;
PartyMenu.itemActionCursor = 1;
PartyMenu.switchFrom = null;
PartyMenu.summaryPage = 1;
PartyMenu.ACTIONS = seq("SUMMARY", "SWITCH", "ITEM", "CANCEL");
PartyMenu.ITEM_ACTIONS = seq("GIVE", "TAKE", "CANCEL");
PartyMenu._oam = null; // per-slot { mon, ball, status } sprite ids
PartyMenu._summaryIcon = null;
PartyMenu._messageText = null;
PartyMenu._onMessageDismiss = null;
PartyMenu._item = null;
PartyMenu._bag = null;

// pokefirered/src/data/party_menu.h:1059
const CURSOR_OPTION: Record<string, number> = {
  SUMMARY: 0, SWITCH: 1, CANCEL: 2, ITEM: 3, GIVE: 4, TAKE: 5,
  SHIFT: 10, "SEND OUT": 11, ENTER: 12, "NO ENTRY": 13, STORE: 14,
};
const CURSOR_OPTION_FIELD_MOVES = 18;
// pokefirered/src/data/party_menu.h:1158
const FIELD_MOVES = seq(
  "FLASH", "CUT", "FLY", "STRENGTH", "SURF", "ROCK_SMASH", "WATERFALL", "TELEPORT",
  "DIG", "MILK_DRINK", "SOFTBOILED", "SWEET_SCENT",
);
const FIELD_MOVE_INDEX: Record<string, number> = {};
// name:gsub("_", " ") -- a plain one-char replace, done with JS (own literals only).
for (const [j, name] of ipairs<string>(FIELD_MOVES)) FIELD_MOVE_INDEX[name.replace(/_/g, " ")] = j - 1;

// pokefirered/src/data/party_menu.h:634
const DESC_FRLG: Record<string, number> = {
  NO_USE: 0, ABLE_3: 1, FIRST: 2, SECOND: 3, THIRD: 4, ABLE: 5,
  NOT_ABLE: 6, ABLE_2: 7, NOT_ABLE_2: 8, LEARNED: 9,
};

// pokeemerald/include/constants/party_menu.h:115
const DESC_EMERALD: Record<string, number> = {
  NO_USE: 0, ABLE_3: 1, FIRST: 2, SECOND: 3, THIRD: 4, FOURTH: 5,
  ABLE: 6, NOT_ABLE: 7, ABLE_2: 8, NOT_ABLE_2: 9, LEARNED: 10,
};

// Lua: party_menu.lua:59 (local DESC = DESC_FRLG; unused)

// Lua: party_menu.lua:61
function currentSession(): any {
  // package.loaded["src.core.game3.runtime"]: always loaded here.
  return PartyMenu._session || (Runtime && Runtime.getSession && Runtime.getSession());
}

// Lua: party_menu.lua:65
function isRse(): boolean {
  // pcall(require, "src.core.game3.profile"): the module is always there.
  const session = currentSession();
  return Profile.family(session) === "rse";
}

// Lua: party_menu.lua:71
function partyUi(): any {
  // pcall(require, "src.core.game3.profile"): the module is always there.
  const row = Profile.forSession(currentSession());
  return row && typeof row.ui === "object" && row.ui != null ? (row.ui.party ?? null) : null;
}

// pokeemerald/src/data/party_menu.h:745
// Lua: party_menu.lua:78
function gameFieldMoves(): { labels: LuaTable; base: number; index: Record<string, number>; byMove: Record<number, string> } | null {
  const p = partyUi();
  if (!(p && p.manifest)) return null;
  // NOT FAITHFUL: Emerald only (require("src.ui.game3.rse.scene_kit") is not
  // ported; FireRed's profile row has no ui.party.manifest, so this is never reached).
  throw new Error("NOT FAITHFUL: Emerald only (rse.scene_kit manifest)");
}

// Lua: party_menu.lua:95
function fieldMoveIndex(): Record<string, number> {
  const g = gameFieldMoves();
  return g ? g.index : FIELD_MOVE_INDEX;
}

// Lua: party_menu.lua:100
function pikePartyRestrictions(): boolean {
  if (Profile.family(currentSession()) !== "rse") return false;
  // NOT FAITHFUL: Emerald only (require("src.core.game3.rse.frontier.pike") is not ported).
  throw new Error("NOT FAITHFUL: Emerald only (rse.frontier.pike)");
}

// Lua: party_menu.lua:106
function cursor_option_text(act: string): string {
  const g = gameFieldMoves();
  if (g) {
    const fm = g.index[act];
    if (fm != null) return g.labels[g.base + fm + 1];
    const c = CURSOR_OPTION[act];
    if (c == null) throw new Error(act);
    return g.labels[c + 1];
  }
  const fm = FIELD_MOVE_INDEX[act];
  if (fm != null) return RomText.at("sCursorOptions", CURSOR_OPTION_FIELD_MOVES + fm);
  const c = CURSOR_OPTION[act];
  if (c == null) throw new Error(act);
  return RomText.at("sCursorOptions", c);
}

// Lua: party_menu.lua:118
const FR_INSETS = { msgX: 2, msgY: 2, actX: 9, actY: 2, cursorX: 1 };
// Lua: party_menu.lua:119
function textInsets(): typeof FR_INSETS {
  const p = partyUi();
  return (p && p.insets) || FR_INSETS;
}

// Lua: party_menu.lua:124
function partyText(key: string, fallback?: any): any {
  const p = partyUi();
  const v = p && p.text ? p.text[key] : null;
  return truthy(v) ? v : fallback;
}

// Lua: party_menu.lua:129
function desc_text(id: string): string {
  const tbl = isRse() ? DESC_EMERALD : DESC_FRLG;
  const idx = tbl[id] ?? DESC_FRLG[id]!;
  return RomText.at("sDescriptionStringTable", idx);
}

// Lua: party_menu.lua:135
function se(id: unknown): void {
  try { Audio.playSe(SE.resolve(id)); } catch { /* pcall */ }
}

// pokefirered/src/item_use.c:614
// Lua: party_menu.lua:140
function mapHeaderFlag(mapDef: any, key: string): boolean {
  if (mapDef == null) return false;
  return (tonumber(mapDef[key]) ?? 0) !== 0;
}

// pokefirered/include/constants/items.h:97
// Lua: party_menu.lua:146
PartyMenu.itemIsEvolutionStone = function (item: any): boolean {
  if (item == null || ItemsData.isTm(item)) return false;
  return ItemsData.fieldUseKind(item) === "evo";
};
// Lua: party_menu.lua:150
const is_evolution_stone = PartyMenu.itemIsEvolutionStone;

// Lua: party_menu.lua:152
function nav_up(cur: number, n: number): number {
  if (cur === 1) {
    return 7;
  } else if (cur === 7) {
    return n;
  } else {
    return cur - 1;
  }
}

// Lua: party_menu.lua:162
function nav_down(cur: number, n: number): number {
  if (cur === 7) {
    return 1;
  } else if (cur === n) {
    return 7;
  } else {
    return cur + 1;
  }
}

// Lua: party_menu.lua:172
function nav_left(cur: number, _n: number, lastSlot: number): [number, number] {
  if (cur !== 1 && cur !== 7) {
    return [1, cur];
  }
  return [cur, lastSlot];
}

// Lua: party_menu.lua:179
function nav_right(cur: number, n: number, lastSlot: number | null | undefined): [number, number | null | undefined] {
  if (cur === 1 && n > 1) {
    let target = lastSlot ?? 2;
    if (target < 2) target = 2;
    if (target > n) target = n;
    return [target, lastSlot];
  }
  return [cur, lastSlot];
}

// pokefirered/src/party_menu.c:86
const SLOT_CONFIRM = 7;
const SLOT_CANCEL_MULTI = 8;

// pokefirered/src/party_menu.c:1359 UpdatePartySelectionSingleLayout
// Lua: party_menu.lua:194
function multi_nav_up(cur: number, n: number): number {
  if (cur === 1) {
    return SLOT_CANCEL_MULTI;
  } else if (cur === SLOT_CONFIRM) {
    return n;
  } else if (cur === SLOT_CANCEL_MULTI) {
    return SLOT_CONFIRM;
  } else {
    return cur - 1;
  }
}

// Lua: party_menu.lua:206
function multi_nav_down(cur: number, n: number): number {
  if (cur === SLOT_CANCEL_MULTI) {
    return 1;
  } else if (cur === n) {
    return SLOT_CONFIRM;
  } else {
    return cur + 1;
  }
}

// Lua: party_menu.lua:216
function multi_nav_left(cur: number, lastSlot: number): [number, number] {
  if (cur !== 1 && cur !== SLOT_CONFIRM && cur !== SLOT_CANCEL_MULTI) {
    return [1, cur];
  }
  return [cur, lastSlot];
}

interface MonStatsView { maxHp: number; atk: number; def: number; spa: number; spd: number; spe: number }

// Lua: party_menu.lua:223
function get_mon_stats(mon: any): MonStatsView {
  return {
    maxHp: tonumber(mon ? (mon.maxHp ?? mon.maxhp) : null) ?? 1,
    atk: tonumber(mon ? (mon.attack ?? mon.atk) : null) ?? 1,
    def: tonumber(mon ? (mon.defense ?? mon.def) : null) ?? 1,
    spa: tonumber(mon ? (mon.spAtk ?? mon.spa ?? mon.spatk) : null) ?? 1,
    spd: tonumber(mon ? (mon.spDef ?? mon.spd ?? mon.spdef) : null) ?? 1,
    spe: tonumber(mon ? (mon.speed ?? mon.spe) : null) ?? 1,
  };
}

// Lua: party_menu.lua:234
PartyMenu.showStatGrowth = function (mon: any, oldStats: any, newStats: any, onDone: Cb): void {
  PartyMenu._statGrowthMon = mon;
  PartyMenu._statGrowthOld = oldStats;
  PartyMenu._statGrowthNew = newStats;
  PartyMenu._statGrowthPage = 1;
  PartyMenu._statGrowthDone = onDone;
  PartyMenu.mode = "stat_growth";
};

interface SlotWin { left: number; top: number; w: number; h: number; kind: string }

// pret sSinglePartyMenuWindowTemplate
const SLOT_WIN: (SlotWin | null)[] = seq(
  { left: 1, top: 3, w: 10, h: 7, kind: "main" },
  { left: 12, top: 1, w: 18, h: 3, kind: "wide" },
  { left: 12, top: 4, w: 18, h: 3, kind: "wide" },
  { left: 12, top: 7, w: 18, h: 3, kind: "wide" },
  { left: 12, top: 10, w: 18, h: 3, kind: "wide" },
  { left: 12, top: 13, w: 18, h: 3, kind: "wide" },
);

// pret sPartyMenuSpriteCoords[PARTY_LAYOUT_SINGLE]
// monX, monY, itemX, itemY, statusX, statusY, ballX, ballY  (CENTER coords)
const SLOT_SPRITES: LuaTable = seq(
  seq(16, 40, 20, 50, 56, 52, 16, 34),
  seq(104, 18, 108, 28, 144, 27, 102, 25),
  seq(104, 42, 108, 52, 144, 51, 102, 49),
  seq(104, 66, 108, 76, 144, 75, 102, 73),
  seq(104, 90, 108, 100, 144, 99, 102, 97),
  seq(104, 114, 108, 124, 144, 123, 102, 121),
);

type InfoRects = Record<"nick" | "level" | "gender" | "hp" | "hpMax" | "hpBar" | "desc", number[]>;

// pret sPartyBoxInfoRects — x,y relative to window
const INFO_LEFT: InfoRects = {
  nick: seq(24, 11) as number[], level: seq(32, 20) as number[], gender: seq(64, 20) as number[],
  hp: seq(38, 36) as number[], hpMax: seq(53, 36) as number[], hpBar: seq(24, 35) as number[],
  desc: seq(12, 34) as number[],
};
const INFO_RIGHT: InfoRects = {
  nick: seq(22, 3) as number[], level: seq(32, 12) as number[], gender: seq(64, 12) as number[],
  hp: seq(102, 12) as number[], hpMax: seq(117, 12) as number[], hpBar: seq(88, 10) as number[],
  desc: seq(77, 4) as number[],
};

// pokefirered/src/data/party_menu.h:192
const SLOT_WIN_DOUBLE: (SlotWin | null)[] = seq(
  { left: 1, top: 1, w: 10, h: 7, kind: "main" },
  { left: 1, top: 8, w: 10, h: 7, kind: "main" },
  { left: 12, top: 1, w: 18, h: 3, kind: "wide" },
  { left: 12, top: 5, w: 18, h: 3, kind: "wide" },
  { left: 12, top: 9, w: 18, h: 3, kind: "wide" },
  { left: 12, top: 13, w: 18, h: 3, kind: "wide" },
);

// pokefirered/src/data/party_menu.h:81
const SLOT_SPRITES_DOUBLE: LuaTable = seq(
  seq(16, 24, 20, 34, 56, 36, 16, 18),
  seq(16, 80, 20, 90, 56, 92, 16, 74),
  seq(104, 18, 108, 28, 144, 27, 102, 25),
  seq(104, 50, 108, 60, 144, 59, 102, 57),
  seq(104, 82, 108, 92, 144, 91, 102, 89),
  seq(104, 114, 108, 124, 144, 123, 102, 121),
);

// Lua: party_menu.lua:296
function is_double(): boolean {
  return PartyMenu._layout === "double";
}

// Lua: party_menu.lua:300
function slot_win(i: number): SlotWin | null | undefined {
  return (is_double() ? SLOT_WIN_DOUBLE : SLOT_WIN)[i];
}

// Lua: party_menu.lua:304
function slot_sprites(i: number): number[] | null | undefined {
  return (is_double() ? SLOT_SPRITES_DOUBLE : SLOT_SPRITES)[i];
}

// pokefirered/src/party_menu.c:735
// Lua: party_menu.lua:309
function slot_info(i: number): InfoRects {
  if (i === 1 || (i === 2 && is_double())) return INFO_LEFT;
  return INFO_RIGHT;
}

// Lua: party_menu.lua:314
function slot_filled(i: number): boolean {
  const mon = PartyMenu._party ? PartyMenu._party[i] : null;
  return mon != null && (tonumber(mon.species ?? mon.speciesId) ?? 1) !== 0;
}

// pokefirered/src/party_menu.c:1499
// Lua: party_menu.lua:320
function double_next_slot(slot: number, dir: number): number | null {
  for (;;) {
    slot = slot + dir;
    if (slot < 1 || slot > 6) return null;
    if (slot_filled(slot)) return slot;
  }
}

// pokefirered/src/party_menu.c:1402
// Lua: party_menu.lua:329
function nav_double(cur: number, dir: string): number {
  const last = PartyMenu._lastSelectedSlot;
  if (dir === "up") {
    if (cur === 1) return 7;
    let from = cur;
    if (cur === 7) from = 7;
    return double_next_slot(from, -1) ?? cur;
  } else if (dir === "down") {
    if (cur === 7) return 1;
    return double_next_slot(cur, 1) ?? 7;
  } else if (dir === "right") {
    if (cur === 1) {
      if (last === 4) {
        if (slot_filled(4)) return 4;
      } else if (slot_filled(3)) {
        return 3;
      }
    } else if (cur === 2) {
      if (last === 6) {
        if (slot_filled(6)) return 6;
      } else if (slot_filled(5)) {
        return 5;
      }
    }
    return cur;
  } else if (dir === "left") {
    if (cur === 3 || cur === 4) {
      PartyMenu._lastSelectedSlot = cur;
      return 1;
    } else if (cur === 5 || cur === 6) {
      PartyMenu._lastSelectedSlot = cur;
      return 2;
    }
  }
  return cur;
}

// Lua: party_menu.lua:366
function battle_nav_double(input: PartyInput): void {
  const oldCur = PartyMenu.cursor;
  for (const [, dir] of ipairs<string>(seq("up", "down", "left", "right"))) {
    if (input.wasPressed(dir)) {
      PartyMenu.cursor = nav_double(PartyMenu.cursor, dir);
      break;
    }
  }
  if (PartyMenu.cursor !== oldCur) se("SE_SELECT");
}

// pokefirered/src/party_menu.c:5905
// Lua: party_menu.lua:378
function open_battle_actions_double(prevMode: string): void {
  const mon = PartyMenu._party ? PartyMenu._party[PartyMenu.cursor] : null;
  se("SE_SELECT");
  if (!slot_filled(2) || (mon && mon.isEgg)) {
    PartyMenu.ACTIONS = seq("SUMMARY", "CANCEL");
  } else if (prevMode === "battle_faint") {
    PartyMenu.ACTIONS = seq("SEND OUT", "SUMMARY", "CANCEL");
  } else {
    PartyMenu.ACTIONS = seq("SHIFT", "SUMMARY", "CANCEL");
  }
  PartyMenu._previousMode = prevMode;
  PartyMenu.mode = "action";
  PartyMenu.actionCursor = 1;
}

// Lua: party_menu.lua:393
function party_print(text: unknown, px: number, py: number, maxW?: number): void {
  FrlgFont.draw(tostring(text ?? ""), px, py, {
    maxWidth: maxW ?? 56,
    colors: FrlgFont.COLOR.PARTY,
    small: true,
  });
}

// Lua: party_menu.lua:401
function right_align_3(nIn: unknown): string {
  let n = Math.floor(tonumber(nIn) ?? 0);
  if (n < 0) n = 0;
  if (n > 999) n = 999;
  if (isRse()) {
    // pokeemerald/src/string_util.c:209 ConvertIntToDecimalStringN
    const digits = tostring(n);
    return rep("{UNK_SPACER}", 3 - digits.length) + digits;
  }
  return format("%3d", n);
}

// Lua: party_menu.lua:413
function destroy_id(id: unknown): void {
  if (id != null) Oam.destroySprite(id);
}

// Lua: party_menu.lua:417
function destroy_party_oam(): void {
  const slots = PartyMenu._oam;
  if (slots) {
    for (let i = 1; i <= 6; i++) {
      const s = slots[i];
      if (s) {
        destroy_id(s.mon);
        destroy_id(s.ball);
        destroy_id(s.status);
        destroy_id(s.item);
      }
    }
  }
  destroy_id(PartyMenu._summaryIcon);
  PartyMenu._oam = null;
  PartyMenu._summaryIcon = null;
}

const SUB_STATUS = 0;
const SUB_ITEM = 0;
const SUB_BALL = 4;
const SUB_MON = 8;

const HOLD_ICONS_SUB = "/pokemon/party/";

// Lua: party_menu.lua:442
function read_cache(rel: string): string | null {
  let okR = true;
  let d: unknown;
  try { d = Dataset.cache().read(rel); } catch { okR = false; }
  if (okR && typeof d === "string" && d.length > 0) return d;
  return null;
}

PartyMenu._holdIcons = null;

// pokefirered/src/party_menu.c:2779
// Lua: party_menu.lua:452
PartyMenu.heldItemSheet = function () {
  if (PartyMenu._holdIcons) return PartyMenu._holdIcons;
  // (love.graphics.newImage always exists here)
  const root = (Extract.CACHE_ROOT || "data/generated/gba") + HOLD_ICONS_SUB;
  const src = read_cache(root + "manifest.lua");
  const chunk = src ? luaLoad(src, "@party/manifest.lua")[0] : null;
  let okM = false;
  let man: any = null;
  if (chunk) {
    try { man = chunk(); okM = true; } catch (e) { okM = false; man = e; }
  }
  const w = okM && typeof man === "object" && man != null ? tonumber(man.holdIconW) : undefined;
  const h = w != null ? tonumber(man.holdIconSheetH) : undefined;
  const frames = h != null ? tonumber(man.holdIconFrames) : undefined;
  const rgba = frames != null ? read_cache(root + "hold_icons.rgba") : null;
  if (!(rgba && rgba.length >= w! * h! * 4)) {
    throw new Error("party_menu: pokemon/party/hold_icons.rgba is not in the cache");
  }
  const image = G.newImage(newImageData(w!, h!, "rgba8", rgba));
  image.setFilter("nearest", "nearest");
  const fh = Math.floor(h! / frames!);
  const quads: Record<number, Quad> = {};
  for (let f = 0; f <= frames! - 1; f++) {
    quads[f] = G.newQuad(0, f * fh, w!, fh, w!, h!);
  }
  PartyMenu._holdIcons = { image, quads, w: w!, h: fh };
  return PartyMenu._holdIcons;
};

// pokefirered/src/party_menu.c:2763
// Lua: party_menu.lua:480
PartyMenu.heldItemFrame = function (mon: any): number | null {
  const raw = mon ? (mon.item ?? mon.heldItem) : null;
  const item = tonumber(raw) ?? (raw != null ? tonumber(ItemsData.toNumericId(raw)) : null) ?? 0;
  if (item === 0) return null;
  return Mail.isMailItem(item) ? 1 : 0;
};

const MON_ICON_ANIM_DELAYS: Record<number, number> = {
  0: 6, // HP_BAR_FULL (100% HP)
  1: 8, // HP_BAR_GREEN (>50% HP)
  2: 14, // HP_BAR_YELLOW (>20% HP)
  3: 22, // HP_BAR_RED (>0% HP)
  4: 0, // HP_BAR_EMPTY (0 HP / fainted: still)
};

const MON_ICON_ANIM_DURATIONS: Record<number, number> = {
  0: 6 / 60, // HP_BAR_FULL (100% HP): 6 frames = 0.100s
  1: 8 / 60, // HP_BAR_GREEN (>50% HP): 8 frames = 0.1333s
  2: 14 / 60, // HP_BAR_YELLOW (>20% HP): 14 frames = 0.2333s
  3: 22 / 60, // HP_BAR_RED (>0% HP): 22 frames = 0.3667s
  4: 0, // HP_BAR_EMPTY (0 HP / fainted: still)
};

// Lua: party_menu.lua:503
function get_hp_bar_level(hpIn: unknown, maxHpIn: unknown, isEgg: unknown): number {
  if (truthy(isEgg)) return 4;
  const hp = tonumber(hpIn) ?? 0;
  let maxHp = tonumber(maxHpIn) ?? 1;
  if (maxHp < 1) maxHp = 1;
  if (hp >= maxHp) return 0;
  if (hp > maxHp * 0.5) return 1;
  if (hp > maxHp * 0.2) return 2;
  if (hp > 0) return 3;
  return 4;
}

// Lua: party_menu.lua:515
function idle_mon_offset(slotIndex: number): [number, number] {
  const spr = slot_sprites(slotIndex);
  if (spr && spr[1] === 16) {
    return [0, -4];
  }
  return [-4, 0];
}

// Lua: party_menu.lua:523
function advance_sprite_anim(sprite: Sprite): number {
  const animNum = sprite.data[3] ?? 0;
  const duration = MON_ICON_ANIM_DURATIONS[animNum] ?? (8 / 60);
  if (duration <= 0) {
    sprite.data[2] = 0;
    return 0;
  }

  if (Timer && Timer.getTime) {
    const now = Timer.getTime();
    const last = sprite._lastAnimTime ?? now;
    let dt = now - last;
    sprite._lastAnimTime = now;
    if (dt < 0) dt = 0; else if (dt > 0.1) dt = 0.1;
    sprite._animElapsed = (sprite._animElapsed ?? 0) + dt;
    while (sprite._animElapsed >= duration) {
      sprite._animElapsed = sprite._animElapsed - duration;
      sprite.data[2] = 1 - (sprite.data[2] ?? 0);
    }
  } else {
    const delay = MON_ICON_ANIM_DELAYS[animNum] ?? 8;
    sprite.data[1] = (sprite.data[1] ?? 0) + 1;
    if (sprite.data[1]! >= delay) {
      sprite.data[1] = 0;
      sprite.data[2] = 1 - (sprite.data[2] ?? 0);
    }
  }

  return sprite.data[2] ?? 0;
}

// Lua: party_menu.lua:554
function SpriteCB_BouncePartyMonIcon(sprite: Sprite): void {
  const f = advance_sprite_anim(sprite);
  sprite.x2 = 0;
  if ((sprite.data[3] ?? 0) === 4) {
    sprite.y2 = 0;
  } else if (f === 0) {
    sprite.y2 = -3;
  } else {
    sprite.y2 = 1;
  }
  if (sprite._quads && sprite._quads[f]) {
    sprite.quad = sprite._quads[f];
  }
}

// Lua: party_menu.lua:569
function SpriteCB_UpdatePartyMonIcon(sprite: Sprite): void {
  const f = advance_sprite_anim(sprite);
  const slotIdx = sprite.data[4] ?? 1;
  const [x2, y2] = idle_mon_offset(slotIdx);
  sprite.x2 = x2;
  sprite.y2 = y2;
  if (sprite._quads && sprite._quads[f]) {
    sprite.quad = sprite._quads[f];
  }
}

// Lua: party_menu.lua:580
function ensure_slot_sprites(i: number, mon: any, selected: boolean): void {
  PartyMenu._oam = PartyMenu._oam || seq();
  let slot = PartyMenu._oam![i];
  if (!slot) {
    slot = {};
    PartyMenu._oam![i] = slot;
  }
  const spr = slot_sprites(i);
  if (!spr || !mon) {
    destroy_id(slot.mon); slot.mon = null;
    destroy_id(slot.ball); slot.ball = null;
    destroy_id(slot.status); slot.status = null;
    destroy_id(slot.item); slot.item = null;
    return;
  }

  const mx = spr[1]!, my = spr[2]!;
  const bx = spr[7]!, by = spr[8]!;
  const sx = spr[5]!, sy = spr[6]!;

  const hp = tonumber(mon.hp) ?? 0;
  const maxHp = tonumber(mon.maxHp) ?? tonumber(mon.maxhp) ?? 1;
  const hpLevel = get_hp_bar_level(hp, maxHp, mon.isEgg);

  const icon = Pokemon.monIcon(mon);
  const q0 = icon && icon.quads ? icon.quads[0] : null;
  if (!slot.mon) {
    const id = Oam.createSprite({
      dims: Oam.SQUARE_32,
      priority: 1,
      image: icon ? icon.image : null,
      quad: q0,
      animPaused: true,
    }, mx, my, SUB_MON)[0];
    slot.mon = id;
  } else {
    Oam.setPos(slot.mon, mx, my);
    const ms = Oam.get(slot.mon);
    if (ms) {
      ms.image = icon ? icon.image : null;
      ms.subpriority = SUB_MON;
    }
  }
  if (slot.mon) {
    const s = Oam.get(slot.mon);
    if (s) {
      s._quads = icon ? icon.quads : null;
      s.data[3] = hpLevel;
      s.data[4] = i;
    }
    if (selected) {
      Oam.setCallback(slot.mon, SpriteCB_BouncePartyMonIcon);
      if (!slot._wasSelected) {
        if (s) {
          s.data[1] = 0;
          s.x2 = 0;
          s.y2 = ((s.data[2] ?? 0) === 1 ? 1 : -3);
        }
      }
      slot._wasSelected = true;
    } else {
      Oam.setCallback(slot.mon, SpriteCB_UpdatePartyMonIcon);
      if (slot._wasSelected) {
        if (s) {
          s.data[1] = 0;
          const [x2, y2] = idle_mon_offset(i);
          s.x2 = x2;
          s.y2 = y2;
        }
      }
      slot._wasSelected = false;
    }
    Oam.setInvisible(slot.mon, PartyMenu.mode === "summary");
  }

  // pokefirered/src/party_menu.c:2743
  const holdFrame = PartyMenu.heldItemFrame(mon);
  const hold = holdFrame != null ? PartyMenu.heldItemSheet() : null;
  if (hold) {
    const hq = hold.quads[holdFrame!];
    if (!slot.item) {
      slot.item = Oam.createSprite({
        dims: Oam.SQUARE_8,
        priority: 1,
        image: hold.image,
        quad: hq,
      }, spr[3], spr[4], SUB_ITEM)[0];
    } else {
      Oam.setPos(slot.item, spr[3], spr[4]);
      Oam.setImage(slot.item, hold.image, hq);
    }
    if (slot.item) {
      Oam.setInvisible(slot.item, PartyMenu.mode === "summary");
    }
  } else {
    destroy_id(slot.item);
    slot.item = null;
  }

  const balls = PartyChrome.ballEntry();
  const ballFrame = selected ? 1 : 0;
  const bq = balls && balls.quads ? balls.quads[ballFrame] : null;
  if (!slot.ball) {
    const id = Oam.createSprite({
      dims: Oam.SQUARE_32,
      priority: 1,
      image: balls ? balls.image : null,
      quad: bq,
    }, bx, by, SUB_BALL)[0];
    slot.ball = id;
  } else {
    Oam.setPos(slot.ball, bx, by);
    if (balls && balls.image) Oam.setImage(slot.ball, balls.image, bq);
    const bs = Oam.get(slot.ball);
    if (bs) bs.subpriority = SUB_BALL;
  }
  if (slot.ball) {
    Oam.setOffset(slot.ball, 0, 0);
    Oam.setInvisible(slot.ball, PartyMenu.mode === "summary");
  }

  const statusFr = SummaryData.statusAilment(mon);
  const [stImg, stQ] = PartyChrome.statusEntry(statusFr);
  if (statusFr > 0 && statusFr !== 6 && stImg) {
    if (!slot.status) {
      const id = Oam.createSprite({
        dims: Oam.HRECT_32x8,
        priority: 1,
        image: stImg,
        quad: stQ,
      }, sx, sy, SUB_STATUS)[0];
      slot.status = id;
    } else {
      Oam.setPos(slot.status, sx, sy);
      Oam.setImage(slot.status, stImg, stQ);
      const ss = Oam.get(slot.status);
      if (ss) ss.subpriority = SUB_STATUS;
    }
    if (slot.status) {
      Oam.setInvisible(slot.status, PartyMenu.mode === "summary");
    }
  } else {
    destroy_id(slot.status);
    slot.status = null;
  }
}

// Lua: party_menu.lua:726
function sync_all_oam(): void {
  const party = PartyMenu._party ?? seq();
  for (let i = 1; i <= 6; i++) {
    const mon = party[i];
    const selected = (i === PartyMenu.cursor || PartyMenu.switchFrom === i);
    ensure_slot_sprites(i, mon, selected);
  }
}

const FLUSHED_CLIP = { x: 0, y: 0, w: 0, h: 0 };

// Lua: party_menu.lua:737
function each_party_sprite(fn: (s: Sprite) => void): void {
  for (const [, slot] of pairs<any>(PartyMenu._oam ?? {})) {
    for (const [, key] of ipairs<string>(seq("mon", "ball", "status", "item"))) {
      const s = slot[key] != null ? Oam.get(slot[key]) : null;
      if (s) fn(s);
    }
  }
}

// Lua: party_menu.lua:746
function unflush_party_sprites(): void {
  each_party_sprite((s) => {
    if (s.clip === FLUSHED_CLIP) s.clip = null;
  });
}

// pokefirered/src/data/party_menu.h:1
// Lua: party_menu.lua:753
function flush_party_sprites(): void {
  const mine = new Set<Sprite>();
  each_party_sprite((s) => { mine.add(s); });
  for (const [, s] of ipairs<Sprite>(Oam.buildOamBuffer())) {
    if (mine.has(s) && s.clip !== FLUSHED_CLIP) {
      Oam.flushOne(s);
      s.clip = FLUSHED_CLIP;
    }
  }
}

// pokefirered/src/party_menu.c:6005
// Lua: party_menu.lua:765
PartyMenu.battleOrder = function (st: any): LuaTable {
  const party = (st && st.playerParty) || {};
  let n = 0;
  for (let i = 1; i <= 6; i++) if (party[i]) n = i;
  let order = st._partyOrder;
  let valid = typeof order === "object" && order != null && len(order) === n;
  if (valid) {
    const seen: Record<number, boolean> = {};
    for (let i = 1; i <= n; i++) {
      const v = order[i];
      if (typeof v !== "number" || v < 1 || v > n || seen[v]) { valid = false; break; }
      seen[v] = true;
    }
  }
  const b0 = (st.battlers && st.battlers[0]) || st.player;
  const b2 = st.double && st.battlers ? st.battlers[2] : null;
  if (!valid) {
    order = seq();
    const used: Record<number, boolean> = {};
    // { b0, b2 } with a nil b2 is { b0 }; ipairs stops at the first nil
    for (const [, b] of ipairs<any>(seq(b0, b2))) {
      const pi = b ? tonumber(b.partyIndex) : undefined;
      if (pi != null && pi >= 1 && pi <= n && !used[pi]) {
        order[len(order) + 1] = pi;
        used[pi] = true;
      }
    }
    for (let i = 1; i <= n; i++) {
      if (!used[i]) order[len(order) + 1] = i;
    }
    st._partyOrder = order;
  }
  // pokefirered/src/party_menu.c:5972
  for (const [pos, b] of ipairs<any>(seq(b0, b2))) {
    const want = b ? tonumber(b.partyIndex) : undefined;
    if (want != null && order[pos] !== want) {
      for (let j = 1; j <= n; j++) {
        if (order[j] === want) {
          const t = order[pos];
          order[pos] = order[j];
          order[j] = t;
          break;
        }
      }
    }
  }
  return order;
};

// pokefirered/src/party_menu.c:6199
// Lua: party_menu.lua:812
function apply_battle_order(party: LuaTable, overlay: any, opts: any): [LuaTable, any, any] {
  let order = opts.battleOrder;
  if (order == null) {
    // package.loaded["src.core.game3.battle"]: always loaded here.
    const st = Battle ? Battle._st : null;
    if (!(st && st.playerParty && st.playerParty === party)) return [party, overlay, opts];
    order = PartyMenu.battleOrder(st);
  }
  const view: LuaTable = seq();
  for (const [i, pi] of ipairs<number>(order)) view[i] = party[pi];
  let viewOverlay = overlay;
  if (typeof overlay === "object" && overlay != null) {
    viewOverlay = seq();
    for (const [i, pi] of ipairs<number>(order)) viewOverlay[i] = overlay[pi];
  }
  const o: any = {};
  for (const [k, v] of pairs(opts)) o[k] = v;
  const active = opts.activeSlot;
  for (const [i, pi] of ipairs<number>(order)) {
    if (pi === active) { o.activeSlot = i; break; }
  }
  const onSelect = opts.onSelect, validate = opts.validate;
  if (onSelect) {
    o.onSelect = (d: any, mon: any) => onSelect(d != null && d !== false ? order[d] : d, mon);
  }
  if (validate) {
    o.validate = (d: any) => validate(d != null && d !== false ? order[d] : d);
  }
  PartyMenu._order = order;
  return [view, viewOverlay, o];
}

// pokefirered/src/party_menu.c:1944
const OAK_DIM_TARGET = 6;
const OAK_DIM_DELAY = 4;
// Built on first use: it reads Chrome / FrlgFont fields, which module order
// cannot guarantee at load time (Brian's Lua builds it at require time).
let OAK_TEXT_OPTS_cache: FontOpts | null = null;
function OAK_TEXT_OPTS(): FontOpts {
  if (!OAK_TEXT_OPTS_cache) {
    OAK_TEXT_OPTS_cache = { maxWidth: Chrome.DLG_W * 8, linePitch: 15, colors: FrlgFont.COLOR.NORMAL };
  }
  return OAK_TEXT_OPTS_cache;
}

// Lua: party_menu.lua:849
function set_oak_page(page: number): void {
  PartyMenu._oakPage = page;
  const text = (PartyMenu._oakPages ?? seq())[page];
  PartyMenu._oakWrapped = text != null ? FrlgFont.wrap(text, Chrome.DLG_W * 8) : null;
}

// Lua: party_menu.lua:855
function end_oak_advice(): void {
  PartyMenu._oakPages = null;
  PartyMenu._oakWrapped = null;
  PartyMenu._oakFx = null;
  PartyMenu.mode = PartyMenu._oakReturn ?? "list";
  PartyMenu._oakReturn = null;
}

// Lua: party_menu.lua:863
function oak_ramp(fx: any, key: string, target: number): boolean {
  if (fx[key] === target) return true;
  fx.counter = fx.counter + 1;
  if (fx.counter > OAK_DIM_DELAY) {
    fx.counter = 0;
    fx[key] = fx[key] + ((fx[key] < target) ? 1 : -1);
  }
  return fx[key] === target;
}

// Lua: party_menu.lua:873
function tick_oak_advice(): void {
  const fx = PartyMenu._oakFx;
  if (!fx) return;
  if (fx.phase === "darken") {
    if (oak_ramp(fx, "y", OAK_DIM_TARGET)) fx.phase = "text";
  } else if (fx.phase === "lighten") {
    // pokefirered/src/party_menu.c:1970
    if (oak_ramp(fx, "slot", 0)) {
      fx.phase = "text";
      set_oak_page((PartyMenu._oakPage ?? 1) + 1);
    }
  } else if (fx.phase === "normal") {
    // pokefirered/src/party_menu.c:2001
    fx.slot = Math.min(fx.slot, fx.y);
    if (oak_ramp(fx, "y", 0)) end_oak_advice();
  }
}

// pokefirered/src/party_menu.c:5832
// Lua: party_menu.lua:892
function begin_oak_advice(opts: any): void {
  PartyMenu._oakPages = null;
  PartyMenu._oakPage = 1;
  PartyMenu._oakReturn = null;
  PartyMenu._oakWrapped = null;
  PartyMenu._oakFx = null;
  if (!(opts && opts.battle)) return;
  // package.loaded["src.core.game3.battle.ui"]: always loaded here (a stub's
  // _st is undefined, the not-in-battle path).
  const st = BattleUi ? BattleUi._st : null;
  if (!st) return;
  // pcall(require, "src.core.game3.battle.oak_advice"): the module is always there.
  const pages = Oak.take(st, Oak.FLAG_PARTY_MENU, "partyMenu");
  if (!pages) return;
  PartyMenu._oakPages = pages;
  PartyMenu._oakReturn = PartyMenu.mode;
  PartyMenu.mode = "oak";
  PartyMenu._oakFx = { phase: "darken", y: 0, slot: OAK_DIM_TARGET, counter: 0 };
  set_oak_page(1);
}

// Lua: party_menu.lua:913
PartyMenu.show = function (sessionParty?: LuaTable | null, moveOverlay?: any, opts?: any): void {
  if (typeof moveOverlay === "object" && moveOverlay != null && opts == null
    && (moveOverlay.mode || moveOverlay.session || moveOverlay.battle || moveOverlay.onSelect || moveOverlay.activeSlot)) {
    opts = moveOverlay;
    moveOverlay = null;
  }
  opts = opts || {};
  PartyMenu._order = null;
  if (opts.mode === "battle_switch" || opts.mode === "battle_faint" || (opts.mode === "use" && opts.battleOrder)) {
    const party0 = sessionParty || (opts.session && opts.session.party);
    const ov0 = moveOverlay || (opts.session && (opts.session.move_overlay || opts.session.moveOverlay));
    if (party0) {
      [sessionParty, moveOverlay, opts] = apply_battle_order(party0, ov0, opts);
    }
  }
  destroy_party_oam();
  PartyMenu.open = true;
  PartyMenu._flyReturn = null;
  PartyMenu._party = sessionParty || (opts.session && opts.session.party) || null;
  PartyMenu._overlay = moveOverlay || (opts.session && (opts.session.move_overlay || opts.session.moveOverlay)) || null;
  PartyMenu._session = opts.session;
  PartyMenu._bag = opts.bag || (opts.session && (opts.session.bag || opts.session.inventory));
  PartyMenu._item = opts.item;
  PartyMenu._giveSource = opts.giveSource;
  PartyMenu._activeSlot = opts.activeSlot ?? 1;
  PartyMenu._layout = (opts.layout === "double") ? "double" : "single";
  PartyMenu._multi = typeof opts.multi === "object" && opts.multi != null ? opts.multi : null;
  PartyMenu._minigameEligible = opts.minigameEligible;
  PartyMenu._battle = opts.battle || (opts.mode === "battle_switch" || opts.mode === "battle_faint");
  PartyMenu.cursor = 1;
  PartyMenu.mode = opts.mode ?? "list";
  // pokefirered/src/party_menu.c:5651 InitChooseMonsForBattle
  PartyMenu._chooseMax = null;
  PartyMenu._chooseOrder = null;
  PartyMenu._chooseEligible = null;
  const wantCount = tonumber(opts.count) ?? 0;
  if (opts.mode === "choose_multi" || (opts.mode === "choose" && wantCount > 1)) {
    PartyMenu.mode = "choose_multi";
    PartyMenu._chooseMax = (wantCount > 0) ? wantCount : 3;
    PartyMenu._chooseOrder = seq();
    PartyMenu._chooseEligible = opts.eligible;
  }
  // pokefirered/src/party_menu.c:5793 ChooseMonForMoveTutor
  PartyMenu._tutor = null;
  PartyMenu._tutorResult = null;
  PartyMenu._tutorAutoSlot = null;
  if (PartyMenu.mode === "move_tutor") {
    PartyMenu._tutor = tonumber(opts.tutor);
    PartyMenu._tutorResult = false;
    const auto = tonumber(opts.autoSlot);
    if (auto != null && auto >= 1) {
      PartyMenu.cursor = auto;
      PartyMenu._tutorAutoSlot = auto;
    }
  }
  PartyMenu._previousMode = PartyMenu.mode;
  PartyMenu.summaryPage = 1;
  PartyMenu.switchFrom = null;
  PartyMenu._onClose = opts.onClose;
  PartyMenu._onSelect = opts.onSelect;
  PartyMenu._validate = opts.validate;
  PartyMenu._messageText = null;
  PartyMenu._onMessageDismiss = null;
  PartyMenu.actionCursor = 1;
  PartyMenu.itemActionCursor = 1;
  PartyMenu._lastSelectedSlot = 1;
  if (!Pokemon._names) Pokemon.install(null);
  PartyChrome.install(null);
  begin_oak_advice(opts);
  Stack.push("party", PartyMenu, { hideBelow: true, fullscreen: true });
  sync_all_oam();
};

// pokefirered/src/region_map.c:4019
// Lua: party_menu.lua:986
PartyMenu.returnFromFlyMap = function (): boolean {
  const ret = PartyMenu._flyReturn;
  PartyMenu._flyReturn = null;
  if (!ret || PartyMenu.open) return false;
  PartyMenu.show(ret.party, null, { session: ret.session });
  PartyMenu.cursor = ret.slot ?? 1;
  return true;
};

// Lua: party_menu.lua:995
PartyMenu.close = function (): void {
  PartyMenu.open = false;
  PartyMenu.mode = "list";
  PartyMenu._pokedude = null;
  destroy_party_oam();
  Stack.pop("party");
  const cb = PartyMenu._onClose;
  PartyMenu._onClose = null;
  if (cb) cb();
};

// Lua: party_menu.lua:1006
PartyMenu.movesFor = function (slot: number): LuaTable {
  const mon = PartyMenu._party ? PartyMenu._party[slot] : null;
  if (!mon) return seq();
  const moves: LuaTable = seq();
  const ov = PartyMenu._overlay ? PartyMenu._overlay[slot] : null;
  for (let i = 1; i <= 4; i++) {
    const o = ov ? ov[i] : null;
    if (o && o.frlgMoveId) {
      moves[i] = { id: o.frlgMoveId, pp: o.pp, quarantined: true };
    } else {
      const rawM = mon.moves ? mon.moves[i] : null;
      const isTbl = typeof rawM === "object" && rawM != null;
      let mid = rawM;
      if (isTbl) {
        const v = rawM.id ?? rawM.move ?? rawM.num ?? rawM.moveId ?? rawM.name ?? rawM[1];
        mid = truthy(v) ? v : rawM;
      }
      let mpp: any;
      if (isTbl) {
        const v = rawM.pp ?? (mon.pp ? mon.pp[i] : null);
        mpp = truthy(v) ? v : (mon.pp ? mon.pp[i] : null);
      } else {
        mpp = mon.pp ? mon.pp[i] : null;
      }
      moves[i] = {
        id: mid,
        pp: mpp,
        quarantined: false,
      };
    }
  }
  return moves;
};

// Lua: party_menu.lua:1029
PartyMenu.isOpen = function (): boolean {
  return PartyMenu.open;
};

// Lua: party_menu.lua:1033
function party_count(): number {
  return len(PartyMenu._party ?? seq());
}

// pokefirered/src/evolution_scene.c:640 EVOSTATE_CANCEL
// Lua: party_menu.lua:1038
function level_evolution_target(mon: any, session: any): [number | null, boolean] {
  const target = Evolution.levelTarget(mon, session)[0];
  if (target) return [target, false];
  const raw = Evolution.targetSpecies(mon, Evolution.EVO_MODE_NORMAL)[0];
  if (raw && raw !== 0 && !Evolution.nationalAllows(raw, session)) {
    return [raw, true];
  }
  return [null, false];
}

// pokefirered/src/party_menu.c:5674 GetBattleEntryEligibility
// Lua: party_menu.lua:1050
function entry_eligible(slot: number): boolean {
  const mon = PartyMenu._party ? PartyMenu._party[slot] : null;
  if (!mon || mon.isEgg) return false;
  const rule = PartyMenu._chooseEligible;
  if (typeof rule === "function") {
    return truthy(rule(slot, mon)) ? true : false;
  } else if (typeof rule === "object" && rule != null) {
    for (const [, s] of ipairs<any>(rule)) {
      if ((tonumber(s) ?? -1) + 1 === slot) return true;
    }
    return false;
  }
  return (tonumber(mon.hp) ?? 0) > 0;
}

// pokefirered/src/party_menu.c:5736 HasPartySlotAlreadyBeenSelected
// Lua: party_menu.lua:1066
function order_index(slot: number): number | null {
  for (const [i, s] of ipairs<number>(PartyMenu._chooseOrder ?? seq())) {
    if (s === slot) return i;
  }
  return null;
}

// pokefirered/src/party_menu.c:413 gSelectedOrderFromParty
// Lua: party_menu.lua:1074
PartyMenu.chosenOrder = function (): LuaTable {
  const out: LuaTable = seq();
  for (const [i, s] of ipairs<number>(PartyMenu._chooseOrder ?? seq())) out[i] = s;
  return out;
};

// Lua: party_menu.lua:1080
function swap_slots(a: number, b: number): void {
  if (!PartyMenu._party || a === b) return;
  if (!PartyMenu._battle) {
    QuestLogRecorder.event(PartyMenu._session, "SwitchMon1WithMon2",
      seq(Pokemon.displayMonName(PartyMenu._party[a]), Pokemon.displayMonName(PartyMenu._party[b])));
  }
  const t = PartyMenu._party[a];
  PartyMenu._party[a] = PartyMenu._party[b];
  PartyMenu._party[b] = t;
  if (PartyMenu._overlay) {
    const o = PartyMenu._overlay[a];
    PartyMenu._overlay[a] = PartyMenu._overlay[b];
    PartyMenu._overlay[b] = o;
  }
}

// Lua: party_menu.lua:1094
PartyMenu.dismissMessage = function (): void {
  if (PartyMenu.mode === "message") {
    const cb = PartyMenu._onMessageDismiss;
    PartyMenu._messageText = null;
    PartyMenu._onMessageDismiss = null;
    PartyMenu.mode = "list";
    if (cb) {
      cb();
    }
  }
};

// Lua: party_menu.lua:1106
PartyMenu.showMessage = function (text: unknown, onDismiss?: Cb): void {
  // TextIR.splitPages returns a 0-based JS array (its port's shape): pages[i - 1].
  const pages = TextIR.splitPages(tostring(text), true);
  const show = (i: number): void => {
    PartyMenu.mode = "message";
    PartyMenu._messageText = pages[i - 1] ?? null;
    if (i >= pages.length) {
      PartyMenu._onMessageDismiss = onDismiss;
    } else {
      PartyMenu._onMessageDismiss = () => { show(i + 1); };
    }
  };
  show(1);
};

// Lua: party_menu.lua:1120
function show_rom_message(key: string, vars: LuaTable | null, onDismiss: Cb): void {
  PartyMenu.showMessage(RomText.box(key, { stringVars: vars, maxWidth: 216 }), onDismiss);
}

PartyMenu._yesNoPrompt = null;
PartyMenu._yesNoCallback = null;
PartyMenu._yesNoCursor = 1;
PartyMenu._forgetPrompt = null;
PartyMenu._forgetMoves = null;
PartyMenu._forgetCallback = null;
PartyMenu._forgetCursor = 1;

// Lua: party_menu.lua:1132
PartyMenu.showYesNo = function (promptText: string, cb: ((yes: boolean) => void) | null): void {
  PartyMenu.mode = "yesno";
  PartyMenu._yesNoPrompt = promptText;
  PartyMenu._yesNoCallback = cb;
  PartyMenu._yesNoCursor = 1;
};

// Lua: party_menu.lua:1139
PartyMenu.showForgetPrompt = function (promptText: string, moveNames: LuaTable, cb: ((idx: number | null) => void) | null): void {
  PartyMenu.mode = "forget";
  PartyMenu._forgetPrompt = promptText;
  PartyMenu._forgetMoves = moveNames;
  PartyMenu._forgetCallback = cb;
  PartyMenu._forgetCursor = 1;
};

// pokefirered/src/party_menu.c:4548 ShowMoveSelectWindow
// Lua: party_menu.lua:1148
PartyMenu.pickPpMove = function (mon: any, item: any, cb: (moveSlot: number) => void): void {
  const names: LuaTable = seq(), slots: LuaTable = seq();
  for (let i = 1; i <= 4; i++) {
    const id = Pokemon.moveIdAt(mon, i);
    if (id != null && id > 0) {
      names[len(names) + 1] = Pokemon.moveName(id) || Strings("MOVE %s", id);
      slots[len(slots) + 1] = i;
    }
  }
  // pokefirered/src/strings.c:319 gText_RestoreWhichMove, :320 gText_BoostPp
  const prompt = ItemUse.ppItemBoosts(item) ? RomText.plain(partyText("boostPp", "gText_BoostPp"))
    : RomText.plain("gText_RestoreWhichMove");
  PartyMenu.showForgetPrompt(prompt, names, (idx) => {
    if (idx == null) {
      // pokefirered/src/party_menu.c:4628 ReturnToUseOnWhichMon
      PartyMenu.mode = "use";
      return;
    }
    cb(slots[idx + 1]);
  });
};

// pokefirered/src/party_menu.c:4841 Task_LearnNextMoveOrClosePartyMenu
// Lua: party_menu.lua:1171
function tutor_learned(moveLearned: unknown): void {
  if (truthy(moveLearned)) PartyMenu._tutorResult = true;
}

/** The askYesNo hook every LearnMove caller here passes (Lua: four copies). */
function learn_ask_yes_no(a: any, b: any): void {
  const cb = (typeof a === "function") ? a : b;
  const prompt = (typeof a === "string") ? a : (PartyMenu._messageText ?? "");
  PartyMenu.showYesNo(prompt, (yes) => {
    if (cb) cb(yes === true);
  });
}

// pokefirered/src/party_menu.c:5391 TryTutorSelectedMon
// Lua: party_menu.lua:1176
function try_tutor_selected_mon(slot: number): void {
  const mon = PartyMenu._party ? PartyMenu._party[slot] : null;
  const tutor = PartyMenu._tutor;
  const moveId = tutor != null ? MoveLearn.tutorMove(tutor) : undefined;
  if (!mon || !moveId) {
    PartyMenu.close();
    return;
  }
  const monName = Pokemon.displayMonName(mon);
  const moveName = Pokemon.moveName(moveId) || "";
  const status = MoveLearn.canMonLearnTutorMove(mon, tutor);
  if (status === MoveLearn.CANNOT_LEARN_MOVE || status === MoveLearn.CANNOT_LEARN_MOVE_IS_EGG) {
    // pokefirered/src/party_menu.c:5407
    show_rom_message("gText_PkmnCantLearnMove", seq(monName, moveName), () => {
      PartyMenu.close();
    });
    return;
  }
  if (status === MoveLearn.ALREADY_KNOWS_MOVE) {
    // pokefirered/src/party_menu.c:5410
    show_rom_message("gText_PkmnAlreadyKnows", seq(monName, moveName), () => {
      PartyMenu.close();
    });
    return;
  }
  if (Pokemon.moveSlotCount(mon) < 4) {
    if (Pokemon.teachMove(mon, moveId)[0]) {
      try { Audio.playFanfare("MUS_LEVEL_UP"); } catch { /* pcall */ }
      // pokefirered/src/party_menu.c:4817
      show_rom_message("gText_PkmnLearnedMove3", seq(monName, moveName), () => {
        tutor_learned(true);
        PartyMenu.close();
      });
    } else {
      PartyMenu.close();
    }
    return;
  }
  LearnMove.begin({
    mon,
    moveId,
    displayName: monName,
    pushMsg: (t: any, cb: Cb) => { PartyMenu.showMessage(t, cb); },
    askYesNo: learn_ask_yes_no,
    askForget: (_a: any, b: any, c: any) => {
      const cb = (typeof b === "function") ? b : c;
      destroy_party_oam();
      SummaryMenu.openMenu(PartyMenu._party, slot, {
        mode: "select_move",
        moveToLearn: moveId,
        onSelectMove: (slotIdx: any) => {
          sync_all_oam();
          if (cb) cb(slotIdx);
        },
      });
    },
    onDone: (learned: any) => {
      tutor_learned(learned);
      PartyMenu.close();
    },
  });
}

// pokefirered/src/party_menu.c:2990 GetPartyMenuActionsType
// Lua: party_menu.lua:1249
PartyMenu.multiActions = function (slot: number): LuaTable {
  if (!entry_eligible(slot)) {
    return seq("SUMMARY", "CANCEL");
  } else if (order_index(slot) != null) {
    return seq("NO ENTRY", "SUMMARY", "CANCEL");
  }
  return seq("ENTER", "SUMMARY", "CANCEL");
};

// pokefirered/src/party_menu.c:3760 CursorCB_Enter
// Lua: party_menu.lua:1259
PartyMenu.enterChosenMon = function (slot: number): boolean {
  const order = PartyMenu._chooseOrder ?? seq();
  const max = PartyMenu._chooseMax ?? 3;
  if (len(order) >= max) {
    se("SE_FAILURE");
    // pokefirered/src/party_menu.c:3769
    let key = (max === 2) ? "gText_NoMoreThanTwoMayEnter" : "gText_NoMoreThanThreeMayEnter";
    let vars: LuaTable | null = null;
    if (isRse()) {
      // pokeemerald/src/party_menu.c:3544
      key = "gText_NoMoreThanVar1Pkmn";
      vars = seq(tostring(max));
    }
    show_rom_message(key, vars, () => { PartyMenu.mode = "choose_multi"; });
    return false;
  }
  se("SE_SELECT");
  order[len(order) + 1] = slot;
  PartyMenu.mode = "choose_multi";
  if (len(order) === max) {
    // pokefirered/src/party_menu.c:3797 MoveCursorToConfirm
    PartyMenu.cursor = SLOT_CONFIRM;
  }
  return true;
};

// pokefirered/src/party_menu.c:3804 CursorCB_NoEntry
// Lua: party_menu.lua:1285
PartyMenu.removeChosenMon = function (slot: number): void {
  se("SE_SELECT");
  const idx = order_index(slot);
  if (idx != null) remove(PartyMenu._chooseOrder, idx);
  PartyMenu.mode = "choose_multi";
};

// pokefirered/src/party_menu.c:5746 Task_ValidateChosenMonsForBattle
// Lua: party_menu.lua:1293
PartyMenu.confirmChosenMons = function (): boolean {
  const order = PartyMenu._chooseOrder ?? seq();
  if (len(order) === 0) {
    se("SE_FAILURE");
    // pokefirered/src/strings.c:322
    PartyMenu.showMessage(RomText.plain("gText_NoPokemonForBattle"), () => {
      PartyMenu.mode = "choose_multi";
    });
    return false;
  }
  se("SE_SELECT");
  const picked = PartyMenu.chosenOrder();
  const cb = PartyMenu._onSelect;
  PartyMenu.close();
  if (cb) cb(picked);
  return true;
};

// pokefirered/src/party_menu.c:1261 DisplayCancelChooseMonYesNo
// Lua: party_menu.lua:1312
PartyMenu.askCancelChooseMons = function (): void {
  se("SE_SELECT");
  // pokefirered/src/strings.c:370
  PartyMenu.showYesNo(RomText.plain("gText_CancelBattle"), (yes) => {
    if (!yes) {
      PartyMenu.mode = "choose_multi";
      return;
    }
    // pokefirered/src/party_menu.c:1285 ClearSelectedPartyOrder
    PartyMenu._chooseOrder = seq();
    const cb = PartyMenu._onSelect;
    PartyMenu.close();
    if (cb) cb(null);
  });
};

// Lua: party_menu.lua:1328
PartyMenu.reloadSprites = function (): void {
  destroy_party_oam();
  sync_all_oam();
};

PartyMenu._hpAnim = null;

// Lua: party_menu.lua:1335
PartyMenu.startHpAnim = function (slot: number, startHp: number, targetHp: number, maxHp: number, onDone: Cb): void {
  PartyMenu._hpAnim = {
    slot,
    current: startHp,
    target: targetHp,
    maxHp,
    speed: Math.max(25, Math.abs(targetHp - startHp) * 2.5),
    onDone,
  };
};

// Lua: party_menu.lua:1346
PartyMenu.update = function (dt?: number): void {
  if (PartyMenu.mode === "oak") tick_oak_advice();
  // pokefirered/src/party_menu.c:5805
  if (PartyMenu._tutorAutoSlot != null && PartyMenu.mode === "move_tutor") {
    const slot = PartyMenu._tutorAutoSlot;
    PartyMenu._tutorAutoSlot = null;
    try_tutor_selected_mon(slot);
  }
  const anim = PartyMenu._hpAnim;
  if (anim) {
    dt = dt ?? (1 / 60);
    if (anim.current < anim.target) {
      anim.current = Math.min(anim.target, anim.current + anim.speed * dt);
    } else if (anim.current > anim.target) {
      anim.current = Math.max(anim.target, anim.current - anim.speed * dt);
    }
    if (anim.current === anim.target) {
      const cb = anim.onDone;
      PartyMenu._hpAnim = null;
      if (cb) cb();
    }
  }

  // package.loaded["src.core.game3.battle.learn_move"]: imported here; while
  // it is still a stub it counts as not loaded (its busy() throws NotPortedError).
  try {
    if (LearnMove && LearnMove.busy && LearnMove.busy() && LearnMove.pump) {
      LearnMove.pump();
    }
  } catch (e) {
    if (!(e instanceof NotPortedError)) throw e;
  }
};

// Lua: party_menu.lua:1375
function pokedude_press(key: string): PartyInput {
  return { wasPressed: (k: string) => k === key, isDown: () => false };
}

// Lua: party_menu.lua:1379
PartyMenu.POKEDUDE_PLANS = {
  // pokefirered/src/party_menu.c:2028 Task_PartyMenu_PokedudeStep
  switch: seq({ at: 80, key: "right" }, { at: 160, key: "a" }, { at: 240, key: "a" }),
  // pokefirered/src/party_menu.c:2080 Task_PartyMenuFromBag_PokedudeStep
  item: seq({ at: 80, use: true }),
};

// Lua: party_menu.lua:1386
function pokedude_tick(input: PartyInput | null | undefined): void {
  const pd = PartyMenu._pokedude;
  // pokefirered/src/party_menu.c:2052 PartyMenuPokedudeIsCancelled
  if (input && input.wasPressed && input.wasPressed("b")) {
    const onCancel = pd.onCancel;
    PartyMenu.close();
    if (onCancel) onCancel();
    return;
  }
  const entry = pd.plan[pd.index];
  if (entry && pd.frames === entry.at) {
    pd.index = pd.index + 1;
    if (entry.use) {
      pd.used = true;
      const slot = (PartyMenu._order && PartyMenu._order[PartyMenu.cursor]) || PartyMenu.cursor;
      // pokefirered/src/party_menu.c:4464 ItemUseCB_MedicineStep
      const text = pd.onUse ? pd.onUse(slot) : null;
      se("SE_USE_ITEM");
      PartyMenu.reloadSprites();
      const onSelect = pd.onSelect;
      PartyMenu.showMessage(truthy(text) ? text : "", () => {
        // pokefirered/src/party_menu.c:4538 Task_ClosePartyMenuAfterText
        PartyMenu.close();
        if (onSelect) onSelect(slot);
      });
      return;
    }
    pd.feeding = true;
    PartyMenu.handleInput(pokedude_press(entry.key));
    if (PartyMenu._pokedude === pd) pd.feeding = false;
  }
  pd.frames = pd.frames + 1;
}

// Lua: party_menu.lua:1420
PartyMenu.isPokedude = function (): boolean {
  return PartyMenu._pokedude != null;
};

// pokefirered/src/party_menu.c:5859 Pokedude_OpenPartyMenuInBattle
// pokefirered/src/party_menu.c:5866 Pokedude_ChooseMonForInBattleItem
// Lua: party_menu.lua:1426
PartyMenu.showPokedude = function (party: LuaTable | null, opts?: any): void {
  opts = opts || {};
  const plan = PartyMenu.POKEDUDE_PLANS[opts.plan];
  if (!plan) throw new Error("no pokedude party plan " + tostring(opts.plan));
  const session = opts.session;
  if (opts.plan === "switch") {
    PartyMenu.show(party, null, {
      mode: "battle_switch",
      session,
      activeSlot: opts.activeSlot ?? 1,
      battle: true,
      validate: opts.validate,
      onSelect: (slot: any) => {
        if (opts.onSelect) opts.onSelect(slot);
      },
    });
  } else {
    PartyMenu.show(party, session && session.move_overlay, {
      mode: "use",
      session,
      bag: opts.bag,
      item: opts.item,
      battle: true,
      battleOrder: opts.battleOrder,
      activeSlot: opts.activeSlot ?? 1,
    });
  }
  PartyMenu._pokedude = {
    plan, index: 1, frames: 0,
    onUse: opts.onUse, onSelect: opts.onSelect, onCancel: opts.onCancel,
  };
};

// Lua: party_menu.lua:1459
PartyMenu.handleInput = function (input: PartyInput): void {
  const pdm = PartyMenu._pokedude;
  if (pdm && !pdm.used && !pdm.feeding) {
    return pokedude_tick(input);
  }
  const n = party_count();
  if (n < 1) {
    if (input.wasPressed("b") || input.wasPressed("start") || input.wasPressed("a")) {
      PartyMenu.close();
    }
    return;
  }

  // Fast-forward / complete HP animation on button press
  if (PartyMenu._hpAnim) {
    if (input.wasPressed("a") || input.wasPressed("b") || input.wasPressed("start")) {
      const anim = PartyMenu._hpAnim;
      anim.current = anim.target;
      const cb = anim.onDone;
      PartyMenu._hpAnim = null;
      if (cb) cb();
    }
    return;
  }

  if (PartyMenu.mode === "message") {
    if (input.wasPressed("a") || input.wasPressed("b") || input.wasPressed("start")) {
      se("SE_SELECT");
      PartyMenu.dismissMessage();
    }
    return;
  }

  // pokefirered/src/party_menu.c:1936
  if (PartyMenu.mode === "oak") {
    const fx = PartyMenu._oakFx;
    if (!fx) {
      end_oak_advice();
    } else if (fx.phase === "text" && (input.wasPressed("a") || input.wasPressed("b"))) {
      se("SE_SELECT");
      const page = (PartyMenu._oakPage ?? 1) + 1;
      if (page > len(PartyMenu._oakPages ?? seq())) {
        PartyMenu._oakWrapped = null;
        fx.phase = "normal";
      } else if (page === 2 && fx.slot > 0) {
        fx.phase = "lighten";
      } else {
        set_oak_page(page);
      }
    }
    return;
  }

  if (PartyMenu.mode === "yesno") {
    if (input.wasPressed("up") || input.wasPressed("down")) {
      PartyMenu._yesNoCursor = (PartyMenu._yesNoCursor === 1) ? 2 : 1;
      se("SE_SELECT");
    } else if (input.wasPressed("a")) {
      se("SE_SELECT");
      const cb = PartyMenu._yesNoCallback;
      const yes = (PartyMenu._yesNoCursor === 1);
      PartyMenu._yesNoCallback = null;
      PartyMenu._yesNoPrompt = null;
      if (cb) cb(yes);
    } else if (input.wasPressed("b")) {
      se("SE_SELECT"); // pokefirered/src/party_menu.c:5001
      const cb = PartyMenu._yesNoCallback;
      PartyMenu._yesNoCallback = null;
      PartyMenu._yesNoPrompt = null;
      if (cb) cb(false);
    }
    return;
  }

  if (PartyMenu.mode === "forget") {
    const moves = PartyMenu._forgetMoves ?? seq();
    const total = len(moves);
    if (total > 0) {
      if (input.wasPressed("up")) {
        PartyMenu._forgetCursor = mod(PartyMenu._forgetCursor - 2, total) + 1;
        se("SE_SELECT");
      } else if (input.wasPressed("down")) {
        PartyMenu._forgetCursor = mod(PartyMenu._forgetCursor, total) + 1;
        se("SE_SELECT");
      } else if (input.wasPressed("a")) {
        se("SE_SELECT");
        const cb = PartyMenu._forgetCallback;
        const idx = PartyMenu._forgetCursor;
        PartyMenu._forgetCallback = null;
        PartyMenu._forgetMoves = null;
        PartyMenu._forgetPrompt = null;
        if (cb) cb(idx - 1);
      } else if (input.wasPressed("b")) {
        se("SE_SELECT"); // pokefirered/src/party_menu.c:5001
        const cb = PartyMenu._forgetCallback;
        PartyMenu._forgetCallback = null;
        PartyMenu._forgetMoves = null;
        PartyMenu._forgetPrompt = null;
        if (cb) cb(null);
      }
    }
    return;
  }

  if (PartyMenu.mode === "summary") {
    if (!SummaryMenu.isOpen()) {
      destroy_party_oam();
      SummaryMenu.openMenu(PartyMenu._party, PartyMenu.cursor, {
        session: PartyMenu._session,
        onClose: () => {
          PartyMenu.mode = "list";
          sync_all_oam();
        },
      });
    }
    SummaryMenu.handleInput(input);
    return;
  }

  if (PartyMenu.mode === "switch") {
    const oldCur = PartyMenu.cursor;
    if (input.wasPressed("up")) {
      PartyMenu.cursor = nav_up(PartyMenu.cursor, n);
    } else if (input.wasPressed("down")) {
      PartyMenu.cursor = nav_down(PartyMenu.cursor, n);
    } else if (input.wasPressed("left")) {
      [PartyMenu.cursor, PartyMenu._lastSelectedSlot] = nav_left(PartyMenu.cursor, n, PartyMenu._lastSelectedSlot);
    } else if (input.wasPressed("right")) {
      PartyMenu.cursor = nav_right(PartyMenu.cursor, n, PartyMenu._lastSelectedSlot)[0];
    }
    if (PartyMenu.cursor !== oldCur) {
      se("SE_SELECT");
    }
    if (input.wasPressed("a")) {
      if (PartyMenu.cursor === 7) {
        se("SE_SELECT"); // pokefirered/src/party_menu.c:1246
        PartyMenu.switchFrom = null;
        PartyMenu.mode = "list";
      } else {
        se("SE_SELECT");
        swap_slots(PartyMenu.switchFrom ?? PartyMenu.cursor, PartyMenu.cursor);
        PartyMenu.switchFrom = null;
        PartyMenu.mode = "list";
      }
    } else if (input.wasPressed("b")) {
      se("SE_SELECT"); // pokefirered/src/party_menu.c:1246
      PartyMenu.switchFrom = null;
      PartyMenu.mode = "list";
    }
    return;
  }

  if (PartyMenu.mode === "item_action") {
    const actions = PartyMenu.ITEM_ACTIONS;
    if (input.wasPressed("up")) {
      PartyMenu.itemActionCursor = mod(PartyMenu.itemActionCursor - 2, len(actions)) + 1;
      se("SE_SELECT");
    } else if (input.wasPressed("down")) {
      PartyMenu.itemActionCursor = mod(PartyMenu.itemActionCursor, len(actions)) + 1;
      se("SE_SELECT");
    } else if (input.wasPressed("a")) {
      const act = actions[PartyMenu.itemActionCursor];
      if (act === "TAKE") {
        const [, , msgText] = ItemUse.takeFromMon(PartyMenu._session, PartyMenu._bag, PartyMenu.cursor);
        se("SE_SELECT"); // pokefirered/src/party_menu.c:3594
        PartyMenu.showMessage(msgText, () => {
          PartyMenu.mode = "list";
        });
      } else if (act === "GIVE") {
        // pokefirered/src/party_menu.c:3424
        BagMenu.show(PartyMenu._session, {
          bag: PartyMenu._bag,
          location: "party",
          onClose: () => {
            PartyMenu.mode = "list";
          },
        });
      } else {
        se("SE_SELECT"); // pokefirered/src/party_menu.c:3733
        PartyMenu.mode = "list";
      }
    } else if (input.wasPressed("b")) {
      se("SE_SELECT"); // pokefirered/src/party_menu.c:3083
      PartyMenu.mode = "list";
    }
    return;
  }

  if (PartyMenu.mode === "stat_growth") {
    if (input.wasPressed("a") || input.wasPressed("b") || input.wasPressed("start")) {
      if (PartyMenu._statGrowthPage === 1) {
        se("SE_SELECT");
        PartyMenu._statGrowthPage = 2;
      } else {
        se("SE_SELECT");
        PartyMenu.mode = "message";
        const cb = PartyMenu._statGrowthDone;
        PartyMenu._statGrowthDone = null;
        if (cb) cb();
      }
    }
    return;
  }

  if (PartyMenu.mode === "action") {
    const actions = PartyMenu.ACTIONS;
    if (input.wasPressed("up")) {
      PartyMenu.actionCursor = mod(PartyMenu.actionCursor - 2, len(actions)) + 1;
      se("SE_SELECT");
    } else if (input.wasPressed("down")) {
      PartyMenu.actionCursor = mod(PartyMenu.actionCursor, len(actions)) + 1;
      se("SE_SELECT");
    } else if (input.wasPressed("a")) {
      const act = actions[PartyMenu.actionCursor];
      if (act === "ENTER") {
        // pokefirered/src/party_menu.c:3760
        PartyMenu.enterChosenMon(PartyMenu.cursor);
      } else if (act === "NO ENTRY") {
        // pokefirered/src/party_menu.c:3804
        PartyMenu.removeChosenMon(PartyMenu.cursor);
      } else if (act === "SHIFT" || act === "SEND OUT" || (PartyMenu._previousMode === "battle_switch" && act === "SWITCH")) {
        se("SE_SELECT");
        const cb = PartyMenu._onSelect;
        const chosen = PartyMenu.cursor;
        const why = PartyMenu._validate ? PartyMenu._validate(chosen) : null;
        if (truthy(why)) {
          const back = PartyMenu._previousMode;
          PartyMenu.showMessage(why, () => { PartyMenu.mode = back!; });
          return;
        }
        PartyMenu.close();
        if (cb) cb(chosen, PartyMenu._party ? PartyMenu._party[chosen] : null);
      } else if (act === "SUMMARY") {
        const prevMode = PartyMenu._previousMode ?? "list";
        PartyMenu.mode = "list";
        destroy_party_oam();
        SummaryMenu.openMenu(PartyMenu._party, PartyMenu.cursor, {
          session: PartyMenu._session,
          onClose: () => {
            PartyMenu.mode = prevMode;
            sync_all_oam();
          },
        });
      } else if (act === "SWITCH") {
        se("SE_SELECT");
        PartyMenu.switchFrom = PartyMenu.cursor;
        PartyMenu.mode = "switch";
      } else if (act === "ITEM") {
        se("SE_SELECT");
        PartyMenu.mode = "item_action";
        PartyMenu.itemActionCursor = 1;
      } else if (PartyMenu._fieldMoveNames && PartyMenu._fieldMoveNames[act]) {
        const mon = PartyMenu._party ? PartyMenu._party[PartyMenu.cursor] : null;
        if (act === "SOFTBOILED" || act === "MILK DRINK") {
          const maxHp = (mon ? (mon.maxHp ?? (mon.stats ? mon.stats.hp : null)) : null) ?? 0;
          const cost = Math.floor(maxHp / 5);
          const curHp = mon ? (mon.hp ?? 0) : 0;
          if (curHp <= cost || cost <= 0) {
            se("SE_SELECT"); // pokefirered/src/party_menu.c:3910
            show_rom_message("gText_NotEnoughHp", null, () => {
              PartyMenu.mode = "list";
            });
            return;
          }
          se("SE_SELECT");
          PartyMenu._softboiledDonorSlot = PartyMenu.cursor;
          PartyMenu.mode = "softboiled";
          return;
        } else {
          // package.loaded["src.core.game3.player"] or require(...): a direct import.
          const P = Player;
          // package.loaded["src.core.game3.scripting.space"]: always loaded here.
          const DELTA: Record<string, number[]> = {
            up: seq(0, -1) as number[], down: seq(0, 1) as number[],
            left: seq(-1, 0) as number[], right: seq(1, 0) as number[],
          };
          const d = DELTA[P.facing || "down"] ?? DELTA.down!;
          const fx = P.cellX + d[1]!, fy = P.cellY + d[2]!;
          const facingObj = Objects.at(fx, fy);
          const isWater = Collision.isWater && Collision.isWater(fx, fy);
          // pokefirered/src/fldeff_cut.c:140
          const hasCuttableGrass3x3 = (px: number, py: number): boolean => {
            if (!Collision.isGrass) return false;
            // pokefirered/src/fldeff_rocksmash.c:31
            const elev = P.elevation;
            for (let y = py - 1; y <= py + 1; y++) {
              for (let x = px - 1; x <= px + 1; x++) {
                const e = Collision.elevationAt ? Collision.elevationAt(x, y) : undefined;
                if ((elev == null || e === elev) && Collision.isGrass(x, y)) return true;
              }
            }
            return false;
          };
          const mapDef = G3Map.currentDef();
          // pokefirered/src/party_menu.c:4118
          const facingBeh = Collision.behavior ? Collision.behavior(fx, fy) : undefined;
          const ctx = {
            party: PartyMenu._party,
            mon,
            store: Space ? Space.store : null,
            session: PartyMenu._session,
            facingObject: facingObj,
            isFacingWater: isWater,
            isFacingWaterfall: FieldMoves.isWaterfallBehavior(facingBeh),
            facing: P.facing,
            isSurfing: P.surfing === true,
            hasCuttableGrass: hasCuttableGrass3x3(P.cellX, P.cellY),
            mapType: mapDef ? mapDef.mapType : null,
            isCave: mapHeaderFlag(mapDef, "cave"),
            canEscapeRope: mapHeaderFlag(mapDef, "allowEscaping"),
            // pokefirered/src/field_effect.c:2126 SetWarpDestinationToEscapeWarp
            escapeWarp: PartyMenu._session ? PartyMenu._session.escapeWarp : null,
          };
          const res: any = FieldMoves.fromMenu(act, ctx);
          if (!res || !res.ok) {
            se("SE_SELECT"); // pokefirered/src/party_menu.c:3910
            PartyMenu.showMessage((res && res.text) || RomText.plain("gText_CantUseHere"), () => {
              PartyMenu.mode = "list";
            });
          } else {
            se("SE_SELECT");
            // package.loaded["src.core.game3.field"] or require(...): a direct import.
            const run = (): void => {
              // pokefirered/src/party_menu.c:3953
              let flyReturn: PartyMenuModule["_flyReturn"] = null;
              if (res.action === "fly") {
                flyReturn = {
                  party: PartyMenu._party,
                  session: PartyMenu._session,
                  slot: PartyMenu.cursor,
                };
              }
              PartyMenu.close();
              PartyMenu._flyReturn = flyReturn;
              // pokefirered/src/party_menu.c:3958
              // package.loaded["src.ui.game3.start_menu"]: always loaded here.
              if (StartMenu && StartMenu.isOpen && StartMenu.isOpen()) {
                StartMenu.close(true);
              }
              if (Field.executeFieldMove) {
                Field.executeFieldMove(res);
              }
            };
            if (res.action === "teleport" || res.action === "dig") {
              const session = PartyMenu._session || {};
              // pokefirered/src/party_menu.c:3939
              let destMap = session.healMap;
              let key = "gText_ReturnToHealingSpot";
              if (res.action === "dig") {
                // pokefirered/src/party_menu.c:3946
                destMap = session.escapeWarp ? session.escapeWarp.map : null;
                key = isRse() ? "gText_EscapeFromHere" : "gText_EscapeFromHereAndReturnTo";
              }
              const game = Field._game;
              const def = game && game.data && game.data.maps ? game.data.maps[destMap] : null;
              let placeName: string | undefined;
              if (isRse()) {
                // pokeemerald/src/party_menu.c:3741
                // NOT FAITHFUL: Emerald only (require("src.ui.game3.rse.mapsec") is not ported).
                throw new Error("NOT FAITHFUL: Emerald only (rse.mapsec)");
              } else {
                // pokefirered/src/region_map.c:3828 GetMapNameGeneric
                placeName = MapSectionsExtract.getPlaceName(destMap, def ? def.regionMapSectionId : null);
              }
              // pokefirered/src/party_menu.c:3984 DisplayFieldMoveExitAreaMessage
              PartyMenu.showYesNo(RomText.box(key, { stringVars: seq(placeName), maxWidth: 216 }), (yes) => {
                if (yes) {
                  run();
                } else {
                  // pokefirered/src/party_menu.c:4014 Task_ReturnToChooseMonAfterText
                  PartyMenu.mode = "list";
                }
              });
              return;
            }
            run();
          }
          return;
        }
      } else {
        se("SE_SELECT"); // pokefirered/src/party_menu.c:3393
        PartyMenu.mode = PartyMenu._previousMode ?? "list";
      }
    } else if (input.wasPressed("b")) {
      se("SE_SELECT"); // pokefirered/src/party_menu.c:3393
      PartyMenu.mode = PartyMenu._previousMode ?? "list";
    }
    return;
  }

  if (PartyMenu.mode === "softboiled") {
    const oldCur = PartyMenu.cursor;
    if (input.wasPressed("up")) {
      PartyMenu.cursor = nav_up(PartyMenu.cursor, n);
    } else if (input.wasPressed("down")) {
      PartyMenu.cursor = nav_down(PartyMenu.cursor, n);
    } else if (input.wasPressed("left")) {
      [PartyMenu.cursor, PartyMenu._lastSelectedSlot] = nav_left(PartyMenu.cursor, n, PartyMenu._lastSelectedSlot);
    } else if (input.wasPressed("right")) {
      PartyMenu.cursor = nav_right(PartyMenu.cursor, n, PartyMenu._lastSelectedSlot)[0];
    }
    if (PartyMenu.cursor !== oldCur) {
      se("SE_SELECT");
    }
    if (input.wasPressed("a")) {
      if (PartyMenu.cursor === 7) {
        se("SE_SELECT"); // pokefirered/src/party_menu.c:1246
        PartyMenu.mode = "list";
      } else {
        const userMon = PartyMenu._party ? PartyMenu._party[PartyMenu._softboiledDonorSlot!] : null;
        const targetMon = PartyMenu._party ? PartyMenu._party[PartyMenu.cursor] : null;
        const [ok] = FieldMoves.softboiledTransfer(userMon, targetMon);
        if (!ok) {
          se("SE_SELECT"); // pokefirered/src/party_menu.c:4490
          show_rom_message("gText_WontHaveEffect", null, () => {
            PartyMenu.mode = "softboiled";
          });
        } else {
          se("SE_BIKE_BELL");
          PartyMenu.mode = "list";
        }
      }
    } else if (input.wasPressed("b")) {
      se("SE_SELECT"); // pokefirered/src/party_menu.c:1246
      PartyMenu.mode = "list";
    }
    return;
  }

  if (PartyMenu.mode === "battle_switch" || PartyMenu.mode === "battle_faint") {
    const sendOut = PartyMenu.mode === "battle_faint";
    if (is_double()) {
      battle_nav_double(input);
    } else {
      const oldCur = PartyMenu.cursor;
      if (input.wasPressed("up")) {
        PartyMenu.cursor = nav_up(PartyMenu.cursor, n);
      } else if (input.wasPressed("down")) {
        PartyMenu.cursor = nav_down(PartyMenu.cursor, n);
      } else if (input.wasPressed("left")) {
        [PartyMenu.cursor, PartyMenu._lastSelectedSlot] = nav_left(PartyMenu.cursor, n, PartyMenu._lastSelectedSlot);
      } else if (input.wasPressed("right")) {
        PartyMenu.cursor = nav_right(PartyMenu.cursor, n, PartyMenu._lastSelectedSlot)[0];
      }
      if (PartyMenu.cursor !== oldCur) se("SE_SELECT");
    }
    const cancel = input.wasPressed("b") || (input.wasPressed("a") && PartyMenu.cursor === 7);
    if (cancel) {
      // pokefirered/src/party_menu.c:1229
      if (sendOut) {
        se("SE_FAILURE");
      } else {
        se("SE_SELECT");
        PartyMenu.close();
      }
    } else if (input.wasPressed("a")) {
      open_battle_actions_double(PartyMenu.mode);
    }
    return;
  }

  // Selection mode for item USE
  if (PartyMenu.mode === "use") {
    let oldCur = PartyMenu.cursor;
    if (is_double()) {
      battle_nav_double(input);
      oldCur = PartyMenu.cursor;
    } else if (input.wasPressed("up")) {
      PartyMenu.cursor = nav_up(PartyMenu.cursor, n);
    } else if (input.wasPressed("down")) {
      PartyMenu.cursor = nav_down(PartyMenu.cursor, n);
    } else if (input.wasPressed("left")) {
      [PartyMenu.cursor, PartyMenu._lastSelectedSlot] = nav_left(PartyMenu.cursor, n, PartyMenu._lastSelectedSlot);
    } else if (input.wasPressed("right")) {
      PartyMenu.cursor = nav_right(PartyMenu.cursor, n, PartyMenu._lastSelectedSlot)[0];
    }
    if (PartyMenu.cursor !== oldCur) {
      se("SE_SELECT");
    }
    if (input.wasPressed("a")) {
      if (PartyMenu.cursor === 7) {
        se("SE_SELECT"); // pokefirered/src/party_menu.c:1246
        if (PartyMenu._onSelect) {
          PartyMenu._onSelect(null);
        } else {
          PartyMenu.close();
        }
        return;
      }
      if (PartyMenu._onSelect) {
        PartyMenu._onSelect(PartyMenu.cursor);
        return;
      }
      const mon = PartyMenu._party ? PartyMenu._party[PartyMenu.cursor] : null;
      if (!mon) return;

      if (mon.isEgg) {
        se("SE_FAILURE"); // pokefirered/src/party_menu.c:1223
        PartyMenu.showMessage(Strings("An EGG can't be used on."), () => {
          PartyMenu.mode = "use";
        });
        return;
      }

      // Case 1: TM / HM
      if (ItemsData.isTm(PartyMenu._item)) {
        const [status, preflightMsg, moveId, moveName] = ItemUse.checkTmPreflight(mon, PartyMenu._item);
        if (status === "knows" || status === "incompatible" || status === "invalid") {
          se("SE_SELECT"); // pokefirered/src/party_menu.c:5001
          PartyMenu.showMessage(preflightMsg, () => {
            PartyMenu.mode = "use";
          });
        } else if (status === "ok") {
          se("SE_SELECT");
          {
            const isHm = ItemsData.isHm(PartyMenu._item);
            const monName = Pokemon.displayMonName(mon);

            // pokefirered/src/party_menu.c:4785
            if (Pokemon.moveSlotCount(mon) < 4) {
              const ok = Pokemon.teachMove(mon, moveId)[0];
              if (ok) {
                // pokefirered/src/party_menu.c:4811
                Pokemon.adjustFriendship(mon, Pokemon.FRIENDSHIP_EVENT_LEARN_TMHM,
                  { mapSec: Pokemon.currentMapSec(PartyMenu._session) });
                QuestLogRecorder.event(PartyMenu._session,
                  isHm ? "MonLearnedMoveFromHM" : "MonLearnedMoveFromTM", seq(monName, moveName));
                if (!isHm) {
                  Bag.remove(PartyMenu._bag, PartyMenu._item, 1);
                }
                try { Audio.playFanfare("MUS_LEVEL_UP"); } catch { /* pcall */ }
                // pokefirered/src/party_menu.c:4817
                show_rom_message("gText_PkmnLearnedMove3", seq(monName, moveName), () => {
                  PartyMenu.close();
                });
              } else {
                PartyMenu.mode = "use";
              }
            } else {
              // Full moveset: Forget Move flow
              LearnMove.begin({
                mon,
                moveId,
                displayName: monName,
                pushMsg: (t: any, cb: Cb) => { PartyMenu.showMessage(t, cb); },
                askYesNo: learn_ask_yes_no,
                askForget: (_a: any, b: any, c: any) => {
                  const cb = (typeof b === "function") ? b : c;
                  const moveToLearn = (LearnMove && LearnMove._moveId) || moveId;
                  destroy_party_oam();
                  SummaryMenu.openMenu(PartyMenu._party, PartyMenu.cursor, {
                    mode: "select_move",
                    moveToLearn,
                    onSelectMove: (slotIdx: any) => {
                      sync_all_oam();
                      if (cb) cb(slotIdx);
                    },
                  });
                },
                onDone: (learned: any) => {
                  if (truthy(learned)) {
                    // pokefirered/src/party_menu.c:4811
                    Pokemon.adjustFriendship(mon, Pokemon.FRIENDSHIP_EVENT_LEARN_TMHM,
                      { mapSec: Pokemon.currentMapSec(PartyMenu._session) });
                    QuestLogRecorder.event(PartyMenu._session,
                      isHm ? "MonLearnedMoveFromHM" : "MonLearnedMoveFromTM", seq(monName, moveName));
                    if (!isHm) {
                      Bag.remove(PartyMenu._bag, PartyMenu._item, 1);
                    }
                    try { Audio.playFanfare("MUS_LEVEL_UP"); } catch { /* pcall */ }
                    PartyMenu.close();
                  } else {
                    PartyMenu.mode = "use";
                  }
                },
              });
            }
          }
        }
        return;
      }

      // Case 2: Rare Candy / Level up item
      if (ItemsData.fieldUseKind(PartyMenu._item) === "level") {
        const lvl = tonumber(mon.level) ?? 1;
        const hp = tonumber(mon.hp) ?? 0;
        if (lvl >= 100 || hp <= 0) {
          se("SE_SELECT"); // pokefirered/src/party_menu.c:5028
          show_rom_message("gText_WontHaveEffect", null, () => {
            PartyMenu.mode = "use";
          });
          return;
        }

        se("SE_USE_ITEM");
        const oldStats = get_mon_stats(mon);
        const oldMax = oldStats.maxHp;
        const oldHp = hp;

        Bag.remove(PartyMenu._bag, PartyMenu._item, 1);
        QuestLogRecorder.event(PartyMenu._session,
          "UsedItemOnMonAtThisLocation", seq(ItemsData.displayName(PartyMenu._item), Pokemon.displayMonName(mon)));
        mon.level = lvl + 1;
        Pokemon.applyStats(mon);
        const newStats = get_mon_stats(mon);
        const newMax = newStats.maxHp;
        const newHp = Math.min(newMax, oldHp + Math.max(0, newMax - oldMax));
        mon.hp = newHp;
        ItemUse.levelUpEvent(mon, mon.level);

        try { Audio.playFanfare("MUS_LEVEL_UP"); } catch { /* pcall */ }

        const monName = Pokemon.displayMonName(mon);
        // pokefirered/src/party_menu.c:5059
        const lvlMsg = RomText.plain("gText_PkmnElevatedToLvVar2", { stringVars: seq(monName, tostring(mon.level)) });
        const slot = PartyMenu.cursor;

        const check_evolution = (): void => {
          const [toSpecies, blocked] = level_evolution_target(mon, PartyMenu._session);
          if (toSpecies) {
            destroy_party_oam();
            EvolutionScene.start(mon, toSpecies, {
              session: PartyMenu._session,
              bag: PartyMenu._bag,
              canStop: true,
              autoCancel: blocked,
              savedSong: Audio._mapSong,
              onDone: (_result: any) => {
                PartyMenu.reloadSprites();
                PartyMenu.mode = "list";
              },
            });
          } else {
            if (Bag.has(PartyMenu._bag, PartyMenu._item, 1)) {
              PartyMenu.mode = "use";
            } else {
              PartyMenu.close();
            }
          }
        };

        const after_level_up = (): void => {
          const spId = Pokemon.speciesOf(mon) ?? tonumber(mon.species ?? mon.speciesId);
          const newMoves = Pokemon.movesLearnedAt(spId, mon.level);
          if (len(newMoves) > 0) {
            const started = LearnMove.beginQueue(mon, seq(mon.level), {
              displayName: monName,
              pushMsg: (t: any, cb: Cb) => { PartyMenu.showMessage(t, cb); },
              askYesNo: learn_ask_yes_no,
              askForget: (_a: any, b: any, c: any) => {
                const cb = (typeof b === "function") ? b : c;
                destroy_party_oam();
                SummaryMenu.openMenu(PartyMenu._party, PartyMenu.cursor, {
                  mode: "select_move",
                  moveToLearn: LearnMove._moveId,
                  onSelectMove: (slotIdx: any) => {
                    sync_all_oam();
                    if (cb) cb(slotIdx);
                  },
                });
              },
              onDone: () => {
                check_evolution();
              },
            });
            if (!started) {
              check_evolution();
            }
          } else {
            check_evolution();
          }
        };

        PartyMenu._messageText = lvlMsg;
        const show_growth = (): void => {
          PartyMenu.showStatGrowth(mon, oldStats, newStats, after_level_up);
        };

        if (newHp > oldHp) {
          PartyMenu.startHpAnim(slot, oldHp, newHp, newMax, show_growth);
        } else {
          show_growth();
        }
        return;
      }

      // Case 3: Evolution Stone
      if (is_evolution_stone(PartyMenu._item)) {
        const toSpecies = Evolution.itemTarget(mon, PartyMenu._item, PartyMenu._session);
        if (!toSpecies) {
          se("SE_SELECT"); // pokefirered/src/party_menu.c:4490
          show_rom_message("gText_WontHaveEffect", null, () => {
            PartyMenu.mode = "use";
          });
        } else {
          Bag.remove(PartyMenu._bag, PartyMenu._item, 1);
          destroy_party_oam();
          EvolutionScene.start(mon, toSpecies, {
            session: PartyMenu._session,
            bag: PartyMenu._bag,
            canStop: false,
            savedSong: Audio._mapSong,
            onDone: (_result: any) => {
              PartyMenu.reloadSprites();
              PartyMenu.mode = "list";
            },
          });
        }
        return;
      }

      // Case 4: General Medicine / Potions / Status
      const use_general = (moveSlot?: number | null): void => {
        const startHp = tonumber(mon ? mon.hp : null) ?? 0;
        const maxHp = tonumber(mon ? (mon.maxHp ?? mon.maxhp) : null) ?? 1;
        const realSlot = (PartyMenu._order && PartyMenu._order[PartyMenu.cursor]) || PartyMenu.cursor;
        const [ok, , msgText] = ItemUse.useField(PartyMenu._session, PartyMenu._bag, PartyMenu._item, realSlot, moveSlot ?? undefined);
        const endHp = tonumber(mon ? mon.hp : null) ?? startHp;
        if (ok) {
          // pokefirered/src/party_menu.c:4498
          se(ItemUse.isFlute(PartyMenu._item) ? 110 : 1);
          const hasRemaining = Bag.has(PartyMenu._bag, PartyMenu._item, 1);
          if (endHp > startHp) {
            PartyMenu.startHpAnim(PartyMenu.cursor, startHp, endHp, maxHp, () => {
              PartyMenu.showMessage(msgText, () => {
                if (hasRemaining) {
                  PartyMenu.mode = "use";
                } else {
                  PartyMenu.close();
                }
              });
            });
          } else {
            PartyMenu.showMessage(msgText, () => {
              if (hasRemaining) {
                PartyMenu.mode = "use";
              } else {
                PartyMenu.close();
              }
            });
          }
        } else {
          se("SE_SELECT"); // pokefirered/src/party_menu.c:4490
          PartyMenu.showMessage(truthy(msgText) ? msgText : RomText.plain("gText_WontHaveEffect"), () => {
            PartyMenu.mode = "use";
          });
        }
      };
      // pokefirered/src/party_menu.c:4591 ItemUseCB_TryRestorePP
      if (ItemsData.fieldUseKind(PartyMenu._item) === "pp" && ItemUse.ppItemNeedsMove(PartyMenu._item)) {
        se("SE_SELECT");
        PartyMenu.pickPpMove(mon, PartyMenu._item, use_general);
        return;
      }
      use_general(null);
    } else if (input.wasPressed("b") || input.wasPressed("start")) {
      se("SE_SELECT"); // pokefirered/src/party_menu.c:1246
      PartyMenu.close();
    }
    return;
  }

  // pokefirered/src/party_menu.c:1172
  if (PartyMenu.mode === "move_tutor") {
    const oldCur = PartyMenu.cursor;
    if (input.wasPressed("up")) {
      PartyMenu.cursor = nav_up(PartyMenu.cursor, n);
    } else if (input.wasPressed("down")) {
      PartyMenu.cursor = nav_down(PartyMenu.cursor, n);
    } else if (input.wasPressed("left")) {
      [PartyMenu.cursor, PartyMenu._lastSelectedSlot] = nav_left(PartyMenu.cursor, n, PartyMenu._lastSelectedSlot);
    } else if (input.wasPressed("right")) {
      PartyMenu.cursor = nav_right(PartyMenu.cursor, n, PartyMenu._lastSelectedSlot)[0];
    }
    if (PartyMenu.cursor !== oldCur) {
      se("SE_SELECT");
    }
    if (input.wasPressed("a")) {
      if (PartyMenu.cursor === 7) {
        se("SE_SELECT"); // pokefirered/src/party_menu.c:1246
        PartyMenu.close();
        return;
      }
      const mon = PartyMenu._party ? PartyMenu._party[PartyMenu.cursor] : null;
      if (!mon) return;
      if (mon.isEgg) {
        se("SE_FAILURE"); // pokefirered/src/party_menu.c:1223
        return;
      }
      se("SE_SELECT"); // pokefirered/src/party_menu.c:1175
      try_tutor_selected_mon(PartyMenu.cursor);
    } else if (input.wasPressed("b") || input.wasPressed("start")) {
      se("SE_SELECT"); // pokefirered/src/party_menu.c:1246
      PartyMenu.close();
    }
    return;
  }

  // Selection mode for item GIVE
  if (PartyMenu.mode === "give") {
    const oldCur = PartyMenu.cursor;
    if (input.wasPressed("up")) {
      PartyMenu.cursor = nav_up(PartyMenu.cursor, n);
    } else if (input.wasPressed("down")) {
      PartyMenu.cursor = nav_down(PartyMenu.cursor, n);
    } else if (input.wasPressed("left")) {
      [PartyMenu.cursor, PartyMenu._lastSelectedSlot] = nav_left(PartyMenu.cursor, n, PartyMenu._lastSelectedSlot);
    } else if (input.wasPressed("right")) {
      PartyMenu.cursor = nav_right(PartyMenu.cursor, n, PartyMenu._lastSelectedSlot)[0];
    }
    if (PartyMenu.cursor !== oldCur) {
      se("SE_SELECT");
    }
    if (input.wasPressed("a")) {
      if (PartyMenu.cursor === 7) {
        se("SE_SELECT"); // pokefirered/src/party_menu.c:1246
        PartyMenu.close();
      } else {
        const mon = PartyMenu._party ? PartyMenu._party[PartyMenu.cursor] : null;
        if (mon && mon.isEgg) {
          se("SE_FAILURE"); // pokefirered/src/party_menu.c:1223
        } else {
          se("SE_SELECT"); // pokefirered/src/party_menu.c:1190
          const session = PartyMenu._session, bag = PartyMenu._bag, item = PartyMenu._item, slot = PartyMenu.cursor;
          const source = PartyMenu._giveSource;
          const chk = ItemUse.checkGive(session, item, slot);
          const kind = chk[0];
          let msgText: any = chk[2];
          if (kind === "give") {
            msgText = ItemUse.giveHeld(session, bag, item, slot, source);
          }
          if (kind === "switch") {
            // src/party_menu.c:5554 Task_SwitchItemsFromBagYesNo
            // TextIR.splitPages returns a 0-based JS array (its port's shape).
            const pages = TextIR.splitPages(tostring(msgText), true);
            const last = pages[pages.length - 1];
            const head = pages.length > 1 ? pages.slice(0, pages.length - 1).join("\f") : null;
            const ask = (): void => {
              PartyMenu.showYesNo(last ?? msgText, (yes) => {
                if (!yes) {
                  PartyMenu.close();
                  return;
                }
                const [, switched] = ItemUse.switchHeld(session, bag, item, slot, source);
                PartyMenu.showMessage(switched, () => {
                  PartyMenu.close();
                });
              });
            };
            if (head != null) PartyMenu.showMessage(head, ask); else ask();
          } else {
            PartyMenu.showMessage(msgText, () => {
              PartyMenu.close();
            });
          }
        }
      }
    } else if (input.wasPressed("b") || input.wasPressed("start")) {
      se("SE_SELECT"); // pokefirered/src/party_menu.c:1246
      PartyMenu.close();
    }
    return;
  }

  // pokefirered/src/party_menu.c:1119 Task_HandleChooseMonInput
  if (PartyMenu.mode === "choose_multi") {
    const oldCur = PartyMenu.cursor;
    if (input.wasPressed("up")) {
      PartyMenu.cursor = multi_nav_up(PartyMenu.cursor, n);
    } else if (input.wasPressed("down")) {
      PartyMenu.cursor = multi_nav_down(PartyMenu.cursor, n);
    } else if (input.wasPressed("left")) {
      [PartyMenu.cursor, PartyMenu._lastSelectedSlot] = multi_nav_left(PartyMenu.cursor, PartyMenu._lastSelectedSlot);
    } else if (input.wasPressed("right")) {
      PartyMenu.cursor = nav_right(PartyMenu.cursor, n, PartyMenu._lastSelectedSlot)[0];
    } else if (input.wasPressed("start")) {
      // pokefirered/src/party_menu.c:1133
      PartyMenu.cursor = SLOT_CONFIRM;
    }
    if (PartyMenu.cursor !== oldCur) {
      se("SE_SELECT");
    }
    if (input.wasPressed("a")) {
      if (PartyMenu.cursor === SLOT_CONFIRM) {
        PartyMenu.confirmChosenMons();
      } else if (PartyMenu.cursor === SLOT_CANCEL_MULTI) {
        PartyMenu.askCancelChooseMons();
      } else {
        se("SE_SELECT");
        PartyMenu.ACTIONS = PartyMenu.multiActions(PartyMenu.cursor);
        PartyMenu._fieldMoveNames = null;
        PartyMenu.mode = "action";
        PartyMenu.actionCursor = 1;
      }
    } else if (input.wasPressed("b")) {
      // pokefirered/src/party_menu.c:1261 DisplayCancelChooseMonYesNo
      PartyMenu.askCancelChooseMons();
    }
    return;
  }

  // Selection mode for generic choose
  if (PartyMenu.mode === "choose") {
    const oldCur = PartyMenu.cursor;
    if (input.wasPressed("up")) {
      PartyMenu.cursor = nav_up(PartyMenu.cursor, n);
    } else if (input.wasPressed("down")) {
      PartyMenu.cursor = nav_down(PartyMenu.cursor, n);
    } else if (input.wasPressed("left")) {
      [PartyMenu.cursor, PartyMenu._lastSelectedSlot] = nav_left(PartyMenu.cursor, n, PartyMenu._lastSelectedSlot);
    } else if (input.wasPressed("right")) {
      PartyMenu.cursor = nav_right(PartyMenu.cursor, n, PartyMenu._lastSelectedSlot)[0];
    }
    if (PartyMenu.cursor !== oldCur) {
      se("SE_SELECT");
    }
    if (input.wasPressed("a")) {
      if (PartyMenu.cursor === 7) {
        se("SE_SELECT"); // pokefirered/src/party_menu.c:1246
        PartyMenu.close();
      } else {
        se("SE_SELECT");
        const cb = PartyMenu._onSelect;
        const why = PartyMenu._validate ? PartyMenu._validate(PartyMenu.cursor) : null;
        if (truthy(why)) {
          const back = PartyMenu._previousMode;
          PartyMenu.showMessage(why, () => { PartyMenu.mode = back!; });
          return;
        }
        PartyMenu.close();
        if (cb) cb(PartyMenu.cursor, PartyMenu._party ? PartyMenu._party[PartyMenu.cursor] : null);
      }
    } else if (input.wasPressed("b") || input.wasPressed("start")) {
      se("SE_SELECT"); // pokefirered/src/party_menu.c:1246
      PartyMenu.close();
    }
    return;
  }

  // Default list mode
  const oldCur = PartyMenu.cursor;
  if (input.wasPressed("up")) {
    PartyMenu.cursor = nav_up(PartyMenu.cursor, n);
  } else if (input.wasPressed("down")) {
    PartyMenu.cursor = nav_down(PartyMenu.cursor, n);
  } else if (input.wasPressed("left")) {
    [PartyMenu.cursor, PartyMenu._lastSelectedSlot] = nav_left(PartyMenu.cursor, n, PartyMenu._lastSelectedSlot);
  } else if (input.wasPressed("right")) {
    PartyMenu.cursor = nav_right(PartyMenu.cursor, n, PartyMenu._lastSelectedSlot)[0];
  }
  if (PartyMenu.cursor !== oldCur) {
    se("SE_SELECT");
  }
  if (input.wasPressed("a")) {
    if (PartyMenu.cursor === 7) {
      se("SE_SELECT"); // pokefirered/src/party_menu.c:1246
      PartyMenu.close();
      return;
    }
    se("SE_SELECT");
    const mon = PartyMenu._party ? PartyMenu._party[PartyMenu.cursor] : null;
    // pokefirered/src/party_menu.c:2963
    const actions: LuaTable = seq("SUMMARY");
    const fmNames: Record<string, boolean> = {};
    const gfm = gameFieldMoves();
    const fmIndex = fieldMoveIndex();
    if (mon && !mon.isEgg && mon.moves) {
      for (const [, m] of ipairs<any>(mon.moves)) {
        const mId = FieldMoves.normalizeMoveId(m);
        let label: string | null | undefined;
        if (gfm) {
          label = mId != null ? gfm.byMove[mId] : null;
        } else {
          const mName = mId != null ? FieldMoves.MOVE_NAME_BY_ID[mId] : null;
          label = mName ? mName.replace(/_/g, " ") : null; // mName:gsub("_", " ")
        }
        if (label && fmIndex[label] != null && !fmNames[label]) {
          actions[len(actions) + 1] = label;
          fmNames[label] = true;
        }
      }
    }
    if (!pikePartyRestrictions()) {
      actions[len(actions) + 1] = "SWITCH";
      if (!(mon && mon.isEgg)) {
        actions[len(actions) + 1] = "ITEM";
      }
    }
    actions[len(actions) + 1] = "CANCEL";
    PartyMenu.ACTIONS = actions;
    PartyMenu._fieldMoveNames = fmNames;
    PartyMenu.mode = "action";
    PartyMenu.actionCursor = 1;
  } else if (input.wasPressed("b") || input.wasPressed("start")) {
    se("SE_SELECT"); // pokefirered/src/party_menu.c:1246
    PartyMenu.close();
  }
};

// Lua: party_menu.lua:2481
function hp_bar(hpIn: unknown, maxHpIn: unknown, px: number, py: number, width?: number): void {
  width = width ?? 48;
  const hp = tonumber(hpIn) ?? 0;
  let maxHp = tonumber(maxHpIn) ?? 1;
  if (maxHp < 1) maxHp = 1;
  const ratio = Math.max(0, Math.min(1, hp / maxHp));
  const w = Math.floor(width * ratio);
  if (w <= 0) return;
  if (ratio > 0.5) {
    G.setColor(0.25, 0.85, 0.25, 1);
  } else if (ratio > 0.2) {
    G.setColor(0.95, 0.85, 0.15, 1);
  } else {
    G.setColor(0.95, 0.2, 0.15, 1);
  }
  G.rectangle("fill", px, py, w, 3);
  G.setColor(1, 1, 1, 1);
}

// pokeemerald/include/constants/party_menu.h:120
const MULTI_ORDER_TEXT = seq("FIRST", "SECOND", "THIRD", "FOURTH");

// Lua: party_menu.lua:2503
function slot_description(slot: number, mon: any): string | null {
  // pokefirered/src/party_menu.c:839
  if (PartyMenu._minigameEligible) {
    return desc_text(truthy(PartyMenu._minigameEligible(slot, mon)) ? "ABLE" : "NOT_ABLE");
  }
  // pokefirered/src/party_menu.c:812 DisplayPartyPokemonDataForChooseMultiple
  if (PartyMenu._chooseOrder) {
    if (!entry_eligible(slot)) return desc_text("NOT_ABLE");
    const idx = order_index(slot);
    if (idx != null && MULTI_ORDER_TEXT[idx]) return desc_text(MULTI_ORDER_TEXT[idx]!);
    return desc_text("ABLE_3");
  }
  // pokefirered/src/party_menu.c:881 DisplayPartyPokemonDataToTeachMove
  if (PartyMenu._tutor != null) {
    const status = MoveLearn.canMonLearnTutorMove(mon, PartyMenu._tutor);
    if (status === MoveLearn.ALREADY_KNOWS_MOVE) return desc_text("LEARNED");
    if (status === MoveLearn.CAN_LEARN_MOVE) return desc_text("ABLE_2");
    return desc_text("NOT_ABLE_2");
  }
  const item = PartyMenu._item;
  if (!truthy(item) || truthy(PartyMenu._battle)) return null;
  if (PartyMenu.mode !== "use" && PartyMenu.mode !== "message") return null;
  // pokefirered/src/party_menu.c:856 TM/HM -> DisplayPartyPokemonDataToTeachMove
  if (ItemsData.isTm(item)) {
    // pokefirered/src/party_menu.c:4760 CanMonLearnTMTutor
    if (Pokemon.isEgg(mon)) return desc_text("NOT_ABLE_2");
    const moveId = Pokemon.moveFromTmItem(item);
    const species = tonumber(mon.species ?? mon.speciesId);
    if (!moveId || !Pokemon.canLearnTmItem(species, item)) return desc_text("NOT_ABLE_2");
    if (Pokemon.knowsMove(mon, moveId)) return desc_text("LEARNED");
    return desc_text("ABLE_2");
  }
  if (!is_evolution_stone(item)) return null;
  if (Evolution.itemCheck(mon, item)) return null;
  return desc_text("NO_USE");
}

// Lua: party_menu.lua:2542
PartyMenu.slotDescription = function (slot: number): string | null {
  const mon = PartyMenu._party ? PartyMenu._party[slot] : null;
  if (!mon) return null;
  return slot_description(slot, mon);
};

// Lua: party_menu.lua:2548
function draw_filled_slot(i: number, mon: any, selected: boolean): void {
  const win = slot_win(i);
  if (!win) return;
  const T = Display.TILE || 8;
  const baseX = win.left * T, baseY = win.top * T;
  const info = slot_info(i);
  const desc = slot_description(i, mon);

  // pokefirered/src/party_menu.c:781 DisplayPartyPokemonData: an egg's slot
  // has no HP frame and shows only its nickname (gText_EggNickname).
  const isEgg = Pokemon.isEgg(mon);
  // pokefirered/src/party_menu.c:1040
  const multiAlt = PartyMenu._multi != null && PartyMenu._multi[i] === true && (tonumber(mon.hp) ?? 0) > 0;
  PartyChrome.drawSlot(win.kind, win.left, win.top, selected, desc != null || isEgg, multiAlt);

  const name = Pokemon.displayName(mon);
  party_print(name, baseX + info.nick[1]!, baseY + info.nick[2]!, 56);
  if (isEgg) {
    if (desc != null) party_print(desc, baseX + info.desc[1]!, baseY + info.desc[2]!, 64);
    return;
  }
  const ailment = SummaryData.statusAilment(mon);
  // pokefirered/src/party_menu.c:2322 DisplayPartyPokemonLevelCheck:
  // Level is only shown when the mon is healthy (or PKRS); status ailments replace level.
  if (ailment === 0 || ailment === 6) {
    // pokefirered/src/party_menu.c:2335
    party_print(RomText.plain("gText_Lv") + tostring(mon.level ?? 0), baseX + info.level[1]!, baseY + info.level[2]!, 32);
  }

  const gender = mon.gender ?? (Pokemon.gender ? Pokemon.gender(mon.species, mon.personality) : null);
  const isNidoran = (mon.species === 29 || mon.species === 32);
  if (truthy(gender) && !isNidoran) {
    if (gender === "M") {
      // "♂" as its UTF-8 bytes
      FrlgFont.draw("\xE2\x99\x82", baseX + info.gender[1]!, baseY + info.gender[2]!, { colors: FrlgFont.COLOR.PARTY_MALE, small: true });
    } else if (gender === "F") {
      // "♀" as its UTF-8 bytes
      FrlgFont.draw("\xE2\x99\x80", baseX + info.gender[1]!, baseY + info.gender[2]!, { colors: FrlgFont.COLOR.PARTY_FEMALE, small: true });
    }
  }

  if (desc != null) {
    party_print(desc, baseX + info.desc[1]!, baseY + info.desc[2]!, 64);
    return;
  }

  const hp = tonumber(mon.hp) ?? 0;
  const maxHp = tonumber(mon.maxHp) ?? tonumber(mon.maxhp) ?? 0;
  const anim = PartyMenu._hpAnim;
  let displayHp = hp;
  if (anim && anim.slot === i) {
    displayHp = Math.floor(anim.current + 0.5);
  }
  party_print(right_align_3(displayHp) + "/", baseX + info.hp[1]!, baseY + info.hp[2]!, 24);
  party_print("/" + right_align_3(maxHp), baseX + info.hpMax[1]!, baseY + info.hpMax[2]!, 24);
  hp_bar(displayHp, maxHp, baseX + info.hpBar[1]!, baseY + info.hpBar[2]!, 48);
}

// Lua: party_menu.lua:2605
PartyMenu.draw = function (): void {
  const ins = textInsets();
  if (!PartyMenu.open) return;
  const party = PartyMenu._party ?? seq();

  if (PartyMenu.mode === "summary" || SummaryMenu.isOpen()) {
    destroy_party_oam();
    if (PartyMenu.mode === "summary") {
      PartyChrome.drawBg();
      SummaryMenu.draw();
    }
    return;
  }

  PartyChrome.drawBg();
  sync_all_oam();
  unflush_party_sprites();

  destroy_id(PartyMenu._summaryIcon);
  PartyMenu._summaryIcon = null;

  for (let i = 1; i <= 6; i++) {
    const mon = party[i];
    const win = slot_win(i);
    if (mon) {
      draw_filled_slot(i, mon, i === PartyMenu.cursor || PartyMenu.switchFrom === i);
    } else if (i > 1 && win && win.kind !== "main") {
      PartyChrome.drawSlot("empty", win.left, win.top, false);
    }
  }

  if (PartyMenu.mode !== "oak") flush_party_sprites();

  if (PartyMenu.mode === "oak") {
    // pokefirered/src/party_menu.c:1944
    const fx = PartyMenu._oakFx;
    const y = fx ? fx.y : 0;
    const slotY = fx ? Math.min(fx.slot, y) : 0;
    const win = slot_win(1);
    if (y > 0 && win) {
      const T = Display.TILE || 8;
      const sx = win.left * T, sy = win.top * T, sw = win.w * T, sh = win.h * T;
      G.setColor(0, 0, 0, y / 16);
      G.rectangle("fill", 0, 0, Display.W, sy);
      G.rectangle("fill", 0, sy, sx, sh);
      G.rectangle("fill", sx + sw, sy, Display.W - sx - sw, sh);
      G.rectangle("fill", 0, sy + sh, Display.W, Display.H - sy - sh);
      if (slotY > 0) {
        // pokefirered/src/party_menu.c:1970
        G.setColor(0, 0, 0, slotY / 16);
        G.rectangle("fill", sx, sy, sw, sh);
      }
      G.setColor(1, 1, 1, 1);
    }
    flush_party_sprites();
    if (fx && fx.phase !== "darken" && fx.phase !== "normal") {
      // pokefirered/src/party_menu.c:2604
      Chrome.dialogueFrame();
      if (PartyMenu._oakWrapped) {
        FrlgFont.draw(PartyMenu._oakWrapped, Chrome.DLG_LEFT * 8, Chrome.DLG_TOP * 8 + 1, OAK_TEXT_OPTS());
      }
    }
  } else if (PartyMenu.mode === "message") {
    Window.stdFrame(Window.template(1, 15, 28, 4));
    if (PartyMenu._messageText) {
      const wrapped = FrlgFont.wrap(PartyMenu._messageText, 216);
      FrlgFont.draw(wrapped, 1 * 8 + 6, 15 * 8 + 4, { maxWidth: 216, linePitch: 15, colors: FrlgFont.COLOR.NORMAL });
    }
  } else if (PartyMenu.mode === "stat_growth") {
    Window.stdFrame(Window.template(1, 15, 28, 4));
    if (PartyMenu._messageText) {
      const wrapped = FrlgFont.wrap(PartyMenu._messageText, 216);
      FrlgFont.draw(wrapped, 1 * 8 + 6, 15 * 8 + 4, { maxWidth: 216, linePitch: 15, colors: FrlgFont.COLOR.NORMAL });
    }

    const winX = 19, winY = 1, winW = 10, winH = 11;
    Window.stdFrame(Window.template(winX, winY, winW, winH));
    // pokefirered/src/pokemon_special_anim_scene.c:1486
    const statKeys = partyText("levelUpStats");
    let statNames: LuaTable;
    if (statKeys) {
      statNames = seq();
      for (const [i, k] of ipairs<string>(statKeys)) statNames[i] = RomText.plain(k);
    } else {
      statNames = RomText.list("sLevelUpWindowStatNames");
    }
    const oldS = PartyMenu._statGrowthOld || {};
    const newS = PartyMenu._statGrowthNew || {};
    const oldList = seq(oldS.maxHp ?? 0, oldS.atk ?? 0, oldS.def ?? 0, oldS.spa ?? 0, oldS.spd ?? 0, oldS.spe ?? 0) as number[];
    const newList = seq(newS.maxHp ?? 0, newS.atk ?? 0, newS.def ?? 0, newS.spa ?? 0, newS.spd ?? 0, newS.spe ?? 0) as number[];
    const isPage1 = (PartyMenu._statGrowthPage === 1);

    for (let idx = 1; idx <= 6; idx++) {
      const rowY = winY * 8 + 2 + (idx - 1) * 14;
      FrlgFont.draw(statNames[idx], winX * 8 + 2, rowY, { colors: FrlgFont.COLOR.NORMAL });
      if (isPage1) {
        const diff = newList[idx]! - oldList[idx]!;
        const sign = (diff >= 0) ? "+" : "-";
        const diffStr = format("%s%2d", sign, Math.abs(diff));
        FrlgFont.draw(diffStr, winX * 8 + 52, rowY, { colors: FrlgFont.COLOR.NORMAL });
      } else {
        const valStr = format("%3d", newList[idx]);
        FrlgFont.draw(valStr, winX * 8 + 52, rowY, { colors: FrlgFont.COLOR.NORMAL });
      }
    }
  } else if (PartyMenu.mode === "yesno") {
    Window.stdFrame(Window.template(1, 15, 28, 4));
    if (PartyMenu._yesNoPrompt) {
      const wrapped = FrlgFont.wrap(PartyMenu._yesNoPrompt, 216);
      FrlgFont.draw(wrapped, 1 * 8 + 6, 15 * 8 + 4, { maxWidth: 216, linePitch: 15, colors: FrlgFont.COLOR.NORMAL });
    }
    // Yes/No window overlay at tile X=21, Y=9, W=6, H=4
    const ynX = 21;
    const ynY = 9;
    Window.stdFrame(Window.template(ynX, ynY, 6, 4));
    const options = seq(RomText.plain("gText_Yes"), RomText.plain("gText_No"));
    for (const [i, opt] of ipairs<string>(options)) {
      const rowY = (ynY * 8) + (i - 1) * 16 + ins.actY;
      if (i === PartyMenu._yesNoCursor) {
        Window.cursorPx(ynX * 8 + ins.cursorX, rowY);
      }
      FrlgFont.draw(opt, ynX * 8 + ins.actX, rowY, { colors: FrlgFont.COLOR.NORMAL });
    }
  } else if (PartyMenu.mode === "forget") {
    Window.stdFrame(Window.template(1, 17, 15, 2));
    FrlgFont.draw(PartyMenu._forgetPrompt || Strings("Which move?"), 1 * 8 + ins.msgX, 17 * 8 + ins.msgY, { colors: FrlgFont.COLOR.NORMAL });

    const moves = PartyMenu._forgetMoves ?? seq();
    const popW = 11;
    const popH = Math.max(4, len(moves) * 2);
    const popX = 18;
    const popY = 19 - popH;
    Window.stdFrame(Window.template(popX, popY, popW, popH));
    for (const [i, mv] of ipairs<unknown>(moves)) {
      const rowY = (popY * 8) + (i - 1) * 16 + ins.actY;
      if (i === PartyMenu._forgetCursor) {
        Window.cursorPx(popX * 8 + ins.cursorX, rowY);
      }
      FrlgFont.draw(tostring(mv), popX * 8 + ins.actX, rowY, { colors: FrlgFont.COLOR.NORMAL });
    }
  } else if (PartyMenu.mode === "item_action") {
    Window.stdFrame(Window.template(1, 17, 18, 2));
    FrlgFont.draw(RomText.plain("gText_DoWhatWithItem"), 1 * 8 + ins.msgX, 17 * 8 + ins.msgY, { colors: FrlgFont.COLOR.NORMAL });

    const actCount = len(PartyMenu.ITEM_ACTIONS);
    const popW = 7;
    const popH = actCount * 2;
    const popX = 22;
    const popY = 19 - popH;
    Window.stdFrame(Window.template(popX, popY, popW, popH));
    for (const [i, act] of ipairs<string>(PartyMenu.ITEM_ACTIONS)) {
      const rowY = (popY * 8) + (i - 1) * 16 + ins.actY;
      if (i === PartyMenu.itemActionCursor) {
        Window.cursorPx(popX * 8 + ins.cursorX, rowY);
      }
      FrlgFont.draw(cursor_option_text(act), popX * 8 + ins.actX, rowY, { colors: FrlgFont.COLOR.NORMAL });
    }
  } else if (PartyMenu.mode === "action") {
    Window.stdFrame(Window.template(1, 17, 17, 2));
    FrlgFont.draw(RomText.plain("gText_DoWhatWithPokemon"), 1 * 8 + ins.msgX, 17 * 8 + ins.msgY, { colors: FrlgFont.COLOR.NORMAL });

    const actCount = len(PartyMenu.ACTIONS);
    const popW = 10;
    const popH = actCount * 2;
    const popX = 19;
    const popY = 19 - popH;
    Window.stdFrame(Window.template(popX, popY, popW, popH));
    for (const [i, act] of ipairs<string>(PartyMenu.ACTIONS)) {
      const rowY = (popY * 8) + (i - 1) * 16 + ins.actY;
      if (i === PartyMenu.actionCursor) {
        Window.cursorPx(popX * 8 + ins.cursorX, rowY);
      }
      const isFm = PartyMenu._fieldMoveNames && PartyMenu._fieldMoveNames[act];
      const col = isFm ? (FrlgFont.COLOR.BLUE || FrlgFont.COLOR.MALE_NPC) : FrlgFont.COLOR.NORMAL;
      FrlgFont.draw(cursor_option_text(act), popX * 8 + ins.actX, rowY, { colors: col });
    }
  } else {
    Window.stdFrame(Window.template(1, 17, 21, 2));
    let promptKey = "gText_ChoosePokemon";
    if (PartyMenu.mode === "switch") {
      promptKey = "gText_MoveToWhere";
    } else if (PartyMenu.mode === "use") {
      if (PartyMenu._item && ItemsData.isTm(PartyMenu._item)) {
        promptKey = "gText_TeachWhichPokemon";
      } else {
        promptKey = "gText_UseOnWhichPokemon";
      }
    } else if (PartyMenu.mode === "give") {
      promptKey = "gText_GiveToWhichPokemon";
    } else if (PartyMenu.mode === "move_tutor") {
      // pokefirered/src/data/party_menu.h:609
      promptKey = "gText_TeachWhichPokemon";
    }
    const promptText = RomText.plain(promptKey);
    FrlgFont.draw(promptText, 1 * 8 + ins.msgX, 17 * 8 + ins.msgY, { colors: FrlgFont.COLOR.NORMAL });
    if (PartyMenu.mode === "choose_multi") {
      // pokefirered/src/party_menu.c:1063 DrawCancelConfirmButtons
      PartyChrome.drawConfirmButton(184, 128, PartyMenu.cursor === SLOT_CONFIRM);
      PartyChrome.drawCancelButton(184, 144, PartyMenu.cursor === SLOT_CANCEL_MULTI);
    } else {
      PartyChrome.drawCancelButton(184, 136, PartyMenu.cursor === 7);
    }
  }
};

export default PartyMenu;
