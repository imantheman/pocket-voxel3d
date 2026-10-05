// Port of gen1recomp src/core/game3/battle/anim_port/g2_effects2b.lua (GPLv3 + additional terms; see LICENSE.md).
// pokefirered battle_anim_effects_2.c (second part) on the g2_pret kit.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { mod, truthy } from "../../../../../import/gen3/lua.ts";
import { seq } from "../../../platform/lt.ts";
import { G } from "../../../platform/graphics.ts";
import { AnimPal } from "../anim_pal.ts";
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

// Lua: g2_effects2b.lua:6 -- local band = bit.band
const band = (a: number, b: number): number => a & b;

// Lua: g2_effects2b.lua:8
function sketch_step(t: T): void {
  const d = t.data;
  if (d[4] === 0) {
    d[5] = d[5] + 1;
    if (d[5] > 20) d[4] = d[4] + 1;
  } else if (d[4] === 1) {
    d[1] = d[1] + 1;
    if (d[1] > 3) {
      d[1] = 0;
      d[2] = band(d[3], 3);
      d[5] = d[0] - d[3];
      if (d[2] === 1) {
        d[5] = d[5] - 2;
      } else if (d[2] === 2 || d[2] === 3) {
        d[5] = d[5] + 1;
      }
      if (d[5] >= 0) t.g2.shift[d[5]] = 0;
      d[3] = d[3] + 1;
      if (d[3] >= d[15]) {
        const p = t.g2.p;
        if (p && p.hShift === t.g2.shift) p.hShift = null;
        P.destroyTask(t);
      }
    }
  }
}

// Lua: g2_effects2b.lua:36 -- pokefirered/src/battle_anim_effects_2.c:2399
TASKS.SketchDrawMon = task(function (t: T): void {
  const tg = P.tgt();
  const d = t.data;
  d[0] = P.yWithElevation(tg) + 32;
  d[1] = 4;
  d[2] = 0;
  d[3] = 0;
  d[4] = 0;
  d[5] = 0;
  d[15] = P.coordAttr(tg, P.ATTR_HEIGHT);
  d[6] = 0;
  const shift: number[] = [];
  for (let i = d[0] - 0x40; i <= d[0]; i++) {
    if (i >= 0) shift[i] = -0xF0;
  }
  t.g2.shift = shift;
  const p = P.present(tg);
  t.g2.p = p;
  if (p) p.hShift = shift;
  t.func = sketch_step;
});

// Lua: g2_effects2b.lua:58
function pencil_step(s: S): void {
  const d = s.data;
  if (d[0] === 0) {
    d[2] = d[2] + 1;
    if (d[2] > 1) {
      d[2] = 0;
      s.invisible = !truthy(s.invisible);
    }
    d[1] = d[1] + 1;
    if (d[1] > 16) {
      s.invisible = false;
      d[0] = d[0] + 1;
    }
  } else if (d[0] === 1) {
    d[1] = d[1] + 1;
    if (d[1] > 3 && d[2] < d[5]) {
      d[1] = 0;
      s.y = s.y - 1;
      d[2] = d[2] + 1;
      if (mod(d[2], 10) === 0) P.playSE("SE_M_SKETCH", d[6]);
    }
    d[4] = d[4] + d[3];
    if (d[4] > 31) {
      d[4] = 0x40 - d[4];
      d[3] = -d[3];
    } else if (d[4] <= -32) {
      d[4] = -0x40 - d[4];
      d[3] = -d[3];
    }
    s.x2 = d[4];
    if (d[5] === d[2]) {
      d[1] = 0;
      d[2] = 0;
      d[0] = d[0] + 1;
    }
  } else if (d[0] === 2) {
    d[2] = d[2] + 1;
    if (d[2] > 1) {
      d[2] = 0;
      s.invisible = !truthy(s.invisible);
    }
    d[1] = d[1] + 1;
    if (d[1] > 16) {
      s.invisible = false;
      P.destroy(s);
    }
  }
}

// Lua: g2_effects2b.lua:108 -- pokefirered/src/battle_anim_effects_2.c:2487
CB.Pencil = function (s: S): void {
  const tg = P.tgt();
  s.x = P.coord(tg, 0) - 16;
  s.y = P.yWithElevation(tg) + 16;
  s.data[0] = 0;
  s.data[1] = 0;
  s.data[2] = 0;
  s.data[3] = 16;
  s.data[4] = 0;
  s.data[5] = P.coordAttr(tg, P.ATTR_HEIGHT) + 2;
  // vm and vm.adjustPanning and vm:adjustPanning(63) or 63
  const vm = P.vm;
  const r = (vm && vm.adjustPanning) ? vm.adjustPanning(63) : null;
  s.data[6] = (r != null && r !== false) ? r : 63;
  s.pcb = pencil_step;
};

// Lua: g2_effects2b.lua:124 -- pokefirered/src/battle_anim_effects_2.c:2560
CB.BlendThinRing = function (s: S): void {
  s.pcb = P.AnimSpriteOnMonPos;
  s.pcb(s);
};

// Lua: g2_effects2b.lua:129
function hyper_voice_wait_end(s: S): void {
  if (P.AnimTranslateLinear(s)) P.destroy(s);
}

// Lua: g2_effects2b.lua:134 -- pokefirered/src/battle_anim_effects_2.c:2600
CB.HyperVoiceRing = function (s: S): void {
  let b1: any, b2: any;
  if (P.arg(5) === 0) {
    b1 = P.atk(); b2 = P.tgt();
  } else {
    b1 = P.tgt(); b2 = P.atk();
  }
  let xt = 0, yt = 1;
  if (P.arg(6) !== 0) { xt = 2; yt = 3; }
  let startX: number;
  if (b1 !== "player") {
    startX = P.u16(P.coord(b1, xt) + P.arg(0));
    s.subpriority = P.subpriorityOf(b2) - 1;
  } else {
    startX = P.u16(P.coord(b1, xt) - P.arg(0));
    s.subpriority = P.subpriorityOf(b1) - 1;
  }
  const startY = P.u16(P.coord(b1, yt) + P.arg(1));
  let x = P.coord(b2, xt);
  let y = P.coord(b2, yt);
  if (b2 !== "player") x = x + P.arg(3); else x = x - P.arg(3);
  y = y + P.arg(4);
  s.x = P.s16(startX);
  s.data[1] = P.s16(startX);
  s.y = P.s16(startY);
  s.data[3] = P.s16(startY);
  s.data[2] = P.s16(x);
  s.data[4] = P.s16(y);
  s.data[0] = P.arg(0);
  P.InitAnimLinearTranslation(s);
  s.pcb = hyper_voice_wait_end;
  s.pcb(s);
};

// Lua: g2_effects2b.lua:169 -- pokefirered/src/battle_anim_effects_2.c:2685
CB.UproarRing = function (s: S): void {
  P.palBlend("tag:THIN_RING", P.arg(5), P.u16(P.arg(4)));
  P.startAffineAnim(s, 1);
  s.pcb = P.AnimSpriteOnMonPos;
  s.pcb(s);
};

// Lua: g2_effects2b.lua:176
function set_bld_alpha(eva: number, evb: number): void {
  const vm = P.vm;
  if (vm) vm.bldAlpha = { eva, evb };
}

// Lua: g2_effects2b.lua:181
function egg_step4_cb(s: S): void {
  const vm = P.vm;
  if (vm) vm.bldAlpha = null;
  P.destroy(s);
}

// Lua: g2_effects2b.lua:187
function egg_step4(s: S): void {
  if (P.u16(P.arg(7)) === 0xFFFF) {
    s.invisible = true;
    if (s.data[7] === 0) {
      s.pcb = egg_step4_cb;
    } else {
      s.pcb = P.DestroyAnimSprite;
    }
  }
}

// Lua: g2_effects2b.lua:198
function egg_step3_cb2(s: S): void {
  const v = s.data[1];
  s.data[1] = v + 1;
  if (mod(v, 3) === 0) {
    s.data[0] = s.data[0] - 1;
    set_bld_alpha(s.data[0], 16 - s.data[0]);
    if (s.data[0] === 0) s.pcb = egg_step4;
  }
}

// Lua: g2_effects2b.lua:208
function egg_step3_cb1(s: S): void {
  s.y2 = s.y2 - 2;
  s.data[0] = s.data[0] + 1;
  if (s.data[0] === 9) {
    s.data[0] = 16;
    s.data[1] = 0;
    set_bld_alpha(s.data[0], 0);
    s.pcb = egg_step3_cb2;
  }
}

// Lua: g2_effects2b.lua:219
function egg_step3(s: S): void {
  if (s.affineAnimEnded) {
    P.startAffineAnim(s, 1);
    s.data[0] = 0;
    if (s.data[7] === 0) {
      s.tileBase = s.tileBase + 16;
      s.pcb = egg_step3_cb1;
    } else {
      s.tileBase = s.tileBase + 32;
      s.pcb = egg_step4;
    }
  }
}

// Lua: g2_effects2b.lua:233
function egg_step2(s: S): void {
  const v = s.data[0];
  s.data[0] = v + 1;
  if (v > 19) {
    P.startAffineAnim(s, 2);
    s.pcb = egg_step3;
  }
}

// Lua: g2_effects2b.lua:242
function egg_step1(s: S): void {
  s.y2 = s.y2 - P.asr(s.data[0], 8);
  s.x2 = P.asr(s.data[1], 8);
  s.data[0] = s.data[0] - 32;
  const add = (P.atk() !== "player") ? -160 : 160;
  s.data[1] = P.s16(s.data[1] + add);
  if (s.y2 > 0) {
    s.y = s.y + s.y2;
    s.x = s.x + s.x2;
    s.y2 = 0;
    s.x2 = 0;
    s.data[0] = 0;
    P.startAffineAnim(s, 1);
    s.pcb = egg_step2;
  }
}

// Lua: g2_effects2b.lua:260 -- pokefirered/src/battle_anim_effects_2.c:2697
CB.SoftBoiledEgg = function (s: S): void {
  P.InitSpritePosToAnimAttacker(s, false);
  const r1 = (P.atk() !== "player") ? -160 : 160;
  s.data[0] = 0x380;
  s.data[1] = r1;
  s.data[7] = P.arg(2);
  s.pcb = egg_step1;
};

// Lua: g2_effects2b.lua:269
function stretch_disappear_step(t: T): void {
  if (!P.RunAffineAnimFromTaskData(t)) {
    const m = t.g2.affMon;
    m.y2 = 0;
    m.invisible = true;
    P.destroyTask(t);
  }
}

// Lua: g2_effects2b.lua:279 -- pokefirered/src/battle_anim_effects_2.c:2802
TASKS.AttackerStretchAndDisappear = task(function (t: T): void {
  const m = P.mon(P.atk());
  if (!m) { P.destroyTask(t); return; }
  P.PrepareAffineAnimInTaskData(t, m, P.affineCmds("sStretchAttackerAffineAnimCmds"));
  t.func = stretch_disappear_step;
});

// Lua: g2_effects2b.lua:286
function es_impact_step(t: T): void {
  const d = t.data;
  const m = t.g2.mon;
  if (d[0] === 0) {
    m.x2 = m.x2 + d[14];
    d[1] = 0;
    d[2] = 0;
    d[3] = 0;
    d[0] = d[0] + 1;
  } else if (d[0] === 1) {
    d[1] = d[1] + 1;
    if (d[1] > 1) {
      d[1] = 0;
      d[2] = d[2] + 1;
      if (band(d[2], 1) !== 0) m.x2 = m.x2 + 6; else m.x2 = m.x2 - 6;
      d[3] = d[3] + 1;
      if (d[3] > 4) {
        if (band(d[2], 1) !== 0) m.x2 = m.x2 - 6;
        d[0] = d[0] + 1;
      }
    }
  } else if (d[0] === 2) {
    d[12] = d[12] - 1;
    if (d[12] !== 0) d[0] = 0; else d[0] = d[0] + 1;
  } else if (d[0] === 3) {
    m.x2 = m.x2 + d[13];
    if (m.x2 === 0) P.destroyTask(t);
  }
}

// Lua: g2_effects2b.lua:317 -- pokefirered/src/battle_anim_effects_2.c:2824
TASKS.ExtremeSpeedImpact = task(function (t: T): void {
  const d = t.data;
  d[12] = 3;
  if (P.tgt() === "player") {
    d[13] = -1;
    d[14] = 8;
  } else {
    d[13] = 1;
    d[14] = -8;
  }
  const m = P.mon(P.tgt());
  if (!m) { P.destroyTask(t); return; }
  t.g2.mon = m;
  t.func = es_impact_step;
});

// Lua: g2_effects2b.lua:333
function es_reappear_step(t: T): void {
  const d = t.data;
  const m = t.g2.mon;
  if (d[0] === 0) {
    d[1] = d[1] + 1;
    if (d[1] > d[4]) {
      d[1] = 0;
      d[2] = d[2] + 1;
      m.invisible = band(d[2], 1) === 0;
      d[3] = d[3] + 1;
      if (d[3] >= d[13]) {
        d[4] = d[4] + 1;
        if (d[4] < d[14]) {
          d[1] = 0;
          d[2] = 0;
          d[3] = 0;
        } else {
          m.invisible = false;
          P.destroyTask(t);
        }
      }
    }
  }
}

// Lua: g2_effects2b.lua:359 -- pokefirered/src/battle_anim_effects_2.c:2894
TASKS.ExtremeSpeedMonReappear = task(function (t: T): void {
  const m = P.mon(P.atk());
  if (!m) { P.destroyTask(t); return; }
  t.g2.mon = m;
  t.data[4] = 1;
  t.data[13] = 14;
  t.data[14] = 2;
  t.func = es_reappear_step;
});

// Lua: g2_effects2b.lua:369 -- { [0] = { 30, 28 }, { -20, 24 }, { 16, 26 }, { -10, 28 } }
const SPEED_DUST_POS = [seq(30, 28), seq(-20, 24), seq(16, 26), seq(-10, 28)];

// Lua: g2_effects2b.lua:371
function speed_dust_step(t: T): void {
  const d = t.data;
  if (d[8] === 0) {
    d[4] = d[4] + 1;
    if (d[4] > 1) {
      d[4] = 0;
      d[5] = band(d[5] + 1, 1);
      d[6] = d[6] + 1;
      if (d[6] > 20) {
        if (d[7] === 0) {
          d[6] = 0;
          d[8] = 1;
        } else {
          d[8] = 2;
        }
      }
    }
  } else if (d[8] === 1) {
    d[5] = 0;
    d[4] = d[4] + 1;
    if (d[4] > 20) {
      d[7] = 1;
      d[8] = 0;
    }
  } else if (d[8] === 2) {
    d[5] = 1;
  }
  if (d[0] === 0) {
    d[1] = d[1] + 1;
    if (d[1] > 4) {
      d[1] = 0;
      const s = P.createSprite("gSpeedDustSpriteTemplate", d[14], d[15], 0);
      if (s) {
        s.g2.task = t;
        s.data[1] = 13;
        s.x2 = SPEED_DUST_POS[d[2]]![1];
        s.y2 = SPEED_DUST_POS[d[2]]![2];
        d[13] = d[13] + 1;
        d[2] = d[2] + 1;
        if (d[2] > 3) {
          d[2] = 0;
          d[3] = d[3] + 1;
          if (d[3] > 5) d[0] = d[0] + 1;
        }
      }
    }
  } else if (d[0] === 1) {
    if (d[13] === 0) P.destroyTask(t);
  }
}

// Lua: g2_effects2b.lua:423 -- pokefirered/src/battle_anim_effects_2.c:3024
CB.SpeedDust = function (s: S): void {
  const t = s.g2.task;
  s.invisible = (t && t.data && t.data[5] !== 0) ? true : false;
  if (s.animEnded) {
    if (t && t.data) t.data[s.data[1]] = t.data[s.data[1]] - 1;
    P.destroy(s);
  }
};

// Lua: g2_effects2b.lua:433 -- pokefirered/src/battle_anim_effects_2.c:2938
TASKS.SpeedDust = task(function (t: T): void {
  const d = t.data;
  d[1] = 4;
  d[14] = P.coord(P.atk(), 0);
  d[15] = P.coord(P.atk(), 1);
  t.func = speed_dust_step;
});

// Lua: g2_effects2b.lua:442 -- pokefirered/src/battle_anim_effects_2.c:3034
const MUSIC_NOTE_PAL_TAGS = ["MUSIC_NOTES_2", "MUSIC_NOTES_2_PAL1", "MUSIC_NOTES_2_PAL2"];

// Lua: g2_effects2b.lua:444
TASKS.LoadMusicNotesPals = task(function (t: T): void {
  // require("src.core.game3.battle.anim_pal"): a static import
  const pack = AnimPal._pack;
  const full = pack && pack.tagPals && pack.tagPals.MUSIC_NOTES_2;
  for (let i = 0; i <= 2; i++) {
    const tag = MUSIC_NOTE_PAL_TAGS[i];
    if (i > 0) AnimPal.alloc(tag);
    if (full) {
      const row: number[] = [];
      for (let c = 0; c <= 15; c++) row[c] = full[i * 16 + c + 1] ?? 0;
      AnimPal.load(tag, row, 0, 16);
    }
  }
  P.destroyTask(t);
});

// Lua: g2_effects2b.lua:461 -- pokefirered/src/battle_anim_effects_2.c:3052
TASKS.FreeMusicNotesPals = task(function (t: T): void {
  for (let i = 0; i <= 2; i++) AnimPal.free(MUSIC_NOTE_PAL_TAGS[i]);
  P.destroyTask(t);
});

// Lua: g2_effects2b.lua:468 -- pokefirered/src/battle_anim_effects_2.c:3062
function set_music_note_palette(s: S, a: number, b: number): void {
  const tile = (band(b, 1) !== 0) ? 32 : 0;
  s.tileBase = s.tileBase + tile + a * 4;
  s._palTag = MUSIC_NOTE_PAL_TAGS[Math.floor(b / 2)];
}

// Lua: g2_effects2b.lua:475 -- pokefirered/src/battle_anim_effects_2.c:3069
CB.HealBellMusicNote = function (s: S): void {
  P.InitSpritePosToAnimAttacker(s, false);
  if (P.atk() !== "player") P.setArg(2, -P.arg(2));
  s.data[0] = P.arg(4);
  s.data[2] = P.coord(P.atk(), 0) + P.arg(2);
  s.data[4] = P.coord(P.atk(), 1) + P.arg(3);
  s.pcb = P.StartAnimLinearTranslation;
  P.storeCallback(s, P.DestroyAnimSprite);
  set_music_note_palette(s, P.arg(5), P.arg(6));
};

// Lua: g2_effects2b.lua:486
function magenta_heart(s: S): void {
  s.data[0] = s.data[0] + 1;
  if (s.data[0] === 1) P.InitSpritePosToAnimAttacker(s, false);
  s.x2 = P.Sin(s.data[1], 8);
  s.y2 = P.asr(s.data[2], 8);
  s.data[1] = mod(s.data[1] + 7, 256);
  s.data[2] = P.s16(s.data[2] - 0x80);
  if (s.data[0] === 60) P.destroy(s);
}

// Lua: g2_effects2b.lua:497 -- pokefirered/src/battle_anim_effects_2.c:3083
CB.MagentaHeart = function (s: S): void {
  magenta_heart(s);
  s.pcb = magenta_heart;
};

// Lua: g2_effects2b.lua:502
function fake_out_draw(t: T): void {
  const g2 = t.g2;
  // (Brian's `or not (love and love.graphics)`: the platform always has graphics.)
  if (!g2) return;
  const l = g2.winL ?? 0, r = g2.winR ?? 240;
  G.setColor(0, 0, 0, 1);
  if (g2.full) {
    G.rectangle("fill", 0, 0, 240, 160);
  } else {
    if (l > 0) G.rectangle("fill", 0, 0, l, 160);
    if (r < 240) G.rectangle("fill", r, 0, 240 - r, 160);
  }
  G.setColor(1, 1, 1, 1);
}

// Lua: g2_effects2b.lua:516
function fake_out_step2(t: T): void {
  t.data[10] = t.data[10] + 1;
  if (t.data[10] === 5) {
    t.data[11] = 0x88;
    t.draw = null;
    P.palBlend("bg", 16, 0x7FFF);
  } else if (t.data[10] > 4) {
    t.draw = null;
    P.destroyTask(t);
  }
}

// Lua: g2_effects2b.lua:528
function fake_out_step1(t: T): void {
  t.data[0] = t.data[0] + 13;
  t.data[1] = t.data[1] - 13;
  if (t.data[0] >= t.data[1]) {
    t.g2.full = true;
    t.func = fake_out_step2;
  } else {
    t.g2.winL = t.data[0];
    t.g2.winR = t.data[1];
  }
}

// Lua: g2_effects2b.lua:541 -- pokefirered/src/battle_anim_effects_2.c:3096
TASKS.FakeOut = task(function (t: T): void {
  t.data[0] = 0;
  t.data[1] = P.DISPLAY_WIDTH;
  t.g2.winL = 0;
  t.g2.winR = P.DISPLAY_WIDTH;
  t.z = 1;
  t.draw = fake_out_draw;
  t.func = fake_out_step1;
});

// Lua: g2_effects2b.lua:551
function stretch_up(t: T, which: number): void {
  const m = t.g2.mon ?? P.monById(which);
  t.g2.mon = m;
  if (!m) { P.destroyTask(t); return; }
  t.data[0] = t.data[0] + 1;
  if (t.data[0] === 1) {
    P.PrepareAffineAnimInTaskData(t, m, P.affineCmds("sAffineAnims_StretchBattlerUp"));
    m.x2 = 4;
  } else {
    m.x2 = -m.x2;
    if (!P.RunAffineAnimFromTaskData(t)) {
      m.x2 = 0;
      m.y2 = 0;
      P.destroyTask(t);
    }
  }
}

// Lua: g2_effects2b.lua:570 -- pokefirered/src/battle_anim_effects_2.c:3149
TASKS.StretchTargetUp = task(function (t: T): void {
  t.func = function (tt: T): void { stretch_up(tt, P.ANIM_TARGET); };
  stretch_up(t, P.ANIM_TARGET);
});

// Lua: g2_effects2b.lua:576 -- pokefirered/src/battle_anim_effects_2.c:3170
TASKS.StretchAttackerUp = task(function (t: T): void {
  t.func = function (tt: T): void { stretch_up(tt, P.ANIM_ATTACKER); };
  stretch_up(t, P.ANIM_ATTACKER);
});

// Lua: g2_effects2b.lua:581
export const G2Effects2b = { cb: CB, tasks: TASKS };
export default G2Effects2b;
