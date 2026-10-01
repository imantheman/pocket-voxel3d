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
import { Map as MapClass } from "../voxelmon/game/gen2/world/Map.ts";

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
  const extra = top?.screenId === "Gen2BattleState"
    ? ` phase=${top.phase} menu=${top.menuIndex} sub=${top.subScreen?.screenId ?? top.sub?.screenId ?? ""} msg=${JSON.stringify(top.message ?? top.text ?? "").slice(0, 60)} ` +
      `player=${top.battle?.player?.mon?.species ?? top.battle?.player?.species}:${top.battle?.player?.mon?.hp ?? top.battle?.player?.hp} ` +
      `enemy=${top.battle?.enemy?.mon?.species ?? top.battle?.enemy?.species}:${top.battle?.enemy?.mon?.hp ?? top.battle?.enemy?.hp}`
    : "";
  return `${w?.map?.id} (${p?.cellX},${p?.cellY}) ${top ? "screen " + (top.screenId ?? "?") + extra : w?.busy() ? "busy" : "free"}` +
    `${w?.textbox ? " text" : ""}`;
}

// ---------------------------------------------------------------------------
// walking
// ---------------------------------------------------------------------------

const surfing = (): boolean => FieldMoves.isSurfing(world().playerState);
/** Field moves the run may use on the way (a chapter turns them on once the
 *  story has handed over the HM and the badge). */
export const can = { cut: false, surf: false, whirlpool: false, strength: false, waterfall: false, rocksmash: false };
/** A boulder the run can push with STRENGTH from (x, y) one step `dir`:
 *  the cell beyond it free ground. */
function boulderPushable(x: number, y: number, dir: Dir): boolean {
  const w = world();
  const n = w.npcAt(x, y);
  if (!n || !can.strength || n.def?.sprite !== "SPRITE_BOULDER") return false;
  const [dx, dy] = DELTA[dir];
  const bx = x + dx;
  const by = y + dy;
  return w.map.inBounds(bx, by) && w.map.isWalkable(bx, by) && !w.npcAt(bx, by);
}
const boulderAt = (x: number, y: number): boolean => world().npcAt(x, y)?.def?.sprite === "SPRITE_BOULDER";

/** A rock the run can ROCK SMASH, standing at (x, y) here? */
function rockAt(x: number, y: number): boolean {
  const n = world().npcAt(x, y);
  return !!n && can.rocksmash && n.def?.sprite === "SPRITE_ROCK";
}
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
  const warps = new Set<string>((w.maps[w.map.id]?.warps ?? [])
    .filter((wp: any) => Permissions.isWarpCollision(w.map.cellCollision(wp.x, wp.y)))
    .map((wp: any) => `${wp.x},${wp.y}`));
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
  // staying on this map: the cross-map planner (boulders, rocks, surf, and
  // parts of the map only reached through another one)
  if (!leaving) {
    go((m, x, y) => m === map && ok(x, y), what);
    return;
  }
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
  for (let k = 0; k < 4; k++) {
    settle();
    for (let f = 0; f < 20 && world().player.facing !== dir && !busy(); f++) step(BTN[dir]);
    for (let f = 0; f < 6 && !busy(); f++) step(0);
    if (!busy() && world().player.facing === dir) return;
  }
}

/** A at what is ahead (`dir`), YES to what it asks, until `done` -- a few
 *  tries, since a wild POKeMON can step in between. */
function aAt(dir: Dir, done: () => boolean, what: string): void {
  for (let k = 0; k < 3 && !done(); k++) {
    face(dir);
    step(VOX_BTN.a);
    settle();
  }
  if (!done()) fail(`${what} (${describe()})`);
}

/** Stand next to (x, y), face it, press A, and let it all play out. */
export function use(x: number, y: number, what: string): void {
  // next to it, or two away straight across a counter (a nurse, a clerk)
  const across = (a: number, b: number): boolean => {
    const dx = x - a;
    const dy = y - b;
    if (!((Math.abs(dx) === 2 && dy === 0) || (Math.abs(dy) === 2 && dx === 0))) return false;
    return Permissions.isCounter(world().map.cellCollision(a + dx / 2, b + dy / 2));
  };
  walk((a, b) => Math.abs(a - x) + Math.abs(b - y) === 1 || across(a, b), what);
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

/** The hop that last took the player onto a new map (reach() needs it). */
let lastHop: { from: string; key: string } | null = null;

/** Take one hop: walk onto the warp (and through it), or off the edge. */
function take(h: Hop): void {
  const w = world();
  const from = w.map.id;
  lastHop = { from, key: hopKey(from, h) };
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

// ---------------------------------------------------------------------------
// the cross-map search
// ---------------------------------------------------------------------------

/** The Map a plan reads: the live one for where the player is (blocks a
 *  script changed, a tree just cut), a fresh one for anywhere else. */
function mapOf(id: string): any {
  return id === world().map.id ? world().map : world().connectionMap(id);
}

/** Steps found refused while walking (a person in the way, a quirk). */
const refused = new Set<string>();
/** Transitions found not to work (a scripted guard, a locked door). */
const deadEnds = new Map<string, number>();

interface Act {
  dir: Dir;
  /** this step starts surfing (A at the water, YES) */
  surf?: boolean;
  /** this step pushes a boulder (STRENGTH) */
  push?: boolean;
  /** this step leaves the map (onto a warp, off an edge) */
  leaves?: string;
}

/** One step `dir` from (x, y) on map `m`, planned: a cell on the same map,
 *  or [map, x, y] across a warp or a connection, or null. */
function planStep(m: string, x: number, y: number, dir: Dir, goal: (m: string, x: number, y: number) => boolean, surf: boolean):
  { m: string; x: number; y: number; leaves?: string; surf: boolean; startSurf?: boolean; push?: boolean } | null {
  if (refused.has(`${m},${x},${y},${dir}`)) return null;
  const w = world();
  const map = mapOf(m);
  const def = w.maps[m];
  if (!map || !def) return null;
  const live = m === w.map.id;
  const collOf = (a: number, b: number): any => w.cellCollisionAcross(map, a, b);
  if (!Permissions.stepPermitted(collOf, x, y, dir)) return null;
  const [dx, dy] = DELTA[dir];
  const tx = x + dx;
  const ty = y + dy;
  if (!map.inBounds(tx, ty)) {
    // off the edge onto the connected map
    const side = dir === "up" ? "north" : dir === "down" ? "south" : dir === "left" ? "west" : "east";
    const conn = map.connection(side);
    const to = conn?.mapId ?? conn?.map;
    const dest = typeof to === "string" ? w.maps[to] : undefined;
    if (!dest) return null;
    const land = MapClass.connectionLanding(dest, conn, dir, x, y);
    if (!land) return null;
    const dmap = mapOf(to);
    const lc = dmap?.cellCollision(land[0], land[1]);
    const landWater = Permissions.surfable(lc) === "water";
    if (!(surf ? Permissions.surfable(lc) !== undefined : dmap?.isWalkable(land[0], land[1]))) return null;
    const key = `${m}>${to}:edge:${dir}`;
    if ((deadEnds.get(key) ?? 0) >= 2) return null;
    return { m: to, x: land[0], y: land[1], leaves: key, surf: surf && landWater };
  }
  const c = map.cellCollision(tx, ty);
  const water = Permissions.surfable(c) === "water";
  let ok = (surf ? Permissions.surfable(c) !== undefined : map.isWalkable(tx, ty))
    || (can.cut && Permissions.isCutTree(c));
  // from the shore onto the water: SURF
  let startSurf = false;
  if (!ok && !surf && can.surf && water) {
    ok = true;
    startSurf = true;
  }
  if (live && ok) {
    const npc = w.npcAt(tx, ty);
    if (npc && !goal(m, tx, ty) && !rockAt(tx, ty)) ok = false;
  }
  if (!ok) {
    // .TryJump: a ledge under the feet that faces this way
    const f = surf ? undefined : Permissions.ledgeFacings(map.cellCollision(x, y));
    const lx = x + 2 * dx;
    const ly = y + 2 * dy;
    if (f && f[dir] && map.inBounds(lx, ly) && map.isWalkable(lx, ly) && !(live && w.npcAt(lx, ly))) return { m, x: lx, y: ly, surf: false };
    return null;
  }
  // onto a warp: across to where it leads -- only where the tile is a warp
  // (a door, stairs, a pit, a mat); a warp entry on plain floor is just
  // where some other map's hole lands
  const wi = Permissions.isWarpCollision(c) ? (def.warps ?? []).findIndex((wp: any) => wp.x === tx && wp.y === ty) : -1;
  if (wi >= 0) {
    const wp = def.warps[wi];
    const dest = w.maps[wp.destMap];
    const arrive = dest?.warps?.[(wp.destWarp ?? 1) - 1];
    if (!dest || !arrive) return null;
    const key = `${m}>${wp.destMap}:warp:${tx},${ty}`;
    if ((deadEnds.get(key) ?? 0) >= 2) return null;
    // a door, a staircase or a cave mouth walks the arriving player a step
    // out (Permissions.doorForcedDirection): that is where they end up
    let ax = arrive.x;
    let ay = arrive.y;
    const dm = mapOf(wp.destMap);
    const forced = dm ? (Permissions.doorForcedDirection(dm.cellCollision(ax, ay)) as Dir | undefined) : undefined;
    if (forced && dm.isWalkable(ax + DELTA[forced][0], ay + DELTA[forced][1])) {
      ax += DELTA[forced][0];
      ay += DELTA[forced][1];
    }
    return { m: wp.destMap, x: ax, y: ay, leaves: key, surf: false };
  }
  // ice: the player slides on until the next cell refuses them
  if (!surf && Permissions.isIce(c)) {
    let sx = tx;
    let sy = ty;
    for (let k = 0; k < 64 && Permissions.isIce(map.cellCollision(sx, sy)); k++) {
      const nx = sx + dx;
      const ny = sy + dy;
      if (!Permissions.stepPermitted(collOf, sx, sy, dir)) break;
      if (!map.inBounds(nx, ny) || !map.isWalkable(nx, ny) || (live && w.npcAt(nx, ny))) break;
      sx = nx;
      sy = ny;
    }
    return { m, x: sx, y: sy, surf: false };
  }
  return { m, x: tx, y: ty, surf: (surf || startSurf) && water, startSurf };
}

/** The steps from where the player stands to a cell `goal` accepts,
 *  across maps; null when there is no way. */
function planTo(goal: (m: string, x: number, y: number) => boolean): Act[] | null {
  const w = world();
  const p = w.player;
  const s0 = surfing();
  const start = `${w.map.id},${p.cellX},${p.cellY},${s0 ? 1 : 0}`;
  const prev = new Map<string, [string, Act]>();
  const q: [string, number, number, boolean][] = [[w.map.id, p.cellX, p.cellY, s0]];
  const seen = new Set([start]);
  let found: string | null = null;
  for (let qi = 0; qi < q.length && qi < 600000; qi++) {
    const [m, x, y, sf] = q[qi]!;
    if (goal(m, x, y)) {
      found = `${m},${x},${y},${sf ? 1 : 0}`;
      break;
    }
    for (const d of DIRS) {
      const t = planStep(m, x, y, d, goal, sf);
      if (!t) continue;
      const k = `${t.m},${t.x},${t.y},${t.surf ? 1 : 0}`;
      if (seen.has(k)) continue;
      seen.add(k);
      prev.set(k, [`${m},${x},${y},${sf ? 1 : 0}`, { dir: d, leaves: t.leaves, surf: t.startSurf, push: t.push }]);
      q.push([t.m, t.x, t.y, t.surf]);
    }
  }
  if (!found) return null;
  const out: Act[] = [];
  let k = found;
  while (k !== start) {
    const [pk, a] = prev.get(k)!;
    out.push(a);
    k = pk;
  }
  return out.reverse();
}

/**
 * STRENGTH puzzles: a search over (player, boulders) on this map -- walking
 * by the movement rules, pushing a boulder one cell when the cell beyond is
 * free ground (the player stays put, as in Gen 2) -- to a cell `goal`
 * accepts. The first step of it, or null.
 */
function solveBoulders(goal: (x: number, y: number) => boolean): Act | null {
  if (!can.strength) return null;
  const w = world();
  const map = w.map;
  const p = w.player;
  const boulders: number[] = [];
  const blockers = new Set<string>();
  for (const n of w.npcs ?? []) {
    if (n.hidden) continue;
    if (n.def?.sprite === "SPRITE_BOULDER") boulders.push(n.cellX * 1000 + n.cellY);
    else blockers.add(`${n.cellX},${n.cellY}`);
  }
  if (boulders.length === 0 || boulders.length > 8) return null;
  const collOf = (a: number, b: number): any => w.cellCollisionAcross(map, a, b);
  const freeCell = (x: number, y: number, bs: Set<number>): boolean =>
    map.inBounds(x, y) && map.isWalkable(x, y) && !blockers.has(`${x},${y}`) && !bs.has(x * 1000 + y);
  const key = (x: number, y: number, bs: number[]): string => `${x},${y}|${bs.join(",")}`;
  const b0 = [...boulders].sort((a, b) => a - b);
  const start = key(p.cellX, p.cellY, b0);
  const prev = new Map<string, [string, Act]>();
  const q: [number, number, number[]][] = [[p.cellX, p.cellY, b0]];
  const seen = new Set([start]);
  for (let qi = 0; qi < q.length && qi < 300000; qi++) {
    const [x, y, bs] = q[qi]!;
    if (goal(x, y)) {
      let k = key(x, y, bs);
      let first: Act | null = null;
      while (k !== start) {
        const [pk, a] = prev.get(k)!;
        first = a;
        k = pk;
      }
      return first;
    }
    const bset = new Set(bs);
    for (const d of DIRS) {
      if (!Permissions.stepPermitted(collOf, x, y, d)) continue;
      const [dx, dy] = DELTA[d];
      const nx = x + dx;
      const ny = y + dy;
      let nb = bs;
      let px = nx;
      let py = ny;
      let push = false;
      if (bset.has(nx * 1000 + ny)) {
        if (!freeCell(nx + dx, ny + dy, bset)) continue;
        nb = bs.map((b) => (b === nx * 1000 + ny ? (nx + dx) * 1000 + ny + dy : b)).sort((a, b) => a - b);
        px = x;
        py = y;
        push = true;
      } else if (!freeCell(nx, ny, bset)) continue;
      const k = key(px, py, nb);
      if (seen.has(k)) continue;
      seen.add(k);
      prev.set(k, [key(x, y, bs), { dir: d, push }]);
      q.push([px, py, nb]);
    }
  }
  return null;
}

/** Walk (across maps) until standing where `goal` accepts. */
export function go(goal: (m: string, x: number, y: number) => boolean, what: string): void {
  for (let tries = 0; tries < 300; tries++) {
    settle();
    const w = world();
    const p = w.player;
    if (goal(w.map.id, p.cellX, p.cellY)) return;
    let acts = planTo(goal);
    // no plain way: a STRENGTH puzzle on this map?
    if ((!acts || acts.length === 0) && can.strength) {
      const first = solveBoulders((x, y) => goal(w.map.id, x, y));
      if (first) acts = [first];
    }
    if (!acts || acts.length === 0) {
      const near = (w.npcs ?? []).filter((n: any) => !n.hidden && Math.abs(n.cellX - p.cellX) + Math.abs(n.cellY - p.cellY) <= 6)
        .map((n: any) => `${String(n.def?.sprite).replace("SPRITE_", "")}@${n.cellX},${n.cellY}`).join(" ");
      fail(`no way to ${what} from ${describe()}; near: ${near}`);
    }
    // walk this map's part of it
    const here = w.map.id;
    if (process.env.STORY_DEBUG) log(`    go ${what}: at ${describe()} plan ${acts!.slice(0, 12).map((a) => a.dir[0] + (a.leaves ? `[${a.leaves}]` : "")).join("")}${acts.length > 12 ? "..." : ""} (${acts.length})`);
    for (const a of acts) {
      const q = world().player;
      const [dx, dy] = DELTA[a.dir];
      if (can.cut && Permissions.isCutTree(world().map.cellCollision(q.cellX + dx, q.cellY + dy))) {
        aAt(a.dir, () => !Permissions.isCutTree(world().map.cellCollision(q.cellX + dx, q.cellY + dy)), `the tree at (${q.cellX + dx},${q.cellY + dy}) would not CUT`);
      }
      // the water ahead: SURF (A facing it, YES) -- the player hops on
      if (a.surf && !surfing()) {
        aAt(a.dir, surfing, `would not SURF at (${q.cellX + dx},${q.cellY + dy})`);
        break;
      }
      // a boulder: STRENGTH (A facing it, YES), push, and plan again
      if (a.push && boulderAt(q.cellX + dx, q.cellY + dy)) {
        face(a.dir);
        if (!busy()) step(VOX_BTN.a);
        settle();
        press(a.dir);
        settle();
        break;
      }
      // a rock in the way: ROCK SMASH it (A facing it, YES)
      if (rockAt(q.cellX + dx, q.cellY + dy)) {
        aAt(a.dir, () => !rockAt(q.cellX + dx, q.cellY + dy), `the rock at (${q.cellX + dx},${q.cellY + dy}) would not ROCK SMASH`);
      }
      const r = press(a.dir);
      if (process.env.STORY_DEBUG && r !== "moved") {
        const top = screen();
        const vm = world().vm;
        log(`      press ${a.dir} from (${q.cellX},${q.cellY}) -> ${r}: ${describe()} top=${top?.constructor?.name} vm=${vm?.running?.()} script=${vm?.currentKey ?? vm?.key ?? vm?.scriptKey ?? ""} tb=${JSON.stringify(Object.keys(world().textbox ?? {})).slice(0, 80)}`);
        if (top) log(`        top: ${Object.keys(top).join(",").slice(0, 200)} | ${JSON.stringify(top.text ?? top.pages ?? top.lines ?? top.message ?? "").slice(0, 160)}`);
      }
      if (r === "map") break;
      if (r === "blocked") {
        refused.add(`${here},${q.cellX},${q.cellY},${a.dir}`);
        break;
      }
      if (r === "interrupted") break;
      if (a.leaves) {
        // on the warp and still here: a mat or a door wants a step its way
        settle();
        if (world().map.id === here) {
          const now = world().player;
          const c = world().map.cellCollision(now.cellX, now.cellY);
          const want = Permissions.carpetDirection(c) as Dir | undefined;
          const tryDirs: Dir[] = want ? [want] : [a.dir, "down", "up", "left", "right"];
          for (const d of tryDirs) {
            if (world().map.id !== here) break;
            press(d);
            settle();
            const n = world().player;
            if (world().map.id === here && (n.cellX !== now.cellX || n.cellY !== now.cellY)) break;
          }
          if (world().map.id === here) {
            deadEnds.set(a.leaves, (deadEnds.get(a.leaves) ?? 0) + 1);
            log(`     (${a.leaves} did not take the player across)`);
          }
        }
        break;
      }
    }
  }
  fail(`could not get to ${what}`);
}

/** Go to map `to` on foot. */
export function travel(to: string, _avoid: string[] = []): void {
  go((m) => m === to, to);
}

/** Stand on (x, y) of map `to` -- or stop as soon as `done` holds (a coord
 *  event's scene that walks the player off it again). */
export function reach(to: string, x: number, y: number, done?: () => boolean): void {
  go((m, a, b) => (done ? done() : false) || (m === to && a === x && b === y), `(${x},${y}) on ${to}`);
}

/** The POKeMON CENTER fewest hops away. */
function nearestCenter(): string | null {
  const from = world().map.id;
  const q = [from];
  const seen = new Set([from]);
  while (q.length) {
    const m = q.shift()!;
    if (/_POKECENTER_1F$/.test(m)) return m;
    for (const h of hops(m)) {
      if (seen.has(h.to) || shut.has(hopKey(m, h))) continue;
      seen.add(h.to);
      q.push(h.to);
    }
  }
  return null;
}

/** When the lead is worn down (HP or PP under half), heal it the way a
 *  player does: the nearest POKeMON CENTER, the nurse, YES. */
export function healIfLow(): void {
  const lead = game.save?.party?.[0];
  if (!lead) return;
  const maxHp = lead.stats?.hp ?? lead.maxHp ?? lead.hp;
  const pp = (lead.moves ?? []).reduce((a: number, m: any) => a + (m.pp ?? 0), 0);
  const ppMax = (lead.moves ?? []).reduce((a: number, m: any) => a + (game.data.moves?.[m.id]?.pp ?? 10), 0);
  if (lead.hp * 2 >= maxHp && pp * 2 >= ppMax) return;
  const center = nearestCenter();
  if (!center) return;
  const back = world().map.id;
  log(`     (healing at ${center}: hp ${lead.hp}/${maxHp}, pp ${pp}/${ppMax})`);
  travel(center);
  talk("SPRITE_NURSE");
  const after = (game.save.party[0].moves ?? []).reduce((a: number, m: any) => a + (m.pp ?? 0), 0);
  expect(after > pp || game.save.party[0].hp > lead.hp, "the nurse to heal the party");
  void back;
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
    healIfLow();
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
