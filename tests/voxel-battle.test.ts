// tests/voxel-battle.test.ts — the gen1recomp wild-battle port under test.
//
// Layer 1 (ROM-free, always runs): HP-bar tile math (the battle overlay
// codes) and the run-away formula against hand-checked cases.
//
// Layer 2 (gated, skips with a printed reason when dist/voxelmon/gen is
// absent): scripted wild battles driven roll-for-roll through seqRng with
// every number CROSS-CHECKED against the rules/ modules directly (the
// battle must apply what the rules compute — no drift), queue discipline,
// the classic battle-screen tile layout, and the battle.tape end-to-end
// determinism run.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { WildBattle, type BattleButton, type BattleInput, type BattleSave } from "../voxelmon/game/battle/battle.ts";
import { TrainerBattle } from "../voxelmon/game/battle/trainer.ts";
import { makeBattler } from "../voxelmon/game/battle/battler.ts";
import { newMon, type PartyMon } from "../voxelmon/game/battle/mon.ts";
import { search as arenaSearch, type Arena } from "../voxelmon/game/battle/arena.ts";
import { chooseOrbit, chooseView, orbitDir, sightlineHits } from "../voxelmon/game/battle/staging.ts";
import {
  HUD_BAR_EMPTY,
  HUD_BAR_FULL,
  HUD_BAR_LEFT,
  HUD_CAP_DOUBLE,
  HUD_CAP_NUB,
  HUD_HP_LABEL,
  HUD_LV,
  BattleUi,
  hpBarTiles,
} from "../voxelmon/game/battle/ui.ts";
import { loadRuntimeData, REQUIRED_MODULES, type VoxelmonData } from "../voxelmon/game/data.ts";
import { encodeGlyphs } from "../voxelmon/game/ui/tiles.ts";
import type { VoxelHost } from "../voxelmon/game/host.ts";
import { RecorderHost } from "../voxelmon/game/host.ts";
import { seededRng, seqRng } from "../voxelmon/game/rng.ts";
import { MoveAnim, type AnimData } from "../voxelmon/game/battle/moveanim.ts";
import { SPARKLE_FRAMES, sparkleStars } from "../voxelmon/game/battle/sparkle.ts";
import { EFFECTS } from "../voxelmon/game/battle/effects.ts";
import { attempt as catchAttempt } from "../voxelmon/game/rules/catching.ts";
import { compute as damageCompute, GEN1_FAITHFUL } from "../voxelmon/game/rules/damage.ts";
import { gainFor } from "../voxelmon/game/rules/experience.ts";
import { hpBarPixels } from "../voxelmon/game/rules/timing.ts";
import { createTypeChart } from "../voxelmon/game/rules/typechart.ts";
import { VoxelmonGame } from "../voxelmon/game/game.ts";
import { parseTape, TapePlayer } from "../voxelmon/game/sim/tape.ts";

const root = join(import.meta.dir, "..");
const genDir = join(root, "dist/voxelmon/gen");
const hasGen = REQUIRED_MODULES.every((m) => existsSync(join(genDir, `${m}.json`)));
if (!hasGen) {
  console.log(
    "[voxel-battle] dist/voxelmon/gen absent (run `bun tools/voxel.ts import`) — ROM-gated suites skipped",
  );
}
const data: VoxelmonData | null = hasGen ? await loadRuntimeData(genDir) : null;

// ---------------------------------------------------------------------------
// drive harness
// ---------------------------------------------------------------------------

class FakeInput implements BattleInput {
  private down = new Set<BattleButton>();
  private edges = new Set<BattleButton>();
  press(btn: BattleButton): void {
    this.edges.add(btn);
    this.down.add(btn);
  }
  clear(): void {
    this.edges.clear();
    this.down.clear();
  }
  isDown(btn: BattleButton): boolean {
    return this.down.has(btn);
  }
  wasPressed(btn: BattleButton): boolean {
    return this.edges.has(btn);
  }
}

function tick(b: WildBattle, input: FakeInput, presses: BattleButton[] = []): void {
  input.clear();
  for (const p of presses) input.press(p);
  b.update(input);
}

/** Mash A through every prompt/hold until the queue idles into a menu or
 * the battle finishes. */
function settle(b: WildBattle, input: FakeInput, maxTicks = 8000): void {
  for (let i = 0; i < maxTicks; i++) {
    if (b.finished || b.phase !== "messages") return;
    tick(b, input, ["a"]);
  }
  throw new Error("battle did not settle");
}

function makeSave(party: PartyMon[], inventory: Record<string, number> = {}): BattleSave {
  return { party, inventory, player: { name: "RED", rival: "BLUE" } };
}

interface BattleOpts {
  playerMon?: PartyMon;
  inventory?: Record<string, number>;
  species?: string;
  level?: number;
  /** The full seqRng roll script; the FIRST FOUR rolls are the enemy's DVs
   * (Stats.randomDVs order: attack, defense, speed, special). */
  rolls: number[];
}

function makeBattle(opts: BattleOpts): { b: WildBattle; input: FakeInput; save: BattleSave } {
  const playerMon = opts.playerMon ?? newMon(data!, "SQUIRTLE", 5);
  const save = makeSave([playerMon], opts.inventory ?? {});
  const b = new WildBattle(
    data!,
    save,
    seqRng(...opts.rolls),
    opts.species ?? "PIDGEY",
    opts.level ?? 3,
  );
  b.enter();
  const input = new FakeInput();
  settle(b, input); // through the intro to the action menu
  return { b, input, save };
}

/** FIGHT with move slot 1 from the action menu, then settle the exchange. */
function fightOnce(b: WildBattle, input: FakeInput): void {
  expect(b.phase).toBe("menu");
  expect(b.menuIndex).toBe(1); // cursor rests on FIGHT
  tick(b, input, ["a"]);
  expect(b.phase).toBe("moveSelect");
  tick(b, input, ["a"]); // slot 1
  expect(b.phase).toBe("messages");
  settle(b, input);
}

describe("catching with a full party", () => {
  /** A wild battle whose next ball catches, with `party` mons already held. */
  function catchGame(party: number) {
    const mons = [];
    for (let i = 0; i < party; i++) mons.push(newMon(data!, "SQUIRTLE", 30));
    const save = makeSave(mons, { POKE_BALL: 5 });
    // MAGIKARP at level 3 with a POKe BALL: the shake rolls below are what
    // make it a catch rather than a break-out.
    const b = new WildBattle(data!, save, seqRng(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0), "MAGIKARP", 3);
    b.enter();
    const input = new FakeInput();
    settle(b, input);
    return { b, input, save };
  }

  /** Throw one ball and let the whole chain play out. */
  function throwOne(b: WildBattle, input: FakeInput) {
    b.openItems();
    b.itemIndex = b.itemList.indexOf("POKE_BALL");
    tick(b, input, ["a"]);
    for (let i = 0; i < 8000 && !b.finished; i++) tick(b, input, ["a"]);
  }

  test.skipIf(!hasGen)("puts the caught mon in the PC instead of dropping it", () => {
    const { b, input, save } = catchGame(6);
    throwOne(b, input);
    expect(b.result).toBe("caught");
    expect(save.party.length).toBe(6); // the party is untouched
    const boxes = (save as any).boxes as { species: string }[][];
    expect(boxes).toBeDefined();
    // it is in a box, and it is the mon that was caught
    const stored = boxes.flat();
    expect(stored.length).toBe(1);
    expect(stored[0]!.species).toBe("MAGIKARP");
    expect(b.messageLog.join("|")).toContain("someone's PC");
  });

  test.skipIf(!hasGen)("says BILL's PC once BILL has been met", () => {
    const { b, input, save } = catchGame(6);
    (save as any).flags = { EVENT_MET_BILL: true };
    throwOne(b, input);
    expect(b.messageLog.join("|")).toContain("BILL's PC");
  });

  test.skipIf(!hasGen)("still joins the party when there is room", () => {
    const { b, input, save } = catchGame(3);
    throwOne(b, input);
    expect(b.result).toBe("caught");
    expect(save.party.length).toBe(4);
    expect(save.party[3]!.species).toBe("MAGIKARP");
    expect(((save as any).boxes ?? []).flat().length).toBe(0);
  });
});

describe("a ball thrown at a trainer's Pokemon", () => {
  test.skipIf(!hasGen)("is blocked, spends the ball and the turn, and catches nothing", () => {
    const save = makeSave([newMon(data!, "SQUIRTLE", 20)], { POKE_BALL: 2 });
    const b = new TrainerBattle(
      data!, save, seqRng(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
      "OPP_YOUNGSTER", 1,
    );
    b.enter();
    const input = new FakeInput();
    settle(b, input);
    expect(b.phase).toBe("menu");

    // ITEM -> the ball
    b.openItems();
    b.itemIndex = b.itemList.indexOf("POKE_BALL");
    expect(b.itemIndex).toBeGreaterThanOrEqual(0);
    tick(b, input, ["a"]);
    settle(b, input);

    expect(b.messageLog.join("|")).toContain("blocked the BALL");
    expect(b.messageLog.join("|")).toContain("thief");
    expect(b.result).toBeNull();          // nothing was caught
    expect(save.party.length).toBe(1);    // and nothing joined the party
    expect(save.inventory.POKE_BALL).toBe(1); // the ball is spent
    // the turn went with it: the foe moved
    expect(b.messageLog.some((m) => m.startsWith("Enemy "))).toBe(true);
  });
});

describe("the Pokemon Tower's GHOST", () => {
  /** A wild battle built by hand so the disguise can go on before enter(). */
  function ghostBattle(species: string, setup: (b: WildBattle) => void) {
    const save = makeSave([newMon(data!, "SQUIRTLE", 5)]);
    const b = new WildBattle(data!, save, seqRng(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
      species, 20);
    setup(b);
    b.enter();
    const input = new FakeInput();
    settle(b, input);
    return { b, input };
  }

  test.skipIf(!hasGen)("nobody moves: you are too scared, and it only says get out", () => {
    const { b, input } = ghostBattle("GASTLY", (b) => b.makeGhost());
    expect(b.disguised).toBe(true);
    expect(b.enemy.name).toBe("GHOST");
    expect(b.messageLog[0]).toBe("The GHOST\nappeared!");
    const hpBefore = b.player.mon.hp;
    fightOnce(b, input);
    // core.asm PrintGhostText on both turns: ScaredText for the player,
    // GetOutText for the ghost. No move lands either way.
    expect(b.messageLog).toContain("SQUIRTLE is too\nscared to move!");
    expect(b.messageLog).toContain("GHOST: Get out...\nGet out...");
    expect(b.messageLog.some((m) => m.includes("used"))).toBe(false);
    expect(b.player.mon.hp).toBe(hpBefore);
    expect(b.enemy.mon.hp).toBe(b.enemy.mon.stats.hp);
    expect(b.phase).toBe("menu");
  });

  test.skipIf(!hasGen)("with the scope the MAROWAK enters as the GHOST and is unveiled", () => {
    const { b } = ghostBattle("MAROWAK", (b) => b.makeUnveiledGhost());
    // PrintBeginningBattleText .isMarowak: the ghost line, the unveil, then
    // the real name -- and the disguise is gone before the first turn.
    expect(b.messageLog[0]).toBe("The GHOST\nappeared!");
    expect(b.messageLog.some((m) => m.includes("unveiled"))).toBe(true);
    expect(b.messageLog).toContain("Wild MAROWAK\nappeared!");
    expect(b.disguised).toBe(false);
    expect(b.enemy.name).toBe("MAROWAK");
  });

  test.skipIf(!hasGen)("a hooked mon attacks rather than appears", () => {
    const { b } = ghostBattle("MAGIKARP", (b) => { b.hooked = true; });
    // the extracted line keeps its own scroll control between the name and
    // "attacked!", so it is matched by its halves
    expect(b.messageLog[0]?.startsWith("The hooked\nMAGIKARP")).toBe(true);
    expect(b.messageLog[0]?.endsWith("attacked!")).toBe(true);
    expect(b.disguised).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Layer 1 — HP bar tile math (HudTiles.drawHPBar + Timing.hpBarPixels)
// ---------------------------------------------------------------------------

describe("hp bar tiles", () => {
  test("full bar: six $6B segments and the side cap", () => {
    expect(hpBarTiles(19, 19, true)).toEqual([
      HUD_HP_LABEL,
      HUD_BAR_LEFT,
      HUD_BAR_FULL,
      HUD_BAR_FULL,
      HUD_BAR_FULL,
      HUD_BAR_FULL,
      HUD_BAR_FULL,
      HUD_BAR_FULL,
      HUD_CAP_DOUBLE, // wHPBarType 1: the $6D double-bar cap (player side)
    ]);
    expect(hpBarTiles(15, 15, false)[8]).toBe(HUD_CAP_NUB); // enemy $6C nub
  });

  test("empty bar: six $63 empties", () => {
    const tiles = hpBarTiles(0, 19, false);
    expect(tiles.slice(2, 8)).toEqual(new Array(6).fill(HUD_BAR_EMPTY));
  });

  test("a nonzero HP always shows a one-pixel sliver (hp_bar.asm:42-45)", () => {
    expect(hpBarPixels(1, 100)).toBe(1);
    const tiles = hpBarTiles(1, 100, false);
    expect(tiles[2]).toBe(HUD_BAR_EMPTY + 1);
    expect(tiles.slice(3, 8)).toEqual(new Array(5).fill(HUD_BAR_EMPTY));
  });

  test("fractional fill matches the 48ths pixel math", () => {
    // 10/19 HP: floor(10*48/19) = 25 px = 3 full tiles + a 1px partial
    expect(hpBarPixels(10, 19)).toBe(25);
    const tiles = hpBarTiles(10, 19, true);
    expect(tiles.slice(2, 8)).toEqual([
      HUD_BAR_FULL,
      HUD_BAR_FULL,
      HUD_BAR_FULL,
      HUD_BAR_EMPTY + 1,
      HUD_BAR_EMPTY,
      HUD_BAR_EMPTY,
    ]);
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — scripted battles, roll-for-roll
// ---------------------------------------------------------------------------

// canonical roll values: 200 = no crit for base speeds under 100ish,
// 38 -> randRange(217,255) = 255 -> damage * 255/255 (the max roll)
const NO_CRIT = 200;
const MAX_RAND = 38;

describe("scripted wild battle", () => {
  test.skipIf(!hasGen)("damage lands exactly as rules/damage computes it", () => {
    // SQUIRTLE L5 (zero DVs, spd 9) vs PIDGEY L3 (zero DVs, spd 8):
    // player moves first with no tie roll. Rolls: 4 DVs, enemy move pick,
    // then acc/crit/rand for each side.
    const { b, input } = makeBattle({
      rolls: [0, 0, 0, 0, 0, 0, NO_CRIT, MAX_RAND, 0, NO_CRIT, MAX_RAND],
    });
    const chart = createTypeChart(data!.type_chart);
    const pMax = b.player.mon.stats.hp;
    const eMax = b.enemy.mon.stats.hp;

    fightOnce(b, input);

    // the same numbers straight out of rules/damage with the same rolls
    const atk = makeBattler(data!, newMon(data!, "SQUIRTLE", 5), true);
    const dfn = makeBattler(data!, newMon(data!, "PIDGEY", 3), false);
    const [tackle] = damageCompute(GEN1_FAITHFUL, chart, atk, dfn, data!.moves.TACKLE, {
      rng: seqRng(NO_CRIT, MAX_RAND),
    });
    const [gust] = damageCompute(GEN1_FAITHFUL, chart, dfn, atk, data!.moves.GUST, {
      rng: seqRng(NO_CRIT, MAX_RAND),
    });
    expect(tackle).toBeGreaterThan(0);
    expect(gust).toBeGreaterThan(0);
    expect(b.enemy.mon.hp).toBe(eMax - tackle);
    expect(b.player.mon.hp).toBe(pMax - gust);
  });

  test.skipIf(!hasGen)(
    "queue discipline: the two-move exchange messages in reference order",
    () => {
      const { b, input } = makeBattle({
        rolls: [0, 0, 0, 0, 0, 0, NO_CRIT, MAX_RAND, 0, NO_CRIT, MAX_RAND],
      });
      fightOnce(b, input);
      expect(b.messageLog).toEqual([
        "Wild PIDGEY\nappeared!",
        "Go! SQUIRTLE!",
        "SQUIRTLE\nused TACKLE!",
        "Enemy PIDGEY\nused GUST!",
      ]);
      expect(b.phase).toBe("menu"); // the turn handed the menu back
      expect(b.result).toBeNull();
    },
  );

  test.skipIf(!hasGen)("speed tie: the coin flip decides who moves first", () => {
    // enemy speed DV 15 makes PIDGEY L3 spd 9 == SQUIRTLE L5 spd 9.
    // firstMover consumes ONE tie roll: 1 -> enemy first, 0 -> player first
    // (TurnOrder.lua:50-59).
    const enemyFirst = makeBattle({
      rolls: [0, 0, 15, 0, 0, /* tie */ 1, 0, NO_CRIT, MAX_RAND, 0, NO_CRIT, MAX_RAND],
    });
    fightOnce(enemyFirst.b, enemyFirst.input);
    expect(enemyFirst.b.messageLog.slice(2)).toEqual([
      "Enemy PIDGEY\nused GUST!",
      "SQUIRTLE\nused TACKLE!",
    ]);

    const playerFirst = makeBattle({
      rolls: [0, 0, 15, 0, 0, /* tie */ 0, 0, NO_CRIT, MAX_RAND, 0, NO_CRIT, MAX_RAND],
    });
    fightOnce(playerFirst.b, playerFirst.input);
    expect(playerFirst.b.messageLog.slice(2)).toEqual([
      "SQUIRTLE\nused TACKLE!",
      "Enemy PIDGEY\nused GUST!",
    ]);
  });

  test.skipIf(!hasGen)("faint -> exp -> level-up, numbers from rules/experience", () => {
    // SQUIRTLE at L5 with exp 160: PIDGEY L3's gain crosses the L6
    // MEDIUM_SLOW threshold (179) exactly once
    const playerMon = newMon(data!, "SQUIRTLE", 5);
    playerMon.exp = 160;
    const { b, input } = makeBattle({
      playerMon,
      rolls: [0, 0, 0, 0, 0, 0, NO_CRIT, MAX_RAND],
    });
    b.enemy.mon.hp = 1;
    b.enemy.shownHP = 1;
    fightOnce(b, input);

    const gained = gainFor(data!.pokemon.PIDGEY, 3);
    expect(gained).toBe(Math.floor((data!.pokemon.PIDGEY.baseExp * 3) / 7));
    expect(b.finished).toBe("win");
    expect(playerMon.exp).toBe(160 + gained);
    expect(playerMon.level).toBe(6);
    expect(b.messageLog).toContain("Enemy PIDGEY\nfainted!");
    expect(b.messageLog).toContain(`SQUIRTLE gained\n${gained} EXP. Points!`);
    expect(b.messageLog).toContain("SQUIRTLE grew\nto level 6!");
    // stat exp: the defeated species' base stats were added
    expect(playerMon.statExp.attack).toBe(data!.pokemon.PIDGEY.baseStats.attack);
  });

  test.skipIf(!hasGen)("level-up learns the exact-level move (BUBBLE at L8)", () => {
    const playerMon = newMon(data!, "SQUIRTLE", 7);
    playerMon.exp = 300; // L8 at 314; PIDGEY L3 pays 23
    const { b, input } = makeBattle({
      playerMon,
      rolls: [0, 0, 0, 0, 0, 0, NO_CRIT, MAX_RAND],
    });
    b.enemy.mon.hp = 1;
    b.enemy.shownHP = 1;
    fightOnce(b, input);
    expect(playerMon.level).toBe(8);
    expect(b.messageLog).toContain("SQUIRTLE learned\nBUBBLE!");
    expect(playerMon.moves.map((m) => m.id)).toContain("BUBBLE");
  });

  test.skipIf(!hasGen)("catch success: shakes and the party join from rules/catching", () => {
    const { b, input, save } = makeBattle({
      inventory: { POKE_BALL: 2 },
      // DVs, then the ball's int(256) and byte rolls
      rolls: [0, 0, 0, 0, 100, 50],
    });
    // cross-check the exact rolls through rules/catching first
    const probe = newMon(data!, "PIDGEY", 3);
    const [caught, shakes] = catchAttempt(
      "POKE_BALL",
      probe,
      data!.pokemon.PIDGEY,
      seqRng(100, 50),
    );
    expect([caught, shakes]).toEqual([true, 3]);

    tick(b, input, ["down"]); // FIGHT -> ITEM
    expect(b.menuIndex).toBe(3);
    tick(b, input, ["a"]);
    expect(b.phase).toBe("item");
    tick(b, input, ["a"]); // throw POKE BALL
    settle(b, input);
    expect(b.finished).toBe("caught");
    expect(b.messageLog).toContain("All right!\nPIDGEY was\ncaught!");
    expect(save.party.length).toBe(2);
    expect(save.party[1].species).toBe("PIDGEY");
    expect(save.inventory.POKE_BALL).toBe(1);
  });

  test.skipIf(!hasGen)("catch failure: the wobble count picks the miss text", () => {
    const { b, input, save } = makeBattle({
      inventory: { POKE_BALL: 1 },
      // ball int + byte (fails), then the enemy's free move
      rolls: [0, 0, 0, 0, 100, 200, 0, 0, NO_CRIT, MAX_RAND],
    });
    const probe = newMon(data!, "PIDGEY", 3);
    const [caught, shakes] = catchAttempt(
      "POKE_BALL",
      probe,
      data!.pokemon.PIDGEY,
      seqRng(100, 200),
    );
    expect([caught, shakes]).toEqual([false, 2]);

    tick(b, input, ["down"]);
    tick(b, input, ["a"]);
    tick(b, input, ["a"]);
    settle(b, input);
    // ItemUseBallText03 for two wobbles, then the foe's free move
    expect(b.messageLog).toContain("Aww! It appeared\nto be caught!");
    expect(b.messageLog).toContain("Enemy PIDGEY\nused GUST!");
    expect(b.result).toBeNull();
    expect(b.phase).toBe("menu");
    expect(save.party.length).toBe(1);
  });

  test.skipIf(!hasGen)("paralysis: the 63/256 roll blocks the move", () => {
    const playerMon = newMon(data!, "SQUIRTLE", 5);
    playerMon.status = "PAR";
    // PAR quarters speed (9 -> 2): the enemy moves first, no tie roll.
    // Rolls: DVs, pick, enemy acc/crit/rand, then the player's PAR byte.
    const blocked = makeBattle({
      playerMon,
      rolls: [0, 0, 0, 0, 0, 0, NO_CRIT, MAX_RAND, /* PAR */ 10],
    });
    fightOnce(blocked.b, blocked.input);
    expect(blocked.b.messageLog).toContain("SQUIRTLE's\nfully paralyzed!");
    expect(blocked.b.messageLog).not.toContain("SQUIRTLE\nused TACKLE!");

    const free = makeBattle({
      playerMon: (() => {
        const m = newMon(data!, "SQUIRTLE", 5);
        m.status = "PAR";
        return m;
      })(),
      rolls: [0, 0, 0, 0, 0, 0, NO_CRIT, MAX_RAND, /* PAR */ 100, 0, NO_CRIT, MAX_RAND],
    });
    fightOnce(free.b, free.input);
    expect(free.b.messageLog).toContain("SQUIRTLE\nused TACKLE!");
  });

  test.skipIf(!hasGen)("run-away formula (TryRunningFromBattle)", () => {
    const mk = (...rolls: number[]) => {
      const b = new WildBattle(
        data!,
        makeSave([newMon(data!, "SQUIRTLE", 5)]),
        seqRng(0, 0, 0, 0, ...rolls),
        "PIDGEY",
        3,
      );
      return b;
    };
    // faster or equal: escapes with no roll
    expect(mk().runRoll(10, 10)).toBe(true);
    expect(mk().runRoll(50, 10)).toBe(true);
    // b = floor(eSpd/4) = 10, x = floor(pSpd*32/b) = 32: escape on <= 32
    expect(mk(32).runRoll(10, 40)).toBe(true);
    expect(mk(33).runRoll(10, 40)).toBe(false);
    // +30 per PREVIOUS attempt
    const b2 = mk(33, 62);
    expect(b2.runRoll(10, 40)).toBe(false);
    expect(b2.runRoll(10, 40)).toBe(true); // x = 32 + 30 = 62
    // a zero divisor auto-escapes
    expect(mk().runRoll(1, 3)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — the battle screen tile layout
// ---------------------------------------------------------------------------

interface CapturedOp {
  op: string;
  args: (number | string)[];
}

class CaptureHost implements VoxelHost {
  ops: CapturedOp[] = [];
  private rec(op: string, ...args: (number | string)[]): void {
    this.ops.push({ op, args });
  }
  gamedata(): ArrayBuffer | null {
    return null;
  }
  audiodata(): ArrayBuffer | null {
    return null;
  }
  stats(): ArrayBuffer | null {
    return null;
  }
  reset(): void {}
  mapShow(...a: number[]): void {
    this.rec("mapShow", ...a);
  }
  mapHide(...a: number[]): void {
    this.rec("mapHide", ...a);
  }
  cam(...a: number[]): void {
    this.rec("cam", ...a);
  }
  pitch(...a: number[]): void {
    this.rec("pitch", ...a);
  }
  tint(...a: number[]): void {
    this.rec("tint", ...a);
  }
  stamp(...a: number[]): void {
    this.rec("stamp", ...a);
  }
  palette(...a: number[]): void {
    this.rec("palette", ...a);
  }
  ent(...a: number[]): void {
    this.rec("ent", ...a);
  }
  entHide(...a: number[]): void {
    this.rec("entHide", ...a);
  }
  emote(...a: number[]): void {
    this.rec("emote", ...a);
  }
  uiTile(x: number, y: number, tile: number): void {
    this.rec("uiTile", x, y, tile);
  }
  uiPanel(side: number, x: number, y: number, w: number, h: number): void {
    this.rec("uiPanel", side, x, y, w, h);
  }
  uiFill(x: number, y: number, w: number, h: number, tile: number): void {
    this.rec("uiFill", x, y, w, h, tile);
  }
  uiText(x: number, y: number, str: string): void {
    this.rec("uiText", x, y, str);
  }
  uiReveal(n: number): void {
    this.rec("uiReveal", n);
  }
  uiClear(): void {
    this.rec("uiClear");
  }
  arena(...a: number[]): void {
    this.rec("arena", ...a);
  }
  card(...a: number[]): void {
    this.rec("card", ...a);
  }
  cardHide(...a: number[]): void {
    this.rec("cardHide", ...a);
  }
  battleCam(...a: number[]): void {
    this.rec("battleCam", ...a);
  }
  music(): void {}
  musicStop(): void {}
  musicFade(): void {}
  sfx(): void {}
  cry(): void {}
  audioWaves(): void {}
  audioDrum(): void {}
  arenaEnd(): void {
    this.rec("arenaEnd");
  }
  frameDone(): void {}

  tile(x: number, y: number): number | undefined {
    for (let i = this.ops.length - 1; i >= 0; i--) {
      const o = this.ops[i];
      if (o.op === "uiTile" && o.args[0] === x && o.args[1] === y) return o.args[2] as number;
    }
    return undefined;
  }
  text(x: number, y: number): string | undefined {
    for (let i = this.ops.length - 1; i >= 0; i--) {
      const o = this.ops[i];
      if (o.op === "uiText" && o.args[0] === x && o.args[1] === y) return o.args[2] as string;
    }
    return undefined;
  }

  /**
   * Static chrome labels land in the grid as glyph tiles (uiText is the one
   * typewriter run): read back the run starting at (x, y) and compare it to
   * a string via its glyph encoding.
   */
  tiles(x: number, y: number, n: number): number[] {
    const grid = new Map<string, number>();
    for (const o of this.ops) {
      if (o.op === "uiTile") grid.set(`${o.args[0]},${o.args[1]}`, o.args[2] as number);
    }
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push(grid.get(`${x + i},${y}`) ?? 0);
    return out;
  }
}

// ---------------------------------------------------------------------------
// Move animations — the compiled subanimation player (battle/moveanim.ts)
// ---------------------------------------------------------------------------

const animPath = join(genDir, "battle_anims.json");
const hasAnims = existsSync(animPath);
if (!hasAnims) console.log("[voxel-battle] battle_anims.json absent — move animation suite skipped");
const animData: AnimData | null = hasAnims
  ? (JSON.parse(readFileSync(animPath, "utf8")) as AnimData)
  : null;

describe("move animations", () => {
  test.skipIf(!hasAnims)("TACKLE is the lunge: two effects, no sprites", () => {
    const a = new MoveAnim(animData, "TACKLE", true);
    expect(a.missing).toEqual([]);
    expect(a.events.filter((e) => e.effect).map((e) => e.effect)).toEqual([
      "SE_MOVE_MON_HORIZONTALLY",
      "SE_RESET_MON_POSITION",
    ]);
    // the row also names the sound its MoveSoundTable entry plays
    expect(a.events.filter((e) => e.sound !== undefined).length).toBe(1);
    // three frames each (the routines' DelayFrames), and nothing drawn
    expect(a.frames).toBe(6);
    expect(a.steps.every((s) => s.sprites.length === 0)).toBe(true);
  });

  test.skipIf(!hasAnims)("THUNDERBOLT draws tiles and flashes every 8 blocks", () => {
    const a = new MoveAnim(animData, "THUNDERBOLT", true);
    expect(a.missing).toEqual([]);
    expect(a.frames).toBeGreaterThan(20);
    const drawn = a.steps.filter((s) => s.sprites.length > 0);
    expect(drawn.length).toBeGreaterThan(4);
    // ANIM_ID_FX: THUNDERBOLT flashes when the block counter hits a
    // multiple of 8 (DoSpecialEffectByAnimationId)
    expect(a.events.some((e) => e.effect === "SE_DARK_SCREEN_FLASH")).toBe(true);
    // every sprite is an 8x8 tile inside its sheet, in OAM space
    for (const s of drawn.flatMap((d) => d.sprites)) {
      expect(s.tile).toBeLessThan(animData!.tilesets[s.ts].tiles);
      expect(s.x).toBeGreaterThanOrEqual(0);
      expect(s.x).toBeLessThan(256);
      expect(s.y).toBeLessThan(256);
    }
  });

  test.skipIf(!hasAnims)("the enemy's turn mirrors what the player's does not", () => {
    // GetSubanimationTransform1/2: on the player's turn every type but
    // ENEMY plays untransformed, so a mirrored type only bites for the foe.
    const mine = new MoveAnim(animData, "EMBER", true);
    const theirs = new MoveAnim(animData, "EMBER", false);
    expect(mine.frames).toBe(theirs.frames);
    const first = (a: MoveAnim) => a.steps.find((s) => s.sprites.length > 0)!.sprites[0];
    const p = first(mine);
    const e = first(theirs);
    expect(p.tile).toBe(e.tile);
    // HFLIP puts x at 168 - x and adds 40 to y (DrawFrameBlock)
    expect(e.x).toBe((168 - p.x) % 256);
    expect(e.y).toBe((p.y + 40) % 256);
    expect(e.xf).toBe(!p.xf);
  });

  test.skipIf(!hasAnims)("HYPER_BEAM spirals three balls inward, then flashes", () => {
    const a = new MoveAnim(animData, "HYPER_BEAM", true);
    expect(a.events.some((e) => e.effect === "SE_SPIRAL_BALLS_INWARD")).toBe(true);
    // the emitter's own steps: three balls, five frames each
    const ball = 0x7a - 0x31;
    const balls = a.steps.filter(
      (s) => s.sprites.length === 3 && s.sprites.every((q) => q.tile === ball),
    );
    expect(balls.length).toBe(19); // 21 spiral coordinates, three at a time
    expect(balls.every((s) => s.dur === 5)).toBe(true);
    expect(a.events.some((e) => e.effect === "SE_DARK_SCREEN_FLASH")).toBe(true);
  });

  test.skipIf(!hasAnims)("GROWL keeps the previous block's notes on screen", () => {
    // DoGrowlSpecialEffects copies the notes and skips the OAM clean, so
    // after the first block every frame shows two sets.
    const a = new MoveAnim(animData, "GROWL", true);
    const counts = a.steps.filter((s) => s.sprites.length > 0).map((s) => s.sprites.length);
    expect(counts.length).toBeGreaterThan(1);
    expect(Math.max(...counts)).toBeGreaterThan(Math.min(...counts));
  });

  test.skipIf(!hasAnims)("playback is a cursor: sprites and events by frame", () => {
    const a = new MoveAnim(animData, "THUNDERBOLT", true);
    expect(a.done(a.frames)).toBe(true);
    expect(a.done(a.frames - 1)).toBe(false);
    // every frame of the animation resolves to the step covering it
    let at = 0;
    for (const step of a.steps) {
      expect(a.spritesAt(at)).toBe(step.sprites);
      at += step.dur;
    }
    expect(a.spritesAt(a.frames)).toEqual([]);
    // events land in the window they belong to, once
    const all = a.eventsIn(0, a.frames + 1);
    expect(all.length).toBe(a.events.length);
  });

  test.skipIf(!hasAnims)("every move in the dataset compiles", () => {
    let drawn = 0;
    for (const id of Object.keys(animData!.anims)) {
      for (const attacker of [true, false]) {
        const a = new MoveAnim(animData, id, attacker);
        expect(a.missing, `${id} missing ids`).toEqual([]);
        // an animation is either drawn, or pure screen effect (TACKLE)
        expect(a.frames).toBeGreaterThanOrEqual(0);
        if (a.steps.some((s) => s.sprites.length > 0)) drawn += 1;
      }
    }
    // most of the 202 animations actually draw something
    expect(drawn).toBeGreaterThan(200);
  });
});

describe("status moves and trapping (MoveEffects port)", () => {
  /** A seeded battle: the player's mon knows exactly `moves`, the enemy
   * only GROWL, so nothing but the move under test changes the picture. */
  function setup(species: string, level: number, moves: string[], foe: string, foeLevel: number, seed: number) {
    const mon = newMon(data!, species, level);
    mon.moves = moves.map((id) => ({ id, pp: 40 }));
    const save = makeSave([mon]);
    const b = new WildBattle(data!, save, seededRng(seed), foe, foeLevel);
    b.enter();
    const input = new FakeInput();
    settle(b, input);
    b.enemy.curMoves = [{ id: "GROWL", pp: 40 }];
    return { b, input };
  }

  /** FIGHT, slot 1 (or straight through if the lock skips the list). */
  function fight(b: WildBattle, input: FakeInput): void {
    tick(b, input, ["a"]);
    if (b.phase === "moveSelect") tick(b, input, ["a"]);
    settle(b, input);
  }

  test.skipIf(!hasGen)("every effect a move in the data uses has a record", () => {
    const missing = new Set<string>();
    for (const mv of Object.values(data!.moves)) {
      if (mv.effect && !EFFECTS[mv.effect]) missing.add(mv.effect);
    }
    expect([...missing]).toEqual([]);
  });

  test.skipIf(!hasGen)("MIMIC: the player picks one of the foe's moves; it is MIMIC again after the battle", () => {
    for (const seed of [7, 8, 9, 10, 11]) {
      const { b, input } = setup("PIKACHU", 20, ["MIMIC", "TACKLE"], "SQUIRTLE", 20, seed);
      b.enemy.curMoves = [{ id: "GROWL", pp: 40 }, { id: "WATER_GUN", pp: 25 }];
      const mon = b.player.mon;
      tick(b, input, ["a"]); // FIGHT
      tick(b, input, ["a"]); // MIMIC
      settle(b, input);
      if (!b.mimicPick) continue; // that roll missed; try the next seed
      expect(b.phase).toBe("moveSelect");
      expect(b.menuMoves().map((m) => m.id)).toEqual(["GROWL", "WATER_GUN"]);
      tick(b, input, ["right"]);
      tick(b, input, ["a"]);
      expect(b.mimicPick).toBeNull();
      settle(b, input);
      expect(b.player.curMoves[0]!.id).toBe("WATER_GUN");
      expect(b.messageLog.join("|")).toContain("learned");
      expect(b.messageLog.join("|")).toContain("WATER GUN!");
      // MIMIC's own PP is what the copy keeps
      expect(b.player.curMoves[0]!.pp).toBe(39);
      b.finish();
      expect(mon.moves[0]!.id).toBe("MIMIC");
      return;
    }
    throw new Error("MIMIC missed on every seed");
  });

  test.skipIf(!hasGen)("MIMIC: the foe copies one of the player's moves at random", () => {
    const { b, input } = setup("PIKACHU", 5, ["GROWL"], "CLEFAIRY", 40, 3);
    b.enemy.curMoves = [{ id: "MIMIC", pp: 10 }];
    for (let i = 0; i < 6 && b.enemy.curMoves[0]!.id === "MIMIC"; i++) fight(b, input);
    expect(b.enemy.curMoves[0]!.id).toBe("GROWL");
  });

  for (const [move, status, text] of [
    ["THUNDER_WAVE", "PAR", "paralyzed! It may\nnot attack!"],
    ["SLEEP_POWDER", "SLP", "fell asleep!"],
    ["TOXIC", "PSN", "badly poisoned!"],
  ] as const) {
    test.skipIf(!hasGen)(`${move} lands ${status}`, () => {
      const { b, input } = setup("PIKACHU", 20, [move], "RATTATA", 20, 7);
      for (let i = 0; i < 12 && !b.enemy.mon.status; i++) fight(b, input);
      expect(b.enemy.mon.status).toBe(status);
      expect(b.messageLog.some((m) => m.endsWith(text))).toBe(true);
      // a second use on a statused foe fails
      const before = b.messageLog.length;
      fight(b, input);
      expect(b.messageLog.slice(before)).toContain("But, it failed!");
    });
  }

  test.skipIf(!hasGen)("a sleeping foe loses its turns, then wakes", () => {
    const { b, input } = setup("PIKACHU", 20, ["SLEEP_POWDER"], "RATTATA", 20, 3);
    for (let i = 0; i < 12 && b.enemy.mon.status !== "SLP"; i++) fight(b, input);
    expect(b.enemy.mon.status).toBe("SLP");
    for (let i = 0; i < 10 && b.enemy.mon.status === "SLP"; i++) fight(b, input);
    expect(b.messageLog).toContain("Enemy RATTATA\nis fast asleep!");
    expect(b.messageLog).toContain("Enemy RATTATA\nwoke up!");
  });

  test.skipIf(!hasGen)("poison hurts at the end of each turn", () => {
    const { b, input } = setup("PIKACHU", 20, ["POISONPOWDER"], "PIDGEY", 20, 5);
    for (let i = 0; i < 12 && !b.enemy.mon.status; i++) fight(b, input);
    expect(b.enemy.mon.status).toBe("PSN");
    const hp = b.enemy.mon.hp;
    fight(b, input); // POISONPOWDER fails, the tick still lands
    expect(b.enemy.mon.hp).toBeLessThan(hp);
    expect(b.messageLog).toContain("Enemy PIDGEY's\nhurt by poison!");
  });

  test.skipIf(!hasGen)("an ICE move's freeze side effect is registered at 26/256", () => {
    expect(EFFECTS.FREEZE_SIDE_EFFECT1?.kind).toBe("secondary");
    expect(data!.moves.ICE_BEAM.effect).toBe("FREEZE_SIDE_EFFECT1");
  });

  test.skipIf(!hasGen)("WRAP holds the foe and keeps hitting without the move list", () => {
    const { b, input } = setup("EKANS", 20, ["WRAP"], "RATTATA", 40, 11);
    for (let i = 0; i < 12 && b.player.trappingTurns === undefined; i++) fight(b, input);
    expect(b.player.trappingTurns).toBeDefined();
    // the foe was held on the turn it was wrapped, or is from now on
    const hp = b.enemy.mon.hp;
    tick(b, input, ["a"]); // FIGHT
    expect(b.phase).toBe("messages"); // the move list is skipped
    settle(b, input);
    expect(b.messageLog).toContain("EKANS's\nattack continues!");
    expect(b.messageLog).toContain("Enemy RATTATA\ncan't move!");
    expect(b.enemy.mon.hp).toBeLessThan(hp);
    // and it lets go after 2-5 attacks in all
    for (let i = 0; i < 6 && b.player.trappingTurns !== undefined; i++) fight(b, input);
    expect(b.player.trappingTurns).toBeUndefined();
  });

  test.skipIf(!hasGen)("a wrapped player cannot pick a move", () => {
    const { b, input } = setup("PIKACHU", 20, ["THUNDERSHOCK"], "EKANS", 40, 2);
    b.enemy.curMoves = [{ id: "WRAP", pp: 40 }];
    for (let i = 0; i < 12 && b.enemy.trappingTurns === undefined; i++) fight(b, input);
    expect(b.enemy.trappingTurns).toBeDefined();
    tick(b, input, ["a"]); // FIGHT goes straight to the held turn
    expect(b.phase).toBe("messages");
    settle(b, input);
    expect(b.messageLog).toContain("PIKACHU\ncan't move!");
  });
});

describe("battle screen layout", () => {
  test.skipIf(!hasGen)("the HUDs declare the cells the core may slide", () => {
    const { b } = makeBattle({ rolls: [0, 0, 0, 0, 0] });
    const host = new CaptureHost();
    new BattleUi().emit(host, b);
    const panels = host.ops.filter((o) => o.op === "uiPanel").map((o) => o.args);
    // side 1 is the enemy card (top-left block), side 0 the player's
    // (bottom-right): the cells paintEnemyHud / paintPlayerHud write into.
    expect(panels).toEqual([
      [1, 0, 0, 10, 4],
      [0, 10, 7, 10, 5],
    ]);
  });


  test.skipIf(!hasGen)("the action menu matches the pinned geometry", () => {
    const { b } = makeBattle({
      rolls: [0, 0, 0, 0, 0],
    });
    expect(b.phase).toBe("menu");
    const host = new CaptureHost();
    const ui = new BattleUi();
    ui.emit(host, b);
    // BATTLE_MENU_TEMPLATE: box (8,12) 12x6, labels from (10,14),
    // <PK><MN> at (16,14)+(17,14), '▶' at column 9 row 14
    expect(host.tiles(10, 14, 5)).toEqual(encodeGlyphs("FIGHT"));
    expect(host.tiles(10, 16, 4)).toEqual(encodeGlyphs("ITEM"));
    expect(host.tiles(16, 16, 3)).toEqual(encodeGlyphs("RUN"));
    expect(host.tile(16, 14)).toBe(0xe1);
    expect(host.tile(17, 14)).toBe(0xe2);
    expect(host.tile(9, 14)).toBe(0xed);
    // the menu box corners (drawBox at (8,12) 12x6)
    expect(host.tile(8, 12)).toBe(0x79);
    expect(host.tile(19, 12)).toBe(0x7b);
    expect(host.tile(8, 17)).toBe(0x7d);
    expect(host.tile(19, 17)).toBe(0x7e);
    // enemy HUD: name row 0 col 1, <LV> at (4,1), bar row 2 with the $6C
    // nub at (10,2); player HUD: name (10,7), digits (11,10), $6D at (18,9)
    expect(host.tiles(1, 0, 6)).toEqual(encodeGlyphs("PIDGEY"));
    expect(host.tile(4, 1)).toBe(HUD_LV);
    expect(host.tile(2, 2)).toBe(HUD_HP_LABEL);
    expect(host.tile(3, 2)).toBe(HUD_BAR_LEFT);
    expect(host.tile(10, 2)).toBe(HUD_CAP_NUB);
    expect(host.tiles(10, 7, 8)).toEqual(encodeGlyphs("SQUIRTLE"));
    expect(host.tile(18, 9)).toBe(HUD_CAP_DOUBLE);
    const p = b.player.mon;
    expect(host.tiles(11, 10, 7)).toEqual(
      encodeGlyphs(`${String(p.hp).padStart(3)}/${String(p.stats.hp).padStart(3)}`),
    );
  });

  test.skipIf(!hasGen)("the move menu shows names, cursor and TYPE/PP", () => {
    const { b, input } = makeBattle({ rolls: [0, 0, 0, 0, 0] });
    tick(b, input, ["a"]); // FIGHT
    expect(b.phase).toBe("moveSelect");
    const host = new CaptureHost();
    const ui = new BattleUi();
    ui.emit(host, b);
    // MoveSelectionMenu: names at column 6 from row 13, cursor column 5
    expect(host.tiles(6, 13, 6)).toEqual(encodeGlyphs("TACKLE"));
    expect(host.tiles(6, 14, 9)).toEqual(encodeGlyphs("TAIL WHIP"));
    expect(host.tile(5, 13)).toBe(0xed);
    // PrintMenuItem: TYPE/ at (1,9), the type at (2,10), PP at (5,11)
    expect(host.tiles(1, 9, 5)).toEqual(encodeGlyphs("TYPE/"));
    expect(host.tiles(2, 10, 6)).toEqual(encodeGlyphs("NORMAL"));
    expect(host.tiles(5, 11, 5)).toEqual(encodeGlyphs("35/35"));
    // the border-merge cells (#240)
    expect(host.tile(4, 12)).toBe(0x7a);
    expect(host.tile(10, 12)).toBe(0x7e);
  });

  test.skipIf(!hasGen)("the wide arena stages on open ground near the player", () => {
    // ROUTE_1 has bare ground all along the path; the search must return a
    // wide 3x6 footprint whose cells all pass openCell
    const game = new VoxelmonGame(data!, new RecorderHost(), 1);
    game.newGame();
    game.overworld.setMap("ROUTE_1", 10, 20, "down");
    const arena = arenaSearch(game.overworld.map, 10, 20, false);
    expect(arena).not.toBeNull();
    expect(arena!.shape).toBe(0); // wide
    expect(arena!.enemyCell).toEqual([arena!.x + 1, arena!.y + 1]);
    expect(arena!.playerCell).toEqual([arena!.x + 1, arena!.y + 4]);
    // the two mons stand three cells apart down the middle column
    expect(arena!.playerCell[1] - arena!.enemyCell[1]).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — battle.tape end to end
// ---------------------------------------------------------------------------

const BATTLE_SEED = 17;

async function runBattleTapeInProcess(): Promise<RecorderHost> {
  const host = new RecorderHost();
  const game = new VoxelmonGame(data!, host, BATTLE_SEED);
  game.newGame();
  const tapeText = await Bun.file(join(root, "voxelmon/tapes/battle.tape")).text();
  const tape = new TapePlayer(parseTape(tapeText));
  while (!tape.done && game.tickIndex < 100_000) {
    const step = tape.next(game);
    for (const m of step.marks) host.mark(m);
    if (tape.done) break;
    game.tick(step.buttons);
    tape.observe(game);
  }
  expect(tape.done).toBe(true);
  return host;
}

describe("battle tape", () => {
  test.skipIf(!hasGen)(
    "reaches its marks, fights and escapes, byte-deterministic x2",
    async () => {
      const a = await runBattleTapeInProcess();
      const b = await runBattleTapeInProcess();
      expect(a.marks).toEqual(["grass-edge", "battle-intro", "post-fight", "escaped"]);
      expect(a.text()).toBe(b.text());
      const trace = a.text();
      // the staging crossed the boundary: arena + battleCam up, arenaEnd down
      expect(trace).toMatch(/\no 70 \d+ \d+ \d+ \d+ \d+\n/);
      expect(trace).toContain("\no 73 0 0 256\n");
      expect(trace).toContain("\no 74\n");
      // FIGHT and RUN both happened on the battle screen
      expect(trace).toContain('s 52 1 14 "Wild PIDGEY"');
      expect(trace).toContain('s 52 1 16 "used TACKLE!"');
      expect(trace).toContain('s 52 1 14 "Got away safely!"');
    },
    60_000,
  );
});

// ---------------------------------------------------------------------------
// Playing one in a battle — the anim row holds the queue and draws
// ---------------------------------------------------------------------------

/** A battle whose dataset carries the animation tables, parked in the queue
 * with one animation row ready to run (the shape resolveTurn builds). */
function animBattle(move: string, opts: { off?: boolean } = {}): {
  b: WildBattle;
  input: FakeInput;
} {
  const save = makeSave([newMon(data!, "SQUIRTLE", 5)], {});
  if (opts.off) save.options = { animations: false };
  const b = new WildBattle(
    { ...data!, battle_anims: animData! },
    save,
    seqRng(0, 0, 0, 0, 0),
    "PIDGEY",
    3,
  );
  b.enter();
  const input = new FakeInput();
  settle(b, input);
  b.queue.push({ anim: move, attackerIsPlayer: true });
  b.phase = "messages";
  return { b, input };
}

describe("playing a move animation", () => {
  test.skipIf(!hasAnims)("the row holds the queue for the whole animation", () => {
    const { b, input } = animBattle("THUNDERBOLT");
    let drew = 0;
    let frames = 0;
    for (let i = 0; i < 600; i++) {
      tick(b, input);
      if (b.moveAnim) frames += 1;
      drew = Math.max(drew, b.animSprites().length);
      if (b.phase !== "messages") break;
    }
    // it drew, it ran for its compiled length, and the queue waited it out
    expect(drew).toBeGreaterThan(0);
    expect(frames).toBe(new MoveAnim(animData, "THUNDERBOLT", true).frames);
    expect(b.moveAnim).toBeNull();
    expect(b.animSprites()).toEqual([]);
    expect(b.phase).toBe("menu");
  });

  test.skipIf(!hasAnims)("its rows play the move's own sound", () => {
    const { b, input } = animBattle("THUNDERBOLT");
    b.audioCues.length = 0;
    for (let i = 0; i < 600 && b.phase === "messages"; i++) tick(b, input);
    const moves = b.audioCues.filter((c) => c.startsWith("move:"));
    expect(moves.length).toBeGreaterThan(0);
    // MoveSoundTable: the sfx AND the pitch/tempo modifiers that tell one
    // electric move from another (moves.json `anim`).
    const anim = (data!.moves.THUNDERBOLT as { anim?: Record<string, unknown> }).anim!;
    expect(moves[0]).toBe(`move:${anim.sound}:${anim.pitch}:${anim.tempo}`);
  });

  test.skipIf(!hasAnims)("a row can borrow another move's sound", () => {
    // TACKLE's rows name move 73 (LEECH SEED); the original does this all
    // over, so the lookup is by MoveSoundTable index, not by the move used.
    const { b, input } = animBattle("TACKLE");
    b.audioCues.length = 0;
    for (let i = 0; i < 600 && b.phase === "messages"; i++) tick(b, input);
    const moves = b.audioCues.filter((c) => c.startsWith("move:"));
    const byIndex = Object.values(data!.moves).find(
      (m) => (m as { index?: number }).index === 73,
    ) as { anim?: { sound?: string } } | undefined;
    expect(moves[0]).toBe(`move:${byIndex!.anim!.sound}:${(byIndex as never as { anim: { pitch: number } }).anim.pitch}:${(byIndex as never as { anim: { tempo: number } }).anim.tempo}`);
  });

  test.skipIf(!hasAnims)("the OPTION toggle keeps it off the screen", () => {
    const { b, input } = animBattle("THUNDERBOLT", { off: true });
    for (let i = 0; i < 600; i++) {
      tick(b, input);
      expect(b.animSprites()).toEqual([]);
      if (b.phase !== "messages") break;
    }
    expect(b.moveAnim).toBeNull();
  });

  test.skipIf(!hasAnims)("a move with no animation data still lunges", () => {
    const { b, input } = animBattle("NOT_A_MOVE");
    tick(b, input);
    expect(b.moveAnim).toBeNull();
    expect(b.animSprites()).toEqual([]);
    for (let i = 0; i < 600 && b.phase === "messages"; i++) tick(b, input);
    expect(b.phase).toBe("menu");
  });
});

// ---------------------------------------------------------------------------
// Where the battle camera stands (staging.ts chooseOrbit)
// ---------------------------------------------------------------------------

describe("the battle camera's opening angle", () => {
  /** Open ground everywhere `wall` does not say otherwise. */
  function ground(wall: (x: number, y: number) => boolean): never {
    return {
      inBounds: (x: number, y: number) => x >= 0 && y >= 0 && x < 40 && y < 40,
      isWalkableCell: (x: number, y: number) => !wall(x, y),
      isWaterCell: () => false,
    } as never;
  }

  const arena: Arena = {
    shape: 0,
    x: 18,
    y: 18,
    w: 3,
    h: 6,
    enemyCell: [19, 19],
    playerCell: [19, 22],
  };

  test("open ground keeps the framing the rig was solved for", () => {
    expect(chooseOrbit(ground(() => false), arena, 0)).toBe(0);
  });

  test("a building where the camera would stand turns it away", () => {
    // Wall off the half of the map the orbit-0 eye looks in from.
    const [ux, uy] = orbitDir(arena, 0, 0);
    const mid = [20.5 - 1.5, 20.5]; // the arena midpoint, near enough
    const behind = (x: number, y: number): boolean =>
      (x - mid[0]) * ux + (y - mid[1]) * uy > 1;
    const q8 = chooseOrbit(ground(behind), arena, 0);
    expect(q8).not.toBe(0);
    // and the angle it picked looks in over ground it can see across
    const [nx, ny] = orbitDir(arena, 0, q8);
    expect(nx * ux + ny * uy).toBeLessThan(0.5);
  });

  test("a wall on both sides still opens on the clearest one", () => {
    // Two walls, one of them further from the arena than the other: the
    // camera takes the side it can see the most of the fight from.
    const near = (x: number, _y: number): boolean => x <= 17;
    const q8 = chooseOrbit(ground(near), arena, 0);
    const [nx] = orbitDir(arena, 0, q8);
    expect(nx).toBeGreaterThan(-0.4);
  });

  test("indoors, the opening view sees the enemy past the furniture (OAKS_LAB)", () => {
    // The rival's battle in Oak's lab opened with the enemy behind a
    // bookshelf. From every cell an arena can be staged on in the lab, the
    // chosen view must see the enemy whenever any view the chooser tries can.
    const game = new VoxelmonGame(data!, new RecorderHost(), 1);
    game.newGame();
    game.overworld.setMap("OAKS_LAB", 5, 6, "up");
    const map = game.overworld.map;
    let staged = 0;
    for (let y = 0; y < map.def.height * 2; y++) {
      for (let x = 0; x < map.def.width * 2; x++) {
        if (!map.isWalkableCell(x, y)) continue;
        const a = arenaSearch(map, x, y, false);
        if (!a) continue;
        staged++;
        const view = chooseView(map, a, 1);
        let bestEnemy = Infinity;
        for (const p of [0, 64, 128, 192]) {
          for (let o = 0; o < 256; o += 32) bestEnemy = Math.min(bestEnemy, sightlineHits(map, a, 1, o, p).enemy);
        }
        expect(sightlineHits(map, a, 1, view.orbit, view.pitch).enemy).toBe(bestEnemy);
      }
    }
    expect(staged).toBeGreaterThan(0);
  });

  test("a real arena on ROUTE_1 gets an angle the map has room for", () => {
    const game = new VoxelmonGame(data!, new RecorderHost(), 1);
    game.newGame();
    game.overworld.setMap("ROUTE_1", 10, 20, "down");
    const a = arenaSearch(game.overworld.map, 10, 20, false)!;
    const q8 = chooseOrbit(game.overworld.map, a, 0);
    expect(q8).toBeGreaterThanOrEqual(0);
    expect(q8).toBeLessThan(256);
  });
});

// ---------------------------------------------------------------------------
// The gear's grids: the cursor goes the way the d-pad is pushed
// ---------------------------------------------------------------------------

describe("the move cursor", () => {
  /** In the move list, with `n` moves, cursor on slot 1. */
  function atMoves(n: number): { b: WildBattle; input: FakeInput } {
    const mon = newMon(data!, "SQUIRTLE", 30);
    // Four is what a full moveset is; trim to the count under test.
    while (mon.moves.length > n) mon.moves.pop();
    const { b, input } = makeBattle({ rolls: [0, 0, 0, 0, 0], playerMon: mon });
    expect(b.phase).toBe("menu");
    tick(b, input, ["a"]); // FIGHT
    expect(b.phase).toBe("moveSelect");
    expect(b.moveIndex).toBe(1);
    return { b, input };
  }

  test.skipIf(!hasGen)("down goes DOWN a row, not along the list", () => {
    const { b, input } = atMoves(4);
    // The gear draws them two to a row: 1 2 / 3 4.
    tick(b, input, ["down"]);
    expect(b.moveIndex).toBe(3);
    tick(b, input, ["right"]);
    expect(b.moveIndex).toBe(4);
    tick(b, input, ["up"]);
    expect(b.moveIndex).toBe(2);
    tick(b, input, ["left"]);
    expect(b.moveIndex).toBe(1);
  });

  test.skipIf(!hasGen)("it stops at the edges instead of wrapping", () => {
    const { b, input } = atMoves(4);
    tick(b, input, ["up"]);
    expect(b.moveIndex).toBe(1);
    tick(b, input, ["left"]);
    expect(b.moveIndex).toBe(1);
  });

  test.skipIf(!hasGen)("a press into an empty cell holds", () => {
    // Two moves: one row, and nothing under them to move to.
    const { b, input } = atMoves(2);
    tick(b, input, ["down"]);
    expect(b.moveIndex).toBe(1);
    tick(b, input, ["right"]);
    expect(b.moveIndex).toBe(2);
    tick(b, input, ["down"]);
    expect(b.moveIndex).toBe(2);
  });

  test.skipIf(!hasGen)("three moves: the lone one on the second row", () => {
    const { b, input } = atMoves(3);
    tick(b, input, ["right"]);
    expect(b.moveIndex).toBe(2);
    // Under slot 2 is the empty fourth cell, so it holds...
    tick(b, input, ["down"]);
    expect(b.moveIndex).toBe(2);
    // ... while under slot 1 there is a third move.
    tick(b, input, ["left"]);
    tick(b, input, ["down"]);
    expect(b.moveIndex).toBe(3);
  });
});

describe("the Kanto shiny sparkle", () => {
  /** Tick from enter() and note the frames the sparkle and the cry start. */
  function intro(rolls: number[]) {
    const save = makeSave([newMon(data!, "SQUIRTLE", 5)]);
    const b = new WildBattle(data!, save, seqRng(...rolls), "PIDGEY", 3);
    b.enter();
    const input = new FakeInput();
    let firstStar = -1;
    let cry = -1;
    let most = 0;
    for (let f = 0; f < 600 && b.phase === "messages"; f++) {
      tick(b, input, f % 2 ? ["a"] : []);
      const n = b.sparkles().length;
      most = Math.max(most, n);
      if (n > 0 && firstStar < 0) firstStar = f;
      if (cry < 0 && b.audioCues.some((c) => c.startsWith("cry:"))) cry = f;
    }
    return { firstStar, cry, most, b };
  }

  test.skipIf(!hasGen)("a mon with shiny DVs sparkles before its cry, then stops", () => {
    // attack, defense, speed, special = 10: shiny once in Gold
    const { firstStar, cry, most, b } = intro([10, 10, 10, 10, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(firstStar).toBeGreaterThanOrEqual(0);
    expect(cry).toBeGreaterThan(firstStar);
    expect(most).toBeGreaterThan(1);
    expect(b.sparkleFrame).toBe(-1);
    expect(b.sparkles()).toEqual([]);
  });

  test.skipIf(!hasGen)("an ordinary mon gets none", () => {
    const { firstStar, cry } = intro([10, 10, 10, 9, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(firstStar).toBe(-1);
    expect(cry).toBeGreaterThanOrEqual(0);
  });

  test("the stars stay small and around the enemy pic", () => {
    for (let f = 0; f < SPARKLE_FRAMES; f++) {
      for (const s of sparkleStars(f)) {
        expect(s.r).toBeGreaterThanOrEqual(1);
        expect(s.r).toBeLessThanOrEqual(8);
        expect(Math.hypot(s.x - 124, s.y - 28)).toBeLessThan(40);
      }
    }
    expect(sparkleStars(SPARKLE_FRAMES)).toEqual([]);
  });
});


describe("Red/Blue trainers' special moves (LoneMoves / TeamMoves / the champion)", () => {
  const party = (id: string, n: number) => {
    const b = new TrainerBattle(data!, makeSave([newMon(data!, "MEWTWO", 70)]) as never, seededRng(1), id, n);
    return (b as any).enemyParty as PartyMon[];
  };
  const third = (m: PartyMon) => m.moves.map((x) => x.id);

  test.skipIf(!hasGen)("gym leaders: BROCK's ONIX knows BIDE, LT.SURGE's RAICHU THUNDERBOLT, the gym GIOVANNI's RHYDON FISSURE", () => {
    const brock = party("OPP_BROCK", 1);
    expect(brock[1]!.species).toBe("ONIX");
    expect(third(brock[1]!)).toContain("BIDE");
    expect(third(brock[0]!)).not.toContain("BIDE");
    const surge = party("OPP_LT_SURGE", 1);
    expect(surge[2]!.species).toBe("RAICHU");
    expect(third(surge[2]!)).toContain("THUNDERBOLT");
    const gio = party("OPP_GIOVANNI", 3);
    expect(gio[4]!.species).toBe("RHYDON");
    expect(gio[4]!.moves[2]!.id).toBe("FISSURE");
    // the Rocket Hideout GIOVANNI is not the gym's: no lone move
    expect(party("OPP_GIOVANNI", 1).some((m) => third(m).includes("FISSURE") && m.species !== "RHYDON")).toBe(false);
  });

  test.skipIf(!hasGen)("the ELITE FOUR's fifth mon, and the champion's PIDGEOT and starter", () => {
    const lorelei = party("OPP_LORELEI", 1);
    expect(lorelei[4]!.species).toBe("LAPRAS");
    expect(lorelei[4]!.moves[2]!.id).toBe("BLIZZARD");
    expect(party("OPP_LANCE", 1)[4]!.moves[2]!.id).toBe("BARRIER");
    const champ = party("OPP_RIVAL3", 3);
    expect(champ[0]!.moves[2]!.id).toBe("SKY_ATTACK");
    expect(champ[5]!.species).toBe("CHARIZARD");
    expect(champ[5]!.moves[2]!.id).toBe("FIRE_BLAST");
  });
});
