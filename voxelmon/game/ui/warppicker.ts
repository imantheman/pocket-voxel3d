// A debug map picker: jump the player straight to any cooked map.
//
// Not a port of anything — a playtesting tool. The story events this build
// keeps gaining sit deeper and deeper into the game, and walking to Celadon
// or Saffron to check one script costs minutes each time. The title screen's
// MAP VIEWER cycles maps with L/R, but it is a camera mode with no player and
// no way to name the map you want, so it cannot be used to test an event.
//
// This picks by name and warps the player, so the map is actually PLAYABLE
// when you arrive.
import type { GameState } from "../game.ts";

/** Rows of the list on screen at once. */
const ROWS = 8;

export interface WarpPickerView {
  entries: string[];
  index: number;
  top: number;
  total: number;
}

export class WarpPickerState implements GameState {
  readonly kind = "warppicker";
  private index = 0;
  private top = 0;
  private readonly maps: string[];

  constructor(
    private game: { input: any; pop(): void; save: any; data: any },
    here: string,
    private onPick: (mapId: string) => void,
  ) {
    // Cooked maps only: anything else has no pak and would fail to load.
    const data = game.data ?? {};
    const cooked: string[] = Array.isArray(data.cookedMaps) ? data.cookedMaps : [];
    const known = data.maps ?? {};
    this.maps = cooked.filter((m) => known[m]).sort();
    // Open on the map the player is standing in, so the list starts where
    // they are rather than at AGATHAS_ROOM every time.
    const at = this.maps.indexOf(here);
    if (at >= 0) this.index = at;
    this.clampScroll();
  }

  private clampScroll(): void {
    if (this.index < this.top) this.top = this.index;
    if (this.index >= this.top + ROWS) this.top = this.index - ROWS + 1;
    this.top = Math.max(0, Math.min(this.top, Math.max(0, this.maps.length - ROWS)));
  }

  update(): void {
    const p = this.game.input.pressed;
    const n = this.maps.length;
    if (n === 0) { this.game.pop(); return; }
    // Up/down step, left/right page — 219 maps is far too many to step
    // through one at a time, which is the complaint this screen exists to
    // answer.
    if (p.up) this.index = (this.index + n - 1) % n;
    else if (p.down) this.index = (this.index + 1) % n;
    else if (p.left) this.index = Math.max(0, this.index - ROWS);
    else if (p.right) this.index = Math.min(n - 1, this.index + ROWS);
    // SELECT jumps to the next initial letter — the fastest way across an
    // alphabetical list this long. The guest's button set (VOX_BTN) has no
    // shoulder buttons, so SELECT is the only spare key here.
    else if (p.select) this.index = this.nextLetter();
    this.clampScroll();
    if (p.b || p.start) { this.game.pop(); return; }
    if (p.a) {
      const pick = this.maps[this.index]!;
      this.game.pop();
      this.onPick(pick);
    }
  }

  private nextLetter(): number {
    const c = this.maps[this.index]![0];
    for (let i = this.index + 1; i < this.maps.length; i++) {
      if (this.maps[i]![0] !== c) return i;
    }
    return this.maps.length - 1;
  }

  view(): WarpPickerView {
    return {
      entries: this.maps.slice(this.top, this.top + ROWS),
      index: this.index - this.top,
      top: this.top,
      total: this.maps.length,
    };
  }
}
