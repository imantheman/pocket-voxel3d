// Ports gen1recomp src/core/gen2/NpcTrade.lua at bdfac727 (MIT).
//
// The in-game trades (engine/events/npc_trade.asm, data/events/npc_trades.asm):
// the rules only; the conversation is ui/TradeMenu.ts. Facts Brian keeps:
//   * NPCTRADE_GIVEMON is what YOU hand over, NPCTRADE_GETMON what you get.
//   * The row's DVs are two raw bytes (atk/def, spd/spc nibbles), so every
//     player gets the same mon (gender and shininess included).
//   * The OT ID in the table IS the ID the player sees.
//   * `trade` writes no wScriptVar; every outcome prints and returns.
//   * One-shot, tracked in wTradeFlags by trade id; a second visit prints
//     TRADE_DIALOG_AFTER.
//   * The received mon keeps the LEVEL of the one handed over.
//
// Indexing: `perform`'s party `index` stays 1-based as the Lua passes it;
// storage is `save.party[index - 1]`. `save.tradeFlags` is an object keyed by
// the 0-based trade id. `perform` returns the tuple [given, received].

import { Mail } from "./Mail.ts";
import { Mon } from "../battle/Mon.ts";
import { idiv, mod, removeAt, tonumber } from "../platform/lua.ts";

export interface NpcTradeRow {
  id?: number;
  dialog?: string;
  give?: string;
  giveIndex?: number;
  get?: string;
  getIndex?: number;
  nickname?: string;
  dvs?: number[];
  item?: string | number;
  otId?: number;
  otName?: string;
  gender?: string;
  [key: string]: any;
}

export const NpcTrade = {
  // constants/npc_trade_constants.asm
  NUM_NPC_TRADES: 6,
  TRADE_GENDER_EITHER: "TRADE_GENDER_EITHER",
  TRADE_GENDER_MALE: "TRADE_GENDER_MALE",
  TRADE_GENDER_FEMALE: "TRADE_GENDER_FEMALE",

  // The outcomes, which are also the TRADE_DIALOG_* rows PrintTradeText picks.
  DIALOG_INTRO: "TRADE_DIALOG_INTRO",
  DIALOG_CANCEL: "TRADE_DIALOG_CANCEL",
  DIALOG_WRONG: "TRADE_DIALOG_WRONG",
  DIALOG_COMPLETE: "TRADE_DIALOG_COMPLETE",
  DIALOG_AFTER: "TRADE_DIALOG_AFTER",

  // Lua: NpcTrade.lua:53 -- events `trades`; the JSON array is 0-based like NPC_TRADE_*.
  row(eventTables: any, id: any): NpcTradeRow | undefined {
    const rows = eventTables !== null && typeof eventTables === "object" ? eventTables.trades : undefined;
    if (rows === null || typeof rows !== "object") return undefined;
    // Lua rows[(id or 0) + 1] over a 1-based sequence = JS rows[id].
    return rows[tonumber(id) ?? 0];
  },

  // Lua: NpcTrade.lua:60 -- wTradeFlags, a bit per trade id; save-side a plain set.
  done(save: any, id: any): boolean {
    const flags = save ? save.tradeFlags : undefined;
    return (flags ? flags[tonumber(id) ?? -1] : undefined) === true;
  },

  // Lua: NpcTrade.lua:65
  markDone(save: any, id: any): void {
    if (!save) return;
    save.tradeFlags = save.tradeFlags ?? {};
    save.tradeFlags[tonumber(id) ?? 0] = true;
  },

  // Lua: NpcTrade.lua:73 -- the two DV bytes as the port's named-DV table
  // (`dn attack, defense` then `dn speed, special`).
  dvs(row: NpcTradeRow | undefined): { attack: number; defense: number; speed: number; special: number; hp?: any } {
    const raw = (row && row.dvs) || [];
    const dvs: { attack: number; defense: number; speed: number; special: number; hp?: any } = {
      attack: idiv(raw[0] ?? 0, 16),
      defense: mod(raw[0] ?? 0, 16),
      speed: idiv(raw[1] ?? 0, 16),
      special: mod(raw[1] ?? 0, 16),
    };
    dvs.hp = Mon.hpDV(dvs);
    return dvs;
  },

  // Lua: NpcTrade.lua:94 -- NPCTRADE_ITEM is an item id BYTE; name it so
  // everything downstream sees an items key. 0 is NO_ITEM; a name passes through.
  item(data: any, row: NpcTradeRow | undefined): string | undefined {
    const raw = row ? row.item : undefined;
    if (raw == null || raw === 0) return undefined;
    if (typeof raw === "string") return raw;
    const items = data ? data.items : undefined;
    if (items !== null && typeof items === "object") {
      for (const id of Object.keys(items)) {
        const def = items[id];
        if (def !== null && typeof def === "object" && def.index === raw) return id;
      }
    }
    const order = data && data.constants ? data.constants.itemOrder : undefined;
    // Lua order[raw] over a 1-based sequence = JS order[raw - 1].
    return (order ? order[raw - 1] : undefined) ?? undefined;
  },

  // Lua: NpcTrade.lua:112 -- CheckTradeGender; genderless satisfies neither MALE nor FEMALE.
  genderOk(row: NpcTradeRow | undefined, mon: any): boolean {
    const want = row ? row.gender : undefined;
    if (!want || want === NpcTrade.TRADE_GENDER_EITHER) return true;
    const gender = mon ? mon.gender : undefined;
    if (want === NpcTrade.TRADE_GENDER_MALE) return gender === "male";
    return gender === "female";
  },

  // Lua: NpcTrade.lua:123 -- the refusals, in order; undefined means "go ahead".
  check(row: NpcTradeRow | undefined, mon: any): string | undefined {
    if (!row) return NpcTrade.DIALOG_CANCEL;
    if (!mon) return NpcTrade.DIALOG_CANCEL;
    if (mon.species !== row.give) return NpcTrade.DIALOG_WRONG;
    if (!NpcTrade.genderOk(row, mon)) return NpcTrade.DIALOG_WRONG;
    return undefined;
  },

  // Lua: NpcTrade.lua:140 -- DoNPCTrade. The mon at `index` (1-based) leaves,
  // the party closes up, and the row's mon goes on the END at the same level
  // (RemoveMonFromPartyOrBox before TryAddMonToParty). Returns [given, received].
  perform(data: any, save: any, row: NpcTradeRow | undefined, index: number): [any, any] | undefined {
    const party: any[] | undefined = save ? save.party : undefined;
    const given = party ? party[index - 1] : undefined;
    if (!(data && given && row)) return undefined;
    const received = Mon.new(data, row.get as string, given.level, {
      dvs: NpcTrade.dvs(row),
      nickname: row.nickname,
      item: NpcTrade.item(data, row),
    });
    if (!received) return undefined;
    // `ot` is what Breeding reads and `otName` what the summary prints; set both.
    received.ot = row.otName;
    received.otName = row.otName;
    received.otId = row.otId;
    // engine/events/npc_trade.asm:189-197
    if (Mon.hasCaughtData(save.version)) {
      Mon.setGiftCaughtData(received, row.dialog === "TRADE_DIALOGSET_GIRL" ? "girl" : "unknown");
    }
    removeAt(party!, index);
    // RemoveMonFromPartyOrBox's "Mail time!" tail: NPCTrade has no mail check,
    // so shift the letters so the mon closing up does not inherit one.
    Mail.removeSlot(save, index);
    party!.push(received);
    // TryAddMonToParty's SetSeenAndCaughtMon (engine/pokemon/move_mon.asm:196).
    save.pokedex = save.pokedex ?? {};
    save.pokedex.seen = save.pokedex.seen ?? {};
    save.pokedex.caught = save.pokedex.caught ?? {};
    save.pokedex.seen[received.species] = true;
    save.pokedex.caught[received.species] = true;
    return [given, received];
  },
};

export default NpcTrade;
