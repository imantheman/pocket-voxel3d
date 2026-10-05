// Port of gen1recomp src/ui/game3/slot_machine.lua (GPLv3 + additional terms; see LICENSE.md).
// pokefirered/src/slot_machine.c:863
// The Game Corner slot machine screen: bet, spin, stop, payout, help panel.
//
// Port notes:
// - Lazily required: registers G3Lazy["src.ui.game3.slot_machine"] at the end.
// - pcall(require, "src.import.gba.extract_island1"): no port; its
//   CACHE_ROOT proxies onto CachePaths.CACHE_ROOT (extract_island1.lua:21).
// - pcall(require, "src.core.game3.dataset" / "src.import.CacheFs" /
//   "src.core.game3.audio"): all in the bundle; love.filesystem is Fs;
//   love.image / love.graphics are always present.
// - rgba_to_image: Brian's ffi.copy of the raw bytes into the ImageData is
//   newImageData(w, h, "rgba8", bytes) here (the same pixels).
// - NOT FAITHFUL: no io.open on the 3DS. read_bytes' last fallback
//   (io.open(rel)) is dropped; Fs.read already tried the same path.
// - Lua's 0-keyed tables (REEL_X, BUTTON_X, ROW_Y, CLEFAIRY_ANIM, the quads)
//   are JS arrays with slot 0 used; CLEFAIRY_X, the anim command lists and
//   HELP_ROWS are Lua sequences (slot 0 unused).

/* eslint-disable @typescript-eslint/no-explicit-any */
import { late, lateOnce } from "../platform/late.ts";
import { seq, len, ipairs, type LuaTable } from "../platform/lt.ts";
import { tonumber, mod, format } from "../../../import/gen3/lua.ts";
import { G } from "../platform/graphics.ts";
import { newImageData } from "../platform/image.ts";
import * as Fs from "../platform/fs.ts";
import { G3Lazy } from "../core/lazy_registry.ts";
import Stack from "./stack.ts";
import Window from "./window.ts";
import FrlgFont from "./frlg_font.ts";
import Strings from "../shared/core/Strings.ts";
import RomText from "../core/rom_text.ts";
import Model, { type SlotState } from "../core/slot_machine.ts";
import song_fields from "../core/song_fields.ts";
import CachePaths from "../core/cache_paths.ts";
import Dataset from "../core/dataset.ts";
import { CacheFs } from "../shared/import/CacheFs.ts";
import SE from "../core/se_ids.ts";
import Audio from "../core/audio.ts";

const ICON: any = late(() => Model.ICON);

const PLACEHOLDER: Record<number, [number[], string]> = lateOnce(() => ({
  [ICON.SEVEN]: [[0.90, 0.16, 0.16], Strings("7")],
  [ICON.ROCKET]: [[0.12, 0.12, 0.16], Strings("R")],
  [ICON.PIKACHU]: [[0.98, 0.84, 0.16], Strings("PI")],
  [ICON.PSYDUCK]: [[0.98, 0.63, 0.20], Strings("PS")],
  [ICON.CHERRIES]: [[0.85, 0.20, 0.42], Strings("CH")],
  [ICON.MAGNEMITE]: [[0.64, 0.70, 0.78], Strings("MA")],
  [ICON.SHELLDER]: [[0.55, 0.72, 0.95], Strings("SH")],
}));

// Lua: slot_machine.lua:90
// pokefirered/src/slot_machine.c:1638
function help_icons(rank: number): LuaTable {
  const out: LuaTable = seq<number>();
  for (let icon = 0; icon <= 6; icon++) {
    if (Model.testIconAttribute(rank, icon)) out[len(out) + 1] = icon;
  }
  return out;
}

// Lua: slot_machine.lua:99
// pokefirered/src/slot_machine.c:388
// built on first use (the import cycle: no reads at load)
const HELP_ROWS: LuaTable = lateOnce(() => {
  const rows: LuaTable = seq<any>();
  for (let rank = Model.NUM_PAYOUT_TYPES - 1; rank >= Model.PAYOUT.CHERRIES2; rank--) {
    rows[len(rows) + 1] = { icons: help_icons(rank), payout: Model.payoutFor(rank) };
  }
  return rows;
});

// Lua: slot_machine.lua:104
function cache_root(): string {
  // pcall(require, "src.import.gba.extract_island1") (see the port notes)
  if (CachePaths.CACHE_ROOT) return CachePaths.CACHE_ROOT;
  return "data/generated/gba";
}

// Lua: slot_machine.lua:110
function read_bytes(rel: string): string | undefined {
  // pcall(require, "src.core.game3.dataset")
  if (Dataset && Dataset.cache) {
    let d: any;
    try { d = Dataset.cache().read(rel); } catch { d = undefined; }
    if (typeof d === "string" && d.length > 0) return d;
  }
  // pcall(require, "src.import.CacheFs")
  if (CacheFs && CacheFs.readActive) {
    let d: any;
    try { d = CacheFs.readActive(rel); } catch { d = undefined; }
    if (typeof d === "string" && d.length > 0) return d;
  }
  {
    let d: any;
    try { d = Fs.read(rel); } catch { d = undefined; }
    if (typeof d === "string" && d.length > 0) return d;
  }
  // NOT FAITHFUL: no io.open on the 3DS (see the port notes).
  return undefined;
}

// Lua: slot_machine.lua:134
function rgba_to_image(rgba: string, w: number, h: number): any {
  // `love and love.image and love.graphics`: always present here
  let data: any;
  try { data = newImageData(w, h, "rgba8", rgba); } catch { return undefined; }
  if (!data) return undefined;
  const img = G.newImage(data);
  if (img && img.setFilter) img.setFilter("nearest", "nearest");
  return img;
}

// Lua: slot_machine.lua:254
function se(id: any): void {
  try { Audio.playSe(id); } catch { /* pcall */ }
}

// Lua: slot_machine.lua:259
// pokefirered/src/sound.c:220
function fanfare(id: any): void {
  try { Audio.playFanfare(id); } catch { /* pcall */ }
}

// Lua: slot_machine.lua:264
// pokefirered/src/sound.c:249
function fanfareInactive(): boolean {
  // pcall(require, "src.core.game3.audio")
  const A: any = Audio;
  if (!(A != null && typeof A === "object")) return true;
  if (typeof A.isFanfareFinished !== "function") return true;
  let done: any;
  try { done = A.isFanfareFinished(); } catch { return true; }
  return (done != null && done !== false) ? true : false;
}

// Lua: slot_machine.lua:365
function coins(): number {
  return Model.coins(SlotMachineUi._session);
}

// Lua: slot_machine.lua:370
// pokefirered/src/slot_machine.c:946
function update_bet(st: SlotState, input: any): void {
  if (coins() === 0) {
    SlotMachineUi.task = "nocoins";
    SlotMachineUi._message = RomText.plain("gString_OutOfCoins");
    return;
  }
  if (input.wasPressed("down")) {
    if (Model.betOne(st, SlotMachineUi._session)) {
      se(SE.SE_RS_SHOP);
      SlotMachineUi.updateLineLights(st.bet);
      if (st.bet >= Model.MAX_BET || coins() === 0) {
        SlotMachineUi.task = "spin";
      }
    }
  } else if (input.wasPressed("r")) {
    if (Model.betMax(st, SlotMachineUi._session)) {
      se(SE.SE_RS_SHOP);
      SlotMachineUi.updateLineLights(st.bet);
      SlotMachineUi.task = "spin";
    }
  } else if (input.wasPressed("a") && st.bet !== 0) {
    SlotMachineUi.task = "spin";
  } else if (input.wasPressed("b")) {
    SlotMachineUi.task = "quit";
    SlotMachineUi._message = RomText.plain("gString_QuitPlaying");
    SlotMachineUi._yesNo = 1;
  } else if (input.wasPressed("right")) {
    // pokefirered/src/slot_machine.c:993
    SlotMachineUi.showHelp();
  }
}

// Lua: slot_machine.lua:411
// pokefirered/src/slot_machine.c:1074
function update_help(_st: SlotState, input: any): void {
  if (SlotMachineUi.helpPhase === "shown" && input.wasPressed("left")) {
    // pokefirered/src/slot_machine.c:2302
    se(SE.SE_WIN_OPEN);
    SlotMachineUi.helpPhase = "out";
  }
}

// Lua: slot_machine.lua:440
// pokefirered/src/slot_machine.c:1000
function begin_spin(st: SlotState): void {
  Model.calcBias(st);
  Model.startReels(st);
  st.currentReel = 0;
  SlotMachineUi.task = "stopping";
  // pokefirered/src/slot_machine.c:1012
  SlotMachineUi.setClefairyAnim(SlotMachineUi.ANIM_SPINNING);
}

// Lua: slot_machine.lua:450
// pokefirered/src/slot_machine.c:1016
function press_stop(st: SlotState): void {
  if (Model.isReelSpinning(st, st.currentReel)) {
    se(SE.SE_CONTEST_PLACE);
    Model.stopCurrentReel(st, st.currentReel, st.currentReel);
    SlotMachineUi.pressReelButton(st.currentReel);
  }
}

// Lua: slot_machine.lua:459
// pokefirered/src/slot_machine.c:1027
function advance_stopped_reel(st: SlotState): void {
  if (!Model.isReelSpinning(st, st.currentReel)) {
    st.currentReel = st.currentReel + 1;
    if (st.currentReel >= Model.NUM_REELS) {
      Model.calcPayout(st);
      st.bet = 0;
      st.currentReel = 0;
      if (st.slotRewardClass === Model.PAYOUT.NONE) {
        SlotMachineUi.task = "lose";
        SlotMachineUi._timer = 0;
        // pokefirered/src/slot_machine.c:2166
        SlotMachineUi.setClefairyAnim(SlotMachineUi.ANIM_LOSE);
      } else {
        if (st.slotRewardClass === Model.PAYOUT.SEVEN) {
          // pokefirered/src/slot_machine.c:1041
          Model.incrementGameStat(SlotMachineUi._session, Model.GAME_STAT_SLOT_JACKPOTS);
        }
        Model.resetBias(st);
        SlotMachineUi.task = "win";
        SlotMachineUi._timer = 0;
        SlotMachineUi._winPhase = 0;
        SlotMachineUi._payAll = false;
        // pokefirered/src/slot_machine.c:2140
        SlotMachineUi.setClefairyAnim(SlotMachineUi.ANIM_PAYOUT);
        SlotMachineUi._lineFlash = 0;
      }
    }
  }
}

// Lua: slot_machine.lua:490
// pokefirered/src/slot_machine.c:1142
function update_lose(st: SlotState): void {
  SlotMachineUi._timer = SlotMachineUi._timer + 1;
  if (SlotMachineUi._timer > 60) {
    SlotMachineUi.task = "bet";
    // pokefirered/src/slot_machine.c:1157
    SlotMachineUi.setClefairyAnim(SlotMachineUi.ANIM_NEUTRAL);
    SlotMachineUi.releaseReelButtons();
    SlotMachineUi.updateLineLights(st.bet);
  }
}

// Lua: slot_machine.lua:502
// pokefirered/src/slot_machine.c:1170
function update_win(st: SlotState): void {
  const input = SlotMachineUi._lastInput;
  const aHeld = (input && input.isDown && input.isDown("a")) ? true : false;
  const phase = SlotMachineUi._winPhase ?? 0;
  const songs: any = SlotMachineUi;
  if (phase === 0) {
    // pokefirered/src/slot_machine.c:1177
    if (st.slotRewardClass === Model.PAYOUT.ROCKET || st.slotRewardClass === Model.PAYOUT.SEVEN) {
      fanfare(songs.MUS_SLOTS_JACKPOT);
    } else {
      fanfare(songs.MUS_SLOTS_WIN);
    }
    SlotMachineUi._payDelay = 8;
    SlotMachineUi._winPhase = 1;
    return;
  }
  if (phase === 1) {
    // pokefirered/src/slot_machine.c:1186
    SlotMachineUi._payDelay = SlotMachineUi._payDelay + 1;
    if (SlotMachineUi._payDelay > 120) {
      SlotMachineUi._payDelay = aHeld ? 2 : 8;
      SlotMachineUi._winPhase = 2;
    }
    return;
  }
  if (phase === 2) {
    const payAll = SlotMachineUi._payAll;
    SlotMachineUi._payAll = false;
    // pokefirered/src/slot_machine.c:1199
    if (fanfareInactive() && payAll) {
      Model.payAll(st, SlotMachineUi._session);
    } else {
      SlotMachineUi._payDelay = SlotMachineUi._payDelay - 1;
      if (SlotMachineUi._payDelay === 0) {
        // pokefirered/src/slot_machine.c:1209
        if (fanfareInactive()) se(SE.SE_PIN);
        Model.payCoin(st, SlotMachineUi._session);
        SlotMachineUi._payDelay = aHeld ? 2 : 8;
      }
    }
    if (st.payout === 0) SlotMachineUi._winPhase = 3;
    return;
  }
  // pokefirered/src/slot_machine.c:1227
  if (fanfareInactive()) {
    SlotMachineUi.task = "bet";
    // pokefirered/src/slot_machine.c:2158
    SlotMachineUi.setClefairyAnim(SlotMachineUi.ANIM_NEUTRAL);
    SlotMachineUi.releaseReelButtons();
    SlotMachineUi.updateLineLights(st.bet);
  }
}

// Lua: slot_machine.lua:555
// pokefirered/src/slot_machine.c:1102
function update_quit(st: SlotState, input: any): void {
  if (input.wasPressed("up") || input.wasPressed("down")) {
    SlotMachineUi._yesNo = (SlotMachineUi._yesNo === 1) ? 2 : 1;
  } else if (input.wasPressed("a")) {
    if (SlotMachineUi._yesNo === 1) {
      Model.refundBet(st, SlotMachineUi._session);
      SlotMachineUi._message = undefined;
      SlotMachineUi.task = "exit";
    } else {
      SlotMachineUi._message = undefined;
      SlotMachineUi._yesNo = undefined;
      SlotMachineUi.task = "bet";
    }
  } else if (input.wasPressed("b")) {
    SlotMachineUi._message = undefined;
    SlotMachineUi._yesNo = undefined;
    SlotMachineUi.task = "bet";
  }
}

// Lua: slot_machine.lua:654
function draw_icon(icon: number, cx: number, cy: number): void {
  const [img, quads] = SlotMachineUi.iconSheet();
  const size = SlotMachineUi.ICON_SIZE;
  if (img && quads && quads[icon]) {
    G.setColor(1, 1, 1, 1);
    G.draw(img, quads[icon], cx - size / 2, cy - size / 2);
    return;
  }
  const p = PLACEHOLDER[icon];
  if (!p) return;
  const w = 22;
  G.setColor(p[0][0]!, p[0][1]!, p[0][2]!, 1);
  G.rectangle("fill", cx - w / 2, cy - w / 2, w, w);
  G.setColor(0, 0, 0, 1);
  G.rectangle("line", cx - w / 2 + 0.5, cy - w / 2 + 0.5, w - 1, w - 1);
  G.setColor(1, 1, 1, 1);
  FrlgFont.draw(p[1], cx - 7, cy - 6, { small: true, colors: FrlgFont.COLOR.NORMAL });
}

// Lua: slot_machine.lua:674
// pokefirered/src/slot_machine.c:1842
function draw_reel(st: SlotState, reel: number): void {
  const cx = SlotMachineUi.REEL_X[reel]!;
  const pos = st.reelPositions[reel]!;
  const yoff = st.reelSubpixel[reel]! * 8;
  for (let j = 0; j <= Model.REEL_LOAD_LENGTH - 1; j++) {
    const icon = Model.iconAt(reel, mod(pos + j, Model.REEL_LENGTH));
    draw_icon(icon, cx, SlotMachineUi.REEL_TOP_Y + SlotMachineUi.ICON_SPACING * j + yoff);
  }
}

// Lua: slot_machine.lua:685
// pokefirered/src/slot_machine.c:2381
function draw_line_seg(x1: number, y1: number, x2: number, y2: number, on: any, win: any, flash: boolean, skipUnlit: boolean): void {
  if (skipUnlit && !(on || win)) return;
  if (win) {
    if (flash) {
      G.setColor(1, 0.9, 0.2, 1);
    } else {
      G.setColor(1, 0.55, 0.12, 1);
    }
  } else if (on) {
    G.setColor(1, 0.35, 0.35, 1);
  } else {
    G.setColor(0.35, 0.35, 0.4, 1);
  }
  G.line(x1, y1, x2, y2);
}

// Lua: slot_machine.lua:701
function draw_lines(st: SlotState): void {
  const lit = SlotMachineUi._lit ?? SlotMachineUi.updateLineLights(st.bet);
  const left = SlotMachineUi.REEL_X[0]! - 24, right = SlotMachineUi.REEL_X[2]! + 24;
  const rowY = SlotMachineUi.ROW_Y;
  const flash = SlotMachineUi.lineFlashOn();
  // pokefirered/src/slot_machine.c:2367
  const baked = SlotMachineUi.background() != null;
  draw_line_seg(left, rowY[0]!, right, rowY[0]!, lit[1], st.winFlags[1], flash, baked);
  draw_line_seg(left, rowY[1]!, right, rowY[1]!, lit[2], st.winFlags[2], flash, baked);
  draw_line_seg(left, rowY[2]!, right, rowY[2]!, lit[3], st.winFlags[3], flash, baked);
  draw_line_seg(left, rowY[0]!, right, rowY[2]!, lit[0], st.winFlags[0], flash, baked);
  draw_line_seg(left, rowY[2]!, right, rowY[0]!, lit[4], st.winFlags[4], flash, baked);
  G.setColor(1, 1, 1, 1);
}

// Lua: slot_machine.lua:717
// pokefirered/src/slot_machine.c:2492
function draw_reel_buttons(): void {
  const pressed = SlotMachineUi.buttonPressed ?? {};
  const size = SlotMachineUi.BUTTON_SIZE;
  const sheet = SlotMachineUi.buttonSheet();
  if (sheet) {
    G.setColor(1, 1, 1, 1);
    for (let reel = 0; reel <= Model.NUM_REELS - 1; reel++) {
      if (pressed[reel]) {
        G.draw(sheet, SlotMachineUi.BUTTON_X[reel]!, SlotMachineUi.BUTTON_Y);
      }
    }
    return;
  }
  for (let reel = 0; reel <= Model.NUM_REELS - 1; reel++) {
    const x = SlotMachineUi.BUTTON_X[reel]!;
    const y = SlotMachineUi.BUTTON_Y + (pressed[reel] ? 2 : 0);
    if (pressed[reel]) {
      G.setColor(0.40, 0.12, 0.14, 1);
    } else {
      G.setColor(0.86, 0.22, 0.25, 1);
    }
    G.rectangle("fill", x, y, size, size - (pressed[reel] ? 2 : 0));
    G.setColor(0, 0, 0, 1);
    G.rectangle("line", x + 0.5, y + 0.5, size - 1, size - 1 - (pressed[reel] ? 2 : 0));
  }
  G.setColor(1, 1, 1, 1);
}

// Lua: slot_machine.lua:746
// pokefirered/src/slot_machine.c:1923
function draw_clefairy(): void {
  const size = SlotMachineUi.CLEFAIRY_SIZE;
  const frame = SlotMachineUi.clefairyFrame();
  const [img, quads] = SlotMachineUi.clefairySheet();
  for (const [i, cx] of ipairs<number>(SlotMachineUi.CLEFAIRY_X)) {
    const x = cx - size / 2;
    const y = SlotMachineUi.CLEFAIRY_Y - size / 2;
    if (img && quads && quads[frame]) {
      G.setColor(1, 1, 1, 1);
      if (i === 2) {
        G.draw(img, quads[frame], x + size, y, 0, -1, 1);
      } else {
        G.draw(img, quads[frame], x, y);
      }
    } else {
      const shade = 0.75 + 0.08 * mod(frame, 2);
      G.setColor(0.98 * shade, 0.72 * shade, 0.78 * shade, 1);
      G.rectangle("fill", x + 6, y + 6, size - 12, size - 12);
      G.setColor(0, 0, 0, 1);
      G.rectangle("line", x + 6.5, y + 6.5, size - 13, size - 13);
    }
  }
  G.setColor(1, 1, 1, 1);
}

// Lua: slot_machine.lua:772
// pokefirered/src/slot_machine.c:2052
function draw_help(): void {
  let w = SlotMachineUi.helpX ?? 0;
  if (w <= 0) return;
  if (w > 240) w = 240;
  const sc = G.getScissor();
  G.setScissor(0, 0, w, 160);
  const img = SlotMachineUi.combosWindow();
  if (img) {
    G.setColor(1, 1, 1, 1);
    G.draw(img, 0, 0);
  } else {
    G.setColor(0.06, 0.06, 0.12, 1);
    G.rectangle("fill", 0, 0, 240, 160);
    for (const [i, row] of ipairs<any>(HELP_ROWS)) {
      const y = 16 + (i - 1) * 22;
      for (const [k, icon] of ipairs<number>(row.icons)) {
        const p = PLACEHOLDER[icon];
        if (p) {
          G.setColor(p[0][0]!, p[0][1]!, p[0][2]!, 1);
          G.rectangle("fill", 24 + (k - 1) * 22, y, 18, 18);
          G.setColor(1, 1, 1, 1);
          FrlgFont.draw(p[1], 27 + (k - 1) * 22, y + 4,
            { small: true, colors: FrlgFont.COLOR.NORMAL });
        }
      }
      G.setColor(1, 1, 1, 1);
      FrlgFont.draw(format("%4d", row.payout), 150, y + 4,
        { small: true, colors: FrlgFont.COLOR.NORMAL });
    }
  }
  if (sc) {
    G.setScissor(sc[0], sc[1], sc[2], sc[3]);
  } else {
    G.setScissor();
  }
  G.setColor(1, 1, 1, 1);
}

// Lua: slot_machine.lua:811
// pokefirered/src/slot_machine.c:1903
function amount_text(key: string, value: number, fmt: (n: number) => string): string {
  let cache = SlotMachineUi._amounts;
  if (!cache) {
    cache = { credit: -1, payout: -1, bet: -1 };
    SlotMachineUi._amounts = cache;
  }
  if (cache[key] !== value) {
    cache[key] = value;
    cache[key + "Text"] = fmt(value);
  }
  return cache[key + "Text"];
}

// Lua: slot_machine.lua:824
function digits(n: number): string {
  return format("%4d", n);
}

// Lua: slot_machine.lua:828
function bet_text(n: number): string {
  return Strings("BET %d", n);
}

// Lua: slot_machine.lua:833
// pokefirered/src/slot_machine.c:1903
function draw_digits(valueIn: any, baseX: number): boolean {
  const [sheet, quads] = SlotMachineUi.digitSheet();
  if (!(sheet && quads)) return false;
  let value = Math.max(0, Math.floor(tonumber(valueIn) ?? 0));
  let divisor = 1000;
  G.setColor(1, 1, 1, 1);
  for (let i = 0; i <= SlotMachineUi.NUM_DIGIT_SPRITES - 1; i++) {
    const quotient = Math.floor(value / divisor);
    value = value - quotient * divisor;
    if (quads[quotient]) {
      G.draw(sheet, quads[quotient],
        baseX + 7 * i - SlotMachineUi.DIGIT_W / 2, SlotMachineUi.DIGIT_Y - SlotMachineUi.DIGIT_H / 2);
    }
    divisor = divisor / 10;
  }
  return true;
}

/** A sprite sheet of `frames` cells stacked vertically: [image, quads (0-based)]. */
function loadStrip(rel: string, w: number, h: number, minFrames: number): [any, any[]] | undefined {
  const raw = read_bytes(rel);
  if (!raw) return undefined;
  const frames = Math.floor(raw.length / (w * h * 4));
  if (frames < minFrames) return undefined;
  const img = rgba_to_image(raw, w, h * frames);
  if (!img) return undefined;
  const quads: any[] = [];
  for (let i = 0; i <= frames - 1; i++) {
    quads[i] = G.newQuad(0, i * h, w, h, w, h * frames);
  }
  return [img, quads];
}

export const SlotMachineUi = {
  open: false as boolean,
  state: undefined as SlotState | undefined,
  task: "bet" as string,

  // pokefirered/src/slot_machine.c:1826
  REEL_X: [80, 120, 160],
  REEL_TOP_Y: 44,
  ICON_SPACING: 24,
  ICON_SIZE: 32,

  // pokefirered/src/slot_machine.c:1894
  CREDIT_X: 85,
  PAYOUT_X: 133,
  DIGIT_Y: 30,

  // pokefirered/src/slot_machine.c:796
  MSG_LEFT: 5,
  MSG_TOP: 15,
  MSG_WIDTH: 20,
  MSG_HEIGHT: 4,

  // pokefirered/src/slot_machine.c:847
  YESNO_LEFT: 19,
  YESNO_TOP: 9,

  // pokefirered/src/slot_machine.c:1923
  CLEFAIRY_SIZE: 32,
  CLEFAIRY_X: seq(16, 224) as LuaTable,
  CLEFAIRY_Y: 136,

  // pokefirered/src/slot_machine.c:679
  CLEFAIRY_ANIM: [
    seq({ frame: 0, duration: 4 }),
    seq({ frame: 0, duration: 24 }, { frame: 1, duration: 24 }),
    seq({ frame: 2, duration: 28 }, { frame: 3, duration: 28 }),
    seq({ frame: 4, duration: 12 }, { frame: 5, duration: 12 }),
  ] as LuaTable[],

  ANIM_NEUTRAL: 0,
  ANIM_SPINNING: 1,
  ANIM_PAYOUT: 2,
  ANIM_LOSE: 3,

  // pokefirered/src/slot_machine.c:857
  BUTTON_X: [72, 112, 152],
  BUTTON_Y: 136,
  BUTTON_SIZE: 16,

  // pokefirered/src/slot_machine.c:2399
  LINE_FLASH_PERIOD: 8,

  // pokefirered/src/slot_machine.c:2385
  ROW_Y: [68, 92, 116],

  // pokefirered/src/slot_machine.c:2287
  HELP_SLIDE_STEP: 16,
  HELP_WIDTH: 256,

  // pokefirered/src/palette.c:162
  FADE_STEP: 3,
  FADE_MAX: 16,

  // pokefirered/src/slot_machine.c:27
  NUM_DIGIT_SPRITES: 4,
  DIGIT_W: 8,
  DIGIT_H: 16,

  // screen state (Brian's SlotMachineUi._* fields)
  _session: undefined as any,
  _onClose: undefined as (() => void) | undefined,
  _timer: 0,
  _frame: 0,
  _message: undefined as string | undefined,
  _yesNo: undefined as number | undefined,
  _payDelay: 0,
  _winPhase: 0,
  _payAll: false,
  _lineFlash: 0,
  _fadeY: 0,
  _fadeDir: 0,
  _lit: undefined as boolean[] | undefined,
  _msgTpl: undefined as any,
  _yesNoTpl: undefined as any,
  _amounts: undefined as Record<string, any> | undefined,
  _lastInput: undefined as any,
  helpPhase: undefined as string | undefined,
  helpX: 0,
  clefairyAnim: 0,
  clefairyStep: 1,
  clefairyTimer: 0,
  buttonPressed: undefined as Record<number, boolean> | undefined,
  _iconsTried: false, _icons: undefined as any, _iconQuads: undefined as any[] | undefined,
  _bgTried: false, _bg: undefined as any,
  _clefTried: false, _clef: undefined as any, _clefQuads: undefined as any[] | undefined,
  _digitsTried: false, _digits: undefined as any, _digitQuads: undefined as any[] | undefined,
  _buttonTried: false, _button: undefined as any,
  _combosTried: false, _combos: undefined as any,

  // Lua: slot_machine.lua:156
  iconSheet(): [any, any[]?] {
    if (SlotMachineUi._iconsTried) return [SlotMachineUi._icons, SlotMachineUi._iconQuads];
    SlotMachineUi._iconsTried = true;
    const size = SlotMachineUi.ICON_SIZE;
    const got = loadStrip(cache_root() + "/slot_machine/reel_icons.rgba", size, size, 7);
    if (!got) return [undefined];
    SlotMachineUi._icons = got[0];
    SlotMachineUi._iconQuads = got[1];
    return got;
  },

  // Lua: slot_machine.lua:175
  background(): any {
    if (SlotMachineUi._bgTried) return SlotMachineUi._bg;
    SlotMachineUi._bgTried = true;
    const raw = read_bytes(cache_root() + "/slot_machine/bg.rgba");
    if (raw && raw.length >= 240 * 160 * 4) {
      SlotMachineUi._bg = rgba_to_image(raw, 240, 160);
    }
    return SlotMachineUi._bg;
  },

  // Lua: slot_machine.lua:185
  clefairySheet(): [any, any[]?] {
    if (SlotMachineUi._clefTried) return [SlotMachineUi._clef, SlotMachineUi._clefQuads];
    SlotMachineUi._clefTried = true;
    const size = SlotMachineUi.CLEFAIRY_SIZE;
    const got = loadStrip(cache_root() + "/slot_machine/clefairy.rgba", size, size, 6);
    if (!got) return [undefined];
    SlotMachineUi._clef = got[0];
    SlotMachineUi._clefQuads = got[1];
    return got;
  },

  // Lua: slot_machine.lua:210
  // pokefirered/src/slot_machine.c:1889
  digitSheet(): [any, any[]?] {
    if (SlotMachineUi._digitsTried) return [SlotMachineUi._digits, SlotMachineUi._digitQuads];
    SlotMachineUi._digitsTried = true;
    const w = SlotMachineUi.DIGIT_W, h = SlotMachineUi.DIGIT_H;
    const got = loadStrip(cache_root() + "/slot_machine/digits.rgba", w, h, 10);
    if (!got) return [undefined];
    SlotMachineUi._digits = got[0];
    SlotMachineUi._digitQuads = got[1];
    return got;
  },

  // Lua: slot_machine.lua:230
  // pokefirered/src/slot_machine.c:2523
  buttonSheet(): any {
    if (SlotMachineUi._buttonTried) return SlotMachineUi._button;
    SlotMachineUi._buttonTried = true;
    const size = SlotMachineUi.BUTTON_SIZE;
    const raw = read_bytes(cache_root() + "/slot_machine/button_pressed.rgba");
    if (raw && raw.length >= size * size * 4) {
      SlotMachineUi._button = rgba_to_image(raw, size, size);
    }
    return SlotMachineUi._button;
  },

  // Lua: slot_machine.lua:242
  // pokefirered/src/slot_machine.c:747
  combosWindow(): any {
    if (SlotMachineUi._combosTried) return SlotMachineUi._combos;
    SlotMachineUi._combosTried = true;
    const raw = read_bytes(cache_root() + "/slot_machine/combos_window.rgba");
    if (raw && raw.length >= 240 * 160 * 4) {
      SlotMachineUi._combos = rgba_to_image(raw, 240, 160);
    }
    return SlotMachineUi._combos;
  },

  // Lua: slot_machine.lua:273
  show(optsIn?: any): SlotState {
    const opts = optsIn ?? {};
    SlotMachineUi.open = true;
    SlotMachineUi._session = opts.session;
    SlotMachineUi._onClose = opts.onClose;
    SlotMachineUi.state = Model.newState(opts.machineIdx);
    SlotMachineUi.task = "bet";
    SlotMachineUi._timer = 0;
    SlotMachineUi._frame = 0;
    SlotMachineUi._message = undefined;
    SlotMachineUi._yesNo = undefined;
    SlotMachineUi._payDelay = 0;
    SlotMachineUi._winPhase = 0;
    SlotMachineUi._payAll = false;
    SlotMachineUi.setClefairyAnim(SlotMachineUi.ANIM_NEUTRAL);
    SlotMachineUi.releaseReelButtons();
    SlotMachineUi._lineFlash = 0;
    SlotMachineUi.helpPhase = undefined;
    SlotMachineUi.helpX = 0;
    // pokefirered/src/slot_machine.c:2087
    SlotMachineUi._fadeY = SlotMachineUi.FADE_MAX;
    SlotMachineUi._fadeDir = -1;
    SlotMachineUi.updateLineLights(SlotMachineUi.state.bet);
    SlotMachineUi._msgTpl = Window.template(SlotMachineUi.MSG_LEFT, SlotMachineUi.MSG_TOP,
      SlotMachineUi.MSG_WIDTH, SlotMachineUi.MSG_HEIGHT);
    SlotMachineUi._yesNoTpl = Window.template(SlotMachineUi.YESNO_LEFT, SlotMachineUi.YESNO_TOP, 6, 4);
    SlotMachineUi._amounts = { credit: -1, payout: -1, bet: -1 };
    Stack.push("slot_machine", SlotMachineUi as any, { hideBelow: true, fullscreen: true });
    return SlotMachineUi.state;
  },

  // Lua: slot_machine.lua:305
  // pokefirered/src/slot_machine.c:2344
  updateLineLights(bet?: any): boolean[] {
    const lit = SlotMachineUi._lit ?? [];
    for (let i = 0; i <= Model.NUM_MATCH_LINES - 1; i++) lit[i] = false;
    for (const [, id] of ipairs<number>(Model.linesForBet(bet ?? 0))) lit[id] = true;
    SlotMachineUi._lit = lit;
    return lit;
  },

  // Lua: slot_machine.lua:314
  // pokefirered/src/slot_machine.c:1932
  setClefairyAnim(animIdIn: any): void {
    let animId = tonumber(animIdIn) ?? 0;
    if (!SlotMachineUi.CLEFAIRY_ANIM[animId]) animId = 0;
    SlotMachineUi.clefairyAnim = animId;
    SlotMachineUi.clefairyStep = 1;
    SlotMachineUi.clefairyTimer = 0;
  },

  // Lua: slot_machine.lua:323
  // pokefirered/src/sprite.c:905
  stepClefairy(): void {
    const anim = SlotMachineUi.CLEFAIRY_ANIM[SlotMachineUi.clefairyAnim ?? 0];
    if (!anim) return;
    SlotMachineUi.clefairyTimer = (SlotMachineUi.clefairyTimer ?? 0) + 1;
    const cmd = anim[SlotMachineUi.clefairyStep ?? 1];
    if (!cmd) return;
    if (SlotMachineUi.clefairyTimer > cmd.duration && len(anim) > 1) {
      SlotMachineUi.clefairyTimer = 0;
      SlotMachineUi.clefairyStep = mod(SlotMachineUi.clefairyStep, len(anim)) + 1;
    }
  },

  // Lua: slot_machine.lua:335
  clefairyFrame(): number {
    const anim = SlotMachineUi.CLEFAIRY_ANIM[SlotMachineUi.clefairyAnim ?? 0];
    const cmd = anim ? anim[SlotMachineUi.clefairyStep ?? 1] : undefined;
    return cmd ? (cmd.frame ?? 0) : 0;
  },

  // Lua: slot_machine.lua:342
  // pokefirered/src/slot_machine.c:2492
  pressReelButton(reel: any): void {
    SlotMachineUi.buttonPressed = SlotMachineUi.buttonPressed ?? {};
    SlotMachineUi.buttonPressed[tonumber(reel) ?? 0] = true;
  },

  // Lua: slot_machine.lua:348
  // pokefirered/src/slot_machine.c:2507
  releaseReelButtons(): void {
    SlotMachineUi.buttonPressed = {};
  },

  // Lua: slot_machine.lua:352
  isOpen(): boolean {
    return SlotMachineUi.open;
  },

  // Lua: slot_machine.lua:356
  close(): void {
    SlotMachineUi.open = false;
    Stack.pop("slot_machine");
    const cb = SlotMachineUi._onClose;
    SlotMachineUi._onClose = undefined;
    SlotMachineUi.state = undefined;
    if (cb) cb();
  },

  // Lua: slot_machine.lua:403
  // pokefirered/src/slot_machine.c:2271
  showHelp(): void {
    SlotMachineUi.task = "help";
    SlotMachineUi.helpPhase = "in";
    SlotMachineUi.helpX = 0;
    se(SE.SE_WIN_OPEN);
  },

  // Lua: slot_machine.lua:420
  // pokefirered/src/slot_machine.c:2287
  stepHelp(): void {
    const phase = SlotMachineUi.helpPhase;
    if (phase === "in") {
      SlotMachineUi.helpX = (SlotMachineUi.helpX ?? 0) + SlotMachineUi.HELP_SLIDE_STEP;
      if (SlotMachineUi.helpX >= SlotMachineUi.HELP_WIDTH) {
        SlotMachineUi.helpX = SlotMachineUi.HELP_WIDTH;
        SlotMachineUi.helpPhase = "shown";
      }
    } else if (phase === "out") {
      // pokefirered/src/slot_machine.c:2311
      SlotMachineUi.helpX = (SlotMachineUi.helpX ?? 0) - SlotMachineUi.HELP_SLIDE_STEP;
      if (SlotMachineUi.helpX <= 0) {
        SlotMachineUi.helpX = 0;
        SlotMachineUi.helpPhase = undefined;
        SlotMachineUi.task = "bet";
      }
    }
  },

  // Lua: slot_machine.lua:575
  handleInput(input: any): void {
    const st = SlotMachineUi.state;
    if (!(SlotMachineUi.open && st && input)) return;
    SlotMachineUi._lastInput = input;
    const task = SlotMachineUi.task;
    if (task === "bet") {
      update_bet(st, input);
    } else if (task === "stopping") {
      if (input.wasPressed("a")) press_stop(st);
    } else if (task === "win") {
      // pokefirered/src/slot_machine.c:1199
      if (input.wasPressed("start") && SlotMachineUi._winPhase === 2 && fanfareInactive()) {
        SlotMachineUi._payAll = true;
      }
    } else if (task === "help") {
      update_help(st, input);
    } else if (task === "quit") {
      update_quit(st, input);
    } else if (task === "nocoins") {
      // pokefirered/src/slot_machine.c:1068
      if (input.wasPressed("a") || input.wasPressed("b") || input.wasPressed("up")
          || input.wasPressed("down") || input.wasPressed("left") || input.wasPressed("right")) {
        SlotMachineUi._message = undefined;
        SlotMachineUi.task = "exit";
      }
    }
  },

  // Lua: slot_machine.lua:604
  // pokefirered/src/palette.c:393
  stepFade(): void {
    let dir = SlotMachineUi._fadeDir ?? 0;
    if (dir === 0) return;
    let y = (SlotMachineUi._fadeY ?? 0) + dir * SlotMachineUi.FADE_STEP;
    if (dir < 0 && y <= 0) { y = 0; dir = 0; }
    if (dir > 0 && y >= SlotMachineUi.FADE_MAX) { y = SlotMachineUi.FADE_MAX; dir = 0; }
    SlotMachineUi._fadeY = y; SlotMachineUi._fadeDir = dir;
  },

  // Lua: slot_machine.lua:613
  fadeActive(): boolean {
    return (SlotMachineUi._fadeDir ?? 0) !== 0;
  },

  // Lua: slot_machine.lua:617
  update(_dt?: number): void {
    const st = SlotMachineUi.state;
    if (!(SlotMachineUi.open && st)) return;
    SlotMachineUi._frame = SlotMachineUi._frame + 1;
    SlotMachineUi.stepFade();
    if (SlotMachineUi.task === "spin") {
      begin_spin(st);
    } else if (SlotMachineUi.task === "lose") {
      update_lose(st);
    } else if (SlotMachineUi.task === "win") {
      update_win(st);
    } else if (SlotMachineUi.task === "help") {
      SlotMachineUi.stepHelp();
    } else if (SlotMachineUi.task === "exit") {
      // pokefirered/src/slot_machine.c:2106
      SlotMachineUi._fadeDir = 1;
      SlotMachineUi.task = "fadeout";
    } else if (SlotMachineUi.task === "fadeout") {
      if (!SlotMachineUi.fadeActive()) {
        SlotMachineUi.close();
        return;
      }
    }
    // pokefirered/src/slot_machine.c:1274
    Model.spinStep(st);
    if (SlotMachineUi.task === "stopping") {
      advance_stopped_reel(st);
    }
    SlotMachineUi.stepClefairy();
    SlotMachineUi._lineFlash = mod((SlotMachineUi._lineFlash ?? 0) + 1, SlotMachineUi.LINE_FLASH_PERIOD * 2);
  },

  // Lua: slot_machine.lua:650
  // pokefirered/src/slot_machine.c:2398
  lineFlashOn(): boolean {
    return (SlotMachineUi._lineFlash ?? 0) < SlotMachineUi.LINE_FLASH_PERIOD;
  },

  // Lua: slot_machine.lua:851
  draw(): void {
    const st = SlotMachineUi.state;
    if (!(SlotMachineUi.open && st)) return;
    // `not (love and love.graphics)`: always present here

    const bg = SlotMachineUi.background();
    if (bg) {
      G.setColor(1, 1, 1, 1);
      G.draw(bg, 0, 0);
    } else {
      G.setColor(0.12, 0.10, 0.22, 1);
      G.rectangle("fill", 0, 0, 240, 160);
      G.setColor(0.24, 0.20, 0.38, 1);
      G.rectangle("fill", 56, 40, 128, 96);
      G.setColor(0, 0, 0, 1);
      G.rectangle("fill", 60, 50, 120, 76);
    }
    G.setColor(1, 1, 1, 1);

    const sc = G.getScissor();
    G.setScissor(60, 50, 120, 76);
    for (let reel = 0; reel <= Model.NUM_REELS - 1; reel++) {
      draw_reel(st, reel);
    }
    if (sc) {
      G.setScissor(sc[0], sc[1], sc[2], sc[3]);
    } else {
      G.setScissor();
    }

    draw_lines(st);
    draw_reel_buttons();
    draw_clefairy();

    // pokefirered/src/slot_machine.c:2037
    if (!bg) {
      FrlgFont.draw(Strings("CREDIT"), SlotMachineUi.CREDIT_X - 30, SlotMachineUi.DIGIT_Y - 14,
        { small: true, colors: FrlgFont.COLOR.NORMAL });
      FrlgFont.draw(amount_text("bet", st.bet, bet_text), 8, SlotMachineUi.DIGIT_Y - 4,
        { small: true, colors: FrlgFont.COLOR.NORMAL });
    }
    // pokefirered/src/slot_machine.c:1903
    if (!draw_digits(coins(), SlotMachineUi.CREDIT_X)) {
      FrlgFont.draw(amount_text("credit", coins(), digits),
        SlotMachineUi.CREDIT_X - 4, SlotMachineUi.DIGIT_Y - 4,
        { small: true, colors: FrlgFont.COLOR.NORMAL });
    }
    if (!draw_digits(st.payout, SlotMachineUi.PAYOUT_X)) {
      FrlgFont.draw(amount_text("payout", st.payout, digits),
        SlotMachineUi.PAYOUT_X - 4, SlotMachineUi.DIGIT_Y - 4,
        { small: true, colors: FrlgFont.COLOR.NORMAL });
    }

    draw_help();

    if (SlotMachineUi._message) {
      const tpl = SlotMachineUi._msgTpl;
      Window.stdFrame(tpl);
      Window.printPx(SlotMachineUi._message, SlotMachineUi.MSG_LEFT * 8, SlotMachineUi.MSG_TOP * 8 + 2);
    }

    if (SlotMachineUi._yesNo) {
      const tpl = SlotMachineUi._yesNoTpl;
      Window.stdFrame(tpl);
      Window.printPx(RomText.plain("gText_Yes"), (SlotMachineUi.YESNO_LEFT + 1) * 8, SlotMachineUi.YESNO_TOP * 8 + 2);
      Window.printPx(RomText.plain("gText_No"), (SlotMachineUi.YESNO_LEFT + 1) * 8, SlotMachineUi.YESNO_TOP * 8 + 16);
      Window.cursorPx(SlotMachineUi.YESNO_LEFT * 8 + 2,
        SlotMachineUi.YESNO_TOP * 8 + 2 + (SlotMachineUi._yesNo - 1) * 14);
    }

    // pokefirered/src/slot_machine.c:2087
    const fadeY = SlotMachineUi._fadeY ?? 0;
    if (fadeY > 0) {
      G.setColor(0, 0, 0, fadeY / SlotMachineUi.FADE_MAX);
      G.rectangle("fill", 0, 0, 240, 160);
    }
    G.setColor(1, 1, 1, 1);
  },
};

// Lua: slot_machine.lua:67
// pokefirered/include/constants/songs.h:275
song_fields(SlotMachineUi);

export default SlotMachineUi;

G3Lazy["src.ui.game3.slot_machine"] = SlotMachineUi;
