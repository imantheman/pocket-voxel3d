// Gold story run: a new game played along the critical path by walking --
// paths found over the real collision (Permissions, ledges, surf), warps and
// connections taken on foot, people talked to by facing them and pressing A,
// text and YES prompts answered with A, battles fought by the battle screen's
// own menus -- so every scene, coord event, rival, trainer in sight and
// roadblock fires the way it does for a player. Each chapter checks what the
// story should have handed over (items, flags, badges); the run stops at the
// first chapter it cannot finish and says where it stood.
//   bun tools/gold_story.ts [last-chapter]
import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";
import { RecorderHost } from "../voxelmon/game/host.ts";
import { useGoldGen } from "../voxelmon/game/gen2/platform/data-node.ts";
import { Lcd } from "../voxelmon/game/gen2/platform/lcd.ts";
import { Game2 } from "../voxelmon/game/gen2/core/Game2.ts";
import { Logger } from "../voxelmon/game/gen2/shared/core/Logger.ts";
import { Permissions } from "../voxelmon/game/gen2/world/Permissions.ts";
import { FieldMoves } from "../voxelmon/game/gen2/world/FieldMoves.ts";
import { FlagNames } from "../voxelmon/game/gen2/core/FlagNames.ts";

type Dir = "up" | "down" | "left" | "right";
const DIRS: Dir[] = ["up", "down", "left", "right"];
const DELTA: Record<Dir, [number, number]> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
const BTN: Record<Dir, number> = { up: VOX_BTN.up, down: VOX_BTN.down, left: VOX_BTN.left, right: VOX_BTN.right };

useGoldGen();
const errors: string[] = [];
Logger.sink = (line: string) => {
  if (/error|not ported|notported/i.test(line)) errors.push(line);
};

export class StoryFail extends Error {}
export const fail = (msg: string): never => {
  throw new StoryFail(msg);
};

export const game: any = Game2.new();
game.load({ startWorld: true });
const lcd = new Lcd(new RecorderHost());
export let frames = 0;
const world = (): any => game.world;

function step(b = 0): void {
  game.frame(b);
  game.draw(lcd);
  lcd.end();
  frames++;
}

/** A screen over the world (battle, menu, naming...)? */
function screen(): any {
  const top = game.stack.top();
  return top && typeof top.update === "function" ? top : undefined;
}

/** Text, a script, a battle or a menu has the game: not the free world. */
function busy(): boolean {
  const w = world();
  return !!screen() || !w || !w.map || w.busy() || game.phase !== "play";
}

/** What to press while something has the game: the battle's own menus, A
 *  through text and at YES/NO (YES is the cursor's start), B out of shops. */
function busyPad(): number {
  const top = screen();
  if (top && top.screenId === "Gen2BattleState") {
    const phase: string = top.phase;
    const tick = frames % 4 === 0;
    if (phase === "menu") {
      if (tick && top.menuIndex === 1 && (top.messageTimer ?? 0) <= 0) return VOX_BTN.a;
      if (tick && top.menuIndex !== 1) return VOX_BTN.up;
      return 0;
    }
    if (phase === "moves") {
      const moves: any[] = top.playerMoves();
      const target = Math.max(1, moves.findIndex((m: any) => (m.pp ?? 1) > 0) + 1);
      if (!tick) return 0;
      return top.moveIndex < target ? VOX_BTN.down : top.moveIndex > target ? VOX_BTN.up : VOX_BTN.a;
    }
    return frames % 8 === 0 ? VOX_BTN.a : 0;
  }
  if (top && top.screenId === "Gen2NamingScreen") return frames % 20 === 0 ? VOX_BTN.start : frames % 20 === 10 ? VOX_BTN.a : 0;
  if (top && top.screenId === "Gen2Credits") return frames % 30 === 0 ? VOX_BTN.a : 0;
  if (top && answer) {
    const b = answer(top);
    if (b !== undefined) return b;
  }
  if (top && /Mart|Shop|PC|Pack|Party|StartMenu|Pokedex|Pokegear/i.test(top.screenId ?? "")) return frames % 10 === 0 ? VOX_BTN.b : 0;
  return frames % 8 === 0 ? VOX_BTN.a : 0;
}

/** A chapter's own answer for a screen (a NO, a menu pick), else default. */
let answer: ((top: any) => number | undefined) | null = null;
export function withAnswer<T>(fn: (top: any) => number | undefined, body: () => T): T {
  const was = answer;
  answer = fn;
  try {
    return body();
  } finally {
    answer = was;
  }
}

/** Let whatever has the game run out; the world free for `quiet` frames. */
export function settle(max = 20000, quiet = 8): void {
  let free = 0;
  for (let f = 0; f < max; f++) {
    if (busy()) {
      free = 0;
      step(busyPad());
    } else {
      if (++free >= quiet) return;
      step(0);
    }
  }
  fail(`never settled (${describe()})`);
}

export function describe(): string {
  const w = world();
  const p = w?.player;
  const top = screen();
  return `${w?.map?.id} (${p?.cellX},${p?.cellY}) ${top ? "screen " + (top.screenId ?? "?") : w?.busy() ? "busy" : "free"}` +
    `${w?.textbox ? " text" : ""}`;
}

// ---------------------------------------------------------------------------
// walking
// ---------------------------------------------------------------------------

const surfing = (): boolean => FieldMoves.isSurfing(world().playerState);
/** Field moves the run may use on the way (a chapter turns them on once the
 *  story has handed over the HM and the badge). */
export const can = { cut: false, surf: false, whirlpool: false, strength: false, waterfall: false };
function coll(x: number, y: number): any {
  const w = world();
  return w.cellCollisionAcross(w.map, x, y);
}

/** Where one step `dir` from (x, y) lands, or null: the movement rules. */
function stepFrom(x: number, y: number, dir: Dir, surf: boolean, goal?: [number, number]): [number, number] | null {
  const w = world();
  const map = w.map;
  if (!Permissions.stepPermitted(coll, x, y, dir)) return null;
  const [dx, dy] = DELTA[dir];
  const tx = x + dx;
  const ty = y + dy;
  if (!map.inBounds(tx, ty)) return null;
  const c = map.cellCollision(tx, ty);
  const ok = (surf ? Permissions.surfable(c) !== undefined : map.isWalkable(tx, ty))
    || (can.cut && Permissions.isCutTree(c));
  const npc = w.npcAt(tx, ty);
  if (ok && (!npc || (goal && goal[0] === tx && goal[1] === ty))) return [tx, ty];
  // .TryJump: a ledge under the feet that faces this way
  if (!surf) {
    const f = Permissions.ledgeFacings(map.cellCollision(x, y));
    if (f && f[dir] && map.inBounds(x + 2 * dx, y + 2 * dy) && map.isWalkable(x + 2 * dx, y + 2 * dy) && !w.npcAt(x + 2 * dx, y + 2 * dy)) {
      return [x + 2 * dx, y + 2 * dy];
    }
  }
  return null;
}

/** Shortest walk on this map to a cell `ok` accepts: the directions. */
function plan(ok: (x: number, y: number) => boolean, blocked = new Set<string>()): Dir[] | null {
  const w = world();
  const p = w.player;
  const surf = surfing();
  const start = `${p.cellX},${p.cellY}`;
  const prev = new Map<string, [string, Dir]>();
  const q: [number, number][] = [[p.cellX, p.cellY]];
  const seen = new Set([start]);
  // never across a warp on the way (it would take the player off the map)
  const warps = new Set<string>((w.maps[w.map.id]?.warps ?? []).map((wp: any) => `${wp.x},${wp.y}`));
  while (q.length) {
    const [x, y] = q.shift()!;
    if (ok(x, y)) {
      const out: Dir[] = [];
      let k = `${x},${y}`;
      while (k !== start) {
        const [pk, d] = prev.get(k)!;
        out.push(d);
        k = pk;
      }
      return out.reverse();
    }
    for (const d of DIRS) {
      if (blocked.has(`${x},${y},${d}`)) continue;
      const t = stepFrom(x, y, d, surf);
      if (!t) continue;
      const k = `${t[0]},${t[1]}`;
      if (seen.has(k) || (warps.has(k) && !ok(t[0], t[1]))) continue;
      seen.add(k);
      prev.set(k, [`${x},${y}`, d]);
      q.push(t);
    }
  }
  return null;
}

/** One step `dir`: held until the step starts, then let finish -- so the
 *  player moves exactly one cell (or turns and is refused). */
function press(dir: Dir): "moved" | "blocked" | "interrupted" | "map" {
  const w = world();
  const map = w.map.id;
  const p = w.player;
  const [x0, y0] = [p.cellX, p.cellY];
  let started = false;
  for (let f = 0; f < 80; f++) {
    if (busy()) return "interrupted";
    const q = world().player;
    step(started ? 0 : BTN[dir]);
    if (world().map.id !== map) return "map";
    const r = world().player;
    if (r.moving) started = true;
    if (!r.moving && (r.cellX !== x0 || r.cellY !== y0)) {
      // a slide (ice, a current) carries on by itself: let it end
      for (let g = 0; g < 200 && (busy() || world().player.moving); g++) step(busy() ? 0 : 0);
      return world().map.id !== map ? "map" : "moved";
    }
    if (!started && f > 24 && r.facing === dir) return "blocked";
    void q;
  }
  return "blocked";
}

/** Walk to a cell `ok` accepts on this map. Replans around people that get
 *  in the way; a script that starts on the way is let run first. */
export function walk(ok: (x: number, y: number) => boolean, what: string, leaving = false): void {
  const map = world().map.id;
  const blocked = new Set<string>();
  for (let tries = 0; tries < 40; tries++) {
    settle();
    if (world().map.id !== map) {
      if (leaving) return;
      fail(`walking to ${what}: left ${map} for ${world().map.id}`);
    }
    const p = world().player;
    if (ok(p.cellX, p.cellY)) return;
    const route = plan(ok, blocked);
    if (!route) fail(`no path to ${what} on ${map} from (${p.cellX},${p.cellY})`);
    for (const d of route) {
      const q = world().player;
      const [dx, dy] = DELTA[d];
      // a tree in the way: CUT it (A facing it, YES)
      if (can.cut && Permissions.isCutTree(world().map.cellCollision(q.cellX + dx, q.cellY + dy))) {
        face(d);
        step(VOX_BTN.a);
        settle();
        if (Permissions.isCutTree(world().map.cellCollision(q.cellX + dx, q.cellY + dy))) fail(`the tree at (${q.cellX + dx},${q.cellY + dy}) would not CUT`);
      }
      const r = press(d);
      if (r === "moved") continue;
      if (r === "blocked") blocked.add(`${q.cellX},${q.cellY},${d}`);
      if (r === "map") {
        if (leaving) return;
        fail(`walking to ${what}: a warp took the player to ${world().map.id}`);
      }
      break;
    }
  }
  fail(`could not reach ${what} on ${map}`);
}

export const walkTo = (x: number, y: number): void => walk((a, b) => a === x && b === y, `(${x},${y})`);

/** Face `dir` without stepping (a refused press turns the player). */
function face(dir: Dir): void {
  for (let f = 0; f < 20 && world().player.facing !== dir; f++) step(BTN[dir]);
  for (let f = 0; f < 6; f++) step(0);
}

/** Stand next to (x, y), face it, press A, and let it all play out. */
export function use(x: number, y: number, what: string): void {
  walk((a, b) => Math.abs(a - x) + Math.abs(b - y) === 1, what);
  const p = world().player;
  const d: Dir = x > p.cellX ? "right" : x < p.cellX ? "left" : y > p.cellY ? "down" : "up";
  face(d);
  step(VOX_BTN.a);
  settle();
}

/** The person on this map wearing `sprite` (the nth of them), or fail. */
export function npc(sprite: string, nth = 0): any {
  const list = (world().npcs ?? []).filter((n: any) => n?.def?.sprite === sprite && !n.hidden);
  const n = list[nth];
  if (!n) fail(`no ${sprite} on ${world().map.id} (have ${(world().npcs ?? []).map((m: any) => m?.def?.sprite).join(" ")})`);
  return n;
}

export function talk(sprite: string, nth = 0): void {
  const n = npc(sprite, nth);
  use(n.cellX, n.cellY, `${sprite} on ${world().map.id}`);
}

// ---------------------------------------------------------------------------
// travel between maps
// ---------------------------------------------------------------------------

interface Hop {
  to: string;
  kind: "warp" | "edge";
  warp?: any;
  dir?: Dir;
}

function hops(id: string): Hop[] {
  const def = world().maps[id];
  const out: Hop[] = [];
  for (const wp of def?.warps ?? []) if (wp?.destMap && world().maps[wp.destMap]) out.push({ to: wp.destMap, kind: "warp", warp: wp });
  const side: Record<string, Dir> = { north: "up", south: "down", west: "left", east: "right" };
  for (const [k, c] of Object.entries<any>(def?.connections ?? {})) {
    const to = c?.mapId ?? c?.map;
    if (typeof to === "string" && world().maps[to]) out.push({ to, kind: "edge", dir: side[k] });
  }
  return out;
}

const hopKey = (from: string, h: Hop): string =>
  `${from}>${h.to}:${h.kind}:${h.warp ? `${h.warp.x},${h.warp.y}` : h.dir}`;
/** Hops found shut on the way (a wall at an edge, a door that is locked). */
const shut = new Set<string>();

/** The map-to-map route (fewest hops), avoiding maps in `avoid` and hops
 *  found shut. */
function route(from: string, to: string, avoid: Set<string>): Hop[] | null {
  const prev = new Map<string, [string, Hop]>();
  const q = [from];
  const seen = new Set([from]);
  while (q.length) {
    const m = q.shift()!;
    if (m === to) {
      const out: Hop[] = [];
      let k = to;
      while (k !== from) {
        const [pk, h] = prev.get(k)!;
        out.push(h);
        k = pk;
      }
      return out.reverse();
    }
    for (const h of hops(m)) {
      if (seen.has(h.to) || (avoid.has(h.to) && h.to !== to) || shut.has(hopKey(m, h))) continue;
      seen.add(h.to);
      prev.set(h.to, [m, h]);
      q.push(h.to);
    }
  }
  return null;
}

/** Take one hop: walk onto the warp (and through it), or off the edge. */
function take(h: Hop): void {
  const w = world();
  const from = w.map.id;
  if (h.kind === "warp") {
    const { x, y } = h.warp;
    // onto the warp itself (a door warps there; stairs too)...
    try {
      walk((a, b) => a === x && b === y, `the warp to ${h.to}`, true);
    } catch (e) {
      // ...or, where it cannot be stood on (a door in a wall), next to it
      if (!(e instanceof StoryFail) || world().map.id !== from) throw e;
      walk((a, b) => Math.abs(a - x) + Math.abs(b - y) === 1, `the warp to ${h.to}`, true);
    }
    for (let k = 0; k < 6 && world().map.id === from; k++) {
      const p = world().player;
      let d: Dir;
      if (p.cellX === x && p.cellY === y) {
        // on it: a carpet or a door wants a step out the way it faces
        const c = world().map.cellCollision(x, y);
        d = (Permissions.carpetDirection(c) as Dir) ?? (["down", "up", "left", "right"] as Dir[])[k % 4]!;
      } else {
        d = x > p.cellX ? "right" : x < p.cellX ? "left" : y > p.cellY ? "down" : "up";
      }
      const at = `(${p.cellX},${p.cellY})`;
      const r = press(d);
      if (process.env.STORY_DEBUG) log(`    warp (${x},${y}) try ${k}: at ${at} press ${d} -> ${r}, now ${describe()}`);
      settle();
    }
  } else {
    const d = h.dir!;
    const map = w.map;
    const edge = (a: number, b: number): boolean =>
      d === "up" ? b === 0 : d === "down" ? b === map.heightCells - 1 : d === "left" ? a === 0 : a === map.widthCells - 1;
    walk((a, b) => edge(a, b) && Permissions.stepPermitted(coll, a, b, d) && coll(a + DELTA[d][0], b + DELTA[d][1]) !== undefined, `the ${d} edge to ${h.to}`, true);
    for (let k = 0; k < 4 && world().map.id === from; k++) {
      press(d);
      settle();
    }
  }
  if (world().map.id === from) fail(`could not get from ${from} to ${h.to}`);
}

/** Go to map `to` on foot. */
export function travel(to: string, avoid: string[] = []): void {
  const bad = new Set(avoid);
  for (let tries = 0; tries < 30 && world().map.id !== to; tries++) {
    settle();
    const r = route(world().map.id, to, bad);
    if (!r || r.length === 0) fail(`no route from ${world().map.id} to ${to}`);
    const h = r[0]!;
    try {
      take(h);
    } catch (e) {
      if (!(e instanceof StoryFail)) throw e;
      // that way is shut (a wall at the edge, a roadblock): try another
      const from = world().map.id;
      log(`  (${e.message}; trying another way)`);
      shut.add(hopKey(from, h));
      void bad;
    }
  }
  if (world().map.id !== to) fail(`could not travel to ${to}`);
}

// ---------------------------------------------------------------------------
// the save, checked
// ---------------------------------------------------------------------------

export const save = (): any => game.save;
export function flag(name: string): boolean {
  const id = FlagNames.events[name];
  if (id === undefined) fail(`no event flag ${name}`);
  return !!world().events?.get(id);
}
export function engine(name: string): boolean {
  const id = FlagNames.engine[name];
  if (id === undefined) fail(`no engine flag ${name}`);
  return !!world().engineFlag(id);
}
export function hasItem(id: string): boolean {
  return (save()?.inventory?.[id] ?? 0) > 0;
}
/** The badge names the save holds (save.player's badge stores). */
export function badges(): string[] {
  const p = save()?.player ?? {};
  const out: string[] = [];
  for (const store of ["johtoBadges", "kantoBadges", "badges"]) {
    const t = p[store];
    if (t && typeof t === "object") for (const [k, v] of Object.entries(t)) if (v === true) out.push(k);
  }
  return out;
}
export function partySpecies(): string[] {
  return (save()?.party ?? []).map((m: any) => m.species);
}
export function expect(cond: boolean, what: string): void {
  if (!cond) fail(`expected ${what} (${describe()})`);
}

export const log = (s: string): void => console.log(s);

// ---------------------------------------------------------------------------
// the chapters
// ---------------------------------------------------------------------------

export interface Chapter {
  name: string;
  run: () => void;
}
export const chapters: Chapter[] = [];

await import("./gold_story_chapters.ts");

const last = process.argv[2];
const t0 = performance.now();
let done = 0;
for (const c of chapters) {
  const f0 = frames;
  errors.length = 0;
  try {
    c.run();
    settle();
    done++;
    log(`ok   ${c.name}  [${frames - f0} frames${errors.length ? `, ${errors.length} log errors: ${errors[0]}` : ""}]`);
  } catch (e) {
    log(`FAIL ${c.name}: ${e instanceof Error ? e.message : e}`);
    if (!(e instanceof StoryFail) && e instanceof Error) log(e.stack ?? "");
    if (errors.length) log(`     log: ${errors.slice(0, 3).join(" | ")}`);
    break;
  }
  if (last && c.name.startsWith(last)) break;
}
log(`${done}/${chapters.length} chapters, ${frames} frames, ${((performance.now() - t0) / 1000).toFixed(1)} s; at ${describe()}`);
log(`party: ${partySpecies().join(" ")}`);
