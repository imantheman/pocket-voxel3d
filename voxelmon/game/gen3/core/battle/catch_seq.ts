// Port of gen1recomp src/core/game3/battle/catch_seq.lua (GPLv3 + additional terms; see LICENSE.md).
// pokefirered/src/pokeball.c:441
//
// Port notes:
// - Sprite `data` tables ({ [0] = ... }) are JS arrays indexed 0..7. Anim /
//   affine command lists are lt.ts sequences with `jump` as a property, as
//   BallOpen.animate reads them.
// - BOUNCE_SE reads SE ids: built on first use (no load-time reads of
//   imports).
// - Lua `%` on values that can be negative (rotation) uses lua.ts mod.
// - Ui.battlerSpriteCenter returns a tuple [x, y].
// - pcall(function ... end) blocks are try/catch; pcall(require, runtime)
//   and the lazy requires (profile, storage, ui) are static imports.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { mod as lmod, tonumber, truthy } from "../../../../import/gen3/lua.ts";
import { seq, len, ipairs, type LuaTable } from "../../platform/lt.ts";
import Anim from "./anim.ts";
import State from "./state.ts";
import Audio from "../audio.ts";
import SE from "../se_ids.ts";
import Pokemon from "../pokemon.ts";
import Catching from "./catching.ts";
import BallOpen from "./ball_open.ts";
import BattleText from "./battle_text.ts";
import Adapter from "./adapter.ts";
import BattleProfile from "./profile.ts";
import Storage from "../storage.ts";
import Runtime from "../runtime.ts";
import Ui from "./ui.ts";

type Fn = (...a: any[]) => any;

// Lua: catch_seq.lua:13
function caught_song(key: string): any {
  return Audio.resolveSong(BattleProfile.get(undefined).sounds[key]);
}

export interface CatchSeqModule {
  _steps: LuaTable | null | undefined;
  _i: number;
  _waiting: boolean;
  _waitingMsg: boolean;
  _pushMsg: Fn | null | undefined;
  _headless: boolean;
  _result: string | null | undefined;
  _st: any;
  _session: any;
  _ballId: any;
  _caught: boolean;
  _shakes: number;
  _catchResult?: any;
  _ball?: any;
  _waitingBall?: boolean;
  _target?: number;
  reset(): void;
  busy(): boolean;
  result(): string | null | undefined;
  catchResult(): any;
  begin(st: any, itemId: any, caught: any, shakes: any, opts?: any): boolean;
  startBall(d: any): any;
  update(): boolean;
}

export const CatchSeq = {} as CatchSeqModule;

CatchSeq._steps = undefined;
CatchSeq._i = 1;
CatchSeq._waiting = false;
CatchSeq._waitingMsg = false;
CatchSeq._pushMsg = undefined;
CatchSeq._headless = false;
CatchSeq._result = undefined; // "catch" | "fail_catch"
CatchSeq._st = undefined;
CatchSeq._session = undefined;
CatchSeq._ballId = undefined;
CatchSeq._caught = false;
CatchSeq._shakes = 0;

// Lua: catch_seq.lua:32
CatchSeq.reset = function (): void {
  CatchSeq._steps = undefined;
  CatchSeq._i = 1;
  CatchSeq._waiting = false;
  CatchSeq._waitingMsg = false;
  CatchSeq._pushMsg = undefined;
  CatchSeq._headless = false;
  CatchSeq._result = undefined;
  CatchSeq._st = undefined;
  CatchSeq._session = undefined;
  CatchSeq._ballId = undefined;
  CatchSeq._caught = false;
  CatchSeq._shakes = 0;
  CatchSeq._catchResult = undefined;
  CatchSeq._ball = undefined;
  CatchSeq._waitingBall = false;
  CatchSeq._target = 1;
};

// Lua: catch_seq.lua:51
CatchSeq.busy = function (): boolean {
  return CatchSeq._steps != null;
};

// Lua: catch_seq.lua:55
CatchSeq.result = function () {
  return CatchSeq._result;
};

// Lua: catch_seq.lua:59
CatchSeq.catchResult = function () {
  return CatchSeq._catchResult;
};

// Lua: catch_seq.lua:63
function finish(): void {
  CatchSeq._steps = undefined;
  CatchSeq._i = 1;
  CatchSeq._waiting = false;
  CatchSeq._waitingMsg = false;
}

// Lua: catch_seq.lua:70
function advance(): void {
  CatchSeq._waiting = false;
  CatchSeq._i = CatchSeq._i + 1;
}

// Lua: catch_seq.lua:75
function wait_busy(): void {
  CatchSeq._waiting = true;
}
void wait_busy;

// Lua: catch_seq.lua:79
function catch_text(id: string): string {
  const st = CatchSeq._st;
  const session = CatchSeq._session;
  return BattleText.get(id, Adapter.fill(st, {
    opponentMon1: truthy(st) ? st.enemy : undefined, lastItem: CatchSeq._ballId,
    playerName: (truthy(session) && truthy(session.name) ? session.name : undefined) ?? (truthy(st) ? st.playerName : undefined),
  }));
}

// pokefirered/src/battle_message.c:1151
const BALL_ESCAPE: Record<number, string> = {
  [0]: "STRINGID_PKMNBROKEFREE", [1]: "STRINGID_ITAPPEAREDCAUGHT",
  [2]: "STRINGID_AARGHALMOSTHADIT", [3]: "STRINGID_SHOOTSOCLOSE",
};

// pokefirered/data/battle_scripts_2.s:77
// Lua: catch_seq.lua:93
function wally(st: any): boolean {
  return st != null && st.kinds != null && st.kinds.tutorial === "wally";
}

// Lua: catch_seq.lua:97
function gotcha_id(st: any): string {
  if (truthy(st) && (truthy(st.oldManTutorial) || truthy(st.pokedude))) return "STRINGID_GOTCHAPKMNCAUGHT2";
  // pokeemerald/data/battle_scripts_2.s:90
  if (wally(st)) return "STRINGID_GOTCHAPKMNCAUGHTWALLY";
  return BattleProfile.of(st).strings.caught;
}

/**
 * Begin a catch animation sequence.
 * opts: { pushMsg, headless, session }
 */
// Lua: catch_seq.lua:106
CatchSeq.begin = function (st: any, itemId: any, caught: any, shakes: any, opts?: any): boolean {
  opts = opts ?? {};
  CatchSeq.reset();
  CatchSeq._st = st;
  CatchSeq._ballId = itemId;
  CatchSeq._caught = truthy(caught) ? true : false;
  CatchSeq._shakes = Math.max(0, Math.min(4, tonumber(shakes) ?? 0));
  CatchSeq._pushMsg = opts.pushMsg;
  CatchSeq._headless = truthy(opts.headless) ? true : false;
  CatchSeq._session = opts.session;
  CatchSeq._result = truthy(caught) ? "catch" : "fail_catch";
  CatchSeq._target = tonumber(opts.target) ?? 1;

  let session = opts.session;
  if (!truthy(session)) {
    // pcall(require, "src.core.game3.runtime")
    if (truthy(Runtime) && truthy(Runtime.getSession)) {
      session = Runtime.getSession();
      CatchSeq._session = session;
    }
  }

  const ename = State.displayName(st.enemy);

  // pokefirered/data/battle_scripts_2.s:54
  let throwMsg: string;
  if (truthy(st.oldManTutorial)) {
    throwMsg = catch_text("STRINGID_OLDMANUSEDITEM");
  } else if (wally(st)) {
    // pokeemerald/data/battle_scripts_2.s:56
    throwMsg = catch_text("STRINGID_WALLYUSEDITEM");
  } else if (truthy(st.pokedude)) {
    throwMsg = catch_text("STRINGID_POKEDUDEUSED");
  } else {
    throwMsg = catch_text("STRINGID_PLAYERUSEDITEM");
  }

  // pokefirered/data/battle_scripts_2.s:124
  const DODGE = catch_text("STRINGID_ITDODGEDBALL");
  if (truthy(opts.ghostDodge)) CatchSeq._result = "fail_catch";
  if (CatchSeq._headless) {
    if (truthy(CatchSeq._pushMsg)) {
      CatchSeq._pushMsg!(throwMsg);
    }
    if (truthy(opts.ghostDodge)) {
      if (truthy(CatchSeq._pushMsg)) CatchSeq._pushMsg!(DODGE);
    } else if (truthy(caught)) {
      let res: any;
      // pokefirered/data/battle_scripts_2.s:99 BattleScript_OldMan_Pokedude_CaughtMessage
      if (!(truthy(st) && (truthy(st.oldManTutorial) || truthy(st.pokedude) || wally(st)))) {
        res = Catching.storeCaught(session, truthy(st) ? st.enemy : undefined, itemId);
      }
      CatchSeq._catchResult = res;
      if (truthy(CatchSeq._pushMsg)) {
        CatchSeq._pushMsg!(catch_text(gotcha_id(st)));
        if (truthy(res) && truthy(res.firstTimeCaught)) {
          CatchSeq._pushMsg!(catch_text("STRINGID_PKMNDATAADDEDTODEX"));
        }
        if (truthy(res) && res.location === "pc") {
          // pokefirered/src/battle_script_commands.c:9617
          CatchSeq._pushMsg!(Storage.pcTransferMessage(session, ename));
        }
      }
    } else {
      if (truthy(CatchSeq._pushMsg)) {
        CatchSeq._pushMsg!(catch_text(BALL_ESCAPE[Math.min(3, CatchSeq._shakes)]!));
      }
    }
    finish();
    return true;
  }

  const steps: LuaTable = [null];
  const add = (kind: string, data?: any): void => {
    steps[len(steps) + 1] = { kind, data: data ?? {} };
  };

  add("msg", { text: throwMsg, wait: truthy(opts.ghostDodge) ? 0 : undefined });

  // pokefirered/src/battle_script_commands.c:9590
  add("throw", {
    caseId: truthy(opts.ghostDodge) ? "ghost" : (truthy(caught) ? 4 : Math.min(3, CatchSeq._shakes)),
    itemId,
  });

  if (truthy(opts.ghostDodge)) {
    add("msg", { text: DODGE, wait: 64 });
  } else if (truthy(caught)) {
    add("capture_success", {
      ballId: itemId,
    });
  } else {
    add("breakout", {
      shakes: Math.min(3, CatchSeq._shakes),
    });
  }

  CatchSeq._steps = steps;
  CatchSeq._i = 1;
  CatchSeq._waiting = false;
  return true;
};

// Lua: catch_seq.lua:210
function play_se(id: any): void {
  try { Audio.playSe(id); } catch { /* pcall */ }
}

/** A command sequence with an optional `jump`. */
function cmds(jump: number | undefined, ...cs: LuaTable[]): LuaTable {
  const t: any = seq(...cs);
  if (jump !== undefined) t.jump = jump;
  return t;
}

// pokefirered/src/pokeball.c:132
const BALL_ANIMS: Record<number, LuaTable> = {
  [0]: cmds(undefined, seq(0, 1)),
  [1]: cmds(undefined, seq(1, 5), seq(2, 5)),
  [2]: cmds(undefined, seq(1, 5), seq(0, 5)),
};

// pokefirered/src/pokeball.c:163
const BALL_AFFINE: Record<number, LuaTable> = {
  [0]: cmds(1, seq(0, 0, 0, 1)),
  [1]: cmds(1, seq(0, 0, -3, 1)),
  [2]: cmds(1, seq(0, 0, 3, 1)),
  [3]: cmds(undefined, seq(256, 256, 0, 0)),
};

// pokefirered/src/data.c:112
const MON_AFFINE: Record<number, LuaTable> = {
  [0]: cmds(undefined, seq(0x100, 0x100, 0, 0)),
  [1]: cmds(undefined, seq(0x28, 0x28, 0, 0), seq(0x12, 0x12, 0, 12)),
};

// pokefirered/src/battle_anim_special.c:98
const CAPTURE_STARS = seq(seq(10, 2, -3), seq(15, 0, -4), seq(-10, 2, -4));

// pokefirered/src/sprite.c:1320
// Lua: catch_seq.lua:239
function affine_apply(a: any, cmd: LuaTable): number {
  if (cmd[4] > 0) {
    a.scale = a.scale + cmd[1];
    a.rotation = lmod(a.rotation + cmd[3] * 256, 65536);
    return cmd[4] - 1;
  }
  a.scale = cmd[1];
  a.rotation = lmod(cmd[3] * 256, 65536);
  return 0;
}

// pokefirered/src/sprite.c:1363
// Lua: catch_seq.lua:251
function affine_start(a: any, num: number): void {
  a.num = num;
  a.idx = 1;
  a.delay = 0;
  a.scale = 0x100;
  a.rotation = 0;
  a.beginning = true;
  a.ended = false;
}

// pokefirered/src/sprite.c:1378
// Lua: catch_seq.lua:262
function affine_change(a: any, num: number): void {
  a.num = num;
  a.beginning = true;
  a.ended = false;
}

// pokefirered/src/sprite.c:1063
// Lua: catch_seq.lua:269
function affine_step(a: any, anims: Record<number, LuaTable>): void {
  const c0 = anims[a.num];
  if (a.beginning) {
    a.idx = 1;
    a.beginning = false;
    a.ended = false;
    a.delay = affine_apply(a, c0[1]);
    return;
  }
  // pokefirered/src/sprite.c:1080
  if (a.delay > 0) {
    if (!truthy(a.paused)) {
      a.delay = a.delay - 1;
      const c = c0[a.idx];
      a.scale = a.scale + c[1];
      a.rotation = lmod(a.rotation + c[3] * 256, 65536);
    }
    return;
  }
  if (truthy(a.paused)) return;
  if (truthy(c0[a.idx + 1])) {
    a.idx = a.idx + 1;
  } else if (truthy(c0.jump)) {
    a.idx = c0.jump;
  } else {
    a.ended = true;
    return;
  }
  a.delay = affine_apply(a, c0[a.idx]);
}

// pokefirered/src/battle_anim_mons.c:988
// Lua: catch_seq.lua:301
function arc_init(s: any, speed: number, destX: number, destY: number, ampl: number): void {
  const d = s.data;
  const dx = destX - s.x, dy = destY - s.y;
  let xd = Math.floor(lmod(Math.abs(dx) * 256, 65536) / speed);
  let yd = Math.floor(lmod(Math.abs(dy) * 256, 65536) / speed);
  xd = xd - lmod(xd, 2) + ((dx < 0) ? 1 : 0);
  yd = yd - lmod(yd, 2) + ((dy < 0) ? 1 : 0);
  d[0] = speed; d[1] = xd; d[2] = yd; d[3] = 0; d[4] = 0;
  d[5] = ampl;
  // pokefirered/src/battle_anim_mons.c:757
  d[6] = Math.floor(0x8000 / speed);
  d[7] = 0;
}

// pokefirered/src/battle_anim_mons.c:1034
// Lua: catch_seq.lua:316
function translate_linear(s: any): boolean {
  const d = s.data;
  if (d[0] === 0) return true;
  const x = lmod(d[3] + d[1], 65536);
  const y = lmod(d[4] + d[2], 65536);
  s.x2 = (lmod(d[1], 2) === 1) ? -Math.floor(x / 256) : Math.floor(x / 256);
  s.y2 = (lmod(d[2], 2) === 1) ? -Math.floor(y / 256) : Math.floor(y / 256);
  d[3] = x; d[4] = y;
  d[0] = d[0] - 1;
  return false;
}

// pokefirered/src/battle_anim_mons.c:766
// Lua: catch_seq.lua:329
function translate_arc(s: any): boolean {
  if (translate_linear(s)) return true;
  const d = s.data;
  d[7] = d[7] + d[6];
  s.y2 = s.y2 + BallOpen.sin(lmod(Math.floor(d[7] / 256), 256), d[5]);
  return false;
}

// pokefirered/src/battle_anim_mons.c:775
// Lua: catch_seq.lua:338
function translate_vertical_arc(s: any): boolean {
  if (translate_linear(s)) return true;
  const d = s.data;
  d[7] = d[7] + d[6];
  s.x2 = s.x2 + BallOpen.sin(lmod(Math.floor(d[7] / 256), 256), d[5]);
  return false;
}

const CB: Record<string, (b: any) => void> = {};

// Lua: catch_seq.lua:348
function start_anim(b: any, num: number): void {
  b.animNum = num; b.animBeginning = true; b.animEnded = false;
}

// pokefirered/src/battle_anim_special.c:810
// Lua: catch_seq.lua:353
CB.init = function (b: any): void {
  arc_init(b, b.data[0], b.data[1], b.data[2], -40);
  b.cb = CB.arcFlight;
};

// pokefirered/src/battle_anim_special.c:824
// pokefirered/src/battle_anim_special.c:1404
// Lua: catch_seq.lua:360
CB.ghostDodge2 = function (b: any): void {
  if (!translate_vertical_arc(b) && (b.y + b.y2) < 65) return;
  b.data[0] = 0;
  b.cb = CB.signalEnd;
};

// pokefirered/src/battle_anim_special.c:1388
// Lua: catch_seq.lua:367
CB.ghostDodge = function (b: any): void {
  b.x = b.x + b.x2; b.y = b.y + b.y2;
  b.x2 = 0; b.y2 = 0;
  arc_init(b, 0x22, b.x - 8, 0x90, 0x20);
  translate_vertical_arc(b);
  b.cb = CB.ghostDodge2;
};

// Lua: catch_seq.lua:375
CB.arcFlight = function (b: any): void {
  if (!translate_arc(b)) return;
  if (b.caseId === "ghost") {
    b.cb = CB.ghostDodge;
    return;
  }
  start_anim(b, 1);
  b.x = b.x + b.x2; b.y = b.y + b.y2;
  b.x2 = 0; b.y2 = 0;
  for (let i = 0; i <= 7; i++) b.data[i] = 0;
  b.cb = CB.tenFrameDelay;
  // pokefirered/src/battle_anim_special.c:857
  BallOpen.start(truthy(b.target) ? b.target : 1, b.x, b.y, b.itemId, false);
  play_se(SE.SE_BALL_OPEN);
};

// pokefirered/src/battle_anim_special.c:865
// Lua: catch_seq.lua:392
CB.tenFrameDelay = function (b: any): void {
  b.data[5] = b.data[5] + 1;
  if (b.data[5] === 10) {
    b.task = { state: 0, count: 0, delta: 0, acc: 0, scale: 256 };
    b.cb = CB.shrinkMon;
  }
};

// pokefirered/src/battle_anim_special.c:875
// Lua: catch_seq.lua:401
CB.shrinkMon = function (b: any): void {
  const t = b.task, p = b.mon;
  t.count = t.count + 1;
  if (t.count === 11) play_se(SE.SE_BALL_TRADE);
  if (t.state === 0) {
    t.scale = 256;
    const dist = (b.monY + (p.oy ?? 0)) - (b.y + b.y2);
    const delta = dist * 256 / 28;
    t.delta = (delta < 0) ? Math.ceil(delta) : Math.floor(delta);
    t.state = 1;
  } else if (t.state === 1) {
    t.scale = t.scale + 0x20;
    p.scale = 256 / t.scale;
    t.acc = t.acc + t.delta;
    p.oy = Math.floor(-t.acc / 256);
    if (t.scale >= 0x480) t.state = 2;
  } else if (t.state === 2) {
    p.scale = 1;
    p.visible = false;
    t.state = 3;
  } else if (t.count > 10) {
    b.task = undefined;
    start_anim(b, 2);
    b.data[5] = 0;
    b.cb = CB.initialFall;
  }
};

// pokefirered/src/battle_anim_special.c:921
// Lua: catch_seq.lua:430
CB.initialFall = function (b: any): void {
  if (!truthy(b.animEnded)) return;
  const d = b.data;
  d[3] = 0; d[4] = 40; d[5] = 0;
  b.y = b.y + BallOpen.cos(0, 40);
  b.y2 = -BallOpen.cos(0, d[4]);
  b.cb = CB.bounce;
};

// Lua: catch_seq.lua:439 (BOUNCE_SE, built on first use)
let BOUNCE_SE: LuaTable | undefined;
function bounce_se(count: number): any {
  BOUNCE_SE = BOUNCE_SE ?? seq(SE.SE_BALL_BOUNCE_1, SE.SE_BALL_BOUNCE_2, SE.SE_BALL_BOUNCE_3);
  return BOUNCE_SE[count] ?? SE.SE_BALL_BOUNCE_4;
}

// pokefirered/src/battle_anim_special.c:937
// Lua: catch_seq.lua:442
CB.bounce = function (b: any): void {
  const d = b.data;
  let lastBounce = false;
  const low = lmod(d[3], 256), hi = Math.floor(d[3] / 256);
  if (low === 0) {
    b.y2 = -BallOpen.cos(d[5], d[4]);
    d[5] = d[5] + hi + 4;
    if (d[5] >= 64) {
      d[4] = d[4] - 10;
      d[3] = d[3] + 257;
      const count = Math.floor(d[3] / 256);
      if (count === 4) lastBounce = true;
      play_se(bounce_se(count));
    }
  } else if (low === 1) {
    b.y2 = -BallOpen.cos(d[5], d[4]);
    d[5] = d[5] - (hi + 4);
    if (d[5] <= 0) {
      d[5] = 0;
      d[3] = d[3] - low;
    }
  }
  if (lastBounce) {
    d[3] = 0;
    b.y = b.y + BallOpen.cos(64, 40);
    b.y2 = 0;
    d[5] = 0;
    if (b.caseId === 0) {
      b.cb = CB.delayThenBreakOut;
    } else {
      d[4] = 1;
      b.cb = CB.initShake;
    }
  }
};

// pokefirered/src/battle_anim_special.c:1005
// Lua: catch_seq.lua:479
CB.initShake = function (b: any): void {
  const d = b.data;
  d[3] = d[3] + 1;
  if (d[3] === 31) {
    d[3] = 0;
    b.aff.paused = true;
    affine_start(b.aff, 1);
    b.subpx = 0;
    b.cb = CB.doShake;
    play_se(SE.SE_BALL);
  }
};

// Lua: catch_seq.lua:492
function shake_move(b: any): void {
  if (b.subpx > 0xFF) {
    b.x2 = b.x2 + b.data[4];
    b.subpx = lmod(b.subpx, 256);
  } else {
    b.subpx = b.subpx + 0xB0;
  }
  b.data[5] = b.data[5] + 1;
  b.aff.paused = false;
}

// Lua: catch_seq.lua:503
function shake_turn(b: any): void {
  const d = b.data;
  d[5] = 0;
  d[4] = -d[4];
  d[3] = d[3] + 1;
  b.aff.paused = false;
  affine_change(b.aff, (d[4] < 0) ? 2 : 1);
}

// pokefirered/src/battle_anim_special.c:1018
// Lua: catch_seq.lua:513
CB.doShake = function (b: any): void {
  const d = b.data;
  const low = lmod(d[3], 256);
  if (low === 0) {
    shake_move(b);
    if (d[5] + 7 > 14) {
      b.subpx = 0;
      d[3] = d[3] + 1;
      d[5] = 0;
    }
  } else if (low === 1) {
    d[5] = d[5] + 1;
    if (d[5] === 1) {
      shake_turn(b);
    } else {
      b.aff.paused = true;
    }
  } else if (low === 2) {
    shake_move(b);
    if (d[5] + 12 > 24) {
      b.subpx = 0;
      d[3] = d[3] + 1;
      d[5] = 0;
    }
  } else if (low === 3 || low === 4) {
    if (low === 3) {
      const v = d[5];
      d[5] = v + 1;
      if (v < 0) {
        b.aff.paused = true;
        return;
      }
      shake_turn(b);
    }
    shake_move(b);
    if (d[5] + 4 > 8) {
      b.subpx = 0;
      d[3] = d[3] + 1;
      d[5] = 0;
      d[4] = -d[4];
    }
  } else if (low === 5) {
    d[3] = d[3] + 0x100;
    const state = Math.floor(d[3] / 256);
    b.aff.paused = true;
    if (state === b.caseId) {
      b.cb = CB.delayThenBreakOut;
    } else if (b.caseId === 4 && state === 3) {
      b.cb = CB.initClick;
    } else {
      d[3] = d[3] + 1;
    }
  } else {
    d[5] = d[5] + 1;
    if (d[5] === 31) {
      d[5] = 0;
      d[3] = d[3] - low;
      affine_start(b.aff, 3);
      affine_start(b.aff, (d[4] < 0) ? 2 : 1);
      play_se(SE.SE_BALL);
    }
  }
};

// pokefirered/src/battle_anim_special.c:1162
// Lua: catch_seq.lua:578
CB.delayThenBreakOut = function (b: any): void {
  b.data[5] = b.data[5] + 1;
  if (b.data[5] === 31) {
    b.data[5] = 0;
    b.cb = CB.beginBreakOut;
  }
};

// pokefirered/src/battle_anim_special.c:1305
// Lua: catch_seq.lua:587
CB.beginBreakOut = function (b: any): void {
  start_anim(b, 1);
  affine_start(b.aff, 0);
  b.cb = CB.runBreakOut;
  BallOpen.start(truthy(b.target) ? b.target : 1, b.x, b.y, b.itemId, true);
  play_se(SE.SE_BALL_OPEN);
  if (truthy(b.mon)) {
    b.mon.visible = true;
    b.monAff = { paused: false };
    affine_start(b.monAff, 1);
    affine_step(b.monAff, MON_AFFINE);
    b.mon.scale = b.monAff.scale / 256;
    b.monData1 = 0x1000;
  }
};

// pokefirered/src/battle_anim_special.c:1327
// Lua: catch_seq.lua:604
CB.runBreakOut = function (b: any): void {
  const p = b.mon;
  let nextStep = false;
  if (truthy(b.animEnded)) b.invisible = true;
  if (b.monAff.ended) {
    affine_start(b.monAff, 0);
    nextStep = true;
  } else {
    b.monData1 = b.monData1 - 288;
    p.oy = Math.floor(b.monData1 / 256);
  }
  if (truthy(b.animEnded) && nextStep) {
    p.oy = 0;
    p.visible = true;
    b.data[0] = 0;
    b.cb = CB.signalEnd;
  }
};

// pokefirered/src/battle_anim_special.c:1171
// Lua: catch_seq.lua:624
CB.initClick = function (b: any): void {
  b.animPaused = true;
  b.cb = CB.doClick;
  b.data[3] = 0; b.data[4] = 0; b.data[5] = 0;
};

// pokefirered/src/battle_anim_special.c:1298
// Lua: catch_seq.lua:631
function star_cb(p: any): void {
  p.invisible = !truthy(p.invisible);
  if (translate_arc(p)) p.dead = true;
}

// pokefirered/src/battle_anim_special.c:1180
// Lua: catch_seq.lua:637
CB.doClick = function (b: any): void {
  const d = b.data;
  d[4] = d[4] + 1;
  if (d[4] === 40) {
    play_se(SE.SE_BALL_CLICK);
    b.blend.coeff = 6; b.blend.r = 0; b.blend.g = 0; b.blend.b = 0;
    // pokefirered/src/battle_anim_special.c:1266
    for (const [, c] of ipairs<any>(CAPTURE_STARS)) {
      const p = BallOpen.spawnSprite(b.x, b.y, 1, star_cb);
      p.invisible = false;
      arc_init(p, 24, b.x + c[1], b.y + c[2], c[3]);
    }
  } else if (d[4] === 60) {
    BallOpen.beginFade(6, 0, { obj: b.blend, delay: 2, color: seq(0, 0, 0) });
  } else if (d[4] === 95) {
    try {
      Audio.stopAll();
      Audio.playSe(caught_song("caughtIntro"));
    } catch { /* pcall */ }
  } else if (d[4] === 315) {
    b.mon.visible = false;
    d[0] = 0;
    b.cb = CB.finishClick;
  }
};

// pokefirered/src/battle_anim_special.c:1211
// Lua: catch_seq.lua:664
CB.finishClick = function (b: any): void {
  const d = b.data;
  if (d[0] === 0) {
    d[1] = 0; d[2] = 0;
    b.alpha = 1;
    BallOpen.beginFade(0, 16, { obj: b.blend, color: seq(31, 31, 31) });
    d[0] = 1;
  } else if (d[0] === 1) {
    const v = d[1];
    d[1] = v + 1;
    if (v > 0) {
      d[1] = 0;
      d[2] = d[2] + 1;
      b.alpha = (16 - d[2]) / 16;
      if (d[2] === 16) d[0] = 2;
    }
  } else if (d[0] === 2) {
    b.invisible = true;
    d[0] = 3;
  } else if (!BallOpen.fadeActive()) {
    d[0] = 0;
    b.cb = CB.signalEnd;
  }
};

// pokefirered/src/battle_anim_special.c:1253
// Lua: catch_seq.lua:690
CB.signalEnd = function (b: any): void {
  if (b.data[0] === 0) {
    b.data[0] = -1;
    b.finished = true;
  } else {
    b.dead = true;
  }
};

// pokefirered/src/sprite.c:304
// Lua: catch_seq.lua:700
function ball_update(b: any): void {
  if (truthy(b.monAff)) {
    affine_step(b.monAff, MON_AFFINE);
    b.mon.scale = b.monAff.scale / 256;
  }
  b.cb(b);
  const s = b.stage;
  if (truthy(b.dead)) {
    s.visible = false; s.blend = undefined; s.alpha = undefined; s.rot = 0;
    return;
  }
  BallOpen.animate(b);
  affine_step(b.aff, BALL_AFFINE);
  s.visible = !truthy(b.invisible);
  s.x = b.x + b.x2; s.y = b.y + b.y2;
  s.ox = 0; s.oy = 0;
  s.frame = b.frame;
  s.rot = -b.aff.rotation * Math.PI / 32768;
  s.blend = (b.blend.coeff > 0) ? b.blend : undefined;
  s.alpha = b.alpha;
}

// pokefirered/src/battle_anim_special.c:734
// Lua: catch_seq.lua:723
function start_ball(d: any): any {
  const st = CatchSeq._st;
  const target = tonumber(d.target) ?? CatchSeq._target ?? 1;
  const enemy = Anim.Coords.battler(st, target);
  let sp = truthy(enemy) ? enemy.species : undefined;
  if (!truthy(sp) && truthy(enemy) && truthy(enemy.mon)) {
    sp = (truthy(Pokemon.speciesOf) ? Pokemon.speciesOf(enemy.mon) : undefined)
      || enemy.mon.species || enemy.mon.speciesId;
  }
  const base = Anim.coords(st, target) ?? Anim.ENEMY_MON;
  let monY = base.y;
  if (truthy(Ui.battlerSpriteCenter)) {
    const [, cy] = Ui.battlerSpriteCenter("enemy", sp, { x: base.x, y: base.y });
    monY = cy;
  }
  const stage = Anim.stage().ball;
  stage.visible = false; stage.darken = 0; stage.flash = 0; stage.side = "enemy";
  // pokefirered/src/battle_anim_special.c:668
  stage.ballId = BallOpen.ballIdForItem(d.itemId);
  const b: any = {
    x: 32, y: 80, x2: 0, y2: 0,
    data: [34, base.x, base.y - 16, 0, 0, 0, 0, 0],
    anims: BALL_ANIMS, animNum: 0, animBeginning: true, animEnded: false, animPaused: false,
    frame: 0, hFlip: false, delay: 0, cmd: 1,
    aff: { paused: false },
    blend: { coeff: 0, r: 0, g: 0, b: 0 },
    alpha: 1,
    subpx: 0,
    caseId: d.caseId ?? 0,
    itemId: d.itemId,
    mon: Anim.present(target),
    target,
    monY,
    stage,
    cb: CB.init,
    update: ball_update,
  };
  affine_start(b.aff, 0);
  return BallOpen.addSprite(b);
}
CatchSeq.startBall = start_ball;

// Lua: catch_seq.lua:765
function run_step(step: any): void {
  if (!truthy(step)) {
    finish();
    return;
  }

  const kind = step.kind;
  const d = step.data ?? {};

  if (kind === "msg") {
    if (truthy(CatchSeq._pushMsg) && truthy(d.text)) {
      CatchSeq._pushMsg!(d.text, d.wait);
    }
    CatchSeq._waiting = true;
    CatchSeq._waitingMsg = true;
    return;
  }

  if (kind === "throw") {
    if (truthy(Anim._headless)) {
      advance();
      return;
    }
    try { Audio.playSe(SE.SE_BALL_THROW, { pan: 0 }); } catch { /* pcall */ }
    CatchSeq._ball = start_ball(d);
    CatchSeq._waitingBall = true;
    return;
  }

  if (kind === "capture_success") {
    let res: any;
    // pokefirered/data/battle_scripts_2.s:99 BattleScript_OldMan_Pokedude_CaughtMessage
    const cst = CatchSeq._st;
    if (!(truthy(cst) && (truthy(cst.oldManTutorial) || truthy(cst.pokedude) || wally(cst)))) {
      res = Catching.storeCaught(CatchSeq._session, truthy(cst) ? cst.enemy : undefined, d.ballId,
        { deferPc: true });
    }
    CatchSeq._catchResult = res;
    // pokefirered/data/battle_scripts_2.s:77
    if (truthy(CatchSeq._pushMsg)) {
      CatchSeq._pushMsg!(catch_text(gotcha_id(CatchSeq._st)));
    }
    try {
      Audio.waitSe(caught_song("caughtIntro"), () => { Audio.playSong(caught_song("caught")); });
    } catch { /* pcall */ }
    if (truthy(CatchSeq._pushMsg)) {
      if (truthy(res) && truthy(res.firstTimeCaught)) {
        CatchSeq._pushMsg!(catch_text("STRINGID_PKMNDATAADDEDTODEX"));
      }
    }
    advance();
    return;
  }

  if (kind === "breakout") {
    if (truthy(CatchSeq._pushMsg)) {
      // pokefirered/data/battle_scripts_2.s:106
      CatchSeq._pushMsg!(catch_text(BALL_ESCAPE[d.shakes]!));
    }
    advance();
    return;
  }

  advance();
}

// Lua: catch_seq.lua:830
CatchSeq.update = function (): boolean {
  if (!truthy(CatchSeq._steps)) return true;

  if (CatchSeq._waitingBall) {
    const b = CatchSeq._ball;
    let alive = false;
    for (const [, s] of ipairs(BallOpen._sprites)) {
      if (s === b) alive = true;
    }
    if (alive && !truthy(b.finished)) return false;
    CatchSeq._waitingBall = false;
    advance();
  }

  if (CatchSeq._waitingMsg) {
    let pending: any = false;
    if (truthy(Ui.dialogPending)) {
      pending = Ui.dialogPending();
    } else if (!truthy(Ui._headless)) {
      pending = (Ui._showing === true) || (truthy(Ui._queue) && len(Ui._queue) > 0);
    }
    if (truthy(pending)) {
      return false;
    }
    CatchSeq._waitingMsg = false;
    CatchSeq._waiting = false;
    advance();
  }

  if (CatchSeq._waiting) {
    if (!Anim.busy()) {
      advance();
    } else {
      return false;
    }
  }

  const step = CatchSeq._steps![CatchSeq._i];
  if (!truthy(step)) {
    finish();
    return true;
  }
  run_step(step);
  return false;
};

export default CatchSeq;
