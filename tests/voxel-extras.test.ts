// ENHANCEMENTS and CHEATS for Red / Blue / Yellow (voxelmon/game/extras.ts,
// ui/extras_layout.ts, ui/optionsmenu.ts, ui/gear/apps/cheats.ts).
//
// Layer 1 (ROM-free): the pure rules -- encounter scaling, the EXP split,
// the HM check, money, item giving on a hand-made item table.
// Layer 2 (gated on dist/voxelmon/gen): the real battles, evolutions,
// menus and the gear app against the imported Red dataset.

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";
import { WildBattle, type BattleButton, type BattleInput, type BattleSave } from "../voxelmon/game/battle/battle.ts";
import { TrainerBattle } from "../voxelmon/game/battle/trainer.ts";
import { LinkBattle } from "../voxelmon/game/battle/linkbattle.ts";
import { newMon, type PartyMon } from "../voxelmon/game/battle/mon.ts";
import { loadRuntimeData, REQUIRED_MODULES, type VoxelmonData } from "../voxelmon/game/data.ts";
import {
  encounterRateFor, expShareSplit, fillDex, giveItem, giveItemList, holdMoney, hmWithoutMove,
  MONEY_MAX, TRADE_EVO_LEVEL, tradeEvoLevel, wildMode,
} from "../voxelmon/game/extras.ts";
import { VoxelmonGame } from "../voxelmon/game/game.ts";
import { RecorderHost } from "../voxelmon/game/host.ts";
import { seededRng, seqRng, type Rng } from "../voxelmon/game/rng.ts";
import { roll } from "../voxelmon/game/rules/encounter.ts";
import { checkParty, pendingFor } from "../voxelmon/game/rules/evolution.ts";
import { gainFor } from "../voxelmon/game/rules/experience.ts";
import { expForLevel } from "../voxelmon/game/rules/growth.ts";
import { encodeSave } from "../voxelmon/game/save-lua.ts";
import { decodeSave } from "../voxelmon/game/save-read.ts";
import { fromDisk, toDisk } from "../voxelmon/game/savecompat.ts";
import { CHEAT_ROWS, CHEAT_TEXT, ENHANCEMENT_ROWS, OPTION_PAGES, SPEED_ROW } from "../voxelmon/game/ui/extras_layout.ts";
import { OptionsMenuState } from "../voxelmon/game/ui/optionsmenu.ts";
import { PartyState } from "../voxelmon/game/ui/partyscreen.ts";
import { drawKantoGear, gearTabs, gearTouchDown, gearTouchUp } from "../voxelmon/game/ui/kantogear.ts";
import { availableApps } from "../voxelmon/game/ui/gear/apps/home.ts";
import { GIVE_PAGE, givePocket } from "../voxelmon/game/ui/gear/apps/cheats.ts";
import { APPS, TOOLS, toolUnlocked } from "../voxelmon/game/ui/gear/model.ts";
import { COLS, TILE_H, TILE_W, wrap } from "../voxelmon/game/ui/gear/draw.ts";
import { KEY_W, SWITCHER_EDGE, switcherLayout, switcherWidth } from "../voxelmon/game/ui/gear/ui.ts";
import { encodeGlyphs } from "../voxelmon/game/ui/tiles.ts";

const root = join(import.meta.dir, "..");
const genDir = join(root, "dist/voxelmon/gen");
const hasGen = REQUIRED_MODULES.every((m) => existsSync(join(genDir, `${m}.json`)));
const data: VoxelmonData | null = hasGen ? await loadRuntimeData(genDir) : null;

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

class FakeInput implements BattleInput {
  private down = new Set<BattleButton>();
  private edges = new Set<BattleButton>();
  press(btn: BattleButton): void { this.edges.add(btn); this.down.add(btn); }
  clear(): void { this.edges.clear(); this.down.clear(); }
  isDown(btn: BattleButton): boolean { return this.down.has(btn); }
  wasPressed(btn: BattleButton): boolean { return this.edges.has(btn); }
}

function tick(b: WildBattle, input: FakeInput, presses: BattleButton[] = []): void {
  input.clear();
  for (const p of presses) input.press(p);
  b.update(input);
}

function settle(b: WildBattle, input: FakeInput, maxTicks = 12000): void {
  for (let i = 0; i < maxTicks; i++) {
    if (b.finished || (b.phase !== "messages" && b.phase !== "forget")) return;
    // a full moveset's learn prompt: decline (the last row is cancel)
    if (b.phase === "forget") { tick(b, input, ["b"]); continue; }
    tick(b, input, ["a"]);
  }
  throw new Error("battle did not settle");
}

function makeSave(party: PartyMon[], options: Record<string, unknown> = {}, inventory: Record<string, number> = {}): BattleSave & { options: Record<string, unknown>; money: number } {
  return { party, inventory, player: { name: "RED", rival: "BLUE" }, options, money: 0, pokedex: { seen: {}, owned: {} } } as never;
}

/** From the action menu: FIGHT (instant victory) and let it all play out. */
function fight(b: WildBattle, input: FakeInput): void {
  expect(b.phase).toBe("menu");
  b.menuIndex = 1;
  tick(b, input, ["a"]);
  settle(b, input);
}

function throwBall(b: WildBattle, input: FakeInput, ball = "POKE_BALL"): void {
  b.openItems();
  b.itemIndex = b.itemList.indexOf(ball);
  expect(b.itemIndex).toBeGreaterThanOrEqual(0);
  tick(b, input, ["a"]);
  settle(b, input);
}

/** An rng that counts its rolls and answers from a list (then 0). */
function countingRng(...v: number[]): Rng & { calls: number } {
  const r = seqRng(...v) as Rng & { calls: number };
  r.calls = 0;
  const byte = r.byte.bind(r);
  r.byte = () => { r.calls += 1; return byte(); };
  return r;
}

class MenuHost extends RecorderHost {
  saved: string | undefined;
  pic(): void {}
  picHide(): void {}
  saveWrite(text: string): void { this.saved = text; }
  saveData(): string | undefined { return this.saved; }
}

function makeGame(): VoxelmonGame {
  const game = new VoxelmonGame(data!, new MenuHost(), 1);
  game.newGame();
  game.closeToOverworld();
  return game;
}

function tap(game: VoxelmonGame, mask: number): void {
  game.tick(mask);
  game.tick(0);
}

// ---------------------------------------------------------------------------
// WILD ENCOUNTERS
// ---------------------------------------------------------------------------

describe("WILD ENCOUNTERS", () => {
  test("NONE stops the roll, LESS halves the rate, MORE doubles it (capped), NORMAL is the cart", () => {
    expect(encounterRateFor(25, "normal")).toBe(25);
    expect(encounterRateFor(25, "less")).toBe(12);
    expect(encounterRateFor(25, "more")).toBe(50);
    expect(encounterRateFor(200, "more")).toBe(255);
    expect(encounterRateFor(1, "less")).toBe(1); // a map that has encounters keeps some
    expect(encounterRateFor(0, "more")).toBe(0); // and one without gets none
    for (const r of [1, 25, 255]) expect(encounterRateFor(r, "none")).toBe(0);
  });

  test("the step roll honours the mode, and NONE spends no roll at all", () => {
    const def = { grass: { rate: 25, slots: Array.from({ length: 10 }, () => ({ species: "PIDGEY", level: 3 })) } };
    // gate byte 30: over 25 (NORMAL) and 12 (LESS), under 50 (MORE)
    expect(roll(def as never, seqRng(30, 0))).toBeNull();
    expect(roll(def as never, seqRng(30, 0), undefined, "less")).toBeNull();
    expect(roll(def as never, seqRng(30, 0), undefined, "more")).toEqual({ species: "PIDGEY", level: 3 });
    // gate byte 20: under NORMAL's 25, over LESS's 12
    expect(roll(def as never, seqRng(20, 0), undefined, "normal")).not.toBeNull();
    expect(roll(def as never, seqRng(20, 0), undefined, "less")).toBeNull();
    const r = countingRng(0, 0);
    expect(roll(def as never, r, undefined, "none")).toBeNull();
    expect(r.calls).toBe(0);
  });

  test("an unset or unknown setting reads NORMAL", () => {
    expect(wildMode(undefined)).toBe("normal");
    expect(wildMode({ options: {} })).toBe("normal");
    expect(wildMode({ options: { wildEncounters: "lots" } })).toBe("normal");
    expect(wildMode({ options: { wildEncounters: "none" } })).toBe("none");
  });

  test.skipIf(!hasGen)("NONE in the grass: a hundred steps' rolls and no battle", () => {
    const game = makeGame();
    game.save.options.wildEncounters = "none";
    const ow = game.overworld;
    ow.setMap("ROUTE_1", 9, 27, "up");
    const grass: [number, number][] = [];
    for (let y = 0; y < ow.map.heightCells; y++) for (let x = 0; x < ow.map.widthCells; x++) if (ow.map.isGrassCell(x, y)) grass.push([x, y]);
    expect(grass.length).toBeGreaterThan(0);
    // the overworld's own encounter pass, a hundred times on a grass cell
    const p = ow.player;
    [p.cellX, p.cellY] = grass[0]!;
    const before = ow.encounterCount;
    for (let i = 0; i < 100; i++) (ow as unknown as { checkEncounter?: () => void; onStepComplete: () => void }).onStepComplete();
    expect(ow.encounterCount).toBe(before);
    expect(game.stackKinds()).not.toContain("battle");
  });
});

// ---------------------------------------------------------------------------
// EXP: PARTY EXP SHARE and EXP FOR CATCHING
// ---------------------------------------------------------------------------

describe("PARTY EXP SHARE", () => {
  test("the split: full for a mon that fought, half the base for the bench", () => {
    expect(expShareSplit(true)).toBe(1);
    expect(expShareSplit(false)).toBe(2);
  });

  test.skipIf(!hasGen)("a win pays the lead in full and every standing bench mon half; the fainted get nothing", () => {
    const lead = newMon(data!, "SQUIRTLE", 10);
    const bench = newMon(data!, "PIDGEY", 10);
    const down = newMon(data!, "RATTATA", 10);
    down.hp = 0;
    const save = makeSave([lead, bench, down], { partyExpShare: true, instantVictory: true }, { EXP_ALL: 1 });
    const b = new WildBattle(data!, save, seededRng(3), "GEODUDE", 12);
    b.enter();
    const input = new FakeInput();
    settle(b, input);
    const e0 = [lead.exp, bench.exp, down.exp];
    fight(b, input);
    expect(b.result).toBe("win");
    const def = data!.pokemon.GEODUDE!;
    expect(lead.exp - e0[0]!).toBe(gainFor(def, 12, false, 1));
    expect(bench.exp - e0[1]!).toBe(gainFor(def, 12, false, 2));
    expect(down.exp).toBe(e0[2]!);
    // EXP.ALL in the bag changes nothing while the share is on
    expect(b.messageLog.some((m) => m.includes("EXP.ALL"))).toBe(false);
  });

  test.skipIf(!hasGen)("a bench mon levels up and learns its move; another is queued for evolution", () => {
    const lead = newMon(data!, "MEWTWO", 70);
    // PIDGEY one EXP short of the level its next move comes at
    const learn = data!.pokemon.PIDGEY!.learnset.find((e) => e.level > 5)!;
    const bench = newMon(data!, "PIDGEY", learn.level - 1);
    bench.moves = bench.moves.filter((m) => m.id !== learn.move).slice(0, 2);
    bench.exp = expForLevel(data!.pokemon.PIDGEY!.growthRate, learn.level) - 1;
    // CHARMELEON one EXP short of 36, CHARIZARD's level
    const evo = newMon(data!, "CHARMELEON", 35);
    evo.exp = expForLevel(data!.pokemon.CHARMELEON!.growthRate, 36) - 1;
    const save = makeSave([lead, bench, evo], { partyExpShare: true, instantVictory: true });
    const b = new WildBattle(data!, save, seededRng(9), "ONIX", 40);
    b.enter();
    const input = new FakeInput();
    settle(b, input);
    fight(b, input);
    expect(bench.level).toBeGreaterThanOrEqual(learn.level);
    expect(bench.moves.map((m) => m.id)).toContain(learn.move);
    expect(b.messageLog.some((m) => m.startsWith("PIDGEY grew\nto level"))).toBe(true);
    expect(b.messageLog.some((m) => m.startsWith("PIDGEY learned"))).toBe(true);
    expect(evo.level).toBeGreaterThanOrEqual(36);
    expect(b.leveledUp.has(evo)).toBe(true);
    const pending = checkParty(data!, save.party, b.leveledUp);
    expect(pending.map((p) => p.to)).toContain("CHARIZARD");
  });

  test.skipIf(!hasGen)("off: the cart's rule, the bench gets nothing", () => {
    const lead = newMon(data!, "SQUIRTLE", 10);
    const bench = newMon(data!, "PIDGEY", 10);
    const save = makeSave([lead, bench], { instantVictory: true });
    const b = new WildBattle(data!, save, seededRng(3), "GEODUDE", 12);
    b.enter();
    const input = new FakeInput();
    settle(b, input);
    const e0 = bench.exp;
    fight(b, input);
    expect(bench.exp).toBe(e0);
  });
});

describe("EXP FOR CATCHING", () => {
  test.skipIf(!hasGen)("a catch pays the battle's EXP before the mon is stored", () => {
    const lead = newMon(data!, "SQUIRTLE", 10);
    const save = makeSave([lead], { expForCatching: true, alwaysCatch: true }, { POKE_BALL: 3 });
    const b = new WildBattle(data!, save, seededRng(4), "PIDGEY", 8);
    b.enter();
    const input = new FakeInput();
    settle(b, input);
    const e0 = lead.exp;
    throwBall(b, input);
    expect(b.result).toBe("caught");
    expect(lead.exp - e0).toBe(gainFor(data!.pokemon.PIDGEY!, 8, false, 1));
    expect(save.party.length).toBe(2);
    expect(save.party[1]!.species).toBe("PIDGEY");
    const log = b.messageLog.join("|");
    expect(log.indexOf("was\ncaught")).toBeLessThan(log.indexOf("EXP. Points"));
  });

  test.skipIf(!hasGen)("off: a catch pays nothing", () => {
    const lead = newMon(data!, "SQUIRTLE", 10);
    const save = makeSave([lead], { alwaysCatch: true }, { POKE_BALL: 3 });
    const b = new WildBattle(data!, save, seededRng(4), "PIDGEY", 8);
    b.enter();
    const input = new FakeInput();
    settle(b, input);
    const e0 = lead.exp;
    throwBall(b, input);
    expect(b.result).toBe("caught");
    expect(lead.exp).toBe(e0);
  });
});

// ---------------------------------------------------------------------------
// TRADE EVO LV. 40
// ---------------------------------------------------------------------------

describe("TRADE EVO LV. 40", () => {
  test("the level, only while the option is on", () => {
    expect(tradeEvoLevel({ options: { tradeEvoLv40: true } })).toBe(TRADE_EVO_LEVEL);
    expect(TRADE_EVO_LEVEL).toBe(40);
    expect(tradeEvoLevel({ options: {} })).toBeUndefined();
  });

  test.skipIf(!hasGen)("all four trade evolutions fire on a level-up at 40, not at 39, not without the option", () => {
    for (const [from, to] of [["KADABRA", "ALAKAZAM"], ["MACHOKE", "MACHAMP"], ["GRAVELER", "GOLEM"], ["HAUNTER", "GENGAR"]] as const) {
      const at40 = newMon(data!, from, 40);
      const at39 = newMon(data!, from, 39);
      expect(checkParty(data!, [at40], new Set([at40]), { tradeLevel: 40 }).map((p) => p.to)).toEqual([to]);
      expect(checkParty(data!, [at39], new Set([at39]), { tradeLevel: 40 })).toEqual([]);
      expect(checkParty(data!, [at40], new Set([at40]))).toEqual([]);
      // only on a level-up: a stone or the manual trigger does nothing
      expect(pendingFor(data!, at40, { kind: "item", item: "MOON_STONE", tradeLevel: 40 })).toBeNull();
      // and a real trade still works either way
      expect(pendingFor(data!, at39, { kind: "trade" })?.[0]).toBe(to);
    }
    // a LEVEL evolution is untouched
    const ivy = newMon(data!, "IVYSAUR", 40);
    expect(checkParty(data!, [ivy], new Set([ivy]), { tradeLevel: 40 }).map((p) => p.to)).toEqual(["VENUSAUR"]);
  });

  test.skipIf(!hasGen)("through the game's own after-battle flow: the evolution movie comes up", () => {
    const game = makeGame();
    const kad = newMon(data!, "KADABRA", 40);
    game.save.party = [kad];
    game.runEvolutions(new Set([kad]));
    expect(game.stackKinds().at(-1)).not.toBe("evolution");
    game.save.options.tradeEvoLv40 = true;
    game.runEvolutions(new Set([kad]));
    expect(game.stackKinds().at(-1)).toBe("evolution");
  });
});

// ---------------------------------------------------------------------------
// HMS WITHOUT MOVE
// ---------------------------------------------------------------------------

describe("HMS WITHOUT MOVE", () => {
  const base = { options: { hmsWithoutMove: true }, inventory: { HM_CUT: 1, CASCADEBADGE: 1 } as Record<string, number> };

  test("the option, the HM (bag or PC) and the cart's badge, all three", () => {
    expect(hmWithoutMove(base, "CUT")).toBe(true);
    expect(hmWithoutMove({ ...base, options: {} }, "CUT")).toBe(false);
    expect(hmWithoutMove({ ...base, inventory: { HM_CUT: 1 } }, "CUT")).toBe(false);
    expect(hmWithoutMove({ ...base, inventory: { CASCADEBADGE: 1 } }, "CUT")).toBe(false);
    expect(hmWithoutMove({ ...base, inventory: { CASCADEBADGE: 1 }, pcItems: { HM_CUT: 1 } }, "CUT")).toBe(true);
    // each HM's own badge
    const all = { options: { hmsWithoutMove: true }, inventory: { HM_FLY: 1, HM_SURF: 1, HM_STRENGTH: 1, HM_FLASH: 1 } as Record<string, number> };
    expect(hmWithoutMove(all, "FLY")).toBe(false);
    all.inventory.THUNDERBADGE = 1;
    all.inventory.SOULBADGE = 1;
    all.inventory.RAINBOWBADGE = 1;
    all.inventory.BOULDERBADGE = 1;
    for (const m of ["FLY", "SURF", "STRENGTH", "FLASH"]) expect(hmWithoutMove(all, m)).toBe(true);
    // not the TM field moves
    expect(hmWithoutMove(all, "DIG")).toBe(false);
  });

  test.skipIf(!hasGen)("the party menu offers CUT on a mon that does not know it, and it runs", () => {
    const game = makeGame();
    const mon = newMon(data!, "PIDGEY", 10);
    mon.moves = [{ id: "TACKLE", pp: 35 }];
    game.save.party = [mon];
    Object.assign(game.save.inventory, { HM_CUT: 1, CASCADEBADGE: 1 });
    const menu = new PartyState(game as never);
    const items = () => (menu.view().submenuItems);
    expect(items()).not.toContain("CUT");
    game.save.options.hmsWithoutMove = true;
    expect(items()).toEqual(["STATS", "SWITCH", "CUT", "CANCEL"]);
    // the box never outgrows the screen: seven rows at most
    Object.assign(game.save.inventory, { HM_FLY: 1, HM_SURF: 1, HM_STRENGTH: 1, HM_FLASH: 1, THUNDERBADGE: 1, SOULBADGE: 1, RAINBOWBADGE: 1, BOULDERBADGE: 1 });
    mon.moves = [{ id: "DIG", pp: 10 }, { id: "TELEPORT", pp: 20 }, { id: "SOFTBOILED", pp: 10 }];
    expect(items().length).toBeLessThanOrEqual(7);
    expect(items().at(-1)).toBe("CANCEL");
    // CUT from the menu: the menus close and the move's own verb runs
    mon.moves = [{ id: "TACKLE", pp: 35 }];
    game.push(menu);
    tap(game, VOX_BTN.a); // the mon
    const at = items().indexOf("CUT");
    for (let i = 0; i < at; i++) tap(game, VOX_BTN.down);
    tap(game, VOX_BTN.a);
    expect(game.stackKinds()).not.toContain("party");
    expect(game.stackKinds().at(-1)).toBe("textbox"); // "No tree to cut" or the cut itself
  });

  test("the gear's TOOLS app shows the HM moves the option allows", () => {
    const cut = TOOLS.find((t) => t.key === "cut")!;
    const save = { options: {}, inventory: { HM_CUT: 1, CASCADEBADGE: 1 }, party: [{ species: "PIDGEY", moves: [{ id: "TACKLE" }] }] };
    expect(toolUnlocked(cut, save as never)).toBe(false);
    (save.options as Record<string, unknown>).hmsWithoutMove = true;
    expect(toolUnlocked(cut, save as never)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ALWAYS CATCH
// ---------------------------------------------------------------------------

describe("ALWAYS CATCH", () => {
  test.skipIf(!hasGen)("a ball that would break out catches; without the cheat the same throw fails", () => {
    // rolls of 255 everywhere: a POKe BALL at a full-HP MEWTWO never catches
    const run = (alwaysCatch: boolean) => {
      const save = makeSave([newMon(data!, "SQUIRTLE", 10)], { alwaysCatch }, { POKE_BALL: 2 });
      const b = new WildBattle(data!, save, seqRng(...Array(200).fill(255)), "MEWTWO", 70);
      b.enter();
      const input = new FakeInput();
      settle(b, input);
      throwBall(b, input);
      return { b, save };
    };
    const off = run(false);
    expect(off.b.result).not.toBe("caught");
    const on = run(true);
    expect(on.b.result).toBe("caught");
    expect(on.save.inventory.POKE_BALL).toBe(1); // the ball is still spent
    expect(on.save.pokedex!.owned!.MEWTWO).toBe(true);
  });

  test.skipIf(!hasGen)("the tower ghost still dodges and a trainer still blocks", () => {
    const ghost = makeSave([newMon(data!, "SQUIRTLE", 10)], { alwaysCatch: true }, { POKE_BALL: 2 });
    const g = new WildBattle(data!, ghost, seededRng(1), "MAROWAK", 30);
    g.noCatch = true;
    g.enter();
    const gi = new FakeInput();
    settle(g, gi);
    throwBall(g, gi);
    expect(g.result).not.toBe("caught");
    expect(g.messageLog.join("|")).toContain("dodged");

    const tr = makeSave([newMon(data!, "SQUIRTLE", 20)], { alwaysCatch: true }, { POKE_BALL: 2 });
    const t = new TrainerBattle(data!, tr, seededRng(1), "OPP_YOUNGSTER", 1);
    t.enter();
    const ti = new FakeInput();
    settle(t, ti);
    throwBall(t, ti);
    expect(t.result).toBeNull();
    expect(t.messageLog.join("|")).toContain("blocked the BALL");
  });
});

// ---------------------------------------------------------------------------
// INSTANT VICTORY
// ---------------------------------------------------------------------------

describe("INSTANT VICTORY", () => {
  test.skipIf(!hasGen)("a wild battle: FIGHT faints the foe, the EXP is paid, the battle is won", () => {
    const lead = newMon(data!, "SQUIRTLE", 5);
    const save = makeSave([lead], { instantVictory: true });
    const b = new WildBattle(data!, save, seededRng(2), "PIDGEY", 30);
    b.enter();
    const input = new FakeInput();
    settle(b, input);
    const e0 = lead.exp;
    fight(b, input);
    expect(b.result).toBe("win");
    expect(b.enemy.mon.hp).toBe(0);
    // no move was used, by either side
    expect(b.messageLog.some((m) => m.includes("used"))).toBe(false);
    expect(lead.exp).toBeGreaterThan(e0);
    expect(b.messageLog.some((m) => m.includes("fainted"))).toBe(true);
  });

  test.skipIf(!hasGen)("a trainer: one FIGHT a mon, each mon's EXP, then the prize money", () => {
    const lead = newMon(data!, "SQUIRTLE", 5);
    const save = makeSave([lead], { instantVictory: true });
    save.money = 100;
    const b = new TrainerBattle(data!, save, seededRng(2), "OPP_BUG_CATCHER", 2);
    b.enter();
    const input = new FakeInput();
    settle(b, input);
    const party = (b as unknown as { enemyParty: PartyMon[] }).enemyParty;
    expect(party.length).toBeGreaterThan(1);
    let fights = 0;
    while (!b.finished && fights < 10) {
      if (b.phase === "menu") { fight(b, input); fights += 1; } else settle(b, input);
    }
    expect(b.result).toBe("win");
    expect(fights).toBe(party.length);
    expect(party.every((m) => m.hp === 0)).toBe(true);
    const def = (data as unknown as { trainers: Record<string, { baseMoney: number }> }).trainers.OPP_BUG_CATCHER!;
    const top = Math.max(...party.map((m) => m.level));
    expect(save.money).toBe(100 + def.baseMoney * top);
    expect(b.messageLog.some((m) => m.includes("paid out"))).toBe(true);
  });

  test.skipIf(!hasGen)("a gym leader through the game: the win, the badge, the TM and the flag", () => {
    const game = makeGame();
    game.save.options.instantVictory = true;
    game.save.party = [newMon(data!, "SQUIRTLE", 8)];
    const ow = game.overworld;
    ow.setMap("PEWTER_GYM", 4, 3, "up");
    ow.showMapText("TEXT_PEWTERGYM_BROCK");
    let guard = 0;
    while (guard++ < 20000 && !(game.save.flags.EVENT_BEAT_BROCK && game.stackKinds().length === 1)) {
      const top = game.stackKinds().at(-1);
      if (top === "battle") {
        const b = (game as unknown as { stack: { battle?: WildBattle }[] }).stack.at(-1)!.battle!;
        if (b.phase === "menu") { b.menuIndex = 1; }
      }
      game.tick(guard % 2 === 0 ? VOX_BTN.a : 0);
    }
    expect(game.save.flags.EVENT_BEAT_BROCK).toBe(true);
    expect(game.save.inventory.BOULDERBADGE).toBe(1);
    expect(game.save.inventory.TM_BIDE).toBe(1);
  });

  test.skipIf(!hasGen)("never over a link, never against the unidentified GHOST, never in a demo", () => {
    expect((LinkBattle.prototype as unknown as { allowsCheats(): boolean }).allowsCheats.call({})).toBe(false);
    const save = makeSave([newMon(data!, "SQUIRTLE", 5)], { instantVictory: true });
    const g = new WildBattle(data!, save, seededRng(1), "GASTLY", 20);
    g.makeGhost();
    g.enter();
    const input = new FakeInput();
    settle(g, input);
    expect(g.instantVictoryOn()).toBe(false);
    const m = new WildBattle(data!, save, seededRng(1), "MAROWAK", 30);
    m.makeUnveiledGhost(); // the scope: a real battle, so it counts
    expect(m.instantVictoryOn()).toBe(true);
    const demo = new WildBattle(data!, save, seededRng(1), "WEEDLE", 5);
    demo.makeOldManDemo();
    expect(demo.instantVictoryOn()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// INFINITE MONEY, DEX FULL, GIVE ITEMS
// ---------------------------------------------------------------------------

describe("INFINITE MONEY", () => {
  test("held at 999999 while on; off keeps what is there", () => {
    const save: { options: Record<string, unknown>; money: number } = { options: { infiniteMoney: true }, money: 1200 };
    holdMoney(save);
    expect(save.money).toBe(MONEY_MAX);
    save.money -= 5000; // a purchase
    holdMoney(save);
    expect(save.money).toBe(999999);
    save.options.infiniteMoney = false;
    save.money -= 5000;
    holdMoney(save);
    expect(save.money).toBe(994999);
  });

  test.skipIf(!hasGen)("the game holds it every frame", () => {
    const game = makeGame();
    game.save.money = 3000;
    game.tick(0);
    expect(game.save.money).toBe(3000);
    game.save.options.infiniteMoney = true;
    game.tick(0);
    expect(game.save.money).toBe(999999);
  });
});

describe("DEX FULL", () => {
  test.skipIf(!hasGen)("every one of the 151 seen and owned", () => {
    const save: any = { pokedex: { seen: { PIDGEY: true }, owned: { PIDGEY: true } } };
    expect(fillDex(save, data!)).toBe(150);
    expect(Object.keys(save.pokedex.owned).length).toBe(151);
    expect(Object.keys(save.pokedex.seen).length).toBe(151);
    expect(save.pokedex.owned.MEW).toBe(true);
    expect(fillDex(save, data!)).toBe(0);
  });
});

describe("GIVE ITEMS", () => {
  test.skipIf(!hasGen)("every real item, none of the glitch ones, in the cart's order", () => {
    const list = giveItemList(data!);
    for (const bad of ["FLOOR_1F", "FLOOR_B4F", "ITEM_2C", "ITEM_32", "SURFBOARD", "BOULDERBADGE", "COIN", "POKEDEX", "SAFARI_BALL"]) {
      expect(list).not.toContain(bad);
    }
    for (const good of ["MASTER_BALL", "RARE_CANDY", "PP_UP", "BICYCLE", "SILPH_SCOPE", "HM_SURF", "TM_MEGA_PUNCH", "TM_SUBSTITUTE"]) {
      expect(list).toContain(good);
    }
    expect(list[0]).toBe("MASTER_BALL");
    expect(list.indexOf("HM_CUT")).toBeLessThan(list.indexOf("TM_MEGA_PUNCH"));
    expect(list.filter((id) => id.startsWith("TM_")).length).toBe(50);
    expect(list.filter((id) => id.startsWith("HM_")).length).toBe(5);
    // every name fits the picker's column
    for (const id of list) expect(encodeGlyphs(data!.items[id]!.name).length).toBeLessThanOrEqual(13);
  });

  test.skipIf(!hasGen)("into the bag, the overflow to the PC, key items and HMs one only", () => {
    const save: any = { inventory: {}, bagOrder: [] };
    expect(giveItem(save, data!, "POTION", 10)).toEqual({ bag: 10, pc: 0 });
    expect(save.inventory.POTION).toBe(10);
    save.inventory.POTION = 95;
    expect(giveItem(save, data!, "POTION", 10)).toEqual({ bag: 4, pc: 6 });
    expect(save.inventory.POTION).toBe(99);
    expect(save.pcItems.POTION).toBe(6);
    // a full bag sends a new item to the PC
    const twenty = giveItemList(data!).filter((id) => !data!.items[id]!.keyItem && !id.startsWith("HM_")).slice(0, 20);
    const full: any = { inventory: Object.fromEntries(twenty.map((id) => [id, 1])), bagOrder: [...twenty] };
    const extra = giveItemList(data!).find((id) => !twenty.includes(id) && !data!.items[id]!.keyItem && !id.startsWith("HM_"))!;
    expect(giveItem(full, data!, extra, 3)).toEqual({ bag: 0, pc: 3 });
    // key items and HMs: one, and never a second
    const k: any = { inventory: {} };
    expect(giveItem(k, data!, "BICYCLE", 5)).toEqual({ bag: 1, pc: 0 });
    expect(giveItem(k, data!, "BICYCLE", 1).refused).toBe("have");
    expect(giveItem(k, data!, "HM_SURF", 9)).toEqual({ bag: 1, pc: 0 });
    // a glitch id is refused outright
    expect(giveItem(k, data!, "FLOOR_1F", 1).refused).toBe("full");
    expect(k.inventory.FLOOR_1F).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// the OPTION screen's pages
// ---------------------------------------------------------------------------

describe("the OPTION screen: SETTINGS and ENHANCEMENTS", () => {
  test("SETTINGS keeps its rows and ends on CHEATS; ENHANCEMENTS has SPEED and the four toggles", () => {
    const save: any = {};
    const pressed: Record<string, boolean> = {};
    const st = new OptionsMenuState({ input: { pressed }, pop() {}, save } as never);
    const v = st.view();
    expect(v.pages).toEqual(OPTION_PAGES);
    expect(v.page).toBe(0);
    expect(v.rows[0]!.label).toBe("TEXT SPEED");
    expect(v.rows.at(-1)).toEqual({ label: "CHEATS", choices: ["OFF", "ON"], index: 0 });
    (st as any).set(v.rows.length - 1, 1);
    expect(save.options.cheats).toBe(true);

    st.turnPage(1);
    const e = st.view();
    expect(e.page).toBe(1);
    expect(e.index).toBe(0);
    expect(e.rows.map((r) => r.label)).toEqual([SPEED_ROW, ...ENHANCEMENT_ROWS].map((r) => r.label));
    expect(e.rows.every((r) => r.index === 0)).toBe(true); // 1X, and OFF, unless set
    // walk to TRADE EVO and turn it on
    pressed.down = true; st.update(); st.update(); st.update(); pressed.down = false;
    pressed.right = true; st.update(); pressed.right = false;
    expect(save.options.tradeEvoLv40).toBe(true);
    expect(st.view().rows[3]!.index).toBe(1);
    // SELECT turns back to SETTINGS
    pressed.select = true; st.update(); pressed.select = false;
    expect(st.view().page).toBe(0);
  });

  test("every label and choice row fits the 20 columns", () => {
    for (const r of [SPEED_ROW, ...ENHANCEMENT_ROWS]) {
      expect(encodeGlyphs(r.label).length).toBeLessThanOrEqual(19);
      const w = r.choices.reduce((n, c) => n + c.length + 2, 1);
      expect(w).toBeLessThanOrEqual(20);
    }
    for (const p of OPTION_PAGES) expect(p.length).toBeLessThanOrEqual(14); // between the arrows
  });

  test.skipIf(!hasGen)("L/R turn the pages while the screen is up, and the gear stays put", () => {
    const game = makeGame();
    const menu = new OptionsMenuState(game as never);
    game.push(menu);
    const was = game.gearView;
    game.cycleGearView(1);
    expect(menu.view().page).toBe(1);
    expect(game.gearView).toBe(was);
    game.cycleGearView(-1);
    expect(menu.view().page).toBe(0);
    tap(game, VOX_BTN.b);
    game.cycleGearView(1);
    expect(game.gearView).not.toBe(was); // closed: the shoulders are the gear's again
  });

  test.skipIf(!hasGen)("the page's name between the arrows, a rule, then the rows; nothing past column 19", () => {
    class GridHost extends MenuHost {
      grid: number[][] = Array.from({ length: 18 }, () => Array(20).fill(-1));
      outside = 0;
      uiClear(): void { this.grid.forEach((r) => r.fill(-1)); }
      uiTile(x: number, y: number, t: number): void {
        if (x < 0 || y < 0 || x >= 20 || y >= 18) { this.outside += 1; return; }
        this.grid[y]![x] = t;
      }
      uiFill(x: number, y: number, w: number, h: number, t: number): void {
        for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) this.uiTile(i, j, t);
      }
    }
    const host = new GridHost();
    const game = new VoxelmonGame(data!, host, 1);
    game.newGame();
    game.closeToOverworld();
    const menu = new OptionsMenuState(game as never);
    game.push(menu);
    const rowText = (y: number, x: number, s: string) => {
      const codes = encodeGlyphs(s);
      return host.grid[y]!.slice(x, x + codes.length);
    };
    game.tick(0);
    // the rows where they always were; the page on the bottom line
    expect(rowText(1, 1, "TEXT SPEED")).toEqual(encodeGlyphs("TEXT SPEED"));
    expect(rowText(17, 6, "SETTINGS")).toEqual(encodeGlyphs("SETTINGS"));
    expect(host.grid[17]![4]).toBe(0x13); // the left arrow (UI_TILE.arrowLeft)
    // the shoulder buttons against the arrows' outer sides: L◀ SETTINGS ▶R
    expect(host.grid[17]![3]).toBe(encodeGlyphs("L")[0]);
    expect(host.grid[17]![16]).toBe(encodeGlyphs("R")[0]);
    expect(host.grid[16]![18]).toBe(0xee); // more below: the GB's ▼
    expect(host.grid[0]!.every((t) => t === host.grid[0]![0])).toBe(true); // the top line stays blank
    menu.turnPage(1);
    game.tick(0);
    expect(rowText(17, 4, "ENHANCEMENTS")).toEqual(encodeGlyphs("ENHANCEMENTS"));
    expect(host.grid[17]![2]).toBe(0x13);
    // L and R a column in from either edge
    expect(host.grid[17]![1]).toBe(encodeGlyphs("L")[0]);
    expect(host.grid[17]![18]).toBe(encodeGlyphs("R")[0]);
    expect(host.grid[17]![0]).toBe(host.grid[17]![19]);
    expect(rowText(1, 1, "SPEED")).toEqual(encodeGlyphs("SPEED"));
    expect(rowText(3, 2, "1X")).toEqual(encodeGlyphs("1X"));
    expect(rowText(5, 1, "EXP FOR CATCHING")).toEqual(encodeGlyphs("EXP FOR CATCHING"));
    expect(host.outside).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// the gear's CHEATS app
// ---------------------------------------------------------------------------

describe("the gear's CHEATS app", () => {
  function frame(game: VoxelmonGame): void {
    drawKantoGear((game as unknown as { host: MenuHost }).host as never, game as never);
  }
  const at = (cx: number, cy: number): [number, number] => [cx * TILE_W + TILE_W / 2, cy * TILE_H + TILE_H / 2];
  function touch(game: VoxelmonGame, cx: number, cy: number): void {
    frame(game);
    const [x, y] = at(cx, cy);
    gearTouchDown(game as never, x, y);
    gearTouchUp(game as never);
  }

  test.skipIf(!hasGen)("absent until OPTION's CHEATS is ON; off again hides it and keeps the cheats", () => {
    const game = makeGame();
    expect(availableApps(game)).not.toContain("cheats");
    expect(gearTabs(game as never).map((t) => t.id)).not.toContain("cheats");
    game.save.options.cheats = true;
    expect(availableApps(game).at(-1)).toBe("cheats");
    game.setGearView("cheats");
    game.save.options.alwaysCatch = true;
    game.save.options.cheats = false;
    expect(availableApps(game)).not.toContain("cheats");
    expect(game.save.options.alwaysCatch).toBe(true);
  });

  test.skipIf(!hasGen)("with every app on offer, CHEATS takes the right of the bottom row, beside ENHANCEMENTS", () => {
    const game = makeGame();
    game.save.inventory.TOWN_MAP = 1;
    game.save.flags.EVENT_GOT_POKEDEX = true;
    (game as { data: any }).data = { ...(game.data as object), atlas: { ...((game.data as any).atlas ?? {}), townMapPage: 0 } };
    game.save.options.cheats = true;
    expect(availableApps(game).length).toBe(15); // HOME + 14 (ENHANCEMENTS is always there)
    game.setGearView("home");
    touch(game, 13, 17);
    expect(game.gearView).toBe("cheats");
  });

  test.skipIf(!hasGen)("its rows: WILD cycles, the toggles flip, DEX FULL asks first", () => {
    const game = makeGame();
    game.save.options.cheats = true;
    game.setGearView("cheats");
    const o = game.save.options;
    // WILD ENCOUNTERS' value under its label (row 3), right
    touch(game, 15, 3);
    expect(o.wildEncounters).toBe("more");
    touch(game, 15, 3);
    expect(o.wildEncounters).toBe("none");
    // the toggles' pills: ALWAYS CATCH's on its row (5); INSTANT VICTORY's
    // and INFINITE MONEY's under their labels (8, 11)
    touch(game, 17, 5);
    expect(o.alwaysCatch).toBe(true);
    touch(game, 17, 8);
    expect(o.instantVictory).toBe(true);
    touch(game, 17, 11);
    expect(o.infiniteMoney).toBe(true);
    touch(game, 17, 11);
    expect(o.infiniteMoney).toBe(false);
    // the second page (the pager's right arrow): DEX FULL: FILL, then NO
    // leaves the dex alone, YES fills it
    touch(game, 17, 16);
    touch(game, 16, 2);
    touch(game, 9, 11); // NO
    expect(Object.keys(game.save.pokedex.owned).length).toBe(0);
    touch(game, 16, 2);
    touch(game, 9, 7); // YES
    expect(Object.keys(game.save.pokedex.owned).length).toBe(151);
  });

  test.skipIf(!hasGen)("GIVE ITEMS: pockets, pages, a quantity, YES, and it is in the bag", () => {
    const game = makeGame();
    game.save.options.cheats = true;
    game.setGearView("cheats");
    touch(game, 17, 16); // the second page
    touch(game, 16, 4); // OPEN
    const ui = () => (game as unknown as { gearUi: Record<string, any> }).gearUi.cheats!;
    expect(ui().give).toBeTruthy();
    const items = givePocket(game.data, "items");
    expect(items.length).toBeGreaterThan(GIVE_PAGE); // more than one page
    // the second page
    touch(game, 18, 13);
    expect(ui().give.page).toBe(1);
    touch(game, 1, 13);
    expect(ui().give.page).toBe(0);
    // the KEY pocket and back
    touch(game, 12, 15);
    expect(ui().give.pocket).toBe("key");
    touch(game, 2, 15);
    // the first item on the page: its page, quantity 10 then 11, GIVE, YES
    const first = items[0]!;
    touch(game, 5, 1);
    expect(ui().give.item).toBe(first);
    touch(game, 7, 12); // the "10" preset
    expect(ui().give.qty).toBe(10);
    touch(game, 18, 10); // ▶: one more
    expect(ui().give.qty).toBe(11);
    const had = game.save.inventory[first] ?? 0;
    touch(game, 15, 17); // GIVE
    touch(game, 9, 7); // YES
    expect(game.save.inventory[first]).toBe(had + 11);
    expect(ui().giveMsg).toBe("11 PUT IN THE BAG.");
    // BACK, BACK: the list again
    touch(game, 3, 17);
    touch(game, 3, 17);
    expect(ui().give).toBeNull();
  });

  test.skipIf(!hasGen)("the page's layout: a row clear under the header, column 19 clear, values ending in 17", () => {
    class BottomGrid extends MenuHost {
      grid: number[][] = Array.from({ length: 18 }, () => Array(20).fill(0));
      uiClearBottom(): void { this.grid.forEach((r) => r.fill(0)); }
      uiTileBottom(x: number, y: number, t: number): void { if (x >= 0 && y >= 0 && x < 20 && y < 18) this.grid[y]![x] = t; }
    }
    const host = new BottomGrid();
    const game = new VoxelmonGame(data!, host, 1);
    game.newGame();
    game.closeToOverworld();
    game.save.options.cheats = true;
    game.save.options.alwaysCatch = true;
    game.setGearView("cheats");
    drawKantoGear(host as never, game as never);
    const g = host.grid;
    const glyph = (t: number) => t & 0x1fff;
    const blank = (t: number) => t === 0 || glyph(t) === 0x7f; // nothing, or a SPACE cell
    expect(g[1]!.every(blank)).toBe(true); // the gap under the header
    for (let y = 1; y < 18; y++) expect(blank(g[y]![19]!)).toBe(true); // column 19
    // every value's last glyph in column 17, column 18 its bar (or paper)
    const on = encodeGlyphs("ON");
    const off = encodeGlyphs("OFF");
    expect(glyph(g[5]![17]!)).toBe(on[1]); // ALWAYS CATCH: ON
    expect(glyph(g[8]![17]!)).toBe(off[2]); // INSTANT VICTORY: OFF, under its label
    expect(glyph(g[3]![17]!)).toBe(encodeGlyphs("NORMAL")[5]);
    // the labels keep a column clear of their values, and one off the edge
    expect(blank(g[5]![14]!)).toBe(true); // after ALWAYS CATCH
    for (let y = 2; y < 18; y++) expect(blank(g[y]![0]!)).toBe(true);
    expect(glyph(g[10]![1]!)).toBe(encodeGlyphs("INFINITE MONEY")[0]);
    expect(g[17]!.every(blank)).toBe(true);
    // the second page: the two actions
    (game as unknown as { gearUi: Record<string, any> }).gearUi.cheats!.page = 1;
    // away and back: the gear redraws a still page only when its key moves
    game.setGearView("home");
    drawKantoGear(host as never, game as never);
    game.setGearView("cheats");
    drawKantoGear(host as never, game as never);
    expect(glyph(g[2]![17]!)).toBe(encodeGlyphs("FILL")[3]);
    expect(glyph(g[4]![17]!)).toBe(encodeGlyphs("OPEN")[3]);
  });

  test("every row's words fit: labels before their pills, the box's two lines", () => {
    for (const r of CHEAT_ROWS) {
      const w = encodeGlyphs(r.label).length;
      // from column 1: on its pill's row with a column clear, or a row to itself
      expect(w).toBeLessThanOrEqual(18);
      if (r.kind === "action") expect(w).toBeLessThanOrEqual(11);
      const abouts = typeof r.about === "string" ? [r.about] : Object.values(r.about);
      for (const a of abouts) expect(wrap(a, 18).length).toBeLessThanOrEqual(2);
    }
    // what an action says, under the item: 18 glyphs
    for (const s of [CHEAT_TEXT.gaveBag(99), CHEAT_TEXT.gavePc(99), CHEAT_TEXT.gaveSplit(98, 99), CHEAT_TEXT.have, CHEAT_TEXT.full, CHEAT_TEXT.notNow]) {
      expect(encodeGlyphs(s).length).toBeLessThanOrEqual(18);
    }
  });
});

// ---------------------------------------------------------------------------
// the gear's app switcher: [L] ◀ TITLE ▶ [R]
// ---------------------------------------------------------------------------

describe("the app header's L and R keys", () => {
  const titles = APPS.filter((a) => a.id !== "home").map((a) => a.title);
  const clocks: [string, boolean][] = [["9:47AM", false], ["12:59PM", false], ["1:05PM", false], ["23:59", true], ["07:05", true]];

  test("every title: the keys clear of the edges and the clock, the arrows and title on half cells", () => {
    for (const t of titles) {
      const n = encodeGlyphs(t).length;
      for (const [clock, h24] of clocks) {
        const L = switcherLayout(n, clock, h24);
        expect(L.keyL).toBeGreaterThanOrEqual(SWITCHER_EDGE);
        const end = L.keyR + KEY_W;
        expect(end).toBeLessThanOrEqual((L.clock >= 0 ? L.clock : COLS * TILE_W) - SWITCHER_EDGE);
        expect(end - L.keyL).toBe(switcherWidth(n));
        for (const x of [L.left, L.title, L.right]) expect(x % 8).toBe(0);
        // a half cell between each arrow and the title, the title whole
        expect(L.title - L.left).toBe(24);
        expect(L.right - L.title).toBe(n * 16 + 8);
        // seven glyphs or fewer keep the clock whatever the hour
        if (n <= 7) expect(L.clock).toBeGreaterThanOrEqual(0);
      }
    }
  });

  test("the header does not move with the hour; a long title has the bar when the clock leaves no room", () => {
    const at = (t: string, c: string, h24 = false) => switcherLayout(encodeGlyphs(t).length, c, h24);
    for (const t of ["TRAINER", "BAG", "PARTY", "OPTIONS"]) expect(at(t, "9:47AM").left).toBe(at(t, "12:59PM").left);
    expect(at("EXPLORER", "9:47AM").clock).toBe(13 * TILE_W);
    expect(at("EXPLORER", "12:59PM").clock).toBe(-1);
    expect(at("EXPLORER", "23:59", true).clock).toBe(14 * TILE_W);
    // ENHANCEMENTS has the bar, centred
    const e = at("ENHANCEMENTS", "9:47AM");
    expect(e.clock).toBe(-1);
    expect(e.keyL + (e.keyR + KEY_W) ).toBe(COLS * TILE_W);
  });

  test.skipIf(!hasGen)("drawn: two light keys on the bar with their letters, ◀ ▶ and the title light", () => {
    class RectGrid extends MenuHost {
      grid: number[][] = Array.from({ length: 18 }, () => Array(20).fill(0));
      rects: number[][] = [];
      uiClearBottom(): void { this.grid.forEach((r) => r.fill(0)); this.rects = []; }
      uiTileBottom(x: number, y: number, t: number): void { if (x >= 0 && y >= 0 && x < 20 && y < 18) this.grid[y]![x] = t; }
      uiRectBottom(x: number, y: number, w: number, h: number, shade: number): void { this.rects.push([x, y, w, h, shade]); }
    }
    const host = new RectGrid();
    const game = new VoxelmonGame(data!, host, 1);
    game.newGame();
    game.closeToOverworld();
    game.setGearView("trainer");
    drawKantoGear(host as never, game as never);
    const bar = host.rects.filter(([, y, , h]) => y! + h! <= Math.floor(TILE_H));
    const keys = bar.filter((r) => r[4] === 0);
    const ink = bar.filter((r) => r[4] === 3);
    // each key is two light rects (its corners cut); the letters are dark
    expect(keys.length).toBe(4);
    expect(ink.length).toBeGreaterThan(4);
    for (const [x, y, w, h] of bar) {
      expect(y).toBeGreaterThanOrEqual(1); // a px of the bar above and below
      expect(y! + h!).toBeLessThanOrEqual(Math.floor(TILE_H) - 1);
      expect(x).toBeGreaterThanOrEqual(SWITCHER_EDGE);
      expect(x! + w!).toBeLessThanOrEqual(COLS * TILE_W - SWITCHER_EDGE);
    }
    // every dark stroke inside a key
    for (const [x, , w] of ink) expect(keys.some(([kx, , kw]) => x! >= kx! && x! + w! <= kx! + kw!)).toBe(true);
    // ◀ TRAINER ▶ light on row 0, column 0 and 19 clear
    const row = host.grid[0]!;
    const glyph = (t: number) => t & 0xfff;
    expect(row.map(glyph)).toContain(0x13);
    expect(row.map(glyph)).toContain(0xed);
    const titleAt = row.findIndex((t) => glyph(t) === encodeGlyphs("T")[0]);
    expect(row.slice(titleAt, titleAt + 7).map(glyph)).toEqual(encodeGlyphs("TRAINER"));
    expect(row[0]).toBe(0);
    expect(row[19]).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// saves
// ---------------------------------------------------------------------------

describe("the settings in the save", () => {
  const extras = {
    gameSpeed: 2, expForCatching: true, partyExpShare: true, tradeEvoLv40: true, hmsWithoutMove: true, cheats: true,
    wildEncounters: "less", alwaysCatch: true, instantVictory: true, infiniteMoney: true, visibleWild: "many",
  };

  test("they survive the Lua save and gen1recomp's load untouched", () => {
    const save: any = { player: { name: "RED", id: 1, map: "PALLET_TOWN", x: 5, y: 6 }, options: { textSpeed: 3, ...extras }, party: [], inventory: {} };
    const back: any = decodeSave(encodeSave(toDisk(save)));
    fromDisk(back, {});
    expect(back.options).toMatchObject({ textSpeed: 3, ...extras });
  });
});
