// The gen3 runtime's script VM cluster (scripting/vm, ctx, space, flags,
// ops_a, adapters, stdscripts, multichoice, trainers, encounter_rules/frlg)
// on real FireRed cache data through the DesktopHost: load the script space,
// check FR_PALLET_TOWN's events and scripts, flag/var storage, step a Pallet
// Town sign through the VM with a recording adapter set, run a trainer
// battle up to the hand-off to battle, and look up std specials, multichoice
// lists and trainers.
//
// The recording adapters are Brian's own Adapters.stub(opts) with test
// callbacks; nothing here replaces a module's behaviour.
import { describe, expect, test, beforeAll } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DesktopHost } from "../voxelmon/game/gen3/platform/desktop.ts";
import { setHost } from "../voxelmon/game/gen3/platform/host.ts";
import { len, seq } from "../voxelmon/game/gen3/platform/lt.ts";
import { NotPortedError } from "../voxelmon/game/gen3/notported.ts";
import { Space } from "../voxelmon/game/gen3/core/scripting/space.ts";
import { Vm } from "../voxelmon/game/gen3/core/scripting/vm.ts";
import { Ctx } from "../voxelmon/game/gen3/core/scripting/ctx.ts";
import { Flags } from "../voxelmon/game/gen3/core/scripting/flags.ts";
import { Adapters } from "../voxelmon/game/gen3/core/scripting/adapters.ts";
import { Ops } from "../voxelmon/game/gen3/core/scripting/ops_a.ts";
import { Std } from "../voxelmon/game/gen3/core/scripting/stdscripts.ts";
import { Multichoice } from "../voxelmon/game/gen3/core/scripting/multichoice.ts";
import { Trainers } from "../voxelmon/game/gen3/core/scripting/trainers.ts";
import { CollisionStd } from "../voxelmon/game/gen3/core/scripting/collision_std.ts";
import { Encounters } from "../voxelmon/game/gen3/core/encounters.ts";
import { Natives } from "../voxelmon/game/gen3/core/scripting/natives.ts";

const ROOT = join(homedir(), "gen3ref/frfull");

describe.skipIf(!existsSync(ROOT))("gen3 runtime: script VM on FireRed data", () => {
  let bundle: any;

  beforeAll(() => {
    setHost(new DesktopHost(ROOT));
    bundle = Space.ensureBundle(null);
  });

  function newVm(opts: any): Vm {
    return Vm.new({
      store: Flags.newStore(),
      scripts: bundle.scripts,
      text: bundle.text,
      movements: bundle.movements,
      adapters: Adapters.stub(opts),
    });
  }

  test("ensureBundle loads the script space with Lua-shaped script lists", () => {
    expect(bundle.fromCache).toBe(true);
    expect(Object.keys(bundle.events).length).toBe(425);
    expect(Object.keys(bundle.scripts).length).toBe(4128);
    // a script is a 1-based sequence of rows (slot 0 unused)
    const sign = bundle.scripts["g3:08165850"];
    expect(sign[0]).toBeNull();
    expect(len(sign)).toBe(3);
    expect(sign[1].op).toBe("loadword");
    expect(sign[2]).toMatchObject({ op: "callstd", std: 3 });
    expect(Space.scriptKey("g3:08165850")).toBe("g3:08165850");
    expect(Space.scriptKey("NoSuchScript")).toBeNull();
    // marts loaded alongside, as extract_scripts.loadBundle does
    expect(bundle.martListCount).toBeGreaterThan(0);
  });

  test("FR_PALLET_TOWN events: signs, objects, map scripts", () => {
    const ev = bundle.events.FR_PALLET_TOWN;
    expect(len(ev.bgEvents)).toBe(5);
    expect(ev.bgEvents[2]).toMatchObject({ scriptKey: "g3:08165850", x: 4, y: 7, type: "sign" });
    expect(ev.objects[1]).toMatchObject({ localId: 1, sprite: "SPRITE_TEACHER", scriptKey: "g3:0816575c" });
    expect(ev.mapScripts.onTransition).toBe("g3:08165465");
    expect(ev.mapScripts.onFrame[1]).toMatchObject({ script: "g3:081654d8", var: 16464, value: 2 });
    // attachEventsToMaps copies the rows onto the map defs
    const maps: any = { FR_PALLET_TOWN: {} };
    expect(Space.attachEventsToMaps(maps, bundle)).toBe(1);
    expect(maps.FR_PALLET_TOWN.objects[1]).not.toBe(ev.objects[1]);
    expect(maps.FR_PALLET_TOWN.objects[1].sprite).toBe("SPRITE_TEACHER");
    expect(maps.FR_PALLET_TOWN.mapScripts).toBe(ev.mapScripts);
  });

  test("flags: flag and var storage, specials, trainers, badges, save round trip", () => {
    const store = Flags.newStore();
    const ctx = Ctx.new();
    expect(ctx.specialLayout.family).toBe("frlg");
    expect(ctx.specialVars[Ctx.VAR_TEXT_COLOR]).toBe(255);

    expect(Flags.getFlag(store, ctx, 0x2C)).toBe(false);
    Flags.setFlag(store, ctx, "FLAG_HIDE_OAK_IN_PALLET_TOWN", true);
    expect(Flags.IDS.HIDE_OAK_IN_PALLET_TOWN).toBe(0x2C);
    expect(Flags.getFlag(store, ctx, 0x2C)).toBe(true);
    expect(Flags.getFlag(store, ctx, "HIDE_OAK_IN_PALLET_TOWN")).toBe(true);
    Flags.setFlag(store, ctx, 0x2C, false);
    expect(Flags.getFlag(store, ctx, 0x2C)).toBe(false);

    // story vars live in the store, wrapped to 16 bits
    Flags.setVar(store, ctx, 0x4050, 70000);
    expect(Flags.getVar(store, ctx, 0x4050)).toBe(70000 - 65536);
    expect(Flags.getVar(store, ctx, "VAR_MAP_SCENE_PALLET_TOWN_OAK")).toBe(70000 - 65536);
    // special vars live on the ctx, never in the store
    Flags.setVar(store, ctx, Ctx.VAR_RESULT, 7);
    expect(ctx.specialVars[Ctx.VAR_RESULT]).toBe(7);
    expect(store.vars[Ctx.VAR_RESULT]).toBeUndefined();
    expect(Flags.getVar(store, null, Ctx.VAR_RESULT)).toBe(0);
    // ids under 0x4000 read as themselves (event_data.c:235)
    expect(Flags.getVar(store, ctx, 0x12)).toBe(0x12);

    expect(Flags.trainerFlagId(102)).toBe(0x500 + 102);
    expect(Flags.isTrainerDefeated(store, 102)).toBe(false);
    Flags.setTrainerDefeated(store, 102, true);
    expect(Flags.isTrainerDefeated(store, 102)).toBe(true);

    Flags.setBadge(store, "BOULDER", true);
    Flags.setBadge(store, "cascadebadge", true);
    expect(Flags.countBadges(store)).toBe(2);
    expect(Flags.getBadgesMask(store)).toBe(3);
    Flags.setBadgesMask(store, 0x80);
    expect(Flags.hasBadge(store, "EARTH")).toBe(true);
    expect(Flags.hasBadge(store, "BOULDER")).toBe(false);
    expect(Flags.badgeInfo("SURF")!.gym).toBe("FUCHSIA");

    expect(Flags.nameFor(0x2C)).toBe("FLAG_HIDE_OAK_IN_PALLET_TOWN");
    expect(Flags.nameFor(0xFFFE)).toBe("FLAG_0xFFFE");
    expect(Flags.varNameFor(0x4050)).toBe("VAR_MAP_SCENE_PALLET_TOWN_OAK");

    const snap = Flags.serialize(store);
    expect(snap.vars["16464"]).toBe(70000 - 65536);
    const back = Flags.loadInto(Flags.newStore(), snap);
    expect(Flags.getVar(back, ctx, 0x4050)).toBe(70000 - 65536);
    expect(Flags.isTrainerDefeated(back, 102)).toBe(true);
    expect(Flags.hasBadge(back, "EARTH")).toBe(true);

    // temp vars and flags clear on map load
    Flags.setVar(store, ctx, 0x4001, 5);
    Flags.setFlag(store, ctx, 0x05, true);
    Flags.onMapLoad(store);
    expect(Flags.getVar(store, ctx, 0x4001)).toBe(0);
    expect(Flags.getFlag(store, ctx, 0x05)).toBe(false);

    // new game hide flags (EventScript_ResetAllMapFlags)
    const fresh = Flags.newStore();
    Flags.applyNewGameHideFlags(fresh);
    expect(Flags.getFlag(fresh, ctx, 0x2C)).toBe(true);
  });

  test("ctx: special ranges and the step callback", () => {
    expect(Ctx.isSpecial(0x8014)).toBe(true);
    expect(Ctx.isSpecial(0x8015)).toBe(false);
    expect(Ctx.isTemp(0x400F)).toBe(true);
    expect(Ctx.isGfxVar(0x4010)).toBe(true);
    expect(Ctx.setStepCallback(Ctx.STEP_CB.ICE, "FR_SEAFOAM_ISLANDS_B3F")).toBe("ice");
    expect(Ctx.stepCallback("FR_SEAFOAM_ISLANDS_B3F")).toEqual(["ice", 4]);
    expect(Ctx.stepCallback("FR_PALLET_TOWN")).toEqual([]);
    expect(Ctx.setStepCallback(Ctx.STEP_CB.ASH)).toBeNull(); // RSE only
    expect(Ctx.stepCallback()).toEqual([]);
    Ctx.resetStepCallback();
  });

  test("VM steps a Pallet Town sign: loadword, callstd 3, message", () => {
    const messages: any[] = [];
    const vm = newVm({ onMessage: (t: any) => messages.push(t) });
    let err: unknown;
    try {
      expect(vm.start("g3:08165850")).toBe(true);
      for (let i = 0; i < 20 && vm.isRunning(); i++) vm.tick();
    } catch (e) { err = e; }
    // loadword stored the text key; callstd 3 ran the sign's standard script
    // (lockall, message, waitmessage, waitbuttonpress, releaseall) to its end
    expect(vm.ctx.data[0]).toBe("g3:0817d87f");
    expect(err).toBeUndefined();
    expect(vm.isRunning()).toBe(false);
    // the sign's text, PLAYER expanded from the adapters
    expect(messages.length).toBe(1);
    expect(messages[0]).toBe("RED's house");
  });

  test("VM: unknown script and halt", () => {
    const vm = newVm({});
    expect(vm.start("NoSuchScript")).toBe(false);
    expect(vm.adapters.logs[1]).toBe("[game3] missing script NoSuchScript");
    vm.ctx.status = "running";
    vm.halt();
    expect(vm.ctx.status).toBe("shutdown");
    expect(vm.isRunning()).toBe(false);
  });

  test("checkflag + goto_if jump, setvar into a special var", () => {
    const vm = newVm({});
    const rows = bundle.scripts.EventScript_AccessHallOfFame;
    expect(rows[1]).toMatchObject({ op: "checkflag", flag: 2092 });
    vm.setPc("EventScript_AccessHallOfFame", 1);
    vm.ctx.status = "running";
    vm.ctx.mode = "bytecode";
    // checkflag 2092 (clear) -> comparisonResult 0
    vm.ctx.pc!.index = 2;
    Ops.dispatch(vm, rows[1]);
    expect(vm.ctx.comparisonResult).toBe(0);
    // goto_if cond 0 jumps
    vm.ctx.pc!.index = 3;
    Ops.dispatch(vm, rows[2]);
    expect(vm.ctx.pc!.listKey).toBe("g3:081a6a46");
    // setvar 0x8004 = 31
    Ops.dispatch(vm, rows[4]);
    expect(Flags.getVar(vm.store, vm.ctx, 0x8004)).toBe(31);
    expect(vm.store.vars[0x8004]).toBeUndefined();
  });

  test("trainerbattle hands off to the battle with the trainer's party", () => {
    const calls: any[] = [];
    const vm = newVm({
      onMessage: (t: any) => calls.push(["msg", t]),
      startTrainerBattle: (foe: any, done: any, opts: any) => {
        calls.push(["battle", foe, opts]);
        done("win");
      },
    });
    const rows = bundle.scripts["g3:08160571"];
    expect(rows[1]).toMatchObject({ op: "trainerbattle", trainer: 102, type: 0 });
    // the approach (trainer sight) already showed the intro, as Field does
    vm.ctx.trainerIntroShown = true;
    vm.startTalk("g3:08160571", 1, 2);
    for (let i = 0; i < 10 && vm.isRunning(); i++) vm.tick();
    const battle = calls.find((c) => c[0] === "battle");
    expect(battle).toBeDefined();
    const [, foe, opts] = battle;
    expect(opts.trainerId).toBe(102);
    expect(opts.earlyRival).toBe(false);
    expect(foe.trainerId ?? opts.trainerId).toBe(102);
    expect(len(foe.party)).toBeGreaterThan(0);
    expect(typeof opts.defeatText).toBe("object"); // the defeat text IR
    expect(vm.ctx.trainerBattleOpponentA).toBe(102);
    // won: trainer flag set, single battle halts the script
    expect(Flags.isTrainerDefeated(vm.store, 102)).toBe(true);
    expect(vm.isRunning()).toBe(false);
    // talking again: already beaten -> straight to the post-battle text
    const again: any[] = [];
    const vm2 = newVm({
      onMessage: (t: any) => again.push(t),
      startTrainerBattle: () => { throw new Error("must not battle twice"); },
    });
    vm2.store = vm.store;
    let err: unknown;
    try {
      vm2.startTalk("g3:08160571", 1, 2);
      for (let i = 0; i < 10 && vm2.isRunning(); i++) vm2.tick();
    } catch (e) { err = e; }
    if (err !== undefined) expect(err).toBeInstanceOf(NotPortedError);
    expect(vm2.ctx.data[0]).toBe("g3:08172315");
    expect(again.length).toBe(1);
  });

  test("stdscripts, multichoice, trainers lookups", () => {
    expect(Std.specialName("firered", 0x191)).toBe("DoSSAnneDepartureCutscene");
    expect(Std.specialName(null, 0xF001)).toBe("FadeScreen");
    expect(Std.SPECIAL_NAME_BY_ID[0xFB]).toBe("ShowTownMap");
    expect(Object.keys(Std.specialIds("firered")).length).toBe(447);

    expect(Multichoice.resolve(1)[0]).toEqual(seq("EEVEE", "FLAREON", "JOLTEON", "VAPOREON", "Quit looking."));

    const brock: any = Trainers.get(414);
    expect(brock.name).toBe("BROCK");
    expect(brock.className).toBe("LEADER");
    const foe = Trainers.foeFromId(414);
    expect(foe.party[1].species).toBe(74);
    expect(foe.party[1].level).toBe(12);
    expect(Trainers.getBattleMusicRole(414)).toEqual(["battleGymLeader", 296]);
  });

  test("natives: FRLG binding and a coin special", () => {
    Natives.ensureBound();
    expect(Natives.boundGame).toBe("firered");
    expect(typeof Natives.handlerFor("GetPokedexCount")).toBe("function");
    expect(typeof Natives.handlerFor("CheckAddCoins")).toBe("function");
    expect(Natives.handlerFor("DoTVShow")).toBeUndefined(); // tv is RSE only
    expect(Natives.specialName(0x15E)).toBe("CheckAddCoins");
    // CheckAddCoins: VAR_RESULT holds the coins, 0x8006 the amount to add
    const ctx = Ctx.new();
    ctx.specialVars[Ctx.VAR_RESULT] = 9990;
    ctx.specialVars[0x8006] = 10;
    expect(Natives.special(ctx, 0x15E, {})).toEqual([false, 0, true]);
    ctx.specialVars[Ctx.VAR_RESULT] = 9;
    expect(Natives.special(ctx, 0x15E, {})).toEqual([false, 1, true]);
  });

  test("collision std scripts and the encounter bind points", () => {
    expect(CollisionStd.scriptFor(0x93)).toBe("EventScript_PC");
    expect(CollisionStd.scriptFor(0x195)).toBe("EventScript_WallTownMap");
    expect(CollisionStd.scriptFor(null)).toBeUndefined();
    expect(CollisionStd.isCounter(0x90)).toBe(true);
    expect(Encounters.deps.Space).toBe(Space);
    expect(Encounters.deps.Flags).toBe(Flags);
    expect(Encounters.deps.rules!.frlg).toBeDefined();
  });
});
