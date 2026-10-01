// gen1recomp src/ui/gen2/BattleState.lua (bdfac727, MIT):
// the Gen 2 battle screen.
//
// All logic lives in battle/Battle.ts; this only draws it and feeds it
// actions.  That split is deliberate: the engine emits an event queue, so a
// test can assert a whole battle without a window and this file stays about
// layout and pacing.
//
// Layout follows the cart (engine/battle/core.asm's HUD placement): the enemy's
// name/level and HP bar top-left with its pic top-right, the player's pic
// bottom-left with its HUD bottom-right, and the message box across the bottom
// two rows.  FIGHT/PACK/POKéMON/RUN sit in that box when it is the player's
// turn.
//
// Drawn onto the Gold screen (platform/screen.ts): tiles on the 8px grid are
// BG cells, off-grid ones objects; scales other than +-1 flips are ignored.

import { AnimRunner } from "../battle/AnimRunner.ts";
import { Assets } from "../shared/render/Assets.ts";
import { Battle } from "../battle/Battle.ts";
import { BattleAnimView } from "./BattleAnimView.ts";
import { BattleHud } from "./BattleHud.ts";
import { BattleMusic } from "../battle/BattleMusic.ts";
import { BerryJuice } from "../battle/BerryJuice.ts";
import { Boxes } from "../core/Boxes.ts";
import { BugContest } from "../core/BugContest.ts";
import { CatchTutorial } from "../core/CatchTutorial.ts";
import { Catching } from "../battle/Catching.ts";
import { Chrome } from "./Chrome.ts";
import { Evolution } from "../core/Evolution.ts";
import { GbcPalette } from "../shared/render/GbcPalette.ts";
import { Save as Gen2Save } from "../core/Save.ts";
import { Font } from "../shared/render/Font.ts";
import { ForgetMoveList } from "./ForgetMoveList.ts";
import { HpBar, type HpBarPainter } from "../battle/HpBar.ts";
import { ItemEffects } from "../core/ItemEffects.ts";
import { Mon } from "../battle/Mon.ts";
import { MonAnim } from "../shared/render/MonAnim.ts";
import { Palettes } from "../world/Palettes.ts";
import { Pokerus } from "../core/Pokerus.ts";
import { Prize } from "../battle/Prize.ts";
import { Runtime } from "../shared/mods/Runtime.ts";
import { Screens } from "../shared/ui/Screens.ts";
import { Sound } from "../shared/core/Sound.ts";
import { SpriteAnims } from "./SpriteAnims.ts";
import { Sprites } from "../shared/pokemon/Sprites.ts";
import { Strings } from "../shared/core/Strings.ts";
import { SummaryMenu } from "./SummaryMenu.ts";
import { TypeChart } from "../shared/battle/TypeChart.ts";
import { TextBox } from "../shared/render/TextBox.ts";
import { Typer } from "./Typer.ts";
import { Unown } from "../core/Unown.ts";
import { Playfield } from "../shared/render/Playfield.ts";
import { WideBattle } from "./WideBattle.ts";
import G from "../platform/screen.ts";
import { random } from "../platform/rng.ts";
import { truthy, tonumber, tostring, idiv, mod, insertAt, removeAt, sortedKeys, format } from "../platform/lua.ts";
import { Music } from "../shared/core/Music.ts";

// Armed while a battle line waits for PromptButton (home/text.asm).  Any
// positive value means "hold until A/B"; the cart never times these out, so
// the victory jingle can keep looping through the post-win prompts.
const MESSAGE_FRAMES = 48;

// engine/battle/effect_commands.asm:6661
const MOVE_DELAY_FRAMES = 40;

// ../pokecrystal/home/text.asm:895
const TEXT_PAUSE_FRAMES = 30;

// home/hm_moves.asm:17-25 IsHMMove's .HMMoves.
const HM_MOVES: Record<string, boolean> = {
  CUT: true, FLY: true, SURF: true, STRENGTH: true, FLASH: true,
  WATERFALL: true, WHIRLPOOL: true,
};

// CheckReceivedDex's ENGINE_POKEDEX (home/flag.asm:97-102), read the way
// StartMenu:availability reads it out of save.engineFlags.
const ENGINE_POKEDEX = 11;

// The message box's own two rows.  PrintTextboxText plants the cursor at
// (TEXTBOX_INNERX, TEXTBOX_INNERY) = tile (1,14) (home/text.asm:143), and
// LineChar does NOT step one row: it reloads the cursor at TEXTBOX_INNERY + 2
// (home/text.asm:397), so a two-line battle string sits on rows 14 and 16 with
// row 15 left blank.  Paragraph's ClearBox wipes exactly rows 14-16
// (home/text.asm:411), which is why there is no third row to spill onto.
const TEXT_INNER_X = 1;
const TEXT_INNER_Y = 14;
const TEXT_WIDTH = 18;
const TEXT_ROWS = 2;
const TEXT_ROW_STEP = 2;

// ../pokecrystal/home/text.asm:630
const DOWN_ARROW = "▼";
const ARROW_X = 18, ARROW_Y = 17;

// SlideBattlePicOut (engine/battle/core.asm:2882) is called with a = 8: eight
// one-tile steps with `ld c, 2 / call DelayFrames` between them, so the enemy
// trainer's pic clears the box in 16 frames.
const TRAINER_SLIDE_STEPS = 8;
const TRAINER_SLIDE_FRAMES_PER_STEP = 2;
const TRAINER_SLIDE_FRAMES = TRAINER_SLIDE_STEPS * TRAINER_SLIDE_FRAMES_PER_STEP;
// ../pokecrystal/engine/battle/core.asm:82-84
const BACKPIC_SLIDE_STEPS = 9;
const BACKPIC_SLIDE_FRAMES = BACKPIC_SLIDE_STEPS * TRAINER_SLIDE_FRAMES_PER_STEP;

// BattleWinSlideInEnemyTrainerFrontpic (engine/battle/core.asm:6279-6318) and
// WinTrainerBattle's DelayFrames 40 (:2311)
const WIN_SLIDE_STEPS = 6;
const WIN_SLIDE_FRAMES_PER_STEP = 4;
const WIN_SLIDE_FRAMES = WIN_SLIDE_STEPS * WIN_SLIDE_FRAMES_PER_STEP;
const WIN_SLIDE_REST_TILES = 2;
const WIN_SLIDE_DELAY_FRAMES = 40;

// Lua: BattleState.lua:139
function winSlideTiles(frames: number): number {
  const step = Math.min(WIN_SLIDE_STEPS,
    Math.floor(frames / WIN_SLIDE_FRAMES_PER_STEP) + 1);
  return WIN_SLIDE_STEPS + WIN_SLIDE_REST_TILES - step;
}

// MonFaintedAnimation (engine/battle/core.asm), which PlayerMonFaintedAnimation
// and EnemyMonFaintedAnimation both fall into with the fainted side's pic
// corner: the pic's tilemap rows are copied DOWN one row per step and the row
// it vacates is blanked, so what is left standing shrinks from the top while
// the feet stay on the ground line -- the mon sinks out of the field.  The step
// is the same `ld c, 2 / call DelayFrames` SlideBattlePicOut uses, and the loop
// runs the pic box's own height (7 rows for the enemy's 7x7 box, 6 for the
// player's 6x6), so the pic is gone when it ends.
const FAINT_SLIDE_FRAMES_PER_ROW = 2;

// BattleText_TheresNoWillToBattle / BattleText_AnEGGCantBattle, the two lines
// CheckIfCurPartyMonIsFitToFight prints before it returns zero
// (engine/battle/core.asm:3439-3466, data/text/battle.asm:241-249).
const TEXT_NO_WILL_TO_FIGHT = Strings.source("There's no will to battle!");
const TEXT_EGG_CANT_BATTLE = Strings.source("An EGG can't battle!");
const TEXT_ALREADY_OUT = Strings.source("%s is already out.");
const TEXT_CANT_BE_RECALLED = Strings.source("%s can't be recalled!");
// data/text/battle.asm:207
const TEXT_USE_NEXT_MON = Strings.source("Use next POKéMON?");

// BattleText_TheMoveIsDisabled / BattleText_TheresNoPPLeftForThisMove
// (data/text/battle.asm:315-322).
const TEXT_NO_PP_LEFT = Strings.source("There's no PP left for this move!");
const TEXT_MOVE_DISABLED = Strings.source("The move is DISABLED!");

// _MoveAskForgetText, _MoveCantForgetHMText and _StopLearningMoveText
// (data/text/common_3.asm:124-134).
const TEXT_ASK_FORGET_SLOT = Strings.source("Which move should\nbe forgotten?");
const TEXT_CANT_FORGET_HM = Strings.source("HM moves can't be\nforgotten now.");
const TEXT_STOP_LEARNING = Strings.source("Stop learning\n%s?");

// BattleText_EnemyIsAboutToUseWillPlayerChangeMon (data/text/battle.asm:222-231).
const TEXT_ENEMY_ABOUT_TO_USE = Strings.source(
  "%s\nis about to use\v%s.\fWill %s\nchange POKéMON?");

// _AskForgetMoveText, all three paragraphs (data/text/common_3.asm:141-165).
const TEXT_ASK_FORGET_MOVE = Strings.source(
  "%s is\ntrying to learn\v%s.\fBut %s\ncan't learn more\vthan four moves."
  + "\fDelete an older\nmove to make room\vfor %s?");

// engine/battle/menu.asm BattleMenuHeader: a 2x2 grid at menu_coords 8, 12,
// 19, 17 with 6 tiles of column spacing, filled row-major, so the order on
// screen is FIGHT / PkMn on top and PACK / RUN below -- not the four-in-a-row
// Gen 1 uses.  The second label is the two-glyph <PK><MN> ligature (charmap
// $e1/$e2), which is what makes it fit a six-tile column.
// (Lua 1-based sequence; here a 0-based array.)
const MENU: string[] = [
  Strings.source("FIGHT"), Strings.source("<PK><MN>"),
  Strings.source("PACK"), Strings.source("RUN"),
];
const MENU_ACTION: Record<string, string> = { FIGHT: "fight", "<PK><MN>": "party",
  PACK: "item", RUN: "run" };
const MENU_BOX_X = 8;
const MENU_COL_SPACING = 6;

// ContestBattleMenuHeader is the same 2x2 grid moved out to menu_coords 2, 12
// with 12 tiles of column spacing, because its third label is "PARKBALL×" and
// the count PrintNum writes after it (two digits, leading zeros) at (13,16).
const CONTEST_MENU_BOX_X = 2;
const CONTEST_MENU_COL_SPACING = 12;

// charmap.asm's quantity glyph, spelled the way MartMenu spells it.
const CONTEST_BALL_LABEL = Strings.source("PARKBALL×%02d");

// data/items/heal_status.asm StatusHealingActions: the four rows whose status
// mask is %11111111.  HealStatus's `.not_full_heal` arm is what makes exactly
// these also clear SUBSTATUS_CONFUSED, and IsItemUsedOnConfusedMon what lets
// them be spent on a mon whose only complaint IS the confusion.
const FULL_MASK_HEALERS: Record<string, boolean> = {
  FULL_HEAL: true, FULL_RESTORE: true, HEAL_POWDER: true,
  MIRACLEBERRY: true,
};

// Collapses runs of spaces and tabs so a text assembled out of several pieces
// prints as one flowing line.  A "\n" is deliberately NOT touched: it is the
// cart's own `line` control byte and Chrome.wrap honours it as a hard break, so
// flattening it here would throw away a break the cart authored (the used-move
// line, data/text/common_2.asm:339).
// Lua: BattleState.lua:225
function oneLine(text: unknown): string {
  return tostring(truthy(text) ? text : "").replace(/[ \t]+/g, " ");
}

// `para` and `cont` both PromptButton before they redraw, and `cont` scrolls
// twice so the new page opens on the old page's last line (home/text.asm:403).
const PAGE = "\f", SCROLL = "\v", LINE = "\n";
// Lua: BattleState.lua:232 -- "([^\n\f\v]*)([\n\f\v])"
const SEPARATORS = /([^\n\f\v]*)([\n\f\v])/g;

// Lua: BattleState.lua:234
// Returns [pages, carried]: both 0-based arrays here, carried[k] belonging to
// pages[k] (the Lua's carried[i] belongs to pages[i], 1-based).
function paginate(text: unknown): [string[], boolean[]] {
  const pages: string[] = [];
  let rows: string[] = [];
  const carried: boolean[] = [];
  // Lua: BattleState.lua:236
  const flush = (scroll: boolean): void => {
    if (rows.length > 0) pages.push(rows.join(LINE));
    rows = scroll ? [rows.length > 0 ? rows[rows.length - 1]! : ""] : [];
    if (scroll) carried[pages.length] = true;
  };
  const src = tostring(truthy(text) ? text : "") + PAGE;
  for (const m of src.matchAll(SEPARATORS)) {
    const chunk = m[1]!, sep = m[2]!;
    rows.push(chunk);
    if (sep === PAGE) flush(false);
    else if (sep === SCROLL) flush(true);
  }
  if (pages.length === 0) pages[0] = tostring(truthy(text) ? text : "");
  return [pages, carried];
}

// ../pokecrystal/home/text.asm:517-526
// Lua: BattleState.lua:251 (0-based arrays in and out, as paginate's)
function foldPages(pages: string[], carried: boolean[]): [string[], boolean[]] {
  const out: string[] = [];
  const outCarried: boolean[] = [];
  pages.forEach((page, i) => {
    const lines = Chrome.wrap(page, TEXT_WIDTH);
    out.push(lines.length > TEXT_ROWS
      ? lines.slice(0, TEXT_ROWS).join(LINE) : page);
    if (carried[i]) outCarried[out.length - 1] = true;
    for (let j = TEXT_ROWS + 1; j <= lines.length; j++) {
      // table.concat(lines, LINE, j - TEXT_ROWS + 1, j), 1-based inclusive
      out.push(lines.slice(j - TEXT_ROWS, j).join(LINE));
      outCarried[out.length - 1] = true;
    }
  });
  return [out, outCarried];
}

// Lua: BattleState.lua:289
function isWide(self: any): boolean {
  const options = self.game && self.game.options;
  return (options && options.battleLayout) === "wide";
}

// SUBSTATUS_UNDERGROUND / SUBSTATUS_FLYING... see BattleState.isVanished.
// BattleBGEffect_RunPicResizeScript draws the mon at one of six BG squares:
// 6x6 / 4x4 / 2x2 tiles for the player and 7x7 / 5x5 / 3x3 for the enemy, in
// that order.  Only the SIZE matters here -- the cart's tile tables are the
// same pic sampled coarsely -- so a size index becomes a scale about the
// box's own bottom centre.  (Lua table keyed from 0, as here.)
const PIC_RESIZE_TILES: Record<number, number> = { 0: 6, 1: 4, 2: 2, 3: 7, 4: 5, 5: 3 };

// ../pokecrystal/engine/battle/anim_hp_bar.asm:286
const HP_BAR_FRAMES_PER_STEP = 2;

// .PlayExpBarSound's own two halves (engine/battle/core.asm:7311-7318): the
// looping SFX_EXP_BAR, then `ld c, 10 / call DelayFrames` before the first
// pixel moves.  TerminateExpBarSound (home/audio.asm:497) cuts it dead at the
// end of the segment rather than letting it ring on, and the end-of-bar hit
// only plays where a level was actually crossed.
const SFX_EXP_BAR = "Sfx_ExpBar";
const SFX_END_OF_EXP_BAR = "Sfx_HitEndOfExpBar";
const SFX_GREW_TO_LEVEL = "Sfx_DexFanfare5079";
const EXP_SOUND_FRAMES = 10;
const EXP_WAIT_SFX_CAP = 180;

// (../pokecrystal/engine/sprite_anims/core.asm:547-608).  The `call WaitSFX`
// behind it (../pokecrystal/engine/battle/core.asm:7538) is what holds the
const EXP_BURST_FRAMES = 8;
const EXP_BURST_SPRITES = 8;
const EXP_BURST_X = 10 * 8 + 4 - 8;
const EXP_BURST_Y = 13 * 8 - 16;

// ../pokecrystal/engine/sprite_anims/core.asm:543 leaves a as a signed byte.
// Lua: BattleState.lua:1237
function signedByte(value: number): number {
  if (value >= 128) return value - 256;
  return value;
}

// HpBar's fallback painter (drawHpBar's HpBar.drawWithLabel): the Lua's
// setColor + rectangle pairs and its Font label.
const gPainter: HpBarPainter = {
  rect(x, y, w, h, rgb) {
    if (rgb === "black") G.setColor(0, 0, 0, 1);
    else if (rgb === "white") G.setColor(1, 1, 1, 1);
    else G.setColor(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, 1);
    G.rectangle("fill", x, y, w, h);
    G.setColor(0, 0, 0, 1);
  },
  text(s, x, y) {
    Font.draw(s, x, y);
  },
};

// Lua: BattleState.lua:1659
const VANISH_SIDES = ["player", "enemy"];

// ---- module locals of Lua lines 2360-4722 ----

// ---- module locals of Lua lines 2360-4722 ----

//--------------------------------------------------------------------------
// PokeBallEffect (engine/items/item_effects.asm:213)
//--------------------------------------------------------------------------

// data/battle_anims/ball_colors.asm BallColors, in its own order.  Anything
// not listed falls to the terminator row's PAL_BATTLE_OB_GRAY.
// Lua: BattleState.lua:3222
const BALL_COLORS: Record<string, string> = {
  MASTER_BALL: "PAL_BATTLE_OB_GREEN",
  ULTRA_BALL: "PAL_BATTLE_OB_YELLOW",
  GREAT_BALL: "PAL_BATTLE_OB_BLUE",
  POKE_BALL: "PAL_BATTLE_OB_RED",
  HEAVY_BALL: "PAL_BATTLE_OB_GRAY",
  LEVEL_BALL: "PAL_BATTLE_OB_BROWN",
  LURE_BALL: "PAL_BATTLE_OB_BLUE",
  FAST_BALL: "PAL_BATTLE_OB_BLUE",
  FRIEND_BALL: "PAL_BATTLE_OB_YELLOW",
  MOON_BALL: "PAL_BATTLE_OB_GRAY",
  LOVE_BALL: "PAL_BATTLE_OB_RED",
};
// Lua: BattleState.lua:3235
const BALL_COLOR_DEFAULT = "PAL_BATTLE_OB_GRAY";

// POKE_BALL's own item id (constants/item_constants.asm:13), for a cache whose
// items table has no index on the row.
// Lua: BattleState.lua:3239
const POKE_BALL_ID = 5;

// data/battle/wobble_probabilities.asm WobbleProbabilities: catch rate, then
// the chance out of 255 of wobbling again rather than breaking free.
// Lua: BattleState.lua:3243
const WOBBLE_PROBABILITIES: [number, number][] = [
  [1, 63], [2, 75], [3, 84], [4, 90], [5, 95], [7, 103],
  [10, 113], [15, 126], [20, 134], [30, 149], [40, 160],
  [50, 169], [60, 177], [80, 191], [100, 201], [120, 211],
  [140, 220], [160, 227], [180, 234], [200, 240], [220, 246],
  [240, 251], [254, 253], [255, 255],
];

// GetPokeBallWobble's `cp 3 + 1`: the ball wobbles up to three times and the
// fourth call is the verdict.
// Lua: BattleState.lua:3253
const WOBBLE_LIMIT = 3;

// The four failure lines, indexed by wThrownBallWobbleCount exactly the way
// item_effects.asm:414-428 indexes them (data/text/common_3.asm:239-258).
// Lua: BattleState.lua:3257
const BALL_FAILURE_TEXT: string[] = [
  Strings.source("Oh no! The POKéMON broke free!"),
  Strings.source("Aww! It appeared to be caught!"),
  Strings.source("Aargh! Almost had it!"),
  Strings.source("Shoot! It was so close too!"),
];

// Text_BallCaught's own sound_caught_mon (data/text/common_3.asm:265).
// Lua: BattleState.lua:3265
const SFX_CAUGHT_MON = "Sfx_CaughtMon";

// HpBar's fallback painter for the exp bar: the Lua's setColor + rectangle
// pairs (HpBar.drawExp takes its painter first in the port).
const expPainter: HpBarPainter = {
  rect(x, y, w, h, rgb) {
    if (rgb === "black") G.setColor(0, 0, 0, 1);
    else if (rgb === "white") G.setColor(1, 1, 1, 1);
    else G.setColor(rgb[0]! / 255, rgb[1]! / 255, rgb[2]! / 255, 1);
    G.rectangle("fill", x, y, w, h);
    G.setColor(1, 1, 1, 1);
  },
};

// PlaceNonFaintStatus's five strings, checked in its own priority order
// (PSN, BRN, FRZ, PAR, SLP).  Toxic is the PSN bit worn harder, so it shares
// the tag; confusion is a substatus on the cart and never reaches the HUD.
// Lua: BattleState.lua:4311
const STATUS_TAGS: Record<string, string> = {
  poison: Strings.source("PSN"), toxic: Strings.source("PSN"),
  burn: Strings.source("BRN"), freeze: Strings.source("FRZ"),
  paralyze: Strings.source("PAR"), sleep: Strings.source("SLP"),
};

// Lua: BattleState.lua:4465
function hasBattleSides(self: any): boolean {
  const hasPlayer = truthy(self.battle) && (truthy(self.battle.player) || truthy(self.tutorial));
  return !!(truthy(self.battle) && hasPlayer && truthy(self.battle.enemy));
}

// pokegold engine/pokemon/mon_stats.asm:118-124 (PrintTempMonStats.StatNames).
// Lua: BattleState.lua:4590
const STATS_BOX_ROWS: [string, string][] = [
  ["ATTACK", "attack"], ["DEFENSE", "defense"],
  ["SPCL.ATK", "specialAttack"], ["SPCL.DEF", "specialDefense"],
  ["SPEED", "speed"],
];

// ---- end of those module locals ----

export class BattleState {
  [key: string]: any;
  static [key: string]: any;

  // Lua: BattleState.lua:56
  static isOpaque = true;

  // Lua: BattleState.lua:58
  moveGridNavigation(): boolean {
    if (!Runtime.wantsHook("battle.move_grid_navigation")) return false;
    return Runtime.call("battle.move_grid_navigation", () => false,
                        this) === true;
  }

  // ../pokecrystal/engine/battle/core.asm:9119-9137
  // ../pokecrystal/data/text/battle.asm:10-35
  // Lua: BattleState.lua:103
  static battleStartText(name: string, battleType: any): string {
    const kind = Battle.battleTypeId(battleType);
    if (kind === Battle.BATTLETYPE_FISH) {
      return Strings.get("The hooked %s attacked!", name);
    } else if (kind === Battle.BATTLETYPE_TREE) {
      return Strings.get("%s fell out of the tree!", name);
    }
    return Strings.get("Wild %s appeared!", name);
  }

  // ../pokecrystal/engine/battle/core.asm:6422, :6251-6256
  // Lua: BattleState.lua:114
  static sleepingTreeMon(mon: any, battleType: any): boolean {
    if (Battle.battleTypeId(battleType) !== Battle.BATTLETYPE_TREE) {
      return false;
    }
    return mon != null && mon.status === "sleep";
  }

  // engine/pokemon/learn.asm:135-166
  // Lua: BattleState.lua:177
  static FORGET_LIST = ForgetMoveList;

  // Lua: BattleState.lua:266
  static fillScale(winW?: number, winH?: number): number {
    let w = winW || 0, h = winH || 0;
    // pcall(require, "src.render.Playfield"): inert on the 3DS (rect gives nil)
    if (Playfield && truthy(Playfield.rect)) {
      try {
        const r = Playfield.rect(winW, winH);
        const pw = r ? r[2] : undefined, ph = r ? r[3] : undefined;
        if (truthy(pw) && pw >= 1 && truthy(ph) && ph >= 1) {
          w = pw; h = ph;
        }
      } catch {
        // the Lua's pcall: keep the window size
      }
    }
    return Math.max(1, Math.min(w / (Chrome.SCREEN_W * 8),
      h / (Chrome.SCREEN_H * 8)));
  }

  // Lua: BattleState.lua:279
  static panelScale(winW?: number, winH?: number, fill?: unknown): number {
    // Chrome.fitScale(winW, winH): the Gold screen's fit is a no-op (1)
    if (!truthy(fill)) return Chrome.fitScale();
    return BattleState.fillScale(winW, winH);
  }

  // Lua: BattleState.lua:284
  wantsFillScale(): boolean {
    const options = this.game && this.game.options;
    return (options && options.battleFit) === "fill";
  }

  // Lua: BattleState.lua:294-295
  static isWideBattleLayout = isWide;
  static wideLayout = isWide;

  // Lua: BattleState.lua:297
  panelSize(): [number, number] {
    if (isWide(this)) {
      return [WideBattle.WIDTH, WideBattle.HEIGHT];
    }
    return [Chrome.SCREEN_W * 8, Chrome.SCREEN_H * 8];
  }

  // Lua: BattleState.lua:305
  battlePanelScale(winW?: number, winH?: number): number {
    if (isWide(this)) {
      if (BattleState.prototype.wantsFillScale.call(this)) {
        return WideBattle.fillScale(winW, winH);
      }
      // Chrome.fitScaleFor(winW, winH, WideBattle.WIDTH / 8,
      //   WideBattle.HEIGHT / 8): a no-op (1) on the Gold screen
      return Chrome.fitScaleFor();
    }
    return BattleState.panelScale(winW, winH, BattleState.prototype.wantsFillScale.call(this));
  }

  // Lua: BattleState.lua:317
  drawsWidescreen(): boolean { return true; }

  // engine/battle/core.asm:8754
  // Lua: BattleState.lua:320
  bgMode(): string {
    const options = this.game && this.game.options;
    if (options && isWide(this) && options.battleFit === "fill"
       && options.battleHud === "extended") {
      return "white";
    }
    const mode = options && options.battleBg;
    if (mode === "black" || mode === "world") return mode;
    return "white";
  }

  // Lua: BattleState.lua:331
  static BG_WORLD_DIM = 0.55;

  // Lua: BattleState.lua:333
  extendedHUD(): boolean {
    const options = this.game && this.game.options;
    if (!(options && isWide(this) && options.battleHud === "extended")) {
      return false;
    }
    const bg = BattleState.prototype.bgMode.call(this);
    if (options.battleFit === "fill") return bg === "white";
    return bg === "white" || bg === "black" || bg === "world";
  }

  // Lua: BattleState.lua:343
  extendedWorldHUD(): boolean {
    const options = this.game && this.game.options;
    return BattleState.prototype.extendedHUD.call(this) && options.battleFit !== "fill"
       && BattleState.prototype.bgMode.call(this) === "world";
  }

  // Lua: BattleState.lua:349
  extendedBlackHUD(): boolean {
    return BattleState.prototype.extendedHUD.call(this)
      && BattleState.prototype.bgMode.call(this) === "black";
  }

  // Lua: BattleState.lua:353
  bottomUIVisible(): boolean {
    if (!Runtime.wantsHook("battle.bottom_ui_visible")) return true;
    return Runtime.call("battle.bottom_ui_visible", () => true,
                        this) !== false;
  }

  // Lua: BattleState.lua:359
  statusHUDVisible(): boolean {
    if (!Runtime.wantsHook("battle.status_hud_visible")) return true;
    return Runtime.call("battle.status_hud_visible", () => true,
                        this) !== false;
  }

  // Class frontpic for the battle intro.  A trainers-registry `pic` wins over
  // the extracted menu_gfx sheet; `trueColor` skips the GBC 4-shade remap.
  // Returns path, trueColor.
  // Lua: BattleState.lua:368
  static trainerArt(data: any, classId: any): [string | undefined, boolean] {
    if (!truthy(classId)) return [undefined, false];
    const classes = data && data.gen2Trainers && data.gen2Trainers.classes;
    const classDef = classes && classes[classId];
    const hud = data && data.gen2MenuGfx && data.gen2MenuGfx.battleHud;
    const path = (classDef && classDef.pic)
      || (hud && hud.trainerPics && hud.trainerPics[classId]) || undefined;
    return [path, truthy(classDef && classDef.trueColor) ? true : false];
  }

  // opts: battle (a Battle), onDone(outcome), save
  // Lua: BattleState.lua:379
  static new(game: any, opts?: any): BattleState {
    opts = opts || {};
    const self = new BattleState();
    self.game = game;
    self.save = opts.save || (game && game.save);
    const data = (game && game.data) || {};
    self.palettes = data.gen2Palettes;
    self.pokemon = data.pokemon;
    self.battle = opts.battle;
    self.onDone = opts.onDone;
    self.link = opts.link;
    // What PlayVictoryMusic needs to know about the opponent (the class the
    // trainer belongs to); nil for a wild battle.
    self.music = opts.music;
    // BATTLETYPE_CONTEST (constants/battle_constants.asm): the park ball menu,
    // the caught mon being HELD in wContestMon rather than added to the party,
    // and CheckContestBattleOver's draw on the last ball.  Set only by
    // World:tryContestEncounter.
    self.contest = truthy(opts.contest) ? true : undefined;
    // BATTLETYPE_TUTORIAL: the DUDE's demonstration.  No mon is sent out
    // (engine/battle/core.asm jumps straight to BattleMenu), the pack is his,
    // the ball cannot fail and nothing it catches is kept.  Set only by
    // World:startCatchTutorial; core/CatchTutorial.ts has the rest.
    self.tutorial = truthy(opts.tutorial) ? true : undefined;
    self.queue = [];
    self.message = undefined;
    self.messageTimer = 0;
    // ../pokecrystal/home/joypad.asm:428
    self.arrowBlink = 0;
    self.phase = "intro"; // intro | menu | moves | resolving | evolving | done
    // wEvolvableFlags (ram/wram.asm, one bit per party slot).
    // engine/battle/core.asm sets a mon's bit the moment it levels up, right
    // after its LearnLevelMoves run, and ExitBattle's EvolveAfterBattle sweep
    // only looks at flagged slots.  start_battle.asm clears the array at the
    // start of every battle, which is why this lives on the screen and not on
    // the save.  (Keyed by party slot as in the Lua.)
    self.evolvable = {};
    self.menuIndex = 1;
    self.moveIndex = 1;
    self.picCache = {};
    // Which side's pic box stays EMPTY until a send-out redraws it: a catch
    // latches from stepAnim (data/moves/animations.asm:379), a faint from the slide.
    self.picHidden = { player: false, enemy: false };
    self.vanishReveal = {};
    // engine/battle/effect_commands.asm:5475-5485
    self.vanishSeen = { player: false, enemy: false };
    // engine/battle/sliding_intro.asm: 72 frames of the two halves sliding in
    // from opposite sides before the first message.
    self.slideFrame = 0;
    // The HUD draws from the cart's own tiles when the cache has them; without
    // them (an older import) drawHpBar falls back to the plain rectangles.
    self.hud = BattleHud.new(data.gen2MenuGfx, self.palettes);
    // The battle-animation runtime.  Both halves are optional: a cache built
    // before the scripts were extracted simply has no `anims`, and every call
    // site below already guards on that.
    self.anims = data.gen2BattleAnims;
    self.animConstants = data.gen2Constants;
    if (self.anims && self.anims.scripts) {
      self.animView = BattleAnimView.new(self.anims, self.palettes);
    }
    self.anim = undefined;

    // The intro sequence is the cart's, in the cart's order:
    //   BattleIntroSlidingPics    both halves slide in, and the player's box
    //                             holds the TRAINER's back-pic, not a mon
    //   BattleStartMessage        "Wild X appeared!"
    //   SendOutPlayerMon          swap in the mon's backpic, play
    //                             ANIM_SEND_OUT_MON, then "Go! X!"
    // so `showPlayerTrainer` is true for everything up to the send-out.
    //
    // In the tutorial the send-out never comes, so the back-pic stands for the
    // whole battle -- and GetTrainerBackpic's "Special exception for Dude" swaps
    // ChrisBackpic for DudeBackpic to draw it.  A cache built before DudeBackpic
    // was extracted has no `dudeBack`, and falls back to the player's own.
    self.showPlayerTrainer = true;
    self.playerBackImage = undefined;
    self.playerBackTrueColor = false;
    const hudGfx = data.gen2MenuGfx && data.gen2MenuGfx.battleHud;
    let backPath = hudGfx && hudGfx.playerBack;
    // GetTrainerBackpic's gender arm, under the Dude exception
    // (../pokecrystal/engine/battle/core.asm:8984-9008).
    if (hudGfx && hudGfx.playerBackFemale && Gen2Save.isFemale(self.save)) {
      backPath = hudGfx.playerBackFemale;
    }
    if (self.tutorial && hudGfx && hudGfx.dudeBack) {
      backPath = hudGfx.dudeBack;
    }
    // player.sprite, the same hook and payload Gen 1 raises for its own back pic
    // (shared/pokemon/Sprites.ts): the Dude's stand-in is the `demo` flag there.
    // Both return values matter here -- a mod's trueColor answer has to survive
    // to drawPic, or GbcPalette treats the replacement art as a grayscale 2bpp
    // sheet and remaps it through a palette instead of leaving it alone.
    let backTrueColor: boolean;
    [backPath, backTrueColor] = Sprites.playerPic(backPath, {
      side: "back", kind: "battle", demo: self.tutorial ? true : false,
      battle: self.battle, data: data,
    } as any);
    if (backPath) {
      try {
        const image = Assets.image(backPath);
        self.playerBackImage = image;
        // Kept so battle_sprite_scales can be looked up for this pic too: it is
        // not a species' pic, so its asset path is the only key it has.
        self.playerBackPath = backPath;
        self.playerBackTrueColor = backTrueColor ? true : false;
      } catch {
        // pcall failed: no back pic
      }
    }

    // Neither HUD exists while the bands slide.  InitBattleDisplay blanks the
    // WHOLE tilemap (.BlankBGMap) and draws only the textbox and the two pics
    // before BattleIntroSlidingPics (engine/battle/core.asm:8554/8564), so the
    // names, levels, bars and borders are not on screen to ride in with them.
    // UpdateEnemyHUD runs only after BattleStartMessage returns, and then only
    // for a WILD battle (core.asm:7815-7817); a trainer's comes up at the tail of
    // ShowSetEnemyMonAndSendOutAnimation (core.asm:3384).  UpdatePlayerHUD runs
    // at the tail of SendOutPlayerMon, after the send-out anim and the cry
    // (core.asm:3838).
    self.showEnemyHud = false;
    self.showPlayerHud = false;

    // engine/battle/trainer_huds.asm:1-9
    self.ballRows = { player: false, enemy: false };
    self.startHuds = {
      player: true,
      enemy: !(self.battle && self.battle.wild),
    };

    // InitEnemyTrainer (engine/battle/core.asm:7848) puts the CLASS's 7x7
    // frontpic in the enemy pic box BEFORE the intro slide, and it stays there
    // until ResetEnemyBattleVars slides it off; only then is the mon drawn.  The
    // pic is a cache asset, so an import made before the extractor grew that
    // stage has none and the mon stands in for the whole intro.
    self.showEnemyTrainer = false;
    self.enemyTrainerTrueColor = false;
    // The CLASS CONSTANT (BUG_CATCHER), which is what both tables this looks the
    // pic up in are keyed by: menu_gfx's trainerPics is written out of
    // constants.trainerClassOrder, and palettes.trainers out of the same names.
    // Trainers.lookup's `class` field is whatever the CALLER asked with, and the
    // overworld asks with the numeric constant an object_event's trainer struct
    // carries (36, not "BUG_CATCHER") -- so reading `class` here found no pic and
    // no palette for every trainer the world starts, which is all of them.
    // `classId` is the trainers.lua key, i.e. the constant; `className` is the
    // DISPLAY name ("BUG CATCHER", with the space) and is not a key at all.
    // A class record's own `pic` / `trueColor` (the trainers registry) wins
    // over the extracted sheet, so a mod can drop in full-color art.
    const enemyTrainer = self.battle && self.battle.trainer;
    self.enemyTrainerClass = enemyTrainer
      && (enemyTrainer.classId ?? enemyTrainer.class);
    const [trainerPath, trainerTrueColor] =
      BattleState.trainerArt(data, self.enemyTrainerClass);
    if (trainerPath) {
      try {
        const image = Assets.image(trainerPath);
        if (image) {
          self.enemyTrainerImage = image;
          self.enemyTrainerPath = trainerPath;
          self.enemyTrainerTrueColor = trainerTrueColor ? true : false;
          self.showEnemyTrainer = true;
        }
      } catch {
        // pcall failed: the mon stands in for the whole intro
      }
    }

    let enemy = self.battle && self.battle.enemy;
    self.noteFirstUnown(enemy);
    self.markSeen(enemy);
    if (enemy) {
      if (self.battle.wild) {
        // BattleCheckEnemyShininess: a shiny wild mon gets ANIM_SEND_OUT_MON's
        // `.Shiny` arm before its cry and its line (core.asm:8705-8715).
        if (enemy.shiny) self.push({ kind: "shiny-flash" });
        // BattleStartMessage's `.wild` arm ends on WildPokemonAppearedText
        // (core.asm:8730); `intro` is what defers the enemy HUD to the step after
        // it, which is where StartBattle's `call z, UpdateEnemyHUD` sits.
        // ../pokecrystal/engine/battle/core.asm:9104-9106
        const asleep = BattleState.sleepingTreeMon(enemy, self.battle.battleType);
        self.push({ kind: "message", intro: true,
          cry: (!asleep) ? enemy : undefined,
          text: BattleState.battleStartText(self.name(enemy),
            self.battle.battleType) });
      } else {
        const trainerName = (self.battle.trainer && self.battle.trainer.name)
          || "Foe";
        // WantsToBattleText (core.asm:8701), read against the trainer's own pic.
        self.push({ kind: "message",
          text: Strings.get("%s wants to battle!", trainerName) });
        // ResetEnemyBattleVars' SlideBattlePicOut at the head of EnemySwitch
        // (core.asm:3027) pushes that pic off the right edge before the mon is
        // announced.  Nothing to slide when the cache has no trainer pic.
        if (self.showEnemyTrainer) {
          self.push({ kind: "trainer-slide" });
        } else {
          // ../pokecrystal/engine/battle/core.asm:3549
          self.picHidden.enemy = true;
        }
        // ShowBattleTextEnemySentOut, then ShowSetEnemyMonAndSendOutAnimation
        // (core.asm:2978-2980, 3354): this is where the mon's frontpic first
        // appears, where ANIM_SEND_OUT_MON plays and where the HUD comes up.
        self.push({ kind: "send", side: "enemy", mon: enemy,
          text: Battle.sentOutText(trainerName, self.name(enemy)) });
      }
    }
    const player = self.battle && self.battle.player;
    if (player) {
      // ../pokecrystal/engine/battle/core.asm:82-84
      self.push({ kind: "backpic-slide" });
      self.push({ kind: "sendout",
        text: Strings.get("Go! %s!", self.name(player)) });
    }
    // What the HUD shows chases the real HP one tick at a time
    // (engine/battle/anim_hp_bar.asm), re-armed by each damage/heal event as
    // the queue consumes it.  The engine has already finished the whole turn's
    // math by the time the first message shows, so drawing mon.hp directly
    // would spoil every hit before its own line ran -- and leave the bars
    // looking frozen while the messages replay.
    self.shownHp = {
      player: (player && player.hp) || 0,
      enemy: (enemy && enemy.hp) || 0,
    };
    // Which mon each side's HUD and pic actually draw, for the same reason: the
    // engine has already rebound battle.enemy by the time the faint line runs, so
    // reading it straight would swap the sprite and the name a beat before
    // "X fainted!" is even displayed.  The replacement arrives with its own
    // `send` event, which is where the cart's send-out animation sits.
    self.shownMon = { player: player, enemy: enemy };
    // home/battle.asm:150 UpdateBattleHuds
    self.shownStatus = {
      player: (player && player.status) || false,
      enemy: (enemy && enemy.status) || false,
    };
    // engine/battle/trainer_huds.asm:142-151
    self.caughtMark = self.dexCaught(enemy);
    // And the same for the two numbers AnimateExpBar walks: wBattleMonLevel is
    // only advanced inside its level loop, right after that level's bar has
    // crawled full (engine/battle/core.asm:7267-7274), so neither the level nor
    // the exp fill may be read live off the mon.
    self.shownLevel = (player && player.level) || 1;
    self.shownExp = player
      ? self.expPixels(player, player.level, player.experience) : 0;
    enemy = self.battle && self.battle.enemy;
    Runtime.emit("battle.started", {
      battle: self,
      kind: (self.battle && self.battle.wild && "wild")
        || (self.link && "link") || "trainer",
      trainerId: self.battle && self.battle.trainer && self.battle.trainer.id,
      species: enemy && enemy.species,
      level: enemy && enemy.level,
    });
    return self;
  }

  // CalcExpBar (engine/battle/core.asm:7555): the bar is 64 pixels of the span
  // between THIS level's exp and the next level's, not a share of the mon's
  // total exp.
  // Lua: BattleState.lua:630
  expPixels(mon: any, level?: number, exp?: number): number {
    const growth = this.growthOf(mon);
    if (!truthy(growth)) return 0;
    level = Math.max(1, Math.min(Mon.MAX_LEVEL, level || 1));
    const base = Mon.experienceForLevel(growth, level);
    const next_ = Mon.experienceForLevel(growth, level + 1);
    if (base == null || next_ == null || next_ <= base) return 0;
    const into = Math.max(0, Math.min(next_ - base, (exp ?? base) - base));
    return Math.floor(into * BattleHud.EXP_LENGTH_PX / (next_ - base));
  }

  // Lua: BattleState.lua:641
  name(mon: any): string {
    if (!truthy(mon)) return "?";
    return mon.nickname || mon.name || mon.species || "?";
  }

  // wFirstUnownSeen: the letter of the first Unown the player ever MET, written
  // by both enemy send-out paths (`cp UNOWN / ld a, [wFirstUnownSeen] / and a /
  // jr nz / predef GetUnownLetter / ld [wFirstUnownSeen], a`,
  // engine/battle/core.asm:7894-7902 and :3251-3259) and only while it is still
  // zero.  Pokedex_LoadSelectedMonTiles copies it into wUnownLetter before
  // GetMonFrontpic (engine/pokedex/pokedex.asm:2364), so the #DEX entry shows the
  // form the player first met -- seeing order, not catching order, which is why
  // an Unown that was fled from still sets it.
  // Lua: BattleState.lua:654
  noteFirstUnown(mon: any): void {
    const save = this.save;
    if (!(save && mon && mon.species === Unown.SPECIES)) return;
    if ((save.firstUnownSeen ?? 0) !== 0) return;
    save.firstUnownSeen = Unown.monLetter(mon);
  }

  // LoadEnemyMon's "Saw this mon" (engine/battle/core.asm:6203-6209): the seen
  // flag is stamped for every battle mode, so a trainer's mon counts too.
  // Lua: BattleState.lua:663
  markSeen(mon: any): void {
    const save = this.save;
    if (!(save && mon && mon.species)) return;
    save.pokedex = save.pokedex || { seen: {}, caught: {} };
    save.pokedex.seen = save.pokedex.seen || {};
    save.pokedex.seen[mon.species] = true;
  }

  // The DUDE answering a prompt.  Every re-arm in the ASM sits at the moment the
  // cart starts WAITING for a button (`.wait_input` in home/joypad.asm, BattleMenu
  // before LoadBattleMenu, TutorialPack before its own loop), so each one goes
  // here right where this screen starts waiting for the same button.
  //
  // `key` makes the arm idempotent for a wait that spans many steps: the prompt
  // stream must be armed ONCE per message, not re-armed every step, or its 0x51
  // blank frames restart forever and the A never lands.  A nil key arms every
  // time it is called, which is what the one-shot menu and pack arms want.
  //
  // `skipIdle` is the pacing correction, and it is a port decision rather than
  // the cart's: the menu and pack streams are consumed by loops that call
  // GetJoypad with NO frame delay (engine/menus/menu.asm `.loopRTC`, and the
  // pack's own), so their long NO_INPUT runs are loop iterations and are gone in
  // a frame or two.  This port polls once per fixed step, so replaying those runs
  // step by step would park the DUDE on the battle menu for seventeen seconds.
  // The presses and their ORDER are what the stream is for, and both survive.
  // Lua: BattleState.lua:688
  dudeInput(stream: string, key?: any, skipIdle?: boolean): boolean {
    if (!this.tutorial) return false;
    if (key != null && this.dudeArmed === key) return false;
    this.dudeArmed = key;
    const game = this.game;
    return CatchTutorial.rearm(game && game.autoInput, stream,
      game && game.input, skipIdle);
  }

  // ../pokecrystal/engine/battle/move_effects/transform.asm:118-136
  // Lua: BattleState.lua:698
  push(event: any): void {
    if (event.kind === "transform" && event.side && event.from && this.shownMon
        && this.shownMon[event.side] === event.mon) {
      // setmetatable({ species = event.from }, { __index = event.mon })
      this.shownMon[event.side] =
        Object.assign(Object.create(event.mon ?? null), { species: event.from });
    }
    // pokecrystal/engine/battle/core.asm:8294
    if (event.kind === "identity" && event.side && event.species
        && this.shownMon) {
      this.identityPin = this.identityPin || {};
      this.identityPin[event.side] = true;
      this.shownMon[event.side] = Object.assign(Object.create(event.mon ?? null),
        { species: event.species, partySpecies: event.partySpecies });
    }
    this.queue.push(event);
  }

  // Lua: BattleState.lua:716
  pushAll(events: any[] | undefined): void {
    this.latchVanished(events);
    for (const event of events || []) this.push(event);
  }

  // LearnMove returns before HandleEnemyMonFaint's send-out/prize arms
  // (engine/battle/core.asm:1959-2010).
  // Lua: BattleState.lua:723
  pushFront(events: any[] | undefined): void {
    this.latchVanished(events);
    const list = events || [];
    for (let i = list.length - 1; i >= 0; i--) {
      this.queue.unshift(list[i]);
    }
  }

  // Lua: BattleState.lua:730
  // Returns [image | undefined, trueColor, path].
  pic(mon: any, back?: boolean): [any, boolean, string?] {
    const def = this.pokemon && mon && this.pokemon[mon.species];
    let path: string | undefined = def ? (back ? def.spriteBack : def.spriteFront) : undefined;
    // `ld hl, wEnemyMonDVs / predef GetUnownLetter / predef GetMonFrontpic`:
    // Unown's pic is picked by FORM, out of UnownPicPointers rather than out of
    // its own PokemonPicPointers row.  Everything else reads one row.
    let letter: any;
    let trueColor = truthy(def && def.trueColor) ? true : false;
    if (mon && mon.species === Unown.SPECIES) {
      letter = Unown.monLetter(mon);
      path = Unown.formSprite(this.pokemon, letter, back) || path;
    }
    // pokemon.sprite, the same name and the same ctx keys Gen 1 resolves its
    // battle pics through (src/pokemon/Sprites.lua:path), so one subscription
    // reskins both games: `side` is "front"/"back", `kind` says which screen is
    // asking, `mon` is the live battler for a per-instance skin and `trueColor`
    // is the mod's way of saying "this art is already coloured, leave the GBC
    // palette off it".  The seam sits HERE rather than on Sprites.path because
    // the vanilla answer it has to be given is the one the Unown row above
    // picked -- resolving the species row again would throw the form away.  The
    // two extra keys are what Gen 2 genuinely carries more of: the Unown letter
    // and the shiny flag that decides the palette.
    if (path) {
      [path, trueColor] = Sprites.pic(path, {
        species: mon.species,
        side: back ? "back" : "front",
        kind: "battle",
        mon: mon,
        trueColor: trueColor,
        data: (this.game && this.game.data) || undefined,
        letter: letter,
        shiny: mon.shiny ? true : false,
      } as any);
    }
    if (!path) return [undefined, false];
    let cached = this.picCache[path];
    if (cached === undefined) {
      try {
        cached = Assets.image(path) || false;
      } catch {
        cached = false;
      }
      this.picCache[path] = cached;
    }
    return [cached || undefined, trueColor, path];
  }

  // Crystal's animated front pics.  A cache with no `anim` row -- every Gold
  // and Silver one -- gets nil here and the static pic is drawn as before.
  // Lua: BattleState.lua:776
  animData(mon: any): any {
    const def = this.pokemon && mon && this.pokemon[mon.species];
    if (!def) return undefined;
    if (mon.species === Unown.SPECIES && def.letters) {
      const entry = def.letters[Unown.name(Unown.monLetter(mon)) as string];
      if (entry && entry.anim) return entry.anim;
    }
    return def.anim;
  }

  // ../pokecrystal/engine/gfx/load_pics.asm:105-131
  // Lua: BattleState.lua:787
  frontPicReplaced(mon: any): boolean {
    const def = this.pokemon && mon && this.pokemon[mon.species];
    let vanilla = def && def.spriteFront;
    if (mon && mon.species === Unown.SPECIES) {
      vanilla = Unown.formSprite(this.pokemon, Unown.monLetter(mon), false)
        || vanilla;
    }
    if (typeof vanilla !== "string") return false;
    const [, , path] = this.pic(mon, false);
    if (typeof path === "string" && path !== vanilla) return true;
    return Assets.resolve(vanilla) !== vanilla;
  }

  // one cart asset, two files on the pokemon.sprite seam (#1827)
  // ../pokecrystal/engine/gfx/load_pics.asm:132-158
  // Lua: BattleState.lua:802
  animSheetPath(mon: any, data: any): [string | undefined, boolean] {
    const path = data && data.sheet;
    if (typeof path !== "string") return [undefined, false];
    let letter: any;
    if (mon && mon.species === Unown.SPECIES) letter = Unown.monLetter(mon);
    const [hooked] = Sprites.pic(path, {
      species: mon && mon.species,
      side: "front",
      kind: "battle_anim",
      mon: mon,
      data: (this.game && this.game.data) || undefined,
      letter: letter,
      shiny: mon && mon.shiny ? true : false,
    } as any);
    if (hooked !== path) return [hooked, true];
    return [path, Assets.resolve(path) !== path];
  }

  // ANIM_MON_NORMAL, the scene BattleStartMessage runs on the enemy's frontpic.
  // ../pokecrystal/engine/battle/core.asm:9112-9113
  // Lua: BattleState.lua:822
  startFrontAnim(mon: any): void {
    this.frontAnim = undefined;
    const data = this.animData(mon);
    if (!data) return;
    const [sheet, sheetReplaced] = this.animSheetPath(mon, data);
    if (!sheet) return;
    if (!sheetReplaced && this.frontPicReplaced(mon)) return;
    let cached = this.picCache[sheet];
    if (cached === undefined) {
      // pcall(Assets.image, sheet): the animation sheets are not cooked for
      // the Gold screen, so this fails and the static pic stands, exactly as
      // the Lua's failure path does.
      try {
        cached = Assets.image(sheet) || false;
      } catch {
        cached = false;
      }
      this.picCache[sheet] = cached;
    }
    if (!cached) return;
    const runner = MonAnim.new(data, "battle");
    if (!runner) return;
    const size = data.tiles * 8;
    this.frontAnim = { mon: mon, runner: runner, sheet: cached, size: size,
      quads: {} };
  }

  // AnimateFrontpic's .loop, one scene command per frame.
  // ../pokecrystal/engine/gfx/pic_animation.asm:79-89
  // Lua: BattleState.lua:845
  stepFrontAnim(): void {
    const state = this.frontAnim;
    if (!state) return;
    state.runner.update();
    if (state.runner.finished()) this.frontAnim = undefined;
  }

  // The sheet is one column of whole pictures, base first, so a frame is one
  // quad at the size the static pic would have been.
  // Lua: BattleState.lua:854
  frontAnimFrame(mon: any): [any, any, number] | undefined {
    const state = this.frontAnim;
    if (!(state && mon && state.mon === mon)) return undefined;
    const frame = state.runner.currentFrame();
    if (frame <= 0) return undefined;
    let quad = state.quads[frame];
    if (!quad) {
      const [w, h] = state.sheet.getDimensions();
      if ((frame + 1) * state.size > h) return undefined;
      quad = G.newQuad(0, frame * state.size, state.size, state.size,
        w, h);
      state.quads[frame] = quad;
    }
    return [state.sheet, quad, state.size];
  }

  // The battle_sprite_scales registry: record id -> { path, scale }, keyed by the
  // ASSET PATH the pic is drawn from rather than by species, which is the only
  // handle there is on the pics that are not a species' own (the player's
  // trainer back, the DUDE's, an opponent's frontpic).  Same table, same record
  // shape and same resolution order as Gen 1's BattleState.imageBattleScale /
  // resolveBattleScale: image-level first, then the species record's own
  // battleScaleFront / battleScaleBack, then the default.  The DEFAULT is where
  // the two generations genuinely differ and why this is not a call into that
  // module: Gen 1's back pics are 32x32 drawn at 2x, Gen 2's are 48x48 and fill
  // their 6x6 box at 1x, so both sides default to 1 here.
  // Lua: BattleState.lua:880
  imageScale(path: string | undefined): number | undefined {
    const data = this.game && this.game.data;
    const scales = data && data.battle_sprite_scales;
    if (!(scales && path)) return undefined;
    // pairs(): the first record with this path wins; sorted for determinism
    for (const id of sortedKeys(scales)) {
      const record = scales[id];
      // `_owners` is the registry's own bookkeeping row, not a record.
      if (id !== "_owners" && typeof record === "object" && record !== null && record.path === path) {
        return tonumber(record.scale);
      }
    }
    return undefined;
  }

  // Lua: BattleState.lua:893
  picScale(path: string | undefined, mon: any, back?: boolean): number {
    const scale = this.imageScale(path);
    if (scale != null) return scale;
    const def = this.pokemon && mon && this.pokemon[mon.species];
    const override = def ? (back ? def.battleScaleBack : def.battleScaleFront) : undefined;
    return tonumber(override) ?? 1;
  }

  // Where the two pics go, straight out of engine/battle/core.asm:
  //
  //   enemy front: hlcoord 12, 0 with lb bc, 7, 7  -- a 7x7 tile box at (96, 0)
  //   player back: hlcoord 2, 6  with lb bc, 6, 6  -- a 6x6 tile box at (16, 48)
  //
  // Back pics are always 48x48 so they fill their box exactly.  Front pics vary
  // (Cyndaquil is 40x40, Onix 56x56) and are padded into the 7x7 box bottom-first,
  // which is what keeps a small mon standing on the same ground line as a big one
  // instead of floating at the top of the box.
  // Lua: BattleState.lua:910-915
  static ENEMY_PIC_TILE_X = 12;
  static ENEMY_PIC_TILE_Y = 0;
  static ENEMY_PIC_TILES = 7;
  static PLAYER_PIC_TILE_X = 2;
  static PLAYER_PIC_TILE_Y = 6;
  static PLAYER_PIC_TILES = 6;

  // SUBSTATUS_UNDERGROUND / SUBSTATUS_FLYING, which BattleCommand_Charge sets on
  // FLY and DIG only (engine/battle/effect_commands.asm:5478-5485); the port
  // carries both as the volatile `vanished` flag.
  // Lua: BattleState.lua:927
  static isVanished(mon: any): boolean {
    const volatiles = mon && mon.volatile;
    return truthy(volatiles && volatiles.vanished) ? true : false;
  }

  // engine/battle/effect_commands.asm:5475-5485
  // Lua: BattleState.lua:933
  isUnderground(side: string, mon?: any): boolean {
    if (mon == null) mon = this.battle && this.battle[side];
    return BattleState.isVanished(mon)
      && truthy(this.vanishSeen && this.vanishSeen[side]) ? true : false;
  }

  // Lua: BattleState.lua:939
  drawPic(mon: any, back?: boolean): void {
    // During the intro slide the player-side pic belongs to presentSlide's
    // backpic overlay, not to the baked bands (see BattleAnimView).
    if (back && this.slidingBackpic) return;
    let [image, trueColor, path] = this.pic(mon, back);
    // Before SendOutPlayerMon the player's box holds ChrisBackpic instead, in
    // the same 6x6 box at hlcoord 2, 6 that the mon's backpic uses.
    const trainerBack = back && this.showPlayerTrainer && this.playerBackImage;
    if (trainerBack) {
      image = trainerBack; path = this.playerBackPath;
      trueColor = this.playerBackTrueColor;
    }
    // And the enemy's box holds the trainer's own frontpic until EnemySwitch
    // slides it out (InitEnemyTrainer, engine/battle/core.asm:7848).
    const enemyTrainer = (!back) && this.showEnemyTrainer
      && this.enemyTrainerImage;
    if (enemyTrainer) {
      image = enemyTrainer; path = this.enemyTrainerPath;
      trueColor = this.enemyTrainerTrueColor;
    }
    if (!image) return;
    const side = back ? "player" : "enemy";
    // The box is empty either because the animation running right now has
    // cleared it, or because the last one ENDED with it cleared (picHidden).
    if (this.picBoxCleared(side)) return;
    const anim = this.animPicState(side);
    // Mid FLY / DIG the box is empty: DisappearUser ClearBoxes it
    // (engine/battle/misc.asm:1-13), AppearUserRaiseSub puts it back on the
    // stored attack (engine/battle/effect_commands.asm:2113-2117).
    if (!(trainerBack || enemyTrainer) && this.isUnderground(side, mon)
       && !(this.vanishAnim && this.vanishAnim === this.anim)) {
      return;
    }
    // GetSubstitutePic (engine/battle_anims/anim_commands.asm:905-960): the
    // doll sits in the mon's own pic box and takes its palette.
    let doll: any, dollQuad: any;
    if (!(trainerBack || enemyTrainer)) {
      const over = anim && anim.pic;
      let up: any;
      if (over != null) {
        up = over === "substitute";
      } else {
        up = mon && mon.volatile && (mon.volatile.substitute ?? 0) > 0;
      }
      if (up) [doll, dollQuad] = this.substituteDoll(back) ?? [];
    }
    let [w, h] = image.getDimensions();
    // Crystal only: the frame the animation is showing replaces the static
    // picture in the same box, at the same size.
    let animSheet: any, animQuad: any, animSize: any;
    if (!(back || trainerBack || enemyTrainer || doll)) {
      const frame = this.frontAnimFrame(mon);
      if (frame) [animSheet, animQuad, animSize] = frame;
      if (animSheet) { w = animSize; h = animSize; }
    }
    let px: number, py: number;
    let boxTiles: number;
    if (back) {
      // pokegold engine/battle/core.asm:8569: 6x6 box, bottom-aligned/centred
      const box = BattleState.PLAYER_PIC_TILES * 8;
      px = BattleState.PLAYER_PIC_TILE_X * 8 + Math.floor((box - w) / 2);
      py = BattleState.PLAYER_PIC_TILE_Y * 8 + (box - h);
      boxTiles = BattleState.PLAYER_PIC_TILES;
    } else {
      // PadFrontpic pads a short pic and never a long one
      // (engine/gfx/load_pics.asm:342-386), so an oversized mod pic pins to the
      // box's own corner at hlcoord 12, 0 rather than to a negative offset.
      const box = BattleState.ENEMY_PIC_TILES * 8;
      // NOT FAITHFUL (to the Lua; faithful to PadFrontpic): the Lua centres
      // with math.max(0, math.floor((box - w) / 2)), which gives a 6x6 pic a
      // 4px offset -- off the 8px grid, so on the Gold screen it would become
      // 36 objects the BG-scroll effects (Tackle etc.) cannot move.
      // PadFrontpic (pokegold engine/gfx/load_pics.asm:342-386) puts a 5x5 AND
      // a 6x6 pic at column 1 of the 7x7 box, a 7x7 at column 0.
      px = BattleState.ENEMY_PIC_TILE_X * 8 + (w < box ? 8 : 0);
      py = BattleState.ENEMY_PIC_TILE_Y * 8 + Math.max(0, box - h);
      boxTiles = BattleState.ENEMY_PIC_TILES;
    }
    // One tile per two frames to the right, SlideBattlePicOut's own step.
    if (enemyTrainer && truthy(this.trainerSlide)) {
      px = px + Math.floor(this.trainerSlide / TRAINER_SLIDE_FRAMES_PER_STEP) * 8;
    } else if (trainerBack && truthy(this.backpicSlide)) {
      px = px - Math.floor(this.backpicSlide / TRAINER_SLIDE_FRAMES_PER_STEP) * 8;
    } else if (enemyTrainer && truthy(this.winSlide)) {
      px = px + winSlideTiles(this.winSlide) * 8;
    }
    // The pic's own scale (battle_sprite_scales, then the species record, then
    // 1x) composed with whatever square BattleBGEffect_RunPicResizeScript has
    // the mon drawn at this frame.
    let scale = this.picScale(path, mon, back);
    if (anim) {
      if (!this.liftedPass) px = px + (anim.slide ?? 0);
      const resized = anim.size != null ? PIC_RESIZE_TILES[anim.size] : undefined;
      if (resized) scale = scale * (resized / boxTiles);
    }
    if (scale !== 1) {
      // Centred in the same box and standing on the same ground line at every
      // scale: the smaller resize squares, and a mod scale, both compensate the
      // same way.
      // NOT FAITHFUL: the Gold screen cannot scale tiles; the offset is kept,
      // but G.draw below ignores the scale and draws the pic at 1x from here.
      px = px + Math.floor(w * (1 - scale) / 2);
      py = py + Math.floor(h * (1 - scale));
    }
    if (doll) {
      px = (back ? 32 : 112) + ((anim && anim.slide) || 0);
      py = back ? 80 : 40;
    }
    G.setColor(1, 1, 1, 1);
    // No mon on this side at all in the catching tutorial, where the box holds
    // the DUDE's back-pic and nothing else for the whole battle.
    let colors: any = this.palettes && mon
      && Palettes.monColors(this.palettes, mon.species, mon.shiny);
    if (trainerBack) {
      // PAL_BATTLE_OB_PLAYER: the player's own colours, which are row 0 of
      // TrainerPalettes (Chris shares Cal's).
      // engine/gfx/color.asm:683-696
      const row = Gen2Save.isFemale(this.save) ? "FALKNER" : "PLAYER";
      colors = Palettes.trainerColors(this.palettes, row)
        || Palettes.trainerColors(this.palettes, "PLAYER") || colors;
    } else if (enemyTrainer) {
      // The opponent's class row out of the same TrainerPalettes table.
      colors = Palettes.trainerColors(this.palettes, this.enemyTrainerClass)
        || colors;
    }
    // ../pokecrystal/engine/gfx/cgb_layouts.asm:67
    if (this.introGrayscale()) colors = Palettes.BLACKOUT;
    if (anim && truthy(anim.shade)) {
      colors = BattleAnimView.shadeColors(colors, anim.shade);
    }
    // MonFaintedAnimation, mid-slide: the rows that have walked past the bottom
    // of the pic box are not on the tilemap any more, so the pic is CROPPED to
    // what is still inside the box rather than drawn over the HUD below it.
    const sunk = this.faintSink(side);
    // Lua: BattleState.lua:1065
    const body = (): void => {
      if (doll) {
        G.draw(doll, dollQuad, px, py);
        return;
      }
      if (sunk > 0) {
        const visible = h - Math.floor(sunk / scale);
        if (visible <= 0) return;
        // NOT FAITHFUL: the Gold screen cannot scale tiles (scale ignored).
        G.draw(image, this.cropQuad(image, visible), px, py + sunk, 0,
          scale, scale);
        return;
      }
      if (animQuad) {
        // NOT FAITHFUL: the Gold screen cannot scale tiles (scale ignored).
        G.draw(animSheet, animQuad, px, py, 0, scale, scale);
        return;
      }
      // NOT FAITHFUL: the Gold screen cannot scale tiles (scale ignored).
      G.draw(image, px, py, 0, scale, scale);
    };
    // A mod-supplied pic that says it is already coloured is drawn as it is:
    // pokemon.sprite's ctx.trueColor, the same flag Gen 1's Sprites.path hands
    // back to its own draw site.
    // Lua: BattleState.lua:1086
    const paint = (): void => {
      if (colors && !(trueColor && GbcPalette.mode === "gbc")
         && GbcPalette.available()) {
        GbcPalette.with(colors, body);
      } else {
        body();
      }
    };
    const lifted = anim && anim.lifted;
    if (!lifted) {
      paint();
      return;
    }
    // engine/battle_anims/bg_effects.asm:448-465: the ClearBoxed band is off the BG.
    // (Lua 1-based lifted[1], lifted[2]; here a 0-based pair.)
    const bandY = (back ? BattleState.PLAYER_PIC_TILE_Y
      : BattleState.ENEMY_PIC_TILE_Y) * 8 + lifted[0] * 8;
    const bandH = lifted[1] * 8;
    // Lua: BattleState.lua:1103
    const band = (y: number, bh: number, lift: boolean): void => {
      G.push("all");
      // The lifted band is the cart's OAM copy of those pic rows: objects, so
      // the BG-scroll effect underneath does not drag it along (G.objects).
      if (lift) G.objects = true;
      Chrome.clipTo(0, y, 160, bh);
      paint();
      G.pop();
    };
    if (this.liftedPass) {
      band(bandY, bandH, true);
    } else {
      if (bandY > 0) band(0, bandY, false);
      const below = 144 - bandY - bandH;
      if (below > 0) band(bandY + bandH, below, false);
    }
  }

  // MonsterSpriteGFX (gfx/sprites.asm:82): the facing-DOWN 16x16 frame for the
  // enemy's frontpic, facing-UP for the player's backpic.
  // Lua: BattleState.lua:1138 (BattleState.lua:1120 defines the identical
  // function first; the later definition is the one Lua keeps.)
  substituteDoll(back?: boolean): [any, any] | undefined {
    if (this.subDoll === undefined) {
      try {
        const image = Assets.image("assets/generated/sprites/monster.png");
        if (!image) throw new Error("no image");
        const [w, h] = image.getDimensions();
        this.subDoll = { image: image,
          down: G.newQuad(0, 0, 16, 16, w, h),
          up: G.newQuad(0, 16, 16, 16, w, h) };
      } catch {
        this.subDoll = false;
      }
    }
    if (!this.subDoll) return undefined;
    return [this.subDoll.image, back ? this.subDoll.up : this.subDoll.down];
  }

  // The top `visible` rows of a pic, for the faint slide.  One quad, re-aimed,
  // the way BattleAnimView keeps one blit quad rather than a new one per frame.
  // Lua: BattleState.lua:1156
  cropQuad(image: any, visible: number): any {
    const [w, h] = image.getDimensions();
    if (!this.picQuad) {
      this.picQuad = G.newQuad(0, 0, w, visible, w, h);
    } else {
      this.picQuad.setViewport(0, 0, w, visible);
    }
    return this.picQuad;
  }

  // How far this side's pic has sunk, in pixels.  MonFaintedAnimation moves one
  // 8px row per FAINT_SLIDE_FRAMES_PER_ROW frames.
  // Lua: BattleState.lua:1168
  faintSink(side: string): number {
    const slide = this.faintSlide;
    if (!(slide && slide.side === side)) return 0;
    return Math.floor(slide.frames / FAINT_SLIDE_FRAMES_PER_ROW) * 8;
  }

  // The whole slide, in frames: the pic box's own height in rows.
  // Lua: BattleState.lua:1175
  faintSlideFrames(side: string): number {
    const tiles = side === "player" ? BattleState.PLAYER_PIC_TILES
      : BattleState.ENEMY_PIC_TILES;
    return tiles * FAINT_SLIDE_FRAMES_PER_ROW;
  }

  // ../pokecrystal/engine/battle/anim_hp_bar.asm:1
  // Lua: BattleState.lua:1185
  stepHpAnim(): boolean {
    const anim = this.hpAnim;
    if (!anim || !this.shownHp) return false;
    const side = anim.side;
    if (!anim.bar) {
      // engine/battle/effect_commands.asm:3399-3414), and _AnimateHPBar picks its
      // short/long loop and its pixels off that alone (anim_hp_bar.asm:42-50,
      const mon = this.activeMon(side);
      const maxHp = (mon && (mon.maxHp || (mon.stats && mon.stats.hp))) || 0;
      anim.bar = HpBar.newAnim(this.shownHp[side] ?? 0, anim.to ?? 0, maxHp);
    }
    if ((anim.hold ?? 0) > 0) {
      anim.hold = anim.hold - 1;
      return true;
    }
    if (HpBar.animStep(anim.bar)) {
      this.shownHp[side] = anim.to ?? 0;
      this.hpAnim = undefined;
      return false;
    }
    this.shownHp[side] = anim.bar.hp;
    anim.hold = HP_BAR_FRAMES_PER_STEP - 1;
    return true;
  }

  // ../pokecrystal/engine/battle/anim_hp_bar.asm:196
  // Lua: BattleState.lua:1211
  hudHpPixels(mon: any, side: string): number {
    const anim = this.hpAnim;
    if (anim && anim.side === side && anim.bar) return anim.bar.px;
    return HpBar.pixels(this.hudHp(mon, side),
      mon && (mon.maxHp || (mon.stats && mon.stats.hp)));
  }

  // One tick of the exp bar crawl.  AnimateExpBar walks the bar one PIXEL at a
  // time out of 64 (.LoopBarAnimation, engine/battle/core.asm:7325-7362): the
  // gap starts at three frames a pixel and drops by one after every SECOND
  // pixel, floored at one, so the bar starts slow and finishes fast.  A level
  // crossing fills the segment to 64, plays SFX_HIT_END_OF_EXP_BAR, advances the
  // level the HUD prints and restarts the bar at 0 (:7259-7285), which is why
  // the number changes as the bar tops out and not a message earlier.
  //
  // Returns true while the crawl is running so the caller holds the queue the
  // way the cart's loop holds the game.
  // Lua: BattleState.lua:1252
  stepExpAnim(): boolean {
    const anim = this.expAnim;
    if (!anim) {
      this.expBurst = undefined;
      return false;
    }
    if (this.stepExpBurst(anim)) return true;
    const mon = anim.mon;
    const toLevel = (mon && mon.level) || this.shownLevel || 1;
    let target = BattleHud.EXP_LENGTH_PX;
    if ((this.shownLevel || 1) >= toLevel) {
      target = this.expPixels(mon, this.shownLevel, mon && mon.experience);
    }
    if (!anim.started) {
      // ../pokecrystal/engine/battle/core.asm:7569
      if (Sound.sfxBusy && Sound.sfxBusy()
          && (anim.busy ?? 0) < EXP_WAIT_SFX_CAP) {
        anim.busy = (anim.busy ?? 0) + 1;
        return true;
      }
      anim.busy = undefined;
      anim.started = true;
      anim.frames = 3;
      anim.wait = 0;
      anim.pixels = 0;
      anim.delay = EXP_SOUND_FRAMES;
      this.playSfx(SFX_EXP_BAR);
    }
    if (anim.delay > 0) {
      anim.delay = anim.delay - 1;
      // ../pokecrystal/engine/battle/core.asm:7584
      if (anim.delay === 0 && anim.restart) {
        anim.restart = undefined;
        this.shownExp = 0;
      }
      return true;
    }
    let shown = this.shownExp || 0;
    if (shown < target) {
      anim.wait = anim.wait + 1;
      if (anim.wait < anim.frames) return true;
      anim.wait = 0;
      shown = shown + 1;
      this.shownExp = shown;
      anim.pixels = anim.pixels + 1;
      if (anim.pixels % 2 === 0) anim.frames = Math.max(1, anim.frames - 1);
      if (shown < target) return true;
    }
    // TerminateExpBarSound at the tail of every segment (:7279 and :7301).
    Sound.stop(SFX_EXP_BAR);
    if ((this.shownLevel || 1) < toLevel) {
      this.shownLevel = (this.shownLevel || 1) + 1;
      this.playSfx(SFX_END_OF_EXP_BAR);
      this.expBurst = { frame: 0,
        line: this.expLevelLine(anim, this.shownLevel, toLevel) };
      return true;
    }
    this.expAnim = undefined;
    return true;
  }

  // ../pokecrystal/data/text/battle.asm:343
  // Lua: BattleState.lua:1314
  expLevelLine(anim: any, level: number, toLevel: number): string {
    if (anim.line && level === toLevel) return anim.line;
    return this.name(anim.mon) + " grew to level " + level + "!";
  }

  // ../pokecrystal/engine/battle/core.asm:7536-7541
  // Lua: BattleState.lua:1320
  stepExpBurst(anim: any): boolean {
    const burst = this.expBurst;
    if (!burst) {
      if (anim.lineWait) {
        anim.lineWait = undefined;
        anim.started = false;
        anim.restart = true;
      }
      return false;
    }
    burst.frame = burst.frame + 1;
    if (burst.frame <= EXP_BURST_FRAMES) return true;
    if (burst.left == null) {
      burst.left = (Sound.waitFramesFor && Sound.waitFramesFor(SFX_END_OF_EXP_BAR))
        || 0;
    }
    burst.left = burst.left - 1;
    if (burst.left > 0 && Sound.isPlaying(SFX_END_OF_EXP_BAR)) return true;
    this.expBurst = undefined;
    // ../pokecrystal/engine/battle/core.asm:7540
    this.message = burst.line;
    this.messageTimer = 0;
    const sfx = anim.lineSfx || SFX_GREW_TO_LEVEL;
    this.playSfx(sfx);
    this.waitSfx = sfx;
    anim.lineWait = true;
    return true;
  }

  // (../pokecrystal/engine/sprite_anims/core.asm:558-608).
  // Lua: BattleState.lua:1350
  drawExpBurst(): void {
    const burst = this.expBurst;
    if (!burst || burst.frame < 1 || burst.frame > EXP_BURST_FRAMES) {
      return;
    }
    const radius = (burst.frame - 1) * 2;
    const set = this.palettes && this.palettes.battleObjects;
    const colors = (set && set.PAL_BATTLE_OB_BLUE) || undefined;
    // The burst is SPRITE_ANIM_OBJ_EXP_BURST... sprites: OAM on the cart, so
    // objects here even where a position lands on the 8px grid.
    G.push();
    G.objects = true;
    for (let c = EXP_BURST_SPRITES - 1; c >= 0; c--) {
      const angle = c * 8;
      const y = EXP_BURST_Y + signedByte(SpriteAnims.sine(angle, radius));
      const x = EXP_BURST_X + signedByte(SpriteAnims.cosine(angle, radius));
      this.hud.drawExpBarEnd(x, y, colors);
    }
    G.pop();
  }

  // The HP a side's HUD prints and fills its bar from: the chased value, not
  // the engine's, which ran a whole turn ahead.
  // Lua: BattleState.lua:1368
  hudHp(mon: any, side: string): number {
    const shown = this.shownHp && this.shownHp[side];
    if (shown == null) return (mon && mon.hp) || 0;
    return shown;
  }

  // The bar is battle/HpBar.ts's: the pixel count comes from
  // ComputeHPBarPixels and the colour from GetHPPal, so this screen and the party
  // list can never disagree about when a mon is in the red.
  // Lua: BattleState.lua:1377
  drawHpBar(mon: any, side: string, tx: number, ty: number): number {
    const maxHp = mon.maxHp || (mon.stats && mon.stats.hp);
    const hp = this.hudHp(mon, side);
    const pixels = this.hudHpPixels(mon, side);
    if (this.hud.available()) {
      return this.hud.drawHpBar(hp, maxHp, tx, ty, undefined, pixels);
    }
    return HpBar.drawWithLabel(gPainter, this.palettes, hp, maxHp, tx, ty, Font, pixels);
  }

  // CheckCaughtMon against wPokedexCaught (home/pokedex_flags.asm:48-51).
  // Lua: BattleState.lua:1388
  dexCaught(mon: any): boolean {
    const caught = this.save && this.save.pokedex && this.save.pokedex.caught;
    return truthy(mon && caught && caught[mon.species]) ? true : false;
  }

  // The status the HUD prints, one drain behind the engine the way shownHp is:
  // UpdateBattleHuds runs after the animation and its line (home/battle.asm:150).
  // Lua: BattleState.lua:1395
  hudStatus(mon: any, side?: string): any {
    const shown = side ? (this.shownStatus && this.shownStatus[side]) : undefined;
    if (shown == null) return (mon && mon.status) || undefined;
    return shown || undefined;
  }

  // home/battle.asm:150, for the clears no queued event carries (a mon waking,
  // a thaw, a bag cure): the tags catch up once the queue is idle.
  // Lua: BattleState.lua:1403
  syncShownStatus(): void {
    const shown = this.shownStatus, battle = this.battle;
    if (!(shown && battle)) return;
    for (const side of ["player", "enemy"]) {
      const mon = battle[side];
      shown[side] = (mon && mon.status) || false;
    }
  }

  // The low-HP alarm is not an SFX id at all.  PlayDanger (audio/engine.asm:531)
  // runs every frame while DANGER_ON_F is set in wLowHealthAlarm and writes a
  // two-tone square straight to channel 1 -- DangerSoundHigh ($750) at counter 0,
  // DangerSoundLow ($6ee) at counter 16 -- while audio/engine.asm:244 keeps music
  // channel 1 quiet for as long as the flag is up.  CheckDanger
  // (engine/battle/core.asm:4393) sets and clears the flag off wPlayerHPPal ==
  // HP_RED, and StopDangerSound (core.asm:2189) zeroes it on a faint and at the
  // end of the battle.  src/core/ChipAudio.lua synthesizes that exact pair, which
  // is what Sound.startLoop("Low_Health_Alarm") reaches.
  //
  // Keyed to the DISPLAYED bar, because wPlayerHPPal is what the bar animation
  // updates: the siren starts when the bar drains into the red, not a turn early.
  // Lua: BattleState.lua:1424
  lowHealthAlarmActive(): boolean {
    // wBattleLowHealthAlarm is the per-battle DISABLE latch, and CheckDanger
    // reads it before anything else (`ld a, [wBattleLowHealthAlarm] / and a /
    // jr nz, .done`, engine/battle/core.asm:4396-4399): once it is set the
    // DANGER_ON_F bit StopDangerSound just cleared is left alone, so the siren
    // cannot come back for the rest of the battle however red the bar stays.
    if (this.lowHealthAlarmDisabled) return false;
    // The healing item's exception, set by applyPartyItem: wLowHealthAlarm is
    // zeroed before the HP moves, and CheckDanger is not asked again until
    // UpdatePlayerHUD runs at the end of the bar climb, so nothing re-arms the
    // siren while the bar is walking back out of the red.
    if (this.healSilence) {
      if (this.hpAnim && this.hpAnim.side === "player") return false;
      this.healSilence = undefined;
    }
    const player = this.battle && this.battle.player;
    return (player && (player.hp ?? 0) > 0
      && HpBar.palette(this.hudHpPixels(player, "player")) === "red") ? true
      : false;
  }

  // Lua: BattleState.lua:1445
  updateAlarm(): void {
    const data = this.game && this.game.data;
    // Mirrors wLowHealthAlarm's DANGER_ON_F bit, under the same field name Gen 1
    // keeps it in (src/battle/BattleState.lua).
    this.lowHealthAlarmOn = this.lowHealthAlarmActive() && data != null;
    // battle.low_health_alarm: on/off toggle for the siren loop, ctx.on mirrors
    // self.lowHealthAlarmOn -- the same name and the same ctx keys as the Gen 1
    // site, so one subscription covers both games and a mod can reshape the
    // toggle (mute it after a budget, swap the loop) before vanilla acts on it.
    // `data` is added because this screen's cache lives on the game rather than
    // on the battle the way Gen 1's does; `battle` is still the battle screen.
    if (Runtime.wantsHook("battle.low_health_alarm")) {
      return Runtime.call("battle.low_health_alarm", (ctx: any) => {
        if (ctx.on && ctx.data) {
          Sound.startLoop(ctx.data, "Low_Health_Alarm");
        } else {
          Sound.stopLoop("Low_Health_Alarm");
        }
      }, { on: this.lowHealthAlarmOn, battle: this, data: data });
    }
    if (this.lowHealthAlarmOn) {
      // Sound.startLoop returns early when the loop is already sounding, so this
      // can run every step the way PlayDanger runs every frame.
      Sound.startLoop(data, "Low_Health_Alarm");
    } else {
      this.stopAlarm();
    }
  }

  // StopDangerSound (engine/battle/core.asm:2189): the siren cannot outlive the
  // mon that raised it, nor the battle screen.
  // Lua: BattleState.lua:1476
  stopAlarm(): void {
    Sound.stopLoop("Low_Health_Alarm");
  }

  //------------------------------------------------------------------------
  // Battle animations
  //------------------------------------------------------------------------

  // hBattleTurn: 0 while the player is attacking.  Every object function and
  // every BG effect keys the side it acts on off this.
  // Lua: BattleState.lua:1486
  turnFor(side: string): number {
    return side === "enemy" ? 1 : 0;
  }

  // Starts an animation script and returns true when there is one to play.
  // `key` is a pool key from battle_anims.lua's `moves` or `ids` map.
  // Lua: BattleState.lua:1492
  startAnim(key: any, opts?: any): boolean {
    if (!(this.anims && this.anims.scripts && key)) return false;
    if (!this.anims.scripts[key]) return false;
    // BattleAnimRunScript's own gate: `bit BATTLE_SCENE, [wOptions]` skips the
    // move animation entirely, which is the OPTION screen's BATTLE SCENE row.
    // The check only applies to a real move id (wFXAnimID+1 == 0); non-move
    // ids (isMove unset here) branch straight to .not_move and always run.
    const options = this.game && this.game.options;
    if (options && options.battleScene === false && opts && opts.isMove) {
      return false;
    }
    opts = opts || {};
    const data = (this.game && this.game.data) || {};
    const audio = data.audio || {};
    this.anim = AnimRunner.new({
      data: this.anims,
      constants: this.animConstants,
      battleTurn: opts.turn || 0,
      animId: opts.animId,
      param: opts.param || 0,
      sfxOrder: audio.sfxOrder,
      ballPalette: opts.ballPalette,
      // BGEffect_CheckFlyDigStatus reads wPlayerSubStatus3 / wEnemySubStatus3
      // (engine/battle_anims/bg_effects.asm:2838-2851); the port keeps that bit
      // on the mon's volatile table, not on the mon itself.
      flying: {
        player: this.isUnderground("player"),
        enemy: this.isUnderground("enemy"),
      },
      hooks: {
        // anim_sound (engine/battle_anims/anim_commands.asm:1105) calls
        // PlayStereoSFX (audio/engine.asm:2571), the ONE sfx path with no
        // CheckSFX/wCurSFX comparison: an animation's second sound is never
        // dropped for being outranked by its first.  BattleAnim_ThrowPokeBall's
        // SFX_THROW_BALL then SFX_BALL_POOF is the case that goes silent if this
        // goes through the gated Sound.play.
        sound: (name: any) => {
          if (name && audio.sfx && audio.sfx[name]) {
            Sound.playStereo(data, name);
          }
        },
        // The cry is the battler's own, at the pitch/length the command adds;
        // the port's Sound layer has no pitch shift, so the plain cry is what
        // plays.  audio.cries is keyed by SPECIES (the same table every other
        // Gen 2 screen plays through Sound.playCry), which is what makes
        // anim_cry moves like GROWL audible at all.
        cry: (side: any) => {
          const mon = side === "enemy" ? this.battle.enemy : this.battle.player;
          const species = mon && mon.species;
          if (species && audio.cries && audio.cries[species]) {
            Sound.playCry(data, species);
          }
        },
        // GetPokeBallWobble, which BattleAnim_ThrowPokeBall's .Loop calls through
        // anim_checkpokeball once per wobble.
        pokeballWobble: () => this.pokeballWobble(),
      } as any,
    });
    this.anim.start(key);
    // BattleAnimRunScript calls BattleAnimClearHud before a MOVE's script and
    // BattleAnimRestoreHuds after; the `.not_move` path (the shared ANIM_* ids)
    // skips both.  ClearActorHud blanks the ATTACKER's own HUD, which is what
    // keeps a Tackle from dragging the name and HP bar along with the pic.
    this.anim.clearsHud = opts.isMove ? true : false;
    this.anim.hudSide = (opts.turn || 0) === 0 ? "player" : "enemy";
    return true;
  }

  // engine/battle/effect_commands.asm:1947-1961
  // Lua: BattleState.lua:1561
  afterAnimFor(side: string, kind: any): string | undefined {
    if (kind === "statdown") {
      if (side === "player") return "ANIM_ENEMY_STAT_DOWN";
      return "ANIM_WOBBLE";
    }
    if (kind !== "damage") return undefined;
    if (side === "player") return "ANIM_ENEMY_DAMAGE";
    return "ANIM_PLAYER_DAMAGE";
  }

  // engine/battle_anims/anim_commands.asm:1200 PlayHitSound
  // Lua: BattleState.lua:1572
  playHitSound(effectiveness: any): void {
    if (!truthy(effectiveness) || effectiveness === 0) return;
    if (effectiveness > 10) this.playSfx("Sfx_SuperEffective");
    else if (effectiveness < 10) this.playSfx("Sfx_NotVeryEffective");
    else this.playSfx("Sfx_Damage");
  }

  // Lua: BattleState.lua:1579
  animForMove(moveId: any, side: string, param?: any, effectiveness?: any, afterAnim?: any): boolean {
    const key = this.anims && this.anims.moves && this.anims.moves[moveId];
    const started = this.startAnim(key, {
      turn: this.turnFor(side), animId: moveId, isMove: true, param: param,
    });
    // engine/battle_anims/anim_commands.asm:55-72
    const name = this.afterAnimFor(side, afterAnim);
    if (started && name) {
      this.pendingAfterAnim = { name: name, side: side,
        effectiveness: (afterAnim === "damage") ? effectiveness : undefined };
    }
    return started;
  }

  // Kick off a queued after-anim; returns true when one is now running.
  // Lua: BattleState.lua:1594
  startPendingAfterAnim(): boolean {
    const pending = this.pendingAfterAnim;
    if (!pending) return false;
    this.pendingAfterAnim = undefined;
    if (this.animForId(pending.name, pending.side)) {
      this.playHitSound(pending.effectiveness);
      // dealDamage's default ANIM_x_DAMAGE is this same shake; skip it there.
      this.afterAnimPlayed = true;
      return true;
    }
    return false;
  }

  // True while BattleAnimClearHud has that side's HUD blanked.
  // Lua: BattleState.lua:1608
  hudCleared(side: string): boolean {
    return this.anim != null && truthy(this.anim.clearsHud) && this.anim.hudSide === side;
  }

  // `param` is wBattleAnimParam, which BattleAnim_SendOutMon branches on
  // (data/moves/animations.asm:414-417).
  // Lua: BattleState.lua:1614
  animForId(idName: string, side: string, param?: any): boolean {
    const key = this.anims && this.anims.ids && this.anims.ids[idName];
    return this.startAnim(key, {
      turn: this.turnFor(side), animId: idName, param: param,
    });
  }

  // data/moves/animations.asm:379
  // Lua: BattleState.lua:1622
  latchCaughtPic(): void {
    const anim = this.anim;
    if (anim && anim.animId === "ANIM_THROW_POKE_BALL"
        && this.ballThrow && this.ballThrow.caught) {
      this.picHidden.enemy = true;
    }
  }

  // One logic frame of a running animation.  B cuts it short, the way holding B
  // pages a text box.
  // Lua: BattleState.lua:1632
  stepAnim(input: any): void {
    if (!this.anim) return;
    if (input && (input.wasPressed("b") || input.wasPressed("start"))) {
      // Cut short: only the explicit latches (a caught mon) survive a skip.
      this.latchCaughtPic();
      const ended = this.anim;
      this.anim = undefined;
      this.clearVanishReveal(undefined, ended);
      // Cart still reaches the after-anim arm after a move script ends; a skip
      // of the move should not drop the hit shake that follows it.
      if (this.startPendingAfterAnim()) return;
      return this.endSendOutAnim(true);
    }
    if (!this.anim.step()) {
      this.latchCaughtPic();
      const ended = this.anim;
      // pokegold data/moves/animations.asm .Click: anim_keepsprites means
      // the OAM outlives the script, so keep the runner for drawing too.
      if (!this.anim.keepSprites) this.anim = undefined;
      this.clearVanishReveal(undefined, ended);
      if (this.startPendingAfterAnim()) return;
      return this.endSendOutAnim();
    }
    this.revealSentOut();
    this.revealVanished();
  }

  // engine/battle/misc.asm:1-13
  // Lua: BattleState.lua:1662
  latchVanished(events: any[] | undefined): void {
    for (const event of events || []) {
      if (event.wasVanished && event.side) {
        this.picHidden[event.side] = true;
        this.vanishReveal[event.side] = { side: event.side };
      }
    }
    for (const side of VANISH_SIDES) {
      if (this.vanishSeen
          && !BattleState.isVanished(this.battle && this.battle[side])) {
        this.vanishSeen[side] = false;
      }
    }
  }

  // Lua: BattleState.lua:1677
  armVanishReveal(side: string): boolean {
    const latch = this.vanishReveal && this.vanishReveal[side];
    if (!latch) return false;
    latch.anim = this.anim;
    return true;
  }

  // Lua: BattleState.lua:1684
  clearVanishReveal(side?: string, ended?: any): void {
    const latches = this.vanishReveal;
    if (!latches) return;
    for (const key of VANISH_SIDES) {
      const latch = latches[key];
      if (latch && (side == null || side === key)
          && (ended == null || latch.anim === ended)) {
        latches[key] = undefined;
        this.picHidden[key] = false;
      }
    }
  }

  // engine/battle_anims/bg_effects.asm:377
  // Lua: BattleState.lua:1698
  revealVanished(): void {
    const anim = this.anim, latches = this.vanishReveal;
    if (!(anim && latches)) return;
    for (const side of VANISH_SIDES) {
      const latch = latches[side];
      if (latch && latch.anim === anim && this.picHidden[side]
          && anim.bg.picSize[side] != null) {
        this.picHidden[side] = false;
        latches[side] = undefined;
      }
    }
  }

  // ../pokecrystal/engine/battle_anims/bg_effects.asm:709-720
  // Lua: BattleState.lua:1712
  revealSentOut(): void {
    const after = this.afterSendOut;
    if (!(after && this.anim && this.picHidden[after.side])) return;
    if (this.anim.bg.picSize[after.side] != null) {
      this.picHidden[after.side] = false;
    }
  }

  // Lua: BattleState.lua:1720
  picBoxCleared(side: string): boolean {
    const anim = this.animPicState(side);
    return truthy((anim && anim.hidden) || this.picHidden[side]) ? true : false;
  }

  // REMOVE_MON / RETURN_MON also serve SUBSTITUTE, SKY_ATTACK, BEAT_UP and

  // Whatever Call_PlayBattleAnim was standing in front of: a send-out's cry and
  // HUD update run the moment its animation is done, cut short or not.
  // Lua: BattleState.lua:1729
  endSendOutAnim(skipped?: boolean): void {
    const after = this.afterSendOut;
    if (!after) return;
    this.afterSendOut = undefined;
    this.picHidden[after.side] = false;
    if (after.shiny && !skipped) {
      after.shiny = undefined;
      if (this.animForId("ANIM_SEND_OUT_MON", after.side, 1)) {
        this.afterSendOut = after;
        return;
      }
    }
    this.finishSendOut(after);
  }

  // What the BG effects are doing to a battler's pic this frame.
  // Lua: BattleState.lua:1745
  animPicState(side: string): any {
    if (!this.anim) return undefined;
    const bg = this.anim.bg;
    return {
      hidden: bg.hidden[side],
      lifted: (bg.liftedRows && bg.liftedRows[side]) || undefined,
      size: bg.picSize[side],
      slide: bg.slide[side] ?? 0,
      shade: bg.monShade[side],
      pic: this.anim.picOverride[side],
    };
  }

  // Lua: BattleState.lua:1758
  advanceQueue(): any {
    const event = this.queue.shift();
    this.messagePages = undefined; this.messageCarry = undefined;
    const pendingSend = this.pendingSendOut;
    if (pendingSend) {
      this.pendingSendOut = undefined;
      this.startSendOut(pendingSend.side, pendingSend.mon);
    }
    // StartBattle runs `call z, UpdateEnemyHUD` AFTER BattleStartMessage returns,
    // and only for a wild battle (engine/battle/core.asm:7808-7817): the appeared
    // line is read against an empty HUD area and the bar comes up on the step
    // after it.  A trainer's HUD is turned on by the send-out arm below instead.
    if (this.introTextShown) {
      this.showEnemyHud = true;
      this.introTextShown = undefined;
    }
    if (!event) {
      this.syncShownStatus();
      // `jp PlayerSwitch`, which follows the enemy's own send-out and spends no
      // turn (engine/battle/core.asm:2955-2963).
      if (truthy(this.shiftSwitchIndex)) {
        const index = this.shiftSwitchIndex;
        this.shiftSwitchIndex = undefined;
        if (this.battle.shiftSwitch(index)) {
          this.pushAll(this.battle.takeEvents());
          return this.advanceQueue();
        }
      }
      // Nothing left: either the battle ended or it is the player's turn.
      if (this.battle && this.battle.over) {
        // ExitBattle runs the evolution sweep BEFORE it cleans up the battle
        // RAM, so the screens come up while the battle is still notionally on.
        return this.startEvolutions();
      }
      this.phase = "menu";
      if (this.tutorial) {
        // BattleMenu's tutorial arm skips UpdateBattleHuds AND EmptyBattleTextbox,
        // so the box keeps whatever it already said while the menu opens over it,
        // and there is no mon to name in a prompt anyway.  The DOWN + A that
        // picks PACK is armed here, where the cart arms it: right before
        // LoadBattleMenu.
        this.dudeInput(CatchTutorial.MENU_STREAM, undefined, true);
        return;
      }
      // `call CheckPlayerLockedIn / jr c, .skip_iteration` (engine/battle/core.asm
      // :162-176) jumps past `call BattleMenu` ENTIRELY, not just past the move
      // list: a mon partway through a Rollout or a Thrash is offered no menu at
      // all, and ParsePlayerAction's .locked_in arm runs the move it is stuck on.
      // The engine side already forces the move (Battle:forcedMove overrides
      // whatever is submitted, and Battle:usableMoves narrows to the one), so all
      // that is left here is not to draw a menu the cart never draws.  Deferred
      // to update() rather than submitted from inside advanceQueue, so a turn
      // that somehow emitted no events cannot recurse.
      if (!this.tutorial && this.battle && this.battle.player
          && truthy(this.battle.lockedInMove(this.battle.player))) {
        // The message is deliberately NOT cleared: EmptyBattleTextbox lives
        // inside BattleMenu, which this turn never calls, so the box keeps
        // whatever the last line was.
        this.phase = "locked-in";
        return;
      }
      // BattleMenu (engine/battle/core.asm) runs EmptyBattleTextbox before
      // LoadBattleMenu: the half of the box beside the 2x2 menu is BLANK on the
      // cart.  Gen 2 has no "What will X do?" line, and printing one here only
      // got it clipped mid-word by the menu box drawn over its right half.
      this.message = undefined;
      return;
    }
    // HandleEnemyMonFaint / HandlePlayerMonFaint run their side's
    // MonFaintedAnimation BEFORE the faint text (engine/battle/core.asm): the pic
    // sinks out of the field and only then does "X fainted!" go up.  The slide
    // owns the screen the way SlideBattlePicOut does, so the event is put back at
    // the head of the queue and re-runs for its text (and for the alarm latch and
    // the victory jingle below it) once the pic is gone.
    if (event.kind === "faint" && event.side && !event.slid
        && !this.faintSlide) {
      event.slid = true;
      this.queue.unshift(event);
      this.faintSlide = { side: event.side, frames: 0 };
      // ../pokecrystal/engine/battle/core.asm:2256, :2269
      if (Sound.sfxBusy && Sound.sfxBusy()) {
        this.faintSlide.wait = 0;
      } else {
        this.faintSound(event.side);
      }
      return;
    }
    // Battle:awardExperience emits one `level` event per mon that grew, which is
    // exactly where the cart sets that slot's wEvolvableFlags bit.
    // (event.index is the 1-based party slot; battle.party a 0-based array.)
    if (event.kind === "level" && truthy(event.index)) {
      const battle = this.battle;
      const mon = battle && battle.party && battle.party[event.index - 1];
      // ../pokecrystal/engine/battle/core.asm:7294-7296
      if (mon && battle && mon !== battle.player && !event.hitPlayed) {
        event.hitPlayed = true;
        this.queue.unshift(event);
        this.playSfx(SFX_END_OF_EXP_BAR);
        this.waitSfx = SFX_END_OF_EXP_BAR;
        return;
      }
      this.evolvable[event.index] = true;
      // GiveExperiencePoints' `.skip_active_mon_update` guard
      // (engine/battle/core.asm:6999-7003): the OUT mon's shown HP snaps.
      // pokegold engine/battle/core.asm:7057-7069: every mon that leveled
      // gets the stats box, not just the mon currently on the field.
      this.pendingStatsMon = mon;
      // engine/battle/core.asm:7284
      if (mon && mon === battle.player) {
        if (this.shownHp) {
          this.shownHp.player = mon.hp ?? 0;
          if (this.hpAnim && this.hpAnim.side === "player") {
            this.hpAnim = undefined;
          }
        }
        // `ld [wBattleMonLevel], a` in the same guarded block (:7018-7020).
        this.shownLevel = mon.level || this.shownLevel;
      }
    }
    // EnemySwitch's shift arm asks BEFORE ClearEnemyMonBox and
    // ShowBattleTextEnemySentOut (engine/battle/core.asm:2941-2955), so the send
    // goes back at the head of the queue and re-runs once the prompt is answered.
    if (event.kind === "send" && event.side === "enemy" && event.replacement
        && !event.offered && this.shiftOfferAllowed()) {
      event.offered = true;
      this.queue.unshift(event);
      return this.offerShiftSwitch(event.mon);
    }
    // A damage or heal event re-arms the HP bar chase (AnimateHPBar runs from
    // UpdateBattleHuds between one battle message and the next), and a send
    // snaps that side's bar straight to the incoming mon.
    if ((event.kind === "damage" || event.kind === "heal")
        && event.side && event.hp != null && this.shownHp
        && this.shownHp[event.side] !== event.hp) {
      this.hpAnim = { side: event.side, to: event.hp };
    } else if (event.kind === "send" && event.side && event.mon && this.shownHp) {
      this.shownHp[event.side] = event.hp ?? event.mon.hp ?? 0;
      if (this.hpAnim && this.hpAnim.side === event.side) this.hpAnim = undefined;
    }
    // And the same lag for the status tag (home/battle.asm:150); a send snaps it
    // to the incoming mon.
    if (this.shownStatus && event.side
        && (event.kind === "status"
          || (event.kind === "send" && event.mon))) {
      let shown = event.status;
      if (event.kind === "send" && shown == null) shown = event.mon.status;
      this.shownStatus[event.side] = shown || false;
    }
    // AnimateExpBar (engine/battle/core.asm:7191) is called from INSIDE
    // GiveExperiencePoints before the exp is committed (the call at :6888 sits
    // ahead of the commit at :6889-6901), so the bar crawls from the figures
    // the HUD is already showing up to the new ones, filling to 64 and
    // restarting at 0 for every level crossed (:7259-7285).  The engine has
    // written mon.experience and mon.level a whole turn earlier here, so the
    // crawl's starting point is the chased state (shownExp / shownLevel) rather
    // than the mon: same reason the HP bar has shownHp.
    if (event.kind === "experience" && truthy(event.index)) {
      const battle = this.battle;
      const mon = battle && battle.party && battle.party[event.index - 1];
      // AnimateExpBar's own two guards: only the mon that is OUT animates (the
      // wCurBattleMon == wCurPartyMon test at :7194-7197), and nothing animates
      // at MAX_LEVEL (:7199-7201).
      if (mon && mon === battle.player
          && (this.shownLevel || 1) < Mon.MAX_LEVEL) {
        const anim: any = { mon: mon, frames: 3, wait: 0, pixels: 0 };
        // ../pokecrystal/engine/battle/core.asm:7540
        for (const ahead of this.queue) {
          if (ahead.kind === "level" && ahead.index === event.index) {
            if ((this.shownLevel || 1) < (ahead.level || mon.level || 1)) {
              ahead.lineShown = true;
              anim.line = ahead.text; anim.lineSfx = ahead.sfx;
            }
            break;
          }
        }
        this.expAnim = anim;
      }
    }
    // ../pokecrystal/engine/battle/move_effects/transform.asm:118-136
    if (event.kind === "transform" && event.side && event.mon
        && this.shownMon
        && !(this.identityPin && this.identityPin[event.side])) {
      this.shownMon[event.side] = event.mon;
    }
    if (event.kind === "send" && event.side && event.mon) {
      // The pic and the HUD name follow the queue, so the mon that just fainted
      // is still on screen for its own line and the replacement arrives here.
      if (this.shownMon) this.shownMon[event.side] = event.mon;
      // The second of the cart's two wFirstUnownSeen writes (core.asm:3251).
      if (event.side === "enemy") {
        this.noteFirstUnown(event.mon);
        this.markSeen(event.mon);
        // engine/battle/trainer_huds.asm:142-151
        this.caughtMark = this.dexCaught(event.mon);
      }
      if (event.side === "player") {
        // SendOutPlayerMon zeroes wBattleMenuCursorPosition and wCurMoveNum back
        // to back (engine/battle/core.asm:3809), so a switched-in mon opens on
        // FIGHT and on its first move.  Player side only: the zeroing lives
        // inside SendOutPlayerMon and nothing on the enemy's path touches them.
        this.menuIndex = 1;
        this.moveIndex = 1;
        // SendOutPlayerMon reloads wBattleMon* from the party slot (:3838):
        // snap from the emit-time snapshot, not the live table (#1514).
        const level = event.level || event.mon.level || 1;
        this.shownLevel = level;
        this.shownExp = this.expPixels(event.mon, level,
          event.experience ?? event.mon.experience);
        this.expAnim = undefined;
        this.expBurst = undefined;
      }
    }
    // ResetEnemyBattleVars' SlideBattlePicOut (engine/battle/core.asm:3027):
    // eight one-tile steps push the trainer's pic off the right edge, and the
    // queue holds until they are done.
    if (event.kind === "trainer-slide") {
      this.trainerSlide = 0;
      return;
    }
    // ../pokecrystal/engine/battle/core.asm:82-84
    if (event.kind === "backpic-slide") {
      this.backpicSlide = 0;
      return;
    }
    // BattleWinSlideInEnemyTrainerFrontpic and the DelayFrames 40 behind it
    // (engine/battle/core.asm:2310-2312)
    if (event.kind === "trainer-return") {
      // LostBattle's ClearBox wipes the live foe pic and HUD before the slide
      // (engine/battle/core.asm:2770-2773)
      if (event.cleared) {
        this.showEnemyHud = false;
        this.ballRows.enemy = false;
      }
      if (!this.enemyTrainerImage) return this.advanceQueue();
      this.showEnemyTrainer = true;
      this.picHidden.enemy = false;
      this.winSlide = 0;
      this.winSliding = true;
      return;
    }
    // PrintWinLossText (home/trainers.asm:230): one FarPrintText of the trainer
    // struct's own line, paged and held for A/B like any other map text.
    if (event.kind === "win-text") {
      let text = event.text;
      if (this.game) text = TextBox.substitute(this.game, text);
      this.showPages(text);
      return;
    }
    // data/text/battle.asm:184
    if (event.kind === "money") {
      this.showPages(event.text ?? "");
      return;
    }
    // The shiny sparkle: hBattleTurn 1 and wBattleAnimParam 1 pick
    // BattleAnim_SendOutMon's `.Shiny` arm on the enemy (core.asm:8708-8715).
    if (event.kind === "shiny-flash") {
      this.animForId("ANIM_SEND_OUT_MON", "enemy", 1);
      return;
    }
    // SendOutPlayerMon: the trainer's back-pic gives way to the mon and
    // ANIM_SEND_OUT_MON plays over the "Go!" line.
    if (event.kind === "sendout") {
      this.showPlayerTrainer = false;
      this.menuIndex = 1;
      this.moveIndex = 1;
      this.message = event.text;
      // ../pokecrystal/data/text/common_2.asm:137-140
      // ../pokecrystal/engine/battle/core.asm:92-93
      this.messageTimer = 0;
      this.startSendOut("player", this.battle && this.battle.player);
      return;
    }
    // DisplayCaughtContestMonStats, which BugContest_SetCaughtContestMon opens
    // over the battle once a second mon is caught: the stock-versus-this
    // comparison and its yes/no, both of which live in the contest screen.
    if (event.kind === "contest-switch") {
      return this.openContestSwitch(event);
    }
    // The failure line is picked from wThrownBallWobbleCount, which only reaches
    // its final value inside the animation (item_effects.asm:414-428).
    if (event.kind === "ball-result") {
      this.message = this.ballFailureText();
      this.messageTimer = MESSAGE_FRAMES;
      return;
    }
    // `predef NewPokedexEntry` (item_effects.asm:542).
    if (event.kind === "dex-entry") {
      return this.openDexEntry(event.species);
    }
    if (event.kind === "ask-nickname") {
      return this.askNickname(event.mon);
    }
    if (event.kind === "choose-switch") {
      // engine/battle/core.asm:2590
      if (this.battle && this.battle.wild) {
        this.nextMonIndex = 1;
        this.phase = "ask-next-mon";
        this.message = Strings.get(TEXT_USE_NEXT_MON);
        this.messageTimer = 0;
        return;
      }
      // A fainted lead: force a switch before anything else runs.
      this.phase = "forced-switch";
      this.message = Strings.get("Choose a POKéMON.");
      return;
    }
    // LearnMove's full-moveset arm: the exp queue stops on ForgetMove's own text
    // and the player drops a move or declines (engine/pokemon/learn.asm:29-33).
    if (event.kind === "choose-forget") {
      this.pendingLearn = { index: event.index, move: event.move,
        moveName: event.moveName };
      return this.askForget();
    }
    // PlayVictoryMusic sits in the faint handler, not at the end of the battle:
    // the jingle is already going while "X fainted!" is on screen and it loops
    // through the exp and money lines until the overworld comes back.
    if (event.kind === "faint" && event.side === "enemy") {
      // UpdateBattleStateAndExperienceAfterEnemyFaint (core.asm:2044) reaches
      // `.wild2` on EVERY wild enemy faint and there calls StopDangerSound and
      // writes 1 to wBattleLowHealthAlarm (:2071-2074), before a single point of
      // experience is awarded; WinTrainerBattle does the same pair when a
      // trainer's last mon drops (:2293-2296).  Until this latch existed the
      // siren kept blaring under the victory jingle, the exp bar and the
      // level-up prompts for as long as the player's own bar stayed red.
      if (this.battle.wild
          || (this.battle.over && this.battle.outcome === "win")) {
        this.stopAlarm();
        this.lowHealthAlarmDisabled = true;
      }
      if (this.battle.over && this.battle.outcome === "win") {
        this.playVictoryMusic();
      }
    }
    if (truthy(event.text) && !event.lineShown) {
      this.showPages(event.text);
      this.typedText = undefined;
      // engine/battle/core.asm:8733
      if (this.startHuds) {
        this.ballRows.player = this.startHuds.player;
        this.ballRows.enemy = this.startHuds.enemy;
        this.startHuds = undefined;
      }
      // move/level lines do not hold for A/B (battle.asm:336-343); experience
      // keeps the wait (common_1.asm:1660-1665).
      if (event.kind === "move" || event.kind === "level") {
        this.messageTimer = 0;
        // engine/battle/effect_commands.asm:1958-1961
        // engine/battle/move_effects/magnitude.asm:20
        if (event.kind === "move" && (event.missed || event.animDelay)) {
          this.messageDelay = MOVE_DELAY_FRAMES;
        }
      } else if (event.textPause) {
        // ../pokecrystal/home/text.asm:887-896
        this.messageTimer = 0;
        this.messageDelay = TEXT_PAUSE_FRAMES;
      } else {
        this.messageTimer = MESSAGE_FRAMES;
      }
      // BattleStartMessage's own line: the enemy HUD comes up on the step after
      // it returns (engine/battle/core.asm:7808-7817), not with it.
      if (event.intro) this.introTextShown = true;
      // BattleStartMessage's `.not_shiny` cries the wild mon before its own line
      // (engine/battle/core.asm:8718-8721).
      if (event.cry) {
        this.playCry(event.cry);
        this.startFrontAnim(event.cry);
      }
      // A text_asm tail that plays its own sound, the way Text_BallCaught's
      // sound_caught_mon rides the "Gotcha!" line rather than following it.
      if (event.sfx) {
        this.playSfx(event.sfx);
        // TextCommand_SOUND is `call PlaySFX` followed by `call WaitSFX`
        // (home/text.asm:829-836, its table row at :860), so the cart stays
        // INSIDE the text command until the sound has finished: the box cannot
        // be paged away from mid-jingle, and PokeBallEffect's `.FinishTutorial`
        // tail cannot return under it.
        if (event.waitSfx) this.waitSfx = event.sfx;
      }
    }
    // engine/battle/effect_commands.asm:1958: a missed move burns the delay
    // and plays nothing; the after-anim chain is animForMove / stepAnim's.
    // data/moves/effects.asm:1705-1711
    const animId = truthy(event.moveAnim) ? event.moveAnim
      : (event.kind === "move" && !event.deferAnim && event.move);
    if (event.wasVanished && (!truthy(animId) || event.missed)) {
      this.clearVanishReveal(event.side);
    }
    if (truthy(animId) && !event.missed) {
      this.afterAnimPlayed = undefined;
      this.pendingAfterAnim = undefined;
      const started = this.animForMove(animId, event.side, event.animParam,
        event.effectiveness, event.afterAnim);
      if (event.wasVanished
          && !(started && this.armVanishReveal(event.side))) {
        this.clearVanishReveal(event.side);
      }
      if (!started) {
        // BATTLE SCENE off skips the move script but still runs wBattleAfterAnim
        // (anim_commands.asm:55-72 .disabled fallthrough).
        const options = this.game && this.game.options;
        const name = this.afterAnimFor(event.side, event.afterAnim);
        if (options && options.battleScene === false && name) {
          if (this.animForId(name, event.side)) {
            if (event.afterAnim === "damage") {
              this.playHitSound(event.effectiveness);
            }
            this.afterAnimPlayed = true;
          }
        }
      }
      // BattleCommand_Charge runs LoadMoveAnim BEFORE DisappearUser
      // (engine/battle/effect_commands.asm:5459-5470), so FLY / DIG still draw
      // the take-off or the burrow on the turn the substatus goes up; the box
      // only empties once THIS animation is done with.
      if (BattleState.isVanished(this.activeMon(event.side))) {
        this.vanishAnim = this.anim;
        if (this.vanishSeen) this.vanishSeen[event.side] = true;
      }
    } else if (event.kind === "damage" && event.side) {
      // ANIM_x_DAMAGE is the MOVE's after-anim (effect_commands.asm:1963-1972),
      // so only a move hit gets it; `animMove` is HandleWrap's (core.asm:1198-1203).
      const from = event.animSide
        || (event.side === "enemy" ? "player" : "enemy");
      if (event.animMove) {
        this.animForMove(event.animMove, from);
      } else if (event.anim !== false) {
        const hit = event.anim
          || (event.side === "enemy" ? "ANIM_ENEMY_DAMAGE"
            : "ANIM_PLAYER_DAMAGE");
        // Already played as the move's after-anim; do not shake twice.
        if (this.afterAnimPlayed
            && (hit === "ANIM_ENEMY_DAMAGE" || hit === "ANIM_PLAYER_DAMAGE")) {
          this.afterAnimPlayed = undefined;
        } else {
          this.playHitSound(event.effectiveness);
          this.animForId(hit, from);
        }
      }
    } else {
      // Status moves still chain the after-anim but emit no damage event to
      // consume the latch; drop it before the next unrelated line.
      this.afterAnimPlayed = undefined;
    }
    if (event.kind === "heal" && event.anim && event.side) {
      // pokegold engine/battle/core.asm:4074 ItemRecoveryAnim
      this.animForMove(event.anim, event.side);
    } else if (event.kind === "send" && event.side) {
      // Every enemy send-out goes through ShowSetEnemyMonAndSendOutAnimation
      // (engine/battle/core.asm:3354) -- the faint replacement out of
      // EnemyPartyMonEntrance and the AI's mid-turn rotation alike -- and the
      // player's voluntary switch through SendOutPlayerMon (:3796).  Without it
      // the replacement simply appeared, which with two of a species back to back
      // reads as one mon growing a second health bar.
      // ../pokecrystal/engine/battle/core.asm:3146-3147
      if (this.messagePages) {
        this.pendingSendOut = { side: event.side, mon: event.mon };
      } else {
        this.startSendOut(event.side, event.mon);
      }
    }
  }

  // SetEnemyTurn / SetPlayerTurn, then ANIM_SEND_OUT_MON.  The cry and the HUD
  // come after the animation, not with it.
  // Lua: BattleState.lua:2221
  startSendOut(side: string, mon: any): boolean {
    // BattleCheckPlayerShininess / BattleCheckEnemyShininess replay the anim's
    // `.Shiny` arm before the cry (core.asm:3826-3831, :3371-3377).
    const after = { side: side, mon: mon, shiny: (mon && mon.shiny) ? true : undefined };
    // ../pokecrystal/engine/battle/core.asm:4030-4033, :3557
    // ../pokecrystal/engine/battle_anims/bg_effects.asm:647
    this.picHidden[side] = true;
    this.faintSlide = undefined;
    // The rows are shadow OAM (engine/battle/trainer_huds.asm:203-223), which
    // this animation's own sprites overwrite.
    this.ballRows.player = false;
    this.ballRows.enemy = false;
    if (this.animForId("ANIM_SEND_OUT_MON", side)) {
      this.afterSendOut = after;
      return true;
    }
    // BattleAnimRunScript is skipped with BATTLE SCENE off (and there are no
    // scripts at all in a cache built before they were extracted), but the cart
    // still runs the cry and the HUD update, so they happen now.
    this.finishSendOut(after);
    return false;
  }

  // `ld a, [wTempEnemyMonSpecies] / call PlayStereoCry / call UpdateEnemyHUD`
  // (engine/battle/core.asm:3380-3384), and the same pair at the tail of
  // SendOutPlayerMon (:3836-3838).
  // Lua: BattleState.lua:2247
  finishSendOut(after: any): void {
    if (!after) return;
    this.picHidden[after.side] = false;
    this.playCry(after.mon);
    if (after.side === "enemy") {
      this.startFrontAnim(after.mon);
      this.showEnemyHud = true;
    } else {
      this.showPlayerHud = true;
    }
  }

  // PlaySFX with one of the sfx the extractor named, or nothing at all when this
  // cache does not carry it.
  // Lua: BattleState.lua:2261
  playSfx(name: any): void {
    const data = this.game && this.game.data;
    const audio = data && data.audio;
    if (name && audio && audio.sfx && audio.sfx[name]) {
      Sound.play(data, name);
    }
  }

  // ../pokecrystal/engine/battle/core.asm:2258-2260, :2270-2271
  // Lua: BattleState.lua:2270
  faintSound(side: string): void {
    if (side === "enemy") {
      this.playSfx("Sfx_Kinesis");
    } else {
      this.playCry(this.activeMon("player"));
    }
  }

  // PlayStereoCry with the battler's own species.  audio.cries is keyed by
  // SPECIES, the same table the animation runtime's `cry` callback plays through.
  // Lua: BattleState.lua:2280
  playCry(mon: any): void {
    const species = mon && mon.species;
    if (!species) return;
    const data = this.game && this.game.data;
    const audio = data && data.audio;
    if (audio && audio.cries && audio.cries[species]) {
      Sound.playCry(data, species);
    }
  }

  //------------------------------------------------------------------------
  // EvolveAfterBattle
  //------------------------------------------------------------------------

  // ExitBattle (engine/battle/core.asm): `ld a, [wBattleResult] / and $f /
  // jr nz, .CleanUpBattleRAM` -- only a WIN reaches `xor a / ld
  // [wForceEvolution], a / predef EvolveAfterBattle`.  A loss goes straight to
  // the whiteout, so a mon that leveled on the way down never evolves.
  //
  // wForceEvolution is cleared here, which is what makes B a working cancel and
  // what keeps the EVOLVE_ITEM rows (Eevee's stones) from firing off a battle.
  // Lua: BattleState.lua:2301
  startEvolutions(): any {
    this.phase = "evolving";
    // ExitBattle's CleanUpBattleRAM zeroes wLowHealthAlarm; nothing past here
    // runs updateAlarm, so the siren has to be cut before the sweep takes over.
    this.stopAlarm();
    const battle = this.battle;
    if (!(battle && Evolution.runsAfterBattle(battle.outcome))) {
      return this.finishBattle();
    }
    const stack = this.game && this.game.stack;
    const party = battle.party || (this.save && this.save.party) || [];
    this.evolutions = Evolution.plan((this.game && this.game.data) || {},
      party, this.evolvable, {
        // wTimeOfDay, for the TR_MORNDAY / TR_NITE happiness rows.
        timeOfDay: Palettes.clockDaytime(),
      } as any);
    // (Lua 1-based counter; evolutions is a 0-based array here.)
    this.evolutionIndex = 0;
    if (this.evolutions.length === 0 || !stack) return this.finishBattle();
    return this.nextEvolution();
  }

  // EvolveAfterBattle_MasterLoop, one flagged slot at a time: the screen owns
  // the stack until it reports back, and the next slot only starts once it does.
  // Lua: BattleState.lua:2324
  nextEvolution(): any {
    this.evolutionIndex = this.evolutionIndex + 1;
    const plan = this.evolutions[this.evolutionIndex - 1];
    if (!plan) return this.finishBattle();
    const stack = this.game.stack;
    Screens.push(this.game, "Gen2EvolutionAnim", {
      mon: plan.mon,
      entry: plan.entry,
      index: plan.index,
      party: this.battle.party || (this.save && this.save.party),
      save: this.save,
      onDone: () => {
        stack.pop();
        this.nextEvolution();
      },
    });
  }

  // ExitBattle's `farcall GivePokerusAndConvertBerries`, which sits immediately
  // after `predef EvolveAfterBattle` inside the same WIN arm -- so it runs once
  // per won battle, after every evolution has resolved, and never after a loss.
  // Silent by design: nothing tells the player, and the Pokemon Center nurse is
  // the first thing that ever mentions it (std_scripts.asm PokeCenterNurseScript,
  // through the CheckPokerus special).
  // Lua: BattleState.lua:2348
  givePokerus(): number | undefined {
    const battle = this.battle;
    if (!(battle && Evolution.runsAfterBattle(battle.outcome))) return undefined;
    const party = battle.party || (this.save && this.save.party);
    // GivePokerusAndConvertBerries opens on `call ConvertBerriesToBerryJuice`,
    // so the Shuckle's held BERRY converts before the Pokerus roll runs.
    BerryJuice.convertAfterBattle(this.save, party);
    return Pokerus.giveAfterBattle(this.save, party);
  }

  // ---- Lua lines 2360-4722 ----


  // ../pokecrystal/home/fade.asm:35-62
  // ../pokecrystal/engine/overworld/map_setup.asm:181-189
  // Lua: BattleState.lua:2360-2362
  static EXIT_FADE_ROWS = [0x90, 0x40, 0x00];
  static EXIT_FADE_FRAMES = 8;
  static EXIT_MUSIC_FADE = 4;
  // ../pokecrystal/engine/events/whiteout.asm:12-13
  // ../pokecrystal/engine/tilesets/timeofday_pals.asm:122-128
  // Lua: BattleState.lua:2365-2367
  static WHITEOUT_FADE_ROWS = [0xe4, 0x90, 0x40, 0x00];
  static WHITEOUT_FADE_FRAMES = 2;
  static WHITEOUT_HOLD_FRAMES = 40;

  // ../pokecrystal/engine/overworld/scripting.asm:1174-1183
  // Lua: BattleState.lua:2370
  whitesOut(): boolean {
    const battle = this.battle;
    return battle != null && battle.outcome === "lose" && !truthy(this.link)
      && battle.battleType !== Battle.BATTLETYPE_CANLOSE;
  }

  // Lua: BattleState.lua:2376
  finishBattle(): void {
    this.phase = "fadeout";
    this.fadeTick = 0;
    this.anim = undefined;
    this.stopAlarm();
    this.clearMenuCursors();
    if (this.whitesOut()) {
      this.exitFade = { rows: BattleState.WHITEOUT_FADE_ROWS,
        frames: BattleState.WHITEOUT_FADE_FRAMES,
        hold: BattleState.WHITEOUT_HOLD_FRAMES };
      return;
    }
    this.exitFade = { rows: BattleState.EXIT_FADE_ROWS,
      frames: BattleState.EXIT_FADE_FRAMES, hold: 0 };
    Music.fadeOut(BattleState.EXIT_MUSIC_FADE);
  }

  // Lua: BattleState.lua:2393
  exitFadeLength(): number {
    const fade = this.exitFade;
    if (!truthy(fade)) return BattleState.EXIT_FADE_FRAMES * BattleState.EXIT_FADE_ROWS.length;
    return fade.frames * fade.rows.length + fade.hold;
  }

  // ../pokecrystal/home/fade.asm:57
  // Lua: BattleState.lua:2400
  stepExitFade(): void {
    this.fadeTick = (this.fadeTick ?? 0) + 1;
    if (this.fadeTick < this.exitFadeLength()) return;
    this.completeBattle();
  }

  // Lua: BattleState.lua:2406
  exitFadeBgp(): number | undefined {
    if (this.phase !== "fadeout") return undefined;
    const fade = this.exitFade;
    const rows: number[] = truthy(fade) && truthy(fade.rows) ? fade.rows : BattleState.EXIT_FADE_ROWS;
    const frames: number = truthy(fade) && truthy(fade.frames) ? fade.frames : BattleState.EXIT_FADE_FRAMES;
    const index = Math.floor((this.fadeTick ?? 0) / frames) + 1;
    return rows[Math.min(rows.length, index) - 1];
  }

  // Lua: BattleState.lua:2415
  completeBattle(): void {
    this.phase = "done";
    this.givePokerus();
    // CleanUpBattleRAM: every substatus the battle wrote goes with the battle.
    // The party tables it wrote them on are the save's own, so this has to run
    // before the overworld (and the next save write) sees them again.
    if (truthy(this.battle)) this.battle.clearAllVolatiles();
    Runtime.emit("battle.ended", {
      battle: this, result: truthy(this.battle) ? this.battle.outcome : undefined,
    });
    if (truthy(this.onDone)) {
      this.onDone(truthy(this.battle) ? this.battle.outcome : undefined, this.battle);
    }
  }

  // CleanUpBattleRAM's cursor block (engine/battle/core.asm:7994-8004): the menu
  // bytes that live ACROSS menu openings are zeroed here and nowhere else --
  // wPartyMenuCursor, wLastPocket, and the ITEM / KEY_ITEM / BALL pocket cursors
  // with their scroll positions.  The TM/HM pair is deliberately NOT in that
  // list, so it survives a battle and is left alone here.
  // Lua: BattleState.lua:2435
  clearMenuCursors(): void {
    this.shiftIndex = undefined;
    this.shiftSwitchIndex = undefined;
    const game = this.game;
    if (!truthy(game)) return;
    game.partyMenuCursor = undefined;
    const pack = game.packCursor;
    if (!truthy(pack)) return;
    pack.pocket = undefined;
    for (const id of ["ITEM", "KEY_ITEM", "BALL"]) {
      pack.cursor[id] = undefined;
      pack.scroll[id] = undefined;
    }
  }

  // Whether any mon that took part in the battle is still standing.  A wild win
  // with none left plays NO music at all (PlayVictoryMusic's `.lost` path), so
  // the map theme carries straight on -- which is what a mon fainting to its own
  // recoil on the winning blow sounds like.
  // Lua: BattleState.lua:2453
  participantsFainted(): boolean {
    const battle = this.battle;
    if (!truthy(battle)) return true;
    for (const key of sortedKeys(battle.participants ?? {})) {
      const index = Number(key);
      const mon = truthy(battle.party) ? battle.party[index - 1] : undefined;
      if (truthy(mon) && (mon.hp ?? 0) > 0) return false;
    }
    return true;
  }

  // Lua: BattleState.lua:2463
  playVictoryMusic(): string | undefined {
    const data = truthy(this.game) ? this.game.data : undefined;
    const audio = truthy(data) ? data.audio : undefined;
    if (!(truthy(audio) && truthy(audio.songs))) return undefined;
    const song = BattleMusic.victorySong({
      class: truthy(this.music) ? this.music.class : undefined,
      participantsFainted: this.participantsFainted(),
    } as any);
    if (!(truthy(song) && truthy(audio.songs[song as any]))) return undefined;
    Music.play(data, song as any, true, { reason: "victory" } as any);
    return song as any;
  }

  // Lua: BattleState.lua:2476
  submit(action: any): any {
    if (truthy(this.link) && truthy(this.link.submit)) {
      return this.link.submit(this, action);
    }
    this.phase = "resolving";
    this.pushAll(this.battle.takeTurn(action));
    this.message = undefined;
    this.messageTimer = 0;
    this.advanceQueue();
  }

  // Lua: BattleState.lua:2487
  playerMoves(): any[] {
    return (truthy(this.battle) && truthy(this.battle.player) && this.battle.player.moves) || [];
  }

  // One semantic path for the native command menu and mod.battle intents.
  // Returns [ok, err] for the Lua's two returns.
  // Lua: BattleState.lua:2492
  chooseMenu(choice: any): [true | undefined, string?] {
    if (this.phase !== "menu") return [undefined, "battle menu is not active"];
    if (truthy(this.link) && truthy(this.link.menuChoice) && truthy(this.link.menuChoice(this, choice))) {
      return [true];
    }
    if (choice === "fight") {
      // CheckPlayerHasUsableMoves skips MoveSelectionScreen and uses Struggle.
      const fighter = truthy(this.battle) ? this.battle.player : undefined;
      if (truthy(fighter) && this.playerMoves().length > 0
          && !truthy(this.battle.hasUsableMoves(fighter))) {
        this.submit({ kind: "move", move: Battle.STRUGGLE });
      } else {
        this.phase = "moves";
        // MoveSelectionScreen reopens on the last used move, clamped if the
        // moveset shrank since then.
        const moves = this.playerMoves();
        this.moveIndex = Math.max(1,
          Math.min(this.moveIndex ?? 1, Math.max(1, moves.length)));
      }
    } else if (choice === "run") {
      this.submit({ kind: "run" });
    } else if (choice === "item") {
      if (truthy(this.tutorial)) {
        this.openTutorialPack();
      } else if (truthy(this.contest)) {
        this.throwParkBall();
      } else {
        this.openPack();
      }
    } else if (choice === "party") {
      this.openParty();
    } else {
      return [undefined, "unknown battle menu choice"];
    }
    return [true];
  }

  // Returns [ok, err] for the Lua's two returns.
  // Lua: BattleState.lua:2529
  chooseMove(index: number): [true | undefined, string?] {
    if (this.phase !== "moves") return [undefined, "move menu is not active"];
    const move = this.playerMoves()[index - 1];
    if (!truthy(move)) return [undefined, "invalid move slot"];
    this.moveIndex = index;
    this.moveSwapIndex = undefined;
    if ((move.pp ?? 0) <= 0) {
      this.refuseMove(TEXT_NO_PP_LEFT);
    } else if (truthy(this.battle.moveDisabled(this.battle.player, move.id))) {
      this.refuseMove(TEXT_MOVE_DISABLED);
    } else {
      this.submit({ kind: "move", move: move.id });
    }
    return [true];
  }

  // Lua: BattleState.lua:2545
  cancelMove(): [true | undefined, string?] {
    if (this.phase !== "moves") return [undefined, "move menu is not active"];
    this.moveSwapIndex = undefined;
    this.phase = "menu";
    return [true];
  }

  // MoveSelectionScreen's `.pressed_select` (engine/battle/core.asm:5320-5374).
  // SELECT marks a slot, SELECT again swaps the marked slot with the one under
  // the cursor, and A or B clears the mark without swapping.  A move IS one
  // record carrying its own pp and maxPp, and the battler is the party entry,
  // so exchanging the two records does all four of the cart's swaps at once.
  // A transformed mon's swap is refused outright (the COOLTRAINER glitch fix).
  // Lua: BattleState.lua:2575
  swapAllowed(): boolean {
    const player = truthy(this.battle) ? this.battle.player : undefined;
    if (!truthy(player)) return false;
    return !truthy((this.battle.volatile(player) ?? {}).transformed);
  }

  // Lua: BattleState.lua:2581
  swapMoves(i: number, j: number): void {
    if (i === j) return;
    const moves = this.playerMoves();
    const a = moves[i - 1];
    const b = moves[j - 1];
    if (!(truthy(a) && truthy(b))) return;
    moves[i - 1] = b;
    moves[j - 1] = a;
  }

  // ../pokecrystal/engine/battle/core.asm:8063
  // Lua: BattleState.lua:2590
  introGrayscale(): boolean {
    const frame = this.slideFrame;
    return frame != null && frame < BattleAnimView.SLIDE_FRAMES;
  }

  // Lua: BattleState.lua:2595
  update(_dt?: number): any {
    // The evolution sweep owns the stack (and the low-HP alarm is long over);
    // this state is only still here because ExitBattle has not cleaned up yet.
    if (this.phase === "evolving" || this.phase === "done") return;
    if (this.phase === "fadeout") return this.stepExitFade();
    this.updateAlarm();
    this.stepFrontAnim();
    // ../pokecrystal/home/joypad.asm:428
    this.arrowBlink = mod((this.arrowBlink ?? 0) + 1, 32);
    const input = truthy(this.game) ? this.game.input : undefined;
    if (!truthy(input)) return;

    // The intro slide blocks everything: BattleIntroSlidingPics is a plain
    // 72-frame loop with no input read inside it.
    if (this.slideFrame < BattleAnimView.SLIDE_FRAMES) {
      this.slideFrame = this.slideFrame + 1;
      return;
    }

    // BattleWinSlideInEnemyTrainerFrontpic plus WinTrainerBattle's DelayFrames
    // 40 (engine/battle/core.asm:6279-6318, :2310-2312)
    if (truthy(this.winSliding)) {
      this.winSlide = this.winSlide + 1;
      if (this.winSlide >= WIN_SLIDE_FRAMES + WIN_SLIDE_DELAY_FRAMES) {
        this.winSliding = undefined;
        this.advanceQueue();
      }
      return;
    }

    // SlideBattlePicOut is a plain loop with DelayFrames in it, so it owns the
    // screen the same way (engine/battle/core.asm:2882).
    if (truthy(this.trainerSlide)) {
      this.trainerSlide = this.trainerSlide + 1;
      if (this.trainerSlide >= TRAINER_SLIDE_FRAMES) {
        this.trainerSlide = undefined;
        this.showEnemyTrainer = false;
        // ../pokecrystal/engine/battle/core.asm:3221
        this.picHidden.enemy = true;
        this.advanceQueue();
      }
      return;
    }
    // ../pokecrystal/engine/battle/core.asm:82-84
    if (truthy(this.backpicSlide)) {
      this.backpicSlide = this.backpicSlide + 1;
      if (this.backpicSlide >= BACKPIC_SLIDE_FRAMES) {
        this.backpicSlide = undefined;
        this.showPlayerTrainer = false;
        this.picHidden.player = true;
        this.advanceQueue();
      }
      return;
    }

    // MonFaintedAnimation is a plain loop with DelayFrames in it, like
    // SlideBattlePicOut above: it owns the screen until the pic is off the
    // field, and the box it emptied stays empty (only a send-out refills it).
    if (truthy(this.faintSlide)) {
      const slide = this.faintSlide;
      if (truthy(slide.wait)) {
        if (Sound.sfxBusy() && slide.wait < EXP_WAIT_SFX_CAP) {
          slide.wait = slide.wait + 1;
          return;
        }
        slide.wait = undefined;
        this.faintSound(slide.side);
      }
      slide.frames = slide.frames + 1;
      if (slide.frames >= this.faintSlideFrames(slide.side)) {
        this.picHidden[slide.side] = true;
        // SFX_FAINT follows EnemyMonFaintedAnimation, and ClearBox blanks the
        // fainted side's HUD before its text (core.asm:2213-2218, :2202-2205).
        if (slide.side === "enemy") {
          this.playSfx("Sfx_Faint");
          this.showEnemyHud = false;
        } else {
          this.showPlayerHud = false;
        }
        this.faintSlide = undefined;
        this.advanceQueue();
      }
      return;
    }

    // ../pokecrystal/home/text.asm:660
    if (truthy(this.syncTyper())) {
      this.typer.tick();
      return;
    }

    // An animation owns the screen for as long as it runs, exactly the way
    // RunBattleAnimScript owns the main loop.
    // pokegold data/moves/animations.asm .Click: a finished keepsprites run
    // no longer owns the loop, just the OAM the draw path still reads.
    if (truthy(this.anim) && !(truthy(this.anim.done()) && truthy(this.anim.keepSprites))) {
      this.stepAnim(input);
      return;
    }

    // The bar drain holds the queue the way AnimateHPBar's loop holds the
    // cart: the next event runs once the shown HP has caught the real one.
    if (truthy(this.stepHpAnim())) return;

    if (this.phase === "resolving" || this.phase === "intro") {
      // The `call WaitSFX` half of TextCommand_SOUND (home/text.asm:834-835):
      // the line holds, unskippable, for as long as its own sound is sounding.
      // Without it the DUDE's auto-input tapped straight through the "Gotcha!"
      // line and finishBattle closed the tutorial over the jingle.
      if (truthy(this.waitSfx)) {
        if (!truthy(this.waitSfxLeft)) {
          this.waitSfxLeft = truthy(Sound.waitFramesFor)
            ? Sound.waitFramesFor(this.waitSfx) : 180;
        }
        this.waitSfxLeft = this.waitSfxLeft - 1;
        if (Sound.isPlaying(this.waitSfx)) {
          if (this.waitSfxLeft > 0) return;
          if (truthy(Sound.stop)) Sound.stop(this.waitSfx);
        }
        this.waitSfx = undefined;
        this.waitSfxLeft = undefined;
      }
      // engine/battle/effect_commands.asm:6661
      if ((this.messageDelay ?? 0) > 0) {
        this.messageDelay = this.messageDelay - 1;
        return;
      }
      if (this.messageTimer > 0) {
        if (truthy(this.tutorial)) {
          // PromptButton waits for the button; the tutorial cannot press it, so
          // DudeAutoInput_A (frame 0x51) answers.  Never auto-timeout here: a
          // 48-frame skip would hand his press to the next screen.
          this.dudeInput(CatchTutorial.PROMPT_STREAM,
            "prompt:" + tostring(this.message));
        }
        // PromptButton (home/text.asm): A/B pages; no frame countdown.
        if (input.wasPressed("a") || input.wasPressed("b")) {
          this.messageTimer = 0;
        }
        return;
      }
      // ../pokecrystal/engine/battle/core.asm:7121-7128
      if (truthy(this.stepExpAnim())) return;
      // pokegold engine/battle/core.asm:7057-7069: the stats box shows once
      // the "grew to level" line has finished, held for A/B.
      if (truthy(this.pendingStatsMon)) {
        this.statsBoxMon = this.pendingStatsMon;
        this.pendingStatsMon = undefined;
        this.phase = "stats-box";
        return;
      }
      // PrintWinLossText's line pages like any map text (home/text.asm:403-448)
      if (truthy(this.nextPage())) return;
      this.advanceQueue();
      return;
    }

    // pokegold engine/battle/core.asm:7069 (WaitPressAorB_BlinkCursor).
    if (this.phase === "stats-box") {
      if (input.wasPressed("a") || input.wasPressed("b")) {
        this.statsBoxMon = undefined;
        this.phase = "resolving";
      }
      return;
    }

    // The turn CheckPlayerLockedIn skipped the menu for.  No input is read: the
    // cart falls straight into ParsePlayerAction, whose .locked_in arm has no
    // MoveSelectionScreen in front of it.
    if (this.phase === "locked-in") {
      const locked = truthy(this.battle) && truthy(this.battle.player)
        ? this.battle.lockedInMove(this.battle.player) : undefined;
      if (truthy(locked)) {
        this.submit({ kind: "move", move: locked });
      } else {
        this.phase = "menu";
      }
      return;
    }

    if (this.phase === "menu") {
      // 2x2 grid: left/right swap the column, up/down the row.  No
      // STATICMENU_WRAP in BattleMenuHeader (engine/battle/menu.asm:31-33), so
      // the cursor clamps at each edge (engine/menus/menu.asm:156-166) (#1706).
      // MenuClickSound / PlayClickSFX (home/menu.asm:746-762): SFX_READ_TEXT_2
      // on A/B only, never on D-pad.
      const col = mod(this.menuIndex - 1, 2);
      const row = Math.floor((this.menuIndex - 1) / 2);
      if (input.wasPressed("left")) {
        this.menuIndex = row * 2 + Math.max(0, col - 1) + 1;
      } else if (input.wasPressed("right")) {
        this.menuIndex = row * 2 + Math.min(1, col + 1) + 1;
      } else if (input.wasPressed("up")) {
        this.menuIndex = Math.max(0, row - 1) * 2 + col + 1;
      } else if (input.wasPressed("down")) {
        this.menuIndex = Math.min(1, row + 1) * 2 + col + 1;
      } else if (input.wasPressed("a")) {
        this.playSfx("Sfx_ReadText2");
        this.chooseMenu(MENU_ACTION[MENU[this.menuIndex - 1]]);
      }
      return;
    }

    if (this.phase === "moves") {
      const moves = this.playerMoves();
      let grid: number | undefined;
      if (truthy(this.moveGridNavigation())) {
        const index = this.moveIndex;
        const count = moves.length;
        if (input.wasPressed("left") || input.wasPressed("right")) {
          const other = Math.floor((index - 1) / 2) * 2
            + (1 - mod(index - 1, 2)) + 1;
          grid = other <= count ? other : index;
        } else if (input.wasPressed("up") || input.wasPressed("down")) {
          const other = (1 - Math.floor((index - 1) / 2)) * 2
            + mod(index - 1, 2) + 1;
          grid = other <= count ? other : index;
        }
      }
      if (grid != null) {
        this.moveIndex = grid;
      } else if (input.wasPressed("up")) {
        this.moveIndex = this.moveIndex > 1 ? this.moveIndex - 1 : moves.length;
      } else if (input.wasPressed("down")) {
        this.moveIndex = this.moveIndex < moves.length ? this.moveIndex + 1 : 1;
      } else if (input.wasPressed("select")) {
        if (truthy(this.moveSwapIndex)) {
          this.swapMoves(this.moveSwapIndex, this.moveIndex);
          this.moveSwapIndex = undefined;
        } else if (this.swapAllowed()) {
          this.moveSwapIndex = this.moveIndex;
        }
      } else if (input.wasPressed("b")) {
        // B leaves the list, and a mark never survives it
        this.playSfx("Sfx_ReadText2");
        this.cancelMove();
      } else if (input.wasPressed("a")) {
        // `xor a / ld [wSwappingMove], a` opens the A arm: choosing a move
        // cancels a pending swap rather than performing it
        this.playSfx("Sfx_ReadText2");
        this.chooseMove(this.moveIndex);
      }
      return;
    }

    if (this.phase === "ask-nickname") {
      // AskGiveNicknameText ends on `done`, so the line stands while the box is
      // up rather than paging away from under it.
      if (this.messageTimer > 0) {
        if (input.wasPressed("a") || input.wasPressed("b")) {
          this.messageTimer = 0;
        }
        return;
      }
      if (input.wasPressed("up") || input.wasPressed("down")) {
        this.nicknameIndex = this.nicknameIndex === 1 ? 2 : 1;
      } else if (input.wasPressed("b")) {
        // YesNoMenuHeader carries no STATICMENU_DISABLE_B: B is NO.
        return this.answerNickname(false);
      } else if (input.wasPressed("a")) {
        return this.answerNickname(this.nicknameIndex === 1);
      }
      return;
    }

    // The prompt's earlier pages: PlaceYesNoBox only follows the LAST one
    // (engine/battle/core.asm:3302-3305), so the mon is named and read first.
    if (this.phase === "shift-intro") {
      if (this.messageTimer > 0) {
        if (input.wasPressed("a") || input.wasPressed("b")) {
          this.messageTimer = 0;
        }
        return;
      }
      this.nextPage();
      if (!truthy(this.messagePages)) this.phase = "ask-shift";
      return;
    }

    // OfferSwitch's YesNoBox: YES opens PickSwitchMonInBattle, NO (and B) falls
    // straight through to the enemy's send-out (engine/battle/core.asm:3305-3310).
    if (this.phase === "ask-shift") {
      if (this.messageTimer > 0) {
        if (input.wasPressed("a") || input.wasPressed("b")) {
          this.messageTimer = 0;
        }
        return;
      }
      if (input.wasPressed("up") || input.wasPressed("down")) {
        this.shiftIndex = this.shiftIndex === 1 ? 2 : 1;
      } else if (input.wasPressed("b")) {
        this.phase = "resolving";
        return this.advanceQueue();
      } else if (input.wasPressed("a")) {
        if (this.shiftIndex === 1) return this.openShiftParty();
        this.phase = "resolving";
        return this.advanceQueue();
      }
      return;
    }

    // engine/battle/core.asm:2590
    if (this.phase === "ask-next-mon") {
      if (this.messageTimer > 0) {
        if (input.wasPressed("a") || input.wasPressed("b")) {
          this.messageTimer = 0;
        }
        return;
      }
      if (input.wasPressed("up") || input.wasPressed("down")) {
        this.nextMonIndex = this.nextMonIndex === 1 ? 2 : 1;
      } else if (input.wasPressed("b")) {
        return this.answerUseNextMon(false);
      } else if (input.wasPressed("a")) {
        return this.answerUseNextMon(this.nextMonIndex === 1);
      }
      return;
    }

    if (this.phase === "cant-escape-then-switch") {
      if (this.messageTimer > 0) {
        if (input.wasPressed("a") || input.wasPressed("b")) {
          this.messageTimer = 0;
        }
        return;
      }
      this.message = Strings.get("Choose a POKéMON.");
      this.phase = "forced-switch";
      return;
    }

    if (this.phase === "refuse-shift") {
      if (this.messageTimer > 0) {
        if (input.wasPressed("a") || input.wasPressed("b")) {
          this.messageTimer = 0;
        }
        return;
      }
      this.message = undefined;
      return this.openShiftParty();
    }

    if (this.phase === "forced-switch") {
      if (truthy(this.link) && truthy(this.link.forcedPrompt) && truthy(this.link.forcedPrompt(this))) {
        return;
      }
      // Reuse the party list so the layout and controls match the start menu's.
      this.openParty(true);
      return;
    }

    // stack the refusal prints over the list itself (core.asm:2852-2857)
    if (this.phase === "refuse-switch") {
      if (this.messageTimer > 0) {
        if (input.wasPressed("a") || input.wasPressed("b")) {
          this.messageTimer = 0;
        }
        return;
      }
      const forced = this.refuseForced;
      this.refuseForced = undefined;
      this.message = undefined;
      if (!truthy(this.openParty(forced))) {
        // No stack to open a list on (headless): the forced arm falls back to
        // the phase that keeps asking, and a voluntary one to the menu.
        this.phase = truthy(forced) ? "forced-switch" : "menu";
      }
      return;
    }

    if (this.phase === "refuse-move") {
      if (this.messageTimer > 0) {
        if (input.wasPressed("a") || input.wasPressed("b")) {
          this.messageTimer = 0;
        }
        return;
      }
      this.message = undefined;
      this.phase = "moves";
      return;
    }

    if (this.phase === "refuse-menu") {
      if (this.messageTimer > 0) {
        if (input.wasPressed("a") || input.wasPressed("b")) {
          this.messageTimer = 0;
        }
        return;
      }
      this.message = undefined;
      this.phase = "menu";
      return;
    }

    if (this.phase === "learn-intro") {
      if (this.messageTimer > 0) {
        if (input.wasPressed("a") || input.wasPressed("b")) {
          this.messageTimer = 0;
        }
        return;
      }
      // YesNoBox follows the last page of the text (engine/pokemon/learn.asm:125).
      this.nextPage();
      if (!truthy(this.messagePages)) this.phase = "ask-forget";
      return;
    }

    if (this.phase === "ask-forget" || this.phase === "stop-learning") {
      if (this.messageTimer > 0) {
        if (input.wasPressed("a") || input.wasPressed("b")) {
          this.messageTimer = 0;
        }
        return;
      }
      if (input.wasPressed("up") || input.wasPressed("down")) {
        this.forgetChoice = this.forgetChoice === 1 ? 2 : 1;
      } else if (input.wasPressed("b")) {
        // YesNoMenuHeader carries no STATICMENU_DISABLE_B: B is NO.
        return this.answerForgetPrompt(false);
      } else if (input.wasPressed("a")) {
        return this.answerForgetPrompt(this.forgetChoice === 1);
      }
      return;
    }

    if (this.phase === "choose-forget") {
      // MoveCantForgetHMText holds like any prompt, then `jr .loop` reprints
      // MoveAskForgetText over the list (engine/pokemon/learn.asm:193-197).
      if (this.messageTimer > 0) {
        if (input.wasPressed("a") || input.wasPressed("b")) {
          this.messageTimer = 0;
        }
        return;
      }
      this.message = Strings.get(TEXT_ASK_FORGET_SLOT);
      const learn = this.pendingLearn;
      const mon = truthy(learn) ? this.battle.party[learn.index - 1] : undefined;
      const moves: any[] = (truthy(mon) && mon.moves) || [];
      if (input.wasPressed("up")) {
        this.forgetIndex = this.forgetIndex > 1 ? this.forgetIndex - 1 : moves.length;
      } else if (input.wasPressed("down")) {
        this.forgetIndex = this.forgetIndex < moves.length ? this.forgetIndex + 1 : 1;
      } else if (input.wasPressed("b")) {
        // ForgetMove's .cancel sets carry, which is LearnMove's .cancel
        // (engine/pokemon/learn.asm:187-201).
        return this.askStopLearning();
      } else if (input.wasPressed("a")) {
        const slot = moves[this.forgetIndex - 1];
        if (truthy(slot) && truthy(HM_MOVES[slot.id])) {
          // MoveCantForgetHMText, then `jr .loop`, which re-seeds wMenuCursorY
          // (engine/pokemon/learn.asm:155-157, 193-197).
          this.message = Strings.get(TEXT_CANT_FORGET_HM);
          this.messageTimer = MESSAGE_FRAMES;
          this.forgetIndex = 1;
          return;
        }
        this.battle.resolveForget(learn.index, this.forgetIndex,
          learn.move, learn.moveName);
        this.pendingLearn = undefined;
        this.phase = "resolving";
        this.pushFront(this.battle.takeEvents());
        this.advanceQueue();
      }
      return;
    }
  }

  // Returns whether the list actually opened, so a caller that has to do
  // something else when it cannot (no stack at all) can tell.
  // Lua: BattleState.lua:3062
  openParty(forced?: boolean): boolean {
    const stack = truthy(this.game) ? this.game.stack : undefined;
    if (!truthy(stack)) return false;
    this.phase = "submenu";
    let list: any;
    list = Screens.push(this.game, "Gen2PartyMenu", {
      // PARTYMENUACTION_CHOOSE_POKEMON for the voluntary list and
      // PARTYMENUACTION_SWITCH for the forced one (engine/battle/core.asm:4795,
      // :2702; engine/pokemon/party_menu.asm:660-679).  Only the voluntary list
      // carries BattleMonMenu; PickPartyMonInBattle has no submenu.
      prompt: truthy(forced) ? "which" : "choose",
      battle: true,
      battleSubmenu: !truthy(forced),
      party: (truthy(this.battle) && this.battle.party) || undefined,
      save: this.save,
      onCancel: () => {
        stack.pop();
        // A forced switch cannot be cancelled.
        this.phase = truthy(forced) ? "forced-switch" : "menu";
      },
      onChoose: (index: number, mon: any) => {
        // TryPlayerSwitch's own order, every arm ending on
        // `jp BattleMenuPKMN_Loop` (engine/battle/core.asm:4863-4888).
        let refused: boolean | undefined;
        let key: any;
        let arg: any;
        if (!truthy(forced) && mon === this.battle.player) {
          refused = true; key = TEXT_ALREADY_OUT; arg = this.name(mon);
        } else if (!truthy(forced) && truthy(this.battle.switchLocked())) {
          refused = true; key = TEXT_CANT_BE_RECALLED;
          arg = this.name(this.battle.player);
        } else if (truthy(mon.isEgg)) {
          // CheckIfCurPartyMonIsFitToFight's `cp EGG` arm (core.asm:3450-3456)
          refused = true; key = TEXT_EGG_CANT_BATTLE;
        } else if ((mon.hp ?? 0) <= 0) {
          // CheckIfCurPartyMonIsFitToFight (engine/pokemon/party_menu.asm):
          // a fainted pick prints Text_TheresNoWillToFight and returns carry, so
          // the caller re-opens the list -- BattleMenu_PKMN's own loop for a
          // voluntary switch, ForcePickPartyMonInBattle's `jr c` after a faint.
          refused = true;
        }
        // Only the accepted switch tears the list down (core.asm:5186-5192)
        if (refused) {
          if (truthy(list)) {
            return list.refuse(Strings.get(key ?? TEXT_NO_WILL_TO_FIGHT, arg));
          }
          stack.pop();
          return this.refuseSwitch(forced, key, arg);
        }
        stack.pop();
        if (truthy(forced)) {
          // ForcePickPartyMonInBattle loops on carry: a pick the engine will not
          // take has to come back as the list again, never as the battle menu
          // with a fainted mon standing on the field.
          if (truthy(this.link) && truthy(this.link.forcedSwitch)) {
            return this.link.forcedSwitch(this, index);
          }
          if (!truthy(this.battle.switch(index))) {
            return this.refuseSwitch(true);
          }
          this.pushAll(this.battle.takeEvents());
          this.phase = "resolving";
          this.advanceQueue();
        } else {
          this.submit({ kind: "switch", index });
        }
      },
    });
    return true;
  }

  // The refusal itself: the line, then the same list again.  `forced` is carried
  // so a faint's list comes back with no CANCEL of its own and a voluntary one
  // keeps its own.
  // Lua: BattleState.lua:3134
  refuseSwitch(forced: any, source?: any, ...args: any[]): void {
    this.refuseForced = truthy(forced) ? true : false;
    this.phase = "refuse-switch";
    this.message = Strings.get(source ?? TEXT_NO_WILL_TO_FIGHT, ...args);
    this.typedText = undefined;
    this.messageTimer = MESSAGE_FRAMES;
  }

  // Lua: BattleState.lua:3142
  refuseMove(text: any): void {
    this.phase = "refuse-move";
    this.message = Strings.get(text);
    this.typedText = undefined;
    this.messageTimer = MESSAGE_FRAMES;
  }

  // Lua: BattleState.lua:3149
  refuseMenu(text: any): void {
    this.phase = "refuse-menu";
    this.message = Strings.get(text);
    this.typedText = undefined;
    this.messageTimer = MESSAGE_FRAMES;
  }

  // BattleMenu_Pack: `farcall BattlePack`, which is a different jumptable from
  // the field PACK's -- it dispatches on the item's BATTLE menu nibble and never
  // reaches a field effect.  The empty world is the same guard MartMenu:enterSell
  // and ItemPcMenu:enterDeposit carry: PackMenu falls back to game.world when it
  // is nil, and that world is the overworld this battle is suspended over.
  // Lua: BattleState.lua:3161
  openPack(): void {
    const stack = truthy(this.game) ? this.game.stack : undefined;
    if (!truthy(stack)) return;
    this.phase = "submenu";
    Screens.push(this.game, "Gen2PackMenu", {
      battle: true,
      world: {},
      onClose: () => {
        stack.pop();
        this.phase = "menu";
      },
      onChoose: (itemId: any) => {
        stack.pop();
        this.useItem(itemId);
      },
    });
  }

  // BattleMenu_Pack's `.tutorial` arm: `farcall TutorialPack`, and then POKE_BALL
  // goes into wCurItem and DoItemEffect runs WHATEVER the pack came back with --
  // TutorialPack's own tail writes FALSE to wPackUsedItem, so its answer is
  // discarded.  The pack is real all the same: it is drawn from the DUDE's own
  // buffers (one POTION and one POKE BALL), and the DUDE_RIGHT_A stream armed
  // with it is what crosses from the ITEM pocket to the BALL pocket and picks
  // the ball, which is the whole point of the demo.
  // Lua: BattleState.lua:3186
  openTutorialPack(): any {
    const stack = truthy(this.game) ? this.game.stack : undefined;
    if (!truthy(stack)) return this.useItem(CatchTutorial.BALL);
    this.phase = "submenu";
    const throwBall = (): void => {
      stack.pop();
      this.useItem(CatchTutorial.BALL);
    };
    Screens.push(this.game, "Gen2PackMenu", {
      battle: true,
      tutorial: true,
      save: CatchTutorial.dudeSave(),
      // An empty world rather than the real one: a DUDE pocket must not reach
      // World:useFieldItem, because these buffers are not the player's bag and
      // nothing in them may be spent.  PackMenu falls back to game.world when
      // this is nil, so it has to be a table.
      world: {},
      onClose: throwBall,
      onChoose: throwBall,
    });
    this.dudeInput(CatchTutorial.PACK_STREAM, undefined, true);
  }

  // BattleMenu_Pack's `.contest` arm: it does NOT open the pack.  PARK_BALL goes
  // straight into wCurItem and DoItemEffect runs, so the third menu slot IS the
  // throw and nothing else can be used inside the park.
  // Lua: BattleState.lua:3212
  throwParkBall(): void {
    this.useItem(BugContest.BALL);
  }

  // wBattleAnimParam for the throw: the item's own id, except that everything
  // past POKE_BALL (the Kurt balls) is thrown with POKE_BALL's -- `cp POKE_BALL
  // + 1 / jr c, .not_kurt_ball / ld a, POKE_BALL` (item_effects.asm:396).  It is
  // what BattleAnim_ThrowPokeBall's anim_if_param_equal rows branch on
  // (data/moves/animations.asm:305-308).
  // Lua: BattleState.lua:3272
  ballAnimParam(itemId: any): number {
    const items = ((truthy(this.game) && this.game.data) || {}).items || {};
    const pokeBall = (truthy(items.POKE_BALL) && items.POKE_BALL.index) || POKE_BALL_ID;
    const id = (truthy(items[itemId]) && items[itemId].index) || pokeBall;
    if (id > pokeBall) return pokeBall;
    return id;
  }

  // GetBallAnimPal (engine/battle_anims/functions.asm:292), which the thrown
  // ball's object function reads out of env.ballPalette.
  // Lua: BattleState.lua:3282
  ballPalette(itemId: any): string {
    return BALL_COLORS[itemId] ?? BALL_COLOR_DEFAULT;
  }

  // `ld de, ANIM_THROW_POKE_BALL ... xor a / ldh [hBattleTurn], a`: the ball is
  // thrown from the player's side whatever the turn order was.
  // Lua: BattleState.lua:3288
  startBallAnim(param: any, itemId: any): any {
    const key = truthy(this.anims) && truthy(this.anims.ids)
      ? this.anims.ids.ANIM_THROW_POKE_BALL : undefined;
    return this.startAnim(key, {
      turn: 0, animId: "ANIM_THROW_POKE_BALL", param,
      ballPalette: this.ballPalette(itemId),
    });
  }

  // GetPokeBallWobble (engine/battle_anims/pokeball_wobble.asm), which
  // anim_checkpokeball loops on: 0 wobble again, 1 click, 2 break free.  The
  // counter goes up FIRST, and the fourth call ends the loop -- a caught mon
  // clicks, anything else breaks free.  Before that a caught mon always wobbles
  // again and a doomed one re-rolls: the first WobbleProbabilities row whose
  // catch rate is at least the final rate is the one whose byte the roll has to
  // come in under.
  // Lua: BattleState.lua:3304
  pokeballWobble(): number {
    const thrown = this.ballThrow;
    if (!truthy(thrown)) return 0;
    thrown.wobble = (thrown.wobble ?? 0) + 1;
    if (thrown.wobble === WOBBLE_LIMIT + 1) {
      return truthy(thrown.caught) ? 1 : 2;
    }
    if (truthy(thrown.caught)) return 0;
    let chance = 0;
    for (const row of WOBBLE_PROBABILITIES) {
      if (row[0] >= (thrown.rate ?? 0)) { chance = row[1]; break; }
    }
    const rnd = truthy(this.battle) ? this.battle.random : undefined;
    const roll = truthy(rnd) ? rnd(256) : 0;
    return roll < chance ? 0 : 2;
  }

  // Which of the four lines the throw earned.  With no animation to run (an
  // older cache, or BATTLE SCENE off) nothing ever wobbled, so it is the first.
  // Lua: BattleState.lua:3323
  ballFailureText(): string {
    const wobble = (truthy(this.ballThrow) && this.ballThrow.wobble) || 1;
    return Strings.get(BALL_FAILURE_TEXT[
      Math.max(1, Math.min(BALL_FAILURE_TEXT.length, wobble)) - 1]!);
  }

  // UseBallInTrainerBattle (item_effects.asm:2579).  Not a bare refusal: the ball
  // is thrown with wBattleAnimParam = 0, which BattleAnim_ThrowPokeBall's
  // `anim_if_param_equal NO_ITEM` sends to .TheTrainerBlockedTheBall, then BOTH
  // lines print and it falls into UseDisposableItem -- so the ball is spent and
  // the turn goes with it.
  // Lua: BattleState.lua:3334
  throwBallAtTrainer(itemId: any): void {
    this.queue = [];
    this.push({ kind: "message", text: Strings.get("The trainer blocked the BALL!") });
    this.push({ kind: "message", text: Strings.get("Don't be a thief!") });
    this.consumeItem(itemId);
    this.pushAll(this.battle.takeTurn({ kind: "item", item: itemId }));
    // NO_ITEM is 0, the id BattleAnim_ThrowPokeBall's first row tests.
    this.startBallAnim(0, itemId);
    this.message = undefined;
    this.messageTimer = 0;
    this.phase = "resolving";
    if (!truthy(this.anim)) this.advanceQueue();
  }

  // Which box `.SendToPC` writes into.  wCurBox is a BYTE the cart masks before
  // it ever indexes with it, so no value of it can address a box that is not
  // there; this save field holds the same number 1-based.  The mask keeps the
  // storage gate, the box-just-filled test and the insert asking about the
  // SAME box (Boxes.box answers an out-of-range index with a throwaway table).
  // Lua: BattleState.lua:3366
  currentBox(): number {
    const save = this.save;
    const index = (truthy(save) && tonumber(save.currentBox)) || 1;
    return Math.max(1, Math.min(Boxes.NUM_BOXES, Math.floor(index)));
  }

  // Lua: BattleState.lua:3372
  hasPokedex(): boolean {
    const save = this.save || {};
    return (save.engineFlags || {})[ENGINE_POKEDEX] === true
      || save.pokedexReceived === true;
  }

  // caught_data.asm:168-199
  // Lua: BattleState.lua:3379
  stampCaughtData(mon: any, bugContest?: any): void {
    const save = this.save;
    const world = truthy(this.game) ? this.game.world : undefined;
    const map = truthy(world) ? world.map : undefined;
    const battle = this.battle;
    Catching.stampCaughtData(mon, {
      version: truthy(save) ? save.version : undefined,
      save,
      data: truthy(this.game) ? this.game.data : undefined,
      bugContest,
      // Lua `a or b`: 0 is a real time of day, so truthy() rather than `||`.
      timeOfDay: truthy(battle) && truthy(battle.timeOfDay) ? battle.timeOfDay
        : (truthy(world) && truthy(world.timeOfDayId) ? world.timeOfDayId() : undefined),
      map: truthy(map) ? map.def : undefined,
      backupMap: (truthy(world) && truthy(world.backupMapId) && truthy(world.maps)
        && world.maps[world.backupMapId]) || undefined,
      playerGender: (truthy(save) && truthy(save.player) && save.player.gender) || undefined,
    } as any);
  }

  // PokeBallEffect's caught tail, in the cart's order (item_effects.asm:514-676):
  // Text_GotchaMonWasCaught, CheckCaughtMon / SetSeenAndCaughtMon, the new-entry
  // line and NewPokedexEntry, the party add or .SendToPC, then
  // AskGiveNicknameText.
  // Lua: BattleState.lua:3402
  pushCaught(enemy: any, itemId: any): any {
    const save = this.save;
    this.battle.over = true;
    this.battle.outcome = "caught";
    // PokeBallEffect's FRIEND_BALL arm: the caught mon's happiness is set to
    // FRIEND_BALL_HAPPINESS (200) instead of the base 70.  That is the ball's
    // whole effect; its catch rate is a plain ball's.  It applies on the box
    // path too (item_effects.asm:620-625).
    if (itemId === "FRIEND_BALL") {
      enemy.happiness = Catching.FRIEND_BALL_HAPPINESS;
    }
    // Text_BallCaught ends in `sound_caught_mon` (data/text/common_3.asm:260-266),
    // and TX_SOUND holds the text engine until the jingle is done
    // (home/text.asm:834-835), so the line is not dismissable under it.
    this.push({ kind: "message", sfx: SFX_CAUGHT_MON, waitSfx: true,
      text: Strings.get("Gotcha! %s was caught!", this.name(enemy)) });
    // BATTLETYPE_TUTORIAL returns before every one of the steps below
    // (`.FinishTutorial`, and `.return_from_capture: ret z`).
    if (truthy(this.tutorial) || !truthy(save)) return;
    // TryAddMonToParty and BugContest_SetCaughtContestMon both end in the same
    // wPlayerID write (item_effects.asm:548-556, :680; move_mon.asm:143-149).
    Mon.stampOT(save, enemy);
    save.pokedex = save.pokedex || { seen: {}, caught: {} };
    // CheckCaughtMon answers whether this row was ALREADY owned, and it is asked
    // before SetSeenAndCaughtMon stamps it (item_effects.asm:519-527).  Both run
    // BEFORE the `.catch_bug_contest_mon` branch, so the dex is marked even
    // though a contest mon is only being HELD.
    const knew = truthy(save.pokedex.caught[enemy.species]) ? true : false;
    save.pokedex.caught[enemy.species] = true;
    save.pokedex.seen[enemy.species] = true;
    // NewDexDataText and `predef NewPokedexEntry` both run above `.skip_pokedex`,
    // so the contest branch is BELOW them (item_effects.asm:528-546), and
    // CheckReceivedDex gates the pair (:532-533).
    if (!knew && this.hasPokedex()) {
      // data/text/common_3.asm:285
      this.push({ kind: "message",
        sfx: "Sfx_SlotMachineStart", waitSfx: true,
        text: Strings.get("%s's data was newly added to the #DEX.",
          this.name(enemy)) });
      this.push({ kind: "dex-entry", species: enemy.species });
    }
    if (truthy(this.contest)) {
      // A contest catch still exits through the `.run` arm with result WIN
      // (engine/battle/core.asm:4780-4783), so CheckPayDay runs for it too.
      this.contestCatch(enemy);
      return this.pushPayDay();
    }
    save.party = save.party || [];
    // item_effects.asm:556-558, :612-614
    this.stampCaughtData(enemy);
    const toPc = save.party.length >= Boxes.PARTY_SIZE;
    if (toPc) {
      // `.SendToPC` / `predef SendMonIntoBox` (item_effects.asm:548-550, 604):
      // a full party sends the catch to the current box.  Not Boxes.deposit,
      // which is the PC's own party-to-box move and carries the last-healthy-mon
      // and mail refusals that have nothing to do with a capture.
      const box = Boxes.box(save, this.currentBox());
      // SendMonIntoBox inserts at the HEAD (move_mon.asm:954-965, :968,
      // :1074-1085), so the catch lands in slot 1 -- which is what lets the
      // FRIEND_BALL arm write sBoxMon1Happiness unconditionally
      // (item_effects.asm:624).  Boxes.deposit stays an append.
      insertAt(box, 1, enemy);
      // SendMonIntoBox refills the boxed slot's PP before it closes SRAM
      // (move_mon.asm:1062-1063); the box_struct it writes carries no HP and no
      // status at all (macros/ram.asm:7-26).  #1696
      Boxes.enterBox(enemy);
      // `.SendToPC` re-reads sBoxCount AFTER the insert and sets
      // BATTLERESULT_BOX_FULL when the box has just filled
      // (item_effects.asm:612-619); Script_reloadmapafterbattle tests that bit
      // on the wild arm and rings the player as PHONE_BILL on the first step
      // back in the overworld (engine/overworld/scripting.asm:1097-1104).
      if (Boxes.isFull(save, this.currentBox())) {
        this.battle.boxFilled = true;
      }
    } else {
      save.party.push(enemy);
    }
    // AddPartyMon's `.registerunowndex` and SendMonIntoBox's `.not_unown` are the
    // two places the cart appends to wUnownDex, and both are on this path.  A
    // contest catch is only HELD, so it returned above without registering.
    Unown.registerCatch(save, enemy);
    // Same name and same payload keys as the Gen 1 site, so one subscription
    // covers both games: `isNew` is CheckCaughtMon's answer read BEFORE
    // SetSeenAndCaughtMon stamped it, and `destination` is which of the two
    // homes PokeBallEffect actually used.
    Runtime.emit("pokemon.caught", {
      battle: this.battle, mon: enemy, species: enemy.species,
      isNew: !knew, ball: itemId,
      destination: toPc ? "box" : "party", game: this.game,
    });
    this.push({ kind: "ask-nickname", mon: enemy });
    if (toPc) {
      // BallSentToPCText, which .SendToPC prints AFTER the nickname prompt
      // (item_effects.asm:672).
      this.push({ kind: "message",
        text: Strings.get("%s was sent to BILL's PC.", this.name(enemy)) });
    }
    this.pushPayDay();
  }

  // CheckPayDay runs on a capture too: `and $f` keeps the win arm
  // (engine/battle/core.asm:7971-7976, :8014-8042).
  // Lua: BattleState.lua:3514
  pushPayDay(): void {
    const save = this.save;
    const coins = Prize.payDay(save, this.battle.payDay, this.battle.amuletCoin);
    this.battle.payDay = undefined;
    if (truthy(coins)) {
      this.push({ kind: "message",
        text: Prize.payDayMessage(coins, truthy(save.player) ? save.player.name : undefined) });
    }
  }

  // CheckWhetherToAskSwitch: a started battle, more than one mon, no link, the
  // BATTLE_SHIFT bit CLEAR (which is SHIFT), and the active mon not fainted
  // (engine/battle/core.asm:3269-3295, engine/menus/options_menu.asm:249-256).
  // Lua: BattleState.lua:3527
  shiftOfferAllowed(): boolean {
    const battle = this.battle;
    if (truthy(this.link)) return false;
    if (!(truthy(battle) && truthy(battle.player) && truthy(battle.trainer))) return false;
    if ((battle.party || []).length < 2) return false;
    if ((battle.player.hp ?? 0) <= 0) return false;
    const options = truthy(this.game) ? this.game.options : undefined;
    return ((truthy(options) && options.battleStyle) || "SHIFT") === "SHIFT";
  }

  // OfferSwitch: Battle_GetTrainerName, the prompt, then PlaceYesNoBox
  // (engine/battle/core.asm:3298-3304, data/text/battle.asm:222-231).
  // Lua: BattleState.lua:3539
  offerShiftSwitch(mon: any): void {
    this.shiftIndex = 1;
    // HandleEnemySwitch farcalls EnemySwitch_TrainerHud before the prompt
    // (engine/battle/core.asm:2246, engine/battle/trainer_huds.asm:11-15).
    this.ballRows.enemy = true;
    const trainer = (truthy(this.battle.trainer) && this.battle.trainer.name) || "Foe";
    const player = (truthy(this.save) && truthy(this.save.player) && this.save.player.name)
      || "GOLD";
    // The `para` splits this in two (data/text/battle.asm:222-231): the incoming
    // mon is NAMED on its own page, and only the second carries the yes/no box.
    this.showPages(Strings.get(TEXT_ENEMY_ABOUT_TO_USE, trainer, this.name(mon), player));
    this.phase = truthy(this.messagePages) ? "shift-intro" : "ask-shift";
  }

  // Lua: BattleState.lua:3553
  answerUseNextMon(yes: boolean): any {
    if (yes) {
      this.phase = "forced-switch";
      this.message = Strings.get("Choose a POKéMON.");
      return;
    }
    const battle = this.battle;
    if (!truthy(battle)) {
      this.phase = "forced-switch";
      return;
    }
    const lead = truthy(battle.party) ? battle.party[0] : undefined;
    const pSpd = (truthy(lead) && truthy(lead.stats) && lead.stats.speed) || 0;
    // engine/battle/core.asm:2614
    if (truthy(battle.tryRun(pSpd))) {
      this.pushAll(battle.takeEvents());
      this.phase = "resolving";
      return this.advanceQueue();
    }
    battle.takeEvents();
    this.message = Strings.get("Can't escape!");
    this.messageTimer = MESSAGE_FRAMES;
    this.phase = "cant-escape-then-switch";
  }

  // SetUpBattlePartyMenu + PickSwitchMonInBattle (core.asm:3307-3308), which is
  // PARTYMENUACTION_SWITCH and carries no submenu; a cancel is `.canceled_switch`
  // and answers exactly like NO (:3327).
  // Lua: BattleState.lua:3581
  openShiftParty(): any {
    const stack = truthy(this.game) ? this.game.stack : undefined;
    if (!truthy(stack)) {
      this.phase = "resolving";
      return this.advanceQueue();
    }
    this.phase = "submenu";
    let list: any;
    list = Screens.push(this.game, "Gen2PartyMenu", {
      prompt: "which",
      battle: true,
      onCancel: () => {
        stack.pop();
        this.phase = "resolving";
        this.advanceQueue();
      },
      onChoose: (index: number, mon: any) => {
        // SwitchMonAlreadyOut (core.asm:2864)
        let refused: boolean | undefined;
        let key: any;
        let arg: any;
        if (mon === this.battle.player) {
          refused = true; key = TEXT_ALREADY_OUT; arg = this.name(mon);
        } else if (truthy(mon.isEgg)) {
          refused = true; key = TEXT_EGG_CANT_BATTLE;
        } else if ((mon.hp ?? 0) <= 0) {
          refused = true;
        }
        if (refused) {
          if (truthy(list)) {
            return list.refuse(Strings.get(key ?? TEXT_NO_WILL_TO_FIGHT, arg));
          }
          stack.pop();
          return this.refuseShift(key, arg);
        }
        stack.pop();
        this.shiftSwitchIndex = index;
        this.phase = "resolving";
        this.advanceQueue();
      },
    });
  }

  // PickSwitchMonInBattle loops on carry the way BattleMenuPKMN_Loop does
  // (engine/battle/core.asm:2716-2728).
  // Lua: BattleState.lua:3624
  refuseShift(source?: any, ...args: any[]): void {
    this.phase = "refuse-shift";
    this.message = Strings.get(source ?? TEXT_NO_WILL_TO_FIGHT, ...args);
    this.messageTimer = MESSAGE_FRAMES;
  }

  // AskGiveNicknameText + YesNoBox (item_effects.asm:566-578).  B is the NO arm
  // (`jp c, .return_from_capture`), which leaves the species name standing.
  // Lua: BattleState.lua:3632
  askNickname(mon: any): void {
    this.nicknameMon = mon;
    // YesNoBox opens on YES; YesNoMenuHeader sets no STATICMENU_DISABLE_B.
    this.nicknameIndex = 1;
    this.phase = "ask-nickname";
    this.message = Strings.get("Give a nickname to %s?", this.name(mon));
    this.messageTimer = MESSAGE_FRAMES;
  }

  // One prompt page in the box, with the rest held for the presses `para` and
  // `cont` wait on (home/text.asm:403-448).  paginate / foldPages (part one)
  // return the Lua's two values as [pages, carried]; `carried` keeps the Lua's
  // 1-based page numbers as keys, as messagePage does.
  // Lua: BattleState.lua:3643
  showPages(text: any): void {
    const [rawPages, rawCarried] = paginate(text);
    const [pages, carried] = foldPages(rawPages, rawCarried);
    this.messagePages = pages.length > 1 ? pages : undefined;
    this.messageCarried = carried;
    this.messagePage = 1;
    this.message = pages[0];
    this.messageCarry = undefined;
    this.messageTimer = MESSAGE_FRAMES;
  }

  // Lua: BattleState.lua:3653
  nextPage(): boolean {
    const pages = this.messagePages;
    if (!truthy(pages)) return false;
    const i = this.messagePage + 1;
    this.messagePage = i;
    this.message = pages[i - 1];
    this.messageCarry = truthy(this.messageCarried) && truthy(this.messageCarried[i])
      ? pages[i - 1] : undefined;
    this.messageTimer = MESSAGE_FRAMES;
    if (i >= pages.length) {
      this.messagePages = undefined;
      // ../pokecrystal/engine/battle/core.asm:3146-3147
      const pending = this.pendingSendOut;
      if (truthy(pending)) {
        this.pendingSendOut = undefined;
        this.startSendOut(pending.side, pending.mon);
      }
    }
    return true;
  }

  // ForgetMove's AskForgetMoveText + YesNoBox (engine/pokemon/learn.asm:123-127);
  // LearnMove's `jp c, .loop` reprints the whole text, so this is the loop head.
  // Lua: BattleState.lua:3676
  askForget(): any {
    if (!truthy(this.pendingLearn)) return this.advanceQueue();
    this.forgetIndex = 1;
    this.forgetChoice = 1;
    const party = (truthy(this.battle) && this.battle.party) || [];
    const name = this.name(party[this.pendingLearn.index - 1]);
    const moveName = this.pendingLearn.moveName || "?";
    this.showPages(Strings.get(TEXT_ASK_FORGET_MOVE, name, moveName, name, moveName));
    this.phase = truthy(this.messagePages) ? "learn-intro" : "ask-forget";
  }

  // LearnMove's .cancel: StopLearningMoveText, and a NO is `jp c, .loop`
  // (engine/pokemon/learn.asm:104-108).
  // Lua: BattleState.lua:3689
  askStopLearning(): any {
    if (!truthy(this.pendingLearn)) return this.advanceQueue();
    this.forgetChoice = 1;
    this.phase = "stop-learning";
    this.showPages(Strings.get(TEXT_STOP_LEARNING, this.pendingLearn.moveName || "?"));
  }

  // DidNotLearnMoveText, then `ld b, 0` and back to the queue (learn.asm:110-113).
  // Lua: BattleState.lua:3697
  finishDecline(): void {
    const learn = this.pendingLearn;
    this.pendingLearn = undefined;
    this.phase = "resolving";
    if (truthy(learn)) this.battle.declineForget(learn.index, learn.moveName);
    this.pushFront(this.battle.takeEvents());
    this.advanceQueue();
  }

  // Lua: BattleState.lua:3706
  answerForgetPrompt(yes: boolean): any {
    if (this.phase === "ask-forget") {
      if (!yes) return this.askStopLearning();
      // MoveAskForgetText over the four-slot list (learn.asm:135-146).
      this.forgetIndex = 1;
      this.phase = "choose-forget";
      this.message = Strings.get(TEXT_ASK_FORGET_SLOT);
      this.messageTimer = 0;
      return;
    }
    if (yes) return this.finishDecline();
    return this.askForget();
  }

  // Lua: BattleState.lua:3720
  answerNickname(yes: boolean): any {
    const mon = this.nicknameMon;
    this.nicknameMon = undefined;
    this.phase = "resolving";
    const stack = truthy(this.game) ? this.game.stack : undefined;
    if (!(yes && truthy(mon) && truthy(stack))) return this.advanceQueue();
    this.phase = "submenu";
    const data = (truthy(this.game) && this.game.data) || {};
    const icons = data.gen2Icons;
    const iconId = truthy(icons) && truthy(icons.species) ? icons.species[mon.species] : undefined;
    const entry = truthy(iconId) && truthy(icons.icons) ? icons.icons[iconId] : undefined;
    const done = (name: any): void => {
      stack.pop();
      // InitName: an empty entry keeps whatever was already in the buffer, which
      // for a fresh capture is the species name.
      if (truthy(name) && name.length > 0) mon.nickname = name;
      this.phase = "resolving";
      this.advanceQueue();
    };
    Screens.push(this.game, "Gen2NamingScreen", {
      type: "nickname",
      monName: mon.name || mon.species,
      iconPath: (truthy(entry) && entry.image) || undefined,
      menuGfx: data.gen2MenuGfx,
      onDone: done,
      onCancel: () => { done(undefined); },
    });
  }

  // BugContest_SetCaughtContestMon (engine/events/bug_contest/caught_mon.asm).
  // With nothing in stock the catch is kept outright (`.firstcatch`); with a mon
  // already in stock the player is shown the comparison and asked, and the NO arm
  // -- which is also what B does -- keeps the mon they already had.
  // Lua: BattleState.lua:3753
  contestCatch(mon: any): void {
    // engine/pokemon/caught_data.asm:72-81
    this.stampCaughtData(mon, true);
    const [kind, stock, fresh] = BugContest.catch(this.save, mon);
    if (kind !== BugContest.ASK_SWITCH) {
      this.push({ kind: "message",
        text: Strings.get("Caught %s!", this.name(mon)) });
      return;
    }
    this.push({ kind: "message",
      text: Strings.get("You already caught a %s.", this.name(stock)) });
    this.push({ kind: "contest-switch", stock, caught: fresh });
  }

  // Lua: BattleState.lua:3767
  openContestSwitch(event: any): any {
    const stack = truthy(this.game) ? this.game.stack : undefined;
    if (!truthy(stack)) return this.advanceQueue();
    this.phase = "submenu";
    Screens.push(this.game, "Gen2ContestMenu", {
      save: this.save,
      stock: event.stock,
      caught: event.caught,
      onClose: () => {
        stack.pop();
        this.phase = "resolving";
        this.advanceQueue();
      },
    });
  }

  // NewPokedexEntry: the dex opens straight on the new species' entry and pages
  // twice (engine/pokedex/new_pokedex_entry.asm:19-23).
  // Lua: BattleState.lua:3785
  openDexEntry(species: any): any {
    const stack = truthy(this.game) ? this.game.stack : undefined;
    const dex = ((truthy(this.game) && this.game.data) || {}).gen2Pokedex;
    const entry = truthy(dex) && truthy(dex.entries) ? dex.entries[species] : undefined;
    if (!(truthy(stack) && truthy(entry))) return this.advanceQueue();
    this.phase = "submenu";
    Screens.push(this.game, "Gen2PokedexMenu", {
      entrySpecies: species,
      newEntry: true,
      onClose: () => {
        stack.pop();
        this.phase = "resolving";
        this.advanceQueue();
      },
    });
  }

  // Lua: BattleState.lua:3802
  catchOptions(itemId: any): any {
    const data = (truthy(this.game) && this.game.data) || {};
    const battle = this.battle;
    const enemy = truthy(battle) ? battle.enemy : undefined;
    if (!truthy(enemy)) return undefined;
    const enemyDef = truthy(data.pokemon) ? data.pokemon[enemy.species] : undefined;
    const dexEntry = truthy(data.gen2Pokedex) ? data.gen2Pokedex[enemy.species] : undefined;
    let evolveItem: any;
    for (const entry of (truthy(enemyDef) && enemyDef.evolutions) || []) {
      if (entry.method === "EVOLVE_ITEM") evolveItem = entry.item;
    }
    const player = battle.player;
    return {
      battle, mon: enemy, def: enemyDef,
      maxHp: truthy(enemy.maxHp) ? enemy.maxHp : (truthy(enemy.stats) ? enemy.stats.hp : undefined),
      hp: enemy.hp,
      catchRate: (truthy(enemyDef) && truthy(enemyDef.catchRate)) ? enemyDef.catchRate : 45,
      ball: itemId,
      status: enemy.status, random: battle.random,
      weight: truthy(dexEntry) ? dexEntry.weight : undefined, level: enemy.level,
      playerLevel: truthy(player) ? player.level : undefined,
      fishing: battle.battleType === Battle.BATTLETYPE_FISH,
      species: enemy.species,
      gender: enemy.gender, playerSpecies: truthy(player) ? player.species : undefined,
      playerGender: truthy(player) ? player.gender : undefined, evolveItem,
    };
  }

  // Lua: BattleState.lua:3828
  catchChance(itemId: any): number | undefined {
    if (truthy(this.tutorial)) return 100;
    const opts = this.catchOptions(itemId);
    return truthy(opts) ? Catching.chance(opts) : undefined;
  }

  // Items in battle: balls try a catch, the stat items apply their stage, and
  // everything with a ported party effect runs the same item_effects.asm routine
  // the field pack runs.  Anything else reports that it cannot be used, which is
  // what the cart does for a key item.
  // Lua: BattleState.lua:3838
  useItem(itemId: any): any {
    const data = (truthy(this.game) && this.game.data) || {};
    const def = truthy(data.items) ? data.items[itemId] : undefined;
    const pocket = truthy(def) ? def.pocket : undefined;
    const save = this.save;

    if (pocket === "BALL") {
      // `ld a, [wBattleMode] / dec a / jp nz, UseBallInTrainerBattle`, the very
      // first thing PokeBallEffect does.
      if (!truthy(this.battle.wild)) {
        return this.throwBallAtTrainer(itemId);
      }
      // The storage gate, before the ball is spent and before the rate is
      // computed (item_effects.asm:217-226): a full party AND a full current box
      // takes Ball_BoxIsFullMessage, which writes wItemEffectSucceeded = 2 --
      // "item wasn't used" -- so neither the ball nor the turn goes.
      if (((truthy(save) && save.party) || []).length >= Boxes.PARTY_SIZE
          && Boxes.isFull(save, this.currentBox())) {
        // BallBoxFullText (data/text/common_3.asm:427).
        this.message = Strings.get("The POKéMON BOX is full. That can't be used now.");
        this.messageTimer = MESSAGE_FRAMES;
        this.phase = "resolving";
        return;
      }
      const enemy = this.battle.enemy;
      let caught: boolean;
      let rate: number | undefined;
      if (truthy(this.tutorial)) {
        // `ld a, [wBattleType] / cp BATTLETYPE_TUTORIAL /
        // jp z, .catch_without_fail`, checked BEFORE the Master Ball and before
        // the rate is ever computed.  The tail then returns early for a tutorial
        // battle (`.return_from_capture: ret z`), which is why the DUDE's
        // RATTATA is not added to a party, not written to the Pokedex and not
        // registered in wUnownDex, and why the ball is not tossed out of the
        // bag: the bag it came from was never the player's.  The THROW still
        // happens: `.catch_without_fail` falls into the shared animation.
        caught = true;
        rate = 255;
      } else {
        // The specialty-ball conditions (BallMultiplierFunctionTable): each one
        // is also used by the read-only preview, so both paths stay exact.
        [caught, rate] = Catching.attempt(this.catchOptions(itemId));
      }
      // wWildMon carries the answer through the animation, and
      // wThrownBallWobbleCount is the counter GetPokeBallWobble bumps once per
      // wobble -- which is what the failure line is picked from afterwards.
      this.ballThrow = { caught, rate: rate ?? 0, wobble: 0 };
      // A PARK BALL is never in the bag: PokeBallEffect's `.used_park_ball` does
      // `dec [hl]` on wParkBallsRemaining instead of tossing an item, so the
      // contest takes its ball off the counter and leaves the pack alone.  The
      // tutorial spends nothing at all (`.return_from_capture: ret z`).
      if (!truthy(this.tutorial)) {
        if (truthy(this.contest)) {
          if (!caught) BugContest.useBall(save);
        } else {
          this.consumeItem(itemId);
        }
      }
      this.queue = [];
      if (caught) {
        this.pushCaught(enemy, itemId);
      } else {
        // Resolved at drain time, because which of the four lines it is depends
        // on how far the wobble counter got inside the animation.
        this.push({ kind: "ball-result" });
        // A failed ball still costs the turn.
        this.pushAll(this.battle.takeTurn({ kind: "item", item: itemId }));
        // CheckContestBattleOver: the throw that empties the counter turns the
        // battle into a DRAW there and then, which is what sends the player back
        // to the gate instead of into the next patch of grass.
        if (truthy(this.contest) && BugContest.isOver(save)) {
          this.battle.over = true;
          this.battle.outcome = "draw";
        }
      }
      // item_effects.asm:405-412: wBattleAnimParam from wCurItem, hBattleTurn 0,
      // wThrownBallWobbleCount 0, then `predef PlayBattleAnim`.  Everything
      // pushed above is drained only once the ball has finished wobbling.
      this.startBallAnim(this.ballAnimParam(itemId), itemId);
      if (caught && !truthy(this.anim)) this.picHidden.enemy = true;
      this.message = undefined;
      this.messageTimer = 0;
      this.phase = "resolving";
      if (!truthy(this.anim)) this.advanceQueue();
      return;
    }

    // The battle stat items (XItemEffect, XAccuracyEffect, DireHitEffect,
    // GuardSpecEffect): the engine applies the stage or the substatus bit and
    // this side spends the item and the turn.  A refused re-use
    // (WontHaveAnyEffect_NotUsedMessage) costs neither.
    if (truthy(Battle.X_ITEM_STATS[itemId]) || truthy(Battle.SUBSTATUS_ITEMS[itemId])) {
      const [ok] = this.battle.useBattleItem(itemId);
      if (!truthy(ok)) {
        // _ItemWontHaveEffectText's own `line` break, the same one
        // ItemEffects.TEXT_NO_EFFECT carries (data/text/common_3.asm).
        this.message = Strings.get(ItemEffects.TEXT_NO_EFFECT);
        this.messageTimer = MESSAGE_FRAMES;
        this.phase = "resolving";
        return;
      }
      if (truthy(save) && truthy(save.inventory)) {
        save.inventory[itemId] = Math.max(0, (save.inventory[itemId] ?? 1) - 1);
        if (save.inventory[itemId] === 0) delete save.inventory[itemId];
      }
      this.queue = [];
      this.pushAll(this.battle.takeEvents());
      this.pushAll(this.battle.takeTurn({ kind: "item", item: itemId }));
      this.phase = "resolving";
      this.advanceQueue();
      return;
    }

    // BattlePack's .ItemFunctionJumptable (engine/items/pack.asm): its first
    // four entries are all .Oak, so an item that is ITEMMENU_NOUSE in a battle
    // does nothing there at all.  The gate has to sit here rather than in the
    // pack, because the battle pack has no field-menu filter of its own and the
    // two nibbles disagree: a RARE CANDY is ITEMMENU_PARTY in the FIELD and
    // would otherwise level a mon mid-fight, and a BITTER BERRY is the reverse.
    if (!(truthy(def) && def.battleMenu === "ITEMMENU_NOUSE")) {
      // BitterBerryEffect: its whole effect is a battle substatus, so it has no
      // field row for ItemEffects to carry and it never opens the party list.
      if (itemId === "BITTER_BERRY") {
        return this.cureBattleConfusion(itemId);
      }
      // Everything else the pack can spend on a party mon runs the same
      // item_effects.asm routine the field pack runs: the potion line and the
      // drinks, the status cures and their berries, REVIVE / MAX REVIVE, and
      // the ETHER / ELIXER family.
      const action = ItemEffects.partyAction(itemId, truthy(this.game) ? this.game.data : undefined);
      if (truthy(action)) {
        return this.useOnPartyMon(itemId, action);
      }
    }

    this.message = Strings.get("That isn't going to help here.");
    this.messageTimer = MESSAGE_FRAMES;
    this.phase = "resolving";
  }

  // UseItem_SelectMon (engine/items/item_effects.asm): every party-target item
  // picks its mon FIRST, so a benched mon can be healed, cured or stood back up
  // mid-battle -- ItemRestoreHP, StatusHealingEffect, ReviveEffect and
  // RestorePPEffect all open the list before they do anything.  Backing out is
  // the .SelectMon carry path: back to the pack with nothing spent.
  // Lua: BattleState.lua:3984
  useOnPartyMon(itemId: any, action: any): any {
    const stack = truthy(this.game) ? this.game.stack : undefined;
    if (!truthy(stack)) {
      return this.applyPartyItem(itemId, action, this.battle.player);
    }
    this.phase = "submenu";
    Screens.push(this.game, "Gen2PartyMenu", {
      prompt: "useItem",
      battle: true,
      party: this.battle.party || (truthy(this.save) ? this.save.party : undefined),
      onCancel: () => {
        stack.pop();
        this.openPack();
      },
      onChoose: (partySlot: number, mon: any) => {
        // RestorePPEffect: the ETHER pair needs the move pick first, the ELIXER
        // pair walks every slot without one, and an EGG refuses before the move
        // list ever opens (UseItem_SelectMon's `cp EGG`).
        const row: any = action === "pp" ? ItemEffects.RESTORE_PP[itemId] : undefined;
        if (truthy(row) && !truthy(row.each) && truthy(mon) && !truthy(mon.isEgg)) {
          return this.pickMoveForItem(itemId, mon, partySlot);
        }
        this.applyPartyItem(itemId, action, mon, undefined, partySlot);
      },
    });
  }

  // RestorePPEffect's "Restore the PP of which move?" pick.  MoveSelectionScreen
  // and ChooseMoveToDelete are the same SetUpMoveList box on the cart, so the
  // port serves both with MoveDeleter.  Backing out drops only the move list and
  // leaves the party list standing, which is the routine's own `jr nz, .loop`.
  // Lua: BattleState.lua:4016
  pickMoveForItem(itemId: any, mon: any, partySlot: any): void {
    const stack = this.game.stack;
    Screens.push(this.game, "Gen2MoveDeleter", {
      mon,
      moves: truthy(this.game.data) ? this.game.data.moves : undefined,
      onCancel: () => { stack.pop(); },
      onChoose: (slot: number) => {
        stack.pop(); // the move list
        this.applyPartyItem(itemId, "pp", mon, slot, partySlot);
      },
    });
  }

  // BitterBerryEffect: it reads wPlayerSubStatus3 straight off, so it acts on
  // whoever is out and a mon that is not confused refuses without spending
  // anything.  UseItemText falls through into UseDisposableItem, so a cure does
  // cost the berry.
  // Lua: BattleState.lua:4033
  cureBattleConfusion(itemId: any): void {
    const mon = this.battle.player;
    const state = truthy(mon) ? this.battle.volatile(mon) : undefined;
    if (!(truthy(state) && truthy(state.confuseCount))) {
      this.message = oneLine(Strings.get(ItemEffects.TEXT_NO_EFFECT));
      this.messageTimer = MESSAGE_FRAMES;
      this.phase = "resolving";
      return;
    }
    state.confuseCount = undefined;
    this.consumeItem(itemId);
    this.queue = [];
    // ConfusedNoMoreText (data/text/battle.asm).
    this.push({ kind: "message",
      text: Strings.get("%s's confused no more!", this.name(mon)) });
    this.pushAll(this.battle.takeTurn({ kind: "item", item: itemId }));
    this.phase = "resolving";
    this.advanceQueue();
  }

  // UseDisposableItem: one copy leaves the pack, and only on a success -- every
  // refusal above returns before this.
  // Lua: BattleState.lua:4055
  consumeItem(itemId: any): void {
    const save = this.save;
    if (!(truthy(save) && truthy(save.inventory))) return;
    save.inventory[itemId] = Math.max(0, (save.inventory[itemId] ?? 1) - 1);
    if (save.inventory[itemId] === 0) delete save.inventory[itemId];
  }

  // The effect itself.  ItemEffects owns the item_effects.asm arithmetic and
  // every refusal it prints (an EGG, a fainted or full-HP heal target, a healthy
  // revive target, a PP slot already full); this side adds the arm that only
  // exists with a battle up, spends the item where UseDisposableItem sits, and
  // pays the turn the pack costs.
  // Lua: BattleState.lua:4067
  applyPartyItem(itemId: any, action: any, mon: any, slot?: any, partySlot?: any): void {
    const data = (truthy(this.game) && this.game.data) || {};
    const stack = truthy(this.game) ? this.game.stack : undefined;
    let menu = truthy(stack) && truthy(stack.top) ? stack.top() : undefined;
    if (!(truthy(menu) && truthy(menu.showItemResult))) menu = undefined;
    const before = (truthy(mon) && mon.hp) || 0;
    let result: any;
    if (action === "pp") {
      result = ItemEffects.usePpItem(itemId, mon, slot, data);
    } else {
      result = ItemEffects.useOnMon(itemId, mon, data);
    }
    // HealStatus's `.not_full_heal` and IsItemUsedOnConfusedMon: a $ff-mask item
    // used on whoever is OUT also clears SUBSTATUS_CONFUSED, and clears it even
    // when the status byte was already empty -- which is the one case where a
    // FULL HEAL that the field routine refuses is still spent in battle.
    if (truthy(mon) && truthy(FULL_MASK_HEALERS[itemId]) && mon === this.battle.player
        && truthy(this.battle.volatile(mon).confuseCount)) {
      this.battle.volatile(mon).confuseCount = undefined;
      if (!truthy(result.used)) {
        // PARTYMENUTEXT_HEAL_CONFUSION (_CameToItsSensesText).
        result = { used: true,
          text: Strings.get("%s came to its senses.", this.name(mon)) };
      }
    }
    if (!truthy(result.used)) {
      if (truthy(menu)) stack.pop();
      this.message = oneLine(result.text);
      this.messageTimer = MESSAGE_FRAMES;
      this.phase = "resolving";
      return;
    }
    this.consumeItem(itemId);
    if (truthy(menu)) {
      // engine/items/item_effects.asm:1671
      const climbs = (action === "heal" || action === "revive")
        && truthy(mon) && (mon.hp ?? 0) !== before;
      if (climbs) {
        // engine/items/item_effects.asm:1659
        this.stopAlarm();
        this.healSilence = true;
      }
      menu.showItemResult(partySlot, {
        fromHp: climbs ? before : undefined,
        toHp: climbs ? mon.hp : undefined,
        sfx: climbs ? "Sfx_Potion" : undefined,
        text: result.text,
        onDone: () => {
          stack.pop();
          this.finishPartyItemTurn(itemId, mon);
        },
      });
      return;
    }
    this.queue = [];
    if (mon === this.battle.player && (mon.hp ?? 0) !== before) {
      // Every HP-restoring effect zeroes wLowHealthAlarm BEFORE it touches the
      // HP or runs HealHP_SFX_GFX (RestoreHPEffect, engine/items/item_effects.asm:
      // 1657-1658; .FullRestore :1580-1581; .skip_to_revive :1542-1543), so the
      // siren dies with the item rather than with the bar animation.  Not a
      // latch: CheckDanger runs again from UpdatePlayerHUD once AnimateHPBar has
      // finished, so a heal that leaves the mon in the red restarts the siren.
      this.stopAlarm();
      this.healSilence = true;
      // The active mon's HP change carries its new value so the HUD bar refills
      // on screen (HealHP_SFX_GFX runs AnimateHPBar for exactly this case).
      this.push({ kind: "heal", side: "player", hp: mon.hp,
        text: oneLine(result.text) });
    } else {
      this.push({ kind: "message", text: oneLine(result.text) });
    }
    this.pushAll(this.battle.takeTurn({ kind: "item", item: itemId }));
    this.phase = "resolving";
    this.advanceQueue();
  }

  // engine/items/item_effects.asm:1671
  // Lua: BattleState.lua:4145
  finishPartyItemTurn(itemId: any, mon: any): void {
    this.queue = [];
    if (truthy(mon) && mon === this.battle.player && truthy(this.shownHp)) {
      this.shownHp.player = mon.hp ?? 0;
      if (truthy(this.hpAnim) && this.hpAnim.side === "player") this.hpAnim = undefined;
    }
    this.pushAll(this.battle.takeTurn({ kind: "item", item: itemId }));
    this.phase = "resolving";
    this.advanceQueue();
  }

  // The HUD is not a box: engine/battle/core.asm draws an L-shaped frame out of
  // four tiles (DrawEnemyHUDBorder / DrawPlayerHUDBorder) -- a horizontal rule
  // under the whole thing with a short vertical stub at one end, opening left for
  // the enemy and right for the player.  Name and level sit on plain background
  // above it, not inside a border.
  // Lua: BattleState.lua:4161
  drawFrame(tx: number, ty: number, width: number, stubRight?: boolean): void {
    // home/fade.asm:35 (RotateThreePalettesRight)
    const ink = GbcPalette.color(GbcPalette.DMG_SHADES as any, 4) ?? [0, 0, 0];
    G.setColor(ink[0]! / 255, ink[1]! / 255, ink[2]! / 255, 1);
    // The bottom rule ($76 repeated, capped by $74/$78 or $6f/$77) sits at the
    // top of its own tile row, immediately under the bar above it.
    G.rectangle("fill", tx * 8, ty * 8, width * 8, 2);
    // The vertical stub ($6d on the enemy's left, $73 on the player's right)
    // climbs from the rule past the bar row.
    const stubX = stubRight ? ((tx + width - 2) * 8 + 6) : (tx * 8);
    G.rectangle("fill", stubX, ty * 8 - 8, 2, 10);
    G.setColor(1, 1, 1, 1);
  }

  // LoadBattleFontsHPBar puts FontBattleExtra in the $60 slot for the whole
  // battle, which is why the HUD's level reads as the bold ":L" glyph ($6e) and
  // not the two characters ':' and 'L'.  The message box below is ordinary text,
  // so the swap is scoped to the HUD.
  // Which mon a side DRAWS.  Battle finishes the whole turn before the first
  // message is displayed, so battle.enemy is already the replacement while the
  // outgoing mon's "fainted!" line is still on screen; the queue's own copy is
  // what keeps the pic and the name where the cart has them.
  // Lua: BattleState.lua:4184
  activeMon(side: string): any {
    const shown = truthy(this.shownMon) ? this.shownMon[side] : undefined;
    if (shown != null) return shown;
    return (truthy(this.battle) && this.battle[side]) || undefined;
  }

  // Lua: BattleState.lua:4190
  drawHud(): void {
    const wasBattle = Font.useBattleExtra(true);
    this.drawEnemyHud();
    this.drawPics();
    this.drawPlayerHud();
    Font.useBattleExtra(wasBattle);
  }

  // Lua: BattleState.lua:4198
  drawPics(): void {
    this.drawPic(this.activeMon("enemy"), false);
    this.drawPic(this.activeMon("player"), true);
  }

  // Lua: BattleState.lua:4203
  drawEnemyHud(): void {
    const wasBattle = Font.useBattleExtra(true);
    const enemy = this.activeMon("enemy");
    const showStatus = this.statusHUDVisible();

    // Enemy HUD (DrawEnemyHUD clears (1,0) 4 rows x 11 cols):
    //   name at (1,0); PrintLevel at (6,1) with the gender symbol at (9,1);
    //   the HP bar's "HP:" at (2,2); the border from (1,2).
    // ClearActorHud blanks this whole block while that side's move animation
    // runs, so a shake or a slide does not drag the HP bar with it.
    // And nothing at all before UpdateEnemyHUD has ever run: the intro bands
    // slide in over a blanked tilemap (core.asm:8554/8564).
    if (truthy(showStatus) && truthy(this.showEnemyHud) && !truthy(this.hudCleared("enemy"))) {
      Chrome.printThrough(this.name(enemy), 1, 0, Chrome.DEFAULT_BOX_PALETTE as any);
      // PrintLevel writes <LV> at the coordinate it is given and then LEFT-aligns
      // the digits after it, so the glyph is pinned to column 6 whether the level
      // is 5 or 100; only a three-digit level moves, and it does so by eating the
      // <LV> tile.  The gender symbol sits past the two digit columns, at (9,1).
      // PlaceNonFaintStatus (engine/pokemon/mon_stats.asm): a statused mon's tag
      // prints where the level goes, and DrawEnemyHUD's `.skip_level` arm drops
      // the level entirely while one is up.
      Chrome.printThrough(this.statusTag(enemy, "enemy")
        ?? ("<LV>" + tostring(enemy.level ?? 1)), 6, 1, Chrome.DEFAULT_BOX_PALETTE as any);
      const enemyGender = this.genderSymbol(enemy);
      if (truthy(enemyGender)) {
        Chrome.printThrough(enemyGender!, 9, 1, Chrome.DEFAULT_BOX_PALETTE as any);
      }
      // `ld a, [wBattleMode] / dec a / ret nz`, then CheckCaughtMon puts $5d at
      // (1,1) (engine/battle/trainer_huds.asm:140-152).
      if (truthy(this.battle) && truthy(this.battle.wild) && truthy(this.caughtMark)) {
        this.hud.drawCaughtIcon(1, 1, this.hudHp(enemy, "enemy"),
          truthy(enemy.maxHp) ? enemy.maxHp : (truthy(enemy.stats) ? enemy.stats.hp : undefined));
      }
      this.drawHpBar(enemy, "enemy", 2, 2);
      // Stub on the LEFT (tile $6d), rule on the row under the bar.
      if (this.hud.available()) {
        this.hud.drawEnemyFrame();
      } else {
        this.drawFrame(1, 3, 10, false);
      }
    }
    // ShowOTTrainerMonsRemaining (engine/battle/trainer_huds.asm:32-45): balls
    // walking LEFT from OAM (72, 32), which the -8/-16 offset puts at (8, 2).
    if (truthy(showStatus) && truthy(this.ballRows.enemy)) {
      if (!truthy(this.showEnemyHud) && this.hud.available()) {
        this.hud.drawEnemyFrame();
      }
      this.hud.drawBallRow(truthy(this.battle) ? this.battle.enemyParty : undefined, 8, 2, -1);
    }
    Font.useBattleExtra(wasBattle);
  }

  // Lua: BattleState.lua:4255
  drawPlayerHud(): void {
    const wasBattle = Font.useBattleExtra(true);
    const player = this.activeMon("player");
    const showStatus = this.statusHUDVisible();
    // ShowPlayerMonsRemaining (engine/battle/trainer_huds.asm:17-30): balls
    // walking RIGHT from OAM (96, 96), i.e. tile (11, 10).
    if (truthy(showStatus) && truthy(this.ballRows.player)) {
      if (!truthy(this.showPlayerHud) && this.hud.available()) {
        this.hud.drawPartyIconFrame();
      }
      this.hud.drawBallRow(truthy(this.battle) ? this.battle.party : undefined, 11, 10, 1);
    }
    // No player HUD in the catching tutorial: DrawPlayerHUD lives in
    // SendOutPlayerMon, which BATTLETYPE_TUTORIAL jumps straight over, and
    // BattleMenu's own tutorial arm skips UpdateBattleHuds as well.  The DUDE's
    // half of the screen is his back-pic and nothing more.
    // Nor before SendOutPlayerMon's own UpdatePlayerHUD (core.asm:3838).
    if (!truthy(showStatus) || !truthy(player) || !truthy(this.showPlayerHud)
        || truthy(this.hudCleared("player"))) {
      Font.useBattleExtra(wasBattle);
      return;
    }
    Chrome.printThrough(this.name(player), 10, 7, Chrome.DEFAULT_BOX_PALETTE as any);
    // PrintPlayerHUD places the same status tag at (14,8) and skips the level
    // while it is up.
    Chrome.printThrough(this.statusTag(player, "player")
      ?? ("<LV>" + tostring(this.shownLevel ?? player.level ?? 1)), 14, 8,
      Chrome.DEFAULT_BOX_PALETTE as any);
    const playerGender = this.genderSymbol(player);
    if (truthy(playerGender)) {
      Chrome.printThrough(playerGender!, 17, 8, Chrome.DEFAULT_BOX_PALETTE as any);
    }
    this.drawHpBar(player, "player", 10, 9);
    const maxHp = (truthy(player.maxHp) ? player.maxHp
      : (truthy(player.stats) ? player.stats.hp : undefined)) ?? 0;
    Chrome.printRightThrough(format("%d/%d", this.hudHp(player, "player"), maxHp),
      18, 10, Chrome.DEFAULT_BOX_PALETTE as any);
    // Stub on the RIGHT (tile $73), border from (18,10) laid leftward, exp bar
    // at (10,11).
    // The chased fill, not the mon's: AnimateExpBar crawls it, and reading the
    // mon straight put the bar at its post-kill value before the "gained N EXP.
    // Points!" line was even on screen.
    const expFraction = (this.shownExp ?? 0) / BattleHud.EXP_LENGTH_PX;
    if (this.hud.available()) {
      this.hud.drawPlayerFrame();
      // Eight tiles at (10,11); FillInExpBar's own span.
      this.hud.drawExpBar(expFraction, 10, 11);
    } else {
      this.drawFrame(9, 11, 10, true);
      HpBar.drawExp(expPainter, this.palettes, expFraction, 10 * 8, 11 * 8 + 4);
    }
    Font.useBattleExtra(wasBattle);
  }

  // Lua: BattleState.lua:4317
  statusTag(mon: any, side: string): string | undefined {
    const status = truthy(mon) ? this.hudStatus(mon, side) : undefined;
    if (!truthy(status)) return undefined;
    const data = (truthy(this.game) && this.game.data)
      || (truthy(this.battle) && this.battle.data) || undefined;
    const merged = truthy(data) ? data.gen2Statuses : undefined;
    const authored = truthy(merged) ? merged[status] : undefined;
    const record: any = truthy(authored) ? authored : Battle.STATUSES[status];
    // SUBSTATUS_CONFUSED and any modded equivalent are battle volatiles, not
    // the major status byte PlaceNonFaintStatus draws in the HUD.
    if (truthy(record) && truthy(record.substatus)) return undefined;
    // Builtins.registerStatusesInto seeds gen2Statuses from Battle.STATUSES at
    // boot with no mod installed, so `authored` alone does not mean a real mod
    // wrote this record: an UNTOUCHED status's merged record is the exact same
    // table Battle.STATUSES holds, and its label still needs Strings(); a real
    // mod's record is a NEW table and is already complete authored content.
    if (truthy(authored)) {
      if (authored === Battle.STATUSES[status]) {
        return Strings.get(authored.hudLabel || authored.label);
      }
      return authored.hudLabel || authored.label;
    }
    const tag = STATUS_TAGS[status];
    return truthy(tag) ? Strings.get(tag) : undefined;
  }

  // ♂ / ♀ after the level, or nil for a genderless species (PrintPlayerHUD
  // writes a plain space in that case).
  // Lua: BattleState.lua:4351
  genderSymbol(mon: any): string | undefined {
    const gender = truthy(mon) ? mon.gender : undefined;
    if (gender === "male") return "♂";
    if (gender === "female") return "♀";
    return undefined;
  }

  // The growth record for a mon's species, for the exp bar's "how far to the next
  // level" fraction.
  // Lua: BattleState.lua:4360
  growthOf(mon: any): any {
    // pokecrystal/engine/battle/core.asm:7151
    const def = truthy(this.pokemon) && truthy(mon) ? this.pokemon[Mon.partySpecies(mon)] : undefined;
    if (!truthy(def)) return undefined;
    // Mon.growthFor off the LIVE game.data, so the exp bar's fraction is drawn
    // against the very curve Mon.gainExperience just used.  The {pokemon=}
    // fallback is for a screen built with no game (drivers, tests).
    const data = (truthy(this.game) && this.game.data) || { pokemon: this.pokemon };
    return Mon.growthFor(data, def.growthRate);
  }

  // The four labels the battle menu draws.  Inside the contest the third one
  // carries the park ball count, which .PrintParkBallsRemaining writes with
  // PRINTNUM_LEADINGZEROS over two digits.
  // Lua: BattleState.lua:4376
  menuLabels(): string[] {
    if (!truthy(this.contest)) {
      return [Strings.get(MENU[0]), Strings.get(MENU[1]),
        Strings.get(MENU[2]), Strings.get(MENU[3])];
    }
    return [Strings.get(MENU[0]), Strings.get(MENU[1]),
      Strings.get(CONTEST_BALL_LABEL, BugContest.ballsLeft(this.save)),
      Strings.get(MENU[3])];
  }

  // The message on the cart's own two rows: 14 and 16, with 15 blank between
  // them (home/text.asm:143 and :397).  A string that will not fit two 18-tile
  // lines is cut rather than spilling onto the rows Paragraph clears.
  // Lua: BattleState.lua:4389
  printMessage(ox?: number): void {
    ox = ox ?? 0;
    this.syncTyper();
    const lines = this.messageLines();
    for (let i = 1; i <= Math.min(lines.length, TEXT_ROWS); i++) {
      Chrome.printThrough(lines[i - 1]!, TEXT_INNER_X,
        TEXT_INNER_Y + (i - 1) * TEXT_ROW_STEP, Chrome.DEFAULT_BOX_PALETTE as any);
    }
    if (this.messageArrowVisible()) {
      Chrome.printThrough(DOWN_ARROW, ARROW_X + ox, ARROW_Y,
        Chrome.DEFAULT_BOX_PALETTE as any);
    }
  }

  // ../pokecrystal/home/text.asm:548
  // ../pokecrystal/home/joypad.asm:428
  // Lua: BattleState.lua:4405
  messageArrowVisible(): boolean {
    if ((this.messageTimer ?? 0) <= 0) return false;
    if (truthy(this.waitSfx) || (this.messageDelay ?? 0) > 0) return false;
    if (Typer.typing(this)) return false;
    return Typer.arrowOn(this);
  }

  // ../pokecrystal/home/text.asm:660 StdBattleTextbox -> PrintText
  // ../pokecrystal/home/print_text.asm:1 PrintLetterDelay
  // Lua: BattleState.lua:4414
  syncTyper(): boolean {
    const text = this.message;
    if (text !== this.typedText) {
      this.typedText = text;
      if (text == null || text === "") {
        this.typer = undefined;
      } else {
        const lines = Chrome.wrap(text, TEXT_WIDTH);
        if (lines.length > TEXT_ROWS) lines.length = TEXT_ROWS;
        this.typer = Typer.new(this.game);
        this.typer.start(lines);
        // ../pokecrystal/home/text.asm:521-523
        if (this.messageCarry === text && lines[0] != null) {
          const carried = Typer.new(this.game);
          carried.start([lines[0]]);
          this.typer.shown = Math.max(this.typer.shown, carried.total);
        }
      }
      this.messageCarry = undefined;
    }
    return this.typer != null && !this.typer.done();
  }

  // Lua: BattleState.lua:4437
  messageLines(): string[] {
    if (truthy(this.typer) && this.typedText === this.message) {
      return this.typer.lines();
    }
    return Chrome.wrap(this.message ?? "", TEXT_WIDTH);
  }

  // MoveInfoBox (engine/battle/core.asm:5403-5478): "TYPE/" at (1,9), the type
  // at (2,10), cur/max PP at (5,11), or "Disabled!" at (1,10).
  // Lua: BattleState.lua:4446
  drawMoveInfoBox(move: any): void {
    if (!truthy(move)) return;
    const fighter = truthy(this.battle) ? this.battle.player : undefined;
    if (truthy(fighter) && truthy(this.battle.moveDisabled(fighter, move.id))) {
      Chrome.printThrough(Strings.get("Disabled!"), 1, 10,
        Chrome.DEFAULT_BOX_PALETTE as any);
      return;
    }
    const def = truthy(this.game) && truthy(this.game.data) && truthy(this.game.data.moves)
      ? this.game.data.moves[move.id] : undefined;
    Chrome.printThrough(Strings.get("TYPE/"), 1, 9, Chrome.DEFAULT_BOX_PALETTE as any);
    const moveType = truthy(def) ? def.type : undefined;
    Chrome.printThrough(truthy(moveType) ? TypeChart.displayName(moveType,
        truthy(this.game) ? this.game.data : undefined) : "",
      2, 10, Chrome.DEFAULT_BOX_PALETTE as any);
    Chrome.printThrough(format("%2d/%2d", move.pp ?? 0, move.maxPp ?? 0),
      5, 11, Chrome.DEFAULT_BOX_PALETTE as any);
  }

  // Lua: BattleState.lua:4470
  static hasBattleSides = hasBattleSides;

  // Lua: BattleState.lua:4472
  drawPanel(): void {
    Chrome.clear();
    if (!hasBattleSides(this)) {
      Chrome.printThrough(Strings.get("NO BATTLE"), 1, 1,
        Chrome.DEFAULT_BOX_PALETTE as any);
      return;
    }
    this.drawHud();
    this.drawBottom(0);
  }

  // Lua: BattleState.lua:4483
  drawBottom(ox?: number): void {
    ox = ox ?? 0;
    if (!truthy(this.bottomUIVisible())) {
      G.setColor(1, 1, 1, 1);
      return;
    }

    // Message box across the bottom, with the menu window over its right half --
    // the cart draws the prompt into the full-width box and then opens the menu
    // on top, so the tail of a long name is simply covered.
    // MoveSelectionScreen type 0 is two boxes: the name-only list
    // (engine/battle/core.asm:5074-5084) and MoveInfoBox's (:5407-5410).
    // engine/gfx/cgb_layouts.asm:146
    // engine/battle_anims/anim_commands.asm:1302
    const previousBgp = GbcPalette.setBgp(this.exitFadeBgp());
    const moveMenu = this.phase === "moves";
    const forgetting = this.phase === "choose-forget"
      && (this.messageTimer ?? 0) <= 0;
    Chrome.box(0, 12, 20 + ox, 6);
    if (moveMenu) {
      // List box first (core.asm:5074-5084), MoveInfoBox on top (:5157).
      Chrome.box(4, 12, 16 + ox, 6);
      Chrome.box(0, 8, 11, 5);
    }
    if (this.phase === "menu") {
      this.printMessage(ox);
      const boxX = (truthy(this.contest) ? CONTEST_MENU_BOX_X : MENU_BOX_X) + ox;
      const spacing = truthy(this.contest) ? CONTEST_MENU_COL_SPACING
        : MENU_COL_SPACING;
      Chrome.box(boxX, 12, 20 + ox - boxX, 6);
      const labels = this.menuLabels();
      for (let i = 1; i <= labels.length; i++) {
        const label = labels[i - 1]!;
        const col = mod(i - 1, 2) * spacing;
        const row = Math.floor((i - 1) / 2) * 2;
        const tx = boxX + 2 + col;
        const ty = 14 + row;
        if (i === this.menuIndex) {
          Chrome.cursorThrough(tx - 1, ty, Chrome.DEFAULT_BOX_PALETTE as any);
        }
        Chrome.printThrough(label, tx, ty, Chrome.DEFAULT_BOX_PALETTE as any);
      }
    } else if (forgetting) {
      // engine/pokemon/learn.asm:136-146
      this.printMessage(ox);
      const learn = this.pendingLearn;
      const mon = truthy(learn) ? this.battle.party[learn.index - 1] : undefined;
      const moves = (truthy(mon) && this.battle.partyMoves(mon)) || this.playerMoves();
      ForgetMoveList.draw(moves, this.forgetIndex,
        truthy(this.game) && truthy(this.game.data) ? this.game.data.moves : undefined,
        Chrome.DEFAULT_BOX_PALETTE as any);
    } else if (moveMenu) {
      const moves = this.playerMoves();
      const cursorRow = this.moveIndex;
      // w2DMenuCursorInitX 5 with the names at hlcoord 6 (core.asm:5086-5107).
      for (let i = 1; i <= moves.length; i++) {
        const move = moves[i - 1];
        const ty = 13 + (i - 1);
        // Cursor in the box's own gutter, not clipped against the border.
        if (i === cursorRow) {
          Chrome.cursorThrough(5, ty, Chrome.DEFAULT_BOX_PALETTE as any);
        }
        // The held slot's marker.  `.battle_player_moves` writes '▷' into the
        // row wSwappingMove names (engine/battle/core.asm:5157-5165) so a move
        // picked up for a swap is visible while the cursor moves off it.  It
        // hlcoord 5, 13 is the cursor's own gutter, so PlaceMenuCursor covers
        // the marker on the cursor's row.
        if (this.moveSwapIndex === i && i !== cursorRow) {
          Chrome.printThrough("\u{25B7}", 5, ty, Chrome.DEFAULT_BOX_PALETTE as any);
        }
        const def = truthy(this.game) && truthy(this.game.data) && truthy(this.game.data.moves)
          ? this.game.data.moves[move.id] : undefined;
        Chrome.printThrough((truthy(def) && def.name) || move.id, 6, ty,
          Chrome.DEFAULT_BOX_PALETTE as any);
      }
      this.drawMoveInfoBox(moves[cursorRow - 1]);
    } else {
      // Battle messages wrap inside the box rather than running off the frame.
      this.printMessage(ox);
      // YesNoBox: `lb bc, SCREEN_WIDTH - 6, 7`, a 6x5 box at (14,7) with YES at
      // (16,8) and NO at (16,10), drawn over the battle while the question
      // stands.
      const asking = this.phase === "ask-nickname" || this.phase === "ask-forget"
        || this.phase === "stop-learning" || this.phase === "ask-shift"
        || this.phase === "ask-next-mon";
      if (asking && (this.messageTimer ?? 0) <= 0) {
        // OfferSwitch calls PlaceYesNoBox with `lb bc, 1, 7`, so its box is at
        // (1,7) instead (engine/battle/core.asm:3303, home/menu.asm:392-410).
        const left = (this.phase === "ask-shift" || this.phase === "ask-next-mon")
          ? 1 : (14 + ox);
        Chrome.box(left, 7, 6, 5);
        Chrome.printThrough(Strings.get("YES"), left + 2, 8,
          Chrome.DEFAULT_BOX_PALETTE as any);
        Chrome.printThrough(Strings.get("NO"), left + 2, 10,
          Chrome.DEFAULT_BOX_PALETTE as any);
        // Lua's `a and x or b and y or ...` chain (each index is a number, so
        // never Lua-false once its phase matches).
        const index = this.phase === "ask-nickname" && truthy(this.nicknameIndex) ? this.nicknameIndex
          : this.phase === "ask-shift" && truthy(this.shiftIndex) ? this.shiftIndex
          : this.phase === "ask-next-mon" && truthy(this.nextMonIndex) ? this.nextMonIndex
          : this.forgetChoice;
        Chrome.cursorThrough(left + 1, index === 1 ? 8 : 10,
          Chrome.DEFAULT_BOX_PALETTE as any);
      }
    }
    GbcPalette.setBgp(previousBgp);
    if (this.phase === "stats-box" && truthy(this.statsBoxMon)) {
      this.drawStatsBox(this.statsBoxMon, Math.floor(ox / 2));
    }
    G.setColor(1, 1, 1, 1);
  }

  // pokegold engine/battle/core.asm:7060-7066 (box at hlcoord 9,0, stats at 11,y).
  // Lua: BattleState.lua:4597
  drawStatsBox(mon: any, ox?: number): void {
    ox = ox ?? 0;
    if (!truthy(mon)) return;
    let stats: any = mon.stats;
    const data = truthy(this.game) ? this.game.data : undefined;
    // pokecrystal/engine/battle/core.asm:7208-7213
    const def = truthy(data) && truthy(data.pokemon) ? data.pokemon[Mon.partySpecies(mon)] : undefined;
    if (truthy(def) && truthy(def.baseStats)) {
      stats = Mon.stats(def.baseStats, mon.dvs, mon.level, mon.statExp);
    }
    if (!truthy(stats)) return;
    Chrome.textbox(9 + ox, 0, 9, 10);
    for (let i = 1; i <= STATS_BOX_ROWS.length; i++) {
      const row = STATS_BOX_ROWS[i - 1]!;
      const ty = 1 + (i - 1) * 2;
      Chrome.printThrough(Strings.get(row[0]), 11 + ox, ty,
        Chrome.DEFAULT_BOX_PALETTE as any);
      Chrome.printRightThrough(format("%d", stats[row[1]] ?? 0), 19 + ox, ty + 1,
        Chrome.DEFAULT_BOX_PALETTE as any);
    }
  }

  // The BG layer, plus whatever the animation is doing to it, plus the OBJ
  // layer on top.  OBJs are not affected by SCX/SCY, which is why they are drawn
  // after the scanline blit rather than into the canvas with everything else.
  // Lua: BattleState.lua:4621
  drawScene(bodyFn?: () => void): void {
    const previousBgp = GbcPalette.setBgp(this.exitFadeBgp() ?? GbcPalette.bgp);
    if (bodyFn) bodyFn(); else this.drawSceneBody();
    GbcPalette.setBgp(previousBgp);
    // battle.overlay: shiny sparkles, custom HUD chrome, and so on.  Draw-only,
    // and the same name, the same payload (the battle screen) and the same place
    // in the frame as the Gen 1 site.  The vanilla link is a no-op, so an empty
    // chain costs one wantsHook.
    if (Runtime.wantsHook("battle.overlay")) {
      Runtime.call("battle.overlay", () => {}, this);
    }
  }

  // data/battle_anims/objects.asm:390-397: the lifted band rides at ABSOLUTE_X,
  // outside the scanline blit, so the attacker's SCX never moves it.
  // Lua: BattleState.lua:4638
  drawLiftedRows(): void {
    const battle = this.battle;
    if (!truthy(battle)) return;
    const enemy = this.animPicState("enemy");
    const player = this.animPicState("player");
    const enemyLift = truthy(enemy) ? enemy.lifted : undefined;
    const playerLift = truthy(player) ? player.lifted : undefined;
    if (!(truthy(enemyLift) || truthy(playerLift))) return;
    // The Lua paints the lifted pics into a 160x144 liftCanvas and blits it
    // over the scanline-scrolled BG.  There are no canvases on the Gold screen;
    // the lifted band is OAM on the cart (data/battle_anims/objects.asm:390-397),
    // so the pics are drawn straight onto the screen as objects (G.objects),
    // which the per-line SCX never moves.  The canvas's scissor dance falls away
    // with it: drawing directly under the current scissor is what blitting the
    // canvas under the restored scissor amounted to.
    G.push();
    G.origin();
    G.objects = true;
    this.liftedPass = true;
    // engine/battle_anims/anim_commands.asm:1308
    const previousBgp = GbcPalette.setBgp(truthy(this.anim) ? this.anim.bg.bgp : undefined);
    if (truthy(enemyLift)) this.drawPic(this.activeMon("enemy"), false);
    if (truthy(playerLift)) this.drawPic(this.activeMon("player"), true);
    GbcPalette.setBgp(previousBgp);
    this.liftedPass = undefined;
    G.pop();
    G.setColor(1, 1, 1, 1);
  }

  // Lua: BattleState.lua:4673
  drawSceneBody(panelFn?: () => void): void {
    const panel = panelFn ?? (() => { this.drawPanel(); });
    if (truthy(this.animView) && this.slideFrame < BattleAnimView.SLIDE_FRAMES) {
      // The back pic is lifted out of the sliding bands and drawn the way the
      // cart's OAM copy is: one intact piece riding in from the right, so it
      // cannot tear at the $40 scanline where the bands part ways.
      this.slidingBackpic = true;
      this.animView.presentSlide(this.slideFrame, panel, (offset: number) => {
        this.slidingBackpic = undefined;
        G.push();
        G.translate(offset, 0);
        // The cart's OAM copy of the back pic rides over the sliding SCX bands
        // and must not scroll with them: every tile an object.
        G.objects = true;
        this.drawPic(truthy(this.battle) ? this.battle.player : undefined, true);
        G.pop();
        this.slidingBackpic = true;
      });
      this.slidingBackpic = undefined;
      return;
    }
    if (truthy(this.anim) && truthy(this.animView)) {
      this.animView.present(this.anim, panel, this.battle);
      this.drawLiftedRows();
      this.animView.drawObjects(this.anim, this.battle);
      // ../pokecrystal/engine/sprite_anims/core.asm:572
      if (truthy(this.expBurst)) this.drawExpBurst();
      return;
    }
    panel();
    // ../pokecrystal/engine/sprite_anims/core.asm:572
    if (truthy(this.expBurst)) this.drawExpBurst();
  }

  // `self:wideLayout()` resolves to BattleState.wideLayout (isWide) through
  // __index, so it is called as the static with `this`.
  // Lua: BattleState.lua:4705
  draw(): void {
    if (truthy(BattleState.wideLayout(this))) return;
    Chrome.withClip(() => { this.drawScene(); });
  }

  // Lua: BattleState.lua:4710
  drawWidescreen(winW: number, winH: number): any {
    if (truthy(BattleState.wideLayout(this))) {
      return WideBattle.draw(this, winW, winH);
    }
    // The Lua passes self:battlePanelScale(winW, winH) as a seventh argument;
    // Chrome.withPanel here draws at the origin and takes no scale.
    Chrome.withPanel(winW, winH, 1, 1, 1, () => { this.drawScene(); });
  }

  // Lua: BattleState.lua:4718-4720
  static MENU = MENU;
  static STATUS_TAGS = STATUS_TAGS;
  static Battle = Battle;
}

export default BattleState;
