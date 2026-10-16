// ENHANCEMENTS and CHEATS for Red, Blue and Yellow: the rules half. Every
// setting is a port-only key in save.options (beside cameraSpeed, tiltShift
// and the rest), OFF / NORMAL unless set, so a save that never opened them
// plays the cart. gen1recomp keeps unknown option keys as they are, and the
// VC save conversion writes only the cart's own option byte (text speed,
// animations, battle style), so none of these reach a cartridge save.
//
// The menu wording lives in ui/extras_layout.ts; this file is what each
// setting DOES, kept pure so the tests can drive it without a game:
//
//   expForCatching   a ball that catches awards the battle's EXP, exactly as
//                    a faint would (battle.ts throwBall -> awardExp).
//   partyExpShare    every standing party mon earns from every win: the mons
//                    that fought get the full amount (no split between them),
//                    the rest half (expShareSplit). EXP.ALL is ignored while
//                    it is on: the share already covers the whole party.
//   tradeEvoLv40     the four trade evolutions also happen on a level-up at
//                    level 40 or above (rules/evolution.ts tradeLevel).
//   hmsWithoutMove   CUT, FLY, SURF, STRENGTH and FLASH can be used outside
//                    battle with the HM in the bag and the badge the cart
//                    asks for, whether or not a party mon knows the move.
//   wildEncounters   NONE / LESS (half the map's rate) / NORMAL / MORE
//                    (double, capped at 255). Only the random step roll:
//                    fishing, scripted and static battles are untouched.
//   alwaysCatch      every ball thrown at a catchable mon catches. Trainers
//                    still block, the tower ghost still dodges, the SAFARI
//                    ZONE still counts its balls.
//   instantVictory   FIGHT knocks the foe's mon out on the spot, through the
//                    real faint path (EXP, the next trainer mon, prize money,
//                    the script's win flags). Not in link battles, not
//                    against the unidentified GHOST.
//   infiniteMoney    money is held at 999999 (the cart's ceiling) while on;
//                    turning it off keeps whatever is there.
//   cheats           whether the gear shows its CHEATS app. Hiding the app
//                    does not switch the cheats off: they keep their values.
//
// DEX FULL and GIVE ITEMS are one-shot actions (fillDex, giveItem).

import * as Bag from "./rules/bag.ts";
import { pcBag, pcCapacityData } from "./world/pcitems.ts";

export interface ExtrasOptions {
  speed?: unknown;
  expForCatching?: boolean;
  partyExpShare?: boolean;
  tradeEvoLv40?: boolean;
  hmsWithoutMove?: boolean;
  cheats?: boolean;
  wildEncounters?: string;
  alwaysCatch?: boolean;
  instantVictory?: boolean;
  infiniteMoney?: boolean;
}

type SaveLike = { options?: ExtrasOptions | null } | null | undefined;

export type ExtrasFlag =
  | "expForCatching" | "partyExpShare" | "tradeEvoLv40" | "hmsWithoutMove" | "cheats"
  | "alwaysCatch" | "instantVictory" | "infiniteMoney";

/** A boolean setting: on only when explicitly true. */
export function extraOn(save: SaveLike, key: ExtrasFlag): boolean {
  return (save?.options as Record<string, unknown> | undefined)?.[key] === true;
}

// ---------------------------------------------------------------------------
// WILD ENCOUNTERS
// ---------------------------------------------------------------------------

export const WILD_MODES = ["none", "less", "normal", "more"] as const;
export type WildMode = (typeof WILD_MODES)[number];

export function wildMode(save: SaveLike): WildMode {
  const v = save?.options?.wildEncounters;
  return (WILD_MODES as readonly string[]).includes(v as string) ? (v as WildMode) : "normal";
}

/** The step roll's rate (out of 256) under a mode: 0 rolls nothing. */
export function encounterRateFor(rate: number, mode: WildMode): number {
  if (mode === "none") return 0;
  if (mode === "less") return rate > 0 ? Math.max(1, Math.floor(rate / 2)) : 0;
  if (mode === "more") return Math.min(255, rate * 2);
  return rate;
}

// ---------------------------------------------------------------------------
// PARTY EXP SHARE
// ---------------------------------------------------------------------------

/**
 * The divisor apply() takes for a mon under the party share: 1 (the full
 * amount) for a mon that was out in the battle, 2 (half the base EXP, so
 * half the EXP give or take the floor) for one that sat on the bench.
 */
export function expShareSplit(participated: boolean): number {
  return participated ? 1 : 2;
}

// ---------------------------------------------------------------------------
// TRADE EVO LV. 40
// ---------------------------------------------------------------------------

export const TRADE_EVO_LEVEL = 40;

/** The level a trade evolution happens at on a level-up, or undefined. */
export function tradeEvoLevel(save: SaveLike): number | undefined {
  return extraOn(save, "tradeEvoLv40") ? TRADE_EVO_LEVEL : undefined;
}

// ---------------------------------------------------------------------------
// HMS WITHOUT MOVE
// ---------------------------------------------------------------------------

/** The HM item and the badge each field move needs (the cart's own pairs). */
export const FIELD_HMS: Record<string, { item: string; badge: string }> = {
  CUT: { item: "HM_CUT", badge: "CASCADEBADGE" },
  FLY: { item: "HM_FLY", badge: "THUNDERBADGE" },
  SURF: { item: "HM_SURF", badge: "SOULBADGE" },
  STRENGTH: { item: "HM_STRENGTH", badge: "RAINBOWBADGE" },
  FLASH: { item: "HM_FLASH", badge: "BOULDERBADGE" },
};

interface HmSave {
  options?: ExtrasOptions | null;
  inventory?: Record<string, number>;
  pcItems?: Record<string, number>;
}

/** HMS WITHOUT MOVE lets `move` be used: the option, the HM, the badge. The
 *  HM may be in the bag or the PC -- it is the player's either way. */
export function hmWithoutMove(save: HmSave | null | undefined, move: string): boolean {
  if (!save || !extraOn(save, "hmsWithoutMove")) return false;
  const need = FIELD_HMS[move];
  if (!need) return false;
  const inv = save.inventory ?? {};
  const hasHm = (inv[need.item] ?? 0) > 0 || (save.pcItems?.[need.item] ?? 0) > 0;
  return hasHm && (inv[need.badge] ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// INFINITE MONEY
// ---------------------------------------------------------------------------

/** The cart's ceiling: three BCD bytes. */
export const MONEY_MAX = 999999;

/** Hold the money at the ceiling while the cheat is on (every frame). */
export function holdMoney(save: (SaveLike & { money?: number }) | null | undefined): void {
  if (save && extraOn(save, "infiniteMoney") && typeof save.money === "number" && save.money !== MONEY_MAX) {
    save.money = MONEY_MAX;
  }
}

// ---------------------------------------------------------------------------
// DEX FULL
// ---------------------------------------------------------------------------

interface DexData {
  pokemon: Record<string, { dex?: number }>;
}

/** Every species of this game's dex (1-151) seen and owned. Returns how many
 *  were newly owned. */
export function fillDex(save: { pokedex?: { seen: Record<string, boolean>; owned: Record<string, boolean> } }, data: DexData): number {
  const dex = (save.pokedex ??= { seen: {}, owned: {} });
  dex.seen ??= {};
  dex.owned ??= {};
  let added = 0;
  for (const [id, def] of Object.entries(data.pokemon)) {
    const n = def?.dex ?? 0;
    if (n < 1 || n > 151) continue;
    if (!dex.owned[id]) added += 1;
    dex.seen[id] = true;
    dex.owned[id] = true;
  }
  return added;
}

// ---------------------------------------------------------------------------
// GIVE ITEMS
// ---------------------------------------------------------------------------

interface ItemDef {
  name?: string;
  index?: number;
  keyItem?: boolean;
  tossable?: boolean;
  machine?: { kind?: string; number?: number };
}
interface ItemData {
  items?: Record<string, ItemDef>;
  constants?: unknown;
  field?: unknown;
}

/**
 * Not items a bag holds, so never offered: the badges (inventory flags), the
 * lift panel's floor names, the unused SURFBOARD and ITEM_2C ("?????"), the
 * duplicate PP UP at $32, the COIN (the coin case's count), the POKéDEX (an
 * event flag here, not a bag item) and SAFARI BALLs (the warden's own count).
 */
export function giveable(id: string, def: ItemDef | undefined): boolean {
  if (!def) return false;
  if (Bag.isBadge(id) || id.startsWith("FLOOR_")) return false;
  if (["SURFBOARD", "ITEM_2C", "ITEM_32", "COIN", "POKEDEX", "SAFARI_BALL"].includes(id)) return false;
  if ((def.name ?? "").includes("?")) return false;
  return true;
}

/** Every item GIVE ITEMS offers, in the cart's order (items, then HMs, TMs). */
export function giveItemList(data: ItemData): string[] {
  const rank = (d: ItemDef): number =>
    d.machine ? (d.machine.kind === "HM" ? 1000 : 2000) + (d.machine.number ?? 0) : (d.index ?? 999);
  return Object.entries(data.items ?? {})
    .filter(([id, d]) => giveable(id, d))
    .sort((a, b) => rank(a[1]) - rank(b[1]))
    .map(([id]) => id);
}

/** A key item or an HM: one is all anyone holds. */
export function oneOnly(data: ItemData, id: string): boolean {
  return Bag.precious(data as never, id);
}

export interface GiveResult {
  bag: number;
  pc: number;
  /** Why nothing went anywhere ("have" -- a key item already held -- or "full"). */
  refused?: "have" | "full";
}

type GiveSave = Bag.BagSave & { pcItems?: Record<string, number>; pcOrder?: string[] };

/**
 * Put `qty` of `id` in the bag, the rest (a full bag, a stack at 99) in the
 * PC; key items and HMs are capped at one, and refused if already held.
 */
export function giveItem(save: GiveSave, data: ItemData, id: string, qty: number): GiveResult {
  const out: GiveResult = { bag: 0, pc: 0 };
  if (!giveable(id, data.items?.[id])) { out.refused = "full"; return out; }
  const box = pcBag(save);
  const one = oneOnly(data, id);
  if (one && ((save.inventory[id] ?? 0) > 0 || (box.inventory[id] ?? 0) > 0)) {
    out.refused = "have";
    return out;
  }
  let left = one ? 1 : Math.max(1, Math.min(99, Math.floor(qty)));
  const room = (s: Bag.BagSave, cap: number): number => {
    const have = s.inventory[id];
    if (have !== undefined) return Math.max(0, 99 - have);
    return Bag.slots(s) < cap ? 99 : 0;
  };
  const toBag = Math.min(left, room(save, Bag.capacity(data as never)));
  if (toBag > 0 && Bag.add(save, id, toBag, data as never)) {
    out.bag = toBag;
    left -= toBag;
  }
  if (left > 0) {
    const pcData = pcCapacityData(data as never);
    const toPc = Math.min(left, room(box, Bag.capacity(pcData)));
    if (toPc > 0 && Bag.add(box, id, toPc, pcData)) out.pc = toPc;
  }
  if (out.bag === 0 && out.pc === 0) out.refused = "full";
  return out;
}
