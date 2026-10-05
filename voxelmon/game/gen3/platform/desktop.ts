// pocket-voxel platform for the gen3 (FireRed) port (GPLv3 + additional terms;
// see LICENSE.md). The desktop host (tests, screenshots): textures in memory,
// frames drawn by the software rasteriser, cache reads from a cache directory
// (an importer's output tree: the folder holding data/generated/gba).

import { existsSync, readFileSync } from "node:fs";
import type { G3Host } from "./host.ts";
import { Rasterizer } from "./rasterize.ts";
import { decodePngBytes } from "./pngdecode.ts";

/** A cache path on disk: the path is a byte string (fsio.ts diskPath). */
function join(root: string, rel: string): Buffer {
  return Buffer.concat([Buffer.from(root, "utf8"), Buffer.from("/" + rel, "latin1")]);
}

export class DesktopHost implements G3Host {
  readonly raster = new Rasterizer(240, 160);
  frames = 0;
  lastList: number[] = [];
  private t0 = performance.now();
  /** Time is the frame count / 60 unless `realTime`. */
  realTime = false;

  constructor(readonly cacheRoot: string) {}

  texUpload(id: number, w: number, h: number, rgba: Uint8Array, repeat: boolean): void {
    this.raster.tex.set(id, { w, h, px: rgba.slice(0, w * h * 4), repeat });
  }
  texFromCache(id: number, path: string): [number, number] | undefined {
    const bytes = this.readBytes(path);
    if (!bytes || !path.endsWith(".png")) return undefined;
    const png = decodePngBytes(bytes);
    this.raster.tex.set(id, { w: png.w, h: png.h, px: png.rgba, repeat: false });
    return [png.w, png.h];
  }
  canvasNew(id: number, w: number, h: number): void {
    this.raster.tex.set(id, { w, h, px: new Uint8Array(w * h * 4), repeat: false });
  }
  texFree(id: number): void { this.raster.tex.delete(id); }
  draw(list: number[]): void {
    this.lastList = list.slice();
    this.raster.run(list);
    this.frames++;
  }
  private readBytes(path: string): Uint8Array | undefined {
    const p = join(this.cacheRoot, path);
    return existsSync(p) ? new Uint8Array(readFileSync(p)) : undefined;
  }
  read(path: string): string | undefined {
    const p = join(this.cacheRoot, path);
    return existsSync(p) ? readFileSync(p).toString("latin1") : undefined;
  }
  exists(path: string): boolean { return existsSync(join(this.cacheRoot, path)); }
  now(): number { return this.realTime ? (performance.now() - this.t0) / 1000 : this.frames / 60; }

  /** The last frame's pixels (RGBA8, 240x160). */
  pixels(): Uint8Array { return this.raster.frame.px; }
}
