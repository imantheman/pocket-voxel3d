// Port of gen1recomp src/import/gba/help_extract.lua (GPLv3 + additional terms; see LICENSE.md).
// FireRed Help ROM tables. Offsets relative to sHelpSystemTopicPtrs, verified
// against pret/pokefirered and BPRE Rev 1. No game text is distributed here.
// Lua differences: topics / descriptions / entries / tiles / palette are
// 0-based arrays (Lua sequences); contexts keeps its 0-based integer keys and
// each context's topics their 1-based keys (objects, holes allowed).

import { format, tostring } from "./lua.ts";
import { luaGet, luaKeys } from "./luatable.ts";
import { Versions } from "./versions.ts";
import type { Cache } from "./cache.ts";
import type { Rom } from "./rom.ts";
import { TextIR } from "../../game/gen3/core/scripting/text_ir.ts";

type Tbl = Record<string, any>;

// CHAR_EXTRA_SYMBOL glyphs use the second bank of the original Latin font.
// (UTF-8 bytes of the Lua source's literals.)
const SYMBOLS: Record<number, string> = {
  0: "\xE2\x86\x91", 1: "\xE2\x86\x93", 2: "\xE2\x86\x90", 3: "\xE2\x86\x92", 4: "+",
  10: "\xE2\x91\xA0", 11: "\xE2\x91\xA1", 12: "\xE2\x91\xA2", 13: "\xE2\x91\xA3", 14: "\xE2\x91\xA4",
  15: "\xE2\x91\xA5", 16: "\xE2\x91\xA6", 17: "\xE2\x91\xA7", 18: "\xE2\x91\xA8", 19: "(", 20: ")",
  21: "\xE2\x97\x8E", 22: "\xE2\x96\xB3", 23: "\xE2\x9C\x95",
};
const BASE_REV1 = 0x45B0E0;
const TABLES: [number, number, number][] = [[0x30, 0xE4, 44], [0x198, 0x25C, 48], [0x320, 0x3D0, 43],
  [0x480, 0x4A0, 7], [0x4C0, 0x550, 35]];

// Lua: help_extract.lua:15
function pointer(rom: Rom, off: number): number {
  const p = rom.u32(off) - 0x08000000;
  if (!(p >= 0 && p < rom.size)) throw new Error("Invalid Help ROM pointer");
  return p;
}

// Lua: help_extract.lua:20
function readText(rom: Rom, off: number): string {
  const out: string[] = [];
  let bytes: number[] = [];
  const flush = (): void => {
    for (const seg of TextIR.decode(bytes)) {
      if (seg.t === "nl" || seg.t === "scroll" || seg.t === "para") {
        out.push("\n");
      } else if (seg.t === "player") out.push("{PLAYER}");
      else if (seg.t === "rival") out.push("{RIVAL}");
      else if (seg.t === "strvar" && seg.n === 1) out.push("{PC_OWNER}");
      else if (seg.t === "text") out.push(seg.s!);
    }
    bytes = [];
  };
  for (let n = 1; n <= 4096; n++) {
    const b = rom.get(off); off = off + 1;
    if (b === 0xFF) { flush(); return out.join(""); }
    if (b === 0xF9) {
      flush();
      const glyph = rom.get(off); off = off + 1;
      const sym = SYMBOLS[glyph];
      if (sym === undefined) throw new Error("Unsupported Help symbol " + tostring(glyph));
      out.push(sym);
    } else bytes.push(b);
  }
  throw new Error("Unterminated Help ROM text");
}

// Lua: help_extract.lua:42 -- 0-based
function list(rom: Rom, off: number): number[] {
  const out: number[] = [];
  for (let i = 0; i <= 63; i++) {
    const v = rom.get(off + i);
    if (v === 255) return out;
    out.push(v);
  }
  throw new Error("Unterminated Help topic list");
}

// Lua: help_extract.lua:51
function locate(rom: Rom): number {
  // Rev 0 and Rev 1 keep this rodata block's layout. Validate the signature
  // instead of applying the Rev 1 displacement to unrelated ROM tables.
  const signature = [0xD1, 0xDC, 0xD5, 0xE8, 0, 0xE7, 0xDC, 0xE3, 0xE9, 0xE0, 0xD8];
  for (let base = Versions.address(BASE_REV1) - 0x200; base <= Versions.address(BASE_REV1) + 0x200; base += 4) {
    const p = rom.u32(base) - 0x08000000;
    if (p >= 0 && p + signature.length < rom.size) {
      let match = true;
      for (let i = 1; i <= signature.length; i++) {
        if (rom.get(p + i - 1) !== signature[i - 1]) { match = false; break; }
      }
      if (match) return base;
    }
  }
  throw new Error("Help tables not found in this ROM revision");
}

// Lua: help_extract.lua:96
function serialize(v: unknown): string {
  if (typeof v === "string") return format("%q", v);
  if (v === null || typeof v !== "object") return tostring(v);
  const keys = luaKeys(v);
  const ks = (k: number | string): string => (typeof k === "number" ? tostring(k) : k);
  keys.sort((a, b) => {
    const sa = ks(a), sb = ks(b);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  });
  const out = ["{"];
  for (const k of keys) out.push("[" + serialize(k) + "]=" + serialize(luaGet(v, k)) + ",");
  out.push("}");
  return out.join("");
}

export const HelpExtract = {
  PATH: "data/generated/gba/help/pack.lua",

  // Lua: help_extract.lua:65
  read(rom: Rom): Tbl {
    const base = locate(rom);
    const textBase = pointer(rom, base);
    const pack: Tbl = {
      version: 1, topics: [], descriptions: [], entries: [], contexts: {},
      greetings: readText(rom, textBase + 0x1D1), cancel: readText(rom, textBase + 0x77),
      basic: list(rom, base + 0x93E), tiles: [], palette: [],
    };
    for (let i = 1; i <= 6; i++) {
      pack.topics[i - 1] = readText(rom, pointer(rom, base + (i - 1) * 4));
      pack.descriptions[i - 1] = readText(rom, pointer(rom, base + 24 + (i - 1) * 4));
    }
    TABLES.forEach((row, idx) => {
      const entries: Tbl[] = []; pack.entries[idx] = entries;
      for (let id = 1; id <= row[2]; id++) {
        entries[id - 1] = {
          question: readText(rom, pointer(rom, base + row[0] + id * 4)),
          answer: readText(rom, pointer(rom, base + row[1] + id * 4)),
        };
      }
    });
    for (let context = 0; context <= 35; context++) {
      const topics: Record<number, number[]> = {}; pack.contexts[context] = topics;
      for (let topic = 1; topic <= 5; topic++) {
        const off = base + 0x960 + (context * 5 + topic - 1) * 4;
        if (rom.u32(off) !== 0) topics[topic] = list(rom, pointer(rom, off));
      }
    }
    for (let i = 0; i <= 287; i++) pack.tiles[i] = rom.get(base + 0x8F88 + i);
    for (let i = 0; i <= 15; i++) {
      const c = rom.u16(base + 0x90A8 + i * 2);
      pack.palette[i] = [c % 32 / 31, Math.floor(c / 32) % 32 / 31, Math.floor(c / 1024) % 32 / 31, 1];
    }
    return pack;
  },

  // Lua: help_extract.lua:105
  writeExtract(rom: Rom, cache: Cache): Tbl {
    const pack = HelpExtract.read(rom);
    if (!cache.write(HelpExtract.PATH, "return " + serialize(pack) + "\n")) throw new Error("assertion failed!");
    return pack;
  },
};

export default HelpExtract;
