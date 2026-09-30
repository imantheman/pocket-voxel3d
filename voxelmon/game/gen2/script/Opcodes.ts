// Gen 2 script opcodes from pokegold/macros/scripts/events.asm.
// `size` is operand bytes after the opcode (for import-time disassembly).
//
// Port of gen1recomp src/script/gen2/Opcodes.lua at bdfac727 (MIT). Like the
// Lua table, `Opcodes[byte]` is { name, size } for every command byte, and
// the table carries NUM_EVENT_COMMANDS, TERMINATORS, MOD_COMMAND, key and
// forEdition beside the rows.

import { format } from "../platform/lua.ts";

export interface OpcodeRow {
  name: string;
  size: number;
}

export interface OpcodeTable {
  [byte: number]: OpcodeRow;
  NUM_EVENT_COMMANDS: number;
  TERMINATORS: Record<string, boolean>;
  MOD_COMMAND: string;
  key(bank: number, address: number): string;
  forEdition(edition?: string): OpcodeTable;
}

// Lua: Opcodes.lua:4
const GOLD_ROWS: [number, string, number][] = [
  [0x00, "scall", 2],
  [0x01, "farscall", 3],
  [0x02, "memcall", 2],
  [0x03, "sjump", 2],
  [0x04, "farsjump", 3],
  [0x05, "memjump", 2],
  [0x06, "ifequal", 3],
  [0x07, "ifnotequal", 3],
  [0x08, "iffalse", 2],
  [0x09, "iftrue", 2],
  [0x0a, "ifgreater", 3],
  [0x0b, "ifless", 3],
  [0x0c, "jumpstd", 2],
  [0x0d, "callstd", 2],
  [0x0e, "callasm", 3],
  [0x0f, "special", 2],
  [0x10, "memcallasm", 2],
  [0x11, "checkmapscene", 2],
  [0x12, "setmapscene", 3],
  [0x13, "checkscene", 0],
  [0x14, "setscene", 1],
  [0x15, "setval", 1],
  [0x16, "addval", 1],
  [0x17, "random", 1],
  [0x18, "checkver", 0],
  [0x19, "readmem", 2],
  [0x1a, "writemem", 2],
  [0x1b, "loadmem", 3],
  [0x1c, "readvar", 1],
  [0x1d, "writevar", 1],
  [0x1e, "loadvar", 2],
  [0x1f, "giveitem", 2],
  [0x20, "takeitem", 2],
  [0x21, "checkitem", 1],
  [0x22, "givemoney", 4], // account + 3-byte money (macro)
  [0x23, "takemoney", 4],
  [0x24, "checkmoney", 4],
  [0x25, "givecoins", 2],
  [0x26, "takecoins", 2],
  [0x27, "checkcoins", 2],
  [0x28, "addcellnum", 1],
  [0x29, "delcellnum", 1],
  [0x2a, "checkcellnum", 1],
  [0x2b, "checktime", 1],
  [0x2c, "checkpoke", 1],
  // Variable length in ROM (4, or 8 when trainer!=0); extractor special-cases it.
  [0x2d, "givepoke", 4],
  [0x2e, "giveegg", 2],
  [0x2f, "givepokemail", 2],
  [0x30, "checkpokemail", 2],
  [0x31, "checkevent", 2],
  [0x32, "clearevent", 2],
  [0x33, "setevent", 2],
  [0x34, "checkflag", 2],
  [0x35, "clearflag", 2],
  [0x36, "setflag", 2],
  [0x37, "wildon", 0],
  [0x38, "wildoff", 0],
  [0x39, "xycompare", 2],
  [0x3a, "warpmod", 3],
  [0x3b, "blackoutmod", 2],
  [0x3c, "warp", 4],
  [0x3d, "getmoney", 2],
  [0x3e, "getcoins", 1],
  [0x3f, "getnum", 1],
  [0x40, "getmonname", 2],
  [0x41, "getitemname", 2],
  [0x42, "getcurlandmarkname", 1],
  [0x43, "gettrainername", 3],
  [0x44, "getstring", 3],
  [0x45, "itemnotify", 0],
  [0x46, "pocketisfull", 0],
  [0x47, "opentext", 0],
  [0x48, "reanchormap", 1],
  [0x49, "closetext", 0],
  [0x4a, "writeunusedbyte", 1],
  [0x4b, "farwritetext", 3],
  [0x4c, "writetext", 2],
  [0x4d, "repeattext", 2],
  [0x4e, "yesorno", 0],
  [0x4f, "loadmenu", 2],
  [0x50, "closewindow", 0],
  [0x51, "jumptextfaceplayer", 2],
  [0x52, "jumptext", 2],
  [0x53, "waitbutton", 0],
  [0x54, "promptbutton", 0],
  [0x55, "pokepic", 1],
  [0x56, "closepokepic", 0],
  [0x57, "_2dmenu", 0],
  [0x58, "verticalmenu", 0],
  [0x59, "loadpikachudata", 0],
  [0x5a, "randomwildmon", 0],
  [0x5b, "loadtemptrainer", 0],
  [0x5c, "loadwildmon", 2],
  [0x5d, "loadtrainer", 2],
  [0x5e, "startbattle", 0],
  [0x5f, "reloadmapafterbattle", 0],
  [0x60, "catchtutorial", 1],
  [0x61, "trainertext", 1],
  [0x62, "trainerflagaction", 1],
  [0x63, "winlosstext", 4],
  [0x64, "scripttalkafter", 0],
  [0x65, "endifjustbattled", 0],
  [0x66, "checkjustbattled", 0],
  [0x67, "setlasttalked", 1],
  [0x68, "applymovement", 3],
  [0x69, "applymovementlasttalked", 2],
  [0x6a, "faceplayer", 0],
  [0x6b, "faceobject", 2],
  [0x6c, "variablesprite", 2],
  [0x6d, "disappear", 1],
  [0x6e, "appear", 1],
  [0x6f, "follow", 2],
  [0x70, "stopfollow", 0],
  [0x71, "moveobject", 3],
  [0x72, "writeobjectxy", 1],
  [0x73, "loademote", 1],
  [0x74, "showemote", 3],
  [0x75, "turnobject", 2],
  [0x76, "follownotexact", 2],
  [0x77, "earthquake", 1],
  [0x78, "changemapblocks", 3],
  [0x79, "changeblock", 3],
  [0x7a, "reloadmap", 0],
  [0x7b, "refreshmap", 0],
  [0x7c, "writecmdqueue", 2],
  [0x7d, "delcmdqueue", 1],
  [0x7e, "playmusic", 2],
  [0x7f, "encountermusic", 0],
  [0x80, "musicfadeout", 3],
  [0x81, "playmapmusic", 0],
  [0x82, "dontrestartmapmusic", 0],
  [0x83, "cry", 2],
  [0x84, "playsound", 2],
  [0x85, "waitsfx", 0],
  [0x86, "warpsound", 0],
  [0x87, "specialsound", 0],
  [0x88, "autoinput", 3],
  [0x89, "newloadmap", 1],
  [0x8a, "pause", 1],
  [0x8b, "deactivatefacing", 1],
  [0x8c, "sdefer", 2],
  [0x8d, "warpcheck", 0],
  [0x8e, "stopandsjump", 2],
  [0x8f, "endcallback", 0],
  [0x90, "end", 0],
  [0x91, "reloadend", 1],
  [0x92, "endall", 0],
  [0x93, "pokemart", 3],
  [0x94, "elevator", 2],
  [0x95, "trade", 1],
  [0x96, "askforphonenumber", 1],
  [0x97, "phonecall", 2],
  [0x98, "hangup", 0],
  [0x99, "describedecoration", 1],
  [0x9a, "fruittree", 1],
  [0x9b, "specialphonecall", 2],
  [0x9c, "checkphonecall", 0],
  [0x9d, "verbosegiveitem", 2],
  // `swarm` is a bare `map_id` (two bytes; Script_swarm makes exactly two
  // GetScriptByte calls).  This row used to say 3.  Lua: Opcodes.lua:163-169
  [0x9e, "swarm", 2],
  [0x9f, "halloffame", 0],
  [0xa0, "credits", 0],
  [0xa1, "warpfacing", 5],
];

// pokecrystal/macros/scripts/events.asm:541-1066, cross-checked against
// ScriptCommandTable at pokecrystal/engine/overworld/scripting.asm:64-237.
// $00..$51 are pokegold's rows, copied below.  Lua: Opcodes.lua:189
const CRYSTAL_ROWS: [number, string, number][] = [
  [0x52, "farjumptext", 3],
  [0x53, "jumptext", 2],
  [0x54, "waitbutton", 0],
  [0x55, "promptbutton", 0],
  [0x56, "pokepic", 1],
  [0x57, "closepokepic", 0],
  [0x58, "_2dmenu", 0],
  [0x59, "verticalmenu", 0],
  [0x5a, "loadpikachudata", 0],
  [0x5b, "randomwildmon", 0],
  [0x5c, "loadtemptrainer", 0],
  [0x5d, "loadwildmon", 2],
  [0x5e, "loadtrainer", 2],
  [0x5f, "startbattle", 0],
  [0x60, "reloadmapafterbattle", 0],
  [0x61, "catchtutorial", 1],
  [0x62, "trainertext", 1],
  [0x63, "trainerflagaction", 1],
  [0x64, "winlosstext", 4],
  [0x65, "scripttalkafter", 0],
  [0x66, "endifjustbattled", 0],
  [0x67, "checkjustbattled", 0],
  [0x68, "setlasttalked", 1],
  [0x69, "applymovement", 3],
  [0x6a, "applymovementlasttalked", 2],
  [0x6b, "faceplayer", 0],
  [0x6c, "faceobject", 2],
  [0x6d, "variablesprite", 2],
  [0x6e, "disappear", 1],
  [0x6f, "appear", 1],
  [0x70, "follow", 2],
  [0x71, "stopfollow", 0],
  [0x72, "moveobject", 3],
  [0x73, "writeobjectxy", 1],
  [0x74, "loademote", 1],
  [0x75, "showemote", 3],
  [0x76, "turnobject", 2],
  [0x77, "follownotexact", 2],
  [0x78, "earthquake", 1],
  [0x79, "changemapblocks", 3],
  [0x7a, "changeblock", 3],
  [0x7b, "reloadmap", 0],
  [0x7c, "refreshmap", 0],
  [0x7d, "writecmdqueue", 2],
  [0x7e, "delcmdqueue", 1],
  [0x7f, "playmusic", 2],
  [0x80, "encountermusic", 0],
  [0x81, "musicfadeout", 3],
  [0x82, "playmapmusic", 0],
  [0x83, "dontrestartmapmusic", 0],
  [0x84, "cry", 2],
  [0x85, "playsound", 2],
  [0x86, "waitsfx", 0],
  [0x87, "warpsound", 0],
  [0x88, "specialsound", 0],
  [0x89, "autoinput", 3],
  [0x8a, "newloadmap", 1],
  [0x8b, "pause", 1],
  [0x8c, "deactivatefacing", 1],
  [0x8d, "sdefer", 2],
  [0x8e, "warpcheck", 0],
  [0x8f, "stopandsjump", 2],
  [0x90, "endcallback", 0],
  [0x91, "end", 0],
  [0x92, "reloadend", 1],
  [0x93, "endall", 0],
  [0x94, "pokemart", 3],
  [0x95, "elevator", 2],
  [0x96, "trade", 1],
  [0x97, "askforphonenumber", 1],
  [0x98, "phonecall", 2],
  [0x99, "hangup", 0],
  [0x9a, "describedecoration", 1],
  [0x9b, "fruittree", 1],
  [0x9c, "specialphonecall", 2],
  [0x9d, "checkphonecall", 0],
  [0x9e, "verbosegiveitem", 2],
  [0x9f, "verbosegiveitemvar", 2],
  // events.asm:1003-1008: Crystal's swarm is `db flag` then `map_id`
  // (scripting.asm:654-662).
  [0xa0, "swarm", 3],
  [0xa1, "halloffame", 0],
  [0xa2, "credits", 0],
  [0xa3, "warpfacing", 5],
  [0xa4, "battletowertext", 1],
  [0xa5, "getlandmarkname", 2],
  [0xa6, "gettrainerclassname", 2],
  [0xa7, "getname", 3],
  [0xa8, "wait", 1],
  [0xa9, "checksave", 0],
];

// Commands that end the current linear path (jumps transfer control).
// `fruittree` / `describedecoration` are ScriptJumps and `halloffame` /
// `credits` fall into ReturnFromCredits (Script_endall); `catchtutorial` is
// deliberately NOT here (it ends on `jp Script_reloadmap` and the script
// continues).  `farjumptext` is Crystal's jumptext twin
// (pokecrystal/engine/overworld/scripting.asm:318-327).  Lua: Opcodes.lua:299
const TERMINATORS: Record<string, boolean> = {
  sjump: true, farsjump: true, memjump: true, jumpstd: true,
  jumptext: true, farjumptext: true, jumptextfaceplayer: true,
  stopandsjump: true, end: true, endall: true, endcallback: true,
  reloadend: true,
  fruittree: true, describedecoration: true,
  halloffame: true, credits: true,
};

// The one op name this engine adds, deliberately with NO byte behind it: a
// mod verb is reachable only by NAME, from a row a mod wrote, never from one
// the extractor did (Gold leaves $a2..$ff free, events.asm:1015; Crystal only
// $aa..$ff, events.asm:1068).  Vm:runModCommand is the only reader.
// Lua: Opcodes.lua:321
const MOD_COMMAND = "modcommand";

// Lua: Opcodes.lua:323
function key(bank: number, address: number): string {
  return format("%02x:%04x", bank, address);
}

const CRYSTAL = {} as OpcodeTable;

// Gold and Silver share one dialect (pokegold/macros/scripts/events.asm:540);
// Crystal renumbers from $52 (pokecrystal/macros/scripts/events.asm:541).
// Lua: Opcodes.lua:333
function forEdition(edition?: string): OpcodeTable {
  if (edition === "crystal") return CRYSTAL;
  return Opcodes;
}

export const Opcodes = {
  // pokegold/macros/scripts/events.asm:1015 DEF NUM_EVENT_COMMANDS EQU $a2
  // Lua: Opcodes.lua:177
  NUM_EVENT_COMMANDS: 0xa2,
  TERMINATORS,
  MOD_COMMAND,
  key,
  forEdition,
} as OpcodeTable;

for (const [byte, name, size] of GOLD_ROWS) Opcodes[byte] = { name, size };

// Lua: Opcodes.lua:181-185
for (let byte = 0x00; byte <= 0x51; byte++) {
  const row = Opcodes[byte]!;
  CRYSTAL[byte] = { name: row.name, size: row.size };
}
for (const [byte, name, size] of CRYSTAL_ROWS) CRYSTAL[byte] = { name, size };
// pokecrystal/macros/scripts/events.asm:1068 DEF NUM_EVENT_COMMANDS EQU $aa
// Lua: Opcodes.lua:281
CRYSTAL.NUM_EVENT_COMMANDS = 0xaa;
// Lua: Opcodes.lua:327-329
CRYSTAL.TERMINATORS = TERMINATORS;
CRYSTAL.MOD_COMMAND = MOD_COMMAND;
CRYSTAL.key = key;
// (The Lua's CRYSTAL table has no forEdition of its own.)

export default Opcodes;
