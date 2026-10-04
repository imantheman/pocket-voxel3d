// The Gen 2 importer context: RomExtractorGen2.lua:215 new() + :254 symbol()
// + :303 decompressLz3Symbol, over the shared Rom/GfxBin. `edition` is
// Brian's self.edition (GameVersion.forSha1(manifest.romSha1), :218): Gold,
// Silver or Crystal, and the Crystal switches (palMapBank, picBank's
// PICS_FIX, the renumbered opcodes, ...) key off it.

import { check, type RomSymbol } from "../ctx.ts";
import type { GfxBin } from "../gfx.ts";
import type { Rom } from "../rom.ts";
import { decompressLz3 } from "./lz.ts";
import type { Gen2Manifest } from "./manifest.ts";
import { CRYSTAL_SHA1, SILVER_SHA1 } from "../env.ts";

export type Gen2Edition = "gold" | "silver" | "crystal";

export class Gen2Ctx {
  /** RomExtractorGen2.lua:219-227 — manifest symbols with the ROM
   * revision's overrides merged over them. */
  readonly symbols: Record<string, [number, number]>;
  /** Which of the two carts this is (RomExtractorGen2.lua:218). */
  readonly edition: Gen2Edition;

  constructor(
    readonly rom: Rom,
    readonly manifest: Gen2Manifest,
    readonly gfx: GfxBin,
    romSha1?: string,
  ) {
    const revision = romSha1 ? manifest.symbolRevisions?.[romSha1] : undefined;
    this.symbols = revision ? { ...manifest.symbols, ...revision } : manifest.symbols;
    this.edition =
      manifest.romSha1 === SILVER_SHA1 ? "silver" : manifest.romSha1 === CRYSTAL_SHA1 ? "crystal" : "gold";
  }

  /** Brian's `self.edition == "crystal"`. */
  get crystal(): boolean {
    return this.edition === "crystal";
  }

  /** `self.symbols[name]`: the optional lookup (nil when absent). */
  location(name: string): [number, number] | undefined {
    return this.symbols[name];
  }

  /** RomExtractorGen2.lua:254 — a missing symbol is a hard error. */
  symbol(name: string): RomSymbol {
    const location = this.symbols[name];
    check(location, `required symbol is missing: ${name}`);
    return { bank: location[0], address: location[1], name };
  }

  /** Everything from bank:address to the end of its bank — how Brian hands
   * a terminator-ended lz3 stream over (RomExtractorGen2.lua:305, :1057). */
  toBankEnd(bank: number, address: number): number[] {
    return this.rom.bytes(bank, address, 0x8000 - address);
  }

  /** RomExtractorGen2.lua:303 decompressLz3Symbol. */
  decompressLz3Symbol(label: string): number[] {
    const symbol = this.symbol(label);
    return decompressLz3(this.toBankEnd(symbol.bank, symbol.address));
  }
}

/** src/script/gen2/Opcodes.lua:323 Opcodes.key — "bb:aaaa", the id every
 * script pointer is keyed by in the Gen 2 script cache. */
export function scriptKey(bank: number, address: number): string {
  return `${bank.toString(16).padStart(2, "0")}:${address.toString(16).padStart(4, "0")}`;
}

/** RomExtractorGen2.lua:1170 signedByte. */
export function signedByte(value: number): number {
  return value >= 0x80 ? value - 0x100 : value;
}

/**
 * RomExtractorGen2.lua:1175 orderName(list, index, fallback): `index` is a
 * LUA (1-based) index into the manifest order list; a miss falls back to
 * `fallback`, then to the index itself (so it never returns nil).
 */
export function orderName(
  list: string[] | undefined,
  luaIndex: number,
  fallback?: string | number,
): string | number {
  if (!Array.isArray(list)) return fallback ?? luaIndex;
  return (luaIndex >= 1 ? list[luaIndex - 1] : undefined) ?? fallback ?? luaIndex;
}
