// Port of gen1recomp src/import/gba/native_pack.lua (GPLv3 + additional terms; see LICENSE.md).
// Encode/decode native FRLG mid atlas + palette + layout blobs.
// Pure (no LÖVE / no ROM). Shared by extract, register, and tests.
//
// Shapes: blobs are byte strings. Sequences (midIds, pixels, cells,
// borderMids) are 0-based (x[i] is the Lua's x[i + 1]); palettes are 0-based
// arrays as the Lua's [0]-keyed tables, and an RGB triple is [r, g, b].
// Mid sets (the Lua's `seen[mid] = true` tables) are Set<number>; a warp-cell
// set is a Set of warpKey numbers.

import { fromBytes, format, mod, tonumber } from "./lua.ts";
import { luaGet, luaLen } from "./luatable.ts";
import { Tileset, type BundleLike, type Palette } from "./tileset.ts";
import { Metatile, type IdxBuf } from "./metatile.ts";
import { Versions } from "./versions.ts";
import { Family } from "./family.ts";
import type { Cache } from "./cache.ts";
import type { Grid, Border } from "./maps.ts";
import { Profile } from "../../game/gen3/core/profile.ts";
import { CachePaths } from "../../game/gen3/core/cache_paths.ts";
import { CollPermissions as Coll } from "../../game/gen3/shared/core/CollPermissions.ts";
import { Collision } from "../../game/gen3/core/scripting/collision.ts";
import { VoidFill } from "../../game/gen3/core/void_fill.ts";

export interface IdxTable {
  formatVersion: number;
  flags: number;
  midCount: number;
  atlasCols: number;
  atlasRows: number;
  midIds: number[];
  pixels: ArrayLike<number>;
}

export interface MidLayoutCell { mid: number; coll: number; elev: number }

export interface MidLayout {
  formatVersion?: number;
  flags?: number;
  width: number;
  height: number;
  trueWidth?: number;
  trueHeight?: number;
  borderWidth?: number;
  borderHeight?: number;
  borderMids?: number[];
  cells?: MidLayoutCell[];
  pair?: string;
}

export interface DecodedPalettes {
  formatVersion: number;
  numPalsInPrimary: number;
  numPalsTotal: number;
  [slot: number]: number[];
}

type Rgb = [number, number, number];

/** Lua's ipairs over a sequence stored as a JS array or an integer-keyed object. */
function seq<T>(t: unknown): T[] {
  if (t === undefined || t === null || typeof t !== "object") return [];
  if (Array.isArray(t)) {
    const n = luaLen(t);
    return t.slice(0, n) as T[];
  }
  const n = luaLen(t as object);
  const out: T[] = [];
  for (let i = 1; i <= n; i++) out.push(luaGet(t as object, i) as T);
  return out;
}

// Lua: native_pack.lua:15
function u8(n: unknown): string {
  return String.fromCharCode(mod(tonumber(n) ?? 0, 256));
}

// Lua: native_pack.lua:19
function u16le(nIn: unknown): string {
  const n = mod(tonumber(nIn) ?? 0, 65536);
  return String.fromCharCode(n % 256, Math.floor(n / 256) % 256);
}

// Lua: native_pack.lua:24 (i is 1-based, as the Lua's)
function read_u16(s: string, i: number): number {
  return s.charCodeAt(i - 1) + s.charCodeAt(i) * 256;
}

// Lua: native_pack.lua:28
function bgr555_to_rgb8(cIn: unknown): Rgb {
  const c = mod(tonumber(cIn) ?? 0, 32768);
  const r5 = c % 32;
  const g5 = Math.floor(c / 32) % 32;
  const b5 = Math.floor(c / 1024) % 32;
  return [
    Math.floor(r5 * 255 / 31 + 0.5),
    Math.floor(g5 * 255 / 31 + 0.5),
    Math.floor(b5 * 255 / 31 + 0.5),
  ];
}

// Lua: native_pack.lua:42
function build_idx_with(compositeFn: (bundle: BundleLike, mid: number) => IdxBuf, bundle: BundleLike,
  midListIn: number[] | undefined, flags: number | undefined): IdxTable {
  const midList = midListIn ?? [];
  const midCount = midList.length;
  const atlasCols = 16;
  const atlasRows = Math.max(1, Math.ceil(midCount / atlasCols));
  const pixels = new Uint8Array(midCount * 256);
  midList.forEach((mid, i) => {
    const idxBuf = compositeFn(bundle, mid);
    pixels.set(idxBuf.subarray(0, 256), i * 256);
  });
  return {
    formatVersion: NativePack.FORMAT_VERSION,
    flags: flags ?? 0,
    midCount,
    atlasCols,
    atlasRows,
    midIds: midList,
    pixels,
  };
}

const DYNAMIC_MIDS_BY_PAIR: Record<string, number[]> = {
  network: [
    0x2D0, 0x2D1, 0x2D8, 0x2D9, 0x2E3, 0x2E4, 0x2EB, 0x2EC,
    0x308, 0x309, 0x30A, 0x30B, 0x310, 0x311, 0x312, 0x313,
    0x314, 0x315, 0x316, 0x317, 0x31C, 0x31E,
  ],
  pokemon_center: [
    0x2D0, 0x2D1, 0x2D8, 0x2D9, 0x2E3, 0x2E4, 0x2EB, 0x2EC,
    0x308, 0x309, 0x30A, 0x30B, 0x310, 0x311, 0x312, 0x313,
    0x314, 0x315, 0x316, 0x317, 0x31C, 0x31E,
  ],
  dept_store: [
    0x28D, 0x2D0, 0x2D1, 0x2D8, 0x2D9, 0x2E3, 0x2E4, 0x2EB, 0x2EC,
    0x308, 0x309, 0x30A, 0x30B, 0x310, 0x311, 0x312, 0x313,
    0x314, 0x315, 0x316, 0x317, 0x31C, 0x31E,
  ],
};

// Lua: native_pack.lua:399 -- every "g3:" string anywhere under v
function scriptTargets(v: unknown, out: string[]): void {
  if (typeof v === "string") {
    if (v.slice(0, 3) === "g3:") out.push(v);
  } else if (v !== null && typeof v === "object") {
    if (Array.isArray(v)) {
      for (const x of v) scriptTargets(x, out);
    } else {
      for (const k of Object.keys(v)) scriptTargets((v as Record<string, unknown>)[k], out);
    }
  }
}

// Lua: native_pack.lua:461
function addVoidFillMids(seen: Set<number>, borders: Record<string, Border> | undefined, pairName: string): void {
  const spec = Versions.TILESET_PAIRS && Versions.TILESET_PAIRS[pairName];
  if (!(spec && spec.primary === VoidFill.PRIMARY)) return;
  const sources = VoidFill.SOURCES;
  for (const k of Object.keys(sources)) {
    const mapId = sources[k]!;
    const border = borders && borders[mapId];
    for (const mid of (border && border.mids) || []) {
      if (mid < VoidFill.PRIMARY_MIDS) seen.add(mid);
    }
  }
}

export const NativePack = {
  MAGIC_IDX: "SVMI",
  MAGIC_PAL: "SVMP",
  MAGIC_MID: "SVML",
  FORMAT_VERSION: 1,

  // flags bit0: legacy flattened (pre dual-layer). bit1: under/over split.
  FLAG_FLAT: 1,
  FLAG_LAYERED: 2,

  // Lua: native_pack.lua:70 -- indexed mid atlas for one tileset pair
  // (legacy flat composite). midList: sorted ROM mid ids to include.
  buildIdx(bundle: BundleLike, midList: number[]): IdxTable {
    return build_idx_with(Metatile.compositeIndexed, bundle, midList, NativePack.FLAG_FLAT);
  },

  // Lua: native_pack.lua:75 -- under (BG3/BG1) + over (BG2) atlases matching
  // pret DrawMetatile layer split. [under, over, middle]
  buildLayeredIdx(bundle: BundleLike, midList: number[]): [IdxTable, IdxTable, IdxTable] {
    const under = build_idx_with(Metatile.compositeIndexedUnder, bundle, midList, NativePack.FLAG_LAYERED);
    const over = build_idx_with(Metatile.compositeIndexedOver, bundle, midList, NativePack.FLAG_LAYERED);
    const middle = build_idx_with(Metatile.compositeIndexedMiddle, bundle, midList, NativePack.FLAG_LAYERED);
    return [under, over, middle];
  },

  // Lua: native_pack.lua:85
  encodeIdx(tbl: Partial<IdxTable>): string {
    const parts: string[] = [
      NativePack.MAGIC_IDX,
      u8(tbl.formatVersion ?? NativePack.FORMAT_VERSION),
      u8(tbl.flags ?? 1),
      u16le(tbl.midCount ?? 0),
      u16le(tbl.atlasCols ?? 16),
      u16le(tbl.atlasRows ?? 1),
    ];
    for (const mid of tbl.midIds ?? []) {
      parts.push(u16le(mid));
    }
    const pix = tbl.pixels ?? [];
    const n = (tbl.midCount ?? 0) * 256;
    const chunk = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      chunk[i] = mod(pix[i] ?? 0, 256);
    }
    parts.push(fromBytes(chunk));
    return parts.join("");
  },

  // Lua: native_pack.lua:107 -- [table] or [undefined, err]; pixels decode
  // lazily on first read (the Lua's __index)
  decodeIdx(blob: unknown): [IdxTable?, string?] {
    if (typeof blob !== "string" || blob.length < 12 || blob.slice(0, 4) !== NativePack.MAGIC_IDX) {
      return [undefined, "bad mids.idx magic"];
    }
    const formatVersion = blob.charCodeAt(4);
    const flags = blob.charCodeAt(5);
    const midCount = read_u16(blob, 7);
    const atlasCols = read_u16(blob, 9);
    const atlasRows = read_u16(blob, 11);
    // The header comes from a file in the user-writable cache and was trusted:
    // an absurd midCount walks the pixel loop past the blob (read_u16 does not
    // bounds-check), and an absurd atlas sizes a ~4 TB buffer downstream in
    // bake_or_load.  Require the declared tables to fit the blob, and the
    // dimensions to be sane, before reading anything.
    const MAX_MIDS = 4096, MAX_ATLAS_TILES = 16384;
    if (midCount < 1 || atlasCols < 1 || atlasRows < 1) {
      return [undefined, "bad mids.idx dimensions"];
    }
    if (midCount > MAX_MIDS || atlasCols * atlasRows > MAX_ATLAS_TILES) {
      return [undefined, "mids.idx dimensions out of range"];
    }
    if (blob.length < 12 + midCount * 2 + midCount * 256) {
      return [undefined, "mids.idx truncated"];
    }
    const midIds: number[] = [];
    let off = 13;
    for (let i = 1; i <= midCount; i++) {
      midIds[i - 1] = read_u16(blob, off);
      off = off + 2;
    }
    const dataOff = off;
    const n = midCount * 256;
    const tbl = {
      formatVersion,
      flags,
      midCount,
      atlasCols,
      atlasRows,
      midIds,
    } as IdxTable;
    let pixels: Uint8Array | undefined;
    Object.defineProperty(tbl, "pixels", {
      enumerable: true,
      configurable: true,
      get() {
        if (!pixels) {
          pixels = new Uint8Array(n);
          for (let i = 1; i <= n; i++) {
            const k = dataOff + i - 2; // blob:byte(dataOff + i - 1), 0-based
            pixels[i - 1] = k < blob.length ? blob.charCodeAt(k) : 0;
          }
        }
        return pixels;
      },
    });
    return [tbl];
  },

  // Lua: native_pack.lua:159
  encodePalettes(mapPals: Palette[]): string {
    const parts: string[] = [
      NativePack.MAGIC_PAL,
      u8(NativePack.FORMAT_VERSION),
      u8(Tileset.NUM_PALS_IN_PRIMARY),
      u8(Tileset.NUM_PALS_TOTAL),
      u8(0),
    ];
    for (let p = 0; p <= 15; p++) {
      const colors = mapPals[p] ?? mapPals[0] ?? [];
      for (let c = 0; c <= 15; c++) {
        parts.push(u16le(colors[c] ?? 0));
      }
    }
    return parts.join("");
  },

  // Lua: native_pack.lua:176 -- [pals] or [undefined, err]
  decodePalettes(blob: unknown): [DecodedPalettes?, string?] {
    if (typeof blob !== "string" || blob.length < 8 + 16 * 16 * 2
      || blob.slice(0, 4) !== NativePack.MAGIC_PAL) {
      return [undefined, "bad palettes.bin magic"];
    }
    const pals = {
      formatVersion: blob.charCodeAt(4),
      numPalsInPrimary: blob.charCodeAt(5),
      numPalsTotal: blob.charCodeAt(6),
    } as DecodedPalettes;
    let off = 9;
    for (let p = 0; p <= 15; p++) {
      const colors: number[] = [];
      for (let c = 0; c <= 15; c++) {
        colors[c] = read_u16(blob, off);
        off = off + 2;
      }
      pals[p] = colors;
    }
    return [pals];
  },

  // Lua: native_pack.lua:199 -- BGR555 pals → RGB8 tables for bake / tint
  palsToRgb8(mapPals: ArrayLike<number[] | undefined> | Record<number, number[] | undefined>): Rgb[][] {
    const out: Rgb[][] = [];
    const src0 = (mapPals as Record<number, number[] | undefined>);
    for (let p = 0; p <= 15; p++) {
      const src = src0[p] ?? src0[0] ?? [];
      const colors: Rgb[] = [];
      for (let c = 0; c <= 15; c++) {
        colors[c] = bgr555_to_rgb8(src[c] ?? 0);
      }
      out[p] = colors;
    }
    return out;
  },

  // Lua: native_pack.lua:215 -- bake indexed atlas + RGB8 pals → contiguous
  // RGBA8 string (w*h*4 bytes). [rgba, w, h]; rgba undefined when cancelled.
  // opts.transparentZero: indexed byte 0 → alpha 0 (overhead / BG2 top layer).
  bakeRgba(idxTbl: Partial<IdxTable>, rgbPals: Rgb[][], opts?: { transparentZero?: boolean; cancelled?: () => boolean }): [string | undefined, number, number] {
    opts = opts ?? {};
    const transparentZero = opts.transparentZero === true;
    const midCount = idxTbl.midCount ?? 0;
    const cols = idxTbl.atlasCols ?? 16;
    const rows = idxTbl.atlasRows ?? Math.max(1, Math.ceil(midCount / cols));
    const w = cols * 16, h = rows * 16;
    const lut: number[][] = [];
    for (let byte = 0; byte <= 255; byte++) {
      if (transparentZero && byte === 0) {
        lut[0] = [0, 0, 0, 0];
      } else {
        const palSlot = Math.floor(byte / 16) % 16;
        const colorIndex = byte % 16;
        const pal = rgbPals[palSlot] ?? rgbPals[0];
        const rgb = (pal && pal[colorIndex]) || [0, 0, 0];
        lut[byte] = [(rgb[0] ?? 0) & 255, (rgb[1] ?? 0) & 255, (rgb[2] ?? 0) & 255, 255];
      }
    }
    // Fill atlas by mid slot: slot i occupies atlas cell (i%cols, floor(i/cols)).
    const pixels = idxTbl.pixels ?? [];
    const out = new Uint8Array(w * h * 4);
    let o = 0;
    for (let ay = 0; ay <= h - 1; ay++) {
      if (ay % 16 === 0 && opts.cancelled && opts.cancelled()) return [undefined, w, h];
      const midRow = Math.floor(ay / 16);
      const py = ay % 16;
      for (let ax = 0; ax <= w - 1; ax++) {
        const midCol = Math.floor(ax / 16);
        const px = ax % 16;
        const slot = midRow * cols + midCol; // 0-based atlas slot
        let byte = 0;
        if (slot < midCount) {
          const base = slot * 256;
          byte = pixels[base + py * 16 + px] ?? 0;
        }
        const c = lut[byte] ?? lut[0]!;
        out[o] = c[0]!; out[o + 1] = c[1]!; out[o + 2] = c[2]!; out[o + 3] = c[3]!;
        o += 4;
      }
    }
    return [fromBytes(out), w, h];
  },

  // Lua: native_pack.lua:258
  encodeMidLayout(layout: MidLayout): string {
    const parts: string[] = [
      NativePack.MAGIC_MID,
      u8(layout.formatVersion ?? NativePack.FORMAT_VERSION),
      u8(layout.flags ?? 0),
      u16le(layout.width),
      u16le(layout.height),
      u16le(layout.trueWidth ?? layout.width),
      u16le(layout.trueHeight ?? layout.height),
      u8(layout.borderWidth ?? 1),
      u8(layout.borderHeight ?? 1),
    ];
    const bw = layout.borderWidth ?? 1;
    const bh = layout.borderHeight ?? 1;
    const border = layout.borderMids ?? [];
    for (let i = 1; i <= bw * bh; i++) {
      parts.push(u16le(border[i - 1] ?? 0));
    }
    const cells = layout.cells ?? [];
    const n = (layout.width ?? 0) * (layout.height ?? 0);
    const body = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
      const c = cells[i] ?? { mid: 0, coll: 0xff, elev: 0 };
      const mid = mod(tonumber(c.mid ?? 0) ?? 0, 65536);
      body[i * 4] = mid % 256;
      body[i * 4 + 1] = Math.floor(mid / 256) % 256;
      body[i * 4 + 2] = mod(tonumber(c.coll ?? 0) ?? 0, 256);
      body[i * 4 + 3] = mod(tonumber(c.elev ?? 0) ?? 0, 256);
    }
    parts.push(fromBytes(body));
    return parts.join("");
  },

  // Lua: native_pack.lua:287 -- [layout] or [undefined, err]
  decodeMidLayout(blob: unknown): [(MidLayout & { borderMids: number[]; cells: MidLayoutCell[] })?, string?] {
    if (typeof blob !== "string" || blob.length < 14 || blob.slice(0, 4) !== NativePack.MAGIC_MID) {
      return [undefined, "bad layout.mid magic"];
    }
    const byte = (i: number): number => blob.charCodeAt(i - 1);
    const formatVersion = byte(5);
    const flags = byte(6);
    const width = read_u16(blob, 7);
    const height = read_u16(blob, 9);
    const trueWidth = read_u16(blob, 11);
    const trueHeight = read_u16(blob, 13);
    const borderWidth = byte(15);
    const borderHeight = byte(16);
    let off = 17;
    const borderMids: number[] = [];
    for (let i = 1; i <= borderWidth * borderHeight; i++) {
      borderMids[i - 1] = read_u16(blob, off);
      off = off + 2;
    }
    const cells: MidLayoutCell[] = [];
    const n = width * height;
    for (let i = 1; i <= n; i++) {
      const mid = read_u16(blob, off);
      const coll = byte(off + 2);
      const elev = byte(off + 3);
      cells[i - 1] = { mid, coll, elev };
      off = off + 4;
    }
    return [{
      formatVersion,
      flags,
      width,
      height,
      trueWidth,
      trueHeight,
      borderWidth,
      borderHeight,
      borderMids,
      cells,
    }];
  },

  // pokefirered/src/field_specials.c:283
  PC_ON_BY_OFF: {
    [0x062]: 0x063, // pokefirered/include/constants/metatile_labels.h:6
    [0x28F]: 0x28A, // pokefirered/include/constants/metatile_labels.h:75
  } as Record<number, number>,

  // Lua: native_pack.lua:352
  addDynamicMids(seen: Set<number>, pairName: string): Set<number> {
    const spec = Versions.TILESET_PAIRS && Versions.TILESET_PAIRS[pairName];
    if (!spec) return seen;
    for (const rule of seq<any>(Versions.DYNAMIC_METATILES ?? [])) {
      for (const name of [spec.primary, spec.secondary]) {
        if (name === undefined || name === null) break; // ipairs stops at a nil
        const ts = Versions.TILESETS[name];
        if (ts && ts.metatiles === rule.metatiles) {
          for (const mid of seq<number>(rule.mids)) seen.add(mid);
        }
      }
    }
    return seen;
  },

  // Lua: native_pack.lua:366
  addPcOnMids(seen: Set<number>): Set<number> {
    for (const k of Object.keys(NativePack.PC_ON_BY_OFF)) {
      const off = Number(k);
      if (seen.has(off)) seen.add(NativePack.PC_ON_BY_OFF[off]!);
    }
    return seen;
  },

  // pokefirered/include/fieldmap.h:9
  NUM_METATILES_TOTAL: 1024,

  ATLAS_POLICY: { frlg: "used", rse: "full" } as Record<string, string>,

  // Lua: native_pack.lua:378
  atlasPolicy(game?: string): string {
    const F = game ? Family.of(game) : Family.active();
    let row: any;
    try {
      row = Profile.of(F.game);
    } catch {
      row = undefined;
    }
    const fromProfile = row !== undefined && row !== null && typeof row === "object" && row.map !== null && typeof row.map === "object"
      ? row.map.atlas : undefined;
    return fromProfile || NativePack.ATLAS_POLICY[F.name] || "used";
  },

  // Lua: native_pack.lua:387 -- pokeemerald/include/fieldmap.h:4
  fullMidsForPair(bundle: BundleLike): number[] {
    const F = Family.active();
    const list: number[] = [];
    const nPri = Math.min(bundle.primaryMt ? bundle.primaryMt.count : 0, F.numPrimaryMetatiles);
    for (let mid = 0; mid <= nPri - 1; mid++) list.push(mid);
    const nSec = Math.min(bundle.secondaryMt ? bundle.secondaryMt.count : 0,
      F.numMetatilesTotal - F.numPrimaryMetatiles);
    for (let i = 0; i <= nSec - 1; i++) list.push(F.numPrimaryMetatiles + i);
    if (list.length === 0) list[0] = 0;
    return list;
  },

  // Lua: native_pack.lua:408 -- pokefirered/src/scrcmd.c:2103
  // Mids that setmetatile can place, per pair: { [pair]: Set<mid> }.
  // A script row is an object whose positional args are integer keys (or an
  // array); row[3] is read with luaGet, as the Lua's row[3].
  scriptMidsByPair(scriptsIn: any, eventsIn: any, pairOf: (mapId: string) => string | undefined): Record<string, Set<number>> {
    const out: Record<string, Set<number>> = {};
    if (scriptsIn === null || typeof scriptsIn !== "object" || eventsIn === null || typeof eventsIn !== "object") return out;
    const scripts = scriptsIn.scripts || scriptsIn;
    const events = eventsIn.events || eventsIn;
    for (const mapId of Object.keys(events)) {
      const ev = events[mapId];
      const pairName = ev !== null && typeof ev === "object" ? pairOf(mapId) : undefined;
      if (pairName) {
        const stack: string[] = [];
        const visited = new Set<string>();
        scriptTargets(ev, stack);
        while (stack.length > 0) {
          const key = stack.pop()!;
          if (!visited.has(key)) {
            visited.add(key);
            const rows = scripts[key];
            if (rows !== null && typeof rows === "object") {
              for (const row of seq<any>(rows)) {
                if (row !== null && typeof row === "object") {
                  if (row.op === "setmetatile") {
                    const mid = tonumber(luaGet(row, 3));
                    if (mid !== undefined && mid >= 0 && mid < NativePack.NUM_METATILES_TOTAL) {
                      out[pairName] = out[pairName] ?? new Set();
                      out[pairName]!.add(mid);
                    }
                  }
                  scriptTargets(row, stack);
                }
              }
            }
          }
        }
      }
    }
    return out;
  },

  WARP_KEY_STRIDE: 4096,

  // Lua: native_pack.lua:446
  warpKey(x: number, y: number): number {
    return y * NativePack.WARP_KEY_STRIDE + x;
  },

  // Lua: native_pack.lua:451 -- pokefirered/src/event_object_movement.c:4835
  resolveLayoutColl(coll: number, mapColl: number | undefined, hasWarp: boolean | undefined): number {
    if ((mapColl ?? 0) === 0) return coll;
    if (Coll.isLedge(coll)) return coll;
    // pokefirered/src/field_control_avatar.c:987
    if (hasWarp && coll >= 0x60 && coll <= 0x7F) return coll;
    if (!Coll.isWalkable(coll)) return coll;
    return Collision.seed("BLOCKED");
  },

  // Lua: native_pack.lua:474 -- unique mids used by grids + borders for a pair
  collectMidsForPair(grids: Record<string, Grid> | undefined, borders: Record<string, Border> | undefined,
    pairName: string, scriptMids?: Record<string, Set<number>>): number[] {
    const seen = new Set<number>();
    for (const mid of (scriptMids && scriptMids[pairName]) || []) {
      seen.add(mid);
    }
    addVoidFillMids(seen, borders, pairName);
    for (const grid of Object.values(grids ?? {})) {
      if ((grid.pair ?? "sevii_outdoor") === pairName) {
        for (const cell of grid.cells ?? []) {
          seen.add(cell.mid);
        }
      }
    }
    for (const mapId of Object.keys(borders ?? {})) {
      const border = borders![mapId]!;
      const grid = grids && grids[mapId];
      const spec = Versions.MAPS[mapId];
      if (((grid && grid.pair) || (spec && spec.pair) || "sevii_outdoor") === pairName) {
        for (const mid of border.mids ?? []) {
          seen.add(mid);
        }
      }
    }
    if (DYNAMIC_MIDS_BY_PAIR[pairName]) {
      for (const mid of DYNAMIC_MIDS_BY_PAIR[pairName]!) {
        seen.add(mid);
      }
    }
    NativePack.addDynamicMids(seen, pairName);
    NativePack.addPcOnMids(seen);
    seen.add(0); // void / default border
    const list = Array.from(seen);
    list.sort((a, b) => a - b);
    return list;
  },

  // Lua: native_pack.lua:514 -- write all native blobs for the extract.
  // grids: padded map grids; borders: mapId → { width, height, mids }
  // midIndex: optional [pair][mid] = { coll, ... } for resolved COLL_* lookup
  // fromCell: (mid, rawColl, behavior, kind) → [collByte, ...]
  writeExtract(cache: Cache, root: string | undefined, bundles: Record<string, BundleLike>,
    grids: Record<string, Grid>, borders: Record<string, Border>, pairNames: string[] | undefined,
    midIndex: Record<string, Record<number, { coll?: number }>> | undefined,
    behaviorOf: ((bundle: BundleLike, mid: number) => number) | undefined,
    fromCell: ((mid: number, mapColl: number | undefined, behavior: number, kind?: string) => [number, ...unknown[]]) | undefined,
    scriptMids?: Record<string, Set<number>>, warpCells?: Record<string, Set<number>>,
    opts?: { midLists?: Record<string, number[]> }): { native_version: number; pairs: Record<string, any>; layouts: Record<string, any> } {
    root = root ?? CachePaths.CACHE_ROOT;
    const midLists = opts && opts.midLists;
    const NativeRoot = root + "/native";
    const manifest = {
      native_version: (Versions.NATIVE_VERSION ?? 1) as number,
      pairs: {} as Record<string, { midCount: number; atlasCols: number; atlasRows: number; layered: boolean }>,
      layouts: {} as Record<string, { pair: string; width: number; height: number; file: string }>,
    };

    for (const pairName of pairNames ?? []) {
      const bundle = bundles[pairName];
      if (bundle) {
        const midList = (midLists && midLists[pairName])
          || NativePack.collectMidsForPair(grids, borders, pairName, scriptMids);
        const [underTbl, overTbl, middleTbl] = NativePack.buildLayeredIdx(bundle, midList);
        const palBlob = NativePack.encodePalettes(bundle.mapPals!);
        const pairDir = NativeRoot + "/" + pairName;
        cache.write(pairDir + "/mids.idx", NativePack.encodeIdx(underTbl));
        cache.write(pairDir + "/mids_over.idx", NativePack.encodeIdx(overTbl));
        cache.write(pairDir + "/mids_mid.idx", NativePack.encodeIdx(middleTbl));
        cache.write(pairDir + "/palettes.bin", palBlob);
        manifest.pairs[pairName] = {
          midCount: underTbl.midCount,
          atlasCols: underTbl.atlasCols,
          atlasRows: underTbl.atlasRows,
          layered: true,
        };
      }
    }

    for (const mapId of Object.keys(grids ?? {})) {
      const grid = grids[mapId]!;
      const pairName = grid.pair ?? "sevii_outdoor";
      const bundle = bundles[pairName];
      const indexForPair = (midIndex && midIndex[pairName]) || {};
      const mapWarps = warpCells ? warpCells[grid.altOwner ?? mapId] : undefined;
      const trueW = grid.padded_from ? grid.padded_from.width : grid.width;
      const trueH = grid.padded_from ? grid.padded_from.height : grid.height;
      const border = (borders && borders[mapId]) || { width: 1, height: 1, mids: [0] };
      const cells: MidLayoutCell[] = [];
      (grid.cells ?? []).forEach((cell, i) => {
        // Prefer per-cell classify (mapColl + kind). midIndex is first-sight and
        // wrongly solidifies indoor carpets that share outdoor TREE mid numbers.
        let coll = 0xff;
        if (fromCell && behaviorOf && bundle) {
          const beh = behaviorOf(bundle, cell.mid);
          coll = fromCell(cell.mid, cell.coll, beh, grid.kind)[0];
        } else {
          const mi = indexForPair[cell.mid];
          if (mi && mi.coll !== undefined && mi.coll !== null) {
            coll = mi.coll;
          } else {
            coll = cell.coll ?? 0;
          }
        }
        const cx = i % grid.width;
        const cy = Math.floor(i / grid.width);
        coll = NativePack.resolveLayoutColl(coll, cell.coll,
          mapWarps ? mapWarps.has(cy * NativePack.WARP_KEY_STRIDE + cx) : undefined);
        cells[i] = { mid: cell.mid, coll, elev: cell.elev ?? 0 };
      });
      const layout: MidLayout = {
        formatVersion: NativePack.FORMAT_VERSION,
        flags: grid.padded_from ? 1 : 0,
        width: grid.width,
        height: grid.height,
        trueWidth: trueW,
        trueHeight: trueH,
        borderWidth: border.width ?? 1,
        borderHeight: border.height ?? 1,
        borderMids: border.mids ?? [0],
        cells,
        pair: pairName,
      };
      const blob = NativePack.encodeMidLayout(layout);
      cache.write(NativeRoot + "/layouts/" + mapId + ".mid", blob);
      // pokefirered/src/scrcmd.c:711
      if (grid.altLayoutId === undefined || grid.altLayoutId === null) {
        manifest.layouts[mapId] = {
          pair: pairName,
          width: layout.width,
          height: layout.height,
          file: "layouts/" + mapId + ".mid",
        };
      }
    }

    const lines: string[] = [
      "return {\n",
      format("  native_version = %d,\n", manifest.native_version),
      "  pairs = {\n",
    ];
    for (const pairName of pairNames ?? []) {
      const p = manifest.pairs[pairName];
      if (p) {
        lines.push(format("    [%q] = { midCount = %d, atlasCols = %d, atlasRows = %d, layered = true },\n",
          pairName, p.midCount, p.atlasCols, p.atlasRows));
      }
    }
    lines.push("  },\n  layouts = {\n");
    const mapIds = Object.keys(manifest.layouts);
    mapIds.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const mapId of mapIds) {
      const L = manifest.layouts[mapId]!;
      lines.push(format("    [%q] = { pair = %q, width = %d, height = %d, file = %q },\n",
        mapId, L.pair, L.width, L.height, L.file));
    }
    lines.push("  },\n}\n");
    cache.write(NativeRoot + "/manifest.lua", lines.join(""));
    return manifest;
  },

  bgr555ToRgb8: bgr555_to_rgb8,
};

export default NativePack;
