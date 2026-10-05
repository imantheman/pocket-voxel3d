// Port of gen1recomp src/import/gba/asset_pack.lua (GPLv3 + additional terms; see LICENSE.md).
// Small shared helpers for the GBA asset extractors: raw/LZ77 byte buffers,
// palette banks, sprite frames and strips, struct readers, and the Lua-literal
// serializer the manifests are written with.
// Byte buffers (the Lua's 1-based tables with `_len`) are 0-based Uint8Arrays
// or number[] here; palette banks are BgBake's (index 0..). RGBA results are
// byte strings, as the Lua returns.
//
// Also here: readLuaLiteral, a restricted reader for the `return { ... }`
// data chunks the importer load()s back from its own cache (manifests,
// region_map/names.lua, scripts/text tables). NOT FAITHFUL: the Lua load()s
// and runs the chunk with an empty environment; this reads only table
// constructors of strings, numbers, booleans and nil (all those chunks hold)
// and throws on anything else, which the callers' pcall turns into nil.

import { Lz77 } from "./lz77.ts";
import { BgBake, type Bytes, type PalBank } from "./bg_bake.ts";
import { format, fromBytes, tostring } from "./lua.ts";
import { luaGet, luaKeys, type LuaKey } from "./luatable.ts";
import type { Cache } from "./cache.ts";
import type { Rom } from "./rom.ts";

export interface FrameSpec { tile: number; hflip?: boolean; vflip?: boolean }
export interface BgOpts { alpha0?: boolean; backdrop?: number; x0?: number; y0?: number }

// Lua: asset_pack.lua:93 (include/gba/io_reg.h:538)
const SCREEN_BLOCKS: Record<number, { w: number; h: number; blocks: [number, number][] }> = {
  0: { w: 32, h: 32, blocks: [[0, 0]] },
  1: { w: 64, h: 32, blocks: [[0, 0], [32, 0]] },
  2: { w: 32, h: 64, blocks: [[0, 0], [0, 32]] },
  3: { w: 64, h: 64, blocks: [[0, 0], [32, 0], [0, 32], [32, 32]] },
};

type Reader = [number, (rom: Rom, off: number) => number];
// Lua: asset_pack.lua:138
const READERS: Record<string, Reader> = {
  u8: [1, (rom, off) => rom.get(off)],
  s8: [1, (rom, off) => { const v = rom.get(off); return v >= 128 ? v - 256 : v; }],
  u16: [2, (rom, off) => rom.u16(off)],
  s16: [2, (rom, off) => { const v = rom.u16(off); return v >= 32768 ? v - 65536 : v; }],
  u32: [4, (rom, off) => rom.u32(off)],
  s32: [4, (rom, off) => { const v = rom.u32(off); return v >= 2147483648 ? v - 4294967296 : v; }],
};

// Lua: asset_pack.lua:221
function isIdent(k: LuaKey): boolean {
  return typeof k === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(k);
}

// Lua: asset_pack.lua:225
function isArray(t: object): boolean {
  const count = luaKeys(t).length;
  for (let i = 1; i <= count; i++) {
    const v = luaGet(t, i);
    if (v === undefined || v === null) return false;
  }
  return true;
}

/** ipairs(t): values for keys 1, 2, ... up to the first nil. */
function ipairsValues(t: object): unknown[] {
  const out: unknown[] = [];
  for (let i = 1; ; i++) {
    const v = luaGet(t, i);
    if (v === undefined || v === null) break;
    out.push(v);
  }
  return out;
}

// Lua: asset_pack.lua:234
function serialize(v: unknown, indent: number): string {
  if (typeof v === "number") {
    if (v % 1 === 0) return format("%d", v);
    return format("%.17g", v);
  } else if (typeof v === "string") {
    return format("%q", v);
  } else if (typeof v === "boolean") {
    return tostring(v);
  } else if (v === null || typeof v !== "object") {
    throw new Error("asset_pack: cannot serialize " + (v === undefined || v === null ? "nil" : typeof v));
  }
  const pad = "  ".repeat(indent + 1);
  const close = "  ".repeat(indent);
  if (isArray(v)) {
    const items = ipairsValues(v);
    let flat = true;
    for (const x of items) if (typeof x === "object" && x !== null) { flat = false; break; }
    const parts = items.map((x) => serialize(x, indent + 1));
    if (flat) return "{ " + parts.join(", ") + " }";
    return "{\n" + pad + parts.join(",\n" + pad) + ",\n" + close + "}";
  }
  const keys = luaKeys(v).slice().sort((a, b) => {
    if (typeof a === typeof b) return a < b ? -1 : a > b ? 1 : 0;
    return typeof a === "number" ? -1 : 1;
  });
  const parts: string[] = [];
  for (const k of keys) {
    const key = isIdent(k) ? (k as string) : "[" + serialize(k, 0) + "]";
    parts.push(key + " = " + serialize(luaGet(v, k), indent + 1));
  }
  return "{\n" + pad + parts.join(",\n" + pad) + ",\n" + close + "}";
}

// ------------------------------------------------------------ Lua-literal reader

const NIL = Symbol("nil");

class LiteralReader {
  private at = 0;
  constructor(private readonly src: string) {}

  fail(why: string): never {
    throw new Error(`lua literal: ${why} at byte ${this.at}`);
  }

  skip(): void {
    const s = this.src;
    for (;;) {
      let c = s.charCodeAt(this.at);
      while (c === 32 || (c >= 9 && c <= 13)) c = s.charCodeAt(++this.at);
      if (c === 45 && s.charCodeAt(this.at + 1) === 45) {
        this.at += 2;
        const long = /^\[(=*)\[/.exec(s.slice(this.at, this.at + 64));
        if (long) {
          const end = s.indexOf("]" + long[1] + "]", this.at);
          this.at = end < 0 ? s.length : end + long[1]!.length + 2;
        } else {
          const end = s.indexOf("\n", this.at);
          this.at = end < 0 ? s.length : end + 1;
        }
        continue;
      }
      return;
    }
  }

  peek(): string {
    this.skip();
    return this.src[this.at] ?? "";
  }

  eat(ch: string): boolean {
    if (this.peek() === ch) { this.at++; return true; }
    return false;
  }

  word(): string | undefined {
    this.skip();
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.src.slice(this.at, this.at + 256));
    return m ? m[0] : undefined;
  }

  chunk(): unknown {
    if (this.word() !== "return") this.fail("expected 'return'");
    this.at += 6;
    const v = this.value();
    this.eat(";");
    this.skip();
    if (this.at < this.src.length) this.fail("trailing input");
    return v === NIL ? undefined : v;
  }

  value(): unknown {
    const c = this.peek();
    if (c === "{") return this.table();
    if (c === '"' || c === "'") return this.string();
    if (c === "[" && /^\[=*\[/.test(this.src.slice(this.at, this.at + 64))) return this.longString();
    if (c === "-" || c === "." || (c >= "0" && c <= "9")) return this.number();
    const w = this.word();
    if (w === "true") { this.at += 4; return true; }
    if (w === "false") { this.at += 5; return false; }
    if (w === "nil") { this.at += 3; return NIL; }
    return this.fail(`unsupported expression '${c}'`);
  }

  number(): number {
    let neg = false;
    while (this.eat("-")) neg = !neg;
    this.skip();
    const rest = this.src.slice(this.at, this.at + 64);
    let m = /^0[xX][0-9a-fA-F]+/.exec(rest);
    let n: number;
    if (m) n = parseInt(m[0].slice(2), 16);
    else {
      m = /^(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/.exec(rest);
      if (!m) this.fail("bad number");
      n = Number(m[0]);
    }
    this.at += m[0].length;
    return neg ? -n : n;
  }

  string(): string {
    const s = this.src;
    const q = s[this.at++]!;
    let out = "";
    for (;;) {
      const c = s[this.at++];
      if (c === undefined) this.fail("unfinished string");
      if (c === q) return out;
      if (c === "\n") this.fail("newline in string");
      if (c !== "\\") { out += c; continue; }
      const e = s[this.at++]!;
      switch (e) {
        case "a": out += "\x07"; break;
        case "b": out += "\b"; break;
        case "f": out += "\f"; break;
        case "n": out += "\n"; break;
        case "r": out += "\r"; break;
        case "t": out += "\t"; break;
        case "v": out += "\v"; break;
        case "\\": out += "\\"; break;
        case '"': out += '"'; break;
        case "'": out += "'"; break;
        case "\n": out += "\n"; if (s[this.at] === "\r") this.at++; break;
        case "\r": out += "\n"; if (s[this.at] === "\n") this.at++; break;
        case "x": {
          const h = /^[0-9a-fA-F]{2}/.exec(s.slice(this.at, this.at + 2));
          if (!h) this.fail("bad \\x escape");
          out += String.fromCharCode(parseInt(h[0], 16));
          this.at += 2;
          break;
        }
        case "z": while (/\s/.test(s[this.at] ?? "")) this.at++; break;
        default: {
          if (e >= "0" && e <= "9") {
            const d = /^\d{1,3}/.exec(s.slice(this.at - 1, this.at + 2))![0];
            const code = Number(d);
            if (code > 255) this.fail("escape too large");
            out += String.fromCharCode(code);
            this.at += d.length - 1;
          } else this.fail("bad escape");
        }
      }
    }
  }

  longString(): string {
    const m = /^\[(=*)\[/.exec(this.src.slice(this.at, this.at + 64))!;
    this.at += m[0].length;
    if (this.src[this.at] === "\r") this.at++;
    if (this.src[this.at] === "\n") this.at++;
    const close = "]" + m[1] + "]";
    const end = this.src.indexOf(close, this.at);
    if (end < 0) this.fail("unfinished long string");
    const out = this.src.slice(this.at, end);
    this.at = end + close.length;
    return out;
  }

  table(): unknown {
    this.at++; // {
    const hash: Record<string, unknown> = {};
    let next = 1;
    for (;;) {
      if (this.eat("}")) break;
      let key: LuaKey | undefined;
      if (this.peek() === "[" && !/^\[=*\[/.test(this.src.slice(this.at, this.at + 64))) {
        this.at++;
        const k = this.value();
        if (!this.eat("]")) this.fail("expected ]");
        if (!this.eat("=")) this.fail("expected =");
        if (typeof k !== "number" && typeof k !== "string") this.fail("unsupported key");
        key = k;
      } else {
        const w = this.word();
        if (w !== undefined && w !== "true" && w !== "false" && w !== "nil") {
          const save = this.at;
          this.at += w.length;
          if (this.eat("=")) key = w;
          else this.at = save;
        }
      }
      const v = this.value();
      if (key === undefined) key = next++;
      if (v !== NIL) hash[String(key)] = v;
      else delete hash[String(key)];
      if (!this.eat(",") && !this.eat(";")) {
        if (!this.eat("}")) this.fail("expected , or }");
        break;
      }
    }
    // A table whose keys are exactly 1..n is a sequence: a 0-based array.
    const keys = Object.keys(hash);
    let seq = true;
    for (let i = 0; i < keys.length; i++) {
      if (hash[String(i + 1)] === undefined) { seq = false; break; }
    }
    if (seq) {
      const arr: unknown[] = [];
      for (let i = 0; i < keys.length; i++) arr.push(hash[String(i + 1)]);
      return arr;
    }
    return hash;
  }
}

/**
 * load(src, name, "t", {}) + pcall for a pure-data `return { ... }` chunk:
 * tables keyed exactly 1..n become 0-based arrays, others objects (integer
 * keys as object keys). Throws where the Lua chunk would not be pure data.
 */
export function readLuaLiteral(src: string): unknown {
  return new LiteralReader(src).chunk();
}

export const AssetPack = {
  // Lua: asset_pack.lua:6
  defaultRoot(): string {
    return "data/generated/gba";
  },

  // Lua: asset_pack.lua:14
  raw(rom: Rom, off: number, n: number): Uint8Array {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = rom.get(off + i);
    return out;
  },

  // Lua: asset_pack.lua:21
  lz(rom: Rom, off: number): Uint8Array {
    const [out] = Lz77.decompress((i) => rom.get(i), off);
    return out;
  },

  // Lua: asset_pack.lua:26
  len(buf: unknown): number {
    return BgBake.byteLen(buf);
  },

  // Lua: asset_pack.lua:30
  pad(buf: Bytes, n: number): Uint8Array {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = buf[i] ?? 0;
    return out;
  },

  // Lua: asset_pack.lua:37
  bytes(buf: Bytes): string {
    return buf instanceof Uint8Array ? Lz77.toString(buf) : fromBytes(Uint8Array.from(buf));
  },

  // Lua: asset_pack.lua:41
  banks(rom: Rom, off: number, count: number): PalBank[] {
    return BgBake.loadPalBanks(AssetPack.raw(rom, off, count * 32), count);
  },

  // Lua: asset_pack.lua:45
  placeBanks(slots: Record<number, PalBank>): PalBank[] {
    const banks: PalBank[] = [];
    for (const k of Object.keys(slots)) banks[Number(k)] = slots[Number(k)]!;
    return banks;
  },

  // Lua: asset_pack.lua:51
  palRgb(banks: Record<number, PalBank | undefined>, first: number, count: number): string {
    let out = "";
    for (let b = first; b <= first + count - 1; b++) {
      const bank = banks[b] ?? [];
      for (let c = 0; c <= 15; c++) {
        const [r, g, bl] = BgBake.bgr555ToRgb8(bank[c] ?? 0);
        out += String.fromCharCode(r, g, bl);
      }
    }
    return out;
  },

  // Lua: asset_pack.lua:63
  frame(gfx: Bytes, bank: PalBank | undefined, tile: number, fw: number, fh: number, hflip?: boolean, vflip?: boolean): string {
    return BgBake.bakeSpriteRgba(gfx, bank, tile, fw, fh, !!hflip, !!vflip);
  },

  // Lua: asset_pack.lua:67
  frames(gfx: Bytes, bank: PalBank | undefined, list: FrameSpec[], fw: number, fh: number): string {
    let out = "";
    for (const f of list) out += AssetPack.frame(gfx, bank, f.tile, fw, fh, f.hflip, f.vflip);
    return out;
  },

  // Lua: asset_pack.lua:75
  strip(gfx: Bytes, bank: PalBank | undefined, first: number, step: number, fw: number, fh: number, count: number): string {
    const list: FrameSpec[] = [];
    for (let i = 0; i <= count - 1; i++) list.push({ tile: first + i * step });
    return AssetPack.frames(gfx, bank, list, fw, fh);
  },

  // Lua: asset_pack.lua:81 -- [rgba, w, h]
  tileSheet(gfx: Bytes, bank: PalBank, count: number, cols: number): [string, number, number] {
    const rows = Math.ceil(count / cols);
    const map: number[] = new Array(cols * rows * 2).fill(0);
    for (let i = 0; i <= cols * rows - 1; i++) {
      const entry = i < count ? i : 0x3ff;
      map[i * 2] = entry % 256;
      map[i * 2 + 1] = Math.floor(entry / 256);
    }
    return [BgBake.bakeRegionRgba(gfx, [bank], map, cols * 8, rows * 8, { mapW: cols, alpha0: true }), cols * 8, rows * 8];
  },

  // Lua: asset_pack.lua:101 -- [out, w, h, filled]; out and filled 0-based
  linearize(map: Bytes, screenSize?: number): [number[], number, number, Record<number, boolean>] {
    const layout = SCREEN_BLOCKS[screenSize ?? 0]!;
    const n = AssetPack.len(map);
    // The Lua's table has `_len` set and holes where no block lands (read as 0).
    const out: number[] = new Array(layout.w * layout.h * 2).fill(0);
    const filled: Record<number, boolean> = {};
    for (let i = 0; i <= Math.floor(n / 2) - 1; i++) {
      const block = Math.floor(i / 1024);
      const origin = layout.blocks[block];
      if (origin) {
        const within = i % 1024;
        const x = origin[0] + (within % 32);
        const y = origin[1] + Math.floor(within / 32);
        const di = (y * layout.w + x) * 2;
        out[di] = map[i * 2] ?? 0;
        out[di + 1] = map[i * 2 + 1] ?? 0;
        filled[y * layout.w + x] = true;
      }
    }
    return [out, layout.w, layout.h, filled];
  },

  // Lua: asset_pack.lua:122
  bg(gfx: Bytes, banks: PalBank[], map: Bytes, mapW: number, w: number, h: number, opts: BgOpts = {}): string {
    let rgba = BgBake.bakeRegionRgba(gfx, banks, map, w, h, {
      mapW, alpha0: opts.alpha0 || opts.backdrop !== undefined, x0: opts.x0, y0: opts.y0,
    });
    if (opts.backdrop !== undefined) {
      const [r, g, b] = BgBake.bgr555ToRgb8(opts.backdrop);
      const solid = String.fromCharCode(r, g, b, 255);
      rgba = rgba.replace(/[\s\S]{4}/g, (px) => (px.charCodeAt(3) === 0 ? solid : px));
    }
    return rgba;
  },

  // Lua: asset_pack.lua:156
  sizeOf(kind: string): number {
    return READERS[kind]![0];
  },

  // Lua: asset_pack.lua:160
  read(rom: Rom, off: number, kind: string): number {
    return READERS[kind]![1](rom, off);
  },

  // Lua: asset_pack.lua:164 -- a sequence (0-based array)
  array(rom: Rom, off: number, kind: string, count: number): number[] {
    const [size, fn] = READERS[kind]!;
    const out: number[] = [];
    for (let i = 0; i <= count - 1; i++) out[i] = fn(rom, off + i * size);
    return out;
  },

  // Lua: asset_pack.lua:171 -- nested sequences (0-based arrays)
  grid(rom: Rom, off: number, kind: string, dims: number[]): any[] {
    const size = READERS[kind]![0];
    const build = (base: number, depth: number): any[] => {
      const n = dims[depth - 1]!;
      if (depth === dims.length) return AssetPack.array(rom, base, kind, n);
      let stride = size;
      for (let d = depth + 1; d <= dims.length; d++) stride *= dims[d - 1]!;
      const out: any[] = [];
      for (let i = 0; i <= n - 1; i++) out[i] = build(base + i * stride, depth + 1);
      return out;
    };
    return build(off, 1);
  },

  // Lua: asset_pack.lua:185 -- fields are { name, kind, offset }
  structs(rom: Rom, off: number, stride: number, count: number, fields: [string, string, number][]): Record<string, number>[] {
    const out: Record<string, number>[] = [];
    for (let i = 0; i <= count - 1; i++) {
      const row: Record<string, number> = {};
      for (const f of fields) row[f[0]] = AssetPack.read(rom, off + i * stride + f[2], f[1]);
      out[i] = row;
    }
    return out;
  },

  // Lua: asset_pack.lua:198 (include/window.h:28)
  windowTemplates(rom: Rom, off: number, count: number): Record<string, number>[] {
    return AssetPack.structs(rom, off, 8, count, [
      ["bg", "u8", 0], ["left", "u8", 1], ["top", "u8", 2],
      ["width", "u8", 3], ["height", "u8", 4], ["paletteNum", "u8", 5],
      ["baseBlock", "u16", 6],
    ]);
  },

  // Lua: asset_pack.lua:207 (include/bg.h:67)
  bgTemplates(rom: Rom, off: number, count: number): Record<string, number>[] {
    const out: Record<string, number>[] = [];
    for (let i = 0; i <= count - 1; i++) {
      const v = rom.u32(off + i * 4);
      const bits = (lo: number, n: number): number => Math.floor(v / 2 ** lo) % 2 ** n;
      out[i] = {
        bg: bits(0, 2), charBaseIndex: bits(2, 2), mapBaseIndex: bits(4, 5),
        screenSize: bits(9, 2), paletteMode: bits(11, 1), priority: bits(12, 2),
        baseTile: bits(16, 10),
      };
    }
    return out;
  },

  // Lua: asset_pack.lua:270
  serialize(v: unknown): string {
    return "return " + serialize(v, 0) + "\n";
  },

  // Lua: asset_pack.lua:274
  loadManifest(cache: Cache | undefined, path: string): any {
    if (!cache) return undefined;
    const body = cache.exists(path) ? cache.read(path) : undefined;
    if (typeof body !== "string") return undefined;
    let man: unknown;
    try { man = readLuaLiteral(body); } catch { return undefined; }
    if (typeof man !== "object" || man === null) return undefined;
    return man;
  },

  // Lua: asset_pack.lua:285
  sizedFile(cache: Cache, path: string, n: number): boolean {
    if (!cache.exists(path)) return false;
    const body = cache.read(path);
    return typeof body === "string" && body.length === n;
  },
};

export default AssetPack;
