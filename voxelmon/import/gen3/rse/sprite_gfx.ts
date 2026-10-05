// Port of gen1recomp src/import/gba/rse/sprite_gfx.lua (GPLv3 + additional terms; see LICENSE.md).
// Shared OBJ sprite helpers (pointers, palettes, 4bpp tiles, OAM, sprite
// templates and anim tables) for the RSE field extractors. FRLG reaches none
// of it (field_effect/weather/door_anim run their FRLG paths); it is ported
// whole because it is generic.
// Lua differences: pixel tables (decodeTiles' `out`, idxString/rgbaString's
// `pix`) are 0-based here (the Lua's are 1-based); palettes keep the Lua's
// keys 0..15 as array indices; anim commands are 1-based Lua sequences, so JS
// arrays.

import { char } from "../lua.ts";
import type { Rom } from "../rom.ts";

/** The symbol table the RSE extractors pass as `S` (Versions.SYMS). */
export interface SpriteSyms {
  namesAt(off: number): string[];
  size(name: string): number;
}

export interface Oam {
  w: number; h: number; shape: number; size: number; affineMode: number; paletteNum: number; priority: number;
}
/** { "end" } | { "jump", arg } | { "loop", arg } | { "frame", kind, arg, hflip, vflip } */
export type AnimCmd = (string | number | boolean)[];
export interface SpriteTemplate {
  tileTag: number;
  paletteTag: number;
  oam: Oam;
  anims: AnimCmd[][];
  affine: boolean;
  images: { off: number; size: number }[];
}

const ROM_BASE = 0x08000000, ROM_END = 0x0A000000;

// pokeemerald/include/gba/types.h:102
const OAM_DIMS: Record<number, [number, number][]> = {
  0: [[8, 8], [16, 16], [32, 32], [64, 64]],
  1: [[16, 8], [32, 8], [32, 16], [64, 32]],
  2: [[8, 16], [8, 32], [16, 32], [32, 64]],
};

// pokeemerald/src/field_effect.c:274
const FE_ARGS: Record<number, number> = { 0: 1, 1: 1, 2: 1, 3: 1, 4: 0, 5: 3, 6: 2, 7: 2 };
const FE_PAL_ARG: Record<number, number> = { 1: 1, 2: 1, 5: 2, 7: 1 };

/** ASCII-only lower (string.lower in the C locale; JS toLowerCase would touch bytes >= 0x80). */
function lower(s: string): string {
  return s.replace(/[A-Z]+/g, (m) => m.toLowerCase());
}

export const SpriteGfx = {
  // Lua: rse/sprite_gfx.lua:12
  ptr(rom: Rom, off: number): number | undefined {
    const p = rom.u32(off);
    if (p >= ROM_BASE && p < ROM_END) return p - ROM_BASE;
    return undefined;
  },

  // Lua: rse/sprite_gfx.lua:18
  snake(name: string): string {
    const s = name.replace(/([a-z])([A-Z])/g, "$1_$2")
      .replace(/([A-Z])([A-Z][a-z])/g, "$1_$2")
      .replace(/([A-Za-z])([0-9])/g, "$1_$2");
    return lower(s);
  },

  // Lua: rse/sprite_gfx.lua:23
  symName(S: SpriteSyms, off: number, prefix?: string): string | undefined {
    let best: string | undefined;
    for (const n of S.namesAt(off)) {
      if (prefix === undefined || n.slice(0, prefix.length) === prefix) {
        if (best === undefined || n.length < best.length) best = n;
      }
    }
    return best;
  },

  // Lua: rse/sprite_gfx.lua:33
  symSize(S: SpriteSyms, off: number): number | undefined {
    for (const n of S.namesAt(off)) {
      let size: unknown;
      try { size = S.size(n); } catch { continue; }
      if (typeof size === "number" && size > 0) return size;
    }
    return undefined;
  },

  // Lua: rse/sprite_gfx.lua:41 -- keys 0..15
  readPalette(rom: Rom, off: number): number[] {
    const pal: number[] = [];
    for (let i = 0; i <= 15; i++) pal[i] = rom.u16(off + i * 2);
    return pal;
  },

  // Lua: rse/sprite_gfx.lua:47 -- [r, g, b]
  rgb8(c: number): [number, number, number] {
    const r5 = c % 32;
    const g5 = Math.floor(c / 32) % 32;
    const b5 = Math.floor(c / 1024) % 32;
    return [Math.floor((r5 * 255) / 31 + 0.5), Math.floor((g5 * 255) / 31 + 0.5), Math.floor((b5 * 255) / 31 + 0.5)];
  },

  // Lua: rse/sprite_gfx.lua:54
  palBytes(pal: (number | undefined)[]): string {
    const out: string[] = [];
    for (let i = 0; i <= 15; i++) {
      const c = pal[i] ?? 0;
      out.push(char(c % 256, Math.floor(c / 256) % 256));
    }
    return out.join("");
  },

  // Lua: rse/sprite_gfx.lua:63 -- `out` is 0-based here (Lua out[row + x*2 + 1])
  decodeTiles(rom: Rom, off: number, fw: number, fh: number, out: number[], oy?: number, stride?: number): number[] {
    const tw = fw / 8;
    stride = stride ?? fw;
    oy = oy ?? 0;
    for (let t = 0; t <= tw * (fh / 8) - 1; t++) {
      const base = off + t * 32;
      const tx = (t % tw) * 8, ty = Math.floor(t / tw) * 8;
      for (let y = 0; y <= 7; y++) {
        const row = (oy + ty + y) * stride + tx;
        for (let x = 0; x <= 3; x++) {
          const b = rom.get(base + y * 4 + x);
          out[row + x * 2] = b % 16;
          out[row + x * 2 + 1] = Math.floor(b / 16);
        }
      }
    }
    return out;
  },

  // Lua: rse/sprite_gfx.lua:82 -- pix 0-based here
  idxString(pix: (number | undefined)[], n: number): string {
    const parts: string[] = [];
    for (let i = 0; i < n; i++) parts.push(String.fromCharCode(pix[i] ?? 0));
    return parts.join("");
  },

  // Lua: rse/sprite_gfx.lua:96 -- pix 0-based here
  rgbaString(pix: (number | undefined)[], n: number, pal: (number | undefined)[]): string {
    const lut: string[] = [];
    for (let i = 0; i <= 15; i++) {
      if (i === 0) {
        lut[i] = "\x00\x00\x00\x00";
      } else {
        const [r, g, b] = SpriteGfx.rgb8(pal[i] ?? 0);
        lut[i] = char(r, g, b, 255);
      }
    }
    const out: string[] = [];
    for (let i = 0; i < n; i++) out[i] = lut[pix[i] ?? 0]!;
    return out.join("");
  },

  // Lua: rse/sprite_gfx.lua:112 (pokeemerald/include/gba/types.h:55)
  readOam(rom: Rom, off: number): Oam {
    const b1 = rom.get(off + 1), b3 = rom.get(off + 3), b5 = rom.get(off + 5);
    const shape = Math.floor(b1 / 64), size = Math.floor(b3 / 64);
    const dims = (OAM_DIMS[shape] && OAM_DIMS[shape]![size]) || [8, 8];
    return {
      w: dims[0],
      h: dims[1],
      shape,
      size,
      affineMode: b1 % 4,
      paletteNum: Math.floor(b5 / 16),
      priority: Math.floor(b5 / 4) % 4,
    };
  },

  // Lua: rse/sprite_gfx.lua:128 (pokeemerald/include/sprite.h:48)
  readAnim(rom: Rom, off: number): AnimCmd[] {
    const cmds: AnimCmd[] = [];
    for (let i = 0; i <= 63; i++) {
      const v = rom.u32(off + i * 4);
      const kind = v % 65536;
      const arg = Math.floor(v / 65536) % 64;
      if (kind === 0xFFFF) {
        cmds.push(["end"]);
        break;
      } else if (kind === 0xFFFE) {
        cmds.push(["jump", arg]);
        break;
      } else if (kind === 0xFFFD) {
        cmds.push(["loop", arg]);
      } else {
        const flags = Math.floor(v / 4194304) % 4;
        cmds.push(["frame", kind, arg, flags % 2 === 1, flags >= 2]);
      }
    }
    return cmds;
  },

  // Lua: rse/sprite_gfx.lua:150
  readAnimTable(rom: Rom, S: SpriteSyms, off: number, limit?: number): AnimCmd[][] {
    const size = SpriteGfx.symSize(S, off);
    const n = size !== undefined ? Math.floor(size / 4) : (limit ?? 1);
    const anims: AnimCmd[][] = [];
    for (let i = 0; i <= n - 1; i++) {
      const a = SpriteGfx.ptr(rom, off + i * 4);
      if (a === undefined) break;
      anims.push(SpriteGfx.readAnim(rom, a));
    }
    return anims;
  },

  // Lua: rse/sprite_gfx.lua:162
  maxFrame(anims: AnimCmd[][] | undefined): number {
    let m = -1;
    for (const anim of anims ?? []) {
      for (const c of anim) {
        if (c[0] === "frame" && (c[1] as number) > m) m = c[1] as number;
      }
    }
    return m;
  },

  // Lua: rse/sprite_gfx.lua:173 (pokeemerald/include/sprite.h:179)
  readTemplate(rom: Rom, S: SpriteSyms, off: number): SpriteTemplate {
    const oamOff = SpriteGfx.ptr(rom, off + 4);
    const oam = oamOff !== undefined ? SpriteGfx.readOam(rom, oamOff) : SpriteGfx.readOam(rom, off);
    const animsOff = SpriteGfx.ptr(rom, off + 8);
    const anims = animsOff !== undefined ? SpriteGfx.readAnimTable(rom, S, animsOff, 1) : [];
    const imagesOff = SpriteGfx.ptr(rom, off + 12);
    const t: SpriteTemplate = {
      tileTag: rom.u16(off),
      paletteTag: rom.u16(off + 2),
      oam,
      anims,
      affine: rom.u32(off + 16) !== 0 && oam.affineMode !== 0,
      images: [],
    };
    if (imagesOff !== undefined) {
      const size = SpriteGfx.symSize(S, imagesOff);
      const n = size !== undefined ? Math.floor(size / 8) : SpriteGfx.maxFrame(t.anims) + 1;
      for (let i = 0; i <= n - 1; i++) {
        const d = SpriteGfx.ptr(rom, imagesOff + i * 8);
        if (d === undefined) break;
        t.images.push({ off: d, size: rom.u16(imagesOff + i * 8 + 4) });
      }
    }
    return t;
  },

  // Lua: rse/sprite_gfx.lua:198 (pokeemerald/src/event_object_movement.c:481) -- tag -> data offset
  objectEventPalettes(rom: Rom, off: number, count: number): Record<number, number> {
    const byTag: Record<number, number> = {};
    for (let i = 0; i <= count - 1; i++) {
      const base = off + i * 8;
      const data = SpriteGfx.ptr(rom, base);
      const tag = rom.u16(base + 4);
      if (data === undefined) break;
      if (byTag[tag] === undefined) byTag[tag] = data;
    }
    return byTag;
  },

  // Lua: rse/sprite_gfx.lua:214
  fieldEffectScriptPalettes(rom: Rom, off: number, count: number, byTag?: Record<number, number>): Record<number, number> {
    byTag = byTag ?? {};
    for (let i = 0; i <= count - 1; i++) {
      let p = SpriteGfx.ptr(rom, off + i * 4);
      let steps = 0;
      while (p !== undefined && steps < 64) {
        const cmd = rom.get(p);
        const nargs = FE_ARGS[cmd];
        if (nargs === undefined || nargs === 0) break;
        const palArg = FE_PAL_ARG[cmd];
        if (palArg !== undefined) {
          const sp = SpriteGfx.ptr(rom, p + 1 + (palArg - 1) * 4);
          if (sp !== undefined) {
            const data = SpriteGfx.ptr(rom, sp);
            const tag = rom.u16(sp + 4);
            if (data !== undefined && byTag[tag] === undefined) byTag[tag] = data;
          }
        }
        p = p + 1 + nargs * 4;
        steps = steps + 1;
      }
    }
    return byTag;
  },
};

export default SpriteGfx;
