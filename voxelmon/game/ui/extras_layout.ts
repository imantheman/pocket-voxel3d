// ENHANCEMENTS and CHEATS: every word the two screens show, and which row
// sits where, in one place -- the Gen 2 games mirror this wording.
//
//   OPTION (top screen)   two pages, turned with L/R (or SELECT):
//                           SETTINGS      the existing rows, then CHEATS
//                           ENHANCEMENTS  SPEED, then the five below
//   the gear (bottom)     an ENHANCEMENTS app, always on HOME and in the L/R
//                         order: the same rows on the same save keys, so a
//                         change on either screen shows on the other
//                         (enhancementIndex / setEnhancement below are the
//                         one reading and writing both use). And a CHEATS
//                         app, only while OPTION's CHEATS row is ON. Hiding
//                         it leaves every cheat as it was set (they stay
//                         active).
//
// What each setting does is in ../extras.ts (SPEED: ../gamespeed.ts,
// VISIBLE WILD: ../visiblewild.ts).

import { GAME_SPEEDS, GAME_SPEED_LABEL, gameSpeedIndex, setGameSpeedIn } from "../gamespeed.ts";
import { VISIBLE_WILD_MODES } from "../visiblewild.ts";

/** OPTION's pages, in L/R order. */
export const OPTION_PAGES = ["SETTINGS", "ENHANCEMENTS"] as const;
export type OptionPage = (typeof OPTION_PAGES)[number];

export const ON_OFF = ["OFF", "ON"] as const;

/** The SETTINGS page's last row: shows the gear's CHEATS app. */
export const CHEATS_ROW = { key: "cheats", label: "CHEATS", choices: ON_OFF } as const;

export interface ExtrasRowDef {
  /** The save.options key. */
  key: string;
  label: string;
  choices: readonly string[];
  /** What each choice saves, by index; a toggle (false / true) without. */
  values?: readonly unknown[];
}

/**
 * The SPEED row heads ENHANCEMENTS: GAME SPEED (../gamespeed.ts), the logic
 * at 1X or 2X, saved as the port-only options.gameSpeed (1 or 2) -- not
 * gen1recomp's own speed keys. Its words are gamespeed.ts's GAME_SPEEDS.
 */
export const SPEED_ROW: ExtrasRowDef = {
  key: "gameSpeed", label: GAME_SPEED_LABEL, choices: GAME_SPEEDS.map((s) => s.label),
};
export const SPEED_ROW_READY = true;

/**
 * VISIBLE WILD (../visiblewild.ts): OFF, or the wild mons about the map in
 * place of random battles, a few (SOME) or more (MANY). options.visibleWild.
 */
export const VISIBLE_WILD_ROW: ExtrasRowDef = {
  key: "visibleWild", label: "VISIBLE WILD", choices: ["OFF", "SOME", "MANY"], values: VISIBLE_WILD_MODES,
};

/** ENHANCEMENTS, after SPEED: four toggles (OFF first), then VISIBLE WILD. */
export const ENHANCEMENT_ROWS: readonly ExtrasRowDef[] = [
  { key: "expForCatching", label: "EXP FOR CATCHING", choices: ON_OFF },
  { key: "partyExpShare", label: "PARTY EXP SHARE", choices: ON_OFF },
  { key: "tradeEvoLv40", label: "TRADE EVO LV.40", choices: ON_OFF },
  { key: "hmsWithoutMove", label: "HMS WITHOUT MOVE", choices: ON_OFF },
  VISIBLE_WILD_ROW,
];

/** Every ENHANCEMENTS row in order, SPEED first: OPTION's page and the
 *  gear's app both list exactly these. */
export function enhancementDefs(): ExtrasRowDef[] {
  return [...(SPEED_ROW_READY ? [SPEED_ROW] : []), ...ENHANCEMENT_ROWS];
}

type Opts = Record<string, unknown>;

/** The choice a row shows for these options: SPEED's 1X / 2X, a row's own
 *  values, else a toggle's OFF / ON. Unset or unknown reads as the first. */
export function enhancementIndex(opts: Opts, d: ExtrasRowDef): number {
  if (d === SPEED_ROW) return gameSpeedIndex(opts);
  if (d.values) return Math.max(0, d.values.indexOf(opts[d.key]));
  return opts[d.key] === true ? 1 : 0;
}

/** Set a row to choice `at` (clamped): what both screens write. */
export function setEnhancement(opts: Opts, d: ExtrasRowDef, at: number): void {
  const i = Math.max(0, Math.min(d.choices.length - 1, at));
  if (d === SPEED_ROW) setGameSpeedIn(opts, GAME_SPEEDS[i]!.key);
  else if (d.values) opts[d.key] = d.values[i];
  else opts[d.key] = i === 1;
}

// ---------------------------------------------------------------------------
// the gear's ENHANCEMENTS app
// ---------------------------------------------------------------------------

export const ENHANCEMENTS_APP = {
  title: "ENHANCEMENTS",
  // HOME's pill: a whole word of six glyphs at most (the one place to
  // change it); the header and the L/R order keep the full title
  short: "EXTRAS",
  about: ["SPEED, EXP, EVOLUTION, HMS", "AND VISIBLE WILD POKéMON."],
} as const;

/**
 * The two lines the app's box at the foot says while a row is the last one
 * tapped (18 glyphs a line), by choice for SPEED and VISIBLE WILD. The rows
 * themselves carry OPTION's own labels, whole: one too long to share its
 * row with its pill has the value on the row under it.
 */
export const ENHANCEMENT_GEAR: Record<string, { about: string | Record<string, string> }> = {
  gameSpeed: { about: { "1X": "THE GAME'S OWN PACE.", "2X": "EVERYTHING TWICE AS FAST." } },
  expForCatching: { about: "A CATCH PAYS EXP, AS A WIN DOES." },
  partyExpShare: { about: "EVERY MON IN THE PARTY EARNS EXP." },
  tradeEvoLv40: { about: "TRADE EVOLUTIONS ALSO BY LEVEL 40." },
  hmsWithoutMove: { about: "THE HM AND ITS BADGE ARE ENOUGH." },
  visibleWild: {
    about: {
      OFF: "RANDOM BATTLES, AS THE GAME HAS THEM.",
      SOME: "NO RANDOM BATTLES. A FEW ROAM.",
      MANY: "NO RANDOM BATTLES. MANY ROAM.",
    },
  },
};

// ---------------------------------------------------------------------------
// the gear's CHEATS app
// ---------------------------------------------------------------------------

export const CHEATS_APP = {
  title: "CHEATS",
  short: "CHEATS",
  about: ["WILD BATTLES, CATCHING,", "MONEY, THE DEX AND ITEMS."],
} as const;

/** WILD ENCOUNTERS' values, by save key (extras.ts WILD_MODES). */
export const WILD_LABELS: Record<string, string> = {
  none: "NONE", less: "LESS", normal: "NORMAL", more: "MORE",
};

export type CheatRowKind = "cycle" | "toggle" | "action";

export interface CheatRowDef {
  key: string;
  label: string;
  kind: CheatRowKind;
  /** An action's button. */
  button?: string;
  /** The info box's two lines (18 glyphs each), by value for a cycle. */
  about: string | Record<string, string>;
}

/** The app's rows, top to bottom. */
export const CHEAT_ROWS: readonly CheatRowDef[] = [
  {
    key: "wildEncounters", label: "WILD ENCOUNTERS", kind: "cycle",
    about: {
      none: "NO RANDOM BATTLES. STORY ONES STAY.",
      less: "HALF AS MANY RANDOM BATTLES.",
      normal: "THE GAME'S OWN RATE OF BATTLES.",
      more: "TWICE AS MANY RANDOM BATTLES.",
    },
  },
  { key: "alwaysCatch", label: "ALWAYS CATCH", kind: "toggle", about: "ANY BALL CATCHES. TRAINERS BLOCK." },
  // the reference's own name, whole: too long to share a row with its pill,
  // so the gear puts its value on the row under it
  { key: "instantVictory", label: "INSTANT VICTORY", kind: "toggle", about: "FIGHT KNOCKS OUT THE FOE AT ONCE." },
  { key: "infiniteMoney", label: "INFINITE MONEY", kind: "toggle", about: "MONEY STAYS AT ¥999999." },
  { key: "dexFull", label: "DEX FULL", kind: "action", button: "FILL", about: "EVERY POKéMON SEEN AND OWNED." },
  { key: "giveItems", label: "GIVE ITEMS", kind: "action", button: "OPEN", about: "ANY ITEM INTO THE BAG OR THE PC." },
];

/** The confirmations and what an action says when it is done. */
export const CHEAT_TEXT = {
  yes: "YES",
  no: "NO",
  back: "BACK",
  give: "GIVE",
  dexAsk: "FILL THE POKéDEX?",
  dexDone: "THE POKéDEX IS FULL!",
  giveAsk: (qty: number, name: string) => `GIVE ${qty} ${name}?`,
  // the item page says these under the item's own name: 18 glyphs at most
  gaveBag: (qty: number) => `${qty} PUT IN THE BAG.`,
  gavePc: (qty: number) => `${qty} PUT IN THE PC.`,
  gaveSplit: (bag: number, pc: number) => `BAG ${bag}, PC ${pc}.`,
  have: "ALREADY HAVE ONE.",
  full: "BAG AND PC FULL.",
  notNow: "NOT NOW!",
  quantity: "QUANTITY",
  oneOnly: "ONLY ONE",
  page: (at: number, of: number) => `PAGE ${at}/${of}`,
  presets: [1, 10, 50, 99] as const,
} as const;
