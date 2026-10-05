// Port of gen1recomp src/import/gba/ow_extract.lua (GPLv3 + additional terms; see LICENSE.md).
// Extract FRLG overworld object graphics (4bpp pics + OBJ pals) from ROM.
// Pret: gObjectEventGraphicsInfoPointers + sObjectEventSpritePalettes.
// Lua differences: palettes keep the Lua's keys 0..15 as array indices;
// decoded frames are 0-based pixel arrays (the Lua's are 1-based); frames
// is a 0-based list of them.

import { Versions } from "./versions.ts";
import { Lz77 } from "./lz77.ts";
import { ExtractMapEvents } from "./extract_map_events.ts";
import { format, tonumber, tostring, char, fromBytes } from "./lua.ts";
import type { Cache } from "./cache.ts";
import type { Rom } from "./rom.ts";

type Pal = number[];

export interface OwInfo {
  tileTag: number; paletteTag: number; reflectionPaletteTag: number; size: number;
  width: number; height: number; paletteSlot: number; shadowSize: number; inanimate: boolean;
  tracks: number; imagesPtr: number; animsPtr: number;
}

export interface OwReflectionMappings {
  slotMap: Record<number, number>;
  paletteTagSets: Record<number, Record<number, number>>;
  playerSets: Record<number, Record<number, number>>;
  specialSets: Record<number, Record<number, number>>;
}

export interface OwSprite {
  graphicsId: number;
  width: number;
  height: number;
  frameCount: number;
  frames: number[][];
  paletteTag: number;
  palette: Pal;
  reflectionPaletteTag: number;
  paletteSlot: number;
  reflectionPaletteMappedTag: number | undefined;
  reflectionPalette: Pal | undefined;
  mappedReflectionPalette: Pal | undefined;
  inanimate: boolean;
}

export interface OwMeta {
  formatVersion: number; inanimate: boolean; graphicsId: number; width: number; height: number;
  frameCount: number; paletteTag: number; reflectionPaletteTag?: number; paletteSlot?: number;
  reflectionPaletteMappedTag?: number; palette?: Pal; reflectionPalette?: Pal; mappedReflectionPalette?: Pal;
}

interface AvatarPair { male: number; female: number; state?: string }
export interface OwAvatars {
  player: AvatarPair[];
  rival: AvatarPair[];
  linkFrlg: AvatarPair;
  linkRs: AvatarPair;
  stateFlags: { male: { gfx: number; flag: number }[]; female: { gfx: number; flag: number }[] };
}

export interface OwManifest {
  ow_version: number;
  sprites: Record<number, { width: number; height: number; frameCount: number; paletteTag: number; inanimate: boolean; atlasW: number; atlasH: number }>;
  avatars?: OwAvatars;
  count?: number;
  total?: number;
}

/** Lua's %s class (JS \s also matches bytes like 0xA0). */
const SP = "[ \\t\\n\\v\\f\\r]";

// Lua: ow_extract.lua:15
function u8(n: unknown): string {
  return char((tonumber(n) ?? 0) % 256);
}

// Lua: ow_extract.lua:19
function u16le(nIn: unknown): string {
  const n = (tonumber(nIn) ?? 0) % 65536;
  return char(n % 256, Math.floor(n / 256) % 256);
}

// Lua: ow_extract.lua:24 -- i 1-based, as the Lua
function read_u16(s: string, i: number): number {
  return s.charCodeAt(i - 1) + s.charCodeAt(i) * 256;
}

// Lua: ow_extract.lua:28
function gba_off(ptr: unknown): number | undefined {
  return Versions.gbaToFile(ptr);
}

// Lua: ow_extract.lua:32
function bgr555_to_rgb8(cIn: unknown): [number, number, number] {
  const c = (tonumber(cIn) ?? 0) % 32768;
  const r5 = c % 32;
  const g5 = Math.floor(c / 32) % 32;
  const b5 = Math.floor(c / 1024) % 32;
  return [Math.floor((r5 * 255) / 31 + 0.5), Math.floor((g5 * 255) / 31 + 0.5), Math.floor((b5 * 255) / 31 + 0.5)];
}

const PALETTE_TAG_NONE = 0xFFFF;

// Lua: ow_extract.lua:66
function read_paired_palette_sets(rom: Rom, offset: number, version: any): Record<number, Record<number, number>> | undefined {
  const sets: Record<number, Record<number, number>> = {};
  for (let i = 0; i <= 63; i++) {
    const row = offset + i * version.paired_palette_stride;
    const tag = rom.u16(row);
    const dataPtr = rom.u32(row + 4);
    if (dataPtr === 0) break;
    const dataOff = gba_off(dataPtr);
    if (dataOff === undefined) return undefined;
    const paletteTags: Record<number, number> = {};
    for (let reflectionType = 0; reflectionType <= version.paired_palette_count - 1; reflectionType++) {
      paletteTags[reflectionType] = rom.u16(dataOff + reflectionType * 2);
    }
    sets[tag] = paletteTags;
  }
  return sets;
}

// Lua: ow_extract.lua:120
function read_graphics_info(rom: Rom, infoOff: number): OwInfo {
  const tileTag = rom.u16(infoOff);
  const paletteTag = rom.u16(infoOff + 2);
  const reflectionPaletteTag = rom.u16(infoOff + 4);
  const size = rom.u16(infoOff + 6);
  let width = rom.u16(infoOff + 8);
  if (width >= 0x8000) width = width - 0x10000;
  let height = rom.u16(infoOff + 10);
  if (height >= 0x8000) height = height - 0x10000;
  const flags = rom.get(infoOff + 12);
  const tracks = rom.get(infoOff + 13);
  const imagesPtr = rom.u32(infoOff + 0x1C);
  const animsPtr = rom.u32(infoOff + 0x18);
  return {
    tileTag,
    paletteTag,
    reflectionPaletteTag,
    size,
    width: Math.abs(width),
    height: Math.abs(height),
    paletteSlot: flags % 16,
    shadowSize: Math.floor(flags / 16) % 4,
    inanimate: Math.floor(flags / 64) % 2 === 1,
    tracks,
    imagesPtr,
    animsPtr,
  };
}

const MAX_PIC_FRAMES = 32;
// Lua: setmetatable({}, { __mode = "k" })
const picStartsCache = new WeakMap<Rom, Record<string, Set<number>>>();

// Lua: ow_extract.lua:152 -- the set of pic table starts (Lua starts[off] = true)
function pic_table_starts(rom: Rom, pointers: number, num: number): Set<number> {
  let byRom = picStartsCache.get(rom);
  if (!byRom) { byRom = {}; picStartsCache.set(rom, byRom); }
  const key = tostring(pointers) + ":" + tostring(num);
  if (byRom[key]) return byRom[key]!;
  const starts = new Set<number>(), infos = new Set<number>();
  const add = (infoOff: number): boolean => {
    if (infos.has(infoOff)) return false;
    if (infoOff + 0x24 > rom.size || rom.u16(infoOff) !== 0xFFFF) return false;
    const animsOff = gba_off(rom.u32(infoOff + 0x18));
    const imagesOff = gba_off(rom.u32(infoOff + 0x1C));
    if (animsOff === undefined || imagesOff === undefined) return false;
    infos.add(infoOff);
    starts.add(imagesOff);
    return true;
  };
  for (let g = 0; g <= num - 1; g++) {
    const infoOff = gba_off(rom.u32(pointers + g * 4));
    if (infoOff !== undefined) add(infoOff);
  }
  // The Lua walks `known` in pairs() order; the resulting set does not depend on it.
  const known: number[] = [...infos];
  for (const off of known) {
    let nextOff = off + 0x24;
    while (add(nextOff)) nextOff = nextOff + 0x24;
  }
  byRom[key] = starts;
  return starts;
}

// Lua: ow_extract.lua:183 (pokefirered/src/data/object_events/object_event_pic_tables.h)
function pic_table_len(rom: Rom, imagesOff: number, frameBytes: number, starts: Set<number>): number {
  let n = 0;
  while (n < MAX_PIC_FRAMES) {
    const off = imagesOff + n * 8;
    if (n > 0 && starts.has(off)) break;
    if (off + 8 > rom.size) break;
    if (gba_off(rom.u32(off)) === undefined || rom.u16(off + 4) !== frameBytes) break;
    n = n + 1;
  }
  return n;
}

// Lua: ow_extract.lua:195
function sym_frame_count(imagesOff: number | undefined): number | undefined {
  const S = Versions.SYMS;
  if (!S || imagesOff === undefined) return undefined;
  for (const n of S.namesAt(imagesOff) as string[]) {
    if (n.includes("PicTable")) {
      let size: any;
      try { size = S.size(n); } catch { continue; }
      if (size && size > 0 && size % 8 === 0) return size / 8;
    }
  }
  return undefined;
}

// Lua: ow_extract.lua:208 -- one 4bpp frame (tile order L->R, T->B 8x8) -> 0-based indices [w*h]
function decode_frame_4bpp(raw: string | Uint8Array, width: number, height: number): number[] {
  const pixels: number[] = [];
  const tilesX = Math.floor(width / 8);
  const tilesY = Math.floor(height / 8);
  const nybble = (byteIndex: number, high: boolean): number => {
    let b: number;
    if (typeof raw === "string") {
      b = byteIndex < raw.length ? raw.charCodeAt(byteIndex) : 0;
    } else {
      b = raw[byteIndex] ?? 0;
    }
    if (high) return Math.floor(b / 16) % 16;
    return b % 16;
  };
  for (let ty = 0; ty <= tilesY - 1; ty++) {
    for (let tx = 0; tx <= tilesX - 1; tx++) {
      let tileIndex = ty * tilesX + tx;
      if (width === 128 && height === 64) {
        tileIndex = Math.floor(ty / 4) * 64 + Math.floor(tx / 8) * 32
          + (ty % 4) * 8 + (tx % 8);
      }
      const tileOff = tileIndex * 32;
      for (let y = 0; y <= 7; y++) {
        for (let x = 0; x <= 7; x++) {
          const byteIndex = tileOff + y * 4 + Math.floor(x / 2);
          const idx = nybble(byteIndex, x % 2 === 1);
          const px = tx * 8 + x;
          const py = ty * 8 + y;
          pixels[py * width + px] = idx;
        }
      }
    }
  }
  return pixels;
}

// Lua: ow_extract.lua:246
function load_frame_bytes(rom: Rom, dataPtr: number, nbytes: number): string | undefined {
  const off = gba_off(dataPtr);
  if (off === undefined) return undefined;
  // Uncompressed OW pics are the common case; try raw first. rom:readBytes
  // always returns a table (or raises), so the Lua's string and LZ fallback
  // branches are unreachable; the LZ fallback is kept for shape.
  const raw = rom.readBytes(off, nbytes);
  if (raw instanceof Uint8Array) {
    const s: string[] = [];
    for (let i = 0; i < nbytes; i++) s[i] = char(raw[i] ?? 0);
    return s.join("");
  }
  try {
    const [dec] = Lz77.decompress((i: number) => rom.get(i), off);
    return fromBytes(dec, 0, Math.min(nbytes, dec.length));
  } catch {
    return undefined;
  }
}

/** Lua's `cond and x or nil` with Lua truthiness for a possibly-0 number. */
function present<T>(v: T | undefined | null): v is T {
  return v !== undefined && v !== null;
}

export const OwExtract = {
  MAGIC: "SVOW",
  FORMAT_VERSION: 3,
  REQUIRED: ["ow/manifest.lua", "ow/palette_manifest.lua"],

  // Lua: ow_extract.lua:43 -- paletteTag -> 16 BGR555 colours from sObjectEventSpritePalettes
  loadPaletteTable(rom: Rom, version?: any): Record<number, Pal> {
    version = version ?? {};
    const tableOff: number = version.ow_sprite_palettes ?? Versions.OW_SPRITE_PALETTES;
    const palsByTag: Record<number, Pal> = {};
    for (let i = 0; i <= 63; i++) {
      const off = tableOff + i * 8;
      const dataPtr = rom.u32(off);
      const tag = rom.u16(off + 4);
      if (dataPtr === 0) break;
      const dataOff = gba_off(dataPtr);
      if (dataOff !== undefined && tag !== 0) {
        const colors: Pal = [];
        for (let c = 0; c <= 15; c++) colors[c] = rom.u16(dataOff + c * 2);
        palsByTag[tag] = colors;
      }
    }
    return palsByTag;
  },

  // Lua: ow_extract.lua:84
  loadReflectionMappings(rom: Rom, version?: any): OwReflectionMappings | undefined {
    version = version ?? Versions.OW_REFLECTION;
    if (!version) return undefined;
    const slotMap: Record<number, number> = {}, paletteTagSets: Record<number, Record<number, number>> = {};
    for (let slot = 0; slot <= version.palette_map_count - 1; slot++) {
      slotMap[slot] = rom.get(version.palette_map + slot);
    }
    for (let set = 0; set <= version.palette_set_count - 1; set++) {
      const ptr = gba_off(rom.u32(version.palette_tag_sets + set * 4));
      if (ptr === undefined) return undefined;
      const tags: Record<number, number> = {};
      for (let slot = 0; slot <= version.palette_tag_slot_count - 1; slot++) {
        tags[slot] = rom.u16(ptr + slot * 2);
      }
      paletteTagSets[set] = tags;
    }
    const playerSets = read_paired_palette_sets(rom, version.player_palette_sets, version);
    const specialSets = read_paired_palette_sets(rom, version.special_palette_sets, version);
    if (!playerSets || !specialSets) return undefined;
    return { slotMap, paletteTagSets, playerSets, specialSets };
  },

  // Lua: ow_extract.lua:110
  reflectionPaletteTag(info: OwInfo | undefined, mappings: OwReflectionMappings | undefined): number | undefined {
    if (!(info && mappings)) return undefined;
    const paired = mappings.playerSets[info.paletteTag] ?? mappings.specialSets[info.paletteTag];
    if (paired) return paired[0];
    const reflectionSlot = mappings.slotMap[info.paletteSlot];
    const defaultTags = mappings.paletteTagSets[0];
    // Lua: defaultTags[nil] is nil
    return defaultTags && reflectionSlot !== undefined ? defaultTags[reflectionSlot] : undefined;
  },

  // Lua: ow_extract.lua:274 -- [sprite] or [undefined, err]
  extractOne(rom: Rom, graphicsIdIn: unknown, palsByTag: Record<number, Pal> | undefined, version?: any,
    reflectionMappings?: OwReflectionMappings): [OwSprite | undefined, string?] {
    version = version ?? {};
    const pointers: number = version.ow_gfx_pointers ?? Versions.OW_GFX_POINTERS;
    const num: number = version.num_obj_event_gfx ?? Versions.NUM_OBJ_EVENT_GFX;
    const graphicsId = tonumber(graphicsIdIn) ?? 0;
    if (graphicsId < 0 || graphicsId >= num) {
      return [undefined, "graphicsId out of range"];
    }
    const infoPtr = rom.u32(pointers + graphicsId * 4);
    const infoOff = gba_off(infoPtr);
    if (infoOff === undefined) return [undefined, "bad info ptr"];
    const info = read_graphics_info(rom, infoOff);
    let w = info.width;
    const h = info.height;
    if (w < 8 || h < 8 || w > 128 || h > 128) {
      return [undefined, "bad dimensions"];
    }
    const imagesOff0 = gba_off(info.imagesPtr);
    const rawBytes = Math.floor((w * h) / 2);
    const exactFrames = sym_frame_count(imagesOff0);
    let frameCount = exactFrames;
    if (frameCount === undefined) {
      const starts = pic_table_starts(rom, pointers, num);
      frameCount = imagesOff0 !== undefined ? pic_table_len(rom, imagesOff0, rawBytes, starts) : 0;
    }
    if (frameCount < 1) frameCount = 1;

    // For Town Map (OBJ_EVENT_GFX_TOWN_MAP = 93) or 16x16 inanimate objects with 32x16 OAM allocation:
    // The sprite is a 16x16 tile image on the left; adjust width to 16 for proper 1:1 tile grid alignment.
    if (info.inanimate && w === 32 && h === 16) {
      w = 16;
    }

    const imagesOff = gba_off(info.imagesPtr);
    if (imagesOff === undefined) return [undefined, "bad images ptr"];

    const expected = Math.floor((w * h) / 2);
    const frames: number[][] = [];
    for (let i = 0; i <= frameCount - 1; i++) {
      const dataPtr = rom.u32(imagesOff + i * 8);
      let frameSize = rom.u16(imagesOff + i * 8 + 4);
      const foreign = exactFrames !== undefined && frameSize !== rawBytes;
      if (frameSize < 1) frameSize = expected;
      if (frameSize > expected * 4) frameSize = expected;
      const bytes = !foreign ? load_frame_bytes(rom, dataPtr, Math.max(frameSize, expected)) : undefined;
      if (bytes === undefined || bytes.length < expected) {
        // pad / blank
        const blank: number[] = [];
        for (let p = 0; p < w * h; p++) blank[p] = 0;
        frames[i] = blank;
      } else {
        frames[i] = decode_frame_4bpp(bytes, w, h);
      }
    }

    let pal = palsByTag ? palsByTag[info.paletteTag] : undefined;
    if (!pal) {
      pal = [];
      for (let c = 0; c <= 15; c++) pal[c] = 0;
    }
    const rawReflectPal = palsByTag ? palsByTag[info.reflectionPaletteTag] : undefined;
    const reflectTag = rawReflectPal ? OwExtract.reflectionPaletteTag(info, reflectionMappings) : undefined;
    const reflectPal = present(reflectTag) && palsByTag ? palsByTag[reflectTag] : undefined;

    return [{
      graphicsId,
      width: w,
      height: h,
      frameCount,
      frames,
      paletteTag: info.paletteTag,
      palette: pal,
      reflectionPaletteTag: info.reflectionPaletteTag,
      paletteSlot: info.paletteSlot,
      reflectionPaletteMappedTag: reflectTag,
      reflectionPalette: rawReflectPal,
      mappedReflectionPalette: reflectPal,
      inanimate: info.inanimate,
    }];
  },

  // Lua: ow_extract.lua:354 -- frames stacked vertically -> [rgba, w, h * n]
  bakeRgba(sprite: OwSprite): [string, number, number] {
    const w = sprite.width, h = sprite.height;
    const n = sprite.frameCount;
    const pal = sprite.palette;
    const rgb: [number, number, number][] = [];
    for (let c = 0; c <= 15; c++) rgb[c] = bgr555_to_rgb8(pal[c] ?? 0);
    const out = new Uint8Array(w * h * n * 4);
    let o = 0;
    for (let fi = 0; fi < n; fi++) {
      const frame = sprite.frames[fi]!;
      for (let py = 0; py <= h - 1; py++) {
        for (let px = 0; px <= w - 1; px++) {
          const idx = frame[py * w + px] ?? 0;
          if (idx === 0) {
            out[o] = 0; out[o + 1] = 0; out[o + 2] = 0; out[o + 3] = 0;
          } else {
            const c = rgb[idx] ?? rgb[0]!;
            out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2]; out[o + 3] = 255;
          }
          o += 4;
        }
      }
    }
    return [fromBytes(out), w, h * n];
  },

  // Lua: ow_extract.lua:383
  encodeMeta(sprite: OwSprite): string {
    const out = [
      OwExtract.MAGIC,
      u8(OwExtract.FORMAT_VERSION),
      u8(sprite.inanimate ? 1 : 0),
      u16le(sprite.graphicsId),
      u16le(sprite.width),
      u16le(sprite.height),
      u16le(sprite.frameCount),
      u16le(sprite.paletteTag ?? 0),
      u16le(sprite.reflectionPaletteTag ?? PALETTE_TAG_NONE),
      u8(sprite.paletteSlot ?? 0xFF),
      u16le(sprite.reflectionPaletteMappedTag ?? PALETTE_TAG_NONE),
      u8((sprite.reflectionPalette ? 1 : 0) + (sprite.mappedReflectionPalette ? 2 : 0)),
    ];
    for (let c = 0; c <= 15; c++) out.push(u16le(sprite.palette ? sprite.palette[c] ?? 0 : 0));
    for (let c = 0; c <= 15; c++) out.push(u16le(sprite.reflectionPalette ? sprite.reflectionPalette[c] ?? 0 : 0));
    for (let c = 0; c <= 15; c++) out.push(u16le(sprite.mappedReflectionPalette ? sprite.mappedReflectionPalette[c] ?? 0 : 0));
    return out.join("");
  },

  // Lua: ow_extract.lua:404 -- [meta] or [undefined, err]
  decodeMeta(blob: unknown): [OwMeta | undefined, string?] {
    if (typeof blob !== "string" || blob.length < 12 || blob.slice(0, 4) !== OwExtract.MAGIC) {
      return [undefined, "bad ow meta"];
    }
    const meta: OwMeta = {
      formatVersion: blob.charCodeAt(4),
      inanimate: blob.charCodeAt(5) === 1,
      graphicsId: read_u16(blob, 7),
      width: read_u16(blob, 9),
      height: read_u16(blob, 11),
      frameCount: read_u16(blob, 13),
      paletteTag: read_u16(blob, 15),
    };
    if (meta.formatVersion >= 2 && blob.length >= 118) {
      meta.reflectionPaletteTag = read_u16(blob, 17);
      meta.paletteSlot = blob.charCodeAt(18);
      meta.reflectionPaletteMappedTag = read_u16(blob, 20);
      const flags = blob.charCodeAt(21);
      meta.palette = [];
      meta.reflectionPalette = [];
      meta.mappedReflectionPalette = [];
      let off = 23;
      for (let c = 0; c <= 15; c++) { meta.palette[c] = read_u16(blob, off); off = off + 2; }
      for (let c = 0; c <= 15; c++) { meta.reflectionPalette[c] = read_u16(blob, off); off = off + 2; }
      for (let c = 0; c <= 15; c++) { meta.mappedReflectionPalette[c] = read_u16(blob, off); off = off + 2; }
      if (flags % 2 === 0) meta.reflectionPalette = undefined;
      if (Math.floor(flags / 2) % 2 === 0) meta.mappedReflectionPalette = undefined;
      if (meta.reflectionPaletteTag === PALETTE_TAG_NONE) meta.reflectionPaletteTag = undefined;
      if (meta.reflectionPaletteMappedTag === PALETTE_TAG_NONE) meta.reflectionPaletteMappedTag = undefined;
    }
    return [meta];
  },

  // Lua: ow_extract.lua:438 -- every OBJ_EVENT_GFX id (0 .. NUM-1)
  collectAllIds(version?: any): number[] {
    version = version ?? {};
    const num: number = version.num_obj_event_gfx ?? Versions.NUM_OBJ_EVENT_GFX ?? 152;
    const list: number[] = [];
    for (let g = 0; g <= num - 1; g++) list.push(g);
    return list;
  },

  // Lua: ow_extract.lua:449 -- graphicsIds used on Island 1 (+ player Red/Green)
  collectIsland1Ids(rom: Rom, version?: any): number[] {
    const ids = new Set<number>([0, 7]); // player
    let events: any;
    try { [events] = ExtractMapEvents.extractIsland1(rom, version); } catch { events = undefined; }
    if (events) {
      const byMap = events;
      for (const k of Object.keys(typeof byMap === "object" ? byMap : {})) {
        const ev = byMap[k];
        if (ev && typeof ev === "object" && ev.objects) {
          for (const obj of ev.objects) {
            const g = tonumber(obj.graphicsId ?? obj.graphics);
            if (g !== undefined) ids.add(g);
          }
        }
      }
    }
    for (const g of [
      16, 19, 22, 24, 30, 32, 35, 39, 40, 43, 44, 45, 46, 54, 56, 57,
      62, 64, 65, 69, 73, 89, 92, 96, 108,
    ]) {
      ids.add(g);
    }
    return [...ids].sort((a, b) => a - b);
  },

  // Lua: ow_extract.lua:476 (pokeemerald/src/field_player_avatar.c:234)
  readAvatars(rom: Rom, spec?: any): OwAvatars | undefined {
    spec = spec ?? Versions.PLAYER_AVATAR_GFX;
    if (!spec) return undefined;
    const genders: number = spec.genders;
    const pair = (off: number): AvatarPair => ({ male: rom.get(off), female: rom.get(off + 1) });
    // spec.stateNames is a Lua sequence (a JS array)
    const states = (off: number, n: number): AvatarPair[] => {
      const out: AvatarPair[] = [];
      for (let s = 0; s <= n - 1; s++) {
        out[s] = pair(off + s * genders);
        out[s]!.state = spec.stateNames[s] ?? tostring(s);
      }
      return out;
    };
    const flags: OwAvatars["stateFlags"] = { male: [], female: [] };
    (["male", "female"] as const).forEach((key, gi) => {
      const g = gi + 1;
      const base = spec.state_flags + (g - 1) * spec.state_flag_count * 2;
      for (let i = 0; i <= spec.state_flag_count - 1; i++) {
        flags[key][i] = { gfx: rom.get(base + i * 2), flag: rom.get(base + i * 2 + 1) };
      }
    });
    return {
      player: states(spec.player, spec.player_states),
      rival: states(spec.rival, spec.rival_states),
      linkFrlg: pair(spec.link_frlg),
      linkRs: pair(spec.link_rs),
      stateFlags: flags,
    };
  },

  // Lua: ow_extract.lua:532 -- write ow/* sheets; opts.all=true extracts every OBJ_EVENT_GFX (firered default)
  writeExtract(rom: Rom, cache: Cache, root?: string, version?: any, opts?: { all?: boolean; firered?: boolean }): OwManifest {
    root = root ?? "data/generated/gba";
    opts = opts ?? {};
    const owRoot = root + "/ow";
    version = version ?? Versions.lookup(rom.md5)[0] ?? {};
    const palsByTag = OwExtract.loadPaletteTable(rom, version);
    const reflectionMappings = OwExtract.loadReflectionMappings(rom, version.ow_reflection);
    let extractAll = opts.all;
    if (extractAll === undefined) {
      // Standalone firered cache wants the full table; Island-1 demake can pass all=false.
      extractAll = root.includes("data/generated/gba") || opts.firered === true;
    }
    const ids = extractAll ? OwExtract.collectAllIds(version) : OwExtract.collectIsland1Ids(rom, version);
    const manifest: OwManifest = {
      ow_version: Versions.OW_VERSION ?? 1,
      sprites: {},
    };
    let okCount = 0;
    for (const gid of ids) {
      const [spr, err] = OwExtract.extractOne(rom, gid, palsByTag, version, reflectionMappings);
      if (spr) {
        const [rgba, aw, ah] = OwExtract.bakeRgba(spr);
        const meta = OwExtract.encodeMeta(spr);
        cache.write(owRoot + "/" + tostring(gid) + ".meta", meta);
        cache.write(owRoot + "/" + tostring(gid) + ".rgba", rgba);
        manifest.sprites[gid] = {
          width: spr.width,
          height: spr.height,
          frameCount: spr.frameCount,
          paletteTag: spr.paletteTag,
          inanimate: spr.inanimate,
          atlasW: aw,
          atlasH: ah,
        };
        okCount = okCount + 1;
      } else {
        console.log("[ow] skip gfx " + tostring(gid) + ": " + tostring(err));
      }
    }
    const lines = [
      "return {\n",
      format("  ow_version = %d,\n", manifest.ow_version),
      format("  count = %d,\n", okCount),
      format("  total = %d,\n", ids.length),
      "  sprites = {\n",
    ];
    for (const gid of ids) {
      const s = manifest.sprites[gid];
      if (s) {
        lines.push(format("    [%d] = { width = %d, height = %d, frameCount = %d, paletteTag = %d, inanimate = %s, atlasW = %d, atlasH = %d },\n",
          gid, s.width, s.height, s.frameCount, s.paletteTag,
          s.inanimate ? "true" : "false", s.atlasW, s.atlasH));
      }
    }
    lines.push("  },\n");
    const avatars = OwExtract.readAvatars(rom);
    if (avatars) {
      manifest.avatars = avatars;
      lines.push(avatar_lines(avatars));
    }
    lines.push("}\n");
    cache.write(owRoot + "/manifest.lua", lines.join(""));
    const paletteLines = [
      "return {\n",
      "  format_version = 1,\n",
      format("  meta_format_version = %d,\n", OwExtract.FORMAT_VERSION),
      format("  count = %d,\n", okCount),
      "  sprites = {\n",
    ];
    for (const gid of ids) {
      if (manifest.sprites[gid]) {
        paletteLines.push(format("    [%d] = %d,\n", gid, OwExtract.FORMAT_VERSION));
      }
    }
    paletteLines.push("  },\n}\n");
    cache.write(owRoot + "/palette_manifest.lua", paletteLines.join(""));
    console.log(format("[ow] extracted %d / %d object graphics → %s", okCount, ids.length, owRoot));
    manifest.count = okCount;
    manifest.total = ids.length;
    return manifest;
  },

  // Lua: ow_extract.lua:615
  run(rom: Rom, cache: Cache, opts: { cacheRoot?: string; version?: any; all?: boolean; strict?: boolean } = {}): { count: number; total: number; avatars: boolean } {
    const manifest = OwExtract.writeExtract(rom, cache, opts.cacheRoot, opts.version, { all: opts.all !== false });
    if (opts.strict !== false && manifest.count !== manifest.total) {
      throw new Error(format("ow: extracted %d of %d object graphics", manifest.count, manifest.total));
    }
    return { count: manifest.count!, total: manifest.total!, avatars: manifest.avatars !== undefined };
  },

  // Lua: ow_extract.lua:624
  ready(cache: Cache | undefined, root?: string): boolean {
    root = root ?? "data/generated/gba";
    const manifest = cache ? cache.read(root + "/ow/manifest.lua") : undefined;
    const num = (s: string, re: RegExp): number | undefined => {
      const m = re.exec(s);
      return m ? tonumber(m[1]) : undefined;
    };
    if (typeof manifest !== "string"
        || num(manifest, new RegExp("ow_version" + SP + "*=" + SP + "*(\\d+)")) !== Versions.OW_VERSION) {
      return false;
    }
    if (Versions.active() !== "firered" && Versions.active() !== "leafgreen") return true;
    const paletteManifest = cache!.read(root + "/ow/palette_manifest.lua");
    if (typeof paletteManifest !== "string"
        || num(paletteManifest, new RegExp("meta_format_version" + SP + "*=" + SP + "*(\\d+)")) !== OwExtract.FORMAT_VERSION) {
      return false;
    }
    const countRe = new RegExp("count" + SP + "*=" + SP + "*(\\d+)");
    const expected = num(manifest, countRe);
    const total = num(manifest, new RegExp("total" + SP + "*=" + SP + "*(\\d+)"));
    if (expected === undefined || expected < 1 || expected !== total
        || num(paletteManifest, countRe) !== expected) {
      return false;
    }
    const seen = new Set<number>();
    let count = 0;
    const re = new RegExp("\\[" + SP + "*(\\d+)" + SP + "*\\]" + SP + "*=" + SP + "*(\\d+)" + SP + "*,", "g");
    for (const m of paletteManifest.matchAll(re)) {
      const gid = tonumber(m[1])!, formatVersion = tonumber(m[2]);
      if (formatVersion !== OwExtract.FORMAT_VERSION || seen.has(gid)
          || !manifest.includes("[" + tostring(gid) + "] = {")) {
        return false;
      }
      const blob = cache!.read(root + "/ow/" + tostring(gid) + ".meta");
      const [meta] = OwExtract.decodeMeta(blob);
      if (typeof blob !== "string" || blob.length < 118 || !meta
          || meta.formatVersion !== OwExtract.FORMAT_VERSION || meta.graphicsId !== gid) {
        return false;
      }
      seen.add(gid);
      count = count + 1;
    }
    return count === expected;
  },
};

// Lua: ow_extract.lua:507
function avatar_lines(av: OwAvatars): string {
  const out = ["  avatars = {\n"];
  for (const key of ["player", "rival"] as const) {
    out.push(format("    %s = {\n", key));
    for (const r of av[key]) {
      out.push(format("      { state = %q, male = %d, female = %d },\n", r.state, r.male, r.female));
    }
    out.push("    },\n");
  }
  for (const key of ["linkFrlg", "linkRs"] as const) {
    out.push(format("    %s = { male = %d, female = %d },\n", key, av[key].male, av[key].female));
  }
  out.push("    stateFlags = {\n");
  for (const g of ["male", "female"] as const) {
    out.push(format("      %s = {\n", g));
    for (const r of av.stateFlags[g]) {
      out.push(format("        { gfx = %d, flag = %d },\n", r.gfx, r.flag));
    }
    out.push("      },\n");
  }
  out.push("    },\n  },\n");
  return out.join("");
}

export default OwExtract;
