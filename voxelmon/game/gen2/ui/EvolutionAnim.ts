// gen1recomp src/ui/gen2/EvolutionAnim.lua (bdfac727, MIT): the Gen 2
// evolution screen -- engine/movie/evolution_animation.asm plus the text
// beats around it in engine/pokemon/evolve.asm's EvolveAfterBattle.
//
// All of the arithmetic (which species, whether the condition is met, what
// the party record becomes, every frame count) is core/Evolution.ts's; this
// file is the half that draws.
//
// The animation is NOT a cross fade: the cart loads both frontpics and swaps
// the 7x7 box at hlcoord 7, 2 between them once per WaitBGMap, in
// accelerating bursts (Evolution.flashRounds), all under PREDEFPAL_BLACKOUT
// so both pics read as one silhouette. Here the swap is which pic is drawn,
// and the blackout is the palette it is drawn through (GbcPalette.with).

import { truthy } from "../platform/lua.ts";
import G, { type LcdImage, putTile, SOLID } from "../platform/screen.ts";
import type { Palette4 } from "../platform/lcd.ts";
import { Evolution } from "../core/Evolution.ts";
import { Mon } from "../battle/Mon.ts";
import { Palettes } from "../world/Palettes.ts";
import { Assets } from "../shared/render/Assets.ts";
import { GbcPalette } from "../shared/render/GbcPalette.ts";
import { MonAnimView } from "../shared/render/MonAnimView.ts";
import { Music } from "../shared/core/Music.ts";
import { Sound } from "../shared/core/Sound.ts";
import { Strings } from "../shared/core/Strings.ts";
import { Sprites } from "../shared/pokemon/Sprites.ts";
import { Chrome } from "./Chrome.ts";
import { SpriteAnims } from "./SpriteAnims.ts";

// Lua: EvolutionAnim.lua:47 -- PrepMonFrontpic's box: hlcoord 7, 2, `lb bc, 7, 7`.
const PIC_TILE_X = 7;
const PIC_TILE_Y = 2;
const PIC_TILES = 7;

// Lua: EvolutionAnim.lua:52
const BOX_X = 0;
const BOX_Y = 12;
const BOX_W = 20;
const BOX_H = 6;
const TEXT_X = 1;
const TEXT_Y = 14;
const TEXT_LINE = 2;

// Lua: EvolutionAnim.lua:58 -- PromptButton pages.
const PROMPT_FRAMES = 48;

// Lua: EvolutionAnim.lua:62 -- Paragraph's own `ld c, 20 / call DelayFrames`.
const PARAGRAPH_FRAMES = 20;

// Lua: EvolutionAnim.lua:66 -- PREDEFPAL_BLACKOUT.
const BLACKOUT = Palettes.BLACKOUT;

// Lua: EvolutionAnim.lua:71 -- NUM_SPRITE_ANIM_STRUCTS.
const BALL_LIMIT = 10;

// Lua: EvolutionAnim.lua:73
const EVOLVING_TEXT = Strings.source("What? %s\nis evolving!");
const STOPPED_TEXT = Strings.source("Huh? %s\nstopped evolving!");
const CONGRATS_TEXT = Strings.source("Congratulations!\nYour %s");
const EVOLVED_TEXT = Strings.source("evolved into\n%s!");
const LEARNED_TEXT = Strings.source("%s learned\n%s!");
const WANTS_TO_LEARN_TEXT = Strings.source("%s wants to\nlearn %s!");

/** Lua `a or b`. */
function or<T>(a: T, b: T): T {
  return truthy(a) ? a : b;
}

// Lua: EvolutionAnim.lua:87 -- deliberately \n-only (fixed two-line cart messages).
function messageLines(source: string, ...args: unknown[]): string[] {
  const translated = Strings.get(source, ...args);
  return translated.split("\n");
}

export interface EvolutionResult {
  canceled: boolean;
  evolved: any;
  learned: any[];
  full: any[];
}

export interface EvolutionAnimOpts {
  /** The party record as it stands BEFORE evolving. */
  mon?: any;
  /** The EvosAttacks row Evolution.check picked. */
  entry?: any;
  /** Its party slot (1-based), so the new record lands in the right one. */
  index?: number;
  /** The party table to write back into (defaults to save.party). */
  party?: any[];
  /** For SetSeenAndCaughtMon. */
  save?: any;
  /** wForceEvolution: a stone evolution cannot be cancelled with B. */
  force?: boolean;
  onDone?: (result: EvolutionResult) => void;
}

interface Ball {
  angle: number;
  radius: number;
  age: number;
  x?: number;
  y?: number;
}

export class EvolutionAnim {
  // Lua: EvolutionAnim.lua:44
  static isOpaque = true;
  isOpaque = true;
  [key: string]: any;

  game: any;
  data: any;
  palettes: any;
  save: any;
  party: any[];
  index: number;
  mon: any;
  entry: any;
  force: boolean;
  onDone?: (result: EvolutionResult) => void;
  oldSpecies: any;
  newSpecies: any;
  nick: any;
  newName: any;
  picCache: Record<string, LcdImage | false>;
  rounds: { wait: number; flashes: number }[];
  canceled: boolean;
  learned: any[];
  full: any[];
  balls: Ball[];
  ballFrame: number;
  showNew: boolean;
  blackout: boolean;
  phase: string | undefined;
  timer = 0;
  lines: string[] | null | undefined;

  /** Lua: EvolutionAnim.lua:100 */
  wantsFillScale(): boolean {
    return true;
  }

  /** Lua: EvolutionAnim.lua:101 */
  drawsWidescreen(): boolean {
    return true;
  }

  /** Lua: EvolutionAnim.lua:111 -- opts: mon, entry, index, party, save, force, onDone(result). */
  static new(game: any, opts?: EvolutionAnimOpts): EvolutionAnim {
    return new EvolutionAnim(game, opts);
  }

  constructor(game: any, opts?: EvolutionAnimOpts) {
    const o: EvolutionAnimOpts = opts || {};
    this.game = game;
    this.data = (game && game.data) || {};
    this.palettes = this.data.gen2Palettes;
    this.save = o.save || (game && game.save);
    this.party = o.party || (this.save && this.save.party) || [];
    this.index = o.index || 1;
    this.mon = o.mon || this.party[this.index - 1];
    this.entry = o.entry;
    this.force = o.force || false;
    this.onDone = o.onDone;

    this.oldSpecies = this.mon && this.mon.species;
    this.newSpecies = this.entry && this.entry.into;
    // wStringBuffer2 is filled with GetNickname BEFORE the animation.
    this.nick = or(or(this.mon && or(this.mon.nickname, this.mon.name), this.oldSpecies), "?");
    this.newName = Evolution.speciesName(this.data, this.newSpecies);

    this.picCache = {};
    this.rounds = Evolution.flashRounds();
    this.canceled = false;
    this.learned = [];
    this.full = [];
    this.balls = [];
    this.ballFrame = 0;
    // The box starts on the OLD pic and every round of flashing ends back on it.
    this.showNew = false;
    this.blackout = false;

    this.setPhase("evolving");
  }

  // ------------------------------------------------------------------ phases

  /** Lua: EvolutionAnim.lua:155 */
  playCry(species: any): any {
    if (!truthy(species)) return null;
    const cries = this.data.audio && this.data.audio.cries;
    if (!(cries && cries[species])) return null;
    return Sound.playCry(this.data, species);
  }

  /** Lua: EvolutionAnim.lua:163 -- ../pokecrystal/engine/pokemon/stats_screen.asm:1183-1195 */
  statused(): boolean {
    const mon = this.mon;
    if (!mon) return false;
    if ((mon.hp ?? 0) <= 0) return true;
    return mon.status === "sleep" || mon.status === "freeze";
  }

  /** Lua: EvolutionAnim.lua:171 -- ../pokecrystal/engine/movie/evolution_animation.asm:88-89 */
  startEvolutionMusic(): void {
    const songs = this.data.audio && this.data.audio.songs;
    if (songs && songs.Music_Evolution) {
      Music.play(this.data, "Music_Evolution", true, { reason: "evolution" });
    }
  }

  /** Lua: EvolutionAnim.lua:179 -- ../pokecrystal/home/pokemon.asm:124-127 */
  beginCry(species: any, after: () => void): void {
    this.crySrc = this.playCry(species);
    this.cryT = 0;
    this.cryAfter = after;
    this.cryWait = this.crySrc != null;
    if (!this.cryWait) return after();
  }

  /** Lua: EvolutionAnim.lua:187 */
  updateCry(): void {
    this.cryT = this.cryT + 1;
    const src = this.crySrc;
    const playing = src && src.isPlaying && src.isPlaying();
    if (this.cryT >= 3 && (!playing || this.cryT > 180)) {
      this.cryWait = false;
      this.crySrc = null;
      const after = this.cryAfter;
      this.cryAfter = null;
      if (after) after();
    }
  }

  /** Lua: EvolutionAnim.lua:199 */
  playSfx(name: string): void {
    const sfx = this.data.audio && this.data.audio.sfx;
    if (sfx && sfx[Sound.resolve(this.data, name)]) {
      Sound.play(this.data, name);
    }
  }

  /**
   * Lua: EvolutionAnim.lua:216 -- NOT `enter` (the stack's own lifecycle
   * hook would reset the machine the instant it was pushed).
   */
  setPhase(phase: string): void {
    this.phase = phase;
    this.timer = 0;

    if (phase === "evolving") {
      // PrintText EvolvingText, then `ld c, 50 / call DelayFrames`.
      this.lines = messageLines(EVOLVING_TEXT, this.nick);
      this.timer = Evolution.EVOLVING_FRAMES;
      return;
    }

    if (phase === "cry") {
      // ../pokecrystal/engine/movie/evolution_animation.asm:82-92
      Music.stop();
      this.timer = Evolution.MUSIC_FRAMES;
      if (this.statused()) return this.startEvolutionMusic();
      return this.beginCry(this.oldSpecies, () => {
        this.startEvolutionMusic();
      });
    }

    if (phase === "flash") {
      // GetSGBLayout with c = TRUE: PREDEFPAL_BLACKOUT for the whole burst.
      this.blackout = true;
      this.round = 1;
      this.step = "wait";
      this.timer = this.rounds[0]!.wait;
      this.swapsLeft = 0;
      return;
    }

    if (phase === "reveal") {
      // The final .ReplaceFrontpic commits the new pic and the colours arrive
      // on the same beat.
      this.blackout = false;
      this.showNew = !this.canceled;
      if (this.canceled) {
        // ../pokecrystal/engine/movie/evolution_animation.asm:151-158
        if (this.statused()) return this.setPhase("stopped");
        return this.beginCry(this.oldSpecies, () => {
          this.setPhase("stopped");
        });
      }
      this.playSfx("Sfx_Evolved");
      this.timer = Evolution.BALL_SPAWN_FRAMES + Evolution.BALL_TAIL_FRAMES;
      return;
    }

    // ../pokecrystal/engine/movie/evolution_animation.asm:113-130
    if (phase === "picAnim") {
      this.balls = [];
      this.picAnim = null;
      if (!this.statused()) {
        const [path, , vanilla] = this.picPath(this.newSpecies);
        this.picAnim = MonAnimView.start(
          this.speciesDef(this.newSpecies),
          this.mon,
          "evolve",
          (p: string) => this.image(p),
          () => {
            this.playCry(this.newSpecies);
          },
          {
            resolve: (sheet: string) => Sprites.pic(sheet, this.picCtx(this.newSpecies, "evolution_anim")),
            staticReplaced: MonAnimView.replaced(vanilla, path),
          },
        );
      }
      if (this.picAnim) return;
      if (this.statused()) return this.setPhase("congrats");
      return this.beginCry(this.newSpecies, () => {
        this.setPhase("congrats");
      });
    }

    if (phase === "stopped") {
      // CancelEvolution: StoppedEvolvingText over the pic, then ClearTilemap.
      this.lines = messageLines(STOPPED_TEXT, this.nick);
      this.timer = PROMPT_FRAMES;
      return;
    }

    if (phase === "congrats") {
      this.lines = messageLines(CONGRATS_TEXT, this.nick);
      this.timer = PROMPT_FRAMES;
      return;
    }

    if (phase === "paragraph") {
      // Paragraph clears the box and waits 20 frames before the next page.
      this.lines = null;
      this.timer = PARAGRAPH_FRAMES;
      return;
    }

    if (phase === "evolved") {
      // EvolvedIntoText, then MUSIC_NONE / SFX_CAUGHT_MON / WaitSFX and
      // `ld c, 40 / call DelayFrames`.
      this.lines = messageLines(EVOLVED_TEXT, this.newName);
      Music.stop();
      this.playSfx("Sfx_CaughtMon");
      this.timer = Evolution.CONGRATS_FRAMES;
      return;
    }

    if (phase === "learn") {
      // ClearTilemap, then the party slot is rewritten and LearnLevelMoves runs.
      this.commit();
      this.learnIndex = 0;
      return this.nextLearn();
    }

    if (phase === "done") {
      if (this.onDone) {
        this.onDone({
          canceled: this.canceled,
          evolved: this.evolved,
          learned: this.learned,
          full: this.full,
        });
      }
      const stack = this.game && this.game.stack;
      if (stack && stack.top && stack.top() === this) stack.pop();
      return;
    }
  }

  /** Lua: EvolutionAnim.lua:347 -- the writeback, all of it Evolution.apply's. */
  commit(): void {
    const evolved = Evolution.apply(this.data, this.mon, this.entry);
    if (!evolved) return;
    this.evolved = evolved;
    this.party[this.index - 1] = evolved;
    Evolution.markPokedex(this.save, evolved.species as any);
    // LearnLevelMoves at wCurPartyLevel (the level the mon already had).
    this.pending = Evolution.learnedOnEvolve(this.data, evolved.species, evolved.level as number, evolved);
  }

  /** Lua: EvolutionAnim.lua:359 */
  nextLearn(): void {
    this.learnIndex = (this.learnIndex || 0) + 1;
    const moveId = this.pending && this.pending[this.learnIndex - 1];
    if (!(truthy(moveId) && this.evolved)) {
      this.lines = null;
      return this.setPhase("done");
    }
    const moveDef = this.data.moves && this.data.moves[moveId];
    const moveName = or(moveDef && moveDef.name, moveId);
    const [ok, reason] = Mon.learnMove(this.evolved, moveId, this.data);
    if (ok) {
      this.learned.push(moveId);
      this.lines = messageLines(LEARNED_TEXT, this.nick, moveName);
    } else if (reason === "full") {
      if (this.game && this.game.learnMoveOn) {
        this.phase = "waitingLearn";
        return this.game.learnMoveOn(this.evolved, moveId, (learned: unknown) => {
          if (truthy(learned)) this.learned.push(moveId);
          else this.full.push(moveId);
          this.nextLearn();
        });
      }
      this.full.push(moveId);
      this.lines = messageLines(WANTS_TO_LEARN_TEXT, this.nick, moveName);
    } else {
      return this.nextLearn();
    }
    this.phase = "learn";
    this.timer = PROMPT_FRAMES;
  }

  // ------------------------------------------------------------------ update

  /**
   * Lua: EvolutionAnim.lua:400 -- .WaitFrames_CheckPressedB; .pressed_b only
   * while wForceEvolution is clear.
   */
  cancelPressed(input: any): boolean {
    if (this.force) return false;
    return (input && input.wasPressed("b")) || false;
  }

  /** Lua: EvolutionAnim.lua:405 */
  update(_dt?: number): void {
    const input = this.game && this.game.input;
    const phase = this.phase;
    // onDone has already fired.
    if (phase === "done") {
      const stack = this.game && this.game.stack;
      if (stack && stack.top && stack.top() === this) stack.pop();
      return;
    }

    if (phase === "waitingLearn") {
      const stack = this.game && this.game.stack;
      if (stack && stack.top && stack.top() === this) this.nextLearn();
      return;
    }

    // ../pokecrystal/home/pokemon.asm:124-127
    if (this.cryWait) return this.updateCry();

    if (phase === "flash") {
      return this.updateFlash(input);
    }

    if (phase === "reveal") {
      this.updateBalls();
      this.timer = this.timer - 1;
      // ../pokecrystal/engine/movie/evolution_animation.asm:113-114
      if (this.timer <= 0) this.setPhase("picAnim");
      return;
    }

    // ../pokecrystal/engine/gfx/pic_animation.asm:79-89
    if (phase === "picAnim") {
      if (this.picAnim && !this.picAnim.step()) return;
      this.picAnim = null;
      return this.setPhase("congrats");
    }

    this.timer = (this.timer || 0) - 1;
    const prompt = phase === "stopped" || phase === "congrats" || phase === "learn";
    if (prompt && input && (input.wasPressed("a") || input.wasPressed("b"))) {
      this.timer = 0;
    }
    if (this.timer > 0) return;

    if (phase === "evolving") return this.setPhase("cry");
    if (phase === "cry") return this.setPhase("flash");
    if (phase === "stopped") return this.setPhase("done");
    if (phase === "congrats") return this.setPhase("paragraph");
    if (phase === "paragraph") return this.setPhase("evolved");
    if (phase === "evolved") return this.setPhase("learn");
    if (phase === "learn") return this.nextLearn();
  }

  /**
   * Lua: EvolutionAnim.lua:463 -- one frame of the flash loop: a round is
   * .WaitFrames_CheckPressedB for its `c` frames, then .Flash b times (new
   * pic, back to old, a WaitBGMap apart).
   */
  updateFlash(input: any): void {
    const round = this.rounds[this.round - 1];
    if (!round) {
      return this.setPhase("reveal");
    }

    if (this.step === "wait") {
      if (this.cancelPressed(input)) {
        // .cancel_evo: wEvolutionCanceled, and the pic stays on the old stage.
        this.canceled = true;
        this.showNew = false;
        return this.setPhase("reveal");
      }
      this.timer = this.timer - 1;
      if (this.timer <= 0) {
        this.step = "flash";
        // Two swaps per flash: to the new pic and back.
        this.swapsLeft = round.flashes * 2;
        this.timer = Evolution.SWAP_FRAMES;
        this.showNew = true;
      }
      return;
    }

    // Each swap holds for one WaitBGMap.
    this.timer = this.timer - 1;
    if (this.timer > 0) return;
    this.swapsLeft = this.swapsLeft - 1;
    if (this.swapsLeft <= 0) {
      this.showNew = false;
      this.round = this.round + 1;
      const nextRound = this.rounds[this.round - 1];
      if (!nextRound) return this.setPhase("reveal");
      this.step = "wait";
      this.timer = nextRound.wait;
      return;
    }
    this.showNew = !this.showNew;
    this.timer = Evolution.SWAP_FRAMES;
  }

  // --------------------------------------------------------- balls of light

  /**
   * Lua: EvolutionAnim.lua:517 -- .balls_of_light spawns two balls on every
   * even wJumptableIndex over the 32 spawn frames; AnimSeq_RevealNewMon walks
   * each out (radius $10 by $08 to $80, angle xor $20 every frame).
   */
  updateBalls(): void {
    const frame = this.ballFrame;
    if (frame < Evolution.BALL_SPAWN_FRAMES && frame % 2 === 0) {
      // The angle is (post & %1110) << 1 with the POST-increment index.
      const post = frame + 1;
      const base = (((post % 16) - (post % 2)) * 2) % 256;
      for (const offset of [0x00, 0x10]) {
        if (this.balls.length < BALL_LIMIT) {
          this.balls.push({
            angle: (base + offset) % 256,
            radius: Evolution.BALL_RADIUS_START,
            age: 0,
          });
        }
      }
    }
    this.ballFrame = frame + 1;

    const alive: Ball[] = [];
    for (const ball of this.balls) {
      if (ball.radius < Evolution.BALL_RADIUS_END) {
        const radius = ball.radius;
        ball.radius = radius + Evolution.BALL_RADIUS_STEP;
        // `xor $20` on a six-bit angle is half a period.
        ball.angle = (ball.angle + 0x20) % 0x40;
        ball.y = EvolutionAnim.signed(SpriteAnims.sine(ball.angle, radius));
        ball.x = EvolutionAnim.signed(SpriteAnims.cosine(ball.angle, radius));
        ball.age = ball.age + 1;
        alive.push(ball);
      }
    }
    this.balls = alive;
  }

  /** Lua: EvolutionAnim.lua:557 -- the byte the ASM leaves in a, as signed. */
  static signed(value: number): number {
    value = ((value % 256) + 256) % 256;
    if (value >= 128) return value - 256;
    return value;
  }

  // -------------------------------------------------------------------- draw

  /** Lua: EvolutionAnim.lua:567 */
  speciesDef(species: any): any {
    return (truthy(species) && this.data.pokemon && this.data.pokemon[species]) || null;
  }

  /** Lua: EvolutionAnim.lua:571 */
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

  /** Lua: EvolutionAnim.lua:584 */
  picCtx(species: any, kind: string): any {
    return {
      species,
      side: "front",
      kind,
      mon: this.mon,
      data: this.data,
      shiny: !!(this.mon && truthy(this.mon.shiny)),
    };
  }

  /** Lua: EvolutionAnim.lua:595 */
  picPath(species: any): [string | undefined, boolean, string | undefined] {
    const def = this.speciesDef(species);
    const vanilla = def && def.spriteFront;
    const [path, trueColor] = Sprites.pic(vanilla, this.picCtx(species, "evolution"));
    return [path, trueColor, vanilla];
  }

  /** Lua: EvolutionAnim.lua:603 */
  pic(species: any): [LcdImage | null, boolean] {
    const [path, trueColor] = this.picPath(species);
    return [this.image(path), trueColor];
  }

  /**
   * Lua: EvolutionAnim.lua:612 -- the mon's own colours while the SGB layout
   * is c = FALSE, PREDEFPAL_BLACKOUT while it is TRUE.
   */
  picColors(species: any): any {
    if (this.blackout) return BLACKOUT;
    return Palettes.monColors(this.palettes, species, this.mon && this.mon.shiny);
  }

  /** Lua: EvolutionAnim.lua:618 */
  drawPic(): void {
    const species = this.showNew ? this.newSpecies : this.oldSpecies;
    let [image, trueColor] = this.pic(species);
    if (!image) return;
    let [w, h] = image.getDimensions();
    // ../pokecrystal/engine/gfx/pic_animation.asm:431-435
    let sheet: LcdImage | undefined;
    let quad: any;
    let size: number | undefined;
    if (this.picAnim) {
      const f = this.picAnim.frame();
      if (f) [sheet, quad, size] = f;
    }
    if (sheet) {
      w = size!;
      h = size!;
      trueColor = this.picAnim.trueColor;
    }
    // PlaceGraphic pads the pic into the 7x7 box bottom-first.
    const box = PIC_TILES * 8;
    const px = PIC_TILE_X * 8 + Math.floor((box - w) / 2);
    const py = PIC_TILE_Y * 8 + (box - h);
    G.setColor(1, 1, 1, 1);
    const colors = this.picColors(species);
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
   * Lua: EvolutionAnim.lua:652 -- the ball is drawn as the disc the two
   * gfx/evo bubble tiles are, alternating sizes every two frames, coloured
   * through GbcPalette.color.
   */
  drawBalls(): void {
    if (this.balls.length === 0) return;
    const colors = Palettes.monColors(this.palettes, this.newSpecies, this.evolved && this.evolved.shiny);
    const rgb = GbcPalette.color(colors, 3) || [0, 0, 0];
    G.setColor(rgb[0]! / 255, rgb[1]! / 255, rgb[2]! / 255, 1);
    for (const ball of this.balls) {
      const radius = Math.floor(ball.age / 2) % 2 === 0 ? 4 : 3;
      const cx = Evolution.BALL_ORIGIN_X + (ball.x || 0) + 4;
      const cy = Evolution.BALL_ORIGIN_Y + (ball.y || 0) + 4;
      G.circle("fill", cx, cy, radius);
      // NOT FAITHFUL: circles have no Gold screen form, so each ball is one
      // solid 8x8 object in the disc's colour (the cart's OAM ball is an 8x8
      // bubble tile; the two disc sizes collapse to the one square).
      const c: [number, number, number] = [rgb[0]!, rgb[1]!, rgb[2]!];
      G.push();
      G.palette = [c, c, c, c] as Palette4;
      putTile(SOLID[0], Math.round(cx - 4), Math.round(cy - 4), false, false, true);
      G.pop();
    }
    G.setColor(1, 1, 1, 1);
  }

  /**
   * Lua: EvolutionAnim.lua:673 -- the pic is on screen from .PlaceFrontpic to
   * ClearTilemap, so the congratulation text prints OVER the new mon.
   */
  drawPanel(): void {
    Chrome.clear();
    if (this.phase !== "evolving" && this.phase !== "learn") {
      this.drawPic();
      this.drawBalls();
    }
    if (this.lines) {
      Chrome.box(BOX_X, BOX_Y, BOX_W, BOX_H);
      this.lines.forEach((line, i) => {
        Chrome.print(line, TEXT_X, TEXT_Y + i * TEXT_LINE);
      });
    }
    G.setColor(1, 1, 1, 1);
  }

  /** Lua: EvolutionAnim.lua:688 */
  draw(): void {
    this.drawPanel();
  }

  /** Lua: EvolutionAnim.lua:692 */
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

export default EvolutionAnim;
