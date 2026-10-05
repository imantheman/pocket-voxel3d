// The FireRed runtime port, battle-animation anim_port groups I, J, K:
// g3_e3b, g3_e3c, g5_tasks (I); g4_pret, g4_templates, g4_tasks, g4_tasks_a,
// g4_callbacks, g4_cb_a (J); g4_tasks_b, g4_cb_b (K).
//
// Oracle: gen1recomp's own anim.lua / anim_vm.lua under luajit on the FireRed
// cache (.cc_ban_oracle.lua with a BLOCK list), with the OTHER anim_port groups
// blocked (g1_*, g2_*, and g3_tasks' ghost / e3a / dark / psychic modules: their
// require fails, Brian's "not found" path), so only these groups drive moves:
//   BLOCK=g1_tasks,g1_callbacks,g2_tasks,g2_callbacks,g3_ghost,g3_e3a,g3_dark,g3_psychic \
//     luajit oracle.lua 1 2 ... 354      (all moves, in order, one VM)
// The port is set up the same way: G3Lazy holds only these groups, and g3_tasks /
// g3_callbacks are what Brian's g3_tasks.lua / g3_callbacks.lua build from e3b +
// e3c when the other g3 modules are missing. Moves run in the same order (the VM
// carries state from move to move, as the oracle's does).
// THUNDER WAVE is 83 frames without anim_port, 119 with these groups (= with all
// groups). FLASH (41 with all groups) is driven by other groups, not these.
import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DesktopHost } from "../voxelmon/game/gen3/platform/desktop.ts";
import { setHost } from "../voxelmon/game/gen3/platform/host.ts";
import { tostring } from "../voxelmon/import/gen3/lua.ts";

const ROOT = join(homedir(), "gen3ref/frfull");
const PRE = "src.core.game3.battle.anim_port.";
const THUNDER_WAVE = 86;

// Brian's [frames, maxSprites] for every move these groups change (frames
// differ from the oracle run with all anim_port blocked).
const ORACLE: Record<number, [number, number]> = {
  8: [173, 10], 28: [50, 30], 40: [111, 3], 45: [53, 3], 51: [137, 5], 53: [128, 8], 55: [95, 3], 56: [117, 24],
  57: [136, 0], 59: [373, 25], 61: [233, 15], 62: [210, 6], 69: [204, 5], 81: [223, 14], 84: [147, 5], 85: [235, 9],
  86: [119, 6], 88: [86, 5], 89: [198, 0], 91: [192, 6], 92: [222, 3], 106: [97, 0], 114: [195, 0], 123: [300, 7],
  124: [107, 3], 127: [160, 14], 131: [58, 3], 137: [160, 20], 141: [218, 6], 143: [122, 0], 145: [254, 6],
  151: [113, 0], 152: [100, 4], 157: [132, 13], 164: [68, 0], 169: [201, 14], 175: [107, 1], 181: [280, 14],
  188: [166, 17], 189: [48, 30], 192: [89, 9], 196: [273, 13], 201: [163, 4], 204: [69, 2], 205: [160, 7],
  209: [119, 8], 211: [175, 2], 220: [79, 2], 222: [118, 0], 230: [170, 13], 231: [135, 1], 232: [133, 2],
  246: [97, 10], 249: [46, 8], 250: [127, 12], 257: [163, 4], 258: [151, 8], 260: [211, 40], 263: [80, 4],
  265: [113, 2], 267: [97, 10], 268: [298, 17], 270: [65, 2], 272: [137, 1], 274: [58, 5], 278: [218, 1],
  281: [212, 3], 284: [345, 10], 286: [118, 1], 287: [166, 2], 294: [153, 1], 295: [272, 3], 296: [174, 1],
  298: [168, 2], 300: [177, 18], 303: [108, 3], 305: [101, 3], 312: [246, 6], 313: [59, 2], 316: [82, 2],
  321: [188, 2], 323: [188, 20], 329: [181, 0], 330: [136, 0], 334: [97, 0], 335: [140, 1], 336: [101, 3],
  342: [188, 3], 343: [88, 2], 344: [271, 17], 350: [55, 5], 351: [254, 21], 352: [150, 11],
};

// Sprite dumps: at frame DUMP_AT[move] of that move, every active particle as
// the oracle prints it (DUMPS=move:frame): tag x y ox oy w h alpha quadY.
const DUMP_AT: Record<number, number> = {
  56: 60, 59: 120, 86: 35, 145: 150, 205: 40, 260: 100, 263: 40, 274: 30, 316: 40, 61: 50, 92: 100,
};
const ORACLE_DUMPS: Record<number, string[]> = {
  [56]: [
    "WATER_ORB x=82 y=98 ox=6 oy=-9 w=16 h=16 a=1 qy=16",
    "WATER_ORB x=82 y=98 ox=6 oy=2 w=16 h=16 a=1 qy=16",
    "WATER_ORB x=82 y=98 ox=43 oy=-43 w=16 h=16 a=1 qy=16",
    "WATER_ORB x=82 y=98 ox=43 oy=-12 w=16 h=16 a=1 qy=16",
    "WATER_ORB x=82 y=98 ox=34 oy=-36 w=16 h=16 a=1 qy=32",
    "WATER_ORB x=82 y=98 ox=34 oy=-7 w=16 h=16 a=1 qy=32",
    "WATER_ORB x=82 y=98 ox=25 oy=-28 w=16 h=16 a=1 qy=48",
    "WATER_ORB x=82 y=98 ox=25 oy=-3 w=16 h=16 a=1 qy=48",
    "WATER_IMPACT x=179 y=55 ox=0 oy=0 w=28.6 h=28.6 a=1 qy=nil",
    "WATER_IMPACT x=179 y=25 ox=0 oy=0 w=28.6 h=28.6 a=1 qy=nil",
    "WATER_ORB x=82 y=98 ox=15 oy=-17 w=16 h=16 a=1 qy=0",
    "WATER_ORB x=82 y=98 ox=15 oy=-2 w=16 h=16 a=1 qy=0",
    "WATER_ORB x=82 y=98 ox=90 oy=-60 w=16 h=16 a=1 qy=0",
    "WATER_ORB x=82 y=98 ox=90 oy=-53 w=16 h=16 a=1 qy=0",
    "WATER_ORB x=82 y=98 ox=81 oy=-59 w=16 h=16 a=1 qy=16",
    "WATER_ORB x=82 y=98 ox=81 oy=-42 w=16 h=16 a=1 qy=16",
    "WATER_ORB x=82 y=98 ox=72 oy=-55 w=16 h=16 a=1 qy=32",
    "WATER_ORB x=82 y=98 ox=72 oy=-34 w=16 h=16 a=1 qy=32",
    "WATER_ORB x=82 y=98 ox=62 oy=-53 w=16 h=16 a=1 qy=48",
    "WATER_ORB x=82 y=98 ox=62 oy=-24 w=16 h=16 a=1 qy=48",
    "WATER_ORB x=82 y=98 ox=53 oy=-48 w=16 h=16 a=1 qy=0",
    "WATER_ORB x=82 y=98 ox=53 oy=-17 w=16 h=16 a=1 qy=0",
  ],
  [59]: [
    "ICE_CRYSTALS x=174 y=38 ox=14 oy=25 w=8 h=8 a=1 qy=56",
    "ICE_CRYSTALS x=-19 y=90 ox=54 oy=-14 w=8 h=8 a=1 qy=56",
    "ICE_CRYSTALS x=174 y=39 ox=7 oy=1 w=8 h=8 a=1 qy=56",
    "ICE_CRYSTALS x=-19 y=100 ox=31 oy=-10 w=8 h=8 a=1 qy=56",
    "ICE_CRYSTALS x=174 y=41 ox=-20 oy=15 w=8 h=8 a=1 qy=56",
    "ICE_CRYSTALS x=-19 y=83 ox=9 oy=-2 w=8 h=8 a=1 qy=56",
    "ICE_CRYSTALS x=174 y=38 ox=7 oy=28 w=8 h=8 a=1 qy=56",
    "ICE_CRYSTALS x=-21 y=110 ox=266 oy=-126 w=16 h=16 a=1 qy=32",
    "ICE_CRYSTALS x=174 y=39 ox=14 oy=4 w=8 h=8 a=1 qy=56",
    "ICE_CRYSTALS x=-21 y=145 ox=240 oy=-114 w=16 h=16 a=1 qy=32",
    "ICE_CRYSTALS x=-19 y=100 ox=189 oy=-60 w=8 h=8 a=1 qy=56",
    "ICE_CRYSTALS x=-21 y=110 ox=215 oy=-102 w=16 h=16 a=1 qy=32",
    "ICE_CRYSTALS x=-19 y=83 ox=166 oy=-39 w=8 h=8 a=1 qy=56",
    "ICE_CRYSTALS x=-21 y=150 ox=189 oy=-90 w=16 h=16 a=1 qy=32",
    "ICE_CRYSTALS x=-19 y=110 ox=144 oy=-54 w=8 h=8 a=1 qy=56",
    "ICE_CRYSTALS x=-21 y=130 ox=164 oy=-78 w=16 h=16 a=1 qy=32",
    "ICE_CRYSTALS x=-19 y=100 ox=121 oy=-38 w=8 h=8 a=1 qy=56",
    "ICE_CRYSTALS x=-21 y=120 ox=138 oy=-65 w=16 h=16 a=1 qy=32",
    "ICE_CRYSTALS x=-19 y=118 ox=99 oy=-39 w=8 h=8 a=1 qy=56",
    "ICE_CRYSTALS x=-21 y=140 ox=112 oy=-53 w=16 h=16 a=1 qy=32",
    "ICE_CRYSTALS x=-19 y=110 ox=76 oy=-28 w=8 h=8 a=1 qy=56",
    "ICE_CRYSTALS x=-21 y=110 ox=87 oy=-41 w=16 h=16 a=1 qy=32",
    "ICE_CRYSTALS x=-21 y=145 ox=61 oy=-29 w=16 h=16 a=1 qy=32",
    "ICE_CRYSTALS x=-21 y=110 ox=35 oy=-17 w=16 h=16 a=1 qy=32",
    "ICE_CRYSTALS x=-21 y=150 ox=10 oy=-4 w=16 h=16 a=1 qy=32",
  ],
  [61]: [
    "BUBBLE x=90 y=18 ox=101 oy=-3 w=16 h=16 a=1 qy=0",
    "BUBBLE x=95 y=50 ox=74 oy=-3 w=16 h=16 a=1 qy=0",
    "BUBBLE x=90 y=148 ox=61 oy=-74 w=16 h=16 a=1 qy=0",
    "BUBBLE x=87 y=103 ox=57 oy=-35 w=16 h=16 a=1 qy=0",
    "BUBBLE x=98 y=79 ox=44 oy=-12 w=16 h=16 a=1 qy=0",
    "BUBBLE x=84 y=118 ox=43 oy=-41 w=16 h=16 a=1 qy=0",
    "BUBBLE x=90 y=18 ox=29 oy=56 w=16 h=16 a=1 qy=0",
    "BUBBLE x=95 y=50 ox=10 oy=33 w=16 h=16 a=1 qy=0",
    "BUBBLE x=90 y=148 ox=3 oy=-61 w=16 h=16 a=1 qy=0",
  ],
  [86]: [
    "SPARK x=176 y=8 ox=0 oy=0 w=8 h=16 a=1 qy=0",
    "SPARK x=176 y=24 ox=0 oy=0 w=8 h=16 a=1 qy=8",
    "SPARK x=176 y=40 ox=0 oy=0 w=8 h=16 a=1 qy=16",
    "SPARK x=176 y=56 ox=0 oy=0 w=8 h=16 a=1 qy=24",
  ],
  [92]: [
    "TOXIC_BUBBLE x=184 y=56 ox=0 oy=0 w=16 h=32 a=1 qy=96",
  ],
  [145]: [
    "BUBBLE x=80 y=79 ox=115 oy=-48 w=16 h=16 a=1 qy=32",
    "BUBBLE x=81 y=59 ox=104 oy=-52 w=16 h=16 a=1 qy=32",
    "BUBBLE x=84 y=118 ox=109 oy=-52 w=16 h=16 a=1 qy=16",
  ],
  [260]: [
    "SPOTLIGHT x=176 y=32 ox=0 oy=0 w=64 h=64 a=1 qy=0",
    "nil x=0 y=0 ox=0 oy=0 w=8 h=8 a=1 qy=0",
  ],
  [263]: [
    "SWEAT_DROP x=30 y=94 ox=0 oy=0 w=8 h=8 a=1 qy=0",
    "SWEAT_DROP x=26 y=100 ox=0 oy=0 w=8 h=8 a=1 qy=0",
    "SWEAT_DROP x=114 y=94 ox=0 oy=0 w=8 h=8 a=1 qy=0",
    "SWEAT_DROP x=118 y=100 ox=0 oy=0 w=8 h=8 a=1 qy=0",
  ],
  [274]: [
    "PAW_PRINT x=112 y=-16 ox=20 oy=108 w=32 h=32 a=1 qy=0",
    "PAW_PRINT x=208 y=128 ox=-142 oy=-50 w=32 h=32 a=1 qy=0",
    "PAW_PRINT x=-16 y=112 ox=142 oy=-67 w=32 h=32 a=1 qy=0",
    "PAW_PRINT x=108 y=128 ox=-10 oy=-60 w=32 h=32 a=1 qy=0",
    "PAW_PRINT x=-16 y=56 ox=82 oy=0 w=32 h=32 a=1 qy=0",
  ],
  [316]: [
    "nil x=176 y=40 ox=24 oy=0 w=64 h=64 a=1 qy=0",
    "nil x=176 y=40 ox=-24 oy=0 w=64 h=64 a=1 qy=0",
  ],
};

/* eslint-disable @typescript-eslint/no-explicit-any */
let G3Lazy: any, Anim: any, AnimSprites: any, AnimTasks: any, AnimCallbacks: any;
let e3b: any, e3c: any, g5: any, g4Tasks: any, g4Callbacks: any, g4Pret: any;
const results: Record<number, { frames: number; ended: boolean; maxSprites: number; err?: string }> = {};
const dumps: Record<number, string[]> = {};

function dumpSprites(): string[] {
  const out: string[] = [];
  AnimSprites.forEachActive((s: any) => {
    out.push(`${tostring(s.tag)} x=${tostring(s.x)} y=${tostring(s.y)} ox=${tostring(s.ox)} oy=${tostring(s.oy)} `
      + `w=${tostring(s.w)} h=${tostring(s.h)} a=${tostring(s.alpha)} qy=${tostring(s.quadY)}`);
  });
  return out;
}

function runMove(id: number): void {
  try {
    Anim.reset({});
    Anim.present(0).visible = true;
    Anim.present(1).visible = true;
    const vm = Anim.vm();
    let ended = false;
    Anim.launchMove(id, {
      attackerSide: "player", targetSide: "enemy", attackerId: 0, targetId: 1,
      onEnd: () => { ended = true; },
    });
    let frames = 0, maxSprites = 0;
    while (vm.active && frames < 5000) {
      vm.update(1 / 60);
      frames++;
      maxSprites = Math.max(maxSprites, AnimSprites.activeCount());
      if (DUMP_AT[id] === frames) dumps[id] = dumpSprites();
    }
    results[id] = { frames, ended, maxSprites };
  } catch (e) {
    results[id] = { frames: -1, ended: false, maxSprites: -1, err: String(e) };
  }
}

describe.skipIf(!existsSync(ROOT))("gen3 runtime: anim_port groups g3_e3b/e3c, g4, g5", () => {
  beforeAll(async () => {
    setHost(new DesktopHost(ROOT));
    ({ G3Lazy } = await import("../voxelmon/game/gen3/core/lazy_registry.ts"));
    g4Pret = (await import("../voxelmon/game/gen3/core/battle/anim_port/g4_pret.ts")).default;
    g4Tasks = (await import("../voxelmon/game/gen3/core/battle/anim_port/g4_tasks.ts")).default;
    g4Callbacks = (await import("../voxelmon/game/gen3/core/battle/anim_port/g4_callbacks.ts")).default;
    g5 = (await import("../voxelmon/game/gen3/core/battle/anim_port/g5_tasks.ts")).default;
    e3b = (await import("../voxelmon/game/gen3/core/battle/anim_port/g3_e3b.ts")).default;
    e3c = (await import("../voxelmon/game/gen3/core/battle/anim_port/g3_e3c.ts")).default;
    ({ Anim } = await import("../voxelmon/game/gen3/core/battle/anim.ts"));
    ({ AnimSprites } = await import("../voxelmon/game/gen3/core/battle/anim_sprites.ts"));
    ({ AnimTasks } = await import("../voxelmon/game/gen3/core/battle/anim_tasks.ts"));
    ({ AnimCallbacks } = await import("../voxelmon/game/gen3/core/battle/anim_callbacks.ts"));
  });

  test("entry modules register in G3Lazy under their Lua names", () => {
    expect(G3Lazy[PRE + "g4_pret"]).toBe(g4Pret);
    expect(G3Lazy[PRE + "g4_tasks"]).toBe(g4Tasks);
    expect(G3Lazy[PRE + "g4_callbacks"]).toBe(g4Callbacks);
    expect(G3Lazy[PRE + "g5_tasks"]).toBe(g5);
    const lazy = readFileSync(join(import.meta.dir, "../voxelmon/game/gen3/core/lazy_modules.ts"), "utf8");
    for (const m of ["g4_pret", "g4_tasks", "g4_callbacks", "g5_tasks"]) {
      expect(lazy).toContain(`import "./battle/anim_port/${m}.ts";`);
    }
    // e3b / e3c return { callbacks, tasks } (read by g3_tasks / g3_callbacks)
    expect(typeof e3b.tasks.AcidArmor).toBe("function");
    expect(typeof e3c.callbacks.GlareEyeDot).toBe("function");
  });

  test("g4_pret math matches pret (trig.h, battle_anim_mons.c)", () => {
    expect(g4Pret.Sin(64, 32)).toBe(32);
    expect(g4Pret.Cos(0, 32)).toBe(32);
    expect(g4Pret.Sin(192, 16)).toBe(-16);
    expect(g4Pret.s16(0x8000)).toBe(-0x8000);
    expect(g4Pret.cdiv(-7, 2)).toBe(-3);
    // 31 + ((0 - 31) * 8 >> 4) = 15 (an arithmetic shift, as Brian's bit.arshift)
    expect(g4Pret.blend555(0x7FFF, 8, 0)).toBe(g4Pret.rgb(15, 15, 15));
    // a linear translation: 10 frames from x=0 to x=40 moves 4 px a frame
    const s: any = { x: 0, y: 0, ox: 0, oy: 0, data: { 0: 10, 2: 40, 4: 0 } };
    s.data[1] = s.x; s.data[3] = s.y;
    g4Pret.initLinear(s);
    for (let i = 0; i < 10; i++) g4Pret.translateLinear(s);
    expect(s.ox).toBe(40);
    expect(g4Pret.translateLinear(s)).toBe(true);
  });

  test("every move, in order, with only these groups present", () => {
    // Only these groups, as in the oracle: drop any other group's entry, and give
    // g3_tasks / g3_callbacks what Brian's loops build from e3b + e3c alone.
    for (const g of ["g1", "g2", "g3"]) for (const k of ["_tasks", "_callbacks"]) delete G3Lazy[PRE + g + k];
    G3Lazy[PRE + "g3_tasks"] = { ...e3b.tasks, ...e3c.tasks };
    G3Lazy[PRE + "g3_callbacks"] = { ...e3b.callbacks, ...e3c.callbacks };
    for (let id = 1; id <= 354; id++) runMove(id);
    const errs = Object.entries(results).filter(([, r]) => r.err != null).map(([id, r]) => `${id}: ${r.err}`);
    expect(errs).toEqual([]);
    const notEnded = Object.entries(results).filter(([, r]) => !r.ended).map(([id]) => id);
    expect(notEnded).toEqual([]);
    // the groups merged into the core registries
    expect(AnimCallbacks._g4).toBeTruthy();
    expect(typeof AnimTasks.REGISTRY.ElectricChargingParticles).toBe("function");
    expect(typeof AnimTasks.REGISTRY.FrozenIceCube).toBe("function");
  });

  test("THUNDER WAVE runs Brian's full 119 frames", () => {
    expect(results[THUNDER_WAVE]).toEqual({ frames: 119, ended: true, maxSprites: 6 });
  });

  test("every move these groups drive matches Brian's frame count and sprite peak", () => {
    const got: Record<number, [number, number]> = {};
    for (const id of Object.keys(ORACLE)) {
      const r = results[+id];
      got[+id] = [r.frames, r.maxSprites];
    }
    expect(got).toEqual(ORACLE);
  });

  test("particle positions match Brian's sprite dumps", () => {
    const want: Record<number, string[]> = {};
    const have: Record<number, string[]> = {};
    for (const id of Object.keys(DUMP_AT)) {
      want[+id] = ORACLE_DUMPS[+id] ?? [];
      have[+id] = dumps[+id] ?? [];
    }
    expect(have).toEqual(want);
  });
});
