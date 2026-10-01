// The Gen 2 overworld (voxelmon/game/gen2/world): a headless World on the real
// Gold import. It boots in the bedroom (PLAYERS_HOUSE_2F), walks down the
// stairs and out of the front door into NEW_BARK_TOWN, bumps a wall and an
// NPC, trips NEW_BARK_TOWN's west coord event, crosses the connection to
// ROUTE_29, watches a walker stay inside its radius, gets spotted by a
// ROUTE_30 trainer, and reads viewState().
//
// The script VM, the text box and the sound/music/clock modules are other
// areas' work (some still stubs), so the test hands World small fakes: a VM
// that records what it was asked to start, an input that holds a direction,
// and a stack that is always empty. Stub functions that are reached turn
// into no-ops for the test (only NotPortedError is swallowed). Skips without
// the Gold import (dist/voxelmon/gold/gen).

import { beforeAll, describe, expect, test } from "bun:test";
import { haveGoldGen, useGoldGen } from "../voxelmon/game/gen2/platform/data-node.ts";
import { seed } from "../voxelmon/game/gen2/platform/rng.ts";
import { NotPortedError } from "../voxelmon/game/gen2/notported.ts";
import { World } from "../voxelmon/game/gen2/world/World.ts";
import { Vm } from "../voxelmon/game/gen2/script/Vm.ts";
import * as Apricorns from "../voxelmon/game/gen2/core/Apricorns.ts";
import * as Boxes from "../voxelmon/game/gen2/core/Boxes.ts";
import * as Breeding from "../voxelmon/game/gen2/core/Breeding.ts";
import * as BugContest from "../voxelmon/game/gen2/core/BugContest.ts";
import * as CatchTutorial from "../voxelmon/game/gen2/core/CatchTutorial.ts";
import * as Clock from "../voxelmon/game/gen2/core/Clock.ts";
import * as Decorations from "../voxelmon/game/gen2/core/Decorations.ts";
import * as HallOfFame from "../voxelmon/game/gen2/core/HallOfFame.ts";
import * as Happiness from "../voxelmon/game/gen2/core/Happiness.ts";
import * as Mail from "../voxelmon/game/gen2/core/Mail.ts";
import * as MomShopping from "../voxelmon/game/gen2/core/MomShopping.ts";
import * as Phone from "../voxelmon/game/gen2/core/Phone.ts";
import * as PhoneRing from "../voxelmon/game/gen2/core/PhoneRing.ts";
import * as Pokerus from "../voxelmon/game/gen2/core/Pokerus.ts";
import * as Roamers from "../voxelmon/game/gen2/core/Roamers.ts";
import * as Save from "../voxelmon/game/gen2/core/Save.ts";
import * as Unown from "../voxelmon/game/gen2/core/Unown.ts";
import * as Battle from "../voxelmon/game/gen2/battle/Battle.ts";
import * as BattleMusic from "../voxelmon/game/gen2/battle/BattleMusic.ts";
import * as Catching from "../voxelmon/game/gen2/battle/Catching.ts";
import * as Encounter from "../voxelmon/game/gen2/battle/Encounter.ts";
import * as Mon from "../voxelmon/game/gen2/battle/Mon.ts";
import * as CallAsm from "../voxelmon/game/gen2/script/CallAsm.ts";
import * as Movement from "../voxelmon/game/gen2/script/Movement.ts";
import * as Bag from "../voxelmon/game/gen2/shared/inventory/Bag.ts";
import * as FixedStep from "../voxelmon/game/gen2/shared/core/FixedStep.ts";
import * as Music from "../voxelmon/game/gen2/shared/core/Music.ts";
import * as ScreenPosition from "../voxelmon/game/gen2/shared/core/ScreenPosition.ts";
import * as Sound from "../voxelmon/game/gen2/shared/core/Sound.ts";
import * as Gen2Compat from "../voxelmon/game/gen2/shared/mods/Gen2Compat.ts";
import * as Party from "../voxelmon/game/gen2/shared/pokemon/Party.ts";
import * as Sprites from "../voxelmon/game/gen2/shared/pokemon/Sprites.ts";
import * as Font from "../voxelmon/game/gen2/shared/render/Font.ts";
import * as Assets from "../voxelmon/game/gen2/shared/render/Assets.ts";
import * as GbcPalette from "../voxelmon/game/gen2/shared/render/GbcPalette.ts";
import * as ChoiceBox from "../voxelmon/game/gen2/shared/ui/ChoiceBox.ts";

/**
 * Other areas' modules the overworld reaches (some still stubs): any of their
 * functions that throws NotPortedError becomes a no-op returning undefined,
 * and a stub table member the World indexes (Save.PLAYER_STATES) is an empty
 * table. Ported functions run as they are.
 */
function inertStubs(): void {
  const mods: Record<string, any>[] = [
    Apricorns, Boxes, Breeding, BugContest, CatchTutorial, Clock, Decorations, HallOfFame,
    Happiness, Mail, MomShopping, Phone, PhoneRing, Pokerus, Roamers, Save, Unown, Battle,
    BattleMusic, Catching, Encounter, Mon, CallAsm, Movement, Bag, FixedStep, Music,
    ScreenPosition, Sound, Gen2Compat, Party, Sprites, Font, Assets, GbcPalette, ChoiceBox,
  ];
  for (const ns of mods) {
    for (const exp of Object.values(ns)) {
      if (!exp || (typeof exp !== "object" && typeof exp !== "function")) continue;
      for (const k of Object.getOwnPropertyNames(exp)) {
        if (k === "prototype" || k === "length" || k === "name") continue;
        const desc = Object.getOwnPropertyDescriptor(exp, k);
        if (!desc || !desc.writable || typeof desc.value !== "function") continue;
        const orig = desc.value;
        if ((orig as any).__inert) continue;
        const wrapped = function (this: unknown, ...args: unknown[]) {
          try {
            return orig.apply(this, args);
          } catch (e) {
            if (e instanceof NotPortedError) return undefined;
            throw e;
          }
        };
        (wrapped as any).__inert = true;
        (exp as any)[k] = wrapped;
      }
    }
  }
  const S = (Save as any).Save;
  if (S && S.PLAYER_STATES == null) S.PLAYER_STATES = {};
}

const HAVE = haveGoldGen();
const t = HAVE ? test : test.skip;

// ------------------------------------------------------------------ fakes

type Dir = "up" | "down" | "left" | "right";

class FakeInput {
  held: Dir | null = null;
  pressed = new Set<string>();
  isDown(k: string): boolean {
    return k === this.held;
  }
  wasPressed(k: string): boolean {
    return this.pressed.has(k);
  }
  step(): void {}
}

class FakeStack {
  items: any[] = [];
  top(): any {
    return this.items[this.items.length - 1];
  }
  push(s: any): void {
    this.items.push(s);
  }
  pop(): any {
    return this.items.pop();
  }
}

/** Records every script World starts; each one "finishes" at once. */
class FakeVm {
  started: any[] = [];
  callbacks: any[] = [];
  scripts: any;
  ctx: any = undefined;
  co: any = undefined;
  trainerObject: any = undefined;
  lastTalked: any = undefined;
  stringBuffer: any = undefined;
  curPhoneCaller: any = undefined;
  constructor(scripts: any) {
    this.scripts = scripts;
  }
  start(key: any): boolean {
    this.started.push(key);
    return true;
  }
  running(): boolean {
    return false;
  }
  update(): void {}
  runCallback(key: any): boolean {
    this.callbacks.push(key);
    return false;
  }
  restoreMem(): void {}
}

function makeGame(): any {
  const input = new FakeInput();
  return {
    data: {},
    save: {
      party: [],
      inventory: {},
      phoneContacts: {},
      version: "gold",
      playerName: "GOLD",
      money: 3000,
    },
    input,
    stack: new FakeStack(),
    stringBuffer: undefined,
  };
}

let vm: FakeVm;

function boot(): { world: any; game: any } {
  seed(12345);
  const game = makeGame();
  const world = World.new(game);
  world.clockHour = 12;
  world.clockDay = 1;
  const ok = world.load();
  if (!ok) throw new Error(`World.load failed: ${world.status}`);
  return { world, game };
}

/** One overworld frame, the way Game2:update drives it (Game2.lua:1237-1272). */
function tick(world: any, game: any): void {
  const top = game.stack.top();
  if (top && top.update) {
    top.update(1 / 60);
    return;
  }
  world.pollInput(game.input);
  if (game.input.wasPressed("a")) world.interact();
  world.step();
  game.input.pressed.clear();
}

function ticks(world: any, game: any, n: number): void {
  for (let i = 0; i < n; i++) tick(world, game);
}

/** Hold a direction until the player lands a step (or n frames pass). */
function stepDir(world: any, game: any, dir: Dir, max = 80): void {
  const mapId = world.map.id;
  // Hold until the step starts (a first press may only turn the player), then
  // let go: holding through the landing would chain the next step.
  game.input.held = dir;
  for (let i = 0; i < max; i++) {
    tick(world, game);
    if (world.map.id !== mapId || world.mapSetup || world.player.moving) break;
  }
  game.input.held = null;
  for (let i = 0; i < max; i++) {
    const p = world.player;
    if (world.map.id !== mapId || world.mapSetup) break;
    if (!p.moving) break;
    tick(world, game);
  }
}

/** Tick until the map setup chain (fades, load) is over. */
function settle(world: any, game: any, max = 400): void {
  for (let i = 0; i < max; i++) {
    if (!world.mapSetup && !world.player.moving && !world.fade) return;
    tick(world, game);
  }
}

const DELTA: Record<Dir, [number, number]> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

function blockedByNpc(world: any, x: number, y: number): boolean {
  return (world.npcs ?? []).some((n: any) => n.covers(x, y) || (n.moving && n.targetX === x && n.targetY === y));
}

/** Shortest path on the current map by walkability (and NPCs), BFS. */
function path(world: any, gx: number, gy: number, allowGoal = true): Dir[] | null {
  const map = world.map;
  const sx = world.player.cellX;
  const sy = world.player.cellY;
  const key = (x: number, y: number) => y * 4096 + x;
  const prev = new globalThis.Map<number, [number, Dir]>();
  const seen = new Set([key(sx, sy)]);
  const q: [number, number][] = [[sx, sy]];
  while (q.length) {
    const [x, y] = q.shift()!;
    if (x === gx && y === gy) {
      const out: Dir[] = [];
      let k = key(x, y);
      while (prev.has(k)) {
        const [pk, d] = prev.get(k)!;
        out.unshift(d);
        k = pk;
      }
      return out;
    }
    for (const d of ["up", "down", "left", "right"] as Dir[]) {
      const [dx, dy] = DELTA[d];
      const nx = x + dx;
      const ny = y + dy;
      const nk = key(nx, ny);
      if (seen.has(nk)) continue;
      const goal = nx === gx && ny === gy;
      if (!map.inBounds(nx, ny)) continue;
      if (!map.isWalkable(nx, ny)) continue;
      if (!map.stepPermitted(x, y, d)) continue;
      if (blockedByNpc(world, nx, ny)) continue;
      // don't route over warps other than the goal
      if (!goal && map.warpAt(nx, ny)) continue;
      if (goal && !allowGoal) continue;
      seen.add(nk);
      prev.set(nk, [key(x, y), d]);
      q.push([nx, ny]);
    }
  }
  return null;
}

/** Walk to (gx, gy), replanning each step (walkers move). */
function walkTo(world: any, game: any, gx: number, gy: number): void {
  const mapId = world.map.id;
  for (let guard = 0; guard < 200; guard++) {
    if (world.map.id !== mapId) return;
    const p = world.player;
    if (p.cellX === gx && p.cellY === gy) return;
    const route = path(world, gx, gy);
    if (!route || route.length === 0) {
      ticks(world, game, 8);
      continue;
    }
    // A turn costs a press of its own (turn-in-place) -- stepDir handles it.
    stepDir(world, game, route[0]!);
  }
  throw new Error(`walkTo(${gx},${gy}) on ${mapId} did not arrive: at ${world.player.cellX},${world.player.cellY}`);
}

// ------------------------------------------------------------------ tests

describe("gen2 world (real Gold data)", () => {
  let world: any;
  let game: any;

  beforeAll(() => {
    if (!HAVE) return;
    useGoldGen();
    inertStubs();
    (Vm as any).new = (scripts: any) => {
      vm = new FakeVm(scripts);
      return vm;
    };
    ({ world, game } = boot());
    settle(world, game);
  });

  t("boots in the bedroom at SPAWN_HOME", () => {
    expect(world.map.id).toBe("PLAYERS_HOUSE_2F");
    expect([world.player.cellX, world.player.cellY]).toEqual([3, 3]);
    expect(world.player.facing).toBe("down");
  });

  t("walks down the stairs to PLAYERS_HOUSE_1F", () => {
    const stairs = world.map.warps[0];
    expect(stairs.destMap).toBe("PLAYERS_HOUSE_1F");
    walkTo(world, game, stairs.x, stairs.y);
    settle(world, game);
    expect(world.map.id).toBe("PLAYERS_HOUSE_1F");
    // arrives on 1F's warp 3 (the stairs' destWarp), the cart's numbering
    const w = world.map.warps[stairs.destWarp - 1];
    expect(Math.abs(world.player.cellX - w.x) + Math.abs(world.player.cellY - w.y)).toBeLessThanOrEqual(1);
  });

  t("walks out of the front door into NEW_BARK_TOWN", () => {
    const door = world.map.warps.find((w: any) => w.destMap === "NEW_BARK_TOWN");
    walkTo(world, game, door.x, door.y);
    // the front door is a carpet (COLL_WARP_CARPET_DOWN): it wants a press its way
    expect(world.map.cellCollision(door.x, door.y)).toBe(0x70);
    game.input.held = "down";
    ticks(world, game, 4);
    game.input.held = null;
    settle(world, game);
    // the door walks the player down off it (HI_NYBBLE_WARPS .warps)
    ticks(world, game, 30);
    settle(world, game);
    expect(world.map.id).toBe("NEW_BARK_TOWN");
    // the house door is NEW_BARK_TOWN's warp 2 (13,5); a door walks you down off it
    const w = world.map.warps[1];
    expect(world.player.cellX).toBe(w.x);
    expect(world.player.cellY).toBeGreaterThanOrEqual(w.y);
  });

  t("bumps a wall without moving", () => {
    // the cell east of the house door (14,6) has the house wall above it (14,5)
    expect(world.map.isWalkable(14, 5)).toBe(false);
    expect(world.map.warpAt(14, 5)).toBeUndefined();
    walkTo(world, game, 14, 6);
    const dir: Dir = "up";
    const p = world.player;
    const [x0, y0] = [p.cellX, p.cellY];
    game.input.held = dir;
    ticks(world, game, 40);
    game.input.held = null;
    ticks(world, game, 2);
    expect([world.player.cellX, world.player.cellY]).toEqual([x0, y0]);
    expect(world.player.facing).toBe(dir);
    expect(world.map.id).toBe("NEW_BARK_TOWN");
  });

  t("bumps an NPC without moving", () => {
    // the TEACHER (object 1) spins in place at (6,8): SPINRANDOM_SLOW never walks
    const teacher = world.npcs.find((n: any) => n.def.index === 1);
    expect(teacher).toBeDefined();
    expect([teacher.cellX, teacher.cellY]).toEqual([6, 8]);
    walkTo(world, game, 7, 8);
    const [x0, y0] = [world.player.cellX, world.player.cellY];
    game.input.held = "left";
    ticks(world, game, 40);
    game.input.held = null;
    ticks(world, game, 2);
    expect([world.player.cellX, world.player.cellY]).toEqual([x0, y0]);
    expect(world.player.facing).toBe("left");
    expect([teacher.cellX, teacher.cellY]).toEqual([6, 8]);
  });

  t("the west coord event (scene 0) starts its script", () => {
    const ev = world.map.def.coordEvents.find((e: any) => e.x === 1 && e.y === 8);
    expect(ev).toBeDefined();
    const before = vm.started.length;
    walkTo(world, game, 1, 8);
    ticks(world, game, 2);
    expect(vm.started.slice(before)).toContain(ev.scriptKey);
  });

  t("crosses the west connection into ROUTE_29", () => {
    walkTo(world, game, 0, 8);
    stepDir(world, game, "left");
    settle(world, game);
    expect(world.map.id).toBe("ROUTE_29");
    // lands on Route 29's east edge, same row (offset 0)
    expect(world.player.cellX).toBe(world.map.widthCells - 1);
    expect(world.player.cellY).toBe(8);
  });

  t("a walker stays inside its radius", () => {
    // Route 29's YOUNGSTER (object 2) walks up and down, radius y 1
    const kid = world.npcs.find((n: any) => n.def.index === 2);
    expect(kid).toBeDefined();
    expect(kid.kind).toBe("walk");
    let moved = false;
    for (let i = 0; i < 3000; i++) {
      tick(world, game);
      expect(Math.abs(kid.cellX - kid.homeX)).toBeLessThanOrEqual(kid.radiusX);
      expect(Math.abs(kid.cellY - kid.homeY)).toBeLessThanOrEqual(kid.radiusY);
      if (kid.cellY !== kid.homeY) moved = true;
    }
    expect(moved).toBe(true);
  });

  t("a ROUTE_30 trainer sees the player", () => {
    game.save.party = [{ species: "CYNDAQUIL", level: 5, hp: 20, maxHp: 20 }];
    // `wildoff` (STATUSFLAGS_NO_WILD_ENCOUNTERS_F): the walk crosses grass,
    // and a wild battle is not what this test is about
    world.noWildEncounters = true;
    world.setMap("ROUTE_30", 5, 20, "down");
    settle(world, game);
    expect(world.map.id).toBe("ROUTE_30");
    // Bug Catcher Don (object 4) spins (SPINRANDOM_FAST) at (4,7), sight 3:
    // stand two cells below him and wait for him to turn and look down.
    const don = world.npcs.find((n: any) => n.def.index === 4);
    expect(don?.def.trainer).toBeDefined();
    expect(don.kind).toBe("spin");
    const before = vm.started.length;
    walkTo(world, game, 4, 9);
    for (let i = 0; i < 1200 && !world.trainerNpc; i++) tick(world, game);
    const started = vm.started.slice(before);
    // SEEN_BY_TRAINER_SCRIPT (World.lua:8336) opens on loadtemptrainer
    const seen = started.find((s: any) => Array.isArray(s) && s[0]?.op === "loadtemptrainer");
    expect(seen).toBeDefined();
    expect(world.trainerNpc).toBe(don);
    expect(don.facing).toBe("down");
    // Trainers.sees: two cells, along the trainer's own facing
    expect(world.trainerSight).toEqual({ distance: 2, dir: "down" });
  });

  t("viewState() describes the frame", () => {
    const v = world.viewState();
    expect(v.ready).toBe(true);
    expect(v.map.id).toBe("ROUTE_30");
    expect([v.map.group, v.map.number]).toEqual([world.map.def.group, world.map.def.map]);
    // the player: an ActorView at the player's cell, Chris's sheet
    const pv = v.player.view;
    expect([pv.cellX, pv.cellY]).toEqual([4, 9]);
    expect([pv.px, pv.py]).toEqual([4 * 16, 9 * 16]);
    expect(pv.spriteId).toBe("SPRITE_CHRIS");
    expect(pv.gfx).toBe("sprites/chris");
    expect(v.player.visible).toBe(true);
    // the spotted trainer is among the actors, facing the player
    const donView = v.actors.find((a: any) => a.kind === "npc" && a.onMap && a.view.cellX === 4 && a.view.cellY === 7);
    expect(donView?.view.facing).toBe("down");
    expect(donView?.view.spriteId).toBe("SPRITE_BUG_CATCHER");
    expect(v.actors.filter((a: any) => a.kind === "player").length).toBe(1);
    // Route 30 connects north to Route 31 and south to Cherrygrove
    const ids = v.neighbors.map((n: any) => n.id);
    expect(ids).toContain("CHERRYGROVE_CITY");
    // camera follows the player (Camera.lua: px - (160/2 - 16), py - (144/2 - 8))
    expect(v.camera).toEqual({ x: 4 * 16 - 64, y: 9 * 16 - 64, viewW: 160, viewH: 144 });
    expect(v.palette.daytime).toBeDefined();
    expect(v.fade).toBeUndefined();
    expect(typeof v.ui.textbox).toBe("boolean");
    // read-only: a second call gives the same answer
    expect(world.viewState().player.view).toEqual(pv);
  });
});
