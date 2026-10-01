// gen1recomp src/ui/gen2/EggHatchAnim.lua (bdfac727, MIT): the egg hatch
// cutscene -- engine/pokemon/breeding.asm EggHatch_AnimationSequence, the
// beat HatchEggs runs between "Huh?" and "<NAME> came out of its EGG!".
//
// The sequence, in the cart's own order: MUSIC_NONE, BlankScreen; the EGG
// pic at hlcoord 7, 4 and MUSIC_EVOLUTION; 80 still frames; eight rounds of
// r wobbles (hSCX +2 / -2 for two frames each, the sprites carried the same
// way by wGlobalAnimXOffset), sixteen still frames and EggHatch_CrackShell;
// then SFX_EGG_HATCH, ten shell fragments, the hatchling's pic at hlcoord
// 6, 3, Hatch_ShellFragmentLoop's 129 frames and PlayMonCry.
//
// The wobble is the hardware's: the pic stays on the BG map and hSCX moves
// it (platform/lcd.ts regs), while the crack and shell objects move by the
// same two pixels the way wGlobalAnimXOffset moves them.

import { truthy } from "../platform/lua.ts";
import G, { currentLcd, type LcdImage, type Quad, SOLID } from "../platform/screen.ts";
import { ATTR_HOLE } from "../platform/lcd.ts";
import { Palettes } from "../world/Palettes.ts";
import { Assets } from "../shared/render/Assets.ts";
import { GbcPalette } from "../shared/render/GbcPalette.ts";
import { MonAnimView } from "../shared/render/MonAnimView.ts";
import { Music } from "../shared/core/Music.ts";
import { Sound } from "../shared/core/Sound.ts";
import { Sprites } from "../shared/pokemon/Sprites.ts";
import { Chrome } from "./Chrome.ts";
import { SpriteAnims } from "./SpriteAnims.ts";

// Lua: EggHatchAnim.lua:52 -- Hatch_UpdateFrontpicBGMapCenter's two hlcoords.
const EGG_TILE_X = 7;
const EGG_TILE_Y = 4;
const MON_TILE_X = 6;
const MON_TILE_Y = 3;

// Lua: EggHatchAnim.lua:61 -- PadFrontpic (engine/gfx/load_pics.asm:342),
// keyed by the pic's width in tiles: [column pad, row pad].
const PIC_PAD: Record<number, [number, number]> = { 7: [0, 0], 6: [1, 1], 5: [1, 2] };

// Lua: EggHatchAnim.lua:64 -- `ld c, 80 / call DelayFrames`.
const HOLD_FRAMES = 80;
// Lua: EggHatchAnim.lua:67 -- `.outerloop`'s `cp 8`.
const ROUNDS = 8;
// Lua: EggHatchAnim.lua:69 -- `ld c, 2 / call DelayFrames`.
const WOBBLE_HALF = 2;
// Lua: EggHatchAnim.lua:71 -- `ld a, 2 / ldh [hSCX]` then `ld a, -2`.
const SHAKE = 2;
// Lua: EggHatchAnim.lua:73 -- `ld c, 16 / call DelayFrames`.
const STILL_FRAMES = 16;
// Lua: EggHatchAnim.lua:75 -- Hatch_ShellFragmentLoop's `ld c, 129`.
const FRAGMENT_FRAMES = 129;

interface FragmentRow {
  x: number;
  y: number;
  flipX: boolean;
  flipY: boolean;
  angle: number;
}

// Lua: EggHatchAnim.lua:84 -- Hatch_InitShellFragments' .SpriteData.
const FRAGMENTS: FragmentRow[] = [
  { x: 10 * 8 + 4, y: 9 * 8, flipX: false, flipY: false, angle: 0x3c },
  { x: 11 * 8 + 4, y: 9 * 8, flipX: true, flipY: false, angle: 0x04 },
  { x: 10 * 8 + 4, y: 10 * 8, flipX: false, flipY: false, angle: 0x30 },
  { x: 11 * 8 + 4, y: 10 * 8, flipX: true, flipY: false, angle: 0x10 },
  { x: 10 * 8 + 4, y: 11 * 8, flipX: false, flipY: true, angle: 0x24 },
  { x: 11 * 8 + 4, y: 11 * 8, flipX: true, flipY: true, angle: 0x1c },
  { x: 10 * 8, y: 9 * 8 + 4, flipX: false, flipY: false, angle: 0x36 },
  { x: 12 * 8, y: 9 * 8 + 4, flipX: true, flipY: false, angle: 0x0a },
  { x: 10 * 8, y: 10 * 8 + 4, flipX: false, flipY: true, angle: 0x2a },
  { x: 12 * 8, y: 10 * 8 + 4, flipX: true, flipY: true, angle: 0x16 },
];

// Lua: EggHatchAnim.lua:100 -- AnimSeq_RevealNewMon: var1 by 8 up to $80.
const FRAGMENT_STEP = 8;
const FRAGMENT_LIMIT = 0x80;

// Lua: EggHatchAnim.lua:111 -- .OAMData_1x1_Palette0's -4 plus OAM's -8 / -16.
const OAM_X = -8 - 4;
const OAM_Y = -16 - 4;

interface Beat {
  frames: number;
  enter?: () => void;
}

interface HatchSprite {
  kind: "crack" | "fragment";
  x: number;
  y: number;
  flipX?: boolean;
  flipY?: boolean;
  angle?: number;
  var1?: number;
  xOffset?: number;
  yOffset?: number;
}

export interface EggHatchAnimOpts {
  /** The hatchling's party record (species, shiny, nickname). */
  mon?: any;
  /** The hatchling's species, when there is no record to hand. */
  species?: string;
  /** data.gen2MenuGfx, when the caller has its own. */
  menuGfx?: any;
  /** The beat after PlayMonCry. */
  onDone?: () => void;
}

/**
 * Lua: EggHatchAnim.lua:276 -- AnimSeq_RevealNewMon, one frame: amplitude
 * +8, angle xor $20, sine/cosine become the y/x offsets.
 */
function stepFragment(sprite: HatchSprite): boolean {
  if (sprite.var1! >= FRAGMENT_LIMIT) return false;
  const amplitude = sprite.var1!;
  sprite.var1 = sprite.var1! + FRAGMENT_STEP;
  // `xor $20` toggles bit 5, half a period of the six-bit angle.
  const angle = sprite.angle! % 256;
  const bit5 = Math.floor(angle / 0x20) % 2;
  sprite.angle = bit5 === 1 ? angle - 0x20 : angle + 0x20;
  sprite.yOffset = SpriteAnims.sine(sprite.angle, amplitude);
  sprite.xOffset = SpriteAnims.cosine(sprite.angle, amplitude);
  return true;
}

export class EggHatchAnim {
  // Lua: EggHatchAnim.lua:46
  static isOpaque = true;
  isOpaque = true;
  [key: string]: any;

  game: any;
  data: any;
  palettes: any;
  mon: any;
  species: any;
  onDone?: (() => void) | null;
  eggPath: string | undefined;
  shellPath: string | undefined;
  picCache: Record<string, LcdImage | false>;
  shellQuads: Quad[] | null;
  showMon: boolean;
  shakeX: number;
  sprites: HatchSprite[];
  beats: Beat[];
  beatIndex: number;
  beatLeft: number;
  done?: boolean;

  /** Lua: EggHatchAnim.lua:114 */
  wantsFillScale(): boolean {
    return true;
  }

  /** Lua: EggHatchAnim.lua:115 */
  drawsWidescreen(): boolean {
    return true;
  }

  /** Lua: EggHatchAnim.lua:125 -- opts: mon, species, menuGfx, onDone(). */
  static new(game: any, opts?: EggHatchAnimOpts): EggHatchAnim {
    return new EggHatchAnim(game, opts);
  }

  constructor(game: any, opts?: EggHatchAnimOpts) {
    const o: EggHatchAnimOpts = opts || {};
    this.game = game;
    this.data = (game && game.data) || {};
    this.palettes = this.data.gen2Palettes;
    this.mon = o.mon;
    this.species = o.species || (this.mon && this.mon.species);
    this.onDone = o.onDone;

    const gfx = (o.menuGfx || this.data.gen2MenuGfx || {}).eggHatch || {};
    this.eggPath = gfx.egg;
    this.shellPath = gfx.shell;
    this.picCache = {};
    this.shell = null;
    this.shellQuads = null;

    // The screen starts on the egg and only swaps to the hatchling at `.done`.
    this.showMon = false;
    this.shakeX = 0;
    this.sprites = [];

    // `ld de, MUSIC_NONE / call PlayMusic` and then MUSIC_EVOLUTION.
    Music.stop();
    const songs = this.data.audio && this.data.audio.songs;
    if (songs && songs.Music_Evolution) {
      Music.play(this.data, "Music_Evolution", true, { reason: "hatch" });
    }

    this.beats = this.buildBeats();
    this.beatIndex = 1;
    this.beatLeft = this.beats[0] ? this.beats[0].frames : 0;
    this.runBeat(this.beats[0]);
  }

  /**
   * Lua: EggHatchAnim.lua:166 -- the whole sequence as a flat list of
   * { frames, enter }; every number is one DelayFrames operand.
   */
  buildBeats(): Beat[] {
    const beats: Beat[] = [];
    const beat = (frames: number, enter: () => void): void => {
      beats.push({ frames, enter });
    };

    beat(HOLD_FRAMES, () => {
      this.shakeX = 0;
    });

    for (let round = 1; round <= ROUNDS; round++) {
      for (let i = 1; i <= round; i++) {
        beat(WOBBLE_HALF, () => {
          this.shakeX = SHAKE;
        });
        beat(WOBBLE_HALF, () => {
          this.shakeX = -SHAKE;
        });
      }
      beat(STILL_FRAMES, () => {
        this.shakeX = 0;
      });
      beat(0, () => {
        this.crackShell(round);
      });
    }

    // `.done`: hSCX and wGlobalAnimXOffset zeroed, ClearSprites, fragments
    // up, and the pic becomes the hatchling's.
    beat(FRAGMENT_FRAMES, () => {
      this.shakeX = 0;
      this.sprites = [];
      this.playSfx("Sfx_EggHatch");
      this.initFragments();
      this.showMon = true;
    });
    // ../pokecrystal/engine/pokemon/breeding.asm:754-761
    beat(0, () => {
      this.startPicAnim();
    });
    return beats;
  }

  /** Lua: EggHatchAnim.lua:198 -- ../pokecrystal/engine/gfx/pic_animation.asm:74 */
  startPicAnim(): void {
    const def = truthy(this.species) && this.data.pokemon && this.data.pokemon[this.species];
    const [path, , vanilla] = this.picPath();
    this.picAnim = MonAnimView.start(
      def || undefined,
      this.mon,
      "hatch",
      (p: string) => this.image(p),
      () => {
        this.playCry();
      },
      {
        resolve: (sheet: string) => Sprites.pic(sheet, this.picCtx("hatch_anim")),
        staticReplaced: MonAnimView.replaced(vanilla, path),
      },
    );
    if (!this.picAnim) this.playCry();
  }

  // ------------------------------------------------------------------- sound

  /** Lua: EggHatchAnim.lua:217 */
  playSfx(name: string): void {
    const sfx = this.data.audio && this.data.audio.sfx;
    if (sfx && sfx[Sound.resolve(this.data, name)]) {
      Sound.play(this.data, name);
    }
  }

  /** Lua: EggHatchAnim.lua:224 */
  playCry(): void {
    const species = this.species;
    if (!truthy(species)) return;
    const cries = this.data.audio && this.data.audio.cries;
    if (cries && cries[species]) Sound.playCry(this.data, species);
  }

  // ------------------------------------------------------ the sprite objects

  /**
   * Lua: EggHatchAnim.lua:241 -- EggHatch_CrackShell (breeding.asm:756):
   * rounds 2, 4 and 6 crack, on tile rows 9, 10 and 11 at x = 11 tiles.
   */
  crackShell(round: number): void {
    const a = (round - 1) % 8;
    if (a === 7) return;
    if (a % 2 === 0) return;
    const step = Math.floor(a / 2);
    this.sprites.push({
      kind: "crack",
      x: 11 * 8,
      y: step * 8 + 9 * 8,
    });
    this.playSfx("Sfx_EggCrack");
  }

  /** Lua: EggHatchAnim.lua:256 -- Hatch_InitShellFragments. */
  initFragments(): void {
    for (const row of FRAGMENTS) {
      this.sprites.push({
        kind: "fragment",
        x: row.x,
        y: row.y,
        flipX: row.flipX,
        flipY: row.flipY,
        // SPRITEANIMSTRUCT_JUMPTABLE_INDEX carries the fragment's angle.
        angle: row.angle,
        var1: 0,
        xOffset: 0,
        yOffset: 0,
      });
    }
  }

  // ------------------------------------------------------------------ update

  /** Lua: EggHatchAnim.lua:295 */
  runBeat(beat: Beat | undefined): void {
    if (beat && beat.enter) beat.enter();
  }

  /** Lua: EggHatchAnim.lua:299 */
  finish(): void {
    this.done = true;
    const cb = this.onDone;
    this.onDone = null;
    if (cb) cb();
  }

  /** Lua: EggHatchAnim.lua:306 */
  update(_dt?: number): void {
    if (this.done) return;

    // ../pokecrystal/engine/gfx/pic_animation.asm:79-89
    if (this.picAnim) {
      if (this.picAnim.step()) {
        this.picAnim = null;
        return this.finish();
      }
      return;
    }

    // EggHatch_DoAnimFrame: the sprites advance every frame; a spent
    // fragment is DeinitializeSprite'd.
    const live: HatchSprite[] = [];
    for (const sprite of this.sprites) {
      if (sprite.kind !== "fragment" || stepFragment(sprite)) live.push(sprite);
    }
    this.sprites = live;

    while (this.beatLeft <= 0) {
      this.beatIndex = this.beatIndex + 1;
      const beat = this.beats[this.beatIndex - 1];
      if (!beat) return this.finish();
      this.beatLeft = beat.frames;
      this.runBeat(beat);
      if (this.picAnim) return;
    }
    this.beatLeft = this.beatLeft - 1;
  }

  // -------------------------------------------------------------------- draw

  /** Lua: EggHatchAnim.lua:348 */
  image(path: string | undefined | null): LcdImage | null {
    if (!truthy(path)) return null;
    let cached = this.picCache[path!];
    if (cached === undefined) {
      try {
        cached = Assets.image(path!);
      } catch {
        cached = false;
      }
      this.picCache[path!] = cached;
    }
    return cached || null;
  }

  /** Lua: EggHatchAnim.lua:360 */
  picCtx(kind: string): any {
    return {
      species: this.species,
      side: "front",
      kind,
      mon: this.mon,
      data: this.data,
      shiny: !!(this.mon && truthy(this.mon.shiny)),
    };
  }

  /** Lua: EggHatchAnim.lua:371 */
  picPath(): [string | undefined, boolean, string | undefined] {
    const def = truthy(this.species) && this.data.pokemon && this.data.pokemon[this.species];
    const vanilla = def ? def.spriteFront : undefined;
    const [path, trueColor] = Sprites.pic(vanilla, this.picCtx("hatch"));
    return [path, trueColor, vanilla];
  }

  /** Lua: EggHatchAnim.lua:379 */
  pic(): [LcdImage | null, boolean | undefined] {
    if (this.showMon) {
      const [path, trueColor] = this.picPath();
      return [this.image(path), trueColor];
    }
    return [this.image(this.eggPath), undefined];
  }

  /**
   * Lua: EggHatchAnim.lua:396 -- Hatch_LoadFrontpicPal: the pic's own
   * palette, EGG's row while the shell is up.
   */
  picColors(): any {
    const species = this.showMon ? this.species : "EGG";
    return Palettes.monColors(this.palettes, species, this.mon && this.mon.shiny);
  }

  /** Lua: EggHatchAnim.lua:402 */
  drawPic(): void {
    let [image, trueColor] = this.pic();
    if (!image) return;
    let w = image.getWidth();
    // ../pokecrystal/engine/gfx/pic_animation.asm:431-435
    let sheet: LcdImage | undefined;
    let quad: Quad | undefined;
    let size: number | undefined;
    if (this.picAnim) {
      const f = this.picAnim.frame();
      if (f) [sheet, quad, size] = f;
    }
    if (sheet) {
      w = size!;
      trueColor = this.picAnim.trueColor;
    }
    const tx = this.showMon ? MON_TILE_X : EGG_TILE_X;
    const ty = this.showMon ? MON_TILE_Y : EGG_TILE_Y;
    // PadFrontpic's own placement, not a centring rule.
    const pad = PIC_PAD[Math.floor(w / 8)] || PIC_PAD[7]!;
    const px = tx * 8 + pad[0] * 8;
    const py = ty * 8 + pad[1] * 8;
    G.setColor(1, 1, 1, 1);
    const colors = this.picColors();
    const body = (): void => {
      if (sheet) return G.draw(sheet, quad, px, py);
      G.draw(image!, px, py);
    };
    if (colors && !(trueColor && GbcPalette.mode === "gbc") && GbcPalette.available()) {
      GbcPalette.with(colors, body);
    } else {
      body();
    }
  }

  /**
   * Lua: EggHatchAnim.lua:435 -- EggHatchGFX: tile $00 the crack, tile $01
   * the shell fragment, both 1x1 on OBJ palette 0.
   */
  shellQuad(index: number): [LcdImage | null, Quad | null] {
    const image = this.image(this.shellPath);
    if (!image) return [null, null];
    if (!this.shellQuads) {
      const [iw, ih] = image.getDimensions();
      this.shellQuads = [G.newQuad(0, 0, 8, 8, iw, ih), G.newQuad(0, 8, 8, 8, iw, ih)];
    }
    return [image, this.shellQuads[index - 1] ?? null];
  }

  /** Lua: EggHatchAnim.lua:447 */
  drawSprites(): void {
    if (this.sprites.length === 0) return;
    G.setColor(1, 1, 1, 1);
    // The crack and the shards are OAM objects, whatever pixel they land on.
    G.push();
    G.objects = true;
    for (const sprite of this.sprites) {
      const slot = sprite.kind === "crack" ? 1 : 2;
      const [image, quad] = this.shellQuad(slot);
      if (image && quad) {
        let x = sprite.x + (sprite.xOffset || 0) + OAM_X;
        let y = sprite.y + (sprite.yOffset || 0) + OAM_Y;
        // The offsets are two's complement bytes.
        if ((sprite.xOffset || 0) > 0x7f) x = x - 256;
        if ((sprite.yOffset || 0) > 0x7f) y = y - 256;
        const flipX = !!sprite.flipX;
        const flipY = !!sprite.flipY;
        G.draw(image, quad, x + (flipX ? 8 : 0), y + (flipY ? 8 : 0), 0, flipX ? -1 : 1, flipY ? -1 : 1);
      }
    }
    G.pop();
  }

  /**
   * Lua: EggHatchAnim.lua:473 -- BlankScreen leaves the tilemap on colour 0;
   * both layers move the SAME way each wobble half (breeding.asm:707-719).
   */
  drawPanel(): void {
    Chrome.clear();
    // The Lua translates the whole picture by -shakeX. Here the pic stays on
    // the BG map and hSCX moves it, as on the cart; the objects move by
    // wGlobalAnimXOffset, i.e. the same translate.
    this.drawPic();
    G.push();
    G.translate(-(this.shakeX || 0), 0);
    this.drawSprites();
    G.pop();
    this.scrollBackground();
    G.setColor(1, 1, 1, 1);
  }

  /**
   * hSCX for the wobble. A scroll exposes BG columns past the 20 drawn, so
   * every cell still a hole is filled with the blank paper first, as
   * BlankScreen leaves the whole 32x32 map.
   */
  scrollBackground(): void {
    const lcd = currentLcd();
    if (!lcd) return;
    const c = GbcPalette.color(Chrome.DEFAULT_BOX_PALETTE, 1);
    const rgb: readonly [number, number, number] = [c[0]!, c[1]!, c[2]!];
    const slot = lcd.palette([rgb, rgb, rgb, rgb]);
    for (let i = 0; i < 1024; i++) {
      if (lcd.s.attrs[i]! & ATTR_HOLE) lcd.cell(i & 31, i >> 5, SOLID[0], slot);
    }
    lcd.regs({ scx: (this.shakeX || 0) & 0xff });
  }

  /** Lua: EggHatchAnim.lua:490 */
  draw(): void {
    this.drawPanel();
  }

  /** Lua: EggHatchAnim.lua:494 */
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

export default EggHatchAnim;
