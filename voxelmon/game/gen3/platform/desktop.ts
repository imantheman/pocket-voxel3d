// pocket-voxel platform for the gen3 (FireRed) port (GPLv3 + additional terms;
// see LICENSE.md). The desktop host (tests, screenshots): textures in memory,
// frames drawn by the software rasteriser, cache reads from a cache directory
// (an importer's output tree: the folder holding data/generated/gba, or the
// 3DS card's firered/ folder, read as the console's host reads it: its
// data.pvpk (import/gen3/card_pack.ts) and deflated files (cooked_data.ts
// ZIP_TAG)).

import { closeSync, existsSync, openSync, readFileSync, readSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { ZIP_TAG } from "../../../import/gen3/cooked_data.ts";
import { PACK_NAME, packHeadLen, readPackIndex, type PackIndex } from "../../../import/gen3/card_pack.ts";
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
  batchUpload(id: number, tex: number, quads: Float32Array, count: number): void {
    this.raster.batches.set(id, { tex, q: quads.slice(0, count * 12), n: count });
  }
  batchFree(id: number): void { this.raster.batches.delete(id); }
  draw(list: Float32Array): void {
    this.lastList = Array.from(list);
    this.raster.run(list);
    this.frames++;
  }
  private pack: { fd: number; index: PackIndex } | null | undefined;
  /** The card pack, if the root holds one. */
  private packIndex(): { fd: number; index: PackIndex } | null {
    if (this.pack !== undefined) return this.pack;
    const p = join(this.cacheRoot, PACK_NAME);
    if (!existsSync(p)) return (this.pack = null);
    const fd = openSync(p, "r");
    const h16 = Buffer.alloc(16);
    readSync(fd, h16, 0, 16, 0);
    const head = Buffer.alloc(packHeadLen(h16));
    readSync(fd, head, 0, head.length, 0);
    return (this.pack = { fd, index: readPackIndex(head) });
  }
  /** Close the pack (tests that make many hosts). */
  close(): void {
    if (this.pack) closeSync(this.pack.fd);
    this.pack = undefined;
  }
  private file(path: string): Buffer | undefined {
    const pk = this.packIndex();
    let b: Buffer;
    if (pk) {
      const e = pk.index.files.get(path);
      if (!e) return undefined;
      b = Buffer.alloc(e[1]);
      readSync(pk.fd, b, 0, e[1], e[0]);
    } else {
      const p = join(this.cacheRoot, path);
      if (!existsSync(p)) return undefined;
      b = readFileSync(p);
    }
    if (b.length >= 9 && b.toString("latin1", 0, 5) === ZIP_TAG) return inflateRawSync(b.subarray(9));
    return b;
  }
  private readBytes(path: string): Uint8Array | undefined {
    const b = this.file(path);
    return b ? new Uint8Array(b) : undefined;
  }
  read(path: string): string | undefined {
    return this.file(path)?.toString("latin1");
  }
  exists(path: string): boolean {
    const pk = this.packIndex();
    if (pk) { const p = path.replace(/\/$/, ""); return pk.index.files.has(p) || pk.index.dirs.has(p); }
    return existsSync(join(this.cacheRoot, path));
  }
  now(): number { return this.realTime ? (performance.now() - this.t0) / 1000 : this.frames / 60; }

  /** The last frame's pixels (RGBA8, 240x160). */
  pixels(): Uint8Array { return this.raster.frame.px; }
}
