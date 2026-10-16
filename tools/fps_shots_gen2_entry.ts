// Citra shots of the Gold/Silver/Crystal party screen and battle screen, top
// and bottom, for checking a drawing change left them as they were (bundled
// in place of game-gold.js). The card's save continued with the speed
// bench's party, the clock pinned (the bottom panel shows the time); then
// the party screen, its cursor moved, its submenu, and a wild battle staged
// in 3D at its menu, its move list and after a hit. Before each shot the
// logic stands still for a second (game.logicFrame does nothing), so the
// frame shot is the same whichever step the host happened to compose. Each
// is shot to the card (shot_N.ppm top, shot_N_r.ppm right eye, shot_N_b.ppm
// bottom) with a "[pv] bpshot N name" line. Never shipped.
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
  console.log(`[pv] bpshot ${shots} ${name}`);
  shots++;
  native.screenshot?.();
};

const perfect = () => ({ attack: 15, defense: 15, speed: 15, special: 15 });
function party(): any[] {
  return ["MEW", "ARCANINE", "LAPRAS", "SNORLAX", "JOLTEON", "DRAGONITE"].map((sp) =>
    Mon.new(game.data, sp, 70, { dvs: perfect(), moves: [{ id: "SWIFT", pp: 63, maxPp: 63 }] }));
}

// the script: each entry waits for its condition (or a step count after the
// last), then runs; "hold" freezes the logic for 60 steps and shoots
type Step = { after?: number; until?: () => boolean; pad?: number; run?: () => void; shoot?: string };
let battleState: any = null;
const STEPS: Step[] = [
  { after: 1, run: () => {
    while (game.stack.top()) game.stack.pop();
    game.save.party = party();
    game.save.party[2].hp = 30;
    game.save.party[3].status = "psn";
    Screens.push(game, "Gen2PartyMenu", { prompt: "choose", submenu: true, onCancel: () => game.stack.pop() });
  } },
  { after: 90, shoot: "party" },
  { after: 10, pad: VOX_BTN.down },
  { after: 10, pad: VOX_BTN.down },
  { after: 40, shoot: "party_cursor3" },
  { after: 10, pad: VOX_BTN.a },
  { after: 50, shoot: "party_submenu" },
  { after: 10, run: () => {
    while (game.stack.top()) game.stack.pop();
    game.world.setMap("ROUTE_29", 20, 8, "down");
  } },
  { after: 60, run: () => {
    game.save.party = party();
    const wild: any = Mon.new(game.data, "CHANSEY", 60, { dvs: perfect() });
    const battle: any = Battle.new({ data: game.data, party: game.save.party, wild, save: game.save });
    Screens.push(game, "Gen2BattleState", { battle, save: game.save, onDone: () => game.stack.pop() });
    battleState = game.stack.top();
  } },
  { until: () => battleState?.phase === "menu" },
  { after: 90, shoot: "battle_menu" },
  { after: 10, pad: VOX_BTN.a },
  { until: () => battleState?.phase === "moves" },
  { after: 60, shoot: "battle_moves" },
  { after: 10, pad: VOX_BTN.a },
  { until: () => battleState?.phase !== "moves" },
  // the hit, then the text through to the menu again (A every 20 steps)
  { until: () => battleState?.phase === "menu" },
  { after: 90, shoot: "battle_after_hit" },
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
