// The GAME CORNER prize window (engine/events/prize_menu.asm
// CeladonPrizeMenu), ported from gen1recomp story3.lua's prizeCounter.
//
// wMaxMenuItem is 3: this counter's three prizes plus NO THANKS. Picking one
// confirms with SoYouWantPrizeText before any coins move, and every branch
// rets out of CeladonPrizeMenu — so one transaction ends the conversation and
// buying again means talking to the counter again.
import type { GameState } from "../game.ts";
import * as Bag from "../rules/bag.ts";
import type { PrizeEntry } from "../world/gamecorner.ts";

export interface PrizeRow {
  label: string;
  cost: number;
}

export interface PrizeView {
  rows: PrizeRow[];
  index: number;
  coins: number;
  /** A line shown under the list instead of the prizes, when one is due. */
  message: string | null;
}

interface PrizeGame {
  input: { pressed: Partial<Record<string, boolean>> };
  push(s: GameState): void;
  pop(): void;
  save: any;
  data: any;
  showText(text: string, onDone?: () => void): void;
  showChoice(text: string, choice: (yes: boolean) => void): void;
  /** give_pokemon's seam: true when the mon found a home. */
  givePrizeMon(species: string, level: number): boolean;
}

export class PrizeState implements GameState {
  readonly kind = "prizes";
  private index = 0;
  private closing = false;

  constructor(
    private game: PrizeGame,
    private prizes: PrizeEntry[],
    private onDone?: () => void,
  ) {}

  private label(p: PrizeEntry): string {
    if (p.kind === "mon") {
      const name = this.game.data.pokemon?.[p.species!]?.name ?? p.species!;
      return `${name} L${p.level}`;
    }
    return this.game.data.items?.[p.item!]?.name ?? p.item!;
  }

  /** Close for good and hand the conversation back. */
  private close(msg?: string): void {
    if (this.closing) return;
    this.closing = true;
    this.game.pop();
    if (msg) this.game.showText(msg, this.onDone);
    else this.onDone?.();
  }

  private buy(p: PrizeEntry): void {
    const save = this.game.save;
    const t = this.game.data.text ?? {};
    if ((save.coins ?? 0) < p.cost) {
      this.close(t._SorryNeedMoreCoinsText ?? "Sorry, you need\nmore coins.");
      return;
    }
    // HasEnoughCoins passed, so the prize is handed over FIRST and the coins
    // come off only once it landed: the asm rets before .subtractCoins when
    // there is no room for it.
    const roomless = t._OopsYouDontHaveEnoughRoomText ?? "Oops! You don't\nhave enough room.";
    if (p.kind === "mon") {
      if (!this.game.givePrizeMon(p.species!, p.level!)) {
        this.close(roomless);
        return;
      }
    } else if (!Bag.add(this.game.save, p.item!, 1, this.game.data)) {
      this.close(roomless);
      return;
    }
    save.coins = (save.coins ?? 0) - p.cost;
    // No thank-you line: HereYouGoText is unreferenced in the asm, which just
    // redraws the coin box and returns.
    this.close();
  }

  update(): void {
    if (this.closing) return;
    const p = this.game.input.pressed;
    const n = this.prizes.length + 1; // + NO THANKS
    if (p.up || p.left) this.index = (this.index + n - 1) % n;
    if (p.down || p.right) this.index = (this.index + 1) % n;
    if (p.b || (p.a && this.index === this.prizes.length)) {
      this.close();
      return;
    }
    if (!p.a) return;
    const prize = this.prizes[this.index]!;
    const t = this.game.data.text ?? {};
    const ask = (t._SoYouWantPrizeText ?? "So, you want\n{RAM:wNameBuffer}?")
      .replace("{RAM:wNameBuffer}", this.label(prize));
    this.game.showChoice(ask, (yes) => {
      if (!yes) {
        this.close(t._OhFineThenText ?? "Oh, fine then.");
        return;
      }
      this.buy(prize);
    });
  }

  view(): PrizeView {
    return {
      rows: this.prizes.map((p) => ({ label: this.label(p), cost: p.cost })),
      index: this.index,
      coins: this.game.save?.coins ?? 0,
      message: null,
    };
  }
}
