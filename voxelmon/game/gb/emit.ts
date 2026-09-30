// The GB screen's op stream: mirrors a GbVideo (gb/video.ts) into the core
// (gb.rs) with the `gb*` ops, sending only what changed since the last
// frame -- a scrolling minigame rewrites a column of the map every few
// frames, not the map.
import type { VoxelHost } from "../host.ts";
import type { GbVideo } from "./video.ts";

/** How the emitter names things the core addresses by number. */
export interface GbResolve {
  /** The atlas page a tile sheet cooked into, or -1. */
  page(sheet: string): number;
  /** An SGB palette's index (the `palette` op's), or -1. */
  palette(name: string): number;
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
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
  private regs = "";
  private lines = "";
  private oam = "";
  private colours = "";

  /** Emit this frame's GB screen, or take it down when `v` is null. */
  emit(host: VoxelHost, v: GbVideo | null, resolve: GbResolve): void {
    if (!v) {
      if (this.shown) {
        host.gbShow?.(0);
        this.shown = false;
      }
      return;
    }
    if (!this.shown) {
      host.gbReset?.();
      host.gbShow?.(1);
      this.shown = true;
      this.maps.fill(0);
      this.loads = this.regs = this.lines = this.oam = this.colours = "";
    }
    const loads = v.loads.map((l) => `${l.dest},${l.sheet},${l.first},${l.count}`).join("|");
    if (loads !== this.loads) {
      this.loads = loads;
      for (const l of v.loads) host.gbTiles?.(l.dest, resolve.page(l.sheet), l.first, l.count);
    }
    // the map, as runs of changed bytes
    let i = 0;
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
    const regs = [v.lcdc, v.scx, v.scy, v.wx, v.wy, v.bgp, v.obp0, v.obp1].join(",");
    if (regs !== this.regs) {
      this.regs = regs;
      host.gbRegs?.(v.lcdc, v.scx & 255, v.scy & 255, v.wx & 255, v.wy & 255, v.bgp, v.obp0, v.obp1);
    }
    const target = v.lineTarget === "scy" ? 1 : v.lineTarget === "scx" ? 2 : 0;
    const lines = target ? `${target}:${hex(v.lines)}` : "0";
    if (lines !== this.lines) {
      this.lines = lines;
      host.gbLines?.(target, target ? hex(v.lines) : "");
    }
    const oam = hex(v.oam);
    if (oam !== this.oam) {
      this.oam = oam;
      host.gbOam?.(oam);
    }
    const c = v.colours;
    const colours = `${c.bg},${c.obj0},${c.obj1}`;
    if (colours !== this.colours) {
      this.colours = colours;
      host.gbColours?.(resolve.palette(c.bg), resolve.palette(c.obj0), resolve.palette(c.obj1));
    }
  }
}
