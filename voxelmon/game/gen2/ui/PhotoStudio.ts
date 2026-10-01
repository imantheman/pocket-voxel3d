// gen1recomp src/ui/gen2/PhotoStudio.lua (bdfac727, MIT): the Cianwood photo
// studio's portrait card (engine/printer/print_party.asm PrintPartyMonPage1),
// reached through `special PhotoStudio` once the fishing guru's yes/no gate
// has been answered yes and a party mon picked.
//
// There is no Game Boy Printer here, so only page 1 -- the portrait itself --
// is transcribed; the special always lands on the cancel branch afterward,
// as a cartridge with nothing in its link port would.
//
// Coordinates are the literal hlcoord operands PrintPartyMonPage1 writes at:
//
//   hlcoord 0, 0    PrepMonFrontpic, a 7x7 block
//   hlcoord 8, 0    "№." then the dex number, 3 digits, leading zeros
//   hlcoord 8, 2    the level (PrintLevel_Force3Digits)
//   hlcoord 12, 2   the HP icon then the max HP, 3 digits
//   hlcoord 8, 4    the nickname
//   hlcoord 9, 6    a bare '/' then the species name at hlcoord 10, 6
//   hlcoord 0, 7    Textbox, 9 rows by 18 columns
//   hlcoord 1, 9    "OT/" then the OT name at hlcoord 4, 9
//   hlcoord 1, 11   "<ID>№" then the id number at hlcoord 4, 11, 5 digits
//   hlcoord 1, 14   "MOVE" then the first move's name at hlcoord 7, 14
//   PlaceGenderAndShininess: gender at hlcoord 17, 2, the shiny ⁂ at 18, 2

import G from "../platform/screen.ts";
import type { LcdImage } from "../platform/screen.ts";
import { Assets } from "../shared/render/Assets.ts";
import { Font } from "../shared/render/Font.ts";
import { GbcPalette } from "../shared/render/GbcPalette.ts";
import { Sprites } from "../shared/pokemon/Sprites.ts";
import { Strings } from "../shared/core/Strings.ts";
import { Palettes } from "../world/Palettes.ts";
import { Chrome } from "./Chrome.ts";

export interface PhotoStudioOpts {
  mon?: any;
  playerName?: string;
  pokemon?: Record<string, any>;
  moves?: Record<string, any>;
  palettes?: any;
  onClose?: () => void;
}

// Lua: PhotoStudio.lua:56 -- the pic's offset inside the 7x7 block, by width.
const PIC_PAD: Record<number, [number, number]> = { 7: [0, 0], 6: [1, 1], 5: [1, 2] };

/** Lua: PhotoStudio.lua:58 */
function num(value: number, width: number, leadingZeros?: boolean): string {
  return Chrome.number(value, width, leadingZeros);
}

export class PhotoStudio {
  // Lua: PhotoStudio.lua:52
  static isOpaque = true;
  isOpaque = true;

  game: any;
  mon: any;
  playerName: string;
  pokemon: Record<string, any> | undefined;
  moves: Record<string, any> | undefined;
  palettes: any;
  onClose?: () => void;
  done: boolean;
  picCache: Record<string, LcdImage | false>;
  [key: string]: any;

  /** Lua: PhotoStudio.lua:54 */
  wantsFillScale(): boolean {
    return true;
  }

  /** Lua: PhotoStudio.lua:63 -- opts: mon, playerName, pokemon, moves, palettes, onClose() */
  static new(game: any, opts?: PhotoStudioOpts): PhotoStudio {
    return new PhotoStudio(game, opts ?? {});
  }

  constructor(game: any, opts: PhotoStudioOpts) {
    this.game = game;
    const data = (game && game.data) || {};
    const save = game && game.save;
    this.mon = opts.mon;
    this.playerName = opts.playerName || (save && save.player && save.player.name) || "?";
    this.pokemon = opts.pokemon || data.pokemon;
    this.moves = opts.moves || data.moves;
    this.palettes = opts.palettes || data.gen2Palettes;
    this.onClose = opts.onClose;
    this.done = false;
    this.picCache = {};
  }

  /** Lua: PhotoStudio.lua:81 */
  speciesDef(): any {
    const mon = this.mon;
    return mon && this.pokemon && this.pokemon[mon.species];
  }

  /** Lua: PhotoStudio.lua:86 */
  finish(): void {
    if (this.done) return;
    this.done = true;
    if (this.onClose) this.onClose();
  }

  /** Lua: PhotoStudio.lua:92 */
  update(_dt?: number): void {
    if (this.done) return;
    const input = this.game && this.game.input;
    if (!input) return;
    if (input.wasPressed("a") || input.wasPressed("b")) this.finish();
  }

  /** Lua: PhotoStudio.lua:101 */
  picFor(species: string | undefined): [LcdImage | undefined, boolean] {
    const def = species && this.pokemon && this.pokemon[species];
    const vanilla = def && def.spriteFront;
    if (!vanilla) return [undefined, false];
    const mon = this.mon;
    const [path, trueColor] = Sprites.pic(vanilla, {
      species,
      side: "front",
      kind: "photo",
      mon,
      data: this.game && this.game.data,
      shiny: !!(mon && mon.shiny),
    } as any);
    if (!path) return [undefined, trueColor];
    let cached = this.picCache[path];
    if (cached === undefined) {
      try {
        cached = Assets.image(path) || false;
      } catch {
        cached = false;
      }
      this.picCache[path] = cached;
    }
    return [cached || undefined, trueColor];
  }

  /** Lua: PhotoStudio.lua:126 -- PrepMonFrontpic at hlcoord 0, 0, centred in 7x7. */
  drawPic(): void {
    const mon = this.mon;
    if (!mon) return;
    const [image, trueColor] = this.picFor(mon.species);
    if (!image) return;
    const colors = (this.palettes && mon.species && Palettes.monColors(this.palettes, mon.species, mon.shiny)) || undefined;
    const blank = colors ? GbcPalette.color(colors, 1) : [255, 255, 255];
    G.setColor(blank[0]! / 255, blank[1]! / 255, blank[2]! / 255, 1);
    G.rectangle("fill", 0, 0, 7 * 8, 7 * 8);

    const wide = Math.floor(image.getWidth() / 8);
    const pad = PIC_PAD[wide] || PIC_PAD[7]!;
    G.setColor(1, 1, 1, 1);
    const body = () => G.draw(image, pad[0] * 8, pad[1] * 8);
    if (colors && !(trueColor && GbcPalette.mode === "gbc") && GbcPalette.available()) {
      GbcPalette.with(colors, body);
    } else {
      body();
    }
    G.setColor(1, 1, 1, 1);
  }

  /** Lua: PhotoStudio.lua:151 */
  moveName(): string {
    const mon = this.mon;
    const entry = mon && mon.moves && mon.moves[0];
    if (!entry) return "-";
    const def = this.moves && this.moves[entry.id];
    return (def && def.name) || entry.id;
  }

  /** Lua: PhotoStudio.lua:159 */
  drawPanel(): void {
    // PrintPartyMonPage1 opens with LoadFontsBattleExtra: '№' ($74), '<ID>'
    // ($73) and '<LV>' ($6e) come from that sheet.
    const wasBattle = Font.useBattleExtra(true);
    Chrome.clear();
    const mon = this.mon || {};
    const def = this.speciesDef();

    this.drawPic();

    Chrome.print(Strings.get("№."), 8, 0);
    Chrome.print(num((def && def.dex) || 0, 3, true), 10, 0);

    Chrome.print(Strings.get("<LV>") + num(mon.level || 1, 2), 8, 2);
    // `ld de, wTempMonMaxHP / lb bc, 2, 3 / call PrintNum`: one field.
    Chrome.print(Strings.get("HP"), 12, 2);
    Chrome.print(num(mon.maxHp || mon.hp || 0, 3), 14, 2);

    // PlaceGenderAndShininess: gender at hlcoord 17, 2, the shiny ⁂ at 18, 2.
    if (mon.gender === "male") Chrome.print(Strings.get("♂"), 17, 2);
    else if (mon.gender === "female") Chrome.print(Strings.get("♀"), 17, 2);
    if (mon.shiny) Chrome.print(Strings.get("⁂"), 18, 2);

    Chrome.print(mon.nickname || mon.name || mon.species || "?", 8, 4);

    Chrome.print(Strings.get("/"), 9, 6);
    Chrome.print((def && def.name) || mon.species || "?", 10, 6);

    Chrome.textbox(0, 7, 18, 9);

    Chrome.print(Strings.get("OT/"), 1, 9);
    Chrome.print(mon.ot || this.playerName, 4, 9);

    Chrome.print(Strings.get("<ID>№"), 1, 11);
    Chrome.print(num(mon.otId || 0, 5, true), 4, 11);

    Chrome.print(Strings.get("MOVE"), 1, 14);
    Chrome.print(this.moveName(), 7, 14);
    Font.useBattleExtra(wasBattle);
  }

  /** Lua: PhotoStudio.lua:206 */
  draw(): void {
    this.drawPanel();
  }

  /**
   * Lua: PhotoStudio.lua:214 -- PrintPartyMonPage1 opens on ClearBGPalettes /
   * ClearTilemap, so the card owns the screen outright.
   */
  drawsWidescreen(): boolean {
    return true;
  }

  /** Lua: PhotoStudio.lua:216 */
  drawWidescreen(winW: number, winH: number): void {
    Chrome.letterbox(winW, winH, 1, 1, 1);
    const scale = Chrome.fitScale();
    const [ox, oy] = Chrome.fitOrigin();
    G.push();
    G.translate(ox, oy);
    G.scale(scale, scale);
    this.drawPanel();
    G.pop();
  }
}

export default PhotoStudio;
