// The trade animation (engine/link/trade_animation.asm).
//
// The ROM's version draws two GAME BOYs joined by a cable and sends a ball
// down it, one console to the other, then opens the ball on the far side.
// The cable, the two consoles and the travelling ball are link-engine
// graphics that the importer does not pull out -- nothing in the pak draws
// a GAME BOY -- so this plays the same beats with what a cooked pak does
// have: the two mons' own front pictures and their cries.
//
// The shape is the ROM's and the timing is the ROM's: the one leaving is
// shown and called, it goes, there is a beat of nothing while it is "in
// the cable", and the one arriving is shown and calls back. What is
// missing is the hardware drawn around it, not a step of the sequence.

import type { GameState } from "../game.ts";
import type { TradeEntry } from "./tradescreen.ts";

/** Frames per beat, matching the ROM's unhurried pacing. */
export const TRADE_SHOW_FRAMES = 60;
export const TRADE_GAP_FRAMES = 40;

/** Where the mon sits, in UI cells: the seven-cell nook the summary uses. */
export const TRADE_PIC_CELL = { x: 6, y: 3, w: 7, h: 7 } as const;

export type TradePhase = "sending" | "gap" | "receiving" | "done";

export interface TradeAnimView {
  phase: TradePhase;
  /** The mon on screen this beat, or null during the gap. */
  mon: TradeEntry | null;
  line: string;
}

interface AnimGame {
  pop(): void;
  audio?: { playCry?(species: string): void };
}

export class TradeAnimState implements GameState {
  readonly kind = "tradeanim";
  private phase: TradePhase = "sending";
  private t = 0;
  private cried = "";

  constructor(
    private game: AnimGame,
    private opts: {
      sending: TradeEntry;
      receiving: TradeEntry;
      peerName: string;
      onDone: () => void;
    },
  ) {}

  private cryOnce(species: string): void {
    if (this.cried === species) return;
    this.cried = species;
    this.game.audio?.playCry?.(species);
  }

  update(): void {
    this.t += 1;
    if (this.phase === "sending") {
      this.cryOnce(this.opts.sending.species);
      if (this.t >= TRADE_SHOW_FRAMES) { this.phase = "gap"; this.t = 0; }
      return;
    }
    if (this.phase === "gap") {
      if (this.t >= TRADE_GAP_FRAMES) { this.phase = "receiving"; this.t = 0; this.cried = ""; }
      return;
    }
    if (this.phase === "receiving") {
      this.cryOnce(this.opts.receiving.species);
      if (this.t >= TRADE_SHOW_FRAMES) {
        this.phase = "done";
        this.game.pop();
        this.opts.onDone();
      }
    }
  }

  view(): TradeAnimView {
    if (this.phase === "sending") {
      return {
        phase: this.phase,
        mon: this.opts.sending,
        line: `${this.opts.sending.name} is\ntransferred.`,
      };
    }
    if (this.phase === "gap") {
      return { phase: this.phase, mon: null, line: `${this.opts.peerName} waves\nfarewell as` };
    }
    return {
      phase: "receiving",
      mon: this.opts.receiving,
      line: `${this.opts.peerName} sends\n${this.opts.receiving.name}.`,
    };
  }
}
