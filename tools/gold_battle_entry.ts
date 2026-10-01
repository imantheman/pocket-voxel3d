// A Citra/hardware bench build of Gold (cc_gold_bench.sh): the real entry,
// then a wild battle on ROUTE_29 that drives itself through FIGHT -> EMBER
// for ever (tools/qjs_bench_battle.ts's driver), so the perf line reports a
// battle's frame rate on the console. Never shipped.
import "../voxelmon/game/gen2/main.ts";
import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";
import { seed } from "../voxelmon/game/gen2/platform/rng.ts";
import { Mon } from "../voxelmon/game/gen2/battle/Mon.ts";
import { Battle } from "../voxelmon/game/gen2/battle/Battle.ts";
import { Screens } from "../voxelmon/game/gen2/shared/ui/Screens.ts";

const g = globalThis as unknown as { goldGame: any; frame: (b: number) => void };
const game = g.goldGame;
const mainFrame = g.frame;
const perfect = () => ({ attack: 15, defense: 15, speed: 15, special: 15 });
let state: any = null;
let done = true;
let i = 0;
g.frame = (_buttons: number): void => {
  if (done) {
    game.stack.clear();
    seed(0x2929);
    const slot = game.data.gen2Encounters.grass.ROUTE_29.slots.DAY[0];
    game.save.party = [Mon.new(game.data, "CYNDAQUIL", 14, { dvs: perfect() })];
    const wild: any = Mon.new(game.data, slot.species, slot.level, { dvs: perfect() });
    const battle: any = Battle.new({ data: game.data, party: game.save.party, wild, save: game.save });
    done = false;
    Screens.push(game, "Gen2BattleState", { battle, save: game.save, onDone: () => { done = true; game.stack.pop(); } });
    state = game.stack.top();
  }
  const phase: string = state.phase;
  const tick = i % 4 === 0;
  let b = 0;
  if (phase === "menu") {
    if (tick && state.menuIndex === 1 && (state.messageTimer ?? 0) <= 0) b = VOX_BTN.a;
    else if (tick && state.menuIndex !== 1) b = VOX_BTN.up;
  } else if (phase === "moves") {
    const moves: any[] = state.playerMoves();
    const target = moves.findIndex((m: any) => m.id === "EMBER") + 1;
    if (tick) b = state.moveIndex < target ? VOX_BTN.down : state.moveIndex > target ? VOX_BTN.up : VOX_BTN.a;
  } else if (i % 8 === 0) b = VOX_BTN.a;
  i++;
  mainFrame(b);
};
