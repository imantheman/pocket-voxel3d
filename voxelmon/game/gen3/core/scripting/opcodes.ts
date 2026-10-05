// Port of gen1recomp src/core/game3/scripting/opcodes.lua (GPLv3 + additional terms; see LICENSE.md).
// The Gen 3 script opcode table (common + per-family tail) and script keys.
// NOT FAITHFUL: only the FRLG tail is ported (opcodes_emerald is out of
// scope); forGame("emerald") throws as the Lua does for an unknown tail.

import { format, tonumber } from "../../../../import/gen3/lua.ts";
import { GameVersion } from "../../../../import/gen3/game_version.ts";
import COMMON, { type OpRow } from "./opcodes_common.ts";
import OPCODES_FRLG from "./opcodes_frlg.ts";
import battleFirered from "../constants/firered/battle.ts";
import { Profile } from "../profile.ts";
import { Constants } from "../constants.ts";

export type { OpRow } from "./opcodes_common.ts";

const TAILS: Record<string, Record<number, OpRow>> = {
  firered: OPCODES_FRLG,
};

// Lua: opcodes.lua:10 -- [table, max byte of the tail]
function build(tail: Record<number, OpRow>): [Record<number, OpRow>, number] {
  const t: Record<number, OpRow> = {};
  for (const k of Object.keys(COMMON)) t[Number(k)] = COMMON[Number(k)]!;
  let max = 0;
  for (const k of Object.keys(tail)) {
    const byte = Number(k);
    t[byte] = tail[byte]!;
    if (byte > max) max = byte;
  }
  return [t, max];
}

const [TABLE, MAX] = build(TAILS.firered!);

// pokefirered/data/event_scripts.s:77
const STD: Record<string, number> = {
  OBTAIN_ITEM: 0,
  FIND_ITEM: 1,
  MSGBOX_NPC: 2,
  MSGBOX_SIGN: 3,
  MSGBOX_DEFAULT: 4,
  MSGBOX_YESNO: 5,
  MSGBOX_AUTOCLOSE: 6,
  OBTAIN_DECORATION: 7,
  PUT_ITEM_AWAY: 8,
  RECEIVED_ITEM: 9,
};

// pokeemerald/data/event_scripts.s:96
const STD_EMERALD: Record<string, number> = {
  OBTAIN_ITEM: 0,
  FIND_ITEM: 1,
  MSGBOX_NPC: 2,
  MSGBOX_SIGN: 3,
  MSGBOX_DEFAULT: 4,
  MSGBOX_YESNO: 5,
  MSGBOX_AUTOCLOSE: 6,
  OBTAIN_DECORATION: 7,
  REGISTER_MATCH_CALL: 8,
  MSGBOX_GETPOINTS: 9,
  MSGBOX_POKENAV: 10,
};

// pokeemerald/asm/macros/event.inc:1024
const BRAILLE_FORMAT_SIZE: Record<string, number> = { firered: 0, emerald: 6 };

// The converted battle constants per game (the Lua requires constants.<game>.battle).
const BATTLE: Record<string, any> = { firered: battleFirered };

// Lua: opcodes.lua:72
function trainerBattleTypes(game: string): Record<number, string> {
  const battle = BATTLE[game];
  if (!battle) throw new Error(`module 'src.core.game3.constants.${game}.battle' not found`);
  const out: Record<number, string> = {};
  const byId = battle.byId.TRAINER_BATTLE_ as Record<string, string>;
  for (const id of Object.keys(byId)) out[Number(id)] = byId[id]!.replace(/^TRAINER_BATTLE_/, "");
  return out;
}

/** One game's opcode set (the Lua's SetMethods objects). */
export class OpcodeSet {
  game: string;
  TABLE: Record<number, OpRow>;
  MAX: number;
  STD: Record<string, number>;
  TRAINER_BATTLE: Record<number, string>;
  brailleFormatSize: number;

  constructor(game: string, tbl: Record<number, OpRow>, max: number) {
    this.game = game;
    this.TABLE = tbl;
    this.MAX = max;
    this.STD = game === "firered" ? STD : STD_EMERALD;
    this.TRAINER_BATTLE = trainerBattleTypes(game);
    this.brailleFormatSize = BRAILLE_FORMAT_SIZE[game] ?? 0;
  }

  // Lua: opcodes.lua:86
  get(byte: number): OpRow | undefined {
    return this.TABLE[byte];
  }

  // Lua: opcodes.lua:90
  trainerBattleType(typ: unknown): string | undefined {
    return this.TRAINER_BATTLE[tonumber(typ) ?? -1];
  }
}

const sets: Record<string, OpcodeSet> = {};

// Lua: opcodes.lua:94
function gameKey(version?: string): string {
  return Constants.gameKey(Profile.resolveId(version));
}

export const Opcodes = {
  TABLE,
  MAX,

  COND: { LT: 0, EQ: 1, GT: 2, LE: 3, GE: 4, NE: 5 } as Record<string, number>,

  STD,

  LOCALID_PLAYER: 0xff,

  STEP_END: 0xfe,

  // Lua: opcodes.lua:63
  get(byte: number): OpRow | undefined {
    return Opcodes.TABLE[byte];
  },

  // Lua: opcodes.lua:67 -- "g3:%08x" script key for a GBA pointer
  key(addr: unknown): string {
    if (typeof addr === "string") return addr;
    return format("g3:%08x", tonumber(addr) ?? 0);
  },

  // Lua: opcodes.lua:100
  forGame(version?: string): OpcodeSet {
    const game = gameKey(version);
    let set = sets[game];
    if (set) return set;
    let tbl: Record<number, OpRow>, max: number;
    if (game === "firered") {
      tbl = Opcodes.TABLE;
      max = Opcodes.MAX;
    } else {
      const tail = TAILS[game];
      if (!tail) throw new Error("no opcode table for " + game);
      [tbl, max] = build(tail);
    }
    set = new OpcodeSet(game, tbl, max);
    sets[game] = set;
    return set;
  },

  // Lua: opcodes.lua:122
  active(): OpcodeSet {
    return Opcodes.forGame(GameVersion.get());
  },
};

export default Opcodes;
