// Debug: WHIRLPOOL in the Dragon's Den -- clear the one at (10,20), step on,
// and see what a wild battle there does (bun tools/dbg_gold_whirl.ts)
import { VOX_BTN } from "../contracts/spec/voxel-spec.ts";
import { RecorderHost } from "../voxelmon/game/host.ts";
import { useGoldGen } from "../voxelmon/game/gen2/platform/data-node.ts";
import { Lcd } from "../voxelmon/game/gen2/platform/lcd.ts";
import { Game2 } from "../voxelmon/game/gen2/core/Game2.ts";
import { Mon } from "../voxelmon/game/gen2/battle/Mon.ts";
import { FieldMoves } from "../voxelmon/game/gen2/world/FieldMoves.ts";
import { Permissions } from "../voxelmon/game/gen2/world/Permissions.ts";
import { seed } from "../voxelmon/game/gen2/platform/rng.ts";

useGoldGen();
seed(Number(process.env.SEED ?? 3));
const game: any = Game2.new();
game.load({ startWorld: true });
const lcd = new Lcd(new RecorderHost());
const step = (b = 0) => { game.frame(b); game.draw(lcd); lcd.end(); };
const lead = Mon.new(game.data, "TYPHLOSION", 100, {});
lead.moves[2] = { id: "WHIRLPOOL", pp: 15, ppUps: 0 };
lead.moves[3] = { id: "SURF", pp: 15, ppUps: 0 };
game.save.party = [lead];
for (const b of Object.values<any>(FieldMoves.BADGE_FLAG)) {
  game.save.player[b.store] = game.save.player[b.store] ?? {};
  game.save.player[b.store][b.name] = true;
}
const w = game.world;
w.setMap("DRAGONS_DEN_B1F", 10, 19, "down");
w.applyPlayerState(FieldMoves.PLAYER_SURF);
for (let i = 0; i < 30; i++) step(0);
const at = () => `(${w.player.cellX},${w.player.cellY}) coll(10,20)=${w.map.cellCollision(10, 20).toString(16)} state=${w.playerState} top=${game.stack.top()?.screenId ?? ""}`;
console.log("start", at());
if (!process.env.NOA) step(VOX_BTN.a);
for (let i = 0; i < 400; i++) step(i % 10 === 0 && (w.busy() || game.stack.top()) ? VOX_BTN.a : 0);
console.log("after A", at());
for (let k = 0; k < 300; k++) {
  const d = k % 2 === 0 ? VOX_BTN.down : VOX_BTN.up;
  const trace: string[] = [];
  for (let i = 0; i < 8; i++) { step(d); trace.push(`${w.player.cellX},${w.player.cellY}`); }
  for (let i = 0; i < 20; i++) { step(0); trace.push(`${w.player.cellX},${w.player.cellY}`); }
  if (process.env.NOA && k < 2) console.log("trace", [...new Set(trace)].join(" "), "surfable 24:", (Permissions as any).surfable(0x24), (Permissions as any).of(0x24));
  let battled = false;
  for (let i = 0; i < 3000 && (w.busy() || game.stack.top()); i++) {
    const top = game.stack.top();
    battled = battled || top?.screenId === "Gen2BattleState";
    // fight it out (A: FIGHT, the first move)
    let b = 0;
    if (top && top.screenId !== "Gen2BattleState" && i % 8 === 0) b = VOX_BTN.b;
    else if (i % 8 === 0) b = VOX_BTN.a;
    step(b);
  }
  if (battled || k % 50 === 0) console.log(k, k % 2 === 0 ? "down" : "up", battled ? "BATTLE" : "", at());
}
