// Port of gen1recomp src/import/gba/rse/boot_gfx.lua (GPLv3 + additional terms; see LICENSE.md).
// Shared kit for the RSE-style extractors: indexed PNG encoding, BG / sprite
// baking into palette-index buffers, and a per-extractor context (symbol
// offsets, LZ77 cache, palettes, file list, manifest).
// Index buffers (the Lua's 1-based tables) are 0-based number[] here;
// palettes keep the Lua's 0-based keys; decompressed data is a byte string,
// as the Lua's lzAt returns.
// NOT FAITHFUL: K.context needs src.import.gba.syms (the Emerald symbol
// tables, out of scope) and throws; FRLG callers use contextWith.

import { Lz77 } from "../lz77.ts";
import { LuaWriter } from "../lua_writer.ts";
import { format, fromBytes, tonumber, tostring } from "../lua.ts";
import type { Cache } from "../cache.ts";
import type { Rom } from "../rom.ts";

export type Idx = number[];
export type Pal = Record<number, number>;
export interface Syms {
  off(name: string): number;
  size(name: string): number;
  namesAt?(off: number): string[];
  obj?(name: string): string | undefined;
  funcAt?(addr: number): any;
}
export interface AnimCmd { op: string; target?: number; count?: number; tile?: number; duration?: number; hFlip?: boolean; vFlip?: boolean; frame?: number }
export interface Oam { shape: number; size: number; w: number; h: number; bpp: number; affineMode: number; objMode: number; priority: number; paletteNum: number }
export interface SpriteTemplate { tileTag: number; paletteTag: number; oam?: Oam; anims: AnimCmd[][]; images?: number; callback: any }
export interface PalVariants { variants: { name: string; pal: Pal }[] }

// pokeemerald/include/gba/types.h:102
// Lua: boot_gfx.lua:12
const OBJ_DIMS: Record<number, [number, number][]> = {
  0: [[8, 8], [16, 16], [32, 32], [64, 64]],
  1: [[16, 8], [32, 8], [32, 16], [64, 32]],
  2: [[8, 16], [8, 32], [16, 32], [32, 64]],
};

// Lua: boot_gfx.lua:25
const CRC: number[] = [];
for (let i = 0; i <= 255; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) c = (c & 1) === 1 ? ((c >>> 1) ^ 0xedb88320) >>> 0 : c >>> 1;
  CRC[i] = c >>> 0;
}

// Lua: boot_gfx.lua:34
function crc32(s: string): number {
  let c = 0xffffffff;
  for (let i = 0; i < s.length; i++) c = (CRC[(c ^ s.charCodeAt(i)) & 0xff]! ^ (c >>> 8)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
}

// Lua: boot_gfx.lua:44
function be32(nIn: number): string {
  const n = nIn % 4294967296;
  return String.fromCharCode(Math.floor(n / 16777216) % 256, Math.floor(n / 65536) % 256, Math.floor(n / 256) % 256, n % 256);
}

// Lua: boot_gfx.lua:50
function chunk(kind: string, data: string): string {
  return be32(data.length) + kind + data + be32(crc32(kind + data));
}

// Lua: boot_gfx.lua:54
function adler32(s: string): number {
  let a = 1, b = 0;
  for (let i = 0; i < s.length; i++) {
    a = (a + s.charCodeAt(i)) % 65521;
    b = (b + a) % 65521;
  }
  return b * 65536 + a;
}

// Lua: boot_gfx.lua:63
function zlibStored(raw: string): string {
  const parts = ["\x78\x01"];
  const n = raw.length;
  let pos = 1;
  do {
    const len = Math.min(65535, n - pos + 1);
    const final = pos + len > n ? 1 : 0;
    parts.push(String.fromCharCode(final, len % 256, Math.floor(len / 256), (65535 - len) % 256, Math.floor((65535 - len) / 256)));
    parts.push(raw.slice(pos - 1, pos - 1 + len));
    pos += len;
  } while (!(pos > n));
  parts.push(be32(adler32(raw)));
  return parts.join("");
}

// Lua: boot_gfx.lua:79
// NOT FAITHFUL: love.data.compress has no counterpart here; the stored-deflate
// fallback is used (the PNG decodes to the same pixels; the luajit reference
// run took this path too).
function zlib(raw: string): string {
  return zlibStored(raw);
}

// Lua: boot_gfx.lua:89
function scanlines(w: number, h: number, idx: Idx): string {
  const rows: string[] = [];
  for (let y = 0; y <= h - 1; y++) {
    const base = y * w;
    const bytes = new Uint8Array(w + 1);
    for (let x = 0; x < w; x++) bytes[x + 1] = idx[base + x]!;
    rows.push(fromBytes(bytes));
  }
  return rows.join("");
}

// Lua: boot_gfx.lua:171 -- 4bpp nibble of a tile; gfx a byte string
function nib(gfx: string, tile: number, x: number, y: number): number {
  const k = tile * 32 + y * 4 + Math.floor(x / 2);
  if (k >= gfx.length) return 0;
  const b = gfx.charCodeAt(k);
  if (x % 2 === 0) return b % 16;
  return Math.floor(b / 16);
}

// Lua: boot_gfx.lua:178
function byte8(gfx: string, tile: number, x: number, y: number): number {
  const k = tile * 64 + y * 8 + x;
  return k < gfx.length ? gfx.charCodeAt(k) : 0;
}

// Lua: boot_gfx.lua:188
function mapEntry(map: string, i: number): number {
  if (i * 2 >= map.length) return 0;
  const lo = map.charCodeAt(i * 2);
  const hi = i * 2 + 1 < map.length ? map.charCodeAt(i * 2 + 1) : 0;
  return lo + hi * 256;
}

// Lua: boot_gfx.lua:326
function isRom(rom: unknown): boolean {
  return typeof rom === "object" && rom !== null && typeof (rom as Rom).readString === "function";
}

export class Ctx {
  rom: Rom;
  cache: Cache;
  opts: Record<string, any>;
  game: string;
  S: Syms;
  sub: string;
  root: string;
  files: string[] = [];
  lzCache: Record<number, string> = {};

  constructor(rom: Rom, cache: Cache, opts: Record<string, any>, sub: string, S: Syms, game: string, root: string) {
    this.rom = rom; this.cache = cache; this.opts = opts; this.sub = sub; this.S = S; this.game = game; this.root = root;
  }

  // Lua: boot_gfx.lua:357
  off(name: string): number { return this.S.off(name); }

  // Lua: boot_gfx.lua:359
  raw(name: string, len?: number): string {
    return this.rom.readString(this.S.off(name), len ?? this.S.size(name));
  }

  // Lua: boot_gfx.lua:363
  lzAt(off: number): string {
    const hit = this.lzCache[off];
    if (hit !== undefined) return hit;
    const rom = this.rom;
    if (rom.get(off) !== 0x10) throw new Error(format("boot_gfx: no LZ77 header at 0x%X", off));
    const [out] = Lz77.decompress((i) => rom.get(i), off);
    const s = fromBytes(out);
    this.lzCache[off] = s;
    return s;
  }

  // Lua: boot_gfx.lua:384
  lz(name: string): string { return this.lzAt(this.S.off(name)); }

  // Lua: boot_gfx.lua:388
  u8(off: number): number { return this.rom.get(off); }
  u16(off: number): number { return this.rom.u16(off); }
  s16(off: number): number {
    let v = this.rom.u16(off);
    if (v >= 0x8000) v -= 0x10000;
    return v;
  }
  s8(off: number): number {
    let v = this.rom.get(off);
    if (v >= 0x80) v -= 0x100;
    return v;
  }
  u32(off: number): number { return this.rom.u32(off); }

  // Lua: boot_gfx.lua:402
  ptr(off: number): number | undefined {
    const p = this.rom.u32(off);
    if (p < 0x08000000 || p >= 0x0a000000) return undefined;
    return p - 0x08000000;
  }

  // Lua: boot_gfx.lua:408
  palFrom(bytes: string, count?: number, into?: Pal, base?: number): Pal {
    into = into ?? {};
    base = base ?? 0;
    count = count ?? Math.floor(bytes.length / 2);
    for (let i = 0; i <= count - 1; i++) {
      const lo = i * 2 < bytes.length ? bytes.charCodeAt(i * 2) : 0;
      const hi = i * 2 + 1 < bytes.length ? bytes.charCodeAt(i * 2 + 1) : 0;
      into[base + i] = lo + hi * 256;
    }
    return into;
  }

  // Lua: boot_gfx.lua:419
  pal(name: string, count?: number, into?: Pal, base?: number, lz?: boolean): Pal {
    return this.palFrom(lz ? this.lz(name) : this.raw(name), count, into, base);
  }

  // Lua: boot_gfx.lua:423
  palAt(off: number, count: number, into?: Pal, base?: number): Pal {
    return this.palFrom(this.rom.readString(off, count * 2), count, into, base);
  }

  // Lua: boot_gfx.lua:433 -- [size, key] or undefined
  sizedAt(off: number, obj?: string): [number, string] | undefined {
    const names = this.S.namesAt ? this.S.namesAt(off) : [];
    for (const n of names) {
      for (const key of obj ? [n, obj + ":" + n] : [n]) {
        let size: number | undefined;
        try { size = this.S.size(key); } catch { size = undefined; }
        if (size !== undefined && size > 0 && this.S.off(key) === off) return [size, key];
      }
    }
    return undefined;
  }

  // Lua: boot_gfx.lua:445 (pokeemerald/include/sprite.h:48)
  readAnim(off: number): AnimCmd[] {
    const cmds: AnimCmd[] = [];
    for (let i = 0; i <= 63; i++) {
      const lo = this.u16(off + i * 4);
      const hi = this.u16(off + i * 4 + 2);
      if (lo === 0xffff) {
        cmds.push({ op: "end" });
        break;
      } else if (lo === 0xfffe) {
        cmds.push({ op: "jump", target: hi % 64 });
        break;
      } else if (lo === 0xfffd) {
        cmds.push({ op: "loop", count: hi % 64 });
      } else {
        const cmd: AnimCmd = { op: "frame", tile: lo, duration: hi % 64 };
        if (Math.floor(hi / 64) % 2 === 1) cmd.hFlip = true;
        if (Math.floor(hi / 128) % 2 === 1) cmd.vFlip = true;
        cmds.push(cmd);
      }
    }
    return cmds;
  }

  // Lua: boot_gfx.lua:471
  readAnimTable(off: number, count?: number, obj?: string): AnimCmd[][] {
    if (count === undefined) {
      const sized = this.sizedAt(off, obj);
      if (!sized) throw new Error(format("boot_gfx: no sized anim table symbol at 0x%X", off));
      count = Math.floor(sized[0] / 4);
    }
    const anims: AnimCmd[][] = [];
    for (let i = 0; i <= count - 1; i++) {
      const p = this.ptr(off + i * 4);
      if (p !== undefined) anims.push(this.readAnim(p));
    }
    return anims;
  }

  // Lua: boot_gfx.lua:486 (pokeemerald/include/gba/types.h:55)
  readOam(off: number): Oam {
    const a0 = this.u16(off), a1 = this.u16(off + 2), a2 = this.u16(off + 4);
    const shape = Math.floor(a0 / 16384) % 4;
    const size = Math.floor(a1 / 16384) % 4;
    const [w, h] = K.objDims(shape, size);
    return {
      shape, size, w, h,
      bpp: Math.floor(a0 / 8192) % 2 === 1 ? 8 : 4,
      affineMode: Math.floor(a0 / 256) % 4,
      objMode: Math.floor(a0 / 1024) % 4,
      priority: Math.floor(a2 / 1024) % 4,
      paletteNum: Math.floor(a2 / 4096) % 16,
    };
  }

  // Lua: boot_gfx.lua:507 (pokeemerald/include/sprite.h:179)
  readTemplate(name: string): SpriteTemplate {
    const off = this.S.off(name);
    const oamOff = this.ptr(off + 4);
    const animsOff = this.ptr(off + 8);
    const imagesOff = this.ptr(off + 12);
    const oam = oamOff !== undefined ? this.readOam(oamOff) : undefined;
    const m = /^(.*?\.o):/.exec(name);
    const obj = m ? m[1] : this.S.obj ? this.S.obj(name) : undefined;
    return {
      tileTag: this.u16(off),
      paletteTag: this.u16(off + 2),
      oam,
      anims: animsOff !== undefined ? this.readAnimTable(animsOff, undefined, obj) : [],
      images: imagesOff,
      callback: this.S.funcAt ? this.S.funcAt(this.u32(off + 20)) : undefined,
    };
  }

  // Lua: boot_gfx.lua:524
  path(name: string): string { return this.root + "/" + name; }

  // Lua: boot_gfx.lua:528
  write(name: string, bytes: string): string {
    const rel = this.path(name);
    const ok = this.cache.write(rel, bytes);
    if (ok === false) throw new Error("boot_gfx: could not write " + rel + ": nil");
    this.files.push(name);
    return rel;
  }

  // Lua: boot_gfx.lua:536
  png(name: string, w: number, h: number, idx: Idx, pal: Pal, transparent0?: boolean): string {
    return this.write(name, K.encodeIndexed(w, h, idx, pal, transparent0));
  }

  // Lua: boot_gfx.lua:540
  gray(name: string, w: number, h: number, idx: Idx): string {
    return this.write(name, K.encodeGray(w, h, idx));
  }

  // Lua: boot_gfx.lua:544
  mask(name: string, w: number, h: number, idx: Idx, keep: Record<number, boolean>): string {
    return this.write(name, K.encodeMask(w, h, idx, keep));
  }

  // Lua: boot_gfx.lua:548
  layer(spec: { key: string; opaque?: boolean; variants?: { name: string; pal: Pal }[]; indexMap?: boolean },
    idx: Idx, W: number, H: number, pal: Pal): Record<string, any> {
    const entry: Record<string, any> = { w: W, h: H, opaque: spec.opaque ? spec.opaque : undefined, variants: {} };
    let out = idx;
    if (spec.opaque) {
      out = [];
      for (let i = 0; i < W * H; i++) out[i] = idx[i]!;
    }
    const variants = spec.variants ?? [{ name: "", pal }];
    for (const v of variants) {
      const file = spec.key + (v.name !== "" ? "_" + v.name : "") + ".png";
      const p = this.png(file, W, H, out, v.pal, !spec.opaque);
      if (v.name === "") entry.png = p; else entry.variants[v.name] = p;
    }
    if (Object.keys(entry.variants).length === 0) entry.variants = undefined;
    if (spec.indexMap) entry.index = this.gray(spec.key + "_idx.png", W, H, idx);
    return entry;
  }

  // Lua: boot_gfx.lua:566
  spriteFrames(key: string, gfx: string, tpl: SpriteTemplate, pal: Pal | PalVariants, extra?: number[]): Record<string, any> {
    const oam = tpl.oam!;
    const w = oam.w, h = oam.h, bpp = oam.bpp;
    const offsets: number[] = [], seen: Record<number, boolean> = {};
    const add = (t: number): void => {
      if (!seen[t]) { seen[t] = true; offsets.push(t); }
    };
    for (const anim of tpl.anims) for (const c of anim) if (c.op === "frame") add(c.tile!);
    for (const t of extra ?? []) add(t);
    if (offsets.length === 0) add(0);
    offsets.sort((a, b) => a - b);
    const frames: Idx[] = [], frameOf: Record<number, number> = {};
    offsets.forEach((t, i) => {
      frames[i] = K.bakeSprite(gfx, w, h, t, bpp);
      frameOf[t] = i;
    });
    const [sheet, SW, SH] = K.stack(frames, w, h);
    const anims: Record<string, any>[][] = [];
    tpl.anims.forEach((anim, ai) => {
      const list: Record<string, any>[] = [];
      anim.forEach((c, ci) => {
        const row: Record<string, any> = { ...c };
        if (c.op === "frame") row.frame = frameOf[c.tile!];
        list[ci] = row;
      });
      anims[ai] = list;
    });
    const entry: Record<string, any> = {
      w, h, bpp, frames: offsets.length, tiles: offsets, anims,
      priority: oam.priority, affineMode: oam.affineMode, objMode: oam.objMode,
      callback: tpl.callback,
    };
    const pals = (pal as PalVariants).variants ?? [{ name: "", pal: pal as Pal }];
    for (const v of pals) {
      const file = key + (v.name !== "" ? "_" + v.name : "") + ".png";
      const p = this.png(file, SW, SH, sheet, v.pal, true);
      if (v.name === "") entry.png = p; else { entry.variants = entry.variants ?? {}; entry.variants[v.name] = p; }
    }
    return entry;
  }

  // Lua: boot_gfx.lua:612
  strip(key: string, gfx: string, w: number, h: number, count: number, pal: Pal | PalVariants, bpp?: number, tileBase?: number): Record<string, any> {
    const per = (w / 8) * (h / 8) * (bpp === 8 ? 2 : 1);
    const frames: Idx[] = [];
    for (let i = 0; i <= count - 1; i++) frames[i] = K.bakeSprite(gfx, w, h, (tileBase ?? 0) + i * per, bpp);
    const [sheet, SW, SH] = K.stack(frames, w, h);
    const entry: Record<string, any> = { w, h, bpp: bpp ?? 4, frames: count, tilesPerFrame: per };
    const pals = (pal as PalVariants).variants ?? [{ name: "", pal: pal as Pal }];
    for (const v of pals) {
      const file = key + (v.name !== "" ? "_" + v.name : "") + ".png";
      const p = this.png(file, SW, SH, sheet, v.pal, true);
      if (v.name === "") entry.png = p; else { entry.variants = entry.variants ?? {}; entry.variants[v.name] = p; }
    }
    return entry;
  }

  // Lua: boot_gfx.lua:629
  atlas(key: string, gfx: string, list: { w: number; h: number; tile: number; bpp?: number }[], pal: Pal | PalVariants): Record<string, any> {
    let W = 0, H = 0;
    for (const fr of list) {
      if (fr.w > W) W = fr.w;
      H += fr.h;
    }
    const out = K.blank(W, H);
    const rects: Record<string, number>[] = [];
    let y = 0;
    list.forEach((fr, i) => {
      const px = K.bakeSprite(gfx, fr.w, fr.h, fr.tile, fr.bpp ?? 4);
      for (let yy = 0; yy <= fr.h - 1; yy++) {
        for (let xx = 0; xx <= fr.w - 1; xx++) out[(y + yy) * W + xx] = px[yy * fr.w + xx]!;
      }
      rects[i] = { x: 0, y, w: fr.w, h: fr.h, tile: fr.tile };
      y += fr.h;
    });
    const entry: Record<string, any> = { w: W, h: H, rects };
    const pals = (pal as PalVariants).variants ?? [{ name: "", pal: pal as Pal }];
    for (const v of pals) {
      const file = key + (v.name !== "" ? "_" + v.name : "") + ".png";
      const p = this.png(file, W, H, out, v.pal, true);
      if (v.name === "") entry.png = p; else { entry.variants = entry.variants ?? {}; entry.variants[v.name] = p; }
    }
    return entry;
  }

  // Lua: boot_gfx.lua:657
  finish(manifest: Record<string, any>): Record<string, any> {
    manifest.format = K.FORMAT;
    manifest.game = this.game;
    manifest.files = this.files.map((f) => this.path(f));
    this.write("manifest.lua", LuaWriter.encode(manifest));
    return manifest;
  }
}

export const K = {
  FORMAT: 1,
  OBJ_DIMS,
  zlibStored,
  Ctx,

  // Lua: boot_gfx.lua:18 -- [w, h]
  objDims(shape: number, size: number): [number, number] {
    const row = OBJ_DIMS[shape];
    const d = row ? row[size] : undefined;
    if (!d) throw new Error(format("boot_gfx: bad OBJ shape/size %s/%s", tostring(shape), tostring(size)));
    return [d[0], d[1]];
  },

  // Lua: boot_gfx.lua:106
  rgb8(cIn: unknown): [number, number, number] {
    const c = (tonumber(cIn) ?? 0) % 32768;
    const r5 = c % 32, g5 = Math.floor(c / 32) % 32, b5 = Math.floor(c / 1024) % 32;
    return [Math.floor((r5 * 255) / 31 + 0.5), Math.floor((g5 * 255) / 31 + 0.5), Math.floor((b5 * 255) / 31 + 0.5)];
  },

  // Lua: boot_gfx.lua:114
  encodeIndexed(w: number, h: number, idx: Idx, pal: Pal, transparent0?: boolean): string {
    let count = 1;
    for (let i = 0; i < w * h; i++) {
      const v = idx[i]!;
      if (v + 1 > count) count = v + 1;
    }
    let plte = "";
    for (let i = 0; i <= count - 1; i++) {
      const [r, g, b] = K.rgb8(pal[i] ?? 0);
      plte += String.fromCharCode(r, g, b);
    }
    const out = [
      "\x89PNG\r\n\x1a\n",
      chunk("IHDR", be32(w) + be32(h) + "\x08\x03\x00\x00\x00"),
      chunk("PLTE", plte),
    ];
    if (transparent0) out.push(chunk("tRNS", "\x00"));
    out.push(chunk("IDAT", zlib(scanlines(w, h, idx))));
    out.push(chunk("IEND", ""));
    return out.join("");
  },

  // Lua: boot_gfx.lua:136
  encodeGray(w: number, h: number, idx: Idx): string {
    return [
      "\x89PNG\r\n\x1a\n",
      chunk("IHDR", be32(w) + be32(h) + "\x08\x00\x00\x00\x00"),
      chunk("IDAT", zlib(scanlines(w, h, idx))),
      chunk("IEND", ""),
    ].join("");
  },

  // Lua: boot_gfx.lua:145
  encodeMask(w: number, h: number, idx: Idx, keep: Record<number, boolean>): string {
    const rows: string[] = [];
    for (let y = 0; y <= h - 1; y++) {
      let row = "\x00";
      for (let x = 1; x <= w; x++) row += keep[idx[y * w + x - 1]!] ? "\xff\xff\xff\xff" : "\x00\x00\x00\x00";
      rows.push(row);
    }
    return [
      "\x89PNG\r\n\x1a\n",
      chunk("IHDR", be32(w) + be32(h) + "\x08\x06\x00\x00\x00"),
      chunk("IDAT", zlib(rows.join(""))),
      chunk("IEND", ""),
    ].join("");
  },

  // Lua: boot_gfx.lua:162 -- [w, h] or undefined
  pngSize(bytes: unknown): [number, number] | undefined {
    if (typeof bytes !== "string" || bytes.slice(0, 8) !== "\x89PNG\r\n\x1a\n") return undefined;
    const u32 = (o: number): number => {
      const a = bytes.charCodeAt(o - 1), b = bytes.charCodeAt(o), c = bytes.charCodeAt(o + 1), d = bytes.charCodeAt(o + 2);
      return ((a * 256 + b) * 256 + c) * 256 + d;
    };
    return [u32(17), u32(21)];
  },

  // Lua: boot_gfx.lua:182
  blank(w: number, h: number, v?: number): Idx {
    return new Array<number>(w * h).fill(v ?? 0);
  },

  // Lua: boot_gfx.lua:195 (pokeemerald/include/gba/io_reg.h:540) -- [idx, W, H]; gfx and map byte strings
  bakeText(gfx: string, map: string, wTiles: number, hTiles: number,
    opts: { mapOffset?: number; linear?: boolean; mapWidth?: number } = {}): [Idx, number, number] {
    const W = wTiles * 8, H = hTiles * 8;
    const out = K.blank(W, H);
    const tiles = Math.floor(gfx.length / 32);
    const mapBase = opts.mapOffset ?? 0;
    const sbW = Math.max(1, Math.floor(wTiles / 32));
    const linear = opts.linear;
    for (let ty = 0; ty <= hTiles - 1; ty++) {
      for (let tx = 0; tx <= wTiles - 1; tx++) {
        let i: number;
        if (linear) i = ty * (opts.mapWidth ?? wTiles) + tx;
        else {
          const sb = Math.floor(ty / 32) * sbW + Math.floor(tx / 32);
          i = sb * 1024 + (ty % 32) * 32 + (tx % 32);
        }
        const e = mapEntry(map, mapBase + i);
        const tile = e % 1024;
        const hf = Math.floor(e / 1024) % 2 === 1;
        const vf = Math.floor(e / 2048) % 2 === 1;
        const bank = Math.floor(e / 4096);
        if (tile < tiles) {
          for (let py = 0; py <= 7; py++) {
            const sy = vf ? 7 - py : py;
            const row = (ty * 8 + py) * W + tx * 8;
            for (let px = 0; px <= 7; px++) {
              const sx = hf ? 7 - px : px;
              const v = nib(gfx, tile, sx, sy);
              if (v !== 0) out[row + px] = bank * 16 + v;
            }
          }
        }
      }
    }
    return [out, W, H];
  },

  // Lua: boot_gfx.lua:233
  bakeText8(gfx: string, map: string, wTiles: number, hTiles: number): [Idx, number, number] {
    const W = wTiles * 8, H = hTiles * 8;
    const out = K.blank(W, H);
    const tiles = Math.floor(gfx.length / 64);
    const sbW = Math.max(1, Math.floor(wTiles / 32));
    for (let ty = 0; ty <= hTiles - 1; ty++) {
      for (let tx = 0; tx <= wTiles - 1; tx++) {
        const sb = Math.floor(ty / 32) * sbW + Math.floor(tx / 32);
        const e = mapEntry(map, sb * 1024 + (ty % 32) * 32 + (tx % 32));
        const tile = e % 1024;
        const hf = Math.floor(e / 1024) % 2 === 1;
        const vf = Math.floor(e / 2048) % 2 === 1;
        if (tile < tiles) {
          for (let py = 0; py <= 7; py++) {
            const sy = vf ? 7 - py : py;
            const row = (ty * 8 + py) * W + tx * 8;
            for (let px = 0; px <= 7; px++) out[row + px] = byte8(gfx, tile, hf ? 7 - px : px, sy);
          }
        }
      }
    }
    return [out, W, H];
  },

  // Lua: boot_gfx.lua:260 (pokeemerald/include/gba/io_reg.h:544)
  bakeAffine(gfx: string, map: string, sizeTiles: number): [Idx, number, number] {
    const W = sizeTiles * 8;
    const out = K.blank(W, W);
    const tiles = Math.floor(gfx.length / 64);
    for (let ty = 0; ty <= sizeTiles - 1; ty++) {
      for (let tx = 0; tx <= sizeTiles - 1; tx++) {
        const k = ty * sizeTiles + tx;
        const tile = k < map.length ? map.charCodeAt(k) : 0;
        if (tile < tiles) {
          for (let py = 0; py <= 7; py++) {
            const row = (ty * 8 + py) * W + tx * 8;
            for (let px = 0; px <= 7; px++) out[row + px] = byte8(gfx, tile, px, py);
          }
        }
      }
    }
    return [out, W, W];
  },

  // Lua: boot_gfx.lua:280
  bakeSprite(gfx: string, w: number, h: number, tileOffset: number, bpp?: number): Idx {
    const out = K.blank(w, h);
    const tw = w / 8, th = h / 8;
    const unit = bpp === 8 ? 2 : 1;
    for (let ty = 0; ty <= th - 1; ty++) {
      for (let tx = 0; tx <= tw - 1; tx++) {
        const t = tileOffset + (ty * tw + tx) * unit;
        for (let py = 0; py <= 7; py++) {
          const row = (ty * 8 + py) * w + tx * 8;
          for (let px = 0; px <= 7; px++) {
            let v: number;
            if (bpp === 8) {
              const k = t * 32 + py * 8 + px;
              v = k < gfx.length ? gfx.charCodeAt(k) : 0;
            } else v = nib(gfx, t, px, py);
            out[row + px] = v;
          }
        }
      }
    }
    return out;
  },

  // Lua: boot_gfx.lua:304 -- [idx, w, h * #frames]
  stack(frames: Idx[], w: number, h: number): [Idx, number, number] {
    const out: Idx = [];
    for (const f of frames) for (let i = 0; i < w * h; i++) out.push(f[i]!);
    return [out, w, h * frames.length];
  },

  // Lua: boot_gfx.lua:316
  crop(idx: Idx, W: number, x0: number, y0: number, w: number, h: number): Idx {
    const out: Idx = [];
    for (let y = 0; y <= h - 1; y++) {
      for (let x = 0; x <= w - 1; x++) out[y * w + x] = idx[(y0 + y) * W + x0 + x] ?? 0;
    }
    return out;
  },

  // Lua: boot_gfx.lua:333
  context(rom: Rom, cache: Cache, opts: Record<string, any> | undefined, sub: string): Ctx {
    opts = opts ?? {};
    const game: string = opts.game ?? rom.id ?? "emerald";
    if (game === "leafgreen" || game === "firered") throw new Error("boot_gfx: rse extractor run for " + game);
    // NOT FAITHFUL: require("src.import.gba.syms").of(game) -- the Emerald
    // symbol tables are not ported (Emerald is out of scope).
    throw new Error("boot_gfx: src.import.gba.syms is not ported (" + game + ")");
  },

  // Lua: boot_gfx.lua:340
  contextWith(rom: Rom, cache: Cache, opts: Record<string, any> | undefined, sub: string, S: Syms, game: string): Ctx {
    if (!isRom(rom)) throw new Error("boot_gfx: rom needs readString");
    opts = opts ?? {};
    const root = (opts.cacheRoot ?? "data/generated/gba") + "/" + sub;
    return new Ctx(rom, cache, opts, sub, S, game, root);
  },

  // Lua: boot_gfx.lua:427 -- a 1-based palette slice as a 0-based array
  palList(pal: Pal, first: number, count: number): number[] {
    const out: number[] = [];
    for (let i = 0; i <= count - 1; i++) out[i] = pal[first + i] ?? 0;
    return out;
  },

  // Lua: boot_gfx.lua:666
  variants(list: { name: string; pal: Pal }[]): PalVariants {
    return { variants: list };
  },

  // Lua: boot_gfx.lua:670
  ready(sub: string, cache: Cache | undefined, cacheRoot?: string): boolean {
    const rel = (cacheRoot ?? "data/generated/gba") + "/" + sub + "/manifest.lua";
    if (!(cache && cache.read)) return false;
    const body = cache.read(rel);
    if (typeof body !== "string") return false;
    const m = /\n\s*format = (\d+),/.exec(body);
    return tonumber(m ? m[1] : undefined) === K.FORMAT;
  },

  // Lua: boot_gfx.lua:679
  required(sub: string, files: string[]): string[] {
    const out = [sub + "/manifest.lua"];
    for (const f of files) out.push(sub + "/" + f);
    return out;
  },
};

export default K;
