// Port of gen1recomp src/import/gba/easy_chat_extract.lua (GPLv3 + additional terms; see LICENSE.md).
// src/data/easy_chat/easy_chat_groups.h:26, src/easy_chat.c:41, :640
// Lua differences: groups / frames keep the Lua's 0-based integer keys
// (objects); words / templates are 0-based arrays.

import { format, tostring } from "./lua.ts";
import { Versions } from "./versions.ts";
import { serialize_lua } from "./extract_scripts.ts";
import type { Cache } from "./cache.ts";
import type { Rom } from "./rom.ts";
import { TextIR } from "../../game/gen3/core/scripting/text_ir.ts";

type Tbl = Record<string, any>;

// include/constants/easy_chat.h:15
const VALUE_GROUPS: Record<number, string> = { 0: "species", 18: "move", 19: "move", 21: "species" };

// Lua: easy_chat_extract.lua:14
function read_string(rom: Rom, off: number, maxLen: number): string {
  const bytes: number[] = [];
  for (let i = 0; i <= maxLen - 1; i++) {
    const b = rom.get(off + i);
    bytes.push(b);
    if (b === 0xFF) break;
  }
  if (bytes[bytes.length - 1] !== 0xFF) throw new Error(format("easy chat string at 0x%X has no EOS", off));
  return TextIR.toPlain(TextIR.decode(bytes), {});
}

// Lua: easy_chat_extract.lua:25
function ptr_offset(rom: Rom, ptr: number, what: string): number {
  const off = rom.ptrOffset(ptr);
  if (off === undefined) throw new Error(format("%s is not a ROM pointer (0x%08X)", what, ptr));
  return off;
}

export const EasyChatExtract = {
  CACHE_SUB: "easy_chat",
  FILE: "easy_chat/words.lua",
  REQUIRED: ["easy_chat/words.lua"],

  // Lua: easy_chat_extract.lua:29
  extractFromRom(rom: Rom): Record<number, Tbl> {
    const groups: Record<number, Tbl> = {};
    const speciesStride = Versions.SPECIES_NAME_LENGTH;
    const moveStride = Versions.MOVE_NAME_LENGTH + 1;
    for (let gid = 0; gid <= Versions.EASY_CHAT_GROUP_COUNT - 1; gid++) {
      const gOff = Versions.EASY_CHAT_GROUPS + gid * 8;
      const dataOff = ptr_offset(rom, rom.u32(gOff), "sEasyChatGroups[" + tostring(gid) + "]");
      const numWords = rom.u16(gOff + 4);
      const numEnabled = rom.u16(gOff + 6);
      const nameOff = ptr_offset(rom, rom.u32(Versions.EASY_CHAT_GROUP_NAMES + gid * 4),
        "sEasyChatGroupNamePointers[" + tostring(gid) + "]");
      const words: Tbl[] = [];
      const kind = VALUE_GROUPS[gid];
      for (let i = 0; i <= numWords - 1; i++) {
        if (kind) {
          const value = rom.u16(dataOff + i * 2);
          let text: string;
          if (kind === "species") {
            text = read_string(rom, Versions.SPECIES_NAMES + value * speciesStride, speciesStride);
          } else {
            text = read_string(rom, Versions.MOVE_NAMES + value * moveStride, moveStride);
          }
          words.push({ id: gid * 512 + value, value, text });
        } else {
          const entry = dataOff + i * 12;
          const textOff = ptr_offset(rom, rom.u32(entry), format("easy chat word %d:%d", gid, i));
          words.push({
            id: gid * 512 + i,
            text: read_string(rom, textOff, 32),
            alphabeticalOrder: rom.u32(entry + 4),
            enabled: rom.u32(entry + 8) !== 0,
          });
        }
      }
      groups[gid] = {
        id: gid,
        name: read_string(rom, nameOff, 32),
        numWords,
        numEnabled,
        words,
      };
    }
    return groups;
  },

  // pokeemerald/src/easy_chat.c:428
  // Lua: easy_chat_extract.lua:79 -- [templates (0-based), frames (0-based keys)]
  templatesFromRom(rom: Rom): [Tbl[], Record<number, Tbl>] {
    const T = Versions.EASY_CHAT_TEMPLATES;
    const text = (ptr: number): string => {
      const off = rom.ptrOffset(ptr);
      return off !== undefined ? read_string(rom, off, 256) : "";
    };
    const out: Tbl[] = [];
    for (let i = 0; i <= T.count - 1; i++) {
      const e = T.off + i * 24;
      const b3 = rom.get(e + 3);
      out.push({
        type: rom.get(e), numColumns: rom.get(e + 1), numRows: rom.get(e + 2),
        frameId: b3 % 128, fourFooterOptions: b3 >= 128,
        title: text(rom.u32(e + 4)), instructions1: text(rom.u32(e + 8)), instructions2: text(rom.u32(e + 12)),
        confirm1: text(rom.u32(e + 16)), confirm2: text(rom.u32(e + 20)),
      });
    }
    const frames: Record<number, Tbl> = {};
    for (let i = 0; i <= T.frameCount - 1; i++) {
      const e = T.frames + i * 4;
      const b0 = rom.get(e);
      frames[i] = {
        left: b0 % 32, top: Math.floor(b0 / 32), width: rom.get(e + 1), height: rom.get(e + 2),
        footerId: rom.get(e + 3),
      };
    }
    return [out, frames];
  },

  // Lua: easy_chat_extract.lua:103
  run(rom: Rom, cache: Cache, opts: { cacheRoot?: string } = {}): Tbl {
    const groups = EasyChatExtract.extractFromRom(rom);
    const outRel = (opts.cacheRoot ?? "data/generated/gba") + "/" + EasyChatExtract.FILE;
    const pack: Tbl = { groups };
    if (Versions.EASY_CHAT_TEMPLATES) {
      [pack.templates, pack.frames] = EasyChatExtract.templatesFromRom(rom);
    }
    if (!cache.write(outRel, "return " + serialize_lua(pack) + "\n")) {
      throw new Error("could not write " + outRel);
    }
    return { ok: true, groupCount: Versions.EASY_CHAT_GROUP_COUNT, path: outRel };
  },
};

export default EasyChatExtract;
