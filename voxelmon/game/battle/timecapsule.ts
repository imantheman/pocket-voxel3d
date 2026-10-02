// A mon arriving from Gold's TIME CAPSULE (engine/link/link.asm's Gen 2 side
// sends its party already in Gen 1's party_struct; here it is the Kanto
// PartyMon it converted to, gen2/core/TimeCapsule.ts toGen1).
//
// Gold cannot do the whole conversion itself: Gen 1's base SPECIAL is not in
// its data (the cart carries data/pokemon/gen1_base_special.asm for this),
// and its PP and growth tables are its own. So the Kanto side finishes it,
// from its own data, the way a Gen 1 cart derives a traded mon's numbers:
// the stat block from base stats, DVs, stat exp and level; EXP as the
// level's floor on the species' curve; PP held under the move's Gen 1
// maximum with its PP UPs; HP scaled to the new maximum. A move or species
// this game does not know never gets here -- Gold's TIME CAPSULE refuses the
// whole party first (CheckTimeCapsuleCompatibility) -- but a peer is a peer,
// so an unknown move is dropped rather than carried.

import type { VoxelmonData } from "../data.ts";
import type { PartyMon } from "./mon.ts";
import { expForLevel } from "../rules/growth.ts";
import { calc as calcStats } from "../rules/stats.ts";

export function fromTimeCapsule(data: VoxelmonData, mon: PartyMon): PartyMon {
  const def = data.pokemon?.[mon.species];
  if (!def) return mon;
  const level = Math.max(1, Math.min(100, Math.floor(Number(mon.level) || 1)));
  const d = (mon.dvs ?? {}) as Record<string, number | undefined>;
  const bit = (v: number | undefined): number => (v ?? 0) & 1;
  const dvs = {
    attack: d.attack ?? 0,
    defense: d.defense ?? 0,
    speed: d.speed ?? 0,
    special: d.special ?? 0,
    hp: 0,
  };
  dvs.hp = bit(dvs.attack) * 8 + bit(dvs.defense) * 4 + bit(dvs.speed) * 2 + bit(dvs.special);
  const se = (mon.statExp ?? {}) as Record<string, number | undefined>;
  const statExp = { hp: se.hp ?? 0, attack: se.attack ?? 0, defense: se.defense ?? 0, speed: se.speed ?? 0, special: se.special ?? 0 };
  const stats = calcStats(def, level, dvs as never, statExp as never);
  // HP keeps its share of the maximum (engine/link/link.asm's rescale)
  const oldMax = Math.max(1, Number(mon.stats?.hp) || stats.hp);
  const oldHp = Math.max(0, Math.min(oldMax, Number(mon.hp) || 0));
  const hp = oldHp <= 0 ? 0 : oldHp >= oldMax ? stats.hp : Math.max(1, Math.min(stats.hp, Math.round((oldHp * stats.hp) / oldMax)));
  const exp = expForLevel(def.growthRate, level, data.growth_rates);
  const moves = (mon.moves ?? [])
    .filter((m) => !!m && !!data.moves?.[m.id])
    .slice(0, 4)
    .map((m) => {
      const base = Number(data.moves?.[m.id]?.pp) || 0;
      const ups = Math.max(0, Math.min(3, Math.floor(Number(m.ppUps) || 0)));
      const max = base + ups * Math.floor(base / 5);
      return { ...m, ppUps: ups, pp: Math.max(0, Math.min(max, Math.floor(Number(m.pp) || 0))) };
    });
  return { ...mon, level, dvs: dvs as never, statExp: statExp as never, stats, hp, exp, moves };
}
