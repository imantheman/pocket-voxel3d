// The Game Corner and Ruins of Alph minigames (voxelmon/game/gen2/ui/
// UnownPuzzle, PrizeMenu, CardFlip, SlotMachine) on a real Game2 and the
// Gold screen.

import { describe, expect, test } from "bun:test";
import { gold, rig, standIns } from "./gen2-ui-d-harness.ts";
import { UnownPuzzle } from "../voxelmon/game/gen2/ui/UnownPuzzle.ts";
import { PrizeMenu } from "../voxelmon/game/gen2/ui/PrizeMenu.ts";
import { CardFlip } from "../voxelmon/game/gen2/ui/CardFlip.ts";
import { SlotMachine } from "../voxelmon/game/gen2/ui/SlotMachine.ts";
import { Bag } from "../voxelmon/game/gen2/shared/inventory/Bag.ts";
import { setGen2Source } from "../voxelmon/game/gen2/platform/data.ts";
import { GOLD_GEN_DIR } from "../voxelmon/game/gen2/platform/data-node.ts";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The importer's JSON tables plus the two minigame tilemaps as byte arrays:
 * the guest has no binary file channel, so the screens read
 * "card_flip.tilemap" / "gold_slots.tilemap" through loadGenerated.
 */
function withTilemaps(): void {
  const src: Record<string, unknown> = {};
  for (const f of readdirSync(GOLD_GEN_DIR)) {
    if (!f.endsWith(".json")) continue;
    const path = join(GOLD_GEN_DIR, f);
    let cached: string | undefined;
    Object.defineProperty(src, f.slice(0, -5), { enumerable: true, get: () => (cached ??= readFileSync(path, "utf8")) });
  }
  for (const rel of ["card_flip/card_flip.tilemap", "slots/gold_slots.tilemap"]) {
    const path = join(GOLD_GEN_DIR, rel);
    if (existsSync(path)) src[rel.replace(/^.*\//, "")] = Array.from(readFileSync(path));
  }
  setGen2Source(src);
}

/** A save holding the COIN CASE and `coins` coins. */
function coinCase(game: any, coins: number): void {
  const save = game.save;
  save.player = save.player || {};
  save.player.coins = coins;
  if (!(save.inventory && save.inventory.COIN_CASE)) Bag.add(save, "COIN_CASE", 1, game.data);
}

/** Press A until `done()` or `max` presses. */
function pressUntil(r: any, done: () => boolean, max = 20, button = "a"): void {
  for (let i = 0; i < max && !done(); i++) r.press(button, 2);
}

standIns();

describe("gen2 Unown puzzle", () => {
  test.skipIf(!gold)("deals the ring, picks a panel up and puts it down inside", async () => {
    const r = await rig({ seed: 77 });
    const { game, lcd } = r;
    let closed: boolean | undefined;
    const puzzle = UnownPuzzle.new(game, { puzzle: 0, onClose: (s) => { closed = s; } });
    game.stack.push(puzzle);
    // a fresh board: all sixteen panels on the ring, interior empty
    const placed = puzzle.pieces.filter((p) => p !== 0).length;
    expect(placed).toBe(16);
    for (const cell of UnownPuzzle.START_CELLS) expect(puzzle.pieces[cell]).not.toBe(0);
    await r.shot("d_puzzle");
    // the board is drawn: the frame at (0,0) and a panel tile at cell 0's corner
    expect(lcd.s.cells[0]).not.toBe(0);
    const before = puzzle.pieces.slice();
    const piece = puzzle.pieces[0]!;
    r.press("a", 2);
    expect(puzzle.holding).toBe(true);
    expect(puzzle.held).toBe(piece);
    expect(puzzle.pieces[0]).toBe(0);
    r.press("down", 2);
    r.press("right", 2);
    expect(puzzle.cursor).toBe(UnownPuzzle.puzcoord(1, 1));
    await r.shot("d_puzzle_held");
    r.press("a", 2);
    expect(puzzle.holding).toBe(false);
    expect(puzzle.pieces[UnownPuzzle.puzcoord(1, 1)]).toBe(piece);
    expect(puzzle.pieces).not.toEqual(before);
    // pick it back up; an occupied ring cell then refuses the drop
    r.press("a", 2);
    expect(puzzle.holding).toBe(true);
    r.press("up", 2);
    r.press("a", 2);
    expect(puzzle.holding).toBe(true);
    // START quits unsolved
    r.press("start", 2);
    expect(closed).toBe(false);
  });

  test("cursor rules: row 5 jumps the caption box, row 4 interior cannot go down", () => {
    expect(UnownPuzzle.moveCursor(35, "left")).toBe(30);
    expect(UnownPuzzle.moveCursor(30, "right")).toBe(35);
    expect(UnownPuzzle.moveCursor(UnownPuzzle.puzcoord(4, 2), "down")).toBeNull();
    expect(UnownPuzzle.moveCursor(2, "up")).toBeNull();
    const solved = UnownPuzzle.SOLVED.slice();
    expect(UnownPuzzle.isSolved(solved)).toBe(true);
    solved[7] = 0;
    expect(UnownPuzzle.isSolved(solved)).toBe(false);
  });
});

describe("gen2 prize counters", () => {
  test.skipIf(!gold)("Celadon TM counter: intro, menu, confirm, TM32 for 1500 coins, then CANCEL", async () => {
    const r = await rig({ seed: 5 });
    const { game } = r;
    coinCase(game, 2000);
    let closed = false;
    const menu = PrizeMenu.new(game, { counter: "CELADON_TM", onClose: () => { closed = true; } });
    game.stack.push(menu);
    expect(menu.hasCoinCase).toBe(true);
    await r.shot("d_prize_intro");
    pressUntil(r, () => menu.phase === "menu");
    expect(menu.phase).toBe("menu");
    expect(menu.prizes.map((p) => p.id ?? "CANCEL")).toEqual(["TM_DOUBLE_TEAM", "TM_PSYCHIC_M", "TM_HYPER_BEAM", "CANCEL"]);
    await r.shot("d_prize");
    r.press("a", 2);
    expect(menu.confirm).toBeTruthy();
    await r.shot("d_prize_confirm");
    r.press("a", 2);
    expect(game.save.player.coins).toBe(500);
    expect(game.save.inventory.TM_DOUBLE_TEAM).toBe(1);
    // "Here you go!" then back to the menu; TM29 is now too dear
    pressUntil(r, () => menu.phase === "menu" && !menu.message);
    r.press("down", 2);
    r.press("a", 2);
    expect(menu.message).toBeTruthy();
    pressUntil(r, () => closed);
    expect(closed).toBe(true);
    expect(game.save.player.coins).toBe(500);
  });

  test.skipIf(!gold)("Goldenrod mon counter: ABRA joins the party for 200 coins", async () => {
    const r = await rig({ seed: 6 });
    const { game } = r;
    coinCase(game, 250);
    game.save.party = [];
    const menu = PrizeMenu.new(game, { counter: "GOLDENROD_MON", texts: "GOLDENROD", version: "gold" });
    game.stack.push(menu);
    pressUntil(r, () => menu.phase === "menu");
    await r.shot("d_prize_mon");
    r.press("a", 2);
    expect(menu.confirm).toBeTruthy();
    r.press("a", 2);
    expect(game.save.player.coins).toBe(50);
    expect(game.save.party.length).toBe(1);
    expect(game.save.party[0].species).toBe("ABRA");
    expect(game.save.pokedex.caught.ABRA).toBe(true);
  });

  test("refusal order: the coin vendor checks the case before the wallet", () => {
    const save: any = { player: { coins: 9990, money: 0 }, inventory: {} };
    expect(PrizeMenu.check(save, PrizeMenu.COUNTERS.COIN_VENDOR!, PrizeMenu.COUNTERS.COIN_VENDOR!.prizes[0]!)).toBe("room");
    save.player.coins = 0;
    expect(PrizeMenu.check(save, PrizeMenu.COUNTERS.COIN_VENDOR!, PrizeMenu.COUNTERS.COIN_VENDOR!.prizes[0]!)).toBe("money");
    save.player.money = 1000;
    expect(PrizeMenu.buy(save, PrizeMenu.COUNTERS.COIN_VENDOR!, PrizeMenu.COUNTERS.COIN_VENDOR!.prizes[0]!)).toBe("ok");
    expect(save.player.coins).toBe(50);
    expect(save.player.money).toBe(0);
  });
});

describe("gen2 card flip", () => {
  test.skipIf(!gold)("one round: bet 3, pick a card, bet its Pokemon, reveal, 12 coins settle", async () => {
    const r = await rig({ seed: 99 });
    withTilemaps();
    const { game } = r;
    coinCase(game, 10);
    let closed = false;
    const cf = CardFlip.new(game, { onClose: () => { closed = true; } });
    game.stack.push(cf);
    expect(cf.phase).toBe("ask");
    await r.shot("d_cardflip_ask");
    r.press("a", 1);
    expect(game.save.player.coins).toBe(7);
    expect(cf.phase).toBe("choose");
    await r.shot("d_cardflip_deal");
    r.press("a", 1);
    expect(cf.phase).toBe("bet");
    const card = CardFlip.dealt(cf.deck, cf.played, cf.which);
    // up to the single-Pokemon row, then across to the card's Pokemon
    r.press("up", 1);
    expect([cf.cursorX, cf.cursorY]).toEqual([2, 1]);
    for (let i = 0; i < CardFlip.mon(card); i++) r.press("right", 1);
    expect(cf.cursorX).toBe(2 + CardFlip.mon(card));
    await r.shot("d_cardflip_bet");
    r.press("a", 1);
    expect(cf.faceUp).toBe(card);
    expect(cf.discarded[card]).toBe(true);
    for (let i = 0; i < 200 && cf.phase !== "result"; i++) r.idle(1);
    expect(cf.phase).toBe("result");
    expect(game.save.player.coins).toBe(7 + CardFlip.PAYOUT_MON);
    await r.shot("d_cardflip_reveal");
    r.press("a", 1);
    expect(cf.phase).toBe("again");
    r.press("b", 1);
    expect(closed).toBe(true);
  });

  test("payout ladder and shuffle", () => {
    // PIKACHU level 1 is card 0; ODDISH level 6 is card 23
    expect(CardFlip.payout(2, 2, 0)).toBe(72);
    expect(CardFlip.payout(2, 1, 0)).toBe(12);
    expect(CardFlip.payout(3, 0, 1)).toBe(6);
    expect(CardFlip.payout(0, 3, 4)).toBe(9);
    expect(CardFlip.payout(1, 7, 23)).toBe(18);
    expect(CardFlip.payout(0, 0, 0)).toBe(0);
    let n = 0;
    const deck = CardFlip.shuffle((k) => (n++ * 7) % k);
    expect(deck.slice().sort((a, b) => a - b)).toEqual(Array.from({ length: 24 }, (_, i) => i));
  });
});

describe("gen2 slot machine", () => {
  /** Bet 3, let it spin, stop all three reels, count the payout out. */
  async function playOne(seed: number, shots: boolean) {
    const r = await rig({ seed });
    withTilemaps();
    const { game } = r;
    coinCase(game, 100);
    let closed = false;
    const sm = SlotMachine.new(game, { onClose: () => { closed = true; } });
    game.stack.push(sm);
    expect(sm.phase).toBe("bet");
    if (shots) await r.shot("d_slots_idle");
    r.press("a", 1);
    expect(sm.bet).toBe(3);
    expect(game.save.player.coins).toBe(97);
    expect(sm.phase).toBe("spinning");
    r.idle(40);
    if (shots) await r.shot("d_slots_spin");
    for (let reel = 1; reel <= 3; reel++) {
      expect(sm.reel).toBe(reel);
      r.press("a", 1);
      expect(sm.stops[reel - 1]).not.toBeNull();
      for (let i = 0; i < 3000 && sm.phase === "spinning" && sm.reel === reel; i++) r.idle(1);
    }
    expect(sm.phase).not.toBe("spinning");
    const windows = [sm.reelWindow(1), sm.reelWindow(2), sm.reelWindow(3)];
    expect(sm.stopped).toEqual(windows);
    const matched = SlotMachine.matchAll(3, windows[0]!, windows[1]!, windows[2]!);
    expect(sm.matched).toBe(matched);
    for (let i = 0; i < 40 && sm.phase === "flash"; i++) r.idle(1);
    if (shots) await r.shot("d_slots_result");
    // a loss waits for A; a win counts out one coin every other frame
    for (let i = 0; i < 1000 && sm.phase === "payoutText"; i++) {
      if (matched === SlotMachine.NO_MATCH) r.press("a", 1);
      else r.idle(1);
    }
    expect(sm.phase).toBe("again");
    const coins = game.save.player.coins;
    expect(coins).toBe(97 + SlotMachine.payout(matched));
    if (shots) await r.shot("d_slots_again");
    r.press("down", 1);
    r.press("a", 1);
    expect(closed).toBe(true);
    return { coins, matched, positions: sm.positions.slice(), bias: sm.bias, action: sm.reel3Action };
  }

  test.skipIf(!gold)("bet 3, spin, stop all three reels: a deterministic, table-consistent result", async () => {
    const a = await playOne(4242, true);
    const b = await playOne(4242, false);
    expect(b).toEqual(a);
  });

  test("the pure spin pays exactly the table for the line it lands", () => {
    let state = 12345;
    const random = (n: number) => {
      state = (Math.imul(state, 1103515245) + 12345) >>> 0;
      return (state >>> 16) % n;
    };
    let wins = 0;
    for (let k = 0; k < 2000; k++) {
      const bet = 1 + (k % 3);
      const res = SlotMachine.spin({ random, bet, stops: [k % 15, (k * 7) % 15, (k * 11) % 15] });
      const matched = SlotMachine.matchAll(bet, res.windows[0], res.windows[1], res.windows[2]);
      expect(res.matched).toBe(matched);
      expect(res.payout).toBe(SlotMachine.payout(matched));
      if (matched !== SlotMachine.NO_MATCH) wins++;
      // with no bias and no reel-3 theatre the third reel refuses every line
      if (res.bias === SlotMachine.NO_BIAS && res.reel3Action === SlotMachine.REEL3_STOP) {
        expect(matched).toBe(SlotMachine.NO_MATCH);
      }
    }
    expect(wins).toBeGreaterThan(0);
    expect(SlotMachine.payout(SlotMachine.SEVEN)).toBe(300);
    expect(SlotMachine.window(SlotMachine.REELS[0]!, 0)).toEqual([SlotMachine.SQUIRTLE, SlotMachine.SEVEN, SlotMachine.CHERRY]);
  });
});
