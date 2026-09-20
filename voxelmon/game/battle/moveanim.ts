// The battle move animations — beams, blobs, rings, projectiles.
//
// Ports gen1recomp src/battle/AnimPlayer.lua, which reimplements pokered's
// subanimation player (engine/battle/animations.asm):
//
//   PlayAnimation (:164)     walks a move's rows: subanimation rows (a
//                            tileset + per-frame-block delay) and 2-byte
//                            special-effect rows (SE_*).
//   LoadSubanimation (:270)  resolves the subanimation type into a
//                            transform: on the PLAYER's turn every type but
//                            ENEMY plays untransformed and ENEMY plays
//                            HFLIP'd; on the ENEMY's turn the type applies
//                            as-is and ENEMY plays untransformed. REVERSE
//                            plays the frame-block list back to front.
//   PlaySubanimation (:580)  draws each frame block at its base coordinate,
//                            from an OAM cursor that resets per row.
//   DrawFrameBlock (:3)      the per-tile transforms, in 8-bit OAM space.
//
// The whole move is compiled ONCE into a list of timed steps (each a frame
// count and the sprites visible for it) plus the events the rest of the
// battle has to react to -- sounds, screen flashes, pic slides. Playback is
// then just a cursor, which is what makes this cheap enough to run on the
// 3DS while the scene draws.
//
// Coordinates stay in the Game Boy's OAM space (screen x + 8, y + 16), 8x8
// tiles: the renderer maps that onto the battle view.

/** One 8x8 sprite of a frame, in OAM space. */
export interface AnimSprite {
  x: number;
  y: number;
  /** Tile within the row's tileset sheet. */
  tile: number;
  ts: number;
  xf: boolean;
  yf: boolean;
  /** Which hardware palette it rendered through; see the OBP notes below. */
  obp: "e4" | "f0" | "f0x" | "obp1";
}

export interface AnimStep {
  dur: number;
  sprites: AnimSprite[];
}

export interface AnimEvent {
  /** A special effect the battle has to perform (SE_*), if any. */
  effect?: string;
  /** A move id whose MoveSoundTable entry plays as the row starts. */
  sound?: number;
  frame: number;
  dur?: number;
}

/** The tables voxelmon/import/stages/battle-anims.ts extracts. */
export interface AnimData {
  anims: Record<string, ({ sub: number; tileset: number; delay: number; sound: number | null }
    | { effect: string; sound: number | null })[]>;
  subanims: { type: string; blocks: { block: number; base: number; mode: number }[] }[];
  frameBlocks: { y: number; x: number; tile: number; attrs: number }[][];
  baseCoords: [number, number][];
  tilesets: { tiles: number; gfx: string }[];
}

/** Fallback pacing for a special effect with no measured length. */
const SE_PAUSE_FRAMES = 8;

/**
 * Frames each special-effect routine blocks the animation for
 * (engine/battle/animations.asm, counted from the routines' DelayFrames).
 * 0 is a bare register write.
 */
const SE_FRAMES: Record<string, number> = {
  SE_DARK_SCREEN_FLASH: 4, // AnimationFlashScreen: 2f inverted + 2f white
  SE_FLASH_SCREEN_LONG: 48, // 12 palettes x (2f + 1f + 1f) over 3 cycles
  SE_DARK_SCREEN_PALETTE: 0, // SetAnimationBGPalette writes
  SE_LIGHT_SCREEN_PALETTE: 0,
  SE_DARKEN_MON_PALETTE: 0,
  SE_RESET_SCREEN_PALETTE: 0,
  SE_SHAKE_SCREEN: 72, // PredefShakeScreenHorizontally b=8: sum 9f
  SE_SHAKE_ENEMY_HUD: 44, // 8 x (2f + 2f) SCX shake + setup Delay3s
  SE_DELAY_ANIMATION_10: 10,
  SE_SLIDE_MON_OFF: 24, // 8 tile steps x 3f (wSlideMonDelay)
  SE_SLIDE_ENEMY_MON_OFF: 24,
  SE_SLIDE_MON_HALF_OFF: 19, // 4 tile steps x 4f + Delay3
  SE_SLIDE_MON_UP: 14, // 7 row shifts x 2f (cyclic wrap)
  SE_SLIDE_MON_DOWN: 21, // 7 rows x Delay3
  SE_SLIDE_MON_DOWN_AND_HIDE: 19, // 2 x 8f + Delay3
  SE_MOVE_MON_HORIZONTALLY: 3,
  SE_RESET_MON_POSITION: 3,
  SE_SHAKE_BACK_AND_FORTH: 96, // 16 loops x 2 redraws x Delay3
  SE_BOUNCE_UP_AND_DOWN: 108, // 5 x AnimationSlideMonDown + Delay3
  SE_SQUISH_MON_PIC: 26, // 4 loops x 2 x Delay3 + 2f
  SE_MINIMIZE_MON: 6,
  SE_SHOW_MON_PIC: 3,
  SE_SHOW_ENEMY_MON_PIC: 3,
  SE_HIDE_MON_PIC: 3,
  SE_HIDE_ENEMY_MON_PIC: 3,
  SE_BLINK_MON: 60, // 6 x (5f off + 5f on)
  SE_BLINK_ENEMY_MON: 60,
  SE_FLASH_MON_PIC: 4,
  SE_FLASH_ENEMY_MON_PIC: 4,
  SE_TRANSFORM_MON: 4,
  SE_SUBSTITUTE_MON: 3,
  SE_WAVY_SCREEN: 255, // AnimationWavyScreen: ld c, $ff frames
};

/**
 * data/battle_anims/special_effects.asm AnimationIdSpecialEffects: extra
 * work after every frame block, keyed on the move. "flash" is
 * AnimationFlashScreen each time.
 */
const ANIM_ID_FX: Record<string, string> = {
  MEGA_PUNCH: "flash",
  GUILLOTINE: "flash",
  MEGA_KICK: "flash",
  HEADBUTT: "flash",
  DISABLE: "flash",
  BUBBLEBEAM: "flash",
  REFLECT: "flash",
  SPORE: "flash",
  BLIZZARD: "blizzard", // flash at counters 13/9/5/1
  HYPER_BEAM: "every4",
  THUNDERBOLT: "every8",
  SELFDESTRUCT: "explode",
  EXPLOSION: "explode",
  ROCK_SLIDE: "rockslide", // 1px rumble at 8-11, flash at 1
};

// Anim tiles load at vSprites tile $31 (LoadMoveAnimationTiles), so the VRAM
// ids the emitter routines poke into OAM are sheet tile (id - $31).
const BALL_TILE = 0x7a - 0x31;
const DROPLET_TILE = 0x71 - 0x31;
const LEAF_TILE = 0x37 - 0x31;
const PETAL_TILE = 0x71 - 0x31;

const wrap = (v: number): number => ((v % 256) + 256) % 256;

/** engine/battle/animations.asm GetSubanimationTransform1/2. */
function resolveTransform(subType: string, attackerIsPlayer: boolean): string {
  if (subType === "ENEMY") return attackerIsPlayer ? "HFLIP" : "NORMAL";
  return attackerIsPlayer ? "NORMAL" : subType;
}

// ---------------------------------------------------------------------------
// Sprite-emitter effects, compiled to per-frame steps. Coordinates are OAM
// space like the frame blocks; `obp` marks which hardware palette the routine
// ran under ("e4" ambient rOBP0, "f0" wAnimPalette on SGB, "obp1" rOBP1).
// ---------------------------------------------------------------------------

/** SpiralBallAnimationCoordinates (y, x). */
const SPIRAL_COORDS: [number, number][] = [
  [0x38, 0x28], [0x40, 0x18], [0x50, 0x10], [0x60, 0x18], [0x68, 0x28], [0x60, 0x38],
  [0x50, 0x40], [0x40, 0x38], [0x40, 0x28], [0x46, 0x1e], [0x50, 0x18], [0x5b, 0x1e],
  [0x60, 0x28], [0x5b, 0x32], [0x50, 0x38], [0x46, 0x32], [0x48, 0x28], [0x50, 0x20],
  [0x58, 0x28], [0x50, 0x30], [0x50, 0x28],
];

/**
 * AnimationSpiralBallsInward (:1480): three balls walk the spiral, one entry
 * per five frames, anchored at (0,0) for the player and (y-40, x+80) for the
 * enemy; ends with a screen flash.
 */
function spiralBallSteps(attackerIsPlayer: boolean): AnimStep[] {
  const by = attackerIsPlayer ? 0 : -40;
  const bx = attackerIsPlayer ? 0 : 80;
  const steps: AnimStep[] = [];
  for (let k = 0; k < SPIRAL_COORDS.length - 2; k++) {
    const sprites: AnimSprite[] = [];
    for (let i = 0; i < 3; i++) {
      const c = SPIRAL_COORDS[k + i];
      sprites.push({
        x: wrap(bx + c[1]),
        y: wrap(by + c[0]),
        tile: BALL_TILE,
        ts: 0,
        xf: false,
        yf: false,
        obp: "e4",
      });
    }
    steps.push({ dur: 5, sprites });
  }
  return steps;
}

/**
 * _AnimationShootBallsUpward (:1638): a pillar of `n` balls at `x`, each
 * rising 4px a frame from baseY + 8*i and vanishing at baseY + 8.
 */
function shootPillarSteps(steps: AnimStep[], n: number, x: number, baseY: number): void {
  const ys: (number | null)[] = [];
  for (let i = 1; i <= n; i++) ys.push(baseY + 8 * i);
  const snapshot = (): AnimSprite[] =>
    ys
      .filter((y): y is number => y !== null)
      .map((y) => ({ x, y: wrap(y), tile: BALL_TILE, ts: 0, xf: false, yf: false, obp: "e4" as const }));
  steps.push({ dur: 1, sprites: snapshot() }); // the init DelayFrame
  let alive = n;
  while (alive > 0) {
    for (let i = 0; i < n; i++) {
      const y = ys[i];
      if (y === null) continue;
      if (y === baseY + 8) {
        ys[i] = null;
        alive -= 1;
      } else {
        ys[i] = y - 4;
      }
    }
    steps.push({ dur: 1, sprites: snapshot() });
  }
}

/** AnimationShootBallsUpward (:1617): one 5-ball pillar. */
function shootBallsSteps(attackerIsPlayer: boolean): AnimStep[] {
  const steps: AnimStep[] = [];
  if (attackerIsPlayer) shootPillarSteps(steps, 5, 5 * 8, 6 * 8);
  else shootPillarSteps(steps, 5, 16 * 8, 0);
  return steps;
}

/** AnimationShootManyBallsUpward (:1686): six sequential 4-ball pillars. */
function shootManyBallsSteps(attackerIsPlayer: boolean): AnimStep[] {
  const xs = attackerIsPlayer
    ? [0x10, 0x40, 0x28, 0x18, 0x38, 0x30]
    : [0x60, 0x90, 0x78, 0x68, 0x88, 0x80];
  const baseY = attackerIsPlayer ? 0x50 : 0x28;
  const steps: AnimStep[] = [];
  for (const x of xs) shootPillarSteps(steps, 4, x, baseY);
  return steps;
}

/**
 * AnimationWaterDropletsEverywhere (:1114): 64 one-frame passes of droplet
 * rows. The 8-bit x cursor persists across passes, which is what makes the
 * field scroll.
 */
function waterDropletSteps(): AnimStep[] {
  const steps: AnimStep[] = [];
  let baseX = 0xf0; // ld a, -16
  for (let pass = 0; pass < 32; pass++) {
    for (const startY of [16, 24]) {
      const sprites: AnimSprite[] = [];
      let y = startY;
      for (;;) {
        baseX = wrap(baseX + 27);
        sprites.push({ x: baseX, y, tile: DROPLET_TILE, ts: 0, xf: false, yf: false, obp: "e4" });
        if (baseX >= 144) {
          baseX = wrap(baseX - 168);
          y += 16;
          if (y >= 112) break;
        }
      }
      steps.push({ dur: 1, sprites });
    }
  }
  return steps;
}

// AnimationFallingObjects (:2335): the sway tables.
const FALLING_X = [
  0x38, 0x40, 0x50, 0x60, 0x70, 0x88, 0x90, 0x56, 0x67, 0x4a,
  0x77, 0x84, 0x98, 0x32, 0x22, 0x5c, 0x6c, 0x7d, 0x8e, 0x99,
];
const FALLING_M = [
  0x00, 0x84, 0x06, 0x81, 0x02, 0x88, 0x01, 0x83, 0x05, 0x89,
  0x09, 0x80, 0x07, 0x87, 0x03, 0x82, 0x04, 0x85, 0x08, 0x86,
];
const FALLING_DX = [0, 1, 3, 5, 7, 9, 11, 13, 15];

/**
 * AnimationFallingObjects: `n` objects fall 2px per 3-frame tick, swaying by
 * the delta-X table (the index advances each tick and the direction flips
 * past index 8), until the first reaches y = 104.
 */
function fallingObjectSteps(n: number, tile: number, obp: AnimSprite["obp"]): AnimStep[] {
  const objs = [];
  for (let i = 0; i < n; i++) {
    objs.push({ y: i === 0 ? 0 : 8 * (i + 1), x: FALLING_X[i], m: FALLING_M[i], xf: false });
  }
  const steps: AnimStep[] = [];
  while (objs[0].y !== 104) {
    const sprites: AnimSprite[] = [];
    for (const o of objs) {
      // FallingObjects_UpdateMovementByte runs before the OAM update
      let left = o.m >= 0x80;
      let idx = (o.m % 0x80) + 1;
      if (idx === 9) {
        left = !left;
        idx = 0;
      }
      o.m = (left ? 0x80 : 0) + idx;
      o.y += 2;
      if (o.y >= 112) o.y = 160; // parked off-screen
      const dx = FALLING_DX[idx];
      o.x = left ? wrap(o.x - dx) : wrap(o.x + dx);
      o.xf = left;
      sprites.push({ x: o.x, y: o.y, tile, ts: 1, xf: o.xf, yf: false, obp });
    }
    steps.push({ dur: 3, sprites });
    if (steps.length > 120) break; // safety; the asm exits at 52 ticks
  }
  return steps;
}

type Emitter = (isPlayer: boolean) => [AnimStep[], string?];

const EMITTERS: Record<string, Emitter> = {
  SE_SPIRAL_BALLS_INWARD: (p) => [spiralBallSteps(p), "flash"],
  SE_SHOOT_BALLS_UPWARD: (p) => [shootBallsSteps(p)],
  SE_SHOOT_MANY_BALLS_UPWARD: (p) => [shootManyBallsSteps(p)],
  SE_WATER_DROPLETS_EVERYWHERE: () => [waterDropletSteps()],
  // Leaves run under wAnimPalette ($f0 on SGB); petals keep the ambient $e4.
  SE_LEAVES_FALLING: () => [fallingObjectSteps(3, LEAF_TILE, "f0")],
  SE_PETALS_FALLING: () => [fallingObjectSteps(20, PETAL_TILE, "e4")],
};

/** OAM attribute bits (macros/gfx.asm dbsprite). */
const OAM_PAL1 = 0x10;
const OAM_XFLIP = 0x20;
const OAM_YFLIP = 0x40;
const OAM_PRIO = 0x80;

/**
 * One OAM entry for a frame block's tile, anchored at its base coordinate
 * with the subanimation transform applied (DrawFrameBlock, 8-bit maths).
 */
function placeTile(
  transform: string,
  bc: [number, number],
  t: { y: number; x: number; tile: number; attrs: number },
  tileset: number,
): AnimSprite {
  const [bcy, bcx] = bc;
  const xflip = (t.attrs & OAM_XFLIP) !== 0;
  const yflip = (t.attrs & OAM_YFLIP) !== 0;
  const prio = (t.attrs & OAM_PRIO) !== 0;
  const pal1 = (t.attrs & OAM_PAL1) !== 0;
  let x: number;
  let y: number;
  let xf: boolean;
  let yf: boolean;
  if (transform === "HVFLIP") {
    y = wrap(136 - wrap(bcy + t.y));
    x = wrap(168 - wrap(bcx + t.x));
    // the engine compares the whole flags byte: plain/xflip/yflip toggle
    // both bits, anything else (both, PRIO, PAL1) becomes no-flip
    const plain = !prio && !pal1;
    if (plain && !xflip && !yflip) {
      xf = true;
      yf = true;
    } else if (plain && xflip && !yflip) {
      xf = false;
      yf = true;
    } else if (plain && yflip && !xflip) {
      xf = true;
      yf = false;
    } else {
      xf = false;
      yf = false;
    }
  } else if (transform === "HFLIP") {
    y = wrap(wrap(bcy + t.y) + 40);
    x = wrap(168 - wrap(bcx + t.x));
    xf = !xflip;
    yf = yflip;
  } else if (transform === "COORDFLIP") {
    y = wrap(wrap(136 - bcy) + t.y);
    x = wrap(wrap(168 - bcx) + t.x);
    xf = xflip;
    yf = yflip;
  } else {
    // NORMAL, and REVERSE, which only reorders the block list
    y = wrap(bcy + t.y);
    x = wrap(bcx + t.x);
    xf = xflip;
    yf = yflip;
  }
  // OAM_PAL1 tiles render through rOBP1; the rest through rOBP0, which is
  // wAnimPalette during a subanimation.
  return { x, y, tile: t.tile, ts: tileset, xf, yf, obp: pal1 ? "obp1" : "f0" };
}

export interface AnimOptions {
  /** Replay each subanimation row this many times (a ball's wobbles). */
  shakes?: number;
  /** The ball being thrown; a Master or Ultra ball flickers the palette. */
  ball?: string;
  ballFlicker?: boolean;
}

/**
 * A compiled move animation: the steps to show and the events to fire.
 *
 * `frames` is the whole length, so a caller can hold the battle queue for
 * exactly as long as the animation runs.
 */
export class MoveAnim {
  readonly steps: AnimStep[] = [];
  readonly events: AnimEvent[] = [];
  readonly frames: number = 0;
  /** Ids a move named that the data does not have; the caller may log them. */
  readonly missing: string[] = [];

  constructor(
    data: AnimData | null,
    moveId: string,
    attackerIsPlayer: boolean,
    opts: AnimOptions = {},
  ) {
    const rows = data?.anims?.[moveId];
    if (!data || !rows) {
      this.missing.push(`anim:${moveId}`);
      return;
    }
    const steps = this.steps;
    const events = this.events;
    let oam: (AnimSprite | null)[] = [];
    let oamMax = 0;
    let frame = 0;

    const emit = (dur: number, override?: AnimSprite[]): void => {
      const d = dur < 1 ? 1 : dur;
      const sprites =
        override ??
        oam.slice(0, oamMax).filter((s): s is AnimSprite => s !== null && s !== undefined);
      steps.push({ dur: d, sprites });
      frame += d;
    };

    // AnimationFlashScreen: four blocking frames, reused by the per-block
    // animation-id effects.
    const flashScreen = (): void => {
      events.push({ effect: "SE_DARK_SCREEN_FLASH", frame });
      emit(4);
    };

    const idFx = ANIM_ID_FX[moveId];

    // DoBallTossSpecialEffects (:685): a Master or Ultra ball toss XORs
    // rOBP0 after every frame block, so the ball flickers block to block.
    const wantsFlicker =
      opts.ballFlicker ?? (opts.ball === "MASTER_BALL" || opts.ball === "ULTRA_BALL");
    const ballFlicker =
      wantsFlicker &&
      (moveId === "TOSS_ANIM" || moveId === "GREATTOSS_ANIM" || moveId === "ULTRATOSS_ANIM");
    let obp0Flip = false;

    // DoGrowlSpecialEffects (:928): GROWL copies the note sprites to a
    // second slot and skips the OAM clean, so the previous block's notes
    // are still on screen, at their old coordinate, while this one draws.
    let growlNoteTrail: AnimSprite[] | null = null;

    for (const row of rows) {
      if (row.sound !== null && row.sound !== undefined) {
        events.push({ sound: row.sound, frame });
      }
      if ("effect" in row) {
        const emitter = EMITTERS[row.effect];
        if (emitter) {
          // the emitter routines write OAM from slot 0 and clean up after
          oam = [];
          oamMax = 0;
          const [emSteps, tailFx] = emitter(attackerIsPlayer);
          events.push({ effect: row.effect, frame });
          for (const st of emSteps) emit(st.dur, st.sprites);
          emit(1, []); // AnimationCleanOAM / ClearSprites
          if (tailFx === "flash") flashScreen();
        } else {
          const known = SE_FRAMES[row.effect];
          const dur = known ?? SE_PAUSE_FRAMES;
          events.push({ effect: row.effect, frame, dur });
          if (dur > 0) emit(dur);
        }
        continue;
      }

      const sub = data.subanims[row.sub];
      if (!sub) {
        this.missing.push(`subanim:${row.sub}`);
        continue;
      }
      const transform = resolveTransform(sub.type, attackerIsPlayer);
      const reverse = transform === "REVERSE";
      const order = reverse ? [...sub.blocks].reverse() : sub.blocks;
      const passes = opts.shakes ?? 1;
      for (let pass = 0; pass < passes; pass++) {
        // DoBallShakeSpecialEffects: each wobble opens with SFX_TINK and a
        // 40-frame pause, then replays the same subanimation.
        if (opts.shakes !== undefined) {
          events.push({ effect: "SFX_TINK", frame });
          emit(40);
        }
        let dest = 0; // PlaySubanimation resets the OAM cursor per row
        let played = 0;
        for (const entry of order) {
          const fb = data.frameBlocks[entry.block];
          const bc = data.baseCoords[entry.base];
          if (!fb || !bc) {
            this.missing.push(`block:${entry.block}:${entry.base}`);
            continue;
          }
          for (let j = 0; j < fb.length; j++) {
            oam[dest + j] = placeTile(transform, bc, fb[j], row.tileset);
          }
          if (obp0Flip) {
            // rOBP0 is complemented right now: this block's tiles show with
            // colours 1 and 2 swapped
            for (let j = 0; j < fb.length; j++) {
              const t = oam[dest + j];
              if (t && t.obp === "f0") t.obp = "f0x";
            }
          }
          if (dest + fb.length > oamMax) oamMax = dest + fb.length;
          const mode = entry.mode;
          if (mode === 2) {
            dest += fb.length; // accumulate; nothing shown yet
          } else if (mode === 3) {
            emit(row.delay); // show and persist
            dest += fb.length;
          } else if (mode === 4) {
            emit(row.delay); // show; the next block overwrites
          } else {
            // 0/1: show, then clean the OAM buffer
            if (moveId === "GROWL") {
              const current = oam
                .slice(0, oamMax)
                .filter((s): s is AnimSprite => s !== null && s !== undefined);
              const shown = growlNoteTrail ? [...current, ...growlNoteTrail] : current;
              emit(row.delay, shown);
              growlNoteTrail = current;
            } else {
              emit(row.delay + 1); // AnimationCleanOAM's extra frame
              oam = [];
              oamMax = 0;
            }
            dest = 0;
          }
          // DoSpecialEffectByAnimationId runs after every frame block, with
          // wSubAnimCounter = the blocks still to come
          played += 1;
          if (ballFlicker) obp0Flip = !obp0Flip;
          if (idFx) {
            const counter = order.length - played + 1;
            if (
              idFx === "flash" ||
              (idFx === "every4" && counter % 4 === 0) ||
              (idFx === "every8" && counter % 8 === 0) ||
              (idFx === "blizzard" &&
                (counter === 13 || counter === 9 || counter === 5 || counter === 1))
            ) {
              flashScreen();
            } else if (idFx === "explode") {
              if (counter % 4 === 0) flashScreen();
              if (counter === 1) {
                // DoExplodeSpecialEffects: the user's pic vanishes
                events.push({ effect: "SE_HIDE_ATTACKER_PIC", frame });
              }
            } else if (idFx === "rockslide") {
              if (counter >= 8 && counter <= 11) {
                events.push({ effect: "SE_ROCK_SLIDE_SHAKE", frame, dur: 15 });
                emit(15);
              } else if (counter === 1) {
                flashScreen();
              }
            }
          }
        }
      }
    }
    this.frames = frame;
  }

  /** The sprites on screen at `frame`, and nothing when it has finished. */
  spritesAt(frame: number): AnimSprite[] {
    let at = 0;
    for (const step of this.steps) {
      if (frame < at + step.dur) return step.sprites;
      at += step.dur;
    }
    return [];
  }

  /** The events that fire in [from, to) -- the frames just played. */
  eventsIn(from: number, to: number): AnimEvent[] {
    return this.events.filter((e) => e.frame >= from && e.frame < to);
  }

  done(frame: number): boolean {
    return frame >= this.frames;
  }
}
