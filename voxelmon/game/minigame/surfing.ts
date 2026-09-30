// Yellow's Surfing Pikachu minigame, ported line by line from pokeyellow's
// engine/minigame/surfing_pikachu.asm, with the animated-object engine it
// drives (engine/gfx/animated_objects.asm) and the bits of the home bank it
// leans on (VBlank, Joypad, the LCDC interrupt, RedrawRowOrColumn,
// VBlankCopy, AutoBgMapTransfer). Routines keep their asm labels so the two
// read side by side; RAM keeps its w/h names.
//
// The ROM's control flow is a generator: every DelayFrame is a `yield`,
// after the VBlank handler has run, so between two `frame()` calls the
// GbVideo holds what the LCD shows for the coming frame.
//
// wOnSGB is taken as set: SurfingPikachuMinigame_SetBGPals uses its SGB
// branch. SGB colours are the SGB palette names on GbVideo.colours.
//
// No Bun and no host here.

import { GbVideo, LCDC, SCREEN_H } from "../gb/video.ts";
import {
  HP_Left,
  Hi_Score,
  PIKACHU_STATE,
  Radness,
  SineWave,
  SURFING_MINIGAME_CENTER_X,
  SURFING_MINIGAME_FLAT_WATER_Y,
  SurfingMinigame_BGMetatileTable,
  SurfingMinigame_LYOverridesInitialSineWave,
  SurfingMinigame_WaveSequenceStarts,
  SurfingMinigameWavePatterns,
  SurfingPikachuFrames,
  SurfingPikachuHPDigitTiles,
  SurfingPikachuMiniPikachuTile,
  SurfingPikachuNarrowCloudTiles,
  SurfingPikachuOAMData,
  SurfingPikachuObjectSpawnData,
  SurfingPikachuStatusBarTiles,
  SurfingPikachuWideCloudTiles,
  Tempos,
  Total,
  WaveFunctions,
  type OamFrame,
} from "./surfing-data.ts";

export { PIKACHU_STATE } from "./surfing-data.ts";

export interface SurfingIo {
  /** The game's Random: a byte 0..255 (hRandomAdd). */
  random(): number;
  playMusic(label: string): void; // e.g. "Music_SurfingPikachu"
  /** Not called by the minigame itself: the ROM never stops the music; PlayDefaultMusic on exit is the caller's. */
  stopMusic(): void;
  playSfx(name: string): void;
  pikaClip(n: number): void; // PlayPikachuSoundClip with PikachuCryN
  /** Music tempo override (wMusicTempo, SurfingMinigame_UpdateMusicTempo); optional. */
  musicTempo?(tempo: number): void;
  /**
   * wChannelNoteDelayCounters of channels 1-3 all at 1 (the tempo is only
   * rewritten then). Absent: always true.
   */
  noteDelaysAtOne?(): boolean;
  /**
   * WaitForSoundToFinish: an sfx still sounding on channels 5, 6 or 8. The
   * ROM spins (VBlanks still running) until it stops. Absent: never.
   */
  sfxPlaying?(): boolean;
  /** IsSurfingStarterPikachuInParty. */
  surfingPikachuInParty: boolean;
  /** BIT_PIKACHU_MAP_SURF_SELECT: SELECT quits. */
  selectQuits: boolean;
  /** The saved high score (wSurfingMinigameHiScore, BCD as the ROM keeps it: 0x1234 = 1234 points). */
  hiScore: number;
  setHiScore(bcd: number): void;
}

export interface SurfingTilemaps {
  beachIntro: ArrayLike<number>;
  beachOutro: ArrayLike<number>;
  title: ArrayLike<number>;
  useControlPad: ArrayLike<number>;
  toSurfRad: ArrayLike<number>;
  /** gfx/surfing_pikachu/high_score_{1,2}.tilemap: in the ROM but never INCBINed by the minigame. */
  highScore1?: ArrayLike<number>;
  highScore2?: ArrayLike<number>;
}

// hardware PAD_* bits
const PAD_A = 0x01;
const PAD_SELECT = 0x04;
const PAD_RIGHT = 0x10;
const PAD_LEFT = 0x20;

const SCREEN_WIDTH = 20;
const TILE_WIDTH = 8;
const OBJ_SIZE = 4;
/** rSCY - $ff00 / rSCX - $ff00: hLCDCPointer values */
const rSCY_LOW = 0x42;
const rSCX_LOW = 0x43;
const vBGMap0 = 0x9800;

// ANIM_OBJ_* (constants/sprite_anim_constants.asm): the animated_object struct
const ANIM_OBJ_INDEX = 0x0;
const ANIM_OBJ_FRAME_SET = 0x1;
const ANIM_OBJ_CALLBACK = 0x2;
const ANIM_OBJ_TILE = 0x3;
const ANIM_OBJ_X_COORD = 0x4;
const ANIM_OBJ_Y_COORD = 0x5;
const ANIM_OBJ_X_OFFSET = 0x6;
const ANIM_OBJ_Y_OFFSET = 0x7;
const ANIM_OBJ_DURATION = 0x8;
const ANIM_OBJ_DURATION_OFFSET = 0x9;
const ANIM_OBJ_FRAME_IDX = 0xa;
const ANIM_OBJ_FIELD_B = 0xb;
const ANIM_OBJ_FIELD_C = 0xc;
const ANIM_OBJ_FIELD_D = 0xd;
const ANIM_OBJ_FIELD_E = 0xe;
const ANIM_OBJ_STRUCT_LENGTH = 0x10;
const NUM_ANIM_OBJS = 10;

// wShadowOAMSpriteNN fields (sprite_oam_struct: y, x, tile, attr)
const wShadowOAMSprite00TileID = 0 * OBJ_SIZE + 2;
const wShadowOAMSprite02TileID = 2 * OBJ_SIZE + 2;
const wShadowOAMSprite04XCoord = 4 * OBJ_SIZE + 1;
const wShadowOAMSprite05XCoord = 5 * OBJ_SIZE + 1;
const wShadowOAMEnd = 40 * OBJ_SIZE;

/** `add`/`adc` then `daa`: the byte and the carry out. */
function addDaa(a: number, b: number, carry: number): [number, number] {
  const sum = a + b + carry;
  const half = (a & 0xf) + (b & 0xf) + carry > 0xf;
  let c = sum > 0xff;
  let r = sum & 0xff;
  let adj = 0;
  if (c || r > 0x99) {
    adj |= 0x60;
    c = true;
  }
  if (half || (r & 0x0f) > 0x09) adj |= 0x06;
  r = (r + adj) & 0xff;
  return [r, c ? 1 : 0];
}

/** `sub`/`sbc` then `daa`: the byte and the carry (borrow) out. */
function subDaa(a: number, b: number, carry: number): [number, number] {
  const diff = a - b - carry;
  const half = (a & 0xf) - (b & 0xf) - carry < 0;
  const c = diff < 0;
  let r = diff & 0xff;
  if (c) r = (r - 0x60) & 0xff;
  if (half) r = (r - 0x06) & 0xff;
  return [r, c ? 1 : 0];
}

/** SurfingMinigame_NTimesDE: hl = a * de, 16 bits. */
function SurfingMinigame_NTimesDE(a: number, de: number): number {
  return (a * de) & 0xffff;
}

/**
 * SurfingPikachu_Sine: `d` times sin(a / 64 turn), the high byte of the
 * product; the second half-cycle negated.
 */
export function SurfingPikachu_Sine(a: number, d: number): number {
  a &= 0x3f; // wrap the 64-step full sine cycle
  if (a < 0x20) return (SurfingPikachu_Sine_GetSine(a, d) >> 8) & 0xff;
  a &= 0x1f; // index the 32-entry half-wave table
  const h = (SurfingPikachu_Sine_GetSine(a, d) >> 8) & 0xff;
  return (-h) & 0xff; // xor $ff / inc a
}
function SurfingPikachu_Sine_GetSine(e: number, d: number): number {
  return SurfingMinigame_NTimesDE(d & 0xff, SineWave[e]!);
}
/** SurfingPikachu_Cosine (unreferenced) */
export function SurfingPikachu_Cosine(a: number, d: number): number {
  return SurfingPikachu_Sine((a + 0x10) & 0xff, d);
}

// ------------------------------------------------------------------------
// engine/gfx/animated_objects.asm

export interface AnimatedObjectTables {
  /** wAnimatedObjectSpawnStateDataPointer: frameset, callback, (unused) tile offset */
  spawn: readonly (readonly number[])[];
  /** wAnimatedObjectFramesDataPointer: frame scripts by frameset, as bytes */
  frames: readonly (readonly number[])[];
  /** wAnimatedObjectOAMDataPointer: by frame id */
  oam: readonly OamFrame[];
  /** wAnimatedObjectJumptablePointer: callbacks, given bc (the struct's offset) */
  callbacks: readonly ((bc: number) => void)[];
}

/**
 * The shared animated-object engine (also the Yellow intro's): ten
 * 16-byte structs drawn into shadow OAM from wCurrentAnimatedObjectOAMBufferOffset.
 */
export class AnimatedObjects {
  /** wAnimatedObjectDataStructs: wAnimatedObject0 .. wAnimatedObject9 */
  readonly structs = new Uint8Array(NUM_ANIM_OBJS * ANIM_OBJ_STRUCT_LENGTH);
  wNumLoadedAnimatedObjects = 0;
  wCurrentAnimatedObjectOAMBufferOffset = 0;
  tables: AnimatedObjectTables | null = null;
  wCurAnimatedObjectOAMAttributes = 0;
  wCurrentAnimatedObjectVTileOffset = 0;
  wCurrentAnimatedObjectXCoord = 0;
  wCurrentAnimatedObjectYCoord = 0;
  wCurrentAnimatedObjectXOffset = 0;
  wCurrentAnimatedObjectYOffset = 0;
  wAnimatedObjectGlobalYOffset = 0;
  wAnimatedObjectGlobalXOffset = 0;

  /**
   * `introScene` reads wYellowIntroCurrentScene, which the minigame's RAM
   * shares with wSurfingMinigameMusicTempoEnabled (a UNION in ram/wram.asm).
   */
  constructor(
    readonly shadowOam: Uint8Array,
    private readonly introScene: () => number,
  ) {}

  ClearObjectAnimationBuffers(): void {
    this.structs.fill(0);
    this.wNumLoadedAnimatedObjects = 0;
    this.wCurrentAnimatedObjectOAMBufferOffset = 0;
    this.tables = null; // the four data pointers are in the cleared block
    this.wCurAnimatedObjectOAMAttributes = 0;
    this.wCurrentAnimatedObjectVTileOffset = 0;
    this.wCurrentAnimatedObjectXCoord = 0;
    this.wCurrentAnimatedObjectYCoord = 0;
    this.wCurrentAnimatedObjectXOffset = 0;
    this.wCurrentAnimatedObjectYOffset = 0;
    this.wAnimatedObjectGlobalYOffset = 0;
    this.wAnimatedObjectGlobalXOffset = 0;
  }

  RunObjectAnimations(): void {
    for (let e = 0; e < NUM_ANIM_OBJS; e++) {
      const bc = e * ANIM_OBJ_STRUCT_LENGTH;
      if (this.structs[bc + ANIM_OBJ_INDEX] === 0) continue;
      this.ExecuteCurrentAnimatedObjectCallback(bc);
      // the frame is drawn even if the callback just masked the struct
      if (this.UpdateCurrentAnimatedObjectFrame(bc)) return; // OAM full: quit
    }
    // .deinit_unused_oam_loop
    for (let l = this.wCurrentAnimatedObjectOAMBufferOffset; l < wShadowOAMEnd; l++) this.shadowOam[l] = 0;
  }

  /** Returns the struct's offset (bc), or -1 with no free slot (carry; bc left alone). */
  SpawnAnimatedObject(a: number, d: number, e: number): number {
    const s = this.structs;
    for (let i = 0; i < NUM_ANIM_OBJS; i++) {
      const bc = i * ANIM_OBJ_STRUCT_LENGTH;
      if (s[bc + ANIM_OBJ_INDEX] !== 0) continue;
      // .init
      this.wNumLoadedAnimatedObjects = (this.wNumLoadedAnimatedObjects + 1) & 0xff;
      const spawn = this.tables!.spawn[a]!;
      // the index is the load count: the 256th spawn gets 0 and so is a free slot
      s[bc + ANIM_OBJ_INDEX] = this.wNumLoadedAnimatedObjects;
      s[bc + ANIM_OBJ_FRAME_SET] = spawn[0]!;
      s[bc + ANIM_OBJ_CALLBACK] = spawn[1]!;
      s[bc + ANIM_OBJ_TILE] = 0; // xor a: the spawn data's tile offset byte goes unread
      s[bc + ANIM_OBJ_X_COORD] = e & 0xff;
      s[bc + ANIM_OBJ_Y_COORD] = d & 0xff;
      s[bc + ANIM_OBJ_X_OFFSET] = 0;
      s[bc + ANIM_OBJ_Y_OFFSET] = 0;
      s[bc + ANIM_OBJ_DURATION] = 0;
      s[bc + ANIM_OBJ_DURATION_OFFSET] = 0;
      s[bc + ANIM_OBJ_FRAME_IDX] = 0xff;
      s.fill(0, bc + ANIM_OBJ_FIELD_B, bc + ANIM_OBJ_STRUCT_LENGTH);
      return bc;
    }
    return -1;
  }

  MaskCurrentAnimatedObjectStruct(bc: number): void {
    this.structs[bc + ANIM_OBJ_INDEX] = 0;
  }

  MaskAllAnimatedObjectStructs(): void {
    for (let i = 0; i < NUM_ANIM_OBJS; i++) this.structs[i * ANIM_OBJ_STRUCT_LENGTH] = 0;
  }

  /** Returns true (carry) when shadow OAM filled up. */
  UpdateCurrentAnimatedObjectFrame(bc: number): boolean {
    const s = this.structs;
    this.wCurAnimatedObjectOAMAttributes = 0;
    this.wCurrentAnimatedObjectVTileOffset = s[bc + ANIM_OBJ_TILE]!;
    this.wCurrentAnimatedObjectXCoord = s[bc + ANIM_OBJ_X_COORD]!;
    this.wCurrentAnimatedObjectYCoord = s[bc + ANIM_OBJ_Y_COORD]!;
    this.wCurrentAnimatedObjectXOffset = s[bc + ANIM_OBJ_X_OFFSET]!;
    this.wCurrentAnimatedObjectYOffset = s[bc + ANIM_OBJ_Y_OFFSET]!;
    const a = this.UpdateDurationTimerAndFrameStateForCurrentAnimatedObject(bc);
    if (a === 0xfd) return false; // dorepeat: nothing drawn this frame
    if (a === 0xfc) {
      this.MaskCurrentAnimatedObjectStruct(bc); // .delete_animation
      return false;
    }
    const oam = this.tables!.oam[a]!; // GetCurrentAnimatedObjectOAMDataPointer
    this.wCurrentAnimatedObjectVTileOffset = (this.wCurrentAnimatedObjectVTileOffset + oam.tile) & 0xff;
    let e = this.wCurrentAnimatedObjectOAMBufferOffset;
    for (const [ty, tx, tile, attr] of oam.entries) {
      let b = (this.wCurrentAnimatedObjectYCoord + this.wCurrentAnimatedObjectYOffset) & 0xff;
      b = (b + this.wAnimatedObjectGlobalYOffset) & 0xff;
      this.shadowOam[e++] = (this.GetCurrentAnimatedObjectTileYCoordinate(ty!) + b) & 0xff;
      b = (this.wCurrentAnimatedObjectXCoord + this.wCurrentAnimatedObjectXOffset) & 0xff;
      b = (b + this.wAnimatedObjectGlobalXOffset) & 0xff;
      this.shadowOam[e++] = (this.GetCurrentAnimatedObjectTileXCoordinate(tx!) + b) & 0xff;
      this.shadowOam[e++] = (this.wCurrentAnimatedObjectVTileOffset + tile!) & 0xff;
      const at = this.SetCurrentAnimatedObjectOAMAttributes(attr!);
      // the Yellow intro's scene 7 keeps OAM attributes; in the minigame the
      // byte is wSurfingMinigameMusicTempoEnabled, 0 or 1
      if (this.introScene() !== 7) this.shadowOam[e] = at;
      e++;
      this.wCurrentAnimatedObjectOAMBufferOffset = e & 0xff;
      if ((e & 0xff) >= wShadowOAMEnd) return true; // .oam_is_full
    }
    return false;
  }

  GetCurrentAnimatedObjectTileYCoordinate(y: number): number {
    let a = y & 0xff;
    if (this.wCurAnimatedObjectOAMAttributes & 0x40) a = (-(a + 8)) & 0xff; // B_OAM_YFLIP
    return a;
  }

  GetCurrentAnimatedObjectTileXCoordinate(x: number): number {
    let a = x & 0xff;
    if (this.wCurAnimatedObjectOAMAttributes & 0x20) a = (-(a + 8)) & 0xff; // B_OAM_XFLIP
    return a;
  }

  SetCurrentAnimatedObjectOAMAttributes(attr: number): number {
    const b = (attr ^ this.wCurAnimatedObjectOAMAttributes) & 0xe0; // OAM_XFLIP | OAM_YFLIP | OAM_PRIO
    let a = (attr & 0x10) | b; // OAM_PAL1
    if (a & 0x10) a |= 0x04; // OAM_HIGH_PALS (CGB palettes 4-7)
    return a;
  }

  SetCurrentAnimatedObjectCallbackAndResetFrameStateRegisters(bc: number, a: number): void {
    // despite the name, byte 1 is the frameset
    this.structs[bc + ANIM_OBJ_FRAME_SET] = a & 0xff;
    this.structs[bc + ANIM_OBJ_DURATION] = 0;
    this.structs[bc + ANIM_OBJ_DURATION_OFFSET] = 0;
    this.structs[bc + ANIM_OBJ_FRAME_IDX] = 0xff;
  }

  /** The frame script byte at the struct's frame index (GetPointerToCurrentAnimatedObjectFrameScript) plus `k`. */
  private scriptByte(bc: number, k: number): number {
    const script = this.tables!.frames[this.structs[bc + ANIM_OBJ_FRAME_SET]!];
    const i = this.structs[bc + ANIM_OBJ_FRAME_IDX]! * 2 + k;
    // past a script's last command the ROM reads on into the next table's bytes;
    // only delanim's unused duration byte ever lands there
    return script?.[i] ?? 0;
  }

  UpdateDurationTimerAndFrameStateForCurrentAnimatedObject(bc: number): number {
    const s = this.structs;
    for (;;) {
      if (s[bc + ANIM_OBJ_DURATION] !== 0) {
        s[bc + ANIM_OBJ_DURATION]--;
        const a = this.scriptByte(bc, 0);
        this.wCurAnimatedObjectOAMAttributes = (this.scriptByte(bc, 1) & 0xc0) >> 1; // .finish
        return a;
      }
      // .next_frame
      s[bc + ANIM_OBJ_FRAME_IDX] = (s[bc + ANIM_OBJ_FRAME_IDX]! + 1) & 0xff;
      const a = this.scriptByte(bc, 0);
      if (a === 0xfe) {
        // .restart_anim
        s[bc + ANIM_OBJ_DURATION] = 0;
        s[bc + ANIM_OBJ_FRAME_IDX] = 0xff;
        continue;
      }
      if (a === 0xff) {
        // .hold_last_frame_state
        s[bc + ANIM_OBJ_DURATION] = 0;
        s[bc + ANIM_OBJ_FRAME_IDX] = (s[bc + ANIM_OBJ_FRAME_IDX]! - 2) & 0xff;
        continue;
      }
      const b = this.scriptByte(bc, 1);
      s[bc + ANIM_OBJ_DURATION] = ((b & 0x3f) + s[bc + ANIM_OBJ_DURATION_OFFSET]!) & 0xff;
      this.wCurAnimatedObjectOAMAttributes = (b & 0xc0) >> 1; // .finish
      return a;
    }
  }

  ExecuteCurrentAnimatedObjectCallback(bc: number): void {
    this.tables!.callbacks[this.structs[bc + ANIM_OBJ_CALLBACK]!]!(bc);
  }
}

// ------------------------------------------------------------------------
// engine/minigame/surfing_pikachu.asm

export class SurfingMinigame {
  readonly video: GbVideo;
  private readonly gen: Generator<void, void, void>;
  private finished = false;

  // HRAM
  hSCX = 0;
  hSCY = 0;
  hWY = SCREEN_H;
  hLCDCPointer = 0;
  hAutoBGTransferEnabled = 0;
  hAutoBGTransferPortion = 0; // left over from the overworld; taken as 0
  hAutoBGTransferDest = 0; // 0 = vBGMap0, 1 = vBGMap1
  hFrameCounter = 0;
  hJoyInput = 0;
  hJoyLast = 0;
  hJoyHeld = 0;
  hJoyPressed = 0;
  hJoyReleased = 0;
  hJoy5 = 0;
  hRedrawRowOrColumnMode = 0;
  hRedrawRowOrColumnDest = vBGMap0;
  hVBlankCopySize = 0;
  hVBlankCopySource = vBGMap0;
  /** wMusicTempo as last written (0: never written by the minigame). */
  wMusicTempo = 0;

  // WRAM
  readonly wShadowOAM = new Uint8Array(wShadowOAMEnd);
  /** wLYOverrides and wLYOverridesBuffer, $100 bytes each. */
  readonly wLYOverrides = new Uint8Array(0x200);
  /**
   * wRedrawRowOrColumnSrcTiles (SCREEN_WIDTH * 2). A column redraw reads 36
   * bytes; the minigame writes 32, so rows 16-17 get what the overworld left
   * here (unknown to us: zeros), under the HP window.
   */
  readonly wRedrawRowOrColumnSrcTiles = new Uint8Array(SCREEN_WIDTH * 2);
  readonly anim: AnimatedObjects;

  // wSurfingMinigameData .. wSurfingMinigameDataEnd
  wSurfingMinigameRoutineNumber = 0;
  wSurfingMinigamePikachuState = 0;
  wSurfingMinigameWaveFunctionNumber = 0;
  wSurfingMinigameWaveRandomValue = 0;
  /** little-endian BCD */
  readonly wSurfingMinigamePikachuHP = new Uint8Array(2);
  wSurfingMinigameRadnessMeter = 0;
  /** little-endian BCD */
  readonly wSurfingMinigameRadnessScore = new Uint8Array(2);
  /** little-endian BCD */
  readonly wSurfingMinigameTotalScore = new Uint8Array(2);
  wSurfingMinigameBoardAngleOffset = 0;
  wSurfingMinigameBoardAngleDecreasing = 0;
  wSurfingMinigameBoardAngleTimer = 0;
  wSurfingMinigameCrashTimer = 0;
  wSurfingMinigameUnusedToggle = 0;
  /** 8.8 pixels per frame (dw, little-endian) */
  wSurfingMinigamePikachuSpeed = 0;
  /** big-endian: sections, then a 16-bit fraction */
  readonly wSurfingMinigameDistance = new Uint8Array(3);
  readonly wSurfingMinigameWaveHeightBuffer = new Uint8Array(2);
  wSurfingMinigamePikachuObjectHeight = 0;
  wSurfingMinigameWaterSprayCounter = 0;
  wSurfingMinigameJumpArcMagnitude = 0;
  wSurfingMinigameJumpDescending = 0;
  wSurfingMinigameJumpArcFraction = 0;
  /** ds 1 tiles: VBlankCopy lands 16 bytes of BG map here */
  readonly wSurfingMinigameBGMapReadBuffer = new Uint8Array(16);
  wSurfingMinigameSCX = 0;
  wSurfingMinigameSCX2 = 0;
  wSurfingMinigameSCXHi = 0;
  readonly wSurfingMinigameWaveHeight = new Uint8Array(SCREEN_WIDTH);
  wSurfingMinigameXOffset = 0;
  wSurfingMinigameTrickFlags = 0;
  wSurfingMinigameGameOver = 0;
  wSurfingMinigameGameOverDelay = 0;
  wSurfingMinigameRoutineDelay = 0;
  wSurfingMinigameIntroAnimationFinished = 0;
  /** shares its byte with wYellowIntroCurrentScene */
  wSurfingMinigameMusicTempoEnabled = 0;
  wSurfingMinigameCloudScrollFraction = 0;

  constructor(
    private readonly io: SurfingIo,
    private readonly tilemaps: SurfingTilemaps,
    video?: GbVideo,
  ) {
    this.video = video ?? new GbVideo();
    this.anim = new AnimatedObjects(this.wShadowOAM, () => this.wSurfingMinigameMusicTempoEnabled);
    this.gen = this.SurfingPikachuMinigame();
  }

  /**
   * One Game Boy frame: the ROM runs up to its next DelayFrame. `held` and
   * `pressed` are PAD_* bits; a press is folded into the input ReadJoypad
   * latches, and Joypad derives hJoyPressed from it as the ROM does.
   * Returns false once the minigame has exited.
   */
  frame(held: number, pressed: number): boolean {
    if (this.finished) return false;
    this.hJoyInput = (held | pressed) & 0xff; // ReadJoypad, in the VBlank before
    if (this.gen.next().done) this.finished = true;
    return !this.finished;
  }

  get done(): boolean {
    return this.finished;
  }

  // ---------------------------------------------------------------- home bank

  /** DelayFrame: the VBlank handler runs, then the frame is shown. */
  private *DelayFrame(): Generator<void, void, void> {
    this.VBlank();
    yield;
  }

  private *DelayFrames(n: number): Generator<void, void, void> {
    for (let i = 0; i < n; i++) yield* this.DelayFrame();
  }

  /** home/vblank.asm VBlank, as far as the minigame's state goes. */
  private VBlank(): void {
    const v = this.video;
    v.scx = this.hSCX;
    v.scy = this.hSCY;
    v.wy = this.hWY; // wDisableVBlankWYUpdate is clear
    this.AutoBgMapTransfer();
    this.RedrawRowOrColumn();
    this.VBlankCopy();
    v.oam.set(this.wShadowOAM); // hDMARoutine
    // PrepareOAMData returns at once (wUpdateSpritesEnabled = $ff); Random is
    // the io's; ReadJoypad is frame()'s
    if (this.hFrameCounter !== 0) this.hFrameCounter--;
    this.LCDC();
  }

  /**
   * home/lcdc.asm LCDC, for the frame to come: in each line's HBlank the STAT
   * interrupt writes wLYOverrides[LY] to the register hLCDCPointer names, so
   * line 0 shows the value VBlank wrote (hSCY/hSCX) and line n the table's
   * entry n-1. The table is taken as it stands at DelayFrame; the ROM's
   * next-frame UpdateLYOverrides lands mid-frame, a one-line rotation later.
   */
  private LCDC(): void {
    const v = this.video;
    if (this.hLCDCPointer === rSCY_LOW) v.lineTarget = "scy";
    else if (this.hLCDCPointer === rSCX_LOW) v.lineTarget = "scx";
    else {
      v.lineTarget = "none";
      return;
    }
    v.lines[0] = v.lineTarget === "scy" ? this.hSCY : this.hSCX;
    for (let ly = 1; ly < SCREEN_H; ly++) v.lines[ly] = this.wLYOverrides[ly - 1]!;
  }

  /** home/vcopy.asm AutoBgMapTransfer: a third of wTileMap per VBlank. */
  private AutoBgMapTransfer(): void {
    this.video.autoBgTransfer = this.hAutoBGTransferEnabled !== 0;
    this.video.autoBgTransferMap = this.hAutoBGTransferDest;
    this.hAutoBGTransferPortion = this.video.vblankThird(this.hAutoBGTransferPortion);
  }

  /** home/vcopy.asm RedrawRowOrColumn: only the column mode (1) is used here. */
  private RedrawRowOrColumn(): void {
    if (this.hRedrawRowOrColumnMode === 0) return;
    const b = this.hRedrawRowOrColumnMode;
    this.hRedrawRowOrColumnMode = 0;
    if (b !== 1) return; // .redrawRow: never requested by the minigame
    let de = this.hRedrawRowOrColumnDest;
    const src = this.wRedrawRowOrColumnSrcTiles;
    for (let c = 0, hl = 0; c < 18; c++) {
      // c = SCREEN_HEIGHT
      this.video.mapSet(de - vBGMap0, src[hl++]!);
      de = (de + 1) & 0xffff;
      this.video.mapSet(de - vBGMap0, src[hl++]!);
      de = (de + 31) & 0xffff; // TILEMAP_WIDTH - 1
      // wrap from bottom to top
      de = ((((de >> 8) & 0x03) | 0x98) << 8) | (de & 0xff);
    }
  }

  /** home/vcopy.asm VBlankCopy: here always one "tile" (16 map bytes) into wSurfingMinigameBGMapReadBuffer. */
  private VBlankCopy(): void {
    if (this.hVBlankCopySize === 0) return;
    const n = this.hVBlankCopySize * 16;
    this.hVBlankCopySize = 0;
    for (let i = 0; i < n; i++) {
      this.wSurfingMinigameBGMapReadBuffer[i & 15] = this.video.maps[(this.hVBlankCopySource - vBGMap0 + i) & 0x7ff]!;
    }
    this.hVBlankCopySource += n;
  }

  /** home/joypad.asm Joypad -> engine/joypad.asm _Joypad (wJoyIgnore clear, joypad not disabled). */
  private Joypad(): void {
    const b = this.hJoyInput;
    // A+B+SELECT+START (and not Up) would TrySoftReset: not modelled
    const d = this.hJoyLast ^ b;
    this.hJoyReleased = d & this.hJoyLast;
    this.hJoyPressed = d & b;
    this.hJoyLast = b;
    this.hJoyHeld = this.hJoyLast;
  }

  /** WaitForSoundToFinish: a spin on the sfx channels; VBlanks keep coming. */
  private *WaitForSoundToFinish(): Generator<void, void, void> {
    while (this.io.sfxPlaying?.()) yield* this.DelayFrame();
  }

  private ClearSprites(): void {
    this.wShadowOAM.fill(0);
  }

  /** DisableLCD: the ROM waits for LY 145 with the VBlank interrupt masked, then turns the LCD off. */
  private DisableLCD(): void {
    this.video.lcdc &= ~LCDC.on;
  }

  /**
   * RunPaletteCommand. SET_PAL_SURFING_PIKACHU_TITLE ($0e) is SetPal_PikachusBeach:
   * PAL_PIKACHUS_BEACH everywhere. SET_PAL_SURFING_PIKACHU_MINIGAME ($0f) is
   * SetPal_PikachusBeachTitle: PAL_PIKACHUS_BEACH_TITLE on screen cells
   * (4,0)-(15,5), the title graphic (UnknownPacket_72751) -- approximated here
   * as the OBP1 colours, GbVideo having no screen regions.
   */
  private RunPaletteCommand(cmd: "SET_PAL_SURFING_PIKACHU_TITLE" | "SET_PAL_SURFING_PIKACHU_MINIGAME"): void {
    if (cmd === "SET_PAL_SURFING_PIKACHU_TITLE") {
      this.video.colours = { bg: "PIKACHUS_BEACH", obj0: "PIKACHUS_BEACH", obj1: "PIKACHUS_BEACH" };
    } else {
      this.video.colours = { bg: "PIKACHUS_BEACH", obj0: "PIKACHUS_BEACH", obj1: "PIKACHUS_BEACH_TITLE" };
    }
  }

  private Random(): number {
    return this.io.random() & 0xff;
  }

  // -------------------------------------------------------------- the minigame

  private *SurfingPikachuMinigame(): Generator<void, void, void> {
    this.SurfingPikachuMinigame_BlankPals();
    yield* this.DelayFrame();
    yield* this.DelayFrame();
    yield* this.DelayFrame();
    // hTileAnimations saved and cleared, wUpdateSpritesEnabled saved and set
    // to $ff, rIE = VBLANK | STAT | TIMER | SERIAL, rSTAT = mode 0 (HBlank):
    // the caller's world stands still meanwhile
    this.hAutoBGTransferDest = 0; // HIGH(vBGMap0)
    yield* this.SurfingPikachuMinigameIntro();
    yield* this.SurfingPikachuLoop();
    this.video.bgp = 0;
    this.video.obp0 = 0;
    this.video.obp1 = 0;
    this.anim.ClearObjectAnimationBuffers();
    this.ClearSprites();
    this.hLCDCPointer = 0;
    this.hSCX = 0;
    this.hSCY = 0;
    this.hWY = SCREEN_H; // keep the window below the visible screen
    yield* this.DelayFrame();
    // hAutoBGTransferDest, rIE, rSTAT restored; RunDefaultPaletteCommand,
    // ReloadMapAfterSurfingMinigame, PlayDefaultMusic, GBPalNormal: the caller's
  }

  private *SurfingPikachuLoop(): Generator<void, void, void> {
    this.SurfingPikachuMinigame_LoadGFXAndLayout();
    yield* this.DelayFrame();
    this.RunPaletteCommand("SET_PAL_SURFING_PIKACHU_TITLE");
    for (;;) {
      if (this.wSurfingMinigameRoutineNumber & 0x80) return;
      this.SurfingPikachu_GetJoypad_3FrameBuffer();
      if (this.SurfingPikachu_CheckPressedSelect()) return;
      yield* this.RunSurfingMinigameRoutine();
      this.anim.wCurrentAnimatedObjectOAMBufferOffset = 15 * OBJ_SIZE;
      this.anim.RunObjectAnimations();
      this.SurfingMinigame_MoveClouds();
      yield* this.DelayFrame(); // .DelayFrame
      this.SurfingMinigame_UpdateMusicTempo();
    }
  }

  SurfingPikachu_CheckPressedSelect(): boolean {
    if (!this.io.selectQuits) return false;
    return (this.hJoyPressed & PAD_SELECT) !== 0;
  }

  /** unused */
  SurfingMinigame_ToggleStartFlag(): void {
    if (!(this.hJoyPressed & 0x08)) return;
    this.wSurfingMinigameUnusedToggle ^= 1;
  }

  private setMusicTempo(tempo: number): void {
    this.wMusicTempo = tempo;
    this.io.musicTempo?.(tempo);
  }

  SurfingMinigame_UpdateMusicTempo(): void {
    if (!this.wSurfingMinigameMusicTempoEnabled) return;
    // all channels on their last frame of note delay
    if (!(this.io.noteDelaysAtOne?.() ?? true)) return;
    // de = ([wSurfingMinigamePikachuSpeed] & $3ff) * 2, high byte
    const e = (((this.wSurfingMinigamePikachuSpeed & 0x3ff) << 1) >> 8) & 0xff;
    // speed tops out at $200, so e <= 4; past the table the ROM would read code
    const tempo = Tempos[e];
    if (tempo !== undefined) this.setMusicTempo(tempo);
  }

  SurfingMinigame_ResetMusicTempo(): void {
    if (!(this.io.noteDelaysAtOne?.() ?? true)) return;
    this.setMusicTempo(117);
  }

  private clearSurfingMinigameData(): void {
    this.wSurfingMinigameRoutineNumber = 0;
    this.wSurfingMinigamePikachuState = 0;
    this.wSurfingMinigameWaveFunctionNumber = 0;
    this.wSurfingMinigameWaveRandomValue = 0;
    this.wSurfingMinigamePikachuHP.fill(0);
    this.wSurfingMinigameRadnessMeter = 0;
    this.wSurfingMinigameRadnessScore.fill(0);
    this.wSurfingMinigameTotalScore.fill(0);
    this.wSurfingMinigameBoardAngleOffset = 0;
    this.wSurfingMinigameBoardAngleDecreasing = 0;
    this.wSurfingMinigameBoardAngleTimer = 0;
    this.wSurfingMinigameCrashTimer = 0;
    this.wSurfingMinigameUnusedToggle = 0;
    this.wSurfingMinigamePikachuSpeed = 0;
    this.wSurfingMinigameDistance.fill(0);
    this.wSurfingMinigameWaveHeightBuffer.fill(0);
    this.wSurfingMinigamePikachuObjectHeight = 0;
    this.wSurfingMinigameWaterSprayCounter = 0;
    this.wSurfingMinigameJumpArcMagnitude = 0;
    this.wSurfingMinigameJumpDescending = 0;
    this.wSurfingMinigameJumpArcFraction = 0;
    this.wSurfingMinigameBGMapReadBuffer.fill(0);
    this.wSurfingMinigameSCX = 0;
    this.wSurfingMinigameSCX2 = 0;
    this.wSurfingMinigameSCXHi = 0;
    this.wSurfingMinigameWaveHeight.fill(0);
    this.wSurfingMinigameXOffset = 0;
    this.wSurfingMinigameTrickFlags = 0;
    this.wSurfingMinigameGameOver = 0;
    this.wSurfingMinigameGameOverDelay = 0;
    this.wSurfingMinigameRoutineDelay = 0;
    this.wSurfingMinigameIntroAnimationFinished = 0;
    this.wSurfingMinigameMusicTempoEnabled = 0;
    this.wSurfingMinigameCloudScrollFraction = 0;
  }

  private setSurfingPikachuTables(): void {
    this.anim.tables = {
      spawn: SurfingPikachuObjectSpawnData,
      callbacks: this.SurfingPikachuObjectCallbacks,
      oam: SurfingPikachuOAMData,
      frames: SurfingPikachuFrames,
    };
  }

  SurfingPikachuMinigame_LoadGFXAndLayout(): void {
    const v = this.video;
    this.SurfingPikachu_ClearTileMap();
    this.ClearSprites();
    this.DisableLCD();
    this.clearSurfingMinigameData();
    this.wLYOverrides.fill(0); // wLYOverrides .. wLYOverridesBufferEnd
    this.hAutoBGTransferEnabled = 0;
    this.anim.ClearObjectAnimationBuffers();

    v.loadTiles(256, "surf_1a", 0, 80); // SurfingPikachu1Graphics1 -> vChars2
    v.loadTiles(0, "surf_1b", 0, 256); // SurfingPikachu1Graphics2 -> vChars0
    this.setSurfingPikachuTables();

    v.maps.fill(0); // vBGMap0, 2 * TILEMAP_AREA
    v.maps.fill(0x0b, GbVideo.bgCoord(0, 6), GbVideo.bgCoord(0, 6) + 12 * 32); // water tile

    this.anim.SpawnAnimatedObject(0x1, SURFING_MINIGAME_FLAT_WATER_Y, SURFING_MINIGAME_CENTER_X); // surfing Pikachu
    this.wSurfingMinigamePikachuObjectHeight = SURFING_MINIGAME_FLAT_WATER_Y;

    this.SurfingMinigame_InitScanlineOverrides();

    this.hSCX = 0;
    this.hSCY = 0;
    this.hWY = 0x7e; // place the HP window just below Pikachu's waterline
    this.hLCDCPointer = rSCY_LOW;
    this.wSurfingMinigamePikachuSpeed = 0x0040; // 0.25: initial speed
    this.wSurfingMinigamePikachuHP[0] = 0x00;
    this.wSurfingMinigamePikachuHP[1] = 0x60; // initial HP: $6000 in little-endian BCD
    this.wSurfingMinigameWaveHeight.fill(SURFING_MINIGAME_FLAT_WATER_Y);
    this.SurfingPikachuMinigame_InitStaticSpriteLayout();
    this.SurfingPikachuMinigame_DrawStaticTilemapLayout();
    v.lcdc = LCDC.on | LCDC.winMap9C00 | LCDC.winOn | LCDC.objOn | LCDC.bgOn;
    this.SurfingPikachuMinigame_SetBGPals();
    v.obp0 = ldpal(SHADE_BLACK, SHADE_DARK, SHADE_LIGHT, SHADE_WHITE);
    v.obp1 = ldpal(SHADE_BLACK, SHADE_DARK, SHADE_WHITE, SHADE_WHITE);
    // UpdateCGBPal_OBP0 / _OBP1: the palettes follow the registers
  }

  /** wOnSGB is taken as set: the .sgb branch. */
  SurfingPikachuMinigame_SetBGPals(): void {
    this.video.bgp = ldpal(SHADE_BLACK, SHADE_DARK, SHADE_LIGHT, SHADE_WHITE);
    // not on SGB: ldpal SHADE_BLACK, SHADE_LIGHT, SHADE_WHITE, SHADE_WHITE
  }

  SurfingPikachuMinigame_InitStaticSpriteLayout(): void {
    let hl = 0; // wSpriteDataEnd, which is wShadowOAM
    hl = this.SurfingPikachuMinigame_PlaceSpriteRowFromTiles(hl, SurfingPikachuHPDigitTiles, 0x97, 0x80); // HP digits
    hl = this.SurfingPikachuMinigame_PlaceSpriteRowFromTiles(hl, SurfingPikachuMiniPikachuTile, 0x96, 0x50); // progress marker
    hl = this.SurfingPikachuMinigame_PlaceSpriteRowFromTiles(hl, SurfingPikachuWideCloudTiles, 0x14, 0x20); // wide cloud
    this.SurfingPikachuMinigame_PlaceSpriteRowFromTiles(hl, SurfingPikachuNarrowCloudTiles, 0x20, 0x80); // narrow cloud
  }

  SurfingPikachuMinigame_PlaceSpriteRowFromTiles(hl: number, tiles: readonly number[], b: number, c: number): number {
    for (const t of tiles) {
      this.wShadowOAM[hl++] = b;
      this.wShadowOAM[hl++] = c;
      this.wShadowOAM[hl++] = t;
      this.wShadowOAM[hl++] = 0;
      c = (c + TILE_WIDTH) & 0xff;
    }
    return hl;
  }

  SurfingPikachuMinigame_DrawStaticTilemapLayout(): void {
    const v = this.video;
    let de = GbVideo.bgCoord(1, 1, 1);
    for (const t of SurfingPikachuStatusBarTiles) v.mapSet(de++, t);
    v.mapSet(GbVideo.bgCoord(1, 0, 1), 0x15);
    v.mapSet(GbVideo.bgCoord(2, 0, 1), 0x16);
    v.mapSet(GbVideo.bgCoord(12, 1, 1), 0x1b);
    v.mapSet(GbVideo.bgCoord(13, 1, 1), 0x1c);
  }

  private *RunSurfingMinigameRoutine(): Generator<void, void, void> {
    switch (this.wSurfingMinigameRoutineNumber) {
      case 0x0: return this.SurfingMinigame_StartGame();
      case 0x1: return this.SurfingMinigame_RunGame();
      case 0x2: return this.SurfingMinigame_WaitToShowResults();
      case 0x3: return this.SurfingMinigame_ScrollToResultsScreen();
      case 0x4: return this.SurfingMinigame_DrawResultsScreenAndWait();
      case 0x5: return this.SurfingMinigame_WriteHPLeftAndWait();
      case 0x6: return this.SurfingMinigame_WriteRadnessAndWait();
      case 0x7: return this.SurfingMinigame_WriteTotalAndWait();
      case 0x8: return this.SurfingMinigame_AddRemainingHPToTotalAndWait();
      case 0x9: return yield* this.SurfingMinigame_AddRadnessToTotalAndWait();
      case 0xa: return this.SurfingMinigame_WaitLast();
      case 0xb: return this.SurfingMinigame_ExitOnPressA();
      case 0xc: return this.SurfingMinigame_GameOver();
    }
  }

  SurfingMinigame_StartGame(): void {
    this.anim.SpawnAnimatedObject(0x2, 0x48, 0xe0); // "START" text, starting off the right edge
    this.wSurfingMinigameRoutineNumber++;
    this.wSurfingMinigameMusicTempoEnabled = 1;
  }

  SurfingMinigame_RunGame(): void {
    if (this.wSurfingMinigameDistance[0]! >= 0x18) {
      // .finished: the end of the 24-section course
      this.wSurfingMinigameRoutineNumber++;
      this.wSurfingMinigameMusicTempoEnabled = 0;
      this.wSurfingMinigameRoutineDelay = 192; // frames to coast before scrolling to the results screen
      return;
    }
    if ((this.wSurfingMinigamePikachuHP[0]! | this.wSurfingMinigamePikachuHP[1]!) === 0) {
      // .dead
      this.wSurfingMinigameGameOver = 1;
      this.wSurfingMinigameRoutineNumber = 0xc;
      this.wSurfingMinigameGameOverDelay = 0x80; // frames before accepting A on the game-over screen
      const bc = this.anim.SpawnAnimatedObject(0xb, 0x88, SURFING_MINIGAME_CENTER_X); // "Oh no.." text
      if (bc >= 0) {
        // (with no free slot the ROM would write through a stale bc)
        this.anim.structs[bc + ANIM_OBJ_Y_OFFSET] = 0x80;
        this.anim.structs[bc + ANIM_OBJ_FIELD_B] = 0x80;
        this.anim.structs[bc + ANIM_OBJ_FIELD_C] = 0x30; // initial frame counter for the flipping animation
      }
      this.wSurfingMinigameMusicTempoEnabled = 0;
      return;
    }
    this.wSurfingMinigameWaveRandomValue = this.Random();
    this.SurfingMinigame_UpdateLYOverrides();
    this.SurfingMinigame_SetPikachuHeight();
    this.SurfingMinigame_ReadBGMapBuffer();
    this.SurfingMinigame_ScrollAndGenerateBGMap();
    this.SurfingMinigame_UpdatePikachuDistance();
    this.SurfingMinigame_Deduct1HP();
    this.SurfingMinigame_DrawHP();
  }

  SurfingMinigame_WaitToShowResults(): void {
    if (this.SurfingMinigame_RunDelayTimer()) {
      // .doneDelay
      this.wSurfingMinigameRoutineNumber++;
      this.hSCX = 0x90; // initial horizontal scroll for the results transition
      this.wSurfingMinigameWaveFunctionNumber = 0x72; // flat water before the beach sequence
      this.wSurfingMinigamePikachuState = PIKACHU_STATE.GAME_END;
      this.hLCDCPointer = 0;
      this.wSurfingMinigameSCX = 0;
      this.wSurfingMinigameSCX2 = 0;
      this.wSurfingMinigameSCXHi = 0;
      return;
    }
    this.wSurfingMinigameWaveRandomValue = 0;
    this.SurfingMinigame_UpdateLYOverrides();
    this.SurfingMinigame_SetPikachuHeight();
    this.SurfingMinigame_ReadBGMapBuffer();
    this.SurfingMinigame_CoastAfterGoal();
    this.SurfingMinigame_ResetMusicTempo();
  }

  SurfingMinigame_ScrollToResultsScreen(): void {
    if (this.hSCX === 0) {
      // .finished
      this.wSurfingMinigamePikachuSpeed = 0;
      this.wSurfingMinigameRoutineNumber++;
      this.wSurfingMinigamePikachuState = PIKACHU_STATE.INIT_RESULTS;
      return;
    }
    this.SurfingMinigame_UpdateLYOverrides();
    this.SurfingMinigame_SetPikachuHeight();
    this.SurfingMinigame_ReadBGMapBuffer();
    this.hSCX = (this.hSCX - 4) & 0xff;
    this.wSurfingMinigameXOffset = 256 - 32; // TILEMAP_WIDTH_PX - 32: generate tiles 32 pixels behind the viewport
    this.SurfingMinigame_GenerateBGMap();
  }

  SurfingMinigame_DrawResultsScreenAndWait(): void {
    this.SurfingMinigame_DrawResultsScreen();
    this.wSurfingMinigameRoutineDelay = 32;
    this.wSurfingMinigameRoutineNumber++;
  }

  SurfingMinigame_WriteHPLeftAndWait(): void {
    if (!this.SurfingMinigame_RunDelayTimer()) return;
    this.SurfingMinigame_WriteHPLeft();
    this.wSurfingMinigameRoutineDelay = 64;
    this.wSurfingMinigameRoutineNumber++;
  }

  SurfingMinigame_WriteRadnessAndWait(): void {
    if (!this.SurfingMinigame_RunDelayTimer()) return;
    this.SurfingMinigame_WriteRadness();
    this.wSurfingMinigameRoutineDelay = 64;
    this.wSurfingMinigameRoutineNumber++;
  }

  SurfingMinigame_WriteTotalAndWait(): void {
    if (!this.SurfingMinigame_RunDelayTimer()) return;
    this.SurfingMinigame_WriteTotal();
    this.wSurfingMinigameRoutineDelay = 64;
    this.wSurfingMinigameRoutineNumber++;
  }

  SurfingMinigame_AddRemainingHPToTotalAndWait(): void {
    if (!this.SurfingMinigame_RunDelayTimer()) return;
    const carry = this.SurfingMinigame_AddRemainingHPToTotal();
    this.SurfingMinigame_BCDPrintTotalScore();
    if (!carry) return;
    this.wSurfingMinigameRoutineDelay = 64;
    this.wSurfingMinigameRoutineNumber++;
  }

  private *SurfingMinigame_AddRadnessToTotalAndWait(): Generator<void, void, void> {
    if (!this.SurfingMinigame_RunDelayTimer()) return;
    const carry = this.SurfingMinigame_AddRadnessToTotal();
    this.SurfingMinigame_BCDPrintTotalScore();
    if (!carry) return;
    this.wSurfingMinigameRoutineDelay = 128;
    this.wSurfingMinigameRoutineNumber++;
    if (!(yield* this.DidPlayerGetAHighScore())) return;
    this.SurfingMinigame_PrintTextHiScore();
    this.wSurfingMinigamePikachuState = PIKACHU_STATE.RESULTS;
  }

  SurfingMinigame_WaitLast(): void {
    if (!this.SurfingMinigame_RunDelayTimer()) return;
    this.wSurfingMinigameRoutineNumber++;
  }

  SurfingMinigame_ExitOnPressA(): void {
    this.SurfingMinigame_UpdateLYOverrides();
    if (!(this.hJoyPressed & PAD_A)) return;
    this.wSurfingMinigameRoutineNumber |= 0x80;
  }

  SurfingMinigame_GameOver(): void {
    this.SurfingMinigame_UpdateLYOverrides();
    this.SurfingMinigame_SetPikachuHeight();
    this.SurfingMinigame_ReadBGMapBuffer();
    this.SurfingMinigame_ScrollAndGenerateBGMap();
    this.SurfingMinigame_ResetMusicTempo();
    if (this.wSurfingMinigameGameOverDelay !== 0) {
      this.wSurfingMinigameGameOverDelay--;
      return;
    }
    // .waitPressA
    if (!(this.hJoyPressed & PAD_A)) return;
    this.wSurfingMinigameRoutineNumber |= 0x80;
  }

  /** Carry (true) once the delay has run out; otherwise counts it down. */
  SurfingMinigame_RunDelayTimer(): boolean {
    if (this.wSurfingMinigameRoutineDelay === 0) return true;
    this.wSurfingMinigameRoutineDelay--;
    return false;
  }

  SurfingMinigame_UpdatePikachuDistance(): void {
    const d = this.wSurfingMinigameDistance;
    const hl = ((d[1]! << 8) | d[2]!) + this.wSurfingMinigamePikachuSpeed;
    d[1] = (hl >> 8) & 0xff;
    d[2] = hl & 0xff;
    if (hl <= 0xffff) return;
    d[0] = (d[0]! + 1) & 0xff;
    this.wShadowOAM[wShadowOAMSprite04XCoord] = (this.wShadowOAM[wShadowOAMSprite04XCoord]! - 2) & 0xff;
  }

  // ------------------------------------------------------ Pikachu's callbacks

  private readonly SurfingPikachuObjectCallbacks: readonly ((bc: number) => void)[] = [
    (bc) => this.SurfingMinigameAnimatedObjectFn_nop(bc), // 0
    (bc) => this.SurfingMinigameAnimatedObjectFn_Pikachu(bc), // 1
    (bc) => this.SurfingMinigame_MoveBannerToCenter(bc), // 2
    (bc) => this.SurfingMinigameAnimatedObjectFn_FlippingPika(bc), // 3
    (bc) => this.SurfingMinigameAnimatedObjectFn_IntroAnimationPikachu(bc), // 4
  ];

  private get o(): Uint8Array {
    return this.anim.structs;
  }

  SurfingMinigameAnimatedObjectFn_nop(_bc: number): void {}

  SurfingMinigameAnimatedObjectFn_Pikachu(bc: number): void {
    switch (this.wSurfingMinigamePikachuState) {
      case 0: return this.SurfingMinigame_UpdateRidingPikachu(bc);
      case 1: return this.SurfingMinigame_UpdateJumpingPikachu(bc);
      case 2: return this.SurfingMinigame_UpdateLandingPikachu(bc);
      case 3: return this.SurfingMinigame_UpdateCrashedPikachu(bc);
      case 4: return this.SurfingMinigame_UpdateGameEndPikachu(bc);
      case 5: return this.SurfingMinigame_InitResultsPikachu(bc);
      case 6: return this.SurfingMinigame_UpdateResultsPikachu(bc);
    }
  }

  SurfingMinigame_UpdateRidingPikachu(bc: number): void {
    if (this.wSurfingMinigameGameOver) {
      // .gameOver
      this.wSurfingMinigamePikachuSpeed = 0;
      this.wSurfingMinigamePikachuState = PIKACHU_STATE.GAME_END;
      this.SurfingMinigame_UpdateSurfingFrame(bc);
      return;
    }
    this.SurfingMinigame_SpawnWaterSpray(bc);
    this.o[bc + ANIM_OBJ_Y_COORD] = this.wSurfingMinigamePikachuObjectHeight;
    if (!this.SurfingMinigame_TryStartJump()) {
      this.SurfingMinigame_UpdateSurfingFrame(bc);
      this.SurfingMinigame_SpeedUpPikachu();
      return;
    }
    // .startedJump
    this.SurfingMinigame_UpdateSurfingFrame(bc);
    this.wSurfingMinigamePikachuState = PIKACHU_STATE.JUMPING;
    this.o[bc + ANIM_OBJ_FIELD_C] = 0;
    this.o[bc + ANIM_OBJ_FIELD_D] = 0;
    this.o[bc + ANIM_OBJ_FIELD_E] = 0;
    this.wSurfingMinigameRadnessMeter = 0;
    this.wSurfingMinigameTrickFlags = 0;
    // wChannelSoundIDs + CHAN8 cleared so the sfx always takes the channel
    this.io.playSfx("Surfing_Jump");
  }

  SurfingMinigame_UpdateJumpingPikachu(bc: number): void {
    this.SurfingMinigame_DPadAction(bc);
    if (!this.SurfingMinigame_UpdatePikachuHeight(bc)) return;
    if (this.SurfingMinigame_TileInteraction(bc)) {
      // .crash
      this.wSurfingMinigamePikachuState = PIKACHU_STATE.CRASHED;
      this.wSurfingMinigameCrashTimer = 0x60; // crash animation duration in frames
      this.anim.SetCurrentAnimatedObjectCallbackAndResetFrameStateRegisters(bc, 0x10);
      this.io.playSfx("Surfing_Crash");
      return;
    }
    this.SurfingMinigame_CalculateAndAddRadnessFromStunt(bc);
    this.o[bc + ANIM_OBJ_FIELD_C] = 0;
    this.wSurfingMinigamePikachuState = PIKACHU_STATE.LANDING;
  }

  SurfingMinigame_UpdateLandingPikachu(bc: number): void {
    const a = this.o[bc + ANIM_OBJ_FIELD_C]!;
    if (a >= 0x20) {
      // .done: the landing splash lasts 32 frames
      this.o[bc + ANIM_OBJ_Y_OFFSET] = 0;
      this.wSurfingMinigamePikachuState = PIKACHU_STATE.RIDING;
      return;
    }
    this.o[bc + ANIM_OBJ_FIELD_C] = (a + 4) & 0xff;
    this.o[bc + ANIM_OBJ_Y_OFFSET] = SurfingPikachu_Sine(a, 4); // the count before the four incs
    this.SurfingMinigame_SpawnWaterSpray(bc);
    this.o[bc + ANIM_OBJ_Y_COORD] = this.wSurfingMinigamePikachuObjectHeight;
  }

  SurfingMinigame_UpdateCrashedPikachu(bc: number): void {
    if (this.wSurfingMinigameCrashTimer !== 0) {
      this.wSurfingMinigameCrashTimer--;
      this.o[bc + ANIM_OBJ_Y_COORD] = this.wSurfingMinigamePikachuObjectHeight;
      return;
    }
    this.wSurfingMinigamePikachuState = PIKACHU_STATE.RIDING;
    this.anim.SetCurrentAnimatedObjectCallbackAndResetFrameStateRegisters(bc, 0x4);
  }

  SurfingMinigame_UpdateGameEndPikachu(bc: number): void {
    this.o[bc + ANIM_OBJ_Y_COORD] = this.wSurfingMinigamePikachuObjectHeight;
    this.SurfingMinigame_UpdateSurfingFrame(bc);
  }

  /**
   * The state is never advanced from here, so every frame restarts
   * frameset $f: without a high score Pikachu holds its first frame.
   */
  SurfingMinigame_InitResultsPikachu(bc: number): void {
    this.anim.SetCurrentAnimatedObjectCallbackAndResetFrameStateRegisters(bc, 0xf);
    this.o[bc + ANIM_OBJ_FIELD_C] = 0;
  }

  SurfingMinigame_UpdateResultsPikachu(bc: number): void {
    const a = this.o[bc + ANIM_OBJ_FIELD_C]!;
    this.o[bc + ANIM_OBJ_FIELD_C] = (a + 2) & 0xff;
    const t = a & 0x3f; // 64-frame bobbing cycle
    if (t < 0x20) {
      // .resetOffset: the sine offset only in the second half
      this.o[bc + ANIM_OBJ_Y_OFFSET] = 0;
      return;
    }
    this.o[bc + ANIM_OBJ_Y_OFFSET] = SurfingPikachu_Sine(t, 0x10);
  }

  SurfingMinigame_DPadAction(bc: number): void {
    const o = this.o;
    const de = this.hJoy5;
    if (de & PAD_LEFT) {
      // .dLeft
      o[bc + ANIM_OBJ_FIELD_E] = 0;
      const a = o[bc + ANIM_OBJ_FIELD_D]!;
      o[bc + ANIM_OBJ_FIELD_D] = (a + 1) & 0xff;
      if (a >= 0xb) {
        this.SurfingMinigame_DPadAction_StartTrick(bc);
        this.wSurfingMinigameTrickFlags |= 1 << 0;
      }
      // .dLeftSkip
      if (o[bc + ANIM_OBJ_FRAME_SET]! >= 0xe) o[bc + ANIM_OBJ_FRAME_SET] = 0x1; // .dLeftReset
      else o[bc + ANIM_OBJ_FRAME_SET]++;
      return;
    }
    if (de & PAD_RIGHT) {
      // .dRight
      o[bc + ANIM_OBJ_FIELD_D] = 0;
      const a = o[bc + ANIM_OBJ_FIELD_E]!;
      o[bc + ANIM_OBJ_FIELD_E] = (a + 1) & 0xff;
      if (a >= 0xd) {
        this.SurfingMinigame_DPadAction_StartTrick(bc);
        this.wSurfingMinigameTrickFlags |= 1 << 1;
      }
      // .dRightSkip
      if (o[bc + ANIM_OBJ_FRAME_SET] === 0x1) o[bc + ANIM_OBJ_FRAME_SET] = 0xe; // .dRightReset
      else o[bc + ANIM_OBJ_FRAME_SET] = (o[bc + ANIM_OBJ_FRAME_SET]! - 1) & 0xff;
    }
  }

  /** SurfingMinigame_DPadAction.StartTrick */
  private SurfingMinigame_DPadAction_StartTrick(bc: number): void {
    this.SurfingMinigame_IncreaseRadnessMeter();
    this.o[bc + ANIM_OBJ_FIELD_D] = 0;
    this.o[bc + ANIM_OBJ_FIELD_E] = 0;
    this.io.playSfx("Surfing_Flip");
  }

  /** Carry (true) on a wipeout. */
  SurfingMinigame_TileInteraction(bc: number): boolean {
    const fs = this.o[bc + ANIM_OBJ_FRAME_SET]!;
    const tile = this.wSurfingMinigameBGMapReadBuffer[0]!;
    // W wipeout, H hard, R rough, C clean -- by frameset 1..7; anything else wipes out
    let row: string;
    if (tile === 0x06) row = "WWWHRCR"; // .risingSlope
    else if (tile === 0x14 || tile === 0x12) row = "WHRCCRH"; // .waveCrest / .waveFace
    else if (tile === 0x07) row = "RCRHWWW"; // .fallingSlope
    else row = "WHRCRHW";
    const r = fs >= 1 && fs <= 7 ? row[fs - 1]! : "W";
    if (r === "W") {
      // .wipeout
      this.wSurfingMinigamePikachuSpeed = 0x0040; // reset speed to 0.25 after a wipeout
      return true;
    }
    if (r === "H") this.SurfingMinigame_ReduceSpeedBy128(); // .hardLanding
    else if (r === "R") this.SurfingMinigame_ReduceSpeedBy64(); // .roughLanding
    // .cleanLanding
    this.io.playSfx("Surfing_Land");
    return false;
  }

  SurfingMinigame_SpeedUpPikachu(): void {
    if (this.wSurfingMinigamePikachuSpeed >> 8 >= 0x2) return;
    this.wSurfingMinigamePikachuSpeed = (this.wSurfingMinigamePikachuSpeed + 0x0002) & 0xffff; // 1/128 per frame
  }

  SurfingMinigame_ReduceSpeedBy64(): void {
    const s = this.wSurfingMinigamePikachuSpeed;
    if (s >> 8 === 0 && (s & 0xff) < 0x40) {
      this.wSurfingMinigamePikachuSpeed = s & 0xff00; // avoid underflow: the low byte zeroed
      return;
    }
    this.wSurfingMinigamePikachuSpeed = (s - 0x40) & 0xffff; // -0.25 after a rough landing
  }

  SurfingMinigame_ReduceSpeedBy128(): void {
    const s = this.wSurfingMinigamePikachuSpeed;
    if (s >> 8 === 0 && (s & 0xff) < 0x80) {
      this.wSurfingMinigamePikachuSpeed = s & 0xff00;
      return;
    }
    this.wSurfingMinigamePikachuSpeed = (s - 0x80) & 0xffff; // -0.5 after a hard landing
  }

  /** Carry (true) when a jump starts off a wave crest. */
  SurfingMinigame_TryStartJump(): boolean {
    const px = this.hSCX & 0x7; // horizontal pixel within the current tile
    if (px < 3 || px >= 5) return false;
    if (this.wSurfingMinigameBGMapReadBuffer[0] !== 0x14) return false; // wave crest
    const a = this.SurfingMinigame_GetSpeedDividedBy32();
    if (a < 0xa) return false;
    this.wSurfingMinigameJumpArcMagnitude = a;
    this.SurfingMinigame_ResetJumpArc();
    return true;
  }

  SurfingMinigame_UpdateSurfingFrame(bc: number): void {
    const px = this.hSCX & 0x7;
    if (px < 3 || px >= 5) return;
    const t = this.wSurfingMinigameBGMapReadBuffer[0]!;
    let e: number;
    if (t === 0x06 || t === 0x14) e = 0x6; // .risingSlope (a wave crest too)
    else if (t === 0x07) e = 0x2; // .fallingSlope
    else {
      this.SurfingMinigame_UpdateBoardAngle();
      this.o[bc + ANIM_OBJ_FRAME_SET] = 0x4;
      return;
    }
    // .selectFrame
    this.o[bc + ANIM_OBJ_FRAME_SET] = (e + this.wSurfingMinigameBoardAngleOffset - 1) & 0xff;
  }

  SurfingMinigame_UpdateBoardAngle(): void {
    const a = this.wSurfingMinigameBoardAngleTimer;
    this.wSurfingMinigameBoardAngleTimer = (a + 1) & 0xff;
    if (a & 0x7) return; // every eight frames
    if (this.wSurfingMinigameBoardAngleDecreasing) {
      if (this.wSurfingMinigameBoardAngleOffset === 0) this.wSurfingMinigameBoardAngleDecreasing = 0; // .startIncreasing
      else this.wSurfingMinigameBoardAngleOffset--;
      return;
    }
    // .increase
    if (this.wSurfingMinigameBoardAngleOffset === 2) this.wSurfingMinigameBoardAngleDecreasing = 1; // .startDecreasing
    else this.wSurfingMinigameBoardAngleOffset++;
  }

  SurfingMinigame_GetSpeedDividedBy32(): number {
    return (((this.wSurfingMinigamePikachuSpeed << 3) & 0xffff) >> 8) & 0xff;
  }

  SurfingMinigame_SpawnWaterSpray(bc: number): void {
    const a = this.wSurfingMinigameWaterSprayCounter;
    this.wSurfingMinigameWaterSprayCounter = (a + 1) & 0xff;
    if (a & 0x3) return;
    const d = this.SurfingMinigame_SpawnWaterSpray_GetYCoord();
    const e = this.o[bc + ANIM_OBJ_X_COORD]!;
    this.anim.SpawnAnimatedObject(0xa, d, e); // water spray
  }

  /** SurfingMinigame_SpawnWaterSpray.GetYCoord */
  private SurfingMinigame_SpawnWaterSpray_GetYCoord(): number {
    const h = this.wSurfingMinigameWaveHeight[this.hSCX & TILE_WIDTH ? 9 : 8]!;
    const t = this.wSurfingMinigameBGMapReadBuffer[1]!;
    if (t === 0x06 || t === 0x14) return (h - (this.hSCX & 0x7)) & 0xff; // .risingSlope / .waveCrest
    if (t === 0x07) return ((this.hSCX & 0x7) + h) & 0xff; // .fallingSlope
    return h;
  }

  SurfingMinigame_MoveBannerToCenter(bc: number): void {
    const a = this.o[bc + ANIM_OBJ_X_COORD]!;
    if (a === SURFING_MINIGAME_CENTER_X) return;
    this.o[bc + ANIM_OBJ_X_COORD] = (a + 4) & 0xff; // four pixels per frame
  }

  /** unreferenced */
  SurfingMinigame_MaskCurrentAnimatedObject(bc: number): void {
    this.anim.MaskCurrentAnimatedObjectStruct(bc);
  }

  SurfingMinigameAnimatedObjectFn_FlippingPika(bc: number): void {
    const o = this.o;
    const d = o[bc + ANIM_OBJ_FIELD_B]!;
    if (d === 0) return;
    o[bc + ANIM_OBJ_FIELD_B] = (d - 2) & 0xff;
    const a = o[bc + ANIM_OBJ_FIELD_C]!;
    o[bc + ANIM_OBJ_FIELD_C] = (a + 1) & 0xff;
    let s = SurfingPikachu_Sine(a, d);
    if (s < 0x80) s = (-s) & 0xff; // always bounce upwards (the ROM's ".positive" keeps the negatives)
    o[bc + ANIM_OBJ_Y_OFFSET] = s;
  }

  SurfingMinigameAnimatedObjectFn_IntroAnimationPikachu(bc: number): void {
    const o = this.o;
    const a = o[bc + ANIM_OBJ_FIELD_B]!;
    o[bc + ANIM_OBJ_FIELD_B] = (a + 1) & 0xff;
    if (!(a & 1)) return;
    if (o[bc + ANIM_OBJ_X_COORD] === 0xc0) {
      // .done: fully off the right side of the screen
      this.wSurfingMinigameIntroAnimationFinished = 1;
      this.anim.MaskCurrentAnimatedObjectStruct(bc);
      return;
    }
    o[bc + ANIM_OBJ_X_COORD]++;
  }

  SurfingMinigame_MoveClouds(): void {
    const hl = this.wSurfingMinigamePikachuSpeed + this.wSurfingMinigameCloudScrollFraction;
    this.wSurfingMinigameCloudScrollFraction = hl & 0xff;
    const d = (hl >> 8) & 0xff;
    for (let e = 0; e < 9; e++) {
      // 9 cloud sprites
      const i = wShadowOAMSprite05XCoord + e * OBJ_SIZE;
      this.wShadowOAM[i] = (this.wShadowOAM[i]! + d) & 0xff;
    }
  }

  SurfingMinigame_ReadBGMapBuffer(): void {
    // (an unused read of wSurfingMinigameBGMapReadBuffer)
    const e = ((this.hSCX + 9 * TILE_WIDTH) & 0xff) >> 3; // sample the wave nine tiles into the viewport
    let hl = vBGMap0 + e;
    let c = this.wSurfingMinigamePikachuObjectHeight >> 3; // Pikachu's pixel Y to a tile row
    while (c !== 0) {
      c--;
      hl = (hl + 32) & 0xffff; // TILEMAP_WIDTH
      hl = ((((hl >> 8) & 0x03) | 0x98) << 8) | (hl & 0xff); // HIGH(TILEMAP_AREA - 1), HIGH(vBGMap0)
    }
    // .copy: one "tile" (16 map bytes) at the next VBlank
    this.hVBlankCopySource = hl;
    this.hVBlankCopySize = 1;
  }

  SurfingMinigame_SetPikachuHeight(): void {
    // select one of the two adjacent wave-height samples
    const h = this.wSurfingMinigameWaveHeight[this.hSCX & TILE_WIDTH ? 8 : 7]!;
    const t = this.wSurfingMinigameBGMapReadBuffer[0]!;
    if (t === 0x06 || t === 0x14) this.wSurfingMinigamePikachuObjectHeight = (h - (this.hSCX & 0x7)) & 0xff;
    else if (t === 0x07) this.wSurfingMinigamePikachuObjectHeight = ((this.hSCX & 0x7) + h) & 0xff;
    else this.wSurfingMinigamePikachuObjectHeight = h;
  }

  SurfingMinigame_Deduct1HP(): void {
    if (!this.SurfingMinigame_Deduct1HP_BCD_Deduct(0)) return;
    this.SurfingMinigame_Deduct1HP_BCD_Deduct(1);
  }

  /** SurfingMinigame_Deduct1HP.BCD_Deduct: carry (true) when the byte rolled over to $99. */
  private SurfingMinigame_Deduct1HP_BCD_Deduct(i: number): boolean {
    const hp = this.wSurfingMinigamePikachuHP;
    if (hp[i] === 0) {
      hp[i] = 0x99; // .rollOver
      return true;
    }
    hp[i] = subDaa(hp[i]!, 1, 0)[0];
    return false;
  }

  SurfingMinigame_DrawHP(): void {
    const hp = this.wSurfingMinigamePikachuHP;
    const place = (hl: number, a: number): void => {
      // .PlaceBCDNumber
      this.wShadowOAM[hl] = ((a >> 4) & 0xf) + 0xd0;
      this.wShadowOAM[hl + OBJ_SIZE] = (a & 0xf) + 0xd0;
    };
    place(wShadowOAMSprite00TileID, hp[1]!);
    place(wShadowOAMSprite02TileID, hp[0]!);
  }

  // --------------------------------------------------------- results screen

  private tileMapCopy(src: ArrayLike<number>, x: number, y: number, n = src.length): void {
    const base = y * SCREEN_WIDTH + x;
    for (let i = 0; i < n; i++) {
      // CopyData into wTileMap (running past its end would write on into WRAM)
      if (base + i < this.video.tileMap.length) this.video.tileMap[base + i] = src[i]! & 0xff;
    }
  }

  SurfingMinigame_DrawResultsScreen(): void {
    this.video.tileMap.fill(0);
    this.tileMapCopy(this.tilemaps.beachOutro, 0, 6); // .BeachOutroTilemap
    this.SurfingMinigame_DrawResultsScreen_PlaceTextbox();
    // 9 * OBJ_SIZE from sprite 5's X: sprite 5's Y stays, sprite 14's Y goes
    this.wShadowOAM.fill(0, wShadowOAMSprite05XCoord, wShadowOAMSprite05XCoord + 9 * OBJ_SIZE);
    this.hAutoBGTransferEnabled = 1;
  }

  /** SurfingMinigame_DrawResultsScreen.PlaceTextbox */
  private SurfingMinigame_DrawResultsScreen_PlaceTextbox(): void {
    const placeRow = (y: number, d: number, e: number, a: number): void => {
      let hl = y * SCREEN_WIDTH + 1;
      this.video.tileMap[hl++] = d;
      for (let c = 0; c < SCREEN_WIDTH - 4; c++) this.video.tileMap[hl++] = a; // box interior width
      this.video.tileMap[hl] = e;
    };
    placeRow(1, 0x3b, 0x3c, 0x40);
    for (let y = 2; y <= 8; y++) placeRow(y, 0x3f, 0x3f, 0xff);
    placeRow(9, 0x3d, 0x3e, 0x40);
  }

  SurfingMinigame_PrintTextHiScore(): void {
    this.tileMapCopy(Hi_Score, 6, 8);
  }

  SurfingMinigame_WriteHPLeft(): void {
    this.tileMapCopy(HP_Left, 2, 2);
    this.SurfingMinigame_BCDPrintHPLeft();
  }

  /** Carry (true) once HP has run out; otherwise 99 points moved this frame. */
  SurfingMinigame_AddRemainingHPToTotal(): boolean {
    for (let c = 99; c > 0; c--) {
      const hp = this.wSurfingMinigamePikachuHP;
      if ((hp[0]! | hp[1]!) === 0) return true; // .dead
      this.SurfingMinigame_Deduct1HP();
      this.SurfingMinigame_AddPointsToTotal(1);
    }
    this.io.playSfx("Press_AB");
    return false;
  }

  SurfingMinigame_BCDPrintHPLeft(): void {
    let hl = 2 * SCREEN_WIDTH + 10; // hlcoord 10, 2
    hl = this.SurfingPikachu_PlaceBCDNumber(hl, this.wSurfingMinigamePikachuHP[1]!);
    hl++;
    hl = this.SurfingPikachu_PlaceBCDNumber(hl, this.wSurfingMinigamePikachuHP[0]!);
    this.placePts(hl);
  }

  /** inc hl / inc hl / "Pts" */
  private placePts(hl: number): void {
    hl += 2;
    this.video.tileMap[hl++] = 0x21; // P
    this.video.tileMap[hl++] = 0x25; // t
    this.video.tileMap[hl] = 0x26; // s
  }

  SurfingMinigame_WriteRadness(): void {
    this.tileMapCopy(Radness, 2, 4);
    this.SurfingMinigame_BCDPrintRadness();
  }

  /** Carry (true) once the radness is used up; otherwise 99 points moved this frame. */
  SurfingMinigame_AddRadnessToTotal(): boolean {
    for (let c = 99; c > 0; c--) {
      const r = this.wSurfingMinigameRadnessScore;
      const e = r[0]!;
      if ((e | r[1]!) === 0) return true; // .done
      const [lo, borrow] = subDaa(e, 1, 0);
      const [hi] = subDaa(r[1]!, 0, borrow);
      r[1] = hi;
      r[0] = lo;
      this.SurfingMinigame_AddPointsToTotal(1);
    }
    this.io.playSfx("Press_AB");
    return false;
  }

  SurfingMinigame_BCDPrintRadness(): void {
    this.SurfingPikachu_PlaceBCDNumber(4 * SCREEN_WIDTH + 10, this.wSurfingMinigameRadnessScore[1]!);
    const hl = this.SurfingPikachu_PlaceBCDNumber(4 * SCREEN_WIDTH + 12, this.wSurfingMinigameRadnessScore[0]!);
    this.placePts(hl);
  }

  SurfingMinigame_AddPointsToTotal(e: number): void {
    const t = this.wSurfingMinigameTotalScore;
    const [lo, c] = addDaa(t[0]!, e, 0);
    t[0] = lo;
    const [hi, c2] = addDaa(t[1]!, 0, c);
    t[1] = hi;
    if (!c2) return;
    t[0] = 0x99;
    t[1] = 0x99;
  }

  SurfingMinigame_BCDPrintTotalScore(): void {
    this.SurfingPikachu_PlaceBCDNumber(6 * SCREEN_WIDTH + 10, this.wSurfingMinigameTotalScore[1]!);
    const hl = this.SurfingPikachu_PlaceBCDNumber(6 * SCREEN_WIDTH + 12, this.wSurfingMinigameTotalScore[0]!);
    this.placePts(hl);
  }

  SurfingMinigame_WriteTotal(): void {
    this.tileMapCopy(Total, 2, 6);
    this.SurfingMinigame_BCDPrintRadness();
    this.SurfingMinigame_BCDPrintTotalScore();
  }

  /** Carry (true) with a new high score. */
  private *DidPlayerGetAHighScore(): Generator<void, boolean, void> {
    const hs = this.io.hiScore;
    const t = this.wSurfingMinigameTotalScore;
    let high: boolean;
    if (t[1]! !== ((hs >> 8) & 0xff)) high = t[1]! > ((hs >> 8) & 0xff);
    else high = t[0]! > (hs & 0xff); // equal is .notHighScore
    if (!high) {
      // .notHighScore
      yield* this.WaitForSoundToFinish();
      this.SurfingMinigame_PlayPikaCryIfSurfingPikaInParty(28); // PikachuCry28
      return false;
    }
    // .highScore
    this.io.setHiScore((t[1]! << 8) | t[0]!);
    yield* this.WaitForSoundToFinish();
    this.SurfingMinigame_PlayPikaCryIfSurfingPikaInParty(34); // PikachuCry34
    this.io.playSfx("Get_Item2"); // SFX_GET_ITEM2_4_2
    return true;
  }

  /** PlayPikachuSoundClip runs with interrupts off in the ROM: the screen stalls for the clip. */
  SurfingMinigame_PlayPikaCryIfSurfingPikaInParty(e: number): void {
    if (!this.io.surfingPikachuInParty) return;
    this.io.pikaClip(e);
  }

  SurfingMinigame_IncreaseRadnessMeter(): void {
    let a = this.wSurfingMinigameRadnessMeter + 1;
    if (a >= 4) a = 3;
    this.wSurfingMinigameRadnessMeter = a;
  }

  /**
   * Radness for the trick just landed, by the consecutive flips:
   * single +0050, 2 the same +0150, 3+ the same +0350, 2 different +0180,
   * 3+ different +0500.
   */
  SurfingMinigame_CalculateAndAddRadnessFromStunt(bc: number): void {
    const meter = this.wSurfingMinigameRadnessMeter;
    if (meter === 0) return;
    let spawn: number;
    if ((this.wSurfingMinigameTrickFlags & 0x3) === 0x3) {
      // .mixedChain: a combination of front and back flips
      if (meter < 3) {
        // .add180RadnessPoints
        this.SurfingMinigame_AddRadness(0x50);
        this.SurfingMinigame_AddRadness(0x50);
        this.SurfingMinigame_AddRadness(0x50);
        this.SurfingMinigame_AddRadness(0x30);
        spawn = 0x8;
      } else {
        let a = 10;
        do this.SurfingMinigame_AddRadness(0x50); // .add500Radness50AtATime
        while (--a);
        spawn = 0x9;
      }
    } else {
      let d = meter;
      let e = 1;
      let a = 0;
      do {
        // .getAmountOfRadness: 1, 3, 7
        a = (a + e) & 0xff;
        e = (e << 1) & 0xff;
      } while (--d);
      do this.SurfingMinigame_AddRadness(0x50); // .addRadness50AtATime
      while ((a = (a - 1) & 0xff));
      spawn = (meter + 3) & 0xff;
    }
    const d = (this.o[bc + ANIM_OBJ_Y_COORD]! - 0x10) & 0xff;
    const e = this.o[bc + ANIM_OBJ_X_COORD]!;
    this.anim.SpawnAnimatedObject(spawn, d, e);
  }

  SurfingMinigame_AddRadness(e: number): void {
    const r = this.wSurfingMinigameRadnessScore;
    const [lo, c] = addDaa(r[0]!, e, 0);
    r[0] = lo;
    const [hi, c2] = addDaa(r[1]!, 0, c);
    r[1] = hi;
    if (!c2) return;
    r[0] = 0x99;
    r[1] = 0x99;
  }

  // ---------------------------------------------------------- the BG map

  SurfingMinigame_CoastAfterGoal(): void {
    this.wSurfingMinigameXOffset = 0xa0; // generate tiles ahead of the viewport
    const hl = ((this.hSCX << 8) | this.wSurfingMinigameSCX) + 0x900; // 9.0 pixels per frame
    this.wSurfingMinigameSCX = hl & 0xff;
    this.hSCX = (hl >> 8) & 0xff;
    this.SurfingMinigame_GenerateBGMap();
  }

  SurfingMinigame_ScrollAndGenerateBGMap(): void {
    this.wSurfingMinigameXOffset = 0xa0; // generate tiles ahead of the viewport
    const hl = ((this.hSCX << 8) | this.wSurfingMinigameSCX) + 0x180; // 1.5 pixels per frame
    this.wSurfingMinigameSCX = hl & 0xff;
    this.hSCX = (hl >> 8) & 0xff;
    this.SurfingMinigame_GenerateBGMap();
  }

  SurfingMinigame_GenerateBGMap(): void {
    if (this.hSCX === this.wSurfingMinigameSCX2) return;
    this.wSurfingMinigameSCX2 = this.hSCX;
    const a = this.hSCX & 0xf0; // align to a two-tile boundary
    if (a === this.wSurfingMinigameSCXHi) return;
    this.wSurfingMinigameSCXHi = a;
    // b and c: the height of the next wave to appear, in pixels from the top of the screen
    const { b, c, pattern } = this.SurfingMinigame_GetWaveDataPointers();
    this.wSurfingMinigameWaveHeightBuffer[0] = b;
    this.wSurfingMinigameWaveHeightBuffer[1] = c;
    const wh = this.wSurfingMinigameWaveHeight;
    for (let i = 0; i < SCREEN_WIDTH - 2; i++) wh[i] = wh[i + 2]!; // .copyLoop
    wh[SCREEN_WIDTH - 2] = this.wSurfingMinigameWaveHeightBuffer[0]!;
    wh[SCREEN_WIDTH - 1] = this.wSurfingMinigameWaveHeightBuffer[1]!;
    let hl = 0;
    for (let i = 0; i < 8; i++) {
      // SurfingMinigameWavePattern01 - SurfingMinigameWavePattern00 metatiles
      const m = SurfingMinigame_BGMetatileTable[pattern[i]!]!; // .CopyRedrawSrcTiles
      for (let k = 0; k < 4; k++) this.wRedrawRowOrColumnSrcTiles[hl++] = m[k]!;
    }
    const e = (((this.hSCX + this.wSurfingMinigameXOffset) & 0xff) & 0xf0) >> 3;
    this.hRedrawRowOrColumnDest = vBGMap0 + e;
    this.hRedrawRowOrColumnMode = 1; // REDRAW_COL
  }

  SurfingMinigame_GetWaveDataPointers(): { b: number; c: number; pattern: readonly number[] } {
    const fn = WaveFunctions[this.wSurfingMinigameWaveFunctionNumber]!;
    if (fn.kind === "choose") return this.SurfingMinigame_ChooseNextWaveSequence();
    if (fn.then === "advance") this.wSurfingMinigameWaveFunctionNumber = (this.wSurfingMinigameWaveFunctionNumber + 1) & 0xff;
    else if (fn.then === "reset") this.wSurfingMinigameWaveFunctionNumber = 0;
    return { b: fn.b, c: fn.c, pattern: fn.pattern };
  }

  SurfingMinigame_ChooseNextWaveSequence(): { b: number; c: number; pattern: readonly number[] } {
    const dist = this.wSurfingMinigameDistance[0]!;
    if (dist < 0x16) {
      // .checkParam
      const a = this.wSurfingMinigameWaveRandomValue;
      if (a !== 0) this.wSurfingMinigameWaveFunctionNumber = SurfingMinigame_WaveSequenceStarts[(a - 1) & 0x7]!;
    } else if (dist === 0x16) {
      this.wSurfingMinigameWaveFunctionNumber = 0x6a; // .bigKahuna: the final wave at section 22
    }
    // .gotWave
    return { b: SURFING_MINIGAME_FLAT_WATER_Y, c: SURFING_MINIGAME_FLAT_WATER_Y, pattern: SurfingMinigameWavePatterns[0]! };
  }

  // ---------------------------------------------------------------- the intro

  private *SurfingPikachuMinigameIntro(): Generator<void, void, void> {
    const v = this.video;
    this.SurfingPikachu_ClearTileMap();
    this.ClearSprites();
    this.DisableLCD();
    this.hAutoBGTransferEnabled = 0;
    this.anim.ClearObjectAnimationBuffers();
    v.loadTiles(128, "surf_1c", 0, 144); // SurfingPikachu1Graphics3 -> vChars1
    this.setSurfingPikachuTables();
    this.anim.SpawnAnimatedObject(0xc, SURFING_MINIGAME_FLAT_WATER_Y, SURFING_MINIGAME_CENTER_X); // intro Pikachu
    this.DrawSurfingPikachuMinigameIntroBackground();
    this.hSCX = 0;
    this.hSCY = 0;
    this.hWY = SCREEN_H; // keep the window below the visible screen
    this.RunPaletteCommand("SET_PAL_SURFING_PIKACHU_MINIGAME");
    v.lcdc = LCDC.on | LCDC.winMap9C00 | LCDC.winOn | LCDC.objOn | LCDC.bgOn;
    this.hAutoBGTransferEnabled = 1;
    yield* this.DelayFrame();
    yield* this.DelayFrame();
    yield* this.DelayFrame();
    this.SurfingPikachuMinigame_SetBGPals();
    v.obp0 = ldpal(SHADE_BLACK, SHADE_DARK, SHADE_LIGHT, SHADE_WHITE);
    v.obp1 = ldpal(SHADE_BLACK, SHADE_DARK, SHADE_WHITE, SHADE_WHITE);
    yield* this.DelayFrame();
    this.io.playMusic("Music_SurfingPikachu"); // MUSIC_SURFING_PIKACHU
    this.wSurfingMinigameIntroAnimationFinished = 0;
    for (;;) {
      if (this.wSurfingMinigameIntroAnimationFinished) return;
      this.anim.wCurrentAnimatedObjectOAMBufferOffset = 0;
      this.anim.RunObjectAnimations();
      yield* this.DelayFrame();
    }
  }

  DrawSurfingPikachuMinigameIntroBackground(): void {
    const tm = this.video.tileMap;
    const t = this.tilemaps;
    tm.fill(0xff);
    this.tileMapCopy(t.beachIntro, 0, 6, 12 * SCREEN_WIDTH); // SurfingMinigame_BeachIntroTilemap
    // .CopyBox: the title graphic, 6 rows of 12
    let de = 0;
    for (let b = 0; b < 6; b++) {
      for (let c = 0; c < 12; c++) tm[b * SCREEN_WIDTH + 4 + c] = (t.title[de++] ?? 0) & 0xff;
    }
    // .FillBoxWithFF: clear the instruction text area
    for (let b = 0; b < 3; b++) {
      for (let c = 0; c < SCREEN_WIDTH - 5; c++) tm[(7 + b) * SCREEN_WIDTH + 3 + c] = 0xff;
    }
    this.tileMapCopy(t.useControlPad, 3, 7);
    this.tileMapCopy(t.toSurfRad, 4, 9);
  }

  SurfingMinigame_UpdateLYOverrides(): void {
    // rotate wLYOverrides[16..144] left by one; entry 144 is past the screen
    const L = this.wLYOverrides;
    const base = 2 * 8; // 2 * TILE_HEIGHT
    const a = L[base]!;
    for (let i = 0; i < SCREEN_H - 2 * 8; i++) L[base + i] = L[base + i + 1]!;
    L[base + SCREEN_H - 2 * 8] = a;
  }

  SurfingMinigame_InitScanlineOverrides(): void {
    // the whole $100-byte wLYOverrides
    for (let i = 0; i < 0x100; i++) this.wLYOverrides[i] = SurfingMinigame_LYOverridesInitialSineWave[i & 31]! & 0xff;
  }

  SurfingPikachu_GetJoypad_3FrameBuffer(): void {
    this.Joypad();
    if (this.hFrameCounter !== 0) {
      // .delayed
      this.hJoy5 = 0;
      return;
    }
    this.hJoy5 = this.hJoyHeld;
    // "every three frames": VBlank takes it to 1 then 0, so in fact every other frame
    this.hFrameCounter = 2;
  }

  SurfingPikachuMinigame_BlankPals(): void {
    this.video.bgp = 0;
    this.video.obp0 = 0;
    this.video.obp1 = 0;
  }

  /** unreferenced */
  SurfingPikachuMinigame_NormalPals(): void {
    this.video.bgp = ldpal(SHADE_BLACK, SHADE_DARK, SHADE_LIGHT, SHADE_WHITE);
    this.video.obp0 = this.video.bgp;
    this.video.obp1 = ldpal(SHADE_BLACK, SHADE_DARK, SHADE_WHITE, SHADE_WHITE);
  }

  SurfingPikachu_ClearTileMap(): void {
    this.video.tileMap.fill(0);
  }

  SurfingMinigame_ResetJumpArc(): void {
    this.wSurfingMinigameJumpDescending = 0;
    this.wSurfingMinigameJumpArcFraction = 0;
  }

  /** Carry (true) once Pikachu is back on the water. */
  SurfingMinigame_UpdatePikachuHeight(bc: number): boolean {
    const o = this.o;
    if (!this.wSurfingMinigameJumpDescending) {
      const d = this.wSurfingMinigameJumpArcMagnitude;
      if ((this.wSurfingMinigameJumpArcFraction | d) === 0) {
        // .done
        this.wSurfingMinigameJumpDescending = 1;
        return false;
      }
      let hl = (((d << 8) | this.wSurfingMinigameJumpArcFraction) + 0xff80) & 0xffff; // -0.5: decrease jump velocity
      this.wSurfingMinigameJumpArcFraction = hl & 0xff;
      this.wSurfingMinigameJumpArcMagnitude = hl >> 8;
      const a = hl >> 8;
      // -(4 * a ** 2), negated byte by byte: l = -l but h = ~h with no borrow,
      // one pixel too high whenever the low byte is 0 (a = 0, 8, 16)
      const sq = SurfingMinigame_NTimesDE(4, SurfingMinigame_NTimesDE(a, a));
      hl = ((~(sq >> 8) & 0xff) << 8) | ((-(sq & 0xff)) & 0xff);
      const de = (o[bc + ANIM_OBJ_Y_COORD]! << 8) | o[bc + ANIM_OBJ_FIELD_C]!;
      const r = (hl + de) & 0xffff;
      o[bc + ANIM_OBJ_Y_COORD] = r >> 8;
      o[bc + ANIM_OBJ_FIELD_C] = r & 0xff;
      return false;
    }
    // .descending
    const e = this.wSurfingMinigamePikachuObjectHeight;
    const y = o[bc + ANIM_OBJ_Y_COORD]!;
    if (y < SCREEN_H && y >= e) {
      // .reset
      o[bc + ANIM_OBJ_Y_COORD] = this.wSurfingMinigamePikachuObjectHeight;
      o[bc + ANIM_OBJ_FIELD_C] = 0;
      return true;
    }
    // .okay
    const hl = (((this.wSurfingMinigameJumpArcMagnitude << 8) | this.wSurfingMinigameJumpArcFraction) + 0x80) & 0xffff; // +0.5 fall velocity
    this.wSurfingMinigameJumpArcFraction = hl & 0xff;
    this.wSurfingMinigameJumpArcMagnitude = hl >> 8;
    const a = hl >> 8;
    const sq = SurfingMinigame_NTimesDE(4, SurfingMinigame_NTimesDE(a, a)); // 4 * a ** 2
    const de = (o[bc + ANIM_OBJ_Y_COORD]! << 8) | o[bc + ANIM_OBJ_FIELD_C]!;
    const r = (sq + de) & 0xffff;
    o[bc + ANIM_OBJ_Y_COORD] = r >> 8;
    o[bc + ANIM_OBJ_FIELD_C] = r & 0xff;
    return false;
  }

  /** Two digit tiles into wTileMap at hl; returns hl on the second digit (the ROM's `dec de` has no use here). */
  SurfingPikachu_PlaceBCDNumber(hl: number, a: number): number {
    this.video.tileMap[hl++] = ((a >> 4) & 0xf) + 0xd0;
    this.video.tileMap[hl] = (a & 0xf) + 0xd0;
    return hl;
  }
}

// constants/hardware.inc shades, macros/code.asm ldpal
const SHADE_WHITE = 0;
const SHADE_LIGHT = 1;
const SHADE_DARK = 2;
const SHADE_BLACK = 3;
function ldpal(a: number, b: number, c: number, d: number): number {
  return (a << 6) | (b << 4) | (c << 2) | d;
}
