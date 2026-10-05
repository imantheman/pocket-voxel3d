// Port of gen1recomp src/core/game3/battle/anim_port/g2_fight.lua (GPLv3 + additional terms; see LICENSE.md).
// pokefirered battle_anim_fight.c on the g2_pret kit.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { mod } from "../../../../../import/gen3/lua.ts";
import P from "./g2_pret.ts";

type S = Record<string, any>;
type T = Record<string, any>;

const CB: Record<string, any> = {};
const TASKS: Record<string, any> = {};

// Brian's `TASKS.X = P.task(fn)` runs at require time; here the wrap is made on
// the first call (no top-level read of g2_pret inside the import cycle).
function task(entry: (t: T, vm: any) => void): (t: T, vm: any) => void {
  let w: any = null;
  return (t: T, vm: any): void => { (w ??= P.task(entry))(t, vm); };
}

// Lua: g2_fight.lua:7 -- pokefirered/src/battle_anim_fight.c:416
CB.SlideHandOrFootToTarget = function (s: S): void {
  if (P.arg(7) === 1 && P.atk() !== "player") {
    P.setArg(1, -P.arg(1));
    P.setArg(3, -P.arg(3));
  }
  P.startAnim(s, P.arg(6));
  P.setArg(6, 0);
  P.AnimTravelDiagonally(s);
};

// Lua: g2_fight.lua:18 -- pokefirered/src/battle_anim_fight.c:428
CB.JumpKick = function (s: S): void {
  CB.SlideHandOrFootToTarget(s);
};

// Lua: g2_fight.lua:23 -- pokefirered/src/battle_anim_fight.c:445
CB.BasicFistOrFoot = function (s: S): void {
  P.startAnim(s, P.arg(4));
  if (P.arg(3) === 0) {
    P.InitSpritePosToAnimAttacker(s, true);
  } else {
    P.InitSpritePosToAnimTarget(s, true);
  }
  s.data[0] = P.arg(2);
  s.pcb = P.WaitAnimForDuration;
  P.storeCallback(s, P.DestroyAnimSprite);
};

// Lua: g2_fight.lua:35
function fist_random_step(s: S): void {
  if (s.data[0] === 0) {
    const child = s.g2.child;
    if (child) P.destroy(child);
    P.destroy(s);
  } else {
    s.data[0] = s.data[0] - 1;
  }
}

// Lua: g2_fight.lua:46 -- pokefirered/src/battle_anim_fight.c:457
CB.FistOrFootRandomPos = function (s: S): void {
  let b: any;
  if (P.arg(0) === 0) b = P.atk(); else b = P.tgt();
  if (P.arg(2) < 0) P.setArg(2, mod(P.Random(), 5));
  P.startAnim(s, P.arg(2));
  s.x = P.coord(b, 2);
  s.y = P.coord(b, 3);
  const xMod = P.div(P.coordAttr(b, P.ATTR_WIDTH), 2);
  const yMod = P.div(P.coordAttr(b, P.ATTR_HEIGHT), 4);
  let x = (xMod !== 0) ? mod(P.Random(), xMod) : 0;
  let y = (yMod !== 0) ? mod(P.Random(), yMod) : 0;
  if (mod(P.Random(), 2) === 1) x = -x;
  if (mod(P.Random(), 2) === 1) y = -y;
  if (b === "player") y = P.s16(y + 0xFFF0);
  s.x = s.x + x;
  s.y = s.y + y;
  s.data[0] = P.arg(1);
  const child = P.createSprite("gBasicHitSplatSpriteTemplate", s.x, s.y, s.subpriority + 1, false, false, false);
  if (child) {
    P.startAffineAnim(child, 0);
    s.g2.child = child;
  }
  s.pcb = fist_random_step;
};

// Lua: g2_fight.lua:71
function cross_chop_step(s: S): void {
  s.data[5] = s.data[5] + 1;
  if (s.data[5] === 11) {
    s.data[2] = s.x - s.x2;
    s.data[4] = s.y - s.y2;
    s.data[0] = 8;
    s.x = s.x + s.x2;
    s.y = s.y + s.y2;
    s.y2 = 0;
    s.x2 = 0;
    s.pcb = P.StartAnimLinearTranslation;
    P.storeCallback(s, P.DestroyAnimSprite);
  }
}

// Lua: g2_fight.lua:87 -- pokefirered/src/battle_anim_fight.c:512
CB.CrossChopHand = function (s: S): void {
  P.InitSpritePosToAnimTarget(s, true);
  s.data[0] = 30;
  if (P.arg(2) === 0) {
    s.data[2] = s.x - 20;
  } else {
    s.data[2] = s.x + 20;
    s.pHFlip = true;
  }
  s.data[4] = s.y - 20;
  s.pcb = P.StartAnimLinearTranslation;
  P.storeCallback(s, cross_chop_step);
};

// Lua: g2_fight.lua:101
function sliding_kick_step(s: S): void {
  if (!P.AnimTranslateLinear(s)) {
    s.y2 = s.y2 + P.Sin(P.asr(s.data[7], 8), s.data[5]);
    s.data[7] = P.s16(s.data[7] + s.data[6]);
  } else {
    P.destroy(s);
  }
}

// Lua: g2_fight.lua:111 -- pokefirered/src/battle_anim_fight.c:547
CB.SlidingKick = function (s: S): void {
  P.InitSpritePosToAnimTarget(s, true);
  if (P.atk() !== "player") P.setArg(2, -P.arg(2));
  s.data[0] = P.arg(3);
  s.data[1] = s.x;
  s.data[2] = s.x + P.arg(2);
  s.data[3] = s.y;
  s.data[4] = s.y;
  P.InitAnimLinearTranslation(s);
  s.data[5] = P.arg(5);
  s.data[6] = P.arg(4);
  s.data[7] = 0;
  s.pcb = sliding_kick_step;
};

// Lua: g2_fight.lua:126
function spinning_finish(s: S): void {
  P.startAffineAnim(s, 0);
  s.affineAnimPaused = true;
  s.data[0] = 20;
  s.pcb = P.WaitAnimForDuration;
  P.storeCallback(s, P.DestroyAnimSprite);
}

// Lua: g2_fight.lua:135 -- pokefirered/src/battle_anim_fight.c:585
CB.SpinningKickOrPunch = function (s: S): void {
  P.InitSpritePosToAnimTarget(s, true);
  P.startAnim(s, P.arg(2));
  s.data[0] = P.arg(3);
  s.pcb = P.WaitAnimForDuration;
  P.storeCallback(s, spinning_finish);
};

// Lua: g2_fight.lua:143
function stomp_end(s: S): void {
  s.data[0] = 15;
  s.pcb = P.WaitAnimForDuration;
  P.storeCallback(s, P.DestroyAnimSprite);
}

// Lua: g2_fight.lua:149
function stomp_step(s: S): void {
  s.data[0] = s.data[0] - 1;
  if (s.data[0] === -1) {
    s.data[0] = 6;
    s.data[2] = P.coord(P.tgt(), 2);
    s.data[4] = P.coord(P.tgt(), 3);
    s.pcb = P.StartAnimLinearTranslation;
    P.storeCallback(s, stomp_end);
  }
}

// Lua: g2_fight.lua:161 -- pokefirered/src/battle_anim_fight.c:607
CB.StompFoot = function (s: S): void {
  P.InitSpritePosToAnimTarget(s, true);
  s.data[0] = P.arg(2);
  s.pcb = stomp_step;
};

// Lua: g2_fight.lua:167
function dizzy_duck(s: S): void {
  if (s.data[0] === 0) {
    P.InitSpritePosToAnimTarget(s, true);
    s.data[1] = P.arg(2);
    s.data[2] = P.arg(3);
    s.data[0] = s.data[0] + 1;
  } else {
    s.data[4] = P.s16(s.data[4] + s.data[1]);
    s.x2 = P.asr(s.data[4], 8);
    s.y2 = P.Sin(s.data[3], s.data[2]);
    s.data[3] = mod(s.data[3] + 3, 256);
    if (s.data[3] > 100) s.invisible = mod(s.data[3], 2) === 1;
    if (s.data[3] > 120) P.destroy(s);
  }
}

// Lua: g2_fight.lua:184 -- pokefirered/src/battle_anim_fight.c:633
CB.DizzyPunchDuck = function (s: S): void {
  dizzy_duck(s);
  s.pcb = dizzy_duck;
};

// Lua: g2_fight.lua:189
function brick_wall_step(s: S): void {
  const d = s.data;
  if (d[0] === 0) {
    d[1] = d[1] - 1;
    if (d[1] === 0) {
      if (d[2] === 0) {
        P.destroy(s);
      } else {
        d[0] = d[0] + 1;
      }
    }
  } else if (d[0] === 1) {
    d[1] = d[1] + 1;
    if (d[1] > 1) {
      d[1] = 0;
      d[3] = d[3] + 1;
      if (mod(d[3], 2) === 1) s.x2 = 2; else s.x2 = -2;
    }
    d[2] = d[2] - 1;
    if (d[2] === 0) P.destroy(s);
  }
}

// Lua: g2_fight.lua:213 -- pokefirered/src/battle_anim_fight.c:656
CB.BrickBreakWall = function (s: S): void {
  const b = (P.arg(0) === 0) ? P.atk() : P.tgt();
  s.x = P.coord(b, 0);
  s.y = P.coord(b, 1);
  s.x = s.x + P.arg(1);
  s.y = s.y + P.arg(2);
  s.data[0] = 0;
  s.data[1] = P.arg(3);
  s.data[2] = P.arg(4);
  s.data[3] = 0;
  s.pcb = brick_wall_step;
};

// Lua: g2_fight.lua:226
function brick_shard_step(s: S): void {
  s.x = s.x + s.data[6];
  s.y = s.y + s.data[7];
  s.data[0] = s.data[0] + 1;
  if (s.data[0] > 40) P.destroy(s);
}

// Lua: g2_fight.lua:234 -- pokefirered/src/battle_anim_fight.c:708
CB.BrickBreakWallShard = function (s: S): void {
  const b = (P.arg(0) === P.ANIM_ATTACKER) ? P.atk() : P.tgt();
  s.x = P.coord(b, 0) + P.arg(2);
  s.y = P.coord(b, 1) + P.arg(3);
  s.tileBase = s.tileBase + P.arg(1) * 16;
  s.data[0] = 0;
  const a1 = P.arg(1);
  if (a1 === 0) {
    s.data[6] = -3; s.data[7] = -3;
  } else if (a1 === 1) {
    s.data[6] = 3; s.data[7] = -3;
  } else if (a1 === 2) {
    s.data[6] = -3; s.data[7] = 3;
  } else if (a1 === 3) {
    s.data[6] = 3; s.data[7] = 3;
  } else {
    P.destroy(s);
    return;
  }
  s.pcb = brick_shard_step;
};

// Lua: g2_fight.lua:256
function superpower_orb_step(s: S): void {
  s.data[0] = s.data[0] + 1;
  if (s.data[0] === 180) {
    s.objBlend = false;
    s.data[0] = 16;
    s.data[1] = s.x;
    s.data[2] = P.coord(s.g2.dest, 2);
    s.data[3] = s.y;
    s.data[4] = P.coord(s.g2.dest, 3);
    P.InitAnimLinearTranslation(s);
    P.storeCallback(s, P.DestroySpriteAndMatrix);
    s.pcb = P.AnimTranslateLinear_WithFollowup;
  }
}

// Lua: g2_fight.lua:272 -- pokefirered/src/battle_anim_fight.c:755
CB.SuperpowerOrb = function (s: S): void {
  if (P.arg(0) === 0) {
    s.x = P.coord(P.atk(), 2);
    s.y = P.coord(P.atk(), 3);
    s.oamPriority = P.bgPriority(P.atk());
    s.g2.dest = P.tgt();
  } else {
    s.oamPriority = P.bgPriority(P.tgt());
    s.g2.dest = P.atk();
  }
  s.data[0] = 0;
  s.data[1] = 12;
  s.data[2] = 8;
  s.pcb = superpower_orb_step;
};

// Lua: g2_fight.lua:288
function superpower_rock_step2(s: S): void {
  s.data[2] = P.s16(s.data[2] + s.data[0]);
  s.data[3] = P.s16(s.data[3] + s.data[1]);
  s.x = P.asr(s.data[2], 4);
  s.y = P.asr(s.data[3], 4);
  const edgeX = P.u16(s.x + 8);
  if (edgeX > 256 || s.y < -8 || s.y > 120) P.destroy(s);
}

// Lua: g2_fight.lua:297
function superpower_rock_step1(s: S): void {
  if (s.data[0] !== 0) {
    s.g2.fy = s.g2.fy - s.data[6];
    s.y = P.asr(s.g2.fy, 8);
    if (s.y < -8) {
      P.destroy(s);
    } else {
      s.data[0] = s.data[0] - 1;
    }
  } else {
    const pos0 = P.coord(P.atk(), 2);
    const pos1 = P.coord(P.atk(), 3);
    const pos2 = P.coord(P.tgt(), 2);
    const pos3 = P.coord(P.tgt(), 3);
    s.data[0] = pos2 - pos0;
    s.data[1] = pos3 - pos1;
    s.data[2] = P.s16(s.x * 16);
    s.data[3] = P.s16(s.y * 16);
    s.pcb = superpower_rock_step2;
  }
}

// Lua: g2_fight.lua:320 -- pokefirered/src/battle_anim_fight.c:792
CB.SuperpowerRock = function (s: S): void {
  s.x = P.arg(0);
  s.y = 120;
  s.data[0] = P.arg(3);
  s.g2.fy = s.y * 256;
  s.data[6] = P.arg(1);
  s.tileBase = s.tileBase + P.arg(2) * 4;
  s.pcb = superpower_rock_step1;
};

// Lua: g2_fight.lua:331 -- pokefirered/src/battle_anim_fight.c:847
CB.SuperpowerFireball = function (s: S): void {
  let b: any;
  if (P.arg(0) === P.ANIM_ATTACKER) {
    s.x = P.coord(P.atk(), 2);
    s.y = P.coord(P.atk(), 3);
    b = P.tgt();
    s.oamPriority = P.bgPriority(P.atk());
  } else {
    b = P.atk();
    s.oamPriority = P.bgPriority(P.tgt());
  }
  if (b === "player") {
    s.pHFlip = true;
    s.pVFlip = true;
  }
  s.data[0] = 16;
  s.data[1] = s.x;
  s.data[2] = P.coord(b, 2);
  s.data[3] = s.y;
  s.data[4] = P.coord(b, 3);
  P.InitAnimLinearTranslation(s);
  P.storeCallback(s, P.DestroyAnimSprite);
  s.pcb = P.AnimTranslateLinear_WithFollowup;
};

// Lua: g2_fight.lua:356
function arm_thrust_step(s: S): void {
  if (s.data[0] === s.data[4]) {
    P.destroy(s);
    return;
  }
  s.data[0] = s.data[0] + 1;
}

// Lua: g2_fight.lua:365 -- pokefirered/src/battle_anim_fight.c:884
CB.ArmThrustHit = function (s: S): void {
  s.x = P.coord(P.tgt(), 2);
  s.y = P.coord(P.tgt(), 3);
  s.data[1] = P.arg(3);
  s.data[2] = P.arg(0);
  s.data[3] = P.arg(1);
  s.data[4] = P.arg(2);
  let turn = mod(P.turn(), 256);
  if (P.tgt() === "player") turn = turn + 1;
  if (mod(turn, 2) === 1) {
    s.data[2] = -s.data[2];
    s.data[1] = s.data[1] + 1;
  }
  P.startAnim(s, s.data[1]);
  s.x2 = s.data[2];
  s.y2 = s.data[3];
  s.pcb = arm_thrust_step;
};

// Lua: g2_fight.lua:385 -- pokefirered/src/battle_anim_fight.c:908
CB.RevengeScratch = function (s: S): void {
  if (P.arg(2) === P.ANIM_ATTACKER) {
    P.InitSpritePosToAnimAttacker(s, false);
  } else {
    P.InitSpritePosToAnimTarget(s, false);
  }
  if (P.atk() !== "player") P.startAnim(s, 1);
  s.pcb = P.RunStoredCallbackWhenAnimEnds;
  P.storeCallback(s, P.DestroyAnimSprite);
};

// Lua: g2_fight.lua:397 -- pokefirered/src/battle_anim_fight.c:923
CB.FocusPunchFist = function (s: S): void {
  if (s.affineAnimEnded) {
    s.data[1] = mod(s.data[1] + 40, 256);
    s.x2 = P.Sin(s.data[1], 2);
    s.data[0] = s.data[0] + 1;
    if (s.data[0] > 40) P.destroy(s);
  }
  s.pcb = CB.FocusPunchFist;
};

// Lua: g2_fight.lua:407
function sky_uppercut_tail(t: T): void {
  const d = t.data;
  d[10] = P.s16(d[10] + 2816);
  const sc = t.g2.scroll;
  if (P.tgt() === "player") {
    sc.x = P.u16(sc.x + P.asr(d[9], 8));
  } else {
    sc.x = P.u16(sc.x - P.asr(d[9], 8));
  }
  sc.y = P.u16(sc.y + P.asr(d[10], 8));
  d[9] = mod(d[9], 256);
  d[10] = mod(d[10], 256);
  if (P.arg(7) === -1) {
    sc.x = 0;
    sc.y = 0;
    const Anim = P.anim();
    if (Anim && Anim._bg3Scroll === sc) Anim._bg3Scroll = null;
    P.destroyTask(t);
  }
}

// Lua: g2_fight.lua:428
function sky_uppercut_step(t: T): void {
  const d = t.data;
  if (d[0] === 1) {
    d[8] = d[8] - 1;
    if (d[8] === -1) d[0] = d[0] + 1;
  } else if (d[0] >= 2) {
    d[9] = P.s16(d[9] + 1280);
  }
  sky_uppercut_tail(t);
}

// Lua: g2_fight.lua:440 -- pokefirered/src/battle_anim_fight.c:934
TASKS.MoveSkyUppercutBg = task(function (t: T): void {
  const vm = P.vm;
  if (vm && !vm.bg3) vm.bg3 = { x: 0, y: 0 };
  const sc = (vm && vm.bg3) ? vm.bg3 : { x: 0, y: 0 };
  t.g2.scroll = sc;
  const Anim = P.anim();
  if (Anim) Anim._bg3Scroll = sc;
  t.data[8] = P.arg(0);
  t.data[0] = 1;
  t.func = sky_uppercut_step;
  sky_uppercut_tail(t);
});

// Lua: g2_fight.lua:453
export const G2Fight = { cb: CB, tasks: TASKS };
export default G2Fight;
