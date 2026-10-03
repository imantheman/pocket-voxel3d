// The `special` command's handlers (data/events/special_pointers.asm).
// A port of gen1recomp src/script/gen2/Specials.lua at bdfac727 (MIT).
//
// Lifted out of Vm because the two are different kinds of code: the VM is one
// interpreter with a shared control flow, and this is 169 INDEPENDENT routines
// that happen to share a dispatch table.
//
// Dispatch is by NAME.  The script byte is an index into SpecialsPointers,
// which the extractor turns into constants.specialOrder, and Vm.specialName
// resolves the one into the other; keying on the label rather than the number
// means a repointed table cannot silently call the wrong routine.  A Gold
// cache's order has 112 rows and a Crystal one 169.
//
// Three kinds of entry live here:
//
//   HANDLERS  the routine, ported.  Most read or write wScriptVar, so each
//             takes the Vm and leaves its answer in `vm.scriptVar`, exactly
//             as the asm leaves it in wScriptVar.
//   STUBS     deliberately out of scope, with the reason written down and a
//             SANE return rather than a fall-through.  Everything link cable,
//             Mystery Gift and the printer is here.
//   ALL       the merge, which is what Vm.SPECIALS is.  The two sets are
//             disjoint by construction.
//
// Everything a handler needs from the game is one call into `vm.specials`, the
// hook table World.specialHooks builds.  A handler with no hooks at all still
// runs and still leaves the right wScriptVar: that is what makes the whole
// table testable headless.
//
// BLOCKING.  A handler runs INSIDE the VM's script generator (Lua: coroutine),
// so it may yield, and Specials.block below is how it parks on a screen: the
// async work is started first and the generator only yields if the callback
// has not already fired, which is what lets the same handler work against a
// real pushed screen and against a test stub that answers on the spot.  The
// parked yield carries a kind Vm.resume does not recognise, deliberately: it
// means "nothing to do, wait", and the screen's own callback is the only thing
// that can start the script again.
//
// Port conventions (docs/gold-engine.md):
//   * a Lua function that yields, directly or transitively, is a generator
//     here and every call to it is `yield*`;
//   * Lua multiple returns come back as a tuple array (`multi()` below reads
//     a hook's or module's answer either way);
//   * party / move lists are JS arrays (0-based), but the indices hooks hand
//     back (selectPartyMon, chooseMoveToDelete, scriptMenu) stay Lua's 1-based
//     ones, and box numbers / game ids keep their game values.

// Two cart tables this file USES but must not re-transcribe.  Each already has
// exactly one home, and a second copy here is how the pair drift apart:
//   Happiness  data/events/happiness_changes.asm, plus ChangeHappiness's tier
//              pick, its two carry clamps and its `cp EGG / ret z`.
//   Roamers    InitRoamMons' three wRoamMon structs, plus the roam walk.
//   BugContest data/wild/bug_contest_mons.asm, ContestScore's tally, the ten
//              contestants and the podium, plus the twenty minute clock.
//   Apricorns  data/items/apricorn_balls.asm and FindApricornsInBag's walk.
import { LINK_WAIT_FRAMES, type CableClub } from "../core/CableClub.ts";
import { TimeCapsule } from "../core/TimeCapsule.ts";
import { Apricorns } from "../core/Apricorns.ts"; // Lua: Specials.lua:53
import { BugContest } from "../core/BugContest.ts";
import { GameVersion } from "../shared/core/GameVersion.ts";
import { Happiness } from "../core/Happiness.ts";
import { Phone } from "../core/Phone.ts";
import { Pokerus } from "../core/Pokerus.ts";
import { Strings } from "../shared/core/Strings.ts";
import { Roamers } from "../core/Roamers.ts";
import { Unown } from "../core/Unown.ts";
// Lazy in-function requires in the Lua; static here (nothing is used at
// module top level, so the cycles are harmless).
import { Breeding } from "../core/Breeding.ts";
import { CommonText } from "../core/CommonText.ts";
import { Clock } from "../core/Clock.ts";
import { Mon } from "../battle/Mon.ts";
import { GbcPalette } from "../shared/render/GbcPalette.ts";
import { TrainerHouse } from "../world/TrainerHouse.ts";
import { MysteryGift } from "../core/MysteryGift.ts";
import { EventPokemon } from "../core/EventPokemon.ts";
import { EVENT_OT } from "../../eventmons.ts";
import { Bag } from "../shared/inventory/Bag.ts";
import { crystal_story } from "./specials/crystal_story.ts";
import { battle_tower } from "./specials/battle_tower.ts";
import { crystal_extras } from "./specials/crystal_extras.ts";
import { unown_words } from "./specials/unown_words.ts";
import { format, idiv, mod, removeAt, sub, tonumber, tostring, truthy } from "../platform/lua.ts";
import { random } from "../platform/rng.ts";
import { osDate } from "../platform/clock.ts";
import type { Script, Vm } from "./Vm.ts";
// A value import, but only ever touched inside functions (Vm.ts imports this).
import { Coroutine } from "./Vm.ts";

/** One `special` routine: plain, or a generator the VM runs with `yield*`. */
export type SpecialHandler = (vm: Vm) => any;

type Hooks = Record<string, any>;
// Save records, party mons and data tables belong to modules still being
// ported; their shapes are Brian's and are not re-declared here.
type Rec = any;

// constants/script_constants.asm
const TRUE = 1; // Lua: Specials.lua:66
const FALSE = 0;

// constants/pokemon_constants.asm, for the handlers that name a species.
const MAGIKARP = "MAGIKARP"; // Lua: Specials.lua:69
const SHUCKLE = "SHUCKLE";

// constants/misc_constants.asm GBCHECK_*: what GameboyCheck answers.
const GBCHECK_GB = 0; // Lua: Specials.lua:73
const GBCHECK_SGB = 1;
const GBCHECK_CGB = 2;

/** Lua `a or b or ...`: the first truthy operand, else the last. */
function lor(...v: any[]): any {
  for (let i = 0; i < v.length - 1; i++) if (truthy(v[i])) return v[i];
  return v[v.length - 1];
}

/** A Lua multiple return, as the ported callee hands it back (a tuple array). */
function multi(v: unknown): any[] {
  return Array.isArray(v) ? v : [v];
}

/** Lua's type() names, for the merge's error text. */
function luaType(v: unknown): string {
  if (v === undefined || v === null) return "nil";
  if (typeof v === "object") return "table";
  return typeof v;
}

//--------------------------------------------------------------------------
// Plumbing
//--------------------------------------------------------------------------

// Lua: Specials.lua:88
function hooks(vm: Vm | undefined): Hooks {
  return lor(vm && vm.specials, {});
}

// Park the script on `start`, which must call its `done` exactly once.
//
// The order matters.  `start` runs FIRST, while the generator is still on the
// stack, so a hook that answers synchronously (a test stub) sets `finished`
// before the yield is ever reached and the handler simply carries on --
// resuming a coroutine that is not suspended would be an error.  A hook that
// answers later leaves the script parked on a yield nothing in Vm.resume
// claims, and its own callback is what resumes it.
// Lua: Specials.lua:100
function* block(vm: Vm, start: (done: (value?: any) => void) => void): Script<any> {
  let finished = false;
  let answer: any = undefined;
  start((value?: any) => {
    answer = value;
    finished = true;
    if (vm.co && vm.co.status() === "suspended") {
      vm.resume(value);
    }
  });
  if (finished) return answer;
  return yield { kind: "specialwait" };
}

// Print a page whose very next act is this handler's OWN `yesorno`.
//
// Vm's one-command lookahead (Vm.textStays) is what keeps a text box standing
// under a YES/NO prompt, but it reads the SCRIPT LIST: inside a hand-ported
// special the row being run is the `special` itself, so the lookahead is
// blind to a prompt this file raises.  Answering it for the length of one page
// is what the cart does anyway -- `PrintText / call YesNoBox` with nothing in
// between, and each of these texts ends in `done`, so DoneText returns with no
// PromptButton (home/text.asm:484) and YesNoBox goes straight up over the box.
// Lua: Specials.lua:125
function* showRawHeld(vm: Vm, body: string): Script<void> {
  const nextOp = vm.nextOp;
  vm.nextOp = "yesorno";
  yield* vm.showRaw(body);
  vm.nextOp = nextOp;
}

// The party, as the handlers see it.  wPartyMon* is one array on the cart and
// one list here, and every routine below that walks it walks this.
// Lua: Specials.lua:134
function party(vm: Vm): Rec[] {
  const h = hooks(vm);
  return lor(h.party && h.party(), []);
}

// Lua: Specials.lua:139
function save(vm: Vm): Rec {
  const h = hooks(vm);
  return h.save ? lor(h.save(), undefined) : undefined;
}

// Lua: Specials.lua:144
function data(vm: Vm): Rec {
  const h = hooks(vm);
  return h.data ? lor(h.data(), undefined) : undefined;
}

// wScriptVar, spelled the way the asm spells it so a handler reads as its
// source: `ld a, TRUE / ld [wScriptVar], a`.
// Lua: Specials.lua:151
function answer(vm: Vm, value: any): void {
  vm.scriptVar = lor(value, 0);
}

// WaitSFX (pokegold home/audio.asm); a test stub that calls a handler off
// the coroutine has no sfx to drain.
// Lua: Specials.lua:157
function* drainSfx(): Script<void> {
  if (Coroutine.running()) yield { kind: "waitsfx" };
}

// Every routine that ends `call GetPokemonName / jp
// CopyPokemonName_Buffer1_Buffer3` puts a name where the next writetext's
// {STRBUF} will find it.
// Lua: Specials.lua:164
function nameMon(vm: Vm, species: any): void {
  const h = hooks(vm);
  let name = h.monName ? h.monName(species) : undefined;
  if (!truthy(name) && typeof species === "string") name = species;
  if (truthy(name)) vm.setStringBuffer(name);
}

// SelectMonFromParty: the carry flag is "the player pressed B".  `onDone` gets
// (index, mon) or (nil, nil), and the handler blocks on it.  Returns the
// 1-based index and the mon as a pair.
// Lua: Specials.lua:173
function* selectMon(vm: Vm, prompt: string): Script<[any, any]> {
  const h = hooks(vm);
  if (!h.selectPartyMon) return [undefined, undefined];
  let picked = yield* Specials.block(vm, (done) => {
    h.selectPartyMon(prompt, (index: any, mon: any) => {
      done({ index, mon });
    });
  });
  picked = lor(picked, {});
  return [picked.index, picked.mon];
}

//--------------------------------------------------------------------------
// Magikarp lengths (engine/events/magikarp.asm)
//--------------------------------------------------------------------------

// MagikarpLengths (data/events/magikarp_lengths.asm): fourteen `dwb` triplets
// of "threshold word, divisor byte".  Not extracted -- nothing in the ROM's
// script bytecode points at it -- so it is transcribed beside the arithmetic
// that reads it, in the file's own order.
// Lua: Specials.lua:207
const MAGIKARP_LENGTHS: Array<[number, number]> = [
  [110, 1], // not used unless the .BCLessThanDE bug is fixed
  [310, 2],
  [710, 4],
  [2710, 20],
  [7710, 50],
  [17710, 100],
  [32710, 150],
  [47710, 150],
  [57710, 100],
  [62710, 50],
  [64710, 20],
  [65210, 5],
  [65410, 2],
  [65510, 1], // not used
];

// `rrc` on one byte: an 8-bit rotate right, the bit that falls off coming back
// in at the top.
// Lua: Specials.lua:226
function rrc(byte: number | undefined): number {
  byte = mod(byte ?? 0, 256);
  return idiv(byte, 2) + mod(byte, 2) * 128;
}

// Lua: Specials.lua:231
function xorByte(a: number | undefined, b: number | undefined): number {
  a = mod(a ?? 0, 256);
  b = mod(b ?? 0, 256);
  let out = 0;
  let bit = 1;
  for (let i = 1; i <= 8; i++) {
    if (mod(a, 2) !== mod(b, 2)) out = out + bit;
    a = idiv(a, 2);
    b = idiv(b, 2);
    bit = bit * 2;
  }
  return out;
}

// CalcMagikarpLength (engine/events/magikarp.asm), transcribed rather than
// approximated, bug and all: the whole Lake of Rage guru sub-plot is this one
// number, and the bug is what makes long Magikarp rare.
//
//   bc = rrc(id_hi) ++ rrc(id_lo)  XOR  rrc(rrc(dv_hi)) ++ rrc(rrc(dv_lo))
//
// Then, walking MagikarpLengths with an index that starts at 2:
//   * bc < 10 is a special case: the length is bc + 190 mm
//   * otherwise the first row whose threshold's HIGH BYTE exceeds bc's high
//     byte wins.  That is .BCLessThanDE's bug -- `ret c / ret nc` makes the
//     low-byte comparison behind it dead code, so only b and d are compared --
//     and it is why `bc - de` underflows and the length lands where it does.
//   * the length is 100 * index + low_byte_of((bc - de) / divisor)
//   * falling off the end of the table is (bc - 65510) + 1600
//
// Both truncations are the cart's: Divide leaves a 32-bit quotient and the
// routine reads only hQuotient + 3, its LOW BYTE.
// Returns [feet, inches, mm] (Lua's three returns).
// Lua: Specials.lua:258
function magikarpLength(otId: number | undefined, dvWord: number | undefined): [number, number, number] {
  otId = mod(otId ?? 0, 65536);
  dvWord = mod(dvWord ?? 0, 65536);
  const b = xorByte(rrc(idiv(otId, 256)), rrc(rrc(idiv(dvWord, 256))));
  const c = xorByte(rrc(mod(otId, 256)), rrc(rrc(mod(dvWord, 256))));
  const bc = b * 256 + c;

  let mm: number | undefined;
  if (b === 0 && c < 10) {
    mm = bc + 190;
  } else {
    let index = 2;
    let de = 0;
    for (const row of Specials.MAGIKARP_LENGTHS) {
      de = row[0];
      if (b < idiv(de, 256)) {
        const dividend = mod(bc - de, 65536);
        mm = 100 * index + mod(idiv(dividend, row[1]), 256);
        break;
      }
      index = index + 1;
    }
    if (mm === undefined) mm = mod(bc - de, 65536) + 1600;
  }
  mm = mod(mm, 65536);

  // `hl = de * 10`, then a 254-step division: inches = mm * 10 / 254, i.e.
  // mm / 25.4.  `a` is one byte, so a length past 2550 inches wraps -- which
  // no reachable length does.
  const inches = mod(idiv(mm * 10, 254), 256);
  return [idiv(inches, 12), mod(inches, 12), mm];
}

// PrintMagikarpLength: PRINTNUM_LEFTALIGN over one byte each, with the ′ and ″
// glyphs (font codes $6e / $6f) between them.  Written as the plain ASCII pair
// because Font.split has no charmap entry for the two prime marks.
// Lua: Specials.lua:295
function magikarpLengthText(feet: number | undefined, inches: number | undefined): string {
  return format("%d'%d\"", lor(feet, 0), lor(inches, 0));
}

// The DV word CalcMagikarpLength is handed, out of the port's DV table:
// (attack << 12) | (defense << 8) | (speed << 4) | special, which is the
// MON_DVS pair's own layout.
// Lua: Specials.lua:303
function dvWord(dvs: any): number {
  if (typeof dvs === "number") return mod(dvs, 65536);
  if (typeof dvs !== "object" || dvs === null) return 0;
  return mod(dvs.attack ?? 0, 16) * 4096
    + mod(dvs.defense ?? 0, 16) * 256
    + mod(dvs.speed ?? 0, 16) * 16
    + mod(dvs.special ?? 0, 16);
}

//--------------------------------------------------------------------------
// The handlers
//--------------------------------------------------------------------------

// Null-prototype so a special named like an Object.prototype member can
// never read as defined (Lua tables have no inherited keys).
const H: Record<string, SpecialHandler> = Object.create(null); // Lua: Specials.lua:316

// ---- 0 WarpToSpawnPoint ---------------------------------------------------
// The whiteout warp, and the few scripted trips home that borrow it.
// Lua: Specials.lua:320
H.WarpToSpawnPoint = (vm: Vm) => {
  if (vm.warpToSpawnFn) vm.warpToSpawnFn();
};

// ---- 20-24 the Bug Catching Contest ---------------------------------------
//
// Every rule lives in core/BugContest and NOT here.  These five handlers plus
// BugContestJudging are the gate scripts' half of the system:
// Route35NationalParkGate's officer runs ContestDropOffMons, GiveParkBalls and
// SelectRandomBugContestContestants on the way in, and BugContestResultsScript
// runs BugContestJudging, ContestReturnMons and CheckPartyFullAfterContest on
// the way out.  The state is on the SAVE (save.bugContest), not the Vm: the
// cart's masked party and its park balls are in SRAM and survive a save
// mid-contest.

// The party as save.bugContest reads it.  The hooks hand back the same table
// the save holds, so this only fills in a save that has no `party` key at all.
// Lua: Specials.lua:338
function contestSave(vm: Vm): Rec {
  const record = save(vm);
  if (!truthy(record)) {
    // A VM built with no `save` hook at all (a headless test) still has a
    // party, and the mask has to go somewhere: the VM stands in for the save,
    // which is enough for every rule and nothing like enough to survive a
    // reload -- exactly what a cartridge with no SRAM would do.
    vm.contestSave = lor(vm.contestSave, { party: party(vm) });
    return vm.contestSave;
  }
  if (record.party == null) record.party = party(vm);
  return record;
}

// ContestDropOffMons: the party is not stored anywhere, it is MASKED -- the
// count is written down to 1 and the second species byte is replaced with the
// -1 terminator, so only the lead mon exists for the duration of the contest.
// `.fainted`: a lead mon with 0 HP refuses, and answers TRUE.
// Lua: Specials.lua:358
H.ContestDropOffMons = (vm: Vm) => {
  answer(vm, BugContest.dropOffMons(contestSave(vm)));
};

// ContestReturnMons: the count is RECOMPUTED by walking to the terminator, so
// a mon caught during the contest is still in slot 2 when the tail goes back.
// Lua: Specials.lua:365
H.ContestReturnMons = (vm: Vm) => {
  BugContest.returnMons(contestSave(vm));
};

// GiveParkBalls: BUG_CONTEST_BALLS is 20, wContestMon is cleared first, and the
// StartBugContestTimer it farcalls puts the twenty minutes on the clock.
// (Specials.BUG_CONTEST_BALLS is a getter below; Lua: Specials.lua:371.)
// Lua: Specials.lua:373
H.GiveParkBalls = (vm: Vm) => {
  BugContest.start(contestSave(vm));
};

// CheckPartyFullAfterContest: the mon caught in the contest goes into the
// party if there is room and into the current box if there is not.  wScriptVar
// is the three-way answer BugContestResults_DidNotLeaveMons branches on:
// BUGCONTEST_CAUGHT_MON 0, BUGCONTEST_BOXED_MON 1, BUGCONTEST_NO_CATCH 2.
// _CaughtAskNicknameText (data/text/common_2.asm:717), engine-printed so the
// extractor never reaches it.
// Lua: Specials.lua:384
const CONTEST_NICKNAME_PROMPT = Strings.source("Give a nickname to\nthe {STRBUF} you\nreceived?");

// GiveANickname_YesNo (engine/pokemon/caught_nickname.asm:123)
// Lua: Specials.lua:388
function* askNickname(vm: Vm, mon: Rec): Script<void> {
  nameMon(vm, mon.species);
  yield* showRawHeld(vm, Strings.get(CONTEST_NICKNAME_PROMPT));
  if (truthy(yield { kind: "yesorno" })) {
    // InitNickname (engine/pokemon/move_mon.asm:1787)
    const h = hooks(vm);
    const name = h.renameMon
      ? yield* Specials.block(vm, (done) => {
        h.renameMon(mon, done, { blank: true });
      })
      : undefined;
    // _InitString's blank test (home/string.asm:6-30)
    if (truthy(name) && String(name).replace(/ /g, "") !== "") mon.nickname = name;
  }
}

// Lua: Specials.lua:402
H.CheckPartyFullAfterContest = function* (vm: Vm): Script<void> {
  const [result, mon] = multi(BugContest.collectCaughtMon(contestSave(vm), Breeding.PARTY_SIZE));
  // GiveANickname_YesNo runs on both contest arms, party and box
  if (truthy(mon) && result !== BugContest.NO_CATCH) {
    yield* Specials.askNickname(vm, mon);
  }
  answer(vm, result);
};

// _BugContestJudging (engine/events/bug_contest/judging.asm): ContestScore over
// wContestMon, BugContest_JudgeContestants for the podium, then the three text
// pages -- third, second, first -- each followed by its score page and its
// placing jingle.  The placing is what BugContest_GetPlayersResult leaves in
// wScriptVar, and the gate script's three `ifequal`s are the prize branches.
//
// Authored here because nothing in the ROM's script bytecode points at
// ContestJudging_*Text: they hang off engine code.
// Lua: Specials.lua:423
const JUDGING = {
  third: Strings.source("Placing third was\n%s,\fwho caught a\n%s!"),
  second: Strings.source("Placing second was\n%s,\fwho caught a\n%s!"),
  first: Strings.source("This Bug-Catching\nContest winner is\f%s,\nwho caught a\n%s!"),
  score: Strings.source("The score was\n%d points!"),
  winningScore: Strings.source("The winning score\nwas %d points!"),
};

// SFX_1ST_PLACE / SFX_2ND_PLACE / SFX_3RD_PLACE, by their pokegold labels: the
// text_asm arm of each page plays one and waits for it.
// Lua: Specials.lua:434
const PLACE_SFX = ["Sfx_1stPlace", "Sfx_2ndPlace", "Sfx_3rdPlace"];

// Lua: Specials.lua:436
H.BugContestJudging = function* (vm: Vm): Script<void> {
  const record = contestSave(vm);
  const place = BugContest.runJudging(record);
  const state = lor(BugContest.state(record), {});
  const results = lor(state.results, {});
  const h = hooks(vm);
  // wPlayerName, which LoadContestantName copies straight out for ID 1.
  const playerName = record.player ? record.player.name : undefined;
  // LoadContestantName reads the winner ID, and GetPokemonName the species the
  // podium recorded, so a slot nobody filled prints nothing at all.
  const order = [
    { entry: results.third, page: JUDGING.third, score: JUDGING.score, sfx: PLACE_SFX[2] },
    { entry: results.second, page: JUDGING.second, score: JUDGING.score, sfx: PLACE_SFX[1] },
    { entry: results.first, page: JUDGING.first, score: JUDGING.winningScore, sfx: PLACE_SFX[0] },
  ];
  for (const row of order) {
    const entry = row.entry;
    if (truthy(entry)) {
      const who = BugContest.contestantName(data(vm), entry.id, playerName);
      const what = lor(h.monName && h.monName(entry.species), entry.species, "");
      yield* vm.showRaw(Strings.get(row.page, who, what));
      // pokegold engine/events/bug_contest/judging.asm:29-32
      yield* drainSfx();
      if (h.playSfxNamed) h.playSfxNamed(row.sfx);
      yield* vm.showRaw(Strings.get(row.score, lor(entry.score, 0)), undefined, undefined, true);
    }
  }
  answer(vm, place);
};

// ---- 25, 26 the Magikarp guru ---------------------------------------------

// CheckMagikarpLength's four answers, spelled out at the top of the routine:
//   3  a Magikarp that beats the record
//   2  a Magikarp the record still beats
//   1  B pressed in the party list
//   0  the mon picked is not a Magikarp
// Lua: Specials.lua:477
H.CheckMagikarpLength = function* (vm: Vm): Script<void> {
  const [, mon] = yield* selectMon(vm, "choose");
  if (!truthy(mon)) {
    answer(vm, 1);
    return;
  }
  if (mon.species !== MAGIKARP) {
    answer(vm, 0);
    nameMon(vm, mon.species);
    return;
  }
  const [feet, inches] = Specials.magikarpLength(mon.otId, Specials.dvWord(mon.dvs));
  vm.setStringBuffer(magikarpLengthText(feet, inches));
  const record = save(vm);
  const best = truthy(record) ? record.magikarpRecord : undefined;
  const total = lor(feet, 0) * 12 + lor(inches, 0);
  const bestTotal = truthy(best) ? lor(best.feet, 0) * 12 + lor(best.inches, 0) : 0;
  if (total <= bestTotal) {
    answer(vm, 2);
    return;
  }
  if (truthy(record)) {
    record.magikarpRecord = {
      feet,
      inches,
      name: record.player ? record.player.name : undefined,
    };
  }
  answer(vm, 3);
};

// MagikarpHouseSign: the record on the wall, in the string buffer for the
// writetext that follows.  A house nobody has beaten yet reads 0'00", which is
// what InitializeMagikarpHouse leaves behind.
// Lua: Specials.lua:511
H.MagikarpHouseSign = (vm: Vm) => {
  const record = save(vm);
  const best = truthy(record) ? record.magikarpRecord : undefined;
  vm.setStringBuffer(magikarpLengthText(best ? best.feet : undefined, best ? best.inches : undefined));
};

// ---- 27-29 the Pokecenter -------------------------------------------------
// Lua: Specials.lua:518
H.HealParty = (vm: Vm) => {
  if (vm.healPartyFn) vm.healPartyFn();
};

// The heal machine's light show, BLOCKING: LoadBallsOntoMachine holds 30
// frames per party ball and .FlashPalettes8Times ten more per flash, and the
// nurse's "thank you for waiting" must not come up over the machine still
// running.  wScriptVar carries the machine's location (`setval HEALMACHINE_*`
// right before the special): 0 Pokecenter, 1 Elm's lab, 2 Hall of Fame.
// Lua: Specials.lua:527
H.HealMachineAnim = function* (vm: Vm): Script<void> {
  if (!vm.healAnimFn) return;
  yield* Specials.block(vm, (done) => {
    vm.healAnimFn(vm.scriptVar ?? 0, done);
  });
};

// PokemonCenterPC (engine/events/pokecenter_pc.asm): the whose-PC top menu.
// The special only opens the screen (World.openPc pushes CenterPcMenu).  The
// asm never writes wScriptVar, so neither does this.
// Lua: Specials.lua:539
H.PokemonCenterPC = (vm: Vm) => {
  if (vm.openPcFn) vm.openPcFn();
};

// PlayersHousePC ends `ld a, c / ld [wScriptVar], a`, and _PlayersHousePC's c
// is TRUE for exactly one reason: the DECORATION menu moved something.  That
// is the branch behind it -- PlayersHousePCScript's `iftrue .Warp`, whose
// `warp NONE, 0, 0` reloads the room so the two decoration callbacks run again.
// Lua: Specials.lua:550
H.PlayersHousePC = function* (vm: Vm): Script<void> {
  const h = hooks(vm);
  if (!h.playersHousePc) {
    // No bedroom PC on this side (a test harness, or the Pokecenter hook only):
    // open what there is and answer the way a player who changed nothing does.
    answer(vm, FALSE);
    if (vm.openPcFn) vm.openPcFn();
    return;
  }
  const changed = yield* Specials.block(vm, (done) => {
    h.playersHousePc(done);
  });
  answer(vm, truthy(changed) ? TRUE : FALSE);
};

// ToggleDecorationsVisibility / ToggleMaptileDecorations
// (engine/overworld/decorations.asm), the two PLAYERS_HOUSE_2F map callbacks.
// Both rebuild the room from the eight wDeco* bytes.  Neither writes
// wScriptVar, and neither may block: a map callback is a nested script run.
// Lua: Specials.lua:574
H.ToggleDecorationsVisibility = (vm: Vm) => {
  const h = hooks(vm);
  if (h.toggleDecorationsVisibility) h.toggleDecorationsVisibility();
};

// Lua: Specials.lua:579
H.ToggleMaptileDecorations = (vm: Vm) => {
  const h = hooks(vm);
  if (h.toggleMaptileDecorations) h.toggleMaptileDecorations();
};

// ---- 30-32, 68-69 the Day Care --------------------------------------------
//
// All three doors are the same screen with a different `side`, and the model
// behind it is core/Breeding.  DayCareManOutside is the only one that writes
// wScriptVar (TRUE = the party was full, so the egg is kept and the script
// asks again), which is why the push carries its answer back.
// Lua: Specials.lua:590
function* dayCare(vm: Vm, side: string): Script<void> {
  const h = hooks(vm);
  if (!h.dayCare) {
    answer(vm, FALSE);
    return;
  }
  const value = yield* Specials.block(vm, (done) => {
    h.dayCare(side, done);
  });
  answer(vm, lor(value, FALSE));
}

// Lua: Specials.lua:602
H.DayCareMan = function* (vm: Vm): Script<void> {
  yield* dayCare(vm, "man");
};
H.DayCareLady = function* (vm: Vm): Script<void> {
  yield* dayCare(vm, "lady");
};
H.DayCareManOutside = function* (vm: Vm): Script<void> {
  yield* dayCare(vm, "outside");
};

// DayCareMon1 / DayCareMon2: not the conversation, just the "you left X here"
// line, the deposited mon's cry, and -- only when the OTHER side is occupied
// too -- the compatibility line about the pair.  Both texts live in
// data/text/common_2.asm and are printed by engine/pokemon/breeding.asm, so
// the extractor seeds its text walker at them by name (NAMED_TEXT); `line`
// prefers the cache's own characters and falls back to the transcription.
// Lua: Specials.lua:614
const DAY_CARE_LEFT: Record<string, { label: string; body: string }> = {
  man: { label: "_LeftWithDayCareManText", body: Strings.source("It's {STRBUF}\nthat was left with\nthe DAY-CARE MAN.") },
  lady: { label: "_LeftWithDayCareLadyText", body: Strings.source("It's {STRBUF}\nthat was left with\nthe DAY-CARE LADY.") },
};

// DayCareMonCompatibilityText's five verdicts, keyed by the string
// Breeding.compatibilityText hands back, in the ASM's own fall-through order.
// The name in {STRBUF} is the OTHER parent's.
// Lua: Specials.lua:628
const COMPATIBILITY: Record<string, { label: string; body: string }> = {
  brimming: { label: "_BreedBrimmingWithEnergyText", body: Strings.source("It's brimming with\nenergy.") },
  none: { label: "_BreedNoInterestText", body: Strings.source("It has no interest\nin {STRBUF}.") },
  cares: { label: "_BreedAppearsToCareForText", body: Strings.source("It appears to care\nfor {STRBUF}.") },
  friendly: { label: "_BreedFriendlyText", body: Strings.source("It's friendly with\n{STRBUF}.") },
  interest: { label: "_BreedShowsInterestText", body: Strings.source("It shows interest\nin {STRBUF}.") },
};

// The extracted string for one of the entries above, or its transcription.
// Lua: Specials.lua:642
function commonLine(vm: Vm, entry: { label: string; body: string } | undefined): string {
  if (!entry) return "";
  return lor(CommonText.get(vm ? vm.text : undefined, entry.label), Strings.get(entry.body));
}

// Lua: Specials.lua:648
function* dayCareMon(vm: Vm, side: string): Script<void> {
  const record = save(vm);
  const h = hooks(vm);
  const mine = lor(Breeding.side(record, side), {});
  const other = lor(Breeding.side(record, side === "man" ? "lady" : "man"), {});
  const mon = mine.mon;
  if (!truthy(mon)) return;
  const monName = (m: Rec): string => lor(m.nickname, m.name, m.species, "#MON");
  vm.setStringBuffer(monName(mon));
  yield* vm.showRaw(commonLine(vm, DAY_CARE_LEFT[side]));
  const index = h.monIndex ? h.monIndex(mon.species) : undefined;
  if (truthy(index) && vm.cryFn) vm.cryFn(index);
  // `bit DAYCARE*_HAS_MON_F / jr z, DayCareMonCursor`: with only one mon in
  // there the routine stops at the blinking cursor and says nothing else.
  if (!truthy(other.mon)) return;
  const value = Breeding.compatibility(data(vm), mon, other.mon);
  vm.setStringBuffer(monName(other.mon));
  yield* vm.showRaw(commonLine(vm, COMPATIBILITY[Breeding.compatibilityText(value)]));
}

// Lua: Specials.lua:671
H.DayCareMon1 = function* (vm: Vm): Script<void> {
  yield* dayCareMon(vm, "man");
};
H.DayCareMon2 = function* (vm: Vm): Script<void> {
  yield* dayCareMon(vm, "lady");
};

// ---- the Blackthorn move deleter -------------------------------------------
//
// MoveDeletion (engine/events/move_deleter.asm).  MoveDeletersHouse's own
// script is `faceplayer / opentext / special MoveDeletion / waitbutton /
// closetext`, so every PrintText below runs inside a textbox the caller
// already opened.  The asm never writes wScriptVar on any path, so this
// handler leaves vm.scriptVar exactly as `special` found it.
//
// data/text/common_3.asm, transcribed: the extractor does not reach the
// common banks.
// Lua: Specials.lua:688
const MOVE_DELETER_TEXT = {
  intro: Strings.source(
    "Um… Oh, yes, I'm\nthe MOVE DELETER.\fI can make #MON\n"
    + "forget moves.\fShall I make a\n#MON forget?"),
  declined: Strings.source("No? Come visit me\nagain."),
  whichMon: Strings.source("Which #MON?"),
  egg: Strings.source("An EGG doesn't\nknow any moves!"),
  onlyOneMove: Strings.source("That #MON knows\nonly one move."),
  whichMove: Strings.source("Which move should\nit forget, then?"),
  confirm: Strings.source("Oh, make it forget\n{STRBUF}?"),
  forgot: Strings.source("Done! Your #MON\nforgot the move."),
};

// ChooseMoveToDelete is its own screen (engine/pokemon/mon_menu.asm), not a
// textbox, so it goes through World like SelectMonFromParty does.  A mon with
// one move never reaches it: `.onlyonemove` is checked first.  Answers the
// 1-based move slot.
// Lua: Specials.lua:705
function* chooseMoveToDelete(vm: Vm, mon: Rec): Script<any> {
  const h = hooks(vm);
  if (!h.chooseMoveToDelete) return undefined;
  return yield* Specials.block(vm, (done) => {
    h.chooseMoveToDelete(mon, done);
  });
}

// Lua: Specials.lua:713
H.MoveDeletion = function* (vm: Vm): Script<void> {
  // engine/events/move_deleter.asm:2-4, PrintText then `call YesNoBox`.
  yield* showRawHeld(vm, Strings.get(MOVE_DELETER_TEXT.intro));
  const wantsToDelete = yield { kind: "yesorno" };
  if (!truthy(wantsToDelete)) {
    yield* vm.showRaw(Strings.get(MOVE_DELETER_TEXT.declined));
    return;
  }

  yield* vm.showRaw(Strings.get(MOVE_DELETER_TEXT.whichMon));
  const [, mon] = yield* selectMon(vm, "choose");
  if (!truthy(mon)) {
    yield* vm.showRaw(Strings.get(MOVE_DELETER_TEXT.declined));
    return;
  }

  // `ld a, [wCurPartySpecies] / cp EGG`: the port marks an egg slot with
  // `isEgg` instead of overwriting the species, so that is the flag this reads.
  if (truthy(mon.isEgg)) {
    yield* vm.showRaw(Strings.get(MOVE_DELETER_TEXT.egg));
    return;
  }

  if (lor(mon.moves, []).length <= 1) {
    yield* vm.showRaw(Strings.get(MOVE_DELETER_TEXT.onlyOneMove));
    return;
  }

  yield* vm.showRaw(Strings.get(MOVE_DELETER_TEXT.whichMove));
  const index = yield* chooseMoveToDelete(vm, mon);
  if (!truthy(index)) {
    yield* vm.showRaw(Strings.get(MOVE_DELETER_TEXT.declined));
    return;
  }

  const entry = mon.moves[index - 1];
  const d = data(vm);
  const def = entry && d && d.moves ? d.moves[entry.id] : undefined;
  vm.setStringBuffer(lor(def && def.name, entry && entry.id, "?"));
  // engine/events/move_deleter.asm:33-35, the same PrintText / YesNoBox pair.
  yield* showRawHeld(vm, Strings.get(MOVE_DELETER_TEXT.confirm));
  const reallyDelete = yield { kind: "yesorno" };
  if (!truthy(reallyDelete)) {
    yield* vm.showRaw(Strings.get(MOVE_DELETER_TEXT.declined));
    return;
  }

  // .DeleteMove: shifts every later move (and its PP) down one slot and
  // clears the last one, which is exactly what removing the array entry does
  // here -- `mon` is the live save.party reference selectMon handed back.
  removeAt(mon.moves, index);

  // `call WaitSFX / ld de, SFX_MOVE_DELETED / call PlaySFX / call WaitSFX`:
  // wait out whatever the YES/NO click left playing, then the deletion jingle,
  // then wait that out too before the last line prints.
  yield { kind: "waitsfx" };
  const h = hooks(vm);
  if (h.playSfxNamed) h.playSfxNamed("Sfx_MoveDeleted", 97);
  yield { kind: "waitsfx" };

  yield* vm.showRaw(Strings.get(MOVE_DELETER_TEXT.forgot));
};

// ---- the Goldenrod NAME RATER ----------------------------------------------
//
// NameRater (engine/events/name_rater.asm).  Like MoveDeletion, the caller's
// script is just `special NameRater` inside an already-open textbox, and the
// asm never writes wScriptVar.
//
// data/text/common_1.asm, transcribed.
// Lua: Specials.lua:789
const NAME_RATER_TEXT = {
  hello: Strings.source(
    "Hello, hello! I'm\nthe NAME RATER.\fI rate the names\nof #MON.\f"
    + "Would you like me\nto rate names?"),
  comeAgain: Strings.source("OK, then. Come\nagain sometime."),
  whichMon: Strings.source("Which #MON's\nnickname should I\vrate for you?"),
  egg: Strings.source("Whoa… That's just\nan EGG."),
  perfectName: Strings.source(
    "Hm… {STRBUF}?\nWhat a great name!\vIt's perfect.\fTreat {STRBUF}\n"
    + "with loving care."),
  betterName: Strings.source(
    "Hm… {STRBUF}…\nThat's a fairly\vdecent name.\fBut, how about a\n"
    + "slightly better\vnickname?\fWant me to give it\na better name?"),
  whatName: Strings.source("All right. What\nname should we\vgive it, then?"),
  finished: Strings.source("That's a better\nname than before!\fWell done!"),
  sameName: Strings.source(
    "It might look the\nsame as before,\fbut this new name\n"
    + "is much better!\fWell done!"),
  named: Strings.source("All right. This\n#MON is now\vnamed {STRBUF}."),
};

// IsNewNameEmpty: the typed name is empty if every character up to the
// terminator (or MON_NAME_LENGTH - 1) is a space -- a blank keyboard entry
// reads the same as a cancelled one.
// Lua: Specials.lua:813
function isBlankName(name: any): boolean {
  return !truthy(name) || /^\s*$/.test(name);
}

// Lua: Specials.lua:817
function* renameMon(vm: Vm, mon: Rec): Script<any> {
  const h = hooks(vm);
  if (!h.renameMon) return undefined;
  return yield* Specials.block(vm, (done) => {
    h.renameMon(mon, done);
  });
}

// CheckIfMonIsYourOT: the OT name AND the OT id both have to match, or the
// mon reads as traded.  A mon that has never changed hands carries no `ot` /
// `otId` at all (Mon.new sets neither), which this treats as "yours".
// Lua: Specials.lua:830
function isTradedMon(vm: Vm, mon: Rec): boolean {
  if (!truthy(mon)) return false;
  const record = save(vm);
  const player = truthy(record) ? record.player : undefined;
  if (!truthy(player)) return false;
  if (mon.ot != null && mon.ot !== player.name) return true;
  if (mon.otId != null && mon.otId !== player.id) return true;
  return false;
}

// Lua: Specials.lua:840
H.NameRater = function* (vm: Vm): Script<void> {
  // engine/events/name_rater.asm:3-5, PrintText then `call YesNoBox`.
  yield* showRawHeld(vm, Strings.get(NAME_RATER_TEXT.hello));
  const wantsToRate = yield { kind: "yesorno" };
  if (!truthy(wantsToRate)) {
    yield* vm.showRaw(Strings.get(NAME_RATER_TEXT.comeAgain));
    return;
  }

  yield* vm.showRaw(Strings.get(NAME_RATER_TEXT.whichMon));
  const [, mon] = yield* selectMon(vm, "choose");
  if (!truthy(mon)) {
    yield* vm.showRaw(Strings.get(NAME_RATER_TEXT.comeAgain));
    return;
  }

  // `cp EGG`, the same isEgg flag MoveDeletion checks above.
  if (truthy(mon.isEgg)) {
    yield* vm.showRaw(Strings.get(NAME_RATER_TEXT.egg));
    return;
  }

  // GetCurNickname puts the current name where {STRBUF} finds it before
  // either of the two texts below read it.
  const currentName = lor(mon.nickname, mon.name, mon.species, "?");
  vm.setStringBuffer(currentName);

  if (isTradedMon(vm, mon)) {
    yield* vm.showRaw(Strings.get(NAME_RATER_TEXT.perfectName));
    return;
  }

  // engine/events/name_rater.asm:21-23, the same PrintText / YesNoBox pair.
  yield* showRawHeld(vm, Strings.get(NAME_RATER_TEXT.betterName));
  const wantsRename = yield { kind: "yesorno" };
  if (!truthy(wantsRename)) {
    yield* vm.showRaw(Strings.get(NAME_RATER_TEXT.comeAgain));
    return;
  }

  yield* vm.showRaw(Strings.get(NAME_RATER_TEXT.whatName));
  const newName = yield* renameMon(vm, mon);

  // IsNewNameEmpty and CompareNewToOld both fall into `.samename`: an empty
  // entry or a re-typed copy of the old name is treated as "unchanged".
  const unchanged = isBlankName(newName) || newName === currentName;
  let finalName = currentName;
  if (!unchanged) {
    mon.nickname = newName;
    finalName = newName;
  }

  // `.samename` re-runs GetCurNickname (now the new name, on the changed
  // path) before NameRaterNamedText, then falls into whichever of
  // FinishedText / SameNameText applies.
  vm.setStringBuffer(finalName);
  yield* vm.showRaw(Strings.get(NAME_RATER_TEXT.named));
  if (unchanged) {
    yield* vm.showRaw(Strings.get(NAME_RATER_TEXT.sameName));
  } else {
    yield* vm.showRaw(Strings.get(NAME_RATER_TEXT.finished));
  }
};

// ---- 36 NameRival ---------------------------------------------------------
// engine/events/specials.asm NameRival: `farcall _NamingScreen` returns only
// when the keyboard closes, then InitName fills an empty wRivalName with the
// version default.  Before this special runs, wRivalName holds
// InitializeNPCNames' "???".  The script's very next writetext is the
// officer's "OK! So <RIVAL>" line, so the handler has to PARK on the screen.
// Lua: Specials.lua:914
H.NameRival = function* (vm: Vm): Script<void> {
  if (!vm.nameRivalFn) return;
  yield* Specials.block(vm, (done) => {
    vm.nameRivalFn(done);
  });
};

// ---- 37, 108-110 the clock ------------------------------------------------

// SetDayOfWeek (engine/rtc/timeset.asm:382): the "what day is it?" wheel Mom
// puts up with the POKeGEAR.  It BLOCKS until the player has picked a day and
// confirmed it.  The screen is InitClock's day mode; a run with no screen to
// push falls back to the host clock's own day.
// Lua: Specials.lua:927
H.SetDayOfWeek = function* (vm: Vm): Script<void> {
  const record = save(vm);
  if (!truthy(record)) return;
  const h = hooks(vm);
  let picked: any;
  if (h.setDayOfWeek) {
    picked = yield* Specials.block(vm, (done) => {
      h.setDayOfWeek(done);
    });
  }
  if (typeof picked !== "number") {
    Clock.setWeekday(record, Clock.hostWeekday());
  }
  record.rtc = lor(record.rtc, {});
  record.rtc.day = tonumber(osDate("%j")) ?? record.rtc.day;
};

// InitialSetDSTFlag / InitialClearDSTFlag (engine/rtc/timeset.asm): one bit
// in wDST, asked once during Mom's clock ladder.  Each routine also reprints
// the clock and puts its OWN confirmation into the open textbox, and the
// `yesorno` right after it in PlayersHouse1F's script reads THAT page.
// Lua: Specials.lua:951
function dstConfirmTime(vm: Vm): string {
  // PrintHoursMins reads hHours / hMinutes, which are the GAME clock.
  const record = save(vm);
  const w = hooks(vm).world;
  const hour = lor(w && w.hour && w.hour(), Clock.hour(record));
  return format("%d:%02d", hour, Clock.minute(record));
}

const DST_CONFIRM = Strings.source("%s DST,\nis that OK?"); // Lua: Specials.lua:961
const TIME_CONFIRM = Strings.source("%s,\nis that OK?");

// Lua: Specials.lua:964
H.InitialSetDSTFlag = function* (vm: Vm): Script<void> {
  const record = save(vm);
  if (truthy(record)) {
    record.rtc = lor(record.rtc, {});
    record.rtc.dst = true;
  }
  yield* vm.showRaw(Strings.get(DST_CONFIRM, dstConfirmTime(vm)));
};

// Lua: Specials.lua:973
H.InitialClearDSTFlag = function* (vm: Vm): Script<void> {
  const record = save(vm);
  if (truthy(record)) {
    record.rtc = lor(record.rtc, {});
    record.rtc.dst = false;
  }
  yield* vm.showRaw(Strings.get(TIME_CONFIRM, dstConfirmTime(vm)));
};

// MrChrono prints the raw RTC registers into the text box: a debug readout the
// cart leaves reachable through the Goldenrod clock man.  The numbers are put
// in the string buffer rather than laid out by hand.
// Lua: Specials.lua:986
H.MrChrono = (vm: Vm) => {
  const record = save(vm);
  const rtc = lor(truthy(record) ? record.rtc : undefined, {});
  vm.setStringBuffer(format("RT %d  DF %d", lor(rtc.day, 0), truthy(rtc.dst) ? 1 : 0));
};

// ---- 40 the wall radios -----------------------------------------------------
//
// MapRadio (engine/events/specials.asm): `ld a, [wScriptVar] / ld e, a /
// farcall PlayRadio`.  The setval before the special left a MAPRADIO_* station
// index in wScriptVar, and PlayRadio blocks with the joypad until A or B.  The
// screen is ui/MapRadio; the push goes through hooks.pushScreen.  Neither the
// special nor PlayRadio writes wScriptVar back.
// Lua: Specials.lua:1003
H.MapRadio = function* (vm: Vm): Script<void> {
  const h = hooks(vm);
  if (!h.pushScreen) return;
  const channel = vm.scriptVar ?? 0;
  yield* Specials.block(vm, (done) => {
    const ok = h.pushScreen("Gen2MapRadio", {
      channel,
      onDone: () => done(true),
    });
    if (!truthy(ok)) done(false);
  });
};

// OverworldTownMap (engine/events/specials.asm): the wall TOWN MAP's
// TownMapScript says "It's the TOWN MAP." and runs FadeToMenu / _TownMap /
// ExitAllMenus -- the region map with the player's landmark marked, UP and
// DOWN walking the landmarks, B to leave. That is the POKeGEAR's MAP card
// in its townMap mode (ui/Pokegear.ts), which pops itself on B.
H.OverworldTownMap = function* (vm: Vm): Script<void> {
  const h = hooks(vm);
  if (!h.pushScreen) return;
  const s = save(vm);
  yield* Specials.block(vm, (done) => {
    const ok = h.pushScreen("Gen2Pokegear", {
      townMap: true,
      save: s,
      onClose: () => done(true),
    });
    if (!truthy(ok)) done(false);
  });
};

// ---- 42-44 the Game Corner ------------------------------------------------
//
// StartGameCornerGame is CheckCoinsAndCoinCase and then the machine.  The
// check is transcribed here because its two refusals are TEXT and the script
// has to see them before the machine opens.
const COIN_CASE = 0x36; // constants/item_constants.asm:62 -- Lua: Specials.lua:1022

// _NoCoinsText / _NoCoinCaseText, data/text/common_1.asm.
const NO_COINS_TEXT = "You have no coins."; // Lua: Specials.lua:1025
const NO_COIN_CASE_TEXT = Strings.source("You don't have a\nCOIN CASE.");

// Lua: Specials.lua:1028
function* gameCornerGame(vm: Vm, kind: string): Script<void> {
  const h = hooks(vm);
  const coins = lor(h.coins && h.coins(), 0);
  if (coins === 0) {
    yield* vm.showRaw(Strings.get(NO_COINS_TEXT));
    return;
  }
  if (h.hasItem && !truthy(h.hasItem(COIN_CASE))) {
    yield* vm.showRaw(Strings.get(NO_COIN_CASE_TEXT));
    return;
  }
  if (!h.gameCornerGame) return;
  yield* Specials.block(vm, (done) => {
    h.gameCornerGame(kind, done);
  });
}

// Lua: Specials.lua:1045
H.SlotMachine = function* (vm: Vm): Script<void> {
  yield* gameCornerGame(vm, "slots");
};
H.CardFlip = function* (vm: Vm): Script<void> {
  yield* gameCornerGame(vm, "cardflip");
};

// ---- the Ruins of Alph ----------------------------------------------------
//
// UnownPuzzle: `call FadeToMenu / farcall _UnownPuzzle / ld a,
// [wSolvedUnownPuzzle] / ld [wScriptVar], a / call ExitAllMenus`.
// wScriptVar goes IN as well as out: LoadUnownPuzzlePiecesGFX reads it
// (`maskbits NUM_UNOWN_PUZZLES`) to pick which of the four pictures, so the id
// is read before the screen opens and the answer written after it closes; a
// screen that cannot open answers 0, the "backed out" arm a quit takes.
// Lua: Specials.lua:1059
H.UnownPuzzle = function* (vm: Vm): Script<void> {
  const h = hooks(vm);
  const puzzle = mod(vm.scriptVar ?? 0, 4);
  if (!h.unownPuzzle) {
    vm.scriptVar = 0;
    return;
  }
  const solved = yield* Specials.block(vm, (done) => {
    h.unownPuzzle(puzzle, done);
  });
  vm.scriptVar = truthy(solved) ? 1 : 0;
};

// CountUnown has no row in SpecialsPointers and therefore no handler here:
// VAR_UNOWNCOUNT is answered by World.readVar from core/Unown.

// UnownPrinter (engine/events/print_unown.asm _UnownPrinter), the research
// centre's ALPH RUINS STAMP machine.  Only the A press needs the printer; the
// viewer is drawn on the cartridge itself, and ui/UnownPrinter takes the A
// press nowhere.  `ld a, [wUnownDex] / and a / ret z` is the gate.  The
// routine never writes wScriptVar.
// Lua: Specials.lua:1090
H.UnownPrinter = function* (vm: Vm): Script<void> {
  const h = hooks(vm);
  const file = save(vm);
  if (truthy(file) && Unown.dex(file).length === 0) return;
  if (!h.showUnownPrinter) return;
  yield* Specials.block(vm, (done) => {
    h.showUnownPrinter(() => done(true));
  });
};

// GameCornerPrizeMonCheckDex: a prize mon the player has never caught shows
// its #DEX page as it is handed over.  wScriptVar carries the species in and
// out untouched.
// Lua: Specials.lua:1104
H.GameCornerPrizeMonCheckDex = (vm: Vm) => {
  const record = save(vm);
  const h = hooks(vm);
  const species = h.monName ? h.monName(vm.scriptVar) : undefined;
  if (!(truthy(record) && truthy(species))) return;
  record.pokedex = lor(record.pokedex, { seen: {}, caught: {} });
  if (truthy(record.pokedex.caught[species])) return;
  record.pokedex.seen[species] = true;
  record.pokedex.caught[species] = true;
};

// UnusedSetSeenMon: SetSeenMon on wScriptVar - 1.  Unreferenced in Gold.
// Lua: Specials.lua:1117
H.UnusedSetSeenMon = (vm: Vm) => {
  const record = save(vm);
  const h = hooks(vm);
  const species = h.monName ? h.monName(vm.scriptVar) : undefined;
  if (!(truthy(record) && truthy(species))) return;
  record.pokedex = lor(record.pokedex, { seen: {}, caught: {} });
  record.pokedex.seen[species] = true;
};

// ---- 45-55 the presentation block -----------------------------------------
//
// None of these is state.  They are the fade, the palette reload and the
// sprite refresh a scripted cutscene brackets its set change with.  Every one
// is listed rather than folded together so a reader looking for
// FadeOutToBlack finds it.
// Lua: Specials.lua:1133
function fade(vm: Vm, kind: string): void {
  const h = hooks(vm);
  if (h.fade) h.fade(kind);
}

// Lua: Specials.lua:1138
H.FadeOutToWhite = (vm: Vm) => fade(vm, "outWhite");
H.FadeOutToBlack = (vm: Vm) => fade(vm, "outBlack");
H.FadeInFromWhite = (vm: Vm) => fade(vm, "inWhite");
H.FadeInFromBlack = (vm: Vm) => fade(vm, "inBlack");

// engine/tilesets/timeofday_pals.asm:130: FillWhiteBGColor, then the same
// c=$9 / b=4 time-pal walk FadeInFromWhite runs, stepped by hand.
// Lua: Specials.lua:1145
H.BattleTowerFade = (vm: Vm) => fade(vm, "inWhite");

// ClearBGPalettes / ClearBGPalettesBufferScreen / ClearTilemap: the screen is
// blanked under a fade that is already down; the flat sheet IS the cleared
// screen.
// Lua: Specials.lua:1150
H.ClearBGPalettes = (vm: Vm) => fade(vm, "outBlack");
H.ClearBGPalettesBufferScreen = (vm: Vm) => fade(vm, "outBlack");
H.ClearTilemap = (vm: Vm) => fade(vm, "outBlack");

// UpdateTimePals: re-resolve the clock's palette without touching anything
// else.
// Lua: Specials.lua:1156
H.UpdateTimePals = (vm: Vm) => {
  const h = hooks(vm);
  if (h.reloadSprites) h.reloadSprites(true);
};

// UpdateSprites / ReloadSpritesNoPalettes: respawn the object list.  The
// second one skips LoadMapPalettes, which is why a scripted swap of an NPC's
// sprite does not restart the palette fade.
// Lua: Specials.lua:1164
H.UpdateSprites = (vm: Vm) => {
  const h = hooks(vm);
  if (h.reloadSprites) h.reloadSprites(true);
};

// Lua: Specials.lua:1169
H.ReloadSpritesNoPalettes = (vm: Vm) => {
  const h = hooks(vm);
  if (h.reloadSprites) h.reloadSprites(false);
};

// LoadUsedSpritesGFX: the VRAM pack for whichever sprites this map uses.  The
// port loads a sheet per sprite on demand, so the whole routine is the rebuild.
// Lua: Specials.lua:1177
H.LoadUsedSpritesGFX = (vm: Vm) => {
  const h = hooks(vm);
  if (h.reloadSprites) h.reloadSprites(false);
};

// ../pokecrystal/engine/overworld/warp_connection.asm:311, `ld b, SCGB_MAPPALS / jp
// GetSGBLayout`: the map's own palette layout, reapplied and nothing else.
// Lua: Specials.lua:1184
H.LoadMapPalettes = (vm: Vm) => {
  const h = hooks(vm);
  if (h.reloadSprites) h.reloadSprites(true);
};

// engine/overworld/overworld.asm:40: the used-sprite list rebuilt and its
// VRAM pack reloaded, with no palette pass -- LoadUsedSpritesGFX's arm.
// Lua: Specials.lua:1191
H.RefreshSprites = (vm: Vm) => {
  const h = hooks(vm);
  if (h.reloadSprites) h.reloadSprites(false);
};

// UpdatePlayerSprite: the player's sheet is a pure function of wPlayerState
// (data/sprites/player_sprites.asm ChrisStateSprites).
// Lua: Specials.lua:1199
H.UpdatePlayerSprite = (vm: Vm) => {
  const h = hooks(vm);
  if (h.updatePlayerSprite) h.updatePlayerSprite();
};

// engine/events/specials.asm:21 -> engine/overworld/map_objects.asm:2515:
// bit 7 of wScriptVar gates the routine, bits 6-4 are the OBJ palette.
// Lua: Specials.lua:1206
H.SetPlayerPalette = (vm: Vm) => {
  const value = mod(vm.scriptVar ?? 0, 0x100);
  if (value < 0x80) return;
  vm.playerPalette = mod(idiv(value, 0x10), 8);
  const h = hooks(vm);
  if (h.setPlayerPalette) h.setPlayerPalette(vm.playerPalette);
};

// ---- 58-62 sound and the water --------------------------------------------

// WaitSFX: hold until the sound effect that is playing finishes.  The VM has
// the whole mechanism already (the `waitsfx` opcode), so this is that yield.
// Lua: Specials.lua:1218
H.WaitSFX = function* (_vm: Vm): Script<void> {
  yield { kind: "waitsfx" };
};

// Lua: Specials.lua:1222
H.PlayMapMusic = (vm: Vm) => {
  const h = hooks(vm);
  if (h.playMapMusic) h.playMapMusic();
};

// Lua: Specials.lua:1227
H.RestartMapMusic = (vm: Vm) => {
  const h = hooks(vm);
  if (h.restartMapMusic) h.restartMapMusic();
};

// FadeOutMusic: MUSIC_NONE into wMusicFadeID with a control of 2, i.e. a fast
// ramp to silence and nothing queued behind it.
// Lua: Specials.lua:1234
H.FadeOutMusic = (vm: Vm) => {
  const h = hooks(vm);
  if (h.fadeOutMusic) h.fadeOutMusic();
};

// SurfStartStep: the player goes onto the water.  Script_UsedSurf calls this,
// so the script route and the party-menu route land in the same place.
// Lua: Specials.lua:1242
H.SurfStartStep = (vm: Vm) => {
  const h = hooks(vm);
  if (h.surfStartStep) h.surfStartStep(party(vm)[0]);
};

// PlayCurMonCry / PlaySlowCry: the cry of wCurPartySpecies, and the same cry
// at a lower pitch.  The port has no pitch control on a cry, so the slow one
// is the ordinary one -- a known, deliberate flattening.
// Lua: Specials.lua:1251
function currentCry(vm: Vm): void {
  const h = hooks(vm);
  const species = vm.scriptVar;
  if (species != null && species !== 0 && vm.cryFn) {
    vm.cryFn(species);
    return;
  }
  const mon = party(vm)[0];
  const index = mon && h.monIndex ? h.monIndex(mon.species) : undefined;
  if (truthy(index) && vm.cryFn) vm.cryFn(index);
}

// Lua: Specials.lua:1263
H.PlayCurMonCry = currentCry;
H.PlaySlowCry = currentCry;

// ---- 63-66 the party searches ---------------------------------------------
//
// Four routines that share FoundOne / FoundNone: wScriptVar goes IN as the
// thing looked for and comes back TRUE or FALSE.
// Lua: Specials.lua:1271
function findPartyMon(vm: Vm, predicate: (mon: Rec, wanted: number) => boolean): void {
  const wanted = vm.scriptVar ?? 0;
  for (const mon of party(vm)) {
    if (predicate(mon, wanted)) {
      answer(vm, TRUE);
      return;
    }
  }
  answer(vm, FALSE);
}

// Lua: Specials.lua:1282
H.FindPartyMonAboveLevel = (vm: Vm) => {
  findPartyMon(vm, (mon, level) => (mon.level ?? 0) >= level);
};

// Lua: Specials.lua:1286
H.FindPartyMonAtLeastThatHappy = (vm: Vm) => {
  findPartyMon(vm, (mon, want) => (mon.happiness ?? 0) >= want);
};

// Lua: Specials.lua:1292
H.FindPartyMonThatSpecies = (vm: Vm) => {
  const h = hooks(vm);
  findPartyMon(vm, (mon, wanted) => !!h.monIndex && h.monIndex(mon.species) === wanted);
};

// _FindPartyMonThatSpeciesYourTrainerID additionally requires the mon to be
// YOURS: it is the check that stops a traded Pokemon from counting.
// Lua: Specials.lua:1302
H.FindPartyMonThatSpeciesYourTrainerID = (vm: Vm) => {
  const h = hooks(vm);
  const record = save(vm);
  const myId = truthy(record) && record.player ? record.player.id : undefined;
  findPartyMon(vm, (mon, wanted) => {
    if (!(h.monIndex && h.monIndex(mon.species) === wanted)) return false;
    return myId == null || mon.otId == null || mon.otId === myId;
  });
};

// UnusedCheckUnusedTwoDayTimer: a timer nothing else in the ROM reads, answering
// the 0 an untouched wUnusedTwoDayTimer holds.
// Lua: Specials.lua:1314
H.UnusedCheckUnusedTwoDayTimer = (vm: Vm) => {
  answer(vm, 0);
};

// ---- 70-71 the swarms and the contestants ---------------------------------

// SelectRandomBugContestContestants: five of the ten contestant flags are set,
// and a SET flag is what keeps that trainer OFF the contest map -- and, at
// judging time, out of ComputeAIContestantScores.  BugContest.pickContestants
// stores the choice as a SET keyed by slot.  applyContestantFlags is the
// `.loop1` that RESETS all ten before the five are set
// (data/events/bug_contest_flags.asm, eventTables.bugContestFlags).
// `vm.events` / `vm.eventTables` rather than a hook: both are already on the
// VM, and onFlagsChanged is the deferred rebuild setevent/clearevent use.
// (NUM_BUG_CONTESTANTS / BUG_CONTESTANTS_PICKED are getters below;
// Lua: Specials.lua:1336.)
// Lua: Specials.lua:1339
H.SelectRandomBugContestContestants = (vm: Vm) => {
  const chosen = BugContest.pickContestants(contestSave(vm));
  BugContest.applyContestantFlags(vm.events, chosen, vm.eventTables);
  if (vm.events && vm.onFlagsChanged) vm.onFlagsChanged();
};

// ActivateFishingSwarm: wFishingSwarmFlag takes wScriptVar, and the routine
// FALLS THROUGH into SetSwarmFlag -- so the map pair and DAILYFLAGS1_SWARM are
// both live afterwards.
// Lua: Specials.lua:1349
H.ActivateFishingSwarm = (vm: Vm) => {
  const record = save(vm);
  if (!truthy(record)) return;
  record.dailyFlags = lor(record.dailyFlags, {});
  record.dailyFlags.fishingSwarm = vm.scriptVar ?? 0;
  record.dailyFlags.swarm = true;
};

// ---- 74-77 gifts and health -----------------------------------------------

// GiveShuckle: a level 15 SHUCKLE holding a BERRY, with Mania's own OT and
// trainer ID, nicknamed SHUCKIE.  Those four facts are what ReturnShuckie
// checks before it will take the thing back.
// (MANIA_OT_ID etc. are on Specials below; Lua: Specials.lua:1362.)
// Lua: Specials.lua:1367
H.GiveShuckle = (vm: Vm) => {
  const list = party(vm);
  if (list.length >= Breeding.PARTY_SIZE) {
    answer(vm, FALSE);
    return;
  }
  const mon = Mon.new(data(vm), SHUCKLE, Specials.SHUCKIE_LEVEL, {
    nickname: Specials.SHUCKIE_NICKNAME,
    item: "BERRY",
  });
  if (!mon) {
    answer(vm, FALSE);
    return;
  }
  mon.ot = Specials.MANIA_OT;
  mon.otId = Specials.MANIA_OT_ID;
  const record = save(vm);
  list.push(mon);
  // ../pokecrystal/engine/events/shuckle.asm:18-19
  if (truthy(Mon.hasCaughtData(truthy(record) ? record.version : undefined))) {
    Mon.setGiftCaughtData(mon, "unknown");
  }
  // TryAddMonToParty's .registerpokedex (engine/pokemon/move_mon.asm:188-196) #1719
  if (truthy(record)) {
    record.pokedex = lor(record.pokedex, { seen: {}, caught: {} });
    record.pokedex.seen[mon.species] = true;
    record.pokedex.caught[mon.species] = true;
  }
  answer(vm, TRUE);
};

// ReturnShuckie: the mon has to BE the Shuckie -- species, Mania's trainer ID
// and Mania's OT name, all three -- and it has to be conscious.  wScriptVar's
// five answers are the five arms of the routine, numbered as ManiasHouse.asm's
// `ifequal` chain checks them (SHUCKIE_* on Specials below; Lua: Specials.lua:1406).
// Lua: Specials.lua:1416
H.ReturnShuckie = function* (vm: Vm): Script<void> {
  const [index, mon] = yield* selectMon(vm, "choose");
  if (!truthy(mon)) {
    answer(vm, Specials.SHUCKIE_REFUSED);
    return;
  }
  if (mon.species !== SHUCKLE
      || mon.otId !== Specials.MANIA_OT_ID
      || mon.ot !== Specials.MANIA_OT) {
    answer(vm, Specials.SHUCKIE_WRONG_MON);
    return;
  }
  if ((mon.hp ?? 0) <= 0) {
    answer(vm, Specials.SHUCKIE_FAINTED);
    return;
  }
  // The happiness the mon comes back with is what Mania comments on, so it is
  // read before the slot might get emptied.
  vm.shuckieHappiness = mon.happiness ?? 0;
  if ((mon.happiness ?? 0) >= Specials.SHUCKIE_HAPPY_THRESHOLD) {
    // Shuckie stays with the player: the party slot is untouched.
    answer(vm, Specials.SHUCKIE_HAPPY);
    return;
  }
  removeAt(party(vm), index);
  answer(vm, Specials.SHUCKIE_RETURNED);
};

// BillsGrandfather: pick a mon and hand him its species.  wScriptVar is the
// species index he then names, 0 for a B press.
// Lua: Specials.lua:1446
H.BillsGrandfather = function* (vm: Vm): Script<void> {
  const h = hooks(vm);
  const [, mon] = yield* selectMon(vm, "choose");
  if (!truthy(mon)) {
    answer(vm, 0);
    return;
  }
  const index = h.monIndex ? h.monIndex(mon.species) : undefined;
  answer(vm, lor(index, 0));
  nameMon(vm, lor(index, mon.species));
};

// CheckPokerus -> _CheckPokerus -> ScriptReturnCarry: 1 when any party member
// carries the virus.  `and $0f` is the whole test -- an ACTIVE infection only.
// Lua: Specials.lua:1462
H.CheckPokerus = (vm: Vm) => {
  answer(vm, truthy(Pokerus.inParty(party(vm))) ? TRUE : FALSE);
};

// ---- 78-80 the money boxes ------------------------------------------------
//
// engine/menus/menu_2.asm.  The three are DIFFERENT boxes -- DisplayMoneyAndCoin
// Balance prints both fields in a 13x3 box of its own -- so the world hook is
// told which.
// Lua: Specials.lua:1472
H.DisplayCoinCaseBalance = (vm: Vm) => {
  if (vm.showCoinsFn) vm.showCoinsFn();
};

// Lua: Specials.lua:1476
H.DisplayMoneyAndCoinBalance = (vm: Vm) => {
  if (vm.showMoneyFn) vm.showMoneyFn("moneycoins");
};

// Lua: Specials.lua:1480
H.PlaceMoneyTopRight = (vm: Vm) => {
  if (vm.showMoneyFn) vm.showMoneyFn("money");
};

// ---- 81-84 the Lucky Number Show ------------------------------------------
//
// Its whole rule is the number of TRAILING digits a mon's trainer ID shares
// with the day's five-digit lucky number, over the party AND every box:
//
//   5 digits  first prize   wScriptVar 1
//   3 or 4    second prize  wScriptVar 2
//   2         third prize   wScriptVar 3
//   fewer     nothing       wScriptVar 0
//
// The BEST match wins, which is why the comparison keeps the LOWER wScriptVar
// (`cp b / jr c, .nomatch`), and a match found in a BOX rather than in the
// party changes only which of two lines is printed.
// Lua: Specials.lua:1498
function trailingDigitsShared(a: number | undefined, b: number | undefined): number {
  const left = format("%05d", mod(a ?? 0, 100000));
  const right = format("%05d", mod(b ?? 0, 100000));
  let shared = 0;
  for (let i = 5; i >= 1; i--) {
    if (sub(left, i, i) !== sub(right, i, i)) break;
    shared = shared + 1;
  }
  return shared;
}

// pokegold/constants/pokemon_data_constants.asm:122-123
const NUM_BOXES = 14; // Lua: Specials.lua:1511
const NUM_BOXES_JP = 9;

// pokegold/engine/events/lucky_number.asm:22-102: sBox (the OPEN box) is walked
// before .BoxesLoop skips it, and .BoxesLoop stops at NUM_BOXES_JP not NUM_BOXES.
// Box numbers are the game's own (1-based).
// Lua: Specials.lua:1515
function luckyNumberBoxOrder(record: Rec): number[] {
  const current = Math.floor(tonumber(truthy(record) ? record.currentBox : undefined) ?? 1);
  const last = truthy(GameVersion.fixes().luckyNumberBoxes) ? NUM_BOXES : NUM_BOXES_JP;
  const order = [current];
  for (let index = 1; index <= last; index++) {
    if (index !== current) order.push(index);
  }
  return order;
}

// Lua: Specials.lua:1526
function luckyPrizeFor(shared: number): number {
  if (shared >= 5) return 1;
  if (shared >= 3) return 2;
  if (shared >= 2) return 3;
  return 0;
}

// engine/overworld/time.asm's RestartLuckyNumberCountdown: the days from
// `weekday` until the NEXT Friday, where Friday itself is a full week away
// rather than zero (`sub c / jr z, .friday_saturday` before the `add 7`).
// GetWeekday counts SUNDAY 0 .. SATURDAY 6 -- the save's weekday (Clock.weekday:
// the host's plus the day the player set at the start), as every GetWeekday
// reads it.
// Lua: Specials.lua:1538
function daysUntilFriday(weekday: number | undefined): number {
  return mod(BugContest.FRIDAY - (weekday ?? 0) - 1, 7) + 1;
}

// save.luckyNumberReset stands in for wLuckyNumberDayTimer: { remaining, day }
// the same shape Apricorns.startDailyResetTimer uses, armed for a week.  A save
// that has never armed it (day == nil) reads as already expired, the same way
// a freshly zeroed SRAM byte does -- which makes the FIRST visit to the Lucky
// Number Man always reset and roll a number.
// Lua: Specials.lua:1549
function luckyNumberTimer(record: Rec): Rec {
  if (typeof record !== "object" || record === null) return undefined;
  record.luckyNumberReset = lor(record.luckyNumberReset, { remaining: 0 });
  return record.luckyNumberReset;
}

// _CheckLuckyNumberShowFlag: CheckDayDependentEventHL over wLuckyNumberDayTimer.
// Advances the stored day as it measures (CalcDaysSince's side effect), then
// clamps the remaining count at zero.
// Lua: Specials.lua:1559
function checkLuckyNumberTimer(record: Rec, now?: any): boolean {
  const timer = luckyNumberTimer(record);
  if (!truthy(timer)) return false;
  if (timer.day == null) return true;
  now = lor(now, BugContest.now());
  const stamp = { day: timer.day };
  const since = BugContest.elapsedSince(stamp, now, "day");
  timer.day = stamp.day;
  let left = (timer.remaining ?? 0) - since.days;
  if (left < 0) left = 0;
  timer.remaining = left;
  return left <= 0;
}

// Lua: Specials.lua:1573
H.CheckForLuckyNumberWinners = (vm: Vm) => {
  const record = save(vm);
  const number = truthy(record) ? record.luckyNumber : undefined;
  answer(vm, 0);
  if (!truthy(number)) return;
  let best = 0;
  let bestMon: Rec = undefined;
  let inBox = false;
  const consider = (mon: Rec, fromBox: boolean): void => {
    if (truthy(Breeding.isEgg(mon))) return;
    const prize = luckyPrizeFor(trailingDigitsShared(mon.otId, number));
    if (prize === 0) return;
    if (best === 0 || prize < best) {
      best = prize;
      bestMon = mon;
      inBox = fromBox;
    }
  };
  for (const mon of party(vm)) consider(mon, false);
  const boxes = lor(truthy(record) ? record.boxes : undefined, {});
  // save.boxes is keyed by box number (Boxes.lua:53), not a 0-based list.
  for (const index of luckyNumberBoxOrder(record)) {
    for (const mon of lor(boxes[index], [])) consider(mon, true);
  }
  answer(vm, best);
  if (truthy(bestMon)) {
    nameMon(vm, bestMon.species);
    vm.luckyNumberInBox = inBox;
  }
};

// _CheckLuckyNumberShowFlag -> ScriptReturnCarry: TRUE once wLuckyNumberDayTimer
// has counted down past the coming Friday.  This is the WEEKLY gate;
// RadioTower1FLuckyNumberManScript only calls ResetLuckyNumberShowFlag when
// this comes back TRUE.
// Lua: Specials.lua:1606
H.CheckLuckyNumberShowFlag = (vm: Vm) => {
  answer(vm, checkLuckyNumberTimer(save(vm)) ? TRUE : FALSE);
};

// ResetLuckyNumberShowFlag: RestartLuckyNumberCountdown re-arms the weekly
// timer for the days until the NEXT Friday, `res LUCKYNUMBERSHOW_GAME_OVER_F`
// clears the SAME storage `checkflag`/`setflag ENGINE_LUCKY_NUMBER_SHOW` read
// and write, and LoadOrRegenerateLuckyIDNumber rolls a fresh five-digit number.
// Lua: Specials.lua:1619
H.ResetLuckyNumberShowFlag = (vm: Vm) => {
  const record = save(vm);
  if (!truthy(record)) return;
  const now = BugContest.now();
  const timer = luckyNumberTimer(record);
  // GetWeekday is wCurDay, which carries the weekday the player chose; the
  // host's own weekday is not it (a card set to Tuesday on a Friday)
  timer.remaining = daysUntilFriday(Clock.weekday(record));
  timer.day = now.day;
  const h = hooks(vm);
  if (h.setEngineFlag) h.setEngineFlag("ENGINE_LUCKY_NUMBER_SHOW", undefined);
  record.luckyNumber = Specials.random(0, 99999);
};

// PrintTodaysLuckyNumber: five digits with leading zeros, into the buffer the
// following writetext reads.
// Lua: Specials.lua:1633
H.PrintTodaysLuckyNumber = (vm: Vm) => {
  const record = save(vm);
  vm.setStringBuffer(format("%05d", mod(lor(truthy(record) ? record.luckyNumber : undefined, 0), 100000)));
};

// ---- 85 Kurt and the apricorns --------------------------------------------

// The CANCEL row Kurt_SelectApricorn's .Name draws itself (`db "CANCEL@"`)
// rather than taking from the item names, because item 0 has no name.
const CANCEL = Strings.source("CANCEL"); // Lua: Specials.lua:1643

// .MenuHeader: MENU_BACKUP_TILES, `menu_coords 0, 0, 14, 17`, .MenuData and a
// default option of 1; .MenuData's own byte is STATICMENU_CURSOR |
// STATICMENU_WRAP (constants/menu_constants.asm bits 7 and 5).  The wrap is
// the one thing ui/ScriptMenu does not honour yet.
const KURT_MENU_FLAGS = 0x80 + 0x20; // Lua: Specials.lua:1650

// SelectApricornForKurt (engine/events/specials.asm) is two routines deep:
//
//   farcall Kurt_SelectApricorn / ld a, c / ld [wScriptVar], a / and a / ret z
//   ld [wCurItem], a / ld a, 1 / ld [wItemQuantityChange], a / TossItem
//
// so wScriptVar is the ITEM id of the apricorn chosen -- .AskApricorn's ladder
// is `ifequal BLU_APRICORN` and friends -- and the apricorn leaves the pack
// HERE, before the script's setevent runs.
//
// Kurt_SelectApricorn (engine/menus/menu_2.asm) is FindApricornsInBag plus a
// DoNthMenu over the list it builds, so the rows come out in ApricornBalls
// order and the last row is always CANCEL.  Both refusals answer `xor a`.
//
// ../pokecrystal/engine/events/kurt.asm:19-45 is the same routine with a
// quantity menu bolted on (:24, :45; ../pokecrystal/maps/KurtsHouse.asm:197).
// Kurt_SelectQuantity is not ported, so the count written here is the one
// apricorn Apricorns.takeApricorn tosses.
// Lua: Specials.lua:1675
H.SelectApricornForKurt = function* (vm: Vm): Script<void> {
  const h = hooks(vm);
  const record = save(vm);
  if (h.setKurtApricornQuantity) h.setKurtApricornQuantity(0);
  const list = Apricorns.bagList(truthy(record) ? record.inventory : undefined);
  if (truthy(list.empty)) {
    answer(vm, FALSE);
    return;
  }

  // The menu's rows as a 0-based list; list.cancel is the 1-based CANCEL row.
  const rows: string[] = [];
  for (let index = 0; index < list.length; index++) {
    const apricorn = list[index];
    rows[index] = lor(h.itemName && h.itemName(apricorn), apricorn);
  }
  rows[list.cancel - 1] = Strings.get(CANCEL);

  const choice = yield* Specials.block(vm, (done) => {
    if (!h.scriptMenu) {
      done(0);
      return;
    }
    h.scriptMenu({
      items: rows, left: 0, top: 0, right: 14, bottom: 17,
      dataFlags: KURT_MENU_FLAGS, cursor: 1,
    }, done);
  });

  const apricorn = Apricorns.select(truthy(record) ? record.inventory : undefined, tonumber(choice));
  if (!truthy(apricorn)) {
    answer(vm, FALSE);
    return;
  }
  // No item id, no toss: an answer the `ifequal` ladder cannot match would
  // fall through to .Red and hand Kurt an apricorn the player never lost.
  const item = h.itemIndex ? h.itemIndex(apricorn) : undefined;
  if (!truthy(item) || item === 0) {
    answer(vm, FALSE);
    return;
  }
  answer(vm, item);
  if (truthy(Apricorns.takeApricorn(record, apricorn!)) && h.setKurtApricornQuantity) {
    h.setKurtApricornQuantity(1);
  }
};

// ---- 88-89 the first party slot -------------------------------------------

// GetFirstPokemonHappiness: the happiness of the first NON-EGG party member --
// the loop skips eggs.
// Lua: Specials.lua:1713
H.GetFirstPokemonHappiness = (vm: Vm) => {
  for (const mon of party(vm)) {
    if (!truthy(Breeding.isEgg(mon))) {
      answer(vm, lor(mon.happiness, 0));
      nameMon(vm, mon.species);
      return;
    }
  }
  answer(vm, 0);
};

// CheckFirstMonIsEgg: TRUE when slot 1 holds an egg, and the name goes in the
// buffer either way (`call GetPokemonName` is past the branch).
// Lua: Specials.lua:1727
H.CheckFirstMonIsEgg = (vm: Vm) => {
  const mon = party(vm)[0];
  answer(vm, truthy(Breeding.isEgg(mon)) ? TRUE : FALSE);
  if (truthy(mon)) nameMon(vm, mon.species);
};

// ---- 90 the rare-mon phone call -------------------------------------------
//
// RandomUnseenWildMon: pick one of the three RAREST slots on the caller's map,
// and if it is not also one of the four commonest AND has never been seen, the
// caller tells you about it (wScriptVar 0).  Anything else is 1.  The only map
// this can honestly read is the one the player is standing on.
// Lua: Specials.lua:1745
H.RandomUnseenWildMon = (vm: Vm) => {
  const h = hooks(vm);
  answer(vm, TRUE);
  if (!h.rareWildMon) return;
  const species = h.rareWildMon();
  if (!truthy(species)) return;
  const record = save(vm);
  const seen = truthy(record) && record.pokedex ? record.pokedex.seen : undefined;
  if (truthy(seen) && truthy(seen[species])) return;
  nameMon(vm, species);
  answer(vm, FALSE);
};

// ---- 91, 92 the phone chatter name-drops -----------------------------------
//
// Both open on GetCallerLocation (engine/phone/phone.asm), which reads the
// contact on the line out of wCurCaller; the port parks that id on
// vm.curPhoneCaller when a call's script starts.  Neither routine writes
// wScriptVar: both end on CopyBytes into wStringBuffer4.

// trainers and encounters both store species IDS, not dex indexes, so this is
// nameMon's sibling for a handler already holding the id.
// Lua: Specials.lua:1769
function nameSpecies(vm: Vm, species: any): void {
  const defs = data(vm);
  const def = truthy(defs) && defs.pokemon ? defs.pokemon[species] : undefined;
  vm.setStringBuffer(lor(def && def.name, species));
}

// RandomPhoneWildMon (engine/overworld/wildmons.asm): one of the FOUR
// commonest grass slots (`call Random / and %11`) on the CALLER'S map, read
// at the current time of day, named into the buffer.  A caller whose map has
// no grass table leaves the buffer alone.
// Lua: Specials.lua:1780
H.RandomPhoneWildMon = (vm: Vm) => {
  const contact = Phone.CONTACTS[vm.curPhoneCaller ?? -1];
  const w = hooks(vm).world;
  const grass = w && w.encounters ? w.encounters.grass : undefined;
  const entry = contact && contact.map && grass ? grass[contact.map] : undefined;
  const slots = entry ? entry.slots : undefined;
  if (!truthy(slots)) return;
  // wTimeOfDay, not the palette pin (wildmons.asm:861)
  let daytime = lor(w && lor(w.tod, w.daytime), "DAY");
  if (daytime === "DARK") daytime = "NITE";
  const slot = lor(slots[daytime], slots.DAY, [])[Specials.random(4) - 1];
  if (slot && truthy(slot.species)) nameSpecies(vm, slot.species);
};

// RandomPhoneMon: a mon out of the calling trainer's OWN party, uniform over
// its length (`call Random / maskbits PARTY_LENGTH / cp e / jr nc` rerolls).
// The contact stores the class id and the member's own id string.
// Lua: Specials.lua:1799
H.RandomPhoneMon = (vm: Vm) => {
  const contact = Phone.CONTACTS[vm.curPhoneCaller ?? -1];
  if (!(contact && truthy(contact.class))) return;
  const defs = data(vm);
  const cls = truthy(defs) && defs.trainers && defs.trainers.classes
    ? defs.trainers.classes[contact.class!]
    : undefined;
  let mons: Rec[] | undefined;
  for (const row of lor(cls && cls.trainers, [])) {
    if (row.id === contact.member) {
      mons = row.party;
      break;
    }
  }
  if (!(mons && mons.length > 0)) return;
  const mon = mons[Specials.random(mons.length) - 1];
  if (mon && truthy(mon.species)) nameSpecies(vm, mon.species);
};

// ---- 95 Snorlax -----------------------------------------------------------
//
// SnorlaxAwake: TRUE only when the POKe FLUTE channel is the map's music AND
// the player is on one of five cells beside the Snorlax.  The coordinates are
// the routine's own .ProximityCoords (SNORLAX_PROXIMITY below, Lua:
// Specials.lua:1823).  The music test is `ld a, [wMapMusic] / cp
// MUSIC_POKE_FLUTE_CHANNEL`: the map music byte that leaving the POKeGEAR on
// a tuned station writes (ExitPokegearRadio_HandleMusic), not whatever the
// sound engine happens to be playing -- which a headless host never is.
// Lua: Specials.lua:1828
H.SnorlaxAwake = (vm: Vm) => {
  const h = hooks(vm);
  answer(vm, FALSE);
  const song = h.mapMusic ? h.mapMusic() : h.currentMusic ? h.currentMusic() : undefined;
  if (song !== Specials.POKE_FLUTE_SONG) return;
  let x: any = 0;
  let y: any = 0;
  if (h.playerCell) [x, y] = multi(h.playerCell());
  for (const cell of Specials.SNORLAX_PROXIMITY) {
    if (cell[0] === x && cell[1] === y) {
      answer(vm, TRUE);
      return;
    }
  }
};

// ---- 96-98 the haircut brothers and Daisy ---------------------------------
//
// One routine (HaircutOrGrooming) with three happiness tables in front of it.
// Each table is a weighted roll: a random byte walks the rows subtracting each
// row's weight, and the row it lands on carries the wScriptVar the script
// branches on and the HAPPINESS_* action applied to the mon.
//
// data/events/happiness_probabilities.asm, transcribed.  Rows are
// [weight, scriptVar, happinessChange] where `weight` is the macro's own
// `N percent` (`* $ff / 100`, integer) and -1 is 255, the catch-all last row:
//
//   Older    30%  -> 2,  50%+1 -> 3,  rest -> 4
//   Younger  60%+1 -> 2, 30%   -> 3,  rest -> 4
//   Daisy    always -> 2
//
// The wScriptVar values really are 2, 3 and 4 -- the barber's script branches
// on them with `ifequal`.
// Lua: Specials.lua:1862
const HAIRCUT_TABLES: Record<string, Array<[number, number, string]>> = {
  older: [
    [76, 2, "OLDERCUT1"], // 30 percent
    [128, 3, "OLDERCUT2"], // 50 percent + 1
    [255, 4, "OLDERCUT3"], // -1
  ],
  younger: [
    [154, 2, "YOUNGCUT1"], // 60 percent + 1
    [76, 3, "YOUNGCUT2"], // 30 percent
    [255, 4, "YOUNGCUT3"], // -1
  ],
  daisy: [
    [255, 2, "GROOMING"],
  ],
};

// HappinessChanges (data/events/happiness_changes.asm) is transcribed ONCE, in
// core/Happiness, alongside the tier pick and the two clamps.  The seven rows
// the barbers and the groomer reach are a window onto that table, not a second
// copy.  The enum is `const_def 1` (1-based) and Happiness.CHANGES is a list,
// hence the `- 1`.
// Lua: Specials.lua:1884
function happinessChanges(): Record<string, any> {
  const out: Record<string, any> = {};
  for (const action of ["OLDERCUT1", "OLDERCUT2", "OLDERCUT3",
    "YOUNGCUT1", "YOUNGCUT2", "YOUNGCUT3", "GROOMING"]) {
    out[action] = Happiness.CHANGES[Happiness.EVENT[action] - 1];
  }
  return out;
}

// Lua: Specials.lua:1900
function* haircut(vm: Vm, which: string): Script<void> {
  const [, mon] = yield* selectMon(vm, "choose");
  if (!truthy(mon)) {
    answer(vm, 0);
    return;
  }
  // `cp EGG / jr z, .egg`: an egg cannot be groomed, and `.egg` leaves
  // wScriptVar at 0 rather than answering one of the three rows.
  if (truthy(Breeding.isEgg(mon))) {
    answer(vm, 0);
    return;
  }
  nameMon(vm, lor(mon.nickname, mon.species));
  const rows = lor(Specials.HAIRCUT_TABLES[which], Specials.HAIRCUT_TABLES.daisy!) as Array<[number, number, string]>;
  // `call Random / .loop: sub [hl] / jr c, .ok`: subtract each row's weight
  // from the rolled byte until it borrows.
  let roll = Specials.random(0, 255);
  let row = rows[rows.length - 1]!;
  for (const candidate of rows) {
    if (roll < candidate[0]) {
      row = candidate;
      break;
    }
    roll = roll - candidate[0];
  }
  answer(vm, row[1]);
  Specials.changeHappiness(mon, row[2]);
}

// Lua: Specials.lua:1927
H.OlderHaircutBrother = function* (vm: Vm): Script<void> {
  yield* haircut(vm, "older");
};
H.YoungerHaircutBrother = function* (vm: Vm): Script<void> {
  yield* haircut(vm, "younger");
};
H.DaisysGrooming = function* (vm: Vm): Script<void> {
  yield* haircut(vm, "daisy");
};

// ---- 100 PROF.OAK's PC #DEX rating -----------------------------------------
//
// ProfOaksPCBoot (engine/events/prof_oaks_pc.asm).  OaksLab's own script is
// `writetext OakLabDexCheckText / waitbutton / special ProfOaksPCBoot`, so
// every line prints straight into an already-open box.  The asm never writes
// wScriptVar either.  ProfOaksPC, the outer wrapper with the yes/no gate, runs
// inside CenterPcMenu's oakRate off the exports below.
//
// data/text/common_2.asm _OakPCText2/_OakPCText3.  The seen/owned counts are
// formatted straight into the text with %d: the cart puts them in two
// DIFFERENT buffers in the one textbox, and {STRBUF} only carries one value.
// `para` is `\f` (home/text.asm:403), `cont` is `\v` (home/text.asm:442).
// Lua: Specials.lua:1955
const OAK_PC_TEXT = {
  completion: Strings.source("Current #DEX\ncompletion level:"),
  counts: Strings.source("%d #MON seen\n%d #MON owned\fPROF.OAK's\nRating:"),
};

// OakRatings (data/events/pokedex_ratings.asm).  Each row is (cap, sfx,
// text); FindOakRating walks the table with `cp c / jr nc, .match` against
// ascending caps: "the first row whose cap covers the caught count".  sfx is
// the Gold sfx table's own label (audio/sfx_pointers.asm dba lines).
// Lua: Specials.lua:1967
interface OakRating { max: number; sfx: string; text: string }
const OAK_RATINGS: OakRating[] = [
  { max: 9, sfx: "Sfx_DexFanfareLessThan20", text: Strings.source("Look for #MON\nin grassy areas!") },
  { max: 19, sfx: "Sfx_DexFanfareLessThan20", text: Strings.source("Good. I see you\nunderstand how to\vuse # BALLS.") },
  { max: 34, sfx: "Sfx_DexFanfare2049", text: Strings.source("You're getting\ngood at this.\fBut you have a\nlong way to go.") },
  { max: 49, sfx: "Sfx_DexFanfare2049", text: Strings.source("You need to fill\nup the #DEX.\fCatch different\nkinds of #MON!") },
  { max: 64, sfx: "Sfx_DexFanfare5079", text: Strings.source("You're trying--I\ncan see that.\fYour #DEX is\ncoming together.") },
  { max: 79, sfx: "Sfx_DexFanfare5079", text: Strings.source("To evolve, some\n#MON grow,\fothers use the\neffects of STONES.") },
  { max: 94, sfx: "Sfx_DexFanfare80109", text: Strings.source("Have you gotten a\nfishing ROD? You\fcan catch #MON\nby fishing.") },
  { max: 109, sfx: "Sfx_DexFanfare80109", text: Strings.source("Excellent! You\nseem to like col-\vlecting things!") },
  { max: 124, sfx: "Sfx_CaughtMon", text: Strings.source("Some #MON only\nappear during\fcertain times of\nthe day.") },
  { max: 139, sfx: "Sfx_CaughtMon", text: Strings.source("Your #DEX is\nfilling up. Keep\vup the good work!") },
  { max: 154, sfx: "Sfx_DexFanfare140169", text: Strings.source("I'm impressed.\nYou're evolving\f#MON, not just\ncatching them.") },
  { max: 169, sfx: "Sfx_DexFanfare140169", text: Strings.source("Have you met KURT?\nHis custom #\vBALLS should help.") },
  { max: 184, sfx: "Sfx_DexFanfare170199", text: Strings.source("Wow. You've found\nmore #MON than\fthe last #DEX\nresearch project.") },
  { max: 199, sfx: "Sfx_DexFanfare170199", text: Strings.source("Are you trading\nyour #MON?\fIt's tough to do\nthis alone!") },
  { max: 214, sfx: "Sfx_DexFanfare200229", text: Strings.source("Wow! You've hit\n200! Your #DEX\vis looking great!") },
  { max: 229, sfx: "Sfx_DexFanfare200229", text: Strings.source("You've found so\nmany #MON!\fYou've really\nhelped my studies!") },
  { max: 239, sfx: "Sfx_DexFanfare230Plus", text: Strings.source("Magnificent! You\ncould become a\f#MON professor\nright now!") },
  { max: 248, sfx: "Sfx_DexFanfare230Plus", text: Strings.source("Your #DEX is\namazing! You're\fready to turn\nprofessional!") },
  // The top band (251 real species, the table's cap of 255 covers it): the
  // ONLY place the ROM checks "has the player finished the #DEX".  The diploma
  // itself is GameFreakGameDesignerScript's business (H.Diploma below, then
  // EVENT_ENABLE_DIPLOMA_PRINTING for `special PrintDiploma`).
  { max: 255, sfx: "Sfx_DexFanfare230Plus", text: Strings.source("Whoa! A perfect\n#DEX! I've\fdreamt about this!\nCongratulations!") },
];

// CountSetBits over wPokedexSeen/wPokedexCaught.  The port's dex is a
// species-keyed bool map (core/Save), not a bitfield, so this counts `true`
// entries.  Returns [seen, caught].
// Lua: Specials.lua:2022
function dexCounts(record: Rec): [number, number] {
  const dex = truthy(record) ? record.pokedex : undefined;
  let seen = 0;
  let caught = 0;
  for (const has of Object.values(lor(dex && dex.seen, {}))) {
    if (truthy(has)) seen = seen + 1;
  }
  for (const has of Object.values(lor(dex && dex.caught, {}))) {
    if (truthy(has)) caught = caught + 1;
  }
  return [seen, caught];
}

// FindOakRating.  NUM_POKEMON is 251, so `caught` never exceeds the table's
// own top cap of 255 and this never falls off the end.
// Lua: Specials.lua:2036
function findOakRating(caught: number): OakRating {
  for (const row of OAK_RATINGS) {
    if (caught <= row.max) return row;
  }
  return OAK_RATINGS[OAK_RATINGS.length - 1]!;
}

// Lua: Specials.lua:2043
H.ProfOaksPCBoot = function* (vm: Vm): Script<void> {
  yield* vm.showRaw(Strings.get(OAK_PC_TEXT.completion));
  const [seen, caught] = dexCounts(save(vm));
  yield* vm.showRaw(Strings.get(OAK_PC_TEXT.counts, seen, caught));
  const rating = findOakRating(caught);
  const h = hooks(vm);
  // pokegold engine/events/prof_oaks_pc.asm:18-20 PlaySFX / JoyWaitAorB / WaitSFX
  yield* drainSfx();
  if (h.playSfxNamed) h.playSfxNamed(rating.sfx);
  yield* vm.showRaw(Strings.get(rating.text), undefined, undefined, true);
};

// ---- 101-102 the console and the Trainer House ----------------------------

// GameboyCheck: GBCHECK_GB 0 / GBCHECK_SGB 1 / GBCHECK_CGB 2.  The honest
// answer follows the COLOR option: the deliberate step down to a grey Game Boy
// is a real answer to this question, and the Goldenrod console kid's line
// changes with it.
// Lua: Specials.lua:2070
H.GameboyCheck = (vm: Vm) => {
  if (GbcPalette.mode === "gbc") {
    answer(vm, GBCHECK_CGB);
  } else if (GbcPalette.mode === "classic") {
    answer(vm, GBCHECK_GB);
  } else {
    answer(vm, GBCHECK_SGB);
  }
};

// TrainerHouse: sMysteryGiftTrainerHouseFlag, the byte a Mystery Gift trade
// leaves behind so the Viridian Trainer House has somebody to fight
// (core/MysteryGift.ts sets it, with the partner's name and party).  world/TrainerHouse owns
// the byte, so the answer cannot drift from the party the battle then loads.
// Lua: Specials.lua:2091
H.TrainerHouse = (vm: Vm) => {
  answer(vm, truthy(TrainerHouse.hasCustomTrainer(save(vm))) ? TRUE : FALSE);
};

// ---- 104 the roamers ------------------------------------------------------
//
// InitRoamMons (engine/overworld/wildmons.asm): the three legendary beasts are
// written into the wRoamMon structs on their starting routes -- Raikou ROUTE
// 42, Entei ROUTE 37, Suicune ROUTE 38, all level 40, each HP byte zeroed
// ("generate new stats").  core/Roamers is the ONE writer of save.roamers;
// Specials.ROAMERS is an alias of its table (a getter below; Lua:
// Specials.lua:2114).  `force` because the asm stores unconditionally.
// Lua: Specials.lua:2116
H.InitRoamMons = (vm: Vm) => {
  const record = save(vm);
  if (!truthy(record)) return;
  Roamers.init(record, { force: true, data: data(vm) });
};

// ---- the #DEX-completion diploma -------------------------------------------
//
// _Diploma (engine/events/diploma.asm): PlaceDiplomaOnScreen then
// WaitPressAorB_BlinkCursor.  _Diploma never touches wScriptVar.  The screen
// is ui/Diploma; World.showDiploma is the push.
// Lua: Specials.lua:2132
H.Diploma = function* (vm: Vm): Script<void> {
  const h = hooks(vm);
  if (!h.showDiploma) return;
  yield* Specials.block(vm, (done) => {
    h.showDiploma(() => done(true));
  });
};

// ---- Mystery Gift ------------------------------------------------------------
//
// core/MysteryGift.ts keeps the SRAM bytes; the exchange itself is the main
// menu's (ui/MysteryGiftScreen).
//
// UnlockMysteryGift: Carrie in the Goldenrod Dept. Store 5F.
H.UnlockMysteryGift = (vm: Vm) => {
  const s = save(vm);
  if (s) MysteryGift.unlock(s);
};

// CheckMysteryGift (engine/events/specials.asm): sMysteryGiftItem, plus one
// when nonzero -- the Pokecenter 2F scene script's `ifequal 0` brings out the
// delivery man otherwise.
//
// Not the cart's: with EVENT POKéMON on, an event mon still waiting brings
// him out too (core/EventPokemon.ts).
H.CheckMysteryGift = (vm: Vm) => {
  const s = save(vm);
  const waiting = s && (MysteryGift.waiting(s) || EventPokemon.next(s, s.options));
  answer(vm, waiting ? 2 : 0);
};

// GetMysteryGiftItem: into the PACK (ReceiveItem), "<PLAYER> received <item>."
// and TRUE; a full PACK keeps the gift waiting and answers FALSE.
H.GetMysteryGiftItem = function* (vm: Vm): Script<void> {
  const h = hooks(vm);
  const s = save(vm);
  const item = s ? MysteryGift.state(s).item : 0;
  if (s && item === 0 && EventPokemon.next(s, s.options)) {
    yield* giveEventMon(vm, s);
    return;
  }
  if (!s || item === 0) {
    answer(vm, FALSE);
    return;
  }
  const data = h.world?.game?.data;
  if (!Bag.add(s, item, 1, data)) {
    answer(vm, FALSE);
    return;
  }
  MysteryGift.take(s);
  const index = h.itemIndex ? h.itemIndex(item) : undefined;
  if (index != null) vm.curItem = index;
  const name = h.itemName ? h.itemName(item) : item;
  yield* vm.showRaw(Strings.get("{PLAYER} received\n%s.", name));
  answer(vm, TRUE);
};

// The event mon in the delivery man's hands: GivePoke's trainer arm for the
// OT (EVENT_OT, as the distribution carts sent them), then the ordinary
// nickname ask. A full party is his "no space" line, and the mon waits.
// wCurItem goes to 0 so the script's own itemnotify after a TRUE prints
// nothing -- there is no pocket for a POKéMON.
function* giveEventMon(vm: Vm, s: any): Script<void> {
  const ev = EventPokemon.next(s, s.options)!;
  const data = hooks(vm).world?.game?.data;
  const index = data?.pokemon?.[ev.species]?.index;
  if (index == null || !vm.givePokeFn || (s.party?.length ?? 0) >= Breeding.PARTY_SIZE) {
    answer(vm, FALSE);
    return;
  }
  const name = data.pokemon[ev.species].name ?? ev.species;
  const mon = vm.givePokeFn(index, ev.level, 0, { otName: EVENT_OT });
  if (!truthy(mon)) {
    answer(vm, FALSE);
    return;
  }
  EventPokemon.mark(s, ev.id);
  vm.curItem = 0;
  yield* vm.showRaw(Strings.get("{PLAYER} received\n%s!", name));
  yield* Specials.askNickname(vm, mon);
  answer(vm, TRUE);
}

// ---- the link record ---------------------------------------------------------
//
// The Pokecenter 2F's sign: _DisplayLinkRecord (engine/link/link.asm), the
// COLOSSEUM's wins, losses and draws (core/LinkRecords.ts), then
// WaitPressAorB_BlinkCursor. The screen is ui/LinkRecord.
H.DisplayLinkRecord = function* (vm: Vm): Script<void> {
  const h = hooks(vm);
  if (!h.showLinkRecord) return;
  yield* Specials.block(vm, (done) => {
    h.showLinkRecord(() => done(true));
  });
};

// ---- Mom's savings ----------------------------------------------------------
//
// BankOfMom (engine/events/mom.asm), reached from PlayersHouse1F's MomScript
// inside a caller-opened textbox.  The asm is a nine-state jumptable; this
// ports its shape rather than its byte, with two of its behaviours kept:
//
//   * StoreMoney/TakeMoney's insufficient-funds arms `ret` WITHOUT advancing
//     wJumptableIndex, so `.loop` re-enters the SAME state and asks again --
//     the `while (true)` loops below stand in for that.
//   * GiveMoney does not refuse an over-the-cap deposit, it CLAMPS to
//     MAX_MONEY and reports carry; the clamp already landed, so a deposit that
//     overflows Mom's account still tops her out at 999999 without touching
//     the wallet.
//
// The `.nope` arm of IsThisAboutYourMoney runs DSTChecks (engine/rtc/
// timeset.asm) before MomJustDoWhatYouCanText: the clock goes forward or back
// an hour through Clock.setTime, and save.rtc.dst is wDST's bit.
//
// data/text/common_1.asm, with the cart's own page structure: `para` is `\f`,
// `cont` is `\v`.
// Lua: Specials.lua:2171
const MOM_TEXT = {
  leaving1: Strings.source(
    "Wow, that's a cute\n#MON.\fWhere did you get\nit?\f…\f"
    + "So, you're leaving\non an adventure…\fOK!\nI'll help too.\f"
    + "But what can I do\nfor you?\fI know! I'll save\nmoney for you.\f"
    + "On a long journey,\nmoney's important.\fDo you want me to\n"
    + "save your money?"),
  leaving2: Strings.source("OK, I'll take care\nof your money.\f…"),
  leaving3: Strings.source(
    "Be careful.\f#MON are your\nfriends. You need\vto work as a team.\f"
    + "Now, go on!"),
  isThisAboutMoney: Strings.source(
    "Hi! Welcome home!\nYou're trying very\vhard, I see.\f"
    + "I've kept your\nroom tidy.\fOr is this about\nyour money?"),
  whatDoYouWantToDo: Strings.source("What do you want\nto do?"),
  storeMoney: Strings.source("How much do you\nwant to save?"),
  takeMoney: Strings.source("How much do you\nwant to take?"),
  saveMoney: Strings.source("Do you want to\nsave some money?"),
  haventSavedThatMuch: Strings.source("You haven't saved\nthat much."),
  notEnoughRoomInWallet: Strings.source("You can't take\nthat much."),
  insufficientFundsInWallet: Strings.source("You don't have\nthat much."),
  notEnoughRoomInBank: Strings.source("You can't save\nthat much."),
  startSavingMoney: Strings.source(
    "OK, I'll save your\nmoney. Trust me!\f{PLAYER}, stick\nwith it!"),
  storedMoney: Strings.source("Your money's safe\nhere! Get going!"),
  takenMoney: Strings.source("{PLAYER}, don't\ngive up!"),
  justDoWhatYouCan: Strings.source("Just do what\nyou can."),
};

// constants/script_constants.asm.
const YOUR_MONEY = 0; // Lua: Specials.lua:2201
const MOMS_MONEY = 1;
const MOM_MAX_MONEY = 999999;

// BankOfMom_MenuHeader: `menu_coords 0, 0, 10, 10`, STATICMENU_CURSOR, four
// items, cursor starting on GET.  Answers through the same "menu" yield
// Script_verticalmenu uses (the answer is the 1-based row).
// Lua: Specials.lua:2207
const BANK_MENU_HEADER = {
  left: 0, top: 0, right: 10, bottom: 10,
  dataFlags: 0x80, // STATICMENU_CURSOR
  items: ["GET", "SAVE", "CHANGE", "CANCEL"],
  cursor: 1,
};

// Lua: Specials.lua:2214
function bankMoney(vm: Vm, account: number): number {
  const h = hooks(vm);
  return lor(h.money && h.money(account), 0);
}

// Lua: Specials.lua:2219
function setBankMoney(vm: Vm, account: number, value: number): void {
  const h = hooks(vm);
  if (h.setMoney) {
    h.setMoney(account, Math.max(0, Math.min(value, MOM_MAX_MONEY)));
  }
}

// GiveMoney (engine/events/money.asm): adds, clamps at MAX_MONEY, and reports
// (the second element) whether the clamp fired.
// Lua: Specials.lua:2229
function giveMoneyClamped(vm: Vm, account: number, amount: number): [number, boolean] {
  const have = bankMoney(vm, account);
  const total = have + amount;
  if (total > MOM_MAX_MONEY) {
    setBankMoney(vm, account, MOM_MAX_MONEY);
    return [MOM_MAX_MONEY, true];
  }
  setBankMoney(vm, account, total);
  return [total, false];
}

// TakeMoney: subtracts, floors at 0 rather than borrowing.
// Lua: Specials.lua:2241
function takeMoneyFloored(vm: Vm, account: number, amount: number): number {
  const have = bankMoney(vm, account);
  if (amount > have) {
    setBankMoney(vm, account, 0);
    return 0;
  }
  setBankMoney(vm, account, have - amount);
  return have - amount;
}

// Mom_SetUpWithdrawMenu / Mom_SetUpDepositMenu's six-digit keypad
// (ui/BankOfMom).  `kind` is "deposit" or "withdraw"; the amount it hands back
// is unvalidated, exactly the way wStringBuffer2 is before StoreMoney/TakeMoney
// check it against the other account.
// Lua: Specials.lua:2256
function* bankOfMomAmount(vm: Vm, kind: string): Script<any> {
  const h = hooks(vm);
  if (!h.bankOfMomAmount) return undefined;
  const saved = bankMoney(vm, MOMS_MONEY);
  const held = bankMoney(vm, YOUR_MONEY);
  return yield* Specials.block(vm, (done) => {
    h.bankOfMomAmount(kind, saved, held, done);
  });
}

// Lua: Specials.lua:2265
function* transactionSfx(vm: Vm): Script<void> {
  yield { kind: "waitsfx" };
  const h = hooks(vm);
  if (h.playSfxNamed) h.playSfxNamed("Sfx_Transaction", 22);
  yield { kind: "waitsfx" };
}

// DSTChecks, data/text/common_3.asm's lines.
const DST_TEXT = {
  askDst: Strings.source("Do you want to\nswitch to Daylight\vSaving Time?"),
  dst: Strings.source("I set the clock\nforward by one\vhour."),
  askNotDst: Strings.source("Is Daylight Saving\nTime over?"),
  notDst: Strings.source("I put the clock\nback one hour."),
  askAdjust: Strings.source("Do you want to\nadjust your clock\ffor Daylight\nSaving Time?"),
  lostBooklet: Strings.source("I lost the in-\nstruction booklet\vfor the #GEAR.\fCome back again in\na while."),
};

// Not the Lua's (it skipped this arm): DSTChecks. An hour's move that would
// cross midnight -- turning DST on at 23:xx, or off at 0:xx -- is refused
// with Mom's lost booklet; otherwise YES moves the clock and flips the bit.
function* dstChecks(vm: Vm): Script<void> {
  const record = save(vm);
  if (!truthy(record)) return;
  record.rtc = lor(record.rtc, {});
  const dst = truthy(record.rtc.dst);
  const w = hooks(vm).world;
  const hour = lor(w && w.hour && w.hour(), Clock.hour(record));
  const minute = Clock.minute(record);
  if ((dst && hour === 0) || (!dst && hour === 23)) {
    yield* showRawHeld(vm, Strings.get(DST_TEXT.askAdjust));
    if (!truthy(yield { kind: "yesorno" })) return;
    yield* vm.showRaw(Strings.get(DST_TEXT.lostBooklet));
    return;
  }
  yield* showRawHeld(vm, Strings.get(dst ? DST_TEXT.askNotDst : DST_TEXT.askDst));
  if (!truthy(yield { kind: "yesorno" })) return;
  record.rtc.dst = !dst;
  Clock.setTime(record, hour + (dst ? -1 : 1), minute);
  yield* vm.showRaw(Strings.get(dst ? DST_TEXT.notDst : DST_TEXT.dst));
}

// Lua: Specials.lua:2272
H.BankOfMom = function* (vm: Vm): Script<void> {
  const record = save(vm);
  if (!truthy(record)) return;
  record.mom = lor(record.mom, {});
  const mom = record.mom;

  const justDoWhatYouCan = function* (): Script<void> {
    yield* vm.showRaw(Strings.get(MOM_TEXT.justDoWhatYouCan));
  };

  // .CheckIfBankInitialized / .InitializeBank: the very first visit, before
  // MOM_ACTIVE_F is ever set.  Skips IsThisAboutYourMoney entirely.
  if (!truthy(mom.active)) {
    // engine/events/mom.asm:50-53, PrintText then `call YesNoBox`.
    yield* showRawHeld(vm, Strings.get(MOM_TEXT.leaving1));
    const wantsToSave = yield { kind: "yesorno" };
    mom.active = true;
    if (truthy(wantsToSave)) {
      mom.savingMoney = true;
      yield* vm.showRaw(Strings.get(MOM_TEXT.leaving2));
    }
    yield* vm.showRaw(Strings.get(MOM_TEXT.leaving3));
    return;
  }

  // .IsThisAboutYourMoney
  // engine/events/mom.asm:71-74, the same PrintText / YesNoBox pair.
  yield* showRawHeld(vm, Strings.get(MOM_TEXT.isThisAboutMoney));
  const aboutMoney = yield { kind: "yesorno" };
  if (!truthy(aboutMoney)) {
    // .nope: DSTChecks, then her usual line
    yield* dstChecks(vm);
    yield* justDoWhatYouCan();
    return;
  }

  // .AccessBankOfMom
  yield* vm.showRaw(Strings.get(MOM_TEXT.whatDoYouWantToDo));
  const choice = yield { kind: "menu", style: "vertical", header: BANK_MENU_HEADER };

  if (choice === 1) {
    // .withdraw -> .TakeMoney
    while (true) {
      yield* vm.showRaw(Strings.get(MOM_TEXT.takeMoney));
      const amount = yield* bankOfMomAmount(vm, "withdraw");
      if (!truthy(amount) || amount === 0) {
        yield* justDoWhatYouCan();
        return;
      }
      if (amount > bankMoney(vm, MOMS_MONEY)) {
        yield* vm.showRaw(Strings.get(MOM_TEXT.haventSavedThatMuch));
      } else {
        const [, overflowed] = giveMoneyClamped(vm, YOUR_MONEY, amount);
        if (overflowed) {
          yield* vm.showRaw(Strings.get(MOM_TEXT.notEnoughRoomInWallet));
        } else {
          takeMoneyFloored(vm, MOMS_MONEY, amount);
          yield* transactionSfx(vm);
          yield* vm.showRaw(Strings.get(MOM_TEXT.takenMoney));
          return;
        }
      }
    }
  } else if (choice === 2) {
    // .deposit -> .StoreMoney
    while (true) {
      yield* vm.showRaw(Strings.get(MOM_TEXT.storeMoney));
      const amount = yield* bankOfMomAmount(vm, "deposit");
      if (!truthy(amount) || amount === 0) {
        yield* justDoWhatYouCan();
        return;
      }
      if (amount > bankMoney(vm, YOUR_MONEY)) {
        yield* vm.showRaw(Strings.get(MOM_TEXT.insufficientFundsInWallet));
      } else {
        const [, overflowed] = giveMoneyClamped(vm, MOMS_MONEY, amount);
        if (overflowed) {
          yield* vm.showRaw(Strings.get(MOM_TEXT.notEnoughRoomInBank));
        } else {
          takeMoneyFloored(vm, YOUR_MONEY, amount);
          yield* transactionSfx(vm);
          yield* vm.showRaw(Strings.get(MOM_TEXT.storedMoney));
          return;
        }
      }
    }
  } else if (choice === 3) {
    // .stopsaving -> .StopOrStartSavingMoney
    // engine/events/mom.asm:255-258, the same PrintText / YesNoBox pair.
    yield* showRawHeld(vm, Strings.get(MOM_TEXT.saveMoney));
    const wantsToSave = yield { kind: "yesorno" };
    if (truthy(wantsToSave)) {
      mom.savingMoney = true;
      yield* vm.showRaw(Strings.get(MOM_TEXT.startSavingMoney));
    } else {
      mom.savingMoney = false;
      yield* justDoWhatYouCan();
    }
  } else {
    // .cancel: CANCEL itself, or B.
    yield* justDoWhatYouCan();
  }
};

// ---- the Magnet Train ------------------------------------------------------
//
// MagnetTrain (engine/events/magnet_train.asm).  The routine READS wScriptVar
// and never writes it:
//
//     ld a, [wScriptVar]
//     and a
//     jr nz, .ToGoldenrod
//
// so the `setval FALSE` / `setval TRUE` in front of the two calls pick the
// direction, and vm.scriptVar comes back out exactly as it went in.  The ride
// is core/MagnetTrain and ui/MagnetTrainRide; World.magnetTrain is the push.
// With no hook the special is a no-op that leaves the script to warp.
// Lua: Specials.lua:2390
H.MagnetTrain = function* (vm: Vm): Script<void> {
  const h = hooks(vm);
  if (!h.magnetTrain) return;
  const toGoldenrod = (vm.scriptVar ?? 0) !== 0;
  yield* Specials.block(vm, (done) => {
    h.magnetTrain(toGoldenrod, () => done(true));
  });
};

// ---- the Cianwood photo studio ---------------------------------------------
//
// PhotoStudio (engine/events/print_photo.asm).  The yes/no gate and the
// surrounding textbox belong to the map script; PhotoStudio itself only runs
// after the player has said yes, and never writes wScriptVar.
//
// data/text/common_1.asm _WhichMonPhotoText/_HoldStillText/_PrestoAllDoneText/
// _NoPhotoText/_EggPhotoText, transcribed.
//
// farcall PrintPartymon (engine/printer/printer.asm) is the actual camera: it
// draws the portrait card (ui/PhotoStudio) and then SendScreenToPrinter walks
// it out the serial port.  There is no peripheral here, so `ldh a, [hPrinter]
// / and a / jr nz, .cancel` is hardwired to the nz arm: the portrait shows,
// then the print always comes back as though the printer errored.
// Lua: Specials.lua:2425
const PHOTO_STUDIO_TEXT = {
  whichMon: Strings.source("Which #MON\nshould I photo-\ngraph?"),
  holdStill: Strings.source("All righty. Hold\nstill for a bit."),
  noPhoto: Strings.source("Oh, no picture?\nCome again, OK?"),
  eggPhoto: Strings.source("An EGG? My talent\nis worth more…"),
};

// Lua: Specials.lua:2432
function* showPhotoStudio(vm: Vm, mon: Rec): Script<void> {
  const h = hooks(vm);
  if (!h.showPhotoStudio) return;
  yield* Specials.block(vm, (done) => {
    h.showPhotoStudio(mon, () => done(true));
  });
}

// Lua: Specials.lua:2440
H.PhotoStudio = function* (vm: Vm): Script<void> {
  yield* vm.showRaw(Strings.get(PHOTO_STUDIO_TEXT.whichMon));
  const [, mon] = yield* selectMon(vm, "choose");
  if (!truthy(mon)) {
    yield* vm.showRaw(Strings.get(PHOTO_STUDIO_TEXT.noPhoto));
    return;
  }

  // `ld a, [wCurPartySpecies] / cp EGG`: an egg slot is marked with `isEgg`.
  if (truthy(mon.isEgg)) {
    yield* vm.showRaw(Strings.get(PHOTO_STUDIO_TEXT.eggPhoto));
    return;
  }

  yield* vm.showRaw(Strings.get(PHOTO_STUDIO_TEXT.holdStill));
  yield* showPhotoStudio(vm, mon);
  // hPrinter reads as an error unconditionally; see the header comment.
  yield* vm.showRaw(Strings.get(PHOTO_STUDIO_TEXT.noPhoto));
};

// ---- 21 the quick save -----------------------------------------------------
//
// TryQuickSave (engine/link/link.asm:2356) is filed with the cable club but is
// not a link routine: it is `farcall Link_SaveGame`, TRUE on carry clear and
// FALSE on carry, then `ld c, 30 / call DelayFrames`.  Link_SaveGame
// (engine/menus/save.asm:63) is AskOverwriteSaveFile (:169) plus the ordinary
// write, so the FALSE arm is a refusal at the overwrite prompt -- what
// ../pokecrystal/maps/BattleTower1F.asm:84-85 backs a challenge out on.
//
// Two differences from the cart, neither observable in the answer:
// AskOverwriteSaveFile's mismatched-ID arm runs ErasePreviousSave (:333)
// first (Save.save replaces the whole file anyway), and SFX_SAVE rings at the
// write, where SaveMenu already puts it.

// data/text/common_2.asm:1279-1299.
// Lua: Specials.lua:2479
const SAVE_TEXT = {
  already: Strings.source("There is already a\nsave file. Is it\vOK to overwrite?"),
  another: Strings.source("There is another\nsave file. Is it\vOK to overwrite?"),
  saving: Strings.source("SAVING… DON'T TURN\nOFF THE POWER."),
  saved: Strings.source("%s saved\nthe game."),
};

// engine/menus/save.asm:247 the 16 frames under SAVING and :251 the 32 the
// write is followed by; :269 the 30 after the saved page, and link.asm:2367 the
// 30 TryQuickSave adds on top.  Both pages are `hold`s rather than `wait`s
// because the world does not tick while a box owns the stack (Vm.showRaw).
const SAVING_HOLD = 16 + 32; // Lua: Specials.lua:2492
const SAVED_HOLD = 30 + 30;

// Lua: Specials.lua:2495
H.TryQuickSave = function* (vm: Vm): Script<void> {
  const h = hooks(vm);
  // `ld a, [wSaveFileExists] / and a / jr z, .erase`, then
  // CompareLoadedAndSavedPlayerID (:212) picking which question is asked.
  let exists: any = false;
  let sameId: any = false;
  if (h.saveFileState) [exists, sameId] = multi(h.saveFileState());
  if (truthy(exists)) {
    yield* showRawHeld(vm, Strings.get(truthy(sameId) ? SAVE_TEXT.already : SAVE_TEXT.another));
    if (!truthy(yield { kind: "yesorno" })) {
      answer(vm, FALSE);
      return;
    }
  }
  yield* vm.showRaw(Strings.get(SAVE_TEXT.saving), true, SAVING_HOLD);
  // _SaveGameData (:273).  A veto from the save.write mod hook is the one way
  // this port can refuse a write the cart always completes, and a refusal is
  // the same FALSE the overwrite prompt's NO gives.
  if (!(h.writeSave && h.writeSave() !== false)) {
    answer(vm, FALSE);
    return;
  }
  if (h.playSfxNamed) h.playSfxNamed("Sfx_Save");
  const record = save(vm);
  const name = lor(truthy(record) && record.player ? record.player.name : undefined, "");
  yield* vm.showRaw(Strings.get(SAVE_TEXT.saved, name), true, SAVED_HOLD);
  answer(vm, TRUE);
};

// ---- the CABLE CLUB --------------------------------------------------------
//
// maps/PokeCenter2F.asm's three receptionists, the link rooms' machines, and
// the TIME CAPSULE's check, on the session core/CableClub.ts keeps (the same
// wire as the Kanto games', world/link.ts). The cart's own scripts run as
// they are; these are the routines they call.

function club(vm: Vm): CableClub | undefined {
  const h = hooks(vm);
  return h.cableClub ? h.cableClub() : undefined;
}

const LINK_TEXT = {
  canceled: Strings.source("The link has been\ncanceled."),
};

H.SetBitsForLinkTradeRequest = function (vm: Vm): void {
  club(vm)?.request("trade");
};
H.SetBitsForBattleRequest = function (vm: Vm): void {
  club(vm)?.request("battle");
};
H.SetBitsForTimeCapsuleRequest = function (vm: Vm): void {
  club(vm)?.request("capsule");
};

// engine/link/link.asm WaitForLinkedFriend: TRUE once another console has
// answered (said hello), FALSE when none does in the wait -- "Your friend is
// not ready."
H.WaitForLinkedFriend = function* (vm: Vm): Script<void> {
  const c = club(vm);
  if (!(c && c.open())) {
    answer(vm, FALSE);
    return;
  }
  const ok = yield* block(vm, (done) =>
    c.waitFor((s) => !!s.peerIdent, LINK_WAIT_FRAMES, (heard) => done(heard || c.heardPeer())));
  if (!ok) c.close();
  answer(vm, ok ? TRUE : FALSE);
};

// engine/link/link.asm CheckLinkTimeout_Receptionist: after the save, the two
// consoles still hear each other. Here: each side says its room and hears the
// other's. A partner whose wire speaks the other generation's terms (a Gen 1
// game at the TRADE CENTER, a TRADE CENTER at the TIME CAPSULE) is let through,
// for wOtherPlayerLinkMode and CheckBothSelectedSameRoom to say why not.
H.CheckLinkTimeout_Receptionist = function* (vm: Vm): Script<void> {
  const c = club(vm);
  const s = c?.session;
  if (!(c && s && c.heardPeer())) {
    answer(vm, FALSE);
    return;
  }
  if (!c.sameMode()) {
    answer(vm, TRUE);
    return;
  }
  s.chooseRoom(c.room());
  const ok = yield* block(vm, (done) => c.waitFor((x) => x.peerRoom !== null, LINK_WAIT_FRAMES, done));
  if (!ok) c.close();
  answer(vm, ok ? TRUE : FALSE);
};

H.CheckBothSelectedSameRoom = function (vm: Vm): void {
  answer(vm, club(vm)?.sameRoom() ? TRUE : FALSE);
};

H.FailedLinkToPast = function (vm: Vm): void {
  club(vm)?.close();
};
H.CloseLink = function (vm: Vm): void {
  club(vm)?.close();
};
H.WaitForOtherPlayerToExit = function (vm: Vm): void {
  club(vm)?.close();
};

// engine/link/link.asm:1970 CheckTimeCapsuleCompatibility: 1 a species from
// after the past (or an EGG), 2 a move from after it, 3 MAIL; the texts read
// the mon (and the move) from the string buffers.
H.CheckTimeCapsuleCompatibility = function (vm: Vm): void {
  const a = TimeCapsule.compatibility(data(vm), party(vm));
  if (a.code !== 0) {
    vm.stringBuffers = a.buffers;
    vm.stringBuffer = a.buffers[0] ?? "";
  }
  answer(vm, a.code);
};

H.EnterTimeCapsule = function (_vm: Vm): void {
  // the TIME CAPSULE's terms were set at the desk (SetBitsForTimeCapsuleRequest)
};

// TRUE for the ROM's player 2 (the right-hand seat), whose friend sits left.
H.CableClubCheckWhichChris = function (vm: Vm): void {
  answer(vm, club(vm)?.seat() === 1 ? TRUE : FALSE);
};

function* linkTrade(vm: Vm, capsule: boolean): Script<void> {
  const h = hooks(vm);
  const s = club(vm)?.session;
  if (!s || s.state === "closed") {
    yield* vm.showRaw(Strings.get(LINK_TEXT.canceled));
  } else if (h.openLinkTrade) {
    yield* block(vm, (done) => h.openLinkTrade(capsule, () => done()));
  }
  if (h.armLinkReturn) h.armLinkReturn();
}

H.TradeCenter = function* (vm: Vm): Script<void> {
  yield* linkTrade(vm, false);
};
H.TimeCapsule = function* (vm: Vm): Script<void> {
  yield* linkTrade(vm, true);
};

// The COLOSSEUM's machine: a link battle (core/LinkBattle2.ts), then the
// room's way out.
H.Colosseum = function* (vm: Vm): Script<void> {
  const h = hooks(vm);
  const c = club(vm);
  if (!c?.session || c.session.state === "closed" || !h.openLinkBattle) {
    yield* vm.showRaw(Strings.get(LINK_TEXT.canceled));
  } else {
    yield* block(vm, (done) => h.openLinkBattle(() => done()));
  }
  if (h.armLinkReturn) h.armLinkReturn();
};

// ---- 111 the dummy --------------------------------------------------------
// UnusedDummySpecial is a bare `ret`.  Listed so the name resolves to a
// handler rather than to the unimplemented ledger.
// Lua: Specials.lua:2524
H.UnusedDummySpecial = () => {};

// ---- 109-165 the Crystal rows ---------------------------------------------
// data/events/special_pointers.asm:124-181, the rows only Crystal has.

// ../pokecrystal/engine/pokemon/search_owned.asm:48 CheckOwnMonAnywhere: party then boxes,
// matching species, OT id and OT name; `ld a, [wPartyCount] / and a / ret z`.
// Lua: Specials.lua:2531
function ownsMonAnywhere(vm: Vm, wanted: any): boolean {
  const h = hooks(vm);
  const list = party(vm);
  if (list.length === 0) return false;
  const record = save(vm);
  const player = truthy(record) ? record.player : undefined;
  const owns = (mon: Rec): boolean => {
    if (!truthy(mon)) return false;
    if (!(h.monIndex && h.monIndex(mon.species) === wanted)) return false;
    if (truthy(player) && truthy(player.id) && truthy(mon.otId) && mon.otId !== player.id) {
      return false;
    }
    if (truthy(player) && truthy(player.name) && truthy(mon.ot) && mon.ot !== player.name) {
      return false;
    }
    return true;
  };
  for (const mon of list) {
    if (owns(mon)) return true;
  }
  for (const box of Object.values(lor(truthy(record) ? record.boxes : undefined, {}))) {
    for (const mon of lor(box, []) as Rec[]) {
      if (owns(mon)) return true;
    }
  }
  return false;
}

// ../pokecrystal/engine/pokemon/search_owned.asm:31
// Lua: Specials.lua:2560
H.MonCheck = (vm: Vm) => {
  answer(vm, ownsMonAnywhere(vm, vm.scriptVar) ? TRUE : FALSE);
};

// home/init.asm:1 falls into Init (home/init.asm:35) and on to the copyright
// splash, which is Game2.softReset rather than Game2.returnToTitle.
// Lua: Specials.lua:2566
H.Reset = (vm: Vm) => {
  const h = hooks(vm);
  if (h.softReset) h.softReset();
};

// ../pokecrystal/mobile/mobile_41.asm:320 is a bare `ret` with its SRAM counter left behind
// it as dead code, so a no-op is the whole routine.
// Lua: Specials.lua:2573
H.StubbedTrainerRankings_Healings = () => {};

// ../pokecrystal/mobile/mobile_41.asm:792: the international ROM answers 0 outright, which
// is what sends every Pokecenter 2F mobile branch down its cable arm.
// Lua: Specials.lua:2577
H.CheckMobileAdapterStatusSpecial = (vm: Vm) => {
  answer(vm, FALSE);
};

// ../pokecrystal/engine/events/battle_tower/battle_tower.asm:187 and :1580, both bare `ret`.
// Lua: Specials.lua:2582
H.UnusedBattleTowerDummySpecial1 = () => {};
H.UnusedBattleTowerDummySpecial2 = () => {};

// ../pokecrystal/engine/overworld/time.asm:136 SampleKenjiBreakCountdown:
// `call Random / and %11 / add 3`, three to six days into wKenjiBreakTimer,
// which ../pokecrystal/maps/Route45.asm:50 reads back through VAR_KENJI_BREAK.
// Lua: Specials.lua:2588
H.SampleKenjiBreakCountdown = (vm: Vm) => {
  const h = hooks(vm);
  if (h.setKenjiBreak) h.setKenjiBreak(Specials.random(4) - 1 + 3);
};

//--------------------------------------------------------------------------
// The deliberate stubs
//--------------------------------------------------------------------------
//
// Each carries the reason it is out of scope and the value it leaves in
// wScriptVar.  A stub is NOT the same thing as a missing handler: a special
// that falls through leaves a STALE wScriptVar behind, and the `iffalse` two
// commands later then takes whatever branch the last special happened to
// leave -- which is the exact failure this whole module exists to stop.
//
// `value = undefined` (Lua nil) means the routine genuinely does not write
// wScriptVar.
// Lua: Specials.lua:2604
const STUB_ROWS: Array<[string, number | undefined, string]> = [
  // (The link cable and Mystery Gift are ported: the CABLE CLUB and the link
  // record above, MYSTERY GIFT under "Mystery Gift".)
  // The Game Boy Printer.  None of the three specials that want it is stubbed
  // any more (PhotoStudio, UnownPrinter above; PrintDiploma in
  // specials/crystal_extras).  The row below is superseded by that handler
  // and survives only as the reason.
  ["PrintDiploma", undefined, "printer: no Game Boy Printer"],
  // ../pokecrystal/data/events/special_pointers.asm:58 and pokegold's :63 both
  // carry `add_special UnusedMemoryGame ; unused`, and no script names it.
  ["UnusedMemoryGame", undefined, "unused on both carts; no script reaches _MemoryGame"],
  // data/events/special_pointers.asm:124-181, the rows only Crystal has.
  ["BattleTowerRoomMenu", 10, "Battle Tower: $a is the menu's back-out arm"],
  ["BattleTowerBattle", undefined, "Battle Tower: no tower battle to run"],
  ["BattleTowerAction", 0, "Battle Tower: 0 is sGSBallFlag clear"],
  ["CheckForBattleTowerRules", 0, "Battle Tower: no challenge in progress"],
  ["Menu_ChallengeExplanationCancel", 0, "Battle Tower: 0 ends the talk"],
  ["LoadOpponentTrainerAndPokemonWithOTSprite", 0, "Battle Tower: no roster"],
  ["BattleTowerMobileError", undefined, "Battle Tower: no mobile error to report"],
  ["Function1700ba", undefined, "Battle Tower: mobile challenge setup"],
  ["Function170114", undefined, "Battle Tower: mobile challenge setup"],
  ["Function1704e1", undefined, "Battle Tower: mobile challenge setup"],
  ["AskMobileOrCable", 0, "Mobile System GB: 0 is a B press off the menu"],
  ["Mobile_SelectThreeMons", 0, "Mobile System GB: no three mons picked"],
  ["Function1011f1", undefined, "Mobile System GB: enters LINK_MOBILE"],
  ["Function101220", undefined, "Mobile System GB: leaves LINK_MOBILE"],
  ["Function101225", 0, "Mobile System GB: mobile trade room teardown"],
  ["Function101231", 0, "Mobile System GB: mobile battle room teardown"],
  ["Function102142", undefined, "Mobile System GB: mobile news feed"],
  ["Function103780", 0, "Mobile System GB: the mobile save never happens"],
  ["Function1037c2", 0, "Mobile System GB: no rematch on same settings"],
  ["Function1037eb", 0, "Mobile System GB: no battle time is left"],
  ["Function10383c", 0, "Mobile System GB: the three-mon pick cancels"],
  ["Function10387b", undefined, "Mobile System GB: adapter status readback"],
  ["TradeCornerHoldMon", undefined, "Mobile System GB: no mobile trade corner"],
  ["Function11ac3e", undefined, "Mobile System GB: trade corner submenu"],
  ["Function11b5e8", undefined, "Mobile System GB: trade corner submenu"],
  ["Function11b7e5", undefined, "Mobile System GB: trade corner submenu"],
  ["Function11b879", 0, "Mobile System GB: trade corner submenu"],
  ["Function11b920", undefined, "Mobile System GB: trade corner submenu"],
  ["Function11b93b", undefined, "Mobile System GB: trade corner submenu"],
  ["Function11ba38", 0, "Mobile System GB: trade corner submenu"],
  ["Function17d2b6", undefined, "Mobile System GB: mobile menu chrome"],
  ["Function17d2ce", 0, "Mobile System GB: mobile menu chrome"],
  ["Function11c1ab", undefined, "Mobile System GB: the fixed-word entry screen"],
  ["UnusedFindItemInPCOrBag", 0, "Mobile System GB: unreferenced"],
  ["GiveOddEgg", undefined, "the Odd Egg roster is not ported; Route 34 is later"],
  ["DisplayUnownWords", undefined, "needs the Unown wall word box"],
  ["HoOhChamber", undefined, "the Ruins of Alph secret chambers are not ported"],
  ["OmanyteChamber", undefined, "the Ruins of Alph secret chambers are not ported"],
  ["PokeSeer", undefined, "needs the Seer's caught-data page"],
  ["BeastsCheck", 0, "the three beasts cannot all be owned this early"],
  ["BuenasPassword", 0, "Buena's show is not ported; 0 is a wrong guess"],
  ["BuenaPrize", undefined, "Buena's prize counter is not ported"],
  ["AskRememberPassword", 0, "Buena's show is not ported; 0 declines"],
  ["CelebiShrineEvent", undefined, "the GS Ball event needs the mobile stadium"],
  ["CheckCaughtCelebi", 0, "the GS Ball event never runs, so Celebi is free"],
  ["GiveDratini", undefined, "the Dragon Shrine moveset swap is past Phase 1"],
  ["MoveTutor", 255, "the tutor is past Phase 1; -1 is its cancel arm"],
];

//--------------------------------------------------------------------------
// The module
//--------------------------------------------------------------------------

export const Specials = {
  // Rolls.  Kept on the module rather than taken from the VM so a test can pin
  // every weighted table without reaching into the rng, and so the two calling
  // conventions (`random(n) -> 1..n` here, `random(n) -> 0..n-1` in battle/)
  // cannot get crossed.  Assignable.
  random: random as (m?: number, n?: number) => number, // Lua: Specials.lua:82

  // Lua: Specials.lua:100
  block,

  // Lua: Specials.lua:185
  shared: {
    TRUE,
    FALSE,
    block,
    hooks,
    party,
    save,
    data,
    answer,
    nameMon,
    selectMon,
    showRawHeld,
  },

  MAGIKARP_LENGTHS, // Lua: Specials.lua:207
  magikarpLength, // Lua: Specials.lua:258
  magikarpLengthText, // Lua: Specials.lua:298
  dvWord, // Lua: Specials.lua:303

  // Lua: Specials.lua:371
  get BUG_CONTEST_BALLS(): any {
    return BugContest.BALLS;
  },
  askNickname, // Lua: Specials.lua:388

  // Lua: Specials.lua:1336
  get NUM_BUG_CONTESTANTS(): any {
    return BugContest.NUM_CONTESTANTS;
  },
  get BUG_CONTESTANTS_PICKED(): any {
    return BugContest.CONTESTANTS_PICKED;
  },

  // Lua: Specials.lua:1362
  MANIA_OT_ID: 518,
  MANIA_OT: "MANIA",
  SHUCKIE_NICKNAME: "SHUCKIE",
  SHUCKIE_LEVEL: 15,

  // Lua: Specials.lua:1406
  SHUCKIE_WRONG_MON: 0,
  SHUCKIE_REFUSED: 1,
  SHUCKIE_RETURNED: 2,
  SHUCKIE_HAPPY: 3,
  SHUCKIE_FAINTED: 4,
  // .HappyToStayWithYou's threshold: 150 happiness or better and Mania lets
  // you keep Shuckie instead of taking it back.
  SHUCKIE_HAPPY_THRESHOLD: 150, // Lua: Specials.lua:1414

  trailingDigitsShared, // Lua: Specials.lua:1508
  luckyNumberBoxOrder, // Lua: Specials.lua:1524
  luckyPrizeFor, // Lua: Specials.lua:1532
  daysUntilFriday, // Lua: Specials.lua:1541

  // Lua: Specials.lua:1823
  SNORLAX_PROXIMITY: [
    [33, 8], [34, 10], [35, 10], [36, 8], [36, 9],
  ] as Array<[number, number]>,
  POKE_FLUTE_SONG: "Music_PokeFluteChannel", // Lua: Specials.lua:1826

  HAIRCUT_TABLES, // Lua: Specials.lua:1862
  // Lua: Specials.lua:1884 (a getter: Happiness's table is read, not copied)
  get HAPPINESS_CHANGES(): Record<string, any> {
    return happinessChanges();
  },

  // ChangeHappiness itself, which is Happiness.change: the band pick, the $ff
  // and 0 carry clamps, and the `cp EGG / ret z`.
  // Lua: Specials.lua:1896
  changeHappiness(mon: Rec, action: string): void {
    Happiness.change(mon, action);
  },

  // The whose-PC menu's PROF.OAK's PC row runs ProfOaksPC's rating flow
  // inside a screen, so the counts, the rating pick and the two OakPC texts
  // are exported here rather than transcribed a second time.
  dstChecks, // Mom's DST arm, for the tests
  dexCounts, // Lua: Specials.lua:2059
  findOakRating,
  OAK_PC_TEXT,

  // Lua: Specials.lua:2114
  get ROAMERS(): any {
    return Roamers.SPECIES;
  },

  HANDLERS: H, // Lua: Specials.lua:2696

  // data/events/special_pointers.asm:124-181, the "; Crystal only" block: one
  // module per owner under script/specials/, merged into HANDLERS here.
  // Lua: Specials.lua:2700
  MODULES: ["crystal_story", "battle_tower", "crystal_extras", "unown_words"],

  HANDLER_SOURCE: Object.create(null) as Record<string, string>, // Lua: Specials.lua:2707

  STUBS: Object.create(null) as Record<string, SpecialHandler>, // Lua: Specials.lua:2710
  STUB_REASONS: Object.create(null) as Record<string, string>,
  SUPERSEDED_STUBS: Object.create(null) as Record<string, string>,

  // The dispatch table Vm.SPECIALS is.  Built rather than written out so the
  // two sets cannot drift, and so a name that ends up in both is a hard error
  // here rather than a silent shadow at runtime.
  ALL: Object.create(null) as Record<string, SpecialHandler>, // Lua: Specials.lua:2717

  // Lua: Specials.lua:2746
  merge(handlers: unknown, source: string): Record<string, SpecialHandler> {
    if (typeof handlers !== "object" || handlers === null) {
      throw new Error("gen2 specials module '" + tostring(source) + "' returned "
        + luaType(handlers) + ", expected a table of name -> function");
    }
    const table = handlers as Record<string, unknown>;
    // (JS object keys are always strings, so only the value is checked.)
    for (const name of Object.keys(table)) {
      const fn = table[name];
      if (typeof fn !== "function") {
        throw new Error("gen2 specials module '" + tostring(source)
          + "' entry [" + tostring(name) + "] is not name -> function");
      }
      const owner = Specials.HANDLER_SOURCE[name];
      if (owner !== undefined) {
        throw new Error("gen2 special '" + name + "' is defined twice: "
          + owner + " and " + tostring(source));
      }
      H[name] = fn as SpecialHandler;
      Specials.HANDLER_SOURCE[name] = source;
    }
    rebuild();
    return table as Record<string, SpecialHandler>;
  },
};

// Lua: Specials.lua:2708
for (const name of Object.keys(H)) Specials.HANDLER_SOURCE[name] = "Specials.lua";

// Lua: Specials.lua:2719
function clear(t: Record<string, unknown>): void {
  for (const key of Object.keys(t)) delete t[key];
}

// Lua: Specials.lua:2723
function rebuild(): void {
  clear(Specials.STUBS);
  clear(Specials.STUB_REASONS);
  clear(Specials.SUPERSEDED_STUBS);
  clear(Specials.ALL);
  for (const row of STUB_ROWS) {
    const [name, value, reason] = row;
    if (H[name]) {
      if (Specials.HANDLER_SOURCE[name] === "Specials.lua") {
        throw new Error("gen2 special '" + name + "' is both implemented and stubbed");
      }
      Specials.SUPERSEDED_STUBS[name] = reason;
    } else {
      Specials.STUB_REASONS[name] = reason;
      Specials.STUBS[name] = (vm: Vm) => {
        if (value !== undefined) vm.scriptVar = value;
      };
    }
  }
  for (const name of Object.keys(H)) Specials.ALL[name] = H[name]!;
  for (const name of Object.keys(Specials.STUBS)) Specials.ALL[name] = Specials.STUBS[name]!;
}

// The module merge (Lua: Specials.lua:2770).  The Lua registers Specials in
// package.loaded first so the modules can require it back; here `Specials` is
// already initialised above, and the modules only read it inside handlers.
// Each import is a live binding: if an import cycle reached this file through
// one of the modules first, that module is not initialised yet, and that is
// reported rather than merged as nothing.
const MODULE_TABLES: Record<string, () => unknown> = {
  crystal_story: () => crystal_story,
  battle_tower: () => battle_tower,
  crystal_extras: () => crystal_extras,
  unown_words: () => unown_words,
};
for (const name of Specials.MODULES) {
  let handlers: unknown;
  try {
    handlers = MODULE_TABLES[name]!();
  } catch (e) {
    handlers = undefined;
  }
  if (handlers === undefined) {
    throw new Error("gen2 specials module 'specials/" + name + ".ts' is not initialised yet: "
      + "an import cycle reached Specials.ts through it; import Specials.ts (or Vm.ts) first");
  }
  Specials.merge(handlers, "specials/" + name + ".lua");
}

rebuild(); // Lua: Specials.lua:2775

export default Specials;
