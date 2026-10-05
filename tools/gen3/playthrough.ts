// FireRed on the desktop, played: a new game (A/START through the boot and
// the professor's speech), then a walk -- down the stairs, out of the house,
// north toward the first route until the professor stops you, into his lab --
// with a screenshot and a log line on every map change. The end-to-end check
// of the runtime port: each stop is the next integration bug to fix.
//   bun tools/gen3/playthrough.ts [maxFrames=20000]
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setHost } from "../../voxelmon/game/gen3/platform/host.ts";
import { DesktopHost } from "../../voxelmon/game/gen3/platform/desktop.ts";
import { G } from "../../voxelmon/game/gen3/platform/graphics.ts";
import { setSaveStore, memorySaveStore } from "../../voxelmon/game/gen3/platform/savefs.ts";
import { setAudio, silentAudio } from "../../voxelmon/game/gen3/platform/audio.ts";
import { encodePng } from "../../voxelmon/import/gen3/png.ts";

const MAX = Number(process.argv[2] ?? 20000);
const OUT = "/tmp/g3play";
mkdirSync(OUT, { recursive: true });
const BIT: Record<string, number> = { UP: 0, DOWN: 1, LEFT: 2, RIGHT: 3, A: 4, B: 5, START: 6, SELECT: 7 };
const host = new DesktopHost(join(homedir(), "gen3ref/frfull"));
setHost(host);
setSaveStore(memorySaveStore());
const audio = silentAudio();
setAudio(audio);

const { Game3 } = await import("../../voxelmon/game/gen3/core/Game3.ts");
const { Input } = await import("../../voxelmon/game/gen3/shared/core/Input.ts");
const { Runtime } = await import("../../voxelmon/game/gen3/core/runtime.ts");
const { Player } = await import("../../voxelmon/game/gen3/core/player.ts");
const { Collision } = await import("../../voxelmon/game/gen3/core/collision.ts");
const { Objects } = await import("../../voxelmon/game/gen3/core/objects.ts");
const { Field } = await import("../../voxelmon/game/gen3/core/field.ts");
const { Battle: BattleMod } = await import("../../voxelmon/game/gen3/core/battle/init.ts") as any;
const game: any = Game3.new();
game.load({});

let f = 0;
let lastMap = "";
function shot(tag: string): void {
  writeFileSync(`${OUT}/${String(f).padStart(6, "0")}_${tag}.png`, encodePng(240, 160, host.pixels()));
}
function frame(mask: number): void {
  f++;
  (Input as any).hostButtons(mask);
  game.update(1 / 60);
  G.beginFrame();
  game.draw();
  G.endFrame();
  const s = Runtime.getSession?.();
  const map = s?.map ?? "";
  if (map !== lastMap) {
    lastMap = map;
    console.log(`f${f}: map ${map} at (${(Player as any).cellX},${(Player as any).cellY})`);
    // a few frames later, once the fade is in
    pendingShot = f + 40;
  }
  if (f === pendingShot) shot(lastMap || "boot");
  if (f >= MAX) throw new Error(`frame budget ${MAX} spent`);
}
let pendingShot = -1;
const tap = (key: string, hold = 6, after = 20): void => {
  for (let i = 0; i < hold; i++) frame(1 << BIT[key]!);
  for (let i = 0; i < after; i++) frame(0);
};
const inField = (): boolean => !!Runtime.getSession?.()?.map && game.phase === "field";

// 1. the new game: START at the title, then A (START now and then: the naming screens' OK)
for (let i = 0; i < 430; i++) frame(0);
tap("START");
let n = 0;
while (!inField() && f < MAX) { tap(n++ % 7 === 6 ? "START" : "A", 6, 39); }
for (let i = 0; i < 120; i++) frame(0);
shot("field");
console.log(`f${f}: in the field, ${lastMap} (${(Player as any).cellX},${(Player as any).cellY})`);

// 2. walk to a cell: greedy, the other axis when blocked; A clears any text on the way
function walkTo(tx: number, ty: number, untilMapChange = true, limit = 1500): boolean {
  const start = lastMap;
  const t0 = f;
  let stuck = 0, lastX = -1, lastY = -1, axisX = true;
  while (f - t0 < limit) {
    if (untilMapChange && lastMap !== start) return true;
    const P: any = Player;
    const x = P.cellX, y = P.cellY;
    if (!untilMapChange && x === tx && y === ty) return true;
    if (x === lastX && y === lastY) stuck++; else { stuck = 0; lastX = x; lastY = y; }
    if (stuck > 90) { axisX = !axisX; stuck = 0; tap("A", 4, 10); }
    const dx = tx - x, dy = ty - y;
    let key: string;
    // on the warp cell itself: press into the exit (door mats: down)
    if (dx === 0 && dy === 0) key = "DOWN";
    else if ((axisX && dx !== 0) || dy === 0) key = dx > 0 ? "RIGHT" : dx < 0 ? "LEFT" : dy > 0 ? "DOWN" : "UP";
    else key = dy > 0 ? "DOWN" : "UP";
    // mid-step: no key, or the step's last frame reads it as the next move
    frame(P.moving ? 0 : 1 << BIT[key]!);
  }
  return false;
}
// BFS over the live collision (people included, ledges hop down), one step
// at a time, recomputed every step. A target past the map edge walks to the
// edge and on through the connection.
const DIRS: [string, number, number][] = [["up", 0, -1], ["down", 0, 1], ["left", -1, 0], ["right", 1, 0]];
function firstStep(tx: number, ty: number): string | undefined {
  const C: any = Collision, P: any = Player;
  const W = C._widthCells, H = C._heightCells;
  const sx = P.cellX, sy = P.cellY;
  const goal = (x: number, y: number): boolean =>
    ty < 0 ? y === 0 : ty >= H ? y === H - 1 : tx < 0 ? x === 0 : tx >= W ? x === W - 1
      : x === tx && y === ty;
  const seen = new Map<number, string>();
  const q: [number, number][] = [[sx, sy]];
  seen.set(sy * W + sx, "");
  while (q.length) {
    const [x, y] = q.shift()!;
    if (goal(x, y)) {
      // walk back to the first move
      let k = y * W + x, dir = "";
      while (k !== sy * W + sx) { const v = seen.get(k)!; const [d, from] = v.split("@"); dir = d!; k = Number(from); }
      return dir || undefined;
    }
    for (const [d, dx, dy] of DIRS) {
      let nx = x + dx, ny = y + dy;
      const [lx, ly] = C.ledgeLanding(game, x, y, d);
      if (lx != null) { nx = lx; ny = ly; }
      else {
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const [ok] = C.canEnter(game, nx, ny, { fromX: x, fromY: y, dir: d, elevation: P.currentElevation });
        if (!ok) continue;
      }
      const k = ny * W + nx;
      if (seen.has(k)) continue;
      seen.set(k, `${d}@${y * W + x}`);
      q.push([nx, ny]);
    }
  }
  return undefined;
}
const KEY: Record<string, string> = { up: "UP", down: "DOWN", left: "LEFT", right: "RIGHT" };
function pathTo(tx: number, ty: number, untilMapChange = true, limit = 3000, onArrive = "DOWN"): boolean {
  const start = lastMap, t0 = f;
  while (f - t0 < limit) {
    if (untilMapChange && lastMap !== start) return true;
    if (inBattle()) return false;
    const P: any = Player;
    if (P.moving || Runtime.uiBusy?.() || (Field as any).locked) { frame(Runtime.uiBusy?.() ? 1 << BIT.A! : 0); continue; }
    const C: any = Collision;
    const W = C._widthCells, H = C._heightCells;
    const atEdge = ty < 0 ? P.cellY === 0 : ty >= H ? P.cellY === H - 1 : tx < 0 ? P.cellX === 0 : tx >= W ? P.cellX === W - 1 : false;
    let key: string;
    if (atEdge || (P.cellX === tx && P.cellY === ty)) {
      const cx = tx, cy = ty;
      if (!untilMapChange && cx === tx && cy === ty) return true;
      key = tx < 0 ? "LEFT" : tx >= C._widthCells ? "RIGHT" : ty < 0 ? "UP" : ty >= C._heightCells ? "DOWN" : onArrive;
    } else {
      const d = firstStep(tx, ty);
      if (!d) { console.log(`f${f}: no path from (${P.cellX},${P.cellY}) to (${tx},${ty}) on ${lastMap}`); return false; }
      key = KEY[d]!;
    }
    frame(1 << BIT[key]!);
  }
  return false;
}
function warpTo(toMap: string): boolean {
  const def = game.data?.maps?.[lastMap];
  const warps: any[] = [];
  for (const k in def?.warps ?? {}) warps.push(def.warps[k]);
  // live warps only (maps carry inactive dummy warps, as in pret)
  const live = warps.filter((w) => w && (Collision as any).warpAt(w.x, w.y));
  const w = live.find((w) => w.destMap === toMap) ?? live[0];
  if (!w) { console.log(`f${f}: no warp out of ${lastMap}`); return false; }
  console.log(`f${f}: walking to the warp at (${w.x},${w.y}) -> ${w.destMap ?? w.map ?? w.dest}`);
  if ((Collision as any).isDoorWarp(game, w.x, w.y) && !(Collision as any).isExitWarp(game, w.x, w.y)) return pathTo(w.x, w.y + 1, true, 3000, "UP");
  return pathTo(w.x, w.y, true);
}
function probeHold(key: string, frames: number): void {
  const P0: any = Player;
  const orig = P0.tryMove;
  P0.tryMove = function (...a: any[]) { const r = orig.apply(this, a); console.log(`  tryMove(${a[0]}) at (${P0.cellX},${P0.cellY}) -> ${JSON.stringify(r)}`); return r; };
  for (let i = 0; i < frames; i++) {
    frame(1 << BIT[key]!);
    if (i % 8 === 0) {
      const P: any = Player;
      console.log(`  probe f${f}: cell (${P.cellX},${P.cellY}) px (${P.px},${P.py}) facing ${P.facing} moving ${P.moving} state ${P.state} locked ${Runtime._fieldLocked} uiBusy ${Runtime.uiBusy?.()}`);
    }
  }
}
{
  const P0: any = Player;
  const orig = P0.tryMove;
  let last = "";
  P0.tryMove = function (...a: any[]) { const r = orig.apply(this, a); const s = `tryMove(${a[0]}) at (${P0.cellX},${P0.cellY}) -> ${JSON.stringify(r)}`; if (s !== last && process.env.TM) console.log(`  f${f} ${s}`); last = s; return r; };
}
const inBattle = (): boolean => game.speedCategory?.() === "battle";
// A through text until the field is free for a while (or a battle starts)
function talkThrough(limit = 3000): boolean {
  const t0 = f;
  let free = 0;
  while (f - t0 < limit) {
    if (inBattle()) return true;
    if (Runtime.uiBusy?.() || (Field as any).locked || (Field as any).running) { free = 0; tap("A", 4, 16); }
    else { free++; frame(0); if (free > 90) return true; }
  }
  return false;
}
function objectsNear(x0: number, y0: number, x1: number, y1: number): string[] {
  const out: string[] = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const o: any = (Objects as any).at(x, y);
    if (o) out.push(`(${x},${y}) id ${o.localId} gfx ${o.def?.graphicsId ?? o.def?.gfx}`);
  }
  return out;
}
const steps: [string, () => boolean][] = [
  ["down the stairs", () => warpTo("FR_PLAYERS_HOUSE_1F")],
  ["out of the house", () => { return warpTo("FR_PALLET_TOWN"); }],
  ["north to the route (the professor stops you)", () => {
    walkTo(12, 1, true, 900);
    const t0 = f;
    while (lastMap !== "FR_OAKS_LAB" && f - t0 < 4000) tap("A", 4, 20);
    return lastMap === "FR_OAKS_LAB";
  }],
  ["the lab speech", () => talkThrough()],
  ["a starter from the table", () => {
    shot("lab_before_starter");
    console.log(`  objects: ${objectsNear(6, 2, 11, 6).join("; ")}`);
    // the middle ball: stand below it, face up, A, then yes / no nickname
    walkTo(9, 5, false, 600);
    tap("UP", 4, 10);
    tap("A", 4, 30);
    for (let i = 0; i < 30 && !inBattle(); i++) tap(i % 5 === 4 ? "B" : "A", 4, 30);
    return talkThrough();
  }],
  ["out of the lab (the rival battle)", () => {
    const t0 = f;
    walkTo(6, 12, true, 1200);
    while (!inBattle() && f - t0 < 2500) tap("A", 4, 20);
    return inBattle();
  }],
  ["the rival battle, fought (A: fight, first move)", () => {
    const t0 = f;
    let k = 0;
    let lastHp = "";
    while (inBattle() && f - t0 < 12000) {
      tap("A", 4, 26);
      const st: any = (game as any).__battleState?.() ?? BattleMod.getState?.();
      const bs = st?.battlers;
      if (bs) {
        const hp = [1, 2, 3, 4].map((i) => bs[i] ? `${bs[i].side}:${bs[i].mon?.hp ?? bs[i].hp}/${bs[i].mon?.maxHp ?? bs[i].maxHp}` : "").join(" ");
        if (hp !== lastHp) { console.log(`  f${f} battlers ${hp}`); lastHp = hp; }
      } if (++k % 6 === 0) shot(`battle_${String(k).padStart(3, "0")}`); }
    for (let i = 0; i < 60; i++) frame(0);
    return !inBattle() && talkThrough(2000);
  }],
  ["out of the lab", () => warpTo("FR_PALLET_TOWN")],
  ["north to route 1", () => pathTo(0, -1, true, 3000)],
  ["a wild battle in the grass (then RUN)", () => {
    // pace in the nearest tall grass until something jumps out
    const C: any = Collision;
    let gx = -1, gy = -1;
    for (let y = C._heightCells - 1; y >= 0 && gx < 0; y--) for (let x = 0; x < C._widthCells; x++) {
      if (C.behavior(x, y) === 0x02 && C.behavior(x + 1, y) === 0x02 && firstStep(x, y)) { gx = x; gy = y; break; }
    }
    if (gx < 0) { console.log("  no grass found"); return false; }
    pathTo(gx, gy, false, 2000);
    const t0 = f;
    let k = 0;
    while (!inBattle() && f - t0 < 6000) { pathTo(gx + (k++ % 2), gy, false, 200); }
    if (!inBattle()) return false;
    console.log(`f${f}: wild battle`);
    // the intro text, then the menu: RUN is bottom right
    for (let i = 0; i < 12; i++) tap("B", 4, 30);
    shot("wild_battle_menu");
    tap("DOWN", 4, 10); tap("RIGHT", 4, 10); tap("A", 4, 60);
    const t1 = f;
    while (inBattle() && f - t1 < 2000) tap("A", 4, 26);
    return !inBattle();
  }],
  ["north to the next town", () => pathTo(0, -1, true, 6000)],
  ["into the shop (the parcel)", () => warpTo("FR_VIRIDIAN_CITY_MART") && talkThrough(3000)],
  ["out of the shop", () => warpTo("FR_VIRIDIAN_CITY")],
  ["into the healing centre", () => warpTo("FR_VIRIDIAN_CITY_POKEMON_CENTER_1F")],
  ["healed at the counter", () => {
    console.log(`  objects: ${objectsNear(0, 0, 14, 8).join("; ")}`);
    return true;
  }],
];
for (const [name, run] of steps) {
  const ok = run();
  console.log(`f${f}: ${name}: ${ok ? "ok" : "did not arrive"} (now ${lastMap} (${(Player as any).cellX},${(Player as any).cellY}))`);
  shot(name.replace(/\W+/g, "_"));
}
console.log(`done at frame ${f}; audio: ${audio.log.slice(-8).join(" | ")}`);
