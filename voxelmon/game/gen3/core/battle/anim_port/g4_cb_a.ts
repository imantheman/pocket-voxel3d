// Port of gen1recomp src/core/game3/battle/anim_port/g4_cb_a.lua (GPLv3 + additional terms; see LICENSE.md).
// g4 sprite callbacks, part A: safari bait/rock, bug, electric, ground and
// poison particles (pokefirered battle_anim_bug.c, _electric.c, _ground.c,
// _poison.c, _special.c).

/* eslint-disable @typescript-eslint/no-explicit-any */
type S = Record<string, any>;
type Cb = (s: S) => void;

// Lua: g4_cb_a.lua:2
export default function g4CbA(C: Record<string, any>): Record<string, any> {
  const P = C.P, T = C.T;
  const CB: Record<string, any> = {};

  // Lua: g4_cb_a.lua:6
  function args(s: S): any { return s._vm.args; }
  // Lua: g4_cb_a.lua:7
  function isOpp(side: any): boolean { return side !== "player"; }

  // Lua: g4_cb_a.lua:10 -- pokefirered/src/battle_anim_mons.c:1440
  C.translateToTargetMonLocation = function (s: S): void {
    const vm = s._vm;
    const a = args(s);
    const respect = (P.u16(a[5]) & 0xFF00) === 0;
    const coordType = ((P.u16(a[5]) & 0xFF) === 0) ? P.Y_PIC_OFFSET : P.Y;
    P.initPosToAttacker(vm, s, respect);
    if (isOpp(P.atk(vm))) a[2] = -a[2];
    s.data[0] = a[4];
    s.data[2] = P.coord(vm, P.tgt(vm), P.X_2) + a[2];
    s.data[4] = P.coord(vm, P.tgt(vm), coordType) + a[3];
    s.callback = P.startLinear;
    P.storeCb(s, P.destroy);
  };

  // pokefirered/src/battle_anim_special.c:2216
  // Lua: g4_cb_a.lua:26
  CB.SpriteCB_SafariBaitOrRock_Init = function (s: S): void {
    const vm = s._vm;
    const a = args(s);
    P.initPosToAttacker(vm, s, false);
    s.data[0] = 30;
    s.data[2] = P.coord(vm, "enemy", P.X) + a[2];
    s.data[4] = P.coord(vm, "enemy", P.Y) + a[3];
    s.data[5] = -32;
    P.initArc(s);
    C.startPlayerThrow(vm);
    s.callback = safariWait;
  };
  // Lua: g4_cb_a.lua:38
  const safariWait: Cb = function (s) {
    if (C.playerThrowIndex(s._vm) === 1) s.callback = safariArc;
  };
  // Lua: g4_cb_a.lua:41
  const safariArc: Cb = function (s) {
    if (P.translateHArc(s)) {
      s.data[0] = 0;
      P.setInvisible(s, true);
      s.callback = safariFinish;
    }
  };
  // Lua: g4_cb_a.lua:48
  const safariFinish: Cb = function (s) {
    if (C.playerThrowEnded(s._vm)) {
      s.data[0] = s.data[0] + 1;
      if (s.data[0] > 0) {
        C.resetPlayerThrow(s._vm);
        P.destroy(s);
      }
    }
  };

  // Lua: g4_cb_a.lua:59 -- pokefirered/src/battle_anim_bug.c:197
  CB.MegahornHorn = function (s: S): void {
    const vm = s._vm;
    const a = args(s);
    if (P.tgt(vm) === "player") {
      P.startAffineAnim(s, 1);
      a[1] = -a[1]; a[2] = -a[2]; a[3] = -a[3]; a[0] = -a[0];
    }
    s.x = P.coord(vm, P.tgt(vm), P.X_2) + a[0];
    s.y = P.coord(vm, P.tgt(vm), P.Y_PIC_OFFSET) + a[1];
    s.data[0] = a[4];
    s.data[2] = P.coord(vm, P.tgt(vm), P.X_2) + a[2];
    s.data[4] = P.coord(vm, P.tgt(vm), P.Y_PIC_OFFSET) + a[3];
    s.callback = P.startLinear;
    P.storeCb(s, P.destroy);
  };

  // Lua: g4_cb_a.lua:76 -- pokefirered/src/battle_anim_bug.c:222
  CB.LeechLifeNeedle = function (s: S): void {
    const vm = s._vm;
    const a = args(s);
    if (P.tgt(vm) === "player") {
      a[1] = -a[1]; a[0] = -a[0];
    }
    s.x = P.coord(vm, P.tgt(vm), P.X_2) + a[0];
    s.y = P.coord(vm, P.tgt(vm), P.Y_PIC_OFFSET) + a[1];
    s.data[0] = a[2];
    s.data[2] = P.coord(vm, P.tgt(vm), P.X_2);
    s.data[4] = P.coord(vm, P.tgt(vm), P.Y_PIC_OFFSET);
    s.callback = P.startLinear;
    P.storeCb(s, P.destroy);
  };

  // Lua: g4_cb_a.lua:93 -- pokefirered/src/battle_anim_bug.c:250
  CB.TranslateWebThread = function (s: S): void {
    const vm = s._vm;
    const a = args(s);
    P.initPosToAttacker(vm, s, true);
    s.data[0] = a[2];
    s.data[1] = s.x;
    s.data[3] = s.y;
    if (a[4] === 0) {
      s.data[2] = P.coord(vm, P.tgt(vm), P.X_2);
      s.data[4] = P.coord(vm, P.tgt(vm), P.Y_PIC_OFFSET);
    } else {
      const [x, y] = P.averagePositions(vm, P.tgt(vm), true);
      s.data[2] = x; s.data[4] = y;
    }
    P.initLinearWithSpeed(s);
    s.data[5] = a[3];
    s.callback = webThreadStep;
  };
  // Lua: g4_cb_a.lua:110
  const webThreadStep: Cb = function (s) {
    if (P.translateLinear(s)) {
      P.destroy(s);
      return;
    }
    s.ox = s.ox + P.Sin(s.data[6], s.data[5]);
    s.data[6] = (s.data[6] + 13) & 0xFF;
  };

  // Lua: g4_cb_a.lua:121 -- pokefirered/src/battle_anim_bug.c:283
  CB.StringWrap = function (s: S): void {
    const vm = s._vm;
    const a = args(s);
    [s.x, s.y] = P.averagePositions(vm, P.tgt(vm), false);
    if (isOpp(P.atk(vm))) s.x = s.x - a[0]; else s.x = s.x + a[0];
    s.y = s.y + a[1];
    if (P.tgt(vm) === "player") s.y = s.y + 8;
    s.callback = stringWrapStep;
  };
  // Lua: g4_cb_a.lua:130
  const stringWrapStep: Cb = function (s) {
    s.data[0] = s.data[0] + 1;
    if (s.data[0] === 3) {
      s.data[0] = 0;
      P.setInvisible(s, !P.isInvisible(s));
    }
    s.data[1] = s.data[1] + 1;
    if (s.data[1] === 51) P.destroy(s);
  };

  // Lua: g4_cb_a.lua:142 -- pokefirered/src/battle_anim_bug.c:309
  CB.SpiderWeb = function (s: S): void {
    s._vm.bldAlpha = { eva: 16, evb: 0 };
    s.data[0] = 16;
    s.callback = spiderWebStep;
  };
  // Lua: g4_cb_a.lua:147
  const spiderWebStep: Cb = function (s) {
    if (s.data[2] < 20) {
      s.data[2] = s.data[2] + 1;
    } else {
      const v = s.data[1];
      s.data[1] = v + 1;
      if ((v & 1) !== 0) {
        s.data[0] = s.data[0] - 1;
        s._vm.bldAlpha = { eva: s.data[0], evb: 16 - s.data[0] };
        if (s.data[0] === 0) {
          P.setInvisible(s, true);
          s.callback = spiderWebEnd;
        }
      }
    }
  };
  // Lua: g4_cb_a.lua:163
  const spiderWebEnd: Cb = function (s) {
    s._vm.bldAlpha = null;
    P.destroy(s);
  };

  // Lua: g4_cb_a.lua:169 -- pokefirered/src/battle_anim_bug.c:350
  CB.TranslateStinger = function (s: S): void {
    const vm = s._vm;
    const a = args(s);
    if (isOpp(P.atk(vm))) {
      a[2] = -a[2]; a[1] = -a[1]; a[3] = -a[3];
    }
    if (P.atk(vm) === P.tgt(vm)) {
      a[2] = -a[2]; a[0] = -a[0];
    }
    P.initPosToAttacker(vm, s, true);
    const lx = P.s16(P.coord(vm, P.tgt(vm), P.X_2) + a[2]);
    const ly = P.s16(P.coord(vm, P.tgt(vm), P.Y_PIC_OFFSET) + a[3]);
    const rot = P.u16(P.ArcTan2Neg(lx - s.x, ly - s.y) + 0xC000);
    P.trySetRotScale(s, 0x100, 0x100, rot);
    s.data[0] = a[4];
    s.data[2] = lx;
    s.data[4] = ly;
    s.callback = P.startLinear;
    P.storeCb(s, P.destroy);
  };

  // Lua: g4_cb_a.lua:192 -- pokefirered/src/battle_anim_bug.c:399
  CB.MissileArc = function (s: S): void {
    const vm = s._vm;
    const a = args(s);
    P.initPosToAttacker(vm, s, true);
    if (isOpp(P.atk(vm))) a[2] = -a[2];
    s.data[0] = a[4];
    s.data[2] = P.coord(vm, P.tgt(vm), P.X_2) + a[2];
    s.data[4] = P.coord(vm, P.tgt(vm), P.Y_PIC_OFFSET) + a[3];
    s.data[5] = a[5];
    P.initArc(s);
    s.callback = missileArcStep;
    P.setInvisible(s, true);
  };
  // Lua: g4_cb_a.lua:205
  const missileArcStep: Cb = function (s) {
    P.setInvisible(s, false);
    if (P.translateHArc(s)) {
      P.destroy(s);
      return;
    }
    const temp: number[] = [];
    for (let i = 0; i <= 7; i++) temp[i] = s.data[i];
    const px = s.x + s.ox;
    const py = s.y + s.oy;
    if (!P.translateHArc(s)) {
      const rot = P.u16(P.ArcTan2Neg(s.x + s.ox - px, s.y + s.oy - py) + 0xC000);
      P.trySetRotScale(s, 0x100, 0x100, rot);
      for (let i = 0; i <= 7; i++) s.data[i] = temp[i];
    }
  };

  // Lua: g4_cb_a.lua:223 -- pokefirered/src/battle_anim_bug.c:448
  CB.TailGlowOrb = function (s: S): void {
    const vm = s._vm;
    const a = args(s);
    const side = (a[0] === P.ANIM_ATTACKER) ? P.atk(vm) : P.tgt(vm);
    s.x = P.coord(vm, side, P.X_2);
    s.y = P.coord(vm, side, P.Y_PIC_OFFSET) + 18;
    P.storeCb(s, P.destroy);
    s.callback = P.runStoredWhenAffineEnds;
  };

  // Lua: g4_cb_a.lua:235 -- pokefirered/src/battle_anim_electric.c:454
  CB.Lightning = function (s: S): void {
    const vm = s._vm;
    const a = args(s);
    if (isOpp(P.atk(vm))) s.x = s.x - a[0]; else s.x = s.x + a[0];
    s.y = s.y + a[1];
    s.callback = lightningStep;
  };
  // Lua: g4_cb_a.lua:242
  const lightningStep: Cb = function (s) {
    if (s.animEnded) P.destroy(s);
  };

  // Lua: g4_cb_a.lua:247 -- pokefirered/src/battle_anim_flying.c:533
  C.destroyAfterTimer = function (s: S): void {
    const v = s.data[0];
    s.data[0] = v - 1;
    if (v <= 0) P.destroy(s);
  };

  // Lua: g4_cb_a.lua:254 -- pokefirered/src/battle_anim_electric.c:507
  CB.SparkElectricity = function (s: S): void {
    const vm = s._vm;
    const a = args(s);
    let side: any;
    if (a[4] === P.ANIM_ATTACKER) side = P.atk(vm); else side = P.tgt(vm);
    if (a[5] === 0) {
      s.x = P.coord(vm, side, P.X);
      s.y = P.coord(vm, side, P.Y);
    } else {
      s.x = P.coord(vm, side, P.X_2);
      s.y = P.coord(vm, side, P.Y_PIC_OFFSET);
    }
    s.ox = P.asr(P.gSine(a[0]) * a[1], 8);
    s.oy = P.asr(P.gSine(a[0] + 64) * a[1], 8);
    if ((a[6] & 1) !== 0) P.setPriority(s, 3, s.subpriority);
    P.setMatrix(s, 0x100, 0x100, P.u16(-a[2] * 256));
    s.affineAnimPaused = true;
    s.data[0] = a[3];
    s.callback = C.destroyAfterTimer;
  };

  // Lua: g4_cb_a.lua:277 -- pokefirered/src/battle_anim_electric.c:558
  CB.ZapCannonSpark = function (s: S): void {
    const vm = s._vm;
    const a = args(s);
    P.initPosToAttacker(vm, s, true);
    s.data[0] = a[3];
    s.data[1] = s.x;
    s.data[2] = P.coord(vm, P.tgt(vm), P.X_2);
    s.data[3] = s.y;
    s.data[4] = P.coord(vm, P.tgt(vm), P.Y_PIC_OFFSET);
    P.initLinear(s);
    s.data[5] = a[2];
    s.data[6] = a[5];
    s.data[7] = a[4];
    P.addTile(s, a[6] * 4);
    s.callback = zapStep;
    s.callback(s);
  };
  // Lua: g4_cb_a.lua:294
  const zapStep: Cb = function (s) {
    if (!P.translateLinear(s)) {
      s.ox = s.ox + P.Sin(s.data[7], s.data[5]);
      s.oy = s.oy + P.Cos(s.data[7], s.data[5]);
      s.data[7] = (s.data[7] + s.data[6]) & 0xFF;
      if (s.data[7] % 3 === 0) P.setInvisible(s, !P.isInvisible(s));
    } else {
      P.destroy(s);
    }
  };

  // Lua: g4_cb_a.lua:307 -- pokefirered/src/battle_anim_electric.c:591
  CB.ThunderboltOrb = function (s: S): void {
    const vm = s._vm;
    const a = args(s);
    if (P.tgt(vm) === "player") a[1] = -a[1];
    s.x = P.coord(vm, P.tgt(vm), P.X_2) + a[1];
    s.y = P.coord(vm, P.tgt(vm), P.Y_PIC_OFFSET) + a[2];
    s.data[3] = a[0];
    s.data[4] = a[3];
    s.data[5] = a[3];
    s.callback = tboltStep;
  };
  // Lua: g4_cb_a.lua:318
  const tboltStep: Cb = function (s) {
    s.data[5] = s.data[5] - 1;
    if (s.data[5] === -1) {
      P.setInvisible(s, !P.isInvisible(s));
      s.data[5] = s.data[4];
    }
    const v = s.data[3];
    s.data[3] = v - 1;
    if (v <= 0) P.destroy(s);
  };

  // Lua: g4_cb_a.lua:331 -- pokefirered/src/battle_anim_electric.c:614
  CB.SparkElectricityFlashing = function (s: S): void {
    const vm = s._vm;
    const a = args(s);
    s.data[0] = a[3];
    const side = ((P.u16(a[7]) & 0x8000) !== 0) ? P.tgt(vm) : P.atk(vm);
    if (side === "player") a[0] = -a[0];
    s.x = P.coord(vm, side, P.X_2) + a[0];
    s.y = P.coord(vm, side, P.Y_PIC_OFFSET) + a[1];
    s.data[4] = P.u16(a[7]) & 0x7FFF;
    s.data[5] = a[2];
    s.data[6] = a[5];
    s.data[7] = a[4];
    P.addTile(s, a[6] * 4);
    s.callback = flashingStep;
    s.callback(s);
  };
  // Lua: g4_cb_a.lua:347
  const flashingStep: Cb = function (s) {
    s.ox = P.Sin(s.data[7], s.data[5]);
    s.oy = P.Cos(s.data[7], s.data[5]);
    s.data[7] = (s.data[7] + s.data[6]) & 0xFF;
    if (s.data[4] !== 0 && s.data[7] % s.data[4] === 0) P.setInvisible(s, !P.isInvisible(s));
    const v = s.data[0];
    s.data[0] = v - 1;
    if (v <= 0) P.destroy(s);
  };

  // Lua: g4_cb_a.lua:358 -- pokefirered/src/battle_anim_electric.c:648
  CB.Electricity = function (s: S): void {
    const vm = s._vm;
    const a = args(s);
    P.initPosToTarget(vm, s, false);
    P.addTile(s, a[3] * 4);
    if (a[3] === 1) P.setHFlip(s, true); else if (a[3] === 2) P.setVFlip(s, true);
    s.data[0] = a[2];
    s.callback = P.waitAnimForDuration;
    P.storeCb(s, P.destroy);
  };

  // Lua: g4_cb_a.lua:371 -- pokefirered/src/battle_anim_electric.c:753
  CB.ThunderWave = function (s: S): void {
    const vm = s._vm;
    const a = args(s);
    s.x = s.x + a[0];
    s.y = s.y + a[1];
    const s2 = P.createSprite(vm, s.tag ?? "SPARK_H", T.gThunderWaveSpriteTemplate, s.x + 32, s.y, s.subpriority, thunderWaveStep, s._baseW, s._baseH);
    if (s2) {
      P.addTile(s2, 8);
      s2._g4counted = true;
    }
    s.callback = thunderWaveStep;
  };
  // Lua: g4_cb_a.lua:383
  const thunderWaveStep: Cb = function (s) {
    s.data[0] = s.data[0] + 1;
    if (s.data[0] === 3) {
      s.data[0] = 0;
      P.setInvisible(s, !P.isInvisible(s));
    }
    s.data[1] = s.data[1] + 1;
    if (s.data[1] === 51) P.destroy(s);
  };

  // Lua: g4_cb_a.lua:394 -- pokefirered/src/battle_anim_electric.c:864
  function orb_on(s: S): void {
    const vm = s._vm;
    const side = (args(s)[0] === P.ANIM_ATTACKER) ? P.atk(vm) : P.tgt(vm);
    s.x = P.coord(vm, side, P.X_2);
    s.y = P.coord(vm, side, P.Y_PIC_OFFSET);
  }
  // Lua: g4_cb_a.lua:400
  CB.GrowingChargeOrb = function (s: S): void {
    orb_on(s);
    P.storeCb(s, P.destroy);
    s.callback = P.runStoredWhenAffineEnds;
  };

  // Lua: g4_cb_a.lua:407 -- pokefirered/src/battle_anim_electric.c:881
  CB.ElectricPuff = function (s: S): void {
    orb_on(s);
    const a = args(s);
    s.ox = a[1];
    s.oy = a[2];
    P.storeCb(s, P.destroy);
    s.callback = P.runStoredWhenAnimEnds;
  };

  // Lua: g4_cb_a.lua:418 -- pokefirered/src/battle_anim_electric.c:900
  CB.VoltTackleOrbSlide = function (s: S): void {
    const vm = s._vm;
    P.startAffineAnim(s, 1);
    s.x = P.coord(vm, P.atk(vm), P.X_2);
    s.y = P.coord(vm, P.atk(vm), P.Y_PIC_OFFSET);
    s._mon = P.present(P.atk(vm));
    s.data[7] = 16;
    if (P.atk(vm) === "enemy") s.data[7] = -16;
    s.callback = orbSlideStep;
  };
  // Lua: g4_cb_a.lua:428
  const orbSlideStep: Cb = function (s) {
    if (s.data[0] === 0) {
      s.data[1] = s.data[1] + 1;
      if (s.data[1] > 40) s.data[0] = s.data[0] + 1;
    } else if (s.data[0] === 1) {
      s.x = s.x + s.data[7];
      if (s._mon) s._mon.ox = (s._mon.ox ?? 0) + s.data[7];
      if (P.u16(s.x + 80) > 400) P.destroy(s);
    }
  };

  // Lua: g4_cb_a.lua:440 -- pokefirered/src/battle_anim_electric.c:1090
  CB.GrowingShockWaveOrb = function (s: S): void {
    const vm = s._vm;
    if (s.data[0] === 0) {
      s.x = P.coord(vm, P.atk(vm), P.X_2);
      s.y = P.coord(vm, P.atk(vm), P.Y_PIC_OFFSET);
      P.startAffineAnim(s, 2);
      s.data[0] = s.data[0] + 1;
    } else if (s.affineAnimEnded) {
      P.destroy(s);
    }
  };

  // Lua: g4_cb_a.lua:454 -- pokefirered/src/battle_anim_ground.c:141
  CB.BonemerangProjectile = function (s: S): void {
    const vm = s._vm;
    s.x = P.coord(vm, P.atk(vm), P.X_2);
    s.y = P.coord(vm, P.atk(vm), P.Y_PIC_OFFSET);
    s.data[0] = 20;
    s.data[2] = P.coord(vm, P.tgt(vm), P.X_2);
    s.data[4] = P.coord(vm, P.tgt(vm), P.Y_PIC_OFFSET);
    s.data[5] = -40;
    P.initArc(s);
    s.callback = bonemerangStep;
  };
  // Lua: g4_cb_a.lua:465
  const bonemerangStep: Cb = function (s) {
    if (P.translateHArc(s)) {
      const vm = s._vm;
      s.x = s.x + s.ox;
      s.y = s.y + s.oy;
      s.oy = 0; s.ox = 0;
      s.data[0] = 20;
      s.data[2] = P.coord(vm, P.atk(vm), P.X_2);
      s.data[4] = P.coord(vm, P.atk(vm), P.Y_PIC_OFFSET);
      s.data[5] = 40;
      P.initArc(s);
      s.callback = bonemerangEnd;
    }
  };
  // Lua: g4_cb_a.lua:479
  const bonemerangEnd: Cb = function (s) {
    if (P.translateHArc(s)) P.destroy(s);
  };

  // Lua: g4_cb_a.lua:484 -- pokefirered/src/battle_anim_ground.c:183
  CB.BoneHitProjectile = function (s: S): void {
    const vm = s._vm;
    const a = args(s);
    P.initPosToTarget(vm, s, true);
    if (isOpp(P.atk(vm))) a[2] = -a[2];
    s.data[0] = a[4];
    s.data[2] = P.coord(vm, P.tgt(vm), P.X_2) + a[2];
    s.data[4] = P.coord(vm, P.tgt(vm), P.Y_PIC_OFFSET) + a[3];
    s.callback = P.startLinear;
    P.storeCb(s, P.destroy);
  };

  // Lua: g4_cb_a.lua:497 -- pokefirered/src/battle_anim_ground.c:201
  CB.DirtScatter = function (s: S): void {
    const vm = s._vm;
    const a = args(s);
    P.initPosToAttacker(vm, s, true);
    const tx = P.coord(vm, P.tgt(vm), P.X_2);
    const ty = P.coord(vm, P.tgt(vm), P.Y_PIC_OFFSET);
    let xo = P.Random() & 0x1F;
    let yo = P.Random() & 0x1F;
    if (xo > 16) xo = 16 - xo;
    if (yo > 16) yo = 16 - yo;
    s.data[0] = a[2];
    s.data[2] = tx + xo;
    s.data[4] = ty + yo;
    s.callback = P.startLinear;
    P.storeCb(s, P.destroy);
  };

  // Lua: g4_cb_a.lua:516 -- pokefirered/src/battle_anim_ground.c:227
  CB.MudSportDirt = function (s: S): void {
    const vm = s._vm;
    const a = args(s);
    P.addTile(s, 1);
    if (a[0] === 0) {
      s.x = P.coord(vm, P.atk(vm), P.X_2) + a[1];
      s.y = P.coord(vm, P.atk(vm), P.Y_PIC_OFFSET) + a[2];
      s.data[0] = a[1] > 0 ? 1 : -1;
      s.callback = mudRising;
    } else {
      s.x = a[1];
      s.y = a[2];
      s.oy = -a[2];
      s.callback = mudFalling;
    }
  };
  // Lua: g4_cb_a.lua:532
  const mudRising: Cb = function (s) {
    s.data[1] = s.data[1] + 1;
    if (s.data[1] > 1) {
      s.data[1] = 0;
      s.x = s.x + s.data[0];
    }
    s.y = s.y - 4;
    if (s.y < -4) P.destroy(s);
  };
  // Lua: g4_cb_a.lua:541
  const mudFalling: Cb = function (s) {
    if (s.data[0] === 0) {
      s.oy = s.oy + 4;
      if (s.oy >= 0) {
        s.oy = 0;
        s.data[0] = s.data[0] + 1;
      }
    } else if (s.data[0] === 1) {
      s.data[1] = s.data[1] + 1;
      if (s.data[1] > 0) {
        s.data[1] = 0;
        P.setInvisible(s, !P.isInvisible(s));
        s.data[2] = s.data[2] + 1;
        if (s.data[2] === 10) P.destroy(s);
      }
    }
  };

  // Lua: g4_cb_a.lua:561 -- pokefirered/src/battle_anim_ground.c:488
  CB.DirtPlumeParticle = function (s: S): void {
    const vm = s._vm;
    const a = args(s);
    const side = (a[0] === 0) ? P.atk(vm) : P.tgt(vm);
    let xo = 24;
    if (a[1] === 1) {
      xo = -24;
      a[2] = -a[2];
    }
    s.x = P.coord(vm, side, P.X_2) + xo;
    s.y = P.yWithElevation(vm, side) + 30;
    s.data[0] = a[5];
    s.data[2] = s.x + a[2];
    s.data[4] = s.y + a[3];
    s.data[5] = a[4];
    P.initArc(s);
    s.callback = plumeStep;
  };
  // Lua: g4_cb_a.lua:579
  const plumeStep: Cb = function (s) {
    if (P.translateHArc(s)) P.destroy(s);
  };

  // Lua: g4_cb_a.lua:584 -- pokefirered/src/battle_anim_ground.c:525
  CB.DigDirtMound = function (s: S): void {
    const vm = s._vm;
    const a = args(s);
    const side = (a[0] === 0) ? P.atk(vm) : P.tgt(vm);
    s.x = P.coord(vm, side, P.X) - 16 + a[1] * 32;
    s.y = P.yWithElevation(vm, side) + 32;
    P.addTile(s, a[1] * 8);
    P.storeCb(s, P.destroy);
    s.data[0] = a[2];
    s.callback = P.waitAnimForDuration;
  };

  // Lua: g4_cb_a.lua:598 -- pokefirered/src/battle_anim_poison.c:187
  CB.SludgeProjectile = function (s: S): void {
    const vm = s._vm;
    const a = args(s);
    if (a[3] === 0) P.startAnim(s, 2);
    P.initPosToAttacker(vm, s, true);
    s.data[0] = a[2];
    s.data[2] = P.coord(vm, P.tgt(vm), P.X_2);
    s.data[4] = P.coord(vm, P.tgt(vm), P.Y_PIC_OFFSET);
    s.data[5] = -30;
    P.initArc(s);
    s.callback = sludgeStep;
  };
  // Lua: g4_cb_a.lua:610
  const sludgeStep: Cb = function (s) {
    if (P.translateHArc(s)) P.destroy(s);
  };

  // Lua: g4_cb_a.lua:615 -- pokefirered/src/battle_anim_poison.c:206
  CB.AcidPoisonBubble = function (s: S): void {
    const vm = s._vm;
    const a = args(s);
    if (a[3] === 0) P.startAnim(s, 2);
    P.initPosToAttacker(vm, s, true);
    const [l1, l2] = P.averagePositions(vm, P.tgt(vm), true);
    if (P.atk(vm) !== "player") a[4] = -a[4];
    s.data[0] = a[2];
    s.data[2] = l1 + a[4];
    s.data[4] = l2 + a[5];
    s.data[5] = -30;
    P.initArc(s);
    s.callback = sludgeStep;
  };

  // Lua: g4_cb_a.lua:631 -- pokefirered/src/battle_anim_mons.c:977
  C.initSpriteDataForLinearTranslation = function (s: S): void {
    const d = s.data;
    const x = P.s16(P.lshift(d[2] - d[1], 8));
    const y = P.s16(P.lshift(d[4] - d[3], 8));
    d[1] = P.s16(P.cdiv(x, d[0]));
    d[2] = P.s16(P.cdiv(y, d[0]));
    d[4] = 0;
    d[3] = 0;
  };

  // Lua: g4_cb_a.lua:643 -- pokefirered/src/battle_anim_poison.c:230
  CB.SludgeBombHitParticle = function (s: S): void {
    const a = args(s);
    s.data[0] = a[2];
    s.data[1] = s.x;
    s.data[2] = s.x + a[0];
    s.data[3] = s.y;
    s.data[4] = s.y + a[1];
    C.initSpriteDataForLinearTranslation(s);
    s.data[5] = P.s16(P.cdiv(s.data[1], a[2]));
    s.data[6] = P.s16(P.cdiv(s.data[2], a[2]));
    s.callback = sludgeHitStep;
  };
  // Lua: g4_cb_a.lua:655
  const sludgeHitStep: Cb = function (s) {
    P.translateSpriteLinearFixedPoint(s);
    if (!s.active) return;
    s.data[1] = P.s16(s.data[1] - s.data[5]);
    s.data[2] = P.s16(s.data[2] - s.data[6]);
    if (s.data[0] === 0) P.destroy(s);
  };

  // Lua: g4_cb_a.lua:664 -- pokefirered/src/battle_anim_poison.c:252
  CB.AcidPoisonDroplet = function (s: S): void {
    const vm = s._vm;
    const a = args(s);
    [s.x, s.y] = P.averagePositions(vm, P.tgt(vm), true);
    if (isOpp(P.atk(vm))) a[0] = -a[0];
    s.x = s.x + a[0];
    s.y = s.y + a[1];
    s.data[0] = a[4];
    s.data[2] = s.x + a[2];
    s.data[4] = s.y + s.data[0];
    s.callback = P.startLinear;
    P.storeCb(s, P.destroy);
  };

  // Lua: g4_cb_a.lua:680 -- pokefirered/src/battle_anim_poison.c:272
  CB.BubbleEffect = function (s: S): void {
    const vm = s._vm;
    const a = args(s);
    if (a[2] === 0) {
      P.initPosToTarget(vm, s, true);
    } else {
      [s.x, s.y] = P.averagePositions(vm, P.tgt(vm), true);
      if (isOpp(P.atk(vm))) a[0] = -a[0];
      s.x = s.x + a[0];
      s.y = s.y + a[1];
    }
    s.callback = bubbleStep;
  };
  // Lua: g4_cb_a.lua:693
  const bubbleStep: Cb = function (s) {
    s.data[0] = (s.data[0] + 0xB) & 0xFF;
    s.ox = P.Sin(s.data[0], 4);
    s.data[1] = s.data[1] + 0x30;
    s.oy = -P.asr(s.data[1], 8);
    if (s.affineAnimEnded) P.destroy(s);
  };

  return CB;
}
