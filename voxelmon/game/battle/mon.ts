// Pokémon instances + party helpers for the battle port. Ports
// gen1recomp src/pokemon/Pokemon.lua (movesAtLevel :11, new :62, heal :92)
// and src/pokemon/Party.lua (MAX/add/firstHealthy) as pure functions over
// the imported dataset. A mon is a plain object so it serializes straight
// into the save, exactly like the Lua table.

import type { SpeciesDef, VoxelmonData } from "../data.ts";
import type { Rng } from "../rng.ts";
import { expForLevel } from "../rules/growth.ts";
import { calc, randomDVs, type DVs, type StatExp } from "../rules/stats.ts";
import type { StatBlock } from "../data.ts";

export interface MoveSlot {
  id: string;
  pp: number;
  ppUps?: number;
}

/** The party_struct slice the battle port reads/writes (Pokemon.lua:70-88). */
export interface PartyMon {
  species: string;
  level: number;
  exp: number;
  dvs: DVs;
  statExp: StatExp;
  stats: StatBlock;
  hp: number;
  /** Gen1 catch-rate byte, frozen at creation (Pokemon.lua:80-83). */
  catchRate: number;
  status: string | null; // "SLP"|"PSN"|"BRN"|"FRZ"|"PAR"
  moves: MoveSlot[];
  nickname?: string;
  /**
   * Came from another trainer. Gen 1 reads this for obedience (a traded mon
   * over the badge level ignores you) and the summary shows the OT below.
   */
  traded?: boolean;
  /**
   * Who caught it, when that is not you. Absent on anything you caught
   * yourself, which is what every save written before trading existed says,
   * so an old save reads as "all mine" and is right.
   */
  otName?: string;
  otId?: number;
}

/**
 * Pokemon.lua:11-31 movesAtLevel — level-1 moves plus learnset entries at or
 * below the level, keeping the most recent four (learn_move.asm behavior).
 */
export function movesAtLevel(speciesDef: SpeciesDef, level: number): string[] {
  const moves: string[] = [];
  const add = (id: string) => {
    if (!moves.includes(id)) moves.push(id);
  };
  for (const m of speciesDef.level1Moves) add(m);
  for (const entry of speciesDef.learnset) {
    if (entry.level <= level) add(entry.move);
  }
  while (moves.length > 4) moves.shift();
  return moves;
}

/**
 * Pokemon.lua:62-88 new — DVs, calc'd stats, full HP, derived move list.
 * `dvs` injected (tests, the fixed-DV starter grant) or rolled off `rng` —
 * four rand(0..15) in attack/defense/speed/special order (Stats.randomDVs).
 */
export function newMon(
  data: VoxelmonData,
  species: string,
  level: number,
  rng?: Rng,
  dvs?: DVs,
): PartyMon {
  const def = data.pokemon[species];
  if (!def) throw new Error(`unknown species ${species}`);
  const rolled =
    dvs ?? (rng ? randomDVs(rng) : { hp: 0, attack: 0, defense: 0, speed: 0, special: 0 });
  const stats = calc(def, level, rolled);
  const moves: MoveSlot[] = [];
  for (const id of movesAtLevel(def, level)) {
    moves.push({ id, pp: data.moves[id]?.pp ?? 0 });
  }
  return {
    species,
    level,
    exp: expForLevel(def.growthRate, level, data.growth_rates),
    dvs: rolled,
    statExp: { hp: 0, attack: 0, defense: 0, speed: 0, special: 0 },
    stats,
    hp: stats.hp,
    catchRate: def.catchRate,
    status: null,
    moves,
  };
}

/**
 * Pokemon.lua:92-101 heal — Pokémon Center / blackout heal (HealParty):
 * full HP, status cleared, every move's PP back to base + the PP-Up bonus
 * (RestoreBonusPP adds maxPP/5 per PP UP).
 */
export function healMon(data: VoxelmonData, mon: PartyMon): void {
  mon.hp = mon.stats.hp;
  mon.status = null;
  for (const mv of mon.moves) {
    const def = data.moves[mv.id];
    if (def) mv.pp = def.pp + (mv.ppUps ?? 0) * Math.floor(def.pp / 5);
  }
}

/** Party.lua:5 — max 6, like the original. */
export const PARTY_MAX = 6;

/** Party.lua:7-13 add — false when full (the box system is v1-out). */
/**
 * A nickname the cartridge would not keep as one: the species' own name
 * (AddPartyMon seeds the nickname with it, and EvolveMon replaces exactly
 * that), or the first seven letters of it, which is what a keyboard sized
 * for the player's name used to hand back when the starter's name was
 * left as it was -- "CHARMAN". Case-blind, since the keyboard has a lower
 * case.
 */
export function isDefaultNickname(data: VoxelmonData, mon: { species: string; nickname?: string }): boolean {
  const nick = mon.nickname;
  if (!nick) return false;
  const name = (data.pokemon[mon.species]?.name ?? mon.species).toUpperCase();
  const up = nick.toUpperCase();
  return up === name || (up.length === 7 && name.length > 7 && name.startsWith(up));
}

/**
 * Drop the nicknames that are only the species name, cut short or not,
 * from a loaded save: the party, the boxes, and the daycare. A mon that
 * came back "CHARMAN" is a CHARMANDER again, and evolves into a
 * CHARMELEON by name.
 */
export function scrubDefaultNicknames(data: VoxelmonData, save: unknown): number {
  const s = save as {
    party?: PartyMon[];
    boxes?: PartyMon[][];
    box?: PartyMon[];
    daycare?: { mon?: PartyMon } | PartyMon | null;
  };
  let n = 0;
  const scrub = (mon: PartyMon | undefined | null): void => {
    if (mon && isDefaultNickname(data, mon)) {
      delete mon.nickname;
      n += 1;
    }
  };
  for (const mon of s.party ?? []) scrub(mon);
  for (const box of s.boxes ?? []) for (const mon of box ?? []) scrub(mon);
  for (const mon of s.box ?? []) scrub(mon);
  const dc = s.daycare as { mon?: PartyMon; species?: string } | null | undefined;
  if (dc) scrub((dc.mon ?? (dc.species ? dc : undefined)) as PartyMon | undefined);
  return n;
}

export function partyAdd(party: PartyMon[], mon: PartyMon): boolean {
  if (party.length >= PARTY_MAX) return false;
  party.push(mon);
  return true;
}

/** Party.lua:15-20 firstHealthy. */
export function firstHealthy(party: PartyMon[]): PartyMon | null {
  for (const mon of party) {
    if (mon.hp > 0) return mon;
  }
  return null;
}

interface DexFlags {
  seen: Record<string, boolean>;
  owned: Record<string, boolean>;
}

/** BattleState.lua:513-515 markSeen — the dex "seen" flag, set whenever an
 * enemy mon appears on the field. Guarded like Bryan's `if dex then` so a save
 * whose pokedex block is missing (older import) is a no-op, not a crash. */
export function markSeen(save: { pokedex?: DexFlags }, species: string): void {
  const dex = save.pokedex;
  if (dex) dex.seen[species] = true;
}

/** BattleState.lua:529-534 — the "owned" mark (a caught/received/evolved mon).
 * Owned implies seen, so both bits are set together, as in every call site. */
export function markOwned(save: { pokedex?: DexFlags }, species: string): void {
  const dex = save.pokedex;
  if (dex) {
    dex.seen[species] = true;
    dex.owned[species] = true;
  }
}
