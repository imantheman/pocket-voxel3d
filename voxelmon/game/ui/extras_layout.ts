// ENHANCEMENTS and CHEATS: every word the two screens show, and which row
// sits where, in one place -- the Gen 2 games mirror this wording.
//
//   OPTION (top screen)   two pages, turned with L/R (or SELECT):
//                           SETTINGS      the existing rows, then CHEATS
//                           ENHANCEMENTS  SPEED, then the four below
//   the gear (bottom)     a CHEATS app, on HOME and in the L/R order, only
//                         while OPTION's CHEATS row is ON. Hiding it leaves
//                         every cheat as it was set (they stay active).
//
// What each setting does is in ../extras.ts.

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
}

/**
 * The SPEED row heads ENHANCEMENTS. Its setter comes from the game-speed
 * work; until that is merged the row is held back (SPEED_ROW_READY), so no
 * build shows a row that does nothing.
 */
export const SPEED_ROW: ExtrasRowDef = { key: "speed", label: "SPEED", choices: ["1X", "2X"] };
export const SPEED_ROW_READY = false;

/** ENHANCEMENTS, after SPEED. Toggles, OFF first. */
export const ENHANCEMENT_ROWS: readonly ExtrasRowDef[] = [
  { key: "expForCatching", label: "EXP FOR CATCHING", choices: ON_OFF },
  { key: "partyExpShare", label: "PARTY EXP SHARE", choices: ON_OFF },
  { key: "tradeEvoLv40", label: "TRADE EVO LV.40", choices: ON_OFF },
  { key: "hmsWithoutMove", label: "HMS WITHOUT MOVE", choices: ON_OFF },
];

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
      normal: "AS MANY RANDOM BATTLES AS THE GAME.",
      more: "TWICE AS MANY RANDOM BATTLES.",
    },
  },
  { key: "alwaysCatch", label: "ALWAYS CATCH", kind: "toggle", about: "EVERY BALL CATCHES. TRAINERS STILL BLOCK." },
  // INSTANT VICTORY on the reference's menu: fifteen glyphs leave no column
  // before the gear's ON/OFF pill, so the gear says INSTANT WIN
  { key: "instantVictory", label: "INSTANT WIN", kind: "toggle", about: "FIGHT KNOCKS OUT THE FOE AT ONCE." },
  { key: "infiniteMoney", label: "INFINITE MONEY", kind: "toggle", about: "MONEY STAYS AT ¥999999." },
  { key: "dexFull", label: "DEX FULL", kind: "action", button: "SET", about: "EVERY POKéMON SEEN AND OWNED." },
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
  gaveBag: (qty: number, name: string) => `${qty} ${name} TO THE BAG.`,
  gavePc: (qty: number, name: string) => `${qty} ${name} TO THE PC.`,
  gaveSplit: (bag: number, pc: number) => `${bag} TO THE BAG, ${pc} TO THE PC.`,
  have: "YOU ALREADY HAVE ONE.",
  full: "THE BAG AND PC ARE FULL.",
  notNow: "NOT NOW!",
  quantity: "QUANTITY",
  oneOnly: "ONLY ONE",
  page: (at: number, of: number) => `PAGE ${at}/${of}`,
  presets: [1, 10, 50, 99] as const,
} as const;
