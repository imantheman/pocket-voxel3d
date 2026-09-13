// The Route 5 DAY CARE (scripts/Daycare.asm), ported from gen1recomp
// data/scripts/story2.lua M.DAYCARE.
//
// The boarded Pokémon earns one exp per step the player takes, anywhere. The
// fee to get it back is ¥100 plus ¥100 for every level it gained.
//
// The exp is DEFERRED: the overworld only counts steps, and they are folded
// into the mon's exp when you come to collect. Its level is not raised until
// the fee is actually paid — pokered reverts wDayCareMonBoxLevel on
// .leaveMonInDayCare, so declining (or being unable to afford it) has to
// leave the mon exactly as it was, ready to be quoted the same price again.

import type { PartyMon } from "../battle/mon.ts";
import { expForLevel, levelForExp } from "../rules/growth.ts";
import { calc as calcStats } from "../rules/stats.ts";
import type { VoxelmonData } from "../data.ts";

export const DAYCARE_BASE_FEE = 100;
export const DAYCARE_FEE_PER_LEVEL = 100;

export interface DaycareState {
  mon: PartyMon;
  /** Steps taken since the deposit; folded into exp at collection. */
  steps: number;
  /** wDayCareMonBoxLevel — the fee baseline, which must survive a decline. */
  depositLevel: number;
}

/** ¥100, plus ¥100 a level (Daycare.asm's wDayCareTotalCost). */
export function daycareFee(levelsGrown: number): number {
  return DAYCARE_BASE_FEE + levelsGrown * DAYCARE_FEE_PER_LEVEL;
}

export interface DaycareQuote {
  /** exp after folding in the walk. */
  exp: number;
  newLevel: number;
  levelsGrown: number;
  fee: number;
}

/**
 * What the mon is worth right now. Folds the pending steps into its exp —
 * the caller must write `exp` back and zero the steps, or a second look
 * would count the same walk twice.
 */
export function daycareQuote(
  data: VoxelmonData, state: DaycareState, levelCap = 100,
): DaycareQuote {
  const def = data.pokemon[state.mon.species];
  let exp = (state.mon.exp ?? 0) + state.steps;
  let newLevel = levelForExp(def?.growthRate ?? "MEDIUM_FAST", exp, levelCap, data.growth_rates);
  if (newLevel >= levelCap) {
    newLevel = levelCap;
    if (def) exp = expForLevel(def.growthRate, levelCap, data.growth_rates);
  }
  // depositLevel falls back to the mon's own level for a save written before
  // the record carried one (gen1recomp story2.lua does the same).
  const levelsGrown = Math.max(0, newLevel - (state.depositLevel ?? state.mon.level));
  return { exp, newLevel, levelsGrown, fee: daycareFee(levelsGrown) };
}

/**
 * Apply the paid collection: the new level, recalculated stats, full HP, and
 * every move learned across the range.
 */
export function applyDaycareGrowth(
  data: VoxelmonData, mon: PartyMon, startLevel: number, newLevel: number,
): void {
  const def = data.pokemon[mon.species];
  if (!def) return;
  mon.level = newLevel;
  mon.stats = calcStats(def, mon.level, mon.dvs, mon.statExp);
  mon.hp = mon.stats.hp;
  learnMovesFromDayCare(data, mon, startLevel, newLevel);
}

/**
 * Every learnset move between the two levels. Daycare.asm calls WriteMonMoves
 * with wLearningMovesFromDayCare set, and that path SHIFTS the oldest move
 * out when the set is full — there is no "should it forget?" prompt, because
 * the player is not there to answer one.
 */
export function learnMovesFromDayCare(
  data: VoxelmonData, mon: PartyMon, startLevel: number, newLevel: number,
): void {
  const learnset = data.pokemon[mon.species]?.learnset;
  if (!Array.isArray(learnset)) return;
  for (const entry of learnset) {
    if (entry.level > newLevel) break;
    if (entry.level <= startLevel) continue;
    if (mon.moves.some((mv) => mv.id === entry.move)) continue;
    const slot = { id: entry.move, pp: data.moves[entry.move]?.pp ?? 0 };
    if (mon.moves.length < 4) mon.moves.push(slot);
    else { mon.moves.shift(); mon.moves.push(slot); }
  }
}

/**
 * The day-care lines carry tokens TextBox does not know: {RAM:wNameBuffer},
 * {RAM:wDayCareMonName} and {NUM:...}, whose span can carry formatting flags
 * after a comma. Filled here, as gen1recomp's fillDaycareText does.
 */
export function fillDaycareText(text: string, subs: Record<string, string | number>): string {
  return text
    .replace(/\{RAM:([^}]*)\}/g, (_, name: string) => String(subs[name] ?? ""))
    .replace(/\{NUM:([\w_]+)[^}]*\}/g, (_, name: string) => String(subs[name] ?? 0));
}
