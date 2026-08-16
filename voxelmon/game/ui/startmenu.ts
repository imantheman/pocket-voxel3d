// The START menu. Entries appear as the original gates them: the DEX only
// after Oak hands it over, ITEM once the bag exists, so a fresh save shows
// the short menu the intro gives you.
import type { GameState } from "../game.ts";

export type MenuAction =
  | "pokedex" | "pokemon" | "item" | "trainer" | "save" | "option" | "exit";

export interface StartMenuView {
  entries: string[];
  index: number;
}

export class StartMenuState implements GameState {
  readonly kind = "startmenu";
  private index = 0;
  private entries: string[];
  private actions: MenuAction[];

  constructor(
    private game: { input: any; pop(): void; save: any },
    private onPick: (a: MenuAction) => void,
  ) {
    const f = game.save?.flags ?? {};
    const party = game.save?.party ?? [];
    const e: [string, MenuAction][] = [];
    if (f.EVENT_GOT_POKEDEX) e.push(["POKéDEX", "pokedex"]);
    if (party.length > 0) e.push(["POKéMON", "pokemon"]);
    e.push(["ITEM", "item"]);
    e.push([String(game.save?.player?.name ?? "RED"), "trainer"]);
    e.push(["SAVE", "save"]);
    e.push(["OPTION", "option"]);
    e.push(["EXIT", "exit"]);
    this.entries = e.map((x) => x[0]);
    this.actions = e.map((x) => x[1]);
  }

  update(): void {
    const p = this.game.input.pressed;
    if (p.up) this.index = (this.index + this.entries.length - 1) % this.entries.length;
    if (p.down) this.index = (this.index + 1) % this.entries.length;
    if (p.b || p.start) { this.game.pop(); return; }
    if (p.a) {
      const act = this.actions[this.index]!;
      if (act === "exit") { this.game.pop(); return; }
      this.onPick(act);
    }
  }

  view(): StartMenuView {
    return { entries: this.entries, index: this.index };
  }
}
