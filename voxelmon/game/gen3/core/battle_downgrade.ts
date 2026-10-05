// Port of gen1recomp src/core/game3/battle_downgrade.lua (GPLv3 + additional terms; see LICENSE.md).
// Gen3 → Gen2 battle view downgrade (H4) + player move remap table (H4∩H6).
//
// Lua keys: a Lua table keeps number and string keys apart (t[291] is not
// t["291"]); a JS object does not. `lget` reads a string key that spells a
// canonical number as absent, so a Gen 3 string move id such as "291" misses
// the number-keyed MOVE_FALLBACK exactly as it does in the Lua.

import { tonumber, truthy } from "../../../import/gen3/lua.ts";
import { insert, ipairs, pairs, seq, type LuaTable } from "../platform/lt.ts";

/** Lua `t[k]` for a key that may be a string or a number (see the header). */
function lget(t: LuaTable, k: unknown): any {
  if (typeof k === "string" && String(Number(k)) === k) return undefined;
  return t[k as any];
}

/** Lua `a == b` (nil is null or undefined here). */
function luaEq(a: unknown, b: unknown): boolean {
  return a == null ? b == null : a === b;
}

/** Lua `type(v) == "table"`. */
function isTable(v: unknown): v is LuaTable {
  return v !== null && typeof v === "object";
}

export interface RemapRow {
  partySlot: number;
  moveSlot: number;
  frlgMoveId: any;
  hostFallbackId: any;
}

export const Downgrade = {
  // Unsupported FRLG moves → Gen2 fallback (or STRUGGLE).
  MOVE_FALLBACK: {
    // Common Gen3-only examples; extend as extract surfaces them.
    291: "DIVE", // if missing on host → Struggle below
    338: "FRENZY_PLANT",
    339: "BULK_UP",
    340: "BOUNCE",
    341: "MUD_SHOT",
    342: "POISON_TAIL",
    344: "VOLT_TACKLE",
    345: "MAGICAL_LEAF",
    347: "CALM_MIND",
    348: "LEAF_BLADE",
    349: "DRAGON_DANCE",
    350: "ROCK_BLAST",
    351: "SHOCK_WAVE",
    352: "WATER_PULSE",
    353: "DOOM_DESIRE",
    354: "PSYCHO_BOOST",
  } as Record<number | string, any>,

  DEFAULT_MOVE: "STRUGGLE",

  // Species FRLG national → host id when names differ; nil = use same number/name.
  SPECIES_MAP: {
    // Fill as needed; missing → log + skip encounter at bridge.
  } as Record<number | string, any>,

  // Lua: battle_downgrade.lua:33
  moveToHost(moveId: any, hostMoves?: LuaTable): any {
    if (moveId == null || moveId === 0) return undefined;
    if (typeof moveId === "string") {
      if (truthy(hostMoves) && truthy(lget(hostMoves, moveId))) return moveId;
      const fb = lget(Downgrade.MOVE_FALLBACK, moveId);
      if (truthy(fb)) return fb;
      // Named Gen2-legal moves pass through; only explicit fallbacks remap.
      return moveId;
    }
    const num = tonumber(moveId);
    if (num == null) return Downgrade.DEFAULT_MOVE;
    // If numeric and host uses string names, map via fallback table.
    if (truthy(Downgrade.MOVE_FALLBACK[num])) {
      return Downgrade.MOVE_FALLBACK[num];
    }
    // Assume host accepts same numeric id within Gen2 range.
    if (num >= 1 && num <= 251) {
      return num;
    }
    return Downgrade.DEFAULT_MOVE;
  },

  // Lua: battle_downgrade.lua:55
  stripAbility(_ability?: any): any {
    return undefined; // NO_ABILITY for host
  },

  // Lua: battle_downgrade.lua:59
  speciesToHost(species: any): any {
    const mapped = species == null ? undefined : lget(Downgrade.SPECIES_MAP, species);
    if (mapped != null) return mapped;
    const n = tonumber(species);
    if (n != null && n >= 1 && n <= 251) return n;
    if (typeof species === "string") return species;
    return undefined; // caller should skip
  },

  /** Build foe payload safe for host BattleState. */
  // Lua: battle_downgrade.lua:69
  foePayload(foe: any): LuaTable | undefined {
    if (!isTable(foe)) return undefined;
    const species = Downgrade.speciesToHost(truthy(foe.species) ? foe.species : foe.id);
    if (!truthy(species)) return undefined;
    const moves: LuaTable = seq();
    const srcMoves = truthy(foe.moves) ? foe.moves : seq();
    for (let i = 1; i <= 4; i++) {
      const m = srcMoves[i];
      if (truthy(m)) {
        moves[i] = Downgrade.moveToHost(m);
      }
    }
    return {
      species,
      level: truthy(foe.level) ? foe.level : 5,
      moves,
      item: foe.item,
      ability: Downgrade.stripAbility(foe.ability),
      dvs: foe.dvs, // wilds may still carry host-shaped stats
      gender: foe.gender,
    };
  },

  /**
   * Build temporary player battle view + remap table for Gen3-only moves.
   * Returns [battleParty (host-legal move ids), remap[{partySlot,moveSlot,frlgMoveId,hostFallbackId}]].
   */
  // Lua: battle_downgrade.lua:94
  playerBattleView(sessionParty: any, moveOverlay?: LuaTable, hostMoveSet?: LuaTable): [LuaTable, LuaTable] {
    const battleParty: LuaTable = seq();
    const remap: LuaTable = seq();
    if (!isTable(sessionParty)) {
      return [battleParty, remap];
    }
    for (const [pi, mon] of ipairs<LuaTable>(sessionParty)) {
      const copy: LuaTable = {};
      for (const [k, v] of pairs(mon)) {
        if (k !== "moves" && k !== "pp") copy[k] = v;
      }
      copy.moves = seq();
      copy.pp = seq();
      const overlaySlot = truthy(moveOverlay) ? moveOverlay[pi] : moveOverlay;
      for (let mi = 1; mi <= 4; mi++) {
        const ov = truthy(overlaySlot) ? overlaySlot[mi] : overlaySlot;
        const moveId = truthy(mon.moves) ? mon.moves[mi] : mon.moves;
        const pp = truthy(mon.pp) ? mon.pp[mi] : mon.pp;
        if (truthy(ov) && truthy(ov.frlgMoveId)) {
          const fallback = Downgrade.moveToHost(ov.frlgMoveId, hostMoveSet);
          copy.moves[mi] = fallback;
          copy.pp[mi] = truthy(ov.pp) ? ov.pp : truthy(pp) ? pp : 5;
          insert(remap, {
            partySlot: pi,
            moveSlot: mi,
            frlgMoveId: ov.frlgMoveId,
            hostFallbackId: fallback,
          } satisfies RemapRow);
        } else {
          const hostMove = Downgrade.moveToHost(moveId, hostMoveSet);
          // If remapped away from original string/number, track as overlay-less remap
          if (truthy(moveId) && truthy(hostMove) && hostMove !== moveId && typeof moveId !== "number") {
            // Gen3 string id on opaque mon without overlay entry
            insert(remap, {
              partySlot: pi,
              moveSlot: mi,
              frlgMoveId: moveId,
              hostFallbackId: hostMove,
            } satisfies RemapRow);
            copy.moves[mi] = hostMove;
          } else {
            copy.moves[mi] = truthy(hostMove) ? hostMove : moveId;
          }
          copy.pp[mi] = pp;
        }
      }
      battleParty[pi] = copy;
    }
    return [battleParty, remap];
  },

  /** After battle: map fallback PP back onto overlay / opaque mon. Never write fallback id into move slot. */
  // Lua: battle_downgrade.lua:146
  writebackPlayerPp(sessionParty: any, moveOverlay: LuaTable | undefined, remap: any, battleParty: any): LuaTable | undefined {
    if (!isTable(remap)) return undefined;
    moveOverlay = truthy(moveOverlay) ? moveOverlay : {};
    for (const [, row] of ipairs<RemapRow>(remap)) {
      const pi = row.partySlot, mi = row.moveSlot;
      const battleMon = truthy(battleParty) ? battleParty[pi] : battleParty;
      const newPp = truthy(battleMon) && truthy(battleMon.pp) ? battleMon.pp[mi] : undefined;
      if (newPp != null) {
        moveOverlay[pi] = truthy(moveOverlay[pi]) ? moveOverlay[pi] : {};
        const ov = truthy(moveOverlay[pi][mi]) ? moveOverlay[pi][mi] : { frlgMoveId: row.frlgMoveId };
        ov.frlgMoveId = row.frlgMoveId; // never fallback
        ov.pp = newPp;
        moveOverlay[pi][mi] = ov;
        // Also keep opaque mon PP in sync if slot still holds a host-legal move id;
        // do not replace moves[mi] with hostFallbackId.
        const mon = truthy(sessionParty) ? sessionParty[pi] : undefined;
        if (truthy(mon)) {
          mon.pp = truthy(mon.pp) ? mon.pp : seq();
          mon.pp[mi] = newPp;
          // If mon.moves[mi] was already the Gen3 id, leave it; if host id, leave it.
          if (truthy(mon.moves) && luaEq(mon.moves[mi], row.hostFallbackId)) {
            mon.moves[mi] = row.frlgMoveId;
          }
        }
      }
    }
    return moveOverlay;
  },
};

export default Downgrade;
