// The Gen 2 script engine (voxelmon/game/gen2/script, a port of gen1recomp's
// src/script/gen2 at bdfac727): the opcode table against the importer's, the
// movement decoder on real movement streams, the callasm site table, and the
// VM running the Gold import's own scripts headlessly against a small fake
// world that records what the scripts ask for. The real-data parts need
// dist/voxelmon/gold/gen (run the Gold import) and skip without it.

import { afterEach, describe, expect, test } from "bun:test";
import { haveGoldGen, useGoldGen } from "../voxelmon/game/gen2/platform/data-node.ts";
import { loadGenerated } from "../voxelmon/game/gen2/platform/data.ts";
import { CallAsm } from "../voxelmon/game/gen2/script/CallAsm.ts";
import { Movement } from "../voxelmon/game/gen2/script/Movement.ts";
import { Opcodes } from "../voxelmon/game/gen2/script/Opcodes.ts";
import { Specials } from "../voxelmon/game/gen2/script/Specials.ts";
import { Coroutine, type Script, Vm } from "../voxelmon/game/gen2/script/Vm.ts";
import { NUM_EVENT_COMMANDS, OPCODES, TERMINATORS } from "../voxelmon/import/gen2/opcodes.ts";

const HAVE = haveGoldGen();
const gold = HAVE ? describe : describe.skip;
if (HAVE) useGoldGen();

// ---- a fake world ---------------------------------------------------------------

class FakeEvents {
  flags = new Map<number, boolean>();
  get(flag: number): boolean {
    return this.flags.get(flag) ?? false;
  }
  set(flag: number, value: boolean): void {
    this.flags.set(flag, value);
  }
}

type Entry = [string, ...any[]];

/**
 * Records every hook the VM calls. Blocking hooks queue their callback
 * instead of answering on the spot, and drive() drains the queue, so a long
 * script does not recurse through resume().
 */
class FakeWorld {
  log: Entry[] = [];
  queue: (() => void)[] = [];
  yes: boolean[] = [];
  events = new FakeEvents();
  frames = 0;
  timeOfDay = 1;
  party: any[] = [];
  engineFlags = new Map<number, boolean>();

  hooks(extra: Record<string, any> = {}): Record<string, any> {
    const log = (...e: Entry) => { this.log.push(e); };
    return {
      specialOrder: HAVE ? (loadGenerated("constants") as any).specialOrder : [],
      showText: (text: string, onDone: () => void, stay: boolean) => {
        log("text", text, stay);
        this.queue.push(onDone);
      },
      yesorno: (cb: (yes: boolean) => void) => {
        const answer = this.yes.length > 0 ? this.yes.shift()! : true;
        log("yesorno", answer);
        this.queue.push(() => cb(answer));
      },
      applyMovement: (object: number, bytes: number[], cb: () => void) => {
        log("move", object, bytes);
        this.queue.push(cb);
      },
      turnObject: (object: number, facing: string) => log("turn", object, facing),
      facePlayer: () => log("faceplayer"),
      playMusic: (id: number) => log("music", id),
      playSound: (id: number) => log("sound", id),
      follow: (a: number, b: number) => log("follow", a, b),
      stopFollow: () => log("stopfollow"),
      showEmote: (emote: number, object: number, frames: number) => log("emote", emote, object, frames),
      setScene: (scene: number) => log("scene", scene),
      addCell: (phone: number) => log("addcell", phone),
      getTimeOfDay: () => this.timeOfDay,
      getEngineFlag: (flag: number) => this.engineFlags.get(flag) ?? false,
      setEngineFlag: (flag: number, value: boolean) => {
        this.engineFlags.set(flag, value);
        log("engineflag", flag, value);
      },
      healParty: () => log("healparty"),
      specials: {
        party: () => this.party,
        restartMapMusic: () => log("restartmapmusic"),
      },
      ...extra,
    };
  }

  /** Run the VM until it goes idle (or maxSteps), one callback or frame a step. */
  drive(vm: Vm, maxSteps = 20000): number {
    let steps = 0;
    while (vm.busy && steps++ < maxSteps) {
      const cb = this.queue.shift();
      if (cb) cb();
      else {
        this.frames++;
        vm.update();
      }
    }
    return steps;
  }

  texts(): string[] {
    return this.log.filter((e) => e[0] === "text").map((e) => e[1] as string);
  }
}

function goldVm(world: FakeWorld, extra: Record<string, any> = {}): Vm {
  return Vm.new(loadGenerated("scripts"), loadGenerated("text"), world.events,
    world.hooks({ eventTables: loadGenerated("events"), ...extra }));
}

function text(key: string): string {
  return (loadGenerated("text") as Record<string, string>)[key]!;
}

// ---- pure modules ---------------------------------------------------------------

describe("Opcodes", () => {
  test("the Gold table is the importer's, byte for byte", () => {
    for (let byte = 0; byte < Opcodes.NUM_EVENT_COMMANDS; byte++) {
      expect(Opcodes[byte]).toEqual(OPCODES.get(byte)!);
    }
    expect(Opcodes.NUM_EVENT_COMMANDS).toBe(NUM_EVENT_COMMANDS);
    expect(new Set(Object.keys(Opcodes.TERMINATORS).filter((k) => k !== "farjumptext")))
      .toEqual(new Set([...TERMINATORS].filter((k) => k !== "farjumptext")));
  });

  test("swarm is a bare map_id in Gold and flag + map_id in Crystal", () => {
    expect(Opcodes[0x9e]).toEqual({ name: "swarm", size: 2 });
    const crystal = Opcodes.forEdition("crystal");
    expect(crystal[0xa0]).toEqual({ name: "swarm", size: 3 });
    expect(crystal[0x52]!.name).toBe("farjumptext");
    expect(crystal[0x51]!.name).toBe("jumptextfaceplayer");
    expect(crystal.NUM_EVENT_COMMANDS).toBe(0xaa);
    expect(Opcodes.forEdition("gold")).toBe(Opcodes);
    expect(Opcodes.key(0x48, 0x406f)).toBe("48:406f");
    expect(Opcodes.MOD_COMMAND).toBe("modcommand");
  });
});

describe("Movement", () => {
  test("decodes each byte family", () => {
    expect(Movement.decodeByte(0x47)).toEqual({ kind: "end" });
    expect(Movement.decodeByte(0x03)).toEqual({ kind: "turn", dir: "right" });
    expect(Movement.decodeByte(0x0e)).toEqual({ kind: "step", dir: "left" });
    expect(Movement.decodeByte(0x25)).toEqual({ kind: "step", dir: "up", spin: true });
    expect(Movement.decodeByte(0x31)).toEqual({ kind: "jump", dir: "up" });
    expect(Movement.decodeByte(0x39)).toEqual({ kind: "sliding", on: true });
    expect(Movement.decodeByte(0x3b)).toEqual({ kind: "fixfacing", fixed: true });
    expect(Movement.decodeByte(0x3e)).toEqual({ kind: "sleep", frames: 16 });
    expect(Movement.decodeByte(0x46)).toEqual({ kind: "sleep", frames: 144 });
    expect(Movement.decodeByte(0x4c)).toEqual({ kind: "teleport", mode: "from", frames: 32 });
    expect(Movement.decodeByte(0x4d)).toEqual({ kind: "teleport", mode: "to", frames: 48 });
    expect(Movement.decodeByte(0x56)).toEqual({ kind: "treeshake", frames: 24 });
    expect(Movement.decodeByte(0x4e)).toEqual({ kind: "skyfall", frames: 32 });
    expect(Movement.decodeByte(0x59)).toEqual({ kind: "skyfalltop", frames: 16 });
    expect(Movement.decodeByte(0x5f)).toEqual({ kind: "nop" });
  });

  test("the curves and the stream builders", () => {
    expect(Movement.jumpYOffset(1, 16)).toBe(-4);
    expect(Movement.jumpYOffset(16, 16)).toBe(0);
    expect(Movement.jumpYOffset(7, 16)).toBe(-12);
    expect(Movement.teleportYOffset(0)).toBe(-96);
    expect(Movement.teleportYOffset(16)).toBe(0);
    expect(Movement.treeShakeIndex(3)).toBe(1);
    expect(Movement.treeShakeIndex(15)).toBe(0);
    expect(Movement.stepByte("right")).toBe(0x0f);
    expect(Movement.forcedMovementBytes("up")).toEqual([0x4f, 16, 0x25, 0x4f, 16, 0x01, 0x47]);
    expect(Movement.digOutBytes()).toEqual([0x4f, 32, 0x3d, 0x47]);
    expect(Movement.digReturnBytes()).toEqual([0x3c, 0x58, 32, 0x47]);
  });
});

describe("CallAsm", () => {
  test("dispatches a real site by bank:addr and leaves wScriptVar alone for stubs", () => {
    const ctx = { curFruitTree: 3, fruitTreePicked: (tree: number) => tree === 3 };
    expect(CallAsm.nameFor(undefined, 0x11, 0x4055)).toBe("CheckFruitTree");
    expect(CallAsm.dispatch(ctx, undefined, 0x11, 0x4055)).toBe(1);
    expect(CallAsm.dispatch({ ...ctx, curFruitTree: 4 }, undefined, 0x11, 0x4055)).toBe(0);
    // HasRockSmash is inverted: 1 when nobody knows it.
    expect(CallAsm.run({ partyMoveUser: () => undefined }, "HasRockSmash")).toBe(1);
    expect(CallAsm.run({}, "TryReceiveItem")).toBeUndefined();
    // A mis-walked hiddenitem operand resolves to nothing.
    expect(CallAsm.nameFor(undefined, 0x45, 0x697a)).toBeUndefined();
    expect(CallAsm.dispatch({}, undefined, 0x45, 0x697a)).toBeUndefined();
    for (const name of Object.keys(CallAsm.STUBS)) expect(CallAsm.HANDLERS[name]).toBeUndefined();
  });
});

describe("Vm without data", () => {
  test("coroutine shim answers like Lua's", () => {
    const co = Coroutine.create(function* (): Script<void> {
      expect(Coroutine.running()).not.toBeNull();
      const v = yield { kind: "a" };
      expect(v).toBe(7);
    });
    expect(co.status()).toBe("suspended");
    expect(co.resume()).toEqual([true, { kind: "a" }]);
    expect(Coroutine.running()).toBeNull();
    expect(co.resume(7)).toEqual([true, undefined]);
    expect(co.status()).toBe("dead");
    expect(co.resume()[0]).toBe(false);
  });

  test("addval wraps, ifgreater/ifless polarity, checkmoney's HAVE_* ladder", () => {
    const world = new FakeWorld();
    const scripts = {
      main: [
        { op: "setval", args: [0] },
        { op: "addval", args: [255] },
        { op: "ifgreater", value: 254, script: "gt" },
        { op: "end" },
      ],
      gt: [
        { op: "checkmoney", args: [0, 0, 0x01, 0x00] },
        { op: "ifequal", value: 2, script: "less" },
        { op: "end" },
      ],
      less: [{ op: "rawtext", text: "broke" }, { op: "end" }],
    };
    const vm = Vm.new(scripts, {}, world.events, world.hooks({ getMoney: () => 100 }));
    vm.start("main");
    world.drive(vm);
    expect(world.texts()).toEqual(["broke"]);
    expect(vm.scriptVar).toBe(2);
    expect(vm.unknownOps).toEqual({});
  });

  test("an unknown op is recorded once and skipped; a whiteout unwinds nested calls", () => {
    const world = new FakeWorld();
    const scripts = {
      main: [{ op: "bogus" }, { op: "bogus" }, { op: "scall", script: "fight" }, { op: "setevent", event: 9 }],
      fight: [{ op: "startbattle" }, { op: "reloadmapafterbattle" }, { op: "setevent", event: 8 }],
    };
    const vm = Vm.new(scripts, {}, world.events, world.hooks({
      startBattle: (_t: any, _w: any, cb: (o: string) => void) => world.queue.push(() => cb("lose")),
      reloadMap: (setup: boolean) => world.log.push(["reload", setup]),
    }));
    vm.start("main");
    world.drive(vm);
    expect(vm.unknownOps).toEqual({ bogus: 2 });
    expect(world.events.get(8)).toBe(false);
    expect(world.events.get(9)).toBe(false);
    expect(world.log).toContainEqual(["reload", true]);
    expect(vm.busy).toBe(false);
  });

  test("a mod row dispatches through the commands registry and may block", () => {
    const world = new FakeWorld();
    const seen: any[] = [];
    Vm.setCommands({
      "mymod:say": function* (ctx: any, word: string): Script<void> {
        seen.push([ctx.generation, word]);
        yield* ctx.vm.showRaw(word);
      },
    });
    try {
      const vm = Vm.new({ main: [["mymod:say", "hi"], { op: "modcommand", verb: "mymod:nope" }] },
        {}, world.events, world.hooks());
      vm.start("main");
      world.drive(vm);
      expect(seen).toEqual([[2, "hi"]]);
      expect(world.texts()).toEqual(["hi"]);
      expect(vm.unknownVerbs).toEqual({ "mymod:nope": 1 });
    } finally {
      Vm.setCommands(undefined);
    }
  });

  test("readmem / addval / writemem add up in the VM's own store and survive a save", () => {
    const world = new FakeWorld();
    const scripts = {
      main: [
        { op: "readmem", args: [0xa8, 0xd6] },
        { op: "addval", args: [1] },
        { op: "writemem", args: [0xa8, 0xd6] },
      ],
    };
    const vm = Vm.new(scripts, {}, world.events, world.hooks());
    vm.start("main");
    vm.start("main");
    expect(vm.serializeMem()).toEqual({ 0xd6a8: 2 });
    const again = Vm.new(scripts, {}, world.events, world.hooks()).restoreMem({ "54952": "2" });
    expect(again.mem[0xd6a8]).toBe(2);
  });
});

// ---- the Gold import's own scripts --------------------------------------------------

gold("Vm on the Gold import", () => {
  afterEach(() => {
    Vm.SPECIALS = Specials.ALL;
  });

  test("NEW_BARK_TOWN's callback runs nested and sets its flags", () => {
    const world = new FakeWorld();
    const vm = goldVm(world);
    const maps = loadGenerated("maps") as any;
    const cb = maps.NEW_BARK_TOWN.callbacks[0];
    expect(cb.callback).toBe("MAPCALLBACK_NEWMAP");
    world.events.set(118, true);
    expect(vm.runCallback(cb.scriptKey)).toBe(true);
    expect(world.engineFlags.get(64)).toBe(true); // setflag ENGINE_FLYPOINT_NEW_BARK
    expect(world.events.get(118)).toBe(false);
    expect(vm.busy).toBe(false);
    expect(vm.blockedCallbacks).toEqual({});
  });

  test("NEW_BARK_TOWN's teacher stops the player: text, turns, movement, follow", () => {
    const world = new FakeWorld();
    const vm = goldVm(world);
    const maps = loadGenerated("maps") as any;
    const coord = maps.NEW_BARK_TOWN.coordEvents[0];
    expect(vm.start(coord.scriptKey)).toBe(true);
    world.drive(vm);
    expect(vm.busy).toBe(false);
    const scripts = loadGenerated("scripts") as any;
    expect(world.log).toEqual([
      ["music", 78],
      ["turn", 2, "left"],
      ["text", text("48:413e"), false],
      ["turn", 0, "right"],
      ["move", 2, scripts.movements["48:40de"]],
      ["text", text("48:4148"), false],
      ["follow", 2, 0],
      ["move", 2, scripts.movements["48:40ea"]],
      ["stopfollow"],
      ["text", text("48:4168"), false],
      ["restartmapmusic"], // special RestartMapMusic
    ]);
    expect(world.texts()[0]).toContain("Wait, {PLAYER}!");
    expect(vm.lastSpecial).toBe("RestartMapMusic");
    expect(vm.unknownOps).toEqual({});
  });

  test("the New Bark fisher is one jumptextfaceplayer", () => {
    const world = new FakeWorld();
    const vm = goldVm(world);
    const obj = (loadGenerated("maps") as any).NEW_BARK_TOWN.objects[1];
    vm.lastTalked = obj.index;
    vm.start(obj.scriptKey);
    world.drive(vm);
    expect(world.log).toEqual([["faceplayer"], ["text", text("48:427e"), false]]);
    expect(vm.lastTextKey).toBe("48:427e");
  });

  test("PLAYERS_HOUSE_1F Mom's talk script branches on the story flags", () => {
    const obj = (loadGenerated("maps") as any).PLAYERS_HOUSE_1F.objects[0];
    expect(obj.sprite).toBe("SPRITE_MOM");
    const talk = (flags: number[]) => {
      const world = new FakeWorld();
      for (const f of flags) world.events.set(f, true);
      const vm = goldVm(world);
      vm.start(obj.scriptKey);
      world.drive(vm);
      return world.texts();
    };
    expect(talk([])).toEqual([text("60:59ca")]);
    expect(talk([26])).toEqual([text("60:59fa")]);
    expect(talk([118])).toEqual([text("60:5a6c")]);
  });

  test("PLAYERS_HOUSE_1F Mom's scene: sdefer, emote hold, getstring, a std script, the clock ladder", () => {
    const world = new FakeWorld();
    const specialsRun: string[] = [];
    const record = (name: string) => (vm: Vm) => {
      specialsRun.push(name);
      if (name === "RestartMapMusic") return Specials.ALL[name]!(vm);
      return undefined;
    };
    Vm.SPECIALS = {
      ...Specials.ALL,
      SetDayOfWeek: record("SetDayOfWeek"),
      InitialSetDSTFlag: record("InitialSetDSTFlag"),
      InitialClearDSTFlag: record("InitialClearDSTFlag"),
      RestartMapMusic: record("RestartMapMusic"),
    };
    // DST? yes -> "is that OK" yes, and the clock ladder closes.
    world.yes = [true, true, true];
    const vm = goldVm(world);
    const scene = (loadGenerated("maps") as any).PLAYERS_HOUSE_1F.sceneScripts["0"];
    expect(vm.start(scene.scriptKey)).toBe(true);
    world.drive(vm);
    expect(vm.busy).toBe(false);
    const scripts = loadGenerated("scripts") as any;
    const kinds = world.log.map((e) => e[0]);
    // The deferred script is what ran: player walks first, Mom's ! bubble.
    expect(world.log[0]).toEqual(["move", 0, scripts.movements["60:570f"]]);
    expect(world.log).toContainEqual(["emote", 0, 2, 15]);
    // getstring -> the received line's {STRBUF}.
    const received = world.texts().find((t) => t.includes("GEAR"));
    expect(received).toBeDefined();
    expect(received).not.toContain("{STRBUF}");
    expect(world.engineFlags.get(4)).toBe(true);
    expect(world.engineFlags.get(2)).toBe(true);
    expect(world.log).toContainEqual(["addcell", 1]);
    expect(world.log).toContainEqual(["scene", 1]);
    expect(world.events.get(1735)).toBe(true);
    expect(world.events.get(1736)).toBe(false);
    expect(specialsRun).toEqual(["SetDayOfWeek", "InitialSetDSTFlag", "RestartMapMusic"]);
    expect(kinds.filter((k) => k === "yesorno").length).toBe(3);
    expect(vm.unknownOps).toEqual({});
    expect(vm.stringBuffer).toContain("GEAR");
    // ReceiveItemScript's two waitsfx and the emote's 30-frame hold ran on
    // frames, not callbacks.
    expect(world.frames).toBeGreaterThanOrEqual(30);
  });

  test("the Pokecenter nurse (a std script) by time of day, with the heal", () => {
    const std = loadGenerated("std_scripts") as any;
    const key = std.scripts.PokecenterNurseScript.key;
    const run = (time: number) => {
      const world = new FakeWorld();
      world.timeOfDay = time;
      Vm.SPECIALS = {
        ...Specials.ALL,
        HealMachineAnim: () => { world.log.push(["healanim"]); },
        CheckPokerus: (vm: Vm) => { vm.scriptVar = 0; },
      };
      const vm = goldVm(world);
      vm.lastTalked = 1;
      vm.start(key);
      world.drive(vm);
      expect(vm.busy).toBe(false);
      expect(vm.unknownOps).toEqual({});
      return world;
    };
    const day = run(1);
    expect(day.texts()[0]).toBe(text("40:4640"));
    expect(day.texts()[1]).toBe(text("40:469f"));
    // The question box stays up under the YES/NO prompt.
    expect(day.log.find((e) => e[0] === "text" && e[1] === text("40:469f"))![2]).toBe(true);
    expect(day.log).toContainEqual(["healparty"]);
    expect(day.log).toContainEqual(["healanim"]);
    expect(day.log).toContainEqual(["turn", 1, "left"]); // turnobject LAST_TALKED
    expect(day.log).toContainEqual(["restartmapmusic"]);
    // pause 20 + 10 + 30 + 10 + 20 + 10 + 10, doubled by Script_pause.
    expect(day.frames).toBeGreaterThanOrEqual(220);
    expect(run(0).texts()[0]).toBe(text("40:4615"));
    expect(run(2).texts()[0]).toBe(text("40:4664"));
    // checktime is FALSE for every mask in darkness: straight to the question.
    expect(run(3).texts()[0]).toBe(text("40:469f"));
  });

  test("a special with no world dependency: the party searches and a stub", () => {
    const world = new FakeWorld();
    world.party = [{ species: "CYNDAQUIL", level: 12, happiness: 70 }];
    const order = (loadGenerated("constants") as any).specialOrder as string[];
    const id = (name: string) => order.indexOf(name);
    const scripts = {
      above: [{ op: "setval", args: [10] }, { op: "special", id: id("FindPartyMonAboveLevel") }],
      above2: [{ op: "setval", args: [13] }, { op: "special", id: id("FindPartyMonAboveLevel") }],
      happy: [{ op: "setval", args: [70] }, { op: "special", id: id("FindPartyMonAtLeastThatHappy") }],
      gift: [{ op: "setval", args: [9] }, { op: "special", id: id("CheckMysteryGift") }],
      link: [{ op: "setval", args: [9] }, { op: "special", id: id("CloseLink") }],
    };
    const vm = Vm.new(scripts, {}, world.events, world.hooks());
    const answer = (key: string) => {
      vm.start(key);
      world.drive(vm);
      return vm.scriptVar;
    };
    expect(answer("above")).toBe(1);
    expect(answer("above2")).toBe(0);
    expect(answer("happy")).toBe(1);
    expect(answer("gift")).toBe(0); // stub: no infrared, no gift
    expect(answer("link")).toBe(9); // stub that writes no wScriptVar
    expect(Specials.STUB_REASONS.CheckMysteryGift).toContain("Mystery Gift");
  });

  test("the movement decoder on every movement stream in the import", () => {
    const movements = (loadGenerated("scripts") as any).movements as Record<string, number[]>;
    const keys = Object.keys(movements);
    expect(keys.length).toBeGreaterThan(100);
    let ended = 0;
    for (const key of keys) {
      const acts = movements[key]!.map((b) => Movement.decodeByte(b));
      if (acts.some((a) => a.kind === "end")) ended++;
    }
    expect(ended / keys.length).toBeGreaterThan(0.95);
    // Elm's aide / the New Bark teacher's stream: four steps left, step_end.
    expect(movements["48:40de"]!.map((b) => Movement.decodeByte(b))).toEqual([
      { kind: "step", dir: "left" }, { kind: "step", dir: "left" },
      { kind: "step", dir: "left" }, { kind: "step", dir: "left" }, { kind: "end" },
    ]);
    expect(movements["48:40ea"]!.map((b) => Movement.decodeByte(b)).slice(4)).toEqual([
      { kind: "turn", dir: "left" }, { kind: "end" },
    ]);
  });

  test("every extracted script runs headless with no unimplemented opcode", () => {
    const scripts = loadGenerated("scripts") as Record<string, any>;
    const unknown: Record<string, number> = {};
    const noop = () => undefined;
    Vm.SPECIALS = new Proxy({}, { get: () => noop }) as any;
    let ran = 0;
    for (const key of Object.keys(scripts)) {
      if (key === "generation" || key === "movements") continue;
      const world = new FakeWorld();
      world.yes = [true, false, true, false, true];
      const vm = goldVm(world);
      vm.start(key);
      world.drive(vm, 3000);
      ran++;
      for (const [op, n] of Object.entries(vm.unknownOps)) unknown[op] = (unknown[op] ?? 0) + n;
    }
    expect(ran).toBeGreaterThan(3000);
    expect(unknown).toEqual({});
  });
});
