// Port of gen1recomp src/import/gba/pokemon_extract.lua (GPLv3 + additional terms; see LICENSE.md).
// Extract FRLG species pack from ROM into data/generated/gba/pokemon/.
// FireRed USA 1.0: names, types, base stats, abilities, national dex, icons.
// Also runs party_chrome_extract into pokemon/party/ (and the other chrome
// extractors, in the Lua's order).
// Lua differences: decompressed tiles and palettes are byte strings (as the
// Lua's decompressString) or 0-based Uint8Arrays; the Lua's 1-based pixel
// index tables are 0-based arrays; per-id tables (names, stats, ...) are
// objects keyed by id as the Lua keys them; per-species lists are arrays.
// The Lua's FFI fast paths and its plain-Lua fallbacks compute the same bytes;
// one path is ported.

import { Versions } from "./versions.ts";
import { TextIR } from "../../game/gen3/core/scripting/text_ir.ts";
import { Lz77 } from "./lz77.ts";
import { Constants } from "../../game/gen3/core/constants.ts";
import { BattleMovesExtract } from "./battle_moves_extract.ts";
import { PartyChromeExtract } from "./party_chrome_extract.ts";
import { BattleChromeExtract } from "./battle_chrome_extract.ts";
import { BallOpenExtract } from "./ball_open_extract.ts";
import { PokedexChromeExtract } from "./pokedex_chrome_extract.ts";
import { StorageChromeExtract } from "./storage_chrome_extract.ts";
import { BattleTransitionExtract } from "./battle_transition_extract.ts";
import { SummaryChromeExtract } from "./summary_chrome_extract.ts";
import { BagChromeExtract } from "./bag_chrome_extract.ts";
import { ShopChromeExtract } from "./shop_chrome_extract.ts";
import { TextChromeExtract } from "./text_chrome_extract.ts";
import { ItemsExtract } from "./items_extract.ts";
import { TrainerCardExtract } from "./trainer_card_extract.ts";
import { TmCaseExtract } from "./tm_case_extract.ts";
import { BerryPouchExtract } from "./berry_pouch_extract.ts";
import { EasyChatExtract } from "./easy_chat_extract.ts";
import { CacheFs, type Cache } from "./cache.ts";
import { format, fromBytes, rep, tonumber, tostring } from "./lua.ts";
import type { Rom } from "./rom.ts";

type Bytes = string | ArrayLike<number>;
type Progress = (name: string, cur: number, total: number) => void;
type IconPal = Record<number, number>;
export interface Stats { hp: number; atk: number; def: number; spe: number; spa: number; spd: number }
export interface LearnsetEntry { move: number; level: number }
export interface EvoEntry { method: number; param: number; target: number }
export interface SpeciesMeta {
  catchRate: number; expYield: number; evHp: number; evAtk: number; evDef: number; evSpe: number; evSpa: number; evSpd: number;
  itemCommon: number; itemRare: number; genderRatio: number; eggCycles: number; friendship: number; growthRate: number;
  eggGroup1: number; eggGroup2: number; safariZoneFleeRate: number; linkStats?: number[];
}
export interface PokemonRunOpts {
  cacheRoot?: string; numSpecies?: number; spMin?: number; spMax?: number; onlySpeciesGfx?: boolean;
  progress?: Progress; part?: string;
}

// Lua: pokemon_extract.lua:15 (extract_island1's CACHE_ROOT; callers pass cacheRoot)
function default_cache_root(): string {
  return "data/generated/gba";
}

// Lua: pokemon_extract.lua:23
function put(cache: Cache, rel: string, bytes: string | Uint8Array): boolean {
  const ok = cache.write(rel, bytes);
  if (ok === false) throw new Error("pokemon_extract: could not write " + rel + ": nil");
  return true;
}

// Lua: pokemon_extract.lua:31
function bgr555_to_rgb8(c: unknown): [number, number, number] {
  const n = (tonumber(c) ?? 0) % 32768;
  const r5 = n % 32, g5 = Math.floor(n / 32) % 32, b5 = Math.floor(n / 1024) % 32;
  return [Math.floor((r5 * 255) / 31 + 0.5), Math.floor((g5 * 255) / 31 + 0.5), Math.floor((b5 * 255) / 31 + 0.5)];
}

// Lua: pokemon_extract.lua:41
function need(key: string): any {
  const v = Versions[key];
  if (v === undefined || v === null) {
    throw new Error("pokemon_extract: Versions." + key + " is not set for " + tostring(Versions.active ? Versions.active() : undefined));
  }
  return v;
}

// Lua: pokemon_extract.lua:49
function species_id(name: string): number {
  return Constants.of(Versions.active ? Versions.active() : "firered").require("species", name);
}

// Lua: pokemon_extract.lua:54
function pic_table(key: string, introKey: string): number {
  const v = Versions[key] ?? (Versions.INTRO ? Versions.INTRO[introKey] : undefined);
  if (v === undefined || v === null) {
    throw new Error("pokemon_extract: Versions." + key + " is not set for " + tostring(Versions.active ? Versions.active() : undefined));
  }
  return v;
}

// Lua: pokemon_extract.lua:62
function gba_off(ptr: number): number | undefined {
  return Versions.gbaToFile(ptr);
}

function charmapAt(b: number): string | undefined {
  return Object.prototype.hasOwnProperty.call(TextIR.CHARMAP, b) ? TextIR.CHARMAP[b] : undefined;
}

// Lua: pokemon_extract.lua:66
function decode_name(rom: Rom, off: number, length?: number): string {
  length = length ?? Versions.SPECIES_NAME_LENGTH;
  let out = "";
  for (let i = 0; i <= length! - 1; i++) {
    const b = rom.get(off + i);
    // GBA charmap: 0x00 is space; only 0xFF is EOS.
    if (b === 0xff) break;
    const ch = charmapAt(b);
    if (ch !== undefined && ch !== "") out += ch;
    else if (b >= 0xbb && b <= 0xd4) out += String.fromCharCode(65 + (b - 0xbb));
    else if (b >= 0xd5 && b <= 0xee) out += String.fromCharCode(97 + (b - 0xd5));
    else out += "?";
  }
  return out;
}

// Lua: pokemon_extract.lua:87
function decode_text(rom: Rom, off: number, max = 256): string {
  let out = "";
  for (let i = 0; i <= max - 1; i++) {
    const b = rom.get(off + i);
    if (b === 0xff) break;
    if (b === 0xfe || b === 0xfa || b === 0xfb) out += "\n";
    else {
      const ch = charmapAt(b);
      if (ch !== undefined && ch !== "") out += ch;
      else if (b >= 0xbb && b <= 0xd4) out += String.fromCharCode(65 + (b - 0xbb));
      else if (b >= 0xd5 && b <= 0xee) out += String.fromCharCode(97 + (b - 0xd5));
      else out += "?";
    }
  }
  return out;
}

const byteAt = (b: Bytes, i: number): number =>
  typeof b === "string" ? (i < b.length ? b.charCodeAt(i) : 0) : (b[i] ?? 0);
const lenOf = (b: Bytes): number => b.length;

// Lua: pokemon_extract.lua:137 -- GBA 4bpp tiles -> flat index buffer (w*h, 0-based here)
function decode_4bpp(bytes: Bytes, w: number, h: number): number[] {
  const tilesW = w >>> 3, tilesH = h >>> 3;
  const pixels: number[] = new Array(w * h);
  let ti = 0;
  for (let ty = 0; ty <= tilesH - 1; ty++) {
    for (let tx = 0; tx <= tilesW - 1; tx++) {
      const tileOff = ti * 32; // 32 bytes / 4bpp tile
      for (let row = 0; row <= 7; row++) {
        for (let bx = 0; bx <= 3; bx++) {
          const bi = tileOff + row * 4 + bx;
          const byte = bi < lenOf(bytes) ? byteAt(bytes, bi) : 0;
          const x0 = tx * 8 + bx * 2, y0 = ty * 8 + row;
          pixels[y0 * w + x0] = byte & 0x0f;
          pixels[y0 * w + x0 + 1] = byte >>> 4;
        }
      }
      ti++;
    }
  }
  return pixels;
}

// Lua: pokemon_extract.lua:182 -- palettes keyed 0.., colours keyed 0..15
function load_icon_pals(rom: Rom): Record<number, IconPal> {
  const base = Versions.MON_ICON_PALETTES;
  const pals: Record<number, IconPal> = {};
  for (let i = 0; i <= Versions.MON_ICON_PAL_COUNT - 1; i++) {
    const colors: IconPal = {};
    const off = base + i * 32; // 16 x u16
    for (let c = 0; c <= 15; c++) colors[c] = rom.u16(off + c * 2);
    pals[i] = colors;
  }
  return pals;
}

// Lua: pokemon_extract.lua:196
function bake_icon_rgba(pixels: number[], pal: IconPal, w: number, h: number): string {
  const rgb: [number, number, number][] = [];
  for (let c = 0; c <= 15; c++) rgb[c] = bgr555_to_rgb8(pal[c] ?? 0);
  const total = w * h;
  const out = new Uint8Array(total * 4);
  for (let i = 0; i < total; i++) {
    const idx = pixels[i] ?? 0;
    if (idx !== 0) {
      const c = rgb[idx] ?? rgb[0]!;
      out[i * 4] = c[0]; out[i * 4 + 1] = c[1]; out[i * 4 + 2] = c[2]; out[i * 4 + 3] = 255;
    }
  }
  return fromBytes(out);
}

// Lua: pokemon_extract.lua:239 -- one 64x64 frame of a pic sheet
function decode_pic_sheet(tiles: Bytes | undefined, palBytes: Bytes | undefined, frame?: number, bank?: number): string | undefined {
  if (tiles === undefined || palBytes === undefined) return undefined;
  const palBase = (tonumber(bank) ?? 0) * 32;
  const tileBase = (tonumber(frame) ?? 0) * 2048;
  const pal: number[] = [];
  const palLen = lenOf(palBytes), tilesLen = lenOf(tiles);
  for (let c = 0; c <= 15; c++) {
    const idx = palBase + c * 2;
    const lo = idx < palLen ? byteAt(palBytes, idx) : 0;
    const hi = idx + 1 < palLen ? byteAt(palBytes, idx + 1) : 0;
    pal[c] = lo + hi * 256;
  }
  const w = 64;
  const rgb: [number, number, number][] = [];
  for (let c = 0; c <= 15; c++) rgb[c] = bgr555_to_rgb8(pal[c] ?? 0);
  const out = new Uint8Array(64 * 64 * 4);
  let ti = 0;
  for (let ty = 0; ty <= 7; ty++) {
    for (let tx = 0; tx <= 7; tx++) {
      const tileOff = ti * 32;
      for (let row = 0; row <= 7; row++) {
        for (let bx = 0; bx <= 3; bx++) {
          const bi = tileBase + tileOff + row * 4 + bx;
          const byte = bi < tilesLen ? byteAt(tiles, bi) : 0;
          const p0 = byte & 0x0f, p1 = byte >>> 4;
          const x0 = tx * 8 + bx * 2, y0 = ty * 8 + row;
          const o0 = (y0 * w + x0) * 4;
          if (p0 !== 0) { const c = rgb[p0] ?? rgb[0]!; out[o0] = c[0]; out[o0 + 1] = c[1]; out[o0 + 2] = c[2]; out[o0 + 3] = 255; }
          const o1 = (y0 * w + x0 + 1) * 4;
          if (p1 !== 0) { const c = rgb[p1] ?? rgb[0]!; out[o1] = c[0]; out[o1 + 1] = c[1]; out[o1 + 2] = c[2]; out[o1 + 3] = 255; }
        }
      }
      ti++;
    }
  }
  return fromBytes(out);
}

// Lua: pokemon_extract.lua:369
function lua_escape(s: unknown): string {
  return tostring(s ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

const sortedIds = (t: object): number[] => Object.keys(t).map(Number).sort((a, b) => a - b);

/** Lua's #t for a table filled from key 0 or 1 upward (the border from 1). */
function border(t: Record<number, unknown>): number {
  let n = 0;
  while (t[n + 1] !== undefined && t[n + 1] !== null) n++;
  return n;
}

// Lua: pokemon_extract.lua:373
function write_names_lua(names: Record<number, string>): string {
  const lines = [
    "-- Auto-generated FRLG gSpeciesNames (internal SPECIES id).",
    "return {",
  ];
  for (let id = 0; id <= border(names); id++) {
    const n = names[id];
    if (n !== undefined && n !== "") lines.push(format('  [%d] = "%s",', id, lua_escape(n)));
  }
  lines.push("}");
  lines.push("");
  return lines.join("\n");
}

// Lua: pokemon_extract.lua:389
function write_types_lua(types: Record<number, number[]>): string {
  const lines = [
    "-- Auto-generated FRLG BaseStats type1/type2 (internal SPECIES id).",
    "return {",
  ];
  for (const id of sortedIds(types)) {
    const t = types[id]!;
    lines.push(format("  [%d] = { %d, %d },", id, t[0] ?? 0, t[1] ?? 0));
  }
  lines.push("}");
  lines.push("");
  return lines.join("\n");
}

// Lua: pokemon_extract.lua:409
function write_national_lua(toNat: Record<number, number>): string {
  const lines = [
    "-- Auto-generated sSpeciesToNationalPokedexNum (+ reverse).",
    "local M = { toNational = {}, toSpecies = {} }",
  ];
  for (const sp of sortedIds(toNat)) {
    const nat = toNat[sp]!;
    if (nat && nat > 0) {
      lines.push(format("M.toNational[%d] = %d", sp, nat));
      lines.push(format("M.toSpecies[%d] = %d", nat, sp));
    }
  }
  lines.push("return M");
  lines.push("");
  return lines.join("\n");
}

// Lua: pokemon_extract.lua:431
function write_stats_lua(stats: Record<number, Stats>): string {
  const lines = [
    "-- Auto-generated FRLG BaseStats (hp/atk/def/spe/spa/spd).",
    "return {",
  ];
  for (const id of sortedIds(stats)) {
    const s = stats[id]!;
    lines.push(format(
      "  [%d] = { hp = %d, atk = %d, def = %d, spe = %d, spa = %d, spd = %d },",
      id, s.hp ?? 0, s.atk ?? 0, s.def ?? 0, s.spe ?? 0, s.spa ?? 0, s.spd ?? 0));
  }
  lines.push("}");
  lines.push("");
  return lines.join("\n");
}

// Lua: pokemon_extract.lua:452
function write_abilities_lua(abilities: Record<number, number[]>): string {
  const lines = [
    "-- Auto-generated FRLG BaseStats abilities[2] (ability ids).",
    "return {",
  ];
  for (const id of sortedIds(abilities)) {
    const a = abilities[id]!;
    lines.push(format("  [%d] = { %d, %d },", id, a[0] ?? 0, a[1] ?? 0));
  }
  lines.push("}");
  lines.push("");
  return lines.join("\n");
}

// Lua: pokemon_extract.lua:472
function write_ability_names_lua(names: Record<number, string>): string {
  const lines = [
    "-- Auto-generated FRLG gAbilityNames.",
    "return {",
  ];
  for (let id = 0; id <= border(names); id++) {
    const n = names[id];
    if (n !== undefined && n !== "") lines.push(format('  [%d] = "%s",', id, lua_escape(n)));
  }
  lines.push("}");
  lines.push("");
  return lines.join("\n");
}

// Lua: pokemon_extract.lua:488
function write_species_meta_lua(meta: Record<number, SpeciesMeta>): string {
  const lines = [
    "-- Auto-generated FRLG BaseStats catch/exp/gender/growth/egg extras.",
    "return {",
  ];
  for (const id of sortedIds(meta)) {
    const m = meta[id]!;
    let link = "";
    if (Array.isArray(m.linkStats)) {
      const ls = m.linkStats;
      link = format(", linkStats = { %d, %d, %d, %d, %d, %d }", ls[0], ls[1], ls[2], ls[3], ls[4], ls[5]);
    }
    lines.push(format(
      "  [%d] = { catchRate = %d, expYield = %d, genderRatio = %d, eggCycles = %d, friendship = %d, growthRate = %d, eggGroup1 = %d, eggGroup2 = %d, itemCommon = %d, itemRare = %d, evHp = %d, evAtk = %d, evDef = %d, evSpe = %d, evSpa = %d, evSpd = %d, safariZoneFleeRate = %d%s },",
      id,
      m.catchRate ?? 0, m.expYield ?? 0, m.genderRatio ?? 0,
      m.eggCycles ?? 0, m.friendship ?? 0, m.growthRate ?? 0,
      m.eggGroup1 ?? 0, m.eggGroup2 ?? 0,
      m.itemCommon ?? 0, m.itemRare ?? 0,
      m.evHp ?? 0, m.evAtk ?? 0, m.evDef ?? 0,
      m.evSpe ?? 0, m.evSpa ?? 0, m.evSpd ?? 0,
      m.safariZoneFleeRate ?? 0, link));
  }
  lines.push("}");
  lines.push("");
  return lines.join("\n");
}

// Lua: pokemon_extract.lua:522
function write_manifest(count: number, version?: number): string {
  return format(
    'return { magic = "%s", format = %d, pokemonVersion = %d, numSpecies = %d, iconW = %d, iconH = %d, iconSheetH = %d, iconFrames = %d, abilitiesCount = %d, movesCount = %d }\n',
    PokemonExtract.MAGIC,
    PokemonExtract.FORMAT_VERSION,
    version ?? need("POKEMON_VERSION"),
    count,
    need("MON_ICON_W"),
    need("MON_ICON_H"),
    64,
    2,
    need("ABILITIES_COUNT"),
    need("MOVES_COUNT"));
}

// Lua: pokemon_extract.lua:537
function write_move_names_lua(names: Record<number, string>): string {
  const lines = [
    "-- Auto-generated FRLG gMoveNames.",
    "return {",
  ];
  const count: number = need("MOVES_COUNT");
  for (let id = 0; id <= count - 1; id++) {
    const n = names[id];
    if (n !== undefined && n !== "") lines.push(format('  [%d] = "%s",', id, lua_escape(n)));
  }
  lines.push("}");
  lines.push("");
  return lines.join("\n");
}

// Lua: pokemon_extract.lua:554
function write_learnsets_lua(learnsets: Record<number, LearnsetEntry[]>): string {
  const lines = [
    "-- Auto-generated FRLG gLevelUpLearnsets (packed level/move).",
    "return {",
  ];
  for (const id of sortedIds(learnsets)) {
    const list = learnsets[id] ?? [];
    const parts = list.map((e) => format("{%d,%d}", e.level ?? 0, e.move ?? 0));
    lines.push(format("  [%d] = { %s },", id, parts.join(", ")));
  }
  lines.push("}");
  lines.push("");
  return lines.join("\n");
}

// Lua: pokemon_extract.lua:577
function write_egg_moves_lua(eggMoves: Record<number, number[]>): string {
  const lines = [
    "-- Auto-generated FRLG gEggMoves: [species] = { move ids }.",
    "return {",
  ];
  for (const id of sortedIds(eggMoves)) {
    const list = eggMoves[id] ?? [];
    if (list.length > 0) lines.push(format("  [%d] = { %s },", id, list.join(", ")));
  }
  lines.push("}");
  lines.push("");
  return lines.join("\n");
}

// Lua: pokemon_extract.lua:599
function write_evolutions_lua(evos: Record<number, EvoEntry[]>): string {
  const lines = [
    "-- Auto-generated FRLG gEvolutionTable (method, param, targetSpecies).",
    "return {",
  ];
  for (const id of sortedIds(evos)) {
    const list = evos[id] ?? [];
    if (list.length > 0) {
      const parts = list.map((e) => format("{method=%d,param=%d,target=%d}", e.method ?? 0, e.param ?? 0, e.target ?? 0));
      lines.push(format("  [%d] = { %s },", id, parts.join(", ")));
    }
  }
  lines.push("}");
  lines.push("");
  return lines.join("\n");
}

// Lua: pokemon_extract.lua:626
function write_tmhm_lua(tmhm: Record<number, { lo: number; hi: number }>, tmMoves: Record<number, number>): string {
  const lines = [
    "-- Auto-generated FRLG sTMHMLearnsets + sTMHMMoves.",
    "local M = { machines = {}, learnsets = {} }",
  ];
  for (let i = 0; i <= need("TMHM_COUNT") - 1; i++) lines.push(format("M.machines[%d] = %d", i, tmMoves[i] ?? 0));
  for (const id of sortedIds(tmhm)) {
    const bits = tmhm[id];
    if (bits && (bits.lo !== 0 || bits.hi !== 0)) {
      lines.push(format("M.learnsets[%d] = { lo = %u, hi = %u }", id, bits.lo ?? 0, bits.hi ?? 0));
    }
  }
  lines.push("return M");
  lines.push("");
  return lines.join("\n");
}

// Lua: pokemon_extract.lua:652
function write_dex_lua(dex: Record<number, { category: string; height: number; weight: number }>): string {
  const lines = [
    "-- Auto-generated FRLG gPokedexEntries (national index): category/height/weight.",
    "return {",
  ];
  for (const id of sortedIds(dex)) {
    const e = dex[id]!;
    lines.push(format('  [%d] = { category = "%s", height = %d, weight = %d },',
      id, lua_escape(e.category ?? ""), e.height ?? 0, e.weight ?? 0));
  }
  lines.push("}");
  lines.push("");
  return lines.join("\n");
}

/**
 * Lua: pokemon_extract.lua:680 -- decode gEggMoves into { [species]: [moveId, ...] }.
 *
 * Not a pointer table: one flat u16 stream of runs, each opened by
 * `species + EGG_MOVES_SPECIES_OFFSET` (a move id is always < 355, so the
 * offset is what tells a header from a move) and closed by 0xFFFF.  The table
 * stops after its last run, so the first word that is neither a header nor a
 * plausible move id ends the scan.  Species without egg moves are absent.
 */
function extract_egg_moves(rom: Rom, num: number): Record<number, number[]> {
  const eggMoves: Record<number, number[]> = {};
  const base: number = need("EGG_MOVES");
  const offset: number = need("EGG_MOVES_SPECIES_OFFSET");
  const terminator: number = need("EGG_MOVES_TERMINATOR");
  const maxMoves: number = need("EGG_MOVES_MAX");
  const moveCount: number = need("MOVES_COUNT");
  const limit = Math.min(rom.size ?? Versions.ROM_SIZE ?? base, base + 0x10000);
  let species: number | undefined;
  let o = base;
  while (o + 1 < limit) {
    const word = rom.u16(o);
    o += 2;
    if (word === terminator) {
      if (species === undefined) break; // the table's own terminator
      species = undefined;
    } else if (word >= offset) {
      const id = word - offset;
      species = id < num ? id : undefined;
      if (species !== undefined) eggMoves[species] = eggMoves[species] ?? [];
    } else if (species !== undefined && word > 0 && word < moveCount) {
      const list = eggMoves[species]!;
      if (list.length < maxMoves) list.push(word);
    } else {
      break; // not a gEggMoves stream: stop rather than invent data
    }
  }
  return eggMoves;
}

// Lua: pokemon_extract.lua:712 -- gMonIconTable / gMonIconPaletteIndices entry for
// one species, both frames (32x64 RGBA); they run past NUM_SPECIES, so
// SPECIES_EGG has its own icon.
function icon_rgba(rom: Rom, sp: number, pals?: Record<number, IconPal>, opts?: { byteOffset?: number }): string {
  pals = pals ?? load_icon_pals(rom);
  const w: number = need("MON_ICON_W");
  const iconH: number = need("MON_ICON_H") * 2; // 64 (2 frames)
  const iconBytes: number = need("MON_ICON_BYTES");
  const off = gba_off(rom.u32(need("MON_ICON_TABLE") + sp * 4) + (opts && opts.byteOffset ? opts.byteOffset : 0));
  // (the Lua's quirk: w * iconH * 4 copies of a 4-byte pixel)
  if (off === undefined) return rep("\x00\x00\x00\x00", w * iconH * 4);
  let palIdx = rom.get(Versions.MON_ICON_PAL_INDICES + sp) ?? 0;
  if (palIdx >= Versions.MON_ICON_PAL_COUNT) palIdx = 0;
  const pixels = decode_4bpp(rom.readBytes(off, iconBytes), w, iconH);
  return bake_icon_rgba(pixels, pals[palIdx] ?? pals[0]!, w, iconH);
}

// Lua: pokemon_extract.lua:731
function write_descriptions_lua(abils: Record<string, string>, mvs: Record<string, string>): string {
  const lines = [
    "-- Auto-generated FRLG Ability & Move Descriptions from ROM.",
    "return {",
    "  ABILITIES = {",
  ];
  const byteSort = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  for (const k of Object.keys(abils).sort(byteSort)) lines.push(format("    [%q] = %q,", k, abils[k]));
  lines.push("  },");
  lines.push("  MOVES = {");
  for (const k of Object.keys(mvs).sort(byteSort)) lines.push(format("    [%q] = %q,", k, mvs[k]));
  lines.push("  },");
  lines.push("}");
  lines.push("");
  return lines.join("\n");
}

// Lua: pokemon_extract.lua:757
function write_hoenn_lua(toHoenn: Record<number, number>): string {
  const lines = ["local M = { toHoenn = {}, toSpecies = {} }"];
  for (let sp = 1; sp <= border(toHoenn); sp++) {
    const n = toHoenn[sp];
    if (n && n > 0) {
      lines.push(format("M.toHoenn[%d] = %d", sp, n));
      lines.push(format("M.toSpecies[%d] = %d", n, sp));
    }
  }
  lines.push("return M");
  lines.push("");
  return lines.join("\n");
}

// Lua: pokemon_extract.lua:771 -- order 1-based (a 0-based array here)
function write_regional_dex_lua(region: string, count: number, order: number[]): string {
  const lines = [
    "return {",
    format("  region = %q,", region),
    format("  count = %d,", count),
    "  order = {",
  ];
  for (let i = 1; i <= order.length; i++) lines.push(format("    [%d] = %d,", i, order[i - 1]));
  lines.push("  },");
  lines.push("}");
  lines.push("");
  return lines.join("\n");
}

// Lua: pokemon_extract.lua:787
function write_type_names_lua(names: Record<number, string>): string {
  const lines = ["return {"];
  for (let id = 0; id <= border(names); id++) lines.push(format('  [%d] = "%s",', id, lua_escape(names[id] ?? "")));
  lines.push("}");
  lines.push("");
  return lines.join("\n");
}

// Lua: pokemon_extract.lua:797 -- rows keyed by rate, each a list of numbers as strings
function write_exp_table_lua(rows: Record<number, string[]>): string {
  const lines = ["return {"];
  for (let rate = 0; rate <= border(rows); rate++) lines.push(format("  [%d] = { [0] = %s },", rate, rows[rate]!.join(", ")));
  lines.push("}");
  lines.push("");
  return lines.join("\n");
}

/** The Lua's `"X_" .. name:upper():gsub("%s+", "_"):gsub("[^%w_]", "")`. */
function constName(prefix: string, name: string): string {
  return prefix + name.replace(/[a-z]+/g, (m) => m.toUpperCase()).replace(/[ \t\n\v\f\r]+/g, "_").replace(/[^A-Za-z0-9_]/g, "");
}

export interface PokemonData {
  names: Record<number, string>; types: Record<number, number[]>; stats: Record<number, Stats>;
  abilities: Record<number, number[]>; abilityNames: Record<number, string>; moveNames: Record<number, string>;
  learnsets: Record<number, LearnsetEntry[]>; eggMoves: Record<number, number[]>; evolutions: Record<number, EvoEntry[]>;
  toHoenn?: Record<number, number>; regionalOrder?: number[]; typeNames?: Record<number, string>;
  expTable?: Record<number, string[]>; root?: string; numSpecies?: number;
}

// Lua: pokemon_extract.lua:807
function extract_data(rom: Rom, cache: Cache, root: string, num: number, progress?: Progress): PokemonData {
  const names: Record<number, string> = {};
  const types: Record<number, number[]> = {};
  const stats: Record<number, Stats> = {};
  const abilities: Record<number, number[]> = {};
  const meta: Record<number, SpeciesMeta> = {};
  const toNat: Record<number, number> = {};
  const nameBase: number = need("SPECIES_NAMES");
  const nameLen: number = need("SPECIES_NAME_LENGTH");
  const infoBase: number = need("SPECIES_INFO");
  const infoSize: number = need("SPECIES_INFO_SIZE");
  const natBase: number = need("SPECIES_TO_NATIONAL");
  const deoxysStats: number | undefined = Versions.DEOXYS_BASE_STATS;
  const deoxys = deoxysStats !== undefined ? species_id("SPECIES_DEOXYS") : undefined;

  for (let sp = 0; sp <= num - 1; sp++) {
    names[sp] = decode_name(rom, nameBase + sp * nameLen);
    const ioff = infoBase + sp * infoSize;
    stats[sp] = {
      hp: rom.get(ioff + 0),
      atk: rom.get(ioff + 1),
      def: rom.get(ioff + 2),
      spe: rom.get(ioff + 3),
      spa: rom.get(ioff + 4),
      spd: rom.get(ioff + 5),
    };
    let linkStats: number[] | undefined;
    if (sp === deoxys) {
      const r = stats[sp]!;
      // pokefirered/src/pokemon.c:6163
      // pokeemerald/src/pokemon.c:2704
      linkStats = [r.hp, r.atk, r.def, r.spe, r.spa, r.spd];
      (["hp", "atk", "def", "spe", "spa", "spd"] as const).forEach((key, i) => {
        stats[sp]![key] = rom.u16(deoxysStats! + i * 2);
      });
    }
    types[sp] = [rom.get(ioff + 6), rom.get(ioff + 7)];
    abilities[sp] = [rom.get(ioff + 0x16), rom.get(ioff + 0x17)];
    const evLo = rom.get(ioff + 0x0a), evHi = rom.get(ioff + 0x0b);
    meta[sp] = {
      catchRate: rom.get(ioff + 0x08),
      expYield: rom.get(ioff + 0x09),
      evHp: evLo % 4,
      evAtk: Math.floor(evLo / 4) % 4,
      evDef: Math.floor(evLo / 16) % 4,
      evSpe: Math.floor(evLo / 64) % 4,
      evSpa: evHi % 4,
      evSpd: Math.floor(evHi / 4) % 4,
      itemCommon: rom.u16(ioff + 0x0c),
      itemRare: rom.u16(ioff + 0x0e),
      genderRatio: rom.get(ioff + 0x10),
      eggCycles: rom.get(ioff + 0x11),
      friendship: rom.get(ioff + 0x12),
      growthRate: rom.get(ioff + 0x13),
      eggGroup1: rom.get(ioff + 0x14),
      eggGroup2: rom.get(ioff + 0x15),
      safariZoneFleeRate: rom.get(ioff + 0x18),
      linkStats,
    };
    toNat[sp] = sp >= 1 ? rom.u16(natBase + (sp - 1) * 2) : 0;
  }

  const abilityNames: Record<number, string> = {};
  const abilBase: number = need("ABILITY_NAMES");
  const abilLen: number = need("ABILITY_NAME_LENGTH") + 1;
  const abilCount: number = need("ABILITIES_COUNT");
  for (let id = 0; id <= abilCount - 1; id++) abilityNames[id] = decode_name(rom, abilBase + id * abilLen, abilLen);

  const moveNames: Record<number, string> = {};
  const moveNameBase: number = need("MOVE_NAMES");
  const moveNameLen: number = need("MOVE_NAME_LENGTH") + 1;
  const moveCount: number = need("MOVES_COUNT");
  for (let id = 0; id <= moveCount - 1; id++) moveNames[id] = decode_name(rom, moveNameBase + id * moveNameLen, moveNameLen);

  const learnsets: Record<number, LearnsetEntry[]> = {};
  const learnPtrBase: number = need("LEVEL_UP_LEARNSETS");
  for (let sp = 0; sp <= num - 1; sp++) {
    if (progress && sp % 80 === 0) progress("learnsets", sp, num);
    const ptr = rom.u32(learnPtrBase + sp * 4);
    const off = gba_off(ptr);
    const list: LearnsetEntry[] = [];
    if (off !== undefined) {
      for (let i = 0; i <= 39; i++) {
        const word = rom.u16(off + i * 2);
        if (word === 0xffff) break;
        list.push({ move: word % 512, level: Math.floor(word / 512) % 128 });
      }
    }
    learnsets[sp] = list;
  }

  const evolutions: Record<number, EvoEntry[]> = {};
  const evoBase: number = need("EVOLUTION_TABLE");
  const evoPer: number = need("EVOS_PER_MON");
  const evoSize: number = need("EVOLUTION_ENTRY_SIZE");
  const evoStride = evoPer * evoSize;
  for (let sp = 0; sp <= num - 1; sp++) {
    const list: EvoEntry[] = [];
    const base = evoBase + sp * evoStride;
    for (let slot = 0; slot <= evoPer - 1; slot++) {
      const off = base + slot * evoSize;
      const method = rom.u16(off);
      if (method !== 0) list.push({ method, param: rom.u16(off + 2), target: rom.u16(off + 4) });
    }
    evolutions[sp] = list;
  }

  const tmhm: Record<number, { lo: number; hi: number }> = {};
  const tmMoves: Record<number, number> = {};
  const tmBase: number = need("TMHM_LEARNSETS");
  const tmMoveBase: number = need("TMHM_MOVES");
  const tmCount: number = need("TMHM_COUNT");
  for (let i = 0; i <= tmCount - 1; i++) tmMoves[i] = rom.u16(tmMoveBase + i * 2);
  for (let sp = 0; sp <= num - 1; sp++) {
    const off = tmBase + sp * 8;
    tmhm[sp] = { lo: rom.u32(off), hi: rom.u32(off + 4) };
  }

  const eggMoves = extract_egg_moves(rom, num);

  const dex: Record<number, { category: string; height: number; weight: number }> = {};
  const dexBase: number = need("POKEDEX_ENTRIES");
  const dexSize: number = need("POKEDEX_ENTRY_SIZE");
  const dexCount: number = need("NATIONAL_DEX_COUNT") + 1;
  for (let nat = 0; nat <= dexCount - 1; nat++) {
    const off = dexBase + nat * dexSize;
    dex[nat] = { category: decode_name(rom, off, 12), height: rom.u16(off + 0x0c), weight: rom.u16(off + 0x0e) };
  }

  const abilityDescs: Record<string, string> = {};
  const abilityDescBase: number = need("ABILITY_DESCRIPTIONS");
  for (let i = 0; i <= abilCount - 1; i++) {
    const ptr = rom.u32(abilityDescBase + i * 4);
    const off = gba_off(ptr);
    const name = abilityNames[i] ?? "ABILITY_" + i;
    const desc = off !== undefined ? decode_text(rom, off, 256) : "";
    abilityDescs[constName("ABILITY_", name)] = desc;
  }

  const moveDescs: Record<string, string> = {};
  const moveDescBase: number = need("MOVE_DESCRIPTIONS");
  for (let i = 0; i <= moveCount - 2; i++) {
    const ptr = rom.u32(moveDescBase + i * 4);
    const off = gba_off(ptr);
    const name = moveNames[i + 1] ?? "MOVE_" + (i + 1);
    const desc = off !== undefined ? decode_text(rom, off, 256) : "";
    moveDescs[constName("MOVE_", name)] = desc;
  }

  put(cache, root + "/names.lua", write_names_lua(names));
  put(cache, root + "/types.lua", write_types_lua(types));
  put(cache, root + "/stats.lua", write_stats_lua(stats));
  put(cache, root + "/abilities.lua", write_abilities_lua(abilities));
  put(cache, root + "/ability_names.lua", write_ability_names_lua(abilityNames));
  put(cache, root + "/descriptions.lua", write_descriptions_lua(abilityDescs, moveDescs));
  put(cache, root + "/meta.lua", write_species_meta_lua(meta));
  put(cache, root + "/national.lua", write_national_lua(toNat));
  put(cache, root + "/move_names.lua", write_move_names_lua(moveNames));
  put(cache, root + "/learnsets.lua", write_learnsets_lua(learnsets));
  put(cache, root + "/evolutions.lua", write_evolutions_lua(evolutions));
  put(cache, root + "/tmhm.lua", write_tmhm_lua(tmhm, tmMoves));
  put(cache, root + "/egg_moves.lua", write_egg_moves_lua(eggMoves));
  put(cache, root + "/dex.lua", write_dex_lua(dex));

  const out: PokemonData = { names, types, stats, abilities, abilityNames, moveNames, learnsets, eggMoves, evolutions };

  // pokeemerald/src/pokemon.c:5685
  if (Versions.SPECIES_TO_HOENN !== undefined) {
    const toHoenn: Record<number, number> = {};
    for (let sp = 1; sp <= num - 1; sp++) toHoenn[sp] = rom.u16(Versions.SPECIES_TO_HOENN + (sp - 1) * 2);
    put(cache, root + "/hoenn.lua", write_hoenn_lua(toHoenn));
    out.toHoenn = toHoenn;
  }
  // pokeemerald/src/pokemon.c:5693
  if (Versions.HOENN_TO_NATIONAL !== undefined) {
    const order: number[] = [];
    for (let i = 1; i <= num - 1; i++) {
      const nat = rom.u16(Versions.HOENN_TO_NATIONAL + (i - 1) * 2);
      if (nat === 0) break;
      order[i - 1] = nat;
    }
    const count = species_id("HOENN_DEX_COUNT");
    put(cache, root + "/regional_dex.lua", write_regional_dex_lua("hoenn", count, order));
    out.regionalOrder = order;
  }
  if (Versions.TYPE_NAMES !== undefined) {
    const typeNames: Record<number, string> = {};
    const stride = need("TYPE_NAME_LENGTH") + 1;
    for (let id = 0; id <= need("TYPE_COUNT") - 1; id++) typeNames[id] = decode_name(rom, Versions.TYPE_NAMES + id * stride, stride);
    put(cache, root + "/type_names.lua", write_type_names_lua(typeNames));
    out.typeNames = typeNames;
  }
  if (Versions.EXPERIENCE_TABLES !== undefined) {
    const rows: Record<number, string[]> = {};
    const levels: number = need("EXPERIENCE_LEVELS");
    for (let rate = 0; rate <= need("GROWTH_RATE_COUNT") - 1; rate++) {
      const row: string[] = [];
      for (let lv = 0; lv <= levels - 1; lv++) row[lv] = tostring(rom.u32(Versions.EXPERIENCE_TABLES + (rate * levels + lv) * 4));
      rows[rate] = row;
    }
    put(cache, root + "/exp_table.lua", write_exp_table_lua(rows));
    out.expTable = rows;
  }

  put(cache, root + "/manifest.lua", write_manifest(num, need("POKEMON_VERSION")));
  return out;
}

const PIC_BYTES = 2048;

// Lua: pokemon_extract.lua:1304
function lz_string(rom: Rom, off: number): string | undefined {
  try {
    return Lz77.decompressString(rom, off)[0];
  } catch { /* the Lua retries with a getter; same decoder here */ }
  try {
    return Lz77.toString(Lz77.decompress((i) => rom.get(i), off)[0]);
  } catch {
    return undefined;
  }
}

// Lua: pokemon_extract.lua:1312
function stack_frames(tiles: string, palBytes: string, frames: number[], bank: number): string {
  return frames.map((f) => decode_pic_sheet(tiles, palBytes, f, bank)!).join("");
}

interface PicWriter {
  written: { front: number; back: number; still: number; anim: number };
  missing: string[];
  write(sp: number): void;
  check(label: string): void;
}

// Lua: pokemon_extract.lua:1318
function pic_writer(rom: Rom, cache: Cache, root: string): PicWriter {
  const frontTable = pic_table("MON_FRONT_PIC_TABLE", "mon_front_pic_table");
  const backTable: number = need("MON_BACK_PIC_TABLE");
  const stillTable: number | undefined = Versions.MON_STILL_FRONT_PIC_TABLE;
  const palTable = pic_table("MON_PALETTE_TABLE", "mon_palette_table");
  const shinyTable: number = need("MON_SHINY_PALETTE_TABLE");
  const castform = species_id("SPECIES_CASTFORM");
  const spinda = species_id("SPECIES_SPINDA");
  const deoxys = Versions.MON_PIC_DUPLICATE_DEOXYS ? species_id("SPECIES_DEOXYS") : undefined;
  const state: PicWriter = {
    written: { front: 0, back: 0, still: 0, anim: 0 },
    missing: [],
    write: () => {},
    check: () => {},
  };

  const ptr = (tableOff: number, sp: number): number | undefined => gba_off(rom.u32(tableOff + sp * 8));

  const out = (kind: string, sp: number, suffix: string, normal: string, shiny: string): void => {
    put(cache, root + "/" + kind + "/" + sp + suffix + ".rgba", normal);
    put(cache, root + "/" + kind + "_shiny/" + sp + suffix + ".rgba", shiny);
  };

  state.write = (sp: number): void => {
    const palOff = ptr(palTable, sp), shinyOff = ptr(shinyTable, sp);
    const pal = palOff !== undefined ? lz_string(rom, palOff) : undefined;
    const shiny = shinyOff !== undefined ? lz_string(rom, shinyOff) : undefined;
    const jobs: [string, number][] = [["front", frontTable], ["back", backTable]];
    if (stillTable !== undefined) jobs.push(["front_still", stillTable]);
    for (const job of jobs) {
      const kind = job[0], picOff = ptr(job[1], sp);
      if (picOff !== undefined && palOff !== undefined) {
        const tiles = lz_string(rom, picOff);
        const frames = tiles !== undefined ? Math.floor(tiles.length / PIC_BYTES) : 0;
        if (!(tiles !== undefined && pal !== undefined && shiny !== undefined && frames >= 1)) {
          state.missing.push(kind + "/" + sp);
        } else {
          out(kind, sp, "", decode_pic_sheet(tiles, pal, 0, 0)!, decode_pic_sheet(tiles, shiny, 0, 0)!);
          const wk = kind === "front_still" ? "still" : (kind as "front" | "back");
          state.written[wk] = state.written[wk] + 1;
          // pokeemerald/src/data/pokemon_graphics/front_pic_anims.h:5194
          if (sp === castform) {
            for (let form = 1; form <= frames - 1; form++) {
              out(kind, sp, "_" + form, decode_pic_sheet(tiles, pal, form, form)!, decode_pic_sheet(tiles, shiny, form, form)!);
            }
          } else if (kind === "front" && frames === 2) {
            out("front_anim", sp, "", stack_frames(tiles, pal, [0, 1], 0), stack_frames(tiles, shiny, [0, 1], 0));
            state.written.anim = state.written.anim + 1;
          }
          // pokeemerald/src/decompress.c:407
          if (sp === deoxys && kind !== "front_still" && frames >= 2) {
            out(kind, sp, "_handled", decode_pic_sheet(tiles, pal, 1, 0)!, decode_pic_sheet(tiles, shiny, 1, 0)!);
            if (kind === "front") {
              out("front_anim", sp, "_handled", stack_frames(tiles, pal, [1, 1], 0), stack_frames(tiles, shiny, [1, 1], 0));
            }
          }
          // pokeemerald/src/pokemon.c:5808
          if (sp === spinda && kind === "front") {
            let spots = "";
            for (let i = 0; i <= 143; i++) spots += String.fromCharCode(rom.get(need("SPINDA_SPOT_GRAPHICS") + i));
            put(cache, root + "/spinda/front.4bpp", tiles.slice(0, PIC_BYTES));
            put(cache, root + "/spinda/normal.gbapal", pal.slice(0, 32));
            put(cache, root + "/spinda/shiny.gbapal", shiny.slice(0, 32));
            put(cache, root + "/spinda/spots.bin", spots);
          }
        }
      }
    }
  };

  state.check = (label: string): void => {
    if (state.missing.length > 0) {
      const shown = state.missing.slice(0, Math.min(8, state.missing.length));
      throw new Error(format("pokemon_extract(%s): %d species sprites with valid ROM pointers produced no file (%s%s)",
        label, state.missing.length, shown.join(", "), state.missing.length > shown.length ? ", ..." : ""));
    }
  };

  return state;
}

// Lua: pokemon_extract.lua:1398
function write_icons_lua(pals: Record<number, IconPal>, indices: Record<number, number>, count: number): string {
  const lines = [
    "return {",
    format("  count = %d,", count),
    "  palettes = {",
  ];
  for (let i = 0; i <= border(pals); i++) {
    const row: string[] = [];
    for (let c = 0; c <= 15; c++) row[c] = tostring(pals[i]![c] ?? 0);
    lines.push(format("    [%d] = { [0] = %s },", i, row.join(", ")));
  }
  lines.push("  },");
  lines.push("  palIndex = {");
  for (let sp = 0; sp <= count - 1; sp++) lines.push(format("    [%d] = %d,", sp, indices[sp] ?? 0));
  lines.push("  },");
  lines.push("}");
  lines.push("");
  return lines.join("\n");
}

// Lua: pokemon_extract.lua:1420
function write_pics_manifest(info: {
  animFrames: number; still: boolean; castform: number; castformForms: number; unownFirst: number; unownLast: number;
  deoxys?: number; footprintColor: number;
}): string {
  const lines = [
    "return {",
    format("  format = %d,", 1),
    format("  picBytes = %d,", PIC_BYTES),
    format("  frontAnimFrames = %d,", info.animFrames),
    format("  still = %s,", tostring(info.still)),
    format("  forms = { [%d] = %d },", info.castform, info.castformForms),
    format("  unown = { first = %d, last = %d },", info.unownFirst, info.unownLast),
    format("  noFrontAnim = { [%d] = true },", info.castform),
  ];
  if (info.deoxys !== undefined) {
    lines.push(format('  handled = { [%d] = { "front", "front_anim", "back", "icons" } },', info.deoxys));
  }
  lines.push(format("  footprint = { width = 16, height = 16, colorIndex = %d },", info.footprintColor));
  lines.push("}");
  lines.push("");
  return lines.join("\n");
}

// Lua: pokemon_extract.lua:1443 (pokeemerald/src/pokedex.c:4587); bytes 0-based
function bake_footprint(bytes: number[]): string {
  const on = "\x00\x00\x00\xff", off = "\x00\x00\x00\x00";
  let px = "";
  for (let y = 0; y <= 15; y++) {
    for (let x = 0; x <= 15; x++) {
      const tile = Math.floor(x / 8) + 2 * Math.floor(y / 8);
      const byte = bytes[tile * 8 + (y % 8)] ?? 0;
      px += Math.floor(byte / 2 ** (x % 8)) % 2 === 1 ? on : off;
    }
  }
  return px;
}

// Lua: pokemon_extract.lua:1543
const RSE_READY: [string, number][] = [
  ["manifest.lua", 20], ["names.lua", 20], ["stats.lua", 20], ["learnsets.lua", 20],
  ["egg_moves.lua", 20], ["move_names.lua", 20], ["hoenn.lua", 20], ["regional_dex.lua", 20],
  ["type_names.lua", 20], ["exp_table.lua", 20], ["pics.lua", 20], ["icons.lua", 20],
  ["footprints/1.rgba", 16 * 16 * 4],
];

export const PokemonExtract = {
  MAGIC: "SVPK",
  FORMAT_VERSION: 6,
  CACHE_SUB: "pokemon",

  // Exposed for tests (tests/engine/game3_egg_moves.lua).
  eggMovesFromRom: extract_egg_moves,
  writeEggMovesLua: write_egg_moves_lua,
  // src/import/gba/egg_extract.lua bakes the SPECIES_EGG icon with it.
  iconRgba: icon_rgba,

  // Lua: pokemon_extract.lua:1058 -- extract the full pack into {cacheRoot}/pokemon/
  run(rom: Rom, cache: Cache, opts: PokemonRunOpts = {}): Record<string, any> {
    const cacheRoot = opts.cacheRoot ?? default_cache_root();
    const root = cacheRoot + "/" + PokemonExtract.CACHE_SUB;
    const num: number = opts.numSpecies ?? Versions.NUM_SPECIES;
    const spMin = opts.spMin ?? 0;
    const spMax = opts.spMax ?? num - 1;
    const onlySpeciesGfx = opts.onlySpeciesGfx === true;
    const progress = opts.progress;

    if (opts.part !== undefined) return PokemonExtract.runPart(rom, cache, opts);

    const pals = load_icon_pals(rom);
    const frontPicTable = pic_table("MON_FRONT_PIC_TABLE", "mon_front_pic_table");
    const backPicTable: number = need("MON_BACK_PIC_TABLE");
    const palTable = pic_table("MON_PALETTE_TABLE", "mon_palette_table");
    const SPECIES_CASTFORM = species_id("SPECIES_CASTFORM");
    const SPECIES_SPINDA = species_id("SPECIES_SPINDA");

    const picsWritten = { icons: 0, front: 0, back: 0 };
    const picsMissing: string[] = [];
    const noteMissing = (kind: string, sp: number): void => { picsMissing.push(kind + "/" + sp); };

    const lz = (off: number): string | undefined => lz_string(rom, off);

    // src/pokemon.c:5904
    const write_pics = (sp: number): void => {
      const palOff = gba_off(rom.u32(palTable + sp * 8));
      const shinyOff = gba_off(rom.u32(Versions.MON_SHINY_PALETTE_TABLE + sp * 8));
      const palBytes = palOff !== undefined ? lz(palOff) : undefined;
      const shinyBytes = shinyOff !== undefined ? lz(shinyOff) : undefined;
      for (const kind of ["front", "back"] as const) {
        const tableOff = kind === "front" ? frontPicTable : backPicTable;
        const picOff = gba_off(rom.u32(tableOff + sp * 8));
        if (picOff !== undefined && palOff !== undefined) {
          const tiles = lz(picOff);
          const rgba = tiles !== undefined && palBytes !== undefined ? decode_pic_sheet(tiles, palBytes) : undefined;
          const shiny = tiles !== undefined && shinyBytes !== undefined ? decode_pic_sheet(tiles, shinyBytes) : undefined;
          if (rgba !== undefined && shiny !== undefined) {
            put(cache, root + "/" + kind + "/" + sp + ".rgba", rgba);
            put(cache, root + "/" + kind + "_shiny/" + sp + ".rgba", shiny);
            picsWritten[kind] = picsWritten[kind] + 1;
            // pokefirered/graphics_file_rules.mk:29
            // src/pokemon.c:1350, :5339
            if (sp === SPECIES_SPINDA && kind === "front") {
              let spots = "";
              for (let i = 0; i <= 143; i++) spots += String.fromCharCode(rom.get(Versions.SPINDA_SPOT_GRAPHICS + i));
              put(cache, root + "/spinda/front.4bpp", tiles!.slice(0, 2048));
              put(cache, root + "/spinda/normal.gbapal", palBytes!.slice(0, 32));
              put(cache, root + "/spinda/shiny.gbapal", shinyBytes!.slice(0, 32));
              put(cache, root + "/spinda/spots.bin", spots);
            }
            if (sp === SPECIES_CASTFORM) {
              for (let form = 1; form <= 3; form++) {
                put(cache, root + "/" + kind + "/" + sp + "_" + form + ".rgba", decode_pic_sheet(tiles, palBytes, form, form)!);
                put(cache, root + "/" + kind + "_shiny/" + sp + "_" + form + ".rgba", decode_pic_sheet(tiles, shinyBytes, form, form)!);
              }
            }
          } else {
            noteMissing(kind, sp);
          }
        }
      }
    };

    const totalGfxCount = spMax - spMin + 1;
    for (let sp = spMin; sp <= spMax; sp++) {
      if (progress && (sp - spMin) % 40 === 0) progress("pokemon", sp - spMin, totalGfxCount);
      put(cache, root + "/icons/" + sp + ".rgba", icon_rgba(rom, sp, pals));
      picsWritten.icons++;
      write_pics(sp);
    }

    if (!onlySpeciesGfx && spMax >= num - 1) {
      // include/constants/species.h:425
      for (let sp = Versions.SPECIES_UNOWN_B; sp <= Versions.SPECIES_UNOWN_QMARK; sp++) {
        put(cache, root + "/icons/" + sp + ".rgba", icon_rgba(rom, sp, pals));
        write_pics(sp);
      }
    }

    if (onlySpeciesGfx) return { root, numSpecies: totalGfxCount, picsWritten };

    if (picsMissing.length > 0) {
      const shown = picsMissing.slice(0, Math.min(8, picsMissing.length));
      throw new Error(format("pokemon_extract: %d species sprites with valid ROM pointers produced no file (%s%s)",
        picsMissing.length, shown.join(", "), picsMissing.length > shown.length ? ", ..." : ""));
    }
    const expectedIcons = spMin === 0 && spMax >= num - 1 ? num : spMax - spMin + 1;
    if (picsWritten.icons < expectedIcons || picsWritten.front < 1 || picsWritten.back < 1) {
      throw new Error(format("pokemon_extract: sprite pass wrote %d icons, %d front, %d back for %d species",
        picsWritten.icons, picsWritten.front, picsWritten.back, expectedIcons));
    }

    // pokefirered/src/battle_gfx_sfx_util.c:422
    const ghostPic: number | undefined = Versions.GHOST_FRONT_PIC;
    const ghostPal: number | undefined = Versions.GHOST_PALETTE;
    if (ghostPic !== undefined && ghostPal !== undefined) {
      let tiles: string | undefined, palBytes: string | undefined;
      try { tiles = Lz77.decompressString(rom, ghostPic)[0]; } catch { tiles = undefined; }
      try { palBytes = Lz77.decompressString(rom, ghostPal)[0]; } catch { palBytes = undefined; }
      if (tiles !== undefined && palBytes !== undefined) {
        const rgba = decode_pic_sheet(tiles, palBytes);
        if (rgba !== undefined) cache.write(root + "/front/ghost.rgba", rgba);
      }
    }

    const data = extract_data(rom, cache, root, num, progress);

    if (progress) progress("battle_moves", 0, 1);
    const battle = BattleMovesExtract.run(rom, cache, { cacheRoot });
    if (progress) progress("battle_moves", 1, 1);

    if (progress) progress("party_chrome", 0, 1);
    const chrome = PartyChromeExtract.run(rom, cache, { cacheRoot });
    if (progress) progress("party_chrome", 1, 1);

    if (progress) progress("battle_chrome", 0, 1);
    const battleChrome = BattleChromeExtract.run(rom, cache, { cacheRoot });
    if (progress) progress("battle_chrome", 1, 1);

    BallOpenExtract.run(rom, cache, { cacheRoot });

    try { PokedexChromeExtract.run(rom, cache, { cacheRoot, progress }); } catch { /* pcall */ }

    try { StorageChromeExtract.run(rom, cache, { cacheRoot }); } catch { /* pcall */ }

    if (progress) progress("battle_transition", 0, 1);
    const [battleTransition] = BattleTransitionExtract.run(rom, cache, { cacheRoot });
    if (progress) progress("battle_transition", 1, 1);

    if (progress) progress("summary_chrome", 0, 1);
    const summaryChrome = SummaryChromeExtract.run(rom, cache, { cacheRoot });
    if (progress) progress("summary_chrome", 1, 1);

    if (progress) progress("bag_chrome", 0, 1);
    BagChromeExtract.run(rom, cache, { cacheRoot });
    if (progress) progress("bag_chrome", 1, 1);

    if (progress) progress("shop_chrome", 0, 1);
    ShopChromeExtract.run(rom, cache, { cacheRoot });
    if (progress) progress("shop_chrome", 1, 1);

    try { TextChromeExtract.run(rom, cache, { cacheRoot }); } catch { /* pcall */ }

    try { ItemsExtract.run(rom, cache, { cacheRoot }); } catch { /* pcall */ }

    try { TrainerCardExtract.run(rom, cache, { cacheRoot }); } catch { /* pcall */ }

    try { TmCaseExtract.run(rom, cache, { cacheRoot }); } catch { /* pcall */ }

    try { BerryPouchExtract.run(rom, cache, { cacheRoot }); } catch { /* pcall */ }

    EasyChatExtract.run(rom, cache, { cacheRoot });

    return {
      root,
      numSpecies: num,
      picsWritten,
      names: data.names,
      types: data.types,
      stats: data.stats,
      abilities: data.abilities,
      abilityNames: data.abilityNames,
      moveNames: data.moveNames,
      learnsets: data.learnsets,
      eggMoves: data.eggMoves,
      evolutions: data.evolutions,
      battleMoves: battle ? battle.pack : undefined,
      partyChrome: chrome,
      battleChrome,
      battleTransition,
      summaryChrome,
    };
  },

  // Lua: pokemon_extract.lua:1456
  runPart(rom: Rom, cache: Cache, opts: PokemonRunOpts): Record<string, any> {
    const cacheRoot = opts.cacheRoot ?? default_cache_root();
    const root = cacheRoot + "/" + PokemonExtract.CACHE_SUB;
    const num: number = opts.numSpecies ?? need("NUM_SPECIES");
    const progress = opts.progress;
    const part = opts.part;

    if (part === "data") {
      const data = extract_data(rom, cache, root, num, progress);
      data.root = root;
      data.numSpecies = num;
      return data as unknown as Record<string, any>;
    }

    const pals = load_icon_pals(rom);
    const writer = pic_writer(rom, cache, root);

    if (part === "gfx") {
      const spMin = opts.spMin ?? 0;
      const spMax = opts.spMax ?? num - 1;
      let icons = 0;
      for (let sp = spMin; sp <= spMax; sp++) {
        if (progress && (sp - spMin) % 40 === 0) progress("pokemon", sp - spMin, spMax - spMin + 1);
        put(cache, root + "/icons/" + sp + ".rgba", icon_rgba(rom, sp, pals));
        icons++;
        writer.write(sp);
      }
      writer.check("gfx " + spMin + "-" + spMax);
      const w = writer.written;
      if (icons < spMax - spMin + 1 || w.front < 1 || w.back < 1) {
        throw new Error(format("pokemon_extract: sprite pass wrote %d icons, %d front, %d back for species %d-%d",
          icons, w.front, w.back, spMin, spMax));
      }
      return { root, picsWritten: w, icons };
    }

    if (part === "forms") {
      const first: number = need("SPECIES_UNOWN_B"), last: number = need("SPECIES_UNOWN_QMARK");
      for (let sp = first; sp <= last; sp++) {
        put(cache, root + "/icons/" + sp + ".rgba", icon_rgba(rom, sp, pals));
        writer.write(sp);
      }
      writer.check("forms");

      const deoxys = Versions.MON_PIC_DUPLICATE_DEOXYS ? species_id("SPECIES_DEOXYS") : undefined;
      if (deoxys !== undefined && Versions.MON_ICON_DEOXYS_OFFSET !== undefined) {
        put(cache, root + "/icons/" + deoxys + "_handled.rgba",
          icon_rgba(rom, deoxys, pals, { byteOffset: Versions.MON_ICON_DEOXYS_OFFSET }));
      }

      const iconCount: number = need("MON_ICON_COUNT");
      const indices: Record<number, number> = {};
      for (let sp = 0; sp <= iconCount - 1; sp++) indices[sp] = rom.get(need("MON_ICON_PAL_INDICES") + sp);
      put(cache, root + "/icons.lua", write_icons_lua(pals, indices, iconCount));

      const fpBase: number = need("MON_FOOTPRINT_TABLE");
      const fpCount: number = need("MON_FOOTPRINT_COUNT");
      let footprints = 0;
      for (let sp = 0; sp <= fpCount - 1; sp++) {
        const off = gba_off(rom.u32(fpBase + sp * 4));
        if (off !== undefined) {
          const bytes: number[] = [];
          for (let i = 0; i <= 31; i++) bytes[i] = rom.get(off + i);
          put(cache, root + "/footprints/" + sp + ".rgba", bake_footprint(bytes));
          footprints++;
        }
      }

      const castform = species_id("SPECIES_CASTFORM");
      const castOff = gba_off(rom.u32(pic_table("MON_FRONT_PIC_TABLE", "mon_front_pic_table") + castform * 8));
      const castTiles = castOff !== undefined ? lz_string(rom, castOff) : undefined;
      put(cache, root + "/pics.lua", write_pics_manifest({
        animFrames: 2,
        still: Versions.MON_STILL_FRONT_PIC_TABLE !== undefined,
        castform,
        castformForms: castTiles !== undefined ? Math.floor(castTiles.length / PIC_BYTES) : 1,
        unownFirst: first,
        unownLast: last,
        deoxys,
        footprintColor: need("MON_FOOTPRINT_COLOR_IDX"),
      }));
      return { root, picsWritten: writer.written, footprints };
    }

    throw new Error("pokemon_extract: unknown part " + tostring(part));
  },

  REQUIRED: [
    "pokemon/manifest.lua", "pokemon/names.lua", "pokemon/types.lua", "pokemon/stats.lua",
    "pokemon/abilities.lua", "pokemon/ability_names.lua", "pokemon/descriptions.lua", "pokemon/meta.lua",
    "pokemon/national.lua", "pokemon/move_names.lua", "pokemon/learnsets.lua", "pokemon/evolutions.lua",
    "pokemon/tmhm.lua", "pokemon/egg_moves.lua", "pokemon/dex.lua", "pokemon/hoenn.lua",
    "pokemon/regional_dex.lua", "pokemon/type_names.lua", "pokemon/exp_table.lua", "pokemon/pics.lua",
    "pokemon/icons.lua",
    "pokemon/front/1.rgba", "pokemon/front/205.rgba", "pokemon/front/411.rgba", "pokemon/front/439.rgba",
    "pokemon/front_anim/1.rgba", "pokemon/front_anim/411.rgba", "pokemon/front_still/1.rgba",
    "pokemon/back/1.rgba", "pokemon/back/411.rgba", "pokemon/back/439.rgba",
    "pokemon/icons/1.rgba", "pokemon/icons/411.rgba", "pokemon/icons/439.rgba",
    "pokemon/footprints/1.rgba",
  ],

  // Lua: pokemon_extract.lua:1564
  // NOT FAITHFUL: with no cache handle the Lua tries CacheFs, love.filesystem
  // and io.open; here CacheFs only.
  ready(cache: Cache | undefined, cacheRoot?: string): boolean {
    const baseRoot = cacheRoot ?? default_cache_root();
    const root = baseRoot + "/" + PokemonExtract.CACHE_SUB;
    const last = (Versions.NUM_SPECIES ?? 412) - 1;
    const iconBytes = (Versions.MON_ICON_W ?? 32) * (Versions.MON_ICON_H ?? 32) * 2 * 4;
    const valid_file = (rel: string, minSize = 1): boolean => {
      if (cache) {
        if (cache.read) {
          const data = cache.read(rel);
          return (data !== undefined && data.length >= minSize) || false;
        } else if (cache.exists) {
          return cache.exists(rel) || false;
        }
        return false;
      }
      try {
        const data = CacheFs.readActive(rel);
        if (data !== undefined && data.length >= minSize) return true;
      } catch { /* no cache bound */ }
      return false;
    };

    const manifest_text = (): string | undefined => {
      if (cache) return cache.read ? cache.read(root + "/manifest.lua") : undefined;
      try { return CacheFs.readActive(root + "/manifest.lua"); } catch { return undefined; }
    };

    const manifest = manifest_text();
    if (typeof manifest === "string") {
      const fm = /format\s*=\s*(\d+)/.exec(manifest);
      const fmt = tonumber(fm ? fm[1] : undefined);
      if (fmt !== PokemonExtract.FORMAT_VERSION) return false;
      const cm = /numSpecies\s*=\s*(\d+)/.exec(manifest);
      const count = tonumber(cm ? cm[1] : undefined);
      if (count !== undefined && count < (Versions.NUM_SPECIES ?? 412)) return false;
    }

    if (Versions.MON_FRONT_PIC_ANIM !== undefined) {
      for (const row of RSE_READY) if (!valid_file(root + "/" + row[0], row[1])) return false;
      const pic = 64 * 64 * 4;
      const unown = Versions.SPECIES_UNOWN_QMARK;
      for (const sp of [1, last, unown]) {
        if (!(valid_file(root + "/front/" + sp + ".rgba", pic)
          && valid_file(root + "/front_anim/" + sp + ".rgba", pic * 2)
          && valid_file(root + "/back/" + sp + ".rgba", pic)
          && valid_file(root + "/icons/" + sp + ".rgba", iconBytes))) {
          return false;
        }
      }
      return true;
    }

    return valid_file(root + "/manifest.lua", 20)
      && valid_file(root + "/names.lua", 20)
      && valid_file(root + "/stats.lua", 20)
      && valid_file(root + "/learnsets.lua", 20)
      && valid_file(root + "/egg_moves.lua", 20)
      && valid_file(root + "/move_names.lua", 20)
      && valid_file(root + "/party/slot_main.rgba", 80 * 56 * 4)
      && valid_file(root + "/summary/page_info.rgba", 240 * 160 * 4)
      && valid_file(root + "/storage/manifest.lua", 20)
      && valid_file(baseRoot + "/chrome/menu_message_rgba.rgba", 20)
      && valid_file(baseRoot + "/trainer_card/bg.rgba", 240 * 160 * 4)
      && valid_file(baseRoot + "/items/pack.lua", 20)
      && valid_file(baseRoot + "/chrome/fonts/braille.lua", 20)
      && valid_file(baseRoot + "/seagallop/manifest.lua", 20)
      && valid_file(baseRoot + "/seagallop/wb.rgba", 32 * 8 * 32 * 8 * 4)
      && valid_file(root + "/pokedex/paper_bg.rgba", 240 * 160 * 4)
      && valid_file(root + "/pokedex/footprints/1.rgba", 16 * 16 * 4)
      && valid_file(root + "/pokedex/footprints/question_mark.rgba", 16 * 16 * 4)
      && valid_file(root + "/battle/terrain_cave.rgba", 256 * 256 * 4)
      && valid_file(root + "/battle/terrain_water.rgba", 256 * 256 * 4)
      && valid_file(root + "/battle/terrain_champion.rgba", 256 * 256 * 4)
      && valid_file(root + "/front/1.rgba", 64 * 64 * 4)
      && valid_file(root + "/back/1.rgba", 64 * 64 * 4)
      && valid_file(root + "/icons/1.rgba", iconBytes)
      && valid_file(root + "/front/" + last + ".rgba", 64 * 64 * 4)
      && valid_file(root + "/back/" + last + ".rgba", 64 * 64 * 4)
      && valid_file(root + "/icons/" + last + ".rgba", iconBytes);
  },
};

export default PokemonExtract;
