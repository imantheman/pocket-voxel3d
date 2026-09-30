// pokegold's "lz3" compression (home/decompress.asm), used for Gen 2
// graphics (tilesets, Pokemon pics, title art, ...). Port of gen1recomp
// src/import/Rom.lua:211-308 Rom.decompressLz3 at bdfac727 (the last MIT
// commit); Brian ported it instruction-for-instruction against pokegold's
// Decompress and tools/lzcompress.c's --uncompress path.
//
// A command byte is `cccnnnnn`: 3-bit command, 5-bit length-1. Command 7
// (LZ_LONG) is `111cccnn nnnnnnnn`: the real command in the next 3 bits and
// a 10-bit length-1. $ff ends the stream.

import { check } from "../ctx.ts";

/** home/decompress.asm LZ_END / the LZ_* command ids (Rom.lua:217-224). */
export const LZ_END = 0xff;
export const LZ_LITERAL = 0;
export const LZ_ITERATE = 1;
export const LZ_ALTERNATE = 2;
export const LZ_ZERO = 3;
export const LZ_REPEAT = 4;
export const LZ_FLIP = 5;
export const LZ_REVERSE = 6;
export const LZ_LONG = 7;

/** Rom.lua:226 — reverse the bit order of one byte (LZ_FLIP's source). */
export function flipBits(value: number): number {
  let flipped = 0;
  for (let bit = 0; bit < 8; bit++) {
    if ((value >> bit) & 1) flipped |= 1 << (7 - bit);
  }
  return flipped;
}

/**
 * Rom.lua:234 — decompress one lz3 stream. `data` may run past the stream
 * (callers hand over everything to the end of the bank, Rom.lua:299-307);
 * the $ff terminator is what ends it. Throws on a stream that runs out
 * first, like the Lua's `error("lz3 stream ended ...")`.
 */
export function decompressLz3(data: ArrayLike<number>): number[] {
  let pos = 0;
  const next = (): number => {
    check(pos < data.length, "lz3 stream ended unexpectedly");
    return data[pos++]!;
  };

  const out: number[] = [];
  while (true) {
    check(pos < data.length, "lz3 stream ended without a terminator");
    const first = data[pos++]!;
    if (first === LZ_END) break;

    let command: number;
    let length: number;
    if (first >> 5 === LZ_LONG) {
      // Rom.lua:257 — 111xxxyy yyyyyyyy: xxx is the real command, yy.. a
      // 10-bit length ("inc bc": read at least 1 byte).
      command = (first >> 2) & 7;
      length = (first & 3) * 0x100 + next() + 1;
    } else {
      command = first >> 5;
      length = (first & 0x1f) + 1;
    }

    if (command === LZ_LITERAL) {
      for (let i = 0; i < length; i++) out.push(next());
    } else if (command === LZ_ITERATE) {
      const value = next();
      for (let i = 0; i < length; i++) out.push(value);
    } else if (command === LZ_ALTERNATE) {
      const a = next();
      const b = next();
      for (let i = 0; i < length; i++) out.push(i % 2 === 0 ? a : b);
    } else if (command === LZ_ZERO) {
      for (let i = 0; i < length; i++) out.push(0);
    } else {
      // Rom.lua:280 — the lookback commands (LZ_REPEAT/LZ_FLIP/LZ_REVERSE,
      // and a long-form id 7, which the hardware routine falls through to
      // LZ_REPEAT for). A high-bit offset byte is a 7-bit negative lookback
      // (decompress.asm `cpl`: $80 is the last byte written, so from =
      // len - n - 1); otherwise a 15-bit big-endian offset from the start of
      // the output. Lua is 1-based (`#out - n`, `off + 1`); these are 0-based.
      const offsetByte = next();
      const from = offsetByte >= 0x80 ? out.length - (offsetByte & 0x7f) - 1 : offsetByte * 0x100 + next();
      // Copies run byte by byte, so a source overlapping the bytes being
      // written repeats them (the RLE-style use the compressor relies on).
      const read = (index: number): number => {
        const value = out[index];
        check(value !== undefined, `lz3 lookback outside the output (${index} of ${out.length})`);
        return value;
      };
      if (command === LZ_FLIP) {
        for (let i = 0; i < length; i++) out.push(flipBits(read(from + i)));
      } else if (command === LZ_REVERSE) {
        for (let i = 0; i < length; i++) out.push(read(from - i));
      } else {
        for (let i = 0; i < length; i++) out.push(read(from + i));
      }
    }
  }
  return out;
}
