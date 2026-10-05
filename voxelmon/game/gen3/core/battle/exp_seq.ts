// Port of gen1recomp src/core/game3/battle/exp_seq.lua (GPLv3 + additional terms; see LICENSE.md).
// Post-faint EXP presentation: gained → bar → level-up → learn moves (ROM learnset).
//
// Port notes:
// - stat_growth(): `pcall(require, "src.ui.game3.stat_growth")` is a lookup
//   in G3Lazy (ui/stat_growth.ts registers itself; a missing entry is the
//   failed require).
// - package.loaded["src.core.game3.battle.ui"] is the Ui module (static
//   import; a still-stubbed Ui's dialogPending counts as not loaded).
// - pcall(require) of audio / se_ids: linked in.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { tonumber, tostring, truthy } from "../../../../import/gen3/lua.ts";
import { len, ipairs, type LuaTable } from "../../platform/lt.ts";
import { NotPortedError } from "../../notported.ts";
import Anim from "./anim.ts";
import State from "./state.ts";
import LearnMove from "./learn_move.ts";
import Pokemon from "../pokemon.ts";
import BattleText from "./battle_text.ts";
import Audio from "../audio.ts";
import SE from "../se_ids.ts";
import Ui from "./ui.ts";
import { G3Lazy } from "../lazy_registry.ts";

type Fn = (...a: any[]) => any;

export interface ExpSeqModule {
  _steps: LuaTable | null | undefined;
  _i: number;
  _waiting: boolean;
  _waitingMsg: boolean;
  _pushMsg: Fn | null | undefined;
  _askYesNo: Fn | null | undefined;
  _askForget: Fn | null | undefined;
  _headless: boolean;
  _leveled: Record<number, boolean> | null | undefined;
  _pendingStatGrowth: any;
  _lvlAnimWait?: boolean;
  _battleText?: boolean;
  reset(): void;
  busy(): boolean;
  leveledSet(): Record<number, boolean> | null | undefined;
  begin(awards: LuaTable | null | undefined, pushMsg?: Fn | null, thenMsgs?: LuaTable | null, opts?: any): boolean;
  update(): boolean;
}

export const ExpSeq = {} as ExpSeqModule;

// Lua: exp_seq.lua:11
function stat_growth(): any {
  // pcall(require, "src.ui.game3.stat_growth")
  const SG = G3Lazy["src.ui.game3.stat_growth"];
  if (truthy(SG)) return SG;
  return undefined;
}

// Lua: exp_seq.lua:17
function stat_window_open(): boolean {
  const SG = stat_growth();
  return (truthy(SG) && truthy(SG.isOpen) && truthy(SG.isOpen())) ? true : false;
}

ExpSeq._steps = undefined;
ExpSeq._i = 1;
ExpSeq._waiting = false;
ExpSeq._waitingMsg = false;
ExpSeq._pushMsg = undefined;
ExpSeq._askYesNo = undefined;
ExpSeq._askForget = undefined;
ExpSeq._headless = false;
ExpSeq._leveled = undefined; // {[partyIndex]=true}
ExpSeq._pendingStatGrowth = undefined;

/** The repeated `pcall(require audio / se_ids) ... Audio.stopSe(SE.SE_EXP)`. */
function stop_exp_se(): void {
  if (truthy(Audio.stopSe) && truthy(SE) && truthy(SE.SE_EXP)) {
    Audio.stopSe(SE.SE_EXP);
  }
}

// Lua: exp_seq.lua:33
ExpSeq.reset = function (): void {
  ExpSeq._steps = undefined;
  ExpSeq._i = 1;
  ExpSeq._waiting = false;
  ExpSeq._waitingMsg = false;
  ExpSeq._pushMsg = undefined;
  ExpSeq._askYesNo = undefined;
  ExpSeq._askForget = undefined;
  ExpSeq._leveled = undefined;
  ExpSeq._pendingStatGrowth = undefined;
  ExpSeq._lvlAnimWait = false;
  stop_exp_se();
  const StatGrowth = stat_growth();
  if (truthy(StatGrowth) && truthy(StatGrowth.close)) StatGrowth.close({ silent: true });
  LearnMove.reset();
};

// Lua: exp_seq.lua:54
ExpSeq.busy = function (): boolean {
  if (stat_window_open()) return true;
  return ExpSeq._steps != null || LearnMove.busy();
};

// Lua: exp_seq.lua:59
ExpSeq.leveledSet = function () {
  return ExpSeq._leveled;
};

// Lua: exp_seq.lua:63
function finish(): void {
  ExpSeq._steps = undefined;
  ExpSeq._i = 1;
  ExpSeq._waiting = false;
  ExpSeq._waitingMsg = false;
  // The step that owned the stat window is over; drop it without letting its
  // stale callback advance a sequence that has already ended (#2324).
  const StatGrowth = stat_growth();
  if (truthy(StatGrowth) && truthy(StatGrowth.close)) StatGrowth.close({ silent: true });
  stop_exp_se();
}

// Lua: exp_seq.lua:79
function advance(): void {
  ExpSeq._waiting = false;
  ExpSeq._waitingMsg = false;
  ExpSeq._i = ExpSeq._i + 1;
}

// Lua: exp_seq.lua:85
function mon_name(entry: any): string {
  if (truthy(entry.battler)) return State.displayName(entry.battler);
  return Pokemon.displayMonName(entry.mon);
}

/**
 * awards: Experience.awardFoe results
 * opts: pushMsg, askYesNo, askForget, headless, thenMsgs
 */
// Lua: exp_seq.lua:92
ExpSeq.begin = function (awards: LuaTable | null | undefined, pushMsg?: Fn | null, thenMsgs?: LuaTable | null, opts?: any): boolean {
  opts = opts ?? {};
  ExpSeq.reset();
  ExpSeq._pushMsg = truthy(pushMsg) ? pushMsg : opts.pushMsg;
  ExpSeq._askYesNo = opts.askYesNo;
  ExpSeq._askForget = opts.askForget;
  ExpSeq._battleText = truthy(opts.battleText) ? true : false;
  ExpSeq._headless = truthy(opts.headless) ? true : false;
  ExpSeq._leveled = {};

  const steps: LuaTable = [null];
  const add = (kind: string, data: any): void => {
    steps[len(steps) + 1] = { kind, data };
  };

  for (const [, entry] of ipairs<any>(awards ?? [null])) {
    const mon = entry.mon;
    const result = entry.result ?? {};
    const name = mon_name(entry);
    const gained = (truthy(result.gained) ? result.gained : entry.amount) ?? 0;
    const pi = entry.partyIndex ?? 1;
    const isBench = (entry.battler == null);
    let key: any = "player";
    if (truthy(opts.double) && truthy(entry.battler) && entry.battler.id != null) key = entry.battler.id;
    if (gained > 0) {
      // pokefirered/src/battle_script_commands.c:3265
      add("msg", {
        text: BattleText.get("STRINGID_PKMNGAINEDEXP", {
          buff1: name,
          buff2: BattleText.get(truthy(entry.boosted) ? "STRINGID_ABOOSTED" : "STRINGID_EMPTYSTRING4"),
          buff3: tostring(gained),
        }),
      });
      for (const [, step] of ipairs<any>(result.steps ?? [null])) {
        // pokefirered/src/battle_controller_player.c:1034
        if (!isBench && !truthy(opts.double)) {
          add("exp", {
            side: "player",
            level: step.level,
            fromRatio: step.fromRatio,
            toRatio: step.toRatio,
          });
        }
        if (truthy(step.grewTo)) {
          ExpSeq._leveled[pi] = true;
          add("level", {
            side: key,
            isBench,
            mon,
            level: step.grewTo,
            hp: truthy(step.hp) ? step.hp : (truthy(mon) ? tonumber(mon.hp) : undefined),
            maxHp: truthy(step.maxHp) ? step.maxHp : (truthy(mon) ? tonumber(mon.maxHp) : undefined),
            oldStats: step.oldStats,
            newStats: step.newStats,
            // pokefirered/src/battle_script_commands.c:3307
            text: BattleText.get("STRINGID_PKMNGREWTOLV", { buff1: name, buff2: tostring(step.grewTo) }),
          });
          // ROM learnset moves at this exact level
          const moves = Pokemon.movesLearnedAt(
            tonumber(truthy(mon) ? (truthy(mon.species) ? mon.species : mon.speciesId) : undefined),
            step.grewTo,
          );
          for (const [, mv] of ipairs(moves)) {
            add("learn", {
              mon,
              moveId: mv,
              displayName: name,
              partyIndex: pi,
            });
          }
        }
      }
    }
  }

  for (const [, t] of ipairs(truthy(thenMsgs) ? thenMsgs : (opts.thenMsgs ?? [null]))) {
    add("msg", { text: t });
  }

  if (len(steps) === 0) {
    finish();
    return false;
  }
  ExpSeq._steps = steps;
  ExpSeq._i = 1;
  ExpSeq._waiting = false;
  ExpSeq._waitingMsg = false;
  return true;
};

// Lua: exp_seq.lua:180
function run_step(step: any): void {
  if (!truthy(step)) {
    finish();
    return;
  }
  const kind = step.kind;
  const d = step.data ?? {};

  if (kind === "msg") {
    if (truthy(ExpSeq._pushMsg) && truthy(d.text)) {
      ExpSeq._pushMsg!(d.text);
    }
    if (!ExpSeq._headless) {
      ExpSeq._waiting = true;
      ExpSeq._waitingMsg = true;
      return;
    }
    advance();
    return;
  }

  if (kind === "exp") {
    ExpSeq._waiting = true;
    const p = Anim.present(truthy(d.side) ? d.side : "player");
    if (truthy(p) && truthy(d.level)) p.displayLevel = d.level;
    {
      Audio.playSe(SE.SE_EXP);
    }
    Anim.tweenExp(truthy(d.side) ? d.side : "player", d.fromRatio, d.toRatio, {
      level: d.level,
      onComplete: () => {
        stop_exp_se();
        advance();
      },
    });
    if (!Anim.busy() && ExpSeq._waiting) {
      stop_exp_se();
      advance();
    }
    return;
  }

  if (kind === "level") {
    if (!truthy(d.isBench) && !ExpSeq._headless && !truthy(d._lvlAnim)) {
      // pokefirered/src/battle_controller_player.c:1143
      d._lvlAnim = true;
      let side = truthy(d.side) ? d.side : "player";
      const bid = (typeof side === "number") ? side : undefined;
      if (bid != null) side = State.sideOf(bid);
      ExpSeq._lvlAnimWait = true;
      Anim.launchSpecial("LVL_UP", {
        attackerSide: side,
        targetSide: side,
        attackerId: bid,
        targetId: bid,
        onEnd: () => { ExpSeq._lvlAnimWait = false; },
      });
      return;
    }
    if (!truthy(d.isBench)) {
      const p = Anim.present(truthy(d.side) ? d.side : "player");
      if (truthy(p)) {
        p.displayLevel = d.level;
        p.displayExp = 0;
        if (truthy(d.maxHp)) {
          p.displayMaxHp = d.maxHp;
          p.displayHp = truthy(d.hp) ? d.hp : d.maxHp;
        }
      }
    }
    {
      Audio.playFanfare(Audio.role("levelUp") || 257);
    }
    if (truthy(ExpSeq._pushMsg) && truthy(d.text)) {
      ExpSeq._pushMsg!(d.text);
    }
    if (!ExpSeq._headless) {
      ExpSeq._waiting = true;
      ExpSeq._waitingMsg = true;
      ExpSeq._pendingStatGrowth = (truthy(d.oldStats) && truthy(d.newStats)) ? {
        mon: d.mon,
        oldStats: d.oldStats,
        newStats: d.newStats,
      } : undefined;
      return;
    }
    advance();
    return;
  }

  if (kind === "learn") {
    ExpSeq._waiting = true;
    LearnMove.begin({
      mon: d.mon,
      moveId: d.moveId,
      displayName: d.displayName,
      pushMsg: ExpSeq._pushMsg,
      askYesNo: ExpSeq._askYesNo,
      askForget: ExpSeq._askForget,
      headless: ExpSeq._headless,
      battleText: ExpSeq._battleText,
      onDone: () => {
        advance();
      },
    });
    // Free-slot teach may finish synchronously
    if (!LearnMove.busy() && ExpSeq._waiting) {
      if (ExpSeq._waiting) advance();
    }
    return;
  }

  advance();
}

/** package.loaded["src.core.game3.battle.ui"]: a stubbed Ui reads as not loaded. */
function ui_dialog_pending(): boolean {
  const U: any = Ui;
  if (!truthy(U)) return false;
  try {
    if (truthy(U.dialogPending)) {
      return truthy(U.dialogPending());
    } else if (!truthy(U._headless)) {
      return (U._showing === true) || (truthy(U._queue) && len(U._queue) > 0);
    }
  } catch (e) {
    if (e instanceof NotPortedError) return false;
    throw e;
  }
  return false;
}

// Lua: exp_seq.lua:306
ExpSeq.update = function (): boolean {
  if (LearnMove.busy()) {
    LearnMove.pump();
    return false;
  }
  if (!truthy(ExpSeq._steps)) return true;

  if (ExpSeq._lvlAnimWait) {
    if (Anim.busy()) return false;
    ExpSeq._lvlAnimWait = false;
  }

  if (ExpSeq._waitingMsg) {
    const pending = ui_dialog_pending();
    if (pending) {
      return false;
    }
    ExpSeq._waitingMsg = false;
    if (truthy(ExpSeq._pendingStatGrowth) && !ExpSeq._headless) {
      const sg = ExpSeq._pendingStatGrowth;
      ExpSeq._pendingStatGrowth = undefined;
      const StatGrowth = stat_growth();
      if (truthy(StatGrowth) && truthy(StatGrowth.open)) {
        ExpSeq._waiting = true;
        StatGrowth.open(sg.mon, sg.oldStats, sg.newStats, () => {
          ExpSeq._waiting = false;
          advance();
        });
        return false;
      }
    }
    ExpSeq._waiting = false;
    advance();
  }

  if (ExpSeq._waiting) {
    if (LearnMove.busy()) {
      return false;
    }
    // The level-up stat window waits for the player; its onDone callback clears
    // _waiting and advances.  Without this the sequence ran straight past the
    // open window, leaving it on screen (#2324).
    if (stat_window_open()) {
      return false;
    }
    if (!Anim.busy()) {
      advance();
    } else {
      return false;
    }
  }
  const step = ExpSeq._steps![ExpSeq._i];
  if (!truthy(step)) {
    finish();
    return true;
  }
  run_step(step);
  return false;
};

export default ExpSeq;
