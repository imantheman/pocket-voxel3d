// Port of gen1recomp src/import/gba/rse/trainer_card_extract.lua (GPLv3 + additional terms; see LICENSE.md).
// The Hoenn-style trainer card the FRLG ROM carries (for link play), baked
// into rse/trainer_card/ as indexed PNGs plus a LuaWriter manifest.

import { K, type Ctx, type Pal } from "./boot_gfx.ts";
import { Versions } from "../versions.ts";
import { format } from "../lua.ts";
import type { Cache } from "../cache.ts";
import type { Rom } from "../rom.ts";

const SUB = "rse/trainer_card";

// pokeemerald/src/trainer_card.c:265
// Lua: rse/trainer_card_extract.lua:8 (keys 0..4)
const STAR_PALS = [
  "gHoennTrainerCardGreen_Pal", "sHoennTrainerCardBronze_Pal", "sHoennTrainerCardCopper_Pal",
  "sHoennTrainerCardSilver_Pal", "sHoennTrainerCardGold_Pal",
];

// Lua: rse/trainer_card_extract.lua:13
const FILES: string[] = ["badges.png", "star.png"];
for (let stars = 0; stars <= 4; stars++) {
  for (const side of ["screen", "front", "back"]) {
    FILES.push(format("%s_%d.png", side, stars));
    FILES.push(format("%s_%d_female.png", side, stars));
  }
}

// Lua: rse/trainer_card_extract.lua:23
function mapString(entries: number[]): string {
  let out = "";
  for (const e of entries) out += String.fromCharCode(e % 256, Math.floor(e / 256));
  return out;
}

// Lua: rse/trainer_card_extract.lua:29 -- [ctx, versions table]
function context(rom: Rom, cache: Cache, opts: Record<string, any> | undefined): [Ctx, Record<string, any>] {
  opts = opts ?? {};
  let V: Record<string, any>;
  try { V = Versions.forGame(opts.game ?? rom.id); } catch { V = Versions; }
  if (typeof V.HOENN_CARD !== "object" || V.HOENN_CARD === null) return [K.context(rom, cache, opts, SUB), V];
  const map = Versions.HOENN_CARD;
  const row = (name: string): Record<number, number> => {
    const r = map[name];
    if (!r) throw new Error("hoenn card: no offset for " + name);
    return r;
  };
  const S = {
    off: (name: string): number => row(name)[1]!,
    size: (name: string): number => row(name)[2]!,
  };
  return [K.contextWith(rom, cache, opts, SUB, S, Versions.active()), Versions];
}

// Lua: rse/trainer_card_extract.lua:44
function pics(c: Ctx, V: Record<string, any>): { male: number; female: number } {
  const classes = V.HOENN_CARD_PIC_CLASSES;
  const base = V.FACILITY_CLASS_TO_PIC_INDEX;
  return { male: c.u8(base + classes.male), female: c.u8(base + classes.female) };
}

export const RseTrainerCardExtract = {
  SUB,
  STAR_PALS,
  FILES,
  REQUIRED: K.required(SUB, FILES),

  // Lua: rse/trainer_card_extract.lua:50 -- [true, manifest]
  run(rom: Rom, cache: Cache, opts?: { cacheRoot?: string; game?: string }): [boolean, Record<string, any>] {
    const [c, V] = context(rom, cache, opts);
    // pokeemerald/src/trainer_card.c:532
    const gfx = c.lz("gHoennTrainerCard_Gfx");
    const maps: Record<string, string> = {
      screen: c.lz("gHoennTrainerCardBg_Tilemap"),
      front: c.lz("gHoennTrainerCardFront_Tilemap"),
      back: c.lz("gHoennTrainerCardBack_Tilemap"),
    };
    // NOT FAITHFUL (order): `for side, map in pairs(maps)`; LuaJIT's pairs order
    // for this table (front, back, screen; seen in the reference manifest's
    // file list) is used.
    const PAIRS_ORDER = ["front", "back", "screen"];
    const layers: Record<string, any> = {};
    for (let stars = 0; stars <= 4; stars++) {
      // pokeemerald/src/trainer_card.c:1434
      const pal = c.pal(STAR_PALS[stars]!, 48);
      const fem: Pal = {};
      for (let i = 0; i <= 47; i++) fem[i] = pal[i]!;
      c.pal("sHoennTrainerCardFemaleBg_Pal", 16, fem, 16);
      for (const side of PAIRS_ORDER) {
        const map = maps[side]!;
        const [idx, W, H] = K.bakeText(gfx, map, 30, 20, { linear: true, mapWidth: 30 });
        const key = format("%s_%d", side, stars);
        layers[key] = c.layer({
          key, opaque: side === "screen", variants: [
            { name: "", pal }, { name: "female", pal: fem },
          ],
        }, idx, W, H, pal);
      }
    }

    // pokeemerald/src/trainer_card.c:1507
    const badgeGfx = c.lz("sHoennTrainerCardBadges_Gfx");
    const badgePal = c.pal("sHoennTrainerCardBadges_Pal", 16);
    const entries: number[] = [];
    for (let row = 0; row <= 1; row++) {
      for (let col = 0; col <= 15; col++) entries.push(row * 16 + col);
    }
    const [bIdx, BW, BH] = K.bakeText(badgeGfx, mapString(entries), 16, 2, { linear: true, mapWidth: 16 });
    c.png("badges.png", BW, BH, bIdx, badgePal, true);

    const starPal = c.pal("sTrainerCardStar_Pal", 16);
    const [sIdx, SW, SH] = K.bakeText(gfx, mapString([143]), 1, 1, { linear: true, mapWidth: 1 });
    c.png("star.png", SW, SH, sIdx, starPal, true);

    return [true, c.finish({
      screen: "trainer_card",
      cardType: "emerald",
      layers,
      badges: { png: c.path("badges.png"), w: BW, h: BH },
      star: { png: c.path("star.png"), w: SW, h: SH },
      // pokeemerald/src/trainer_card.c:287
      picOffset: [1, 0],
      pics: pics(c, V),
    })];
  },

  // Lua: rse/trainer_card_extract.lua:101
  ready(cache: Cache | undefined, cacheRoot?: string): boolean {
    return K.ready(SUB, cache, cacheRoot);
  },
};

export default RseTrainerCardExtract;
