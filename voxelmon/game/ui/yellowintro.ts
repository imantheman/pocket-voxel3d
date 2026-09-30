// Pokémon Yellow's attract movie: PlayIntroScene (pokeyellow
// engine/movie/intro_yellow.asm) by way of gen1recomp src/ui/YellowIntro.lua,
// which is where the tables below and their comments come from.
//
// Pikachu runs three times, kicks, surfs, flies over the clouds and the
// Boulder Badge, then fills the screen and throws a thunderbolt. Eighteen
// scenes on 128/88-frame timers, an animated-object system for the sprites,
// and rBGP pokes for the strobes and the fade.
//
// The Game Boy builds each scene out of 8x8 tiles in a 32x32 BG map and OAM.
// Here the importer lays each scene's BG map out once as a picture (the
// `bg*` builders below, stage import/intro.ts) and each OAM frame as a
// picture too (`FRAMES`), so the movie is nothing but pictures moving: the
// BG map picture at -SCX, wrapped every 256 px exactly as the map wraps, and
// one picture per object. The BGP effects are their own pictures, in the
// shades those BGP values show (the `_k` and `_s1`/`_s2` keys).
//
// Where it differs: scene 7's per-scanline SCY sine (the sea rolls line by
// line) is one sine bob of the whole sea, since a picture cannot be bent;
// and the CGB OBJ palette pokes of scenes 7/11, which the reference drops
// too.
//
// No Bun and no host here: the importer and the guest both load this file.

// --- the objects (data/sprite_anims/intro_oam.asm, intro_frames.asm) --------

/** One OAM entry: y and x offsets from the object, tile delta, x-flip. */
type Oam = readonly [number, number, number, boolean?];

function grid(rows: number, cols: number, dy0: number, dx0: number, tile: (r: number, c: number) => number): Oam[] {
  const out: Oam[] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) out.push([dy0 + r * 8, dx0 + c * 8, tile(r, c)]);
  return out;
}

const OAM = {
  // Unkn_fa17e: 2x2, tiles +0/+1 over +$10/+$11
  fa17e: grid(2, 2, -8, -8, (r, c) => r * 0x10 + c),
  // Unkn_fa18f: 16x32; the bottom two rows mirror their left half
  fa18f: [
    [-16, -8, 0x00], [-16, 0, 0x01], [-8, -8, 0x10], [-8, 0, 0x11],
    [0, -8, 0x20], [0, 0, 0x20, true], [8, -8, 0x21], [8, 0, 0x21, true],
  ] as Oam[],
  // Unkn_fa1b0: 32x40 (16-wide head rows, 32-wide mirrored body rows)
  fa1b0: [
    [-24, -8, 0x00], [-24, 0, 0x01], [-16, -8, 0x02], [-16, 0, 0x03],
    [-8, -16, 0x04], [-8, -8, 0x05], [-8, 0, 0x06], [-8, 8, 0x04, true],
    [0, -16, 0x07], [0, -8, 0x08], [0, 0, 0x08, true], [0, 8, 0x07, true],
    [8, -16, 0x09], [8, -8, 0x0a], [8, 0, 0x0a, true], [8, 8, 0x09, true],
    [16, -16, 0x0b], [16, -8, 0x0c], [16, 0, 0x0c, true], [16, 8, 0x0b, true],
  ] as Oam[],
  // Unkn_fa201: 6x6 = 48x48, row r uses tiles +$r0..+$r5
  fa201: grid(6, 6, -24, -24, (r, c) => r * 0x10 + c),
  // Unkn_fa292: 5x5 = 40x40, row bases $00,$05,$10,$15,$20
  fa292: grid(5, 5, -20, -16, (r, c) => [0x00, 0x05, 0x10, 0x15, 0x20][r]! + c),
  // Unkn_fa2f7: 32x8 mirrored streak
  fa2f7: [[-4, -16, 0x00], [-4, -8, 0x01], [-4, 0, 0x01, true], [-4, 8, 0x00, true]] as Oam[],
  // Unkn_fa308: two mirrored 16x16 clusters, 32px apart
  fa308: [
    [-8, -24, 0x00], [-8, -16, 0x01], [0, -24, 0x02], [0, -16, 0x03],
    [-8, 8, 0x01, true], [-8, 16, 0x00, true], [0, 8, 0x03, true], [0, 16, 0x02, true],
  ] as Oam[],
  // Unkn_fa329: two mirrored 24x16 clusters
  fa329: [
    [-8, -40, 0x00], [-8, -32, 0x01], [-8, -24, 0x02],
    [0, -40, 0x10], [0, -32, 0x11], [0, -24, 0x12],
    [-8, 16, 0x02, true], [-8, 24, 0x01, true], [-8, 32, 0x00, true],
    [0, 16, 0x12, true], [0, 24, 0x11, true], [0, 32, 0x10, true],
  ] as Oam[],
};

/** frame id -> its atlas-2 tile base and OAM list (frame $0a is never used). */
export const FRAMES: Record<number, { base: number; oam: Oam[] }> = {
  0x01: { base: 0x96, oam: OAM.fa17e }, 0x02: { base: 0x98, oam: OAM.fa17e }, 0x03: { base: 0x9a, oam: OAM.fa17e },
  0x04: { base: 0x0c, oam: OAM.fa18f }, 0x05: { base: 0x0e, oam: OAM.fa18f }, 0x06: { base: 0x3c, oam: OAM.fa18f },
  0x07: { base: 0x60, oam: OAM.fa1b0 }, 0x08: { base: 0x70, oam: OAM.fa1b0 }, 0x09: { base: 0x80, oam: OAM.fa1b0 },
  0x0b: { base: 0x00, oam: OAM.fa201 }, 0x0c: { base: 0x06, oam: OAM.fa201 },
  0x0d: { base: 0xc6, oam: OAM.fa292 },
  0x0e: { base: 0x6d, oam: OAM.fa2f7 },
  0x0f: { base: 0xf0, oam: OAM.fa308 }, 0x10: { base: 0xf4, oam: OAM.fa308 }, 0x11: { base: 0xf8, oam: OAM.fa308 },
  0x12: { base: 0x9c, oam: OAM.fa329 }, 0x13: { base: 0xec, oam: OAM.fa329 },
};

/** A frame's picture: where its top-left sits from the object, and its size. */
export function frameBox(id: number): { dx: number; dy: number; w: number; h: number } {
  const oam = FRAMES[id]!.oam;
  const dx = Math.min(...oam.map((e) => e[1]));
  const dy = Math.min(...oam.map((e) => e[0]));
  const w = Math.max(...oam.map((e) => e[1])) + 8 - dx;
  const h = Math.max(...oam.map((e) => e[0])) + 8 - dy;
  return { dx, dy, w, h };
}

/** Frame scripts: [frame id, frames] runs; `loop` or hold the last. */
const FRAMESETS: Record<number, { steps: [number, number][]; loop?: boolean }> = {
  1: { steps: [[0x01, 4], [0x02, 4], [0x03, 4]], loop: true },
  2: { steps: [[0x04, 4], [0x05, 4], [0x06, 4]], loop: true },
  3: { steps: [[0x07, 4], [0x08, 4], [0x09, 4]], loop: true },
  5: { steps: [[0x0b, 32]] },
  6: { steps: [[0x0c, 32]] },
  7: { steps: [[0x0d, 32]] },
  8: { steps: [[0x0e, 32]] },
  9: { steps: [[0x0f, 31], [0x11, 2], [0x0f, 2], [0x11, 2], [0x0f, 31], [0x11, 2], [0x0f, 23], [0x10, 32]] },
  10: { steps: [[0x12, 4], [0x13, 4]], loop: true },
};

type Motion = "static" | "surf" | "fly" | "bar";
/** YellowIntro_AnimatedObjectSpawnStateData: frameset and movement. */
const SPAWN: Record<number, [number, Motion]> = {
  1: [1, "static"], 2: [2, "static"], 3: [3, "static"], 5: [5, "surf"], 6: [6, "fly"],
  7: [7, "static"], 8: [8, "bar"], 9: [9, "static"], 10: [10, "static"],
};

/** YellowIntroFlyingSpeedBarData: x, y, speed. */
const SPEED_BARS: [number, number, number][] = [
  [0xd0, 0x20, 2], [0xf0, 0x30, 4], [0xd0, 0x40, 6], [0xc0, 0x50, 8],
  [0xe0, 0x60, 8], [0xc0, 0x70, 6], [0xe0, 0x80, 4], [0xf0, 0x90, 2],
];

/** Scene 6's sine (YellowIntro_Copy8BitSineWave.SineWave). */
const WAVE = [0, 0, 1, 2, 2, 3, 3, 3, 4, 3, 3, 3, 2, 2, 1, 0, 0, 0, -1, -2, -2, -3, -3, -3, -4, -3, -3, -3, -2, -2, -1, 0];

/** Scene 14's strobe (YellowIntroPalSequence_f9dd6) and 16's fade (_f9e0a). */
const STROBE = Array.from({ length: 51 }, (_, i) => (i % 4 === 1 || i % 4 === 2 ? 0xc0 : 0xe4));
const FADE = [0xe4, 0x90, 0x90, 0x40, 0x40, 0x00, 0x00];

/** Func_fa079's bob (sine_table 32, with the true peak the ROM truncates). */
function bob(phase: number): number {
  const a = phase % 64;
  const v = Math.floor(8 * Math.sin((Math.PI * (a % 32)) / 32));
  return a < 32 ? v : -v;
}

// --- the BG maps (what the importer lays out as pictures) -------------------

/** BG map rows the pictures carry: the 18 on screen, plus one for the bob. */
export const BG_ROWS = 20;
type Map32 = number[][];

function fill(id: number): Map32 {
  return Array.from({ length: BG_ROWS }, () => new Array<number>(32).fill(id));
}
function blitMap(m: Map32, col: number, row: number, src: number[][]): void {
  src.forEach((line, r) => line.forEach((id, c) => { m[(row + r) % BG_ROWS]![(col + c) % 32] = id; }));
}
/** Func_f9e5f: rows 0-3 and 14-17 tile $01, the rest $00. */
function letterbox(): Map32 {
  const m = fill(0x00);
  for (const y of [0, 1, 2, 3, 14, 15, 16, 17]) m[y]!.fill(0x01);
  return m;
}

const SKY_MAP = [
  [0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x60, 0x61, 0x62],
  [0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x62, 0x00, 0x00, 0x00],
  [0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x62, 0x00, 0x00, 0x00, 0x00],
  [0x60, 0x61, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x02, 0x62, 0x00, 0x00, 0x00, 0x00, 0x00],
  [0x00, 0x00, 0x63, 0x60, 0x61, 0x60, 0x61, 0x02, 0x02, 0x02, 0x02, 0x60, 0x61, 0x62, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
  [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x63, 0x62, 0x63, 0x62, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
];
const BADGE_MAP = [[0x30, 0x31, 0x32, 0x33], [0x40, 0x41, 0x42, 0x43], [0x50, 0x51, 0x52, 0x53]];
const MARK_MAP = [[0x12, 0x13], [0x22, 0x23]];

/**
 * Each scene's BG map, by picture name. Tile ids below $80 are atlas 1's,
 * the rest atlas 2's (LCDC signed addressing); $60-$63 in `sky*` are the
 * cloud tiles, whose two frames scene 11 flips between.
 */
export const BG_MAPS: Record<string, () => Map32> = {
  letter: letterbox,
  // scene 2: the kick, a 6x6 block at column 20 that SCX brings in
  kick: () => {
    const m = fill(0x00);
    blitMap(m, 20, 6, Array.from({ length: 6 }, (_, r) => Array.from({ length: 6 }, (_, c) => 0x90 + r * 0x10 + c)));
    return m;
  },
  // scene 6: the sea
  sea: () => {
    const m = fill(0x10);
    for (let y = 0; y < 3; y++) m[y]!.fill(0x00);
    m[3] = Array.from({ length: 32 }, (_, x) => (x % 2 === 0 ? 0x20 : 0x21));
    return m;
  },
  // scene 10: the sky, the clouds, the badge and the mark
  sky: () => {
    const m = fill(0x00);
    for (let y = 0; y < 8; y++) m[y]!.fill(0x02);
    blitMap(m, 0, 8, SKY_MAP);
    blitMap(m, 12, 4, BADGE_MAP);
    blitMap(m, 3, 7, MARK_MAP);
    // Columns 20-31 are off the Game Boy's screen and blank in the ROM's
    // map, but ours is wider and shows six either side: carry the cloud
    // line on out -- up one row past the rising edge at column 19 on the
    // right, level with columns 0-1 on the left (the map wraps).
    for (let c = 20; c < 32; c++) {
      const top = c % 2 === 0 ? 0x60 : 0x61;
      if (c < 26) m[7]![c] = top;
      else {
        for (let y = 8; y <= 10; y++) m[y]![c] = 0x02;
        m[11]![c] = top;
      }
    }
    return m;
  },
  // scene 12: the close-up, 12x8 of atlas 1 over the letterbox, and fixups
  close: () => {
    const m = letterbox();
    blitMap(m, 5, 6, Array.from({ length: 8 }, (_, r) => Array.from({ length: 12 }, (_, c) => 0x04 + r * 0x10 + c)));
    m[6]![4] = 0x03;
    m[7]![4] = 0x74;
    m[13]![5] = 0x00;
    return m;
  },
};

/**
 * The pictures the movie needs, by name (gfx key `intro/yi_<name>`): the BG
 * maps (the sky twice, one per cloud frame), each frame, and the BGP states
 * the strobes and the fade show. `shades` maps a GB shade to the one shown.
 */
export interface YellowIntroPicture {
  name: string;
  bg?: string;
  cloud?: number;
  frame?: number;
  shades?: [number, number, number, number];
}

/** rBGP as a shade map: shade i shows (bgp >> 2i) & 3. */
export function bgpShades(bgp: number): [number, number, number, number] {
  return [0, 1, 2, 3].map((i) => (bgp >> (2 * i)) & 3) as [number, number, number, number];
}

const hex = (n: number): string => n.toString(16).padStart(2, "0");
const STROBE_FRAMES = [0x0f, 0x10, 0x11, 0x12, 0x13];

export const YELLOW_INTRO_PICTURES: YellowIntroPicture[] = [
  { name: "bg_letter", bg: "letter" },
  { name: "bg_letter_s1", bg: "letter", shades: bgpShades(0x90) },
  { name: "bg_letter_s2", bg: "letter", shades: bgpShades(0x40) },
  { name: "bg_kick", bg: "kick" },
  { name: "bg_sea", bg: "sea" },
  { name: "bg_sky0", bg: "sky", cloud: 0 },
  { name: "bg_sky1", bg: "sky", cloud: 1 },
  { name: "bg_close", bg: "close" },
  { name: "bg_close_k", bg: "close", shades: bgpShades(0xc0) },
  ...Object.keys(FRAMES).map((k) => ({ name: `obj_${hex(Number(k))}`, frame: Number(k) })),
  { name: "obj_0d_s1", frame: 0x0d, shades: bgpShades(0x90) },
  { name: "obj_0d_s2", frame: 0x0d, shades: bgpShades(0x40) },
  ...STROBE_FRAMES.map((f) => ({ name: `obj_${hex(f)}_k`, frame: f, shades: bgpShades(0xc0) })),
];

/** The pictures PIKACHUS_BEACH colours (PalPacket_PikachusBeach); the rest
 * are MEWMON (PalPacket_Generic). */
const BEACH = new Set(["bg_kick", "bg_sea", "bg_sky0", "bg_sky1", "obj_0b", "obj_0c", "obj_0e"]);
export function yellowIntroPalette(name: string): string {
  return BEACH.has(name) ? "PIKACHUS_BEACH" : "MEWMON";
}

// --- the scenes ---------------------------------------------------------------

interface Obj {
  id: number;
  frameset: number;
  motion: Motion;
  x: number;
  y: number;
  yoff: number;
  step: number;
  wait: number;
  held: boolean;
  fieldB: number;
  fieldC: number;
}

/** One frame of the movie, in GB pixels: the BG picture and the objects. */
export interface YellowIntroFrame {
  /** The BG picture (`bg_*`), drawn at x = -scx wrapping every 256 px, and
   * `dy` down; null = nothing but white (rBGP $00). */
  bg: { name: string; scx: number; dy: number } | null;
  /** The whole screen black (scene 15's rBGP $e7 flip). */
  black: boolean;
  /** Objects back to front: picture name and its top-left. */
  objects: { name: string; x: number; y: number; w: number; h: number }[];
}

/** The frames setup scenes spend with the palettes blanked (#523). */
const SETUP_DELAY = 3;
const HEAD_FRAMES = 2;

/**
 * The scene machine, one call per frame. `done` once scene 17 runs out;
 * the skip is IntroState's (any of A/B/START drops the whole movie).
 */
export class YellowIntroScenes {
  done = false;
  private scene = 0;
  private timer = 0;
  private seq = 0;
  private scx = 0;
  private bgp = 0xe4;
  private bgName = "bg_letter";
  private waveT = 0;
  private cloud = 0;
  private objects: Obj[] = [];
  private delay = HEAD_FRAMES;
  private then: (() => void) | null = () => this.start(0);

  private spawn(id: number, x: number, y: number): Obj {
    const [frameset, motion] = SPAWN[id]!;
    const o: Obj = {
      id, frameset, motion, x, y, yoff: 0, step: 0,
      wait: FRAMESETS[frameset]!.steps[0]![1], held: false, fieldB: 0, fieldC: 0,
    };
    this.objects.push(o);
    return o;
  }

  private setup(scene: number): void {
    this.objects = [];
    this.bgp = 0x00;
    this.delay = SETUP_DELAY;
    this.then = () => {
      this.bgp = 0xe4;
      this.start(scene);
    };
  }

  private start(scene: number): void {
    this.scx = 0;
    switch (scene) {
      case 0: // running pika 1 over the boot letterbox
        this.bgName = "bg_letter";
        this.spawn(1, 0x58, 0x58);
        this.timer = 130;
        this.scene = 1;
        break;
      case 2: // the kick, scrolled in, and eight speed bars
        this.bgName = "bg_kick";
        for (const [x, y, speed] of SPEED_BARS) this.spawn(8, x, y).fieldB = speed;
        this.timer = 128;
        this.scene = 3;
        break;
      case 4: // running pika 2
        this.bgName = "bg_letter";
        this.spawn(2, 0x58, 0x58);
        this.timer = 128;
        this.scene = 5;
        break;
      case 6: // surfing over the rolling sea
        this.bgName = "bg_sea";
        this.waveT = 0;
        this.spawn(5, 0xf8, 0x40);
        this.timer = 88;
        this.scene = 7;
        break;
      case 8: // running pika 3
        this.bgName = "bg_letter";
        this.spawn(3, 0x58, 0x58);
        this.timer = 128;
        this.scene = 9;
        break;
      case 10: // flying over the clouds, the badge and the mark
        this.bgName = "bg_sky0";
        this.cloud = 0;
        this.spawn(6, 0x58, 0x98);
        this.timer = 128;
        this.scene = 11;
        break;
      case 12: // the close-up
        this.bgName = "bg_close";
        this.spawn(9, 0x58, 0x60);
        this.timer = 128;
        this.scene = 13;
        break;
      default:
        this.scene = scene;
    }
  }

  update(): void {
    if (this.done) return;
    if (this.delay > 0) {
      // the DelayFrames a handler spends inside one .loop pass
      if (--this.delay === 0) {
        const then = this.then;
        this.then = null;
        then?.();
      }
      this.updateObjects();
      return;
    }
    switch (this.scene) {
      case 1: case 5: case 9: case 13:
        if (this.timer > 0) this.timer--;
        else if (this.scene === 13) {
          // the thunderbolt over the close-up; the strobe reuses the timer
          this.spawn(10, 0x58, 0x68);
          this.seq = 0;
          this.scene = 14;
        } else this.setup(this.scene + 1);
        break;
      case 3:
        if (this.timer > 0) {
          this.timer--;
          if (this.scx !== 0x68) this.scx += 4;
        } else this.setup(4);
        break;
      case 7:
        if (this.timer > 0) {
          this.timer--;
          this.scx = (this.scx + 2) % 256;
          this.waveT++;
        } else this.setup(8);
        break;
      case 11:
        if (this.timer > 0) {
          // the cloud tiles swap every 8 frames
          if (this.timer % 8 === 0) this.cloud = Math.floor(this.timer / 8) % 2;
          this.bgName = `bg_sky${this.cloud}`;
          this.timer--;
        } else this.setup(12);
        break;
      case 14: {
        const v = STROBE[this.seq++];
        if (v !== undefined) this.bgp = v;
        else {
          // everything goes, the letterbox returns, and three frames on the
          // logo object comes up over it
          this.objects = [];
          this.bgName = "bg_letter";
          this.delay = 3;
          this.then = () => {
            this.bgp = 0xe4;
            this.spawn(7, 0x58, 0x58);
            this.timer = 40;
            this.scene = 15;
          };
        }
        break;
      }
      case 15:
        if (this.timer > 0) {
          if (this.timer % 4 === 0) this.bgp = this.bgp === 0xe4 ? 0xe7 : 0xe4;
          this.timer--;
        } else {
          this.bgp = 0xe4;
          this.seq = 0;
          this.scene = 16;
        }
        break;
      case 16: {
        const v = FADE[this.seq++];
        if (v !== undefined) this.bgp = v;
        else {
          this.timer = 64;
          this.scene = 17;
        }
        break;
      }
      case 17:
        if (this.timer > 0) this.timer--;
        else this.done = true;
        break;
    }
    this.updateObjects();
  }

  private updateObjects(): void {
    for (const o of this.objects) {
      if (o.motion === "bar") {
        o.x = (o.x + o.fieldB) % 256; // Func_fa062
      } else if (o.motion === "surf") {
        // Func_fa014, with the original's Y = X + 1 quirk: the diagonal
        if (o.x !== 0x58) {
          o.x = (o.x + 4) % 256;
          o.y = (o.x + 1) % 256;
        }
      } else if (o.motion === "fly") {
        // Func_fa02b: up 2px a frame to $58, then the bob
        if (o.fieldB === 0) {
          if (o.y !== 0x58) o.y = (o.y - 2 + 256) % 256;
          else o.fieldB = 1;
        }
        if (o.fieldB === 1) o.yoff = bob(o.fieldC++);
      }
      if (o.held) continue;
      if (--o.wait > 0) continue;
      const set = FRAMESETS[o.frameset]!;
      if (o.step >= set.steps.length - 1) {
        if (set.loop) {
          o.step = 0;
          o.wait = set.steps[0]![1];
        } else o.held = true;
        continue;
      }
      o.step++;
      o.wait = set.steps[o.step]![1];
    }
  }

  frame(): YellowIntroFrame {
    const bgp = this.bgp;
    const suffix = bgp === 0x90 ? "_s1" : bgp === 0x40 ? "_s2" : bgp === 0xc0 ? "_k" : "";
    const white = bgp === 0x00;
    let bg: YellowIntroFrame["bg"] = null;
    if (!white) {
      const name = suffix && `${this.bgName}${suffix}` in NAMED ? `${this.bgName}${suffix}` : this.bgName;
      const dy = this.bgName === "bg_sea" ? WAVE[this.waveT % 32]! : 0;
      bg = { name, scx: this.scx, dy };
    }
    const objects: YellowIntroFrame["objects"] = [];
    if (!white) {
      for (const o of this.objects) {
        const id = FRAMESETS[o.frameset]!.steps[o.step]![0];
        const box = frameBox(id);
        const base = `obj_${hex(id)}`;
        const name = suffix && `${base}${suffix}` in NAMED ? `${base}${suffix}` : base;
        // OAM space to screen: (X + dx - 8, Y + dy - 16), in a 256 wrap
        let x = (o.x + box.dx - 8 + 512) % 256;
        let y = (o.y + o.yoff + box.dy - 16 + 512) % 256;
        if (x > 160) x -= 256;
        if (y > 144) y -= 256;
        if (x >= 160 || x + box.w <= 0 || y >= 144 || y + box.h <= 0) continue;
        objects.push({ name, x, y, w: box.w, h: box.h });
      }
    }
    return { bg, black: bgp === 0xe7, objects };
  }
}

const NAMED: Record<string, true> = Object.fromEntries(YELLOW_INTRO_PICTURES.map((p) => [p.name, true]));
