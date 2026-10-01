// The credits roll: a port of gen1recomp src/ui/gen2/Credits.lua (bdfac727,
// MIT) -- pokegold engine/movie/credits.asm, the cart's own machinery driven by
// a scene script.
//
// THE MACHINERY. Credits is a 13-entry jumptable stepped once per frame:
//
//   0      ParseCredits              read the script, if the timer is out
//   5      Credits_UpdateGFXRequestPath  advance the banner's animation frame
//   7      Credits_LYOverride        slide the two border strips 2px
//   12     Credits_LoopBack          index &= $f0, back to 0
//   (the rest idle)
//
// so ONE pass is 13 frames, and every `db CREDITS_WAIT, 12` is 12 passes --
// 156 frames.
//
// THE TILEMAP IS PUSHED ONLY BY `.wait`. ParseCredits blanks rows 5-12 and
// writes the next group's strings, but nothing reaches VRAM until the `.wait`
// arm sets hBGMapMode. `pending` and `shown` are that hBGMapMode.
//
// <NEXT> IS TWO ROWS: the four lines of a group land on rows 6, 8, 10 and 12.
//
// THE BANNER is four 4x4-tile mon graphics repeated five times across rows 0-3
// and 14-17, with a scrolling strip of border tiles on rows 4 and 13.
//
// THE GRAPHICS come out of the importer as `data.gen2Credits` (credits.json:
// the border strip, the four Credits<Mon>GFX sheets, TheEndGFX and
// CreditsPalettes).
//
// THE TEXT IS BRIAN'S: his port replaces GAME FREAK's staff roll with its own,
// and that roll is kept verbatim here (faithful first). The command
// vocabulary, the waits, the scene changes and the copyright/THE END tail are
// the cart's.

import { Chrome } from "./Chrome.ts";
import { Font } from "../shared/render/Font.ts";
import { GameVersion } from "../shared/core/GameVersion.ts";
import { GbcPalette } from "../shared/render/GbcPalette.ts";
import { Logger } from "../shared/core/Logger.ts";
import { Music } from "../shared/core/Music.ts";
import { Assets } from "../shared/render/Assets.ts";
import G, { currentLcd, type LcdImage, type Quad } from "../platform/screen.ts";
import { LCD_H, type Palette4 } from "../platform/lcd.ts";
import { tostring } from "../platform/lua.ts";

type Colors = readonly (readonly number[])[];

const SCREEN_W = 160;
const SCREEN_H = 144;
const TILES_W = 20;

// constants/ram_constants.asm / engine/movie/credits.asm.
const ALLOW_SKIPPING_CREDITS_F = 6;
const JUMPTABLE_EXIT_F = 7;

// Lua: Credits.lua:87 -- the jumptable slots that do something.
const STEP_PARSE = 0;
const STEP_GFX = 5;
const STEP_LY = 7;

// Lua: Credits.lua:93 -- ConstructCreditsTilemap's rows.
const BANNER_TILES = 4; // a mon graphic is 4x4 tiles
const BANNER_REPEATS = 5; // .InitTopPortion's `ld b, 5`
const TEXT_TOP_ROW = 5; // ParseCredits clears from hlcoord 0, 5
const TEXT_FIRST_ROW = 6; // .print's hlcoord 0, 6
const LINE_SPACING = 2; // `ld bc, SCREEN_WIDTH * 2`

// Lua: Credits.lua:100 -- Credits_TheEnd: tiles $40.. at hlcoord 6, 8 and 6, 9.
const THEEND_X = 6;
const THEEND_W = 8;

interface Layout {
  bannerRows: number[];
  borderRows: number[];
  textRows: number;
  theEndY: number;
  lyStep: number;
}

// Lua: Credits.lua:103 -- ../pokecrystal/engine/movie/credits.asm:400-451
const LAYOUT: Record<string, Layout> = {
  gs: { bannerRows: [0, 14], borderRows: [4, 13], textRows: 8, theEndY: 8, lyStep: 2 },
  crystal: { bannerRows: [0], borderRows: [4, 17], textRows: 12, theEndY: 9, lyStep: -2 },
};

// Lua: Credits.lua:110
function isCrystal(): boolean {
  return GameVersion.engine() === "crystal";
}

// Lua: Credits.lua:114
function layout(): Layout {
  return isCrystal() ? LAYOUT.crystal! : LAYOUT.gs!;
}

// Lua: Credits.lua:120 -- Credits_HandleBButton: the fast-forward only
// unlocks once wCreditsPos has passed $d.
const SKIP_AFTER_POS = 0xd;

const CREDITS_MUSIC = "Music_Credits";
const POST_CREDITS_MUSIC = "Music_PostCredits";
// `.end`: `ld a, 32 / ld [wMusicFade], a`.
const POST_CREDITS_FADE = 32;

// Lua: Credits.lua:135 -- RGB555 scaled the way the importer scales it.
function scale5(value: number): number {
  return Math.floor((value * 255) / 31 + 0.5);
}

// Lua: Credits.lua:137
function pal555(...args: number[]): number[][] {
  const out: number[][] = [];
  for (let index = 0; index < 4; index++) {
    const base = index * 3;
    out.push([scale5(args[base]!), scale5(args[base + 1]!), scale5(args[base + 2]!)]);
  }
  return out;
}

// Lua: Credits.lua:173 -- Credits_LoadBorderGFX's .Frames.
const BORDER_FRAMES: Record<number, number[]> = {
  0: [1, 2, 1, 3], // Bellossom
  1: [1, 2, 1, 3], // Togepi
  2: [1, 2, 1, 3], // Elekid
  3: [1, 2, 3, 4], // Sentret
};

// Lua: Credits.lua:181 -- ../pokecrystal/engine/movie/credits.asm:572-591
const BORDER_FRAMES_CRYSTAL: Record<number, number[]> = {
  0: [1, 2, 3, 4], 1: [1, 2, 3, 4], 2: [1, 2, 3, 4], 3: [1, 2, 3, 4],
};

// ---------------------------------------------------------------------------
// The strings (Lua: Credits.lua:207) -- data/credits_strings.asm's shape: one
// table of fixed strings, each padded with leading spaces to sit where it
// should on a 20-tile row, indexed by id. A function value is resolved on
// read (the per-edition STAFF lines).

type CreditString = string | string[] | (() => string | string[]);
const RAW_STRINGS: Record<number, CreditString> = {};
const STRINGS: Record<number, string | string[] | undefined> = new Proxy({} as Record<number, string | string[] | undefined>, {
  get(_t, key) {
    const value = RAW_STRINGS[Number(key)];
    if (typeof value === "function") return value();
    return value;
  },
  set(_t, key, value) {
    RAW_STRINGS[Number(key)] = value;
    return true;
  },
});
const ID: Record<string, number> = {};
let nextId = 0;

// Lua: Credits.lua:219
function defineString(name: string, text: CreditString): number {
  ID[name] = nextId;
  RAW_STRINGS[nextId] = text;
  nextId = nextId + 1;
  return ID[name]!;
}

// Lua: Credits.lua:227 -- the people first.
defineString("BRYANTHABOI", "    BRYANTHABOI");
defineString("BOIS_CLUB", "  BOIS CLUB GAMES");
defineString("THE_BOIS_CLUB", "   THE BOIS CLUB");
defineString("PRET_POKEGOLD", "   PRET POKEGOLD");
defineString("PRET_PROJECT", "  THE PRET PROJECT");
defineString("LOVE2D", "       LOVE2D");
defineString("LUAJIT", "       LUAJIT");
defineString("CHIP_SYNTH", "     CHIP SYNTH");
defineString("EVERY_TESTER", "    EVERY TESTER");
defineString("AND_YOU", "      AND YOU");
defineString("CREDIT_END", "END");

// Lua: Credits.lua:244 -- ../pokecrystal/data/credits_strings.asm:183-185
const STAFF_LINES: Record<string, string[]> = {
  gold: ["      #MON", "    GOLD VERSION", "     PORT STAFF"],
  silver: ["      #MON", "   SILVER VERSION", "     PORT STAFF"],
  crystal: ["      #MON", "  CRYSTAL VERSION", "     PORT STAFF"],
};

// Lua: Credits.lua:262 -- STAFF and everything after it is a heading.
const STAFF = defineString("STAFF", () => STAFF_LINES[GameVersion.get()] ?? STAFF_LINES.gold!);
defineString("DIRECTOR", "      DIRECTOR");
defineString("PROGRAMMING", "    PROGRAMMING");
defineString("ENGINE_DESIGN", "   ENGINE DESIGN");
defineString("BATTLE_ENGINE", "   BATTLE ENGINE");
defineString("SCRIPT_ENGINE", "   SCRIPT ENGINE");
defineString("WORLD_ENGINE", "    WORLD ENGINE");
defineString("AUDIO_ENGINE", "    AUDIO ENGINE");
defineString("GRAPHICS", "      GRAPHICS");
defineString("USER_INTERFACE", "   USER INTERFACE");
defineString("ROM_IMPORTER", "    ROM IMPORTER");
defineString("SAVE_EDITOR", "    SAVE EDITOR");
defineString("MOD_SDK", "      MOD SDK");
defineString("TOOLS", "       TOOLS");
defineString("TESTING", "      TESTING");
defineString("BUILT_WITH", "     BUILT WITH");
defineString("BASED_ON", "      BASED ON");
defineString("SPECIAL_THANKS", "   SPECIAL THANKS");
defineString("PRODUCER", "      PRODUCER");

// Lua: Credits.lua:287 -- Credits_Copyright, the one string with an hlcoord
// of its own.
const COPYRIGHT = defineString("COPYRIGHT", ["bois club games", "bryanthaboi 2026", "a fan-made port"]);

// ---------------------------------------------------------------------------
// The script (Lua: Credits.lua:300) -- data/credits_script.asm's shape, byte
// for byte: a flat stream where a string id is followed by its LINE INDEX and
// each command carries its own operands.

const END = 0xff;
const WAIT = 0xfe;
const SCENE = 0xfd;
const CLEAR = 0xfc;
const MUSIC = 0xfb;
const WAIT2 = 0xfa;
const THEEND = 0xf9;

// Lua: Credits.lua:306
function group(script: number[], ...rows: number[]): number[] {
  rows.forEach((id, index) => {
    script.push(id);
    script.push(index);
  });
  script.push(WAIT);
  script.push(12);
  return script;
}

// Lua: Credits.lua:317
function build(): number[] {
  const s: number[] = [];
  // Clear the banner, put the heading up, and let the music start under it.
  s.push(CLEAR, ID.STAFF!, 0, WAIT, 8, MUSIC, WAIT2, 10, WAIT, 1);
  const scene = (n: number): void => {
    s.push(SCENE, n);
  };
  // The cart ends each act with a bare `CREDITS_WAIT, 0`, then CREDITS_CLEAR
  // and a one-tick wait before the next scene.
  const endAct = (): void => {
    s.push(WAIT, 0, CLEAR, WAIT, 1);
  };

  scene(0); // Bellossom
  group(s, ID.DIRECTOR!, ID.BRYANTHABOI!);
  group(s, ID.PROGRAMMING!, ID.BRYANTHABOI!, ID.BOIS_CLUB!);
  group(s, ID.ENGINE_DESIGN!, ID.BOIS_CLUB!);
  group(s, ID.BATTLE_ENGINE!, ID.BOIS_CLUB!);
  group(s, ID.SCRIPT_ENGINE!, ID.BOIS_CLUB!);
  endAct();

  scene(1); // Togepi
  group(s, ID.WORLD_ENGINE!, ID.BOIS_CLUB!);
  group(s, ID.AUDIO_ENGINE!, ID.CHIP_SYNTH!, ID.BOIS_CLUB!);
  group(s, ID.GRAPHICS!, ID.BOIS_CLUB!);
  group(s, ID.USER_INTERFACE!, ID.BOIS_CLUB!);
  group(s, ID.ROM_IMPORTER!, ID.BOIS_CLUB!);
  endAct();

  scene(2); // Elekid
  group(s, ID.SAVE_EDITOR!, ID.BOIS_CLUB!);
  group(s, ID.MOD_SDK!, ID.BOIS_CLUB!);
  group(s, ID.TOOLS!, ID.BRYANTHABOI!);
  group(s, ID.TESTING!, ID.THE_BOIS_CLUB!);
  group(s, ID.BUILT_WITH!, ID.LOVE2D!, ID.LUAJIT!);
  endAct();

  scene(3); // Sentret
  group(s, ID.BASED_ON!, ID.PRET_POKEGOLD!);
  group(s, ID.SPECIAL_THANKS!, ID.PRET_PROJECT!, ID.EVERY_TESTER!);
  group(s, ID.SPECIAL_THANKS!, ID.THE_BOIS_CLUB!, ID.AND_YOU!);
  group(s, ID.PRODUCER!, ID.BRYANTHABOI!);

  // The tail, which is the cart's exactly.
  s.push(ID.COPYRIGHT!, 0, WAIT, 20, WAIT, 19, THEEND, WAIT, 20, END);
  return s;
}

const SCRIPT = build();

interface Placed {
  text?: string;
  theEnd?: boolean;
  x: number;
  y: number;
  width?: number;
}

export interface CreditsOpts {
  allowSkip?: boolean;
  script?: number[];
  icons?: any;
  gfx?: any;
  onDone?: () => void;
}

export class Credits {
  [key: string]: any;
  static isOpaque = true;
  isOpaque = true;

  // Lua: Credits.lua:71 -- `const_def -1, -1`: the command block counts DOWN.
  static END = END;
  static WAIT = WAIT;
  static SCENE = SCENE;
  static CLEAR = CLEAR;
  static MUSIC = MUSIC;
  static WAIT2 = WAIT2;
  static THEEND = THEEND;
  // Lua: Credits.lua:84 -- one trip round Credits_Jumptable.
  static PASS_FRAMES = 13;

  // Lua: Credits.lua:147 -- gfx/credits/credits.pal, the first four sets.
  static PALETTES: Record<number, number[][]> = {
    0: pal555(31, 31, 31, 29, 8, 27, 15, 24, 12, 7, 7, 7), // Bellossom
    1: pal555(31, 31, 31, 30, 26, 11, 31, 11, 27, 7, 7, 7), // Togepi
    2: pal555(31, 31, 31, 31, 31, 5, 17, 23, 31, 7, 7, 7), // Elekid
    3: pal555(31, 31, 31, 22, 15, 10, 31, 19, 9, 7, 7, 7), // Sentret
  };

  // Lua: Credits.lua:154
  static PALETTES_CRYSTAL: number[][][] = [
    pal555(31, 0, 31, 31, 25, 0, 11, 14, 31, 7, 7, 7),
    pal555(31, 5, 5, 11, 14, 31, 11, 14, 31, 31, 31, 31),
    pal555(31, 5, 5, 0, 0, 0, 31, 31, 31, 31, 31, 31),
    pal555(31, 31, 31, 31, 27, 0, 26, 6, 31, 7, 7, 7),
    pal555(3, 13, 31, 20, 0, 24, 26, 6, 31, 31, 31, 31),
    pal555(3, 13, 31, 0, 0, 0, 31, 31, 31, 31, 31, 31),
    pal555(31, 31, 31, 23, 12, 28, 31, 22, 0, 7, 7, 7),
    pal555(3, 20, 0, 31, 22, 0, 31, 22, 0, 31, 31, 31),
    pal555(3, 20, 0, 0, 0, 0, 31, 31, 31, 31, 31, 31),
    pal555(31, 31, 31, 31, 10, 31, 31, 0, 9, 7, 7, 7),
    pal555(31, 14, 0, 31, 0, 9, 31, 0, 9, 31, 31, 31),
    pal555(31, 14, 0, 31, 31, 31, 31, 31, 31, 31, 31, 31),
  ];
  static CRYSTAL_PALETTES_PER_SCENE = 3;
  static BORDER_FRAMES = BORDER_FRAMES;
  static BORDER_FRAMES_CRYSTAL = BORDER_FRAMES_CRYSTAL;
  // Lua: Credits.lua:189
  static SCENE_SPECIES: Record<number, string> = { 0: "BELLOSSOM", 1: "TOGEPI", 2: "ELEKID", 3: "SENTRET" };
  static SCENE_SPECIES_CRYSTAL: Record<number, string> = { 0: "PICHU", 1: "SMOOCHUM", 2: "DITTO", 3: "IGGLYBUFF" };

  static STAFF = STAFF;
  static COPYRIGHT = COPYRIGHT;
  static STRINGS = STRINGS;
  static ID = ID;
  static SCRIPT = SCRIPT;
  static warned = false;

  static TILES_W = TILES_W;
  static TEXT_TOP_ROW = TEXT_TOP_ROW;
  static TEXT_FIRST_ROW = TEXT_FIRST_ROW;
  static LINE_SPACING = LINE_SPACING;
  static LAYOUT = LAYOUT;
  static layout = layout;
  static SKIP_AFTER_POS = SKIP_AFTER_POS;
  static ALLOW_SKIPPING_CREDITS_F = ALLOW_SKIPPING_CREDITS_F;
  static JUMPTABLE_EXIT_F = JUMPTABLE_EXIT_F;
  static STEP_PARSE = STEP_PARSE;
  static STEP_GFX = STEP_GFX;
  static STEP_LY = STEP_LY;

  game: any;
  data: any;
  onDone?: () => void;
  script: number[] = SCRIPT;
  allowSkip = false;
  icons: any;
  gfx: any;
  images: Record<string, LcdImage | false> = {};
  quads: Record<string, Quad> = {};
  step = 0;
  exiting = false;
  pos = 1;
  timer = 0;
  frames = 0;
  passes = 0;
  done = false;
  scene = 0;
  borderFrame = 0xff;
  lyOverride = 0;
  pending: Placed[] = [];
  shown: Placed[] = [];
  postCredits?: string;

  // Lua: Credits.lua:397
  wantsFillScale(): boolean {
    return true;
  }

  // Lua: Credits.lua:398
  drawsWidescreen(): boolean {
    return true;
  }

  // Lua: Credits.lua:407 -- opts: allowSkip (the ALLOW_SKIPPING_CREDITS_F
  // bit), script (an override), icons, gfx, onDone()
  static new(game: any, opts?: CreditsOpts): Credits {
    const o = opts ?? {};
    const self = new Credits();
    self.game = game;
    const data = (game && game.data) || {};
    self.data = data;
    self.onDone = o.onDone;
    self.script = o.script ?? SCRIPT;
    self.allowSkip = !!o.allowSkip;
    self.icons = o.icons ?? data.gen2Icons;
    self.gfx = o.gfx ?? data.gen2Credits;
    if (!(self.gfx && self.gfx.scenes) && !Credits.warned) {
      Credits.warned = true;
      Logger.info("gold credits: gfx/credits/ is not in the cache -- the banner falls back to the mon icons");
    }
    self.images = {};
    // wJumptableIndex's low nibble, and its two flags as their own fields.
    self.step = 0;
    self.exiting = false;
    // wCreditsPos, 1-based like the Lua.
    self.pos = 1;
    self.timer = 0;
    self.frames = 0;
    self.passes = 0;
    self.done = false;
    // wCreditsBorderMon / wCreditsBorderFrame. $ff is the blank frame.
    self.scene = 0;
    self.borderFrame = 0xff;
    self.lyOverride = 0;
    self.pending = [];
    self.shown = [];
    return self;
  }

  // Lua: Credits.lua:453 -- `.get`: read the byte at wCreditsPos and step past it.
  get(): number | undefined {
    const byte = this.script[this.pos - 1];
    this.pos = this.pos + 1;
    return byte;
  }

  // Lua: Credits.lua:459
  clearPending(): void {
    this.pending = [];
  }

  // Lua: Credits.lua:465 -- one text write into the pending tilemap.
  place(id: number, line: number | undefined): void {
    const text = STRINGS[id];
    if (text == null) return;
    // `cp COPYRIGHT / jr z, .copyright` is hlcoord 2, 6; everything else 0, 6.
    const x = id === COPYRIGHT ? 2 : 0;
    const y = TEXT_FIRST_ROW + (line ?? 0) * LINE_SPACING;
    if (Array.isArray(text)) {
      text.forEach((row, index) => {
        this.pending.push({ text: row, x, y: y + index * LINE_SPACING });
      });
      return;
    }
    this.pending.push({ text, x, y });
  }

  // Lua: Credits.lua:484 -- Credits_TheEnd: two rows of eight running tile ids.
  theEnd(): void {
    this.pending.push({ theEnd: true, x: THEEND_X, y: layout().theEndY, width: THEEND_W });
  }

  // Lua: Credits.lua:491 -- the `.wait` arm's hBGMapMode.
  pushTilemap(): void {
    this.shown = [...this.pending];
  }

  // Lua: Credits.lua:497
  parse(): void {
    if (this.exiting) return;
    if (this.timer > 0) {
      this.timer = this.timer - 1;
      return;
    }
    // `.parse` clears rows 5-12 of the tilemap first, every time.
    this.clearPending();
    for (;;) {
      const byte = this.get();
      if (byte == null || byte === END) {
        // `.end`: set the exit flag and queue the post-credits theme behind a
        // 32-step fade. The screen stays up until A is pressed.
        this.exiting = true;
        this.fadeToPostCredits();
        return;
      } else if (byte === WAIT) {
        this.timer = this.get() ?? 0;
        this.pushTilemap();
        return;
      } else if (byte === WAIT2) {
        // Same timer, no hBGMapMode: whatever is on screen stays there.
        this.timer = this.get() ?? 0;
        return;
      } else if (byte === SCENE) {
        this.scene = (this.get() ?? 0) % 4;
        this.borderFrame = 0;
      } else if (byte === CLEAR) {
        this.borderFrame = 0xff;
      } else if (byte === MUSIC) {
        this.playMusic(CREDITS_MUSIC);
      } else if (byte === THEEND) {
        this.theEnd();
      } else {
        this.place(byte, this.get());
      }
    }
  }

  // Lua: Credits.lua:545 -- Credits_LoadBorderGFX.
  advanceBorder(): void {
    if (this.borderFrame === 0xff) return;
    this.borderFrame = (this.borderFrame + 1) % 4;
  }

  // Lua: Credits.lua:552 -- which of the mon's graphics is showing, 1-based.
  borderGraphic(): number | undefined {
    if (this.borderFrame === 0xff) return undefined;
    const sets = isCrystal() ? BORDER_FRAMES_CRYSTAL : BORDER_FRAMES;
    const frames = sets[this.scene] ?? sets[0]!;
    return frames[this.borderFrame];
  }

  // Lua: Credits.lua:563 -- Credits_LYOverride: two more pixels every pass.
  advanceLY(): void {
    this.lyOverride = (((this.lyOverride + layout().lyStep) % 256) + 256) % 256;
  }

  // Lua: Credits.lua:571
  playMusic(song: string): void {
    const audio = this.data && this.data.audio;
    if (audio && audio.songs && audio.songs[song]) {
      // HallOfFame_PlayMusicDE: MUSIC_NONE for a frame, then the song.
      Music.stop();
      Music.play(this.data, song, true, { reason: "credits" });
    }
  }

  // Lua: Credits.lua:580
  fadeToPostCredits(): void {
    const audio = this.data && this.data.audio;
    if (!(audio && audio.songs && audio.songs[POST_CREDITS_MUSIC])) {
      Music.fadeOut(POST_CREDITS_FADE);
      return;
    }
    Music.fadeOut(POST_CREDITS_FADE);
    this.postCredits = POST_CREDITS_MUSIC;
  }

  // Lua: Credits.lua:596 -- Credits_HandleBButton: B makes the credits hurry.
  handleB(input: any): void {
    if (!(input && input.isDown && input.isDown("b"))) return;
    if (!this.allowSkip) return;
    // `cp $d` against the low byte of wCreditsPos, which is 0-based.
    if (this.pos - 1 < SKIP_AFTER_POS) return;
    if (this.timer <= 0) return;
    this.timer = this.timer - 1;
  }

  // Lua: Credits.lua:606 -- A only leaves once ParseCredits set the exit bit.
  handleA(input: any): boolean {
    return !!(this.exiting && input && input.isDown && input.isDown("a"));
  }

  // Lua: Credits.lua:614 -- one frame of `.execution_loop`.
  step1(): boolean {
    if (this.done) return true;
    this.frames = this.frames + 1;
    const step = this.step;
    if (step === STEP_PARSE) {
      this.parse();
    } else if (step === STEP_GFX) {
      this.advanceBorder();
    } else if (step === STEP_LY) {
      this.advanceLY();
    }
    if (step >= Credits.PASS_FRAMES - 1) {
      // Credits_LoopBack: `and $f0`, so only the low nibble is reset.
      this.step = 0;
      this.passes = this.passes + 1;
    } else {
      this.step = step + 1;
    }
    return false;
  }

  // Lua: Credits.lua:635
  finish(): void {
    if (this.done) return;
    this.done = true;
    if (this.postCredits) this.playMusic(this.postCredits);
    if (this.onDone) this.onDone();
  }

  // Lua: Credits.lua:642
  update(_dt?: number): void {
    if (this.done) return;
    const input = this.game ? this.game.input : undefined;
    this.handleB(input);
    if (this.handleA(input)) return this.finish();
    this.step1();
  }

  // Lua: Credits.lua:652 -- run the whole movie headless; frames, or undefined.
  runToEnd(limit?: number): number | undefined {
    const n = limit ?? 60000;
    for (let frame = 1; frame <= n; frame++) {
      this.step1();
      if (this.exiting) return frame;
    }
    return undefined;
  }

  // Lua: Credits.lua:668 -- GetCreditsPalette masks the scene with %11.
  palette(): Colors {
    if (isCrystal()) return this.palettes()[0];
    const sets = this.gfx && this.gfx.palettes;
    const extracted = sets && sets[(this.scene % 4)];
    if (extracted) return extracted;
    return Credits.PALETTES[this.scene] ?? Credits.PALETTES[0]!;
  }

  // Lua: Credits.lua:677 -- ../pokecrystal/engine/movie/credits.asm:501-514
  palettes(): [Colors, Colors, Colors] {
    if (!isCrystal()) {
      const pal = this.palette();
      return [pal, pal, pal];
    }
    let sets = this.gfx && this.gfx.palettes;
    if (!(sets && sets[11])) sets = Credits.PALETTES_CRYSTAL;
    const base = (this.scene % 4) * Credits.CRYSTAL_PALETTES_PER_SCENE;
    return [sets[base], sets[base + 1], sets[base + 2]];
  }

  // Lua: Credits.lua:688
  image(path: string | undefined): LcdImage | undefined {
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

  // Lua: Credits.lua:703 -- the icon standing in for this scene's mon graphic.
  sceneIcon(): [LcdImage | undefined, any] | undefined {
    const names = isCrystal() ? Credits.SCENE_SPECIES_CRYSTAL : Credits.SCENE_SPECIES;
    const species = names[this.scene];
    const icons = this.icons;
    if (!(species && icons && icons.species && icons.icons)) return undefined;
    const entry = icons.icons[icons.species[species]];
    if (!entry) return undefined;
    return [this.image(entry.image), entry];
  }

  // Lua: Credits.lua:717 -- an icon sheet is one column of `frames` 16x16 cells.
  iconQuad(image: LcdImage, entry: any, graphic: number): Quad {
    const frames = entry.frames || 2;
    const index = (graphic - 1) % frames;
    const key = tostring(entry.id) + ":" + index;
    let quad = this.quads[key];
    if (!quad) {
      const height = Math.floor((entry.height || 32) / frames);
      const [w, h] = image.getDimensions();
      quad = G.newQuad(0, index * height, entry.width || 16, height, w, h);
      this.quads[key] = quad;
    }
    return quad;
  }

  // Lua: Credits.lua:736 -- the real 4x4 sheet for this scene.
  sceneSheet(): [LcdImage | undefined, any] | undefined {
    const scenes = this.gfx && this.gfx.scenes;
    const entry = scenes && scenes[this.scene % 4];
    if (!entry) return undefined;
    return [this.image(entry.image), entry];
  }

  // Lua: Credits.lua:743
  sheetQuad(image: LcdImage, entry: any, graphic: number): Quad {
    const frames = entry.frames || 1;
    const index = Math.min(graphic, frames) - 1;
    const w = entry.width || 32;
    const h = entry.height || 32;
    const key = "sheet:" + tostring(entry.species) + ":" + index;
    let quad = this.quads[key];
    if (!quad) {
      const [iw, ih] = image.getDimensions();
      quad = G.newQuad(0, index * h, w, h, iw, ih);
      this.quads[key] = quad;
    }
    return quad;
  }

  // Lua: Credits.lua:758 -- TheEndGFX.
  theEndImage(): LcdImage | undefined {
    const path = this.gfx && this.gfx.theEnd;
    return path ? this.image(path) : undefined;
  }

  // Lua: Credits.lua:765 -- one 8x8 tile of the 9-tile border strip, 1-based.
  borderQuad(image: LcdImage, tile: number): Quad {
    const key = "border:" + tile;
    let quad = this.quads[key];
    if (!quad) {
      const [w, h] = image.getDimensions();
      quad = G.newQuad((tile - 1) * 8, 0, 8, 8, w, h);
      this.quads[key] = quad;
    }
    return quad;
  }

  // Lua: Credits.lua:784 -- rows 0-3 and 14-17: five copies of a 4x4 block.
  drawBanner(): void {
    const banner = this.palettes()[0];
    const pal = GbcPalette.resolve(banner);
    const graphic = this.borderGraphic();
    const cell = BANNER_TILES * 8;
    for (const row of layout().bannerRows) {
      // The cleared banner really is one flat colour: wCreditsBlankFrame2bpp
      // is sixteen tiles of solid colour 2.
      const backdrop = graphic != null ? GbcPalette.color(pal, 1) : GbcPalette.color(pal, 3);
      fill(backdrop, 0, row * 8, SCREEN_W, cell);
      if (graphic != null) {
        // The real sheet first: a 32x32 block is exactly the 4x4 cell.
        let found = this.sceneSheet();
        let image = found ? found[0] : undefined;
        let entry = found ? found[1] : undefined;
        let quad = image && entry ? this.sheetQuad(image, entry, graphic) : undefined;
        let px = 0;
        let py = row * 8;
        if (!quad) {
          found = this.sceneIcon();
          image = found ? found[0] : undefined;
          entry = found ? found[1] : undefined;
          quad = image && entry ? this.iconQuad(image, entry, graphic) : undefined;
          if (quad) {
            const iconW = entry.width || 16;
            const iconH = Math.floor((entry.height || 32) / (entry.frames || 2));
            px = Math.floor((cell - iconW) / 2);
            py = row * 8 + Math.floor((cell - iconH) / 2);
          }
        }
        if (quad && image) {
          G.setColor(1, 1, 1, 1);
          GbcPalette.useRaw(pal);
          for (let repeatIndex = 0; repeatIndex < BANNER_REPEATS; repeatIndex++) {
            G.draw(image, quad, repeatIndex * cell + px, py);
          }
          GbcPalette.clear();
        }
      }
    }
  }

  // Lua: Credits.lua:836 -- rows 4 and 13: the border strip, slid sideways by
  // the LY override. DrawCreditsBorder lays four running tiles across the
  // row, so the pattern repeats every 32px. Row 4 starts at $24 and row 13 at
  // $20: different quarters of the 9-tile strip.
  //
  // The Lua draws the strip shifted by `lyOverride % 32` on its canvas. Here
  // it is what the cart does: the strip goes into all 32 BG map columns of
  // its row and the LY override becomes per-line SCX on those eight lines.
  drawBorderStrips(): void {
    const strips = this.palettes()[1];
    const pal = GbcPalette.resolve(strips);
    const color = GbcPalette.color(pal, 3);
    const gfx = this.gfx;
    const image = gfx && gfx.border ? this.image(gfx.border) : undefined;
    const rows = layout().borderRows;
    const starts: Record<number, number> = {
      [rows[0]!]: (gfx && gfx.borderTopTile) || 5,
      [rows[1]!]: (gfx && gfx.borderBottomTile) || 1,
    };
    const lcd = currentLcd();
    const scx = new Array<number>(LCD_H).fill(0);
    for (const row of rows) {
      fill(color, 0, row * 8, SCREEN_W, 8);
      if (image && lcd) {
        const first = starts[row]!;
        const slot = lcd.palette(GbcPalette.remap(pal, GbcPalette.bgp) as unknown as Palette4);
        for (let col = 0; col < 32; col++) {
          const tile = first + (col % 4);
          const id = image.ids[tile - 1];
          if (id !== undefined) lcd.cell(col, row, id, slot);
        }
        for (let ly = row * 8; ly < row * 8 + 8 && ly < LCD_H; ly++) scx[ly] = this.lyOverride;
      } else {
        // Without the real strip art the slide has nothing to move, so a
        // notch carries it: one lighter cell per four, at the override.
        const light = GbcPalette.color(pal, 2);
        const shift = this.lyOverride % 32;
        for (let x = -32; x <= SCREEN_W; x += 32) fill(light, x + shift, row * 8, 8, 8);
      }
    }
    if (lcd && image) lcd.lines(2, scx);
  }

  // Lua: Credits.lua:878
  drawText(): void {
    const pal = this.palettes()[2];
    for (const entry of this.shown) {
      if (entry.theEnd) {
        const image = this.theEndImage();
        if (image) {
          // TheEndGFX is 16 tiles, placed 8 wide on rows 8 and 9.
          const shaded = GbcPalette.resolve(pal);
          G.setColor(1, 1, 1, 1);
          GbcPalette.useRaw(shaded);
          G.draw(image, entry.x * 8, entry.y * 8);
          GbcPalette.clear();
        } else {
          // Centred in the eight columns the graphic occupies.
          const text = "THE END";
          const width = Font.width(text);
          Chrome.printThrough(text, entry.x + Math.floor((entry.width! * 8 - width) / 16), entry.y, pal);
        }
      } else {
        Chrome.printThrough(entry.text!, entry.x, entry.y, pal);
      }
    }
  }

  // Lua: Credits.lua:908
  drawPanel(): void {
    const field = this.palettes()[2];
    const pal = GbcPalette.resolve(field);
    // Rows 4-13 are $7f, the blank tile, which reads as colour 0.
    const paper = GbcPalette.color(pal, 1);
    fill(paper, 0, 0, SCREEN_W, SCREEN_H);
    this.drawBanner();
    this.drawBorderStrips();
    this.drawText();
    G.setColor(1, 1, 1, 1);
  }

  // Lua: Credits.lua:920
  draw(): void {
    Chrome.withClip(() => this.drawPanel());
  }

  // Lua: Credits.lua:924
  drawWidescreen(winW: number, winH: number): void {
    Chrome.withPanel(winW, winH, 0, 0, 0, () => this.drawPanel());
  }
}

// Lua: Credits.lua:776
function fill(color: readonly number[], x: number, y: number, w: number, h: number): void {
  G.setColor(color[0]! / 255, color[1]! / 255, color[2]! / 255, 1);
  G.rectangle("fill", x, y, w, h);
  G.setColor(1, 1, 1, 1);
}

export default Credits;
