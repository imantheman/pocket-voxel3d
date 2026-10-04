// gen1recomp src/ui/gen2/CrystalSplash.lua (bdfac727, MIT): the Crystal GAME
// FREAK splash (pokecrystal engine/movie/splash.asm:1-342). Ditto bounces in,
// rests, transforms into the logo, then GAME FREAK / presents.
//
// As in GameFreakPresents.ts, the OAM entries become Gold screen objects
// (G.objects) and the letters BG cells through the palette the Lua picks.

import G from "../platform/screen.ts";
import { Music } from "../shared/core/Music.ts";
import { Sound } from "../shared/core/Sound.ts";
import { Runtime } from "../shared/mods/Runtime.ts";
import { GbcPalette } from "../shared/render/GbcPalette.ts";
import { SpriteAnims, type AnimStruct, type Frame, type OamEntry, type SpriteAnimSystem } from "./SpriteAnims.ts";
import { TileSheet } from "./TileSheet.ts";

type Rgb = readonly number[];
type Colors = readonly Rgb[];

// Lua: CrystalSplash.lua:16
const SCREEN_W = 160;
const SCREEN_H = 144;

// Lua: CrystalSplash.lua:18 -- splash.asm:91 `depixel 10, 11, 4, 0` is y-first.
const LOGO_X = 11 * 8 + 0;
const LOGO_Y = 10 * 8 + 4;
// pokecrystal constants/gfx_constants.asm:36 OAM_YCOORD_HIDDEN.
const YCOORD_HIDDEN = 160;

// Lua: CrystalSplash.lua:25 -- splash.asm:161-164, :183-186; $0d is the logo's
// own first tile borrowed as the space.
const GAME_FREAK = [0x00, 0x01, 0x02, 0x03, 0x0d, 0x04, 0x05, 0x03, 0x01, 0x06];
const GAME_FREAK_X = 5;
const GAME_FREAK_Y = 10;
const PRESENTS = [0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c];
const PRESENTS_X = 7;
const PRESENTS_Y = 11;

// splash.asm:121-122 `ld c, 16 / call DelayFrames`.
const EXIT_FRAMES = 16;

const BLACK: Rgb = [0, 0, 0];
const WHITE: Rgb = [255, 255, 255];
// gfx/splash/ditto.pal, OBJ pals 0 and 1 (engine/gfx/cgb_layouts.asm:876-893).
const DITTO_OB: Colors = [WHITE, [107, 90, 0], [189, 99, 230], BLACK];
// gfx/sgb/predef.pal:79 PREDEFPAL_GAMEFREAK_LOGO_BG.
const DEFAULT_BG: Colors = [BLACK, [66, 90, 90], [173, 173, 173], WHITE];

// ---------------------------------------------------------- sprite-anim data

// Lua: CrystalSplash.lua:46 -- dbsprite: y byte first.
function s(xTile: number, yTile: number, xPixel: number, yPixel: number, tile: number, attr: number): OamEntry {
  return { y: (((yTile * 8 + yPixel) % 256) + 256) % 256, x: (((xTile * 8 + xPixel) % 256) + 256) % 256, tile, attr };
}

// oam.asm:1098-1108 .OAMData_GameFreakLogo1_3
const DITTO_SMALL: OamEntry[] = [];
for (let row = 0; row <= 2; row++) for (let col = 0; col <= 2; col++) DITTO_SMALL.push(s(col - 2, row - 2, 4, 0, row * 0x10 + col, 1));

// oam.asm:1110-1135 .OAMData_GameFreakLogo4_11
const DITTO_MORPH: OamEntry[] = [];
for (let row = 0; row <= 5; row++) for (let col = 0; col <= 3; col++) DITTO_MORPH.push(s(col - 2, row - 5, 4, 0, row * 0x10 + col, 1));

// oam.asm:139-149 -- vtile bases into the 256-tile Ditto sheet
const OAMSETS: Record<string, [number, OamEntry[]]> = {
  CRYSTAL_GAMEFREAK_LOGO_1: [0xd0, DITTO_SMALL],
  CRYSTAL_GAMEFREAK_LOGO_2: [0xd3, DITTO_SMALL],
  CRYSTAL_GAMEFREAK_LOGO_3: [0xd6, DITTO_SMALL],
  CRYSTAL_GAMEFREAK_LOGO_4: [0x6c, DITTO_MORPH],
  CRYSTAL_GAMEFREAK_LOGO_5: [0x68, DITTO_MORPH],
  CRYSTAL_GAMEFREAK_LOGO_6: [0x64, DITTO_MORPH],
  CRYSTAL_GAMEFREAK_LOGO_7: [0x60, DITTO_MORPH],
  CRYSTAL_GAMEFREAK_LOGO_8: [0x0c, DITTO_MORPH],
  CRYSTAL_GAMEFREAK_LOGO_9: [0x08, DITTO_MORPH],
  CRYSTAL_GAMEFREAK_LOGO_10: [0x04, DITTO_MORPH],
  CRYSTAL_GAMEFREAK_LOGO_11: [0x00, DITTO_MORPH],
};

const f = (oamset: string, duration: number, flags = 0): Frame => ({ oamset, duration, flags });

// framesets.asm:142-158 .Frameset_GameFreakLogo
const FRAMESETS: Record<string, Frame[]> = {
  CrystalGameFreakLogo: [
    f("CRYSTAL_GAMEFREAK_LOGO_1", 12), f("CRYSTAL_GAMEFREAK_LOGO_2", 1),
    f("CRYSTAL_GAMEFREAK_LOGO_3", 1), f("CRYSTAL_GAMEFREAK_LOGO_2", 4),
    f("CRYSTAL_GAMEFREAK_LOGO_1", 12), f("CRYSTAL_GAMEFREAK_LOGO_2", 12),
    f("CRYSTAL_GAMEFREAK_LOGO_3", 4), f("CRYSTAL_GAMEFREAK_LOGO_4", 32),
    f("CRYSTAL_GAMEFREAK_LOGO_5", 3), f("CRYSTAL_GAMEFREAK_LOGO_6", 3),
    f("CRYSTAL_GAMEFREAK_LOGO_7", 4), f("CRYSTAL_GAMEFREAK_LOGO_8", 4),
    f("CRYSTAL_GAMEFREAK_LOGO_9", 4), f("CRYSTAL_GAMEFREAK_LOGO_10", 10),
    f("CRYSTAL_GAMEFREAK_LOGO_11", 7),
    "end",
  ],
};

// Lua: CrystalSplash.lua:113 -- GameFreakLogoSpriteAnim (splash.asm:201-342):
// VAR1 jump height, VAR2 sine offset / frame counter; sys.flag carries the
// transform's NextScene call.
const SEQUENCES: Record<string, (sys: SpriteAnimSystem, st: AnimStruct) => void> = {
  CrystalGameFreakLogo(sys, st) {
    const splash = (sys as SpriteAnimSystem & { splash?: CrystalSplash }).splash;
    if (st.jt === 0) {
      // GameFreakLogo_Init (splash.asm:221-225)
      st.jt = 1;
    } else if (st.jt === 1) {
      // GameFreakLogo_Bounce (splash.asm:227-283)
      if (st.var1 === 0) {
        st.jt = 2;
        st.var2 = 0;
        splash?.playSfx("Sfx_DittoPopUp");
        return;
      }
      let angle = st.var2 % 0x40;
      if (angle < 32) angle += 32;
      st.yOffset = SpriteAnims.sine(angle, st.var1);
      const before = st.var2;
      st.var2 = (st.var2 + 255) % 256;
      if (before % 0x20 === 0) {
        st.var1 = (st.var1 - 48 + 256) % 256;
        splash?.playSfx("Sfx_DittoBounce");
      }
    } else if (st.jt === 2) {
      // GameFreakLogo_Ditto (splash.asm:285-304)
      if (st.var2 >= 32) {
        st.jt = 3;
        st.var2 = 0;
        splash?.playSfx("Sfx_DittoTransform");
      } else {
        st.var2 += 1;
      }
    } else if (st.jt === 3) {
      // GameFreakLogo_Transform (splash.asm:306-340)
      if (st.var2 === 64) {
        st.jt = 4;
        sys.flag = 1;
      } else {
        const step = Math.floor(st.var2 / 4);
        st.var2 += 1;
        splash?.fadeTo(step);
      }
    }
  },
};

// objects.asm:11-12 SPRITE_ANIM_OBJ_GAMEFREAK_LOGO
const OBJECTS: Record<string, [string, string]> = {
  CRYSTAL_GAMEFREAK_LOGO: ["CrystalGameFreakLogo", "CrystalGameFreakLogo"],
};

function register<T>(target: Record<string, T>, entries: Record<string, T>): void {
  for (const [name, value] of Object.entries(entries)) if (target[name] === undefined) target[name] = value;
}
register(SpriteAnims.OAMSETS as Record<string, unknown>, OAMSETS);
register(SpriteAnims.FRAMESETS as Record<string, unknown>, FRAMESETS);
register(SpriteAnims.OBJECTS as Record<string, unknown>, OBJECTS);
register(SpriteAnims.SEQUENCES as Record<string, unknown>, SEQUENCES);

// ------------------------------------------------------------------- screen

export interface CrystalSplashOpts {
  oakSpeech?: any;
  onDone?: (skipped: boolean) => void;
}

type SceneFn = (self: CrystalSplash) => void;

export class CrystalSplash {
  static isOpaque = true;
  isOpaque = true;
  game: any;
  onDone: ((skipped: boolean) => void) | undefined;
  obColors: Rgb[];
  bgColors: Colors;
  dittoFade: Colors | undefined;
  sheets: TileSheet[];
  ditto: TileSheet;
  anims: SpriteAnimSystem;
  scene = 0;
  timer = 0;
  /** The BG tilemap, sparse: tiles[ty][tx] = tile id. */
  tiles: Record<number, Record<number, number>> = {};
  frames = 0;
  exitTail: number | null = null;
  done = false;
  skipped: boolean | undefined;

  // Lua: CrystalSplash.lua:178 -- opts: oakSpeech (for its `splash`), onDone(skipped)
  constructor(game: any, opts: CrystalSplashOpts = {}) {
    this.game = game;
    this.onDone = opts.onDone;
    const splash = (opts.oakSpeech ?? {}).splash ?? {};
    const ob: Colors = splash.dittoPalette ?? DITTO_OB;
    this.obColors = [ob[0]!, ob[1]!, ob[2]!, ob[3]!];
    this.bgColors = splash.bgPalette ?? DEFAULT_BG;
    this.dittoFade = splash.dittoFade;
    // GameFreakLogoGFX's 28 1bpp tiles at vTiles2 $00 (splash.asm:62-65):
    // letters $00-$0c, the 3x5 logo $0d-$1b
    this.sheets = [
      TileSheet.new({ path: splash.presents ?? "assets/generated/splash/presents.png", wide: 13, firstTile: 0x00 }),
      TileSheet.new({ path: splash.logo ?? "assets/generated/splash/logo.png", wide: 3, firstTile: 0x0d }),
    ];
    this.ditto = TileSheet.new({ path: splash.ditto ?? "assets/generated/splash/ditto.png", wide: splash.dittoTilesWide ?? 16, firstTile: 0x00 });
    this.anims = SpriteAnims.new();
    (this.anims as SpriteAnimSystem & { splash?: CrystalSplash }).splash = this;
    // splash.asm:91-102: spawn hidden, VAR1=96, VAR2=48
    const st = this.anims.init("CRYSTAL_GAMEFREAK_LOGO", LOGO_X, LOGO_Y);
    if (st) {
      st.yOffset = YCOORD_HIDDEN;
      st.var1 = 96;
      st.var2 = 48;
    }
  }

  static new(game: any, opts?: CrystalSplashOpts): CrystalSplash {
    return new CrystalSplash(game, opts ?? {});
  }

  wantsFillScale(): boolean {
    return true;
  }

  drawsWidescreen(): boolean {
    return true;
  }

  // Lua: CrystalSplash.lua:216
  enter(): void {
    const data = this.game && this.game.data;
    if (data && data.audio && data.audio.runtime) Music.stop();
    if (Runtime.wants("intro.boot.gamefreak")) Runtime.emit("intro.boot.gamefreak", { screen: this, game: this.game });
  }

  // Lua: CrystalSplash.lua:226
  finish(): void {
    if (this.done) return;
    this.done = true;
    if (this.onDone) this.onDone(this.skipped === true);
  }

  // Lua: CrystalSplash.lua:232
  playSfx(name: string): void {
    const data = this.game && this.game.data;
    if (data && data.audio && data.audio.sfx && data.audio.sfx[name]) Sound.play(data, name);
  }

  // Lua: CrystalSplash.lua:241 -- OBJ pal 1 colour 2 down GameFreakDittoPaletteFade
  fadeTo(step: number): void {
    const color = this.dittoFade?.[step];
    if (color) this.obColors[2] = color;
  }

  // Lua: CrystalSplash.lua:247
  placeString(tiles: readonly number[], tx: number, ty: number): void {
    const row = (this.tiles[ty] ??= {});
    tiles.forEach((tile, i) => {
      row[tx + i] = tile;
    });
  }

  // ---------------------------------- GameFreakPresentsScene (splash.asm:125-199)

  sceneWaitSpriteAnim(): void {
    if (this.anims.flag === 0) return;
    this.scene = 1;
    this.timer = 0;
  }

  scenePlaceGameFreak(): void {
    if (this.timer < 32) {
      this.timer += 1;
      return;
    }
    this.timer = 0;
    this.placeString(GAME_FREAK, GAME_FREAK_X, GAME_FREAK_Y);
    this.scene = 2;
    this.playSfx("Sfx_GameFreakPresents");
  }

  scenePlacePresents(): void {
    if (this.timer < 64) {
      this.timer += 1;
      return;
    }
    this.timer = 0;
    this.placeString(PRESENTS, PRESENTS_X, PRESENTS_Y);
    this.scene = 3;
  }

  sceneWaitForTimer(): void {
    if (this.timer < 128) {
      this.timer += 1;
      return;
    }
    this.beginExit();
  }

  // Lua: CrystalSplash.lua:305 -- GameFreakPresentsEnd (splash.asm:117-123)
  beginExit(): void {
    if (this.exitTail != null) return;
    this.anims.clear();
    this.tiles = {};
    this.exitTail = 0;
  }

  // Lua: CrystalSplash.lua:312
  update(_dt?: number): void {
    this.frames += 1;
    if (this.exitTail != null) {
      this.exitTail += 1;
      if (this.exitTail > EXIT_FRAMES) this.finish();
      return;
    }
    const input = this.game && this.game.input;
    if (input && (input.wasPressed("a") || input.wasPressed("b") || input.wasPressed("start") || input.wasPressed("select"))) {
      // SplashScreen.pressed_button (splash.asm:51-54) returns carry
      this.skipped = true;
      this.beginExit();
      return;
    }
    const scene = SCENES[this.scene];
    if (scene) scene(this);
    this.anims.playFrame();
  }

  // ------------------------------------------------------------------ drawing

  private readonly sheetOf = new Map<number, TileSheet | null>();

  // Lua: CrystalSplash.lua:338
  sheetFor(tile: number): TileSheet | null {
    const known = this.sheetOf.get(tile);
    if (known !== undefined) return known;
    let found: TileSheet | null = null;
    for (const sheet of this.sheets) {
      if (tile >= sheet.firstTile && sheet.available()) {
        const index = tile - sheet.firstTile;
        const [, height] = sheet.image()!.getDimensions();
        if (index < sheet.wide * (height / 8)) {
          found = sheet;
          break;
        }
      }
    }
    this.sheetOf.set(tile, found);
    return found;
  }

  drawTile(tile: number, tx: number, ty: number, colors: Colors): void {
    const sheet = this.sheetFor(tile);
    if (!sheet) return;
    sheet.palette = colors;
    sheet.draw(tile, tx, ty);
  }

  // Lua: CrystalSplash.lua:357 -- the Gold screen puts earlier objects on top,
  // so the OAM walks forwards (the Lua walks it backwards to paint 1 last)
  drawObjects(): void {
    const sheet = this.ditto;
    if (!sheet.available()) return;
    G.push();
    G.objects = true;
    G.setColor(1, 1, 1, 1);
    if (GbcPalette.available()) GbcPalette.use(this.obColors);
    for (const entry of this.anims.oam) {
      const quad = sheet.quad(entry.tile);
      if (!quad) continue;
      const flipX = Math.floor(entry.attr / SpriteAnims.OAM_XFLIP) % 2 === 1;
      const flipY = Math.floor(entry.attr / SpriteAnims.OAM_YFLIP) % 2 === 1;
      G.draw(sheet.image()!, quad, entry.x - 8 + (flipX ? 8 : 0), entry.y - 16 + (flipY ? 8 : 0), 0, flipX ? -1 : 1, flipY ? -1 : 1);
    }
    G.pop();
  }

  // Lua: CrystalSplash.lua:383
  drawPanel(): void {
    const backdrop = GbcPalette.color(this.bgColors, 1) ?? BLACK;
    G.setColor(backdrop[0]! / 255, backdrop[1]! / 255, backdrop[2]! / 255, 1);
    G.rectangle("fill", 0, 0, SCREEN_W, SCREEN_H);
    G.setColor(1, 1, 1, 1);
    for (const ty of Object.keys(this.tiles)) {
      const row = this.tiles[Number(ty)]!;
      for (const tx of Object.keys(row)) this.drawTile(row[Number(tx)]!, Number(tx), Number(ty), this.bgColors);
    }
    this.drawObjects();
    G.setColor(1, 1, 1, 1);
  }

  draw(): void {
    this.drawPanel();
  }

  // the Gold screen is the panel: no letterbox or fit
  drawWidescreen(_winW: number, _winH: number): void {
    this.drawPanel();
  }
}

// Lua: CrystalSplash.lua:298
const SCENES: SceneFn[] = [
  (self) => self.sceneWaitSpriteAnim(),
  (self) => self.scenePlaceGameFreak(),
  (self) => self.scenePlacePresents(),
  (self) => self.sceneWaitForTimer(),
];

export default CrystalSplash;
