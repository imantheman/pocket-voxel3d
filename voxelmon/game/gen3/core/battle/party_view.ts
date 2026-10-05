// Port of gen1recomp src/core/game3/battle/party_view.lua (GPLv3 + additional terms; see LICENSE.md).
// Build in-memory battle party from opaque session party + move_overlay.
// Preserves Gen3 move ids (no host downgrade). Tracks overlay slots for PP writeback.
//
// Port notes:
// - fromSession / doubleTransitionLevels return tuples ([battleParty, remap],
//   [pSum, eSum]).
// - shallow() copies one level deep, as Lua; a nested JS array stays an array
//   (same keys).
// - package.loaded["src.core.game3.battle"] is battle.ts's Battle.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { tonumber, truthy } from "../../../../import/gen3/lua.ts";
import { seq, len, ipairs, pairs, type LuaTable } from "../../platform/lt.ts";
import State from "./state.ts";
import { Battle } from "../battle.ts";

export interface PartyViewModule {
  fromSession(sessionParty: any, moveOverlay?: any): [LuaTable, LuaTable];
  live(session: any): LuaTable;
  firstAliveIndex(party: any): number | undefined;
  doubleTransitionLevels(playerParty: any, foeParty: any): [number, number];
}

export const PartyView = {} as PartyViewModule;

// Lua: party_view.lua:6
function shallow(mon: any): any {
  const copy: any = Array.isArray(mon) ? [] : {};
  for (const [k, v] of pairs(mon)) {
    if (v !== null && typeof v === "object") {
      const inner: any = Array.isArray(v) ? [] : {};
      for (const [ik, iv] of pairs(v)) inner[ik] = iv;
      copy[k] = inner;
    } else {
      copy[k] = v;
    }
  }
  return copy;
}

/** Returns battleParty, remap[{partySlot,moveSlot,frlgMoveId}] */
// Lua: party_view.lua:21
PartyView.fromSession = function (sessionParty: any, moveOverlay?: any): [LuaTable, LuaTable] {
  const battleParty: LuaTable = [null];
  const remap: LuaTable = [null];
  if (sessionParty === null || typeof sessionParty !== "object") return [battleParty, remap];
  for (const [pi, mon] of ipairs<any>(sessionParty)) {
    const copy = shallow(mon);
    copy.moves = [null];
    copy.pp = [null];
    const overlaySlot = truthy(moveOverlay) ? moveOverlay[pi] : undefined;
    for (let mi = 1; mi <= 4; mi++) {
      const ov = truthy(overlaySlot) ? overlaySlot[mi] : undefined;
      const monPp = (i: number) => (truthy(mon.pp) ? mon.pp[i] : undefined);
      if (truthy(ov) && truthy(ov.frlgMoveId)) {
        copy.moves[mi] = ov.frlgMoveId;
        copy.pp[mi] = (truthy(ov.pp) ? ov.pp : undefined) ?? (truthy(monPp(mi)) ? monPp(mi) : undefined) ?? 5;
        remap[len(remap) + 1] = {
          partySlot: pi,
          moveSlot: mi,
          frlgMoveId: ov.frlgMoveId,
          hostFallbackId: ov.frlgMoveId, // identity; writeback keeps Gen3 id
        };
      } else {
        const rawM = truthy(mon.moves) ? mon.moves[mi] : undefined;
        if (rawM !== null && typeof rawM === "object") {
          copy.moves[mi] = [rawM.id, rawM.move, rawM.num, rawM.moveId, rawM.name, rawM[1]].find((v) => truthy(v)) ?? rawM[1];
          copy.pp[mi] = truthy(rawM.pp) ? rawM.pp : monPp(mi);
        } else {
          copy.moves[mi] = rawM;
          copy.pp[mi] = monPp(mi);
        }
      }
    }
    battleParty[pi] = copy;
  }
  return [battleParty, remap];
};

const LIVE_IDS = seq(0, 2);

/**
 * The party an item UI must read while it is open.
 *
 * The battle runs on the copy built by fromSession, and battle_bridge only
 * writes it back into session.party when the battle ends.  Anything that
 * opens mid-battle and shows HP (the bag's party-select screen, the Berry
 * Pouch) has to read the copy or it shows pre-battle HP and refuses heals
 * that would in fact work.
 */
// Lua: party_view.lua:64
PartyView.live = function (session: any): LuaTable {
  // package.loaded["src.core.game3.battle"]
  const st = truthy(Battle) ? Battle._st : undefined;
  if (!(truthy(st) && truthy(st.playerParty))) {
    return (truthy(session) && truthy(session.party)) ? session.party : [null];
  }
  // Flush the active battlers' HP/status first, exactly as the switch path
  // does (battle/ui.lua open_battle_party).  battlers[2] is the second player
  // battler in doubles and nil in singles, so this is safe either way.
  for (const [, id] of ipairs<number>(LIVE_IDS)) {
    const b = State.battler(st, id);
    if (truthy(b) && b.side === "player") {
      State.syncBattlerToParty(b, st.playerParty);
    }
  }
  return st.playerParty;
};

// Lua: party_view.lua:83
PartyView.firstAliveIndex = function (party: any): number | undefined {
  if (party === null || typeof party !== "object") return undefined;
  for (const [i, mon] of ipairs<any>(party)) {
    if (truthy(mon) && (tonumber(mon.hp) ?? 0) > 0) return i;
  }
  return undefined;
};

// pokefirered/src/battle_setup.c:542
// Lua: party_view.lua:92
PartyView.doubleTransitionLevels = function (playerParty: any, foeParty: any): [number, number] {
  let pSum = 0, need = 2;
  for (const [, mon] of ipairs<any>(playerParty ?? [null])) {
    const sp = tonumber(truthy(mon.species) ? mon.species : mon.speciesId) ?? 0;
    if (sp !== 0 && sp !== 412 && !truthy(mon.isEgg) && (tonumber(mon.hp) ?? 0) !== 0) {
      pSum = (pSum + (tonumber(truthy(mon.level) ? mon.level : mon.lvl) ?? 0)) % 256;
      need = need - 1;
      if (need === 0) break;
    }
  }
  // pokefirered/src/battle_setup.c:561
  let eSum = 0;
  for (let i = 1; i <= Math.min(2, len(foeParty ?? [null])); i++) {
    const m = foeParty[i];
    eSum = (eSum + (tonumber(truthy(m.level) ? m.level : m.lvl) ?? 0)) % 256;
  }
  return [pSum, eSum];
};

export default PartyView;
