// Yellow's Surfing Pikachu minigame (engine/minigame/surfing_pikachu.asm):
// its three tile banks and the tilemaps it INCBINs.
//
// The banks are in the manifest (SurfingPikachu1Graphics1-3). The tilemaps
// are not -- they sit inline in the minigame's own bank, unlabelled in the
// manifest -- so their places in the Yellow ROM are written down here. They
// lie back to back exactly as the disassembly lays them out (beach_intro,
// use_control_pad, to_surf_rad, title at $3E:$50BC..$520F), which is the
// check that these are the right bytes. Red and Blue have none of it.
//
// The banks become sheets 16 tiles wide (tile t at column t%16, row t/16),
// raw shades 0-3: the GB screen (game/gb/video.ts, core gb.rs) applies the
// palette registers itself, so nothing here is matted or coloured.
import type { Ctx } from "../ctx.ts";
import { decode2bpp, type GfxImage } from "../gfx.ts";

/** label -> [bank, address, bytes] in the Yellow ROM. */
const TILEMAPS: Record<string, [number, number, number]> = {
  beachIntro: [0x3e, 0x50bc, 240], // SurfingMinigame_BeachIntroTilemap
  useControlPad: [0x3e, 0x51ac, 15], // SurfingMinigame_UseControlPadTilemap
  toSurfRad: [0x3e, 0x51bb, 13], // SurfingMinigame_ToSurfRadTilemap
  title: [0x3e, 0x51c8, 72], // SurfingMinigame_TitleTilemap
  beachOutro: [0x3e, 0x4946, 200], // SurfingMinigame_DrawResultsScreen.BeachOutroTilemap
  highScore1: [0x3a, 0x51c4, 24], // the beach house printer's high score card
  highScore2: [0x3a, 0x51dc, 96],
};

const SHEETS: [string, string, number][] = [
  ["SurfingPikachu1Graphics1", "surf_1a", 80],
  ["SurfingPikachu1Graphics2", "surf_1b", 256],
  ["SurfingPikachu1Graphics3", "surf_1c", 144],
];

export function extractMinigame(ctx: Ctx): Record<string, unknown> | null {
  if (!SHEETS.every(([s]) => ctx.hasSymbol(s))) return null;
  const rom = (ctx as unknown as { rom: { bytes(b: number, a: number, n: number): number[] } }).rom;
  const gfx = (ctx as unknown as { gfx: { add(key: string, image: GfxImage): void } }).gfx;
  const sheets: Record<string, { tiles: number }> = {};
  for (const [symbol, name, tiles] of SHEETS) {
    const sym = ctx.symbol(symbol);
    const rows = Math.ceil(tiles / 16);
    const raw = rom.bytes(sym.bank, sym.address, tiles * 16);
    while (raw.length < rows * 16 * 16) raw.push(0);
    gfx.add(`minigame/${name}`, decode2bpp(raw, 128, rows * 8));
    sheets[name] = { tiles };
  }
  const tilemaps: Record<string, number[]> = {};
  for (const [name, [bank, address, n]] of Object.entries(TILEMAPS)) {
    tilemaps[name] = rom.bytes(bank, address, n);
  }
  return { surfing: { sheets, tilemaps } };
}
