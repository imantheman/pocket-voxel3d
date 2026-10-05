// Port of gen1recomp src/core/game3/battle/ui.lua (GPLv3 + additional terms; see LICENSE.md).
// FRLG battle UI (pret battle_bg windows + battle_interface). Chrome from ROM extract.
//
// Port notes:
// - require / package.loaded / pcall(require): every runtime module is in the
//   bundle, so each is a static import used exactly as Brian guards it
//   (Message and Choice load, so his `Message and ...` guards are always true).
//   package.loaded probes of UI screens (`M and M.isOpen and M.isOpen()`) go
//   through probeOpen(): a module that is still a stub cannot have been
//   opened, so its isOpen refusing (NotPortedError) reads as closed, as in
//   init.ts. package.loaded["src.core.game3.battle"] and
//   ["src.core.game3.battle.init"] are both init.ts's Battle (battle.lua
//   returns require("src.core.game3.battle.init")).
// - Modules with no file in the port are looked up in G3Lazy (core/runtime.ts);
//   a missing entry is Brian's failed require / nil package.loaded probe:
//   src.core.game3.rse.frontier.pyramid, src.ui.game3.rse.pyramid_bag,
//   src.ui.game3.stat_growth, src.ui.game3.rse.pokedex.
// - Lua multiple returns are 0-based tuples: live_battler [b, st];
//   battlerSpriteCenter [cx, cy]; picArgs / sidePicArgs [picSpecies, shiny,
//   personality]; battlerPic [entry, form, ghost]; targetSelection
//   [needs, cursor, start]; partySummaryCoords [x, y]; ballQuad [img, quad, id]
//   ([] when there is no sheet, Lua's single nil). Callees returning tuples:
//   Commands.fightShortcut [act, msg], Engine.canRun [ok, why], Wally.take
//   [act, step], BallOpen.monBlend ([0] or [coeff, r, g, b], spread into
//   setBlendShader as Lua does), BattleChrome.textOrigin [x, y, w, narrow],
//   Anim.particleBand [lo, hi].
// - Lua sequences keep their keys (platform/lt.ts): the queue, the log, menu
//   labels, position tables are seq(...). Tables keyed by battler id
//   (_actionCursor, _moveCursor, _bounce.hb/mon, fade masks) are plain objects
//   with integer keys 0..3. RomText.ir is TextIR's own 0-based Seg[].
// - LÖVE shaders -> platform effects: GRAY = gray5_pre, STAT_MASK = stat_mask,
//   MOSAIC = mosaic, AFFINE = affine_color; Brian's send calls are unchanged
//   (vectors as plain 0-based JS arrays, as LÖVE takes them).
// - `love and love.graphics` / `love.image` are always present here.
// - print -> console.log.
// - The FRLG action / move menu position tables are module constants (Brian
//   rebuilds the same constant tables every frame).
// - NOT FAITHFUL: Emerald only: the Battle Pyramid bag (the Pyramid module
//   has no file, so its probe reads nil and the branch is never taken; if it
//   were, the missing src.ui.game3.rse.pyramid_bag throws as a failed plain
//   require), and battle_font() for a profile font module other than
//   src.ui.game3.frlg_font (both shipped profiles name frlg_font).
// - Link battles are deferred: confirm_link_forfeit and the `st.link` paths sit
//   behind Brian's own `st.link` guards; nothing here calls the link stubs.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { NotPortedError, notPorted } from "../../notported.ts";
import { seq, len, ipairs, remove, concat, type LuaTable } from "../../platform/lt.ts";
import { truthy, tostring, tonumber, format, mod as lmod } from "../../../../import/gen3/lua.ts";
import { G, type Shader } from "../../platform/graphics.ts";
import { newImageData, type Image, type Quad } from "../../platform/image.ts";
import Message from "../../ui/message.ts";
import Choice from "../../ui/choice.ts";
import Commands from "./commands.ts";
import State from "./state.ts";
import Moves from "./moves.ts";
import Display from "../display.ts";
import FrlgFont from "../../ui/frlg_font.ts";
import BattleChrome from "../../ui/battle_chrome.ts";
import BattleBg from "./bg.ts";
import Healthbox from "./healthbox.ts";
import Pokemon from "../pokemon.ts";
import Window from "../../ui/window.ts";
import Types from "./types.ts";
import BallOpen from "./ball_open.ts";
import Oak from "./oak_advice.ts";
import Strings from "../../shared/core/Strings.ts";
import RomText from "../rom_text.ts";
import BattleText from "./battle_text.ts";
import SummaryChrome from "../../ui/summary_chrome.ts";
import Anim from "./anim.ts";
import PicCoords from "./pic_coords.ts";
import TrainerPic from "../trainer_pic.ts";
import Audio from "../audio.ts";
import SE from "../se_ids.ts";
// Lazy requires / package.loaded probes (all linked in):
import Battle from "./init.ts";
import Kinds from "./kinds.ts";
import BagMenu from "../../ui/bag_menu.ts";
import PartyMenu from "../../ui/party_menu.ts";
import Runtime, { G3Lazy } from "../runtime.ts";
import Wally from "./tutorial_wally.ts";
import Engine from "./engine.ts";
import MoveSwap from "./move_swap.ts";
import SummaryMenu from "../../ui/summary_menu.ts";
import BattleProfile from "./profile.ts";
import Profile from "../profile.ts";
import Pal from "../pal_fade.ts";
import Fx from "../gba_fx.ts";
import Screens from "../../ui/screens.ts";
import MonAnim from "../mon_anim.ts";
import Dataset from "../dataset.ts";
import Pokedex from "../../ui/pokedex.ts";
import Extract from "../../../../import/gen3/extract_island1.ts";

type Fn = (...a: any[]) => any;

/** Lua `a or b` (b already evaluated; use only where b is pure). */
function lor<A, B>(a: A, b: B): A | B {
  return truthy(a) ? a : b;
}

/** Lua `a or b or c ...` with lazy operands: the first truthy value, else the last one. */
function orl(...fs: (() => any)[]): any {
  let v: any;
  for (let i = 0; i < fs.length; i++) {
    v = fs[i]!();
    if (truthy(v)) return v;
  }
  return v;
}

/** Lua `type(v) == "table"`. */
function isTable(v: unknown): v is LuaTable {
  return v !== null && typeof v === "object";
}

/**
 * `M and M.isOpen and M.isOpen()` on a package.loaded probe. A module that is
 * still a stub cannot have been loaded / opened: its isOpen refusing reads as
 * nil (closed).
 */
function probeOpen(M: any): boolean {
  if (!truthy(M) || !truthy(M.isOpen)) return false;
  try {
    return truthy(M.isOpen());
  } catch (e) {
    if (e instanceof NotPortedError) return false;
    throw e;
  }
}

// Runtime.getSession through `Runtime and Runtime.getSession and Runtime.getSession()`.
function runtime_session(): any {
  return truthy(Runtime) && truthy(Runtime.getSession) ? Runtime.getSession() : undefined;
}

export interface UiModule {
  _queue: LuaTable;
  _showing: boolean;
  _headless: boolean;
  _log: LuaTable;
  _mode: string;
  _menuIndex: number;
  _moveIndex: number;
  _moveIndexBattler: any;
  _st: any;
  _pendingCommand: any;
  _pendingYesNo: any;
  _session: any;
  _active: number;
  _actionCursor: Record<number, number>;
  _moveCursor: Record<number, number>;
  _moveCursorMon: Record<number, any>;
  _target: any;
  _bounce: { hb: Record<number, any>; mon: Record<number, any> };
  _preview: any;
  _partnerAction: any;
  // Fields ui.lua sets on the fly:
  _caughtDexScene: any;
  _timed: any;
  _linger: boolean;
  _menuLabels: Record<string, LuaTable>;
  _promptFor: any;
  _promptText: any;
  _swap: any;
  _oak: any;
  _oakTexts: Record<string, boolean> | undefined;
  _oakLit: Record<string, boolean> | undefined;
  _oakShown: any;
  _oldManTimer: number | undefined;
  _oldManSubstate: number | undefined;
  _selCmd: any;
  _selReturn: string | undefined;
  _wally: any;
  _trainerQuads: Record<string, Quad> | undefined;
  _ballSheet: Image | false | undefined;
  _ballQuads: Record<number, Quad> | undefined;
  // Exposed locals:
  castformForm: (side: any, battler: any) => number;
  showsGhost: (side: any, st: any) => boolean;
  battlerSpriteCenter: (side: any, species?: any, base?: any, form?: any, ghost?: any) => [number, number];
  picArgs: (battler: any, sp: any) => [any, boolean, any];
  openBattleBag: () => void;
  activeBattlerObject: (st?: any) => any;
  _openMoveMenu: () => void;
  moveTargetType: (battler: any, mv: any) => number;
  sidePicArgs(side: any, sp: any): [any, boolean, any];
  battlerPic(side: any, battler?: any, species?: any): [any, number, boolean];
  reset(opts?: any): void;
  bindState(st: any, session?: any): void;
  bindSession(session: any): void;
  markVoiceover(text: any, opts?: any): void;
  litHealthboxShown(): boolean;
  isVoiceoverText(text: any): boolean;
  push(text: any, cb?: Fn | null): void;
  pushTimed(text: any, waitFrames?: number | null, cb?: Fn | null): void;
  voiceoverDim(): number;
  busy(): boolean;
  dialogPending(): boolean;
  askYesNo(a: any, b?: any): void;
  yesNoPending(): boolean;
  askForget(labels: any, cb?: Fn | null, ctx?: any): void;
  choiceActive(): boolean;
  waitingForCommand(): boolean;
  refuseItems(): void;
  isShowing(): boolean;
  activeBattler(): number;
  multiPartyOrder(st: any): LuaTable;
  battlePartyOrder(st: any): LuaTable;
  allySlots(st: any, order?: LuaTable | null): Record<number, boolean> | undefined;
  openPartyMenu(st: any, battlerId?: any, opts?: any): void;
  openMenu(battlerId?: any, opts?: any): void;
  clearLinger(): void;
  selectionPump(): boolean;
  takeCommand(): any;
  pump(): boolean;
  targetSelection(st: any, id: any, slot: any): [boolean, number, number];
  bounceOffset(kind: string, id: any): number;
  previewCoeff(id: any): number;
  targetHidden(id: any): boolean;
  targetCursor(): number | undefined;
  tick(): void;
  chooseTarget(st: any, battlerId: any, moveSlot: any, cb?: Fn | null): boolean;
  handleInput(input: any): boolean;
  ppColorState(currentPp: any, maxPp: any): number;
  ppColorIndex(currentPp: any, maxPp: any): number;
  ballSheet(): Image | undefined;
  ballQuad(ballId: any, frame: any): [Image?, Quad?, number?];
  partySummaryCoords(st: any, battlerId: any, isSwitchingMons?: any): [number, number];
  beginCaughtDexScene(caught: any): void;
  updateCaughtDexScene(): boolean;
  clearCaughtDexScene(): void;
  draw(w?: number, h?: number): void;
  log(): LuaTable;
  [k: string]: any;
}

export const Ui = {} as UiModule;
let chromeInstallWarned = false;

// pokefirered/src/text.c:537 TextPrinterWaitAutoMode
const POKEDUDE_AUTO_SCROLL = 120;

// The stat window may only be on screen while the battle is in a phase that can
// still dismiss it; init.lua owns the list (#2324).  Resolved lazily because
// init.lua requires this module.
// Lua: ui.lua:45
function stat_window_phase(): boolean {
  if (!(truthy(Battle) && truthy(Battle.statWindowPhase))) return true;
  return Battle.statWindowPhase();
}

Ui._queue = seq();
Ui._showing = false;
Ui._headless = false;
Ui._log = seq();
Ui._mode = "none"; // "none"|"menu"|"moves"|"bag"
Ui._menuIndex = 1;
Ui._moveIndex = 1;
Ui._moveIndexBattler = undefined;
Ui._st = undefined;
Ui._pendingCommand = undefined;
Ui._pendingYesNo = undefined;
Ui._session = undefined;
Ui._active = 0;
Ui._actionCursor = {};
Ui._moveCursor = {};
Ui._moveCursorMon = {};
Ui._target = undefined;
Ui._bounce = { hb: {}, mon: {} };
Ui._preview = undefined;
Ui._partnerAction = undefined;

// pokefirered/src/battle_script_commands.c:5149
const BATTLE_YESNO = { left: 24, top: 9, style: "battle" };

// pret sBattlerCoords (singles) — CreateSprite CENTER before pic y_offset
const ENEMY_MON = { x: 176, y: 40 };
const PLAYER_MON = { x: 72, y: 80 };

/** pret GetBattlerSpriteFinal_Y (a3=TRUE / BATTLER_COORD_Y_PIC_OFFSET). */
const SPECIES_CASTFORM = 385;
// pokefirered/src/battle_anim_mons.c:48  ({ [0] = 17, 9, 9, 8 }: keys 0..3)
const CASTFORM_FRONT_Y: number[] = [17, 9, 9, 8];
// pokefirered/src/battle_anim_mons.c:56
const CASTFORM_ELEV: number[] = [13, 14, 13, 13];
// pokefirered/src/battle_anim_mons.c:65
const CASTFORM_BACK_Y: number[] = [0, 0, 0, 0];

// Lua: ui.lua:88
function live_battler(side: any): [any, any] {
  const st = truthy(Battle) ? Battle._st : Battle;
  let b: any;
  if (typeof side === "number") {
    b = truthy(st)
      ? orl(
        () => side === 0 && st.player,
        () => side === 1 && st.enemy,
        () => truthy(st.battlers) ? st.battlers[side] : st.battlers,
      )
      : st;
  } else {
    b = truthy(st) ? st[side] : st;
  }
  if (truthy(Anim) && truthy(Anim.shownBattler)) b = Anim.shownBattler(side, b);
  return [b, st];
}

// pokefirered/src/battle_gfx_sfx_util.c:1000
// Lua: ui.lua:103
function castform_form(side: any, battler: any): number {
  const pres = truthy(Anim) && truthy(Anim._present) ? Anim._present[side] : undefined;
  if (!(truthy(pres) && truthy(battler) && pres.castformForm != null)) return 0;
  if (pres.castformMon != null && pres.castformMon !== battler.mon) return 0;
  const f = lmod((tonumber(pres.castformForm) ?? 0), 128);
  if (f < 0 || f > 3) return 0;
  return f;
}
Ui.castformForm = castform_form;

// pokefirered/src/pokemon.c:6247
// Lua: ui.lua:115
function shows_ghost(side: any, st: any): boolean {
  if (side !== "enemy" || !(truthy(st) && truthy(st.ghostBattle))) return false;
  const pres = truthy(Anim) && truthy(Anim._present) ? Anim._present.enemy : undefined;
  return !(truthy(pres) && truthy(pres.ghostUnveiled));
}
Ui.showsGhost = shows_ghost;

// Lua: ui.lua:123
function is_double(st?: any): boolean {
  st = lor(st, Ui._st);
  return isTable(st) && st.double === true;
}

// Lua: ui.lua:128
function battler_sprite_center(side: any, species?: any, base?: any, form?: any, ghost?: any): [number, number] {
  if (typeof side === "number") {
    const id = side;
    side = (lmod(id, 2) === 0) ? "player" : "enemy";
    const [, st] = live_battler(id);
    if (!truthy(base)) base = PicCoords.battlerCoords(is_double(st), id);
    if (is_double(st) && side === "player" && truthy(species)) {
      const sp = (tonumber(species) ?? 0);
      let yo = (truthy(PicCoords.back) ? PicCoords.back[sp] : undefined) ?? 0;
      if (sp === SPECIES_CASTFORM) yo = CASTFORM_BACK_Y[form ?? 0] ?? 0;
      // pokefirered/src/battle_anim_mons.c:252
      const y = Math.min(base.y + yo + 8, 160 - 64 + 8);
      return [base.x, y - 4];
    }
  }
  let cx = base.x;
  let cy = (side === "player") ? (base.y - 4) : base.y;
  if (!truthy(species)) return [cx, cy];
  const sp = (tonumber(species) ?? 0);
  if (ghost == null || (form == null && sp === SPECIES_CASTFORM)) {
    const [b, st] = live_battler(side);
    if (ghost == null) ghost = shows_ghost(side, st);
    if (form == null && sp === SPECIES_CASTFORM) form = castform_form(side, b);
  }
  if (side === "player") {
    let yo = (truthy(PicCoords.back) ? PicCoords.back[sp] : undefined) ?? 0;
    if (sp === SPECIES_CASTFORM) yo = CASTFORM_BACK_Y[form ?? 0] ?? 0;
    cy = base.y + yo + 4; // shifted up 4px
  } else if (truthy(ghost)) {
    // pokefirered/src/battle_anim_mons.c:297
    cy = base.y;
  } else {
    let yo = (truthy(PicCoords.front) ? PicCoords.front[sp] : undefined) ?? 0;
    let elev = (truthy(PicCoords.elev) ? PicCoords.elev[sp] : undefined) ?? 0;
    if (sp === SPECIES_CASTFORM) {
      yo = CASTFORM_FRONT_Y[form ?? 0] ?? yo;
      elev = CASTFORM_ELEV[form ?? 0] ?? elev;
    }
    cy = base.y + yo - elev;
  }
  return [cx, cy];
}
Ui.battlerSpriteCenter = battler_sprite_center;

// pokefirered/src/battle_gfx_sfx_util.c:328, :715
// Lua: ui.lua:172
function pic_args(battler: any, sp: any): [any, boolean, any] {
  const mon = truthy(battler) ? battler.mon : battler;
  let personality = truthy(mon) ? mon.personality : mon;
  const tf = truthy(battler) ? battler.expTransform : battler;
  if (truthy(tf) && tonumber(tf.species) === tonumber(sp) && tf.personality != null) {
    personality = tf.personality;
  }
  return [Pokemon.picSpecies(sp, personality), Pokemon.isShiny(mon), personality];
}
Ui.picArgs = pic_args;

// Lua: ui.lua:183
Ui.sidePicArgs = function (side: any, sp: any): [any, boolean, any] {
  return pic_args(live_battler(side)[0], sp);
};

// Lua: ui.lua:187
Ui.battlerPic = function (side: any, battler?: any, species?: any): [any, number, boolean] {
  const [b, st] = live_battler(side);
  if (typeof side === "number") side = (lmod(side, 2) === 0) ? "player" : "enemy";
  battler = lor(battler, b);
  if (shows_ghost(side, st) && truthy(Pokemon.ghostPic)) {
    const g = Pokemon.ghostPic();
    if (truthy(g)) return [g, 0, true];
  }
  const sp = lor(tonumber(species), truthy(battler) ? tonumber(battler.species) : battler);
  if (!truthy(sp)) return [undefined, 0, false];
  const form = (sp === SPECIES_CASTFORM) ? castform_form(side, battler) : 0;
  const [picSp, shiny, personality] = pic_args(battler, sp);
  let entry: any;
  if (side === "player" && truthy(Pokemon.backPic)) entry = Pokemon.backPic(picSp, form, shiny);
  if (!truthy(entry) && truthy(Pokemon.frontPic)) entry = Pokemon.frontPic(picSp, form, shiny, personality);
  return [entry, form, false];
};

// Lua: ui.lua:205
Ui.reset = function (opts?: any): void {
  opts = lor(opts, {});
  Ui._caughtDexScene = undefined;
  Ui._timed = undefined;
  Ui._linger = false;
  Ui._queue = seq();
  Ui._showing = false;
  Ui._headless = truthy(opts.headless) ? true : false;
  Ui._log = seq();
  Ui._mode = "none";
  Ui._menuIndex = 1;
  Ui._moveIndex = 1;
  Ui._moveIndexBattler = undefined;
  Ui._menuLabels = {};
  Ui._promptFor = undefined;
  Ui._promptText = undefined;
  Ui._st = undefined;
  Ui._pendingCommand = undefined;
  Ui._pendingYesNo = undefined;
  Ui._active = 0;
  Ui._actionCursor = {};
  Ui._moveCursor = {};
  Ui._moveCursorMon = {};
  Ui._swap = undefined;
  Ui._target = undefined;
  Ui._bounce = { hb: {}, mon: {} };
  Ui._preview = undefined;
  Ui._partnerAction = undefined;
  Ui._oak = undefined;
  Ui._oakTexts = undefined;
  Ui._oakLit = undefined;
  Ui._oakShown = undefined;
  Ui._oldManTimer = undefined;
  Ui._oldManSubstate = undefined;
  if (truthy(Message) && truthy(Message.isHeld) && Message.isHeld()) Message.close();
  if (!Ui._headless) {
    let okC = true;
    let errC: unknown;
    try {
      BattleChrome.install(undefined);
    } catch (e) {
      okC = false;
      errC = e;
    }
    if (!okC && !chromeInstallWarned) {
      chromeInstallWarned = true;
      console.log("[game3/battle.ui] BattleChrome.install failed: " + tostring(errC instanceof Error ? errC.message : errC));
    }
  }
};

// Lua: ui.lua:249
Ui.bindState = function (st: any, session?: any): void {
  Ui._st = st;
  if (session != null) Ui._session = session;
};

// Lua: ui.lua:254
Ui.bindSession = function (session: any): void {
  Ui._session = session;
};

// pokefirered/src/battle_controller_oak_old_man.c:647
// Lua: ui.lua:259
Ui.markVoiceover = function (text: any, opts?: any): void {
  if (typeof text !== "string" || text === "") return;
  Ui._oakTexts = lor(Ui._oakTexts, {}) as Record<string, boolean>;
  Ui._oakTexts[text] = true;
  if (truthy(opts) && truthy(opts.litHealthbox)) {
    // pokefirered/src/battle_controller_pokedude.c:2586 PokedudeAction_PrintMessageWithHealthboxPals
    Ui._oakLit = lor(Ui._oakLit, {}) as Record<string, boolean>;
    Ui._oakLit[text] = true;
  }
};

// Lua: ui.lua:270
Ui.litHealthboxShown = function (): boolean {
  return Ui._oakShown != null && Ui._oakLit != null && Ui._oakLit[Ui._oakShown] === true;
};

// Lua: ui.lua:274
Ui.isVoiceoverText = function (text: any): boolean {
  return typeof text === "string" && Ui._oakTexts != null && Ui._oakTexts[text] === true;
};

// Lua: ui.lua:278
Ui.push = function (text: any, cb?: Fn | null): void {
  if (!truthy(text) || text === "") {
    if (truthy(cb)) cb!();
    return;
  }
  // pokefirered/src/battle_message.c:2773
  if (truthy(Ui._st) && (truthy(Ui._st.pokedude) || truthy(Ui._st.link)) && typeof text === "string" && !Ui.isVoiceoverText(text)) {
    return Ui.pushTimed(text, POKEDUDE_AUTO_SCROLL, cb);
  }
  Ui._log[len(Ui._log) + 1] = text;
  if (Ui.isVoiceoverText(text)) {
    Ui._queue[len(Ui._queue) + 1] = { text, cb, oak: true };
  } else if (truthy(cb) || isTable(text)) {
    Ui._queue[len(Ui._queue) + 1] = { text, cb };
  } else {
    Ui._queue[len(Ui._queue) + 1] = text;
  }
};

// pokefirered/src/battle_script_commands.c:2041
// Lua: ui.lua:298
Ui.pushTimed = function (text: any, waitFrames?: number | null, cb?: Fn | null): void {
  if (!truthy(text) || text === "") {
    if (truthy(cb)) cb!();
    return;
  }
  // pokefirered/src/battle_controller_oak_old_man.c:780
  if (Ui.isVoiceoverText(text)) return Ui.push(text, cb);
  Ui._log[len(Ui._log) + 1] = text;
  Ui._queue[len(Ui._queue) + 1] = { text, cb, timed: true, wait: lor(waitFrames, 64) };
};

// Lua: ui.lua:309
function message_blocking(): boolean {
  if (!(truthy(Message) && truthy(Message.isOpen) && Message.isOpen())) return false;
  if (truthy(Message.isHeld) && Message.isHeld()) return false;
  return !Ui._linger;
}

// pokefirered/src/battle_controller_oak_old_man.c:759
const OAK_DIM_TARGET = 8;
const OAK_DIM_DELAY = 4;

// Lua: ui.lua:319
function oak_state(): any {
  let f = Ui._oak;
  if (!truthy(f)) {
    f = { y: 0, target: 0, counter: 0, pending: undefined };
    Ui._oak = f;
  }
  return f;
}

// Lua: ui.lua:328
Ui.voiceoverDim = function (): number {
  const f = Ui._oak;
  if (!truthy(f) || f.y <= 0) return 0;
  return f.y / 16;
};

// Lua: ui.lua:334
Ui.busy = function (): boolean {
  if (Ui._headless) return false;
  if (truthy(Choice) && truthy(Choice.active)) return true;
  if (truthy(Ui._timed)) return true;
  if (message_blocking()) return true;
  if (Ui._showing) return true;
  if (len(Ui._queue) > 0) return true;
  if (truthy(Ui._oak) && (truthy(Ui._oak.pending) || Ui._oak.y > 0)) return true;
  return false;
};

/** True while battle text is queued or on screen (intro / turn messages). */
// Lua: ui.lua:346
Ui.dialogPending = function (): boolean {
  if (Ui._headless) return false;
  if (truthy(Ui._timed)) return true;
  if (message_blocking()) return true;
  if (Ui._showing) return true;
  if (truthy(Ui._oak) && (truthy(Ui._oak.pending) || Ui._oak.y > 0)) return true;
  return len(Ui._queue) > 0;
};

/** YES/NO during award/learn (Choice.yesNo). cb(true|false) */
// Lua: ui.lua:356
Ui.askYesNo = function (a: any, b?: any): void {
  const cb: Fn | undefined = (typeof a === "function") ? a : b;
  const prompt: string | undefined = (typeof a === "string") ? a : undefined;
  if (Ui._headless) {
    if (truthy(cb)) cb!(false);
    return;
  }
  if (!truthy(Choice)) {
    if (truthy(cb)) cb!(false);
    return;
  }
  if (truthy(prompt) && prompt !== "" && truthy(Message) && truthy(Message.show)) {
    Ui._log[len(Ui._log) + 1] = prompt;
    Message.show(prompt, { frame: "battle", battle: true, stay: true });
    // pokefirered/data/battle_scripts_1.s:3127
    Ui._pendingYesNo = lor(cb, false);
    return;
  }
  Choice.yesNo(cb, BATTLE_YESNO);
};

// Lua: ui.lua:377
function open_pending_yesno(): boolean {
  if (Ui._pendingYesNo == null) return false;
  if (!(truthy(Message) && truthy(Message.isOpen) && Message.isOpen())) {
    Ui._pendingYesNo = undefined;
    return false;
  }
  if (!(truthy(Message.isWaiting) && Message.isWaiting())) return true;
  const cb = Ui._pendingYesNo;
  Ui._pendingYesNo = undefined;
  // pokefirered/data/battle_scripts_1.s:3129
  Choice.yesNo((yes: boolean) => {
    if (Message.isOpen() && truthy(Message.close)) Message.close();
    if (truthy(cb)) cb(yes);
  }, BATTLE_YESNO);
  return true;
}

// Lua: ui.lua:394
Ui.yesNoPending = function (): boolean {
  return Ui._pendingYesNo != null;
};

/** Multi-choice forget list. cb(0-based index) or cb(-1)/cb(127) on cancel. */
// Lua: ui.lua:399
Ui.askForget = function (labels: any, cb?: Fn | null, ctx?: any): void {
  if (Ui._headless) {
    if (truthy(cb)) cb!(-1);
    return;
  }
  if (truthy(ctx) && truthy(ctx.mon)) {
    // pcall(require, "src.ui.game3.summary_menu"): linked in, always loads.
    if (truthy(SummaryMenu) && truthy(SummaryMenu.openMenu)) {
      // pokefirered/src/battle_script_commands.c:5194
      SummaryMenu.openMenu(seq(ctx.mon), 1, {
        mode: "select_move",
        moveToLearn: ctx.moveId,
        onSelectMove: (slotIdx: any) => {
          if (truthy(cb)) cb!(slotIdx);
        },
      });
      return;
    }
  }
  if (!truthy(Choice)) {
    if (truthy(cb)) cb!(-1);
    return;
  }
  Choice.multi(labels, 0, cb ?? undefined, { left: 14, top: 2 });
};

// Lua: ui.lua:425
Ui.choiceActive = function (): boolean {
  return truthy(Choice) && Choice.active;
};

// Lua: ui.lua:429
Ui.waitingForCommand = function (): boolean {
  return Ui._mode === "menu" || Ui._mode === "moves" || Ui._mode === "bag" || Ui._mode === "target";
};

// Lua: ui.lua:433
function restore_action_menu(): void {
  Ui._mode = "menu";
  Ui._linger = false;
  Ui._timed = undefined;
  Ui._showing = false;
  if (truthy(Message) && truthy(Message.open)) Message.reset();
}

// pokefirered/src/battle_main.c:3182 BattleScript_ActionSelectionItemsCantBeUsed
// Lua: ui.lua:442
Ui.refuseItems = function (): void {
  Ui._selCmd = undefined;
  Ui._selReturn = "menu";
  Ui._mode = "selmsg";
  Ui.push(BattleText.get("STRINGID_ITEMSCANTBEUSEDNOW"));
};

// pokeemerald/data/battle_scripts_1.s:4547 BattleScript_AskIfWantsToForfeitMatch
// Lua: ui.lua:450
function confirm_link_forfeit(act: any): void {
  if (Ui._headless || !truthy(Choice)) {
    Ui._pendingCommand = act;
    Ui._mode = "none";
    return;
  }
  Ui._selCmd = undefined;
  Ui._selReturn = "menu";
  Ui._mode = "selmsg";
  // pokeemerald/src/battle_message.c:1422
  Ui.askYesNo(Strings("Would you like to forfeit the match\nand quit now?"), (yes: boolean) => {
    if (truthy(yes)) Ui._selCmd = act;
  });
}

// Lua: ui.lua:465
function is_frontier_forfeit(st: any): boolean {
  return truthy(st) && !truthy(st.wild) && (Kinds.has(st, "frontier") || Kinds.has(st, "trainerHill"));
}

// Lua: ui.lua:470
function open_battle_bag(): void {
  if (truthy(Ui._st) && truthy(Ui._st.link)) return Ui.refuseItems();
  const session = lor(Ui._session, runtime_session());
  // package.loaded / pcall(require, "src.core.game3.rse.frontier.pyramid"):
  // no file in the port, so G3Lazy has no entry (Brian's failed require).
  const Pyramid = G3Lazy["src.core.game3.rse.frontier.pyramid"];
  if (truthy(session) && truthy(Pyramid) && truthy(Pyramid.inPyramid) && Pyramid.inPyramid(session)) {
    // pokeemerald/src/battle_pyramid_bag.c:379
    Ui._mode = "bag";
    // NOT FAITHFUL: Emerald only (src.ui.game3.rse.pyramid_bag has no file;
    // a plain require of it fails).
    const PyramidBag = G3Lazy["src.ui.game3.rse.pyramid_bag"];
    if (!truthy(PyramidBag)) notPorted('require("src.ui.game3.rse.pyramid_bag") (Emerald only)');
    PyramidBag.show({
      session,
      location: "battle",
      onUse: (itemId: any) => {
        Ui._pendingCommand = { kind: "bag", user: "player", itemId, usedInMenu: true };
        if (is_double()) Ui._pendingCommand.battler = Ui._active ?? 0;
        Ui._mode = "none";
      },
      onClose: () => {
        if (Ui._mode === "bag") restore_action_menu();
      },
    });
    return;
  }
  const bag = truthy(session) ? session.bag : session;
  if (!truthy(bag)) {
    Ui.push(Strings("The BAG is empty."));
    restore_action_menu();
    return;
  }
  Ui._mode = "bag";
  BagMenu.show(bag, {
    session,
    battle: true,
    onBattleUse: (itemId: any, partySlot: any, moveSlot: any, usedInMenu: any) => {
      if (itemId == null) {
        restore_action_menu();
        return;
      }
      if (truthy(usedInMenu) && truthy(Ui._st)) {
        // pokefirered/src/reshow_battle_screen.c:299
        Anim.syncDisplayFromState(Ui._st);
      }
      Ui._pendingCommand = {
        kind: "bag",
        user: "player",
        itemId,
        partySlot,
        moveSlot,
        usedInMenu: truthy(usedInMenu) ? usedInMenu : undefined,
      };
      if (is_double()) Ui._pendingCommand.battler = Ui._active ?? 0;
      Ui._mode = "none";
    },
    onClose: () => {
      if (Ui._mode === "bag") {
        restore_action_menu();
      }
    },
  });
}
Ui.openBattleBag = open_battle_bag;

// Lua: ui.lua:537
Ui.isShowing = function (): boolean {
  return Ui._showing || Ui.busy() || (truthy(Message) && truthy(Message.isOpen) && Message.isOpen());
};

// Lua: ui.lua:541
function active_battler(st?: any): any {
  st = lor(st, Ui._st);
  if (!truthy(st)) return undefined;
  const id = Ui._active ?? 0;
  if (id === 0) return st.player;
  return truthy(st.battlers) ? st.battlers[id] : st.battlers;
}
Ui.activeBattlerObject = active_battler;

// Lua: ui.lua:550
Ui.activeBattler = function (): number {
  return Ui._active ?? 0;
};

// pokefirered/src/party_menu.c:5981
// Lua: ui.lua:555
Ui.multiPartyOrder = function (st: any): LuaTable {
  const own = (tonumber(st.linkOwn) ?? 0);
  const owners = lor(truthy(st.partyOwner) ? st.partyOwner.player : st.partyOwner, {});
  const lead: Record<number, any> = {};
  for (const id of [own, lmod(own + 2, 4)]) {
    const b = State.battler(st, id);
    lead[id] = lor(truthy(b) ? tonumber(b.partyIndex) : b, undefined);
  }
  const order = seq();
  const used: Record<number, boolean> = {};
  const add = (i: any): void => {
    if (truthy(i) && truthy(st.playerParty[i]) && !truthy(used[i])) {
      used[i] = true;
      order[len(order) + 1] = i;
    }
  };
  add(lead[own]);
  add(lead[lmod(own + 2, 4)]);
  for (const id of [own, lmod(own + 2, 4)]) {
    for (let i = 1; i <= len(st.playerParty); i++) {
      if (owners[i] === id) add(i);
    }
  }
  for (let i = 1; i <= len(st.playerParty); i++) add(i);
  return order;
};

// Lua: ui.lua:581
Ui.battlePartyOrder = function (st: any): LuaTable {
  if (truthy(st) && truthy(st.multi) && truthy(st.playerParty)) return Ui.multiPartyOrder(st);
  return PartyMenu.battleOrder(st);
};

// Lua: ui.lua:586
Ui.allySlots = function (st: any, order?: LuaTable | null): Record<number, boolean> | undefined {
  if (!(truthy(st) && truthy(st.multi) && truthy(st.partyOwner))) return undefined;
  const own = (tonumber(st.linkOwn) ?? 0);
  const out: Record<number, boolean> = {};
  for (const [view, i] of ipairs(lor(order, {}))) {
    if (st.partyOwner.player[i] !== own) out[view] = true;
  }
  return out;
};

// Lua: ui.lua:596
Ui.openPartyMenu = function (st: any, battlerId?: any, opts?: any): void {
  opts = lor(opts, {});
  st = lor(st, Ui._st);
  const session = lor(Ui._session, runtime_session());
  const party = orl(() => truthy(st) && st.playerParty, () => truthy(session) && session.party, () => ({}));
  const overlay = truthy(session) ? session.move_overlay : session;
  const id = (tonumber(battlerId) ?? 0);
  const forced = truthy(opts.forced) ? true : false;
  if (truthy(st) && truthy(st.playerParty)) {
    for (const bid of [0, 2]) {
      const b = orl(
        () => bid === 0 && st.player,
        () => truthy(st.double) && truthy(st.battlers) && st.battlers[bid],
      );
      if (truthy(b)) State.syncBattlerToParty(b, st.playerParty);
    }
  }
  const order = (truthy(st) && truthy(st.playerParty)) ? lor(Ui.battlePartyOrder(st), undefined) : undefined;
  const own = orl(
    () => truthy(st) && truthy(st.multi) && State.battler(st, (tonumber(st.linkOwn) ?? 0)),
    () => truthy(st) && st.player,
  );
  PartyMenu.show(party, overlay, {
    mode: forced ? "battle_faint" : "battle_switch",
    layout: (truthy(st) && truthy(st.double)) ? "double" : undefined,
    // pokefirered/src/party_menu.c:1048
    multi: Ui.allySlots(st, order),
    battleOrder: order,
    session,
    activeSlot: lor(truthy(own) ? own.partyIndex : own, 1),
    battle: true,
    validate: (pi: any) => {
      if (truthy(opts.validate)) return opts.validate(pi);
      if (truthy(st) && truthy(st.double)) return Commands.switchError(st, pi, forced, id);
      return Commands.switchError(st, pi, forced);
    },
    onSelect: (pi: any) => {
      if (truthy(opts.onSelect)) opts.onSelect(pi);
    },
    onClose: opts.onClose,
  });
};

// Lua: ui.lua:636
function open_battle_party_double(): void {
  const id = Ui._active ?? 0;
  Ui._mode = "party";
  Ui.openPartyMenu(Ui._st, id, {
    onSelect: (slot: any) => {
      if (slot == null) {
        restore_action_menu();
        return;
      }
      Ui._pendingCommand = {
        kind: "switch",
        user: "player",
        battler: id,
        slot,
      };
      Ui._mode = "none";
    },
    onClose: () => {
      if (Ui._mode === "party") {
        restore_action_menu();
      }
    },
  });
}

// Lua: ui.lua:661
function open_battle_party(): void {
  if (is_double()) return open_battle_party_double();
  const session = lor(Ui._session, runtime_session());
  if (truthy(Ui._st) && truthy(Ui._st.player) && truthy(Ui._st.playerParty)) {
    State.syncBattlerToParty(Ui._st.player, Ui._st.playerParty);
  }
  const party = orl(() => truthy(Ui._st) && Ui._st.playerParty, () => truthy(session) && session.party);
  const overlay = truthy(session) ? session.move_overlay : session;
  const activeSlot = lor(truthy(Ui._st) && truthy(Ui._st.player) ? Ui._st.player.partyIndex : undefined, 1);
  Ui._mode = "party";
  PartyMenu.show(party, overlay, {
    mode: "battle_switch",
    session,
    activeSlot,
    battle: true,
    validate: (slot: any) => Commands.switchError(Ui._st, slot),
    onSelect: (slot: any) => {
      if (slot == null || slot === activeSlot) {
        restore_action_menu();
        return;
      }
      Ui._pendingCommand = {
        kind: "switch",
        user: "player",
        slot,
      };
      Ui._mode = "none";
    },
    onClose: () => {
      if (Ui._mode === "party") {
        restore_action_menu();
      }
    },
  });
}

// Lua: ui.lua:701
Ui.openMenu = function (battlerId?: any, opts?: any): void {
  if (truthy(Ui._st) && truthy(Ui._st.spectate)) {
    Ui._mode = "none";
    Ui._pendingCommand = undefined;
    return;
  }
  Ui._linger = false;
  Ui._timed = undefined;
  Ui._mode = "menu";
  Ui._target = undefined;
  Ui._active = (tonumber(battlerId) ?? 0);
  Ui._partnerAction = (truthy(opts) && truthy(opts.partnerAction)) ? opts.partnerAction : undefined;
  if (is_double()) {
    // pokefirered/src/battle_controller_player.c:2421
    Ui._menuIndex = lor(Ui._actionCursor[Ui._active], 1);
  } else {
    Ui._menuIndex = 1;
  }
  Ui._pendingCommand = undefined;
  Ui._wally = undefined;
  if (Wally.active(Ui._st)) {
    // pokeemerald/src/battle_controller_wally.c:1203
    if (Ui._headless) {
      Ui._pendingCommand = Wally.take(Ui._st)[0];
      Ui._mode = "none";
    } else {
      Ui._wally = { timer: 0, sub: 0 };
    }
  }
  if (truthy(Ui._st) && truthy(Ui._st.oldManTutorial)) {
    Ui._oldManTimer = 0;
    Ui._oldManSubstate = 0;
    if (Ui._headless) {
      Ui._pendingCommand = { kind: "bag", itemId: 4, user: "player" };
      Ui._mode = "none";
    }
  }
  if (truthy(Message) && truthy(Message.open)) {
    Message.reset();
  }
  Ui._showing = false;
  const pb = !is_double() && truthy(Ui._st) ? Ui._st.player : undefined;
  if (truthy(pb) && (truthy(pb.expLockedMove) || truthy(pb.expMustRecharge))) {
    // pokefirered/src/battle_main.c:3125
    const slot = lor(pb.expLockedSlot, 1);
    const mon = lor(pb.mon, {});
    Ui._pendingCommand = {
      kind: "move", user: "player", slot,
      move: orl(() => pb.expLockedMove, () => pb.lastMoveId, () => pb.lastMove,
        () => truthy(mon.moves) ? mon.moves[slot] : mon.moves),
    };
    Ui._mode = "none";
  }
};

// Lua: ui.lua:754
Ui.clearLinger = function (): void {
  if (Ui._linger && truthy(Message) && truthy(Message.close)) Message.close();
  Ui._linger = false;
};

// Lua: ui.lua:759
Ui.selectionPump = function (): boolean {
  if (Ui._mode !== "selmsg") return false;
  if (truthy(Choice) && truthy(Choice.active)) return false;
  if (!Ui.pump()) return true;
  if (truthy(Ui._selCmd)) {
    Ui._pendingCommand = Ui._selCmd;
    Ui._selCmd = undefined;
    Ui._mode = "none";
  } else {
    // pokefirered/src/battle_main.c:3370
    const ret = lor(Ui._selReturn, "moves") as string;
    restore_action_menu();
    Ui._mode = ret;
  }
  Ui._selReturn = undefined;
  return true;
};

// Lua: ui.lua:777
Ui.takeCommand = function (): any {
  const c = Ui._pendingCommand;
  Ui._pendingCommand = undefined;
  if (truthy(c)) {
    // pokefirered/src/battle_controller_player.c:2809
    Ui._bounce = { hb: {}, mon: {} };
    Ui._target = undefined;
    Ui._preview = undefined;
  }
  return c;
};

// Lua: ui.lua:789
function pop_queue(): [any, Fn | undefined, any] {
  const item = remove(Ui._queue, 1);
  if (isTable(item)) return [item.text, item.cb, item];
  return [item, undefined, undefined];
}

// Lua: ui.lua:795
function show_next(): void {
  if (Ui._showing) return;
  if (len(Ui._queue) === 0) return;
  const [text, cb, item] = pop_queue();
  if (Ui._headless) {
    if (truthy(cb)) cb!();
    return;
  }
  Ui._linger = false;
  if (truthy(item) && truthy(item.oak) && truthy(Message) && truthy(Message.show)) {
    // pokefirered/src/battle_controller_oak_old_man.c:744
    Ui._showing = true;
    oak_state().pending = { text, cb };
    return;
  }
  if (truthy(item) && truthy(item.timed) && truthy(Message) && truthy(Message.show)) {
    Ui._showing = true;
    Ui._timed = { frames: 0, wait: lor(item.wait, 64), cb };
    Message.show(text, { frame: "battle", battle: true, stay: true });
    return;
  }
  if (truthy(Message) && truthy(Message.show)) {
    Ui._showing = true;
    Message.show(text, {
      frame: "battle",
      battle: true,
      done: () => {
        Ui._showing = false;
        if (truthy(cb)) cb!();
      },
    });
  } else if (truthy(cb)) {
    cb!();
  }
}

// Lua: ui.lua:831
function oak_wants_dim(): boolean {
  const f = oak_state();
  if (truthy(f.pending)) return true;
  if (truthy(Message) && truthy(Message.isOpen) && Message.isOpen()
      && truthy(Message.frameKind) && Message.frameKind() === "voiceover"
      && !(truthy(Message.isHeld) && Message.isHeld())) {
    return true;
  }
  const nxt = Ui._queue[1];
  return isTable(nxt) && nxt.oak === true;
}

// pokefirered/src/battle_controller_oak_old_man.c:793
// Lua: ui.lua:844
function drop_held_voiceover(): void {
  if (truthy(Message) && truthy(Message.isHeld) && Message.isHeld() && Message.frameKind() === "voiceover") {
    Message.close();
  }
}

// pokefirered/src/battle_controller_oak_old_man.c:744
// Lua: ui.lua:851
function tick_oak(): boolean {
  const f = oak_state();
  f.target = oak_wants_dim() ? OAK_DIM_TARGET : 0;
  if (f.y !== f.target) {
    f.counter = f.counter + 1;
    if (f.counter > OAK_DIM_DELAY) {
      f.counter = 0;
      f.y = f.y + ((f.y < f.target) ? 1 : -1);
    }
    if (f.y === 0) drop_held_voiceover();
    return true;
  }
  f.counter = 0;
  if (f.target === 0) drop_held_voiceover();
  if (truthy(f.pending)) {
    const p = f.pending;
    f.pending = undefined;
    Ui._showing = true;
    Ui._oakShown = p.text;
    Message.show(p.text, {
      frame: "voiceover",
      hold: true,
      done: () => {
        Ui._showing = false;
        Ui._oakShown = undefined;
        if (truthy(p.cb)) p.cb();
      },
    });
    return true;
  }
  return false;
}

// Lua: ui.lua:884
function tick_timed(): boolean {
  const t = Ui._timed;
  if (!truthy(t)) return false;
  const waiting = truthy(Message) && truthy(Message.isWaiting) && Message.isWaiting();
  const onLast = waiting && lor(Message._page, 1) >= len(lor(Message._pages, seq()));
  if (!onLast) {
    // pokefirered/src/text.c:537 TextPrinterWaitAutoMode
    if (waiting && truthy(Ui._st) && (truthy(Ui._st.pokedude) || truthy(Ui._st.link))) {
      t.pageFrames = lor(t.pageFrames, 0) + 1;
      if (t.pageFrames >= POKEDUDE_AUTO_SCROLL) {
        t.pageFrames = 0;
        Message.advance();
      }
    }
    return true;
  }
  t.frames = t.frames + 1;
  if (t.frames < t.wait) return true;
  Ui._timed = undefined;
  Ui._showing = false;
  Ui._linger = true;
  if (truthy(t.cb)) t.cb();
  return false;
}

// Lua: ui.lua:909
Ui.pump = function (): boolean {
  if (Ui._headless) {
    while (len(Ui._queue) > 0) {
      const [, cb] = pop_queue();
      if (truthy(cb)) cb!();
    }
    Ui._showing = false;
    Ui._timed = undefined;
    Ui._oak = undefined;
    return true;
  }
  if (tick_oak()) return false;
  if (tick_timed()) return false;
  if (open_pending_yesno()) return false;
  if (message_blocking()) {
    return false;
  }
  Ui._showing = false;
  if (len(Ui._queue) > 0) {
    show_next();
    return false;
  }
  return true;
};

// Lua: ui.lua:934
function play_select(): void {
  // pcall(function() ... Audio.playSe(SE.SE_SELECT) end): errors are swallowed.
  try {
    Audio.playSe(SE.SE_SELECT);
  } catch {
    /* pcall */
  }
}

// Lua: ui.lua:942
function grid_nav(index: any, input: any, maxN?: number): [any, boolean] {
  let c = lor(index, 1) - 1;
  if (input.wasPressed("left") || input.wasPressed("right")) {
    c = (lmod(c, 2) === 0) ? (c + 1) : (c - 1);
  } else if (input.wasPressed("up") || input.wasPressed("down")) {
    c = (c < 2) ? (c + 2) : (c - 2);
  } else {
    return [index, false];
  }
  if (c < 0 || c >= (maxN ?? 4)) return [index, false];
  return [c + 1, true];
}

// pokefirered/src/battle_controller_player.c:1381
// Lua: ui.lua:956
function move_count(mon: any): number {
  let n = 0;
  for (let i = 1; i <= 4; i++) {
    const mv = truthy(mon) && truthy(mon.moves) ? mon.moves[i] : undefined;
    if (truthy(mv) && mv !== 0 && mv !== "") n = n + 1;
  }
  if (n < 1) n = 1;
  return n;
}

const SWAP_DIRS = ["left", "right", "up", "down"];

// pokeemerald/src/battle_controller_player.c:599
// Lua: ui.lua:967
function move_swap_input(input: any, st: any, battler: any, id: any): boolean {
  const sw = Ui._swap;
  const cur = lor(Ui._moveIndex, 1) - 1;
  if (!truthy(sw)) {
    if (input.wasPressed("select") && MoveSwap.canStart(st, battler)) {
      Ui._swap = { cursor: MoveSwap.initialCursor(cur) };
      return true;
    }
    return false;
  }
  if (input.wasPressed("a") || input.wasPressed("select")) {
    play_select();
    if (sw.cursor !== cur) MoveSwap.apply(battler, cur + 1, sw.cursor + 1);
    Ui._moveIndex = sw.cursor + 1;
    if (truthy(id)) Ui._moveCursor[id] = Ui._moveIndex;
    Ui._swap = undefined;
  } else if (input.wasPressed("b")) {
    play_select();
    Ui._swap = undefined;
  } else {
    const n = MoveSwap.moveCount(truthy(battler) ? battler.mon : battler);
    for (const dir of SWAP_DIRS) {
      if (input.wasPressed(dir)) {
        const nc = MoveSwap.step(sw.cursor, dir, n);
        if (nc !== sw.cursor) {
          sw.cursor = nc;
          play_select();
        }
        break;
      }
    }
  }
  return true;
}

// pokefirered/src/battle_main.c:2380
// Lua: ui.lua:1004
function open_move_menu(): void {
  Ui._swap = undefined;
  if (is_double()) {
    const id = Ui._active ?? 0;
    const battler = active_battler();
    const mon = truthy(battler) ? battler.mon : battler;
    if (mon !== Ui._moveCursorMon[id]) {
      Ui._moveCursorMon[id] = mon;
      Ui._moveCursor[id] = 1;
    }
    const n = move_count(mon);
    let idx = (tonumber(Ui._moveCursor[id]) ?? 1);
    if (idx < 1) idx = 1;
    if (idx > n) idx = n;
    Ui._moveCursor[id] = idx;
    Ui._moveIndex = idx;
    Ui._mode = "moves";
    return;
  }
  const battler = truthy(Ui._st) ? Ui._st.player : Ui._st;
  if (battler !== Ui._moveIndexBattler) {
    Ui._moveIndexBattler = battler;
    Ui._moveIndex = 1;
  }
  const n = move_count(truthy(battler) ? battler.mon : battler);
  let idx = (tonumber(Ui._moveIndex) ?? 1);
  if (idx < 1) idx = 1;
  if (idx > n) idx = n;
  Ui._moveIndex = idx;
  Ui._mode = "moves";
}
Ui._openMoveMenu = open_move_menu;

const MT = { SELECTED: 0, DEPENDS: 1, USER_OR_SELECTED: 2, RANDOM: 4, BOTH: 8, USER: 16, FOES_AND_ALLY: 32, OPPONENTS_FIELD: 64 };
const MOVE_CURSE = 174;
const TYPE_GHOST = 7;
const ITEM_PREMIER_BALL = 12;
// pokefirered/src/battle_controller_player.c:171
const TARGET_IDENTITIES = seq(0, 2, 3, 1) as number[];

// Lua: ui.lua:1044
function band(a: any, b: any): number {
  return ((tonumber(a) ?? 0)) & ((tonumber(b) ?? 0));
}

// Lua: ui.lua:1049
function move_num(mv: any): number {
  const n = tonumber(mv);
  if (truthy(n)) return n!;
  if (mv == null || mv === "") return 0;
  if (truthy(Moves.numForName)) {
    const norm = truthy(Moves.normalizeId) ? lor(Moves.normalizeId(mv), mv) : mv;
    return lor(Moves.numForName(norm), 0) as number;
  }
  return 0;
}

// Lua: ui.lua:1060
function is_type(b: any, t: number): boolean {
  return truthy(b) && (tonumber(b.type1) === t || tonumber(b.type2) === t);
}

// pokefirered/src/battle_controller_player.c:444
// Lua: ui.lua:1065
function move_target_type(battler: any, mv: any): number {
  if (move_num(mv) === MOVE_CURSE) {
    return is_type(battler, TYPE_GHOST) ? MT.SELECTED : MT.USER;
  }
  const def: any = truthy(mv) ? Moves.get(mv) : mv;
  return lor(tonumber(truthy(def) ? def.target : def), 0) as number;
}
Ui.moveTargetType = move_target_type;

// Lua: ui.lua:1074
function absent(st: any, id: number): boolean {
  if (!truthy(st)) return true;
  if (truthy(st.absent) && truthy(st.absent[id])) return true;
  const b = orl(
    () => id === 0 && st.player,
    () => id === 1 && st.enemy,
    () => truthy(st.battlers) ? st.battlers[id] : st.battlers,
  );
  return b == null;
}

// pokefirered/src/pokemon.c:2651
// Lua: ui.lua:1082
function count_except_active(st: any, id: number): number {
  let n = 0;
  for (let i = 0; i <= 3; i++) {
    if (i !== id && !absent(st, i)) n = n + 1;
  }
  return n;
}

// pokefirered/src/battle_controller_player.c:437
// Lua: ui.lua:1091
Ui.targetSelection = function (st: any, idIn: any, slot: any): [boolean, number, number] {
  st = lor(st, Ui._st);
  const id = (tonumber(idIn) ?? 0);
  const b = orl(() => id === 0 && st.player, () => truthy(st.battlers) ? st.battlers[id] : st.battlers);
  const mon = truthy(b) ? b.mon : b;
  const mv = truthy(mon) && truthy(mon.moves) ? mon.moves[slot] : undefined;
  const tt = move_target_type(b, mv);
  const opposingLeft = (lmod(id, 2) === 0) ? 1 : 0;
  let cursor = (band(tt, MT.USER) !== 0) ? id : opposingLeft;
  if (!(truthy(st) && truthy(st.double))) return [false, cursor, cursor];
  let can = band(tt, MT.RANDOM + MT.BOTH + MT.DEPENDS + MT.FOES_AND_ALLY + MT.OPPONENTS_FIELD + MT.USER) === 0;
  const pp = truthy(mon) && truthy(mon.pp) ? tonumber(mon.pp[slot]) : undefined;
  if (pp != null && pp === 0) {
    can = false;
  } else if (band(tt, MT.USER + MT.USER_OR_SELECTED) === 0 && count_except_active(st, id) <= 1) {
    // pokefirered/src/pokemon.c:2686
    cursor = absent(st, opposingLeft) ? (opposingLeft + 2) : opposingLeft;
    can = false;
  }
  if (!can) return [false, cursor, cursor];
  let start: number;
  if (band(tt, MT.USER + MT.USER_OR_SELECTED) !== 0) {
    start = id;
  } else if (absent(st, opposingLeft)) {
    start = opposingLeft + 2;
  } else {
    start = opposingLeft;
  }
  return [true, cursor, start];
};

// pokefirered/src/battle_main.c:2091
// Lua: ui.lua:1123
function start_bounce(kind: "hb" | "mon", id: number, delta: number, amp: number): void {
  const t = Ui._bounce[kind];
  if (truthy(t[id])) return;
  t[id] = { idx: (kind === "hb") ? 128 : 192, delta, amp, y: 0, fresh: true };
}

// pokefirered/src/battle_main.c:2132
// Lua: ui.lua:1130
function end_bounce(kind: "hb" | "mon", id: number): void {
  delete Ui._bounce[kind][id];
}

// Lua: ui.lua:1134
function end_all_bounces(): void {
  Ui._bounce = { hb: {}, mon: {} };
}

// pokefirered/src/trig.c:4
// Lua: ui.lua:1139
function sin_q8(idx: number, amp: number): number {
  const v = Math.floor(Math.sin(lmod(idx, 256) * Math.PI / 128) * 256 + 0.5);
  return Math.floor(v * amp / 256);
}

const BOUNCE_KINDS: ("hb" | "mon")[] = ["hb", "mon"];

// pokefirered/src/battle_main.c:2159
// Lua: ui.lua:1145
function tick_bounces(): void {
  for (const kind of BOUNCE_KINDS) {
    const t = Ui._bounce[kind];
    for (const k in t) {
      const bo = t[k as any];
      if (bo == null) continue;
      if (bo.fresh) {
        bo.fresh = false;
        bo.y = 0;
      } else {
        bo.y = sin_q8(bo.idx, bo.amp) + bo.amp;
        bo.idx = lmod(bo.idx + bo.delta, 256);
      }
    }
  }
}

// Lua: ui.lua:1159
Ui.bounceOffset = function (kind: string, id: any): number {
  const t = (Ui._bounce as any)[kind];
  const bo = truthy(t) ? t[id] : t;
  return truthy(bo) ? bo.y : 0;
};

const PREVIEW_ALL: Record<number, boolean> = { 114: true, 201: true, 195: true, 240: true, 241: true, 258: true, 300: true, 346: true };
const PREVIEW_ALLIES: Record<number, boolean> = { 219: true, 115: true, 113: true, 54: true, 215: true, 312: true };
const MOVE_HELPING_HAND = 270;

// pokefirered/src/battle_controller_player.c:2889
// Lua: ui.lua:1169
function preview_targets(st: any, id: number, slot: any): [Record<number, boolean>, number] {
  const b = active_battler(st);
  const mv = truthy(b) && truthy(b.mon) && truthy(b.mon.moves) ? b.mon.moves[slot] : undefined;
  const tt = move_target_type(b, mv);
  const num = move_num(mv);
  const partner = lmod(id + 2, 4);
  if (tt === MT.SELECTED || tt === MT.DEPENDS || tt === MT.USER_OR_SELECTED || tt === MT.RANDOM) {
    return [{ 0: true, 1: true, 2: true, 3: true }, 0];
  } else if (tt === MT.BOTH || tt === MT.OPPONENTS_FIELD) {
    return [{ 1: true, 3: true }, 8];
  } else if (tt === MT.USER) {
    if (PREVIEW_ALL[num]) return [{ 0: true, 1: true, 2: true, 3: true }, 8];
    if (PREVIEW_ALLIES[num]) return [{ 0: true, 2: true }, 8];
    if (num === MOVE_HELPING_HAND) return [{ [partner]: true }, 8];
    return [{ [id]: true }, 8];
  } else if (tt === MT.FOES_AND_ALLY) {
    return [{ 1: true, [partner]: true, 3: true }, 8];
  }
  return [{}, 0];
}

const ALL_BATTLERS: Record<number, boolean> = { 0: true, 1: true, 2: true, 3: true };

// Lua: ui.lua:1192
function fade_state(): any {
  let f = Ui._preview;
  if (!truthy(f)) {
    f = {
      active: false, objY: {}, objToggle: false, mask: {}, y: 0, target: 0,
      delay: 0, delayCounter: 0, finishing: false, finCounter: 0,
    };
    Ui._preview = f;
  }
  return f;
}

// pokefirered/src/palette.c:393
// Lua: ui.lua:1203
function fade_update(f: any): void {
  if (!f.active) return;
  if (f.finishing) {
    // pokefirered/src/palette.c:757
    if (f.finCounter === 4) {
      f.active = false; f.finishing = false; f.finCounter = 0;
    } else {
      f.finCounter = f.finCounter + 1;
    }
    return;
  }
  if (!f.objToggle) {
    if (f.delayCounter < f.delay) {
      f.delayCounter = f.delayCounter + 1;
      return;
    }
    f.delayCounter = 0;
  } else {
    for (const id in f.mask) f.objY[id] = f.y;
  }
  f.objToggle = !f.objToggle;
  if (!f.objToggle) {
    if (f.y === f.target) {
      f.mask = {};
      f.finishing = true;
    } else if (f.y > f.target) {
      f.y = Math.max(f.target, f.y - 2);
    } else {
      f.y = Math.min(f.target, f.y + 2);
    }
  }
}

// pokefirered/src/palette.c:151
// Lua: ui.lua:1237
function fade_begin(mask: Record<number, boolean>, delay: number, startY: number, targetY: number): boolean {
  const f = fade_state();
  if (f.active) return false;
  f.mask = mask; f.delay = delay; f.delayCounter = delay;
  f.y = startY; f.target = targetY;
  f.active = true;
  fade_update(f);
  return true;
}

// pokefirered/src/palette.c:349
// Lua: ui.lua:1248
function fade_reset_clear(): void {
  const f = fade_state();
  f.active = false; f.finishing = false; f.finCounter = 0; f.delayCounter = 0; f.y = 0; f.target = 0;
  fade_begin(ALL_BATTLERS, 0, 0, 0);
}

// Lua: ui.lua:1254
function tick_preview(): void {
  if (!is_double()) return;
  const f = fade_state();
  if (Ui._mode === "moves") {
    // pokefirered/src/battle_controller_player.c:442
    const [mask, y] = preview_targets(Ui._st, Ui._active ?? 0, Ui._moveIndex);
    fade_begin(mask, 8, y, 0);
  }
  fade_update(f);
}

// Lua: ui.lua:1265
Ui.previewCoeff = function (id: any): number {
  const f = Ui._preview;
  return lor(truthy(f) ? f.objY[id] : f, 0);
};

// pokefirered/src/battle_main.c:2019
// Lua: ui.lua:1271
function blink_start(t: any): void {
  t.blinkCounter = 8;
  t.hidden = false;
}

// Lua: ui.lua:1276
function tick_target(): void {
  const t = Ui._target;
  if (!truthy(t)) return;
  t.blinkCounter = lor(t.blinkCounter, 8) - 1;
  if (t.blinkCounter <= 0) {
    t.hidden = !truthy(t.hidden);
    t.blinkCounter = 8;
  }
}

// Lua: ui.lua:1286
Ui.targetHidden = function (id: any): boolean {
  const t = Ui._target;
  return t != null && t.cursor === id && t.hidden === true;
};

// Lua: ui.lua:1291
Ui.targetCursor = function (): number | undefined {
  return truthy(Ui._target) ? lor(Ui._target.cursor, undefined) : undefined;
};

// Lua: ui.lua:1295
Ui.tick = function (): void {
  const m = Ui._mode;
  if (m === "menu" || m === "moves" || m === "target" || m === "selmsg") {
    const id = Ui._active ?? 0;
    if (m === "menu") {
      // pokefirered/src/battle_controller_player.c:223
      start_bounce("hb", id, 7, 1);
      start_bounce("mon", id, 7, 1);
    } else if (m === "target" && truthy(Ui._target)) {
      // pokefirered/src/battle_controller_player.c:326
      const cur = Ui._target.cursor;
      start_bounce("hb", cur, 15, 1);
      for (let i = 0; i <= 3; i++) {
        if (i !== cur) end_bounce("hb", i);
      }
    }
    tick_bounces();
    tick_target();
    if (truthy(Ui._st) && truthy(Ui._st.oldManTutorial) && Ui._mode === "menu" && !Ui._headless) {
      // pokefirered/src/battle_controller_oak_old_man.c: SimulateInputChooseAction
      if (Ui._oldManSubstate === 0) {
        Ui._oldManTimer = (Ui._oldManTimer ?? 0) + 1;
        if (Ui._oldManTimer >= 64) {
          play_select();
          Ui._menuIndex = 2; // BAG
          Ui._oldManTimer = 0;
          Ui._oldManSubstate = 1;
        }
      } else if (Ui._oldManSubstate === 1) {
        Ui._oldManTimer = (Ui._oldManTimer ?? 0) + 1;
        if (Ui._oldManTimer >= 64) {
          play_select();
          Ui._pendingCommand = { kind: "bag", itemId: 4, user: "player" };
          Ui._mode = "none";
          Ui._oldManSubstate = undefined;
          Ui._oldManTimer = undefined;
        }
      }
    }
    if (truthy(Ui._wally) && truthy(Ui._st) && (m === "menu" || m === "moves") && !Ui._headless) {
      Wally.menuStep(Ui, Ui._st, play_select);
    }
  } else if (m !== "bag" && m !== "party") {
    end_all_bounces();
  }
  tick_preview();
};

// Lua: ui.lua:1343
function finish_move_choice(id: number, slot: any, target: any): void {
  const err = Commands.selectionError(Ui._st, slot, id);
  if (truthy(err)) {
    // pokefirered/src/battle_main.c:3277
    Ui._selCmd = undefined;
    Ui._selReturn = "moves";
    Ui._mode = "selmsg";
    Ui.push(err);
    return;
  }
  Ui._pendingCommand = Commands.playerAction(Ui._st, 1, slot, id, target);
  Ui._mode = "none";
  end_all_bounces();
}

// Lua: ui.lua:1358
function enter_target_mode(id: number, slot: any, start: number, cb: Fn | false): void {
  Ui._target = { battler: id, slot, cursor: start, cb };
  blink_start(Ui._target);
  Ui._mode = "target";
}

// pokefirered/src/battle_controller_player.c:493
// Lua: ui.lua:1365
Ui.chooseTarget = function (st: any, battlerId: any, moveSlot: any, cb?: Fn | null): boolean {
  if (truthy(st)) Ui._st = st;
  const id = (tonumber(battlerId) ?? 0);
  Ui._active = id;
  const [needs, target, start] = Ui.targetSelection(Ui._st, id, moveSlot);
  if (!needs) {
    if (truthy(cb)) cb!(target);
    return false;
  }
  Ui._moveIndex = moveSlot;
  enter_target_mode(id, moveSlot, start, lor(cb, false) as Fn | false);
  return true;
};

// pokefirered/src/battle_controller_player.c:355
// Lua: ui.lua:1380
function cycle_target(dir: number): void {
  const t = Ui._target;
  const st = Ui._st;
  const b = active_battler(st);
  const mv = truthy(b) && truthy(b.mon) && truthy(b.mon.moves) ? b.mon.moves[t.slot] : undefined;
  const def: any = truthy(mv) ? Moves.get(mv) : mv;
  const userOrSel = band(truthy(def) ? def.target : def, MT.USER_OR_SELECTED) !== 0;
  let pos = 1;
  for (let i = 1; i <= 4; i++) {
    if (TARGET_IDENTITIES[i] === t.cursor) { pos = i; break; }
  }
  for (let n = 1; n <= 8; n++) {
    pos = pos + dir;
    if (pos < 1) pos = 4; else if (pos > 4) pos = 1;
    const cand = TARGET_IDENTITIES[pos]!;
    let ok: boolean;
    if (lmod(cand, 2) === 0) {
      ok = (cand !== t.battler) || userOrSel;
    } else {
      ok = true;
    }
    if (absent(st, cand)) ok = false;
    if (ok) {
      t.cursor = cand;
      break;
    }
  }
  blink_start(t);
}

// Lua: ui.lua:1410
function handle_target_input(input: any): boolean {
  const t = Ui._target;
  if (!truthy(t)) {
    Ui._mode = "moves";
    return true;
  }
  if (input.wasPressed("a")) {
    play_select();
    const cur = t.cursor, cb = t.cb, id = t.battler, slot = t.slot;
    Ui._target = undefined;
    end_bounce("hb", cur);
    if (truthy(cb)) {
      Ui._mode = "none";
      cb(cur);
    } else {
      finish_move_choice(id, slot, cur);
    }
    return true;
  } else if (input.wasPressed("b")) {
    play_select();
    const cur = t.cursor, cb = t.cb, id = t.battler;
    Ui._target = undefined;
    // pokefirered/src/battle_controller_player.c:346
    start_bounce("hb", id, 7, 1);
    start_bounce("mon", id, 7, 1);
    end_bounce("hb", cur);
    if (truthy(cb)) {
      Ui._mode = "none";
      cb(undefined);
    } else {
      Ui._mode = "moves";
    }
    return true;
  } else if (input.wasPressed("left") || input.wasPressed("up")) {
    play_select();
    cycle_target(-1);
    return true;
  } else if (input.wasPressed("right") || input.wasPressed("down")) {
    play_select();
    cycle_target(1);
    return true;
  }
  return true;
}

// Lua: ui.lua:1455
function handle_double_input(input: any): boolean {
  const st = Ui._st;
  const id = Ui._active ?? 0;
  if (Ui._mode === "target") {
    return handle_target_input(input);
  }
  if (Ui._mode === "menu") {
    // pokefirered/src/battle_controller_player.c:219
    const c = lor(Ui._menuIndex, 1) - 1;
    let nc = c;
    if (input.wasPressed("a")) {
      play_select();
      Ui._actionCursor[id] = Ui._menuIndex;
      if (truthy(st) && truthy(st.safari)) {
        // pokefirered/src/battle_controller_safari.c:162
        Ui._pendingCommand = Commands.playerAction(st, Ui._menuIndex, undefined, id);
        Ui._mode = "none";
        end_all_bounces();
        return true;
      }
      const kind = Commands.MENU[Ui._menuIndex];
      if (kind === "FIGHT") {
        const [act, msg] = Commands.fightShortcut(st, id);
        if (truthy(act) && truthy(msg)) {
          Ui._selCmd = act;
          Ui._mode = "selmsg";
          Ui.push(msg);
        } else if (truthy(act)) {
          Ui._pendingCommand = act;
          Ui._mode = "none";
          end_all_bounces();
        } else {
          open_move_menu();
        }
      } else if (kind === "BAG") {
        open_battle_bag();
      } else if (kind === "POKEMON" || kind === "POK\xC3\xA9MON") {
        open_battle_party();
      } else {
        const ad = truthy(Battle) ? Battle._adapter : Battle;
        let canRun: any = true;
        let why: any;
        if (truthy(Engine) && truthy(Engine.canRun) && truthy(ad) && truthy(st)) {
          [canRun, why] = Engine.canRun(st, ad, active_battler(st));
        }
        if (!truthy(canRun) && truthy(why)) {
          Ui._selCmd = undefined;
          Ui._selReturn = "menu";
          Ui._mode = "selmsg";
          Ui.push(why);
          // pokefirered/src/battle_controller_oak_old_man.c:1782
          Oak.say(st, "noRunning");
        } else if (truthy(st) && (truthy(st.link) || is_frontier_forfeit(st))) {
          const act = Commands.playerAction(st, Ui._menuIndex, undefined, id);
          if (is_frontier_forfeit(st)) act.forfeit = true;
          confirm_link_forfeit(act);
        } else {
          Ui._pendingCommand = Commands.playerAction(st, Ui._menuIndex, undefined, id);
          Ui._mode = "none";
          end_all_bounces();
        }
      }
      return true;
    } else if (input.wasPressed("left")) {
      if (lmod(c, 2) === 1) nc = c - 1;
    } else if (input.wasPressed("right")) {
      if (lmod(c, 2) === 0) nc = c + 1;
    } else if (input.wasPressed("up")) {
      if (c >= 2) nc = c - 2;
    } else if (input.wasPressed("down")) {
      if (c < 2) nc = c + 2;
    } else if (input.wasPressed("b")) {
      // pokefirered/src/battle_controller_player.c:286
      if (id === 2 && !(truthy(st.absent) && truthy(st.absent[0])) && !truthy(st.multi)) {
        const pa = Ui._partnerAction;
        let refund: number | undefined;
        if (truthy(pa) && pa.kind === "bag") {
          const item = tonumber(lor(pa.itemId, pa.item));
          if (truthy(item) && item! <= ITEM_PREMIER_BALL) {
            refund = item;
          } else {
            return true;
          }
        }
        play_select();
        Ui._pendingCommand = { kind: "cancel_partner", battler: id, refundItem: refund };
        Ui._mode = "none";
        end_all_bounces();
      }
      return true;
    } else if (input.wasPressed("start")) {
      // pokefirered/src/battle_controller_player.c:306
      Healthbox.swapHpBarsWithHpText(st);
      return true;
    }
    if (nc !== c) {
      play_select();
      Ui._menuIndex = nc + 1;
      Ui._actionCursor[id] = Ui._menuIndex;
    }
    return true;
  } else if (Ui._mode === "bag" || Ui._mode === "party") {
    return true;
  } else if (Ui._mode === "moves") {
    const b = active_battler(st);
    if (move_swap_input(input, st, b, id)) return true;
    const n = move_count(truthy(b) ? b.mon : b);
    const c = lor(Ui._moveIndex, 1) - 1;
    let nc = c;
    // pokefirered/src/battle_controller_player.c:511
    if (input.wasPressed("left")) {
      if (lmod(c, 2) === 1) nc = c - 1;
    } else if (input.wasPressed("right")) {
      if (lmod(c, 2) === 0 && c + 1 < n) nc = c + 1;
    } else if (input.wasPressed("up")) {
      if (c >= 2) nc = c - 2;
    } else if (input.wasPressed("down")) {
      if (c < 2 && c + 2 < n) nc = c + 2;
    }
    const idx = nc + 1, moved = nc !== c;
    if (moved) {
      Ui._moveIndex = idx;
      Ui._moveCursor[id] = idx;
      play_select();
      // pokefirered/src/battle_controller_player.c:521
      fade_begin(ALL_BATTLERS, 0, 0, 0);
      return true;
    }
    if (input.wasPressed("a")) {
      play_select();
      const slot = Ui._moveIndex;
      const [needs, target, start] = Ui.targetSelection(st, id, slot);
      fade_reset_clear();
      if (needs) {
        enter_target_mode(id, slot, start, false);
      } else {
        finish_move_choice(id, slot, target);
      }
      return true;
    } else if (input.wasPressed("b")) {
      play_select();
      fade_reset_clear();
      Ui._mode = "menu";
      return true;
    }
  }
  return false;
}

// Lua: ui.lua:1606
Ui.handleInput = function (input: any): boolean {
  if (!truthy(input)) return false;
  Ui.tick();

  // Learn-move / evo YES-NO and forget list
  if (truthy(Choice) && truthy(Choice.active)) {
    if (input.wasPressed("up")) {
      Choice.move(-1);
      return true;
    } else if (input.wasPressed("down")) {
      Choice.move(1);
      return true;
    } else if (input.wasPressed("a")) {
      Choice.confirm();
      return true;
    } else if (input.wasPressed("b")) {
      Choice.cancel();
      return true;
    }
    return true;
  }

  if (!Ui.waitingForCommand()) return false;
  if (truthy(Ui._st) && truthy(Ui._st.oldManTutorial)) {
    // Old Man tutorial script controls the actions automatically
    return true;
  }
  if (truthy(Ui._wally)) return true;
  if (is_double()) return handle_double_input(input);
  if (Ui._mode === "menu") {
    const [idx, moved] = grid_nav(Ui._menuIndex, input, 4);
    if (moved) {
      Ui._menuIndex = idx;
      play_select();
      return true;
    }
    if (input.wasPressed("a")) {
      play_select();
      if (truthy(Ui._st) && truthy(Ui._st.safari)) {
        // pokefirered/src/battle_controller_safari.c:162
        Ui._pendingCommand = Commands.playerAction(Ui._st, Ui._menuIndex, undefined);
        Ui._mode = "none";
        return true;
      }
      const kind = Commands.MENU[Ui._menuIndex];
      if (kind === "FIGHT") {
        const [act, msg] = Commands.fightShortcut(Ui._st);
        if (truthy(act) && truthy(msg)) {
          Ui._selCmd = act;
          Ui._mode = "selmsg";
          Ui.push(msg);
        } else if (truthy(act)) {
          Ui._pendingCommand = act;
          Ui._mode = "none";
        } else {
          open_move_menu();
        }
      } else if (kind === "BAG") {
        open_battle_bag();
      } else if (kind === "POKEMON" || kind === "POK\xC3\xA9MON") {
        open_battle_party();
      } else {
        // pokefirered/src/battle_main.c:3246
        const ad = truthy(Battle) ? Battle._adapter : Battle;
        let canRun: any = true;
        let why: any;
        if (truthy(Engine) && truthy(Engine.canRun) && truthy(ad) && truthy(Ui._st)) {
          [canRun, why] = Engine.canRun(Ui._st, ad, Ui._st.player);
        }
        if (!truthy(canRun) && truthy(why)) {
          Ui._selCmd = undefined;
          Ui._selReturn = "menu";
          Ui._mode = "selmsg";
          Ui.push(why);
          // pokefirered/src/battle_controller_oak_old_man.c:1782
          Oak.say(Ui._st, "noRunning");
        } else if (truthy(Ui._st) && (truthy(Ui._st.link) || is_frontier_forfeit(Ui._st))) {
          const act = Commands.playerAction(Ui._st, Ui._menuIndex, undefined);
          if (is_frontier_forfeit(Ui._st)) act.forfeit = true;
          confirm_link_forfeit(act);
        } else {
          Ui._pendingCommand = Commands.playerAction(Ui._st, Ui._menuIndex, undefined);
          Ui._mode = "none";
        }
      }
      return true;
    } else if (input.wasPressed("b")) {
      return true;
    }
  } else if (Ui._mode === "bag" || Ui._mode === "party") {
    // Input owned by BagMenu / PartyMenu via Battle.update
    return true;
  } else if (Ui._mode === "moves") {
    if (move_swap_input(input, Ui._st, truthy(Ui._st) ? Ui._st.player : Ui._st, undefined)) return true;
    // pokefirered/src/battle_controller_player.c:526
    const [idx, moved] = grid_nav(Ui._moveIndex, input,
      move_count(truthy(Ui._st) && truthy(Ui._st.player) ? Ui._st.player.mon : undefined));
    if (moved) {
      Ui._moveIndex = idx;
      play_select();
      return true;
    }
    if (input.wasPressed("a")) {
      play_select();
      // pokefirered/src/battle_main.c:3277
      const err = Commands.selectionError(Ui._st, Ui._moveIndex);
      if (truthy(err)) {
        Ui._selCmd = undefined;
        Ui._mode = "selmsg";
        Ui.push(err);
        return true;
      }
      Ui._pendingCommand = Commands.playerAction(Ui._st, 1, Ui._moveIndex);
      Ui._mode = "none";
      return true;
    } else if (input.wasPressed("b")) {
      play_select();
      Ui._mode = "menu";
      return true;
    }
  }
  return false;
};

// Lua: ui.lua:1730
function draw_menu_text(text: any, x: number, y: number, opts?: any): void {
  opts = lor(opts, {});
  FrlgFont.draw(tostring(lor(text, "")), x, y, {
    small: opts.small != null ? opts.small : false,
    colors: lor(opts.colors, FrlgFont.COLOR.NORMAL),
  });
}

// ({ [0] = 1, [1] = 2, [2] = 3, [3] = 0 }: keys 0..3)
const PP_STATE_TO_COLOR_INDEX: number[] = [1, 2, 3, 0];

// Lua: ui.lua:1745
Ui.ppColorState = function (currentPpIn: any, maxPpIn: any): number {
  const currentPp = (tonumber(currentPpIn) ?? 0);
  const maxPp = (tonumber(maxPpIn) ?? 0);
  if (maxPp === currentPp) return 3;
  if (maxPp <= 2) {
    if (currentPp > 1) return 3;
    return 2 - currentPp;
  } else if (maxPp <= 7) {
    if (currentPp > 2) return 3;
    return 2 - currentPp;
  }
  if (currentPp === 0) return 2;
  if (currentPp <= Math.floor(maxPp / 4)) return 1;
  if (currentPp > Math.floor(maxPp / 2)) return 3;
  return 0;
};

// Lua: ui.lua:1762
Ui.ppColorIndex = function (currentPp: any, maxPp: any): number {
  return PP_STATE_TO_COLOR_INDEX[Ui.ppColorState(currentPp, maxPp)]!;
};

// Lua: ui.lua:1766
function pp_text_colors(currentPp: any, maxPp: any): any {
  const manifest = truthy(SummaryChrome.manifest) ? SummaryChrome.manifest() : undefined;
  const rows = truthy(manifest) ? manifest.moveTextColors : manifest;
  const row = truthy(rows) ? rows[Ui.ppColorIndex(currentPp, maxPp)] : rows;
  if (!truthy(row)) return FrlgFont.COLOR.NORMAL;
  const rgb = (c: any): any => seq(lor(c[1], 0) / 255, lor(c[2], 0) / 255, lor(c[3], 0) / 255, 1);
  return { fg: rgb(row.fg), shadow: rgb(row.shadow), bg: FrlgFont.STDPAL[0] };
}

// Lua: ui.lua:1777
function draw_prompt_text(text: any, x: number, y: number): void {
  FrlgFont.draw(tostring(lor(text, "")), x, y, {
    colors: FrlgFont.COLOR.WHITE,
  });
}

// GRAY_SHADER_SRC (ui.lua:1783) -> platform effect "gray5_pre".
let grayShader: Shader | false | undefined;

// pokefirered/src/battle_anim_mons.c:1287
// Lua: ui.lua:1794
function set_gray_shader(): boolean {
  if (grayShader === undefined) {
    try {
      grayShader = G.newShader("gray5_pre");
    } catch {
      grayShader = false;
    }
  }
  if (!grayShader) return false;
  G.setShader(grayShader);
  return true;
}

// STAT_MASK_SRC (ui.lua:1804) -> platform effect "stat_mask".
let statMaskShader: Shader | false | undefined;

// pokefirered/src/battle_anim_utility_funcs.c:526
// Lua: ui.lua:1827
function draw_stat_mask(pres: any, img: Image, cx: number, cy: number, sx: number, sy: number): void {
  const sm = truthy(pres) ? pres.statMask : pres;
  if (!(truthy(sm) && (tonumber(sm.eva) ?? 0) > 0)) return;
  const vm = truthy(Anim.vm) ? Anim.vm() : undefined;
  if (!(truthy(vm) && truthy(vm.active))) return;
  const mask = Anim.statMaskImage(sm.tilemap, sm.pal);
  if (!truthy(mask)) return;
  if (statMaskShader === undefined) {
    try {
      statMaskShader = G.newShader("stat_mask");
    } catch {
      statMaskShader = false;
    }
  }
  if (!statMaskShader) return;
  const sh = statMaskShader;
  const [iw, ih] = img.getDimensions();
  const w = iw * Math.abs(sx), h = ih * Math.abs(sy);
  let ok = true;
  try {
    sh.send("maskTex", mask);
    sh.send("origin", [cx - 32 * Math.abs(sx), cy - 32 * Math.abs(sy)]);
    sh.send("size", [w, h]);
    sh.send("scroll", [(tonumber(sm.x) ?? 0), (tonumber(sm.y) ?? 0)]);
    sh.send("flip", sx < 0 ? 1 : 0);
    sh.send("eva", Math.min(1, (tonumber(sm.eva) ?? 0) / 16));
    sh.send("darken", 0);
  } catch {
    ok = false;
  }
  if (!ok) return;
  const eva = Math.min(16, (tonumber(sm.eva) ?? 0));
  const evb = truthy(sm.evb) ? Math.min(16, (tonumber(sm.evb) ?? 0)) : (16 - eva);
  G.setShader(sh);
  G.setColor(1, 1, 1, 1);
  if (eva + evb !== 16) {
    // pokefirered/src/battle_anim_utility_funcs.c:306
    try {
      sh.send("darken", 1);
      sh.send("eva", 1 - evb / 16);
    } catch { /* pcall */ }
    G.draw(img, cx, cy, 0, sx, sy, 32, 32);
    try {
      sh.send("darken", 0);
      sh.send("eva", eva / 16);
    } catch { /* pcall */ }
    G.setBlendMode("add", "alphamultiply");
    G.draw(img, cx, cy, 0, sx, sy, 32, 32);
    G.setBlendMode("alpha", "alphamultiply");
  } else {
    G.draw(img, cx, cy, 0, sx, sy, 32, 32);
  }
  G.setShader();
}

// MOSAIC_SRC (ui.lua:1876) -> platform effect "mosaic".
let mosaicShader: Shader | false | undefined;

// pokefirered/src/battle_anim_effects_3.c:2223
// Lua: ui.lua:1887
function set_mosaic_shader(img: Image, level: any): boolean {
  if (mosaicShader === undefined) {
    try {
      mosaicShader = G.newShader("mosaic");
    } catch {
      mosaicShader = false;
    }
  }
  if (!mosaicShader) return false;
  const [iw, ih] = img.getDimensions();
  try {
    mosaicShader.send("texSize", [iw, ih]);
    mosaicShader.send("block", (tonumber(level) ?? 0) + 1);
  } catch {
    return false;
  }
  G.setShader(mosaicShader);
  return true;
}

// AFFINE_SRC (ui.lua:1903) -> platform effect "affine_color".
let affineShader: Shader | false | undefined;

// pokefirered/src/palette.c:471
// Lua: ui.lua:1914
function set_affine_shader(st: any): boolean {
  if (!isTable(st)) return false;
  if (affineShader === undefined) {
    try {
      affineShader = G.newShader("affine_color");
    } catch {
      affineShader = false;
    }
  }
  if (!affineShader) return false;
  try {
    affineShader.send("m", (tonumber(st.m) ?? 1));
    affineShader.send("off", [(tonumber(st.r) ?? 0), (tonumber(st.g) ?? 0), (tonumber(st.b) ?? 0)]);
  } catch {
    return false;
  }
  G.setShader(affineShader);
  return true;
}

const rowQuads: Record<number, Quad> = {};
// Lua: ui.lua:1931
function row_quad(iw: number, ih: number, r: number): Quad {
  const key = iw * 100000 + ih * 100 + r;
  let q = rowQuads[key];
  if (!q) {
    q = G.newQuad(0, r, iw, 1, iw, ih);
    rowQuads[key] = q;
  }
  return q;
}

// Lua: ui.lua:1941
function bg_blend_params(bb: any): [number?, number?, number?, number?] {
  if (!isTable(bb)) return [];
  const coeff = (tonumber(bb.coeff) ?? 0);
  if (coeff <= 0) return [];
  const c = bb.color;
  if (typeof c === "number") {
    return [coeff, lmod(c, 32), lmod(Math.floor(c / 32), 32), lmod(Math.floor(c / 1024), 32)];
  } else if (isTable(c)) {
    return [coeff, lor(c[1], 0) * 31, lor(c[2], 0) * 31, lor(c[3], 0) * 31];
  }
  return [coeff, 0, 0, 0];
}

const DEFAULT_BLEND_COLOR = seq(1, 1, 1);

/**
 * Draw mon pic at GetBattlerSpriteFinal_Y center (64×64 → TL = center−32).
 * Applies Anim present offsets / alpha / visibility / z (Dig/Fly hide).
 */
// Lua: ui.lua:1956
function draw_mon_sprite(battler: any, base: any, back: boolean, id?: number): void {
  if (!truthy(battler)) return;
  const side = back ? "player" : "enemy";
  const key = id != null ? id : side;
  const pres = Anim.present(key);
  if (truthy(pres) && (pres.visible === false || truthy(pres.blinkHidden) || truthy(pres.battlerInvisible) || truthy(pres.invisible))) return;
  if (id != null && Ui.targetHidden(id)) return;
  battler = lor(Anim.shownBattler(key, battler), battler);

  let sp = battler.species;
  if (!truthy(sp) && truthy(battler.mon) && truthy(Pokemon.speciesOf)) {
    sp = Pokemon.speciesOf(battler.mon);
  } else if (!truthy(sp) && truthy(battler.mon)) {
    sp = lor(battler.mon.species, battler.mon.speciesId);
  }
  let tf: any;
  if (truthy(battler.expTransform)) {
    tf = truthy(pres) ? pres.transformSpecies : pres;
    if (!truthy(tf) && !(truthy(pres) && truthy(pres.pendingTransform))) tf = battler.expTransform.species;
  }
  if (truthy(tf)) sp = tf;
  const ghost = shows_ghost(side, Ui._st);
  const form = (tonumber(sp) === SPECIES_CASTFORM) ? castform_form(side, battler) : 0;
  let [cx, cy] = battler_sprite_center(id != null ? id : side, sp, base, form, ghost);
  if (truthy(pres)) {
    cx = cx + lor(pres.ox, 0);
    cy = cy + lor(pres.oy, 0);
  }
  cy = cy + Ui.bounceOffset("mon", id != null ? id : (back ? 0 : 1));
  const scale = lor(truthy(pres) ? pres.scale : pres, 1);
  const darken = lor(truthy(pres) ? pres.darken : pres, 0);
  let entry: any;
  const dollImg = truthy(pres) && truthy(pres.substitute) ? Anim.substituteImage(key) : undefined;
  if (truthy(dollImg)) {
    // pokefirered/src/battle_gfx_sfx_util.c:794
    entry = { image: dollImg };
    cx = base.x + lor(pres.ox, 0);
    cy = orl(() => pres.substituteY, () => Anim.substituteY(key)) + lor(pres.oy, 0);
  }
  if (!truthy(entry) && ghost && truthy(Pokemon.ghostPic)) {
    entry = Pokemon.ghostPic();
  }
  const [picSp, shiny, personality] = pic_args(battler, sp);
  if (!truthy(entry) && back && truthy(Pokemon.backPic)) {
    entry = Pokemon.backPic(picSp, form, shiny);
  }
  if (!truthy(entry)) {
    entry = truthy(Pokemon.frontPic) ? Pokemon.frontPic(picSp, form, shiny, personality) : undefined;
  }
  if (!back && !ghost && !truthy(dollImg) && truthy(pres) && (tonumber(pres.monFrame) ?? 0) !== 0) {
    // pokeemerald/src/sprite.c:917
    entry = lor(MonAnim.framePic(picSp, pres.monFrame, shiny), entry);
  }
  if (truthy(entry) && truthy(entry.image)) {
    const a = lor(truthy(pres) ? pres.alpha : pres, 1);
    const flash = truthy(pres) ? lor(pres.flash, 0) : 0;
    const shade = 1 - darken * (1 - 8 / 255);
    if (flash > 0) {
      G.setColor(1, 1, 1, a * (0.4 + 0.6 * ((lmod(flash, 2) === 0) ? 1 : 0.3)));
    } else {
      G.setColor(shade, shade, shade, a);
    }
    const hFlip = (truthy(pres) && truthy(pres.hFlip)) ? true : false;
    const sx = (hFlip ? -1 : 1) * scale * lor(truthy(pres) ? pres.sx : pres, 1);
    const sy = scale * lor(truthy(pres) ? pres.sy : pres, 1);
    const rot = lor(truthy(pres) ? pres.rotation : pres, 0);
    let blended: any;
    if (id != null) {
      blended = BallOpen.setBlendShader(...BallOpen.monBlend(id));
      if (!truthy(blended) && id < 2) blended = BallOpen.setBlendShader(...BallOpen.monBlend(side));
    } else {
      blended = BallOpen.setBlendShader(...BallOpen.monBlend(side));
    }
    if (!truthy(blended) && truthy(pres)) {
      if (truthy(pres.palAffine)) {
        blended = set_affine_shader(pres.palAffine);
      } else if ((tonumber(pres.mosaic) ?? 0) > 0) {
        blended = set_mosaic_shader(entry.image, pres.mosaic);
      } else if (truthy(pres.grayscale)) {
        blended = set_gray_shader();
      } else if ((tonumber(pres.blendCoeff) ?? 0) > 0) {
        const c = lor(pres.blendColor, DEFAULT_BLEND_COLOR);
        blended = BallOpen.setBlendShader(pres.blendCoeff * 16, lor(c[1], 0) * 31, lor(c[2], 0) * 31, lor(c[3], 0) * 31);
      }
    }
    if (!truthy(blended) && truthy(tf) && !truthy(dollImg)) {
      // pokefirered/src/battle_gfx_sfx_util.c:747
      blended = BallOpen.setBlendShader(6, 31, 31, 31);
    }
    if (!truthy(blended) && id != null) {
      const pc = Ui.previewCoeff(id);
      // pokefirered/src/battle_controller_player.c:2987
      if (pc > 0) blended = BallOpen.setBlendShader(pc, 31, 31, 31);
    }
    if (truthy(pres) && isTable(pres.hShift) && rot === 0 && sy === 1) {
      const img: Image = entry.image;
      const [iw, ih] = img.getDimensions();
      const top = Math.floor(cy - 32 + 0.5);
      for (let r = 0; r <= ih - 1; r++) {
        const q = row_quad(iw, ih, r);
        const dx = (tonumber(pres.hShift[top + r]) ?? 0);
        G.draw(img, q, cx + dx, top + r, 0, sx, 1, 32, 0);
      }
    } else {
      G.draw(entry.image, cx, cy, rot, sx, sy, 32, 32);
    }
    if (truthy(blended)) G.setShader();
    if (truthy(pres) && truthy(pres.statMask) && !truthy(dollImg)) draw_stat_mask(pres, entry.image, cx, cy, sx, sy);
  } else {
    // Placeholder silhouette so lunge/shake is visible before full pic extract.
    const a = lor(truthy(pres) ? pres.alpha : pres, 1);
    const flash = truthy(pres) ? lor(pres.flash, 0) : 0;
    if (flash > 0 && lmod(flash, 2) === 0) {
      G.setColor(1, 1, 1, a);
    } else if (back) {
      G.setColor(0.35, 0.55, 0.95, a);
    } else {
      G.setColor(0.95, 0.45, 0.35, a);
    }
    const hw = 24 * scale;
    const rot = lor(truthy(pres) ? pres.rotation : pres, 0);
    const sx = lor(truthy(pres) ? pres.sx : pres, 1);
    const sy = lor(truthy(pres) ? pres.sy : pres, 1);
    if (rot !== 0 || sx !== 1 || sy !== 1) {
      G.push();
      G.translate(cx, cy);
      G.rotate(rot);
      G.scale(sx, sy);
      G.rectangle("fill", -hw, -hw, hw * 2, hw * 2);
      G.setColor(1, 1, 1, a * 0.9);
      G.rectangle("line", -hw, -hw, hw * 2, hw * 2);
      G.pop();
    } else {
      G.rectangle("fill", cx - hw, cy - hw, hw * 2, hw * 2);
      G.setColor(1, 1, 1, a * 0.9);
      G.rectangle("line", cx - hw, cy - hw, hw * 2, hw * 2);
    }
  }
}

// src/battle_message.c:1282
// Lua: ui.lua:2097
function menu_labels(key: string): LuaTable {
  Ui._menuLabels = lor(Ui._menuLabels, {}) as Record<string, LuaTable>;
  if (truthy(Ui._menuLabels[key])) return Ui._menuLabels[key]!;
  const labels = seq();
  let buf = seq();
  const flush = (): void => {
    if (len(buf) > 0) {
      const label = concat(buf);
      labels[len(labels) + 1] = Strings(label, key);
      buf = seq();
    }
  };
  // RomText.ir is TextIR's 0-based Seg[] (rom_text.ts).
  for (const seg of RomText.ir(key)) {
    if (seg.t === "text") {
      buf[len(buf) + 1] = seg.s;
    } else if (seg.t === "tag" && truthy(seg.tag)) {
      // pokeemerald/src/battle_message.c:1276
      buf[len(buf) + 1] = seg.tag;
    } else if (seg.t === "nl" || (seg.t === "ext" && seg.cmd === 19)) {
      flush();
    }
  }
  flush();
  Ui._menuLabels[key] = labels;
  return labels;
}

// Lua: ui.lua:2123
function action_prompt(st: any, ab: any): any {
  const mode = orl(
    () => truthy(st) && truthy(st.safari) && "safari",
    () => truthy(st) && truthy(st.oldManTutorial) && "oldman",
    () => truthy(st) && truthy(st.kinds) && st.kinds.tutorial === "wally" && "wally",
    () => "pkmn",
  );
  const mon = truthy(ab) ? ab.mon : ab;
  const cached = Ui._promptFor;
  if (truthy(cached) && cached.st === st && cached.mode === mode && cached.mon === mon && truthy(Ui._promptText)) {
    return Ui._promptText;
  }
  let text: any;
  if (mode === "safari") {
    // pokefirered/src/battle_controller_safari.c:446
    text = BattleText.get(BattleProfile.of(st).strings.safariPrompt,
      { playerName: st.playerName });
  } else if (mode === "oldman") {
    // pokefirered/src/battle_controller_oak_old_man.c:1825
    text = BattleText.get("gText_WhatWillOldManDo");
  } else if (mode === "wally") {
    // pokeemerald/src/battle_controller_wally.c:1214
    text = BattleText.get("gText_WhatWillWallyDo");
  } else {
    // pokefirered/src/battle_controller_player.c:2422
    text = BattleText.get("gText_WhatWillPkmnDo", { active: ab, trainer: truthy(st) && !truthy(st.wild) });
  }
  Ui._promptFor = { st, mode, mon };
  Ui._promptText = text;
  return text;
}

// Lua: ui.lua:2151
function battle_font(): any {
  const P: any = Profile.forSession(Ui._session);
  // require(P.font.module): both shipped profiles name frlg_font.
  if (P.font.module === "src.ui.game3.frlg_font") return FrlgFont;
  // NOT FAITHFUL: Emerald only (another font module).
  return notPorted(`require("${tostring(P.font.module)}") (battle font)`);
}

// Lua: ui.lua:2156
function c5to8(x: number): number {
  return (x * 8 + Math.floor(x / 4)) / 255;
}

// Lua: ui.lua:2160
function bgr555_rgba(vIn: any): any {
  const v = (tonumber(vIn) ?? 0);
  return seq(c5to8(lmod(v, 32)), c5to8(lmod(Math.floor(v / 32), 32)), c5to8(lmod(Math.floor(v / 1024), 32)), 1);
}

// pokeemerald/src/battle_bg.c:748
// Lua: ui.lua:2166
function rse_window_colors(fgIdx?: number, shadowIdx?: number): any {
  const pal = lor(BattleChrome.manifest().windowTextPal, {});
  return {
    fg: bgr555_rgba(pal[(fgIdx ?? 13) + 1]),
    shadow: bgr555_rgba(pal[(shadowIdx ?? 15) + 1]),
    bg: seq(0, 0, 0, 0),
  };
}

// The default (13, 15) window colours, rebuilt only when the manifest's
// palette table changes.  Callers must not modify the returned table
// (rse_pp_colors, which does, builds its own with rse_window_colors).
let _defaultWinColors: any;
let _defaultWinPal: any;
// Lua: ui.lua:2179
function rse_default_colors(): any {
  const pal = lor(BattleChrome.manifest().windowTextPal, undefined);
  if (!truthy(_defaultWinColors) || pal !== _defaultWinPal) {
    _defaultWinColors = rse_window_colors();
    _defaultWinPal = pal;
  }
  return _defaultWinColors;
}

// pokeemerald/src/battle_message.c:3033
// Lua: ui.lua:2189
function rse_pp_colors(pp: any, maxPp: any): any {
  const pp2 = lor(BattleChrome.manifest().ppTextPal, {});
  const state = Ui.ppColorState(pp, maxPp);
  const c = rse_window_colors(13, 15);
  c.fg = bgr555_rgba(pp2[state * 2 + 1]);
  c.shadow = bgr555_rgba(pp2[state * 2 + 2]);
  return c;
}

// Lua: ui.lua:2198
function rse_text(win: any, text: any, dx?: number, opts?: any): void {
  const [x, y, , narrow] = BattleChrome.textOrigin(win);
  opts = lor(opts, {});
  const F = battle_font();
  const useNarrow = (opts.narrow == null && truthy(narrow)) ? narrow : opts.narrow;
  F.draw(tostring(lor(text, "")), x + (dx ?? 0), y, {
    font: truthy(useNarrow) ? "narrow" : undefined,
    colors: lor(opts.colors, rse_default_colors()),
  });
}

// pokeemerald/src/battle_controller_player.c:1530
// Lua: ui.lua:2210
function draw_action_menu_rse(st: any): void {
  const W = BattleChrome.WIN;
  const ab = truthy(st) ? (is_double(st) ? lor(active_battler(st), st.player) : st.player) : st;
  const labels = menu_labels((truthy(st) && truthy(st.safari)) ? "gText_SafariZoneMenu" : "gText_BattleMenu");
  const [px, py] = BattleChrome.textOrigin(W.ACTION_PROMPT);
  battle_font().draw(tostring(lor(action_prompt(st, ab), "")), px, py, { colors: BattleChrome.textboxColors(1, 6) });
  const [mx, my] = BattleChrome.textOrigin(W.ACTION_MENU);
  const c = Ui._menuIndex - 1;
  const col = lmod(c, 2), row = Math.floor(c / 2);
  Window.cursorPx(8 * (7 * col + 16), my + 16 * row, { colors: rse_default_colors() });
  for (let i = 1; i <= 4; i++) {
    const cc = lmod(i - 1, 2), rr = Math.floor((i - 1) / 2);
    battle_font().draw(tostring(lor(labels[i], "")), mx + 56 * cc, my + 16 * rr, { colors: rse_default_colors() });
  }
}

// Lua: ui.lua:2226
function swap_cursor_colors(variant: number, base: any): any {
  const clear = seq(0, 0, 0, 0);
  if (variant === 27) return { fg: base.fg, shadow: clear, bg: base.bg };
  return { fg: base.shadow, shadow: clear, bg: base.bg };
}

// pokeemerald/src/battle_controller_player.c:608
// Lua: ui.lua:2233
function draw_move_cursors(pos_of: (c: number) => any, base: any): void {
  const cur = Ui._moveIndex - 1;
  const sw = Ui._swap;
  const p = pos_of(cur);
  if (!truthy(sw) || sw.cursor === cur) {
    Window.cursorPx(p[1], p[2], { colors: base });
    return;
  }
  Window.cursorPx(p[1], p[2], { colors: swap_cursor_colors(29, base) });
  const q = pos_of(sw.cursor);
  Window.cursorPx(q[1], q[2], { colors: swap_cursor_colors(27, base) });
}

// pokeemerald/src/battle_controller_player.c:1456
// Lua: ui.lua:2247
function draw_move_menu_rse(st: any): void {
  const W = BattleChrome.WIN;
  const ab = truthy(st) ? (is_double(st) ? lor(active_battler(st), st.player) : st.player) : st;
  const mon = truthy(ab) ? ab.mon : ab;
  const [, cy] = BattleChrome.textOrigin(W.MOVE_NAME_1);
  draw_move_cursors((c: number) => {
    return seq(8 * (9 * lmod(c, 2) + 1), cy + 16 * Math.floor(c / 2));
  }, rse_default_colors());
  for (let i = 1; i <= 4; i++) {
    const mv = truthy(mon) && truthy(mon.moves) ? mon.moves[i] : undefined;
    let label = "-";
    if (truthy(mv) && mv !== 0 && mv !== "") label = Moves.displayName(mv);
    rse_text(W.MOVE_NAME_1! + i - 1, label);
  }
  if (truthy(Ui._swap)) {
    rse_text(W.SWITCH_PROMPT, RomText.plain("gText_BattleSwitchWhich"));
    return;
  }
  const slot = Ui._moveIndex;
  const mv = truthy(mon) && truthy(mon.moves) ? mon.moves[slot] : undefined;
  if (truthy(mv) && mv !== 0 && mv !== "") {
    const def: any = Moves.get(mv);
    const pp = truthy(mon.pp) ? lor(mon.pp[slot], 0) : 0;
    const maxPp = orl(() => truthy(mon.maxPp) && mon.maxPp[slot], () => truthy(def) && def.pp, () => pp);
    // pokeemerald/src/battle_controller_player.c:1473
    rse_text(W.PP, RomText.plain("gText_MoveInterfacePP"), 0, { colors: rse_pp_colors(pp, maxPp) });
    // pokeemerald/src/battle_controller_player.c:1479
    rse_text(W.PP_REMAINING, format("%2d/%2d", pp, maxPp), 0, { colors: rse_pp_colors(pp, maxPp) });
    // pokeemerald/src/battle_controller_player.c:1496
    const typeLabel = RomText.plain("gText_MoveInterfaceType");
    rse_text(W.MOVE_TYPE, typeLabel);
    const F = battle_font();
    const tw = F.measure(typeLabel, { font: "narrow" });
    rse_text(W.MOVE_TYPE, Types.name(def.type), tw, { narrow: false });
  }
}

// FRLG action / move menu tables (Brian builds the same constants per frame).
const ACTION_POSITIONS = seq(
  seq(136, 122), seq(184, 122),
  seq(136, 138), seq(184, 138),
) as any[];
const ACTION_CURSOR_POS = seq(
  seq(128, 122), seq(176, 122),
  seq(128, 138), seq(176, 138),
) as any[];
const MOVE_POSITIONS = seq(
  seq(16, 122), seq(88, 122),
  seq(16, 138), seq(88, 138),
) as any[];
const MOVE_CURSOR_POS = seq(
  seq(8, 122), seq(80, 122),
  seq(8, 138), seq(80, 138),
) as any[];
const move_cursor_pos = (c: number): any => lor(MOVE_CURSOR_POS[c + 1], MOVE_CURSOR_POS[1]);

// Lua: ui.lua:2284
function draw_action_menu(st: any): void {
  if (BattleChrome.isRse()) return draw_action_menu_rse(st);
  // B_WIN_ACTION_PROMPT @ (1,15) after scroll → px (8,120); printer (2,2) → (10,122)
  // B_WIN_ACTION_MENU @ (17,15) → (136,120); printer (0,2) → (136,122)
  // ActionSelectionCreateCursorAt: tile (16+7*col, 35+row) → after scroll (128,120);
  // cursor is a 1×2 BG pip whose ink lines up with printer y=2 text → draw at text Y.
  const ab = truthy(st) ? (is_double(st) ? lor(active_battler(st), st.player) : st.player) : st;
  const labels = menu_labels((truthy(st) && truthy(st.safari)) ? "gText_SafariZoneMenu" : "gText_BattleMenu");
  draw_prompt_text(action_prompt(st, ab), 10, 122);
  const c = Ui._menuIndex - 1;
  const cp = lor(ACTION_CURSOR_POS[c + 1], ACTION_CURSOR_POS[1]);
  Window.cursorPx(cp[1], cp[2], { colors: FrlgFont.COLOR.NORMAL });
  for (const [i, pos] of ipairs(ACTION_POSITIONS)) {
    draw_menu_text(labels[i], pos[1], pos[2], { small: false, colors: FrlgFont.COLOR.NORMAL });
  }
}

// Lua: ui.lua:2309
function draw_move_menu(st: any): void {
  if (BattleChrome.isRse()) return draw_move_menu_rse(st);
  const ab = truthy(st) ? (is_double(st) ? lor(active_battler(st), st.player) : st.player) : st;
  const mon = truthy(ab) ? ab.mon : ab;
  draw_move_cursors(move_cursor_pos, FrlgFont.COLOR.NORMAL);
  for (let i = 1; i <= 4; i++) {
    const mv = truthy(mon) && truthy(mon.moves) ? mon.moves[i] : undefined;
    // pokefirered/src/data/text/move_names.h:2
    let label = "-";
    if (truthy(mv) && mv !== 0 && mv !== "") {
      label = Moves.displayName(mv);
    }
    draw_menu_text(label, MOVE_POSITIONS[i][1], MOVE_POSITIONS[i][2], { small: true, colors: FrlgFont.COLOR.NORMAL });
  }
  if (truthy(Ui._swap)) {
    draw_menu_text(RomText.plain("gText_BattleSwitchWhich"), 168, 122,
      { small: false, colors: FrlgFont.COLOR.NORMAL });
    return;
  }
  const slot = Ui._moveIndex;
  const mv = truthy(mon) && truthy(mon.moves) ? mon.moves[slot] : undefined;
  if (truthy(mv) && mv !== 0 && mv !== "") {
    const def: any = Moves.get(mv);
    const pp = truthy(mon.pp) ? lor(mon.pp[slot], 0) : 0;
    const maxPp = orl(() => truthy(mon.maxPp) && mon.maxPp[slot], () => truthy(def) && def.pp, () => pp);
    const ppColors = pp_text_colors(pp, maxPp);
    // pokefirered/src/battle_controller_player.c:1387
    draw_menu_text(RomText.plain("gText_MoveInterfacePP"), 168, 122,
      { small: true, colors: FrlgFont.COLOR.NORMAL });
    // pokefirered/src/battle_controller_player.c:1402
    draw_menu_text(format("%2d/%2d", pp, maxPp), 202, 122, { small: false, colors: ppColors });
    // pokefirered/src/battle_controller_player.c:1413
    draw_menu_text(RomText.plain("gText_MoveInterfaceType") + Types.name(def.type), 168, 138,
      { small: true, colors: FrlgFont.COLOR.NORMAL });
  }
}

// Lua: ui.lua:2355
function draw_enemy_trainer(stage: any): void {
  if (!truthy(stage) || !truthy(stage.trainer)) return;
  const te = stage.trainer.enemy;
  if (truthy(te) && truthy(te.visible)) {
    // pokefirered/src/battle_controller_link_opponent.c:1133
    const pics = seq(seq(te.pic2, te.x2), seq(te.picId, lor(te.x, 176)));
    for (const [, row] of ipairs<any>(pics)) {
      const picId = row[1], x = row[2];
      if (picId != null && x != null) {
        const entry = TrainerPic.front(picId);
        if (truthy(entry) && truthy(entry!.image)) {
          G.setColor(1, 1, 1, 1);
          G.draw(entry!.image, x + lor(te.ox, 0) - 32, 40 + lor(te.oy, 0) - 32);
        }
      }
    }
  }
}

// Lua: ui.lua:2375
function draw_player_trainer(stage: any): void {
  if (!truthy(stage) || !truthy(stage.trainer)) return;
  const tp = stage.trainer.player;
  if (truthy(tp) && truthy(tp.visible)) {
    // pokefirered/src/battle_controller_link_partner.c:1093
    const backs = seq(seq(tp.gender2, tp.x2), seq(lor(tp.gender, 0), lor(tp.x, 80)));
    for (const [, row] of ipairs<any>(backs)) {
      const gender = row[1], x = row[2];
      const entry: any = (gender != null && x != null) ? lor(TrainerPic.back(gender), undefined) : undefined;
      if (truthy(entry) && truthy(entry.image)) {
        const maxFrame = Math.max(0, lor(entry.frames, 5) - 1);
        const frame = Math.max(0, Math.min(maxFrame, (tonumber(tp.frame) ?? 0)));
        const key = "back_" + tostring(gender) + "_" + tostring(frame);
        Ui._trainerQuads = lor(Ui._trainerQuads, {}) as Record<string, Quad>;
        if (!truthy(Ui._trainerQuads[key])) {
          const imgH = orl(() => entry.h, () => truthy(entry.frames) && entry.frames * 64, () => 320);
          Ui._trainerQuads[key] = G.newQuad(0, frame * 64, 64, 64, lor(entry.w, 64), imgH);
        }
        G.setColor(1, 1, 1, 1);
        G.draw(
          entry.image, Ui._trainerQuads[key],
          x + lor(tp.ox, 0) - 32, 80 + lor(tp.oy, 0) - 32);
      }
    }
  }
}

// pokefirered/src/pokeball.c:59
// Lua: ui.lua:2404
Ui.ballSheet = function (): Image | undefined {
  if (Ui._ballSheet == null) {
    Ui._ballSheet = false;
    const d = BallOpen.data();
    if (truthy(d) && truthy(d.ballSheet)) {
      // pcall(require, "src.import.gba.extract_island1"): linked in.
      const root = (truthy(Extract) && truthy(Extract.CACHE_ROOT) ? Extract.CACHE_ROOT : "data/generated/gba") + "/" + BallOpen.CACHE_SUB;
      // pcall(require, "src.core.game3.dataset"): linked in.
      const c: any = truthy(Dataset) && truthy(Dataset.cache) ? Dataset.cache() : undefined;
      const rgba = truthy(c) && truthy(c.read) ? c.read(root + "/" + d.ballSheet) : undefined;
      const w = d.ballSheetW, h = d.ballSheetH;
      if (typeof rgba === "string" && truthy(w) && truthy(h) && rgba.length >= w * h * 4) {
        let id: any;
        let ok = true;
        try {
          id = newImageData(w, h, "rgba8", rgba);
        } catch {
          ok = false;
        }
        let okI = false;
        let img: Image | undefined;
        if (ok && truthy(id)) {
          try {
            img = G.newImage(id);
            okI = true;
          } catch {
            okI = false;
          }
        }
        if (okI && img) {
          img.setFilter("nearest", "nearest");
          Ui._ballSheet = img;
        }
      }
    }
  }
  return truthy(Ui._ballSheet) ? (Ui._ballSheet as Image) : undefined;
};

// Lua: ui.lua:2429
Ui.ballQuad = function (ballId: any, frameIn: any): [Image?, Quad?, number?] {
  const img = Ui.ballSheet();
  if (!img) return [];
  let id = Math.floor((tonumber(ballId) ?? 0));
  if (id < 0 || id > 11) id = 0;
  const frame = Math.max(0, Math.min(2, Math.floor((tonumber(frameIn) ?? 0))));
  Ui._ballQuads = lor(Ui._ballQuads, {}) as Record<number, Quad>;
  const key = id * 3 + frame;
  let q = Ui._ballQuads[key];
  if (!q) {
    const [iw, ih] = img.getDimensions();
    q = G.newQuad(id * 16, frame * 16, 16, 16, iw, ih);
    Ui._ballQuads[key] = q;
  }
  return [img, q, id];
};

// Lua: ui.lua:2446
function draw_ball_entry(ball: any): void {
  if (!truthy(ball) || !truthy(ball.visible)) return;
  const bx = lor(ball.x, 0) + lor(ball.ox, 0);
  const by = lor(ball.y, 0) + lor(ball.oy, 0);
  const rot = (tonumber(ball.rot) ?? 0);
  const frame = Math.max(0, Math.min(2, (tonumber(ball.frame) ?? 0)));
  const darken = (tonumber(ball.darken) ?? 0);
  const flash = (tonumber(ball.flash) ?? 0);
  const shade = Math.max(0, Math.min(1, 1 - darken * (1 - 8 / 255)));

  const alpha = (tonumber(ball.alpha) ?? 1);
  if (flash > 0 && lmod(flash, 2) === 0) {
    G.setColor(1, 1, 1, alpha);
  } else {
    G.setColor(shade, shade, shade, alpha);
  }

  const [img, quad] = Ui.ballQuad(ball.ballId, frame);
  if (img) {
    const blend = ball.blend;
    const blended = truthy(blend) && BallOpen.setBlendShader(blend.coeff, blend.r, blend.g, blend.b);
    G.draw(img, quad, bx, by, rot, 1, 1, 8, 8);
    if (truthy(blended)) G.setShader();
  }

  G.setColor(1, 1, 1, 1);
}

// pokefirered/src/battle_controller_player.c:2105
// Lua: ui.lua:2475
function draw_intro_ball(stage: any): void {
  if (!truthy(stage)) return;
  draw_ball_entry(stage.ball);
  const balls = stage.balls;
  if (isTable(balls)) {
    for (let id = 0; id <= 3; id++) {
      const e = balls[id];
      if (truthy(e) && e !== stage.ball) draw_ball_entry(e);
    }
  }
}

// Lua: ui.lua:2487
function battler_at(st: any, id: number): any {
  if (id === 0) return st.player;
  if (id === 1) return st.enemy;
  return truthy(st.battlers) ? st.battlers[id] : st.battlers;
}

// pokefirered/src/battle_anim_mons.c:1908
// Lua: ui.lua:2494
function draw_double_mons(st: any, stage: any, AnimM: any, screenFxActive: any): void {
  const order = lor(truthy(AnimM.monDrawOrder) ? AnimM.monDrawOrder(st) : undefined, PicCoords.DRAW_ORDER);
  // Lua names this local `band` (shadowing the file's band()).
  const pband = AnimM.particleBand;
  const particles = (k: number): void => {
    let lo: any, hi: any;
    if (truthy(pband)) {
      const r = pband(k, st);
      if (r != null) { lo = r[0]; hi = r[1]; }
    }
    if (!truthy(lo)) {
      lo = (k === 0) ? 0 : (k * 100 + 1);
      hi = (k >= len(order)) ? 999 : (k * 100 + 99);
    }
    AnimM.drawParticles(lo, hi);
  };
  draw_enemy_trainer(stage);
  particles(0);
  for (const [k, id] of ipairs<number>(order)) {
    if (lmod(id, 2) === 0 && k > 1 && lmod(order[k - 1], 2) === 1) {
      draw_player_trainer(stage);
    }
    if (!(truthy(st.absent) && truthy(st.absent[id]))) {
      const b = battler_at(st, id);
      const base = orl(() => truthy(AnimM.coords) && AnimM.coords(st, id), () => PicCoords.battlerCoords(true, id));
      draw_mon_sprite(b, base, lmod(id, 2) === 0, id);
    }
    if (truthy(screenFxActive)) AnimM.beginScreenEffect();
    particles(k);
  }
}

// pokefirered/src/battle_interface.c:540
// Lua: ui.lua:2523
function draw_double_healthboxes(st: any, AnimM: any): void {
  for (let id = 3; id >= 0; id--) {
    const b = battler_at(st, id);
    if (truthy(b) && !(truthy(st.absent) && truthy(st.absent[id]))) {
      Healthbox.draw(id, AnimM.shownBattler(id, b), { st, oy: Ui.bounceOffset("hb", id) });
    }
  }
}

// pokefirered/src/battle_interface.c:1080
// Lua: ui.lua:2533
Ui.partySummaryCoords = function (st: any, battlerId: any, isSwitchingMons?: any): [number, number] {
  const id = (tonumber(battlerId) ?? 0);
  if (lmod(id, 2) === 0) return [136, 96];
  if (truthy(isSwitchingMons) && is_double(st) && id !== 3) return [104, 16];
  return [104, 40];
};

const PARTY_BAR_OPPONENT = { x: 104, y: 40 };
const PARTY_BAR_PLAYER = { x: 136, y: 96 };

// Lua: ui.lua:2540
function draw_party_bars(stage: any): void {
  if (!truthy(stage) || !truthy(stage.partyBar)) return;
  const m: any = lor(truthy(BattleChrome.manifest) ? BattleChrome.manifest() : undefined, {});
  const enemy = stage.partyBar.enemy;
  if (truthy(enemy) && truthy(enemy.visible)) {
    const pos = lor(m.partyBarOpponent, PARTY_BAR_OPPONENT);
    BattleChrome.drawPartyBar(lor(enemy.x, pos.x), lor(enemy.y, pos.y), enemy.balls, enemy.ox, true);
  }
  const player = stage.partyBar.player;
  if (truthy(player) && truthy(player.visible)) {
    const pos = lor(m.partyBarPlayer, PARTY_BAR_PLAYER);
    BattleChrome.drawPartyBar(pos.x, pos.y, player.balls, player.ox, false);
  }
}

// pokeemerald/src/battle_script_commands.c:10131
// Lua: ui.lua:2556
Ui.beginCaughtDexScene = function (caught: any): void {
  caught.pal = Pal.new();
  // pokefirered/src/battle_script_commands.c:9709
  caught.pal.beginFade(caught.family === "frlg" ? 0x1FFFF : Pal.BG, 0, 16, 0, Pal.BLACK);
  Ui._caughtDexScene = caught;
};

// pokeemerald/src/pokedex.c:4079
// Lua: ui.lua:2565
Ui.updateCaughtDexScene = function (): boolean {
  const c = Ui._caughtDexScene;
  if (!truthy(c)) return true;
  const spr = c.sprite;
  const centerY = c.family === "frlg" ? 64 : 80;
  if (spr.x < 120) spr.x = Math.min(120, spr.x + 2);
  if (spr.x > 120) spr.x = Math.max(120, spr.x - 2);
  if (spr.y < centerY) spr.y = Math.min(centerY, spr.y + 1);
  if (spr.y > centerY) spr.y = Math.max(centerY, spr.y - 1);
  c.pal.updateFade();
  return !c.pal.fadeActive();
};

// Lua: ui.lua:2578
Ui.clearCaughtDexScene = function (): void {
  Ui._caughtDexScene = undefined;
};

// Lua: ui.lua:2582
Ui.draw = function (w?: number, h?: number): void {
  // `if not (love and love.graphics) then return end`: always present here.
  w = lor(w, Display.W) as number;
  h = lor(h, Display.H) as number;

  const caught = Ui._caughtDexScene;
  if (truthy(caught)) {
    // pokeemerald/src/battle_script_commands.c:10133
    Fx.draw(() => {
      BattleChrome.drawPostDexBg(BattleBg.sheetKey());
      BattleChrome.drawPanel("none");
    }, caught.pal.fx(0));
    const spr = caught.sprite;
    Fx.draw(() => {
      G.setColor(1, 1, 1, 1);
      G.draw(spr.img, spr.x + lor(spr.x2, 0), spr.y + lor(spr.y2, 0), 0, 1, lor(spr.scaleY, 1), 32, 32);
    }, caught.pal.fx(16));
    if (truthy(Choice) && truthy(Choice.active) && truthy(Choice.draw)) Choice.draw();
    return;
  }

  const st = Ui._st;
  const stage = truthy(Anim.stage) ? Anim.stage() : undefined;

  let enemyOx = 0;
  let playerOx = 0;
  if (truthy(stage) && truthy(stage.bgSlide)) {
    enemyOx = lor(stage.bgSlide.enemyOx, 0);
    playerOx = lor(stage.bgSlide.playerOx, 0);
  }
  // pokefirered/src/battle_intro.c:139
  let bgOx = 0;
  if ((enemyOx !== 0 || playerOx !== 0) && truthy(stage) && truthy(stage.slide)) {
    bgOx = Math.floor(((tonumber(stage.slide) ?? 0)) * 154 * 6 + 0.5);
  }

  const bgDim = lor(truthy(stage) ? stage.bgDim : stage, 0);
  if (bgDim > 0) {
    const s = Math.max(0, 1 - bgDim * 0.65);
    G.setColor(s, s, s, 1);
  } else {
    G.setColor(1, 1, 1, 1);
  }

  const screenFxActive = truthy(Anim.beginScreenEffect) ? Anim.beginScreenEffect() : Anim.beginScreenEffect;

  // pokefirered/src/battle_anim_special.c:1888
  let bgBlended: any = !truthy(screenFxActive) && BallOpen.setBlendShader(BallOpen.bgCoeff(), 31, 31, 31);
  if (!truthy(bgBlended) && !truthy(screenFxActive) && truthy(Anim._bgPalAffine)) {
    bgBlended = set_affine_shader(Anim._bgPalAffine);
  }
  if (!truthy(bgBlended) && !truthy(screenFxActive)) {
    const [bc, br, bg_, bb] = bg_blend_params(Anim._bgBlend);
    if (truthy(bc)) bgBlended = BallOpen.setBlendShader(bc, br, bg_, bb);
  }
  let bg3 = Anim._bg3Scroll;
  if (bg3 == null) {
    const vm = truthy(Anim.vm) ? Anim.vm() : undefined;
    bg3 = truthy(vm) && truthy(vm.active) && truthy(vm.bg3) ? vm.bg3 : undefined;
  }
  const bg3x = (isTable(bg3) ? (tonumber(bg3.x) ?? 0) : 0) as number;
  const bg3y = (isTable(bg3) ? (tonumber(bg3.y) ?? 0) : 0) as number;
  if (bg3x !== 0 || bg3y !== 0) {
    G.push();
    G.translate(-bg3x, -bg3y);
  }
  if (!BattleBg.draw(undefined, enemyOx, playerOx, bgOx)) {
    G.setColor(0.92, 0.94, 0.96, 1);
    G.rectangle("fill", 0, 0, w, 112);
  }
  if (bg3x !== 0 || bg3y !== 0) {
    G.pop();
  }
  if (truthy(bgBlended)) G.setShader();
  if (truthy(screenFxActive)) Anim.beginScreenEffect();
  G.setColor(1, 1, 1, 1);

  // pret-ish 5-layer z:
  // 1. Behind Enemy & Background FX (Z: 0 .. 99)
  // 2. Enemy Mon (Z: 100)
  // 3. In front of Enemy / Behind Player / Mid-field (Z: 101 .. 199)
  // 4. Player Mon (Z: 200)
  // 5. In front of Player & Global Foreground (Z: 201 .. 999)
  const dbl = truthy(st) && is_double(st);
  if (truthy(Anim.beginParticleFrame)) Anim.beginParticleFrame();
  if (dbl) {
    draw_double_mons(st, stage, Anim, screenFxActive);
  } else {
    draw_enemy_trainer(stage);
    Anim.drawParticles(0, 99);
    if (truthy(st)) {
      draw_mon_sprite(st.enemy, ENEMY_MON, false);
    }
    if (truthy(screenFxActive)) Anim.beginScreenEffect();
    Anim.drawParticles(101, 199);
    // pokefirered/src/battle_anim_mons.c:1908
    draw_player_trainer(stage);
    // pokefirered/src/battle_main.c:2565
    if (truthy(st) && !truthy(st.safari)) {
      draw_mon_sprite(st.player, PLAYER_MON, true);
    }
    if (truthy(screenFxActive)) Anim.beginScreenEffect();
    Anim.drawParticles(201, 999);
  }
  if (truthy(Anim.endParticleFrame)) Anim.endParticleFrame();
  draw_intro_ball(stage);
  // pokefirered/src/pokeball.c:770
  BallOpen.draw();
  if (truthy(screenFxActive)) Anim.endScreenEffect();
  if (dbl) {
    draw_double_healthboxes(st, Anim);
  } else if (truthy(st)) {
    Healthbox.draw("enemy", Anim.shownBattler("enemy", st.enemy), { oy: Ui.bounceOffset("hb", 1) });
    Healthbox.draw("player", Anim.shownBattler("player", st.player), { oy: Ui.bounceOffset("hb", 0) });
  }
  draw_party_bars(stage);

  let panelMode = "none";
  if (Ui._mode === "menu") {
    panelMode = "menu";
  } else if (Ui._mode === "moves" || Ui._mode === "target") {
    panelMode = "moves";
  }
  BattleChrome.drawPanel(panelMode);
  BattleChrome.drawMenuFrames(panelMode);

  if (Ui._mode === "menu") {
    draw_action_menu(st);
  } else if (Ui._mode === "moves" || Ui._mode === "target") {
    draw_move_menu(st);
  }

  // pokefirered/src/battle_controller_oak_old_man.c:759
  const oakDim = Ui.voiceoverDim();
  if (oakDim > 0) {
    G.setColor(0, 0, 0, oakDim);
    G.rectangle("fill", 0, 0, w, h);
    G.setColor(1, 1, 1, 1);
    // pokefirered/src/battle_controller_pokedude.c:2607
    if (truthy(st) && !dbl && Ui.litHealthboxShown()) {
      Healthbox.draw("player", Anim.shownBattler("player", st.player), { oy: Ui.bounceOffset("hb", 0) });
    }
  }

  // package.loaded / pcall(require, "src.ui.game3.bag_menu"): linked in.
  if (probeOpen(BagMenu) && truthy(BagMenu.draw)) {
    Screens.draw("bag", BagMenu);
  }

  if (truthy(Choice) && truthy(Choice.active) && truthy(Choice.draw)) {
    Choice.draw();
  }

  // package.loaded / pcall(require, "src.ui.game3.party_menu"): linked in.
  if (probeOpen(PartyMenu) && truthy(PartyMenu.draw)) {
    PartyMenu.draw();
  }

  // package.loaded["src.ui.game3.pokedex"]
  if (probeOpen(Pokedex) && truthy(Pokedex.draw)) {
    Pokedex.draw();
  }
  // package.loaded["src.ui.game3.rse.pokedex"]: no file in the port (G3Lazy).
  const RseDex = G3Lazy["src.ui.game3.rse.pokedex"];
  if (truthy(RseDex) && truthy(RseDex.active) && RseDex.active()) RseDex.Host.draw();

  // package.loaded["src.ui.game3.stat_growth"]: no file in the port (G3Lazy).
  const StatGrowth = G3Lazy["src.ui.game3.stat_growth"];
  if (probeOpen(StatGrowth) && truthy(StatGrowth.draw)
      && stat_window_phase()) {
    StatGrowth.draw();
  }

  G.setColor(1, 1, 1, 1);
};

// Lua: ui.lua:2765
Ui.log = function (): LuaTable {
  return Ui._log;
};

export default Ui;
