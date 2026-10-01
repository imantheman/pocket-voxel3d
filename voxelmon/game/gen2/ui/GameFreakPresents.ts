// gen1recomp src/ui/gen2/GameFreakPresents.lua (bdfac727): the GAME FREAK
// splash (pokegold engine/movie/splash.asm).
//
// The six-scene jumptable GameFreakPresentsScene walks: a star spirals in,
// the logo is placed where the star died, sparkles fly off it for 128 frames
// while "GAME FREAK" appears halfway through, then "presents", then a last
// 128-frame hold. Any button skips the whole thing.
//
//   scene 0  Star            spawn the star, play SFX_GAME_FREAK_LOGO_GS
//   scene 1  PlaceLogo       wait for the star to die, then place the logo
//   scene 2  LogoSparkles    128 frames of sparkles; "GAME FREAK" at 63
//   scene 3  PlacePresents   "presents", reset the timer
//   scene 4  WaitForTimer    128 frames
//   scene 5  SetDoneFlag     finished
//
// GameFreakPresentsInit points wSpriteAnimDict at $8d, so every OAM set's
// vtile offset is relative to the logo. OBP0 stays %11111000 (star and
// sparkles yellow) while OBP1 rotates from %00100100 to %10010000, so the
// logo is white for its first 48 frames and yellow after.
//
// Here the OAM entries become Gold screen objects (G.objects), and the
// letters BG cells, each through the palette the Lua picks.

import G from "../platform/screen.ts";
import { Music } from "../shared/core/Music.ts";
import { Sound } from "../shared/core/Sound.ts";
import { Runtime } from "../shared/mods/Runtime.ts";
import { GbcPalette } from "../shared/render/GbcPalette.ts";
import { SpriteAnims, type SpriteAnimSystem } from "./SpriteAnims.ts";
import { TileSheet } from "./TileSheet.ts";

type Rgb = readonly number[];
type Colors = readonly Rgb[];

// Lua: GameFreakPresents.lua:43
const SCREEN_W = 160;
const SCREEN_H = 144;

// Lua: GameFreakPresents.lua:46 -- wSpriteAnimDict[SPRITE_ANIM_DICT_GS_SPLASH] = $8d.
const DICT_VTILE = 0x8d;

// Lua: GameFreakPresents.lua:50 -- `depixel 10, 11, 4, 0` / `depixel 11, 11` (y-first).
const LOGO_X = 11 * 8 + 0;
const LOGO_Y = 10 * 8 + 4;
const SPARKLE_X = 11 * 8;
const SPARKLE_Y = 11 * 8;

// Lua: GameFreakPresents.lua:56 -- $8d is the logo's first tile borrowed as a blank.
const GAME_FREAK = [0x80, 0x81, 0x82, 0x83, 0x8d, 0x84, 0x85, 0x83, 0x81, 0x86];
const GAME_FREAK_X = 5;
const GAME_FREAK_Y = 12;
const PRESENTS = [0x87, 0x88, 0x89, 0x8a, 0x8b, 0x8c];
const PRESENTS_X = 7;
const PRESENTS_Y = 13;

// Lua: GameFreakPresents.lua:62 -- GameFreakPresents_Sparkle .sparkle_vectors: angle, distance.
const SPARKLE_VECTORS: [number, number][] = [
  [0x00, 0x03], [0x08, 0x04], [0x04, 0x03], [0x0c, 0x02],
  [0x10, 0x02], [0x18, 0x03], [0x14, 0x04], [0x1c, 0x03],
  [0x20, 0x02], [0x28, 0x02], [0x24, 0x03], [0x2c, 0x04],
  [0x30, 0x04], [0x38, 0x03], [0x34, 0x02], [0x3c, 0x04],
];

// Lua: GameFreakPresents.lua:69
const SCENE_TIMER = 128;
// The `ld c, 16 / call DelayFrames` every exit path runs before returning.
const EXIT_FRAMES = 16;

// Lua: GameFreakPresents.lua:75 -- DMG palette bytes (colour 0 in the low bits).
const OBP0 = 0xf8; // %11111000, the star and the sparkles
const OBP1_START = 0x24; // %00100100, the logo before the rotation runs
const OBP1_FINAL = 0x90; // %10010000, where UpdateLogoPal stops

// Lua: GameFreakPresents.lua:79
const BLACK: Rgb = [0, 0, 0];
const WHITE: Rgb = [255, 255, 255];
const YELLOW: Rgb = [206, 247, 0]; // RGB 25,30,00 out of gfx/sgb/predef.pal

const DEFAULT_OB: Colors = [WHITE, WHITE, YELLOW, YELLOW];
const DEFAULT_BG: Colors = [BLACK, [66, 90, 90], [173, 173, 173], WHITE];

// Lua: GameFreakPresents.lua:86
function permute(colors: Colors, byte: number): Rgb[] {
  const out: Rgb[] = [];
  for (let index = 0; index <= 3; index++) {
    out[index] = colors[(byte >> (index * 2)) & 3] ?? BLACK;
  }
  return out;
}

export interface GameFreakPresentsOpts {
  oakSpeech?: any;
  title?: any;
  onDone?: (skipped: boolean) => void;
}

type SceneFn = (self: GameFreakPresents) => void;

export class GameFreakPresents {
  static isOpaque = true;
  static SPARKLE_VECTORS = SPARKLE_VECTORS;
  static permute = permute;

  isOpaque = true;
  game: any;
  onDone: ((skipped: boolean) => void) | undefined;
  obColors: Colors;
  bgColors: Colors;
  sheets: TileSheet[];
  anims: SpriteAnimSystem;
  scene = 0;
  timer = 0;
  obp1 = OBP1_START;
  /** The BG tilemap, sparse: tiles[ty][tx] = tile id. */
  tiles: Record<number, Record<number, number>> = {};
  frames = 0;
  // exitTail, not `exit`: enter/exit are the StateStack's own callback names.
  exitTail: number | null = null;
  done = false;
  sfxPlayed = false;
  skipped: boolean | undefined;
  logoAlive = false;

  // Lua: GameFreakPresents.lua:99 -- opts: oakSpeech (for its `splash` table), onDone
  constructor(game: any, opts: GameFreakPresentsOpts = {}) {
    this.game = game;
    this.onDone = opts.onDone;
    const splash = (opts.oakSpeech ?? {}).splash ?? {};
    this.obColors = splash.obPalette ?? DEFAULT_OB;
    this.bgColors = splash.bgPalette ?? DEFAULT_BG;

    // One sheet per INCBIN, each addressed by the VRAM id its tiles were loaded at.
    this.sheets = [
      TileSheet.new({ path: splash.presents ?? "assets/generated/splash/presents.png", wide: 13, firstTile: 0x80 }),
      TileSheet.new({ path: splash.logo ?? "assets/generated/splash/logo.png", wide: 3, firstTile: 0x8d }),
      TileSheet.new({ path: splash.star ?? "assets/generated/splash/star.png", wide: 1, firstTile: 0x9c }),
      TileSheet.new({ path: splash.sparkle ?? "assets/generated/splash/sparkle.png", wide: 3, firstTile: 0x9e }),
    ];

    this.anims = SpriteAnims.new();
    this.anims.vtileBase = DICT_VTILE;
  }

  static new(game: any, opts?: GameFreakPresentsOpts): GameFreakPresents {
    return new GameFreakPresents(game, opts ?? {});
  }

  // Lua: GameFreakPresents.lua:94
  wantsFillScale(): boolean {
    return true;
  }

  // Lua: GameFreakPresents.lua:95
  drawsWidescreen(): boolean {
    return true;
  }

  // Lua: GameFreakPresents.lua:137 -- intro.boot.gamefreak
  enter(): void {
    const data = this.game && this.game.data;
    if (data && data.audio && data.audio.runtime) Music.stop();
    if (Runtime.wants("intro.boot.gamefreak")) {
      Runtime.emit("intro.boot.gamefreak", { screen: this, game: this.game });
    }
  }

  // Lua: GameFreakPresents.lua:152
  finish(): void {
    if (this.done) return;
    this.done = true;
    if (this.onDone) this.onDone(this.skipped === true);
  }

  // Lua: GameFreakPresents.lua:159 -- PlaceString into the sparse tilemap.
  placeString(tiles: readonly number[], tx: number, ty: number): void {
    let row = this.tiles[ty];
    if (!row) {
      row = {};
      this.tiles[ty] = row;
    }
    tiles.forEach((tile, i) => {
      row![tx + i] = tile;
    });
  }

  // ---------------------------------------------------- GameFreakPresentsScene

  // Lua: GameFreakPresents.lua:174
  sceneStar(): void {
    this.anims.flag = 0; // wIntroSceneFrameCounter
    const st = this.anims.init("GS_GAMEFREAK_LOGO_STAR", LOGO_X, LOGO_Y);
    if (st) st.var1 = 0x80;
    const data = this.game && this.game.data;
    if (data && data.audio && data.audio.sfx && data.audio.sfx.Sfx_GameFreakLogoGs) {
      Sound.play(data, "Sfx_GameFreakLogoGs");
    }
    this.scene = this.scene + 1;
  }

  // Lua: GameFreakPresents.lua:186
  scenePlaceLogo(): void {
    // The star's own sequence sets the flag when it reaches the middle.
    if (this.anims.flag === 0) return;
    this.anims.init("GAMEFREAK_LOGO", LOGO_X, LOGO_Y);
    // UpdateLogoPal runs out of the LOGO's own AnimSeq: its clock only runs once the logo exists.
    this.logoAlive = true;
    this.scene = this.scene + 1;
    this.timer = SCENE_TIMER;
  }

  // Lua: GameFreakPresents.lua:201 -- GameFreakPresents_Sparkle: one every second frame.
  sparkle(counter: number): void {
    if (counter % 2 !== 0) return;
    const st = this.anims.init("GS_GAMEFREAK_LOGO_SPARKLE", SPARKLE_X, SPARKLE_Y);
    if (!st) return; // all ten structs busy, as on hardware
    const vector = SPARKLE_VECTORS[Math.floor(counter / 2) % 16]!;
    st.jt = vector[0];
    st.var1 = 0;
    st.var2 = vector[1];
  }

  // Lua: GameFreakPresents.lua:212
  sceneLogoSparkles(): void {
    const counter = this.timer;
    if (counter === 0) {
      this.timer = SCENE_TIMER;
      this.scene = this.scene + 1;
      return;
    }
    this.timer = this.timer - 1;
    if (counter === 63) this.placeString(GAME_FREAK, GAME_FREAK_X, GAME_FREAK_Y);
    this.sparkle(counter);
  }

  // Lua: GameFreakPresents.lua:226
  scenePlacePresents(): void {
    this.placeString(PRESENTS, PRESENTS_X, PRESENTS_Y);
    this.scene = this.scene + 1;
    this.timer = SCENE_TIMER;
  }

  // Lua: GameFreakPresents.lua:232
  sceneWaitForTimer(): void {
    if (this.timer === 0) {
      this.scene = this.scene + 1;
      return;
    }
    this.timer = this.timer - 1;
  }

  // Lua: GameFreakPresents.lua:252 -- ClearSpriteAnims, ClearTilemap, ClearSprites, then 16 frames.
  beginExit(): void {
    if (this.exitTail != null) return;
    this.anims.clear();
    this.tiles = {};
    this.logoAlive = false;
    this.exitTail = 0;
  }

  // Lua: GameFreakPresents.lua:263 -- GameFreakPresents_UpdateLogoPal: rotate OBP1
  // right one colour slot every 16 frames until it reaches its final state.
  updateLogoPal(): void {
    if (!this.logoAlive) return;
    if (this.obp1 === OBP1_FINAL) return;
    if (this.timer % 16 !== 0) return;
    const low = this.obp1 % 4;
    this.obp1 = Math.floor(this.obp1 / 4) + low * 64;
  }

  // Lua: GameFreakPresents.lua:271
  update(_dt?: number): void {
    this.frames = this.frames + 1;
    // The 16-frame tail after the sequence finishes or is skipped.
    if (this.exitTail != null) {
      this.exitTail = this.exitTail + 1;
      if (this.exitTail > EXIT_FRAMES) this.finish();
      return;
    }
    const input = this.game && this.game.input;
    if (input && (input.wasPressed("a") || input.wasPressed("b") || input.wasPressed("start") || input.wasPressed("select"))) {
      // .pressed_button: everything is torn down and the splash is over.
      this.skipped = true;
      this.beginExit();
      return;
    }
    this.anims.playFrame();
    this.updateLogoPal();
    const scene = SCENES[this.scene];
    if (scene) scene(this);
  }

  // ------------------------------------------------------------------ Drawing

  // Lua: GameFreakPresents.lua:297
  sheetFor(tile: number): TileSheet | null {
    for (const sheet of this.sheets) {
      if (tile >= sheet.firstTile && sheet.available()) {
        const index = tile - sheet.firstTile;
        const image = sheet.image()!;
        const [, height] = image.getDimensions();
        if (index < sheet.wide * (height / 8)) return sheet;
      }
    }
    return null;
  }

  // Lua: GameFreakPresents.lua:309
  drawTile(tile: number, tx: number, ty: number, colors: Colors): void {
    const sheet = this.sheetFor(tile);
    if (!sheet) return;
    sheet.palette = colors;
    sheet.draw(tile, tx, ty);
  }

  // Lua: GameFreakPresents.lua:319 -- one pass over wShadowOAM; OBJ palette 1 is the
  // logo on the rotating OBP1, everything else the fixed OBP0.
  drawObjects(): void {
    const logoPal = permute(this.obColors, this.obp1);
    const objPal = permute(this.obColors, OBP0);
    const oam = this.anims.oam;
    G.push();
    // OAM is objects whether or not an entry lands on the 8px grid.
    G.objects = true;
    // The Lua walks wShadowOAM backwards so entry 1 paints last (on top); the
    // Gold screen puts earlier objects on top, so walk it forwards.
    for (const entry of oam) {
      const isLogo = entry.attr % 8 === 1;
      const sheet = this.sheetFor(entry.tile);
      const quad = sheet && sheet.quad(entry.tile - sheet.firstTile);
      if (sheet && quad) {
        const flipX = Math.floor(entry.attr / SpriteAnims.OAM_XFLIP) % 2 === 1;
        const flipY = Math.floor(entry.attr / SpriteAnims.OAM_YFLIP) % 2 === 1;
        const colors = isLogo ? logoPal : objPal;
        const body = (): void => {
          G.setColor(1, 1, 1, 1);
          G.draw(sheet.image()!, quad, entry.x - 8 + (flipX ? 8 : 0), entry.y - 16 + (flipY ? 8 : 0), 0, flipX ? -1 : 1, flipY ? -1 : 1);
        };
        if (GbcPalette.available()) GbcPalette.with(colors, body);
        else body();
      }
    }
    G.pop();
  }

  // Lua: GameFreakPresents.lua:349
  drawPanel(): void {
    // BG colour 0 is the backdrop the cleared tilemap shows.
    const backdrop = GbcPalette.color(this.bgColors, 1) ?? BLACK;
    G.setColor(backdrop[0]! / 255, backdrop[1]! / 255, backdrop[2]! / 255, 1);
    G.rectangle("fill", 0, 0, SCREEN_W, SCREEN_H);
    G.setColor(1, 1, 1, 1);
    for (const ty of Object.keys(this.tiles)) {
      const row = this.tiles[Number(ty)]!;
      for (const tx of Object.keys(row)) {
        this.drawTile(row[Number(tx)]!, Number(tx), Number(ty), this.bgColors);
      }
    }
    this.drawObjects();
    G.setColor(1, 1, 1, 1);
  }

  // Lua: GameFreakPresents.lua:365
  draw(): void {
    this.drawPanel();
  }

  // Lua: GameFreakPresents.lua:369 -- the Gold screen is the panel: no letterbox or fit.
  drawWidescreen(_winW: number, _winH: number): void {
    this.drawPanel();
  }
}

// Lua: GameFreakPresents.lua:240
const SCENES: SceneFn[] = [
  (self) => self.sceneStar(),
  (self) => self.scenePlaceLogo(),
  (self) => self.sceneLogoSparkles(),
  (self) => self.scenePlacePresents(),
  (self) => self.sceneWaitForTimer(),
  // GameFreakPresents_SetDoneFlag.
  (self) => self.beginExit(),
];

export default GameFreakPresents;
