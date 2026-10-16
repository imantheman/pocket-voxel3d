// VISIBLE WILD on the Gold engine (voxelmon/game/gen2/world/VisibleWild.ts):
// where the mons stand, how many, what they are at each time of day, their
// shiny odds, the battle a touch starts, the random encounters it stops, and
// the WILD ENCOUNTERS cheat's say over it -- against the real Gold data.
// Skips without the import.

import { afterAll, describe, expect, test } from "bun:test";
import { haveGoldGen, useGoldGen } from "../voxelmon/game/gen2/platform/data-node.ts";
import { seed } from "../voxelmon/game/gen2/platform/rng.ts";
import { Game2 } from "../voxelmon/game/gen2/core/Game2.ts";
import { Cheats } from "../voxelmon/game/gen2/core/Cheats.ts";
import { Mon } from "../voxelmon/game/gen2/battle/Mon.ts";
import { FieldMoves } from "../voxelmon/game/gen2/world/FieldMoves.ts";
import { Permissions } from "../voxelmon/game/gen2/world/Permissions.ts";
import { VisibleWild, aimFor, MAX_MONS, RX, RY } from "../voxelmon/game/gen2/world/VisibleWild.ts";
import { OptionsMenu } from "../voxelmon/game/gen2/ui/OptionsMenu.ts";

const gold = haveGoldGen();
const t = test.skipIf(!gold);

afterAll(() => Cheats.bind(() => undefined));

/** A game on ROUTE_29's grass with a party, VISIBLE WILD as given. */
function route(options: Record<string, any>, map = "ROUTE_29", x = 10, y = 10, s = 0x2929): any {
  useGoldGen();
  seed(s);
  const game: any = Game2.new();
  game.load({ startWorld: true });
  for (let i = 0; i < 10; i++) game.frame(0);
  game.world.setMap(map, x, y, "down");
  for (let i = 0; i < 30; i++) game.frame(0);
  game.save.party = [Mon.new(game.data, "CYNDAQUIL", 30, {})];
  Object.assign(game.options, options);
  Cheats.bind(() => game.options);
  game.stack.clear?.();
  return game;
}

/** Run `n` overworld steps straight on the world (no screens in the way). */
function steps(game: any, n: number): void {
  for (let i = 0; i < n; i++) game.world.step();
}

/** The world's live mons. */
const mons = (game: any): any[] => (game.world.visibleWild ? game.world.visibleWild.list : []);

describe("gen2 VISIBLE WILD: the option", () => {
  test("off unless set; the ladder OFF / SOME / MANY; aims 3 and 6, scaled by WILD ENCOUNTERS", () => {
    Cheats.bind(() => ({}));
    expect(Cheats.visibleWild()).toBe("off");
    Cheats.bind(() => ({ visibleWild: "lots" }));
    expect(Cheats.visibleWild()).toBe("off");
    Cheats.bind(() => ({ visibleWild: "many" }));
    expect(Cheats.visibleWild()).toBe("many");
    expect(aimFor("off", "normal")).toBe(0);
    expect(aimFor("some", "normal")).toBe(3);
    expect(aimFor("many", "normal")).toBe(6);
    expect(aimFor("some", "less")).toBe(2);
    expect(aimFor("many", "less")).toBe(3);
    expect(aimFor("some", "more")).toBe(5);
    expect(aimFor("many", "more")).toBe(MAX_MONS);
    expect(aimFor("many", "none")).toBe(0);
  });

  test("OPTION's ENHANCEMENTS page carries VISIBLE WILD after HMS WITHOUT MOVE", () => {
    const row = OptionsMenu.ROWS.find((r: any) => r.key === "visibleWild")!;
    expect(row).toBeDefined();
    const o: Record<string, any> = {};
    expect(row.text!(o)).toBe("OFF");
    row.cycle!(o, 1);
    expect(o.visibleWild).toBe("some");
    row.cycle!(o, 1);
    expect(row.text!(o)).toBe("MANY");
    row.cycle!(o, 1);
    expect(o.visibleWild).toBe("off");
    row.cycle!(o, -1);
    expect(o.visibleWild).toBe("many");
    const keys = OptionsMenu.ROWS.map((r: any) => r.key);
    expect(keys.indexOf("visibleWild")).toBe(keys.indexOf("hmsWithoutMove") + 1);
  });
});

describe("gen2 VISIBLE WILD: on the map", () => {
  t("ROUTE_29: mons appear, every one on a cell the cart rolls encounters on, none on or beside the player", () => {
    const game = route({ visibleWild: "many" });
    const world = game.world;
    let seen = 0;
    for (let k = 0; k < 40; k++) {
      steps(game, 60);
      for (const w of mons(game)) {
        seen++;
        const c = world.map.cellCollision(w.npc.cellX, w.npc.cellY);
        expect(FieldMoves.canEncounterWildMon(world.map.def.environment, c, false)).toBe(true);
        expect(Permissions.isIce(c)).toBe(false);
        expect(world.map.warpAt(w.npc.cellX, w.npc.cellY)).toBeUndefined();
        expect(world.npcAt(w.npc.cellX, w.npc.cellY)).toBeUndefined();
        expect(w.kind).toBe(Permissions.isWater(c) ? "water" : "land");
      }
    }
    expect(seen).toBeGreaterThan(0);
  });

  t("every cell VisibleWild accepts in the window is an encounter cell, and a town has none", () => {
    const game = route({ visibleWild: "many" });
    const vw = new VisibleWild();
    const cells = vw.candidates(game.world);
    expect(cells.length).toBeGreaterThan(0);
    for (const c of cells) {
      const coll = game.world.map.cellCollision(c.x, c.y);
      expect(Permissions.isEncounterCollision(coll)).toBe(true);
      expect(Math.max(Math.abs(c.x - game.world.player.cellX), Math.abs(c.y - game.world.player.cellY))).toBeGreaterThanOrEqual(2);
      expect(Math.abs(c.x - game.world.player.cellX)).toBeLessThanOrEqual(RX);
      expect(Math.abs(c.y - game.world.player.cellY)).toBeLessThanOrEqual(RY);
    }
    const town = route({ visibleWild: "many" }, "NEW_BARK_TOWN", 10, 8);
    expect(new VisibleWild().candidates(town.world).length).toBe(0);
    steps(town, 600);
    expect(mons(town).length).toBe(0);
  });

  t("counts: SOME holds at most 3 and reaches it, MANY at most 6 and reaches 5 or more; LESS and MORE scale", () => {
    // all grass round the player, so the patch never caps the aim
    const grassy = (options: Record<string, any>): any => {
      const g = route(options);
      let grass = -1;
      for (let c = 0; c < 256 && grass < 0; c++) {
        if (Permissions.isEncounterCollision(c) && !Permissions.isWater(c) && !Permissions.isIce(c)
            && Permissions.isWalkable(c) && !Permissions.ledgeFacings(c) && !Permissions.isWarpCollision(c)) grass = c;
      }
      g.world.map.cellCollision = () => grass;
      g.world.map.def.coordEvents = [];
      return g;
    };
    const peak = (g: any): number => {
      let most = 0;
      for (let k = 0; k < 60; k++) {
        steps(g, 30);
        most = Math.max(most, mons(g).filter((w: any) => w.roaming == null).length);
      }
      return most;
    };
    expect(peak(grassy({ visibleWild: "some" }))).toBe(3);
    const many = peak(grassy({ visibleWild: "many" }));
    expect(many).toBeGreaterThanOrEqual(5);
    expect(many).toBeLessThanOrEqual(6);
    expect(peak(grassy({ visibleWild: "some", wildEncounters: "less" }))).toBe(2);
    expect(peak(grassy({ visibleWild: "many", wildEncounters: "more" }))).toBe(MAX_MONS);
    expect(peak(grassy({ visibleWild: "off" }))).toBe(0);
  });

  t("WILD ENCOUNTERS NONE: no mon appears", () => {
    const game = route({ visibleWild: "many", wildEncounters: "none" });
    steps(game, 1800);
    expect(mons(game).filter((w: any) => w.roaming == null).length).toBe(0);
  });

  t("time of day: each mon comes from that time's land list (MORN, DAY, NITE)", () => {
    const game = route({ visibleWild: "many" });
    const world = game.world;
    const table = world.encounters.grass.ROUTE_29;
    for (const tod of ["MORN", "DAY", "NITE"]) {
      world.tod = tod;
      const allowed = new Set(table.slots[tod].map((s: any) => `${s.species}:${s.level}`));
      const vw = new VisibleWild();
      vw.mapId = world.map.id;
      let n = 0;
      for (let k = 0; k < 300; k++) {
        const w = vw.spawnOne(world);
        if (w) {
          n++;
          expect(allowed.has(`${w.species}:${w.level}`)).toBe(true);
        }
        vw.list.length = 0;
      }
      expect(n).toBeGreaterThan(100);
    }
  });

  t("shiny at spawn: SHINY ODDS 1/1 makes every one shiny (and its shiny colours); the cart's odds make them rare", () => {
    const game = route({ visibleWild: "many", shinyOdds: 1 });
    const world = game.world;
    const vw = new VisibleWild();
    vw.mapId = world.map.id;
    let n = 0;
    for (let k = 0; k < 100; k++) {
      const w = vw.spawnOne(world);
      if (w) {
        n++;
        expect(w.shiny).toBe(true);
        expect(Mon.vanillaShiny(w.dvs as any)).toBe(true);
        expect(w.colors).toEqual(VisibleWild.colorsFor(world, w.species, true)!);
      }
      vw.list.length = 0;
    }
    expect(n).toBeGreaterThan(20);
    game.options.shinyOdds = 8192;
    let shiny = 0;
    n = 0;
    for (let k = 0; k < 8000; k++) {
      const w = vw.spawnOne(world);
      if (w) {
        n++;
        if (w.shiny) shiny++;
      }
      vw.list.length = 0;
    }
    // about one in 8192 (a handful at most in this many)
    expect(n).toBeGreaterThan(4000);
    expect(shiny).toBeLessThanOrEqual(5);
  });

  t("touching one starts exactly that battle, and it is gone", () => {
    const game = route({ visibleWild: "some" });
    const world = game.world;
    const met: any[] = [];
    world.startBattle = (o: any) => met.push(o);
    let w: any;
    for (let k = 0; k < 60 && !w; k++) {
      steps(game, 30);
      w = mons(game)[0];
    }
    expect(w).toBeDefined();
    // the player onto its cell (its own step done)
    while (w.npc.moving) w.npc.update(world.map);
    world.player.cellX = w.npc.cellX;
    world.player.cellY = w.npc.cellY;
    world.player.px = w.npc.px;
    world.player.py = w.npc.py;
    expect(world.visibleWild.touch(world)).toBe(true);
    expect(met.length).toBe(1);
    const wild = met[0].wild;
    expect(wild.species).toBe(w.species);
    expect(wild.level).toBe(w.level);
    for (const k of ["attack", "defense", "speed", "special"]) expect(wild.dvs[k]).toBe(w.dvs[k]);
    expect(met[0].roaming).toBeUndefined();
    expect(mons(game).includes(w)).toBe(false);
    expect(game.save.pokedex.seen[w.species]).toBe(true);
  });

  t("ON: no random step encounter, even on grass at the highest rate; OFF: they come back", () => {
    const game = route({ visibleWild: "some", wildEncounters: "more" });
    const world = game.world;
    let grass = -1;
    for (let c = 0; c < 256 && grass < 0; c++) {
      if (Permissions.isEncounterCollision(c) && !Permissions.isWater(c) && !Permissions.isIce(c)) grass = c;
    }
    world.map.cellCollision = () => grass;
    const met: any[] = [];
    world.startBattle = (o: any) => met.push(o);
    for (let i = 0; i < 500; i++) {
      world.wildCooldown = 0;
      world.tryWildEncounter();
    }
    expect(met.length).toBe(0);
    game.options.visibleWild = "off";
    for (let i = 0; i < 500; i++) {
      world.wildCooldown = 0;
      world.tryWildEncounter();
    }
    expect(met.length).toBeGreaterThan(0);
  });

  t("over a link: no mons, and the step encounters are the cart's", () => {
    const game = route({ visibleWild: "many" });
    game.linked = () => true;
    expect(VisibleWild.active(game.world)).toBe(false);
    steps(game, 900);
    expect(mons(game).length).toBe(0);
  });

  t("a map change takes them all; the mons are never written to the save", () => {
    const game = route({ visibleWild: "many" });
    steps(game, 900);
    expect(mons(game).length).toBeGreaterThan(0);
    expect(JSON.stringify(game.save)).not.toContain("VISIBLE_WILD");
    game.world.setMap("ROUTE_30", 10, 10, "down");
    for (let i = 0; i < 30; i++) game.frame(0);
    steps(game, 1);
    expect(mons(game).every((w: any) => w.npc.mapId === "ROUTE_30")).toBe(true);
  });
});
