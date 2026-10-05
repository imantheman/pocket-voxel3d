// Port of gen1recomp src/core/game3/scripting/opcodes_frlg.lua (GPLv3 + additional terms; see LICENSE.md).
// pokefirered/data/script_cmd_table.inc:203 -- the FRLG tail of the opcode table.

import { op, type OpArg, type OpRow } from "./opcodes_common.ts";

const B: OpArg = { kind: "byte" }, H: OpArg = { kind: "half" }, W: OpArg = { kind: "word" };

const OPCODES_FRLG: Record<number, OpRow> = {
  [0xc7]: op("textcolor", 2, [B]),
  [0xc8]: op("loadhelp", 5, [W]),
  [0xc9]: op("unloadhelp", 1),
  [0xca]: op("signmsg", 1),
  [0xcb]: op("normalmsg", 1),
  // pret asm/macros/event.inc: comparestat — .byte statId / .4byte value
  [0xcc]: op("comparestat", 6, [B, W]),
  [0xcd]: op("setmonmodernfatefulencounter", 3, [H]),
  [0xce]: op("checkmonmodernfatefulencounter", 3, [H]),
  [0xcf]: op("trywondercardscript", 1),
  [0xd0]: op("setworldmapflag", 3, [H]),
  [0xd1]: op("warpspinenter", 8, [B, B, B, H, H]),
  [0xd2]: op("setmonmetlocation", 4, [H, B]),
  [0xd3]: op("getbraillestringwidth", 5, [W]),
  [0xd4]: op("bufferitemnameplural", 6, [B, H, H]),
};

export default OPCODES_FRLG;
