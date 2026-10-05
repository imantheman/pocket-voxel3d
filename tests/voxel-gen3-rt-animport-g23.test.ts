// The FireRed runtime port, battle-animation anim_port groups F, G and H:
//   F: g2_modules g2_callbacks g2_tasks g2_mon_sizes g2_templates g2_dragon
//      g2_fight g2_flying g2_fire g2_effects2a
//   G: g3_pret g3_data g3_callbacks g3_tasks g2_effects2b g2_effects2c
//   H: g3_dark g3_ghost g3_psychic g3_e3a
// on real data (~/gen3ref/frfull's move-animation pack).
//
// Oracle: gen1recomp's own engine under luajit (.cc_ban_oracle.lua, love
// stubbed so images report their PNG sizes, audio silent), FULL mode (every
// anim_port group loaded), counting AnimVm:update calls until the VM goes idle
// for a move launched player -> enemy. The port runs with every group present
// (the other workers' g1 / g2_pret / g3_e3b,c / g4 / g5 too), as the game does.
// Sprite dumps are the oracle's DUMPF lines (tag x y ox oy w h alpha quadY of
// every active sprite at one frame), sorted.
import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DesktopHost } from "../voxelmon/game/gen3/platform/desktop.ts";
import { setHost } from "../voxelmon/game/gen3/platform/host.ts";

const ROOT = join(homedir(), "gen3ref/frfull");

// move id -> [frames, maxSprites], Brian's engine (luajit, full).
const FIRE: Record<number, [number, number]> = {
  7: [94, 9], 52: [68, 3], 53: [128, 8], 83: [103, 7], 126: [196, 17], 241: [144, 4], 257: [163, 4],
  261: [191, 6], 284: [446, 7], 299: [86, 9], 315: [221, 24],
};
const FLYING: Record<number, [number, number]> = {
  16: [92, 1], 17: [91, 4], 19: [34, 1], 64: [18, 1], 65: [89, 4], 143: [124, 0], 314: [100, 3],
  332: [32, 3], 340: [32, 1],
};
const FIGHTING: Record<number, [number, number]> = {
  2: [32, 1], 24: [30, 2], 26: [39, 1], 27: [49, 2], 66: [101, 1], 67: [30, 2], 69: [204, 5],
  136: [86, 1], 179: [170, 6], 223: [76, 4], 238: [73, 3], 264: [143, 2], 276: [242, 7], 279: [128, 2],
  280: [145, 2], 292: [47, 1], 327: [178, 4], 339: [107, 1],
};
const DRAGON: Record<number, [number, number]> = {
  82: [158, 8], 200: [95, 14], 225: [87, 6], 239: [183, 12], 337: [143, 11], 349: [104, 6],
};
const DARK: Record<number, [number, number]> = {
  44: [35, 3], 168: [124, 1], 185: [205, 1], 228: [92, 1], 242: [131, 3], 251: [30, 2], 259: [176, 6],
  260: [215, 40], 262: [172, 0], 282: [47, 1], 289: [27, 0], 313: [83, 8],
};
const GHOST: Record<number, [number, number]> = {
  101: [216, 1], 109: [259, 1], 122: [72, 1], 171: [157, 1], 174: [357, 1], 180: [209, 1], 194: [177, 1],
  247: [149, 1], 288: [172, 6], 310: [62, 2], 325: [98, 10],
};
const PSYCHIC: Record<number, [number, number]> = {
  60: [155, 3], 93: [135, 0], 94: [135, 0], 95: [164, 6], 96: [114, 0], 97: [74, 2], 100: [90, 0],
  112: [68, 1], 113: [83, 4], 115: [71, 3], 133: [210, 1], 134: [268, 3], 149: [200, 5], 156: [109, 3],
  248: [106, 0], 285: [190, 5], 286: [173, 5], 322: [235, 2], 326: [151, 1], 347: [102, 2], 354: [384, 1],
};

// move id, frame -> the oracle's sprite dump (sorted).
const DUMPS: [number, number, string[]][] = [
  [349, 30, [ // DRAGON DANCE: g2_dragon DragonDanceOrb
    "S HOLLOW_ORB x=72 y=88 ox=-27 oy=17 w=16 h=16 a=1 qy=nil",
    "S HOLLOW_ORB x=72 y=88 ox=-29 oy=-14 w=16 h=16 a=1 qy=nil",
    "S HOLLOW_ORB x=72 y=88 ox=-3 oy=-32 w=16 h=16 a=1 qy=nil",
    "S HOLLOW_ORB x=72 y=88 ox=2 oy=31 w=16 h=16 a=1 qy=nil",
    "S HOLLOW_ORB x=72 y=88 ox=26 oy=-18 w=16 h=16 a=1 qy=nil",
    "S HOLLOW_ORB x=72 y=88 ox=28 oy=14 w=16 h=16 a=1 qy=nil",
  ]],
  [314, 50, [ // AIR CUTTER: g2_effects2a AirCutterProjectile / AirWaveProjectile
    "S AIR_WAVE x=144 y=46 ox=34 oy=-15 w=32 h=16 a=1 qy=nil",
    "S AIR_WAVE x=144 y=46 ox=34 oy=-15 w=32 h=16 a=1 qy=nil",
    "S AIR_WAVE x=144 y=46 ox=34 oy=-15 w=32 h=16 a=1 qy=nil",
  ]],
  [2, 15, [ // KARATE CHOP: g2_fight
    "S HANDS_AND_FEET x=144 y=40 ox=28 oy=0 w=32 h=32 a=1 qy=nil",
  ]],
  [261, 100, [ // WILL-O-WISP: g2_fire WillOWispOrb
    "S WISP_ORB x=71 y=80 ox=31 oy=-17 w=16 h=16 a=1 qy=nil",
    "S WISP_ORB x=71 y=80 ox=36 oy=-19 w=16 h=16 a=1 qy=nil",
    "S WISP_ORB x=71 y=80 ox=45 oy=-21 w=16 h=16 a=1 qy=nil",
    "S WISP_ORB x=71 y=80 ox=57 oy=-23 w=16 h=16 a=1 qy=nil",
  ]],
  [276, 120, [ // SUPERPOWER: g2_fight SuperpowerOrb / SuperpowerRock
    "S CIRCLE_OF_LIGHT x=72 y=88 ox=0 oy=0 w=64 h=64 a=1 qy=nil",
    "S FLAT_ROCK x=130 y=103 ox=0 oy=0 w=16 h=16 a=1 qy=nil",
    "S FLAT_ROCK x=160 y=107 ox=0 oy=0 w=16 h=16 a=1 qy=nil",
    "S FLAT_ROCK x=20 y=84 ox=0 oy=0 w=16 h=16 a=1 qy=nil",
    "S FLAT_ROCK x=200 y=102 ox=0 oy=0 w=16 h=16 a=1 qy=nil",
    "S FLAT_ROCK x=60 y=112 ox=0 oy=0 w=16 h=16 a=1 qy=nil",
  ]],
];

/* eslint-disable @typescript-eslint/no-explicit-any */
let Anim: any, AnimSprites: any, AnimTasks: any, AnimCallbacks: any, G3Lazy: any, NotPortedError: any,
  tostring: any, P3: any, G3Data: any, G2Templates: any, MonSizes: any, Ui: any;

function resetAnim(): void {
  try {
    Anim.reset({});
  } catch (e) {
    if (!(e instanceof NotPortedError)) throw e;
  }
  Anim.present(0).visible = true;
  Anim.present(1).visible = true;
}

function runMove(id: number, dumpAt = 0): { frames: number; ended: boolean; maxSprites: number; dump: string[] } {
  resetAnim();
  const vm = Anim.vm();
  let ended = false;
  Anim.launchMove(id, {
    attackerSide: "player", targetSide: "enemy", attackerId: 0, targetId: 1,
    onEnd: () => { ended = true; },
  });
  let frames = 0, maxSprites = 0;
  const dump: string[] = [];
  const T = (v: any): string => (v == null ? "nil" : tostring(v));
  while (vm.active && frames < 5000) {
    vm.update(1 / 60);
    frames++;
    maxSprites = Math.max(maxSprites, AnimSprites.activeCount());
    if (frames === dumpAt) {
      AnimSprites.forEachActive((s: any) => dump.push(
        `S ${T(s.tag)} x=${T(s.x)} y=${T(s.y)} ox=${T(s.ox)} oy=${T(s.oy)} w=${T(s.w)} h=${T(s.h)} a=${T(s.alpha)} qy=${T(s.quadY)}`));
    }
  }
  dump.sort();
  return { frames, ended, maxSprites, dump };
}

function checkTable(table: Record<number, [number, number]>): void {
  const got: Record<number, [number, number]> = {};
  for (const k of Object.keys(table)) {
    const r = runMove(+k);
    expect(r.ended).toBe(true);
    got[+k] = [r.frames, r.maxSprites];
  }
  expect(got).toEqual(table);
}

describe.skipIf(!existsSync(ROOT))("gen3 runtime: anim_port groups F, G, H", () => {
  beforeAll(async () => {
    setHost(new DesktopHost(ROOT));
    await import("../voxelmon/game/gen3/core/lazy_modules.ts");
    ({ G3Lazy } = await import("../voxelmon/game/gen3/core/lazy_registry.ts"));
    ({ NotPortedError } = await import("../voxelmon/game/gen3/notported.ts"));
    ({ tostring } = await import("../voxelmon/import/gen3/lua.ts"));
    ({ Anim } = await import("../voxelmon/game/gen3/core/battle/anim.ts"));
    ({ AnimSprites } = await import("../voxelmon/game/gen3/core/battle/anim_sprites.ts"));
    ({ AnimTasks } = await import("../voxelmon/game/gen3/core/battle/anim_tasks.ts"));
    ({ AnimCallbacks } = await import("../voxelmon/game/gen3/core/battle/anim_callbacks.ts"));
    ({ Ui } = await import("../voxelmon/game/gen3/core/battle/ui.ts"));
    ({ P: P3 } = await import("../voxelmon/game/gen3/core/battle/anim_port/g3_pret.ts"));
    ({ G3Data } = await import("../voxelmon/game/gen3/core/battle/anim_port/g3_data.ts"));
    ({ T: G2Templates } = await import("../voxelmon/game/gen3/core/battle/anim_port/g2_templates.ts"));
    ({ MonSizes } = await import("../voxelmon/game/gen3/core/battle/anim_port/g2_mon_sizes.ts"));
  });

  test("the entry modules register in G3Lazy and merge into the core registries", () => {
    for (const n of ["g2_callbacks", "g2_tasks", "g3_callbacks", "g3_tasks"]) {
      expect(typeof G3Lazy["src.core.game3.battle.anim_port." + n]).toBe("object");
    }
    AnimTasks.init();
    AnimCallbacks._loadGroups();
    const g2t = G3Lazy["src.core.game3.battle.anim_port.g2_tasks"];
    const g3t = G3Lazy["src.core.game3.battle.anim_port.g3_tasks"];
    const g3c = G3Lazy["src.core.game3.battle.anim_port.g3_callbacks"];
    for (const k of ["DragonDanceWaver", "MoveSkyUppercutBg", "EruptionLaunchRocks", "AnimateGustTornadoPalette",
      "AirCutterProjectile", "SketchDrawMon", "HeartsBackground", "IsFuryCutterHitRight"]) {
      expect(AnimTasks.REGISTRY[k]).toBe(g2t[k]);
      expect(AnimTasks.REGISTRY["AnimTask_" + k]).toBe(g2t[k]);
    }
    for (const k of ["AttackerFadeToInvisible", "GrudgeFlames", "NightShadeClone", "ImprisonOrbs",
      "ExtrasensoryDistortion", "TormentAttacker", "MorningSunLightBeam", "DefenseCurlDeformMon"]) {
      expect(AnimTasks.REGISTRY[k]).toBe(g3t[k]);
    }
    for (const k of ["Bite", "ShadowBall", "CurseNail", "PsychoBoost", "DefensiveWall", "BlackSmoke", "Spotlight"]) {
      expect(AnimCallbacks[k]).toBe(g3c[k]);
    }
    // g2 sprite callbacks: raw in g2_pret's P.CB, P.cb-wrapped in the merged table
    const g2c = G3Lazy["src.core.game3.battle.anim_port.g2_callbacks"];
    for (const k of ["OutrageFlame", "FireSpiralInward", "GustToTarget", "CrossChopHand", "Pencil", "Devil"]) {
      expect(typeof g2c[k]).toBe("function");
      expect(AnimCallbacks[k]).toBe(g2c[k]);
    }
  });

  test("g3_pret primitives match Brian's (luajit)", () => {
    expect([P3.Sin(64, 256), P3.Sin(200, -77), P3.Cos(10, 300), P3.Sin2(90), P3.Sin2(270), P3.Sin2(-5)])
      .toEqual([256, 75, 290, 4096, -4096, 782]);
    expect([P3.ArcTan2Neg(10, -20), P3.ArcTan2Neg(-33, 7)]).toEqual([11548, 34948]);
    expect([P3.div(-7, 2), P3.mod(-7, 2), P3.s16(40000), P3.u8(-1)]).toEqual([-3, -1, -25536, 255]);
    const s: any = { data: [10, 0, 100, 0, -50, 0, 0, 0], ox: 0, oy: 0 };
    P3.InitAnimLinearTranslation(s);
    expect([s.data[1], s.data[2]]).toEqual([2560, 1281]);
    for (let i = 0; i < 3; i++) P3.AnimTranslateLinear(s);
    expect([s.ox, s.oy, s.data[0], s.data[3], s.data[4]]).toEqual([30, -15, 7, 7680, 3843]);
    const f: any = { data: [7, 5, -60, 3, 90, 0, 0, 0], ox: 0, oy: 0 };
    P3.InitAnimFastLinearTranslation(f);
    for (let i = 0; i < 4; i++) P3.AnimFastTranslateLinear(f);
    expect([f.data[1], f.data[2], f.ox, f.oy]).toEqual([149, 198, -37, 49]);
    const a: any = { data: [16, 0, 150, 0, 30, 12, 0, 0], x: 50, y: 60, ox: 0, oy: 0 };
    P3.InitAnimArcTranslation(a);
    for (let i = 0; i < 5; i++) P3.TranslateAnimHorizontalArc(a);
    expect([a.data[6], a.data[7], a.ox, a.oy]).toEqual([2048, 10240, 31, 0]);
    const w = P3.Wave(10, 20, 2, 6, 1);
    const o1 = w.step(w, 3); w.step(w, 3); const o3 = w.step(w, 3);
    expect([o1[10], o1[19], o3[10], o3[15], w.offset, w.framesUntilMove]).toEqual([3, 5, 3, 4, 1, 0]);
  });

  test("g3_pret sprite anim / affine-anim commands on g3_data tables match Brian's", () => {
    const sp: any = { _anims: [null, G3Data.anims.sAnim_BentSpoon_1], animNum: 0, animBeginning: true };
    const trace: number[] = [];
    for (let i = 0; i < 160; i++) { P3.animate(sp); trace.push(sp.imageValue); }
    const want = "8,".repeat(60) + "16,16,16,16,16,8,8,8,8,8,0,0,0,0,0," + "8,".repeat(22)
      + "16,16,16,16,16,8,8,8,8,8,0,0,0,0,0,8,8,8,8,8,16,16,16,16,16,8,8,8,8,8,0,0,0,0,0," + "8,".repeat(27) + "24";
    expect(trace.join(",")).toBe(want);
    expect(sp.animEnded).toBe(false);
    const af: any = { _aff: 1, _affine: [null, G3Data.affine.sAffineAnim_PsychoBoostOrb_0], affineAnimBeginning: true };
    const at: string[] = [];
    for (let i = 0; i < 30; i++) { P3.animate(af); at.push(af.affX + "/" + af.affRot); }
    expect(at.join(",")).toBe("32/0,48/0,64/0,80/0,96/0,112/0,128/0,144/0,160/0,176/0,192/0,208/0,224/0,240/0,"
      + "256/0,272/0,288/0,304/0,296/0,288/0,280/0,272/0,264/0,256/0,248/0,240/0,232/0,224/0,232/0,240/0");
  });

  test("data modules: g3_data, g2_templates (lazy build), g2_mon_sizes", () => {
    expect(P3.template("gShadowBallSpriteTemplate")).toMatchObject({ tag: "SHADOW_BALL", w: 32, h: 32, aff: 1 });
    expect(P3.template(null)).toBeNull();
    const t = G2Templates.gDragonDanceOrbSpriteTemplate;
    expect(t).toMatchObject({ tag: "HOLLOW_ORB", w: 16, h: 16, cbName: "DragonDanceOrb" });
    expect(t.anims[1][1]).toEqual({ stop: true });
    expect(Object.keys(G2Templates)).toContain("_affine");
    expect(G2Templates._affine.sSplashEffectAffineAnimCmds.length - 1).toBe(4);
    // FRLG front pic 1 is 40x40 (10280): (40 / 8) * 16 + 40 / 8
    expect(MonSizes.front[1]).toBe(85);
  });

  test("FIRE moves: Brian's full frame counts", () => checkTable(FIRE));
  test("FLYING moves: Brian's full frame counts", () => checkTable(FLYING));
  test("FIGHTING moves: Brian's full frame counts", () => checkTable(FIGHTING));
  test("DRAGON moves: Brian's full frame counts", () => checkTable(DRAGON));
  test("DARK moves: Brian's full frame counts", () => checkTable(DARK));
  test("GHOST moves: Brian's full frame counts", () => checkTable(GHOST));
  test("PSYCHIC moves: Brian's full frame counts", () => checkTable(PSYCHIC));

  test("mid-move sprite dumps match the oracle's", () => {
    for (const [id, f, want] of DUMPS) {
      expect({ id, dump: runMove(id, f).dump }).toEqual({ id, dump: want });
    }
  });

  test("every move 1..354, every frame: sprite traces equal Brian's (shared RNG)", async () => {
    // The oracle run with math.random replaced by platform/rng.ts's generator
    // (mulberry32, Lua argument rules, same start state): for each move in
    // order, each frame, "<move> <frame> <activeCount> <sorted tag@x,y+ox,oy ...>".
    // 48547 lines, SHA-1 of the file below. (With LuaJIT's own math.random the
    // frame counts still all match; only the random-driven sprites differ.)
    const { seed } = await import("../voxelmon/game/gen3/platform/rng.ts");
    const { createHash } = await import("node:crypto");
    seed(0x9e3779b9);
    const T = (v: any): string => (v == null ? "nil" : tostring(v));
    const lines: string[] = [];
    for (let id = 1; id <= 354; id++) {
      resetAnim();
      const vm = Anim.vm();
      Anim.launchMove(id, { attackerSide: "player", targetSide: "enemy", attackerId: 0, targetId: 1 });
      let f = 0;
      while (vm.active && f < 5000) {
        vm.update(1 / 60);
        f++;
        const tags: string[] = [];
        AnimSprites.forEachActive((s: any) => tags.push(`${T(s.tag)}@${T(s.x)},${T(s.y)}+${T(s.ox)},${T(s.oy)}`));
        tags.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        lines.push(`${id} ${f} ${AnimSprites.activeCount()} ${tags.join(" ")}`);
      }
    }
    expect(lines.length).toBe(48547);
    expect(createHash("sha1").update(lines.join("\n") + "\n").digest("hex")).toBe("2eb0f84a0c6befbc56520531202168d596550112");
  });

  test("NIGHT SHADE's clone sits on Ui.battlerSpriteCenter (the oracle has no battle ui loaded)", () => {
    // g3_pret monCenter reads package.loaded["src.core.game3.battle.ui"]; in a
    // battle it is loaded (the oracle's minimal harness leaves it out and takes
    // Brian's fallback, COORD_Y_PIC_DEF = y 80). The port always has Ui.
    const r = runMove(101, 100);
    expect(r.dump.length).toBe(1);
    const [, cy] = Ui.battlerSpriteCenter("player", P3.species(Anim.vm(), "player"), { x: 72, y: 80 });
    expect(r.dump[0]).toBe(`S nil x=72 y=${tostring(cy)} ox=0 oy=0 w=64 h=64 a=1 qy=0`);
  });
});
