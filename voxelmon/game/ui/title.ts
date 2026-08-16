// Title screen. gen1recomp src/ui/TitleState.lua: the starter art cycles
// through mon pics while PRESS START waits, then the main menu offers
// CONTINUE / NEW GAME / OPTION.
import type { GameState } from "../game.ts";

/** The rotating cast the original cycles behind the logo. */
const CYCLE = [
  "CHARMANDER", "SQUIRTLE", "BULBASAUR", "PIKACHU", "MEWTWO",
  "NIDOKING", "GENGAR", "ONIX", "GYARADOS", "LAPRAS",
];

export const TITLE_PAGES = {"copyright": 421, "gamefreak": 422, "logo": 423, "player": 424} as const;
export const CYCLE_PAGES: Record<string, number> = {"CHARMANDER": 84, "SQUIRTLE": 202, "BULBASAUR": 79, "PIKACHU": 176, "MEWTWO": 155, "NIDOKING": 159, "GENGAR": 112, "ONIX": 169, "GYARADOS": 123, "LAPRAS": 141};

export type TitleChoice = "continue" | "new" | "option" | "viewer";

export interface TitleView {
  phase: "press" | "menu";
  monPage: number;
  menu: string[];
  index: number;
  hasSave: boolean;
}

export class TitleState implements GameState {
  readonly kind = "title";
  private phase: "press" | "menu" = "press";
  private timer = 0;
  private cycleAt = 0;
  private index = 0;
  private menu: string[];

  constructor(
    private game: {
      input: any;
      pop(): void;
      data: any;
      hasSave?: boolean;
      picPageFor?: (species: string) => number;
    },
    private onChoose: (c: TitleChoice) => void,
  ) {
    this.menu = game.hasSave
      ? ["CONTINUE", "NEW GAME", "OPTION", "MAP VIEWER"]
      : ["NEW GAME", "OPTION", "MAP VIEWER"];
  }

  private monPage(): number {
    const species = CYCLE[this.cycleAt % CYCLE.length]!;
    return CYCLE_PAGES[species] ?? -1;
  }

  update(): void {
    const p = this.game.input.pressed;
    this.timer += 1;

    if (this.phase === "press") {
      // TitleState.lua cycles the art on a fixed beat while waiting.
      if (this.timer % 150 === 0) this.cycleAt += 1;   // ~2.5s per mon
      if (p.start || p.a) {
        this.phase = "menu";
        this.index = 0;
      }
      return;
    }

    if (p.up) this.index = (this.index + this.menu.length - 1) % this.menu.length;
    if (p.down) this.index = (this.index + 1) % this.menu.length;
    if (p.b) { this.phase = "press"; return; }
    if (p.a) {
      const pick = this.menu[this.index];
      this.game.pop();
      if (pick === "CONTINUE") this.onChoose("continue");
      else if (pick === "NEW GAME") this.onChoose("new");
      else if (pick === "MAP VIEWER") this.onChoose("viewer");
      else this.onChoose("option");
    }
  }

  view(): TitleView {
    return {
      phase: this.phase,
      monPage: this.monPage(),
      menu: this.menu,
      index: this.index,
      hasSave: !!this.game.hasSave,
    };
  }
}
