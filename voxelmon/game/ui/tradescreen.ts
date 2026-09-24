// The link trade screen (engine/link/cable_club.asm's trade menu): both
// parties at once, theirs above yours, and a cursor that crosses between
// them.
//
// You pick one of yours, the cursor moves over to their side, you pick one
// of theirs, and that is a proposal. The other console gets it as a
// yes-or-no, which is why only one side ever reaches the confirm: whoever
// presses A twice first is proposing, and the other's screen steps aside to
// answer them. That race is decided by the wire rather than by a lock,
// because the ROM does it that way too -- there is no "your turn" in a
// Cable Club, just two people reaching for the machine.

import type { GameState } from "../game.ts";

/** Row of the first entry in each list, in UI cells. */
export const TRADE_THEIRS_ROW = 2;
export const TRADE_MINE_ROW = 10;

export interface TradeEntry {
  name: string;
  level: number;
  species: string;
  hp: number;
  maxHp: number;
  status: string | null;
}

export interface TradeScreenView {
  myName: string;
  peerName: string;
  mine: TradeEntry[];
  theirs: TradeEntry[];
  /** 0 = the cursor is on your party, 1 = on theirs. */
  side: 0 | 1;
  index: number;
  /** Which of yours is already picked, while choosing one of theirs. */
  chosenMine: number | null;
  prompt: string;
}

/** What the screen closed with. */
export type TradeChoice =
  | { kind: "propose"; give: number; take: number }
  /** The peer proposed first; the flow should answer them instead. */
  | { kind: "incoming" }
  | { kind: "cancel" };

interface TradeGame {
  input: { pressed: { a?: boolean; b?: boolean; up?: boolean; down?: boolean } };
  pop(): void;
}

/** Just enough of the session for the screen to notice an offer arriving. */
interface OfferWatch {
  peerOffer: unknown;
  state: string;
}

export class TradeScreenState implements GameState {
  readonly kind = "tradescreen";
  private side: 0 | 1 = 0;
  private index = 0;
  private chosenMine: number | null = null;
  private closed = false;

  constructor(
    private game: TradeGame,
    private opts: {
      myName: string;
      peerName: string;
      mine: TradeEntry[];
      theirs: TradeEntry[];
      watch: OfferWatch;
      onDone: (choice: TradeChoice) => void;
    },
  ) {}

  private finish(choice: TradeChoice): void {
    if (this.closed) return;
    this.closed = true;
    this.game.pop();
    this.opts.onDone(choice);
  }

  update(): void {
    if (this.closed) return;
    // They reached the machine first: step aside and let the flow answer.
    if (this.opts.watch.peerOffer) { this.finish({ kind: "incoming" }); return; }
    if (this.opts.watch.state === "closed") { this.finish({ kind: "cancel" }); return; }

    const p = this.game.input.pressed;
    const list = this.side === 0 ? this.opts.mine : this.opts.theirs;
    const n = Math.max(1, list.length);
    if (p.up) this.index = (this.index + n - 1) % n;
    if (p.down) this.index = (this.index + 1) % n;
    if (p.b) {
      // Back out of their side first; from your own side, back out of the
      // trade.
      if (this.side === 1) { this.side = 0; this.index = this.chosenMine ?? 0; this.chosenMine = null; }
      else this.finish({ kind: "cancel" });
      return;
    }
    if (!p.a || list.length === 0) return;
    if (this.side === 0) {
      this.chosenMine = this.index;
      this.side = 1;
      this.index = 0;
      return;
    }
    this.finish({ kind: "propose", give: this.chosenMine ?? 0, take: this.index });
  }

  view(): TradeScreenView {
    return {
      myName: this.opts.myName,
      peerName: this.opts.peerName,
      mine: this.opts.mine,
      theirs: this.opts.theirs,
      side: this.side,
      index: this.index,
      chosenMine: this.chosenMine,
      prompt: this.side === 0 ? "Choose a POKéMON." : "Which POKéMON\nfor theirs?",
    };
  }
}
