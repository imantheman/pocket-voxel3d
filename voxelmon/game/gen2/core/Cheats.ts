// The port's ENHANCEMENTS and CHEATS for the Gold/Silver/Crystal engine --
// none of it the cart's. Every setting is a port-only option on the options
// table (Save.loadOptions / saveOptions, the `gold` block of this game's
// options file, which also rides on save.options); a key that was never set
// reads as its default, so a save that never opened the rows plays as the
// cart does. The keys and what each one does:
//
// ENHANCEMENTS (the OPTION screen's ENHANCEMENTS page)
//   expForCatching  EXP FOR CATCHING  a caught wild mon pays the battle's EXP
//                   exactly as if it had fainted (Battle.caught).
//   partyExpShare   PARTY EXP SHARE   every party mon earns EXP from a
//                   defeated foe: the ones that fought get the cart's share,
//                   every other healthy (non-egg) mon half of one fighter's
//                   share, with the stat exp halved the same way. Level ups
//                   and new moves follow for all of them. While it is on the
//                   cart's EXP SHARE item adds nothing: no tax on the
//                   fighters and no second pass for holders -- a holder is
//                   paid like any other mon (Battle.awardExperience).
//   tradeEvoLv40    TRADE EVO LV.40   a trade evolution happens at level 40 or
//                   above through the normal level-up flow (after a battle, or
//                   a RARE CANDY). The trade-with-item ones need the item held,
//                   and it is used up as the trade would; an EVERSTONE still
//                   stops it (Evolution.METHODS EVOLVE_TRADE).
//   hmsWithoutMove  HMS WITHOUT MOVE  CUT, SURF, STRENGTH, WHIRLPOOL,
//                   WATERFALL, HEADBUTT and ROCK SMASH work from the overworld,
//                   and FLY and FLASH from any mon's party menu, without a mon
//                   knowing the move -- as long as the bag holds the HM (or
//                   the TM for HEADBUTT / ROCK SMASH) and the player has the
//                   badge the cart asks for (FieldMoves.partyMoveUser,
//                   PartyMenu.buildSubmenuItems).
//   visibleWild     VISIBLE WILD      off / some / many: wild mons stand in
//                   the overworld where a step could meet one, and walking
//                   into one is that battle; random step encounters stop
//                   while it is on. The whole set of rules is
//                   world/VisibleWild.ts's header.
//
// CHEATS (the bottom screen's CHEATS tab, shown while `cheats` is on; turning
// the tab off hides it and leaves every cheat as it was set -- they keep
// working while hidden)
//   wildEncounters  WILD ENCOUNTERS   none / less / normal / more: the step
//                   encounter rate halved (less) or doubled (more, capped at
//                   the byte). NONE: no ordinary encounter at all, but the
//                   rate is still rolled for a roaming beast on the map, so
//                   the roamers can still be met; scripted and static battles,
//                   fishing, HEADBUTT, ROCK SMASH and SWEET SCENT are as ever.
//                   The Bug-Catching Contest keeps its own rates.
//   shinyOdds       SHINY ODDS        8192 (the cart) / 4096 / 1024 / 512 /
//                   64 / 1: the chance a freshly rolled DV set is shiny. Every
//                   mon whose DVs are rolled -- wild, static, roaming, gift
//                   and gift-egg mons (Mon.randomDVs) -- and a day-care egg
//                   (Breeding.makeEgg) are shiny with exactly 1 in N; the
//                   rest roll ordinary DVs, so stats stay valid. Trainer mons
//                   and the NPC trades keep their fixed DVs.
//   alwaysCatch     ALWAYS CATCH      every ball thrown at a wild mon catches
//                   (the tutorial catch, the trainer's blocked ball and the
//                   contest's PARK BALL counter are unchanged).
//   instantVictory  INSTANT WIN       choosing FIGHT (any move) knocks out
//                   the foe's mon in play before either side moves; it faints
//                   as if hit, so EXP, prize money, the win text and the
//                   script's own win branch (flags, badges, phone numbers) all
//                   run as on a real win. A trainer sends the next mon as
//                   usual. Link battles and the Battle Tower are exempt.
//   fastEggs        FAST EGGS         a compatible pair at the day care has
//                   an egg on the next step, and an egg in the party hatches
//                   within FAST_EGG_STEPS steps.
//   infiniteMoney   INFINITE MONEY    the player's money is held at the cap
//                   (999999) every frame while it is on; spending refills it.
//                   MOM's savings are never touched. Turned off, the money
//                   stays where it is.
//   DEX FULL        (one-shot, YES/NO first): every species seen and owned,
//                   and all 26 UNOWN letters in the UNOWN dex. Gen 2's
//                   regional (NEW) dex already lists all 251, so the
//                   reference's regional and national rows are one row here.
//                   (fillDex can also mark them seen only; no row uses it.)
//   GIVE ITEMS      (one-shot): any real item (no glitch ids), into its own
//                   pocket, the rest into the PC when the pocket is full or
//                   the stack reaches 99. KEY ITEMS and HMs are one each.

import { Bag } from "../shared/inventory/Bag.ts";
import { random } from "../platform/rng.ts";

type Options = Record<string, any>;

export type WildRate = "none" | "less" | "normal" | "more";

export const WILD_RATES: WildRate[] = ["none", "less", "normal", "more"];

/** VISIBLE WILD (world/VisibleWild.ts). */
export type VisibleWildMode = "off" | "some" | "many";
export const VISIBLE_WILD_MODES: VisibleWildMode[] = ["off", "some", "many"];
export const VISIBLE_WILD_LABELS: Record<VisibleWildMode, string> = { off: "OFF", some: "SOME", many: "MANY" };
export const WILD_RATE_LABELS: Record<WildRate, string> = {
  none: "NONE", less: "LESS", normal: "NORMAL", more: "MORE",
};
/** SHINY ODDS, 1 in N; the first is the cart's (8 DV patterns in 65536). */
export const SHINY_ODDS = [8192, 4096, 1024, 512, 64, 1];
export const CART_SHINY_ODDS = 8192;
/** FAST EGGS: the most steps a party egg has left. */
export const FAST_EGG_STEPS = 5;
/** wNumPCItems, and a stack's limit (MomShopping's numbers). */
const PC_ITEM_CAPACITY = 50;
const MAX_STACK = 99;
const MAX_MONEY = 999999;
/** Gen 2's shiny Attack DVs (Mon.vanillaShiny: attack mod 4 is 2 or 3). */
const SHINY_ATTACK = [2, 3, 6, 7, 10, 11, 14, 15];

let source: () => Options | null | undefined = () => undefined;

const on = (o: Options | null | undefined, key: string): boolean => !!o && o[key] === true;

/** Mon.vanillaShiny, kept here so this module and Mon need not import each other. */
function isShiny(d: { attack?: number; defense?: number; speed?: number; special?: number }): boolean {
  if (d.speed !== 10 || d.defense !== 10 || d.special !== 10) return false;
  const a = (d.attack ?? 0) % 4;
  return a === 2 || a === 3;
}

export interface GiveResult {
  /** How many went into the PACK, and how many into the PC. */
  bag: number;
  pc: number;
  /** Why fewer than asked were given ("have" for an owned key item / HM). */
  short?: "have" | "full" | "invalid";
}

export const Cheats = {
  /** Where the live options table comes from (Game2 binds its own). */
  bind(fn: () => Options | null | undefined): void {
    source = fn;
  },

  options(): Options {
    return source() ?? {};
  },

  // ------------------------------------------------------------ the readers
  expForCatching: (o: Options | null = Cheats.options()): boolean => on(o, "expForCatching"),
  partyExpShare: (o: Options | null = Cheats.options()): boolean => on(o, "partyExpShare"),
  tradeEvoLv40: (o: Options | null = Cheats.options()): boolean => on(o, "tradeEvoLv40"),
  hmsWithoutMove: (o: Options | null = Cheats.options()): boolean => on(o, "hmsWithoutMove"),
  /** The CHEATS tab on the bottom screen. */
  tabShown: (o: Options | null = Cheats.options()): boolean => on(o, "cheats"),
  alwaysCatch: (o: Options | null = Cheats.options()): boolean => on(o, "alwaysCatch"),
  instantVictory: (o: Options | null = Cheats.options()): boolean => on(o, "instantVictory"),
  fastEggs: (o: Options | null = Cheats.options()): boolean => on(o, "fastEggs"),
  infiniteMoney: (o: Options | null = Cheats.options()): boolean => on(o, "infiniteMoney"),

  /** VISIBLE WILD: "off" unless set to one of the others. */
  visibleWild(o: Options | null = Cheats.options()): VisibleWildMode {
    const v = o ? o.visibleWild : undefined;
    return VISIBLE_WILD_MODES.includes(v) ? v : "off";
  },

  wildRate(o: Options | null = Cheats.options()): WildRate {
    const v = o ? o.wildEncounters : undefined;
    return WILD_RATES.includes(v) ? v : "normal";
  },

  shinyOdds(o: Options | null = Cheats.options()): number {
    const v = Number(o ? o.shinyOdds : undefined);
    return SHINY_ODDS.includes(v) ? v : CART_SHINY_ODDS;
  },

  /** A value one step along a ladder, wrapping (the rows' tap / left-right). */
  step<T>(ladder: readonly T[], current: T, delta: number): T {
    const n = ladder.length;
    const at = Math.max(0, ladder.indexOf(current));
    return ladder[(((at + delta) % n) + n) % n]!;
  },

  // ------------------------------------------------------- WILD ENCOUNTERS
  /** The step encounter rate (out of 256) under WILD ENCOUNTERS. NONE is 0
   *  here; the roamer roll is the caller's (World.tryWildEncounter). */
  scaleEncounterRate(rate: number | undefined, mode: WildRate = Cheats.wildRate()): number | undefined {
    if (rate == null || mode === "normal") return rate;
    if (mode === "none") return 0;
    if (rate <= 0) return rate;
    if (mode === "less") return Math.max(1, Math.floor(rate / 2));
    return Math.min(255, rate * 2);
  },

  // ------------------------------------------------------------ SHINY ODDS
  /** A shiny DV set: Defense, Speed and Special 10, a shiny Attack. */
  shinyDVs(roll: (lo: number, hi: number) => number = random): { attack: number; defense: number; speed: number; special: number } {
    return { attack: SHINY_ATTACK[roll(0, SHINY_ATTACK.length - 1)]!, defense: 10, speed: 10, special: 10 };
  },

  /**
   * DVs rolled under SHINY ODDS `odds` (1 in N): shiny with exactly that
   * chance, otherwise an ordinary set that is NOT shiny. The cart's odds take
   * the cart's roll (`plain`) untouched, so no extra random number is drawn.
   */
  rollDVs<D extends { attack?: number; defense?: number; speed?: number; special?: number }>(
    plain: () => D, odds: number = Cheats.shinyOdds(),
    roll: (lo: number, hi: number) => number = random,
  ): D {
    if (odds === CART_SHINY_ODDS) return plain();
    if (odds <= 1 || roll(1, odds) === 1) return { ...plain(), ...Cheats.shinyDVs(roll) };
    let dvs = plain();
    while (isShiny(dvs)) dvs = plain();
    return dvs;
  },

  /** A day-care egg's DVs once inheritance is done: shiny with 1 in N on top
   *  of the cart's own chance (a shiny parent's passing on still applies). */
  eggDVs<D extends { attack?: number; defense?: number; speed?: number; special?: number }>(
    dvs: D, odds: number = Cheats.shinyOdds(), roll: (lo: number, hi: number) => number = random,
  ): D {
    if (odds === CART_SHINY_ODDS || isShiny(dvs)) return dvs;
    if (odds <= 1 || roll(1, odds) === 1) Object.assign(dvs, Cheats.shinyDVs(roll));
    return dvs;
  },

  // -------------------------------------------------------- INFINITE MONEY
  /** Once a frame (Game2.frame): the money held at the cap. */
  frame(game: any): void {
    const player = game && game.save ? game.save.player : undefined;
    if (!player || !Cheats.infiniteMoney(game.options)) return;
    if (player.money !== MAX_MONEY) player.money = MAX_MONEY;
  },

  // -------------------------------------------------------------- DEX FULL
  /** Every species of this game's dataset, in dex order. */
  species(data: any): string[] {
    const mons = (data && data.pokemon) || {};
    const out: { id: string; dex: number }[] = [];
    for (const id of Object.keys(mons)) {
      const def = mons[id];
      if (def && typeof def === "object" && def.baseStats && typeof def.dex === "number") {
        out.push({ id, dex: def.dex });
      }
    }
    out.sort((a, b) => a.dex - b.dex);
    return out.map((r) => r.id);
  },

  /** DEX ALL SEEN (`owned` false) / DEX FULL (`owned` true); the count. */
  fillDex(save: any, data: any, owned: boolean): number {
    if (!save) return 0;
    save.pokedex = save.pokedex || {};
    save.pokedex.seen = save.pokedex.seen || {};
    save.pokedex.caught = save.pokedex.caught || {};
    const all = Cheats.species(data);
    for (const id of all) {
      save.pokedex.seen[id] = true;
      if (owned) save.pokedex.caught[id] = true;
    }
    if (owned) {
      // wUnownDex: the letters missing appended in alphabetical order, so
      // the ones already caught keep their places (UpdateUnownDex appends).
      const list: number[] = Array.isArray(save.unownDex) ? save.unownDex : [];
      save.unownDex = list;
      for (let letter = 1; letter <= 26; letter++) if (!list.includes(letter)) list.push(letter);
      if (!(Number(save.firstUnownSeen) >= 1)) save.firstUnownSeen = list[0] ?? 1;
    }
    return all.length;
  },

  // ------------------------------------------------------------ GIVE ITEMS
  /** A real item: priced or not, but never an unused ITEM_xx slot or the
   *  cart's TERU-SAMA filler. */
  validItem(data: any, id: string): boolean {
    const def = data && data.items ? data.items[id] : undefined;
    if (!def || typeof def !== "object" || !def.pocket) return false;
    if (/^ITEM_[0-9A-F]{2}$/.test(id)) return false;
    const name = String(def.name ?? "");
    if (name === "" || name.startsWith("TERU")) return false;
    return true;
  },

  /** The valid items of one pocket, in the cart's item order. */
  itemsIn(data: any, pocket: string): string[] {
    const items = (data && data.items) || {};
    return Object.keys(items)
      .filter((id) => Cheats.validItem(data, id) && items[id].pocket === pocket)
      .sort((a, b) => (items[a].index ?? 0) - (items[b].index ?? 0));
  },

  /** One of a kind: KEY ITEMS and HMs. */
  single(data: any, id: string): boolean {
    const def = data && data.items ? data.items[id] : undefined;
    return !!def && (def.pocket === "KEY_ITEM" || id.startsWith("HM_"));
  },

  /** The most of `id` the player may be given now (0 when an owned key item). */
  maxGive(save: any, data: any, id: string): number {
    if (!Cheats.validItem(data, id)) return 0;
    const have = (save && save.inventory && save.inventory[id]) || 0;
    if (Cheats.single(data, id)) return have > 0 ? 0 : 1;
    return MAX_STACK;
  },

  /**
   * `qty` of `id` into its own pocket (Bag.add's own rules: a free slot of
   * that pocket, a stack of at most 99), whatever does not fit into the PC
   * (50 stacks of 99, as ReceiveItem treats wPCItems). TM/HM and KEY ITEMS
   * never go to the PC.
   */
  giveItem(save: any, data: any, id: string, qty: number): GiveResult {
    if (!save || !Cheats.validItem(data, id)) return { bag: 0, pc: 0, short: "invalid" };
    let want = Math.max(0, Math.floor(qty));
    const single = Cheats.single(data, id);
    if (single) {
      if (((save.inventory && save.inventory[id]) || 0) > 0) return { bag: 0, pc: 0, short: "have" };
      want = Math.min(want, 1);
    }
    const have = (save.inventory && save.inventory[id]) || 0;
    const room = Math.max(0, MAX_STACK - have);
    let bag = 0;
    const toBag = Math.min(want, room);
    if (toBag > 0 && Bag.add(save, id, toBag, data)) bag = toBag;
    let pc = 0;
    const pocket = Bag.pocketOf(id, data);
    if (bag < want && pocket !== "TM_HM" && pocket !== "KEY_ITEM") {
      save.pcItems = save.pcItems || {};
      const box: Record<string, number> = save.pcItems;
      const stacks = (n: number): number => Math.ceil((n || 0) / MAX_STACK);
      let used = 0;
      for (const k of Object.keys(box)) used += stacks(box[k]!);
      while (bag + pc < want) {
        const held = box[id] || 0;
        if (used + stacks(held + 1) - stacks(held) > PC_ITEM_CAPACITY) break;
        used += stacks(held + 1) - stacks(held);
        box[id] = held + 1;
        pc++;
      }
    }
    const out: GiveResult = { bag, pc };
    if (bag + pc < want) out.short = "full";
    return out;
  },
};

export default Cheats;
