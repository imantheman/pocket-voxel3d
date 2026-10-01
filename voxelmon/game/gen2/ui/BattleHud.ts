// gen1recomp src/ui/gen2/BattleHud.lua (bdfac727, MIT): the battle HUD,
// drawn from the cart's own tiles.
//
// The HUD is not lines and boxes an engine invents: it is tiles the cart loads
// into fixed VRAM slots (engine/gfx/load_font.asm LoadBattleFontsHPBar /
// LoadHPBar), placed at fixed tile coordinates.
//
//   FontBattleExtra      -> $60  "HP:" is $60/$61; the bar's cells are $62
//                                (empty) through $6a (8 pixels of fill), and
//                                $6b is the bar's right end cap
//   EnemyHPBarBorderGFX  -> $6c  4 tiles: $6d left side, $6f bottom left
//   HPExpBarBorderGFX    -> $73  6 tiles: $73 right side, $74 bottom left,
//                                $76 bottom side, $77 / $78 bottom right
//   ExpBarGFX            -> $55  9 exp-bar fill cells
//
// On the Gold screen every one of these is simply a cell (G.draw on the 8px
// grid) wearing the HP / exp palette, which is exactly the cart's picture.

import { Assets } from "../shared/render/Assets.ts";
import { GbcPalette } from "../shared/render/GbcPalette.ts";
import { HpBar } from "../battle/HpBar.ts";
import G, { type LcdImage, type Quad } from "../platform/screen.ts";

type Rgb = readonly number[];
type Colors = Rgb[];

// Tile ids, so the arithmetic below reads as the ASM does.
// Lua: BattleHud.lua:31-59
const TILE_HP_LABEL = 0x60; // and $61
const TILE_BAR_EMPTY = 0x62; // $62..$6a is 0..8 pixels of fill
const TILE_BAR_END = 0x6b;
const FIRST_BATTLE_EXTRA = 0x60;

// Enemy border sheet ($6c..$6f) and player border sheet ($73..$78).
const ENEMY_BORDER_FIRST = 0x6c;
const PLAYER_BORDER_FIRST = 0x73;
const TILE_ENEMY_LEFT = 0x6d;
const TILE_ENEMY_BOTTOM_LEFT = 0x74; // from the player sheet, per the ASM
const TILE_ENEMY_BOTTOM_RIGHT = 0x78;
const TILE_BOTTOM_SIDE = 0x76;
const TILE_PLAYER_RIGHT = 0x73;
const TILE_PLAYER_BOTTOM_RIGHT = 0x77;
const TILE_PLAYER_BOTTOM_LEFT = 0x6f;

// DrawEnemyHUDBorder's tail: ExpBarGFX's 9th tile, the caught mark
// (engine/battle/trainer_huds.asm:143-152).
const TILE_CAUGHT = 0x5d;

// The ball icons StageBallTilesData stages, one per party slot
// (engine/battle/trainer_huds.asm:47-99).
const TILE_BALL_NORMAL = 0x31;
const TILE_BALL_STATUSED = 0x32;
const TILE_BALL_FAINTED = 0x33;
const TILE_BALL_EMPTY = 0x34;
// DrawPlayerPartyIconHUDBorder's corner (trainer_huds.asm:118-132).
const TILE_PARTY_ICON_BOTTOM_RIGHT = 0x5c;

// Lua: BattleHud.lua:198-200
const TILE_EXP_FULL = 0x6a; // FontBattleExtra
const TILE_EXP_EMPTY = 0x62; // FontBattleExtra
const EXP_PARTIAL_BASE = 0x54; // $54 + remainder lands in ExpBarGFX

interface BorderTiles {
  sideSheet: string;
  sideFirst: number;
  cornerSheet: string;
  cornerFirst: number;
  farSheet?: string;
  farFirst?: number;
  side: number;
  nearCorner: number;
  farCorner: number;
  bottom: number;
}

// Lua: BattleHud.lua:311
const PLAYER_FRAME_TILES: BorderTiles = {
  sideSheet: "playerBorder",
  sideFirst: PLAYER_BORDER_FIRST,
  cornerSheet: "playerBorder",
  cornerFirst: PLAYER_BORDER_FIRST,
  // $6f is the LAST tile of EnemyHPBarBorderGFX, not the player sheet
  // (engine/gfx/load_font.asm:57-65).
  farSheet: "enemyBorder",
  farFirst: ENEMY_BORDER_FIRST,
  side: TILE_PLAYER_RIGHT,
  nearCorner: TILE_PLAYER_BOTTOM_RIGHT,
  farCorner: TILE_PLAYER_BOTTOM_LEFT,
  bottom: TILE_BOTTOM_SIDE,
};

// StageBallTilesData's .GetHUDTile, and the $34 it stages past the party
// count (engine/battle/trainer_huds.asm:47-100).
// Lua: BattleHud.lua:338
function ballTile(mon: any): number {
  if (!mon) return TILE_BALL_EMPTY;
  if ((mon.hp ?? 0) <= 0) return TILE_BALL_FAINTED;
  return mon.status ? TILE_BALL_STATUSED : TILE_BALL_NORMAL;
}

export class BattleHud {
  static PARTY_LENGTH = 6;
  static EXP_CELLS = 8;
  static EXP_LENGTH_PX = 8 * 8;
  static TILE_HP_LABEL = TILE_HP_LABEL;
  static TILE_BAR_EMPTY = TILE_BAR_EMPTY;
  static TILE_BAR_END = TILE_BAR_END;

  gfx: Record<string, any> | undefined;
  palettes: any;
  images: Record<string, LcdImage | false> = {};
  quads: Record<string, Quad> = {};

  constructor(menuGfx: any, palettes: any) {
    this.gfx = menuGfx ? menuGfx.battleHud : undefined;
    this.palettes = palettes;
  }

  // Lua: BattleHud.lua:63
  static new(menuGfx?: any, palettes?: any): BattleHud {
    return new BattleHud(menuGfx, palettes);
  }

  // Lua: BattleHud.lua:72
  image(key: string): LcdImage | undefined {
    const path = this.gfx && this.gfx[key];
    if (!path) return undefined;
    let cached = this.images[path];
    if (cached === undefined) {
      try {
        cached = Assets.image(path);
      } catch {
        cached = false;
      }
      this.images[path] = cached;
    }
    return cached || undefined;
  }

  // One 8x8 tile out of a horizontal strip, cached per (sheet, index).
  // Lua: BattleHud.lua:85
  quad(image: LcdImage, index: number): Quad {
    const key = `${image.key}:${index}`;
    let quad = this.quads[key];
    if (!quad) {
      const [w, h] = image.getDimensions();
      quad = G.newQuad(index * 8, 0, 8, 8, w, h);
      this.quads[key] = quad;
    }
    return quad;
  }

  // Lua: BattleHud.lua:96
  available(): boolean {
    return this.image("hpBar") !== undefined;
  }

  // The 4-colour palette the HP-bar cells draw with: white, the bar's own light
  // colour, the state's fill colour, black.
  // Lua: BattleHud.lua:103
  barColors(key: string, zero?: Rgb | null): Colors | undefined {
    const pal = this.palettes && this.palettes.hpBar && this.palettes.hpBar[key];
    if (!pal) return undefined;
    return [zero ?? [255, 255, 255], [pal[0][0], pal[0][1], pal[0][2]], [pal[1][0], pal[1][1], pal[1][2]], [0, 0, 0]];
  }

  // Draw a run of tiles from a sheet whose first tile is `firstTile`, colouring
  // with `colors` when one is given.
  // Lua: BattleHud.lua:116
  drawTile(key: string, firstTile: number | undefined, tile: number, tx: number, ty: number, colors?: Colors | null, mirror?: boolean): boolean {
    const image = this.image(key);
    if (!image) return false;
    const index = tile - (firstTile as number);
    if (!(index >= 0)) return false;
    G.setColor(1, 1, 1, 1);
    const body = (): void => {
      if (mirror) {
        // Flip in place: the origin moves a tile right and x scales by -1.
        G.draw(image, this.quad(image, index), tx * 8 + 8, ty * 8, 0, -1, 1);
      } else {
        G.draw(image, this.quad(image, index), tx * 8, ty * 8);
      }
    };
    // home/fade.asm:35 (RotateThreePalettesRight)
    GbcPalette.with(colors ?? GbcPalette.DMG_SHADES, body);
    return true;
  }

  // Six bar cells at (tx, ty), no label and no end cap: DrawBattleHPBar itself
  // (PlacePartyHPBar calls it with `ld d, $6` / `ld b, $0`).
  // Lua: BattleHud.lua:149
  drawBar(hp: number, maxHp: number, tx: number, ty: number, zero?: Rgb | null, pixels?: number): number {
    pixels = pixels ?? HpBar.pixels(hp, maxHp);
    const colors = this.barColors(HpBar.palette(pixels), zero);
    for (let cell = 0; cell < HpBar.LENGTH_TILES; cell++) {
      const remaining = pixels - cell * 8;
      const filled = Math.max(0, Math.min(8, remaining));
      this.drawTile("hpBar", FIRST_BATTLE_EXTRA, TILE_BAR_EMPTY + filled, tx + cell, ty, colors);
    }
    return tx + HpBar.LENGTH_TILES;
  }

  // "HP:" plus the six bar cells plus the end cap, starting at tile (tx, ty).
  // Returns the column just past the assembly (tx + 9). `zero` overrides
  // colour 0: the stats screen puts the page tint there
  // (engine/gfx/color.asm:386-390).
  // Lua: BattleHud.lua:166
  drawHpBar(hp: number, maxHp: number, tx: number, ty: number, zero?: Rgb | null, pixels?: number): number {
    pixels = pixels ?? HpBar.pixels(hp, maxHp);
    const colors = this.barColors(HpBar.palette(pixels), zero);
    // The "HP:" badge sits inside the bar's own attrmap region, so it wears the
    // HP palette too.
    this.drawTile("hpBar", FIRST_BATTLE_EXTRA, TILE_HP_LABEL, tx, ty, colors);
    this.drawTile("hpBar", FIRST_BATTLE_EXTRA, TILE_HP_LABEL + 1, tx + 1, ty, colors);
    this.drawBar(hp, maxHp, tx + 2, ty, zero, pixels);
    this.drawTile("hpBar", FIRST_BATTLE_EXTRA, TILE_BAR_END, tx + 2 + HpBar.LENGTH_TILES, ty, colors);
    return tx + 3 + HpBar.LENGTH_TILES;
  }

  // PAL_BATTLE_BG_EXP, which the attrmap lays over (10,11)..(18,11)
  // (engine/gfx/cgb_layouts.asm:142-145).
  // Lua: BattleHud.lua:204
  expColors(zero?: Rgb | null): Colors | undefined {
    const pal = this.palettes && this.palettes.expBar;
    if (!pal) return undefined;
    return [zero ?? [255, 255, 255], [pal[0][0], pal[0][1], pal[0][2]], [pal[1][0], pal[1][1], pal[1][2]], [0, 0, 0]];
  }

  // The exp bar, transcribed from FillInExpBar / PlaceExpBar: eight tiles,
  // growing from the RIGHT; full cells $6a, the leftover $54 + remainder from
  // ExpBarGFX, empty cells $62.
  // Lua: BattleHud.lua:215
  drawExpBar(fraction: number | undefined, tx: number, ty: number, zero?: Rgb | null): boolean {
    if (!this.image("hpBar")) return false;
    fraction = Math.max(0, Math.min(1, fraction ?? 0));
    const pixels = Math.floor(fraction * BattleHud.EXP_LENGTH_PX);
    // The whole row wears the exp bar's palette, full and empty cells included.
    const colors = this.expColors(zero);
    let remaining = pixels;
    for (let cell = BattleHud.EXP_CELLS - 1; cell >= 0; cell--) {
      const column = tx + cell;
      if (remaining >= 8) {
        remaining = remaining - 8;
        this.drawTile("hpBar", FIRST_BATTLE_EXTRA, TILE_EXP_FULL, column, ty, colors);
      } else if (remaining > 0) {
        this.drawTile("expBar", this.gfx!.expBarFirstTile, EXP_PARTIAL_BASE + remaining, column, ty, colors);
        remaining = 0;
      } else {
        this.drawTile("hpBar", FIRST_BATTLE_EXTRA, TILE_EXP_EMPTY, column, ty, colors);
      }
    }
    return true;
  }

  // The exp bar's end sprite, at pixels rather than on the tile grid
  // (../pokecrystal/engine/sprite_anims/core.asm:547-608).
  // Lua: BattleHud.lua:242
  drawExpBarEnd(x: number, y: number, colors?: Colors | null): boolean {
    const image = this.image("expBarEnd");
    if (!image) return false;
    G.setColor(1, 1, 1, 1);
    const body = (): void => G.draw(image, x, y);
    if (colors) GbcPalette.with(colors, body);
    else GbcPalette.with(GbcPalette.DMG_SHADES, body);
    return true;
  }

  // The mark sits inside the enemy HP block, which the battle attrmap fills with
  // PAL_BATTLE_BG_ENEMY_HP (engine/gfx/cgb_layouts.asm:123-128).
  // Lua: BattleHud.lua:260
  drawCaughtIcon(tx: number, ty: number, hp: number, maxHp: number): boolean {
    const first = this.gfx && this.gfx.expBarFirstTile;
    if (!first || (this.gfx!.expBarCells ?? 0) < 9) return false;
    const colors = this.barColors(HpBar.palette(HpBar.pixels(hp, maxHp)));
    if (!colors) return false;
    return this.drawTile("expBar", first, TILE_CAUGHT, tx, ty, colors);
  }

  // PlaceHUDBorderTiles: side at the start, near corner one row below, eight
  // bottom-side tiles stepping by `step`, then the far corner.
  // Lua: BattleHud.lua:278
  placeBorder(tiles: BorderTiles, tx: number, ty: number, step: number): void {
    this.drawTile(tiles.sideSheet, tiles.sideFirst, tiles.side, tx, ty);
    this.drawTile(tiles.cornerSheet, tiles.cornerFirst, tiles.nearCorner, tx, ty + 1);
    let x = tx;
    for (let i = 1; i <= 8; i++) {
      x = x + step;
      this.drawTile(tiles.cornerSheet, tiles.cornerFirst, tiles.bottom, x, ty + 1);
    }
    x = x + step;
    this.drawTile(tiles.farSheet ?? tiles.cornerSheet, tiles.farFirst ?? tiles.cornerFirst, tiles.farCorner, x, ty + 1);
  }

  // DrawEnemyHUDBorder: hlcoord 1, 2 stepping right, tiles $6d / $74 / $78 / $76.
  // Lua: BattleHud.lua:297
  drawEnemyFrame(): void {
    this.placeBorder(
      {
        sideSheet: "enemyBorder",
        sideFirst: ENEMY_BORDER_FIRST,
        cornerSheet: "playerBorder",
        cornerFirst: PLAYER_BORDER_FIRST,
        side: TILE_ENEMY_LEFT,
        nearCorner: TILE_ENEMY_BOTTOM_LEFT,
        farCorner: TILE_ENEMY_BOTTOM_RIGHT,
        bottom: TILE_BOTTOM_SIDE,
      },
      1,
      2,
      1,
    );
  }

  // DrawPlayerHUDBorder: hlcoord 18, 10 stepping LEFT, plus the extra vertical
  // bar DrawPlayerHUD writes at (18,9).
  // Lua: BattleHud.lua:323
  drawPlayerFrame(): void {
    this.drawTile("playerBorder", PLAYER_BORDER_FIRST, TILE_PLAYER_RIGHT, 18, 9);
    this.placeBorder(PLAYER_FRAME_TILES, 18, 10, -1);
  }

  // DrawPlayerPartyIconHUDBorder (engine/battle/trainer_huds.asm:118-132).
  // Lua: BattleHud.lua:330
  drawPartyIconFrame(): boolean {
    this.placeBorder(PLAYER_FRAME_TILES, 18, 10, -1);
    return this.drawTile("expBar", this.gfx && this.gfx.expBarFirstTile, TILE_PARTY_ICON_BOTTOM_RIGHT, 18, 11, this.expColors());
  }

  // PAL_BATTLE_OB_YELLOW (engine/battle/trainer_huds.asm:213-214).
  // Lua: BattleHud.lua:345
  ballColors(): Colors | undefined {
    const pals = this.palettes && this.palettes.battleObjects;
    return pals ? pals.PAL_BATTLE_OB_YELLOW : undefined;
  }

  // LoadTrainerHudOAM (engine/battle/trainer_huds.asm:203-223): six sprites
  // from (tx, ty), each one tile further along `step`. They are OAM on the
  // cart, so they are objects here too.
  // Lua: BattleHud.lua:352
  drawBallRow(party: any[] | undefined, tx: number, ty: number, step: number): boolean {
    if (!this.image("balls")) return false;
    const first = this.gfx!.ballsFirstTile ?? TILE_BALL_NORMAL;
    const colors = this.ballColors();
    G.push();
    G.objects = true;
    for (let slot = 1; slot <= BattleHud.PARTY_LENGTH; slot++) {
      this.drawTile("balls", first, ballTile(party && party[slot - 1]), tx + (slot - 1) * step, ty, colors);
    }
    G.pop();
    return true;
  }
}

export default BattleHud;
