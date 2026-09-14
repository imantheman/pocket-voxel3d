// The DEV menu: the playtesting tools, gathered behind one START-menu entry.
//
// Not a port of anything. WARP used to sit in the START menu proper, between
// OPTION and EXIT, which put a debug map jump one mis-press away from SAVE;
// it lives down here now, with room for the other things that exist only for
// testing. Nothing in here is reachable in a normal playthrough.
import type { GameState } from "../game.ts";

export type DevAction = "warp" | "candy" | "cardtest" | "exit";

export interface DevMenuView {
  entries: string[];
  index: number;
}

/** Label + action, in menu order. CANCEL last, like every other GB menu. */
const ENTRIES: [string, DevAction][] = [
  ["WARP", "warp"],
  ["RARE CANDY", "candy"],
  // Writes a file to the SD card and reads it back, then says on screen
  // whether it worked. A card that has gone read-only still reads its maps
  // perfectly, so nothing else in the game gives it away.
  ["CARD TEST", "cardtest"],
  ["CANCEL", "exit"],
];

export class DevMenuState implements GameState {
  readonly kind = "devmenu";
  private index = 0;

  constructor(
    private game: { input: any; pop(): void },
    private onPick: (a: DevAction) => void,
  ) {}

  update(): void {
    const p = this.game.input.pressed;
    const n = ENTRIES.length;
    if (p.up) this.index = (this.index + n - 1) % n;
    if (p.down) this.index = (this.index + 1) % n;
    if (p.b || p.start) { this.game.pop(); return; }
    if (p.a) {
      const act = ENTRIES[this.index]![1];
      if (act === "exit") { this.game.pop(); return; }
      this.onPick(act);
    }
  }

  view(): DevMenuView {
    return { entries: ENTRIES.map((e) => e[0]), index: this.index };
  }
}
