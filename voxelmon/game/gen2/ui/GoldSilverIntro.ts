// gen1recomp src/ui/gen2/GoldSilverIntro.lua (bdfac727): the Gold/Silver
// intro movie (pokegold engine/movie/intro.asm GoldSilverIntro), transcribed
// rather than approximated.
//
// The cart runs the whole thing off one 17-entry jumptable stepped once per
// frame, and almost everything on screen is a side effect of four bytes:
// hSCX, hSCY and the two intro frame counters. So this module keeps those
// bytes, keeps a real 32x32 BG map, and runs the same scene functions.
//
//   1-5    underwater: Shellders, bubbles, the climb to the surface (one
//          fresh metatile row streamed into the top of the map every 16
//          pixels), Magikarp, Lapras, fade.
//   6-9    grass: scroll to Jigglypuff, notes, Pikachu charges, drop and fade.
//   10-16  fire: climb a black field to the Charizard silhouette while the
//          starters flash across it, open its mouth, breathe a fireball.
//   17     64 frames, then the title screen.
//
// Drawing. The Lua renders the BG map into a 256x256 canvas and presents it
// at (hSCX, hSCY), one quad per scanline while the LY overrides are live.
// The Gold screen IS that hardware: the map goes into the BG map's 32x32
// cells, hSCX/hSCY into its scroll registers, wLYOverrides into its per-line
// SCY (`lcd.lines`), and wShadowOAM into its objects (OAM_PRIO included, so
// Lapras half-submerges exactly as on the cart).
//
// Any button skips the whole thing, exactly as .PlayFrame does on PAD_BUTTONS.

import { ATTR_PRIORITY, ATTR_X_FLIP, ATTR_Y_FLIP, type Palette4 } from "../platform/lcd.ts";
import { mod } from "../platform/lua.ts";
import G, { currentLcd, type LcdImage, SOLID } from "../platform/screen.ts";
import { Logger } from "../shared/core/Logger.ts";
import { Music } from "../shared/core/Music.ts";
import { Sound } from "../shared/core/Sound.ts";
import { Runtime } from "../shared/mods/Runtime.ts";
import { Assets } from "../shared/render/Assets.ts";
import { GbcPalette } from "../shared/render/GbcPalette.ts";
import { Palettes } from "../world/Palettes.ts";
import { SpriteAnims, type SpriteAnimSystem } from "./SpriteAnims.ts";

type Rgb = readonly number[];
type Colors = readonly Rgb[];

// Lua: GoldSilverIntro.lua:44
const SCREEN_W = 160;
const SCREEN_H = 144;
const BG_TILES = 32; // TILEMAP_WIDTH / TILEMAP_HEIGHT
const META_COLS = 16; // TILEMAP_WIDTH / 2
const TILEMAP_W = 20; // SCREEN_WIDTH
const TILEMAP_H = 18; // SCREEN_HEIGHT

// Lua: GoldSilverIntro.lua:50
const INTRO_MUSIC = "Music_GoldSilverOpening";
const INTRO_MUSIC_2 = "Music_GoldSilverOpening2";
const SFX_FIREBALL = "Sfx_GsIntroCharizardFireball";
const SFX_APPEARS = "Sfx_GsIntroPokemonAppears";

// Lua: GoldSilverIntro.lua:57 -- Intro_AnimateOceanWaves' .wave_tiles.
const WAVE_TILES = [
  [0x70, 0x71, 0x72, 0x73],
  [0x74, 0x75, 0x76, 0x77],
  [0x78, 0x79, 0x7a, 0x7b],
  [0x7c, 0x7d, 0x7e, 0x7f],
];
// `vBGMap0 tile $1e` is 480 bytes in, i.e. the whole of BG row 15.
const WAVE_ROW = 15;

// Lua: GoldSilverIntro.lua:68 -- DrawIntroCharizardGraphic .charizard_data.
const CHARIZARD_GFX = [
  { tile: 0x00, width: 8, height: 8, x: 10, y: 6 }, // mouth closed
  { tile: 0x40, width: 9, height: 8, x: 9, y: 6 }, // mouth open
  { tile: 0x88, width: 9, height: 8, x: 8, y: 6 }, // breathing fire
];

// Lua: GoldSilverIntro.lua:78 -- palette ladders (DMG registers through DmgToCgb*Pals).
const WATER_FADE = [0xe4, 0xe4, 0x90, 0x40, 0x00];
const GRASS_FADE = [0xe4, 0xe4, 0xe4, 0xe4, 0xe4, 0x90, 0x40, 0x00];
const CHARIZARD_PALS = [0x6a, 0xa5, 0xe4, 0x00];
const FIRE_FADE = [0xe4, 0x90, 0x40, 0x00];

// Lua: GoldSilverIntro.lua:85 -- Intro_CheckSCYEvent .scy_jumptable.
const SCY_EVENTS: Record<number, string> = {
  [0x86]: "loadChikorita",
  [0x87]: "chikoritaAppears",
  [0x88]: "flashMonPalette",
  [0x98]: "flashSilhouette",
  [0x99]: "loadCyndaquil",
  [0xaf]: "cyndaquilAppears",
  [0xb0]: "flashMonPalette",
  [0xc0]: "flashSilhouette",
  [0xc1]: "loadTotodile",
  [0xd7]: "totodileAppears",
  [0xd8]: "flashMonPalette",
  [0xe8]: "flashSilhouette",
  [0xe9]: "loadCharizard",
};

// Lua: GoldSilverIntro.lua:101
const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];

// ----------------------------------------------------------- Palette plumbing

// Lua: GoldSilverIntro.lua:112 -- CopyPals: colour i shows loaded colour (reg >> 2i) & 3.
function remap(palette: Colors | null | undefined, register: number): Rgb[] {
  const out: Rgb[] = [];
  for (let index = 0; index <= 3; index++) {
    const slot = (register >> (index * 2)) & 3;
    out[index] = (palette && palette[slot]) || BLACK;
  }
  return out;
}

// Lua: GoldSilverIntro.lua:121
function copyPalette(source: Colors | null | undefined): Rgb[] {
  const out: Rgb[] = [];
  for (let index = 0; index < 4; index++) {
    const color = source && source[index];
    out[index] = color ? [color[0]!, color[1]!, color[2]!] : BLACK;
  }
  return out;
}

interface ActData {
  tiles?: string;
  sprites?: string;
  tilemap?: number[];
  meta?: number[];
  firstRow?: number;
}

interface Sheet {
  image: LcdImage;
  count: number;
}

export interface GoldSilverIntroOpts {
  onDone?: () => void;
  intro?: any;
}

type SceneFn = (self: GoldSilverIntro) => void;

export class GoldSilverIntro {
  static isOpaque = true;
  static WATER_FADE = WATER_FADE;
  static GRASS_FADE = GRASS_FADE;
  static CHARIZARD_PALS = CHARIZARD_PALS;
  static FIRE_FADE = FIRE_FADE;
  static SCY_EVENTS = SCY_EVENTS;
  static WAVE_TILES = WAVE_TILES;
  static CHARIZARD_GFX = CHARIZARD_GFX;
  static remap = remap;

  isOpaque = true;
  game: any;
  onDone: (() => void) | undefined;
  monPalettes: any;
  assets: any;
  images: Record<string, LcdImage | false> = {};
  sheets: Record<string, Sheet | false> = {};
  anims: SpriteAnimSystem;
  scene = 1;
  done = false;
  finished = false;
  skipped = false;
  frames = 0;

  // Hardware registers and the movie's own WRAM.
  scx = 0;
  scy = 0;
  counter1 = 0;
  counter2 = 0;
  bgp = 0xe4;
  obp0 = 0xe4;
  lyActive = false;
  /** Lua 1-based [line + 1] -> 0-based [line]. */
  lyOverrides: number[] = [];
  /** 0x81 entries are touched (Lua lySine[1..0x81]); 0-based here. */
  lySine: number[] = [];
  bgPals: Rgb[][];
  obPals: Rgb[][];
  bgmap: number[] = [];
  tilemap: number[] = [];
  act: string | null = null;
  mapDirty = true;
  tilemapRow = 0;
  bgRow = 0;
  hold = 0;

  // Lua: GoldSilverIntro.lua:137
  constructor(game: any, opts: GoldSilverIntroOpts = {}) {
    this.game = game;
    this.onDone = opts.onDone;
    const data = (game && game.data) || {};
    this.monPalettes = data.gen2Palettes;
    this.assets = opts.intro || data.gen2Intro || (game && game.introData) || null;
    if (!this.assets) {
      // The scene script runs either way, so a cache with no intro data plays
      // the movie's 2335 frames over an empty screen. Say so instead.
      Logger.warn("gen2 intro: no intro.lua in the cache -- re-import this version or the movie plays blank");
    }
    this.anims = SpriteAnims.new();
    for (let line = 0; line < SCREEN_H; line++) {
      this.lyOverrides[line] = 0;
      this.lySine[line] = 0;
    }
    this.bgPals = [copyPalette(null)];
    this.obPals = [copyPalette(null), copyPalette(null)];
    for (let index = 0; index < BG_TILES * BG_TILES; index++) this.bgmap[index] = 0;
    for (let index = 0; index < TILEMAP_W * TILEMAP_H; index++) this.tilemap[index] = 0;
    this.mapDirty = true;
  }

  static new(game: any, opts?: GoldSilverIntroOpts): GoldSilverIntro {
    return new GoldSilverIntro(game, opts ?? {});
  }

  // Lua: GoldSilverIntro.lua:134
  wantsFillScale(): boolean {
    return true;
  }

  // Lua: GoldSilverIntro.lua:135
  drawsWidescreen(): boolean {
    return true;
  }

  // ----------------------------------------------------------------- Audio

  // Lua: GoldSilverIntro.lua:282
  playMusic(song: string): void {
    const data = this.game && this.game.data;
    const audio = data && data.audio;
    if (audio && audio.runtime && audio.songs && audio.songs[song]) Music.play(data, song);
  }

  // Lua: GoldSilverIntro.lua:290
  playSfx(name: string): void {
    const data = this.game && this.game.data;
    const audio = data && data.audio;
    if (audio && audio.runtime && audio.sfx && audio.sfx[name]) Sound.play(data, name);
  }

  // ------------------------------------------------------------ Frame loop

  // Lua: GoldSilverIntro.lua:770 -- GoldSilverIntro.PlayFrame minus the joypad read.
  step(): boolean {
    if (this.done) return true;
    this.frames = this.frames + 1;
    this.anims.playFrame();
    const scene = Scenes[this.scene];
    if (scene) scene(this);
    return this.done;
  }

  // Lua: GoldSilverIntro.lua:779 -- intro.boot.movie
  enter(): void {
    if (Runtime.wants("intro.boot.movie")) Runtime.emit("intro.boot.movie", { screen: this, game: this.game });
  }

  // Lua: GoldSilverIntro.lua:791
  finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.done = true;
    if (Runtime.wants("intro.boot.movie_ended")) {
      Runtime.emit("intro.boot.movie_ended", {
        screen: this,
        game: this.game,
        skipped: this.skipped,
        frames: this.frames,
      });
    }
    if (this.onDone) this.onDone();
  }

  // Lua: GoldSilverIntro.lua:809
  skip(): void {
    this.skipped = true;
    this.finish();
  }

  // Lua: GoldSilverIntro.lua:814
  update(_dt?: number): void {
    if (this.finished) return;
    const input = this.game && this.game.input;
    if (input) {
      for (const button of ["a", "b", "start", "select"]) {
        if (input.wasPressed(button)) {
          this.skip();
          return;
        }
      }
    }
    if (this.step()) this.finish();
  }

  // --------------------------------------------------------------- Drawing

  // Lua: GoldSilverIntro.lua:832
  image(path: string | undefined): LcdImage | null {
    if (!path) return null;
    let cached = this.images[path];
    if (cached === undefined) {
      try {
        cached = Assets.image(path) || false;
      } catch {
        cached = false;
      }
      this.images[path] = cached;
    }
    return cached || null;
  }

  // Lua: GoldSilverIntro.lua:848 -- a sheet is 16 tiles wide: tile N at (N % 16, N / 16).
  sheet(path: string | undefined): Sheet | null {
    if (!path) return null;
    const entry = this.sheets[path];
    if (entry !== undefined) return entry || null;
    const image = this.image(path);
    if (!image) {
      this.sheets[path] = false;
      return null;
    }
    const made: Sheet = { image, count: Math.floor(image.w / 8) * Math.floor(image.h / 8) };
    this.sheets[path] = made;
    return made;
  }

  /** Tile id of sheet tile `tile` (16 across), or undefined past the sheet. */
  /**
   * Every tile of a sheet as its Gold-screen id, SOLID[0] past the sheet
   * (a tile past the sheet draws nothing in the Lua: the backdrop shows).
   */
  idTable(sheet: Sheet): Uint16Array {
    const cached = this.idTables.get(sheet);
    if (cached) return cached;
    const t = new Uint16Array(256);
    for (let i = 0; i < 256; i++) t[i] = this.tileId(sheet, i) ?? SOLID[0];
    this.idTables.set(sheet, t);
    return t;
  }
  private idTables = new Map<Sheet, Uint16Array>();

  tileId(sheet: Sheet, tile: number): number | undefined {
    if (tile < 0 || tile >= sheet.count) return undefined;
    const col = tile % 16;
    const row = Math.floor(tile / 16);
    if (col >= sheet.image.tw || row >= sheet.image.th) return undefined;
    return sheet.image.ids[row * sheet.image.tw + col];
  }

  /** The four colours a palette draws as under the COLOR mode (what GbcPalette.use sets). */
  resolved(colors: Colors): Palette4 {
    return GbcPalette.resolvedPalette(colors);
  }

  // Lua: GoldSilverIntro.lua:878 / :919 -- the BG map and its scroll. The Lua
  // caches a 256x256 canvas and presents it per scanline; here the 32x32 cells
  // ARE the BG map, and hSCX/hSCY/wLYOverrides are the screen's registers.
  drawBackground(palette: Colors): void {
    const lcd = currentLcd();
    if (!lcd) return;
    const source = actData(this);
    const sheet = source && this.sheet(source.tiles);
    if (!sheet) return;
    const slot = lcd.palette(this.resolved(palette));
    // The whole 32x32 map every frame, so straight into the cell arrays
    // through a tile -> id table (one tileId per sheet tile, not per cell):
    // this loop was most of the intro's frame on the 3DS. bgmap and the
    // Gold screen's map share the row-major 32x32 layout.
    // The ids are kept between frames and rebuilt only when the map or the
    // sheet changes; a frame is then two native copies.
    const lut = this.idTable(sheet);
    const bg = this.bgmap;
    const ids = this.cellIds;
    if (this.mapDirty || lut !== this.cellIdsLut) {
      for (let i = 0; i < BG_TILES * BG_TILES; i++) ids[i] = lut[bg[i]! & 0xff]!;
      this.cellIdsLut = lut;
    } else {
      for (let k = 0; k < this.changedCount; k++) {
        const i = this.changed[k]!;
        ids[i] = lut[bg[i]! & 0xff]!;
      }
    }
    this.changedCount = 0;
    lcd.s.cells.set(this.cellIds, 0);
    lcd.s.attrs.fill(slot & 0xef, 0, BG_TILES * BG_TILES);
    this.mapDirty = false;
    lcd.regs({ scx: mod(this.scx, 256), scy: mod(this.scy, 256) });
    if (this.lyActive) lcd.lines(1, this.lyOverrides);
    else lcd.lines(0);
  }

  /** The BG map as Gold-screen ids, through `cellIdsLut` (drawBackground). */
  private readonly cellIds = new Uint16Array(BG_TILES * BG_TILES);
  private cellIdsLut: Uint16Array | null = null;
  /** Cells mapSet changed since drawBackground last ran (past 256: the whole map). */
  private readonly changed = new Int16Array(256);
  private changedCount = 0;
  noteCell(i: number): void {
    if (this.mapDirty) return;
    if (this.changedCount === this.changed.length) {
      this.mapDirty = true;
      return;
    }
    this.changed[this.changedCount++] = i;
  }
  /** drawObjects' slot per OAM palette this frame (-1 not yet asked). */
  private readonly objSlots = new Int16Array(8);

  // Lua: GoldSilverIntro.lua:946 -- one pass over wShadowOAM. The Lua draws the
  // OAM_PRIO objects under the BG and the rest over it in two passes; the
  // screen's object priority bit does both at once.
  drawObjects(): void {
    const lcd = currentLcd();
    if (!lcd) return;
    const source = actData(this);
    const sheet = source && this.sheet(source.sprites);
    if (!sheet) return;
    // Earlier objects are on top on the Gold screen, as in OAM. Each OAM
    // palette resolved once a frame, not once an object (objPalette builds
    // a fresh array, so lcd.palette's own last-palette check never hit).
    const slots = this.objSlots;
    slots.fill(-1);
    for (const entry of this.anims.oam) {
      const id = this.tileId(sheet, entry.tile);
      if (id === undefined) continue;
      const pal = entry.attr % 8;
      let slot = slots[pal]!;
      if (slot < 0) {
        slot = lcd.palette(this.resolved(objPalette(this, pal)), true);
        slots[pal] = slot;
      }
      let attr = slot;
      if (entry.attr & SpriteAnims.OAM_XFLIP) attr |= ATTR_X_FLIP;
      if (entry.attr & SpriteAnims.OAM_YFLIP) attr |= ATTR_Y_FLIP;
      if (entry.attr >= SpriteAnims.OAM_PRIO) attr |= ATTR_PRIORITY;
      lcd.obj(entry.x - 8, entry.y - 16, id, attr);
    }
  }

  // Lua: GoldSilverIntro.lua:980 -- compose one 160x144 frame.
  renderFrame(): boolean {
    const pal = bgPalette(this);
    const source = actData(this);
    if (!(source && this.sheet(source.tiles))) return false;
    // BG colour 0 is the backdrop.
    this.drawBackground(pal);
    this.drawObjects();
    return true;
  }

  // Lua: GoldSilverIntro.lua:1013
  drawPanel(): void {
    if (this.renderFrame()) return;
    G.setColor(0, 0, 0, 1);
    G.rectangle("fill", 0, 0, SCREEN_W, SCREEN_H);
    G.setColor(1, 1, 1, 1);
  }

  // Lua: GoldSilverIntro.lua:1026
  draw(): void {
    this.drawPanel();
  }

  // Lua: GoldSilverIntro.lua:1030 -- the Gold screen is the panel: no letterbox or fit.
  drawWidescreen(_winW: number, _winH: number): void {
    this.drawPanel();
  }
}

// ------------------------------------------------------------------ BG map

// Lua: GoldSilverIntro.lua:188
function mapGet(self: GoldSilverIntro, col: number, row: number): number {
  return self.bgmap[mod(row, BG_TILES) * BG_TILES + mod(col, BG_TILES)]!;
}

// Lua: GoldSilverIntro.lua:192
function mapSet(self: GoldSilverIntro, col: number, row: number, tile: number): void {
  // (integer cells: the wrap is & 31) Only a change is noted, and only that
  // cell: the waves rewrite their row nearly every step, mostly with the
  // tiles already there, and a whole-map rebuild each time was most of the
  // ocean scenes' frame on the 3DS.
  const i = (row & (BG_TILES - 1)) * BG_TILES + (col & (BG_TILES - 1));
  if (self.bgmap[i] === tile) return;
  self.bgmap[i] = tile;
  self.noteCell(i);
}

// Lua: GoldSilverIntro.lua:197
function actData(self: GoldSilverIntro): ActData | null {
  return (self.assets && self.act && self.assets[self.act]) || null;
}

// Lua: GoldSilverIntro.lua:203 -- Intro_Draw2x2Tiles: metatile `index` is four tile
// ids in reading order, laid into the 2x2 block at (col, row).
function draw2x2(self: GoldSilverIntro, source: ActData, index: number, col: number, row: number): void {
  const meta = source.meta ?? [];
  for (let quad = 0; quad <= 3; quad++) {
    const tile = meta[index * 4 + quad] ?? 0;
    mapSet(self, col + (quad % 2), row + Math.floor(quad / 2), tile);
  }
}

// Lua: GoldSilverIntro.lua:213 -- Intro_DrawBackground: 16 metatile rows of 16.
function drawBackground(self: GoldSilverIntro, source: ActData, firstRow: number): void {
  const tilemap = source.tilemap ?? [];
  for (let metaRow = 0; metaRow <= BG_TILES / 2 - 1; metaRow++) {
    for (let metaCol = 0; metaCol <= META_COLS - 1; metaCol++) {
      const at = (firstRow + metaRow) * META_COLS + metaCol;
      const index = at >= 0 ? tilemap[at] : undefined;
      draw2x2(self, source, index ?? 0, metaCol * 2, metaRow * 2);
    }
  }
}

// Lua: GoldSilverIntro.lua:227 -- Intro_UpdateTilemapAndBGMap: step back one metatile
// row, draw it in at the top of the (wrapping) map, tick counter1 down.
function updateTilemapAndBGMap(self: GoldSilverIntro, source: ActData): void {
  const tilemap = source.tilemap ?? [];
  self.tilemapRow = self.tilemapRow - 1;
  self.bgRow = mod(self.bgRow - 2, BG_TILES);
  for (let metaCol = 0; metaCol <= META_COLS - 1; metaCol++) {
    const at = self.tilemapRow * META_COLS + metaCol;
    const index = at >= 0 ? tilemap[at] : undefined;
    draw2x2(self, source, index ?? 0, metaCol * 2, self.bgRow);
  }
  self.counter1 = mod(self.counter1 - 1, 256);
}

// Lua: GoldSilverIntro.lua:240 -- Intro_AnimateOceanWaves (no VBlank queue here).
function animateOceanWaves(self: GoldSilverIntro): void {
  if (self.counter2 % 4 === 3) return;
  const cycle = WAVE_TILES[Math.floor((self.counter2 % 0x40) / 0x10)]!;
  for (let col = 0; col <= BG_TILES - 1; col++) {
    mapSet(self, col, WAVE_ROW, cycle[col % 4]!);
  }
}

// ------------------------------------------------------------ LY overrides

// Lua: GoldSilverIntro.lua:256 -- Intro_InitSineLYOverrides.
function initSineLYOverrides(self: GoldSilverIntro): void {
  for (let line = 0; line <= SCREEN_H - 1; line++) {
    self.lySine[line] = SpriteAnims.sine(line, 4);
  }
}

// Lua: GoldSilverIntro.lua:262
function resetLYOverrides(self: GoldSilverIntro): void {
  for (let line = 0; line < SCREEN_H; line++) self.lyOverrides[line] = 0;
  self.lyActive = false;
}

// Lua: GoldSilverIntro.lua:267 -- Intro_UpdateLYOverrides: rotate the sine table by
// one entry and add hSCY; the top 16 lines are held flat at hSCY.
function updateLYOverrides(self: GoldSilverIntro): void {
  for (let line = 0; line < 16; line++) self.lyOverrides[line] = self.scy;
  const first = self.lySine[0]!;
  const scy = self.scy;
  for (let offset = 0; offset <= 0x7f; offset++) {
    const value = self.lySine[offset + 1]!;
    self.lySine[offset] = value;
    // mod(_, 256) of integers
    self.lyOverrides[16 + offset] = (value + scy) & 255;
  }
  self.lySine[0x80] = first;
}

// --------------------------------------------------------------- Scenes

const Scenes: Record<number, SceneFn> = {};

// Lua: GoldSilverIntro.lua:305 -- IntroScene1: set up the water cutscene.
Scenes[1] = (self) => {
  self.scene = 2;
  self.act = "water";
  const source = actData(self);
  if (source) {
    self.tilemapRow = source.firstRow ?? 15;
    self.bgRow = 0;
    drawBackground(self, source, self.tilemapRow);
  }
  self.anims.clear();
  self.scy = 0;
  self.anims.globalY = 0;
  self.anims.globalX = 0;
  self.scx = 0x58;
  self.counter2 = 0;
  self.counter1 = 0x80;
  self.lyActive = true;
  initSineLYOverrides(self);
  self.anims.flag = 0;

  // GetSGBLayout SCGB_GS_INTRO 0 -> _CGB_GSIntro.ShellderLaprasScene.
  const palettes = (self.assets && self.assets.palettes) || {};
  self.bgPals[0] = copyPalette(palettes.waterBg);
  self.obPals[0] = copyPalette(palettes.waterOb && palettes.waterOb[0]);
  self.obPals[1] = copyPalette(palettes.waterOb && palettes.waterOb[1]);
  self.bgp = 0xe4;
  self.obp0 = 0xe4;

  // Intro_InitShellders.
  self.anims.init("GS_INTRO_SHELLDER", 7 * 8, 18 * 8);
  self.anims.init("GS_INTRO_SHELLDER", 10 * 8, 14 * 8);
  self.anims.init("GS_INTRO_SHELLDER", 15 * 8, 16 * 8);
  self.playMusic(INTRO_MUSIC);
};

// Lua: GoldSilverIntro.lua:342 -- Intro_InitBubble .pixel_table; the two slots that
// read past the six-entry table on hardware are dropped, as in the Lua.
const BUBBLE_SPOTS: [number, number][] = [
  [6 * 8, 14 * 8 + 4], [14 * 8, 18 * 8 + 4], [10 * 8, 16 * 8 + 4],
  [12 * 8, 15 * 8], [4 * 8, 13 * 8], [8 * 8, 17 * 8],
];

// Lua: GoldSilverIntro.lua:347
function initBubble(self: GoldSilverIntro): void {
  if (self.counter1 % 16 !== 0) return;
  const spot = BUBBLE_SPOTS[Math.floor((self.counter1 % 0x80) / 0x10)];
  if (!spot) return;
  self.anims.init("GS_INTRO_BUBBLE", spot[0], spot[1]);
}

// Lua: GoldSilverIntro.lua:355 -- IntroScene2: Shellders drift, bubbles rise, $80 frames.
Scenes[2] = (self) => {
  updateLYOverrides(self);
  if (self.counter1 !== 0) {
    self.counter1 = self.counter1 - 1;
    initBubble(self);
    return;
  }
  self.counter1 = 0x10;
  self.scene = 3;
  return Scenes[3]!(self);
};

// Lua: GoldSilverIntro.lua:370 -- Intro_InitMagikarps' two sets of spots.
const MAGIKARP_SPOTS: [number, number][][] = [
  [[28 * 8, 29 * 8], [0 * 8, 26 * 8], [24 * 8, 0 * 8]],
  [[30 * 8, 28 * 8], [24 * 8, 31 * 8], [28 * 8, 2 * 8]],
];

// Lua: GoldSilverIntro.lua:375
function initMagikarps(self: GoldSilverIntro): void {
  if (self.counter2 % 0x40 !== 0) return;
  const set = MAGIKARP_SPOTS[self.counter2 % 0x80 !== 0 ? 1 : 0]!;
  for (const spot of set) self.anims.init("GS_INTRO_MAGIKARP", spot[0], spot[1]);
}

// Lua: GoldSilverIntro.lua:383
function initLapras(self: GoldSilverIntro): void {
  if (self.counter2 % 0x20 !== 0) return;
  self.anims.init("GS_INTRO_LAPRAS", 24 * 8, 16 * 8);
}

// Lua: GoldSilverIntro.lua:392 -- IntroScene3_Jumper's 17 entries, indexed by counter1
// (the Lua table is [0]-based too).
const SCENE3_STEPS = [
  "waves", "waves", "waves", "lapras", "waves", "waves",
  "magikarp", "magikarp", "magikarp", "palettes", "noLY",
  "ly", "ly", "ly", "ly", "ly", "ly",
];

// Lua: GoldSilverIntro.lua:398
function scene3Jumper(self: GoldSilverIntro): void {
  const step = SCENE3_STEPS[self.counter1];
  if (step === "lapras") {
    initLapras(self);
    self.obp0 = 0xe4; // DmgToCgbObjPals with depixel 28, 28, 4, 4
    animateOceanWaves(self);
  } else if (step === "waves") {
    animateOceanWaves(self);
  } else if (step === "magikarp") {
    initMagikarps(self);
    animateOceanWaves(self);
  } else if (step === "palettes") {
    if (self.counter2 % 0x20 === 0) {
      // Intro_LoadMagikarpPalettes swaps in the school's own colours.
      const palettes = (self.assets && self.assets.palettes) || {};
      self.bgPals[0] = copyPalette(palettes.magikarpBg);
      self.obPals[0] = copyPalette(palettes.magikarpOb);
    } else {
      initMagikarps(self);
    }
  } else if (step === "noLY") {
    self.lyActive = false;
  } else if (step === "ly") {
    updateLYOverrides(self);
  }
}

// Lua: GoldSilverIntro.lua:428 -- IntroScene3_ScrollToSurface. Carry is counter1 reaching zero.
function scrollToSurface(self: GoldSilverIntro): boolean {
  self.counter2 = mod(self.counter2 + 1, 256);
  if (self.counter2 % 4 === 0) self.scx = mod(self.scx - 1, 256);
  if (self.counter2 % 2 !== 0) return false;
  self.anims.globalY = mod(self.anims.globalY + 1, 256);
  const before = self.scy;
  self.scy = mod(self.scy - 1, 256);
  if (before % 16 === 0) {
    const source = actData(self);
    if (source) updateTilemapAndBGMap(self, source);
  }
  return self.counter1 === 0;
}

// Lua: GoldSilverIntro.lua:445 -- IntroScene3: rise towards the surface.
Scenes[3] = (self) => {
  scene3Jumper(self);
  if (!scrollToSurface(self)) return;
  resetLYOverrides(self);
  self.scy = mod(self.scy + 1, 256);
  self.scene = 4;
  return Scenes[4]!(self);
};

// Lua: GoldSilverIntro.lua:455 -- IntroScene4: hold until Lapras has swum off.
Scenes[4] = (self) => {
  if (self.anims.flag === 0) {
    self.counter2 = mod(self.counter2 + 1, 256);
    if (self.counter2 % 16 === 0) self.scx = mod(self.scx - 2, 256);
    animateOceanWaves(self);
    return;
  }
  self.scene = 5;
  self.counter1 = 0;
  return Scenes[5]!(self);
};

// Lua: GoldSilverIntro.lua:470 -- IntroScene5: fade out, one step every 16 frames.
Scenes[5] = (self) => {
  const step = Math.floor(self.counter1 / 16);
  self.counter1 = mod(self.counter1 + 1, 256);
  const palette = WATER_FADE[step];
  if (palette === undefined) {
    self.scene = 6;
    return;
  }
  self.bgp = palette;
  animateOceanWaves(self);
  self.scx = mod(self.scx - 2, 256);
};

// Lua: GoldSilverIntro.lua:484 -- IntroScene6: set up the grass cutscene.
Scenes[6] = (self) => {
  self.scene = 7;
  self.act = "grass";
  self.anims.clear();
  resetLYOverrides(self);
  const source = actData(self);
  if (source) {
    self.tilemapRow = source.firstRow ?? 0;
    self.bgRow = 0;
    drawBackground(self, source, self.tilemapRow);
  }
  self.scy = 0;
  self.anims.globalY = 0;
  self.scx = 0x60;
  self.anims.globalX = 0xa0;
  self.counter2 = 0;

  const palettes = (self.assets && self.assets.palettes) || {};
  self.bgPals[0] = copyPalette(palettes.grassBg);
  self.obPals[0] = copyPalette(palettes.grassOb);
  self.obPals[1] = copyPalette(palettes.grassOb);
  self.bgp = 0xe4;
  self.obp0 = 0xe4;

  // Intro_InitJigglypuff.
  self.anims.init("GS_INTRO_JIGGLYPUFF", 6 * 8, 14 * 8);
  self.anims.flag = 0;
};

// Lua: GoldSilverIntro.lua:514 -- Intro_InitNote: one every 64 frames, alternating
// with the invisible variant.
function initNote(self: GoldSilverIntro): void {
  if (self.anims.flag !== 0) return;
  if (self.counter2 % 0x40 !== 0) return;
  if (self.counter2 % 0x80 !== 0) self.anims.init("GS_INTRO_NOTE", 6 * 8, 11 * 8 + 4);
  else self.anims.init("GS_INTRO_INVISIBLE_NOTE", 6 * 8, 10 * 8 + 4);
}

// Lua: GoldSilverIntro.lua:526 -- IntroScene7: scroll left to Jigglypuff.
Scenes[7] = (self) => {
  initNote(self);
  const before = self.counter2;
  self.counter2 = mod(self.counter2 + 1, 256);
  // `and 3 / ret z`: the camera holds still one frame in four.
  if (before % 4 === 0) return;
  if (self.scx !== 0) {
    self.scx = self.scx - 1;
    self.anims.globalX = mod(self.anims.globalX + 1, 256);
    return;
  }
  self.counter1 = 0xff;
  // Intro_InitPikachu: body and tail are two objects at the same spot.
  self.anims.init("GS_INTRO_PIKACHU", 24 * 8, 14 * 8);
  self.anims.init("GS_INTRO_PIKACHU_TAIL", 24 * 8, 14 * 8);
  self.scene = 8;
};

// Lua: GoldSilverIntro.lua:545 -- IntroScene8: Pikachu runs in and attacks.
Scenes[8] = (self) => {
  if (self.counter1 !== 0) {
    self.counter1 = self.counter1 - 1;
    initNote(self);
    self.counter2 = mod(self.counter2 + 1, 256);
    return;
  }
  self.counter1 = 0;
  self.scene = 9;
};

// Lua: GoldSilverIntro.lua:557 -- IntroScene9: scroll down and fade, every 8 frames.
Scenes[9] = (self) => {
  const step = Math.floor(self.counter1 / 8);
  self.counter1 = mod(self.counter1 + 1, 256);
  const palette = GRASS_FADE[step];
  if (palette === undefined) {
    self.scene = 10;
    return;
  }
  self.bgp = palette;
  self.scy = mod(self.scy + 1, 256);
  self.anims.globalY = mod(self.anims.globalY - 1, 256);
};

// Lua: GoldSilverIntro.lua:572 -- DrawIntroCharizardGraphic.
function drawCharizard(self: GoldSilverIntro, stage: number): void {
  for (let row = 6; row <= 13; row++) {
    for (let col = 0; col <= TILEMAP_W - 1; col++) self.tilemap[row * TILEMAP_W + col] = 0;
  }
  const gfx = CHARIZARD_GFX[stage]!;
  let tile = gfx.tile;
  for (let row = 0; row <= gfx.height - 1; row++) {
    for (let col = 0; col <= gfx.width - 1; col++) {
      self.tilemap[(gfx.y + row) * TILEMAP_W + gfx.x + col] = tile % 256;
      tile = tile + 1;
    }
  }
  for (let row = 0; row <= TILEMAP_H - 1; row++) {
    for (let col = 0; col <= TILEMAP_W - 1; col++) {
      mapSet(self, col, row, self.tilemap[row * TILEMAP_W + col]!);
    }
  }
}

// Lua: GoldSilverIntro.lua:594 -- IntroScene10: set up the fireball cutscene.
Scenes[10] = (self) => {
  self.scene = 11;
  self.act = "fire";
  self.anims.clear();
  resetLYOverrides(self);
  for (let index = 0; index < BG_TILES * BG_TILES; index++) self.bgmap[index] = 0;
  for (let index = 0; index < TILEMAP_W * TILEMAP_H; index++) self.tilemap[index] = 0;
  self.mapDirty = true;
  drawCharizard(self, 0);

  self.scy = 0x80;
  self.scx = 0;
  self.anims.globalY = 0;
  self.anims.globalX = 0;
  self.counter2 = 0;

  const palettes = (self.assets && self.assets.palettes) || {};
  self.bgPals[0] = copyPalette(palettes.fireBg && palettes.fireBg[0]);
  self.obPals[0] = copyPalette(palettes.startersOb);
  self.obPals[1] = copyPalette(palettes.startersOb);
  // %00111111 paints the silhouette flat: every shade takes colour 3.
  self.bgp = 0x3f;
  self.obp0 = 0xff;
  self.playMusic(INTRO_MUSIC_2);
};

// Lua: GoldSilverIntro.lua:619
function monColors(self: GoldSilverIntro, species: string): Colors | undefined {
  return (self.monPalettes && Palettes.monColors(self.monPalettes, species)) || undefined;
}

// Lua: GoldSilverIntro.lua:627 -- Intro_LoadMonPalette (CGB): white, the mon's two
// colours, black, into OBJ palette 0.
function loadMonPalette(self: GoldSilverIntro, species: string): void {
  const colors = monColors(self, species);
  if (!colors) return;
  self.obPals[0] = [WHITE, colors[1] ?? BLACK, colors[2] ?? BLACK, BLACK];
}

// Lua: GoldSilverIntro.lua:633
const SCY_HANDLERS: Record<string, SceneFn> = {
  loadChikorita: (self) => loadMonPalette(self, "CHIKORITA"),
  loadCyndaquil: (self) => loadMonPalette(self, "CYNDAQUIL"),
  loadTotodile: (self) => loadMonPalette(self, "TOTODILE"),
  // Intro_LoadCharizardPalette deliberately uses Cyndaquil's on a CGB.
  loadCharizard: (self) => loadMonPalette(self, "CYNDAQUIL"),
  chikoritaAppears: (self) => {
    self.playSfx(SFX_APPEARS);
    self.anims.init("GS_INTRO_CHIKORITA", 1 * 8, 22 * 8);
  },
  cyndaquilAppears: (self) => {
    self.playSfx(SFX_APPEARS);
    self.anims.init("GS_INTRO_CYNDAQUIL", 20 * 8, 22 * 8);
  },
  totodileAppears: (self) => {
    self.playSfx(SFX_APPEARS);
    self.anims.init("GS_INTRO_TOTODILE", 1 * 8, 22 * 8);
  },
  // Intro_FlashMonPalette shows the starter and blacks the silhouette out;
  // Intro_FlashSilhouette does the reverse.
  flashMonPalette: (self) => {
    self.obp0 = 0xe4;
    self.bgp = 0x00;
  },
  flashSilhouette: (self) => {
    self.obp0 = 0xff;
    self.bgp = 0x3f;
  },
};

// Lua: GoldSilverIntro.lua:664 -- IntroScene11: climb every other frame, firing events.
Scenes[11] = (self) => {
  const before = self.counter2;
  self.counter2 = mod(self.counter2 + 1, 256);
  if (before % 2 === 0) return;
  const handler = SCY_HANDLERS[SCY_EVENTS[self.scy] ?? ""];
  if (handler) handler(self);
  if (self.scy !== 0) {
    self.scy = mod(self.scy + 1, 256);
    return;
  }
  self.scene = 12;
  self.counter1 = 0;
  return Scenes[12]!(self);
};

// Lua: GoldSilverIntro.lua:681 -- IntroScene12: four Charizard palettes, four frames apiece.
Scenes[12] = (self) => {
  const step = Math.floor(self.counter1 / 4) % 4;
  self.counter1 = mod(self.counter1 + 1, 256);
  const palette = CHARIZARD_PALS[step]!;
  if (palette === 0) {
    self.scene = 13;
    self.counter1 = 0x80;
    return;
  }
  self.bgp = palette;
  self.obp0 = palette;
};

// Lua: GoldSilverIntro.lua:695 -- IntroScene13: hold, then open the mouth.
Scenes[13] = (self) => {
  if (self.counter1 !== 0) {
    self.counter1 = self.counter1 - 1;
    return;
  }
  self.scene = 14;
  drawCharizard(self, 1);
  self.counter1 = 4;
};

// Lua: GoldSilverIntro.lua:706 -- IntroScene14: hold four frames, then breathe.
Scenes[14] = (self) => {
  if (self.counter1 !== 0) {
    self.counter1 = self.counter1 - 1;
    return;
  }
  self.scene = 15;
  drawCharizard(self, 2);
  self.counter1 = 64;
  self.counter2 = 0;
  self.playSfx(SFX_FIREBALL);
  return Scenes[15]!(self);
};

// Lua: GoldSilverIntro.lua:721 -- Intro_AnimateFireball: a new fireball every 4 frames.
function animateFireball(self: GoldSilverIntro): void {
  const before = self.counter2;
  self.counter2 = mod(self.counter2 + 1, 256);
  if (before % 4 !== 0) return;
  self.anims.init("GS_INTRO_FIREBALL", 10 * 8 + 4, 12 * 8 + 4);
  self.scx = mod(self.scx - 1, 256);
  self.anims.globalX = mod(self.anims.globalX + 1, 256);
}

// Lua: GoldSilverIntro.lua:731 -- IntroScene15: 64 frames of fireball.
Scenes[15] = (self) => {
  animateFireball(self);
  if (self.counter1 !== 0) {
    self.counter1 = self.counter1 - 1;
    return;
  }
  self.scene = 16;
  self.counter1 = 0;
};

// Lua: GoldSilverIntro.lua:742 -- IntroScene16: fireball on while the palettes fade.
Scenes[16] = (self) => {
  animateFireball(self);
  const step = Math.floor(self.counter1 / 16) % 8;
  self.counter1 = mod(self.counter1 + 1, 256);
  const palette = FIRE_FADE[step];
  if (palette === undefined) {
    self.scene = 17;
    self.hold = 0;
    return;
  }
  self.bgp = palette;
  self.obp0 = palette;
};

// Lua: GoldSilverIntro.lua:759 -- IntroScene17: 64 frames, then the done flag.
Scenes[17] = (self) => {
  self.hold = (self.hold || 0) + 1;
  if (self.hold >= 64) self.done = true;
};

// Lua: GoldSilverIntro.lua:868
function bgPalette(self: GoldSilverIntro): Rgb[] {
  return remap(self.bgPals[0], self.bgp);
}

// Lua: GoldSilverIntro.lua:872
function objPalette(self: GoldSilverIntro, slot: number): Rgb[] {
  return remap(self.obPals[slot] ?? self.obPals[0], self.obp0);
}

export { Scenes };
export default GoldSilverIntro;
