// Title screen: engine/movie/title.asm, by way of gen1recomp
// src/ui/TitleState.lua, whose tilemap this copies to the pixel. The logo
// at tile (2,1); the "Red Version" ribbon on row 8, "Red" at column 7 and
// "Version" at column 10; Red's title art as OAM at px (82,80), drawn over
// the mon's box; the title mon bottom-aligned in the 7x7 box at tile
// (5,10), in the four Game Boy shades; the copyright on row 17. Nothing
// says PRESS START -- the cartridge waits for START or A -- and then the
// main menu offers CONTINUE / NEW GAME / OPTION.
import type { GameState } from "../game.ts";
import { namedPage, picPageFor } from "../battle/staging.ts";
import { gameVersion } from "../data.ts";
import { COPYRIGHT_GAMEFREAK, COPYRIGHT_PREFIX, gbW, gbX, gbY } from "./intro.ts";

/**
 * data/pokemon/title_mons.asm, the Red list. The starter leads, then
 * TitleScreenPickNewMon draws from the rest without repeating. The cook
 * carries the same list (cook/cli.ts TITLE_MONS); a test holds them equal.
 */
export const TITLE_MONS = [
  "CHARMANDER", "SQUIRTLE", "BULBASAUR", "WEEDLE", "NIDORAN_M", "SCYTHER",
  "PIKACHU", "CLEFAIRY", "RHYDON", "ABRA", "GASTLY", "DITTO",
  "PIDGEOTTO", "ONIX", "PONYTA", "MAGIKARP",
] as const;

/** The Blue list (title_mons.asm _BLUE; gen1recomp BLUE_CYCLE_SPECIES):
 * STARTER2 -- Squirtle -- leads. */
export const TITLE_MONS_BLUE = [
  "SQUIRTLE", "CHARMANDER", "BULBASAUR", "MANKEY", "HITMONLEE", "VULPIX",
  "CHANSEY", "AERODACTYL", "JOLTEON", "SNORLAX", "GLOOM", "POLIWAG",
  "DODUO", "PORYGON", "GENGAR", "RAICHU",
] as const;

/** The cast of the game the dataset is. */
export function titleMons(data: unknown): readonly string[] {
  return gameVersion(data as { version?: string }) === "blue" ? TITLE_MONS_BLUE : TITLE_MONS;
}

/** Where a pak cooked before `atlas.picTitle` existed put the title art.
 * Only used when the dataset does not name the pages itself. */
export const TITLE_PAGES = {"copyright": 421, "gamefreak": 422, "logo": 423, "player": 424} as const;

/** The title art page the dataset names, else the old literal. */
export function titlePage(data: unknown, key: keyof typeof TITLE_PAGES): number {
  const p = namedPage(data as never, "picTitle", key);
  return p >= 0 ? p : TITLE_PAGES[key];
}

/** Frames a mon holds the box before the next one (the ROM's own beat is
 * a scroll-out and a scroll-in; this is the wait between them). */
export const TITLE_MON_FRAMES = 150;

// The tilemap, in GB pixels (title.asm; TitleState.lua:482-486).
const LOGO = { x: 16, y: 8, w: 128, h: 48 };
const RIBBON_Y = 64;
const RIBBON_RED = { x: 56, tiles: [0, 1] };
const RIBBON_VERSION = { x: 80, tiles: [5, 6, 7, 8, 9] };
/** Blue's ribbon is one run, "Blue Version" in the first eight tiles,
 * drawn from column 7 (gen1recomp TitleState.lua: quad 0,0,64,8 at 56,64). */
const RIBBON_BLUE = { x: 56, tiles: [0, 1, 2, 3, 4, 5, 6, 7] };
/** The mon's box: tiles (5,10)-(11,16), the mon bottom-aligned and centred. */
const MON_BOX = { x: 40, y: 80, w: 56, h: 56 };
const RED_AT = { x: 82, y: 80, w: 40, h: 56 };
const COPYRIGHT_Y = 136;

export type TitleChoice = "continue" | "new" | "option" | "viewer";

export interface TitleQuad {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TitleTile {
  page: number;
  tile: number;
  x: number;
  y: number;
  flags: number;
}

export interface TitleView {
  phase: "press" | "menu";
  /** The mon in the box this beat, for the scene's redraw key. */
  monPage: number;
  /** Screen-space pictures, back to front. */
  pics: TitleQuad[];
  /** GB-space 8x8 tiles: the ribbon and the copyright line. */
  tiles: TitleTile[];
  menu: string[];
  index: number;
  hasSave: boolean;
}

export class TitleState implements GameState {
  readonly kind = "title";
  private phase: "press" | "menu" = "press";
  private timer = 0;
  private index = 0;
  private menu: string[];
  /** The mon on show, and the ones still to come this pass. */
  private mon: string;
  private bag: string[] = [];
  private cast: readonly string[];

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
    this.cast = titleMons(game.data);
    this.mon = this.cast[0]!;
  }

  /** TitleScreenPickNewMon: the next one, never the same twice in a pass. */
  private pickNext(): void {
    if (this.bag.length === 0) this.bag = this.cast.filter((s) => s !== this.mon);
    const i = Math.floor(Math.random() * this.bag.length);
    this.mon = this.bag.splice(i, 1)[0]!;
  }

  private monPage(): number {
    // In grey, as the cartridge shows it; a pak cooked before the title
    // had its own pages shows the coloured battle pic instead.
    const grey = namedPage(this.game.data as never, "picTitleMon", this.mon);
    if (grey >= 0) return grey;
    return this.game.picPageFor
      ? this.game.picPageFor(this.mon)
      : picPageFor(this.game.data, this.mon);
  }

  update(): void {
    const p = this.game.input.pressed;
    this.timer += 1;
    // The world stages behind the title and starts its map theme on its
    // first tick, so claim the music from here rather than at push time.
    if (this.timer === 2) {
      (this.game as any).audio?.play?.("Music_TitleScreen");
    }

    if (this.phase === "press") {
      if (this.timer % TITLE_MON_FRAMES === 0) this.pickNext();
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

  private quad(page: number, r: { x: number; y: number; w: number; h: number }): TitleQuad {
    return { page, x: gbX(r.x), y: gbY(r.y), w: gbW(r.w), h: gbW(r.h) };
  }

  view(): TitleView {
    const data = this.game.data;
    const monPage = this.monPage();
    const pics: TitleQuad[] = [this.quad(titlePage(data, "logo"), LOGO)];
    if (monPage >= 0) pics.push(this.quad(monPage, MON_BOX));
    // Red is OAM in the original: he draws over the mon's box edge
    pics.push(this.quad(titlePage(data, "player"), RED_AT));

    const tiles: TitleTile[] = [];
    const row = (page: number, seq: readonly number[], x: number, y: number): void => {
      if (page < 0) return;
      seq.forEach((t, i) => tiles.push({ page, tile: t, x: x + i * 8, y, flags: 0 }));
    };
    const version = namedPage(data as never, "picTitle", "version");
    if (gameVersion(data as { version?: string }) === "blue") {
      row(version, RIBBON_BLUE.tiles, RIBBON_BLUE.x, RIBBON_Y);
    } else {
      row(version, RIBBON_RED.tiles, RIBBON_RED.x, RIBBON_Y);
      row(version, RIBBON_VERSION.tiles, RIBBON_VERSION.x, RIBBON_Y);
    }
    row(titlePage(data, "copyright"), COPYRIGHT_PREFIX, 16, COPYRIGHT_Y);
    row(titlePage(data, "gamefreak"), COPYRIGHT_GAMEFREAK, 80, COPYRIGHT_Y);

    return {
      phase: this.phase,
      monPage,
      pics,
      tiles,
      menu: this.menu,
      index: this.index,
      hasSave: !!this.game.hasSave,
    };
  }
}
