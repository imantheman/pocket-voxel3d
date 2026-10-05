// Port of gen1recomp src/import/gba/multichoice_extract.lua (GPLv3 + additional terms; see LICENSE.md).
// Extractor for GBA Multichoice list strings and tables (gMultichoiceLists).
// Lua differences: lists keeps the Lua's 0-based integer keys (an object);
// labels are 0-based arrays.
// NOT FAITHFUL: when cache.write fails the Lua also tries love.filesystem;
// here only the cache and CacheFs are tried.

import { format, tostring } from "./lua.ts";
import { Versions } from "./versions.ts";
import { Family } from "./family.ts";
import { CacheFs, type Cache } from "./cache.ts";
import type { Rom } from "./rom.ts";
import { TextIR } from "../../game/gen3/core/scripting/text_ir.ts";
import { Profile } from "../../game/gen3/core/profile.ts";

export interface MultichoiceList { count: number; labels: string[] }

const ROM_BASE = 0x08000000, ROM_END = 0x0A000000;
const MAX_LABEL_BYTES = 64;

// Lua: multichoice_extract.lua:11
function read_label_bytes(rom: Rom, off: number): number[] {
  const bytes: number[] = [];
  for (let i = 0; i <= MAX_LABEL_BYTES - 1; i++) {
    const b = rom.get(off + i);
    bytes.push(b);
    if (b === 0xFF) break;
  }
  return bytes;
}

const SEG_TEXT: Record<string, string> = {
  nl: " ", para: " ", scroll: " ",
  player: "{PLAYER}", rival: "{RIVAL}",
};

// Lua: multichoice_extract.lua:45
function rom_off(ptr: number): number | undefined {
  if (ptr >= ROM_BASE && ptr < ROM_END) return ptr - ROM_BASE;
  return undefined;
}

// Lua: multichoice_extract.lua:80
function source_label(): string {
  const F = Family.active();
  if (F.aliases) return "FRLG";
  return Profile.of(F.game).label;
}

// Lua: multichoice_extract.lua:118
function multichoice_path(cacheRoot?: string): string {
  return (cacheRoot ?? "data/generated/gba") + "/" + MultichoiceExtract.CACHE_REL;
}

export const MultichoiceExtract = {
  CACHE_REL: "scripts/multichoice.lua",
  REQUIRED: ["scripts/multichoice.lua"],

  // Lua: multichoice_extract.lua:26 -- bytes 0-based
  label(bytes: ArrayLike<number>, dialect?: string): string {
    const parts: string[] = [];
    for (const seg of TextIR.decode(bytes, { dialect })) {
      if (seg.t === "eos") break;
      if (seg.t === "text") {
        parts.push(seg.s!);
      } else if (seg.t === "tag") {
        parts.push(seg.tag!);
      } else if (seg.t === "strvar") {
        parts.push("{STR_VAR_" + tostring(seg.n) + "}");
      } else if (seg.t === "ext" && seg.cmd === 0x13) {
        parts.push("  ");
      } else if (SEG_TEXT[seg.t] !== undefined) {
        parts.push(SEG_TEXT[seg.t]!);
      }
    }
    // Lua's %s is [ \t\n\v\f\r] (JS \s would also match byte 0xA0 of UTF-8 text).
    return parts.join("").replace(/[ \t\n\v\f\r]+/g, " ").replace(/^[ \t\n\v\f\r]+/, "").replace(/[ \t\n\v\f\r]+$/, "");
  },

  // Lua: multichoice_extract.lua:50
  extract(rom: Rom, opts: { base?: number; count?: number; dialect?: string } = {}): Record<number, MultichoiceList> {
    const base = opts.base ?? Versions.MULTICHOICE_LISTS;
    if (!base) throw new Error("multichoice: no MULTICHOICE_LISTS for this ROM");
    const totalCount = opts.count ?? Versions.MULTICHOICE_COUNT;
    if (!totalCount) throw new Error("multichoice: no MULTICHOICE_COUNT for this ROM");
    const dialect = opts.dialect ?? TextIR.dialectOf();

    const lists: Record<number, MultichoiceList> = {};
    for (let i = 0; i <= totalCount - 1; i++) {
      const off = base + i * 8;
      const listOff = rom_off(rom.u32(off));
      const count = rom.get(off + 4);
      const labels: string[] = [];
      if (listOff !== undefined && count > 0 && count <= 30) {
        for (let a = 0; a <= count - 1; a++) {
          const textOff = rom_off(rom.u32(listOff + a * 8));
          let s = "";
          if (textOff !== undefined) {
            s = MultichoiceExtract.label(read_label_bytes(rom, textOff), dialect);
          }
          labels.push(s);
        }
      }
      lists[i] = { count: labels.length, labels };
    }
    return lists;
  },

  // Lua: multichoice_extract.lua:86
  formatLua(lists: Record<number, MultichoiceList>): string {
    const lines = [
      "-- Auto-generated " + source_label() + " Multichoice Lists from ROM gMultichoiceLists. DO NOT EDIT DIRECTLY.",
      "return {",
    ];
    // `for i = 0, #lists`: the border of lists' 1.. keys.
    let n = 0;
    while (lists[n + 1] !== undefined) n++;
    for (let i = 0; i <= n; i++) {
      const item = lists[i];
      if (item && item.labels) {
        const quoted: string[] = [];
        for (const s of item.labels) {
          quoted.push(format("%q", s));
        }
        lines.push(format("  [%d] = { count = %d, labels = { %s } },", i, item.labels.length, quoted.join(", ")));
      }
    }
    lines.push("}");
    lines.push("");
    return lines.join("\n");
  },

  // Lua: multichoice_extract.lua:122
  ready(cache: Cache | undefined, cacheRoot?: string): boolean {
    const rel = multichoice_path(cacheRoot);
    if (cache && cache.read) {
      const data = cache.read(rel);
      return (data !== undefined && data.length > 40 && data.includes("labels"));
    }
    if (cache && cache.exists) {
      return cache.exists(rel) ? true : false;
    }
    return false;
  },

  // Lua: multichoice_extract.lua:134
  run(rom: Rom, cache: Cache | undefined, opts: { cacheRoot?: string } = {}): { path: string; listCount: number } {
    const lists = MultichoiceExtract.extract(rom);
    const content = MultichoiceExtract.formatLua(lists);
    const rel = multichoice_path(opts.cacheRoot);

    let wrote = false, err: unknown;
    if (cache && cache.write) {
      const ok = cache.write(rel, content);
      if (ok === false) err = "write failed"; else wrote = true;
    }
    if (!wrote) {
      try {
        const [ok, werr] = CacheFs.write(rel, content);
        if (ok) wrote = true; else err = err ?? werr;
      } catch (e) {
        err = err ?? e;
      }
    }
    if (!wrote) {
      throw new Error("multichoice: could not write " + rel + ": " + tostring(err));
    }

    let count = 0;
    for (const k of Object.keys(lists)) {
      const entry = lists[Number(k)];
      if (entry && entry.count && entry.count > 0) count = count + 1;
    }
    return { path: rel, listCount: count };
  },
};

export default MultichoiceExtract;
