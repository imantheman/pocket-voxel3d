// Port of gen1recomp src/import/gba/battle_moves_extract.lua (GPLv3 + additional terms; see LICENSE.md).
// Extract FRLG gBattleMoves into {cacheRoot}/pokemon/battle_moves.lua.

import { Versions } from "./versions.ts";
import { CacheFs, type Cache } from "./cache.ts";
import { format } from "./lua.ts";
import type { Rom } from "./rom.ts";

export interface BattleMoveRow {
  effect: number; power: number; type: number; accuracy: number; pp: number;
  secondaryChance: number; target: number; priority: number; flags: number;
}
export interface BattleMovesPack {
  version: number; base: number; stride: number; count: number;
  /** keyed by internal move id from 0 (as the Lua's rows[id]) */
  moves: Record<number, BattleMoveRow>;
}

// Lua: battle_moves_extract.lua:11 -- extract_island1 is not a dependency
// here; every caller passes cacheRoot, and its CACHE_ROOT is this default.
function default_cache_root(): string {
  return "data/generated/gba";
}

function assert<T>(v: T | undefined | null, msg: string): T {
  if (v === undefined || v === null || (v as unknown) === false) throw new Error(msg);
  return v;
}

export const BattleMovesExtract = {
  FORMAT_VERSION: 1,
  CACHE_SUB: "pokemon",
  REQUIRED: ["pokemon/battle_moves.lua"],

  // Lua: battle_moves_extract.lua:20 -- bytes 0-based here (the Lua's off defaults to 1)
  decodeRow(bytes: ArrayLike<number | undefined>, off = 0): BattleMoveRow {
    const effect = bytes[off] ?? 0;
    const power = bytes[off + 1] ?? 0;
    const typeId = bytes[off + 2] ?? 0;
    const accuracy = bytes[off + 3] ?? 0;
    const pp = bytes[off + 4] ?? 0;
    const secondaryChance = bytes[off + 5] ?? 0;
    const target = bytes[off + 6] ?? 0;
    let priority = bytes[off + 7] ?? 0;
    if (priority >= 128) priority = priority - 256; // s8
    const flags = bytes[off + 8] ?? 0;
    return { effect, power, type: typeId, accuracy, pp, secondaryChance, target, priority, flags };
  },

  // Lua: battle_moves_extract.lua:45
  extract(rom: Rom, _opts: Record<string, unknown> = {}): BattleMovesPack {
    const base = assert<number>(Versions.BATTLE_MOVES, "battle_moves_extract: no BATTLE_MOVES key");
    const stride = assert<number>(Versions.BATTLE_MOVE_SIZE, "battle_moves_extract: no BATTLE_MOVE_SIZE key");
    const count = assert<number>(Versions.MOVES_COUNT, "battle_moves_extract: no MOVES_COUNT key");
    const rows: Record<number, BattleMoveRow> = {};
    for (let id = 0; id <= count - 1; id++) {
      const off = base + id * stride;
      const buf: number[] = [];
      for (let i = 0; i <= 8; i++) buf[i] = rom.get(off + i);
      rows[id] = BattleMovesExtract.decodeRow(buf, 0);
    }
    return { version: BattleMovesExtract.FORMAT_VERSION, base, stride, count, moves: rows };
  },

  // Lua: battle_moves_extract.lua:68
  packToLua(pack: BattleMovesPack): string {
    const lines = [
      "-- Auto-generated FRLG gBattleMoves (internal move id).",
      "-- effect/power/type/accuracy/pp/secondaryChance/target/priority/flags",
      "return {",
      format("  version = %d,", pack.version || 1),
      format("  count = %d,", pack.count || 0),
      "  moves = {",
    ];
    for (let id = 0; id <= (pack.count || 0) - 1; id++) {
      const m = pack.moves[id];
      if (m) {
        lines.push(format(
          "    [%d] = { effect=%d, power=%d, type=%d, accuracy=%d, pp=%d, secondaryChance=%d, target=%d, priority=%d, flags=%d },",
          id, m.effect, m.power, m.type, m.accuracy, m.pp,
          m.secondaryChance, m.target, m.priority, m.flags));
      }
    }
    lines.push("  },");
    lines.push("}");
    lines.push("");
    return lines.join("\n");
  },

  // Lua: battle_moves_extract.lua:93 -- via the cache object, else CacheFs.
  // NOT FAITHFUL: the love.filesystem / io.open fallbacks are dropped (the
  // importer has no file system of its own; the cache is the only sink).
  writeCache(pack: BattleMovesPack, cacheOrDir: Cache | string | undefined, opts: { cacheRoot?: string } = {}): string {
    const body = BattleMovesExtract.packToLua(pack);
    const root = (opts.cacheRoot ?? default_cache_root()) + "/" + BattleMovesExtract.CACHE_SUB;
    const rel = root + "/battle_moves.lua";
    if (typeof cacheOrDir === "object" && cacheOrDir && typeof cacheOrDir.write === "function") {
      cacheOrDir.write(rel, body);
      return rel;
    }
    try { CacheFs.write(rel, body); return rel; } catch { /* fall through */ }
    const outDir = (typeof cacheOrDir === "string" && cacheOrDir) || root;
    return outDir + "/battle_moves.lua";
  },

  // Lua: battle_moves_extract.lua:125
  run(rom: Rom, cache: Cache, opts: { cacheRoot?: string } = {}): { pack: BattleMovesPack; path: string } {
    const pack = BattleMovesExtract.extract(rom, opts);
    const path = BattleMovesExtract.writeCache(pack, cache, opts);
    return { pack, path };
  },

  // Lua: battle_moves_extract.lua:132
  ready(cache: Cache | undefined, cacheRoot?: string): boolean {
    const root = (cacheRoot ?? default_cache_root()) + "/pokemon/battle_moves.lua";
    if (cache && cache.exists && cache.exists(root)) return true;
    if (cache && cache.read && cache.read(root) !== undefined) return true;
    return false;
  },
};

export default BattleMovesExtract;
