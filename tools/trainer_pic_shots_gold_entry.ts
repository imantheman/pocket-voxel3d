// Citra shots of the trainers' own cards on Gold/Silver/Crystal's 3D battle
// stage (bundled in place of game-gold.js): the card's save continued, then a
// wild battle and two trainer battles (a leader, then a class) staged on two
// routes, each shot three times through its opening while the trainers stand
// in the arena, the logic frozen for a second around each shot. A run built
// for Crystal reads the save's own gender, so a female save shows her pic.
// Each is shot to the card (shot_N.ppm top, shot_N_r.ppm right eye,
// shot_N_b.ppm bottom) with a "[pv] bpshot N name" line. Never shipped.
import "../voxelmon/game/gen2/main.ts";
import { native } from "../voxelmon/game/quickjs-host.ts";
import { Save } from "../voxelmon/game/gen2/core/Save.ts";
import { Mon } from "../voxelmon/game/gen2/battle/Mon.ts";
import { Battle } from "../voxelmon/game/gen2/battle/Battle.ts";
import { Screens } from "../voxelmon/game/gen2/shared/ui/Screens.ts";
import { Trainers } from "../voxelmon/game/gen2/world/Trainers.ts";
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
  console.log(`[pv] bpshot ${shots} ${name} map=${game.world?.map?.id} gender=${game.save?.gender}`);
  shots++;
  native.screenshot?.();
};
const dvs = () => ({ attack: 15, defense: 15, speed: 15, special: 15 });

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

function goTo(id: string): void {
  while (game.stack.top()) game.stack.pop();
  const w = game.world;
  const def = w.maps[id];
  w.warpToMapId(id, Math.floor(def.width), Math.floor(def.height), "down");
  const p = w.player;
  const at = nearestOpen(w.map, p.cellX, p.cellY);
  if (at) w.setMap(id, at[0], at[1], "down");
  console.log(`[pv] trainerpic: ${id} at ${at ? at.join(",") : "?"}`);
}

/** A battle: a wild `foe`, or the first trainer of class `cls`. */
function battle(foe: string | null, cls: number | null): void {
  game.save.party = [Mon.new(game.data, "CYNDAQUIL", 20, { dvs: dvs(), moves: [{ id: "SWIFT", pp: 63, maxPp: 63 }] })];
  const record: any = cls !== null ? Trainers.lookup(game.data.trainers, cls, 1) : undefined;
  const trainer = record ? { ...record, memberId: record.id, party: Trainers.party(game.data, record) } : undefined;
  const wild: any = foe ? Mon.new(game.data, foe, 10, { dvs: dvs() }) : undefined;
  const b: any = Battle.new({ data: game.data, party: game.save.party, wild: trainer ? undefined : wild, trainer, save: game.save });
  Screens.push(game, "Gen2BattleState", { battle: b, save: game.save, onDone: () => game.stack.pop() });
  console.log(`[pv] trainerpic: battle ${foe ?? ""} ${trainer ? trainer.classId + " " + (trainer.name ?? "") : ""}`);
}

type Step = { after: number; run?: () => void; shoot?: string };
// ... and the battle popped after, with frames to spare before the next, so
// the stage sees no battle and takes itself down (battlestage.ts end)
const opening = (tag: string): Step[] => [
  { after: 50, shoot: `${tag}_a` },
  { after: 40, shoot: `${tag}_b` },
  { after: 40, shoot: `${tag}_c` },
  { after: 10, run: () => { while (game.stack.top()?.screenId === "Gen2BattleState") game.stack.pop(); } },
  { after: 30 },
];
const STEPS: Step[] = [
  { after: 10, run: () => goTo("ROUTE_29") },
  { after: 90, run: () => battle("PIDGEY", null) },
  ...opening("r29_wild"),
  { after: 10, run: () => battle(null, 1) }, // FALKNER
  ...opening("r29_leader"),
  { after: 10, run: () => goTo("ROUTE_34") },
  { after: 90, run: () => battle(null, 26) }, // YOUNGSTER
  ...opening("r34_youngster"),
  { after: 10, run: () => battle("DROWZEE", null) },
  ...opening("r34_wild"),
  { after: 60, run: () => console.log("[pv] bpshot done") },
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
      hold--;
      if (hold === 30) shot(STEPS[at]!.shoot!);
      if (hold === 0) {
        frozen = false;
        at++;
        since = 0;
      }
    } else if (++since >= STEPS[at]!.after) {
      const s = STEPS[at]!;
      if (s.shoot) {
        frozen = true;
        hold = 60;
      } else {
        s.run?.();
        at++;
        since = 0;
      }
    }
  }
  mainFrame(b & ~0xff);
};
