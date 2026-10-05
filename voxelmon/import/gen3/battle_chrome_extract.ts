// Port of gen1recomp src/import/gba/battle_chrome_extract.lua (GPLv3 + additional terms; see LICENSE.md).
// Bake FRLG battle interface chrome from ROM into data/generated/gba/pokemon/battle/.
// Healthboxes are OAM-assembled (pret CreateBattlerHealthboxSprites): two side-by-side
// sprites, not a flat 128-wide sheet blit.
// Byte tables and pixel index tables are 0-based here (the Lua's 1-based);
// palettes keyed from 0 as the Lua keys them.

import { Versions } from "./versions.ts";
import { Lz77 } from "./lz77.ts";
import { CacheFs, type Cache } from "./cache.ts";
import { format, fromBytes, tonumber } from "./lua.ts";
import type { Rom } from "./rom.ts";

type Bytes = ArrayLike<number>;
type Pal = Record<number, number>;
type Get = (i: number) => number;

// Lua: battle_chrome_extract.lua:45 (extract_island1's CACHE_ROOT; callers pass cacheRoot)
function default_cache_root(): string {
  return "data/generated/gba";
}

// Lua: battle_chrome_extract.lua:53
function bgr555_to_rgb8(c: unknown): [number, number, number] {
  const n = (tonumber(c) ?? 0) % 32768;
  const r5 = n % 32, g5 = Math.floor(n / 32) % 32, b5 = Math.floor(n / 1024) % 32;
  return [Math.floor((r5 * 255) / 31 + 0.5), Math.floor((g5 * 255) / 31 + 0.5), Math.floor((b5 * 255) / 31 + 0.5)];
}

// Lua: battle_chrome_extract.lua:63
function byte_len(buf: unknown): number {
  if (typeof buf === "string") return buf.length;
  if (buf instanceof Uint8Array || Array.isArray(buf)) return buf.length;
  return 0;
}

// Lua: battle_chrome_extract.lua:69
function bytes_to_array(tbl: string | Bytes): Bytes {
  if (typeof tbl === "string") {
    const t: number[] = [];
    for (let i = 0; i < tbl.length; i++) t[i] = tbl.charCodeAt(i);
    return t;
  }
  return tbl;
}

// Lua: battle_chrome_extract.lua:83
function load_pal(bytesIn: string | Bytes, count?: number): Pal {
  const bytes = bytes_to_array(bytesIn);
  const pal: Pal = {};
  for (let c = 0; c <= (count ?? 16) - 1; c++) pal[c] = (bytes[c * 2] ?? 0) + (bytes[c * 2 + 1] ?? 0) * 256;
  return pal;
}

// Lua: battle_chrome_extract.lua:93
function decode_tile_4bpp(tileBytes: Bytes, out: number[], baseX: number, baseY: number, stride: number, hflip: boolean, vflip: boolean): void {
  for (let row = 0; row <= 7; row++) {
    const srcRow = vflip ? 7 - row : row;
    for (let bx = 0; bx <= 3; bx++) {
      const byte = tileBytes[srcRow * 4 + bx] ?? 0;
      const p0 = byte % 16, p1 = Math.floor(byte / 16) % 16;
      let x0 = bx * 2, x1 = x0 + 1;
      if (hflip) { x0 = 7 - x0; x1 = 7 - x1; }
      out[(baseY + row) * stride + (baseX + x0)] = p0;
      out[(baseY + row) * stride + (baseX + x1)] = p1;
    }
  }
}

function tileAt(gfx: Bytes, tileId: number): number[] {
  const tile: number[] = [];
  const base = tileId * 32;
  for (let i = 0; i < 32; i++) tile[i] = gfx[base + i] ?? 0;
  return tile;
}

// Lua: battle_chrome_extract.lua:111
function indices_to_rgba(indices: number[], pal: Pal, w: number, h: number): string {
  const out = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const idx = indices[i] ?? 0;
    if (idx !== 0) {
      const [r, g, b] = bgr555_to_rgb8(pal[idx] ?? 0);
      out[i * 4] = r; out[i * 4 + 1] = g; out[i * 4 + 2] = b; out[i * 4 + 3] = 255;
    }
  }
  return fromBytes(out);
}

// Lua: battle_chrome_extract.lua:126 -- GBA OAM multi-tile blit: tiles arranged row-major in an (tilesW x tilesH) grid.
function blit_oam_rect(gfxIn: string | Bytes, _pal: Pal, tileStart: number, tilesW: number, tilesH: number, dest: number[], destX: number, destY: number, destW: number): void {
  const gfx = bytes_to_array(gfxIn);
  const tileCount = Math.floor(byte_len(gfx) / 32);
  for (let ty = 0; ty <= tilesH - 1; ty++) {
    for (let tx = 0; tx <= tilesW - 1; tx++) {
      const ti = tileStart + ty * tilesW + tx;
      if (ti >= 0 && ti < tileCount) {
        const tmp = new Array<number>(64).fill(0);
        decode_tile_4bpp(tileAt(gfx, ti), tmp, 0, 0, 8, false, false);
        for (let row = 0; row <= 7; row++) {
          for (let col = 0; col <= 7; col++) {
            const idx = tmp[row * 8 + col] ?? 0;
            if (idx !== 0) {
              const dx = destX + tx * 8 + col;
              const dy = destY + ty * 8 + row;
              dest[dy * destW + dx] = idx;
            }
          }
        }
      }
    }
  }
}

// Lua: battle_chrome_extract.lua:156 -- Player singles: two 64x64 sprites, other at x+64 (SpriteCB_HealthBoxOther).
function bake_player_healthbox(gfx: Bytes, pal: Pal): [string, number, number] {
  const w = 128, h = 64;
  const indices = new Array<number>(w * h).fill(0);
  blit_oam_rect(gfx, pal, 0, 8, 8, indices, 0, 0, w);
  blit_oam_rect(gfx, pal, 64, 8, 8, indices, 64, 0, w);
  return [indices_to_rgba(indices, pal, w, h), w, h];
}

// Lua: battle_chrome_extract.lua:166 -- Enemy singles: two 64x32 sprites (default OAM), other at x+64, tileNum+=32.
function bake_enemy_healthbox(gfx: Bytes, pal: Pal): [string, number, number] {
  const w = 128, h = 32;
  const indices = new Array<number>(w * h).fill(0);
  blit_oam_rect(gfx, pal, 0, 8, 4, indices, 0, 0, w);
  blit_oam_rect(gfx, pal, 32, 8, 4, indices, 64, 0, w);
  return [indices_to_rgba(indices, pal, w, h), w, h];
}

// Lua: battle_chrome_extract.lua:176 -- pokefirered/src/battle_interface.c:568
function bake_doubles_healthbox(gfx: Bytes, pal: Pal): [string, number, number] {
  return bake_enemy_healthbox(gfx, pal);
}

// Lua: battle_chrome_extract.lua:202 -- pokefirered/src/text_printer.c:187
function decode_bold_half_rows(get: Get, base: number, dest: number[], destX: number, stride: number): void {
  const map: Record<number, number> = { 0: 0, 1: 1, 2: 3, 3: 0 };
  for (let row = 0; row <= 7; row++) {
    const lo = get(base + row * 2) ?? 0;
    const hi = get(base + row * 2 + 1) ?? 0;
    for (let half = 0; half <= 1; half++) {
      const b = half === 0 ? hi : lo;
      for (let k = 0; k <= 3; k++) {
        const v = Math.floor(b / 4 ** (3 - k)) % 4;
        dest[row * stride + destX + half * 4 + k] = map[v]!;
      }
    }
  }
}

// Lua: battle_chrome_extract.lua:251
function bake_sheet_rgba(gfxIn: string | Bytes, pal: Pal, w: number, h: number): string {
  const gfx = bytes_to_array(gfxIn);
  const tilesW = Math.floor(w / 8), tilesH = Math.floor(h / 8);
  const indices = new Array<number>(w * h).fill(0);
  let ti = 0;
  for (let ty = 0; ty <= tilesH - 1; ty++) {
    for (let tx = 0; tx <= tilesW - 1; tx++) {
      decode_tile_4bpp(tileAt(gfx, ti), indices, tx * 8, ty * 8, w, false, false);
      ti = ti + 1;
    }
  }
  return indices_to_rgba(indices, pal, w, h);
}

// Lua: battle_chrome_extract.lua:269 -- [rgba, W, H]
function bake_tilemap_rgba(gfxIn: string | Bytes, palIn: string | Bytes, mapIn: string | Bytes, mapTilesW: number, mapTilesH: number,
  opts: { transparent0?: boolean; bgPalBase?: number } = {}): [string, number, number] {
  const gfx = bytes_to_array(gfxIn);
  const map = bytes_to_array(mapIn);
  const palBytes = bytes_to_array(palIn);
  const tileCount = Math.floor(gfx.length / 32);
  const bankCount = Math.max(1, Math.floor(palBytes.length / 32));
  const banks: Pal[] = [];
  for (let b = 0; b <= bankCount - 1; b++) {
    const slice: number[] = [];
    for (let i = 0; i < 32; i++) slice[i] = palBytes[b * 32 + i] ?? 0;
    banks[b] = load_pal(slice, 16);
  }

  const W = mapTilesW * 8, H = mapTilesH * 8;
  const indices = new Array<number>(W * H).fill(0);
  const pals = new Array<number>(W * H).fill(0);
  for (let ty = 0; ty <= mapTilesH - 1; ty++) {
    for (let tx = 0; tx <= mapTilesW - 1; tx++) {
      const mi = (ty * mapTilesW + tx) * 2;
      const entry = (map[mi] ?? 0) + (map[mi + 1] ?? 0) * 256;
      let tileId = entry % 1024;
      const hflip = Math.floor(entry / 1024) % 2 === 1;
      const vflip = Math.floor(entry / 2048) % 2 === 1;
      const palNum = Math.floor(entry / 4096) % 16;
      if (tileId >= tileCount) tileId = 0;
      const tmp = new Array<number>(64).fill(0);
      decode_tile_4bpp(tileAt(gfx, tileId), tmp, 0, 0, 8, hflip, vflip);
      for (let row = 0; row <= 7; row++) {
        for (let col = 0; col <= 7; col++) {
          const di = (ty * 8 + row) * W + (tx * 8 + col);
          indices[di] = tmp[row * 8 + col] ?? 0;
          pals[di] = palNum;
        }
      }
    }
  }
  const transparent0 = opts.transparent0 !== false;
  // Terrain pals load at BG_PLTT_ID(2); textbox at BG_PLTT_ID(0).
  const bgPalBase = opts.bgPalBase ?? 0;
  const out = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const idx = indices[i] ?? 0;
    if (!(idx === 0 && transparent0)) {
      const palNum = pals[i] ?? 0;
      let bi = palNum - bgPalBase;
      if (bi < 0 || bi >= bankCount) bi = Math.max(0, Math.min(bankCount - 1, palNum));
      const bank = banks[bi] ?? banks[0]!;
      const [r, g, b] = bgr555_to_rgb8(bank[idx] ?? 0);
      out[i * 4] = r; out[i * 4 + 1] = g; out[i * 4 + 2] = b; out[i * 4 + 3] = 255;
    }
  }
  return [fromBytes(out), W, H];
}

// Lua: battle_chrome_extract.lua:332
function read_raw(rom: Rom, off: number, n: number): number[] {
  const t: number[] = [];
  for (let i = 0; i <= n - 1; i++) t[i] = rom.get(off + i);
  return t;
}

// Lua: battle_chrome_extract.lua:338
function split_terrain_layers(fullRgba: string, mapIn: string | Bytes): [string, string, string] {
  const mapBytes = bytes_to_array(mapIn);
  const bgTilePerRow: number[] = [];
  for (let ty = 0; ty <= 19; ty++) {
    const counts = new Map<number, number>();
    const inserted: number[] = [];
    for (let tx = 0; tx <= 31; tx++) {
      const mi = (ty * 32 + tx) * 2;
      const entry = (mapBytes[mi] ?? 0) + (mapBytes[mi + 1] ?? 0) * 256;
      const tid = entry % 1024;
      if (!counts.has(tid)) inserted.push(tid);
      counts.set(tid, (counts.get(tid) ?? 0) + 1);
    }
    let maxCount = -1, bestTid = 0;
    // NOT FAITHFUL (iteration order): the Lua walks `pairs(counts)` and keeps
    // the first key with the highest count, so a tie would go to whichever key
    // LuaJIT's table traversal yields first. Here keys go in ascending order.
    // No FireRed terrain row has a tie (checked on the FireRed ROM: every
    // row's top count is unique), so the outputs are identical there.
    for (const tid of [...inserted].sort((x, y) => x - y)) {
      const count = counts.get(tid)!;
      if (count > maxCount) { maxCount = count; bestTid = tid; }
    }
    bgTilePerRow[ty] = bestTid;
  }

  const W = 256, H = 160;
  const bg = new Uint8Array(W * H * 4);
  const enemy = new Uint8Array(W * H * 4);
  const player = new Uint8Array(W * H * 4);
  const px = (s: number): number => (s < fullRgba.length ? fullRgba.charCodeAt(s) : 0);
  let o = 0;
  for (let ty = 0; ty <= 19; ty++) {
    const bgTid = bgTilePerRow[ty]!;
    let bgTx = 0;
    for (let tx = 0; tx <= 31; tx++) {
      const mi = (ty * 32 + tx) * 2;
      const entry = (mapBytes[mi] ?? 0) + (mapBytes[mi + 1] ?? 0) * 256;
      if (entry % 1024 === bgTid) { bgTx = tx; break; }
    }
    for (let row = 0; row <= 7; row++) {
      const srcY = ty * 8 + row;
      for (let tx = 0; tx <= 31; tx++) {
        const mi = (ty * 32 + tx) * 2;
        const entry = (mapBytes[mi] ?? 0) + (mapBytes[mi + 1] ?? 0) * 256;
        const tid = entry % 1024;
        const isBg = tid === bgTid;
        for (let col = 0; col <= 7; col++) {
          const srcIdx = (srcY * 256 + (tx * 8 + col)) * 4;
          const bgIdx = (srcY * 256 + (bgTx * 8 + col)) * 4;
          for (let k = 0; k < 4; k++) bg[o + k] = px(bgIdx + k);
          if (!isBg && tx >= 10 && ty <= 10) for (let k = 0; k < 4; k++) enemy[o + k] = px(srcIdx + k);
          if (!isBg && tx <= 16 && ty >= 10) for (let k = 0; k < 4; k++) player[o + k] = px(srcIdx + k);
          o += 4;
        }
      }
    }
  }
  return [fromBytes(bg), fromBytes(enemy), fromBytes(player)];
}

// Lua: battle_chrome_extract.lua:411
function ptr_offset(v: unknown): number | undefined {
  if (typeof v !== "number" || v < 0x08000000 || v >= 0x09000000) return undefined;
  return v - 0x08000000;
}

interface TerrainCfg { tiles: number; tilemap: number; pal: number }
interface TerrainRow { key: string; id: number; cfg: TerrainCfg }
interface TerrainMeta { w: number; h: number; postDexFile: string }

// Lua: battle_chrome_extract.lua:470
function bake_terrain(get: Get, cache: Cache, root: string, key: string, tr: TerrainCfg): TerrainMeta {
  const [tGfx] = Lz77.decompress(get, tr.tiles);
  const [tPal] = Lz77.decompress(get, tr.pal);
  const [tMap] = Lz77.decompress(get, tr.tilemap);
  if (byte_len(tMap) < 4096) {
    throw new Error("battle_chrome_extract: post-dex terrain map missing right screen for " + key);
  }
  const [rgba, trW, trH] = bake_tilemap_rgba(tGfx, tPal, tMap, 32, 32, { transparent0: false, bgPalBase: 2 });
  cache.write(root + "/terrain_" + key + ".rgba", rgba);
  const [bgRgba, enemyRgba, playerRgba] = split_terrain_layers(rgba, tMap);
  cache.write(root + "/terrain_bg_" + key + ".rgba", bgRgba);
  cache.write(root + "/terrain_enemy_" + key + ".rgba", enemyRgba);
  cache.write(root + "/terrain_player_" + key + ".rgba", playerRgba);
  // pokeemerald/src/battle_script_commands.c:10133
  // pokefirered/src/battle_script_commands.c:9693
  const bytes = bytes_to_array(tMap);
  const postMap: number[] = [];
  for (let i = 0; i < 2048; i++) postMap[i] = bytes[2048 + i]!;
  const [postRgba] = bake_tilemap_rgba(tGfx, tPal, postMap, 32, 32, { transparent0: false, bgPalBase: 2 });
  const postDexFile = "terrain_" + key + "_post_dex.rgba";
  cache.write(root + "/" + postDexFile, postRgba);
  return { w: trW, h: trH, postDexFile };
}

export const BattleChromeExtract = {
  FORMAT_VERSION: 7,
  CACHE_SUB: "pokemon/battle",
  REQUIRED: [
    "pokemon/battle/manifest.lua",
    "pokemon/battle/textbox.rgba",
    "pokemon/battle/healthbox_player.rgba",
    "pokemon/battle/terrain_building.rgba",
  ],

  // src/battle_bg.c:439
  TERRAIN_TABLE: 0x24ee34,
  TERRAIN_ENTRY_SIZE: 20,
  TERRAIN_KEYS: {
    0: "grass", 1: "long_grass", 2: "sand", 3: "underwater", 4: "water", 5: "pond", 6: "mountain",
    7: "cave", 8: "building", 9: "plain", 10: "link", 11: "gym", 12: "leader", 13: "indoor_2",
    14: "indoor_1", 15: "lorelei", 16: "bruno", 17: "agatha", 18: "lance", 19: "champion",
  } as Record<number, string>,

  DOUBLES_FILES: {
    player: "healthbox_doubles_player.rgba",
    opponent: "healthbox_doubles_opponent.rgba",
  },

  // Lua: battle_chrome_extract.lua:185 -- [playerRgba, opponentRgba] or []
  bakeDoubles(get: Get, cfg?: Record<string, any>): [string?, string?] {
    cfg = cfg ?? Versions.BATTLE_UI;
    if (!(cfg!.healthbox_doubles_player && cfg!.healthbox_doubles_opponent)) return [];
    const raw: number[] = [];
    for (let i = 0; i <= 31; i++) raw[i] = get(cfg!.healthbox_pal + i);
    const hbPal = load_pal(raw, 16);
    // (bake_doubles_healthbox returns rgba, w, h; the Lua keeps only the first value)
    const [playerRgba] = bake_doubles_healthbox(Lz77.decompress(get, cfg!.healthbox_doubles_player)[0], hbPal);
    const [opponentRgba] = bake_doubles_healthbox(Lz77.decompress(get, cfg!.healthbox_doubles_opponent)[0], hbPal);
    return [playerRgba, opponentRgba];
  },

  HP_BOLD_FILE: "hp_bold_digits.rgba",
  HP_BOLD_CHARS: "0123456789/",
  HP_BOLD_W: 88,
  HP_BOLD_H: 8,

  // Lua: battle_chrome_extract.lua:218 -- pokefirered/src/text.c:1688
  bakeHpBoldDigits(get: Get, cfg?: Record<string, any>): string | undefined {
    cfg = cfg ?? Versions.BATTLE_UI;
    if (!cfg!.font_bold_glyphs) return undefined;
    const raw: number[] = [];
    for (let i = 0; i <= 31; i++) raw[i] = get(cfg!.healthbar_pal + i);
    const barPal = load_pal(raw, 16);
    const w = BattleChromeExtract.HP_BOLD_W, h = BattleChromeExtract.HP_BOLD_H;
    const indices = new Array<number>(w * h).fill(0);
    const codes = [0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xba];
    codes.forEach((id, n) => {
      const glyph = cfg!.font_bold_glyphs + 2 * (0x100 * Math.floor(id / 16) + 8 * (id % 16));
      // pokefirered/src/battle_interface.c:900
      decode_bold_half_rows(get, glyph + 2 * 0x80, indices, n * 8, w);
    });
    return indices_to_rgba(indices, barPal, w, h);
  },

  // Lua: battle_chrome_extract.lua:236
  runDoubles(rom: Rom, cache: Cache, opts: { cacheRoot?: string; cfg?: Record<string, any> } = {}): boolean {
    const root = (opts.cacheRoot ?? default_cache_root()) + "/" + BattleChromeExtract.CACHE_SUB;
    const get = (i: number): number => rom.get(i);
    const [playerRgba, opponentRgba] = BattleChromeExtract.bakeDoubles(get, opts.cfg);
    if (playerRgba === undefined) return false;
    cache.write(root + "/" + BattleChromeExtract.DOUBLES_FILES.player, playerRgba);
    cache.write(root + "/" + BattleChromeExtract.DOUBLES_FILES.opponent, opponentRgba!);
    const boldRgba = BattleChromeExtract.bakeHpBoldDigits(get, opts.cfg);
    if (boldRgba !== undefined) cache.write(root + "/" + BattleChromeExtract.HP_BOLD_FILE, boldRgba);
    return true;
  },

  // Lua: battle_chrome_extract.lua:417 -- src/battle_bg.c:439
  terrainTable(get: Get, cfg?: Record<string, any>): TerrainRow[] | undefined {
    cfg = cfg ?? Versions.BATTLE_UI;
    const base: number = cfg!.terrain_table ?? Versions.address(BattleChromeExtract.TERRAIN_TABLE);
    const u32 = (off: number): number => (get(off) ?? 0) + (get(off + 1) ?? 0) * 256
      + (get(off + 2) ?? 0) * 65536 + (get(off + 3) ?? 0) * 16777216;
    const out: TerrainRow[] = [];
    for (let id = 0; id <= (cfg!.terrain_count ?? 20) - 1; id++) {
      const key = BattleChromeExtract.TERRAIN_KEYS[id];
      const off = base + id * BattleChromeExtract.TERRAIN_ENTRY_SIZE;
      const tiles = ptr_offset(u32(off));
      const tilemap = ptr_offset(u32(off + 4));
      const pal = ptr_offset(u32(off + 16));
      if (!(key && tiles !== undefined && tilemap !== undefined && pal !== undefined)) return undefined;
      out[id] = { key, id, cfg: { tiles, tilemap, pal } };
    }
    const grass = cfg!.terrain_grass;
    const first = out[0]!.cfg;
    if (grass && (first.tiles !== grass.tiles || first.tilemap !== grass.tilemap || first.pal !== grass.pal)) return undefined;
    return out;
  },

  // Lua: battle_chrome_extract.lua:443
  requireTerrainTable(get: Get, cfg?: Record<string, any>): TerrainRow[] {
    cfg = cfg ?? Versions.BATTLE_UI;
    const terrains = BattleChromeExtract.terrainTable(get, cfg);
    if (!terrains) {
      throw new Error(format("battle_chrome_extract: sBattleTerrainTable at 0x%X did not decode",
        cfg!.terrain_table ?? Versions.address(BattleChromeExtract.TERRAIN_TABLE)));
    }
    return terrains;
  },

  // Lua: battle_chrome_extract.lua:494 -- NOT PORTED: the Emerald (rse)
  // layout (and its pal_list / window_rows helpers); Emerald is outside the FireRed port.
  runRse(): never {
    throw new Error("battle_chrome_extract: the rse layout is not ported");
  },

  // Lua: battle_chrome_extract.lua:602
  run(rom: Rom, cache: Cache, opts: { cacheRoot?: string } = {}): { root: string; textboxW: number; textboxH: number; terrains: string[] } {
    const cacheRoot = opts.cacheRoot ?? default_cache_root();
    const root = cacheRoot + "/" + BattleChromeExtract.CACHE_SUB;
    const cfg = Versions.BATTLE_UI;
    if (cfg.layout === "rse") BattleChromeExtract.runRse();
    const get = (i: number): number => rom.get(i);

    const [tbGfx] = Lz77.decompress(get, cfg.textbox_gfx);
    const [tbPal] = Lz77.decompress(get, cfg.textbox_pal);
    const [tbMap] = Lz77.decompress(get, cfg.textbox_tilemap);
    const [textboxRgba, tw, th] = bake_tilemap_rgba(tbGfx, tbPal, tbMap, 32, 64);
    cache.write(root + "/textbox.rgba", textboxRgba);

    // Healthbox pals are uncompressed INCBIN_U16 (not LZ).
    const hbPal = load_pal(read_raw(rom, cfg.healthbox_pal, 32), 16);
    const barPal = load_pal(read_raw(rom, cfg.healthbar_pal, 32), 16);
    const [playerGfx] = Lz77.decompress(get, cfg.healthbox_player);
    const [enemyGfx] = Lz77.decompress(get, cfg.healthbox_enemy);
    cache.write(root + "/healthbox_player.rgba", bake_player_healthbox(playerGfx, hbPal)[0]);
    cache.write(root + "/healthbox_enemy.rgba", bake_enemy_healthbox(enemyGfx, hbPal)[0]);
    if (cfg.healthbox_safari) {
      // src/battle_interface.c:615 CreateSafariPlayerHealthboxSprites
      const [safariGfx] = Lz77.decompress(get, cfg.healthbox_safari);
      cache.write(root + "/healthbox_safari.rgba", bake_player_healthbox(safariGfx, hbPal)[0]);
    }
    BattleChromeExtract.runDoubles(rom, cache, { cacheRoot });

    const elGfx = read_raw(rom, cfg.healthbox_elements, (320 * 24) / 2);
    // HP bar sprite uses TAG_HEALTHBAR_PAL; EXP is blitted into the healthbox
    // which uses TAG_HEALTHBOX_PAL (cyan/blue fill). Bake both.
    cache.write(root + "/elements.rgba", bake_sheet_rgba(elGfx, barPal, 320, 24));
    cache.write(root + "/elements_exp.rgba", bake_sheet_rgba(elGfx, hbPal, 320, 24));

    // Terrains (BG2). Palettes load at BG_PLTT_ID(2) -> tilemap palNum 2/3/4.
    const terrains = BattleChromeExtract.requireTerrainTable(get, cfg);
    const terrainMeta: Record<string, TerrainMeta> = {};
    const terrainOrder: string[] = [];
    for (const t of terrains) {
      const tr = t.cfg;
      if (tr) {
        terrainMeta[t.key] = bake_terrain(get, cache, root, t.key, tr);
        terrainOrder.push(t.key);
      }
    }

    const grass = terrainMeta.grass ?? { w: 256, h: 256 };
    const terrainLines: string[] = [];
    for (const key of terrainOrder) {
      const m = terrainMeta[key]!;
      terrainLines.push(format(
        '    %s = { file = "terrain_%s.rgba", postDexFile = %q, w = %d, h = %d },', key, key, m.postDexFile, m.w, m.h));
    }

    // Party summary bar (128x8); balls use elements tiles 66..69.
    if (cfg.party_summary_bar) {
      const [barGfx] = Lz77.decompress(get, cfg.party_summary_bar);
      cache.write(root + "/party_summary_bar.rgba", bake_sheet_rgba(barGfx, hbPal, 128, 8));
    }

    const manifest = format(`return {
  format = %d,
  textboxW = %d, textboxH = %d,
  terrainW = %d, terrainH = %d,
  terrains = {
%s
  },
  partySummaryBar = { file = "party_summary_bar.rgba", w = 128, h = 8 },
  partyBarPlayer = { x = 136, y = 96 },
  partyBarOpponent = { x = 104, y = 40 },
  -- pret InitBattlerHealthboxCoords / sBattlerCoords (singles)
  -- Player TL uses stale 64x32 centerToCorner (\xe2\x88\x9232,\xe2\x88\x9216) even though shape is 64x64
  playerBox = { w = 128, h = 64, x = 158, y = 88 },
  enemyBox = { w = 128, h = 32, x = 44, y = 30 },
  doublesPlayerBox = { w = 128, h = 32, file = "healthbox_doubles_player.rgba" },
  doublesOpponentBox = { w = 128, h = 32, file = "healthbox_doubles_opponent.rgba" },
  -- src/battle_interface.c:615, :735
  safariBox = { w = 128, h = 64, x = 158, y = 88, file = "healthbox_safari.rgba" },
  -- Sprite centers before pic y_offset; final Y = base + y_offset [+8 player]
  playerSprite = { x = 72, y = 80 },
  enemySprite = { x = 176, y = 40 },
  -- HP bar: subsprite origin (center\xe2\x88\x9216, center) relative to box TL
  playerHpBar = { x = 32, y = 16, pixels = 48 },
  enemyHpBar = { x = 24, y = 16, pixels = 48 },
  playerExpBar = { x = 32, y = 32, pixels = 64 },
  hpBarPixels = 48,
  expBarPixels = 64,
  msgY = 120,
  panelH = 40,
}
`, BattleChromeExtract.FORMAT_VERSION, tw, th, grass.w, grass.h, terrainLines.join("\n"));
    cache.write(root + "/manifest.lua", manifest);

    return { root, textboxW: tw, textboxH: th, terrains: terrainOrder };
  },

  // Lua: battle_chrome_extract.lua:702
  // NOT FAITHFUL: without a cache, only CacheFs is consulted (no love.filesystem / io.open).
  ready(cache: Cache | undefined, cacheRoot?: string): boolean {
    const root = (cacheRoot ?? default_cache_root()) + "/" + BattleChromeExtract.CACHE_SUB;
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
      } catch { /* no bound cache */ }
      return false;
    };
    return valid_file(root + "/manifest.lua", 20)
      && valid_file(root + "/healthbox_player.rgba", 128 * 64 * 4)
      && valid_file(root + "/terrain_building.rgba", 100);
  },
};

export default BattleChromeExtract;
