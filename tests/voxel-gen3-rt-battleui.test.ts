// The FireRed runtime port, cluster "battle presentation": battle UI, the
// intro / switch / catch / EXP / evolution / learn-move sequences, healthbox,
// ball open, pic coords, battle backgrounds, battle chrome, stat growth and
// the battle transition. Real data from ~/gen3ref/frfull through the
// DesktopHost rasteriser; frames go to /tmp/g3shots/ (bui_*.png).
//
// The visible battles are driven the way gen1recomp's runtime drives them
// (runtime.lua:293-318, display.lua:305): Task.update, Battle.update,
// Message.tick, Hud.update (which advances waiting messages on A), then the
// battle branch of Display.presentPlanes.
import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DesktopHost } from "../voxelmon/game/gen3/platform/desktop.ts";
import { getHost, setHost } from "../voxelmon/game/gen3/platform/host.ts";
import { G } from "../voxelmon/game/gen3/platform/graphics.ts";
import { len, seq } from "../voxelmon/game/gen3/platform/lt.ts";
import { encodePng } from "../voxelmon/import/gen3/png.ts";
import { GameVersion } from "../voxelmon/game/gen3/shared/core/GameVersion.ts";
import { Pokemon } from "../voxelmon/game/gen3/core/pokemon.ts";
import { Moves } from "../voxelmon/game/gen3/core/battle/moves.ts";
import { Experience } from "../voxelmon/game/gen3/core/battle/experience.ts";
import { Commands } from "../voxelmon/game/gen3/core/battle/commands.ts";
import { Battle } from "../voxelmon/game/gen3/core/battle/init.ts";
import { Ui } from "../voxelmon/game/gen3/core/battle/ui.ts";
import { Anim } from "../voxelmon/game/gen3/core/battle/anim.ts";
import { IntroSeq } from "../voxelmon/game/gen3/core/battle/intro_seq.ts";
import { CatchSeq } from "../voxelmon/game/gen3/core/battle/catch_seq.ts";
import { ExpSeq } from "../voxelmon/game/gen3/core/battle/exp_seq.ts";
import { MoveSwap } from "../voxelmon/game/gen3/core/battle/move_swap.ts";
import { PartyView } from "../voxelmon/game/gen3/core/battle/party_view.ts";
import { PicCoords } from "../voxelmon/game/gen3/core/battle/pic_coords.ts";
import { BattleBg } from "../voxelmon/game/gen3/core/battle/bg.ts";
import { EnvFrlg } from "../voxelmon/game/gen3/core/battle/env_frlg.ts";
import { BallOpen } from "../voxelmon/game/gen3/core/battle/ball_open.ts";
import { Healthbox } from "../voxelmon/game/gen3/core/battle/healthbox.ts";
import { LearnMove } from "../voxelmon/game/gen3/core/battle/learn_move.ts";
import { Ids } from "../voxelmon/game/gen3/core/battle_transition_ids_frlg.ts";
import { BattleTransition } from "../voxelmon/game/gen3/core/battle_transition.ts";
import { BattleChrome } from "../voxelmon/game/gen3/ui/battle_chrome.ts";
import { StatGrowth } from "../voxelmon/game/gen3/ui/stat_growth.ts";
import { G3Lazy } from "../voxelmon/game/gen3/core/lazy_registry.ts";
import { Task } from "../voxelmon/game/gen3/core/task.ts";
import { Runtime } from "../voxelmon/game/gen3/core/runtime.ts";
import { Bag } from "../voxelmon/game/gen3/core/bag.ts";
import { Dex } from "../voxelmon/game/gen3/core/dex.ts";
import { Display } from "../voxelmon/game/gen3/core/display.ts";
import { Oam } from "../voxelmon/game/gen3/core/oam.ts";
import { Bg } from "../voxelmon/game/gen3/core/bg.ts";
import { Message } from "../voxelmon/game/gen3/ui/message.ts";
import { Hud } from "../voxelmon/game/gen3/ui/hud.ts";
import "../voxelmon/game/gen3/core/lazy_modules.ts";
import { CacheFs as ImportCacheFs } from "../voxelmon/import/gen3/cache.ts";
import { makeCache } from "../voxelmon/import/gen3/fsio.ts";

const ROOT = join(homedir(), "gen3ref/frfull");
const SHOTS = "/tmp/g3shots";

// FireRed species / moves / items (pokefirered include/constants).
const BULBASAUR = 1, RATTATA = 19;
const TACKLE = 33, GROWL = 45, VINE_WHIP = 22, POISON_POWDER = 77;
const POKE_BALL = 4;

const ZERO = () => ({ hp: 0, atk: 0, def: 0, spe: 0, spa: 0, spd: 0 });

/** A real FireRed mon: stats from the ROM's base stats (IVs/EVs 0, Hardy). */
function mkMon(species: number, level: number, moves: number[], extra: Record<string, any> = {}): any {
  const mon: any = {
    species, level, ivs: ZERO(), evs: ZERO(), personality: 0x12345678, otId: 12345,
    moves: seq(...moves), pp: seq(...moves.map(() => 20)),
    ...extra,
  };
  Pokemon.applyStats(mon);
  if (extra.hp != null) mon.hp = extra.hp;
  mon.exp = mon.exp ?? Experience.expForLevel(mon, level);
  return mon;
}

function newSession(lead: any): any {
  const session: any = { name: "RED", party: seq(lead), dex: Dex.new(), bag: Bag.new(), trainerId: 12345 };
  Bag.add(session.bag, POKE_BALL, 5);
  Runtime.session = session;
  return session;
}

/** One frame of the battle branch of Display.presentPlanes (display.lua:305). */
function render(host: DesktopHost): void {
  G.beginFrame();
  G.push("all");
  G.origin();
  G.clear(0.06, 0.12, 0.20, 1);
  Oam.resetFrame();
  Battle.draw(undefined, Display.W, Display.H);
  Display.drawUiPass();
  Oam.animateSprites();
  Oam.buildOamBuffer();
  if (Bg.hasVisible()) {
    for (let pri = 3; pri >= 0; pri--) { Bg.flushPriority(pri); Oam.flushPriority(pri); }
  } else {
    Oam.flush();
  }
  G.pop();
  G.endFrame();
}

function shot(host: DesktopHost, name: string): void {
  mkdirSync(SHOTS, { recursive: true });
  writeFileSync(join(SHOTS, name), encodePng(240, 160, host.pixels()));
}

function px(host: DesktopHost, x: number, y: number): [number, number, number] {
  const p = host.pixels(), o = (y * 240 + x) * 4;
  return [p[o]!, p[o + 1]!, p[o + 2]!];
}

/** A scripted pad: `press(k)` is seen as wasPressed for one frame. */
class Pad {
  key: string | undefined;
  wasPressed = (k: string): boolean => this.key === k;
  isDown = (k: string): boolean => this.key === k;
  wasReleased = (): boolean => false;
}

interface Frame { f: number; phase: string; mode: string; }
interface FrameOut { shot?: string; stop?: boolean }

/**
 * Drive a visible battle like runtime.lua. `choose` is asked each frame for
 * a key (or nothing); a waiting message is advanced with A when it returns
 * nothing. `onFrame` sees the state after each update and may ask for a
 * screenshot of that frame. Frames are only rasterised when a shot is asked
 * for (the desktop rasteriser is slow; the battle logic does not read the
 * frame).
 */
function drive(host: DesktopHost, maxFrames: number,
  choose: (fr: Frame) => string | undefined,
  onFrame: (fr: Frame) => FrameOut | void, trace?: string[]): number {
  const pad = new Pad();
  const game: any = { input: pad };
  let f = 0;
  let last = "";
  for (; f < maxFrames; f++) {
    const fr: Frame = { f, phase: String(Battle._phase), mode: String(Ui._mode) };
    let key = choose(fr);
    if (key == null && Message.isOpen() && Message.isWaiting() && !Message._stay && f % 8 === 0) key = "a";
    pad.key = key;
    Task.update(1 / 60);
    Battle.update(1 / 60, game);
    if (Message.tick) Message.tick();
    Hud.update(game, 1 / 60, pad);
    const now = { f, phase: String(Battle._phase), mode: String(Ui._mode) };
    const tag = now.phase + "/" + now.mode;
    if (trace && tag !== last) { trace.push(f + ":" + tag); last = tag; }
    const out = onFrame(now) ?? {};
    if (out.shot) {
      render(host);
      shot(host, out.shot);
    }
    if (out.stop) break;
    if (!Battle.isActive()) break;
  }
  return f;
}

function lastLog(): string {
  const log = Ui.log() ?? [null];
  return String(log[len(log)] ?? "");
}

describe.skipIf(!existsSync(ROOT))("gen3 runtime: battle presentation on FireRed data", () => {
  let host: DesktopHost;

  beforeAll(() => {
    host = new DesktopHost(ROOT);
    setHost(host);
    GameVersion.set("firered");
    // the post-catch Pokedex page reads map sections through the importer cache
    ImportCacheFs.bind(makeCache(ROOT));
    Pokemon.install({ read: (rel: string) => getHost().read(rel) });
    Moves.loadRomPack();
  });

  test("transition ids and battle terrain (battle_setup.c, battle_bg.c)", () => {
    // pret battle_setup.c:87 sBattleTransitionTable_Wild: stronger player -> first entry
    expect(Ids.pickWild({ playerLevel: 10, enemyLevel: 3 })).toBe(Ids.ID.SLICE!);
    expect(Ids.pickWild({ playerLevel: 3, enemyLevel: 10 })).toBe(Ids.ID.WHITE_BARS_FADE!);
    expect(Ids.pickWild({ isCave: true, playerLevel: 3, enemyLevel: 10 })).toBe(Ids.ID.GRID_SQUARES!);
    expect(Ids.pickTrainer({ trainerClass: 87, trainerId: 412 })).toBe(Ids.ID.AGATHA!);
    expect(Ids.pickTrainer({ trainerClass: 90, trainerTower: true, playerLevel: 1, enemyLevel: 9 })).toBe(Ids.ID.ANGLED_WIPES!);
    // plain-property env tables (Lua metatable accessors)
    expect(BattleBg.TERRAIN.GRASS).toBe(0);
    expect(BattleBg.TERRAIN.BUILDING).toBe(8);
    expect(BattleBg.MAP_TYPE.UNDERGROUND).toBe(4);
    expect(BattleBg.resolveFromMapKind("route")).toBe(EnvFrlg.TERRAIN.GRASS!);
    // metatile_behaviors.h: tall grass, sand, deep water on a route
    expect(BattleBg.resolveFromBehavior(0x02, "route")).toBe(EnvFrlg.TERRAIN.GRASS!);
    expect(BattleBg.resolveFromBehavior(0x21, "route")).toBe(EnvFrlg.TERRAIN.SAND!);
    expect(BattleBg.resolveFromBehavior(0x12, "route")).toBe(EnvFrlg.TERRAIN.WATER!);
    expect(BattleBg.resolveOverride(0, { trainer: true, trainerClass: 84 })).toBe(EnvFrlg.TERRAIN.LEADER!);
    expect(BattleBg.resolveOverride(0, { mapBattleScene: 1 })).toBe(EnvFrlg.TERRAIN.GYM!);
    BattleBg.setTerrain(undefined);
    expect(BattleBg.terrainId()).toBe(8);
  });

  test("battle chrome: ROM sheets, HP bar levels (battle_interface.c:2155)", () => {
    BattleChrome.install();
    expect(BattleChrome._textbox).toBeDefined();
    expect(BattleChrome._playerBox!.getDimensions()).toEqual([128, 64]);
    expect(BattleChrome._enemyBox!.getDimensions()).toEqual([128, 32]);
    expect(BattleChrome.terrain("grass")).toBeDefined();
    expect(BattleBg.sheetKey(BattleBg.TERRAIN.GRASS)).toBe("grass");
    expect(BattleChrome.scaledHpFraction(1, 200, 48)).toBe(1);
    expect(BattleChrome.scaledHpFraction(100, 200, 48)).toBe(24);
    expect(BattleChrome.hpBarLevel(20, 20)).toBe("full");
    expect(BattleChrome.hpBarLevel(13, 20)).toBe("green");
    expect(BattleChrome.hpBarLevel(10, 20)).toBe("yellow");
    expect(BattleChrome.hpBarLevel(4, 20)).toBe("red");
    expect(BattleChrome.hpBarLevel(0, 20)).toBe("empty");
    expect(BattleChrome.messageOrigin()).toEqual([10, 122, 224]);
  });

  test("move swap, party view, pic coords, ball ids, stat growth", () => {
    // battle_controller_player.c:795 the move-swap cursor
    expect(MoveSwap.step(0, "right", 4)).toBe(1);
    expect(MoveSwap.step(1, "down", 3)).toBe(1);
    expect(MoveSwap.step(0, "down", 3)).toBe(2);
    const m = mkMon(BULBASAUR, 10, [TACKLE, GROWL, VINE_WHIP]);
    expect(MoveSwap.moveCount(m)).toBe(3);
    expect(MoveSwap.apply({ mon: m }, 1, 3)).toBe(true);
    expect([m.moves[1], m.moves[3]]).toEqual([VINE_WHIP, TACKLE]);
    // battle_setup.c:542
    const [p, e] = PartyView.doubleTransitionLevels(seq(mkMon(1, 10, [33]), mkMon(4, 12, [33])), seq(mkMon(19, 3, [33])));
    expect([p, e]).toEqual([22, 3]);
    // pret gMonFrontPicCoords: BULBASAUR y_offset 16, RATTATA 14
    expect(PicCoords.front[BULBASAUR]).toBe(16);
    expect(PicCoords.front[RATTATA]).toBe(14);
    expect(PicCoords.battlerCoords(false, 1).x).toBe(176);
    expect(BallOpen.ballIdForItem(POKE_BALL)).toBe(0);
    expect(BallOpen.ballIdForItem(1)).toBe(4); // MASTER BALL
    expect(Healthbox.center({ double: false }, 1)).toEqual({ x: 44, y: 30 });
    // the lazily-required level-up window
    expect(G3Lazy["src.ui.game3.stat_growth"]).toBe(StatGrowth);
    let done = 0;
    StatGrowth.open({}, { maxHp: 20, atk: 10 }, { maxHp: 23, atk: 12 }, () => { done++; });
    expect(StatGrowth.isOpen()).toBe(true);
    const pad = new Pad();
    pad.key = "a";
    StatGrowth.handleInput(pad);
    expect(StatGrowth._page).toBe(2);
    StatGrowth.handleInput(pad);
    expect(StatGrowth.isOpen()).toBe(false);
    expect(done).toBe(1);
  });

  test("learn move: a free slot is filled from the ROM learnset (headless)", () => {
    LearnMove.reset();
    const mon = mkMon(BULBASAUR, 7, [TACKLE, GROWL]);
    const msgs: string[] = [];
    // pokefirered: BULBASAUR learns LEECH SEED at 7
    const started = LearnMove.beginQueue(mon, seq(7), {
      headless: true, battleText: true, pushMsg: (t: string) => { msgs.push(t); },
    });
    expect(started).toBe(true);
    expect(mon.moves[3]).toBe(73);
    expect(msgs.join(" ").replace(/\s+/g, " ")).toContain("learned LEECH SEED");
  });

  test("the wild grass battle transitions render (battle_transition.c)", () => {
    BattleChrome.install();
    const world = G.newCanvas(240, 160);
    // a field-like backdrop: the grass battle wallpaper
    const backdrop = (): void => {
      G.setCanvas(world);
      G.clear(0, 0, 0, 1);
      BattleChrome.drawCleanBg("grass");
      G.setCanvas();
    };
    const frame = (): void => {
      G.beginFrame();
      backdrop();
      G.setCanvas(world);
      BattleTransition.drawWorld(world, 240, 160);
      G.setCanvas();
      G.setColor(1, 1, 1, 1);
      G.draw(world, 0, 0);
      G.endFrame();
    };
    for (const [name, opts] of [
      ["slice", { playerLevel: 10, enemyLevel: 3 }],
      ["bars", { playerLevel: 3, enemyLevel: 10 }],
    ] as const) {
      const id = BattleTransition.pick({ wild: true, terrain: BattleTransition.TERRAIN.NORMAL, ...opts });
      expect(id).toBe(name === "slice" ? BattleTransition.ID.SLICE : BattleTransition.ID.WHITE_BARS_FADE);
      let done = false;
      expect(BattleTransition.start(id, {}, () => { done = true; })).toBe(true);
      let f = 0;
      const sums: number[] = [];
      for (; f < 400 && !done; f++) {
        BattleTransition.tick(1 / 60);
        frame();
        if (f % 12 === 0) shot(host, `bui_trans_${name}_${String(f).padStart(3, "0")}.png`);
        sums.push(host.pixels().reduce((a, v) => a + v, 0));
      }
      expect(done).toBe(true);
      expect(f).toBeLessThan(400);
      // it ends on a black screen (alpha bytes only) before handing over
      const black = 240 * 160 * 255;
      expect(sums.slice(-4)).toContain(black);
      expect(sums[0]).toBeGreaterThan(black);
    }
  });

  test("a headless wild battle runs to its end", () => {
    const lead = mkMon(BULBASAUR, 20, [TACKLE, VINE_WHIP]);
    const session = newSession(lead);
    const [ok, err] = Battle.start({
      wild: true, headless: true, autoFight: false, session, playerParty: session.party,
      foe: { species: RATTATA, level: 3 }, mapKind: "route",
      rng: (lo: number, hi: number) => (lo === 1 && hi === 100 ? 1 : hi),
    });
    expect(err).toBeUndefined();
    expect(ok).toBe(true);
    let turns = 0;
    for (let i = 0; i < 400 && Battle.isActive(); i++) {
      Battle.update(0, undefined);
      const st = Battle.getState();
      if (Battle._phase === "command" && st && Ui._pendingCommand == null) {
        Ui._pendingCommand = Commands.playerAction(st, 1, 2);
        turns++;
      }
    }
    expect(Battle.isActive()).toBe(false);
    const log = (Ui.log() ?? [null]).slice(1).join(" | ");
    expect(log).toContain("Wild RATTATA appeared!");
    expect(log).toContain("Go! BULBASAUR!");
    expect(log).toContain("VINE WHIP");
    expect(log).toContain("fainted");
    expect(log).toContain("gained");
    expect(turns).toBeGreaterThanOrEqual(1);
  });

  test("a visible wild battle: grass intro, menus, HP drain, EXP (screenshots)", () => {
    const lead = mkMon(BULBASAUR, 10, [TACKLE, GROWL, VINE_WHIP, POISON_POWDER]);
    const session = newSession(lead);
    const [ok] = Battle.start({
      wild: true, session, playerParty: session.party, fade: false, autoFight: false,
      foe: { species: RATTATA, level: 3 }, mapKind: "route",
      rng: (lo: number, hi: number) => (lo === 1 && hi === 100 ? 1 : hi),
    });
    expect(ok).toBe(true);
    expect(BattleBg.terrainId()).toBe(BattleBg.TERRAIN.GRASS);
    let menuAt = -1, movesAt = -1, drainAt = -1, expAt = -1, hbAt = -1;
    let enemyHpStart = -1;
    let barPx: number[] = [], barEmpty: number[] = [];
    // the frame the current menu / move menu opened (A 30 frames later)
    let menuOpen = -1, movesOpen = -1, prevTag = "";
    const trace: string[] = [];
    let end = 0;
    try {
      end = drive(host, 2600, (fr) => {
        // FIGHT, then TACKLE on every turn
        if (fr.phase === "command" && fr.mode === "menu" && fr.f === menuOpen + 30) return "a";
        if (fr.phase === "command" && fr.mode === "moves" && fr.f === movesOpen + 30) return "a";
        return undefined;
      }, (fr) => {
        const out: FrameOut = {};
        const tag = fr.phase + "/" + fr.mode;
        if (tag !== prevTag) {
          if (tag === "command/menu") menuOpen = fr.f;
          if (tag === "command/moves") movesOpen = fr.f;
          prevTag = tag;
        }
        if (fr.f === 40) out.shot = "bui_intro_slide.png";
        if (fr.f === 130) out.shot = "bui_intro_slide2.png";
        const step = IntroSeq._steps ? IntroSeq._steps[IntroSeq._i] : undefined;
        if (fr.phase === "intro" && step?.kind === "healthbox" && hbAt < 0) hbAt = fr.f;
        if (hbAt >= 0 && fr.f === hbAt + 10) out.shot = "bui_intro_healthbox.png";
        if (menuAt < 0 && menuOpen >= 0) menuAt = menuOpen;
        if (fr.f === menuAt + 20) out.shot = "bui_command_menu.png";
        if (movesAt < 0 && movesOpen >= 0) movesAt = movesOpen;
        if (fr.f === movesAt + 20) out.shot = "bui_move_menu.png";
        const p = Anim.present("enemy");
        // the foe's HP bar once the first move is chosen
        if (movesAt >= 0 && fr.f === movesAt + 30 && p && p.displayHp != null) enemyHpStart = p.displayHp;
        if (drainAt < 0 && p && p.displayHp != null && enemyHpStart >= 0 && p.displayHp < enemyHpStart) drainAt = fr.f;
        if (drainAt >= 0 && fr.f === drainAt + 6) out.shot = "bui_hp_drain.png";
        if (drainAt >= 0 && fr.f === drainAt + 14) out.shot = "bui_hp_drain2.png";
        // the last rendered frame: the foe bar at 5/15 HP is yellow (battle_interface.c:2168), 16 of 48 px
        if (drainAt >= 0 && fr.f === drainAt + 15) { barPx = px(host, 60, 33); barEmpty = px(host, 72, 33); }
        if (expAt < 0 && ExpSeq.busy() && ExpSeq._steps && ExpSeq._steps[ExpSeq._i]?.kind === "exp") expAt = fr.f;
        if (expAt >= 0 && fr.f === expAt + 8) out.shot = "bui_exp_gain.png";
        if (expAt >= 0 && fr.f === expAt + 30) out.shot = "bui_exp_gain2.png";
        return out;
      }, trace);
    } finally {
      if (Battle.isActive()) console.log("[battleui] trace: " + trace.join(" "));
      Battle.abort();
    }
    expect(hbAt).toBeGreaterThan(0);
    expect(menuAt).toBeGreaterThan(hbAt);
    expect(movesAt).toBeGreaterThan(menuAt);
    expect(drainAt).toBeGreaterThan(movesAt);
    expect(expAt).toBeGreaterThan(drainAt);
    expect(barPx).toEqual([206, 173, 8]);
    expect(barEmpty).toEqual([74, 66, 90]);
    expect(end).toBeLessThan(2600);
    void lastLog;
  }, 300000);

  test("a visible catch: throw, shakes, click (screenshots)", () => {
    const lead = mkMon(BULBASAUR, 10, [TACKLE, GROWL]);
    const session = newSession(lead);
    const [ok] = Battle.start({
      wild: true, session, playerParty: session.party, fade: false, autoFight: false,
      foe: { species: RATTATA, level: 3 }, mapKind: "route",
      rng: (lo: number) => lo,
    });
    expect(ok).toBe(true);
    let thrown = -1, caughtAt = -1, dexAt = -1;
    let result: string | null | undefined;
    const shots = [30, 50, 70, 100, 140, 200, 260, 330, 420];
    const trace: string[] = [];
    try {
      drive(host, 2400, (fr) => {
        if (fr.phase === "command" && fr.mode === "menu" && thrown < 0 && Ui._pendingCommand == null) {
          // what the BAG's onBattleUse hands back for a POKé BALL (battle/ui.lua open_battle_bag)
          Ui._pendingCommand = { kind: "bag", itemId: POKE_BALL, user: "player" };
          Ui._mode = "none";
          thrown = fr.f;
        }
        return undefined;
      }, (fr) => {
        const out: FrameOut = {};
        if (thrown >= 0) {
          for (const s of shots) if (fr.f === thrown + s) out.shot = `bui_catch_${String(s).padStart(3, "0")}.png`;
        }
        if (caughtAt < 0 && CatchSeq.result() === "catch" && !CatchSeq.busy()) { caughtAt = fr.f; result = CatchSeq.result(); }
        // the caught mon's Pokedex page (battle_script_commands.c:9691)
        if (fr.phase === "pokedex_reg" && dexAt < 0) dexAt = fr.f;
        if (dexAt >= 0 && fr.f === dexAt + 40) { out.shot = "bui_catch_dex.png"; out.stop = true; }
        return out;
      }, trace);
    } finally {
      console.log("[battleui] catch trace: " + trace.join(" "));
      Battle.abort();
    }
    expect(thrown).toBeGreaterThan(0);
    expect(result).toBe("catch");
    expect(dexAt).toBeGreaterThanOrEqual(caughtAt);
    expect(len(session.party)).toBe(2);
    expect(session.party[2].species).toBe(RATTATA);
  }, 300000);
});
