// Port of gen1recomp src/core/game3/battle/tutorial_wally.lua (GPLv3 + additional terms; see LICENSE.md).
// Emerald's Wally catching tutorial (battle_controller_wally.c).
//
// Port notes:
// - FRLG never reaches this module: it only acts when st.kinds.tutorial is
//   "wally", which no FRLG battle kind sets. Brian's guard (Wally.active) is
//   kept and the code is ported as written.
// - Multiple returns are 0-based tuples: peek / take -> [action, step].
//   menuStep stores only take's first value (`Ui._pendingCommand = Wally.take(st)`).
// - Constants(...):require(kind, name) is the method call `.require(kind, name)`.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { tonumber, truthy } from "../../../../import/gen3/lua.ts";
import Commands from "./commands.ts";
import BattleProfile from "./profile.ts";

export type WallyStep = "fight" | "throw" | "bag";

export interface WallyModule {
  WAIT_LONG: number;
  MOVE_FRAMES: number;
  active(st: any): boolean;
  ballItem(st: any): any;
  peek(st: any): [any, WallyStep];
  take(st: any): [any, WallyStep];
  menuStep(Ui: any, st: any, playSelect: () => void): void;
}

export const Wally = {} as WallyModule;

// pokeemerald/include/constants/battle.h:324
Wally.WAIT_LONG = 64;
// pokeemerald/src/battle_controller_wally.c:1230
Wally.MOVE_FRAMES = 80;

// Lua: tutorial_wally.lua:11
Wally.active = function (st: any): boolean {
  return st != null && st.kinds != null && st.kinds.tutorial === "wally";
};

// Lua: tutorial_wally.lua:15
Wally.ballItem = function (st: any): any {
  return BattleProfile.constants(BattleProfile.of(st)).require("items", "ITEM_POKE_BALL");
};

// pokeemerald/src/battle_controller_wally.c:188
// Lua: tutorial_wally.lua:20
Wally.peek = function (st: any): [any, WallyStep] {
  const n = tonumber(st != null ? st.wallyState : st) ?? 0;
  if (n < 2) {
    const act = Commands.playerAction(st, 1, 1);
    act.user = "player";
    return [act, "fight"];
  }
  if (n === 2) return [{ kind: "wally_throw", user: "player" }, "throw"];
  return [{ kind: "bag", itemId: Wally.ballItem(st), user: "player", wally: true }, "bag"];
};

// Lua: tutorial_wally.lua:31
Wally.take = function (st: any): [any, WallyStep] {
  const [act, step] = Wally.peek(st);
  st.wallyState = (tonumber(st.wallyState) ?? 0) + 1;
  return [act, step];
};

// pokeemerald/src/battle_controller_wally.c:188
// Lua: tutorial_wally.lua:38
Wally.menuStep = function (Ui: any, st: any, playSelect: () => void): void {
  const w = Ui._wally;
  if (!truthy(w)) return;
  const step = Wally.peek(st)[1];
  w.timer = w.timer + 1;
  if (step === "fight") {
    if (w.sub === 0 && w.timer >= Wally.WAIT_LONG) {
      playSelect();
      w.sub = 1;
      w.timer = 0;
      if (truthy(Ui._openMoveMenu)) Ui._openMoveMenu();
    } else if (w.sub === 1 && w.timer >= Wally.MOVE_FRAMES) {
      // pokeemerald/src/battle_controller_wally.c:1244
      playSelect();
      Ui._pendingCommand = Wally.take(st)[0];
      Ui._mode = "none";
      Ui._wally = undefined;
    }
  } else if (step === "throw") {
    if (w.timer >= Wally.WAIT_LONG) {
      Ui._pendingCommand = Wally.take(st)[0];
      Ui._mode = "none";
      Ui._wally = undefined;
    }
  } else {
    if (w.sub === 0 && w.timer >= Wally.WAIT_LONG) {
      // pokeemerald/src/battle_controller_wally.c:232
      playSelect();
      Ui._menuIndex = 2;
      w.sub = 1;
      w.timer = 0;
    } else if (w.sub === 1 && w.timer >= Wally.WAIT_LONG) {
      playSelect();
      Ui._pendingCommand = Wally.take(st)[0];
      Ui._mode = "none";
      Ui._wally = undefined;
    }
  }
};

export default Wally;
