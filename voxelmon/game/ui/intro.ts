// The boot intro: the copyright card, the GAME FREAK splash and the
// Gengar/Nidorino attract fight, plus the one thing the cartridge never had
// -- a fist that comes through the paper.
//
// A frame-for-frame port of PlayIntro (engine/movie/intro.asm) and
// AnimateShootingStar (engine/movie/splash.asm) by way of gen1recomp
// src/ui/IntroMovie.lua, which is where the line numbers cited below come
// from. Every count here is the ROM's; nothing is eyeballed.
//
// The PUNCH is ours and sits exactly where the ROM cuts from the splash to
// the fight, so the original's running order is untouched: the paper the
// splash is printed on tears off, and the fight is already going on behind
// it.
//
// Yellow boots the same way up to the fight, and plays its own movie where
// Red's fight would be (ui/yellowintro.ts): Pikachu is already running
// behind the paper.
import type { GameState } from "../game.ts";
import { namedPage } from "../battle/staging.ts";
import { GB_W, GB_H, VIEW_W, VIEW_H } from "../../../contracts/spec/voxel-spec.ts";
import { gameVersion } from "../data.ts";
import { BG_ROWS, YellowIntroScenes } from "./yellowintro.ts";

/** GB pixels -> the 480x272 the pic layer measures in (core ui.rs). */
const UI_SCALE = VIEW_H / GB_H;
const UI_ORIGIN_X = (VIEW_W - GB_W * UI_SCALE) / 2;
const sx = (gx: number): number => Math.round(UI_ORIGIN_X + gx * UI_SCALE);
const sy = (gy: number): number => Math.round(gy * UI_SCALE);
const sw = (gw: number): number => Math.round(gw * UI_SCALE);
/** The same three, for the title screen, which is laid out in GB space too. */
export const gbX = sx;
export const gbY = sy;
export const gbW = sw;
/** The copyright line's tiles, for the title's row 17 (title/copyright,
 * then title/gamefreak). */
export const COPYRIGHT_PREFIX = [0, 1, 2, 1, 3, 1, 4] as const;
/** Yellow's "(c)1995-1999" (pokeyellow title.asm .tileScreenCopyrightTiles
 * $e0,$e1,$e2,$e3,$e1,$e2,$ee): its copyright tiles are 1-9 / 9 / 5- / 9,
 * and the $ee NineTile is the same "9" as tile 4. */
export const COPYRIGHT_PREFIX_YELLOW = [0, 1, 2, 3, 1, 2, 4] as const;
export const COPYRIGHT_GAMEFREAK = [0, 1, 2, 3, 4, 5, 6, 7, 8] as const;

export interface IntroQuad {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** How far out of the screen this one stands, Q8 (host `picDepth`). */
  d?: number;
}
export interface IntroTile { page: number; tile: number; x: number; y: number; flags: number }

/** The movie's own clock, for anything that has to wait for a phase. */
export const INTRO_CLOCK = {
  copyright: 180,
  splash: 318,
  breach: 82,
} as const;

export interface IntroView {
  phase: "copyright" | "splash" | "punch" | "fight";
  /** Screen-space pic draws, back to front. */
  pics: IntroQuad[];
  /** GB-space 8x8 tiles (the OAM layer). */
  tiles: IntroTile[];
}

// --- the ROM's clock --------------------------------------------------------

const COPYRIGHT_FRAMES = 180;       // ld c, 180 (intro.asm:311-312)
const STAR_START = 64;              // ld c, 64 (intro.asm:323-324)
const STAR_FRAMES = 40;             // OAM Y 0->160 in +4 steps (splash.asm:32-60)
const FLASH_START = STAR_START + STAR_FRAMES;
const FLASH_FRAMES = 30;            // 3 loops x 10 frames (splash.asm:72-82)
const WAVES_START = FLASH_START + FLASH_FRAMES;
const WAVE_FRAMES = 24;             // 8 substeps x 3 frames (splash.asm:186-209)
const WAVES_END = WAVES_START + 6 * WAVE_FRAMES; // 4 waves + 2 empty
const SPLASH_FRAMES = WAVES_END + 40; // ld c, 40 (intro.asm:329-331)

/** Logo 16x24 at (72,56), the GAME FREAK row 80x8 at (40,80). */
const LOGO_X = 72, LOGO_Y = 56;
const TEXT_X = 40, TEXT_Y = 80;

/** SmallStarsWave*Coords (splash.asm:160-183); all spawn at y 88 (OAM $68). */
const STAR_WAVES = [
  [40, 56, 80, 112],
  [48, 64, 88, 104],
  [44, 68, 76, 92],
  [52, 84, 100, 108],
];

/**
 * LoadCopyrightTiles (title.asm CopyrightTextString) into the extracted
 * strip: the year runs 0,1,2,1,3,1,4 because the ROM keeps ONE `'9` tile
 * and places it three times.
 */
const COPY_PREFIX = [0, 1, 2, 1, 3, 1, 4];
const COPY_NINTENDO = [5, 6, 7, 8, 9, 10];
const COPY_CREATURES = [11, 12, 13, 14, 15, 16, 17, 18];
/** GameFreakLogoGraphics is its own strip: "GAME FREAK inc.", nine tiles. */
const COPY_GAMEFREAK = [0, 1, 2, 3, 4, 5, 6, 7, 8];
/** Credits.lua drawCopyright: prefix column 2, name column 10, rows 7/9/11. */
const COPY_ROWS = [56, 72, 88];

/** Each paper piece's canvas corner, and the way out of the frame. */
const FLAP_W = 88, FLAP_H = 80;
const FLAP_AT = [
  { x: 0, y: 0, dx: -1, dy: -1 },
  { x: GB_W - FLAP_W, y: 0, dx: 1, dy: -1 },
  { x: 0, y: GB_H - FLAP_H, dx: -1, dy: 1 },
  { x: GB_W - FLAP_W, y: GB_H - FLAP_H, dx: 1, dy: 1 },
] as const;

// --- the punch --------------------------------------------------------------
//
// The staging matters more than any of the numbers here. The fist is BEHIND
// the paper: nothing of it exists on screen until the paper breaks, then it
// comes out through the hole it made and past the camera. Only after it has
// gone does the movie push INTO that hole, which is where the rest of the
// intro plays. Draw a fist over unbroken paper and the whole illusion is the
// other way round -- something outside the screen, landing on it.

const BANNER_AT = 6;                // "IN 3D" lands the moment the stars stop
const BANNER_POP = 24;              // ...and takes this long to come forward
const BANNER_BLINK = 8;             // ...and blinks on this beat once it has
const WHOOSH_AT = 56;               // something is coming, from behind
const BREACH_AT = 82;               // and it is through
/** The burst: the hole opens and the fist comes out of it and past you. */
const BURST_FRAMES = 46;
/** The push through the hole, which ends with it filling the screen. */
const ZOOM_FRAMES = 80;
const TEAR_FRAMES = BURST_FRAMES + ZOOM_FRAMES;
/**
 * The fist waits this long after the breach. The hole has to be OPEN and
 * plainly a hole before anything comes out of it -- a fist that arrives
 * with the first frame of the tear just reads as a fist landing on top of
 * an intact screen, which is the opposite of the trick.
 */
const FIST_AT = 8;
/** 0..1 through the burst, and 0..1 through the push after it. */
function burstOf(tear: number): number {
  return Math.max(0, Math.min(1, tear / BURST_FRAMES));
}
function zoomOf(tear: number): number {
  return Math.max(0, Math.min(1, (tear - BURST_FRAMES) / ZOOM_FRAMES));
}

/** How big the fist is, as a fraction of screen height; 0 = not there. */
function fistScale(tear: number): number {
  if (tear < FIST_AT || tear > BURST_FRAMES) return 0;
  const u = (tear - FIST_AT) / (BURST_FRAMES - FIST_AT);
  // starts small enough to be something coming through a hole, and ends
  // bigger than the screen, which is it going past your head
  return 0.08 + Math.pow(u, 2.4) * 3.3;
}

/** How far out of the screen the fist stands: 0 at the paper, 1 at the eye. */
function fistPop(tear: number): number {
  if (tear < FIST_AT || tear > BURST_FRAMES) return 0;
  const u = (tear - FIST_AT) / (BURST_FRAMES - FIST_AT);
  return Math.min(1, u * 1.4);
}

// --- the fight (PlayIntroScene, intro.asm:23-141) ---------------------------

/** Nidorino's {dy,dx} lists, one delta per 5 frames (intro.asm:370-437). */
const ANIM: number[][][] = [
  [[0, 0], [-2, 2], [-1, 2], [1, 2], [2, 2]],
  [[0, 0], [-2, -2], [-1, -2], [1, -2], [2, -2]],
  [[0, 0], [-12, 6], [-8, 6], [8, 6], [12, 6]],
  [[0, 0], [-8, -4], [-4, -4], [4, -4], [8, -4]],
  [[0, 0], [-8, 4], [-4, 4], [4, 4], [8, 4]],
  [[0, 0], [2, 0], [2, 0], [0, 0]],
  [[-8, -16], [-7, -14], [-6, -12], [-4, -10]],
];

interface Op {
  move?: "scrollIn" | "gengar";
  px?: number;
  dx?: number;
  sfx?: string;
  pose?: number;
  frame?: number;
  anim?: number;
  wait?: number;
  fade?: number;
}

const FIGHT: Op[] = [
  { move: "scrollIn", px: 80 },
  { sfx: "Intro_Hip" }, { anim: 1 },
  { sfx: "Intro_Hop" }, { anim: 2 }, { wait: 10 },
  { sfx: "Intro_Hip" }, { anim: 1 },
  { sfx: "Intro_Hop" }, { anim: 2 }, { wait: 30 },
  { pose: 2 }, { sfx: "Intro_Raise" },
  { move: "gengar", dx: -8 }, { wait: 30 },
  { pose: 3 }, { sfx: "Intro_Crash" },
  { move: "gengar", dx: 16 },
  { sfx: "Intro_Hip" }, { frame: 2 }, { anim: 3 },
  { wait: 30 },
  { move: "gengar", dx: -8 }, { pose: 1 },
  { wait: 60 },
  { sfx: "Intro_Hip" }, { frame: 1 }, { anim: 4 },
  { sfx: "Intro_Hop" }, { anim: 5 }, { wait: 20 },
  { frame: 2 }, { anim: 6 }, { wait: 30 },
  { sfx: "Intro_Lunge" }, { frame: 3 }, { anim: 7 },
  { fade: 24 },
];

interface IntroHost {
  input: { pressed: { a?: boolean; b?: boolean; start?: boolean } };
  data: unknown;
  pop(): void;
  audio?: {
    playSfx(name: string): void;
    playOnce(song: string): boolean;
    stop(): void;
  };
}

export class IntroState implements GameState {
  readonly kind = "intro";
  private phase: IntroView["phase"] = "copyright";
  private t = 0;
  private done = false;
  /** Fight state: PlayIntroScene's entry values (intro.asm:30-39). */
  private gengarX = 104;
  private gengarY = 56;
  private nidoX = -8;
  private nidoY = 72;
  private pose = 1;
  private frame = 1;
  private op = 0;
  private opT = 0;
  private fade = 0;
  /** The punch's own clock, which keeps running under the fight. */
  private tear = -1;
  /** Yellow's movie, in place of the fight (null for Red and Blue). */
  private readonly yellow: YellowIntroScenes | null;

  constructor(private game: IntroHost, private onDone: () => void) {
    this.yellow = gameVersion(game.data as { version?: string }) === "yellow" ? new YellowIntroScenes() : null;
  }

  private page(key: string): number {
    return namedPage(this.game.data as never, "picIntro", key);
  }

  private titleArt(key: string): number {
    return namedPage(this.game.data as never, "picTitle", key);
  }

  private animPage(): number {
    const a = (this.game.data as { atlas?: { animPages?: Record<string, number> } }).atlas;
    return a?.animPages?.["battleanim/46ee"] ?? -1;
  }

  private finish(): void {
    if (this.done) return;
    this.done = true;
    this.game.audio?.stop();
    this.game.pop();
    this.onDone();
  }

  update(): void {
    const p = this.game.input.pressed;
    // CheckForUserInterruption: any of A/B/START drops the whole movie.
    if (p.a || p.b || p.start) {
      this.finish();
      return;
    }
    this.t += 1;
    if (this.tear >= 0) this.tear += 1;
    if (this.phase === "copyright") {
      if (this.t >= COPYRIGHT_FRAMES) this.start("splash");
      return;
    }
    if (this.phase === "splash") {
      if (this.t === STAR_START) this.game.audio?.playSfx("Shooting_Star");
      if (this.t >= SPLASH_FRAMES) this.start("punch");
      return;
    }
    if (this.phase === "punch") {
      if (this.t === WHOOSH_AT) this.game.audio?.playSfx("Intro_Whoosh");
      if (this.t >= BREACH_AT) {
        this.game.audio?.playSfx("Intro_Crash");
        this.tear = 0;
        this.start("fight");
      }
      return;
    }
    if (this.yellow) {
      this.yellow.update();
      if (this.yellow.done) this.finish();
      return;
    }
    this.fightStep();
  }

  private start(phase: IntroView["phase"]): void {
    this.phase = phase;
    this.t = 0;
    // intro.asm:333-338 -- the battle theme belongs to the fight; Yellow's
    // movie starts its own (InitYellowIntroGFXAndMusic)
    if (phase === "fight") {
      if (!this.yellow || !this.game.audio?.playOnce("Music_YellowIntro")) {
        this.game.audio?.playOnce("Music_IntroBattle");
      }
    }
  }

  /** One frame of FIGHT, which runs ops until one of them wants time. */
  private fightStep(): void {
    for (;;) {
      const op = FIGHT[this.op];
      if (!op) {
        this.finish();
        return;
      }
      if (op.sfx) {
        this.game.audio?.playSfx(op.sfx);
      } else if (op.pose !== undefined) {
        this.pose = op.pose;
      } else if (op.frame !== undefined) {
        this.frame = op.frame;
      } else if (op.move) {
        // 2px per 2 frames (IntroMoveMon, intro.asm:235-269)
        if (this.opT % 2 === 0) {
          if (op.move === "scrollIn") {
            this.gengarX -= 2;
            this.nidoX += 2;
          } else {
            this.gengarX += (op.dx ?? 0) > 0 ? 2 : -2;
          }
        }
        this.opT += 1;
        if (this.opT < (op.px ?? Math.abs(op.dx ?? 0))) return;
      } else if (op.anim !== undefined) {
        // one {dy,dx} per 5 frames (AnimateIntroNidorino: DelayFrames 5)
        const list = ANIM[op.anim - 1]!;
        if (this.opT % 5 === 0) {
          const d = list[this.opT / 5];
          if (d) {
            this.nidoY += d[0]!;
            this.nidoX += d[1]!;
          }
        }
        this.opT += 1;
        if (this.opT < list.length * 5) return;
      } else if (op.wait !== undefined) {
        this.opT += 1;
        if (this.opT < op.wait) return;
      } else if (op.fade !== undefined) {
        this.opT += 1;
        this.fade = this.opT / op.fade;
        if (this.opT >= op.fade) this.finish();
        return;
      }
      this.op += 1;
      this.opT = 0;
    }
  }

  // --- what it looks like ---------------------------------------------------

  /**
   * The white the whole movie plays on, the full width of OUR screen.
   *
   * Not a pillarbox: the Game Boy's picture is 160x144 and ours is wider,
   * and the honest way to sit one in the other is to carry the screen's own
   * white out to the edges. The only black in the movie is the black the
   * cartridge draws -- the letterbox bars, and the dark through the hole.
   */
  private paper(out: IntroQuad[]): void {
    const page = this.page("white");
    if (page < 0) return;
    out.push({ page, x: 0, y: 0, w: VIEW_W, h: VIEW_H });
  }

  /**
   * A band of the GAME BOY's screen, in one shade: (gy, gh) in GB rows,
   * the full GB width. Used for the dark behind the paper, which has to
   * stop at the edge of the Game Boy's picture -- past that it would be a
   * border, and the movie has none.
   */
  private gb(out: IntroQuad[], key: string, gy: number, gh: number): void {
    const page = this.page(key);
    if (page < 0) return;
    out.push({ page, x: sx(0), y: sy(gy), w: sw(GB_W), h: sw(gh) });
  }

  /**
   * The four black rows top and bottom (IntroDrawBlackTiles, :343-357),
   * carried the full width of OUR screen so the movie is framed the same
   * way from edge to edge.
   */
  private bars(out: IntroQuad[]): void {
    const black = this.page("black");
    if (black < 0) return;
    out.push({ page: black, x: 0, y: 0, w: VIEW_W, h: sy(32) });
    out.push({ page: black, x: 0, y: sy(GB_H - 32), w: VIEW_W, h: VIEW_H - sy(GB_H - 32) });
  }

  private splashArt(out: IntroQuad[], dim: boolean): void {
    const logo = this.page(dim ? "gflogo_dim" : "gflogo");
    if (logo >= 0) {
      out.push({ page: logo, x: sx(LOGO_X), y: sy(LOGO_Y), w: sw(16), h: sw(24) });
    }
    const text = this.page("gftext");
    if (text >= 0) {
      out.push({ page: text, x: sx(TEXT_X), y: sy(TEXT_Y), w: sw(80), h: sw(8) });
    }
  }

  /**
   * IN 3D: our own line, in our own hand (cook/intro.ts buildIn3dPage),
   * standing between the top letterbox bar and the logo -- and standing
   * OUT of the screen, which is the claim it is making.
   */
  private marquee(out: IntroQuad[], clock: number): void {
    const page = this.page("in3d");
    if (page < 0 || clock < BANNER_AT) return;
    // Blinking, the way an attract screen does: the words are shouting.
    if (Math.floor(clock / BANNER_BLINK) % 2 !== 0) return;
    const W = 60, H = 16;
    const pop = Math.min(1, (clock - BANNER_AT) / BANNER_POP);
    out.push({
      page,
      x: sx((GB_W - W) / 2),
      y: sy(36),
      w: sw(W),
      h: sw(H),
      d: Math.round(pop * 160),
    });
  }

  /** The copyright card, composed tile by tile the way the ROM composes it. */
  private copyrightTiles(out: IntroTile[]): void {
    const strip = this.titleArt("copyright");
    const gf = this.titleArt("gamefreak");
    const row = (page: number, seq: number[], x: number, y: number): void => {
      if (page < 0) return;
      seq.forEach((t, i) => out.push({ page, tile: t, x: x + i * 8, y, flags: 0 }));
    };
    const prefix = this.yellow ? [...COPYRIGHT_PREFIX_YELLOW] : COPY_PREFIX;
    COPY_ROWS.forEach((y) => row(strip, prefix, 16, y));
    row(strip, COPY_NINTENDO, 80, COPY_ROWS[0]!);
    row(strip, COPY_CREATURES, 80, COPY_ROWS[1]!);
    row(gf, COPY_GAMEFREAK, 80, COPY_ROWS[2]!);
  }

  /**
   * The big star: MoveAnimationTiles1 tiles 3 and 19, the right column the
   * same two mirrored (GameFreakShootingStarOAMData, splash.asm:6-13).
   */
  /**
   * Both the star and the falling stars carry OAM_PRIO, so the letterbox
   * bars cover them (intro.asm:195, splash.asm:149). Our bars are pictures
   * and the tile layer draws over pictures, so a tile that would touch a
   * bar is simply not drawn -- clipped to the tile, which is the grain the
   * bars themselves are drawn at.
   */
  private unbarred(y: number): boolean {
    return y >= 32 && y + 8 <= 112;
  }

  private bigStar(out: IntroTile[]): void {
    const page = this.animPage();
    if (page < 0) return;
    const n = this.t - STAR_START + 1;
    const x = 152 - 4 * n;
    const y = -16 + 4 * n;
    for (const pair of [[3, 0], [19, 8]]) {
      const tile = pair[0]!;
      const dy = pair[1]!;
      if (!this.unbarred(y + dy)) continue;
      out.push({ page, tile, x, y: y + dy, flags: 0 });
      out.push({ page, tile, x: x + 8, y: y + dy, flags: 1 });
    }
  }

  /**
   * Four waves raining off the logo, each falling 1px per 3-frame substep
   * and the lower star of the tile blinking with OBP1 (splash.asm:97-209).
   */
  private fallingStars(out: IntroTile[]): void {
    const star = this.page("star");
    const blink = this.page("star_blink");
    if (star < 0) return;
    const substep = Math.floor((Math.min(this.t, WAVES_END) - WAVES_START) / 3);
    const page = substep % 2 === 0 ? star : (blink >= 0 ? blink : star);
    STAR_WAVES.forEach((xs, w) => {
      const spawn = w * 8;
      if (substep < spawn) return;
      const y = 88 + (substep - spawn);
      if (!this.unbarred(y)) return;
      for (const x of xs) out.push({ page, tile: 0, x, y, flags: 0 });
    });
  }

  /**
   * One frame of Yellow's movie: the scene's BG picture at -SCX, wrapped
   * every 256 px the way the BG map wraps (so it runs out to the edges of
   * our wider screen with what the map holds there), then the objects.
   */
  private yellowArt(out: IntroQuad[]): void {
    const f = this.yellow!.frame();
    if (f.black) {
      const black = this.page("black");
      if (black >= 0) out.push({ page: black, x: 0, y: 0, w: VIEW_W, h: VIEW_H });
    } else if (f.bg) {
      const page = this.page(`yi_${f.bg.name}`);
      if (page >= 0) {
        for (let k = -1; k <= 1; k++) {
          const gx = -f.bg.scx + k * 256;
          if (sx(gx) >= VIEW_W || sx(gx + 256) <= 0) continue;
          out.push({ page, x: sx(gx), y: sy(f.bg.dy), w: sw(256), h: sw(BG_ROWS * 8) });
        }
      }
    }
    for (const o of f.objects) {
      const page = this.page(`yi_${o.name}`);
      if (page >= 0) out.push({ page, x: sx(o.x), y: sy(o.y), w: sw(o.w), h: sw(o.h) });
    }
  }

  private fightArt(out: IntroQuad[]): void {
    const nido = this.page(`nido${this.frame}`);
    if (nido >= 0) {
      out.push({ page: nido, x: sx(this.nidoX), y: sy(this.nidoY), w: sw(48), h: sw(48) });
    }
    const gengar = this.page(`gengar${this.pose}`);
    if (gengar >= 0) {
      out.push({ page: gengar, x: sx(this.gengarX), y: sy(this.gengarY), w: sw(56), h: sw(56) });
    }
  }

  /**
   * The paper, the fist, and the push through the hole.
   *
   * The paper is in eight pieces and they leave in two waves. The four
   * PATCHES are the hole: they all retreat from the middle, so the opening
   * grows out of the centre to the ragged edge the cook cut, and the rest
   * of the screen stays whole while it happens. Only once the fist is
   * through and gone do the four FLAPS follow, which is the movie pushing
   * in through the hole rather than the screen falling apart.
   *
   * The fist is drawn after both, because by then it is in front of the
   * paper it just came through; and it does not exist at all before the
   * hole does.
   */
  private tearArt(out: IntroQuad[]): void {
    const tear = Math.max(0, this.tear);
    const burst = burstOf(tear);
    const zoom = zoomOf(tear);
    const piece = (kind: string, fly: number, grow: number): void => {
      FLAP_AT.forEach((at, q) => {
        const page = this.page(`${kind}${q}`);
        if (page < 0) return;
        // grown about the corner each piece is anchored to, so the eight of
        // them stay joined along their cuts until they actually part
        const gx = at.dx < 0 ? at.x : at.x + FLAP_W - FLAP_W * grow;
        const gy = at.dy < 0 ? at.y : at.y + FLAP_H - FLAP_H * grow;
        const quad = {
          page,
          x: sx(gx) + Math.round(at.dx * fly),
          y: sy(gy) + Math.round(at.dy * fly * 0.75),
          w: sw(FLAP_W * grow),
          h: sw(FLAP_H * grow),
        };
        // A piece on its way out is several times screen size by the end,
        // and eight of those is real fill on a 3DS. Once one has left the
        // frame entirely it stops being drawn.
        if (quad.x >= VIEW_W || quad.y >= VIEW_H) return;
        if (quad.x + quad.w <= 0 || quad.y + quad.h <= 0) return;
        out.push(quad);
      });
    };
    if (zoom < 1) piece("flap", zoom * zoom * 700, 1 + zoom * 2.2);
    if (zoom < 1) {
      // the hole opens FAST -- most of its width in the first few frames,
      // which is how paper gives
      piece("patch", Math.pow(burst, 0.75) * 120 + zoom * zoom * 760,
            1 + burst * 0.2 + zoom * 2.4);
    }
    const scale = fistScale(tear);
    if (scale <= 0) return;
    const fist = this.page("fist");
    if (fist < 0) return;
    const size = Math.round(VIEW_H * scale);
    const pop = fistPop(tear);
    // it leaves past your left ear rather than straight through the middle,
    // so the last frames read as it passing and not as it swelling
    const away = pop * pop * pop;
    out.push({
      page: fist,
      x: Math.round(VIEW_W / 2 - size / 2 - away * 150),
      y: Math.round(VIEW_H / 2 - size / 2 + away * 90),
      w: size,
      h: size,
      // The whole point of the gag: on a console with the slider up this
      // one picture is genuinely in front of the glass, and it comes
      // forward as it grows rather than arriving there.
      d: Math.round(pop * 256),
    });
  }

  view(): IntroView {
    const pics: IntroQuad[] = [];
    const tiles: IntroTile[] = [];
    this.paper(pics);
    if (this.phase === "copyright") {
      this.copyrightTiles(tiles);
    } else if (this.phase === "splash") {
      if (this.t >= STAR_START) {
        const flashing = this.t >= FLASH_START && this.t < FLASH_START + FLASH_FRAMES;
        this.splashArt(pics, flashing && Math.floor((this.t - FLASH_START) / 5) % 2 === 0);
      }
      if (this.t >= STAR_START && this.t < FLASH_START) this.bigStar(tiles);
      if (this.t >= WAVES_START) this.fallingStars(tiles);
      this.bars(pics);
    } else if (this.phase === "punch") {
      // No splash art of its own: the logo, the letter row and the
      // letterbox are all PRINTED on the paper (cook/intro.ts splashSheet),
      // so the screen looks exactly as it did a frame ago and the tear
      // takes every part of it away together.
      this.tearArt(pics);
      this.marquee(pics, this.t);
      this.bars(pics);
    } else {
      // Two different things are behind the paper, in order.
      //
      // While the fist is coming through, the hole shows nothing but the
      // dark behind the screen -- a hole in paper shows darkness, and a
      // white field torn over a white field reads as the logo falling
      // apart rather than as the screen giving way. It stops at the edge of
      // the Game Boy's picture, so it can only ever be a hole and never a
      // border.
      //
      // Once the fist has gone past, the fight is simply there, and the
      // rest of the tear is what is left of the paper flying outward and
      // growing past the lens: the camera going through the hole, which is
      // where the rest of the movie happens.
      const bursting = this.tear >= 0 && burstOf(this.tear) < 1;
      const tearing = this.tear >= 0 && this.tear <= TEAR_FRAMES;
      if (bursting) this.gb(pics, "black", 0, GB_H);
      else if (this.yellow) this.yellowArt(pics);
      else this.fightArt(pics);
      if (tearing) this.tearArt(pics);
      // The words are still standing on the paper they were standing on a
      // frame ago -- which is not moving yet -- so they stay, over it,
      // until the push takes the whole sheet with it.
      if (bursting) this.marquee(pics, BREACH_AT + this.tear);
      // Yellow's scenes carry their own letterbox when they have one; the
      // bars stay over the paper only while it is still tearing
      if (!this.yellow || tearing) this.bars(pics);
      if (this.fade > 0) {
        // GBFadeOutToWhite: three palettes over 24 frames. A pic cannot be
        // part transparent, so the white arrives in one step at the end
        // rather than as a ramp.
        const white = this.page("white");
        if (white >= 0 && this.fade >= 2 / 3) {
          pics.push({ page: white, x: 0, y: 0, w: VIEW_W, h: VIEW_H });
        }
      }
    }
    return { phase: this.phase, pics, tiles };
  }
}
