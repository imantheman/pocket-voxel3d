// Port of gen1recomp src/import/gba/battle_anim_extract.lua (GPLv3 + additional terms; see LICENSE.md).
// ROM-native GBA battle anim extraction.
// Decodes bytecode scripts from gBattleAnims_Moves and subroutines.
// createsprite: reads SpriteTemplate.tileTag from the embedded ROM pointer -> true tag.
// Sprite sheets: decompressed from gBattleAnimPicTable + gBattleAnimPaletteTable -> PNG.
// Writes: {cacheRoot}/pokemon/battle_anims/pack.lua  +  tags/*.png
//
// Lua tables, as the serializer sees them: sequences are JS arrays (0-based,
// Lua 1..n); tables with string keys only are plain objects; tables whose
// keys are numbers (or mix numbers and strings) are Maps, so a number key
// stays a number ([0] = ...) and a digit string stays a string (["123"]).
// Byte tables (LZ77 output, raw reads) are 0-based.

import { Versions } from "./versions.ts";
import { Lz77 } from "./lz77.ts";
import { encodePng } from "./png.ts";
import { format, fromBytes, toBytes, tostring } from "./lua.ts";
import type { Cache } from "./cache.ts";
import type { Rom } from "./rom.ts";

type Bytes = ArrayLike<number>;
type Op = Record<string, unknown>;
type Ops = Op[];
type Key = number | string;
type PalRgba = Record<number, [number, number, number, number]>;

// ── opcode sizes (total bytes incl. opcode byte) for fixed-width opcodes ──
// Variable-width: 0x02 createsprite, 0x03 createvisualtask, 0x1F createsoundtask
const OP_FIXED: Record<number, number> = {
  0x00: 3, 0x01: 3, // loadspritegfx / unloadspritegfx
  0x04: 2, 0x05: 1, 0x06: 1, 0x07: 1, 0x08: 1, // delay/waitforvisualfinish/nop/nop2/end
  0x09: 3, // playse
  0x0a: 2, 0x0b: 2, // monbg / clearmonbg
  0x0c: 3, // setalpha
  0x0d: 1, // blendoff
  0x0e: 5, // call
  0x0f: 1, // return
  0x10: 4, // setarg
  0x11: 9, // choosetwoturnanim
  0x12: 6, // jumpifmoveturn
  0x13: 5, // goto
  0x14: 2, 0x15: 1, 0x16: 1, 0x17: 1, 0x18: 2, // fadetobg/restorebg/waitbgfadeout/waitbgfadein/changebg
  0x19: 4, // playsewithpan
  0x1a: 2, // setpan
  0x1b: 7, // panse
  0x1c: 6, // loopsewithpan
  0x1d: 5, // waitplaysewithpan
  0x1e: 3, // setbldcnt
  0x20: 1, // waitsound
  0x21: 8, // jumpargeq
  0x22: 2, 0x23: 2, // monbg_static / clearmonbg_static
  0x24: 5, // jumpifcontest
  0x25: 4, // fadetobgfromset
  0x26: 7, 0x27: 7, // panse_adjustnone / panse_adjustall
  0x28: 2, 0x29: 1, 0x2a: 2, // splitbgprio / splitbgprio_all / splitbgprio_foes
  0x2b: 2, 0x2c: 2, // invisible / visible
  0x2d: 2, 0x2e: 2, 0x2f: 1, // teamattack_moveback / movefwd / stopsound
};

// Lua: battle_anim_extract.lua:16, :51 -- module config, refreshed by run()
let V: Record<string, any> = {};
let SPRITES_START = 10000;
let TAG_NAMES: Record<number, string> = {};
let unresolved: Record<string, string> | undefined;

// Lua: battle_anim_extract.lua:55
function refresh_config(): void {
  V = Versions.BATTLE_ANIMS ?? {};
  SPRITES_START = V.sprites_start ?? 10000;
  TAG_NAMES = Versions.ANIM_TAG_NAMES ?? {};
}

// Lua: battle_anim_extract.lua:61
function note_unresolved(kind: string, ptr: number | undefined, at: number | undefined): void {
  if (!unresolved) return;
  const key = kind + format(" 0x%08X", ptr ?? 0);
  if (!unresolved[key]) unresolved[key] = format("%s pointer 0x%08X (script offset 0x%06X)", kind, ptr ?? 0, at ?? 0);
}

const BATTLER_NAMES: Record<number, string> = { 0: "attacker", 1: "target", 2: "atk_partner", 3: "def_partner" };

// Lua: battle_anim_extract.lua:72 -- Signed-extend 8-bit (for pan values stored as s8).
function s8(v: number): number {
  return v >= 128 ? v - 256 : v;
}

// Lua: battle_anim_extract.lua:78 -- Signed-extend 16-bit (for arg values stored as s16).
function s16(v: number): number {
  return v >= 32768 ? v - 65536 : v;
}

const tagName = (idx: number): string => TAG_NAMES[idx] ?? "TAG_" + tostring(idx);

// The OAM {w,h} table indexed by [shape][size]
const DIMS: Record<number, [number, number][]> = {
  0: [[8, 8], [16, 16], [32, 32], [64, 64]], // square
  1: [[16, 8], [32, 8], [32, 16], [64, 32]], // wide
  2: [[8, 16], [8, 32], [16, 32], [32, 64]], // tall
};

/**
 * Lua: battle_anim_extract.lua:89 -- Decode one battle anim bytecode script
 * beginning at file offset `startOff` (0-based). `visited` holds offsets
 * already decoded; `labels` maps tostring(offset) to its IR list (filled in
 * place for call/goto targets).
 */
function decode_script(rom: Rom, startOff: number, visited: Set<number>, labels: Map<Key, Ops>,
  tag_dims: Record<string, { w: number; h: number }> | undefined): Ops {
  if (visited.has(startOff)) return labels.get(tostring(startOff)) ?? [];
  visited.add(startOff);

  const ops: Ops = [];
  labels.set(tostring(startOff), ops);

  let i = startOff;
  let guard = 0;
  while (guard < 4096) {
    guard = guard + 1;
    if (i >= rom.size) break;

    const op = rom.get(i);

    if (op === 0x08) { // end
      ops.push({ op: "end" });
      break;
    } else if (op === 0x00) { // loadspritegfx
      const tag_id = rom.u16(i + 1);
      const tag_idx = tag_id - SPRITES_START;
      ops.push({ op: "loadspritegfx", tag: tagName(tag_idx), tag_idx });
      i = i + 3;
    } else if (op === 0x01) { // unloadspritegfx
      const tag_id = rom.u16(i + 1);
      const tag_idx = tag_id - SPRITES_START;
      ops.push({ op: "unloadspritegfx", tag: tagName(tag_idx) });
      i = i + 3;
    } else if (op === 0x02) { // createsprite
      const tmpl_gba = rom.u32(i + 1);
      const tmpl_off = rom.ptrOffset(tmpl_gba);
      // SpriteTemplate layout: tileTag(u16)+paletteTag(u16)+oam*(u32)+anims*(u32)+images*(u32)+affineAnims*(u32)+callback*(u32) = 24 bytes
      const tile_id = tmpl_off !== undefined ? rom.u16(tmpl_off) : 0;
      const tile_idx = tile_id - SPRITES_START;
      const tag_name = tile_id >= SPRITES_START ? tagName(tile_idx) : undefined;
      const noGfx = tile_id < SPRITES_START; // tileTag = 0 means TAG_NONE -> no gfx
      const pal_id = tmpl_off !== undefined ? rom.u16(tmpl_off + 2) : 0;
      const pal_name = pal_id >= SPRITES_START ? tagName(pal_id - SPRITES_START) : undefined;

      // OAM dimensions from SpriteTemplate.oam pointer
      let w = 32, h = 32;
      if (tmpl_off !== undefined) {
        const oam_gba = rom.u32(tmpl_off + 4);
        const oam_off = rom.ptrOffset(oam_gba);
        if (oam_off !== undefined) {
          // OAM struct: 4 bytes total. shape=bits[15:14] of u16[0], size=bits[15:14] of u16[1]
          const h0 = rom.u16(oam_off);
          const h1 = rom.u16(oam_off + 2);
          const shape = Math.floor(h0 / 0x4000) % 4;
          const size = Math.floor(h1 / 0x4000) % 4;
          const row = DIMS[shape];
          if (row && row[size]) { w = row[size]![0]; h = row[size]![1]; }
        }
      }

      const cb_gba = tmpl_off !== undefined ? rom.u32(tmpl_off + 20) : 0;
      const cb_name: string | undefined = Versions.ANIM_CALLBACK_NAMES && Versions.ANIM_CALLBACK_NAMES[cb_gba];
      const tmpl_name: string | undefined = Versions.ANIM_TEMPLATE_NAMES && Versions.ANIM_TEMPLATE_NAMES[tmpl_gba];
      if (!tmpl_name) note_unresolved("template", tmpl_gba, i);
      if (!cb_name) note_unresolved("callback", cb_gba, i);

      if (tag_name && tag_dims && !tag_dims[tag_name]) tag_dims[tag_name] = { w, h };

      const battler_byte = rom.get(i + 5);
      const is_target = battler_byte >= 0x80;
      const subpri = battler_byte % 0x80;
      const argc = rom.get(i + 6);
      const args: number[] = [];
      for (let ai = 0; ai <= argc - 1; ai++) args[ai] = s16(rom.u16(i + 7 + ai * 2));

      const battler = is_target ? "target" : "attacker";

      ops.push({
        op: "createsprite",
        template: tmpl_name,
        tag: tag_name,
        palTag: pal_name !== tag_name ? pal_name : undefined,
        callback: cb_name,
        noGfx: noGfx || undefined,
        w,
        h,
        animBattler: battler,
        subpriority: subpri,
        args,
      });
      i = i + 7 + argc * 2;
    } else if (op === 0x03) { // createvisualtask
      const fn_gba = rom.u32(i + 1);
      const pri = rom.get(i + 5);
      const argc = rom.get(i + 6);
      const args: number[] = [];
      for (let ai = 0; ai <= argc - 1; ai++) args[ai] = s16(rom.u16(i + 7 + ai * 2));
      const task_name: string | undefined = Versions.ANIM_TASK_NAMES && Versions.ANIM_TASK_NAMES[fn_gba];
      if (!task_name) note_unresolved("task", fn_gba, i);
      ops.push({ op: "createvisualtask", task: task_name || format("0x%08X", fn_gba), priority: pri, args });
      i = i + 7 + argc * 2;
    } else if (op === 0x04) { // delay
      ops.push({ op: "delay", frames: rom.get(i + 1) });
      i = i + 2;
    } else if (op === 0x05) { // waitforvisualfinish
      ops.push({ op: "waitforvisualfinish" });
      i = i + 1;
    } else if (op === 0x09) { // playse
      ops.push({ op: "playse", se: rom.u16(i + 1) });
      i = i + 3;
    } else if (op === 0x0a) { // monbg
      ops.push({ op: "monbg", battler: BATTLER_NAMES[rom.get(i + 1)] ?? "target" });
      i = i + 2;
    } else if (op === 0x0b) { // clearmonbg
      ops.push({ op: "clearmonbg", battler: BATTLER_NAMES[rom.get(i + 1)] ?? "target" });
      i = i + 2;
    } else if (op === 0x0c) { // setalpha
      const v = rom.u16(i + 1);
      ops.push({ op: "setalpha", eva: v % 256, evb: Math.floor(v / 256) % 256 });
      i = i + 3;
    } else if (op === 0x0d) { // blendoff
      ops.push({ op: "blendoff" });
      i = i + 1;
    } else if (op === 0x0e) { // call
      const target_off = rom.ptrOffset(rom.u32(i + 1));
      ops.push({ op: "call", label: tostring(target_off) });
      i = i + 5;
      // Eagerly decode target if not yet visited
      if (target_off !== undefined && !visited.has(target_off)) decode_script(rom, target_off, visited, labels, tag_dims);
    } else if (op === 0x0f) { // return
      ops.push({ op: "return" });
      break;
    } else if (op === 0x10) { // setarg
      ops.push({ op: "setarg", argId: rom.get(i + 1), value: s16(rom.u16(i + 2)) });
      i = i + 4;
    } else if (op === 0x11) { // choosetwoturnanim
      const off1 = rom.ptrOffset(rom.u32(i + 1));
      const off2 = rom.ptrOffset(rom.u32(i + 5));
      ops.push({ op: "choosetwoturnanim", label1: tostring(off1), label2: tostring(off2) });
      i = i + 9;
      if (off1 !== undefined && !visited.has(off1)) decode_script(rom, off1, visited, labels, tag_dims);
      if (off2 !== undefined && !visited.has(off2)) decode_script(rom, off2, visited, labels, tag_dims);
    } else if (op === 0x12) { // jumpifmoveturn
      const toCheck = rom.get(i + 1);
      const off = rom.ptrOffset(rom.u32(i + 2));
      ops.push({ op: "jumpifmoveturn", turn: toCheck, label: tostring(off) });
      i = i + 6;
      if (off !== undefined && !visited.has(off)) decode_script(rom, off, visited, labels, tag_dims);
    } else if (op === 0x13) { // goto
      const target_off = rom.ptrOffset(rom.u32(i + 1));
      ops.push({ op: "goto", label: tostring(target_off) });
      // Decode target then stop (tail-jump)
      if (target_off !== undefined && !visited.has(target_off)) decode_script(rom, target_off, visited, labels, tag_dims);
      break;
    } else if (op === 0x14) { // fadetobg
      ops.push({ op: "fadetobg", bg: rom.get(i + 1) });
      i = i + 2;
    } else if (op === 0x15) { // restorebg
      ops.push({ op: "restorebg" });
      i = i + 1;
    } else if (op === 0x18) { // changebg
      ops.push({ op: "changebg", bg: rom.get(i + 1) });
      i = i + 2;
    } else if (op === 0x19) { // playsewithpan
      ops.push({ op: "playsewithpan", se: rom.u16(i + 1), pan: s8(rom.get(i + 3)) });
      i = i + 4;
    } else if (op === 0x1b) { // panse
      const se = rom.u16(i + 1);
      const pan1 = s8(rom.get(i + 3)), pan2 = s8(rom.get(i + 4)), step = s8(rom.get(i + 5));
      const wait = rom.get(i + 6);
      ops.push({ op: "panse", se, pan: pan1, targetPan: pan2, step, wait });
      i = i + 7;
    } else if (op === 0x1c) { // loopsewithpan
      const se = rom.u16(i + 1);
      const pan = s8(rom.get(i + 3));
      const wait = rom.get(i + 4), times = rom.get(i + 5);
      ops.push({ op: "loopsewithpan", se, pan, wait, times });
      i = i + 6;
    } else if (op === 0x1d) { // waitplaysewithpan
      const se = rom.u16(i + 1);
      const pan = s8(rom.get(i + 3));
      const wait = rom.get(i + 4);
      ops.push({ op: "waitplaysewithpan", se, pan, wait });
      i = i + 5;
    } else if (op === 0x1f) { // createsoundtask (variable, like createvisualtask)
      const fn_gba = rom.u32(i + 1);
      const argc = rom.get(i + 5);
      const args: number[] = [];
      for (let ai = 0; ai <= argc - 1; ai++) args[ai] = s16(rom.u16(i + 6 + ai * 2));
      const snd_name: string | undefined = Versions.ANIM_TASK_NAMES && Versions.ANIM_TASK_NAMES[fn_gba];
      if (!snd_name) note_unresolved("sound task", fn_gba, i);
      ops.push({ op: "createsoundtask", task: snd_name || format("0x%08X", fn_gba), args });
      i = i + 6 + argc * 2;
    } else if (op === 0x21) { // jumpargeq
      const argId = rom.get(i + 1);
      const val = s16(rom.u16(i + 2));
      const off = rom.ptrOffset(rom.u32(i + 4));
      ops.push({ op: "jumpargeq", argId, value: val, label: tostring(off) });
      i = i + 8;
      if (off !== undefined && !visited.has(off)) decode_script(rom, off, visited, labels, tag_dims);
    } else if (op === 0x25) { // fadetobgfromset
      ops.push({ op: "fadetobgfromset", bg1: rom.get(i + 1), bg2: rom.get(i + 2), bg3: rom.get(i + 3) });
      i = i + 4;
    } else if (op === 0x26 || op === 0x27) { // panse_adjustnone / panse_adjustall
      const se = rom.u16(i + 1);
      const pan1 = s8(rom.get(i + 3)), pan2 = s8(rom.get(i + 4)), step = s8(rom.get(i + 5));
      const wait = rom.get(i + 6);
      ops.push({ op: "panse", se, pan: pan1, targetPan: pan2, step, wait, mode: op === 0x26 ? "adjustnone" : "adjustall" });
      i = i + 7;
    } else if (op === 0x28 || op === 0x29 || op === 0x2a) { // splitbgprio / splitbgprio_all / splitbgprio_foes
      const b = op === 0x28 || op === 0x2a ? rom.get(i + 1) : 1;
      ops.push({ op: "splitbgprio", battler: BATTLER_NAMES[b] ?? "target",
        mode: op === 0x29 ? "all" : op === 0x2a ? "foes" : undefined });
      i = i + (op === 0x29 ? 1 : 2);
    } else if (op === 0x16 || op === 0x17 || op === 0x20 || op === 0x2f) {
      const names: Record<number, string> = { 0x16: "waitbgfadeout", 0x17: "waitbgfadein", 0x20: "waitsound", 0x2f: "stopsound" };
      ops.push({ op: names[op] });
      i = i + 1;
    } else if (op === 0x1a) {
      ops.push({ op: "setpan", pan: s8(rom.get(i + 1)) });
      i = i + 2;
    } else if (op === 0x1e) {
      ops.push({ op: "setbldcnt", value: rom.u16(i + 1) });
      i = i + 3;
    } else if (op === 0x22 || op === 0x23) {
      ops.push({ op: op === 0x22 ? "monbg_static" : "clearmonbg_static", battler: BATTLER_NAMES[rom.get(i + 1)] ?? "target" });
      i = i + 2;
    } else if (op === 0x24) {
      const target_off = rom.ptrOffset(rom.u32(i + 1));
      ops.push({ op: "jumpifcontest", label: target_off !== undefined ? tostring(target_off) : undefined });
      i = i + 5;
      if (target_off !== undefined && !visited.has(target_off)) decode_script(rom, target_off, visited, labels, tag_dims);
    } else if (op === 0x2b) { // invisible
      ops.push({ op: "invisible", battler: BATTLER_NAMES[rom.get(i + 1)] ?? "attacker" });
      i = i + 2;
    } else if (op === 0x2c) { // visible
      ops.push({ op: "visible", battler: BATTLER_NAMES[rom.get(i + 1)] ?? "attacker" });
      i = i + 2;
    } else {
      // Fixed-size or unknown: step by known size, emit nop
      const sz = OP_FIXED[op] ?? 1;
      if (sz > 1 || (op >= 0x05 && op <= 0x2f)) ops.push({ op: "nop" });
      i = i + sz;
    }
  }

  // Ensure scripts always terminate
  if (ops.length === 0 || (ops[ops.length - 1]!.op !== "end" && ops[ops.length - 1]!.op !== "return")) ops.push({ op: "end" });
  return ops;
}

// ── Sprite sheet extraction ───────────────────────────────────────────────

// Lua: battle_anim_extract.lua:453 -- Decode GBA RGB555 palette bytes (32 bytes = 16 colors) to RGBA table.
// Color 0 is forced fully transparent (GBA OBJ convention).
function decode_palette(pal_bytes: Bytes): PalRgba {
  const pal: PalRgba = {};
  for (let ci = 0; ci <= 15; ci++) {
    const v = pal_bytes[ci * 2]! + pal_bytes[ci * 2 + 1]! * 256;
    const r = (v % 32) * 8;
    const g = (Math.floor(v / 32) % 32) * 8;
    const b = (Math.floor(v / 1024) % 32) * 8;
    pal[ci] = [r, g, b, ci === 0 ? 0 : 255];
  }
  return pal;
}

// Lua: battle_anim_extract.lua:469 -- 16 BGR555 ints (a sequence)
function pal_ints(pal_bytes: Bytes, off = 0): number[] {
  const out: number[] = [];
  for (let ci = 0; ci <= 15; ci++) out[ci] = ((pal_bytes[off + ci * 2] ?? 0) + (pal_bytes[off + ci * 2 + 1] ?? 0) * 256) & 0x7fff;
  return out;
}

/**
 * Lua: battle_anim_extract.lua:550 -- Encode RGBA pixels (a byte string or a
 * 0-based byte array) to PNG bytes (a byte string). His encoder writes the
 * same thing (filter 0 rows, stored deflate when love.data.compress is
 * absent); png.ts's encodePng does that here. PNGs are compared by pixels.
 */
function encode_png(pixels: string | Bytes, w: number, h: number): string {
  const n = w * h * 4;
  let rgba: Uint8Array;
  if (typeof pixels === "string") {
    rgba = new Uint8Array(n);
    rgba.set(toBytes(pixels.length > n ? pixels.slice(0, n) : pixels));
  } else if (pixels instanceof Uint8Array && pixels.length === n) {
    rgba = pixels;
  } else {
    rgba = new Uint8Array(n);
    for (let i = 0; i < n; i++) rgba[i] = (pixels[i] ?? 0) & 255;
  }
  return fromBytes(encodePng(w, h, rgba));
}

interface TagMeta {
  file: string; idxFile?: string; pal?: number[]; w: number; h: number; frameW: number; frameH: number;
}

// Lua: battle_anim_extract.lua:645 -- Extract every named sprite sheet in gBattleAnimPicTable.
function extract_tag_sheets(rom: Rom, cache: { write(rel: string, bytes: string): unknown }, root: string,
  _usedTags: Set<string>, tag_dims: Record<string, { w: number; h: number }> | undefined): Record<string, TagMeta> {
  const anim = Versions.BATTLE_ANIMS;
  const tags: Record<string, TagMeta> = {};
  if (!(anim && anim.pic_table)) return tags;

  const pic_base: number = anim.pic_table;
  const pal_base: number = anim.pal_table;
  const getj = (j: number): number => rom.get(j);

  for (let idx = 0; idx <= anim.tag_count - 1; idx++) {
    const name = TAG_NAMES[idx];
    if (!name) continue;

    // Read pic pointer (8-byte stride: ptr at +0, size at +4)
    const pic_off = rom.ptrOffset(rom.u32(pic_base + idx * 8));
    if (!(pic_off !== undefined && rom.get(pic_off) === 0x10)) continue;

    // Read pal pointer
    const pal_off = rom.ptrOffset(rom.u32(pal_base + idx * 8));
    if (pal_off === undefined) continue;

    // Decompress tile data
    let tile_bytes: Uint8Array;
    try { tile_bytes = Lz77.decompress(getj, pic_off)[0]; } catch { continue; }

    // Decode palette (32 bytes uncompressed, or LZ77 compressed)
    let pal_bytes: Bytes | undefined;
    if (rom.get(pal_off) === 0x10) {
      try { pal_bytes = Lz77.decompress(getj, pal_off)[0]; } catch { /* nil */ }
    } else {
      const pb: number[] = [];
      for (let pi = 0; pi <= 31; pi++) pb[pi] = rom.get(pal_off + pi);
      pal_bytes = pb;
    }
    if (!pal_bytes) continue;

    const pal = decode_palette(pal_bytes);
    const palInts = pal_ints(pal_bytes);

    // tile_bytes: raw 4bpp tile data. Each tile = 32 bytes = 8x8 pixels.
    // Tiles are arranged in columns determined by frame width.
    const total_bytes = tile_bytes.length;
    const tile_count = Math.floor(total_bytes / 32);
    if (tile_count <= 0) continue;

    const frame_w = tag_dims && tag_dims[name] ? tag_dims[name]!.w : undefined;
    const frame_h = tag_dims && tag_dims[name] ? tag_dims[name]!.h : undefined;
    let best_w = frame_w !== undefined ? Math.max(1, Math.floor(frame_w / 8)) : undefined;
    if (best_w === undefined) {
      best_w = 4;
      for (const w of [1, 2, 4, 8, 16]) if (w * w <= tile_count) best_w = w;
    }

    const img_w = best_w * 8;
    let img_h = Math.ceil(tile_count / best_w) * 8;
    if (img_h === 0) img_h = img_w;

    // Decode all tiles to RGBA
    const pixels = new Uint8Array(img_w * img_h * 4);
    const ipx = new Uint8Array(img_w * img_h * 4);
    for (let p = 3; p < ipx.length; p += 4) ipx[p] = 255;

    const tiles_wide = Math.floor(img_w / 8);
    for (let ti = 0; ti <= tile_count - 1; ti++) {
      const tx = ti % tiles_wide;
      const ty = Math.floor(ti / tiles_wide);
      // Each tile's 8 rows map to img_w-stride RGBA pixels
      for (let row = 0; row <= 7; row++) {
        const byte_base = ti * 32 + row * 4;
        for (let col = 0; col <= 3; col++) {
          const b = tile_bytes[byte_base + col] ?? 0;
          const lo = b % 16, hi = Math.floor(b / 16) % 16;
          const px = (ty * 8 + row) * img_w + tx * 8 + col * 2;
          const cl = pal[lo]!, ch = pal[hi]!;
          let base = px * 4;
          pixels[base] = cl[0]; pixels[base + 1] = cl[1]; pixels[base + 2] = cl[2]; pixels[base + 3] = cl[3];
          ipx[base] = ipx[base + 1] = ipx[base + 2] = lo * 17;
          base = base + 4;
          pixels[base] = ch[0]; pixels[base + 1] = ch[1]; pixels[base + 2] = ch[2]; pixels[base + 3] = ch[3];
          ipx[base] = ipx[base + 1] = ipx[base + 2] = hi * 17;
        }
      }
    }

    const png = encode_png(pixels, img_w, img_h);
    if (png && png.length > 0) {
      const rel = root + "/tags/" + name + ".png";
      if (cache && cache.write) cache.write(rel, png);
      const ipng = encode_png(ipx, img_w, img_h);
      let idxRel: string | undefined;
      if (ipng && ipng.length > 0 && cache && cache.write) {
        idxRel = "tags/" + name + ".idx.png";
        cache.write(root + "/" + idxRel, ipng);
      }
      tags[name] = {
        file: "tags/" + name + ".png",
        idxFile: idxRel,
        pal: palInts,
        w: img_w,
        h: img_h,
        frameW: frame_w ?? best_w * 8,
        frameH: frame_h ?? best_w * 8,
      };
    }
  }
  return tags;
}

// Lua: battle_anim_extract.lua:766
function lz_at(rom: Rom, ptr: number): Uint8Array | undefined {
  const off = rom.ptrOffset(ptr);
  if (!(off !== undefined && rom.get(off) === 0x10)) return undefined;
  try { return Lz77.decompress((j: number) => rom.get(j), off)[0]; } catch { return undefined; }
}

// Lua: battle_anim_extract.lua:774
function raw_at(rom: Rom, off: number, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i <= n - 1; i++) out[i] = rom.get(off + i);
  return out;
}

// Lua: battle_anim_extract.lua:780
function pal_bytes_at(rom: Rom, ptr: number): Bytes | undefined {
  const b = lz_at(rom, ptr);
  if (b) return b;
  const po = rom.ptrOffset(ptr);
  if (po === undefined) return undefined;
  return raw_at(rom, po, 32);
}

// Lua: battle_anim_extract.lua:788
function tag_pal_ints(rom: Rom, idx: number): number[] | undefined {
  const anim = Versions.BATTLE_ANIMS;
  if (!(anim && anim.pal_table)) return undefined;
  const b = pal_bytes_at(rom, rom.u32(anim.pal_table + idx * 8));
  if (!(b && b.length >= 32)) return undefined;
  const out: number[] = [];
  for (let k = 0; k <= Math.floor(b.length / 32) - 1; k++) {
    const row = pal_ints(b, k * 32);
    for (let i = 0; i < 16; i++) out[k * 16 + i] = row[i]!;
  }
  return out;
}

// Lua: battle_anim_extract.lua:801 -- [rgba, idx, w, h]
function decode_bg(tiles: Bytes, map: Bytes, palInts: number[], opaque0: boolean): [Uint8Array, Uint8Array, number, number] {
  const entries = Math.floor(map.length / 2);
  const mw = entries >= 2048 ? 64 : 32;
  const mh = Math.max(1, Math.min(32, Math.floor(entries / mw)));
  const w = mw * 8, h = mh * 8;
  const rgba = new Uint8Array(w * h * 4);
  const idx = new Uint8Array(w * h * 4);
  for (let p = 3; p < idx.length; p += 4) idx[p] = 255;
  const cols: [number, number, number][] = [];
  for (let ci = 0; ci <= 15; ci++) {
    const c = palInts[ci] ?? 0;
    cols[ci] = [(c & 31) * 8, ((c >>> 5) & 31) * 8, ((c >>> 10) & 31) * 8];
  }
  const ntiles = Math.floor(tiles.length / 32);
  for (let e = 0; e <= mw * mh - 1; e++) {
    const v = (map[e * 2] ?? 0) + (map[e * 2 + 1] ?? 0) * 256;
    const tile = v % 1024;
    const hf = Math.floor(v / 1024) % 2 === 1;
    const vf = Math.floor(v / 2048) % 2 === 1;
    const sbx = Math.floor(e / 1024);
    const inb = e % 1024;
    const tx = (inb % 32) + sbx * 32;
    const ty = Math.floor(inb / 32);
    if (tile < ntiles) {
      for (let row = 0; row <= 7; row++) {
        for (let col = 0; col <= 7; col++) {
          const b = tiles[tile * 32 + row * 4 + Math.floor(col / 2)] ?? 0;
          const ci = col % 2 === 0 ? b % 16 : Math.floor(b / 16);
          const dx = hf ? 7 - col : col;
          const dy = vf ? 7 - row : row;
          const o = ((ty * 8 + dy) * w + tx * 8 + dx) * 4;
          const c = cols[ci]!;
          rgba[o] = c[0]; rgba[o + 1] = c[1]; rgba[o + 2] = c[2];
          rgba[o + 3] = ci === 0 && !opaque0 ? 0 : 255;
          idx[o] = idx[o + 1] = idx[o + 2] = ci * 17;
        }
      }
    }
  }
  return [rgba, idx, w, h];
}

interface BgMeta { file: string; idxFile: string; pal: number[]; w: number; h: number; opaque0?: boolean }

// Lua: battle_anim_extract.lua:845
function write_bg(cache: Cache, root: string, key: string, tiles: Bytes, map: Bytes, palInts: number[], opaque0: boolean): BgMeta | undefined {
  const [rgba, idx, w, h] = decode_bg(tiles, map, palInts, opaque0);
  const rel = "animbg/" + key + ".png";
  const irel = "animbg/" + key + ".idx.png";
  const png = encode_png(rgba, w, h);
  const ipng = encode_png(idx, w, h);
  if (!(png && ipng && cache && cache.write)) return undefined;
  cache.write(root + "/" + rel, png);
  cache.write(root + "/" + irel, ipng);
  return { file: rel, idxFile: irel, pal: palInts, w, h, opaque0: opaque0 || undefined };
}

// Lua: battle_anim_extract.lua:858 -- pokefirered/src/graphics.c:705
function extract_named_bgs(rom: Rom, cache: Cache, root: string, out: Map<Key, BgMeta>): Map<Key, BgMeta> {
  const anim = Versions.BATTLE_ANIMS;
  const named = anim && anim.named_bgs;
  if (!named) return out;
  // (pairs order only orders the writes)
  for (const key of Object.keys(named)) {
    const e = named[key];
    let tiles: Bytes | undefined;
    if (e.gfx_raw) tiles = raw_at(rom, e.gfx_raw, e.gfx_size ?? 0x800);
    else tiles = lz_at(rom, e.gfx + 0x08000000);
    const map = lz_at(rom, e.map + 0x08000000);
    let palInts: number[] | undefined;
    if (e.pal_tag) {
      for (let i = 0; i <= (anim.tag_count ?? 289) - 1; i++) {
        if (TAG_NAMES[i] === e.pal_tag) palInts = tag_pal_ints(rom, i);
      }
    } else if (e.pal_raw) {
      palInts = pal_ints(raw_at(rom, e.pal_raw, 32));
    } else if (e.pal_white1) {
      palInts = new Array<number>(16).fill(0);
      palInts[1] = 0x7fff;
    } else if (e.pal) {
      const pb = lz_at(rom, e.pal + 0x08000000);
      palInts = pb ? pal_ints(pb) : undefined;
    }
    if (tiles && map && palInts) {
      const m = write_bg(cache, root, key, tiles, map, palInts, false);
      if (m) out.set(key, m); else out.delete(key);
    }
  }
  return out;
}

// Lua: battle_anim_extract.lua:893 -- pokefirered/src/data/battle_anim.h:1596
function extract_anim_bgs(rom: Rom, cache: Cache, root: string): Map<Key, BgMeta> {
  const anim = Versions.BATTLE_ANIMS;
  const base: number | undefined = anim && (anim.bg_table ?? (anim.pal_table && anim.tag_count ? anim.pal_table + anim.tag_count * 8 : undefined));
  const count: number = (anim && anim.bg_count) ?? 27;
  const out = new Map<Key, BgMeta>();
  if (!base) return out;
  const done: Record<string, BgMeta> = {};
  for (let id = 0; id <= count - 1; id++) {
    const imgPtr = rom.u32(base + id * 12);
    const palPtr = rom.u32(base + id * 12 + 4);
    const mapPtr = rom.u32(base + id * 12 + 8);
    const key = format("%08X_%08X_%08X", imgPtr, palPtr, mapPtr);
    if (done[key]) {
      out.set(id, done[key]!);
    } else {
      const tiles = lz_at(rom, imgPtr);
      const map = lz_at(rom, mapPtr);
      let palBytes: Bytes | undefined = lz_at(rom, palPtr);
      if (!palBytes) {
        const po = rom.ptrOffset(palPtr);
        if (po !== undefined) {
          const pb: number[] = [];
          for (let pi = 0; pi <= 31; pi++) pb[pi] = rom.get(po + pi);
          palBytes = pb;
        }
      }
      if (tiles && map && palBytes && palBytes.length >= 32) {
        const e = write_bg(cache, root, tostring(id), tiles, map, pal_ints(palBytes), true);
        if (e) {
          out.set(id, e);
          done[key] = e;
        }
      }
    }
  }
  return out;
}

interface StatMask { files: string[]; pals: [number, number, number][][] }

// Lua: battle_anim_extract.lua:931 -- pokefirered/src/battle_anim_utility_funcs.c:459
function extract_stat_mask(rom: Rom, cache: Cache, root: string): StatMask | undefined {
  const anim = Versions.BATTLE_ANIMS;
  if (!(anim && anim.stat_mask_gfx)) return undefined;
  const tiles = lz_at(rom, anim.stat_mask_gfx + 0x08000000);
  if (!tiles) return undefined;
  const out: StatMask = { files: [], pals: [] };
  for (let k = 1; k <= 8; k++) {
    const palOff: number = anim.stat_mask_pals && anim.stat_mask_pals[k] !== undefined ? anim.stat_mask_pals[k] : anim.stat_mask_pal + (k - 1) * 0x20;
    const pb = lz_at(rom, palOff + 0x08000000);
    if (!pb) return undefined;
    const pal = decode_palette(pb);
    const row: [number, number, number][] = [];
    for (let ci = 0; ci <= 15; ci++) row[ci] = [pal[ci]![0], pal[ci]![1], pal[ci]![2]];
    out.pals[k - 1] = row;
  }
  const ntiles = Math.floor(tiles.length / 32);
  const maps: number[] = [anim.stat_mask_tilemap1, anim.stat_mask_tilemap2];
  for (let mi = 1; mi <= maps.length; mi++) {
    const map = lz_at(rom, maps[mi - 1]! + 0x08000000);
    if (!map) return undefined;
    const pixels = new Uint8Array(256 * 256 * 4);
    for (let e = 0; e <= 1023; e++) {
      const v = map[e * 2]! + map[e * 2 + 1]! * 256;
      const tile = v % 1024;
      const hf = Math.floor(v / 1024) % 2 === 1;
      const vf = Math.floor(v / 2048) % 2 === 1;
      const tx = e % 32, ty = Math.floor(e / 32);
      if (tile < ntiles) {
        for (let r = 0; r <= 7; r++) {
          for (let c = 0; c <= 7; c++) {
            const b = tiles[tile * 32 + r * 4 + Math.floor(c / 2)] ?? 0;
            const ci = c % 2 === 0 ? b % 16 : Math.floor(b / 16);
            const dx = hf ? 7 - c : c;
            const dy = vf ? 7 - r : r;
            const i = ((ty * 8 + dy) * 256 + tx * 8 + dx) * 4;
            pixels[i] = pixels[i + 1] = pixels[i + 2] = ci * 16;
            pixels[i + 3] = ci === 0 ? 0 : 255;
          }
        }
      }
    }
    const png = encode_png(pixels, 256, 256);
    if (!png) return undefined;
    const rel = "statmask/" + tostring(mi) + ".png";
    cache.write(root + "/" + rel, png);
    out.files[mi - 1] = rel;
  }
  return out;
}

// ── Lua serializer ────────────────────────────────────────────────────────

/** The keys a Lua table built this way would have (undefined values are absent). */
function luaPairs(v: object): [Key, unknown][] {
  if (Array.isArray(v)) {
    const out: [Key, unknown][] = [];
    v.forEach((x, i) => { if (x !== undefined && x !== null) out.push([i + 1, x]); });
    return out;
  }
  if (v instanceof Map) {
    const out: [Key, unknown][] = [];
    for (const [k, x] of v) if (x !== undefined && x !== null) out.push([k, x]);
    return out;
  }
  const out: [Key, unknown][] = [];
  for (const k of Object.keys(v)) {
    const x = (v as Record<string, unknown>)[k];
    if (x !== undefined && x !== null) out.push([k, x]);
  }
  return out;
}

/** `#v` for the tables serialize sees: a sequence's length, else the 1..n border. */
function luaBorder(entries: [Key, unknown][]): number {
  const nums = new Set<number>();
  for (const [k] of entries) if (typeof k === "number") nums.add(k);
  let n = 0;
  while (nums.has(n + 1)) n++;
  return n;
}

// Lua: battle_anim_extract.lua:982
function serialize(v: unknown, indent = ""): string {
  if (v === undefined || v === null) return "nil";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return tostring(v);
  if (typeof v === "string") return format("%q", v);
  if (typeof v === "object") {
    const entries = luaPairs(v);
    const n = luaBorder(entries);
    let isArr = true;
    for (const [k] of entries) {
      if (typeof k !== "number" || k < 1 || k > n || k % 1 !== 0) isArr = false;
    }
    const get = new Map<Key, unknown>(entries);
    if (isArr && n > 0) {
      const parts = ["{"];
      for (let i = 1; i <= n; i++) {
        parts.push("\n" + indent + "  " + serialize(get.get(i), indent + "  ") + (i < n ? "," : ""));
      }
      parts.push("\n" + indent + "}");
      return parts.join("");
    }
    const keys = entries.map(([k]) => k);
    keys.sort((a, b) => {
      const ta = typeof a, tb = typeof b;
      if (ta === tb) {
        if (ta === "number") return (a as number) - (b as number);
        const sa = tostring(a), sb = tostring(b);
        return sa < sb ? -1 : sa > sb ? 1 : 0;
      }
      return ta < tb ? -1 : 1;
    });
    const parts = ["{"];
    const last = keys[keys.length - 1];
    for (const k of keys) {
      const key = typeof k === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? k : "[" + serialize(k) + "]";
      parts.push("\n" + indent + "  " + key + " = " + serialize(get.get(k), indent + "  ") + (k !== last ? "," : ""));
    }
    parts.push("\n" + indent + "}");
    return parts.join("");
  }
  return "nil";
}

// ── Generic fallback script (used when no pack is available) ──────────────

const GENERIC: Ops = [
  { op: "loadspritegfx", tag: "IMPACT", tag_idx: 135 },
  { op: "monbg", battler: "target" },
  { op: "createsprite", tag: "IMPACT", noGfx: undefined, w: 32, h: 32,
    animBattler: "attacker", subpriority: 2,
    args: [0, 0, -1, 2] }, // args[3]=-1 -> from HorizontalLunge noGfx template
  { op: "createsprite", tag: "IMPACT", w: 32, h: 32,
    animBattler: "attacker", subpriority: 2, args: [0, 0, 1, 2] },
  { op: "createvisualtask", task: "AnimTask_ShakeMon", priority: 2,
    args: [1, 3, 0, 6, 1] },
  { op: "waitforvisualfinish" },
  { op: "clearmonbg", battler: "target" },
  { op: "blendoff" },
  { op: "end" },
];

export interface BattleAnimOpts { force?: boolean; cacheRoot?: string; strict?: boolean; outPath?: string }
export interface BattleAnimResult { path: string; moveCount: number; tagCount: number; version: number; skipped?: boolean }

export const BattleAnimExtract = {
  FORMAT_VERSION: 5,
  CACHE_SUB: "pokemon/battle_anims",
  REQUIRED: ["pokemon/battle_anims/pack.lua"],

  encodePng: encode_png,
  /** (exposed for tests) the pack serializer */
  serialize,

  // Lua: battle_anim_extract.lua:1043
  ready(cache: Cache | undefined, cacheRoot?: string): boolean {
    const root = (cacheRoot ?? "data/generated/gba") + "/" + BattleAnimExtract.CACHE_SUB;
    const path = root + "/pack.lua";
    if (cache && cache.exists && cache.exists(path)) return true;
    if (cache && cache.read && cache.read(path) !== undefined) return true;
    return false;
  },

  // Lua: battle_anim_extract.lua:1055 -- Main extraction entry point.
  run(rom: Rom | undefined, cache: Cache | undefined, opts: BattleAnimOpts = {}): BattleAnimResult {
    const root = (opts.cacheRoot ?? "data/generated/gba") + "/" + BattleAnimExtract.CACHE_SUB;
    refresh_config();
    const strict = opts.strict === true;
    unresolved = strict ? {} : undefined;
    const failures: string[] = [];
    const fail = (msg: string): void => { failures.push(msg); };

    // Skip if already extracted and not forced
    if (!opts.force && BattleAnimExtract.ready(cache, opts.cacheRoot ?? "data/generated/gba")) {
      return { path: root + "/pack.lua", moveCount: V.move_count ?? 355, tagCount: 0, version: BattleAnimExtract.FORMAT_VERSION, skipped: true };
    }

    const anim = Versions.BATTLE_ANIMS;
    if (strict && !(rom && anim && anim.moves_table)) {
      throw new Error("battle_anim_extract: no ROM or BATTLE_ANIMS key table for this game");
    }
    if (!(rom && anim && anim.moves_table)) {
      // No ROM — write generic fallback
      const moves = new Map<Key, Ops>();
      for (let id = 0; id <= (V.move_count ?? 355) - 1; id++) moves.set(id, GENERIC);
      const pack = { version: BattleAnimExtract.FORMAT_VERSION, moves, labels: {}, tags: {} };
      const lua = "return " + serialize(pack) + "\n";
      if (cache && cache.write) cache.write(root + "/pack.lua", lua);
      console.log("[battle_anim_extract] no ROM — wrote generic fallback");
      return { path: root + "/pack.lua", moveCount: 0, tagCount: 0, version: BattleAnimExtract.FORMAT_VERSION };
    }

    // ── Step 1: Decode all move scripts ──────────────────────────────────
    const visited = new Set<number>();
    const labels = new Map<Key, Ops>(); // offset-string -> IR ops list
    const moves = new Map<Key, Ops>(); // [id] -> IR ops list
    const usedTags = new Set<string>(); // tag_name -> true
    const tagDims: Record<string, { w: number; h: number }> = {}; // tag_name -> { w=N, h=N }

    const moves_table: number = anim.moves_table;
    const move_count: number = anim.move_count ?? 355;

    console.log("[battle_anim_extract] decoding " + tostring(move_count) + " move scripts from ROM...");
    for (let id = 0; id <= move_count - 1; id++) {
      const off = rom.ptrOffset(rom.u32(moves_table + id * 4));
      if (off !== undefined) {
        const script = decode_script(rom, off, visited, labels, tagDims);
        moves.set(id, script);
        // Collect used tags
        for (const op of script) if (op.tag && op.tag !== "") usedTags.add(op.tag as string);
      } else {
        if (strict) fail(format("move %d has no script pointer", id));
        moves.set(id, GENERIC);
      }
    }

    let tag_count = 0;
    const decode_table = (base: number | undefined, count: number, names: Record<number, string> | undefined): [Map<Key, Ops>, Map<Key, string>] => {
      const out = new Map<Key, Ops>(), outNames = new Map<Key, string>();
      if (!base) return [out, outNames];
      for (let idx = 0; idx <= count - 1; idx++) {
        const off = rom.ptrOffset(rom.u32(base + idx * 4));
        if (off !== undefined) out.set(idx, decode_script(rom, off, visited, labels, tagDims));
        else {
          if (strict) fail(format("table 0x%06X entry %d has no script pointer", base, idx));
          out.set(idx, GENERIC);
        }
        outNames.set(idx, (names && names[idx]) || tostring(idx));
      }
      return [out, outNames];
    };

    const [general, generalNames] = decode_table(anim.general_table, anim.general_count ?? 28, Versions.BATTLE_ANIM_GENERAL_NAMES);
    const [special, specialNames] = decode_table(anim.special_table, anim.special_count ?? 7, Versions.BATTLE_ANIM_SPECIAL_NAMES);
    const [status, statusNames] = decode_table(anim.status_table, anim.status_count ?? 9, Versions.BATTLE_ANIM_STATUS_NAMES);

    // Collect tags from all label scripts too
    for (const script of labels.values()) {
      for (const op of script) if (op.tag && op.tag !== "") usedTags.add(op.tag as string);
    }

    tag_count = usedTags.size;
    console.log(format("[battle_anim_extract] %d moves decoded, %d unique tags", move_count, tag_count));

    // ── Step 2: Extract sprite sheets ───────────────────────────────────
    let tagMeta: Record<string, TagMeta> = {};
    if (cache) {
      console.log("[battle_anim_extract] extracting " + tostring(tag_count) + " sprite sheets...");
      tagMeta = extract_tag_sheets(rom, { write: (rel: string, bytes: string) => cache.write(rel, bytes) }, root, usedTags, tagDims);
      console.log(format("[battle_anim_extract] wrote %d tag PNGs", Object.keys(tagMeta).length));
    }
    const animBgs = cache ? extract_anim_bgs(rom, cache, root) : new Map<Key, BgMeta>();
    if (cache) extract_named_bgs(rom, cache, root, animBgs);
    const tagPals: Record<string, number[]> = {};
    for (let i = 0; i <= (anim.tag_count ?? 289) - 1; i++) {
      const nm = TAG_NAMES[i];
      if (nm) {
        const p = tag_pal_ints(rom, i);
        if (p) tagPals[nm] = p; else delete tagPals[nm];
      }
    }
    const bgPals: Record<string, number[]> = {};
    if (anim.muddy_water_pal) {
      const pb = lz_at(rom, anim.muddy_water_pal + 0x08000000);
      if (pb) bgPals.MUDDY_WATER = pal_ints(pb);
    }
    if (cache && anim.smokescreen_gfx && anim.smokescreen_pal) {
      const tb = lz_at(rom, anim.smokescreen_gfx + 0x08000000);
      const pb = lz_at(rom, anim.smokescreen_pal + 0x08000000);
      if (tb && pb) {
        const pal = decode_palette(pb);
        const palInts = pal_ints(pb);
        const ntiles = Math.floor(tb.length / 32);
        const w = 16, h = Math.ceil(ntiles / 2) * 8;
        const px = new Uint8Array(w * h * 4), ipx = new Uint8Array(w * h * 4);
        for (let p = 3; p < ipx.length; p += 4) ipx[p] = 255;
        for (let ti = 0; ti <= ntiles - 1; ti++) {
          const tx = ti % 2, ty = Math.floor(ti / 2);
          for (let row = 0; row <= 7; row++) {
            for (let col = 0; col <= 7; col++) {
              const b = tb[ti * 32 + row * 4 + Math.floor(col / 2)] ?? 0;
              const ci = col % 2 === 0 ? b % 16 : Math.floor(b / 16);
              const o = ((ty * 8 + row) * w + tx * 8 + col) * 4;
              const c = pal[ci]!;
              px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = c[3];
              ipx[o] = ipx[o + 1] = ipx[o + 2] = ci * 17;
            }
          }
        }
        const png = encode_png(px, w, h), ipng = encode_png(ipx, w, h);
        if (png && ipng) {
          cache.write(root + "/tags/TAG_SMOKESCREEN.png", png);
          cache.write(root + "/tags/TAG_SMOKESCREEN.idx.png", ipng);
          tagMeta.TAG_SMOKESCREEN = { file: "tags/TAG_SMOKESCREEN.png", idxFile: "tags/TAG_SMOKESCREEN.idx.png",
            pal: palInts, w, h, frameW: 16, frameH: 16 };
          tagPals.TAG_SMOKESCREEN = palInts;
        }
      }
    }
    if (cache && anim.substitute_pal) {
      const palBytes = lz_at(rom, anim.substitute_pal + 0x08000000);
      if (palBytes) {
        const pal = decode_palette(palBytes);
        // (pairs order only orders the two writes)
        for (const [key, off] of [["SUBSTITUTE_DOLL_FRONT", anim.substitute_front], ["SUBSTITUTE_DOLL_BACK", anim.substitute_back]] as [string, number | undefined][]) {
          const tb = off !== undefined ? lz_at(rom, off + 0x08000000) : undefined;
          if (tb && tb.length >= 2048) {
            const pixels = new Uint8Array(64 * 64 * 4);
            for (let ti = 0; ti <= 63; ti++) {
              const tx = ti % 8, ty = Math.floor(ti / 8);
              for (let row = 0; row <= 7; row++) {
                for (let col = 0; col <= 3; col++) {
                  const b = tb[ti * 32 + row * 4 + col] ?? 0;
                  const p = ((ty * 8 + row) * 64 + tx * 8 + col * 2) * 4;
                  const cl = pal[b % 16]!, ch = pal[Math.floor(b / 16) % 16]!;
                  pixels[p] = cl[0]; pixels[p + 1] = cl[1]; pixels[p + 2] = cl[2]; pixels[p + 3] = cl[3];
                  pixels[p + 4] = ch[0]; pixels[p + 5] = ch[1]; pixels[p + 6] = ch[2]; pixels[p + 7] = ch[3];
                }
              }
            }
            const png = encode_png(pixels, 64, 64);
            if (png && png.length > 0) {
              cache.write(root + "/tags/" + key + ".png", png);
              tagMeta[key] = { file: "tags/" + key + ".png", w: 64, h: 64, frameW: 64, frameH: 64 };
            }
          }
        }
      }
    }

    const statMask = cache ? extract_stat_mask(rom, cache, root) : undefined;

    if (strict) {
      const keys = Object.keys(unresolved!).sort();
      for (const k of keys) fail("unresolved " + unresolved![k]);
      for (const name of usedTags) if (!tagMeta[name]) fail("tag " + name + " has no sprite sheet");
      for (let id = 0; id <= (anim.bg_count ?? 27) - 1; id++) if (!animBgs.get(id)) fail("anim bg " + tostring(id) + " did not decode");
      for (const key of Object.keys(anim.named_bgs ?? {})) if (!animBgs.get(key)) fail("named anim bg " + key + " did not decode");
      if (anim.stat_mask_gfx && !statMask) fail("stat mask did not decode");
      if (anim.smokescreen_gfx && !tagMeta.TAG_SMOKESCREEN) fail("smokescreen did not decode");
      if (anim.substitute_pal && !(tagMeta.SUBSTITUTE_DOLL_FRONT && tagMeta.SUBSTITUTE_DOLL_BACK)) fail("substitute doll did not decode");
      if (anim.muddy_water_pal && !bgPals.MUDDY_WATER) fail("muddy water palette did not decode");
      unresolved = undefined;
      if (failures.length > 0) {
        throw new Error("battle_anim_extract: " + tostring(failures.length) + " failures:\n  " + failures.join("\n  "));
      }
    }

    // ── Step 3: Serialize pack ──────────────────────────────────────────
    const pack = {
      version: BattleAnimExtract.FORMAT_VERSION,
      moves,
      labels,
      tags: tagMeta,
      general,
      special,
      status,
      generalNames,
      specialNames,
      statusNames,
      animBgs,
      tagPals,
      bgPals,
      statMask,
    };

    const lua = "return " + serialize(pack) + "\n";
    if (cache && cache.write) cache.write(root + "/pack.lua", lua);
    // NOT FAITHFUL: opts.outPath (an io.open write without a cache) is not supported.

    return { path: root + "/pack.lua", moveCount: move_count, tagCount: tag_count, version: BattleAnimExtract.FORMAT_VERSION };
  },
};

export default BattleAnimExtract;
