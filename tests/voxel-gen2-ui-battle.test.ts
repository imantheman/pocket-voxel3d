// Group C screens on the Gold screen: the battle screen (ui/BattleState.ts and
// its HUD / animation painters), the battle transition, evolution, egg hatch
// and the trade screens -- built on a real Game2 and the real Gold data,
// driven through Input and the StateStack, drawn into an Lcd.
//
// GOLD_SHOTS=<dir> writes PNGs of the main states.

import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";
import { RecorderHost } from "../voxelmon/game/host.ts";
import { haveGoldGen, useGoldGen } from "../voxelmon/game/gen2/platform/data-node.ts";
import { Lcd, LCD_HOLE, LCD_W, renderLcd } from "../voxelmon/game/gen2/platform/lcd.ts";
import { resetDrawState, setLcd } from "../voxelmon/game/gen2/platform/screen.ts";
import { seed } from "../voxelmon/game/gen2/platform/rng.ts";
import { NotPortedError } from "../voxelmon/game/gen2/notported.ts";
import { Input } from "../voxelmon/game/gen2/shared/core/Input.ts";
import { Sound } from "../voxelmon/game/gen2/shared/core/Sound.ts";
import { Music } from "../voxelmon/game/gen2/shared/core/Music.ts";
import { Game2 } from "../voxelmon/game/gen2/core/Game2.ts";
import { Mon } from "../voxelmon/game/gen2/battle/Mon.ts";
import { Battle } from "../voxelmon/game/gen2/battle/Battle.ts";
import { Screens } from "../voxelmon/game/gen2/shared/ui/Screens.ts";
import { BattleTransition } from "../voxelmon/game/gen2/ui/BattleTransition.ts";
import { BattleAnimView } from "../voxelmon/game/gen2/ui/BattleAnimView.ts";
import * as MonAnimViewMod from "../voxelmon/game/gen2/shared/render/MonAnimView.ts";
import * as MonAnimMod from "../voxelmon/game/gen2/shared/render/MonAnim.ts";
import * as SpriteAnimsMod from "../voxelmon/game/gen2/ui/SpriteAnims.ts";

const gold = haveGoldGen();
const d = gold ? describe : describe.skip;
const SHOTS = process.env.GOLD_SHOTS;

function isStub(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch (e) {
    return e instanceof NotPortedError;
  }
}

// Group A's shared view helpers land in parallel. Where one is still a stub,
// a test-only stand-in that draws nothing takes its place (the screens call
// them exactly as the Lua does).
function installDoubles(): void {
  const silence = (obj: any, names: string[]): void => {
    for (const n of names) {
      if (typeof obj[n] === "function" && String(obj[n]).includes("notPorted")) obj[n] = () => undefined;
    }
  };
  const S = Sound as any;
  silence(S, Object.keys(S));
  const M = Music as any;
  silence(M, Object.keys(M));
  for (const mod of [MonAnimViewMod, MonAnimMod, SpriteAnimsMod] as any[]) {
    for (const key of Object.keys(mod)) {
      const v = mod[key];
      if (!v || (typeof v !== "object" && typeof v !== "function")) continue;
      const header = String(v);
      if (typeof v === "function" && header.includes("notPorted")) continue;
      for (const n of Object.getOwnPropertyNames(v)) {
        try {
          if (typeof v[n] === "function" && String(v[n]).includes("notPorted")) {
            v[n] = n === "new" ? () => ({ update: () => undefined, draw: () => false, step: () => undefined, frame: () => undefined, done: () => true }) : () => undefined;
          }
        } catch {
          // getters
        }
      }
    }
  }
}

let game: any;
let lcd: Lcd;
let shotsMade: string[] = [];

beforeAll(async () => {
  if (!gold) return;
  useGoldGen();
  const { useGoldTiles } = await import("../voxelmon/game/gen2/platform/shot-node.ts");
  useGoldTiles();
  installDoubles();
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
});

function newGame(): any {
  seed(0x29);
  const g: any = Game2.new();
  try {
    g.load({ startWorld: false });
  } catch {
    // the copyright splash is another group's screen
  }
  g.stack.clear();
  lcd = new Lcd(new RecorderHost());
  lcd.shown = true;
  setLcd(lcd);
  Input.reset();
  return g;
}

/** One frame: pad in, update the top state, draw the stack. */
function frame(buttons = 0): void {
  Input.setButtons(buttons);
  Input.step();
  game.stack.update(1 / 60);
  draw();
}

function draw(): void {
  lcd.begin();
  resetDrawState();
  game.stack.draw();
  lcd.end();
}

function press(button: keyof typeof VOX_BTN, hold = 1): void {
  for (let i = 0; i < hold; i++) frame(VOX_BTN[button]);
  frame(0);
}

async function shot(name: string): Promise<void> {
  if (!SHOTS) return;
  const { shotLcd } = await import("../voxelmon/game/gen2/platform/shot-node.ts");
  shotLcd(lcd.s, `${SHOTS}/${name}.png`);
  shotsMade.push(name);
}

/** The rendered frame (slot*4+colour per pixel, or LCD_HOLE). */
async function rendered(): Promise<Uint8Array> {
  const { useGoldTiles, tilePixel } = await import("../voxelmon/game/gen2/platform/shot-node.ts");
  const t = useGoldTiles();
  return renderLcd(lcd.s, (id, x, y) => tilePixel(t, id, x, y));
}

function holes(f: Uint8Array): number {
  let n = 0;
  for (const v of f) if (v === LCD_HOLE) n++;
  return n;
}

const perfect = () => ({ attack: 15, defense: 15, speed: 15, special: 15 });

// ------------------------------------------------------------------ evolution / egg

d("gen2 ui: evolution and egg hatch", () => {
  test("CYNDAQUIL evolves into QUILAVA: the animation runs to its end", async () => {
    game = newGame();
    const mon: any = Mon.new(game.data, "CYNDAQUIL", 14, { dvs: perfect() });
    game.save.party = [mon];
    let result: any;
    Screens.push(game, "Gen2EvolutionAnim", {
      mon,
      index: 1,
      party: game.save.party,
      save: game.save,
      entry: { method: "EVOLVE_LEVEL", param: 14, into: "QUILAVA" },
      onDone: (r: any) => (result = r),
    });
    const anim = game.stack.top();
    expect(anim.phase).toBe("evolving");
    const phases = new Set<string>();
    let midShot = false;
    for (let i = 0; i < 6000 && game.stack.top() === anim; i++) {
      phases.add(anim.phase);
      // a prompt waits for A; tap it every 20 frames
      frame(i % 20 === 0 ? VOX_BTN.a : 0);
      if (!midShot && anim.phase === "flash" && anim.showNew) {
        midShot = true;
        await shot("evolution_mid");
        const f = await rendered();
        expect(holes(f)).toBe(0); // a full-screen scene
      }
    }
    expect(game.stack.top()).not.toBe(anim);
    expect(result).toBeDefined();
    expect(result.canceled).toBe(false);
    // Evolution.apply writes a new record into the party slot
    expect(game.save.party[0].species).toBe("QUILAVA");
    expect(result.evolved.species).toBe("QUILAVA");
    for (const p of ["evolving", "flash", "congrats"]) expect(phases.has(p)).toBe(true);
  });

  test("an EGG hatches into TOGEPI", async () => {
    game = newGame();
    const mon: any = Mon.new(game.data, "TOGEPI", 5, { dvs: perfect() });
    let done = false;
    Screens.push(game, "Gen2EggHatchAnim", {
      mon,
      species: "TOGEPI",
      menuGfx: game.data.gen2MenuGfx,
      onDone: () => {
        done = true;
        game.stack.pop();
      },
    });
    const anim = game.stack.top();
    let shotTaken = false;
    for (let i = 0; i < 4000 && !done; i++) {
      frame(i % 20 === 0 ? VOX_BTN.a : 0);
      if (!shotTaken && i === 60) {
        shotTaken = true;
        await shot("egg_hatch_wobble");
      }
    }
    expect(done).toBe(true);
    expect(game.stack.top()).not.toBe(anim);
  });
});

// ------------------------------------------------------------------ transition

d("gen2 ui: battle transition", () => {
  test("pick: the two-bit select and the cave pair", () => {
    expect(BattleTransition.pick({ environment: "TOWN", playerLevel: 5, enemyLevel: 3 })).toBe("spin");
    expect(BattleTransition.pick({ environment: "ROUTE", playerLevel: 5, enemyLevel: 9 })).toBe("speckle");
    expect(BattleTransition.pick({ environment: "CAVE", playerLevel: 5, enemyLevel: 3 })).toBe("sine");
    expect(BattleTransition.pick({ environment: "DUNGEON", playerLevel: 2, enemyLevel: 9 })).toBe("zoom");
    expect(BattleTransition.flashByte([3, 2, 1, 0])).toBe(0xe4);
    expect(BattleTransition.pokeballCells().length).toBeGreaterThan(80);
  });

  test("a spin wipe over the world runs to black and pops", async () => {
    game = newGame();
    let done = false;
    const world = { map: { def: { environment: "ROUTE" } }, daytime: "DAY", draw: () => undefined };
    game.stack.push({ draw: () => undefined, update: () => undefined, isOpaque: true });
    Screens.push(game, "Gen2BattleTransition", { world, playerLevel: 5, enemyLevel: 2, onDone: () => (done = true) });
    const t = game.stack.top();
    expect(t.style).toBe("spin");
    let midShot = false;
    for (let i = 0; i < 400 && !done; i++) {
      frame();
      if (!midShot && t.phase === "outro" && t.step >= 10) {
        midShot = true;
        const f = await rendered();
        // half the spin: some black cells, and the world (holes) through the rest
        expect(holes(f)).toBeGreaterThan(0);
        expect(holes(f)).toBeLessThan(160 * 144);
        await shot("transition_spin_mid");
      }
    }
    expect(done).toBe(true);
  });
});


// ------------------------------------------------------------------ battles

interface DriveLog {
  phases: Set<string>;
  shots: Set<string>;
  anims: Set<string>;
  outcome?: string;
  done: boolean;
  frames: number;
  prefix: string;
}

/** A party member with the moves a level-14 CYNDAQUIL knows. */
function cyndaquil(level: number): any {
  return Mon.new(game.data, "CYNDAQUIL", level, { dvs: perfect() });
}

function pushBattle(battle: any, log: DriveLog): any {
  Screens.push(game, "Gen2BattleState", {
    battle,
    save: game.save,
    onDone: (outcome: string) => {
      log.outcome = outcome;
      log.done = true;
      game.stack.pop();
    },
  });
  return game.stack.top();
}

/**
 * Drive a battle screen through its own menus: FIGHT, then the named move
 * (cursor walked down to it), A through every message. `until` stops early.
 * Shots of the requested states are taken the first time each is reached.
 */
async function drive(state: any, move: string, log: DriveLog, maxFrames: number, until?: () => boolean): Promise<void> {
  let hpFrames = 0;
  let expFrames = 0;
  for (let i = 0; i < maxFrames && !log.done; i++) {
    if (until && until()) return;
    log.frames++;
    const phase: string = state.phase;
    log.phases.add(phase);
    const tick = i % 4 === 0;
    let buttons = 0;
    if (phase === "menu") {
      if (tick && state.menuIndex === 1 && (state.messageTimer ?? 0) <= 0) buttons = VOX_BTN.a;
      else if (tick && state.menuIndex !== 1) buttons = VOX_BTN.up;
    } else if (phase === "moves") {
      const moves: any[] = state.playerMoves();
      const target = moves.findIndex((m: any) => m.id === move) + 1;
      if (tick) buttons = state.moveIndex < target ? VOX_BTN.down : state.moveIndex > target ? VOX_BTN.up : VOX_BTN.a;
    } else if (i % 8 === 0) {
      buttons = VOX_BTN.a;
    }
    frame(buttons);
    const runner = state.anim;
    if (runner && runner.animId) log.anims.add(String(runner.animId));
    if (state.slideFrame != null && state.slideFrame >= 24 && state.slideFrame < BattleAnimView.SLIDE_FRAMES && !log.shots.has("slide")) {
      log.shots.add("slide");
      await shot(`${log.prefix}_start_slide`);
    }
    if (state.phase === "menu" && !log.shots.has("menu") && (state.messageTimer ?? 0) <= 0) {
      log.shots.add("menu");
      const f = await rendered();
      expect(holes(f)).toBe(0); // full-screen and opaque, as pokegold
      await shot(`${log.prefix}_menu`);
    }
    if (state.phase === "moves" && !log.shots.has("moves")) {
      log.shots.add("moves");
      await shot(`${log.prefix}_moves`);
    }
    if (runner && runner.animId === move && runner.frames >= 14 && !log.shots.has("anim")) {
      log.shots.add("anim");
      // the move's objects are on the OBJ layer
      expect(lcd.s.objs.length).toBeGreaterThan(0);
      await shot(`${log.prefix}_${move.toLowerCase()}_mid`);
    }
    if (state.hpAnim && state.hpAnim.side === "enemy") {
      hpFrames++;
      if (hpFrames === 16 && !log.shots.has("hp")) {
        log.shots.add("hp");
        await shot(`${log.prefix}_hp_drain`);
      }
    }
    if (state.expAnim) {
      expFrames++;
      if (expFrames === 24 && !log.shots.has("exp")) {
        log.shots.add("exp");
        await shot(`${log.prefix}_exp_bar`);
      }
    }
  }
}

function newLog(prefix: string): DriveLog {
  return { phases: new Set(), shots: new Set(), anims: new Set(), done: false, frames: 0, prefix };
}

d("gen2 ui: the battle screen", () => {
  test("a wild battle on ROUTE_29, CYNDAQUIL vs the first DAY slot, through the menus to the end", async () => {
    game = newGame();
    seed(0x2929);
    const slot = game.data.gen2Encounters.grass.ROUTE_29.slots.DAY[0];
    const player = cyndaquil(14);
    expect(player.moves.map((m: any) => m.id)).toContain("EMBER");
    // halfway through level 14, so the exp bar has something to show
    const growth = Mon.growthFor(game.data, game.data.pokemon.CYNDAQUIL.growthRate);
    const lo = Mon.experienceForLevel(growth, 14);
    const hi = Mon.experienceForLevel(growth, 15);
    player.experience = lo + Math.floor((hi - lo) / 2);
    game.save.party = [player];
    const wild: any = Mon.new(game.data, slot.species, slot.level, { dvs: perfect() });
    const expBefore = player.experience;
    const battle: any = Battle.new({ data: game.data, party: game.save.party, wild, save: game.save });
    const log = newLog("battle");
    const state = pushBattle(battle, log);
    await drive(state, "EMBER", log, 8000);
    expect(log.done).toBe(true);
    expect(log.outcome).toBe("win");
    expect(wild.hp).toBe(0);
    expect(game.save.party[0].experience).toBeGreaterThan(expBefore);
    for (const p of ["menu", "moves", "resolving"]) expect(log.phases.has(p)).toBe(true);
    expect(log.anims.has("EMBER")).toBe(true);
    for (const s of ["menu", "moves", "anim", "hp", "exp"]) expect(log.shots.has(s)).toBe(true);
    expect(game.stack.top()).not.toBe(state);
  });

  test("FALKNER: the trainer intro and the first turn", async () => {
    game = newGame();
    seed(0xfa1c);
    const cls = game.data.trainers.classes.FALKNER;
    const row = cls.trainers[0];
    const party = row.party.map((r: any) =>
      Mon.new(game.data, r.species, r.level, {
        moves: r.moves && r.moves.length > 0 ? r.moves.map((id: string) => ({ id, pp: game.data.moves[id].pp, maxPp: game.data.moves[id].pp })) : undefined,
        item: r.item,
        dvs: { attack: 9, defense: 8, speed: 8, special: 8 },
      }),
    );
    game.save.party = [cyndaquil(16)];
    const battle: any = Battle.new({
      data: game.data,
      party: game.save.party,
      trainer: { class: "FALKNER", classId: "FALKNER", name: row.name, party, baseMoney: cls.baseMoney },
      save: game.save,
    });
    const log = newLog("falkner");
    const state = pushBattle(battle, log);
    // the intro: FALKNER's own pic slides in before PIDGEY is sent out
    let sawTrainer = false;
    for (let i = 0; i < 40; i++) {
      frame();
      if (state.showEnemyTrainer) sawTrainer = true;
    }
    expect(sawTrainer).toBe(true);
    await shot("falkner_intro");
    // to the first menu
    await drive(state, "EMBER", log, 3000, () => state.phase === "menu" && (state.messageTimer ?? 0) <= 0 && log.frames > 0);
    expect(state.phase).toBe("menu");
    expect(battle.enemy.species).toBe("PIDGEY");
    const pidgey = battle.enemy;
    const enemyHp = pidgey.hp;
    // FIGHT -> EMBER, then on until the menu comes back for turn 2
    let left = false;
    await drive(state, "EMBER", log, 3000, () => {
      if (state.phase !== "menu") left = true;
      return left && state.phase === "menu" && (state.messageTimer ?? 0) <= 0;
    });
    expect(left).toBe(true);
    expect(log.anims.has("EMBER")).toBe(true);
    // EMBER from a level-16 CYNDAQUIL: PIDGEY is hurt (or down, and FALKNER
    // has sent PIDGEOTTO)
    expect(pidgey.hp).toBeLessThan(enemyHp);
    if (pidgey.hp === 0) expect(battle.enemy.species).toBe("PIDGEOTTO");
    await shot("falkner_turn2_menu");
  });
});

export { BattleAnimView, Battle, LCD_W };
