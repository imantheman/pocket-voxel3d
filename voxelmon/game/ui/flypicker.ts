// Where to? — the FLY destination list.
//
// pokered puts the TOWN MAP on screen with a bird cursor you nudge between
// towns (engine/items/town_map.asm LoadTownMap_Fly). This is a plain list of
// the same destinations in the same order. That is a deliberate simplification
// rather than a port: the gear's town map draws locations but has no cursor
// mode, and a list gets the move working without holding the whole HM behind
// a new rendering feature. The destinations, their order and their landing
// cells are the real ones (world/fly.ts).
import type { GameState } from "../game.ts";
import type { FlyDest } from "../world/fly.ts";

/** Rows on screen at once. Eleven towns at most, so this shows nearly all. */
const ROWS = 9;

export interface FlyPickerView {
  entries: string[];
  index: number;
  top: number;
  total: number;
}

export class FlyPickerState implements GameState {
  readonly kind = "flypicker";
  private index = 0;
  private top = 0;

  constructor(
    private game: { input: any; pop(): void },
    private dests: FlyDest[],
    private onPick: (dest: FlyDest) => void,
    private onCancel?: () => void,
  ) {}

  private clampScroll(): void {
    if (this.index < this.top) this.top = this.index;
    if (this.index >= this.top + ROWS) this.top = this.index - ROWS + 1;
    this.top = Math.max(0, Math.min(this.top, Math.max(0, this.dests.length - ROWS)));
  }

  update(): void {
    const p = this.game.input.pressed;
    const n = this.dests.length;
    if (n === 0) {
      this.game.pop();
      this.onCancel?.();
      return;
    }
    if (p.up) this.index = (this.index + n - 1) % n;
    else if (p.down) this.index = (this.index + 1) % n;
    this.clampScroll();
    if (p.b || p.start) {
      this.game.pop();
      this.onCancel?.();
      return;
    }
    if (p.a) {
      const pick = this.dests[this.index]!;
      this.game.pop();
      this.onPick(pick);
    }
  }

  view(): FlyPickerView {
    return {
      entries: this.dests.map((d) => d.name),
      index: this.index,
      top: this.top,
      total: this.dests.length,
    };
  }
}
