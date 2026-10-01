// A Game Boy's video state, for the few screens ported straight off the
// hardware -- Yellow's Surfing Pikachu minigame first. The ROM code those
// screens run writes tile maps, scroll registers, a per-scanline override
// table and OAM, and reads the tile maps back; porting it faithfully means
// keeping exactly that state, so this is that state and nothing more.
//
// The core draws it (crates/pocketvoxel-core gb.rs, the `gb*` ops), and so
// does `renderGb` below -- the same rules in TypeScript, for tests and
// offline looks. Tile PIXELS never live here: a tile bank names an atlas
// page ("sheet") and the tile it starts at, the way FarCopyData into vChars
// names a ROM address.
//
// No Bun and no host here.

/** LCDC bits (hardware rLCDC). */
export const LCDC = {
  on: 0x80,
  winMap9C00: 0x40,
  winOn: 0x20,
  /** BG/window tiles at $8000 unsigned; clear = $9000 signed. */
  tiles8000: 0x10,
  bgMap9C00: 0x08,
  objOn: 0x02,
  bgOn: 0x01,
} as const;

/** OAM attribute bits. */
export const OAM_ATTR = { behindBg: 0x80, yFlip: 0x40, xFlip: 0x20, obp1: 0x10 } as const;

export const SCREEN_W = 160;
export const SCREEN_H = 144;
/** OAM_X_OFS / OAM_Y_OFS: an OAM entry at (8, 16) is the top-left pixel. */
export const OAM_X_OFS = 8;
export const OAM_Y_OFS = 16;

/**
 * What a range of VRAM tiles holds: `count` tiles of atlas sheet `sheet`
 * from its tile `first`, landing at VRAM tile `dest` -- 0..127 $8000,
 * 128..255 $8800, 256..383 $9000.
 */
export interface TileLoad {
  dest: number;
  sheet: string;
  first: number;
  count: number;
  /** A sheet read `wide` tiles at a time out of rows `stride` tiles long
   *  (a walk sheet's 2-tile column of a wider page); 0/absent: straight on. */
  wide?: number;
  stride?: number;
  /** With the sheet "terrain": whose terrain page (the map's index). */
  map?: number;
}

/** Which register the per-scanline table overrides (hLCDCPointer). */
export type LineTarget = "none" | "scy" | "scx";

export class GbVideo {
  /** vBGMap0 ($9800) then vBGMap1 ($9C00), 32x32 tile ids each. */
  readonly maps = new Uint8Array(2048);
  /** wTileMap, 20x18: copied onto vBGMap0 each frame while autoBgTransfer. */
  readonly tileMap = new Uint8Array(SCREEN_W / 8 * (SCREEN_H / 8));
  autoBgTransfer = false;
  /** The destination map of the auto transfer (hAutoBGTransferDest): 0 or 1. */
  autoBgTransferMap = 0;
  /** 40 x (y, x, tile, attr), hardware OAM coordinates. */
  readonly oam = new Uint8Array(160);
  /** wLYOverrides: one value per scanline for `lineTarget`. */
  readonly lines = new Uint8Array(SCREEN_H);
  lineTarget: LineTarget = "none";
  lcdc = 0;
  scx = 0;
  scy = 0;
  wx = 7;
  wy = SCREEN_H;
  bgp = 0xe4;
  obp0 = 0xe4;
  obp1 = 0xe4;
  /** SGB palette names the three palette registers colour through. */
  colours = { bg: "PIKACHUS_BEACH", obj0: "PIKACHUS_BEACH", obj1: "PIKACHUS_BEACH" };
  /** VRAM tile contents, in load order (a later load over the same tiles wins). */
  loads: TileLoad[] = [];
  /**
   * False when the producer knows `maps` is as it was last frame, so the
   * emitter can skip comparing all 2048 bytes; undefined (the minigame's
   * way) always compares.
   */
  mapsDirty: boolean | undefined = undefined;

  /** FarCopyData of `count` tiles of `sheet` from `first` to VRAM tile `dest`. */
  loadTiles(dest: number, sheet: string, first: number, count: number): void {
    this.loads = this.loads.filter((l) => l.dest + l.count <= dest || l.dest >= dest + count);
    this.loads.push({ dest, sheet, first, count });
  }

  /** The sheet tile VRAM tile `vram` holds, or null for an unloaded tile. */
  tileAt(vram: number): { sheet: string; tile: number } | null {
    for (let i = this.loads.length - 1; i >= 0; i--) {
      const l = this.loads[i]!;
      if (vram >= l.dest && vram < l.dest + l.count) return { sheet: l.sheet, tile: l.first + vram - l.dest };
    }
    return null;
  }

  /** The VRAM tile a BG/window tile id reads, by LCDC's addressing mode. */
  bgTile(id: number): number {
    if (this.lcdc & LCDC.tiles8000) return id;
    return id < 0x80 ? 256 + id : id;
  }

  /** A byte of VRAM map space: `addr` from $9800 (0..$7FF). */
  mapGet(addr: number): number {
    return this.maps[addr & 0x7ff]!;
  }
  mapSet(addr: number, id: number): void {
    this.maps[addr & 0x7ff] = id & 0xff;
  }
  /** hlbgcoord x, y[, map]: the map byte offset of a BG cell. */
  static bgCoord(x: number, y: number, map = 0): number {
    return map * 0x400 + (y & 31) * 32 + (x & 31);
  }

  /** The start of a frame's VBlank: hAutoBGTransfer copies wTileMap over. */
  vblank(): void {
    if (!this.autoBgTransfer) return;
    const base = this.autoBgTransferMap * 0x400;
    for (let y = 0; y < SCREEN_H / 8; y++) {
      for (let x = 0; x < SCREEN_W / 8; x++) this.maps[base + y * 32 + x] = this.tileMap[y * 20 + x]!;
    }
  }

  /**
   * AutoBgMapTransfer (home/vcopy.asm) the way the ROM paces it: one third
   * of wTileMap (six rows) per VBlank -- top, middle, bottom, round again.
   * `portion` is hAutoBGTransferPortion; returns the next one (unchanged
   * while the transfer is off).
   */
  vblankThird(portion: number): number {
    if (!this.autoBgTransfer) return portion;
    const row = portion === 0 ? 0 : portion === 1 ? 6 : 12;
    const base = this.autoBgTransferMap * 0x400;
    for (let y = row; y < row + 6; y++) {
      for (let x = 0; x < SCREEN_W / 8; x++) this.maps[base + y * 32 + x] = this.tileMap[y * 20 + x]!;
    }
    return portion === 0 ? 1 : portion === 1 ? 2 : 0;
  }

  clearOam(): void {
    this.oam.fill(0);
  }
}

/** A DMG palette register as a shade map: shade i shows (p >> 2i) & 3. */
export function shadeOf(p: number, shade: number): number {
  return (p >> (shade * 2)) & 3;
}

/**
 * The frame, the way the hardware draws it: one value per pixel, the palette
 * slot times four plus the shade shown (slot 0 BG/window, 1 OBP0, 2 OBP1).
 * `pixel(sheet, tile, x, y)` reads a sheet tile's raw shade (0-3). Sprites
 * are 8x8; ten a line, in hardware order.
 */
export function renderGb(
  v: GbVideo,
  pixel: (sheet: string, tile: number, x: number, y: number) => number,
): Uint8Array {
  const out = new Uint8Array(SCREEN_W * SCREEN_H);
  const raw = (vram: number, x: number, y: number): number => {
    const t = v.tileAt(vram);
    return t ? pixel(t.sheet, t.tile, x, y) & 3 : 0;
  };
  const bgRaw = new Uint8Array(SCREEN_W);
  let winLine = 0;
  for (let ly = 0; ly < SCREEN_H; ly++) {
    const scy = v.lineTarget === "scy" ? v.lines[ly]! : v.scy;
    const scx = v.lineTarget === "scx" ? v.lines[ly]! : v.scx;
    bgRaw.fill(0);
    for (let x = 0; x < SCREEN_W; x++) {
      let shade = 0;
      if (v.lcdc & LCDC.bgOn) {
        const bx = (x + scx) & 255;
        const by = (ly + scy) & 255;
        const map = v.lcdc & LCDC.bgMap9C00 ? 0x400 : 0;
        const id = v.maps[map + (by >> 3) * 32 + (bx >> 3)]!;
        shade = raw(v.bgTile(id), bx & 7, by & 7);
      }
      bgRaw[x] = shade;
      out[ly * SCREEN_W + x] = shadeOf(v.bgp, shade);
    }
    if (v.lcdc & LCDC.winOn && ly >= v.wy && v.wx <= 166) {
      const map = v.lcdc & LCDC.winMap9C00 ? 0x400 : 0;
      for (let x = Math.max(0, v.wx - 7); x < SCREEN_W; x++) {
        const wx = x - (v.wx - 7);
        const id = v.maps[map + (winLine >> 3) * 32 + (wx >> 3)]!;
        const shade = raw(v.bgTile(id), wx & 7, winLine & 7);
        bgRaw[x] = shade;
        out[ly * SCREEN_W + x] = shadeOf(v.bgp, shade);
      }
      winLine++;
    }
    if (!(v.lcdc & LCDC.objOn)) continue;
    // the first ten entries on this line, drawn so a lower X (then a lower
    // OAM index) wins
    const hits: number[] = [];
    for (let i = 0; i < 40 && hits.length < 10; i++) {
      const y = v.oam[i * 4]! - OAM_Y_OFS;
      if (ly >= y && ly < y + 8) hits.push(i);
    }
    hits.sort((a, b) => v.oam[a * 4 + 1]! - v.oam[b * 4 + 1]! || a - b);
    for (let h = hits.length - 1; h >= 0; h--) {
      const i = hits[h]!;
      const [oy, ox, tile, attr] = [v.oam[i * 4]!, v.oam[i * 4 + 1]!, v.oam[i * 4 + 2]!, v.oam[i * 4 + 3]!];
      const y = oy - OAM_Y_OFS;
      const x0 = ox - OAM_X_OFS;
      let ty = ly - y;
      if (attr & OAM_ATTR.yFlip) ty = 7 - ty;
      for (let px = 0; px < 8; px++) {
        const x = x0 + px;
        if (x < 0 || x >= SCREEN_W) continue;
        const shade = raw(tile, attr & OAM_ATTR.xFlip ? 7 - px : px, ty);
        if (shade === 0) continue;
        if (attr & OAM_ATTR.behindBg && bgRaw[x] !== 0) continue;
        const pal = attr & OAM_ATTR.obp1 ? v.obp1 : v.obp0;
        out[ly * SCREEN_W + x] = (attr & OAM_ATTR.obp1 ? 8 : 4) + shadeOf(pal, shade);
      }
    }
  }
  return out;
}
