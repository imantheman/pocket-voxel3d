// gen1recomp src/ui/gen2/TitleState.lua (bdfac727): the Gen 2 title --
// coloured TitleScreenTilemap BG, scrolling clouds, Ho-Oh's wing-flap
// (Frameset_GSIntroHoOhLugia), spark trails, A/START to continue.
// Every Gold/Silver difference arrives as a title.json key, defaulted to Gold.
//
// On the Gold screen the title is what the cart shows: the screen is BG
// cells, each through its title_bg_gold.pal palette (title.json's
// screenPalettes/screenPalMap -- the importer ships shade images plus those
// palettes where Brian baked the colours in), the cloud band scrolls with a
// per-line SCX over its rows, and Ho-Oh and the trails are objects through
// title_fg.pal (hoohPalette/trailPalette).

import type { Lcd, Palette4 } from "../platform/lcd.ts";
import { tonumber } from "../platform/lua.ts";
import { random } from "../platform/rng.ts";
import G, { currentLcd, type LcdImage } from "../platform/screen.ts";
import { Music } from "../shared/core/Music.ts";
import { Sound } from "../shared/core/Sound.ts";
import { Runtime } from "../shared/mods/Runtime.ts";
import { Assets } from "../shared/render/Assets.ts";
import { GbcPalette } from "../shared/render/GbcPalette.ts";
import { SpriteAnims } from "./SpriteAnims.ts";

type Rgb = readonly number[];
type Colors = readonly Rgb[];

// Lua: TitleState.lua:22 -- title_bg_gold.pal mid-sky shade.
const SKY = [123 / 255, 165 / 255, 255 / 255, 1];
// Lua: TitleState.lua:30 -- its grey stand-in when COLOR is not GBC.
const SKY_GRAY = [170 / 255, 170 / 255, 170 / 255, 1];

// Lua: TitleState.lua:32
function tryImage(path: string | null | undefined): LcdImage | null {
  if (!path) return null;
  try {
    return Assets.image(path) ?? null;
  } catch {
    return null;
  }
}

// Lua: TitleState.lua:210 -- Sprites_Sine's byte as a signed pixel delta.
function signed(value: number): number {
  if (value >= 0x80) return value - 0x100;
  return value;
}

/** The four colours a palette draws as under the COLOR mode (what GbcPalette.use sets). */
function resolved(colors: Colors | null | undefined): Palette4 {
  G.push();
  GbcPalette.use(colors);
  const p = G.palette;
  G.pop();
  return p;
}

interface Trail {
  x: number;
  y: number;
  phase: number;
  drawY?: number;
}

export interface TitleStateOpts {
  title?: any;
  onContinue?: () => void;
  onTimeout?: () => void;
}

export class TitleState {
  static isOpaque = true;

  isOpaque = true;
  game: any;
  onContinue: (() => void) | undefined;
  onTimeout: (() => void) | undefined;
  title: any;
  screenColor: LcdImage | null;
  cloudsColor: LcdImage | null;
  trailColor: LcdImage | null;
  screenGray: LcdImage | null;
  cloudsGray: LcdImage | null;
  trailGray: LcdImage | null;
  hoohX: number;
  hoohY: number;
  cloudY: number;
  cloudScrollEvery: number;
  hoohBobAmplitude: number;
  hoohBobStep: number;
  sky: number[];
  below: number[];
  hoohColor: (LcdImage | null)[] = [];
  hoohGray: (LcdImage | null)[] = [];
  sequence: [number, number][];
  seqIndex: number;
  seqLeft: number;
  frame: number;
  hoohPhase = 0;
  frameCounter = 0;
  cloudScroll = 0;
  trails: Trail[] = [];
  trailSpawns: [number, number][];
  trailSpawnIndex = 1;
  trailMode: string;
  trailSpawnEvery: number;
  trailStepX: number;
  trailStepY: number;
  trailBobAmplitude: number;
  trailPhaseStep: number;
  trailPhase: number | undefined;
  trailMaxX = 200;
  musicStarted = false;
  suicuneColor: (LcdImage | null)[] = [];
  suicuneGray: (LcdImage | null)[] = [];
  suicuneX: number;
  suicuneY: number;
  suicuneEvery: number;
  suicuneTick = 0;
  suicuneFrame = 1;
  gemColor: LcdImage | null;
  gemGray: LcdImage | null;
  gemX: number;
  gemRestY: number;
  gemStep: number;
  entrance: any;
  entranceScx: number;
  entranceStep: number;
  entranceLines: number;
  entranceHideBelow: number | undefined;
  gemY: number;
  entranceSfx: string | undefined;
  timeoutFrames: number | undefined;
  timeoutStart: number | undefined;
  fadeStart: number | undefined;
  bandColor: number[];
  // The importer's palettes for the shade sheets (see the header).
  screenPalettes: Colors[] | null;
  screenPalMap: number[] | null;
  hoohPalette: Colors | null;
  trailPalette: Colors | null;

  // Lua: TitleState.lua:42
  constructor(game: any, opts: TitleStateOpts = {}) {
    this.game = game;
    this.onContinue = opts.onContinue;
    const title = opts.title ?? {};
    this.title = title;
    this.screenColor = tryImage(title.screen ?? "assets/generated/title/title_screen.png");
    this.cloudsColor = tryImage(title.clouds ?? "assets/generated/title/clouds.png");
    this.trailColor = tryImage(title.trail ?? "assets/generated/title/trail.png");
    // The uncoloured set; pickArt falls back to the colour one when absent.
    this.screenGray = tryImage(title.screenGray);
    this.cloudsGray = tryImage(title.cloudsGray);
    this.trailGray = tryImage(title.trailGray);
    // `depixel 12, 11` less the OAM bias and the pose's own origin.
    this.hoohX = tonumber(title.hoohX) ?? 48;
    this.hoohY = tonumber(title.hoohY) ?? 56;
    this.cloudY = tonumber(title.cloudY) ?? 88;
    this.cloudScrollEvery = tonumber(title.cloudScrollEvery) ?? 8;
    // AnimSeq_GSIntroHoOhLugia (engine/sprite_anims/functions.asm:820-838).
    this.hoohBobAmplitude = tonumber(title.hoohBobAmplitude) ?? 2;
    this.hoohBobStep = tonumber(title.hoohBobStep) ?? 1;
    const sky = title.sky;
    this.sky = Array.isArray(sky) && sky.length >= 3 ? [sky[0], sky[1], sky[2], 1] : SKY;
    const below = title.below;
    this.below = Array.isArray(below) && below.length >= 3 ? [below[0], below[1], below[2], 1] : [1, 1, 1, 1];

    const paths = title.hoohFrames;
    if (Array.isArray(paths)) paths.forEach((path: string, i: number) => (this.hoohColor[i] = tryImage(path)));
    if (this.hoohColor.length === 0) this.hoohColor[0] = tryImage(title.hooh ?? "assets/generated/title/hooh.png");
    if (Array.isArray(title.hoohFramesGray)) {
      title.hoohFramesGray.forEach((path: string, i: number) => (this.hoohGray[i] = tryImage(path)));
    }
    this.sequence = title.hoohSequence ?? [[1, 10], [2, 9], [3, 10], [4, 10], [3, 9], [5, 10]];
    // A frame shows duration + 1 ticks (engine/sprite_anims/core.asm:400-434).
    // seqIndex and frame stay the Lua's 1-based values.
    this.seqIndex = 1;
    this.seqLeft = (this.sequence[0] ? this.sequence[0][1] : 10) + 1;
    this.frame = 1;

    // UpdateTitleTrailSprite / TitleTrailCoords (intro_menu.asm:1069-1124), in pixels.
    this.trailSpawns = title.trailSpawns ?? [[80, 88], [104, 88], [104, 88], [120, 88], [120, 88], [88, 88]];
    // AnimSeq_GSTitleTrail (engine/sprite_anims/functions.asm:720-818).
    this.trailMode = title.trailMode ?? "gold";
    this.trailSpawnEvery = tonumber(title.trailSpawnEvery) ?? 4;
    this.trailStepX = tonumber(title.trailStepX) ?? 4;
    this.trailStepY = tonumber(title.trailStepY) ?? 1;
    this.trailBobAmplitude = tonumber(title.trailBobAmplitude) ?? 2;
    this.trailPhaseStep = tonumber(title.trailPhaseStep) ?? 3;
    this.trailPhase = tonumber(title.trailPhase);

    // engine/movie/title.asm:104-127,217-273,304-338 (Crystal)
    if (Array.isArray(title.suicuneFrames)) {
      title.suicuneFrames.forEach((path: string, i: number) => (this.suicuneColor[i] = tryImage(path)));
    }
    if (Array.isArray(title.suicuneFramesGray)) {
      title.suicuneFramesGray.forEach((path: string, i: number) => (this.suicuneGray[i] = tryImage(path)));
    }
    this.suicuneX = tonumber(title.suicuneX) ?? 48;
    this.suicuneY = tonumber(title.suicuneY) ?? 96;
    this.suicuneEvery = tonumber(title.suicuneEvery) ?? 8;
    this.gemColor = tryImage(title.gem);
    this.gemGray = tryImage(title.gemGray);
    this.gemX = tonumber(title.gemX) ?? 56;
    this.gemRestY = tonumber(title.gemY) ?? 6;
    this.gemStep = tonumber(title.gemStep) ?? 2;
    // TitleScreenEntrance (engine/menus/intro_menu.asm:1078-1123).
    const entrance = title.entrance && typeof title.entrance === "object" ? title.entrance : null;
    this.entrance = entrance;
    this.entranceScx = entrance ? (tonumber(entrance.scx) ?? 112) : 0;
    this.entranceStep = entrance ? (tonumber(entrance.step) ?? 4) : 4;
    this.entranceLines = entrance ? (tonumber(entrance.lines) ?? 80) : 0;
    this.entranceHideBelow = entrance ? tonumber(entrance.hideBelow) : undefined;
    this.gemY = entrance ? (tonumber(title.gemFromY) ?? -50) : this.gemRestY;
    this.entranceSfx = title.entranceSfx;
    // engine/menus/intro_menu.asm:951-966
    this.timeoutFrames = tonumber(title.timeoutFrames) ?? (this.trailMode === "silver" ? 73 * 60 + 36 : 84 * 60 + 16);
    this.onTimeout = opts.onTimeout;
    // The copyright window line is pal 7 (engine/movie/title.asm:40-43).
    const pals = title.palettes && typeof title.palettes === "object" ? title.palettes.bg : null;
    const band = Array.isArray(pals) && Array.isArray(pals[7]) ? pals[7][0] : null;
    this.bandColor = Array.isArray(band) && band.length >= 3 ? [band[0] / 255, band[1] / 255, band[2] / 255, 1] : [0, 0, 0, 1];

    this.screenPalettes = Array.isArray(title.screenPalettes) ? title.screenPalettes : null;
    this.screenPalMap = Array.isArray(title.screenPalMap) ? title.screenPalMap : null;
    this.hoohPalette = Array.isArray(title.hoohPalette) ? title.hoohPalette : null;
    this.trailPalette = Array.isArray(title.trailPalette) ? title.trailPalette : null;
  }

  static new(game: any, opts?: TitleStateOpts): TitleState {
    return new TitleState(game, opts ?? {});
  }

  // Lua: TitleState.lua:39
  wantsFillScale(): boolean {
    return true;
  }

  // Lua: TitleState.lua:40
  drawsWidescreen(): boolean {
    return true;
  }

  // Lua: TitleState.lua:173
  startMusic(): void {
    if (this.musicStarted) return;
    const data = this.game && this.game.data;
    if (data && data.audio && data.audio.runtime) {
      Music.play(data, "Music_TitleScreen", true, { reason: "title" } as any);
      this.musicStarted = true;
    }
  }

  // Lua: TitleState.lua:182 -- intro.boot.title
  enter(): void {
    if (this.entrance) {
      // _TitleScreen silences the channels and plays the entrance sting.
      Music.stop();
      const data = this.game && this.game.data;
      if (data && data.audio && data.audio.runtime && this.entranceSfx && data.audio.sfx && data.audio.sfx[this.entranceSfx]) {
        Sound.play(data, this.entranceSfx);
      }
    } else {
      this.startMusic();
    }
    if (Runtime.wants("intro.boot.title")) Runtime.emit("intro.boot.title", { screen: this, game: this.game });
  }

  // Lua: TitleState.lua:216 -- AnimSeq_GSIntroHoOhLugia.
  hoohBob(): number {
    return signed(SpriteAnims.sine(this.hoohPhase, this.hoohBobAmplitude));
  }

  // Lua: TitleState.lua:220
  advanceHooh(): void {
    this.hoohPhase = (this.hoohPhase + this.hoohBobStep) % 256;
    this.seqLeft = this.seqLeft - 1;
    if (this.seqLeft > 0) return;
    this.seqIndex = this.seqIndex + 1;
    if (this.seqIndex > this.sequence.length) this.seqIndex = 1;
    const step = this.sequence[this.seqIndex - 1]!;
    this.frame = step[0];
    this.seqLeft = step[1] + 1;
  }

  // Lua: TitleState.lua:231
  spawnTrail(): void {
    if (!(this.trailColor || this.trailGray)) return;
    if (this.trailSpawns.length === 0) return;
    if (this.frameCounter % this.trailSpawnEvery !== 0) return;
    const spawn = this.trailSpawns[this.trailSpawnIndex - 1];
    this.trailSpawnIndex = (this.trailSpawnIndex % this.trailSpawns.length) + 1;
    if (!spawn) return;
    this.trails.push({ x: spawn[0], y: spawn[1], phase: this.trailPhase ?? random(0, 255) });
  }

  // Lua: TitleState.lua:244
  stepTrails(): void {
    const alive: Trail[] = [];
    const maxX = this.trailMaxX || 200;
    const silver = this.trailMode === "silver";
    for (const t of this.trails) {
      t.x = t.x + this.trailStepX;
      t.y = t.y + this.trailStepY;
      t.phase = t.phase + this.trailPhaseStep;
      if (silver) t.drawY = t.y + signed(SpriteAnims.sine(t.phase, this.trailBobAmplitude));
      else t.drawY = t.y + Math.floor(Math.sin(t.phase / 16) * this.trailBobAmplitude);
      if (t.x < maxX) alive.push(t);
    }
    this.trails = alive;
  }

  // Lua: TitleState.lua:265 -- SuicuneFrameIterator (Crystal).
  advanceSuicune(): void {
    if (this.suicuneColor.length === 0) return;
    const c = this.suicuneTick;
    this.suicuneTick = (c + 1) % 256;
    if (c % this.suicuneEvery !== 0) return;
    this.suicuneFrame = Math.floor((c % (this.suicuneEvery * 4)) / this.suicuneEvery) + 1;
  }

  // Lua: TitleState.lua:274
  update(_dt?: number): void {
    this.frameCounter = this.frameCounter + 1;
    this.advanceHooh();
    this.advanceSuicune();
    if (this.frameCounter % this.cloudScrollEvery === 0) {
      this.cloudScroll = (((this.cloudScroll - 1) % 160) + 160) % 160;
    }
    this.spawnTrail();
    this.stepTrails();

    if (this.entranceScx > 0) {
      // TitleScreenEntrance polls no buttons and moves the gem by 2 a frame.
      this.entranceScx = Math.max(0, this.entranceScx - this.entranceStep);
      if (this.gemY < this.gemRestY) this.gemY = Math.min(this.gemRestY, this.gemY + this.gemStep);
      if (this.entranceScx === 0) {
        this.startMusic();
        // TitleScreenTimer only starts once the entrance scene hands over.
        this.timeoutStart = this.frameCounter;
      }
      return;
    }

    // engine/menus/intro_menu.asm:1023-1059
    if (this.timeoutFrames != null && this.onTimeout) {
      if (this.fadeStart != null) {
        if (this.frameCounter - this.fadeStart >= 60) this.onTimeout();
        return;
      }
      if (this.frameCounter - (this.timeoutStart ?? 0) >= this.timeoutFrames) {
        this.fadeStart = this.frameCounter;
        Music.fadeOut(8);
        return;
      }
    }

    const input = this.game.input;
    if (input && (input.wasPressed("a") || input.wasPressed("start"))) {
      if (this.onContinue) this.onContinue();
    }
  }

  // Lua: TitleState.lua:319
  gray(): boolean {
    return GbcPalette.mode === "dmg" || GbcPalette.mode === "classic";
  }

  // Lua: TitleState.lua:323 -- [screen, clouds, trail, hoohFrames]
  art(): [LcdImage | null, LcdImage | null, LcdImage | null, (LcdImage | null)[]] {
    if (this.gray()) {
      return [
        this.screenGray ?? this.screenColor,
        this.cloudsGray ?? this.cloudsColor,
        this.trailGray ?? this.trailColor,
        this.hoohGray.length > 0 ? this.hoohGray : this.hoohColor,
      ];
    }
    return [this.screenColor, this.cloudsColor, this.trailColor, this.hoohColor];
  }

  /** The title_bg_gold.pal palette of screen cell (col, row), or null for none. */
  cellPalette(col: number, row: number): Colors | null {
    if (!this.screenPalettes || !this.screenPalMap) return null;
    const index = this.screenPalMap[row * 20 + col];
    return index != null ? (this.screenPalettes[index] ?? null) : null;
  }

  /**
   * The screen palette `index`'s slot this frame (null: `fallback`'s). Each of
   * title_bg_gold.pal's palettes is resolved and matched to a slot once a
   * frame, not once per cell.
   */
  private slotOf(lcd: Lcd, index: number | undefined, fallback: Palette4 | null): number {
    if (this.slotFrame !== lcd.frame || this.slotMode !== GbcPalette.mode) {
      this.slotFrame = lcd.frame;
      this.slotMode = GbcPalette.mode;
      this.slots.length = 0;
      this.nullSlot = -1;
    }
    if (index == null || !this.screenPalettes?.[index]) {
      if (fallback) return lcd.palette(fallback);
      if (this.nullSlot < 0) this.nullSlot = lcd.palette(resolved(null));
      return this.nullSlot;
    }
    let slot = this.slots[index];
    if (slot === undefined) {
      slot = lcd.palette(resolved(this.screenPalettes[index]));
      this.slots[index] = slot;
    }
    return slot;
  }
  private slots: number[] = [];
  private slotFrame = -1;
  private slotMode = "";
  private nullSlot = -1;

  /** The screen as BG cells, each through its own palette. */
  drawScreen(screen: LcdImage): void {
    if (!this.screenPalettes || !this.screenPalMap) {
      G.draw(screen, 0, 0);
      return;
    }
    const lcd = currentLcd();
    if (lcd && G.tx === 0 && G.ty === 0 && G.map == null && !G.objects) {
      const cells = lcd.s.cells;
      const attrs = lcd.s.attrs;
      const map = this.screenPalMap;
      const rows = Math.min(18, screen.th);
      const cols = Math.min(20, screen.tw);
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const i = row * 32 + col;
          cells[i] = screen.ids[row * screen.tw + col]! & 0xffff;
          attrs[i] = this.slotOf(lcd, map[row * 20 + col], null) & 0xef;
        }
      }
      return;
    }
    const quad = G.newQuad(0, 0, 8, 8, screen.w, screen.h);
    for (let row = 0; row < Math.min(18, screen.th); row++) {
      for (let col = 0; col < Math.min(20, screen.tw); col++) {
        quad.setViewport(col * 8, row * 8, 8, 8);
        GbcPalette.with(this.cellPalette(col, row), () => G.draw(screen, quad, col * 8, row * 8));
      }
    }
  }

  // Lua: TitleState.lua:334 -- tile the cloud strip so the scroll lines up with the
  // 160px frame. The Lua draws the strip at x = start, start + 160, ... with
  // start = -scroll; on the Gold screen that is the band's cells rotated by
  // whole tiles plus the remainder in a per-line SCX over the band's lines.
  drawCloudSpan(_x0: number, _x1: number, top: number): void {
    const [, clouds] = this.art();
    if (!clouds) return;
    const lcd = currentLcd();
    if (!lcd) return;
    const s = this.cloudScroll % 160;
    const coarse = Math.floor(s / 8);
    const fine = s % 8;
    const band0 = Math.floor(top / 8);
    const cols = Math.min(20, clouds.tw);
    for (let r = 0; r < clouds.th; r++) {
      const screenRow = band0 + r;
      if (screenRow < 0 || screenRow > 31) continue;
      // 21 cells: the fine scroll brings the 21st into view.
      for (let c = 0; c <= 20; c++) {
        const src = (c + coarse) % cols;
        const slot = this.slotOf(lcd, this.screenPalMap?.[screenRow * 20 + src], G.palette);
        lcd.cell(c, screenRow, clouds.ids[r * clouds.tw + src]!, slot);
      }
    }
    // Per-line SCX: the band scrolls, everything else holds still.
    const lines: number[] = [];
    for (let ly = 0; ly < 144; ly++) lines[ly] = ly >= band0 * 8 && ly < (band0 + clouds.th) * 8 ? fine : 0;
    lcd.lines(2, lines);
  }

  // Lua: TitleState.lua:349 -- TitleScreenEntrance's interlace (Crystal): even lines
  // slide in from the left, odd from the right, converging as hSCX walks to 0.
  // NOT FAITHFUL: the screen is cells 0-19 of the BG map, so the per-line SCX
  // that slides it uncovers BG cells 20-31 (holes) where the Lua showed the sky
  // fill; Gold never runs this (title.json has no entrance).
  drawEntranceScreen(screen: LcdImage): void {
    const scx = this.entranceScx;
    this.drawScreen(screen);
    if (scx <= 0) return;
    const lcd = currentLcd();
    if (!lcd) return;
    const lines: number[] = [];
    const count = Math.min(this.entranceLines, screen.h);
    for (let line = 0; line < 144; line++) {
      lines[line] = line < count ? (line % 2 === 0 ? scx : -scx) & 0xff : 0;
    }
    lcd.lines(2, lines);
  }

  // Lua: TitleState.lua:372
  drawContent(): void {
    const [screen, , trail, hoohFrames] = this.art();
    G.setColor(1, 1, 1, 1);

    const gem = this.gray() ? (this.gemGray ?? this.gemColor) : this.gemColor;
    let suicuneFrames: (LcdImage | null)[] | null = null;
    if (this.suicuneColor.length > 0) {
      suicuneFrames = this.gray() && this.suicuneGray.length > 0 ? this.suicuneGray : this.suicuneColor;
    }
    if (gem || suicuneFrames) {
      // Crystal's layering (engine/movie/title.asm:81-85,334).
      const fill = this.gray() ? SKY_GRAY : this.sky;
      G.setColor(fill[0]!, fill[1]!, fill[2]!, 1);
      G.rectangle("fill", 0, 0, 160, 144);
      G.setColor(1, 1, 1, 1);
      if (gem) {
        G.push();
        G.objects = true;
        G.draw(gem, this.gemX, this.gemY);
        G.pop();
      }
      if (suicuneFrames) {
        const frame = suicuneFrames[this.suicuneFrame - 1] ?? suicuneFrames[0];
        if (frame) G.draw(frame, this.suicuneX, this.suicuneY);
      }
      if (this.entranceScx <= 0) {
        // The pal-7 window line covers the BG once hWY lands at $88.
        const bandTop = this.entranceHideBelow ?? 136;
        const band = this.bandColor;
        G.setColor(band[0]!, band[1]!, band[2]!, 1);
        G.rectangle("fill", 0, bandTop, 160, 144 - bandTop);
        G.setColor(1, 1, 1, 1);
      }
      if (screen) this.drawEntranceScreen(screen);
      return;
    }

    if (screen) {
      // title_screen already carries the cart's (c) GAME FREAK line on row 17.
      this.drawScreen(screen);
    } else {
      G.rectangle("fill", 0, 0, 160, 144);
    }

    // Center cloud scroll.
    this.drawCloudSpan(0, 160, this.cloudY);

    // Ho-Oh and the trails are OAM: objects on or off the 8px grid.
    G.push();
    G.objects = true;
    const bob = this.hoohBob();
    const hooh = hoohFrames[this.frame - 1] ?? hoohFrames[0];
    if (hooh) GbcPalette.with(this.hoohPalette, () => G.draw(hooh, this.hoohX, this.hoohY + bob));
    if (trail) {
      GbcPalette.with(this.trailPalette, () => {
        for (const t of this.trails) G.draw(trail, t.x, t.drawY ?? t.y);
      });
    }
    G.pop();
  }

  // Lua: TitleState.lua:438
  draw(): void {
    this.drawContent();
  }

  // Lua: TitleState.lua:443 -- the Gold screen is the panel (scale 1, origin 0), so
  // the window-wide sky and cloud wrap are the panel's own and only the trail
  // limit carries over.
  drawWidescreen(winW: number, _winH: number): void {
    this.trailMaxX = Math.ceil(winW) + 16;
    this.drawContent();
  }
}

export default TitleState;
