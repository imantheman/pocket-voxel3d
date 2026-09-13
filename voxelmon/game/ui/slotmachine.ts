// The GAME CORNER slot machine (engine/slots/slot_machine.asm), ported from
// gen1recomp src/ui/SlotMachine.lua.
//
// Wheels are the ROM's own symbol strips (field.slotWheels, 15 symbols plus
// 3 wraparound entries, read like SlotMachine_GetWheelTiles). Positions are
// kept in pokered's HALF-symbol offsets (wSlotMachineWheelXOffset, 0..29): a
// wheel may only stop when its offset is odd — that is when a symbol is
// centred — and every animation step advances by one, so slips scroll past
// tile by tile the way they do on the GB.
//
// Per-wheel stop rules:
//  * wheel 1 spends one of 4 slip charges at each centred position and stops
//    unless the centred middle symbol is a CHERRY. In seven-and-bar mode the
//    early-stop test is pokered's own bug (`cp HIGH(SLOTS7)` / `jr c`, never
//    true), so it slips all four every time. The bug is the behaviour.
//  * wheel 2 stops as soon as wheels 1 and 2 line up any possible payline;
//    in seven-and-bar mode it instead waits for a 7 or BAR. Also 4 slips.
//  * wheel 3 stops at the next centred position, and then the match check
//    rerolls it one symbol at a time — past a match the luck flags forbid,
//    or toward one while the reroll counter lasts.
//
// Hidden luck (SlotMachine_SetFlags): one machine per Game Corner visit is
// "lucky", which only changes the seven-and-bar chance (5/256 vs 2/256). Per
// spin: 1/256 arms 60 guaranteed-winnable spins, r > chance arms seven-and-bar
// mode (sticky until a BAR win clears it, or a 300 win does half the time),
// r > 210 allows a match, and the rest cannot win at all.
import type { GameState } from "../game.ts";
import type { Rng } from "../rng.ts";

/** SlotReward*Func. Anything that is not 7/BAR/CHERRY pays 15. */
const PAYOUT: Record<string, number> = {
  "7": 300, BAR: 100, CHERRY: 8, MOUSE: 15, FISH: 15, BIRD: 15,
};

/**
 * Paylines in pokered's check order (SlotMachine_CheckForMatches): a 3-coin
 * bet tries both diagonals first, then falls into the 2-coin rows, then the
 * 1-coin middle. The FIRST match wins. Entries are row offsets from the
 * bottom, per wheel.
 */
const LINES: { rows: [number, number, number]; bet: number }[] = [
  { rows: [0, 1, 2], bet: 3 },
  { rows: [2, 1, 0], bet: 3 },
  { rows: [2, 2, 2], bet: 2 },
  { rows: [0, 0, 0], bet: 2 },
  { rows: [1, 1, 1], bet: 1 },
];

/** One animation step every other frame; 20 free steps before input is read. */
const STEP_FRAMES = 2;
const SPINUP_STEPS = 20;
const COIN_CAP = 9999;

export type SlotStage =
  | "intro" | "bet" | "spinup" | "spin" | "reroll"
  | "flash" | "message" | "payout" | "onemore";

export interface SlotView {
  stage: SlotStage;
  /** The 3x3 window: [wheel][row], row 0 top. */
  grid: string[][];
  bet: number;
  betIndex: number;
  coins: number;
  payout: number;
  message: string | null;
  yesno: number;
  /** The win flash, so the screen can invert with it. */
  flash: boolean;
  /**
   * field.slotSymbols.order — the symbol names in the order the cook laid
   * their tiles out, so the renderer can turn a grid name into a tile without
   * reaching for the dataset itself.
   */
  order: string[];
}

type Wheels = string[][];

/** wheel[pos + off], wrapping — SlotMachine_GetWheelTiles. */
function at(wheel: string[], pos: number, off: number): string {
  return wheel[(((pos + off - 1) % wheel.length) + wheel.length) % wheel.length]!;
}

/** bottom, middle, top at a centred position. */
function rowsAt(wheel: string[], pos: number): [string, string, string] {
  return [at(wheel, pos, 0), at(wheel, pos, 1), at(wheel, pos, 2)];
}

export interface SlotWin {
  payout: number;
  symbol: string;
}

/** SlotMachine_CheckForMatches: the first matching line, or null. */
export function evaluate(wheels: Wheels, stops: number[], bet: number): SlotWin | null {
  for (const line of LINES) {
    if (bet < line.bet) continue;
    const a = at(wheels[0]!, stops[0]!, line.rows[0]);
    const b = at(wheels[1]!, stops[1]!, line.rows[1]);
    const c = at(wheels[2]!, stops[2]!, line.rows[2]);
    if (a === b && b === c) return { payout: PAYOUT[a] ?? 15, symbol: a };
  }
  return null;
}

/** SlotMachine_StopWheel1Early. */
export function stopWheel1Early(wheels: Wheels, pos1: number, sevenBar: boolean): boolean {
  if (sevenBar) return false;
  return rowsAt(wheels[0]!, pos1)[1] !== "CHERRY";
}

/**
 * SlotMachine_FindWheel1Wheel2Matches — can wheels 1 and 2 as placed still
 * line up a payline given a good wheel 3? Pairs in pokered's order. Returns
 * the match plus the wheel-2 tile DE points at afterwards (the matched one,
 * or wheel 2's bottom when nothing matched).
 */
export function findWheel1Wheel2Matches(
  wheels: Wheels, pos1: number, pos2: number,
): [boolean, string] {
  const [b1, m1, t1] = rowsAt(wheels[0]!, pos1);
  const [b2, m2, t2] = rowsAt(wheels[1]!, pos2);
  if (b2 === b1) return [true, b2];
  if (m2 === b1) return [true, m2];
  if (m2 === m1) return [true, m2];
  if (m2 === t1) return [true, m2];
  if (t2 === t1) return [true, t2];
  return [false, b2];
}

/** SlotMachine_StopWheel2Early. */
export function stopWheel2Early(
  wheels: Wheels, pos1: number, pos2: number, sevenBar: boolean,
): boolean {
  const [matched, tile] = findWheel1Wheel2Matches(wheels, pos1, pos2);
  if (sevenBar) return tile === "7" || tile === "BAR";
  return matched;
}

/**
 * One match decision: "accept" pays out, "roll" is a match the flags forbid
 * (roll wheel 3 on WITHOUT consuming the reroll counter), "nomatch" is
 * nothing lined up (the caller spends a reroll charge).
 */
export function checkForMatch(
  wheels: Wheels, stops: number[], bet: number, canWin: boolean, sevenBar: boolean,
): ["accept" | "roll" | "nomatch", SlotWin | null] {
  const win = evaluate(wheels, stops, bet);
  if (!win) return ["nomatch", null];
  if (!(canWin || sevenBar)) return ["roll", win];
  if (!sevenBar && (win.symbol === "7" || win.symbol === "BAR")) return ["roll", win];
  return ["accept", win];
}

interface SlotGame {
  input: { pressed: Partial<Record<string, boolean>> };
  pop(): void;
  save: { coins?: number };
  data: { field?: { slotWheels?: Wheels; slotSymbols?: { order?: string[] } } };
  playSfx?(name: string): void;
}

export class SlotMachineState implements GameState {
  readonly kind = "slots";
  private wheels: Wheels;
  private order: string[];
  stage: SlotStage = "intro";
  private yesno = 1; // 1 = YES
  private betIndex = 0;
  bet = 3;
  private payoutDisplay = 0;
  private flash = false;
  /** wSlotMachineWheelXOffset — 29 is where LoadSlotMachineTiles leaves them. */
  private offset = [29, 29, 29];
  private stopping = 0;
  private slip = [4, 4];
  private reroll = 4;
  private frame = 0;
  private message: string | null = null;
  private afterMessage: string | null = null;
  private exitTimer: number | null = null;
  private spinupSteps = 0;
  private rerollSteps = 0;
  private win: SlotWin | null = null;
  private payoutRemaining = 0;
  private flashLeft = 0;
  private flashTimer = 0;
  private dripFrames = 8;
  private dripTimer = 0;
  private dripFlash = 5;
  /** wSlotMachineSevenAndBarModeChance — the lucky machine's is 250, not 253. */
  private sevenBarChance: number;
  private allowMatches = 0;
  private canWin = false;
  private sevenBar = false;

  constructor(
    private game: SlotGame,
    private rng: Rng,
    lucky: boolean,
    private onDone?: () => void,
  ) {
    this.wheels = game.data.field?.slotWheels ?? [[], [], []];
    this.order = game.data.field?.slotSymbols?.order ?? [];
    this.sevenBarChance = lucky ? 250 : 253;
  }

  private coins(): number {
    return this.game.save.coins ?? 0;
  }

  private sfx(name: string): void {
    this.game.playSfx?.(name);
  }

  /** SlotMachine_SetFlags, rolled as each spin starts. Sticky once armed. */
  private setFlags(): void {
    if (this.sevenBar) return;
    if (this.allowMatches > 0) { this.canWin = true; return; }
    const r = this.rng.byte();
    if (r === 0) {
      // 1/256: arm 60 winnable spins. THIS spin's flags are left alone — the
      // asm returns before writing them.
      this.allowMatches = 60;
      return;
    }
    if (r > this.sevenBarChance) { this.sevenBar = true; return; }
    this.canWin = r > 210;
  }

  private animWheel(w: number): void {
    this.offset[w] = (this.offset[w]! + 1) % 30;
  }

  private stops(): number[] {
    return this.offset.map((o) => (o + 1) / 2);
  }

  /** SlotMachine_StopOrAnimWheel1/2. */
  private stopOrAnimWheel(w: number): void {
    if (this.stopping < w + 1) { this.animWheel(w); return; }
    const o = this.offset[w]!;
    if (o % 2 === 0) { this.animWheel(w); return; }
    if (this.slip[w] === 0) return; // stopped
    this.slip[w] = this.slip[w]! - 1;
    const stop = w === 0
      ? stopWheel1Early(this.wheels, (o + 1) / 2, this.sevenBar)
      : stopWheel2Early(this.wheels, (this.offset[0]! + 1) / 2, (o + 1) / 2, this.sevenBar);
    if (stop) { this.slip[w] = 0; return; }
    this.animWheel(w);
  }

  /** SlotMachine_StopOrAnimWheel3 — no slips; true when the spin is over. */
  private stopOrAnimWheel3(): boolean {
    if (this.stopping < 3) { this.animWheel(2); return false; }
    if (this.offset[2]! % 2 === 1) return true;
    this.animWheel(2);
    return false;
  }

  private checkForMatches(): void {
    const [action, win] = checkForMatch(
      this.wheels, this.stops(), this.bet, this.canWin, this.sevenBar,
    );
    if (action === "accept") { this.resolveWin(win!); return; }
    if (action === "nomatch") {
      if (!(this.canWin || this.sevenBar)) { this.resolveLose(); return; }
      this.reroll -= 1;
      if (this.reroll === 0) { this.resolveLose(); return; }
    }
    // .rollWheel3DownByOneSymbol: two half-steps, one per frame
    this.stage = "reroll";
    this.rerollSteps = 2;
  }

  private resolveWin(win: SlotWin): void {
    const { symbol: sym, payout: pay } = win;
    let flashes: number;
    if (sym === "7") {
      this.sfx("Get_Item2");
      // SlotReward300Func: the jackpot always ends an allow-matches streak,
      // and half the time resets the luck flags outright.
      if (this.rng.byte() >= 128) { this.canWin = false; this.sevenBar = false; }
      this.allowMatches = 0;
      flashes = 20;
    } else if (sym === "BAR") {
      this.sfx("Get_Key_Item");
      this.canWin = false;
      this.sevenBar = false;
      flashes = 8;
    } else {
      if (this.allowMatches > 0) this.allowMatches -= 1;
      flashes = pay === 8 ? 2 : 4;
    }
    this.win = win;
    this.payoutRemaining = pay;
    this.payoutDisplay = pay;
    this.message = `${sym} lined up!\nScored ${pay} coins!`;
    // The coins are NOT credited until the player dismisses this text.
    this.stage = "flash";
    this.flashLeft = flashes;
    this.flashTimer = 0;
    this.flash = false;
  }

  private resolveLose(): void {
    this.message = "Not this time!";
    this.stage = "message";
    this.afterMessage = "onemore";
  }

  private enterBet(): void {
    this.stage = "bet";
    this.betIndex = 0;
    this.bet = 3;
    this.message = null;
    this.payoutDisplay = 0;
  }

  private enterOneMore(): void {
    this.stage = "onemore";
    this.yesno = 1;
    this.message = null;
    this.payoutDisplay = 0;
  }

  /** Running out of coins ends the session; otherwise "One more go?". */
  private afterSpin(): void {
    if (this.coins() === 0) {
      this.message = "Darn!\nRan out of coins!";
      this.stage = "message";
      this.afterMessage = null;
      this.exitTimer = 60;
    } else {
      this.enterOneMore();
    }
  }

  /** SlotMachine_PayCoinsToPlayer: one coin every 8 frames, 4 for a 7/BAR. */
  private startPayout(): void {
    this.stage = "payout";
    const sym = this.win?.symbol;
    this.dripFrames = sym === "7" || sym === "BAR" ? 4 : 8;
    this.dripTimer = 0;
    this.dripFlash = 5;
    this.flash = false;
  }

  private close(): void {
    this.game.pop();
    this.onDone?.();
  }

  private updateYesNo(p: Partial<Record<string, boolean>>, onYes: () => void): void {
    if (p.up || p.down) this.yesno = this.yesno === 1 ? 2 : 1;
    else if (p.a) {
      this.sfx("Press_AB");
      if (this.yesno === 1) onYes();
      else this.close();
    } else if (p.b) {
      this.sfx("Press_AB");
      this.close();
    }
  }

  update(): void {
    const p = this.game.input.pressed;
    const save = this.game.save;

    switch (this.stage) {
      case "intro":
        this.updateYesNo(p, () => this.enterBet());
        return;

      case "message": {
        if (this.exitTimer !== null) {
          this.exitTimer -= 1;
          if (this.exitTimer <= 0) this.close();
          return;
        }
        if (!(p.a || p.b)) return;
        this.sfx("Press_AB");
        const after = this.afterMessage;
        this.afterMessage = null;
        if (after === "payout") this.startPayout();
        else if (after === "onemore") this.afterSpin();
        else this.enterBet();
        return;
      }

      case "onemore":
        this.updateYesNo(p, () => this.enterBet());
        return;

      case "flash":
        this.flashTimer += 1;
        if (this.flashTimer >= 5) {
          this.flashTimer = 0;
          this.flash = !this.flash;
          this.flashLeft -= 1;
          if (this.flashLeft <= 0) {
            this.flash = false;
            this.stage = "message";
            this.afterMessage = "payout";
          }
        }
        return;

      case "payout":
        if (this.payoutRemaining <= 0) {
          this.flash = false;
          this.payoutDisplay = 0;
          this.afterSpin();
          return;
        }
        this.dripTimer += 1;
        if (this.dripTimer >= this.dripFrames) {
          this.dripTimer = 0;
          save.coins = Math.min(COIN_CAP, this.coins() + 1);
          this.payoutRemaining -= 1;
          this.payoutDisplay = this.payoutRemaining;
          this.sfx("Slots_Reward");
          this.dripFlash -= 1;
          if (this.dripFlash <= 0) { this.dripFlash = 5; this.flash = !this.flash; }
        }
        return;

      case "bet":
        if (p.b) { this.close(); return; }
        if (p.up) this.betIndex = Math.max(0, this.betIndex - 1);
        if (p.down) this.betIndex = Math.min(2, this.betIndex + 1);
        this.bet = 3 - this.betIndex;
        if (!p.a) return;
        if (this.coins() < this.bet) {
          this.message = "Not enough\ncoins!";
          this.afterMessage = "bet";
          this.stage = "message";
          return;
        }
        save.coins = this.coins() - this.bet;
        this.setFlags();
        this.stopping = 0;
        this.slip = [4, 4];
        this.reroll = 4;
        this.frame = 0;
        this.spinupSteps = SPINUP_STEPS;
        this.stage = "spinup";
        this.sfx("Slots_New_Spin");
        return;

      case "spinup":
        this.frame += 1;
        if (this.frame % STEP_FRAMES === 0) {
          for (let w = 0; w < 3; w++) this.animWheel(w);
          this.spinupSteps -= 1;
          if (this.spinupSteps === 0) this.stage = "spin";
        }
        return;

      case "spin": {
        // A stops the next wheel, but is ignored while the previous one is
        // still slipping (SlotMachine_HandleInputWhileWheelsSpin).
        if (p.a) {
          const held = (this.stopping === 1 && this.slip[0]! > 0)
            || (this.stopping === 2 && this.slip[1]! > 0);
          if (!held) {
            this.stopping += 1;
            this.sfx("Slots_Stop_Wheel");
          }
        }
        this.frame += 1;
        if (this.frame % STEP_FRAMES === 0) {
          this.stopOrAnimWheel(0);
          this.stopOrAnimWheel(1);
          if (this.stopOrAnimWheel3()) this.checkForMatches();
        }
        return;
      }

      case "reroll":
        this.animWheel(2);
        this.rerollSteps -= 1;
        if (this.rerollSteps === 0) this.checkForMatches();
        return;
    }
  }

  view(): SlotView {
    // The window shows three symbols per wheel, top row first. A wheel at an
    // EVEN offset is mid-slip: it reads one symbol further on, which is what
    // makes a slip scroll instead of jumping.
    const grid = this.offset.map((o, w) => {
      const pos = Math.floor((o + 1) / 2);
      const [b, m, t] = rowsAt(this.wheels[w] ?? [], pos);
      return [t, m, b];
    });
    return {
      stage: this.stage,
      grid,
      bet: this.bet,
      betIndex: this.betIndex,
      coins: this.coins(),
      payout: this.payoutDisplay,
      message: this.message,
      yesno: this.yesno,
      flash: this.flash,
      order: this.order,
    };
  }
}
