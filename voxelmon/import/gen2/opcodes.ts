// Gen 2 script opcodes: port of gen1recomp src/script/gen2/Opcodes.lua
// (bdfac727), from pokegold/macros/scripts/events.asm. `size` is operand
// bytes after the opcode, for the import-time disassembly. Gold and Silver
// share this dialect (events.asm:540); Crystal renumbers from $52
// (Opcodes.lua:175-270, farjumptext at $52): `opcodesFor("crystal")` hands
// back the runtime port's CRYSTAL table (game/gen2/script/Opcodes.ts), the
// one the VM runs, so the two can never disagree.
// Notes kept from the Lua: givepoke is variable length (4, or 8 when the
// trainer byte is set; the extractor special-cases it); swarm is a bare
// map_id, 2 bytes (Opcodes.lua:163-169).

import { Opcodes } from "../../game/gen2/script/Opcodes.ts";

export interface OpcodeInfo {
  name: string;
  size: number;
}

const ROWS: [number, string, number][] = [
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
  [0x22, "givemoney", 4],
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
  [0x9e, "swarm", 2],
  [0x9f, "halloffame", 0],
  [0xa0, "credits", 0],
  [0xa1, "warpfacing", 5],
];

/** Opcodes.lua:4 — opcode byte -> {name, size}. */
export const OPCODES: Map<number, OpcodeInfo> = new Map(ROWS.map(([code, name, size]) => [code, { name, size }]));

let crystalOpcodes: Map<number, OpcodeInfo> | undefined;

/** Opcodes.lua:333 forEdition: Gold and Silver share OPCODES; Crystal's
 * renumbered dialect comes from the runtime table. */
export function opcodesFor(edition: string): Map<number, OpcodeInfo> {
  if (edition !== "crystal") return OPCODES;
  if (!crystalOpcodes) {
    const table = Opcodes.forEdition("crystal") as unknown as Record<number, OpcodeInfo>;
    crystalOpcodes = new Map();
    for (let byte = 0; byte < 0x100; byte++) {
      const row = table[byte];
      if (row) crystalOpcodes.set(byte, { name: row.name, size: row.size });
    }
  }
  return crystalOpcodes;
}

/** Opcodes.lua:172 — pokegold/macros/scripts/events.asm:1015. */
export const NUM_EVENT_COMMANDS = 0xa2;

/** Opcodes.lua:291 TERMINATORS — commands that end the current linear
 * path (jumps transfer control; fruittree/describedecoration are
 * ScriptJumps; halloffame/credits fall into ReturnFromCredits).
 * catchtutorial is deliberately not here. farjumptext is Crystal's but
 * harmless to keep. */
export const TERMINATORS: ReadonlySet<string> = new Set([
  "sjump", "farsjump", "memjump", "jumpstd",
  "jumptext", "farjumptext", "jumptextfaceplayer",
  "stopandsjump", "end", "endall", "endcallback",
  "reloadend",
  "fruittree", "describedecoration",
  "halloffame", "credits",
]);
