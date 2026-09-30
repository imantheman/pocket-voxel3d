// Title-screen art. The logo, the player figure and the publisher logos are
// plain 2bpp tile strips (not compressed pics), so they decode like the emote
// sheet in field.ts and get composited into flat pages the cook can pack.
import type { Ctx } from "../ctx.ts";
import { GfxImage, TRANSPARENT, blit, decode1bpp, decode2bpp, matteColor0 } from "../gfx.ts";

interface Strip {
  symbol: string;
  key: string;
  cols: number;
  rows: number;
  /** 1bpp strips (build_rom_data.py raw_1bpp): a set bit is black. */
  bpp?: 1 | 2;
  /**
   * OAM art with a white interior: shade 0 stays opaque INSIDE the figure
   * and only the white joined to the edge goes clear, the way
   * build_rom_data.py _matte_color0 floods it, so Red covers the mon he
   * stands in front of and the box edge shows past his shoulder.
   */
  matte?: boolean;
}

const STRIPS: Strip[] = [
  { symbol: "PokemonLogoGraphics", key: "title/logo", cols: 16, rows: 6 },
  // gfx/title/player.png is 40x56 (rom_manifest field/title/player).
  { symbol: "PlayerCharacterTitleGraphics", key: "title/player", cols: 5, rows: 7, matte: true },
  { symbol: "NintendoCopyrightLogoGraphics", key: "title/copyright", cols: 16, rows: 2 },
  { symbol: "GameFreakLogoGraphics", key: "title/gamefreak", cols: 16, rows: 2 },
  // gfx/title/red_version.png: "Red" in tiles 0-1, "Version" in 5-9
  // (title.asm draws the two words at columns 7 and 10).
  { symbol: "Version_GFX", key: "title/version", cols: 10, rows: 1, bpp: 1 },
];

/** Flood the shade-0 pixels joined to the border to transparent. */
function matteEdges(page: GfxImage): void {
  const w = page.w;
  const h = page.h;
  const seen = new Uint8Array(w * h);
  const queue: number[] = [];
  const add = (x: number, y: number): void => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = y * w + x;
    if (seen[i] || page.get(x, y) !== 0) return;
    seen[i] = 1;
    queue.push(i);
  };
  for (let x = 0; x < w; x++) { add(x, 0); add(x, h - 1); }
  for (let y = 0; y < h; y++) { add(0, y); add(w - 1, y); }
  while (queue.length) {
    const i = queue.shift()!;
    const x = i % w;
    const y = Math.floor(i / w);
    page.set(x, y, TRANSPARENT);
    add(x - 1, y); add(x + 1, y); add(x, y - 1); add(x, y + 1);
  }
}

export function extractTitle(ctx: Ctx): Record<string, unknown> {
  const anyCtx = ctx as unknown as { rom: any; gfx: any };
  const out: Record<string, unknown> = {};
  // Yellow's logo sheet is deduplicated, so the sequential strip reads
  // scrambled; its logo comes from the tilemap composition below instead.
  const yellow = ctx.hasSymbol("TitlePikachuBGGraphics");
  for (const s of STRIPS) {
    if (yellow && s.key === "title/logo") continue;
    let sym: any;
    try {
      sym = ctx.symbol(s.symbol);
    } catch {
      console.warn("title: no symbol " + s.symbol);
      continue;
    }
    const tiles = s.cols * s.rows;
    const w = s.cols * 8;
    const h = s.rows * 8;
    try {
      const per = s.bpp === 1 ? 8 : 16;
      const bytes = anyCtx.rom.bytes(sym.bank, sym.address, tiles * per);
      const page = new GfxImage(w, h);
      for (let i = 0; i < tiles; i++) {
        const slice = bytes.slice(i * per, i * per + per);
        const tile = s.bpp === 1
          ? decode1bpp(slice, 8, 8, true)
          : decode2bpp(slice, 8, 8, !s.matte);
        blit(page, tile, (i % s.cols) * 8, Math.floor(i / s.cols) * 8);
      }
      if (s.matte) matteEdges(page);
      anyCtx.gfx.add(s.key, page);
      out[s.key] = { w: w, h: h };
      console.log("title: " + s.key + " " + w + "x" + h);
    } catch (e) {
      console.warn("title: " + s.symbol + " failed: " + String(e).slice(0, 80));
    }
  }
  if (yellow) Object.assign(out, extractYellowTitle(ctx));
  return out;
}

/**
 * Yellow's title (pokeyellow engine/movie/title_yellow.asm, by way of
 * gen1recomp RomExtractor.lua extractYellowTitleArt): a tilemap composition
 * over both tile banks -- PokemonLogoGraphics at BG ids $00-$7F,
 * TitlePikachuBGGraphics at $80-$EF, TitlePikachuOBGraphics at $F0-$FC
 * (also the eye OAM tiles) and PokemonLogoCornerGraphics at $FD-$FF.
 *
 *   title/logo         16x7 logo box at tile (2,1)
 *   title/pika_bubble  7x4 speech bubble at (6,4) + its two tail tiles
 *   title/pikachu      12x9 Pikachu at (4,8) + the right-ear column, open
 *                      eyes (OAM) baked in
 *   title/eyes_half    the (24,16)-(71,31) eye band mid-blink, and
 *   title/eyes_closed  shut -- DoTitleScreenFunction's OB tile swap
 */
function extractYellowTitle(ctx: Ctx): Record<string, unknown> {
  const { rom } = ctx;
  const gfx = (ctx as unknown as { gfx: { add(k: string, i: GfxImage): void } }).gfx;
  const sheet = (label: string, count: number, transparent = false): GfxImage[] => {
    const sym = ctx.symbol(label);
    const raw = rom.bytes(sym.bank, sym.address, count * 16);
    const tiles: GfxImage[] = [];
    for (let o = 0; o < raw.length; o += 16) tiles.push(decode2bpp(raw.slice(o, o + 16), 8, 8, transparent));
    return tiles;
  };
  // tile counts: the Graphics..GraphicsEnd symbol gaps in pokeyellow.sym
  const logo = sheet("PokemonLogoGraphics", 115);
  const corner = sheet("PokemonLogoCornerGraphics", 3);
  const bg = sheet("TitlePikachuBGGraphics", 64);
  const ob = sheet("TitlePikachuOBGraphics", 12);
  const obClear = sheet("TitlePikachuOBGraphics", 12, true);
  const tileFor = (id: number): GfxImage | undefined =>
    id < 0x80 ? logo[id] : id < 0xf0 ? bg[id - 0x80] : id < 0xfd ? ob[id - 0xf0] : corner[id - 0xfd];
  const compose = (cols: number, rows: number, cells: [number, number, number][]): GfxImage => {
    const pose = new GfxImage(cols * 8, rows * 8);
    for (const [id, cx, cy] of cells) {
      const t = tileFor(id);
      if (t) blit(pose, t, cx * 8, cy * 8);
    }
    return pose;
  };
  const mapCells = (label: string, cols: number, rows: number): [number, number, number][] => {
    const sym = ctx.symbol(label);
    return rom.bytes(sym.bank, sym.address, cols * rows).map(
      (id: number, i: number) => [id, i % cols, Math.floor(i / cols)] as [number, number, number],
    );
  };
  // OAM-style: colour-0 pixels leave what is underneath
  const blitSprite = (target: GfxImage, tile: GfxImage, tx: number, ty: number, flipX: boolean): void => {
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const v = tile.get(flipX ? 7 - x : x, y);
        if (v !== TRANSPARENT) target.set(tx + x, ty + y, v);
      }
    }
  };
  const out: Record<string, unknown> = {};
  const save = (key: string, img: GfxImage): void => {
    gfx.add(key, img);
    out[key] = { w: img.w, h: img.h };
    console.log(`title: ${key} ${img.w}x${img.h}`);
  };

  save("title/logo", compose(16, 7, mapCells("TitleScreenPokemonLogoTilemap", 16, 7)));

  const bubble = mapCells("TitleScreenPikaBubbleTilemap", 7, 4);
  bubble.push([0x64, 3, 4], [0x65, 4, 4]);
  save("title/pika_bubble", matteColor0(compose(7, 5, bubble)));

  const cells = mapCells("TitleScreenPikachuTilemap", 12, 9);
  cells.push([0x96, 12, 2], [0x9d, 12, 3], [0xa7, 12, 4], [0xb1, 12, 5]);
  const pikachu = matteColor0(compose(13, 9, cells));
  // the eye OAM, relative to the box origin px (32,64): the left eye
  // x-flipped (attr $22); tile sets at +0 open, +4 half, +8 closed
  const EYES: [number, number, number, boolean][] = [
    [1, 24, 16, true], [0, 32, 16, true], [3, 24, 24, true], [2, 32, 24, true],
    [0, 56, 16, false], [1, 64, 16, false], [2, 56, 24, false], [3, 64, 24, false],
  ];
  // the blink overlays first: the BG face is eyeless, so each is the blank
  // face crop with that tile set on top -- exactly the hardware mid-blink
  for (const [name, base] of [["title/eyes_half", 4], ["title/eyes_closed", 8]] as const) {
    const band = new GfxImage(48, 16);
    blit(band, pikachu, 0, 0, 24, 16, 48, 16);
    for (const [i, x, y, flip] of EYES) blitSprite(band, obClear[base + i]!, x - 24, y - 16, flip);
    save(name, band);
  }
  for (const [i, x, y, flip] of EYES) blitSprite(pikachu, obClear[i]!, x, y, flip);
  save("title/pikachu", pikachu);
  return out;
}
