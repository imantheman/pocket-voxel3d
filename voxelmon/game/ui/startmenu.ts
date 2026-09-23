// The START menu. Entries appear as the original gates them: the DEX only
// after Oak hands it over, ITEM once the bag exists, so a fresh save shows
// the short menu the intro gives you.
import type { GameState } from "../game.ts";

export type MenuAction =
  | "pokedex" | "pokemon" | "item" | "trainer" | "save" | "option" | "dev" | "exit";

export interface StartMenuView {
  entries: string[];
  index: number;
  /**
   * The SAFARI ZONE counter, while a game is running. The original replaces
   * the whole START menu with it (StartMenu_Safari: a BALLS/steps box is all
   * you get), and the Safari Zone's own sign tells the player to press START
   * to check the time — so it is drawn above the menu rather than instead of
   * it, keeping SAVE and the rest reachable.
   */
  safari: { balls: number; steps: number } | null;
}

export class StartMenuState implements GameState {
  readonly kind = "startmenu";
  private index = 0;
  private entries: string[];
  private actions: MenuAction[];

  constructor(
    private game: { input: any; pop(): void; save: { options?: { devMenu?: boolean } } & any },
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
    // Playtesting only, not in the original (ui/devmenu.ts): the map jump and
    // the other test tools, one level down so a mis-press lands on a submenu
    // rather than on a debug warp. OFF unless the OPTION screen's DEV MENU
    // row turns it on -- a row of test tools in the middle of the pause menu
    // is not what a player opening it wants to find.
    if (game.save?.options?.devMenu === true) e.push(["DEV", "dev"]);
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
    const s = this.game.save?.safari;
    return {
      entries: this.entries,
      index: this.index,
      safari: s ? { balls: s.balls, steps: s.steps } : null,
    };
  }
}
