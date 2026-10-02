// A Citra check of Gold's 2D battles in the 3D world (cc_gold_bench.sh
// tools/gold_battle2d_entry.ts): the card's save continued with VIEW 3D and
// BATTLES 2D (ONLY=1 at bundle time: VIEW 2D too), a wild battle that
// drives itself, a top-screen shot (native screenshot) every two seconds.
// Never shipped.
import "../voxelmon/game/gen2/main.ts";
import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";
import { seed } from "../voxelmon/game/gen2/platform/rng.ts";
import { Save } from "../voxelmon/game/gen2/core/Save.ts";
import { Mon } from "../voxelmon/game/gen2/battle/Mon.ts";
import { Battle } from "../voxelmon/game/gen2/battle/Battle.ts";
import { Screens } from "../voxelmon/game/gen2/shared/ui/Screens.ts";
import { native } from "../voxelmon/game/quickjs-host.ts";

declare const ONLY: string;
const g = globalThis as unknown as { goldGame: any; frame: (b: number) => void };
const game = g.goldGame;
const mainFrame = g.frame;
const perfect = () => ({ attack: 15, defense: 15, speed: 15, special: 15 });
const WALK = [VOX_BTN.left, VOX_BTN.left, VOX_BTN.up, VOX_BTN.right, VOX_BTN.right, VOX_BTN.down];
let started = false;
let worldFrames = 0;
let state: any = null;
let done = true;
let i = 0;
g.frame = (_b: number): void => {
  if (!started) {
    started = true;
    const [save] = Save.load();
    game.continueGame(save);
    game.options.view = typeof ONLY !== "undefined" ? "2d" : "3d";
    game.options.battleView = "2d";
  }
  let b = 0;
  if (game.world?.map) worldFrames++;
  if (worldFrames > 0 && worldFrames % 120 === 0 && worldFrames < 1800) native.screenshot?.();
  if (worldFrames > 30 && worldFrames < 300) {
    // a step every 20 frames, round a little loop
    b = WALK[Math.floor(worldFrames / 20) % WALK.length]!;
  } else if (worldFrames >= 300) {
    if (done) {
      seed(0x2929 + i);
      const wild: any = Mon.new(game.data, "SENTRET", 12, { dvs: perfect() });
      game.save.party = [Mon.new(game.data, "CYNDAQUIL", 30, { dvs: perfect() })];
      const battle: any = Battle.new({ data: game.data, party: game.save.party, wild, save: game.save });
      done = false;
      Screens.push(game, "Gen2BattleState", { battle, save: game.save, onDone: () => { done = true; game.stack.pop(); } });
      state = game.stack.top();
    }
    const phase: string = state.phase;
    const tick = i % 4 === 0;
    if (phase === "menu") {
      if (tick && state.menuIndex === 1 && (state.messageTimer ?? 0) <= 0) b = VOX_BTN.a;
      else if (tick && state.menuIndex !== 1) b = VOX_BTN.up;
    } else if (phase === "moves") {
      if (tick) b = state.moveIndex > 1 ? VOX_BTN.up : VOX_BTN.a;
    } else if (i % 8 === 0) b = VOX_BTN.a;
    i++;
  }
  mainFrame(b);
};
