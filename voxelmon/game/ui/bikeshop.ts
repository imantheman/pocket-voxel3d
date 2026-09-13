// The BIKE SHOP's price window (scripts/BikeShop.asm BikeShopClerkText's
// sales-pitch branch), ported from gen1recomp story2.lua's BikeShopWindow.
//
// The clerk draws his own window (TextBoxBorder hlcoord 0,0, b=4 c=15)
// holding BikeShopMenuText and BikeShopMenuPrice, then goes straight into
// HandleMenuInput without waiting — so the pitch line stays on screen in the
// bottom box UNDER the window while you choose. The original never erases it
// before TextScriptEnd, which is why this state carries its own copy of that
// line as a footer rather than leaving a blank box.
import type { GameState } from "../game.ts";

/** BikeShopMenuPrice — a million, i.e. deliberately out of reach. */
export const BIKE_PRICE = 1000000;

export interface BikeShopView {
  /** The two rows: the bike and CANCEL. */
  rows: string[];
  price: string;
  index: number;
  /** The clerk's pitch, still showing in the bottom box. */
  footer: string | null;
}

interface BikeShopGame {
  input: { pressed: Partial<Record<string, boolean>> };
  pop(): void;
  data: any;
  playSfx(name: string): void;
}

export class BikeShopState implements GameState {
  readonly kind = "bikeshop";
  private index = 0;
  /** One answer only: the boxes the callback pushes sit ON TOP of this
   * state, so a second A on the same frame must not fire it twice. */
  private answered = false;

  constructor(
    private game: BikeShopGame,
    private footer: string | null,
    private onChoose: (bought: boolean) => void,
  ) {}

  update(): void {
    if (this.answered) return;
    const p = this.game.input.pressed;
    // HandleMenuInput with wMenuWrappingEnabled clear: the two rows clamp
    // rather than wrap.
    if (p.up) this.index = 0;
    if (p.down) this.index = 1;
    if (!p.a && !p.b) return;
    const cancelled = !!p.b; // bit B_PAD_B -> .cancel
    this.game.playSfx("Press_AB");
    this.answered = true;
    this.onChoose(!cancelled && this.index === 0);
  }

  /** The clerk's last line closes the conversation and takes the window. */
  close(): void {
    this.game.pop();
  }

  view(): BikeShopView {
    const name = this.game.data?.items?.BICYCLE?.name ?? "BICYCLE";
    return {
      rows: [name, "CANCEL"],
      price: `¥${BIKE_PRICE}`,
      index: this.index,
      footer: this.footer,
    };
  }
}
