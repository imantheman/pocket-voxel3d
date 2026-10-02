// A Citra check of Gold's 3D battles (cc_gold_bench.sh tools/gold_battle3d_entry.ts):
// the real entry, the card's save continued straight away (no title), and
// once the world is up a wild battle on the spot that drives itself through
// FIGHT -> the first move with PP, over and over. TRAINERS=1 at bundle time:
// trainer battles instead (FALKNER, WHITNEY, then a few classes), so the
// trainers' own cards stand in the arena for the intro. Never shipped.
import "../voxelmon/game/gen2/main.ts";
import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";
import { seed } from "../voxelmon/game/gen2/platform/rng.ts";
import { Save } from "../voxelmon/game/gen2/core/Save.ts";
import { Mon } from "../voxelmon/game/gen2/battle/Mon.ts";
import { Battle } from "../voxelmon/game/gen2/battle/Battle.ts";
import { Screens } from "../voxelmon/game/gen2/shared/ui/Screens.ts";
import { Trainers } from "../voxelmon/game/gen2/world/Trainers.ts";

declare const TRAINERS: boolean;
const trainers = typeof TRAINERS !== "undefined" && TRAINERS;
// trainer classes by their constant (constants/trainer_constants.asm):
// FALKNER, WHITNEY, BUGSY, YOUNGSTER, LASS
const CLASSES = [1, 2, 3, 26, 29];

const g = globalThis as unknown as { goldGame: any; frame: (b: number) => void };
const game = g.goldGame;
const mainFrame = g.frame;
const perfect = () => ({ attack: 15, defense: 15, speed: 15, special: 15 });
let started = false;
let worldFrames = 0;
let state: any = null;
let done = true;
let i = 0;
const WILD = ["SENTRET", "PIDGEY", "HOOTHOOT", "RATTATA", "HOPPIP", "SPINARAK"];
let n = 0;
g.frame = (_b: number): void => {
  if (!started) {
    started = true;
    const [save] = Save.load();
    game.continueGame(save);
    game.options.battleView = "3d";
  }
  let b = 0;
  if (game.world?.map) worldFrames++;
  if (worldFrames > 90) {
    if (done) {
      seed(0x2929 + n);
      const wild: any = Mon.new(game.data, WILD[n++ % WILD.length]!, 12, { dvs: perfect() });
      game.save.party = [Mon.new(game.data, "CYNDAQUIL", 30, { dvs: perfect() })];
      // the record the world hands a battle (World.startBattle): the
      // lookup, with its rows built into a party
      const record: any = trainers ? Trainers.lookup(game.data.trainers, CLASSES[(n - 1) % CLASSES.length]!, 1) : undefined;
      const trainer = record ? { ...record, memberId: record.id, party: Trainers.party(game.data, record) } : undefined;
      if (trainer) console.log(`[pv] bench trainer: ${trainer.classId} ${trainer.name ?? ""}`);
      const battle: any = Battle.new({ data: game.data, party: game.save.party, wild: trainer ? undefined : wild, trainer, save: game.save });
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
      const moves: any[] = state.playerMoves();
      const target = Math.max(1, moves.findIndex((m: any) => (m.pp ?? 1) > 0) + 1);
      if (tick) b = state.moveIndex < target ? VOX_BTN.down : state.moveIndex > target ? VOX_BTN.up : VOX_BTN.a;
    } else if (i % 8 === 0) b = VOX_BTN.a;
    i++;
  }
  mainFrame(b);
};
