// The voxel surface as the guest sees it: one method per VOX_OP
// (contracts/spec/voxel-spec.ts — arg semantics live there) plus the
// per-tick frameDone. The QuickJS binding implements this against the Rust
// core later; RecorderHost is the Bun headless implementation that
// accumulates a .vtrace (SCHEMA.md ".vtrace — the op trace").

import { VOX_OP } from "../../contracts/spec/voxel-spec.ts";

export interface VoxelHost {
  // system
  /** The pak GAME section (boot, cold). Null off-device: Bun loads gen/. */
  gamedata(): ArrayBuffer | null;
  /** The pak AUDIO section — the chip synth's banks + manifest (boot, cold).
   *  Null off-device (Bun loads gen/) and on a pak cooked without audio. */
  audiodata(): ArrayBuffer | null;
  stats(): ArrayBuffer | null;
  reset(): void;
  // world
  mapShow(slot: number, mapId: number, ox: number, oy: number): void;
  mapHide(slot: number): void;
  /** View centre, world px in Q4 (value = px*16). */
  cam(x: number, y: number): void;
  /** PITCH_RUNGS index; the core tweens. */
  pitch(rung: number): void;
  tint(abgr: number): void;
  stamp(mapId: number, cx: number, cy: number, on: number): void;
  /** SGB palette index into the pak's SGB set (VPAL[4 + i]) for the non-ui
   * atlas kinds; -1 restores the GB grayscale ramp. */
  palette(index: number): void;
  // entities
  /** x/y world px Q4; lift px; flags = ENT_FLAG mask. */
  ent(
    slot: number,
    sheet: number,
    frame: number,
    x: number,
    y: number,
    lift: number,
    flags: number,
  ): void;
  entHide(slot: number): void;
  /** EMOTE kind; 0 clears. */
  emote(slot: number, kind: number): void;
  pic(slot: number, page: number, x: number, y: number, w: number, h: number): void;
  /**
   * How far out of the screen a pic stands, Q8 (256 = as far as the 3D
   * slider allows). Applies to the slot's CURRENT picture only: `pic`
   * resets it, so a pop has to be re-stated with the draw it belongs to.
   */
  picDepth(slot: number, depthQ8: number): void;
  picHide(slot: number): void;
  /** True when the bytes reached the card. False means nothing was saved. */
  saveWrite(text: string): boolean | void;
  saveData(): string | undefined;
  /** Write a file and read it back: is this card writable at all? */
  writeTest?(): boolean;
  /** Why the last write failed, from the host. */
  writeErr?(): string | undefined;
  viewer?(): void;
  // ui (the GB tile layer; tile ids index the cooked UI atlas)
  uiTile(x: number, y: number, tile: number): void;
  uiFill(x: number, y: number, w: number, h: number, tile: number): void;
  /** STRING arg; glyphs resolved core-side through the cooked charmap. */
  uiText(x: number, y: number, str: string): void;
  /** Glyphs of the last uiText shown. */
  uiReveal(n: number): void;
  uiClear(): void;
  /** Kanto Gear companion (bottom screen) tile surface. Same 20x18 grid as
   * the top UI; tiles are glyph/border ids. Retained until uiClearBottom. */
  uiTileBottom(x: number, y: number, tile: number): void;
  uiFillBottom(x: number, y: number, w: number, h: number, tile: number): void;
  uiClearBottom(): void;
  /** A whole atlas `page` scaled into a rect on the bottom screen, in its
   * native 320x240 pixel space. Append-only like the tile grid — up to 8
   * per frame, reset by uiClearBottom. */
  uiSpriteBottom(page: number, x: number, y: number, w: number, h: number): void;
  /** Part of a page (sx,sy,sw,sh in page px) into a bottom-screen rect;
   * flags bit 0 mirrors it. Optional: an older host draws nothing. */
  uiSpriteRectBottom?(
    page: number, x: number, y: number, w: number, h: number,
    sx: number, sy: number, sw: number, sh: number, flags?: number,
  ): void;
  /** A flat bottom-screen rect under the grid, shade 0 light .. 3 darkest. */
  uiRectBottom?(x: number, y: number, w: number, h: number, shade: number): void;
  /**
   * One 8x8 move-animation tile for this frame, in GAME BOY pixels
   * (battle/moveanim.ts converts OAM space). `flags` bit 0 is x-flip, bit
   * 1 y-flip. Append-only per frame; `animClear` resets the list.
   */
  animSprite(page: number, tile: number, x: number, y: number, flags: number): void;
  /** Drop every move-animation sprite. */
  animClear(): void;
  /**
   * Declare a rect of UI cells as one side's battle HUD panel, so the core
   * can slide it clear of the 3D sprites as the camera moves. `side` is the
   * card's side (0 player, 1 enemy); `w` 0 clears it.
   */
  uiPanel(side: number, x: number, y: number, w: number, h: number): void;


  /** Field effect billboard at Q4 world px (x, z); frame < 0 clears it. */
  fieldFx(x: number, z: number, frame: number): void;
  // battle
  arena(mapId: number, x: number, y: number, shape: number, rig: number): void;
  /** dx/dy/dz: Q4-px animation offset from the cell centre, optional and 0
   * for a still card (battle/anim.ts). dy lifts — negative sinks the card
   * into the floor, which is the faint slide. */
  card(
    side: number,
    pic: number,
    x: number,
    y: number,
    dx?: number,
    dy?: number,
    dz?: number,
  ): void;
  cardHide(side: number): void;
  /** Q8 fixed 0..256 = 0..1 (zoom Q8 x). */
  battleCam(orbit: number, pitch: number, zoom: number): void;
  arenaEnd(): void;
  // audio (the chip synth: the core interprets the ROM's channel programs)
  /** `bank` is a BANK SLOT — the index of that ROM bank in the manifest's
   *  bankOrder — and `addr` the program's GB address inside it. Every
   *  argument is a number the guest resolved out of the manifest. */
  music(bank: number, addr: number, engine: number, flags: number): void;
  musicStop(): void;
  /** One rAUDVOL level every `ticks` ticks, then the song stops. */
  musicFade(ticks: number): void;
  sfx(
    bank: number,
    addr: number,
    engine: number,
    pitch: number,
    tempo: number,
    flags: number,
  ): void;
  cry(bank: number, addr: number, engine: number, pitch: number, length: number): void;
  /** Boot-time: a sound engine's wave-instrument table. */
  audioWaves(engine: number, bank: number, addr: number): void;
  /** Boot-time: one drum program of a sound engine. */
  audioDrum(engine: number, drum: number, bank: number, addr: number): void;
  /** End of one guest turn: exactly once per host tick. */
  frameDone(tick: number, buttons: number): void;
}

/**
 * Accumulates .vtrace lines (SCHEMA.md): ops buffered during a tick flush
 * under their `t <tick> <buttons>` header at frameDone; `m <name>` lines
 * (checkpoints) land where they execute — between tick blocks, so the sim
 * renders the state after the last completed tick.
 */
export class RecorderHost implements VoxelHost {
  private lines: string[] = ["voxtrace 1"];
  private pending: string[] = [];
  opCount = 0;
  markCount = 0;
  readonly marks: string[] = [];

  private op(code: number, ...args: number[]): void {
    this.pending.push(`o ${code}${args.length ? " " : ""}${args.join(" ")}`);
    this.opCount += 1;
  }

  gamedata(): ArrayBuffer | null {
    this.op(VOX_OP.gamedata);
    return null;
  }
  audiodata(): ArrayBuffer | null {
    this.op(VOX_OP.audiodata);
    return null;
  }
  stats(): ArrayBuffer | null {
    this.op(VOX_OP.stats);
    return null;
  }
  reset(): void {
    this.op(VOX_OP.reset);
  }
  mapShow(slot: number, mapId: number, ox: number, oy: number): void {
    this.op(VOX_OP.mapShow, slot, mapId, ox, oy);
  }
  mapHide(slot: number): void {
    this.op(VOX_OP.mapHide, slot);
  }
  cam(x: number, y: number): void {
    this.op(VOX_OP.cam, x, y);
  }
  pitch(rung: number): void {
    this.op(VOX_OP.pitch, rung);
  }
  tint(abgr: number): void {
    this.op(VOX_OP.tint, abgr);
  }
  stamp(mapId: number, cx: number, cy: number, on: number): void {
    this.op(VOX_OP.stamp, mapId, cx, cy, on);
  }
  palette(index: number): void {
    this.op(VOX_OP.palette, index);
  }
  ent(
    slot: number,
    sheet: number,
    frame: number,
    x: number,
    y: number,
    lift: number,
    flags: number,
  ): void {
    this.op(VOX_OP.ent, slot, sheet, frame, x, y, lift, flags);
  }
  entHide(slot: number): void {
    this.op(VOX_OP.entHide, slot);
  }
  emote(slot: number, kind: number): void {
    this.op(VOX_OP.emote, slot, kind);
  }
  uiTile(x: number, y: number, tile: number): void {
    this.op(VOX_OP.uiTile, x, y, tile);
  }
  uiFill(x: number, y: number, w: number, h: number, tile: number): void {
    this.op(VOX_OP.uiFill, x, y, w, h, tile);
  }
  /**
   * The pic layer and the save slot: recorded like everything else so a
   * trace is the whole frame, and present at ALL, which they were not.
   * A RecorderHost that cannot answer `pic` threw the moment a screen with
   * a portrait opened -- the trainer card, the hall of fame, and now the
   * evolution movie -- which is why several tests died in the scene rather
   * than failing an assertion.
   */
  pic(slot: number, page: number, x: number, y: number, w: number, h: number): void {
    this.op(VOX_OP.pic, slot, page, x, y, w, h);
  }
  picDepth(slot: number, depthQ8: number): void {
    this.op(VOX_OP.picDepth, slot, depthQ8);
  }
  picHide(slot: number): void {
    this.op(VOX_OP.picHide, slot);
  }
  /** The save the last write committed; `saveData` reads it back. */
  private savedText: string | undefined;
  saveWrite(text: string): void {
    this.savedText = text;
  }
  saveData(): string | undefined {
    return this.savedText;
  }

  uiText(x: number, y: number, str: string): void {
    // the string-arg op form: `s <code> <i32> <i32> <json-string>`
    this.pending.push(`s ${VOX_OP.uiText} ${x} ${y} ${JSON.stringify(str)}`);
    this.opCount += 1;
  }
  uiReveal(n: number): void {
    this.op(VOX_OP.uiReveal, n);
  }
  uiClear(): void {
    this.op(VOX_OP.uiClear);
  }
  uiTileBottom(x: number, y: number, tile: number): void {
    this.op(VOX_OP.uiTileBottom, x, y, tile);
  }
  uiFillBottom(x: number, y: number, w: number, h: number, tile: number): void {
    this.op(VOX_OP.uiFillBottom, x, y, w, h, tile);
  }
  uiClearBottom(): void {
    this.op(VOX_OP.uiClearBottom);
  }
  uiSpriteBottom(page: number, x: number, y: number, w: number, h: number): void {
    this.op(VOX_OP.uiSpriteBottom, page, x, y, w, h);
  }
  uiSpriteRectBottom(
    page: number, x: number, y: number, w: number, h: number,
    sx: number, sy: number, sw: number, sh: number, flags = 0,
  ): void {
    this.op(VOX_OP.uiSpriteRectBottom, page, x, y, w, h, sx | (sy << 16), sw | (sh << 16), flags);
  }
  uiRectBottom(x: number, y: number, w: number, h: number, shade: number): void {
    this.op(VOX_OP.uiRectBottom, x, y, w, h, shade);
  }

  animSprite(page: number, tile: number, x: number, y: number, flags: number): void {
    this.op(VOX_OP.animSprite, page, tile, x, y, flags);
  }

  animClear(): void {
    this.op(VOX_OP.animClear);
  }

  uiPanel(side: number, x: number, y: number, w: number, h: number): void {
    this.op(VOX_OP.uiPanel, side, x, y, w, h);
  }
  fieldFx(x: number, z: number, frame: number): void {
    // Args pass straight through, like card/arena: the caller supplies Q4.
    this.op(VOX_OP.fieldFx, x, z, frame);
  }
  arena(mapId: number, x: number, y: number, shape: number, rig: number): void {
    this.op(VOX_OP.arena, mapId, x, y, shape, rig);
  }
  card(side: number, pic: number, x: number, y: number, dx = 0, dy = 0, dz = 0): void {
    this.op(VOX_OP.card, side, pic, x, y, dx, dy, dz);
  }
  cardHide(side: number): void {
    this.op(VOX_OP.cardHide, side);
  }
  battleCam(orbit: number, pitch: number, zoom: number): void {
    this.op(VOX_OP.battleCam, orbit, pitch, zoom);
  }
  arenaEnd(): void {
    this.op(VOX_OP.arenaEnd);
  }
  music(bank: number, addr: number, engine: number, flags: number): void {
    this.op(VOX_OP.music, bank, addr, engine, flags);
  }
  musicStop(): void {
    this.op(VOX_OP.musicStop);
  }
  musicFade(ticks: number): void {
    this.op(VOX_OP.musicFade, ticks);
  }
  sfx(
    bank: number,
    addr: number,
    engine: number,
    pitch: number,
    tempo: number,
    flags: number,
  ): void {
    this.op(VOX_OP.sfx, bank, addr, engine, pitch, tempo, flags);
  }
  cry(bank: number, addr: number, engine: number, pitch: number, length: number): void {
    this.op(VOX_OP.cry, bank, addr, engine, pitch, length);
  }
  audioWaves(engine: number, bank: number, addr: number): void {
    this.op(VOX_OP.audioWaves, engine, bank, addr);
  }
  audioDrum(engine: number, drum: number, bank: number, addr: number): void {
    this.op(VOX_OP.audioDrum, engine, drum, bank, addr);
  }

  frameDone(tick: number, buttons: number): void {
    this.lines.push(`t ${tick} ${buttons}`);
    this.lines.push(...this.pending);
    this.pending = [];
  }

  /** Checkpoint: the sim renders + hashes here (tape `mark`). */
  mark(name: string): void {
    this.lines.push(`m ${name}`);
    this.marks.push(name);
    this.markCount += 1;
  }

  text(): string {
    return `${this.lines.join("\n")}\n`;
  }
}
