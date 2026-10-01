// gen1recomp src/ui/gen2/NamePick.lua (bdfac727): the player-name menu
// (pokegold engine/menus/intro_menu.asm NamePlayer, data/player_names.asm
// NameMenuHeader).
//
//   menu_coords 0, 0, 10, TEXTBOX_Y - 1     the box: (0,0) to (10,11)
//   STATICMENU_CURSOR | STATICMENU_PLACE_TITLE | STATICMENU_DISABLE_B
//   5 items, default option 1, title indent 2, title "NAME"
//
// The labels start at (2,2) and step two rows; the cursor sits at column 1;
// the title lands ON the box's top border at (2,0). The other half of the
// screen is the pic: NamePlayer opens with MovePlayerPicRight, walking the
// 7x7 CAL frontpic from hlcoord 6,4 to 13,4 one tile per frame, and a preset
// returns through MovePlayerPicLeft. STATICMENU_DISABLE_B: B does nothing.

import G, { type LcdImage } from "../platform/screen.ts";
import { GameVersion } from "../shared/core/GameVersion.ts";
import { Strings } from "../shared/core/Strings.ts";
import { Font } from "../shared/render/Font.ts";
import { GbcPalette } from "../shared/render/GbcPalette.ts";
import { Screens } from "../shared/ui/Screens.ts";
import { Palettes } from "../world/Palettes.ts";
import { Chrome } from "./Chrome.ts";
import { NamingScreen } from "./NamingScreen.ts";

type Colors = readonly (readonly number[])[];

// Lua: NamePick.lua:40 -- data/player_names.asm PlayerNameArray, one half of
// the IF per edition, and Crystal's two arrays at
// ../pokecrystal/data/player_names.asm:12-16, :31-35.
const PRESETS: Record<string, string[]> = {
  gold: ["GOLD", "HIRO", "TAYLOR", "KARL"],
  silver: ["SILVER", "KAMON", "OSCAR", "MAX"],
  crystal: ["CHRIS", "MAT", "ALLAN", "JON"],
};
const PRESETS_FEMALE: Record<string, string[]> = {
  crystal: ["KRIS", "AMANDA", "JUANA", "JODI"],
};

/**
 * Lua: NamePick.lua:51 -- ShowPlayerNamingChoices picks the header off
 * wPlayerGender (../pokecrystal/engine/gfx/player_gfx.asm:57-62).
 */
function presetsFor(gender?: string | null): string[] {
  const version = GameVersion.get();
  if (gender === "female" && PRESETS_FEMALE[version]) return PRESETS_FEMALE[version]!;
  return PRESETS[version] ?? PRESETS.gold!;
}

// Lua: NamePick.lua:60 -- menu_coords 0, 0, 10, TEXTBOX_Y - 1 (TEXTBOX_Y = 12).
const BOX_X1 = 0;
const BOX_Y1 = 0;
const BOX_X2 = 10;
const BOX_Y2 = 11;
// GetMenuTextStartCoord's answer for this header's flags.
const TEXT_X = 2;
const TEXT_Y = 2;
const CURSOR_X = TEXT_X - 1;
const TITLE = Strings.source("NAME");
const TITLE_X = 2;
const TITLE_Y = 0;
const NEW_NAME = Strings.source("NEW NAME");

// Lua: NamePick.lua:69 -- Intro_PrepTrainerPic puts the 7x7 pic at hlcoord
// 6,4; MovePlayerPic walks it to 13,4 one tile per frame.
const PIC_X_LEFT = 6;
const PIC_X_RIGHT = 13;
const PIC_Y = 4;
const PIC_TILES = 7;

export interface NamePickOpts {
  onDone?: (name?: string) => void;
  font?: any;
  pic?: LcdImage | null;
  picColors?: Colors | null;
  presets?: string[];
  gender?: string;
}

export class NamePick {
  static isOpaque = true;
  static PRESETS = PRESETS;
  static PRESETS_FEMALE = PRESETS_FEMALE;
  static presetsFor = presetsFor;

  [key: string]: any;
  isOpaque = true;
  game: any;
  onDone: ((name?: string) => void) | undefined;
  gender: string | undefined;
  items: string[];
  cursor = 1;
  pic: LcdImage | null | undefined;
  picColors: Colors | null | undefined;
  fontOk = false;
  picX = PIC_X_LEFT;
  slide: "in" | "out" | null = "in";
  pendingName?: string;

  /** Lua: NamePick.lua:77 -- opts: onDone(name), font, pic, picColors, presets, gender */
  constructor(game: any, opts: NamePickOpts = {}) {
    this.game = game;
    this.onDone = opts.onDone;
    this.gender = opts.gender ?? (game && game.save && game.save.player && game.save.player.gender) ?? undefined;
    this.items = [NEW_NAME];
    for (const name of opts.presets ?? presetsFor(this.gender)) this.items.push(name);
    // `db 1 ; default option`: the cursor starts on NEW NAME, not on a preset.
    this.cursor = 1;
    this.pic = opts.pic;
    this.picColors = opts.picColors;
    const font = opts.font;
    if (font) {
      try {
        Font.load({ font });
        this.fontOk = true;
      } catch {
        this.fontOk = false;
      }
    }
    // picX is the pic's live tile column: the column IS the state.
    this.picX = PIC_X_LEFT;
    this.slide = "in";
  }

  /** Lua: NamePick.lua:77 */
  static new(game: any, opts?: NamePickOpts): NamePick {
    return new NamePick(game, opts ?? {});
  }

  /** Lua: NamePick.lua:72 */
  wantsFillScale(): boolean {
    return true;
  }

  /** Lua: NamePick.lua:73 */
  drawsWidescreen(): boolean {
    return true;
  }

  /** Lua: NamePick.lua:106 */
  choose(name?: string): void {
    if (this.onDone) this.onDone(name);
  }

  /** Lua: NamePick.lua:112 -- NEW NAME opens Gold's own keyboard. */
  openNaming(): void {
    const data = (this.game && this.game.data) || {};
    const sprites = data.gen2Sprites;
    const def = sprites && sprites[NamingScreen.playerSprite(this.gender)];
    Screens.push(this.game, "Gen2NamingScreen", {
      type: "player",
      gender: this.gender,
      menuGfx: data.gen2MenuGfx,
      iconPath: def ? def.image : undefined,
      // Chris is PAL_OW_RED and Kris PAL_OW_BLUE
      // (../pokecrystal/engine/overworld/player_object.asm:32-39); the naming
      // screen is lit like day.
      iconColors: data.gen2Palettes ? Palettes.spritePalette(data.gen2Palettes, "DAY", def) : undefined,
      onDone: (name?: string) => {
        // An empty name keeps the default.
        this.game.stack.pop(); // the naming screen
        if (name && name.length > 0) this.choose(name);
        else this.choose(this.items[1] ?? presetsFor(this.gender)[0]);
      },
    });
  }

  /** Lua: NamePick.lua:141 */
  update(_dt?: number): void {
    // MovePlayerPic is a blocking DelayFrame loop on the cart: nothing reads
    // the joypad until the pic has finished walking.
    if (this.slide === "in") {
      if (this.picX < PIC_X_RIGHT) {
        this.picX += 1;
        return;
      }
      this.slide = null;
      return;
    } else if (this.slide === "out") {
      if (this.picX > PIC_X_LEFT) {
        this.picX -= 1;
        return;
      }
      this.slide = null;
      this.choose(this.pendingName);
      return;
    }

    const input = this.game.input;
    if (!input) return;
    if (input.wasPressed("up")) {
      this.cursor = this.cursor > 1 ? this.cursor - 1 : this.items.length;
    } else if (input.wasPressed("down")) {
      this.cursor = this.cursor < this.items.length ? this.cursor + 1 : 1;
    } else if (input.wasPressed("a") || input.wasPressed("start")) {
      // `ld a, [wMenuCursorY]; dec a; jr z, .NewName`. B is deliberately not
      // handled -- STATICMENU_DISABLE_B.
      if (this.cursor === 1) {
        if (this.fontOk) this.openNaming();
        else this.choose(this.items[1] ?? presetsFor(this.gender)[0]);
      } else {
        // A preset returns through MovePlayerPicLeft.
        this.pendingName = this.items[this.cursor - 1];
        this.slide = "out";
      }
    }
  }

  /** Lua: NamePick.lua:186 */
  drawPic(): void {
    const pic = this.pic;
    if (!pic) return;
    const [, h] = pic.getDimensions();
    // PlaceGraphic lays a 7x7 block from the coordinate; a smaller pic sits in
    // the block's bottom-left, as PadFrontpic leaves it.
    const x = this.picX * 8;
    const y = PIC_Y * 8 + (PIC_TILES - h / 8) * 8;
    const body = (): void => {
      G.setColor(1, 1, 1, 1);
      G.draw(pic, x, y);
    };
    if (this.picColors && GbcPalette.available()) GbcPalette.with(this.picColors, body);
    else body();
    G.setColor(1, 1, 1, 1);
  }

  /** Lua: NamePick.lua:206 */
  drawPanel(): void {
    Chrome.clear();
    this.drawPic();
    // The menu is only up once the pic has finished walking over.
    if (this.slide === "in") return;
    if (!this.fontOk) {
      // NOT FAITHFUL: the Lua's love.graphics.print fallback is Font.draw here
      G.setColor(0, 0, 0, 1);
      this.items.forEach((label, i) => {
        const index = i + 1;
        const prefix = index === this.cursor ? "> " : "  ";
        Font.draw(prefix + (index === 1 ? Strings.get(label) : label), TEXT_X * 8, (TEXT_Y + (index - 1) * 2) * 8);
      });
      G.setColor(1, 1, 1, 1);
      return;
    }
    // MenuBox: GetMenuBoxDims then `dec b / dec c`.
    Chrome.textbox(BOX_X1, BOX_Y1, BOX_X2 - BOX_X1 - 1, BOX_Y2 - BOX_Y1 - 1);
    // PlaceString REPLACES the tilemap cells it lands on: the border tiles
    // under the title go.
    G.setColor(1, 1, 1, 1);
    const title = Strings.get(TITLE);
    G.rectangle("fill", TITLE_X * 8, TITLE_Y * 8, Font.split(title).length * 8, 8);
    Chrome.print(title, TITLE_X, TITLE_Y);
    this.items.forEach((label, i) => {
      Chrome.print(i === 0 ? Strings.get(label) : label, TEXT_X, TEXT_Y + i * 2);
    });
    Chrome.cursor(CURSOR_X, TEXT_Y + (this.cursor - 1) * 2);
    G.setColor(1, 1, 1, 1);
  }

  /** Lua: NamePick.lua:241 */
  draw(): void {
    this.drawPanel();
  }

  /** Lua: NamePick.lua:245 -- the Gold screen is the panel: no fit. */
  drawWidescreen(winW: number, winH: number): void {
    Chrome.letterbox(winW, winH, 1, 1, 1);
    G.push();
    G.translate(...Chrome.fitOrigin());
    this.drawPanel();
    G.pop();
  }
}

export default NamePick;
