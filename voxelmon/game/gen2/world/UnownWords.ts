// gen1recomp src/world/gen2/UnownWords.lua at bdfac727 (MIT).
//
// ../pokecrystal/engine/events/unown_walls.asm:102 DisplayUnownWords, and the
// Unown alphabet it writes out of ../pokecrystal/constants/charmap.asm:424;
// :1 HoOhChamber, :13 OmanyteChamber, :54 SpecialAerodactylChamber and :81
// SpecialKabutoChamber, the four routines that open the chambers' walls.
//
// The words window is Gold-screen 2D UI: its draw stays in the screen API's
// terms (Chrome, GbcPalette, Assets and `G`, the love.graphics stand-in).

import { Assets } from "../shared/render/Assets.ts";
import { Chrome } from "../ui/Chrome.ts";
import { GbcPalette } from "../shared/render/GbcPalette.ts";
import { Palettes, type Colors4 } from "./Palettes.ts";
import { Sound } from "../shared/core/Sound.ts";
import G, { type LcdImage, type Quad } from "../platform/screen.ts";

/** An events.unownWalls row (tile coords of the MenuBox, and its chars). */
export interface UnownWall {
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
  chars?: number[];
  [k: string]: any;
}

/** One 16x16 letter: its tile-coord origin and the four tile ids. */
export interface UnownSquare {
  tx: number;
  ty: number;
  tl: number;
  tr: number;
  bl: number;
  br: number;
}

export interface UnownWordsOpts {
  wall?: UnownWall;
  world?: any;
  onClose?: () => void;
}

// Lua: UnownWords.lua:22 -- unown_walls.asm:225 .YChar, :237 .ZChar,
// :249 .DashChar
const FIXED: Record<number, [number, number, number, number]> = {
  0x60: [0x5b, 0x5c, 0x4d, 0x5d],
  0x62: [0x4e, 0x4f, 0x5e, 0x5f],
  0x64: [0x02, 0x03, 0x03, 0x02],
};

export class UnownWords {
  static isOpaque = false;
  isOpaque = false;

  // Lua: UnownWords.lua:18 -- engine/tilesets/map_palettes.asm:40,
  // constants/tileset_constants.asm:55
  static BANK1 = 0x80;
  static BROWN = 6; // 1-based BG slot (set[BROWN - 1])

  // Lua: UnownWords.lua:62 -- constants/event_flags.asm:486-489, the four
  // Crystal-only EVENT_WALL_OPENED_IN_*_CHAMBER bits.
  static WALL_OPENED: Record<string, number> = {
    HO_OH: 806,
    KABUTO: 807,
    OMANYTE: 808,
    AERODACTYL: 809,
  };

  // Lua: UnownWords.lua:71 -- unown_walls.asm:60, :87, the
  // GetMapAttributesPointer compare the two non-special routines are gated on.
  static CHAMBER_MAPS: Record<string, string> = {
    HO_OH: "RUINS_OF_ALPH_HO_OH_CHAMBER",
    KABUTO: "RUINS_OF_ALPH_KABUTO_CHAMBER",
    OMANYTE: "RUINS_OF_ALPH_OMANYTE_CHAMBER",
    AERODACTYL: "RUINS_OF_ALPH_AERODACTYL_CHAMBER",
  };

  // Lua: UnownWords.lua:79 -- unown_walls.asm:4, :22
  static HO_OH = "HO_OH";
  static WATER_STONE = "WATER_STONE";

  game: any;
  wall: UnownWall | undefined;
  world: any;
  onClose: (() => void) | undefined;
  done: boolean;
  squares: UnownSquare[];
  atlas: LcdImage | false | undefined;
  colors: Colors4 | undefined;

  // Lua: UnownWords.lua:28 -- returns a TUPLE [tl, tr, bl, br] (four values).
  static square(char: number): [number, number, number, number] {
    const fixed = FIXED[char];
    if (fixed) return [fixed[0], fixed[1], fixed[2], fixed[3]];
    const base = UnownWords.BANK1 + char;
    return [base, base + 1, base + 0x10, base + 0x11];
  }

  // Lua: UnownWords.lua:36 -- unown_walls.asm:122-127; TUPLE [tx, ty].
  static origin(wall: UnownWall): [number, number] {
    return [(wall.x1 ?? 0) + 1, (wall.y1 ?? 0) + 2];
  }

  // Lua: UnownWords.lua:41 -- unown_walls.asm:119 MenuBox, home/menu.asm:131
  // GetMenuBoxDims; TUPLE [x, y, w, h] in tiles.
  static boxRect(wall: UnownWall): [number, number, number, number] {
    const x1 = wall.x1 ?? 0;
    const y1 = wall.y1 ?? 0;
    return [x1, y1, (wall.x2 ?? x1) - x1 + 1, (wall.y2 ?? y1) - y1 + 1];
  }

  // Lua: UnownWords.lua:47 -- unown_walls.asm:182 _DisplayUnownWords_CopyWord
  static layout(wall: UnownWall): UnownSquare[] {
    const [tx, ty] = UnownWords.origin(wall);
    const out: UnownSquare[] = [];
    const chars = wall.chars || [];
    for (let i = 0; i < chars.length; i++) {
      const char = chars[i];
      if (char == null) break; // ipairs
      const [tl, tr, bl, br] = UnownWords.square(char);
      out[i] = { tx: tx + i * 2, ty, tl, tr, bl, br };
    }
    return out;
  }

  // Lua: UnownWords.lua:83 -- unown_walls.asm:16 EventFlagAction CHECK_FLAG
  static wallOpened(events: any, chamber: string): boolean {
    const flag = UnownWords.WALL_OPENED[chamber];
    if (!(events && flag != null)) return false;
    const v = events.get(flag);
    return v != null && v !== false;
  }

  // Lua: UnownWords.lua:90 -- unown_walls.asm:8 EventFlagAction SET_FLAG
  static openWall(events: any, chamber: string): boolean {
    const flag = UnownWords.WALL_OPENED[chamber];
    if (!(events && flag != null)) return false;
    const v = events.get(flag);
    if (v != null && v !== false) return false;
    events.set(flag, true);
    return true;
  }

  // Lua: UnownWords.lua:100 -- unown_walls.asm:2-5: wPartySpecies[0], which
  // holds EGG rather than the hatchling's species while a slot is an egg.
  static leadIsHoOh(party: any[] | null | undefined): boolean {
    const lead = party ? party[0] : undefined;
    if (!lead || lead.isEgg) return false;
    return lead.species === UnownWords.HO_OH;
  }

  // Lua: UnownWords.lua:108 -- unown_walls.asm:28-43: wPartyCount down to 1,
  // MON_ITEM on each, so the LAST slot holding one is the one it stops at.
  // Returns the 1-based party slot.
  static waterStoneSlot(party: any[] | null | undefined): number | undefined {
    party = party || [];
    for (let slot = party.length; slot >= 1; slot--) {
      const mon = party[slot - 1];
      if (mon && mon.item === UnownWords.WATER_STONE) return slot;
    }
    return undefined;
  }

  // Lua: UnownWords.lua:119 -- unown_walls.asm:54, whose carry FlashFunction
  // jumps on at engine/events/overworld.asm:285.
  static aerodactylChamber(events: any, mapId: string | undefined): boolean {
    if (mapId !== UnownWords.CHAMBER_MAPS.AERODACTYL) return false;
    UnownWords.openWall(events, "AERODACTYL");
    return true;
  }

  // Lua: UnownWords.lua:127 -- unown_walls.asm:81, off the escape rope arm of
  // EscapeRopeOrDig (engine/events/overworld.asm:809).
  static kabutoChamber(events: any, mapId: string | undefined): boolean {
    if (mapId !== UnownWords.CHAMBER_MAPS.KABUTO) return false;
    UnownWords.openWall(events, "KABUTO");
    return true;
  }

  // Lua: UnownWords.lua:134 -- constants/script_constants.asm:319 UNOWNWORDS_*
  static wallFor(data: any, scriptVar?: number): UnownWall | undefined {
    const walls = data && data.gen2EventTables ? data.gen2EventTables.unownWalls : undefined;
    if (!walls) return undefined;
    return walls[scriptVar ?? 0];
  }

  // Lua: UnownWords.lua:141 -- opts: wall (an events.unownWalls row), world,
  // onClose()
  constructor(game: any, opts?: UnownWordsOpts) {
    opts = opts || {};
    this.game = game;
    this.wall = opts.wall;
    this.world = opts.world;
    this.onClose = opts.onClose;
    this.done = false;
    this.squares = this.wall ? UnownWords.layout(this.wall) : [];
  }

  static new(game: any, opts?: UnownWordsOpts): UnownWords {
    return new UnownWords(game, opts);
  }

  // Lua: UnownWords.lua:154 -- unown_walls.asm:155 _DisplayUnownWords_FillAttr.
  // Returns a TUPLE [tileset, atlas], or undefined (the Lua's nil).
  tileset(): [any, LcdImage] | undefined {
    const world = this.world;
    const map = world ? world.map : undefined;
    const def = map ? map.def : undefined;
    const tileset = def && world.tilesets ? world.tilesets[def.tileset] : undefined;
    if (!tileset || !tileset.image) return undefined;
    if (this.atlas === undefined) {
      let image: LcdImage | undefined;
      try {
        image = Assets.image(tileset.image);
      } catch {
        image = undefined;
      }
      this.atlas = image || false;
      if (this.atlas) this.atlas.setFilter("nearest", "nearest");
      const set = world.palettes
        ? Palettes.bgSet(world.palettes, def, world.daytime || "DAY") : undefined;
      this.colors = set ? set[UnownWords.BROWN - 1] : undefined;
    }
    if (!this.atlas) return undefined;
    return [tileset, this.atlas];
  }

  // Lua: UnownWords.lua:173 -- unown_walls.asm:147 PlayClickSFX, :148
  // CloseWindow
  finish(): void {
    if (this.done) return;
    this.done = true;
    const game = this.game;
    if (game && game.data) Sound.play(game.data, "SFX_READ_TEXT_2");
    if (game && game.stack) game.stack.pop();
    if (this.onClose) this.onClose();
  }

  // Lua: UnownWords.lua:182
  update(_dt?: number): void {
    if (this.done) return;
    const input = this.game ? this.game.input : undefined;
    if (!input) return;
    if (input.wasPressed("a") || input.wasPressed("b")) this.finish();
  }

  // Lua: UnownWords.lua:189 -- Gold-screen UI, kept in the screen API's terms.
  draw(): void {
    const wall = this.wall;
    if (!wall) return;
    const [bx, by, bw, bh] = UnownWords.boxRect(wall);
    Chrome.paletteBox(bx, by, bw, bh);
    const ts = this.tileset();
    if (!ts) return;
    const [tileset, atlas] = ts;
    const perRow: number = tileset.tilesPerRow ?? 16;
    const [aw, ah] = atlas.getDimensions();
    const quads: Record<number, Quad> = {};
    const quadFor = (tile: number): Quad => {
      let q = quads[tile];
      if (!q) {
        q = G.newQuad((tile % perRow) * 8, Math.floor(tile / perRow) * 8, 8, 8, aw, ah);
        quads[tile] = q;
      }
      return q;
    };
    const body = (): void => {
      G.setColor(1, 1, 1, 1);
      for (const square of this.squares) {
        const x = square.tx * 8;
        const y = square.ty * 8;
        G.draw(atlas, quadFor(square.tl), x, y);
        G.draw(atlas, quadFor(square.tr), x + 8, y);
        G.draw(atlas, quadFor(square.bl), x, y + 8);
        G.draw(atlas, quadFor(square.br), x + 8, y + 8);
      }
    };
    if (this.colors && GbcPalette.available()) {
      GbcPalette.with(this.colors, body);
    } else {
      body();
    }
    G.setColor(0, 0, 0, 1);
  }
}

export default UnownWords;
