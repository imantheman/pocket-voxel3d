// gen1recomp src/ui/gen2/BattleTransition.lua (bdfac727, MIT):
// DoBattleTransition (engine/battle/battle_transition.asm), the wipe that
// takes the overworld off screen before a battle starts.
//
// The cart drives it from a jumptable of 33 slots, four consecutive runs
// through the same five steps with a different outro at the end:
// LoadPokeBallGraphics (trainer battles only), SetUpBGMap, Flash x3, NextScene,
// SetUpFor<outro> + the outro, picked by two bits
// (StartTrainerBattle_DetermineWhichAnimation):
//
//                    | player's lead + 3 >= enemy | enemy stronger
//   CAVE/DUNGEON/5   | SineWave (a growing wobble)| ZoomToBlack
//   anywhere else    | SpinToBlack               | SpeckleToBlack
//
// The cart's own bug is kept: the level test reads wEnemyMonLevel BEFORE the
// enemy mon is loaded (engine/battle/battle_transition.asm:164).
//
// On the Gold screen the wipe is cells over the 3D world: the Poke Ball and
// every blackened tile are cells, everything else is a hole the world shows
// through. The two effects that act on the MAP itself -- the rBGP flash and
// the sine-wave scanline shift -- act on the voxel world here, which the Gold
// screen cannot recolour or scroll; see the NOT FAITHFUL notes in the draw
// code. The state exposes them (flashPal / flashByte / lyOverrides) for the
// world view.

import { Chrome } from "./Chrome.ts";
import { GbcPalette } from "../shared/render/GbcPalette.ts";
import { Palettes } from "../world/Palettes.ts";
import { Runtime } from "../shared/mods/Runtime.ts";
import { SpriteAnims } from "./SpriteAnims.ts";
import { Tilt } from "../shared/render/Tilt.ts";
import G from "../platform/screen.ts";
import { LCD_H, LCD_W } from "../platform/lcd.ts";
import { random as luaRandom } from "../platform/rng.ts";

// SCREEN_WIDTH x SCREEN_HEIGHT, in tiles. Lua: BattleTransition.lua:39
const COLS = 20;
const ROWS = 18;

type Pal = readonly [number, number, number, number];
type Step = readonly [string, string, number, number];
type Box = readonly [number, number, number, number];
type Black = Record<number, boolean>;

// `.PokeBallTransition`, 16 bigdw rows of 16 bits, stamped from hlcoord 2, 1.
// Lua: BattleTransition.lua:126
const POKEBALL_ROWS = [
  "......XXXX......",
  "....XXXXXXXX....",
  "..XXXX....XXXX..",
  "..XX........XX..",
  ".XX..........XX.",
  ".XX...XXXX...XX.",
  "XX...XX..XX...XX",
  "XXXXXX....XXXXXX",
  "XXXXXX....XXXXXX",
  "XX...XX..XX...XX",
  ".XX...XXXX...XX.",
  ".XX..........XX.",
  "..XX........XX..",
  "..XXXX....XXXX..",
  "....XXXXXXXX....",
  "......XXXX......",
];

// ../pokecrystal/engine/battle/battle_transition.asm:151
// Lua: BattleTransition.lua:163
const SQUARE_TILE = ["33333333", "30000003", "31000013", "31100113", "31122113", "31222213", "32222223", "33333333"];

// Each wedge is a run-length walk away from its own corner. A -1 in the shift
// slot ends the wedge. Lua: BattleTransition.lua:190
const WEDGES: Record<string, number[]> = {
  wedge1: [2, 3, 5, 4, 9, -1],
  wedge2: [1, 1, 2, 2, 4, 2, 4, 2, 3, -1],
  wedge3: [2, 1, 3, 1, 4, 1, 4, 1, 4, 1, 3, 1, 2, 1, 1, 1, 1, -1],
  wedge4: [4, 1, 4, 0, 3, 1, 3, 0, 2, 1, 2, 0, 1, -1],
  wedge5: [4, 0, 3, 0, 3, 0, 2, 0, 2, 0, 1, 0, 1, 0, 1, -1],
};

const FLASH_PALS: Pal[] = [
  [3, 3, 2, 1],
  [3, 3, 3, 2],
  [3, 3, 3, 3],
  [3, 3, 3, 2],
  [3, 3, 2, 1],
  [3, 2, 1, 0],
  [2, 1, 0, 0],
  [1, 0, 0, 0],
  [0, 0, 0, 0],
  [1, 0, 0, 0],
  [2, 1, 0, 0],
  [3, 2, 1, 0],
];
const FLASH_HOLD = 2;
const FLASH_CYCLES = 3;

// The default of the transition.style hook. Lua: BattleTransition.lua:387
function vanillaStyle(ctx: any): string {
  return ctx.style ?? BattleTransition.pick(ctx);
}

// ../pokecrystal/engine/battle/battle_transition.asm:272-275
// Lua: BattleTransition.lua:399
function darknessFor(world: any): boolean {
  if (!world) return false;
  if (world.daytime) return world.daytime === "DARK";
  const def = world.map && world.map.def;
  const hour = world.hour ? world.hour() : undefined;
  return Palettes.isDarkness(def, hour, world.flashUsed) ? true : false;
}

/** Tilt is desktop-only and inert here; never active. */
function tiltActive(): boolean {
  return !!(Tilt.active && Tilt.active());
}

export class BattleTransition {
  [key: string]: any;

  static isOpaque = false;

  // StartTrainerBattle_Flash's `.pals`: one packed rBGP per entry, colour 3
  // first. Lua: BattleTransition.lua:60
  static FLASH_PALS = FLASH_PALS;
  // Each palette is held for two frames. Lua: BattleTransition.lua:76
  static FLASH_HOLD = FLASH_HOLD;
  static FLASH_CYCLES = FLASH_CYCLES;
  // ../pokecrystal/engine/battle/battle_transition.asm:266-311
  static FLASH_SLOT_FRAMES = FLASH_PALS.length * FLASH_HOLD + 1;
  static FLASH_FRAMES = (FLASH_PALS.length * FLASH_HOLD + 1) * FLASH_CYCLES;

  // Lua: BattleTransition.lua:109-114
  static TRAINER_PAL = [
    [255, 148, 239],
    [255, 90, 123],
    [255, 41, 41],
    [58, 58, 58],
  ];
  static TRAINER_PAL_DARK = [
    [255, 148, 239],
    [255, 41, 41],
    [255, 41, 41],
    [255, 41, 41],
  ];
  // ../pokecrystal/engine/battle/battle_transition.asm:689-701
  static get RAMPED_OBJ(): Record<number, boolean> {
    return { [Palettes.OW_PALETTE_ID.PAL_OW_TREE]: true, [Palettes.OW_PALETTE_ID.PAL_OW_ROCK]: true };
  }
  static POKEBALL_X = 2;
  static POKEBALL_Y = 1;

  // `.spin_quadrants`. Lua: BattleTransition.lua:200
  static SPIN_STEPS: Step[] = [
    ["UPPER_LEFT", "wedge1", 1, 6],
    ["UPPER_LEFT", "wedge2", 0, 3],
    ["UPPER_LEFT", "wedge3", 1, 0],
    ["UPPER_LEFT", "wedge4", 5, 0],
    ["UPPER_LEFT", "wedge5", 9, 0],
    ["UPPER_RIGHT", "wedge5", 10, 0],
    ["UPPER_RIGHT", "wedge4", 14, 0],
    ["UPPER_RIGHT", "wedge3", 18, 0],
    ["UPPER_RIGHT", "wedge2", 19, 3],
    ["UPPER_RIGHT", "wedge1", 18, 6],
    ["LOWER_RIGHT", "wedge1", 18, 11],
    ["LOWER_RIGHT", "wedge2", 19, 14],
    ["LOWER_RIGHT", "wedge3", 18, 17],
    ["LOWER_RIGHT", "wedge4", 14, 17],
    ["LOWER_RIGHT", "wedge5", 10, 17],
    ["LOWER_LEFT", "wedge5", 9, 17],
    ["LOWER_LEFT", "wedge4", 5, 17],
    ["LOWER_LEFT", "wedge3", 1, 17],
    ["LOWER_LEFT", "wedge2", 0, 14],
    ["LOWER_LEFT", "wedge1", 1, 11],
  ];
  // ../pokecrystal/engine/battle/battle_transition.asm:381-402
  static SPIN_HOLD = 3;

  // `.boxes`: width, height, top row, left column. Lua: BattleTransition.lua:265
  static ZOOM_BOXES: Box[] = [
    [4, 2, 8, 8],
    [6, 4, 7, 7],
    [8, 6, 6, 6],
    [10, 8, 5, 5],
    [12, 10, 4, 4],
    [14, 12, 3, 3],
    [16, 14, 2, 2],
    [18, 16, 1, 1],
    [20, 18, 0, 0],
  ];
  // ../pokecrystal/home/tilemap.asm:3-10
  static ZOOM_HOLD = 4;
  // ../pokecrystal/engine/battle/battle_transition.asm:29-32
  static OUTRO_LEAD: Record<string, number> = { spin: 2, speckle: 2, sine: 2, zoom: 1 };
  // ../pokecrystal/engine/battle/battle_transition.asm:395-402
  static END_HOLD: Record<string, number> = { spin: 4, speckle: 4, sine: 1, zoom: 1 };

  static SPECKLE_PASSES = 0x10;
  static SPECKLE_PER_PASS = 12;
  static SINE_LIMIT = 0x60;
  static CAVE_ENVIRONMENTS: Record<string, boolean> = { CAVE: true, ENVIRONMENT_5: true, DUNGEON: true };
  static STYLES: Record<string, boolean> = { spin: true, speckle: true, zoom: true, sine: true };
  static BLACK_HOLD = 16;
  static TINT_ALPHA = 0.55;

  // One .pals row as the rBGP byte the cart writes. Lua: BattleTransition.lua:82
  static flashByte(pal: Pal): number {
    return pal[0] * 64 + pal[1] * 16 + pal[2] * 4 + pal[3];
  }

  // Signed veil for one palette row: +1 black, -1 white, 0 untouched.
  // Lua: BattleTransition.lua:92
  static flashVeil(pal: Pal): number {
    let sum = 0;
    for (const shade of pal) sum += shade;
    return (sum - 6) / 6;
  }

  // Lua: BattleTransition.lua:147
  static pokeballCells(): [number, number][] {
    const cells: [number, number][] = [];
    POKEBALL_ROWS.forEach((bits, row) => {
      for (let col = 0; col < bits.length; col++) {
        if (bits[col] === "X") cells.push([BattleTransition.POKEBALL_X + col, BattleTransition.POKEBALL_Y + row]);
      }
    });
    return cells;
  }

  // Lua: BattleTransition.lua:168
  static squareTile(): string[] {
    return SQUARE_TILE;
  }

  // 1-based shades, as the Lua returns them. Lua: BattleTransition.lua:170
  static squareShades(byte?: number | null): number[][] {
    const shades = GbcPalette.bgpShades(byte);
    const out: number[][] = [];
    for (let y = 0; y < 8; y++) {
      out[y] = [];
      for (let x = 0; x < 8; x++) out[y]![x] = shades[Number(SQUARE_TILE[y]![x])]! + 1;
    }
    return out;
  }

  // Walk one wedge, marking cells in `black` (a [y * COLS + x] set).
  // Lua: BattleTransition.lua:230
  static spinStep(black: Black, step: Step): Black {
    const [quadrant, wedgeName] = step;
    let x = step[2];
    let y = step[3];
    const wedge = WEDGES[wedgeName]!;
    const right = quadrant === "UPPER_RIGHT" || quadrant === "LOWER_RIGHT";
    const lower = quadrant === "LOWER_LEFT" || quadrant === "LOWER_RIGHT";
    const dx = right ? 1 : -1;
    const dy = lower ? -1 : 1;
    let i = 0;
    while (i < wedge.length) {
      const count = wedge[i]!;
      i++;
      let cx = x;
      for (let n = 0; n < count; n++) {
        // Clipped rather than run off the end of a row into the next one.
        if (cx >= 0 && cx < COLS && y >= 0 && y < ROWS) black[y * COLS + cx] = true;
        cx += dx;
      }
      y += dy;
      const shift = wedge[i];
      i++;
      if (shift === undefined || shift === -1) return black;
      x = x - dx * shift;
    }
    return black;
  }

  // `zoombox width, height, start y, start x`. Lua: BattleTransition.lua:286
  static zoomStep(black: Black, box: Box): Black {
    const [width, height, y0, x0] = box;
    for (let y = y0; y < Math.min(ROWS, y0 + height); y++) {
      for (let x = x0; x < Math.min(COLS, x0 + width); x++) black[y * COLS + x] = true;
    }
    return black;
  }

  // Sixteen passes of twelve NEW tiles each, with the cart's reject loops.
  // `random(n)` returns 0..n-1. Lua: BattleTransition.lua:305
  static speckleStep(black: Black, random?: ((n: number) => number) | null): Black {
    const roll = random ?? ((n: number) => (luaRandom(n) as number) - 1);
    for (let k = 0; k < BattleTransition.SPECKLE_PER_PASS; k++) {
      let x: number;
      let y: number;
      do y = roll(256);
      while (y >= ROWS);
      do x = roll(256);
      while (x >= COLS);
      let key = y * COLS + x;
      if (black[key]) {
        // `jr z, .y_loop`: a repeat lands on the same pass.
        let tries = 0;
        do {
          do y = roll(256);
          while (y >= ROWS);
          do x = roll(256);
          while (x >= COLS);
          key = y * COLS + x;
          tries++;
        } while (black[key] && tries <= COLS * ROWS);
      }
      black[key] = true;
    }
    return black;
  }

  // The amplitude grows by the frame index every frame; the phase restarts
  // each frame and steps 2 a scanline. Lua: BattleTransition.lua:342
  static sineFrames(): number[][] {
    const frames: number[][] = [];
    let counter = 0;
    let offset = 0;
    while (counter < BattleTransition.SINE_LIMIT) {
      const amplitude = counter;
      counter += offset;
      offset++;
      const row: number[] = [];
      for (let y = 0; y <= 143; y++) {
        // The stored byte is signed; DrawSineWave returns it two's complement.
        const value = SpriteAnims.sine(y * 2, amplitude);
        row[y] = value >= 128 ? value - 256 : value;
      }
      frames.push(row);
    }
    return frames;
  }

  // StartTrainerBattle_DetermineWhichAnimation. Lua: BattleTransition.lua:370
  static pick(opts?: any): string {
    opts = opts ?? {};
    const cave = BattleTransition.CAVE_ENVIRONMENTS[opts.environment] === true;
    const stronger = (opts.playerLevel ?? 1) + 3 < (opts.enemyLevel ?? 1);
    if (cave) return stronger ? "zoom" : "sine";
    return stronger ? "speckle" : "spin";
  }

  // Lua: BattleTransition.lua:395-396
  drawsWidescreen(): boolean {
    return true;
  }
  wantsFillScale(): boolean {
    return true;
  }

  // opts: world, trainer (bool), environment, playerLevel, enemyLevel,
  //       random(n), onDone, style, dark
  // Lua: BattleTransition.lua:409
  static new(game: any, opts?: any): BattleTransition {
    opts = opts ?? {};
    const self = new BattleTransition();
    self.game = game;
    self.world = opts.world ?? (game && game.world);
    self.onDone = opts.onDone;
    self.random = opts.random;
    const ctx = {
      game,
      trainer: !!opts.trainer,
      stronger: (opts.playerLevel ?? 1) + 3 < (opts.enemyLevel ?? 1),
      dungeon: BattleTransition.CAVE_ENVIRONMENTS[opts.environment] === true,
      environment: opts.environment,
      playerLevel: opts.playerLevel,
      enemyLevel: opts.enemyLevel,
      style: opts.style,
    };
    let style = Runtime.call("transition.style", vanillaStyle, ctx);
    // A hook naming an outro that does not exist falls back to the vanilla pick.
    if (!BattleTransition.STYLES[style]) style = vanillaStyle(ctx);
    self.style = style;
    self.trainer = !!opts.trainer;
    // ../pokecrystal/engine/battle/battle_transition.asm:585-587
    self.recolor = self.trainer;
    if (opts.dark != null) self.dark = !!opts.dark;
    else self.dark = darknessFor(self.world);
    self.black = {} as Black;
    self.frame = 0;
    self.step = 0;
    self.sine = undefined;
    self.phase = self.trainer ? "pokeball" : "flash";
    // ../pokecrystal/engine/overworld/map_objects.asm:2191-2205
    self.respawnFilter = (npc: any) => self.keepsOpponent(npc);
    if (self.world) self.world.bgOverlay = (s: number) => self.drawBgLayer(s);
    return self;
  }

  // Lua: BattleTransition.lua:459
  keepsOpponent(npc: any): boolean {
    const world = this.world;
    const vm = world && world.vm;
    if (!(vm && vm.lastTalked)) return false;
    if (!(this.trainer || (vm.running && vm.running()))) return false;
    return (npc && npc.def && (npc.def.index ?? 0) + 1 === vm.lastTalked) || false;
  }

  // Lua: BattleTransition.lua:468
  trainerRamp(): number[][] | undefined {
    if (!this.recolor) return undefined;
    return this.dark ? BattleTransition.TRAINER_PAL_DARK : BattleTransition.TRAINER_PAL;
  }

  // ../pokecrystal/engine/battle/battle_transition.asm:272-275
  // Lua: BattleTransition.lua:475
  flashFrames(): number {
    if (this.dark) return BattleTransition.FLASH_CYCLES;
    return BattleTransition.FLASH_FRAMES;
  }

  // Lua: BattleTransition.lua:480
  beginOutro(): void {
    this.phase = "outro";
    this.frame = 0;
    this.step = 0;
    this.ending = undefined;
    this.captured = false;
    if (this.style === "sine") this.sine = BattleTransition.sineFrames();
  }

  // One logic frame; the state pops itself when the last phase is done.
  // Lua: BattleTransition.lua:494
  update(_dt?: number): void {
    this.frame++;
    if (this.phase === "pokeball") {
      if (this.frame >= 2) {
        this.phase = "flash";
        this.frame = 0;
      }
      return;
    }
    if (this.phase === "flash") {
      if (this.frame >= this.flashFrames()) this.beginOutro();
      return;
    }
    if (this.phase === "outro") {
      this.outroFrame();
      return;
    }
    if (this.phase === "black") {
      if (this.frame >= BattleTransition.BLACK_HOLD) this.finish();
      return;
    }
    this.finish();
  }

  // Lua: BattleTransition.lua:520
  outroFrame(): void {
    const style = this.style;
    this.captured = false;
    const world = this.world;
    if (this.frame >= 1 && world && !world.spriteFilter) world.spriteFilter = this.respawnFilter;
    if (this.ending) {
      this.ending--;
      if (this.ending <= 0) this.blackOut();
      return;
    }
    const at = this.frame - (BattleTransition.OUTRO_LEAD[style] ?? 2);
    if (at < 0) return;
    if (style === "spin") {
      if (at % BattleTransition.SPIN_HOLD !== 0) return;
      this.step++;
      const step = BattleTransition.SPIN_STEPS[this.step - 1];
      if (!step) {
        this.endOutro();
        return;
      }
      BattleTransition.spinStep(this.black, step);
    } else if (style === "zoom") {
      if (at % BattleTransition.ZOOM_HOLD !== 0) return;
      this.step++;
      const box = BattleTransition.ZOOM_BOXES[this.step - 1];
      if (!box) {
        this.endOutro();
        return;
      }
      BattleTransition.zoomStep(this.black, box);
    } else if (style === "speckle") {
      this.step++;
      if (this.step > BattleTransition.SPECKLE_PASSES) {
        this.endOutro();
        return;
      }
      BattleTransition.speckleStep(this.black, this.random);
    } else {
      this.step++;
      if (!(this.sine && this.sine[this.step - 1])) {
        this.endOutro();
        return;
      }
    }
  }

  // Lua: BattleTransition.lua:568
  endOutro(): void {
    const hold = BattleTransition.END_HOLD[this.style] ?? 0;
    if (hold > 0) this.ending = hold;
    else this.blackOut();
  }

  // DoBattleTransition's own `.done`: the screen solid black while the battle
  // screen loads. Lua: BattleTransition.lua:588
  blackOut(): void {
    this.phase = "black";
    this.frame = 0;
  }

  // Lua: BattleTransition.lua:593
  finish(): void {
    if (this.finished) return;
    this.finished = true;
    const world = this.world;
    if (world) {
      if (world.bgOverlay) world.bgOverlay = undefined;
      if (world.spriteFilter === this.respawnFilter) world.spriteFilter = undefined;
      world.peopleHidden = undefined;
    }
    const stack = this.game && this.game.stack;
    if (stack) stack.pop();
    if (this.onDone) this.onDone();
  }

  // The LY overrides this frame, or undefined outside the sine outro.
  // Lua: BattleTransition.lua:610
  lyOverrides(): number[] | undefined {
    if (this.phase !== "outro" || this.style !== "sine") return undefined;
    if (!(this.sine && this.step > 0)) return undefined;
    return this.sine[Math.min(this.step, this.sine.length) - 1];
  }

  // Lua: BattleTransition.lua:621
  blackAt(col: number, row: number): boolean {
    const x = Math.max(0, Math.min(COLS - 1, col));
    const y = Math.max(0, Math.min(ROWS - 1, row));
    return this.black[y * COLS + x] === true;
  }

  // Lua: BattleTransition.lua:627 -- the Gold screen is the playfield.
  draw(): void {
    this.drawWidescreen(LCD_W, LCD_H);
  }

  // The .pals row this frame is holding, or undefined outside the flash.
  // Lua: BattleTransition.lua:633
  flashPal(): Pal | undefined {
    if (this.phase !== "flash" || this.dark) return undefined;
    const slot = this.frame % BattleTransition.FLASH_SLOT_FRAMES;
    const index = Math.min(Math.floor(slot / BattleTransition.FLASH_HOLD), FLASH_PALS.length - 1);
    return FLASH_PALS[index];
  }

  // The map's BG palettes and the time of day's OBJ palettes.
  // Lua: BattleTransition.lua:646
  remapPalettes(): [any, any] | undefined {
    const world = this.world;
    const def = world && world.map && world.map.def;
    if (!(def && world.palettes)) return undefined;
    const bg = Palettes.bgSet(world.palettes, def, world.daytime);
    if (!bg) return undefined;
    return [bg, Palettes.objectSet(world.palettes, world.daytime)];
  }

  // ../pokecrystal/engine/battle/battle_transition.asm:657-683
  // Lua: BattleTransition.lua:656 -- the remap shader re-indexed the baked
  // map canvas; the map is the voxel world here and there is no such pass, so
  // this is always the Lua's "cannot run" answer.
  bindRemap(_byte?: number | null): boolean {
    if (tiltActive()) return false;
    return false;
  }

  // Draw the map through this frame's rBGP byte. Lua: BattleTransition.lua:684
  drawMap(w: number, h: number, byte: number | undefined): boolean {
    const ramp = this.trainerRamp();
    if (!ramp && (byte == null || byte === GbcPalette.BGP_IDENTITY)) {
      // `dc 3, 2, 1, 0`: the picture is simply itself.
      this.drawWorld();
      return true;
    }
    const canvas = this.capture(w, h);
    if (!canvas) return false;
    if (!this.bindRemap(byte)) return false;
    GbcPalette.clear();
    this.overlayDrawn = this.captureLayered;
    return true;
  }

  // Lua: BattleTransition.lua:704 -- the world is the voxel scene; World:draw
  // puts nothing on the Gold screen.
  drawWorld(): boolean {
    this.overlayDrawn = false;
    if (this.world && this.world.draw) this.world.draw();
    return this.overlayDrawn;
  }

  // Lua: BattleTransition.lua:712
  // NOT FAITHFUL: the trainer recolour's tint is a 55% alpha wash over the
  // map; the Gold screen has no alpha and the map is the voxel world, so it is
  // not drawn (an opaque fill would hide the world).
  drawTint(_w: number, _h: number): boolean {
    return false;
  }

  // Lua: BattleTransition.lua:725
  drawWidescreen(w: number, h: number): void {
    const world = this.world;
    const ly = this.lyOverrides();

    if (this.phase === "black") {
      G.setColor(0, 0, 0, 1);
      G.rectangle("fill", 0, 0, w, h);
      G.setColor(1, 1, 1, 1);
      return;
    }

    let pal = this.flashPal();
    const byte = pal ? BattleTransition.flashByte(pal) : undefined;

    this.overlayDrawn = false;
    if (world && world.map) {
      if (ly) {
        this.drawWavy(w, h, ly);
      } else if (this.drawMap(w, h, byte)) {
        pal = undefined;
      } else {
        this.drawWorld();
        this.drawTint(w, h);
      }
    } else {
      G.setColor(0, 0, 0, 1);
      G.rectangle("fill", 0, 0, w, h);
    }

    if (pal) {
      // NOT FAITHFUL: the flash permutes the map's palettes (DmgToCgbBGPals);
      // the map is the voxel world, which the Gold screen cannot recolour, and
      // there is no alpha for the Lua's veil. Only the entries that are one
      // solid shade -- %11111111 black and %00000000 white -- are drawn, as a
      // full-screen fill; the others leave the world as it is.
      const veil = BattleTransition.flashVeil(pal);
      if (Math.abs(veil) >= 1) {
        const shade = veil > 0 ? 0 : 1;
        G.setColor(shade, shade, shade, 1);
        G.rectangle("fill", 0, 0, w, h);
      }
    }

    if (!this.overlayDrawn) this.drawTopLayer(w, h);
    G.setColor(1, 1, 1, 1);
  }

  // The tile grid, anchored on the screen. Lua: BattleTransition.lua:773
  grid(w: number, h: number): [number, number, number] {
    let scale: number;
    if (this.world && this.world.fitScale) scale = this.world.fitScale() ?? 1;
    else scale = Math.max(1, Math.floor(Math.min(w / 160, h / 144)));
    const size = 8 * scale;
    const [ox, oy] = Chrome.fitOrigin();
    return [size, ox, oy];
  }

  // Lua: BattleTransition.lua:786
  drawTopLayer(w: number, h: number): void {
    const [size, ox, oy] = this.grid(w, h);
    this.paintLayer(size, ox, oy, w, h);
  }

  // ../pokecrystal/engine/battle/battle_transition.asm:609-646
  // Lua: BattleTransition.lua:792
  drawBgLayer(s: number): void {
    if (this.finished) return;
    const world = this.world;
    if (!(world && world.gbScreenOrigin)) return;
    const [sox, soy] = world.gbScreenOrigin();
    this.paintLayer(8 * s, sox * s, soy * s, LCD_W, LCD_H);
    this.overlayDrawn = true;
  }

  // Lua: BattleTransition.lua:809 -- the Lua builds the square tile as an
  // image; nothing can be built at run time here (every tile is cooked, and
  // BATTLETRANSITION_SQUARE is not), so this is the Lua's failure answer and
  // paintLayer takes its own fallback: a solid cell in the ramp's colour 4.
  // NOT FAITHFUL: the Poke Ball's squares are solid instead of bevelled.
  ballImage(): undefined {
    return undefined;
  }

  // Lua: BattleTransition.lua:836
  blackColor(): [number, number, number] {
    const ramp = this.trainerRamp();
    if (ramp) {
      const previous = GbcPalette.setBgp(null);
      const c = GbcPalette.color(ramp, 4);
      GbcPalette.setBgp(previous);
      if (c) return [c[0]! / 255, c[1]! / 255, c[2]! / 255];
    }
    return [0, 0, 0];
  }

  // Lua: BattleTransition.lua:847
  paintLayer(size: number, ox: number, oy: number, w: number, h: number): void {
    if (this.trainer) {
      const image = this.ballImage();
      G.setColor(1, 1, 1, 1);
      for (const cell of BattleTransition.pokeballCells()) {
        const x = Math.floor(ox + cell[0] * size);
        const y = Math.floor(oy + cell[1] * size);
        if (image) {
          G.draw(image, x, y);
        } else {
          const [r, g, b] = this.blackColor();
          G.setColor(r, g, b, 1);
          G.rectangle("fill", x, y, size, size);
          G.setColor(1, 1, 1, 1);
        }
      }
    }
    let any = false;
    for (const _k in this.black) {
      any = true;
      break;
    }
    if (!any) return;
    const first = -Math.ceil(ox / size);
    const last = Math.ceil((w - ox) / size);
    const top = -Math.ceil(oy / size);
    const bottom = Math.ceil((h - oy) / size);
    G.setColor(this.blackColor());
    // On the 8px grid a row's run of black cells is one fill: the same
    // cells as a fill each, at a fraction of the calls (the full-screen
    // wipes filled eighty-odd cells one by one every frame). Off the grid
    // each cell keeps its own fill (its ragged edges are objects).
    const grid = size % 8 === 0 && (G.tx + ox) % 8 === 0 && (G.ty + oy) % 8 === 0;
    for (let row = top; row < bottom; row++) {
      for (let col = first; col < last; col++) {
        if (!this.blackAt(col, row)) continue;
        let end = col + 1;
        if (grid) while (end < last && this.blackAt(end, row)) end++;
        G.rectangle("fill", ox + col * size, oy + row * size, size * (end - col), size);
        col = end - 1;
      }
    }
    G.setColor(1, 1, 1, 1);
  }

  // Lua: BattleTransition.lua:884
  // NOT FAITHFUL: the sine outro shifts the MAP's scanlines (rSCX through the
  // LY overrides). The map is the voxel world, which the Gold screen's
  // per-line scroll does not reach, so the world stands still under the wave;
  // lyOverrides() holds this frame's values for the world view. The Lua's
  // capture also hides the people (battle_transition.asm:320-321) and draws
  // them back unshifted, which leaves them exactly where they were.
  drawWavy(_w: number, _h: number, _ly: number[]): void {
    this.drawWorld();
  }

  // Lua: BattleTransition.lua:936 -- there are no canvases to capture into.
  capture(_w: number, _h: number): undefined {
    return undefined;
  }
}

export default BattleTransition;
