// MYSTERY GIFT: pokegold engine/link/mystery_gift.asm (DoMysteryGift),
// mystery_gift_2.asm (StageDataForMysteryGift, MysteryGiftGetItem/
// GetDecoration), mystery_gift_3.asm (StagePartyDataForMysteryGift), and the
// SRAM bytes it keeps, carried on save.mysteryGift:
//
//   unlocked     sMysteryGiftUnlocked / sNumDailyMysteryGiftPartnerIDs != -1:
//                set by Carrie in the Goldenrod Dept. Store 5F (UnlockMysteryGift);
//                the main menu offers MYSTERY GIFT once it is
//   item         sMysteryGiftItem: the gift waiting with the Pokecenter 2F's
//                delivery man (CheckMysteryGift / GetMysteryGiftItem); 0 none
//   ids          sDailyMysteryGiftPartnerIDs: today's partners, five at most
//   timer        sMysteryGiftTimer: a one-day countdown; when it runs out the
//                day's partners are forgotten (DoMysteryGiftIfDayHasPassed)
//   decos        sMysteryGiftDecorationsReceived: decorations already sent home
//   trainerHouse sMysteryGiftTrainerHouseFlag, with partnerName and trainer
//                (the last partner's party): the Viridian TRAINER HOUSE's CAL2
//
// The cart beams this between two Game Boy Colors by infrared; here the same
// two records cross on the wireless link (a session in its own "gift" mode,
// so only another console at its MYSTERY GIFT screen answers). What each side
// gets is decided by the OTHER side's record -- its coin flip between an item
// and a decoration and its two weighted picks, which lean on its trainer ID --
// exactly as on the cart.

import { BugContest } from "./BugContest.ts";
import { Decorations } from "./Decorations.ts";
import { random } from "../platform/rng.ts";
import { GameVersion } from "../shared/core/GameVersion.ts";

export const MAX_MYSTERY_GIFT_PARTNERS = 5;

// data/items/mystery_gift_items.asm
export const MYSTERY_GIFT_ITEMS = [
  "BERRY", "PRZCUREBERRY", "MINT_BERRY", "ICE_BERRY", "BURNT_BERRY", "PSNCUREBERRY",
  "GUARD_SPEC", "X_DEFEND", "X_ATTACK", "BITTER_BERRY", "DIRE_HIT", "X_SPECIAL",
  "X_ACCURACY", "EON_MAIL", "MORPH_MAIL", "MUSIC_MAIL", "MIRACLEBERRY", "GOLD_BERRY",
  "REVIVE", "GREAT_BALL", "SUPER_REPEL", "MAX_REPEL", "ELIXER", "ETHER",
  "WATER_STONE", "FIRE_STONE", "LEAF_STONE", "THUNDERSTONE", "MAX_ETHER", "MAX_ELIXER",
  "MAX_REVIVE", "SCOPE_LENS", "HP_UP", "PP_UP", "RARE_CANDY", "BLUESKY_MAIL",
  "MIRAGE_MAIL",
];

// data/decorations/mystery_gift_decos.asm, as DECOFLAG_* numbers
// (constants/deco_constants.asm): JIGGLYPUFF, POLIWAG, DIGLETT, STARYU,
// MAGIKARP, ODDISH, GENGAR, SHELLDER, GRIMER, VOLTORB dolls, CLEFAIRY and
// JIGGLYPUFF posters, SNES, WEEDLE, GEODUDE, MACHOP dolls, MAGNAPLANT,
// TROPICPLANT, FAMICOM, N64, BULBASAUR, SQUIRTLE dolls, PINK and POLKADOT
// beds, RED, BLUE, YELLOW, GREEN carpets, JUMBOPLANT, VIRTUAL BOY, BIG ONIX,
// PIKACHU poster, BIG LAPRAS, SURF PIKACHU doll, PIKACHU bed, UNOWN and
// TENTACOOL dolls.
export const MYSTERY_GIFT_DECOS = [
  22, 26, 27, 28, 29, 30, 31, 32, 33, 34, 13, 14, 16, 35, 37, 38, 8, 9, 15, 17,
  23, 25, 1, 2, 4, 5, 6, 7, 10, 18, 41, 12, 42, 20, 3, 36, 39,
];

// MysteryGiftFallbackItem: `ld c, DECOFLAG_RED_CARPET ; GREAT_BALL`
const FALLBACK_ITEM = "GREAT_BALL";
const FALLBACK_DECO = 4;

/** One side's record: wMysteryGiftPlayerData, then the party for the
 *  TRAINER HOUSE (wMysteryGiftTrainer). */
export interface GiftRecord {
  game: string;
  id: number;
  name: string;
  caught: number;
  sentDeco: boolean;
  whichItem: number;
  whichDeco: number;
  /** A gift still waiting at a Pokecenter (sBackupMysteryGiftItem != 0). */
  waiting: boolean;
  count: number;
  party: { level: number; species: string; moves: string[] }[];
}

export type GiftResult =
  | { kind: "fiveADay" }
  | { kind: "oneADay" }
  | { kind: "giftWaiting" }
  | { kind: "friendNotReady" }
  | { kind: "item"; partner: string; item: string }
  | { kind: "deco"; partner: string; deco: number };

export interface GiftState {
  unlocked: boolean;
  item: string | 0;
  ids: number[];
  timer?: { remaining: number; day: number };
  decos: Record<string, boolean>;
  trainerHouse?: boolean;
  partnerName?: string;
  trainer?: GiftRecord["party"];
}

/** StageDataForMysteryGift's .RandomSample: an index into the gift tables,
 *  0-15 nine times in ten, then 16-23, 24-31, 32-33 ever more rarely, with
 *  bits of the trainer ID (`hi`/`lo`) choosing within each band. `rand()` is
 *  Random: 0-255. */
export function randomSample(hi: number, lo: number, rand: () => number = () => random(256) - 1): number {
  // `ld e, $80 / .loop rlc e / dec a / jr nz`: bit (a - 1) & 7 of the ID byte,
  // bit 7 for a = 0 (the loop runs 256 times)
  const bit = (a: number, byte: number): number => ((byte >> ((a + 7) & 7)) & 1);
  if (rand() >= 25) { // cp 10 percent
    const a = rand() & 7;
    return a * 2 + bit(a, lo);
  }
  if (rand() >= 50) { // cp 20 percent - 1
    const a = rand() & 3;
    return a * 2 + bit(a, hi) + 0x10;
  }
  if (rand() >= 50) return ((hi >> 4) & 7) + 0x18;
  return hi & 0x80 ? 0x21 : 0x20;
}

export const MysteryGift = {
  state(save: any): GiftState {
    const g = save?.mysteryGift;
    const out: GiftState = {
      unlocked: g?.unlocked === true,
      item: typeof g?.item === "string" && g.item !== "" ? g.item : 0,
      ids: Array.isArray(g?.ids) ? g.ids.filter((n: unknown) => typeof n === "number").slice(0, MAX_MYSTERY_GIFT_PARTNERS) : [],
      decos: g?.decos && typeof g.decos === "object" ? g.decos : {},
    };
    if (g?.timer && typeof g.timer.day === "number") out.timer = { remaining: Number(g.timer.remaining ?? 0), day: g.timer.day };
    if (g?.trainerHouse === true) {
      out.trainerHouse = true;
      out.partnerName = String(g.partnerName ?? "");
      out.trainer = Array.isArray(g.trainer) ? g.trainer : [];
    }
    if (save) save.mysteryGift = out;
    return out;
  },

  unlocked(save: any): boolean {
    return save?.mysteryGift?.unlocked === true;
  },

  /** UnlockMysteryGift: the first time only, and with no gift waiting. */
  unlock(save: any): void {
    const g = MysteryGift.state(save);
    if (g.unlocked) return;
    g.unlocked = true;
    g.item = 0;
    g.ids = [];
  },

  /** DoMysteryGiftIfDayHasPassed: a countdown never armed reads as run out. */
  dayPassed(save: any, now?: any): void {
    const g = MysteryGift.state(save);
    const stamp = now ?? BugContest.now();
    let expired = true;
    if (g.timer) {
      const s = { day: g.timer.day };
      const since = BugContest.elapsedSince(s, stamp, "day");
      g.timer.day = s.day;
      g.timer.remaining = Math.max(0, g.timer.remaining - since.days);
      expired = g.timer.remaining <= 0;
    }
    if (!expired) return;
    // InitOneDayCountdown, then ResetDailyMysteryGiftLimitIfUnlocked
    g.timer = { remaining: 1, day: stamp.day ?? 0 };
    if (g.unlocked) g.ids = [];
  },

  /** StageDataForMysteryGift + StagePartyDataForMysteryGift. */
  stage(save: any, data: any, rand?: () => number): GiftRecord {
    const g = MysteryGift.state(save);
    const id = Number(save?.player?.id ?? 0) & 0xffff;
    const hi = id >> 8;
    const lo = id & 0xff;
    // The cart's Random mixes in the free-running timer (rDIV), so a gift is
    // never the same roll twice for the same press; the game's own stream is
    // seeded the same at every boot (gen2/main.ts), so this one is not used.
    const r = rand ?? ((): number => Math.floor(Math.random() * 256));
    const caught = Object.values(save?.pokedex?.caught ?? {}).filter((v) => v === true).length;
    const party = (Array.isArray(save?.party) ? save.party : [])
      .filter((m: any) => m && !m.isEgg && typeof m.species === "string")
      .map((m: any) => ({
        level: Number(m.level ?? 1),
        species: m.species,
        moves: (Array.isArray(m.moves) ? m.moves : []).map((mv: any) => (typeof mv === "string" ? mv : mv?.id)).filter(Boolean).slice(0, 4),
      }));
    void data;
    return {
      game: GameVersion.get(),
      id,
      name: String(save?.player?.name ?? "?"),
      caught: Math.min(255, caught),
      sentDeco: (r() & 1) === 1,
      whichItem: randomSample(hi, lo, r),
      whichDeco: randomSample(lo, hi, r),
      waiting: g.item !== 0,
      count: g.ids.length,
      party,
    };
  },

  /** DoMysteryGift after a good exchange: the checks in the cart's order,
   *  then what the partner's record sends. */
  receive(save: any, mine: GiftRecord, theirs: GiftRecord, data?: any): GiftResult {
    const g = MysteryGift.state(save);
    if (g.ids.length >= MAX_MYSTERY_GIFT_PARTNERS) return { kind: "fiveADay" };
    if (g.ids.includes(theirs.id & 0xffff)) return { kind: "oneADay" };
    if (mine.waiting) return { kind: "giftWaiting" };
    if (theirs.waiting) return { kind: "friendNotReady" };
    // .AddMysteryGiftPartnerID, .SaveMysteryGiftTrainerName
    g.ids.push(theirs.id & 0xffff);
    g.trainerHouse = true;
    g.partnerName = String(theirs.name ?? "").slice(0, 10);
    const known = (m: any): boolean => !!m && typeof m.species === "string" && (!data?.pokemon || !!data.pokemon[m.species]);
    g.trainer = (Array.isArray(theirs.party) ? theirs.party : []).filter(known).slice(0, 6).map((m) => ({
      level: Math.max(1, Math.min(100, Math.floor(Number(m.level) || 1))),
      species: String(m.species),
      moves: (Array.isArray(m.moves) ? m.moves : []).map(String).filter((mv) => !data?.moves || !!data.moves[mv]).slice(0, 4),
    }));
    const partner = String(theirs.name ?? "?");
    if (theirs.sentDeco) {
      const deco = MYSTERY_GIFT_DECOS[theirs.whichDeco] ?? FALLBACK_DECO;
      // CheckAndSetMysteryGiftDecorationAlreadyReceived: a second copy turns
      // into the item instead
      if (!g.decos[String(deco)]) {
        g.decos[String(deco)] = true;
        return { kind: "deco", partner, deco };
      }
    }
    const item = MYSTERY_GIFT_ITEMS[theirs.whichItem] ?? FALLBACK_ITEM;
    g.item = item;
    return { kind: "item", partner, item };
  },

  /** CheckMysteryGift: nonzero while a gift waits at the counter. */
  waiting(save: any): boolean {
    return MysteryGift.state(save).item !== 0;
  },

  /** GetMysteryGiftItem's hand-over, once the PACK has taken it. */
  take(save: any): string | 0 {
    const g = MysteryGift.state(save);
    const item = g.item;
    g.item = 0;
    return item;
  },

  /** CopyMysteryGiftReceivedDecorationsToPC: a received decoration is the
   *  player's (its decoration flag set). */
  giveDecoration(save: any, deco: number): void {
    if (!save) return;
    save.events = save.events ?? {};
    // (from the main menu: no world, so the save's own event bytes)
    Decorations.giveFlag({
      get: (f: number) => save.events[f],
      set: (f: number, v: boolean) => { save.events[f] = v; },
    }, deco);
  },
};
