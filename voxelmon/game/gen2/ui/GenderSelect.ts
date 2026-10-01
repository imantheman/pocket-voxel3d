// gen1recomp src/ui/gen2/GenderSelect.lua (bdfac727):
// ../pokecrystal/engine/menus/init_gender.asm:23-41 InitGender, which
// PlayerProfileSetup runs before OakSpeech (engine/menus/intro_menu.asm:61-83).
// Crystal-only in practice: OakSpeech pushes it only when the cache carries
// Kris (FieldMoves.hasGenderChoice), which Gold and Silver do not.

import G from "../platform/screen.ts";
import { CommonText } from "../core/CommonText.ts";
import { Music } from "../shared/core/Music.ts";
import { RomText } from "../shared/core/RomText.ts";
import { Sound } from "../shared/core/Sound.ts";
import { Strings } from "../shared/core/Strings.ts";
import { GbcPalette } from "../shared/render/GbcPalette.ts";
import { Chrome } from "./Chrome.ts";
import { IntroFade } from "./IntroFade.ts";
import { Typer } from "./Typer.ts";

type Colors = readonly (readonly number[])[];

// Lua: GenderSelect.lua:26 -- menu_coords 6, 4, 12, 9 -- inclusive, so 7x6.
const BOX_X = 6;
const BOX_Y = 4;
const BOX_W = 7;
const BOX_H = 6;
const TEXT_X = BOX_X + 2;
const TEXT_Y = BOX_Y + 2;
const CURSOR_X = TEXT_X - 1;
const ROW_STEP = 2;

// Lua: GenderSelect.lua:33 -- TEXTBOX_X / TEXTBOX_Y / TEXTBOX_INNERX /
// TEXTBOX_INNERY (../pokecrystal/constants/text_constants.asm:25-32).
const SAY_X = 0;
const SAY_Y = 12;
const SAY_W = 18;
const SAY_H = 4;
const SAY_TEXT_X = 1;
const SAY_TEXT_Y = 14;

// Lua: GenderSelect.lua:43 -- pokecrystal/engine/menus/init_gender.asm:31-33
const MENU_OPEN_FRAMES = 4;
// Lua: GenderSelect.lua:48 -- `ld a, $10 / ld [wMusicFade]` with MUSIC_NONE
// (../pokecrystal/engine/menus/init_gender.asm:59-65).
const FADE_CONTROL = 0x10;
// Lua: GenderSelect.lua:51 -- `ld c, 10 / call DelayFrames` on the way out
// (../pokecrystal/engine/menus/init_gender.asm:39-40).
const EXIT_FRAMES = 10;

const FALLBACK = Strings.source("Are you a boy?\nOr are you a girl?");

const PALETTE: Colors = [
  [255, 255, 255],
  [74, 247, 255],
  [8, 90, 255],
  [0, 0, 0],
];

export interface GenderSelectOpts {
  onDone?: (gender: string) => void;
  save?: any;
  fades?: boolean;
}

export class GenderSelect {
  static isOpaque = true;
  // Lua: GenderSelect.lua:20 -- .MenuData's two items
  // (../pokecrystal/engine/menus/init_gender.asm:50-53) and the byte each writes.
  static OPTIONS = [
    { label: Strings.source("Boy"), gender: "male" },
    { label: Strings.source("Girl"), gender: "female" },
  ];
  // Lua: GenderSelect.lua:37 -- gfx/new_game/gender_screen.pal:1-4
  static PALETTE = PALETTE;
  static GROUND = PALETTE[1]!;
  static MENU_OPEN_FRAMES = MENU_OPEN_FRAMES;

  [key: string]: any;
  isOpaque = true;
  game: any;
  save: any;
  onDone: ((gender: string) => void) | undefined;
  data: any;
  cursor = 1;
  exit: number | null = null;
  fades: boolean;
  text: string;
  typer: Typer;
  chosen?: string;
  menuWait?: number;

  /** Lua: GenderSelect.lua:59 -- opts: onDone(gender), save */
  constructor(game: any, opts: GenderSelectOpts = {}) {
    this.game = game;
    this.save = opts.save ?? (game ? game.save : undefined);
    this.onDone = opts.onDone;
    this.data = (game && game.data) || {};
    // `db 1 ; default option`: the cursor opens on Boy.
    this.cursor = 1;
    this.exit = null;
    this.fades = !!opts.fades;
    this.text = CommonText.plain(RomText(this.data, "_AreYouABoyOrAreYouAGirlText", FALLBACK));
    // ../pokecrystal/home/print_text.asm:5, ../pokecrystal/engine/menus/init_gender.asm:30-34
    this.typer = Typer.new(game, {});
    this.typer.start(this.text);
  }

  /** Lua: GenderSelect.lua:59 */
  static new(game: any, opts?: GenderSelectOpts): GenderSelect {
    return new GenderSelect(game, opts ?? {});
  }

  /** Lua: GenderSelect.lua:55 */
  wantsFillScale(): boolean {
    return true;
  }

  /** Lua: GenderSelect.lua:56 */
  drawsWidescreen(): boolean {
    return true;
  }

  /** Lua: GenderSelect.lua:78 */
  enter(): void {
    Music.fadeOut(FADE_CONTROL);
  }

  /** Lua: GenderSelect.lua:82 */
  playSfx(name: string): void {
    const sfx = this.data.audio && this.data.audio.sfx;
    if (sfx && sfx[Sound.resolve(this.data, name)]) Sound.play(this.data, name);
  }

  /** Lua: GenderSelect.lua:89 */
  choose(index: number): void {
    const option = GenderSelect.OPTIONS[index - 1] ?? GenderSelect.OPTIONS[0]!;
    if (this.save && this.save.player) this.save.player.gender = option.gender;
    this.chosen = option.gender;
    this.exit = EXIT_FRAMES;
  }

  /** Lua: GenderSelect.lua:98 */
  leave(): void {
    const done = (): void => {
      if (this.onDone) this.onDone(this.chosen!);
    };
    // ../pokecrystal/engine/rtc/timeset.asm:22
    if (this.fades) return IntroFade.run(this, ["outBlack"], done);
    done();
  }

  /** Lua: GenderSelect.lua:108 -- pokecrystal/engine/menus/init_gender.asm:29-34 */
  menuOpen(): boolean {
    if (!this.typer) return true;
    return this.typer.done() && (this.menuWait ?? MENU_OPEN_FRAMES) <= 0;
  }

  /** Lua: GenderSelect.lua:113 */
  update(_dt?: number): void {
    // ../pokecrystal/home/fade.asm:22-101
    if (IntroFade.advance(this)) return;
    if (this.typer) this.typer.tick();
    if (this.exit != null) {
      this.exit -= 1;
      if (this.exit > 0) return;
      this.exit = null;
      this.leave();
      return;
    }
    if (!this.menuOpen()) {
      if (this.typer.done()) {
        if (this.menuWait != null) this.menuWait -= 1;
        else this.menuWait = MENU_OPEN_FRAMES;
      }
      return;
    }
    const input = this.game && this.game.input;
    if (!input) return;
    // STATICMENU_WRAP, and STATICMENU_DISABLE_B: no `b` arm at all.
    if (input.wasPressed("up")) {
      this.cursor = this.cursor > 1 ? this.cursor - 1 : GenderSelect.OPTIONS.length;
    } else if (input.wasPressed("down")) {
      this.cursor = this.cursor < GenderSelect.OPTIONS.length ? this.cursor + 1 : 1;
    } else if (input.wasPressed("a") || input.wasPressed("start")) {
      // MenuClickSound (../pokecrystal/home/menu.asm:793-803).
      this.playSfx("Sfx_ReadText2");
      this.choose(this.cursor);
    }
  }

  /** Lua: GenderSelect.lua:148 */
  drawPanel(): void {
    const palette = GenderSelect.PALETTE;
    // pokecrystal/engine/menus/init_gender.asm:93-101
    const ground = GbcPalette.color(palette, 2) ?? GenderSelect.GROUND;
    G.setColor(ground[0]! / 255, ground[1]! / 255, ground[2]! / 255, 1);
    G.rectangle("fill", 0, 0, Chrome.SCREEN_W * 8, Chrome.SCREEN_H * 8);
    G.setColor(1, 1, 1, 1);
    Chrome.paletteBox(SAY_X, SAY_Y, SAY_W + 2, SAY_H + 2, palette);
    // ../pokecrystal/home/text.asm:473
    Chrome.printWrapped((Typer.text(this, []) as string[]).join("\n"), SAY_TEXT_X, SAY_TEXT_Y, SAY_W, 2, 2, palette);
    // pokecrystal/engine/menus/init_gender.asm:31-34
    if (!this.menuOpen()) return;
    Chrome.paletteBox(BOX_X, BOX_Y, BOX_W, BOX_H, palette);
    GenderSelect.OPTIONS.forEach((option, i) => {
      const row = TEXT_Y + i * ROW_STEP;
      Chrome.printThrough(Strings.get(option.label), TEXT_X, row, palette);
      if (i + 1 === this.cursor) Chrome.cursorThrough(CURSOR_X, row, palette);
    });
  }

  /** Lua: GenderSelect.lua:172 */
  drawBody(): void {
    IntroFade.paint(this, Chrome.SCREEN_W * 8, Chrome.SCREEN_H * 8, () => this.drawPanel());
  }

  /** Lua: GenderSelect.lua:177 */
  draw(): void {
    Chrome.withClip(() => this.drawBody());
  }

  /** Lua: GenderSelect.lua:181 */
  drawWidescreen(winW: number, winH: number): void {
    const [r, g, b] = IntroFade.surround(this, GenderSelect.PALETTE, 1, 1, 1);
    Chrome.withPanel(winW, winH, r, g, b, () => this.drawBody());
  }
}

export default GenderSelect;
