// Group D services screens (voxelmon/game/gen2/ui/): DayCareMenu, the mail
// screens (MailCompose, MailRead, MailMenu, MailboxMenu), ElevatorMenu,
// DecorationMenu, PhotoStudio, UnownPrinter, MagnetTrainRide, ContestMenu,
// MoveTutor and BuenaPassword, on a real Game2 and the Gold screen.

import { afterEach, describe, expect, test } from "bun:test";
import { gold, mon, rig, standIns, type Rig } from "./gen2-ui-d-harness.ts";
import { loadGenerated } from "../voxelmon/game/gen2/platform/data.ts";
import { Font } from "../voxelmon/game/gen2/shared/render/Font.ts";
import { Mail } from "../voxelmon/game/gen2/core/Mail.ts";
import { Breeding } from "../voxelmon/game/gen2/core/Breeding.ts";
import { Decorations } from "../voxelmon/game/gen2/core/Decorations.ts";
import { Chrome } from "../voxelmon/game/gen2/ui/Chrome.ts";
import { Typer } from "../voxelmon/game/gen2/ui/Typer.ts";
import { PartyMenu } from "../voxelmon/game/gen2/ui/PartyMenu.ts";
import { DayCareMenu } from "../voxelmon/game/gen2/ui/DayCareMenu.ts";
import { MailCompose } from "../voxelmon/game/gen2/ui/MailCompose.ts";
import { MailRead } from "../voxelmon/game/gen2/ui/MailRead.ts";
import { MailMenu } from "../voxelmon/game/gen2/ui/MailMenu.ts";
import { MailboxMenu } from "../voxelmon/game/gen2/ui/MailboxMenu.ts";
import { ElevatorMenu } from "../voxelmon/game/gen2/ui/ElevatorMenu.ts";
import { DecorationMenu } from "../voxelmon/game/gen2/ui/DecorationMenu.ts";
import { PhotoStudio } from "../voxelmon/game/gen2/ui/PhotoStudio.ts";
import { UnownPrinter } from "../voxelmon/game/gen2/ui/UnownPrinter.ts";
import { MagnetTrainRide } from "../voxelmon/game/gen2/ui/MagnetTrainRide.ts";
import { ContestMenu } from "../voxelmon/game/gen2/ui/ContestMenu.ts";
import { MoveTutor } from "../voxelmon/game/gen2/ui/MoveTutor.ts";
import { BuenaPassword } from "../voxelmon/game/gen2/ui/BuenaPassword.ts";

if (gold) standIns();

/** The text on screen row `ty`, read back through the font's glyph tiles. */
function rowText(r: Rig, ty: number, x0 = 0, x1 = 20): string {
  const byTile = new Map<number, string>();
  for (const ch of "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789:?!./'") {
    const code = Font.encode(ch)[0];
    const tile = code === undefined ? undefined : Font.tileOf(code);
    if (tile !== undefined) byTile.set(tile, ch);
  }
  let s = "";
  for (let x = x0; x < x1; x++) s += byTile.get(r.lcd.s.cells[ty * 32 + x]!) ?? " ";
  return s;
}

/** Let a typing page finish, then press A once. */
function advance(r: Rig, screen: any, button: "a" | "b" = "a"): void {
  for (let i = 0; i < 600 && Typer.typing(screen); i++) r.idle(1);
  r.press(button);
}

// PartyMenu belongs to another agent and may still be a stub: a test-only
// stand-in records the opts it was opened with, draws a box, and lets the
// test answer onChoose / onCancel itself.
const realPartyNew = (PartyMenu as any).new;
let opened: any[] = [];
function fakeParty(): void {
  opened = [];
  (PartyMenu as any).new = (_game: any, opts: any) => {
    const st = {
      isOpaque: true,
      opts,
      update() {},
      drawPanel() {
        Chrome.clear();
        Chrome.textbox(0, 12, 18, 4);
        Chrome.print("Choose a #MON.", 1, 14);
      },
      draw() {
        st.drawPanel();
      },
    };
    opened.push(st);
    return st;
  };
}
afterEach(() => {
  (PartyMenu as any).new = realPartyNew;
});

function partyOf(r: Rig, ...species: [string, number][]): any[] {
  const party = species.map(([s, l]) => mon(r.game, s, l));
  r.game.save.party = party;
  r.game.save.player = r.game.save.player || {};
  r.game.save.player.name = r.game.save.player.name || "GOLD";
  return party;
}

describe("gen2 Day-Care", () => {
  test.skipIf(!gold)("deposit: a party mon moves into the day-care slot and the party shrinks", async () => {
    const r = await rig({ seed: 7 });
    const { game } = r;
    fakeParty();
    partyOf(r, ["CYNDAQUIL", 12], ["PIDGEY", 7]);
    let closed: number | undefined;
    const menu = DayCareMenu.new(game, { side: "man", onClose: (v) => (closed = v) });
    game.stack.push(menu);
    // the first meeting is the longer egg script (seven pages)
    expect(menu.confirm!.pages.length).toBe(7);
    for (let i = 0; i < 600 && Typer.typing(menu); i++) r.idle(1);
    await r.shot("d_daycare");
    for (let i = 0; i < 6; i++) advance(r, menu);
    for (let i = 0; i < 600 && Typer.typing(menu); i++) r.idle(1);
    expect(menu.yesNoVisible()).toBe(true);
    await r.shot("d_daycare_yesno");
    // YES -> "What should I raise for you?" -> the party list
    r.press("a");
    expect(menu.message).not.toBeNull();
    advance(r, menu);
    expect(opened.length).toBe(1);
    expect(opened[0].opts.prompt).toBe("choose");
    opened[0].opts.onChoose(1);
    // "OK. I'll raise your CYNDAQUIL."
    expect(game.save.party.length).toBe(1);
    expect(game.save.party[0].species).toBe("PIDGEY");
    expect(Breeding.side(game.save, "man")!.mon!.species).toBe("CYNDAQUIL");
    for (let i = 0; i < 600 && Typer.typing(menu); i++) r.idle(1);
    await r.shot("d_daycare_deposit");
    expect(rowText(r, 16).trim()).toContain("CYNDAQUIL");
    advance(r, menu);
    advance(r, menu); // "Come back for it later."
    expect(closed).toBe(0);
  });

  test.skipIf(!gold)("withdraw opens on the price question; outside says not yet", async () => {
    const r = await rig({ seed: 8 });
    const { game } = r;
    partyOf(r, ["CYNDAQUIL", 12], ["PIDGEY", 7]);
    Breeding.deposit(game.data, game.save, "lady", 1);
    const menu = DayCareMenu.new(game, { side: "lady" });
    game.stack.push(menu);
    expect(menu.grown).toBe(0);
    for (let i = 0; i < 600 && Typer.typing(menu); i++) r.idle(1);
    await r.shot("d_daycare_withdraw");
    expect(rowText(r, 14, 1, 19).trim()).toBe("Huh? Back already?");
    game.stack.clear();
    let closed = false;
    const out = DayCareMenu.new(game, { side: "outside", onClose: () => (closed = true) });
    game.stack.push(out);
    advance(r, out);
    expect(closed).toBe(true);
  });
});

describe("gen2 mail", () => {
  test.skipIf(!gold)("compose through the keyboard, confirm, the record holds it, MailRead shows it", async () => {
    const r = await rig();
    const { game } = r;
    const [lead] = partyOf(r, ["CYNDAQUIL", 12]);
    lead.item = "FLOWER_MAIL";
    let message: string | undefined;
    const compose = MailCompose.new(game, { onDone: (m) => (message = m) });
    game.stack.push(compose);
    // H E L L O on the 10-wide upper grid
    const typeAt = (col: number, row: number) => {
      while (compose.row !== row) r.press(compose.row < row ? "down" : "up");
      while (compose.col !== col) r.press(compose.col < col ? "right" : "left");
      r.press("a");
    };
    typeAt(7, 0);
    typeAt(4, 0);
    typeAt(1, 1);
    typeAt(1, 1);
    typeAt(4, 1);
    expect(compose.text).toBe("HELLO");
    // B deletes, then retype
    r.press("b");
    expect(compose.text).toBe("HELL");
    typeAt(4, 1);
    // SELECT: lower case; "!" is on the upper grid only
    r.press("select");
    expect(compose.lower).toBe(true);
    r.press("select");
    await r.shot("d_mailcompose");
    expect(rowText(r, 2, 2, 7)).toBe("HELLO");
    expect(rowText(r, 17, 1, 6)).toBe("lower");
    // START parks on END; A accepts
    r.press("start");
    expect(compose.cursorCharacter()).toBe("END");
    r.press("a");
    expect(message).toBe("HELLO");
    game.stack.pop();
    expect(Mail.compose(game.save, 1, message!, lead, "FLOWER_MAIL")).toBe(true);
    const entry = Mail.get(game.save, 1)!;
    expect(entry.message).toBe("HELLO");
    expect(entry.author).toBe(game.save.player.name);

    let closed = false;
    const read = MailRead.new(game, { entry, onClose: () => (closed = true) });
    game.stack.push(read);
    await r.shot("d_mailread");
    expect(rowText(r, 7, 2, 7)).toBe("HELLO");
    expect(rowText(r, 14, 5, 5 + entry.author.length)).toBe(entry.author);
    r.press("a");
    expect(closed).toBe(true);
  });

  test.skipIf(!gold)("MailMenu: READ pushes MailRead, TAKE sends to the PC", async () => {
    const r = await rig();
    const { game } = r;
    const [lead] = partyOf(r, ["CYNDAQUIL", 12]);
    lead.item = "FLOWER_MAIL";
    Mail.compose(game.save, 1, "HI THERE", lead, "FLOWER_MAIL");
    let closes = 0;
    const menu = MailMenu.new(game, { slot: 1, onClose: () => closes++ });
    game.stack.push(menu);
    await r.shot("d_mailmenu");
    expect(rowText(r, 12, 11, 15)).toBe("READ");
    r.press("a");
    expect(game.stack.top()).toBeInstanceOf(MailRead);
    r.press("b");
    expect(closes).toBe(1);
    expect(game.stack.top()).toBe(menu);
    // TAKE -> "Send the removed MAIL to your PC?" YES -> sent
    menu.index = 2;
    r.press("a");
    expect(menu.confirm).not.toBeNull();
    await r.shot("d_mailmenu_take");
    r.press("a");
    expect(Mail.mailboxCount(game.save)).toBe(1);
    expect(lead.item).toBeUndefined();
    r.press("a");
    expect(closes).toBe(2);
  });

  test.skipIf(!gold)("MailboxMenu: list of authors, submenu, CANCEL, B out; empty box says so", async () => {
    const r = await rig();
    const { game } = r;
    partyOf(r, ["CYNDAQUIL", 12]);
    const box = Mail.state(game.save).box;
    box.push(Mail.entry("FLOWER_MAIL", "HELLO", "MOM", 1), Mail.entry("SURF_MAIL", "SEE YOU", "ELM", 2));
    let closed = false;
    const menu = MailboxMenu.new(game, { onClose: () => (closed = true) });
    game.stack.push(menu);
    await r.shot("d_mailbox");
    expect(rowText(r, 3, 10, 13)).toBe("MOM");
    expect(rowText(r, 5, 10, 13)).toBe("ELM");
    r.press("down");
    r.press("a");
    expect(menu.submenu).not.toBeNull();
    await r.shot("d_mailbox_sub");
    r.press("down");
    r.press("down");
    r.press("down");
    r.press("a");
    expect(menu.submenu).toBeNull();
    r.press("b");
    expect(closed).toBe(true);

    game.stack.clear();
    box.length = 0;
    closed = false;
    const empty = MailboxMenu.new(game, { onClose: () => (closed = true) });
    game.stack.push(empty);
    r.press("a");
    expect(closed).toBe(true);
  });
});

describe("gen2 elevator, decorations, photo, stamps", () => {
  test.skipIf(!gold)("ElevatorMenu picks a floor; the floor you are on is a cancel", async () => {
    const r = await rig();
    const { game } = r;
    const floorNames = loadGenerated<any>("events").floorNames;
    const floors = [4, 5, 6, 7, 8, 15].map((floorId, i) => ({ floorId, destWarp: i + 1, destMap: `F${floorId}` }));
    let picked: any = "none";
    const menu = ElevatorMenu.new(game, { floors, currentMap: "F4", floorNames, onDone: (row) => (picked = row) });
    game.stack.push(menu);
    await r.shot("d_elevator");
    expect(rowText(r, 2, 1, 8)).toBe("Now on:");
    expect(rowText(r, 4, 4, 6)).toBe("1F");
    for (let i = 0; i < 5; i++) r.press("down");
    expect(menu.scroll).toBe(2);
    await r.shot("d_elevator_scrolled");
    r.press("up");
    r.press("up");
    r.press("up");
    r.press("a");
    expect(picked).toBe(floors[2]);
  });

  test.skipIf(!gold)("DecorationMenu: category, set up a bed, EXIT reports the change", async () => {
    const r = await rig();
    const { game } = r;
    const flags = new Map<number, boolean>();
    const events = { get: (f: number) => flags.get(f) ?? false, set: (f: number, v: boolean) => flags.set(f, v) };
    // the FEATHERY bed is InitDecorations' default, so own the PINK one
    for (const category of Decorations.CATEGORIES) Decorations.give(events, category.members[category.id === 1 ? 1 : 0]);
    let changed: boolean | undefined;
    const menu = DecorationMenu.new(game, { save: game.save, events, onDone: (c) => (changed = c) });
    game.stack.push(menu);
    expect(menu.categories.length).toBeGreaterThan(0);
    await r.shot("d_decoration");
    r.press("a");
    expect(menu.mode).toBe("items");
    await r.shot("d_decoration_items");
    r.press("a");
    expect(menu.pages).not.toBeNull();
    for (let i = 0; i < 600 && Typer.typing(menu); i++) r.idle(1);
    await r.shot("d_decoration_msg");
    for (let i = 0; i < 5 && menu.pages; i++) advance(r, menu);
    r.press("b");
    expect(menu.mode).toBe("category");
    r.press("up"); // wraps to EXIT
    r.press("a");
    expect(changed).toBe(true);
  });

  test.skipIf(!gold)("PhotoStudio draws the card and closes on A", async () => {
    const r = await rig();
    const { game } = r;
    const [lead] = partyOf(r, ["CYNDAQUIL", 12]);
    let closed = false;
    const card = PhotoStudio.new(game, { mon: lead, onClose: () => (closed = true) });
    game.stack.push(card);
    await r.shot("d_photo");
    expect(rowText(r, 9, 1, 4)).toBe("OT/");
    expect(rowText(r, 14, 1, 5)).toBe("MOVE");
    r.press("a");
    expect(closed).toBe(true);
  });

  test.skipIf(!gold)("UnownPrinter scrolls the 27-slot wheel and B leaves", async () => {
    const r = await rig();
    const { game } = r;
    let closed = false;
    const sheet = UnownPrinter.new(game, { onClose: () => (closed = true) });
    game.stack.push(sheet);
    await r.shot("d_unownprinter");
    r.press("right");
    expect(sheet.letter()).toBe(2);
    r.press("left");
    r.press("left");
    expect(sheet.letter()).toBeUndefined();
    await r.shot("d_unownprinter_vacant");
    expect(rowText(r, 9, 1, 7)).toBe("VACANT");
    r.press("a"); // no printer: a no-op
    expect(closed).toBe(false);
    r.press("b");
    expect(closed).toBe(true);
  });
});

describe("gen2 rides and minigame windows", () => {
  test.skipIf(!gold)("MagnetTrainRide runs to its end", async () => {
    const r = await rig();
    const { game } = r;
    game.save.player = game.save.player || {};
    let done = false;
    const ride = MagnetTrainRide.new(game, { toGoldenrod: true, onDone: () => (done = true) });
    game.stack.push(ride);
    let frames = 0;
    for (; frames < 4000 && !done; frames++) {
      r.idle(1);
      if (frames === 150) await r.shot("d_magnettrain");
      if (frames === 300) await r.shot("d_magnettrain_late");
    }
    expect(done).toBe(true);
    expect(frames).toBeGreaterThan(100);
  });

  test.skipIf(!gold)("MagnetTrainRide puts the 32-wide train map in the BG and the bands in per-line SCX", async () => {
    const r = await rig();
    const { game } = r;
    const ride: any = MagnetTrainRide.new(game, { toGoldenrod: true });
    // tilesets/train_station is not cooked into the Gold screen's pages (the
    // cook leaves map tilesets out), so stand in a sheet whose tile ids are
    // the tile numbers themselves: this checks placement, not art.
    const ids = Array.from({ length: 96 }, (_, i) => 1000 + i);
    const image = {
      key: "test/sheet", w: 128, h: 48, tw: 16, th: 6, ids, obj: false,
      getDimensions: () => [128, 48], getWidth: () => 128, getHeight: () => 48, release() {}, setFilter() {},
    };
    const quads: Record<number, any> = {};
    for (let t = 0; t < 96; t++) quads[t] = { x: (t % 16) * 8, y: Math.floor(t / 16) * 8, w: 8, h: 8 };
    ride.sheet = { image, quads, width: 128, height: 48 };
    game.stack.push(ride);
    r.idle(120);
    r.draw();
    const rows = ride.ride.tilemap();
    const s = r.lcd.s;
    // column 25 (off the 20-wide screen) row 0 is the repeated BG strip
    expect(s.cells[0 * 32 + 25]).toBe(1000 + rows[0][25]);
    // the train rows carry the BG-over-OBJ bit (OAM_PRIO's effect)
    expect(s.attrs[7 * 32 + 3]! & 0x80).toBe(0x80);
    expect(s.lineTarget).toBe(2);
    const bands = ride.ride.bands();
    for (const [top, , scx] of bands) expect(s.lines[top]).toBe(scx & 0xff);
    // the player is one object per on-screen OAM entry
    const onScreen = ride.ride.playerOam().filter((e: any) => e.x > -8 && e.x < 160 && e.y > -16 && e.y < 144);
    expect(s.objs.length).toBe(onScreen.length);
  });

  test.skipIf(!gold)("ContestMenu: B keeps the stock, YES switches", async () => {
    const r = await rig();
    const { game } = r;
    const stock = mon(game, "CATERPIE", 7);
    const caught = mon(game, "SCYTHER", 13);
    let kept: any;
    const menu = ContestMenu.new(game, { stock, caught, onClose: (k) => (kept = k) });
    game.stack.push(menu);
    await r.shot("d_contest");
    expect(rowText(r, 4, 5, 11)).toBe("HEALTH");
    r.press("b");
    expect(kept).toBe(stock);
    kept = undefined;
    menu.choice = 1;
    r.press("a");
    expect(kept).toBeDefined();
    expect(kept.species).toBe("SCYTHER");
  });

  test.skipIf(!gold)("MoveTutor opens the TM/HM party list, refuses an incompatible mon, cancels", async () => {
    const r = await rig();
    const { game } = r;
    fakeParty();
    const party = partyOf(r, ["CYNDAQUIL", 12], ["PIDGEY", 7]);
    let learned: boolean | undefined;
    const tutor = MoveTutor.new(game, { move: "CUT", moveName: "CUT", onDone: (l) => (learned = l) });
    game.stack.push(tutor);
    expect(opened[0].opts.tmhm.move).toBe("CUT");
    expect(MoveTutor.canLearn(tutor.view.CYNDAQUIL, "CUT")).toBe(true);
    expect(MoveTutor.canLearn(tutor.view.PIDGEY, "CUT")).toBe(false);
    // Gold's cache has no tutorMoves: Crystal's three tutor moves are not compatible
    expect(MoveTutor.canLearn(tutor.view.CYNDAQUIL, "FLAMETHROWER")).toBe(false);
    await r.shot("d_movetutor");
    opened[0].opts.onChoose(2, party[1]);
    expect(game.stack.top()).not.toBe(tutor); // the refusal's text box
    game.stack.pop();
    opened[0].opts.onCancel();
    expect(learned).toBe(false);
    expect(game.stack.top()).toBeUndefined();
  });

  test.skipIf(!gold)("BuenaPassword: password answers zero-based; prize list scrolls and B is 0", async () => {
    const r = await rig();
    const { game } = r;
    let answer: number | undefined;
    const pw = BuenaPassword.new(game, { words: ["CYNDAQUIL", "TOTODILE", "CHIKORITA"], width: 9, onDone: (v) => (answer = v) });
    game.stack.push(pw);
    await r.shot("d_buena");
    r.press("b"); // STATICMENU_DISABLE_B
    expect(answer).toBeUndefined();
    r.press("down");
    r.press("a");
    expect(answer).toBe(1);

    const prizes = ["ULTRA BALL", "FULL RESTORE", "NUGGET", "RARE CANDY", "SUN STONE", "MOON STONE"].map((name, i) => ({ name, cost: i + 2 }));
    answer = undefined;
    const prize = BuenaPassword.new(game, { mode: "prize", prizes, balance: 10, onDone: (v) => (answer = v) });
    game.stack.push(prize);
    for (let i = 0; i < 5; i++) r.press("down");
    expect(prize.scroll).toBe(2);
    await r.shot("d_buena_prize");
    r.press("b");
    expect(answer as number | undefined).toBe(0);
  });
});
