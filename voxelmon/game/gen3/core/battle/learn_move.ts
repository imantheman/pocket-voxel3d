// Port of gen1recomp src/core/game3/battle/learn_move.lua (GPLv3 + additional terms; see LICENSE.md).
// In-battle / post-battle learn-move flow (pret handlelearnnewmove).
// Driven by ROM learnsets via Pokemon.movesLearnedAt.
// Choices open only after the message queue is idle (see LearnMove.pump).
//
// Port notes:
// - Pokemon.teachMove / replaceMove return tuples; their first value is taken.
// - The `(.-)\\p` page split uses lpattern's gmatch.
// - pcall around Audio.playFanfare: errors are swallowed as in Lua.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { tonumber, truthy } from "../../../../import/gen3/lua.ts";
import { len, ipairs, type LuaTable } from "../../platform/lt.ts";
import { gmatch } from "../../platform/lpattern.ts";
import Pokemon from "../pokemon.ts";
import Strings from "../../shared/core/Strings.ts";
import RomText from "../rom_text.ts";
import BattleText from "./battle_text.ts";
import BattleProfile from "./profile.ts";
import Audio from "../audio.ts";

type Fn = (...a: any[]) => any;

export interface LearnMoveModule {
  _active: boolean;
  _mon: any;
  _moveId: number | null | undefined;
  _name: string | null | undefined;
  _moveName: string | null | undefined;
  _pushMsg: Fn | null | undefined;
  _askYesNo: Fn | null | undefined;
  _askForget: Fn | null | undefined;
  _onDone: Fn | null | undefined;
  _headless: boolean;
  _waitingChoice: boolean;
  _forgetSlots: LuaTable | null | undefined;
  _battleText?: boolean;
  _relearner?: boolean;
  _queue?: LuaTable | null;
  _queueIdx?: number;
  _queueOpts?: any;
  reset(): void;
  busy(): boolean;
  waitingChoice(): boolean;
  pump(): boolean;
  begin(opts?: any): void;
  movesForLevels(mon: any, levels: LuaTable | null | undefined): LuaTable;
  beginQueue(mon: any, levels: LuaTable | null | undefined, opts?: any): boolean;
}

export const LearnMove = {} as LearnMoveModule;

LearnMove._active = false;
LearnMove._mon = undefined;
LearnMove._moveId = undefined;
LearnMove._name = undefined;
LearnMove._moveName = undefined;
LearnMove._pushMsg = undefined;
LearnMove._askYesNo = undefined;
LearnMove._askForget = undefined;
LearnMove._onDone = undefined;
LearnMove._headless = false;
LearnMove._waitingChoice = false;
LearnMove._forgetSlots = undefined;

// Lua: learn_move.lua:25
LearnMove.reset = function (): void {
  LearnMove._active = false;
  LearnMove._mon = undefined;
  LearnMove._moveId = undefined;
  LearnMove._name = undefined;
  LearnMove._moveName = undefined;
  LearnMove._pushMsg = undefined;
  LearnMove._askYesNo = undefined;
  LearnMove._askForget = undefined;
  LearnMove._onDone = undefined;
  LearnMove._waitingChoice = false;
  LearnMove._forgetSlots = undefined;
  LearnMove._battleText = false;
  LearnMove._relearner = false;
  LearnMove._queue = undefined;
  LearnMove._queueIdx = 0;
  LearnMove._queueOpts = undefined;
};

// Lua: learn_move.lua:44
LearnMove.busy = function (): boolean {
  return LearnMove._active === true;
};

// Lua: learn_move.lua:48
LearnMove.waitingChoice = function (): boolean {
  return LearnMove._waitingChoice === true;
};

// Lua: learn_move.lua:52
function finish(learned: any): void {
  const cb = LearnMove._onDone;
  LearnMove._active = false;
  LearnMove._mon = undefined;
  LearnMove._moveId = undefined;
  LearnMove._waitingChoice = false;
  LearnMove._onDone = undefined;
  // Leave _queue / _queueOpts for beginQueue's onDone → queue_next
  if (truthy(cb)) cb!(learned === true);
}

// Lua: learn_move.lua:63
function say(text: any, cb?: Fn): void {
  if (truthy(LearnMove._pushMsg) && truthy(text)) {
    LearnMove._pushMsg!(text, cb);
  } else if (truthy(cb)) {
    cb!();
  }
}

// Lua: learn_move.lua:71
function move_name(moveId: any): string {
  return Pokemon.moveName(moveId);
}

// Lua: learn_move.lua:80
function T(battle: any, field: any, relearner?: any): any {
  let v: any;
  if (LearnMove._relearner) v = truthy(relearner) ? relearner : field;
  else if (LearnMove._battleText) v = battle;
  else v = field;
  if (typeof v === "function") return v();
  return v;
}

// Lua: learn_move.lua:89
function battle_text(id: string, forgotten?: any): string {
  return BattleText.get(id, { buff1: LearnMove._name, buff2: truthy(forgotten) ? forgotten : LearnMove._moveName });
}

// Lua: learn_move.lua:93
function field_text(key: string, v2?: any, v3?: any): string {
  return RomText.ascii(key, { stringVars: [null, LearnMove._name, truthy(v2) ? v2 : LearnMove._moveName, v3] });
}

// Lua: learn_move.lua:97
function field_pages(key: string, v2?: any, v3?: any): LuaTable {
  const pages: LuaTable = [null];
  for (const [page] of gmatch(field_text(key, v2, v3) + "\\p", "(.-)\\p")) {
    if (page !== "") pages[len(pages) + 1] = page;
  }
  return pages;
}

// Lua: learn_move.lua:105
function lazy(fn: Fn, a?: any, b?: any, c?: any): () => any {
  return () => fn(a, b, c);
}

// Lua: learn_move.lua:109
function did_not_learn_text(): string {
  // pokefirered/data/battle_scripts_1.s:3134
  // pokefirered/src/party_menu.c:4987
  return T(lazy(battle_text, "STRINGID_DIDNOTLEARNMOVE"), lazy(field_text, "gText_MoveNotLearned"));
}

// Lua: learn_move.lua:115
function try_to_learn_pages(): LuaTable {
  // pokefirered/data/battle_scripts_1.s:3124
  // pokefirered/src/party_menu.c:4793
  // pokefirered/src/learn_move.c:551
  return T(() => [null, battle_text("STRINGID_TRYTOLEARNMOVE1"), battle_text("STRINGID_TRYTOLEARNMOVE2"),
    battle_text("STRINGID_TRYTOLEARNMOVE3")],
  lazy(field_pages, "gText_PkmnNeedsToReplaceMove"),
  lazy(field_pages, "gText_MonIsTryingToLearnMove"));
}

// Lua: learn_move.lua:125
function ask_to_learn(): void {
  const pages = try_to_learn_pages();
  say(pages[1], () => {
    say(pages[2], () => {
      open_delete_prompt();
    });
  });
}

// Lua: learn_move.lua:134
function open_delete_prompt(): void {
  if (LearnMove._headless || !truthy(LearnMove._askYesNo)) {
    say(did_not_learn_text(), () => {
      finish(false);
    });
    return;
  }
  LearnMove._waitingChoice = true;
  LearnMove._askYesNo!(try_to_learn_pages()[3], (yes: any) => {
    LearnMove._waitingChoice = false;
    if (!truthy(yes)) {
      open_stop_prompt();
      return;
    }
    if (LearnMove._relearner) {
      // pokefirered/src/learn_move.c:562
      say(RomText.ascii("gText_WhichMoveShouldBeForgotten"), () => {
        open_forget_list();
      });
      return;
    }
    open_forget_list();
  });
}

// Lua: learn_move.lua:159
function open_stop_prompt(): void {
  if (LearnMove._headless || !truthy(LearnMove._askYesNo)) {
    say(did_not_learn_text(), () => {
      finish(false);
    });
    return;
  }
  LearnMove._waitingChoice = true;
  // pokefirered/data/battle_scripts_1.s:3130
  // pokefirered/src/party_menu.c:4963
  // pokefirered/src/learn_move.c:572
  LearnMove._askYesNo!(T(lazy(battle_text, "STRINGID_STOPLEARNINGMOVE"), lazy(field_text, "gText_StopLearningMove2"),
    lazy(field_text, "gText_StopLearningMove")), (stop: any) => {
    LearnMove._waitingChoice = false;
    if (truthy(stop)) {
      if (LearnMove._relearner) {
        // pokefirered/src/learn_move.c:583
        finish(false);
        return;
      }
      say(did_not_learn_text(), () => {
        finish(false);
      });
    } else if (LearnMove._battleText || LearnMove._relearner) {
      // pokefirered/data/battle_scripts_1.s:3133
      ask_to_learn();
    } else {
      open_delete_prompt();
    }
  });
}

// Lua: learn_move.lua:191
function open_forget_list(): void {
  if (LearnMove._headless || !truthy(LearnMove._askForget)) {
    say(did_not_learn_text(), () => {
      finish(false);
    });
    return;
  }
  const opts: LuaTable = [null], slots: LuaTable = [null];
  for (let i = 1; i <= 4; i++) {
    const id = Pokemon.moveIdAt(LearnMove._mon, i);
    if (id != null && id > 0) {
      let label = move_name(id);
      if (Pokemon.isHmMove(id)) label = Strings("%s (HM)", label);
      opts[len(opts) + 1] = label;
      slots[len(slots) + 1] = i;
    }
  }
  LearnMove._forgetSlots = slots;
  LearnMove._waitingChoice = true;
  LearnMove._askForget!(opts, (idx: any) => {
    LearnMove._waitingChoice = false;
    if (idx == null || idx < 0 || idx >= len(slots)) {
      open_stop_prompt();
      return;
    }
    const slot = slots[idx + 1];
    const oldId = Pokemon.moveIdAt(LearnMove._mon, slot);
    if (Pokemon.isHmMove(oldId)) {
      // pokefirered/src/battle_script_commands.c:5212
      // pokefirered/src/pokemon_summary_screen.c:3899
      say(T(lazy(BattleText.get, "STRINGID_HMMOVESCANTBEFORGOTTEN"),
        lazy(RomText.ascii, BattleProfile.get(undefined).strings.hmCantForget)), () => {
        if (LearnMove._battleText || LearnMove._relearner) {
          // pokefirered/src/battle_script_commands.c:5247
          // pokefirered/src/pokemon_summary_screen.c:3899
          open_forget_list();
        } else {
          open_delete_prompt();
        }
      });
      return;
    }
    const forgotten = Pokemon.replaceMove(LearnMove._mon, slot, LearnMove._moveId)[0];
    if (truthy(forgotten)) {
      const battle = LearnMove._battleText;
      const fanfare = () => {
        try { Audio.playFanfare("MUS_LEVEL_UP"); } catch { /* pcall */ }
      };
      if (!battle) fanfare();
      const oldName = move_name(forgotten);
      let poof: any, forgot: any, andText: any, learned: any;
      if (LearnMove._relearner) {
        // pokefirered/src/learn_move.c:650
        poof = field_text("gText_1_2_and_Poof");
        // pokefirered/src/learn_move.c:657
        const pages = field_pages("gText_MonForgotOldMoveAndMonLearnedNewMove", undefined, oldName);
        forgot = pages[1]; andText = pages[2]; learned = pages[3];
      } else if (battle) {
        // pokefirered/data/battle_scripts_1.s:3137
        poof = BattleText.get("STRINGID_123POOF");
        forgot = battle_text("STRINGID_PKMNFORGOTMOVE", oldName);
        andText = BattleText.get("STRINGID_ANDELLIPSIS");
        learned = battle_text("STRINGID_PKMNLEARNEDMOVE");
      } else {
        // pokefirered/src/party_menu.c:4941
        const pages = field_pages("gText_12PoofForgotMove", oldName);
        poof = pages[1]; forgot = pages[2]; andText = pages[3];
        // pokefirered/src/party_menu.c:4817
        learned = field_text("gText_PkmnLearnedMove3");
      }
      if (LearnMove._headless) {
        say(poof);
        say(forgot);
        say(andText);
        if (battle) fanfare();
        say(learned);
        finish(true);
      } else {
        say(poof, () => {
          say(forgot, () => {
            say(andText, () => {
              // pokefirered/data/battle_scripts_1.s:3142
              if (battle) fanfare();
              say(learned, () => {
                finish(true);
              });
            });
          });
        });
      }
    } else {
      open_delete_prompt();
    }
  }, { mon: LearnMove._mon, moveId: LearnMove._moveId });
}

/**
 * Call when message queue is idle. Opens deferred Choice prompts.
 * Returns false while still busy.
 */
// Lua: learn_move.lua:289
LearnMove.pump = function (): boolean {
  return !LearnMove._active;
};

// Lua: learn_move.lua:293
LearnMove.begin = function (opts?: any): void {
  opts = opts ?? {};
  const mon = opts.mon;
  const moveId = tonumber(opts.moveId);
  if (!truthy(mon) || moveId == null) {
    if (truthy(opts.onDone)) opts.onDone(false);
    return;
  }
  if (Pokemon.knowsMove(mon, moveId)) {
    if (truthy(opts.onDone)) opts.onDone(false);
    return;
  }

  LearnMove._active = true;
  LearnMove._mon = mon;
  LearnMove._moveId = moveId;
  LearnMove._name = truthy(opts.displayName) ? opts.displayName : Pokemon.displayMonName(mon);
  LearnMove._moveName = move_name(moveId);
  LearnMove._pushMsg = opts.pushMsg;
  LearnMove._askYesNo = opts.askYesNo;
  LearnMove._askForget = opts.askForget;
  LearnMove._onDone = opts.onDone;
  LearnMove._headless = truthy(opts.headless) ? true : false;
  LearnMove._battleText = truthy(opts.battleText) ? true : false;
  LearnMove._relearner = truthy(opts.relearner) ? true : false;
  LearnMove._waitingChoice = false;

  if (Pokemon.moveSlotCount(mon) < 4) {
    const ok = Pokemon.teachMove(mon, moveId)[0];
    if (ok) {
      try { Audio.playFanfare("MUS_LEVEL_UP"); } catch { /* pcall */ }
      // pokefirered/data/battle_scripts_1.s:3143
      // pokefirered/src/party_menu.c:4817
      // pokefirered/src/learn_move.c:518
      const learned = T(lazy(battle_text, "STRINGID_PKMNLEARNEDMOVE"), lazy(field_text, "gText_PkmnLearnedMove3"),
        lazy(field_text, "gText_MonLearnedMove"));
      if (LearnMove._headless) {
        say(learned);
        finish(ok);
      } else {
        say(learned, () => {
          finish(ok);
        });
      }
    } else {
      finish(false);
    }
    return;
  }

  if (LearnMove._headless) {
    say(did_not_learn_text());
    finish(false);
    return;
  }

  ask_to_learn();
};

// Lua: learn_move.lua:352
LearnMove.movesForLevels = function (mon: any, levels: LuaTable | null | undefined): LuaTable {
  const species = Pokemon.speciesOf(mon)
    ?? tonumber(truthy(mon) ? (truthy(mon.species) ? mon.species : mon.speciesId) : mon);
  const out: LuaTable = [null];
  if (species == null) return out;
  const seen: Record<number, boolean> = {};
  for (const [, lv] of ipairs<number>(levels ?? [null])) {
    for (const [, mv] of ipairs<number>(Pokemon.movesLearnedAt(species, lv))) {
      if (!seen[mv] && !Pokemon.knowsMove(mon, mv)) {
        seen[mv] = true;
        out[len(out) + 1] = { level: lv, moveId: mv };
      }
    }
  }
  return out;
};

// Lua: learn_move.lua:368
function queue_next(): void {
  const opts = LearnMove._queueOpts;
  const mon = truthy(opts) ? opts.mon : undefined;
  LearnMove._queueIdx = (LearnMove._queueIdx ?? 0) + 1;
  const item = truthy(LearnMove._queue) ? LearnMove._queue![LearnMove._queueIdx] : undefined;
  if (!truthy(item) || !truthy(mon)) {
    const cb = truthy(opts) ? opts.onDone : undefined;
    LearnMove._queue = undefined;
    LearnMove._queueOpts = undefined;
    if (truthy(cb)) cb();
    return;
  }
  LearnMove.begin({
    mon,
    moveId: item.moveId,
    displayName: opts.displayName,
    pushMsg: opts.pushMsg,
    askYesNo: opts.askYesNo,
    askForget: opts.askForget,
    headless: opts.headless,
    battleText: opts.battleText,
    onDone: () => {
      queue_next();
    },
  });
}

// Lua: learn_move.lua:395
LearnMove.beginQueue = function (mon: any, levels: LuaTable | null | undefined, opts?: any): boolean {
  opts = opts ?? {};
  opts.mon = mon;
  const q = LearnMove.movesForLevels(mon, levels);
  if (len(q) === 0) {
    if (truthy(opts.onDone)) opts.onDone();
    return false;
  }
  LearnMove._queue = q;
  LearnMove._queueIdx = 0;
  LearnMove._queueOpts = opts;
  queue_next();
  return true;
};

export default LearnMove;
