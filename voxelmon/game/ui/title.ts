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
import { COPYRIGHT_GAMEFREAK, COPYRIGHT_PREFIX, COPYRIGHT_PREFIX_YELLOW, gbW, gbX, gbY } from "./intro.ts";

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

/**
 * Yellow's logo drop (title_yellow.asm .TitleScreenPokemonLogoYScrolls, by
 * way of gen1recomp TitleState.lua DROP_STEPS): { dy per frame, frames }.
 * hSCY starts at $40 with the composition parked above the view; the -3
 * rebound step lands with the crash.
 */
const YELLOW_DROP: [number, number][] = [[-4, 16], [3, 4], [-3, 4], [2, 2], [-2, 2], [1, 2], [-1, 2]];
/** The Yellow tilemap, GB px: logo (2,1) 16x7, bubble (6,4), Pikachu (4,8)
 * 13x9, the eye band (56,80) 48x16. */
const Y_LOGO = { x: 16, y: 8, w: 128, h: 56 };
const Y_BUBBLE = { x: 48, y: 32, w: 56, h: 40 };
const Y_PIKACHU = { x: 32, y: 64, w: 104, h: 72 };
const Y_EYES = { x: 56, y: 80, w: 48, h: 16 };

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
/** Where GAME FREAK starts: title.asm writes the copyright as one run of 16
 * tiles from (2,17), the 7-tile year prefix then the 9 GAME FREAK tiles,
 * so it follows the prefix with no gap -- column 9. */
const COPYRIGHT_GAMEFREAK_X = 16 + COPYRIGHT_PREFIX.length * 8;

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

/** A title page by name, or -1 (Yellow's pieces have no literal fallback). */
function named(data: unknown, key: string): number {
  return namedPage(data as never, "picTitle", key);
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
  /** Yellow: the fixed Pikachu composition and its boot cinematic. */
  private readonly yellow: boolean;
  private yPhase: "drop" | "settle" | "bubble" | "loop" = "drop";
  private scy = 0x40;
  private dropStep = 0;
  private dropLeft = -1;
  private yTimer = 0;
  private showBubble = false;
  private blinkTimer = 0;
  private blinkAt = -1;

  constructor(
    private game: {
      input: any;
      pop(): void;
      data: any;
      hasSave?: boolean;
      picPageFor?: (species: string) => number;
      showChoice?: (text: string, cb: (yes: boolean) => void, opts?: { defaultNo?: boolean }) => void;
      deleteSave?: () => void;
    },
    private onChoose: (c: TitleChoice) => void,
  ) {
    this.menu = game.hasSave
      ? ["CONTINUE", "NEW GAME", "OPTION", "MAP VIEWER"]
      : ["NEW GAME", "OPTION", "MAP VIEWER"];
    this.cast = titleMons(game.data);
    this.mon = this.cast[0]!;
    this.yellow = gameVersion(game.data as { version?: string }) === "yellow";
  }

  private audio():
    | { play?(s: string): void; playSfx?(s: string): void; playCry?(s: string): void; playPikaClip?(n: number): void }
    | undefined {
    return (this.game as { audio?: never }).audio;
  }

  /** The Yellow title's cinematic, one frame per call: the logo drop,
   * 36 frames, the whoosh and the bubble, Pikachu's cry, then the theme
   * (title_yellow.asm; gen1recomp TitleState.lua updateSequence). */
  private yellowSequence(): void {
    if (this.yPhase === "drop") {
      const step = YELLOW_DROP[this.dropStep];
      if (!step) { this.yPhase = "settle"; this.yTimer = 0; return; }
      if (this.dropLeft < 0) {
        this.dropLeft = step[1];
        if (step[0] === -3) this.audio()?.playSfx?.("Intro_Crash");
      }
      this.scy += step[0];
      this.dropLeft -= 1;
      if (this.dropLeft <= 0) { this.dropStep += 1; this.dropLeft = -1; }
    } else if (this.yPhase === "settle") {
      if (++this.yTimer >= 36) {
        this.audio()?.playSfx?.("Intro_Whoosh");
        this.showBubble = true;
        this.yPhase = "bubble";
        this.yTimer = 0;
      }
    } else if (this.yPhase === "bubble") {
      // title.asm:146 ldpikacry e, PikachuCry1 -- the long "Pikachuuu"
      if (++this.yTimer === 3) this.audio()?.playPikaClip?.(1);
      // WaitForSoundToFinish before the music: a cry's length, near enough
      if (this.yTimer >= 60) {
        this.audio()?.play?.("Music_TitleScreen");
        this.yPhase = "loop";
        this.blinkTimer = 0;
      }
    }
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

  /**
   * The title's UP + SELECT + B (DisplayTitleScreen -> DoClearSaveDialogue,
   * engine/menus/save.asm): "Clear all saved data?" over NO / YES, NO first.
   * YES empties the card's save, and the title's menu loses CONTINUE.
   */
  private clearSaveChord(): boolean {
    const i = this.game.input;
    if (!(i.isDown?.("up") && i.isDown?.("select") && i.isDown?.("b"))) return false;
    if (!this.game.showChoice || !this.game.deleteSave) return false;
    const text = (this.game.data?.text ?? {})._ClearSaveDataText ?? "Clear all saved\ndata?";
    this.game.showChoice(text, (yes) => {
      if (!yes) return;
      this.game.deleteSave!();
      this.menu = this.menu.filter((m) => m !== "CONTINUE");
      this.index = 0;
    }, { defaultNo: true });
    return true;
  }

  update(): void {
    const p = this.game.input.pressed;
    if (this.phase === "press" && (!this.yellow || this.yPhase === "loop") && this.clearSaveChord()) return;
    if (this.yellow && this.phase === "press") {
      if (this.yPhase !== "loop") { this.yellowSequence(); return; } // input waits for the landing
      // DoTitleScreenFunction's blink: at 0, $80 and $90 of an 8-bit clock,
      // half / closed / half over nine frames
      const t = this.blinkTimer;
      this.blinkTimer = (t + 1) % 256;
      if (t === 0 || t === 0x80 || t === 0x90) this.blinkAt = 0;
      if (this.blinkAt >= 0 && ++this.blinkAt > 9) this.blinkAt = -1;
      if (p.start || p.a) {
        this.audio()?.playPikaClip?.(11); // title.asm:180 PikachuCry11
        this.phase = "menu";
        this.index = 0;
      }
      return;
    }
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
    if (this.yellow) return this.yellowView();
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
    row(titlePage(data, "gamefreak"), COPYRIGHT_GAMEFREAK, COPYRIGHT_GAMEFREAK_X, COPYRIGHT_Y);

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

  /** Yellow's composition (title_yellow.asm): no ribbon, no cycling mon;
   * everything rides the logo drop's scroll until it lands. */
  private yellowView(): TitleView {
    const data = this.game.data;
    const dy = -this.scy;
    const at = (r: { x: number; y: number; w: number; h: number }) => ({ ...r, y: r.y + dy });
    const pics: TitleQuad[] = [this.quad(named(data, "logo"), at(Y_LOGO))];
    if (this.showBubble) pics.push(this.quad(named(data, "pika_bubble"), at(Y_BUBBLE)));
    pics.push(this.quad(named(data, "pikachu"), at(Y_PIKACHU)));
    if (this.blinkAt >= 0) {
      const eyes = this.blinkAt <= 3 || this.blinkAt > 6 ? "eyes_half" : "eyes_closed";
      pics.push(this.quad(named(data, eyes), at(Y_EYES)));
    }
    const tiles: TitleTile[] = [];
    if (this.yPhase === "loop") {
      const row = (page: number, seq: readonly number[], x: number, y: number): void => {
        if (page < 0) return;
        seq.forEach((t, i) => tiles.push({ page, tile: t, x: x + i * 8, y, flags: 0 }));
      };
      row(titlePage(data, "copyright"), COPYRIGHT_PREFIX_YELLOW, 16, COPYRIGHT_Y);
      row(titlePage(data, "gamefreak"), COPYRIGHT_GAMEFREAK, COPYRIGHT_GAMEFREAK_X, COPYRIGHT_Y);
    }
    return {
      phase: this.phase,
      monPage: named(data, "pikachu"),
      pics: pics.filter((q) => q.page >= 0),
      tiles,
      menu: this.menu,
      index: this.index,
      hasSave: !!this.game.hasSave,
    };
  }
}
