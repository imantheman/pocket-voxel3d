// gen1recomp src/world/gen2/Trainers.lua at bdfac727 (MIT).
//
// Gen 2 overworld trainers: the `trainer` struct an object_event points at
// (macros/scripts/maps.asm), the eyesight test from home/trainers.asm, and the
// party build that turns trainers.json's level/species rows into battle mons.
//
// The extractor already has every class's members; this is the layer between
// that table and a battle, so nothing here reads the ROM.

import { Mon, type MoveSlot } from "../battle/Mon.ts";
import { Map } from "./Map.ts";
import type { Dir } from "./Permissions.ts";

/** Trainers.lookup's flat record. */
export interface TrainerRecord {
  class: number;
  classId: string | undefined;
  className: string | undefined;
  member: number;
  id: string | undefined;
  name: string | undefined;
  trainerType: string | undefined;
  roster: any[];
  attributes: any;
  items: any[];
  baseMoney: number | undefined;
}

interface Sighted {
  cellX: number;
  cellY: number;
  facing?: string;
}

// Lua: Trainers.lua:20 -- trainers.json keys classes by name; the `trainer`
// struct and `loadtrainer` both carry the class's numeric constant, so index
// once per data table (cached on the table as `_byIndex`, as the rawset did).
function classIndex(trainerData: any): Record<number, any> {
  if (!(trainerData && trainerData.classes)) return {};
  const cached = trainerData._byIndex;
  if (cached) return cached;
  const cache: Record<number, any> = {};
  for (const id of Object.keys(trainerData.classes)) {
    const cls = trainerData.classes[id];
    if (cls != null && typeof cls === "object" && cls.index != null) {
      cache[cls.index] = cls;
      cls.id = cls.id ?? id;
    }
  }
  trainerData._byIndex = cache;
  return cache;
}

export const Trainers = {
  // Lua: Trainers.lua:14 -- constants/script_constants.asm
  TEXT_SEEN: 0,
  TEXT_WIN: 1,
  TEXT_LOSS: 2,
  // Lua: Trainers.lua:16 -- constants/misc_constants.asm
  RESET_FLAG: 0,
  SET_FLAG: 1,
  CHECK_FLAG: 2,

  // Lua: Trainers.lua:35
  classIndex,

  // Lua: Trainers.lua:40 -- class constant + member number (1-based, the
  // game's) -> a flat record the battle screen can use.  `name` is the
  // trainer's own name (JOEY), `className` the class's display name
  // (YOUNGSTER) -- the HUD wants "YOUNGSTER JOEY".
  lookup(trainerData: any, cls: number, member: number): TrainerRecord | undefined {
    const entry = classIndex(trainerData)[cls];
    if (!entry) return undefined;
    const row = entry.trainers ? entry.trainers[member - 1] : undefined;
    if (!row) return undefined;
    return {
      class: cls,
      classId: entry.id,
      className: entry.name,
      member,
      id: row.id,
      name: row.name,
      trainerType: row.trainerType,
      roster: row.party || [],
      attributes: entry.attributes,
      // TRNATTR_ITEM1/ITEM2: what AI_TryItem may reach for.  A copy, so using
      // one up in a battle does not empty the class record for the next
      // trainer of that class.
      items: (() => {
        const out: any[] = [];
        for (const id of entry.items || []) {
          if (id == null) break; // ipairs
          out.push(id);
        }
        return out;
      })(),
      baseMoney: entry.baseMoney,
    };
  },

  // Lua: Trainers.lua:70 -- build the battle party.  TRAINERTYPE_MOVES /
  // _ITEM_MOVES rows carry an explicit move list; the rest take whatever the
  // species knows at that level, which is what MakeTrainerPartyMon does via
  // LearnLevelMoves.
  party(data: any, entry: { roster?: any[] } | null | undefined): any[] {
    const party: any[] = [];
    for (const row of (entry && entry.roster) || []) {
      if (row == null) break; // ipairs
      let moves: MoveSlot[] | undefined;
      if (row.moves && row.moves.length > 0) {
        moves = [];
        for (const id of row.moves) {
          if (id == null) break;
          const def = data && data.moves ? data.moves[id] : undefined;
          moves.push({ id, pp: (def && def.pp) || 0, maxPp: (def && def.pp) || 0 });
        }
      }
      // Trainer mons roll no DVs: the cart gives every one of them 9/8/8/8/8
      // (wEnemyMonDVs is fixed in MakeTrainerPartyMon), which is why a
      // trainer's Rattata is always the same Rattata.
      const mon = Mon.new(data, row.species, row.level, {
        moves,
        item: row.item,
        dvs: { attack: 9, defense: 8, speed: 8, special: 8 },
      });
      if (mon) party.push(mon);
    }
    return party;
  },

  // Lua: Trainers.lua:98 -- FacingPlayerDistance (home/trainers.asm): the
  // trainer must share a row or column with the player, be facing along it,
  // and the gap must be at least 1 and no more than its sight range.
  // Returns a TUPLE [distance, direction], or undefined (the Lua's nil).
  sees(npc: Sighted | null | undefined, player: Sighted | null | undefined, sight?: number): [number, Dir] | undefined {
    if (!(npc && player) || (sight ?? 0) <= 0) return undefined;
    const range = sight!;
    if (npc.cellX === player.cellX) {
      let d = player.cellY - npc.cellY;
      if (d === 0) return undefined;
      const dir: Dir = d > 0 ? "down" : "up";
      d = Math.abs(d);
      if (npc.facing !== dir || d > range) return undefined;
      return [d, dir];
    } else if (npc.cellY === player.cellY) {
      let d = player.cellX - npc.cellX;
      if (d === 0) return undefined;
      const dir: Dir = d > 0 ? "right" : "left";
      d = Math.abs(d);
      if (npc.facing !== dir || d > range) return undefined;
      return [d, dir];
    }
    return undefined;
  },

  // Lua: Trainers.lua:120 -- TrainerWalkToPlayer: the trainer closes to one
  // cell short of the player, so a distance of 1 means it never moves.
  approach(distance: number | null | undefined, dir: Dir): Dir[] {
    const steps: Dir[] = [];
    const n = Math.max(0, (distance ?? 1) - 1);
    for (let i = 1; i <= n; i++) {
      steps.push(dir);
    }
    return steps;
  },

  // Lua: Trainers.lua:128 (a getter so nothing reads Map at module top level)
  get DELTA(): typeof Map.DELTA {
    return Map.DELTA;
  },
};

export default Trainers;
