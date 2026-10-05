// Port of gen1recomp src/core/game3/scripting/natives_moveteach.lua (GPLv3 + additional terms; see LICENSE.md).
// pokefirered/src/party_menu_specials.c:24, pokefirered/src/learn_move.c:367
// Move Relearner, Move Deleter, move tutors and the Cape Brink tutor.
//
// Port notes:
// - Handlers return Lua's multiple returns as a 0-based tuple (see natives.ts).
// - require / package.loaded / pcall(require, ...): modules in the bundle are
//   static imports used exactly as Brian guards them. A stubbed screen
//   (ui/party_menu, ui/summary_menu) loads, and calling it throws
//   NotPortedError, as the brief says for a pcall(require) of a stub.
//   "src.ui.game3.move_relearner" (and the RSE one) have no file in the port:
//   they are looked up in G3Lazy, a missing entry being the failed require.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { truthy, tonumber } from "../../../../import/gen3/lua.ts";
import Std from "./stdscripts.ts";
import MoveLearn from "../move_learn.ts";
import Flags from "./flags.ts";
import Runtime, { G3Lazy } from "../runtime.ts";
import Space from "./space.ts";
import Message from "../../ui/message.ts";
import Fade from "../../ui/fade.ts";
import Profile from "../profile.ts";
import Pokemon from "../pokemon.ts";
import { SummaryMenu } from "../../ui/summary_menu.ts";
import { PartyMenu } from "../../ui/party_menu.ts";
import Natives, { type Handler } from "./natives.ts";

/** Lua's `a or b`. */
function lor<A, B>(a: A, b: B): A | B {
  return truthy(a) ? a : b;
}

// pokefirered/data/specials.inc:230
const SPECIAL_CHOOSE_MON_FOR_MOVE_RELEARNER = 0xDB;
// pokefirered/data/specials.inc:231
const SPECIAL_SELECT_MOVE_DELETER_MOVE = 0xDC;
// pokefirered/data/specials.inc:232
const SPECIAL_MOVE_DELETER_FORGET_MOVE = 0xDD;
// pokefirered/data/specials.inc:233
const SPECIAL_BUFFER_MOVE_DELETER_NICKNAME_AND_MOVE = 0xDE;
// pokefirered/data/specials.inc:234
const SPECIAL_GET_NUM_MOVES_SELECTED_MON_HAS = 0xDF;
// pokefirered/data/specials.inc:235
const SPECIAL_TEACH_MOVE_RELEARNER_MOVE = 0xE0;
// pokefirered/data/specials.inc:408
const SPECIAL_CHOOSE_MON_FOR_MOVE_TUTOR = 0x18D;
// pokefirered/data/specials.inc:430
const SPECIAL_CAPE_BRINK_GET_MOVE = 0x1A3;
// pokefirered/data/specials.inc:431
const SPECIAL_HAS_LEARNED_ALL_CAPE_BRINK = 0x1A4;

const VAR_RESULT = 0x800D; // pokefirered/include/constants/vars.h:328
const VAR_0x8004 = 0x8004; // pokefirered/include/constants/vars.h:319
const VAR_0x8005 = 0x8005; // pokefirered/include/constants/vars.h:320
const VAR_0x8006 = 0x8006; // pokefirered/include/constants/vars.h:321
const VAR_0x8007 = 0x8007; // pokefirered/include/constants/vars.h:322

const PARTY_SIZE = 6; // pokefirered/include/constants/global.h:78
const MAX_MON_MOVES = 4; // pokefirered/include/constants/global.h:77
// pokefirered/include/constants/party_menu.h:62
const PARTY_MENU_TYPE_MOVE_RELEARNER = 7;

// Lua: natives_moveteach.lua:50
function flagsMod(): typeof Flags {
  return Flags;
}

// Lua: natives_moveteach.lua:54
function varGet(ctx: any, id: number): number {
  let v = tonumber(flagsMod().getVar(undefined, ctx, id)) ?? 0;
  if (v === 0 && ctx && typeof ctx.getVar === "function") {
    v = tonumber(ctx.getVar(id)) ?? 0;
  }
  return v;
}

// Lua: natives_moveteach.lua:62
function varSet(ctx: any, id: number, value: any): void {
  flagsMod().setVar(undefined, ctx, id, value);
  if (ctx && typeof ctx.setVar === "function") ctx.setVar(id, value);
}

// Lua: natives_moveteach.lua:67
function sessionOf(): any {
  // package.loaded["src.core.game3.runtime"]
  const rt = Runtime;
  return lor(rt && rt.getSession && rt.getSession(), undefined);
}

// Lua: natives_moveteach.lua:72
function flagStore(): any {
  // package.loaded["src.core.game3.scripting.space"]
  const session = sessionOf();
  return lor(lor(Space && Space.store, session && session.store), undefined);
}

// Lua: natives_moveteach.lua:78
function chosenMon(ctx: any): [any, any] {
  const session = sessionOf();
  const party = session && session.party;
  const slot = varGet(ctx, VAR_0x8004);
  if (!truthy(party) || slot >= PARTY_SIZE) return [undefined, session];
  return [party[slot + 1], session];
}

// Lua: natives_moveteach.lua:86
function tickVm(): void {
  // package.loaded["src.core.game3.scripting.space"]
  if (Space && Space.vm) Space.vm.tick();
}

// Lua: natives_moveteach.lua:92
// pokefirered/src/scrcmd.c:1697 ScrCmd_bufferstring
function setStringVar(ctx: any, adapters: any, index: number, text: string): void {
  if (adapters && truthy(adapters.setStringVar)) adapters.setStringVar(index, text);
  if (ctx && truthy(ctx.stringVars)) ctx.stringVars[index] = text;
}

// Lua: natives_moveteach.lua:97
function closeMessage(): void {
  // pcall(require, "src.ui.game3.message")
  if (Message && Message.isOpen && Message.isOpen() && Message.close) {
    Message.close();
  }
}

// Lua: natives_moveteach.lua:105
// pokefirered/src/party_menu_specials.c:38, pokefirered/src/party_menu.c:6317
function takeScreen(): () => void {
  // pcall(require, "src.ui.game3.fade")
  const F: any = Fade;
  if (!(F && F.begin && F.MODE)) return () => {};
  const covered = !(F.isActive && F.isActive()) && (tonumber(F.t) ?? 0) >= 16;
  if (!(covered && F.mode === F.MODE.TO_BLACK)) return () => {};
  F.clear();
  return () => {
    F.begin(F.MODE.FROM_BLACK, 1, () => {});
  };
}

const BY_NAME: Record<string, Handler> = {
  // Lua: natives_moveteach.lua:118
  // pokefirered/src/party_menu_specials.c:24
  ChooseMonForMoveRelearner: (ctx, adapters) => {
    let applied = false;
    const apply = (): void => {
      if (applied) return;
      applied = true;
      // pokefirered/src/party_menu.c:1201
      varSet(ctx, VAR_0x8005, MoveLearn.countRelearnableMoves(chosenMon(ctx)[0]));
    };
    const yielded = Natives.choosePartyMon(ctx, adapters, PARTY_MENU_TYPE_MOVE_RELEARNER);
    if (!yielded) {
      apply();
      return [false];
    }
    const closedPoll = ctx.nativePoll;
    ctx.nativePoll = (): boolean => {
      if (truthy(closedPoll) && !closedPoll()) return false;
      apply();
      return true;
    };
    return [true];
  },
  // Lua: natives_moveteach.lua:141
  // pokefirered/src/learn_move.c:367
  TeachMoveRelearnerMove: (ctx, adapters) => {
    const [mon, session] = chosenMon(ctx);
    let screen = "src.ui.game3.move_relearner";
    if (Profile.family(session) === "rse") {
      // pokeemerald/src/move_relearner.c:373
      screen = "src.ui.game3.rse.move_relearner";
    }
    // pcall(require, screen): no file in the port (see the port notes)
    const MoveRelearner = G3Lazy[screen];
    const okUi = MoveRelearner != null;
    if (!(truthy(mon) && okUi && typeof MoveRelearner === "object" && truthy(MoveRelearner.show))) {
      varSet(ctx, VAR_0x8004, 0);
      return [false];
    }
    return [Natives.yieldHost(ctx, adapters, (done) => {
      // pcall(require, "src.ui.game3.message")
      if (Message && Message.isOpen && Message.isOpen() && Message.close) {
        Message.close();
      }
      MoveRelearner.show(mon, {
        session,
        onDone: (learned: any) => {
          // pokefirered/src/learn_move.c:519
          varSet(ctx, VAR_0x8004, truthy(learned) ? 1 : 0);
          done();
          tickVm();
        },
      });
    })];
  },
  // Lua: natives_moveteach.lua:171
  // pokefirered/src/party_menu_specials.c:44
  SelectMoveDeleterMove: (ctx, adapters) => {
    const [mon, session] = chosenMon(ctx);
    // pcall(require, "src.ui.game3.summary_menu"): a stub until ported
    const SM: any = SummaryMenu;
    if (!(truthy(mon) && SM != null && typeof SM === "object" && truthy(SM.openMenu))) {
      varSet(ctx, VAR_0x8005, MAX_MON_MOVES);
      return [false];
    }
    const slot = varGet(ctx, VAR_0x8004) + 1;
    const restore = takeScreen();
    return [Natives.yieldHost(ctx, adapters, (done) => {
      closeMessage();
      // pokefirered/src/pokemon_summary_screen.c:1050 ShowSelectMovePokemonSummaryScreen
      SM.openMenu(session && session.party, slot, {
        session,
        mode: "select_move",
        // pokefirered/src/party_menu_specials.c:47
        forgetMove: true,
        onSelectMove: (slotIdx: any) => {
          // pokefirered/src/pokemon_summary_screen.c:3859
          varSet(ctx, VAR_0x8005, tonumber(slotIdx) ?? MAX_MON_MOVES);
          restore();
          done();
          tickVm();
        },
      });
    })];
  },
  // Lua: natives_moveteach.lua:200
  // pokefirered/src/party_menu_specials.c:92
  MoveDeleterForgetMove: (ctx) => {
    const [mon] = chosenMon(ctx);
    if (!truthy(mon)) return [false];
    MoveLearn.forgetMove(mon, varGet(ctx, VAR_0x8005));
    return [false];
  },
  // Lua: natives_moveteach.lua:207
  // pokefirered/src/party_menu_specials.c:61
  BufferMoveDeleterNicknameAndMove: (ctx, adapters) => {
    const [mon] = chosenMon(ctx);
    if (!truthy(mon)) return [false];
    setStringVar(ctx, adapters, 1, Pokemon.displayMonName(mon));
    const moveId = Pokemon.moveIdAt(mon, varGet(ctx, VAR_0x8005) + 1);
    setStringVar(ctx, adapters, 2, lor(Pokemon.moveName(moveId), ""));
    return [false];
  },
  // Lua: natives_moveteach.lua:217
  // pokefirered/src/party_menu_specials.c:50
  GetNumMovesSelectedMonHas: (ctx) => {
    const [mon] = chosenMon(ctx);
    varSet(ctx, VAR_RESULT, truthy(mon) ? Pokemon.moveSlotCount(mon) : 0);
    return [false];
  },
  // Lua: natives_moveteach.lua:224
  // pokefirered/src/party_menu.c:5793 ChooseMonForMoveTutor
  ChooseMonForMoveTutor: (ctx, adapters) => {
    // pokefirered/src/party_menu.c:855
    varSet(ctx, VAR_RESULT, 0);
    const tutor = varGet(ctx, VAR_0x8005);
    const session = sessionOf();
    const party = session && session.party;
    // pcall(require, "src.ui.game3.party_menu"): a stub until ported
    const PM: any = PartyMenu;
    if (!(truthy(party) && truthy(party[1]) && PM != null && typeof PM === "object" && truthy(PM.show))) {
      return [false];
    }
    let auto: number | undefined = undefined;
    let tutorCount = MoveLearn.TUTOR_MOVE_COUNT;
    if (Profile.family() === "rse") {
      tutorCount = MoveLearn.tutorMoveCount();
    }
    if (tutor >= tutorCount) {
      // pokefirered/src/party_menu.c:5814
      auto = varGet(ctx, VAR_0x8007) + 1;
    }
    const restore = takeScreen();
    return [Natives.yieldHost(ctx, adapters, (done) => {
      closeMessage();
      PM.show(party, undefined, {
        mode: "move_tutor",
        tutor,
        autoSlot: auto,
        session,
        onClose: () => {
          // pokefirered/src/party_menu.c:4841
          varSet(ctx, VAR_RESULT, truthy(PM._tutorResult) ? 1 : 0);
          restore();
          done();
          tickVm();
        },
      });
    })];
  },
  // Lua: natives_moveteach.lua:263
  // pokefirered/src/field_specials.c:2219 CapeBrinkGetMoveToTeachLeadPokemon
  CapeBrinkGetMoveToTeachLeadPokemon: (ctx, adapters) => {
    const session = sessionOf();
    const party = lor(session && session.party, {} as any);
    const lead = MoveLearn.leadMonIndex(party);
    varSet(ctx, VAR_0x8007, lead);
    const mon = party[lead + 1];
    const row = MoveLearn.capeBrinkRow(mon);
    if (!row) {
      varSet(ctx, VAR_RESULT, 0);
      return [false];
    }
    setStringVar(ctx, adapters, 2, lor(Pokemon.moveName(row.move), ""));
    varSet(ctx, VAR_0x8005, row.tutor);
    if (flagsMod().getFlag(flagStore(), ctx, row.flag)) {
      varSet(ctx, VAR_RESULT, 0);
      return [false];
    }
    varSet(ctx, VAR_0x8006, Pokemon.moveSlotCount(mon));
    varSet(ctx, VAR_RESULT, 1);
    return [false];
  },
  // Lua: natives_moveteach.lua:286
  // pokefirered/src/field_specials.c:2274 HasLearnedAllMovesFromCapeBrinkTutor
  HasLearnedAllMovesFromCapeBrinkTutor: (ctx) => {
    const tutor = varGet(ctx, VAR_0x8005);
    const F = flagsMod();
    const store = flagStore();
    // (MoveLearn.CAPE_BRINK keeps Lua's keys 0..2: slot 0 is used)
    let burn = MoveLearn.CAPE_BRINK[2]!;
    for (let i = 0; i <= 1; i++) {
      if (MoveLearn.CAPE_BRINK[i]!.tutor === tutor) burn = MoveLearn.CAPE_BRINK[i]!;
    }
    F.setFlag(store, ctx, burn.flag, true);
    let count = 0;
    for (let i = 0; i <= 2; i++) {
      if (F.getFlag(store, ctx, MoveLearn.CAPE_BRINK[i]!.flag)) count = count + 1;
    }
    varSet(ctx, VAR_RESULT, count === 3 ? 1 : 0);
    return [false];
  },
};

export const MoveTeach = {
  SPECIAL: {
    ChooseMonForMoveRelearner: SPECIAL_CHOOSE_MON_FOR_MOVE_RELEARNER,
    SelectMoveDeleterMove: SPECIAL_SELECT_MOVE_DELETER_MOVE,
    MoveDeleterForgetMove: SPECIAL_MOVE_DELETER_FORGET_MOVE,
    BufferMoveDeleterNicknameAndMove: SPECIAL_BUFFER_MOVE_DELETER_NICKNAME_AND_MOVE,
    GetNumMovesSelectedMonHas: SPECIAL_GET_NUM_MOVES_SELECTED_MON_HAS,
    TeachMoveRelearnerMove: SPECIAL_TEACH_MOVE_RELEARNER_MOVE,
    ChooseMonForMoveTutor: SPECIAL_CHOOSE_MON_FOR_MOVE_TUTOR,
    CapeBrinkGetMoveToTeachLeadPokemon: SPECIAL_CAPE_BRINK_GET_MOVE,
    HasLearnedAllMovesFromCapeBrinkTutor: SPECIAL_HAS_LEARNED_ALL_CAPE_BRINK,
  } as Record<string, number>,

  BY_NAME,
  /** Set by Std.legacyHandlers (stdscripts.lua:262): special id -> handler. */
  HANDLERS: undefined as Record<number, Handler> | undefined,
};
// Lua: natives_moveteach.lua:303
Std.legacyHandlers(MoveTeach);

export default MoveTeach;
