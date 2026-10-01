// gen1recomp src/ui/gen2/TradeAnim.lua (bdfac727, MIT): the trade
// animation's screen (engine/movie/trade_animation.asm).
//
// The script and every frame count is core/TradeAnim.ts's; this file is the
// half that draws. NPCTrade runs it between DoNPCTrade and TradedForText and
// nothing about the trade depends on it, so B skips straight to the end (the
// cart has no skip).
//
// gfx/trade/ comes out of the cache as data.gen2Trade: one 49-tile sheet the
// two tilemaps index, plus the ball, the poof, the tube bulge and the bubble
// as OAM sheets. The objects are quadrants (data/sprite_anims/oam.asm): a
// 2x2 block drawn four times mirrored into a 32x32 sprite. A sprite anim's
// x, y is its ORIGIN, the middle of the sprite.
//
// Coordinates, all from the ASM: the frontpic is PlaceGraphic's 7x7 box at
// hlcoord 7, 2 (56, 16); the stats panel a Textbox at hlcoord 3, 0, 15x8
// tiles, in the window at hWY $50, so (24, 80); the link tube a 12x3 tilemap
// at hlcoord 8, 2 (64, 16); the ball at (80, 68); the bulge at y 24.
//
// SCX scrolls the BACKGROUND, so a positive hSCX moves the picture LEFT.
//
// On the Gold screen the scrolls are the cart's own: where the Lua translates
// a BG layer by an hSCX/hWX offset, this draws it unscrolled on the BG map
// and sets that band's SCX per scanline (platform/lcd.ts `lines`), the window
// bands (stats panel, tube strip) being BG rows that keep their own SCX. The
// unrolled Game Boy scene is laid into the 32-column map with wraparound,
// as the cart's tilemap swaps at $50 / $a0 do.

import { tostring, truthy } from "../platform/lua.ts";
import G, { currentLcd, type LcdImage, type Quad, SOLID } from "../platform/screen.ts";
import { ATTR_HOLE, ATTR_X_FLIP, ATTR_Y_FLIP, LCD_H } from "../platform/lcd.ts";
import { TradeAnim as Anim, type TradeBeat, type TradeRecord } from "../core/TradeAnim.ts";
import { Unown } from "../core/Unown.ts";
import { Palettes } from "../world/Palettes.ts";
import { Assets } from "../shared/render/Assets.ts";
import { Font } from "../shared/render/Font.ts";
import { GbcPalette } from "../shared/render/GbcPalette.ts";
import { MonAnimView } from "../shared/render/MonAnimView.ts";
import { Music } from "../shared/core/Music.ts";
import { Sound } from "../shared/core/Sound.ts";
import { Strings } from "../shared/core/Strings.ts";
import { Sprites } from "../shared/pokemon/Sprites.ts";
import { Chrome } from "./Chrome.ts";
import { TradeMenu } from "./TradeMenu.ts";

// Lua: TradeAnim.lua:64 -- PlaceGraphic's box and the stats panel's Textbox, in tiles.
const PIC_TILE_X = 7;
const PIC_TILE_Y = 2;
const PIC_TILES = 7;
const PANEL_X = 3;
const PANEL_Y = 0;
const PANEL_INNER_W = 13;
const PANEL_INNER_H = 6;
const WINDOW_Y = 0x50;

// Lua: TradeAnim.lua:70 -- TradeLinkTubeTilemap at hlcoord 8, 2.
const TUBE_X = 64;
const TUBE_Y = 16;
const TUBE_W = 96;
const TUBE_H = 24;

// Lua: TradeAnim.lua:73 -- the ball, the poof and the bulge.
const BALL_X = 80;
const BALL_Y = 68;
const BULGE_Y = 24;
// Lua: TradeAnim.lua:77 -- TradeAnim_DropBall's SPRITEANIMSTRUCT_YOFFSET $dc.
const DROP_OFFSET = -36;

// Lua: TradeAnim.lua:80 -- TradeAnim_Poof's wFrameCounter.
const POOF_FRAMES = 16;

// Lua: TradeAnim.lua:88 -- the unrolled Game Boy scene.
const GB_W = 48;
const GB_H = 64;
const GB_A_X = 24;
const GB_A_Y = 16;
const GB_B_X = 0x100 + 80;
const GB_B_Y = 48;
const CABLE_Y = 3 * 8 + 4;
const CABLE_FROM = 72;
const CABLE_TURN = 0x100 + 17 * 8;
const CABLE_DOWN_TO = 7 * 8;
const CABLE_IN = 0x100 + 16 * 8;

// Lua: TradeAnim.lua:108 -- the cable TradeAnim_TubeAnimJumptable ByteFills.
const CABLE_PLUG = 0x5b;
const CABLE_RUN = 0x60;
const CABLE_CORNER_DOWN = 0x5d;
const CABLE_DROP = 0x61;
const CABLE_CORNER_IN = 0x5f;
const CABLE_CELLS: [number, number, number][] = [];
{
  const cell = (column: number, row: number, id: number): void => {
    CABLE_CELLS.push([column, row, id]);
  };
  cell(9, 3, CABLE_PLUG);
  for (let column = 10; column <= 48; column++) cell(column, 3, CABLE_RUN);
  cell(49, 3, CABLE_CORNER_DOWN);
  for (let row = 4; row <= 6; row++) cell(49, row, CABLE_DROP);
  cell(49, 7, CABLE_CORNER_IN);
  cell(48, 7, CABLE_PLUG);
}

// Lua: TradeAnim.lua:137 -- the window strip under the two pans (hWY $70).
const STRIP_Y = 0x70;
const STRIP_RULE_ROW = 0;
const STRIP_NAME_ROW = 1;
const STRIP_ARROW_ROW = 2;
const STRIP_OT_ROW = 3;
const STRIP_ARROW_X = 7;
const STRIP_ARROWS = 6;

// Lua: TradeAnim.lua:143 -- the speech box.
const BOX_X = 0;
const BOX_Y = 12;
const BOX_W = 20;
const BOX_H = 6;
const TEXT_X = 1;
const TEXT_Y = 14;
const TEXT_LINE = 2;

// Lua: TradeAnim.lua:150 -- which beats hold the speech box open.
const BOX_BEATS: Record<string, boolean> = {
  sent_blank: true, sent_text: true, ot_sends_a: true, ot_sends_b: true,
  farewell_a: true, farewell_b: true, take_care: true,
};

// Lua: TradeAnim.lua:157
const GIVE_BEATS: Record<string, boolean> = { givemon_scroll: true, givemon_hold: true };
const TUBE_BEATS: Record<string, boolean> = {
  tube_in: true, tube_hold: true, ball_rock: true, bulge: true,
  tube_in2: true, tube_hold2: true, tube_out: true, ball_wait: true,
};
const GET_BEATS: Record<string, boolean> = {
  getmon_poof: true, getmon_hold: true, take_care: true,
};

// Lua: TradeAnim.lua:169 -- fallbacks (data/text/common_1.asm), each with the
// buffer list its text_ram rows name.
const FALLBACK: Record<string, { text: string; buffers: string[] }> = {
  _MonWasSentToText: {
    text: Strings.source("{STRBUF} was\nsent to {STRBUF}."),
    buffers: ["wPlayerTrademonSpeciesName", "wOTTrademonSenderName"],
  },
  _ForYourMonSendsText: {
    text: Strings.source("For {STRBUF}'s\n{STRBUF},"),
    buffers: ["wPlayerTrademonSenderName", "wPlayerTrademonSpeciesName"],
  },
  _OTSendsText: {
    text: Strings.source("{STRBUF} sends\n{STRBUF}."),
    buffers: ["wOTTrademonSenderName", "wOTTrademonSpeciesName"],
  },
  _BidsFarewellToMonText: {
    text: Strings.source("{STRBUF} bids\nfarewell to"),
    buffers: ["wOTTrademonSenderName"],
  },
  _MonNameBidsFarewellText: {
    text: Strings.source("{STRBUF}."),
    buffers: ["wOTTrademonSpeciesName"],
  },
  _TakeGoodCareOfMonText: {
    text: Strings.source("Take good care of\n{STRBUF}."),
    buffers: ["wOTTrademonSpeciesName"],
  },
};

// Lua: TradeAnim.lua:200 -- TrademonStats_MonTemplate's rows (0, 4, 6).
const TEMPLATE_ROWS: { row: number; text: string }[] = [
  { row: 0, text: "─── №." },
  { row: 4, text: "OT/" },
  { row: 6, text: "<ID>№." },
];

// Lua: TradeAnim.lua:207 -- gfx/sgb/predef.pal:29
function scale5(value: number): number {
  return Math.floor((value * 255) / 31 + 0.5);
}
const TRADE_TUBE_PAL: number[][] = [
  [scale5(31), scale5(31), scale5(31)],
  [scale5(18), scale5(20), scale5(27)],
  [scale5(11), scale5(15), scale5(23)],
  [0, 0, 0],
];

export interface TradeAnimOpts {
  /** The npc_trades.asm row, for the OT name and id. */
  row?: any;
  /** The party record that just left (NpcTrade.perform's first answer). */
  given?: any;
  /** The one that arrived (its second). */
  received?: any;
  /** For the player's own name and id. */
  save?: any;
  /** The event tables, for the animation's lines. */
  eventTables?: any;
  /** data.gen2Trade, when the caller has its own. */
  gfx?: any;
  /** Fired once, on the last frame or on a skip (the caller pops the screen). */
  onDone?: () => void;
}

export class TradeAnimView {
  // Lua: TradeAnim.lua:61
  static isOpaque = true;
  isOpaque = true;
  [key: string]: any;

  game: any;
  data: any;
  palettes: any;
  save: any;
  row: any;
  eventTables: any;
  onDone?: () => void;
  give: TradeRecord;
  get: TradeRecord;
  frame: number;
  beatIndex: number | undefined;
  beat: TradeBeat | undefined;
  offset: number | undefined;
  picCache: Record<string, LcdImage | false>;
  iconCache: Record<string, LcdImage | false>;
  gfx: any;
  imageCache: Record<string, LcdImage | false>;
  quadCache: Map<LcdImage, Quad[]>;
  done?: boolean;
  /** The BG bands drawn unscrolled this frame and the SCX each shows at. */
  bands: [number, number, number][] = [];
  /** The pan while the unrolled scene is being laid into the BG map. */
  scenePan: number | null = null;

  /** Lua: TradeAnim.lua:219 */
  wantsFillScale(): boolean {
    return true;
  }

  /** Lua: TradeAnim.lua:220 */
  drawsWidescreen(): boolean {
    return true;
  }

  /**
   * Lua: TradeAnim.lua:229 -- opts: row, given, received, save, eventTables,
   * onDone() (fired once, on the last frame or on a skip).
   */
  static new(game: any, opts?: TradeAnimOpts): TradeAnimView {
    return new TradeAnimView(game, opts);
  }

  constructor(game: any, opts?: TradeAnimOpts) {
    const o: TradeAnimOpts = opts || {};
    this.game = game;
    this.data = (game && game.data) || {};
    this.palettes = this.data.gen2Palettes;
    this.save = o.save || (game && game.save);
    this.row = o.row;
    this.eventTables = o.eventTables || {};
    this.onDone = o.onDone;
    [this.give, this.get] = Anim.records(this.data, this.save, this.row, o.given, o.received);
    this.frame = -1;
    this.beatIndex = undefined;
    this.picCache = {};
    this.iconCache = {};
    this.gfx = o.gfx || this.data.gen2Trade;
    this.imageCache = {};
    this.quadCache = new Map();
    // RunTradeAnimScript's `ld de, MUSIC_EVOLUTION / call PlayMusic2`.
    const songs = this.data.audio && this.data.audio.songs;
    if (songs && songs.Music_Evolution) {
      Music.play(this.data, "Music_Evolution", true, { reason: "trade" });
    }
    this.step();
  }

  /** Lua: TradeAnim.lua:258 */
  playSfx(name: string): void {
    const sfx = this.data.audio && this.data.audio.sfx;
    if (sfx && sfx[Sound.resolve(this.data, name)]) {
      Sound.play(this.data, name);
    }
  }

  /** Lua: TradeAnim.lua:265 */
  playCry(species: any): void {
    const cries = this.data.audio && this.data.audio.cries;
    if (species != null && species !== false && cries && cries[species]) {
      Sound.playCry(this.data, species);
    }
  }

  // ------------------------------------------------------------------- clock

  /**
   * Lua: TradeAnim.lua:278 -- one frame of DoTradeAnimation: the beat this
   * frame lands in, and its setup when it is a new one.
   */
  step(): void {
    this.frame = this.frame + 1;
    const [beat, offset, index] = Anim.beatAt(this.frame);
    this.beat = beat;
    this.offset = offset;
    if (index !== this.beatIndex) {
      this.beatIndex = index;
      this.cue(beat.cue);
      // ../pokecrystal/engine/movie/trade_animation.asm:64-65
      if (beat.id === "getmon_hold") this.startPicAnim();
    }
  }

  /** Lua: TradeAnim.lua:291 -- ../pokecrystal/engine/gfx/trademon_frontpic.asm:36-37 */
  startPicAnim(): void {
    const record = this.get;
    const species = record && record.species;
    const [path, , vanilla] = this.picPath(record);
    this.picAnim = MonAnimView.start(
      (species != null && this.data.pokemon && this.data.pokemon[species]) || undefined,
      record,
      "trade",
      (p: string) => this.image(p),
      () => {
        this.playCry(species);
      },
      {
        resolve: (sheet: string) => Sprites.pic(sheet, this.picCtx(record, "trade_anim")),
        staticReplaced: MonAnimView.replaced(vanilla, path),
      },
    );
  }

  /** Lua: TradeAnim.lua:306 */
  picCtx(record: any, kind: string): any {
    return {
      species: record && record.species,
      side: "front",
      kind,
      mon: record,
      data: this.data,
      letter: Unown.monLetter(record),
      shiny: !!(record && record.shiny != null && record.shiny !== false),
    };
  }

  /** Lua: TradeAnim.lua:318 */
  picPath(record: any): [string | undefined, boolean, string | undefined] {
    const species = record && record.species;
    const def = species != null && this.data.pokemon && this.data.pokemon[species];
    let vanilla: string | undefined = def ? def.spriteFront : undefined;
    // engine/movie/trade_animation.asm:795-804
    if (species === Unown.SPECIES) {
      vanilla = Unown.formSprite(this.data.pokemon, Unown.monLetter(record)) || vanilla;
    }
    const [path, trueColor] = Sprites.pic(vanilla, this.picCtx(record, "trade"));
    return [path, trueColor, vanilla];
  }

  /** Lua: TradeAnim.lua:331 */
  getAnimData(): any {
    const species = this.get && this.get.species;
    const def = species != null && this.data.pokemon && this.data.pokemon[species];
    return MonAnimView.animData(def || undefined, this.get);
  }

  /** Lua: TradeAnim.lua:337 */
  cue(cue: string | undefined): void {
    if (cue === "show_give") {
      // TradeAnim_ShowGivemonData: the stats, the frontpic, then the cry.
      this.playCry(this.give.species);
    } else if (cue === "poof") {
      // TradeAnim_Poof's SFX_BALL_POOF, then EnterLinkTube1's SFX_POTION.
      this.playSfx("Sfx_BallPoof");
      this.playSfx("Sfx_Potion");
    } else if (cue === "tube") {
      this.playSfx("Sfx_Potion");
    } else if (cue === "give_sfx") {
      this.playSfx("Sfx_GiveTrademon");
    } else if (cue === "get_sfx") {
      this.playSfx("Sfx_GetTrademon");
    } else if (cue === "drop") {
      this.playSfx("Sfx_BallPoof");
    } else if (cue === "show_get") {
      // ../pokecrystal/engine/movie/trade_animation.asm:787-800
      this.playSfx("Sfx_BallPoof");
      // ../pokegold/engine/movie/trade_animation.asm:784-789
      if (!this.getAnimData()) this.playCry(this.get.species);
    }
  }

  /** Lua: TradeAnim.lua:361 */
  finish(): void {
    if (this.done) return;
    this.done = true;
    // NPCTrade's RestartMapMusic, which runs before TradedForText.
    Music.restoreMap(this.data);
    if (this.onDone) this.onDone();
  }

  /** Lua: TradeAnim.lua:369 */
  update(_dt?: number): void {
    if (this.done) return;
    const input = this.game && this.game.input;
    if (input && (input.wasPressed("b") || input.wasPressed("start"))) {
      return this.finish();
    }
    // ../pokecrystal/engine/gfx/pic_animation.asm:79-89
    if (this.picAnim) {
      if (this.picAnim.step()) this.picAnim = null;
      return;
    }
    if (this.frame + 1 >= Anim.TOTAL) return this.finish();
    this.step();
  }

  // -------------------------------------------------------------------- text

  /** Lua: TradeAnim.lua:391 -- the four buffers the animation's lines name. */
  buffers(): Record<string, any> {
    return {
      wPlayerTrademonSpeciesName: this.give.name,
      wPlayerTrademonSenderName: this.give.senderName,
      wOTTrademonSpeciesName: this.get.name,
      wOTTrademonSenderName: this.get.senderName,
    };
  }

  /** Lua: TradeAnim.lua:400 */
  static fill(body: unknown, names: Record<string, any>, buffers?: string[] | null): string {
    let index = 0;
    const text = body != null && body !== false ? tostring(body) : "";
    return text.replace(/\{STRBUF\}/g, () => {
      index = index + 1;
      const slot = (buffers || [])[index - 1];
      if (truthy(slot) && truthy(names[slot!])) return tostring(names[slot!]);
      return tostring(truthy(names.wOTTrademonSpeciesName) ? names.wOTTrademonSpeciesName : "");
    });
  }

  /** Lua: TradeAnim.lua:411 -- the line a beat prints, as up to two rows. */
  lines(id: string | undefined): string[] | undefined {
    const label = id != null ? Anim.TEXT[id] : undefined;
    if (!label) return undefined;
    const texts = this.eventTables.tradeTexts || {};
    let body = texts[label];
    let buffers = (this.eventTables.tradeBuffers || {})[label];
    if (typeof body !== "string") {
      const fallback = FALLBACK[label];
      if (!fallback) return undefined;
      body = fallback.text;
      buffers = fallback.buffers;
    }
    const pages = TradeMenu.paginate(TradeAnimView.fill(body, this.buffers(), buffers));
    return pages[0];
  }

  // ------------------------------------------------------------ draw helpers

  /**
   * Lua: TradeAnim.lua:436 -- every shape reads through the text palette,
   * except on a pan, where SCGB_TRADE_TUBE's palette swaps its two middle
   * colours every 8 frames (engine/movie/trade_animation.asm:1271).
   */
  bgColors(): any {
    const id = (this.beat && this.beat.id) || "";
    const pan = id.includes("_pan_");
    if (!pan) {
      return Palettes.textColors(this.palettes);
    }
    let colors = TRADE_TUBE_PAL;
    // engine/movie/trade_animation.asm:1271
    if (Math.floor((this.frame || 0) / 8) % 2 === 1) {
      colors = [colors[0]!, colors[2]!, colors[1]!, colors[3]!];
    }
    return colors;
  }

  /** Lua: TradeAnim.lua:450 -- `index` is a GB shade, 0 (white) to 3 (black). */
  shade(index: number): [number, number, number] {
    const colors = this.bgColors();
    const rgb =
      GbcPalette.color(colors, index + 1) ||
      [[255, 255, 255], [168, 168, 168], [96, 96, 96], [0, 0, 0]][index]!;
    return [rgb[0]! / 255, rgb[1]! / 255, rgb[2]! / 255];
  }

  /** Lua: TradeAnim.lua:458 */
  setShade(index: number): void {
    const [r, g, b] = this.shade(index);
    G.setColor(r, g, b);
  }

  /** Lua: TradeAnim.lua:466 -- art and shapes through the same four colours. */
  through(body: () => void): void {
    const colors = this.bgColors();
    G.setColor(1, 1, 1, 1);
    if (colors && GbcPalette.available()) {
      GbcPalette.with(colors, body);
    } else {
      body();
    }
    G.setColor(1, 1, 1, 1);
  }

  /** What the cart has in OAM: objects wherever they land, never BG cells. */
  oam(body: () => void): void {
    G.push();
    G.objects = true;
    try {
      body();
    } finally {
      G.pop();
    }
  }

  /** A BG band [y0, y1) drawn unscrolled that shows at SCX `scx` this frame. */
  band(y0: number, y1: number, scx: number): void {
    this.bands.push([y0, y1, scx]);
  }

  /**
   * The frame's scrolls: every map cell still a hole becomes the blank paper
   * (BlankScreen / ClearTilemap leave the whole 32x32 map so, and a scroll
   * shows columns past the 20 drawn), then each band's SCX per scanline.
   */
  present(): void {
    const lcd = currentLcd();
    if (!lcd || this.bands.length === 0) return;
    const c = GbcPalette.color(Chrome.DEFAULT_BOX_PALETTE, 1);
    const rgb: readonly [number, number, number] = [c[0]!, c[1]!, c[2]!];
    const slot = lcd.palette([rgb, rgb, rgb, rgb]);
    for (let i = 0; i < 1024; i++) {
      if (lcd.s.attrs[i]! & ATTR_HOLE) lcd.cell(i & 31, i >> 5, SOLID[0], slot);
    }
    const values = new Array<number>(LCD_H).fill(0);
    for (const [y0, y1, scx] of this.bands) {
      for (let y = Math.max(0, y0); y < Math.min(LCD_H, y1); y++) values[y] = scx & 0xff;
    }
    lcd.lines(2, values);
  }

  /** Lua: TradeAnim.lua:477 */
  image(path: string | undefined | null): LcdImage | null {
    if (!truthy(path)) return null;
    let cached = this.imageCache[path!];
    if (cached === undefined) {
      try {
        cached = Assets.image(path!);
      } catch {
        cached = false;
      }
      if (cached) cached.setFilter("nearest", "nearest");
      this.imageCache[path!] = cached;
    }
    return cached || null;
  }

  /**
   * Lua: TradeAnim.lua:493 -- one of the object sheets (ball, poof, bulge,
   * bubble, arrows) and how many tiles across it is; null for a cache that
   * predates the trade gfx.
   */
  art(key: string): [LcdImage, number] | null {
    const entry = this.gfx && this.gfx[key];
    if (typeof entry !== "object" || entry === null) return null;
    const image = this.image(entry.image);
    if (!image) return null;
    return [image, entry.sheetTiles ?? 1];
  }

  /** Lua: TradeAnim.lua:503 -- TradeGameBoyLZ's 49 tiles and the base tile id ($31). */
  sheet(): [LcdImage, number, number] | null {
    const gfx = this.gfx;
    if (!(gfx && gfx.image)) return null;
    const image = this.image(gfx.image);
    if (!image) return null;
    return [image, gfx.sheetTiles ?? 7, gfx.baseTile ?? 0x31];
  }

  /** Lua: TradeAnim.lua:511 */
  quad(image: LcdImage, across: number, index: number): Quad {
    let perImage = this.quadCache.get(image);
    if (!perImage) {
      perImage = [];
      this.quadCache.set(image, perImage);
    }
    let quad = perImage[index];
    if (!quad) {
      const [iw, ih] = image.getDimensions();
      quad = G.newQuad((index % across) * 8, Math.floor(index / across) * 8, 8, 8, iw, ih);
      perImage[index] = quad;
    }
    return quad;
  }

  /** Lua: TradeAnim.lua:528 -- one 8x8 tile, optionally mirrored like an OAM attribute. */
  blit(image: LcdImage, across: number, index: number, x: number, y: number, flipX?: boolean, flipY?: boolean): void {
    if (this.scenePan !== null) return this.sceneCell(image, across, index, x, y, flipX, flipY);
    G.draw(image, this.quad(image, across, index), x + (flipX ? 8 : 0), y + (flipY ? 8 : 0), 0, flipX ? -1 : 1, flipY ? -1 : 1);
  }

  /**
   * The unrolled scene's tile at unrolled pixel (x, y), laid into the BG map
   * column it wraps to -- only the 21 columns the pan has in view, so the two
   * tilemap states never collide, as the cart's swaps at $50 / $a0 keep them.
   */
  sceneCell(image: LcdImage, across: number, index: number, x: number, y: number, flipX?: boolean, flipY?: boolean): void {
    const lcd = currentLcd();
    if (!lcd) return;
    const pan = this.scenePan!;
    if (x + 8 <= pan || x >= pan + 160) return;
    const tx = index % across;
    const ty = Math.floor(index / across);
    if (tx >= image.tw || ty >= image.th) return;
    const id = image.ids[ty * image.tw + tx]!;
    const slot = lcd.palette(G.palette);
    const flips = (flipX ? ATTR_X_FLIP : 0) | (flipY ? ATTR_Y_FLIP : 0);
    lcd.cell((x >> 3) & 31, (y >> 3) & 31, id, slot | flips);
  }

  /**
   * Lua: TradeAnim.lua:536 -- a tilemap stamp (TradeAnim_CopyBoxFromDEtoHL)
   * at the pixel its hlcoord lands on; false with no cache art.
   */
  drawTilemap(map: any, x: number, y: number): boolean {
    if (typeof map !== "object" || map === null || !Array.isArray(map.tiles)) return false;
    const s = this.sheet();
    if (!s) return false;
    const [image, across, base] = s;
    this.through(() => {
      for (let index = 0; index <= map.width * map.height - 1; index++) {
        const id = map.tiles[index];
        if (id != null && id >= base) {
          this.blit(image, across, id - base, x + (index % map.width) * 8, y + Math.floor(index / map.width) * 8);
        }
      }
    });
    return true;
  }

  /**
   * Lua: TradeAnim.lua:556 -- an object built out of one mirrored quadrant,
   * `side` tiles square, drawn four times centred on the origin x, y.
   */
  drawQuadrant(image: LcdImage, across: number, first: number, side: number, x: number, y: number): void {
    for (let quadY = 0; quadY <= 1; quadY++) {
      for (let quadX = 0; quadX <= 1; quadX++) {
        for (let tileY = 0; tileY <= side - 1; tileY++) {
          for (let tileX = 0; tileX <= side - 1; tileX++) {
            const dx = quadX === 0 ? tileX - side : side - 1 - tileX;
            const dy = quadY === 0 ? tileY - side : side - 1 - tileY;
            this.blit(image, across, first + tileY * side + tileX, x + dx * 8, y + dy * 8, quadX === 1, quadY === 1);
          }
        }
      }
    }
  }

  /** Lua: TradeAnim.lua:571 */
  pic(record: any): [LcdImage | null, boolean] {
    const [path, trueColor] = this.picPath(record);
    if (!truthy(path)) return [null, trueColor];
    let cached = this.picCache[path!];
    if (cached === undefined) {
      try {
        cached = Assets.image(path!);
      } catch {
        cached = false;
      }
      this.picCache[path!] = cached;
    }
    return [cached || null, trueColor];
  }

  /**
   * Lua: TradeAnim.lua:587 -- TradeAnim_ShowFrontpic's PlaceGraphic, padded
   * bottom-first. The Lua draws it `offset` to the left; here a pic on the
   * tile grid stays on the BG map and hSCX moves its band (the cart's way),
   * and one Brian's centring puts off the grid is objects moved by `offset`.
   */
  drawPic(record: any, offset: number): void {
    const [image, tc] = this.pic(record);
    let trueColor = tc;
    if (!image) return;
    let [w, h] = image.getDimensions();
    // ../pokecrystal/engine/gfx/pic_animation.asm:431-435
    let sheet: LcdImage | undefined;
    let quad: Quad | undefined;
    let size: number | undefined;
    if (this.picAnim && record === this.get) {
      const f = this.picAnim.frame();
      if (f) [sheet, quad, size] = f;
    }
    if (sheet) {
      w = size!;
      h = size!;
    }
    const box = PIC_TILES * 8;
    const px0 = PIC_TILE_X * 8 + Math.floor((box - w) / 2);
    const py = PIC_TILE_Y * 8 + (box - h);
    const onGrid = px0 % 8 === 0 && py % 8 === 0;
    const px = onGrid ? px0 : px0 - offset;
    if (onGrid && offset !== 0) this.band(0, WINDOW_Y, offset);
    G.setColor(1, 1, 1, 1);
    const colors = Palettes.monColors(this.palettes, record.species, record.shiny);
    const body = (): void => {
      G.push();
      if (!onGrid) G.objects = true;
      if (sheet) G.draw(sheet, quad, px, py);
      else G.draw(image, px, py);
      G.pop();
    };
    if (sheet) trueColor = this.picAnim.trueColor;
    if (colors && !(trueColor && GbcPalette.mode === "gbc") && GbcPalette.available()) {
      GbcPalette.with(colors, body);
    } else {
      body();
    }
  }

  /**
   * Lua: TradeAnim.lua:618 -- ShowPlayerTrademonStats / ShowOTTrademonStats,
   * in the window at hWY $50. The Lua translates it by `offset` (hWX); here
   * it is BG rows 10-17 whose SCX is -offset.
   */
  drawStats(record: any, offset: number): void {
    G.push();
    G.translate(0, WINDOW_Y);
    if (offset !== 0) this.band(WINDOW_Y, LCD_H, -offset);
    Chrome.textbox(PANEL_X, PANEL_Y, PANEL_INNER_W, PANEL_INNER_H);
    // pokegold engine/movie/trade_animation.asm:883-897,925-929: PlaceString
    // and PrintNum overwrite the border's own tile at cols 4-12, row 0.
    G.setColor(1, 1, 1, 1);
    G.rectangle("fill", (PANEL_X + 1) * 8, PANEL_Y * 8, 9 * 8, 8);
    for (const row of TEMPLATE_ROWS) {
      Chrome.print(Strings.get(row.text), PANEL_X + 1, row.row);
    }
    Chrome.print(Chrome.number(record.dex || 0, 3, true), PANEL_X + 7, 0);
    Chrome.print(record.name, PANEL_X + 1, 2);
    Chrome.print(record.otName, PANEL_X + 4, 4);
    Chrome.print(Chrome.number(record.id || 0, 5, true), PANEL_X + 4, 6);
    G.pop();
  }

  /**
   * Lua: TradeAnim.lua:640 -- TradeLinkTubeTilemap. The Lua draws it at
   * TUBE_X - offset; here it stays at TUBE_X and hSCX moves the BG.
   */
  drawTube(offset: number): void {
    const x = TUBE_X;
    if (offset !== 0) this.band(0, LCD_H, offset);
    if (this.drawTilemap(this.gfx && this.gfx.tube, x, TUBE_Y)) return;
    // NOT FAITHFUL: the no-art fallback's outline is a line rectangle with
    // rounded corners, which the Gold screen cannot draw (only the two fills
    // show). Only a cache without gfx/trade reaches it.
    this.setShade(3);
    G.rectangle("line", x + 0.5, TUBE_Y + 0.5, TUBE_W - 1, TUBE_H - 1);
    this.setShade(2);
    G.rectangle("fill", x + 4, TUBE_Y + 4, TUBE_W - 8, 2);
    G.rectangle("fill", x + 4, TUBE_Y + TUBE_H - 6, TUBE_W - 8, 2);
    G.setColor(1, 1, 1, 1);
  }

  /**
   * Lua: TradeAnim.lua:657 -- TradeBallGFX on .Frameset_TradePokeBallWobble:
   * frame 1 / frame 2 / frame 1 / frame 2 X-flipped, 3 ticks each.
   */
  drawBall(x: number, y: number, rocking: boolean): void {
    const a = this.art("ball");
    if (a) {
      const [image, across] = a;
      const step = rocking ? Math.floor((this.offset || 0) / 3) % 4 : 0;
      this.oam(() =>
        this.through(() => {
          if (step % 2 === 0) {
            this.blit(image, across, 0, x - 8, y - 8);
            this.blit(image, across, 0, x, y - 8, true);
            this.blit(image, across, 1, x - 8, y);
            this.blit(image, across, 1, x, y, true);
          } else {
            // The fourth frame's B_OAM_XFLIP mirrors the whole object.
            const flip = step === 3;
            for (let index = 0; index <= 3; index++) {
              let column = index % 2;
              if (flip) column = 1 - column;
              this.blit(image, across, 2 + index, x - 8 + column * 8, y - 8 + Math.floor(index / 2) * 8, flip);
            }
          }
        }),
      );
      return;
    }
    // NOT FAITHFUL: the no-art fallback ball is circles, which the Gold
    // screen cannot draw; only its centre band shows. Only a cache without
    // gfx/trade reaches it.
    let lean = 0;
    if (rocking) lean = Math.floor((this.offset || 0) / 8) % 2 === 0 ? -1 : 1;
    const cx = x + 4 + lean;
    const cy = y + 4;
    this.setShade(3);
    G.circle("fill", cx, cy, 5);
    this.setShade(0);
    G.circle("fill", cx, cy, 4);
    this.setShade(3);
    G.rectangle("fill", cx - 4, cy - 1, 9, 2);
    G.circle("fill", cx, cy, 1.5);
    G.setColor(1, 1, 1, 1);
  }

  /**
   * Lua: TradeAnim.lua:697 -- TradePoofGFX on .Frameset_TradePoof: three
   * 4-tile frames at 4 ticks each, each a 2x2 quadrant mirrored into 32x32.
   */
  drawPoof(x: number, y: number, t: number): void {
    const a = this.art("poof");
    if (a) {
      const [image, across] = a;
      const frame = Math.min(2, Math.floor(t / 4));
      this.oam(() =>
        this.through(() => {
          this.drawQuadrant(image, across, frame * 4, 2, x, y);
        }),
      );
      return;
    }
    // NOT FAITHFUL: the no-art fallback poof is a circle outline, a no-op on
    // the Gold screen. Only a cache without gfx/trade reaches it.
    const step = Math.floor(t / 4);
    const radius = 4 + step * 3;
    this.setShade(3 - Math.min(2, step));
    G.setLineWidth(2);
    G.circle("line", x + 4, y + 4, radius);
    G.setLineWidth(1);
    G.setColor(1, 1, 1, 1);
  }

  /**
   * Lua: TradeAnim.lua:718 -- the unrolled Game Boy scene the two pans
   * travel. The Lua translates it by -pan; here its tiles go into the BG map
   * columns they wrap to and hSCX = pan moves the band above the strip.
   */
  drawScene(pan: number): void {
    const s = this.sheet();
    if (s && this.gfx.gameBoy) {
      const [image, across, base] = s;
      this.band(0, STRIP_Y, pan);
      this.scenePan = pan;
      try {
        this.through(() => {
          for (const cell of CABLE_CELLS) {
            this.blit(image, across, cell[2] - base, cell[0] * 8, cell[1] * 8);
          }
        });
        this.drawGameBoy(GB_A_X, GB_A_Y);
        this.drawGameBoy(GB_B_X, GB_B_Y);
      } finally {
        this.scenePan = null;
      }
      G.setColor(1, 1, 1, 1);
      return;
    }
    // NOT FAITHFUL: the no-art fallback keeps the Lua's translate, so the
    // cable and Game Boy shapes land as cells/objects at whole-pixel pans
    // without the BG wrap. Only a cache without gfx/trade reaches it.
    G.push();
    G.translate(-pan, 0);
    this.setShade(3);
    G.rectangle("fill", CABLE_FROM, CABLE_Y, CABLE_TURN - CABLE_FROM, 2);
    G.rectangle("fill", CABLE_TURN, CABLE_Y, 2, CABLE_DOWN_TO - CABLE_Y);
    G.rectangle("fill", CABLE_IN, CABLE_DOWN_TO, CABLE_TURN - CABLE_IN + 2, 2);
    this.drawGameBoy(GB_A_X, GB_A_Y);
    this.drawGameBoy(GB_B_X, GB_B_Y);
    G.pop();
    G.setColor(1, 1, 1, 1);
  }

  /** Lua: TradeAnim.lua:746 -- TradeGameBoyTilemap, 6x8 tiles. */
  drawGameBoy(x: number, y: number): void {
    if (this.drawTilemap(this.gfx && this.gfx.gameBoy, x, y)) return;
    // (no-art fallback; rounded corners and the circles do not exist here)
    this.setShade(3);
    G.rectangle("fill", x, y, GB_W, GB_H);
    this.setShade(1);
    G.rectangle("fill", x + 4, y + 4, GB_W - 8, GB_H - 26);
    this.setShade(0);
    G.rectangle("fill", x + 8, y + 8, GB_W - 16, GB_H - 34);
    this.setShade(1);
    G.circle("fill", x + GB_W - 12, y + GB_H - 16, 3);
    G.circle("fill", x + GB_W - 22, y + GB_H - 12, 3);
    G.rectangle("fill", x + 8, y + GB_H - 17, 8, 3);
    G.rectangle("fill", x + 10, y + GB_H - 19, 3, 8);
    G.setColor(1, 1, 1, 1);
  }

  /**
   * Lua: TradeAnim.lua:767 -- TradeCableGFX on .Frameset_TradeTubeBulge: two
   * one-tile frames at 3 ticks, each mirrored into the 16x16 bulge.
   */
  drawBulge(x: number, y: number, t: number): void {
    const a = this.art("bulge");
    if (!a) return this.drawBall(x, y, false);
    const [image, across] = a;
    const frame = Math.floor((t || 0) / 3) % 2;
    this.oam(() =>
      this.through(() => {
        this.drawQuadrant(image, across, frame, 1, x, y);
      }),
    );
  }

  /**
   * Lua: TradeAnim.lua:780 -- the bubble the mon icon rides in (a 2x2
   * quadrant mirrored into 32x32) and the icon's first frame, both centred.
   */
  drawBubble(record: any, x: number, y: number): void {
    const a = this.art("bubble");
    if (a) {
      const [image, across] = a;
      this.oam(() =>
        this.through(() => {
          this.drawQuadrant(image, across, 0, 2, x, y);
        }),
      );
    } else {
      // NOT FAITHFUL: the no-art fallback bubble is circles, a no-op on the
      // Gold screen. Only a cache without gfx/trade reaches it.
      this.setShade(0);
      G.circle("fill", x, y, 11);
      this.setShade(3);
      G.circle("line", x + 0.5, y + 0.5, 11);
      G.setColor(1, 1, 1, 1);
    }
    this.drawIcon(record, x - 8, y - 8);
  }

  /**
   * Lua: TradeAnim.lua:800 -- the window strip the two pans run over (hWY
   * $70, so BG rows 14-17 at SCX 0 here): the rule, the two trainers and
   * the six arrows.
   */
  drawTubeStrip(sending: boolean): void {
    G.push();
    G.translate(0, STRIP_Y);
    Chrome.print("─".repeat(Chrome.SCREEN_W), 0, STRIP_RULE_ROW);
    Chrome.print(this.give.senderName, 0, STRIP_NAME_ROW);
    Chrome.printRight(this.get.senderName, Chrome.SCREEN_W, STRIP_OT_ROW);
    const a = this.art("arrows");
    if (a) {
      const [image, across] = a;
      this.through(() => {
        for (let column = 0; column <= STRIP_ARROWS - 1; column++) {
          this.blit(image, across, sending ? 0 : 1, (STRIP_ARROW_X + column) * 8, STRIP_ARROW_ROW * 8);
        }
      });
    }
    G.pop();
    G.setColor(1, 1, 1, 1);
  }

  /** Lua: TradeAnim.lua:820 */
  drawIcon(record: any, x: number, y: number): void {
    const icons = this.data.gen2Icons;
    const iconId = icons && icons.species && record.species != null && icons.species[record.species];
    const entry = iconId != null && iconId !== false && icons.icons && icons.icons[iconId];
    if (!(entry && entry.image)) return;
    let cached = this.iconCache[entry.image];
    if (cached === undefined) {
      try {
        cached = Assets.image(entry.image);
      } catch {
        cached = false;
      }
      this.iconCache[entry.image] = cached;
    }
    if (!cached) return;
    const img = cached;
    const [iw, ih] = img.getDimensions();
    const quad = G.newQuad(0, 0, 16, 16, iw, ih);
    G.setColor(1, 1, 1, 1);
    const colors = Palettes.monColors(this.palettes, record.species, record.shiny);
    // The icon is MONICON_TRADE's OAM object.
    this.oam(() => {
      if (colors && GbcPalette.available()) {
        GbcPalette.with(colors, () => G.draw(img, quad, x, y));
      } else {
        G.draw(img, quad, x, y);
      }
    });
  }

  // -------------------------------------------------------------------- draw

  /** Lua: TradeAnim.lua:849 */
  drawPanel(): void {
    const id = this.beat ? this.beat.id : undefined;
    const t = this.offset || 0;
    this.bands = [];
    // engine/movie/trade_animation.asm:151
    const wasBattle = Font.useBattleExtra(true);
    Chrome.clear();

    if (id != null && GIVE_BEATS[id]) {
      const offset = id === "givemon_scroll" ? Anim.givemonOffset(t) : 0;
      this.drawPic(this.give, offset);
      // The window comes in from the other side: hWX is $88 out when hSCX is.
      this.drawStats(this.give, offset);
    } else if (id != null && TUBE_BEATS[id]) {
      this.drawTubeBeat(id, t);
    } else if (id != null && GET_BEATS[id]) {
      this.drawPic(this.get, 0);
      if (id === "getmon_poof") this.drawPoof(BALL_X, BALL_Y, t);
      // FrontpicScrollStart puts the window back up for Wait80, and
      // TextboxScrollStart takes it away again for the last line.
      if (id === "getmon_hold") this.drawStats(this.get, 0);
    } else if (id != null) {
      const pan = Anim.pan(id, t);
      if (pan !== undefined) this.drawPanBeat(id, t, pan);
    }

    if (id != null && BOX_BEATS[id]) {
      Chrome.box(BOX_X, BOX_Y, BOX_W, BOX_H);
      (this.lines(id) || []).forEach((line, index) => {
        Chrome.print(line, TEXT_X, TEXT_Y + index * TEXT_LINE);
      });
    }
    this.present();
    G.setColor(1, 1, 1, 1);
    Font.useBattleExtra(wasBattle);
  }

  /** Lua: TradeAnim.lua:884 */
  drawTubeBeat(id: string, t: number): void {
    let offset = 0;
    if (id === "tube_in" || id === "tube_in2" || id === "tube_out") {
      offset = Anim.tubeOffset(id, t);
    }
    this.drawTube(offset);
    if (id === "tube_in") {
      // The poof is still running while the cable slides over it.
      if (t < POOF_FRAMES) {
        this.drawPoof(BALL_X, BALL_Y, t);
      } else {
        this.drawBall(BALL_X, BALL_Y, true);
      }
    } else if (id === "tube_hold" || id === "ball_rock") {
      this.drawBall(BALL_X, BALL_Y, true);
    } else if (id === "bulge") {
      // TradeAnim_AnimateTrademonInTube walks the bulge cap to cap over 128 frames.
      const span = TUBE_W - 16;
      const x = TUBE_X + 8 + Math.floor((span * t) / 128);
      this.drawBulge(x, BULGE_Y, t);
    } else if (id === "tube_out") {
      // DropBall starts the ball $dc (-36) above its rest and lets it fall.
      const drop = Math.min(0, DROP_OFFSET + t);
      this.drawBall(BALL_X, BALL_Y + drop, false);
    } else if (id === "ball_wait") {
      this.drawBall(BALL_X, BALL_Y, true);
    }
  }

  /** Lua: TradeAnim.lua:915 */
  drawPanBeat(id: string, t: number, pan: number): void {
    this.drawScene(pan);
    const sending = id.slice(0, 4) === "send";
    // TradeAnim_AnimateTrademonInTube walks the object along the cable and
    // then despawns it; it is only parked while the pan itself runs.
    const at = Anim.tubeIcon(id, t);
    if (at) {
      const [x, y] = at;
      this.drawBubble(sending ? this.give : this.get, x, y);
    }
    this.drawTubeStrip(sending);
  }

  /** Lua: TradeAnim.lua:927 */
  draw(): void {
    this.drawPanel();
  }

  /** Lua: TradeAnim.lua:931 */
  drawWidescreen(winW: number, winH: number): void {
    Chrome.letterbox(winW, winH, 1, 1, 1);
    const scale = Chrome.fitScale();
    G.push();
    G.translate(...Chrome.fitOrigin());
    G.scale(scale, scale);
    this.drawPanel();
    G.pop();
  }
}

export default TradeAnimView;
