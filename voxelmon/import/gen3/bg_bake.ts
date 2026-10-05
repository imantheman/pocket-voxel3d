// Port of gen1recomp src/import/gba/bg_bake.lua (GPLv3 + additional terms; see LICENSE.md).
// Shared 4bpp BG baking: ROM 4bpp tiles + a 32-wide tilemap + BGR555 palette
// banks -> raw RGBA byte strings. Byte tables (the Lua's 1-based `gfx`/`map`)
// are 0-based Uint8Arrays here; palette banks are arrays keyed from 0 as the
// Lua keys them; RGBA results are byte strings, as the Lua returns.

export type Bytes = Uint8Array | number[];
/** A palette bank: 16 BGR555 colours, keys 0..15. */
export type PalBank = number[];
export interface RegionOpts { mapW?: number; x0?: number; y0?: number; bankOffset?: number }

export const BgBake = {
  // Lua: bg_bake.lua:8 -- BGR555 -> 8-bit [r, g, b]
  bgr555ToRgb8(c: number): [number, number, number] {
    c = (Number(c) || 0) % 32768;
    const r5 = c % 32, g5 = Math.floor(c / 32) % 32, b5 = Math.floor(c / 1024) % 32;
    return [Math.floor((r5 * 255) / 31 + 0.5), Math.floor((g5 * 255) / 31 + 0.5), Math.floor((b5 * 255) / 31 + 0.5)];
  },

  // Lua: bg_bake.lua:19
  byteLen(buf: unknown): number {
    if (buf instanceof Uint8Array || Array.isArray(buf)) return buf.length;
    return 0;
  },

  /**
   * Lua: bg_bake.lua:25 -- one 8x8 4bpp tile's palette indices into `out`
   * (0-based here, `stride` wide); tileBytes 0-based.
   */
  decodeTile4bpp(tileBytes: Bytes, out: number[] | Uint8Array, baseX: number, baseY: number, stride: number, hflip?: boolean, vflip?: boolean): void {
    for (let row = 0; row < 8; row++) {
      const srcRow = vflip ? 7 - row : row;
      for (let bx = 0; bx < 4; bx++) {
        const byte = tileBytes[srcRow * 4 + bx] ?? 0;
        const p0 = byte % 16, p1 = Math.floor(byte / 16) % 16;
        let x0 = bx * 2, x1 = x0 + 1;
        if (hflip) { x0 = 7 - x0; x1 = 7 - x1; }
        out[(baseY + row) * stride + baseX + x0] = p0;
        out[(baseY + row) * stride + baseX + x1] = p1;
      }
    }
  },

  // Lua: bg_bake.lua:44 -- a BGR555 block split into 16-colour banks (keys 0..)
  loadPalBanks(bytes: Bytes, count?: number): PalBank[] {
    const banks: PalBank[] = [];
    const n = count ?? Math.floor(BgBake.byteLen(bytes) / 32);
    for (let b = 0; b < n; b++) {
      const colors: number[] = [];
      const off = b * 32;
      for (let c = 0; c < 16; c++) colors[c] = (bytes[off + c * 2] ?? 0) + (bytes[off + c * 2 + 1] ?? 0) * 256;
      banks[b] = colors;
    }
    return banks;
  },

  // Lua: bg_bake.lua:61 -- WxH RGBA from 4bpp tiles + 32-wide tilemap + banks
  bakeBgRgba(gfx: Bytes, palBanks: PalBank[], map: Bytes, W: number, H: number): string {
    const tileCount = Math.floor(BgBake.byteLen(gfx) / 32);
    const mapW = 32;
    const indices = new Array<number>(W * H).fill(0);
    const pals = new Array<number>(W * H).fill(0);
    const tilesH = Math.min(32, Math.floor(H / 8));
    const tilesW = Math.min(32, Math.floor(W / 8));
    const tmp = new Array<number>(64);
    for (let ty = 0; ty < tilesH; ty++) {
      for (let tx = 0; tx < tilesW; tx++) {
        const mi = (ty * mapW + tx) * 2;
        const entry = (map[mi] ?? 0) + (map[mi + 1] ?? 0) * 256;
        const tileId = entry % 1024;
        const hflip = Math.floor(entry / 1024) % 2 === 1;
        const vflip = Math.floor(entry / 2048) % 2 === 1;
        const palNum = Math.floor(entry / 4096) % 16;
        if (tileId < tileCount) {
          const base = tileId * 32;
          const tile = Array.from({ length: 32 }, (_, i) => gfx[base + i] ?? 0);
          tmp.fill(0);
          BgBake.decodeTile4bpp(tile, tmp, 0, 0, 8, hflip, vflip);
          for (let row = 0; row < 8; row++) {
            for (let col = 0; col < 8; col++) {
              const px = tx * 8 + col, py = ty * 8 + row;
              if (px < W && py < H) {
                const di = py * W + px;
                indices[di] = tmp[row * 8 + col] ?? 0;
                pals[di] = palNum;
              }
            }
          }
        }
      }
    }
    let out = "";
    for (let i = 0; i < W * H; i++) {
      const bank = palBanks[pals[i]!] ?? palBanks[0] ?? [];
      const [r, g, b] = BgBake.bgr555ToRgb8(bank[indices[i]!] ?? 0);
      out += String.fromCharCode(r, g, b, 255);
    }
    return out;
  },

  // Lua: bg_bake.lua:113 -- [indices, pals] (0-based arrays; pals -1 where no tile)
  regionIndices(gfx: Bytes, map: Bytes, W: number, H: number, opts: RegionOpts = {}): [number[], number[]] {
    const mapW = opts.mapW ?? 32, x0 = opts.x0 ?? 0, y0 = opts.y0 ?? 0, bankOffset = opts.bankOffset ?? 0;
    const tileCount = Math.floor(BgBake.byteLen(gfx) / 32);
    const mapLen = BgBake.byteLen(map);
    const indices = new Array<number>(W * H).fill(0);
    const pals = new Array<number>(W * H).fill(-1);
    const tileX = Math.floor(x0 / 8), tileY = Math.floor(y0 / 8);
    const subX = x0 - tileX * 8, subY = y0 - tileY * 8;
    const tilesW = Math.ceil((W + subX) / 8), tilesH = Math.ceil((H + subY) / 8);
    const tmp = new Array<number>(64);
    for (let ty = 0; ty < tilesH; ty++) {
      for (let tx = 0; tx < tilesW; tx++) {
        // Lua mi is 1-based and checks mi + 1 <= mapLen; 0-based: mi + 1 < mapLen
        const mi = ((tileY + ty) * mapW + (tileX + tx)) * 2;
        if (tileY + ty >= 0 && mi + 1 < mapLen) {
          const entry = (map[mi] ?? 0) + (map[mi + 1] ?? 0) * 256;
          const tileId = entry % 1024;
          const hflip = Math.floor(entry / 1024) % 2 === 1;
          const vflip = Math.floor(entry / 2048) % 2 === 1;
          const palNum = (Math.floor(entry / 4096) % 16) - bankOffset;
          if (tileId < tileCount) {
            const base = tileId * 32;
            const tile = Array.from({ length: 32 }, (_, i) => gfx[base + i] ?? 0);
            tmp.fill(0);
            BgBake.decodeTile4bpp(tile, tmp, 0, 0, 8, hflip, vflip);
            for (let row = 0; row < 8; row++) {
              for (let col = 0; col < 8; col++) {
                const px = tx * 8 + col - subX, py = ty * 8 + row - subY;
                if (px >= 0 && py >= 0 && px < W && py < H) {
                  const di = py * W + px;
                  indices[di] = tmp[row * 8 + col] ?? 0;
                  pals[di] = palNum;
                }
              }
            }
          }
        }
      }
    }
    return [indices, pals];
  },

  // Lua: bg_bake.lua:160 -- one byte per pixel (index, 0 where no tile)
  bakeRegionIndices(gfx: Bytes, map: Bytes, W: number, H: number, opts?: RegionOpts): string {
    const [indices, pals] = BgBake.regionIndices(gfx, map, W, H, opts);
    let out = "";
    for (let i = 0; i < W * H; i++) out += String.fromCharCode(pals[i]! < 0 ? 0 : indices[i]!);
    return out;
  },

  // Lua: bg_bake.lua:169
  bakeRegionRgba(gfx: Bytes, palBanks: PalBank[], map: Bytes, W: number, H: number,
    opts: RegionOpts & { alpha0?: boolean } = {}): string {
    const alpha0 = !!opts.alpha0;
    const [indices, pals] = BgBake.regionIndices(gfx, map, W, H, opts);
    let out = "";
    for (let i = 0; i < W * H; i++) {
      const idx = indices[i]!;
      if (pals[i]! < 0 || (alpha0 && idx === 0)) out += "\x00\x00\x00\x00";
      else {
        const bank = palBanks[pals[i]!] ?? palBanks[0] ?? [];
        const [r, g, b] = BgBake.bgr555ToRgb8(bank[idx] ?? 0);
        out += String.fromCharCode(r, g, b, 255);
      }
    }
    return out;
  },

  // Lua: bg_bake.lua:188
  bakeSpriteRgba(gfx: Bytes, bank: PalBank | undefined, tileIndex: number, fw: number, fh: number, hflip?: boolean, vflip?: boolean): string {
    const tw = Math.floor(fw / 8), th = Math.floor(fh / 8);
    const pixels = new Array<number>(fw * fh).fill(0);
    for (let ty = 0; ty < th; ty++) {
      for (let tx = 0; tx < tw; tx++) {
        const base = (tileIndex + ty * tw + tx) * 32;
        const tile = Array.from({ length: 32 }, (_, i) => gfx[base + i] ?? 0);
        BgBake.decodeTile4bpp(tile, pixels, tx * 8, ty * 8, fw, false, false);
      }
    }
    let out = "";
    for (let y = 0; y < fh; y++) {
      for (let x = 0; x < fw; x++) {
        const sx = hflip ? fw - 1 - x : x, sy = vflip ? fh - 1 - y : y;
        const idx = pixels[sy * fw + sx] ?? 0;
        if (idx === 0) out += "\x00\x00\x00\x00";
        else {
          const [r, g, b] = BgBake.bgr555ToRgb8((bank ?? [])[idx] ?? 0);
          out += String.fromCharCode(r, g, b, 255);
        }
      }
    }
    return out;
  },
};

export default BgBake;
