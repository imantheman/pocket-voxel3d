// The FireRed runtime port, cluster "battle animation engine": anim, anim_vm,
// anim_seq, anim_tasks, anim_callbacks, anim_pal, anim_sprites, anim_coords,
// anim_templates, anim_ctx. Real data: the importer's move-animation pack
// (data/generated/gba/pokemon/battle_anims/pack.lua) from ~/gen3ref/frfull.
//
// Frame counts are gen1recomp's own: its anim.lua / anim_vm.lua run under
// luajit on the same pack (love stubbed so images report their PNG sizes,
// audio silent), counting AnimVm:update calls until the VM goes idle. The
// anim_port groups (g1..g5 tasks/callbacks, g4_pret) are not ported yet, so the
// oracle blocks them too (their pcall(require) fails, Brian's "not found" path):
//   noport: TACKLE 29, EMBER 65, THUNDERBOLT 241, FLASH 2, THUNDER WAVE 83
//   full:   TACKLE 25, EMBER 68, THUNDERBOLT 235, FLASH 41, THUNDER WAVE 119
// (the "full" row is what the port reaches once anim_port is ported).
// Frames are also rendered to /tmp/g3shots/battleanim_*.png.
import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DesktopHost } from "../voxelmon/game/gen3/platform/desktop.ts";
import { setHost } from "../voxelmon/game/gen3/platform/host.ts";
import { encodePng } from "../voxelmon/import/gen3/png.ts";

const ROOT = join(homedir(), "gen3ref/frfull");
const SHOTS = "/tmp/g3shots";
const TACKLE = 33, EMBER = 52, THUNDERBOLT = 85, THUNDER_WAVE = 86, FLASH = 148;

// Brian's VM under luajit, anim_port blocked (see the header).
const ORACLE_NOPORT: Record<number, number> = {
  [TACKLE]: 29, [EMBER]: 65, [THUNDERBOLT]: 241, [FLASH]: 2, [THUNDER_WAVE]: 83,
};

/* eslint-disable @typescript-eslint/no-explicit-any */
let host: DesktopHost;
let G: any, Anim: any, AnimVm: any, AnimSprites: any, AnimCoords: any, AnimPal: any, AnimTemplates: any,
  AnimCallbacks: any, AnimTasks: any, NotPortedError: any;

/** Anim.reset as a battle does; its last call (BallOpen.reset) is the
 *  ball-open module, still a stub of another cluster. */
function resetAnim(): void {
  try {
    Anim.reset({});
  } catch (e) {
    if (!(e instanceof NotPortedError)) throw e;
  }
  // both mons on screen (Anim.reset hides them until the send-out)
  Anim.present(0).visible = true;
  Anim.present(1).visible = true;
}

function shot(name: string, draw: () => void): void {
  G.beginFrame();
  // stand-in battle scene: sky, ground, and boxes where the mon pics sit
  G.setColor(0.55, 0.75, 0.95, 1); G.rectangle("fill", 0, 0, 240, 112);
  G.setColor(0.45, 0.70, 0.40, 1); G.rectangle("fill", 0, 112, 240, 48);
  G.setColor(0.2, 0.2, 0.2, 1);
  for (const id of [0, 1]) {
    const [cx, cy] = Anim.battlerCenter(id);
    G.rectangle("line", cx - 32, cy - 32, 64, 64);
  }
  G.setColor(1, 1, 1, 1);
  draw();
  G.endFrame();
  if (!existsSync(SHOTS)) mkdirSync(SHOTS, { recursive: true });
  writeFileSync(join(SHOTS, name), encodePng(240, 160, host.pixels()));
}

/** Launch a move (player -> enemy) and tick to completion; snap frames on request. */
function runMove(moveId: number, snaps: Record<number, string> = {}): { frames: number; ended: boolean; maxSprites: number } {
  resetAnim();
  const vm = Anim.vm();
  let ended = false;
  Anim.launchMove(moveId, {
    attackerSide: "player", targetSide: "enemy", attackerId: 0, targetId: 1,
    onEnd: () => { ended = true; },
  });
  let frames = 0, maxSprites = 0;
  while (vm.active && frames < 5000) {
    vm.update(1 / 60);
    frames++;
    maxSprites = Math.max(maxSprites, AnimSprites.activeCount());
    const name = snaps[frames];
    if (name) shot(name, () => Anim.drawParticles());
  }
  return { frames, ended, maxSprites };
}

describe.skipIf(!existsSync(ROOT))("gen3 runtime: battle animation engine", () => {
  beforeAll(async () => {
    host = new DesktopHost(ROOT);
    setHost(host);
    ({ G } = await import("../voxelmon/game/gen3/platform/graphics.ts"));
    ({ NotPortedError } = await import("../voxelmon/game/gen3/notported.ts"));
    ({ Anim } = await import("../voxelmon/game/gen3/core/battle/anim.ts"));
    ({ AnimVm } = await import("../voxelmon/game/gen3/core/battle/anim_vm.ts"));
    ({ AnimSprites } = await import("../voxelmon/game/gen3/core/battle/anim_sprites.ts"));
    ({ AnimCoords } = await import("../voxelmon/game/gen3/core/battle/anim_coords.ts"));
    ({ AnimPal } = await import("../voxelmon/game/gen3/core/battle/anim_pal.ts"));
    ({ AnimTemplates } = await import("../voxelmon/game/gen3/core/battle/anim_templates.ts"));
    ({ AnimCallbacks } = await import("../voxelmon/game/gen3/core/battle/anim_callbacks.ts"));
    ({ AnimTasks } = await import("../voxelmon/game/gen3/core/battle/anim_tasks.ts"));
  });

  test("coords, ids and id tables (battle_anim_mons.c)", () => {
    AnimCoords.setDouble(false);
    expect(AnimCoords.coords(null, "player")).toMatchObject({ x: 72, y: 80 });
    expect(AnimCoords.coords(null, "enemy")).toMatchObject({ x: 176, y: 40 });
    expect(AnimCoords.partner(1)).toBe(3);
    AnimCoords.bind(0, 1);
    const t = AnimCoords.idTable({ player: "p", 1: "e" });
    expect(t[0]).toBe("p");
    expect(t.enemy).toBe("e");
    AnimCoords.bind(null);
    // pokefirered/src/battle_anim.c:630 layer z
    expect(AnimCoords.layerZ(2, null, null)).toBe(201 + 96);
  });

  test("palette blend matches pret BlendPalette", () => {
    // white blended halfway (8/16) toward black: 31 + floor((0-31)*8/16) = 15
    expect(AnimPal.blendColor(0x7FFF, 8, 0)).toBe(AnimPal.pack(15, 15, 15));
    expect(AnimPal.rgb(AnimPal.pack(1, 2, 3))).toEqual([1, 2, 3]);
  });

  test("templates and callbacks resolve by pret name", () => {
    expect(AnimTemplates.get("gBasicHitSplatSpriteTemplate").tag).toBe("IMPACT");
    expect(AnimTemplates.get("BasicHitSplatSpriteTemplate").callback).toBe("HitSplatBasic");
    expect(AnimCallbacks.get("AnimTravelDiagonally")).toBe(AnimCallbacks.AnimTravelDiagonally);
    expect(AnimCallbacks.get("NoSuchCallback")).toBe(AnimCallbacks.SimpleFadeOut);
    expect(AnimCallbacks.HorizontalLunge).toBeUndefined();
    AnimTasks.init();
    expect(typeof AnimTasks.REGISTRY.ShakeMon).toBe("function");
  });

  test("the move pack loads with tag sheets", () => {
    const script = Anim.scriptForMove(TACKLE);
    expect(script[1].op).toBe("loadspritegfx");
    expect(script[1].tag).toBe("IMPACT");
    const pack = Anim._pack;
    expect(pack.tags.IMPACT.image).toBeTruthy();
    expect(pack.tags.IMPACT.w).toBeGreaterThan(0);
  });

  test("TACKLE runs to completion in Brian's frame count", () => {
    const r = runMove(TACKLE, { 14: "battleanim_tackle_f14.png" });
    expect(r.ended).toBe(true);
    expect(r.frames).toBe(ORACLE_NOPORT[TACKLE]);
    expect(r.maxSprites).toBe(1);
  });

  test("EMBER runs to completion in Brian's frame count", () => {
    const r = runMove(EMBER, { 18: "battleanim_ember_f18.png", 48: "battleanim_ember_f48.png" });
    expect(r.ended).toBe(true);
    expect(r.frames).toBe(ORACLE_NOPORT[EMBER]);
    expect(r.maxSprites).toBe(3);
  });

  test("THUNDERBOLT runs to completion in Brian's frame count", () => {
    const r = runMove(THUNDERBOLT, { 42: "battleanim_thunderbolt_f42.png", 110: "battleanim_thunderbolt_f110.png" });
    expect(r.ended).toBe(true);
    expect(r.frames).toBe(ORACLE_NOPORT[THUNDERBOLT]);
    expect(r.maxSprites).toBe(9);
  });

  test("FLASH and THUNDER WAVE (screen flash / blend tasks) run to completion", () => {
    const f = runMove(FLASH);
    expect(f.ended).toBe(true);
    expect(f.frames).toBe(ORACLE_NOPORT[FLASH]);
    const w = runMove(THUNDER_WAVE, { 35: "battleanim_thunderwave_f35.png" });
    expect(w.ended).toBe(true);
    expect(w.frames).toBe(ORACLE_NOPORT[THUNDER_WAVE]);
  });

  test("a miss plays Brian's 8-frame stand-in", () => {
    resetAnim();
    const vm = Anim.vm();
    Anim.launchMove(TACKLE, { attackerSide: "player", targetSide: "enemy", miss: true });
    let n = 0;
    while (vm.active && n < 100) { vm.update(1 / 60); n++; }
    // Brian's VM under luajit (miss): 11 -- the delay op's frame, 8 waiting
    // frames, the frame that leaves wait mode, and the frame that runs `end`.
    expect(n).toBe(11);
  });

  test("an AnimVm on its own: headless launches end at once", () => {
    const vm = AnimVm.new();
    let ended = false;
    vm.headless = true;
    expect(vm.launch(Anim.scriptForMove(TACKLE), { onEnd: () => { ended = true; } })).toBe(true);
    expect(ended).toBe(true);
    expect(vm.busy()).toBe(false);
  });
});
