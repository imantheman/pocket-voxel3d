// Port tooling: FireRed's live textures over a long session, as the 3DS host
// would hold them. Under Bun on the desktop host, a new game placed on the
// town plays many wild and trainer battles (different species and moves)
// and many map changes (walks through doors and connections, teleports to
// the big cities), opening the menus now and then; after each step the
// textures still alive are counted as the 3DS allocates them (power-of-two
// RGBA8 in linear memory; canvases in VRAM), with the call sites that made
// the ones added since the last step. Never shipped.
//   bun tools/gen3/tex_leak.ts [--2d] [--draw] [--battles N] [--hash out.txt] [--sites] [--root DIR]
// (--2d: the field in VIEW 2D, not the 3D world; --draw: rasterise every
// frame, which --hash implies: one hash per frame, to compare two trees.)
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { DesktopHost } from "../../voxelmon/game/gen3/platform/desktop.ts";

const argv = process.argv.slice(2);
const opt = (k: string): string | undefined => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const root = opt("--root") ?? join(homedir(), "gen3ref/frfull");
const W3D = !argv.includes("--2d");
const HASH = opt("--hash");
/** --shots N: the screen every N frames to ~/leakruns/shot_<f>.ppm (implies --draw) */
const SHOTS = Number(opt("--shots") ?? 0);
const DRAW = argv.includes("--draw") || !!HASH || SHOTS > 0;
const SITES = argv.includes("--sites");
const NBATTLES = Number(opt("--battles") ?? 8);

// ---- the 3DS host's allocation of a texture (g3_render.c tex_alloc / tex_alloc_folded)
const po2 = (n: number): number => { let p = 8; while (p < n) p <<= 1; return p; };
/** g3_render.c pick_fmt's bytes per texel: 1 (LA4), 2 (LA8) or 4 (RGBA8); --rgba8: always 4 (the host before it). */
const ALL_RGBA8 = argv.includes("--rgba8");
function texelBytes(px: Uint8Array | undefined, n: number): number {
  if (ALL_RGBA8 || !px) return 4;
  let la4 = true;
  for (let o = 0; o < n * 4; o += 4) {
    if (px[o] !== px[o + 1] || px[o + 1] !== px[o + 2]) return 4;
    if (la4 && (px[o]! % 17 || px[o + 3]! % 17)) la4 = false;
  }
  return la4 ? 1 : 2;
}
function linBytes(w: number, h: number, repeat: boolean, px?: Uint8Array): number {
  const bpp = texelBytes(px, w * h);
  if (h > 1024 && !repeat && w <= 512) { const pw = w * 2, ph = Math.max(h - 512, 512); return po2(pw) * po2(ph) * bpp; }
  return po2(w) * po2(h) * bpp;
}
interface Live { bytes: number; vram: boolean; site: string; w: number; h: number; born: number }
const live = new Map<number, Live>();
let step = 0;
function site(): string {
  if (!SITES) return "";
  const st = (new Error().stack ?? "").split("\n").slice(2);
  const keep: string[] = [];
  for (const l of st) {
    const m = l.match(/at (?:(\S+) )?\(?(?:.*\/)?([^/]+\.ts):(\d+)/);
    if (!m) continue;
    if (/^(image|graphics|desktop|tex_leak|host)\.ts$/.test(m[2]!)) continue;
    keep.push(`${m[1] ?? "?"}@${m[2]}:${m[3]}`);
    if (keep.length >= 3) break;
  }
  return keep.join(" < ");
}
const host = new DesktopHost(root);
{
  const h = host as any;
  const up = h.texUpload.bind(host), fc = h.texFromCache.bind(host), cv = h.canvasNew.bind(host), fr = h.texFree.bind(host);
  h.texUpload = (id: number, w: number, hh: number, px: Uint8Array, rep: boolean): void => {
    const old = live.get(id);
    live.set(id, { bytes: linBytes(w, hh, rep, px), vram: false, site: old?.site ?? site(), w, h: hh, born: old?.born ?? step });
    if (DRAW) up(id, w, hh, px, rep);
  };
  h.texFromCache = (id: number, p: string): [number, number] | undefined => {
    const r = fc(id, p);
    if (r) live.set(id, { bytes: linBytes(r[0], r[1], false, h.raster.tex.get(id)?.px), vram: false, site: SITES ? `cache ${p.replace(/^data\/generated\/gba\//, "")} < ${site()}` : "", w: r[0], h: r[1], born: step });
    return r;
  };
  h.canvasNew = (id: number, w: number, hh: number): void => {
    live.set(id, { bytes: po2(w) * po2(hh) * 4, vram: true, site: site(), w, h: hh, born: step });
    cv(id, w, hh);
  };
  h.texFree = (id: number): void => { live.delete(id); fr(id); };
  if (!DRAW) h.draw = (): void => { h.frames++; };
}
const g = globalThis as Record<string, unknown>;
g.__perfHost = host;
await import("./qjs_boot_host.ts");
const { G } = await import("../../voxelmon/game/gen3/platform/graphics.ts");
const { Game3 } = await import("../../voxelmon/game/gen3/core/Game3.ts");
const { Input } = await import("../../voxelmon/game/gen3/shared/core/Input.ts");
const { Runtime } = await import("../../voxelmon/game/gen3/core/runtime.ts");
const { Player } = await import("../../voxelmon/game/gen3/core/player.ts") as any;
const { Collision } = await import("../../voxelmon/game/gen3/core/collision.ts") as any;
const { Field } = await import("../../voxelmon/game/gen3/core/field.ts") as any;
const { Party } = await import("../../voxelmon/game/gen3/core/party.ts") as any;
const { BattleBridge } = await import("../../voxelmon/game/gen3/core/battle_bridge.ts") as any;
const { Warp } = await import("../../voxelmon/game/gen3/core/warp.ts") as any;
const BattleUi = (await import("../../voxelmon/game/gen3/core/battle/ui.ts") as any).Ui;
const { Options } = await import("../../voxelmon/game/gen3/core/options.ts") as any;
const Trainers = (await import("../../voxelmon/game/gen3/core/scripting/trainers.ts")).default as any;
const { WorldView, parseWorldJson } = await import("../../voxelmon/game/gen3/platform/worldview.ts");
const { Game3World } = await import("../../voxelmon/game/gen3/platform/game3_world.ts");

const t0 = performance.now();
const game: any = Game3.new();
game.load({});
let view: any, field: any;
if (W3D) {
  const ops = { mapShow() {}, mapHide() {}, cam() {}, pitch() {}, tint() {}, flatWorld() {}, g3Ents() {}, strips() {} };
  // the card's paks_firered/world.json (--world), as main.rs's gamedata hands it over
  const wj = opt("--world") ? readFileSync(opt("--world")!, "utf8") : host.read("world.json");
  view = new WorldView(ops as any, parseWorldJson(wj ?? "{}"));
  console.log(`world: ${wj ? "maps " + Object.keys((parseWorldJson(wj) as any)?.maps ?? {}).length : "none (the field is 2D)"}`);
  field = new Game3World(view);
}
console.log(`load ${(performance.now() - t0).toFixed(0)} ms; field ${W3D ? "3D" : "VIEW 2D"}`);

const BIT: Record<string, number> = { UP: 0, DOWN: 1, LEFT: 2, RIGHT: 3, A: 4, B: 5, START: 6, SELECT: 7 };
let f = 0;
let lastMap = "";
let mapChanges = 0;
const hashes: string[] = [];
const inBattle = (): boolean => game.speedCategory?.() === "battle";
function frame(mask: number): void {
  f++;
  (Input as any).hostButtons(mask);
  game.update(1 / 60);
  if (field) field.begin(game);
  G.beginFrame();
  game.draw();
  G.endFrame();
  if (field && view) view.emit(field.state(game));
  if (HASH) hashes.push(`${f} ${Bun.hash(host.pixels()).toString(16)}`);
  if (SHOTS && f % SHOTS === 0) {
    const px = host.pixels(), rgb = Buffer.alloc(240 * 160 * 3);
    for (let i = 0; i < 240 * 160; i++) { rgb[i * 3] = px[i * 4]!; rgb[i * 3 + 1] = px[i * 4 + 1]!; rgb[i * 3 + 2] = px[i * 4 + 2]!; }
    writeFileSync(`${homedir()}/leakruns/shot_${String(f).padStart(6, "0")}.ppm`, Buffer.concat([Buffer.from("P6\n240 160\n255\n"), rgb]));
  }
  const map = Runtime.getSession?.()?.map ?? "";
  if (map !== lastMap) { if (lastMap) mapChanges++; lastMap = map; }
}
const tap = (key: string, hold = 4, after = 20): void => {
  for (let i = 0; i < hold; i++) frame(1 << BIT[key]!);
  for (let i = 0; i < after; i++) frame(0);
};
const idle = (n: number): void => { for (let i = 0; i < n; i++) frame(0); };

const mb = (b: number): string => (b / 1048576).toFixed(2);
let lastIds = new Set<number>();
let lastTypes: Record<string, number> = {};
const SNAP = opt("--snap") ? opt("--snap")!.split(",").map(Number) : undefined;
let snapA: any;
/** Bun keeps a WeakRef's target alive until the current job ends: a turn of
 *  the event loop and a full collection, then a few frames for the guest's
 *  scan (QuickJS frees an unreachable image at once, without either). */
async function settleGc(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  Bun.gc(true);
  idle(17);
}
async function report(what: string): Promise<void> {
  await settleGc();
  let n = 0, lin = 0, vn = 0, vram = 0;
  for (const t of live.values()) { if (t.vram) { vn++; vram += t.bytes; } else { n++; lin += t.bytes; } }
  const jsc = await import("bun:jsc");
  const hs = jsc.heapStats();
  console.log(`[tex] f${String(f).padStart(6)} ${what.padEnd(52)} linear ${String(n).padStart(4)} tex ${mb(lin).padStart(6)} MB | vram ${vn} ${mb(vram)} MB | maps ${mapChanges} | js heap ${mb(hs.heapSize)} MB (${hs.objectCount} objects)`);
  if (argv.includes("--types")) {
    const c = hs.objectTypeCounts as Record<string, number>;
    const d = Object.entries(c).map(([k, v]) => [k, v - (lastTypes[k] ?? 0)] as [string, number]).filter((e) => e[1] !== 0).sort((a, b) => b[1] - a[1]);
    console.log(`[types]   ${d.slice(0, 10).map(([k, v]) => `${k} ${v > 0 ? "+" : ""}${v}`).join(", ")}`);
    lastTypes = { ...c };
  }
  if (SITES) {
    const by = new Map<string, [number, number]>();
    for (const [id, t] of live) {
      if (lastIds.has(id) || t.vram) continue;
      const e = by.get(t.site) ?? [0, 0];
      e[0]++; e[1] += t.bytes;
      by.set(t.site, e);
    }
    for (const [s, e] of [...by].sort((a, b) => b[1][1] - a[1][1]).slice(0, 8)) {
      console.log(`[tex]        +${e[0]} ${mb(e[1])} MB  ${s}`);
    }
  }
  lastIds = new Set(live.keys());
  // --snap a,b: the heap's growth between steps a and b, by holder (heap_diff.ts)
  if (SNAP) {
    if (step === SNAP[0]) snapA = Bun.generateHeapSnapshot();
    if (step === SNAP[1] && snapA) {
      const { heapDiff } = await import("./heap_diff.ts");
      for (const l of heapDiff(snapA, Bun.generateHeapSnapshot() as any, Number(opt("--snap-top") ?? 40), Number(opt("--snap-depth") ?? 3))) console.log(l);
      snapA = undefined;
    }
  }
  step++;
}

// ---- moving about
const DIRS: [string, number, number][] = [["up", 0, -1], ["down", 0, 1], ["left", -1, 0], ["right", 1, 0]];
function firstStep(tx: number, ty: number): string | undefined {
  const C = Collision, P = Player;
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
const KEY: Record<string, string> = { up: "UP", down: "DOWN", left: "LEFT", right: "RIGHT" };
function pathTo(tx: number, ty: number, untilMapChange = true, limit = 3000, onArrive = "DOWN"): boolean {
  const start = lastMap, s0 = f;
  while (f - s0 < limit) {
    if (untilMapChange && lastMap !== start) return true;
    if (inBattle()) { finishBattle(); continue; }
    const P = Player;
    if (P.moving || Runtime.uiBusy?.() || Field.locked) { frame(Runtime.uiBusy?.() ? 1 << BIT.B! : 0); continue; }
    const C = Collision;
    const atEdge = ty < 0 ? P.cellY === 0 : ty >= C._heightCells ? P.cellY === C._heightCells - 1 : tx < 0 ? P.cellX === 0 : tx >= C._widthCells ? P.cellX === C._widthCells - 1 : false;
    let key: string;
    if (atEdge || (P.cellX === tx && P.cellY === ty)) {
      if (!untilMapChange) return true;
      key = tx < 0 ? "LEFT" : tx >= C._widthCells ? "RIGHT" : ty < 0 ? "UP" : ty >= C._heightCells ? "DOWN" : onArrive;
    } else {
      const d = firstStep(tx, ty);
      if (!d) return false;
      key = KEY[d]!;
    }
    frame(1 << BIT[key]!);
  }
  return false;
}
function warpsOf(map: string): any[] {
  const def = game.data?.maps?.[map];
  const out: any[] = [];
  for (const k in def?.warps ?? {}) if (def.warps[k]) out.push(def.warps[k]);
  return out;
}
/** Walk into a door of this map (the one to `toMap` if given), as the player would. */
function doorTo(toMap?: string): boolean {
  const live = warpsOf(lastMap).filter((w) => Collision.warpAt(w.x, w.y));
  const w = (toMap && live.find((w) => w.destMap === toMap)) || live[0];
  if (!w) return false;
  if (Collision.isDoorWarp(game, w.x, w.y) && !Collision.isExitWarp(game, w.x, w.y)) return pathTo(w.x, w.y + 1, true, 2000, "UP");
  return pathTo(w.x, w.y, true, 2000);
}
/** Teleport (the warp module's own request, as a script's warp does) to a map's first warp cell. */
function teleport(map: string, x?: number, y?: number): boolean {
  const w = warpsOf(map)[0];
  if (!w && x === undefined) { console.log(`no warp cell on ${map}`); return false; }
  const before = lastMap;
  Warp.request(Runtime._mod, game, map, x ?? w.x, y ?? w.y + 1, "down");
  for (let i = 0; i < 400 && lastMap === before; i++) frame(0);
  idle(60);
  return lastMap !== before;
}
function settle(): void {
  for (let i = 0; i < 600; i++) {
    if (inBattle()) { finishBattle(); continue; }
    if (Runtime.uiBusy?.() || Field.locked) tap("B", 4, 12); else return;
  }
  console.log(`settle: still busy at f${f} (uiBusy ${Runtime.uiBusy?.()} locked ${Field.locked} phase ${game.phase} battle ${inBattle()})`);
}

// ---- battles
let moveTurn = 0;
function finishBattle(): void {
  const s0 = f;
  // by the battle UI's own state: FIGHT on the action menu, the next of the
  // four moves on the move menu, B to every other screen (text, prompts)
  let want = 1, tries = 0;
  while (inBattle() && f - s0 < 12000) {
    const mode = BattleUi._mode;
    if (mode === "menu") {
      const i = BattleUi._menuIndex;
      if (i === 1) { tap("A", 4, 16); want = (moveTurn++ % 4) + 1; tries = 0; }
      else tap(i === 2 ? "LEFT" : i === 3 ? "UP" : "LEFT", 4, 8);
    } else if (mode === "moves") {
      const i = BattleUi._moveIndex;
      if (i === want || ++tries > 6) { tap("A", 4, 16); want = 1; }
      else {
        // 1 2 / 3 4
        const dx = ((want - 1) % 2) - ((i - 1) % 2), dy = Math.floor((want - 1) / 2) - Math.floor((i - 1) / 2);
        tap(dx > 0 ? "RIGHT" : dx < 0 ? "LEFT" : dy > 0 ? "DOWN" : "UP", 4, 8);
      }
    } else if (mode === "party") {
      // a fainted lead's replacement: the next mon, SEND OUT
      tap("DOWN", 4, 12); tap("A", 4, 20); tap("A", 4, 20);
    } else tap("B", 4, 12);
  }
  if (inBattle()) {
    console.log(`battle still on after ${f - s0} frames (ui mode ${BattleUi._mode}): ended as a win`);
    try { BattleBridge.finishPending("win"); } catch (e) { console.log(`finishPending: ${e}`); }
  }
  idle(90);
}
async function startAndFight(kind: string, start: () => [any, any]): Promise<void> {
  const [ok, err] = start();
  if (!ok) { console.log(`${kind}: start failed: ${err}`); return; }
  for (let i = 0; i < 600 && !inBattle(); i++) frame(0);
  await report(`${kind}: started`);
  finishBattle();
  settle();
  await report(`${kind}: over`);
}
async function wild(species: number, level: number): Promise<void> {
  await startAndFight(`wild #${species} L${level}`, () => BattleBridge.startWild(Runtime._mod, game, { species, level }, {}));
}
async function trainer(id: number): Promise<void> {
  const foe = Trainers.foeFromId(id);
  if (!foe) { console.log(`trainer ${id}: no party`); return; }
  await startAndFight(`trainer ${id}`, () => BattleBridge.start(Runtime._mod, game, foe, { trainerId: id }));
}
/** The party's lead swapped with slot k (another mon's moves). */
function lead(k: number): void {
  const p = Runtime.getSession().party;
  if (!p || !p[k]) return;
  const t = p[1]; p[1] = p[k]; p[k] = t;
}
async function menus(): Promise<void> {
  tap("START", 4, 40);
  tap("A", 4, 90); tap("A", 4, 60); tap("A", 4, 120); tap("RIGHT", 4, 60); tap("RIGHT", 4, 60);
  tap("B", 4, 60); tap("B", 4, 40); tap("B", 4, 60);
  tap("DOWN", 4, 20); tap("A", 4, 120); tap("RIGHT", 4, 40); tap("RIGHT", 4, 40); tap("B", 4, 90); tap("B", 4, 60);
  settle();
  idle(30);
  await report("menus: party, summary, bag");
}

// ---- the session
try {
  game._handleBootAction({ action: "new_game", name: "RED", rivalName: "BLUE", gender: 0, start: { map: "FR_PALLET_TOWN", x: 6, y: 8, facing: "down" } });
  idle(120);
  await report("placed on the town");
  const s = Runtime.getSession();
  for (const [sp, lv] of [[4, 24], [1, 24], [7, 24], [25, 26], [92, 26], [66, 26]]) Party.giveMon(s, sp, lv);
  // battle style SET: no "will you change?" between a trainer's mons
  Options.ensure(s).battleStyle = 1;
  await report("party given");
  const wilds: [number, number][] = [[16, 4], [19, 5], [10, 3], [41, 6], [74, 7], [129, 5], [43, 6], [21, 5], [56, 8], [60, 6], [23, 6], [100, 9]];
  const trainerIds = [0x66, 0x67, 0x68, 0x8e, 0x8f, 0x9c, 0xa1, 0xb0, 0xc0];
  const cities: [string, string][] = [["FR_VIRIDIAN_CITY", "FR_VIRIDIAN_CITY_POKEMON_CENTER_1F"], ["FR_PEWTER_CITY", ""],
    ["FR_CERULEAN_CITY", ""], ["FR_CELADON_CITY", ""], ["FR_SAFFRON_CITY", ""], ["FR_VERMILION_CITY", ""], ["FR_PALLET_TOWN", ""]];
  if (opt("--trainer")) { await trainer(Number(opt("--trainer"))); throw new Error("--trainer: done"); }
  for (let i = 0; i < NBATTLES; i++) {
    lead(1 + (i % 6));
    if (i % 3 === 2) await trainer(trainerIds[i % trainerIds.length]!);
    else { const [sp, lv] = wilds[i % wilds.length]!; await wild(sp, lv); }
    const [city] = cities[i % cities.length]!;
    if (teleport(city)) {
      settle();
      await report(`teleport ${city}`);
      if (doorTo()) { settle(); idle(60); await report(`  in ${lastMap}`); }
      if (doorTo()) { settle(); idle(60); await report(`  out to ${lastMap}`); }
    }
    if (i % 4 === 3) await menus();
  }
  // the town and the route both ways, a connection each time
  // (Viridian's south edge: Pallet's north one runs the professor's script)
  teleport("FR_VIRIDIAN_CITY"); settle();
  for (let k = 0; k < 3; k++) {
    for (let j = 0; j < 2; j++) { pathTo(0, 999, true, 4000); idle(30); settle(); await report(`south to ${lastMap}`); }
    for (let j = 0; j < 2; j++) { pathTo(0, -1, true, 4000); idle(30); settle(); await report(`north to ${lastMap}`); }
  }
  teleport("FR_CELADON_CITY"); settle(); idle(120);
  await report("Celadon at the end");
} catch (e) {
  console.log(`stopped at f${f}: ${(e as Error)?.stack ?? e}`);
}
await report("end");
if (SITES) {
  // everything still alive at the end, by where it was first drawn (and the steps it was born at)
  const by = new Map<string, { n: number; b: number; born: number[] }>();
  for (const t of live.values()) {
    const e = by.get(t.site) ?? { n: 0, b: 0, born: [] };
    e.n++; e.b += t.bytes; e.born.push(t.born);
    by.set(t.site, e);
  }
  console.log("[live] at the end, by site:");
  for (const [s, e] of [...by].sort((a, b) => b[1].b - a[1].b)) {
    console.log(`[live] ${String(e.n).padStart(3)} ${mb(e.b).padStart(6)} MB  steps ${e.born.slice(0, 12).join(",")}${e.born.length > 12 ? ",..." : ""}  ${s}`);
  }
}
console.log(`${f} frames, ${mapChanges} map changes, ${((performance.now() - t0) / 1000).toFixed(0)} s`);
if (HASH) { writeFileSync(HASH, hashes.join("\n") + "\n"); console.log(`${hashes.length} frame hashes -> ${HASH}`); }
