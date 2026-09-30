// Port of gen1recomp RomExtractorGen2.lua:5754-6381 extractMenuGfx
// (bdfac727): menu chrome that is not part of the font -- the naming
// screen's tiles, the battle HUD (borders, back-pics, trainer pics, exp/HP
// bars, ball icons), the PACK, emotes, the heal machine, the egg hatch,
// the stats page tiles and the Game Corner's slots / card flip sheets --
// plus the screens in menugfx-screens.ts (#DEX, Bill's PC, POKeGEAR,
// trainer card, Unown puzzle), called at the point Brian calls them.
//
// Gold only: KrisBackpic, ChrisPic/KrisPic (HOF), _CGB_PackPals.ChrisPackPals
// / KrisPackPals and KrisFishingGFX are Crystal labels, absent from Gold's
// manifest, and dropped. Brian's `self:trace` on a failed trainer pic is
// dropped too (the pic is just skipped, as in Lua).
//
// Every image is a shade sheet (0..3, 0xff transparent). The slot machine
// actor sheet (:6218) is composed on ImageWriter.blank(.., 1, 1, 1, 0) --
// transparent -- and blitted from colour-0-transparent tiles, so it is a
// plain shade image too; no RGB is written anywhere in this stage.
// Palettes ride the JSON as [r, g, b] 0-255 (Brian's self:colors).

import { GfxImage, TRANSPARENT, blit, decode2bpp } from "../gfx.ts";
import type { Gen2Ctx } from "./ctx.ts";
import { decompressLz3 } from "./lz.ts";
import { columnsToRows, deinterleave, picBank, save, write2bpp, writeCompressedPic } from "./helpers.ts";
import { type Rgb, colors } from "./palettes.ts";
import { billsPcGfx, pokedexGfx, pokegearGfx, trainerCardGfx, unownPuzzleGfx } from "./menugfx-screens.ts";

/** RomExtractorGen2.lua:392 inkFrom1bpp — a set bit is black ink (3), a
 * clear bit transparent. (Same as font.ts's; kept local so this stage does
 * not depend on another stage's module.) */
function inkFrom1bpp(raw: number[], width: number, height: number): GfxImage {
  const image = new GfxImage(width, height, TRANSPARENT);
  const tilesPerRow = width / 8;
  for (let tile = 0; tile < Math.floor(raw.length / 8); tile++) {
    const tileX = (tile % tilesPerRow) * 8;
    const tileY = Math.floor(tile / tilesPerRow) * 8;
    for (let y = 0; y < 8; y++) {
      const row = raw[tile * 8 + y]!;
      for (let x = 0; x < 8; x++) if ((row >> (7 - x)) & 1) image.set(tileX + x, tileY + y, 3);
    }
  }
  return image;
}

/** Brian's writeRaw paths ("assets/generated/<rel>") -> "<rel>". */
function rawKey(relative: string): string {
  return relative.replace(/^assets\/generated\//, "");
}

/** :6194 pad2bpp — pad with 0 / trim to width*height/4 bytes. */
function pad2bpp(raw: number[], width: number, height: number): number[] {
  const need = (width * height) / 4;
  const out = raw.slice(0, need);
  while (out.length < need) out.push(0);
  return out;
}

// :6187-6192 canonical Game Corner sheet sizes (pret gfx/slots, gfx/card_flip).
const SLOTS1 = [16, 152] as const;
const SLOTS2 = [16, 256] as const;
const SLOTS3 = [24, 240] as const;
const CARD1 = [128, 32] as const;
const CARD2 = [24, 160] as const;
const CARD3 = [8, 56] as const;

interface OamEntry {
  x: number;
  y: number;
  t: number;
  xf?: boolean;
}

// :6230-6267 OAMData_SlotsGolem / Chansey* (data/sprite_anims/oam.asm).
const GOLEM: OamEntry[] = [
  { x: -2, y: -2, t: 0x00 }, { x: -1, y: -2, t: 0x02 }, { x: 0, y: -2, t: 0x00, xf: true },
  { x: -2, y: 0, t: 0x04 }, { x: -1, y: 0, t: 0x06 }, { x: 0, y: 0, t: 0x04, xf: true },
];
const chanseyTop: OamEntry[] = [{ x: -2, y: -2, t: 0x00 }, { x: -1, y: -2, t: 0x02 }, { x: 0, y: -2, t: 0x04 }];
const chanseyBottom = (a: number): OamEntry[] => [
  { x: -2, y: 0, t: a }, { x: -1, y: 0, t: a + 2 }, { x: 0, y: 0, t: a + 4 },
];
const CHANSEY: OamEntry[][] = [
  [...chanseyTop, ...chanseyBottom(0x06)],
  [...chanseyTop, ...chanseyBottom(0x0c)],
  [...chanseyTop, ...chanseyBottom(0x12)],
  [...chanseyTop, ...chanseyBottom(0x18)],
  [{ x: -2, y: -2, t: 0x1e }, { x: -1, y: -2, t: 0x20 }, { x: 0, y: -2, t: 0x22 }, ...chanseyBottom(0x24)],
];

/** :6210 composeSlotsActors — rebuild the 24x240 actor sheet from Slots3LZ's
 * unique 8x16 OBJ columns. Transparent backdrop, colour 0 transparent. */
export function composeSlotsActors(raw: number[]): GfxImage {
  const tileCount = Math.floor(raw.length / 16);
  const tiles: GfxImage[] = [];
  for (let index = 0; index < tileCount; index++) {
    const one: number[] = [];
    for (let b = 0; b < 16; b++) one.push(raw[index * 16 + b] ?? 0);
    tiles.push(decode2bpp(one, 8, 8, true));
  }
  const sheet = new GfxImage(SLOTS3[0], SLOTS3[1], TRANSPARENT);
  const blit8x16 = (tileId: number, dx: number, dy: number, flipX: boolean): void => {
    const top = tiles[tileId];
    const bot = tiles[tileId + 1];
    if (!top || !bot) return;
    blit(sheet, top, dx, dy, 0, 0, 8, 8, flipX);
    blit(sheet, bot, dx, dy + 8, 0, 0, 8, 8, flipX);
  };
  const blitPose = (poseY: number, base: number, entries: OamEntry[]): void => {
    for (const e of entries) blit8x16(base + e.t, (e.x + 2) * 8, poseY + (e.y + 2) * 8, e.xf ?? false);
  };
  blitPose(0, 0x00, GOLEM);
  blitPose(32, 0x08, GOLEM);
  CHANSEY.forEach((frame, i) => blitPose(32 + (i + 1) * 32, 0x10, frame));
  blit8x16(0x3a, 0, 224, false);
  return sheet;
}

/** :6280 expandCardFlip2 — re-insert the --remove-whitespace tiles
 * (2, 5, .., 23) so the sheet is pret's 60 tiles. */
export function expandCardFlip2(compact: number[]): number[] {
  const out: number[] = new Array((CARD2[0] * CARD2[1]) / 4).fill(0);
  let src = 0;
  for (let tile = 0; tile < 60; tile++) {
    if (tile <= 23 && tile % 3 === 2) continue;
    for (let b = 0; b < 16; b++) out[tile * 16 + b] = compact[src * 16 + b] ?? 0;
    src += 1;
  }
  return out;
}

/**
 * RomExtractorGen2.lua:5754 extractMenuGfx. Returns:
 *  - "menu_gfx": { generation 2, source, border, cursor, middleLine,
 *    underLine, battleHud, pack, pokedex, billsPc?, pokegear, trainerCard,
 *    unownPuzzle, emotes, healMachine?, eggHatch?, stats?, slots?,
 *    cardFlip? } -- image fields are gfx keys, tile ids numbers, palettes
 *    [r,g,b][]; pack.pocketName / pack.palettes / paletteZones are arrays
 *    (element i = Lua [i+1]); pack.paletteZones' palette field is 1-based.
 *  - "slots/gold_slots.tilemap" (20x12 = 240 bytes) and
 *    "card_flip/card_flip.tilemap" (11x12 = 132 bytes): Brian's raw
 *    CacheFs files, as Uint8Array; menu_gfx names them by the same keys.
 */
export function extractMenuGfx(ctx: Gen2Ctx): Record<string, unknown> {
  const files: Record<string, unknown> = {};
  const out: Record<string, unknown> = { generation: 2, source: "ROM:NamingScreenGFX_*" };
  const bytesOf = (label: string, length: number, offset = 0): number[] => {
    const s = ctx.symbol(label);
    return ctx.rom.bytes(s.bank, s.address + offset, length);
  };

  // :5759-5783 naming screen: opaque border, 8x16 OBJ cursor, 1bpp ink lines.
  out.border = write2bpp(ctx, bytesOf("NamingScreenGFX_Border", 16), 8, 8, "naming/border.png");
  out.cursor = write2bpp(ctx, bytesOf("NamingScreenGFX_Cursor", 32), 8, 16, "naming/cursor.png", true);
  for (const [key, label] of [
    ["middleLine", "NamingScreenGFX_MiddleLine"],
    ["underLine", "NamingScreenGFX_UnderLine"],
  ] as const) {
    out[key] = save(ctx, inkFrom1bpp(bytesOf(label, 8), 8, 8), `naming/${key.toLowerCase()}.png`);
  }

  // :5798-5811 battle HUD borders (1bpp ink).
  const hud: Record<string, unknown> = {};
  hud.enemyBorder = save(ctx, inkFrom1bpp(bytesOf("EnemyHPBarBorderGFX", 4 * 8), 32, 8), "battle/hud/enemy_border.png");
  hud.enemyBorderFirstTile = 0x6c;
  hud.playerBorder = save(ctx, inkFrom1bpp(bytesOf("HPExpBarBorderGFX", 6 * 8), 48, 8), "battle/hud/player_border.png");
  hud.playerBorderFirstTile = 0x73;

  // :5818-5823 ChrisBackpic, 6 tiles square (pcall'd in Lua).
  if (ctx.location("ChrisBackpic")) {
    try {
      writeCompressedPic(ctx, "ChrisBackpic", 6, "battle/player_back.png");
      hud.playerBack = "battle/player_back";
    } catch {
      /* Lua pcall: leave playerBack unset */
    }
  }
  // :5827-5842 KrisBackpic is Crystal-only: dropped.
  // :5847-5852 DudeBackpic, the catching tutorial's.
  if (ctx.location("DudeBackpic")) {
    try {
      writeCompressedPic(ctx, "DudeBackpic", 6, "battle/dude_back.png");
      hud.dudeBack = "battle/dude_back";
    } catch {
      /* Lua pcall */
    }
  }

  // :5860-5912 TrainerPicPointers, `dec a` so row 0 is class 1 (FALKNER).
  if (ctx.location("TrainerPicPointers")) {
    const symbol = ctx.symbol("TrainerPicPointers");
    const classOrder = ctx.manifest.constants.trainerClassOrder ?? [];
    const pics: Record<string, string> = {};
    // Element j (Lua index j+1); j = 0 is TRAINER_NONE, which has no row.
    for (let j = 1; j < classOrder.length; j++) {
      const cls = classOrder[j]!;
      const base = symbol.address + (j - 1) * 3;
      const bank = picBank(ctx.rom.byte(symbol.bank, base));
      const address = ctx.rom.word(symbol.bank, base + 1);
      const rel = `battle/trainers/${cls.toLowerCase()}.png`;
      try {
        // GetLZByte crosses into the next bank at $8000 (:5872-5878).
        const compressed = [...ctx.rom.bytes(bank, address, 0x8000 - address), ...ctx.rom.bytes(bank + 1, 0x4000, 0x4000)];
        const pixels = pad2bpp(decompressLz3(compressed), 56, 56);
        pics[cls] = write2bpp(ctx, columnsToRows(pixels, 7, 7), 56, 56, rel);
      } catch {
        /* Lua: trace and skip */
      }
    }
    // :5895-5910 ChrisPic/KrisPic (HOF) are Crystal labels: dropped.
    hud.trainerPics = pics;
  }

  // :5914-5935 exp bar, its end cap, and the ball icons.
  hud.expBar = write2bpp(ctx, bytesOf("ExpBarGFX", 9 * 16), 72, 8, "battle/hud/exp_bar.png");
  hud.expBarFirstTile = 0x55;
  hud.expBarCells = 9;
  if (ctx.location("EndOfExpBarGFX")) {
    hud.expBarEnd = write2bpp(ctx, bytesOf("EndOfExpBarGFX", 16), 8, 8, "battle/hud/exp_bar_end.png", true);
  }
  hud.balls = write2bpp(ctx, bytesOf("LoadBallIconGFX.gfx", 4 * 16), 32, 8, "battle/hud/balls.png", true);
  hud.ballsFirstTile = 0x31;

  // :5942-5953 "HP:" and the bar cells as a plain 2bpp sheet.
  hud.hpBar = write2bpp(ctx, bytesOf("FontBattleExtra", 12 * 16), 96, 8, "battle/hud/hp_bar.png");
  hud.hpBarTiles = 12;
  hud.battleExtra = "fonts/font_battle_extra"; // the font stage's sheet
  hud.battleExtraFirstTile = 0x60;
  hud.hpLabelTiles = [0x60, 0x61];
  hud.hpBarEmptyTile = 0x62;
  hud.hpBarFullTile = 0x6a;
  hud.hpBarEndTile = 0x6b;
  out.battleHud = hud;

  // :5972-6031 PACK.
  const pack: Record<string, unknown> = {};
  pack.menu = write2bpp(ctx, bytesOf("PackMenuGFX", 0x60 * 16), 128, 48, "pack/menu.png");
  pack.menuTiles = 0x60;
  pack.menuTilesWide = 16;
  pack.backgroundTile = 0x24;
  pack.headerFirstTile = 0x28;
  pack.pack = write2bpp(ctx, bytesOf("PackGFX", 60 * 16), 40, 96, "pack/pack.png");
  pack.packFirstTile = 0x50;
  pack.packTilesWide = 5;
  pack.packTilesHigh = 3;
  pack.pocketPicture = { ITEM: 15, BALL: 45, KEY_ITEM: 0, TM_HM: 30 };
  const pocketRaw = bytesOf("DrawPocketName.tilemap", 60);
  pack.pocketName = [0, 1, 2, 3].map((block) => pocketRaw.slice(block * 15, block * 15 + 15));
  pack.pocketOrder = ["ITEM", "BALL", "KEY_ITEM", "TM_HM"];
  // :6008-6022 Gold's _CGB_PackPals.PackPals (Crystal's Chris/Kris split dropped).
  const packPals = ctx.symbol("_CGB_PackPals.PackPals");
  const packPalettes: Rgb[][] = [];
  for (let i = 0; i < 6; i++) packPalettes.push(colors(ctx, packPals.bank, packPals.address + i * 8, 4));
  pack.palettes = packPalettes;
  pack.paletteZones = [
    [0, 0, 10, 1, 2],
    [10, 0, 10, 1, 3],
    [7, 2, 1, 9, 4],
    [0, 7, 5, 3, 5],
    [0, 3, 5, 3, 6],
  ];
  out.pack = pack;

  // :6032-6036, in Brian's order (gfx.bin entries follow it).
  out.pokedex = pokedexGfx(ctx);
  const billsPc = billsPcGfx(ctx);
  if (billsPc) out.billsPc = billsPc;
  out.pokegear = pokegearGfx(ctx);
  out.trainerCard = trainerCardGfx(ctx);
  out.unownPuzzle = unownPuzzleGfx(ctx);

  // :6042-6101 emotes (OBJ, colour 0 transparent), 4 tiles row-major.
  const emotes: Record<string, unknown> = {};
  const emoteOrder = ["shock", "question", "happy", "sad", "heart", "bolt", "sleep", "fish"];
  const emoteLabels: Record<string, string> = {
    shock: "ShockEmote",
    question: "QuestionEmote",
    happy: "HappyEmote",
    sad: "SadEmote",
    heart: "HeartEmote",
    bolt: "BoltEmote",
    sleep: "SleepEmote",
    fish: "FishEmote",
  };
  for (const key of emoteOrder) {
    const at = ctx.location(emoteLabels[key]!);
    if (at) emotes[key] = write2bpp(ctx, ctx.rom.bytes(at[0], at[1], 4 * 16), 16, 16, `emotes/${key}.png`, true);
  }
  emotes.order = emoteOrder;
  const objSheet = (label: string, tiles: number, w: number, h: number, rel: string, field: string): void => {
    const at = ctx.location(label);
    if (at) emotes[field] = write2bpp(ctx, ctx.rom.bytes(at[0], at[1], tiles * 16), w, h, rel, true);
  };
  objSheet("GrassRustleGFX", 1, 8, 8, "emotes/grass_rustle.png", "grassRustle");
  objSheet("JumpShadowGFX", 1, 8, 8, "emotes/jump_shadow.png", "jumpShadow");
  objSheet("CutGrassGFX", 4, 32, 8, "emotes/cut_grass.png", "cutGrass");
  objSheet("FishingGFX", 8, 16, 32, "emotes/fishing.png", "fishing");
  // :6095 KrisFishingGFX is Crystal-only: dropped.
  out.emotes = emotes;

  // :6112-6121 heal machine OBJ art + gfx/overworld/heal_machine.pal.
  const healGfx = ctx.location("HealMachineAnim.HealMachineGFX");
  if (healGfx) {
    const heal: Record<string, unknown> = {
      sheet: write2bpp(ctx, ctx.rom.bytes(healGfx[0], healGfx[1], 2 * 16), 16, 8, "emotes/heal_machine.png", true),
    };
    const healPal = ctx.location("HealMachineAnim.palettes");
    if (healPal) heal.palette = colors(ctx, healPal[0], healPal[1], 4);
    out.healMachine = heal;
  }

  // :6138-6153 egg hatch: EggPic (5x5 --columns) and EggHatchGFX (OBJ).
  const eggHatch: Record<string, unknown> = {};
  if (ctx.location("EggPic")) {
    try {
      writeCompressedPic(ctx, "EggPic", 5, "battle/front/egg.png");
      eggHatch.egg = "battle/front/egg";
    } catch {
      /* Lua pcall */
    }
  }
  if (ctx.location("EggHatchGFX")) {
    eggHatch.shell = write2bpp(ctx, bytesOf("EggHatchGFX", 2 * 16), 8, 16, "menu/egg_hatch.png", true);
    eggHatch.shellTiles = 2;
  }
  if (eggHatch.egg !== undefined || eggHatch.shell !== undefined) out.eggHatch = eggHatch;

  // :6157-6167 StatsScreenPageTilesGFX: the 17 tiles just before
  // EnemyHPBarBorderGFX.
  const hpBarBorder = ctx.location("EnemyHPBarBorderGFX");
  if (hpBarBorder) {
    const sheet = write2bpp(
      ctx,
      ctx.rom.bytes(hpBarBorder[0], hpBarBorder[1] - 17 * 16, 17 * 16),
      17 * 8,
      8,
      "menu/stats_tiles.png",
    );
    out.stats = { sheet, tiles: 17, firstTile: 0x31 };
  }

  // :6300-6334 Goldenrod Game Corner: slot machine.
  const writeSheet = (raw: number[], [w, h]: readonly [number, number], rel: string): string =>
    write2bpp(ctx, pad2bpp(raw, w, h), w, h, rel);
  const slots: Record<string, unknown> = {};
  if (ctx.location("Slots1LZ")) {
    slots.sheet1 = writeSheet(ctx.decompressLz3Symbol("Slots1LZ"), SLOTS1, "slots/gold_slots_1.png");
  }
  if (ctx.location("Slots2LZ")) {
    const raw2 = deinterleave(ctx.decompressLz3Symbol("Slots2LZ"), SLOTS2[0]);
    // Commercial Gold stores the Seven symbol with inverted bit polarity.
    for (let i = 0; i < Math.min(64, raw2.length); i++) raw2[i] = ~raw2[i]! & 0xff;
    slots.sheet2 = writeSheet(raw2, SLOTS2, "slots/gold_slots_2.png");
  }
  if (ctx.location("Slots3LZ")) {
    const actors = composeSlotsActors(ctx.decompressLz3Symbol("Slots3LZ"));
    slots.sheet3 = save(ctx, actors, "slots/gold_slots_3.png");
    save(ctx, actors, "slots/gold_slots_actors.png");
  }
  if (ctx.location("SlotsTilemap")) {
    const key = rawKey("slots/gold_slots.tilemap");
    files[key] = Uint8Array.from(bytesOf("SlotsTilemap", 20 * 12));
    slots.tilemap = key;
  }
  if (Object.keys(slots).length > 0) out.slots = slots;

  // :6337-6376 card flip.
  const cardFlip: Record<string, unknown> = {};
  if (ctx.location("CardFlipLZ01")) {
    cardFlip.sheet1 = writeSheet(ctx.decompressLz3Symbol("CardFlipLZ01"), CARD1, "card_flip/card_flip_1.png");
  }
  if (ctx.location("CardFlipLZ02")) {
    cardFlip.sheet2 = writeSheet(expandCardFlip2(ctx.decompressLz3Symbol("CardFlipLZ02")), CARD2, "card_flip/card_flip_2.png");
  }
  if (ctx.location("CardFlipLZ03")) {
    cardFlip.sheet3 = writeSheet(ctx.decompressLz3Symbol("CardFlipLZ03"), CARD3, "card_flip/card_flip_3.png");
  }
  if (ctx.location("CardFlipOnButtonGFX")) {
    cardFlip.on = write2bpp(ctx, bytesOf("CardFlipOnButtonGFX", 16), 8, 8, "card_flip/on.png");
  }
  if (ctx.location("CardFlipOffButtonGFX")) {
    cardFlip.off = write2bpp(ctx, bytesOf("CardFlipOffButtonGFX", 16), 8, 8, "card_flip/off.png");
  }
  if (ctx.location("CardFlipTilemap")) {
    const key = rawKey("card_flip/card_flip.tilemap");
    files[key] = Uint8Array.from(bytesOf("CardFlipTilemap", 11 * 12));
    cardFlip.tilemap = key;
  }
  if (Object.keys(cardFlip).length > 0) out.cardFlip = cardFlip;

  return { menu_gfx: out, ...files };
}
