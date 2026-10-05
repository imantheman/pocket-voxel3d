// Port of gen1recomp src/import/gba/items_extract.lua (GPLv3 + additional terms; see LICENSE.md).
// Extract FRLG item table from ROM (gItems) into data/generated/gba/items/pack.lua.
// Pure ROM reader: 0 external pret / python dependencies.
// The item effect byte list (the Lua's 1-based table) is a 0-based array here.

import { Versions } from "./versions.ts";
import { TextIR } from "../../game/gen3/core/scripting/text_ir.ts";
import { Layouts } from "./layouts.ts";
import { CacheFs, type Cache } from "./cache.ts";
import { format, tostring } from "./lua.ts";
import type { Rom } from "./rom.ts";

// Lua: items_extract.lua:14 (extract_island1's CACHE_ROOT; callers pass cacheRoot)
function default_cache_root(): string {
  return "data/generated/gba";
}

// Lua: items_extract.lua:22
function get_byte(rom: Rom, off: number): number {
  return rom.get(off);
}

// Lua: items_extract.lua:31
function get_u16(rom: Rom, off: number): number {
  return rom.u16(off);
}

// Lua: items_extract.lua:38
function get_u32(rom: Rom, off: number): number {
  return rom.u32(off);
}

function charmapAt(b: number): string | undefined {
  return Object.prototype.hasOwnProperty.call(TextIR.CHARMAP, b) ? TextIR.CHARMAP[b] : undefined;
}

// Lua: items_extract.lua:48
function decode_name(rom: Rom, off: number, maxLen = 14): string {
  let out = "";
  const extra = TextIR.dialect().CHARMAP_EXTRA;
  for (let i = 0; i <= maxLen - 1; i++) {
    const b = get_byte(rom, off + i);
    if (b === 0xff) break;
    const ch = charmapAt(b);
    if (ch !== undefined) out += ch;
    else if (extra && extra[b] !== undefined) out += extra[b]; // pokeemerald/charmap.txt:45
    else if (b >= 0xbb && b <= 0xd4) out += String.fromCharCode(65 + (b - 0xbb));
    else if (b >= 0xd5 && b <= 0xee) out += String.fromCharCode(97 + (b - 0xd5));
  }
  return out;
}

// Lua: items_extract.lua:69
function decode_text(rom: Rom, gbaPtr: number | undefined, maxLen = 256): string {
  if (gbaPtr === undefined || gbaPtr < 0x08000000 || gbaPtr >= 0x0a000000) return "";
  const off = gbaPtr - 0x08000000;
  let out = "";
  const extra = TextIR.dialect().CHARMAP_EXTRA;
  for (let i = 0; i <= maxLen - 1; i++) {
    const b = get_byte(rom, off + i);
    if (b === 0xff) break;
    const ch = charmapAt(b);
    if (b === 0xfe || b === 0xfa || b === 0xfb) out += "\n";
    else if (ch !== undefined) out += ch;
    else if (extra && extra[b] !== undefined) out += extra[b]; // pokeemerald/charmap.txt:45
    else if (b >= 0xbb && b <= 0xd4) out += String.fromCharCode(65 + (b - 0xbb));
    else if (b >= 0xd5 && b <= 0xee) out += String.fromCharCode(97 + (b - 0xd5));
  }
  return out;
}

// Lua: items_extract.lua:96
function escape_lua(s: unknown): string {
  return tostring(s ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

// Lua: items_extract.lua:100
function popcount(v: number): number {
  let n = 0;
  while (v > 0) {
    n += v % 2;
    v = Math.floor(v / 2);
  }
  return n;
}

// Lua: items_extract.lua:110 (src/data/pokemon/item_effects.h:338, src/pokemon.c:4202)
function read_effect(rom: Rom, id: number): number[] | undefined {
  if (id < Versions.ITEM_EFFECT_FIRST || id > Versions.ITEM_EFFECT_LAST) return undefined;
  const ptr = get_u32(rom, Versions.ITEM_EFFECT_TABLE + (id - Versions.ITEM_EFFECT_FIRST) * 4);
  if (ptr < 0x08000000 || ptr >= 0x0a000000) return undefined;
  const off = ptr - 0x08000000;
  const e4 = get_byte(rom, off + 4), e5 = get_byte(rom, off + 5);
  const len = 6 + popcount(e4 % 8) + (Math.floor(e4 / 8) % 4 !== 0 ? 1 : 0)
    + popcount(e5 % 16) + popcount(Math.floor(e5 / 32));
  const out: number[] = [];
  for (let i = 1; i <= len; i++) out[i - 1] = get_byte(rom, off + i - 1);
  return out;
}

// Lua: items_extract.lua:124 (src/item_use.c:409); effect 0-based (Lua effect[4] = effect[3])
function medicine_kind(effect: number[] | undefined): string {
  if (!effect) return "heal";
  const e3 = effect[3]!, e4 = effect[4]!, e5 = effect[5]!;
  if (Math.floor(e4 / 64) % 2 === 1) return "revive";
  if (e4 % 4 !== 0 || e5 % 16 !== 0) return "vitamin";
  if (Math.floor(e4 / 4) % 2 === 1) return "heal";
  if (e3 % 64 !== 0 || effect[0]! >= 0x80) return "status";
  return "heal";
}

// Lua: items_extract.lua:134
function determine_field_use(pocket: string, battleUsage: number, fieldUseFunc: number, effect: number[] | undefined): string {
  if (pocket === "KEY_ITEMS") return "key";
  if (pocket === "TM_CASE" || pocket === "TM_HM") return "tm";
  if (pocket === "POKE_BALLS") return "battle";
  const F = Versions.FIELD_USE_FUNCS;
  const fn = fieldUseFunc - 0x08000001;
  if (fn === F.medicine || (F.reduce_ev !== undefined && fn === F.reduce_ev)) return medicine_kind(effect);
  if (fn === F.ether || fn === F.pp_up) return "pp";
  if (fn === F.rare_candy) return "level";
  if (fn === F.evo_item) return "evo";
  if (fn === F.sacred_ash) return "revive";
  if (fn === F.repel) return "repel";
  if (fn === F.escape_rope) return "escape";
  if (fn === F.black_white_flute) return "black_white_flute";
  if ((battleUsage ?? 0) > 0) return "battle";
  return "none";
}

export interface ItemsResult { ok: boolean; count: number; path: string; skipped?: boolean }

export const ItemsExtract = {
  CACHE_SUB: "items",
  FORMAT_VERSION: 1,
  REQUIRED: ["items/pack.lua"],

  // Lua: items_extract.lua:152
  // NOT FAITHFUL: the Lua's love.filesystem / io.open fallbacks are not ported
  // (the cache and CacheFs are the only stores here).
  ready(cache: Cache | undefined, cacheRoot?: string): boolean {
    const root = (cacheRoot ?? default_cache_root()) + "/" + ItemsExtract.CACHE_SUB;
    const needRel = root + "/pack.lua";
    if (cache && cache.exists && cache.exists(needRel)) return true;
    try {
      if (CacheFs.exists(needRel)) return true;
    } catch { /* no cache bound */ }
    return false;
  },

  // Lua: items_extract.lua:173
  run(rom: Rom, cache: Cache | undefined, opts: { cacheRoot?: string; force?: boolean } = {}): ItemsResult {
    const cacheRoot = opts.cacheRoot ?? default_cache_root();
    const outRel = cacheRoot + "/" + ItemsExtract.CACHE_SUB + "/pack.lua";

    if (!opts.force && ItemsExtract.ready(cache, cacheRoot)) {
      return { ok: true, count: Versions.ITEMS_COUNT, path: outRel, skipped: true };
    }

    const itemBase = Versions.ITEMS;
    if (itemBase === undefined) throw new Error("items_extract: no ITEMS key");
    const itemCount: number = Versions.ITEMS_COUNT;
    if (itemCount === undefined) throw new Error("items_extract: no ITEMS_COUNT key");
    const itemStride: number = Versions.ITEM_STRIDE;
    if (itemStride === undefined) throw new Error("items_extract: no ITEM_STRIDE key");
    const layout = Layouts.active();
    const pocketNames = Layouts.pockets(layout);
    // rawget(Versions.module(), "SYMS"): the FRLG table has none (RSE only).
    const syms = Object.prototype.hasOwnProperty.call(Versions.module(), "SYMS") ? Versions.module().SYMS : undefined;

    const lines: string[] = [
      "-- Auto-generated from GBA ROM gItems table. DO NOT EDIT DIRECTLY.",
      "return {",
      "  version = 1,",
      format("  count = %d,", itemCount),
      "  items = {",
    ];

    for (let id = 0; id <= itemCount - 1; id++) {
      const off = itemBase + id * itemStride;
      const name = decode_name(rom, off, 14);
      const itemId = get_u16(rom, off + 14);
      const price = get_u16(rom, off + 16);
      const holdEffect = get_byte(rom, off + 18);
      const holdEffectParam = get_byte(rom, off + 19);
      const descPtr = get_u32(rom, off + 20);
      const importance = get_byte(rom, off + 24);
      const registrability = get_byte(rom, off + 25);
      const pocketId = get_byte(rom, off + 26);
      const itemType = get_byte(rom, off + 27);
      const fieldUseFunc = get_u32(rom, off + 28);
      const battleUsage = get_byte(rom, off + 32);
      const battleUseFunc = get_u32(rom, off + 36);
      const secondaryId = get_byte(rom, off + 40);

      const desc = decode_text(rom, descPtr, 256);
      const pocket = pocketNames[pocketId] ?? "ITEMS";
      const effect = read_effect(rom, id);
      const fieldUse = determine_field_use(pocket, battleUsage, fieldUseFunc, effect);

      lines.push(format(
        '    [%d] = { name="%s", pocket="%s", fieldUse="%s", price=%d, '
        + "holdEffect=%d, holdEffectParam=%d, importance=%d, registrability=%d, "
        + "battleUsage=%d, secondaryId=%d, itemId=%d, itemType=%d, "
        + 'fieldUseFunc=%d, battleUseFunc=%d, effect=%s, description="%s" },',
        id,
        escape_lua(name !== "" ? name : "????????"),
        pocket,
        fieldUse,
        price,
        holdEffect,
        holdEffectParam,
        importance,
        registrability,
        battleUsage,
        secondaryId,
        itemId,
        itemType,
        fieldUseFunc,
        battleUseFunc,
        effect ? "{" + effect.join(",") + "}" : "nil",
        escape_lua(desc),
      ));
      if (syms) {
        const fieldName = fieldUseFunc !== 0 ? syms.funcAt(fieldUseFunc) : undefined;
        const battleName = battleUseFunc !== 0 ? syms.funcAt(battleUseFunc) : undefined;
        const last = lines[lines.length - 1]!;
        lines[lines.length - 1] = last.slice(0, -3) + format(
          ", pocketId=%d, fieldUseName=%s, battleUseName=%s },",
          pocketId,
          fieldName ? '"' + fieldName + '"' : "nil",
          battleName ? '"' + battleName + '"' : "nil");
      }
    }

    lines.push("  },");
    lines.push("}");
    lines.push("");

    const outputText = lines.join("\n");

    let wrote = false;
    if (cache && cache.write) {
      cache.write(outRel, outputText);
      wrote = true;
    }
    if (!wrote) {
      try {
        CacheFs.write(outRel, outputText);
        wrote = true;
      } catch { /* the Lua pcall()s it */ }
    }

    return { ok: true, count: itemCount, path: outRel };
  },
};

export default ItemsExtract;
