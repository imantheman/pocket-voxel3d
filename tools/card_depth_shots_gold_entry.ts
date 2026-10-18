// Citra shots of Gold/Silver/Crystal battles on the 3D stage with the two
// mons' cards overlapping, for the empty corners of the near card hiding the
// far one (bundled in place of game-gold.js): the card's save continued,
// then a wild battle staged in 3D on each route below, shot as it opens, at
// its menu and after a hit, plus the overworld in a big city for the perf
// line. Before each shot the logic stands still for a second, so the frame
// shot is the same whichever step the host composed. Each is shot to the
// card (shot_N.ppm top, shot_N_r.ppm right eye, shot_N_b.ppm bottom) with a
// "[pv] bpshot N name" line. Never shipped.
import "../voxelmon/game/gen2/main.ts";
import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";
import { native } from "../voxelmon/game/quickjs-host.ts";
import { Save } from "../voxelmon/game/gen2/core/Save.ts";
import { Mon } from "../voxelmon/game/gen2/battle/Mon.ts";
import { Battle } from "../voxelmon/game/gen2/battle/Battle.ts";
import { Screens } from "../voxelmon/game/gen2/shared/ui/Screens.ts";
import { setClockSource } from "../voxelmon/game/gen2/platform/clock.ts";

const g = globalThis as unknown as { goldGame: any; frame: (b: number) => void };
const game = g.goldGame;
const mainFrame = g.frame;
setClockSource({ now: () => 1790000000 });

const logicFrame = game.logicFrame.bind(game);
let frozen = false;
game.logicFrame = (b: number): void => {
  if (!frozen) logicFrame(b);
};

let shots = 0;
const shot = (name: string): void => {
  console.log(`[pv] bpshot ${shots} ${name} map=${game.world?.map?.id}`);
  shots++;
  native.screenshot?.();
};

const dvs = () => ({ attack: 15, defense: 15, speed: 15, special: 15 });

/** The walkable, warp-free cell nearest (cx, cy) on the loaded map. */
function nearestOpen(map: any, cx: number, cy: number): [number, number] | null {
  for (let r = 0; r < 24; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = cx + dx;
        const y = cy + dy;
        if (!map.inBounds(x, y)) continue;
        if (map.isWalkableCell(x, y) && !map.warpAt(x, y)) return [x, y];
      }
    }
  }
  return null;
}

/** Onto `map` near the middle of it. */
function goTo(id: string, fx = 0.5, fy = 0.5): void {
  while (game.stack.top()) game.stack.pop();
  const w = game.world;
  const def = w.maps[id];
  w.warpToMapId(id, Math.floor(def.width * 2 * fx), Math.floor(def.height * 2 * fy), "down");
  const p = w.player;
  const at = nearestOpen(w.map, p.cellX, p.cellY);
  if (at) w.setMap(id, at[0], at[1], "down");
  console.log(`[pv] carddepth: ${id} at ${at ? at.join(",") : "?"}`);
}

let battleState: any = null;
function battle(mine: string, lv: number, foe: string, flv: number): void {
  game.save.party = [Mon.new(game.data, mine, lv, { dvs: dvs(), moves: [{ id: "SWIFT", pp: 63, maxPp: 63 }] })];
  const wild: any = Mon.new(game.data, foe, flv, { dvs: dvs() });
  const b: any = Battle.new({ data: game.data, party: game.save.party, wild, save: game.save });
  Screens.push(game, "Gen2BattleState", { battle: b, save: game.save, onDone: () => game.stack.pop() });
  battleState = game.stack.top();
}

// the script: each entry waits for its condition (or a step count after the
// last), then runs; "shoot" freezes the logic for 60 steps and shoots
type Step = { after?: number; until?: () => boolean; pad?: number; run?: () => void; shoot?: string };
const fight = (map: string, mine: string, lv: number, foe: string, flv: number, tag: string): Step[] => [
  { after: 10, run: () => goTo(map) },
  { after: 90, run: () => battle(mine, lv, foe, flv) },
  { after: 100, shoot: `${tag}_opens` },
  { until: () => battleState?.phase === "menu" },
  { after: 90, shoot: `${tag}_menu` },
  { after: 10, pad: VOX_BTN.a },
  { until: () => battleState?.phase === "moves" },
  { after: 10, pad: VOX_BTN.a },
  { until: () => battleState?.phase !== "moves" },
  // back at the menu, or (a knock-out) the battle gone
  { until: () => battleState?.phase === "menu" || game.stack.top() !== battleState },
  { after: 90, shoot: `${tag}_after_hit` },
];
const STEPS: Step[] = [
  ...fight("ROUTE_34", "SPINARAK", 17, "DROWZEE", 10, "r34"),
  ...fight("ROUTE_29", "ONIX", 12, "HOOTHOOT", 12, "r29"),
  ...fight("ROUTE_35", "SNORLAX", 20, "PIDGEY", 18, "r35"),
  // the overworld in the big city, for the perf line, and a shot
  { after: 10, run: () => goTo("GOLDENROD_CITY") },
  { after: 600, shoot: "goldenrod" },
  { after: 400, run: () => console.log("[pv] bpshot done") },
];

let started = false;
let ready = -1;
let at = 0;
let since = 0;
let hold = 0;
let i = 0;

g.frame = (b: number): void => {
  i++;
  if (!started) {
    started = true;
    const [save] = Save.load();
    game.continueGame(save);
  }
  let pad = 0;
  if (ready < 0 && game.world?.map && game.phase === "play") {
    game.options.view = "3d";
    game.options.battleView = "3d";
    game.options.movement = "grid";
    game.options.battleScene = true;
    game.save.repelSteps = 60000;
    game.world.trainerBeaten = () => true;
    game.setGameSpeed(1);
    ready = i + 60;
  }
  if (ready >= 0 && i >= ready && at < STEPS.length) {
    if (hold > 0) {
      // frozen: the same frame composed every step; shot halfway
      hold--;
      if (hold === 30) shot(STEPS[at]!.shoot!);
      if (hold === 0) {
        frozen = false;
        at++;
        since = 0;
      }
    } else {
      since++;
      const s = STEPS[at]!;
      const due = s.until ? s.until() : since >= (s.after ?? 0);
      if (s.until && !due && battleState && since % 20 === 0 && battleState.phase !== "moves") pad = VOX_BTN.a;
      if (due) {
        if (s.shoot) {
          frozen = true;
          hold = 60;
        } else {
          if (s.run) s.run();
          if (s.pad) pad = s.pad;
          at++;
          since = 0;
        }
      }
    }
  }
  mainFrame((b & ~0xff) | pad);
};
