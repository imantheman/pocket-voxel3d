// The QuickJS host surface, shared by the Gen 1 entry (psp-main.ts) and
// the Gold entry (gen2/main.ts): the natives the 3DS/PSP binary registers as
// `globalThis.voxel`, and QuickJsHost, the VoxelHost that forwards to them.
// Split out of psp-main.ts unchanged.

import type { VoxelHost } from "./host.ts";

export interface VoxelNative {
  gamedata(): string;
  audiodata(): ArrayBuffer | undefined;
  stats(): void;
  reset(): void;
  mapShow(slot: number, mapId: number, ox: number, oy: number): void;
  mapHide(slot: number): void;
  cam(x: number, y: number): void;
  pitch(rung: number): void;
  tint(abgr: number): void;
  stamp(mapId: number, cx: number, cy: number, on: number): void;
  palette(index: number): void;
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
  emote(slot: number, kind: number): void;
  pic(slot: number, page: number, x: number, y: number, w: number, h: number): void;
  picDepth(slot: number, depthQ8: number): void;
  picHide(slot: number): void;
  saveWrite(text: string): boolean | void;
  saveData(): string | undefined;
  writeTest?(): boolean;
  writeErr?(): string | undefined;
  viewer?(): void;
  uiTile(x: number, y: number, tile: number): void;
  uiFill(x: number, y: number, w: number, h: number, tile: number): void;
  uiText(x: number, y: number, str: string): void;
  uiReveal(n: number): void;
  uiClear(): void;
  uiTileBottom(x: number, y: number, tile: number): void;
  uiFillBottom(x: number, y: number, w: number, h: number, tile: number): void;
  uiClearBottom(): void;
  uiSpriteBottom(page: number, x: number, y: number, w: number, h: number): void;
  uiSpriteRectBottom?(
    page: number, x: number, y: number, w: number, h: number, src: number, size: number, flags: number,
  ): void;
  uiRectBottom?(x: number, y: number, w: number, h: number, shade: number): void;
  animSprite(page: number, tile: number, x: number, y: number, flags: number): void;
  animClear(): void;
  uiPanel(side: number, x: number, y: number, w: number, h: number): void;
  /** spec `camSpeed`: the C-stick's rate multiplier, Q8. */
  camSpeed?(q8: number): void;
  /** The circle pad as the host last read it: (x << 16) | (y & 0xffff),
   * each a signed 16-bit in the pad's own units (-156..156 on a 3DS). */
  stick?(): number;
  /** The OPTION screen's file beside the save (Gold): its text, or undefined. */
  optionsData?(): string | undefined;
  /** Write that file; false if the card did not take it. */
  optionsWrite?(text: string): boolean;
  /** Whether this tick is the last before the host renders (it may run several to catch up). */
  lastStep?(): boolean;
  fieldFx(x: number, z: number, frame: number): void;
  arena(mapId: number, x: number, y: number, shape: number, rig: number): void;
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
  battleCam(orbit: number, pitch: number, zoom: number, lift?: number, dist?: number): void;
  arenaEnd(): void;
  // audio — optional on the binding: an EBOOT built before the ops existed
  // simply has no such function, and the guest must not crash on it.
  music?(bank: number, addr: number, engine: number, flags: number): void;
  musicStop?(): void;
  musicFade?(ticks: number): void;
  sfx?(
    bank: number,
    addr: number,
    engine: number,
    pitch: number,
    tempo: number,
    flags: number,
  ): void;
  cry?(bank: number, addr: number, engine: number, pitch: number, length: number): void;
  pikaPcm?(clip: number): void;
  gbShow?(on: number): void;
  gbTiles?(dest: number, page: number, first: number, count: number, wide?: number, stride?: number, map?: number): void;
  gbReset?(): void;
  gbMap?(offset: number, hex: string): void;
  gbRegs?(lcdc: number, scx: number, scy: number, wx: number, wy: number, bgp: number, obp0: number, obp1: number): void;
  gbLines?(target: number, hex: string): void;
  gbOam?(hex: string): void;
  gbWide?(w: number, h: number, scx: number, scy: number, full: number): void;
  gbWideObjs?(hex: string): void;
  gbColours?(bg: number, obp0: number, obp1: number): void;
  /** The Gold screen (voxel-spec.ts lcdShow..lcdLines; gen2/platform/lcd.ts). */
  lcdShow?(on: number): void;
  lcdBank?(base: number, page: number, count: number): void;
  lcdReset?(): void;
  lcdCells?(offset: number, hex: string): void;
  lcdRegs?(scx: number, scy: number, wx: number, wy: number, flags: number): void;
  lcdObjs?(hex: string): void;
  lcdPals?(first: number, hex: string): void;
  lcdLines?(target: number, hex: string): void;
  /**
   * The typed-array forms of lcdCells/lcdObjs/lcdLines (the 3DS shim's): the
   * whole cell map, the objects packed y, x, tile, attribute, the line
   * values -- the guest's own arrays, diffed natively. A host without them
   * gets the hex ops.
   */
  lcdCellsBin?(cells: Uint16Array, attrs: Uint8Array): void;
  lcdObjsBin?(packed: Int16Array, count: number): void;
  lcdLinesBin?(target: number, lines: Uint8Array): void;
  /** The under layer (voxel-spec.ts lcdUnder..lcdUnderAt; VIEW 2D). */
  lcdUnder?(w: number, h: number): void;
  lcdUnderRow?(row: number, hex: string): void;
  lcdUnderAt?(on: number, x: number, y: number): void;
  /** voxel-spec.ts lcdTall: this Gold screen shown whole (the bottom screen). */
  lcdTall?(on: number): void;
  /** voxel-spec.ts lcdUnderView, and the canvas's objects packed as lcdObjsBin's. */
  lcdUnderView?(w: number, h: number, wide: number): void;
  lcdUnderObjsBin?(packed: Int16Array, count: number): void;
  /** Debug: the next frame's top screen to the card (main.rs dump_top_screen). */
  screenshot?(): void;
  /** voxel-spec.ts flatWorld: the 3D world is not seen; build no meshes. */
  flatWorld?(on: number): void;
  /** voxel-spec.ts lcdAlias: the under layer's tile `from` drawn as `to`. */
  lcdAlias?(slot: number, from: number, to: number): void;
  daytime?(k: number): void;
  /** spec `tiltShift`: 0 off, 1 soft, 2 strong. */
  tiltShift?(level: number): void;
  /** spec `lcdTarget`: 0 the top Gold screen, 1 the bottom. */
  lcdTarget?(k: number): void;
  /** spec `cardPal`: a battle card's four RGB555 colours; c0 < 0 drops them. */
  cardPal?(side: number, c0: number, c1: number, c2: number, c3: number): void;
  audioWaves?(engine: number, bank: number, addr: number): void;
  audioDrum?(engine: number, drum: number, bank: number, addr: number): void;
}

export const native = (globalThis as unknown as { voxel: VoxelNative }).voxel;
/** The 3DS circle pad's full throw in its own units (ctrulib circlePosition). */
export const STICK_RANGE = 156;

/**
 * VoxelHost over the native surface: every op forwards 1:1. `frameDone` is
 * a no-op — the host advances the core Scene's tick clock itself, after
 * `frame(buttons)` returns (one guest turn per host tick).
 */
export class QuickJsHost implements VoxelHost {
  saveWrite(text: string): boolean | void {
    return native.saveWrite(text);
  }

  viewer(): void {
    (native as any).viewer?.();
  }

  writeTest(): boolean {
    return native.writeTest ? native.writeTest() === true : true;
  }

  writeErr(): string | undefined {
    return native.writeErr ? native.writeErr() : undefined;
  }

  saveData(): string | undefined {
    return native.saveData();
  }

  gamedata(): ArrayBuffer | null {
    // The boot path below reads the GAME string directly; the game never
    // crosses for data again after construction.
    return null;
  }
  audiodata(): ArrayBuffer | null {
    // One cold read at boot, like gamedata(): setAudioFromPak() parses the
    // manifest half and leaves the programs in the pak, where the core reads
    // them. undefined = a pak cooked without audio, and the director then
    // resolves nothing and emits no op.
    return native.audiodata ? (native.audiodata() ?? null) : null;
  }
  stats(): ArrayBuffer | null {
    native.stats();
    return null;
  }
  reset(): void {
    native.reset();
  }
  mapShow(slot: number, mapId: number, ox: number, oy: number): void {
    native.mapShow(slot, mapId, ox, oy);
  }
  mapHide(slot: number): void {
    native.mapHide(slot);
  }
  cam(x: number, y: number): void {
    native.cam(x, y);
  }
  pitch(rung: number): void {
    native.pitch(rung);
  }
  tint(abgr: number): void {
    native.tint(abgr);
  }
  stamp(mapId: number, cx: number, cy: number, on: number): void {
    native.stamp(mapId, cx, cy, on);
  }
  palette(index: number): void {
    native.palette(index);
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
    native.ent(slot, sheet, frame, x, y, lift, flags);
  }
  pic(slot: number, page: number, x: number, y: number, w: number, h: number): void {
    native.pic(slot, page, x, y, w, h);
  }
  picDepth(slot: number, depthQ8: number): void {
    native.picDepth(slot, depthQ8);
  }
  picHide(slot: number): void {
    native.picHide(slot);
  }
  entHide(slot: number): void {
    native.entHide(slot);
  }
  emote(slot: number, kind: number): void {
    native.emote(slot, kind);
  }
  uiTile(x: number, y: number, tile: number): void {
    native.uiTile(x, y, tile);
  }
  uiFill(x: number, y: number, w: number, h: number, tile: number): void {
    native.uiFill(x, y, w, h, tile);
  }
  uiText(x: number, y: number, str: string): void {
    native.uiText(x, y, str);
  }
  uiReveal(n: number): void {
    native.uiReveal(n);
  }
  uiClear(): void {
    native.uiClear();
  }
  uiTileBottom(x: number, y: number, tile: number): void {
    native.uiTileBottom(x, y, tile);
  }
  uiFillBottom(x: number, y: number, w: number, h: number, tile: number): void {
    native.uiFillBottom(x, y, w, h, tile);
  }
  uiClearBottom(): void {
    native.uiClearBottom();
  }
  uiSpriteBottom(page: number, x: number, y: number, w: number, h: number): void {
    native.uiSpriteBottom(page, x, y, w, h);
  }
  uiSpriteRectBottom(
    page: number, x: number, y: number, w: number, h: number,
    sx: number, sy: number, sw: number, sh: number, flags = 0,
  ): void {
    native.uiSpriteRectBottom?.(page, x, y, w, h, sx | (sy << 16), sw | (sh << 16), flags);
  }
  uiRectBottom(x: number, y: number, w: number, h: number, shade: number): void {
    native.uiRectBottom?.(x, y, w, h, shade);
  }
  animSprite(page: number, tile: number, x: number, y: number, flags: number): void {
    native.animSprite(page, tile, x, y, flags);
  }
  animClear(): void {
    native.animClear();
  }
  uiPanel(side: number, x: number, y: number, w: number, h: number): void {
    native.uiPanel(side, x, y, w, h);
  }
  fieldFx(x: number, z: number, frame: number): void {
    native.fieldFx(x, z, frame);
  }
  arena(mapId: number, x: number, y: number, shape: number, rig: number): void {
    native.arena(mapId, x, y, shape, rig);
  }
  card(side: number, pic: number, x: number, y: number, dx = 0, dy = 0, dz = 0): void {
    native.card(side, pic, x, y, dx, dy, dz);
  }
  cardHide(side: number): void {
    native.cardHide(side);
  }
  battleCam(orbit: number, pitch: number, zoom: number, lift = 0, dist = 0): void {
    native.battleCam(orbit, pitch, zoom, lift, dist);
  }
  arenaEnd(): void {
    native.arenaEnd();
  }
  music(bank: number, addr: number, engine: number, flags: number): void {
    native.music?.(bank, addr, engine, flags);
  }
  musicStop(): void {
    native.musicStop?.();
  }
  musicFade(ticks: number): void {
    native.musicFade?.(ticks);
  }
  sfx(
    bank: number,
    addr: number,
    engine: number,
    pitch: number,
    tempo: number,
    flags: number,
  ): void {
    native.sfx?.(bank, addr, engine, pitch, tempo, flags);
  }
  cry(bank: number, addr: number, engine: number, pitch: number, length: number): void {
    native.cry?.(bank, addr, engine, pitch, length);
  }
  pikaPcm(clip: number): void {
    native.pikaPcm?.(clip);
  }
  gbShow(on: number): void {
    native.gbShow?.(on);
  }
  gbTiles(dest: number, page: number, first: number, count: number, wide = 0, stride = 0, map = 0): void {
    native.gbTiles?.(dest, page, first, count, wide, stride, map);
  }
  gbReset(): void {
    native.gbReset?.();
  }
  gbMap(offset: number, hex: string): void {
    native.gbMap?.(offset, hex);
  }
  gbRegs(lcdc: number, scx: number, scy: number, wx: number, wy: number, bgp: number, obp0: number, obp1: number): void {
    native.gbRegs?.(lcdc, scx, scy, wx, wy, bgp, obp0, obp1);
  }
  gbLines(target: number, hex: string): void {
    native.gbLines?.(target, hex);
  }
  gbOam(hex: string): void {
    native.gbOam?.(hex);
  }
  // the wide picture only where the shim has it: view2d asks (wideSupported)
  gbWide = native.gbWide ? (w: number, h: number, scx: number, scy: number, full: number): void => native.gbWide!(w, h, scx, scy, full) : undefined;
  gbWideObjs = native.gbWideObjs ? (hex: string): void => native.gbWideObjs!(hex) : undefined;
  gbColours(bg: number, obp0: number, obp1: number): void {
    native.gbColours?.(bg, obp0, obp1);
  }
  lcdShow(on: number): void {
    native.lcdShow?.(on);
  }
  lcdBank(base: number, page: number, count: number): void {
    native.lcdBank?.(base, page, count);
  }
  lcdReset(): void {
    native.lcdReset?.();
  }
  lcdCells(offset: number, hex: string): void {
    native.lcdCells?.(offset, hex);
  }
  lcdRegs(scx: number, scy: number, wx: number, wy: number, flags: number): void {
    native.lcdRegs?.(scx, scy, wx, wy, flags);
  }
  lcdObjs(hex: string): void {
    native.lcdObjs?.(hex);
  }
  lcdPals(first: number, hex: string): void {
    native.lcdPals?.(first, hex);
  }
  lcdLines(target: number, hex: string): void {
    native.lcdLines?.(target, hex);
  }
  // only where the shim has them: Lcd.end takes their presence as the choice
  lcdCellsBin = native.lcdCellsBin ? (cells: Uint16Array, attrs: Uint8Array): void => native.lcdCellsBin!(cells, attrs) : undefined;
  lcdObjsBin = native.lcdObjsBin ? (packed: Int16Array, count: number): void => native.lcdObjsBin!(packed, count) : undefined;
  lcdLinesBin = native.lcdLinesBin ? (target: number, lines: Uint8Array): void => native.lcdLinesBin!(target, lines) : undefined;
  // the 2D canvas only where the shim has it: Lcd.canvasSupported asks
  lcdUnderView = native.lcdUnderView ? (w: number, h: number, wide: number): void => native.lcdUnderView!(w, h, wide) : undefined;
  lcdUnderObjsBin = native.lcdUnderObjsBin ? (packed: Int16Array, count: number): void => native.lcdUnderObjsBin!(packed, count) : undefined;
  screenshot = native.screenshot ? (): void => native.screenshot!() : undefined;
  lcdTall(on: number): void {
    native.lcdTall?.(on);
  }
  lcdUnder(w: number, h: number): void {
    native.lcdUnder?.(w, h);
  }
  lcdUnderRow(row: number, hex: string): void {
    native.lcdUnderRow?.(row, hex);
  }
  lcdUnderAt(on: number, x: number, y: number): void {
    native.lcdUnderAt?.(on, x, y);
  }
  flatWorld(on: number): void {
    native.flatWorld?.(on);
  }
  lcdAlias(slot: number, from: number, to: number): void {
    native.lcdAlias?.(slot, from, to);
  }
  daytime(k: number): void {
    native.daytime?.(k);
  }
  tiltShift(level: number): void {
    native.tiltShift?.(level);
  }
  lcdTarget(k: number): void {
    native.lcdTarget?.(k);
  }
  cardPal(side: number, c0: number, c1: number, c2: number, c3: number): void {
    native.cardPal?.(side, c0, c1, c2, c3);
  }
  audioWaves(engine: number, bank: number, addr: number): void {
    native.audioWaves?.(engine, bank, addr);
  }
  audioDrum(engine: number, drum: number, bank: number, addr: number): void {
    native.audioDrum?.(engine, drum, bank, addr);
  }
  frameDone(_tick: number, _buttons: number): void {
    // host-side: the EBOOT ticks the scene after frame() returns
  }
}
