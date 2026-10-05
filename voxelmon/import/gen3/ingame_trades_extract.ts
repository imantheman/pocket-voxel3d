// Port of gen1recomp src/import/gba/ingame_trades_extract.lua (GPLv3 + additional terms; see LICENSE.md).
// src/trade_scene.c:57, src/data/ingame_trades.h:1, :184
// Lua differences: trades / mail keep the Lua's 0-based integer keys
// (objects); ivs / conditions / words are 0-based arrays.

import { Versions } from "./versions.ts";
import { serialize_lua } from "./extract_scripts.ts";
import type { Cache } from "./cache.ts";
import type { Rom } from "./rom.ts";
import { TextIR } from "../../game/gen3/core/scripting/text_ir.ts";

type Tbl = Record<string, any>;

const MAIL_WORDS = 9; // include/constants/global.h:65
const MAIL_ROW = 10;
const MAIL_NONE = 255;

// Lua: ingame_trades_extract.lua:17
function name_at(rom: Rom, off: number, len: number): string {
  const bytes: number[] = [];
  for (let i = 0; i <= len - 1; i++) {
    const b = rom.get(off + i);
    bytes.push(b);
    if (b === 0xFF) break;
  }
  return TextIR.toPlain(TextIR.decode(bytes), {});
}

export const InGameTradesExtract = {
  CACHE_SUB: "trades",
  FILES: ["ingame_trades.lua"],
  REQUIRED: ["trades/ingame_trades.lua"],

  // Lua: ingame_trades_extract.lua:27
  extract(rom: Rom): { trades: Record<number, Tbl>; mail: Record<number, number[]> } {
    const trades: Record<number, Tbl> = {};
    for (let i = 0; i <= Versions.INGAME_TRADE_COUNT - 1; i++) {
      const off = Versions.INGAME_TRADES + i * Versions.INGAME_TRADE_SIZE;
      const ivs: number[] = [];
      for (let s = 0; s <= 5; s++) ivs[s] = rom.get(off + 0x0E + s);
      const conditions: number[] = [];
      for (let c = 0; c <= 4; c++) conditions[c] = rom.get(off + 0x1C + c);
      const mailNum = rom.get(off + 0x2A);
      trades[i] = {
        nickname: name_at(rom, off, 11),
        species: rom.u16(off + 0x0C),
        ivs,
        abilityNum: rom.get(off + 0x14),
        otId: rom.u32(off + 0x18),
        conditions,
        personality: rom.u32(off + 0x24),
        heldItem: rom.u16(off + 0x28),
        mailNum: mailNum !== MAIL_NONE ? mailNum : undefined,
        otName: name_at(rom, off + 0x2B, 11),
        otGender: rom.get(off + 0x36),
        sheen: rom.get(off + 0x37),
        requestedSpecies: rom.u16(off + 0x38),
      };
    }
    const mail: Record<number, number[]> = {};
    for (let m = 0; m <= Versions.INGAME_TRADE_MAIL_COUNT - 1; m++) {
      const words: number[] = [];
      for (let w = 0; w <= MAIL_WORDS - 1; w++) {
        words[w] = rom.u16(Versions.INGAME_TRADE_MAIL + (m * MAIL_ROW + w) * 2);
      }
      mail[m] = words;
    }
    return { trades, mail };
  },

  // Lua: ingame_trades_extract.lua:63
  ready(cache: Cache | undefined, cacheRoot?: string): boolean {
    const rel = (cacheRoot ?? "data/generated/gba") + "/" + InGameTradesExtract.CACHE_SUB + "/ingame_trades.lua";
    return (cache && cache.exists && cache.exists(rel)) ? true : false;
  },

  // Lua: ingame_trades_extract.lua:68
  run(rom: Rom, cache: Cache, opts: { cacheRoot?: string } = {}): Tbl {
    const root = (opts.cacheRoot ?? "data/generated/gba") + "/" + InGameTradesExtract.CACHE_SUB;
    const pack = InGameTradesExtract.extract(rom);
    cache.write(root + "/ingame_trades.lua", "return " + serialize_lua(pack) + "\n");
    return pack;
  },
};

export default InGameTradesExtract;
