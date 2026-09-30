// Kanto Gear: what the companion knows -- its own saved state (options,
// installed apps, the step counter, notes) and the facts it works out from
// the dataset and the save (encounter odds, a map's trainers and items, a
// move's effect in words, type matchups, route stamps).
//
// Behaviour follows the Kanto Gear mod for gen1recomp (AverageConsumer,
// MIT; see THIRD_PARTY_NOTICES.md): its app set, its three INFO levels, its
// field-tool unlock rules and its move-effect wording.

import { itemBallFlag } from "../../world/mapscripts.ts";
import { hiddenKey } from "../../world/hiddenitems.ts";

// ---------------------------------------------------------------------------
// saved state (save.modData.kanto_gear -- where the mod keeps its own)
// ---------------------------------------------------------------------------

export type InfoLevel = "vanilla" | "enhanced" | "spoiler";

export interface GearNote {
  kind: "text" | "list" | "sketch";
  title: string;
  /** text: the lines; list: one entry per item. */
  lines: string[];
  /** list: which items are ticked. */
  done?: boolean[];
  /** sketch: the ink, run-length over the pad's cells (see notes.ts). */
  ink?: string;
}

export interface GearSave {
  steps: number;
  /** The resettable trip counter under the total. */
  trip: number;
  info: InfoLevel;
  caughtIcon: boolean;
  clock24: boolean;
  qwertz: boolean;
  /** Optional apps the player has removed in the STORE (true = removed). */
  removed: Record<string, boolean>;
  notes: GearNote[];
}

interface SaveLike {
  modData?: Record<string, unknown>;
  [k: string]: unknown;
}

/** The gear's saved state, created with defaults on first use. */
export function gearSave(save: SaveLike | undefined): GearSave {
  const fallback: GearSave = {
    steps: 0, trip: 0, info: "enhanced", caughtIcon: true, clock24: false, qwertz: false,
    removed: {}, notes: [],
  };
  if (!save) return fallback;
  const md = (save.modData ??= {}) as Record<string, unknown>;
  const g = (md.kanto_gear ??= {}) as Partial<GearSave>;
  g.steps ??= 0;
  g.trip ??= 0;
  g.info ??= "enhanced";
  g.caughtIcon ??= true;
  g.clock24 ??= false;
  g.qwertz ??= false;
  g.removed ??= {};
  g.notes ??= [];
  return g as GearSave;
}

/** One step walked (overworld.onStepComplete). */
export function countGearStep(save: SaveLike | undefined): void {
  if (!save) return;
  const g = gearSave(save);
  g.steps = Math.min(9999999, g.steps + 1);
  g.trip = Math.min(9999999, g.trip + 1);
}

/** ENHANCED and SPOILERS turn the mod's assists on; VANILLA is the game alone. */
export function assists(save: SaveLike | undefined): boolean {
  return gearSave(save).info !== "vanilla";
}

export function spoilers(save: SaveLike | undefined): boolean {
  return gearSave(save).info === "spoiler";
}

// ---------------------------------------------------------------------------
// the apps
// ---------------------------------------------------------------------------

export type GearViewId =
  | "home" | "party" | "map" | "explorer" | "trainer" | "pokedex" | "bag"
  | "tools" | "steps" | "stamps" | "notes" | "store" | "options";

export interface GearApp {
  id: GearViewId;
  /** The header's name. */
  title: string;
  /** The home screen's button (6 glyphs at most). */
  short: string;
  /** Can't be removed in the STORE. */
  fixed?: boolean;
  /** The STORE's three lines. */
  about: string[];
}

/** Home order, which is also the L/R order. */
export const APPS: GearApp[] = [
  { id: "home", title: "KANTO GEAR", short: "HOME", fixed: true, about: [] },
  { id: "party", title: "PARTY", short: "PARTY", fixed: true,
    about: ["CHECK YOUR TEAM AT A GLANCE.", "VIEW STATS, MOVES AND STATUS."] },
  { id: "map", title: "MAP", short: "MAP", fixed: true,
    about: ["VIEW THE REGION MAP.", "YOUR POSITION, AT A GLANCE."] },
  { id: "explorer", title: "EXPLORER", short: "GUIDE", fixed: true,
    about: ["EXPLORE THE AREA AROUND YOU.", "FIND POKéMON, ITEMS AND TRAINERS."] },
  { id: "trainer", title: "TRAINER", short: "CARD", fixed: true,
    about: ["REVIEW YOUR TRAINER JOURNEY.", "BADGES, PLAY TIME AND PROGRESS."] },
  { id: "pokedex", title: "POKéDEX", short: "DEX",
    about: ["RESEARCH EVERY SPECIES.", "STATS, MOVES AND HABITATS."] },
  { id: "bag", title: "BAG", short: "BAG",
    about: ["BROWSE EVERY ITEM.", "USE THEM WITH THE GAME'S OWN EFFECTS."] },
  { id: "tools", title: "TOOLS", short: "TOOLS",
    about: ["ONE TAP FOR THE BIKE, THE RODS", "AND YOUR TEAM'S FIELD MOVES."] },
  { id: "steps", title: "STEPS", short: "STEPS",
    about: ["COUNT EVERY STEP OF YOUR JOURNEY.", "ONE SMALL STEP AT A TIME."] },
  { id: "stamps", title: "STAMPS", short: "STAMPS",
    about: ["COLLECT A STAMP FOR EVERY AREA", "YOU FINISH EXPLORING."] },
  { id: "notes", title: "NOTES", short: "NOTES",
    about: ["PLAN ROUTES AND REMINDERS.", "WRITE, CHECK TASKS AND DRAW."] },
  { id: "store", title: "STORE", short: "STORE", fixed: true,
    about: ["ADD OR REMOVE APPS."] },
  { id: "options", title: "OPTIONS", short: "OPTION", fixed: true,
    about: ["HOW MUCH HELP THE GEAR GIVES."] },
];

export function appOf(id: string): GearApp | undefined {
  return APPS.find((a) => a.id === id);
}

// ---------------------------------------------------------------------------
// Gen 1 encounter odds
// ---------------------------------------------------------------------------

/** The grass/water slot chances (engine/battle/wild_encounters.asm
 * WildMonEncounterSlotChances: 51, 51, 39, 25, 25, 25, 13, 13, 11, 3 /256). */
export const SLOT_CHANCE = [51, 51, 39, 25, 25, 25, 13, 13, 11, 3];

export interface WildRow {
  species: string;
  method: "GRASS" | "WATER" | "OLD ROD" | "GOOD ROD" | "SUPER ROD";
  /** Percent of that method's encounters. */
  pct: number;
  minLv: number;
  maxLv: number;
}

interface EncData {
  encounters?: Record<string, { grass?: { rate?: number; slots?: { species: string; level: number }[] };
                                 water?: { rate?: number; slots?: { species: string; level: number }[] } }>;
  field?: { superRod?: Record<string, { species: string; level: number }[]> } & Record<string, unknown>;
}

/** Every wild mon on a map, merged per species and method. Rods only when
 * the player owns one (`rods`). */
export function wildRows(data: EncData, mapId: string, rods: Record<string, boolean> = {}): WildRow[] {
  const rows: WildRow[] = [];
  const add = (method: WildRow["method"], species: string, level: number, weight: number, total: number) => {
    const pct = (weight / total) * 100;
    const held = rows.find((r) => r.species === species && r.method === method);
    if (held) {
      held.pct += pct;
      held.minLv = Math.min(held.minLv, level);
      held.maxLv = Math.max(held.maxLv, level);
    } else rows.push({ species, method, pct, minLv: level, maxLv: level });
  };
  const enc = data.encounters?.[mapId];
  for (const [key, method] of [["grass", "GRASS"], ["water", "WATER"]] as const) {
    const t = enc?.[key];
    if (!t || !(t.rate ?? 0) || !t.slots) continue;
    t.slots.forEach((s, i) => add(method, s.species, s.level, SLOT_CHANCE[i] ?? 0, 256));
  }
  if (rods.OLD_ROD) add("OLD ROD", "MAGIKARP", 5, 1, 1);
  if (rods.GOOD_ROD) {
    add("GOOD ROD", "GOLDEEN", 10, 1, 2);
    add("GOOD ROD", "POLIWAG", 10, 1, 2);
  }
  const superRod = (data.field?.superRod as Record<string, { species: string; level: number }[]> | undefined)?.[mapId];
  if (rods.SUPER_ROD && Array.isArray(superRod) && superRod.length) {
    for (const s of superRod) add("SUPER ROD", s.species, s.level, 1, superRod.length);
  }
  for (const r of rows) r.pct = Math.round(r.pct);
  return rows;
}

// ---------------------------------------------------------------------------
// a map's trainers and items, from the map data and the save
// ---------------------------------------------------------------------------

interface MapObj {
  index: number;
  x: number;
  y: number;
  sprite?: string;
  text?: string;
  item?: string;
  trainerClass?: string;
  trainerParty?: number;
  hidden?: boolean;
  name?: string;
}

interface MapData {
  maps: Record<string, { label?: string; objects?: MapObj[] } | undefined>;
  trainer_headers?: Record<string, unknown>;
  trainers?: Record<string, { name?: string; parties?: { species: string; level: number }[][] } | undefined>;
  items?: Record<string, { name?: string } | undefined>;
  field?: Record<string, unknown>;
}

interface ProgressSave {
  flags?: Record<string, boolean>;
  defeatedTrainers?: Record<string, boolean>;
  hiddenTaken?: Record<string, boolean>;
}

export interface TrainerRow {
  obj: MapObj;
  cls: string;
  name: string;
  beaten: boolean;
  party: { species: string; level: number }[];
}

/** The rival and the boss who hide until a script shows them are not a
 * route's to finish; nor is anyone whose object starts hidden. */
function countsAsTrainer(o: MapObj): boolean {
  return !!o.trainerClass && !o.hidden && !/^OPP_RIVAL/.test(o.trainerClass);
}

function headerFor(data: MapData, label: string | undefined, index: number): { event?: string } | undefined {
  const forMap = label ? (data.trainer_headers as Record<string, unknown> | undefined)?.[label] : undefined;
  if (!forMap) return undefined;
  if (Array.isArray(forMap)) return (forMap as { event?: string }[])[index - 1];
  return (forMap as Record<string, { event?: string }>)[index];
}

export function mapTrainers(data: MapData, save: ProgressSave, mapId: string): TrainerRow[] {
  const def = data.maps[mapId];
  const out: TrainerRow[] = [];
  for (const o of def?.objects ?? []) {
    if (!countsAsTrainer(o)) continue;
    const ev = headerFor(data, def?.label, o.index)?.event;
    const beaten = !!save.defeatedTrainers?.[`${mapId}_obj_${o.index}`] || (!!ev && !!save.flags?.[ev]);
    const t = data.trainers?.[o.trainerClass!];
    const party = t?.parties?.[(o.trainerParty ?? 1) - 1] ?? [];
    out.push({ obj: o, cls: o.trainerClass!, name: t?.name ?? o.trainerClass!.replace(/^OPP_/, ""), beaten, party });
  }
  return out;
}

export interface ItemRow {
  item: string;
  name: string;
  hidden: boolean;
  taken: boolean;
  x: number;
  y: number;
}

export function mapItems(data: MapData, save: ProgressSave, mapId: string): ItemRow[] {
  const out: ItemRow[] = [];
  for (const o of data.maps[mapId]?.objects ?? []) {
    if (!o.item || o.hidden || !o.text) continue;
    out.push({
      item: o.item,
      name: data.items?.[o.item]?.name ?? o.item,
      hidden: false,
      taken: !!save.flags?.[itemBallFlag(mapId, o.text)],
      x: o.x, y: o.y,
    });
  }
  const hidden = ((data.field?.hiddenItems as Record<string, { x: number; y: number; item: string }[]> | undefined)
    ?.[mapId]) ?? [];
  for (const h of hidden) {
    out.push({
      item: h.item,
      name: data.items?.[h.item]?.name ?? h.item,
      hidden: true,
      taken: !!save.hiddenTaken?.[hiddenKey(mapId, h.x, h.y)],
      x: h.x, y: h.y,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// stamps: an area is done when its trainers are beaten and its items found
// ---------------------------------------------------------------------------

export interface StampArea {
  name: string;
  maps: string[];
  trainers: number;
  beaten: number;
  items: number;
  found: number;
  visited: boolean;
}

/** Areas are the TOWN MAP's places: every map filed under one name. Hidden
 * items count only under SPOILERS, the way the mod's radar gates them. */
export function stampAreas(
  data: MapData & { field?: { townMap?: { locations?: Record<string, { name: string }> } } },
  save: ProgressSave & { visited?: Record<string, boolean> },
  withHidden: boolean,
): StampArea[] {
  const locs = (data.field?.townMap as { locations?: Record<string, { name: string }> } | undefined)?.locations ?? {};
  const byName = new Map<string, StampArea>();
  for (const id of Object.keys(locs).sort()) {
    const name = locs[id]!.name;
    let a = byName.get(name);
    if (!a) {
      a = { name, maps: [], trainers: 0, beaten: 0, items: 0, found: 0, visited: false };
      byName.set(name, a);
    }
    a.maps.push(id);
    if (save.visited?.[id]) a.visited = true;
    for (const t of mapTrainers(data, save, id)) { a.trainers++; if (t.beaten) a.beaten++; }
    for (const it of mapItems(data, save, id)) {
      if (it.hidden && !withHidden) continue;
      a.items++;
      if (it.taken) a.found++;
    }
  }
  return [...byName.values()].filter((a) => a.trainers + a.items > 0);
}

export function stampDone(a: StampArea): boolean {
  return a.beaten >= a.trainers && a.found >= a.items;
}

// ---------------------------------------------------------------------------
// move effects in words (the mod's THEME.moveEffects / moveDescription)
// ---------------------------------------------------------------------------

const HIGH_CRIT = new Set(["CRABHAMMER", "KARATE_CHOP", "RAZOR_LEAF", "SLASH"]);

const MOVE_SPECIAL: Record<string, string[]> = {
  COUNTER: ["2X LAST NORMAL/FIGHT", "DAMAGE"],
  DIG: ["DIGS UNDERGROUND", "ATTACKS NEXT TURN"],
  DRAGON_RAGE: ["DEALS 40 FIXED DAMAGE"],
  NIGHT_SHADE: ["DAMAGE EQUALS", "USER LEVEL"],
  PSYWAVE: ["DEALS 1 TO 1.5X", "USER LEVEL DAMAGE"],
  REST: ["FULLY HEALS USER", "THEN SLEEPS 2 TURNS"],
  SEISMIC_TOSS: ["DAMAGE EQUALS", "USER LEVEL"],
  SONICBOOM: ["DEALS 20 FIXED DAMAGE"],
  STRUGGLE: ["USER TAKES HALF", "OF DAMAGE DEALT"],
  TELEPORT: ["ESCAPES WILD BATTLE", "FAILS VS TRAINERS"],
  TOXIC: ["BADLY POISONS TARGET", "DAMAGE GROWS PER TURN"],
};

const MOVE_EFFECTS: Record<string, string[]> = {
  ATTACK_TWICE_EFFECT: ["HITS TWICE"],
  BIDE_EFFECT: ["STORES DAMAGE 2-3", "TURNS THEN RETURNS 2X"],
  BURN_SIDE_EFFECT1: ["10.2% CHANCE", "TO BURN TARGET"],
  BURN_SIDE_EFFECT2: ["30.1% CHANCE", "TO BURN TARGET"],
  CHARGE_EFFECT: ["CHARGES THIS TURN", "ATTACKS NEXT TURN"],
  CONFUSION_EFFECT: ["CONFUSES THE TARGET"],
  CONFUSION_SIDE_EFFECT: ["9.8% CHANCE", "TO CONFUSE TARGET"],
  CONVERSION_EFFECT: ["COPIES TARGET TYPES"],
  DISABLE_EFFECT: ["DISABLES RANDOM MOVE", "FOR 1-8 TURNS"],
  DRAIN_HP_EFFECT: ["HEALS USER BY HALF", "OF DAMAGE DEALT"],
  DREAM_EATER_EFFECT: ["ONLY HITS SLEEPING", "DRAINS HALF DAMAGE"],
  EXPLODE_EFFECT: ["USER FAINTS AFTER", "THE ATTACK"],
  FLINCH_SIDE_EFFECT1: ["10.2% CHANCE", "TO FLINCH TARGET"],
  FLINCH_SIDE_EFFECT2: ["30.1% CHANCE", "TO FLINCH TARGET"],
  FLY_EFFECT: ["FLIES UP THIS TURN", "ATTACKS NEXT TURN"],
  FREEZE_SIDE_EFFECT1: ["10.2% CHANCE", "TO FREEZE TARGET"],
  HAZE_EFFECT: ["CLEARS BOTH SIDES", "STATS AND CONDITIONS"],
  HEAL_EFFECT: ["RESTORES HALF OF", "USER MAX HP"],
  JUMP_KICK_EFFECT: ["USER LOSES 1 HP", "IF ATTACK MISSES"],
  LEECH_SEED_EFFECT: ["DRAINS TARGET HP", "EACH TURN"],
  LIGHT_SCREEN_EFFECT: ["DOUBLES USER SPECIAL", "DEFENSE UNTIL SWITCH"],
  METRONOME_EFFECT: ["USES A RANDOM MOVE"],
  MIMIC_EFFECT: ["COPIES A TARGET MOVE"],
  MIRROR_MOVE_EFFECT: ["REPEATS TARGET LAST", "MOVE"],
  MIST_EFFECT: ["PREVENTS ENEMY STAT", "REDUCTIONS"],
  OHKO_EFFECT: ["ONE-HIT KO", "FAILS IF USER SLOWER"],
  PARALYZE_EFFECT: ["PARALYZES THE TARGET"],
  PARALYZE_SIDE_EFFECT1: ["10.2% CHANCE", "TO PARALYZE TARGET"],
  PARALYZE_SIDE_EFFECT2: ["30.1% CHANCE", "TO PARALYZE TARGET"],
  PAY_DAY_EFFECT: ["SCATTERS 2X LEVEL", "COINS AFTER BATTLE"],
  POISON_EFFECT: ["POISONS THE TARGET"],
  POISON_SIDE_EFFECT1: ["20.3% CHANCE", "TO POISON TARGET"],
  POISON_SIDE_EFFECT2: ["40.2% CHANCE", "TO POISON TARGET"],
  RAGE_EFFECT: ["ATTACK RISES WHEN", "USER IS HIT"],
  RECOIL_EFFECT: ["USER TAKES 1/4", "OF DAMAGE DEALT"],
  REFLECT_EFFECT: ["DOUBLES USER DEFENSE", "UNTIL SWITCHING"],
  SLEEP_EFFECT: ["PUTS TARGET TO SLEEP"],
  SPLASH_EFFECT: ["DOES NOTHING"],
  SUBSTITUTE_EFFECT: ["USES 1/4 MAX HP", "TO CREATE A DECOY"],
  SUPER_FANG_EFFECT: ["HALVES TARGET", "CURRENT HP"],
  SWIFT_EFFECT: ["NEVER MISSES"],
  SWITCH_AND_TELEPORT_EFFECT: ["ENDS WILD BATTLE", "FAILS VS TRAINERS"],
  THRASH_PETAL_DANCE_EFFECT: ["ATTACKS 3-4 TURNS", "THEN CONFUSES USER"],
  TRANSFORM_EFFECT: ["COPIES TARGET STATS", "TYPES AND MOVES"],
  TRAPPING_EFFECT: ["TRAPS FOR 2-5 HITS", "TARGET CANNOT MOVE"],
  TWINEEDLE_EFFECT: ["HITS TWICE", "20.3% POISON CHANCE"],
  TWO_TO_FIVE_ATTACKS_EFFECT: ["HITS 2-5 TIMES"],
};

const STAT_WORD: Record<string, string> = {
  ATTACK: "ATTACK", DEFENSE: "DEFENSE", SPEED: "SPEED", SPECIAL: "SPECIAL",
  ACCURACY: "ACCURACY", EVASION: "EVASION",
};

/** The mod's side-effect odds, as the fractions they are (the GB font has
 * no "%"): 9.8/10.2 -> 1/10, 20.3 -> 1/5, 30.1 -> 3/10, 33.2 -> 1/3, 40.2 -> 2/5. */
const ODDS: Record<string, string> = {
  "9.8%": "1/10", "10.2%": "1/10", "20.3%": "1/5", "30.1%": "3/10", "33.2%": "1/3", "40.2%": "2/5",
};

/** A move's effect as the mod words it, one or two short lines. */
export function moveEffectLines(id: string, def: { effect?: string } | undefined): string[] {
  return moveEffectRaw(id, def).map((l) => l.replace(/\d+\.\d%/g, (m) => ODDS[m] ?? m));
}

function moveEffectRaw(id: string, def: { effect?: string } | undefined): string[] {
  const special = MOVE_SPECIAL[id];
  if (special) return special;
  if (HIGH_CRIT.has(id)) return ["HIGH CRITICAL-HIT", "RATE"];
  const effect = def?.effect ?? "";
  if (effect === "FOCUS_ENERGY_EFFECT") return ["LOWERS CRITICAL-HIT", "RATE (GEN 1 BUG)"];
  if (effect === "HYPER_BEAM_EFFECT") return ["RECHARGES NEXT TURN", "UNLESS TARGET FAINTS"];
  let m = /^([A-Z]+)_UP([12])_EFFECT$/.exec(effect);
  if (m) return [`RAISES USER ${STAT_WORD[m[1]!] ?? m[1]}`, m[2] === "2" ? "BY TWO STAGES" : "BY ONE STAGE"];
  m = /^([A-Z]+)_DOWN([12])_EFFECT$/.exec(effect);
  if (m) return [`LOWERS TARGET ${STAT_WORD[m[1]!] ?? m[1]}`, m[2] === "2" ? "BY TWO STAGES" : "BY ONE STAGE"];
  m = /^([A-Z]+)_DOWN_SIDE_EFFECT$/.exec(effect);
  if (m) return ["33.2% CHANCE TO LOWER", `TARGET ${STAT_WORD[m[1]!] ?? m[1]}`];
  if (MOVE_EFFECTS[effect]) return MOVE_EFFECTS[effect]!;
  if (effect === "NO_ADDITIONAL_EFFECT" || effect === "") return ["DEALS DAMAGE"];
  return ["NO DETAILS AVAILABLE"];
}

// ---------------------------------------------------------------------------
// type matchups
// ---------------------------------------------------------------------------

export const TYPES = [
  "NORMAL", "FIGHTING", "FLYING", "POISON", "GROUND", "ROCK", "BUG", "GHOST",
  "FIRE", "WATER", "GRASS", "ELECTRIC", "PSYCHIC", "ICE", "DRAGON",
];

/** The short names the mod prints where a type has to fit a column. */
export function typeShort(t: string): string {
  const s: Record<string, string> = {
    FIGHTING: "FIGHT", ELECTRIC: "ELECT", PSYCHIC: "PSYCH",
  };
  return s[t] ?? t;
}

type Chart = { effectiveness: (atk: string, def: readonly string[]) => number };

/** Every attacking type against these defenders, x10, split into the ones
 * that hit hard and the ones that don't. */
export function matchups(chart: Chart | undefined, defTypes: readonly string[]): {
  weak: [string, number][];
  resist: [string, number][];
} {
  const weak: [string, number][] = [];
  const resist: [string, number][] = [];
  if (!chart) return { weak, resist };
  for (const t of TYPES) {
    const e = chart.effectiveness(t, defTypes);
    if (e > 10) weak.push([t, e]);
    else if (e < 10) resist.push([t, e]);
  }
  weak.sort((a, b) => b[1] - a[1]);
  resist.sort((a, b) => a[1] - b[1]);
  return { weak, resist };
}

/** A x10 multiplier the way the mod prints it: 2X, 4X, 1/2, 1/4, 0X. */
export function multLabel(e10: number): string {
  if (e10 === 0) return "0X";
  if (e10 >= 10) return `${e10 / 10}X`;
  if (e10 === 5) return "1/2";
  if (e10 === 2 || e10 === 3) return "1/4";
  return `${e10 / 10}X`;
}

// ---------------------------------------------------------------------------
// field tools (the mod's THEME.fieldTools, Gen 1 half)
// ---------------------------------------------------------------------------

export interface ToolDef {
  key: string;
  label: string;
  item?: string;
  move?: string;
}

export const TOOLS: ToolDef[] = [
  { key: "bicycle", label: "BICYCLE", item: "BICYCLE" },
  { key: "old_rod", label: "OLD ROD", item: "OLD_ROD" },
  { key: "good_rod", label: "GOOD ROD", item: "GOOD_ROD" },
  { key: "super_rod", label: "SUPER ROD", item: "SUPER_ROD" },
  { key: "cut", label: "CUT", move: "CUT" },
  { key: "surf", label: "SURF", move: "SURF" },
  { key: "strength", label: "STRENGTH", move: "STRENGTH" },
  { key: "flash", label: "FLASH", move: "FLASH" },
  { key: "fly", label: "FLY", move: "FLY" },
  { key: "dig", label: "DIG", move: "DIG" },
  { key: "teleport", label: "TELEPORT", move: "TELEPORT" },
  { key: "softboiled", label: "SOFTBOILED", move: "SOFTBOILED" },
];

/** The badge each HM needs outside battle (false: none). */
export const FIELD_BADGE: Record<string, string | false> = {
  CUT: "CASCADEBADGE", SURF: "SOULBADGE", STRENGTH: "RAINBOWBADGE",
  FLASH: "BOULDERBADGE", FLY: "THUNDERBADGE", DIG: false, TELEPORT: false, SOFTBOILED: false,
};

interface ToolSave {
  inventory?: Record<string, number>;
  party?: { species: string; nickname?: string; moves?: { id: string }[] }[];
}

/** Which party member knows a move, or -1. */
export function knowerOf(save: ToolSave, move: string): number {
  return (save.party ?? []).findIndex((m) => m.moves?.some((mv) => mv.id === move));
}

/** THEME.fieldTools.unlocked: an item in the bag, or a move in the party
 * with its badge (if it needs one). */
export function toolUnlocked(t: ToolDef, save: ToolSave): boolean {
  const inv = save.inventory ?? {};
  if (t.item) return (inv[t.item] ?? 0) > 0;
  if (!t.move || knowerOf(save, t.move) < 0) return false;
  const badge = FIELD_BADGE[t.move];
  return badge === false || (!!badge && (inv[badge] ?? 0) > 0);
}
