// pocket-voxel platform for the gen3 (FireRed) port (GPLv3 + additional terms;
// see LICENSE.md). The device bench's transitions (main.ts in bench mode with
// PV_G3_BENCH_SCRIPT="load"): from main.ts's placed new game, each kind of
// screen change the player sees -- a warp, wild and trainer battles and
// their ends, the START menu and each of its screens opened and closed, a
// door in and out, a walk across a seam each way -- with a mark line before
// each ("[pv] g3 mark: <name>"). The host's hitch lines (gen3/pace.rs) fall
// between the marks, so tools/gen3/load_table.py can say, per transition,
// the worst frame and how many frames came late. It presses the game's own
// buttons (and starts the battles and the first warp as a script would).
// main.ts makes one only in bench mode; a game build never runs it.

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
import { Stack } from "../ui/stack.ts";
import { StartMenu } from "../ui/start_menu.ts";
import { Flags } from "../core/scripting/flags.ts";
import { Space } from "../core/scripting/space.ts";
import { Oam } from "../core/oam.ts";
import { PartyMenu } from "../ui/party_menu.ts";
import { SummaryMenu } from "../ui/summary_menu.ts";
import { BottomScreen } from "../ui/bottom_screen.ts";

const BIT: Record<string, number> = { UP: 0, DOWN: 1, LEFT: 2, RIGHT: 3, A: 4, B: 5, START: 6, SELECT: 7 };
const DIRS: [string, number, number][] = [["up", 0, -1], ["down", 0, 1], ["left", -1, 0], ["right", 1, 0]];

type Gen = Generator<number, void, unknown>;

export class BenchLoad {
  done = false;
  private it: Gen;
  private game: any;
  private tick = 0;
  private lastMap = "";
  private moveTurn = 0;

  /** The battle being fought (its exit is marked by afterUpdate, in the tick it ends). */
  private fighting = "";

  /** `part`: "" the whole session, or "battle", "menu" or "walk" alone; "stray" (the
   *  battle pictures after the party menu), "city" (the big cities' memory) or
   *  "bottom" (the bottom screen's tabs, photographed). */
  constructor(game: any, private readonly mem: () => string, private readonly part = "") {
    this.game = game;
    this.it = this.session();
  }

  /** After the tick's game.update (main.ts): a battle that just ended is marked
   *  now, before the frame that brings the field back is drawn. */
  afterUpdate(): void {
    if (this.fighting && !this.inBattle()) {
      this.mark(`${this.fighting}: exit`);
      this.fighting = "";
    }
  }

  /** Frames of a battle (with no party screen up) that drew a party-menu
   *  sprite or a small picture in the spot left of the foe's health box. */
  strays = 0;
  /** Probe every part's frames (the desktop runner), not just the "stray" part's. */
  probeAlways = false;
  /** A screenshot (the device's), taken a while into each fight of the "stray" part. */
  shot: (() => void) | undefined;

  /**
   * Each frame's draw list (main.ts / tools/gen3/qjs_load.ts hand it over):
   * a party-menu mon icon left behind (OAM sprite 0, ui/party_menu.ts
   * ensure_slot_sprites) stood left of the foe's health box in every battle
   * after the party menu (Isaac's shot). Nothing in a battle draws a 32x32
   * picture (a mon icon's size) there (starting left of x 16, reaching
   * 30 <= y < 58, into any target; the foe's box slides in over it with its
   * 16 px glyphs and 8 px parts), and with no party screen up no OAM sprite is live on the ui
   * layer (the battle's sprites are its own).
   */
  probeFrame(list: Float32Array): void {
    // (the stray part's, and the desktop runs': a walk over each frame's list
    // would cost the other parts' timings a few ms a frame on the console)
    if (this.part !== "stray" && !this.probeAlways) return;
    if (!this.inBattle() || PartyMenu.open || SummaryMenu.isOpen?.()) return;
    let found = "";
    for (let i = 0, target = 0; i < list.length;) {
      const op = list[i]!;
      if (op === 1) { target = list[i + 1]!; i += 2; } else if (op === 2) i += 5;
      else if (op === 3) i += 24;
      else if (op === 4) {
        let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
        for (let k = 0; k < 4; k++) {
          const x = list[i + 2 + k * 2]!, y = list[i + 3 + k * 2]!;
          if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
        if (Math.round(x1 - x0) === 32 && Math.round(y1 - y0) === 32 && x0 < 16 && x1 > 0 && y1 > 30 && y0 < 58) {
          found = `a ${Math.round(x1 - x0)}x${Math.round(y1 - y0)} picture (texture ${list[i + 1]}, target ${target}) at ${Math.round(x0)},${Math.round(y0)}`;
        }
        i += 18;
      } else if (op === 5) i += 6 + list[i + 1]! * 6;
      else if (op === 6) i += 13;
      else break;
    }
    const pool = (Oam as any)._sprites as any[] | null;
    for (let i = 0; !found && pool && i < pool.length; i++) {
      const s = pool[i];
      if (s && s.inUse && !s.invisible && s.image && (s.layer ?? "ui") === "ui") {
        found = `OAM sprite ${i} live on the ui layer (image ${s.image.id}) at ${s.x},${s.y}`;
      }
    }
    if (!found) return;
    this.strays++;
    if (this.strays <= 5) console.log(`[pv] g3 stray: ${found} (tick ${this.tick}, top ${this.top()})`);
  }

  /** The buttons held at `tick`. */
  at(tick: number, game: any): number {
    this.tick = tick;
    this.game = game;
    if (this.done) return 0;
    this.lastMap = Runtime.getSession?.()?.map ?? "";
    const r = this.it.next();
    if (r.done) { this.done = true; return 0; }
    return r.value;
  }

  private top(): string {
    const L: any = (Stack as any)._layers;
    let n = 0;
    while (L && L[n + 1] != null) n++;
    return n > 0 ? String(L[n].id ?? "?") : "-";
  }

  private mark(what: string): void {
    console.log(`[pv] g3 mark: ${what} (tick ${this.tick}, map ${this.lastMap}, top ${this.top()}, battle ${this.inBattle() ? 1 : 0})`);
  }

  inBattle(): boolean { const g = this.game; return !!(g && g.speedCategory && g.speedCategory() === "battle"); }

  private *idle(n: number): Gen { for (let i = 0; i < n; i++) yield 0; }
  private *tap(key: string, hold = 4, after = 20): Gen {
    for (let i = 0; i < hold; i++) yield 1 << BIT[key]!;
    for (let i = 0; i < after; i++) yield 0;
  }

  /** A battle to its end, by the battle UI's own state (bench_leak.ts's driver). */
  private *fight(): Gen {
    const t0 = this.tick;
    let want = 1, tries = 0;
    // the "stray" part photographs each fight a few seconds in
    // (then once the player's health box is up: its EXP bar)
    const shots = this.part === "stray" && this.shot ? [t0 + 240, t0 + 420] : [];
    while (this.inBattle() && this.tick - t0 < 12000) {
      if (shots.length && this.tick >= shots[0]!) { shots.shift(); this.shot!(); console.log(`[pv] g3 stray: shot (tick ${this.tick}, ${this.strays} stray frames so far)`); }
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
      console.log(`[pv] g3 mark: battle still on after ${this.tick - t0} ticks: ended as a win`);
      try { (BattleBridge as any).finishPending("win"); } catch { /* the bench goes on */ }
    }
  }

  private *settle(): Gen {
    for (let i = 0; i < 300; i++) {
      if (this.inBattle()) { yield* this.fight(); continue; }
      if (Runtime.uiBusy?.() || (Field as any).locked) yield* this.tap("B", 4, 12); else return;
    }
  }

  private *battle(kind: string, start: () => [any, any]): Gen {
    this.mark(`${kind}: start`);
    let ok: any, err: any;
    try { [ok, err] = start(); } catch (e) { ok = false; err = String(e); }
    if (!ok) { console.log(`[pv] g3 mark: ${kind}: start failed: ${err}`); return; }
    for (let i = 0; i < 600 && !this.inBattle(); i++) yield 0;
    this.mark(`${kind}: fight`);
    // the battle screen going is marked by afterUpdate: what follows is its
    // teardown and the field coming back
    this.fighting = kind;
    yield* this.fight();
    yield* this.idle(240);
    yield* this.settle();
    this.mark(`${kind}: after`);
    yield* this.idle(60);
  }

  private warpsOf(map: string): any[] {
    const def = this.game?.data?.maps?.[map];
    const out: any[] = [];
    for (const k in def?.warps ?? {}) if (def.warps[k]) out.push(def.warps[k]);
    return out;
  }

  private *teleport(map: string): Gen {
    const w = this.warpsOf(map)[0];
    if (!w) return;
    const before = this.lastMap;
    try { (Warp as any).request(Runtime._mod, this.game, map, w.x, w.y + 1, "down"); } catch (e) {
      console.log(`[pv] g3 mark: teleport ${map} failed: ${String(e)}`);
      return;
    }
    for (let i = 0; i < 600 && this.lastMap === before; i++) yield 0;
    yield* this.idle(180);
  }

  /** The whole route to a cell (or an edge) as cells to step onto, found once:
   *  a search per step was itself a hitch of up to a second on the console. */
  private route(tx: number, ty: number): number[] | undefined {
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
        const cells: number[] = [];
        let k = y * Wd + x;
        while (k !== sy * Wd + sx) { cells.unshift(k); const v = seen.get(k)!; k = Number(v.split("@")[1]); }
        return cells;
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
  private *pathTo(tx: number, ty: number, onArrive = "DOWN", limit = 3000, stop = false, pre?: number[]): Gen {
    const start = this.lastMap, t0 = this.tick;
    let cells: number[] | undefined = pre;
    let at = 0, still = 0, lastCell = -1;
    while (this.tick - t0 < limit) {
      if (this.lastMap !== start) return;
      if (this.inBattle()) { yield* this.fight(); cells = undefined; continue; }
      const P: any = Player, C: any = Collision;
      if (P.moving || Runtime.uiBusy?.() || (Field as any).locked) { yield Runtime.uiBusy?.() ? 1 << BIT.B! : 0; continue; }
      if (stop && P.cellX === tx && P.cellY === ty) return;
      const Wd = C._widthCells;
      const atEdge = ty < 0 ? P.cellY === 0 : ty >= C._heightCells ? P.cellY === C._heightCells - 1 : tx < 0 ? P.cellX === 0 : tx >= Wd ? P.cellX === Wd - 1 : false;
      let key: string;
      if (atEdge || (P.cellX === tx && P.cellY === ty)) {
        key = tx < 0 ? "LEFT" : tx >= Wd ? "RIGHT" : ty < 0 ? "UP" : ty >= C._heightCells ? "DOWN" : onArrive;
      } else {
        const cell = P.cellY * Wd + P.cellX;
        // where the route expects the player; anywhere else (pushed, blocked
        // for long): a new route from here
        if (cell !== lastCell) { still = 0; lastCell = cell; } else if (++still > 40) { cells = undefined; still = 0; }
        if (cells) {
          const k = cells.indexOf(cell);
          if (k >= 0) at = k + 1; else if (at > 0 && cells[at - 1] !== cell) cells = undefined;
        }
        if (!cells) { cells = this.route(tx, ty); at = 0; }
        const next = cells?.[at];
        if (next == null) return;
        const nx = next % Wd, ny = Math.floor(next / Wd);
        key = ny < P.cellY ? "UP" : ny > P.cellY ? "DOWN" : nx < P.cellX ? "LEFT" : "RIGHT";
      }
      yield 1 << BIT[key]!;
    }
  }

  /** Through the map's first live warp (a door from outside, the exit mat from inside). */
  private *door(what: string): Gen {
    const live = this.warpsOf(this.lastMap).filter((w) => (Collision as any).warpAt(w.x, w.y));
    const w = live[0];
    if (!w) { console.log(`[pv] g3 mark: ${what}: no warp on ${this.lastMap}`); return; }
    const C: any = Collision;
    const isDoor = C.isDoorWarp(this.game, w.x, w.y) && !C.isExitWarp(this.game, w.x, w.y);
    // walk to the cell before the warp in a bench segment of its own (its
    // route search is the bench's cost): the transition is the last step
    this.mark(`~walk to ${what}`);
    if (isDoor) yield* this.pathTo(w.x, w.y + 2, "UP", 3000, true); else yield* this.pathTo(w.x, w.y - 1, "DOWN", 3000, true);
    yield* this.idle(30);
    this.mark(what);
    if (isDoor) yield* this.pathTo(w.x, w.y + 1, "UP"); else yield* this.pathTo(w.x, w.y);
    yield* this.idle(240);
    yield* this.settle();
  }

  /** Across the map's edge into the next one (the route found first, in a bench segment). */
  private *seam(what: string, tx: number, ty: number): Gen {
    this.mark(`~route for ${what}`);
    const r = this.route(tx, ty);
    yield* this.idle(2);
    this.mark(what);
    yield* this.pathTo(tx, ty, "DOWN", 3000, false, r);
    yield* this.idle(240);
    yield* this.settle();
  }

  /** The START menu's cursor onto entry `id`. */
  private *menuTo(id: string): Gen {
    for (let i = 0; i < 12; i++) {
      const e = StartMenu.ENTRIES?.[StartMenu.cursor];
      if (!StartMenu.open || (e && e.id === id)) return;
      yield* this.tap("DOWN", 4, 10);
    }
  }

  /** A marked key press, then a wait for what it brought up. */
  private *step(what: string, key: string, after: number): Gen {
    this.mark(what);
    yield* this.tap(key, 4, after);
  }

  /** Back to the START menu itself (a screen or a sub-menu still up is closed). */
  private *toStart(): Gen {
    for (let i = 0; i < 6 && this.top() !== "start" && this.top() !== "-"; i++) yield* this.tap("B", 4, 60);
  }

  private *menus(): Gen {
    yield* this.step("menu: open", "START", 60);
    console.log(`[pv] g3 mark: menu entries ${(StartMenu.ENTRIES ?? []).filter(Boolean).map((e: any) => e.id).join(",")}`);
    yield* this.menuTo("pokemon");
    yield* this.step("party: open", "A", 120);
    yield* this.step("party: mon menu", "A", 60);
    yield* this.step("summary: open", "A", 150);
    yield* this.step("summary: page", "RIGHT", 60);
    yield* this.step("summary: close", "B", 120);
    yield* this.step("party: close", "B", 120);
    yield* this.toStart();
    yield* this.menuTo("bag");
    yield* this.step("bag: open", "A", 150);
    yield* this.step("bag: pocket", "RIGHT", 60);
    yield* this.step("bag: close", "B", 150);
    yield* this.toStart();
    yield* this.menuTo("option");
    yield* this.step("option: open", "A", 120);
    yield* this.step("option: close", "B", 120);
    yield* this.toStart();
    yield* this.menuTo("save");
    yield* this.step("save: open", "A", 120);
    yield* this.step("save: yes", "A", 400);
    // the save is done: its last text goes, back to the field
    yield* this.step("save: close", "B", 120);
    if (StartMenu.open) yield* this.step("menu: close", "B", 120);
    yield* this.step("menu: open again", "START", 60);
    yield* this.step("menu: close again", "B", 120);
    yield* this.settle();
  }

  private *battles(again: boolean): Gen {
    if (again) {
      yield* this.battle("wild 3 (again)", () => (BattleBridge as any).startWild(Runtime._mod, this.game, { species: 16, level: 4 }, {}));
      return;
    }
    yield* this.battle("wild 1", () => (BattleBridge as any).startWild(Runtime._mod, this.game, { species: 16, level: 4 }, {}));
    yield* this.battle("wild 2", () => (BattleBridge as any).startWild(Runtime._mod, this.game, { species: 19, level: 5 }, {}));
    const id = 0x66;
    const foe = (Trainers as any).foeFromId(id);
    if (foe) yield* this.battle("trainer", () => (BattleBridge as any).start(Runtime._mod, this.game, foe, { trainerId: id }));
  }

  private *walks(again: string): Gen {
    yield* this.door(`door: in${again}`);
    yield* this.door(`door: out${again}`);
    yield* this.idle(60);
    yield* this.seam(`seam: walk south${again}`, 0, 999);
    yield* this.seam(`seam: walk north${again}`, 0, -1);
  }

  /** The bottom screen's four tabs, each photographed (main.ts's shot: the
   *  host dumps both screens, shot_N.ppm and shot_N_b.ppm). */
  private *bottomShots(where: string): Gen {
    for (const t of ["party", "bag", "map", "card"] as const) {
      // in the field the tabs are turned with Y, as a player turns them (the
      // host's button, g3HostKeys bit 6); elsewhere set
      if (where === "field" && t !== "party") yield* this.hostY();
      BottomScreen.setTab(t);
      yield* this.idle(30);
      this.mark(`bottom: ${where}: ${t}`);
      this.shot?.();
      yield* this.idle(8);
    }
  }

  /** Y pressed on the host's side for a few ticks (gen3::inject_keys). */
  private *hostY(): Gen {
    const hk = (globalThis as { voxel?: { g3HostKeys?(m: number): void } }).voxel?.g3HostKeys;
    if (!hk) return;
    const before = BottomScreen.tab;
    hk(64);
    yield* this.idle(4);
    hk(0);
    yield* this.idle(4);
    console.log(`[pv] g3 mark: bottom: Y turned ${before} to ${BottomScreen.tab}`);
  }

  /** The "bottom" part: the bottom screen in the field, over the party
   *  menu, in a wild battle (its first menu, and the field after), on
   *  another bag pocket, and in the two big cities (their linear memory
   *  with the bottom screen's canvas up). */
  private *bottomTour(): Gen {
    yield* this.bottomShots("field");
    yield* this.step("menu: open", "START", 60);
    yield* this.menuTo("pokemon");
    yield* this.step("party: open", "A", 120);
    yield* this.bottomShots("party menu");
    yield* this.step("party: close", "B", 120);
    yield* this.toStart();
    if (StartMenu.open) yield* this.step("menu: close", "B", 120);
    BottomScreen.setTab("party");
    this.mark("bottom: battle: start");
    try { (BattleBridge as any).startWild(Runtime._mod, this.game, { species: 19, level: 5 }, {}); } catch (e) { console.log(`[pv] g3 mark: bottom battle failed: ${String(e)}`); }
    for (let i = 0; i < 600 && !this.inBattle(); i++) yield 0;
    for (let i = 0; i < 1500 && this.inBattle() && (BattleUi as any)._mode !== "menu"; i++) yield 0;
    yield* this.bottomShots("battle");
    BottomScreen.setTab("party");
    this.fighting = "bottom: battle";
    yield* this.fight();
    yield* this.idle(240);
    yield* this.settle();
    yield* this.idle(60);
    this.mark("bottom: after the battle");
    this.shot?.();
    BottomScreen.setTab("bag");
    BottomScreen.bagPocket = 3;
    yield* this.idle(30);
    this.mark("bottom: bag pocket 3");
    this.shot?.();
    for (const c of ["FR_CELADON_CITY", "FR_SAFFRON_CITY"]) {
      this.mark(`bottom: warp to ${c}`);
      yield* this.teleport(c);
      yield* this.settle();
      yield* this.idle(240);
      BottomScreen.setTab(c === "FR_CELADON_CITY" ? "map" : "party");
      yield* this.idle(30);
      this.mark(`bottom: in ${this.lastMap}; ${this.mem()}`);
      this.shot?.();
    }
  }

  private *session(): Gen {
    yield* this.idle(240);
    const s = Runtime.getSession();
    for (const [sp, lv] of [[4, 24], [1, 24], [7, 24], [25, 26], [92, 26], [66, 26]]) (Party as any).giveMon(s, sp, lv);
    (Options as any).ensure(s).battleStyle = 1; // SET: no "will you change?" between a trainer's mons
    // the START menu's POKéMON row (FLAG_SYS_POKEMON_GET), as the first one received sets it
    try { (Flags as any).setFlag((Space as any).store, null, 0x828, true); } catch { /* the row stays hidden */ }
    this.mark(`begins; ${this.mem()}`);
    this.mark("warp: teleport");
    yield* this.teleport("FR_VIRIDIAN_CITY");
    yield* this.settle();
    yield* this.idle(120);
    this.mark(`arrived; ${this.mem()}`);
    const all = this.part === "";
    if (this.part === "city") {
      // the big cities: the world's linear memory, and a battle in each
      // with the world kept or let go (gen3/mod.rs hold_rebuild)
      for (const c of ["FR_CELADON_CITY", "FR_SAFFRON_CITY"]) {
        this.mark(`city: warp to ${c}`);
        yield* this.teleport(c);
        yield* this.settle();
        yield* this.idle(240);
        this.mark(`city: in ${this.lastMap}; ${this.mem()}`);
        yield* this.battle(`city: ${c} wild`, () => (BattleBridge as any).startWild(Runtime._mod, this.game, { species: 19, level: 5 }, {}));
        this.mark(`city: after the battle; ${this.mem()}`);
      }
      this.mark(`done; ${this.mem()}`);
      return;
    }
    if (this.part === "bottom") {
      yield* this.bottomTour();
      this.mark(`done; ${this.mem()}`);
      return;
    }
    if (this.part === "stray") {
      // the party menu (and its summary) closed, then a battle: Isaac's
      // stale party icon beside the foe's health box
      yield* this.battle("stray: wild before", () => (BattleBridge as any).startWild(Runtime._mod, this.game, { species: 16, level: 4 }, {}));
      yield* this.menus();
      yield* this.battle("stray: wild after menus", () => (BattleBridge as any).startWild(Runtime._mod, this.game, { species: 16, level: 4 }, {}));
      yield* this.menus();
      yield* this.battle("stray: wild after menus again", () => (BattleBridge as any).startWild(Runtime._mod, this.game, { species: 19, level: 5 }, {}));
      this.mark(`done; ${this.strays} stray frames; ${this.mem()}`);
      return;
    }
    if (all || this.part === "battle") { yield* this.battles(false); this.mark(`battles done; ${this.mem()}`); }
    if (all || this.part === "menu") { yield* this.menus(); this.mark(`menus done; ${this.mem()}`); }
    if (all || this.part === "walk") { yield* this.walks(""); this.mark(`walks done; ${this.mem()}`); }
    // the same again: what a second time costs
    if (all || this.part === "walk") yield* this.walks(" again");
    if (all || this.part === "battle") yield* this.battles(true);
    if (all || this.part === "menu") yield* this.menus();
    this.mark(`done; ${this.strays} stray frames; ${this.mem()}`);
  }
}
