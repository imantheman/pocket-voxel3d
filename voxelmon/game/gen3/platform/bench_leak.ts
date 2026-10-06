// pocket-voxel platform for the gen3 (FireRed) port (GPLv3 + additional terms;
// see LICENSE.md). The device bench's long session (main.ts in bench mode
// with PV_G3_BENCH_SCRIPT="leak"): from main.ts's placed new game, many
// wild and trainer battles with a changing lead (different species and
// moves) and map changes between them (teleports to the cities, walks
// through doors and across a connection), the start menu now and then, and
// at the end the big cities in 3D -- a line after each step with the heaps,
// linear memory and the 2D layer's live textures, to show whether memory
// levels off and whether the world still gets its vertex spans after it.
// It presses the game's own buttons (and starts the battles and teleports
// as a script would). main.ts makes one only in bench mode; a game build
// never runs it. The same session runs on the desktop in
// tools/gen3/tex_leak.ts.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { Runtime } from "../core/runtime.ts";
import { Party } from "../core/party.ts";
import { BattleBridge } from "../core/battle_bridge.ts";
import { Player } from "../core/player.ts";
import { Collision } from "../core/collision.ts";
import { Field } from "../core/field.ts";
import { Warp } from "../core/warp.ts";
import { Options } from "../core/options.ts";
import Trainers from "../core/scripting/trainers.ts";
import { Ui as BattleUi } from "../core/battle/ui.ts";

const BIT: Record<string, number> = { UP: 0, DOWN: 1, LEFT: 2, RIGHT: 3, A: 4, B: 5, START: 6, SELECT: 7 };
const KEY: Record<string, string> = { up: "UP", down: "DOWN", left: "LEFT", right: "RIGHT" };
const DIRS: [string, number, number][] = [["up", 0, -1], ["down", 0, 1], ["left", -1, 0], ["right", 1, 0]];

type Gen = Generator<number, void, unknown>;

export class BenchLeak {
  done = false;
  private it: Gen;
  private game: any;
  private tick = 0;
  private maps = 0;
  private lastMap = "";
  private moveTurn = 0;

  constructor(game: any, private readonly mem: () => string) {
    this.game = game;
    this.it = this.session();
  }

  /** The buttons held at `tick`. */
  at(tick: number, game: any): number {
    this.tick = tick;
    this.game = game;
    if (this.done) return 0;
    const map = Runtime.getSession?.()?.map ?? "";
    if (map !== this.lastMap) { if (this.lastMap) this.maps++; this.lastMap = map; }
    const r = this.it.next();
    if (r.done) { this.done = true; return 0; }
    return r.value;
  }

  private log(what: string): void {
    console.log(`[pv] g3 leak: ${what} (tick ${this.tick}, ${this.maps} map changes); ${this.mem()}`);
  }

  private inBattle(): boolean { const g = this.game; return !!(g && g.speedCategory && g.speedCategory() === "battle"); }

  private *idle(n: number): Gen { for (let i = 0; i < n; i++) yield 0; }
  private *tap(key: string, hold = 4, after = 20): Gen {
    for (let i = 0; i < hold; i++) yield 1 << BIT[key]!;
    for (let i = 0; i < after; i++) yield 0;
  }

  /** A battle to its end, by the battle UI's own state (tools/gen3/tex_leak.ts's driver). */
  private *fight(): Gen {
    const t0 = this.tick;
    let want = 1, tries = 0;
    while (this.inBattle() && this.tick - t0 < 12000) {
      const mode = (BattleUi as any)._mode;
      if (mode === "menu") {
        const i = (BattleUi as any)._menuIndex;
        if (i === 1) { yield* this.tap("A", 4, 16); want = (this.moveTurn++ % 4) + 1; tries = 0; }
        else yield* this.tap(i === 3 ? "UP" : "LEFT", 4, 8);
      } else if (mode === "moves") {
        const i = (BattleUi as any)._moveIndex;
        if (i === want || ++tries > 6) { yield* this.tap("A", 4, 16); want = 1; }
        else {
          const dx = ((want - 1) % 2) - ((i - 1) % 2), dy = Math.floor((want - 1) / 2) - Math.floor((i - 1) / 2);
          yield* this.tap(dx > 0 ? "RIGHT" : dx < 0 ? "LEFT" : dy > 0 ? "DOWN" : "UP", 4, 8);
        }
      } else if (mode === "party") {
        yield* this.tap("DOWN", 4, 12); yield* this.tap("A", 4, 20); yield* this.tap("A", 4, 20);
      } else yield* this.tap("B", 4, 12);
    }
    if (this.inBattle()) {
      console.log(`[pv] g3 leak: battle still on after ${this.tick - t0} ticks: ended as a win`);
      try { (BattleBridge as any).finishPending("win"); } catch { /* the bench goes on */ }
    }
    yield* this.idle(90);
  }

  private *settle(): Gen {
    for (let i = 0; i < 300; i++) {
      if (this.inBattle()) { yield* this.fight(); continue; }
      if (Runtime.uiBusy?.() || (Field as any).locked) yield* this.tap("B", 4, 12); else return;
    }
  }

  private *battle(kind: string, start: () => [any, any]): Gen {
    let ok: any, err: any;
    try { [ok, err] = start(); } catch (e) { ok = false; err = String(e); }
    if (!ok) { console.log(`[pv] g3 leak: ${kind}: start failed: ${err}`); return; }
    for (let i = 0; i < 600 && !this.inBattle(); i++) yield 0;
    this.log(`${kind}: started`);
    yield* this.fight();
    yield* this.settle();
    this.log(`${kind}: over`);
  }

  private warpsOf(map: string): any[] {
    const def = this.game?.data?.maps?.[map];
    const out: any[] = [];
    for (const k in def?.warps ?? {}) if (def.warps[k]) out.push(def.warps[k]);
    return out;
  }

  private *teleport(map: string, x?: number, y?: number): Gen {
    const w = this.warpsOf(map)[0];
    if (!w && x === undefined) return;
    const before = this.lastMap;
    try { (Warp as any).request(Runtime._mod, this.game, map, x ?? w.x, y ?? w.y + 1, "down"); } catch (e) {
      console.log(`[pv] g3 leak: teleport ${map} failed: ${String(e)}`);
      return;
    }
    for (let i = 0; i < 600 && this.lastMap === before; i++) yield 0;
    yield* this.idle(60);
  }

  private firstStep(tx: number, ty: number): string | undefined {
    const C: any = Collision, P: any = Player, game = this.game;
    const Wd = C._widthCells, H = C._heightCells;
    const sx = P.cellX, sy = P.cellY;
    const goal = (x: number, y: number): boolean =>
      ty < 0 ? y === 0 : ty >= H ? y === H - 1 : tx < 0 ? x === 0 : tx >= Wd ? x === Wd - 1 : x === tx && y === ty;
    const seen = new Map<number, string>();
    const q: [number, number][] = [[sx, sy]];
    seen.set(sy * Wd + sx, "");
    while (q.length) {
      const [x, y] = q.shift()!;
      if (goal(x, y)) {
        let k = y * Wd + x, dir = "";
        while (k !== sy * Wd + sx) { const v = seen.get(k)!; const [d, from] = v.split("@"); dir = d!; k = Number(from); }
        return dir || undefined;
      }
      for (const [d, dx, dy] of DIRS) {
        let nx = x + dx, ny = y + dy;
        const [lx, ly] = C.ledgeLanding(game, x, y, d);
        if (lx != null) { nx = lx; ny = ly; } else {
          if (nx < 0 || ny < 0 || nx >= Wd || ny >= H) continue;
          const [ok] = C.canEnter(game, nx, ny, { fromX: x, fromY: y, dir: d, elevation: P.currentElevation });
          if (!ok) continue;
        }
        const k = ny * Wd + nx;
        if (seen.has(k)) continue;
        seen.set(k, `${d}@${y * Wd + x}`);
        q.push([nx, ny]);
      }
    }
    return undefined;
  }

  /** Walk to a cell (or off an edge: -1 / 999) until the map changes. */
  private *pathTo(tx: number, ty: number, onArrive = "DOWN", limit = 3000): Gen {
    const start = this.lastMap, t0 = this.tick;
    // the path is found again only when the player is on a new cell
    let lastCell = -1, key = "";
    while (this.tick - t0 < limit) {
      if (this.lastMap !== start) return;
      if (this.inBattle()) { yield* this.fight(); continue; }
      const P: any = Player, C: any = Collision;
      if (P.moving || Runtime.uiBusy?.() || (Field as any).locked) { yield Runtime.uiBusy?.() ? 1 << BIT.B! : 0; continue; }
      const atEdge = ty < 0 ? P.cellY === 0 : ty >= C._heightCells ? P.cellY === C._heightCells - 1 : tx < 0 ? P.cellX === 0 : tx >= C._widthCells ? P.cellX === C._widthCells - 1 : false;
      if (atEdge || (P.cellX === tx && P.cellY === ty)) {
        key = tx < 0 ? "LEFT" : tx >= C._widthCells ? "RIGHT" : ty < 0 ? "UP" : ty >= C._heightCells ? "DOWN" : onArrive;
      } else {
        const cell = P.cellY * 4096 + P.cellX;
        if (cell !== lastCell) {
          lastCell = cell;
          const d = this.firstStep(tx, ty);
          if (!d) return;
          key = KEY[d]!;
        }
      }
      yield 1 << BIT[key]!;
    }
  }

  private *door(): Gen {
    const live = this.warpsOf(this.lastMap).filter((w) => (Collision as any).warpAt(w.x, w.y));
    const w = live[0];
    if (!w) return;
    const C: any = Collision;
    if (C.isDoorWarp(this.game, w.x, w.y) && !C.isExitWarp(this.game, w.x, w.y)) yield* this.pathTo(w.x, w.y + 1, "UP");
    else yield* this.pathTo(w.x, w.y);
  }

  private *menus(): Gen {
    for (const [k, after] of [["START", 40], ["A", 90], ["A", 60], ["A", 120], ["RIGHT", 60], ["RIGHT", 60], ["B", 60], ["B", 40],
      ["B", 60], ["DOWN", 20], ["A", 120], ["RIGHT", 40], ["RIGHT", 40], ["B", 90], ["B", 60]] as [string, number][]) {
      yield* this.tap(k, 4, after);
    }
    yield* this.settle();
    this.log("menus: party, summary, bag");
  }

  private *session(): Gen {
    yield* this.idle(120);
    const s = Runtime.getSession();
    for (const [sp, lv] of [[4, 24], [1, 24], [7, 24], [25, 26], [92, 26], [66, 26]]) (Party as any).giveMon(s, sp, lv);
    (Options as any).ensure(s).battleStyle = 1; // SET: no "will you change?" between a trainer's mons
    this.log("begins");
    const wilds: [number, number][] = [[16, 4], [19, 5], [10, 3], [41, 6], [74, 7], [129, 5], [43, 6], [21, 5], [56, 8], [60, 6], [23, 6], [100, 9]];
    const trainers = [0x66, 0x67, 0x68, 0x8e, 0x8f, 0x9c, 0xa1, 0xb0, 0xc0];
    const cities = ["FR_VIRIDIAN_CITY", "FR_PEWTER_CITY", "FR_CERULEAN_CITY", "FR_CELADON_CITY", "FR_SAFFRON_CITY", "FR_VERMILION_CITY", "FR_PALLET_TOWN"];
    for (let i = 0; i < 12; i++) {
      const p = s.party;
      const k = 1 + (i % 6);
      if (p && p[k]) { const t = p[1]; p[1] = p[k]; p[k] = t; }
      if (i % 3 === 2) {
        const id = trainers[i % trainers.length]!;
        const foe = (Trainers as any).foeFromId(id);
        if (foe) yield* this.battle(`trainer ${id}`, () => (BattleBridge as any).start(Runtime._mod, this.game, foe, { trainerId: id }));
      } else {
        const [sp, lv] = wilds[i % wilds.length]!;
        yield* this.battle(`wild #${sp} L${lv}`, () => (BattleBridge as any).startWild(Runtime._mod, this.game, { species: sp, level: lv }, {}));
      }
      const city = cities[i % cities.length]!;
      yield* this.teleport(city);
      yield* this.settle();
      this.log(`teleport ${city} -> ${this.lastMap}`);
      yield* this.door(); yield* this.settle(); yield* this.idle(60);
      this.log(`  in ${this.lastMap}`);
      yield* this.door(); yield* this.settle(); yield* this.idle(60);
      this.log(`  out to ${this.lastMap}`);
      if (i % 4 === 3) yield* this.menus();
    }
    // a connection both ways (Viridian's south edge: Pallet's north one runs the professor's script)
    yield* this.teleport("FR_VIRIDIAN_CITY");
    yield* this.settle();
    for (let j = 0; j < 2; j++) {
      yield* this.pathTo(0, 999); yield* this.idle(30); yield* this.settle();
      this.log(`south to ${this.lastMap}`);
      yield* this.pathTo(0, -1); yield* this.idle(30); yield* this.settle();
      this.log(`north to ${this.lastMap}`);
    }
    // the big cities in 3D after all that: standing, then a walk about
    for (const city of ["FR_CELADON_CITY", "FR_SAFFRON_CITY"]) {
      yield* this.teleport(city);
      yield* this.settle();
      yield* this.idle(300);
      this.log(`big city ${this.lastMap}, standing`);
      for (let j = 0; j < 4; j++) yield* this.tap(["RIGHT", "UP", "LEFT", "DOWN"][j]!, 48, 4);
      this.log(`big city ${this.lastMap}, walked`);
    }
    this.log("done");
  }
}
