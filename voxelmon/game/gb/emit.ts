// The GB screen's op stream: mirrors a GbVideo (gb/video.ts) into the core
// (gb.rs) with the `gb*` ops, sending only what changed since the last
// frame -- a scrolling minigame rewrites a column of the map every few
// frames, not the map.
import type { VoxelHost } from "../host.ts";
import { WIDE_COLS_MAX, WIDE_ROWS_MAX, type GbVideo } from "./video.ts";

/** How the emitter names things the core addresses by number. */
export interface GbResolve {
  /** The atlas page a tile sheet cooked into, or -1. */
  page(sheet: string): number;
  /** An SGB palette's index (the `palette` op's), or -1. */
  palette(name: string): number;
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
/** Four digits (a 16-bit value, two's complement for the wide objects). */
const HEX4: string[] = [];
function hex4(v: number): string {
  return HEX4[v] ??= HEX[(v >> 8) & 0xff]! + HEX[v & 0xff]!;
}
function hex(bytes: ArrayLike<number>, from = 0, to = bytes.length): string {
  let s = "";
  for (let i = from; i < to; i++) s += HEX[bytes[i]! & 0xff];
  return s;
}

/** Runs closer than this are sent as one (each op has its own cost). */
const MERGE_GAP = 8;

export class GbEmitter {
  private shown = false;
  private readonly maps = new Uint8Array(2048);
  private loads = "";
  private loadsRef: unknown = null;
  /** Bytes of OAM sent last (only the used front of it is sent). */
  private oamLen = 0;
  private readonly oamNow = new Uint8Array(160);
  private readonly regsNow = new Int32Array(8);
  private colours0 = "";
  private colours1 = "";
  private lines = "";
  private colours = "";
  private readonly wideMap = new Uint8Array(WIDE_COLS_MAX * WIDE_ROWS_MAX);
  private wide = "";
  private wideObjs = "";

  /** Emit this frame's GB screen, or take it down when `v` is null. */
  emit(host: VoxelHost, v: GbVideo | null, resolve: GbResolve): void {
    if (!v) {
      if (this.shown) {
        host.gbShow?.(0);
        this.shown = false;
      }
      return;
    }
    let fresh = false;
    if (!this.shown) {
      host.gbReset?.();
      host.gbShow?.(1);
      this.shown = true;
      this.maps.fill(0);
      this.wideMap.fill(0);
      this.wide = this.wideObjs = "";
      this.loads = this.lines = this.colours = "";
      this.loadsRef = null;
      this.oamLen = 0;
      fresh = true;
    }
    if (v.loads !== this.loadsRef) {
      this.loadsRef = v.loads;
      const loads = v.loads.map((l) => `${l.dest},${l.sheet},${l.first},${l.count},${l.wide ?? 0},${l.stride ?? 0},${l.map ?? 0}`).join("|");
      if (loads !== this.loads) {
        this.loads = loads;
        for (const l of v.loads) host.gbTiles?.(l.dest, resolve.page(l.sheet), l.first, l.count, l.wide ?? 0, l.stride ?? 0, l.map ?? 0);
      }
    }
    // the map, as runs of changed bytes
    let i = fresh || v.mapsDirty !== false ? 0 : 2048;
    while (i < 2048) {
      if (v.maps[i] === this.maps[i]) { i++; continue; }
      let end = i + 1;
      let gap = 0;
      for (let j = i + 1; j < 2048 && gap < MERGE_GAP; j++) {
        if (v.maps[j] !== this.maps[j]) { end = j + 1; gap = 0; } else gap++;
      }
      host.gbMap?.(i, hex(v.maps, i, end));
      this.maps.set(v.maps.subarray(i, end), i);
      i = end;
    }
    // the wide picture: its size and scroll, its ring (offset 0x800) while
    // it is on, its objects
    const wideOn = v.wideW > 0 && v.wideH > 0 && !!host.gbWide;
    const wide = wideOn ? `${v.wideW},${v.wideH},${v.wideScx},${v.wideScy},${v.wideFull ? 1 : 0},${v.wideCols},${v.wideRows}` : "";
    if (wide !== this.wide) {
      this.wide = wide;
      host.gbWide?.(wideOn ? v.wideW : 0, wideOn ? v.wideH : 0, v.wideScx, v.wideScy, v.wideFull ? 1 : 0, v.wideCols, v.wideRows);
    }
    if (wideOn) {
      // only the ring ranges written since the last send (a step's row or
      // column), each compared against what the core holds
      const send = (from: number, to: number): void => {
        let j = from;
        while (j < to) {
          if (v.wideMap[j] === this.wideMap[j]) { j++; continue; }
          let end = j + 1;
          let gap = 0;
          for (let k = j + 1; k < to && gap < MERGE_GAP; k++) {
            if (v.wideMap[k] !== this.wideMap[k]) { end = k + 1; gap = 0; } else gap++;
          }
          host.gbMap?.(0x800 + j, hex(v.wideMap, j, end));
          this.wideMap.set(v.wideMap.subarray(j, end), j);
          j = end;
        }
      };
      if (fresh || v.wideSpansAll) send(0, v.wideCols * v.wideRows);
      else for (let s = 0; s < v.wideSpans.length; s += 2) send(v.wideSpans[s]!, v.wideSpans[s + 1]!);
      v.wideSpans.length = 0;
      v.wideSpansAll = false;
      let objs = "";
      const p = v.wideObjs;
      for (let k = 0; k < v.wideObjCount; k++) {
        objs += hex4(p[k * 4]! & 0xffff) + hex4(p[k * 4 + 1]! & 0xffff) + HEX[p[k * 4 + 2]! & 0xff] + HEX[p[k * 4 + 3]! & 0xff];
      }
      if (objs !== this.wideObjs) {
        this.wideObjs = objs;
        host.gbWideObjs?.(objs);
      }
    }
    // the registers, compared as numbers (no string a frame)
    const r = this.regsNow;
    if (fresh || r[0] !== v.lcdc || r[1] !== v.scx || r[2] !== v.scy || r[3] !== v.wx || r[4] !== v.wy ||
        r[5] !== v.bgp || r[6] !== v.obp0 || r[7] !== v.obp1) {
      r[0] = v.lcdc; r[1] = v.scx; r[2] = v.scy; r[3] = v.wx; r[4] = v.wy; r[5] = v.bgp; r[6] = v.obp0; r[7] = v.obp1;
      host.gbRegs?.(v.lcdc, v.scx & 255, v.scy & 255, v.wx & 255, v.wy & 255, v.bgp, v.obp0, v.obp1);
    }
    const target = v.lineTarget === "scy" ? 1 : v.lineTarget === "scx" ? 2 : 0;
    const lines = target ? `${target}:${hex(v.lines)}` : "0";
    if (lines !== this.lines) {
      this.lines = lines;
      host.gbLines?.(target, target ? hex(v.lines) : "");
    }
    // OAM up to its last used entry (and over whatever was sent past that
    // last time, to clear it)
    const o = v.oam;
    let used = 160;
    while (used > 0 && o[used - 1] === 0 && o[used - 2] === 0 && o[used - 3] === 0 && o[used - 4] === 0) used -= 4;
    const len = Math.max(used, this.oamLen);
    // as sent last time? (bytes past `used` are zero, as they were sent)
    const was = this.oamNow;
    let same = !fresh && len === this.oamLen;
    for (let k = 0; same && k < len; k++) if (o[k] !== was[k]) same = false;
    if (!same) {
      was.set(o);
      this.oamLen = used;
      host.gbOam?.(hex(o, 0, len));
    }
    const c = v.colours;
    if (fresh || c.bg !== this.colours || c.obj0 !== this.colours0 || c.obj1 !== this.colours1) {
      this.colours = c.bg;
      this.colours0 = c.obj0;
      this.colours1 = c.obj1;
      host.gbColours?.(resolve.palette(c.bg), resolve.palette(c.obj0), resolve.palette(c.obj1));
    }
  }
}
