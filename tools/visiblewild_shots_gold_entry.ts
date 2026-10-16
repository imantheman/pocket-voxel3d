// A Citra tour of VISIBLE WILD on Gold/Silver/Crystal (bundled in place of
// game-gold.js): the card's save continued, then a route's grass with SOME
// and MANY in 3D and in 2D, every mon made shiny (SHINY ODDS 1/1) for one
// shot, a walk into a mon and the battle it starts; then the timing tour --
// MANY (and OFF, to compare) on a long route and in the national park at 1X
// and 2X, each held long enough for the host's perf lines, with a
// "[pv] vwbench <place> <mode> <speed>" line before each. Each shot goes to
// the card (shot_N.ppm top, shot_N_b.ppm bottom) with a "[pv] bpshot N name"
// line. Nothing is saved. Never shipped.
//
// globalThis.vwTour picks the tour: "shots" (default), "perf", or "all".
import "../voxelmon/game/gen2/main.ts";
import { native } from "../voxelmon/game/quickjs-host.ts";
import { Mon } from "../voxelmon/game/gen2/battle/Mon.ts";
import { Save } from "../voxelmon/game/gen2/core/Save.ts";
import { VisibleWild } from "../voxelmon/game/gen2/world/VisibleWild.ts";
import { search } from "../voxelmon/game/battle/arena.ts";
import { chooseView } from "../voxelmon/game/battle/staging.ts";

const g = globalThis as unknown as { goldGame: any; frame: (b: number) => void; vwTour?: string; goldProf?: boolean };
const game = g.goldGame;
const mainFrame = g.frame;
const BTN: Record<string, number> = { a: 1, b: 2, right: 1 << 3, left: 1 << 2, up: 1 << 4, down: 1 << 5 };
const TOUR = g.vwTour ?? "all";

let i = 0;
let started = false;
let shots = 0;
const shot = (name: string): void => {
  console.log(`[pv] bpshot ${shots} ${name}`);
  shots++;
  native.screenshot?.();
};

const world = (): any => game.world;
const vw = (): any => world().visibleWild;

/** The cell of `mapId` with the most cells a mon could stand on round it. */
function bestSpot(): [number, number] {
  const w = world();
  const probe = new VisibleWild();
  const save = { x: w.player.cellX, y: w.player.cellY, px: w.player.px, py: w.player.py };
  let best: [number, number] = [save.x, save.y];
  let most = -1;
  for (let y = 2; y < w.map.heightCells - 2; y += 2) {
    for (let x = 2; x < w.map.widthCells - 2; x += 2) {
      if (!w.map.isWalkable(x, y)) continue;
      w.player.cellX = x;
      w.player.cellY = y;
      w.player.px = x * 16;
      w.player.py = y * 16;
      const n = probe.candidates(w).length;
      if (n > most) {
        most = n;
        best = [x, y];
      }
    }
  }
  Object.assign(w.player, { cellX: save.x, cellY: save.y, px: save.px, py: save.py });
  console.log(`[pv] vwbench spot ${w.map.id} ${best[0]},${best[1]} (${most} cells)`);
  return best;
}

type Step = { at: number; run: () => number | void };
const steps: Step[] = [];
let clock = 0;
/** Queue `run` `wait` steps after the one before. */
const then = (wait: number, run: () => number | void): void => {
  clock += wait;
  steps.push({ at: clock, run });
};
let pad = 0;
let padUntil = 0;
const hold = (btn: number, n: number): void => {
  pad = btn;
  padUntil = i + n;
};

/** Warp to `mapId`, then onto its grassiest cell. */
function goTo(mapId: string): void {
  then(1, () => {
    while (game.stack.top()) game.stack.pop();
    world().visibleWild?.clear();
    world().warpToMapId(mapId, 6, 6, "down");
  });
  then(150, () => {
    const [x, y] = bestSpot();
    world().warpToMapId(mapId, x, y, "down");
  });
  then(150, () => undefined);
}

function shotsTour(): void {
  goTo("ROUTE_29");
  then(1, () => { game.options.visibleWild = "some"; game.options.view = "3d"; });
  then(420, () => shot("route_some_3d"));
  then(20, () => { game.options.visibleWild = "many"; });
  then(480, () => shot("route_many_3d"));
  then(20, () => { game.options.view = "2d"; });
  then(60, () => shot("route_many_2d"));
  then(20, () => { game.options.visibleWild = "some"; });
  then(300, () => shot("route_some_2d"));
  // every one shiny for a shot, in 3D and 2D
  then(20, () => { game.options.view = "3d"; game.options.shinyOdds = 1; game.options.visibleWild = "many"; vw()?.clear(); });
  then(480, () => shot("route_shiny_3d"));
  then(20, () => { game.options.view = "2d"; });
  then(60, () => shot("route_shiny_2d"));
  then(20, () => { delete game.options.shinyOdds; game.options.view = "3d"; vw()?.clear(); });
  // a walk into one: the nearest mon, the player put a cell to its left,
  // facing it; RIGHT walks in
  then(420, () => {
    const w = world();
    const list: any[] = vw()?.list ?? [];
    const p = w.player;
    let pick: any;
    let fallback: any;
    for (const m of list) {
      if (m.npc.moving) continue;
      const lx = m.npc.cellX - 1;
      if (!w.map.isWalkable(lx, m.npc.cellY) || w.npcAt(lx, m.npc.cellY)) continue;
      fallback = fallback ?? m;
      // a spot whose battle stage looks down on its cards (some arenas on
      // this route get a level camera that the grass hides them from)
      const arena: any = search(w.map, lx, m.npc.cellY, false);
      const view: any = arena ? chooseView(w.map, arena, 0, 32) : null;
      if (view && view.pitch > 0) {
        pick = m;
        break;
      }
    }
    pick = pick ?? fallback;
    if (!pick) return;
    pick.pause = 9999;
    p.cellX = pick.npc.cellX - 1;
    p.cellY = pick.npc.cellY;
    p.px = p.cellX * 16;
    p.py = p.cellY * 16;
    p.facing = "right";
    console.log(`[pv] vwbench touch ${pick.species} L${pick.level} at ${pick.npc.cellX},${pick.npc.cellY}`);
  });
  then(30, () => shot("touch_before"));
  then(2, () => hold(BTN.right!, 8));
  then(150, () => shot("touch_battle_intro"));
  then(240, () => shot("touch_battle"));
  then(240, () => shot("touch_battle_menu"));
}

/** The battle camera at the first route's (40,14), whose solved framing
 *  stood its eye in the south edge's border fill: a battle begun there. */
function camTour(): void {
  then(1, () => {
    while (game.stack.top()) game.stack.pop();
    game.options.visibleWild = "off";
    game.options.view = "3d";
    world().warpToMapId("ROUTE_29", 40, 14, "down");
  });
  then(200, () => {
    world().startBattle({ wild: Mon.new(game.data, "HOOTHOOT", 3, {}) });
    console.log("[pv] vwbench cam: battle at 40,14");
  });
  then(420, () => shot("cam_40_14_battle"));
}

/** One shot for a second game: MANY on a route in 3D. */
function oneTour(): void {
  goTo("ROUTE_29");
  then(1, () => { game.options.visibleWild = "many"; game.options.view = "3d"; });
  then(600, () => shot("route_many_3d"));
  then(20, () => { game.options.view = "2d"; });
  then(60, () => shot("route_many_2d"));
}

/** The same wild battle started straight through World.startBattle with
 *  VISIBLE WILD off, on the same spot, for comparison with a touch's. */
function abTour(): void {
  goTo("ROUTE_29");
  then(1, () => { game.options.visibleWild = "off"; game.options.view = "3d"; });
  then(120, () => {
    world().startBattle({ wild: Mon.new(game.data, "HOOTHOOT", 3, {}) });
    console.log("[pv] vwbench ab: plain battle started");
  });
  then(400, () => shot("ab_plain_battle"));
}

function perfTour(): void {
  g.goldProf = true;
  for (const place of ["ROUTE_32", "NATIONAL_PARK"]) {
    goTo(place);
    for (const mode of ["many", "off"]) {
      for (const speed of [1, 2]) {
        then(1, () => {
          game.options.view = "3d";
          game.options.visibleWild = mode;
          game.setGameSpeed(speed);
          console.log(`[pv] vwbench ${place} ${mode} ${speed}X`);
        });
        then(900, () => console.log(`[pv] vwbench ${place} ${mode} ${speed}X mons ${vw()?.list?.length ?? 0}`));
      }
    }
    then(1, () => { game.setGameSpeed(1); game.options.visibleWild = "many"; });
    then(240, () => shot(`perf_${place.toLowerCase()}`));
  }
}

let built = false;
g.frame = (b: number): void => {
  i++;
  if (!started) {
    started = true;
    const [save] = Save.load();
    game.continueGame(save);
    game.persistOptions = () => undefined;
    for (const k of ["visibleWild", "wildEncounters", "shinyOdds", "cheats"]) delete game.options[k];
    game.options.view = "3d";
    game.setGameSpeed(1);
  }
  if (!built && game.world?.map && game.phase === "play") {
    built = true;
    const s = game.save;
    if (!(s.party ?? []).length) s.party = [Mon.new(game.data, "CYNDAQUIL", 20, {})];
    clock = i + 60;
    if (TOUR === "ab") abTour();
    if (TOUR === "one") oneTour();
    if (TOUR === "cam") camTour();
    if (TOUR === "shots" || TOUR === "all") shotsTour();
    if (TOUR === "perf" || TOUR === "all") perfTour();
    then(30, () => console.log("[pv] bpshot done"));
  }
  while (steps.length && i >= steps[0]!.at) steps.shift()!.run();
  const p = i < padUntil ? pad : 0;
  mainFrame((b & ~0xff) | p);
};
