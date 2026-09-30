// Type effectiveness: a port of gen1recomp src/battle/TypeChart.lua
// (bdfac727, MIT).
//
// Gen 1 type effectiveness from generated data (multipliers x10).
// Like the original, each matchup row applies independently, so dual types
// multiply (e.g. 20 * 5 -> neutral).
//
// Gen 2 note: Game2:load (Game2.lua:1031-1036) appends the chart's
// foresightMatchups (NORMAL/FIGHTING -> GHOST, x0) to `matchups` before
// anything loads it; TypeChart itself only reads what it is handed.

export interface TypeRecord {
  name?: string;
  category?: string;
  [k: string]: any;
}

export interface MatchupRow {
  attacker: string;
  defender: string;
  multiplier: number;
  [k: string]: any;
}

let index: Record<string, Record<string, number>> | undefined; // [atk][def] -> x10 multiplier
let matchups: MatchupRow[] | undefined; // ROM-ordered TypeEffects rows
let types: Record<string, TypeRecord> | undefined; // merged type records (physical/special category, display name)

// Identifiers whose cart-facing spelling differs even without loaded data.
// CURSE_TYPE is Gen 2's ??? type and is deliberately not a Gen 1 registry
// record; keeping it here avoids exposing a non-existent Gen 1 type.
// Lua: TypeChart.lua:14
const DISPLAY_NAMES: Record<string, string> = { PSYCHIC_TYPE: "PSYCHIC", CURSE_TYPE: "???" };

function luaAssert<T>(v: T, msg: string): asserts v {
  if (v === undefined || v === null || (v as unknown) === false) throw new Error(msg);
}

export const TypeChart = {
  // Lua: TypeChart.lua:16
  load(data: any): void {
    index = {};
    matchups = data.type_chart.matchups as MatchupRow[];
    for (const m of matchups ?? []) {
      index[m.attacker] = index[m.attacker] ?? {};
      index[m.attacker]![m.defender] = m.multiplier;
    }
    types = data.type_chart.types;
  },

  // the merged type record's category; falls back to the vanilla records
  // so pure-module callers need no load
  // Lua: TypeChart.lua:28
  category(typeId: string): string | undefined {
    const record = (types && types[typeId]) || TypeChart.TYPES[typeId];
    return record?.category ?? undefined;
  },

  // display name for the move-select TYPE/ box (mod types render their
  // name instead of their raw id)
  // Lua: TypeChart.lua:35
  displayName(typeId: string, data?: any): string {
    // Menus can be opened before the first battle has called TypeChart.load.
    // Accept their live Data explicitly so a merged type_chart translation is
    // still visible there; battle callers retain the cached-table fast path.
    const supplied: Record<string, TypeRecord> | undefined = data && data.type_chart && data.type_chart.types;
    const record = (supplied && supplied[typeId]) || (types && types[typeId]) || TypeChart.TYPES[typeId];
    return record?.name ?? DISPLAY_NAMES[typeId] ?? typeId;
  },

  // The x10 multipliers of every TypeEffects row that applies, in ROM
  // order.  AdjustDamageForMoveType applies each row to the running
  // damage separately (one application per row even when both defender
  // types match it), so callers must floor after every row.
  // Lua: TypeChart.lua:50
  rows(moveType: string, defenderTypes: string[]): number[] {
    luaAssert(matchups, "TypeChart.load not called");
    const out: number[] = [];
    for (const m of matchups) {
      if (m.attacker === moveType) {
        for (const dt of defenderTypes) {
          if (m.defender === dt) {
            out.push(m.multiplier);
            break;
          }
        }
      }
    }
    return out;
  },

  // Returns the combined x10 multiplier of moveType against a types list
  // (x100 for dual matchups is normalized back: each application is /10).
  // Lua: TypeChart.lua:68
  effectiveness(moveType: string, defenderTypes: string[]): number {
    luaAssert(index, "TypeChart.load not called");
    let mult = 10;
    const row = index[moveType];
    if (!row) return mult;
    for (const dt of defenderTypes) {
      const m = row[dt];
      if (m !== undefined) {
        mult = Math.floor((mult * m) / 10);
      }
    }
    return mult;
  },

  // Gen 1 splits physical from special by TYPE, not by move: the seven types
  // from FIRE up are special (engine/battle/effect_commands.asm compares the
  // type id against SPECIAL).  The list Damage.isSpecial carries is the same
  // one, restated here as the type records the type_chart registry serves.
  // Lua: TypeChart.lua:86
  TYPES: {
    NORMAL: { name: "NORMAL", category: "physical" },
    FIGHTING: { name: "FIGHTING", category: "physical" },
    FLYING: { name: "FLYING", category: "physical" },
    POISON: { name: "POISON", category: "physical" },
    GROUND: { name: "GROUND", category: "physical" },
    ROCK: { name: "ROCK", category: "physical" },
    BUG: { name: "BUG", category: "physical" },
    GHOST: { name: "GHOST", category: "physical" },
    FIRE: { name: "FIRE", category: "special" },
    WATER: { name: "WATER", category: "special" },
    GRASS: { name: "GRASS", category: "special" },
    ELECTRIC: { name: "ELECTRIC", category: "special" },
    PSYCHIC_TYPE: { name: "PSYCHIC", category: "special" },
    ICE: { name: "ICE", category: "special" },
    DRAGON: { name: "DRAGON", category: "special" },
  } as Record<string, TypeRecord>,

  // The matchup rows come from the generated chart, so a dataset with a
  // different table registers a different world without touching this file.
  // Lua: TypeChart.lua:106
  registerInto(registry: any, data: any, owner?: any): void {
    // pairs() order: sorted for determinism
    for (const id of Object.keys(TypeChart.TYPES).sort()) {
      registry.register(id, TypeChart.TYPES[id], owner);
    }
    const chart = data && data.type_chart;
    for (const row of (chart && chart.matchups) || []) {
      registry.register(row.attacker + ">" + row.defender, { multiplier: row.multiplier }, owner);
    }
  },
};

export default TypeChart;
