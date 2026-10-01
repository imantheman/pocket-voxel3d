// The Gold Oak speech and its screens (voxelmon/game/gen2/ui/OakSpeech,
// InitClock, NamePick, NamingScreen, GenderSelect), driven through Game2's
// own boot flow (showOakSpeech) on the Gold screen.

import { describe, expect, test } from "bun:test";
import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";
import { RecorderHost } from "../voxelmon/game/host.ts";
import { Game2 } from "../voxelmon/game/gen2/core/Game2.ts";
import { Clock } from "../voxelmon/game/gen2/core/Clock.ts";
import { fixedClock, setClockSource } from "../voxelmon/game/gen2/platform/clock.ts";
import { haveGoldGen, useGoldGen } from "../voxelmon/game/gen2/platform/data-node.ts";
import { Lcd } from "../voxelmon/game/gen2/platform/lcd.ts";
import { seed } from "../voxelmon/game/gen2/platform/rng.ts";
import { memorySaveIo, setSaveIo } from "../voxelmon/game/gen2/platform/saveio.ts";
import { Screens } from "../voxelmon/game/gen2/shared/ui/Screens.ts";
import { GenderSelect } from "../voxelmon/game/gen2/ui/GenderSelect.ts";
import { InitClock } from "../voxelmon/game/gen2/ui/InitClock.ts";
import { NamePick } from "../voxelmon/game/gen2/ui/NamePick.ts";
import { NamingScreen } from "../voxelmon/game/gen2/ui/NamingScreen.ts";
import { OakSpeech } from "../voxelmon/game/gen2/ui/OakSpeech.ts";

const gold = haveGoldGen();
type Btn = keyof typeof VOX_BTN;

interface Rig {
  game: any;
  lcd: Lcd;
  worldStarted: number;
}

async function rig(): Promise<Rig> {
  useGoldGen();
  const { useGoldTiles } = await import("../voxelmon/game/gen2/platform/shot-node.ts");
  useGoldTiles();
  seed(2026);
  setSaveIo(memorySaveIo());
  setClockSource(fixedClock({ year: 2026, month: 9, day: 30, hour: 10, min: 15 }));
  const game: any = Game2.new();
  game.showCopyright = () => {};
  game.load({ startWorld: false });
  const r: Rig = { game, lcd: new Lcd(new RecorderHost()), worldStarted: 0 };
  // the world is another module's; the speech's exit is what is under test
  game.startWorld = () => {
    r.worldStarted += 1;
    return true;
  };
  return r;
}

/** One Game2 step with `btn` held, then a draw. */
function step(r: Rig, btn?: Btn): void {
  r.game.frame(btn ? VOX_BTN[btn] : 0);
  r.game.draw(r.lcd);
}

function press(r: Rig, btn: Btn, settle = 1): void {
  step(r, btn);
  for (let i = 0; i < settle; i++) step(r);
}

function idle(r: Rig, n: number): void {
  for (let i = 0; i < n; i++) step(r);
}

/** Step (tapping `btn` every other frame when given) until `cond`, or fail. */
function until(r: Rig, cond: () => boolean, btn?: Btn, max = 3000): void {
  for (let i = 0; i < max; i++) {
    if (cond()) return;
    step(r, btn && i % 2 === 0 ? btn : undefined);
  }
  throw new Error(`until: gave up (top ${topName(r)})`);
}

function topName(r: Rig): string | undefined {
  const t = r.game.stack.top();
  return t ? t.constructor?.name : undefined;
}

function speechOf(r: Rig): OakSpeech {
  return r.game.stack.states.find((s: any) => s instanceof OakSpeech);
}

async function shot(r: Rig, name: string): Promise<void> {
  r.game.draw(r.lcd);
  if (!process.env.GOLD_SHOTS) return;
  const { shotLcd } = await import("../voxelmon/game/gen2/platform/shot-node.ts");
  shotLcd(r.lcd.s, `${process.env.GOLD_SHOTS}/${name}.png`);
}

/** Walk the NamingScreen cursor to `ch` on the board showing, and press A. */
function typeChar(r: Rig, ch: string): void {
  const ns: NamingScreen = r.game.stack.top();
  const grid = ns.rows();
  let row = -1;
  let col = -1;
  grid.forEach((line, y) => {
    const x = line.indexOf(ch);
    if (x >= 0 && row < 0) {
      row = y;
      col = x;
    }
  });
  if (row < 0) throw new Error(`typeChar: ${ch} not on the board`);
  while (ns.row < row) press(r, "down");
  while (ns.row > row) press(r, "up");
  while (ns.col < col) press(r, "right");
  while (ns.col > col) press(r, "left");
  expect(ns.cursorCharacter()).toBe(ch);
  press(r, "a");
}

/**
 * InitClock from its fade-in to its exit: hour up to 12, a NO that drops
 * back to the picker, YES, minutes up to 3, YES, Oak's reply, out.
 */
async function setClock(r: Rig, shots: boolean): Promise<void> {
  const clock: InitClock = r.game.stack.top();
  expect(clock).toBeInstanceOf(InitClock);
  expect(clock.blank).toBe(true);
  if (shots) await shot(r, "initclock_blank");
  until(r, () => clock.fade == null && clock.typer.done());
  expect(clock.phase).toBe("intro");
  if (shots) await shot(r, "initclock_intro");
  press(r, "a");
  until(r, () => clock.typer.done());
  expect(clock.page).toBe(2);
  press(r, "a");
  expect(clock.phase).toBe("hour");
  until(r, () => clock.typer.done());
  press(r, "up");
  press(r, "up");
  expect(clock.hour).toBe(12);
  if (shots) await shot(r, "initclock_hour");
  press(r, "a");
  expect(clock.phase).toBe("confirm-hour");
  until(r, () => clock.typer.done());
  if (shots) await shot(r, "initclock_confirm_hour");
  press(r, "down");
  expect(clock.yesNo).toBe(2);
  press(r, "a");
  expect(clock.phase).toBe("hour");
  until(r, () => clock.typer.done());
  press(r, "a");
  until(r, () => clock.typer.done());
  press(r, "a");
  expect(clock.phase).toBe("minute");
  until(r, () => clock.typer.done());
  for (let i = 0; i < 3; i++) press(r, "up");
  press(r, "down");
  press(r, "up");
  expect(clock.minute).toBe(3);
  if (shots) await shot(r, "initclock_minute");
  press(r, "a");
  until(r, () => clock.typer.done());
  expect(clock.phase).toBe("confirm-minute");
  press(r, "a");
  expect(clock.phase).toBe("response");
  until(r, () => clock.typer.done());
  expect(clock.pageText()).toBe("DAY 12:03!\nYikes! I over-");
  if (shots) await shot(r, "initclock_response");
  press(r, "a");
  until(r, () => clock.typer.done());
  press(r, "a");
  // the outBlack fade, then the speech pops it
  until(r, () => topName(r) !== "InitClock");
  expect(Clock.isSet(r.game.save)).toBe(true);
}

/** From the end of InitClock to the NamePick menu, with the beat shots. */
async function speechToNamePick(r: Rig, shots: boolean): Promise<OakSpeech> {
  const speech = speechOf(r);
  expect(topName(r)).toBe("OakSpeech");
  // inBlack + outWhite, then Oak's rotate reveal
  until(r, () => speech.picReveal != null);
  expect(speech.pic).toBe(speech.oakPic);
  expect(speech.picReveal!.kind).toBe("rotate");
  idle(r, 25);
  if (shots) await shot(r, "oak_rotate");
  until(r, () => topName(r) === "TextBox");
  idle(r, 40);
  if (shots) await shot(r, "oak_1");
  // OakText1 through to the Marill wipe
  until(r, () => speech.picReveal?.kind === "wipe", "a");
  expect(speech.pic).toBe(speech.marillPic);
  idle(r, 8);
  if (shots) await shot(r, "oak_marill_wipe");
  until(r, () => topName(r) === "TextBox");
  idle(r, 40);
  expect(speech.pic).toBe(speech.marillPic);
  if (shots) await shot(r, "oak_marill");
  // OakText2, OakText4, back to Oak for OakText5, then the player
  until(r, () => speech.steps![speech.step - 1]!.id === "oak_study", "a");
  until(r, () => speech.steps![speech.step - 1]!.id === "ask_player_name", "a");
  expect(speech.pic).toBe(speech.playerPic);
  until(r, () => topName(r) === "TextBox");
  idle(r, 60);
  if (shots) await shot(r, "oak_player");
  until(r, () => topName(r) === "NamePick", "a");
  const pick: NamePick = r.game.stack.top();
  expect(pick.slide).toBe("in");
  idle(r, 3);
  if (shots) await shot(r, "namepick_slide");
  until(r, () => pick.slide == null);
  expect(pick.picX).toBe(13);
  expect(pick.items).toEqual(["NEW NAME", "GOLD", "HIRO", "TAYLOR", "KARL"]);
  return speech;
}

/** From the name to the speech's exit, through OakText7 and the shrink. */
async function speechToEnd(r: Rig, shots: boolean): Promise<void> {
  const speech = speechOf(r);
  until(r, () => speech.shrink != null, "a");
  expect(topName(r)).toBe("OakSpeech");
  until(r, () => speech.shrink!.frame >= OakSpeech.SHRINK_PIC2);
  expect(speech.pic).toBe(speech.shrinkPic2);
  if (shots) await shot(r, "oak_shrink");
  until(r, () => speech.shrink!.frame >= OakSpeech.SHRINK_ICON);
  expect(speech.pic).toBeNull();
  expect(speech.playerIcon).not.toBeNull();
  if (shots) await shot(r, "oak_shrink_icon");
  until(r, () => r.worldStarted > 0);
  expect(speech.finished).toBe(true);
  expect(r.game.stack.top()).toBeUndefined();
}

describe("gen2 Oak speech", () => {
  test.skipIf(!gold)("Game2.showOakSpeech: clock, Oak, Marill, the player, a preset name, the shrink, onDone", async () => {
    const r = await rig();
    const { game } = r;
    game.showOakSpeech();
    expect(topName(r)).toBe("InitClock");
    const speech = speechOf(r);
    expect(speech.steps!.map((s) => s.id)).toEqual([
      "init_clock", "oak_welcome", "demo_mon", "world_spiel", "oak_study",
      "ask_player_name", "name_player", "legend", "shrink",
    ]);
    expect(speech.oakPic?.key).toBe("intro/oak");
    expect(speech.marillPic?.key).toBe("battle/front/marill");
    expect(speech.playerPic?.key).toBe("intro/cal");
    expect(speech.oakColors).toBeDefined();
    await setClock(r, true);
    await speechToNamePick(r, true);
    const pick: NamePick = game.stack.top();
    await shot(r, "namepick");
    // B is STATICMENU_DISABLE_B
    press(r, "b");
    expect(game.stack.top()).toBe(pick);
    press(r, "down");
    press(r, "down");
    expect(pick.cursor).toBe(3);
    await shot(r, "namepick_hiro");
    press(r, "a");
    expect(pick.slide).toBe("out");
    until(r, () => topName(r) !== "NamePick");
    expect(game.save.player.name).toBe("HIRO");
    expect(speech.answers.name).toBe("HIRO");
    // OakText7 says the name back
    until(r, () => topName(r) === "TextBox");
    idle(r, 30);
    await shot(r, "oak_legend");
    await speechToEnd(r, true);
    expect(r.worldStarted).toBe(1);
  }, 60000);

  test.skipIf(!gold)("NEW NAME: the keyboard types a custom name, case switch, DEL, END", async () => {
    const r = await rig();
    const { game } = r;
    game.showOakSpeech();
    await setClock(r, false);
    await speechToNamePick(r, false);
    press(r, "a");
    expect(topName(r)).toBe("NamingScreen");
    const ns: NamingScreen = game.stack.top();
    expect(ns.prompt).toBe("YOUR NAME?");
    expect(ns.maxLength).toBe(7);
    expect(ns.iconImage?.key).toBe("sprites/chris");
    await shot(r, "naming_empty");
    typeChar(r, "I");
    // SELECT: lower case
    press(r, "select");
    expect(ns.lower).toBe(true);
    typeChar(r, "s");
    typeChar(r, "a");
    typeChar(r, "z");
    // B deletes
    press(r, "b");
    typeChar(r, "a");
    typeChar(r, "c");
    expect(ns.text).toBe("Isaac");
    await shot(r, "naming");
    // the bottom row: DEL on the board, then the case switch back
    press(r, "start");
    expect(ns.cursorCharacter()).toBe("END");
    press(r, "left");
    expect(ns.cursorCharacter()).toBe("DEL");
    await shot(r, "naming_del");
    press(r, "left");
    expect(ns.cursorCharacter()).toBe("CASE");
    press(r, "a");
    expect(ns.lower).toBe(false);
    await shot(r, "naming_upper");
    press(r, "start");
    press(r, "a");
    expect(topName(r)).not.toBe("NamingScreen");
    expect(game.save.player.name).toBe("Isaac");
    expect(speechOf(r).answers.name).toBe("Isaac");
    await speechToEnd(r, false);
  }, 60000);

  test.skipIf(!gold)("a full name parks the cursor on END; an empty name keeps the preset", async () => {
    const r = await rig();
    const { game } = r;
    const names: string[] = [];
    const pick = Screens.push(game, "Gen2NamePick", { font: game.fontData, onDone: (n: string) => names.push(n) });
    until(r, () => pick.slide == null);
    press(r, "a");
    const ns: NamingScreen = game.stack.top();
    for (let i = 0; i < 7; i++) {
      press(r, "a");
      if (i < 6) expect(ns.onBottomRow()).toBe(false);
    }
    expect(ns.text).toBe("AAAAAAA");
    expect(ns.cursorCharacter()).toBe("END");
    for (let i = 0; i < 7; i++) press(r, "b");
    press(r, "a");
    expect(names).toEqual(["GOLD"]);
  });
});

describe("gen2 InitClock", () => {
  test.skipIf(!gold)("autoConfirm walks itself to the exit and anchors the clock at 10:00", async () => {
    const r = await rig();
    const { game } = r;
    let got: number[] | null = null;
    Screens.push(game, "Gen2InitClock", { mode: "clock", autoConfirm: true, onDone: (h: number, m: number) => { got = [h, m]; } });
    until(r, () => got != null, undefined, 50);
    expect(got!).toEqual([10, 0]);
    expect(InitClock.hourString(0)).toBe("NITE 12");
    expect(InitClock.responseKey(10)).toBe("overslept");
    expect(InitClock.responseKey(11)).toBe("yikes");
    expect(InitClock.responseKey(3)).toBe("soDark");
  });

  test.skipIf(!gold)("day mode: the weekday wheel wraps, confirms and writes the day", async () => {
    const r = await rig();
    const { game } = r;
    game.stack.clear();
    game.phase = "play";
    let day: number | null = null;
    const clock: InitClock = Screens.push(game, "Gen2InitClock", { mode: "day", onDone: (d: number) => { day = d; } });
    expect(clock.isOpaque).toBe(false);
    expect(clock.phase).toBe("day");
    press(r, "down");
    expect(clock.day).toBe(6);
    press(r, "up");
    press(r, "up");
    expect(clock.day).toBe(1);
    // drawn over a white panel, as Mom's house would sit under it
    game.phase = "boot";
    await shot(r, "initclock_day");
    press(r, "a");
    expect(clock.phase).toBe("confirm-day");
    press(r, "a");
    expect(day!).toBe(1);
    expect(game.save.rtc.dayOfWeek).toBe(1);
  });
});

describe("gen2 GenderSelect", () => {
  test.skipIf(!gold)("types its question, opens the menu, Girl writes wPlayerGender", async () => {
    const r = await rig();
    const { game } = r;
    game.stack.clear();
    let gender: string | null = null;
    const gs: GenderSelect = Screens.push(game, "Gen2GenderSelect", { save: game.save, fades: true, onDone: (g: string) => { gender = g; } });
    until(r, () => gs.menuOpen());
    await shot(r, "gender");
    press(r, "b");
    expect(gs.cursor).toBe(1);
    press(r, "down");
    press(r, "a");
    until(r, () => gender != null);
    expect(gender!).toBe("female");
    expect(game.save.player.gender).toBe("female");
  });
});
