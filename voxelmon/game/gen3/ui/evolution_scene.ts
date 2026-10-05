// Port of gen1recomp src/ui/game3/evolution_scene.lua (GPLv3 + additional terms; see LICENSE.md).
// Dedicated Gen 3 Evolution Scene (pret evolution_scene.c & evolution_graphics.c).
// Handles visual starburst rays, sparkle particles, white silhouette pulse scaling,
// B-button cancellation, point-of-no-return mutation, audio choreography, and move learning.
//
// `package.loaded["src.ui.game3.choice"]` reads are the static import (always loaded).

/* eslint-disable @typescript-eslint/no-explicit-any */
import { tonumber } from "../../../import/gen3/lua.ts";
import { Stack } from "./stack.ts";
import { Display } from "../core/display.ts";
import { Message } from "./message.ts";
import { BattleChrome } from "./battle_chrome.ts";
import { Pokemon } from "../core/pokemon.ts";
import { Evolution } from "../core/evolution.ts";
import { Audio } from "../core/audio.ts";
import { LearnMove } from "../core/battle/learn_move.ts";
import { SE } from "../core/se_ids.ts";
import { Oam } from "../core/oam.ts";
import { RomText } from "../core/rom_text.ts";
import { Song } from "../core/song_ids.ts";
import { MonAnim, type MonSprite } from "../core/mon_anim.ts";
import { Choice } from "./choice.ts";
import { SummaryMenu } from "./summary_menu.ts";
import { G, type Shader } from "../platform/graphics.ts";
import type { Image } from "../platform/image.ts";
import { random } from "../platform/rng.ts";
import { len, remove, seq, ipairs, type LuaTable } from "../platform/lt.ts";
import { gsub, match } from "../platform/lpattern.ts";

interface Particle {
  x: number; y: number; kind: string; t: number; maxT: number; size: number;
  angle?: number; dist?: number; speed?: number; vx?: number; vy?: number;
}
type EvoSprite = MonSprite & { evoSpecies?: unknown };
interface Pic { image: Image; w: number; h: number }

export interface EvolutionSceneModule {
  open: boolean;
  _mon: any;
  _preSpecies: number | null;
  _postSpecies: number | null;
  _canStop: boolean;
  _session: any;
  _bag: any;
  _onDone: ((result: string, mon?: any) => void) | null | undefined;
  _state: string;
  _timer: number;
  _frame: number;
  _speed: number;
  _direction: number;
  _preScale: number;
  _postScale: number;
  _particles: (Particle | null)[];
  _flashAlpha: number;
  _bgAngle: number;
  _bgBrightness: number;
  _savedSong: any;
  _isBattle: boolean;
  _monAnim?: EvoSprite | null;
  _nick?: string | null;
  _autoCancel?: boolean;
  _via?: string;
  _headless?: boolean;
  _pendingYesNo?: ((yes: boolean) => void) | false | null;
  _learnWait?: number | null;
  _learnQueue?: LuaTable | null;
  _learnOpts?: any;
  _learnIdx?: number;
  isOpen(): boolean;
  start(mon: any, postSpecies: unknown, opts?: any): boolean;
  handleInput(input: any): void;
  update(dt?: number): void;
  draw(): void;
}

// Brian creates the shader at module load; here on first use (no top-level
// calls into other modules: the gen3 import cycle).
let silhouetteShader: Shader | null = null;
let silhouetteTried = false;
function silhouette(): Shader | null {
  if (!silhouetteTried) {
    silhouetteTried = true;
    // `love and love.graphics and love.graphics.newShader`: always here
    try {
      silhouetteShader = G.newShader("silhouette");
    } catch { /* pcall */ }
  }
  return silhouetteShader;
}

// Lua: evolution_scene.lua:57
function clean_string(s: unknown): string {
  if (typeof s !== "string") return "";
  return (match(gsub(s, "%z+", "")[0], "^%s*(.-)%s*$") as string | undefined) || "";
}

// pokefirered/src/sound.c:50
const NON_MAP_SONGS: Record<string, boolean> = {
  MUS_HEAL: true, MUS_LEVEL_UP: true, MUS_OBTAIN_ITEM: true, MUS_EVOLVED: true, MUS_OBTAIN_BADGE: true,
  MUS_OBTAIN_TMHM: true, MUS_OBTAIN_BERRY: true, MUS_EVOLUTION_INTRO: true, MUS_EVOLUTION: true,
  MUS_RS_VS_GYM_LEADER: true, MUS_RS_VS_TRAINER: true, MUS_SCHOOL: true, MUS_SLOTS_JACKPOT: true,
  MUS_SLOTS_WIN: true, MUS_MOVE_DELETED: true, MUS_TOO_BAD: true, MUS_DEX_RATING: true,
  MUS_OBTAIN_KEY_ITEM: true, MUS_POKE_FLUTE: true,
  // pokeemerald/src/sound.c:37
  MUS_AWAKEN_LEGEND: true, MUS_RG_POKE_FLUTE: true, MUS_RG_OBTAIN_KEY_ITEM: true, MUS_RG_DEX_RATING: true,
  MUS_OBTAIN_B_POINTS: true, MUS_OBTAIN_SYMBOL: true, MUS_REGISTER_MATCH_CALL: true,
};

// Lua: evolution_scene.lua:76
function is_fanfare_or_evo_song(idIn: unknown): boolean {
  const id = tonumber(idIn);
  if (id == null || id === 0 || id === 0xFFFF) return true;
  const name = Song.nameOf(id);
  return name != null && NON_MAP_SONGS[name] === true;
}

// pokefirered/src/evolution_scene.c:266
// Lua: evolution_scene.lua:88
function evo_pic(species: unknown): Pic | null {
  const mon = EvolutionScene._mon;
  return Pokemon.frontPic(Pokemon.picSpecies(species, mon && mon.personality), null, Pokemon.isShiny(mon),
    mon && mon.personality) as Pic | null;
}

// pokeemerald/src/evolution_scene.c:1674
// Lua: evolution_scene.lua:95
function evo_mon_anim(species: unknown): boolean {
  if (!MonAnim.enabled()) return false;
  if (EvolutionScene._monAnim) MonAnim.stop(EvolutionScene._monAnim);
  const sp = tonumber(species) ?? 0;
  const sprite: EvoSprite = MonAnim.run(MonAnim.newSprite(sp, { data: { 2: sp } }), { tasksFirst: false });
  sprite.evoSpecies = species;
  EvolutionScene._monAnim = sprite;
  MonAnim.doFront(sprite, sp, false, 0, { cry: (s, pan) => { try { (Audio as any).playCry(s, 0, pan); } catch { /* pcall */ } } });
  return true;
}

// Lua: evolution_scene.lua:107
function evo_anim_draw(species: unknown, pic: Pic | null, cx: number, cy: number): boolean {
  const sprite = EvolutionScene._monAnim;
  if (!(sprite && sprite.evoSpecies === species && pic && pic.image)) return false;
  const mon = EvolutionScene._mon;
  const f = MonAnim.framePic(Pokemon.picSpecies(species, mon && mon.personality), (sprite as any).frame, Pokemon.isShiny(mon));
  G.setColor(1, 1, 1, 1);
  MonAnim.draw(sprite, (f || pic).image, cx, cy);
  return true;
}

// Lua: evolution_scene.lua:190
function spawn_sparkle(kind?: string): void {
  const cx = 120, cy = 64;
  const p: Particle = {
    x: cx,
    y: cy,
    kind: kind || "spiral",
    t: 0,
    maxT: random(30, 50),
    angle: random() * Math.PI * 2,
    dist: random(40, 80),
    speed: random(1, 3),
    size: random(2, 4),
  };
  EvolutionScene._particles[len(EvolutionScene._particles) + 1] = p;
}

// Lua: evolution_scene.lua:206
function spawn_flash_spray(): void {
  const cx = 120, cy = 64;
  for (let i = 1; i <= 32; i++) {
    const angle = (i / 32) * Math.PI * 2 + (random() - 0.5) * 0.2;
    const speed = random(2, 5);
    EvolutionScene._particles[len(EvolutionScene._particles) + 1] = {
      x: cx,
      y: cy,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      kind: "spray",
      t: 0,
      maxT: random(25, 45),
      size: random(2, 5),
    };
  }
}

// Lua: evolution_scene.lua:224
function finish_scene(result: string): void {
  EvolutionScene.open = false;
  Stack.pop("evolution_scene");
  const cb = EvolutionScene._onDone;
  const mon = EvolutionScene._mon;
  const saved = EvolutionScene._savedSong ?? Audio._mapSong;
  EvolutionScene._onDone = null;
  EvolutionScene._mon = null;
  EvolutionScene._nick = null;
  EvolutionScene._pendingYesNo = null;
  EvolutionScene._learnWait = null;
  EvolutionScene._learnQueue = null;
  EvolutionScene._learnOpts = null;

  if (Message.close) Message.close();

  // Restore previous BGM (victory loop if after battle, or map song if from menu/field)
  if (saved != null) {
    if (!is_fanfare_or_evo_song(saved)) {
      Audio.playSong(saved);
    } else if (Audio._mapSong != null) {
      Audio.playSong(Audio._mapSong);
    }
  }

  if (cb) cb(result, mon);
}

// Lua: evolution_scene.lua:252
function open_pending_yesno(): void {
  if (EvolutionScene._pendingYesNo == null) return;
  // pokefirered/src/evolution_scene.c:912
  if (Message.isOpen && Message.isOpen()
      && !(Message.isWaiting && Message.isWaiting())) return;
  const cb = EvolutionScene._pendingYesNo;
  EvolutionScene._pendingYesNo = null;
  // pokefirered/src/evolution_scene.c:914
  Choice.yesNo((yes) => {
    if (Message.isOpen() && Message.close) Message.close();
    if (cb) cb(yes === true);
  }, { left: 24, top: 9, style: "battle" } as any);
}

// Lua: evolution_scene.lua:269
function learn_hooks(mon: any, displayName: string): any {
  return {
    mon,
    displayName,
    headless: EvolutionScene._headless,
    // pokefirered/src/evolution_scene.c:887
    battleText: true,
    pushMsg: (text: string, cb?: () => void) => {
      Message.show(text, { frame: "battle", done: cb });
    },
    askYesNo: (a: unknown, b: unknown) => {
      const cb = (typeof a === "function") ? a as (yes: boolean) => void : b as ((yes: boolean) => void) | undefined;
      const prompt = (typeof a === "string") ? a : null;
      if (prompt && prompt !== "") {
        Message.show(prompt, { frame: "battle", stay: true });
        EvolutionScene._pendingYesNo = cb || false;
        return;
      }
      EvolutionScene._pendingYesNo = null;
      Choice.yesNo((yes) => {
        if (cb) cb(yes === true);
      }, { left: 24, top: 9, style: "battle" } as any);
    },
    askForget: (_: unknown, cb?: (slot: number) => void, ctx?: any) => {
      // pokefirered/src/evolution_scene.c:971
      SummaryMenu.openMenu(seq(mon), 1, {
        mode: "select_move",
        moveToLearn: (ctx && ctx.moveId) || LearnMove._moveId,
        onSelectMove: (slotIdx: number) => {
          if (cb) cb(slotIdx);
        },
      });
    },
  };
}

// Lua: evolution_scene.lua:307
function learn_next(): void {
  if (!EvolutionScene.open) return;
  const q = EvolutionScene._learnQueue;
  EvolutionScene._learnIdx = (EvolutionScene._learnIdx || 0) + 1;
  const item = q && q[EvolutionScene._learnIdx];
  if (!item) {
    EvolutionScene._learnQueue = null;
    finish_scene("evolved");
    return;
  }
  const opts = EvolutionScene._learnOpts;
  LearnMove.begin({
    mon: opts.mon,
    moveId: item.moveId,
    displayName: opts.displayName,
    headless: opts.headless,
    battleText: opts.battleText,
    pushMsg: opts.pushMsg,
    askYesNo: opts.askYesNo,
    askForget: opts.askForget,
    onDone: (learned: unknown) => {
      if (learned && !EvolutionScene._headless) {
        // pokefirered/src/evolution_scene.c:871
        EvolutionScene._learnWait = 0x40;
      } else {
        learn_next();
      }
    },
  });
}

// Lua: evolution_scene.lua:338
function start_learn_moves(): void {
  const mon = EvolutionScene._mon;
  const level = tonumber(mon.level) ?? 1;
  const displayName = Pokemon.displayMonName(mon);

  EvolutionScene._pendingYesNo = null;
  EvolutionScene._learnWait = null;
  EvolutionScene._learnOpts = learn_hooks(mon, displayName);
  // pokefirered/src/pokemon.c:2288
  EvolutionScene._learnQueue = LearnMove.movesForLevels(mon, seq(level));
  EvolutionScene._learnIdx = 0;
  learn_next();
}

// Lua: evolution_scene.lua:594
function draw_starburst(cx: number, cy: number, radius: number, numRays: number, angle: number, color1: number[], _color2: number[]): void {
  const step = (Math.PI * 2) / numRays;
  for (let i = 0; i <= numRays - 1; i++) {
    const a1 = angle + i * step;
    const a2 = a1 + step * 0.5;
    const x1 = cx + Math.cos(a1) * radius;
    const y1 = cy + Math.sin(a1) * radius;
    const x2 = cx + Math.cos(a2) * radius;
    const y2 = cy + Math.sin(a2) * radius;
    G.setColor(color1);
    G.polygon("fill", cx, cy, x1, y1, x2, y2);
  }
}

export const EvolutionScene: EvolutionSceneModule = {
  open: false,
  _mon: null,
  _preSpecies: null,
  _postSpecies: null,
  _canStop: true,
  _session: null,
  _bag: null,
  _onDone: null,
  _state: "idle",
  _timer: 0,
  _frame: 0,
  _speed: 8,
  _direction: 0,
  _preScale: 1.0,
  _postScale: 0.0625,
  _particles: [null],
  _flashAlpha: 0,
  _bgAngle: 0,
  _bgBrightness: 0,
  _savedSong: null,
  _isBattle: false,

  // Lua: evolution_scene.lua:83
  isOpen(): boolean {
    return EvolutionScene.open;
  },

  /**
   * Start an evolution scene.
   * opts: { canStop, session, bag, isBattle, savedSong, onDone }
   */
  // Lua: evolution_scene.lua:122
  start(mon: any, postSpecies: unknown, opts?: any): boolean {
    opts = opts || {};
    if (!mon || postSpecies == null || postSpecies === false) {
      if (opts.onDone) opts.onDone("error");
      return false;
    }

    EvolutionScene.open = true;
    EvolutionScene._monAnim = null;
    EvolutionScene._mon = mon;
    EvolutionScene._preSpecies = Pokemon.speciesOf(mon) || 1;
    EvolutionScene._postSpecies = (Pokemon.speciesFromName(postSpecies) || tonumber(postSpecies) || EvolutionScene._preSpecies) as number;
    // pokefirered/src/evolution_scene.c:256
    let nick = clean_string(mon.nickname);
    if (nick === "") nick = clean_string(Pokemon.name(EvolutionScene._preSpecies));
    EvolutionScene._nick = nick !== "" ? nick : "POK\xC3\xA9MON";
    EvolutionScene._canStop = opts.canStop !== false;
    // pokefirered/src/evolution_scene.c:641
    EvolutionScene._autoCancel = opts.autoCancel ? true : false;
    EvolutionScene._session = opts.session;
    EvolutionScene._bag = opts.bag;
    EvolutionScene._via = opts.via;
    EvolutionScene._onDone = opts.onDone;
    EvolutionScene._isBattle = opts.isBattle ? true : false;
    EvolutionScene._headless = opts.headless ? true : false;

    let saved = opts.savedSong;
    if (saved == null || saved === false || is_fanfare_or_evo_song(saved)) {
      if (Audio._currentSong && !is_fanfare_or_evo_song(Audio._currentSong.id)) {
        saved = Audio._currentSong.id;
      }
    }
    if (saved == null || saved === false || is_fanfare_or_evo_song(saved)) {
      saved = Audio._mapSong;
    }
    EvolutionScene._savedSong = saved;

    EvolutionScene._state = "fade_in";
    EvolutionScene._timer = 0;
    EvolutionScene._frame = 0;
    EvolutionScene._speed = 8;
    EvolutionScene._direction = 0;
    EvolutionScene._preScale = 1.0;
    EvolutionScene._postScale = 0.0625;
    EvolutionScene._particles = [null];
    EvolutionScene._flashAlpha = 0;
    EvolutionScene._bgAngle = 0;
    EvolutionScene._bgBrightness = 0;

    // Ensure OAM is cleared so no party menu/field sprites linger
    Oam.destroyAll();

    // Ensure BattleChrome is installed
    if (!(BattleChrome as any)._installed) {
      BattleChrome.install(null);
    }

    // Ensure pre-evolution and post-evolution pics are cached
    evo_pic(EvolutionScene._preSpecies);
    evo_pic(EvolutionScene._postSpecies);

    // Open message box in battle frame
    if (Message.setFrame) Message.setFrame("battle");

    Stack.push("evolution_scene", EvolutionScene, { hideBelow: true, fullscreen: true });
    return true;
  },

  // Lua: evolution_scene.lua:352
  handleInput(input: any): void {
    if (!EvolutionScene.open) return;

    if (Choice && Choice.active) {
      // pokefirered/src/evolution_scene.c:925
      if (input.wasPressed("up")) {
        if (Choice.cursor !== 1) Choice.move(-1);
      } else if (input.wasPressed("down")) {
        if (Choice.cursor === 1) Choice.move(1);
      } else if (input.wasPressed("a")) {
        Choice.confirm();
      } else if (input.wasPressed("b")) {
        Choice.cancel();
      }
      return;
    }

    // B-Button Cancellation during CYCLE_SPRITES before T_speed >= 128
    if (EvolutionScene._state === "cycle" && EvolutionScene._canStop && EvolutionScene._speed < 128) {
      if (input.isDown("b") || input.wasPressed("b")) {
        EvolutionScene._state = "cancel";
        EvolutionScene._timer = 0;
        Audio.playSong(0);
        try { Audio.playSe(SE.SE_NOT_EFFECTIVE ?? 2); } catch { /* pcall */ }
        const fromName = Pokemon.displayMonName(EvolutionScene._mon);
        // pokefirered/src/evolution_scene.c:857
        Message.show(RomText.box("gText_PkmnStoppedEvolving", { stringVars: seq(fromName) }), { frame: "battle" });
        return;
      }
    }

    // Advance dialogue on A or B during text states
    if (EvolutionScene._state === "congrats" || EvolutionScene._state === "cancel" || EvolutionScene._state === "learn_moves") {
      if (input.wasPressed("a") || input.wasPressed("b") || input.wasPressed("start")) {
        if (Message.isOpen && Message.isOpen()) {
          if (Message.isWaiting && Message.isWaiting()) {
            Message.advance();
          } else {
            Message.skipReveal();
          }
        }
        if (!(Message.isOpen && Message.isOpen())) {
          if (EvolutionScene._state === "congrats") {
            EvolutionScene._state = "learn_moves";
            // Restore saved music immediately when congratulations message advances (1:1 pret pokefirered)
            const saved = EvolutionScene._savedSong ?? Audio._mapSong;
            if (saved != null) {
              if (!is_fanfare_or_evo_song(saved)) {
                Audio.playSong(saved);
              } else if (Audio._mapSong != null) {
                Audio.playSong(Audio._mapSong);
              }
            }
            start_learn_moves();
          } else if (EvolutionScene._state === "cancel") {
            finish_scene("stopped");
          }
        }
      }
    }
  },

  // Lua: evolution_scene.lua:415
  update(_dt?: number): void {
    if (!EvolutionScene.open) return;
    EvolutionScene._frame = EvolutionScene._frame + 1;
    EvolutionScene._bgAngle = (EvolutionScene._bgAngle + 0.02) % (Math.PI * 2);

    if (EvolutionScene._state === "learn_moves") {
      open_pending_yesno();
    }

    if (Message.isOpen && Message.isOpen()) {
      Message.tick();
    }

    if (EvolutionScene._state === "learn_moves") {
      if (LearnMove.busy()) {
        LearnMove.pump();
      } else if (EvolutionScene._learnWait != null && !(Message.isOpen && Message.isOpen())) {
        // pokefirered/src/evolution_scene.c:876
        EvolutionScene._learnWait = EvolutionScene._learnWait - 1;
        if (EvolutionScene._learnWait <= 0) {
          EvolutionScene._learnWait = null;
          learn_next();
        }
      }
    }

    // Update particles
    for (let i = len(EvolutionScene._particles); i >= 1; i--) {
      const p = EvolutionScene._particles[i]!;
      p.t = p.t + 1;
      if (p.kind === "spiral") {
        p.angle = p.angle! + 0.1;
        p.dist = Math.max(0, p.dist! - p.speed!);
        p.x = 120 + Math.cos(p.angle) * p.dist;
        p.y = 64 + Math.sin(p.angle) * p.dist;
      } else if (p.kind === "spray") {
        p.x = p.x + (p.vx || 0);
        p.y = p.y + (p.vy || 0);
      }
      if (p.t >= p.maxT || (p.kind === "spiral" && p.dist! <= 2)) {
        remove(EvolutionScene._particles, i);
      }
    }

    // pokefirered/src/evolution_scene.c:641
    if (EvolutionScene._autoCancel && EvolutionScene._state === "cycle") {
      EvolutionScene._state = "cancel";
      EvolutionScene._timer = 0;
      Audio.playSong(0);
      // pokefirered/src/battle_message.c:1277 gText_EllipsisQuestionMark
      Message.show(RomText.box("gText_EllipsisQuestionMark"), { frame: "battle" });
      return;
    }

    const st = EvolutionScene._state;

    if (st === "fade_in") {
      EvolutionScene._timer = EvolutionScene._timer + 1;
      if (EvolutionScene._timer >= 16) {
        EvolutionScene._state = "intro_msg";
        EvolutionScene._timer = 0;
        const fromName = Pokemon.displayMonName(EvolutionScene._mon);
        // pokefirered/src/evolution_scene.c:678
        Message.show(RomText.box("gText_PkmnIsEvolving", { stringVars: seq(fromName) }), { frame: "battle" });
      }
    } else if (st === "intro_msg") {
      EvolutionScene._timer = EvolutionScene._timer + 1;
      if (EvolutionScene._timer >= 45) {
        EvolutionScene._state = "intro_cry";
        EvolutionScene._timer = 0;
        if (!evo_mon_anim(EvolutionScene._preSpecies)) Audio.playCry(EvolutionScene._preSpecies);
      }
    } else if (st === "intro_cry") {
      EvolutionScene._timer = EvolutionScene._timer + 1;
      const ma = EvolutionScene._monAnim;
      // pokeemerald/src/evolution_scene.c:676
      if (ma && MonAnim.busy(ma)) EvolutionScene._timer = 0;
      if (EvolutionScene._timer >= (ma ? 1 : 40)) {
        EvolutionScene._state = "intro_sound";
        EvolutionScene._timer = 0;
        Audio.playSong(Song.MUS_EVOLUTION_INTRO, { loop: false });
      }
    } else if (st === "intro_sound") {
      EvolutionScene._timer = EvolutionScene._timer + 1;
      if (EvolutionScene._timer >= 35) {
        EvolutionScene._state = "start_music";
        EvolutionScene._timer = 0;
        Audio.playSong(Song.MUS_EVOLUTION, { restart: true, loop: true });
      }
    } else if (st === "start_music") {
      EvolutionScene._timer = EvolutionScene._timer + 1;
      EvolutionScene._bgBrightness = Math.min(1.0, EvolutionScene._timer / 20);
      if (EvolutionScene._timer >= 20) {
        EvolutionScene._state = "cycle";
        EvolutionScene._timer = 0;
        EvolutionScene._speed = 8;
        EvolutionScene._direction = 0;
        EvolutionScene._preScale = 1.0;
        EvolutionScene._postScale = 0.0625;
      }
    } else if (st === "cycle") {
      EvolutionScene._timer = EvolutionScene._timer + 1;
      if (EvolutionScene._frame % 3 === 0) {
        spawn_sparkle("spiral");
      }

      const spd = EvolutionScene._speed / 256;
      if (EvolutionScene._direction === 0) {
        // Pre-evo shrinks, Post-evo grows
        EvolutionScene._preScale = Math.max(0.0625, EvolutionScene._preScale - spd);
        EvolutionScene._postScale = Math.min(1.0, EvolutionScene._postScale + spd);
        if (EvolutionScene._preScale <= 0.0625 && EvolutionScene._postScale >= 1.0) {
          EvolutionScene._direction = 1;
          EvolutionScene._speed = EvolutionScene._speed + 2;
        }
      } else {
        // Pre-evo grows, Post-evo shrinks
        EvolutionScene._preScale = Math.min(1.0, EvolutionScene._preScale + spd);
        EvolutionScene._postScale = Math.max(0.0625, EvolutionScene._postScale - spd);
        if (EvolutionScene._preScale >= 1.0 && EvolutionScene._postScale <= 0.0625) {
          EvolutionScene._direction = 0;
          EvolutionScene._speed = EvolutionScene._speed + 2;
        }
      }

      // Acceleration cutoff -> Point of no return
      if (EvolutionScene._speed >= 128) {
        EvolutionScene._state = "flash_reveal";
        EvolutionScene._timer = 0;
        EvolutionScene._flashAlpha = 1.0;
        EvolutionScene._preScale = 0;
        EvolutionScene._postScale = 1.0;

        // Stop evolution BGM on burst (pokefirered m4aMPlayAllStop)
        Audio.playSong(0);

        // POINT OF NO RETURN: Mutate species, stats, nickname, dex, Shedinja now
        Evolution.apply(EvolutionScene._mon, EvolutionScene._postSpecies, EvolutionScene._session, EvolutionScene._bag, EvolutionScene._via);

        try { Audio.playSe(SE.SE_M_PETAL_DANCE ?? 195); } catch { /* pcall */ }
        spawn_flash_spray();
      }
    } else if (st === "flash_reveal") {
      EvolutionScene._timer = EvolutionScene._timer + 1;
      EvolutionScene._flashAlpha = Math.max(0, 1.0 - (EvolutionScene._timer / 15));
      if (EvolutionScene._timer >= 30) {
        EvolutionScene._state = "evo_cry";
        EvolutionScene._timer = 0;
        if (!evo_mon_anim(EvolutionScene._postSpecies)) Audio.playCry(EvolutionScene._postSpecies);
      }
    } else if (st === "evo_cry") {
      EvolutionScene._timer = EvolutionScene._timer + 1;
      if (EvolutionScene._timer >= 45) {
        EvolutionScene._state = "congrats";
        EvolutionScene._timer = 0;
        Audio.stopCry();
        Audio.playFanfare(Song.MUS_EVOLVED);

        const fromName = EvolutionScene._nick || clean_string(Pokemon.name(EvolutionScene._preSpecies));
        const intoName = Pokemon.name(EvolutionScene._postSpecies) || "POK\xC3\xA9MON";
        // pokefirered/src/evolution_scene.c:775
        Message.show(RomText.box("gText_CongratsPkmnEvolved", { stringVars: seq(fromName, intoName) }),
          { frame: "battle" });
      }
    } else if (st === "cancel") {
      // Handled via handleInput
    } else if (st === "learn_moves") {
      // Handled via LearnMove callbacks
    }
  },

  // Lua: evolution_scene.lua:609
  draw(): void {
    if (!EvolutionScene.open) return;

    // 1. Draw plain battle background (clean wallpaper without platform blotches)
    BattleChrome.drawCleanBg("building");

    const cx = 120, cy = 64;

    // 2. Draw animated starburst background when music active
    if (EvolutionScene._bgBrightness > 0) {
      const b = EvolutionScene._bgBrightness;
      const c1 = [0.15 * b, 0.45 * b, 0.85 * b, 0.85 * b];
      const c2 = [0.05 * b, 0.15 * b, 0.40 * b, 0.70 * b];
      G.setColor(c2);
      G.rectangle("fill", 0, 0, Display.W, 112);
      draw_starburst(cx, cy, 200, 16, EvolutionScene._bgAngle, c1, c2);
    }

    // 3. Draw sparkle particles
    for (const [, p] of ipairs<Particle>(EvolutionScene._particles)) {
      const alpha = Math.min(1.0, (p.maxT - p.t) / 10);
      G.setColor(1, 1, 0.8, alpha);
      G.circle("fill", p.x, p.y, p.size || 2);
    }

    // 4. Draw Pokémon sprites (silhouette or full color)
    const st = EvolutionScene._state;
    const prePic = evo_pic(EvolutionScene._preSpecies);
    const postPic = evo_pic(EvolutionScene._postSpecies);

    if (st === "cycle") {
      // Solid white silhouette shader
      const silhouetteShader = silhouette();
      if (silhouetteShader) {
        G.setShader(silhouetteShader);
      }
      G.setColor(1, 1, 1, 1);

      if (prePic && prePic.image && EvolutionScene._preScale > 0.05) {
        const s = EvolutionScene._preScale;
        G.draw(prePic.image, cx, cy, 0, s, s, 32, 32);
      }
      if (postPic && postPic.image && EvolutionScene._postScale > 0.05) {
        const s = EvolutionScene._postScale;
        G.draw(postPic.image, cx, cy, 0, s, s, 32, 32);
      }

      if (silhouetteShader) {
        G.setShader();
      }
    } else if (st === "cancel" || st === "fade_in" || st === "intro_msg" || st === "intro_cry" || st === "intro_sound" || st === "start_music") {
      // Normal pre-evolution sprite
      if (evo_anim_draw(EvolutionScene._preSpecies, prePic, cx, cy)) {
        // drawn by the mon anim
      } else if (prePic && prePic.image) {
        G.setColor(1, 1, 1, 1);
        G.draw(prePic.image, cx, cy, 0, 1, 1, 32, 32);
      }
    } else {
      // Normal post-evolution sprite (flash_reveal, evo_cry, congrats, learn_moves)
      if (evo_anim_draw(EvolutionScene._postSpecies, postPic, cx, cy)) {
        // drawn by the mon anim
      } else if (postPic && postPic.image) {
        G.setColor(1, 1, 1, 1);
        G.draw(postPic.image, cx, cy, 0, 1, 1, 32, 32);
      }
    }

    // 5. Full white flash overlay
    if (EvolutionScene._flashAlpha > 0) {
      G.setColor(1, 1, 1, EvolutionScene._flashAlpha);
      G.rectangle("fill", 0, 0, Display.W, 112);
    }

    // 6. Battle panel chrome & message window
    BattleChrome.drawPanel("none");
    if (Message.isOpen && Message.isOpen()) {
      Message.draw();
    }

    if (Choice && Choice.active && Choice.draw) {
      Choice.draw();
    }

    G.setColor(1, 1, 1, 1);
  },
};

export default EvolutionScene;
