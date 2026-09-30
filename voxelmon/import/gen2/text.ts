// Port of gen1recomp RomExtractorGen2.lua:2977 decodeGen2Text (bdfac727)
// and its tables (:135-187): the Gen 2 text-command walker that turns a
// text stream into the string the overworld VM prints, with {STRBUF},
// {NUM}, {PLAYER}, {RIVAL}, {USER}/{TARGET}/{ENEMY}, {PROMPT}/{DONE} and
// {BYTE:xx} markers. Crystal's buffer addresses (TEXT_BUFFERS_CRYSTAL) and
// its $14 <PLAY_G> in-string case are dropped: Gold only.

import { hex2 } from "../ctx.ts";
import type { Gen2Ctx } from "./ctx.ts";

/** :139 TEXT_BUFFERS — the WRAM string buffers a `text_ram` can name
 * (pokegold.sym); recorded only when the caller passes `buffers`. */
export const TEXT_BUFFERS: Record<number, string> = {
  0xcf48: "wMonOrItemNameBuffer",
  0xcf6b: "wStringBuffer1",
  0xcf7e: "wStringBuffer2",
  0xcf91: "wStringBuffer3",
  0xcfa4: "wStringBuffer4",
  0xcfb7: "wStringBuffer5",
  0xc5d1: "wPlayerTrademonSpeciesName",
  0xc5e7: "wPlayerTrademonSenderName",
  0xc602: "wOTTrademonSpeciesName",
  0xc618: "wOTTrademonSenderName",
};

/** :171 TEXT_NO_GLYPH — TX_LOW, TX_SCROLL, TX_PAUSE, TX_WAIT_BUTTON,
 * TX_DAY and the six TX_SOUND_* jingles: print nothing, carry nothing. */
const TEXT_NO_GLYPH = new Set([0x05, 0x07, 0x0a, 0x0b, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x15]);

/** :183 NAME_SLOT — the battle name slots, markers rather than glyphs. */
const NAME_SLOT: Record<string, string> = {
  "<USER>": "{USER}",
  "<TARGET>": "{TARGET}",
  "<ENEMY>": "{ENEMY}",
};

/**
 * RomExtractorGen2.lua:2977 decodeGen2Text. Walks at most 4096 bytes
 * (counting from the current stream start; a TX_FAR restarts the count).
 * `buffers`, when given, receives one entry per TX_RAM: the buffer's name,
 * or its raw address when TEXT_BUFFERS has none.
 */
export function decodeGen2Text(
  ctx: Gen2Ctx,
  bank: number,
  address: number,
  charmap: Record<string, string>,
  buffers?: (string | number)[],
): string {
  const { rom } = ctx;
  const out: string[] = [];
  let i = 0;
  let hops = 0;
  // false = DoTextUntilTerminator, true = inside PlaceString.
  let inString = false;
  while (i < 4096) {
    const b = rom.byte(bank, address + i);
    if (b === 0x50) {
      if (!inString) break; // TX_END
      inString = false; // `@`: end of this chunk
    } else if (b === 0x57 || b === 0x58) {
      // home/text.asm PromptText / DoneText
      if (out.length > 0) out.push(b === 0x58 ? "{PROMPT}" : "{DONE}");
      break;
    } else if (b === 0x00) {
      inString = true; // TX_START
    } else if (b === 0x16 && !inString) {
      // :2999 TX_FAR `db TX_FAR / dw addr / db bank`: the stream CONTINUES
      // at the far address.
      const farAddr = rom.word(bank, address + i + 1);
      const farBank = rom.byte(bank, address + i + 3);
      hops += 1;
      if (hops > 8 || farBank === 0 || farBank > 0x7f || farAddr < 0x4000 || farAddr >= 0x8000) break;
      bank = farBank;
      address = farAddr;
      i = -1; // the loop's own increment lands on the far stream's first byte
    } else if (b === 0x01) {
      // TX_RAM: dw wStringBuffer*
      out.push("{STRBUF}");
      if (buffers) {
        const target = rom.word(bank, address + i + 1);
        buffers.push(TEXT_BUFFERS[target] ?? target);
      }
      i += 2;
    } else if (b === 0x4e || b === 0x4f) {
      out.push("\n");
    } else if (b === 0x51) {
      out.push("\f");
    } else if (b === 0x55) {
      out.push("\v");
    } else if (b === 0x52) {
      out.push("{PLAYER}");
    } else if (b === 0x53) {
      out.push("{RIVAL}");
    } else if (b === 0x54) {
      out.push("POKé");
    } else if (b === 0x06) {
      // TX_PROMPT_BUTTON: no glyphs.
    } else if (b === 0x09 && !inString) {
      // :3040 TX_DECIMAL `dw address / dn bytes, digits`: a runtime number.
      out.push("{NUM}");
      i += 3;
    } else if (b === 0x14 && !inString) {
      // TX_STRINGBUFFER `db buffer id`
      out.push("{STRBUF}");
      i += 1;
    } else if (b === 0x0c && !inString) {
      i += 1; // TX_DOTS `db count`
    } else if (!inString && TEXT_NO_GLYPH.has(b)) {
      // box and timing commands that print nothing
    } else {
      const ch = charmap[String(b)];
      if (ch !== undefined && !ch.startsWith("<")) {
        out.push(ch);
      } else if (ch === "<……>" || b === 0x56) {
        out.push("……");
      } else if (ch !== undefined && NAME_SLOT[ch]) {
        out.push(NAME_SLOT[ch]!);
      } else if (ch === undefined) {
        out.push(`{BYTE:${hex2(b)}}`);
      }
      // other <$xx> control glyphs are skipped
    }
    i += 1;
  }
  return out.join("");
}

/** A try-wrapped call: Lua's `pcall` shape (undefined on error). */
export function attempt<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}
