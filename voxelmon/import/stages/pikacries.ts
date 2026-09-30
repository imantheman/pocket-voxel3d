// Yellow's voiced Pikachu clips: gen1recomp RomExtractor.lua:2141-2200
// extractPikachuCries, kept as the ROM's own bits rather than decoded WAVs.
//
// PikachuCriesPointerTable is NUM_PIKA_CRIES `dba` rows (bank byte, then a
// little-endian address); each clip is `dw length` and then `length` bytes
// of 1-bit PCM, MSB first (audio/pikachu_pcm.asm). The core plays the bits
// directly (crates/pocketvoxel-core audio.rs PcmBank), so this writes them
// out untouched behind a small table:
//
//   u16 count  u16 rate  count x { u32 offset, u32 bytes }  then the bits
//
// offsets from the start of the table. Red and Blue have no pointer table
// and get no file.

import { PIKA_PCM_CLIPS, PIKA_PCM_RATE } from "../../../contracts/spec/voxel-spec.ts";
import type { Ctx } from "../ctx.ts";

export function extractPikaCries(ctx: Ctx): Uint8Array | null {
  if (!ctx.hasSymbol("PikachuCriesPointerTable")) return null;
  const table = ctx.symbol("PikachuCriesPointerTable");
  const clips: Uint8Array[] = [];
  for (let i = 0; i < PIKA_PCM_CLIPS; i++) {
    const row = table.address + i * 3;
    const bank = ctx.rom.byte(table.bank, row);
    const address = ctx.rom.word(table.bank, row + 1);
    const length = ctx.rom.word(bank, address);
    const bits = new Uint8Array(length);
    for (let j = 0; j < length; j++) bits[j] = ctx.rom.byte(bank, address + 2 + j);
    clips.push(bits);
  }
  const head = 4 + clips.length * 8;
  const out = new Uint8Array(head + clips.reduce((n, c) => n + c.length, 0));
  const view = new DataView(out.buffer);
  view.setUint16(0, clips.length, true);
  view.setUint16(2, PIKA_PCM_RATE, true);
  let at = head;
  clips.forEach((c, i) => {
    view.setUint32(4 + i * 8, at, true);
    view.setUint32(8 + i * 8, c.length, true);
    out.set(c, at);
    at += c.length;
  });
  return out;
}
