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
  battleCam(orbit: number, pitch: number, zoom: number): void;
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
  gbTiles?(dest: number, page: number, first: number, count: number): void;
  gbReset?(): void;
  gbMap?(offset: number, hex: string): void;
  gbRegs?(lcdc: number, scx: number, scy: number, wx: number, wy: number, bgp: number, obp0: number, obp1: number): void;
  gbLines?(target: number, hex: string): void;
  gbOam?(hex: string): void;
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
  battleCam(orbit: number, pitch: number, zoom: number): void {
    native.battleCam(orbit, pitch, zoom);
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
  gbTiles(dest: number, page: number, first: number, count: number): void {
    native.gbTiles?.(dest, page, first, count);
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
