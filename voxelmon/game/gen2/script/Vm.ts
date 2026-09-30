// Gen 2 script VM over import-extracted command lists (scripts.json).
// Yields on text / yesorno / movement / waitsfx so the overworld can drive UI.
//
// Port of gen1recomp src/script/gen2/Vm.lua at bdfac727 (MIT).
//
// Lua coroutines become generators here. Every function that can reach a
// `coroutine.yield` is a `function*`, and each call into one is `yield*`:
// runList, runCmd, showText, showRaw, waitFrames, pauseFrames, runSpecial,
// runModCommand. `Coroutine` below is the thin coroutine.create / resume /
// status / running shim the Lua's lifecycle code (Vm:start, Vm:resume,
// Vm:runCallback, Specials.block) is written against.

import { format, mod, tonumber, tostring, truthy } from "../platform/lua.ts";
import { random } from "../platform/rng.ts";
import { Logger } from "../shared/core/Logger.ts";
import { Runtime } from "../shared/mods/Runtime.ts";
import { Strings } from "../shared/core/Strings.ts";
import { Movement } from "./Movement.ts";
import { Opcodes } from "./Opcodes.ts";
import { Specials } from "./Specials.ts";

// ---- coroutine shim ---------------------------------------------------------

/** What a script yields to Vm:resume: { kind = "text", ... } and friends. */
export type VmRequest = { kind: string; [k: string]: any };
/** A resumable script body (a Lua function run inside a coroutine). */
export type Script<T = any> = Generator<VmRequest, T, any>;

/** True for a generator object (what a `function*` handler returns). */
export function isScript(v: unknown): v is Script {
  return v != null && typeof v === "object" && typeof (v as any).next === "function"
    && typeof (v as any)[Symbol.iterator] === "function";
}

export type CoStatus = "suspended" | "running" | "dead";

/**
 * coroutine.create / coroutine.resume / coroutine.status / coroutine.running
 * over a generator. resume() answers like Lua's: [true, yielded] on a yield,
 * [true, undefined] when the body returns, [false, err] on an error or on a
 * coroutine that is not suspended.
 */
export class Coroutine {
  static current: Coroutine | null = null;

  /** coroutine.running(): is any script coroutine executing right now? */
  static running(): Coroutine | null {
    return Coroutine.current;
  }

  static create(fn: () => Script<any>): Coroutine {
    return new Coroutine(fn);
  }

  private gen: Script<any> | null = null;
  private state: CoStatus = "suspended";

  constructor(private readonly fn: () => Script<any>) {}

  status(): CoStatus {
    return this.state;
  }

  resume(value?: any): [boolean, any] {
    if (this.state !== "suspended") return [false, `cannot resume ${this.state} coroutine`];
    const prev = Coroutine.current;
    Coroutine.current = this;
    this.state = "running";
    try {
      // First resume starts the body (Lua passes the args to fn; ours take none).
      if (!this.gen) this.gen = this.fn();
      const r = this.gen.next(value);
      this.state = r.done ? "dead" : "suspended";
      return [true, r.done ? undefined : r.value];
    } catch (err) {
      this.state = "dead";
      return [false, err];
    } finally {
      Coroutine.current = prev;
    }
  }
}

/** Lua `a or b` for hook answers, where only nil and false fall through. */
function orv<T>(v: T, d: any): any {
  return truthy(v) ? v : d;
}

// ---- constants ----------------------------------------------------------------

// The op name a mod's row carries; no cart byte decodes to it.  See
// Opcodes.MOD_COMMAND and Vm:runModCommand.  Lua: Vm.lua:22
const MOD_COMMAND: string = Opcodes.MOD_COMMAND;

type Cmd = { op?: string; args?: number[]; [k: string]: any };

// Lua: Vm.lua:24
function arg1(cmd: Cmd | undefined): any {
  if (cmd == null) return undefined;
  if (cmd.args) return cmd.args[0];
  return undefined;
}

// constants/script_constants.asm.  LAST_TALKED is -2, so the byte the
// extractor writes is 254: `disappear LAST_TALKED` means hLastTalked, not
// object 254.  Script_disappear / Script_turnobject / Script_writeobjectxy all
// carry that substitution; Script_appear pointedly does not.  Lua: Vm.lua:34
const LAST_TALKED = 0xfe;
// CompareMoneyAction's three answers; HAVE_MORE is ZERO.  Lua: Vm.lua:39
const HAVE_MORE = 0, HAVE_AMOUNT = 1, HAVE_LESS = 2;
// CheckPokeMail's REFUSED (SelectMonFromParty's carry).  Lua: Vm.lua:43
const POKEMAIL_REFUSED = 2;
// Script_askforphonenumber's three answers.  SUCCESS IS ZERO.  Lua: Vm.lua:45
const PHONE_CONTACT_GOT = 0, PHONE_CONTACTS_FULL = 1, PHONE_CONTACT_REFUSED = 2;
// constants/misc_constants.asm.  Lua: Vm.lua:47
const MAX_MONEY = 999999, MAX_COINS = 9999;
// constants/sfx_constants.asm.  Lua: Vm.lua:49
const SFX_ITEM = 0x01, SFX_HANG_UP = 0x6b;
// EMOTE_FROM_MEM is -1, i.e. the byte $ff.  Lua: Vm.lua:51
const EMOTE_FROM_MEM = 0xff;
// constants/item_constants.asm:300 DEF ITEM_FROM_MEM EQU $ff.  Lua: Vm.lua:53
const ITEM_FROM_MEM = 0xff;
// pokecrystal/constants/script_constants.asm:254-257.  Lua: Vm.lua:55
const SWARM_DUNSPARCE = 0;
// pokecrystal/constants/text_constants.asm:13-19 wNamedObjectType.  Lua: Vm.lua:57
const NAMED_MON = 1, NAMED_ITEM = 4, NAMED_TRAINER = 7;
// pokecrystal/engine/overworld/scripting.asm:2336-2347 Script_wait.  Lua: Vm.lua:59
const WAIT_FRAMES_PER_UNIT = 6;
// constants/misc_constants.asm GS_VERSION: 0 Gold, 1 Silver.  Lua: Vm.lua:61
const GS_VERSION_GOLD = 0;
// engine/overworld/variables.asm .VarActionTable rows for wMapGroup and
// wMapNumber (see Vm:scriptCtx).  Lua: Vm.lua:66
const VAR_MAPGROUP = 0x0c, VAR_MAPNUMBER = 0x0d;
// wBattleResult: a win is ZERO.  Lua: Vm.lua:71
const BATTLE_RESULTS: Record<string, number> = { win: 0, lose: 1, draw: 2 };
// ItemPocketNames (data/items/pocket_names.asm) by CheckItemPocket's type;
// the SECOND blank in _PutItemInPocketText / _PocketIsFullText.  Lua: Vm.lua:78
const POCKET_NAMES: Record<string, string> = {
  ITEM: "ITEM POCKET",
  KEY_ITEM: "KEY POCKET",
  BALL: "BALL POCKET",
  TM_HM: "TM POCKET",
};

// CompareMoney (engine/events/money.asm).  Lua: Vm.lua:87
function compareFunds(account: number, amount: number): number {
  if (account < amount) return HAVE_LESS;
  if (account === amount) return HAVE_AMOUNT;
  return HAVE_MORE;
}

// `db account` then `bigdt money`: args[1] is the account, args[2..4] the
// three money bytes BIG-endian.  Lua: Vm.lua:97
function moneyArgs(cmd: Cmd): [number, number] {
  const a = cmd.args ?? [];
  return [a[0] ?? 0, (a[1] ?? 0) * 0x10000 + (a[2] ?? 0) * 0x100 + (a[3] ?? 0)];
}

// The plain `dw` operands are little-endian.  `first` is Lua's 1-based
// operand index.  Lua: Vm.lua:107
function wordArg(cmd: Cmd, first = 1): number {
  const a = cmd.args ?? [];
  return (a[first - 1] ?? 0) + (a[first] ?? 0) * 0x100;
}

// The operand list of a MOD's row: `args`, or the tail of a Gen 1 shaped row
// -- { "mymod:shake", 4, 2 } -> { 4, 2 }.  Built fresh per dispatch.
// Lua: Vm.lua:117
function modArgs(cmd: any): any[] {
  if (cmd.args) return cmd.args;
  const out: any[] = [];
  for (let i = 1; i < cmd.length; i++) out[i - 1] = cmd[i];
  return out;
}

// ---- the interpreter ----------------------------------------------------------

// Execute ONE command out of a list.  Returns "end" (this command ends the
// list it is in), a 1-based row number (only a mod hook produces one), or
// undefined to fall through to the next row.  Lua: Vm.lua:136
function* runCmd(self: Vm, cmd: Cmd, op: string | undefined): Script<any> {
  if (op === "end" || op === "endall" || op === "endcallback" || op === "reloadend") {
    return "end";
  } else if (op === "sjump" || op === "stopandsjump") {
    yield* runList(self, cmd.script);
    return "end";
  } else if (op === "scall") {
    yield* runList(self, cmd.script);
  } else if (op === "sdefer") {
    // Script_sdefer only RECORDS the target; RunSceneScript
    // (engine/overworld/events.asm:388) picks it up after the scene body has
    // run to its `end`.  Vm:runDeferred drains it where the cart does.
    self.deferred = cmd.script;
  } else if (op === "farscall") {
    // Script_farscall is Script_scall with the bank from the command; the
    // extractor already resolved bank:addr into a scripts key.
    yield* runList(self, cmd.script);
  } else if (op === "farsjump") {
    // Script_farsjump: ScriptJump across banks, never returns.
    yield* runList(self, cmd.script);
    return "end";
  } else if (op === "memjump") {
    // Script_memjump reads a far pointer out of WRAM (LoadMemScript fills it
    // at run time): no static target, but still a JUMP, so it ends the list.
    return "end";
  } else if (op === "memcall") {
    // Script_memcall: a WRAM far pointer written by the phone engine at run
    // time.  Explicit no-op; leaves wScriptVar alone.
  } else if (op === "memcallasm") {
    // Script_memcallasm: the WRAM pointer `rst FarCall`ed as raw code.  No
    // interpreter can honour that; explicit no-op.
  } else if (op === "callasm") {
    // Script_callasm: `rst FarCall` into raw code at bank:addr.  A no-op
    // unless the hook models the routine; a number back is wScriptVar, nil
    // means "not modelled, leave it alone" (Script_callasm never writes it).
    if (self.callAsmFn) {
      const value = self.callAsmFn(cmd.label, arg1(cmd) ?? 0, wordArg(cmd, 2));
      if (value != null) self.scriptVar = mod(value, 256);
    }
  } else if (op === "jumptext" || op === "farjumptext") {
    // pokecrystal/engine/overworld/scripting.asm:318-327 Script_farjumptext.
    self.emitFace(false);
    yield* self.showText(cmd.text);
    return "end";
  } else if (op === "jumptextfaceplayer") {
    self.emitFace(true);
    yield* self.showText(cmd.text);
    return "end";
  } else if (op === "faceplayer") {
    self.emitFace(true);
  } else if (op === "opentext" || op === "closetext"
      || op === "promptbutton" || op === "closepokepic") {
    // UI framing / pokepic teardown handled by hooks or TextBox.
    if (op === "closepokepic") {
      // Script_closepokepic is CloseWindow on the pokepic window.
      self.picOpen = false;
      if (self.hidePicFn) self.hidePicFn();
    }
  } else if (op === "reanchormap") {
    // Script_reanchormap: ClearWindowData plus a re-blit; the window
    // teardown is what matters here (ElmsLab reanchors before every pokepic).
    self.picOpen = false;
    if (self.hidePicFn) self.hidePicFn();
  } else if (op === "writetext" || op === "farwritetext") {
    yield* self.showText(cmd.text);
    if (self.nextOp === "playsound") {
      // pokegold home/joypad.asm PromptButton: drain the box's own
      // SFX_READ_TEXT_2 before the script's playsound.
      yield { kind: "waitsfx" };
    }
  } else if (op === "rawtext") {
    // NOT a cart opcode: a hand-ported script's literal text, with `stay` /
    // `hold` riding the row (Vm:showRaw).  The extractor never emits it.
    yield* self.showRaw(Strings.get(cmd.text), cmd.stay,
      truthy(cmd.hold) ? Vm.pauseLength(cmd.hold) : undefined);
  } else if (op === "waitbutton") {
    // Script_waitbutton is a REAL press; after a writetext the port's box has
    // already taken it, so only a standing pokepic window parks here (#911).
    if (self.picOpen && self.waitButtonFn) {
      yield { kind: "waitbutton" };
    }
  } else if (op === "checkevent") {
    self.scriptVar = truthy(self.events.get(cmd.event)) ? 1 : 0;
  } else if (op === "setevent") {
    self.events.set(cmd.event, true);
    if (self.onFlagsChanged) self.onFlagsChanged();
  } else if (op === "clearevent") {
    self.events.set(cmd.event, false);
    if (self.onFlagsChanged) self.onFlagsChanged();
  } else if (op === "checkflag") {
    // Script_checkflag: EngineFlagAction CHECK_FLAG over an ENGINE_* id -- a
    // different namespace from setevent's wEventFlags.
    const flag = cmd.flag ?? wordArg(cmd);
    let set;
    if (self.getEngineFlagFn) {
      set = self.getEngineFlagFn(flag);
    } else {
      set = self.engineFlags[flag];
    }
    self.scriptVar = truthy(set) ? 1 : 0;
  } else if (op === "setflag" || op === "clearflag") {
    // Script_setflag / Script_clearflag over ENGINE_* (badges, Pokegear
    // cards, the contest timer).  Deliberately no onFlagsChanged: engine
    // flags never gate object visibility.
    const flag = cmd.flag ?? wordArg(cmd);
    const value = op === "setflag";
    if (self.setEngineFlagFn) {
      self.setEngineFlagFn(flag, value);
    } else if (value) {
      self.engineFlags[flag] = value;
    } else {
      delete self.engineFlags[flag];
    }
  } else if (op === "iftrue") {
    if (self.scriptVar !== 0) {
      yield* runList(self, cmd.script);
      return "end";
    }
  } else if (op === "iffalse") {
    if (self.scriptVar === 0) {
      yield* runList(self, cmd.script);
      return "end";
    }
  } else if (op === "ifequal") {
    if (self.scriptVar === (cmd.value ?? 0)) {
      yield* runList(self, cmd.script);
      return "end";
    }
  } else if (op === "ifnotequal") {
    if (self.scriptVar !== (cmd.value ?? 0)) {
      yield* runList(self, cmd.script);
      return "end";
    }
  } else if (op === "ifgreater") {
    // Script_ifgreater: operand minus wScriptVar, so the branch is taken on
    // scriptVar > value.
    if ((self.scriptVar ?? 0) > (cmd.value ?? 0)) {
      yield* runList(self, cmd.script);
      return "end";
    }
  } else if (op === "ifless") {
    // Script_ifless: scriptVar minus operand, taken on scriptVar < value.
    if ((self.scriptVar ?? 0) < (cmd.value ?? 0)) {
      yield* runList(self, cmd.script);
      return "end";
    }
  } else if (op === "pause") {
    yield* self.pauseFrames(cmd.frames ?? cmd.length ?? 0);
  } else if (op === "setscene") {
    const scene = cmd.scene ?? arg1(cmd) ?? 0;
    if (self.setSceneFn) self.setSceneFn(scene);
  } else if (op === "checkscene") {
    self.scriptVar = self.getSceneFn ? orv(self.getSceneFn(), 0) : 0;
  } else if (op === "setmapscene") {
    const group = cmd.group ?? (cmd.args && cmd.args[0]);
    const map = cmd.map ?? (cmd.args && cmd.args[1]);
    const scene = cmd.scene ?? (cmd.args && cmd.args[2]) ?? 0;
    if (self.setMapSceneFn) self.setMapSceneFn(group, map, scene);
  } else if (op === "checkmapscene") {
    // Script_checkmapscene: a map with no scene_var row answers $ff, NOT 0.
    const args = cmd.args;
    const group = cmd.group ?? (args && args[0]);
    const mapNum = cmd.map ?? (args && args[1]);
    const scene = self.getMapSceneFn ? self.getMapSceneFn(group, mapNum) : undefined;
    self.scriptVar = orv(scene, 0xff);
  } else if (op === "turnobject") {
    // engine/events/std_scripts.asm: turnobject LAST_TALKED resolves to the
    // NPC last talked to.
    const facing = Movement.dir(cmd.facing ?? 0);
    let object = cmd.object ?? 0;
    if (object === LAST_TALKED) object = self.lastTalked;
    if (self.turnObjectFn) {
      self.turnObjectFn(object, facing);
    }
  } else if (op === "applymovement" || op === "applymovementlasttalked") {
    let object = cmd.object ?? 0;
    if (op === "applymovementlasttalked") {
      object = self.lastTalked ?? 1;
    }
    const movKey = cmd.movement;
    const bytes = movKey != null && self.movements ? self.movements[movKey] : undefined;
    if (bytes && self.applyMovementFn) {
      yield { kind: "move", object, bytes };
    }
  } else if (op === "yesorno") {
    const yes = yield { kind: "yesorno" };
    self.scriptVar = truthy(yes) ? 1 : 0;
  } else if (op === "disappear") {
    // Script_disappear has the `cp LAST_TALKED`; Script_appear does not.
    let object = cmd.object ?? arg1(cmd);
    if (object === LAST_TALKED) object = self.lastTalked;
    if (self.disappearFn) self.disappearFn(object);
  } else if (op === "appear") {
    // Script_appear: the object list changes NOW, not via onFlagsChanged.
    const object = cmd.object ?? arg1(cmd);
    if (self.appearFn) self.appearFn(object);
  } else if (op === "moveobject") {
    // Script_moveobject: the script's bytes are plain map cells (the +4 is
    // the border offset CopyDECoordsToMapObject undoes).
    const args = cmd.args ?? [];
    const object = cmd.object ?? args[0] ?? 0;
    const x = cmd.x ?? args[1] ?? 0;
    const y = cmd.y ?? args[2] ?? 0;
    if (self.moveObjectFn) self.moveObjectFn(object, x, y);
  } else if (op === "variablesprite") {
    // Script_variablesprite: wVariableSprites[byte] = sprite; the first byte
    // is already a 0-based slot (`\1 - SPRITE_VARS`).
    const args = cmd.args ?? [];
    const slot = cmd.slot ?? args[0] ?? 0;
    const sprite = cmd.sprite ?? args[1] ?? 0;
    self.variableSprites[slot] = sprite;
    if (self.variableSpriteFn) self.variableSpriteFn(slot, sprite);
  } else if (op === "loademote") {
    // Script_loademote: EMOTE_FROM_MEM means the emote in wScriptVar.
    let emote = cmd.emote ?? arg1(cmd) ?? 0;
    if (emote === EMOTE_FROM_MEM) emote = self.scriptVar ?? 0;
    self.loadedEmote = emote;
    if (self.loadEmoteFn) self.loadEmoteFn(emote);
  } else if (op === "pokepic") {
    // Script_pokepic leaves its window standing until closepokepic /
    // reanchormap; the flag is what `waitbutton` reads.
    const species = cmd.species ?? arg1(cmd);
    self.picOpen = true;
    if (self.showPicFn) {
      self.showPicFn(species);
    }
  } else if (op === "getmonname") {
    const species = cmd.species ?? arg1(cmd);
    if (self.getMonNameFn) {
      self.setStringBuffer(self.getMonNameFn(species));
    }
  } else if (op === "getitemname") {
    let item = cmd.item ?? arg1(cmd) ?? 0;
    // pokecrystal/engine/overworld/scripting.asm:1597-1601 USE_SCRIPT_VAR
    if (item === 0) item = mod(self.scriptVar ?? 0, 256);
    if (self.getItemNameFn) {
      self.setStringBuffer(self.getItemNameFn(item));
    }
  } else if (op === "getstring") {
    // The extractor already read the `@`-terminated name (Script_getstring
    // CopyName1 -> wStringBuffer2).
    self.setStringBuffer(cmd.string);
  } else if (op === "gettrainername") {
    if (self.getTrainerNameFn) {
      self.setStringBuffer(self.getTrainerNameFn(cmd.group, cmd.trainer));
    }
  } else if (op === "getcurlandmarkname") {
    // Script_getcurlandmarkname: the map is implicit, the operand is only
    // the buffer id and this port has one buffer.
    const name = self.getLandmarkNameFn ? self.getLandmarkNameFn() : undefined;
    if (truthy(name)) self.setStringBuffer(name);
  } else if (op === "getlandmarkname") {
    // pokecrystal/engine/overworld/scripting.asm:1615-1623
    const id = cmd.landmark ?? arg1(cmd) ?? 0;
    const name = self.getLandmarkNameFn ? self.getLandmarkNameFn(id) : undefined;
    if (truthy(name)) self.setStringBuffer(name);
  } else if (op === "gettrainerclassname") {
    // pokecrystal/engine/overworld/scripting.asm:1644-1647
    if (self.getTrainerClassNameFn) {
      const name = self.getTrainerClassNameFn(cmd.class ?? arg1(cmd) ?? 0);
      if (truthy(name)) self.setStringBuffer(name);
    }
  } else if (op === "getname") {
    // pokecrystal/engine/overworld/scripting.asm:1633-1641
    const args = cmd.args ?? [];
    const kind = cmd.kind ?? args[0] ?? 0;
    const id = cmd.id ?? args[1] ?? 0;
    let name;
    if (kind === NAMED_MON && self.getMonNameFn) {
      name = self.getMonNameFn(id);
    } else if (kind === NAMED_ITEM && self.getItemNameFn) {
      name = self.getItemNameFn(id);
    } else if (kind === NAMED_TRAINER && self.getTrainerClassNameFn) {
      name = self.getTrainerClassNameFn(id);
    } else if (self.getNameFn) {
      name = self.getNameFn(kind, id);
    }
    if (truthy(name)) self.setStringBuffer(name);
  } else if (op === "getnum") {
    // Script_getnum: PrintNum of wScriptVar, left-aligned.
    self.setStringBuffer(tostring(self.scriptVar ?? 0));
  } else if (op === "repeattext") {
    // Script_repeattext re-prints wScriptTextBank/Addr ONLY when both operand
    // bytes are -1 (JumpTextScript's `repeattext -1, -1`).
    const args = cmd.args;
    if (args && args[0] === 0xff && args[1] === 0xff && self.lastTextKey) {
      yield* self.showText(self.lastTextKey);
    }
  } else if (op === "givepoke") {
    const species = cmd.species ?? arg1(cmd);
    const level = cmd.level ?? (cmd.args && cmd.args[1]) ?? 5;
    const item = cmd.item ?? (cmd.args && cmd.args[2]) ?? 0;
    const trainer = cmd.trainer ?? (cmd.args && cmd.args[3]) ?? 0;
    if (self.givePokeFn) {
      // engine/pokemon/move_mon.asm:1695-1736: the trainer arm copies the
      // script's own nickname and OT name in instead of asking for one.
      const named = trainer !== 0
        ? { nickname: cmd.name, otName: cmd.otName } : undefined;
      const mon = self.givePokeFn(species, level, item, named);
      // engine/pokemon/move_mon.asm:1753-1757
      if (truthy(mon) && trainer === 0) {
        const r = Specials.askNickname(self, mon);
        if (isScript(r)) yield* r;
      }
    }
  } else if (op === "checkpoke") {
    // Script_checkpoke: IsInArray over wPartySpecies (party only).
    const species = cmd.species ?? arg1(cmd) ?? 0;
    const has = self.hasPokeFn ? self.hasPokeFn(species) : undefined;
    self.scriptVar = truthy(has) ? 1 : 0;
  } else if (op === "giveegg") {
    // Script_giveegg: 0 when no room, 2 when the egg went in.
    const args = cmd.args;
    const species = cmd.species ?? (args && args[0]) ?? 0;
    const level = cmd.level ?? (args && args[1]) ?? 5;
    const given = self.giveEggFn ? self.giveEggFn(species, level) : undefined;
    self.scriptVar = truthy(given) ? 2 : 0;
  } else if (op === "givepokemail") {
    // The extractor resolves the pointer into cmd.mail = { item, message };
    // the raw word is the fallback.  GivePokeMail writes no wScriptVar.
    if (self.givePokeMailFn) {
      self.givePokeMailFn(cmd.mail ?? wordArg(cmd));
    }
  } else if (op === "checkpokemail") {
    // CheckPokeMail BLOCKS on the party list; with no handler, REFUSED.
    const expected = cmd.mail ?? wordArg(cmd);
    if (self.checkPokeMailFn) {
      const answer = yield { kind: "pokemail", mail: expected };
      self.scriptVar = tonumber(answer) ?? POKEMAIL_REFUSED;
    } else {
      self.scriptVar = POKEMAIL_REFUSED;
    }
  } else if (op === "giveitem" || op === "verbosegiveitem"
      || op === "verbosegiveitemvar") {
    let item = cmd.item ?? arg1(cmd) ?? 0;
    // pokecrystal/engine/overworld/scripting.asm:1722-1727 ITEM_FROM_MEM
    if (item === ITEM_FROM_MEM) item = mod(self.scriptVar ?? 0, 256);
    let qty = cmd.quantity ?? (cmd.args && cmd.args[1]) ?? 1;
    if (op === "verbosegiveitemvar") {
      // pokecrystal/engine/overworld/scripting.asm:486-510
      const varId = cmd.var ?? (cmd.args && cmd.args[1]) ?? 0;
      qty = self.readVarFn ? orv(self.readVarFn(varId), 0) : 0;
    }
    // Script_giveitem's own `ld [wCurItem], a` (scripting.asm:1612), which
    // specialsound inside GiveItemScript reads back.
    self.curItem = item;
    let ok = true;
    if (self.giveItemFn) {
      ok = self.giveItemFn(item, qty) !== false;
    }
    self.scriptVar = ok ? 1 : 0;
    if (op === "verbosegiveitem" || op === "verbosegiveitemvar") {
      const name = self.getItemNameFn ? orv(self.getItemNameFn(item), "?") : "?";
      self.setStringBuffer(name);
      // GiveItemScript (engine/overworld/scripting.asm:441-449): both
      // messages print into the ONE MapTextbox the caller opened.  Its
      // `waitsfx` is deliberately NOT a park here (see Vm.lua:673-695).
      yield* self.showRaw(Strings.get("{PLAYER} received\n%s.", name));
      if (ok) {
        if (self.specialSoundFn) {
          self.specialSoundFn(item);
        } else if (self.playSoundFn) {
          self.playSoundFn(1); // SFX_ITEM
        }
        // _PutItemInPocketText's second blank is wStringBuffer3 from
        // ItemPocketNames (data/text/common_2.asm:1351).  Script_specialsound's
        // WaitSFX (scripting.asm:485): the box holds its press until the
        // jingle ends.
        yield* self.showRaw(Strings.get("{PLAYER} put the\n%s in\nthe %s.",
          name, self.pocketName(item)), undefined, undefined, true);
      } else {
        yield* self.showRaw(Strings.get("The %s\nis full…", self.pocketName(item)));
      }
    }
  } else if (op === "itemnotify") {
    // Script_itemnotify is GetPocketName + CurItemName over wCurItem
    // (engine/overworld/scripting.asm:460); no string buffer is read.
    const name = self.curItemName();
    if (name !== "") {
      yield* self.showRaw(Strings.get("{PLAYER} put the\n%s in\nthe %s.",
        name, self.pocketName(self.curItem)));
    }
  } else if (op === "pocketisfull") {
    // Script_pocketisfull reads wCurItem (engine/overworld/scripting.asm:468).
    yield* self.showRaw(Strings.get("The %s\nis full…", self.pocketName(self.curItem)));
  // ---- bag, money and coins (engine/events/money.asm) --------------------
  } else if (op === "checkitem") {
    // Script_checkitem clears wScriptVar FIRST.
    const item = cmd.item ?? arg1(cmd) ?? 0;
    const has = self.hasItemFn ? self.hasItemFn(item) : undefined;
    self.scriptVar = truthy(has) ? 1 : 0;
  } else if (op === "takeitem") {
    // `takeitem item, quantity`; TRUE only when the pack held that many.
    const args = cmd.args;
    const item = cmd.item ?? (args && args[0]) ?? 0;
    const qty = cmd.quantity ?? (args && args[1]) ?? 1;
    const took = self.takeItemFn ? self.takeItemFn(item, qty) : undefined;
    self.scriptVar = truthy(took) ? 1 : 0;
  } else if (op === "checkmoney") {
    // CompareMoneyAction: HAVE_MORE 0 / HAVE_AMOUNT 1 / HAVE_LESS 2.
    const [account, amount] = moneyArgs(cmd);
    const have = self.getMoneyFn ? orv(self.getMoneyFn(account), 0) : 0;
    self.scriptVar = compareFunds(have, amount);
  } else if (op === "givemoney" || op === "takemoney") {
    // GiveMoney caps at MAX_MONEY, TakeMoney floors at 0; no wScriptVar.
    const [account, amount] = moneyArgs(cmd);
    if (self.getMoneyFn && self.setMoneyFn) {
      const have = orv(self.getMoneyFn(account), 0);
      if (op === "givemoney") {
        self.setMoneyFn(account, Math.min(have + amount, MAX_MONEY));
      } else {
        self.setMoneyFn(account, Math.max(have - amount, 0));
      }
    }
  } else if (op === "getmoney") {
    // `getmoney string_buffer, account` emits the ACCOUNT byte first.
    const account = arg1(cmd) ?? 0;
    const have = self.getMoneyFn ? orv(self.getMoneyFn(account), 0) : 0;
    self.setStringBuffer(tostring(have));
  } else if (op === "checkcoins") {
    // Script_checkcoins: the same HAVE_* ladder.
    const have = self.getCoinsFn ? orv(self.getCoinsFn(), 0) : 0;
    self.scriptVar = compareFunds(have, wordArg(cmd));
  } else if (op === "givecoins" || op === "takecoins") {
    const amount = wordArg(cmd);
    if (self.getCoinsFn && self.setCoinsFn) {
      const have = orv(self.getCoinsFn(), 0);
      if (op === "givecoins") {
        self.setCoinsFn(Math.min(have + amount, MAX_COINS));
      } else {
        self.setCoinsFn(Math.max(have - amount, 0));
      }
    }
  } else if (op === "getcoins") {
    const have = self.getCoinsFn ? orv(self.getCoinsFn(), 0) : 0;
    self.setStringBuffer(tostring(have));
  } else if (op === "pokemart") {
    // `pokemart dialog_id, mart_id`: a MARTTYPE_* byte then a WORD mart id.
    // OpenMartDialog does not return until the shop closes, so this parks.
    const args = cmd.args;
    const martType = cmd.martType ?? cmd.dialog ?? (args && args[0]) ?? 0;
    let martId = cmd.mart ?? cmd.martId;
    if (!truthy(martId) && args) {
      martId = (args[1] ?? 0) + (args[2] ?? 0) * 0x100;
    }
    yield { kind: "mart", martType, martId: martId ?? 0 };
  } else if (op === "addcellnum") {
    const phone = cmd.phone ?? arg1(cmd) ?? 0;
    if (self.addCellFn) self.addCellFn(phone);
  } else if (op === "delcellnum") {
    const phone = cmd.phone ?? arg1(cmd) ?? 0;
    if (self.delCellFn) self.delCellFn(phone);
  } else if (op === "checkcellnum") {
    const phone = cmd.phone ?? arg1(cmd) ?? 0;
    const has = self.hasCellFn ? self.hasCellFn(phone) : undefined;
    self.scriptVar = truthy(has) ? 1 : 0;
  } else if (op === "cry") {
    if (self.cryFn) self.cryFn(cmd.id);
  } else if (op === "playsound") {
    if (self.playSoundFn) self.playSoundFn(cmd.id);
  } else if (op === "playmusic") {
    if (self.playMusicFn) self.playMusicFn(cmd.id);
  } else if (op === "playmapmusic") {
    // Script_playmapmusic: PlayMapMusic (home/audio.asm).
    if (self.playMapMusicFn) self.playMapMusicFn();
  } else if (op === "musicfadeout") {
    // Script_musicfadeout: a WORD music id, then a fade byte with
    // MUSIC_FADE_IN_F (bit 7) cleared.
    const args = cmd.args ?? [];
    const music = cmd.id ?? wordArg(cmd);
    const fade = mod(cmd.fade ?? args[2] ?? 0, 128); // clear MUSIC_FADE_IN_F
    if (self.fadeOutMusicFn) self.fadeOutMusicFn(music, fade);
  } else if (op === "dontrestartmapmusic") {
    // Script_dontrestartmapmusic: a ONE SHOT; the next reload comes back
    // SILENT (TryRestartMapMusic, home/audio.asm).
    self.dontRestartMapMusic = true;
    if (self.dontRestartMapMusicFn) self.dontRestartMapMusicFn();
  } else if (op === "warpsound") {
    // Script_warpsound: GetWarpSFX off the tile under the player.
    if (self.warpSoundFn) self.warpSoundFn();
  } else if (op === "waitsfx") {
    yield { kind: "waitsfx" };
  } else if (op === "specialsound") {
    // Script_specialsound (scripting.asm:476): CheckItemPocket over wCurItem.
    if (self.specialSoundFn) {
      self.specialSoundFn(self.curItem);
    } else if (self.playSoundFn) {
      self.playSoundFn(1); // SFX_ITEM
    }
    yield { kind: "waitsfx" };
  } else if (op === "readvar") {
    const id = cmd.var ?? arg1(cmd) ?? 0;
    if (self.readVarFn) {
      self.scriptVar = orv(self.readVarFn(id), 0);
    } else {
      self.scriptVar = 0;
    }
  } else if (op === "writevar") {
    // Script_writevar: [var] = wScriptVar.
    if (self.writeVarFn) {
      self.writeVarFn(cmd.var ?? arg1(cmd) ?? 0, mod(self.scriptVar ?? 0, 256));
    }
  } else if (op === "loadvar") {
    // Script_loadvar: [var] = a LITERAL byte (args = {var, value}).  This arms
    // the special battles (VAR_BATTLETYPE).
    const args = cmd.args;
    const varId = cmd.var ?? (args && args[0]) ?? 0;
    const value = (args && args[1]) ?? 0;
    if (self.writeVarFn) self.writeVarFn(varId, mod(value, 256));
  } else if (op === "readmem") {
    // Script_readmem: wScriptVar = the WRAM byte at args = {lo, hi}.  The hook
    // answers for engine-owned addresses; nil means the VM's own store.
    const addr = wordArg(cmd);
    let value = self.readMemFn ? self.readMemFn(addr) : undefined;
    if (value == null) value = self.mem[addr];
    self.scriptVar = mod(value ?? 0, 256);
  } else if (op === "writemem" || op === "loadmem") {
    // Script_writemem takes wScriptVar; Script_loadmem a literal LAST
    // (args = {lo, hi, value}).
    const addr = wordArg(cmd);
    let value;
    if (op === "loadmem") {
      value = mod((cmd.args && cmd.args[2]) ?? 0, 256);
    } else {
      value = mod(self.scriptVar ?? 0, 256);
    }
    const handled = self.writeMemFn ? self.writeMemFn(addr, value) : undefined;
    if (!truthy(handled)) self.mem[addr] = value;
  } else if (op === "jumpstd") {
    // StdScripts entry, resolved by the extractor to a scripts key; a tail
    // call.
    if (cmd.script) yield* runList(self, cmd.script);
    return "end";
  } else if (op === "callstd") {
    if (cmd.script) yield* runList(self, cmd.script);
  } else if (op === "special") {
    yield* self.runSpecial(cmd.id, cmd);
  } else if (op === "setval") {
    // setval loads wScriptVar, which the ifequal family then tests.
    self.scriptVar = cmd.value ?? arg1(cmd) ?? 0;
  } else if (op === "addval") {
    // Script_addval: added and wrapped at 8 bits (`addval -1` counts down).
    self.scriptVar = mod((self.scriptVar ?? 0) + (arg1(cmd) ?? 0), 256);
  } else if (op === "random") {
    // Script_random: uniform 0 .. n-1; `random 0` is a zero result.
    const n = arg1(cmd) ?? 0;
    self.scriptVar = n === 0 ? 0 : random(0, n - 1);
  } else if (op === "checkver") {
    // Script_checkver: GS_VERSION, 0 Gold / 1 Silver; `iftrue` is SILVER.
    let version = GS_VERSION_GOLD;
    if (self.gsVersionFn) version = orv(self.gsVersionFn(), version);
    self.scriptVar = version;
  } else if (op === "checktime") {
    // Script_checktime: MORN 1, DAY 2, NITE 4; CheckTime.TimeOfDayTable has
    // no DARKNESS_F, so checktime is FALSE for every mask in a dark cave.
    const mask = arg1(cmd) ?? 0;
    const time = self.getTimeOfDayFn ? orv(self.getTimeOfDayFn(), 0) : 0;
    let bit = 0;
    if (time === 0) bit = 1;        // MORN_F
    else if (time === 1) bit = 2;   // DAY_F
    else if (time === 2) bit = 4;   // NITE_F
                                    // DARKNESS_F falls through at 0
    const hit = bit !== 0 && mod(Math.floor(mask / bit), 2) === 1;
    self.scriptVar = hit ? 1 : 0;
  // ---- trainer battles (engine/events/trainer_scripts.asm) ----------------
  } else if (op === "loadtrainer") {
    // `loadtrainer class, member` overrides whatever the object carried.
    self.trainer = self.lookupTrainer(cmd.class ?? arg1(cmd),
      cmd.member ?? (cmd.args && cmd.args[1]));
  } else if (op === "loadtemptrainer") {
    // wTempTrainer: the object's own record.
    self.trainer = self.lookupTrainer(
      self.trainerObject && self.trainerObject.class,
      self.trainerObject && self.trainerObject.member);
  } else if (op === "startbattle") {
    // Resumes with "win" / "lose"; wBattleResult counts up from a WIN
    // (WIN 0, LOSE 1, DRAW 2), so a win is the FALSE arm.
    const outcome = yield { kind: "battle", trainer: self.trainer, wild: self.wildMon };
    self.wildMon = undefined;
    self.trainer = undefined;
    // engine/overworld/scripting.asm Script_startbattle
    if (outcome == null) {
      self.aborted = true;
      return "end";
    }
    self.justBattled = true;
    self.battleOutcome = outcome;
    self.scriptVar = BATTLE_RESULTS[outcome] ?? BATTLE_RESULTS.win;
  } else if (op === "loadwildmon") {
    // Script_loadwildmon rewrites wBattleScriptFlags to the WILD shape, so a
    // stale trainer must not shadow the wild mon.
    self.trainer = undefined;
    self.wildMon = { species: cmd.species ?? arg1(cmd),
      level: cmd.level ?? (cmd.args && cmd.args[1]) };
  } else if (op === "randomwildmon") {
    // Script_randomwildmon: clearing the flags IS the command; the map's own
    // table is rolled (here, rather than inside startbattle).
    self.trainer = undefined;
    self.wildMon = undefined;
    if (self.rollWildFn) self.wildMon = self.rollWildFn();
  } else if (op === "loadpikachudata") {
    // Script_loadpikachudata: PIKACHU (25) at level 5, flags untouched.
    self.wildMon = { species: 25, level: 5 };
  } else if (op === "wildon" || op === "wildoff") {
    // STATUSFLAGS_NO_WILD_ENCOUNTERS_F (bit 5 of wStatusFlags).
    self.wildEncounters = op === "wildon";
    if (self.setWildEncountersFn) {
      self.setWildEncountersFn(self.wildEncounters);
    }
  } else if (op === "swarm") {
    // Script_swarm: a `map_id` into StoreSwarmMapIndices, falling through into
    // SetSwarmFlag.  Crystal adds a leading flag byte (three operands).
    const args = cmd.args ?? [];
    let kind, group, mapNum;
    if (args.length >= 3) {
      [kind, group, mapNum] = [args[0], args[1], args[2]];
    } else {
      kind = SWARM_DUNSPARCE;
      group = cmd.group ?? args[0];
      mapNum = cmd.map ?? args[1];
    }
    if (self.setSwarmFn) self.setSwarmFn(group, mapNum, kind);
  } else if (op === "reloadmapafterbattle" || op === "reloadmap"
      || op === "refreshmap") {
    // Losing ENDS the script: Script_reloadmapafterbattle ScriptJumps to
    // Script_BattleWhiteout on LOSE.  The hook's argument is "this reload
    // runs a map SETUP script" (refreshmap runs none, scripting.asm:2044).
    if (op === "reloadmapafterbattle" && self.battleOutcome === "lose") {
      self.aborted = true;
      self.battleOutcome = undefined;
      if (self.reloadMapFn) self.reloadMapFn(true);
      return "end";
    }
    if (self.reloadMapFn) self.reloadMapFn(op !== "refreshmap");
    // engine/overworld/scripting.asm:1209
    if (op !== "refreshmap") yield* self.waitFrames(1);
  } else if (op === "catchtutorial") {
    // `catchtutorial battle_type` (engine/events/catch_tutorial.asm):
    // StartAutoInput, the battle, StopAutoInput, then `jp Script_reloadmap`.
    // NOT a terminator, and it leaves wScriptVar alone.
    const wild = self.wildMon;
    self.wildMon = undefined;
    if (self.autoInputStreamFn) {
      self.autoInputStreamFn("CATCH_TUTORIAL");
    }
    if (self.catchTutorialFn) {
      yield { kind: "catchtutorial", battleType: cmd.battleType ?? arg1(cmd), wild };
    }
    if (self.stopAutoInputFn) self.stopAutoInputFn();
    if (self.reloadMapFn) self.reloadMapFn(true);
    // engine/overworld/scripting.asm:1209
    yield* self.waitFrames(1);
  } else if (op === "winlosstext") {
    // Overrides the struct's win/loss text for this battle only; a 0
    // argument zeroes that pointer (engine/overworld/scripting.asm:651).
    self.winLossArmed = true;
    self.winTextOverride = cmd.winText;
    self.lossTextOverride = cmd.lossText;
  } else if (op === "trainertext") {
    const which = cmd.index ?? arg1(cmd) ?? 0;
    const obj = self.trainerObject ?? {};
    let key;
    if (which === 1) {
      key = orv(self.winLossArmed && self.winTextOverride,
        (!self.winLossArmed && truthy(obj.winText)) ? obj.winText : undefined);
    } else if (which === 2) {
      key = orv(self.winLossArmed && self.lossTextOverride,
        (!self.winLossArmed && truthy(obj.lossText)) ? obj.lossText : undefined);
    } else {
      key = obj.seenText;
    }
    yield* self.showText(truthy(key) ? key : undefined);
  } else if (op === "trainerflagaction") {
    // EventFlagAction over the struct's beat flag; CHECK writes wScriptVar.
    const action = cmd.action ?? arg1(cmd) ?? 0;
    const flag = self.trainerObject && self.trainerObject.event;
    if (!truthy(flag)) {
      self.scriptVar = 0;
    } else if (action === 2) { // CHECK_FLAG
      self.scriptVar = truthy(self.events.get(flag)) ? 1 : 0;
    } else {
      self.events.set(flag, action === 1); // SET_FLAG / RESET_FLAG
      if (self.onFlagsChanged) self.onFlagsChanged();
    }
  } else if (op === "scripttalkafter") {
    // Tail call into the struct's after-battle script.
    const after = self.trainerObject && self.trainerObject.scriptKey;
    if (truthy(after)) yield* runList(self, after);
    return "end";
  } else if (op === "endifjustbattled") {
    if (self.justBattled) return "end";
  } else if (op === "checkjustbattled") {
    self.scriptVar = self.justBattled ? 1 : 0;
  } else if (op === "setlasttalked") {
    self.lastTalked = cmd.object ?? arg1(cmd);
  } else if (op === "encountermusic") {
    if (self.encounterMusicFn) {
      self.encounterMusicFn(self.trainerObject && self.trainerObject.class);
    }
  } else if (op === "showemote") {
    // `showemote emote, object, length` -- the ! bubble over a trainer.
    const emote = cmd.emote ?? arg1(cmd) ?? 0;
    const object = cmd.object ?? (cmd.args && cmd.args[1]) ?? 0;
    const frames = cmd.frames ?? (cmd.args && cmd.args[2]) ?? 0;
    if (self.showEmoteFn) {
      self.showEmoteFn(emote, object, frames);
    }
    // ShowEmoteScript holds on `pause 0` reading back wScriptDelay
    // (scripting.asm:981, 986-991): two frames per operand byte.
    yield* self.pauseFrames(frames);
  } else if (op === "trainerapproach") {
    // SeenByTrainerScript's callasm TrainerWalkToPlayer + applymovement, as
    // one step: the World owns the path.
    if (self.trainerApproachFn) {
      yield { kind: "approach" };
    }
  } else if (op === "faceobject" || op === "writeobjectxy") {
    // faceobject PLAYER, LAST_TALKED squares the player up to the trainer.
    if (op === "faceobject" && self.faceObjectFn) {
      self.faceObjectFn(cmd.a ?? (cmd.args && cmd.args[0]),
        cmd.b ?? (cmd.args && cmd.args[1]));
    }
  } else if (op === "follow" || op === "follownotexact") {
    // `follow leader, follower`: the New Bark Town teacher's
    // `follow NEWBARKTOWN_TEACHER, PLAYER` drags the player off the coord
    // event's tile.
    if (self.followFn) {
      self.followFn(cmd.a ?? (cmd.args && cmd.args[0]),
        cmd.b ?? (cmd.args && cmd.args[1]));
    }
  } else if (op === "stopfollow") {
    if (self.stopFollowFn) self.stopFollowFn();
  // ---- map blocks (home/map.asm GetBlockLocation) -------------------------
  } else if (op === "changeblock") {
    // Script_changeblock: the script's x and y are CELL coordinates and the
    // block it rewrites is (x / 2, y / 2).
    const args = cmd.args ?? [];
    const x = cmd.x ?? args[0] ?? 0;
    const y = cmd.y ?? args[1] ?? 0;
    const block = cmd.block ?? args[2] ?? 0;
    if (self.changeBlockFn) {
      self.changeBlockFn(Math.floor(x / 2), Math.floor(y / 2), block);
    }
  } else if (op === "changemapblocks") {
    // Script_changemapblocks: a `dba` (bank, then pointer lo/hi), kept as a
    // RAW ROM pointer for World:changeMapBlocks to place.
    const args = cmd.args ?? [];
    const bank = cmd.bank ?? args[0];
    const pointer = cmd.address
      ?? ((args[1] ?? 0) + (args[2] ?? 0) * 0x100);
    if (self.changeMapBlocksFn) {
      self.changeMapBlocksFn(bank, pointer);
    }
  } else if (op === "earthquake") {
    // Script_earthquake: ONE byte carries the displacement (whole byte) and
    // the sleep (byte & $3f); the sleep holds the script.
    const param = cmd.param ?? arg1(cmd) ?? 0;
    const frames = mod(param, 64);
    if (self.earthquakeFn) self.earthquakeFn(param, frames);
    yield* self.waitFrames(frames);
  // ---- warps (home/map.asm) ----------------------------------------------
  } else if (op === "warp" || op === "warpfacing") {
    // Script_warpfacing FALLS THROUGH into Script_warp.  It does NOT end the
    // script.  Group 0 is MAPSETUP_BADWARP on the map already underfoot.
    const args = cmd.args ?? [];
    const base = op === "warpfacing" ? 1 : 0;
    let facing;
    if (op === "warpfacing") {
      facing = Movement.dir(cmd.facing ?? args[0] ?? 0);
    }
    const group = cmd.group ?? args[base] ?? 0;
    const mapNum = cmd.map ?? args[base + 1];
    const x = cmd.x ?? args[base + 2];
    const y = cmd.y ?? args[base + 3];
    if (group === 0) {
      const reload = self.badWarpFn ?? self.reloadMapFn;
      if (reload) reload();
    } else if (self.warpToFn) {
      self.warpToFn(group, mapNum, x, y, facing);
    }
  } else if (op === "warpcheck") {
    // Script_warpcheck arms the warp; it must not warp mid-script.
    if (self.warpCheckFn) self.warpCheckFn();
  } else if (op === "warpmod") {
    // Script_warpmod: wBackupWarpNumber / wBackupMapGroup / wBackupMapNumber.
    const args = cmd.args ?? [];
    const warpId = cmd.warp ?? args[0];
    const group = cmd.group ?? args[1];
    const mapNum = cmd.map ?? args[2];
    if (self.setWarpModFn) self.setWarpModFn(warpId, group, mapNum);
  } else if (op === "blackoutmod") {
    // Script_blackoutmod: wLastSpawnMapGroup / wLastSpawnMapNumber.
    const args = cmd.args ?? [];
    const group = cmd.group ?? args[0];
    const mapNum = cmd.map ?? args[1];
    if (self.setBlackoutMapFn) self.setBlackoutMapFn(group, mapNum);
  } else if (op === "newloadmap") {
    // Script_newloadmap: re-enter the current map through a MapSetupScript.
    const method = cmd.method ?? arg1(cmd) ?? 0;
    if (self.newLoadMapFn) self.newLoadMapFn(method);
  // ---- windows and menus (home/menu.asm) ---------------------------------
  } else if (op === "loadmenu") {
    // LoadMenuHeader only copies it; the verticalmenu / _2dmenu opens it.
    self.menuHeader = cmd.menu ?? { address: wordArg(cmd) };
  } else if (op === "verticalmenu" || op === "_2dmenu") {
    // 1-BASED cursors, 0 is the cancel arm.  Blocks like yesorno.
    const choice = yield { kind: "menu",
      style: op === "_2dmenu" ? "2d" : "vertical",
      header: self.menuHeader };
    self.scriptVar = tonumber(choice) ?? 0;
  } else if (op === "closewindow") {
    // Script_closewindow: the menu hook owns its own screen lifetime.
  // ---- field events ------------------------------------------------------
  } else if (op === "fruittree") {
    // `fruittree tree_id` JUMPS to FruitTreeScript, transcribed here (it is
    // an engine script nothing extracts).  Text bodies from
    // data/text/common_1.asm.
    const tree = cmd.tree ?? arg1(cmd) ?? 0;
    // callasm GetCurTreeFruit: the hook undoes the 1-based FRUITTREE_* offset.
    const item = self.fruitTreeItemFn ? orv(self.fruitTreeItemFn(tree), 0) : 0;
    const name = orv(item !== 0 && self.getItemNameFn
      && self.getItemNameFn(item), "BERRY");
    // readmem wCurFruit / getitemname STRING_BUFFER_3, USE_SCRIPT_VAR
    self.scriptVar = item;
    self.setStringBuffer(name);
    yield* self.showRaw(Strings.get("It's a fruit-\nbearing tree."));
    // callasm TryResetFruitTrees runs BEFORE CheckFruitTree.
    if (self.fruitTreeResetFn) self.fruitTreeResetFn();
    // CheckFruitTree: a SET flag means "already picked".
    const picked = self.fruitTreePickedFn ? self.fruitTreePickedFn(tree) : undefined;
    if (truthy(picked)) {
      yield* self.showRaw(Strings.get("There's nothing\nhere…"));
      return "end";
    }
    yield* self.showRaw(Strings.get("Hey! It's\n%s!", name));
    // readmem wCurFruit / giveitem ITEM_FROM_MEM / iffalse .packisfull
    let ok = true;
    if (self.giveItemFn) ok = self.giveItemFn(item, 1) !== false;
    self.scriptVar = ok ? 1 : 0;
    if (!ok) {
      yield* self.showRaw(Strings.get("But the PACK is\nfull…"));
      return "end";
    }
    yield* self.showRaw(Strings.get("Obtained\n%s!", name));
    // callasm PickedFruitTree: set AFTER the fruit is banked.
    if (self.fruitTreePickFn) self.fruitTreePickFn(tree);
    if (self.specialSoundFn) {
      self.specialSoundFn(item);
    } else if (self.playSoundFn) {
      self.playSoundFn(SFX_ITEM);
    }
    // `specialsound / itemnotify` (engine/events/fruit_trees.asm:23-24); the
    // obtained box's own press is the drain point, not a waitsfx park.
    yield* self.showRaw(Strings.get("{PLAYER} put the\n%s in\nthe %s.",
      name, self.pocketName(item)), undefined, undefined, true);
    return "end";
  } else if (op === "describedecoration") {
    // `describedecoration byte` picks a DECODESC_* arm and JUMPS to the
    // script it hands back (engine/overworld/decorations.asm).
    const kind = cmd.decoration ?? arg1(cmd) ?? 0;
    const descName = cmd.decorationName ?? "";
    if (self.describeDecorationFn) self.describeDecorationFn(kind);
    let arm = (self.eventTables.decorations ?? {})[descName];
    let placed, placedName;
    if (self.decorationSlotFn) {
      [placed, placedName] = asPair(self.decorationSlotFn(descName));
    }
    if (descName === "DECODESC_POSTER" && arm && arm.posters) {
      for (const row of arm.posters) {
        if (row.decoration === placed) {
          arm = row;
          break;
        }
      }
    } else if (truthy(placedName)) {
      self.setStringBuffer(placedName);
    }
    if (arm && arm.script && self.scripts[arm.script]) {
      yield* runList(self, arm.script);
      return "end";
    }
    return "end";
  } else if (op === "trade") {
    // `trade trade_id` -> NPCTrade: a whole blocking conversation; no
    // wScriptVar.
    if (self.npcTradeFn) {
      yield { kind: "trade", trade: cmd.trade ?? arg1(cmd) ?? 0 };
    }
  } else if (op === "elevator") {
    // Script_elevator: wScriptVar = 0 up front, TRUE only when we moved.
    self.scriptVar = 0;
    if (cmd.floors && cmd.floors.length > 0 && self.elevatorFn) {
      const rode = yield { kind: "elevator", floors: cmd.floors };
      self.scriptVar = truthy(rode) ? 1 : 0;
    }
  // ---- phone (engine/phone/phone.asm) ------------------------------------
  } else if (op === "askforphonenumber") {
    // YesNoBox FIRST, then AddPhoneNumber; SUCCESS IS ZERO.
    const contact = cmd.phone ?? arg1(cmd) ?? 0;
    const yes = yield { kind: "yesorno" };
    if (!truthy(yes)) {
      self.scriptVar = PHONE_CONTACT_REFUSED;
    } else {
      const added = self.addPhoneNumberFn ? self.addPhoneNumberFn(contact) : undefined;
      self.scriptVar = truthy(added) ? PHONE_CONTACT_GOT : PHONE_CONTACTS_FULL;
    }
  } else if (op === "phonecall") {
    // `phonecall caller_name` -> PhoneCall: the ring and the caller's name.
    if (self.phoneCallFn) {
      yield { kind: "phonecall", caller: cmd.caller ?? wordArg(cmd) };
    }
  } else if (op === "hangup") {
    // HangUp: SFX_HANG_UP started BEFORE the "Click!" line.
    if (self.playSoundFn) self.playSoundFn(SFX_HANG_UP);
    yield* self.showRaw(Strings.get("Click!"));
    if (self.hangUpFn) self.hangUpFn();
  } else if (op === "specialphonecall") {
    // Only STORES the id; only the low byte is ever read back.
    const id = cmd.call ?? wordArg(cmd);
    self.specialCall = id;
    if (self.setSpecialCallFn) self.setSpecialCallFn(id);
  } else if (op === "checkphonecall") {
    // Script_checkphonecall reads only the LOW byte of wSpecialPhoneCallID.
    const id = orv(self.getSpecialCallFn && self.getSpecialCallFn(),
      orv(self.specialCall, 0));
    self.scriptVar = mod(id, 0x100) !== 0 ? 1 : 0;
  // ---- end of game -------------------------------------------------------
  } else if (op === "halloffame") {
    // Script_halloffame, then ReturnFromCredits (Script_endall).
    if (self.hallOfFameFn) {
      yield { kind: "halloffame" };
    }
    return "end";
  } else if (op === "credits") {
    // Script_credits: RedCredits, then the same teardown.
    if (self.creditsFn) {
      yield { kind: "credits" };
    }
    return "end";
  // ---- Crystal-only verbs ------------------------------------------------
  } else if (op === "wait") {
    // pokecrystal/engine/overworld/scripting.asm:2336-2347: SIX frames a unit.
    yield* self.waitFrames((cmd.frames ?? arg1(cmd) ?? 0) * WAIT_FRAMES_PER_UNIT);
  } else if (op === "checksave") {
    // pokecrystal/engine/overworld/scripting.asm:2349-2353
    let ok = true;
    if (self.checkSaveFn) ok = truthy(self.checkSaveFn());
    self.scriptVar = ok ? 1 : 0;
  } else if (op === "battletowertext") {
    // pokecrystal/engine/overworld/scripting.asm:447-452 BattleTowerText.
    self.noteUnknownOp(op);
  // ---- commands with no engine behind them yet ---------------------------
  } else if (op === "deactivatefacing") {
    // ../pokecrystal/engine/overworld/scripting.asm:2237, :30 WaitScript
    yield* self.pauseFrames(cmd.frames ?? arg1(cmd) ?? 0);
  } else if (op === "writeunusedbyte") {
    // wUnusedScriptByte: a dead write, consumed deliberately.
    self.unusedScriptByte = arg1(cmd) ?? 0;
  } else if (op === "xycompare") {
    // Script_xycompare only stores wXYComparePointer.
    self.xyComparePointer = wordArg(cmd);
  } else if (op === "autoinput") {
    // Script_autoinput: a `dba` (bank, then lo/hi) for StartAutoInput.
    if (self.autoInputFn) {
      self.autoInputFn(arg1(cmd) ?? 0, wordArg(cmd, 2));
    }
  } else if (op === "writecmdqueue") {
    // Script_writecmdqueue: the World resolves the entry from the map
    // (CmdQueue STONE_TABLES).
    if (self.writeCmdQueueFn) {
      self.writeCmdQueueFn(cmd.pointer ?? wordArg(cmd));
    }
  } else if (op === "delcmdqueue") {
    // Script_delcmdqueue answers FALSE on a successful delete and TRUE when
    // there was nothing to delete.
    const kind = cmd.queue ?? arg1(cmd) ?? 0;
    let deleted = false;
    if (self.delCmdQueueFn) deleted = truthy(self.delCmdQueueFn(kind));
    self.scriptVar = deleted ? 0 : 1;
  } else if (op === "unknown" || op === "truncated") {
    // Not a command: the extractor's pointer walk ran into data.  Ending the
    // list is the only safe reading.
    const key = cmd.code ?? op;
    self.badBytes[key] = (self.badBytes[key] ?? 0) + 1;
    return "end";
  } else if (op === MOD_COMMAND) {
    // A mod's verb (Vm:runModCommand); no cart row can carry this op.
    return yield* self.runModCommand(cmd);
  } else {
    // No branch for this opcode: keep running, but record it and say so once.
    self.noteUnknownOp(op);
  }
  return undefined;
}

// A decoration slot hook answers (placed, placedName), which the port returns
// as an array; a bare value is the first half.
function asPair(v: any): [any, any] {
  return Array.isArray(v) ? [v[0], v[1]] : [v, undefined];
}

// `key` is a scripts key, or a command list itself (the two trainer scripts
// the World hands over inline).  Lua: Vm.lua:1811
function* runList(self: Vm, key: any): Script<void> {
  const list: any[] | undefined = (typeof key === "object" && key !== null) ? key : self.scripts[key];
  if (!list) return;
  let i = 0;
  while (list[i]) {
    // A whiteout replaces the running script, so the abort unwinds every
    // nested scall as well as this list.
    if (self.aborted) return;
    const cmd = list[i];
    let op = cmd.op;
    // A row a MOD wrote in the Gen 1 shape, { "mymod:shake", 4, 2 }.
    if (op == null && typeof cmd[0] === "string") op = MOD_COMMAND;
    // One-command lookahead, for `writetext`'s missing terminator.
    self.nextOp = list[i + 1] ? list[i + 1].op : undefined;
    let jump: any;
    if (Runtime.wantsHook("script.command")) {
      // The SAME hook name and (ctx, name, args) the Gen 1 runner passes,
      // plus the decoded row as a fourth argument.
      const args = (op === MOD_COMMAND && modArgs(cmd)) || cmd.args || [];
      const r = Runtime.call("script.command", (_ctx: any, hname: any, hargs: any, hcmd: any) => {
        let row = hcmd ?? cmd;
        if (hargs != null && hargs !== args && hargs !== row.args) {
          row = Object.assign(Array.isArray(row) ? [] : {}, row);
          row.args = hargs;
        }
        return runCmd(self, row, hname ?? row.op ?? op);
      }, self.scriptCtx(), op, args, cmd);
      jump = isScript(r) ? yield* r : r;
    } else {
      jump = yield* runCmd(self, cmd, op);
    }
    if (jump === "end") {
      return;
    } else if (typeof jump === "number") {
      // A hook-returned program counter, 1-based as the Gen 1 runner's.
      i = jump - 1;
    } else {
      if (typeof jump === "string") self.noteBadJump(jump);
      i = i + 1;
    }
  }
}

// ---- the VM ---------------------------------------------------------------------

// Vm.new's hooks -> fields, in the Lua's order (Vm.lua:1914-2067).  Each is
// optional; a missing hook is the headless path the Lua already takes.
const HOOK_FIELDS: [string, string][] = [
  ["showTextFn", "showText"],
  ["facePlayerFn", "facePlayer"],
  ["onFlagsChanged", "onFlagsChanged"],
  ["setSceneFn", "setScene"],
  ["getSceneFn", "getScene"],
  ["setMapSceneFn", "setMapScene"],
  ["turnObjectFn", "turnObject"],
  ["applyMovementFn", "applyMovement"],
  ["yesornoFn", "yesorno"],
  ["disappearFn", "disappear"],
  ["showPicFn", "showPic"],
  ["hidePicFn", "hidePic"],
  ["waitButtonFn", "waitButton"],
  ["getMonNameFn", "getMonName"],
  ["getItemNameFn", "getItemName"],
  ["getItemPocketFn", "getItemPocket"],
  ["getTrainerNameFn", "getTrainerName"],
  ["setStringBufferFn", "setStringBuffer"],
  ["givePokeFn", "givePoke"],
  ["giveItemFn", "giveItem"],
  ["addCellFn", "addCell"],
  ["delCellFn", "delCell"],
  ["hasCellFn", "hasCell"],
  ["cryFn", "cry"],
  ["playSoundFn", "playSound"],
  ["playMusicFn", "playMusic"],
  ["specialSoundFn", "specialSound"],
  ["waitSfxFn", "waitSfx"],
  ["waitSfxCapFn", "waitSfxCap"],
  ["autoInputFn", "autoInput"],
  ["autoInputStreamFn", "autoInputStream"],
  ["stopAutoInputFn", "stopAutoInput"],
  ["readVarFn", "readVar"],
  ["mapIdFn", "mapId"],
  ["specialOrder", "specialOrder"],
  ["specials", "specials"],
  ["healPartyFn", "healParty"],
  ["healAnimFn", "healAnim"],
  ["nameRivalFn", "nameRival"],
  ["warpToSpawnFn", "warpToSpawn"],
  ["showMoneyFn", "showMoney"],
  ["showCoinsFn", "showCoins"],
  ["openPcFn", "openPc"],
  ["openMartFn", "openMart"],
  ["lookupTrainerFn", "lookupTrainer"],
  ["startBattleFn", "startBattle"],
  ["catchTutorialFn", "catchTutorial"],
  ["reloadMapFn", "reloadMap"],
  ["badWarpFn", "badWarp"],
  ["encounterMusicFn", "encounterMusic"],
  ["showEmoteFn", "showEmote"],
  ["trainerApproachFn", "trainerApproach"],
  ["faceObjectFn", "faceObject"],
  ["followFn", "follow"],
  ["stopFollowFn", "stopFollow"],
  ["getMapSceneFn", "getMapScene"],
  ["getTimeOfDayFn", "getTimeOfDay"],
  ["gsVersionFn", "gsVersion"],
  ["getEngineFlagFn", "getEngineFlag"],
  ["setEngineFlagFn", "setEngineFlag"],
  ["readMemFn", "readMem"],
  ["writeMemFn", "writeMem"],
  ["writeVarFn", "writeVar"],
  ["callAsmFn", "callAsm"],
  ["appearFn", "appear"],
  ["moveObjectFn", "moveObject"],
  ["variableSpriteFn", "variableSprite"],
  ["loadEmoteFn", "loadEmote"],
  ["changeBlockFn", "changeBlock"],
  ["changeMapBlocksFn", "changeMapBlocks"],
  ["earthquakeFn", "earthquake"],
  ["warpToFn", "warpTo"],
  ["warpCheckFn", "warpCheck"],
  ["warpSoundFn", "warpSound"],
  ["newLoadMapFn", "newLoadMap"],
  ["writeCmdQueueFn", "writeCmdQueue"],
  ["delCmdQueueFn", "delCmdQueue"],
  ["setWarpModFn", "setWarpMod"],
  ["setBlackoutMapFn", "setBlackoutMap"],
  ["setSwarmFn", "setSwarm"],
  ["setWildEncountersFn", "setWildEncounters"],
  ["rollWildFn", "rollWild"],
  ["playMapMusicFn", "playMapMusic"],
  ["fadeOutMusicFn", "fadeOutMusic"],
  ["dontRestartMapMusicFn", "dontRestartMapMusic"],
  ["hasItemFn", "hasItem"],
  ["takeItemFn", "takeItem"],
  ["getMoneyFn", "getMoney"],
  ["setMoneyFn", "setMoney"],
  ["getCoinsFn", "getCoins"],
  ["setCoinsFn", "setCoins"],
  ["hasPokeFn", "hasPoke"],
  ["giveEggFn", "giveEgg"],
  ["givePokeMailFn", "givePokeMail"],
  ["checkPokeMailFn", "checkPokeMail"],
  ["getLandmarkNameFn", "getLandmarkName"],
  ["getTrainerClassNameFn", "getTrainerClassName"],
  ["getNameFn", "getName"],
  ["checkSaveFn", "checkSave"],
  ["openMenuFn", "openMenu"],
  ["fruitTreeItemFn", "fruitTreeItem"],
  ["fruitTreeResetFn", "fruitTreeReset"],
  ["fruitTreePickedFn", "fruitTreePicked"],
  ["fruitTreePickFn", "fruitTreePick"],
  ["describeDecorationFn", "describeDecoration"],
  ["decorationSlotFn", "decorationSlot"],
  ["npcTradeFn", "npcTrade"],
  ["elevatorFn", "elevator"],
  ["addPhoneNumberFn", "addPhoneNumber"],
  ["phoneCallFn", "phoneCall"],
  ["hangUpFn", "hangUp"],
  ["setSpecialCallFn", "setSpecialCall"],
  ["getSpecialCallFn", "getSpecialCall"],
  ["hallOfFameFn", "hallOfFame"],
  ["creditsFn", "credits"],
];

let SPECIALS_OVERRIDE: Record<string, (vm: Vm) => any> | undefined;

export class Vm {
  // Lua tables take any field; handlers (Specials, CallAsm, mods) hang their
  // own state on the VM (curPhoneCaller, btLevelGroup, ...).
  [key: string]: any;

  /** Vm.setCommands' module-level default for the mod verb registry. */
  static commands: any = undefined;

  /**
   * `special` handlers by SpecialsPointers label (Specials.ALL), read lazily
   * so the Vm <-> Specials import cycle cannot bite.  Lua: Vm.lua:2377
   */
  static get SPECIALS(): Record<string, (vm: Vm) => any> {
    return SPECIALS_OVERRIDE ?? Specials.ALL;
  }
  static set SPECIALS(v: Record<string, (vm: Vm) => any>) {
    SPECIALS_OVERRIDE = v;
  }

  scripts: Record<string, any>;
  movements: Record<string, number[]>;
  text: Record<string, any>;
  events: any;
  eventTables: Record<string, any>;
  scriptVar = 0;
  stringBuffer = "";
  busy = false;
  lastTalked: any = undefined;
  co: Coroutine | undefined = undefined;
  pending: VmRequest | undefined = undefined;
  nextOp: string | undefined = undefined;
  trainerObject: any = undefined;
  trainer: any = undefined;
  justBattled = false;
  lastSpecial: any = undefined;
  // Sparse WRAM store for readmem / writemem / loadmem.
  mem: Record<number, number> = {};
  // ENGINE_* flags, when nothing supplies getEngineFlag / setEngineFlag.
  engineFlags: Record<number, boolean> = {};
  // wVariableSprites: slot -> sprite byte.
  variableSprites: Record<number, number> = {};
  // The unknown-opcode and bad-byte ledgers.
  unknownOps: Record<string, number> = {};
  badBytes: Record<string, number> = {};
  // Every map callback that tried to block, by script key.
  blockedCallbacks: Record<string, any> = {};
  menuHeader: any = undefined;
  loadedEmote: any = undefined;
  lastTextKey: any = undefined;
  unusedScriptByte: any = undefined;
  xyComparePointer: any = undefined;
  specialCall: any = undefined;
  dontRestartMapMusic = false;
  wildEncounters = true;

  // Lua: Vm.lua:1893
  constructor(scripts?: any, text?: any, events?: any, hooks?: Record<string, any>) {
    hooks = hooks ?? {};
    this.scripts = scripts ?? {};
    this.movements = (scripts && scripts.movements) ?? hooks.movements ?? {};
    this.text = text ?? {};
    this.events = events;
    // events.json: the side tables a command NAMES (trades, floor labels,
    // decoration scripts) -- not wEventFlags.
    this.eventTables = hooks.eventTables ?? {};
    // Left ABSENT when the boot supplies none, so resolveVerb falls through
    // to the module-level Vm.setCommands default.
    if (hooks.commands != null) this.commands = hooks.commands;
    for (const [field, hook] of HOOK_FIELDS) {
      if (hooks[hook] != null) this[field] = hooks[hook];
    }
  }

  static new(scripts?: any, text?: any, events?: any, hooks?: Record<string, any>): Vm {
    return new Vm(scripts, text, events, hooks);
  }

  // The sparse WRAM store for the save file: address -> byte, zeroes
  // dropped.  Lua: Vm.lua:2108
  serializeMem(): Record<number, number> {
    const out: Record<number, number> = {};
    for (const addr of Object.keys(this.mem)) {
      const value = this.mem[Number(addr)]!;
      if (value !== 0) out[Number(addr)] = value;
    }
    return out;
  }

  // Lua: Vm.lua:2116
  restoreMem(bytes: unknown): this {
    if (typeof bytes !== "object" || bytes === null) return this;
    this.mem = {};
    for (const [addr, value] of Object.entries(bytes as Record<string, unknown>)) {
      // A serialized file can hand these back as strings.
      const index = tonumber(addr), byte = tonumber(value);
      if (index != null && byte != null) this.mem[index] = mod(byte, 256);
    }
    return this;
  }

  // The unknown-opcode ledger: warn once per opcode name.  Lua: Vm.lua:2131
  noteUnknownOp(op: any): void {
    if (op == null) return;
    if (this.unknownOps[op]) {
      this.unknownOps[op] = this.unknownOps[op]! + 1;
      return;
    }
    this.unknownOps[op] = 1;
    Logger.warn("gen2 script: unimplemented opcode '%s' skipped", tostring(op));
  }

  // Lua: Vm.lua:2144
  noteBadJump(name: string): void {
    this.badJumps = this.badJumps ?? {};
    if (this.badJumps[name]) return;
    this.badJumps[name] = true;
    Logger.warn("gen2 script: script.command returned label '%s'; "
      + "this VM has no labels, falling through", tostring(name));
  }

  // ---- the mod verb table (contract: Vm.lua:2152-2197) ------------------
  //
  // A mod row is `{ op = "modcommand", verb = "mymod:shake", args = { 4, 2 } }`
  // or the Gen 1 row `{ "mymod:shake", 4, 2 }`; the verb resolves against the
  // `commands` registry (a bare function or { fn, foreground, blocking }).
  // The handler is called as fn(ctx, ...args); it may be a generator (it
  // yields exactly the way a command does), and its return value speaks
  // runCmd's vocabulary: "end", a 1-based row number, or nil.

  // Lua: Vm.lua:2198
  static setCommands(source: any): any {
    Vm.commands = source;
    return source;
  }

  // Lua: Vm.lua:2214
  resolveVerb(verb: unknown): [any, any] | [] {
    const source = this.commands !== undefined ? this.commands : Vm.commands;
    if (source == null || typeof verb !== "string") return [];
    let record;
    if (typeof source === "function") {
      record = source(verb);
    } else {
      record = source[verb];
    }
    if (typeof record === "object" && record !== null) return [record.fn, record];
    if (typeof record === "function") return [record, undefined];
    return [];
  }

  // pcall, and keep going: one bad mod row must not make Gold unplayable.
  // Lua: Vm.lua:2228
  *runModCommand(cmd: any): Script<any> {
    const verb = cmd.verb ?? cmd[0];
    const [fn] = this.resolveVerb(verb);
    if (typeof fn !== "function") {
      this.noteUnknownVerb(verb);
      return undefined;
    }
    try {
      let jump = fn(this.scriptCtx(), ...modArgs(cmd));
      if (isScript(jump)) jump = yield* jump;
      return jump;
    } catch (err) {
      this.noteFailedVerb(verb, err);
      return undefined;
    }
  }

  // Lua: Vm.lua:2252
  noteUnknownVerb(verb: unknown): void {
    const name = tostring(verb);
    this.unknownVerbs = this.unknownVerbs ?? {};
    if (this.unknownVerbs[name]) {
      this.unknownVerbs[name] = this.unknownVerbs[name] + 1;
      return;
    }
    this.unknownVerbs[name] = 1;
    Logger.warn("gen2 script: no command '%s' in the commands registry; "
      + "row skipped", name);
  }

  // Lua: Vm.lua:2270
  noteFailedVerb(verb: unknown, err: unknown): void {
    const name = tostring(verb);
    this.failedVerbs = this.failedVerbs ?? {};
    const m = /^([^:]+):/.exec(name);
    if (m) Runtime.reportError(m[1], name + ": " + tostring(err));
    if (this.failedVerbs[name]) return;
    this.failedVerbs[name] = tostring(err);
    Logger.error("gen2 script: command '%s' failed: %s", name, tostring(err));
  }

  // ---- the mod-facing script lifecycle ------------------------------------

  // The per-run ctx, memoised.  Lua: Vm.lua:2300
  scriptCtx(): Record<string, any> {
    const ctx = this.ctx;
    if (ctx) return ctx;
    let group, number;
    if (this.readVarFn) {
      group = this.readVarFn(VAR_MAPGROUP);
      number = this.readVarFn(VAR_MAPNUMBER);
    }
    const built = {
      vm: this,
      generation: 2,
      scriptKey: this.ctxKey,
      kind: this.ctxKind ?? "script",
      mapId: orv(this.mapIdFn && this.mapIdFn(),
        truthy(group) ? format("%d:%d", group, number ?? 0) : undefined),
      mapGroup: group,
      mapNumber: number,
      object: this.lastTalked,
    };
    this.ctx = built;
    return built;
  }

  // Lua: Vm.lua:2342
  emitScriptEnded(completed: unknown): void {
    if (Runtime.wants("script.ended")) {
      Runtime.emit("script.ended",
        { ctx: this.scriptCtx(), completed: truthy(completed) });
    }
    this.ctx = undefined;
  }

  // The `trainer` struct only stores class + member; the roster comes from
  // trainers.json through the World.  Lua: Vm.lua:2352
  lookupTrainer(clazz: any, member: any): any {
    if (!(truthy(clazz) && truthy(member))) return undefined;
    if (!this.lookupTrainerFn) return { class: clazz, member };
    const record = this.lookupTrainerFn(clazz, member);
    if (!truthy(record)) {
      const key = tostring(clazz) + "/" + tostring(member);
      this.missingTrainers = this.missingTrainers ?? {};
      if (!this.missingTrainers[key]) {
        this.missingTrainers[key] = true;
        Logger.warn("gen2 trainer class %s member %s is not in the roster",
          tostring(clazz), tostring(member));
      }
    }
    return record;
  }

  // specialOrder is the importer's 0-based array, so Lua's order[id + 1] is
  // order[id].  Lua: Vm.lua:2379
  specialName(id: any): string | undefined {
    const order = this.specialOrder;
    if (!order || id == null) return undefined;
    return order[id];
  }

  // Lua: Vm.lua:2385
  *runSpecial(id: any, _cmd?: any): Script<void> {
    const name = this.specialName(id);
    const handler = name ? Vm.SPECIALS[name] : undefined;
    this.lastSpecial = name ?? id;
    if (handler) {
      const r = handler(this);
      if (isScript(r)) yield* r;
    }
  }

  // wStringBuffer2 in one place.  Lua: Vm.lua:2396
  setStringBuffer(value: any): void {
    this.stringBuffer = orv(value, "");
    if (this.setStringBufferFn) this.setStringBufferFn(this.stringBuffer);
  }

  // CurItemName (engine/overworld/scripting.asm:507): wCurItem only.
  // Lua: Vm.lua:2407
  curItemName(): string {
    if (!(this.getItemNameFn && this.curItem != null)) return "";
    return orv(this.getItemNameFn(this.curItem), "");
  }

  // GetPocketName (engine/overworld/scripting.asm:488).  Lua: Vm.lua:2415
  pocketName(item: any): string {
    const pocket = this.getItemPocketFn && item != null ? this.getItemPocketFn(item) : undefined;
    return POCKET_NAMES[pocket] ?? POCKET_NAMES.ITEM!;
  }

  // Lua: Vm.lua:2420
  emitFace(doFace: boolean): void {
    if (doFace && this.facePlayerFn) this.facePlayerFn();
  }

  // The next command is the cart's YES/NO prompt.  Lua: Vm.lua:2429
  textStays(): boolean {
    return this.nextOp === "yesorno";
  }

  // ../pokecrystal/engine/overworld/scripting.asm:374 Script_promptbutton
  // Lua: Vm.lua:2434
  textArrows(): boolean {
    return this.nextOp === "promptbutton";
  }

  // A literal page.  `stay` holds the box over a non-yesorno command, `hold`
  // is a folded cart `pause` in frames, `sfxWait` is Script_specialsound's
  // WaitSFX (pokegold engine/overworld/scripting.asm:485).  Lua: Vm.lua:2451
  *showRaw(body?: string, stay?: any, hold?: number, sfxWait?: any): Script<void> {
    if (!body || body === "") body = "...";
    if (this.stringBuffer && this.stringBuffer !== "") {
      body = body.split("{STRBUF}").join(this.stringBuffer);
    }
    if (this.showTextFn) {
      yield {
        kind: "text",
        text: body,
        stay: truthy(stay) || this.textStays(),
        hold,
        sfxWait: truthy(sfxWait) ? true : undefined,
        arrows: this.textArrows(),
      };
    }
  }

  // Lua: Vm.lua:2469
  *showText(textKey?: any): Script<void> {
    let body = textKey != null ? this.text[textKey] : undefined;
    // wScriptTextAddr: JumpTextScript's `repeattext -1, -1` prints it.
    if (textKey != null) this.lastTextKey = textKey;
    if (!body || body === "") body = "...";
    if (this.stringBuffer && this.stringBuffer !== "") {
      // Only the {STRBUF} marker reads the (stale by design) buffer.
      body = String(body).split("{STRBUF}").join(this.stringBuffer);
    }
    if (this.showTextFn) {
      yield { kind: "text", text: body, stay: this.textStays(),
        arrows: this.textArrows() };
    }
  }

  // A wait SUSPENDS the script: it yields and Vm:resume parks the count in
  // waitLeft, which Vm:update spends.  Lua: Vm.lua:2494
  *waitFrames(n?: number): Script<void> {
    if (n != null && n > 0) {
      yield { kind: "wait", frames: n };
    }
  }

  // Script_pause: two frames per unit.  Lua: Vm.lua:2505
  *pauseFrames(n?: number): Script<void> {
    yield* this.waitFrames(Vm.pauseLength(n));
  }

  // Lua: Vm.lua:2512
  static pauseLength(n?: number): number {
    return (n ?? 0) * 2;
  }

  // Lua: Vm.lua:2516
  running(): boolean {
    return this.busy;
  }

  // Lua: Vm.lua:2520
  start(scriptKey: any): boolean {
    if (this.busy || !truthy(scriptKey)) return false;
    if (typeof scriptKey !== "object" && !this.scripts[scriptKey]) {
      return false;
    }
    this.busy = true;
    this.scriptVar = 0;
    // wRunningTrainerBattleScript and the win/loss overrides are per-run.
    this.justBattled = false;
    this.battleOutcome = undefined;
    this.winTextOverride = undefined;
    this.lossTextOverride = undefined;
    this.winLossArmed = undefined;
    // The whiteout abort is per-run too.
    this.aborted = false;
    this.ctx = undefined;
    this.ctxKey = scriptKey;
    this.ctxKind = "script";
    if (Runtime.wants("script.started")) {
      Runtime.emit("script.started", { ctx: this.scriptCtx() });
    }
    this.co = Coroutine.create(() => runList(this, scriptKey));
    this.resume();
    return true;
  }

  // ExecuteCallbackScript (home/map.asm): runnable while the VM is busy; the
  // parked coroutine and its request are the saved stack frame.  wScriptVar
  // is deliberately NOT saved.  Lua: Vm.lua:2573
  runCallback(scriptKey: any): boolean {
    if (!truthy(scriptKey)) return false;
    if (typeof scriptKey !== "object" && !this.scripts[scriptKey]) {
      return false;
    }
    const parent = {
      busy: this.busy, co: this.co, pending: this.pending,
      waitLeft: this.waitLeft,
      waitSfx: this.waitSfx, waitSfxLeft: this.waitSfxLeft,
      ctx: this.ctx, ctxKey: this.ctxKey, ctxKind: this.ctxKind,
    };
    this.busy = true;
    this.co = undefined;
    this.pending = undefined;
    this.waitLeft = undefined;
    this.waitSfx = undefined;
    this.waitSfxLeft = undefined;
    const abortedBefore = this.aborted;
    this.aborted = false;
    this.ctx = undefined;
    this.ctxKey = scriptKey;
    this.ctxKind = "callback";
    if (Runtime.wants("script.started")) {
      Runtime.emit("script.started", { ctx: this.scriptCtx() });
    }
    const co = Coroutine.create(() => runList(this, scriptKey));
    const [ok, req] = co.resume();
    const finished = ok && co.status() === "dead";
    this.emitScriptEnded(finished);
    this.busy = parent.busy;
    this.co = parent.co;
    this.pending = parent.pending;
    this.waitLeft = parent.waitLeft;
    this.waitSfx = parent.waitSfx;
    this.waitSfxLeft = parent.waitSfxLeft;
    this.aborted = abortedBefore;
    this.ctx = parent.ctx;
    this.ctxKey = parent.ctxKey;
    this.ctxKind = parent.ctxKind;
    if (!ok) throw req;
    if (!finished) {
      this.noteBlockedCallback(scriptKey, req);
      return false;
    }
    return true;
  }

  // Lua: Vm.lua:2622
  noteBlockedCallback(scriptKey: any, req: any): void {
    const key = tostring(typeof scriptKey === "object" ? "table" : scriptKey);
    this.blockedCallbacks = this.blockedCallbacks ?? {};
    if (this.blockedCallbacks[key]) return;
    this.blockedCallbacks[key] = (req && req.kind) ?? true;
    Logger.warn("gen2 map callback '%s' blocked on '%s'; abandoned",
      key, tostring((req && req.kind) ?? "?"));
  }

  // RunSceneScript's tail (engine/overworld/events.asm:414-429).
  // Lua: Vm.lua:2636
  runDeferred(): boolean {
    const script = this.deferred;
    this.deferred = undefined;
    if (!truthy(script) || this.aborted) return false;
    return this.start(script);
  }

  // Lua: Vm.lua:2643
  resume(resumeValue?: any): void {
    if (!this.co) return;
    const co = this.co;
    const [ok, req] = co.resume(resumeValue);
    if (!ok) {
      this.busy = false;
      this.co = undefined;
      this.emitScriptEnded(false);
      throw req;
    }
    if (co.status() === "dead") {
      this.busy = false;
      this.co = undefined;
      this.pending = undefined;
      // Emitted BEFORE runDeferred, which starts a whole new run.
      this.emitScriptEnded(!this.aborted);
      this.runDeferred();
      return;
    }
    this.pending = req;
    if (req && req.kind === "text" && this.showTextFn) {
      this.showTextFn(req.text, () => {
        this.resume();
      }, req.stay, req.hold, req.sfxWait, req.arrows);
    } else if (req && req.kind === "wait") {
      this.waitLeft = req.frames ?? 0;
    } else if (req && req.kind === "waitbutton") {
      // Only yielded when the hook exists.
      this.waitButtonFn(() => this.resume());
    } else if (req && req.kind === "yesorno" && this.yesornoFn) {
      this.yesornoFn((yes: any) => {
        this.resume(truthy(yes));
      });
    } else if (req && req.kind === "move" && this.applyMovementFn) {
      this.applyMovementFn(req.object, req.bytes, () => {
        this.resume();
      });
    } else if (req && req.kind === "waitsfx") {
      // home/audio.asm:225
      this.waitSfx = true;
      const cap = this.waitSfxCapFn ? this.waitSfxCapFn() : undefined;
      this.waitSfxLeft = Math.max(orv(cap, 180), 1);
    } else if (req && req.kind === "battle") {
      if (this.startBattleFn) {
        this.startBattleFn(req.trainer, req.wild, (outcome: any) => {
          this.resume(outcome);
        });
      } else {
        this.resume("win");
      }
    } else if (req && req.kind === "catchtutorial") {
      // Only reached when the hook exists.
      this.catchTutorialFn(req.wild, req.battleType, () => {
        this.resume();
      });
    } else if (req && req.kind === "mart") {
      if (this.openMartFn) {
        this.openMartFn(req.martType, req.martId, () => this.resume());
      } else {
        this.resume();
      }
    } else if (req && req.kind === "approach") {
      this.trainerApproachFn(() => this.resume());
    } else if (req && req.kind === "menu") {
      // Resumed with the 1-based index (0 or nil for B); with no hook the
      // script takes the cancel arm.
      if (this.openMenuFn) {
        this.openMenuFn(req.header, req.style, (choice: any) => {
          this.resume(choice);
        });
      } else {
        this.resume(0);
      }
    } else if (req && req.kind === "pokemail") {
      this.checkPokeMailFn(req.mail, (answer: any) => this.resume(answer));
    } else if (req && req.kind === "trade") {
      this.npcTradeFn(req.trade, () => this.resume());
    } else if (req && req.kind === "elevator") {
      this.elevatorFn(req.floors, (rode: any) => this.resume(rode));
    } else if (req && req.kind === "phonecall") {
      this.phoneCallFn(req.caller, () => this.resume());
    } else if (req && req.kind === "halloffame") {
      this.hallOfFameFn(() => this.resume());
    } else if (req && req.kind === "credits") {
      this.creditsFn(() => this.resume());
    }
  }

  // Lua: Vm.lua:2741
  update(): void {
    if (!this.busy) return;
    if (this.waitLeft && this.waitLeft > 0) {
      this.waitLeft = this.waitLeft - 1;
      if (this.waitLeft <= 0) {
        this.waitLeft = undefined;
        this.resume();
      }
      return;
    }
    if (this.waitSfx) {
      let done: any = true;
      if (this.waitSfxFn) {
        done = this.waitSfxFn();
      }
      if (this.waitSfxLeft) {
        this.waitSfxLeft = this.waitSfxLeft - 1;
        if (this.waitSfxLeft <= 0) done = true;
      }
      if (truthy(done)) {
        this.waitSfx = undefined;
        this.waitSfxLeft = undefined;
        this.resume();
      }
    }
  }
}

export default Vm;
