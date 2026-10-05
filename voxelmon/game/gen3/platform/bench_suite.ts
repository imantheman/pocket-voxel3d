// pocket-voxel platform for the gen3 (FireRed) port (GPLv3 + additional terms;
// see LICENSE.md). The device bench's screen suite (main.ts in bench mode
// with PV_G3_BENCH_SCRIPT="suite"): from main.ts's placed new game on the
// town, a timed run through each kind of screen the 60 fps work is measured
// on -- the field in 3D standing and walking, the field in VIEW 2D walking,
// a wild battle fought with three different moves, the start menu with the
// party, a summary and the bag -- pressing the game's own buttons. Each
// phase ends with a line of its guest cost (update per tick, draw per frame,
// and a frame at 60: the last tick's update plus the draw). main.ts makes
// one only in bench mode; a game build never runs it.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { Game3World } from "./game3_world.ts";
import { Runtime } from "../core/runtime.ts";
import { Party } from "../core/party.ts";
import { BattleBridge } from "../core/battle_bridge.ts";

const BIT: Record<string, number> = { UP: 0, DOWN: 1, LEFT: 2, RIGHT: 3, A: 4, B: 5, START: 6, SELECT: 7 };

interface Tap { key: string; hold: number; after: number }
const tap = (key: string, hold = 4, after = 20): Tap => ({ key, hold, after });

class Stat {
  n = 0; sum = 0; max = 0;
  add(v: number): void { this.n++; this.sum += v; if (v > this.max) this.max = v; }
  text(): string { return this.n ? `${(this.sum / this.n / 1000).toFixed(2)} avg ${(this.max / 1000).toFixed(1)} max` : "-"; }
}

export class BenchSuite {
  phase = "";
  private taps: Tap[] = [];
  private tapAt = 0;
  private walkAt = 0;
  private up = new Stat();
  private draw = new Stat();
  private frame = new Stat();
  private lastUp = 0;
  private t0 = 0;
  private battleStart = 0;
  done = false;

  private begin(name: string, tick: number): void {
    this.end(tick);
    this.phase = name;
    this.t0 = tick;
    console.log(`[pv] g3 suite: ${name} begins at tick ${tick}`);
  }
  private end(tick: number): void {
    if (!this.phase) return;
    console.log(`[pv] g3 suite: ${this.phase}: ${this.draw.n} frames, ${tick - this.t0} ticks; update ${this.up.text()} ms/tick, ` +
      `draw ${this.draw.text()} ms, a frame at 60 ${this.frame.text()} ms`);
    this.up = new Stat(); this.draw = new Stat(); this.frame = new Stat();
  }

  /** The guest's cost of one tick's update (us). */
  noteUpdate(us: number): void { this.up.add(us); this.lastUp = us; }
  /** The guest's cost of one shown frame's draw and world (us). */
  noteDraw(us: number): void { this.draw.add(us); this.frame.add(this.lastUp + us); }

  private inBattle(game: any): boolean {
    return game && game.speedCategory && game.speedCategory() === "battle";
  }

  /** A walk: three cells each way round a square. */
  private walk(): number {
    const k = ["RIGHT", "UP", "LEFT", "DOWN"][Math.floor(this.walkAt++ / 48) % 4]!;
    return 1 << BIT[k]!;
  }

  /** The queued taps' keys for this tick (0 between and after them). */
  private tapKeys(): number {
    const t = this.taps[0];
    if (!t) return 0;
    const i = this.tapAt++;
    if (i >= t.hold + t.after) { this.taps.shift(); this.tapAt = 0; return this.tapKeys(); }
    return i < t.hold ? 1 << BIT[t.key]! : 0;
  }

  /** The buttons held at `tick` (and the phase's actions). */
  at(tick: number, game: any): number {
    if (this.done) return 0;
    if (tick === 1) this.begin("field 3D, standing", tick);
    if (tick < 600) return 0;
    if (tick === 600) this.begin("field 3D, walking", tick);
    if (tick < 1500) return this.walk();
    if (tick === 1500) { Game3World.force2d = true; this.begin("field VIEW 2D, walking", tick); }
    if (tick < 2400) return this.walk();
    if (tick === 2400) {
      Game3World.force2d = false;
      try {
        const session = Runtime.getSession();
        (Party as any).giveMon(session, 4, 12);
        (Party as any).giveMon(session, 1, 12);
        const [ok, err] = (BattleBridge as any).startWild(Runtime._mod, game, { species: 16, level: 4 }, {});
        if (!ok) console.log(`[pv] g3 suite: startWild failed: ${err}`);
      } catch (e) {
        console.log(`[pv] g3 suite: battle setup failed: ${String(e)}`);
      }
      this.begin("battle: the transition", tick);
      return 0;
    }
    if (this.phase === "battle: the transition") {
      if (this.inBattle(game)) { this.begin("battle: menus, moves, animations", tick); this.battleStart = tick; }
      else if (tick - this.t0 > 600) this.begin("battle: none (transition timed out)", tick);
      return 0;
    }
    if (this.phase === "battle: menus, moves, animations") {
      if (!this.inBattle(game) || tick - this.battleStart > 9000) {
        this.taps = [];
        this.begin("field 3D, after the battle", tick);
        return 0;
      }
      if (!this.taps.length) {
        // FIGHT, a move (Scratch, Ember, Growl in turn), then the text
        const m = Math.floor((tick - this.battleStart) / 7) % 3;
        this.taps.push(tap("A", 4, 30));
        if (m === 1) this.taps.push(tap("DOWN", 4, 10));
        if (m === 2) this.taps.push(tap("RIGHT", 4, 10));
        this.taps.push(tap("A", 4, 30));
        for (let i = 0; i < 8; i++) this.taps.push(tap("B", 4, 26));
      }
      return this.tapKeys();
    }
    if (this.phase === "field 3D, after the battle") {
      if (tick - this.t0 < 120) return 0;
      this.begin("menus: start menu, party, summary, bag", tick);
      this.taps = [tap("START", 4, 40), tap("A", 4, 90), tap("A", 4, 60), tap("A", 4, 120), tap("RIGHT", 4, 60),
        tap("RIGHT", 4, 60), tap("B", 4, 60), tap("B", 4, 40), tap("B", 4, 60), tap("DOWN", 4, 20), tap("A", 4, 120),
        tap("RIGHT", 4, 40), tap("RIGHT", 4, 40), tap("B", 4, 90), tap("B", 4, 60)];
    }
    if (this.phase === "menus: start menu, party, summary, bag") {
      if (this.taps.length) return this.tapKeys();
      this.begin("field 3D, standing again", tick);
      return 0;
    }
    if (this.phase === "field 3D, standing again" && tick - this.t0 >= 300) {
      this.end(tick);
      this.phase = "";
      this.done = true;
      console.log(`[pv] g3 suite: done at tick ${tick}`);
    }
    return 0;
  }
}
