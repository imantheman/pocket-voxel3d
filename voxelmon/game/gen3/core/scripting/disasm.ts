// Port of gen1recomp src/core/game3/scripting/disasm.lua (GPLv3 + additional terms; see LICENSE.md).
// Disassemble FRLG script bytecode into command rows.
// Lua differences: `bytes` is a 0-based byte array (the Lua's 1-based table),
// but every index `i` here keeps the Lua's 1-based position (bytes[i - 1]),
// so callers' offsets (`off + i - 1`) port unchanged. A row is an object that
// holds the Lua's positional operands under integer keys (row[1], row[2]:
// Lua NUMBER keys, see import/gen3/luatable.ts) beside its named fields.

import { Opcodes, type OpcodeSet } from "./opcodes.ts";

/** A decoded command row (the Lua table: op, opcode, [1..n] and named fields). */
export type Row = Record<string, any>;

type Bytes = ArrayLike<number>;

// Lua: disasm.lua:7
function u8(bytes: Bytes, i: number): [number, number] {
  return [bytes[i - 1] ?? 0, i + 1];
}

// Lua: disasm.lua:11
function u16(bytes: Bytes, i: number): [number, number] {
  const lo = bytes[i - 1] ?? 0;
  const hi = bytes[i] ?? 0;
  return [lo + hi * 256, i + 2];
}

// Lua: disasm.lua:17
function u32(bytes: Bytes, i: number): [number, number] {
  const a = bytes[i - 1] ?? 0, b = bytes[i] ?? 0, c = bytes[i + 1] ?? 0, d = bytes[i + 2] ?? 0;
  return [a + b * 256 + c * 65536 + d * 16777216, i + 4];
}

// Lua: disasm.lua:22
const TRAINER_BATTLE_PTRS: Record<string, string[]> = {
  SINGLE: ["introText", "defeatText"],
  REMATCH: ["introText", "defeatText"],
  CONTINUE_SCRIPT: ["introText", "defeatText", "eventScript"],
  CONTINUE_SCRIPT_NO_MUSIC: ["introText", "defeatText", "eventScript"],
  SINGLE_NO_INTRO_TEXT: ["defeatText"],
  DOUBLE: ["introText", "defeatText", "notEnoughText"],
  REMATCH_DOUBLE: ["introText", "defeatText", "notEnoughText"],
  CONTINUE_SCRIPT_DOUBLE: ["introText", "defeatText", "notEnoughText", "eventScript"],
  CONTINUE_SCRIPT_DOUBLE_NO_MUSIC: ["introText", "defeatText", "notEnoughText", "eventScript"],
  EARLY_RIVAL: ["defeatText", "victoryText"],
  PYRAMID: ["introText", "defeatText"],
  SET_TRAINER_A: ["introText", "defeatText"],
  SET_TRAINER_B: ["introText", "defeatText"],
  HILL: ["introText", "defeatText"],
};

export const Disasm = {
  TRAINER_BATTLE_PTRS,

  /** Decode one command at (1-based) index i. Returns [row, nextIndex]. */
  // Lua: disasm.lua:41
  decodeOne(bytes: Bytes, i: number, set?: OpcodeSet): [Row, number] {
    set = set ?? Opcodes.active();
    let opb: number;
    [opb, i] = u8(bytes, i);
    const def = set.get(opb);
    if (!def) {
      return [{ op: "unknown", byte: opb }, i];
    }
    const row: Row = { op: def.name, opcode: opb };
    if (def.name === "trainerbattle") {
      // pokeemerald/asm/macros/event.inc:730
      let typ: number, trainer: number, localId: number;
      [typ, i] = u8(bytes, i);
      [trainer, i] = u16(bytes, i);
      [localId, i] = u16(bytes, i);
      row.type = typ;
      row.trainer = trainer;
      row.localId = localId;
      row[1] = trainer;
      row[2] = localId;

      const kind = set.trainerBattleType(typ);
      const ptrs = kind !== undefined ? TRAINER_BATTLE_PTRS[kind] : undefined;
      if (ptrs) {
        if (kind === "EARLY_RIVAL") row.flags = localId;
        for (const field of ptrs) {
          let v: number;
          [v, i] = u32(bytes, i);
          row[field] = v;
        }
      } else {
        row.opaque = true;
      }
      return [row, i];
    }
    let n = 0;
    for (const a of def.args) {
      let v: number;
      if (a.kind === "byte") {
        [v, i] = u8(bytes, i);
        row[++n] = v;
      } else if (a.kind === "half") {
        [v, i] = u16(bytes, i);
        row[++n] = v;
      } else if (a.kind === "word") {
        [v, i] = u32(bytes, i);
        row[++n] = v;
      }
    }
    // Named fields for common Tier A ops.
    const name = def.name;
    if (name === "loadword") {
      row.dest = row[1]; row.value = row[2];
    } else if (name === "callstd" || name === "gotostd") {
      row.std = row[1];
    } else if (name === "setvar" || name === "compare_var_to_value") {
      row.var = row[1]; row.value = row[2];
    } else if (name === "setflag" || name === "clearflag" || name === "checkflag") {
      row.flag = row[1];
    } else if (name === "goto" || name === "call") {
      row.target = row[1];
    } else if (name === "goto_if" || name === "call_if") {
      row.cond = row[1]; row.target = row[2];
    } else if (name === "applymovement") {
      row.localId = row[1]; row.movement = row[2];
    } else if (name === "waitmovement" || name === "removeobject" || name === "addobject") {
      row.localId = row[1];
    } else if (name === "message") {
      row.ptr = row[1];
    } else if (name === "callnative" || name === "gotonative") {
      row.fn = row[1];
    } else if (name === "special") {
      row.id = row[1];
    } else if (name === "textcolor") {
      row.color = row[1];
    } else if (name === "setworldmapflag") {
      row.flag = row[1];
    } else if (name.includes("^buffer")) {
      // Faithful quirk: the Lua calls name:find("^buffer", 1, true), a PLAIN
      // find of the literal text "^buffer", so this branch never matches.
      row.dest = row[1];
      row.src = row[2];
    }
    return [row, i];
  },

  /** Linear disasm until `end`/`return` or maxBytes (start is 1-based). */
  // Lua: disasm.lua:128
  decode(bytes: Bytes, start?: number, maxBytes?: number, set?: OpcodeSet): Row[] {
    start = start ?? 1;
    maxBytes = maxBytes ?? bytes.length;
    const rows: Row[] = [];
    let i = start;
    const limit = Math.min(bytes.length + 1, start + maxBytes);
    while (i < limit) {
      let row: Row;
      [row, i] = Disasm.decodeOne(bytes, i, set);
      rows.push(row);
      if (row.op === "end" || row.op === "return" || row.op === "unknown") {
        break;
      }
    }
    return rows;
  },

  /** Read movement stream until (and including) step_end 0xFE (start is 1-based). */
  // Lua: disasm.lua:146
  decodeMovement(bytes: Bytes, start?: number): number[] {
    start = start ?? 1;
    const out: number[] = [];
    let i = start;
    while (i <= bytes.length) {
      const b = bytes[i - 1]!;
      out.push(b);
      i = i + 1;
      if (b === Opcodes.STEP_END) break;
    }
    return out;
  },

  /** Encode a small subset of Tier A command rows back to bytes (for tests). */
  // Lua: disasm.lua:160
  encodeSimple(rows: Row[]): number[] {
    const out: number[] = [];
    const push = (...vals: number[]): void => {
      for (const v of vals) out.push(v);
    };
    const half = (v: number): void => {
      v = ((v % 65536) + 65536) % 65536;
      push(v % 256, Math.floor(v / 256));
    };
    const word = (v: number): void => {
      v = ((v % 4294967296) + 4294967296) % 4294967296;
      push(v % 256, Math.floor(v / 256) % 256, Math.floor(v / 65536) % 256, Math.floor(v / 16777216) % 256);
    };
    for (const row of rows) {
      const name = row.op;
      let found: number | undefined;
      // NOT FAITHFUL (order): the Lua takes the first match in pairs() order;
      // here bytes ascending (names are unique in the table).
      for (const k of Object.keys(Opcodes.TABLE)) {
        if (Opcodes.TABLE[Number(k)]!.name === name) { found = Number(k); break; }
      }
      if (found === undefined) throw new Error("unknown op " + String(name));
      push(found);
      if (name === "loadword") {
        push(row.dest ?? row[1] ?? 0);
        word(row.value ?? row[2] ?? 0);
      } else if (name === "callstd" || name === "gotostd") {
        push(row.std ?? row[1] ?? 0);
      } else if (name === "setvar" || name === "compare_var_to_value") {
        half(row.var ?? row[1] ?? 0);
        half(row.value ?? row[2] ?? 0);
      } else if (name === "setflag" || name === "clearflag" || name === "checkflag" || name === "setworldmapflag") {
        half(row.flag ?? row[1] ?? 0);
      } else if (name === "goto" || name === "call") {
        word(row.target ?? row[1] ?? 0);
      } else if (name === "goto_if" || name === "call_if") {
        push(row.cond ?? row[1] ?? 0);
        word(row.target ?? row[2] ?? 0);
      } else if (name === "applymovement") {
        half(row.localId ?? row[1] ?? 0);
        word(row.movement ?? row[2] ?? 0);
      } else if (name === "waitmovement" || name === "removeobject" || name === "addobject") {
        half(row.localId ?? row[1] ?? 0);
      } else if (name === "turnobject") {
        half(row.localId ?? row[1] ?? 0);
        push(row.direction ?? row[2] ?? 0);
      } else if (name === "message") {
        word(row.ptr ?? row[1] ?? 0);
      } else if (name === "callnative") {
        word(row.fn ?? row[1] ?? 0);
      } else if (name === "special") {
        half(row.id ?? row[1] ?? 0);
      } else if (name === "textcolor") {
        push(row.color ?? row[1] ?? 0);
      } else if (name === "bufferspeciesname" || name === "bufferitemname"
        || name === "buffernumberstring" || name === "bufferstdstring"
        || name === "bufferpartymonnick" || name === "buffermovename"
        || name === "bufferdecorationname") {
        push(row.dest ?? row[1] ?? 0);
        half(row.src ?? row[2] ?? 0);
      } else if (name === "bufferleadmonspeciesname") {
        push(row.dest ?? row[1] ?? 0);
      } else if (name === "bufferstring") {
        push(row.dest ?? row[1] ?? 0);
        word(row.src ?? row[2] ?? 0);
      }
      // zero-arg ops: end, lock, release, faceplayer, …
    }
    return out;
  },
};

export default Disasm;
