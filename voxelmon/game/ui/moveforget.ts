// The out-of-battle replace-move list (pokered MoveLearnMenu). Pick which of
// a full moveset to delete, or back out.
//
// In battle the same decision is a PHASE on the battle object
// (battle.ts updateForget), because the battle owns its own input loop and
// its queue has to park while the player chooses. Out here the ordinary state
// stack does the job, so this is a plain screen.
import type { GameState } from "../game.ts";
import type { PartyMon } from "../battle/mon.ts";

export interface MoveForgetView {
  name: string;
  moves: string[];
  index: number;
}

export class MoveForgetState implements GameState {
  readonly kind = "moveforget";
  private index = 0;

  constructor(
    private game: { input: any; pop(): void; data: any },
    private mon: PartyMon,
    /** The chosen slot, or -1 for "don't learn it". */
    private onPick: (slot: number) => void,
  ) {}

  update(): void {
    const p = this.game.input.pressed;
    const rows = this.mon.moves.length + 1; // + the cancel row
    // Every d-pad direction steps, matching the battle lists.
    if (p.up || p.left) this.index = (this.index + rows - 1) % rows;
    else if (p.down || p.right) this.index = (this.index + 1) % rows;
    if (p.b) { this.game.pop(); this.onPick(-1); return; }
    if (p.a) {
      const slot = this.index >= this.mon.moves.length ? -1 : this.index;
      this.game.pop();
      this.onPick(slot);
    }
  }

  view(): MoveForgetView {
    const names = this.mon.moves.map(
      (mv) => (this.game.data.moves?.[mv.id]?.name as string) ?? mv.id,
    );
    return {
      name: this.mon.nickname ?? this.game.data.pokemon?.[this.mon.species]?.name ?? "",
      moves: names,
      index: this.index,
    };
  }
}
