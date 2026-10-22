// Citra shots of a move's animation in Gold's 3D battle (cc_gold_bench.sh
// tools/gold_anim3d_shots_entry.ts): the card's save continued, a wild battle
// on the spot with BATTLES 3D, FIGHT -> EMBER, and a shot every 6 frames while
// the animation runs -- for the effect landing on the cards rather than where
// the 2D pics were (DrawList::lcd_field). shot_N.ppm on the card, a
// "[pv] bpshot N" line in pvlog.txt each. Never shipped.
import "../voxelmon/game/gen2/main.ts";
import { native } from "../voxelmon/game/quickjs-host.ts";
import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";
import { seed } from "../voxelmon/game/gen2/platform/rng.ts";
import { Save } from "../voxelmon/game/gen2/core/Save.ts";
import { Mon } from "../voxelmon/game/gen2/battle/Mon.ts";
import { Battle } from "../voxelmon/game/gen2/battle/Battle.ts";
import { Screens } from "../voxelmon/game/gen2/shared/ui/Screens.ts";

const g = globalThis as unknown as { goldGame: any; frame: (b: number) => void };
const game = g.goldGame;
const mainFrame = g.frame;
const perfect = () => ({ attack: 15, defense: 15, speed: 15, special: 15 });
let started = false;
let worldFrames = 0;
let state: any = null;
let done = true;
let i = 0;
let shots = 0;
let battles = 0;
g.frame = (_b: number): void => {
  if (!started) {
    started = true;
    const [save] = Save.load();
    game.continueGame(save);
    game.options.battleView = "3d";
    game.options.gameSpeed = 1;
  }
  let b = 0;
  if (game.world?.map) worldFrames++;
  if (worldFrames > 90 && battles <= 2) {
    if (done) {
      battles++;
      seed(0x2929 + battles);
      const wild: any = Mon.new(game.data, "ONIX", 20, { dvs: perfect() });
      game.save.party = [Mon.new(game.data, "CYNDAQUIL", 30, { dvs: perfect() })];
      const battle: any = Battle.new({ data: game.data, party: game.save.party, wild, save: game.save });
      done = false;
      Screens.push(game, "Gen2BattleState", { battle, save: game.save, onDone: () => { done = true; game.stack.pop(); } });
      state = game.stack.top();
      console.log(`[pv] bpshot battle ${battles}`);
    }
    const phase: string = state.phase;
    const tick = i % 4 === 0;
    if (phase === "menu") {
      if (tick && state.menuIndex === 1 && (state.messageTimer ?? 0) <= 0) b = VOX_BTN.a;
      else if (tick && state.menuIndex !== 1) b = VOX_BTN.up;
    } else if (phase === "moves") {
      const moves: any[] = state.playerMoves();
      const target = Math.max(1, moves.findIndex((m: any) => m.id === "EMBER") + 1);
      if (tick) b = state.moveIndex < target ? VOX_BTN.down : state.moveIndex > target ? VOX_BTN.up : VOX_BTN.a;
    } else if (i % 8 === 0) b = VOX_BTN.a;
    const anim = state.anim?.animId;
    if (anim && i % 6 === 0 && shots < 48) {
      console.log(`[pv] bpshot ${shots} ${anim}`);
      shots++;
      native.screenshot?.();
    }
    i++;
  }
  mainFrame(b);
};
