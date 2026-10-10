// pocket-voxel platform for the gen3 (FireRed) port (GPLv3 + additional terms;
// see LICENSE.md). The device bench of VIEW 2D (main.ts in bench mode with
// PV_G3_BENCH_SCRIPT="view2d:..."; tools/gen3/view2d_check.ts runs the same
// walk on the desktop): on main.ts's placed new game, the field in VIEW 2D
// standing, walking and running a shuttle, each phase ending with a line of
// its guest cost (as bench_suite.ts's). main.ts makes one only in bench
// mode; a game build never runs it.
//
//   view2d:<walk>[:<opt>=<v>...]
//     walk  cell steps, a letter each (R L U D), repeated: "RRRRLLLL"
//     opt   game.options set before the first phase: zoom2d=67, screen2d=wide

/* eslint-disable @typescript-eslint/no-explicit-any */
import { Runtime } from "../core/runtime.ts";
import { Player } from "../core/player.ts";

/** The sampling profiler's globals, in a bench built with it (tools/gen3/qjs_prof.c). */
const prof = globalThis as { profReset?(): void; profDump?(n: number, title: string): void };

const BIT: Record<string, number> = { U: 0, D: 1, L: 2, R: 3, A: 4, B: 5, START: 6 };
/** The phases: [name, ticks]. */
const PHASES: [string, number][] = [["settle", 180], ["standing", 720], ["walking", 1200], ["running", 1200]];

class Stat {
  n = 0; sum = 0; max = 0;
  add(v: number): void { this.n++; this.sum += v; if (v > this.max) this.max = v; }
  text(): string { return this.n ? `${(this.sum / this.n / 1000).toFixed(2)} avg ${(this.max / 1000).toFixed(1)} max` : "-"; }
}

export class BenchView2d {
  private readonly walk: string;
  private readonly opts: Record<string, string | number> = {};
  private readonly presses: [number, number][] = [];
  private phase = -1;
  private t0 = 0;
  private up = new Stat();
  private draw = new Stat();
  private frame = new Stat();
  private over = 0;
  private lastUp = 0;
  private slowLogged = 0;
  private tick = 0;
  private step = 0;
  private stepAt = 0;
  private blocked = 0;
  private baseX: number | null = null;
  private baseY: number | null = null;
  done = false;
  /** Log lines go here (main.ts: console.log; the desktop check: its own). */
  log: (s: string) => void = (s) => console.log(s);

  constructor(script: string) {
    const parts = script.split(":");
    this.walk = (parts[1] || "RRRLLL").toUpperCase().replace(/[^RLUD]/g, "") || "RRRLLL";
    for (const p of parts.slice(2)) {
      const [k, v] = p.split("=");
      if (k === "profslow") (globalThis as { __profSlowUs?: number }).__profSlowUs = Number(v) * 1000;
      // press=TICK.KEY+TICK.KEY...: a button tapped (4 ticks) at those ticks
      // while standing -- a menu over the field, for a photograph
      else if (k === "press" && v) {
        for (const t of v.split("+")) {
          const [tk, key] = t.split(".");
          if (tk && key && BIT[key.toUpperCase()] != null) this.presses.push([Number(tk), 1 << BIT[key.toUpperCase()]!]);
        }
      }
      else if (k && v != null) this.opts[k] = /^\d+$/.test(v) ? Number(v) : v;
    }
  }

  get phaseName(): string { return PHASES[this.phase]?.[0] ?? ""; }

  private where(_game: any): string {
    const ses = Runtime.isActive() ? Runtime.getSession?.() : null;
    return ses ? `${ses.map} (${ses.x},${ses.y})` : "?";
  }

  private begin(i: number, tick: number, game: any): void {
    this.end(tick, game);
    this.phase = i;
    this.t0 = tick;
    if (i < PHASES.length) this.log(`[pv] g3 view2d: ${PHASES[i]![0]} begins at tick ${tick} at ${this.where(game)}`);
    // a bench built with the sampling profiler (tools/gen3/qjs_prof.c): a profile a phase
    if (prof.profReset && i < PHASES.length) prof.profReset();
  }

  private end(tick: number, game: any): void {
    if (this.phase < 0 || this.phase >= PHASES.length) return;
    const name = PHASES[this.phase]![0];
    if (name !== "settle") {
      this.log(`[pv] g3 view2d: ${name}: ${this.draw.n} frames, ${tick - this.t0} ticks; update ${this.up.text()} ms/tick, ` +
        `draw ${this.draw.text()} ms, a frame at 60 ${this.frame.text()} ms (${this.over} over 12 ms); now at ${this.where(game)}`);
      if (prof.profDump) prof.profDump(60, name);
    }
    this.up = new Stat(); this.draw = new Stat(); this.frame = new Stat();
    this.over = 0;
    this.slowLogged = 0;
  }

  noteUpdate(us: number): void {
    this.up.add(us); this.lastUp = us;
    if (us > 12000 && this.slowLogged++ < 10) this.log(`[pv] g3 view2d: slow update ${(us / 1000).toFixed(1)} ms at tick ${this.tick} (${this.phaseName})`);
  }

  noteDraw(us: number): void {
    this.draw.add(us); this.frame.add(this.lastUp + us);
    if (this.lastUp + us > 12000) this.over++;
    if (us > 10000 && this.slowLogged++ < 10) this.log(`[pv] g3 view2d: slow draw ${(us / 1000).toFixed(1)} ms at tick ${this.tick} (${this.phaseName})`);
  }

  /** The buttons held at `tick`. */
  at(tick: number, game: any): number {
    this.tick = tick;
    if (this.done) return 0;
    if (this.phase < 0) {
      if (game?.options) {
        game.options.view = "2d";
        // (the zoom rows as the bench names them, NORMAL and OFF otherwise --
        // not whatever a card's saved options last held)
        game.options.screen2d = "normal";
        game.options.zoom2d = 100;
        for (const k in this.opts) game.options[k] = this.opts[k];
      }
      this.log(`[pv] g3 view2d: walk ${this.walk}, options ${JSON.stringify(this.opts)}`);
      this.begin(0, tick, game);
    }
    if (tick - this.t0 >= PHASES[this.phase]![1]) {
      this.begin(this.phase + 1, tick, game);
      if (this.phase >= PHASES.length) {
        this.done = true;
        this.log(`[pv] g3 view2d: done at tick ${tick}`);
        return 0;
      }
    }
    const name = PHASES[this.phase]![0];
    if (name !== "walking" && name !== "running") {
      for (const [t, m] of this.presses) if (tick >= t && tick < t + 4) return m;
      return 0;
    }
    const run = name === "running";
    // closed loop: hold the step's direction until the player is bound for
    // (or stands in) the step's cell, so the walk never drifts into a wall
    const P: any = Player;
    const cx = Number(P.moving ? P.targetX : P.cellX), cy = Number(P.moving ? P.targetY : P.cellY);
    if (this.baseX == null || tick === this.t0) { this.baseX = cx; this.baseY = cy; this.stepAt = tick; }
    let k = this.walk[this.step % this.walk.length]!;
    const tx = this.baseX + (k === "R" ? 1 : k === "L" ? -1 : 0), ty = this.baseY! + (k === "D" ? 1 : k === "U" ? -1 : 0);
    if ((cx === tx && cy === ty) || tick - this.stepAt > 64) {
      if (tick - this.stepAt > 64 && this.blocked++ < 4) this.log(`[pv] g3 view2d: step ${k} from (${this.baseX},${this.baseY}) blocked`);
      this.baseX = cx; this.baseY = cy;
      this.step++;
      this.stepAt = tick;
      k = this.walk[this.step % this.walk.length]!;
    }
    return (1 << BIT[k]!) | (run ? 1 << BIT.B! : 0);
  }
}
