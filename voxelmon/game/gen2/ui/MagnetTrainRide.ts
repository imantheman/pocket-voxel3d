// gen1recomp src/ui/gen2/MagnetTrainRide.lua (bdfac727, MIT): the Magnet
// Train ride, drawn (pokegold engine/events/magnet_train.asm).
//
// core/MagnetTrain.ts is the routine: the jumptable, the three SCX bands and
// the player's frameset. This is the presentation:
//
//   * MagnetTrain_LoadGFX_PlayMusic loads NO background tiles: the train, the
//     bushes and the window come out of TILESET_TRAIN_STATION.
//   * MagnetTrainBGTiles (a 2x18 strip repeated across all 32 columns) and
//     MagnetTrainTilemap (the 20x4 train over rows 6-9) come from
//     data.gen2Field.magnetTrain. Without them the ride runs on a blank screen.
//   * SetMagnetTrainPals: bushes and bottom rows PAL_BG_GREEN, the train
//     PAL_BG_GRAY, the six window tiles PAL_BG_YELLOW, out of a TOWN palette
//     set at the current time of day.
//
// Brian bakes the 32x18 background into a 256x144 canvas and blits three SCX
// bands, then re-blits an overlay (shade 0 transparent, via a shader) over the
// player to emulate OAM_PRIO. The Gold screen IS the hardware he emulates, so
// here it is the cart's own way: the background goes into the 32-wide BG map
// once a frame (G.map = 0), the bands become per-line SCX (lcd.lines), and the
// priority is the BG-over-OBJ attribute bit (GbcPalette.useKeyed), which the
// screen resolves exactly like OAM_PRIO: colour 0 lets the objects through.

import G, { currentLcd } from "../platform/screen.ts";
import type { LcdImage, Quad } from "../platform/screen.ts";
import { Assets } from "../shared/render/Assets.ts";
import { GbcPalette } from "../shared/render/GbcPalette.ts";
import { Music } from "../shared/core/Music.ts";
import { Sound } from "../shared/core/Sound.ts";
import { FieldMoves } from "../world/FieldMoves.ts";
import { Palettes } from "../world/Palettes.ts";
import { MagnetTrain } from "../core/MagnetTrain.ts";
import { Chrome } from "./Chrome.ts";

export interface MagnetTrainRideOpts {
  toGoldenrod?: any;
  save?: any;
  onDone?: () => void;
}

// Lua: MagnetTrainRide.lua:47
const SCREEN_W = 160, SCREEN_H = 144;
const BG_W = 256; // TILEMAP_WIDTH * 8
const TILES_PER_ROW = 16; // every 2bpp sheet the importer writes
const BLACK = [0, 0, 0];

interface Sheet {
  image: LcdImage;
  quads: Record<number, Quad>;
  width: number;
  height: number;
}

/** Lua: MagnetTrainRide.lua:132 */
function sheetFor(path: string | undefined): Sheet | undefined {
  if (!path) return undefined;
  let image: LcdImage | undefined;
  try {
    image = Assets.image(path);
  } catch {
    return undefined;
  }
  if (!image) return undefined;
  image.setFilter("nearest", "nearest");
  const [width, height] = image.getDimensions();
  const quads: Record<number, Quad> = {};
  for (let tile = 0; tile <= Math.floor(width / 8) * Math.floor(height / 8) - 1; tile++) {
    quads[tile] = G.newQuad((tile % TILES_PER_ROW) * 8, Math.floor(tile / TILES_PER_ROW) * 8, 8, 8, width, height);
  }
  return { image, quads, width, height };
}

export class MagnetTrainRide {
  // Lua: MagnetTrainRide.lua:45
  static isOpaque = true;
  isOpaque = true;

  game: any;
  data: any;
  onDone?: () => void;
  finished: boolean;
  gender: any;
  ride: MagnetTrain;
  tileset: any;
  palettes: any;
  spriteSheet: { image: LcdImage } | undefined;
  sheet?: Sheet | false;
  playerQuads?: Record<number, Quad>;
  [key: string]: any;

  /** Lua: MagnetTrainRide.lua:76 */
  wantsFillScale(): boolean {
    return true;
  }

  /** Lua: MagnetTrainRide.lua:79 -- opts: toGoldenrod (the officer's wScriptVar), onDone() */
  static new(game: any, opts?: MagnetTrainRideOpts): MagnetTrainRide {
    return new MagnetTrainRide(game, opts ?? {});
  }

  constructor(game: any, opts: MagnetTrainRideOpts) {
    this.game = game;
    this.data = game && game.data;
    this.onDone = opts.onDone;
    this.finished = false;
    const save = opts.save || (game && game.save);
    this.gender = (save && save.player && save.player.gender) || undefined;

    const field = this.data && this.data.gen2Field;
    const gfx = field && field.magnetTrain;
    this.ride = MagnetTrain.new({
      toGoldenrod: opts.toGoldenrod,
      bgTiles: gfx && gfx.bgTiles,
      fgTilemap: gfx && gfx.tilemap,
    });

    this.tileset = this.data && this.data.gen2Tilesets && this.data.gen2Tilesets.TILESET_TRAIN_STATION;
    this.palettes = this.bgPalettes();
    this.spriteSheet = this.playerSheet();

    // PlayMusic2 MUSIC_MAGNET_TRAIN, the last thing the GFX load does.
    const songs = this.data && this.data.audio && this.data.audio.songs;
    if (songs && songs.Music_MagnetTrain) {
      Music.stop();
      Music.play(this.data, "Music_MagnetTrain", true, { reason: "magnettrain" } as any);
    }
  }

  /**
   * Lua: MagnetTrainRide.lua:114 -- GetSGBLayout with wEnvironment forced to
   * TOWN and wTimeOfDayPal from the real clock.
   */
  bgPalettes(): any {
    const data = this.data;
    const palettes = data && data.gen2Palettes;
    if (!palettes) return undefined;
    return Palettes.bgSet(palettes, { environment: "TOWN" }, Palettes.clockDaytime());
  }

  /** Lua: MagnetTrainRide.lua:122 -- `slot` is 1-based; the set is a 0-based array. */
  palette(slot: number): any {
    const set = this.palettes;
    return set && (set[slot - 1] || set[0]);
  }

  // ---------------------------------------------------------------- sheets

  /** Lua: MagnetTrainRide.lua:149 */
  tileSheet(): Sheet | undefined {
    if (this.sheet === undefined) this.sheet = sheetFor(this.tileset && this.tileset.image) || false;
    return this.sheet || undefined;
  }

  /**
   * Lua: MagnetTrainRide.lua:160 -- the player's overworld sheet: six 16x16
   * frames stacked vertically.
   */
  playerSheet(): { image: LcdImage } | undefined {
    const def = this.playerSpriteDef();
    const path = def && def.image;
    if (!path) return undefined;
    let image: LcdImage | undefined;
    try {
      image = Assets.image(path);
    } catch {
      return undefined;
    }
    if (!image) return undefined;
    image.setFilter("nearest", "nearest");
    return { image };
  }

  /**
   * Lua: MagnetTrainRide.lua:173 -- the quad for one vtile of the two loaded
   * blocks; a 2x2 frame is TL, TR, BL, BR (.OAMData_MagnetTrainRed's order).
   */
  playerQuad(vtile: number): Quad | undefined {
    const sheet = this.spriteSheet;
    if (!sheet) return undefined;
    const frame = MagnetTrain.SHEET_FRAME[vtile - (vtile % 4)];
    if (frame == null) return undefined;
    this.playerQuads = this.playerQuads || {};
    let quad = this.playerQuads[vtile];
    if (!quad) {
      const sub = vtile % 4;
      const [w, h] = sheet.image.getDimensions();
      quad = G.newQuad((sub % 2) * 8, frame * 16 + Math.floor(sub / 2) * 8, 8, 8, w, h);
      this.playerQuads[vtile] = quad;
    }
    return quad;
  }

  // Lua: MagnetTrainRide.lua:190-220 -- overlayShader / useOverlayShader are
  // not needed: the BG-over-OBJ attribute does the OAM_PRIO masking.

  // ------------------------------------------------------- the background

  /**
   * Lua: MagnetTrainRide.lua:230 -- DrawMagnetTrain plus SetMagnetTrainPals.
   * Brian renders this once into canvases; here the 32x18 cells go straight
   * into the BG map each frame (the Gold screen is immediate mode), drawn
   * keyed so colours 1-3 sit over the player's objects.
   */
  drawBackground(): boolean {
    const rows = this.ride.tilemap();
    const sheet = this.tileSheet();
    if (!(rows && sheet)) return false;

    // Lua: MagnetTrainRide.lua:251 -- the cells grouped by palette slot.
    const groups = new Map<number, [number, number, number][]>();
    for (let row = 0; row < rows.length; row++) {
      for (let col = 0; col < rows[row]!.length; col++) {
        const slot = MagnetTrain.paletteSlot(col, row);
        let list = groups.get(slot);
        if (!list) {
          list = [];
          groups.set(slot, list);
        }
        list.push([rows[row]![col], col * 8, row * 8]);
      }
    }

    G.push("all");
    G.origin();
    G.setScissor();
    G.map = 0;
    G.setColor(1, 1, 1, 1);
    const shader = GbcPalette.available();
    for (const [slot, list] of groups) {
      const colors = this.palette(slot);
      if (shader && colors) GbcPalette.useKeyed(colors);
      for (const cell of list) {
        const quad = sheet.quads[cell[0]];
        if (quad) G.draw(sheet.image, quad, cell[1], cell[2]);
      }
    }
    if (shader) GbcPalette.clear();
    G.pop();
    return true;
  }

  // ----------------------------------------------------------------- frame

  /** Lua: MagnetTrainRide.lua:316 */
  playSfx(name: string): void {
    const audio = this.data && this.data.audio;
    const sfx = audio && audio.sfx;
    if (sfx && sfx[Sound.resolve(this.data, name)]) Sound.play(this.data, name);
  }

  /** Lua: MagnetTrainRide.lua:324 */
  finish(): void {
    if (this.finished) return;
    this.finished = true;
    if (this.onDone) this.onDone();
  }

  /** Lua: MagnetTrainRide.lua:330 */
  update(_dt?: number): void {
    if (this.finished) return;
    const sfx = this.ride.update();
    if (sfx) this.playSfx(sfx);
    if (this.ride.done()) {
      // MagnetTrain's .done returns to the script, which then runs
      // `warpcheck` and `newloadmap MAPSETUP_TRAIN`.
      this.finish();
    }
  }

  /**
   * Lua: MagnetTrainRide.lua:342 -- the three LY override bands. Brian blits
   * each band of the baked canvas wrapped at 256px; here they are the
   * per-line SCX the cart writes to wLYOverrides, and the BG map wraps.
   */
  drawBands(): void {
    const lcd = currentLcd();
    if (!lcd) return;
    const bands = this.ride.bands();
    if (bands.length === 0) return;
    const lines = new Array<number>(SCREEN_H).fill(0);
    for (const band of bands) {
      const top = band[0];
      const bottom = band[1];
      const scx = ((band[2] % BG_W) + BG_W) % BG_W;
      for (let ly = Math.max(0, top); ly <= Math.min(SCREEN_H - 1, bottom); ly++) lines[ly] = scx;
    }
    lcd.lines(2, lines);
  }

  /**
   * Lua: MagnetTrainRide.lua:365 -- GetPlayerIcon's sheet, which
   * .InitPlayerSpriteAnim pairs with SPRITE_ANIM_OBJ_MAGNET_TRAIN_RED/_BLUE.
   */
  playerSpriteDef(): any {
    const sprites = this.data && this.data.gen2Sprites;
    if (!sprites) return undefined;
    return sprites[FieldMoves.playerSprite(this.gender)] || sprites.SPRITE_CHRIS || sprites.SPRITE_KRIS;
  }

  /** Lua: MagnetTrainRide.lua:374 -- PAL_OW_RED (or PAL_OW_BLUE for Kris). */
  playerPalette(): any {
    const palettes = this.data && this.data.gen2Palettes;
    if (!palettes) return undefined;
    return Palettes.spritePalette(palettes, Palettes.clockDaytime(), this.playerSpriteDef());
  }

  /** Lua: MagnetTrainRide.lua:381 */
  drawPlayer(): void {
    const sheet = this.spriteSheet;
    if (!sheet) return;
    const oam = this.ride.playerOam();
    if (oam.length === 0) return;
    const shader = GbcPalette.available();
    const colors = shader && this.playerPalette();
    if (colors) GbcPalette.use(colors);
    G.setColor(1, 1, 1, 1);
    for (const entry of oam) {
      if (entry.x >= -8 && entry.x < SCREEN_W && entry.y >= -16 && entry.y < SCREEN_H) {
        const quad = this.playerQuad(entry.tile);
        if (quad) G.draw(sheet.image, quad, entry.x + (entry.xflip ? 8 : 0), entry.y, 0, entry.xflip ? -1 : 1, 1);
      }
    }
    if (colors) GbcPalette.clear();
  }

  /**
   * Lua: MagnetTrainRide.lua:407 -- BG colour 0 of the gray palette the train
   * body uses: what shows wherever nothing was drawn.
   */
  backdrop(): readonly number[] {
    return GbcPalette.color(this.palette(MagnetTrain.PAL_BG_GRAY), 1) || BLACK;
  }

  /** Lua: MagnetTrainRide.lua:411 */
  drawPanel(): void {
    const backdrop = this.backdrop();
    G.setColor(backdrop[0]! / 255, backdrop[1]! / 255, backdrop[2]! / 255, 1);
    G.rectangle("fill", 0, 0, SCREEN_W, SCREEN_H);
    G.setColor(1, 1, 1, 1);

    // 1. the background (bushes, train body, window aperture) into the BG
    //    map, keyed, and the per-line SCX bands
    if (this.drawBackground()) this.drawBands();
    // 2. the player's objects, behind the train's colours 1-3 and visible
    //    through the window's colour 0 (OAM_PRIO)
    this.drawPlayer();

    G.setColor(1, 1, 1, 1);
  }

  /** Lua: MagnetTrainRide.lua:429 */
  draw(): void {
    Chrome.withClip(() => this.drawPanel());
  }

  /**
   * Lua: MagnetTrainRide.lua:438 -- MagnetTrain_LoadGFX_PlayMusic opens on
   * ClearBGPalettes / ClearSprites; the surround is the gray backdrop.
   */
  drawsWidescreen(): boolean {
    return true;
  }

  /** Lua: MagnetTrainRide.lua:440 */
  drawWidescreen(winW: number, winH: number): void {
    const backdrop = this.backdrop();
    Chrome.letterbox(winW, winH, backdrop[0]! / 255, backdrop[1]! / 255, backdrop[2]! / 255);
    G.setColor(1, 1, 1, 1);
    const scale = Chrome.fitScale();
    const [ox, oy] = Chrome.fitOrigin();
    G.push("all");
    Chrome.clipTo(ox, oy, SCREEN_W * scale, SCREEN_H * scale);
    G.translate(ox, oy);
    G.scale(scale, scale);
    this.drawPanel();
    G.pop();
  }
}

export default MagnetTrainRide;
