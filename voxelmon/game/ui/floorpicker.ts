// WHICH FLOOR? -- the lift panel's floor list (engine/overworld/elevator.asm
// DisplayElevatorFloorMenu), drawn the way the FLY list is: the same entries
// in the same order, as a plain list.
//
// Choosing one does not move the player. It rewrites the car's exits (see
// world/elevator.ts) and closes, and they walk out of the car onto the floor
// they picked -- which is what the original does, shake and all.
import type { GameState } from "../game.ts";
import type { ElevatorFloor } from "../world/elevator.ts";

/** Rows on screen at once; no car serves more than eleven floors. */
const ROWS = 9;

export interface FloorPickerView {
  entries: string[];
  index: number;
  top: number;
  total: number;
}

export class FloorPickerState implements GameState {
  readonly kind = "floorpicker";
  private index = 0;
  private top = 0;

  constructor(
    private game: { input: { pressed: Record<string, boolean | undefined> }; pop(): void },
    private floors: ElevatorFloor[],
    private onPick: (floor: ElevatorFloor) => void,
    private onCancel?: () => void,
  ) {}

  private clampScroll(): void {
    if (this.index < this.top) this.top = this.index;
    if (this.index >= this.top + ROWS) this.top = this.index - ROWS + 1;
    this.top = Math.max(0, Math.min(this.top, Math.max(0, this.floors.length - ROWS)));
  }

  update(): void {
    const p = this.game.input.pressed;
    const n = this.floors.length;
    if (n === 0) {
      this.game.pop();
      this.onCancel?.();
      return;
    }
    if (p.up) this.index = (this.index + n - 1) % n;
    else if (p.down) this.index = (this.index + 1) % n;
    this.clampScroll();
    // DisplayElevatorFloorMenu's `ret c`: B leaves the car as it was.
    if (p.b || p.start) {
      this.game.pop();
      this.onCancel?.();
      return;
    }
    if (p.a) {
      const pick = this.floors[this.index]!;
      this.game.pop();
      this.onPick(pick);
    }
  }

  view(): FloorPickerView {
    return {
      entries: this.floors.map((f) => f.token),
      index: this.index,
      top: this.top,
      total: this.floors.length,
    };
  }
}
